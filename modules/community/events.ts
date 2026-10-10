import {eventVideoStorageMode,type EventVideoAssetService} from '../assets/event-video.js';
import {readEventVideoHttp} from '../assets/event-video-read.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { checkVersion, command, digest, journal, transaction, type Command } from '../../packages/db/index.js';
import { Problem,requireCondition } from '../../packages/shared/problem.js';
import { text, isoTime } from '../../packages/shared/validation.js';
import type { Actor } from '../identity-membership/service.js';
import {authRateLimitInTransaction} from '../identity-membership/members.js';
import { normalizeEventPoster } from '../skill-submissions/payload.js';
import {notifyMember} from '../member-communications/notifications.js';
import {lockMemberSession,assertCurrentSessionClock} from '../../packages/db/member-session.js';
import {avatarUrl} from '../identity-membership/avatars.js';
import {lockMemberGuilds} from '../positioning/onboarding.js';
import {requireFullGuildMember} from '../positioning/member-tier.js';
import {adminCommand,audit,type AdminActor,type AdminCommand} from '../platform-admin/service.js';

import {eventBannerStorageMode,type EventBannerAssetService} from '../assets/event-banner.js';
import {eventBannerMemberCommand,eventVideoMemberCommand} from '../../packages/scoped-commands/index.js';
import {readDomainMedia,type DomainMediaSnapshot} from '../../packages/media-migration/domain-bridge.js';
import {snapshotBoundedBytes,type ObjectStore,AssetStorageError} from '../../packages/asset-storage/index.js';

const details = z.object({
  title:text(120), description:text(3000), starts_at:isoTime, ends_at:isoTime,
  mode:z.enum(['online','in_person','hybrid']), location:text(300),
  event_kind:z.enum(['reading_group','meetup','guild_skill_exchange','other']).default('other'),
  topic:text(160).nullable().default(null),
  online_url:z.string().trim().max(500).refine(value=>{try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port;}catch{return false;}},'請提供安全的 HTTPS 參與連結。').nullable().default(null),
  visibility:z.enum(['workshop','guild','referral','open']).default('workshop'),
  capacity:z.number().int().min(1).max(500).nullable(),
  guild_key:z.string().min(1).max(100).nullable().default(null),
}).strict().superRefine((value,ctx)=>{
  if(Date.parse(value.ends_at)<=Date.parse(value.starts_at))ctx.addIssue({code:'custom',message:'結束時間須晚於開始時間。',path:['ends_at']});
  if(value.event_kind==='reading_group'&&!value.topic)ctx.addIssue({code:'custom',message:'讀書會請填寫主題。',path:['topic']});
  if(value.event_kind==='reading_group'&&value.mode!=='online')ctx.addIssue({code:'custom',message:'線上讀書會請選擇線上形式。',path:['mode']});
  if(value.event_kind==='guild_skill_exchange'&&!value.guild_key)ctx.addIssue({code:'custom',message:'公會技能交流請選擇主辦公會。',path:['guild_key']});
  if(value.visibility==='guild'&&value.event_kind!=='guild_skill_exchange')ctx.addIssue({code:'custom',message:'公會內部活動限公會技能交流。',path:['visibility']});
  if(value.mode==='hybrid'&&!value.online_url)ctx.addIssue({code:'custom',message:'線上與實體活動請填寫線上參與連結。',path:['online_url']});
});
const reviewInput=z.object({decision:z.enum(['approve','reject']),reason:text(500)}).strict();
const onlineReviewGuild='guild_member_operations';
const physicalReviewGuild='guild_event_space';
function reviewGuildFor(body:z.infer<typeof details>){
  return body.event_kind==='guild_skill_exchange'?body.guild_key:body.mode==='online'?onlineReviewGuild:physicalReviewGuild;
}
async function testHostHidden(q:Pick<PoolClient,'query'>,organizerId:string,viewerId:string){
  if(organizerId===viewerId)return false;
  return Boolean((await q.query('SELECT is_verification_test_account($1) AS hidden',[organizerId])).rows[0].hidden);
}

async function scopedEvent(q:Pick<PoolClient,'query'>,actor:Actor,id:string,lock=false) {
  const row=(await q.query(`SELECT * FROM community_events WHERE event_id=$1 AND community_id=$2${lock?' FOR UPDATE':''}`,[id,actor.community_id])).rows[0];
  requireCondition(row,404,'not_found','找不到這場活動。');return row;
}

export async function canAccessGuildEvent(q:Pick<PoolClient,'query'>,actor:Actor,row:any){
  if(row.visibility!=='guild'||row.organizer_ref===actor.user_id)return true;
  const member=await q.query(`SELECT 1 FROM positioning_profession_memberships
    WHERE community_id=$1 AND guild_key=$2 AND user_id=$3 AND state='active'`,[row.community_id,row.guild_key,actor.user_id]);
  return member.rowCount===1;
}

async function eventView(q:Pick<PoolClient,'query'>,actor:Actor,row:any) {
  const count=(await q.query(`SELECT
    (SELECT count(*) FROM community_event_rsvps WHERE event_id=$1 AND state='going' AND NOT is_verification_test_account(user_id))+
    (SELECT count(*) FROM community_event_guest_rsvps WHERE event_id=$1 AND email_sent_at IS NOT NULL) AS total`,[row.event_id])).rows[0].total as string;
  const mine=(await q.query('SELECT state FROM community_event_rsvps WHERE event_id=$1 AND user_id=$2',[row.event_id,actor.user_id])).rows[0]?.state??null;
  const canReview=row.state==='pending'&&row.review_guild_key&&(await q.query(`SELECT 1 FROM positioning_guild_officers o
    JOIN positioning_profession_memberships m ON m.community_id=o.community_id AND m.guild_key=o.guild_key AND m.user_id=o.user_id AND m.state='active'
    WHERE o.community_id=$1 AND o.guild_key=$2 AND o.user_id=$3`,[actor.community_id,row.review_guild_key,actor.user_id])).rowCount===1;
  const media=(await q.query(`SELECT (SELECT orientation FROM community_event_banners WHERE event_id=$1) AS banner_orientation,
    (SELECT mime_type FROM community_event_videos WHERE event_id=$1) AS video_mime`,[row.event_id])).rows[0];
  const hideOnline=row.visibility==='referral'&&mine!=='going'&&row.organizer_ref!==actor.user_id&&!canReview;
  return {...row,location:hideOnline&&(row.mode==='online'||/https?:\/\//i.test(row.location))?'線上參與資料將寄至報名信箱':row.location,
    online_url:hideOnline?null:row.online_url,
    banner_url:media.banner_orientation?`/api/v1/events/${row.event_id}/banner?v=${row.aggregate_version}`:null,banner_orientation:media.banner_orientation,
    video_url:media.video_mime?`/api/v1/events/${row.event_id}/video?v=${row.aggregate_version}`:null,video_mime:media.video_mime,
    organizer_name:(await q.query('SELECT display_name FROM users WHERE user_id=$1',[row.organizer_ref])).rows[0]?.display_name??'社群成員',attending_count:Number(count),my_rsvp:mine,can_review:Boolean(canReview)};
}

async function bulletin(q:PoolClient,row:any,kind:'submitted'|'approved'|'rejected',actorName:string,organizerName:string){
  const scope=row.visibility==='guild'?'公會內部活動':'公開活動';
  const message=kind==='submitted'?`${organizerName} 提交了${scope}「${row.title}」，等待審核。`
    :kind==='approved'?`${actorName} 核准了 ${organizerName} 的${scope}「${row.title}」。`
    :`${actorName} 未核准 ${organizerName} 的${scope}「${row.title}」。`;
  await q.query(`INSERT INTO community_event_bulletins(bulletin_id,event_id,community_id,kind,actor_name,message)
    VALUES($1,$2,$3,$4,$5,$6)`,[randomUUID(),row.event_id,row.community_id,kind,actorName,message]);
}

export async function listEventBulletins(pool:Pool,actor:Actor){
  return (await pool.query(`SELECT b.bulletin_id,b.event_id,b.kind,b.actor_name,b.message,b.created_at FROM community_event_bulletins b
    JOIN community_events e ON e.event_id=b.event_id WHERE b.community_id=$1 AND
      (e.visibility<>'guild' OR e.organizer_ref=$2 OR EXISTS(
        SELECT 1 FROM positioning_profession_memberships m WHERE m.community_id=e.community_id
          AND m.user_id=$2 AND m.guild_key=e.guild_key AND m.state='active'))
      AND (e.organizer_ref=$2 OR NOT is_verification_test_account(e.organizer_ref))
    ORDER BY b.created_at DESC,b.bulletin_id DESC LIMIT 30`,[actor.community_id,actor.user_id])).rows;
}

const pastEventLimit=100;
// Provisional per-member submission budget for #199; adjust these two values only.
const eventCreateLimit=5,eventCreateWindowSeconds=3600;
// Current and own rows stay whole. Other ended published rows are the newest slice, so old history cannot crowd them out.
function rankedEvents(visible:string,columns:string){
  return `WITH visible AS (${visible}), listed AS (
    SELECT visible.*,0 AS list_rank,visible.starts_at AS list_time FROM visible WHERE NOT (state='published' AND ends_at<=now())
    UNION ALL
    SELECT visible.*,1,visible.starts_at FROM visible WHERE state='published' AND ends_at<=now() AND organizer_ref=$2
    UNION ALL
    SELECT capped.*,1,capped.starts_at FROM (
      SELECT visible.* FROM visible WHERE state='published' AND ends_at<=now() AND organizer_ref<>$2
      ORDER BY starts_at DESC,event_id DESC LIMIT $3::int) capped
  ) SELECT ${columns} FROM listed
  ORDER BY list_rank,CASE WHEN list_rank=0 THEN list_time END ASC,CASE WHEN list_rank=1 THEN list_time END DESC,event_id`;
}

export async function listEvents(pool:Pool,actor:Actor) {
  const args=[actor.community_id,actor.user_id,pastEventLimit];
  if(actor.onboarding_required&&!actor.onboarding_completed_at) {
    return (await pool.query(rankedEvents(`SELECT event_id,title,starts_at,ends_at,mode,state,organizer_ref
      FROM community_events WHERE community_id=$1 AND ((state='published' AND visibility<>'guild') OR organizer_ref=$2)
        AND (organizer_ref=$2 OR NOT is_verification_test_account(organizer_ref))`,'event_id,title,starts_at,ends_at,mode,state'),args)).rows;
  }
  const rows=(await pool.query(rankedEvents(`SELECT e.*,u.display_name AS organizer_name,
    (CASE WHEN EXISTS(SELECT 1 FROM community_event_banners b WHERE b.event_id=e.event_id)
      THEN '/api/v1/events/'||e.event_id||'/banner?v='||e.aggregate_version ELSE NULL END) AS banner_url,
    (SELECT orientation FROM community_event_banners b WHERE b.event_id=e.event_id) AS banner_orientation,
    (CASE WHEN EXISTS(SELECT 1 FROM community_event_videos v WHERE v.event_id=e.event_id)
      THEN '/api/v1/events/'||e.event_id||'/video?v='||e.aggregate_version ELSE NULL END) AS video_url,
    (SELECT mime_type FROM community_event_videos v WHERE v.event_id=e.event_id) AS video_mime,
    ((SELECT count(*)::int FROM community_event_rsvps r WHERE r.event_id=e.event_id AND r.state='going' AND NOT is_verification_test_account(r.user_id))+
      (SELECT count(*)::int FROM community_event_guest_rsvps g WHERE g.event_id=e.event_id AND g.email_sent_at IS NOT NULL)) AS attending_count,
    (SELECT state FROM community_event_rsvps r WHERE r.event_id=e.event_id AND r.user_id=$2) AS my_rsvp,
    (e.state='pending' AND e.review_guild_key IS NOT NULL AND EXISTS(
      SELECT 1 FROM positioning_guild_officers o JOIN positioning_profession_memberships m
        ON m.community_id=o.community_id AND m.guild_key=o.guild_key AND m.user_id=o.user_id AND m.state='active'
      WHERE o.community_id=e.community_id AND o.guild_key=e.review_guild_key AND o.user_id=$2)) AS can_review
    FROM community_events e JOIN users u ON u.user_id=e.organizer_ref
    WHERE e.community_id=$1 AND ((e.state='published' AND
      (e.visibility<>'guild' OR e.organizer_ref=$2 OR EXISTS(
        SELECT 1 FROM positioning_profession_memberships gm WHERE gm.community_id=e.community_id
          AND gm.user_id=$2 AND gm.guild_key=e.guild_key AND gm.state='active')))
      OR e.organizer_ref=$2 OR (e.state='pending' AND e.review_guild_key IS NOT NULL AND EXISTS(
        SELECT 1 FROM positioning_guild_officers o JOIN positioning_profession_memberships m
          ON m.community_id=o.community_id AND m.guild_key=o.guild_key AND m.user_id=o.user_id AND m.state='active'
        WHERE o.community_id=e.community_id AND o.guild_key=e.review_guild_key AND o.user_id=$2)))
      AND (e.organizer_ref=$2 OR NOT is_verification_test_account(e.organizer_ref))`,'*'),args)).rows;
  return rows.map(row=>{
    const {list_rank:_rank,list_time:_time,...rest}=row;
    return rest.visibility==='referral'&&rest.my_rsvp!=='going'&&rest.organizer_ref!==actor.user_id&&!rest.can_review
      ?{...rest,location:rest.mode==='online'||/https?:\/\//i.test(rest.location)?'線上參與資料將寄至報名信箱':rest.location,online_url:null}:rest;
  });
}

const shareCode=z.string().regex(/^[A-Za-z0-9_-]{16,32}$/);
async function referralOwner(q:Pick<PoolClient,'query'>,eventId:string,raw:string|null){
  if(raw===null)return null;
  const code=shareCode.parse(raw);
  const row=(await q.query(`SELECT c.user_id FROM community_event_share_codes c
    JOIN community_events e ON e.event_id=c.event_id WHERE c.event_id=$1 AND c.code=$2 AND e.state='published'`,[eventId,code])).rows[0];
  requireCondition(row,422,'invalid_event_share_code','這個活動分享連結已無效，請向分享者取得新連結。');
  return row.user_id as string;
}

export async function getEventShareCode(pool:Pool,actor:Actor,id:string){
  const row=await scopedEvent(pool,actor,id);
  requireCondition(row.state==='published'&&await canAccessGuildEvent(pool,actor,row)&&!await testHostHidden(pool,row.organizer_ref,actor.user_id),404,'not_found','找不到可分享的活動。');
  const code=randomBytes(18).toString('base64url');
  return (await pool.query(`INSERT INTO community_event_share_codes(event_id,user_id,code) VALUES($1,$2,$3)
    ON CONFLICT(event_id,user_id) DO UPDATE SET code=community_event_share_codes.code RETURNING code`,[id,actor.user_id,code])).rows[0] as {code:string};
}

export async function eventReferralReport(pool:Pool,actor:Actor,id:string){
  const row=await scopedEvent(pool,actor,id);
  requireCondition(row.organizer_ref===actor.user_id,403,'organizer_required','只有主辦者能查看活動分享統計。');
  return (await pool.query(`SELECT c.user_id,u.display_name AS member_name,
    (SELECT count(*)::int FROM community_event_rsvps r WHERE r.event_id=c.event_id AND r.referred_by_user_id=c.user_id AND r.state='going' AND NOT is_verification_test_account(r.user_id))+
    (SELECT count(*)::int FROM community_event_guest_rsvps g WHERE g.event_id=c.event_id AND g.referred_by_user_id=c.user_id AND g.email_sent_at IS NOT NULL) AS registrations,
    (SELECT count(*)::int FROM promotion_clicks pc JOIN promotion_links pl ON pl.link_id=pc.link_id WHERE pl.kind='event' AND pl.target_key=c.event_id::text AND pl.user_id=c.user_id) AS clicks
    FROM community_event_share_codes c JOIN users u ON u.user_id=c.user_id WHERE c.event_id=$1 AND (c.user_id=$2 OR NOT is_verification_test_account(c.user_id)) ORDER BY registrations DESC,u.display_name`,[id,actor.user_id])).rows;
}

// Keep the page bounded while allowing every advertised continuation; Zod int
// rejects fractional and unsafe numeric offsets before they reach PostgreSQL.
const AttendeeQuery=z.object({limit:z.coerce.number().int().min(1).max(50).default(20),offset:z.coerce.number().int().min(0).default(0)}).strict();
export type EventAttendee={kind:'member';user_id:string;nickname:string;avatar_url:string|null;registered_at:string}|{kind:'guest';registered_at:string};
/** Organizer-only list of who is currently going, newest registration last (#401).
 * Same population as attending_count; members show only their card summary and
 * public guests only their registration time — never email, name or contacts. */
export async function eventAttendees(pool:Pool,actor:Actor,id:string,raw:unknown):Promise<{items:EventAttendee[];total:number;next_offset:number|null}>{
  const {limit,offset}=AttendeeQuery.parse(raw);
  return transaction(pool,async q=>{
    await lockMemberSession(q,actor);
  const row=await scopedEvent(q,actor,id,true);
  requireCondition(row.organizer_ref===actor.user_id,403,'organizer_required','只有主辦者能查看報名名單。');
  const rows=(await q.query(`WITH going AS (
      SELECT 'member' AS kind,r.user_id,r.updated_at AS registered_at,r.user_id::text AS registration_key FROM community_event_rsvps r
        WHERE r.event_id=$1 AND r.state='going' AND NOT is_verification_test_account(r.user_id)
      UNION ALL
      SELECT 'guest',NULL,g.created_at,g.email FROM community_event_guest_rsvps g WHERE g.event_id=$1 AND g.email_sent_at IS NOT NULL)
    SELECT g.kind,g.user_id,g.registered_at,u.display_name,a.aggregate_version AS avatar_version,a.present AS avatar_present,count(*) OVER() AS total
    FROM going g LEFT JOIN users u ON u.user_id=g.user_id LEFT JOIN member_avatar_presence a ON a.user_id=g.user_id AND a.community_id=$2
    ORDER BY g.registered_at,g.user_id NULLS LAST,g.registration_key LIMIT $3 OFFSET $4`,[id,actor.community_id,limit+1,offset])).rows;
  const total=rows.length?Number(rows[0].total):(await q.query(`SELECT
    (SELECT count(*) FROM community_event_rsvps WHERE event_id=$1 AND state='going' AND NOT is_verification_test_account(user_id))+
    (SELECT count(*) FROM community_event_guest_rsvps WHERE event_id=$1 AND email_sent_at IS NOT NULL) AS total`,[id])).rows[0].total;
  const items=rows.slice(0,limit).map((item):EventAttendee=>item.kind==='member'
    ?{kind:'member',user_id:item.user_id,nickname:item.display_name,avatar_url:item.avatar_present?avatarUrl(item.user_id,item.avatar_version??'1',true):null,registered_at:new Date(item.registered_at).toISOString()}
    :{kind:'guest',registered_at:new Date(item.registered_at).toISOString()});
  await assertCurrentSessionClock(q,actor);
  return {items,total:Number(total),next_offset:rows.length>limit?offset+limit:null};
  });
}

export async function publicEvent(pool:Pool,id:string){
  const row=(await pool.query(`SELECT e.event_id,e.title,e.description,e.starts_at,e.ends_at,e.mode,e.location,e.online_url,e.event_kind,e.topic,
    e.visibility,e.capacity,e.aggregate_version,u.display_name AS organizer_name,
    (SELECT orientation FROM community_event_banners b WHERE b.event_id=e.event_id) AS banner_orientation,
    (SELECT mime_type FROM community_event_videos v WHERE v.event_id=e.event_id) AS video_mime,
    ((SELECT count(*)::int FROM community_event_rsvps r WHERE r.event_id=e.event_id AND r.state='going' AND NOT is_verification_test_account(r.user_id))+
      (SELECT count(*)::int FROM community_event_guest_rsvps g WHERE g.event_id=e.event_id AND g.email_sent_at IS NOT NULL)) AS attending_count
    FROM community_events e JOIN users u ON u.user_id=e.organizer_ref WHERE e.event_id=$1 AND e.state='published' AND e.visibility IN ('referral','open') AND NOT is_verification_test_account(e.organizer_ref)`,[id])).rows[0];
  requireCondition(row,404,'not_found','找不到這場公開活動。');
  const referral=row.visibility==='referral';
  return {event_id:row.event_id,title:row.title,description:row.description,starts_at:row.starts_at,ends_at:row.ends_at,
    mode:row.mode,location:referral&&(row.mode==='online'||/https?:\/\//i.test(row.location))?'線上參與資料將寄至報名信箱':row.location,
    online_url:referral?null:row.online_url,event_kind:row.event_kind,topic:row.topic,visibility:row.visibility,
    capacity:row.capacity,aggregate_version:Number(row.aggregate_version),organizer_name:row.organizer_name,
    attending_count:row.attending_count,banner_orientation:row.banner_orientation,
    banner_url:row.banner_orientation?`/api/v1/public/events/${id}/banner`:null,
    video_url:row.video_mime?`/api/v1/public/events/${id}/video`:null,video_mime:row.video_mime};
}

export async function publicEventBanner(pool:Pool,id:string,store?:ObjectStore){
 return (await readDomainMedia(()=>bannerSnapshot(pool,id),{purpose:'community.event-banner',targetId:id,variant:'banner'},store)).bytes;
}

export type EventEmailSender=(to:string,subject:string,body:string)=>Promise<void>;
export async function registerPublicEvent(pool:Pool,id:string,raw:unknown,send:EventEmailSender,origin:string){
  const body=z.object({name:text(80),email:z.email().max(200),referral_code:shareCode.nullable().default(null)}).strict().parse(raw);
  const email=body.email.trim().toLowerCase();
  const registration=await transaction(pool,async q=>{
    const row=(await q.query(`SELECT * FROM community_events WHERE event_id=$1 FOR UPDATE`,[id])).rows[0];
    requireCondition(row&&row.state==='published'&&['referral','open'].includes(row.visibility)&&!(await q.query('SELECT is_verification_test_account($1) AS hidden',[row.organizer_ref])).rows[0].hidden,404,'not_found','找不到這場公開活動。');
    requireCondition(Date.parse(row.starts_at)>Date.now(),409,'event_closed','活動已開始或取消，無法報名。');
    requireCondition(row.visibility!=='referral'||body.referral_code,422,'share_code_required','請從會員分享的活動連結報名。');
    const referrer=await referralOwner(q,id,body.referral_code);
    await q.query("DELETE FROM community_event_guest_rsvps WHERE event_id=$1 AND email_sent_at IS NULL AND created_at<now()-interval '10 minutes'",[id]);
    const existing=(await q.query('SELECT email_sent_at FROM community_event_guest_rsvps WHERE event_id=$1 AND email=$2',[id,email])).rows[0];
    if(!existing){
      const count=(await q.query(`SELECT (SELECT count(*) FROM community_event_rsvps WHERE event_id=$1 AND state='going' AND NOT is_verification_test_account(user_id))+
        (SELECT count(*) FROM community_event_guest_rsvps WHERE event_id=$1) AS total`,[id])).rows[0].total;
      requireCondition(row.capacity===null||Number(count)<row.capacity,409,'event_full','活動名額已滿。');
      await q.query(`INSERT INTO community_event_guest_rsvps(event_id,email,name,referred_by_user_id) VALUES($1,$2,$3,$4)`,[id,email,body.name,referrer]);
    }else if(!existing.email_sent_at)await q.query('UPDATE community_event_guest_rsvps SET created_at=now() WHERE event_id=$1 AND email=$2',[id,email]);
    return row;
  });
  const event=registration;
  const local=(value:string)=>new Date(value).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',dateStyle:'medium',timeStyle:'short'});
  const parts=[`你已申請參加「${event.title}」。`,`時間：${local(event.starts_at)} 至 ${local(event.ends_at)}（台灣時間）`,
    `地點：${event.location}`,event.online_url?`線上參與連結：${event.online_url}`:'',`活動頁：${origin}/events/${event.event_id}`].filter(Boolean);
  try{await send(email,'自由工坊：活動參與資料',parts.join('\n\n'));}
  catch{
    throw new Problem(503,'event_email_delivery_failed','活動郵件暫時無法寄送，請稍後重試。');
  }
  await pool.query('UPDATE community_event_guest_rsvps SET email_sent_at=now() WHERE event_id=$1 AND email=$2',[id,email]);
  return {registered:true};
}

export async function readEvent(pool:Pool,actor:Actor,id:string){
  const row=await scopedEvent(pool,actor,id);
  const member=await canAccessGuildEvent(pool,actor,row);
  const reviewer=row.state==='pending'&&row.review_guild_key&&(await pool.query(`SELECT 1 FROM positioning_guild_officers o
    JOIN positioning_profession_memberships m ON m.community_id=o.community_id AND m.guild_key=o.guild_key AND m.user_id=o.user_id AND m.state='active'
    WHERE o.community_id=$1 AND o.guild_key=$2 AND o.user_id=$3`,[actor.community_id,row.review_guild_key,actor.user_id])).rowCount===1;
  requireCondition(!await testHostHidden(pool,row.organizer_ref,actor.user_id)&&(row.organizer_ref===actor.user_id||Boolean(reviewer)||row.state==='published'&&member),404,'not_found','找不到這場活動。');
  return eventView(pool,actor,row);
}

/** Existing organizer/intern/state rules, composed by the closed banner profile. */
export async function authorizeEventBannerWrite(q:PoolClient,actor:Actor,id:string,lock=false,editable=true){
 await lockMemberGuilds(q,actor);
 const row=await scopedEvent(q,actor,id,lock);
 requireCondition(row.organizer_ref===actor.user_id,403,'organizer_required','只能修改自己活動的 Banner。');
 await refuseInternGuildExchange(q,actor,row);
 if(editable){const clock=(await q.query('SELECT clock_timestamp() AS now')).rows[0].now;requireCondition(row.state==='pending'&&Date.parse(row.starts_at)>clock.getTime(),409,'event_closed','只能修改待審核且尚未開始的活動。');}
 return row;
}
export async function eventBannerResult(q:PoolClient,actor:Actor,id:string){
 // The original HTTP DTO serializes PostgreSQL Date values to ISO strings.
 // Serialize that trusted domain result before the strict receipt JSON boundary.
 return JSON.parse(JSON.stringify(await eventView(q,actor,await scopedEvent(q,actor,id)))) as Awaited<ReturnType<typeof eventView>>;
}

export async function saveEventBanner(pool:Pool,input:Command,id:string,upload:{bytes:Buffer;mime:string;orientation?:'landscape'|'portrait'}|null,assets?:EventBannerAssetService){
  if(upload)upload={...upload,bytes:Buffer.from(snapshotBoundedBytes(upload.bytes,524288))};
  const orientation=upload?.orientation??'landscape';
  const body=upload?{mime:upload.mime,orientation,sha256:createHash('sha256').update(upload.bytes).digest('hex')}:{removed:true};
  if(upload&&await eventBannerStorageMode(pool)!=='legacy')return saveAssetBanner(pool,{...input,actor:Object.freeze({...input.actor}),body},id,{...upload,orientation},assets);
  return command(pool,{...input,body},async q=>{
    const row=await scopedEvent(q,input.actor,id);
    requireCondition(row.organizer_ref===input.actor.user_id,403,'organizer_required','只能修改自己活動的 Banner。');
    await refuseInternGuildExchange(q,input.actor,row);
  },async q=>{
    const row=await scopedEvent(q,input.actor,id,true);
    checkVersion(row.aggregate_version,input.expected);
    requireCondition(row.state==='pending'&&Date.parse(row.starts_at)>Date.now(),409,'event_closed','只能修改待審核且尚未開始的活動。');
    if(upload){
      const normalized=await normalizeEventPoster(upload.mime,upload.bytes,orientation);
      await q.query(`INSERT INTO community_event_banners(event_id,image_bytes,orientation) VALUES($1,$2,$3)
        ON CONFLICT(event_id) DO UPDATE SET image_bytes=EXCLUDED.image_bytes,orientation=EXCLUDED.orientation,updated_at=now()`,[id,normalized,orientation]);
    }else await q.query('DELETE FROM community_event_banners WHERE event_id=$1',[id]);
    const updated=(await q.query('UPDATE community_events SET aggregate_version=aggregate_version+1,updated_at=now() WHERE event_id=$1 RETURNING *',[id])).rows[0];
    await journal(q,input.actor,'community_event',id,updated.aggregate_version,upload?'save_banner':'remove_banner',{});
    return eventView(q,input.actor,updated);
  });
}

async function saveAssetBanner(pool:Pool,input:Command,id:string,file:{bytes:Buffer;mime:string;orientation:'landscape'|'portrait'},assets?:EventBannerAssetService){
 const authorize=(q:PoolClient)=>authorizeEventBannerWrite(q,input.actor,id,false,false).then(()=>{});
 const probe=async()=>{const miss=new Error('banner_receipt_miss');try{return await eventBannerMemberCommand(pool,input,authorize,async()=>{throw miss;});}catch(e){if(e!==miss)throw e;return undefined;}};
 const replay=await probe();if(replay)return replay;
 requireCondition(assets,503,'media_upload_unavailable','內容上傳暫時無法使用。');if(input.expected===undefined)checkVersion('1',input.expected);
 const key=digest({operation:input.operation,key:input.key});
 try{
  const prepared=await assets!.prepare(input.actor,{key,targetEventId:id,expectedVersion:input.expected!,contentType:file.mime as 'image/png'|'image/jpeg'|'image/webp',byteSize:file.bytes.length,sha256:(input.body as {sha256:string}).sha256,orientation:file.orientation});
  const lease=await assets!.resumeUpload(input.actor,{key,intentId:prepared.intentId}),binding={intentId:lease.intentId,fence:lease.fence,leaseToken:lease.leaseToken};
  if(lease.state==='prepared'||lease.state==='processing')await assets!.write(input.actor,{...binding,key:digest({key,phase:'write',fence:lease.fence})},new ReadableStream({start(c){c.enqueue(file.bytes);c.close();}}));
  let publicationClient:PoolClient;
  return await assets!.finalizeVia<Awaited<ReturnType<typeof eventBannerResult>>>(input.actor,{...binding,key:digest({key,phase:'finalize'})},{operation:'community.event.banner.replace',execute:run=>eventBannerMemberCommand(pool,input,authorize,async(q,context)=>{publicationClient=q;return run(q,context);}),validateIntent:row=>requireCondition(row.expected_version===input.expected&&row.target_event_id===id&&row.source_sha256===(input.body as {sha256:string}).sha256&&row.source_orientation===file.orientation,409,'asset_source_mismatch','上傳內容與準備紀錄不同。'),result:()=>eventBannerResult(publicationClient,input.actor,id)});
 }catch(e){const committed=await probe();if(committed)return committed;if(e instanceof AssetStorageError)throw new Problem(503,'media_upload_unavailable','內容上傳暫時無法使用。');throw e;}
}
async function saveAssetVideo(pool:Pool,input:Command,id:string,file:{bytes:Buffer;mime:'video/mp4'|'video/webm'},assets?:EventVideoAssetService){
 const authorize=(q:PoolClient)=>authorizeEventBannerWrite(q,input.actor,id,false,false).then(()=>{});
 const probe=async()=>{const miss=new Error('video_receipt_miss');try{return await eventVideoMemberCommand(pool,input,authorize,async()=>{throw miss;});}catch(e){if(e!==miss)throw e;return undefined;}};
 const replay=await probe();if(replay)return replay;
 requireCondition(assets,503,'media_upload_unavailable','內容上傳暫時無法使用。');if(input.expected===undefined)checkVersion('1',input.expected);
 const key=digest({operation:input.operation,key:input.key});
 try{
  const prepared=await assets!.prepare(input.actor,{key,targetEventId:id,expectedVersion:input.expected!,contentType:file.mime,byteSize:file.bytes.length,sha256:(input.body as {sha256:string}).sha256});
  const lease=await assets!.resumeUpload(input.actor,{key,intentId:prepared.intentId}),binding={intentId:lease.intentId,fence:lease.fence,leaseToken:lease.leaseToken};
  if(lease.state==='prepared'||lease.state==='processing')await assets!.write(input.actor,{...binding,key:digest({key,phase:'write',fence:lease.fence})},new ReadableStream({start(c){c.enqueue(file.bytes);c.close();}}));
  let publicationClient:PoolClient;
  return await assets!.finalizeVia<Awaited<ReturnType<typeof eventBannerResult>>>(input.actor,{...binding,key:digest({key,phase:'finalize'})},{operation:'community.event.video.replace',execute:run=>eventVideoMemberCommand(pool,input,authorize,async(q,context)=>{publicationClient=q;return run(q,context);}),validateIntent:row=>requireCondition(row.expected_version===input.expected&&row.target_video_event_id===id&&row.source_sha256===(input.body as {sha256:string}).sha256&&row.source_content_type===file.mime,409,'asset_source_mismatch','上傳內容與準備紀錄不同。'),result:()=>eventBannerResult(publicationClient,input.actor,id)});
 }catch(e){const committed=await probe();if(committed)return committed;if(e instanceof AssetStorageError)throw new Problem(503,'media_upload_unavailable','內容上傳暫時無法使用。');throw e;}
}
async function bannerSnapshot(pool:Pool,id:string,actor?:Actor):Promise<DomainMediaSnapshot|undefined>{
 const row=(await pool.query(`SELECT e.*,b.storage_source,b.image_bytes,b.orientation,t.asset_id,t.scope_id,o.representation_id,o.content_type,o.byte_size,o.content_sha256,o.transform_version,o.policy_revision,o.profile_id
 FROM community_events e JOIN community_event_banners b USING(event_id)
 LEFT JOIN community_event_banner_asset_targets t ON t.event_id=e.event_id AND t.linked_at_version<=e.aggregate_version
 LEFT JOIN assets a ON a.asset_id=t.asset_id AND a.state='ready' AND a.purpose='community.event-banner'
 LEFT JOIN asset_objects o ON o.asset_id=a.asset_id AND o.purpose='community.event-banner'
 WHERE e.event_id=$1 AND ${actor?'e.community_id=$2':"e.state='published' AND e.visibility IN ('referral','open') AND NOT is_verification_test_account(e.organizer_ref)"}`,actor?[id,actor.community_id]:[id])).rows[0];
 if(!row)return undefined;
 let member=false,reviewer=false;
 if(actor){member=await canAccessGuildEvent(pool,actor,row);reviewer=row.state==='pending'&&row.review_guild_key&&(await pool.query(`SELECT 1 FROM positioning_guild_officers o JOIN positioning_profession_memberships m ON m.community_id=o.community_id AND m.guild_key=o.guild_key AND m.user_id=o.user_id AND m.state='active' WHERE o.community_id=$1 AND o.guild_key=$2 AND o.user_id=$3`,[actor.community_id,row.review_guild_key,actor.user_id])).rowCount===1;if(!(row.organizer_ref===actor.user_id||reviewer||row.state==='published'&&member))return undefined;}
 return {purpose:'community.event-banner',targetId:id,variant:'banner',domainVersion:String(row.aggregate_version),source:row.storage_source,authorizationVersion:JSON.stringify([row.community_id,row.organizer_ref,row.state,row.visibility,row.guild_key,row.review_guild_key,row.orientation,member,reviewer]),legacyBytes:row.image_bytes,assetId:row.asset_id,scopeId:row.scope_id,representationId:row.representation_id,metadata:row.representation_id?{contentType:row.content_type,byteSize:row.byte_size,sha256:row.content_sha256,transformVersion:row.transform_version,policyRevision:row.policy_revision,profileId:row.profile_id}:null};
}
export async function readEventBanner(pool:Pool,actor:Actor,id:string,store?:ObjectStore){return (await readDomainMedia(()=>bannerSnapshot(pool,id,actor),{purpose:'community.event-banner',targetId:id,variant:'banner'},store)).bytes;}

export async function saveEventVideo(pool:Pool,input:Command,id:string,upload:{bytes:Buffer;mime:'video/mp4'|'video/webm'}|null,assets?:EventVideoAssetService){
  if(upload)upload={...upload,bytes:Buffer.from(snapshotBoundedBytes(upload.bytes,20971520))};
  const body=upload?{mime:upload.mime,sha256:createHash('sha256').update(upload.bytes).digest('hex')}:{removed:true};
  if(upload){
    const bytes=upload.bytes;
    requireCondition(bytes.length>0&&bytes.length<=20*1024*1024,413,'event_video_too_large','影片需為 20 MiB 以下。');
    const valid=upload.mime==='video/mp4'?bytes.length>=12&&bytes.toString('ascii',4,8)==='ftyp'
      :bytes.length>=4&&bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
    requireCondition(valid,422,'invalid_event_video','影片格式不符，請上傳 MP4 或 WebM。');
  }
  if(upload&&await eventVideoStorageMode(pool)!=='legacy')return saveAssetVideo(pool,{...input,actor:Object.freeze({...input.actor}),body},id,upload,assets);
  return command(pool,{...input,body},async q=>{
    const row=await scopedEvent(q,input.actor,id);
    requireCondition(row.organizer_ref===input.actor.user_id,403,'organizer_required','只能修改自己活動的影片。');
    await refuseInternGuildExchange(q,input.actor,row);
  },async q=>{
    const row=await scopedEvent(q,input.actor,id,true);checkVersion(row.aggregate_version,input.expected);
    requireCondition(row.state==='pending'&&Date.parse(row.starts_at)>Date.now(),409,'event_closed','只能修改待審核且尚未開始的活動。');
    if(upload)await q.query(`INSERT INTO community_event_videos(event_id,media_bytes,mime_type) VALUES($1,$2,$3)
      ON CONFLICT(event_id) DO UPDATE SET media_bytes=EXCLUDED.media_bytes,mime_type=EXCLUDED.mime_type,updated_at=now()`,[id,upload.bytes,upload.mime]);
    else await q.query('DELETE FROM community_event_videos WHERE event_id=$1',[id]);
    const updated=(await q.query('UPDATE community_events SET aggregate_version=aggregate_version+1,updated_at=now() WHERE event_id=$1 RETURNING *',[id])).rows[0];
    await journal(q,input.actor,'community_event',id,updated.aggregate_version,upload?'save_video':'remove_video',{});
    return eventView(q,input.actor,updated);
  });
}

async function videoSnapshot(pool:Pool,id:string,actor?:Actor):Promise<DomainMediaSnapshot|undefined>{
 let access;try{access=actor?await readEvent(pool,actor,id):await publicEvent(pool,id);}catch(error){if(error instanceof Problem&&error.status===404)return undefined;throw error;}
 const row=(await pool.query(`SELECT e.aggregate_version::text AS version,v.storage_source,CASE WHEN v.storage_source='legacy' THEN v.media_bytes END AS media_bytes,v.mime_type,t.asset_id,t.scope_id,o.representation_id,o.content_type,o.byte_size,o.content_sha256,o.transform_version,o.policy_revision,o.profile_id FROM community_events e JOIN community_event_videos v USING(event_id) LEFT JOIN community_event_video_asset_targets t ON t.event_id=e.event_id AND t.linked_at_version<=e.aggregate_version LEFT JOIN assets a ON a.asset_id=t.asset_id AND a.state='ready' AND a.purpose='community.event-video' LEFT JOIN asset_objects o ON o.asset_id=a.asset_id AND o.purpose='community.event-video' WHERE e.event_id=$1`,[id])).rows[0];if(!row)return undefined;
 return {purpose:'community.event-video',targetId:id,variant:'video',domainVersion:row.version,source:row.storage_source,authorizationVersion:JSON.stringify(access),legacyBytes:row.media_bytes,legacyContentType:row.mime_type,assetId:row.asset_id,scopeId:row.scope_id,representationId:row.representation_id,metadata:row.representation_id?{contentType:row.content_type,byteSize:row.byte_size,sha256:row.content_sha256,transformVersion:row.transform_version,policyRevision:row.policy_revision,profileId:row.profile_id}:null};
}
export async function readEventVideo(pool:Pool,actor:Actor,id:string,store?:ObjectStore){const media=await readDomainMedia(()=>videoSnapshot(pool,id,actor),{purpose:'community.event-video',targetId:id,variant:'video'},store);return {bytes:media.bytes,mime:media.contentType as 'video/mp4'|'video/webm'};}
export async function publicEventVideo(pool:Pool,id:string,store?:ObjectStore){const media=await readDomainMedia(()=>videoSnapshot(pool,id),{purpose:'community.event-video',targetId:id,variant:'video'},store);return {bytes:media.bytes,mime:media.contentType as 'video/mp4'|'video/webm'};}
export async function eventVideoHttp(pool:Pool,id:string,request:{method:'GET'|'HEAD';rangeHeader?:string;ifRangeHeader?:string},store?:ObjectStore,actor?:Actor){return readEventVideoHttp(()=>videoSnapshot(pool,id,actor),request,store);}

async function activeGuildTier(q:PoolClient,actor:Actor,guildKey:string|null){
  if(!guildKey)return undefined;
  await lockMemberGuilds(q,actor);
  return (await q.query(`SELECT member_tier FROM positioning_profession_memberships WHERE community_id=$1 AND guild_key=$2 AND user_id=$3 AND state='active'`,[actor.community_id,guildKey,actor.user_id])).rows[0]?.member_tier as string|undefined;
}
/** Active interns cannot post or edit a guild skill exchange. Former members keep the organizer path. */
export async function refuseInternGuildExchange(q:PoolClient,actor:Actor,row:{event_kind?:string;guild_key?:string|null}){
  if(row.event_kind!=='guild_skill_exchange')return;
  const tier=await activeGuildTier(q,actor,row.guild_key??null);
  if(tier)requireFullGuildMember(tier);
}

export async function createEvent(pool:Pool,input:Command) {
  const body=details.parse(input.body);
  return command(pool,input,async()=>{},async q=>{
    requireCondition(Date.parse(body.starts_at)>Date.now(),422,'event_in_past','活動開始時間須在未來。');
    if(body.guild_key)requireCondition((await q.query('SELECT 1 FROM positioning_guild_catalog WHERE guild_key=$1',[body.guild_key])).rowCount===1,422,'unknown_guild','請選擇現有公會。');
    if(body.event_kind==='guild_skill_exchange'){const tier=await activeGuildTier(q,input.actor,body.guild_key);requireCondition(tier,403,'event_guild_required','只有主辦公會成員能提交公會技能交流。');requireFullGuildMember(tier);}
    // The command has already checked receipts; replay never consumes this budget.
    await authRateLimitInTransaction(q,'event-create-member',input.actor.user_id,eventCreateLimit,eventCreateWindowSeconds);
    const id=randomUUID();
    const row=(await q.query(`INSERT INTO community_events(event_id,community_id,organizer_ref,guild_key,title,description,starts_at,ends_at,mode,location,capacity,event_kind,topic,online_url,review_guild_key,visibility)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,[id,input.actor.community_id,input.actor.user_id,body.guild_key,body.title,body.description,body.starts_at,body.ends_at,body.mode,body.location,body.capacity,body.event_kind,body.topic,body.online_url,reviewGuildFor(body),body.visibility])).rows[0];
    const organizer=(await q.query('SELECT display_name FROM users WHERE user_id=$1',[input.actor.user_id])).rows[0].display_name as string;
    await bulletin(q,row,'submitted',organizer,organizer);
    await notifyMember(q,{community_id:row.community_id,recipient_ref:row.organizer_ref,kind:'event_submitted',source_key:`event/${id}/submitted`,title:'活動已送出審核',body:`「${body.title}」已送出；核准後才會開放報名。`,action:{tab:'events',resource_id:null}});
    const reviewers=(await q.query(`SELECT DISTINCT u.user_id FROM users u WHERE u.community_id=$1 AND u.active AND (
      (u.email_verified_at IS NOT NULL AND EXISTS(SELECT 1 FROM platform_admins p WHERE p.community_id=$1 AND p.active AND p.email=lower(u.email)))
      OR ($2::text IS NOT NULL AND EXISTS(SELECT 1 FROM positioning_guild_officers o JOIN positioning_profession_memberships m
        ON m.community_id=o.community_id AND m.guild_key=o.guild_key AND m.user_id=o.user_id AND m.state='active'
        WHERE o.community_id=$1 AND o.guild_key=$2 AND o.user_id=u.user_id)))`,[row.community_id,row.review_guild_key])).rows as {user_id:string}[];
    for(const reviewer of reviewers)if(reviewer.user_id!==row.organizer_ref)await notifyMember(q,{community_id:row.community_id,recipient_ref:reviewer.user_id,kind:'event_review_needed',source_key:`event/${id}/review-needed`,title:'有活動待審核',body:`${organizer} 提交了「${body.title}」。`,action:{tab:'events',resource_id:null}});
    await journal(q,input.actor,'community_event',id,1,'submit',{title:body.title,guild_key:body.guild_key},'freedom.community.event.submitted.v1');
    return eventView(q,input.actor,row);
  });
}

export async function updateEvent(pool:Pool,input:Command,id:string) {
  const body=details.parse(input.body);
  return command(pool,input,async q=>{
    const row=await scopedEvent(q,input.actor,id);
    requireCondition(row.organizer_ref===input.actor.user_id,403,'organizer_required','只能編輯自己發佈的活動。');
    await refuseInternGuildExchange(q,input.actor,row);
  },async q=>{
    const row=await scopedEvent(q,input.actor,id,true);
    checkVersion(row.aggregate_version,input.expected);
    requireCondition(row.state==='pending'&&Date.parse(row.starts_at)>Date.now(),409,'event_closed','只能修改待審核且尚未開始的活動。');
    requireCondition(Date.parse(body.starts_at)>Date.now(),422,'event_in_past','活動開始時間須在未來。');
    requireCondition(body.guild_key===row.guild_key&&body.mode===row.mode&&body.event_kind===row.event_kind&&body.visibility===row.visibility,422,'event_review_route_immutable','送出後不能更換主辦公會、形式、類型或參與範圍；請取消並重新提交。');
    const updated=(await q.query(`UPDATE community_events SET title=$2,description=$3,starts_at=$4,ends_at=$5,mode=$6,location=$7,capacity=$8,
      event_kind=$9,topic=$10,online_url=$11,visibility=$12,aggregate_version=aggregate_version+1,updated_at=now() WHERE event_id=$1 RETURNING *`,[id,body.title,body.description,body.starts_at,body.ends_at,body.mode,body.location,body.capacity,body.event_kind,body.topic,body.online_url,body.visibility])).rows[0];
    await journal(q,input.actor,'community_event',id,updated.aggregate_version,'update',{title:body.title});
    return eventView(q,input.actor,updated);
  });
}

export async function cancelEvent(pool:Pool,input:Command,id:string) {
  z.object({}).strict().parse(input.body);
  return command(pool,input,async q=>{
    const row=await scopedEvent(q,input.actor,id);
    requireCondition(row.organizer_ref===input.actor.user_id,403,'organizer_required','只能取消自己發佈的活動。');
    await refuseInternGuildExchange(q,input.actor,row);
  },async q=>{
    const row=await scopedEvent(q,input.actor,id,true);
    checkVersion(row.aggregate_version,input.expected);
    requireCondition(row.state==='published'||row.state==='pending',409,'event_closed','這場活動已關閉。');
    const updated=(await q.query("UPDATE community_events SET state='cancelled',aggregate_version=aggregate_version+1,updated_at=now() WHERE event_id=$1 RETURNING *",[id])).rows[0];
    await journal(q,input.actor,'community_event',id,updated.aggregate_version,'cancel',{},'freedom.community.event.cancelled.v1');
    return eventView(q,input.actor,updated);
  });
}

async function applyReview(q:PoolClient,row:any,decision:'approve'|'reject',reason:string,reviewer:{name:string;userId?:string;adminId?:string}){
  requireCondition(row.state==='pending',409,'event_reviewed','這場活動已完成審核。');
  requireCondition(Date.parse(row.starts_at)>Date.now(),409,'event_started','活動開始時間已過，請提交新的活動。');
  const state=decision==='approve'?'published':'rejected';
  const updated=(await q.query(`UPDATE community_events SET state=$2,reviewer_user_ref=$3,reviewer_admin_ref=$4,
    review_reason=$5,reviewed_at=now(),aggregate_version=aggregate_version+1,updated_at=now()
    WHERE event_id=$1 RETURNING *`,[row.event_id,state,reviewer.userId??null,reviewer.adminId??null,reason])).rows[0];
  const organizer=(await q.query('SELECT display_name FROM users WHERE user_id=$1',[row.organizer_ref])).rows[0].display_name as string;
  await bulletin(q,updated,decision==='approve'?'approved':'rejected',reviewer.name,organizer);
  await notifyMember(q,{community_id:row.community_id,recipient_ref:row.organizer_ref,
    kind:decision==='approve'?'event_approved':'event_rejected',source_key:`event/${row.event_id}/${state}`,
    title:decision==='approve'?'活動已核准':'活動未通過審核',
    body:decision==='approve'?`${reviewer.name} 已核准「${row.title}」，現在可公開報名。`:`${reviewer.name} 未核准「${row.title}」：${reason}`,
    action:{tab:'events',resource_id:null}});
  return updated;
}

async function requireGuildReviewer(q:PoolClient,actor:Actor,row:any){
  requireCondition(row.review_guild_key,403,'event_admin_review_required','未指定公會的活動由平台管理員審核。');
  const eligible=(await q.query(`SELECT 1 FROM positioning_guild_officers o
    JOIN positioning_profession_memberships m ON m.community_id=o.community_id AND m.guild_key=o.guild_key AND m.user_id=o.user_id AND m.state='active'
    WHERE o.community_id=$1 AND o.guild_key=$2 AND o.user_id=$3 FOR SHARE OF o,m`,[actor.community_id,row.review_guild_key,actor.user_id])).rowCount===1;
  requireCondition(eligible,403,'guild_master_required','只有這場活動所屬公會的現任會長可審核。');
}

export async function reviewEventAsGuildMaster(pool:Pool,input:Command,id:string){
  const body=reviewInput.parse(input.body);
  return command(pool,input,async q=>{const row=await scopedEvent(q,input.actor,id);await requireGuildReviewer(q,input.actor,row);},async q=>{
    const row=await scopedEvent(q,input.actor,id,true);await requireGuildReviewer(q,input.actor,row);checkVersion(row.aggregate_version,input.expected);
    const name=(await q.query('SELECT display_name FROM users WHERE user_id=$1',[input.actor.user_id])).rows[0].display_name as string;
    const reviewed=await applyReview(q,row,body.decision,body.reason,{name,userId:input.actor.user_id});
    await journal(q,input.actor,'community_event',id,reviewed.aggregate_version,body.decision==='approve'?'approve':'reject',{reason:body.reason},`freedom.community.event.${body.decision==='approve'?'approved':'rejected'}.v1`);
    return eventView(q,input.actor,reviewed);
  });
}

export async function listAdminEventQueue(pool:Pool,admin:AdminActor){
  return (await pool.query(`SELECT e.*,u.display_name AS organizer_name,g.name AS guild_name
    FROM community_events e JOIN users u ON u.user_id=e.organizer_ref
    LEFT JOIN positioning_guild_catalog g ON g.guild_key=e.guild_key
    WHERE e.community_id=$1 AND e.state='pending' AND NOT is_verification_test_account(e.organizer_ref) ORDER BY e.created_at,e.event_id LIMIT 100`,[admin.community_id])).rows;
}

export async function reviewEventAsAdmin(pool:Pool,input:AdminCommand,id:string){
  const body=reviewInput.parse(input.body);
  const scoped=async(q:PoolClient,lock=false)=>{
    const row=(await q.query(`SELECT * FROM community_events WHERE event_id=$1 AND community_id=$2${lock?' FOR UPDATE':''}`,[id,input.admin.community_id])).rows[0];
    requireCondition(row,404,'event_not_found','找不到這場活動。');return row;
  };
  return adminCommand(pool,input,q=>scoped(q),async q=>{
    const row=await scoped(q,true);checkVersion(row.aggregate_version,input.expected);
    const reviewed=await applyReview(q,row,body.decision,body.reason,{name:input.admin.display_name,adminId:input.admin.admin_id});
    await audit(q,input.admin,'community_event_review','community_event',id,body.reason,
      {state:row.state,aggregate_version:row.aggregate_version},{state:reviewed.state,aggregate_version:reviewed.aggregate_version});
    return reviewed;
  });
}

export async function setRsvp(pool:Pool,input:Command,id:string) {
  const body=z.object({going:z.boolean(),referral_code:shareCode.nullable().optional()}).strict().parse(input.body);
  return command(pool,input,q=>scopedEvent(q,input.actor,id),async q=>{
    // Lock the event so simultaneous last-seat requests see the same RSVP count.
    const row=await scopedEvent(q,input.actor,id,true);
    requireCondition(!await testHostHidden(q,row.organizer_ref,input.actor.user_id)&&await canAccessGuildEvent(q,input.actor,row),404,'not_found','找不到這場活動。');
    const referrer=body.going?await referralOwner(q,id,body.referral_code??null):null;
    if(body.going){
      requireCondition(row.state==='published'&&Date.parse(row.starts_at)>Date.now(),409,'event_closed','活動已開始或取消，無法報名。');
      if(row.visibility==='guild'){
        const member=await q.query(`SELECT 1 FROM positioning_profession_memberships WHERE community_id=$1 AND guild_key=$2 AND user_id=$3 AND state='active' FOR SHARE`,[row.community_id,row.guild_key,input.actor.user_id]);
        requireCondition(member.rowCount===1,403,'event_guild_required','這場活動只開放主辦公會成員報名。');
      }
      requireCondition(row.visibility!=='referral'||referrer,422,'share_code_required','請從會員分享的活動連結報名。');
      const mine=(await q.query('SELECT state FROM community_event_rsvps WHERE event_id=$1 AND user_id=$2',[id,input.actor.user_id])).rows[0]?.state;
      if(mine!=='going'){
        await q.query("DELETE FROM community_event_guest_rsvps WHERE event_id=$1 AND email_sent_at IS NULL AND created_at<now()-interval '10 minutes'",[id]);
        const count=(await q.query(`SELECT (SELECT count(*) FROM community_event_rsvps WHERE event_id=$1 AND state='going' AND NOT is_verification_test_account(user_id))+
          (SELECT count(*) FROM community_event_guest_rsvps WHERE event_id=$1) AS total`,[id])).rows[0].total;
        requireCondition(row.capacity===null||Number(count)<row.capacity,409,'event_full','活動名額已滿。');
      }
    }
    const rsvp=(await q.query(`INSERT INTO community_event_rsvps(rsvp_id,event_id,user_id,state,referred_by_user_id) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(event_id,user_id) DO UPDATE SET state=EXCLUDED.state,
        referred_by_user_id=COALESCE(community_event_rsvps.referred_by_user_id,EXCLUDED.referred_by_user_id),
        aggregate_version=community_event_rsvps.aggregate_version+1,updated_at=now()
      RETURNING rsvp_id,aggregate_version`,[randomUUID(),id,input.actor.user_id,body.going?'going':'cancelled',referrer===input.actor.user_id?null:referrer])).rows[0];
    await journal(q,input.actor,'community_event_rsvp',rsvp.rsvp_id,rsvp.aggregate_version,body.going?'rsvp':'withdraw_rsvp',{event_id:id});
    return eventView(q,input.actor,row);
  });
}
