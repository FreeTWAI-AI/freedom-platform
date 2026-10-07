import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Pool } from 'pg';
import { OpaqueId } from '../../../../contracts/common/v1/identity.js';
import { RuntimeEnvironmentSchema, type RuntimeEnvironment } from '../../../../contracts/execution/v1/runtime-registration.js';
import { BootstrapClientIdSchema } from '../../../../contracts/execution/v1/bootstrap.js';
import { BrokerModelSelectionSchema, ModelCredentialMetadataSchema } from '../../../../contracts/execution/v2/model-credential.js';
import { MemberModelSettingsOverviewSchema, type MemberModelSettingsSetup } from '../../../../contracts/execution/v2/member-model-settings.js';
import { createMemberModelSettings } from '../../../../modules/agent-execution/member-model-settings.js';
import { ExecutionInputError, freezeTree, snapshotInput } from '../../../../packages/execution-state/decode.js';
import { Problem, requireCondition } from '../../../../packages/shared/problem.js';
import { chargeBootstrapHttp } from '../../../../modules/agent-control/bootstrap-http-limits.js';
import { memberBoundary } from '../member-boundary.js';
import { readSessionCookie } from '../session-cookie.js';
import { SHARED_NETWORK_KEY } from '../runtime.js';
import type { PlatformEnv } from '../module-context.js';

const overviewPath = '/api/v1/me/model-settings', credentialPath = '/api/v1/me/model-credentials/';
const safeCodes = new Set(['member_model_settings_unavailable','member_model_settings_rate_limited','host_rejected','origin_rejected',
  'method_not_allowed','credential_kind_rejected','encoding_rejected','read_headers_rejected','login_required','session_expired',
  'onboarding_required','not_found','principal_disabled','scope_disabled','foundation_mapping_unavailable']);
function security(c: Context<PlatformEnv>) {
  c.header('Cache-Control','private, no-store'); c.header('Pragma','no-cache'); c.header('Vary','Origin, Cookie, Authorization, DPoP');
  c.header('X-Content-Type-Options','nosniff'); c.header('Referrer-Policy','no-referrer');
  c.header('X-Robots-Tag','noindex, nofollow'); c.header('Cross-Origin-Resource-Policy','same-origin');
}
function canonicalOrigin(value: unknown, requireHttps = true): URL {
  if (typeof value !== 'string' || value.length > 256 || /[?#%\\\x00-\x20\x7f-\uffff]/.test(value)) throw new Error();
  const url = new URL(value);
  if (!(requireHttps ? url.protocol === 'https:' : ['http:','https:'].includes(url.protocol)) || url.origin !== value || url.username || url.password) throw new Error();
  return url;
}

/** Cookie-only metadata routes; no vault, recovery, broker proxy or secret body port. */
export async function createMemberModelSettingsHttpTransport(pool: Pool, raw: {
  origin: string; environment: RuntimeEnvironment; clientId: string; selections: readonly z.infer<typeof BrokerModelSelectionSchema>[];
  setupOrigin?: string; sourceNetwork?: (request: Request) => string;
}) {
  let origin: string, host: string, environment: RuntimeEnvironment, clientId: string;
  let selections: z.infer<typeof BrokerModelSelectionSchema>[], setup: MemberModelSettingsSetup;
  let sourceNetwork: ((request: Request) => string) | undefined;
  try {
    if (!raw || Object.getPrototypeOf(raw) !== Object.prototype || Reflect.ownKeys(raw).some(key => typeof key !== 'string'
      || !['origin','environment','clientId','selections','setupOrigin','sourceNetwork'].includes(key))) throw new Error();
    const ds = Object.getOwnPropertyDescriptors(raw);
    if (['origin','environment','clientId','selections'].some(key => !ds[key]) || Object.values(ds).some(d => !d.enumerable || !('value' in d))) throw new Error();
    environment = RuntimeEnvironmentSchema.parse(ds.environment.value); clientId = BootstrapClientIdSchema.parse(ds.clientId.value);
    const main = canonicalOrigin(ds.origin.value,false); origin = main.origin; host = main.host;
    if (main.protocol === 'http:' && (environment !== 'local' || !['localhost','127.0.0.1','[::1]'].includes(main.hostname) || ds.setupOrigin)) throw new Error();
    selections = freezeTree(z.array(BrokerModelSelectionSchema).max(50).parse(snapshotInput(ds.selections.value)));
    sourceNetwork = ds.sourceNetwork?.value;
    if (sourceNetwork !== undefined && typeof sourceNetwork !== 'function') throw new Error();
    setup = ds.setupOrigin ? {state:'installed',setupOrigin:canonicalOrigin(ds.setupOrigin.value).origin} : {state:'unavailable'};
    if (setup.state === 'installed' && new URL(setup.setupOrigin).hostname === main.hostname) throw new Error();
    freezeTree(setup);
  } catch { throw new Error('invalid_member_model_settings_http_configuration'); }
  const settings = createMemberModelSettings(pool,{environment,clientId,selections}), boundary = memberBoundary(pool,origin), app = new Hono<PlatformEnv>();
  app.onError((error,c) => {
    security(c); let code = 'internal_error', status = 500;
    if (error instanceof z.ZodError || error instanceof ExecutionInputError) { code = 'validation_failed'; status = 400; }
    else if (error instanceof Problem && safeCodes.has(error.code) && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) {
      code = error.code; status = error.status;
    }
    if (code === 'member_model_settings_rate_limited') c.header('Retry-After','60');
    return c.json({type:'about:blank',title:code,status,code,detail:'Request could not be completed.'},status as 400);
  });
  app.use('*',async(c,next) => {
    security(c);
    const url = new URL(c.req.url), sentHost = c.req.header('Host');
    requireCondition(url.origin === origin && url.href === c.req.url && !/[?#%\\\x00-\x20\x7f-\uffff]/.test(c.req.url)
      && (sentHost === undefined || sentHost === host),403,'host_rejected','Host rejected.');
    const match = /^\/api\/v1\/me\/model-credentials\/([0-9a-f-]{36})$(?![\s\S])/.exec(url.pathname);
    if (url.pathname !== overviewPath && !match) throw new Problem(404,'not_found','Not found.');
    if (c.req.method !== 'GET') { c.header('Allow','GET'); throw new Problem(405,'method_not_allowed','Method rejected.'); }
    if (match) OpaqueId.parse(match[1]);
    const sentOrigin = c.req.header('Origin'), site = c.req.header('Sec-Fetch-Site');
    requireCondition((sentOrigin === undefined || sentOrigin === origin) && (site === undefined || site === 'same-origin'),403,'origin_rejected','Origin rejected.');
    requireCondition(['Authorization','DPoP','X-Freedom-Connection','X-Freedom-Nonce'].every(h => c.req.header(h) === undefined),403,'credential_kind_rejected','Credential rejected.');
    readSessionCookie(c.req.header('Cookie'),origin);
    requireCondition(c.req.header('Content-Encoding') === undefined,415,'encoding_rejected','Encoding unsupported.');
    requireCondition(c.req.raw.body === null && ['If-None-Match','If-Modified-Since','If-Unmodified-Since','If-Range','Range',
      'Idempotency-Key','If-Match','Content-Length','Transfer-Encoding'].every(h => c.req.header(h) === undefined),400,'read_headers_rejected','Read headers rejected.');
    let network = SHARED_NETWORK_KEY;
    if (sourceNetwork) {
      try { network = sourceNetwork(c.req.raw); if (typeof network !== 'string' || !/^[\x21-\x7e]{1,200}$(?![\s\S])/.test(network)) throw new Error(); }
      catch { throw new Problem(503,'member_model_settings_unavailable','Source unavailable.'); }
    }
    try { await chargeBootstrapHttp(pool,environment,clientId,'execution_member',network); }
    catch (error) {
      if (error instanceof Problem && error.code === 'bootstrap_http_rate_limited') throw new Problem(429,'member_model_settings_rate_limited','Rate limited.');
      throw new Problem(503,'member_model_settings_unavailable','Request unavailable.');
    }
    await boundary(c,next);
  });
  app.all('*',async c => {
    if (new URL(c.req.url).pathname === overviewPath) {
      const dto = MemberModelSettingsOverviewSchema.safeParse({...await settings.readOverview(c.get('actor')),setup});
      if (!dto.success) throw new Error('invalid_member_model_settings_metadata');
      return c.json(dto.data);
    }
    const dto = ModelCredentialMetadataSchema.safeParse(await settings.readCredential(c.get('actor'),{credentialId:new URL(c.req.url).pathname.slice(credentialPath.length)}));
    if (!dto.success) throw new Error('invalid_member_model_settings_metadata');
    return c.json(dto.data);
  });
  return app;
}
