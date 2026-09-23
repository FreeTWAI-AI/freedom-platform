import {Hono,type Context} from 'hono';
import type {Pool} from 'pg';
import {requireCondition} from '../../../../packages/shared/problem.js';
import {moduleCommand,type PlatformEnv} from '../module-context.js';
import type {AdminActor,AdminCommand} from '../../../../modules/platform-admin/service.js';
import * as service from '../../../../modules/guild-workspace/service.js';
export function createGuildWorkspaceRoutes(pool:Pool){
 const app=new Hono<PlatformEnv>();
 app.get('/guild-workspace',async c=>c.json(await service.guildWorkspace(pool,c.get('actor'))));
 app.get('/guilds/:key/announcements',async c=>c.json(await service.guildAnnouncements(pool,c.get('actor'),c.req.param('key'))));
 app.post('/guilds/:key/announcements',async c=>c.json(await service.createGuildAnnouncement(pool,await moduleCommand(c),c.req.param('key')),201));
 app.post('/guild-announcements/:id/edit',async c=>c.json(await service.editGuildAnnouncement(pool,await moduleCommand(c),c.req.param('id'))));
 app.get('/skill-books/:id/editor',async c=>c.json(await service.skillEditor(pool,c.get('actor'),c.req.param('id'))));
 app.post('/skill-books/:id/editor',async c=>c.json(await service.saveSkillEditorial(pool,await moduleCommand(c),c.req.param('id'))));
 app.get('/guild-council/threads',async c=>c.json(await service.listGuildCouncil(pool,c.get('actor'))));
 app.post('/guild-council/threads',async c=>c.json(await service.createGuildCouncilThread(pool,await moduleCommand(c)),201));
 app.get('/guild-council/threads/:id',async c=>c.json(await service.getGuildCouncilThread(pool,c.get('actor'),c.req.param('id'))));
 app.post('/guild-council/threads/:id/replies',async c=>c.json(await service.replyGuildCouncilThread(pool,await moduleCommand(c),c.req.param('id')),201));
 return app;
}
type AdminEnv={Variables:{admin:AdminActor;adminCsrf:string}};
/** Must be mounted inside createAdminRoutes AFTER verified Access + admin CSRF middleware. */
export function createGuildWorkspaceAdminRoutes(pool:Pool){
 const app=new Hono<AdminEnv>();
 const command=async(c:Context<AdminEnv>):Promise<AdminCommand>=>{const version=c.req.header('If-Match');if(version)requireCondition(/^"[1-9][0-9]*"$/.test(version),400,'invalid_version','請提供有效的資料版本。');return {admin:c.get('admin'),operation:`${c.req.method} ${c.req.path}`,key:c.req.header('Idempotency-Key')??'',body:await c.req.json(),expected:version?.slice(1,-1)};};
 app.get('/skill-maintainers',async c=>c.json(await service.listSkillMaintainers(pool,c.get('admin'))));
 app.post('/skill-maintainers/:id',async c=>c.json(await service.appointSkillMaintainer(pool,await command(c),c.req.param('id'))));
 app.get('/guild-council/threads',async c=>c.json(await service.listAdminCouncil(pool,c.get('admin'))));
 app.post('/guild-council/threads',async c=>c.json(await service.createAdminCouncilThread(pool,await command(c)),201));
 app.get('/guild-council/threads/:id',async c=>c.json(await service.getAdminCouncilThread(pool,c.get('admin'),c.req.param('id'))));
 app.post('/guild-council/threads/:id/replies',async c=>c.json(await service.replyAdminCouncilThread(pool,await command(c),c.req.param('id')),201));
 return app;
}
