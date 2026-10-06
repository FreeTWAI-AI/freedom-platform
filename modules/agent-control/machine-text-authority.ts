import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { OpaqueId } from '../../contracts/common/v1/identity.js';
import { MachineTextAccessClaimsSchema, MachineTextBindingSchema, MachineTextDeviceBindingSchema,
  MachineTextLimits, type MachineTextBinding, type MachineTextDeviceBinding, type MachineTextHost,
  type MachineTextOperation } from '../../contracts/execution/v3/machine-text-execution.js';
import { transaction } from '../../packages/db/transaction.js';
import { freezeTree, snapshotInput } from '../../packages/execution-state/decode.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import type { ScopedFactContext, ExecutionFactBinding } from '../../packages/scoped-commands/command-context.js';
import { parseBootstrapCompact } from './strict-jose-json.js';
import { createMachineTextProofVerifier, machineTextHash, parseMachineTextHost, signMachineTextAccess } from './machine-text-proof.js';

const Hash=z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/), Compact=z.string().min(1).max(MachineTextLimits.compactBytes);
const ChallengeInput=z.object({connectionId:OpaqueId,familyId:OpaqueId,proof:Compact,requestSha256:Hash}).strict();
const ActivationInput=ChallengeInput.extend({challengeId:OpaqueId,nonce:z.string().length(43)}).strict();
const AccessInput=z.object({accessToken:Compact,proof:Compact,operation:z.enum(['execute','status','evidence']),requestSha256:Hash}).strict();
type DeviceRow={binding:MachineTextDeviceBinding;expires_at:Date};
interface AuthorizationRow { binding:MachineTextBinding;execute_jti:string;evidence_jti:string;issued_at:Date;expires_at:Date;evidence_expires_at:Date }
declare const invocationBrand:unique symbol;
export interface MachineModelSubject {readonly user_id:string;readonly [invocationBrand]:never}
export interface MachineModelContext extends ScopedFactContext {readonly authn_kind:'execution_token';readonly ownerUserId:string}
export interface MachineTextContext extends ScopedFactContext {
  readonly authn_kind:'execution_token';
  readonly ownerUserId:string;
  readonly binding:MachineTextBinding;
}
interface Admission {model?:boolean;q:PoolClient;operation:MachineTextOperation;validUntilMs:number;validFromMs:number;monotonicDeadline:number}
const admissions=new WeakMap<MachineTextContext,Admission>();
const deny:()=>never=()=>{throw new Problem(401,'machine_text_unauthorized','機器執行授權無效或已失效。');};
/** jti of a proof that pending()/authorizeAccess() has already verified. */
const proofJti=(compact:string):string=>{const c=parseBootstrapCompact(compact).claims,jti=c&&typeof c==='object'?(c as {jti?:unknown}).jti:undefined;return typeof jti==='string'?jti:deny();};
const parse=<T>(schema:z.ZodType<T>,raw:unknown):T=>freezeTree(schema.parse(snapshotInput(raw)));
async function clock(q:PoolClient):Promise<number>{return Number((await q.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text ms")).rows[0].ms);}
function wall(from:number,until:number){const t=Date.now();if(t<from||t>=until)deny();}
function context(binding:MachineTextBinding):MachineTextContext{return freezeTree({authn_kind:'execution_token' as const,ownerUserId:binding.ownerUserId,binding,
  subject_principal:{principal_id:binding.principalId,kind:'person' as const},scope:{scope_id:binding.scopeId,kind:'personal' as const}});}
export function machineTextFactBinding(c:MachineTextContext):ExecutionFactBinding {
  if(!admissions.has(c))deny();const b=c.binding;
  return {authorizationId:b.authorizationId,attemptId:b.attemptId,grantId:b.grantId,runtimeDeviceId:b.runtimeDeviceId,connectionId:b.connectionId};
}
/** Current SQL and decision clock, not a client-created context or boolean. */
export async function assertMachineTextCurrent(q:PoolClient,c:MachineTextContext):Promise<void>{
  const a=admissions.get(c);if(!a||a.q!==q||performance.now()>=a.monotonicDeadline)deny();wall(a!.validFromMs,a!.validUntilMs);
  if(a!.model&&a!.operation==='execute')await q.query('SELECT check_machine_model_admission(current_schema(),$1)',[c.binding.authorizationId]);
  else await q.query('SELECT check_machine_text_authorization(current_schema(),$1,$2)',[c.binding.authorizationId,a!.operation==='evidence'||a!.model===true]);
  const t=await clock(q);if(t<a!.validFromMs||t>=a!.validUntilMs||performance.now()>=a!.monotonicDeadline)deny();wall(a!.validFromMs,a!.validUntilMs);
}
export function forgetMachineTextContext(c:MachineTextContext):void{admissions.delete(c);}

const bindingColumns=`jsonb_build_object('ownerUserId',a.owner_user_id::text,'principalId',a.owner_principal_id::text,
  'scopeId',a.scope_id::text,'runtimeDeviceId',a.runtime_device_id::text,'runtimeVersion',a.runtime_version::text,
  'connectionId',a.connection_id::text,'connectionVersion',a.connection_version::text,'familyId',a.family_id::text,
  'keyThumbprint',a.key_thumbprint,'authorizationId',a.authorization_id::text,'stepId',a.step_id::text,'attemptId',a.attempt_id::text,
  'runId',a.run_id::text,'grantId',a.grant_id::text,'grantVersion',a.grant_version::text,'approvalId',a.approval_id::text,
  'approvalVersion',a.approval_version::text,'bindingSha256',a.binding_sha256,'recoveryGeneration',a.recovery_generation::text) binding`;

/** Closed signed-device adapter. All caller fields are untrusted lookup/proof
 * material. Current owner, scope, device and domain facts come from SQL.
 * Activation authorization attaches only to a genuine reserved model step;
 * its owning command creates that Step/Attempt in this SAME transaction.
 * No member Actor/session is fabricated and no private context is returned. */
export function createMachineTextAuthority(pool:Pool,rawHost:MachineTextHost,signingKey:CryptoKey){return machineTextAuthority(pool,rawHost,signingKey);}
/** Main-side cryptographic/current SQL inspection has no token minting key. */
export function createMachineTextInspection(pool:Pool,rawHost:MachineTextHost){
  const {inspectActivation,inspectAccess}=machineTextAuthority(pool,rawHost);return Object.freeze({inspectActivation,inspectAccess});
}
function machineTextAuthority(pool:Pool,rawHost:MachineTextHost,signingKey?:CryptoKey){
  const host=parseMachineTextHost(rawHost),verifier=createMachineTextProofVerifier(host);
  async function lockDevice(q:PoolClient,connectionId:string,familyId:string):Promise<DeviceRow>{
    const first=(await q.query(`SELECT c.*,r.challenge_id,r.key_thumbprint FROM agent_connections c
      JOIN runtime_registrations r USING(runtime_device_id) WHERE c.connection_id=$1`,[connectionId])).rows[0];
    if(!first||first.environment!==host.environment||first.client_id!==host.clientId)deny();
    // Canonical member order without the member-only session lock.
    await q.query('SELECT user_id FROM users WHERE user_id=$1 FOR SHARE',[first.owner_user_id]);
    await q.query('SELECT principal_id FROM principals WHERE principal_id=$1 FOR SHARE',[first.owner_principal_id]);
    await q.query('SELECT scope_id FROM resource_scopes WHERE scope_id=$1 FOR SHARE',[first.scope_id]);
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`freedom.execution-prerequisites.owner/v1:${first.owner_principal_id}`]);
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['freedom.runtime-enrollment.owner/v1',host.environment,first.owner_principal_id])]);
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['freedom.runtime-enrollment.key/v1',host.environment,first.key_thumbprint])]);
    await q.query('SELECT challenge_id FROM runtime_registration_challenges WHERE challenge_id=$1 FOR UPDATE',[first.challenge_id]);
    await q.query('SELECT runtime_device_id FROM runtime_registrations WHERE runtime_device_id=$1 FOR UPDATE',[first.runtime_device_id]);
    await q.query('SELECT connection_id FROM agent_connections WHERE connection_id=$1 FOR UPDATE',[connectionId]);
    await q.query('SELECT family_id FROM bootstrap_refresh_families WHERE family_id=$1 FOR UPDATE',[familyId]);
    await q.query('SELECT check_machine_text_device(current_schema(),$1,$2,$3)',[first.runtime_device_id,connectionId,familyId]);
    const row=(await q.query(`SELECT jsonb_build_object('ownerUserId',c.owner_user_id::text,'principalId',c.owner_principal_id::text,
      'scopeId',c.scope_id::text,'runtimeDeviceId',r.runtime_device_id::text,'runtimeVersion',r.aggregate_version::text,
      'connectionId',c.connection_id::text,'connectionVersion',c.aggregate_version::text,'familyId',f.family_id::text,
      'keyThumbprint',r.key_thumbprint) binding,least(c.expires_at,f.expires_at) expires_at
      FROM agent_connections c JOIN runtime_registrations r USING(runtime_device_id)
      JOIN bootstrap_refresh_families f ON f.connection_id=c.connection_id WHERE c.connection_id=$1 AND f.family_id=$2`,[connectionId,familyId])).rows[0];
    if(!row)deny();return {binding:parse(MachineTextDeviceBindingSchema,row.binding),expires_at:row.expires_at};
  }
  async function addProof(q:PoolClient,b:MachineTextDeviceBinding,operation:string,proofId:string,requestSha256:string,
    from:number,until:number,challengeId:string|null,authorizationId:string|null){
    wall(from,until);const t=await clock(q);if(t<from||t>=until)deny();
    const result=await q.query(`INSERT INTO execution_machine_proofs(runtime_device_id,connection_id,family_id,proof_jti,operation,
      challenge_id,authorization_id,request_sha256,accepted_at,valid_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT(runtime_device_id,proof_jti) DO NOTHING`,[b.runtimeDeviceId,b.connectionId,b.familyId,proofId,operation,
      challengeId,authorizationId,requestSha256,new Date(t),new Date(until)]);
    if(result.rowCount!==1)deny();wall(from,until);
  }
  async function challenge(raw:z.infer<typeof ChallengeInput>){
    const input=parse(ChallengeInput,raw);
    return transaction(pool,async q=>{
      const d=await lockDevice(q,input.connectionId,input.familyId),t=await clock(q);
      const proof=await verifier.device({...input,purpose:'challenge',binding:d.binding,nowMs:t});if(!proof)deny();
      wall(proof!.validFromMs,proof!.validUntilMs);
      const nonce=randomBytes(32).toString('base64url'),id=randomUUID(),expires=Math.min(t+MachineTextLimits.nonceMs,d.expires_at.getTime());
      await q.query(`INSERT INTO execution_machine_challenges(challenge_id,runtime_device_id,connection_id,family_id,nonce_hash,request_sha256,issued_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[id,d.binding.runtimeDeviceId,input.connectionId,input.familyId,machineTextHash(nonce),input.requestSha256,new Date(t),new Date(expires)]);
      await addProof(q,d.binding,'challenge',proof!.proofId,input.requestSha256,proof!.validFromMs,proof!.validUntilMs,id,null);
      // Returned after COMMIT by transaction(); never persisted in a receipt.
      return freezeTree({challengeId:id,nonce,expiresAt:new Date(expires).toISOString()});
    });
  }
  async function attach(q:PoolClient,raw:z.infer<typeof ActivationInput>,stepId:string){
    if(!signingKey)deny();const input=parse(ActivationInput,raw);OpaqueId.parse(stepId);
    const d=await lockDevice(q,input.connectionId,input.familyId),t=await clock(q);
    const challenge=(await q.query('SELECT * FROM execution_machine_challenges WHERE challenge_id=$1 FOR UPDATE',[input.challengeId])).rows[0];
    if(!challenge||challenge.connection_id!==input.connectionId||challenge.family_id!==input.familyId
      ||challenge.runtime_device_id!==d.binding.runtimeDeviceId||challenge.nonce_hash!==machineTextHash(input.nonce)
      ||challenge.consumed_at||t<challenge.issued_at.getTime()||t>=challenge.expires_at.getTime())deny();
    const proof=await verifier.device({...input,purpose:'activate',binding:d.binding,nowMs:t});if(!proof)deny();
    const s=(await q.query(`SELECT s.*,encode(sha256(convert_to(s.binding::text,'UTF8')),'hex') binding_hash FROM model_text_steps s WHERE step_id=$1`,[stepId])).rows[0];
    if(!s||s.owner_user_id!==d.binding.ownerUserId||s.owner_principal_id!==d.binding.principalId||s.scope_id!==d.binding.scopeId
      ||s.binding.runtimeDeviceId!==d.binding.runtimeDeviceId||s.binding.connectionId!==input.connectionId||s.binding.familyId!==input.familyId)deny();
    wall(proof!.validFromMs,proof!.validUntilMs);
    const issuer=host.keys.find(key=>key.kid===host.issuerKid)!,issued=await clock(q);
    if(issuer.revoked||Math.floor(issued/1000)*1000<issuer.notBeforeMs||issued>=issuer.notAfterMs)deny();
    const expires=Math.min(issued+MachineTextLimits.accessSeconds*1000,s.lease_expires_at.getTime(),issuer.notAfterMs),
      evidenceExpires=Math.min(issued+MachineTextLimits.evidenceSeconds*1000,d.expires_at.getTime(),issuer.notAfterMs);
    if(Math.floor(expires/1000)<=Math.floor(issued/1000))deny();
    await q.query('UPDATE execution_machine_challenges SET consumed_at=$2 WHERE challenge_id=$1',[input.challengeId,new Date(issued)]);
    await addProof(q,d.binding,'activate',proof!.proofId,input.requestSha256,proof!.validFromMs,proof!.validUntilMs,input.challengeId,null);
    const binding=parse(MachineTextBindingSchema,{...d.binding,authorizationId:randomUUID(),stepId,attemptId:s.attempt_id,runId:s.run_id,
      grantId:s.binding.grantId,grantVersion:s.binding.grantVersion,approvalId:s.approval_id,approvalVersion:s.binding.approvalVersion,
      bindingSha256:s.binding_hash,recoveryGeneration:s.verified_binding.recoveryGeneration});
    const executeJti=randomBytes(24).toString('base64url'),evidenceJti=randomBytes(24).toString('base64url');
    await q.query(`INSERT INTO execution_machine_authorizations(authorization_id,challenge_id,step_id,attempt_id,run_id,grant_id,approval_id,
      owner_user_id,owner_principal_id,scope_id,environment,client_id,runtime_device_id,runtime_version,connection_id,connection_version,
      family_id,key_thumbprint,grant_version,approval_version,binding_sha256,recovery_generation,execute_jti,evidence_jti,issued_at,expires_at,evidence_expires_at)
      VALUES(${Array.from({length:27},(_,i)=>'$'+(i+1)).join(',')})`,[binding.authorizationId,input.challengeId,stepId,binding.attemptId,binding.runId,
      binding.grantId,binding.approvalId,binding.ownerUserId,binding.principalId,binding.scopeId,host.environment,host.clientId,binding.runtimeDeviceId,
      binding.runtimeVersion,binding.connectionId,binding.connectionVersion,binding.familyId,binding.keyThumbprint,binding.grantVersion,binding.approvalVersion,
      binding.bindingSha256,binding.recoveryGeneration,executeJti,evidenceJti,new Date(issued),new Date(expires),new Date(evidenceExpires)]);
    const claims={iss:host.issuer,aud:host.audience,sub:binding.principalId,environment:host.environment,client_id:host.clientId,binding,
      cnf:{jkt:binding.keyThumbprint},iat:Math.floor(issued/1000)};
    const accessToken=await signMachineTextAccess(host,signingKey,{...claims,purpose:'machine_text.execute',scope:'model.private-draft',jti:executeJti,exp:Math.floor(expires/1000)});
    const evidenceToken=await signMachineTextAccess(host,signingKey,{...claims,purpose:'machine_text.evidence',scope:'model.dispatch.evidence',jti:evidenceJti,exp:Math.floor(evidenceExpires/1000)});
    await q.query('SELECT check_machine_text_authorization(current_schema(),$1,false)',[binding.authorizationId]);
    wall(proof!.validFromMs,Math.min(proof!.validUntilMs,expires,challenge.expires_at.getTime()));
    return freezeTree({binding,accessToken,evidenceToken,expiresAt:new Date(expires).toISOString(),evidenceExpiresAt:new Date(evidenceExpires).toISOString()});
  }
  async function authorizeAccess(q:PoolClient,raw:z.infer<typeof AccessInput>,model=false,accepted:false|true|'inspect'=false):Promise<MachineTextContext>{
    const input=parse(AccessInput,raw);
    // Parsing provides only a bounded lookup ID; none of these claims are
    // trusted until SQL-derived equality AND both ES256 signatures pass.
    const claimed=MachineTextAccessClaimsSchema.parse(parseBootstrapCompact(input.accessToken).claims);
    const initial=(await q.query(`SELECT ${bindingColumns},a.* FROM execution_machine_authorizations a WHERE a.authorization_id=$1`,[claimed.binding.authorizationId])).rows[0] as AuthorizationRow|undefined;
    if(!initial)deny();const binding=parse(MachineTextBindingSchema,initial!.binding);
    await lockDevice(q,binding.connectionId,binding.familyId);
    // Lock the existing domain in its established order before the new proof.
    const g=(await q.query('SELECT * FROM execution_grants WHERE grant_id=$1',[binding.grantId])).rows[0];if(!g)deny();
    await q.query('SELECT work_item_id FROM work_items WHERE work_item_id=$1 FOR UPDATE',[g.work_item_id]);
    await q.query('SELECT run_id FROM execution_runs WHERE run_id=$1 FOR UPDATE',[binding.runId]);
    await q.query('SELECT model_connection_id FROM model_connections WHERE model_connection_id=$1 FOR UPDATE',[g.model_connection_id]);
    await q.query('SELECT grant_id FROM execution_grants WHERE grant_id=$1 FOR UPDATE',[binding.grantId]);
    await q.query('SELECT approval_id FROM model_export_approvals WHERE approval_id=$1 FOR UPDATE',[binding.approvalId]);
    await q.query('SELECT attempt_id FROM execution_attempts WHERE attempt_id=$1 FOR UPDATE',[binding.attemptId]);
    await q.query('SELECT step_id FROM model_text_steps WHERE step_id=$1 FOR UPDATE',[binding.stepId]);
    const a=(await q.query('SELECT * FROM execution_machine_authorizations WHERE authorization_id=$1 FOR UPDATE',[binding.authorizationId])).rows[0] as AuthorizationRow;
    const clockStarted=performance.now(),t=await clock(q),proof=await verifier.access({...input,binding,nowMs:t});if(!proof)deny();
    const evidence=input.operation==='evidence',expires=evidence?a.evidence_expires_at:a.expires_at;
    if(proof!.tokenId!==(evidence?a.evidence_jti:a.execute_jti)||claimed.iat!==Math.floor(a.issued_at.getTime()/1000)
      ||claimed.exp!==Math.floor(expires.getTime()/1000))deny();
    const until=Math.min(expires.getTime(),proof!.validUntilMs),c=context(binding);
    admissions.set(c,{q,model,operation:input.operation,validFromMs:Math.max(a.issued_at.getTime(),proof!.validFromMs),validUntilMs:until,
      monotonicDeadline:clockStarted+Math.max(0,until-t)});
    try{await assertMachineTextCurrent(q,c);
      if(!accepted)await addProof(q,binding,input.operation,proof!.proofId,input.requestSha256,proof!.validFromMs,proof!.validUntilMs,null,binding.authorizationId);
      else if(accepted!=='inspect'){const prior=(await q.query(`SELECT 1 FROM execution_machine_proofs WHERE runtime_device_id=$1 AND proof_jti=$2 AND authorization_id=$3
        AND operation=$4 AND request_sha256=$5 AND valid_until>clock_timestamp()`,[binding.runtimeDeviceId,proof!.proofId,binding.authorizationId,input.operation,input.requestSha256])).rowCount;if(prior!==1)deny();}
      await assertMachineTextCurrent(q,c);return c;
    }catch(error){admissions.delete(c);throw error;}
  }
  function invocationPorts(){
    type Pending={kind:'activate';input:z.infer<typeof ActivationInput>;approvalId:string;device:MachineTextDeviceBinding};
    type Executing={kind:'execute'|'status'|'evidence';input:z.infer<typeof AccessInput>;binding:MachineTextBinding};
    type Data=Pending|Executing;
    const subjects=new WeakMap<MachineModelSubject,Data>();
    const live=new WeakMap<MachineModelContext,{q:PoolClient;subject:MachineModelSubject;active?:MachineTextContext;pendingUntil?:number;pendingFrom?:number}>();
    const transactions=new WeakMap<MachineModelSubject,Map<PoolClient,MachineModelContext>>();
    const issued=new WeakMap<MachineModelSubject,Awaited<ReturnType<typeof attach>>>();
    const get=(subject:MachineModelSubject)=>{const d=subjects.get(subject);if(!d)deny();return d!;};
    function make(data:Data){const subject=Object.freeze({user_id:data.kind==='activate'?data.device.ownerUserId:data.binding.ownerUserId}) as MachineModelSubject;
      subjects.set(subject,freezeTree(data));return subject;}
    async function pending(q:PoolClient,input:z.infer<typeof ActivationInput>,approvalId:string,expected?:MachineTextDeviceBinding){
      const d=await lockDevice(q,input.connectionId,input.familyId),t=await clock(q);
      if(expected&&JSON.stringify(d.binding)!==JSON.stringify(expected))deny();
      const row=(await q.query('SELECT * FROM execution_machine_challenges WHERE challenge_id=$1 FOR UPDATE',[input.challengeId])).rows[0];
      if(!row||row.consumed_at||row.runtime_device_id!==d.binding.runtimeDeviceId||row.connection_id!==input.connectionId
        ||row.family_id!==input.familyId||row.nonce_hash!==machineTextHash(input.nonce)||t<row.issued_at.getTime()||t>=row.expires_at.getTime())deny();
      const proof=await verifier.device({...input,purpose:'activate',binding:d.binding,nowMs:t});if(!proof)deny();
      const a=(await q.query(`SELECT a.*,g.runtime_device_id,g.connection_id,g.family_id,g.selection grant_selection
        FROM model_export_approvals a JOIN execution_grants g USING(grant_id) WHERE a.approval_id=$1
        AND a.owner_user_id=$2 AND a.owner_principal_id=$3 AND a.scope_id=$4 AND a.environment=$5 AND a.client_id=$6`,
      [approvalId,d.binding.ownerUserId,d.binding.principalId,d.binding.scopeId,host.environment,host.clientId])).rows[0];
      if(!a||a.runtime_device_id!==d.binding.runtimeDeviceId||a.connection_id!==input.connectionId||a.family_id!==input.familyId)deny();
      // Native/official CLI is unavailable before the shared engine may load
      // any private context or ask a host to verify a provider credential.
      const selection=a.grant_selection;
      requireCondition(selection.billingSource==='user_byok'&&selection.processingLocation==='provider_remote'
        &&selection.credentialCustody==='platform_vault'&&selection.engineLocation==='platform'&&selection.artifactCustody==='platform_asset',
      503,'machine_model_profile_unavailable','模型執行方式尚未提供。');
      const from=Math.max(proof!.validFromMs,row.issued_at.getTime()),until=Math.min(proof!.validUntilMs,row.expires_at.getTime(),d.expires_at.getTime());
      wall(from,until);return {device:d.binding,from,until};
    }
    async function activation(raw:z.infer<typeof ActivationInput>,approvalId:string):Promise<MachineModelSubject>{
      const input=parse(ActivationInput,raw);OpaqueId.parse(approvalId);
      return transaction(pool,async q=>make({kind:'activate',input,approvalId,device:(await pending(q,input,approvalId)).device}));
    }
    async function execution(raw:z.infer<typeof AccessInput>):Promise<MachineModelSubject>{
      const input=parse(AccessInput,raw);
      return transaction(pool,async q=>{const c=await authorizeAccess(q,input,true);try{return make({kind:input.operation,input,binding:c.binding});}finally{forgetMachineTextContext(c);}});
    }
    async function resume(q:PoolClient,subject:MachineModelSubject):Promise<MachineModelContext>{
      const d=get(subject);let active:MachineTextContext|undefined,until:number|undefined,from:number|undefined;
      if(d.kind==='activate'){const p=await pending(q,d.input,d.approvalId,d.device);until=p.until;from=p.from;}
      else active=await authorizeAccess(q,d.input,true,true);
      const b=d.kind==='activate'?d.device:d.binding;
      const c=freezeTree({authn_kind:'execution_token' as const,ownerUserId:b.ownerUserId,
        subject_principal:{principal_id:b.principalId,kind:'person' as const},scope:{scope_id:b.scopeId,kind:'personal' as const}});
      live.set(c,{q,subject,active,pendingUntil:until,pendingFrom:from});
      let map=transactions.get(subject);if(!map){map=new Map();transactions.set(subject,map);}if(map.has(q))deny();map.set(q,c);return c;
    }
    async function current(q:PoolClient,subject:MachineModelSubject){
      get(subject);const c=transactions.get(subject)?.get(q),l=c&&live.get(c);if(!l||l.q!==q)deny();
      if(l!.active)await assertMachineTextCurrent(q,l!.active);
      else {wall(l!.pendingFrom!,l!.pendingUntil!);const d=get(subject);if(d.kind!=='activate')return deny();await pending(q,d.input,d.approvalId,d.device);wall(l!.pendingFrom!,l!.pendingUntil!);}
    }
    async function attachModel(q:PoolClient,subject:MachineModelSubject,c:MachineModelContext,stepId:string){
      const d=get(subject),l=live.get(c);if(d.kind!=='activate'||!l||l.q!==q||l.subject!==subject||l.active||issued.has(subject))deny();
      const value=await attach(q,(d as Pending).input,stepId),b=value.binding;
      const s=(await q.query('SELECT evidence_origin,binding FROM model_text_steps WHERE step_id=$1',[stepId])).rows[0];
      let credentialId:string|null=null,credentialGeneration:string|null=null;
      {
        const credential=(await q.query(`SELECT credential_id,generation::text FROM broker_model_credentials WHERE model_connection_id=$1
          AND model_version=$2 AND owner_user_id=$3 AND owner_principal_id=$4 AND scope_id=$5 AND environment=$6 AND client_id=$7
          AND runtime_device_id=$8 AND connection_id=$9 AND family_id=$10 AND state='active' AND issued_at<=clock_timestamp()
          AND expires_at>clock_timestamp() AND recovery_generation=$11`,[s.binding.modelConnectionId,s.binding.modelVersion,b.ownerUserId,
          b.principalId,b.scopeId,host.environment,host.clientId,b.runtimeDeviceId,b.connectionId,b.familyId,b.recoveryGeneration])).rows[0];
        if(!credential&&s.evidence_origin!=='synthetic_local_fixture')deny();if(credential){credentialId=credential.credential_id;credentialGeneration=credential.generation;}
      }
      await q.query(`INSERT INTO execution_machine_model_pins(authorization_id,profile,evidence_origin,credential_id,credential_generation)
        VALUES($1,'freedom.machine-model-pin/v1',$2,$3,$4)`,[b.authorizationId,s.evidence_origin,credentialId,credentialGeneration]);
      const active=context(b),started=performance.now(),t=await clock(q),until=Math.min(l!.pendingUntil!,Date.parse(value.expiresAt));
      admissions.set(active,{q,model:true,operation:'execute',validFromMs:l!.pendingFrom!,validUntilMs:until,monotonicDeadline:started+Math.max(0,until-t)});
      l!.active=active;await assertMachineTextCurrent(q,active);issued.set(subject,value);
    }
    function fact(q:PoolClient,c:MachineModelContext):ExecutionFactBinding{const l=live.get(c);if(!l||l.q!==q||!l.active)deny();return machineTextFactBinding(l!.active!);}
    function finish(q:PoolClient,c:MachineModelContext){const l=live.get(c);if(!l||l.q!==q)deny();if(l!.active)forgetMachineTextContext(l!.active);transactions.get(l!.subject)?.delete(q);live.delete(c);}
    function takeIssued(subject:MachineModelSubject){get(subject);const value=issued.get(subject);issued.delete(subject);return value??null;}
    function forget(subject:MachineModelSubject){subjects.delete(subject);issued.delete(subject);transactions.delete(subject);}
    async function inspectActivation(q:PoolClient,raw:z.infer<typeof ActivationInput>,approvalId:string){
      const input=parse(ActivationInput,raw);OpaqueId.parse(approvalId);const p=await pending(q,input,approvalId);
      return freezeTree({...p,proofId:proofJti(input.proof)});
    }
    async function inspectAccess(q:PoolClient,raw:z.infer<typeof AccessInput>){
      const input=parse(AccessInput,raw);if(input.operation!=='execute')deny();const c=await authorizeAccess(q,input,true,'inspect');
      try{return freezeTree({binding:c.binding,proofId:proofJti(input.proof)});}finally{forgetMachineTextContext(c);}
    }
    return Object.freeze({inspectActivation,inspectAccess,activation,execution,resume,current,attachModel,fact,finish,takeIssued,forget,
      snapshot:(subject:MachineModelSubject)=>{get(subject);return subject;},
      describe:(subject:MachineModelSubject)=>{const d=get(subject);return freezeTree(d.kind==='activate'?{kind:d.kind,approvalId:d.approvalId,challengeId:d.input.challengeId,device:d.device}:{kind:d.kind,binding:d.binding});}});
  }
  return Object.freeze({challenge,attach,access:(q:PoolClient,raw:z.infer<typeof AccessInput>)=>authorizeAccess(q,raw),...invocationPorts()});
}
export type MachineTextAuthority=ReturnType<typeof createMachineTextAuthority>;
