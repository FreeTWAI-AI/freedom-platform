import type { ExecutionContext, Hyperdrive, ImagesBinding as OfficialImagesBinding } from '@cloudflare/workers-types';
import type { Context, Hono } from 'hono';
import { isIP } from 'node:net';
import type { Pool } from 'pg';
import { createRequestPool } from '../../../packages/db/index.js';
import { Problem } from '../../../packages/shared/problem.js';
import { createUnavailableImageProcessor, runWithImageProcessor } from '../../../packages/shared/image-runtime.js';
import { createCloudflareImageProcessor, type ImagesBinding } from '../../../packages/shared/image-cloudflare.js';
import { createAdminAccessVerifier, type AdminAccessVerifier } from '../../../modules/platform-admin/access.js';
import { assertOriginAllowed, resolveFreedomEnv, type FreedomEnv } from './env.js';
import { createPlatformApp } from './platform-app.js';
import { assertDatabaseReady, ReadinessError } from './readiness.js';
import { SHARED_NETWORK_KEY, type PlatformRuntime } from './runtime.js';

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
 * Secrets arrive as bindings and are only passed into explicit per-request
 * options; process.env is never read or written here.
 */
export interface WorkerEnv {
  HYPERDRIVE: { readonly connectionString: string };
  ASSETS: { fetch(request: Request): Promise<Response> };
  IMAGES?: ImagesBinding;
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
  return { freedomEnv, origin, release, trustConnectingIp };
}

/**
 * Cloudflare's edge sets CF-Connecting-IP on requests to a custom domain, replacing
 * any client-supplied value. workerd, `wrangler dev` and Miniflare pass inbound
 * headers through and fabricate `request.cf`, so neither the header nor `cf` proves
 * an edge request. The header is therefore used only when the deployment opted in
 * (non-local env, explicit binding), the request carries `cf`, and the worker
 * already required Host to equal the configured custom-domain origin. Otherwise
 * every client shares one conservative key. X-Forwarded-For is never read.
 */
export function cloudflareSourceNetwork(trustConnectingIp: boolean) {
  return (c: Context): string => {
    if (!trustConnectingIp || !(c.req.raw as Request & { cf?: unknown }).cf) return SHARED_NETWORK_KEY;
    const address = c.req.header('CF-Connecting-IP')?.trim() ?? '';
    return isIP(address) ? address : SHARED_NETWORK_KEY;
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
  return {
    registrationCommunityId: () => community,
    githubTokenKey: () => tokenKey,
    adminVerifier: workerAdminVerifier(env),
    sourceNetwork: cloudflareSourceNetwork(config.trustConnectingIp),
    allowedHosts: new Set([new URL(config.origin).hostname]),
    // Every Worker links, canonicalizes and documents its own configured origin;
    // only the existing Node deployments keep the live-site default.
    publicOrigin: config.origin,
    health: { runtime: 'cloudflare-workers', release_sha: config.release },
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
        const app = createPlatformApp(pool, config.origin, config.freedomEnv, workerRuntime(env, config));
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
  };
}

export default createWorkerHandler();
