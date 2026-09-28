import { Hono } from 'hono';
import { z } from 'zod';
import type { Pool } from 'pg';
import { requireCondition } from '../../../../packages/shared/problem.js';
import { authRateLimit } from '../../../../modules/identity-membership/members.js';
import { moduleCommand, type PlatformEnv } from '../module-context.js';
import { cancelEvent, createEvent, listEventBulletins, listEvents, readEventBanner, reviewEventAsGuildMaster, saveEventBanner, setRsvp, updateEvent } from '../../../../modules/community/events.js';

const BANNER_MAX_BYTES=512*1024;
const BANNER_MIME_TYPES=new Set(['image/jpeg','image/png','image/webp']);
export function isEventBannerUpload(method:string,path:string){return method==='POST'&&/^\/api\/v1\/events\/[0-9a-f-]{36}\/banner$/.test(path);}
export function checkEventBannerUploadHeaders(contentType?:string,contentLength?:string){
  requireCondition(BANNER_MIME_TYPES.has(contentType??''),415,'banner_format','請選擇 JPEG、PNG 或 WebP 圖片。');
  if(contentLength!==undefined)requireCondition(/^\d+$/.test(contentLength)&&Number(contentLength)<=BANNER_MAX_BYTES,413,'banner_too_large','Banner 需為 512 KiB 以下。');
}
async function boundedBanner(request:Request){
  const reader=request.body?.getReader();requireCondition(reader,422,'invalid_banner','請先選擇 Banner 圖片。');
  const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;requireCondition(size<=BANNER_MAX_BYTES,413,'banner_too_large','Banner 需為 512 KiB 以下。');chunks.push(value);}}
  catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  requireCondition(size>0,422,'invalid_banner','請先選擇 Banner 圖片。');return Buffer.concat(chunks,size);
}

export function createCommunityEventRoutes(pool:Pool) {
  const app=new Hono<PlatformEnv>();
  const id=(raw:string)=>z.uuid().parse(raw);
  app.get('/events',async c=>c.json({items:await listEvents(pool,c.get('actor'))}));
  app.get('/events/bulletins',async c=>c.json({items:await listEventBulletins(pool,c.get('actor'))}));
  app.get('/events/:id/banner',async c=>{
    const bytes=await readEventBanner(pool,c.get('actor'),id(c.req.param('id')));
    c.header('Content-Type','image/webp');c.header('Cache-Control','private, no-store');c.header('Vary','Cookie');c.header('Cross-Origin-Resource-Policy','same-origin');
    return c.body(new Uint8Array(bytes));
  });
  app.post('/events',async c=>c.json(await createEvent(pool,await moduleCommand(c)),201));
  app.post('/events/:id/banner',async c=>{
    checkEventBannerUploadHeaders(c.req.header('Content-Type'),c.req.header('Content-Length'));
    const version=c.req.header('If-Match');requireCondition(version&&/^"[1-9][0-9]*"$/.test(version),version?400:428,'version_required','請重新整理活動後再保存 Banner。');
    const key=c.req.header('Idempotency-Key')??'';requireCondition(/^[A-Za-z0-9_-]{8,128}$/.test(key),400,'idempotency_required','請提供有效的 Idempotency-Key。');
    await authRateLimit(pool,'event-banner-member',c.get('actor').user_id,12,60);
    const bytes=await boundedBanner(c.req.raw);
    const result=await saveEventBanner(pool,{actor:c.get('actor'),operation:`${c.req.method} ${c.req.path}`,key,expected:version.slice(1,-1),body:null},id(c.req.param('id')),{bytes,mime:c.req.header('Content-Type')!});
    c.header('ETag',`"${result.aggregate_version}"`);return c.json(result);
  });
  app.post('/events/:id/banner/remove',async c=>c.json(await saveEventBanner(pool,await moduleCommand(c),id(c.req.param('id')),null)));
  app.post('/events/:id/update',async c=>c.json(await updateEvent(pool,await moduleCommand(c),id(c.req.param('id')))));
  app.post('/events/:id/cancel',async c=>c.json(await cancelEvent(pool,await moduleCommand(c),id(c.req.param('id')))));
  app.post('/events/:id/review',async c=>c.json(await reviewEventAsGuildMaster(pool,await moduleCommand(c),id(c.req.param('id')))));
  app.post('/events/:id/rsvp',async c=>c.json(await setRsvp(pool,await moduleCommand(c),id(c.req.param('id')))));
  return app;
}
