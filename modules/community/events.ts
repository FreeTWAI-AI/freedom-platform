import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { checkVersion, command, journal, type Command } from '../../packages/db/index.js';
import { requireCondition } from '../../packages/shared/problem.js';
import { text, isoTime } from '../../packages/shared/validation.js';
import type { Actor } from '../identity-membership/service.js';
import { normalizeCoverImage } from '../skill-submissions/payload.js';
import {notifyMember} from '../member-communications/notifications.js';
import {adminCommand,audit,type AdminActor,type AdminCommand} from '../platform-admin/service.js';

const details = z.object({
  title:text(120), description:text(3000), starts_at:isoTime, ends_at:isoTime,
  mode:z.enum(['online','in_person','hybrid']), location:text(300),
  event_kind:z.enum(['reading_group','meetup','guild_skill_exchange','other']).default('other'),
  topic:text(160).nullable().default(null),
  online_url:z.string().trim().max(500).refine(value=>{try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port;}catch{return false;}},'請提供安全的 HTTPS 參與連結。').nullable().default(null),
  visibility:z.enum(['public','guild']).default('public'),
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

async function scopedEvent(q:Pick<PoolClient,'query'>,actor:Actor,id:string,lock=false) {
  const row=(await q.query(`SELECT * FROM community_events WHERE event_id=$1 AND community_id=$2${lock?' FOR UPDATE':''}`,[id,actor.community_id])).rows[0];
  requireCondition(row,404,'not_found','找不到這場活動。');return row;
}

async function canAccessGuildEvent(q:Pick<PoolClient,'query'>,actor:Actor,row:any){
  if(row.visibility!=='guild'||row.organizer_ref===actor.user_id)return true;
  const member=await q.query(`SELECT 1 FROM positioning_profession_memberships
    WHERE community_id=$1 AND guild_key=$2 AND user_id=$3 AND state='active'`,[row.community_id,row.guild_key,actor.user_id]);
  return member.rowCount===1;
}

async function eventView(q:Pick<PoolClient,'query'>,actor:Actor,row:any) {
  const count=(await q.query("SELECT count(*)::int AS total FROM community_event_rsvps WHERE event_id=$1 AND state='going'",[row.event_id])).rows[0].total as number;
  const mine=(await q.query('SELECT state FROM community_event_rsvps WHERE event_id=$1 AND user_id=$2',[row.event_id,actor.user_id])).rows[0]?.state??null;
  const canReview=row.state==='pending'&&row.review_guild_key&&(await q.query(`SELECT 1 FROM positioning_guild_officers o
    JOIN positioning_profession_memberships m ON m.community_id=o.community_id AND m.guild_key=o.guild_key AND m.user_id=o.user_id AND m.state='active'
    WHERE o.community_id=$1 AND o.guild_key=$2 AND o.user_id=$3`,[actor.community_id,row.review_guild_key,actor.user_id])).rowCount===1;
  const hasBanner=(await q.query('SELECT 1 FROM community_event_banners WHERE event_id=$1',[row.event_id])).rowCount===1;
  return {...row,banner_url:hasBanner?`/api/v1/events/${row.event_id}/banner?v=${row.aggregate_version}`:null,organizer_name:(await q.query('SELECT display_name FROM users WHERE user_id=$1',[row.organizer_ref])).rows[0]?.display_name??'社群成員',attending_count:count,my_rsvp:mine,can_review:Boolean(canReview)};
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
      (e.visibility='public' OR e.organizer_ref=$2 OR EXISTS(
        SELECT 1 FROM positioning_profession_memberships m WHERE m.community_id=e.community_id
          AND m.user_id=$2 AND m.guild_key=e.guild_key AND m.state='active'))
    ORDER BY b.created_at DESC,b.bulletin_id DESC LIMIT 30`,[actor.community_id,actor.user_id])).rows;
}

export async function listEvents(pool:Pool,actor:Actor) {
  if(actor.onboarding_required&&!actor.onboarding_completed_at) {
    return (await pool.query(`SELECT event_id,title,starts_at,ends_at,mode,state
      FROM community_events WHERE community_id=$1 AND ((state='published' AND visibility='public' AND starts_at>now()) OR organizer_ref=$2)
      ORDER BY starts_at,event_id LIMIT 30`,[actor.community_id,actor.user_id])).rows;
  }
  const rows=(await pool.query(`SELECT e.*,u.display_name AS organizer_name,
    (CASE WHEN EXISTS(SELECT 1 FROM community_event_banners b WHERE b.event_id=e.event_id)
      THEN '/api/v1/events/'||e.event_id||'/banner?v='||e.aggregate_version ELSE NULL END) AS banner_url,
    (SELECT count(*)::int FROM community_event_rsvps r WHERE r.event_id=e.event_id AND r.state='going') AS attending_count,
    (SELECT state FROM community_event_rsvps r WHERE r.event_id=e.event_id AND r.user_id=$2) AS my_rsvp,
    (e.state='pending' AND e.review_guild_key IS NOT NULL AND EXISTS(
      SELECT 1 FROM positioning_guild_officers o JOIN positioning_profession_memberships m
        ON m.community_id=o.community_id AND m.guild_key=o.guild_key AND m.user_id=o.user_id AND m.state='active'
      WHERE o.community_id=e.community_id AND o.guild_key=e.review_guild_key AND o.user_id=$2)) AS can_review
    FROM community_events e JOIN users u ON u.user_id=e.organizer_ref
    WHERE e.community_id=$1 AND ((e.state='published' AND e.starts_at>now()-interval '30 days' AND
      (e.visibility='public' OR e.organizer_ref=$2 OR EXISTS(
        SELECT 1 FROM positioning_profession_memberships gm WHERE gm.community_id=e.community_id
          AND gm.user_id=$2 AND gm.guild_key=e.guild_key AND gm.state='active')))
      OR e.organizer_ref=$2 OR (e.state='pending' AND e.review_guild_key IS NOT NULL AND EXISTS(
        SELECT 1 FROM positioning_guild_officers o JOIN positioning_profession_memberships m
          ON m.community_id=o.community_id AND m.guild_key=o.guild_key AND m.user_id=o.user_id AND m.state='active'
        WHERE o.community_id=e.community_id AND o.guild_key=e.review_guild_key AND o.user_id=$2)))
    ORDER BY e.starts_at,e.event_id LIMIT 100`,[actor.community_id,actor.user_id])).rows;
  return rows;
}

export async function saveEventBanner(pool:Pool,input:Command,id:string,upload:{bytes:Buffer;mime:string}|null){
  const body=upload?{mime:upload.mime,sha256:createHash('sha256').update(upload.bytes).digest('hex')}:{};
  return command(pool,{...input,body},async q=>{
    const row=await scopedEvent(q,input.actor,id);
    requireCondition(row.organizer_ref===input.actor.user_id,403,'organizer_required','只能修改自己活動的 Banner。');
  },async q=>{
    const row=await scopedEvent(q,input.actor,id,true);
    checkVersion(row.aggregate_version,input.expected);
    requireCondition(row.state==='pending'&&Date.parse(row.starts_at)>Date.now(),409,'event_closed','只能修改待審核且尚未開始的活動。');
    if(upload){
      const normalized=await normalizeCoverImage(upload.mime,upload.bytes.toString('base64'));
      await q.query(`INSERT INTO community_event_banners(event_id,image_bytes) VALUES($1,$2)
        ON CONFLICT(event_id) DO UPDATE SET image_bytes=EXCLUDED.image_bytes,updated_at=now()`,[id,normalized.webp]);
    }else await q.query('DELETE FROM community_event_banners WHERE event_id=$1',[id]);
    const updated=(await q.query('UPDATE community_events SET aggregate_version=aggregate_version+1,updated_at=now() WHERE event_id=$1 RETURNING *',[id])).rows[0];
    await journal(q,input.actor,'community_event',id,updated.aggregate_version,upload?'save_banner':'remove_banner',{});
    return eventView(q,input.actor,updated);
  });
}

export async function readEventBanner(pool:Pool,actor:Actor,id:string){
  const row=(await pool.query(`SELECT e.*,b.image_bytes FROM community_events e JOIN community_event_banners b ON b.event_id=e.event_id
    WHERE e.event_id=$1 AND e.community_id=$2`,[id,actor.community_id])).rows[0];
  requireCondition(row,404,'not_found','找不到活動 Banner。');
  const member=await canAccessGuildEvent(pool,actor,row);
  const reviewer=row.state==='pending'&&row.review_guild_key&&(await pool.query(`SELECT 1 FROM positioning_guild_officers o
    JOIN positioning_profession_memberships m ON m.community_id=o.community_id AND m.guild_key=o.guild_key AND m.user_id=o.user_id AND m.state='active'
    WHERE o.community_id=$1 AND o.guild_key=$2 AND o.user_id=$3`,[actor.community_id,row.review_guild_key,actor.user_id])).rowCount===1;
  requireCondition(row.organizer_ref===actor.user_id||Boolean(reviewer)||row.state==='published'&&member,404,'not_found','找不到活動 Banner。');
  return row.image_bytes as Buffer;
}

export async function createEvent(pool:Pool,input:Command) {
  const body=details.parse(input.body);
  return command(pool,input,async()=>{},async q=>{
    requireCondition(Date.parse(body.starts_at)>Date.now(),422,'event_in_past','活動開始時間須在未來。');
    if(body.guild_key)requireCondition((await q.query('SELECT 1 FROM positioning_guild_catalog WHERE guild_key=$1',[body.guild_key])).rowCount===1,422,'unknown_guild','請選擇現有公會。');
    if(body.event_kind==='guild_skill_exchange')requireCondition((await q.query(`SELECT 1 FROM positioning_profession_memberships WHERE community_id=$1 AND guild_key=$2 AND user_id=$3 AND state='active'`,[input.actor.community_id,body.guild_key,input.actor.user_id])).rowCount===1,403,'event_guild_required','只有主辦公會成員能提交公會技能交流。');
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
    WHERE e.community_id=$1 AND e.state='pending' ORDER BY e.created_at,e.event_id LIMIT 100`,[admin.community_id])).rows;
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
  const body=z.object({going:z.boolean()}).strict().parse(input.body);
  return command(pool,input,q=>scopedEvent(q,input.actor,id),async q=>{
    // Lock the event so simultaneous last-seat requests see the same RSVP count.
    const row=await scopedEvent(q,input.actor,id,true);
    requireCondition(await canAccessGuildEvent(q,input.actor,row),404,'not_found','找不到這場活動。');
    if(body.going){
      requireCondition(row.state==='published'&&Date.parse(row.starts_at)>Date.now(),409,'event_closed','活動已開始或取消，無法報名。');
      if(row.visibility==='guild'){
        const member=await q.query(`SELECT 1 FROM positioning_profession_memberships WHERE community_id=$1 AND guild_key=$2 AND user_id=$3 AND state='active' FOR SHARE`,[row.community_id,row.guild_key,input.actor.user_id]);
        requireCondition(member.rowCount===1,403,'event_guild_required','這場活動只開放主辦公會成員報名。');
      }
      const mine=(await q.query('SELECT state FROM community_event_rsvps WHERE event_id=$1 AND user_id=$2',[id,input.actor.user_id])).rows[0]?.state;
      if(mine!=='going'){
        const count=(await q.query("SELECT count(*)::int AS total FROM community_event_rsvps WHERE event_id=$1 AND state='going'",[id])).rows[0].total as number;
        requireCondition(row.capacity===null||count<row.capacity,409,'event_full','活動名額已滿。');
      }
    }
    const rsvp=(await q.query(`INSERT INTO community_event_rsvps(rsvp_id,event_id,user_id,state) VALUES($1,$2,$3,$4)
      ON CONFLICT(event_id,user_id) DO UPDATE SET state=EXCLUDED.state,aggregate_version=community_event_rsvps.aggregate_version+1,updated_at=now()
      RETURNING rsvp_id,aggregate_version`,[randomUUID(),id,input.actor.user_id,body.going?'going':'cancelled'])).rows[0];
    await journal(q,input.actor,'community_event_rsvp',rsvp.rsvp_id,rsvp.aggregate_version,body.going?'rsvp':'withdraw_rsvp',{event_id:id});
    return eventView(q,input.actor,row);
  });
}
