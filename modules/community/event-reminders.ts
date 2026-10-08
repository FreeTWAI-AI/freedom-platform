import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {checkVersion,command,digest,transaction,type Command} from '../../packages/db/index.js';
import {Problem,requireCondition} from '../../packages/shared/problem.js';
import type {Actor} from '../identity-membership/service.js';
import {readEvent,type EventEmailSender} from './events.js';
import {resolveGuestParticipation,resolveGuestParticipationByEmail} from './event-waitlist.js';
import {notifyMember} from '../member-communications/notifications.js';
import {isNotificationQuietHours} from '../member-communications/notification-preferences.js';

type Query=Pool|PoolClient;
type Identity={member_ref:string;guest_email?:never}|{guest_email:string;member_ref?:never};
const options=z.object({enabled:z.boolean(),minutes_before_start:z.number().int().positive().refine(Number.isSafeInteger).optional(),channel:z.enum(['in_app','email']).optional()}).strict().refine(b=>!b.enabled||(b.minutes_before_start!==undefined&&b.channel!==undefined),'請選擇提前時間與提醒方式。');
const guestOptions=options;
export interface EventReminder {version:number;enabled:boolean;minutes_before_start:number|null;channel:'in_app'|'email'|null;status:'pending'|'provider_accepted'|'recorded'|'cancelled'|'failed'|null}
function view(row:any):EventReminder{return {version:Number(row?.aggregate_version??1),enabled:row?.enabled??false,minutes_before_start:row?Number(row.minutes_before_start):null,channel:row?.channel??null,status:row?.status??null};}
async function own(q:Query,id:string,identity:Identity){return (await q.query('SELECT * FROM community_event_reminders WHERE event_id=$1 AND member_ref IS NOT DISTINCT FROM $2 AND guest_email IS NOT DISTINCT FROM $3',[id,identity.member_ref??null,identity.guest_email??null])).rows[0];}
async function eventLock(q:PoolClient,id:string){return (await q.query('SELECT * FROM community_events WHERE event_id=$1 FOR UPDATE',[id])).rows[0];}
async function memberSource(q:Query,actor:Actor,id:string){const event=await readEvent(q,actor,id,true);return {event,going:event.my_rsvp==='going'};}
async function save(q:PoolClient,event:any,identity:Identity,body:z.infer<typeof options>,expected?:number|string){
  const row=await own(q,event.event_id,identity);if(expected!==undefined)checkVersion(String(row?.aggregate_version??1),String(expected));
  if(!body.enabled){if(row)await q.query("UPDATE community_event_reminders SET enabled=false,status='cancelled',aggregate_version=aggregate_version+1,updated_at=now() WHERE reminder_id=$1",[row.reminder_id]);return view(await own(q,event.event_id,identity));}
  requireCondition(event.state==='published'&&new Date(event.starts_at).getTime()>Date.now(),409,'event_closed','活動已開始或取消。');
  requireCondition(!identity.guest_email||body.channel==='email',422,'guest_email_required','訪客提醒僅支援電子郵件。');
  // Lead duration can exceed Date's range even though the integer itself is safe.
  const due=new Date(new Date(event.starts_at).getTime()-body.minutes_before_start!*60000);
  requireCondition(Number.isFinite(due.getTime())&&due.getUTCFullYear()>=1&&due.getUTCFullYear()<=9999,422,'invalid_reminder_time','提前時間超出可支援範圍。');
  const id=row?.reminder_id??randomUUID();
  const prior=(await q.query('SELECT status FROM community_event_reminder_attempts WHERE reminder_id=$1 AND starts_at=$2 AND minutes_before_start=$3 AND channel=$4',[id,event.starts_at,body.minutes_before_start,body.channel])).rows[0];
  // Version 1 describes an absent choice; the first write must consume it too.
  await q.query(`INSERT INTO community_event_reminders(reminder_id,event_id,member_ref,guest_email,minutes_before_start,channel,enabled,status,event_version,starts_at,due_at,aggregate_version)
    VALUES($1,$2,$3,$4,$5,$6,true,$7,$8,$9,$10,2) ON CONFLICT(reminder_id) DO UPDATE SET minutes_before_start=EXCLUDED.minutes_before_start,channel=EXCLUDED.channel,
    enabled=true,status=EXCLUDED.status,event_version=EXCLUDED.event_version,starts_at=EXCLUDED.starts_at,due_at=EXCLUDED.due_at,aggregate_version=community_event_reminders.aggregate_version+1,updated_at=now()`,
    [id,event.event_id,identity.member_ref??null,identity.guest_email??null,body.minutes_before_start,body.channel,prior?.status??'pending',event.aggregate_version,event.starts_at,due]);
  return view(await own(q,event.event_id,identity));
}
export async function readEventReminder(pool:Pool,actor:Actor,id:string):Promise<EventReminder>{await memberSource(pool,actor,id);return view(await own(pool,id,{member_ref:actor.user_id}));}
export async function saveEventReminder(pool:Pool,input:Command,id:string){
  const body=options.parse(input.body);
  requireCondition(input.expected,428,'version_required','請提供 If-Match 版本。');
  return command(pool,input,q=>memberSource(q,input.actor,id),async q=>{
    await eventLock(q,id);const source=await memberSource(q,input.actor,id);
    requireCondition(!body.enabled||source.going,409,'rsvp_required','請先確認參加活動。');
    return save(q,source.event,{member_ref:input.actor.user_id},body,input.expected);
  });
}
export async function readGuestEventReminder(pool:Pool,id:string,token:string){const source=await resolveGuestParticipation(pool,id,token);return view(await own(pool,id,{guest_email:source.email}));}
export async function saveGuestEventReminder(pool:Pool,id:string,token:string,raw:unknown){
  const parsed=z.object({command_id:z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/),expected_version:z.number().int().positive().refine(Number.isSafeInteger),enabled:z.boolean(),minutes_before_start:z.number().optional(),channel:z.enum(['email','in_app']).optional()}).strict().parse(raw);
  const {command_id,expected_version,...config}=parsed,body=guestOptions.parse(config),hash=digest({body,expected_version});
  return transaction(pool,async q=>{
    await eventLock(q,id);const source=await resolveGuestParticipation(q,id,token);
    const prior=(await q.query('SELECT payload_hash,result FROM community_event_reminder_receipts WHERE event_id=$1 AND guest_email=$2 AND command_id=$3',[id,source.email,command_id])).rows[0];
    if(prior){requireCondition(prior.payload_hash===hash,409,'idempotency_conflict','同一命令不可變更內容。');return prior.result;}
    requireCondition(!body.enabled||source.going,409,'rsvp_required','請先確認參加活動。');
    const result=await save(q,source.event,{guest_email:source.email},body,expected_version);
    await q.query('INSERT INTO community_event_reminder_receipts(event_id,guest_email,command_id,payload_hash,result) VALUES($1,$2,$3,$4,$5)',[id,source.email,command_id,hash,result]);return result;
  });
}
/** Called inside original registration's event-locked transaction; contains no capability. */
export async function configureGuestEventReminder(q:PoolClient,id:string,email:string,raw:unknown){if(raw===undefined)return;const body=options.parse(raw);const event=await eventLock(q,id);return save(q,event,{guest_email:email},body);}
export async function cancelEventReminders(q:PoolClient,id:string,identity?:Identity){
  await q.query(`UPDATE community_event_reminders SET enabled=false,status='cancelled',aggregate_version=aggregate_version+1,updated_at=now() WHERE event_id=$1 ${identity?'AND member_ref IS NOT DISTINCT FROM $2 AND guest_email IS NOT DISTINCT FROM $3':''} AND enabled`,identity?[id,identity.member_ref??null,identity.guest_email??null]:[id]);
}
export async function reconcileEventReminders(q:PoolClient,id:string,now:Date=new Date()){
  const event=await eventLock(q,id);if(!event||event.state!=='published'||new Date(event.starts_at).getTime()<=now.getTime())return cancelEventReminders(q,id);
  await q.query(`UPDATE community_event_reminders r SET starts_at=$2,event_version=$3,due_at=$2::timestamptz-r.minutes_before_start*interval '1 minute',
    status=COALESCE((SELECT a.status FROM community_event_reminder_attempts a WHERE a.reminder_id=r.reminder_id AND a.starts_at=$2 AND a.minutes_before_start=r.minutes_before_start AND a.channel=r.channel),'pending'),
    aggregate_version=aggregate_version+1,updated_at=now() WHERE event_id=$1 AND enabled AND (starts_at<>$2 OR event_version<>$3)`,[id,event.starts_at,event.aggregate_version]);
}

async function currentDispatchSource(q:PoolClient,row:any,now:Date){
  const event=await eventLock(q,row.event_id);
  if(!event||event.state!=='published'||new Date(event.starts_at).getTime()<=now.getTime())return null;
  if(row.guest_email){try{const source=await resolveGuestParticipationByEmail(q,row.event_id,row.guest_email);return source.going?{event:source.event,email:source.email}:null;}catch(error){if(error instanceof Problem&&error.status===404)return null;throw error;}}
  const user=(await q.query('SELECT * FROM users WHERE user_id=$1 AND community_id=$2 AND active AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL)',[row.member_ref,event.community_id])).rows[0];
  if(!user)return null;
  const actor:Actor={user_id:user.user_id,community_id:user.community_id,email:user.email,display_name:user.display_name,profession_membership_ref:user.profession_membership_ref,session_hash:'',csrf_token:''};
  try{const source=await memberSource(q,actor,row.event_id);return source.going?{event:source.event,email:user.email_verified_at?user.email:null}:null;}catch(error){if(error instanceof Problem&&error.status===404)return null;throw error;}
}
/** Bounded at-most-once provider handoff. Unknown provider outcomes are failed, never delivered or retried. */
export async function processEventReminders(pool:Pool,send:EventEmailSender,config:{enabled:boolean;now?:Date;limit?:number}){
  if(!config.enabled)return {processed:0};const now=config.now??new Date(),limit=Math.min(100,Math.max(1,config.limit??50));
  const candidates=(await pool.query("SELECT reminder_id,event_id FROM community_event_reminders WHERE enabled AND status='pending' AND due_at<=$1 ORDER BY due_at,reminder_id LIMIT $2",[now,limit])).rows;let processed=0;
  for(const candidate of candidates){
    const claim=await transaction(pool,async q=>{
      await eventLock(q,candidate.event_id);
      let row=(await q.query('SELECT * FROM community_event_reminders WHERE reminder_id=$1 FOR UPDATE',[candidate.reminder_id])).rows[0];
      if(!row?.enabled||row.status!=='pending')return null;
      await reconcileEventReminders(q,row.event_id,now);row=(await q.query('SELECT * FROM community_event_reminders WHERE reminder_id=$1',[row.reminder_id])).rows[0];
      if(!row.enabled||row.status!=='pending'||new Date(row.due_at).getTime()>now.getTime())return null;
      const source=await currentDispatchSource(q,row,now);
      if(!source){await cancelEventReminders(q,row.event_id,row.member_ref?{member_ref:row.member_ref}:{guest_email:row.guest_email});return null;}
      if(row.channel==='in_app'){
        const prefs=(await q.query('SELECT * FROM member_notification_preferences WHERE community_id=$1 AND owner_user_id=$2',[source.event.community_id,row.member_ref])).rows[0];
        if(prefs?.events_mode==='off'){await cancelEventReminders(q,row.event_id,{member_ref:row.member_ref});return null;}
        if(prefs&&isNotificationQuietHours({quiet_hours:{enabled:prefs.quiet_enabled,time_zone:prefs.time_zone,start:prefs.quiet_start,end:prefs.quiet_end}},now))return null;
      }
      if(row.channel==='email'&&!source.email){await cancelEventReminders(q,row.event_id,{member_ref:row.member_ref});return null;}
      const inserted=await q.query(`INSERT INTO community_event_reminder_attempts(reminder_id,starts_at,minutes_before_start,channel,status) VALUES($1,$2,$3,$4,'failed') ON CONFLICT DO NOTHING RETURNING reminder_id`,[row.reminder_id,row.starts_at,row.minutes_before_start,row.channel]);
      if(!inserted.rowCount){await q.query("UPDATE community_event_reminders SET status=(SELECT status FROM community_event_reminder_attempts WHERE reminder_id=$1 AND starts_at=$2 AND minutes_before_start=$3 AND channel=$4) WHERE reminder_id=$1",[row.reminder_id,row.starts_at,row.minutes_before_start,row.channel]);return null;}
      if(row.channel==='in_app'){
        await notifyMember(q,{community_id:source.event.community_id,recipient_ref:row.member_ref,kind:'event_start_reminder',source_key:`event-reminder/${row.reminder_id}/${new Date(row.starts_at).getTime()}/${row.minutes_before_start}/in_app`,title:'活動即將開始',body:'你選擇的活動提醒時間已到；請開啟活動查看目前資訊。',action:{tab:'events',resource_id:row.event_id}});
        await record(q,row,'recorded');return {recorded:true as const};
      }
      await q.query("UPDATE community_event_reminders SET status='failed',attempted_at=$2 WHERE reminder_id=$1",[row.reminder_id,now]);return row;
    });
    if(!claim)continue;if('recorded' in claim){processed++;continue;}
    await transaction(pool,async q=>{
      await eventLock(q,claim.event_id);
      await reconcileEventReminders(q,claim.event_id,config.now??new Date());
      const row=(await q.query('SELECT * FROM community_event_reminders WHERE reminder_id=$1 FOR UPDATE',[claim.reminder_id])).rows[0];
      if(!row.enabled||row.channel!==claim.channel||Number(row.minutes_before_start)!==Number(claim.minutes_before_start)||new Date(row.starts_at).getTime()!==new Date(claim.starts_at).getTime())return;
      const source=await currentDispatchSource(q,row,config.now??new Date());if(!source||!source.email){await cancelEventReminders(q,row.event_id,row.member_ref?{member_ref:row.member_ref}:{guest_email:row.guest_email});return;}
      let status:'provider_accepted'|'failed'='provider_accepted';
      try{await send(source.email,'自由工坊：活動即將開始',`你選擇的活動提醒時間已到。\n活動：${source.event.title}\n開始時間（UTC）：${new Date(source.event.starts_at).toISOString()}\n請回到活動頁查看目前參與資訊。`);}catch{status='failed';}
      await record(q,row,status);
    });processed++;
  }
  return {processed};
}
async function record(q:PoolClient,row:any,status:'provider_accepted'|'recorded'|'failed'){
  await q.query('UPDATE community_event_reminder_attempts SET status=$5 WHERE reminder_id=$1 AND starts_at=$2 AND minutes_before_start=$3 AND channel=$4',[row.reminder_id,row.starts_at,row.minutes_before_start,row.channel,status]);
  await q.query('UPDATE community_event_reminders SET status=$2,processed_at=now(),updated_at=now() WHERE reminder_id=$1',[row.reminder_id,status]);
}
