import {Hono,type Context} from 'hono';
import {createGuildWorkspaceAdminRoutes} from './guild-workspace.js';
import {timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {getCookie} from 'hono/cookie';
import {authenticate} from '../../../../modules/identity-membership/service.js';
import {linkNominatedMember,nominatedGuildAppointments} from '../../../../modules/platform-admin/leadership.js';
import type {Pool} from 'pg';
import {requireCondition} from '../../../../packages/shared/problem.js';
import {verifyAdminAccess,type AdminAccessVerifier} from '../../../../modules/platform-admin/access.js';
import {authenticateAdmin,adminBootstrap,adminMembers,changeMemberStatus,adminApplications,reviewGuildApplication,adminGuilds,adminGuildMasterCandidates,appointGuildMaster,adminNominees,adminAudit,appointPlatformAdmin,changePlatformAdminStatus,type AdminActor,type AdminCommand} from '../../../../modules/platform-admin/service.js';
import {startGitHubAppSetup,completeGitHubAppSetup,githubAppSetupStatus} from '../../../../modules/github-social/setup.js';
type AdminEnv={Variables:{admin:AdminActor;adminCsrf:string}};
export function createAdminRoutes(pool:Pool,verifyAccess:AdminAccessVerifier=verifyAdminAccess,github:{origin:string;tokenKey?:string;fetcher?:typeof fetch}={origin:'http://127.0.0.1:4310'}){
  const app=new Hono<AdminEnv>();
  app.use('*',async(c,next)=>{
    const identity=await verifyAccess(c.req.raw),admin=await authenticateAdmin(pool,identity);
    c.set('admin',admin);c.set('adminCsrf',identity.csrfToken);
    if(!['GET','HEAD'].includes(c.req.method)){
      const got=Buffer.from(c.req.header('X-Admin-CSRF')??''),expected=Buffer.from(identity.csrfToken);
      requireCondition(got.length===expected.length&&timingSafeEqual(got,expected),403,'admin_csrf_rejected','管理員驗證已變更，請重新整理。');
    }
    await next();
  });
  app.route('/',createGuildWorkspaceAdminRoutes(pool));
  const command=async(c:Context<AdminEnv>):Promise<AdminCommand>=>{
    const version=c.req.header('If-Match');
    if(version)requireCondition(/^"[1-9][0-9]*"$/.test(version),400,'invalid_version','If-Match 須為加引號的整數版本。');
    return {admin:c.get('admin'),operation:`${c.req.method} ${c.req.path}`,key:c.req.header('Idempotency-Key')??'',body:await c.req.json(),expected:version?.slice(1,-1)};
  };
  const paging=(c:Context<AdminEnv>)=>z.object({limit:z.coerce.number().int().min(1).max(100).default(25),offset:z.coerce.number().int().min(0).max(100000).default(0)}).parse(c.req.query());
  const result=(c:Context<AdminEnv>,value:any)=>{if(value.aggregate_version)c.header('ETag',`"${value.aggregate_version}"`);return c.json(value);};
  app.get('/bootstrap',async c=>c.json({...await adminBootstrap(pool,c.get('admin')),csrf_token:c.get('adminCsrf'),pending_guild_appointments:await nominatedGuildAppointments(pool,c.get('admin'))}));
  app.get('/github-app',async c=>c.json({...await githubAppSetupStatus(pool,c.get('admin')),setup_available:Boolean(github.tokenKey)}));
  app.post('/github-app/start',async c=>{
    z.object({}).strict().parse(await c.req.json());
    requireCondition(github.tokenKey,503,'github_setup_unavailable','GitHub 連結設定尚未啟用。');
    return c.json(await startGitHubAppSetup(pool,c.get('admin'),github.origin,github.tokenKey));
  });
  app.post('/github-app/complete',async c=>{
    const body=z.object({code:z.string().min(1).max(512),state:z.string().min(20).max(200)}).strict().parse(await c.req.json());
    requireCondition(github.tokenKey,503,'github_setup_unavailable','GitHub 連結設定尚未啟用。');
    return c.json(await completeGitHubAppSetup(pool,c.get('admin'),body,github.tokenKey,{fetcher:github.fetcher}));
  });
  app.post('/link-member',async c=>{const input=await command(c),member=await authenticate(pool,getCookie(c,'freedom_local_session'));return result(c,await linkNominatedMember(pool,input,member));});
  app.get('/members',async c=>{const {limit,offset}=paging(c),q=z.string().trim().max(100).parse(c.req.query('q')??'');return c.json(await adminMembers(pool,c.get('admin'),limit,offset,q));});
  app.post('/members/:id/admin',async c=>result(c,await appointPlatformAdmin(pool,await command(c),c.req.param('id'))));
  app.post('/members/:id/status',async c=>result(c,await changeMemberStatus(pool,await command(c),c.req.param('id'))));
  app.get('/guild-applications',async c=>{const {limit,offset}=paging(c),state=z.enum(['pending','approved','declined','all']).parse(c.req.query('state')??'pending');return c.json(await adminApplications(pool,c.get('admin'),limit,offset,state));});
  app.post('/guild-applications/:id/review',async c=>result(c,await reviewGuildApplication(pool,await command(c),c.req.param('id'))));
  app.get('/guilds',async c=>c.json({items:await adminGuilds(pool,c.get('admin'))}));
  app.get('/guilds/:key/master-candidates',async c=>c.json(await adminGuildMasterCandidates(pool,c.get('admin'),c.req.param('key'),c.req.query())));
  app.post('/guilds/:key/master',async c=>result(c,await appointGuildMaster(pool,await command(c),z.string().min(1).max(100).parse(c.req.param('key')))));
  app.get('/admins',async c=>c.json({items:await adminNominees(pool,c.get('admin'))}));
  app.post('/admins/:id/status',async c=>result(c,await changePlatformAdminStatus(pool,await command(c),c.req.param('id'))));
  app.get('/audit',async c=>c.json({items:await adminAudit(pool,c.get('admin'))}));
  app.all('*',c=>c.json({type:'about:blank',title:'Not found',status:404,code:'not_found',detail:'找不到這個管理 API。'},404));
  return app;
}
