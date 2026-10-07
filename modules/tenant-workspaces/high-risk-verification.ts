import type { Pool, PoolClient } from 'pg';
import { HighRiskVerificationInputSchema, HighRiskVerificationSchema } from '../../contracts/guild-launchpad/v1/tenant.js';
import type { Actor } from '../identity-membership/service.js';
import { tokenHash, verifyMemberPassword } from '../identity-membership/service.js';
import { transaction } from '../../packages/db/transaction.js';
import { assertCurrentSessionClock, lockMemberSession } from '../../packages/db/member-session.js';
import { mapPersonPrincipal } from '../../packages/resource-scopes/index.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import { iso, NOT_FOUND } from './facts.js';
import { loadActivePolicy } from './policy.js';

type Purpose = 'tenant.ownership.propose' | 'tenant.ownership.accept' | 'tenant.recovery.accept';

export function receiptNamespaceDigest(profile: string, parts: readonly string[]): string {
  return tokenHash(JSON.stringify([profile, ...parts]));
}

async function qualified(q: PoolClient, actor: Actor, principalId: string, tenantId: string, purpose: Purpose): Promise<void> {
  const tenant = (await q.query<{ community_id: string; status: string }>(
    `SELECT community_id, status FROM tenants WHERE tenant_id=$1`, [tenantId])).rows[0];
  if (!tenant || tenant.community_id !== actor.community_id) throw new Problem(404, 'tenant_not_found', NOT_FOUND);
  if (purpose === 'tenant.ownership.propose') {
    const owner = await q.query(`SELECT 1 FROM tenant_memberships
      WHERE tenant_id=$1 AND principal_id=$2 AND role='owner' AND status='active'`, [tenantId, principalId]);
    if (tenant.status !== 'active' || owner.rowCount !== 1) throw new Problem(404, 'tenant_not_found', NOT_FOUND);
    return;
  }
  if (purpose === 'tenant.ownership.accept') {
    const transfer = await q.query(`SELECT 1 FROM tenant_ownership_transfers
      WHERE tenant_id=$1 AND to_principal_id=$2 AND state='pending'`, [tenantId, principalId]);
    if (transfer.rowCount !== 1) throw new Problem(404, 'tenant_not_found', NOT_FOUND);
    return;
  }
  const recovery = await q.query(`SELECT 1 FROM tenant_recovery_cases
    WHERE tenant_id=$1 AND proposed_owner_principal_id=$2 AND state IN ('opened','evidence_required','approved')`, [tenantId, principalId]);
  if ((recovery.rowCount ?? 0) < 1) throw new Problem(404, 'tenant_not_found', NOT_FOUND);
}

/** Password re-check. No receipt: the password must never enter a digest.
 * Failure counts commit before the problem is raised, matching login(). */
export async function createHighRiskVerification(pool: Pool, actor: Actor, body: unknown) {
  const input = HighRiskVerificationInputSchema.parse(body);
  const outcome = await transaction(pool, async q => {
    await lockMemberSession(q, actor);
    const principal = await mapPersonPrincipal(q, actor.user_id);
    requireCondition(principal.status === 'active' && principal.kind === 'person', 403, 'principal_disabled', '這個身分目前無法使用。');
    await qualified(q, actor, principal.principal_id, input.tenant_id, input.purpose);
    const attemptKey = tokenHash(`high-risk-verification:${actor.user_id}`);
    await q.query(`INSERT INTO login_attempts VALUES($1,0,now()) ON CONFLICT DO NOTHING`, [attemptKey]);
    const attempt = (await q.query<{ failures: number; window_start: Date }>(
      `SELECT failures, window_start FROM login_attempts WHERE attempt_key=$1 FOR UPDATE`, [attemptKey])).rows[0];
    if (Date.now() - new Date(attempt.window_start).getTime() > 15 * 60 * 1000) {
      await q.query(`UPDATE login_attempts SET failures=0, window_start=now() WHERE attempt_key=$1`, [attemptKey]);
      attempt.failures = 0;
    }
    if (attempt.failures >= 10) return { kind: 'blocked' as const };
    let policy: { fresh_auth_ttl_seconds: number };
    try {
      policy = await loadActivePolicy(q);
    } catch (error) {
      if (error instanceof Problem && error.code === 'policy_unconfigured') return { kind: 'unconfigured' as const };
      throw error;
    }
    const valid = await verifyMemberPassword(q, actor.user_id, input.password);
    if (!valid) {
      await q.query(`UPDATE login_attempts SET failures=failures+1 WHERE attempt_key=$1`, [attemptKey]);
      return { kind: 'invalid' as const };
    }
    await q.query(`UPDATE login_attempts SET failures=0 WHERE attempt_key=$1`, [attemptKey]);
    const row = (await q.query<{ verification_id: string; expires_at: Date }>(
      `INSERT INTO tenant_high_risk_verifications(user_id,principal_id,session_hash,tenant_id,purpose,verified_at,expires_at)
       VALUES($1,$2,$3,$4,$5,clock_timestamp(),clock_timestamp()+make_interval(secs => $6))
       RETURNING verification_id, expires_at`,
      [actor.user_id, principal.principal_id, actor.session_hash, input.tenant_id, input.purpose, policy.fresh_auth_ttl_seconds])).rows[0];
    return {
      kind: 'created' as const,
      body: HighRiskVerificationSchema.parse({
        verification_id: row.verification_id, purpose: input.purpose, tenant_id: input.tenant_id, expires_at: iso(row.expires_at),
      }),
    };
  });
  if (outcome.kind === 'blocked') throw new Problem(429, 'fresh_auth_rate_limited', '重新驗證次數過多，請稍後再試。', 900);
  if (outcome.kind === 'unconfigured') throw new Problem(403, 'policy_unconfigured', '業務空間權限政策尚未設定。');
  if (outcome.kind === 'invalid') throw new Problem(403, 'fresh_auth_required', '密碼不正確');
  return outcome.body;
}

export async function requireFreshVerification(q: PoolClient, input: {
  userId: string; sessionHash: string; principalId: string; tenantId: string; purpose: Purpose;
  verificationId: string; namespaceDigest: string;
}): Promise<void> {
  // An expired session must win over a missing verification. authorize runs
  // after the receipt lock, so a wait there can outlive the session.
  await assertCurrentSessionClock(q, { user_id: input.userId, session_hash: input.sessionHash });
  const row = (await q.query<{ consumed_by: string | null }>(`SELECT v.consumed_by
    FROM tenant_high_risk_verifications v
    JOIN sessions s ON s.token_hash=v.session_hash
    WHERE v.verification_id=$1 AND v.user_id=$2 AND v.principal_id=$3 AND v.session_hash=$4
      AND v.tenant_id=$5 AND v.purpose=$6 AND v.expires_at>clock_timestamp()
      AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
    FOR UPDATE OF v`,
  [input.verificationId, input.userId, input.principalId, input.sessionHash, input.tenantId, input.purpose])).rows[0];
  if (!row || (row.consumed_by !== null && row.consumed_by !== input.namespaceDigest)) {
    throw new Problem(403, 'fresh_auth_required', '需要重新驗證。');
  }
}

/** The row lock from requireFreshVerification does not keep expires_at current.
 * Call this after the last lock wait and before effects. clock_timestamp()
 * moves during the wait; transaction-start now() does not. */
export async function assertFreshVerificationCurrent(q: PoolClient, verificationId: string): Promise<void> {
  const row = (await q.query<{ ok: boolean }>(
    `SELECT expires_at > clock_timestamp() AS ok FROM tenant_high_risk_verifications WHERE verification_id=$1`,
    [verificationId])).rows[0];
  requireCondition(row?.ok === true, 403, 'fresh_auth_required', '需要重新驗證。');
}

export async function consumeFreshVerification(q: PoolClient, verificationId: string, namespaceDigest: string): Promise<void> {
  const consumed = await q.query(`UPDATE tenant_high_risk_verifications
    SET consumed_at=clock_timestamp(), consumed_by=$2
    WHERE verification_id=$1 AND consumed_at IS NULL AND expires_at > clock_timestamp()`, [verificationId, namespaceDigest]);
  requireCondition(consumed.rowCount === 1, 403, 'fresh_auth_required', '需要重新驗證。');
}
