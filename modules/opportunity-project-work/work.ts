import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { command, checkVersion, digest, journal, type Command } from '../../packages/db/index.js';
import { requireCondition } from '../../packages/shared/problem.js';
import { text, opaqueRef, isoTime } from '../../packages/shared/validation.js';
import type { Actor } from '../identity-membership/service.js';

export const createWorkInput = z.object({
  title:text(120),objective:text(1000),acceptance_criteria:text(1000),gain:text(500),
  estimated_minutes:z.number().int().min(5).max(480),maximum_minutes:z.number().int().min(5).max(480),
  claim_by:isoTime,finish_by:isoTime,will_review:z.boolean()
}).strict().refine(v=>v.estimated_minutes<=v.maximum_minutes,'預估投入不能超過最大投入。')
  .refine(v=>Date.parse(v.finish_by)>Date.parse(v.claim_by),'完成期限須在認領期限之後。');
export const claimInput = z.object({claimant_type:z.literal('user'),acting_profession_membership_ref:z.uuid(),
  expected_aggregate_version:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),terms_status:z.literal('declared'),
  participation_terms_revision:z.number().int().positive(),participation_terms_sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const submitInput = z.object({summary:text(4000),artifact_ref:opaqueRef}).strict();
export const decideInput = z.object({decision:z.enum(['accept','changes_requested']),feedback:text(2000),submission_sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();

export function voluntaryTerms(input: z.infer<typeof createWorkInput>, actor: Actor) {
  return {
    schema_version:'freedom.work-participation/v1',participation_mode:'voluntary_contribution',
    beneficiary:{party_ref:actor.user_id,problem:input.objective,intended_gain:input.acceptance_criteria},
    contributor_gain:{kind:'voluntary_public_good',description:input.gain,assurance:'aspirational',resource_refs:[]},
    effort:{estimated_minutes:input.estimated_minutes,maximum_minutes:input.maximum_minutes},shared_goal_ref:null,
    human_support:{promised:false,reservation_ref:null,scope:'不保證真人回饋，不自動轉派核心團隊。',no_capacity_fallback:'self_service'},
    completion:{criteria:[input.acceptance_criteria],claim_by:input.claim_by,finish_by:input.finish_by,
      feedback_due:new Date(Date.parse(input.finish_by)+7*86400000).toISOString(),unanswered_outcome:'expire_unclaimed'},
    reuse:{visibility:'community',artifact_license_ref:'local-demo-author-consent',consent_required:true},funding:null,newcomer_friendly:true
  };
}
export async function createWork(pool: Pool, input: Command) {
  const body=createWorkInput.parse(input.body);
  return command(pool,input,async()=>{},async q=>{
    // Eligibility is evaluated only for a new command, never against an already committed replay.
    requireCondition(Date.parse(body.claim_by)>Date.now(),422,'claim_deadline_in_past','認領期限須在未來。');
    const workId=randomUUID(), terms=voluntaryTerms(body,input.actor);
    const row=(await q.query(`INSERT INTO work_items(work_item_id,community_id,owner_ref,title,objective,acceptance_criteria,gain,state,participation_terms,participation_terms_sha256,claim_window_expires_at,due_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'open',$8,$9,$10,$11) RETURNING *`,[workId,input.actor.community_id,input.actor.user_id,body.title,body.objective,body.acceptance_criteria,body.gain,terms,digest(terms),body.claim_by,body.finish_by])).rows[0];
    if(body.will_review) await q.query('INSERT INTO work_review_routes(work_item_id,reviewer_ref,valid_until) VALUES($1,$2,$3)',[workId,input.actor.user_id,terms.completion.feedback_due]);
    await journal(q,input.actor,'work_item',workId,1,'open',{title:body.title},'freedom.work.item.opened.v1');
    return workView(row,body.will_review,null);
  });
}
function workView(row:any,reviewAvailable:boolean,myClaim:any) {
  return {...row,terms_status:'declared',review_capacity:reviewAvailable?'available':'waiting_reviewer_capacity',my_claim:myClaim};
}
async function claimView(q: Pick<PoolClient,'query'>, claim:any) {
  if(!claim)return null;
  const submission=(await q.query('SELECT submission_id,summary,artifact_ref,sha256,revision FROM submissions WHERE claim_id=$1 ORDER BY revision DESC LIMIT 1',[claim.claim_id])).rows[0]??null;
  return {claim_id:claim.claim_id,work_item_id:claim.work_item_id,claimant_ref:claim.claimant_ref,claimant_type:'user',
    acting_profession_membership_ref:claim.acting_profession_membership_ref,state:claim.state,aggregate_version:claim.aggregate_version,
    terms_status:'declared',participation_terms_revision:claim.terms_revision,participation_terms_sha256:claim.terms_sha256,
    latest_submission:submission,feedback:claim.feedback};
}
export async function listWorks(pool: Pool, actor: Actor) {
  const rows=(await pool.query(`SELECT w.*, EXISTS(SELECT 1 FROM work_review_routes r WHERE r.work_item_id=w.work_item_id AND r.revoked_at IS NULL AND r.valid_until>now()) AS review_available
    FROM work_items w WHERE community_id=$1 ORDER BY created_at DESC,work_item_id`,[actor.community_id])).rows;
  return Promise.all(rows.map(async row=>{
    const own=(await pool.query('SELECT * FROM work_claims WHERE work_item_id=$1 AND claimant_ref=$2',[row.work_item_id,actor.user_id])).rows[0];
    const {review_available,...work}=row;return workView(work,review_available,await claimView(pool,own));
  }));
}
async function scopedWork(q:PoolClient, actor:Actor,id:string,lock=false) {
  const row=(await q.query(`SELECT * FROM work_items WHERE work_item_id=$1 AND community_id=$2${lock?' FOR UPDATE':''}`,[id,actor.community_id])).rows[0];
  requireCondition(row,404,'not_found','找不到這個工作。');return row;
}
export async function claimWork(pool:Pool,input:Command,id:string) {
  const body=claimInput.parse(input.body);
  requireCondition(body.acting_profession_membership_ref===input.actor.profession_membership_ref,403,'wrong_profession','只能以自己的職業身分認領。');
  requireCondition(String(body.expected_aggregate_version)===input.expected,400,'version_header_mismatch','版本欄位與 If-Match 不一致。');
  return command(pool,input,q=>scopedWork(q,input.actor,id),async q=>{
    const work=await scopedWork(q,input.actor,id,true);checkVersion(work.aggregate_version,input.expected);
    requireCondition(work.owner_ref!==input.actor.user_id,403,'self_claim','請由另一位成員協作這件工作。');
    requireCondition(work.state==='open',409,'claim_unavailable','這件工作已被認領。');
    requireCondition(new Date(work.claim_window_expires_at).getTime()>Date.now(),409,'claim_window_closed','認領期限已過。');
    requireCondition(body.participation_terms_revision===work.participation_terms_revision && body.participation_terms_sha256===work.participation_terms_sha256,409,'terms_changed','參與條款已更新，請重新閱讀。');
    const claim=(await q.query(`INSERT INTO work_claims(claim_id,work_item_id,claimant_ref,acting_profession_membership_ref,state,terms_revision,terms_sha256,terms_snapshot)
      VALUES($1,$2,$3,$4,'claimed',$5,$6,$7) RETURNING *`,[randomUUID(),id,input.actor.user_id,input.actor.profession_membership_ref,work.participation_terms_revision,work.participation_terms_sha256,work.participation_terms])).rows[0];
    const version=(await q.query("UPDATE work_items SET state='claiming_closed',aggregate_version=aggregate_version+1 WHERE work_item_id=$1 RETURNING aggregate_version",[id])).rows[0].aggregate_version;
    await journal(q,input.actor,'work_item',id,version,'add_exclusive_claim_atomically',{claim_id:claim.claim_id});
    await journal(q,input.actor,'work_claim',claim.claim_id,1,'claim',{work_item_id:id},'freedom.work.item.claimed.v1');
    const {latest_submission,feedback,...canonicalClaim}=(await claimView(q,claim))!;
    return canonicalClaim;
  });
}
async function scopedClaim(q:PoolClient,actor:Actor,id:string,review:boolean,lock=false) {
  const claim=(await q.query(`SELECT c.* FROM work_claims c JOIN work_items w USING(work_item_id)
    WHERE c.claim_id=$1 AND w.community_id=$2${lock?' FOR UPDATE OF c':''}`,[id,actor.community_id])).rows[0];
  requireCondition(claim,404,'not_found','找不到這次認領。');
  if(review) {
    requireCondition(claim.claimant_ref!==actor.user_id,403,'self_review','不能驗收自己的成果。');
    const route=await q.query(`SELECT 1 FROM work_review_routes WHERE work_item_id=$1 AND reviewer_ref=$2 AND revoked_at IS NULL AND valid_until>now() FOR SHARE`,[claim.work_item_id,actor.user_id]);
    requireCondition(route.rowCount===1,403,'review_authority_required','你沒有這件工作的有效驗收安排。');
  } else requireCondition(claim.claimant_ref===actor.user_id,403,'claim_owner_required','只能操作自己的認領。');
  return claim;
}
export async function changeClaim(pool:Pool,input:Command,id:string,action:'start'|'submit'|'begin-review'|'decide') {
  const body=action==='submit'?submitInput.parse(input.body):action==='decide'?decideInput.parse(input.body):z.object({}).strict().parse(input.body);
  const reviewing=action==='begin-review'||action==='decide';
  return command(pool,input,q=>scopedClaim(q,input.actor,id,reviewing),async q=>{
    const claim=await scopedClaim(q,input.actor,id,reviewing,true);checkVersion(claim.aggregate_version,input.expected);
    const view=await claimView(q,claim);let next='',event:string|undefined;let feedback=claim.feedback;
    if(action==='start') { requireCondition(claim.state==='claimed',409,'invalid_state','這件工作目前無法開始。');next='in_progress'; }
    if(action==='submit') {
      requireCondition(['in_progress','changes_requested'].includes(claim.state),409,'invalid_state','請先開始工作或完成補件。');
      const data=body as z.infer<typeof submitInput>,revision=(view?.latest_submission?.revision??0)+1;
      await q.query('INSERT INTO submissions(submission_id,claim_id,revision,summary,artifact_ref,sha256) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),id,revision,data.summary,data.artifact_ref,digest({claim_id:id,revision,...data})]);
      next='submitted';feedback=null;event='freedom.work.submission.created.v1';
    }
    if(action==='begin-review') { requireCondition(claim.state==='submitted',409,'invalid_state','只有已提交的成果可以開始驗收。');next='in_review'; }
    if(action==='decide') {
      const data=body as z.infer<typeof decideInput>,submission=view?.latest_submission;
      requireCondition(claim.state==='in_review' && submission,409,'invalid_state','請先開始驗收。');
      requireCondition(data.submission_sha256===submission.sha256,409,'submission_changed','成果版本已變更，請重新閱讀。');
      const decisionId=randomUUID();
      await q.query('INSERT INTO work_decisions(decision_id,claim_id,submission_id,reviewer_ref,decision,feedback,submission_sha256) VALUES($1,$2,$3,$4,$5,$6,$7)',[decisionId,id,submission.submission_id,input.actor.user_id,data.decision,data.feedback,submission.sha256]);
      next=data.decision==='accept'?'accepted':'changes_requested';feedback=data.feedback;
      if(next==='accepted') {
        const work=(await q.query("UPDATE work_items SET state='accepted',aggregate_version=aggregate_version+1 WHERE work_item_id=$1 RETURNING *",[claim.work_item_id])).rows[0];
        await q.query('INSERT INTO contributions(contribution_id,claim_id,user_id,community_id,work_item_id,decision_id,title,summary,artifact_ref) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[randomUUID(),id,claim.claimant_ref,input.actor.community_id,claim.work_item_id,decisionId,work.title,submission.summary,submission.artifact_ref]);
        await journal(q,input.actor,'work_item',work.work_item_id,work.aggregate_version,'apply_accepted_result_policy',{claim_id:id});
        event='freedom.work.submission.accepted.v1';
      }
    }
    const updated=(await q.query('UPDATE work_claims SET state=$2,feedback=$3,aggregate_version=aggregate_version+1 WHERE claim_id=$1 RETURNING *',[id,next,feedback])).rows[0];
    await journal(q,input.actor,'work_claim',id,updated.aggregate_version,action,{state:next},event);
    return claimView(q,updated);
  });
}
export async function dashboard(pool:Pool,actor:Actor) {
  const works=await listWorks(pool,actor);
  const gained=(await pool.query('SELECT contribution_id,work_item_id,title,summary,artifact_ref,accepted_at,official FROM contributions WHERE community_id=$1 AND user_id=$2 ORDER BY accepted_at DESC',[actor.community_id,actor.user_id])).rows;
  const reviewClaims=(await pool.query(`SELECT c.*,u.display_name AS claimant_name FROM work_claims c JOIN work_items w USING(work_item_id)
    JOIN work_review_routes r USING(work_item_id) JOIN users u ON u.user_id=c.claimant_ref
    WHERE w.community_id=$1 AND r.reviewer_ref=$2 AND r.revoked_at IS NULL AND r.valid_until>now()
    AND c.claimant_ref<>$2 AND c.state IN ('submitted','in_review') ORDER BY c.created_at`,[actor.community_id,actor.user_id])).rows;
  return {now:works.filter(w=>w.my_claim && w.my_claim.state!=='accepted'),next:works.filter(w=>w.state==='open'),gained,
    review_queue:await Promise.all(reviewClaims.map(async c=>({claim:await claimView(pool,c),work_item:works.find(w=>w.work_item_id===c.work_item_id),claimant_name:c.claimant_name}))),summary:{accepted_count:gained.length}};
}
