import {Hono} from 'hono';
import type {Pool} from 'pg';
import {moduleCommand,type PlatformEnv} from '../module-context.js';
import {benefitView,recordBenefit} from '../../../../modules/results/benefits.js';
export function createBenefitRoutes(pool:Pool){
  const app=new Hono<PlatformEnv>();
  app.get('/work-items/:id/benefit-observations',async c=>{
    const value=await benefitView(pool,c.get('actor'),c.req.param('id'));c.header('ETag',`"${value.aggregate_version}"`);return c.json(value);
  });
  app.post('/work-items/:id/benefit-observations',async c=>c.json(await recordBenefit(pool,await moduleCommand(c),c.req.param('id')),201));
  return app;
}
