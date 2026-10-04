import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import type { Actor } from '../identity-membership/service.js';
import * as contract from '../../contracts/execution/v1/member-execution.js';
import { RuntimeEnvironmentSchema } from '../../contracts/execution/v1/runtime-registration.js';
import { BootstrapClientIdSchema } from '../../contracts/execution/v1/bootstrap.js';
import { withMemberScope, type MemberScopeContext } from '../../packages/resource-scopes/index.js';
import { scopedMemberCommand, scopedJournal } from '../../packages/scoped-commands/index.js';
import { assertCurrentSessionClock } from '../../packages/db/member-session.js';
import { checkVersion } from '../../packages/db/index.js';
import { requireCondition } from '../../packages/shared/problem.js';
import { freezeTree, snapshotInput } from '../../packages/execution-state/decode.js';
import { resolvePrivateWorkPersistencePolicy } from '../autopilot-work/policy.js';

interface Owned { owner_user_id: string; owner_principal_id: string; scope_id: string }
interface Runtime extends Owned { runtime_device_id: string; challenge_id: string; key_thumbprint: string; environment: string; state: string; aggregate_version: string }
interface Connection extends Owned { connection_id: string; runtime_device_id: string; environment: string; client_id: string; state: string; aggregate_version: string; issued_at: Date; expires_at: Date }
interface Family { family_id: string; connection_id: string; state: string; issued_at: Date; expires_at: Date }
interface Model extends Owned { model_connection_id: string; runtime_device_id: string; connection_id: string; family_id: string; environment: contract.ModelConnectionMetadata['environment']; client_id: string; selection: contract.ModelSelection; state: 'unverified'|'revoked'; aggregate_version: string; created_at: Date }
interface Work { work_item_id: string; aggregate_version: string; state: string }
interface Run { run_id: string; work_item_id: string; aggregate_version: string; input_work_version: string; task_lease_epoch: string; control_epoch: string; state: string }
interface Grant extends Owned { grant_id: string; run_id: string; work_item_id: string; input_work_version: string; run_version: string; task_lease_epoch: string; control_epoch: string; runtime_device_id: string; runtime_version: string; connection_id: string; connection_version: string; family_id: string; environment: string; client_id: string; model_connection_id: string; model_version: string; selection: contract.ModelSelection; persistence_policy_revision: string; state: 'active'|'revoked'; aggregate_version: string; created_at: Date; expires_at: Date; purpose: 'model.private-draft' }
interface Attempt extends Owned { attempt_id: string; run_id: string; grant_id: string; attempt_number: number; grant_snapshot: Record<string, unknown>; created_at: Date; state: 'preflight_blocked'; blockers: contract.ExecutionAttemptMetadata['blockers'] }
interface Backing { runtime: Runtime; connection: Connection; family: Family }
interface Binding extends Backing { work: Work; run: Run; model: Model; policyRevision: string }
const maximum = 9223372036854775807n;
const unavailable = () => requireCondition(false, 409, 'execution_backing_unavailable', '這項執行前置紀錄目前無法使用。');
const stale = () => requireCondition(false, 409, 'execution_binding_stale', '執行前置紀錄已變更，請重新確認。');
const found = <T>(row: T | undefined): T => { requireCondition(row, 404, 'not_found', '找不到這項執行前置紀錄。'); return row; };
const versionColumns = 'aggregate_version::text';
const grantVersions = 'aggregate_version::text,runtime_version::text,connection_version::text,model_version::text,input_work_version::text,run_version::text,task_lease_epoch::text,control_epoch::text';
const modelMetadata = (row: Model): contract.ModelConnectionMetadata => freezeTree(contract.ModelConnectionMetadataSchema.parse({
  modelConnectionId: row.model_connection_id, connectionId: row.connection_id, runtimeDeviceId: row.runtime_device_id, familyId: row.family_id,
  environment: row.environment, clientId: row.client_id, selection: row.selection, state: row.state, aggregateVersion: row.aggregate_version,
  createdAt: row.created_at.toISOString(), operational_authority: false,
}));
const grantMetadata = (row: Grant): contract.ExecutionGrantMetadata => freezeTree(contract.ExecutionGrantMetadataSchema.parse({
  grantId: row.grant_id, runId: row.run_id, workId: row.work_item_id, inputWorkVersion: row.input_work_version, runVersion: row.run_version,
  taskLeaseEpoch: row.task_lease_epoch, controlEpoch: row.control_epoch, runtimeDeviceId: row.runtime_device_id,
  connectionId: row.connection_id, connectionVersion: row.connection_version, familyId: row.family_id,
  modelConnectionId: row.model_connection_id, modelVersion: row.model_version, selection: row.selection,
  policyRevision: row.persistence_policy_revision, state: row.state, aggregateVersion: row.aggregate_version,
  issuedAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(), purpose: row.purpose, operational_authority: false,
}));
function snapshotGrant(raw: Record<string, unknown>): Grant {
  const value = { ...raw } as unknown as Grant;
  for (const key of ['aggregate_version','runtime_version','connection_version','model_version','input_work_version','run_version','task_lease_epoch','control_epoch'] as const)
    value[key] = String(raw[key]);
  value.created_at = new Date(String(raw.created_at)); value.expires_at = new Date(String(raw.expires_at));
  return value;
}
const attemptMetadata = (row: Attempt): contract.ExecutionAttemptMetadata => freezeTree(contract.ExecutionAttemptMetadataSchema.parse({
  attemptId: row.attempt_id, attemptNumber: row.attempt_number, grant: grantMetadata(snapshotGrant(row.grant_snapshot)),
  createdAt: row.created_at.toISOString(), state: row.state, blockers: row.blockers, operational_authority: false,
}));

/** Closed server-only member records. Every model remains unverified and every
 * Attempt remains blocked. No HTTP, machine auth, model I/O or dispatch adapter. */
export function createExecutionPrerequisites(pool: Pool, rawOptions: { environment: contract.ModelConnectionMetadata['environment']; clientId: string; grantTtlSeconds?: number }) {
  const { environment, clientId, grantTtlSeconds = 3600 } = z.object({ environment: RuntimeEnvironmentSchema, clientId: BootstrapClientIdSchema,
    grantTtlSeconds: z.number().int().min(1).max(3600).optional() }).strict().parse(snapshotInput(rawOptions));
  const parse = <T>(schema: z.ZodType<T>, raw: unknown): T => freezeTree(schema.parse(snapshotInput(raw)));
  async function eligible(q: PoolClient, actor: Actor) {
    const row = await q.query('SELECT user_id FROM users WHERE user_id=$1 AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL)', [actor.user_id]);
    requireCondition(row.rowCount === 1, 403, 'onboarding_required', '請先完成加入。');
  }
  async function stamp(q: PoolClient, actor: Actor): Promise<Date> {
    await assertCurrentSessionClock(q, actor);
    return (await q.query<{ now: Date }>("SELECT date_trunc('milliseconds',clock_timestamp()) now")).rows[0].now;
  }
  async function ownerLock(q: PoolClient, context: MemberScopeContext) {
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`freedom.execution-prerequisites.owner/v1:${context.subject_principal.principal_id}`]);
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['freedom.runtime-enrollment.owner/v1', environment, context.subject_principal.principal_id])]);
  }
  const ownerValues = (actor: Actor, context: MemberScopeContext) => [actor.user_id, context.subject_principal.principal_id, context.scope.scope_id];
  async function lockConnection(q: PoolClient, actor: Actor, context: MemberScopeContext, id: string): Promise<Backing> {
    const identity = found((await q.query<Connection>(`SELECT *,${versionColumns} FROM agent_connections WHERE connection_id=$1
      AND environment=$2 AND client_id=$3 AND owner_user_id=$4 AND owner_principal_id=$5 AND scope_id=$6`, [id, environment, clientId, ...ownerValues(actor, context)])).rows[0]);
    const first = found((await q.query<Runtime>(`SELECT * FROM runtime_registrations WHERE runtime_device_id=$1 AND environment=$2
      AND owner_user_id=$3 AND owner_principal_id=$4 AND scope_id=$5`, [identity.runtime_device_id, environment, ...ownerValues(actor, context)])).rows[0]);
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['freedom.runtime-enrollment.key/v1', environment, first.key_thumbprint])]);
    await q.query('SELECT challenge_id FROM runtime_registration_challenges WHERE challenge_id=$1 FOR UPDATE', [first.challenge_id]);
    const runtime = found((await q.query<Runtime>(`SELECT *,${versionColumns} FROM runtime_registrations WHERE runtime_device_id=$1
      AND environment=$2 AND owner_user_id=$3 AND owner_principal_id=$4 AND scope_id=$5 FOR UPDATE`, [identity.runtime_device_id, environment, ...ownerValues(actor, context)])).rows[0]);
    const connection = found((await q.query<Connection>(`SELECT *,${versionColumns} FROM agent_connections WHERE connection_id=$1 AND runtime_device_id=$2
      AND environment=$3 AND client_id=$4 AND owner_user_id=$5 AND owner_principal_id=$6 AND scope_id=$7 FOR UPDATE`, [id, runtime.runtime_device_id, environment, clientId, ...ownerValues(actor, context)])).rows[0]);
    const family = found((await q.query<Family>('SELECT * FROM bootstrap_refresh_families WHERE connection_id=$1 FOR UPDATE', [id])).rows[0]);
    return { runtime, connection, family };
  }
  async function lockRun(q: PoolClient, actor: Actor, context: MemberScopeContext, id: string) {
    const values = [id, ...ownerValues(actor, context)];
    const first = found((await q.query<Run>('SELECT work_item_id FROM execution_runs WHERE run_id=$1 AND owner_user_id=$2 AND owner_principal_id=$3 AND scope_id=$4', values)).rows[0]);
    const work = found((await q.query<Work>(`SELECT work_item_id,aggregate_version::text,state FROM work_items WHERE work_item_id=$1
      AND work_mode='personal_execution' AND owner_ref=$2 AND owner_principal_id=$3 AND scope_id=$4 FOR UPDATE`, [first.work_item_id, ...ownerValues(actor, context)])).rows[0]);
    const run = found((await q.query<Run>(`SELECT *,aggregate_version::text,input_work_version::text,task_lease_epoch::text,control_epoch::text
      FROM execution_runs WHERE run_id=$1 AND owner_user_id=$2 AND owner_principal_id=$3 AND scope_id=$4 FOR UPDATE`, values)).rows[0]);
    return { work, run };
  }
  async function locateModel(q: PoolClient, actor: Actor, context: MemberScopeContext, id: string, locked = false) {
    return found((await q.query<Model>(`SELECT *,${versionColumns} FROM model_connections WHERE model_connection_id=$1 AND environment=$2
      AND client_id=$3 AND owner_user_id=$4 AND owner_principal_id=$5 AND scope_id=$6 ${locked ? 'FOR UPDATE' : ''}`, [id, environment, clientId, ...ownerValues(actor, context)])).rows[0]);
  }
  async function locateGrant(q: PoolClient, actor: Actor, context: MemberScopeContext, id: string, locked = false) {
    return found((await q.query<Grant>(`SELECT *,${grantVersions} FROM execution_grants WHERE grant_id=$1 AND environment=$2
      AND client_id=$3 AND owner_user_id=$4 AND owner_principal_id=$5 AND scope_id=$6 ${locked ? 'FOR UPDATE' : ''}`, [id, environment, clientId, ...ownerValues(actor, context)])).rows[0]);
  }
  async function currentBacking(q: PoolClient, actor: Actor, backing: Backing): Promise<Date> {
    const time = await stamp(q, actor), { runtime, connection, family } = backing;
    if (runtime.state !== 'enrolled' || connection.state !== 'active' || family.state !== 'active'
      || time < connection.issued_at || time >= connection.expires_at || time < family.issued_at || time >= family.expires_at) unavailable();
    return time;
  }
  async function lockBinding(q: PoolClient, actor: Actor, context: MemberScopeContext, runId: string, connectionId: string, modelId: string): Promise<Binding> {
    const backing = await lockConnection(q, actor, context, connectionId), target = await lockRun(q, actor, context, runId);
    const model = await locateModel(q, actor, context, modelId, true);
    requireCondition(model.connection_id === backing.connection.connection_id && model.runtime_device_id === backing.runtime.runtime_device_id && model.family_id === backing.family.family_id,
      409, 'execution_binding_mismatch', '模型選擇與機器連線不符。');
    return { ...backing, ...target, model, policyRevision: '' };
  }
  async function currentBinding(q: PoolClient, actor: Actor, binding: Binding, grant?: Grant): Promise<Date> {
    const time = await currentBacking(q, actor, binding);
    if (binding.model.state !== 'unverified' || binding.work.state !== 'draft' || binding.run.state !== 'created'
      || binding.work.aggregate_version !== binding.run.input_work_version) stale();
    if (grant && (grant.state !== 'active' || grant.aggregate_version !== '1' || time < grant.created_at || time >= grant.expires_at
      || grant.runtime_version !== binding.runtime.aggregate_version || grant.connection_version !== binding.connection.aggregate_version
      || grant.model_version !== binding.model.aggregate_version || grant.run_version !== binding.run.aggregate_version
      || grant.input_work_version !== binding.work.aggregate_version || grant.task_lease_epoch !== binding.run.task_lease_epoch
      || grant.control_epoch !== binding.run.control_epoch || grant.persistence_policy_revision !== binding.policyRevision)) stale();
    return time;
  }
  async function record(q: PoolClient, context: MemberScopeContext, operation: string, type: string, id: string, version: string, state: string) {
    await scopedJournal(q, context, { aggregate_type: type, id, version, operation,
      data: { state, operational_authority: false }, eventType: 'freedom.execution.prerequisite.recorded.v1' });
  }
  async function capacity(q: PoolClient, owner: string, table: 'model_connections'|'execution_grants', limit: number) {
    const count = (await q.query<{ n: number }>(`SELECT count(*)::int n FROM ${table} WHERE owner_principal_id=$1`, [owner])).rows[0].n;
    requireCondition(count < limit, 429, 'execution_prerequisite_limit', '執行前置紀錄數量已達上限。');
  }
  async function createModel(actor: Actor, raw: contract.CreateModelConnectionInput): Promise<contract.ModelConnectionMetadata> {
    actor = Object.freeze({ ...actor }); const input = parse(contract.CreateModelConnectionInputSchema, raw), operation = 'execution.model.create';
    let backing!: Backing, original: Model | undefined;
    const validate = async (q: PoolClient) => { await currentBacking(q, actor, backing); checkVersion(backing.connection.aggregate_version, input.expectedConnectionVersion);
      if (original?.state === 'revoked') unavailable(); };
    return scopedMemberCommand(pool, { actor, scope: 'personal', operation, key: input.key,
      target: { kind: 'agent_connection', id: input.connectionId }, expected: input.expectedConnectionVersion, body: { environment, clientId, selection: input.selection } },
    async (q, context) => {
      await eligible(q, actor); await ownerLock(q, context); backing = await lockConnection(q, actor, context, input.connectionId);
      original = (await q.query<Model>(`SELECT *,aggregate_version::text FROM model_connections WHERE owner_principal_id=$1 AND scope_id=$2
        AND environment=$3 AND client_id=$4 AND creation_key=$5 FOR UPDATE`, [context.subject_principal.principal_id, context.scope.scope_id, environment, clientId, input.key])).rows[0];
      await validate(q);
    }, async (q, context) => {
      await capacity(q, context.subject_principal.principal_id, 'model_connections', 32);
      const time = await currentBacking(q, actor, backing);
      const row = (await q.query<Model>(`INSERT INTO model_connections(model_connection_id,runtime_device_id,connection_id,family_id,
        owner_user_id,owner_principal_id,scope_id,environment,client_id,selection,created_at,creation_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        RETURNING *,${versionColumns}`, [randomUUID(), backing.runtime.runtime_device_id, input.connectionId, backing.family.family_id,
        ...ownerValues(actor, context), environment, clientId, JSON.stringify(input.selection), time, input.key])).rows[0];
      await record(q, context, operation, 'model_connection', row.model_connection_id, row.aggregate_version, row.state);
      return modelMetadata(row);
    }, async q => { await validate(q); });
  }
  async function readModel(actor: Actor, raw: contract.ReadModelConnectionInput): Promise<contract.ModelConnectionMetadata> {
    actor = Object.freeze({ ...actor }); const input = parse(contract.ReadModelConnectionInputSchema, raw);
    return withMemberScope(pool, { actor, scope: 'personal' }, async q => eligible(q, actor), async (q, context) => {
      await ownerLock(q, context); const first = await locateModel(q, actor, context, input.modelConnectionId);
      await lockConnection(q, actor, context, first.connection_id); const row = await locateModel(q, actor, context, input.modelConnectionId, true);
      await stamp(q, actor); return modelMetadata(row);
    });
  }
  async function revokeModel(actor: Actor, raw: contract.RevokeModelConnectionInput): Promise<contract.ModelConnectionMetadata> {
    actor = Object.freeze({ ...actor }); const input = parse(contract.RevokeModelConnectionInputSchema, raw), operation = 'execution.model.revoke'; let current!: Model;
    return scopedMemberCommand(pool, { actor, scope: 'personal', operation, key: input.key,
      target: { kind: 'model_connection', id: input.modelConnectionId }, expected: input.expectedVersion, body: { environment, clientId } },
    async (q, context) => { await eligible(q, actor); await ownerLock(q, context); const first = await locateModel(q, actor, context, input.modelConnectionId);
      await lockConnection(q, actor, context, first.connection_id); current = await locateModel(q, actor, context, input.modelConnectionId, true); },
    async (q, context) => {
      checkVersion(current.aggregate_version, input.expectedVersion); if (current.state === 'revoked') unavailable();
      requireCondition(BigInt(current.aggregate_version) < maximum, 409, 'execution_version_exhausted', '執行前置紀錄無法再更新。');
      const time = await stamp(q, actor);
      const row = found((await q.query<Model>(`UPDATE model_connections SET state='revoked',revoked_at=$3,aggregate_version=aggregate_version+1
        WHERE model_connection_id=$1 AND aggregate_version=$2 RETURNING *,${versionColumns}`, [input.modelConnectionId, input.expectedVersion, time])).rows[0]);
      await record(q, context, operation, 'model_connection', row.model_connection_id, row.aggregate_version, row.state); return modelMetadata(row);
    }, async q => { await stamp(q, actor); });
  }
  async function createGrant(actor: Actor, raw: contract.CreateExecutionGrantInput): Promise<contract.ExecutionGrantMetadata> {
    actor = Object.freeze({ ...actor }); const input = parse(contract.CreateExecutionGrantInputSchema, raw), operation = 'execution.grant.create'; let binding!: Binding, original: Grant | undefined;
    const validate = async (q: PoolClient) => {
      await currentBinding(q, actor, binding, original); checkVersion(binding.run.aggregate_version, input.expectedRunVersion);
      checkVersion(binding.work.aggregate_version, input.expectedWorkVersion); checkVersion(binding.connection.aggregate_version, input.expectedConnectionVersion);
      checkVersion(binding.model.aggregate_version, input.expectedModelVersion);
    };
    return scopedMemberCommand(pool, { actor, scope: 'personal', operation, key: input.key, target: { kind: 'execution_run', id: input.runId },
      expected: input.expectedRunVersion, body: { environment, clientId, expectedWorkVersion: input.expectedWorkVersion ?? null,
        connectionId: input.connectionId, expectedConnectionVersion: input.expectedConnectionVersion ?? null,
        modelConnectionId: input.modelConnectionId, expectedModelVersion: input.expectedModelVersion ?? null, consent: true } },
    async (q, context) => {
      await eligible(q, actor); await ownerLock(q, context); binding = await lockBinding(q, actor, context, input.runId, input.connectionId, input.modelConnectionId);
      original = (await q.query<Grant>(`SELECT *,${grantVersions} FROM execution_grants WHERE owner_principal_id=$1 AND scope_id=$2
        AND environment=$3 AND client_id=$4 AND creation_key=$5 FOR UPDATE`, [context.subject_principal.principal_id, context.scope.scope_id, environment, clientId, input.key])).rows[0];
      binding.policyRevision = (await resolvePrivateWorkPersistencePolicy(q, context)).revision; await validate(q);
    }, async (q, context) => {
      await capacity(q, context.subject_principal.principal_id, 'execution_grants', 256); const time = await currentBinding(q, actor, binding);
      const expiry = new Date(Math.min(time.getTime()+grantTtlSeconds*1000, binding.connection.expires_at.getTime(), binding.family.expires_at.getTime()));
      const row = (await q.query<Grant>(`INSERT INTO execution_grants(grant_id,run_id,work_item_id,owner_user_id,owner_principal_id,scope_id,
        runtime_device_id,runtime_version,connection_id,connection_version,family_id,environment,client_id,model_connection_id,model_version,
        selection,input_work_version,run_version,task_lease_epoch,control_epoch,persistence_policy_revision,consent,created_at,expires_at,creation_key)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,true,$22,$23,$24) RETURNING *,${grantVersions}`,
      [randomUUID(), input.runId, binding.work.work_item_id, ...ownerValues(actor, context), binding.runtime.runtime_device_id, binding.runtime.aggregate_version,
        input.connectionId, binding.connection.aggregate_version, binding.family.family_id, environment, clientId, input.modelConnectionId,
        binding.model.aggregate_version, JSON.stringify(binding.model.selection), binding.work.aggregate_version, binding.run.aggregate_version,
        binding.run.task_lease_epoch, binding.run.control_epoch, binding.policyRevision, time, expiry, input.key])).rows[0];
      original = row;
      await record(q, context, operation, 'execution_grant', row.grant_id, row.aggregate_version, row.state);
      requireCondition(row.expires_at > await stamp(q, actor), 409, 'execution_binding_stale', '執行前置紀錄已變更，請重新確認。');
      return grantMetadata(row);
    }, async q => { await validate(q); });
  }
  async function readGrant(actor: Actor, raw: contract.ReadExecutionGrantInput): Promise<contract.ExecutionGrantMetadata> {
    actor = Object.freeze({ ...actor }); const input = parse(contract.ReadExecutionGrantInputSchema, raw);
    return withMemberScope(pool, { actor, scope: 'personal' }, async q => eligible(q, actor), async (q, context) => {
      await ownerLock(q, context); const first = await locateGrant(q, actor, context, input.grantId);
      await lockBinding(q, actor, context, first.run_id, first.connection_id, first.model_connection_id);
      const current = await locateGrant(q, actor, context, input.grantId, true); await stamp(q, actor); return grantMetadata(current);
    });
  }
  async function revokeGrant(actor: Actor, raw: contract.RevokeExecutionGrantInput): Promise<contract.ExecutionGrantMetadata> {
    actor = Object.freeze({ ...actor }); const input = parse(contract.RevokeExecutionGrantInputSchema, raw), operation = 'execution.grant.revoke'; let current!: Grant;
    return scopedMemberCommand(pool, { actor, scope: 'personal', operation, key: input.key, target: { kind: 'execution_grant', id: input.grantId },
      expected: input.expectedVersion, body: { environment, clientId } }, async (q, context) => {
      await eligible(q, actor); await ownerLock(q, context); const first = await locateGrant(q, actor, context, input.grantId);
      await lockBinding(q, actor, context, first.run_id, first.connection_id, first.model_connection_id); current = await locateGrant(q, actor, context, input.grantId, true);
    }, async (q, context) => {
      checkVersion(current.aggregate_version, input.expectedVersion); if (current.state === 'revoked') unavailable();
      requireCondition(BigInt(current.aggregate_version) < maximum, 409, 'execution_version_exhausted', '執行前置紀錄無法再更新。');
      const time = await stamp(q, actor);
      const row = found((await q.query<Grant>(`UPDATE execution_grants SET state='revoked',revoked_at=$3,aggregate_version=aggregate_version+1
        WHERE grant_id=$1 AND aggregate_version=$2 RETURNING *,${grantVersions}`, [input.grantId, input.expectedVersion, time])).rows[0]);
      await record(q, context, operation, 'execution_grant', row.grant_id, row.aggregate_version, row.state); return grantMetadata(row);
    }, async q => { await stamp(q, actor); });
  }
  async function createAttempt(actor: Actor, raw: contract.CreateExecutionAttemptInput): Promise<contract.ExecutionAttemptMetadata> {
    actor = Object.freeze({ ...actor }); const input = parse(contract.CreateExecutionAttemptInputSchema, raw), operation = 'execution.attempt.create';
    let binding!: Binding, grant!: Grant;
    const validate = async (q: PoolClient) => { await currentBinding(q, actor, binding, grant);
      checkVersion(binding.run.aggregate_version, input.expectedRunVersion); checkVersion(grant.aggregate_version, input.expectedGrantVersion); };
    return scopedMemberCommand(pool, { actor, scope: 'personal', operation, key: input.key, target: { kind: 'execution_run', id: input.runId },
      expected: input.expectedRunVersion, body: { environment, clientId, grantId: input.grantId, expectedGrantVersion: input.expectedGrantVersion ?? null } },
    async (q, context) => {
      await eligible(q, actor); await ownerLock(q, context); const first = await locateGrant(q, actor, context, input.grantId);
      requireCondition(first.run_id === input.runId, 409, 'execution_binding_mismatch', '授權與執行紀錄不符。');
      binding = await lockBinding(q, actor, context, input.runId, first.connection_id, first.model_connection_id);
      grant = await locateGrant(q, actor, context, input.grantId, true);
      binding.policyRevision = (await resolvePrivateWorkPersistencePolicy(q, context)).revision; await validate(q);
    }, async (q, context) => {
      const count = (await q.query<{ n: number }>('SELECT count(*)::int n FROM execution_attempts WHERE run_id=$1', [input.runId])).rows[0].n;
      requireCondition(count < 16, 429, 'execution_attempt_limit', '執行前置檢查紀錄數量已達上限。'); const time = await currentBinding(q, actor, binding, grant);
      // PostgreSQL jsonb retains exact bigint snapshots; do not round through JS.
      const row = (await q.query<Attempt>(`INSERT INTO execution_attempts(attempt_id,run_id,work_item_id,owner_user_id,owner_principal_id,scope_id,grant_id,attempt_number,grant_snapshot,created_at)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,execution_prerequisite_grant_snapshot(to_jsonb(g)),$9 FROM execution_grants g WHERE grant_id=$7 RETURNING *`,
      [randomUUID(), input.runId, grant.work_item_id, ...ownerValues(actor, context), input.grantId, count+1, time])).rows[0];
      await record(q, context, operation, 'execution_attempt', row.attempt_id, '1', row.state); return attemptMetadata(row);
    }, async q => { await validate(q); });
  }
  async function readAttempt(actor: Actor, raw: contract.ReadExecutionAttemptInput): Promise<contract.ExecutionAttemptMetadata> {
    actor = Object.freeze({ ...actor }); const input = parse(contract.ReadExecutionAttemptInputSchema, raw);
    return withMemberScope(pool, { actor, scope: 'personal' }, async q => eligible(q, actor), async (q, context) => {
      await ownerLock(q, context);
      const first = found((await q.query<Attempt>(`SELECT a.* FROM execution_attempts a JOIN execution_grants g ON g.grant_id=a.grant_id
        WHERE a.state='preflight_blocked' AND a.attempt_id=$1 AND a.owner_user_id=$2 AND a.owner_principal_id=$3 AND a.scope_id=$4 AND g.environment=$5 AND g.client_id=$6`,
      [input.attemptId, ...ownerValues(actor, context), environment, clientId])).rows[0]);
      const grant = await locateGrant(q, actor, context, first.grant_id);
      await lockBinding(q, actor, context, first.run_id, grant.connection_id, grant.model_connection_id);
      await locateGrant(q, actor, context, first.grant_id, true);
      const current = found((await q.query<Attempt>('SELECT * FROM execution_attempts WHERE attempt_id=$1 FOR UPDATE', [input.attemptId])).rows[0]);
      await stamp(q, actor); return attemptMetadata(current);
    });
  }
  return Object.freeze({ models: Object.freeze({ create: createModel, read: readModel, revoke: revokeModel }),
    grants: Object.freeze({ create: createGrant, read: readGrant, revoke: revokeGrant }), attempts: Object.freeze({ create: createAttempt, read: readAttempt }) });
}
