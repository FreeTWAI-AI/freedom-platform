import {Hono} from 'hono';
import type {Pool} from 'pg';
import {skillDiscovery} from '../../../../modules/community/discovery.js';
export function createSkillDiscoveryRoutes(pool:Pool){
  const app=new Hono();
  app.get('/skills/discovery',async c=>c.json(await skillDiscovery(pool)));
  return app;
}
