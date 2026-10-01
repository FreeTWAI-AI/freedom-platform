import type {Pool} from 'pg';
import {z} from 'zod';
import {journal} from '../../packages/db/index.js';
import {requireCondition} from '../../packages/shared/problem.js';
import type {Actor} from '../identity-membership/service.js';
import {lockMemberGuilds} from '../positioning/onboarding.js';
import {writeFullMembership} from './guild-appointment-membership.js';
import {adminCommand,audit,type AdminActor,type AdminCommand} from './service.js';
import {notifyGuildMasterChange} from '../member-communications/events.js';

export async function nominatedGuildAppointments(pool:Pool,admin:AdminActor){
  return (await pool.query(`SELECT n.guild_key,g.name,n.state,n.bound_user_id FROM guild_leadership_nominations n
    JOIN positioning_guild_catalog g USING(guild_key) WHERE n.community_id=$1 AND n.admin_id=$2 ORDER BY g.name`,[admin.community_id,admin.admin_id])).rows;
}
export async function linkNominatedMember(pool:Pool,input:AdminCommand,member:Actor){
  z.object({}).strict().parse(input.body);
  requireCondition(member.community_id===input.admin.community_id&&member.email.toLowerCase()===input.admin.email,
    403,'member_identity_mismatch','請先登入與管理員驗證信箱相同的會員帳號，再連結任命。');
  return adminCommand(pool,input,async q=>{
    // Same lock order as membership writes, login and account suspension.
    const user=(await q.query('SELECT * FROM users WHERE user_id=$1 AND community_id=$2 FOR UPDATE',[member.user_id,member.community_id])).rows[0];
    requireCondition(user?.active&&user.email.toLowerCase()===input.admin.email,403,'member_identity_mismatch','會員身分已變更，請重新登入。');
    requireCondition((await q.query('SELECT 1 FROM sessions WHERE token_hash=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now() FOR SHARE',[member.session_hash,member.user_id])).rowCount===1,401,'session_expired','會員登入已到期，請先返回平台登入。');
    requireCondition(!user.onboarding_required||user.onboarding_completed_at,409,'onboarding_required','請先完成會員定位，再回到管理介面確認任命。');
  },async q=>{
    await lockMemberGuilds(q,member);
    const nominations=(await q.query("SELECT n.*,g.name FROM guild_leadership_nominations n JOIN positioning_guild_catalog g USING(guild_key) WHERE n.community_id=$1 AND n.admin_id=$2 AND n.state='pending' ORDER BY n.guild_key FOR UPDATE OF n",[input.admin.community_id,input.admin.admin_id])).rows;
    const activated:{guild_key:string;name:string}[]=[];
    for(const nomination of nominations){
      const key=nomination.guild_key;
      await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`guild-officer/${member.community_id}/${key}`]);
      const officer=(await q.query('SELECT user_id FROM positioning_guild_officers WHERE community_id=$1 AND guild_key=$2 FOR UPDATE',[member.community_id,key])).rows[0];
      requireCondition(!officer||officer.user_id===member.user_id,409,'appointment_changed','這個公會已有其他會長，請先在管理介面確認任命。');
      const written=await writeFullMembership(q,member.community_id,member.user_id,key);
      if(written.membership_joined)await journal(q,member,'profession_membership',written.membership_id,written.membership.aggregate_version,'join_guild',{guild_key:key,state:'active',rank:written.membership.rank},'freedom.organization.profession_membership.updated.v1');
      if(!officer){
        const appointed=(await q.query('INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) VALUES($1,$2,$3) RETURNING guild_key,user_id,aggregate_version',[member.community_id,key,member.user_id])).rows[0];
        await notifyGuildMasterChange(q,member.community_id,null,appointed);
      }
      await q.query("UPDATE guild_leadership_nominations SET state='bound',bound_user_id=$3,activated_at=now() WHERE community_id=$1 AND guild_key=$2",[member.community_id,key,member.user_id]);
      await audit(q,input.admin,'accept_nominated_guild_master','guild',key,'本人通過信箱驗證並登入同信箱會員，確認平台負責人的公會長任命。',{state:'pending'},{state:'bound',user_id:member.user_id});
      activated.push({guild_key:key,name:nomination.name});
    }
    await q.query('UPDATE users SET email_verified_at=COALESCE(email_verified_at,now()) WHERE user_id=$1',[member.user_id]);
    await audit(q,input.admin,'link_verified_member','member',member.user_id,'本人以管理員信箱驗證連結已登入的同信箱會員。',null,{user_id:member.user_id});
    return {linked_user_id:member.user_id,activated_guilds:activated};
  });
}
