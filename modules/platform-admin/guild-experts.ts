import type {Pool} from 'pg';
import {z} from 'zod';
import {checkVersion} from '../../packages/db/index.js';
import {requireCondition} from '../../packages/shared/problem.js';
import {adminCommand,audit,type AdminCommand} from './service.js';
import {authorizeGuildAppointee,ensureGuildAppointeeMembership} from './guild-appointment-membership.js';

const ExpertInput=z.object({user_id:z.uuid(),active:z.boolean(),reason:z.string().trim().min(3).max(1000)}).strict();
export async function setGuildExpert(pool:Pool,input:AdminCommand,key:string){
 z.string().min(1).max(100).regex(/^guild_[a-z0-9_]+$/).parse(key);
 const body=ExpertInput.parse(input.body);
 return adminCommand(pool,input,
  q=>authorizeGuildAppointee(q,input.admin,body.user_id,key,body.active),
  async q=>{
   // authorizeGuildAppointee already locks the member's guild changes. Keep the
   // retained row and its version even when the appointment is revoked/left.
   const prior=(await q.query('SELECT * FROM positioning_guild_experts WHERE community_id=$1 AND guild_key=$2 AND user_id=$3 FOR UPDATE',[input.admin.community_id,key,body.user_id])).rows[0];
   if(prior)checkVersion(prior.aggregate_version,input.expected);
   else{
    requireCondition(!input.expected,412,'version_conflict','公會專家任命已變更，請重新整理。');
    requireCondition(body.active,404,'guild_expert_not_found','這位會員尚未被任命為公會專家。');
   }
   const membership=body.active?await ensureGuildAppointeeMembership(q,input.admin,body.user_id,key,body.reason):null;
   const row=(await q.query(`INSERT INTO positioning_guild_experts(community_id,guild_key,user_id,active,appointed_by)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(community_id,guild_key,user_id) DO UPDATE
    SET active=$4,appointed_by=$5,appointed_at=now(),aggregate_version=positioning_guild_experts.aggregate_version+1
    RETURNING guild_key,user_id,active,aggregate_version`,[input.admin.community_id,key,body.user_id,body.active,input.admin.admin_id])).rows[0];
   const result={...row,aggregate_version:Number(row.aggregate_version),membership_joined:membership?.membership_joined??false};
   await audit(q,input.admin,body.active?'appoint_guild_expert':'remove_guild_expert','guild',key,body.reason,
    prior?{user_id:prior.user_id,active:prior.active,aggregate_version:Number(prior.aggregate_version)}:null,result);
   return result;
  });
}
