import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { BootstrapRefreshInputSchema, BootstrapSessionNonceInputSchema, BOOTSTRAP_SESSION_LIMITS,
  type BootstrapSessionHost, type BootstrapRefreshInput, type BootstrapRefreshResult, type BootstrapSessionNonceInput } from '../../contracts/execution/v1/bootstrap-session.js';
import type { RuntimePublicJwk } from '../../contracts/execution/v1/runtime-registration.js';
import { BOOTSTRAP_NONCE_LIMITS, type BootstrapNonce } from '../../contracts/execution/v1/bootstrap-status.js';
import { freezeTree, snapshotInput } from '../../packages/execution-state/decode.js';
import { transaction } from '../../packages/db/transaction.js';
import { Problem } from '../../packages/shared/problem.js';
import { createBootstrapSessionProofVerifier, parseBootstrapSessionHost } from './bootstrap-session-proof.js';
import { BootstrapProofError } from './bootstrap-proof.js';
import { createBootstrapTokenIssuer } from './bootstrap-issuer.js';
import { insertRefreshGeneration, refreshHandleHash, refreshWireHash } from './bootstrap-session-store.js';

interface Connection {
  connection_id: string; runtime_device_id: string; owner_user_id: string; owner_principal_id: string; scope_id: string;
  environment: BootstrapSessionHost['environment']; client_id: string; aggregate_version: string;
  state: string; issued_at: Date; expires_at: Date;
}
interface Runtime { runtime_device_id: string; challenge_id: string; public_jwk: RuntimePublicJwk; key_thumbprint: string; state: string }
interface Family { family_id: string; connection_id: string; current_generation: string; issued_at: Date; expires_at: Date; state: string }
interface Generation { generation: string; consumed_at: Date | null; handle_wire_hash: string }
interface Interval { validFromMs: number; validUntilMs: number }
const invalid = (): never => { throw new Problem(401, 'bootstrap_invalid', '機器連線驗證無效。'); };
const unavailable = () => new Problem(503, 'bootstrap_unavailable', '機器連線驗證暫時無法使用。');
const now = async (q: PoolClient): Promise<Date> => (await q.query<{ now: Date }>("SELECT date_trunc('milliseconds',clock_timestamp()) now")).rows[0].now;
const binding = (connection: Connection, runtime: Runtime) => ({ ownerUserId: connection.owner_user_id, principalId: connection.owner_principal_id,
  scopeId: connection.scope_id, runtimeDeviceId: runtime.runtime_device_id, connectionId: connection.connection_id,
  connectionVersion: connection.aggregate_version, keyThumbprint: runtime.key_thumbprint });

/** Closed machine admission. All secrets leave only after transaction commit. */
export async function createBootstrapSessions(pool: Pool, options: { host: BootstrapSessionHost; signingKey: CryptoKey }) {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype || Reflect.ownKeys(options).sort().join(',') !== 'host,signingKey') throw new BootstrapProofError();
  const descriptors = Object.getOwnPropertyDescriptors(options);
  if (Object.values(descriptors).some(d => !d.enumerable || !('value' in d))) throw new BootstrapProofError();
  const host = parseBootstrapSessionHost(descriptors.host.value), signingKey = descriptors.signingKey.value as CryptoKey;
  const verifier = createBootstrapSessionProofVerifier(host);
  const { issuerKid, refreshUri: _refreshUri, nonceUri: _nonceUri, ...proofHost } = host;
  const issuer = await createBootstrapTokenIssuer({ host: proofHost, kid: issuerKid, signingKey });
  const { environment, clientId } = host;
  async function guarded<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); } catch (error) {
      if (error instanceof Problem && error.code === 'bootstrap_invalid') throw error;
      if (['23505','23514'].includes((error as { code?: string })?.code ?? '')) return invalid();
      throw unavailable();
    }
  }
  async function bounded(q: PoolClient) { await q.query("SET LOCAL statement_timeout='5s'"); await q.query("SET LOCAL lock_timeout='5s'"); }
  async function locate(q: PoolClient, id: string): Promise<Connection> {
    const row = (await q.query<Connection>('SELECT *,aggregate_version::text FROM agent_connections WHERE connection_id=$1 AND environment=$2 AND client_id=$3', [id, environment, clientId])).rows[0];
    if (!row) return invalid(); return row;
  }
  async function lock(q: PoolClient, first: Connection) {
    if ((await q.query(`SELECT user_id FROM users WHERE user_id=$1 AND active AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL) FOR SHARE`, [first.owner_user_id])).rowCount !== 1) invalid();
    if ((await q.query("SELECT principal_id FROM principals WHERE principal_id=$1 AND user_ref=$2 AND kind='person' AND status='active' FOR SHARE", [first.owner_principal_id, first.owner_user_id])).rowCount !== 1) invalid();
    if ((await q.query("SELECT scope_id FROM resource_scopes WHERE scope_id=$1 AND owner_principal_id=$2 AND kind='personal' AND status='active' FOR SHARE", [first.scope_id, first.owner_principal_id])).rowCount !== 1) invalid();
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['freedom.runtime-enrollment.owner/v1', environment, first.owner_principal_id])]);
    const values = [first.runtime_device_id, environment, first.owner_user_id, first.owner_principal_id, first.scope_id];
    const predicate = 'runtime_device_id=$1 AND environment=$2 AND owner_user_id=$3 AND owner_principal_id=$4 AND scope_id=$5';
    const key = (await q.query<Runtime>(`SELECT * FROM runtime_registrations WHERE ${predicate}`, values)).rows[0];
    if (!key) return invalid();
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['freedom.runtime-enrollment.key/v1', environment, key.key_thumbprint])]);
    await q.query('SELECT challenge_id FROM runtime_registration_challenges WHERE challenge_id=$1 FOR UPDATE', [key.challenge_id]);
    const runtime = (await q.query<Runtime>(`SELECT * FROM runtime_registrations WHERE ${predicate} FOR UPDATE`, values)).rows[0];
    if (!runtime || runtime.state !== 'enrolled' || runtime.key_thumbprint !== key.key_thumbprint) return invalid();
    const connection = (await q.query<Connection>(`SELECT *,aggregate_version::text FROM agent_connections WHERE connection_id=$1 AND runtime_device_id=$2
      AND owner_user_id=$3 AND owner_principal_id=$4 AND scope_id=$5 AND environment=$6 AND client_id=$7 FOR UPDATE`,
    [first.connection_id, first.runtime_device_id, first.owner_user_id, first.owner_principal_id, first.scope_id, environment, clientId])).rows[0];
    if (!connection || connection.state !== 'active') return invalid();
    return { connection, runtime };
  }
  function current(connection: Connection, time: Date, family?: Family, intervals: Interval[] = []) {
    if (time < connection.issued_at || time >= connection.expires_at || family && (family.state !== 'active' || time < family.issued_at || time >= family.expires_at)
      || intervals.some(i => time.getTime() < i.validFromMs || time.getTime() >= i.validUntilMs)) invalid();
  }
  async function ledger(q: PoolClient, connection: Connection, operation: 'refresh' | 'nonce', proofId: string, stamp: Date) {
    const count = (await q.query<{ total: number }>('SELECT count(*)::int total FROM bootstrap_session_proofs WHERE connection_id=$1', [connection.connection_id])).rows[0].total;
    if (count >= BOOTSTRAP_SESSION_LIMITS.connectionProofs) invalid();
    await q.query('INSERT INTO bootstrap_session_proofs(connection_id,runtime_device_id,operation,proof_jti,accepted_at) VALUES($1,$2,$3,$4,$5)',
      [connection.connection_id, connection.runtime_device_id, operation, proofId, stamp]);
  }
  async function refresh(raw: BootstrapRefreshInput): Promise<BootstrapRefreshResult> {
    let input: BootstrapRefreshInput;
    try { input = freezeTree(BootstrapRefreshInputSchema.parse(snapshotInput(raw))); } catch { return invalid(); }
    const outcome = await guarded(() => transaction(pool, async q => {
      await bounded(q);
      const locator = (await q.query<{ connection_id: string }>('SELECT connection_id FROM bootstrap_refresh_families WHERE family_id=$1', [input.familyId])).rows[0];
      if (!locator) return invalid();
      const { connection, runtime } = await lock(q, await locate(q, locator.connection_id));
      const family = (await q.query<Family>('SELECT *,current_generation::text FROM bootstrap_refresh_families WHERE family_id=$1 AND connection_id=$2 FOR UPDATE', [input.familyId, connection.connection_id])).rows[0];
      if (!family) return invalid();
      const generation = (await q.query<Generation>('SELECT *,generation::text FROM bootstrap_refresh_generations WHERE family_id=$1 AND handle_hash=$2 FOR UPDATE', [family.family_id, refreshHandleHash(input.refreshHandle)])).rows[0];
      if (!generation || generation.handle_wire_hash !== refreshWireHash(input.refreshHandle)) return invalid();
      const stamp = await now(q); current(connection, stamp, family);
      const proof = await verifier.verifyRefresh({ proof: input.proof, publicJwk: runtime.public_jwk, familyId: family.family_id, generation: generation.generation,
        connectionId: connection.connection_id, refreshHandleHash: generation.handle_wire_hash, nowMs: stamp.getTime() });
      if (!proof) return invalid();
      const fresh = await now(q); current(connection, fresh, family, [proof]);
      // This branch deliberately precedes all JTI and quota checks. A committed
      // response loss or equivalent valid ECDSA replay still revokes the family.
      if (generation.consumed_at !== null) {
        await q.query("UPDATE bootstrap_refresh_families SET state='revoked',revoked_at=$2,revocation_reason='refresh_reuse' WHERE family_id=$1", [family.family_id, fresh]);
        await q.query("UPDATE agent_connections SET state='revoked',revoked_at=$2,aggregate_version=aggregate_version+1 WHERE connection_id=$1", [connection.connection_id, fresh]);
        current(connection, await now(q), family, [proof]);
        return null;
      }
      if (generation.generation !== family.current_generation || BigInt(family.current_generation) >= BigInt(BOOTSTRAP_SESSION_LIMITS.generations)) return invalid();
      await ledger(q, connection, 'refresh', proof.proofId, fresh);
      await q.query('UPDATE bootstrap_refresh_generations SET consumed_at=$3 WHERE family_id=$1 AND generation=$2', [family.family_id, generation.generation, fresh]);
      const next = (BigInt(generation.generation)+1n).toString();
      const refresh = await insertRefreshGeneration(q, family.family_id, next, fresh, family.expires_at);
      await q.query('UPDATE bootstrap_refresh_families SET current_generation=$2 WHERE family_id=$1', [family.family_id, next]);
      const signingTime = await now(q); current(connection, signingTime, family, [proof]);
      const token = await issuer.issue({ binding: binding(connection, runtime), nowMs: signingTime.getTime(), notAfterMs: Math.min(family.expires_at.getTime(), connection.expires_at.getTime()) });
      if (!token) return invalid();
      current(connection, await now(q), family, [proof, token]);
      return { accessToken: token.accessToken, tokenType: 'DPoP' as const, expiresAt: new Date(token.expiresAt*1000).toISOString(), connectionId: connection.connection_id,
        runtimeDeviceId: runtime.runtime_device_id, refresh, operational_authority: false as const };
    }));
    if (!outcome) return invalid(); return outcome;
  }
  async function nonce(raw: BootstrapSessionNonceInput): Promise<BootstrapNonce> {
    let input: BootstrapSessionNonceInput;
    try { input = freezeTree(BootstrapSessionNonceInputSchema.parse(snapshotInput(raw))); } catch { return invalid(); }
    return guarded(() => transaction(pool, async q => {
      await bounded(q);
      const { connection, runtime } = await lock(q, await locate(q, input.connectionId));
      const family = (await q.query<Family>('SELECT *,current_generation::text FROM bootstrap_refresh_families WHERE connection_id=$1 FOR UPDATE', [connection.connection_id])).rows[0];
      if (!family) return invalid();
      const stamp = await now(q); current(connection, stamp, family);
      const proof = await verifier.verifyNonce({ accessToken: input.accessToken, proof: input.proof, expectedBinding: binding(connection, runtime), nowMs: stamp.getTime() });
      if (!proof) return invalid();
      const fresh = await now(q); current(connection, fresh, family, [proof]);
      const counts = (await q.query<{ pending: number; lifetime: number }>(`SELECT count(*)::int lifetime,
        count(*) FILTER(WHERE consumed_at IS NULL AND expires_at>clock_timestamp())::int pending FROM bootstrap_nonces WHERE connection_id=$1`, [connection.connection_id])).rows[0];
      if (counts.pending >= BOOTSTRAP_NONCE_LIMITS.pending || counts.lifetime >= BOOTSTRAP_NONCE_LIMITS.lifetime) return invalid();
      await ledger(q, connection, 'nonce', proof.proofId, fresh);
      const issuedAt = await now(q); current(connection, issuedAt, family, [proof]);
      const nonce: BootstrapNonce = { nonceId: randomUUID(), nonce: randomBytes(32).toString('base64url'), connectionId: connection.connection_id,
        issuedAt: issuedAt.toISOString(), expiresAt: new Date(Math.min(issuedAt.getTime()+BOOTSTRAP_NONCE_LIMITS.ttlMs, connection.expires_at.getTime())).toISOString(), operational_authority: false };
      await q.query(`INSERT INTO bootstrap_nonces(nonce_id,connection_id,runtime_device_id,owner_user_id,owner_principal_id,scope_id,environment,client_id,connection_version,challenge_key,nonce,issued_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [nonce.nonceId, connection.connection_id, runtime.runtime_device_id, connection.owner_user_id,
        connection.owner_principal_id, connection.scope_id, environment, clientId, connection.aggregate_version, 'session_'+nonce.nonceId, nonce.nonce, issuedAt, nonce.expiresAt]);
      const final = await now(q); current(connection, final, family, [proof]); if (final >= new Date(nonce.expiresAt)) return invalid();
      return nonce;
    }));
  }
  return Object.freeze({ refresh, nonce });
}
