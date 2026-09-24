import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {command,type Command} from '../../packages/db/index.js';
import {Problem,requireCondition} from '../../packages/shared/problem.js';
import type {Actor} from '../identity-membership/service.js';
import {lockMemberGuilds} from '../positioning/onboarding.js';
import {
  CHANNEL_KINDS,CHANNEL_KEY_MAX,CHANNEL_MESSAGE_BODY_MAX,CHANNEL_NOT_AVAILABLE,CHANNEL_PAGE_DEFAULT_LIMIT,CHANNEL_PAGE_MAX_LIMIT,CHANNEL_PAGE_MAX_OFFSET,
  GUILD_CHANNEL_KEY_PATTERN,
  type Channel,type ChannelKind,type ChannelList,type ChannelMessage,type ChannelMessagePage,type ChannelReadResult,type ChannelSummary,
} from './channel-types.js';

// Guild/squad group channels (migration 037). A room exists for every current
// active guild or squad membership; access is always rechecked from locked
// membership rows, never from the channel row, the Actor snapshot or a receipt.
// Lock order: user -> session -> membership -> sender budget -> channel.

const page={
  limit:z.coerce.number().int().min(1).max(CHANNEL_PAGE_MAX_LIMIT).default(CHANNEL_PAGE_DEFAULT_LIMIT),
  offset:z.coerce.number().int().min(0).max(CHANNEL_PAGE_MAX_OFFSET).default(0),
};
export const ChannelListQuery=z.object({kind:z.enum(CHANNEL_KINDS),...page}).strict();
export const ChannelPageQuery=z.object(page).strict();
// Plain text only, same rules as direct messages: stored and returned verbatim
// after trimming; length counts code points like PostgreSQL.
const ChannelMessageInput=z.object({
  body:z.string().transform(value=>value.replace(/\r\n?/g,'\n').trim())
    .refine(value=>value.length>0,'請輸入訊息內容。')
    .refine(value=>[...value].length<=CHANNEL_MESSAGE_BODY_MAX,`訊息最多 ${CHANNEL_MESSAGE_BODY_MAX} 字。`)
    .refine(value=>!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value),'訊息不可包含控制字元。'),
}).strict();
const ChannelReadInput=z.object({through_message_id:z.uuid()}).strict();
/** Shared by guild and squad sends; replays neither count nor are blocked. */
export const CHANNEL_MESSAGE_RATE_LIMIT=20,CHANNEL_MESSAGE_RATE_WINDOW_SECONDS=60;

const SQUAD_KEY_INPUT=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUSTOM_GUILD_PREFIX='guild_custom_';
const ready=(alias:string)=>`${alias}.active AND (NOT ${alias}.onboarding_required OR ${alias}.onboarding_completed_at IS NOT NULL)`;
const iso=(value:Date|string)=>new Date(value).toISOString();
const notAvailable=()=>new Problem(404,CHANNEL_NOT_AVAILABLE,'找不到這個頻道，或你目前不是成員。');

type Room={kind:ChannelKind;key:string};
/** Guild keys keep their case (exact catalog match); squad UUIDs are lowercased. */
function room(rawKind:string,rawKey:string):Room{
  const kind=z.enum(CHANNEL_KINDS).parse(rawKind);
  const key=z.string().min(1).max(CHANNEL_KEY_MAX)
    .refine(value=>kind==='guild'?GUILD_CHANNEL_KEY_PATTERN.test(value):SQUAD_KEY_INPUT.test(value),'頻道代碼格式不正確。').parse(rawKey);
  return {kind,key:kind==='squad'?key.toLowerCase():key};
}

/**
 * Live eligibility from the locked user row, never the Actor snapshot; same as
 * service.ts. Commands already hold user and session, so they pass session=false.
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
 * One REPEATABLE READ snapshot starting with the user/session share locks. The
 * membership rows are then locked FOR SHARE, so a leave committed while the
 * advisory lock waited raises 40001 and the read reruns fresh. GET never writes;
 * only this read path retries.
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

// Custom guild keys come from a global catalog today, so they count only with an
// approved creation application in the viewer's community.
const guildScope=`(m.guild_key NOT LIKE '${CUSTOM_GUILD_PREFIX}%' OR EXISTS(SELECT 1 FROM guild_creation_applications a
  WHERE a.state='approved' AND a.approved_guild_key=m.guild_key AND a.community_id=m.community_id))`;
const squadLock=(squadId:string,userId:string)=>`squad-membership/${squadId}/${userId}`;
const advisory=(q:PoolClient,name:string)=>q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[name]);

/** Locks and returns the viewer's active membership of one room, else 404. */
async function lockRoom(q:PoolClient,actor:Actor,{kind,key}:Room):Promise<Channel>{
  let row:{name:string}|undefined;
  if(kind==='guild'){
    await lockMemberGuilds(q,actor);
    row=(await q.query(`SELECT g.name FROM positioning_profession_memberships m JOIN positioning_guild_catalog g ON g.guild_key=m.guild_key
      WHERE m.community_id=$1 AND m.user_id=$2 AND m.guild_key=$3 AND m.state='active' AND ${guildScope} FOR SHARE OF m`,[actor.community_id,actor.user_id,key])).rows[0];
  }else{
    await advisory(q,squadLock(key,actor.user_id));
    row=(await q.query(`SELECT s.name FROM member_squad_memberships m JOIN member_squads s ON s.squad_id=m.squad_id
      WHERE m.squad_id=$1 AND m.user_id=$2 AND m.state='active' AND s.community_id=$3 FOR SHARE OF m`,[key,actor.user_id,actor.community_id])).rows[0];
  }
  if(!row)throw notAvailable();
  return {kind,channel_key:key,name:row.name};
}

/** Every active room of one kind, membership rows locked FOR SHARE. */
async function lockRooms(q:PoolClient,actor:Actor,kind:ChannelKind):Promise<Channel[]>{
  if(kind==='guild'){
    await lockMemberGuilds(q,actor);
    return (await q.query(`SELECT g.guild_key AS channel_key,g.name FROM positioning_profession_memberships m JOIN positioning_guild_catalog g ON g.guild_key=m.guild_key
      WHERE m.community_id=$1 AND m.user_id=$2 AND m.state='active' AND ${guildScope} ORDER BY m.guild_key FOR SHARE OF m`,[actor.community_id,actor.user_id])).rows
      .map(row=>({kind,channel_key:row.channel_key,name:row.name}));
  }
  // Candidates unlocked in a stable order, then each pair lock before its row
  // lock (the order membership writers use), so no advisory/row inversion.
  const candidates=(await q.query(`SELECT m.squad_id FROM member_squad_memberships m JOIN member_squads s ON s.squad_id=m.squad_id
    WHERE m.user_id=$1 AND m.state='active' AND s.community_id=$2 ORDER BY m.squad_id`,[actor.user_id,actor.community_id])).rows.map(row=>row.squad_id as string);
  const rooms:Channel[]=[];
  for(const squadId of candidates){
    await advisory(q,squadLock(squadId,actor.user_id));
    const row=(await q.query(`SELECT s.name FROM member_squad_memberships m JOIN member_squads s ON s.squad_id=m.squad_id
      WHERE m.squad_id=$1 AND m.user_id=$2 AND m.state='active' AND s.community_id=$3 FOR SHARE OF m`,[squadId,actor.user_id,actor.community_id])).rows[0];
    if(row)rooms.push({kind,channel_key:squadId,name:row.name});
  }
  return rooms;
}

// Unread: others' messages above the viewer's cursor (absent cursor = 0).
const unreadSql=`(SELECT count(*)::int FROM member_channel_messages x WHERE x.community_id=$1 AND x.kind=$2 AND x.channel_key=r.channel_key AND x.sender_ref<>$3
  AND x.sequence>COALESCE((SELECT d.last_read_sequence FROM member_channel_reads d WHERE d.community_id=$1 AND d.kind=$2 AND d.channel_key=r.channel_key AND d.user_id=$3),0))`;
const messageColumns=`m.message_id,m.kind,m.channel_key,m.sequence::text AS sequence,m.sender_ref,u.display_name AS sender_name,m.body,m.created_at`;
function message(row:any):ChannelMessage{
  return {message_id:row.message_id,kind:row.kind,channel_key:row.channel_key,sequence:row.sequence,sender_ref:row.sender_ref,sender_name:row.sender_name,body:row.body,created_at:iso(row.created_at)};
}

export async function listChannels(pool:Pool,actor:Actor,raw:unknown):Promise<ChannelList>{
  const {kind,limit,offset}=ChannelListQuery.parse(raw);
  return snapshot(pool,actor,async q=>{
    const rooms=await lockRooms(q,actor,kind);
    // Counts and last activity only; no message body is read for the list.
    const stats=new Map((await q.query(`SELECT r.channel_key,${unreadSql} AS unread_count,
        (SELECT x.created_at FROM member_channel_messages x JOIN member_chat_channels c USING (community_id,kind,channel_key)
          WHERE x.community_id=$1 AND x.kind=$2 AND x.channel_key=r.channel_key AND x.sequence=c.last_sequence) AS last_message_at
      FROM unnest($4::text[]) AS r(channel_key)`,[actor.community_id,kind,actor.user_id,rooms.map(r=>r.channel_key)])).rows.map(row=>[row.channel_key as string,row]));
    const items:ChannelSummary[]=rooms.map(r=>{const s=stats.get(r.channel_key);
      return {...r,unread_count:s?.unread_count??0,last_message_at:s?.last_message_at?iso(s.last_message_at):null};});
    items.sort((a,b)=>a.last_message_at!==b.last_message_at
      ?(a.last_message_at===null?1:b.last_message_at===null?-1:a.last_message_at<b.last_message_at?1:-1)
      :a.channel_key<b.channel_key?-1:a.channel_key>b.channel_key?1:0);
    return {items:items.slice(offset,offset+limit),unread_count:items.reduce((n,item)=>n+item.unread_count,0),
      next_offset:items.length>offset+limit?offset+limit:null};
  });
}

export async function channelMessages(pool:Pool,actor:Actor,rawKind:string,rawKey:string,raw:unknown):Promise<ChannelMessagePage>{
  const target=room(rawKind,rawKey),{limit,offset}=ChannelPageQuery.parse(raw);
  return snapshot(pool,actor,async q=>{
    const channel=await lockRoom(q,actor,target);
    const unread=(await q.query(`SELECT ${unreadSql} AS n FROM (SELECT $4::text AS channel_key) r`,[actor.community_id,target.kind,actor.user_id,target.key])).rows[0].n;
    const rows=(await q.query(`SELECT ${messageColumns} FROM member_channel_messages m JOIN users u ON u.user_id=m.sender_ref
      WHERE m.community_id=$1 AND m.kind=$2 AND m.channel_key=$3 ORDER BY m.sequence DESC LIMIT $4 OFFSET $5`,
      [actor.community_id,target.kind,target.key,limit+1,offset])).rows;
    return {channel,items:rows.slice(0,limit).map(message),unread_count:unread,next_offset:rows.length>limit?offset+limit:null};
  });
}

export async function sendChannelMessage(pool:Pool,input:Command,rawKind:string,rawKey:string):Promise<ChannelMessage>{
  const target=room(rawKind,rawKey),body=ChannelMessageInput.parse(input.body),actor=input.actor;
  // Receipts keep only the message id, so message text never enters command
  // receipts, journals or outbox. Membership is rechecked before any replay.
  const sent=await command(pool,input,async q=>{await currentMember(q,actor,false);await lockRoom(q,actor,target);},async q=>{
    // One budget per sender across both kinds; serialized so concurrent sends cannot exceed it.
    await advisory(q,`member-channel-sender/${actor.community_id}/${actor.user_id}`);
    const recent=(await q.query(`SELECT count(*)::int AS n FROM member_channel_messages WHERE community_id=$1 AND sender_ref=$2 AND created_at>clock_timestamp()-make_interval(secs=>$3)`,
      [actor.community_id,actor.user_id,CHANNEL_MESSAGE_RATE_WINDOW_SECONDS])).rows[0].n;
    requireCondition(recent<CHANNEL_MESSAGE_RATE_LIMIT,429,'message_rate_limited','訊息傳送太頻繁，請稍後再試。');
    // Sequence allocation and the message insert share this lock and transaction,
    // so a higher sequence never commits before a lower one.
    await advisory(q,`member-channel/${actor.community_id}/${target.kind}/${target.key}`);
    await q.query('INSERT INTO member_chat_channels(community_id,kind,channel_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[actor.community_id,target.kind,target.key]);
    const sequence=(await q.query('UPDATE member_chat_channels SET last_sequence=last_sequence+1 WHERE community_id=$1 AND kind=$2 AND channel_key=$3 RETURNING last_sequence',
      [actor.community_id,target.kind,target.key])).rows[0].last_sequence;
    const row=(await q.query(`INSERT INTO member_channel_messages(community_id,kind,channel_key,sequence,sender_ref,body,created_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()) RETURNING message_id`,
      [actor.community_id,target.kind,target.key,sequence,actor.user_id,body.body])).rows[0];
    return {message_id:row.message_id as string};
  });
  // Read back under a fresh membership check, so a leave after the write cannot
  // be answered from history.
  return snapshot(pool,actor,async q=>{
    await lockRoom(q,actor,target);
    const row=(await q.query(`SELECT ${messageColumns} FROM member_channel_messages m JOIN users u ON u.user_id=m.sender_ref
      WHERE m.message_id=$1 AND m.community_id=$2 AND m.kind=$3 AND m.channel_key=$4 AND m.sender_ref=$5`,
      [sent.message_id,actor.community_id,target.kind,target.key,actor.user_id])).rows[0];
    requireCondition(row,404,'channel_message_not_found','找不到這則訊息。');
    return message(row);
  });
}

export async function markChannelRead(pool:Pool,input:Command,rawKind:string,rawKey:string):Promise<ChannelReadResult>{
  const target=room(rawKind,rawKey),through=ChannelReadInput.parse(input.body).through_message_id.toLowerCase(),actor=input.actor;
  return command(pool,input,async q=>{await currentMember(q,actor,false);await lockRoom(q,actor,target);},async q=>{
    await advisory(q,`member-channel/${actor.community_id}/${target.kind}/${target.key}`);
    const seen=(await q.query('SELECT sequence FROM member_channel_messages WHERE message_id=$1 AND community_id=$2 AND kind=$3 AND channel_key=$4',
      [through,actor.community_id,target.kind,target.key])).rows[0];
    requireCondition(seen,404,'channel_message_not_found','找不到這則訊息。');
    // Monotonic: never moves back, and read_at changes only when it advances.
    const row=(await q.query(`INSERT INTO member_channel_reads AS d(community_id,kind,channel_key,user_id,last_read_sequence,read_at) VALUES($1,$2,$3,$4,$5,clock_timestamp())
      ON CONFLICT (community_id,kind,channel_key,user_id) DO UPDATE SET last_read_sequence=GREATEST(d.last_read_sequence,EXCLUDED.last_read_sequence),
        read_at=CASE WHEN EXCLUDED.last_read_sequence>d.last_read_sequence THEN EXCLUDED.read_at ELSE d.read_at END
      RETURNING last_read_sequence::text AS read_sequence,read_at`,[actor.community_id,target.kind,target.key,actor.user_id,seen.sequence])).rows[0];
    return {kind:target.kind,channel_key:target.key,read_sequence:row.read_sequence as string,read_at:iso(row.read_at)};
  });
}
