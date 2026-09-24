import { Hono } from 'hono';
import type { Pool } from 'pg';
import { moduleCommand,type PlatformEnv } from '../module-context.js';
import {
  listNotifications,markNotificationRead,listConversations,conversationMessages,sendDirectMessage,markConversationRead,
} from '../../../../modules/member-communications/service.js';

// Mounted after the shared session, Origin, CSRF and onboarding middleware.
// Writes use Idempotency-Key; If-Match is not required for these commands.
export function createMemberCommunicationRoutes(pool:Pool) {
  const app=new Hono<PlatformEnv>();
  app.get('/me/notifications',async c=>c.json(await listNotifications(pool,c.get('actor'),c.req.query())));
  app.post('/me/notifications/:id/read',async c=>c.json(await markNotificationRead(pool,await moduleCommand(c),c.req.param('id'))));
  app.get('/me/conversations',async c=>c.json(await listConversations(pool,c.get('actor'),c.req.query())));
  app.get('/me/conversations/:userId/messages',async c=>c.json(await conversationMessages(pool,c.get('actor'),c.req.param('userId'),c.req.query())));
  app.post('/me/conversations/:userId/messages',async c=>c.json(await sendDirectMessage(pool,await moduleCommand(c),c.req.param('userId')),201));
  app.post('/me/conversations/:userId/read',async c=>c.json(await markConversationRead(pool,await moduleCommand(c),c.req.param('userId'))));
  return app;
}
