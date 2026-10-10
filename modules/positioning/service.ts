import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { command, journal, checkVersion, type Command } from '../../packages/db/index.js';
import { requireCondition } from '../../packages/shared/problem.js';
import type { Actor } from '../identity-membership/service.js';
import { lockMemberGuilds,grantGuildBooks,assertCanLeaveGuild,removeSecondaryGuildOnLeave } from './onboarding.js';
import { LeaveV2Input } from '../../contracts/guild-launchpad/v1/guild-preferences.js';
import { categorySlotForGuild, clearCategorySlot, communitySwitched, ensureProjectionSet, getPreferenceView, lockGuildCatalogShared, recomputeLegacyProjection } from './guild-categories.js';

const short=z.string().trim().min(1).max(100);
const uniqueStrings=(max:number)=>z.array(short).max(max).refine(a=>new Set(a).size===a.length,'請移除重複選項。');
const ProfileInput=z.object({
  real_world_occupations:uniqueStrings(8),background:z.string().trim().max(1200),strengths:uniqueStrings(12),
  goals:z.string().trim().min(1).max(1000),weekly_minutes:z.number().int().min(0).max(10080),
  desired_roles:z.array(z.enum(['supplier','seller','creator','promoter','helper'])).max(5).refine(a=>new Set(a).size===a.length),
  selected_tracks:uniqueStrings(3),confirmed:z.literal(true),
}).strict();
export async function listTracks(pool:Pool) {
  return (await pool.query(`SELECT t.*,g.name AS guild_name,g.profession_key,g.module_key FROM positioning_track_catalog t
    JOIN positioning_guild_catalog g USING(guild_key) ORDER BY t.track_key`)).rows;
}
export async function getProfile(pool:Pool,actor:Actor) {
  return (await pool.query('SELECT * FROM positioning_profiles WHERE community_id=$1 AND user_id=$2 ORDER BY aggregate_version DESC LIMIT 1',[actor.community_id,actor.user_id])).rows[0]??null;
}
export async function saveProfile(pool:Pool,input:Command) {
  const body=ProfileInput.parse(input.body);
  return command(pool,input,async()=>{},async q=>{
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`positioning/${input.actor.community_id}/${input.actor.user_id}`]);
    const previous=(await q.query('SELECT * FROM positioning_profiles WHERE community_id=$1 AND user_id=$2 ORDER BY aggregate_version DESC LIMIT 1',[input.actor.community_id,input.actor.user_id])).rows[0];
    if(previous)checkVersion(previous.aggregate_version,input.expected);
    else requireCondition(!input.expected,412,'version_conflict','方向卡已變更，請重新整理。');
    const known=await q.query('SELECT track_key FROM positioning_track_catalog WHERE track_key=ANY($1::text[])',[body.selected_tracks]);
    requireCondition(known.rowCount===body.selected_tracks.length,422,'unknown_track','請從目前的職業方向選單選擇。');
    const id=randomUUID(),version=previous?BigInt(previous.aggregate_version)+1n:1n;
    const result=(await q.query(`INSERT INTO positioning_profiles(profile_id,community_id,user_id,aggregate_version,real_world_occupations,background,strengths,goals,weekly_minutes,desired_roles,selected_tracks,supersedes_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[id,input.actor.community_id,input.actor.user_id,version.toString(),body.real_world_occupations,body.background,body.strengths,body.goals,body.weekly_minutes,body.desired_roles,body.selected_tracks,previous?.profile_id??null])).rows[0];
    await journal(q,input.actor,'career_profile',id,version.toString(),'confirm_self_declared_profile',{source:'self_declared',supersedes_id:previous?.profile_id??null},'freedom.positioning.profile.confirmed.v1');
    return result;
  });
}
export async function positioningView(pool:Pool,actor:Actor) {
  const [profile,tracks]=await Promise.all([getProfile(pool,actor),listTracks(pool)]);
  const ranked=profile?tracks.map(t=>({...t,selected:profile.selected_tracks.includes(t.track_key),role_match:profile.desired_roles.includes(t.role_key)}))
    .filter(t=>t.selected||t.role_match).sort((a,b)=>Number(b.selected)-Number(a.selected)||a.track_key.localeCompare(b.track_key)):[];
  return {profile,tracks,recommendations:ranked.slice(0,3).map(t=>({track_key:t.track_key,name:t.name,guild_key:t.guild_key,guild_name:t.guild_name,module_key:t.module_key,
    reason:t.selected?'你已選擇這個職業方向。':'這個方向符合你自己選擇的參與角色。',first_result:t.first_result,estimated_minutes:t.estimated_minutes,
    time_note:profile.weekly_minutes<t.estimated_minutes?'可先收藏，依自己的時間拆小步。':null,policy_version:'self-declared-v1'}))};
}
export async function listGuilds(pool:Pool,actor:Actor) {
  return (await pool.query(`SELECT g.*,COALESCE(t.track_count,0)::int AS track_count,
    CASE WHEN m.membership_id IS NULL THEN NULL ELSE jsonb_build_object('membership_id',m.membership_id,'state',m.state,'rank',m.rank,'member_tier',m.member_tier,'aggregate_version',m.aggregate_version) END AS membership
    FROM positioning_guild_catalog g LEFT JOIN (SELECT guild_key,count(*) AS track_count FROM positioning_track_catalog GROUP BY guild_key)t USING(guild_key)
    LEFT JOIN positioning_profession_memberships m ON m.guild_key=g.guild_key AND m.community_id=$1 AND m.user_id=$2 ORDER BY g.guild_key`,[actor.community_id,actor.user_id])).rows;
}
export async function changeGuildMembership(pool:Pool,input:Command,guildKey:string,action:'join'|'leave') {
  z.object({}).strict().parse(input.body);
  return command(pool,input,async q=>{
    requireCondition((await q.query('SELECT 1 FROM positioning_guild_catalog WHERE guild_key=$1',[guildKey])).rowCount===1,404,'guild_not_found','找不到這個公會。');
  },async q=>{
    await lockGuildCatalogShared(q);
    await lockMemberGuilds(q,input.actor);
    const switched=await communitySwitched(q,input.actor.community_id);
    if(action==='leave'){
      if(switched)requireCondition(!(await categorySlotForGuild(q,input.actor,guildKey)),409,'primary_clear_required','請先取消本類主力，再離開這個公會。');
      else await assertCanLeaveGuild(q,input.actor,guildKey);
    }
    let membership=(await q.query('SELECT * FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=$2 AND guild_key=$3 FOR UPDATE',[input.actor.community_id,input.actor.user_id,guildKey])).rows[0];
    if(action==='join'&&membership?.state==='active'){await grantGuildBooks(pool, q, input.actor,guildKey);if(!switched)await recomputeLegacyProjection(q,input.actor);return membership;}
    if(membership)checkVersion(membership.aggregate_version,input.expected);
    else { requireCondition(action==='join',404,'membership_not_found','你尚未加入這個公會。');requireCondition(!input.expected,412,'version_conflict','公會狀態已變更，請重新整理。'); }
    const state=action==='join'?'active':'left';
    if(membership?.state===state)return membership;
    if(action==='leave'&&!switched)await removeSecondaryGuildOnLeave(q,input.actor,guildKey);
    if(membership)membership=(await q.query(`UPDATE positioning_profession_memberships SET state=$1,member_tier=CASE WHEN $1='active' THEN 'intern' ELSE member_tier END,aggregate_version=aggregate_version+1,left_at=CASE WHEN $1='left' THEN now() ELSE NULL END,
      joined_at=CASE WHEN $1='active' THEN now() ELSE joined_at END WHERE membership_id=$2 RETURNING *`,[state,membership.membership_id])).rows[0];
    else membership=(await q.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier) VALUES($1,$2,$3,$4,'active','intern') RETURNING *`,[randomUUID(),input.actor.community_id,input.actor.user_id,guildKey])).rows[0];
    if(action==='join')await grantGuildBooks(pool, q, input.actor,guildKey);
    await journal(q,input.actor,'profession_membership',membership.membership_id,membership.aggregate_version,`${action}_guild`,{guild_key:guildKey,state,rank:'runner'},'freedom.organization.profession_membership.updated.v1');
    if(!switched)await recomputeLegacyProjection(q,input.actor);
    return membership;
  });
}
export async function leaveGuildV2(pool:Pool,input:Command,guildKey:string,preferenceVersion?:string){
  const body=LeaveV2Input.parse(input.body);
  z.string().min(1).max(100).parse(guildKey);
  if(preferenceVersion!==undefined)requireCondition(/^[1-9][0-9]{0,18}$/.test(preferenceVersion),400,'invalid_version','請提供有效的偏好版本。');
  return command(pool,input,async q=>{
    requireCondition((await q.query('SELECT 1 FROM positioning_guild_catalog WHERE guild_key=$1',[guildKey])).rowCount===1,404,'guild_not_found','找不到這個公會。');
  },async q=>{
    await lockGuildCatalogShared(q);
    await lockMemberGuilds(q,input.actor);
    const switched=await communitySwitched(q,input.actor.community_id);
    let membership=(await q.query('SELECT * FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=$2 AND guild_key=$3 FOR UPDATE',[input.actor.community_id,input.actor.user_id,guildKey])).rows[0];
    requireCondition(membership,404,'membership_not_found','你尚未加入這個公會。');
    checkVersion(membership.aggregate_version,input.expected);
    const slot=await categorySlotForGuild(q,input.actor,guildKey);
    if(slot){
      requireCondition(preferenceVersion,428,'version_required','請提供偏好版本。');
      const set=(await q.query('SELECT aggregate_version::text AS aggregate_version FROM guild_preference_sets WHERE community_id=$1 AND user_id=$2 FOR UPDATE',[input.actor.community_id,input.actor.user_id])).rows[0];
      requireCondition(set,503,'preference_mapping_unavailable','偏好對照尚未建立。');
      checkVersion(String(set.aggregate_version),preferenceVersion);
      requireCondition(body.clear_primary,409,'primary_clear_required','請先取消本類主力，或在離開時一併清除。');
      if(switched)await clearCategorySlot(q,input.actor,slot.category,guildKey,'membership_left');
    }
    if(!switched){
      await assertCanLeaveGuild(q,input.actor,guildKey);
      if(membership.state!=='left')await removeSecondaryGuildOnLeave(q,input.actor,guildKey);
    }
    if(membership.state!=='left'){
      membership=(await q.query(`UPDATE positioning_profession_memberships SET state='left',member_tier=member_tier,aggregate_version=aggregate_version+1,left_at=now() WHERE membership_id=$1 RETURNING *`,[membership.membership_id])).rows[0];
      await journal(q,input.actor,'profession_membership',membership.membership_id,membership.aggregate_version,'leave_guild',{guild_key:guildKey,state:'left',rank:'runner'},'freedom.organization.profession_membership.updated.v1');
    }
    if(!switched)await recomputeLegacyProjection(q,input.actor);
    await ensureProjectionSet(q,input.actor);
    return {membership,preferences:await getPreferenceView(q,input.actor)};
  });
}
