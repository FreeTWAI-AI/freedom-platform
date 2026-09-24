import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {command,type Command} from '../../packages/db/index.js';
import {Problem,requireCondition} from '../../packages/shared/problem.js';
import type {Actor} from '../identity-membership/service.js';
import {avatarUrl} from '../identity-membership/avatars.js';
import {
  COMMUNICATION_PAGE_DEFAULT_LIMIT,COMMUNICATION_PAGE_MAX_LIMIT,DIRECT_MESSAGE_BODY_MAX,
  type ConversationPage,type Message,type MessagePage,type Notification,type NotificationList,type Participant,
} from './types.js';

export const CommunicationPageQuery=z.object({
  limit:z.coerce.number().int().min(1).max(COMMUNICATION_PAGE_MAX_LIMIT).default(COMMUNICATION_PAGE_DEFAULT_LIMIT),
  offset:z.coerce.number().int().min(0).max(10000).default(0),
}).strict();
const Empty=z.object({}).strict();
// Plain text only: stored and returned verbatim after trimming. Nothing is
// parsed as HTML/Markdown or fetched. Length counts code points like PostgreSQL.
const MessageInput=z.object({
  body:z.string().transform(value=>value.replace(/\r\n?/g,'\n').trim())
    .refine(value=>value.length>0,'請輸入訊息內容。')
    .refine(value=>[...value].length<=DIRECT_MESSAGE_BODY_MAX,`訊息最多 ${DIRECT_MESSAGE_BODY_MAX} 字。`)
    .refine(value=>!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value),'訊息不可包含控制字元。'),
}).strict();
export const DIRECT_MESSAGE_RATE_LIMIT=20,DIRECT_MESSAGE_RATE_WINDOW_SECONDS=60;

const ready=(alias:string)=>`${alias}.active AND (NOT ${alias}.onboarding_required OR ${alias}.onboarding_completed_at IS NOT NULL)`;
const iso=(value:Date|string|null)=>value===null?null:new Date(value).toISOString();
const pageOf=<T>(rows:T[],limit:number,offset:number)=>({items:rows.slice(0,limit),next_offset:rows.length>limit?offset+limit:null});
function peerId(actor:Actor,raw:string){
  const id=z.uuid().parse(raw).toLowerCase();
  requireCondition(id!==actor.user_id.toLowerCase(),422,'self_conversation','不能傳訊息給自己。');
  return id;
}
/**
 * Live eligibility from the locked user row, never the Actor snapshot. Locks the
 * user before the session, the same order as command(). Commands already hold
 * both rows, so they pass session=false and only recheck onboarding readiness.
 */
async function currentMember(q:PoolClient,actor:Actor,session:boolean){
  const user=(await q.query(`SELECT ${ready('u')} AS ready FROM users u WHERE u.user_id=$1 AND u.community_id=$2 AND u.active FOR SHARE`,[actor.user_id,actor.community_id])).rows[0];
  requireCondition(user,401,'session_expired','請重新登入。');
  if(session)requireCondition((await q.query('SELECT 1 FROM sessions WHERE token_hash=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now() FOR SHARE',
    [actor.session_hash,actor.user_id])).rowCount===1,401,'session_expired','請重新登入。');
  requireCondition(user.ready,403,'onboarding_required','請先完成定位並選擇主要公會。');
}
const SNAPSHOT_ATTEMPTS=3;
/**
 * Counts and pages share one REPEATABLE READ snapshot that starts with the
 * member/session share locks; GET never writes. A revocation committed while
 * the locks waited raises 40001, and the whole read reruns in a fresh
 * transaction that then sees it. Only this read path retries.
 */
async function snapshot<T>(pool:Pool,actor:Actor,run:(q:PoolClient)=>Promise<T>):Promise<T>{
  for(let attempt=1;;attempt++){
    const q=await pool.connect();
    try{
      await q.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await currentMember(q,actor,true);
      const result=await run(q);await q.query('COMMIT');return result;
    }catch(error){
      await q.query('ROLLBACK');
      if(error instanceof Problem||(error as {code?:string}).code!=='40001')throw error;
      if(attempt===SNAPSHOT_ATTEMPTS)throw new Problem(503,'communications_busy','資料正在更新，請稍後再試。');
    }finally{q.release();}
  }
}
function message(row:any):Message{
  return {message_id:row.message_id,sender_ref:row.sender_ref,recipient_ref:row.recipient_ref,body:row.body,created_at:iso(row.created_at)!,read_at:iso(row.read_at)};
}
function notification(row:any):Notification{
  return {notification_id:row.notification_id,kind:row.kind,title:row.title,body:row.body,created_at:iso(row.created_at)!,read_at:iso(row.read_at),
    action:row.action_tab?{tab:row.action_tab,resource_id:row.action_resource_id}:null};
}

// ---------- notifications ----------
export async function listNotifications(pool:Pool,actor:Actor,raw:unknown):Promise<NotificationList>{
  const {limit,offset}=CommunicationPageQuery.parse(raw);
  return snapshot(pool,actor,async q=>{
    const unread=(await q.query('SELECT count(*)::int AS n FROM member_notifications WHERE community_id=$1 AND recipient_ref=$2 AND read_at IS NULL',[actor.community_id,actor.user_id])).rows[0].n;
    const rows=(await q.query(`SELECT notification_id,kind,title,body,created_at,read_at,action_tab,action_resource_id FROM member_notifications
      WHERE community_id=$1 AND recipient_ref=$2 ORDER BY created_at DESC,notification_id DESC LIMIT $3 OFFSET $4`,[actor.community_id,actor.user_id,limit+1,offset])).rows;
    const page=pageOf(rows.map(notification),limit,offset);
    return {items:page.items,unread_count:unread,next_offset:page.next_offset};
  });
}
export async function markNotificationRead(pool:Pool,input:Command,rawId:string){
  Empty.parse(input.body);const id=z.uuid().parse(rawId).toLowerCase();
  const own=async(q:PoolClient)=>{await currentMember(q,input.actor,false);requireCondition((await q.query('SELECT 1 FROM member_notifications WHERE notification_id=$1 AND community_id=$2 AND recipient_ref=$3',[id,input.actor.community_id,input.actor.user_id])).rowCount===1,404,'notification_not_found','找不到這則通知。');};
  return command(pool,input,own,async q=>{
    const row=(await q.query(`UPDATE member_notifications SET read_at=COALESCE(read_at,now()) WHERE notification_id=$1 AND community_id=$2 AND recipient_ref=$3
      RETURNING notification_id,read_at`,[id,input.actor.community_id,input.actor.user_id])).rows[0];
    return {notification_id:row.notification_id as string,read_at:iso(row.read_at)!};
  });
}

// ---------- direct messages ----------
type Peer={participant:Participant;ready:boolean;viewer_ready:boolean;has_history:boolean};
async function resolvePeer(q:PoolClient|Pool,actor:Actor,id:string):Promise<Peer>{
  const row=(await q.query(`SELECT u.user_id,u.display_name,${ready('u')} AS ready,av.aggregate_version AS avatar_version,av.image_bytes IS NOT NULL AS avatar_present,
      (SELECT ${ready('v')} FROM users v WHERE v.user_id=$2 AND v.community_id=$1) AS viewer_ready,
      EXISTS(SELECT 1 FROM member_direct_messages d WHERE d.community_id=$1
        AND least(d.sender_ref,d.recipient_ref)=least($2::uuid,$3::uuid) AND greatest(d.sender_ref,d.recipient_ref)=greatest($2::uuid,$3::uuid)) AS has_history
    FROM users u LEFT JOIN member_avatars av ON av.user_id=u.user_id AND av.community_id=u.community_id
    WHERE u.user_id=$3 AND u.community_id=$1`,[actor.community_id,actor.user_id,id])).rows[0];
  // Cross-community, unknown, and history-less unavailable members are indistinguishable.
  requireCondition(row&&(row.ready||row.has_history),404,'member_not_found','找不到這位會員。');
  return {ready:row.ready,viewer_ready:Boolean(row.viewer_ready),has_history:row.has_history,
    participant:{user_id:row.user_id,display_name:row.display_name,avatar_url:row.ready?avatarUrl(row.user_id,row.avatar_version??'1',Boolean(row.avatar_present)):null}};
}

export async function listConversations(pool:Pool,actor:Actor,raw:unknown):Promise<ConversationPage>{
  const {limit,offset}=CommunicationPageQuery.parse(raw);
  return snapshot(pool,actor,async q=>{
    const unread=(await q.query('SELECT count(*)::int AS n FROM member_direct_messages WHERE community_id=$1 AND recipient_ref=$2 AND read_at IS NULL',[actor.community_id,actor.user_id])).rows[0].n;
    const viewerReady=(await q.query(`SELECT ${ready('v')} AS ready FROM users v WHERE v.user_id=$1 AND v.community_id=$2`,[actor.user_id,actor.community_id])).rows[0]?.ready===true;
    const rows=(await q.query(`WITH latest AS (
        SELECT DISTINCT ON (peer) peer,message_id,sender_ref,recipient_ref,body,created_at,read_at FROM (
          SELECT CASE WHEN sender_ref=$2 THEN recipient_ref ELSE sender_ref END AS peer,* FROM member_direct_messages
          WHERE community_id=$1 AND (sender_ref=$2 OR recipient_ref=$2)) pair
        ORDER BY peer,created_at DESC,message_id DESC)
      SELECT l.*,u.display_name,${ready('u')} AS ready,av.aggregate_version AS avatar_version,av.image_bytes IS NOT NULL AS avatar_present,
        (SELECT count(*)::int FROM member_direct_messages d WHERE d.community_id=$1 AND d.recipient_ref=$2 AND d.sender_ref=l.peer AND d.read_at IS NULL) AS unread_count
      FROM latest l JOIN users u ON u.user_id=l.peer AND u.community_id=$1
      LEFT JOIN member_avatars av ON av.user_id=u.user_id AND av.community_id=u.community_id
      ORDER BY l.created_at DESC,l.message_id DESC LIMIT $3 OFFSET $4`,[actor.community_id,actor.user_id,limit+1,offset])).rows;
    const page=pageOf(rows,limit,offset);
    return {unread_count:unread,next_offset:page.next_offset,items:page.items.map(row=>({
      participant:{user_id:row.peer,display_name:row.display_name,avatar_url:row.ready?avatarUrl(row.peer,row.avatar_version??'1',Boolean(row.avatar_present)):null},
      can_send:viewerReady&&row.ready,last_message:message(row),unread_count:row.unread_count}))};
  });
}

export async function conversationMessages(pool:Pool,actor:Actor,rawPeer:string,raw:unknown):Promise<MessagePage>{
  const {limit,offset}=CommunicationPageQuery.parse(raw),id=peerId(actor,rawPeer);
  return snapshot(pool,actor,async q=>{
    const peer=await resolvePeer(q,actor,id);
    const unread=(await q.query('SELECT count(*)::int AS n FROM member_direct_messages WHERE community_id=$1 AND recipient_ref=$2 AND sender_ref=$3 AND read_at IS NULL',[actor.community_id,actor.user_id,id])).rows[0].n;
    const rows=(await q.query(`SELECT message_id,sender_ref,recipient_ref,body,created_at,read_at FROM member_direct_messages
      WHERE community_id=$1 AND least(sender_ref,recipient_ref)=least($2::uuid,$3::uuid) AND greatest(sender_ref,recipient_ref)=greatest($2::uuid,$3::uuid)
      ORDER BY created_at DESC,message_id DESC LIMIT $4 OFFSET $5`,[actor.community_id,actor.user_id,id,limit+1,offset])).rows;
    const page=pageOf(rows.map(message),limit,offset);
    return {participant:peer.participant,can_send:peer.ready&&peer.viewer_ready,items:page.items,unread_count:unread,next_offset:page.next_offset};
  });
}

export async function sendDirectMessage(pool:Pool,input:Command,rawPeer:string):Promise<Message>{
  const body=MessageInput.parse(input.body),id=peerId(input.actor,rawPeer);
  // Receipts keep only the message id; replay rereads the sender's own row, so
  // message text never enters command receipts, journals or logs.
  const sent=await command(pool,input,async q=>{
    // Current eligibility is rechecked before any replay. The command already
    // holds the sender row FOR SHARE; SHARE on the recipient cannot deadlock a
    // reciprocal send and still blocks a concurrent suspension until commit.
    await currentMember(q,input.actor,false);
    const recipient=await q.query(`SELECT 1 FROM users u WHERE u.user_id=$1 AND u.community_id=$2 AND ${ready('u')} FOR SHARE`,[id,input.actor.community_id]);
    if(recipient.rowCount!==1){
      const peer=await resolvePeer(q,input.actor,id);
      requireCondition(false,409,'recipient_unavailable',`${peer.participant.display_name} 目前無法接收訊息。`);
    }
  },async q=>{
    // Serialize one sender's sends so concurrent requests cannot exceed the budget.
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`direct-message-sender/${input.actor.community_id}/${input.actor.user_id}`]);
    const recent=(await q.query(`SELECT count(*)::int AS n FROM member_direct_messages WHERE community_id=$1 AND sender_ref=$2 AND created_at>clock_timestamp()-make_interval(secs=>$3)`,
      [input.actor.community_id,input.actor.user_id,DIRECT_MESSAGE_RATE_WINDOW_SECONDS])).rows[0].n;
    requireCondition(recent<DIRECT_MESSAGE_RATE_LIMIT,429,'message_rate_limited','訊息傳送太頻繁，請稍後再試。');
    const row=(await q.query('INSERT INTO member_direct_messages(community_id,sender_ref,recipient_ref,body,created_at) VALUES($1,$2,$3,$4,clock_timestamp()) RETURNING message_id',
      [input.actor.community_id,input.actor.user_id,id,body.body])).rows[0];
    return {message_id:row.message_id as string};
  });
  const row=(await pool.query('SELECT message_id,sender_ref,recipient_ref,body,created_at,read_at FROM member_direct_messages WHERE message_id=$1 AND community_id=$2 AND sender_ref=$3',
    [sent.message_id,input.actor.community_id,input.actor.user_id])).rows[0];
  requireCondition(row,404,'message_not_found','找不到這則訊息。');
  return message(row);
}

export async function markConversationRead(pool:Pool,input:Command,rawPeer:string){
  Empty.parse(input.body);const id=peerId(input.actor,rawPeer);
  return command(pool,input,async q=>{await currentMember(q,input.actor,false);await resolvePeer(q,input.actor,id);},async q=>{
    // Only messages the peer sent to the viewer and already committed are marked.
    const row=(await q.query(`WITH marked AS (UPDATE member_direct_messages SET read_at=now()
        WHERE community_id=$1 AND recipient_ref=$2 AND sender_ref=$3 AND read_at IS NULL RETURNING 1)
      SELECT now() AS read_at,(SELECT count(*)::int FROM marked) AS updated_count`,[input.actor.community_id,input.actor.user_id,id])).rows[0];
    return {user_id:id,read_at:iso(row.read_at)!,updated_count:row.updated_count as number};
  });
}
