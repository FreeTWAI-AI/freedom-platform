import {withBookStarChecks} from '../positioning/onboarding.js';
import type {Pool} from 'pg';
import {z} from 'zod';
import {adminCommand,audit,type AdminCommand} from './service.js';
import {authorizeGuildAppointee,ensureGuildAppointeeMembership} from './guild-appointment-membership.js';
import {commitGuildExpert} from '../positioning/member-tier.js';

const ExpertInput=z.object({user_id:z.uuid(),active:z.boolean(),reason:z.string().trim().min(3).max(1000)}).strict();
export async function setGuildExpert(pool:Pool,input:AdminCommand,key:string){
 z.string().min(1).max(100).regex(/^(guild_[a-z0-9_]+|guild_custom_[0-9A-Fa-f]{32})$/).parse(key);
 const body=ExpertInput.parse(input.body);
 return withBookStarChecks(pool,run=>adminCommand(pool,input,
  q=>authorizeGuildAppointee(q,input.admin,body.user_id,key,body.active),
  run),async q=>{
   // Keep the existing user → member-guild lock order, then serialize all
   // expert appointments within this guild, including different appointees.
   // Membership leave only deactivates a role; it never acquires this lock.
   const {result,prior}=await commitGuildExpert(pool,q,{communityId:input.admin.community_id,guildKey:key,userId:body.user_id,active:body.active,expected:input.expected,appointedBy:input.admin.admin_id,appointedByUserId:null},body.active?()=>ensureGuildAppointeeMembership(pool, q, input.admin,body.user_id,key,body.reason):undefined);
   await audit(q,input.admin,body.active?'appoint_guild_expert':'remove_guild_expert','guild',key,body.reason,prior,result);
   return result;
  });
}
