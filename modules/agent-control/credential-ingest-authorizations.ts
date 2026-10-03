import type { Pool, PoolClient } from 'pg';
import type { Actor } from '../identity-membership/service.js';
import type { RecoveryObservation } from '../agent-execution/model-step-host.js';
import type { RuntimeEnvironment } from '../../contracts/execution/v1/runtime-registration.js';
import type { ModelCredentialBinding } from '../../contracts/execution/v2/model-credential.js';
import type { CredentialIngestCommand,CredentialIngestBootstrapClaims,CredentialIngestSetupMetadata,CredentialIngestOwnerOutcome } from '../../contracts/execution/v2/model-credential-ingest.js';

declare const ingestInvocationBrand:unique symbol;
export interface OpaqueCredentialIngestInvocation {readonly [ingestInvocationBrand]:never}
export interface CredentialIngestAuthorizationOptions {
  environment:RuntimeEnvironment;clientId:string;issuer:string;audience:string;setupOrigin:string;
  recover:()=>Promise<RecoveryObservation>;
}
export interface CredentialIngestInvocationData {
  actor:Actor;command:CredentialIngestCommand;authorizationRef:string;nonce:string;commandDigest:string;
  recoveryGeneration:string;expiresAt:string;setupExpiresAt:string;model:CredentialIngestSetupMetadata['model'];
}
/** Pure API contract only. No implementation or fallback authority is installed
 * by this declaration. Claim arguments are server-generated/verified inputs. */
export interface CredentialIngestAuthorizations {
  issue(actor:Actor,input:{command:CredentialIngestCommand;nonce:string}):Promise<CredentialIngestBootstrapClaims>;
  claimBootstrap(claims:CredentialIngestBootstrapClaims,input:{cookieHash:string;csrfHash:string}):Promise<OpaqueCredentialIngestInvocation>;
  read(invocation:OpaqueCredentialIngestInvocation):CredentialIngestInvocationData;
  claimSubmission(invocation:OpaqueCredentialIngestInvocation,input:{binding:ModelCredentialBinding;writeExpiresAt:string;cookieHash:string;csrfHash:string}):Promise<void>;
  assertCurrent(q:PoolClient,invocation:OpaqueCredentialIngestInvocation):Promise<void>;
  readOwnerOutcome(actor:Actor,authorizationRef:string):Promise<CredentialIngestOwnerOutcome>;
}

import { createHash,randomUUID } from 'node:crypto';
import { z } from 'zod';
import { scopedMemberCommand } from '../../packages/scoped-commands/index.js';
import { withMemberScope,type MemberScopeContext } from '../../packages/resource-scopes/index.js';
import { transaction } from '../../packages/db/transaction.js';
import { assertCurrentSessionClock } from '../../packages/db/member-session.js';
import { requireCondition } from '../../packages/shared/problem.js';
import { snapshotInput,freezeTree } from '../../packages/execution-state/decode.js';
import { RuntimeEnvironmentSchema } from '../../contracts/execution/v1/runtime-registration.js';
import { BootstrapClientIdSchema } from '../../contracts/execution/v1/bootstrap.js';
import { ModelConnectionMetadataSchema } from '../../contracts/execution/v1/member-execution.js';
import { CredentialRecoveryFloorSchema,ModelCredentialBindingSchema,ModelCredentialMetadataSchema,BrokerModelSelectionSchema } from '../../contracts/execution/v2/model-credential.js';
import * as c from '../../contracts/execution/v2/model-credential-ingest.js';

interface Row {
  authorization_id:string;owner_user_id:string;owner_principal_id:string;scope_id:string;original_session_hash:string;
  environment:string;client_id:string;operation:'create'|'rotate';command_key:string;command:CredentialIngestCommand;command_digest:string;
  nonce_hash:string;assertion:CredentialIngestBootstrapClaims;model_connection_id:string;model_version:string;
  model_metadata:CredentialIngestSetupMetadata['model'];old_credential_id:string|null;old_credential_version:string|null;
  old_credential_generation:string|null;old_model_connection_id:string|null;old_model_version:string|null;
  recovery_generation:string;issued_at:Date;expires_at:Date;bootstrap_claimed_at:Date|null;
  setup_cookie_hash:string|null;setup_csrf_hash:string|null;setup_expires_at:Date|null;
  submission_claimed_at:Date|null;write_expires_at:Date|null;submitted_credential_id:string|null;submitted_binding:ModelCredentialBinding|null;
  committed_at:Date|null;committed_credential_id:string|null;
}
interface Captured {identity:object;row:Row;data:CredentialIngestInvocationData;monotonic:number;binding?:ModelCredentialBinding;writeMonotonic?:number}
const invocations=new WeakMap<object,Captured>();
const invalid=():never=>{requireCondition(false,403,'credential_ingest_authorization_invalid','Credential ingestion authorization is unavailable.');throw new Error('credential_ingest_authorization_invalid');};
const parse=<T>(schema:z.ZodType<T>,raw:unknown):T=>freezeTree(schema.parse(snapshotInput(raw)));
const ordered=(v:unknown):unknown=>!v||typeof v!=='object'?v:Array.isArray(v)?v.map(ordered):Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered((v as Record<string,unknown>)[k])]));
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const equal=(a:unknown,b:unknown)=>JSON.stringify(ordered(a))===JSON.stringify(ordered(b));
export const credentialIngestCommandDigest=(command:CredentialIngestCommand):string=>hash(JSON.stringify(ordered(parse(c.CredentialIngestCommandSchema,command))));
const rowColumns='a.model_version::text,a.old_credential_version::text,a.old_credential_generation::text,a.old_model_version::text,a.recovery_generation::text';
const Hash=z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/);
function captureActor(raw:Actor):Actor {
  if(!raw||typeof raw!=='object')invalid();const d=Object.getOwnPropertyDescriptors(raw),out:Record<string,string>={};
  for(const key of ['user_id','community_id','session_hash']){if(!d[key]?.enumerable||!('value'in d[key])||typeof d[key].value!=='string')invalid();out[key]=d[key].value;}
  return Object.freeze(out) as unknown as Actor;
}
/** Claims arrive only AFTER pinned signature verification in the broker. The
 * original SQL session is the only source of broker-local member identity. */
export function createCredentialIngestAuthorizations(pool:Pool,options:CredentialIngestAuthorizationOptions):CredentialIngestAuthorizations {
  if(!options||Object.getPrototypeOf(options)!==Object.prototype)invalid();const d=Object.getOwnPropertyDescriptors(options);
  const names=['environment','clientId','issuer','audience','setupOrigin','recover'];
  if(Reflect.ownKeys(options).length!==names.length||names.some(k=>!d[k]?.enumerable||!('value'in d[k])))invalid();
  const environment=RuntimeEnvironmentSchema.parse(d.environment.value),clientId=BootstrapClientIdSchema.parse(d.clientId.value);
  const issuer=c.CredentialIngestBootstrapClaimsSchema.shape.issuer.parse(d.issuer.value),audience=c.CredentialIngestBootstrapClaimsSchema.shape.audience.parse(d.audience.value),
    setupOrigin=c.CredentialIngestBootstrapClaimsSchema.shape.setupOrigin.parse(d.setupOrigin.value),recover=d.recover.value as ()=>Promise<RecoveryObservation>;
  const origin=new URL(setupOrigin);
  if(origin.origin!==setupOrigin||origin.username||origin.password||origin.hash||origin.search
    ||(origin.protocol!=='https:'&&(environment!=='local'||origin.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(origin.hostname)))
    ||typeof recover!=='function'||typeof issuer!=='string'||typeof audience!=='string'||!issuer||!audience)invalid();
  const identity=Object.freeze(Object.create(null));
  async function recovery():Promise<RecoveryObservation> {
    const started=performance.now();let timer:ReturnType<typeof setTimeout>|undefined;
    try {const result=parse(CredentialRecoveryFloorSchema,await Promise.race([Promise.resolve().then(recover),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('credential_ingest_unavailable')),3000);})]));
      if(performance.now()-started>=3000||Date.parse(result.expiresAt)<=Date.now())invalid();return result;
    }catch{return invalid();}finally{if(timer)clearTimeout(timer);}
  }
  function captured(invocation:OpaqueCredentialIngestInvocation):Captured {
    const found=invocation&&typeof invocation==='object'?invocations.get(invocation):undefined;if(!found||found.identity!==identity)invalid();return found!;
  }
  function active(data:Captured) {
    const expiry=data.row.write_expires_at??data.row.setup_expires_at??data.row.expires_at;
    if(expiry.getTime()<=Date.now()||performance.now()>=(data.writeMonotonic??data.monotonic))invalid();
  }
  interface Authority {community_id:string;session_expiry:Date;connection_expiry:Date;family_expiry:Date;old_expiry:Date|null;now:Date}
  async function currentRow(q:PoolClient,row:Row,r:RecoveryObservation,expectedBinding?:ModelCredentialBinding):Promise<Authority> {
    const result=(await q.query<Authority>(`SELECT u.community_id,s.expires_at session_expiry,ac.expires_at connection_expiry,
      f.expires_at family_expiry,old.expires_at old_expiry,clock_timestamp() now
      FROM credential_ingest_authorizations a
      JOIN users u ON u.user_id=a.owner_user_id AND u.active AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL)
      JOIN sessions s ON s.token_hash=a.original_session_hash AND s.user_id=u.user_id AND s.revoked_at IS NULL
      JOIN principals p ON p.principal_id=a.owner_principal_id AND p.user_ref=u.user_id AND p.kind='person' AND p.status='active'
      JOIN resource_scopes rs ON rs.scope_id=a.scope_id AND rs.owner_principal_id=p.principal_id AND rs.kind='personal' AND rs.status='active'
      JOIN model_connections m ON m.model_connection_id=a.model_connection_id AND m.aggregate_version=a.model_version AND m.state='unverified'
        AND m.owner_user_id=u.user_id AND m.owner_principal_id=p.principal_id AND m.scope_id=rs.scope_id
        AND m.environment=a.environment AND m.client_id=a.client_id AND m.selection=a.model_metadata->'selection'
        AND m.runtime_device_id=(a.model_metadata->>'runtimeDeviceId')::uuid AND m.connection_id=(a.model_metadata->>'connectionId')::uuid
        AND m.family_id=(a.model_metadata->>'familyId')::uuid
      JOIN runtime_registrations runtime ON runtime.runtime_device_id=m.runtime_device_id AND runtime.owner_user_id=u.user_id
        AND runtime.owner_principal_id=p.principal_id AND runtime.scope_id=rs.scope_id AND runtime.environment=a.environment AND runtime.state='enrolled'
      JOIN agent_connections ac ON ac.connection_id=m.connection_id AND ac.runtime_device_id=m.runtime_device_id
        AND ac.owner_user_id=u.user_id AND ac.owner_principal_id=p.principal_id AND ac.scope_id=rs.scope_id
        AND ac.environment=a.environment AND ac.client_id=a.client_id AND ac.state='active'
      JOIN bootstrap_refresh_families f ON f.family_id=m.family_id AND f.connection_id=ac.connection_id AND f.state='active'
      LEFT JOIN broker_model_credentials existing ON existing.model_connection_id=m.model_connection_id
      LEFT JOIN broker_model_credentials old ON old.credential_id=a.old_credential_id
      LEFT JOIN model_connections om ON om.model_connection_id=a.old_model_connection_id
      LEFT JOIN runtime_registrations ort ON ort.runtime_device_id=old.runtime_device_id
      LEFT JOIN agent_connections oac ON oac.connection_id=old.connection_id
      LEFT JOIN bootstrap_refresh_families ofam ON ofam.family_id=old.family_id
      WHERE a.authorization_id=$1 AND a.original_session_hash=$2 AND a.command_digest=$3 AND a.nonce_hash=$4
        AND a.environment=$5 AND a.client_id=$6 AND a.recovery_generation=$7
        AND s.expires_at>clock_timestamp() AND a.issued_at<=clock_timestamp() AND a.expires_at>clock_timestamp()
        AND (a.setup_expires_at IS NULL OR a.setup_expires_at>clock_timestamp())
        AND (a.write_expires_at IS NULL OR a.write_expires_at>clock_timestamp())
        AND runtime.enrolled_at<=clock_timestamp() AND m.created_at<=clock_timestamp()
        AND ac.issued_at<=clock_timestamp() AND ac.expires_at>clock_timestamp()
        AND f.issued_at<=clock_timestamp() AND f.expires_at>clock_timestamp()
        AND (existing.credential_id IS NULL OR (a.submitted_credential_id=existing.credential_id
          AND existing.binding=a.submitted_binding AND existing.state='active' AND existing.expires_at>clock_timestamp()))
        AND ($8::jsonb IS NULL OR a.submitted_binding=$8::jsonb)
        AND (a.operation='create' OR (old.generation=a.old_credential_generation AND old.model_connection_id=a.old_model_connection_id
          AND old.model_version=a.old_model_version AND old.owner_user_id=u.user_id AND old.owner_principal_id=p.principal_id
          AND old.scope_id=rs.scope_id AND old.environment=a.environment AND old.client_id=a.client_id
          AND old.recovery_generation=a.recovery_generation AND old.expires_at>clock_timestamp()
          AND om.selection=old.selection AND om.runtime_device_id=old.runtime_device_id AND om.connection_id=old.connection_id AND om.family_id=old.family_id
          AND ort.state='enrolled' AND ort.enrolled_at<=clock_timestamp() AND oac.state='active'
          AND oac.issued_at<=clock_timestamp() AND oac.expires_at>clock_timestamp() AND ofam.state='active'
          AND ofam.issued_at<=clock_timestamp() AND ofam.expires_at>clock_timestamp()
          AND ((old.state='active' AND old.aggregate_version=a.old_credential_version AND om.state='unverified' AND om.aggregate_version=a.old_model_version)
            OR (old.state='rotated' AND old.aggregate_version=a.old_credential_version+1 AND old.replacement_credential_id=a.submitted_credential_id
              AND om.state='revoked' AND om.aggregate_version=a.old_model_version+1 AND existing.credential_id=a.submitted_credential_id
              AND existing.binding=a.submitted_binding))))`,
      [row.authorization_id,row.original_session_hash,row.command_digest,row.nonce_hash,environment,clientId,r.generation,expectedBinding?JSON.stringify(expectedBinding):null])).rows[0];
    const expiry=Math.min(row.expires_at.getTime(),row.setup_expires_at?.getTime()??Infinity,row.write_expires_at?.getTime()??Infinity,
      result?.session_expiry.getTime()??0,result?.connection_expiry.getTime()??0,result?.family_expiry.getTime()??0,result?.old_expiry?.getTime()??Infinity,Date.parse(r.expiresAt));
    if(!result||r.generation!==row.recovery_generation||expiry<=Math.max(result.now.getTime(),Date.now()))invalid();return result;
  }
  async function assertCurrent(q:PoolClient,invocation:OpaqueCredentialIngestInvocation):Promise<void> {
    const data=captured(invocation);active(data);const r=await recovery();active(data);await currentRow(q,data.row,r,data.binding);active(data);
    const after=await recovery();active(data);if(after.generation!==r.generation)invalid();await currentRow(q,data.row,after,data.binding);active(data);
    // Only this exact committed sealed binding may complete this authorization.
    // This update is inside the original store transaction and rolls back with it.
    if(data.binding){
      await q.query(`UPDATE credential_ingest_authorizations a SET committed_at=date_trunc('milliseconds',clock_timestamp()),committed_credential_id=a.submitted_credential_id
        WHERE a.authorization_id=$1 AND a.committed_at IS NULL AND EXISTS(SELECT 1 FROM broker_model_credentials c JOIN broker_credential_vault v USING(credential_id)
          WHERE c.credential_id=a.submitted_credential_id AND c.binding=a.submitted_binding AND c.state='active')`,[data.row.authorization_id]);
      active(data);await currentRow(q,data.row,after,data.binding);active(data);
    }
  }
  function read(invocation:OpaqueCredentialIngestInvocation):CredentialIngestInvocationData {const data=captured(invocation);active(data);return data.data;}
  async function target(q:PoolClient,actor:Actor,context:MemberScopeContext,command:CredentialIngestCommand,r:RecoveryObservation) {
    const modelId=command.operation==='create'?command.input.modelConnectionId:command.input.replacementModelConnectionId;
    const modelVersion=command.operation==='create'?command.input.expectedModelVersion:command.input.expectedReplacementModelVersion;
    const model=(await q.query(`SELECT m.*,m.aggregate_version::text,s.expires_at session_expiry,ac.expires_at connection_expiry,f.expires_at family_expiry,
      date_trunc('milliseconds',clock_timestamp()) now FROM model_connections m
      JOIN runtime_registrations d ON d.runtime_device_id=m.runtime_device_id AND d.state='enrolled' AND d.enrolled_at<=clock_timestamp()
      JOIN agent_connections ac ON ac.connection_id=m.connection_id AND ac.state='active' AND ac.issued_at<=clock_timestamp() AND ac.expires_at>clock_timestamp()
      JOIN bootstrap_refresh_families f ON f.family_id=m.family_id AND f.connection_id=ac.connection_id AND f.state='active' AND f.issued_at<=clock_timestamp() AND f.expires_at>clock_timestamp()
      JOIN sessions s ON s.token_hash=$7 AND s.user_id=m.owner_user_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
      WHERE m.model_connection_id=$1 AND m.aggregate_version=$8 AND m.owner_user_id=$2 AND m.owner_principal_id=$3 AND m.scope_id=$4
        AND m.environment=$5 AND m.client_id=$6 AND m.state='unverified' AND m.created_at<=clock_timestamp()
        AND NOT EXISTS(SELECT 1 FROM broker_model_credentials c WHERE c.model_connection_id=m.model_connection_id)`,
      [modelId,actor.user_id,context.subject_principal.principal_id,context.scope.scope_id,environment,clientId,actor.session_hash,modelVersion])).rows[0];
    if(!model)invalid();parse(BrokerModelSelectionSchema,model.selection);
    let old:any;
    if(command.operation==='rotate'){
      old=(await q.query(`SELECT c.*,c.aggregate_version::text,c.generation::text,c.model_version::text,
        ac.expires_at connection_expiry,f.expires_at family_expiry FROM broker_model_credentials c
        JOIN model_connections m ON m.model_connection_id=c.model_connection_id AND m.state='unverified' AND m.aggregate_version=c.model_version AND m.selection=c.selection
        JOIN runtime_registrations rt ON rt.runtime_device_id=c.runtime_device_id AND rt.state='enrolled' AND rt.enrolled_at<=clock_timestamp()
        JOIN agent_connections ac ON ac.connection_id=c.connection_id AND ac.state='active' AND ac.issued_at<=clock_timestamp() AND ac.expires_at>clock_timestamp()
        JOIN bootstrap_refresh_families f ON f.family_id=c.family_id AND f.state='active' AND f.issued_at<=clock_timestamp() AND f.expires_at>clock_timestamp()
        WHERE c.credential_id=$1 AND c.aggregate_version=$2 AND c.owner_user_id=$3 AND c.owner_principal_id=$4 AND c.scope_id=$5
          AND c.environment=$6 AND c.client_id=$7 AND c.state='active' AND c.issued_at<=clock_timestamp() AND c.expires_at>clock_timestamp()
          AND c.recovery_generation=$8 AND c.model_connection_id<>$9 AND c.generation<9223372036854775807`,
        [command.input.credentialId,command.input.expectedVersion,actor.user_id,context.subject_principal.principal_id,context.scope.scope_id,environment,clientId,r.generation,modelId])).rows[0];
      if(!old)invalid();
    }
    const metadata=parse(ModelConnectionMetadataSchema,{modelConnectionId:model.model_connection_id,connectionId:model.connection_id,runtimeDeviceId:model.runtime_device_id,
      familyId:model.family_id,environment,clientId,selection:model.selection,state:model.state,aggregateVersion:model.aggregate_version,createdAt:model.created_at.toISOString(),operational_authority:false});
    return {model,old,metadata};
  }
  async function issue(rawActor:Actor,input:{command:CredentialIngestCommand;nonce:string}):Promise<CredentialIngestBootstrapClaims> {
    input=parse(z.object({command:c.CredentialIngestCommandSchema,nonce:c.CredentialIngestBootstrapClaimsSchema.shape.nonce}).strict(),input);
    const actor=captureActor(rawActor),command=input.command,digest=credentialIngestCommandDigest(command),r=await recovery();
    let row!:Row,existing=false;
    const targetId=command.operation==='create'?command.input.modelConnectionId:command.input.credentialId;
    return scopedMemberCommand(pool,{actor,scope:'personal',operation:`broker.credential-ingest.issue.${command.operation}`,key:command.input.key,
      target:{kind:command.operation==='create'?'model_connection':'model_credential',id:targetId},body:{environment,clientId,command}},async(q,context)=>{
      const prior=(await q.query<Row>(`SELECT a.*,${rowColumns} FROM credential_ingest_authorizations a WHERE a.owner_principal_id=$1 AND a.scope_id=$2
        AND a.environment=$3 AND a.client_id=$4 AND a.operation=$5 AND a.command_key=$6`,[context.subject_principal.principal_id,context.scope.scope_id,environment,clientId,command.operation,command.input.key])).rows[0];
      if(prior){requireCondition(prior.command_digest===digest,409,'idempotency_conflict','Command key has different semantics.');if(prior.original_session_hash!==actor.session_hash)invalid();row=prior;existing=true;await currentRow(q,row,r);return;}
      const t=await target(q,actor,context,command,r),expires=new Date(Math.min(t.model.now.getTime()+c.CredentialIngestLimits.authorizationMs,
        t.model.session_expiry.getTime(),t.model.connection_expiry.getTime(),t.model.family_expiry.getTime(),Date.parse(r.expiresAt),
        t.old?.expires_at.getTime()??Infinity,t.old?.connection_expiry.getTime()??Infinity,t.old?.family_expiry.getTime()??Infinity));
      if(expires.getTime()<=Math.max(t.model.now.getTime(),Date.now()))invalid();
      const assertion=parse(c.CredentialIngestBootstrapClaimsSchema,{profile:'credential-ingest.bootstrap/v1',issuer,audience,purpose:'credential-broker.ingest-bootstrap',setupOrigin,
        operation:command.operation,environment,clientId,authorizationRef:randomUUID(),nonce:input.nonce,commandDigest:digest,recoveryGeneration:r.generation,
        issuedAt:t.model.now.toISOString(),expiresAt:expires.toISOString()});
      row={authorization_id:assertion.authorizationRef,owner_user_id:actor.user_id,owner_principal_id:context.subject_principal.principal_id,scope_id:context.scope.scope_id,
        original_session_hash:actor.session_hash,environment,client_id:clientId,operation:command.operation,command_key:command.input.key,command,command_digest:digest,
        nonce_hash:hash(assertion.nonce),assertion,model_connection_id:t.model.model_connection_id,model_version:t.model.aggregate_version,model_metadata:t.metadata,
        old_credential_id:t.old?.credential_id??null,old_credential_version:t.old?.aggregate_version??null,old_credential_generation:t.old?.generation??null,
        old_model_connection_id:t.old?.model_connection_id??null,old_model_version:t.old?.model_version??null,recovery_generation:r.generation,
        issued_at:t.model.now,expires_at:expires,bootstrap_claimed_at:null,setup_cookie_hash:null,setup_csrf_hash:null,setup_expires_at:null,
        submission_claimed_at:null,write_expires_at:null,submitted_credential_id:null,submitted_binding:null,committed_at:null,committed_credential_id:null};
    },async q=>{
      if(existing)return parse(c.CredentialIngestBootstrapClaimsSchema,row.assertion);
      await q.query(`INSERT INTO credential_ingest_authorizations(authorization_id,owner_user_id,owner_principal_id,scope_id,original_session_hash,environment,client_id,
        operation,command_key,command,command_digest,nonce_hash,assertion,model_connection_id,model_version,model_metadata,old_credential_id,old_credential_version,
        old_credential_generation,old_model_connection_id,old_model_version,recovery_generation,issued_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
        [row.authorization_id,row.owner_user_id,row.owner_principal_id,row.scope_id,row.original_session_hash,environment,clientId,row.operation,command.input.key,JSON.stringify(command),digest,
          row.nonce_hash,JSON.stringify(row.assertion),row.model_connection_id,row.model_version,JSON.stringify(row.model_metadata),row.old_credential_id,row.old_credential_version,
          row.old_credential_generation,row.old_model_connection_id,row.old_model_version,row.recovery_generation,row.issued_at,row.expires_at]);return row.assertion;
    },async q=>{
      const persisted=(await q.query<Row>(`SELECT a.*,${rowColumns} FROM credential_ingest_authorizations a WHERE a.authorization_id=$1`,[row.authorization_id])).rows[0];
      const fresh=await recovery();if(fresh.generation!==row.recovery_generation||row.expires_at.getTime()<=Date.now())invalid();
      if(persisted){if(persisted.original_session_hash!==actor.session_hash)invalid();await currentRow(q,persisted,fresh);}
      else await target(q,actor,{authn_kind:'member_session',subject_principal:{principal_id:row.owner_principal_id,kind:'person'},scope:{scope_id:row.scope_id,kind:'personal'}},command,fresh);
    });
  }
  async function claimBootstrap(raw:CredentialIngestBootstrapClaims,input:{cookieHash:string;csrfHash:string}):Promise<OpaqueCredentialIngestInvocation> {
    input=parse(z.object({cookieHash:Hash,csrfHash:Hash}).strict(),input);
    const claims=parse(c.CredentialIngestBootstrapClaimsSchema,raw),cookieHash=input.cookieHash,csrfHash=input.csrfHash;
    if(claims.environment!==environment||claims.clientId!==clientId||claims.issuer!==issuer||claims.audience!==audience||claims.setupOrigin!==setupOrigin
      ||Date.parse(claims.issuedAt)>Date.now()||Date.parse(claims.expiresAt)<=Date.now()
      ||Date.parse(claims.expiresAt)-Date.parse(claims.issuedAt)>c.CredentialIngestLimits.authorizationMs)invalid();
    return transaction(pool,async q=>{
      const row=(await q.query<Row>(`SELECT a.*,${rowColumns} FROM credential_ingest_authorizations a WHERE a.authorization_id=$1 FOR UPDATE`,[claims.authorizationRef])).rows[0];
      if(!row||row.bootstrap_claimed_at||!equal(row.assertion,claims)||row.nonce_hash!==hash(claims.nonce)||credentialIngestCommandDigest(row.command)!==claims.commandDigest)invalid();
      const auth=await currentRow(q,row,await recovery());
      const updated=(await q.query<Row>(`UPDATE credential_ingest_authorizations a SET bootstrap_claimed_at=date_trunc('milliseconds',clock_timestamp()),
        setup_cookie_hash=$2,setup_csrf_hash=$3,setup_expires_at=expires_at WHERE authorization_id=$1 AND bootstrap_claimed_at IS NULL RETURNING a.*,${rowColumns}`,
        [row.authorization_id,cookieHash,csrfHash])).rows[0];if(!updated)invalid();
      const actor=Object.freeze({user_id:row.owner_user_id,community_id:auth.community_id,session_hash:row.original_session_hash}) as Actor;
      const data=freezeTree({actor,command:parse(c.CredentialIngestCommandSchema,row.command),authorizationRef:row.authorization_id,nonce:claims.nonce,
        commandDigest:row.command_digest,recoveryGeneration:row.recovery_generation,expiresAt:row.expires_at.toISOString(),setupExpiresAt:updated.setup_expires_at!.toISOString(),
        model:parse(ModelConnectionMetadataSchema,row.model_metadata)});
      const invocation=Object.freeze(Object.create(null)) as OpaqueCredentialIngestInvocation;
      invocations.set(invocation,{identity,row:updated,data,monotonic:performance.now()+Math.max(0,updated.setup_expires_at!.getTime()-Date.now())});
      await assertCurrent(q,invocation);return invocation;
    });
  }
  async function claimSubmission(invocation:OpaqueCredentialIngestInvocation,input:{binding:ModelCredentialBinding;writeExpiresAt:string;cookieHash:string;csrfHash:string}):Promise<void> {
    input=parse(z.object({binding:ModelCredentialBindingSchema,writeExpiresAt:z.iso.datetime({precision:3}),cookieHash:Hash,csrfHash:Hash}).strict(),input);
    const data=captured(invocation);active(data);const binding=input.binding,cookieHash=input.cookieHash,csrfHash=input.csrfHash;
    const writeExpiry=new Date(z.iso.datetime({precision:3}).parse(input.writeExpiresAt));
    const model=data.data.model,row=data.row;
    if(cookieHash!==row.setup_cookie_hash||csrfHash!==row.setup_csrf_hash||binding.modelConnectionId!==model.modelConnectionId||binding.modelVersion!==model.aggregateVersion
      ||binding.ownerUserId!==row.owner_user_id||binding.ownerPrincipalId!==row.owner_principal_id||binding.scopeId!==row.scope_id
      ||binding.environment!==environment||binding.clientId!==clientId||binding.runtimeDeviceId!==model.runtimeDeviceId
      ||binding.connectionId!==model.connectionId||binding.familyId!==model.familyId||!equal(binding.selection,model.selection)
      ||binding.recoveryGeneration!==row.recovery_generation||binding.generation!==(row.operation==='create'?'1':String(BigInt(row.old_credential_generation!)+1n))
      ||Date.parse(binding.issuedAt)>Date.now()||writeExpiry.getTime()>Date.parse(binding.issuedAt)+c.CredentialIngestLimits.writeMs
      ||writeExpiry.getTime()>Date.parse(binding.expiresAt)||writeExpiry.getTime()>row.setup_expires_at!.getTime()||writeExpiry.getTime()<=Date.now())invalid();
    await transaction(pool,async q=>{
      const current=(await q.query<Row>(`SELECT a.*,${rowColumns} FROM credential_ingest_authorizations a WHERE a.authorization_id=$1 FOR UPDATE`,[row.authorization_id])).rows[0];
      if(!current||current.submission_claimed_at||current.setup_cookie_hash!==cookieHash||current.setup_csrf_hash!==csrfHash)invalid();
      await assertCurrent(q,invocation);active(data);
      const updated=(await q.query<Row>(`UPDATE credential_ingest_authorizations a SET submission_claimed_at=date_trunc('milliseconds',clock_timestamp()),
        write_expires_at=$2,submitted_credential_id=$3,submitted_binding=$4 WHERE authorization_id=$1 AND submission_claimed_at IS NULL RETURNING a.*,${rowColumns}`,
        [row.authorization_id,writeExpiry,binding.credentialId,JSON.stringify(binding)])).rows[0];if(!updated)invalid();
      await currentRow(q,updated,await recovery(),binding);active(data);
      // Capture only after the SQL claim commits below. A late result cannot
      // regrant submission; registry callers remain responsible for cancellation.
      return updated;
    }).then(updated=>{data.row=updated;data.binding=binding;data.writeMonotonic=performance.now()+Math.max(0,writeExpiry.getTime()-Date.now());active(data);});
  }
  async function readOwnerOutcome(rawActor:Actor,authorizationRef:string):Promise<CredentialIngestOwnerOutcome> {
    const actor=captureActor(rawActor),ref=z.uuid().parse(authorizationRef);
    return withMemberScope(pool,{actor,scope:'personal'},async()=>{},async(q,context)=>{
      const row=(await q.query<Row>(`SELECT a.*,${rowColumns} FROM credential_ingest_authorizations a WHERE a.authorization_id=$1
        AND a.owner_user_id=$2 AND a.owner_principal_id=$3 AND a.scope_id=$4 AND a.environment=$5 AND a.client_id=$6`,
        [ref,actor.user_id,context.subject_principal.principal_id,context.scope.scope_id,environment,clientId])).rows[0];if(!row)invalid();
      let credential=null;
      if(row.committed_credential_id){const found=(await q.query(`SELECT binding,credential_id,state,aggregate_version::text,terminal_at,replacement_credential_id
        FROM broker_model_credentials WHERE credential_id=$1 AND owner_user_id=$2 AND owner_principal_id=$3 AND scope_id=$4 AND environment=$5 AND client_id=$6`,
        [row.committed_credential_id,actor.user_id,context.subject_principal.principal_id,context.scope.scope_id,environment,clientId])).rows[0];if(!found)invalid();
        const b=parse(ModelCredentialBindingSchema,found.binding);credential=parse(ModelCredentialMetadataSchema,{credentialId:found.credential_id,modelConnectionId:b.modelConnectionId,
          modelVersion:b.modelVersion,generation:b.generation,aggregateVersion:found.aggregate_version,state:found.state,selection:b.selection,recoveryGeneration:b.recoveryGeneration,
          issuedAt:b.issuedAt,expiresAt:b.expiresAt,terminalAt:found.terminal_at?.toISOString()??null,replacementCredentialId:found.replacement_credential_id,operational_authority:false});}
      const result=parse(c.CredentialIngestOwnerOutcomeSchema,{authorizationRef:ref,operation:row.operation,
        state:row.committed_at?'committed':row.submission_claimed_at?'submission_claimed':row.bootstrap_claimed_at?'setup_claimed':'issued',credential,operational_authority:false});
      await assertCurrentSessionClock(q,actor);return result;
    });
  }
  return Object.freeze({issue,claimBootstrap,read,claimSubmission,assertCurrent,readOwnerOutcome});
}
