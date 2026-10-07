import {Hono,type Context} from 'hono';
import {createGuildWorkspaceAdminRoutes} from './guild-workspace.js';
import {createRepoMaintainerAdminRoutes} from './repo-maintainer.js';
import {timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {getCookie} from 'hono/cookie';
import {authenticate} from '../../../../modules/identity-membership/service.js';
import {linkNominatedMember,nominatedGuildAppointments} from '../../../../modules/platform-admin/leadership.js';
import {setGuildExpert} from '../../../../modules/platform-admin/guild-experts.js';
import type {Pool} from 'pg';
import {Problem,requireCondition} from '../../../../packages/shared/problem.js';
import {verifyAdminAccess,type AdminAccessVerifier} from '../../../../modules/platform-admin/access.js';
import {authenticateAdmin,adminBootstrap,adminMembers,changeMemberStatus,adminApplications,reviewGuildApplication,adminGuilds,adminGuildMasterCandidates,appointGuildMaster,updateGuildProfile,adminNominees,adminAudit,appointPlatformAdmin,changePlatformAdminStatus,classifyGuild,backfillGuildPreferencesAdmin,switchGuildPreferencesAdmin,type AdminActor,type AdminCommand} from '../../../../modules/platform-admin/service.js';
import {listGuildCategories} from '../../../../modules/positioning/guild-categories.js';
import {GuildKey} from '../../../../contracts/guild-launchpad/v1/guild-preferences.js';
import {startGitHubAppSetup,completeGitHubAppSetup,githubAppSetupStatus} from '../../../../modules/github-social/setup.js';
import {listAdminEventQueue,reviewEventAsAdmin} from '../../../../modules/community/events.js';
import {acknowledgeAuthorClaimIdentity,adminAuthorClaims,refreshAuthorClaimObservation,reviewAuthorClaim} from '../../../../modules/community/repo-author-claims.js';
import {guildDiscoveryReport,refreshGuildDiscoveryReports,type GuildReviewer} from '../../../../modules/community/guild-discovery.js';
import {listCredentials,requestCloudflareRenewal} from '../../../../modules/platform-admin/credentials.js';
import {approveRecoveryCase,closeRecoveryCase,executeRecoveryCase,getRecoveryCase,openRecoveryCase} from '../../../../modules/tenant-workspaces/recovery.js';
type AdminEnv={Variables:{admin:AdminActor;adminCsrf:string}};
export function createAdminRoutes(pool:Pool,verifyAccess:AdminAccessVerifier=verifyAdminAccess,github:{origin:string;tokenKey?:string;fetcher?:typeof fetch;readToken?:()=>string|undefined;guildReviewer?:GuildReviewer}={origin:'http://127.0.0.1:4310'},guildLaunchpadEnabled=false){
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
  app.get('/members',async c=>{const {limit,offset}=paging(c),q=z.string().trim().max(100).parse(c.req.query('q')??''),includeTest=z.enum(['true','false']).default('false').parse(c.req.query('include_test'))==='true';return c.json(await adminMembers(pool,c.get('admin'),limit,offset,q,includeTest));});
  app.post('/members/:id/admin',async c=>result(c,await appointPlatformAdmin(pool,await command(c),c.req.param('id'))));
  app.post('/members/:id/status',async c=>result(c,await changeMemberStatus(pool,await command(c),c.req.param('id'))));
  app.get('/guild-applications',async c=>{const {limit,offset}=paging(c),state=z.enum(['pending','approved','declined','all']).parse(c.req.query('state')??'pending');return c.json(await adminApplications(pool,c.get('admin'),limit,offset,state));});
  app.get('/events',async c=>c.json({items:await listAdminEventQueue(pool,c.get('admin'))}));
  app.post('/events/:id/review',async c=>result(c,await reviewEventAsAdmin(pool,await command(c),z.uuid().parse(c.req.param('id')))));
  app.post('/guild-applications/:id/review',async c=>result(c,await reviewGuildApplication(pool,await command(c),c.req.param('id'))));
  app.get('/guild-discovery',async c=>c.json({...await guildDiscoveryReport(pool,c.get('admin').community_id),ai_configured:Boolean(github.guildReviewer)}));
  app.post('/guild-discovery/refresh',async c=>{
    z.object({}).strict().parse(await c.req.json());
    await refreshGuildDiscoveryReports(pool,{communityId:c.get('admin').community_id,reviewer:github.guildReviewer});
    return c.json({...await guildDiscoveryReport(pool,c.get('admin').community_id),ai_configured:Boolean(github.guildReviewer)});
  });
  app.get('/guilds',async c=>c.json({items:await adminGuilds(pool,c.get('admin'))}));
  app.get('/guilds/:key/master-candidates',async c=>c.json(await adminGuildMasterCandidates(pool,c.get('admin'),c.req.param('key'),c.req.query())));
  app.post('/guilds/:key/master',async c=>result(c,await appointGuildMaster(pool,await command(c),z.string().min(1).max(100).parse(c.req.param('key')))));
  app.post('/guilds/:key/profile',async c=>result(c,await updateGuildProfile(pool,await command(c),z.string().min(1).max(100).regex(/^(guild_[a-z0-9_]+|guild_custom_[0-9A-Fa-f]{32})$/).parse(c.req.param('key')))));
  app.post('/guilds/:key/experts',async c=>result(c,await setGuildExpert(pool,await command(c),z.string().min(1).max(100).parse(c.req.param('key')))));
  app.get('/admins',async c=>c.json({items:await adminNominees(pool,c.get('admin'))}));
  app.post('/admins/:id/status',async c=>result(c,await changePlatformAdminStatus(pool,await command(c),c.req.param('id'))));
  app.get('/audit',async c=>c.json({items:await adminAudit(pool,c.get('admin'))}));
  app.get('/author-claims',async c=>c.json(await adminAuthorClaims(pool,c.get('admin'),z.enum(['review','verified']).parse(c.req.query('queue')??'review'))));
  app.post('/author-claims/:id/review',async c=>{
    const value=await reviewAuthorClaim(pool,await command(c),z.uuid().parse(c.req.param('id')));
    c.header('ETag',`"${value.version}"`);return c.json(value);
  });
  const skillBookId=(c:Context<AdminEnv>)=>z.string().regex(/^[a-z0-9-]{1,100}$/).parse(c.req.param('id'));
  app.post('/skill-books/:id/author-claim-observation',async c=>c.json(await refreshAuthorClaimObservation(pool,await command(c),skillBookId(c),github.fetcher??globalThis.fetch,github.readToken?.())));
  app.post('/skill-books/:id/author-claim-observation/acknowledge',async c=>c.json(await acknowledgeAuthorClaimIdentity(pool,await command(c),skillBookId(c))));
  app.get('/credentials',async c=>c.json(await listCredentials(pool)));
  app.post('/credentials/:key/renewals',async c=>{
    if(c.req.param('key')!=='cloudflare_deploy_token')return c.json({type:'about:blank',title:'Not found',status:404,code:'not_found',detail:'找不到這個憑證。'},404);
    const value=await requestCloudflareRenewal(pool,await command(c));
    return c.json(value.request,value.created?201:200);
  });
  app.get('/client-errors',async c=>{
    const admin=c.get('admin');
    const rows=await pool.query(`SELECT e.error_id,e.user_id,u.display_name,e.action,e.error_code,e.http_status,e.created_at
      FROM member_client_errors e JOIN users u ON u.user_id=e.user_id
      WHERE e.community_id=$1 ORDER BY e.created_at DESC LIMIT 100`,[admin.community_id]);
    return c.json({items:rows.rows});
  });
  if(guildLaunchpadEnabled){
    app.get('/guild-categories',async c=>c.json(await listGuildCategories(pool)));
    app.post('/guilds/:key/classification',async c=>{
      requireCondition(c.req.header('If-Match'),428,'version_required','請提供 If-Match 版本。');
      const value=await classifyGuild(pool,await command(c),GuildKey.parse(c.req.param('key')));
      c.header('ETag',`"${value.classification.catalog_revision}"`);return c.json(value);
    });
    app.post('/guild-preferences/backfill',async c=>c.json(await backfillGuildPreferencesAdmin(pool,await command(c))));
    app.post('/guild-preferences/switch',async c=>c.json(await switchGuildPreferencesAdmin(pool,await command(c))));
  }
  app.route('/',createRepoMaintainerAdminRoutes(pool));
  if(guildLaunchpadEnabled){
    const matched=async(c:Context<AdminEnv>)=>{
      const version=c.req.header('If-Match');
      if(version===undefined)throw new Problem(428,'version_required','請提供 If-Match 版本。');
      requireCondition(/^"[1-9][0-9]{0,18}"$/.test(version)&&BigInt(version.slice(1,-1))<=9223372036854775807n,400,'invalid_version','If-Match 須為加引號的正整數版本。');
      return command(c);
    };
    const recovery=(c:Context<AdminEnv>,value:{version?:string;case?:{version?:string}},status=200)=>{
      const version=value.case?.version??value.version;
      if(version)c.header('ETag',`"${version}"`);
      c.header('Cache-Control','private, no-store');c.header('Vary','Cookie');
      return c.json(value,status as 200);
    };
    app.post('/tenant-recovery-cases',async c=>recovery(c,await openRecoveryCase(pool,await command(c)),201));
    app.get('/tenant-recovery-cases/:id',async c=>recovery(c,await getRecoveryCase(pool,c.get('admin'),z.uuid().parse(c.req.param('id')))));
    app.post('/tenant-recovery-cases/:id/approve',async c=>recovery(c,await approveRecoveryCase(pool,await matched(c),z.uuid().parse(c.req.param('id')))));
    app.post('/tenant-recovery-cases/:id/execute',async c=>recovery(c,await executeRecoveryCase(pool,await matched(c),z.uuid().parse(c.req.param('id')))));
    app.post('/tenant-recovery-cases/:id/close',async c=>recovery(c,await closeRecoveryCase(pool,await matched(c),z.uuid().parse(c.req.param('id')))));
  }
  app.all('*',c=>c.json({type:'about:blank',title:'Not found',status:404,code:'not_found',detail:'找不到這個管理 API。'},404));
  return app;
}
