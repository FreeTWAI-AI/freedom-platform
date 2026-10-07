import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Pool } from 'pg';
import { OpaqueId } from '../../../../contracts/common/v1/identity.js';
import { RuntimeEnvironmentSchema, type RuntimeEnvironment } from '../../../../contracts/execution/v1/runtime-registration.js';
import { BootstrapClientIdSchema } from '../../../../contracts/execution/v1/bootstrap.js';
import { CredentialIngestIssueInputSchema, CredentialIngestOwnerOutcomeSchema } from '../../../../contracts/execution/v2/model-credential-ingest.js';
import { bindCredentialIngestClient, CredentialIngestHandoffSchema, type CredentialIngestClient } from '../credential-ingest-client.js';
import { readBoundedHttpJson } from '../../../../packages/execution-state/http-body.js';
import { ExecutionInputError } from '../../../../packages/execution-state/decode.js';
import { Problem, requireCondition } from '../../../../packages/shared/problem.js';
import { chargeBootstrapHttp } from '../../../../modules/agent-control/bootstrap-http-limits.js';
import { memberBoundary } from '../member-boundary.js';
import { readSessionCookie } from '../session-cookie.js';
import { SHARED_NETWORK_KEY } from '../runtime.js';
import type { PlatformEnv } from '../module-context.js';

const base='/api/v1/me/credential-ingests';
const safeCodes=new Set(['credential_ingest_unavailable','credential_ingest_authorization_invalid','credential_ingest_registry_unavailable',
  'credential_ingest_outcome_unknown','credential_ingest_submission_consumed','host_rejected','origin_rejected','method_not_allowed',
  'credential_kind_rejected','encoding_rejected','read_headers_rejected','idempotency_required','version_required','invalid_version',
  'credential_ingest_rate_limited','login_required','session_expired','csrf_rejected','onboarding_required','not_found','principal_disabled',
  'scope_disabled','foundation_mapping_unavailable','scope_kind_unavailable','personal_scope_required','idempotency_conflict','version_conflict',
  'body_too_large','body_timeout','invalid_body','invalid_json','json_required']);
function security(c:Context<PlatformEnv>){
  c.header('Cache-Control','private, no-store');c.header('Pragma','no-cache');c.header('Vary','Origin, Cookie, Authorization, DPoP');
  c.header('X-Content-Type-Options','nosniff');c.header('Referrer-Policy','no-referrer');c.header('X-Robots-Tag','noindex, nofollow');
  c.header('Cross-Origin-Resource-Policy','same-origin');
}
function key(c:Context<PlatformEnv>){const k=c.req.header('Idempotency-Key')??'';
  requireCondition(/^[A-Za-z0-9_-]{8,128}$(?![\s\S])/.test(k),400,'idempotency_required','Key required.');return k;}
function version(c:Context<PlatformEnv>){const v=c.req.header('If-Match');
  requireCondition(v!==undefined,428,'version_required','Version required.');
  requireCondition(/^"[1-9][0-9]{0,18}"$(?![\s\S])/.test(v!)&&BigInt(v!.slice(1,-1))<=9223372036854775807n,400,'invalid_version','Invalid version.');return v!.slice(1,-1);}

/** Explicit member metadata factory. It has no secret body or broker proxy route. */
export async function createMemberCredentialIngestHttpTransport(pool:Pool,raw:{origin:string;environment:RuntimeEnvironment;
  clientId:string;ingest:CredentialIngestClient;sourceNetwork?:(request:Request)=>string}){
  const ds=raw&&Object.getOwnPropertyDescriptors(raw);
  if(!raw||Object.getPrototypeOf(raw)!==Object.prototype||!ds||Reflect.ownKeys(raw).some(k=>typeof k!=='string'
    ||!['origin','environment','clientId','ingest','sourceNetwork'].includes(k))||Object.values(ds).some(v=>!v.enumerable||!('value'in v))
    ||['origin','environment','clientId','ingest'].some(k=>!ds[k]))throw new Error('invalid_credential_ingest_http_configuration');
  const origin=ds.origin.value as string,u=new URL(origin),environment=RuntimeEnvironmentSchema.parse(ds.environment.value),
    clientId=BootstrapClientIdSchema.parse(ds.clientId.value),sourceNetwork=ds.sourceNetwork?.value as ((request:Request)=>string)|undefined;
  if(typeof origin!=='string'||u.protocol!=='https:'||u.origin!==origin||u.username||u.password
    ||/[?#%\\\x00-\x20\x7f-\uffff]/.test(origin)||(sourceNetwork!==undefined&&typeof sourceNetwork!=='function'))throw new Error('invalid_credential_ingest_http_configuration');
  const ingest=bindCredentialIngestClient(ds.ingest.value as CredentialIngestClient,pool,origin,environment,clientId),boundary=memberBoundary(pool,origin),app=new Hono<PlatformEnv>();
  app.onError((error,c)=>{
    security(c);let code='internal_error',status=500;
    if(error instanceof z.ZodError||error instanceof ExecutionInputError){code='validation_failed';status=400;}
    else if(error instanceof Problem&&safeCodes.has(error.code)&&Number.isInteger(error.status)&&error.status>=400&&error.status<=599){code=error.code;status=error.status;}
    if(code==='credential_ingest_rate_limited')c.header('Retry-After','60');
    return c.json({type:'about:blank',title:code,status,code,detail:'Request could not be completed.'},status as 400);
  });
  app.use('*',async(c,next)=>{
    security(c);const url=new URL(c.req.url),host=c.req.header('Host'),path=url.pathname;
    requireCondition(url.origin===origin&&url.href===c.req.url&&!/[?#%\\\x00-\x20\x7f-\uffff]/.test(c.req.url)
      &&(host===undefined||host===u.host),403,'host_rejected','Host rejected.');
    const match=new RegExp('^'+base+'/([0-9a-f-]{36})$(?![\\s\\S])').exec(path),method=path===base?'POST':match?'GET':undefined;
    if(!method)throw new Problem(404,'not_found','Not found.');
    if(c.req.method!==method){c.header('Allow',method);throw new Problem(405,'method_not_allowed','Method rejected.');}
    if(match)OpaqueId.parse(match[1]);
    const sentOrigin=c.req.header('Origin'),site=c.req.header('Sec-Fetch-Site');
    requireCondition((sentOrigin===undefined||sentOrigin===origin)&&(method==='GET'||sentOrigin===origin)
      &&(site===undefined||site==='same-origin'),403,'origin_rejected','Origin rejected.');
    requireCondition(['Authorization','DPoP','X-Freedom-Connection','X-Freedom-Nonce'].every(h=>c.req.header(h)===undefined),403,'credential_kind_rejected','Credential rejected.');
    requireCondition(c.req.header('Content-Encoding')===undefined,415,'encoding_rejected','Encoding unsupported.');
    requireCondition(['If-None-Match','If-Modified-Since','If-Unmodified-Since','If-Range','Range'].every(h=>c.req.header(h)===undefined),400,'read_headers_rejected','Conditional headers unsupported.');
    readSessionCookie(c.req.header('Cookie'),origin);
    if(method==='GET')requireCondition(c.req.raw.body===null&&['Idempotency-Key','If-Match','Content-Length','Transfer-Encoding'].every(h=>c.req.header(h)===undefined),400,'read_headers_rejected','Read headers rejected.');
    else{key(c);version(c);}
    let network=SHARED_NETWORK_KEY;
    if(sourceNetwork){try{network=sourceNetwork(c.req.raw);if(typeof network!=='string'||!/^[\x21-\x7e]{1,200}$(?![\s\S])/.test(network))throw new Error();}
      catch{throw new Problem(503,'credential_ingest_unavailable','Source unavailable.');}}
    try{await chargeBootstrapHttp(pool,environment,clientId,'execution_member',network);}
    catch(error){if(error instanceof Problem&&error.code==='bootstrap_http_rate_limited')throw new Problem(429,'credential_ingest_rate_limited','Rate limited.');throw new Problem(503,'credential_ingest_unavailable','Request unavailable.');}
    await boundary(c,next);
  });
  app.all('*',async c=>{
    const actor=c.get('actor'),path=new URL(c.req.url).pathname;
    if(c.req.method==='GET')return c.json(CredentialIngestOwnerOutcomeSchema.parse(await ingest.readOwnerOutcome(actor,path.slice(base.length+1))));
    const input=CredentialIngestIssueInputSchema.parse(await readBoundedHttpJson(c.req.raw));
    const command=input.operation==='create'?{operation:'create' as const,input:{key:key(c),modelConnectionId:input.modelConnectionId,
      expectedModelVersion:version(c),consent:true as const}}:{operation:'rotate' as const,input:{key:key(c),credentialId:input.credentialId,
      expectedVersion:version(c),replacementModelConnectionId:input.replacementModelConnectionId,
      expectedReplacementModelVersion:input.expectedReplacementModelVersion,consent:true as const}};
    return c.json(CredentialIngestHandoffSchema.parse(await ingest.issue(actor,{command})),201);
  });
  return app;
}
