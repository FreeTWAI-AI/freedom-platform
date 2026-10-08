import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {checkVersion,command,digest,journal,transaction,type Command} from '../../packages/db/index.js';
import {Problem,requireCondition} from '../../packages/shared/problem.js';
import {isoTime,text} from '../../packages/shared/validation.js';
import type {Actor} from '../identity-membership/service.js';
import {canAccessGuildEvent,refuseInternGuildExchange,type EventEmailSender} from './events.js';
import {notifyMember} from '../member-communications/notifications.js';
import {cancelEventReminders,reconcileEventReminders} from './event-reminders.js';

type Query=Pool|PoolClient;
export type EventParticipationIdentity={member_ref:string;guest_email?:never}|{guest_email:string;member_ref?:never};
const referral=z.string().regex(/^[A-Za-z0-9_-]{16,32}$/).nullable().optional();
const actionInput=z.object({action:z.enum(['join','leave','accept','decline']),referral_code:referral}).strict();
const guestInput=z.object({action:z.enum(['join','leave','accept','decline','cancel','register']),referral_code:referral,expected_version:z.union([z.string(),z.number().int().positive().refine(Number.isSafeInteger)])}).strict();
const policyInput=z.object({waitlist_enabled:z.boolean(),response_window_minutes:z.number().int().positive().refine(Number.isSafeInteger).nullable()}).strict().refine(b=>!b.waitlist_enabled||b.response_window_minutes!==null,'請明確設定候補回覆分鐘數。');
const scheduleInput=z.object({starts_at:isoTime,ends_at:isoTime,capacity:z.number().int().min(1).max(500).nullable()}).strict().refine(b=>Date.parse(b.ends_at)>Date.parse(b.starts_at),'結束時間须晚於開始時間。');
export interface EventParticipation {event_id:string;event_version:number;event_state:'pending'|'published'|'rejected'|'cancelled';starts_at:string;waitlist_enabled:boolean;response_window_minutes:number|null;rsvp_state:'pending'|'going'|'cancelled'|null;waitlist:null|{status:string;aggregate_version:number;joined_at:string;invited_at:string|null;expires_at:string|null;delivery_status:string};available_seats:number|null}
const instant=(value:Date|string)=>new Date(value).getTime();
const json=<T>(value:T):T=>JSON.parse(JSON.stringify(value)) as T;
async function eventRow(q:Query,id:string,lock=false){const row=(await q.query(`SELECT * FROM community_events WHERE event_id=$1${lock?' FOR UPDATE':''}`,[id])).rows[0];requireCondition(row,404,'not_found','找不到這場活動。');return row;}
async function bump(q:PoolClient,id:string){await q.query('UPDATE community_events SET aggregate_version=aggregate_version+1,updated_at=now() WHERE event_id=$1',[id]);}
async function ownEntry(q:Query,id:string,identity:EventParticipationIdentity){return (await q.query('SELECT * FROM community_event_waitlist WHERE event_id=$1 AND member_ref IS NOT DISTINCT FROM $2 AND guest_email IS NOT DISTINCT FROM $3',[id,identity.member_ref??null,identity.guest_email??null])).rows[0];}
async function ownRsvp(q:Query,id:string,identity:EventParticipationIdentity){
  return identity.member_ref
    ?(await q.query('SELECT state,confirmed_at FROM community_event_rsvps WHERE event_id=$1 AND user_id=$2',[id,identity.member_ref])).rows[0]
    :(await q.query("SELECT confirmed_at,email_sent_at,CASE WHEN state='pending' THEN 'pending' WHEN state='going' AND (email_sent_at IS NOT NULL OR confirmed_at IS NOT NULL) THEN 'going' ELSE 'cancelled' END AS state FROM community_event_guest_rsvps WHERE event_id=$1 AND email=$2",[id,identity.guest_email])).rows[0];
}
async function memberSource(q:Query,actor:Actor,id:string,lock=false){
  const row=await eventRow(q,id,lock);
  requireCondition(row.community_id===actor.community_id&&await canAccessGuildEvent(q,actor,row)&&!(row.organizer_ref!==actor.user_id&&(await q.query('SELECT is_verification_test_account($1) AS hidden',[row.organizer_ref])).rows[0].hidden),404,'not_found','找不到這場活動。');
  const rsvp=await ownRsvp(q,id,{member_ref:actor.user_id});
  const history=rsvp?.confirmed_at||await ownEntry(q,id,{member_ref:actor.user_id});
  requireCondition(row.state==='published'||row.organizer_ref===actor.user_id||row.state==='cancelled'&&history,404,'not_found','找不到這場活動。');
  return row;
}
async function referralOwner(q:Query,id:string,code:string|null|undefined,status:404|422=422){if(!code)return null;const owner=(await q.query("SELECT c.user_id FROM community_event_share_codes c JOIN community_events e USING(event_id) WHERE c.event_id=$1 AND c.code=$2 AND e.state='published'",[id,code])).rows[0];requireCondition(owner,status,status===404?'not_found':'invalid_event_share_code','活動分享連結已失效。');return owner.user_id as string;}
async function guestLegal(q:Query,event:any,cap:any,history:boolean){requireCondition(['open','referral'].includes(event.visibility)&&!(await q.query('SELECT is_verification_test_account($1) AS hidden',[event.organizer_ref])).rows[0].hidden,404,'not_found','找不到這場活動。');requireCondition(event.state==='published'||event.state==='cancelled'&&history,404,'not_found','找不到這場活動。');if(event.state==='published'&&event.visibility==='referral')requireCondition(await referralOwner(q,event.event_id,cap.referral_code,404),404,'not_found','活動分享來源已失效。');}
export async function ensureGuestCapability(q:PoolClient,id:string,body:{email:string;name:string;referral_code?:string|null}):Promise<string>{const email=body.email.trim().toLowerCase();const existing=(await q.query('SELECT token_secret FROM community_event_guest_capabilities WHERE event_id=$1 AND email=$2',[id,email])).rows[0];if(existing)return existing.token_secret;const token=randomBytes(32).toString('base64url');await q.query('INSERT INTO community_event_guest_capabilities(event_id,email,name,referral_code,token_hash,token_secret) VALUES($1,$2,$3,$4,$5,$6)',[id,email,body.name,body.referral_code??null,createHash('sha256').update(token).digest('hex'),token]);return token;}
export function eventGuestManagementLink(origin:string,id:string,token:string){return `${origin}/events/${id}#participation=${token}`;}
export async function markGuestCapabilityProviderAccepted(q:Query,id:string,email:string){await q.query("UPDATE community_event_guest_capabilities SET provider_status='provider_accepted' WHERE event_id=$1 AND email=$2",[id,email.trim().toLowerCase()]);}
export async function resolveGuestParticipation(q:Query,id:string,token:string):Promise<{event:any;email:string;going:boolean}>{
  requireCondition(/^[A-Za-z0-9_-]{43}$/.test(token),404,'not_found','參與管理連結無效。');
  const cap=(await q.query('SELECT email,name,referral_code FROM community_event_guest_capabilities WHERE event_id=$1 AND token_hash=$2',[id,createHash('sha256').update(token).digest('hex')])).rows[0];
  requireCondition(cap,404,'not_found','參與管理連結無效。');
  const event=await eventRow(q,id),identity={guest_email:cap.email},rsvp=await ownRsvp(q,id,identity);
  await guestLegal(q,event,cap,Boolean(rsvp?.confirmed_at||rsvp?.email_sent_at||await ownEntry(q,id,identity)));
  await q.query('UPDATE community_event_guest_capabilities SET verified_at=COALESCE(verified_at,now()) WHERE event_id=$1 AND email=$2',[id,cap.email]);
  const going=event.state==='published'&&rsvp?.state==='going';
  return {event:going?event:{...event,location:null,online_url:null},email:cap.email,going};
}
export async function resolveGuestParticipationByEmail(q:Query,id:string,email:string):Promise<{event:any;email:string;going:boolean}>{
  const event=await eventRow(q,id);
  const cap=(await q.query('SELECT email,referral_code,verified_at FROM community_event_guest_capabilities WHERE event_id=$1 AND email=$2',[id,email])).rows[0];
  requireCondition(cap?.verified_at,404,'not_found','找不到參與紀錄。');
  const identity={guest_email:email},rsvp=await ownRsvp(q,id,identity);
  await guestLegal(q,event,cap,Boolean(rsvp?.confirmed_at||rsvp?.email_sent_at||await ownEntry(q,id,identity)));
  const going=event.state==='published'&&rsvp?.state==='going';
  return {event:going?event:{...event,location:null,online_url:null},email,going};
}
export async function countEventSeats(q:Query,id:string,now=new Date()):Promise<number>{return Number((await q.query(`SELECT (SELECT count(*) FROM community_event_rsvps WHERE event_id=$1 AND state='going' AND NOT is_verification_test_account(user_id))+(SELECT count(*) FROM community_event_guest_rsvps WHERE event_id=$1 AND ((state='going' AND (email_sent_at IS NOT NULL OR confirmed_at IS NOT NULL)) OR (state='pending' AND created_at>$2::timestamptz-interval '10 minutes')))+(SELECT count(*) FROM community_event_waitlist w WHERE event_id=$1 AND status='invited' AND expires_at>$2 AND NOT EXISTS(SELECT 1 FROM community_event_rsvps r WHERE r.event_id=w.event_id AND r.user_id=w.member_ref AND r.state='going') AND NOT EXISTS(SELECT 1 FROM community_event_guest_rsvps g WHERE g.event_id=w.event_id AND g.email=w.guest_email AND ((g.state='going' AND (g.email_sent_at IS NOT NULL OR g.confirmed_at IS NOT NULL)) OR (g.state='pending' AND g.created_at>$2::timestamptz-interval '10 minutes')))) AS total`,[id,now])).rows[0].total);}
export function eventInvitationDeadline(invitedAt:Date,startsAt:Date|string,minutes:number):Date{requireCondition(Number.isSafeInteger(minutes)&&minutes>0,422,'response_window_required','請明確設定候補回覆分鐘數。');return new Date(Math.min(invitedAt.getTime()+minutes*60000,instant(startsAt)));}
async function eligible(q:PoolClient,event:any,entry:any):Promise<boolean>{
  if((await q.query('SELECT is_verification_test_account($1) AS hidden',[event.organizer_ref])).rows[0].hidden)return false;
  if(event.visibility==='referral'&&!(await q.query("SELECT 1 FROM community_event_share_codes WHERE event_id=$1 AND code=$2",[event.event_id,entry.referral_code])).rowCount)return false;
  if(entry.member_ref){
    const member=(await q.query('SELECT user_id FROM users WHERE user_id=$1 AND community_id=$2 AND active AND NOT is_verification_test_account(user_id)',[entry.member_ref,event.community_id])).rows[0];
    if(!member)return false;
    if(event.visibility==='guild'&&!(await q.query("SELECT 1 FROM positioning_profession_memberships WHERE community_id=$1 AND guild_key=$2 AND user_id=$3 AND state='active' FOR SHARE",[event.community_id,event.guild_key,entry.member_ref])).rowCount)return false;
    return true;
  }
  const cap=(await q.query('SELECT verified_at,referral_code FROM community_event_guest_capabilities WHERE event_id=$1 AND email=$2',[event.event_id,entry.guest_email])).rows[0];
  return Boolean(cap?.verified_at&&['open','referral'].includes(event.visibility));
}
export async function reconcileEventWaitlist(q:PoolClient,id:string,now=new Date()):Promise<void>{const event=await eventRow(q,id,true);let changed=false;const expire=await q.query("UPDATE community_event_waitlist SET status='expired',aggregate_version=aggregate_version+1 WHERE event_id=$1 AND status='invited' AND expires_at<=$2",[id,now]);changed=Boolean(expire.rowCount);await q.query("UPDATE community_event_guest_rsvps SET state='cancelled' WHERE event_id=$1 AND state='pending' AND created_at<=$2::timestamptz-interval '10 minutes'",[id,now]);if(event.state!=='published'||instant(event.starts_at)<=now.getTime()||!event.waitlist_enabled){const cancelled=await q.query("UPDATE community_event_waitlist SET status='cancelled',aggregate_version=aggregate_version+1 WHERE event_id=$1 AND status IN ('queued','invited')",[id]);if(changed||cancelled.rowCount)await bump(q,id);return;}
const entries=(await q.query("SELECT * FROM community_event_waitlist WHERE event_id=$1 AND status IN ('queued','invited') ORDER BY joined_at,entry_id",[id])).rows;
for(const entry of entries){if((await ownRsvp(q,id,entry.member_ref?{member_ref:entry.member_ref}:{guest_email:entry.guest_email}))?.state==='going'){await q.query("UPDATE community_event_waitlist SET status='accepted',aggregate_version=aggregate_version+1 WHERE entry_id=$1",[entry.entry_id]);changed=true;continue;}if(!await eligible(q,event,entry)){await q.query("UPDATE community_event_waitlist SET status='cancelled',aggregate_version=aggregate_version+1 WHERE entry_id=$1",[entry.entry_id]);changed=true;}}
let occupied=await countEventSeats(q,id,now);if(event.capacity!==null&&occupied>event.capacity){const revoke=(await q.query("SELECT entry_id FROM community_event_waitlist WHERE event_id=$1 AND status='invited' ORDER BY joined_at DESC,entry_id DESC",[id])).rows;for(const row of revoke){if(occupied<=event.capacity)break;await q.query("UPDATE community_event_waitlist SET status='queued',invitation_id=NULL,invited_at=NULL,expires_at=NULL,delivery_status='pending',aggregate_version=aggregate_version+1 WHERE entry_id=$1",[row.entry_id]);occupied--;changed=true;}}
const queue=(await q.query("SELECT * FROM community_event_waitlist WHERE event_id=$1 AND status='queued' ORDER BY joined_at,entry_id",[id])).rows;
for(const entry of queue){if(event.capacity!==null&&occupied>=event.capacity)break;const expires=eventInvitationDeadline(now,event.starts_at,Number(event.response_window_minutes));const invitation=randomUUID();await q.query("UPDATE community_event_waitlist SET status='invited',invited_at=$2,expires_at=$3,invitation_id=$4,delivery_status='pending',aggregate_version=aggregate_version+1 WHERE entry_id=$1",[entry.entry_id,now,expires,invitation]);if(entry.member_ref){await notifyMember(q,{community_id:event.community_id,recipient_ref:entry.member_ref,kind:'event_waitlist_invited',source_key:`event/${id}/invite/${invitation}`,title:'候補名額可回覆',body:'你候補的活動有保留名額，請在回覆期限內選擇是否參加。',action:{tab:'events',resource_id:id}});await q.query("UPDATE community_event_waitlist SET delivery_status='recorded' WHERE entry_id=$1",[entry.entry_id]);}occupied++;changed=true;}if(changed)await bump(q,id);}
export async function markEventParticipationGoing(q:PoolClient,id:string,identity:EventParticipationIdentity):Promise<void>{const result=await q.query("UPDATE community_event_waitlist SET status='accepted',aggregate_version=aggregate_version+1 WHERE event_id=$1 AND member_ref IS NOT DISTINCT FROM $2 AND guest_email IS NOT DISTINCT FROM $3 AND status IN ('queued','invited')",[id,identity.member_ref??null,identity.guest_email??null]);if(result.rowCount)await bump(q,id);}
export async function cancelEventParticipation(q:PoolClient,id:string,identity:EventParticipationIdentity,now=new Date(),options:{reconcile?:boolean}={}):Promise<void>{await eventRow(q,id,true);const result=await q.query("UPDATE community_event_waitlist SET status='left',aggregate_version=aggregate_version+1 WHERE event_id=$1 AND member_ref IS NOT DISTINCT FROM $2 AND guest_email IS NOT DISTINCT FROM $3 AND status IN ('queued','invited','accepted')",[id,identity.member_ref??null,identity.guest_email??null]);if(result.rowCount)await bump(q,id);await cancelEventReminders(q,id,identity);if(options.reconcile!==false)await reconcileEventWaitlist(q,id,now);}
async function view(q:Query,id:string,identity:EventParticipationIdentity):Promise<EventParticipation>{
  const event=await eventRow(q,id),entry=await ownEntry(q,id,identity);
  return json({event_id:id,event_version:Number(event.aggregate_version),event_state:event.state,starts_at:new Date(event.starts_at).toISOString(),
    waitlist_enabled:event.waitlist_enabled,response_window_minutes:event.response_window_minutes===null?null:Number(event.response_window_minutes),
    rsvp_state:(await ownRsvp(q,id,identity))?.state??null,
    waitlist:entry?{status:entry.status,aggregate_version:Number(entry.aggregate_version),joined_at:entry.joined_at,invited_at:entry.invited_at,expires_at:entry.expires_at,delivery_status:entry.delivery_status}:null,
    available_seats:event.capacity===null?null:Math.max(0,event.capacity-await countEventSeats(q,id))});
}
export async function readEventParticipation(pool:Query,actor:Actor,id:string){await memberSource(pool,actor,id);return view(pool,id,{member_ref:actor.user_id});}
export async function readGuestEventParticipation(pool:Query,id:string,token:string){const source=await resolveGuestParticipation(pool,id,token);return view(pool,id,{guest_email:source.email});}
async function apply(q:PoolClient,event:any,identity:EventParticipationIdentity,action:string,code:string|null|undefined,now:Date){const id=event.event_id;if(action==='leave'||action==='cancel'){if(action==='cancel'&&identity.guest_email)await q.query("UPDATE community_event_guest_rsvps SET state='cancelled' WHERE event_id=$1 AND email=$2",[id,identity.guest_email]);await cancelEventParticipation(q,id,identity,now);return;}requireCondition(event.state==='published'&&instant(event.starts_at)>now.getTime(),409,'event_closed','活動已開始或取消。');const entry=await ownEntry(q,id,identity);if(action==='decline'){if(entry?.status==='invited'){await q.query("UPDATE community_event_waitlist SET status='declined',aggregate_version=aggregate_version+1 WHERE entry_id=$1",[entry.entry_id]);await bump(q,id);await cancelEventReminders(q,id,identity);}await reconcileEventWaitlist(q,id,now);return;}
if(action==='join'){requireCondition(event.waitlist_enabled,409,'waitlist_disabled','主辦者尚未開放候補。');requireCondition((await ownRsvp(q,id,identity))?.state!=='going',409,'already_registered','你已報名這場活動。');const sourceCode=code??entry?.referral_code??null;if(event.visibility==='referral')requireCondition(await referralOwner(q,id,sourceCode),422,'share_code_required','請使用有效分享連結。');if(!entry){await q.query("INSERT INTO community_event_waitlist(entry_id,event_id,member_ref,guest_email,referral_code,status,joined_at) VALUES($1,$2,$3,$4,$5,'queued',$6)",[randomUUID(),id,identity.member_ref??null,identity.guest_email??null,sourceCode,now]);await bump(q,id);}else if(!['queued','invited','accepted'].includes(entry.status)){await q.query("UPDATE community_event_waitlist SET status='queued',joined_at=$2,referral_code=$3,invited_at=NULL,expires_at=NULL,invitation_id=NULL,delivery_status='pending',aggregate_version=aggregate_version+1 WHERE entry_id=$1",[entry.entry_id,now,sourceCode]);await bump(q,id);}await reconcileEventWaitlist(q,id,now);return;}
await reconcileEventWaitlist(q,id,now);const current=await ownEntry(q,id,identity);if(action==='accept'&&current?.status==='expired')return;if(action==='accept'){if(current?.status==='accepted'&&(await ownRsvp(q,id,identity))?.state==='going')return;requireCondition(current?.status==='invited'&&instant(current.expires_at)>now.getTime(),409,'invitation_unavailable','候補邀請已失效。');requireCondition(await eligible(q,event,current),404,'not_found','找不到可參與的活動。');}
if(action==='register'){requireCondition(identity.guest_email,403,'guest_required','請使用自己的參與管理連結。');if((await ownRsvp(q,id,identity))?.state==='going')return;const reserved=current?.status==='invited';const pending=(await q.query("SELECT 1 FROM community_event_guest_rsvps WHERE event_id=$1 AND email=$2 AND state='pending' AND created_at>$3::timestamptz-interval '10 minutes'",[id,identity.guest_email,now])).rowCount===1;requireCondition(reserved||event.capacity===null||await countEventSeats(q,id,now)-(pending?1:0)<event.capacity,409,'event_full','活動名額已滿。');}
const referrer=await referralOwner(q,id,code??current?.referral_code??null);
if(event.visibility==='referral')requireCondition(referrer,422,'share_code_required','請使用有效分享連結。');
if(identity.member_ref){
  await q.query(`INSERT INTO community_event_rsvps(rsvp_id,event_id,user_id,state,referred_by_user_id,confirmed_at)
    VALUES($1,$2,$3,'going',$4,$5) ON CONFLICT(event_id,user_id) DO UPDATE SET state='going',
    confirmed_at=COALESCE(community_event_rsvps.confirmed_at,EXCLUDED.confirmed_at),
    aggregate_version=community_event_rsvps.aggregate_version+1,updated_at=now(),
    referred_by_user_id=COALESCE(community_event_rsvps.referred_by_user_id,EXCLUDED.referred_by_user_id)`,
    [randomUUID(),id,identity.member_ref,referrer===identity.member_ref?null:referrer,now]);
}else{
  const cap=(await q.query('SELECT name FROM community_event_guest_capabilities WHERE event_id=$1 AND email=$2',[id,identity.guest_email])).rows[0];
  await q.query(`INSERT INTO community_event_guest_rsvps(event_id,email,name,state,confirmed_at,referred_by_user_id)
    VALUES($1,$2,$3,'going',$4,$5) ON CONFLICT(event_id,email) DO UPDATE SET state='going',
    confirmed_at=EXCLUDED.confirmed_at,registration_attempt_id=EXCLUDED.registration_attempt_id,referred_by_user_id=COALESCE(community_event_guest_rsvps.referred_by_user_id,EXCLUDED.referred_by_user_id)`,
    [id,identity.guest_email,cap.name,now,referrer]);
}
await markEventParticipationGoing(q,id,identity);await bump(q,id);await reconcileEventWaitlist(q,id,now);
}
export async function mutateEventWaitlist(pool:Pool,input:Command,id:string){const body=actionInput.parse(input.body);return command(pool,input,q=>memberSource(q,input.actor,id),async q=>{const event=await memberSource(q,input.actor,id,true);checkVersion(String(event.aggregate_version),input.expected);if(event.visibility==='guild'&&['join','accept'].includes(body.action))requireCondition((await q.query("SELECT 1 FROM positioning_profession_memberships WHERE community_id=$1 AND guild_key=$2 AND user_id=$3 AND state='active' FOR SHARE",[event.community_id,event.guild_key,input.actor.user_id])).rowCount===1,403,'event_guild_required','活動僅開放主辦公會會員。');await apply(q,event,{member_ref:input.actor.user_id},body.action,body.referral_code,new Date());const result=await view(q,id,{member_ref:input.actor.user_id});if(result.event_version!==Number(event.aggregate_version))await journal(q,input.actor,'community_event',id,result.event_version,`waitlist_${body.action}`,{waitlist_status:result.waitlist?.status??null,rsvp_state:result.rsvp_state});return result;});}
export async function mutateGuestEventParticipation(pool:Pool,id:string,token:string,raw:unknown,key:string){const body=guestInput.parse(raw);requireCondition(/^[A-Za-z0-9_-]{8,128}$/.test(key),400,'idempotency_required','請提供有效的 Idempotency-Key。');return transaction(pool,async q=>{const event=await eventRow(q,id,true);const source=await resolveGuestParticipation(q,id,token);const hash=digest(body);const prior=(await q.query('SELECT body_hash,result FROM community_event_guest_commands WHERE event_id=$1 AND email=$2 AND command_id=$3',[id,source.email,key])).rows[0];if(prior){requireCondition(prior.body_hash===hash,409,'idempotency_conflict','同一指令識別碼的內容不可變更。');return prior.result as EventParticipation;}checkVersion(String(event.aggregate_version),String(body.expected_version));const cap=(await q.query('SELECT referral_code FROM community_event_guest_capabilities WHERE event_id=$1 AND email=$2',[id,source.email])).rows[0];await apply(q,event,{guest_email:source.email},body.action,body.referral_code??cap.referral_code,new Date());const result=await view(q,id,{guest_email:source.email});await q.query('INSERT INTO community_event_guest_commands(event_id,email,command_id,body_hash,result) VALUES($1,$2,$3,$4,$5)',[id,source.email,key,hash,JSON.stringify(result)]);return result;});}
export async function setEventWaitlistPolicy(pool:Pool,input:Command,id:string){const body=policyInput.parse(input.body);return command(pool,input,q=>memberSource(q,input.actor,id),async q=>{const event=await memberSource(q,input.actor,id,true);requireCondition(event.organizer_ref===input.actor.user_id,403,'organizer_required','只有主辦者可設定候補。');await refuseInternGuildExchange(q,input.actor,event);checkVersion(String(event.aggregate_version),input.expected);requireCondition(event.state==='published'&&instant(event.starts_at)>Date.now(),409,'event_closed','僅可設定尚未開始的已發布活動。');await q.query('UPDATE community_events SET waitlist_enabled=$2,response_window_minutes=$3,aggregate_version=aggregate_version+1,updated_at=now() WHERE event_id=$1',[id,body.waitlist_enabled,body.response_window_minutes]);await reconcileEventWaitlist(q,id);const result=await view(q,id,{member_ref:input.actor.user_id});await journal(q,input.actor,'community_event',id,result.event_version,'waitlist_policy',body);return result;});}
export async function notifyEventParticipationChanged(q:PoolClient,id:string,kind:'event_schedule_changed'|'event_cancelled'){const event=await eventRow(q,id,true);const members=(await q.query("SELECT user_id FROM community_event_rsvps WHERE event_id=$1 AND state='going' UNION SELECT member_ref FROM community_event_waitlist WHERE event_id=$1 AND member_ref IS NOT NULL AND status IN ('queued','invited','cancelled')",[id])).rows;for(const member of members)await notifyMember(q,{community_id:event.community_id,recipient_ref:member.user_id,kind,source_key:`event/${id}/${kind}/${event.aggregate_version}`,title:kind==='event_cancelled'?'參與活動已取消':'參與活動安排已更新',body:'請返回自己的活動參與頁查看目前狀態。',action:{tab:'events',resource_id:id}});await q.query(`INSERT INTO community_event_participation_notices(notice_id,event_id,guest_email,event_version,kind) SELECT gen_random_uuid(),$1,email,$2,$3 FROM community_event_guest_capabilities c WHERE event_id=$1 AND verified_at IS NOT NULL AND (EXISTS(SELECT 1 FROM community_event_guest_rsvps g WHERE g.event_id=c.event_id AND g.email=c.email AND g.state='going') OR EXISTS(SELECT 1 FROM community_event_waitlist w WHERE w.event_id=c.event_id AND w.guest_email=c.email AND w.status IN ('queued','invited','cancelled'))) ON CONFLICT(event_id,guest_email,event_version,kind) DO NOTHING`,[id,event.aggregate_version,kind]);}
export async function updateEventSchedule(pool:Pool,input:Command,id:string){const body=scheduleInput.parse(input.body);return command(pool,input,q=>memberSource(q,input.actor,id),async q=>{const event=await memberSource(q,input.actor,id,true);requireCondition(event.organizer_ref===input.actor.user_id,403,'organizer_required','只有主辦者可調整活動時間。');await refuseInternGuildExchange(q,input.actor,event);checkVersion(String(event.aggregate_version),input.expected);requireCondition(event.state==='published'&&instant(event.starts_at)>Date.now()&&Date.parse(body.starts_at)>Date.now(),409,'event_closed','僅可調整尚未開始的已發布活動。');if(instant(event.starts_at)===Date.parse(body.starts_at)&&instant(event.ends_at)===Date.parse(body.ends_at)&&event.capacity===body.capacity)return view(q,id,{member_ref:input.actor.user_id});const confirmed=Number((await q.query(`SELECT (SELECT count(*) FROM community_event_rsvps WHERE event_id=$1 AND state='going' AND NOT is_verification_test_account(user_id))+(SELECT count(*) FROM community_event_guest_rsvps WHERE event_id=$1 AND ((state='going' AND (email_sent_at IS NOT NULL OR confirmed_at IS NOT NULL)) OR (state='pending' AND created_at>now()-interval '10 minutes'))) AS total`,[id])).rows[0].total);requireCondition(body.capacity===null||body.capacity>=confirmed,409,'capacity_below_attendees','活動名額不能低於已報名及暫時保留的人數。');await q.query('UPDATE community_events SET starts_at=$2,ends_at=$3,capacity=$4,aggregate_version=aggregate_version+1,updated_at=now() WHERE event_id=$1',[id,body.starts_at,body.ends_at,body.capacity]);await q.query('UPDATE community_event_waitlist SET expires_at=LEAST(expires_at,$2::timestamptz),aggregate_version=aggregate_version+1 WHERE event_id=$1 AND status=\'invited\' AND expires_at>$2',[id,body.starts_at]);await reconcileEventWaitlist(q,id);await reconcileEventReminders(q,id);await notifyEventParticipationChanged(q,id,'event_schedule_changed');const result=await view(q,id,{member_ref:input.actor.user_id});await journal(q,input.actor,'community_event',id,result.event_version,'schedule',body);return result;});}
export async function requestGuestEventParticipation(pool:Pool,id:string,raw:unknown,send:EventEmailSender,origin:string){const body=z.object({name:text(80),email:z.email().max(200),referral_code:referral}).strict().parse(raw);const email=body.email.trim().toLowerCase();const token=await transaction(pool,async q=>{const event=await eventRow(q,id,true);const existing=(await q.query('SELECT referral_code FROM community_event_guest_capabilities WHERE event_id=$1 AND email=$2',[id,email])).rows[0];const rsvp=await ownRsvp(q,id,{guest_email:email});const history=Boolean(rsvp?.confirmed_at||rsvp?.email_sent_at||await ownEntry(q,id,{guest_email:email}));await guestLegal(q,event,existing??body,history);requireCondition(history||event.state==='published'&&instant(event.starts_at)>Date.now(),409,'event_closed','活動已開始或取消。');return ensureGuestCapability(q,id,{...body,email});});try{await send(email,'自由工坊：活動參與管理',`請使用私人連結管理自己的活動報名、候補及提醒。請勿轉寄。\n${eventGuestManagementLink(origin,id,token)}`);}catch{throw new Problem(503,'event_email_delivery_failed','郵件提供者尚未確認接受，請稍後重試。');}await markGuestCapabilityProviderAccepted(pool,id,email);return {requested:true,provider_status:'provider_accepted' as const};}
export async function processEventWaitlist(pool:Pool,send:EventEmailSender,origin:string,now?:Date,eventId?:string):Promise<{reconciled:number;provider_accepted:number;failed:number}>{
  const clock=()=>now??new Date();
  const ids=(await pool.query("SELECT e.event_id FROM community_events e WHERE ($1::uuid IS NULL OR e.event_id=$1) AND EXISTS(SELECT 1 FROM community_event_waitlist w WHERE w.event_id=e.event_id AND w.status IN ('queued','invited')) ORDER BY e.waitlist_reconciled_at NULLS FIRST,e.event_id LIMIT 100",[eventId??null])).rows;
  for(const row of ids)await transaction(pool,async q=>{const checkedAt=clock();await reconcileEventWaitlist(q,row.event_id,checkedAt);await q.query('UPDATE community_events SET waitlist_reconciled_at=$2 WHERE event_id=$1',[row.event_id,checkedAt]);});
  let accepted=0,failed=0;
  const candidates=(await pool.query("SELECT entry_id,event_id FROM community_event_waitlist WHERE status='invited' AND guest_email IS NOT NULL AND delivery_status='pending' AND ($1::uuid IS NULL OR event_id=$1) ORDER BY joined_at,entry_id LIMIT 100",[eventId??null])).rows;
for(const candidate of candidates){
  const claim=await transaction(pool,async q=>{
    const event=await eventRow(q,candidate.event_id,true);
    await reconcileEventWaitlist(q,event.event_id,clock());
    const entry=(await q.query("SELECT * FROM community_event_waitlist WHERE entry_id=$1 AND status='invited' AND delivery_status='pending'",[candidate.entry_id])).rows[0];
    if(!entry||!await eligible(q,event,entry))return null;
    await q.query("UPDATE community_event_waitlist SET delivery_status='unknown' WHERE entry_id=$1",[entry.entry_id]);
    return {entry_id:entry.entry_id,event_id:entry.event_id,invitation_id:entry.invitation_id};
  });
  if(!claim)continue;
  // Persist before handoff; ambiguous sends must not be automatically retried.
  await transaction(pool,async q=>{
    const event=await eventRow(q,claim.event_id,true);
    const entry=(await q.query("SELECT * FROM community_event_waitlist WHERE entry_id=$1 AND invitation_id=$2 AND status='invited' AND delivery_status='unknown'",[claim.entry_id,claim.invitation_id])).rows[0];
    if(!entry||event.state!=='published'||instant(event.starts_at)<=clock().getTime()||instant(entry.expires_at)<=clock().getTime()||!await eligible(q,event,entry))return;
    const cap=(await q.query('SELECT token_secret FROM community_event_guest_capabilities WHERE event_id=$1 AND email=$2',[event.event_id,entry.guest_email])).rows[0];
    if(!cap||instant(entry.expires_at)<=clock().getTime())return;
    let status='provider_accepted';
    try{
      await send(entry.guest_email,'自由工坊：候補名額可回覆',`你候補的活動有保留名額。請在 ${new Date(entry.expires_at).toISOString()}（UTC）前選擇是否參加。\n${eventGuestManagementLink(origin,entry.event_id,cap.token_secret)}`);
      accepted++;
    }catch{status='failed';failed++;}
    await q.query('UPDATE community_event_waitlist SET delivery_status=$2 WHERE entry_id=$1 AND invitation_id=$3',[entry.entry_id,status,entry.invitation_id]);
  });
}
const notices=(await pool.query("SELECT notice_id,event_id FROM community_event_participation_notices WHERE status='pending' AND ($1::uuid IS NULL OR event_id=$1) ORDER BY notice_id LIMIT 100",[eventId??null])).rows;
for(const candidate of notices){
  const claimed=await transaction(pool,async q=>{
    await eventRow(q,candidate.event_id,true);
    return (await q.query("UPDATE community_event_participation_notices SET status='unknown' WHERE notice_id=$1 AND status='pending' RETURNING *",[candidate.notice_id])).rows[0];
  });
  if(!claimed)continue;
  await transaction(pool,async q=>{
    const event=await eventRow(q,claimed.event_id,true);
    const latest=(await q.query('SELECT notice_id FROM community_event_participation_notices WHERE event_id=$1 AND guest_email=$2 AND kind=$3 ORDER BY event_version DESC LIMIT 1',[event.event_id,claimed.guest_email,claimed.kind])).rows[0];
    if(latest?.notice_id!==claimed.notice_id)return;
    try{
      const source=await resolveGuestParticipationByEmail(q,event.event_id,claimed.guest_email);
      if(claimed.kind==='event_cancelled'){if(event.state!=='cancelled')return;}
      else if(!source.going&&!(await q.query("SELECT 1 FROM community_event_waitlist WHERE event_id=$1 AND guest_email=$2 AND status IN ('queued','invited')",[event.event_id,claimed.guest_email])).rowCount)return;
    }catch{return;}
    let status='provider_accepted';
    try{
      await send(claimed.guest_email,'自由工坊：活動參與狀態更新',claimed.kind==='event_cancelled'?'你參與的活動已取消。請返回自己的參與管理頁查看目前狀態。':'你參與的活動安排已更新。請返回自己的參與管理頁查看目前狀態。');
      accepted++;
    }catch{status='failed';failed++;}
    await q.query('UPDATE community_event_participation_notices SET status=$2 WHERE notice_id=$1',[claimed.notice_id,status]);
  });
}
return {reconciled:ids.length,provider_accepted:accepted,failed};
}
