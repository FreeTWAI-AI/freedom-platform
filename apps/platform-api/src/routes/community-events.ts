import { Hono } from 'hono';
import { z } from 'zod';
import type { Pool } from 'pg';
import { moduleCommand, type PlatformEnv } from '../module-context.js';
import { cancelEvent, createEvent, listEvents, setRsvp, updateEvent } from '../../../../modules/community/events.js';

export function createCommunityEventRoutes(pool:Pool) {
  const app=new Hono<PlatformEnv>();
  const id=(raw:string)=>z.uuid().parse(raw);
  app.get('/events',async c=>c.json({items:await listEvents(pool,c.get('actor'))}));
  app.post('/events',async c=>c.json(await createEvent(pool,await moduleCommand(c)),201));
  app.post('/events/:id/update',async c=>c.json(await updateEvent(pool,await moduleCommand(c),id(c.req.param('id')))));
  app.post('/events/:id/cancel',async c=>c.json(await cancelEvent(pool,await moduleCommand(c),id(c.req.param('id')))));
  app.post('/events/:id/rsvp',async c=>c.json(await setRsvp(pool,await moduleCommand(c),id(c.req.param('id')))));
  return app;
}
