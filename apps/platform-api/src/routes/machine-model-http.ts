import {Hono,type Context} from 'hono';
import {z} from 'zod';
import type {Pool} from 'pg';
import {OpaqueId} from '../../../../contracts/common/v1/identity.js';
import {MemberExecutionVersionSchema} from '../../../../contracts/execution/v1/member-execution.js';
import {ModelStepMetadataSchema} from '../../../../contracts/execution/v2/model-step.js';
import {MachineTextLimits,type MachineTextHost} from '../../../../contracts/execution/v3/machine-text-execution.js';
import {createMachineTextAuthority} from '../../../../modules/agent-control/machine-text-authority.js';
import {parseMachineTextHost,machineTextRequestHash} from '../../../../modules/agent-control/machine-text-proof.js';
import {createMachineModelStepService,MachineDispatchEvidenceSchema} from '../../../../modules/agent-execution/machine-model-step.js';
import type {ModelStepHost} from '../../../../modules/agent-execution/model-step-host.js';
import {AdapterFault} from '../../../../modules/agent-execution/adapters/common.js';
import type {ObjectStore} from '../../../../packages/asset-storage/index.js';
import {readBoundedHttpJsonPayload} from '../../../../packages/execution-state/http-body.js';
import {ExecutionInputError} from '../../../../packages/execution-state/decode.js';
import {Problem,requireCondition} from '../../../../packages/shared/problem.js';
import {chargeBootstrapHttp} from '../../../../modules/agent-control/bootstrap-http-limits.js';
import {SHARED_NETWORK_KEY} from '../runtime.js';

const base='/execution-api/v1/model-steps';
const Device=z.object({connectionId:OpaqueId,familyId:OpaqueId}).strict();
const Activation=Device.extend({challengeId:OpaqueId,nonce:z.string().regex(/^[A-Za-z0-9_-]{43}$(?![\s\S])/),approvalId:OpaqueId,expectedRunVersion:MemberExecutionVersionSchema}).strict();
const Empty=z.object({}).strict();
type Route={name:'challenge'|'activate'|'execute'|'status'|'evidence';method:'POST'|'GET';id?:string};
function route(path:string):Route|undefined{
  if(path===base+'/challenge')return {name:'challenge',method:'POST'};
  if(path===base)return {name:'activate',method:'POST'};
  const m=/^\/execution-api\/v1\/model-steps\/([0-9a-f-]{36})(\/(execute|evidence))?$(?![\s\S])/.exec(path);
  if(m&&OpaqueId.safeParse(m[1]).success)return {name:(m[3] as 'execute'|'evidence')??'status',method:m[3]?'POST':'GET',id:m[1]};
}
function security(c:Context){for(const [name,value] of Object.entries({'Cache-Control':'private, no-store','Pragma':'no-cache','Vary':'Origin, Cookie, Authorization, DPoP',
  'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow','Cross-Origin-Resource-Policy':'same-origin'}))c.header(name,value);}
const safe=new Set(['machine_text_unauthorized','machine_model_operation_denied','machine_model_profile_unavailable','machine_activation_consumed','model_step_binding_stale','model_step_already_consumed',
  'idempotency_conflict','version_conflict','body_too_large','body_timeout','invalid_body','invalid_json','json_required','host_rejected','origin_rejected','credential_kind_rejected','encoding_rejected',
  'method_not_allowed','not_found','idempotency_required','version_required','invalid_version','read_headers_rejected','machine_model_http_rate_limited','machine_model_http_unavailable','request_aborted']);
/** Explicit machine-purpose transport. This factory performs actual signed
 * device/SQL admission; installing it requires fixed host keys and real model
 * ports. Member cookies and bootstrap tokens cannot enter this authority. */
export function createMachineModelHttpTransport(pool:Pool,options:{host:MachineTextHost;signingKey:CryptoKey;modelHost:ModelStepHost;store:ObjectStore;sourceNetwork?:(request:Request)=>string}){
  const descriptors=Object.getOwnPropertyDescriptors(options);
  if(Object.getPrototypeOf(options)!==Object.prototype||Reflect.ownKeys(options).some(k=>typeof k!=='string'||!['host','signingKey','modelHost','store','sourceNetwork'].includes(k))
    ||['host','signingKey','modelHost','store'].some(k=>!descriptors[k])||Object.values(descriptors).some(d=>!d.enumerable||!('value'in d)))throw Error('invalid_machine_model_http_configuration');
  const host=parseMachineTextHost(descriptors.host.value),origin=host.origin,hostname=new URL(origin).host,network=descriptors.sourceNetwork?.value;
  if(network!==undefined&&typeof network!=='function')throw Error('invalid_machine_model_http_configuration');
  const authority=createMachineTextAuthority(pool,host,descriptors.signingKey.value as CryptoKey),service=createMachineModelStepService(pool,{environment:host.environment,clientId:host.clientId,authority,
    host:descriptors.modelHost.value as ModelStepHost,store:descriptors.store.value as ObjectStore});
  const app=new Hono();
  app.onError((error,c)=>{security(c);let status=500,code='internal_error';
    if(error instanceof z.ZodError||error instanceof ExecutionInputError){status=400;code='validation_failed';}
    else if(error instanceof AdapterFault){status=503;code=error.code==='outcome_unknown'?'model_step_outcome_unknown':'model_authentication_unavailable';}
    else if(error instanceof Problem&&safe.has(error.code)){status=error.status;code=error.code;}
    else if(['23514','23503','23505'].includes((error as {code?:string}).code??'')){status=401;code='machine_text_unauthorized';}
    return c.json({type:'about:blank',title:code,status,code,detail:'Request could not be completed.'},status as 400);
  });
  app.use('*',async(c,next)=>{security(c);const url=new URL(c.req.url),r=route(url.pathname);
    requireCondition(url.origin===origin&&url.href===c.req.url&&!/[?#%\\\x00-\x20\x7f-\uffff]/.test(c.req.url)
      &&(!c.req.header('Host')||c.req.header('Host')===hostname),403,'host_rejected','Host rejected.');
    if(!r)throw new Problem(404,'not_found','Not found.');
    if(c.req.method!==r.method){c.header('Allow',r.method);throw new Problem(405,'method_not_allowed','Method rejected.');}
    requireCondition(c.req.header('Origin')===undefined&&c.req.header('Sec-Fetch-Site')===undefined,403,'origin_rejected','Origin rejected.');
    requireCondition(['Cookie','X-CSRF-Token','X-Freedom-Connection','X-Freedom-Nonce'].every(h=>c.req.header(h)===undefined),403,'credential_kind_rejected','Credential rejected.');
    requireCondition(c.req.header('Content-Encoding')===undefined,415,'encoding_rejected','Encoding rejected.');
    requireCondition(['If-None-Match','If-Modified-Since','If-Unmodified-Since','If-Range','Range'].every(h=>c.req.header(h)===undefined),400,'read_headers_rejected','Headers rejected.');
    if(r.name==='status'||r.name==='challenge')requireCondition(['Idempotency-Key','If-Match'].every(h=>c.req.header(h)===undefined),400,'read_headers_rejected','Headers rejected.');
    if(r.method==='GET')requireCondition(c.req.raw.body===null&&['Content-Length','Transfer-Encoding','Content-Type'].every(h=>c.req.header(h)===undefined),400,'read_headers_rejected','Headers rejected.');
    const compact=c.req.header('DPoP')??'';requireCondition(compact.length<=MachineTextLimits.compactBytes&&/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$(?![\s\S])/.test(compact),401,'machine_text_unauthorized','Credential rejected.');
    if(r.name==='challenge'||r.name==='activate')requireCondition(c.req.header('Authorization')===undefined,403,'credential_kind_rejected','Credential rejected.');
    let source=SHARED_NETWORK_KEY;try{if(network){source=network(c.req.raw);if(typeof source!=='string'||!/^\S{1,200}$(?![\s\S])/.test(source))throw Error();}
      await chargeBootstrapHttp(pool,host.environment,host.clientId,'execution_machine',source);
    }catch(error){if(error instanceof Problem&&error.status===429)throw new Problem(429,'machine_model_http_rate_limited','Rate limited.');throw new Problem(503,'machine_model_http_unavailable','Unavailable.');}
    await next();
  });
  app.all('*',async c=>{const r=route(new URL(c.req.url).pathname)!,proof=c.req.header('DPoP')!,path=new URL(c.req.url).pathname;
    const key=r.name==='status'||r.name==='challenge'?null:c.req.header('Idempotency-Key')??'';
    if(key!==null)requireCondition(/^[A-Za-z0-9_-]{8,128}$(?![\s\S])/.test(key),400,'idempotency_required','Key required.');
    let version:string|null=null;
    if(key!==null){const v=c.req.header('If-Match');requireCondition(v,428,'version_required','Version required.');requireCondition(/^"[1-9][0-9]{0,18}"$(?![\s\S])/.test(v!),400,'invalid_version','Invalid version.');version=MemberExecutionVersionSchema.parse(v!.slice(1,-1));}
    const payload=r.method==='GET'?{value:{},bytes:new Uint8Array()}:await readBoundedHttpJsonPayload(c.req.raw);
    const requestSha256=machineTextRequestHash(r.method,path,payload.bytes,key,version);
    requireCondition(!c.req.raw.signal.aborted,400,'request_aborted','Request aborted.');
    if(r.name==='challenge'){const input=Device.parse(payload.value);return c.json(await authority.challenge({...input,proof,requestSha256}),201);}
    if(r.name==='activate'){const {approvalId,expectedRunVersion,...device}=Activation.parse(payload.value);
      const result=await service.activate({...device,proof,requestSha256},{approvalId,expectedRunVersion,key:key!,expectedApprovalVersion:version!},c.req.raw.signal);
      return c.json({metadata:ModelStepMetadataSchema.parse(result.metadata),credentials:result.credentials},201);}
    const match=/^DPoP ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$(?![\s\S])/.exec(c.req.header('Authorization')??'');
    requireCondition(match&&match[1].length<=MachineTextLimits.compactBytes,401,'machine_text_unauthorized','Credential rejected.');
    const admission={accessToken:match![1],proof,requestSha256,operation:r.name};
    if(r.name==='evidence'){requireCondition(version==='1',400,'invalid_version','Invalid version.');return c.json(await service.evidence(admission,r.id!,key!,MachineDispatchEvidenceSchema.parse(payload.value)));}
    Empty.parse(payload.value);
    const result=r.name==='status'?await service.read(admission,{stepId:r.id!}):(await service.execute(admission,{stepId:r.id!,key:key!,expectedVersion:version!},c.req.raw.signal)).metadata;
    return c.json(ModelStepMetadataSchema.parse(result));
  });return app;
}
