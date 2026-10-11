import {Hono} from 'hono';
import type {Pool} from 'pg';
import {moduleCommand,type PlatformEnv} from '../module-context.js';
import {createContributionRole,changeContributionRole,contributionRoles,memberContributionOutcomes} from '../../../../modules/opportunity-project-work/contribution-roles.js';

export function createContributionRoleRoutes(pool:Pool){
  const app=new Hono<PlatformEnv>();
  app.get('/me/contribution-outcomes',async c=>c.json(await memberContributionOutcomes(pool,c.get('actor'),c.get('actor').user_id,c.req.query())));
  app.get('/work-items/:id/contribution-roles',async c=>c.json(await contributionRoles(pool,c.get('actor'),c.req.param('id'),c.req.query())));
  app.post('/work-items/:id/contribution-roles',async c=>{
    const input=await moduleCommand(c);input.operation=input.operation.replace(c.req.param('id'),c.req.param('id').toLowerCase());
    return c.json(await createContributionRole(pool,input,c.req.param('id')),201);
  });
  for(const action of ['edit','withdraw','confirm'] as const)app.post(`/contribution-roles/:id/${action}`,async c=>{
    const input=await moduleCommand(c);
    // Same identity/receipt namespace for UUID case variants.
    input.operation=input.operation.replace(c.req.param('id'),c.req.param('id').toLowerCase());
    const result=await changeContributionRole(pool,input,c.req.param('id'),action);c.header('ETag',`"${result.aggregate_version}"`);return c.json(result);
  });
  app.get('/members/:id/contribution-outcomes',async c=>c.json(await memberContributionOutcomes(pool,c.get('actor'),c.req.param('id'),c.req.query())));
  return app;
}
