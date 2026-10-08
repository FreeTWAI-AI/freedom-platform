import {Hono} from 'hono';
import type {Pool} from 'pg';
import {moduleCommand,type PlatformEnv} from '../module-context.js';
import {createSquadOutcomeDraft,updateOwnSquadOutcome,publishOwnSquadOutcome,withdrawOwnSquadOutcome,readSquadOutcome,readPublishedSquadOutcome,listSquadOutcomes,listOwnSquadOutcomes} from '../../../../modules/identity-membership/squad-outcomes.js';

// The host mounts these only when its default-off outcome feature is enabled.
export function createSquadOutcomeRoutes(pool:Pool) {
 const app=new Hono<PlatformEnv>();
 app.use('*',async(c,next)=>{c.header('Cache-Control','private, no-store');await next();});
 app.get('/me/squad-outcomes',async c=>c.json(await listOwnSquadOutcomes(pool,c.get('actor'),c.req.query())));
 app.get('/squads/:squadId/outcomes',async c=>c.json(await listSquadOutcomes(pool,c.get('actor'),c.req.param('squadId'),c.req.query())));
 app.post('/squads/:squadId/outcomes',async c=>{
  const result=await createSquadOutcomeDraft(pool,await moduleCommand(c),c.req.param('squadId'));
  c.header('ETag',`"${result.aggregate_version}"`);return c.json(result,201);
 });
 app.get('/squad-outcomes/:id',async c=>{
  const result=await readSquadOutcome(pool,c.get('actor'),c.req.param('id'));
  c.header('ETag',`"${result.aggregate_version}"`);return c.json(result);
 });
 for(const action of ['edit','publish','withdraw'] as const)app.post(`/squad-outcomes/:id/${action}`,async c=>{
  const input=await moduleCommand(c),id=c.req.param('id');
  const result=await (action==='edit'?updateOwnSquadOutcome:action==='publish'?publishOwnSquadOutcome:withdrawOwnSquadOutcome)(pool,input,id);
  c.header('ETag',`"${result.aggregate_version}"`);return c.json(result);
 });
 return app;
}
export function createPublicSquadOutcomeRoutes(pool:Pool) {
 const app=new Hono();
 app.use('*',async(c,next)=>{c.header('Cache-Control','no-store');await next();});
 app.get('/squad-outcomes/:id',async c=>c.json(await readPublishedSquadOutcome(pool,c.req.param('id'),null)));
 return app;
}
