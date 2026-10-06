import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import type { Actor } from '../../../modules/identity-membership/service.js';
import type { ModelStepBinding } from '../../../contracts/execution/v2/model-step.js';
import * as c from '../../../contracts/execution/v2/model-credential.js';
import { RuntimeEnvironmentSchema } from '../../../contracts/execution/v1/runtime-registration.js';
import { BootstrapClientIdSchema } from '../../../contracts/execution/v1/bootstrap.js';
import { withMemberScope, type MemberScopeContext } from '../../../packages/resource-scopes/index.js';
import { scopedMemberCommand, scopedJournal } from '../../../packages/scoped-commands/index.js';
import { assertCurrentSessionClock } from '../../../packages/db/member-session.js';
import { checkVersion } from '../../../packages/db/index.js';
import { requireCondition } from '../../../packages/shared/problem.js';
import { freezeTree, snapshotInput } from '../../../packages/execution-state/decode.js';
import { parseModelStepBinding, type RecoveryObservation, type ResolvedModelCredential } from '../../../modules/agent-execution/model-step-host.js';
import type { CredentialVault, OpaqueSealedCredential } from './vault.js';

declare const writeBrand: unique symbol;
export interface OpaqueCredentialWriteIntent { readonly [writeBrand]: never }
interface WriteIntent {
  store: object; actor: Actor; binding: c.ModelCredentialBinding; deadline: number; monotonic: number; guard: CredentialWriteInvocationGuard;
  input: c.ModelCredentialCreate | c.ModelCredentialRotate; kind: 'create' | 'rotate';
}
const intents = new WeakMap<object, WriteIntent>();
const maximum = 9223372036854775807n;
const invalid = () => requireCondition(false, 409, 'broker_credential_unavailable', 'Credential operation is unavailable.');
const parse = <T>(schema: z.ZodType<T>, raw: unknown): T => freezeTree(schema.parse(snapshotInput(raw)));
const recoverySchema = c.CredentialRecoveryFloorSchema;
function ordered(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(ordered);
  return Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,child]) => [key,ordered(child)]));
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
const equal = (a: unknown, b: unknown) => hash(a) === hash(b);
function captureActor(raw: Actor): Actor {
  requireCondition(raw && typeof raw === 'object', 401, 'session_expired', 'Session required.');
  const descriptors = Object.getOwnPropertyDescriptors(raw), out: Record<string, unknown> = {};
  for (const key of ['user_id', 'community_id', 'session_hash']) {
    const d = descriptors[key];
    requireCondition(d && d.enumerable && 'value' in d && typeof d.value === 'string', 401, 'session_expired', 'Session required.');
    out[key] = d.value;
  }
  return Object.freeze(out) as unknown as Actor;
}
async function port<T>(operation: () => Promise<T>, discard?: (late: T) => void, budgetMs = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const started = performance.now();
  const observed = Promise.resolve().then(operation).then(result => {
    // A blocked event loop or a microtask chain can postpone the timer itself.
    // The monotonic completion clock is therefore also a hard deadline.
    if (expired || performance.now() - started >= budgetMs) {
      expired = true; discard?.(result); invalid();
    }
    return result;
  });
  try { return await Promise.race([observed, new Promise<never>((_, reject) => {
    timer = setTimeout(() => { expired = true; reject(new Error('broker_authority_unavailable')); }, budgetMs);
  })]); } catch { invalid(); throw new Error('broker_authority_unavailable'); }
  finally { if (timer) clearTimeout(timer); }
}
export type CredentialWriteInvocationGuard = (q: PoolClient) => Promise<void>;
const localWriteGuard: CredentialWriteInvocationGuard = async () => {};
const writeTimeChecks = new WeakMap<CredentialWriteInvocationGuard, () => void>();
/** Server-owned synchronous deadline/cancellation check. It supplements genuine
 * SQL authorization after the last awaited result; request data cannot bind it. */
export function bindCredentialWriteInvocationTime(guard: CredentialWriteInvocationGuard, assertCurrentTime: () => void): CredentialWriteInvocationGuard {
  requireCondition(typeof guard === 'function' && typeof assertCurrentTime === 'function',
    409, 'broker_write_intent_required', 'Private write guard required.');
  const bound: CredentialWriteInvocationGuard = async q => {
    assertCurrentTime(); await guard(q); assertCurrentTime();
  };
  writeTimeChecks.set(bound, assertCurrentTime);
  return bound;
}
function assertWriteInvocationTime(guard: CredentialWriteInvocationGuard): void { writeTimeChecks.get(guard)?.(); }
function captureWriteGuard(guard?: CredentialWriteInvocationGuard): CredentialWriteInvocationGuard {
  if (guard === undefined) return localWriteGuard;
  requireCondition(typeof guard === 'function', 409, 'broker_write_intent_required', 'Private write guard required.');
  return guard;
}
function assertIntentTime(data: WriteIntent) {
  assertWriteInvocationTime(data.guard);
  if (Date.now() >= data.deadline || performance.now() >= data.monotonic || Date.parse(data.binding.expiresAt) <= Date.now()) invalid();
}
export function getCredentialWriteIntentMetadata(intent: OpaqueCredentialWriteIntent): Readonly<{ binding: c.ModelCredentialBinding; expiresAt: string }> {
  const data = intent && typeof intent === 'object' ? intents.get(intent) : undefined;
  requireCondition(data, 409, 'broker_write_intent_required', 'Private write intent required.');
  assertIntentTime(data);
  return Object.freeze({ binding: data.binding, expiresAt: new Date(Math.min(data.deadline, Date.parse(data.binding.expiresAt))).toISOString() });
}
export function getCredentialWriteBinding(intent: OpaqueCredentialWriteIntent): c.ModelCredentialBinding {
  const data = intent && typeof intent === 'object' ? intents.get(intent) : undefined;
  requireCondition(data, 409, 'broker_write_intent_required', 'Private write intent required.');
  return data.binding;
}
interface ModelRow {
  model_connection_id: string; runtime_device_id: string; connection_id: string; family_id: string;
  owner_user_id: string; owner_principal_id: string; scope_id: string; environment: string; client_id: string;
  selection: c.ModelCredentialBinding['selection']; aggregate_version: string; state: string; created_at: Date;
}
interface CredentialRow {
  credential_id: string; binding: c.ModelCredentialBinding; state: c.ModelCredentialMetadata['state'];
  aggregate_version: string; terminal_at: Date | null; replacement_credential_id: string | null;
}
interface Backing {
  model: ModelRow;
  runtime: { state: string; enrolled_at: Date };
  connection: { state: string; issued_at: Date; expires_at: Date };
  family: { state: string; issued_at: Date; expires_at: Date };
}
const metadata = (row: CredentialRow): c.ModelCredentialMetadata => parse(c.ModelCredentialMetadataSchema, {
  credentialId: row.credential_id, modelConnectionId: row.binding.modelConnectionId, modelVersion: row.binding.modelVersion,
  generation: row.binding.generation, aggregateVersion: String(row.aggregate_version), state: row.state,
  selection: row.binding.selection, recoveryGeneration: row.binding.recoveryGeneration,
  issuedAt: row.binding.issuedAt, expiresAt: row.binding.expiresAt,
  terminalAt: row.terminal_at?.toISOString() ?? null, replacementCredentialId: row.replacement_credential_id,
  operational_authority: false,
});

/** Closed broker-process composition, never a public API or cross-process Actor
 * transport. Sealing/opening is outside SQL; current authority is checked again
 * afterwards. Credential selection and ciphertext parsing grant no execution. */
export function createBrokerCredentialStore(pool: Pool, options: {
  environment: c.ModelCredentialBinding['environment']; clientId: string; vault: CredentialVault;
  recover: () => Promise<RecoveryObservation>; credentialTtlSeconds?: number;
}) {
  const descriptors = Object.getOwnPropertyDescriptors(options);
  requireCondition(Object.getPrototypeOf(options) === Object.prototype
    && Reflect.ownKeys(options).every(key => typeof key === 'string' && ['environment','clientId','vault','recover','credentialTtlSeconds'].includes(key))
    && Object.values(descriptors).every(d => d.enumerable && 'value' in d), 400, 'invalid_broker_configuration', 'Invalid broker configuration.');
  const environment = RuntimeEnvironmentSchema.parse(descriptors.environment?.value);
  const clientId = BootstrapClientIdSchema.parse(descriptors.clientId?.value);
  const ttl = z.number().int().min(1).max(3600).parse(descriptors.credentialTtlSeconds?.value ?? 3600);
  const vault = descriptors.vault?.value as CredentialVault, recover = descriptors.recover?.value as () => Promise<RecoveryObservation>;
  requireCondition(vault && typeof vault.seal === 'function' && typeof vault.readSealedCredential === 'function'
    && typeof vault.open === 'function' && typeof recover === 'function', 400, 'invalid_broker_configuration', 'Private broker ports required.');
  const identity = Object.freeze(Object.create(null));
  async function recovery(): Promise<RecoveryObservation> {
    const result = parse(recoverySchema, await port(recover));
    if (Date.parse(result.expiresAt) <= Date.now()) invalid();
    return result;
  }
  async function stamp(q: PoolClient, actor: Actor): Promise<Date> {
    await assertCurrentSessionClock(q, actor);
    return (await q.query<{ now: Date }>("SELECT date_trunc('milliseconds',clock_timestamp()) now")).rows[0].now;
  }
  async function eligible(q: PoolClient, actor: Actor) {
    const row = await q.query('SELECT user_id FROM users WHERE user_id=$1 AND active AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL)', [actor.user_id]);
    requireCondition(row.rowCount === 1, 403, 'onboarding_required', 'Current enrolled member required.');
  }
  async function ownerLock(q: PoolClient, context: MemberScopeContext) {
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`freedom.execution-prerequisites.owner/v1:${context.subject_principal.principal_id}`]);
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['freedom.runtime-enrollment.owner/v1', environment, context.subject_principal.principal_id])]);
  }
  const owner = (actor: Actor, context: MemberScopeContext) => [actor.user_id, context.subject_principal.principal_id, context.scope.scope_id];
  async function locate(q: PoolClient, actor: Actor, context: MemberScopeContext, id: string): Promise<CredentialRow> {
    const row = (await q.query<CredentialRow>(`SELECT credential_id,binding,state,aggregate_version::text,terminal_at,replacement_credential_id
      FROM broker_model_credentials WHERE credential_id=$1 AND environment=$2 AND client_id=$3
      AND owner_user_id=$4 AND owner_principal_id=$5 AND scope_id=$6 FOR UPDATE`, [id, environment, clientId, ...owner(actor, context)])).rows[0];
    requireCondition(row, 404, 'broker_credential_not_found', 'Credential not found.');
    row.binding = parse(c.ModelCredentialBindingSchema, row.binding); return row;
  }
  async function backing(q: PoolClient, actor: Actor, context: MemberScopeContext, modelId: string): Promise<Backing> {
    const first = (await q.query<ModelRow>(`SELECT *,aggregate_version::text FROM model_connections
      WHERE model_connection_id=$1 AND environment=$2 AND client_id=$3 AND owner_user_id=$4 AND owner_principal_id=$5 AND scope_id=$6`,
    [modelId, environment, clientId, ...owner(actor, context)])).rows[0];
    requireCondition(first, 404, 'broker_model_not_found', 'Model binding not found.');
    const runtime = (await q.query<Backing['runtime']>('SELECT state,enrolled_at FROM runtime_registrations WHERE runtime_device_id=$1 FOR SHARE', [first.runtime_device_id])).rows[0];
    const connection = (await q.query<Backing['connection']>('SELECT state,issued_at,expires_at FROM agent_connections WHERE connection_id=$1 FOR SHARE', [first.connection_id])).rows[0];
    const family = (await q.query<Backing['family']>('SELECT state,issued_at,expires_at FROM bootstrap_refresh_families WHERE family_id=$1 AND connection_id=$2 FOR SHARE', [first.family_id, first.connection_id])).rows[0];
    const model = (await q.query<ModelRow>('SELECT *,aggregate_version::text FROM model_connections WHERE model_connection_id=$1 FOR UPDATE', [modelId])).rows[0];
    if (!runtime || !connection || !family || !model) invalid();
    parse(c.BrokerModelSelectionSchema, model.selection);
    return { runtime, connection, family, model };
  }
  async function current(q: PoolClient, actor: Actor, b: Backing, binding?: c.ModelCredentialBinding, terminal = false) {
    const time = await stamp(q, actor);
    if (b.runtime.state !== 'enrolled' || b.connection.state !== 'active' || b.family.state !== 'active'
      || b.runtime.enrolled_at > time || b.connection.issued_at > time || b.family.issued_at > time || b.model.created_at > time
      || b.connection.expires_at <= time || b.family.expires_at <= time) invalid();
    if (binding) {
      if (binding.modelConnectionId !== b.model.model_connection_id || !equal(binding.selection, b.model.selection)
        || binding.modelVersion !== (terminal ? String(BigInt(b.model.aggregate_version) - 1n) : b.model.aggregate_version)
        || b.model.state !== (terminal ? 'revoked' : 'unverified') || Date.parse(binding.expiresAt) <= time.getTime()
        || Date.parse(binding.issuedAt) > time.getTime() || Date.parse(binding.expiresAt) > b.connection.expires_at.getTime()
        || Date.parse(binding.expiresAt) > b.family.expires_at.getTime()) invalid();
      const r = await recovery();
      const after = await stamp(q, actor);
      if (r.generation !== binding.recoveryGeneration || Date.parse(r.expiresAt) <= after.getTime()
        || Date.parse(binding.expiresAt) <= after.getTime() || b.connection.expires_at <= after || b.family.expires_at <= after) invalid();
      return { time: after, recoveryExpiresAt: r.expiresAt };
    }
    if (b.model.state !== 'unverified') invalid(); return { time, recoveryExpiresAt: null };
  }
  async function prepare(actorRaw: Actor, raw: unknown, kind: 'create' | 'rotate', invocation?: CredentialWriteInvocationGuard) {
    const guard = captureWriteGuard(invocation), started = performance.now();
    const active = () => { if (performance.now() - started >= 30_000) invalid(); };
    const actor = captureActor(actorRaw);
    const input = kind === 'create' ? parse(c.ModelCredentialCreateSchema, raw) : parse(c.ModelCredentialRotateSchema, raw);
    const r = await recovery(); active();
    const data = await withMemberScope(pool, { actor, scope: 'personal' }, q => eligible(q, actor), async (q, context) => {
      await guard(q); active(); await stamp(q, actor);
      await ownerLock(q, context);
      let generation = '1';
      if (kind === 'rotate') {
        const rotate = input as c.ModelCredentialRotate, old = await locate(q, actor, context, rotate.credentialId);
        checkVersion(old.aggregate_version, rotate.expectedVersion);
        if (old.state !== 'active' || old.binding.modelConnectionId === rotate.replacementModelConnectionId || BigInt(old.binding.generation) >= maximum) invalid();
        await current(q, actor, await backing(q, actor, context, old.binding.modelConnectionId), old.binding);
        generation = String(BigInt(old.binding.generation) + 1n);
      }
      const modelId = kind === 'create' ? (input as c.ModelCredentialCreate).modelConnectionId : (input as c.ModelCredentialRotate).replacementModelConnectionId;
      const b = await backing(q, actor, context, modelId), { time: now } = await current(q, actor, b);
      checkVersion(b.model.aggregate_version, kind === 'create' ? (input as c.ModelCredentialCreate).expectedModelVersion : (input as c.ModelCredentialRotate).expectedReplacementModelVersion);
      const occupied = await q.query('SELECT credential_id FROM broker_model_credentials WHERE model_connection_id=$1', [modelId]);
      requireCondition(occupied.rowCount === 0, 409, 'broker_model_credential_exists', 'Each model binding has one credential lifetime.');
      const binding = parse(c.ModelCredentialBindingSchema, { profile: 'model-credential.binding/v1', credentialId: randomUUID(), generation,
        modelConnectionId: modelId, modelVersion: b.model.aggregate_version, ownerUserId: actor.user_id,
        ownerPrincipalId: context.subject_principal.principal_id, scopeId: context.scope.scope_id, environment, clientId,
        runtimeDeviceId: b.model.runtime_device_id, connectionId: b.model.connection_id, familyId: b.model.family_id,
        selection: b.model.selection, recoveryGeneration: r.generation, issuedAt: now.toISOString(),
        expiresAt: new Date(Math.min(now.getTime() + ttl * 1000, b.connection.expires_at.getTime(), b.family.expires_at.getTime(), Date.parse(r.expiresAt))).toISOString() });
      await current(q, actor, b, binding); await guard(q); active();
      const finalTime = await stamp(q, actor); active();
      const deadline = now.getTime() + 30_000;
      if (finalTime.getTime() >= deadline || Date.now() >= deadline) invalid();
      return { store: identity, actor, input, kind, binding, deadline, guard, monotonic: performance.now() + Math.max(0, deadline - Date.now()) };
    });
    active(); assertIntentTime(data);
    const intent = Object.freeze(Object.create(null)) as OpaqueCredentialWriteIntent;
    intents.set(intent, data); return intent;
  }
  async function commit(actorRaw: Actor, handle: OpaqueCredentialWriteIntent, sealed: OpaqueSealedCredential, invocation?: CredentialWriteInvocationGuard): Promise<c.ModelCredentialMetadata> {
    const suppliedGuard = captureWriteGuard(invocation);
    const actor = captureActor(actorRaw), data = handle && typeof handle === 'object' ? intents.get(handle) : undefined;
    requireCondition(data, 409, 'broker_write_intent_required', 'Current private write intent required.');
    requireCondition(data.store === identity && equal(actor, data.actor), 409, 'broker_write_intent_required', 'Current private write intent required.');
    const assertCurrentTime = () => { assertIntentTime(data); assertWriteInvocationTime(suppliedGuard); };
    const guard: CredentialWriteInvocationGuard = async q => { await data.guard(q); if (suppliedGuard !== data.guard) await suppliedGuard(q); };
    assertIntentTime(data);
    // Authenticated private vault provenance precedes any domain SQL mutation.
    const envelope = parse(c.BrokerCredentialEnvelopeSchema, await port(async () => vault.readSealedCredential(sealed, data.binding)));
    assertIntentTime(data);
    const input = data.input, operation = `broker.credential.${data.kind}`, binding = data.binding;
    let b!: Backing, old: CredentialRow | undefined, applied = false;
    const validate = async (q: PoolClient, context: MemberScopeContext) => {
      await eligible(q, actor); await ownerLock(q, context);
      if (data.kind === 'rotate') {
        const rotate = input as c.ModelCredentialRotate;
        old = await locate(q, actor, context, rotate.credentialId);
        applied = old.state === 'rotated' && old.replacement_credential_id === binding.credentialId;
        if (!applied) { checkVersion(old.aggregate_version, rotate.expectedVersion); if (old.state !== 'active') invalid(); }
        if (!applied) await current(q, actor, await backing(q, actor, context, old.binding.modelConnectionId), old.binding);
        else await stamp(q, actor); // Historical old binding is not new authority.
        if (binding.generation !== String(BigInt(old.binding.generation) + 1n)) invalid();
      }
      b = await backing(q, actor, context, binding.modelConnectionId);
      const { time: now } = await current(q, actor, b, binding);
      if (now.getTime() >= data.deadline || context.subject_principal.principal_id !== binding.ownerPrincipalId || context.scope.scope_id !== binding.scopeId) invalid();
      const found = (await q.query<CredentialRow>('SELECT credential_id,binding,state,aggregate_version::text,terminal_at,replacement_credential_id FROM broker_model_credentials WHERE model_connection_id=$1 FOR UPDATE', [binding.modelConnectionId])).rows[0];
      if (found && (found.credential_id !== binding.credentialId || found.state !== 'active' || !equal(parse(c.ModelCredentialBindingSchema, found.binding), binding))) invalid();
      await guard(q); assertIntentTime(data);
      const finalTime = await stamp(q, actor); assertIntentTime(data);
      if (finalTime.getTime() >= data.deadline) invalid();
    };
    const result = await scopedMemberCommand(pool, { actor, scope: 'personal', operation, key: input.key,
      target: { kind: 'model_connection', id: binding.modelConnectionId },
      body: { environment, clientId, input, binding, sealedSha256: hash(envelope) } }, validate,
    async (q, context) => {
      const { time } = await current(q, actor, b, binding);
      if (old) {
        const version = (input as c.ModelCredentialRotate).expectedVersion;
        checkVersion(old.aggregate_version, version); if (old.state !== 'active') invalid();
        await q.query("UPDATE model_connections SET state='revoked',aggregate_version=aggregate_version+1,revoked_at=$2 WHERE model_connection_id=$1", [old.binding.modelConnectionId, time]);
        await q.query("UPDATE broker_model_credentials SET state='rotated',aggregate_version=aggregate_version+1,terminal_at=$2,replacement_credential_id=$3 WHERE credential_id=$1", [old.credential_id, time, binding.credentialId]);
        await scopedJournal(q, context, { aggregate_type: 'model_credential', id: old.credential_id, version: String(BigInt(version)+1n), operation,
          data: { state: 'rotated', replacementCredentialId: binding.credentialId } });
      }
      const row = (await q.query<CredentialRow>(`INSERT INTO broker_model_credentials(credential_id,model_connection_id,model_version,generation,
        owner_user_id,owner_principal_id,scope_id,runtime_device_id,connection_id,family_id,environment,client_id,selection,recovery_generation,binding,issued_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        RETURNING credential_id,binding,state,aggregate_version::text,terminal_at,replacement_credential_id`,
      [binding.credentialId,binding.modelConnectionId,binding.modelVersion,binding.generation,binding.ownerUserId,binding.ownerPrincipalId,binding.scopeId,
        binding.runtimeDeviceId,binding.connectionId,binding.familyId,binding.environment,binding.clientId,JSON.stringify(binding.selection),binding.recoveryGeneration,
        JSON.stringify(binding),binding.issuedAt,binding.expiresAt])).rows[0];
      await q.query('INSERT INTO broker_credential_vault(credential_id,envelope) VALUES($1,$2)', [binding.credentialId,JSON.stringify(envelope)]);
      await scopedJournal(q, context, { aggregate_type: 'model_credential', id: binding.credentialId, version: '1', operation,
        data: { state: 'active', generation: binding.generation, modelConnectionId: binding.modelConnectionId } });
      return metadata(row);
    }, validate, assertCurrentTime);
    assertCurrentTime(); return result;
  }
  async function read(actorRaw: Actor, raw: c.ModelCredentialRead): Promise<c.ModelCredentialMetadata> {
    const actor = captureActor(actorRaw), input = parse(c.ModelCredentialReadSchema, raw);
    return withMemberScope(pool, { actor, scope: 'personal' }, q => eligible(q, actor), async (q, context) => {
      await ownerLock(q, context); const row = await locate(q, actor, context, input.credentialId);
      // Owner history and safe termination survive provider/recovery/family
      // withdrawal. Current member/session/principal/scope remains mandatory.
      await stamp(q, actor);
      return metadata(row);
    });
  }
  async function revoke(actorRaw: Actor, raw: c.ModelCredentialRevoke): Promise<c.ModelCredentialMetadata> {
    const actor = captureActor(actorRaw), input = parse(c.ModelCredentialRevokeSchema, raw), operation = 'broker.credential.revoke';
    let row!: CredentialRow, model!: ModelRow;
    const validate = async (q: PoolClient, context: MemberScopeContext) => {
      await eligible(q, actor); await ownerLock(q, context); row = await locate(q, actor, context, input.credentialId);
      model = (await q.query<ModelRow>('SELECT *,aggregate_version::text FROM model_connections WHERE model_connection_id=$1 FOR UPDATE', [row.binding.modelConnectionId])).rows[0];
      if (!model || !equal(model.selection,row.binding.selection)
        || !(model.state==='unverified' && model.aggregate_version===row.binding.modelVersion
          || model.state==='revoked' && BigInt(model.aggregate_version)===BigInt(row.binding.modelVersion)+1n)) invalid();
      await stamp(q, actor);
    };
    return scopedMemberCommand(pool, { actor, scope: 'personal', operation, key: input.key,
      target: { kind: 'model_credential', id: input.credentialId }, expected: input.expectedVersion, body: { environment, clientId } }, validate,
    async (q, context) => {
      checkVersion(row.aggregate_version, input.expectedVersion); if (row.state !== 'active' || BigInt(row.binding.modelVersion) >= maximum) invalid();
      const time = await stamp(q, actor);
      if (model.state==='unverified') await q.query("UPDATE model_connections SET state='revoked',aggregate_version=aggregate_version+1,revoked_at=$2 WHERE model_connection_id=$1", [row.binding.modelConnectionId,time]);
      const result = (await q.query<CredentialRow>(`UPDATE broker_model_credentials SET state='revoked',aggregate_version=aggregate_version+1,terminal_at=$2
        WHERE credential_id=$1 RETURNING credential_id,binding,state,aggregate_version::text,terminal_at,replacement_credential_id`, [row.credential_id,time])).rows[0];
      await scopedJournal(q, context, { aggregate_type: 'model_credential', id: row.credential_id, version: result.aggregate_version, operation, data: { state: 'revoked' } });
      return metadata(result);
    }, validate);
  }
  async function createResolver(actorRaw: Actor, raw: c.ModelCredentialResolverPin) {
    const actor = captureActor(actorRaw), pin = parse(c.ModelCredentialResolverPinSchema, raw);
    // The parent ModelStep transaction already locks/fences its member and
    // model rows. A nested broker lock would deadlock that same transaction.
    // This private resolver performs fresh, non-mutating joined observations;
    // lifecycle commands retain their existing locks. No mapping creation or
    // cross-process caller identity is inferred from the structural locator.
    interface Snapshot { binding: c.ModelCredentialBinding; envelope: c.BrokerCredentialEnvelope;
      now: Date; session_expiry: Date; connection_expiry: Date; family_expiry: Date }
    const observe = async (checkBudget: () => void): Promise<Snapshot> => {
      checkBudget();
      const row = (await pool.query<Snapshot>(`SELECT c.binding,v.envelope,clock_timestamp() now,
        s.expires_at session_expiry,a.expires_at connection_expiry,f.expires_at family_expiry
        FROM broker_model_credentials c JOIN broker_credential_vault v USING(credential_id)
        JOIN users u ON u.user_id=c.owner_user_id AND u.community_id=$4 AND u.active
          AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL)
        JOIN sessions s ON s.user_id=u.user_id AND s.token_hash=$5 AND s.revoked_at IS NULL
        JOIN principals p ON p.principal_id=c.owner_principal_id AND p.user_ref=u.user_id AND p.kind='person' AND p.status='active'
        JOIN resource_scopes sc ON sc.scope_id=c.scope_id AND sc.owner_principal_id=p.principal_id AND sc.kind='personal' AND sc.status='active'
        JOIN runtime_registrations r ON r.runtime_device_id=c.runtime_device_id AND r.owner_user_id=u.user_id
          AND r.owner_principal_id=p.principal_id AND r.scope_id=sc.scope_id AND r.environment=c.environment AND r.state='enrolled'
        JOIN agent_connections a ON a.connection_id=c.connection_id AND a.runtime_device_id=r.runtime_device_id
          AND a.owner_user_id=u.user_id AND a.owner_principal_id=p.principal_id AND a.scope_id=sc.scope_id
          AND a.environment=c.environment AND a.client_id=c.client_id AND a.state='active'
        JOIN bootstrap_refresh_families f ON f.family_id=c.family_id AND f.connection_id=a.connection_id AND f.state='active'
        JOIN model_connections m ON m.model_connection_id=c.model_connection_id AND m.aggregate_version=c.model_version
          AND m.runtime_device_id=r.runtime_device_id AND m.connection_id=a.connection_id AND m.family_id=f.family_id
          AND m.owner_user_id=u.user_id AND m.owner_principal_id=p.principal_id AND m.scope_id=sc.scope_id
          AND m.environment=c.environment AND m.client_id=c.client_id AND m.selection=c.selection AND m.state='unverified'
        WHERE c.credential_id=$1 AND c.generation=$2 AND c.owner_user_id=$3 AND c.environment=$6 AND c.client_id=$7
          AND c.state='active' AND c.issued_at<=clock_timestamp() AND r.enrolled_at<=clock_timestamp()
          AND a.issued_at<=clock_timestamp() AND f.issued_at<=clock_timestamp() AND m.created_at<=clock_timestamp()
          AND s.expires_at>clock_timestamp() AND c.expires_at>clock_timestamp()
          AND a.expires_at>clock_timestamp() AND f.expires_at>clock_timestamp()`,
      [pin.credentialId,pin.expectedGeneration,actor.user_id,actor.community_id,actor.session_hash,environment,clientId])).rows[0];
      checkBudget();
      if (!row) invalid();
      row.binding = parse(c.ModelCredentialBindingSchema,row.binding);
      row.envelope = parse(c.BrokerCredentialEnvelopeSchema,row.envelope);
      if (Date.parse(row.binding.expiresAt)<=row.now.getTime() || row.session_expiry<=row.now
        || row.connection_expiry<=row.now || row.family_expiry<=row.now) invalid();
      // The SQL predicate remains authoritative, but result delivery itself can
      // await beyond that statement's clock. Never hand out an already expired
      // credential after a driver/network wait returns an older valid snapshot.
      const returnedAt = Date.now();
      if (Date.parse(row.binding.expiresAt)<=returnedAt || row.session_expiry.getTime()<=returnedAt
        || row.connection_expiry.getTime()<=returnedAt || row.family_expiry.getTime()<=returnedAt) invalid();
      return row;
    };
    const inspect = async (step: ModelStepBinding | undefined, checkBudget: () => void) => {
      const before = await observe(checkBudget), r = await recovery(); checkBudget();
      const row = await observe(checkBudget);
      // A driver wait can also span an external recovery-generation change.
      // Read that source again after the final SQL result arrives. These are
      // bounded fresh observations, not a claim of cross-source atomicity.
      const finalRecovery = await recovery(); checkBudget();
      if (!equal(before.binding,row.binding) || !equal(before.envelope,row.envelope)
        || r.generation!==row.binding.recoveryGeneration || Date.parse(r.expiresAt)<=row.now.getTime()
        || finalRecovery.generation!==r.generation || Date.parse(r.expiresAt)<=Date.now()
        || Date.parse(finalRecovery.expiresAt)<=Date.now()) invalid();
      if (step) {
        for (const key of ['modelConnectionId','modelVersion','ownerUserId','ownerPrincipalId','scopeId','environment','clientId','runtimeDeviceId','connectionId','familyId','selection'] as const)
          if (!equal(row.binding[key], step[key])) invalid();
      }
      const expiresAt = new Date(Math.min(Date.parse(row.binding.expiresAt),row.session_expiry.getTime(),
        row.connection_expiry.getTime(),row.family_expiry.getTime(),Date.parse(r.expiresAt),Date.parse(finalRecovery.expiresAt))).toISOString();
      if (Date.parse(expiresAt)<=Date.now()) invalid();
      return { binding: row.binding, envelope: row.envelope, expiresAt };
    };
    // One shared 2.5s resolver deadline covers SQL/recovery/open/SQL. It is
    // shorter than ModelStepHost's 3s consumer budget, so retained plaintext is
    // cleared before the host times out. Pending SQL is not cancelled or killed.
    const resolverBudgetMs = 2500;
    {
      const started = performance.now(); let cancelled = false;
      const checkBudget = () => { if (cancelled || performance.now()-started>=resolverBudgetMs) invalid(); };
      try { await port(() => inspect(undefined,checkBudget),undefined,resolverBudgetMs); }
      finally { cancelled = true; }
    }
    return async (rawStep: ModelStepBinding): Promise<ResolvedModelCredential> => {
      const started = performance.now(); let cancelled = false, key: Uint8Array | undefined;
      const checkBudget = () => { if (cancelled || performance.now()-started>=resolverBudgetMs) invalid(); };
      try {
        return await port(async () => {
          checkBudget(); const step = parseModelStepBinding(rawStep), before = await inspect(step,checkBudget);
          const opened = await vault.open(before.binding,before.envelope);
          if (cancelled || performance.now()-started>=resolverBudgetMs) { opened.fill(0); invalid(); }
          key = opened;
          const after = await inspect(step,checkBudget); checkBudget();
          if (!equal(before.binding,after.binding) || !equal(before.envelope,after.envelope)) invalid();
          const result = { key, expiresAt: new Date(Math.min(Date.parse(before.expiresAt),Date.parse(after.expiresAt))).toISOString() };
          if (Date.parse(result.expiresAt)<=Date.now()) invalid();
          checkBudget(); key = undefined; return result;
        },late => late.key.fill(0),resolverBudgetMs);
      } finally { cancelled = true; key?.fill(0); }
    };
  }
  return Object.freeze({ prepareCreate: (actor: Actor, input: c.ModelCredentialCreate, guard?: CredentialWriteInvocationGuard) => prepare(actor,input,'create',guard),
    prepareRotate: (actor: Actor, input: c.ModelCredentialRotate, guard?: CredentialWriteInvocationGuard) => prepare(actor,input,'rotate',guard), commit, read, revoke, createResolver });
}

const machinePinSchema = z.object({
  credentialId: c.ModelCredentialBindingSchema.shape.credentialId, expectedGeneration: c.ModelCredentialBindingSchema.shape.generation,
  ownerUserId: c.ModelCredentialBindingSchema.shape.ownerUserId, ownerPrincipalId: c.ModelCredentialBindingSchema.shape.ownerPrincipalId,
  scopeId: c.ModelCredentialBindingSchema.shape.scopeId, runtimeDeviceId: c.ModelCredentialBindingSchema.shape.runtimeDeviceId,
  connectionId: c.ModelCredentialBindingSchema.shape.connectionId, familyId: c.ModelCredentialBindingSchema.shape.familyId,
  modelConnectionId: c.ModelCredentialBindingSchema.shape.modelConnectionId, modelVersion: c.ModelCredentialBindingSchema.shape.modelVersion,
  recoveryGeneration: c.ModelCredentialBindingSchema.shape.recoveryGeneration, environment: RuntimeEnvironmentSchema, clientId: BootstrapClientIdSchema,
}).strict();
/** Machine decrypt port. Pins come from the claimed SQL row, never from a
 * transported Actor or a borrowed session. The member resolver above is unchanged. */
export async function createMachineCredentialResolver(pool: Pool, raw: {
  environment: z.infer<typeof RuntimeEnvironmentSchema>; clientId: string; vault: CredentialVault;
  recover: () => Promise<RecoveryObservation>; pin: z.infer<typeof machinePinSchema>; assertMachine: () => Promise<void>;
}) {
  if (!raw || Object.getPrototypeOf(raw) !== Object.prototype) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(raw), names = ['environment', 'clientId', 'vault', 'recover', 'pin', 'assertMachine'];
  if (Reflect.ownKeys(raw).length !== names.length || names.some(key => !descriptors[key]?.enumerable || !('value' in descriptors[key]))) invalid();
  const environment = RuntimeEnvironmentSchema.parse(descriptors.environment.value), clientId = BootstrapClientIdSchema.parse(descriptors.clientId.value);
  const vault = descriptors.vault.value as CredentialVault, recover = descriptors.recover.value as () => Promise<RecoveryObservation>;
  const assertMachine = descriptors.assertMachine.value as () => Promise<void>, pin = parse(machinePinSchema, descriptors.pin.value);
  if (!vault || typeof vault.open !== 'function' || typeof recover !== 'function' || typeof assertMachine !== 'function'
    || pin.environment !== environment || pin.clientId !== clientId) invalid();
  const recovery = async (checkBudget: () => void) => {
    checkBudget(); const result = parse(recoverySchema, await recover()); checkBudget();
    if (result.generation !== pin.recoveryGeneration || Date.parse(result.expiresAt) <= Date.now()) invalid();
    return result;
  };
  interface Snapshot { binding: c.ModelCredentialBinding; envelope: c.BrokerCredentialEnvelope; now: Date; connection_expiry: Date; family_expiry: Date }
  const observe = async (checkBudget: () => void): Promise<Snapshot> => {
    checkBudget();
    const row = (await pool.query<Snapshot>(`SELECT c.binding,v.envelope,clock_timestamp() now,a.expires_at connection_expiry,f.expires_at family_expiry
      FROM broker_model_credentials c JOIN broker_credential_vault v USING(credential_id)
      JOIN users u ON u.user_id=c.owner_user_id AND u.active AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL)
      JOIN principals p ON p.principal_id=c.owner_principal_id AND p.user_ref=u.user_id AND p.kind='person' AND p.status='active'
      JOIN resource_scopes sc ON sc.scope_id=c.scope_id AND sc.owner_principal_id=p.principal_id AND sc.kind='personal' AND sc.status='active'
      JOIN runtime_registrations r ON r.runtime_device_id=c.runtime_device_id AND r.owner_user_id=u.user_id
        AND r.owner_principal_id=p.principal_id AND r.scope_id=sc.scope_id AND r.environment=c.environment AND r.state='enrolled'
      JOIN agent_connections a ON a.connection_id=c.connection_id AND a.runtime_device_id=r.runtime_device_id
        AND a.owner_user_id=u.user_id AND a.owner_principal_id=p.principal_id AND a.scope_id=sc.scope_id
        AND a.environment=c.environment AND a.client_id=c.client_id AND a.state='active'
      JOIN bootstrap_refresh_families f ON f.family_id=c.family_id AND f.connection_id=a.connection_id AND f.state='active'
      JOIN model_connections m ON m.model_connection_id=c.model_connection_id AND m.aggregate_version=c.model_version
        AND m.runtime_device_id=r.runtime_device_id AND m.connection_id=a.connection_id AND m.family_id=f.family_id
        AND m.owner_user_id=u.user_id AND m.owner_principal_id=p.principal_id AND m.scope_id=sc.scope_id
        AND m.environment=c.environment AND m.client_id=c.client_id AND m.selection=c.selection AND m.state='unverified'
      WHERE c.credential_id=$1 AND c.generation=$2 AND c.owner_user_id=$3 AND c.owner_principal_id=$4 AND c.scope_id=$5
        AND c.environment=$6 AND c.client_id=$7 AND c.runtime_device_id=$8 AND c.connection_id=$9 AND c.family_id=$10
        AND c.model_connection_id=$11 AND c.model_version=$12 AND c.recovery_generation=$13 AND c.state='active'
        AND c.issued_at<=clock_timestamp() AND r.enrolled_at<=clock_timestamp() AND a.issued_at<=clock_timestamp()
        AND f.issued_at<=clock_timestamp() AND m.created_at<=clock_timestamp() AND c.expires_at>clock_timestamp()
        AND a.expires_at>clock_timestamp() AND f.expires_at>clock_timestamp()`,
    [pin.credentialId, pin.expectedGeneration, pin.ownerUserId, pin.ownerPrincipalId, pin.scopeId, environment, clientId,
      pin.runtimeDeviceId, pin.connectionId, pin.familyId, pin.modelConnectionId, pin.modelVersion, pin.recoveryGeneration])).rows[0];
    checkBudget();
    if (!row) invalid();
    row.binding = parse(c.ModelCredentialBindingSchema, row.binding);
    row.envelope = parse(c.BrokerCredentialEnvelopeSchema, row.envelope);
    const returnedAt = Date.now();
    if (Date.parse(row.binding.expiresAt) <= row.now.getTime() || row.connection_expiry <= row.now || row.family_expiry <= row.now
      || Date.parse(row.binding.expiresAt) <= returnedAt || row.connection_expiry.getTime() <= returnedAt || row.family_expiry.getTime() <= returnedAt
      || row.binding.credentialId !== pin.credentialId || row.binding.generation !== pin.expectedGeneration
      || row.binding.recoveryGeneration !== pin.recoveryGeneration) invalid();
    return row;
  };
  const inspect = async (step: ModelStepBinding | undefined, checkBudget: () => void) => {
    const before = await observe(checkBudget), r = await recovery(checkBudget), row = await observe(checkBudget), finalRecovery = await recovery(checkBudget);
    if (!equal(before.binding, row.binding) || !equal(before.envelope, row.envelope) || finalRecovery.generation !== r.generation
      || Date.parse(r.expiresAt) <= Date.now() || Date.parse(finalRecovery.expiresAt) <= Date.now()) invalid();
    if (step) for (const key of ['modelConnectionId', 'modelVersion', 'ownerUserId', 'ownerPrincipalId', 'scopeId', 'environment', 'clientId', 'runtimeDeviceId', 'connectionId', 'familyId', 'selection'] as const)
      if (!equal(row.binding[key], step[key])) invalid();
    await assertMachine(); checkBudget();
    const expiresAt = new Date(Math.min(Date.parse(row.binding.expiresAt), row.connection_expiry.getTime(), row.family_expiry.getTime(),
      Date.parse(r.expiresAt), Date.parse(finalRecovery.expiresAt))).toISOString();
    if (Date.parse(expiresAt) <= Date.now()) invalid();
    return { binding: row.binding, envelope: row.envelope, expiresAt };
  };
  const resolverBudgetMs = 2500;
  { const started = performance.now(); let cancelled = false;
    const checkBudget = () => { if (cancelled || performance.now() - started >= resolverBudgetMs) invalid(); };
    try { await port(() => inspect(undefined, checkBudget), undefined, resolverBudgetMs); } finally { cancelled = true; } }
  return async (rawStep: ModelStepBinding): Promise<ResolvedModelCredential> => {
    const started = performance.now(); let cancelled = false, key: Uint8Array | undefined;
    const checkBudget = () => { if (cancelled || performance.now() - started >= resolverBudgetMs) invalid(); };
    try {
      return await port(async () => {
        checkBudget(); const step = parseModelStepBinding(rawStep), before = await inspect(step, checkBudget);
        const opened = await vault.open(before.binding, before.envelope);
        if (cancelled || performance.now() - started >= resolverBudgetMs) { opened.fill(0); invalid(); }
        key = opened;
        const after = await inspect(step, checkBudget); checkBudget();
        if (!equal(before.binding, after.binding) || !equal(before.envelope, after.envelope)) invalid();
        const result = { key, expiresAt: new Date(Math.min(Date.parse(before.expiresAt), Date.parse(after.expiresAt))).toISOString() };
        if (Date.parse(result.expiresAt) <= Date.now()) invalid();
        checkBudget(); key = undefined; return result;
      }, late => late.key.fill(0), resolverBudgetMs);
    } finally { cancelled = true; key?.fill(0); }
  };
}
