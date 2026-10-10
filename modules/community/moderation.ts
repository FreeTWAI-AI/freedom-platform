import type { Pool, PoolClient } from 'pg';
import type { Actor } from '../identity-membership/service.js';
import { requireCondition } from '../../packages/shared/problem.js';

/** Platform admins with a verified email. Guild leaders are not included. */
export async function canHideMemberContent(db: Pool | PoolClient, actor: Actor) {
  const row = await db.query(`SELECT 1 FROM users u WHERE u.user_id=$1 AND u.community_id=$2 AND u.active AND u.email_verified_at IS NOT NULL
    AND EXISTS(SELECT 1 FROM platform_admins p WHERE p.community_id=u.community_id AND p.active AND p.email=lower(u.email))`, [actor.user_id, actor.community_id]);
  return row.rowCount === 1;
}

/** Call inside the member transaction, after its user/session locks. */
export async function requireMemberContentAdmin(q: PoolClient, actor: Actor, code: 'member_content_admin_required'|'social_post_admin_required' = 'member_content_admin_required') {
  const rows = await q.query(`SELECT p.admin_id FROM users u JOIN platform_admins p
    ON p.community_id=u.community_id AND p.email=lower(u.email)
    WHERE u.user_id=$1 AND u.community_id=$2 AND u.active AND u.email_verified_at IS NOT NULL AND p.active
    ORDER BY p.admin_id FOR SHARE OF u,p`, [actor.user_id,actor.community_id]);
  requireCondition(rows.rowCount,403,code,code==='social_post_admin_required'?'只有平台管理員能隱藏貼文。':'只有已驗證的平台管理員能處理檢舉。');
}

/** Shared real moderation effect; never opens a nested transaction or receipt. */
export async function moderateSocialContent(q: PoolClient, actor: Actor, kind: 'post'|'comment', id: string, action: 'hide'|'restore', now = new Date()) {
  await requireMemberContentAdmin(q,actor);
  const table=kind==='post'?'community_social_posts':'community_social_comments';
  const column=kind==='post'?'post_id':'comment_id';
  const row=(await q.query(`SELECT state FROM ${table} WHERE ${column}=$1 AND community_id=$2 FOR UPDATE`,[id,actor.community_id])).rows[0];
  requireCondition(row && row.state!=='deleted',404,'not_found','找不到這則內容。');
  const state=action==='hide'?'hidden':'active';
  const changed=row.state!==state;
  if(changed && kind==='post' && action==='restore'){
    // Hiding retires asset thumbnails and clears their current pointer. Never
    // revive retired assets, discard retained evidence, or defer this to COMMIT.
    const unavailable=await q.query(`SELECT 1 FROM community_social_post_thumbnails b
      JOIN community_social_posts p USING(post_id)
      WHERE b.post_id=$1 AND b.storage_source='asset' AND NOT EXISTS(
        SELECT 1 FROM community_social_thumbnail_asset_targets t WHERE t.post_id=b.post_id
          AND t.asset_id IS NOT NULL AND t.linked_at_version<=p.media_version+1)`,[id]);
    requireCondition(!unavailable.rowCount,409,'report_restore_media_unavailable','這則貼文的圖片已退役，目前無法完整恢復。內容與案件未變更；請選擇不變更內容，或等待圖片還原支援。');
  }
  if(changed)await q.query(`UPDATE ${table} SET state=$2${kind==='post'?',updated_at=$3':''} WHERE ${column}=$1`,kind==='post'?[id,state,now]:[id,state]);
  return {target_kind:kind,target_id:id,action,previous_state:row.state as string,state,changed};
}
