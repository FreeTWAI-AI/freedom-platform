import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {command,checkVersion,journal,transaction,type Command} from '../../packages/db/index.js';
import {Problem,requireCondition} from '../../packages/shared/problem.js';
import type {Actor} from '../identity-membership/service.js';
import {assertCurrentSessionClock,lockMemberSession} from '../../packages/db/member-session.js';

type Query=Pick<Pool,'query'>;
type Choice='work'|'introduction';
export interface FirstParticipationCompletion {kind:'work'|'guild_message';source_id:string;created_at:string;title:string|null;href:string;audience:'community'|'guild';reply_count:number|null}
export interface FirstParticipation {aggregate_version:number;choice:Choice|null;state:'offered'|'chosen'|'completed'|'source_unavailable'|'skipped'|'dismissed';guild_key:string|null;started_at:string|null;completion:FirstParticipationCompletion|null;resume:null|{kind:'work_draft';source_id:string;href:string};reception:{requested:boolean;state:'not_requested'|'unclaimed'|'claimed'|'stopped';claimant:null|{user_id:string;display_name:string}}}
const actions=z.union([z.object({action:z.literal('choose'),choice:z.enum(['work','introduction'])}).strict(),z.object({action:z.enum(['skip','dismiss','resume','request_reception','stop_reception'])}).strict()]);
const rowSchema=z.looseObject({user_id:z.string(),community_id:z.string(),aggregate_version:z.union([z.string(),z.number()]),choice:z.enum(['work','introduction']).nullable(),state:z.enum(['offered','chosen','skipped','dismissed']),guild_key:z.string().nullable(),started_at:z.union([z.date(),z.string()]).nullable(),reception_requested:z.boolean(),reception_stopped:z.boolean(),claimant_ref:z.string().nullable(),display_name:z.string().optional()});
type ParticipationRow=z.infer<typeof rowSchema>;
const ready=(a:string)=>`${a}.active AND (NOT ${a}.onboarding_required OR ${a}.onboarding_completed_at IS NOT NULL)`;
const iso=(v:Date|string)=>new Date(v).toISOString();
async function member(q:Query,id:string,community:string){return (await q.query(`SELECT user_id,display_name FROM users u WHERE user_id=$1 AND community_id=$2 AND ${ready('u')} FOR SHARE`,[id,community])).rows[0];}
async function guild(q:PoolClient,actor:Actor,key?:string|null){
 await q.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[`guild-member/${actor.community_id}/${actor.user_id}`]);
 const row=(await q.query(`SELECT m.guild_key FROM positioning_profession_memberships m JOIN positioning_guild_catalog g USING(guild_key)
 JOIN guild_member_preferences p ON p.community_id=m.community_id AND p.user_id=m.user_id
 WHERE m.community_id=$1 AND m.user_id=$2 AND m.state='active' AND m.guild_key=COALESCE($3,p.primary_guild_key)
 AND (m.guild_key NOT LIKE 'guild_custom_%' OR EXISTS(SELECT 1 FROM guild_creation_applications a WHERE a.community_id=m.community_id AND a.approved_guild_key=m.guild_key AND a.state='approved')) FOR SHARE OF m`,[actor.community_id,actor.user_id,key??null])).rows[0];
 return row?.guild_key as string|undefined;
}
async function row(q:Query,actor:Actor,id=actor.user_id){const value=(await q.query('SELECT * FROM member_first_participation WHERE user_id=$1 AND community_id=$2',[id,actor.community_id])).rows[0];return value?rowSchema.parse(value):undefined;}
async function lock(q:PoolClient,actor:Actor,id=actor.user_id){await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`first-participation/${actor.community_id}/${id}`]);return row(q,actor,id);}
// The original journal proves first publication even after withdrawal; no cached title is retained.
async function source(q:PoolClient,actor:Actor,r:ParticipationRow|undefined):Promise<{completion:FirstParticipationCompletion|null;unavailable:boolean}>{
 if(!r?.choice||!r.started_at)return {completion:null,unavailable:false};
 if(r.choice==='work'){
  const fact=(await q.query(`SELECT aggregate_id,MIN(created_at) AS created_at FROM transition_journal WHERE community_id=$1 AND actor_ref=$2 AND aggregate_type='showcase' AND command='share_with_community' GROUP BY aggregate_id HAVING MIN(created_at)>=$3 ORDER BY MIN(created_at),aggregate_id LIMIT 1`,[r.community_id,r.user_id,r.started_at])).rows[0];
  if(!fact)return {completion:null,unavailable:false};
  const s=(await q.query(`SELECT s.showcase_id,s.title FROM showcases s JOIN users u ON u.user_id=s.owner_ref AND u.community_id=s.community_id WHERE s.showcase_id=$1 AND s.owner_ref=$2 AND s.community_id=$3 AND s.status='published' AND s.visibility='community' AND s.consent_recorded_at IS NOT NULL AND ${ready('u')} AND (s.owner_ref=$4 OR NOT is_verification_test_account(s.owner_ref)) FOR SHARE OF s,u`,[fact.aggregate_id,r.user_id,r.community_id,actor.user_id])).rows[0];
  const replies=s&&actor.user_id===r.user_id?Number((await q.query('SELECT count(*) AS n FROM opportunities WHERE community_id=$1 AND showcase_id=$2 AND provider_ref=$3',[r.community_id,s.showcase_id,actor.user_id])).rows[0].n):null;
  return {unavailable:!s,completion:s?{kind:'work',source_id:s.showcase_id,created_at:iso(fact.created_at),title:s.title,href:`#showcase/${s.showcase_id}`,audience:'community',reply_count:replies}:null};
 }
 const fact=(await q.query(`SELECT message_id,created_at FROM member_channel_messages WHERE community_id=$1 AND sender_ref=$2 AND kind='guild' AND channel_key=$3 AND created_at>=$4 ORDER BY created_at,message_id LIMIT 1`,[r.community_id,r.user_id,r.guild_key,r.started_at])).rows[0];
 if(!fact)return {completion:null,unavailable:false};
 const owner={...actor,user_id:r.user_id};
 const readable=await member(q,r.user_id,r.community_id)&&await guild(q,owner,r.guild_key)&&await guild(q,actor,r.guild_key);
 if(!readable)return {completion:null,unavailable:true};
 const replies=Number((await q.query(`SELECT count(*) AS n FROM member_channel_messages WHERE community_id=$1 AND kind='guild' AND channel_key=$2 AND reply_to_message_id=$3 AND sender_ref<>$4`,[r.community_id,r.guild_key,fact.message_id,r.user_id])).rows[0].n);
 return {unavailable:false,completion:{kind:'guild_message',source_id:fact.message_id,created_at:iso(fact.created_at),title:null,href:`#messages?guild=${encodeURIComponent(r.guild_key!)}`,audience:'guild',reply_count:replies}};
}
async function projection(q:PoolClient,actor:Actor,r:ParticipationRow|undefined):Promise<FirstParticipation>{
 const current=await source(q,actor,r);let claimant:FirstParticipation['reception']['claimant']=null;
 if(r?.reception_requested&&r.claimant_ref&&current.completion){const u=await member(q,r.claimant_ref,actor.community_id);if(u&&(r.choice!=='introduction'||await guild(q,{...actor,user_id:r.claimant_ref},r.guild_key)))claimant={user_id:String(u.user_id),display_name:String(u.display_name)};}
 let resume:FirstParticipation['resume']=null;
 if(r&&actor.user_id===r.user_id&&r.choice==='work'&&!current.completion){const d=(await q.query(`SELECT showcase_id FROM showcases WHERE community_id=$1 AND owner_ref=$2 AND status IN ('draft','withdrawn') ORDER BY updated_at DESC,showcase_id LIMIT 1`,[actor.community_id,actor.user_id])).rows[0];if(d)resume={kind:'work_draft',source_id:d.showcase_id,href:'#my-content'};}
 const state=r?.state??'offered';
 return {aggregate_version:Number(r?.aggregate_version??1),choice:r?.choice??null,state:state==='chosen'?(current.unavailable?'source_unavailable':current.completion?'completed':'chosen'):state,guild_key:r?.guild_key??null,started_at:r?.started_at?iso(r.started_at):null,completion:current.completion,resume,reception:{requested:r?.reception_requested??false,state:r?.reception_requested?(claimant?'claimed':'unclaimed'):r?.reception_stopped?'stopped':'not_requested',claimant}};
}
async function read<T>(pool:Pool,actor:Actor,run:(q:PoolClient)=>Promise<T>){
 for(let attempt=0;;attempt++){
  try{return await transaction(pool,async q=>{
   await q.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
   await lockMemberSession(q,actor);
   requireCondition(await member(q,actor.user_id,actor.community_id),403,'onboarding_required','請先選擇主要公會。');
   const result=await run(q);await assertCurrentSessionClock(q,actor);return result;
  });}catch(error){
   if(error instanceof Problem||!(error instanceof Error)||!('code' in error)||error.code!=='40001')throw error;
   if(attempt===2)throw new Problem(503,'first_participation_busy','資料正在更新，請稍後再試。');
  }
 }
}
export async function readFirstParticipation(pool:Pool,actor:Actor){return read(pool,actor,async q=>projection(q,actor,await row(q,actor)));}
export async function changeFirstParticipation(pool:Pool,input:Command){
 const body=actions.parse(input.body),actor=input.actor;
 await command(pool,{...input,body},async q=>{requireCondition(await member(q,actor.user_id,actor.community_id),403,'onboarding_required','請先選擇主要公會。');},async q=>{
  const prior=await lock(q,actor);checkVersion(String(prior?.aggregate_version??1),input.expected);
  if(!prior)await q.query('INSERT INTO member_first_participation(user_id,community_id) VALUES($1,$2)',[actor.user_id,actor.community_id]);
  if(body.action==='choose'){
   const key=await guild(q,actor);requireCondition(key,409,'primary_guild_required','請先選擇主要公會。');
   await q.query(`UPDATE member_first_participation SET choice=$2,state='chosen',guild_key=$3,started_at=clock_timestamp(),reception_requested=false,reception_stopped=false,claimant_ref=NULL WHERE user_id=$1`,[actor.user_id,body.choice,key]);
  }else if(body.action==='skip'||body.action==='dismiss')await q.query('UPDATE member_first_participation SET state=$2,reception_requested=false,claimant_ref=NULL WHERE user_id=$1',[actor.user_id,body.action==='skip'?'skipped':'dismissed']);
  else if(body.action==='resume')await q.query("UPDATE member_first_participation SET state=CASE WHEN choice IS NULL THEN 'offered' ELSE 'chosen' END WHERE user_id=$1",[actor.user_id]);
  else if(body.action==='request_reception'){const current=await row(q,actor);requireCondition(current?.state==='chosen'&&(await source(q,actor,current)).completion,409,'contribution_required','請先完成原作品分享或公會訊息，再自願請求接待。');await q.query('UPDATE member_first_participation SET reception_requested=true,reception_stopped=false WHERE user_id=$1',[actor.user_id]);}
  else await q.query('UPDATE member_first_participation SET reception_requested=false,reception_stopped=true,claimant_ref=NULL WHERE user_id=$1',[actor.user_id]);
  const saved=(await q.query('UPDATE member_first_participation SET aggregate_version=aggregate_version+1,updated_at=clock_timestamp() WHERE user_id=$1 RETURNING aggregate_version',[actor.user_id])).rows[0];
  await journal(q,actor,'first_participation',actor.user_id,saved.aggregate_version,body.action);return {user_id:actor.user_id};
 });
 return readFirstParticipation(pool,actor);
}
export async function listFirstParticipationReception(pool:Pool,actor:Actor,raw:unknown){
 const {offset,limit}=z.object({offset:z.coerce.number().int().min(0).max(10000).default(0),limit:z.coerce.number().int().min(1).max(50).default(20)}).strict().parse(raw);
 return read(pool,actor,async q=>{
  const candidates=(await q.query(`SELECT p.*,u.display_name FROM member_first_participation p JOIN users u USING(user_id)
   WHERE p.community_id=$1 AND u.community_id=p.community_id AND ${ready('u')} AND p.reception_requested AND p.state='chosen' AND p.user_id<>$2
   AND ((p.choice='work' AND NOT is_verification_test_account(p.user_id) AND EXISTS(
    SELECT 1 FROM showcases s WHERE s.community_id=p.community_id AND s.owner_ref=p.user_id AND s.status='published' AND s.visibility='community' AND s.consent_recorded_at IS NOT NULL
    AND s.showcase_id=(SELECT j.aggregate_id FROM transition_journal j WHERE j.community_id=p.community_id AND j.actor_ref=p.user_id AND j.aggregate_type='showcase' AND j.command='share_with_community' GROUP BY j.aggregate_id HAVING MIN(j.created_at)>=p.started_at ORDER BY MIN(j.created_at),j.aggregate_id LIMIT 1)))
    OR (p.choice='introduction' AND EXISTS(SELECT 1 FROM member_channel_messages m WHERE m.community_id=p.community_id AND m.sender_ref=p.user_id AND m.kind='guild' AND m.channel_key=p.guild_key AND m.created_at>=p.started_at)
     AND EXISTS(SELECT 1 FROM positioning_profession_memberships m JOIN guild_member_preferences pref ON pref.community_id=m.community_id AND pref.user_id=m.user_id WHERE m.community_id=p.community_id AND m.user_id=p.user_id AND m.guild_key=p.guild_key AND m.state='active')
     AND EXISTS(SELECT 1 FROM positioning_profession_memberships m JOIN guild_member_preferences pref ON pref.community_id=m.community_id AND pref.user_id=m.user_id WHERE m.community_id=p.community_id AND m.user_id=$2 AND m.guild_key=p.guild_key AND m.state='active')
     AND (p.guild_key NOT LIKE 'guild_custom_%' OR EXISTS(SELECT 1 FROM guild_creation_applications a WHERE a.community_id=p.community_id AND a.approved_guild_key=p.guild_key AND a.state='approved'))))
   ORDER BY p.updated_at,p.user_id LIMIT $3 OFFSET $4 FOR SHARE OF p,u`,[actor.community_id,actor.user_id,limit+1,offset])).rows.map(value=>rowSchema.parse(value));
  const items=[];for(const r of candidates.slice(0,limit)){const view=await projection(q,actor,r);if(view.completion)items.push({user_id:r.user_id,display_name:r.display_name,aggregate_version:view.aggregate_version,choice:view.choice,completion:view.completion,claimant:view.reception.claimant});}
  return {items,next_offset:candidates.length>limit?offset+limit:null};
 });
}
export async function claimFirstParticipationReception(pool:Pool,input:Command,id:string,release=false){
 z.object({}).strict().parse(input.body);id=z.uuid().parse(id);const actor=input.actor;
 const authorize=async(q:PoolClient)=>{requireCondition(await member(q,actor.user_id,actor.community_id),403,'onboarding_required','請先選擇主要公會。');requireCondition(id!==actor.user_id,403,'self_claim_forbidden','不能接待自己的請求。');const r=await lock(q,actor,id);requireCondition(r?.reception_requested&&r.state==='chosen'&&await member(q,id,actor.community_id)&&(await source(q,actor,r)).completion,404,'not_found','找不到目前可接待的請求。');return r!;};
 await command(pool,input,authorize,async q=>{const r=await authorize(q);checkVersion(String(r.aggregate_version),input.expected);const view=await projection(q,actor,r);requireCondition(release?r.claimant_ref===actor.user_id:!view.reception.claimant,409,'reception_claim_conflict','接待認領已更新，請重新整理。');const saved=(await q.query('UPDATE member_first_participation SET claimant_ref=$2,aggregate_version=aggregate_version+1,updated_at=clock_timestamp() WHERE user_id=$1 RETURNING aggregate_version',[id,release?null:actor.user_id])).rows[0];await journal(q,actor,'first_participation',id,saved.aggregate_version,release?'release':'claim');return {user_id:id};});
 return read(pool,actor,async q=>{const r=await row(q,actor,id);requireCondition(r?.reception_requested&&(await source(q,actor,r)).completion,404,'not_found','找不到目前可接待的請求。');const view=await projection(q,actor,r);const u=await member(q,id,actor.community_id);requireCondition(u,404,'not_found','找不到目前可接待的請求。');return {user_id:id,display_name:u.display_name,aggregate_version:view.aggregate_version,choice:view.choice,completion:view.completion,claimant:view.reception.claimant};});
}
