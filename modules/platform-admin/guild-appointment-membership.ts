import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {requireCondition} from '../../packages/shared/problem.js';
import {grantGuildBooks,lockMemberGuilds} from '../positioning/onboarding.js';
import {audit,type AdminActor} from './service.js';

/** Same user → membership lock order as member join/leave and nominations. */
export async function authorizeGuildAppointee(q:PoolClient,admin:AdminActor,userId:string,guildKey:string,requireActive=true){
  requireCondition((await q.query('SELECT 1 FROM positioning_guild_catalog WHERE guild_key=$1',[guildKey])).rowCount===1,404,'guild_not_found','找不到這個公會。');
  const user=(await q.query('SELECT user_id,active FROM users WHERE community_id=$1 AND user_id=$2 FOR SHARE',[admin.community_id,userId])).rows[0];
  requireCondition(user&&(!requireActive||user.active),422,'active_member_required','請選擇這個社群已啟用的會員。');
  await lockMemberGuilds(q,{community_id:admin.community_id,user_id:userId});
}

/** Called only inside an authorized admin command, after its version check. */
export async function ensureGuildAppointeeMembership(q:PoolClient,admin:AdminActor,userId:string,guildKey:string,reason:string){
  let membership=(await q.query('SELECT * FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=$2 AND guild_key=$3 FOR UPDATE',[admin.community_id,userId,guildKey])).rows[0];
  const joined=membership?.state!=='active';
  if(joined){
    const before=membership?{membership_id:membership.membership_id,user_id:userId,guild_key:guildKey,state:membership.state,aggregate_version:membership.aggregate_version}:null;
    membership=membership
      ?(await q.query("UPDATE positioning_profession_memberships SET state='active',aggregate_version=aggregate_version+1,joined_at=now(),left_at=NULL WHERE membership_id=$1 RETURNING *",[membership.membership_id])).rows[0]
      :(await q.query("INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state) VALUES($1,$2,$3,$4,'active') RETURNING *",[randomUUID(),admin.community_id,userId,guildKey])).rows[0];
    // Attribute the join to the verified administrator, never to the member.
    await audit(q,admin,'admin_join_guild','profession_membership',membership.membership_id,reason,before,{membership_id:membership.membership_id,user_id:userId,guild_key:guildKey,state:'active',aggregate_version:membership.aggregate_version});
  }
  await grantGuildBooks(q,{community_id:admin.community_id,user_id:userId},guildKey);
  // An appointment does not choose a primary guild or complete an assessment.
  return {membership_joined:joined,membership_id:membership.membership_id as string};
}
