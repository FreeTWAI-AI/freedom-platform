import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { command,checkVersion,digest,journal,type Command } from '../../packages/db/index.js';
import { requireCondition } from '../../packages/shared/problem.js';
import { text,opaqueRef,money,currency,isoTime } from '../../packages/shared/validation.js';
import type { Actor } from '../identity-membership/service.js';

export const showcaseInput=z.object({title:text(120),description:text(2000),artifact_ref:opaqueRef,consent_to_share:z.literal(true)}).strict();
export const opportunityInput=z.object({showcase_id:z.uuid(),need:text(2000)}).strict();
export const engagementInput=z.object({scope:text(3000),acceptance_criteria:text(2000),amount_minor:money,currency}).strict();
export const receiptInput=z.object({amount_minor:money,currency,evidence_ref:opaqueRef,received_at:isoTime}).strict();
const termsInput=z.object({terms_sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();

export async function listShowcases(pool:Pool,actor:Actor) {
  return (await pool.query(`SELECT s.*,u.display_name AS owner_name FROM showcases s JOIN users u ON u.user_id=s.owner_ref
    WHERE s.community_id=$1 ORDER BY s.created_at DESC,s.showcase_id`,[actor.community_id])).rows;
}
export async function createShowcase(pool:Pool,input:Command) {
  const body=showcaseInput.parse(input.body);
  return command(pool,input,async()=>{},async q=>{
    const row=(await q.query(`INSERT INTO showcases(showcase_id,community_id,owner_ref,title,description,artifact_ref)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[randomUUID(),input.actor.community_id,input.actor.user_id,body.title,body.description,body.artifact_ref])).rows[0];
    await journal(q,input.actor,'showcase',row.showcase_id,1,'share_with_community',{artifact_ref:body.artifact_ref});
    return {...row,owner_name:input.actor.display_name};
  });
}
async function visibleShowcase(q:PoolClient,actor:Actor,id:string) {
  const row=(await q.query('SELECT * FROM showcases WHERE showcase_id=$1 AND community_id=$2',[id,actor.community_id])).rows[0];
  requireCondition(row,404,'not_found','找不到這件作品。');return row;
}
export async function createOpportunity(pool:Pool,input:Command) {
  const body=opportunityInput.parse(input.body);
  return command(pool,input,q=>visibleShowcase(q,input.actor,body.showcase_id),async q=>{
    const showcase=await visibleShowcase(q,input.actor,body.showcase_id);
    requireCondition(showcase.owner_ref!==input.actor.user_id,403,'self_opportunity','請向另一位成員的作品提出合作需求。');
    const row=(await q.query(`INSERT INTO opportunities(opportunity_id,community_id,showcase_id,provider_ref,client_ref,need)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[randomUUID(),input.actor.community_id,showcase.showcase_id,showcase.owner_ref,input.actor.user_id,body.need])).rows[0];
    await journal(q,input.actor,'opportunity',row.opportunity_id,1,'raise_need',{showcase_id:showcase.showcase_id});return row;
  });
}
export async function listOpportunities(pool:Pool,actor:Actor) {
  return (await pool.query(`SELECT o.*,s.title AS showcase_title,p.display_name AS provider_name,c.display_name AS client_name
    FROM opportunities o JOIN showcases s USING(showcase_id) JOIN users p ON p.user_id=o.provider_ref JOIN users c ON c.user_id=o.client_ref
    WHERE o.community_id=$1 AND ($2=o.provider_ref OR $2=o.client_ref) ORDER BY o.created_at DESC`,[actor.community_id,actor.user_id])).rows;
}
async function scopedOpportunity(q:PoolClient,actor:Actor,id:string,lock=false) {
  const row=(await q.query(`SELECT * FROM opportunities WHERE opportunity_id=$1 AND community_id=$2 AND provider_ref=$3${lock?' FOR UPDATE':''}`,[id,actor.community_id,actor.user_id])).rows[0];
  requireCondition(row,404,'not_found','找不到可由你提案的商機。');return row;
}
export async function proposeEngagement(pool:Pool,input:Command,id:string) {
  const body=engagementInput.parse(input.body);
  return command(pool,input,q=>scopedOpportunity(q,input.actor,id),async q=>{
    const opportunity=await scopedOpportunity(q,input.actor,id,true);checkVersion(opportunity.aggregate_version,input.expected);
    requireCondition(opportunity.state==='open',409,'invalid_state','這個商機已有合作提案。');
    const engagementId=randomUUID();
    const terms={engagement_id:engagementId,provider_ref:opportunity.provider_ref,client_ref:opportunity.client_ref,...body};
    const row=(await q.query(`INSERT INTO engagements(engagement_id,community_id,opportunity_id,provider_ref,client_ref,scope,acceptance_criteria,amount_minor,currency,terms_sha256)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[engagementId,input.actor.community_id,id,opportunity.provider_ref,opportunity.client_ref,body.scope,body.acceptance_criteria,body.amount_minor,body.currency,digest(terms)])).rows[0];
    const version=(await q.query("UPDATE opportunities SET state='proposed',aggregate_version=aggregate_version+1 WHERE opportunity_id=$1 RETURNING aggregate_version",[id])).rows[0].aggregate_version;
    await journal(q,input.actor,'opportunity',id,version,'propose_cooperation',{engagement_id:engagementId});
    await journal(q,input.actor,'engagement',engagementId,1,'propose',{terms_sha256:row.terms_sha256});return {...row,receipt:null};
  });
}
export async function listEngagements(pool:Pool,actor:Actor) {
  return (await pool.query(`SELECT e.*,p.display_name AS provider_name,c.display_name AS client_name,
    CASE WHEN r.receipt_id IS NULL THEN NULL ELSE jsonb_build_object('receipt_id',r.receipt_id,'amount_minor',r.amount_minor::text,'currency',r.currency,
    'evidence_ref',r.evidence_ref,'received_at',r.received_at,'verification_status',r.verification_status) END AS receipt
    FROM engagements e JOIN users p ON p.user_id=e.provider_ref JOIN users c ON c.user_id=e.client_ref
    LEFT JOIN receipt_observations r USING(engagement_id)
    WHERE e.community_id=$1 AND ($2=e.provider_ref OR $2=e.client_ref) ORDER BY e.created_at DESC`,[actor.community_id,actor.user_id])).rows;
}
async function scopedEngagement(q:PoolClient,actor:Actor,id:string,role:'client'|'provider',lock=false) {
  const column=role==='client'?'client_ref':'provider_ref';
  const row=(await q.query(`SELECT * FROM engagements WHERE engagement_id=$1 AND community_id=$2 AND ${column}=$3${lock?' FOR UPDATE':''}`,[id,actor.community_id,actor.user_id])).rows[0];
  requireCondition(row,404,'not_found','找不到可由你操作的合作。');return row;
}
export async function changeEngagement(pool:Pool,input:Command,id:string,action:'agree'|'deliver'|'accept'|'receipt'|'confirm-receipt') {
  const body=action==='agree'||action==='accept'?termsInput.parse(input.body):action==='deliver'?z.object({artifact_ref:opaqueRef}).strict().parse(input.body):action==='receipt'?receiptInput.parse(input.body):z.object({}).strict().parse(input.body);
  const role=action==='deliver'||action==='receipt'?'provider':'client';
  return command(pool,input,q=>scopedEngagement(q,input.actor,id,role),async q=>{
    const row=await scopedEngagement(q,input.actor,id,role,true);checkVersion(row.aggregate_version,input.expected);
    if(action==='agree'||action==='accept') {
      const data=body as z.infer<typeof termsInput>;
      requireCondition(data.terms_sha256===row.terms_sha256,409,'terms_changed','合作條款已變更，請重新閱讀。');
      requireCondition(row.state===(action==='agree'?'proposed':'delivered'),409,'invalid_state','合作目前無法執行這個動作。');
      const timestamp=action==='agree'?'agreed_at':'accepted_at';
      await q.query(`UPDATE engagements SET state=$2,${timestamp}=now(),aggregate_version=aggregate_version+1 WHERE engagement_id=$1`,[id,action==='agree'?'agreed':'accepted']);
    } else if(action==='deliver') {
      requireCondition(row.state==='agreed',409,'invalid_state','請等對方確認合作條款。');
      await q.query("UPDATE engagements SET state='delivered',delivery_ref=$2,aggregate_version=aggregate_version+1 WHERE engagement_id=$1",[id,(body as {artifact_ref:string}).artifact_ref]);
    } else if(action==='receipt') {
      const data=body as z.infer<typeof receiptInput>;
      requireCondition(row.state==='accepted',409,'invalid_state','本機驗證流程請先完成交付驗收，再記錄收款回報。');
      requireCondition(String(data.amount_minor)===row.amount_minor && data.currency===row.currency,422,'receipt_amount_mismatch','此版本只支援與合作條款一致的一次全額收款回報。');
      requireCondition(Date.parse(data.received_at)<=Date.now() && Date.parse(data.received_at)>=new Date(row.agreed_at).getTime(),422,'invalid_receipt_time','收款時間須在確認合作之後，且不能在未來。');
      const exists=await q.query('SELECT 1 FROM receipt_observations WHERE engagement_id=$1 OR (reporter_ref=$2 AND evidence_ref=$3)',[id,input.actor.user_id,data.evidence_ref]);
      requireCondition(!exists.rowCount,409,'receipt_exists','此合作或證據已有收款回報，請重新整理查看。');
      await q.query('INSERT INTO receipt_observations(receipt_id,engagement_id,reporter_ref,amount_minor,currency,evidence_ref,received_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),id,input.actor.user_id,data.amount_minor,data.currency,data.evidence_ref,data.received_at]);
      await q.query('UPDATE engagements SET aggregate_version=aggregate_version+1 WHERE engagement_id=$1',[id]);
    } else {
      const receipt=(await q.query('SELECT * FROM receipt_observations WHERE engagement_id=$1 FOR UPDATE',[id])).rows[0];
      requireCondition(receipt && receipt.verification_status==='self_reported',409,'invalid_state','目前沒有待你確認的收款回報。');
      await q.query("UPDATE receipt_observations SET verification_status='counterparty_confirmed',confirmed_by=$2,confirmed_at=now() WHERE engagement_id=$1",[id,input.actor.user_id]);
      await q.query('UPDATE engagements SET aggregate_version=aggregate_version+1 WHERE engagement_id=$1',[id]);
    }
    const updated=(await q.query('SELECT * FROM engagements WHERE engagement_id=$1',[id])).rows[0];
    await journal(q,input.actor,'engagement',id,updated.aggregate_version,action,{terms_sha256:updated.terms_sha256});
    const receipt=(await q.query('SELECT receipt_id,amount_minor,currency,evidence_ref,received_at,verification_status FROM receipt_observations WHERE engagement_id=$1',[id])).rows[0]??null;
    return {...updated,receipt};
  });
}
