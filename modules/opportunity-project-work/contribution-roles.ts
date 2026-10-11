import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Pool,PoolClient} from 'pg';
import {command,checkVersion,digest,journal,type Command} from '../../packages/db/index.js';
import {assertCurrentSessionClock,readWithMemberSession} from '../../packages/db/member-session.js';
import {requireCondition} from '../../packages/shared/problem.js';
import {opaqueRef,text} from '../../packages/shared/validation.js';
import type {Actor} from '../identity-membership/service.js';

const role=z.enum(['proposal','design','implementation','testing','review','documentation','coordination','service']);
export const contributionRoleInput=z.object({role,summary:text(1000),evidence_ref:opaqueRef,share_with_community:z.literal(true)}).strict();
const editInput=contributionRoleInput.omit({role:true});
const confirmationInput=z.object({payload_sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const pageInput=z.object({limit:z.coerce.number().int().min(1).max(50).default(20),offset:z.coerce.number().int().min(0).max(10000).default(0)}).strict();
type Queryable=Pool|PoolClient;
async function eligible(q:Queryable,actor:Actor){
  const current=(await q.query('SELECT 1 FROM users WHERE user_id=$1 AND community_id=$2 AND active AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL)',[actor.user_id,actor.community_id])).rowCount;
  requireCondition(current===1,403,'member_required','請先完成加入社群。');
}
// IDs/session always originate in the authenticated server Actor. No GitHub slug,
// display name, job title, claim author supplied in JSON, or platform rank is used.
async function work(q:Queryable,actor:Actor,id:string,lock=false){
  await eligible(q,actor);
  const row=(await q.query(`SELECT w.work_item_id,w.owner_ref,w.title,w.state,w.aggregate_version,
    c.user_id AS accepted_member,c.decision_id,c.accepted_at,d.reviewer_ref AS accepted_by
    FROM work_items w LEFT JOIN contributions c ON c.work_item_id=w.work_item_id
    LEFT JOIN work_decisions d ON d.decision_id=c.decision_id AND d.decision='accept'
    WHERE w.work_item_id=$1 AND w.community_id=$2 AND w.work_mode='community_collaboration'
    ${lock?'FOR SHARE OF w':''}`,[id,actor.community_id])).rows[0];
  requireCondition(row,404,'not_found','找不到這件社群工作。');return row;
}
async function claim(q:Queryable,actor:Actor,id:string,lock=false){
  const row=(await q.query(`SELECT r.* FROM work_contribution_roles r JOIN work_items w USING(work_item_id)
    WHERE r.role_id=$1 AND r.community_id=$2 AND w.community_id=$2 AND w.work_mode='community_collaboration'
    ${lock?'FOR UPDATE OF r':''}`,[id,actor.community_id])).rows[0];
  requireCondition(row,404,'not_found','找不到這份成果署名。');return row;
}
async function confirmationAuthority(q:PoolClient,actor:Actor,target:any,source:any,lock=false){
  requireCondition(target.member_ref!==actor.user_id,403,'self_confirmation','自己的角色需要另一位合作成員確認。');
  requireCondition(source.state==='accepted'&&source.accepted_by,409,'work_not_accepted','工作通過驗收後才能確認成果角色。');
  const member=(await q.query(`SELECT 1 FROM users WHERE user_id=$1 AND community_id=$2 AND active
    AND NOT EXISTS(SELECT 1 FROM member_interaction_blocks b WHERE b.community_id=$2 AND b.state='active'
      AND ((b.owner_ref=$3 AND b.target_ref=$1) OR (b.owner_ref=$1 AND b.target_ref=$3)))`,[target.member_ref,actor.community_id,actor.user_id])).rowCount;
  requireCondition(member===1,404,'not_found','找不到這份成果署名。');
  const routes=await q.query(`SELECT valid_until FROM work_review_routes WHERE work_item_id=$1 AND reviewer_ref=$2
    AND revoked_at IS NULL ${lock?'FOR SHARE':''}`,[target.work_item_id,actor.user_id]);
  const now=(await q.query('SELECT clock_timestamp() AS now')).rows[0].now;
  const validRoute=routes.rows.some(route=>new Date(route.valid_until)>new Date(now));
  // The accepted deliverer can acknowledge the initiator's own role. This is an
  // actual collaboration relationship, not a new reviewer appointment or rating.
  const counterpart=source.accepted_member===actor.user_id&&source.owner_ref===target.member_ref;
  requireCondition(validRoute||counterpart,403,'confirmation_authority_required','只有目前的驗收者，或確認工作發起人角色的已驗收交付者，可以確認這份署名。');
}
function receipt(row:any){return {role_id:row.role_id,work_item_id:row.work_item_id,state:row.state,aggregate_version:String(row.aggregate_version),payload_sha256:row.payload_sha256};}
function payload(workId:string,memberId:string,roleId:string,summary:string,evidence:string){return digest({work_item_id:workId,member_ref:memberId,role:roleId,summary,evidence_ref:evidence});}

export async function createContributionRole(pool:Pool,input:Command,workId:string){
  const request={...input,actor:{...input.actor},body:structuredClone(input.body)};
  workId=z.uuid().parse(workId).toLowerCase();const body=contributionRoleInput.parse(request.body),actor=request.actor;
  return command(pool,request,q=>work(q,actor,workId),async q=>{
    await work(q,actor,workId,true);
    // Serialize only this person's role identity, not every collaboration member.
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`work-role/${workId}/${actor.user_id}/${body.role}`]);
    requireCondition(!(await q.query('SELECT 1 FROM work_contribution_roles WHERE work_item_id=$1 AND member_ref=$2 AND role=$3',[workId,actor.user_id,body.role])).rowCount,
      409,'role_already_recorded','這個角色已有紀錄，請修改原署名。');
    const row=(await q.query(`INSERT INTO work_contribution_roles(role_id,community_id,work_item_id,member_ref,role,summary,evidence_ref,payload_sha256)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[randomUUID(),actor.community_id,workId,actor.user_id,body.role,body.summary,body.evidence_ref,payload(workId,actor.user_id,body.role,body.summary,body.evidence_ref)])).rows[0];
    await assertCurrentSessionClock(q,actor);
    await journal(q,actor,'work_contribution_role',row.role_id,1,'declare_role',{work_item_id:workId,state:'pending',payload_sha256:row.payload_sha256});
    return receipt(row);
  });
}

export async function changeContributionRole(pool:Pool,input:Command,id:string,action:'edit'|'withdraw'|'confirm'){
  const request={...input,actor:{...input.actor},body:structuredClone(input.body)};
  id=z.uuid().parse(id).toLowerCase();const actor=request.actor;
  const body=action==='edit'?editInput.parse(request.body):action==='confirm'?confirmationInput.parse(request.body):z.object({}).strict().parse(request.body);
  let target:any;
  async function authorize(q:PoolClient){
    target=await claim(q,actor,id);const source=await work(q,actor,target.work_item_id);
    if(action==='confirm')await confirmationAuthority(q,actor,target,source);
    else requireCondition(target.member_ref===actor.user_id,403,'role_owner_required','只能修改或撤回自己的署名。');
  }
  async function revalidate(q:PoolClient){
    if(action==='confirm')await confirmationAuthority(q,actor,target,await work(q,actor,target.work_item_id));
  }
  return command(pool,request,authorize,async q=>{
    // Consistent lock order: session -> Work -> role -> review route.
    const source=await work(q,actor,target.work_item_id,true);
    target=await claim(q,actor,id,true);checkVersion(String(target.aggregate_version),request.expected);
    if(action==='confirm'){
      await confirmationAuthority(q,actor,target,source,true);
      requireCondition(target.state==='pending',409,'role_not_pending','這份署名已確認或撤回，請重新讀取。');
      requireCondition((body as z.infer<typeof confirmationInput>).payload_sha256===target.payload_sha256,409,'role_changed','署名內容已修改，請閱讀新版本後再確認。');
      await q.query(`INSERT INTO work_contribution_confirmations(confirmation_id,role_id,claim_version,payload_sha256,confirmer_ref)
        VALUES($1,$2,$3,$4,$5)`,[randomUUID(),id,target.aggregate_version,target.payload_sha256,actor.user_id]);
      target=(await q.query("UPDATE work_contribution_roles SET state='confirmed',aggregate_version=aggregate_version+1,updated_at=now() WHERE role_id=$1 RETURNING *",[id])).rows[0];
    }else if(action==='withdraw'){
      requireCondition(target.state!=='withdrawn',409,'role_withdrawn','署名已撤回。');
      target=(await q.query("UPDATE work_contribution_roles SET state='withdrawn',aggregate_version=aggregate_version+1,updated_at=now() WHERE role_id=$1 RETURNING *",[id])).rows[0];
    }else{
      const edit=body as z.infer<typeof editInput>;
      target=(await q.query(`UPDATE work_contribution_roles SET summary=$2,evidence_ref=$3,payload_sha256=$4,state='pending',
        aggregate_version=aggregate_version+1,shared_at=now(),updated_at=now() WHERE role_id=$1 RETURNING *`,[id,edit.summary,edit.evidence_ref,payload(target.work_item_id,actor.user_id,target.role,edit.summary,edit.evidence_ref)])).rows[0];
    }
    await assertCurrentSessionClock(q,actor);
    await journal(q,actor,'work_contribution_role',id,target.aggregate_version,action,{work_item_id:target.work_item_id,state:target.state,payload_sha256:target.payload_sha256});
    return receipt(target);
  },revalidate);
}

export async function contributionRoles(pool:Pool,actor:Actor,workId:string,query:unknown){
  workId=z.uuid().parse(workId).toLowerCase();const page=pageInput.parse(query);actor={...actor};
  return readWithMemberSession(pool,actor,async q=>{
    const source=await work(q,actor,workId);
    const rows=(await q.query(`SELECT r.*,u.display_name AS member_name,c.confirmer_ref,c.confirmed_at,v.display_name AS confirmer_name
      FROM work_contribution_roles r JOIN users u ON u.user_id=r.member_ref AND u.community_id=r.community_id AND u.active
      LEFT JOIN work_contribution_confirmations c ON c.role_id=r.role_id AND c.claim_version=r.aggregate_version-1 AND c.payload_sha256=r.payload_sha256 AND r.state='confirmed'
      LEFT JOIN users v ON v.user_id=c.confirmer_ref
      WHERE r.work_item_id=$1 AND r.community_id=$2 AND (r.state<>'withdrawn' OR r.member_ref=$3)
      AND (r.member_ref=$3 OR NOT is_verification_test_account(r.member_ref))
      AND NOT EXISTS(SELECT 1 FROM member_interaction_blocks b WHERE b.community_id=$2 AND b.state='active'
        AND ((b.owner_ref=$3 AND b.target_ref=r.member_ref) OR (b.owner_ref=r.member_ref AND b.target_ref=$3)))
      ORDER BY r.shared_at,r.role_id LIMIT $4 OFFSET $5`,[workId,actor.community_id,actor.user_id,page.limit+1,page.offset])).rows;
    const routes=source.state==='accepted'?(await q.query('SELECT 1 FROM work_review_routes WHERE work_item_id=$1 AND reviewer_ref=$2 AND revoked_at IS NULL AND valid_until>clock_timestamp()',[workId,actor.user_id])).rowCount:0;
    const items=[];
    for(const row of rows.slice(0,page.limit)){
      let canConfirm=false;
      if(row.state==='pending'&&row.member_ref!==actor.user_id&&source.state==='accepted'){
        canConfirm=Boolean(routes)||source.accepted_member===actor.user_id&&source.owner_ref===row.member_ref;
      }
      items.push({...receipt(row),role:row.role,member_ref:row.member_ref,member_name:row.member_name,summary:row.summary,evidence_ref:row.evidence_ref,
        is_self:row.member_ref===actor.user_id,can_confirm:canConfirm,confirmer_name:row.confirmer_name??null,confirmed_at:row.confirmed_at??null});
    }
    return {work_item_id:workId,title:source.title,work_state:source.state,accepted_at:source.accepted_at??null,items,next_offset:rows.length>page.limit?page.offset+page.limit:null};
  });
}

// A member-visible projection only. Anonymous e-cards never call this reader.
// Count unique Work IDs: several roles, PRs or replays do not create more outcomes.
export async function memberContributionOutcomes(pool:Pool,actor:Actor,memberId:string,query:unknown){
  memberId=z.uuid().parse(memberId).toLowerCase();actor={...actor};const page=pageInput.parse(query);
  return readWithMemberSession(pool,actor,async q=>{
    await eligible(q,actor);
    const visible=(await q.query(`SELECT 1 FROM users u WHERE u.user_id=$1 AND u.community_id=$2 AND u.active
      AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL)
      AND (u.user_id=$3 OR NOT is_verification_test_account(u.user_id))
      AND NOT EXISTS(SELECT 1 FROM member_interaction_blocks b WHERE b.community_id=$2 AND b.state='active'
        AND ((b.owner_ref=$3 AND b.target_ref=u.user_id) OR (b.owner_ref=u.user_id AND b.target_ref=$3)))`,[memberId,actor.community_id,actor.user_id])).rowCount;
    requireCondition(visible===1,404,'not_found','找不到這位夥伴的成果紀錄。');
    const result=(await q.query(`WITH outcomes AS (
      SELECT w.work_item_id,w.title,c.accepted_at,d.reviewer_ref AS accepted_by,
        CASE WHEN c.user_id=$2 THEN c.artifact_ref ELSE NULL END AS delivery_ref,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('role',r.role,'summary',r.summary,'evidence_ref',r.evidence_ref,
          'confirmer_name',v.display_name,'confirmed_at',f.confirmed_at) ORDER BY r.role)
          FROM work_contribution_roles r JOIN work_contribution_confirmations f ON f.role_id=r.role_id AND f.claim_version=r.aggregate_version-1 AND f.payload_sha256=r.payload_sha256
          JOIN users v ON v.user_id=f.confirmer_ref WHERE r.work_item_id=w.work_item_id AND r.member_ref=$2 AND r.community_id=$1 AND r.state='confirmed'),'[]'::jsonb) AS roles
      FROM work_items w JOIN contributions c ON c.work_item_id=w.work_item_id AND c.community_id=w.community_id
      JOIN work_decisions d ON d.decision_id=c.decision_id AND d.decision='accept'
      WHERE w.community_id=$1 AND w.work_mode='community_collaboration' AND w.state='accepted'
        AND (c.user_id=$2 OR EXISTS(SELECT 1 FROM work_contribution_roles r JOIN work_contribution_confirmations f ON f.role_id=r.role_id
          AND f.claim_version=r.aggregate_version-1 AND f.payload_sha256=r.payload_sha256
          WHERE r.work_item_id=w.work_item_id AND r.community_id=$1 AND r.member_ref=$2 AND r.state='confirmed'))
    ) SELECT (SELECT count(*)::int FROM outcomes) AS accepted_count,
      COALESCE((SELECT jsonb_agg(p) FROM (SELECT o.*,v.display_name AS accepted_by_name FROM outcomes o
        JOIN users v ON v.user_id=o.accepted_by ORDER BY accepted_at DESC,work_item_id LIMIT $3 OFFSET $4) p),'[]'::jsonb) AS entries`,[actor.community_id,memberId,page.limit,page.offset])).rows[0];
    return {policy:'community_work_roles_v1',member_ref:memberId,accepted_count:result.accepted_count,entries:result.entries,
      next_offset:page.offset+page.limit<result.accepted_count?page.offset+page.limit:null};
  });
}
