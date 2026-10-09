import { createHostedOrderRoutes } from './routes/hosted-orders.js';
import { privateCache as hostedOrderPrivateCache } from './routes/tenant-http.js';
import { createHostedStoreRoutes, createPublicHostedStoreRoutes } from './routes/hosted-store.js';
import {installedPrivateAiResponse} from './private-ai-path.js';
import {shopServiceHost} from '../../../packages/resource-scopes/shop-service.js';
import { guideAssetResponse, isGuideAssetPath, registerGuideReleaseRoute } from './routes/guide-packs.js';
import {createAgentCommerceRoutes,createShopMachineRoutes,createPublicShopRoutes} from './routes/agent-commerce.js';
import { Hono, type MiddlewareHandler } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import type { Pool } from 'pg';
import { authenticate, login, sessionView, SESSION_LIFETIME_SECONDS, type Actor } from '../../../modules/identity-membership/service.js';
import { memberBoundary } from './member-boundary.js';
import { readSessionCookie, sessionCookieName } from './session-cookie.js';
import { createWork,claimWork,changeClaim,listWorks,dashboard } from '../../../modules/opportunity-project-work/work.js';
import { createPrivateWorkRoutes } from './routes/private-work.js';
import { createShowcase,listShowcases,createOpportunity,listOpportunities,proposeEngagement,listEngagements,changeEngagement } from '../../../modules/opportunity-project-work/business.js';
import { Problem,requireCondition } from '../../../packages/shared/problem.js';
import { AssetStorageError } from '../../../packages/asset-storage/index.js';
import { DependencySelectionRequired, InstanceSelectionRequired, QuotaExceeded } from '../../../modules/module-registry/problems.js';
import type { Command } from '../../../packages/db/index.js';
import { allowedBrowserOrigins, type FreedomEnv } from './env.js';
import type { PlatformRuntime } from './runtime.js';
import {PUBLIC_REVALIDATION_SCRIPT} from '../../../packages/shared/public-revalidation.js';
import { listCommunityBookmarks, changeCommunityBookmark, listCommunityFollows, changeCommunityFollow, listCommunityFollowUpdates } from '../../../modules/community/content-relations.js';
import { createPositioningRoutes } from './routes/positioning.js';
import { listGuildCategories } from '../../../modules/positioning/guild-categories.js';
import { createCommerceRoutes } from './routes/commerce.js';
import { createMemberRoutes } from './routes/members.js';
import { checkAvatarUploadHeaders, createAvatarRoutes, isAvatarUpload } from './routes/avatars.js';
import { authRateLimit,registerMember } from '../../../modules/identity-membership/members.js';
import { requestPasswordReset,confirmPasswordReset } from '../../../modules/identity-membership/password-recovery.js';
import { communityCatalog } from '../../../modules/community/catalog.js';
import {publicDiscovery,discoveryReadAllowed} from '../../../modules/community/public-discovery.js';
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
import {createMemberAuthorClaimRoutes, createPublicAuthorClaimRoutes} from './routes/repo-author-claims.js';
import {publicAuthorClaimForBook} from '../../../modules/community/repo-author-claims.js';
import {skillDiscovery} from '../../../modules/community/discovery.js';
import {readSkillEditorial} from '../../../modules/guild-workspace/service.js';
import {createGuildWorkspaceRoutes} from './routes/guild-workspace.js';
import {createTenantWorkspaceRoutes} from './routes/tenant-workspaces.js';
import {createGuildLaunchpadRoutes, createPublicGuildLaunchpadRoutes} from './routes/guild-launchpad.js';
import {createModuleRegistryRoutes, createPublicModuleRegistryRoutes} from './routes/module-registry.js';
import {checkTenantResultContentHeaders,createTenantWorkRoutes,isTenantResultContentUpload} from './routes/tenant-work.js';
import {onboardingDiagnostics} from './onboarding-diagnostics.js';
import {createSkillSubmissionRoutes,createAgentSkillSubmissionRoutes,isAgentSkillUploadPath} from './routes/skill-submissions.js';
import {createMaintainerWebhookRoutes,createRepoMaintainerMemberRoutes,isMaintainerWebhookPath} from './routes/repo-maintainer.js';
import {createPublishedSkillRoutes} from './routes/published-skills.js';
import {checkMessageImageHeaders,createMemberCommunicationRoutes,isMessageImageUpload,messageImagesInstalled} from './routes/member-communications.js';
import {PageGitHubReader,PageGitHubEventReader} from '../../../modules/development/page-github.js';
import {createCommunityEventRoutes,checkEventBannerUploadHeaders,checkEventVideoUploadHeaders,eventVideoResponse,eventAssetVideoResponse,isEventBannerUpload,isEventVideoUpload} from './routes/community-events.js';
import {checkHighlightPhotoUploadHeaders,checkHighlightPosterUploadHeaders,createEventHighlightMemberRoutes,createEventHighlightPublicRoutes,isHighlightPhotoUpload,isHighlightPosterUpload} from './routes/event-highlights.js';
import {CollaborationGitHub} from '../../../modules/co-creation/github.js';
import {acceptedWorkFeed,contributionRecords,previewTasks} from '../../../modules/community/task-board.js';
import {publicEvent,publicEventBanner,publicEventVideo,registerPublicEvent} from '../../../modules/community/events.js';
import {checkSocialThumbnailHeaders,isSocialThumbnailUpload,registerMemberPromotion,registerPublicPromotion} from './routes/promotion.js';
import {checkServiceCoverHeaders,isServiceCoverUpload,registerMemberServices,registerPublicMemberServices} from './routes/member-services.js';
import {publicMemberCard,publicMemberAvatar} from '../../../modules/identity-membership/member-sharing.js';
import { searchCommunityContent, assignContentTopics, listTaggableContent } from '../../../modules/community/content-search.js';

function onboardingAllowed(path:string,method:string) {
  if(path==='/api/v1/me/client-errors'&&method==='POST')return true;
  if(path==='/api/v1/events'&&method==='POST')return true;
  if(method==='POST'&&/^\/api\/v1\/events\/[0-9a-f-]{36}\/banner$/.test(path))return true;
  if(method==='POST'&&/^\/api\/v1\/events\/[0-9a-f-]{36}\/video$/.test(path))return true;
  if(path==='/api/v1/me/notifications'&&method==='GET')return true;
  if(method==='POST'&&/^\/api\/v1\/me\/notifications\/[0-9a-f-]+\/read$/.test(path))return true;
  if(path==='/api/v1/session'||path==='/api/v1/auth/logout'||path==='/api/v1/me/account')return true;
  if(method==='GET'&&['/api/v1/assessment-definition','/api/v1/career-tracks','/api/v1/guilds','/api/v1/me/skill-books','/api/v1/me/guild-preferences','/api/v1/guilds/directory','/api/v1/events','/api/v1/task-board/preview'].includes(path))return true;
  if(/^\/api\/v1\/me\/onboarding(?:\/(answers|evaluate|complete|quick-start))?$/.test(path))return true;
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
/** Browser page for a share token. The JSON and avatar routes set the same tag themselves. */
export function isMemberCardPage(path:string){return /^\/member-cards\/[A-Za-z0-9_-]{43}\/?$/.test(path);}
/** Runtime-neutral platform app. Host adapters: app.ts (Node) and worker.ts (Cloudflare). */
export function createPlatformApp(pool:Pool,origin:string,freedomEnv:FreedomEnv,runtime:PlatformRuntime,options:{githubSocial?:GitHubSocialOptions;coCreationGitHub?:CollaborationGitHub}={}) {
  const allowedOrigins=allowedBrowserOrigins(freedomEnv,origin);
  const shopHost=shopServiceHost(freedomEnv,origin,runtime.shopKeyPolicy);
  const allowedHosts=runtime.allowedHosts,authNetwork=runtime.rateLimitNetwork??runtime.sourceNetwork;
  const brokerFormOrigin=runtime.privateAiProduct?runtime.privateAiSetupOrigin?.():undefined;
  if(brokerFormOrigin!==undefined){
    const setup=new URL(brokerFormOrigin),main=new URL(origin);
    if(setup.protocol!=='https:'||setup.origin!==brokerFormOrigin||setup.username||setup.password
      ||setup.hostname===main.hostname||/[?#%\\\x00-\x20\x7f-\uffff]/.test(brokerFormOrigin))throw new Error('invalid_private_ai_browser_policy');
  }

  const secureCookies=freedomEnv!=='local';
  const COOKIE=sessionCookieName(origin);
  const loadSocial=socialLoader(pool,origin,options.githubSocial,runtime.githubTokenKey,runtime.githubMetricsToken);
  const publicSocial=new GitHubSocial(pool,undefined,options.githubSocial?.fetcher??fetch,runtime.githubMetricsToken());
  const pageGitHub=new PageGitHubReader(pool);
  const pageGitHubEvents=new PageGitHubEventReader(pool);
  const app=new Hono<{Variables:{actor:Actor}}>();
  app.onError((err,c)=>{
    if(err instanceof z.ZodError) return c.json({type:'about:blank',title:'Validation failed',status:422,code:'validation_failed',detail:err.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; ')},422);
    if(err instanceof InstanceSelectionRequired) return c.json({type:'about:blank',title:err.code,status:err.status,code:err.code,detail:err.message,candidates:err.candidates},409);
    if(err instanceof DependencySelectionRequired) return c.json({type:'about:blank',title:err.code,status:err.status,code:err.code,detail:err.message,candidates:err.candidates},409);
    if(err instanceof QuotaExceeded) return c.json({type:'about:blank',title:err.code,status:err.status,code:err.code,detail:err.message,dimension:err.dimension},429);
    if(err instanceof AssetStorageError && err.code==='object_unavailable') return c.json({type:'about:blank',title:'object_unavailable',status:503,code:'object_unavailable',detail:'內容儲存目前無法使用。'},503);
    if(err instanceof Problem) {
      const retry=err.retryAfterSeconds;
      if(typeof retry==='number'&&Number.isFinite(retry)&&retry>=0&&retry<=86400)c.header('Retry-After',String(Math.ceil(retry)));
      return c.json({type:'about:blank',title:err.code,status:err.status,code:err.code,detail:err.message},err.status as 400);
    }
    // Never echo SQL, request bodies, credentials, raw errors, or stack traces.
    console.error('request_failed', err instanceof Error ? err.name : 'unknown');
    return c.json({type:'about:blank',title:'Internal error',status:500,code:'internal_error',detail:'操作未完成，請重新整理並查看目前狀態。'},500);
  });
  app.use('/api/v1/me/onboarding/*',onboardingDiagnostics());
  app.use('*',async(c,next)=>{
    c.header('Cache-Control','no-store');c.header('X-Content-Type-Options','nosniff');c.header('Referrer-Policy','no-referrer');
    const host=new URL(c.req.url).hostname;
    requireCondition(allowedHosts.has(host),403,'host_rejected',freedomEnv==='local'?'此版本只提供本機使用。':'請從自由工坊網站操作。');
    if(c.req.path==='/api/v1/community-search'||c.req.path.startsWith('/api/v1/community-search/'))c.header('X-Robots-Tag','noindex, nofollow');
    readSessionCookie(c.req.header('Cookie'),origin);
    if(isMemberCardPage(c.req.path))c.header('X-Robots-Tag','noindex, nofollow');
    const githubSetupForm=c.req.path==='/admin'||c.req.path==='/admin/github/callback'?' https://github.com/organizations/FreeTWAI-AI/settings/apps/new':'';
    c.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data: https:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"+githubSetupForm+(brokerFormOrigin?' '+brokerFormOrigin:''));
    // Public guide responses are terminal and own their explicit validated cache policy.
    // Return before generic mutation body parsing; unknown paths never reach the SPA.
    if(isGuideAssetPath(c.req.path)){
      const response=await guideAssetResponse(c.req.raw,runtime.publicGuideAssets);
      c.header('Cache-Control',response.headers.get('Cache-Control')??'no-store');
      return response;
    }
    // These host-installed child transports authorize and bound the ORIGINAL
    // request body. The legacy generic text reader must not consume it first.
    const privateAi=installedPrivateAiResponse(c.req.raw,runtime.privateAiProduct);
    if(privateAi)return privateAi;
    if(!['GET','HEAD','OPTIONS'].includes(c.req.method)) {
      const agentUpload=isAgentSkillUploadPath(c.req.method,c.req.path)||isAgentDevelopmentPath(c.req.method,c.req.path);
      // Only the narrow Bearer-authenticated Agent endpoints accept a CLI
      // without Origin. Browser requests keep the normal same-origin checks.
      const shopMachine=c.req.path.startsWith('/shop-api/v1/');
      const maintainerWebhook=isMaintainerWebhookPath(c.req.method,c.req.path);
      // GitHub sends no Origin. A browser Origin that is present must still match.
      if((!agentUpload&&!shopMachine&&!maintainerWebhook)||c.req.header('Origin')!==undefined)requireCondition(allowedOrigins.has(c.req.header('Origin')??''),403,'origin_rejected',freedomEnv==='local'?'操作來源不正確，請從本機工作台操作。':'操作來源不正確，請從自由工坊網站操作。');
      if(agentUpload) {
        // The Agent route authenticates and consumes a bounded stream itself.
      } else if(maintainerWebhook) {
        // The route checks content type, the 2 MiB cap and the signature, then reads the raw body.
      } else if(isAvatarUpload(c.req.method,c.req.path)) {
        // Only this route accepts binary input. Its bounded stream reader runs
        // after session, CSRF and completed-member checks, before decoding.
        checkAvatarUploadHeaders(c.req.header('Content-Type'),c.req.header('Content-Length'));
      } else if(isEventBannerUpload(c.req.method,c.req.path)) {
        checkEventBannerUploadHeaders(c.req.header('Content-Type'),c.req.header('Content-Length'));
      } else if(isEventVideoUpload(c.req.method,c.req.path)) {
        checkEventVideoUploadHeaders(c.req.header('Content-Type'),c.req.header('Content-Length'));
      } else if(isSocialThumbnailUpload(c.req.method,c.req.path)) {
        checkSocialThumbnailHeaders(c.req.header('Content-Type'),c.req.header('Content-Length'));
      } else if(isMessageImageUpload(c.req.method,c.req.path)) {
        // Binary body only when the feature is installed; otherwise the route does not exist.
        requireCondition(messageImagesInstalled(runtime),404,'not_found','找不到這個頁面。');
        checkMessageImageHeaders(c.req.header('Content-Type'),c.req.header('Content-Length'));
      } else if(isServiceCoverUpload(c.req.method,c.req.path)) {
        checkServiceCoverHeaders(c.req.header('Content-Type'),c.req.header('Content-Length'));
      } else if(isHighlightPhotoUpload(c.req.method,c.req.path)) {
        checkHighlightPhotoUploadHeaders(c.req.header('Content-Type'),c.req.header('Content-Length'));
      } else if(isHighlightPosterUpload(c.req.method,c.req.path)) {
        checkHighlightPosterUploadHeaders(c.req.header('Content-Type'),c.req.header('Content-Length'));
      } else if(isTenantResultContentUpload(c.req.method,c.req.path)) {
        // The route reads a capped byte stream after the session check. Do not parse JSON.
        checkTenantResultContentHeaders(c.req.header('Content-Length'));
      } else {
        requireCondition(c.req.header('Content-Type')?.split(';')[0]==='application/json',415,'json_required','操作需要 JSON。');
        requireCondition(Number(c.req.header('Content-Length')??0)<=32768,413,'body_too_large','內容過長。');
        if(c.req.raw.body) {
          let size=0;
          const body=c.req.raw.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({
            transform(chunk,controller) {
              size+=chunk.byteLength;
              requireCondition(size<=32768,413,'body_too_large','內容過長。');
              controller.enqueue(chunk);
            },
          }));
          // Hono caches body promises. Preserve the host Request and its cf metadata.
          Object.assign(c.req.bodyCache,{text:new Response(body).text()});
        }
        const raw=await c.req.text();
        try { JSON.parse(raw); } catch { throw new Problem(400,'invalid_json','JSON 格式不正確。'); }
      }
    }
    if(runtime.communityDiscoveryEnabled===true&&['GET','HEAD'].includes(c.req.method)){
      requireCondition(await discoveryReadAllowed(pool,c.req.path,runtime.registrationCommunityId()),404,'not_found','找不到公開內容。');
    }
    await next();
    if(runtime.communityDiscoveryEnabled===true&&['GET','HEAD'].includes(c.req.method)){
      if(/^\/(?:services|highlights|api\/v1\/public\/(?:events|event-highlights|member-services))(?:\/|$)/.test(c.req.path))c.header('Cache-Control','no-store');
      if(/^\/events\/[0-9a-f-]{36}\/?$/.test(c.req.path)&&c.req.query('ref'))c.header('X-Robots-Tag','noindex, nofollow');
      requireCondition(await discoveryReadAllowed(pool,c.req.path,runtime.registrationCommunityId()),404,'not_found','找不到公開內容。');
    }
    // A native cross-origin form uses the source document's referrer policy
    // when deriving Origin. Suppressing all referrers makes that Origin null.
    // Only installed HTML documents disclose the origin, never path or query;
    // API replies and hosts without the genuine broker keep no-referrer.
    if(brokerFormOrigin&&['GET','HEAD'].includes(c.req.method)
      &&/^text\/html(?:;|$)/i.test(c.res.headers.get('Content-Type')??''))c.header('Referrer-Policy','strict-origin');
    if((c.req.path.startsWith('/api/')||c.req.path.startsWith('/agent-api/')||c.req.path.startsWith('/client-api/')||c.req.path.startsWith('/admin/api/')) && c.res.headers.get('Content-Type')?.includes('application/json')) {
      const data=wireVersions(await c.res.json());
      c.res=new Response(JSON.stringify(data),{status:c.res.status,headers:c.res.headers});
    }
  });
  registerGuideReleaseRoute(app,runtime.publicGuideAssets);
  app.route('/admin/api',createAdminRoutes(pool,runtime.adminVerifier,{origin,tokenKey:runtime.githubTokenKey(),fetcher:options.githubSocial?.fetcher,readToken:runtime.githubMetricsToken,guildReviewer:runtime.guildReviewer},runtime.guildLaunchpadEnabled===true));
  app.route('/',createPublishedSkillRoutes(pool,runtime.publicOrigin,runtime.skillImageAssetStore,runtime.communityDiscoveryEnabled===true));
  app.route('/',createDevelopmentRoutes(id=>publicSocial.cachedMetrics(id),id=>readSkillEditorial(pool,id),async id=>(await skillDiscovery(pool)).books.find(book=>book.book_id===id),runtime.publicOrigin,id=>publicAuthorClaimForBook(pool,id),runtime.communityDiscoveryEnabled===true));
  app.get('/api/v1/health',c=>c.json({status:'ok',mode:freedomEnv,version:packageMetadata.version,money_movement_enabled:false,official:false,...runtime.health,shop_key_policy:shopHost.policy??'unconfigured',shop_key_issuer_profile:shopHost.policy?'freedom.shop-service-key/v1':null}));
  app.get('/api/v1/protocol',c=>c.json(protocolMetadata));
  app.get('/api/v1/site',c=>c.json({brand:'自由工坊',public_mode:freedomEnv==='public',registration_enabled:freedomEnv==='local'||Boolean(runtime.registrationCommunityId()),password_recovery_enabled:Boolean(runtime.passwordEmailSender),demo_accounts_enabled:freedomEnv!=='public',community:communityCatalog,guild_launchpad_enabled:runtime.guildLaunchpadEnabled===true,community_discovery_enabled:runtime.communityDiscoveryEnabled===true,member_blocking_enabled:runtime.memberBlockingEnabled===true,community_search_enabled:runtime.communitySearchEnabled===true,community_relations_enabled:runtime.communitySearchEnabled===true&&runtime.communityRelationsEnabled===true,message_images_enabled:messageImagesInstalled(runtime)}));
  app.get('/api/v1/public/community-discovery',async c=>{
    requireCondition(runtime.communityDiscoveryEnabled===true,404,'not_found','找不到公開內容。');
    return c.json(await publicDiscovery(pool,runtime.registrationCommunityId()));
  });
  app.get('/public-revalidation.js',c=>{
    c.header('Content-Type','text/javascript; charset=utf-8');
    c.header('Cache-Control','no-store');
    return c.body(PUBLIC_REVALIDATION_SCRIPT);
  });
  if(runtime.guildLaunchpadEnabled===true)app.get('/api/v1/guild-categories',async c=>c.json(await listGuildCategories(pool)));
  const searchEnabled:MiddlewareHandler=async(_c,next)=>{
    requireCondition(runtime.communitySearchEnabled===true,404,'not_found','找不到這個頁面。');
    await next();
  };
  app.use('/api/v1/community-search',searchEnabled);
  app.use('/api/v1/community-search/*',searchEnabled);
  app.use('/api/v1/community-relations/*',async(c,next)=>{
    c.header('X-Robots-Tag','noindex, nofollow');
    requireCondition(runtime.communitySearchEnabled===true&&runtime.communityRelationsEnabled===true,404,'not_found','找不到這個頁面。');
    await next();
  });
  if(runtime.communitySearchEnabled===true)app.get('/api/v1/community-search',async c=>{
    let actor:Actor|null=null;
    const session=readSessionCookie(c.req.header('Cookie'),origin);
    if(session){
      try { actor=await authenticate(pool,session); }
      catch(error){
        // Invalid, expired or revoked cookies only have anonymous visibility;
        // database failures must remain failures rather than false empty results.
        if(!(error instanceof Problem&&error.status===401&&['login_required','session_expired'].includes(error.code)))throw error;
      }
    }
    if(actor?.onboarding_required&&!actor.onboarding_completed_at)actor=null;
    return c.json(await searchCommunityContent(pool,actor,c.req.query()));
  });
  app.get('/api/v1/community',c=>c.json(communityCatalog));
  app.get('/api/v1/public/member-cards/:token',async c=>{
    c.header('X-Robots-Tag','noindex, nofollow');
    return c.json(await publicMemberCard(pool,c.req.param('token')));
  });
  app.get('/api/v1/public/member-cards/:token/avatar',async c=>{
    const bytes=await publicMemberAvatar(pool,c.req.param('token'),runtime.avatarAssetStore);
    c.header('Content-Type','image/webp');c.header('X-Robots-Tag','noindex, nofollow');
    c.header('Cache-Control','no-store');c.header('Content-Length',String(bytes.length));
    return c.body(new Uint8Array(bytes));
  });
  app.get('/api/v1/public/events/:id',async c=>{
    const event=await publicEvent(pool,z.uuid().parse(c.req.param('id')));
    if(event.visibility==='referral')c.header('X-Robots-Tag','noindex, nofollow');
    return c.json(event);
  });
  app.get('/api/v1/public/events/:id/banner',async c=>{
    const bytes=await publicEventBanner(pool,z.uuid().parse(c.req.param('id')),runtime.eventBannerAssetStore);
    c.header('Content-Type','image/webp');c.header('Cache-Control','public, max-age=300');c.header('Cross-Origin-Resource-Policy','same-origin');
    return c.body(new Uint8Array(bytes));
  });
  app.get('/api/v1/public/events/:id/video',async c=>eventAssetVideoResponse(c,pool,z.uuid().parse(c.req.param('id')),runtime.eventVideoAssetStore));
  registerPublicPromotion(app,pool,runtime,origin);
  registerPublicMemberServices(app,pool,runtime);
  app.route('/',createEventHighlightPublicRoutes(pool,runtime.publicOrigin,runtime));
  app.post('/api/v1/public/events/:id/register',async c=>{
    requireCondition(runtime.eventEmailSender,503,'event_email_unavailable','活動郵件服務暫時無法使用。');
    const body=await c.req.json();
    const email=z.email().max(200).parse(body?.email).trim().toLowerCase();
    await authRateLimit(pool,'event-register-network',authNetwork(c),10,3600);
    await authRateLimit(pool,'event-register-email',email,3,3600);
    await authRateLimit(pool,'event-register-global','global',300,3600);
    return c.json(await registerPublicEvent(pool,z.uuid().parse(c.req.param('id')),body,runtime.eventEmailSender,origin));
  });
  app.get('/api/v1/pages/github-activity',async c=>c.json(await pageGitHub.read(c.req.query('page'),c.req.query('refresh')==='1')));
  app.get('/api/v1/pages/github-events',async c=>c.json(await pageGitHubEvents.read()));
  app.route('/api/v1',createGitHubMetricsRoutes(async()=>publicSocial));
  app.route('/api/v1',createPublicAuthorClaimRoutes(pool));
  app.route('/api/v1',createSkillDiscoveryRoutes(pool));
  app.route('/api/v1',createPublicClientConnectionRoutes(pool,origin,authNetwork));
  app.route('/client-api/v1',createClientApiRoutes(pool));
  app.route('/shop-api/v1',createShopMachineRoutes(pool,shopHost));
  app.route('/',createPublicShopRoutes(pool));
  app.route('/agent-api/v1',createAgentSkillSubmissionRoutes(pool,origin,authNetwork,runtime));
  app.route('/development-agent/v1',createDevelopmentAgentRoutes(pool,loadSocial,authNetwork));
  app.post('/api/v1/auth/register',async c=>{
    await authRateLimit(pool,'registration-network',authNetwork(c),8);
    await authRateLimit(pool,'registration-global','global',100,60);
    const raw=await c.req.json();
    const result=await registerMember(pool,raw,{communityId:runtime.registrationCommunityId(),allowSingleCommunity:freedomEnv==='local',publicMode:freedomEnv==='public'});
    const old=readSessionCookie(c.req.header('Cookie'),origin);
    if(old) {const {tokenHash}=await import('../../../modules/identity-membership/service.js');await pool.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1',[tokenHash(old)]);}
    setCookie(c,COOKIE,result.token,{httpOnly:true,sameSite:'Strict',secure:secureCookies,path:'/',maxAge:SESSION_LIFETIME_SECONDS});
    return c.json(sessionView(result.actor),201);
  });
  app.post('/api/v1/auth/login',async c=>{
    await authRateLimit(pool,'login-network',authNetwork(c),60);
    await authRateLimit(pool,'login-global','global',240,60);
    const body=z.object({email:z.email().max(200),password:z.string().min(1).max(200)}).strict().parse(await c.req.json());
    const result=await login(pool,body.email,body.password);
    // Replace any old session on login, so changing accounts never keeps an active old cookie.
    const old=readSessionCookie(c.req.header('Cookie'),origin);
    if(old) { const {tokenHash}=await import('../../../modules/identity-membership/service.js');await pool.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1',[tokenHash(old)]); }
    setCookie(c,COOKIE,result.token,{httpOnly:true,sameSite:'Strict',secure:secureCookies,path:'/',maxAge:SESSION_LIFETIME_SECONDS});
    return c.json(sessionView(result.actor));
  });
  app.post('/api/v1/auth/reset/request',async c=>{
    requireCondition(runtime.passwordEmailSender,503,'password_recovery_unavailable','忘記密碼服務尚未設定完成。');
    const body=z.object({email:z.email().max(200)}).strict().parse(await c.req.json());
    const email=body.email.trim().toLowerCase();
    await authRateLimit(pool,'password-reset-network',authNetwork(c),12,3600);
    await authRateLimit(pool,'password-reset-global','global',500,3600);
    await authRateLimit(pool,'password-reset-email',email,3,3600);
    await requestPasswordReset(pool,email,origin,runtime.passwordEmailSender);
    return c.json({requested:true,message:'若此信箱有可用帳號，且寄送服務正常，重設連結會寄到信箱。'});
  });
  app.post('/api/v1/auth/reset/confirm',async c=>{
    requireCondition(runtime.passwordEmailSender,503,'password_recovery_unavailable','忘記密碼服務尚未設定完成。');
    await authRateLimit(pool,'password-reset-confirm-network',authNetwork(c),30,3600);
    await authRateLimit(pool,'password-reset-confirm-global','global',500,3600);
    const body=z.object({token:z.string().max(100),password:z.string().max(128)}).strict().parse(await c.req.json());
    const old=readSessionCookie(c.req.header('Cookie'),origin);
    const result=await confirmPasswordReset(pool,body.token,body.password);
    // Replace any old session on reset, so changing accounts never keeps an active old cookie.
    if(old) { const {tokenHash}=await import('../../../modules/identity-membership/service.js');await pool.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1',[tokenHash(old)]); }
    setCookie(c,COOKIE,result.token,{httpOnly:true,sameSite:'Strict',secure:secureCookies,path:'/',maxAge:SESSION_LIFETIME_SECONDS});
    return c.json({reset:result.reset,expires_after_minutes:result.expires_after_minutes,...sessionView(result.actor)});
  });
  app.route('/',createMaintainerWebhookRoutes(pool,runtime.maintainerWebhookSecret));
  if(runtime.guildLaunchpadEnabled===true)app.route('/',createPublicGuildLaunchpadRoutes(pool));
  if(runtime.guildLaunchpadEnabled===true){
    app.route('/',createPublicModuleRegistryRoutes(pool,origin));
    app.route('/',createPublicHostedStoreRoutes(pool));
  }
  for (const path of ['/api/v1/hosted-stores/*', '/api/v1/me/hosted-orders/*', '/api/v1/tenants/:tenant_id/storefronts/:instance_id/orders', '/api/v1/tenants/:tenant_id/storefronts/:instance_id/orders/*']) app.use(path, async (c, next) => {
    try { await next(); } finally { hostedOrderPrivateCache(c); }
  });
  app.use('/api/v1/*',memberBoundary(pool,origin,onboardingAllowed));
  app.route('/api/v1', createHostedOrderRoutes(pool, { discoveryInstalled: runtime.guildLaunchpadEnabled === true, admissionEnabled: runtime.hostedReservationsEnabled === true, cursors: runtime.tenantListCursors }));
  const cmd=async(c:any):Promise<Command>=>{
    const ifMatch=c.req.header('If-Match') as string|undefined;
    if(ifMatch) requireCondition(/^"[1-9][0-9]*"$/.test(ifMatch),400,'invalid_version','If-Match 須為加引號的整數版本。');
    return {actor:c.get('actor'),operation:`${c.req.method} ${c.req.path}`,key:c.req.header('Idempotency-Key')??'',body:await c.req.json(),expected:ifMatch?.slice(1,-1)};
  };
  const routeId=(c:any,name='id')=>z.uuid().parse(c.req.param(name).split(':')[0]);
  const respond=(c:any,value:any,status=200)=>{if(value?.aggregate_version)c.header('ETag',`"${value.aggregate_version}"`);return c.json(value,status);};
  if(runtime.communitySearchEnabled===true){
    app.get('/api/v1/community-search/mine',async c=>c.json(await listTaggableContent(pool,c.get('actor'))));
    app.post('/api/v1/community-search/topics',async c=>respond(c,await assignContentTopics(pool,await cmd(c))));
  }
  if(runtime.communitySearchEnabled===true&&runtime.communityRelationsEnabled===true){
    app.get('/api/v1/community-relations/bookmarks',async c=>c.json(await listCommunityBookmarks(pool,c.get('actor'),c.req.query())));
    app.post('/api/v1/community-relations/bookmarks',async c=>respond(c,await changeCommunityBookmark(pool,await cmd(c))));
    app.get('/api/v1/community-relations/follows',async c=>c.json(await listCommunityFollows(pool,c.get('actor'))));
    app.post('/api/v1/community-relations/follows',async c=>respond(c,await changeCommunityFollow(pool,await cmd(c))));
    app.get('/api/v1/community-relations/updates',async c=>c.json(await listCommunityFollowUpdates(pool,c.get('actor'),c.req.query())));
  }
  app.get('/api/v1/session',c=>c.json(sessionView(c.get('actor'))));
  app.post('/api/v1/me/client-errors',async c=>{
    const body=z.object({action:z.string().regex(/^(GET|POST|PUT|PATCH|DELETE|UI) \/[a-zA-Z0-9_/:.#-]*$/).max(120),error_code:z.string().regex(/^[a-zA-Z0-9_:-]{1,80}$/),http_status:z.number().int().min(0).max(599).optional()}).strict().parse(await c.req.json());
    const actor=c.get('actor');
    const recent=await pool.query('SELECT count(*)::int AS n FROM member_client_errors WHERE user_id=$1 AND created_at>clock_timestamp()-interval \'1 minute\'',[actor.user_id]);
    requireCondition(recent.rows[0].n<20,429,'error_log_rate_limited','錯誤回報過於頻繁。');
    await pool.query('INSERT INTO member_client_errors(community_id,user_id,action,error_code,http_status) VALUES($1,$2,$3,$4,$5)',[actor.community_id,actor.user_id,body.action,body.error_code,body.http_status??null]);
    return c.json({recorded:true},201);
  });
  app.post('/api/v1/auth/logout',async c=>{await pool.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1',[c.get('actor').session_hash]);deleteCookie(c,COOKIE,{path:'/',secure:secureCookies,httpOnly:true,sameSite:'Strict'});return c.json({logged_out:true});});
  app.get('/api/v1/work-items',async c=>c.json({items:await listWorks(pool,c.get('actor'))}));
  app.route('/api/v1',createPrivateWorkRoutes(pool));
  app.post('/api/v1/work-items',async c=>respond(c,await createWork(pool,await cmd(c)),201));
  // Action suffix is part of the constrained segment; validate its UUID separately.
  app.post('/api/v1/work-items/:id{[0-9a-f-]+:claim}',async c=>respond(c,await claimWork(pool,await cmd(c),routeId(c)),201));
  for(const action of ['start','submit','begin-review','decide'] as const) {
    app.post(`/api/v1/work-claims/:id{[0-9a-f-]+:${action}}`,async c=>respond(c,await changeClaim(pool,await cmd(c),routeId(c),action)));
  }
  app.get('/api/v1/dashboard',async c=>c.json(await dashboard(pool,c.get('actor'))));
  app.get('/api/v1/task-board/preview',async c=>c.json({items:await previewTasks(pool,c.get('actor'))}));
  app.get('/api/v1/me/contribution-records',async c=>c.json(await contributionRecords(pool,c.get('actor'))));
  app.get('/api/v1/community/accepted-work',async c=>c.json({items:await acceptedWorkFeed(pool,c.get('actor'))}));
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
  app.route('/api/v1',createMemberCommunicationRoutes(pool,runtime,runtime.memberBlockingEnabled===true));
  app.route('/api/v1',createCommunityEventRoutes(pool,runtime.eventEmailSender,origin,runtime));
  registerMemberPromotion(app,pool,runtime);
  registerMemberServices(app,pool,runtime);
  app.route('/api/v1',createEventHighlightMemberRoutes(pool,runtime));
  app.route('/api/v1',createGitHubSocialRoutes(loadSocial));
  app.route('/api/v1',createMemberAuthorClaimRoutes(pool,options.githubSocial?.fetcher??globalThis.fetch,runtime.githubMetricsToken));
  app.route('/api/v1',createDevelopmentAccessRoutes(pool,loadSocial));
  app.route('/api/v1',createGuildWorkspaceRoutes(pool));
  if(runtime.guildLaunchpadEnabled===true)app.route('/api/v1',createGuildLaunchpadRoutes(pool));
  app.route('/api/v1',createRepoMaintainerMemberRoutes(pool));
  app.route('/api/v1',createAvatarRoutes(pool,runtime.avatarAssetStore));
  app.route('/api/v1',createClientConnectionRoutes(pool));
  app.route('/api/v1',createSkillSubmissionRoutes(pool,origin,runtime.githubMetricsToken,runtime));
  app.route('/api/v1',createPositioningRoutes(pool,{guildLaunchpadEnabled:runtime.guildLaunchpadEnabled===true}));
  app.route('/api/v1',createCommerceRoutes(pool));
  app.route('/api/v1',createAgentCommerceRoutes(pool,origin,shopHost));
  app.route('/api/v1', createOpenSourceRoutes(pool,runtime.githubMetricsToken,loadSocial));
  app.route('/api/v1',createCoCreationRoutes(pool,options.coCreationGitHub));
  app.route('/api/v1',createBenefitRoutes(pool));
  if(runtime.guildLaunchpadEnabled===true){
    app.route('/api/v1',createTenantWorkspaceRoutes(pool));
    app.route('/api/v1',createModuleRegistryRoutes(pool,runtime.moduleProviders,runtime.tenantListCursors));
    app.route('/api/v1',createTenantWorkRoutes(pool,runtime.tenantWorkAssetStore,runtime.tenantListCursors));
    app.route('/api/v1',createHostedStoreRoutes(pool));
  }
  // Unknown machine paths answer JSON 404 before any host serves the browser shell.
  for(const prefix of ['/api/*','/client-api/*','/agent-api/*','/development-agent/*','/shop-api/*'])app.all(prefix,c=>c.json({type:'about:blank',title:'Not found',status:404,code:'not_found',detail:'此版本尚未提供這個 API。'},404));
  return app;
}
