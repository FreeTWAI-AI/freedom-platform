import {Hono} from 'hono';
import {z} from 'zod';
import type {Pool} from 'pg';
import {moduleCommand,type PlatformEnv} from '../module-context.js';
import {createCoCreation,getCoCreation,listCoCreation,listCoCreationGuilds} from '../../../../modules/co-creation/service.js';
import {CollaborationGitHub,projectBrief} from '../../../../modules/co-creation/github.js';
export function createCoCreationRoutes(pool:Pool){
  const app=new Hono<PlatformEnv>(),github=new CollaborationGitHub();
  app.get('/co-creation/projects',async c=>{
    const [items,guilds]=await Promise.all([listCoCreation(pool,c.get('actor')),listCoCreationGuilds(pool)]);
    return c.json({items,guilds});
  });
  app.post('/co-creation/projects',async c=>c.json(await createCoCreation(pool,await moduleCommand(c)),201));
  app.get('/co-creation/projects/:id/activity',async c=>c.json(await github.read(await getCoCreation(pool,c.get('actor'),c.req.param('id')))));
  app.get('/co-creation/projects/:id/brief',async c=>c.json(projectBrief(await getCoCreation(pool,c.get('actor'),c.req.param('id')))));
  app.get('/co-creation/projects/:id/issues/:number/brief',async c=>{
    const number=z.coerce.number().int().positive().max(1000000000).parse(c.req.param('number'));
    return c.json(await github.brief(await getCoCreation(pool,c.get('actor'),c.req.param('id')),number));
  });return app;
}
