import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import type { Actor } from '../identity-membership/service.js';
import { OpaqueId } from '../../contracts/common/v1/identity.js';
import { RuntimeEnvironmentSchema, type RuntimeEnvironment } from '../../contracts/execution/v1/runtime-registration.js';
import { ExecutionVersion } from '../../contracts/execution/v1/state.js';
import { BootstrapClientIdSchema } from '../../contracts/execution/v1/bootstrap.js';
import { withMemberScope, type MemberScopeContext } from '../../packages/resource-scopes/index.js';
import { scopedMemberCommand, scopedJournal } from '../../packages/scoped-commands/index.js';
import { assertCurrentSessionClock } from '../../packages/db/member-session.js';
import { checkVersion } from '../../packages/db/index.js';
import { requireCondition } from '../../packages/shared/problem.js';

const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const keySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$(?![\s\S])/);
const versionSchema = ExecutionVersion.refine(value => BigInt(value) <= 9223372036854775807n);
const createSchema = z.object({ key: keySchema, runtimeDeviceId: OpaqueId }).strict();
const readSchema = z.object({ connectionId: OpaqueId }).strict();
const revokeSchema = readSchema.extend({ key: keySchema, expectedVersion: versionSchema.optional() }).strict();
export interface CreateAgentConnectionInput { key: string; runtimeDeviceId: string }
export interface ReadAgentConnectionInput { connectionId: string }
export interface RevokeAgentConnectionInput extends ReadAgentConnectionInput { key: string; expectedVersion: string }
export interface AgentConnectionMetadata {
  readonly connectionId: string; readonly runtimeDeviceId: string;
  readonly environment: RuntimeEnvironment; readonly clientId: string;
  readonly state: 'active' | 'revoked'; readonly aggregateVersion: string;
  readonly issuedAt: string; readonly expiresAt: string; readonly operational_authority: false;
}
interface ConnectionRow {
  connection_id: string; runtime_device_id: string; environment: RuntimeEnvironment; client_id: string;
  state: 'active' | 'revoked'; aggregate_version: string; issued_at: Date; expires_at: Date;
}
interface RuntimeRow { runtime_device_id: string; challenge_id: string; key_thumbprint: string; state: 'enrolled' | 'revoked' }
const metadata = (row: ConnectionRow): AgentConnectionMetadata => Object.freeze({
  connectionId: row.connection_id, runtimeDeviceId: row.runtime_device_id, environment: row.environment, clientId: row.client_id,
  state: row.state, aggregateVersion: row.aggregate_version, issuedAt: row.issued_at.toISOString(), expiresAt: row.expires_at.toISOString(),
  operational_authority: false,
});
const unavailable = () => requireCondition(false, 409, 'agent_connection_unavailable', '這項機器連線目前無法使用。');
function plainInput(value: unknown): void {
  requireCondition(value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    && Object.getOwnPropertySymbols(value).length === 0
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => descriptor.enumerable && 'value' in descriptor),
  400, 'invalid_agent_connection', '機器連線資料無效。');
}

/** Current-member management only. A connection row is not machine authentication. */
export function createAgentConnections(pool: Pool, rawOptions: { environment: RuntimeEnvironment; clientId: string }) {
  plainInput(rawOptions);
  const { environment, clientId } = z.object({ environment: RuntimeEnvironmentSchema, clientId: BootstrapClientIdSchema }).strict().parse(rawOptions);
  async function eligible(q: PoolClient, actor: Actor) {
    const row = await q.query('SELECT user_id FROM users WHERE user_id=$1 AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL)', [actor.user_id]);
    requireCondition(row.rowCount === 1, 403, 'onboarding_required', '請先完成加入。');
  }
  async function ownerLock(q: PoolClient, context: MemberScopeContext) {
    // Same namespace as 087, serializing this quota and runtime revocation.
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [JSON.stringify(['freedom.runtime-enrollment.owner/v1', environment, context.subject_principal.principal_id])]);
  }
  async function decisionClock(q: PoolClient, actor: Actor): Promise<Date> {
    await assertCurrentSessionClock(q, actor);
    return (await q.query<{ now: Date }>("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0].now;
  }
  async function ownedRuntime(q: PoolClient, actor: Actor, context: MemberScopeContext, id: string): Promise<RuntimeRow> {
    const values = [id, environment, actor.user_id, context.subject_principal.principal_id, context.scope.scope_id];
    const predicate = 'runtime_device_id=$1 AND environment=$2 AND owner_user_id=$3 AND owner_principal_id=$4 AND scope_id=$5';
    const identity = (await q.query<RuntimeRow>(`SELECT runtime_device_id,challenge_id,key_thumbprint,state FROM runtime_registrations WHERE ${predicate}`, values)).rows[0];
    requireCondition(identity, 404, 'not_found', '找不到這項機器連線。');
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [JSON.stringify(['freedom.runtime-enrollment.key/v1', environment, identity.key_thumbprint])]);
    await q.query('SELECT challenge_id FROM runtime_registration_challenges WHERE challenge_id=$1 FOR UPDATE', [identity.challenge_id]);
    const current = (await q.query<RuntimeRow>(`SELECT runtime_device_id,challenge_id,key_thumbprint,state FROM runtime_registrations WHERE ${predicate} FOR UPDATE`, values)).rows[0];
    requireCondition(current, 404, 'not_found', '找不到這項機器連線。');
    return current;
  }
  async function ownedConnection(q: PoolClient, actor: Actor, context: MemberScopeContext, id: string): Promise<ConnectionRow> {
    const values = [id, environment, clientId, actor.user_id, context.subject_principal.principal_id, context.scope.scope_id];
    const predicate = 'connection_id=$1 AND environment=$2 AND client_id=$3 AND owner_user_id=$4 AND owner_principal_id=$5 AND scope_id=$6';
    const identity = (await q.query<ConnectionRow>(`SELECT runtime_device_id FROM agent_connections WHERE ${predicate}`, values)).rows[0];
    requireCondition(identity, 404, 'not_found', '找不到這項機器連線。');
    await ownedRuntime(q, actor, context, identity.runtime_device_id);
    const current = (await q.query<ConnectionRow>(`SELECT *,aggregate_version::text FROM agent_connections WHERE ${predicate} FOR UPDATE`, values)).rows[0];
    requireCondition(current, 404, 'not_found', '找不到這項機器連線。');
    return current;
  }
  async function record(q: PoolClient, context: MemberScopeContext, operation: string, row: ConnectionRow) {
    await scopedJournal(q, context, { aggregate_type: 'agent_connection', id: row.connection_id,
      version: row.aggregate_version, operation, data: { state: row.state, environment, operational_authority: false },
      eventType: 'freedom.agent.connection.recorded.v1' });
    return metadata(row);
  }
  async function create(actor: Actor, raw: CreateAgentConnectionInput): Promise<AgentConnectionMetadata> {
    plainInput(raw);
    actor = Object.freeze({ ...actor }); const input = Object.freeze(createSchema.parse(raw));
    const operation = 'agent.connection.create';
    let existing: ConnectionRow | undefined;
    return scopedMemberCommand(pool, { actor, scope: 'personal', operation, key: input.key,
      target: { kind: 'runtime_registration', id: input.runtimeDeviceId }, body: { environment, clientId } },
    async (q, context) => {
      await eligible(q, actor); await ownerLock(q, context);
      const runtime = await ownedRuntime(q, actor, context, input.runtimeDeviceId);
      existing = (await q.query<ConnectionRow>('SELECT *,aggregate_version::text FROM agent_connections WHERE runtime_device_id=$1 AND client_id=$2 FOR UPDATE',
        [input.runtimeDeviceId, clientId])).rows[0];
      const now = await decisionClock(q, actor);
      if (runtime.state !== 'enrolled' || existing && (existing.state !== 'active' || existing.expires_at <= now)) unavailable();
    }, async (q, context) => {
      if (existing) unavailable();
      const count = (await q.query<{ n: number }>('SELECT count(*)::int n FROM agent_connections WHERE owner_principal_id=$1 AND environment=$2',
        [context.subject_principal.principal_id, environment])).rows[0].n;
      requireCondition(count < 32, 429, 'agent_connection_limit', '機器連線數量已達上限。');
      const now = await decisionClock(q, actor);
      const row = (await q.query<ConnectionRow>(`INSERT INTO agent_connections
        (connection_id,runtime_device_id,owner_user_id,owner_principal_id,scope_id,environment,client_id,issued_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *,aggregate_version::text`,
      [randomUUID(), input.runtimeDeviceId, actor.user_id, context.subject_principal.principal_id, context.scope.scope_id,
        environment, clientId, now, new Date(now.getTime() + TTL_MS)])).rows[0];
      const result = await record(q, context, operation, row);
      if (row.expires_at <= await decisionClock(q, actor)) unavailable();
      return result;
    });
  }
  async function read(actor: Actor, raw: ReadAgentConnectionInput): Promise<AgentConnectionMetadata> {
    plainInput(raw);
    actor = Object.freeze({ ...actor }); const input = Object.freeze(readSchema.parse(raw));
    return withMemberScope(pool, { actor, scope: 'personal' }, async q => { await eligible(q, actor); }, async (q, context) => {
      await ownerLock(q, context); const row = await ownedConnection(q, actor, context, input.connectionId);
      await decisionClock(q, actor); return metadata(row);
    });
  }
  async function revoke(actor: Actor, raw: RevokeAgentConnectionInput): Promise<AgentConnectionMetadata> {
    plainInput(raw);
    actor = Object.freeze({ ...actor }); const input = Object.freeze(revokeSchema.parse(raw)), operation = 'agent.connection.revoke';
    let current!: ConnectionRow;
    return scopedMemberCommand(pool, { actor, scope: 'personal', operation, key: input.key,
      target: { kind: 'agent_connection', id: input.connectionId }, expected: input.expectedVersion, body: { environment, clientId } },
    async (q, context) => { await eligible(q, actor); await ownerLock(q, context); current = await ownedConnection(q, actor, context, input.connectionId); },
    async (q, context) => {
      checkVersion(current.aggregate_version, input.expectedVersion);
      if (current.state === 'revoked') unavailable();
      requireCondition(BigInt(current.aggregate_version) < 9223372036854775807n, 409, 'agent_connection_version_exhausted', '機器連線無法再更新。');
      const now = await decisionClock(q, actor);
      const row = (await q.query<ConnectionRow>(`UPDATE agent_connections SET state='revoked',revoked_at=$3,aggregate_version=aggregate_version+1
        WHERE connection_id=$1 AND aggregate_version=$2 RETURNING *,aggregate_version::text`, [input.connectionId, input.expectedVersion, now])).rows[0];
      requireCondition(row, 412, 'version_conflict', '資料已更新，請重新整理後再操作。');
      const result = await record(q, context, operation, row);
      await decisionClock(q, actor); return result;
    });
  }
  return Object.freeze({ create, read, revoke });
}
