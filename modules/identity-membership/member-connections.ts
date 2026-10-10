import type {Pool} from 'pg';
import {z} from 'zod';
import type {Actor} from './service.js';
import {memberCards} from './members.js';
import {contactableIds} from './blocks.js';
export const FriendsQuery=z.object({
  scope:z.enum(['accepted','incoming','outgoing']).default('accepted'),
  search:z.string().trim().max(100).default(''),
  limit:z.coerce.number().int().min(1).max(50).default(20),
  offset:z.coerce.number().int().min(0).max(10000).default(0),
}).strict();
export const RecommendationsQuery=z.object({
  limit:z.coerce.number().int().min(1).max(3).default(1),
  offset:z.coerce.number().int().min(0).max(10000).default(0),
}).strict();
async function visibleCards(pool:Pool,actor:Actor,ids:string[]){
  const cards=await memberCards(pool,actor,ids);
  const allowed=await contactableIds(pool,actor,ids);
  return cards.filter(card=>allowed.has(card.user_id));
}
export async function friendDirectory(pool:Pool,actor:Actor,raw:unknown){
  const query=FriendsQuery.parse(raw);
  const page=(await pool.query(`WITH matches AS (
    SELECT u.user_id,u.display_name,f.updated_at FROM member_friendships f
      JOIN users u ON u.user_id=CASE WHEN f.low_ref=$2 THEN f.high_ref ELSE f.low_ref END
    WHERE f.community_id=$1 AND (f.low_ref=$2 OR f.high_ref=$2) AND u.community_id=$1
      AND u.active AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL)
      AND NOT is_verification_test_account(u.user_id)
      AND NOT EXISTS(SELECT 1 FROM member_interaction_blocks b WHERE b.community_id=$1 AND b.state='active'
        AND ((b.owner_ref=$2 AND b.target_ref=u.user_id) OR (b.owner_ref=u.user_id AND b.target_ref=$2)))
      AND (($3='accepted' AND f.state='accepted') OR ($3='incoming' AND f.state='pending' AND f.requester_ref<>$2)
        OR ($3='outgoing' AND f.state='pending' AND f.requester_ref=$2))
      AND ($4='' OR strpos(lower(u.display_name),lower($4))>0)
  ) SELECT (SELECT count(*)::int FROM matches) AS total,
    ARRAY(SELECT user_id FROM matches ORDER BY updated_at DESC,user_id LIMIT $5 OFFSET $6) AS ids`,
    [actor.community_id,actor.user_id,query.scope,query.search,query.limit,query.offset])).rows[0];
  // Recheck current relationship before showing a contact-bearing card.
  const items=(await visibleCards(pool,actor,page.ids)).filter(card=>query.scope==='accepted'?card.friendship.state==='accepted':card.friendship.state==='pending'&&(query.scope==='incoming'?card.friendship.requester_ref!==actor.user_id:card.friendship.requester_ref===actor.user_id));
  return {items,total:page.total,next_offset:query.offset+query.limit<page.total?query.offset+query.limit:null};
}
export async function memberRecommendations(pool:Pool,actor:Actor,raw:unknown){
  const query=RecommendationsQuery.parse(raw);
  const page=(await pool.query(`WITH candidates AS (
    SELECT u.user_id,
      ARRAY(SELECT g.name FROM positioning_profession_memberships a
        JOIN positioning_profession_memberships b USING(community_id,guild_key)
        JOIN positioning_guild_catalog g USING(guild_key)
        WHERE a.community_id=$1 AND a.user_id=$2 AND b.user_id=u.user_id AND a.state='active' AND b.state='active'
        ORDER BY g.name) AS common_guilds,
      ARRAY(SELECT value FROM jsonb_array_elements_text(COALESCE(p.published_profile->'capabilities','[]'::jsonb)) AS c(value)
        WHERE COALESCE(mine.published_profile->'capabilities','[]'::jsonb) ? c.value ORDER BY value) AS common_skills
    FROM users u LEFT JOIN onboarding_assessments p ON p.user_id=u.user_id AND p.community_id=u.community_id
      LEFT JOIN onboarding_assessments mine ON mine.user_id=$2 AND mine.community_id=$1
    WHERE u.community_id=$1 AND u.user_id<>$2 AND u.active
      AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL)
      AND NOT is_verification_test_account(u.user_id)
      AND NOT EXISTS(SELECT 1 FROM member_interaction_blocks b WHERE b.community_id=$1 AND b.state='active'
        AND ((b.owner_ref=$2 AND b.target_ref=u.user_id) OR (b.owner_ref=u.user_id AND b.target_ref=$2)))
      AND NOT EXISTS(SELECT 1 FROM member_friendships f WHERE f.community_id=$1
        AND f.low_ref=least(u.user_id,$2::uuid) AND f.high_ref=greatest(u.user_id,$2::uuid) AND f.state IN ('accepted','pending'))
  ), ranked AS (SELECT *,cardinality(common_guilds)*3+cardinality(common_skills) AS score FROM candidates)
  SELECT (SELECT count(*)::int FROM ranked) AS total,
    COALESCE((SELECT jsonb_agg(row_to_json(pick)) FROM (SELECT * FROM ranked ORDER BY score DESC,
      md5(user_id::text || $2::text || (now() AT TIME ZONE 'Asia/Taipei')::date::text),user_id LIMIT $3 OFFSET $4) pick),'[]'::jsonb) AS picks`,
    [actor.community_id,actor.user_id,query.limit,query.offset])).rows[0];
  const cards=await visibleCards(pool,actor,page.picks.map((pick:any)=>pick.user_id));
  const items=cards.filter(card=>!['accepted','pending'].includes(card.friendship.state)).map(card=>{
    const pick=page.picks.find((item:any)=>item.user_id===card.user_id);
    return {member:card,reason:pick.common_guilds.length?`你們都加入了${pick.common_guilds.slice(0,2).join('、')}`:pick.common_skills.length?'你們公開的專長有共同項目':'認識不同領域的工坊夥伴'};
  });
  return {items,total:page.total,next_offset:query.offset+query.limit<page.total?query.offset+query.limit:0};
}
