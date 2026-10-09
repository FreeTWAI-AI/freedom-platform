import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {command,journal,transaction,type Command} from '../../packages/db/index.js';
import {lockMemberSession,assertCurrentSessionClock} from '../../packages/db/member-session.js';
import {requireCondition} from '../../packages/shared/problem.js';
import type {Actor} from '../identity-membership/service.js';
import {visibleMember} from '../identity-membership/members.js';
import {currentMember,lockRoom} from '../member-communications/channels.js';
import {resolvePeer} from '../member-communications/service.js';
import {moderateSocialContent,requireMemberContentAdmin} from './moderation.js';

const TargetKind=z.enum(['post','comment','direct_message','channel_message','member']);
const ReportInput=z.object({target_kind:TargetKind,target_id:z.uuid().transform(value=>value.toLowerCase()),reason:z.enum(['harassment','spam','fraud','other']),note:z.string().trim().max(2000).optional()}).strict();
const TransitionInput=z.object({state:z.enum(['in_progress','closed']),reason:z.string().trim().min(1).max(2000),summary:z.string().trim().min(1).max(2000),action:z.enum(['none','hide','restore'])}).strict();
type Target=z.infer<typeof ReportInput>;
type ReportRow={case_id:string;case_number:string;target_kind:Target['target_kind'];target_id:string;reason:string;state:'received'|'in_progress'|'closed';aggregate_version:number;summary:string|null;created_at:Date;updated_at:Date;reporter_user_id:string;handler_user_id:string|null;processing_reason:string|null;action:'none'|'hide'|'restore';note:string|null;evidence:unknown};

/** This explicit projection is also the only report data persisted in receipts. */
function reporterView(row:ReportRow){
  return {case_id:row.case_id,case_number:String(row.case_number),target_kind:row.target_kind,target_id:row.target_id,reason:row.reason,state:row.state,aggregate_version:Number(row.aggregate_version),summary:row.summary,created_at:new Date(row.created_at).toISOString(),updated_at:new Date(row.updated_at).toISOString()};
}

/** Lock only content already visible to this actor; never follow a supplied quote. */
async function visibleEvidence(q:PoolClient,actor:Actor,target:Target):Promise<Record<string,unknown>>{
  const args=[target.target_id,actor.community_id];
  let row:Record<string,unknown>|undefined;
  switch(target.target_kind){
    case 'post':
      row=(await q.query(`SELECT p.post_id,p.author_user_id,u.display_name,p.kind,p.title,p.note,p.url,p.created_at FROM community_social_posts p JOIN users u ON u.user_id=p.author_user_id
        WHERE p.post_id=$1 AND p.community_id=$2 AND p.state='active' FOR SHARE OF p`,args)).rows[0];
      break;
    case 'comment':
      row=(await q.query(`SELECT c.comment_id,c.post_id,c.author_user_id,u.display_name,c.body,c.created_at FROM community_social_comments c JOIN users u ON u.user_id=c.author_user_id
        JOIN community_social_posts p ON p.post_id=c.post_id AND p.community_id=c.community_id
        WHERE c.comment_id=$1 AND c.community_id=$2 AND c.state='active' AND p.state='active' FOR SHARE OF p,c`,args)).rows[0];
      break;
    case 'direct_message':{
      row=(await q.query(`SELECT message_id,sender_ref,recipient_ref,body,sticker_id,reply_to_message_id,created_at FROM member_direct_messages
        WHERE message_id=$1 AND community_id=$2 AND (sender_ref=$3 OR recipient_ref=$3) FOR SHARE`,[...args,actor.user_id])).rows[0];
      if(row)await resolvePeer(q,actor,String(row.sender_ref===actor.user_id?row.recipient_ref:row.sender_ref));
      break;
    }
    case 'channel_message':{
      // Resolve room identity without reading body, then reuse the room's locked membership policy.
      const room=(await q.query(`SELECT kind,channel_key FROM member_channel_messages WHERE message_id=$1 AND community_id=$2
        AND (kind<>'world' OR sender_ref=$3 OR NOT is_verification_test_account(sender_ref))`,[...args,actor.user_id])).rows[0];
      requireCondition(room,404,'report_target_not_found','找不到可檢舉的內容。');
      await lockRoom(q,actor,{kind:room.kind,key:room.channel_key});
      row=(await q.query(`SELECT message_id,kind,channel_key,sender_ref,body,sticker_id,reply_to_message_id,created_at FROM member_channel_messages
        WHERE message_id=$1 AND community_id=$2 AND kind=$4 AND channel_key=$5
        AND (kind<>'world' OR sender_ref=$3 OR NOT is_verification_test_account(sender_ref)) FOR SHARE`,[...args,actor.user_id,room.kind,room.channel_key])).rows[0];
      break;
    }
    case 'member':row=await visibleMember(q,actor,target.target_id,true);break;
  }
  requireCondition(row,404,'report_target_not_found','找不到可檢舉的內容。');
  return row;
}

export async function createMemberReport(pool:Pool,input:Command){
  const body=ReportInput.parse(input.body),actor=input.actor;
  let content:Record<string,unknown>;
  return command(pool,input,async q=>{
    await currentMember(q,actor,false);
    content=await visibleEvidence(q,actor,body);
  },async q=>{
    // Different receipt keys still share one reporter budget and dedupe lock.
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`member-report-budget/${actor.user_id}`]);
    const prior=(await q.query('SELECT * FROM member_reports WHERE reporter_user_id=$1 AND target_kind=$2 AND target_id=$3',[actor.user_id,body.target_kind,body.target_id])).rows[0] as ReportRow|undefined;
    if(prior)return reporterView(prior);
    const used=(await q.query("SELECT count(*)::int AS n FROM member_reports WHERE reporter_user_id=$1 AND created_at>clock_timestamp()-interval '1 hour'",[actor.user_id])).rows[0].n;
    requireCondition(used<20,429,'member_report_rate_limit','每小時最多提出 20 件新檢舉。');
    const captured=(await q.query('SELECT clock_timestamp() AS captured_at')).rows[0].captured_at as Date;
    const evidence={captured_at:captured.toISOString(),target_kind:body.target_kind,target_id:body.target_id,content:content!};
    const row=(await q.query(`INSERT INTO member_reports(community_id,reporter_user_id,target_kind,target_id,reason,note,evidence)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[actor.community_id,actor.user_id,body.target_kind,body.target_id,body.reason,body.note??null,JSON.stringify(evidence)])).rows[0] as ReportRow;
    // The private evidence/note do not enter journal, outbox, or receipts.
    await journal(q,actor,'member_report',row.case_id,row.aggregate_version,'receive',{state:'received',target_kind:body.target_kind,target_id:body.target_id});
    return reporterView(row);
  });
}

export async function listMyMemberReports(pool:Pool,actor:Actor){
  return transaction(pool,async q=>{
    await lockMemberSession(q,actor);
    await currentMember(q,actor,false);
    const rows=(await q.query(`SELECT case_id,case_number,target_kind,target_id,reason,state,aggregate_version,summary,created_at,updated_at
      FROM member_reports WHERE community_id=$1 AND reporter_user_id=$2 ORDER BY created_at DESC,case_id`,[actor.community_id,actor.user_id])).rows as ReportRow[];
    await assertCurrentSessionClock(q,actor);
    return {items:rows.map(reporterView)};
  });
}

export async function listAdminMemberReports(pool:Pool,actor:Actor){
  return transaction(pool,async q=>{
    await lockMemberSession(q,actor);
    await requireMemberContentAdmin(q,actor);
    const rows=(await q.query('SELECT * FROM member_reports WHERE community_id=$1 ORDER BY created_at DESC,case_id',[actor.community_id])).rows as ReportRow[];
    await assertCurrentSessionClock(q,actor);
    return {items:rows.map(row=>({...reporterView(row),reporter_user_id:row.reporter_user_id,handler_user_id:row.handler_user_id,processing_reason:row.processing_reason,action:row.action,note:row.note,evidence:row.evidence}))};
  });
}

export async function transitionMemberReport(pool:Pool,input:Command,rawId:string){
  const id=z.uuid().parse(rawId).toLowerCase(),body=TransitionInput.parse(input.body),actor=input.actor;
  return command(pool,input,q=>requireMemberContentAdmin(q,actor),async q=>{
    const row=(await q.query('SELECT * FROM member_reports WHERE case_id=$1 AND community_id=$2 FOR UPDATE',[id,actor.community_id])).rows[0] as ReportRow|undefined;
    requireCondition(row,404,'report_not_found','找不到這件檢舉。');
    requireCondition(input.expected,428,'version_required','請提供 If-Match 版本。');
    requireCondition(String(row.aggregate_version)===input.expected,409,'report_version_conflict','案件已更新，請重新整理。');
    requireCondition((row.state==='received'&&body.state==='in_progress')||(row.state==='in_progress'&&body.state==='closed'),409,'report_transition_conflict','案件必須依序由已收到、處理中到已結案。');
    let effect:unknown={action:'none',changed:false};
    if(body.action!=='none'){
      requireCondition(row.target_kind==='post'||row.target_kind==='comment',422,'report_action_unavailable','這類內容不支援隱藏或還原。');
      effect=await moderateSocialContent(q,actor,row.target_kind,row.target_id,body.action);
    }
    const updated=(await q.query(`UPDATE member_reports SET state=$2,summary=$3,handler_user_id=$4,aggregate_version=aggregate_version+1,updated_at=clock_timestamp(),processing_reason=$6,action=$7
      WHERE case_id=$1 AND aggregate_version=$5 RETURNING *`,[id,body.state,body.summary,actor.user_id,row.aggregate_version,body.reason,body.action])).rows[0] as ReportRow;
    await journal(q,actor,'member_report',id,updated.aggregate_version,'transition',{previous_state:row.state,state:body.state,reason:body.reason,summary:body.summary,action:body.action,effect});
    return reporterView(updated);
  },q=>requireMemberContentAdmin(q,actor));
}
