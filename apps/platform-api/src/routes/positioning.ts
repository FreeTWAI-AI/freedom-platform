import { Hono } from 'hono';
import type { Pool } from 'pg';
import { moduleCommand, type PlatformEnv } from '../module-context.js';
import { positioningView,saveProfile,listTracks,listGuilds,changeGuildMembership } from '../../../../modules/positioning/service.js';

export function createPositioningRoutes(pool:Pool) {
  const app=new Hono<PlatformEnv>();
  app.get('/me/positioning',async c=>c.json(await positioningView(pool,c.get('actor'))));
  app.post('/me/positioning',async c=>{
    const profile=await saveProfile(pool,await moduleCommand(c));
    c.header('ETag',`"${profile.aggregate_version}"`);return c.json(profile,201);
  });
  app.get('/career-tracks',async c=>c.json({items:await listTracks(pool)}));
  app.get('/guilds',async c=>c.json({items:await listGuilds(pool,c.get('actor'))}));
  for(const action of ['join','leave'] as const)app.post(`/guilds/:key/${action}`,async c=>{
    const membership=await changeGuildMembership(pool,await moduleCommand(c),c.req.param('key'),action);
    c.header('ETag',`"${membership.aggregate_version}"`);return c.json(membership);
  });
  return app;
}
