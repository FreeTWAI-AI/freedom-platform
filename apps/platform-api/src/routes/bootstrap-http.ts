import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Pool } from 'pg';
import { OpaqueId } from '../../../../contracts/common/v1/identity.js';
import { BOOTSTRAP_LIMITS } from '../../../../contracts/execution/v1/bootstrap.js';
import { BootstrapHttpBeginSchema, BootstrapHttpTokenSchema, BootstrapHttpNonceSchema, BootstrapHttpDecisionSchema } from '../../../../contracts/execution/v1/bootstrap-http.js';
import { DeviceAuthorizationInspectInputSchema, type DeviceAuthorizationHost } from '../../../../contracts/execution/v1/device-pairing.js';
import { parseBoundedJson, ExecutionInputError } from '../../../../packages/execution-state/decode.js';
import { snapshotBoundedBytes } from '../../../../packages/asset-storage/index.js';
import { Problem, requireCondition } from '../../../../packages/shared/problem.js';
import { createDeviceAuthorizations } from '../../../../modules/agent-control/device-authorizations.js';
import { parseDeviceAuthorizationHost } from '../../../../modules/agent-control/device-pairing-proof.js';
import { createBootstrapSessions } from '../../../../modules/agent-control/bootstrap-sessions.js';
import { createBootstrapStatus } from '../../../../modules/agent-control/bootstrap-status.js';
import { createAgentConnections } from '../../../../modules/agent-control/agent-connections.js';
import { chargeBootstrapHttp, type BootstrapHttpOperation } from '../../../../modules/agent-control/bootstrap-http-limits.js';
import { memberBoundary } from '../member-boundary.js';
import { SHARED_NETWORK_KEY } from '../runtime.js';
import type { PlatformEnv } from '../module-context.js';

const BODY_BYTES = 32768, BODY_CHUNKS = 128, BODY_MS = 5000;
const execution = '/execution-api/v1', member = '/api/v1/me';
const paths = Object.freeze({ begin: execution+'/auth/device-authorizations', token: execution+'/auth/token',
  nonce: execution+'/auth/nonce', status: execution+'/bootstrap', inspect: member+'/device-authorizations/inspect',
  decide: member+'/device-authorizations/decide', list: member+'/agent-connections' });
type Route = { name: keyof typeof paths | 'connection' | 'revoke'; method: 'GET' | 'POST'; member: boolean; id?: string; operation: BootstrapHttpOperation };
function route(path: string): Route | undefined {
  for (const [name, value] of Object.entries(paths)) if (value === path) {
    const isMember = ['inspect', 'decide', 'list'].includes(name);
    return { name: name as keyof typeof paths, method: ['status','list'].includes(name) ? 'GET' : 'POST', member: isMember,
      operation: isMember ? 'member' : name as BootstrapHttpOperation };
  }
  const match = /^\/api\/v1\/me\/agent-connections\/([0-9a-f-]{36})(:revoke)?$/.exec(path);
  if (match) return { name: match[2] ? 'revoke' : 'connection', method: match[2] ? 'POST' : 'GET', member: true, id: match[1], operation: 'member' };
}
const safeCodes = new Set(['host_rejected','origin_rejected','method_not_allowed','credential_kind_rejected',
  'json_required','encoding_rejected','body_too_large','body_timeout','invalid_body','invalid_json','validation_failed',
  'idempotency_required','version_required','invalid_version','bootstrap_invalid','bootstrap_unavailable',
  'bootstrap_http_unavailable','bootstrap_http_rate_limited','device_authorization_invalid','device_authorization_unavailable',
  'device_authorization_not_found','device_authorization_limit','runtime_registration_limit','bootstrap_nonce_limit',
  'login_required','session_expired','csrf_rejected','onboarding_required','not_found','principal_disabled','scope_disabled',
  'foundation_mapping_unavailable','scope_kind_unavailable','personal_scope_required','idempotency_conflict',
  'version_conflict','agent_connection_unavailable','agent_connection_version_exhausted']);
function security(c: Context<PlatformEnv>) {
  c.header('Cache-Control','private, no-store'); c.header('Pragma','no-cache');
  c.header('Vary','Origin, Cookie, Authorization, DPoP'); c.header('X-Content-Type-Options','nosniff');
  c.header('Referrer-Policy','no-referrer'); c.header('X-Robots-Tag','noindex, nofollow');
  c.header('Cross-Origin-Resource-Policy','same-origin');
}
function proof(c: Context<PlatformEnv>): string {
  const value = c.req.header('DPoP') ?? '';
  requireCondition(value.length <= BOOTSTRAP_LIMITS.compactBytes && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$(?![\s\S])/.test(value),
    401,'bootstrap_invalid','Invalid credential.'); return value;
}
function access(c: Context<PlatformEnv>): string {
  const value = c.req.header('Authorization') ?? '', match = /^DPoP ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$(?![\s\S])/.exec(value);
  requireCondition(match && match[1].length <= BOOTSTRAP_LIMITS.compactBytes,401,'bootstrap_invalid','Invalid credential.'); return match[1];
}
function key(c: Context<PlatformEnv>): string {
  const value = c.req.header('Idempotency-Key') ?? '';
  requireCondition(/^[A-Za-z0-9_-]{8,128}$(?![\s\S])/.test(value),400,'idempotency_required','Idempotency key required.'); return value;
}
function version(c: Context<PlatformEnv>): string {
  const value = c.req.header('If-Match');
  requireCondition(value !== undefined,428,'version_required','Version required.');
  requireCondition(/^"[1-9][0-9]{0,18}"$(?![\s\S])/.test(value) && BigInt(value.slice(1,-1)) <= 9223372036854775807n,
    400,'invalid_version','Invalid version.'); return value.slice(1,-1);
}
async function body(c: Context<PlatformEnv>): Promise<unknown> {
  requireCondition(/^application\/json(?:;\s*charset=utf-8)?$(?![\s\S])/i.test(c.req.header('Content-Type') ?? ''),415,'json_required','JSON required.');
  const length = c.req.header('Content-Length');
  requireCondition(length === undefined || /^(0|[1-9][0-9]*)$(?![\s\S])/.test(length) && Number(length) <= BODY_BYTES,
    413,'body_too_large','Body too large.');
  requireCondition(c.req.raw.body,400,'invalid_body','Body required.');
  const reader = c.req.raw.body.getReader(), buffer = new Uint8Array(BODY_BYTES);
  let timer: ReturnType<typeof setTimeout> | undefined, size = 0, chunks = 0, complete = false;
  let abort: (() => void) | undefined;
  const deadline = new Promise<never>((_,reject) => {
    timer = setTimeout(() => reject(new Problem(408,'body_timeout','Body timeout.')),BODY_MS);
    abort = () => reject(new Problem(400,'invalid_body','Body aborted.'));
    c.req.raw.signal.addEventListener('abort',abort,{once:true});
    if (c.req.raw.signal.aborted) abort();
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(),deadline]);
      if (next.done) { complete = true; break; }
      requireCondition(++chunks <= BODY_CHUNKS,413,'body_too_large','Body too large.');
      let bytes: Uint8Array;
      try { bytes = snapshotBoundedBytes(next.value,BODY_BYTES); }
      catch (error) {
        if ((error as { code?: string })?.code === 'too_large') throw new Problem(413,'body_too_large','Body too large.');
        throw new Problem(400,'invalid_body','Invalid body chunk.');
      }
      requireCondition(bytes.length <= BODY_BYTES-size,413,'body_too_large','Body too large.');
      buffer.set(bytes,size); size += bytes.length;
    }
    requireCondition(length === undefined || Number(length) === size,400,'invalid_body','Invalid body length.');
    const raw = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(buffer.subarray(0,size));
    return parseBoundedJson(raw);
  } catch (error) {
    if (error instanceof Problem) throw error;
    throw new Problem(400,'invalid_json','Invalid JSON.');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort) c.req.raw.signal.removeEventListener('abort',abort);
    // A hostile/failed source cannot make cancellation hold the request open.
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Explicit closed transport. Production app/Node/Worker do not mount this.
 * Configuration and sourceNetwork are trusted server ports, never request data. */
export async function createBootstrapHttpTransport(pool: Pool, options: {
  host: DeviceAuthorizationHost; signingKey: CryptoKey; sourceNetwork?: (request: Request) => string;
}) {
  let host: DeviceAuthorizationHost, signingKey: CryptoKey, sourceNetwork: ((request: Request) => string) | undefined;
  try {
    if (!options || Object.getPrototypeOf(options) !== Object.prototype
      || Reflect.ownKeys(options).some(k => typeof k !== 'string' || !['host','signingKey','sourceNetwork'].includes(k))) throw new Error();
    const desc = Object.getOwnPropertyDescriptors(options);
    if (!desc.host || !desc.signingKey || Object.values(desc).some(d => !d.enumerable || !('value' in d))) throw new Error();
    host = parseDeviceAuthorizationHost(desc.host.value); signingKey = desc.signingKey.value as CryptoKey;
    sourceNetwork = desc.sourceNetwork?.value;
    if (sourceNetwork !== undefined && typeof sourceNetwork !== 'function') throw new Error();
    const origin = new URL(host.bootstrapUri).origin;
    if (host.bootstrapUri !== origin+paths.status || host.beginUri !== origin+paths.begin || host.pollUri !== origin+paths.token
      || new URL(host.verificationUri).origin !== origin) throw new Error();
  } catch { throw new Error('invalid_bootstrap_http_configuration'); }
  const origin = new URL(host.bootstrapUri).origin, requestHost = new URL(origin).host;
  const pairing = await createDeviceAuthorizations(pool,{host,signingKey});
  const { issuerKid,beginUri:_begin,pollUri:_poll,verificationUri:_verification,clientDisplayName:_name,...cryptoHost } = host;
  const sessions = await createBootstrapSessions(pool,{host:{...cryptoHost,issuerKid,refreshUri:host.pollUri,nonceUri:origin+paths.nonce},signingKey});
  const status = createBootstrapStatus(pool,cryptoHost);
  const connections = createAgentConnections(pool,{environment:host.environment,clientId:host.clientId});
  const boundary = memberBoundary(pool), app = new Hono<PlatformEnv>();
  app.onError((error,c) => {
    security(c); let code = 'internal_error', httpStatus = 500;
    if (error instanceof z.ZodError || error instanceof ExecutionInputError) { code = 'validation_failed'; httpStatus = 400; }
    else if (error instanceof Problem && safeCodes.has(error.code) && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) {
      code = error.code; httpStatus = error.status;
      if (code === 'bootstrap_http_rate_limited') c.header('Retry-After','60');
    }
    return c.json({type:'about:blank',title:code,status:httpStatus,code,detail:'Request could not be completed.'},httpStatus as 400);
  });
  app.use('*',async (c,next) => {
    security(c);
    const url = new URL(c.req.url), sentHost = c.req.header('Host');
    requireCondition(url.origin === origin && url.href === c.req.url && !/[?#%\\\x00-\x20\x7f-\uffff]/.test(c.req.url)
      && (sentHost === undefined || sentHost === requestHost),403,'host_rejected','Host rejected.');
    const entry = route(url.pathname);
    if (!entry) return c.json({type:'about:blank',title:'not_found',status:404,code:'not_found',detail:'Not found.'},404);
    if (c.req.method !== entry.method) { c.header('Allow',entry.method); throw new Problem(405,'method_not_allowed','Method not allowed.'); }
    const sentOrigin = c.req.header('Origin'), fetchSite = c.req.header('Sec-Fetch-Site');
    requireCondition((sentOrigin === undefined || sentOrigin === origin)
      && (!entry.member || entry.method === 'GET' || sentOrigin === origin)
      && (fetchSite === undefined || fetchSite === 'same-origin' || !entry.member && fetchSite === 'none'),403,'origin_rejected','Origin rejected.');
    requireCondition(c.req.header('Content-Encoding') === undefined,415,'encoding_rejected','Encoding unsupported.');
    if (entry.member) requireCondition(c.req.header('Authorization') === undefined && c.req.header('DPoP') === undefined,
      403,'credential_kind_rejected','Credential kind rejected.');
    else {
      requireCondition(c.req.header('Cookie') === undefined && c.req.header('X-CSRF-Token') === undefined,403,'credential_kind_rejected','Credential kind rejected.');
      if (entry.name === 'begin' || entry.name === 'token') requireCondition(c.req.header('Authorization') === undefined,
        403,'credential_kind_rejected','Credential kind rejected.');
    }
    let network = SHARED_NETWORK_KEY;
    if (sourceNetwork) {
      try {
        const value = sourceNetwork(c.req.raw);
        if (typeof value !== 'string' || !/^[\x21-\x7e]{1,200}$(?![\s\S])/.test(value)) throw new Error();
        network = value;
      } catch { throw new Problem(503,'bootstrap_http_unavailable','Source unavailable.'); }
    }
    await chargeBootstrapHttp(pool,host.environment,host.clientId,entry.operation,network);
    if (entry.member) await boundary(c,next); else await next();
  });
  app.all('*',async c => {
    const entry = route(new URL(c.req.url).pathname)!;
    switch (entry.name) {
      case 'begin': return c.json(await pairing.begin({...BootstrapHttpBeginSchema.parse(await body(c)),proof:proof(c)}),201);
      case 'token': {
        const input = BootstrapHttpTokenSchema.parse(await body(c)), dpop = proof(c);
        if (input.grantType === 'device_code') {
          const {grantType:_grant,...poll} = input; return c.json(await pairing.poll({...poll,proof:dpop}));
        }
        const {grantType:_grant,...refresh} = input; return c.json(await sessions.refresh({...refresh,proof:dpop}));
      }
      case 'nonce': return c.json(await sessions.nonce({...BootstrapHttpNonceSchema.parse(await body(c)),accessToken:access(c),proof:proof(c)}),201);
      case 'status': return c.json(await status.read({connectionId:OpaqueId.parse(c.req.header('X-Freedom-Connection')),
        nonceId:OpaqueId.parse(c.req.header('X-Freedom-Nonce')),accessToken:access(c),proof:proof(c)}));
      case 'inspect': return c.json(await pairing.inspect(c.get('actor'),DeviceAuthorizationInspectInputSchema.parse(await body(c))));
      case 'decide': return c.json(await pairing.decide(c.get('actor'),{...BootstrapHttpDecisionSchema.parse(await body(c)),key:key(c)}));
      case 'list': return c.json({items:await connections.list(c.get('actor')),operational_authority:false});
      case 'connection': {
        const value = await connections.read(c.get('actor'),{connectionId:OpaqueId.parse(entry.id)});
        c.header('ETag',`"${value.aggregateVersion}"`); return c.json(value);
      }
      case 'revoke': {
        z.object({}).strict().parse(await body(c));
        const value = await connections.revoke(c.get('actor'),{connectionId:OpaqueId.parse(entry.id),key:key(c),expectedVersion:version(c)});
        c.header('ETag',`"${value.aggregateVersion}"`); return c.json(value);
      }
    }
  });
  return app;
}
