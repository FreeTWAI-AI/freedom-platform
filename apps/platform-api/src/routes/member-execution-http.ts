import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Pool } from 'pg';
import { OpaqueId } from '../../../../contracts/common/v1/identity.js';
import { RuntimeEnvironmentSchema, type RuntimeEnvironment } from '../../../../contracts/execution/v1/runtime-registration.js';
import { BootstrapClientIdSchema } from '../../../../contracts/execution/v1/bootstrap.js';
import { MemberExecutionHttpRunCreateSchema, MemberExecutionHttpEmptySchema, MemberExecutionHttpModelCreateSchema,
  MemberExecutionHttpGrantCreateSchema, MemberExecutionHttpAttemptCreateSchema, MemberExecutionHttpRunMetadataSchema } from '../../../../contracts/execution/v1/member-execution-http.js';
import { ModelConnectionMetadataSchema, ExecutionGrantMetadataSchema, ExecutionAttemptMetadataSchema } from '../../../../contracts/execution/v1/member-execution.js';
import { readBoundedHttpJson } from '../../../../packages/execution-state/http-body.js';
import { ExecutionInputError } from '../../../../packages/execution-state/decode.js';
import { Problem, requireCondition } from '../../../../packages/shared/problem.js';
import { createExecutionRuns } from '../../../../modules/agent-execution/runs.js';
import { createExecutionPrerequisites } from '../../../../modules/agent-execution/prerequisites.js';
import { chargeBootstrapHttp } from '../../../../modules/agent-control/bootstrap-http-limits.js';
import { memberBoundary } from '../member-boundary.js';
import { SHARED_NETWORK_KEY } from '../runtime.js';
import type { PlatformEnv } from '../module-context.js';

type Name = 'runCreate'|'runRead'|'runPause'|'runStop'|'modelCreate'|'modelRead'|'modelRevoke'|'grantCreate'|'grantRead'|'grantRevoke'|'attemptCreate'|'attemptRead';
type Route = { name: Name; method: 'GET'|'POST'; id?: string };
function route(path: string): Route | undefined {
  if (path === '/api/v1/me/execution-runs') return {name:'runCreate',method:'POST'};
  if (path === '/api/v1/me/model-connections') return {name:'modelCreate',method:'POST'};
  const run = /^\/api\/v1\/me\/execution-runs\/([0-9a-f-]{36})(?:(:pause|:stop)|\/(grants|attempts))?$(?![\s\S])/.exec(path);
  if (run) return {name:run[2] === ':pause' ? 'runPause' : run[2] === ':stop' ? 'runStop' : run[3] === 'grants' ? 'grantCreate' : run[3] === 'attempts' ? 'attemptCreate' : 'runRead', method:run[2] || run[3] ? 'POST' : 'GET', id:run[1]};
  const record = /^\/api\/v1\/me\/(model-connections|execution-grants|execution-attempts)\/([0-9a-f-]{36})(:revoke)?$(?![\s\S])/.exec(path);
  if (!record || record[1] === 'execution-attempts' && record[3]) return;
  return {name:record[1] === 'model-connections' ? record[3] ? 'modelRevoke' : 'modelRead' : record[1] === 'execution-grants' ? record[3] ? 'grantRevoke' : 'grantRead' : 'attemptRead', method:record[3] ? 'POST' : 'GET', id:record[2]};
}
const safeCodes = new Set(['host_rejected','origin_rejected','method_not_allowed','credential_kind_rejected','encoding_rejected',
  'json_required','body_too_large','body_timeout','invalid_body','invalid_json','validation_failed','idempotency_required',
  'version_required','invalid_version','read_headers_rejected','member_execution_http_unavailable','member_execution_http_rate_limited',
  'login_required','session_expired','csrf_rejected','onboarding_required','not_found','principal_disabled','scope_disabled',
  'foundation_mapping_unavailable','scope_kind_unavailable','personal_scope_required','idempotency_conflict','version_conflict',
  'private_work_archived','private_work_policy_unavailable','execution_run_terminal','execution_run_version_exhausted','execution_run_profile_required',
  'execution_backing_unavailable','execution_binding_stale','execution_binding_mismatch','execution_prerequisite_limit',
  'execution_attempt_limit','execution_version_exhausted']);
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

/** Closed-profile member metadata transport. Explicit Node product ports may
 * install it; default Node/Worker hosts remain unconfigured.
 * Options are trusted server configuration, never body-controlled execution ports. */
export async function createMemberExecutionHttpTransport(pool: Pool, options: {
  origin: string; environment: RuntimeEnvironment; clientId: string; sourceNetwork?: (request: Request) => string; grantTtlSeconds?: number;
}) {
  let origin: string, environment: RuntimeEnvironment, clientId: string, grantTtlSeconds: number | undefined;
  let sourceNetwork: ((request: Request) => string) | undefined;
  try {
    if (!options || Object.getPrototypeOf(options) !== Object.prototype || Reflect.ownKeys(options).some(k => typeof k !== 'string'
      || !['origin','environment','clientId','sourceNetwork','grantTtlSeconds'].includes(k))) throw new Error();
    const desc = Object.getOwnPropertyDescriptors(options);
    if (!desc.origin || !desc.environment || !desc.clientId || Object.values(desc).some(d => !d.enumerable || !('value' in d))) throw new Error();
    const candidateOrigin = desc.origin.value;
    if (typeof candidateOrigin !== 'string' || /[?#%\\\x00-\x20\x7f-\uffff]/.test(candidateOrigin)) throw new Error();
    origin = candidateOrigin;
    const url = new URL(origin);
    if (!['http:','https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) throw new Error();
    environment = RuntimeEnvironmentSchema.parse(desc.environment.value);
    if (url.protocol === 'http:' && (environment !== 'local' || !['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw new Error();
    clientId = BootstrapClientIdSchema.parse(desc.clientId.value);
    sourceNetwork = desc.sourceNetwork?.value; grantTtlSeconds = desc.grantTtlSeconds?.value;
    if (sourceNetwork !== undefined && typeof sourceNetwork !== 'function') throw new Error();
    if (grantTtlSeconds !== undefined && (!Number.isInteger(grantTtlSeconds) || grantTtlSeconds < 1 || grantTtlSeconds > 3600)) throw new Error();
  } catch { throw new Error('invalid_member_execution_http_configuration'); }
  const requestHost = new URL(origin).host, boundary = memberBoundary(pool), runs = createExecutionRuns(pool);
  const prerequisites = createExecutionPrerequisites(pool,{environment,clientId,...(grantTtlSeconds === undefined ? {} : {grantTtlSeconds})});
  const app = new Hono<PlatformEnv>();
  app.onError((error,c) => {
    security(c); c.res.headers.delete('ETag'); let code = 'internal_error', httpStatus = 500;
    if (error instanceof z.ZodError || error instanceof ExecutionInputError) { code = 'validation_failed'; httpStatus = 400; }
    else if (error instanceof Problem && safeCodes.has(error.code) && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) {
      code = error.code; httpStatus = error.status;
      if (code === 'member_execution_http_rate_limited') c.header('Retry-After','60');
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
      } catch { throw new Problem(503,'member_execution_http_unavailable','Source unavailable.'); }
    }
    try { await chargeBootstrapHttp(pool,environment,clientId,'execution_member',network); }
    catch (error) {
      if (error instanceof Problem && error.code === 'bootstrap_http_rate_limited') throw new Problem(429,'member_execution_http_rate_limited','Rate limited.',60);
      throw new Problem(503,'member_execution_http_unavailable','Request unavailable.');
    }
    await boundary(c,next);
  });
  app.all('*',async c => {
    const entry = route(new URL(c.req.url).pathname)!, actor = c.get('actor');
    // Output validation errors are server failures, never mislabeled caller validation.
    const output = <T>(schema: z.ZodType<T>, value: unknown): T => { const parsed = schema.safeParse(value); if (!parsed.success) throw new Error('invalid_execution_metadata'); return parsed.data; };
    const runResponse = (value: unknown, status: 200|201 = 200) => { const dto = output(MemberExecutionHttpRunMetadataSchema,value); c.header('ETag',`"${dto.aggregateVersion}"`); return c.json(dto,status); };
    const modelResponse = (value: unknown, status: 200|201 = 200) => { const dto = output(ModelConnectionMetadataSchema,value); c.header('ETag',`"${dto.aggregateVersion}"`); return c.json(dto,status); };
    const grantResponse = (value: unknown, status: 200|201 = 200) => { const dto = output(ExecutionGrantMetadataSchema,value); c.header('ETag',`"${dto.aggregateVersion}"`); return c.json(dto,status); };
    switch (entry.name) {
      case 'runCreate': return runResponse(await runs.create(actor,{...MemberExecutionHttpRunCreateSchema.parse(await readBoundedHttpJson(c.req.raw)),key:key(c),expectedWorkVersion:version(c)}),201);
      case 'runRead': return runResponse(await runs.read(actor,{runId:entry.id!}));
      case 'runPause': case 'runStop': {
        MemberExecutionHttpEmptySchema.parse(await readBoundedHttpJson(c.req.raw));
        return runResponse(await runs[entry.name === 'runPause' ? 'pause' : 'stop'](actor,{runId:entry.id!,key:key(c),expectedVersion:version(c)}));
      }
      case 'modelCreate': return modelResponse(await prerequisites.models.create(actor,{...MemberExecutionHttpModelCreateSchema.parse(await readBoundedHttpJson(c.req.raw)),key:key(c),expectedConnectionVersion:version(c)}),201);
      case 'modelRead': return modelResponse(await prerequisites.models.read(actor,{modelConnectionId:entry.id!}));
      case 'modelRevoke': {
        MemberExecutionHttpEmptySchema.parse(await readBoundedHttpJson(c.req.raw));
        return modelResponse(await prerequisites.models.revoke(actor,{modelConnectionId:entry.id!,key:key(c),expectedVersion:version(c)}));
      }
      case 'grantCreate': return grantResponse(await prerequisites.grants.create(actor,{...MemberExecutionHttpGrantCreateSchema.parse(await readBoundedHttpJson(c.req.raw)),runId:entry.id!,key:key(c),expectedRunVersion:version(c)}),201);
      case 'grantRead': return grantResponse(await prerequisites.grants.read(actor,{grantId:entry.id!}));
      case 'grantRevoke': {
        MemberExecutionHttpEmptySchema.parse(await readBoundedHttpJson(c.req.raw));
        return grantResponse(await prerequisites.grants.revoke(actor,{grantId:entry.id!,key:key(c),expectedVersion:version(c)}));
      }
      case 'attemptCreate': return c.json(output(ExecutionAttemptMetadataSchema,await prerequisites.attempts.create(actor,{...MemberExecutionHttpAttemptCreateSchema.parse(await readBoundedHttpJson(c.req.raw)),runId:entry.id!,key:key(c),expectedRunVersion:version(c)})),201);
      case 'attemptRead': return c.json(output(ExecutionAttemptMetadataSchema,await prerequisites.attempts.read(actor,{attemptId:entry.id!})));
    }
  });
  return app;
}
