import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { command, journal, checkVersion, type Command } from '../../packages/db/index.js';
import { requireCondition } from '../../packages/shared/problem.js';
import type { Actor } from '../identity-membership/service.js';

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
    CASE WHEN m.membership_id IS NULL THEN NULL ELSE jsonb_build_object('membership_id',m.membership_id,'state',m.state,'rank',m.rank,'aggregate_version',m.aggregate_version) END AS membership
    FROM positioning_guild_catalog g LEFT JOIN (SELECT guild_key,count(*) AS track_count FROM positioning_track_catalog GROUP BY guild_key)t USING(guild_key)
    LEFT JOIN positioning_profession_memberships m ON m.guild_key=g.guild_key AND m.community_id=$1 AND m.user_id=$2 ORDER BY g.guild_key`,[actor.community_id,actor.user_id])).rows;
}
export async function changeGuildMembership(pool:Pool,input:Command,guildKey:string,action:'join'|'leave') {
  z.object({}).strict().parse(input.body);
  return command(pool,input,async q=>{
    requireCondition((await q.query('SELECT 1 FROM positioning_guild_catalog WHERE guild_key=$1',[guildKey])).rowCount===1,404,'guild_not_found','找不到這個公會。');
  },async q=>{
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`guild/${input.actor.community_id}/${input.actor.user_id}/${guildKey}`]);
    let membership=(await q.query('SELECT * FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=$2 AND guild_key=$3 FOR UPDATE',[input.actor.community_id,input.actor.user_id,guildKey])).rows[0];
    if(action==='join'&&membership?.state==='active')return membership;
    if(membership)checkVersion(membership.aggregate_version,input.expected);
    else { requireCondition(action==='join',404,'membership_not_found','你尚未加入這個公會。');requireCondition(!input.expected,412,'version_conflict','公會狀態已變更，請重新整理。'); }
    const state=action==='join'?'active':'left';
    if(membership?.state===state)return membership;
    if(membership)membership=(await q.query(`UPDATE positioning_profession_memberships SET state=$1,aggregate_version=aggregate_version+1,left_at=CASE WHEN $1='left' THEN now() ELSE NULL END,
      joined_at=CASE WHEN $1='active' THEN now() ELSE joined_at END WHERE membership_id=$2 RETURNING *`,[state,membership.membership_id])).rows[0];
    else membership=(await q.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state) VALUES($1,$2,$3,$4,'active') RETURNING *`,[randomUUID(),input.actor.community_id,input.actor.user_id,guildKey])).rows[0];
    await journal(q,input.actor,'profession_membership',membership.membership_id,membership.aggregate_version,`${action}_guild`,{guild_key:guildKey,state,rank:'runner'},'freedom.organization.profession_membership.updated.v1');
    return membership;
  });
}
