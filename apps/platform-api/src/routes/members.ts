import { Hono } from 'hono';
import type { Pool } from 'pg';
import type { Command } from '../../../../packages/db/index.js';
import { z } from 'zod';
import { moduleCommand,type PlatformEnv } from '../module-context.js';
import { accountView,saveAccount,listMembers,MemberDirectoryQuery,memberCard,listFriends,changeFriendship,listSquads,squadView,createSquad,changeSquadMembership } from '../../../../modules/identity-membership/members.js';
import {inviteToSquad,resolveSquadInvitation,squadInvitations,receivedSquadInvitations} from '../../../../modules/identity-membership/squad-invitations.js';
import {ownSocialLinks,visibleSocialLinks,createSocialLink,editSocialLink,deleteSocialLink} from '../../../../modules/identity-membership/social-links.js';
// One receipt per invitation/squad regardless of the id's letter case.
const lowercaseIds=(input:Command)=>({...input,operation:input.operation.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,id=>id.toLowerCase())});
const pagination=z.object({limit:z.coerce.number().int().min(1).max(50).default(20),offset:z.coerce.number().int().min(0).max(10000).default(0)});
export function createMemberRoutes(pool:Pool) {
  const app=new Hono<PlatformEnv>();
  app.get('/me/account',async c=>c.json(await accountView(pool,c.get('actor'))));
  app.post('/me/account',async c=>{const result=await saveAccount(pool,await moduleCommand(c));c.header('ETag',`"${result.aggregate_version}"`);return c.json(result);});
  app.get('/me/social-links',async c=>c.json(await ownSocialLinks(pool,c.get('actor'),c.req.query())));
  app.post('/me/social-links',async c=>{const result=await createSocialLink(pool,await moduleCommand(c));c.header('ETag',`"${result.aggregate_version}"`);return c.json(result,201);});
  app.post('/me/social-links/:id/edit',async c=>{const result=await editSocialLink(pool,await moduleCommand(c),c.req.param('id'));c.header('ETag',`"${result.aggregate_version}"`);return c.json(result);});
  app.post('/me/social-links/:id/delete',async c=>{const result=await deleteSocialLink(pool,await moduleCommand(c),c.req.param('id'));c.header('ETag',`"${result.aggregate_version}"`);return c.json(result);});
  app.get('/members/:id/social-links',async c=>c.json(await visibleSocialLinks(pool,c.get('actor'),c.req.param('id'),c.req.query())));
  app.get('/members',async c=>{const {limit,offset,...filters}=MemberDirectoryQuery.parse(c.req.query());return c.json(await listMembers(pool,c.get('actor'),limit,offset,filters));});
  app.get('/members/:id',async c=>c.json(await memberCard(pool,c.get('actor'),c.req.param('id'))));
  app.get('/friends',async c=>c.json({items:await listFriends(pool,c.get('actor'))}));
  for(const action of ['request','accept','remove'] as const)app.post(`/friends/:id/${action}`,async c=>c.json(await changeFriendship(pool,await moduleCommand(c),c.req.param('id'),action)));
  app.get('/squads',async c=>{const {limit,offset}=pagination.parse(c.req.query());return c.json(await listSquads(pool,c.get('actor'),limit,offset));});
  app.get('/squads/:id',async c=>c.json(await squadView(pool,c.get('actor'),c.req.param('id'))));
  app.post('/squads',async c=>c.json(await createSquad(pool,await moduleCommand(c)),201));
  for(const action of ['request','leave'] as const)app.post(`/squads/:id/${action}`,async c=>c.json(await changeSquadMembership(pool,await moduleCommand(c),c.req.param('id'),action)));
  app.get('/me/squad-invitations',async c=>c.json(await receivedSquadInvitations(pool,c.get('actor'),c.req.query())));
  app.get('/squads/:id/invitations',async c=>c.json(await squadInvitations(pool,c.get('actor'),c.req.param('id'),c.req.query())));
  app.post('/squads/:id/invitations',async c=>{const result=await inviteToSquad(pool,lowercaseIds(await moduleCommand(c)),c.req.param('id'));c.header('ETag',`"${result.aggregate_version}"`);return c.json(result);});
  for(const action of ['accept','decline','withdraw'] as const)app.post(`/squad-invitations/:id/${action}`,async c=>{const result=await resolveSquadInvitation(pool,lowercaseIds(await moduleCommand(c)),c.req.param('id'),action);c.header('ETag',`"${result.aggregate_version}"`);return c.json(result);});
  app.post('/squads/:id/members/:userId/accept',async c=>c.json(await changeSquadMembership(pool,await moduleCommand(c),c.req.param('id'),'accept',c.req.param('userId'))));
  return app;
}
