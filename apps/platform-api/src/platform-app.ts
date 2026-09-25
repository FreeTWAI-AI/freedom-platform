import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import type { Pool } from 'pg';
import { timingSafeEqual } from 'node:crypto';
import { authenticate, login, sessionView, type Actor } from '../../../modules/identity-membership/service.js';
import { createWork,claimWork,changeClaim,listWorks,dashboard } from '../../../modules/opportunity-project-work/work.js';
import { createShowcase,listShowcases,createOpportunity,listOpportunities,proposeEngagement,listEngagements,changeEngagement } from '../../../modules/opportunity-project-work/business.js';
import { Problem,requireCondition } from '../../../packages/shared/problem.js';
import type { Command } from '../../../packages/db/index.js';
import { allowedBrowserOrigins, type FreedomEnv } from './env.js';
import type { PlatformRuntime } from './runtime.js';
import { createPositioningRoutes } from './routes/positioning.js';
import { createCommerceRoutes } from './routes/commerce.js';
import { createMemberRoutes } from './routes/members.js';
import { checkAvatarUploadHeaders, createAvatarRoutes, isAvatarUpload } from './routes/avatars.js';
import { authRateLimit,registerMember } from '../../../modules/identity-membership/members.js';
import { communityCatalog } from '../../../modules/community/catalog.js';
import { createOpenSourceRoutes } from './routes/opensource.js';
import { createAdminRoutes } from './routes/admin.js';
import { createCoCreationRoutes } from './routes/co-creation.js';
import { createBenefitRoutes } from './routes/benefits.js';
import { createDevelopmentRoutes } from './routes/development.js';
import { createPublicClientConnectionRoutes,createClientConnectionRoutes,createClientApiRoutes } from './routes/client-connections.js';
import protocolMetadata from '../../../contracts/preview/v1/metadata.json' with { type: 'json' };
import packageMetadata from '../../../package.json' with { type: 'json' };
import {createGitHubMetricsRoutes,createGitHubSocialRoutes,socialLoader,type GitHubSocialOptions} from './routes/github-social.js';
import {GitHubSocial} from '../../../modules/github-social/service.js';
import {createDevelopmentAccessRoutes,createDevelopmentAgentRoutes,isAgentDevelopmentPath} from './routes/development-access.js';
import {createSkillDiscoveryRoutes} from './routes/skill-discovery.js';
import {skillDiscovery} from '../../../modules/community/discovery.js';
import {readSkillEditorial} from '../../../modules/guild-workspace/service.js';
import {createGuildWorkspaceRoutes} from './routes/guild-workspace.js';
import {onboardingDiagnostics} from './onboarding-diagnostics.js';
import {createSkillSubmissionRoutes,createAgentSkillSubmissionRoutes,isAgentSkillUploadPath} from './routes/skill-submissions.js';
import {createPublishedSkillRoutes} from './routes/published-skills.js';
import {createMemberCommunicationRoutes} from './routes/member-communications.js';

const COOKIE='freedom_local_session';
function onboardingAllowed(path:string,method:string) {
  if(path==='/api/v1/session'||path==='/api/v1/auth/logout'||path==='/api/v1/me/account')return true;
  if(method==='GET'&&['/api/v1/assessment-definition','/api/v1/career-tracks','/api/v1/guilds','/api/v1/me/skill-books','/api/v1/me/guild-preferences','/api/v1/guilds/directory'].includes(path))return true;
  if(/^\/api\/v1\/me\/onboarding(?:\/(answers|evaluate|complete))?$/.test(path))return true;
  return method==='POST'&&/^\/api\/v1\/guilds\/[^/]+\/(join|leave|primary)$/.test(path);
}
// PostgreSQL bigint stays lossless internally; canonical AggregateVersion is a JSON safe integer.
function wireVersions(value:any):any {
  if(Array.isArray(value))return value.map(wireVersions);
  if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>{
    if(k==='aggregate_version' && typeof v==='string') {
      const n=Number(v);requireCondition(Number.isSafeInteger(n)&&n>=0,500,'version_overflow','版本超出此 API 可表示範圍。');return [k,n];
    }
    return [k,wireVersions(v)];
  }));
  return value;
}
/** Runtime-neutral platform app. Host adapters: app.ts (Node) and worker.ts (Cloudflare). */
export function createPlatformApp(pool:Pool,origin:string,freedomEnv:FreedomEnv,runtime:PlatformRuntime,options:{githubSocial?:GitHubSocialOptions}={}) {
  const allowedOrigins=allowedBrowserOrigins(freedomEnv,origin);
  const allowedHosts=runtime.allowedHosts,authNetwork=runtime.sourceNetwork;
  const secureCookies=freedomEnv!=='local';
  const loadSocial=socialLoader(pool,origin,options.githubSocial,runtime.githubTokenKey);
  const publicSocial=new GitHubSocial(pool,undefined,options.githubSocial?.fetcher??fetch);
  const app=new Hono<{Variables:{actor:Actor}}>();
  app.onError((err,c)=>{
    if(err instanceof z.ZodError) return c.json({type:'about:blank',title:'Validation failed',status:422,code:'validation_failed',detail:err.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; ')},422);
    if(err instanceof Problem) return c.json({type:'about:blank',title:err.code,status:err.status,code:err.code,detail:err.message},err.status as 400);
    // Never echo SQL, request bodies, credentials, raw errors, or stack traces.
    console.error('request_failed', err instanceof Error ? err.name : 'unknown');
    return c.json({type:'about:blank',title:'Internal error',status:500,code:'internal_error',detail:'操作未完成，請重新整理並查看目前狀態。'},500);
  });
  app.use('/api/v1/me/onboarding/*',onboardingDiagnostics());
  app.use('*',async(c,next)=>{
    const host=new URL(c.req.url).hostname;
    requireCondition(allowedHosts.has(host),403,'host_rejected',freedomEnv==='local'?'此版本只提供本機使用。':'請從自由工坊網站操作。');
    c.header('Cache-Control','no-store');c.header('X-Content-Type-Options','nosniff');c.header('Referrer-Policy','no-referrer');
    const githubSetupForm=c.req.path==='/admin'||c.req.path==='/admin/github/callback'?' https://github.com/organizations/FreeTWAI-AI/settings/apps/new':'';
    c.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data: https:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"+githubSetupForm);
    if(!['GET','HEAD','OPTIONS'].includes(c.req.method)) {
      const agentUpload=isAgentSkillUploadPath(c.req.method,c.req.path)||isAgentDevelopmentPath(c.req.method,c.req.path);
      // Only the narrow Bearer-authenticated Agent endpoints accept a CLI
      // without Origin. Browser requests keep the normal same-origin checks.
      if(!agentUpload||c.req.header('Origin')!==undefined)requireCondition(allowedOrigins.has(c.req.header('Origin')??''),403,'origin_rejected',freedomEnv==='local'?'操作來源不正確，請從本機工作台操作。':'操作來源不正確，請從自由工坊網站操作。');
      if(agentUpload) {
        // The Agent route authenticates and consumes a bounded stream itself.
      } else if(isAvatarUpload(c.req.method,c.req.path)) {
        // Only this route accepts binary input. Its bounded stream reader runs
        // after session, CSRF and completed-member checks, before decoding.
        checkAvatarUploadHeaders(c.req.header('Content-Type'),c.req.header('Content-Length'));
      } else {
        requireCondition(c.req.header('Content-Type')?.split(';')[0]==='application/json',415,'json_required','操作需要 JSON。');
        requireCondition(Number(c.req.header('Content-Length')??0)<=32768,413,'body_too_large','內容過長。');
        const raw=await c.req.text();requireCondition(Buffer.byteLength(raw)<=32768,413,'body_too_large','內容過長。');
        try { JSON.parse(raw); } catch { throw new Problem(400,'invalid_json','JSON 格式不正確。'); }
      }
    }
    await next();
    if((c.req.path.startsWith('/api/')||c.req.path.startsWith('/agent-api/')||c.req.path.startsWith('/client-api/')||c.req.path.startsWith('/admin/api/')) && c.res.headers.get('Content-Type')?.includes('application/json')) {
      const data=wireVersions(await c.res.json());
      c.res=new Response(JSON.stringify(data),{status:c.res.status,headers:c.res.headers});
    }
  });
  app.route('/admin/api',createAdminRoutes(pool,runtime.adminVerifier,{origin,tokenKey:runtime.githubTokenKey(),fetcher:options.githubSocial?.fetcher}));
  app.route('/',createPublishedSkillRoutes(pool,runtime.publicOrigin));
  app.route('/',createDevelopmentRoutes(id=>publicSocial.cachedMetrics(id),id=>readSkillEditorial(pool,id),async id=>(await skillDiscovery(pool)).books.find(book=>book.book_id===id),runtime.publicOrigin));
  app.get('/api/v1/health',c=>c.json({status:'ok',mode:freedomEnv,version:packageMetadata.version,money_movement_enabled:false,official:false,...runtime.health}));
  app.get('/api/v1/protocol',c=>c.json(protocolMetadata));
  app.get('/api/v1/site',c=>c.json({brand:'自由工坊',public_mode:freedomEnv==='public',registration_enabled:freedomEnv==='local'||Boolean(runtime.registrationCommunityId()),demo_accounts_enabled:freedomEnv!=='public',community:communityCatalog}));
  app.get('/api/v1/community',c=>c.json(communityCatalog));
  app.route('/api/v1',createGitHubMetricsRoutes(async()=>publicSocial));
  app.route('/api/v1',createSkillDiscoveryRoutes(pool));
  app.route('/api/v1',createPublicClientConnectionRoutes(pool,origin,authNetwork));
  app.route('/client-api/v1',createClientApiRoutes(pool));
  app.route('/agent-api/v1',createAgentSkillSubmissionRoutes(pool,origin,authNetwork));
  app.route('/development-agent/v1',createDevelopmentAgentRoutes(pool,loadSocial,authNetwork));
  app.post('/api/v1/auth/register',async c=>{
    await authRateLimit(pool,'registration-network',authNetwork(c),8);
    await authRateLimit(pool,'registration-global','global',100,60);
    const raw=await c.req.json();
    const result=await registerMember(pool,raw,{communityId:runtime.registrationCommunityId(),allowSingleCommunity:freedomEnv==='local',publicMode:freedomEnv==='public'});
    const old=getCookie(c,COOKIE);
    if(old) {const {tokenHash}=await import('../../../modules/identity-membership/service.js');await pool.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1',[tokenHash(old)]);}
    setCookie(c,COOKIE,result.token,{httpOnly:true,sameSite:'Strict',secure:secureCookies,path:'/',maxAge:8*60*60});
    return c.json(sessionView(result.actor),201);
  });
  app.post('/api/v1/auth/login',async c=>{
    await authRateLimit(pool,'login-network',authNetwork(c),60);
    await authRateLimit(pool,'login-global','global',240,60);
    const body=z.object({email:z.email().max(200),password:z.string().min(1).max(200)}).strict().parse(await c.req.json());
    const result=await login(pool,body.email,body.password);
    // Replace any old session on login, so changing accounts never keeps an active old cookie.
    const old=getCookie(c,COOKIE);
    if(old) { const {tokenHash}=await import('../../../modules/identity-membership/service.js');await pool.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1',[tokenHash(old)]); }
    setCookie(c,COOKIE,result.token,{httpOnly:true,sameSite:'Strict',secure:secureCookies,path:'/',maxAge:8*60*60});
    return c.json(sessionView(result.actor));
  });
  app.use('/api/v1/*',async(c,next)=>{
    const actor=await authenticate(pool,getCookie(c,COOKIE));c.set('actor',actor);
    if(!['GET','HEAD'].includes(c.req.method)) {
      const got=Buffer.from(c.req.header('X-CSRF-Token')??''),expected=Buffer.from(actor.csrf_token);
      requireCondition(got.length===expected.length && timingSafeEqual(got,expected),403,'csrf_rejected','登入狀態已變更，請重新整理。');
    }
    requireCondition(!actor.onboarding_required||Boolean(actor.onboarding_completed_at)||onboardingAllowed(c.req.path,c.req.method),403,'onboarding_required','請先完成定位測驗並選擇主要公會。');
    await next();
  });
  const cmd=async(c:any):Promise<Command>=>{
    const ifMatch=c.req.header('If-Match') as string|undefined;
    if(ifMatch) requireCondition(/^"[1-9][0-9]*"$/.test(ifMatch),400,'invalid_version','If-Match 須為加引號的整數版本。');
    return {actor:c.get('actor'),operation:`${c.req.method} ${c.req.path}`,key:c.req.header('Idempotency-Key')??'',body:await c.req.json(),expected:ifMatch?.slice(1,-1)};
  };
  const routeId=(c:any,name='id')=>z.uuid().parse(c.req.param(name).split(':')[0]);
  const respond=(c:any,value:any,status=200)=>{if(value?.aggregate_version)c.header('ETag',`"${value.aggregate_version}"`);return c.json(value,status);};
  app.get('/api/v1/session',c=>c.json(sessionView(c.get('actor'))));
  app.post('/api/v1/auth/logout',async c=>{await pool.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1',[c.get('actor').session_hash]);deleteCookie(c,COOKIE,{path:'/'});return c.json({logged_out:true});});
  app.get('/api/v1/work-items',async c=>c.json({items:await listWorks(pool,c.get('actor'))}));
  app.post('/api/v1/work-items',async c=>respond(c,await createWork(pool,await cmd(c)),201));
  // Action suffix is part of the constrained segment; validate its UUID separately.
  app.post('/api/v1/work-items/:id{[0-9a-f-]+:claim}',async c=>respond(c,await claimWork(pool,await cmd(c),routeId(c)),201));
  for(const action of ['start','submit','begin-review','decide'] as const) {
    app.post(`/api/v1/work-claims/:id{[0-9a-f-]+:${action}}`,async c=>respond(c,await changeClaim(pool,await cmd(c),routeId(c),action)));
  }
  app.get('/api/v1/dashboard',async c=>c.json(await dashboard(pool,c.get('actor'))));
  app.get('/api/v1/showcases',async c=>c.json({items:await listShowcases(pool,c.get('actor'))}));
  app.post('/api/v1/showcases',async c=>respond(c,await createShowcase(pool,await cmd(c)),201));
  app.get('/api/v1/opportunities',async c=>c.json({items:await listOpportunities(pool,c.get('actor'))}));
  app.post('/api/v1/opportunities',async c=>respond(c,await createOpportunity(pool,await cmd(c)),201));
  app.post('/api/v1/opportunities/:id/engagements',async c=>respond(c,await proposeEngagement(pool,await cmd(c),routeId(c)),201));
  app.get('/api/v1/engagements',async c=>c.json({items:await listEngagements(pool,c.get('actor'))}));
  for(const action of ['agree','deliver','accept','confirm-receipt'] as const) {
    app.post(`/api/v1/engagements/:id{[0-9a-f-]+:${action}}`,async c=>respond(c,await changeEngagement(pool,await cmd(c),routeId(c),action)));
  }
  app.post('/api/v1/engagements/:id/receipts',async c=>respond(c,await changeEngagement(pool,await cmd(c),routeId(c),'receipt'),201));
  app.route('/api/v1',createMemberRoutes(pool));
  app.route('/api/v1',createMemberCommunicationRoutes(pool));
  app.route('/api/v1',createGitHubSocialRoutes(loadSocial));
  app.route('/api/v1',createDevelopmentAccessRoutes(pool,loadSocial));
  app.route('/api/v1',createGuildWorkspaceRoutes(pool));
  app.route('/api/v1',createAvatarRoutes(pool));
  app.route('/api/v1',createClientConnectionRoutes(pool));
  app.route('/api/v1',createSkillSubmissionRoutes(pool,origin));
  app.route('/api/v1',createPositioningRoutes(pool));
  app.route('/api/v1',createCommerceRoutes(pool));
  app.route('/api/v1',createOpenSourceRoutes(pool));
  app.route('/api/v1',createCoCreationRoutes(pool));
  app.route('/api/v1',createBenefitRoutes(pool));
  // Unknown machine paths answer JSON 404 before any host serves the browser shell.
  for(const prefix of ['/api/*','/client-api/*','/agent-api/*','/development-agent/*'])app.all(prefix,c=>c.json({type:'about:blank',title:'Not found',status:404,code:'not_found',detail:'此版本尚未提供這個 API。'},404));
  return app;
}
