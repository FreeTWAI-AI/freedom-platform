import type { Pool } from 'pg';
import { Hono } from 'hono';
import type { ObjectStore } from '../../../packages/asset-storage/index.js';
import type { ModelStepHost } from '../../../modules/agent-execution/model-step-host.js';
import { resolvePrivateWorkPersistencePolicy } from '../../../modules/autopilot-work/policy.js';
import { RuntimeEnvironmentSchema, type RuntimeEnvironment } from '../../../contracts/execution/v1/runtime-registration.js';
import { createPrivateWorkTransport } from './routes/private-work-transport.js';
import { createMemberExecutionHttpTransport } from './routes/member-execution-http.js';
import { createMemberModelHttpTransport } from './routes/member-model-http.js';
import { assertOriginAllowed, type FreedomEnv } from './env.js';

declare const privateAiProductBrand: unique symbol;
/** Node-only host composition. JSON cannot construct this server port. */
export interface PrivateAiProductTransport { readonly [privateAiProductBrand]: never }
type Product = { pool: Pool; origin: string; freedomEnv: FreedomEnv; fetch: (request: Request) => Promise<Response> };
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
  origin: string; environment: RuntimeEnvironment; clientId: string; host: ModelStepHost; store: ObjectStore;
  sourceNetwork?: (request: Request) => string;
}): Promise<PrivateAiProductTransport> {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype) throw new Error('invalid_private_ai_product_configuration');
  const descriptors = Object.getOwnPropertyDescriptors(options);
  if (Reflect.ownKeys(options).some(key => typeof key !== 'string' || !['origin','environment','clientId','host','store','sourceNetwork'].includes(key))
    || Object.values(descriptors).some(value => !value.enumerable || !('value' in value))
    || ['origin','environment','clientId','host','store'].some(key => !descriptors[key])) throw new Error('invalid_private_ai_product_configuration');
  const environment = RuntimeEnvironmentSchema.parse(descriptors.environment.value);
  const freedomEnv: FreedomEnv = environment === 'local' ? 'local' : environment === 'staging-next' ? 'staging' : 'public';
  const origin = descriptors.origin.value as string;
  assertOriginAllowed(freedomEnv, origin);
  const clientId = descriptors.clientId.value as string, host = descriptors.host.value as ModelStepHost, store = descriptors.store.value as ObjectStore;
  const sourceNetwork = descriptors.sourceNetwork?.value as ((request: Request) => string) | undefined;
  const network = sourceNetwork === undefined ? {} : { sourceNetwork };
  // Each child owns its member boundary and original bounded request stream.
  // Wildcard child middleware must never be appended to the whole platform.
  const privateWork = createPrivateWorkTransport(pool, { origin, freedomEnv, store });
  const privateWorkApp = new Hono().route('/api/v1', privateWork);
  const prerequisites = await createMemberExecutionHttpTransport(pool, { origin, environment, clientId, ...network });
  const models = await createMemberModelHttpTransport(pool, { origin, environment, clientId, host, store,
    resolvePolicy: resolvePrivateWorkPersistencePolicy, ...network });
  const port = Object.freeze(Object.create(null)) as PrivateAiProductTransport;
  products.set(port, { pool, origin, freedomEnv, async fetch(request) {
    const url=new URL(request.url),path=url.pathname,sentHost=request.headers.get('Host'),sentOrigin=request.headers.get('Origin');
    if(url.origin!==origin||url.href!==request.url||url.hash||/[#%\\\x00-\x20\x7f-\uffff]/.test(path)
      ||(sentHost!==null&&sentHost!==new URL(origin).host))return rejected('host_rejected',403);
    const read=['GET','HEAD'].includes(request.method),site=request.headers.get('Sec-Fetch-Site');
    if((sentOrigin!==null&&sentOrigin!==origin)||(!read&&sentOrigin!==origin)||(site!==null&&site!=='same-origin'))return rejected('origin_rejected',403);
    if(['Authorization','DPoP','X-Freedom-Connection','X-Freedom-Nonce'].some(header=>request.headers.has(header)))return rejected('credential_kind_rejected',403);
    if(request.headers.has('Content-Encoding'))return rejected('encoding_rejected',415);
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
