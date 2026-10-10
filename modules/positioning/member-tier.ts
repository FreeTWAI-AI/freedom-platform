import {withBookStarChecks} from './onboarding.js';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {checkVersion,command,journal,type Command} from '../../packages/db/index.js';
import {requireCondition} from '../../packages/shared/problem.js';
import {notifyGuildExpertChange,notifyGuildMemberTierChange} from '../member-communications/events.js';
import {authorizeGuildAppointee,writeFullMembership} from '../platform-admin/guild-appointment-membership.js';
import {lockMemberGuilds,assertGuildBookStars} from './onboarding.js';

export const GUILD_FULL_MEMBER_REQUIRED='實習成員可以閱讀公會內容、在公會聊天室聊天；請會長把你設為正式成員後再發布或編輯。';
export const GUILD_MEMBER_TIER_LOCKED='會長與公會專家必須是正式成員；請先解除專家任命。';
const GUILD_MEMBER_TIER_SELF='會長不能變更自己的成員等級。';
const GUILD_EXPERT_SELF='會長不能任命自己為公會專家。';
const GUILD_MEMBER_NOT_FOUND='這位會員不是這個公會的現任成員。';
const GUILD_LEADER_REQUIRED='此操作限目前在任的公會長。';
const guildKey=z.string().min(1).max(100).regex(/^(guild_[a-z0-9_]+|guild_custom_[0-9A-Fa-f]{32})$/);

export function requireFullGuildMember(memberTier:string|null|undefined){
  requireCondition(memberTier==='full',403,'guild_full_member_required',GUILD_FULL_MEMBER_REQUIRED);
}

type ExpertCommit={
  communityId:string;guildKey:string;userId:string;active:boolean;expected?:string;
  appointedBy:string|null;appointedByUserId:string|null;
};
/** Shared appointment: lock, cap of 3, version, full membership, and notification. */
export async function commitGuildExpert(pool:Pool,q:PoolClient,input:ExpertCommit,join?:()=>Promise<{membership_joined:boolean}>){
  // Caller already holds the appointee's user → member-guild locks.
  await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`guild-experts/${input.communityId}/${input.guildKey}`]);
  const prior=(await q.query('SELECT * FROM positioning_guild_experts WHERE community_id=$1 AND guild_key=$2 AND user_id=$3 FOR UPDATE',[input.communityId,input.guildKey,input.userId])).rows[0];
  if(prior)checkVersion(prior.aggregate_version,input.expected);
  else{
    requireCondition(!input.expected,412,'version_conflict','公會專家任命已變更，請重新整理。');
    requireCondition(input.active,404,'guild_expert_not_found','這位會員尚未被任命為公會專家。');
  }
  if(input.active&&!prior?.active){
    const occupied=(await q.query('SELECT count(*)::int AS n FROM positioning_guild_experts WHERE community_id=$1 AND guild_key=$2 AND active',[input.communityId,input.guildKey])).rows[0].n;
    requireCondition(occupied<3,409,'guild_expert_limit_reached','每個公會最多 3 位公會專家，請先移除一位再任命。');
  }
  const membership=input.active?join?await join():await writeFullMembership(pool, q, input.communityId,input.userId,input.guildKey):null;
  const row=(await q.query(`INSERT INTO positioning_guild_experts(community_id,guild_key,user_id,active,appointed_by,appointed_by_user_id)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(community_id,guild_key,user_id) DO UPDATE
    SET active=$4,appointed_by=$5,appointed_by_user_id=$6,appointed_at=now(),aggregate_version=positioning_guild_experts.aggregate_version+1
    RETURNING guild_key,user_id,active,aggregate_version`,[input.communityId,input.guildKey,input.userId,input.active,input.appointedBy,input.appointedByUserId])).rows[0];
  const result={...row,aggregate_version:Number(row.aggregate_version),membership_joined:membership?.membership_joined??false};
  if(Boolean(prior?.active)!==row.active)await notifyGuildExpertChange(q,input.communityId,row);
  return {result,prior:prior?{user_id:prior.user_id,active:prior.active,aggregate_version:Number(prior.aggregate_version)}:null};
}

async function requireCurrentMaster(q:PoolClient,communityId:string,userId:string,key:string){
  requireCondition((await q.query('SELECT 1 FROM positioning_guild_catalog WHERE guild_key=$1',[key])).rowCount===1,404,'guild_not_found','找不到這個公會。');
  requireCondition((await q.query('SELECT 1 FROM positioning_guild_officers WHERE community_id=$1 AND guild_key=$2 AND user_id=$3',[communityId,key,userId])).rowCount===1,403,'guild_leader_required',GUILD_LEADER_REQUIRED);
}

const TierInput=z.object({member_tier:z.enum(['intern','full'])}).strict();
export async function setMemberTier(pool:Pool,input:Command,key:string,userId:string){
  guildKey.parse(key);z.uuid().parse(userId);
  const body=TierInput.parse(input.body);
  return withBookStarChecks(pool,run=>command(pool,input,async q=>{
    await requireCurrentMaster(q,input.actor.community_id,input.actor.user_id,key);
    requireCondition(userId!==input.actor.user_id,409,'guild_member_tier_self',GUILD_MEMBER_TIER_SELF);
  },run),async q=>{
    await lockMemberGuilds(q,input.actor);
    const master=(await q.query("SELECT state FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=$2 AND guild_key=$3 FOR UPDATE",[input.actor.community_id,input.actor.user_id,key])).rows[0];
    requireCondition(master?.state==='active',403,'guild_leader_required',GUILD_LEADER_REQUIRED);
    await lockMemberGuilds(q,{community_id:input.actor.community_id,user_id:userId});
    const membership=(await q.query('SELECT * FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=$2 AND guild_key=$3 FOR UPDATE',[input.actor.community_id,userId,key])).rows[0];
    requireCondition(membership?.state==='active',404,'guild_member_not_found',GUILD_MEMBER_NOT_FOUND);
    checkVersion(membership.aggregate_version,input.expected);
    if(membership.member_tier===body.member_tier)return {user_id:userId,guild_key:key,member_tier:body.member_tier,aggregate_version:Number(membership.aggregate_version),changed:false};
    if(body.member_tier==='intern'){
      const locked=(await q.query('SELECT 1 FROM positioning_guild_experts WHERE community_id=$1 AND guild_key=$2 AND user_id=$3 AND active',[input.actor.community_id,key,userId])).rowCount===1
        ||(await q.query('SELECT 1 FROM positioning_guild_officers WHERE community_id=$1 AND guild_key=$2 AND user_id=$3',[input.actor.community_id,key,userId])).rowCount===1;
      requireCondition(!locked,409,'guild_member_tier_locked',GUILD_MEMBER_TIER_LOCKED);
    }
    if(body.member_tier==='full')await assertGuildBookStars(pool,q,{community_id:input.actor.community_id,user_id:userId},key);
    const updated=(await q.query('UPDATE positioning_profession_memberships SET member_tier=$2,aggregate_version=aggregate_version+1 WHERE membership_id=$1 RETURNING member_tier,aggregate_version',[membership.membership_id,body.member_tier])).rows[0];
    await journal(q,input.actor,'profession_membership',membership.membership_id,updated.aggregate_version,'set_member_tier',{member_tier:body.member_tier,guild_key:key});
    await notifyGuildMemberTierChange(q,input.actor.community_id,{guild_key:key,user_id:userId,member_tier:body.member_tier,aggregate_version:updated.aggregate_version});
    return {user_id:userId,guild_key:key,member_tier:updated.member_tier,aggregate_version:Number(updated.aggregate_version),changed:true};
  });
}

const MasterExpertInput=z.object({user_id:z.uuid(),active:z.boolean(),reason:z.string().trim().max(1000).optional()}).strict();
export async function setGuildExpertByMaster(pool:Pool,input:Command,key:string){
  guildKey.parse(key);
  const body=MasterExpertInput.parse(input.body);
  return withBookStarChecks(pool,run=>command(pool,input,async q=>{
    await requireCurrentMaster(q,input.actor.community_id,input.actor.user_id,key);
    requireCondition(body.user_id!==input.actor.user_id,409,'guild_expert_self',GUILD_EXPERT_SELF);
    await authorizeGuildAppointee(q,input.actor,body.user_id,key,body.active);
  },run),async q=>{
    await lockMemberGuilds(q,input.actor);
    const master=(await q.query("SELECT state FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=$2 AND guild_key=$3 FOR UPDATE",[input.actor.community_id,input.actor.user_id,key])).rows[0];
    requireCondition(master?.state==='active',403,'guild_leader_required',GUILD_LEADER_REQUIRED);
    const {result}=await commitGuildExpert(pool, q, {communityId:input.actor.community_id,guildKey:key,userId:body.user_id,active:body.active,expected:input.expected,appointedBy:null,appointedByUserId:input.actor.user_id});
    // The expert key is (community, guild, user). The journal's aggregate id is a uuid, so record the membership row.
    const membership=(await q.query('SELECT membership_id FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=$2 AND guild_key=$3',[input.actor.community_id,body.user_id,key])).rows[0];
    requireCondition(membership,404,'guild_member_not_found',GUILD_MEMBER_NOT_FOUND);
    await journal(q,input.actor,'guild_expert',membership.membership_id,result.aggregate_version,body.active?'appoint_guild_expert':'remove_guild_expert',{user_id:body.user_id,active:body.active,guild_key:key,reason:body.reason??null});
    return result;
  });
}
