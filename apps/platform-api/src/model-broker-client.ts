import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { base64url, compactVerify, CompactSign } from 'jose';
import type { Actor } from '../../../modules/identity-membership/service.js';
import { createModelBrokerAuthorizations } from '../../../modules/agent-control/model-broker-authorizations.js';
import { createModelStepService } from '../../../modules/agent-execution/model-step-service.js';
import { createUnavailableModelStepHost, type RecoveryObservation } from '../../../modules/agent-execution/model-step-host.js';
import { ModelBrokerLimits as limits, ModelBrokerAssertionPayloadSchema, ModelBrokerCommandSchema,
  ModelBrokerProtectedHeaderSchema, ModelBrokerRequestSchema, ModelBrokerResponseEnvelopeSchema,
  ModelBrokerResponsePayloadSchema, ModelBrokerResponseProtectedHeaderSchema,
  type ModelBrokerCommand, type ModelBrokerRequest, type ModelBrokerResponseEnvelope } from '../../../contracts/execution/v2/model-broker-bridge.js';
import type { RuntimeEnvironment } from '../../../contracts/execution/v1/runtime-registration.js';
import type { ModelStepActivateInput, ModelStepBeginInput, ModelStepMetadata } from '../../../contracts/execution/v2/model-step.js';
import { freezeTree, parseBoundedJson, snapshotInput } from '../../../packages/execution-state/decode.js';
import { CredentialRecoveryFloorSchema } from '../../../contracts/execution/v2/model-credential.js';
import { Problem } from '../../../packages/shared/problem.js';

declare const brokerClientBrand: unique symbol;
export interface ModelBrokerClient { readonly [brokerClientBrand]: never }
export interface ModelBrokerClientOptions {
  origin: string; environment: RuntimeEnvironment; clientId: string; issuer: string; audience: string;
  requestKey: CryptoKey; requestKid: string; responseKeys: ReadonlyMap<string,CryptoKey>;
  brokerIdentity: string; responseAudience: string; recover: () => Promise<RecoveryObservation>;
  exchange: (request: ModelBrokerRequest) => Promise<ModelBrokerResponseEnvelope>;
}
type Client = { pool: Pool; origin: string; environment: string; clientId: string;
  activate: (actor:Actor,input:ModelStepActivateInput)=>Promise<ModelStepMetadata>;
  execute: (actor:Actor,input:ModelStepBeginInput)=>Promise<ModelStepMetadata> };
const clients=new WeakMap<object,Client>();
function unavailable():never { throw new Problem(503,'model_broker_unavailable','Model execution is unavailable.'); }
function segment(raw:string,maximum:number):Uint8Array {
  if (!/^[A-Za-z0-9_-]+$(?![\s\S])/.test(raw)||raw.length>Math.ceil(maximum*4/3)) unavailable();
  const bytes=base64url.decode(raw);
  if(bytes.byteLength>maximum||base64url.encode(bytes)!==raw) unavailable();
  return bytes;
}
function json(bytes:Uint8Array):unknown {
  const parsed=parseBoundedJson(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes));let nodes=0;
  const visit=(value:unknown,depth:number)=>{if(++nodes>limits.jsonNodes||depth>limits.jsonDepth)unavailable();
    if(value&&typeof value==='object')for(const child of Object.values(value))visit(child,depth+1);};
  visit(parsed,0);return parsed;
}
/** Main-side reference issuer. It has no credential resolver, provider host,
 * ciphertext pool, KEK, context bytes or Result finalizer. */
export async function createModelBrokerClient(pool:Pool,options:ModelBrokerClientOptions):Promise<ModelBrokerClient> {
  if(!options||Object.getPrototypeOf(options)!==Object.prototype) unavailable();
  const d=Object.getOwnPropertyDescriptors(options),names=['origin','environment','clientId','issuer','audience','requestKey','requestKid',
    'responseKeys','brokerIdentity','responseAudience','recover','exchange'];
  if(Reflect.ownKeys(options).length!==names.length||names.some(k=>!d[k]?.enumerable||!('value'in d[k])))unavailable();
  const {origin,environment,clientId,issuer,audience,requestKey,requestKid,brokerIdentity,responseAudience,recover,exchange}=options;
  const authorizations=createModelBrokerAuthorizations(pool,{environment,clientId,issuer,audience,recover});
  const url=new URL(origin);
  if(url.origin!==origin||url.username||url.password||url.hash||url.search
    ||(url.protocol!=='https:'&&(url.protocol!=='http:'||environment!=='local'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)))
    ||typeof exchange!=='function'||typeof recover!=='function'||issuer===brokerIdentity||audience===responseAudience
    ||![issuer,audience,brokerIdentity,responseAudience].every(s=>typeof s==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$(?![\s\S])/.test(s))
    ||!(requestKey instanceof CryptoKey)||requestKey.type!=='private'||requestKey.algorithm.name!=='Ed25519'||!requestKey.usages.includes('sign'))unavailable();
  const header=ModelBrokerProtectedHeaderSchema.parse({alg:'EdDSA',typ:'freedom-model-broker-assertion+jws',kid:requestKid});
  if(!options.responseKeys||options.responseKeys.size<1||options.responseKeys.size>16)unavailable();
  const responseKeys=new Map<string,CryptoKey>();
  for(const [kid,key] of options.responseKeys){ModelBrokerResponseProtectedHeaderSchema.parse({alg:'EdDSA',typ:'freedom-model-broker-response+jws',kid});
    if(!(key instanceof CryptoKey)||key.type!=='public'||key.algorithm.name!=='Ed25519'||key.usages.length!==1||key.usages[0]!=='verify')unavailable();
    responseKeys.set(kid,key);}
  const separation=new TextEncoder().encode('freedom/model-broker/key-direction-separation/v1');
  const signed=await crypto.subtle.sign('Ed25519',requestKey,separation);
  for(const key of responseKeys.values())if(await crypto.subtle.verify('Ed25519',key,signed,separation))unavailable();
  const steps=createModelStepService(pool,{environment,clientId,host:createUnavailableModelStepHost()});
  async function call(actor:Actor,raw:ModelBrokerCommand):Promise<ModelStepMetadata> {
    actor=Object.freeze({...actor});const command=freezeTree(ModelBrokerCommandSchema.parse(snapshotInput(raw)));
    const claims=ModelBrokerAssertionPayloadSchema.parse(await authorizations.issue(actor,{operation:command.operation,command,nonce:randomBytes(32).toString('base64url')}));
    let timer:ReturnType<typeof setTimeout>|undefined;let cancelled=false;const started=performance.now();
    const active=()=>{if(cancelled||performance.now()-started>=45_000||Date.parse(claims.expiresAt)<=Date.now())unavailable();};
    const freshRecovery=async()=>{active();const r=CredentialRecoveryFloorSchema.parse(snapshotInput(await recover()));
      active();if(r.generation!==claims.recoveryGeneration||Date.parse(r.expiresAt)<=Date.now()||Date.parse(claims.expiresAt)<=Date.now())unavailable();};
    try {
      const perform=async()=>{
        await freshRecovery();
        const assertion=await new CompactSign(new TextEncoder().encode(JSON.stringify(claims))).setProtectedHeader(header).sign(requestKey);
        const request=freezeTree(ModelBrokerRequestSchema.parse({authorizationRef:claims.authorizationRef,nonce:claims.nonce,assertion}));
        await freshRecovery();
        active();const rawResponse=await exchange(request);active();
        const envelope=ModelBrokerResponseEnvelopeSchema.parse(snapshotInput(rawResponse)),parts=envelope.response.split('.');
        const h=ModelBrokerResponseProtectedHeaderSchema.parse(json(segment(parts[0],limits.headerBytes)));
        if(segment(parts[2],64).byteLength!==64)unavailable();
        const key=responseKeys.get(h.kid);if(!key)unavailable();
        await compactVerify(envelope.response,key,{algorithms:['EdDSA']});
        const response=ModelBrokerResponsePayloadSchema.parse(json(segment(parts[1],limits.payloadBytes)));
        const now=Date.now(),issued=Date.parse(response.issuedAt),expiry=Date.parse(response.expiresAt);
        if(response.issuer!==brokerIdentity||response.audience!==responseAudience||response.environment!==environment||response.clientId!==clientId
          ||response.authorizationRef!==claims.authorizationRef||response.nonce!==claims.nonce||response.commandDigest!==claims.commandDigest
          ||response.recoveryGeneration!==claims.recoveryGeneration||issued>now||expiry<=now||expiry<=issued||expiry-issued>limits.responseMs)unavailable();
        await freshRecovery();
        if(response.outcome.kind==='problem')throw new Problem(503,response.outcome.code,'Model execution is unavailable.');
        if(command.operation==='execute'&&response.outcome.step.stepId!==command.input.stepId)unavailable();
        // Signed metadata cannot manufacture a Step, an opaque proof or Result.
        // Read existing owner/session-authorized SQL after verifying the reply.
        await freshRecovery();
        const stepId=response.outcome.step.stepId;
        const latest=await steps.read(actor,{stepId},async q=>{
          if(command.operation==='activate'){
            const row=await q.query('SELECT approval_id FROM model_text_steps WHERE step_id=$1 AND owner_user_id=$2',[stepId,actor.user_id]);
            if(row.rows[0]?.approval_id!==command.input.approvalId)unavailable();
          }
          active();
        });
        // No recovery/network await after the final owner/session transaction.
        active();return latest;
      };
      return await Promise.race([perform(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{cancelled=true;reject(new Problem(503,'model_broker_unavailable','Model execution is unavailable.'));},45_000);})]);
    } catch(error){if(error instanceof Problem&&error.code.startsWith('model_broker_')||error instanceof Problem&&error.code.startsWith('model_step_'))throw error;return unavailable();}
    finally{cancelled=true;if(timer)clearTimeout(timer);}
  }
  const port=Object.freeze(Object.create(null)) as ModelBrokerClient;
  clients.set(port,{pool,origin,environment,clientId,activate:(actor,input)=>call(actor,{operation:'activate',input}),execute:(actor,input)=>call(actor,{operation:'execute',input})});
  return port;
}
export function bindModelBrokerClient(port:ModelBrokerClient,pool:Pool,origin:string,environment:string,clientId:string) {
  const client=port&&typeof port==='object'?clients.get(port):undefined;
  if(!client||client.pool!==pool||client.origin!==origin||client.environment!==environment||client.clientId!==clientId)unavailable();
  return Object.freeze({activate:client.activate,execute:client.execute});
}
