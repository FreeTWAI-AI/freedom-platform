import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { command, journal, checkVersion, type Command } from '../../packages/db/index.js';
import { requireCondition } from '../../packages/shared/problem.js';
import type { Actor } from '../identity-membership/service.js';
import { avatarUrl } from '../identity-membership/avatars.js';
import { skillBooksForGuild, communityCatalog, capabilityCategories, equipmentCategories, type SkillBook } from '../community/catalog.js';
import { ASSESSMENT_VERSION, ASSESSMENT_SHA256, assessmentQuestions, publicAssessmentDefinition, evaluateAssessment, guildTitles } from './assessment.js';

type Queryable=Pick<Pool,'query'>;
const Empty=z.object({}).strict();
const distinct=(max:number)=>z.array(z.string().min(1).max(100)).max(max).refine(values=>new Set(values).size===values.length,'請移除重複選項。');
const customValues=z.array(z.string().trim().min(1).max(60).refine(value=>!/[\x00-\x1f\x7f]/.test(value),'請使用單行文字。')).max(10)
 .refine(values=>new Set(values.map(value=>value.normalize('NFKC').toLowerCase())).size===values.length,'請移除重複的自填項目。');
const QuestionNotes=z.record(z.string().min(1).max(100),z.string().trim().max(500).refine(value=>!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value),'補充文字含不支援的字元。'));
const featuredChoices=(profile:any):string[]=>{
 const choices=[...(profile?.capabilities??[]),...(profile?.custom_capabilities??[]).map((label:string)=>'custom:'+label)];
 const selected=Array.isArray(profile?.featured_capabilities)?profile.featured_capabilities:choices;
 return [...new Set<string>(selected.filter((id:string)=>choices.includes(id)))].slice(0,3);
};
const AnswerInput=z.object({assessment_version:z.literal(ASSESSMENT_VERSION),assessment_sha256:z.literal(ASSESSMENT_SHA256),
 answers:z.record(z.string().max(100),z.string().max(100)),occupation:z.string().trim().max(160),founding_interest:z.boolean(),
 capabilities:distinct(500),equipment:distinct(500),custom_capabilities:customValues.optional(),custom_equipment:customValues.optional(),
 featured_capabilities:distinct(3).optional(),question_notes:QuestionNotes.optional(),}).strict();
export function assessmentDefinition(){return {...publicAssessmentDefinition(),
 capability_categories:capabilityCategories.map(({id,label,items,subcategories})=>({id,label,options:items,subcategories:(subcategories??[{id:'all',label,items}]).map(group=>({id:group.id,label:group.label,options:group.items}))})),
 equipment_categories:equipmentCategories.map(({id,label,items,subcategories})=>({id,label,options:items,subcategories:(subcategories??[{id:'all',label,items}]).map(group=>({id:group.id,label:group.label,options:group.items}))})),
 disclaimer:'這是方向與興趣探索；能力題提供入門情境回饋，不代表證照、職業資格或心理診斷。能力、訂閱與精選技能皆為本人自填；補充文字不參與評分。'};}
export async function lockMemberGuilds(q:PoolClient,actor:Pick<Actor,'community_id'|'user_id'>){
 await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`guild-member/${actor.community_id}/${actor.user_id}`]);
}
export async function listGuildSkillBooks(q:Queryable,communityId:string,guildKey:string):Promise<SkillBook[]>{
 const bound=(await q.query('SELECT book_id FROM guild_skill_book_bindings WHERE community_id=$1 AND guild_key=$2 ORDER BY book_id',[communityId,guildKey])).rows;
 const books=new Map<string,SkillBook>(skillBooksForGuild(guildKey).map(book=>[book.id,book]));
 for(const binding of bound){const book=communityCatalog.skill_books.find(book=>book.id===binding.book_id);if(book)books.set(book.id,book);}
 return [...books.values()];
}
export async function grantGuildBooks(q:PoolClient,actor:Pick<Actor,'community_id'|'user_id'>,guildKey:string){
 for(const book of await listGuildSkillBooks(q,actor.community_id,guildKey))await q.query(`INSERT INTO member_skill_book_grants(grant_id,community_id,user_id,guild_key,book_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[randomUUID(),actor.community_id,actor.user_id,guildKey,book.id]);
}
export async function assertCanLeaveGuild(q:PoolClient,actor:Actor,guildKey:string){
 const pref=(await q.query('SELECT primary_guild_key FROM guild_member_preferences WHERE community_id=$1 AND user_id=$2',[actor.community_id,actor.user_id])).rows[0];
 requireCondition(pref?.primary_guild_key!==guildKey,409,'primary_guild_required','請先把另一個已加入的公會設為主力，再離開這個公會。');
}
export async function listSkillBooks(q:Queryable,actor:Pick<Actor,'community_id'|'user_id'>){
 const grants=(await q.query('SELECT book_id,guild_key,granted_at FROM member_skill_book_grants WHERE community_id=$1 AND user_id=$2 ORDER BY granted_at,book_id',[actor.community_id,actor.user_id])).rows;
 const books=new Map<string,any>();
 for(const grant of grants){const definition=communityCatalog.skill_books.find(book=>book.id===grant.book_id);if(!definition)continue;
   if(books.has(grant.book_id))books.get(grant.book_id).guild_keys.push(grant.guild_key);
   else books.set(grant.book_id,{...definition,book_id:grant.book_id,guild_keys:[grant.guild_key],granted_at:grant.granted_at});
 }
 return [...books.values()];
}
type GuildPreferenceRow={primary_guild_key:string|null;secondary_guild_keys:string[]|null;aggregate_version:string|null;active_guild_keys:string[]};
function effectiveSecondary(row:GuildPreferenceRow):string[]{
 const active=new Set(row.active_guild_keys);
 return [...new Set(row.secondary_guild_keys??row.active_guild_keys)].filter(key=>key!==row.primary_guild_key&&active.has(key)).slice(0,2);
}
async function guildPreferenceState(q:Queryable,actor:Pick<Actor,'community_id'|'user_id'>):Promise<GuildPreferenceRow>{
 return (await q.query(`SELECT p.primary_guild_key,p.secondary_guild_keys,p.aggregate_version,
   ARRAY(SELECT m.guild_key FROM positioning_profession_memberships m WHERE m.community_id=$1 AND m.user_id=$2 AND m.state='active' ORDER BY m.guild_key) AS active_guild_keys
   FROM (VALUES(1)) anchor(n) LEFT JOIN guild_member_preferences p ON p.community_id=$1 AND p.user_id=$2`,[actor.community_id,actor.user_id])).rows[0];
}
export async function guildPreferences(q:Queryable,actor:Pick<Actor,'community_id'|'user_id'>){
 const row=await guildPreferenceState(q,actor);
 return {primary_guild_key:row.primary_guild_key,secondary_guild_keys:effectiveSecondary(row),aggregate_version:row.aggregate_version};
}
async function savePrimaryPreference(q:PoolClient,actor:Actor,guildKey:string){
 const previous=await guildPreferenceState(q,actor);
 // Persist the initial choices once; later joins cannot displace them.
 let secondary=previous.secondary_guild_keys??effectiveSecondary({...previous,primary_guild_key:previous.primary_guild_key??guildKey});
 if(previous.primary_guild_key&&previous.primary_guild_key!==guildKey){
   secondary=effectiveSecondary(previous).filter(key=>key!==guildKey);
   // Explicitly empty remains empty. Otherwise the former primary fills a free slot.
   if(previous.secondary_guild_keys?.length!==0&&secondary.length<2&&previous.active_guild_keys.includes(previous.primary_guild_key))secondary.push(previous.primary_guild_key);
 }
 await q.query(`INSERT INTO guild_member_preferences(community_id,user_id,primary_guild_key,secondary_guild_keys) VALUES($1,$2,$3,$4)
   ON CONFLICT(community_id,user_id) DO UPDATE SET primary_guild_key=excluded.primary_guild_key,secondary_guild_keys=excluded.secondary_guild_keys,
   aggregate_version=guild_member_preferences.aggregate_version+1,updated_at=now()`,[actor.community_id,actor.user_id,guildKey,secondary]);
 return guildPreferences(q,actor);
}
export async function removeSecondaryGuildOnLeave(q:PoolClient,actor:Actor,guildKey:string){
 const current=await guildPreferenceState(q,actor);
 if(!current.primary_guild_key)return;
 const secondary=effectiveSecondary(current).filter(key=>key!==guildKey);
 // Freeze NULL before leaving so joining again cannot silently reclaim a secondary slot.
 if(current.secondary_guild_keys===null||JSON.stringify(current.secondary_guild_keys)!==JSON.stringify(secondary))
   await q.query('UPDATE guild_member_preferences SET secondary_guild_keys=$3,aggregate_version=aggregate_version+1,updated_at=now() WHERE community_id=$1 AND user_id=$2',[actor.community_id,actor.user_id,secondary]);
}
const SecondaryInput=z.object({secondary_guild_keys:distinct(2)}).strict();
export async function setSecondaryGuilds(pool:Pool,input:Command){
 const body=SecondaryInput.parse(input.body);
 return command(pool,input,async()=>{},async q=>{
   await lockMemberGuilds(q,input.actor);
   const current=await guildPreferenceState(q,input.actor);
   requireCondition(current.primary_guild_key,409,'primary_guild_required','請先設定主要公會。');
   checkVersion(current.aggregate_version!,input.expected);
   requireCondition(!body.secondary_guild_keys.includes(current.primary_guild_key!),422,'primary_guild_not_secondary','主要公會不能同時設為次要公會。');
   requireCondition(body.secondary_guild_keys.every(key=>current.active_guild_keys.includes(key)),409,'active_guild_required','請先加入公會，再設為次要。');
   await q.query('UPDATE guild_member_preferences SET secondary_guild_keys=$3,aggregate_version=aggregate_version+1,updated_at=now() WHERE community_id=$1 AND user_id=$2',[input.actor.community_id,input.actor.user_id,body.secondary_guild_keys]);
   return guildPreferences(q,input.actor);
 });
}
export async function onboardingView(q:Queryable,actor:Actor){
 const user=(await q.query('SELECT onboarding_required,onboarding_completed_at FROM users WHERE user_id=$1 AND community_id=$2',[actor.user_id,actor.community_id])).rows[0];
 const row=(await q.query('SELECT * FROM onboarding_assessments WHERE community_id=$1 AND user_id=$2',[actor.community_id,actor.user_id])).rows[0];
 const prefs=await guildPreferences(q,actor);
 return {required:!!user?.onboarding_required&&!user?.onboarding_completed_at,completed:!!user?.onboarding_completed_at,
   assessment_update_required:!!row&&(row.assessment_version!==ASSESSMENT_VERSION||row.assessment_sha256!==ASSESSMENT_SHA256),
   current_assessment_version:ASSESSMENT_VERSION,current_assessment_sha256:ASSESSMENT_SHA256,
   state:row?.state??'new',draft:row?{aggregate_version:row.aggregate_version,assessment_version:row.assessment_version,assessment_sha256:row.assessment_sha256,
     answers:row.answers,occupation:row.occupation,founding_interest:row.founding_interest,capabilities:row.capabilities,equipment:row.equipment,custom_capabilities:row.custom_capabilities,custom_equipment:row.custom_equipment,
     featured_capabilities:featuredChoices(row),question_notes:row.question_notes}:null,
   result:row?.result??null,primary_guild_key:prefs.primary_guild_key,secondary_guild_keys:prefs.secondary_guild_keys,skill_books:await listSkillBooks(q,actor)};
}
export async function saveAssessmentAnswers(pool:Pool,input:Command){
 const body=AnswerInput.parse(input.body);
 for(const [key,value] of Object.entries(body.answers)){
   const question=assessmentQuestions.find(q=>q.id===key);requireCondition(question&&question.options.some(option=>option.id===value),422,'invalid_assessment_answer','請使用目前定位題目提供的選項。');
 }
 for(const key of Object.keys(body.question_notes??{}))requireCondition(assessmentQuestions.some(question=>question.id===key),422,'unknown_question_note','補充說明必須對應目前的定位題目。');
 const capabilityIds=new Set(capabilityCategories.flatMap(c=>c.items.map(i=>i.id))),equipmentIds=new Set(equipmentCategories.flatMap(c=>c.items.map(i=>i.id)));
 requireCondition(body.capabilities.every(id=>capabilityIds.has(id))&&body.equipment.every(id=>equipmentIds.has(id)),422,'unknown_capability_or_equipment','請從目前分類選單選擇能力與裝備。');
 return command(pool,input,async()=>{},async q=>{
   await lockMemberGuilds(q,input.actor);
   const current=(await q.query('SELECT * FROM onboarding_assessments WHERE community_id=$1 AND user_id=$2',[input.actor.community_id,input.actor.user_id])).rows[0];
   if(current)checkVersion(current.aggregate_version,input.expected);else requireCondition(!input.expected,412,'version_conflict','定位進度已變更，請重新整理。');
   const customCapabilities=body.custom_capabilities??current?.custom_capabilities??[],customEquipment=body.custom_equipment??current?.custom_equipment??[];
   const choices=new Set([...body.capabilities,...customCapabilities.map((label:string)=>'custom:'+label)]);
   if(body.featured_capabilities!==undefined)requireCondition(body.featured_capabilities.every(id=>choices.has(id)),422,'featured_capability_not_selected','精選技能必須來自你已勾選或自填的能力。');
   const featured=body.featured_capabilities??(current?.featured_capabilities?current.featured_capabilities.filter((id:string)=>choices.has(id)):null);
   const questionNotes=body.question_notes??current?.question_notes??{};
   await q.query(`INSERT INTO onboarding_assessments(assessment_id,community_id,user_id,assessment_version,assessment_sha256,state,answers,occupation,founding_interest,capabilities,equipment,custom_capabilities,custom_equipment,featured_capabilities,question_notes)
      VALUES($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT(community_id,user_id) DO UPDATE SET aggregate_version=onboarding_assessments.aggregate_version+1,
        assessment_version=excluded.assessment_version,assessment_sha256=excluded.assessment_sha256,state='draft',answers=excluded.answers,
        occupation=excluded.occupation,founding_interest=excluded.founding_interest,capabilities=excluded.capabilities,equipment=excluded.equipment,custom_capabilities=excluded.custom_capabilities,custom_equipment=excluded.custom_equipment,
        featured_capabilities=excluded.featured_capabilities,question_notes=excluded.question_notes,result=NULL,updated_at=now()`,
     [randomUUID(),input.actor.community_id,input.actor.user_id,body.assessment_version,body.assessment_sha256,JSON.stringify(body.answers),body.occupation,body.founding_interest,body.capabilities,body.equipment,customCapabilities,customEquipment,featured,JSON.stringify(questionNotes)]);
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
   const result=evaluateAssessment(current.answers);
   const guilds=(await q.query('SELECT guild_key,name FROM positioning_guild_catalog WHERE guild_key=ANY($1::text[])',[result.recommendations.map(r=>r.guild_key)])).rows;
   const enriched={...result,recommendations:result.recommendations.map(r=>({...r,name:guilds.find(g=>g.guild_key===r.guild_key)!.name}))};
   await q.query(`UPDATE onboarding_assessments SET state='evaluated',result=$1,aggregate_version=aggregate_version+1,updated_at=now() WHERE assessment_id=$2`,[JSON.stringify(enriched),current.assessment_id]);
   return onboardingView(q,input.actor);
 });
}
const CompleteInput=z.object({guild_keys:distinct(15).refine(keys=>keys.length>0,'請至少加入一個公會。'),primary_guild_key:z.string().min(1).max(100),confirmed:z.literal(true)}).strict();
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
   await savePrimaryPreference(q,input.actor,body.primary_guild_key);
   await q.query("UPDATE onboarding_assessments SET state='completed',published_profile=jsonb_build_object('capabilities',capabilities,'equipment',equipment,'custom_capabilities',custom_capabilities,'custom_equipment',custom_equipment,'featured_capabilities',featured_capabilities),aggregate_version=aggregate_version+1,updated_at=now() WHERE assessment_id=$1",[current.assessment_id]);
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
   if(current.primary_guild_key)checkVersion(current.aggregate_version!,input.expected);else requireCondition(!input.expected,412,'version_conflict','主力公會已變更，請重新整理。');
   return savePrimaryPreference(q,input.actor,guildKey);
 });
}
export async function guildDirectory(pool:Pool,actor:Actor){
 // Avatar metadata uses the same visibility snapshot as the roles. New members
 // may browse guild choices, but cannot receive another member's avatar URL.
 const result=(await pool.query(`WITH visible_avatars AS (
   SELECT av.user_id,av.aggregate_version FROM member_avatars av
   JOIN users owner ON owner.user_id=av.user_id AND owner.community_id=av.community_id
   JOIN users viewer ON viewer.user_id=$2 AND viewer.community_id=av.community_id
   JOIN sessions viewer_session ON viewer_session.user_id=viewer.user_id AND viewer_session.token_hash=$3
   WHERE av.community_id=$1 AND av.image_bytes IS NOT NULL
     AND owner.active AND (NOT owner.onboarding_required OR owner.onboarding_completed_at IS NOT NULL)
     AND viewer.active AND (NOT viewer.onboarding_required OR viewer.onboarding_completed_at IS NOT NULL)
     AND viewer_session.revoked_at IS NULL AND viewer_session.expires_at>now()
 ) SELECT g.*,CASE WHEN m.membership_id IS NULL THEN NULL ELSE jsonb_build_object('membership_id',m.membership_id,'state',m.state,'rank',m.rank,'aggregate_version',m.aggregate_version) END AS membership,
     COALESCE(p.primary_guild_key=g.guild_key,false) AS is_primary,p.secondary_guild_keys AS stored_secondary_guild_keys,
     CASE WHEN u.user_id IS NULL THEN NULL ELSE jsonb_build_object('user_id',u.user_id,'display_name',u.display_name,'avatar_version',ma.aggregate_version) END AS guild_master,
     COALESCE((SELECT jsonb_agg(jsonb_build_object('user_id',eu.user_id,'display_name',eu.display_name,'avatar_version',ea.aggregate_version) ORDER BY eu.display_name,eu.user_id)
       FROM positioning_guild_experts e JOIN users eu ON eu.user_id=e.user_id AND eu.community_id=e.community_id AND eu.active
       JOIN positioning_profession_memberships em ON em.community_id=e.community_id AND em.guild_key=e.guild_key AND em.user_id=e.user_id AND em.state='active'
       LEFT JOIN visible_avatars ea ON ea.user_id=eu.user_id
       WHERE e.community_id=$1 AND e.guild_key=g.guild_key AND e.active),'[]'::jsonb) AS guild_experts,
     CASE WHEN u.user_id IS NULL AND a.admin_id IS NOT NULL THEN jsonb_build_object('display_name',a.display_name,'state','pending') ELSE NULL END AS guild_master_nominee
   FROM positioning_guild_catalog g
   LEFT JOIN positioning_profession_memberships m ON m.guild_key=g.guild_key AND m.community_id=$1 AND m.user_id=$2
   LEFT JOIN guild_member_preferences p ON p.community_id=$1 AND p.user_id=$2
   LEFT JOIN positioning_guild_officers o ON o.community_id=$1 AND o.guild_key=g.guild_key
   LEFT JOIN users u ON u.user_id=o.user_id AND u.community_id=$1 AND u.active
   LEFT JOIN visible_avatars ma ON ma.user_id=u.user_id
   LEFT JOIN guild_leadership_nominations n ON n.community_id=$1 AND n.guild_key=g.guild_key AND n.state='pending'
   LEFT JOIN platform_admins a ON a.admin_id=n.admin_id AND a.community_id=$1 AND a.active
   ORDER BY is_primary DESC,COALESCE(m.state='active',false) DESC,g.guild_key`,[actor.community_id,actor.user_id,actor.session_hash])).rows;
 const secondary=effectiveSecondary({primary_guild_key:result.find(g=>g.is_primary)?.guild_key??null,secondary_guild_keys:result[0]?.stored_secondary_guild_keys??null,aggregate_version:null,active_guild_keys:result.filter(g=>g.membership?.state==='active').map(g=>g.guild_key)});
 const person=(row:any)=>({user_id:row.user_id,display_name:row.display_name,avatar_url:avatarUrl(row.user_id,row.avatar_version??'1',row.avatar_version!=null)});
 return Promise.all(result.map(async ({stored_secondary_guild_keys,...guild})=>({...guild,is_secondary:guild.membership?.state==='active'&&!guild.is_primary&&secondary.includes(guild.guild_key),secondary_position:guild.membership?.state==='active'&&!guild.is_primary&&secondary.includes(guild.guild_key)?secondary.indexOf(guild.guild_key)+1:null,guild_master:guild.guild_master?person(guild.guild_master):null,guild_experts:guild.guild_experts.map(person),skill_books:await listGuildSkillBooks(pool,actor.community_id,guild.guild_key)})));
}
export async function memberPositioningSummary(pool:Queryable,communityId:string,userId:string){
 const membership=(await pool.query(`SELECT g.guild_key,g.name,m.joined_at,p.secondary_guild_keys,COALESCE(p.primary_guild_key=g.guild_key,false) AS is_primary FROM positioning_profession_memberships m
  JOIN positioning_guild_catalog g USING(guild_key) LEFT JOIN guild_member_preferences p ON p.community_id=m.community_id AND p.user_id=m.user_id
  WHERE m.community_id=$1 AND m.user_id=$2 AND m.state='active' ORDER BY g.guild_key`,[communityId,userId])).rows;
 const row=(await pool.query("SELECT published_profile FROM onboarding_assessments WHERE community_id=$1 AND user_id=$2",[communityId,userId])).rows[0];
 const primary=membership.find(g=>g.is_primary),select=(g:any)=>({guild_key:g.guild_key,name:g.name,joined_at:new Date(g.joined_at).toISOString()}),profile=row?.published_profile;
 const secondary=effectiveSecondary({primary_guild_key:primary?.guild_key??null,secondary_guild_keys:membership[0]?.secondary_guild_keys??null,aggregate_version:null,active_guild_keys:membership.map(g=>g.guild_key)});
 return {positioning_title:primary?(guildTitles[primary.guild_key]??'專業探索者'):null,primary_guild:primary?select(primary):null,secondary_guilds:secondary.map(key=>select(membership.find(g=>g.guild_key===key))),joined_guilds:membership.filter(g=>!g.is_primary&&!secondary.includes(g.guild_key)).map(select),capabilities:profile?.capabilities??[],equipment:profile?.equipment??[],custom_capabilities:profile?.custom_capabilities??[],custom_equipment:profile?.custom_equipment??[],featured_capabilities:featuredChoices(profile)};
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
