import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {z} from 'zod';
import {checkVersion,command,digest,journal,type Command} from '../../packages/db/index.js';
import {Problem,requireCondition} from '../../packages/shared/problem.js';
import {text} from '../../packages/shared/validation.js';
import type {Actor} from '../identity-membership/service.js';
import {readPublishedSquadOutcome} from '../identity-membership/squad-outcomes.js';
import {publishedWorkFrom,publishedWorkPayload} from '../skill-submissions/public.js';
import {publicPath} from '../skill-submissions/service.js';
import {communityCatalog} from './catalog.js';
import {getSkillCollaboration} from './skill-collaboration.js';

type Query=Pick<Pool,'query'>;
export type EventOutcomeViewer={communityId:string;userId:string};
export type EventOutcomeRef={kind:'work'|'skill_book'|'squad_outcome';id:string};
const refInput=z.object({kind:z.enum(['work','skill_book','squad_outcome']),id:z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/).transform(id=>z.uuid().safeParse(id).success?id.toLowerCase():id)}).strict();
const draftInput=z.object({title:text(120),summary:text(4000),audience:z.enum(['public','community','guild']),refs:z.array(refInput).max(8).default([])}).strict().refine(b=>new Set(b.refs.map(r=>`${r.kind}/${r.id}`)).size===b.refs.length,'來源不可重複。');
const publishInput=z.object({consent_to_share:z.literal(true)}).strict();
const viewerOf=(actor:Actor):EventOutcomeViewer=>({communityId:actor.community_id,userId:actor.user_id});
async function member(q:Query,v:EventOutcomeViewer){return (await q.query(`SELECT user_id,display_name FROM users WHERE user_id=$1 AND community_id=$2 AND active AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL)`,[v.userId,v.communityId])).rows[0];}
async function event(q:Query,id:string,v:EventOutcomeViewer|null,lock=false){
 const row=(await q.query(`SELECT e.*,is_verification_test_account(e.organizer_ref) AS hidden FROM community_events e WHERE event_id=$1${lock?' FOR UPDATE OF e':''}`,[z.uuid().parse(id)])).rows[0];
 requireCondition(row&&row.state==='published'&&new Date(row.ends_at).getTime()<=Date.now()&&(!row.hidden||v?.userId===row.organizer_ref),404,'not_found','找不到這場活動成果。');
 if(v){requireCondition(v.communityId===row.community_id&&await member(q,v),404,'not_found','找不到這場活動成果。');
  if(row.visibility==='guild'&&row.organizer_ref!==v.userId)requireCondition((await q.query(`SELECT 1 FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=$2 AND guild_key=$3 AND state='active'`,[row.community_id,v.userId,row.guild_key])).rowCount===1,404,'not_found','找不到這場活動成果。');
 }else requireCondition(['open','referral'].includes(row.visibility),404,'not_found','找不到這場活動成果。');
 return row;
}
async function source(q:Query,ref:EventOutcomeRef,communityId:string,v:EventOutcomeViewer|null){
 if(v)requireCondition(v.communityId===communityId&&await member(q,v),404,'not_found','找不到來源。');
 if(ref.kind==='work'){
  requireCondition(v&&z.uuid().safeParse(ref.id).success,404,'not_found','找不到來源。');
  const row=(await q.query(`SELECT s.*,u.display_name FROM showcases s JOIN users u ON u.user_id=s.owner_ref AND u.community_id=s.community_id WHERE s.showcase_id=$1 AND s.community_id=$2 AND s.status='published' AND s.visibility='community' AND s.consent_recorded_at IS NOT NULL AND u.active AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL) AND (s.owner_ref=$3 OR NOT is_verification_test_account(s.owner_ref))`,[ref.id,communityId,v!.userId])).rows[0];
  requireCondition(row,404,'not_found','找不到來源。');
  return {...ref,title:String(row.title),path:`#showcase/${row.showcase_id}`,author:{user_id:row.owner_ref,display_name:row.display_name},audience:'community',version:digest(row)};
 }
 if(ref.kind==='squad_outcome'){
  requireCondition(z.uuid().safeParse(ref.id).success,404,'not_found','找不到來源。');
  const tenant=(await q.query('SELECT community_id FROM member_squad_outcomes WHERE outcome_id=$1',[ref.id])).rows[0];
  requireCondition(tenant?.community_id===communityId,404,'not_found','找不到來源。');
  const row=await readPublishedSquadOutcome(q,ref.id,v);
  return {...ref,title:row.title,path:v?`#squad-outcomes/${row.outcome_id}`:`/squad-outcomes/${row.outcome_id}`,author:row.author,audience:row.audience,version:digest(row)};
 }
 const book=communityCatalog.skill_books.find(b=>b.id===ref.id);
 if(book&&getSkillCollaboration(book.id))return {...ref,title:book.title,path:`/development/skills/${book.id}`,author:book.guide?.author_name?{user_id:null,display_name:book.guide.author_name}:null,author_role:'source_attribution',repository_url:book.repository_url,audience:'public',version:digest(book)};
 requireCondition(z.uuid().safeParse(ref.id).success,404,'not_found','找不到來源。');
 const row=(await q.query(`SELECT s.submission_id,s.owner_ref,u.display_name,(${publishedWorkPayload}) AS public_payload,s.aggregate_version,s.project_version_id,s.published_at,v.repository_url ${publishedWorkFrom} AND s.community_id=$1 AND s.submission_id=$2`,[communityId,ref.id])).rows[0];
 requireCondition(row,404,'not_found','找不到來源。');
 return {...ref,title:String(row.public_payload.title),path:publicPath(row.submission_id),author:{user_id:row.owner_ref,display_name:row.display_name},author_role:'submitter',relationship:row.public_payload.relationship,relationship_verification:'self_declared',repository_url:row.repository_url,audience:'public',version:digest(row)};
}
async function refs(q:Query,id:string):Promise<EventOutcomeRef[]>{return (await q.query('SELECT source_kind AS kind,source_id AS id FROM community_event_outcome_refs WHERE outcome_id=$1 ORDER BY ordinal',[id])).rows;}
async function rowById(q:Query,id:string,lock=false){const row=(await q.query(`SELECT o.*,u.display_name FROM community_event_outcomes o JOIN users u ON u.user_id=o.author_user_id WHERE o.outcome_id=$1${lock?' FOR UPDATE OF o':''}`,[z.uuid().parse(id)])).rows[0];requireCondition(row,404,'not_found','找不到這份活动成果。');return row;}
async function own(q:Query,actor:Actor,id:string,lock=false){const row=await rowById(q,id,lock);requireCondition(row.author_user_id===actor.user_id&&row.community_id===actor.community_id&&await member(q,viewerOf(actor)),404,'not_found','找不到這份活動成果。');return row;}
function dto(row:any,resolved:any[],mediaIds:string[]){const iso=(value:any)=>value?new Date(value).toISOString():null;return {outcome_id:row.outcome_id,event_id:row.event_id,title:row.title,summary:row.summary,audience:row.audience as 'public'|'community'|'guild',state:row.state as 'draft'|'published'|'withdrawn',aggregate_version:Number(row.aggregate_version),author:{user_id:row.author_user_id,display_name:row.display_name},refs:resolved.map(({version:_version,audience:_audience,...ref})=>ref),media_ids:mediaIds,consent_recorded_at:iso(row.consent_recorded_at),published_at:iso(row.published_at),withdrawn_at:iso(row.withdrawn_at),created_at:iso(row.created_at),updated_at:iso(row.updated_at)};}
async function media(q:Query,id:string){return (await q.query(`SELECT b.media_id FROM community_event_outcome_media b JOIN community_event_highlights h USING(media_id) WHERE b.outcome_id=$1 AND h.state='active' ORDER BY h.created_at,h.media_id`,[id])).rows.map(r=>String(r.media_id));}
async function shareable(q:Query,row:any,v:EventOutcomeViewer|null){
 requireCondition(row.state==='published',404,'not_found','找不到這份活動成果。');
 const e=await event(q,row.event_id,v);
 const author={communityId:row.community_id,userId:row.author_user_id};await event(q,row.event_id,author);
 requireCondition(!(await q.query('SELECT is_verification_test_account($1) AS hidden',[row.author_user_id])).rows[0].hidden||v?.userId===row.author_user_id,404,'not_found','找不到這份活動成果。');
 if(row.audience!=='public')requireCondition(v,404,'not_found','找不到這份活動成果。');
 if(row.audience==='guild'){
  requireCondition(e.guild_key&&v,404,'not_found','找不到這份活動成果。');
  const memberships=await q.query(`SELECT user_id FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=ANY($2::uuid[]) AND guild_key=$3 AND state='active'`,[row.community_id,[row.author_user_id,v!.userId],e.guild_key]);
  requireCondition(memberships.rows.some(member=>member.user_id===row.author_user_id)&&memberships.rows.some(member=>member.user_id===v!.userId),404,'not_found','找不到這份活動成果。');
 }
 requireCondition(row.audience!=='public'||['open','referral'].includes(e.visibility),404,'not_found','找不到這份活動成果。');
 const resolved=[];for(const ref of await refs(q,row.outcome_id))resolved.push(await source(q,ref,row.community_id,v));
 return {event:e,resolved,authorizationVersion:digest({row,event:e,viewer:v,refs:resolved})};
}
export async function readPublishedEventOutcome(q:Query,id:string,v:EventOutcomeViewer|null){
 const row=await rowById(q,id),readable=await shareable(q,row,v);
 const result=dto(row,readable.resolved,await media(q,id));
 const current=await shareable(q,await rowById(q,id),v);
 requireCondition(current.authorizationVersion===readable.authorizationVersion,404,'not_found','成果權限已變更。');
 return result;
}
export async function readOwnEventOutcome(q:Query,actor:Actor,id:string){const row=await own(q,actor,id);const resolved=[];for(const ref of await refs(q,id)){try{resolved.push(await source(q,ref,row.community_id,viewerOf(actor)));}catch(error){if(!(error instanceof Problem&&error.status===404))throw error;resolved.push({...ref,unavailable:true});}}return dto(row,resolved,await media(q,id));}
export async function listEventOutcomes(q:Query,eventId:string,v:EventOutcomeViewer|null){await event(q,eventId,v);const rows=(await q.query(`SELECT outcome_id FROM community_event_outcomes WHERE event_id=$1 AND state='published' ORDER BY created_at,outcome_id LIMIT 100`,[eventId])).rows;const items=[];for(const row of rows){try{items.push(await readPublishedEventOutcome(q,row.outcome_id,v));}catch(error){if(!(error instanceof Problem&&error.status===404))throw error;}}return {items};}
export async function listOwnEventOutcomes(q:Query,actor:Actor,eventId:string){requireCondition(await member(q,viewerOf(actor)),404,'not_found','找不到內容。');const rows=(await q.query('SELECT outcome_id FROM community_event_outcomes WHERE event_id=$1 AND community_id=$2 AND author_user_id=$3 ORDER BY created_at,outcome_id LIMIT 100',[z.uuid().parse(eventId),actor.community_id,actor.user_id])).rows;const items=[];for(const row of rows)items.push(await readOwnEventOutcome(q,actor,row.outcome_id));return {items};}
async function validateDraft(q:Query,actor:Actor,e:any,body:z.infer<typeof draftInput>){
 requireCondition(body.audience!=='public'||['open','referral'].includes(e.visibility),422,'outcome_audience_invalid','此活動不能公開成果。');
 requireCondition(body.audience!=='guild'||e.guild_key,422,'outcome_audience_invalid','此活動沒有指定公會。');
 if(body.audience==='guild')requireCondition((await q.query(`SELECT 1 FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=$2 AND guild_key=$3 AND state='active'`,[e.community_id,actor.user_id,e.guild_key])).rowCount===1,404,'not_found','找不到可發布的公會成果。');
 for(const ref of body.refs){
  const resolved=await source(q,ref,e.community_id,viewerOf(actor));
  if(body.audience==='public')await source(q,ref,e.community_id,null);
  if(body.audience==='community')requireCondition(['public','community'].includes(resolved.audience),422,'outcome_source_audience','來源不對全社群開放。');
 }
}
async function replaceRefs(q:Query,id:string,values:EventOutcomeRef[]){await q.query('DELETE FROM community_event_outcome_refs WHERE outcome_id=$1',[id]);for(const [index,ref] of values.entries())await q.query('INSERT INTO community_event_outcome_refs(outcome_id,ordinal,source_kind,source_id) VALUES($1,$2,$3,$4)',[id,index,ref.kind,ref.id]);}
// Mutation receipts contain authored data and source identities, never source title/path snapshots.
async function mutationResult(q:Query,actor:Actor,id:string){
 const row=await own(q,actor,id);
 return dto(row,await refs(q,id),await media(q,id));
}
export async function createEventOutcome(pool:Pool,input:Command,eventId:string){
 const body=draftInput.parse(input.body);
 return command(pool,input,q=>event(q,eventId,viewerOf(input.actor)),async q=>{
  const e=await event(q,eventId,viewerOf(input.actor),true);
  await validateDraft(q,input.actor,e,body);
  requireCondition(Number((await q.query('SELECT count(*) AS count FROM community_event_outcomes WHERE event_id=$1',[eventId])).rows[0].count)<100,409,'outcome_limit','此活動已達成果數量上限。');
  const id=randomUUID();
  await q.query('INSERT INTO community_event_outcomes(outcome_id,event_id,community_id,author_user_id,title,summary,audience) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,eventId,e.community_id,input.actor.user_id,body.title,body.summary,body.audience]);
  await replaceRefs(q,id,body.refs);
  await journal(q,input.actor,'event_outcome',id,1,'draft',{});
  return mutationResult(q,input.actor,id);
 });
}
export async function updateEventOutcome(pool:Pool,input:Command,id:string){
 const body=draftInput.parse(input.body);
 return command(pool,input,q=>own(q,input.actor,id),async q=>{
  const initial=await own(q,input.actor,id);
  const e=await event(q,initial.event_id,viewerOf(input.actor),true);
  const row=await own(q,input.actor,id,true);
  checkVersion(String(row.aggregate_version),input.expected);
  requireCondition(row.state!=='published',409,'withdraw_first','請先撤下再編輯。');
  await validateDraft(q,input.actor,e,body);
  await q.query(`UPDATE community_event_outcomes SET title=$2,summary=$3,audience=$4,state='draft',consent_recorded_at=NULL,published_at=NULL,withdrawn_at=NULL,aggregate_version=aggregate_version+1,updated_at=now() WHERE outcome_id=$1`,[id,body.title,body.summary,body.audience]);
  await replaceRefs(q,id,body.refs);
  await journal(q,input.actor,'event_outcome',id,Number(row.aggregate_version)+1,'update_draft',{});
  return mutationResult(q,input.actor,id);
 });
}
export async function publishEventOutcome(pool:Pool,input:Command,id:string){
 publishInput.parse(input.body);
 const authorize=async(q:Query)=>{
  const row=await own(q,input.actor,id);
  const e=await event(q,row.event_id,viewerOf(input.actor));
  await validateDraft(q,input.actor,e,{title:row.title,summary:row.summary,audience:row.audience,refs:await refs(q,id)});
 };
 return command(pool,input,authorize,async q=>{
  const initial=await own(q,input.actor,id);
  await event(q,initial.event_id,viewerOf(input.actor),true);
  const row=await own(q,input.actor,id,true);
  checkVersion(String(row.aggregate_version),input.expected);
  requireCondition(row.state!=='published',409,'already_published','成果已發布。');
  await authorize(q);
  await q.query(`UPDATE community_event_outcomes SET state='published',consent_recorded_at=now(),published_at=now(),withdrawn_at=NULL,aggregate_version=aggregate_version+1,updated_at=now() WHERE outcome_id=$1`,[id]);
  await journal(q,input.actor,'event_outcome',id,Number(row.aggregate_version)+1,'publish',{consent_to_share:true});
  return mutationResult(q,input.actor,id);
 },authorize);
}
export async function withdrawEventOutcome(pool:Pool,input:Command,id:string){
 z.object({}).strict().parse(input.body);
 return command(pool,input,q=>own(q,input.actor,id),async q=>{
  const initial=await own(q,input.actor,id);
  // Withdrawal remains available after event/source revocation.
  await q.query('SELECT event_id FROM community_events WHERE event_id=$1 FOR UPDATE',[initial.event_id]);
  const row=await own(q,input.actor,id,true);
  checkVersion(String(row.aggregate_version),input.expected);
  requireCondition(row.state!=='withdrawn',409,'already_withdrawn','成果已撤下。');
  await q.query(`UPDATE community_event_outcomes SET state='withdrawn',withdrawn_at=now(),aggregate_version=aggregate_version+1,updated_at=now() WHERE outcome_id=$1`,[id]);
  await journal(q,input.actor,'event_outcome',id,Number(row.aggregate_version)+1,'withdraw',{});
  return mutationResult(q,input.actor,id);
 });
}
export async function validateAndBindEventOutcomeMedia(q:Query,actor:Actor,eventId:string,entryId:string,mediaId:string){
 const e=await event(q,eventId,viewerOf(actor),true);
 const row=await own(q,actor,entryId,true);
 requireCondition(row.event_id===eventId&&row.state!=='withdrawn',404,'not_found','找不到可綁定的成果。');
 await validateDraft(q,actor,e,{title:row.title,summary:row.summary,audience:row.audience,refs:await refs(q,entryId)});
 const item=(await q.query(`SELECT 1 FROM community_event_highlights WHERE media_id=$1 AND event_id=$2 AND community_id=$3 AND uploader_user_id=$4 AND state='active' FOR UPDATE`,[z.uuid().parse(mediaId),eventId,actor.community_id,actor.user_id])).rows[0];
 requireCondition(item,404,'not_found','找不到可綁定的媒體。');
 requireCondition(Number((await q.query('SELECT count(*) AS count FROM community_event_outcome_media WHERE outcome_id=$1',[entryId])).rows[0].count)<30,409,'outcome_media_limit','成果媒體已達上限。');
 await q.query('INSERT INTO community_event_outcome_media(media_id,outcome_id,event_id,community_id,author_user_id) VALUES($1,$2,$3,$4,$5)',[mediaId,entryId,eventId,actor.community_id,actor.user_id]);
}
export async function readEventOutcomeMediaAuthorization(q:Query,mediaId:string,v:EventOutcomeViewer|null):Promise<{authorized:boolean;authorizationVersion:string}|null>{
 const binding=(await q.query('SELECT outcome_id FROM community_event_outcome_media WHERE media_id=$1',[mediaId])).rows[0];
 if(!binding)return null;
 try{
  const row=await rowById(q,binding.outcome_id);
  if(v&&row.state==='draft'&&v.userId===row.author_user_id&&v.communityId===row.community_id){
   const e=await event(q,row.event_id,v),resolved=[];
   for(const ref of await refs(q,row.outcome_id))resolved.push(await source(q,ref,row.community_id,v));
   return {authorized:true,authorizationVersion:digest({row,event:e,viewer:v,refs:resolved})};
  }
  const readable=await shareable(q,row,v);
  return {authorized:true,authorizationVersion:readable.authorizationVersion};
 }catch(error){
  if(!(error instanceof Problem&&error.status===404))throw error;
  return {authorized:false,authorizationVersion:`denied:${binding.outcome_id}`};
 }
}
export async function listEventOutcomeBacklinks(q:Query,ref:EventOutcomeRef,v:EventOutcomeViewer|null){
 ref=refInput.parse(ref);
 let communities:string[]|null=null;
 if(v)requireCondition(await member(q,v),404,'not_found','找不到來源。');
 if(ref.kind==='work'){
  requireCondition(v,404,'not_found','找不到來源。');
  await source(q,ref,v.communityId,v);
  communities=[v.communityId];
 }else if(ref.kind==='skill_book'&&communityCatalog.skill_books.some(book=>book.id===ref.id&&getSkillCollaboration(book.id))){
  communities=null;
 }else{
  const row=ref.kind==='squad_outcome'
   ?(await q.query('SELECT community_id FROM member_squad_outcomes WHERE outcome_id=$1',[z.uuid().parse(ref.id)])).rows[0]
   :(await q.query(`SELECT s.community_id ${publishedWorkFrom} AND s.submission_id=$1`,[z.uuid().parse(ref.id)])).rows[0];
  requireCondition(row,404,'not_found','找不到來源。');
  await source(q,ref,row.community_id,v?.communityId===row.community_id?v:null);
  communities=[row.community_id];
 }
 const rows=(await q.query(`SELECT o.outcome_id FROM community_event_outcome_refs r JOIN community_event_outcomes o USING(outcome_id) WHERE r.source_kind=$1 AND r.source_id=$2 AND ($3::uuid[] IS NULL OR o.community_id=ANY($3::uuid[])) AND o.state='published' ORDER BY o.created_at DESC,o.outcome_id LIMIT 100`,[ref.kind,ref.id,communities])).rows;
 const items=[];
 for(const row of rows){
  try{
   const entry=await rowById(q,row.outcome_id),reader=v?.communityId===entry.community_id?v:null,readable=await shareable(q,entry,reader);
   const current=await shareable(q,await rowById(q,row.outcome_id),reader);
   requireCondition(current.authorizationVersion===readable.authorizationVersion&&current.resolved.some(r=>r.kind===ref.kind&&r.id===ref.id),404,'not_found','成果權限已變更。');
   items.push({outcome_id:entry.outcome_id,event_id:entry.event_id,title:entry.title,event_title:readable.event.title,path:reader?`#highlights/${entry.event_id}`:`/highlights/${entry.event_id}`});
  }catch(error){
   if(!(error instanceof Problem&&error.status===404))throw error;
  }
 }
 return {items};
}
export async function listEventOutcomeReferences(q:Query,actor:Actor,eventId:string){const e=await event(q,eventId,viewerOf(actor));const candidates:EventOutcomeRef[]=[];for(const row of (await q.query(`SELECT showcase_id FROM showcases WHERE community_id=$1 AND status='published' ORDER BY created_at DESC LIMIT 30`,[e.community_id])).rows)candidates.push({kind:'work',id:row.showcase_id});for(const book of communityCatalog.skill_books)candidates.push({kind:'skill_book',id:book.id});for(const row of (await q.query(`SELECT submission_id FROM skill_submissions WHERE community_id=$1 AND status='published' ORDER BY published_at DESC LIMIT 30`,[e.community_id])).rows)candidates.push({kind:'skill_book',id:row.submission_id});for(const row of (await q.query(`SELECT outcome_id FROM member_squad_outcomes WHERE community_id=$1 AND state='published' ORDER BY published_at DESC LIMIT 30`,[e.community_id])).rows)candidates.push({kind:'squad_outcome',id:row.outcome_id});const items=[];for(const ref of candidates){try{const {version:_version,...resolved}=await source(q,ref,e.community_id,viewerOf(actor));items.push(resolved);}catch(error){if(!(error instanceof Problem&&error.status===404))throw error;}}return {items:items.slice(0,100)};}
