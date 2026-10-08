import { installWorkerGuideAssets } from '../../../packages/public-guide-assets/worker.js';
import type { GuideR2Binding } from '../../../packages/public-guide-assets/r2.js';
import {createEventHighlightAssetService,resolveEventHighlightUploadPolicy} from '../../../modules/assets/event-highlight.js';
import {createSocialThumbnailAssetService,resolveSocialThumbnailUploadPolicy} from '../../../modules/assets/social-thumbnail.js';
import {createSkillImageAssetService} from '../../../modules/assets/skill-image.js';
import type { ExecutionContext, Hyperdrive, ImagesBinding as OfficialImagesBinding } from '@cloudflare/workers-types';
import type { Context, Hono } from 'hono';
import { isIP } from 'node:net';
import type { Pool } from 'pg';
import { createRequestPool } from '../../../packages/db/index.js';
import { createR2ObjectStore, type AssetR2Binding } from '../../../packages/asset-storage/r2.js';
import { Problem } from '../../../packages/shared/problem.js';
import { createUnavailableImageProcessor, runWithImageProcessor } from '../../../packages/shared/image-runtime.js';
import { createCloudflareImageProcessor, type ImagesBinding } from '../../../packages/shared/image-cloudflare.js';
import { createAdminAccessVerifier, type AdminAccessVerifier } from '../../../modules/platform-admin/access.js';
import { assertOriginAllowed, resolveFreedomEnv, type FreedomEnv } from './env.js';
import { createPlatformApp, isMemberCardPage } from './platform-app.js';
import { assertDatabaseReady, ReadinessError } from './readiness.js';
import { SHARED_NETWORK_KEY, type PlatformRuntime } from './runtime.js';
import { GITHUB_SYNC_REQUEST_BUDGET, syncGitHubRepositories } from '../../../modules/community/github-sync.js';
import {refreshGuildDiscoveryReports} from '../../../modules/community/guild-discovery.js';
import {pruneExpiredAuthRecords} from '../../../modules/identity-membership/auth-pruning.js';
import {processEventWaitlist} from '../../../modules/community/event-waitlist.js';
import {processEventReminders} from '../../../modules/community/event-reminders.js';
import {createEventVideoAssetService,resolveEventVideoUploadPolicy} from '../../../modules/assets/event-video.js';
import {createEventBannerAssetService,resolveEventBannerUploadPolicy} from '../../../modules/assets/event-banner.js';
import {createServiceCoverAssetService,resolveServiceCoverUploadPolicy} from '../../../modules/assets/media-domain.js';
import { workerPrivateAiPorts,type WorkerPrivateAiBindings } from './worker-private-ai.js';
import {guildReviewerFromBindings,type GuildReviewBindings} from './guild-review.js';
import {sweepDueOperations} from '../../../modules/module-registry/operations.js';
import { workerPreviewFetch } from './worker-preview-fetch.js';

/**
 * Cloudflare Worker adapter. Bindings contract (see wrangler.jsonc):
 * - HYPERDRIVE: the single Hyperdrive binding for all platform data. It MUST be a
 *   configuration created with caching disabled (`--caching-disabled`), because
 *   sessions, CSRF, rate limits and grants are read-your-writes. Nothing in this
 *   code or its config can disable provider caching; the infrastructure owner
 *   creates and preflights it.
 * - ASSETS: the built browser app (apps/portal-web/dist), with run_worker_first.
 * - IMAGES (optional): Cloudflare Images binding that decodes and re-encodes uploads.
 *   Without it only image mutations answer 503; everything else keeps working.
 * - MEDIA (optional): private native R2 binding for asset-backed avatars. Absence
 *   never enables a legacy fallback or GC; legacy avatars keep their current path.
 * Secrets arrive as bindings and are only passed into explicit per-request
 * options; process.env is never read or written here.
 */
export interface WorkerEnv extends GuildReviewBindings,WorkerPrivateAiBindings {
  /** Explicit cover composition; native MEDIA alone grants no persistence. */
  FREEDOM_SERVICE_COVER_ENABLED?: string;
  /** Explicit banner composition; canonical community policy remains required. */
  FREEDOM_EVENT_BANNER_ENABLED?: string;
  FREEDOM_EVENT_VIDEO_ENABLED?: string;
  FREEDOM_SKILL_IMAGE_ENABLED?: string;
  FREEDOM_SOCIAL_THUMBNAIL_ENABLED?: string;
  FREEDOM_EVENT_HIGHLIGHT_ENABLED?: string;
  HYPERDRIVE: { readonly connectionString: string };
  ASSETS: { fetch(request: Request): Promise<Response> };
  IMAGES?: ImagesBinding;
  MEDIA?: AssetR2Binding;
  /** Separate private-origin bucket, read-only purpose-specific public asset path. */
  GUIDE_STATIC?: GuideR2Binding;
  FREEDOM_PUBLIC_GUIDE_ENABLED?: string;
  EMAIL?: {send(message:{to:string;from:string;subject:string;text:string}):Promise<{messageId:string}>};
  FREEDOM_SHOP_KEY_POLICY?: 'legacy-compatible'|'purpose-bound-only';
  FREEDOM_GUILD_LAUNCHPAD_ENABLED?: string;
  FREEDOM_COMMUNITY_DISCOVERY_ENABLED?: string;
  FREEDOM_COMMUNITY_SEARCH_ENABLED?: string;
  FREEDOM_COMMUNITY_RELATIONS_ENABLED?: string;
  FREEDOM_PERSONAL_CONTENT_ENABLED?: string;
  FREEDOM_UNIFIED_SHARING_ENABLED?: string;
  FREEDOM_NOTIFICATION_PREFERENCES_ENABLED?: string;
  FREEDOM_EVENT_PARTICIPATION_ENABLED?: string;
  FREEDOM_SQUAD_OUTCOMES_ENABLED?: string;
  FREEDOM_EVENT_OUTCOMES_ENABLED?: string;
  FREEDOM_FIRST_PARTICIPATION_ENABLED?: string;
  FREEDOM_PARTICIPATION_METRICS_ENABLED?: string;
  FREEDOM_ENV?: string;
  APP_ORIGIN?: string;
  /** Git commit deployed, 40 lowercase hex; required outside local. */
  FREEDOM_RELEASE_SHA?: string;
  FREEDOM_DATABASE_NAME?: string;
  FREEDOM_REGISTRATION_COMMUNITY_ID?: string;
  /** "true" only on deployed staging/public custom domains; rejected in local. */
  FREEDOM_TRUST_CF_CONNECTING_IP?: string;
  FREEDOM_ADMIN_ACCESS_ISSUER?: string;
  FREEDOM_ADMIN_ACCESS_AUD?: string;
  FREEDOM_ADMIN_CSRF_SECRET?: string;
  GITHUB_SOCIAL_TOKEN_KEY?: string;
  /** Optional read-only GitHub token: Workers share egress IPs, so anonymous GitHub quota is gone. */
  GITHUB_METRICS_TOKEN?: string;
  /** Optional. Without it only POST /api/v1/maintainer/github/webhook answers 503. */
  GITHUB_MAINTAINER_WEBHOOK_SECRET?: string;
  FREEDOM_PASSWORD_RESET_EMAIL_ENABLED?: string;
}
export type WorkerContext = { waitUntil(promise: Promise<unknown>): void; passThroughOnException?(): void };
// Compile-time proof that the official binding types satisfy these structural ones.
type Satisfies<T extends true> = T;
export type OfficialBindingsFit = Satisfies<Hyperdrive extends WorkerEnv['HYPERDRIVE'] ? ExecutionContext extends WorkerContext ? true : false : false>;
// workers-types declares its own ReadableStream, which never unifies with the Node lib
// stream in this compilation, so only the Images method names are checked here.
export type OfficialImagesFit = Satisfies<keyof ImagesBinding extends keyof OfficialImagesBinding ? true : false>;
export type WorkerConfig = { freedomEnv: FreedomEnv; origin: string; release: string | null; trustConnectingIp: boolean };

const RELEASE = /^[0-9a-f]{40}$/;
/** Validates bindings without I/O. Errors never echo binding values. */
export function readWorkerConfig(env: WorkerEnv): WorkerConfig {
  if (typeof env.FREEDOM_ENV !== 'string' || !env.FREEDOM_ENV.trim()) throw new ReadinessError('FREEDOM_ENV binding is required.');
  let freedomEnv: FreedomEnv;
  try { freedomEnv = resolveFreedomEnv(env.FREEDOM_ENV); } catch { throw new ReadinessError('FREEDOM_ENV binding is invalid.'); }
  if(env.FREEDOM_SHOP_KEY_POLICY!==undefined&&!['legacy-compatible','purpose-bound-only'].includes(env.FREEDOM_SHOP_KEY_POLICY))throw new ReadinessError('FREEDOM_SHOP_KEY_POLICY is invalid.');
  const origin = env.APP_ORIGIN ?? '';
  try { assertOriginAllowed(freedomEnv, origin); } catch { throw new ReadinessError('APP_ORIGIN binding is invalid for this environment.'); }
  const release = env.FREEDOM_RELEASE_SHA || null;
  if (release !== null && !RELEASE.test(release)) throw new ReadinessError('FREEDOM_RELEASE_SHA must be a full commit SHA.');
  if (freedomEnv !== 'local' && release === null) throw new ReadinessError('FREEDOM_RELEASE_SHA is required outside local.');
  const trustConnectingIp = env.FREEDOM_TRUST_CF_CONNECTING_IP === 'true';
  if (env.FREEDOM_TRUST_CF_CONNECTING_IP !== undefined && !['true', 'false'].includes(env.FREEDOM_TRUST_CF_CONNECTING_IP)) throw new ReadinessError('FREEDOM_TRUST_CF_CONNECTING_IP must be true or false.');
  if (trustConnectingIp && freedomEnv === 'local') throw new ReadinessError('Local Workers never trust client address headers.');
  if (typeof env.HYPERDRIVE?.connectionString !== 'string' || !env.HYPERDRIVE.connectionString) throw new ReadinessError('HYPERDRIVE binding is required.');
  if (typeof env.ASSETS?.fetch !== 'function') throw new ReadinessError('ASSETS binding is required.');
  if (env.FREEDOM_PASSWORD_RESET_EMAIL_ENABLED !== undefined && !['true','false'].includes(env.FREEDOM_PASSWORD_RESET_EMAIL_ENABLED)) throw new ReadinessError('FREEDOM_PASSWORD_RESET_EMAIL_ENABLED must be true or false.');
  if (env.FREEDOM_PASSWORD_RESET_EMAIL_ENABLED === 'true' && typeof env.EMAIL?.send !== 'function') throw new ReadinessError('EMAIL binding is required when password recovery is enabled.');
  if(env.FREEDOM_EVENT_PARTICIPATION_ENABLED!==undefined&&!['true','false'].includes(env.FREEDOM_EVENT_PARTICIPATION_ENABLED))throw new ReadinessError('FREEDOM_EVENT_PARTICIPATION_ENABLED must be true or false.');
  if(env.FREEDOM_EVENT_PARTICIPATION_ENABLED==='true'&&typeof env.EMAIL?.send!=='function')throw new ReadinessError('EMAIL binding is required when event participation is enabled.');
  for(const flag of [env.FREEDOM_SQUAD_OUTCOMES_ENABLED,env.FREEDOM_EVENT_OUTCOMES_ENABLED]){
    if(flag!==undefined&&!['true','false'].includes(flag))throw new ReadinessError('Outcome publication flag must be true or false.');
  }
  if(env.FREEDOM_EVENT_OUTCOMES_ENABLED==='true'&&env.FREEDOM_SQUAD_OUTCOMES_ENABLED!=='true')throw new ReadinessError('Event outcomes require squad outcomes to expose all canonical sources.');
  if(env.FREEDOM_PARTICIPATION_METRICS_ENABLED!==undefined&&!['true','false'].includes(env.FREEDOM_PARTICIPATION_METRICS_ENABLED))throw new ReadinessError('Participation metrics flag must be true or false.');
  if(env.FREEDOM_FIRST_PARTICIPATION_ENABLED!==undefined&&!['true','false'].includes(env.FREEDOM_FIRST_PARTICIPATION_ENABLED))throw new ReadinessError('First participation flag must be true or false.');
  if(env.FREEDOM_FIRST_PARTICIPATION_ENABLED==='true'&&env.FREEDOM_PERSONAL_CONTENT_ENABLED!=='true')throw new ReadinessError('First participation requires personal content.');
  for(const flag of [env.FREEDOM_SERVICE_COVER_ENABLED,env.FREEDOM_EVENT_BANNER_ENABLED,env.FREEDOM_SKILL_IMAGE_ENABLED,env.FREEDOM_SOCIAL_THUMBNAIL_ENABLED,env.FREEDOM_EVENT_HIGHLIGHT_ENABLED]){
    if(flag!==undefined&&!['true','false'].includes(flag))throw new ReadinessError('Media installation flag must be true or false.');
    if(flag==='true'&&(['get','put','head','delete'].some(method=>typeof (env.MEDIA as unknown as Record<string,unknown>|undefined)?.[method]!=='function')||typeof env.IMAGES?.info!=='function'||typeof env.IMAGES?.input!=='function'))throw new ReadinessError('MEDIA and IMAGES are required for enabled image lifecycle.');
  }
  if(env.FREEDOM_EVENT_VIDEO_ENABLED!==undefined&&!['true','false'].includes(env.FREEDOM_EVENT_VIDEO_ENABLED))throw new ReadinessError('Video installation flag must be true or false.');
  if(env.FREEDOM_EVENT_VIDEO_ENABLED==='true'&&(['get','put','head','delete'].some(method=>typeof (env.MEDIA as unknown as Record<string,unknown>|undefined)?.[method]!=='function')))throw new ReadinessError('MEDIA is required for enabled video lifecycle.');
  if(env.FREEDOM_PUBLIC_GUIDE_ENABLED!==undefined&&!['true','false'].includes(env.FREEDOM_PUBLIC_GUIDE_ENABLED))throw new ReadinessError('Guide release flag must be true or false.');
  if(env.GUIDE_STATIC&&env.GUIDE_STATIC===env.MEDIA)throw new ReadinessError('Guide assets require a separate purpose binding.');
  if(env.FREEDOM_PUBLIC_GUIDE_ENABLED==='true'&&typeof env.GUIDE_STATIC?.get!=='function')throw new ReadinessError('GUIDE_STATIC is required for public guide assets.');
  return { freedomEnv, origin, release, trustConnectingIp };
}

/**
 * Rate-limit key for an address that already passed `isIP`. IPv6 collapses to its /64,
 * since one subscriber usually holds the whole prefix; only a true IPv4-mapped address
 * (::ffff:a.b.c.d, first 80 bits zero) keeps its IPv4 budget, so a host inside some /64
 * cannot mint IPv4 keys by choosing its last 32 bits.
 */
export function rateLimitNetworkKey(address: string): string {
  if (isIP(address) === 4) return address;
  const bare = address.split('%')[0].toLowerCase();
  // A trailing dotted quad is the last two hextets written in decimal.
  const quad = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  const hex = quad ? `${bare.slice(0, -quad[0].length)}${((+quad[1] << 8) | +quad[2]).toString(16)}:${((+quad[3] << 8) | +quad[4]).toString(16)}` : bare;
  const [left, right] = hex.includes('::') ? hex.split('::') : [hex, undefined];
  const l = left ? left.split(':') : [], r = right ? right.split(':') : [];
  const hextets = right === undefined ? l : [...l, ...Array(8 - l.length - r.length).fill('0'), ...r];
  if (hextets.length !== 8) return address;
  const words = hextets.map(h => parseInt(h, 16));
  // ::ffff:0:0/96 in either notation is an IPv4 client.
  if (words.slice(0, 5).every(w => w === 0) && words[5] === 0xffff) return [words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255].join('.');
  return `${words.slice(0, 4).map(w => w.toString(16)).join(':')}::/64`;
}

/**
 * Cloudflare's edge sets CF-Connecting-IP on requests to a custom domain, replacing
 * any client-supplied value. workerd, `wrangler dev` and Miniflare pass inbound
 * headers through and fabricate `request.cf`, so neither the header nor `cf` proves
 * an edge request. The header is therefore used only when the deployment opted in
 * (non-local env, explicit binding), the request carries `cf`, and the worker
 * already required Host to equal the configured custom-domain origin. Otherwise
 * every client shares one conservative key. X-Forwarded-For is never read.
 * Keep the full address for existing non-limiter consumers such as promotion scoring.
 */
export function cloudflareSourceNetwork(trustConnectingIp: boolean) {
  return (c: Context): string => {
    if (!trustConnectingIp || !(c.req.raw as Request & { cf?: unknown }).cf) return SHARED_NETWORK_KEY;
    const address = c.req.header('CF-Connecting-IP')?.trim() ?? '';
    return isIP(address) ? address : SHARED_NETWORK_KEY;
  };
}

/** Group only request budgets; never replace the visitor identity with a prefix. */
export function cloudflareRateLimitNetwork(trustConnectingIp: boolean) {
  const sourceNetwork = cloudflareSourceNetwork(trustConnectingIp);
  return (c: Context): string => {
    const address = sourceNetwork(c);
    return isIP(address) ? rateLimitNetworkKey(address) : SHARED_NETWORK_KEY;
  };
}

/** Built from this request's bindings; missing or invalid settings fail closed. */
export function workerAdminVerifier(env: WorkerEnv): AdminAccessVerifier {
  const issuer = env.FREEDOM_ADMIN_ACCESS_ISSUER ?? '', audience = env.FREEDOM_ADMIN_ACCESS_AUD ?? '', csrfSecret = env.FREEDOM_ADMIN_CSRF_SECRET ?? '';
  const unavailable: AdminAccessVerifier = async () => { throw new Problem(503, 'admin_not_configured', '管理員登入尚未設定完成。'); };
  if (!issuer || !audience || csrfSecret.length < 32) return unavailable;
  try { return createAdminAccessVerifier({ issuer, audience, csrfSecret }); } catch { return unavailable; }
}

export function workerRuntime(env: WorkerEnv, config: WorkerConfig): PlatformRuntime {
  const community = env.FREEDOM_REGISTRATION_COMMUNITY_ID || undefined, tokenKey = env.GITHUB_SOCIAL_TOKEN_KEY || undefined;
  const metricsToken = env.GITHUB_METRICS_TOKEN || undefined;
  const maintainerWebhookSecret = env.GITHUB_MAINTAINER_WEBHOOK_SECRET || undefined;
  let avatarAssetStore: PlatformRuntime['avatarAssetStore'];
  // Optional storage failure is scoped to asset operations, not login/health.
  // This request captures only its own binding. App ports cannot delete objects.
  try { if (env.MEDIA) avatarAssetStore = createR2ObjectStore(env.MEDIA); } catch { /* unavailable, no binding diagnostics */ }
  return {
    avatarAssetStore,
    shopKeyPolicy:env.FREEDOM_SHOP_KEY_POLICY,
    registrationCommunityId: () => community,
    githubTokenKey: () => tokenKey,
    githubMetricsToken: () => metricsToken,
    maintainerWebhookSecret: () => maintainerWebhookSecret,
    adminVerifier: workerAdminVerifier(env),
    sourceNetwork: cloudflareSourceNetwork(config.trustConnectingIp),
    rateLimitNetwork: cloudflareRateLimitNetwork(config.trustConnectingIp),
    allowedHosts: new Set([new URL(config.origin).hostname]),
    // Every Worker links, canonicalizes and documents its own configured origin;
    // only the existing Node deployments keep the live-site default.
    publicOrigin: config.origin,
    guildReviewer: guildReviewerFromBindings(env),
    passwordEmailSender:env.FREEDOM_PASSWORD_RESET_EMAIL_ENABLED==='true'&&env.EMAIL
      ?async(to,url)=>{await env.EMAIL!.send({to,from:'no-reply@mail.freetwai.com',subject:'自由工坊：重設密碼',text:`有人申請重設自由工坊帳號的密碼。\n\n請在 30 分鐘內開啟以下連結：\n${url}\n\n若不是你提出申請，請忽略此信。`});}
      :undefined,
    eventEmailSender:env.EMAIL?async(to,subject,text)=>{await env.EMAIL!.send({to,from:'no-reply@mail.freetwai.com',subject,text});}:undefined,
    health: { runtime: 'cloudflare-workers', release_sha: config.release },
    linkPreviewFetch: workerPreviewFetch,
    moduleProviders: undefined,
    guildLaunchpadEnabled: env.FREEDOM_GUILD_LAUNCHPAD_ENABLED === 'true',
    communityDiscoveryEnabled: env.FREEDOM_COMMUNITY_DISCOVERY_ENABLED === 'true',
    communitySearchEnabled: env.FREEDOM_COMMUNITY_SEARCH_ENABLED === 'true',
    communityRelationsEnabled: env.FREEDOM_COMMUNITY_RELATIONS_ENABLED === 'true',
    personalContentEnabled: env.FREEDOM_PERSONAL_CONTENT_ENABLED === 'true',
    unifiedSharingEnabled: env.FREEDOM_UNIFIED_SHARING_ENABLED === 'true',
    notificationPreferencesEnabled: env.FREEDOM_NOTIFICATION_PREFERENCES_ENABLED === 'true',
    eventParticipationEnabled: env.FREEDOM_EVENT_PARTICIPATION_ENABLED === 'true',
    squadOutcomesEnabled: env.FREEDOM_SQUAD_OUTCOMES_ENABLED === 'true',
    eventOutcomesEnabled: env.FREEDOM_EVENT_OUTCOMES_ENABLED === 'true',
    firstParticipationEnabled: env.FREEDOM_FIRST_PARTICIPATION_ENABLED === 'true',
    participationMetricsEnabled: env.FREEDOM_PARTICIPATION_METRICS_ENABLED === 'true',
    tenantWorkAssetStore: env.FREEDOM_GUILD_LAUNCHPAD_ENABLED === 'true' && avatarAssetStore ? avatarAssetStore : undefined,
  };
}

const SAFE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'" };
function problem(status: number, code: string, detail: string) {
  return Response.json({ type: 'about:blank', title: code, status, code, detail }, { status, headers: SAFE_HEADERS });
}
// Security headers from the platform middleware win over asset metadata, like the Node static server.
const ASSET_OVERRIDDEN = new Set(['cache-control', 'content-security-policy', 'x-content-type-options', 'referrer-policy', 'set-cookie']);
function fromAsset(c: Context, asset: Response) {
  const headers: Record<string, string> = {};
  for (const [name, value] of asset.headers) if (!ASSET_OVERRIDDEN.has(name.toLowerCase())) headers[name] = value;
  if (isMemberCardPage(new URL(c.req.url).pathname)) headers['X-Robots-Tag'] = 'noindex, nofollow';
  return c.body(asset.body as ReadableStream, asset.status as 200, headers);
}
/** Same order as server.ts: files after every app route, then the browser shell for GET navigation. */
export function mountAssets(app: Hono<any>, assets: WorkerEnv['ASSETS']) {
  app.use('/*', async (c, next) => {
    if (!['GET', 'HEAD'].includes(c.req.method)) return next();
    const asset = await assets.fetch(c.req.raw);
    if (asset.status === 404) return next();
    return fromAsset(c, asset);
  });
  app.get('*', async c => {
    const shell = await assets.fetch(new Request(new URL('/', c.req.url), { method: c.req.method, headers: { Accept: 'text/html' } }));
    return shell.status === 200 ? fromAsset(c, shell) : c.notFound();
  });
}

export type WorkerDependencies = {
  createPool?: (env: WorkerEnv) => Pool;
  /** Request-scoped wrapper for host services (the image processor attaches here). */
  scope?: (env: WorkerEnv, run: () => Promise<Response>) => Promise<Response>;
  /** Test seam. Production uses syncGitHubRepositories. */
  syncGitHub?: typeof syncGitHubRepositories;
  githubFetcher?: typeof fetch;
  guildDiscovery?: typeof refreshGuildDiscoveryReports;
  /** Test seam. Production uses pruneExpiredAuthRecords. */
  authPrune?: typeof pruneExpiredAuthRecords;
};

/**
 * Default request scope: this request's IMAGES binding decodes uploads. Without the
 * binding, image mutations refuse with 503 image_processing_unavailable while every
 * other route, login and static file keeps working. The bundle aliases `sharp` to a
 * fail-closed stub (wrangler.jsonc), so the Node default processor never runs here.
 */
export function workerScope(env: WorkerEnv, run: () => Promise<Response>): Promise<Response> {
  return runWithImageProcessor(env.IMAGES ? createCloudflareImageProcessor(env.IMAGES) : createUnavailableImageProcessor(), run);
}

export function createWorkerHandler(deps: WorkerDependencies = {}) {
  const createPool = deps.createPool ?? (env => createRequestPool(env.HYPERDRIVE.connectionString));
  const scope = deps.scope ?? workerScope;
  const syncGitHub = deps.syncGitHub ?? syncGitHubRepositories;
  // Only a boolean per bindings object: pending I/O is never shared between requests.
  const verified = new WeakSet<object>();
  return {
    async fetch(request: Request, env: WorkerEnv, ctx: WorkerContext): Promise<Response> {
      let config: WorkerConfig;
      try { config = readWorkerConfig(env); } catch (error) {
        console.error('runtime_not_ready', error instanceof ReadinessError ? error.message : 'invalid_configuration');
        return problem(503, 'runtime_not_ready', '服務設定尚未完成。');
      }
      const url = new URL(request.url), configured = new URL(config.origin);
      if (url.host !== configured.host) return problem(403, 'host_rejected', config.freedomEnv === 'local' ? '此版本只提供本機使用。' : '請從自由工坊網站操作。');
      if (url.protocol !== configured.protocol) {
        if (request.method === 'GET' || request.method === 'HEAD') return new Response(null, { status: 308, headers: { ...SAFE_HEADERS, Location: config.origin + url.pathname + url.search } });
        return problem(403, 'host_rejected', '請從自由工坊網站操作。');
      }
      if(env.FREEDOM_FIRST_PARTICIPATION_ENABLED!=='true'&&(url.pathname==='/api/v1/me/first-participation'||url.pathname.startsWith('/api/v1/first-participation/')))return problem(404,'not_found','找不到這個頁面。');
      let pool: Pool;
      // A throwing factory must not escape with its raw error or leave anything to end.
      try { pool = createPool(env); } catch (error) {
        console.error('runtime_not_ready', 'pool_unavailable', error instanceof Error ? error.name : 'unknown');
        return problem(503, 'runtime_not_ready', '服務設定尚未完成。');
      }
      try {
        if (!verified.has(env)) {
          try { await assertDatabaseReady(pool, config.freedomEnv, { registrationCommunityId: env.FREEDOM_REGISTRATION_COMMUNITY_ID || undefined, databaseName: env.FREEDOM_DATABASE_NAME || undefined }); }
          catch (error) {
            console.error('runtime_not_ready', error instanceof ReadinessError ? error.message : 'database_unavailable');
            return problem(503, 'runtime_not_ready', '服務設定尚未完成。');
          }
          verified.add(env);
        }
        const runtime=workerRuntime(env,config),privateAi=await workerPrivateAiPorts(pool,env,config);
        if(privateAi)Object.assign(runtime,privateAi);
        runtime.publicGuideAssets=await installWorkerGuideAssets(env);
        if(env.FREEDOM_SERVICE_COVER_ENABLED==='true'&&runtime.avatarAssetStore){
          runtime.serviceCoverAssetStore=runtime.avatarAssetStore;
          runtime.serviceCoverAssets=createServiceCoverAssetService(pool,{store:runtime.avatarAssetStore,resolvePolicy:resolveServiceCoverUploadPolicy});
        }
        if(env.FREEDOM_EVENT_BANNER_ENABLED==='true'&&runtime.avatarAssetStore){
          runtime.eventBannerAssetStore=runtime.avatarAssetStore;
          runtime.eventBannerAssets=createEventBannerAssetService(pool,{store:runtime.avatarAssetStore,resolvePolicy:resolveEventBannerUploadPolicy});
        }
        if(env.FREEDOM_EVENT_VIDEO_ENABLED==='true'&&runtime.avatarAssetStore){
          runtime.eventVideoAssetStore=runtime.avatarAssetStore;
          runtime.eventVideoAssets=createEventVideoAssetService(pool,{store:runtime.avatarAssetStore,resolvePolicy:resolveEventVideoUploadPolicy});
        }
        if(env.FREEDOM_SKILL_IMAGE_ENABLED==='true'&&runtime.avatarAssetStore){
          runtime.skillImageAssetStore=runtime.avatarAssetStore;
          runtime.skillImageAssets=createSkillImageAssetService(pool,{store:runtime.avatarAssetStore});
        }
        if(env.FREEDOM_SOCIAL_THUMBNAIL_ENABLED==='true'&&runtime.avatarAssetStore){
          runtime.socialThumbnailAssetStore=runtime.avatarAssetStore;
          runtime.socialThumbnailAssets=createSocialThumbnailAssetService(pool,{store:runtime.avatarAssetStore,resolvePolicy:resolveSocialThumbnailUploadPolicy});
        }
        if(env.FREEDOM_EVENT_HIGHLIGHT_ENABLED==='true'&&runtime.avatarAssetStore){
          runtime.eventHighlightAssetStore=runtime.avatarAssetStore;
          runtime.eventHighlightAssets=createEventHighlightAssetService(pool,{store:runtime.avatarAssetStore,resolvePolicy:resolveEventHighlightUploadPolicy});
        }
        const app = createPlatformApp(pool, config.origin, config.freedomEnv, runtime);
        mountAssets(app, env.ASSETS);
        return await scope(env, async () => app.fetch(request, env, ctx as never));
      } catch (error) {
        console.error('request_failed', error instanceof Error ? error.name : 'unknown');
        return problem(500, 'internal_error', '操作未完成，請重新整理並查看目前狀態。');
      } finally {
        // Sockets are request-bound in Workers; always release them, even after errors.
        ctx.waitUntil(pool.end().catch(() => console.error('pool_end_failed')));
      }
    },
    async scheduled(_controller: {readonly cron?: string; readonly scheduledTime?: number}, env: WorkerEnv, ctx: WorkerContext): Promise<void> {
      const token = env.GITHUB_METRICS_TOKEN || undefined;
      let pool: Pool | undefined;
      const work = (async () => {
        try {
          pool = createPool(env);
          if(env.FREEDOM_EVENT_PARTICIPATION_ENABLED==='true'){
            try{
              const config=readWorkerConfig(env);
              const send=async(to:string,subject:string,text:string)=>{await env.EMAIL!.send({to,from:'no-reply@mail.freetwai.com',subject,text});};
              try{await processEventWaitlist(pool,send,config.origin);}catch{console.error('event_waitlist_failed');}
              try{await processEventReminders(pool,send,{enabled:true});}catch{console.error('event_reminders_failed');}
            }catch{console.error('event_participation_not_ready');}
          }
          try{await syncGitHub(pool, {fetcher: deps.githubFetcher, token, budget: GITHUB_SYNC_REQUEST_BUDGET});}
          catch(error){const name=error instanceof Error&&/^[A-Za-z][A-Za-z0-9_]*$/.test(error.name)?error.name:'unknown';console.error('github_sync_failed',name);}
          if(env.FREEDOM_REGISTRATION_COMMUNITY_ID){
            try{await (deps.guildDiscovery??refreshGuildDiscoveryReports)(pool,{communityId:env.FREEDOM_REGISTRATION_COMMUNITY_ID,reviewer:guildReviewerFromBindings(env)});}
            catch{console.error('guild_discovery_failed');}
          }
          if(env.FREEDOM_GUILD_LAUNCHPAD_ENABLED==='true'){
            try{await sweepDueOperations(pool);}
            catch{console.error('module_provision_sweep_failed');}
          }
          try{await (deps.authPrune??pruneExpiredAuthRecords)(pool);}
          catch{console.error('auth_prune_failed');}
        } catch (error) {
          const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9_]*$/.test(error.name) ? error.name : 'unknown';
          console.error('github_sync_failed', name);
        } finally {
          if (pool) await pool.end().catch(() => console.error('pool_end_failed'));
        }
      })();
      ctx.waitUntil(work);
      await work;
    },
  };
}

export default createWorkerHandler();
