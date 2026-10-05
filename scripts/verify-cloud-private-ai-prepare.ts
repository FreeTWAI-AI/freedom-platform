// Operator-invoked staging pairing/model preparation. No SQL or provider calls.
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {isAbsolute,join} from 'node:path';
import {CompactSign,calculateJwkThumbprint} from 'jose';
import {z} from 'zod';
import {DeviceAuthorizationBeginResultSchema,DeviceAuthorizationReviewSchema,DeviceAuthorizationDecisionResultSchema,DeviceAuthorizationPollResultSchema} from '../contracts/execution/v1/device-pairing.js';
import {RuntimePublicJwkSchema} from '../contracts/execution/v1/runtime-registration.js';
import {ModelConnectionMetadataSchema} from '../contracts/execution/v1/member-execution.js';
import {MemberModelSettingsOverviewSchema} from '../contracts/execution/v2/member-model-settings.js';
import {createRuntimeRegistrationChallenge} from '../modules/agent-control/runtime-proof.js';
import {durableCreate,privateDirectory} from './lib/openrouter-acceptance-guard.js';
import type {Account,CandidateClient,Secrets,Target} from './verify-cloud-candidate-lib.js';
const origin='https://staging.freetwai.com',sha=z.string().regex(/^[a-f0-9]{40}$/);
export const PrivateAiPrepareConfigSchema=z.object({
 profile:z.literal('private-ai.staging-owner-prepare/v1'),mainOrigin:z.literal(origin),environment:z.literal('staging-next'),
 setupOrigin:z.string().regex(/^https:\/\/[a-z0-9-]+\.freetwai\.com$/).refine(v=>v!==origin),
 mainReleaseSha:sha,brokerReleaseSha:sha,bindingReviewSha256:z.string().regex(/^[a-f0-9]{64}$/),
 accountLabel:z.string().regex(/^[a-z0-9-]{3,48}$/),clientId:z.string().min(1).max(128),model:z.string().min(1).max(96),
 receiptDirectory:z.string().refine(isAbsolute),paidExecution:z.literal(false),syntheticOwner:z.literal(true),
}).strict();
export type PrivateAiPrepareConfig=z.infer<typeof PrivateAiPrepareConfigSchema>;
export function validatePrivateAiPrepare(raw:unknown,target:Target,release:string|null|undefined,account:Account|null|undefined){
 const c=PrivateAiPrepareConfigSchema.parse(raw);
 if(target.name!=='staging'||target.origin!==origin||target.mode!=='staging'||target.harness!=='cloud_candidate'
  ||c.mainReleaseSha!==release||c.brokerReleaseSha!==release||c.accountLabel!==account?.label)throw Error('private_ai_prepare_binding_mismatch');
 return c;
}
type Context={check(id:string,condition:boolean):void;metric(key:string,value:unknown):void;cleanup(item:string,state:'residual_expected'):void};
export async function runPrivateAiPrepare(input:{config:PrivateAiPrepareConfig;client:CandidateClient;secrets:Secrets;ctx:Context;authenticate:()=>Promise<{userId:string}>}){
 const {config:c,client,secrets,ctx}=input;
 ctx.metric('scope','synthetic_staging_owner_pairing_and_model_only');ctx.metric('paid_execution','disabled');
 ctx.metric('full_owner_acceptance','incomplete');ctx.metric('credential_ingest','not_run');ctx.metric('provider_posts',0);
 await privateDirectory(c.receiptDirectory);
 // Permanent exclusive intent precedes even the tool login. Never reuse an
 // unknown run; a missing handoff requires operator reconciliation, not retries.
 await durableCreate(join(c.receiptDirectory,'prepare-intent.json'),{profile:c.profile,release:c.mainReleaseSha,brokerRelease:c.brokerReleaseSha,bindingReviewSha256:c.bindingReviewSha256,accountLabel:c.accountLabel,at:new Date().toISOString(),paidExecution:false});
 ctx.cleanup('synthetic pairing/model preparation intent and owner metadata; reconcile unknown outcomes manually','residual_expected');
 const {userId}=await input.authenticate();secrets.add(userId);ctx.check('synthetic_owner_session',z.uuid().safeParse(userId).success);
 const selection={providerRef:'openrouter' as const,modelRef:c.model,processingLocation:'provider_remote',artifactCustody:'platform_asset' as const,credentialCustody:'platform_vault' as const,engineLocation:'platform' as const,billingSource:'user_byok' as const};
 const overview=async()=>{const r=await client.request('GET','/api/v1/me/model-settings');ctx.check('owner_settings_http',r.status===200);return MemberModelSettingsOverviewSchema.parse(r.json());};
 const before=await overview();
 ctx.check('reviewed_setup_installed',before.setup.state==='installed'&&before.setup.setupOrigin===c.setupOrigin);
 const sameSelection=(s:typeof selection)=>Object.entries(selection).every(([k,v])=>s[k as keyof typeof s]===v);
 ctx.check('exact_selection_advertised',before.selectionOptions.some(s=>sameSelection(s as typeof selection)));
 const keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
 const exported=await crypto.subtle.exportKey('jwk',keys.publicKey),publicJwk=RuntimePublicJwkSchema.parse({kty:exported.kty,crv:exported.crv,x:exported.x,y:exported.y});
 const thumbprint=await calculateJwkThumbprint(publicJwk);
 const begin='/execution-api/v1/auth/device-authorizations',token='/execution-api/v1/auth/token';
 const sign=async(typ:string,payload:unknown,includeKey=false)=>{const proof=await new CompactSign(new TextEncoder().encode(typeof payload==='string'?payload:JSON.stringify(payload))).setProtectedHeader({alg:'ES256',typ,...(includeKey?{jwk:publicJwk}:{})}).sign(keys.privateKey);secrets.add(proof);return proof;};
 const base={client_id:c.clientId,environment:c.environment,runtime_kind:'agent-kit',scope:'bootstrap.status.read',htm:'POST'};
 const machine=client.withoutSession();
 const devicePost=async(path:string,body:unknown,proof:string,status:number)=>{const r=await machine.request('POST',path,{json:body,dpop:proof,session:false,csrf:null,origin:'none'});ctx.check('device_http',r.status===status);return r.json();};
 const authorization=DeviceAuthorizationBeginResultSchema.parse(await devicePost(begin,{publicJwk,runtimeKind:'agent-kit'},await sign('freedom-device-pairing+jwt',{...base,purpose:'device_pairing_begin',jti:randomUUID(),iat:Math.floor(Date.now()/1000),htu:origin+begin},true),201));
 for(const value of Object.values(authorization))secrets.add(value);
 const expiry=Date.parse(authorization.expiresAt),monotonicEnd=performance.now()+Math.max(0,expiry-Date.now());
 const current=()=>ctx.check('pairing_deadline_current',Date.now()<expiry&&performance.now()<monotonicEnd);
 ctx.check('begin_binding',authorization.verificationUri===origin+'/device'&&Date.parse(authorization.issuedAt)<=Date.now()&&expiry-Date.parse(authorization.issuedAt)===300000);current();
 let nextPoll=performance.now()+authorization.interval*1000;
 const inspected=await client.request('POST','/api/v1/me/device-authorizations/inspect',{json:{userCode:authorization.userCode}});ctx.check('inspect_http',inspected.status===200);
 const reviewed=DeviceAuthorizationReviewSchema.parse(inspected.json());
 ctx.check('exact_pairing_review',reviewed.authorizationId===authorization.authorizationId&&reviewed.requestDigest===authorization.requestDigest&&reviewed.clientId===c.clientId&&reviewed.environment===c.environment&&reviewed.runtimeKind==='agent-kit'&&reviewed.scope==='bootstrap.status.read'&&reviewed.keyThumbprint===thumbprint&&reviewed.expiresAt===authorization.expiresAt&&reviewed.state==='pending');current();
 const decision=await client.request('POST','/api/v1/me/device-authorizations/decide',{json:{userCode:authorization.userCode,authorizationId:reviewed.authorizationId,requestDigest:reviewed.requestDigest,decision:'approve'},idempotency:randomUUID()});ctx.check('decide_http',decision.status===200);
 const decided=DeviceAuthorizationDecisionResultSchema.parse(decision.json());ctx.check('exact_pairing_decision',decided.authorizationId===authorization.authorizationId&&decided.requestDigest===authorization.requestDigest&&decided.state==='approved');
 const poll=async(enrollmentProof?:string)=>{
  current();const wait=Math.max(0,nextPoll-performance.now())+20;ctx.check('poll_fits_deadline',performance.now()+wait<monotonicEnd);await delay(wait);current();
  const result=DeviceAuthorizationPollResultSchema.parse(await devicePost(token,{grantType:'device_code',authorizationId:authorization.authorizationId,deviceCode:authorization.deviceCode,...(enrollmentProof?{enrollmentProof}:{})},await sign('freedom-device-pairing+jwt',{...base,purpose:'device_pairing_poll',jti:randomUUID(),iat:Math.floor(Date.now()/1000),htu:origin+token,authorization_id:authorization.authorizationId,nonce:authorization.nonce,request_digest:authorization.requestDigest,device_code_hash:createHash('sha256').update(authorization.deviceCode,'ascii').digest('base64url')},true),200));
  if('interval'in result)nextPoll=performance.now()+result.interval*1000;
  return result;
 };
 const challenge=await poll();ctx.check('enrollment_challenge_required',challenge.status==='proof_required');if(challenge.status!=='proof_required')throw Error('private_ai_prepare_unavailable');
 const {profile:_,purpose:__,operational_authority:___,payload,...fields}=challenge.challenge;
 const canonical=createRuntimeRegistrationChallenge(fields);
 ctx.check('exact_enrollment_challenge',canonical.payload===payload&&fields.owner_member_id===userId&&fields.environment===c.environment&&fields.key_thumbprint===thumbprint&&Date.parse(fields.issued_at)<=Date.now()&&Date.parse(fields.expires_at)>Date.now());
 const issued=await poll(await sign('freedom-runtime-enrollment+jws',payload));ctx.check('pairing_issued',issued.status==='issued');if(issued.status!=='issued')throw Error('private_ai_prepare_unavailable');
 for(const value of [issued.accessToken,issued.refresh.handle,issued.nonce.nonce,issued.connectionId,issued.runtimeDeviceId,issued.refresh.familyId])secrets.add(value);
 ctx.check('issued_runtime_binding',issued.runtimeDeviceId===fields.runtime_device_id&&issued.nonce.connectionId===issued.connectionId&&Date.parse(issued.expiresAt)>Date.now()&&Date.parse(issued.refresh.expiresAt)>Date.now()&&Date.parse(issued.nonce.expiresAt)>Date.now());
 const paired=await overview(),connection=paired.connections.find(v=>v.connectionId===issued.connectionId);
 ctx.check('new_current_owner_connection',!!connection&&!before.connections.some(v=>v.connectionId===issued.connectionId)&&connection.runtimeDeviceId===issued.runtimeDeviceId&&connection.state==='active'&&Date.parse(connection.expiresAt)>Date.now());
 const created=await client.request('POST','/api/v1/me/model-connections',{json:{connectionId:issued.connectionId,selection},ifMatch:connection!.aggregateVersion,idempotency:randomUUID()});ctx.check('model_created_http',created.status===201);
 const model=ModelConnectionMetadataSchema.parse(created.json());secrets.add(model.modelConnectionId);ctx.check('model_version_etag',created.headers.get('ETag')===`"${model.aggregateVersion}"`);
 ctx.check('exact_created_model',model.connectionId===issued.connectionId&&model.runtimeDeviceId===issued.runtimeDeviceId&&model.familyId===issued.refresh.familyId&&model.environment===c.environment&&model.clientId===c.clientId&&sameSelection(model.selection as typeof selection)&&model.state==='unverified'&&model.aggregateVersion==='1');
 const after=await overview();ctx.check('created_model_owner_readback',after.models.some(v=>v.modelConnectionId===model.modelConnectionId&&JSON.stringify(v)===JSON.stringify(model))&&!after.credentials.some(v=>v.modelConnectionId===model.modelConnectionId));
 // Metadata handoff only: never persist signer, codes, DPoP, tokens or refresh
 // handles. Operator combines this with its existing private ingest config.
 await durableCreate(join(c.receiptDirectory,'prepare-handoff.json'),{profile:'private-ai.staging-owner-prepare-handoff/v1',mainOrigin:origin,mainReleaseSha:c.mainReleaseSha,brokerReleaseSha:c.brokerReleaseSha,bindingReviewSha256:c.bindingReviewSha256,accountLabel:c.accountLabel,clientId:c.clientId,setupOrigin:c.setupOrigin,model:c.model,connectionId:issued.connectionId,runtimeDeviceId:issued.runtimeDeviceId,modelConnectionId:model.modelConnectionId,modelVersion:model.aggregateVersion,paidExecution:false,fullOwnerAcceptance:'incomplete'});
 ctx.metric('pairing','pass');ctx.metric('owner_model','pass');ctx.metric('private_handoff','created');
}
