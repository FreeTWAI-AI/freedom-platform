import { Hono,type Context } from 'hono';
import type { Pool } from 'pg';
import { moduleCommand,type PlatformEnv } from '../module-context.js';
import {
  listNotifications,markNotificationRead,listConversations,conversationMessages,sendDirectMessage,markConversationRead,
} from '../../../../modules/member-communications/service.js';
import {listChannels,channelMessages,sendChannelMessage,markChannelRead} from '../../../../modules/member-communications/channels.js';

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
export function createMemberCommunicationRoutes(pool:Pool) {
  const app=new Hono<PlatformEnv>();
  app.get('/me/notifications',async c=>c.json(await listNotifications(pool,c.get('actor'),c.req.query())));
  app.post('/me/notifications/:id/read',async c=>c.json(await markNotificationRead(pool,await canonicalCommand(c,`/me/notifications/${uuidParam(c,'id')}/read`),c.req.param('id'))));
  app.get('/me/conversations',async c=>c.json(await listConversations(pool,c.get('actor'),c.req.query())));
  app.get('/me/conversations/:userId/messages',async c=>c.json(await conversationMessages(pool,c.get('actor'),c.req.param('userId'),c.req.query())));
  app.post('/me/conversations/:userId/messages',async c=>c.json(await sendDirectMessage(pool,await canonicalCommand(c,`/me/conversations/${uuidParam(c,'userId')}/messages`),c.req.param('userId')),201));
  app.post('/me/conversations/:userId/read',async c=>c.json(await markConversationRead(pool,await canonicalCommand(c,`/me/conversations/${uuidParam(c,'userId')}/read`),c.req.param('userId'))));
  app.get('/me/channels',async c=>c.json(await listChannels(pool,c.get('actor'),c.req.query())));
  app.get('/me/channels/:kind/:key/messages',async c=>c.json(await channelMessages(pool,c.get('actor'),c.req.param('kind'),c.req.param('key'),c.req.query())));
  app.post('/me/channels/:kind/:key/messages',async c=>c.json(await sendChannelMessage(pool,await channelCommand(c,'messages'),c.req.param('kind'),c.req.param('key')),201));
  app.post('/me/channels/:kind/:key/read',async c=>c.json(await markChannelRead(pool,await channelCommand(c,'read'),c.req.param('kind'),c.req.param('key'))));
  return app;
}
