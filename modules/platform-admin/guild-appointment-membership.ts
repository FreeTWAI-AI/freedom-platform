import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {requireCondition} from '../../packages/shared/problem.js';
import {grantGuildBooks,lockMemberGuilds} from '../positioning/onboarding.js';
import {audit,type AdminActor} from './service.js';

/** Same user → membership lock order as member join/leave and nominations. */
export async function authorizeGuildAppointee(q:PoolClient,scope:{community_id:string},userId:string,guildKey:string,requireActive=true){
  requireCondition((await q.query('SELECT 1 FROM positioning_guild_catalog WHERE guild_key=$1',[guildKey])).rowCount===1,404,'guild_not_found','找不到這個公會。');
  const user=(await q.query('SELECT user_id,active FROM users WHERE community_id=$1 AND user_id=$2 FOR SHARE',[scope.community_id,userId])).rows[0];
  requireCondition(user&&(!requireActive||user.active),422,'active_member_required','請選擇這個社群已啟用的會員。');
  await lockMemberGuilds(q,{community_id:scope.community_id,user_id:userId});
}

/**
 * Appointment membership: new and reactivated rows become full in one version bump.
 * An already-active intern is promoted in a second bump. membership_joined stays
 * false when the person was already active. Callers hold the member-guild lock.
 */
export async function writeFullMembership(q:PoolClient,communityId:string,userId:string,guildKey:string){
  let membership=(await q.query('SELECT * FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=$2 AND guild_key=$3 FOR UPDATE',[communityId,userId,guildKey])).rows[0];
  const joined=membership?.state!=='active';
  if(joined){
    membership=membership
      ?(await q.query("UPDATE positioning_profession_memberships SET state='active',member_tier='full',aggregate_version=aggregate_version+1,joined_at=now(),left_at=NULL WHERE membership_id=$1 RETURNING *",[membership.membership_id])).rows[0]
      :(await q.query("INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier) VALUES($1,$2,$3,$4,'active','full') RETURNING *",[randomUUID(),communityId,userId,guildKey])).rows[0];
  }else if(membership.member_tier!=='full'){
    membership=(await q.query("UPDATE positioning_profession_memberships SET member_tier='full',aggregate_version=aggregate_version+1 WHERE membership_id=$1 RETURNING *",[membership.membership_id])).rows[0];
  }
  await grantGuildBooks(q,{community_id:communityId,user_id:userId},guildKey);
  return {membership_joined:joined,membership_id:membership.membership_id as string,membership};
}

/** Called only inside an authorized admin command, after its version check. */
export async function ensureGuildAppointeeMembership(q:PoolClient,admin:AdminActor,userId:string,guildKey:string,reason:string){
  const beforeRow=(await q.query('SELECT * FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=$2 AND guild_key=$3',[admin.community_id,userId,guildKey])).rows[0];
  const written=await writeFullMembership(q,admin.community_id,userId,guildKey);
  if(written.membership_joined){
    const before=beforeRow?{membership_id:beforeRow.membership_id,user_id:userId,guild_key:guildKey,state:beforeRow.state,aggregate_version:beforeRow.aggregate_version}:null;
    // Attribute the join to the verified administrator, never to the member.
    await audit(q,admin,'admin_join_guild','profession_membership',written.membership_id,reason,before,{membership_id:written.membership_id,user_id:userId,guild_key:guildKey,state:'active',aggregate_version:written.membership.aggregate_version});
  }
  // An appointment does not choose a primary guild or complete an assessment.
  return {membership_joined:written.membership_joined,membership_id:written.membership_id};
}
