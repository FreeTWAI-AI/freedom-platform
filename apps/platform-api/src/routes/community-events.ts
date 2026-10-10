import type {PlatformRuntime} from '../runtime.js';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Pool } from 'pg';
import { requireCondition } from '../../../../packages/shared/problem.js';
import { sha256 } from '../../../../packages/asset-storage/index.js';
import { planObjectHttpRequest } from '../../../../packages/asset-storage/http-range.js';
import { authRateLimit } from '../../../../modules/identity-membership/members.js';
import type { EventEmailSender } from '../../../../modules/community/events.js';
import { moduleCommand, type PlatformEnv } from '../module-context.js';
import { eventVideoHttp, cancelEvent, createEvent, eventReferralReport,eventAttendees, getEventShareCode, listEventBulletins, listEvents, readEvent, readEventBanner, readEventVideo, reviewEventAsGuildMaster, saveEventBanner, saveEventVideo, setRsvp, updateEvent } from '../../../../modules/community/events.js';
import {readMemberEventCalendar} from '../../../../modules/community/event-calendar.js';
import {readEventReminder,saveEventReminder} from '../../../../modules/community/event-reminders.js';
import {mutateEventWaitlist,processEventWaitlist,readEventParticipation,setEventWaitlistPolicy,updateEventSchedule} from '../../../../modules/community/event-waitlist.js';

const BANNER_MAX_BYTES=512*1024;
const VIDEO_MAX_BYTES=20*1024*1024;
const BANNER_MIME_TYPES=new Set(['image/jpeg','image/png','image/webp']);
export function isEventBannerUpload(method:string,path:string){return method==='POST'&&/^\/api\/v1\/events\/[0-9a-f-]{36}\/banner$/.test(path);}
export function isEventVideoUpload(method:string,path:string){return method==='POST'&&/^\/api\/v1\/events\/[0-9a-f-]{36}\/video$/.test(path);}
export function checkEventBannerUploadHeaders(contentType?:string,contentLength?:string){
  requireCondition(BANNER_MIME_TYPES.has(contentType??''),415,'banner_format','請選擇 JPEG、PNG 或 WebP 圖片。');
  if(contentLength!==undefined)requireCondition(/^\d+$/.test(contentLength)&&Number(contentLength)<=BANNER_MAX_BYTES,413,'banner_too_large','Banner 需為 512 KiB 以下。');
}
export function checkEventVideoUploadHeaders(contentType?:string,contentLength?:string){
  requireCondition(contentType==='video/mp4'||contentType==='video/webm',415,'video_format','請選擇 MP4 或 WebM 影片。');
  if(contentLength!==undefined)requireCondition(/^\d+$/.test(contentLength)&&Number(contentLength)<=VIDEO_MAX_BYTES,413,'video_too_large','影片需為 20 MiB 以下。');
}
export async function boundedMedia(request:Request,max:number,message:string){
  const reader=request.body?.getReader();requireCondition(reader,422,'invalid_banner','請先選擇 Banner 圖片。');
  const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;requireCondition(size<=max,413,'media_too_large',message);chunks.push(value);}}
  catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  requireCondition(size>0,422,'invalid_media','請先選擇檔案。');return Buffer.concat(chunks,size);
}

/** Called only after the original member/public domain read authorizes media.
 * This legacy bytea response uses the same range planner as future Asset reads;
 * a range is transport evidence, never whole-object integrity verification. */
export async function eventVideoResponse(c:Context,media:{bytes:Buffer;mime:string},publicCache=false){
  const plan=planObjectHttpRequest({method:c.req.method==='HEAD'?'HEAD':'GET',byteSize:media.bytes.length,
    contentType:media.mime,etag:await sha256(media.bytes),rangeHeader:c.req.header('Range'),ifRangeHeader:c.req.header('If-Range')});
  for(const [name,value] of Object.entries(plan.headers))c.header(name,value);
  c.header('Cache-Control',publicCache?'public, max-age=300':'private, no-store');c.header('Cross-Origin-Resource-Policy','same-origin');
  if(!plan.sendBody)return c.body(null,plan.status);
  const range=plan.range??{offset:0,length:media.bytes.length};
  return c.body(new Uint8Array(media.bytes.subarray(range.offset,range.offset+range.length)),plan.status);
}

/** Asset range transport is lazy; the domain has rechecked its original ACL. */
export async function eventAssetVideoResponse(c:Context,pool:Pool,id:string,store:PlatformRuntime['eventVideoAssetStore'],actor?:PlatformEnv['Variables']['actor']){
 const media=await eventVideoHttp(pool,id,{method:c.req.method==='HEAD'?'HEAD':'GET',rangeHeader:c.req.header('Range'),ifRangeHeader:c.req.header('If-Range')},store,actor);
 for(const [name,value] of Object.entries(media.plan.headers))c.header(name,value);
 c.header('Cache-Control',actor?'private, no-store':'public, max-age=300');c.header('Cross-Origin-Resource-Policy','same-origin');if(actor)c.header('Vary','Cookie');
 if(media.body===null)return c.body(null,media.plan.status);
 if(media.body instanceof Uint8Array)return c.body(new Uint8Array(media.body),media.plan.status);
 return c.body(media.body,media.plan.status);
}

export function createCommunityEventRoutes(pool:Pool,emailSender?:EventEmailSender,origin='',runtime?:Pick<PlatformRuntime,'eventBannerAssets'|'eventBannerAssetStore'|'eventVideoAssets'|'eventVideoAssetStore'|'eventParticipationEnabled'>) {
  const app=new Hono<PlatformEnv>();
  const id=(raw:string)=>z.uuid().parse(raw);
  const dispatch=async(eventId:string)=>{if(runtime?.eventParticipationEnabled===true)await processEventWaitlist(pool,async(to,subject,body)=>{requireCondition(emailSender,503,'event_email_unavailable','活動郵件服務暫時無法使用。');await emailSender(to,subject,body);},origin,undefined,eventId);};
  if(runtime?.eventParticipationEnabled===true){
    app.get('/events/:id/participation',async c=>c.json(await readEventParticipation(pool,c.get('actor'),id(c.req.param('id')))));
    app.get('/events/:id/calendar',async c=>c.json(await readMemberEventCalendar(pool,c.get('actor'),id(c.req.param('id')))));
    app.get('/events/:id/reminder',async c=>c.json(await readEventReminder(pool,c.get('actor'),id(c.req.param('id')))));
    app.patch('/events/:id/reminder',async c=>c.json(await saveEventReminder(pool,await moduleCommand(c),id(c.req.param('id')))));
    app.post('/events/:id/waitlist',async c=>{const eventId=id(c.req.param('id'));const result=await mutateEventWaitlist(pool,await moduleCommand(c),eventId);await dispatch(eventId);return c.json(result);});
    app.patch('/events/:id/waitlist-policy',async c=>{const eventId=id(c.req.param('id'));const result=await setEventWaitlistPolicy(pool,await moduleCommand(c),eventId);await dispatch(eventId);return c.json(result);});
    app.patch('/events/:id/schedule',async c=>{const eventId=id(c.req.param('id'));const result=await updateEventSchedule(pool,await moduleCommand(c),eventId);await dispatch(eventId);return c.json(result);});
  }
  app.get('/events',async c=>c.json({items:await listEvents(pool,c.get('actor'))}));
  app.get('/events/bulletins',async c=>c.json({items:await listEventBulletins(pool,c.get('actor'))}));
  app.get('/events/:id',async c=>c.json(await readEvent(pool,c.get('actor'),id(c.req.param('id')),runtime?.eventParticipationEnabled===true)));
  app.get('/events/:id/referrals',async c=>c.json({items:await eventReferralReport(pool,c.get('actor'),id(c.req.param('id')))}));
  app.get('/events/:id/attendees',async c=>{c.header('Cache-Control','private, no-store');return c.json(await eventAttendees(pool,c.get('actor'),id(c.req.param('id')),c.req.query()));});
  app.post('/events/:id/share-code',async c=>c.json(await getEventShareCode(pool,c.get('actor'),id(c.req.param('id')))));
  app.get('/events/:id/banner',async c=>{
    const bytes=await readEventBanner(pool,c.get('actor'),id(c.req.param('id')),runtime?.eventBannerAssetStore);
    c.header('Content-Type','image/webp');c.header('Cache-Control','private, no-store');c.header('Vary','Cookie');c.header('Cross-Origin-Resource-Policy','same-origin');
    return c.body(new Uint8Array(bytes));
  });
  app.post('/events',async c=>c.json(await createEvent(pool,await moduleCommand(c)),201));
  app.post('/events/:id/banner',async c=>{
    checkEventBannerUploadHeaders(c.req.header('Content-Type'),c.req.header('Content-Length'));
    const version=c.req.header('If-Match');requireCondition(version&&/^"[1-9][0-9]*"$/.test(version),version?400:428,'version_required','請重新整理活動後再保存 Banner。');
    const key=c.req.header('Idempotency-Key')??'';requireCondition(/^[A-Za-z0-9_-]{8,128}$/.test(key),400,'idempotency_required','請提供有效的 Idempotency-Key。');
    await authRateLimit(pool,'event-banner-member',c.get('actor').user_id,12,60);
    const bytes=await boundedMedia(c.req.raw,BANNER_MAX_BYTES,'Banner 需為 512 KiB 以下。');
    const orientation=c.req.header('X-Poster-Orientation')??'landscape';requireCondition(orientation==='portrait'||orientation==='landscape',422,'invalid_orientation','海報方向不正確。');
    const result=await saveEventBanner(pool,{actor:c.get('actor'),operation:`${c.req.method} ${c.req.path}`,key,expected:version.slice(1,-1),body:null},id(c.req.param('id')),{bytes,mime:c.req.header('Content-Type')!,orientation},runtime?.eventBannerAssets);
    c.header('ETag',`"${result.aggregate_version}"`);return c.json(result);
  });
  app.post('/events/:id/banner/remove',async c=>c.json(await saveEventBanner(pool,await moduleCommand(c),id(c.req.param('id')),null)));
  app.get('/events/:id/video',async c=>eventAssetVideoResponse(c,pool,id(c.req.param('id')),runtime?.eventVideoAssetStore,c.get('actor')));
  app.post('/events/:id/video',async c=>{
    checkEventVideoUploadHeaders(c.req.header('Content-Type'),c.req.header('Content-Length'));
    const version=c.req.header('If-Match');requireCondition(version&&/^"[1-9][0-9]*"$/.test(version),version?400:428,'version_required','請重新整理活動後再保存影片。');
    const key=c.req.header('Idempotency-Key')??'';requireCondition(/^[A-Za-z0-9_-]{8,128}$/.test(key),400,'idempotency_required','請提供有效的 Idempotency-Key。');
    await authRateLimit(pool,'event-video-member',c.get('actor').user_id,8,3600);
    const bytes=await boundedMedia(c.req.raw,VIDEO_MAX_BYTES,'影片需為 20 MiB 以下。');
    const result=await saveEventVideo(pool,{actor:c.get('actor'),operation:`${c.req.method} ${c.req.path}`,key,expected:version.slice(1,-1),body:null},id(c.req.param('id')),{bytes,mime:c.req.header('Content-Type') as 'video/mp4'|'video/webm'},runtime?.eventVideoAssets);
    c.header('ETag',`"${result.aggregate_version}"`);return c.json(result);
  });
  app.post('/events/:id/video/remove',async c=>c.json(await saveEventVideo(pool,await moduleCommand(c),id(c.req.param('id')),null)));
  app.post('/events/:id/update',async c=>c.json(await updateEvent(pool,await moduleCommand(c),id(c.req.param('id')))));
  app.post('/events/:id/cancel',async c=>{const eventId=id(c.req.param('id'));const result=await cancelEvent(pool,await moduleCommand(c),eventId,runtime?.eventParticipationEnabled===true);await dispatch(eventId);return c.json(result);});
  app.post('/events/:id/review',async c=>c.json(await reviewEventAsGuildMaster(pool,await moduleCommand(c),id(c.req.param('id')))));
  app.post('/events/:id/rsvp',async c=>{
    const input=await moduleCommand(c),eventId=id(c.req.param('id'));
    const target=(input.body as {going?:boolean})?.going
      ?(await pool.query("SELECT visibility FROM community_events WHERE event_id=$1 AND community_id=$2 AND state='published'",[eventId,c.get('actor').community_id])).rows[0]:null;
    if(target?.visibility==='referral'){
      requireCondition(emailSender,503,'event_email_unavailable','活動郵件服務暫時無法使用。');
      await authRateLimit(pool,'event-rsvp-email',c.get('actor').user_id,6,3600);
    }
    const result=await setRsvp(pool,input,eventId,runtime?.eventParticipationEnabled===true);
    await dispatch(eventId);
    if((input.body as {going?:boolean})?.going&&result.visibility==='referral'&&emailSender){
      try{await emailSender(c.get('actor').email,'自由工坊：活動參與資料',
        `你已報名「${result.title}」。\n\n活動頁：${origin}/events/${eventId}\n\n地點：${result.location}${result.online_url?`\n線上參與連結：${result.online_url}`:''}`);}
      catch{requireCondition(false,503,'event_email_delivery_failed','報名已確認，但 Email 提供者尚未確認接受郵件；這不代表未報名。請在活動專頁查看目前狀態。');}
    }
    return c.json(result);
  });
  return app;
}
