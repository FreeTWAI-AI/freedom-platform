import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { command, journal, transaction, type Command } from '../../packages/db/index.js';
import { lockMemberSession } from '../../packages/db/member-session.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import { hashPasswordAsync, tokenHash, verifyMemberPassword, type Actor } from './service.js';

const PasswordChangeInput = z.object({
  current_password: z.string().min(1).max(200),
  new_password: z.string().min(12, '新密碼需為 12 到 128 個字元。').max(128, '新密碼需為 12 到 128 個字元。'),
}).strict();

export type MemberSessionView = { current: boolean; created_at: string | null; last_seen_at: string | null; expires_at: string };
export type MemberSessionList = { items: MemberSessionView[]; total: number };
export type PasswordChangeResult = { changed: true; revoked_sessions: number };
export type SessionRevocationResult = { revoked_sessions: number; aggregate_version: number };

const iso = (value: Date | null) => value ? new Date(value).toISOString() : null;

/** Password re-check with the login lockout window. No command receipt: the
 * password must never enter a request digest. Failure counts commit before
 * the problem is raised, matching login(). */
export async function changePassword(pool: Pool, actor: Actor, raw: unknown): Promise<PasswordChangeResult> {
  const body = PasswordChangeInput.parse(raw);
  requireCondition(body.new_password !== body.current_password, 422, 'password_unchanged', '新密碼不能與目前密碼相同。');
  const passwordHash = await hashPasswordAsync(body.new_password);
  const attemptKey = tokenHash(`password-change:${actor.user_id}`);
  const outcome = await transaction(pool, async q => {
    await lockMemberSession(q, actor, true);
    // DO UPDATE locks an existing row, so the scheduled prune cannot delete it before the SELECT below.
    await q.query('INSERT INTO login_attempts VALUES($1,0,now()) ON CONFLICT (attempt_key) DO UPDATE SET attempt_key=excluded.attempt_key', [attemptKey]);
    const attempt = (await q.query<{ failures: number; window_start: Date }>('SELECT failures, window_start FROM login_attempts WHERE attempt_key=$1 FOR UPDATE', [attemptKey])).rows[0];
    if (Date.now() - new Date(attempt.window_start).getTime() > 15 * 60 * 1000) {
      await q.query('UPDATE login_attempts SET failures=0, window_start=now() WHERE attempt_key=$1', [attemptKey]);
      attempt.failures = 0;
    }
    if (attempt.failures >= 10) return { kind: 'blocked' as const };
    const valid = await verifyMemberPassword(q, actor.user_id, body.current_password);
    if (!valid) {
      await q.query('UPDATE login_attempts SET failures=failures+1 WHERE attempt_key=$1', [attemptKey]);
      return { kind: 'invalid' as const };
    }
    await q.query('UPDATE login_attempts SET failures=0 WHERE attempt_key=$1', [attemptKey]);
    await q.query('UPDATE users SET password_hash=$2 WHERE user_id=$1', [actor.user_id, passwordHash]);
    // The session that proved the password stays signed in; every other one ends now.
    const revoked = (await q.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL AND token_hash<>$2', [actor.user_id, actor.session_hash])).rowCount ?? 0;
    const version = await accountVersion(q, actor);
    await journal(q, actor, 'member_account', actor.user_id, version, 'change_password', { revoked_sessions: revoked });
    return { kind: 'changed' as const, revoked };
  });
  if (outcome.kind === 'blocked') throw new Problem(429, 'password_change_rate_limited', '密碼確認次數過多，請稍後再試。', 900);
  if (outcome.kind === 'invalid') throw new Problem(403, 'current_password_invalid', '目前密碼不正確。');
  return { changed: true, revoked_sessions: outcome.revoked };
}
async function accountVersion(q: PoolClient, actor: Actor): Promise<number> {
  await q.query('INSERT INTO member_accounts(user_id,community_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [actor.user_id, actor.community_id]);
  // The journal is unique per aggregate version, so every security change advances the account.
  return Number((await q.query<{ aggregate_version: string }>('UPDATE member_accounts SET aggregate_version=aggregate_version+1 WHERE user_id=$1 AND community_id=$2 RETURNING aggregate_version', [actor.user_id, actor.community_id])).rows[0].aggregate_version);
}

export async function listMemberSessions(pool: Pool, actor: Actor): Promise<MemberSessionList> {
  const rows = (await pool.query<{ current: boolean; created_at: Date | null; last_seen_at: Date | null; expires_at: Date }>(
    `SELECT token_hash=$2 AS current, created_at, last_seen_at, expires_at FROM sessions
     WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now()
     ORDER BY token_hash=$2 DESC, last_seen_at DESC NULLS LAST, created_at DESC NULLS LAST LIMIT 50`, [actor.user_id, actor.session_hash])).rows;
  return { items: rows.map(row => ({ current: row.current, created_at: iso(row.created_at), last_seen_at: iso(row.last_seen_at), expires_at: iso(row.expires_at)! })), total: rows.length };
}

export async function revokeOtherSessions(pool: Pool, input: Command): Promise<SessionRevocationResult> {
  z.object({}).strict().parse(input.body);
  return command(pool, { ...input, lockUser: true }, async () => {}, async q => {
    const revoked = (await q.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL AND token_hash<>$2', [input.actor.user_id, input.actor.session_hash])).rowCount ?? 0;
    const version = await accountVersion(q, input.actor);
    await journal(q, input.actor, 'member_account', input.actor.user_id, version, 'revoke_other_sessions', { revoked_sessions: revoked });
    return { revoked_sessions: revoked, aggregate_version: version };
  });
}
