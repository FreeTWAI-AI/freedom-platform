import {z} from 'zod';
import type {Pool} from 'pg';
import type {Actor} from '../identity-membership/service.js';
import {requireCondition} from '../../packages/shared/problem.js';

export const socialMetadataInput = {
  topic: z.enum(['mood','event','work']).default('mood'),
  location_name: z.string().trim().min(1).max(120).refine(value => !/[\x00-\x1f\x7f]/.test(value)).optional(),
  mention_ids: z.array(z.uuid()).max(10).default([]),
};
export type SocialMention = {user_id:string; display_name:string};
export function socialTags(text:string) {
  return [...new Set([...text.matchAll(/(?<![\p{L}\p{N}_])#([\p{L}\p{N}_]{1,50})(?![\p{L}\p{N}_])/gu)].map(match=>match[1].toLocaleLowerCase()))].slice(0,20);
}
export async function socialMentions(q:Pick<Pool,'query'>,actor:Actor,text:string,ids:string[]):Promise<SocialMention[]> {
  const unique=[...new Set(ids)];
  if(!unique.length)return [];
  const rows=(await q.query(`SELECT user_id,display_name FROM users u WHERE u.user_id=ANY($1::uuid[]) AND u.community_id=$2 AND u.active
    AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL)
    AND (NOT is_verification_test_account(u.user_id) OR u.user_id=$3)
    AND NOT EXISTS(SELECT 1 FROM member_interaction_blocks b WHERE b.community_id=$2 AND b.state='active'
      AND ((b.owner_ref=$3 AND b.target_ref=u.user_id) OR (b.owner_ref=u.user_id AND b.target_ref=$3)))`,[unique,actor.community_id,actor.user_id])).rows as SocialMention[];
  requireCondition(rows.length===unique.length,422,'mention_unavailable','標註的會員目前無法選取，請移除後再試。');
  return rows.filter(row=>text.includes(`@${row.display_name}`));
}
