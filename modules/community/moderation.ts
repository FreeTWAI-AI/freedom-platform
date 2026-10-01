import type { Pool, PoolClient } from 'pg';
import type { Actor } from '../identity-membership/service.js';

/** Platform admins with a verified email. Guild leaders are not included. */
export async function canHideMemberContent(db: Pool | PoolClient, actor: Actor) {
  const row = await db.query(`SELECT 1 FROM users u WHERE u.user_id=$1 AND u.community_id=$2 AND u.active AND u.email_verified_at IS NOT NULL
    AND EXISTS(SELECT 1 FROM platform_admins p WHERE p.community_id=u.community_id AND p.active AND p.email=lower(u.email))`, [actor.user_id, actor.community_id]);
  return row.rowCount === 1;
}
