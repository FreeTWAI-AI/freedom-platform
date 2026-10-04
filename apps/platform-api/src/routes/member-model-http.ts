import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Pool } from 'pg';
import { OpaqueId } from '../../../../contracts/common/v1/identity.js';
import { RuntimeEnvironmentSchema, type RuntimeEnvironment } from '../../../../contracts/execution/v1/runtime-registration.js';
import { BootstrapClientIdSchema } from '../../../../contracts/execution/v1/bootstrap.js';
import { MemberModelHttpApprovalCreateSchema, MemberModelHttpActivateSchema, MemberModelHttpEmptySchema } from '../../../../contracts/execution/v2/member-model-http.js';
import { ModelStepApprovalMetadataSchema, ModelStepMetadataSchema } from '../../../../contracts/execution/v2/model-step.js';
import type { ObjectStore } from '../../../../packages/asset-storage/index.js';
import type { PrivateResultDependencies } from '../../../../modules/autopilot-work/results.js';
import { bindModelBrokerClient, type ModelBrokerClient } from '../model-broker-client.js';
import { createUnavailableModelStepHost } from '../../../../modules/agent-execution/model-step-host.js';
import type { ModelStepHost } from '../../../../modules/agent-execution/model-step-host.js';
import { createModelStepService } from '../../../../modules/agent-execution/model-step-service.js';
import { createModelStepRunner } from '../../../../modules/agent-execution/model-step-runner.js';
import { createPrivateModelResultService } from '../../../../modules/agent-execution/model-results.js';
import { readMemberModelOverview } from '../../../../modules/agent-execution/member-model-overview.js';
import { AdapterFault } from '../../../../modules/agent-execution/adapters/common.js';
import { readBoundedHttpJson } from '../../../../packages/execution-state/http-body.js';
import { ExecutionInputError } from '../../../../packages/execution-state/decode.js';
import { Problem, requireCondition } from '../../../../packages/shared/problem.js';
import { chargeBootstrapHttp } from '../../../../modules/agent-control/bootstrap-http-limits.js';
import { memberBoundary } from '../member-boundary.js';
import { SHARED_NETWORK_KEY } from '../runtime.js';
import type { PlatformEnv } from '../module-context.js';

type Name = 'approvalCreate'|'approvalRead'|'approvalRevoke'|'activate'|'read'|'execute'|'pause'|'stop'|'overview';
type Route = { name: Name; method: 'GET'|'POST'; id?: string };
function route(path: string): Route | undefined {
  if (path === '/api/v1/me/model-step-overview') return {name:'overview',method:'GET'};
  if (path === '/api/v1/me/model-step-approvals') return {name:'approvalCreate',method:'POST'};
  if (path === '/api/v1/me/model-steps') return {name:'activate',method:'POST'};
  const approval = /^\/api\/v1\/me\/model-step-approvals\/([0-9a-f-]{36})(:revoke)?$(?![\s\S])/.exec(path);
  if(approval) return {name:approval[2]?'approvalRevoke':'approvalRead',method:approval[2]?'POST':'GET',id:approval[1]};
  const step = /^\/api\/v1\/me\/model-steps\/([0-9a-f-]{36})(:execute|:pause|:stop)?$(?![\s\S])/.exec(path);
  if(step) return {name:step[2] === ':execute'?'execute':step[2] === ':pause'?'pause':step[2] === ':stop'?'stop':'read',method:step[2]?'POST':'GET',id:step[1]};
}
const safeCodes = new Set(['model_broker_unavailable','model_broker_authorization_invalid','model_broker_registry_unavailable','model_step_outcome_unknown','host_rejected','origin_rejected','method_not_allowed','credential_kind_rejected','encoding_rejected',
  'json_required','body_too_large','body_timeout','invalid_body','invalid_json','validation_failed','idempotency_required',
  'version_required','invalid_version','read_headers_rejected','member_model_http_unavailable','member_model_http_rate_limited',
  'login_required','session_expired','csrf_rejected','onboarding_required','not_found','principal_disabled','scope_disabled',
  'foundation_mapping_unavailable','scope_kind_unavailable','personal_scope_required','idempotency_conflict','version_conflict',
  'private_work_archived','private_work_policy_unavailable','execution_run_terminal','execution_run_version_exhausted',
  'execution_backing_unavailable','execution_binding_stale','execution_binding_mismatch','execution_prerequisite_limit',
  'execution_attempt_limit','execution_version_exhausted','model_step_binding_stale','model_step_binding_mismatch',
  'model_step_custody_unavailable','model_step_already_activated','model_step_already_consumed','model_authentication_unavailable',
  'model_inference_export_denied','model_inference_export_unavailable','inference_export_policy_unavailable','inference_export_denied',
  'private_work_persistence_denied','model_step_limit','model_step_state_conflict','model_export_policy_denied','model_export_approval_revoked']);
function security(c: Context<PlatformEnv>) {
  c.header('Cache-Control','private, no-store'); c.header('Pragma','no-cache');
  c.header('Vary','Origin, Cookie, Authorization, DPoP'); c.header('X-Content-Type-Options','nosniff');
  c.header('Referrer-Policy','no-referrer'); c.header('X-Robots-Tag','noindex, nofollow');
  c.header('Cross-Origin-Resource-Policy','same-origin');
}
function key(c: Context<PlatformEnv>): string {
  const value = c.req.header('Idempotency-Key') ?? '';
  requireCondition(/^[A-Za-z0-9_-]{8,128}$(?![\s\S])/.test(value),400,'idempotency_required','Key required.'); return value;
}
function version(c: Context<PlatformEnv>): string {
  const value = c.req.header('If-Match');
  requireCondition(value !== undefined,428,'version_required','Version required.');
  requireCondition(/^"[1-9][0-9]{0,18}"$(?![\s\S])/.test(value) && BigInt(value.slice(1,-1)) <= 9223372036854775807n,
    400,'invalid_version','Invalid version.'); return value.slice(1,-1);
}

/** Member-cookie ModelStep transport. All execution ports are trusted host
 * configuration. No caller field can select a host, credential or policy. */
export interface MemberModelHttpOptions {
  origin: string; environment: RuntimeEnvironment; clientId: string; host?: ModelStepHost; broker?: ModelBrokerClient;
  store: ObjectStore; resolvePolicy: PrivateResultDependencies['resolvePolicy']; sourceNetwork?: (request: Request) => string;
}
export async function createMemberModelHttpTransport(pool: Pool, options: MemberModelHttpOptions) {
  let origin: string, environment: RuntimeEnvironment, clientId: string, host: ModelStepHost, store: ObjectStore, resolvePolicy: PrivateResultDependencies['resolvePolicy'];
  let broker: ReturnType<typeof bindModelBrokerClient> | undefined;
  let sourceNetwork: ((request: Request) => string) | undefined;
  try {
    if (!options || Object.getPrototypeOf(options) !== Object.prototype || Reflect.ownKeys(options).some(k => typeof k !== 'string'
      || !['origin','environment','clientId','host','broker','store','resolvePolicy','sourceNetwork'].includes(k))) throw new Error();
    const desc = Object.getOwnPropertyDescriptors(options);
    if (['origin','environment','clientId','store','resolvePolicy'].some(k => !desc[k]) || (!!desc.host === !!desc.broker) || Object.values(desc).some(d => !d.enumerable || !('value' in d))) throw new Error();
    const candidateOrigin = desc.origin.value;
    if (typeof candidateOrigin !== 'string' || /[?#%\\\x00-\x20\x7f-\uffff]/.test(candidateOrigin)) throw new Error();
    origin = candidateOrigin;
    const url = new URL(origin);
    if (!['http:','https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) throw new Error();
    environment = RuntimeEnvironmentSchema.parse(desc.environment.value);
    if (url.protocol === 'http:' && (environment !== 'local' || !['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw new Error();
    clientId = BootstrapClientIdSchema.parse(desc.clientId.value);
    sourceNetwork = desc.sourceNetwork?.value;
    broker = desc.broker ? bindModelBrokerClient(desc.broker.value as ModelBrokerClient,pool,origin,environment,clientId) : undefined;
    host = desc.host ? desc.host.value as ModelStepHost : createUnavailableModelStepHost(); store = desc.store.value as ObjectStore; resolvePolicy = desc.resolvePolicy.value as PrivateResultDependencies["resolvePolicy"];
    if (sourceNetwork !== undefined && typeof sourceNetwork !== 'function') throw new Error();
    if (!store || typeof store !== 'object' || ['get','head','putImmutable','delete'].some(k => typeof (store as unknown as Record<string,unknown>)[k] !== 'function') || typeof resolvePolicy !== 'function') throw new Error();
  } catch { throw new Error('invalid_member_model_http_configuration'); }
  const requestHost = new URL(origin).host, boundary = memberBoundary(pool);
  const steps = createModelStepService(pool,{environment,clientId,host});
  const finalizer = broker ? undefined : createPrivateModelResultService(pool,{steps,host,store,resolvePolicy});
  const runner = broker ? undefined : createModelStepRunner({service:steps,host,resultFinalizer:finalizer!});
  const app = new Hono<PlatformEnv>();
  app.onError((error,c) => {
    security(c); c.res.headers.delete('ETag'); let code = 'internal_error', httpStatus = 500;
    if (error instanceof z.ZodError || error instanceof ExecutionInputError) { code = 'validation_failed'; httpStatus = 400; }
    else if (error instanceof AdapterFault) { code = error.code === 'outcome_unknown' ? 'model_step_outcome_unknown' : 'model_authentication_unavailable'; httpStatus = 503; }
    else if (error instanceof Problem && safeCodes.has(error.code) && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) {
      code = error.code; httpStatus = error.status;
      if (code === 'member_model_http_rate_limited') c.header('Retry-After','60');
    }
    return c.json({type:'about:blank',title:code,status:httpStatus,code,detail:'Request could not be completed.'},httpStatus as 400);
  });
  app.use('*',async (c,next) => {
    security(c);
    const url = new URL(c.req.url), sentHost = c.req.header('Host');
    requireCondition(url.origin === origin && url.href === c.req.url && !/[?#%\\\x00-\x20\x7f-\uffff]/.test(c.req.url)
      && (sentHost === undefined || sentHost === requestHost),403,'host_rejected','Host rejected.');
    const entry = route(url.pathname);
    if (!entry) throw new Problem(404,'not_found','Not found.');
    if (c.req.method !== entry.method) { c.header('Allow',entry.method); throw new Problem(405,'method_not_allowed','Method rejected.'); }
    const sentOrigin = c.req.header('Origin'), fetchSite = c.req.header('Sec-Fetch-Site');
    requireCondition((sentOrigin === undefined || sentOrigin === origin) && (entry.method === 'GET' || sentOrigin === origin)
      && (fetchSite === undefined || fetchSite === 'same-origin'),403,'origin_rejected','Origin rejected.');
    requireCondition(['Authorization','DPoP','X-Freedom-Connection','X-Freedom-Nonce'].every(h => c.req.header(h) === undefined),403,'credential_kind_rejected','Credential rejected.');
    requireCondition(c.req.header('Content-Encoding') === undefined,415,'encoding_rejected','Encoding unsupported.');
    requireCondition(['If-None-Match','If-Modified-Since','If-Unmodified-Since','If-Range','Range'].every(h => c.req.header(h) === undefined),400,'read_headers_rejected','Conditional headers unsupported.');
    if (entry.id) OpaqueId.parse(entry.id);
    if (entry.method === 'GET') requireCondition(c.req.raw.body === null && ['Idempotency-Key','If-Match','Content-Length','Transfer-Encoding'].every(h => c.req.header(h) === undefined),400,'read_headers_rejected','Read headers rejected.');
    else { key(c); version(c); }
    let network = SHARED_NETWORK_KEY;
    if (sourceNetwork) {
      try { const value = sourceNetwork(c.req.raw);
        if (typeof value !== 'string' || !/^[\x21-\x7e]{1,200}$(?![\s\S])/.test(value)) throw new Error(); network = value;
      } catch { throw new Problem(503,'member_model_http_unavailable','Source unavailable.'); }
    }
    try { await chargeBootstrapHttp(pool,environment,clientId,'execution_member',network); }
    catch (error) {
      if (error instanceof Problem && error.code === 'bootstrap_http_rate_limited') throw new Problem(429,'member_model_http_rate_limited','Rate limited.',60);
      throw new Problem(503,'member_model_http_unavailable','Request unavailable.');
    }
    await boundary(c,next);
  });
  app.all('*',async c => {
    const entry = route(new URL(c.req.url).pathname)!, actor = c.get('actor');
    // Output validation errors are server failures, never mislabeled caller validation.
    const output = <T>(schema: z.ZodType<T>, value: unknown): T => { const parsed = schema.safeParse(value); if (!parsed.success) throw new Error('invalid_execution_metadata'); return parsed.data; };
    const approvalResponse = (value: unknown, status: 200|201 = 200) => { const dto = output(ModelStepApprovalMetadataSchema,value); c.header('ETag',`"${dto.aggregateVersion}"`); return c.json(dto,status); };
    const stepResponse = (value: unknown, status: 200|201 = 200) => { const dto = output(ModelStepMetadataSchema,value); c.header('ETag',`"${dto.aggregateVersion}"`); return c.json(dto,status); };
    switch (entry.name) {
      case 'overview': return c.json(await readMemberModelOverview(pool,actor,environment,clientId));
      case 'approvalCreate': return approvalResponse(await steps.approvals.create(actor,{...MemberModelHttpApprovalCreateSchema.parse(await readBoundedHttpJson(c.req.raw)),key:key(c),expectedRunVersion:version(c)}),201);
      case 'approvalRead': return approvalResponse(await steps.approvals.read(actor,{approvalId:entry.id!}));
      case 'approvalRevoke': {
        MemberModelHttpEmptySchema.parse(await readBoundedHttpJson(c.req.raw));
        return approvalResponse(await steps.approvals.revoke(actor,{approvalId:entry.id!,key:key(c),expectedVersion:version(c)}));
      }
      case 'activate': return stepResponse(await (broker ? broker.activate : steps.activate)(actor,{...MemberModelHttpActivateSchema.parse(await readBoundedHttpJson(c.req.raw)),key:key(c),expectedApprovalVersion:version(c)}),201);
      case 'read': return stepResponse(await steps.read(actor,{stepId:entry.id!}));
      case 'execute': {
        MemberModelHttpEmptySchema.parse(await readBoundedHttpJson(c.req.raw));
        const input={stepId:entry.id!,key:key(c),expectedVersion:version(c)};
        const executed = broker ? {metadata:await broker.execute(actor,input)} : await runner!.execute(actor,input);
        // The finalizer's Result pointer never carries bytes across this wire;
        // callers read private text through the established authorized Result API.
        return stepResponse(executed.metadata);
      }
      case 'pause': case 'stop': {
        MemberModelHttpEmptySchema.parse(await readBoundedHttpJson(c.req.raw));
        return stepResponse(await steps.control(actor,{stepId:entry.id!,key:key(c),expectedVersion:version(c),action:entry.name}));
      }
    }
  });
  return app;
}
