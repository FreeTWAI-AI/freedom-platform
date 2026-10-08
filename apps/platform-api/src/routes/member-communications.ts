import { Hono,type Context } from 'hono';
import type { Pool } from 'pg';
import { moduleCommand,type PlatformEnv } from '../module-context.js';
import {
  listNotifications,markNotificationRead,markAllInboxRead,listConversations,conversationMessages,conversationActivity,sendDirectMessage,markConversationRead,searchConversationMessages,
} from '../../../../modules/member-communications/service.js';
import {authRateLimit} from '../../../../modules/identity-membership/members.js';
import {MESSAGE_IMAGE_INPUT_BYTES,MESSAGE_IMAGE_MIME_TYPES} from '../../../../modules/assets/message-image.js';
import {readMessageImage,uploadMessageImage} from '../../../../modules/member-communications/images.js';
import {requireCondition} from '../../../../packages/shared/problem.js';
import type {PlatformRuntime} from '../runtime.js';
import {listChannels,channelMessages,channelActivity,sendChannelMessage,markChannelRead,searchChannelMessages} from '../../../../modules/member-communications/channels.js';

type ImageRuntime=Pick<PlatformRuntime,'messageImageAssets'|'messageImageAssetStore'>;
/** Both the lifecycle service and the object store must be installed (#230). */
export const messageImagesInstalled=(runtime?:ImageRuntime)=>Boolean(runtime?.messageImageAssets&&runtime.messageImageAssetStore);
export function isMessageImageUpload(method:string,path:string){return method==='POST'&&/^\/api\/v1\/me\/conversations\/[0-9A-Fa-f-]{36}\/images$/.test(path);}
export function checkMessageImageHeaders(contentType?:string,contentLength?:string){
  requireCondition(MESSAGE_IMAGE_MIME_TYPES.has(contentType??''),415,'message_image_format','請選擇 JPEG、PNG 或 WebP 圖片。');
  if(contentLength!==undefined)requireCondition(/^\d+$/.test(contentLength)&&Number(contentLength)<=MESSAGE_IMAGE_INPUT_BYTES,413,'message_image_too_large','圖片需為 2 MB 以下的檔案。');
}
/** The request stream is capped while it is read; Content-Length is only an early hint. */
async function boundedImageUpload(request:Request){
  const reader=request.body?.getReader();
  requireCondition(reader,422,'invalid_message_image','請先選擇圖片。');
  const chunks:Uint8Array[]=[];let size=0;
  try{
    for(;;){
      const {value,done}=await reader!.read();if(done)break;
      size+=value.byteLength;
      requireCondition(size<=MESSAGE_IMAGE_INPUT_BYTES,413,'message_image_too_large','圖片需為 2 MB 以下的檔案。');
      chunks.push(value);
    }
  }catch(error){await reader!.cancel().catch(()=>{});throw error;}finally{reader!.releaseLock();}
  requireCondition(size>0,422,'invalid_message_image','請先選擇圖片。');
  return Buffer.concat(chunks,size);
}

// Mounted after the shared session, Origin, CSRF and onboarding middleware.
// Writes use Idempotency-Key; If-Match is not required for these commands.
// Receipts key on the decoded, canonical target, not the raw path, so case or
// percent-encoded UUID aliases replay instead of inserting again. Guild keys
// keep their exact case; the service still validates every id.
async function canonicalCommand(c:Context<PlatformEnv>,path:string){
  return {...await moduleCommand(c),operation:`${c.req.method} /api/v1${path}`};
}
const uuidParam=(c:Context<PlatformEnv>,name:string)=>(c.req.param(name)??'').toLowerCase();
function channelCommand(c:Context<PlatformEnv>,action:'messages'|'read'){
  const kind=c.req.param('kind')??'',key=c.req.param('key')??'';
  return canonicalCommand(c,`/me/channels/${kind}/${kind==='squad'?key.toLowerCase():key}/${action}`);
}
export function createMemberCommunicationRoutes(pool:Pool,runtime?:ImageRuntime) {
  const app=new Hono<PlatformEnv>();
  const installed=()=>requireCondition(messagesImagesOn(),404,'not_found','找不到這個頁面。');
  const messagesImagesOn=()=>messageImagesInstalled(runtime);
  app.post('/me/inbox/read-all',async c=>c.json(await markAllInboxRead(pool,await canonicalCommand(c,'/me/inbox/read-all'))));
  app.get('/me/notifications',async c=>c.json(await listNotifications(pool,c.get('actor'),c.req.query())));
  app.post('/me/notifications/:id/read',async c=>c.json(await markNotificationRead(pool,await canonicalCommand(c,`/me/notifications/${uuidParam(c,'id')}/read`),c.req.param('id'))));
  app.get('/me/conversations',async c=>c.json(await listConversations(pool,c.get('actor'),c.req.query())));
  app.get('/me/conversations/:userId/activity',async c=>c.json(await conversationActivity(pool,c.get('actor'),c.req.param('userId'),c.req.query())));
  app.get('/me/conversations/:userId/messages',async c=>c.json(await conversationMessages(pool,c.get('actor'),c.req.param('userId'),c.req.query())));
  app.get('/me/conversations/:userId/messages/search',async c=>c.json(await searchConversationMessages(pool,c.get('actor'),c.req.param('userId'),c.req.query())));
  app.post('/me/conversations/:userId/messages',async c=>c.json(await sendDirectMessage(pool,await canonicalCommand(c,`/me/conversations/${uuidParam(c,'userId')}/messages`),c.req.param('userId'),{messageImages:messagesImagesOn()}),201));
  // Direct-message images: bytes in, bytes out. No public URL, no signed URL.
  app.post('/me/conversations/:userId/images',async c=>{
    installed();
    checkMessageImageHeaders(c.req.header('Content-Type'),c.req.header('Content-Length'));
    const key=c.req.header('Idempotency-Key')??'';
    requireCondition(/^[A-Za-z0-9_-]{8,128}$/.test(key),400,'idempotency_required','請提供有效的 Idempotency-Key。');
    const actor=c.get('actor');
    await authRateLimit(pool,'message-image-upload-member',actor.user_id,12,60);
    await authRateLimit(pool,'message-image-upload-global','global',120,60);
    const bytes=await boundedImageUpload(c.req.raw);
    return c.json(await uploadMessageImage(pool,{actor,operation:`${c.req.method} ${c.req.path}`,key,body:null},c.req.param('userId'),{bytes,mime:c.req.header('Content-Type')!},runtime?.messageImageAssets),201);
  });
  app.get('/me/conversations/:userId/messages/:messageId/image',async c=>{
    installed();
    const bytes=await readMessageImage(pool,c.get('actor'),c.req.param('userId'),c.req.param('messageId'),runtime?.messageImageAssetStore);
    c.header('Content-Type','image/webp');
    c.header('Cache-Control','private, no-store');
    c.header('Vary','Cookie');
    c.header('Cross-Origin-Resource-Policy','same-origin');
    c.header('X-Content-Type-Options','nosniff');
    c.header('Content-Length',String(bytes.length));
    return c.body(new Uint8Array(bytes));
  });
  app.post('/me/conversations/:userId/read',async c=>c.json(await markConversationRead(pool,await canonicalCommand(c,`/me/conversations/${uuidParam(c,'userId')}/read`),c.req.param('userId'))));
  app.get('/me/channels',async c=>c.json(await listChannels(pool,c.get('actor'),c.req.query())));
  app.get('/me/channels/:kind/:key/activity',async c=>c.json(await channelActivity(pool,c.get('actor'),c.req.param('kind'),c.req.param('key'),c.req.query())));
  app.get('/me/channels/:kind/:key/messages',async c=>c.json(await channelMessages(pool,c.get('actor'),c.req.param('kind'),c.req.param('key'),c.req.query())));
  app.get('/me/channels/:kind/:key/messages/search',async c=>c.json(await searchChannelMessages(pool,c.get('actor'),c.req.param('kind'),c.req.param('key'),c.req.query())));
  app.post('/me/channels/:kind/:key/messages',async c=>c.json(await sendChannelMessage(pool,await channelCommand(c,'messages'),c.req.param('kind'),c.req.param('key')),201));
  app.post('/me/channels/:kind/:key/read',async c=>c.json(await markChannelRead(pool,await channelCommand(c,'read'),c.req.param('kind'),c.req.param('key'))));
  return app;
}
