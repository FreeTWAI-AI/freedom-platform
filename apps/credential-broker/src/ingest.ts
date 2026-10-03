import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { BrokerModelSelectionSchema, type ModelCredentialBinding } from '../../../contracts/execution/v2/model-credential.js';
import * as c from '../../../contracts/execution/v2/model-credential-ingest.js';
import { RuntimeEnvironmentSchema } from '../../../contracts/execution/v1/runtime-registration.js';
import { BootstrapClientIdSchema } from '../../../contracts/execution/v1/bootstrap.js';
import type { CredentialIngestAuthorizations, CredentialIngestInvocationData, OpaqueCredentialIngestInvocation } from '../../../modules/agent-control/credential-ingest-authorizations.js';
import { withMemberScope } from '../../../packages/resource-scopes/index.js';
import { Problem } from '../../../packages/shared/problem.js';
import type { RecoveryObservation } from '../../../modules/agent-execution/model-step-host.js';
import { createBrokerCredentialStore, getCredentialWriteIntentMetadata, type OpaqueCredentialWriteIntent } from './store.js';
import type { CredentialVault } from './vault.js';
import { createCredentialIngestCrypto, type CredentialIngestCryptoOptions } from './ingest-crypto.js';

export interface CredentialIngestBodyLimits {maxBytes:number;maxChunks:number;timeoutMs:number;expiresAt:string;monotonicDeadline:number}
/** Trusted lazy transport port. It must own/zero its byte buffers and late
 * chunks. Calling it is forbidden until submission acceptance has committed. */
export interface CredentialIngestBodyPort {read(limits:CredentialIngestBodyLimits):Promise<Uint8Array>;signal?:AbortSignal}
export interface ProtectedCredentialSetupDto {selection:BrokerModelSelection;operation:'create'|'rotate';modelConnectionId:string;
  csrfToken:string;expiresAt:string;operational_authority:false}
type BrokerModelSelection=ModelCredentialBinding['selection'];
export interface CredentialIngestServiceOptions extends CredentialIngestCryptoOptions {
  cipherPool:Pool;mainOrigin:string;vault:CredentialVault;recover:()=>Promise<RecoveryObservation>;
  authorizations:CredentialIngestAuthorizations;
  assertProtectedSurface:(input:Readonly<{origin:string;purpose:'credential-ingest'}>)=>Promise<void>;
  maxSetups?:number;
}
const problem=(code='credential_ingest_unavailable',status=503):never=>{throw new Problem(status,code,'Credential setup is unavailable.');};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export function credentialIngestOrigins(mainOrigin:string,setupOrigin:string):void {
  for(const value of[mainOrigin,setupOrigin]){
    if(typeof value!=='string'||/[?#%\\\x00-\x20\x7f-\uffff]/.test(value))problem();
    const url=new URL(value);if(url.protocol!=='https:'||url.origin!==value||url.username||url.password||!url.hostname
      ||url.hostname==='localhost'||/^[0-9.]+$/.test(url.hostname)||url.hostname.startsWith('['))problem();
  }
  if(new URL(mainOrigin).hostname===new URL(setupOrigin).hostname)problem();
}
class Fence {
  cancelled=false;readonly end:number;readonly expires:number;
  constructor(expiresAt:string){this.expires=Date.parse(expiresAt);this.end=performance.now()+this.expires-Date.now();this.assert();}
  assert(){if(this.cancelled||Date.now()>=this.expires||performance.now()>=this.end)problem('credential_ingest_authorization_invalid',403);}
  watch(signal?:AbortSignal){const abort=()=>{this.cancelled=true;};if(signal?.aborted)abort();signal?.addEventListener('abort',abort,{once:true});
    return()=>signal?.removeEventListener('abort',abort);}
  async wait<T>(operation:()=>Promise<T>,maxMs=Infinity,discard?:(value:T)=>void):Promise<T>{
    this.assert();const end=Math.min(this.end,performance.now()+maxMs);let timer:ReturnType<typeof setTimeout>|undefined,expired=false;
    const work=Promise.resolve().then(()=>{this.assert();return operation();}).then(value=>{
      if(expired||this.cancelled||performance.now()>=end||Date.now()>=this.expires){discard?.(value);problem('credential_ingest_authorization_invalid',403);}return value;
    });
    try{const value=await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{expired=true;this.cancelled=true;
      reject(new Problem(503,'credential_ingest_unavailable','Credential setup is unavailable.'));},Math.max(0,end-performance.now()));})]);this.assert();return value;}
    catch(error){this.cancelled=true;throw error;}finally{if(timer)clearTimeout(timer);}
  }
}
interface Setup {invocation:OpaqueCredentialIngestInvocation;data:CredentialIngestInvocationData;cookieHash:string;csrfHash:string;
  expiresAt:string;end:number;phase:'setup'|'preparing'|'prepared'|'submitting';intent?:OpaqueCredentialWriteIntent;writeExpiresAt?:string;writeEnd?:number}

/** All actor/command provenance remains in the original SQL authorization and
 * genuine store/vault instances. No cookie or DTO recreates private evidence. */
export async function createCredentialIngestService(options:CredentialIngestServiceOptions) {
  const desc=Object.getOwnPropertyDescriptors(options);
  const required=['cipherPool','mainOrigin','setupOrigin','environment','clientId','vault','recover','authorizations','issuer','requestAudience',
    'requestKeys','responseSigningKey','responseKeyId','responseIssuer','responseAudience','assertProtectedSurface'];
  if(Object.getPrototypeOf(options)!==Object.prototype||Reflect.ownKeys(options).some(k=>typeof k!=='string'||![...required,'maxSetups'].includes(k))
    ||required.some(k=>!desc[k]?.enumerable||!('value'in desc[k]))||Object.values(desc).some(d=>!d.enumerable||!('value'in d)))problem();
  const mainOrigin=desc.mainOrigin.value as string,setupOrigin=desc.setupOrigin.value as string;credentialIngestOrigins(mainOrigin,setupOrigin);
  const environment=RuntimeEnvironmentSchema.parse(desc.environment.value),clientId=BootstrapClientIdSchema.parse(desc.clientId.value);
  const pool=desc.cipherPool.value as Pool,vault=desc.vault.value as CredentialVault,recover=desc.recover.value as ()=>Promise<RecoveryObservation>;
  const authority=desc.authorizations.value as CredentialIngestAuthorizations,capture=desc.assertProtectedSurface.value as CredentialIngestServiceOptions['assertProtectedSurface'];
  const max=desc.maxSetups?.value??128;
  if(!pool||typeof pool.connect!=='function'||typeof capture!=='function'||!Number.isInteger(max)||max<1||max>128||!authority
    ||['claimBootstrap','read','claimSubmission','assertCurrent'].some(k=>typeof(authority as unknown as Record<string,unknown>)[k]!=='function'))problem();
  const claimBootstrap=authority.claimBootstrap.bind(authority),read=authority.read.bind(authority),claimSubmission=authority.claimSubmission.bind(authority),assertCurrent=authority.assertCurrent.bind(authority);
  const store=createBrokerCredentialStore(pool,{environment,clientId,vault,recover});
  const cryptoPort=await createCredentialIngestCrypto({environment,clientId,issuer:desc.issuer.value!,requestAudience:desc.requestAudience.value!,setupOrigin,
    requestKeys:desc.requestKeys.value!,responseSigningKey:desc.responseSigningKey.value!,responseKeyId:desc.responseKeyId.value!,responseIssuer:desc.responseIssuer.value!,responseAudience:desc.responseAudience.value!});
  const setups=new Map<string,Setup>();let pending=0;
  function prune(){for(const[key,s]of setups)if(Date.now()>=Date.parse(s.expiresAt)||performance.now()>=s.end)setups.delete(key);}
  function locate(cookie:string,csrf?:string):Setup {
    prune();if(typeof cookie!=='string'||!/^[A-Za-z0-9_-]{43}$(?![\s\S])/.test(cookie))problem('credential_ingest_registry_unavailable',403);
    const s=setups.get(hash(cookie));if(!s)problem('credential_ingest_registry_unavailable',403);
    if(csrf!==undefined){if(!/^[A-Za-z0-9_-]{43}$(?![\s\S])/.test(csrf)||!timingSafeEqual(Buffer.from(hash(csrf),'hex'),Buffer.from(s!.csrfHash,'hex')))problem('credential_ingest_authorization_invalid',403);}
    return s!;
  }
  function fence(s:Setup,write=false){const f=new Fence(write?s.writeExpiresAt!:s.expiresAt);
    Object.defineProperty(f,'end',{value:Math.min(f.end,s.end,write?s.writeEnd!:Infinity)});f.assert();return f;}
  async function readiness(f:Fence){await f.wait(()=>capture(Object.freeze({origin:setupOrigin,purpose:'credential-ingest' as const})),1000);}
  function guard(s:Setup,f:Fence){return async(q:PoolClient)=>{f.assert();await assertCurrent(q,s.invocation);f.assert();};}
  async function current(s:Setup,f:Fence){const g=guard(s,f);await f.wait(()=>withMemberScope(pool,{actor:s.data.actor,scope:'personal'},g,async q=>g(q)));f.assert();}
  return Object.freeze({
    async bootstrap(assertion:string,signal?:AbortSignal):Promise<{cookieToken:string;csrfToken:string;setup:ProtectedCredentialSetupDto}>{
      prune();if(setups.size+pending>=max)problem('credential_ingest_registry_unavailable');pending++;
      let installed:string|undefined,unwatch:(()=>void)|undefined;
      try{
        const claims=await cryptoPort.verify(assertion),f=new Fence(claims.expiresAt);unwatch=f.watch(signal);await readiness(f);
        const cookieToken=randomBytes(32).toString('base64url'),csrfToken=randomBytes(32).toString('base64url'),cookieHash=hash(cookieToken),csrfHash=hash(csrfToken);
        const invocation=await f.wait(()=>claimBootstrap(claims,{cookieHash,csrfHash})),data=read(invocation);
        if(data.authorizationRef!==claims.authorizationRef||data.nonce!==claims.nonce||data.commandDigest!==claims.commandDigest
          ||data.recoveryGeneration!==claims.recoveryGeneration||data.command.operation!==claims.operation)problem();
        const selection=BrokerModelSelectionSchema.parse(data.model.selection);
        const expiresAt=new Date(Math.min(Date.parse(claims.expiresAt),Date.parse(data.expiresAt),Date.parse(data.setupExpiresAt))).toISOString();
        const s:Setup={invocation,data,cookieHash,csrfHash,expiresAt,end:Math.min(f.end,performance.now()+Date.parse(expiresAt)-Date.now()),phase:'setup'};
        await current(s,f);await readiness(f);f.assert();setups.set(cookieHash,s);installed=cookieHash;
        return {cookieToken,csrfToken,setup:Object.freeze({selection,operation:data.command.operation,modelConnectionId:data.model.modelConnectionId,
          csrfToken,expiresAt,operational_authority:false})};
      }catch(error){if(installed)setups.delete(installed);throw error;}finally{unwatch?.();pending--;}
    },
    async assertSetupCurrent(cookie:string):Promise<void>{const s=locate(cookie),f=fence(s);await current(s,f);await readiness(f);f.assert();},
    async prepare(cookie:string,csrf:string,signal?:AbortSignal):Promise<{expiresAt:string;operational_authority:false}>{
      const s=locate(cookie,csrf);if(s.phase!=='setup')problem('credential_ingest_submission_consumed',409);s.phase='preparing';const f=fence(s);
      const unwatch=f.watch(signal);try{
        await current(s,f);await readiness(f);const g=guard(s,f),command=s.data.command,prepareEnd=performance.now()+c.CredentialIngestLimits.writeMs;
        const intent=await f.wait(()=>command.operation==='create'?store.prepareCreate(s.data.actor,command.input,g):store.prepareRotate(s.data.actor,command.input,g));
        const metadata=getCredentialWriteIntentMetadata(intent);f.assert();
        s.writeExpiresAt=new Date(Math.min(Date.parse(metadata.expiresAt),Date.parse(s.expiresAt))).toISOString();
        s.writeEnd=Math.min(s.end,prepareEnd,performance.now()+Date.parse(s.writeExpiresAt)-Date.now());s.intent=intent;s.phase='prepared';
        const w=fence(s,true);w.assert();return {expiresAt:s.writeExpiresAt,operational_authority:false};
      }catch(error){f.cancelled=true;setups.delete(s.cookieHash);throw error;}finally{unwatch();}
    },
    async submit(cookie:string,csrf:string,body:CredentialIngestBodyPort):Promise<c.CredentialIngestResponseEnvelope>{
      const s=locate(cookie,csrf);if(s.phase!=='prepared'||!s.intent)problem('credential_ingest_submission_consumed',409);
      if(!body||typeof body.read!=='function')problem();const readBody=body.read.bind(body);s.phase='submitting';const f=fence(s,true);const unwatch=f.watch(body.signal);let bytes:Uint8Array|undefined;
      try{
        await current(s,f);await readiness(f);const metadata=getCredentialWriteIntentMetadata(s.intent!);
        await f.wait(()=>claimSubmission(s.invocation,{binding:metadata.binding,writeExpiresAt:s.writeExpiresAt!,cookieHash:s.cookieHash,csrfHash:s.csrfHash}));
        await current(s,f);await readiness(f);f.assert();
        bytes=await f.wait(()=>readBody({maxBytes:c.CredentialIngestLimits.secretBytes,maxChunks:c.CredentialIngestLimits.chunks,
          timeoutMs:c.CredentialIngestLimits.bodyMs,expiresAt:s.writeExpiresAt!,monotonicDeadline:f.end}),c.CredentialIngestLimits.bodyMs,value=>value.fill(0));
        if(!(bytes instanceof Uint8Array)||bytes.length<1||bytes.length>c.CredentialIngestLimits.secretBytes)problem();
        for(const v of bytes)if(!(v>=48&&v<=57||v>=65&&v<=90||v>=97&&v<=122||v===46||v===95||v===45))problem();
        await current(s,f);f.assert();const sealed=await f.wait(()=>vault.seal(metadata.binding,bytes!));f.assert();
        const credential=await f.wait(()=>store.commit(s.data.actor,s.intent!,sealed,guard(s,f)));f.assert();
        return await cryptoPort.response(s.data,{kind:'metadata',credential});
      }catch(error){
        f.cancelled=true;const parsed=c.CredentialIngestProblemCodeSchema.safeParse((error as {code?:unknown})?.code);
        return cryptoPort.response(s.data,{kind:'problem',code:parsed.success?parsed.data:'credential_ingest_outcome_unknown'});
      }finally{f.cancelled=true;bytes?.fill(0);setups.delete(s.cookieHash);unwatch();}
    },
  });
}
export type CredentialIngestService=Awaited<ReturnType<typeof createCredentialIngestService>>;
