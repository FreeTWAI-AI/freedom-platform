import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Pool } from 'pg';
import { OpaqueId } from '../../../../contracts/common/v1/identity.js';
import { BOOTSTRAP_LIMITS } from '../../../../contracts/execution/v1/bootstrap.js';
import { BootstrapHttpBeginSchema, BootstrapHttpTokenSchema, BootstrapHttpNonceSchema, BootstrapHttpDecisionSchema } from '../../../../contracts/execution/v1/bootstrap-http.js';
import { DeviceAuthorizationInspectInputSchema, type DeviceAuthorizationHost } from '../../../../contracts/execution/v1/device-pairing.js';
import { ExecutionInputError } from '../../../../packages/execution-state/decode.js';
import { readBoundedHttpJson } from '../../../../packages/execution-state/http-body.js';
import { Problem, requireCondition } from '../../../../packages/shared/problem.js';
import { createDeviceAuthorizations } from '../../../../modules/agent-control/device-authorizations.js';
import { parseDeviceAuthorizationHost } from '../../../../modules/agent-control/device-pairing-proof.js';
import { createBootstrapSessions } from '../../../../modules/agent-control/bootstrap-sessions.js';
import { createBootstrapStatus } from '../../../../modules/agent-control/bootstrap-status.js';
import { createAgentConnections } from '../../../../modules/agent-control/agent-connections.js';
import { chargeBootstrapHttp, type BootstrapHttpOperation } from '../../../../modules/agent-control/bootstrap-http-limits.js';
import { memberBoundary } from '../member-boundary.js';
import { readSessionCookie } from '../session-cookie.js';
import { SHARED_NETWORK_KEY } from '../runtime.js';
import type { PlatformEnv } from '../module-context.js';

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
  'read_headers_rejected','idempotency_required','version_required','invalid_version','bootstrap_invalid','bootstrap_unavailable',
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

/** Explicit closed transport. Only a genuine Node product installation mounts this.
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
  const boundary = memberBoundary(pool,origin), app = new Hono<PlatformEnv>();
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
    if (entry.member) {
      requireCondition(['Authorization','DPoP','X-Freedom-Connection','X-Freedom-Nonce'].every(h => c.req.header(h) === undefined),
        403,'credential_kind_rejected','Credential kind rejected.');
      readSessionCookie(c.req.header('Cookie'),origin);
      requireCondition(['If-None-Match','If-Modified-Since','If-Unmodified-Since','If-Range','Range'].every(h => c.req.header(h) === undefined),
        400,'read_headers_rejected','Conditional headers unsupported.');
      if (entry.id) OpaqueId.parse(entry.id);
      if (entry.method === 'GET') requireCondition(c.req.raw.body === null
        && ['Idempotency-Key','If-Match','Content-Length','Transfer-Encoding'].every(h => c.req.header(h) === undefined),
        400,'read_headers_rejected','Read headers rejected.');
      if (entry.name === 'decide' || entry.name === 'revoke') key(c);
      if (entry.name === 'revoke') version(c);
    }
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
      case 'begin': return c.json(await pairing.begin({...BootstrapHttpBeginSchema.parse(await readBoundedHttpJson(c.req.raw)),proof:proof(c)}),201);
      case 'token': {
        const input = BootstrapHttpTokenSchema.parse(await readBoundedHttpJson(c.req.raw)), dpop = proof(c);
        if (input.grantType === 'device_code') {
          const {grantType:_grant,...poll} = input; return c.json(await pairing.poll({...poll,proof:dpop}));
        }
        const {grantType:_grant,...refresh} = input; return c.json(await sessions.refresh({...refresh,proof:dpop}));
      }
      case 'nonce': return c.json(await sessions.nonce({...BootstrapHttpNonceSchema.parse(await readBoundedHttpJson(c.req.raw)),accessToken:access(c),proof:proof(c)}),201);
      case 'status': return c.json(await status.read({connectionId:OpaqueId.parse(c.req.header('X-Freedom-Connection')),
        nonceId:OpaqueId.parse(c.req.header('X-Freedom-Nonce')),accessToken:access(c),proof:proof(c)}));
      case 'inspect': return c.json(await pairing.inspect(c.get('actor'),DeviceAuthorizationInspectInputSchema.parse(await readBoundedHttpJson(c.req.raw))));
      case 'decide': return c.json(await pairing.decide(c.get('actor'),{...BootstrapHttpDecisionSchema.parse(await readBoundedHttpJson(c.req.raw)),key:key(c)}));
      case 'list': return c.json({items:await connections.list(c.get('actor')),operational_authority:false});
      case 'connection': {
        const value = await connections.read(c.get('actor'),{connectionId:OpaqueId.parse(entry.id)});
        c.header('ETag',`"${value.aggregateVersion}"`); return c.json(value);
      }
      case 'revoke': {
        z.object({}).strict().parse(await readBoundedHttpJson(c.req.raw));
        const value = await connections.revoke(c.get('actor'),{connectionId:OpaqueId.parse(entry.id),key:key(c),expectedVersion:version(c)});
        c.header('ETag',`"${value.aggregateVersion}"`); return c.json(value);
      }
    }
  });
  return app;
}
