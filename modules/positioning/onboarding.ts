import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { command, journal, checkVersion, type Command } from '../../packages/db/index.js';
import { requireCondition } from '../../packages/shared/problem.js';
import type { Actor } from '../identity-membership/service.js';
import { skillBooksForGuild, capabilityCategories, equipmentCategories } from '../community/catalog.js';
import { ASSESSMENT_VERSION, ASSESSMENT_SHA256, assessmentQuestions, publicAssessmentDefinition, evaluateAssessment, guildTitles } from './assessment.js';

type Queryable=Pick<Pool,'query'>;
const Empty=z.object({}).strict();
const distinct=(max:number)=>z.array(z.string().min(1).max(100)).max(max).refine(values=>new Set(values).size===values.length,'請移除重複選項。');
const AnswerInput=z.object({assessment_version:z.literal(ASSESSMENT_VERSION),assessment_sha256:z.literal(ASSESSMENT_SHA256),
 answers:z.record(z.string().max(100),z.string().max(100)),occupation:z.string().trim().max(160),founding_interest:z.boolean(),
 capabilities:distinct(150),equipment:distinct(150),}).strict();
export function assessmentDefinition(){return {...publicAssessmentDefinition(),
 capability_categories:capabilityCategories.map(({id,label,items})=>({id,label,options:items})),
 equipment_categories:equipmentCategories.map(({id,label,items})=>({id,label,options:items})),
 disclaimer:'這是方向與興趣探索；能力題提供入門情境回饋，不代表證照、職業資格或心理診斷。'};}
export async function lockMemberGuilds(q:PoolClient,actor:Actor){
 await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`guild-member/${actor.community_id}/${actor.user_id}`]);
}
export async function grantGuildBooks(q:PoolClient,actor:Actor,guildKey:string){
 for(const book of skillBooksForGuild(guildKey))await q.query(`INSERT INTO member_skill_book_grants(grant_id,community_id,user_id,guild_key,book_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[randomUUID(),actor.community_id,actor.user_id,guildKey,book.id]);
}
export async function assertCanLeaveGuild(q:PoolClient,actor:Actor,guildKey:string){
 const pref=(await q.query('SELECT primary_guild_key FROM guild_member_preferences WHERE community_id=$1 AND user_id=$2',[actor.community_id,actor.user_id])).rows[0];
 requireCondition(pref?.primary_guild_key!==guildKey,409,'primary_guild_required','請先把另一個已加入的公會設為主力，再離開這個公會。');
}
export async function listSkillBooks(q:Queryable,actor:Pick<Actor,'community_id'|'user_id'>){
 const grants=(await q.query('SELECT book_id,guild_key,granted_at FROM member_skill_book_grants WHERE community_id=$1 AND user_id=$2 ORDER BY granted_at,book_id',[actor.community_id,actor.user_id])).rows;
 const books=new Map<string,any>();
 for(const grant of grants){const definition=skillBooksForGuild(grant.guild_key).find(book=>book.id===grant.book_id);if(!definition)continue;
   if(books.has(grant.book_id))books.get(grant.book_id).guild_keys.push(grant.guild_key);
   else books.set(grant.book_id,{...definition,book_id:grant.book_id,guild_keys:[grant.guild_key],granted_at:grant.granted_at});
 }
 return [...books.values()];
}
export async function guildPreferences(q:Queryable,actor:Pick<Actor,'community_id'|'user_id'>){
 return (await q.query('SELECT primary_guild_key,aggregate_version FROM guild_member_preferences WHERE community_id=$1 AND user_id=$2',[actor.community_id,actor.user_id])).rows[0]??{primary_guild_key:null,aggregate_version:null};
}
export async function onboardingView(q:Queryable,actor:Actor){
 const user=(await q.query('SELECT onboarding_required,onboarding_completed_at FROM users WHERE user_id=$1 AND community_id=$2',[actor.user_id,actor.community_id])).rows[0];
 const row=(await q.query('SELECT * FROM onboarding_assessments WHERE community_id=$1 AND user_id=$2',[actor.community_id,actor.user_id])).rows[0];
 const prefs=await guildPreferences(q,actor);
 return {required:!!user?.onboarding_required&&!user?.onboarding_completed_at,completed:!!user?.onboarding_completed_at,
   state:row?.state??'new',draft:row?{aggregate_version:row.aggregate_version,assessment_version:row.assessment_version,assessment_sha256:row.assessment_sha256,
     answers:row.answers,occupation:row.occupation,founding_interest:row.founding_interest,capabilities:row.capabilities,equipment:row.equipment}:null,
   result:row?.result??null,primary_guild_key:prefs.primary_guild_key,skill_books:await listSkillBooks(q,actor)};
}
export async function saveAssessmentAnswers(pool:Pool,input:Command){
 const body=AnswerInput.parse(input.body);
 for(const [key,value] of Object.entries(body.answers)){
   const question=assessmentQuestions.find(q=>q.id===key);requireCondition(question&&question.options.some(option=>option.id===value),422,'invalid_assessment_answer','請使用目前定位題目提供的選項。');
 }
 const capabilityIds=new Set(capabilityCategories.flatMap(c=>c.items.map(i=>i.id))),equipmentIds=new Set(equipmentCategories.flatMap(c=>c.items.map(i=>i.id)));
 requireCondition(body.capabilities.every(id=>capabilityIds.has(id))&&body.equipment.every(id=>equipmentIds.has(id)),422,'unknown_capability_or_equipment','請從目前分類選單選擇能力與裝備。');
 return command(pool,input,async()=>{},async q=>{
   await lockMemberGuilds(q,input.actor);
   const current=(await q.query('SELECT aggregate_version FROM onboarding_assessments WHERE community_id=$1 AND user_id=$2',[input.actor.community_id,input.actor.user_id])).rows[0];
   if(current)checkVersion(current.aggregate_version,input.expected);else requireCondition(!input.expected,412,'version_conflict','定位進度已變更，請重新整理。');
   await q.query(`INSERT INTO onboarding_assessments(assessment_id,community_id,user_id,assessment_version,assessment_sha256,state,answers,occupation,founding_interest,capabilities,equipment)
      VALUES($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10)
      ON CONFLICT(community_id,user_id) DO UPDATE SET aggregate_version=onboarding_assessments.aggregate_version+1,
        assessment_version=excluded.assessment_version,assessment_sha256=excluded.assessment_sha256,state='draft',answers=excluded.answers,
        occupation=excluded.occupation,founding_interest=excluded.founding_interest,capabilities=excluded.capabilities,equipment=excluded.equipment,result=NULL,updated_at=now()`,
     [randomUUID(),input.actor.community_id,input.actor.user_id,body.assessment_version,body.assessment_sha256,JSON.stringify(body.answers),body.occupation,body.founding_interest,body.capabilities,body.equipment]);
   return onboardingView(q,input.actor);
 });
}
async function currentAssessment(q:PoolClient,input:Command){
 await lockMemberGuilds(q,input.actor);
 const current=(await q.query('SELECT * FROM onboarding_assessments WHERE community_id=$1 AND user_id=$2 FOR UPDATE',[input.actor.community_id,input.actor.user_id])).rows[0];
 requireCondition(current,409,'assessment_required','請先填寫定位題目。');checkVersion(current.aggregate_version,input.expected);
 requireCondition(current.assessment_version===ASSESSMENT_VERSION&&current.assessment_sha256===ASSESSMENT_SHA256,409,'assessment_revision_changed','定位題目版本已更新，請重新填寫。');
 return current;
}
export async function evaluateSavedAssessment(pool:Pool,input:Command){
 Empty.parse(input.body);
 return command(pool,input,async()=>{},async q=>{
   const current=await currentAssessment(q,input);
   requireCondition(assessmentQuestions.every(question=>question.options.some(option=>option.id===current.answers[question.id])),422,'assessment_incomplete','請先完成每一題偏好與能力情境題。');
   requireCondition(current.capabilities.length>0,422,'capabilities_required','請選擇自己的基本能力；剛開始學習也可以選入門選項。');
   const result=evaluateAssessment(current.answers);
   const guilds=(await q.query('SELECT guild_key,name FROM positioning_guild_catalog WHERE guild_key=ANY($1::text[])',[result.recommendations.map(r=>r.guild_key)])).rows;
   const enriched={...result,recommendations:result.recommendations.map(r=>({...r,name:guilds.find(g=>g.guild_key===r.guild_key)!.name}))};
   await q.query(`UPDATE onboarding_assessments SET state='evaluated',result=$1,aggregate_version=aggregate_version+1,updated_at=now() WHERE assessment_id=$2`,[JSON.stringify(enriched),current.assessment_id]);
   return onboardingView(q,input.actor);
 });
}
const CompleteInput=z.object({guild_keys:distinct(12).refine(keys=>keys.length>0,'請至少加入一個公會。'),primary_guild_key:z.string().min(1).max(100),confirmed:z.literal(true)}).strict();
async function joinInTransaction(q:PoolClient,actor:Actor,guildKey:string){
 let member=(await q.query('SELECT * FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=$2 AND guild_key=$3 FOR UPDATE',[actor.community_id,actor.user_id,guildKey])).rows[0];
 if(!member||member.state!=='active'){
   if(member)member=(await q.query("UPDATE positioning_profession_memberships SET state='active',aggregate_version=aggregate_version+1,joined_at=now(),left_at=NULL WHERE membership_id=$1 RETURNING *",[member.membership_id])).rows[0];
   else member=(await q.query("INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state) VALUES($1,$2,$3,$4,'active') RETURNING *",[randomUUID(),actor.community_id,actor.user_id,guildKey])).rows[0];
   await journal(q,actor,'profession_membership',member.membership_id,member.aggregate_version,'join_guild',{guild_key:guildKey,state:'active',rank:'runner'},'freedom.organization.profession_membership.updated.v1');
 }
 await grantGuildBooks(q,actor,guildKey);
}
export async function completeOnboarding(pool:Pool,input:Command){
 const body=CompleteInput.parse(input.body);
 requireCondition(body.guild_keys.includes(body.primary_guild_key),422,'primary_guild_not_selected','主力公會必須是你這次選擇加入的公會。');
 return command(pool,{...input,lockUser:true},async()=>{},async q=>{
   const current=await currentAssessment(q,input);
   requireCondition(current.state==='evaluated'&&current.result,409,'assessment_not_evaluated','請先完成定位並查看公會建議。');
   requireCondition((await q.query('SELECT guild_key FROM positioning_guild_catalog WHERE guild_key=ANY($1::text[])',[body.guild_keys])).rowCount===body.guild_keys.length,422,'unknown_guild','請選擇目前已建立的公會。');
   for(const key of body.guild_keys)await joinInTransaction(q,input.actor,key);
   await q.query(`INSERT INTO guild_member_preferences(community_id,user_id,primary_guild_key) VALUES($1,$2,$3)
      ON CONFLICT(community_id,user_id) DO UPDATE SET primary_guild_key=excluded.primary_guild_key,aggregate_version=guild_member_preferences.aggregate_version+1,updated_at=now()`,[input.actor.community_id,input.actor.user_id,body.primary_guild_key]);
   await q.query("UPDATE onboarding_assessments SET state='completed',published_profile=jsonb_build_object('capabilities',capabilities,'equipment',equipment),aggregate_version=aggregate_version+1,updated_at=now() WHERE assessment_id=$1",[current.assessment_id]);
   await q.query('UPDATE users SET onboarding_completed_at=COALESCE(onboarding_completed_at,now()) WHERE user_id=$1 AND community_id=$2',[input.actor.user_id,input.actor.community_id]);
   await journal(q,input.actor,'member_onboarding',current.assessment_id,(BigInt(current.aggregate_version)+1n).toString(),'complete_onboarding',{assessment_version:ASSESSMENT_VERSION,primary_guild_key:body.primary_guild_key},'freedom.membership.onboarding.completed.v1');
   return onboardingView(q,input.actor);
 });
}
export async function setPrimaryGuild(pool:Pool,input:Command,guildKey:string){
 Empty.parse(input.body);
 return command(pool,input,async()=>{},async q=>{
   await lockMemberGuilds(q,input.actor);
   const membership=(await q.query("SELECT membership_id FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=$2 AND guild_key=$3 AND state='active'",[input.actor.community_id,input.actor.user_id,guildKey])).rows[0];
   requireCondition(membership,409,'active_guild_required','請先加入這個公會，再設為主力。');
   const current=await guildPreferences(q,input.actor);
   if(current.primary_guild_key)checkVersion(current.aggregate_version,input.expected);else requireCondition(!input.expected,412,'version_conflict','主力公會已變更，請重新整理。');
   return (await q.query(`INSERT INTO guild_member_preferences(community_id,user_id,primary_guild_key) VALUES($1,$2,$3)
     ON CONFLICT(community_id,user_id) DO UPDATE SET primary_guild_key=excluded.primary_guild_key,aggregate_version=guild_member_preferences.aggregate_version+1,updated_at=now()
     RETURNING primary_guild_key,aggregate_version`,[input.actor.community_id,input.actor.user_id,guildKey])).rows[0];
 });
}
export async function guildDirectory(pool:Pool,actor:Actor){
 const result=(await pool.query(`SELECT g.*,CASE WHEN m.membership_id IS NULL THEN NULL ELSE jsonb_build_object('membership_id',m.membership_id,'state',m.state,'rank',m.rank,'aggregate_version',m.aggregate_version) END AS membership,
     COALESCE(p.primary_guild_key=g.guild_key,false) AS is_primary,
     CASE WHEN u.user_id IS NULL THEN NULL ELSE jsonb_build_object('display_name',u.display_name) END AS guild_master
   FROM positioning_guild_catalog g
   LEFT JOIN positioning_profession_memberships m ON m.guild_key=g.guild_key AND m.community_id=$1 AND m.user_id=$2
   LEFT JOIN guild_member_preferences p ON p.community_id=$1 AND p.user_id=$2
   LEFT JOIN positioning_guild_officers o ON o.community_id=$1 AND o.guild_key=g.guild_key
   LEFT JOIN users u ON u.user_id=o.user_id AND u.community_id=$1 AND u.active ORDER BY g.guild_key`,[actor.community_id,actor.user_id])).rows;
 return result.map(guild=>({...guild,skill_books:skillBooksForGuild(guild.guild_key)}));
}
export async function memberPositioningSummary(pool:Queryable,communityId:string,userId:string){
 const membership=(await pool.query(`SELECT g.guild_key,g.name,COALESCE(p.primary_guild_key=g.guild_key,false) AS is_primary FROM positioning_profession_memberships m
  JOIN positioning_guild_catalog g USING(guild_key) LEFT JOIN guild_member_preferences p ON p.community_id=m.community_id AND p.user_id=m.user_id
  WHERE m.community_id=$1 AND m.user_id=$2 AND m.state='active' ORDER BY g.guild_key`,[communityId,userId])).rows;
 const row=(await pool.query("SELECT published_profile FROM onboarding_assessments WHERE community_id=$1 AND user_id=$2",[communityId,userId])).rows[0];
 const primary=membership.find(g=>g.is_primary),select=(g:any)=>({guild_key:g.guild_key,name:g.name});
 return {positioning_title:primary?(guildTitles[primary.guild_key]??'專業探索者'):null,primary_guild:primary?select(primary):null,secondary_guilds:membership.filter(g=>!g.is_primary).map(select),capabilities:row?.published_profile?.capabilities??[],equipment:row?.published_profile?.equipment??[]};
}
const ApplicationInput=z.object({name:z.string().trim().min(2).max(100),profession:z.string().trim().min(1).max(160),reason:z.string().trim().min(10).max(2000)}).strict();
export async function createGuildApplication(pool:Pool,input:Command){
 const body=ApplicationInput.parse(input.body);
 return command(pool,input,async()=>{},async q=>{
   await lockMemberGuilds(q,input.actor);
   requireCondition((await q.query("SELECT 1 FROM guild_creation_applications WHERE community_id=$1 AND user_id=$2 AND lower(name)=lower($3) AND state='pending'",[input.actor.community_id,input.actor.user_id,body.name])).rowCount===0,409,'application_pending','相同名稱的申請已在等待處理。');
   requireCondition(Number((await q.query("SELECT count(*) FROM guild_creation_applications WHERE community_id=$1 AND user_id=$2 AND state='pending'",[input.actor.community_id,input.actor.user_id])).rows[0].count)<5,409,'application_limit','目前最多保留五件待處理的公會申請。');
   return (await q.query('INSERT INTO guild_creation_applications(application_id,community_id,user_id,name,profession,reason) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[randomUUID(),input.actor.community_id,input.actor.user_id,body.name,body.profession,body.reason])).rows[0];
 });
}
export async function listGuildApplications(pool:Pool,actor:Actor){return (await pool.query('SELECT * FROM guild_creation_applications WHERE community_id=$1 AND user_id=$2 ORDER BY created_at DESC',[actor.community_id,actor.user_id])).rows;}
