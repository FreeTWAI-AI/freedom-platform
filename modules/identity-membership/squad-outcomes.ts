import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {z} from 'zod';
import {command,checkVersion,journal,type Command} from '../../packages/db/index.js';
import {requireCondition} from '../../packages/shared/problem.js';
import {externalLink} from '../opensource-marketing/github.js';
import type {Actor} from './service.js';
import {privateHost} from './social-links.js';

type Query=Pick<Pool,'query'>;
export type SquadOutcomeViewer={communityId:string;userId:string};
export type SquadOutcome={outcome_id:string;squad_id:string;squad_name:string;title:string;summary:string;artifact_url:string|null;author:{user_id:string;display_name:string};audience:'squad'|'community'|'public';state:'draft'|'published'|'withdrawn';aggregate_version:number;created_at:string;updated_at:string;published_at:string|null;withdrawn_at:string|null;consent_recorded_at:string|null};
const artifactUrl=z.string().refine(v=>!/[\x00-\x1f\x7f]/.test(v),'網址不可包含控制字元。').pipe(externalLink).refine(v=>!privateHost(new URL(v).hostname),'請使用公開 HTTPS 網址。');
export const SquadOutcomeDraftInput=z.object({title:z.string().trim().min(1).max(120).refine(v=>!/[\x00-\x1f\x7f]/.test(v)),summary:z.string().trim().min(1).max(4000).refine(v=>!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v)),artifact_url:artifactUrl.nullable().default(null)}).strict();
// This domain consent covers sharing the squad name, authorship, and rights/person
// permission for the supplied text/link where relevant; it is not formal #261 policy.
export const SquadOutcomePublishInput=z.object({audience:z.enum(['squad','community','public']),consent_to_share:z.literal(true)}).strict();
const Pagination=z.object({limit:z.coerce.number().int().min(1).max(50).default(20),offset:z.coerce.number().int().min(0).max(10000).default(0)}).strict();
const idOf=(id:string)=>{requireCondition(z.uuid().safeParse(id).success,404,'squad_outcome_not_found','找不到這項小隊成果。');return id.toLowerCase();};
const missing=(row:unknown)=>requireCondition(row,404,'squad_outcome_not_found','找不到這項小隊成果。');
const selection=`SELECT o.*,s.name AS squad_name,u.display_name AS author_name FROM member_squad_outcomes o
 JOIN member_squads s ON s.squad_id=o.squad_id AND s.community_id=o.community_id
 JOIN users u ON u.user_id=o.author_ref AND u.community_id=o.community_id`;
const publishedAcl=`o.state='published' AND o.consent_recorded_at IS NOT NULL
 AND s.owner_ref=o.author_ref AND u.active AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL)
 AND EXISTS(SELECT 1 FROM member_squad_memberships m WHERE m.squad_id=s.squad_id AND m.user_id=u.user_id AND m.state='active')
 AND EXISTS(SELECT 1 FROM member_squad_classification sc WHERE sc.squad_id=s.squad_id AND sc.community_id=o.community_id AND (NOT sc.is_test_data OR u.user_id=$3))
 AND (NOT is_verification_test_account(u.user_id) OR u.user_id=$3)
 AND (($2::uuid IS NULL AND o.audience='public') OR ($2=o.community_id
 AND EXISTS(SELECT 1 FROM users v WHERE v.user_id=$3 AND v.community_id=$2 AND v.active AND (NOT v.onboarding_required OR v.onboarding_completed_at IS NOT NULL))
 AND (o.audience IN ('public','community') OR EXISTS(SELECT 1 FROM member_squad_memberships vm WHERE vm.squad_id=s.squad_id AND vm.user_id=$3 AND vm.state='active'))))`;
function dto(row:any):SquadOutcome {
 const time=(v:any)=>v===null?null:new Date(v).toISOString();
 return {outcome_id:row.outcome_id,squad_id:row.squad_id,squad_name:row.squad_name,title:row.title,summary:row.summary,artifact_url:row.artifact_url,author:{user_id:row.author_ref,display_name:row.author_name},audience:row.audience,state:row.state,aggregate_version:Number(row.aggregate_version),created_at:time(row.created_at)!,updated_at:time(row.updated_at)!,published_at:time(row.published_at),withdrawn_at:time(row.withdrawn_at),consent_recorded_at:time(row.consent_recorded_at)};
}
async function eligibleViewer(q:Query,actor:Actor) {
 const row=(await q.query(`SELECT user_id FROM users WHERE user_id=$1 AND community_id=$2 AND active AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL)`,[actor.user_id,actor.community_id])).rows[0];missing(row);
}
export async function readPublishedSquadOutcome(q:Query,id:string,viewer:SquadOutcomeViewer|null):Promise<SquadOutcome> {
 const row=(await q.query(`${selection} WHERE o.outcome_id=$1 AND ${publishedAcl}`,[idOf(id),viewer?.communityId??null,viewer?.userId??null])).rows[0];missing(row);return dto(row);
}
export async function readOwnSquadOutcome(q:Query,actor:Actor,id:string):Promise<SquadOutcome> {
 await eligibleViewer(q,actor);
 const row=(await q.query(`${selection} WHERE o.outcome_id=$1 AND o.community_id=$2 AND o.author_ref=$3`,[idOf(id),actor.community_id,actor.user_id])).rows[0];missing(row);return dto(row);
}
export async function readSquadOutcome(q:Query,actor:Actor,id:string):Promise<SquadOutcome> {
 await eligibleViewer(q,actor);
 const row=(await q.query(`${selection} WHERE o.outcome_id=$1 AND o.community_id=$2 AND (o.author_ref=$3 OR (${publishedAcl}))`,[idOf(id),actor.community_id,actor.user_id])).rows[0];missing(row);return dto(row);
}
export async function listSquadOutcomes(q:Query,actor:Actor,squadId:string,query:unknown={}) {
 await eligibleViewer(q,actor);const {limit,offset}=Pagination.parse(query);
 const rows=(await q.query(`${selection} WHERE o.squad_id=$1 AND o.community_id=$2 AND (o.author_ref=$3 OR (${publishedAcl})) ORDER BY o.created_at DESC,o.outcome_id LIMIT $4 OFFSET $5`,[idOf(squadId),actor.community_id,actor.user_id,limit+1,offset])).rows;
 return {items:rows.slice(0,limit).map(dto),next_offset:rows.length>limit?offset+limit:null};
}
export async function listOwnSquadOutcomes(q:Query,actor:Actor,query:unknown={}) {
 await eligibleViewer(q,actor);const {limit,offset}=Pagination.parse(query);
 const rows=(await q.query(`${selection} WHERE o.community_id=$1 AND o.author_ref=$2 ORDER BY o.created_at DESC,o.outcome_id LIMIT $3 OFFSET $4`,[actor.community_id,actor.user_id,limit+1,offset])).rows;
 return {items:rows.slice(0,limit).map(dto),next_offset:rows.length>limit?offset+limit:null};
}
async function lockOwner(q:Query,actor:Actor,squadId:string) {
 await eligibleViewer(q,actor);
 await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`squad-outcomes/${squadId}`]);
 const squad=(await q.query(`SELECT * FROM member_squads WHERE squad_id=$1 AND community_id=$2 FOR UPDATE`,[squadId,actor.community_id])).rows[0];missing(squad);
 requireCondition(squad.owner_ref===actor.user_id,403,'squad_owner_required','只有目前隊主可以建立或發布自己的小隊成果。');
 const membership=(await q.query(`SELECT user_id FROM member_squad_memberships WHERE squad_id=$1 AND user_id=$2 AND state='active' FOR SHARE`,[squadId,actor.user_id])).rows[0];missing(membership);
 const classification=(await q.query(`SELECT squad_id FROM member_squad_classification WHERE squad_id=$1 AND community_id=$2`,[squadId,actor.community_id])).rows[0];missing(classification);
 return squad;
}
async function owned(q:Query,actor:Actor,id:string,lock=false) {
 const row=(await q.query(`SELECT * FROM member_squad_outcomes WHERE outcome_id=$1 AND community_id=$2 AND author_ref=$3${lock?' FOR UPDATE':''}`,[id,actor.community_id,actor.user_id])).rows[0];missing(row);return row;
}
const normalized=(input:Command)=>({...input,operation:input.operation.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,id=>id.toLowerCase())});
export async function createSquadOutcomeDraft(pool:Pool,input:Command,squadId:string) {
 squadId=idOf(squadId);const body=SquadOutcomeDraftInput.parse(input.body);
 return command(pool,normalized(input),q=>lockOwner(q,input.actor,squadId),async q=>{
  const id=randomUUID();await q.query(`INSERT INTO member_squad_outcomes(outcome_id,squad_id,community_id,author_ref,title,summary,artifact_url) VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,squadId,input.actor.community_id,input.actor.user_id,body.title,body.summary,body.artifact_url]);
  await journal(q,input.actor,'squad_outcome',id,1,'save_draft',{squad_id:squadId});return readOwnSquadOutcome(q,input.actor,id);
 });
}
async function mutate(pool:Pool,input:Command,id:string,action:'edit'|'publish'|'withdraw') {
 id=idOf(id);const body=action==='edit'?SquadOutcomeDraftInput.parse(input.body):action==='publish'?SquadOutcomePublishInput.parse(input.body):z.object({}).strict().parse(input.body);
 return command(pool,normalized(input),async q=>{
  await eligibleViewer(q,input.actor);
  const row=await owned(q,input.actor,id);
  if(action!=='withdraw')await lockOwner(q,input.actor,row.squad_id);
 },async q=>{
  const row=await owned(q,input.actor,id,true);checkVersion(String(row.aggregate_version),input.expected);
  if(action==='edit') {
   requireCondition(row.state!=='published',409,'squad_outcome_not_editable','請先撤回已發布的成果再修改。');
   const draft=body as z.infer<typeof SquadOutcomeDraftInput>;
   await q.query(`UPDATE member_squad_outcomes SET title=$2,summary=$3,artifact_url=$4,state='draft',audience='squad',consent_recorded_at=NULL,published_at=NULL,withdrawn_at=NULL,aggregate_version=aggregate_version+1,updated_at=now() WHERE outcome_id=$1`,[id,draft.title,draft.summary,draft.artifact_url]);
  } else if(action==='publish') {
   requireCondition(row.state!=='published',409,'squad_outcome_already_published','這項成果已發布。');
   await q.query(`UPDATE member_squad_outcomes SET state='published',audience=$2,consent_recorded_at=now(),published_at=now(),withdrawn_at=NULL,aggregate_version=aggregate_version+1,updated_at=now() WHERE outcome_id=$1`,[id,(body as z.infer<typeof SquadOutcomePublishInput>).audience]);
  } else {
   requireCondition(row.state!=='withdrawn',409,'squad_outcome_withdrawn','這項成果已撤回。');
   await q.query(`UPDATE member_squad_outcomes SET state='withdrawn',withdrawn_at=now(),aggregate_version=aggregate_version+1,updated_at=now() WHERE outcome_id=$1`,[id]);
  }
  const result=await readOwnSquadOutcome(q,input.actor,id);
  await journal(q,input.actor,'squad_outcome',id,result.aggregate_version,action==='edit'?'save_draft':action,{squad_id:row.squad_id,...(action==='publish'?{audience:result.audience,consent_to_share:true}:{})});return result;
 });
}
export const updateOwnSquadOutcome=(pool:Pool,input:Command,id:string)=>mutate(pool,input,id,'edit');
export const publishOwnSquadOutcome=(pool:Pool,input:Command,id:string)=>mutate(pool,input,id,'publish');
export const withdrawOwnSquadOutcome=(pool:Pool,input:Command,id:string)=>mutate(pool,input,id,'withdraw');
