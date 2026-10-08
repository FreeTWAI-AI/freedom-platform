import {Hono} from 'hono';
import {z} from 'zod';
import type {Pool} from 'pg';
import {moduleCommand,type PlatformEnv} from '../module-context.js';
import {createEventOutcome,listEventOutcomeBacklinks,listEventOutcomeReferences,listEventOutcomes,listOwnEventOutcomes,publishEventOutcome,readOwnEventOutcome,readPublishedEventOutcome,updateEventOutcome,withdrawEventOutcome} from '../../../../modules/community/event-outcomes.js';

export function createEventOutcomeRoutes(pool:Pool){
 const app=new Hono<PlatformEnv>();
 app.use('*',async(c,next)=>{c.header('Cache-Control','no-store');await next();});
 app.get('/event-highlights/:eventId/outcomes',async c=>{const actor=c.get('actor');return c.json(await listEventOutcomes(pool,z.uuid().parse(c.req.param('eventId')),{communityId:actor.community_id,userId:actor.user_id}));});
 app.get('/event-highlights/:eventId/outcomes/own',async c=>c.json(await listOwnEventOutcomes(pool,c.get('actor'),z.uuid().parse(c.req.param('eventId')))));
 app.get('/event-highlights/:eventId/outcome-references',async c=>c.json(await listEventOutcomeReferences(pool,c.get('actor'),z.uuid().parse(c.req.param('eventId')))));
 app.post('/event-highlights/:eventId/outcomes',async c=>c.json(await createEventOutcome(pool,await moduleCommand(c),z.uuid().parse(c.req.param('eventId'))),201));
 app.get('/event-outcomes/:id',async c=>c.json(await readOwnEventOutcome(pool,c.get('actor'),z.uuid().parse(c.req.param('id')))));
 app.get('/event-outcomes/:id/published',async c=>{const actor=c.get('actor');return c.json(await readPublishedEventOutcome(pool,z.uuid().parse(c.req.param('id')),{communityId:actor.community_id,userId:actor.user_id}));});
 app.post('/event-outcomes/:id/update',async c=>c.json(await updateEventOutcome(pool,await moduleCommand(c),z.uuid().parse(c.req.param('id')))));
 app.post('/event-outcomes/:id/publish',async c=>c.json(await publishEventOutcome(pool,await moduleCommand(c),z.uuid().parse(c.req.param('id')))));
 app.post('/event-outcomes/:id/withdraw',async c=>c.json(await withdrawEventOutcome(pool,await moduleCommand(c),z.uuid().parse(c.req.param('id')))));
 app.get('/event-outcome-backlinks/:kind/:sourceId',async c=>{const actor=c.get('actor');return c.json(await listEventOutcomeBacklinks(pool,{kind:z.enum(['work','skill_book','squad_outcome']).parse(c.req.param('kind')),id:c.req.param('sourceId')},{communityId:actor.community_id,userId:actor.user_id}));});
 return app;
}
export function createPublicEventOutcomeRoutes(pool:Pool){
 const app=new Hono();
 app.use('*',async(c,next)=>{c.header('Cache-Control','no-store');await next();});
 app.get('/api/v1/public/event-highlights/:eventId/outcomes',async c=>c.json(await listEventOutcomes(pool,z.uuid().parse(c.req.param('eventId')),null)));
 app.get('/api/v1/public/event-outcomes/:id',async c=>c.json(await readPublishedEventOutcome(pool,z.uuid().parse(c.req.param('id')),null)));
 app.get('/api/v1/public/event-outcome-backlinks/:kind/:sourceId',async c=>c.json(await listEventOutcomeBacklinks(pool,{kind:z.enum(['work','skill_book','squad_outcome']).parse(c.req.param('kind')),id:c.req.param('sourceId')},null)));
 return app;
}
