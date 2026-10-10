import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {command,type Command} from '../../packages/db/index.js';
import {Problem,requireCondition} from '../../packages/shared/problem.js';
import type {Actor} from '../identity-membership/service.js';
import {avatarUrl} from '../identity-membership/avatars.js';
import {lockInteractionPair,assertCanContact} from '../identity-membership/blocks.js';
import {assertCurrentSessionClock} from '../../packages/db/member-session.js';
import {DirectMessageInput,messageContents,storedMessageBody} from './content.js';
import {markAllMemberChannelsRead} from './channels.js';
import {MessageSearchQuery,messageSearchPattern,boundedMessageSearch,type MessageSearchPage} from './message-search.js';
import {
  COMMUNICATION_PAGE_DEFAULT_LIMIT,COMMUNICATION_PAGE_MAX_LIMIT,DIRECT_MESSAGE_BODY_MAX,
  type ConversationActivity,type ConversationPage,type Message,type MessagePage,type Notification,type NotificationList,type Participant,
} from './types.js';

export const CommunicationPageQuery=z.object({
  limit:z.coerce.number().int().min(1).max(COMMUNICATION_PAGE_MAX_LIMIT).default(COMMUNICATION_PAGE_DEFAULT_LIMIT),
  offset:z.coerce.number().int().min(0).max(10000).default(0),
}).strict();
const Empty=z.object({}).strict();
const ConversationReadInput=z.object({through_message_id:z.uuid().optional()}).strict();
const MessageInput=DirectMessageInput;
export const DIRECT_MESSAGE_RATE_LIMIT=20,DIRECT_MESSAGE_RATE_WINDOW_SECONDS=60;

const ready=(alias:string)=>`${alias}.active AND (NOT ${alias}.onboarding_required OR ${alias}.onboarding_completed_at IS NOT NULL)`;
const iso=(value:Date|string|null)=>value===null?null:new Date(value).toISOString();
const pageOf=<T>(rows:T[],limit:number,offset:number)=>({items:rows.slice(0,limit),next_offset:rows.length>limit?offset+limit:null});
export function peerId(actor:Actor,raw:string){
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
  requireCondition(user.ready,403,'onboarding_required','請先選擇主要公會，完成加入後即可使用會員功能。');
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
      const result=await run(q);await assertCurrentSessionClock(q,actor);await q.query('COMMIT');return result;
    }catch(error){
      await q.query('ROLLBACK');
      if(error instanceof Problem||(error as {code?:string}).code!=='40001')throw error;
      if(attempt===SNAPSHOT_ATTEMPTS)throw new Problem(503,'communications_busy','資料正在更新，請稍後再試。');
    }finally{q.release();}
  }
}
function message(row:any):Message{
  const retracted=iso(row.retracted_at??null);
  // A retracted row keeps its place and read state; the text never leaves the server again.
  return {message_id:row.message_id,sender_ref:row.sender_ref,recipient_ref:row.recipient_ref,body:retracted?'':row.body,created_at:iso(row.created_at)!,read_at:iso(row.read_at),retracted_at:retracted};
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

/** One explicit command clears the viewer's inbox across pages and rooms.
 * Replaying the receipt never consumes messages that arrived afterwards. */
export async function markAllInboxRead(pool:Pool,input:Command){
  Empty.parse(input.body);
  return command(pool,input,q=>currentMember(q,input.actor,false),async q=>{
    const {community_id,user_id}=input.actor;
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`member-inbox-read-all/${community_id}/${user_id}`]);
    const notices=await q.query('UPDATE member_notifications SET read_at=clock_timestamp() WHERE community_id=$1 AND recipient_ref=$2 AND read_at IS NULL',[community_id,user_id]);
    const messages=await q.query('UPDATE member_direct_messages SET read_at=clock_timestamp() WHERE community_id=$1 AND recipient_ref=$2 AND read_at IS NULL',[community_id,user_id]);
    const channels=await markAllMemberChannelsRead(q,input.actor);
    return {notifications_updated:notices.rowCount??0,direct_messages_updated:messages.rowCount??0,channels_updated:channels};
  });
}

// ---------- direct messages ----------
type Peer={participant:Participant;ready:boolean;viewer_ready:boolean;has_history:boolean;blocked:boolean};
async function resolvePeer(q:PoolClient|Pool,actor:Actor,id:string):Promise<Peer>{
  const row=(await q.query(`SELECT u.user_id,u.display_name,${ready('u')} AS ready,av.aggregate_version AS avatar_version,av.present AS avatar_present,
      (SELECT max(coalesce(s.last_seen_at,s.created_at)) FROM sessions s WHERE s.user_id=u.user_id) AS last_seen_at,
      EXISTS(SELECT 1 FROM sessions s WHERE s.user_id=u.user_id AND s.revoked_at IS NULL AND s.expires_at>now()
        AND s.last_seen_at>now()-interval '2 minutes') AS is_online,
      (SELECT ${ready('v')} FROM users v WHERE v.user_id=$2 AND v.community_id=$1) AS viewer_ready,
      EXISTS(SELECT 1 FROM member_interaction_blocks b WHERE b.community_id=$1 AND b.state='active'
        AND ((b.owner_ref=$2 AND b.target_ref=$3) OR (b.owner_ref=$3 AND b.target_ref=$2))) AS blocked,
      EXISTS(SELECT 1 FROM member_direct_messages d WHERE d.community_id=$1
        AND least(d.sender_ref,d.recipient_ref)=least($2::uuid,$3::uuid) AND greatest(d.sender_ref,d.recipient_ref)=greatest($2::uuid,$3::uuid)) AS has_history
    FROM users u LEFT JOIN member_avatar_presence av ON av.user_id=u.user_id AND av.community_id=u.community_id
    WHERE u.user_id=$3 AND u.community_id=$1`,[actor.community_id,actor.user_id,id])).rows[0];
  // Cross-community, unknown, and history-less unavailable members are indistinguishable.
  requireCondition(row&&(row.ready||row.has_history),404,'member_not_found','找不到這位會員。');
  return {ready:row.ready,viewer_ready:Boolean(row.viewer_ready),has_history:row.has_history,blocked:row.blocked,
    participant:{user_id:row.user_id,display_name:row.display_name,avatar_url:row.ready?avatarUrl(row.user_id,row.avatar_version??'1',Boolean(row.avatar_present)):null,
      last_seen_at:row.last_seen_at?new Date(row.last_seen_at).toISOString():null,is_online:row.is_online}};
}

export async function listConversations(pool:Pool,actor:Actor,raw:unknown):Promise<ConversationPage>{
  const {limit,offset}=CommunicationPageQuery.parse(raw);
  return snapshot(pool,actor,async q=>{
    const unread=(await q.query('SELECT count(*)::int AS n FROM member_direct_messages WHERE community_id=$1 AND recipient_ref=$2 AND read_at IS NULL AND retracted_at IS NULL',[actor.community_id,actor.user_id])).rows[0].n;
    const viewerReady=(await q.query(`SELECT ${ready('v')} AS ready FROM users v WHERE v.user_id=$1 AND v.community_id=$2`,[actor.user_id,actor.community_id])).rows[0]?.ready===true;
    const rows=(await q.query(`WITH latest AS (
        SELECT DISTINCT ON (peer) peer,message_id,sender_ref,recipient_ref,body,created_at,read_at,sticker_id,reply_to_message_id,retracted_at FROM (
          SELECT CASE WHEN sender_ref=$2 THEN recipient_ref ELSE sender_ref END AS peer,* FROM member_direct_messages
          WHERE community_id=$1 AND (sender_ref=$2 OR recipient_ref=$2)) pair
        ORDER BY peer,created_at DESC,message_id DESC)
      SELECT l.*,u.display_name,${ready('u')} AS ready,av.aggregate_version AS avatar_version,av.present AS avatar_present,
        EXISTS(SELECT 1 FROM member_interaction_blocks b WHERE b.community_id=$1 AND b.state='active'
          AND ((b.owner_ref=$2 AND b.target_ref=l.peer) OR (b.owner_ref=l.peer AND b.target_ref=$2))) AS blocked,
        (SELECT max(coalesce(s.last_seen_at,s.created_at)) FROM sessions s WHERE s.user_id=u.user_id) AS last_seen_at,
        EXISTS(SELECT 1 FROM sessions s WHERE s.user_id=u.user_id AND s.revoked_at IS NULL AND s.expires_at>now()
          AND s.last_seen_at>now()-interval '2 minutes') AS is_online,
        (SELECT count(*)::int FROM member_direct_messages d WHERE d.community_id=$1 AND d.recipient_ref=$2 AND d.sender_ref=l.peer AND d.read_at IS NULL AND d.retracted_at IS NULL) AS unread_count
      FROM latest l JOIN users u ON u.user_id=l.peer AND u.community_id=$1
      LEFT JOIN member_avatar_presence av ON av.user_id=u.user_id AND av.community_id=u.community_id
      ORDER BY l.created_at DESC,l.message_id DESC LIMIT $3 OFFSET $4`,[actor.community_id,actor.user_id,limit+1,offset])).rows;
    const page=pageOf(rows,limit,offset);
    const contents=await messageContents(q,page.items,'direct',actor.user_id);
    return {unread_count:unread,next_offset:page.next_offset,items:page.items.map((row,index)=>({
      participant:{user_id:row.peer,display_name:row.display_name,avatar_url:row.ready?avatarUrl(row.peer,row.avatar_version??'1',Boolean(row.avatar_present)):null,
        last_seen_at:row.last_seen_at?new Date(row.last_seen_at).toISOString():null,is_online:row.is_online},
      can_send:viewerReady&&row.ready&&!row.blocked,last_message:{...message(row),...contents[index]},unread_count:row.unread_count}))};
  });
}

export async function conversationMessages(pool:Pool,actor:Actor,rawPeer:string,raw:unknown):Promise<MessagePage>{
  const {limit,offset}=CommunicationPageQuery.parse(raw),id=peerId(actor,rawPeer);
  return snapshot(pool,actor,async q=>{
    const peer=await resolvePeer(q,actor,id);
    const unread=(await q.query('SELECT count(*)::int AS n FROM member_direct_messages WHERE community_id=$1 AND recipient_ref=$2 AND sender_ref=$3 AND read_at IS NULL AND retracted_at IS NULL',[actor.community_id,actor.user_id,id])).rows[0].n;
    const rows=(await q.query(`SELECT message_id,sender_ref,recipient_ref,body,created_at,read_at,sticker_id,reply_to_message_id,retracted_at FROM member_direct_messages
      WHERE community_id=$1 AND least(sender_ref,recipient_ref)=least($2::uuid,$3::uuid) AND greatest(sender_ref,recipient_ref)=greatest($2::uuid,$3::uuid)
      ORDER BY created_at DESC,message_id DESC LIMIT $4 OFFSET $5`,[actor.community_id,actor.user_id,id,limit+1,offset])).rows;
    const page=pageOf(rows,limit,offset),contents=await messageContents(q,page.items,'direct',actor.user_id);
    return {participant:peer.participant,can_send:peer.ready&&peer.viewer_ready&&!peer.blocked,items:page.items.map((row,index)=>({...message(row),...contents[index]})),unread_count:unread,next_offset:page.next_offset};
  });
}

export async function conversationActivity(pool:Pool,actor:Actor,rawPeer:string,raw:unknown={}):Promise<ConversationActivity>{
  Empty.parse(raw);const id=peerId(actor,rawPeer);
  return snapshot(pool,actor,async q=>{
    const peer=await resolvePeer(q,actor,id);
    const row=(await q.query(`SELECT
      (SELECT message_id FROM member_direct_messages WHERE community_id=$1
        AND least(sender_ref,recipient_ref)=least($2::uuid,$3::uuid) AND greatest(sender_ref,recipient_ref)=greatest($2::uuid,$3::uuid)
        ORDER BY created_at DESC,message_id DESC LIMIT 1) AS last_message_id,
      (SELECT count(*)::int FROM member_direct_messages WHERE community_id=$1 AND recipient_ref=$2 AND sender_ref=$3 AND read_at IS NULL AND retracted_at IS NULL) AS unread_count,
      (SELECT json_build_object('message_id',message_id,'read_at',read_at) FROM member_direct_messages
        WHERE community_id=$1 AND sender_ref=$2 AND recipient_ref=$3 AND retracted_at IS NULL
        ORDER BY created_at DESC,message_id DESC LIMIT 1) AS last_outgoing`,
      [actor.community_id,actor.user_id,id])).rows[0];
    return {last_message_id:row.last_message_id,unread_count:row.unread_count,can_send:peer.ready&&peer.viewer_ready&&!peer.blocked,
      last_outgoing:row.last_outgoing?{message_id:row.last_outgoing.message_id,read_at:iso(row.last_outgoing.read_at)}:null};
  });
}

export async function searchConversationMessages(pool:Pool,actor:Actor,rawPeer:string,raw:unknown):Promise<MessageSearchPage<Message>>{
  const {q:query,limit,cursor}=MessageSearchQuery.parse(raw),id=peerId(actor,rawPeer);
  return snapshot(pool,actor,async q=>{
    await resolvePeer(q,actor,id);
    return boundedMessageSearch(q,async()=>{
      // Resolve the cursor from this same pair, keeping PostgreSQL microseconds.
      // A cursor from another conversation never provides a pagination boundary.
      if(cursor)requireCondition((await q.query(`SELECT 1 FROM member_direct_messages WHERE message_id=$1 AND community_id=$2
        AND least(sender_ref,recipient_ref)=least($3::uuid,$4::uuid) AND greatest(sender_ref,recipient_ref)=greatest($3::uuid,$4::uuid)`,
        [cursor,actor.community_id,actor.user_id,id])).rowCount===1,404,'message_not_found','找不到這則訊息。');
      const rows=(await q.query(`SELECT message_id,sender_ref,recipient_ref,body,created_at,read_at,sticker_id,reply_to_message_id,retracted_at FROM member_direct_messages
        WHERE community_id=$1 AND least(sender_ref,recipient_ref)=least($2::uuid,$3::uuid) AND greatest(sender_ref,recipient_ref)=greatest($2::uuid,$3::uuid)
          AND retracted_at IS NULL AND body ILIKE $4 AND ($5::uuid IS NULL OR (created_at,message_id)<(SELECT created_at,message_id FROM member_direct_messages WHERE message_id=$5))
        ORDER BY created_at DESC,message_id DESC LIMIT $6`,[actor.community_id,actor.user_id,id,messageSearchPattern(query),cursor??null,limit+1])).rows;
      const shown=rows.slice(0,limit),contents=await messageContents(q,shown,'direct',actor.user_id);
      return {items:shown.map((row,index)=>({...message(row),...contents[index]})),next_cursor:rows.length>limit?shown[shown.length-1].message_id:null};
    });
  });
}

/** `messageImages` is the installed image feature; without it image_id is refused as not found. */
export async function sendDirectMessage(pool:Pool,input:Command,rawPeer:string,options:{messageImages?:boolean}={}):Promise<Message>{
  const body=MessageInput.parse(input.body),id=peerId(input.actor,rawPeer);
  if(body.image_id!==undefined)requireCondition(options.messageImages===true,404,'not_found','找不到這個頁面。');
  // Receipts keep only the message id; replay rereads the sender's own row, so
  // message text never enters command receipts, journals or logs.
  const sent=await command(pool,input,async q=>{
    await lockInteractionPair(q,input.actor,id);
    await assertCanContact(q,input.actor,id);
    // Current eligibility is rechecked before any replay. The command already
    // holds the sender row FOR SHARE; SHARE on the recipient cannot deadlock a
    // reciprocal send and still blocks a concurrent suspension until commit.
    await currentMember(q,input.actor,false);
    const recipient=await q.query(`SELECT 1 FROM users u WHERE u.user_id=$1 AND u.community_id=$2 AND ${ready('u')} FOR SHARE`,[id,input.actor.community_id]);
    if(recipient.rowCount!==1){
      const peer=await resolvePeer(q,input.actor,id);
      requireCondition(false,409,'recipient_unavailable','目前無法與這位會員聯絡。');
    }
    if(body.reply_to_message_id)requireCondition((await q.query(`SELECT 1 FROM member_direct_messages WHERE message_id=$1 AND community_id=$2
      AND least(sender_ref,recipient_ref)=least($3::uuid,$4::uuid) AND greatest(sender_ref,recipient_ref)=greatest($3::uuid,$4::uuid)`,
      [body.reply_to_message_id,input.actor.community_id,input.actor.user_id,id])).rowCount===1,404,'reply_not_available','找不到可回覆的訊息。');
  },async q=>{
    // Serialize one sender's sends so concurrent requests cannot exceed the budget.
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`direct-message-sender/${input.actor.community_id}/${input.actor.user_id}`]);
    await assertCurrentSessionClock(q,input.actor);
    const recent=(await q.query(`SELECT count(*)::int AS n FROM member_direct_messages WHERE community_id=$1 AND sender_ref=$2 AND created_at>clock_timestamp()-make_interval(secs=>$3)`,
      [input.actor.community_id,input.actor.user_id,DIRECT_MESSAGE_RATE_WINDOW_SECONDS])).rows[0].n;
    requireCondition(recent<DIRECT_MESSAGE_RATE_LIMIT,429,'message_rate_limited','訊息傳送太頻繁，請稍後再試。');
    if(body.image_id){
      // The draft must be this sender's own ready upload for exactly this recipient and not yet sent.
      // The sidecar's composite key and UNIQUE(message_id) repeat these facts for concurrent sends.
      const image=(await q.query(`SELECT t.message_id FROM member_message_image_asset_targets t JOIN assets a ON a.asset_id=t.asset_id AND a.purpose='member.message-image' AND a.state='ready' AND a.deletion_fence=0
        WHERE t.image_id=$1 AND t.community_id=$2 AND t.owner_user_id=$3 AND t.recipient_user_id=$4 AND t.asset_id IS NOT NULL FOR UPDATE OF t`,[body.image_id,input.actor.community_id,input.actor.user_id,id])).rows[0];
      requireCondition(image,404,'image_not_available','找不到可傳送的圖片，請重新選擇。');
      requireCondition(image.message_id===null,409,'image_already_sent','這張圖片已經傳送過，請重新選擇。');
    }
    const row=(await q.query('INSERT INTO member_direct_messages(community_id,sender_ref,recipient_ref,body,sticker_id,reply_to_message_id,created_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()) RETURNING message_id',
      [input.actor.community_id,input.actor.user_id,id,storedMessageBody(body),body.sticker_id??null,body.reply_to_message_id??null])).rows[0];
    // Attach in the same transaction; the sidecar's composite key repeats sender, recipient and community.
    if(body.image_id)requireCondition((await q.query('UPDATE member_message_image_asset_targets SET message_id=$2 WHERE image_id=$1 AND message_id IS NULL',[body.image_id,row.message_id])).rowCount===1,409,'image_already_sent','這張圖片已經傳送過，請重新選擇。');
    return {message_id:row.message_id as string};
  },async q=>{await currentMember(q,input.actor,false);await assertCanContact(q,input.actor,id);});
  return snapshot(pool,input.actor,async q=>{
    const row=(await q.query('SELECT message_id,sender_ref,recipient_ref,body,created_at,read_at,sticker_id,reply_to_message_id,retracted_at FROM member_direct_messages WHERE message_id=$1 AND community_id=$2 AND sender_ref=$3',
      [sent.message_id,input.actor.community_id,input.actor.user_id])).rows[0];
    requireCondition(row,404,'message_not_found','找不到這則訊息。');
    return {...message(row),...(await messageContents(q,[row],'direct',input.actor.user_id))[0]};
  });
}

export async function markConversationRead(pool:Pool,input:Command,rawPeer:string){
  const {through_message_id}=ConversationReadInput.parse(input.body),through=through_message_id?.toLowerCase(),id=peerId(input.actor,rawPeer);
  return command(pool,input,async q=>{
    await currentMember(q,input.actor,false);await resolvePeer(q,input.actor,id);
    if(through)requireCondition((await q.query(`SELECT 1 FROM member_direct_messages WHERE message_id=$1 AND community_id=$2
      AND least(sender_ref,recipient_ref)=least($3::uuid,$4::uuid) AND greatest(sender_ref,recipient_ref)=greatest($3::uuid,$4::uuid)`,
      [through,input.actor.community_id,input.actor.user_id,id])).rowCount===1,404,'message_not_found','找不到這則訊息。');
  },async q=>{
    // Opening a thread marks only through its displayed snapshot. A later arrival stays unread.
    // The empty-body legacy command remains compatible; the portal always supplies a boundary.
    const row=(await q.query(`WITH marked AS (UPDATE member_direct_messages SET read_at=now()
        WHERE community_id=$1 AND recipient_ref=$2 AND sender_ref=$3 AND read_at IS NULL
          AND ($4::uuid IS NULL OR (created_at,message_id)<=(SELECT created_at,message_id FROM member_direct_messages WHERE message_id=$4)) RETURNING 1)
      SELECT now() AS read_at,(SELECT count(*)::int FROM marked) AS updated_count`,[input.actor.community_id,input.actor.user_id,id,through??null])).rows[0];
    return {user_id:id,read_at:iso(row.read_at)!,updated_count:row.updated_count as number};
  });
}

export type MessageRetraction={message_id:string;retracted_at:string};
/** Only the sender retracts, at any time. The row stays for ordering and read
 * cursors; replaying the receipt or retracting twice returns the same stamp. */
export async function retractDirectMessage(pool:Pool,input:Command,rawPeer:string,rawMessageId:string):Promise<MessageRetraction>{
  Empty.parse(input.body);
  const id=peerId(input.actor,rawPeer),messageId=rawMessageId.toLowerCase();
  requireCondition(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(messageId),404,'message_not_found','找不到這則訊息。');
  return command(pool,input,async q=>{
    await currentMember(q,input.actor,false);
    const row=(await q.query('SELECT sender_ref FROM member_direct_messages WHERE message_id=$1 AND community_id=$2 AND ((sender_ref=$3 AND recipient_ref=$4) OR (sender_ref=$4 AND recipient_ref=$3))',
      [messageId,input.actor.community_id,input.actor.user_id,id])).rows[0];
    requireCondition(row,404,'message_not_found','找不到這則訊息。');
    requireCondition(row.sender_ref===input.actor.user_id,403,'message_not_own','只能收回自己傳送的訊息。');
  },async q=>{
    const row=(await q.query(`UPDATE member_direct_messages SET retracted_at=COALESCE(retracted_at,clock_timestamp())
      WHERE message_id=$1 AND community_id=$2 AND sender_ref=$3 AND recipient_ref=$4 RETURNING retracted_at`,[messageId,input.actor.community_id,input.actor.user_id,id])).rows[0];
    return {message_id:messageId,retracted_at:iso(row.retracted_at)!};
  });
}
