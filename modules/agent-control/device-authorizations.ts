import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Actor } from '../identity-membership/service.js';
import { DEVICE_PAIRING_LIMITS as LIMITS,
  DeviceAuthorizationBeginInputSchema, DeviceAuthorizationInspectInputSchema, DeviceAuthorizationDecisionInputSchema, DeviceAuthorizationPollInputSchema,
  type DeviceAuthorizationHost, type DeviceAuthorizationBeginInput, type DeviceAuthorizationInspectInput, type DeviceAuthorizationDecisionInput,
  type DeviceAuthorizationPollInput, type DeviceAuthorizationBeginResult, type DeviceAuthorizationReview, type DeviceAuthorizationDecisionResult,
  type DeviceAuthorizationPollResult, type DevicePairingProofResult } from '../../contracts/execution/v1/device-pairing.js';
import type { RuntimePublicJwk, RuntimeRegistrationChallenge } from '../../contracts/execution/v1/runtime-registration.js';
import type { BootstrapNonce } from '../../contracts/execution/v1/bootstrap-status.js';
import { freezeTree, snapshotInput } from '../../packages/execution-state/decode.js';
import { transaction } from '../../packages/db/transaction.js';
import { assertCurrentSessionClock } from '../../packages/db/member-session.js';
import { withMemberScope, type MemberScopeContext } from '../../packages/resource-scopes/index.js';
import { scopedMemberCommand, scopedJournal } from '../../packages/scoped-commands/index.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import { createRuntimeRegistrationChallenge, verifyRuntimeRegistrationProof } from './runtime-proof.js';
import { createDevicePairingProofVerifier, parseDeviceAuthorizationHost, DevicePairingProofError } from './device-pairing-proof.js';
import { createBootstrapTokenIssuer } from './bootstrap-issuer.js';
import { insertInitialRefreshFamily } from './bootstrap-session-store.js';

type State = 'pending' | 'approved' | 'denied' | 'consumed';
interface Authorization {
  authorization_id: string; environment: DeviceAuthorizationHost['environment']; client_id: string; client_display_name: string;
  runtime_kind: DeviceAuthorizationBeginInput['runtimeKind']; public_jwk: RuntimePublicJwk; key_thumbprint: string;
  device_code_hash: string; device_code_wire_hash: string; user_code_hash: string; nonce: string; request_digest: string;
  issued_at: Date; expires_at: Date; state: State; owner_user_id: string | null; owner_principal_id: string | null;
  scope_id: string | null; challenge_id: string | null; decided_at: Date | null; consumed_at: Date | null;
  connection_id: string | null; bootstrap_nonce_id: string | null; poll_interval: number; last_poll_at: Date | null;
}
interface Enrollment {
  challenge_id: string; runtime_device_id: string; owner_user_id: string; owner_principal_id: string; scope_id: string;
  environment: DeviceAuthorizationHost['environment']; public_jwk: RuntimePublicJwk; key_thumbprint: string;
  nonce: string; issued_at: Date; expires_at: Date; consumed_at: Date | null;
}
const invalid = (): never => { throw new Problem(401, 'device_authorization_invalid', '裝置配對資料無效。'); };
const unavailable = () => new Problem(503, 'device_authorization_unavailable', '裝置配對暫時無法使用。');
const hash = (purpose: string, value: string) => createHash('sha256').update(JSON.stringify(['freedom.device-authorization/v1', purpose, value])).digest('hex');
const wireHash = (value: string) => createHash('sha256').update(value, 'ascii').digest('base64url');
const publicChallenge = (row: Enrollment): RuntimeRegistrationChallenge => createRuntimeRegistrationChallenge({ challenge_id: row.challenge_id,
  runtime_device_id: row.runtime_device_id, owner_member_id: row.owner_user_id, owner_principal_id: row.owner_principal_id,
  scope_id: row.scope_id, environment: row.environment, key_thumbprint: row.key_thumbprint, nonce: row.nonce,
  issued_at: row.issued_at.toISOString(), expires_at: row.expires_at.toISOString() });
const protocol = (status: 'access_denied' | 'expired_token'): DeviceAuthorizationPollResult => ({ status, operational_authority: false });

/** Closed coordinator. No caller-supplied verifier/signer, fake member Actor,
 * nested member factory, HTTP endpoint, raw secret receipt, or execution grant. */
export async function createDeviceAuthorizations(pool: Pool, options: { host: DeviceAuthorizationHost; signingKey: CryptoKey }) {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype || Reflect.ownKeys(options).sort().join(',') !== 'host,signingKey') throw new DevicePairingProofError();
  const descriptors = Object.getOwnPropertyDescriptors(options);
  if (Object.values(descriptors).some(d => !d.enumerable || !('value' in d))) throw new DevicePairingProofError();
  const host = parseDeviceAuthorizationHost(descriptors.host.value);
  const signingKey = descriptors.signingKey.value as CryptoKey;
  const verifier = createDevicePairingProofVerifier(host);
  const { issuerKid, beginUri: _beginUri, pollUri: _pollUri, verificationUri: _verificationUri, clientDisplayName: _name, ...proofHost } = host;
  const issuer = await createBootstrapTokenIssuer({ host: proofHost, kid: issuerKid, signingKey });
  const { environment, clientId } = host;
  async function bounded(q: PoolClient) {
    await q.query("SET LOCAL statement_timeout='5s'"); await q.query("SET LOCAL lock_timeout='5s'");
  }
  async function now(q: PoolClient): Promise<Date> {
    return (await q.query<{ now: Date }>("SELECT date_trunc('milliseconds',clock_timestamp()) now")).rows[0].now;
  }
  async function advisory(q: PoolClient, parts: unknown[]) { await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(parts)]); }
  async function ownerLock(q: PoolClient, principal: string) { await advisory(q, ['freedom.runtime-enrollment.owner/v1', environment, principal]); }
  async function keyLock(q: PoolClient, thumbprint: string) { await advisory(q, ['freedom.runtime-enrollment.key/v1', environment, thumbprint]); }
  function proofTime(evidence: DevicePairingProofResult, stamp: Date) {
    if (stamp.getTime() < evidence.validFromMs || stamp.getTime() >= evidence.validUntilMs) invalid();
  }
  function live(row: Authorization, stamp: Date) { return row.issued_at <= stamp && stamp < row.expires_at; }
  async function eligible(q: PoolClient, actor: Actor) {
    const result = await q.query('SELECT user_id FROM users WHERE user_id=$1 AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL)', [actor.user_id]);
    requireCondition(result.rowCount === 1, 403, 'onboarding_required', '請先完成加入。');
  }
  async function memberClock(q: PoolClient, actor: Actor) { await assertCurrentSessionClock(q, actor); return now(q); }
  async function locate(q: PoolClient, id: string, lock = false): Promise<Authorization | undefined> {
    return (await q.query<Authorization>(`SELECT * FROM device_authorizations WHERE authorization_id=$1 AND environment=$2 AND client_id=$3 ${lock ? 'FOR UPDATE' : ''}`,
      [id, environment, clientId])).rows[0];
  }
  function memberOwn(row: Authorization, actor: Actor, context: MemberScopeContext) {
    return row.state === 'pending' || row.owner_user_id === actor.user_id && row.owner_principal_id === context.subject_principal.principal_id && row.scope_id === context.scope.scope_id;
  }
  async function challengeRow(q: PoolClient, id: string) {
    return (await q.query<Enrollment>('SELECT * FROM runtime_registration_challenges WHERE challenge_id=$1 FOR UPDATE', [id])).rows[0];
  }
  async function registration(q: PoolClient, key: string) {
    return (await q.query<{ runtime_device_id: string; state: string }>('SELECT runtime_device_id,state FROM runtime_registrations WHERE environment=$1 AND key_thumbprint=$2 FOR UPDATE', [environment, key])).rows[0];
  }
  function challengeBinding(row: Authorization, challenge: Enrollment | undefined): Enrollment {
    if (!challenge || challenge.challenge_id !== row.challenge_id || challenge.owner_user_id !== row.owner_user_id
      || challenge.owner_principal_id !== row.owner_principal_id || challenge.scope_id !== row.scope_id
      || challenge.environment !== environment || challenge.key_thumbprint !== row.key_thumbprint) return invalid();
    return challenge;
  }
  async function guarded<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); } catch (error) {
      if (error instanceof Problem) throw error;
      if (['23505', '23514'].includes((error as { code?: string })?.code ?? '')) return invalid();
      throw unavailable();
    }
  }
  async function begin(raw: DeviceAuthorizationBeginInput): Promise<DeviceAuthorizationBeginResult> {
    let input: DeviceAuthorizationBeginInput;
    try { input = freezeTree(DeviceAuthorizationBeginInputSchema.parse(snapshotInput(raw))); } catch { return invalid(); }
    return guarded(() => transaction(pool, async q => {
      await bounded(q);
      const evidence = await verifier.verifyBegin({ ...input, nowMs: (await now(q)).getTime() });
      if (!evidence) return invalid();
      await advisory(q, ['freedom.device-authorization.admission/v1', environment]);
      await keyLock(q, evidence.keyThumbprint);
      if (await registration(q, evidence.keyThumbprint)) return invalid();
      const count = (await q.query<{ lifetime: number; pending: number; key_lifetime: number; key_pending: number }>(`SELECT count(*)::int lifetime,
        count(*) FILTER(WHERE state IN ('pending','approved') AND expires_at>clock_timestamp())::int pending,
        count(*) FILTER(WHERE key_thumbprint=$2)::int key_lifetime,
        count(*) FILTER(WHERE key_thumbprint=$2 AND state IN ('pending','approved') AND expires_at>clock_timestamp())::int key_pending
        FROM device_authorizations WHERE environment=$1`, [environment, evidence.keyThumbprint])).rows[0];
      requireCondition(count.lifetime < LIMITS.environmentLifetime && count.pending < LIMITS.environmentPending
        && count.key_lifetime < LIMITS.keyLifetime && count.key_pending < LIMITS.keyPending, 429, 'device_authorization_limit', '裝置配對數量已達上限。');
      const issuedAt = await now(q); proofTime(evidence, issuedAt);
      const authorizationId = randomUUID(), deviceCode = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url');
      const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
      const digits = [...randomBytes(10)].map(byte => alphabet[byte & 31]).join('');
      const userCode = digits.slice(0, 5)+'-'+digits.slice(5), expiresAt = new Date(issuedAt.getTime()+LIMITS.ttlSeconds*1000);
      const requestDigest = createHash('sha256').update(JSON.stringify({ profile: 'freedom.device-authorization/v1', authorizationId,
        environment, clientId, clientDisplayName: host.clientDisplayName, runtimeKind: input.runtimeKind, keyThumbprint: evidence.keyThumbprint, nonce,
        scope: 'bootstrap.status.read', issuedAt: issuedAt.toISOString(), expiresAt: expiresAt.toISOString() })).digest('base64url');
      await q.query(`INSERT INTO device_authorizations
        (authorization_id,environment,client_id,runtime_kind,public_jwk,key_thumbprint,begin_jti,device_code_hash,device_code_wire_hash,user_code_hash,nonce,request_digest,issued_at,expires_at,client_display_name)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [authorizationId, environment, clientId, input.runtimeKind, input.publicJwk, evidence.keyThumbprint, evidence.proofId,
        hash('device-code', deviceCode), wireHash(deviceCode), hash('user-code', userCode), nonce, requestDigest, issuedAt, expiresAt, host.clientDisplayName]);
      const final = await now(q); proofTime(evidence, final); if (final >= expiresAt) invalid();
      return { authorizationId, deviceCode, userCode, nonce, requestDigest, verificationUri: host.verificationUri,
        issuedAt: issuedAt.toISOString(), expiresAt: expiresAt.toISOString(), expiresIn: 300, interval: 5, operational_authority: false };
    }));
  }

  // The rate charge intentionally commits separately even for unknown codes or
  // a later failed decision. It carries no reusable authority into that decision.
  async function review(actor: Actor, userCode: string): Promise<Authorization> {
    const outcome = await withMemberScope(pool, { actor, scope: 'personal' }, async q => { await bounded(q); await eligible(q, actor); }, async (q, context) => {
      await advisory(q, ['freedom.device-authorization.review/v1', environment, context.subject_principal.principal_id]);
      const bucket = (await q.query<{ window_start: Date; attempts: number }>('SELECT * FROM device_review_buckets WHERE owner_principal_id=$1 AND environment=$2 FOR UPDATE',
        [context.subject_principal.principal_id, environment])).rows[0];
      const stamp = await memberClock(q, actor);
      if (bucket && stamp.getTime() < bucket.window_start.getTime()+LIMITS.reviewWindowSeconds*1000 && bucket.attempts >= LIMITS.reviewLookups) return { limited: true };
      if (!bucket) await q.query('INSERT INTO device_review_buckets(owner_principal_id,environment,window_start,attempts) VALUES($1,$2,$3,1)',
        [context.subject_principal.principal_id, environment, stamp]);
      else await q.query('UPDATE device_review_buckets SET window_start=$3,attempts=$4 WHERE owner_principal_id=$1 AND environment=$2',
        [context.subject_principal.principal_id, environment, stamp.getTime() >= bucket.window_start.getTime()+LIMITS.reviewWindowSeconds*1000 ? stamp : bucket.window_start,
          stamp.getTime() >= bucket.window_start.getTime()+LIMITS.reviewWindowSeconds*1000 ? 1 : bucket.attempts+1]);
      const row = (await q.query<Authorization>('SELECT * FROM device_authorizations WHERE user_code_hash=$1 AND environment=$2 AND client_id=$3',
        [hash('user-code', userCode), environment, clientId])).rows[0];
      const final = await memberClock(q, actor);
      return { row: row && live(row, final) && memberOwn(row, actor, context) ? row : undefined };
    });
    requireCondition(!outcome.limited, 429, 'device_review_limit', '配對代碼查找次數已達上限。');
    requireCondition(outcome.row, 404, 'device_authorization_not_found', '找不到這項裝置配對。');
    return outcome.row;
  }
  async function inspect(actor: Actor, raw: DeviceAuthorizationInspectInput): Promise<DeviceAuthorizationReview> {
    actor = Object.freeze({ ...actor }); const input = DeviceAuthorizationInspectInputSchema.parse(snapshotInput(raw));
    return guarded(async () => {
      const row = await review(actor, input.userCode);
      return { authorizationId: row.authorization_id, requestDigest: row.request_digest, clientId, clientDisplayName: row.client_display_name,
        environment, runtimeKind: row.runtime_kind, keyThumbprint: row.key_thumbprint, scope: 'bootstrap.status.read',
        expiresAt: row.expires_at.toISOString(), state: row.state, operational_authority: false };
    });
  }
  async function decide(actor: Actor, raw: DeviceAuthorizationDecisionInput): Promise<DeviceAuthorizationDecisionResult> {
    actor = Object.freeze({ ...actor }); const input = freezeTree(DeviceAuthorizationDecisionInputSchema.parse(snapshotInput(raw)));
    return guarded(async () => {
      await review(actor, input.userCode);
      let row!: Authorization;
      const operation = 'device.authorization.decide';
      return scopedMemberCommand(pool, { actor, scope: 'personal', operation, key: input.key,
        target: { kind: 'device_authorization', id: input.authorizationId }, body: { environment, clientId, requestDigest: input.requestDigest, decision: input.decision,
          userCodeHash: hash('user-code', input.userCode) } }, async (q, context) => {
        await bounded(q); await eligible(q, actor);
        const first = await locate(q, input.authorizationId);
        requireCondition(first && first.user_code_hash === hash('user-code', input.userCode) && first.request_digest === input.requestDigest,
          404, 'device_authorization_not_found', '找不到這項裝置配對。');
        await ownerLock(q, context.subject_principal.principal_id); await keyLock(q, first.key_thumbprint);
        if (first.challenge_id) await challengeRow(q, first.challenge_id);
        const registered = await registration(q, first.key_thumbprint);
        row = (await locate(q, input.authorizationId, true))!;
        requireCondition(row && row.user_code_hash === hash('user-code', input.userCode) && row.request_digest === input.requestDigest
          && memberOwn(row, actor, context) && row.state !== 'consumed' && live(row, await memberClock(q, actor)) && !registered,
        409, 'device_authorization_unavailable', '這項裝置配對目前無法使用。');
      }, async (q, context) => {
        requireCondition(row.state === 'pending', 409, 'device_authorization_unavailable', '這項裝置配對目前無法使用。');
        let challengeId: string | null = null;
        if (input.decision === 'approve') {
          const counts = (await q.query<{ pending: number; lifetime: number; registered: number }>(`SELECT
            (SELECT count(*)::int FROM runtime_registration_challenges WHERE owner_principal_id=$1 AND environment=$2) lifetime,
            (SELECT count(*)::int FROM runtime_registration_challenges WHERE owner_principal_id=$1 AND environment=$2 AND consumed_at IS NULL AND expires_at>clock_timestamp()) pending,
            (SELECT count(*)::int FROM runtime_registrations WHERE owner_principal_id=$1 AND environment=$2) registered`, [context.subject_principal.principal_id, environment])).rows[0];
          requireCondition(counts.pending < 10 && counts.lifetime < 1000 && counts.registered < 32, 429, 'runtime_registration_limit', '裝置登錄數量已達上限。');
          const stamp = await memberClock(q, actor); if (!live(row, stamp)) invalid();
          challengeId = randomUUID();
          await q.query(`INSERT INTO runtime_registration_challenges
            (challenge_id,runtime_device_id,owner_user_id,owner_principal_id,scope_id,environment,begin_key,public_jwk,key_thumbprint,nonce,issued_at,expires_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [challengeId, randomUUID(), actor.user_id, context.subject_principal.principal_id, context.scope.scope_id, environment,
            'device_'+row.authorization_id, row.public_jwk, row.key_thumbprint, randomBytes(32).toString('base64url'), stamp, new Date(stamp.getTime()+300000)]);
        }
        const stamp = await memberClock(q, actor); if (!live(row, stamp)) invalid();
        const state = input.decision === 'approve' ? 'approved' : 'denied';
        await q.query(`UPDATE device_authorizations SET state=$2,owner_user_id=$3,owner_principal_id=$4,scope_id=$5,challenge_id=$6,decided_at=$7 WHERE authorization_id=$1`,
          [row.authorization_id, state, actor.user_id, context.subject_principal.principal_id, context.scope.scope_id, challengeId, stamp]);
        await scopedJournal(q, context, { aggregate_type: 'device_authorization', id: row.authorization_id, version: '1', operation,
          data: { state, environment, operational_authority: false }, eventType: 'freedom.device.authorization.decided.v1' });
        if (!live(row, await memberClock(q, actor))) invalid();
        return { authorizationId: row.authorization_id, requestDigest: row.request_digest, state, operational_authority: false };
      });
    });
  }

  async function lockMachineOwner(q: PoolClient, row: Authorization) {
    if (!row.owner_user_id || !row.owner_principal_id || !row.scope_id) return invalid();
    const user = await q.query('SELECT user_id FROM users WHERE user_id=$1 AND active AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL) FOR SHARE', [row.owner_user_id]);
    const person = await q.query("SELECT principal_id FROM principals WHERE principal_id=$1 AND user_ref=$2 AND kind='person' AND status='active' FOR SHARE", [row.owner_principal_id, row.owner_user_id]);
    const scope = await q.query("SELECT scope_id FROM resource_scopes WHERE scope_id=$1 AND owner_principal_id=$2 AND kind='personal' AND status='active' FOR SHARE", [row.scope_id, row.owner_principal_id]);
    if (user.rowCount !== 1 || person.rowCount !== 1 || scope.rowCount !== 1) invalid();
    await ownerLock(q, row.owner_principal_id); await keyLock(q, row.key_thumbprint);
  }
  async function poll(raw: DeviceAuthorizationPollInput): Promise<DeviceAuthorizationPollResult> {
    let input: DeviceAuthorizationPollInput;
    try { input = freezeTree(DeviceAuthorizationPollInputSchema.parse(snapshotInput(raw))); } catch { return invalid(); }
    return guarded(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await transaction(pool, async (q: PoolClient): Promise<DeviceAuthorizationPollResult | null> => {
          await bounded(q);
          const first = await locate(q, input.authorizationId);
          if (!first || first.device_code_hash !== hash('device-code', input.deviceCode)) return invalid();
          let enrollment: Enrollment | undefined;
          let registered: { runtime_device_id: string; state: string } | undefined;
          if (first.state !== 'pending') {
            await lockMachineOwner(q, first);
            if (first.challenge_id) enrollment = await challengeRow(q, first.challenge_id);
            registered = await registration(q, first.key_thumbprint);
            if (registered) await q.query('SELECT connection_id FROM agent_connections WHERE runtime_device_id=$1 AND client_id=$2 FOR UPDATE', [registered.runtime_device_id, clientId]);
          }
          const row = await locate(q, input.authorizationId, true);
          if (!row) return invalid();
          // Never upgrade pending authorization -> owner locks inside one txn.
          if (first.state === 'pending' && row.state !== 'pending') return null;
          if (row.owner_user_id !== first.owner_user_id || row.owner_principal_id !== first.owner_principal_id || row.scope_id !== first.scope_id
            || row.device_code_hash !== hash('device-code', input.deviceCode)) return invalid();
          const proof = await verifier.verifyPoll({ proof: input.proof, publicJwk: row.public_jwk, runtimeKind: row.runtime_kind,
            authorizationId: row.authorization_id, nonce: row.nonce, deviceCodeHash: row.device_code_wire_hash, requestDigest: row.request_digest, nowMs: (await now(q)).getTime() });
          if (!proof) return invalid();
          let stamp = await now(q); proofTime(proof, stamp);
          const used = await q.query('SELECT proof_jti FROM device_poll_proofs WHERE authorization_id=$1 AND proof_jti=$2', [row.authorization_id, proof.proofId]);
          if (used.rowCount) return invalid();
          const count = (await q.query<{ n: number }>('SELECT count(*)::int n FROM device_poll_proofs WHERE authorization_id=$1', [row.authorization_id])).rows[0].n;
          if (count >= LIMITS.pollProofs || row.state === 'consumed') return invalid();
          const early = row.last_poll_at !== null && stamp.getTime() < row.last_poll_at.getTime()+row.poll_interval*1000;
          const interval = row.poll_interval+(early ? LIMITS.slowdownSeconds : 0);
          await q.query('UPDATE device_authorizations SET last_poll_at=$2,poll_interval=$3 WHERE authorization_id=$1', [row.authorization_id, stamp, interval]);
          stamp = await now(q); proofTime(proof, stamp);
          const finish = async (value: DeviceAuthorizationPollResult): Promise<DeviceAuthorizationPollResult> => {
            await q.query('INSERT INTO device_poll_proofs(authorization_id,proof_jti,accepted_at) VALUES($1,$2,$3)', [row.authorization_id, proof.proofId, stamp]);
            const final = await now(q); proofTime(proof, final);
            if (!live(row, final) || value.status === 'proof_required' && enrollment && final >= enrollment.expires_at) return protocol('expired_token');
            return value;
          };
          if (!live(row, stamp)) return finish(protocol('expired_token'));
          if (row.state === 'denied') return finish(protocol('access_denied'));
          if (early) return finish({ status: 'slow_down', interval, operational_authority: false });
          if (row.state === 'pending') return finish({ status: 'authorization_pending', interval, operational_authority: false });
          enrollment = challengeBinding(row, enrollment);
          if (registered || enrollment.consumed_at) return invalid();
          if (stamp < enrollment.issued_at || stamp >= enrollment.expires_at) return finish(protocol('expired_token'));
          if (!input.enrollmentProof) return finish({ status: 'proof_required', challenge: publicChallenge(enrollment), interval, operational_authority: false });
          if (!await verifyRuntimeRegistrationProof({ proof: input.enrollmentProof, challenge: publicChallenge(enrollment), public_jwk: row.public_jwk })) return invalid();
          const counts = (await q.query<{ runtimes: number; connections: number }>(`SELECT
            (SELECT count(*)::int FROM runtime_registrations WHERE owner_principal_id=$1 AND environment=$2) runtimes,
            (SELECT count(*)::int FROM agent_connections WHERE owner_principal_id=$1 AND environment=$2) connections`, [row.owner_principal_id, environment])).rows[0];
          if (counts.runtimes >= 32 || counts.connections >= 32) return invalid();
          stamp = await now(q); proofTime(proof, stamp);
          if (!live(row, stamp) || stamp < enrollment.issued_at || stamp >= enrollment.expires_at) return invalid();
          await q.query('INSERT INTO device_poll_proofs(authorization_id,proof_jti,accepted_at,exchange_challenge_id) VALUES($1,$2,$3,$4)',
            [row.authorization_id, proof.proofId, stamp, enrollment.challenge_id]);
          await q.query('UPDATE runtime_registration_challenges SET consumed_at=$2 WHERE challenge_id=$1 AND consumed_at IS NULL', [enrollment.challenge_id, stamp]);
          await q.query(`INSERT INTO runtime_registrations(runtime_device_id,challenge_id,owner_user_id,owner_principal_id,scope_id,environment,public_jwk,key_thumbprint,enrolled_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [enrollment.runtime_device_id, enrollment.challenge_id, row.owner_user_id, row.owner_principal_id, row.scope_id,
            environment, row.public_jwk, row.key_thumbprint, stamp]);
          const connectionId = randomUUID(), connectionExpiry = new Date(stamp.getTime()+30*24*60*60*1000);
          await q.query(`INSERT INTO agent_connections(connection_id,runtime_device_id,owner_user_id,owner_principal_id,scope_id,environment,client_id,issued_at,expires_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [connectionId, enrollment.runtime_device_id, row.owner_user_id, row.owner_principal_id, row.scope_id, environment, clientId, stamp, connectionExpiry]);
          const refresh = await insertInitialRefreshFamily(q, connectionId, stamp, connectionExpiry);
          const nonce: BootstrapNonce = { nonceId: randomUUID(), nonce: randomBytes(32).toString('base64url'), connectionId,
            issuedAt: stamp.toISOString(), expiresAt: new Date(stamp.getTime()+60000).toISOString(), operational_authority: false };
          await q.query(`INSERT INTO bootstrap_nonces(nonce_id,connection_id,runtime_device_id,owner_user_id,owner_principal_id,scope_id,environment,client_id,connection_version,challenge_key,nonce,issued_at,expires_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11,$12)`, [nonce.nonceId, connectionId, enrollment.runtime_device_id, row.owner_user_id, row.owner_principal_id,
            row.scope_id, environment, clientId, 'device_'+row.authorization_id, nonce.nonce, stamp, nonce.expiresAt]);
          const token = await issuer.issue({ binding: { ownerUserId: row.owner_user_id!, principalId: row.owner_principal_id!, scopeId: row.scope_id!,
            runtimeDeviceId: enrollment.runtime_device_id, connectionId, connectionVersion: '1', keyThumbprint: row.key_thumbprint }, nowMs: (await now(q)).getTime(), notAfterMs: connectionExpiry.getTime() });
          if (!token) return invalid();
          stamp = await now(q); proofTime(proof, stamp);
          if (!live(row, stamp) || stamp >= enrollment.expires_at || stamp.getTime() < token.validFromMs || stamp.getTime() >= token.validUntilMs || stamp >= new Date(nonce.expiresAt)) return invalid();
          await q.query(`UPDATE device_authorizations SET state='consumed',consumed_at=$2,connection_id=$3,bootstrap_nonce_id=$4,token_jti=$5 WHERE authorization_id=$1`,
            [row.authorization_id, stamp, connectionId, nonce.nonceId, token.tokenId]);
          const final = await now(q); proofTime(proof, final);
          if (!live(row, final) || final >= enrollment.expires_at || final.getTime() < token.validFromMs || final.getTime() >= token.validUntilMs
            || final >= connectionExpiry || final >= new Date(nonce.expiresAt)) return invalid();
          return { status: 'issued', accessToken: token.accessToken, tokenType: 'DPoP', expiresAt: new Date(token.expiresAt*1000).toISOString(),
            connectionId, runtimeDeviceId: enrollment.runtime_device_id, nonce, refresh, refreshSupported: true, operational_authority: false };
        });
        if (result) return result;
      }
      return invalid();
    });
  }
  return Object.freeze({ begin, inspect, decide, poll });
}
