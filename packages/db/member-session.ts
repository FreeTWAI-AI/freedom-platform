import type { PoolClient } from 'pg';
import type { Actor } from '../../modules/identity-membership/service.js';
import { requireCondition } from '../shared/problem.js';

// Same transaction/ordering as legacy memberCommand. Not a serialized auth proof.
export async function lockMemberSession(q: PoolClient, actor: Actor, lockUser = false): Promise<void> {
  const activeUser=await q.query(`SELECT user_id FROM users WHERE user_id=$1 AND community_id=$2 AND active
    ${lockUser ? 'FOR UPDATE' : 'FOR SHARE'}`,[actor.user_id,actor.community_id]);
  requireCondition(activeUser.rowCount===1,401,'session_expired','請重新登入。');
  const active=await q.query(`SELECT token_hash FROM sessions WHERE token_hash=$1 AND user_id=$2
    AND revoked_at IS NULL AND expires_at>now() FOR SHARE`,[actor.session_hash,actor.user_id]);
  requireCondition(active.rowCount===1,401,'session_expired','請重新登入。');
}

/** Decision-clock refresh only, NOT standalone authentication. The caller must
 * already hold current user/session locks through lockMemberSession (directly
 * or via member-scope resolution) on this SAME open transaction client. Call
 * after the final potentially blocking domain/policy query and before returning
 * private data or handing an authorized snapshot to an external-effect phase.
 * Existing legacy member authentication/order deliberately remains unchanged.
 */
export async function assertCurrentSessionClock(q: PoolClient, actor: Pick<Actor, 'user_id' | 'session_hash'>): Promise<void> {
  const current = await q.query(`SELECT token_hash FROM sessions WHERE token_hash=$1 AND user_id=$2
    AND revoked_at IS NULL AND expires_at>clock_timestamp()`, [actor.session_hash, actor.user_id]);
  requireCondition(current.rowCount === 1, 401, 'session_expired', '請重新登入。');
}
