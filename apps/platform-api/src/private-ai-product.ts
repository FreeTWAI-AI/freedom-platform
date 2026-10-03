import type { Pool } from 'pg';
import type { DeviceAuthorizationHost } from '../../../contracts/execution/v1/device-pairing.js';
import { parseDeviceAuthorizationHost } from '../../../modules/agent-control/device-pairing-proof.js';
import { createBootstrapHttpTransport } from './routes/bootstrap-http.js';
import { Hono } from 'hono';
import type { ObjectStore } from '../../../packages/asset-storage/index.js';
import type { ModelBrokerClient } from './model-broker-client.js';
import { bindCredentialIngestClient, type CredentialIngestClient } from './credential-ingest-client.js';
import { z } from 'zod';
import { BrokerModelSelectionSchema } from '../../../contracts/execution/v2/model-credential.js';
import { freezeTree, snapshotInput } from '../../../packages/execution-state/decode.js';
import { createMemberModelSettingsHttpTransport } from './routes/member-model-settings-http.js';
import type { ModelStepHost } from '../../../modules/agent-execution/model-step-host.js';
import { resolvePrivateWorkPersistencePolicy } from '../../../modules/autopilot-work/policy.js';
import { RuntimeEnvironmentSchema, type RuntimeEnvironment } from '../../../contracts/execution/v1/runtime-registration.js';
import { createPrivateWorkTransport } from './routes/private-work-transport.js';
import { createMemberExecutionHttpTransport } from './routes/member-execution-http.js';
import { createMemberModelHttpTransport } from './routes/member-model-http.js';
import { createMemberCredentialIngestHttpTransport } from './routes/member-credential-ingest-http.js';
import { assertOriginAllowed, type FreedomEnv } from './env.js';

declare const privateAiProductBrand: unique symbol;
/** Genuine host composition. Workers install signed broker mode only; JSON cannot construct this server port. */
export interface PrivateAiProductTransport { readonly [privateAiProductBrand]: never }
export type PrivateAiBootstrapInstallation = { host: DeviceAuthorizationHost; signingKey: CryptoKey };
type Product = { pool: Pool; origin: string; freedomEnv: FreedomEnv; setupOrigin?: string; fetch: (request: Request) => Promise<Response> };
const products = new WeakMap<object, Product>();
const privateWorkPath = '/api/v1/me/private-work';
const modelPaths = ['/api/v1/me/model-step-overview', '/api/v1/me/model-step-approvals', '/api/v1/me/model-steps'];
const matches = (path: string, base: string) => path === base || path.startsWith(base + '/') || path.startsWith(base + ':');
const privateHeaders = {'Cache-Control':'private, no-store','Pragma':'no-cache','Vary':'Origin, Cookie, Authorization, DPoP',
  'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow','Cross-Origin-Resource-Policy':'same-origin'};
function rejected(code:string,status:number) {
  return Response.json({type:'about:blank',title:code,status,code,detail:'Request could not be completed.'},{status,headers:privateHeaders});
}

export async function createPrivateAiProductTransport(pool: Pool, options: {
  origin: string; environment: RuntimeEnvironment; clientId: string; host?: ModelStepHost; broker?: ModelBrokerClient; store: ObjectStore;
  sourceNetwork?: (request: Request) => string; ingest?: CredentialIngestClient; settingsSelections?: readonly z.infer<typeof BrokerModelSelectionSchema>[];
  bootstrap?: PrivateAiBootstrapInstallation;
}): Promise<PrivateAiProductTransport> {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype) throw new Error('invalid_private_ai_product_configuration');
  const descriptors = Object.getOwnPropertyDescriptors(options);
  if (Reflect.ownKeys(options).some(key => typeof key !== 'string' || !['origin','environment','clientId','host','broker','store','sourceNetwork','ingest','settingsSelections','bootstrap'].includes(key))
    || Object.values(descriptors).some(value => !value.enumerable || !('value' in value))
    || ['origin','environment','clientId','store'].some(key => !descriptors[key]) || (!!descriptors.host === !!descriptors.broker)) throw new Error('invalid_private_ai_product_configuration');
  const environment = RuntimeEnvironmentSchema.parse(descriptors.environment.value);
  const freedomEnv: FreedomEnv = environment === 'local' ? 'local' : environment === 'staging-next' ? 'staging' : 'public';
  const origin = descriptors.origin.value as string;
  assertOriginAllowed(freedomEnv, origin);
  const clientId = descriptors.clientId.value as string, host = descriptors.host?.value as ModelStepHost | undefined, broker = descriptors.broker?.value as ModelBrokerClient | undefined, store = descriptors.store.value as ObjectStore;
  const sourceNetwork = descriptors.sourceNetwork?.value as ((request: Request) => string) | undefined;
  const network = sourceNetwork === undefined ? {} : { sourceNetwork };
  const settingsSelections = freezeTree(z.array(BrokerModelSelectionSchema).max(50).parse(
    descriptors.settingsSelections ? snapshotInput(descriptors.settingsSelections.value) : []));
  let bootstrap: Awaited<ReturnType<typeof createBootstrapHttpTransport>> | undefined;
  if (descriptors.bootstrap) {
    const installation = descriptors.bootstrap.value;
    if (!installation || Object.getPrototypeOf(installation) !== Object.prototype
      || Reflect.ownKeys(installation).some(key => typeof key !== 'string' || !['host','signingKey'].includes(key)))
      throw new Error('invalid_private_ai_bootstrap_configuration');
    const ports = Object.getOwnPropertyDescriptors(installation);
    if (!ports.host || !ports.signingKey || Object.values(ports).some(value => !value.enumerable || !('value' in value)))
      throw new Error('invalid_private_ai_bootstrap_configuration');
    const bootstrapHost = parseDeviceAuthorizationHost(ports.host.value);
    if (bootstrapHost.environment !== environment || bootstrapHost.clientId !== clientId
      || new URL(bootstrapHost.bootstrapUri).origin !== origin)
      throw new Error('invalid_private_ai_bootstrap_binding');
    bootstrap = await createBootstrapHttpTransport(pool,{host:bootstrapHost,signingKey:ports.signingKey.value as CryptoKey,...network});
  }
  const ingestClient = descriptors.ingest ? bindCredentialIngestClient(descriptors.ingest.value as CredentialIngestClient,pool,origin,environment,clientId) : undefined;
  const setupOrigin = ingestClient?.setupOrigin;
  // Each child owns its member boundary and original bounded request stream.
  // Wildcard child middleware must never be appended to the whole platform.
  const privateWork = createPrivateWorkTransport(pool, { origin, freedomEnv, store });
  const privateWorkApp = new Hono().route('/api/v1', privateWork);
  const prerequisites = await createMemberExecutionHttpTransport(pool, { origin, environment, clientId, ...network });
  const ingest = descriptors.ingest ? await createMemberCredentialIngestHttpTransport(pool,
    {origin,environment,clientId,ingest:descriptors.ingest.value as CredentialIngestClient,...network}) : undefined;
  const settings = await createMemberModelSettingsHttpTransport(pool, {origin,environment,clientId,selections:settingsSelections,...(setupOrigin?{setupOrigin}:{}),...network});
  const models = await createMemberModelHttpTransport(pool, { origin, environment, clientId, ...(broker ? {broker} : {host:host!}), store,
    resolvePolicy: resolvePrivateWorkPersistencePolicy, ...network });
  const port = Object.freeze(Object.create(null)) as PrivateAiProductTransport;
  products.set(port, { pool, origin, freedomEnv, setupOrigin, async fetch(request) {
    const url=new URL(request.url),path=url.pathname,sentHost=request.headers.get('Host'),sentOrigin=request.headers.get('Origin');
    if(url.origin!==origin||url.href!==request.url||url.hash||/[#%\\\x00-\x20\x7f-\uffff]/.test(path)
      ||(sentHost!==null&&sentHost!==new URL(origin).host))return rejected('host_rejected',403);
    if (path === '/execution-api/v1' || path.startsWith('/execution-api/v1/')
      || matches(path,'/api/v1/me/device-authorizations') || matches(path,'/api/v1/me/agent-connections'))
      return bootstrap ? bootstrap.fetch(request) : rejected('bootstrap_http_unavailable',503);
    const read=['GET','HEAD'].includes(request.method),site=request.headers.get('Sec-Fetch-Site');
    if((sentOrigin!==null&&sentOrigin!==origin)||(!read&&sentOrigin!==origin)||(site!==null&&site!=='same-origin'))return rejected('origin_rejected',403);
    if(['Authorization','DPoP','X-Freedom-Connection','X-Freedom-Nonce'].some(header=>request.headers.has(header)))return rejected('credential_kind_rejected',403);
    if(request.headers.has('Content-Encoding'))return rejected('encoding_rejected',415);
    if (matches(path, '/api/v1/me/model-settings') || matches(path, '/api/v1/me/model-credentials')) return settings.fetch(request);
    if (matches(path, '/api/v1/me/credential-ingests')) {
      return ingest ? ingest.fetch(request) : rejected('credential_ingest_unavailable',503);
    }
    if (matches(path, privateWorkPath)) {
      // Private Work's reusable router has relative /me routes. Route through a
      // Hono base path rather than changing the authenticated request URL.
      return privateWorkApp.fetch(request);
    }
    if (modelPaths.some(base => matches(path, base))) return models.fetch(request);
    return prerequisites.fetch(request);
  } });
  return port;
}

/** Reject forged handles and construction for a different DB, origin or host
 * environment before any request can use the installed ports. */
export function bindPrivateAiProductTransport(port: PrivateAiProductTransport, pool: Pool, origin: string, freedomEnv: FreedomEnv) {
  const product = port && typeof port === 'object' ? products.get(port) : undefined;
  if (!product || product.pool !== pool || product.origin !== origin || product.freedomEnv !== freedomEnv) {
    throw new Error('invalid_private_ai_product_binding');
  }
  return product.fetch.bind(product);
}

/** Browser policy is derived from the same genuine installed product/client,
 * never a separate caller-supplied origin. Closure stays inside the host. */
export function bindPrivateAiProductBrowserPolicy(port: PrivateAiProductTransport,pool: Pool,origin: string,freedomEnv: FreedomEnv): () => string | undefined {
  const product=port&&typeof port==='object'?products.get(port):undefined;
  if(!product||product.pool!==pool||product.origin!==origin||product.freedomEnv!==freedomEnv)throw new Error('invalid_private_ai_product_binding');
  const setupOrigin=product.setupOrigin;
  return Object.freeze(() => setupOrigin);
}
