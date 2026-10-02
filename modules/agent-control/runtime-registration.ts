import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import type { Actor } from '../identity-membership/service.js';
import { OpaqueId } from '../../contracts/common/v1/identity.js';
import { RuntimeEnvironmentSchema as environmentSchema, RUNTIME_ENROLLMENT_TTL_MS, RUNTIME_ENROLLMENT_LIMITS,
  type RuntimePublicJwk, type RuntimeRegistrationChallenge } from '../../contracts/execution/v1/runtime-registration.js';
import { ExecutionVersion } from '../../contracts/execution/v1/state.js';
import { parseRuntimePublicJwk, runtimePublicKeyThumbprint, createRuntimeRegistrationChallenge, verifyRuntimeRegistrationProof } from './runtime-proof.js';
import { withMemberScope, type MemberScopeContext } from '../../packages/resource-scopes/index.js';
import { scopedMemberCommand, scopedJournal } from '../../packages/scoped-commands/index.js';
import { assertCurrentSessionClock } from '../../packages/db/member-session.js';
import { checkVersion } from '../../packages/db/index.js';
import { requireCondition } from '../../packages/shared/problem.js';

const keySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$(?![\s\S])/);
const versionSchema = ExecutionVersion.refine(v => BigInt(v) <= 9223372036854775807n);
const beginSchema = z.object({ key: keySchema, publicJwk: z.unknown() }).strict();
const confirmSchema = z.object({ key: keySchema, challengeId: OpaqueId, proof: z.string().min(1).max(RUNTIME_ENROLLMENT_LIMITS.proofBytes) }).strict();
const readSchema = z.object({ runtimeDeviceId: OpaqueId }).strict();
const revokeSchema = readSchema.extend({ key: keySchema, expectedVersion: versionSchema.optional() }).strict();
export interface BeginRuntimeRegistrationInput { key: string; publicJwk: RuntimePublicJwk }
export interface ConfirmRuntimeRegistrationInput { key: string; challengeId: string; proof: string }
export interface ReadRuntimeRegistrationInput { runtimeDeviceId: string }
export interface RevokeRuntimeRegistrationInput extends ReadRuntimeRegistrationInput { key: string; expectedVersion: string }
export interface RuntimeRegistrationMetadata {
  readonly runtimeDeviceId: string; readonly environment: z.infer<typeof environmentSchema>;
  readonly keyThumbprint: string; readonly state: 'enrolled' | 'revoked'; readonly aggregateVersion: string;
  readonly operational_authority: false;
}
interface ChallengeRow {
  challenge_id: string; runtime_device_id: string; owner_user_id: string; owner_principal_id: string; scope_id: string;
  environment: z.infer<typeof environmentSchema>; public_jwk: RuntimePublicJwk; key_thumbprint: string; nonce: string;
  issued_at: Date; expires_at: Date; consumed_at: Date | null;
}
interface RegistrationRow {
  runtime_device_id: string; challenge_id: string; key_thumbprint: string; environment: z.infer<typeof environmentSchema>;
  state: 'enrolled' | 'revoked'; aggregate_version: string;
}
const metadata = (row: RegistrationRow): RuntimeRegistrationMetadata => Object.freeze({ runtimeDeviceId: row.runtime_device_id,
  environment: row.environment, keyThumbprint: row.key_thumbprint, state: row.state,
  aggregateVersion: row.aggregate_version, operational_authority: false });
const challenge = (row: ChallengeRow): RuntimeRegistrationChallenge => createRuntimeRegistrationChallenge({
  challenge_id: row.challenge_id, runtime_device_id: row.runtime_device_id, owner_member_id: row.owner_user_id,
  owner_principal_id: row.owner_principal_id, scope_id: row.scope_id, environment: row.environment,
  key_thumbprint: row.key_thumbprint, nonce: row.nonce, issued_at: row.issued_at.toISOString(), expires_at: row.expires_at.toISOString(),
});
const unavailable = () => requireCondition(false, 409, 'runtime_registration_unavailable', '這項裝置登錄目前無法使用。');
function plainInput(value: unknown): void {
  requireCondition(value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    && Object.getOwnPropertySymbols(value).length === 0
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(d => d.enumerable && 'value' in d),
  400, 'invalid_runtime_registration', '裝置登錄資料無效。');
}

/** Internal current-member factory only. Enrollment proves key possession, never
 * a trustworthy runtime build, machine authentication, or execution authority. */
export function createRuntimeRegistrations(pool: Pool, rawOptions: { environment: z.infer<typeof environmentSchema> }) {
  plainInput(rawOptions);
  const { environment } = z.object({ environment: environmentSchema }).strict().parse(rawOptions);
  async function eligible(q: PoolClient, actor: Actor) {
    const row = await q.query('SELECT user_id FROM users WHERE user_id=$1 AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL)', [actor.user_id]);
    requireCondition(row.rowCount === 1, 403, 'onboarding_required', '請先完成加入。');
  }
  async function ownerLock(q: PoolClient, context: MemberScopeContext) {
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [JSON.stringify(['freedom.runtime-enrollment.owner/v1', environment, context.subject_principal.principal_id])]);
  }
  async function keyLock(q: PoolClient, thumbprint: string) {
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [JSON.stringify(['freedom.runtime-enrollment.key/v1', environment, thumbprint])]);
  }
  async function decisionClock(q: PoolClient, actor: Actor): Promise<Date> {
    await assertCurrentSessionClock(q, actor);
    return (await q.query<{ now: Date }>("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0].now;
  }
  async function registrationByKey(q: PoolClient, thumbprint: string): Promise<RegistrationRow | undefined> {
    return (await q.query<RegistrationRow>('SELECT *,aggregate_version::text FROM runtime_registrations WHERE environment=$1 AND key_thumbprint=$2 FOR UPDATE', [environment, thumbprint])).rows[0];
  }
  async function ownedChallenge(q: PoolClient, context: MemberScopeContext, actor: Actor, id: string, lock = true): Promise<ChallengeRow> {
    const row = (await q.query<ChallengeRow>(`SELECT * FROM runtime_registration_challenges
      WHERE challenge_id=$1 AND environment=$2 AND owner_user_id=$3 AND owner_principal_id=$4 AND scope_id=$5 ${lock ? 'FOR UPDATE' : ''}`,
    [id, environment, actor.user_id, context.subject_principal.principal_id, context.scope.scope_id])).rows[0];
    requireCondition(row, 404, 'not_found', '找不到這項装置登錄。');
    return row;
  }
  async function ownedRegistration(q: PoolClient, context: MemberScopeContext, actor: Actor, id: string): Promise<RegistrationRow> {
    // Resolve immutable key before taking key/challenge/registration locks.
    const identity = (await q.query<{ challenge_id: string; key_thumbprint: string }>(`SELECT challenge_id,key_thumbprint FROM runtime_registrations
      WHERE runtime_device_id=$1 AND environment=$2 AND owner_user_id=$3 AND owner_principal_id=$4 AND scope_id=$5`,
    [id, environment, actor.user_id, context.subject_principal.principal_id, context.scope.scope_id])).rows[0];
    requireCondition(identity, 404, 'not_found', '找不到這項装置登錄。');
    await keyLock(q, identity.key_thumbprint);
    await ownedChallenge(q, context, actor, identity.challenge_id);
    return (await registrationByKey(q, identity.key_thumbprint))!;
  }
  async function record(q: PoolClient, context: MemberScopeContext, operation: string, row: RegistrationRow) {
    await scopedJournal(q, context, { aggregate_type: 'runtime_registration', id: row.runtime_device_id,
      version: row.aggregate_version, operation, data: { state: row.state, environment, operational_authority: false },
      eventType: 'freedom.runtime.registration.recorded.v1' });
    return metadata(row);
  }
  async function begin(actor: Actor, raw: BeginRuntimeRegistrationInput): Promise<RuntimeRegistrationChallenge> {
    actor = Object.freeze({ ...actor });
    plainInput(raw);
    const parsed = beginSchema.parse(raw), publicJwk = Object.freeze(parseRuntimePublicJwk(parsed.publicJwk));
    const input = Object.freeze({ key: parsed.key, publicJwk }), thumbprint = await runtimePublicKeyThumbprint(publicJwk);
    const operation = 'runtime.registration.begin';
    let prior: ChallengeRow | undefined;
    return scopedMemberCommand(pool, { actor, scope: 'personal', operation, key: input.key,
      target: { kind: 'member_runtime_enrollment', id: actor.user_id }, body: { environment, publicJwk } },
    async (q, context) => {
      await eligible(q, actor);
      await ownerLock(q, context); await keyLock(q, thumbprint);
      prior = (await q.query<ChallengeRow>(`SELECT * FROM runtime_registration_challenges
        WHERE owner_principal_id=$1 AND environment=$2 AND begin_key=$3 FOR UPDATE`,
      [context.subject_principal.principal_id, environment, input.key])).rows[0];
      const current = await registrationByKey(q, thumbprint), now = await decisionClock(q, actor);
      if (current || prior && (prior.consumed_at || prior.expires_at <= now)) unavailable();
    }, async (q, context) => {
      const now = await decisionClock(q, actor);
      const counts = (await q.query<{ lifetime: number; pending: number; registered: number }>(`SELECT
        (SELECT count(*)::int FROM runtime_registration_challenges WHERE owner_principal_id=$1 AND environment=$2) lifetime,
        (SELECT count(*)::int FROM runtime_registration_challenges WHERE owner_principal_id=$1 AND environment=$2 AND consumed_at IS NULL AND expires_at>$3) pending,
        (SELECT count(*)::int FROM runtime_registrations WHERE owner_principal_id=$1 AND environment=$2) registered`,
      [context.subject_principal.principal_id, environment, now])).rows[0];
      requireCondition(counts.lifetime < 1000 && counts.pending < 10 && counts.registered < 32,
        429, 'runtime_registration_limit', '裝置登錄數量已達上限。');
      const issuedAt = await decisionClock(q, actor);
      const row = (await q.query<ChallengeRow>(`INSERT INTO runtime_registration_challenges
        (challenge_id,runtime_device_id,owner_user_id,owner_principal_id,scope_id,environment,begin_key,public_jwk,key_thumbprint,nonce,issued_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [randomUUID(), randomUUID(), actor.user_id, context.subject_principal.principal_id, context.scope.scope_id,
        environment, input.key, publicJwk, thumbprint, randomBytes(32).toString('base64url'), issuedAt, new Date(issuedAt.getTime() + RUNTIME_ENROLLMENT_TTL_MS)])).rows[0];
      await scopedJournal(q, context, { aggregate_type: 'runtime_registration_challenge', id: row.challenge_id,
        version: '1', operation, data: { environment, operational_authority: false }, eventType: 'freedom.runtime.registration.challenge.v1' });
      return challenge(row);
    });
  }
  async function confirm(actor: Actor, raw: ConfirmRuntimeRegistrationInput): Promise<RuntimeRegistrationMetadata> {
    plainInput(raw);
    actor = Object.freeze({ ...actor }); const input = Object.freeze(confirmSchema.parse(raw)), operation = 'runtime.registration.confirm';
    let current!: ChallengeRow, existing: RegistrationRow | undefined;
    return scopedMemberCommand(pool, { actor, scope: 'personal', operation, key: input.key,
      target: { kind: 'runtime_registration_challenge', id: input.challengeId },
      body: { environment, proof_sha256: createHash('sha256').update(input.proof).digest('hex') } },
    async (q, context) => {
      await eligible(q, actor);
      await ownerLock(q, context);
      const identity = await ownedChallenge(q, context, actor, input.challengeId, false);
      await keyLock(q, identity.key_thumbprint);
      current = await ownedChallenge(q, context, actor, input.challengeId);
      existing = await registrationByKey(q, current.key_thumbprint);
      if (existing && (existing.challenge_id !== current.challenge_id || existing.state !== 'enrolled')) unavailable();
      await decisionClock(q, actor);
    }, async (q, context) => {
      if (current.consumed_at || existing) unavailable();
      const now = await decisionClock(q, actor);
      requireCondition(current.issued_at <= now && now < current.expires_at, 409, 'runtime_challenge_expired', '裝置登錄驗證已過期。');
      const valid = await verifyRuntimeRegistrationProof({ proof: input.proof, challenge: challenge(current), public_jwk: current.public_jwk });
      requireCondition(valid, 403, 'runtime_proof_invalid', '裝置登錄驗證無效。');
      const count = (await q.query<{ n: number }>('SELECT count(*)::int n FROM runtime_registrations WHERE owner_principal_id=$1 AND environment=$2',
        [context.subject_principal.principal_id, environment])).rows[0].n;
      requireCondition(count < 32, 429, 'runtime_registration_limit', '裝置登錄數量已達上限。');
      const finalNow = await decisionClock(q, actor);
      requireCondition(current.issued_at <= finalNow && finalNow < current.expires_at, 409, 'runtime_challenge_expired', '裝置登錄驗證已過期。');
      await q.query('UPDATE runtime_registration_challenges SET consumed_at=$2 WHERE challenge_id=$1 AND consumed_at IS NULL', [current.challenge_id, finalNow]);
      const row = (await q.query<RegistrationRow>(`INSERT INTO runtime_registrations
        (runtime_device_id,challenge_id,owner_user_id,owner_principal_id,scope_id,environment,public_jwk,key_thumbprint,enrolled_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *,aggregate_version::text`,
      [current.runtime_device_id, current.challenge_id, actor.user_id, context.subject_principal.principal_id,
        context.scope.scope_id, environment, current.public_jwk, current.key_thumbprint, finalNow])).rows[0];
      return record(q, context, operation, row);
    });
  }
  async function read(actor: Actor, raw: ReadRuntimeRegistrationInput): Promise<RuntimeRegistrationMetadata> {
    plainInput(raw);
    actor = Object.freeze({ ...actor }); const input = Object.freeze(readSchema.parse(raw));
    return withMemberScope(pool, { actor, scope: 'personal' }, async q => { await eligible(q, actor); }, async (q, context) => {
      await ownerLock(q, context); const row = await ownedRegistration(q, context, actor, input.runtimeDeviceId);
      await decisionClock(q, actor); return metadata(row);
    });
  }
  async function revoke(actor: Actor, raw: RevokeRuntimeRegistrationInput): Promise<RuntimeRegistrationMetadata> {
    plainInput(raw);
    actor = Object.freeze({ ...actor }); const input = Object.freeze(revokeSchema.parse(raw)), operation = 'runtime.registration.revoke';
    let current!: RegistrationRow;
    return scopedMemberCommand(pool, { actor, scope: 'personal', operation, key: input.key,
      target: { kind: 'runtime_registration', id: input.runtimeDeviceId }, expected: input.expectedVersion, body: { environment } },
    async (q, context) => { await eligible(q, actor); await ownerLock(q, context); current = await ownedRegistration(q, context, actor, input.runtimeDeviceId); },
    async (q, context) => {
      checkVersion(current.aggregate_version, input.expectedVersion);
      if (current.state === 'revoked') unavailable();
      requireCondition(BigInt(current.aggregate_version) < 9223372036854775807n, 409, 'runtime_version_exhausted', '裝置登錄無法再更新。');
      const now = await decisionClock(q, actor);
      const row = (await q.query<RegistrationRow>(`UPDATE runtime_registrations SET state='revoked',revoked_at=$3,aggregate_version=aggregate_version+1
        WHERE runtime_device_id=$1 AND aggregate_version=$2 RETURNING *,aggregate_version::text`, [input.runtimeDeviceId, input.expectedVersion, now])).rows[0];
      requireCondition(row, 412, 'version_conflict', '資料已更新，請重新整理後再操作。');
      return record(q, context, operation, row);
    });
  }
  return Object.freeze({ begin, confirm, read, revoke });
}
