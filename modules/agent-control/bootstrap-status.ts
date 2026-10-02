import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import type { Actor } from '../identity-membership/service.js';
import { OpaqueId } from '../../contracts/common/v1/identity.js';
import { BOOTSTRAP_LIMITS, BootstrapProofHostSchema, type BootstrapProofHost, type BootstrapProofResult } from '../../contracts/execution/v1/bootstrap.js';
import { freezeTree, snapshotInput } from '../../packages/execution-state/decode.js';
import { scopedMemberCommand, scopedJournal } from '../../packages/scoped-commands/index.js';
import { assertCurrentSessionClock } from '../../packages/db/member-session.js';
import { transaction } from '../../packages/db/transaction.js';
import type { MemberScopeContext } from '../../packages/resource-scopes/index.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import { BootstrapProofError, createBootstrapProofVerifier } from './bootstrap-proof.js';

const challengeSchema = z.object({ key: z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$(?![\s\S])/), connectionId: OpaqueId }).strict();
const readSchema = z.object({ connectionId: OpaqueId, nonceId: OpaqueId,
  accessToken: z.string().min(1).max(BOOTSTRAP_LIMITS.compactBytes), proof: z.string().min(1).max(BOOTSTRAP_LIMITS.compactBytes) }).strict();
export interface BootstrapChallengeInput { key: string; connectionId: string }
export interface BootstrapStatusInput { connectionId: string; nonceId: string; accessToken: string; proof: string }
export interface BootstrapChallenge {
  readonly nonceId: string; readonly nonce: string; readonly connectionId: string;
  readonly issuedAt: string; readonly expiresAt: string; readonly operational_authority: false;
}
export interface BootstrapStatus {
  readonly connectionId: string; readonly runtimeDeviceId: string; readonly clientId: string;
  readonly environment: BootstrapProofHost['environment']; readonly connectionVersion: string; readonly expiresAt: string;
  readonly state: 'active'; readonly operation: 'bootstrap.status.read'; readonly operational_authority: false;
}
interface ConnectionRow {
  connection_id: string; runtime_device_id: string; owner_user_id: string; owner_principal_id: string; scope_id: string;
  environment: BootstrapProofHost['environment']; client_id: string; aggregate_version: string;
  state: 'active' | 'revoked'; issued_at: Date; expires_at: Date;
}
interface RuntimeRow { runtime_device_id: string; challenge_id: string; key_thumbprint: string; state: 'enrolled' | 'revoked' }
interface NonceRow extends Omit<ConnectionRow, 'aggregate_version' | 'state'> {
  nonce_id: string; nonce: string; connection_version: string; consumed_at: Date | null;
}
const invalid = (): never => { throw new Problem(401, 'bootstrap_invalid', '機器連線驗證無效。'); };
const unavailable = () => new Problem(503, 'bootstrap_unavailable', '機器連線驗證暫時無法使用。');
const nonceView = (row: NonceRow): BootstrapChallenge => Object.freeze({ nonceId: row.nonce_id, nonce: row.nonce,
  connectionId: row.connection_id, issuedAt: row.issued_at.toISOString(), expiresAt: row.expires_at.toISOString(), operational_authority: false });
const statusView = (row: ConnectionRow): BootstrapStatus => Object.freeze({ connectionId: row.connection_id, runtimeDeviceId: row.runtime_device_id,
  clientId: row.client_id, environment: row.environment, connectionVersion: row.aggregate_version, expiresAt: row.expires_at.toISOString(),
  state: 'active', operation: 'bootstrap.status.read', operational_authority: false });

/** One closed operation, no HTTP transport, token issuer or reusable auth context. */
export function createBootstrapStatus(pool: Pool, configuration: BootstrapProofHost) {
  let host: BootstrapProofHost;
  try { host = freezeTree(BootstrapProofHostSchema.parse(snapshotInput(configuration))); }
  catch { throw new BootstrapProofError(); }
  const verifier = createBootstrapProofVerifier(host), { environment, clientId } = host;
  const check = (condition: unknown, machine: boolean): void => {
    if (condition) return;
    if (machine) invalid();
    throw new Problem(409, 'bootstrap_challenge_unavailable', '這項連線挑戰目前無法使用。');
  };
  async function now(q: PoolClient): Promise<Date> {
    return (await q.query<{ now: Date }>("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0].now;
  }
  async function limits(q: PoolClient) { await q.query("SET LOCAL statement_timeout='5s'"); await q.query("SET LOCAL lock_timeout='5s'"); }
  async function identity(q: PoolClient, connectionId: string, machine: boolean): Promise<ConnectionRow> {
    const row = (await q.query<ConnectionRow>('SELECT *,aggregate_version::text FROM agent_connections WHERE connection_id=$1 AND environment=$2 AND client_id=$3',
      [connectionId, environment, clientId])).rows[0];
    if (!row) { if (machine) invalid(); throw new Problem(404, 'not_found', '找不到這項機器連線。'); }
    return row;
  }
  async function ownerLock(q: PoolClient, principalId: string) {
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [JSON.stringify(['freedom.runtime-enrollment.owner/v1', environment, principalId])]);
  }
  async function lockDomain(q: PoolClient, first: ConnectionRow, machine: boolean) {
    await ownerLock(q, first.owner_principal_id);
    const values = [first.runtime_device_id, environment, first.owner_user_id, first.owner_principal_id, first.scope_id];
    const predicate = 'runtime_device_id=$1 AND environment=$2 AND owner_user_id=$3 AND owner_principal_id=$4 AND scope_id=$5';
    const key = (await q.query<RuntimeRow>(`SELECT runtime_device_id,challenge_id,key_thumbprint,state FROM runtime_registrations WHERE ${predicate}`, values)).rows[0];
    check(key, machine);
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [JSON.stringify(['freedom.runtime-enrollment.key/v1', environment, key.key_thumbprint])]);
    await q.query('SELECT challenge_id FROM runtime_registration_challenges WHERE challenge_id=$1 FOR UPDATE', [key.challenge_id]);
    const runtime = (await q.query<RuntimeRow>(`SELECT runtime_device_id,challenge_id,key_thumbprint,state FROM runtime_registrations WHERE ${predicate} FOR UPDATE`, values)).rows[0];
    check(runtime?.state === 'enrolled', machine);
    const row = (await q.query<ConnectionRow>(`SELECT *,aggregate_version::text FROM agent_connections
      WHERE connection_id=$1 AND runtime_device_id=$2 AND owner_user_id=$3 AND owner_principal_id=$4 AND scope_id=$5
        AND environment=$6 AND client_id=$7 FOR UPDATE`,
    [first.connection_id, first.runtime_device_id, first.owner_user_id, first.owner_principal_id, first.scope_id, environment, clientId])).rows[0];
    check(row?.state === 'active', machine);
    return { row, runtime };
  }
  function current(connection: ConnectionRow, nonce: NonceRow | undefined, time: Date, machine: boolean) {
    check(connection.issued_at <= time && time < connection.expires_at, machine);
    if (nonce) check(nonce.consumed_at === null && nonce.connection_id === connection.connection_id
      && nonce.runtime_device_id === connection.runtime_device_id && nonce.owner_user_id === connection.owner_user_id
      && nonce.owner_principal_id === connection.owner_principal_id && nonce.scope_id === connection.scope_id
      && nonce.environment === environment && nonce.client_id === clientId && nonce.connection_version === connection.aggregate_version
      && nonce.issued_at <= time && time < nonce.expires_at, machine);
  }
  async function memberClock(q: PoolClient, actor: Actor, connection: ConnectionRow, nonce?: NonceRow) {
    await assertCurrentSessionClock(q, actor); current(connection, nonce, await now(q), false);
  }
  async function challenge(actor: Actor, raw: BootstrapChallengeInput): Promise<BootstrapChallenge> {
    const input = freezeTree(challengeSchema.parse(snapshotInput(raw))); actor = Object.freeze({ ...actor });
    const operation = 'bootstrap.challenge.create';
    let connection!: ConnectionRow, existing: NonceRow | undefined;
    return scopedMemberCommand(pool, { actor, scope: 'personal', operation, key: input.key,
      target: { kind: 'agent_connection', id: input.connectionId }, body: { environment, clientId } },
    async (q, context) => {
      await limits(q);
      const eligible = await q.query('SELECT user_id FROM users WHERE user_id=$1 AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL)', [actor.user_id]);
      requireCondition(eligible.rowCount === 1, 403, 'onboarding_required', '請先完成加入。');
      const first = await identity(q, input.connectionId, false);
      requireCondition(first.owner_user_id === actor.user_id && first.owner_principal_id === context.subject_principal.principal_id
        && first.scope_id === context.scope.scope_id, 404, 'not_found', '找不到這項機器連線。');
      connection = (await lockDomain(q, first, false)).row;
      existing = (await q.query<NonceRow>('SELECT *,connection_version::text FROM bootstrap_nonces WHERE connection_id=$1 AND challenge_key=$2 FOR UPDATE',
        [input.connectionId, input.key])).rows[0];
      await memberClock(q, actor, connection, existing);
    }, async (q, context: MemberScopeContext) => {
      check(!existing, false);
      const counts = (await q.query<{ pending: number; lifetime: number }>(`SELECT count(*)::int lifetime,
        count(*) FILTER (WHERE consumed_at IS NULL AND expires_at>clock_timestamp())::int pending
        FROM bootstrap_nonces WHERE connection_id=$1`, [input.connectionId])).rows[0];
      requireCondition(counts.pending < 8 && counts.lifetime < 4096, 429, 'bootstrap_challenge_limit', '連線挑戰數量已達上限。');
      await memberClock(q, actor, connection); const issuedAt = await now(q);
      const row = (await q.query<NonceRow>(`INSERT INTO bootstrap_nonces
        (nonce_id,connection_id,runtime_device_id,owner_user_id,owner_principal_id,scope_id,environment,client_id,connection_version,challenge_key,nonce,issued_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *,connection_version::text`,
      [randomUUID(), connection.connection_id, connection.runtime_device_id, actor.user_id, context.subject_principal.principal_id, context.scope.scope_id,
        environment, clientId, connection.aggregate_version, input.key, randomBytes(32).toString('base64url'), issuedAt,
        new Date(Math.min(issuedAt.getTime()+60_000, connection.expires_at.getTime()))])).rows[0];
      await scopedJournal(q, context, { aggregate_type: 'bootstrap_nonce', id: row.nonce_id, version: '1', operation,
        data: { environment, operational_authority: false }, eventType: 'freedom.bootstrap.challenge.created.v1' });
      await memberClock(q, actor, connection, row); return nonceView(row);
    });
  }
  async function read(raw: BootstrapStatusInput): Promise<BootstrapStatus> {
    let input: BootstrapStatusInput;
    try { input = freezeTree(readSchema.parse(snapshotInput(raw))); } catch { return invalid(); }
    try {
      return await transaction(pool, async q => {
        await limits(q);
        const first = await identity(q, input.connectionId, true);
        // Machine authority has no member session and never creates lazy mappings.
        const user = await q.query(`SELECT user_id FROM users WHERE user_id=$1 AND active
          AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL) FOR SHARE`, [first.owner_user_id]);
        if (user.rowCount !== 1) invalid();
        const principal = await q.query("SELECT principal_id FROM principals WHERE principal_id=$1 AND user_ref=$2 AND kind='person' AND status='active' FOR SHARE",
          [first.owner_principal_id, first.owner_user_id]);
        if (principal.rowCount !== 1) invalid();
        const scope = await q.query("SELECT scope_id FROM resource_scopes WHERE scope_id=$1 AND owner_principal_id=$2 AND kind='personal' AND status='active' FOR SHARE",
          [first.scope_id, first.owner_principal_id]);
        if (scope.rowCount !== 1) invalid();
        const { row: connection, runtime } = await lockDomain(q, first, true);
        const nonce = (await q.query<NonceRow>('SELECT *,connection_version::text FROM bootstrap_nonces WHERE nonce_id=$1 AND connection_id=$2 FOR UPDATE',
          [input.nonceId, connection.connection_id])).rows[0];
        if (!nonce) invalid();
        const time = await now(q); current(connection, nonce, time, true);
        const proof = await verifier.verify({ accessToken: input.accessToken, proof: input.proof, expectedNonce: nonce.nonce, nowMs: time.getTime(),
          expectedBinding: { ownerUserId: connection.owner_user_id, principalId: connection.owner_principal_id, scopeId: connection.scope_id,
            runtimeDeviceId: runtime.runtime_device_id, connectionId: connection.connection_id, connectionVersion: connection.aggregate_version, keyThumbprint: runtime.key_thumbprint } });
        if (!proof) return invalid();
        const fresh = async (evidence: BootstrapProofResult) => {
          const stamp = await now(q); current(connection, nonce, stamp, true);
          if (stamp.getTime() < evidence.validFromMs || stamp.getTime() >= evidence.validUntilMs) invalid();
          return stamp;
        };
        const consumedAt = await fresh(proof);
        const consumed = await q.query(`UPDATE bootstrap_nonces SET consumed_at=$2,proof_jti=$3,token_jti=$4
          WHERE nonce_id=$1 AND consumed_at IS NULL RETURNING nonce_id`, [nonce.nonce_id, consumedAt, proof.proofId, proof.tokenId]);
        if (consumed.rowCount !== 1) invalid();
        await fresh(proof);
        return statusView(connection);
      });
    } catch (error) {
      if (error instanceof Problem && error.code === 'bootstrap_invalid') throw error;
      // Unique JTI/tombstone and final SQL clock guards are uniform admission failures.
      if (['23505', '23514'].includes((error as { code?: string })?.code ?? '')) return invalid();
      throw unavailable();
    }
  }
  return Object.freeze({ challenge, read });
}
