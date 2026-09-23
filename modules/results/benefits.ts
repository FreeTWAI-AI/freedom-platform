import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Pool,PoolClient} from 'pg';
import type {Actor} from '../identity-membership/service.js';
import {command,checkVersion,journal,type Command} from '../../packages/db/index.js';
import {requireCondition} from '../../packages/shared/problem.js';
import {opaqueRef} from '../../packages/shared/validation.js';

const minutes=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();
const effort=z.object({platform_maintenance:minutes,coordination_friction:minutes,collaborative_value:minutes,paid_delivery:minutes}).strict().nullable();
export const benefitInput=z.object({
  work_claim_ref:z.uuid().nullable(),role:z.enum(['beneficiary','contributor']),
  outcome:z.enum(['gained','partly_gained','not_gained','unconfirmed']),actual_gain:z.string().trim().max(1000).nullable(),
  evidence_refs:z.array(opaqueRef).max(30).refine(a=>new Set(a).size===a.length,'引用不可重複。'),
  would_participate_again:z.boolean().nullable(),effort_minutes:effort,supersedes_observation_ref:z.uuid().nullable(),
}).strict().refine(v=>!['gained','partly_gained'].includes(v.outcome)||Boolean(v.actual_gain?.length),{path:['actual_gain'],message:'請用自己的話說明這次得到的具體幫助。'});
type Report=z.infer<typeof benefitInput>;
type Queryable=Pool|PoolClient;
async function participant(q:Queryable,actor:Actor,id:string,lock=false){
  const work=(await q.query(`SELECT * FROM work_items WHERE work_item_id=$1 AND community_id=$2${lock?' FOR SHARE':''}`,[id,actor.community_id])).rows[0];
  requireCondition(work,404,'not_found','找不到這次合作的回報。');
  const claim=(await q.query('SELECT claim_id,claimant_ref,state FROM work_claims WHERE work_item_id=$1',[id])).rows[0];
  requireCondition(work.owner_ref===actor.user_id||claim?.claimant_ref===actor.user_id,404,'not_found','找不到這次合作的回報。');
  const role=work.owner_ref===actor.user_id?'beneficiary':'contributor';
  return {work,claim,role,claimRef:role==='contributor'?claim.claim_id:null,canReport:Boolean(claim&&claim.state!=='claimed')};
}
function receipt(row:any){return {observation_id:row.observation_id,work_item_ref:row.work_item_ref,reporter_principal_ref:row.reporter_principal_ref,
  observation_revision:row.observation_revision,recorded_at:row.recorded_at instanceof Date?row.recorded_at.toISOString():row.recorded_at,report:row.report};}
async function latest(q:Queryable,communityId:string,workId:string){
  return (await q.query(`SELECT DISTINCT ON (reporter_principal_ref,role,work_claim_ref) * FROM work_benefit_observations
    WHERE community_id=$1 AND work_item_ref=$2 ORDER BY reporter_principal_ref,role,work_claim_ref,observation_revision DESC`,[communityId,workId])).rows;
}
export async function recordBenefit(pool:Pool,input:Command,id:string){
  id=z.uuid().parse(id);const body=benefitInput.parse(input.body);
  const authorize=async(q:PoolClient)=>{
    const relation=await participant(q,input.actor,id);
    requireCondition(body.role===relation.role&&body.work_claim_ref===relation.claimRef,403,'benefit_participant_required','只能以自己這次合作的身分回報，不可替其他人確認。');
  };
  return command(pool,input,authorize,async q=>{
    const relation=await participant(q,input.actor,id,true);
    checkVersion(relation.work.aggregate_version,input.expected);
    requireCondition(relation.canReport,409,'participation_not_started','開始參與之後才能回報這次的實際經驗；回報隨時可以略過。');
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`benefit/${input.actor.community_id}/${id}/${input.actor.user_id}/${body.role}/${body.work_claim_ref??''}`]);
    const previous=(await latest(q,input.actor.community_id,id)).find(row=>row.reporter_principal_ref===input.actor.user_id&&row.role===body.role&&row.work_claim_ref===body.work_claim_ref);
    requireCondition(body.supersedes_observation_ref===(previous?.observation_id??null),409,'benefit_observation_changed','你的回報已更新，請重新載入後再修改。');
    const revision=(previous?.observation_revision??0)+1;
    const row=(await q.query(`INSERT INTO work_benefit_observations(observation_id,community_id,work_item_ref,reporter_principal_ref,work_claim_ref,role,observation_revision,supersedes_observation_ref,report)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[randomUUID(),input.actor.community_id,id,input.actor.user_id,body.work_claim_ref,body.role,revision,body.supersedes_observation_ref,JSON.stringify(body)])).rows[0];
    // Private narrative, evidence references and minutes never enter the shared journal/outbox.
    await journal(q,input.actor,'benefit_observation',row.observation_id,1,'record_first_person_benefit',{work_item_ref:id,observation_revision:revision},'freedom.result.benefit_observed.v1');
    return receipt(row);
  });
}
export async function benefitView(pool:Pool,actor:Actor,id:string){
  id=z.uuid().parse(id);const relation=await participant(pool,actor,id),rows=await latest(pool,actor.community_id,id);
  const participants=[{id:relation.work.owner_ref,role:'beneficiary',claim:null},...(relation.claim?[{id:relation.claim.claimant_ref,role:'contributor',claim:relation.claim.claim_id}]:[])];
  const current=participants.map(p=>rows.find(row=>row.reporter_principal_ref===p.id&&row.role===p.role&&row.work_claim_ref===p.claim));
  const outcomes={gained:0,partly_gained:0,not_gained:0,unconfirmed:0,not_reported:0};
  for(const row of current){if(row)outcomes[(row.report as Report).outcome]++;else outcomes.not_reported++;}
  const own=rows.find(row=>row.reporter_principal_ref===actor.user_id&&row.role===relation.role&&row.work_claim_ref===relation.claimRef);
  return {work_item_ref:id,aggregate_version:relation.work.aggregate_version,role:relation.role,work_claim_ref:relation.claimRef,
    can_report:relation.canReport,own_observation:own?receipt(own):null,
    summary:{participants:participants.length,reported:current.filter(Boolean).length,outcomes,
      both_participants_reported_gained:participants.length===2&&new Set(participants.map(p=>p.id)).size===2&&current.every(row=>row?.report.outcome==='gained'),
      evidence_level:'self_reported',independent_people_verified:false,income_verified:false},
  };
}
