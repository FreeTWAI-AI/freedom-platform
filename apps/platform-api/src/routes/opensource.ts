import { Hono } from 'hono';
import { z } from 'zod';
import type { Pool } from 'pg';
import { moduleCommand,type PlatformEnv } from '../module-context.js';
import { listProjects,importProject,refreshProject,reviseProject,listCampaigns,createCampaign,reviseCampaign,recordShare } from '../../../../modules/opensource-marketing/service.js';

export function createOpenSourceRoutes(pool:Pool) {
  const app=new Hono<PlatformEnv>();
  app.get('/opensource/projects',async c=>c.json({items:await listProjects(pool,c.get('actor'))}));
  app.post('/opensource/projects',async c=>c.json(await importProject(pool,await moduleCommand(c)),201));
  app.post('/opensource/projects/:id{[0-9a-f-]+:refresh}',async c=>{
    const result=await refreshProject(pool,await moduleCommand(c),z.uuid().parse(c.req.param('id').split(':')[0]));
    c.header('ETag',`"${result.aggregate_version}"`);return c.json(result);
  });
  app.post('/opensource/projects/:id{[0-9a-f-]+:revise}',async c=>{
    const result=await reviseProject(pool,await moduleCommand(c),z.uuid().parse(c.req.param('id').split(':')[0]));
    c.header('ETag',`"${result.aggregate_version}"`);return c.json(result);
  });
  app.get('/marketing/campaigns',async c=>c.json({items:await listCampaigns(pool,c.get('actor'))}));
  app.post('/marketing/campaigns',async c=>c.json(await createCampaign(pool,await moduleCommand(c)),201));
  app.post('/marketing/campaigns/:id{[0-9a-f-]+:revise}',async c=>{
    const result=await reviseCampaign(pool,await moduleCommand(c),z.uuid().parse(c.req.param('id').split(':')[0]));
    c.header('ETag',`"${result.aggregate_version}"`);return c.json(result);
  });
  app.post('/marketing/campaigns/:id/shares',async c=>{
    const result=await recordShare(pool,await moduleCommand(c),z.uuid().parse(c.req.param('id')));
    c.header('ETag',`"${result.aggregate_version}"`);return c.json(result,201);
  });
  return app;
}
