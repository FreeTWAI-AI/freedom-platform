import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import type { Actor } from '../identity-membership/service.js';
import { scopedMemberCommand } from '../../packages/scoped-commands/index.js';
import type { MemberScopeContext } from '../../packages/resource-scopes/index.js';
import { transaction } from '../../packages/db/transaction.js';
import { requireCondition } from '../../packages/shared/problem.js';
import { snapshotInput, freezeTree } from '../../packages/execution-state/decode.js';
import { RuntimeEnvironmentSchema } from '../../contracts/execution/v1/runtime-registration.js';
import { BootstrapClientIdSchema } from '../../contracts/execution/v1/bootstrap.js';
import { CredentialRecoveryFloorSchema } from '../../contracts/execution/v2/model-credential.js';
import type { RecoveryObservation } from '../agent-execution/model-step-host.js';
import * as c from '../../contracts/execution/v2/model-broker-bridge.js';

declare const invocationBrand: unique symbol;
export interface OpaqueModelBrokerInvocation { readonly [invocationBrand]: never }
interface Row {
  authorization_id:string;owner_user_id:string;owner_principal_id:string;scope_id:string;original_session_hash:string;
  environment:string;client_id:string;operation:'activate'|'execute';command:c.ModelBrokerCommand;command_digest:string;
  nonce_hash:string;assertion:c.ModelBrokerAssertionPayload;credential_id:string;credential_generation:string;
  model_connection_id:string;model_version:string;recovery_generation:string;issued_at:Date;expires_at:Date;accepted_at:Date|null;
}
export interface ModelBrokerInvocationData {
  readonly actor:Actor; readonly command:c.ModelBrokerCommand; readonly operation:'activate'|'execute';
  readonly credentialPin:Readonly<{credentialId:string;expectedGeneration:string}>;
  readonly sessionIdentity:string;readonly authorizationRef:string;readonly commandDigest:string;
  readonly recoveryGeneration:string;readonly expiresAt:string;readonly modelConnectionId:string;readonly modelVersion:string;
  readonly credentialExpiresAt:string;readonly sessionExpiresAt:string;
}
interface Captured { identity:object;row:Row;data:ModelBrokerInvocationData }
const invocations=new WeakMap<object,Captured>();
const invalid=()=>requireCondition(false,403,'model_broker_authorization_invalid','Broker member authorization is unavailable.');
const parse=<T>(schema:z.ZodType<T>,raw:unknown):T=>freezeTree(schema.parse(snapshotInput(raw)));
const ordered=(value:unknown):unknown=>!value||typeof value!=='object'?value:Array.isArray(value)?value.map(ordered)
  :Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered((value as Record<string,unknown>)[key])]));
export const modelBrokerCommandDigest=(command:c.ModelBrokerCommand):string=>createHash('sha256')
  .update(JSON.stringify(ordered(parse(c.ModelBrokerCommandSchema,command)))).digest('hex');
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const columns='a.credential_generation::text,a.model_version::text,a.recovery_generation::text';

/** This server-only adapter receives signed claims AFTER pinned verification.
 * It derives Actor solely from the immutable SQL authorization's genuine
 * original session. It never accepts a transported Actor or arbitrary user ID. */
export function createModelBrokerAuthorizations(pool:Pool,options:{environment:z.infer<typeof RuntimeEnvironmentSchema>;
  clientId:string;issuer:string;audience:string;recover:()=>Promise<RecoveryObservation>}) {
  const descriptors=Object.getOwnPropertyDescriptors(options);
  requireCondition(Object.getPrototypeOf(options)===Object.prototype&&Reflect.ownKeys(options).length===5
    &&['environment','clientId','issuer','audience','recover'].every(key=>descriptors[key]?.enumerable&&'value' in descriptors[key]),
    503,'model_broker_unavailable','Broker ports are unavailable.');
  const environment=RuntimeEnvironmentSchema.parse(descriptors.environment.value),clientId=BootstrapClientIdSchema.parse(descriptors.clientId.value);
  const issuer=descriptors.issuer.value as string,audience=descriptors.audience.value as string,recover=descriptors.recover.value as ()=>Promise<RecoveryObservation>;
  const identity=Object.freeze(Object.create(null));
  requireCondition(typeof recover==='function'&&typeof issuer==='string'&&typeof audience==='string'
    &&issuer.length>0&&audience.length>0,503,'model_broker_unavailable','Broker ports are unavailable.');
  async function recovery():Promise<RecoveryObservation> {
    const started=performance.now();let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const result=parse(CredentialRecoveryFloorSchema,await Promise.race([Promise.resolve().then(recover),new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>reject(new Error('model_broker_unavailable')),3000);
      })]));
      if(performance.now()-started>=3000||Date.parse(result.expiresAt)<=Date.now())invalid();return result;
    } catch {invalid();throw new Error('model_broker_authorization_invalid');}
    finally {if(timer)clearTimeout(timer);}
  }
  interface Authority {community_id:string;session_expiry:Date;credential_expiry:Date;now:Date}
  async function currentRow(q:PoolClient,row:Row,r:RecoveryObservation):Promise<Authority> {
    const found=(await q.query<Authority>(`SELECT u.community_id,s.expires_at session_expiry,c.expires_at credential_expiry,clock_timestamp() now
      FROM model_broker_authorizations a JOIN users u ON u.user_id=a.owner_user_id AND u.active
        AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL)
      JOIN sessions s ON s.token_hash=a.original_session_hash AND s.user_id=u.user_id AND s.revoked_at IS NULL
      JOIN principals p ON p.principal_id=a.owner_principal_id AND p.user_ref=u.user_id AND p.kind='person' AND p.status='active'
      JOIN resource_scopes rs ON rs.scope_id=a.scope_id AND rs.owner_principal_id=p.principal_id AND rs.kind='personal' AND rs.status='active'
      JOIN broker_model_credentials c ON c.credential_id=a.credential_id AND c.generation=a.credential_generation AND c.state='active'
        AND c.recovery_generation=a.recovery_generation AND c.model_connection_id=a.model_connection_id AND c.model_version=a.model_version
        AND c.owner_user_id=u.user_id AND c.owner_principal_id=p.principal_id AND c.scope_id=rs.scope_id
        AND c.environment=a.environment AND c.client_id=a.client_id
      JOIN model_connections m ON m.model_connection_id=c.model_connection_id AND m.aggregate_version=c.model_version AND m.state='unverified'
        AND m.selection=c.selection AND m.runtime_device_id=c.runtime_device_id AND m.connection_id=c.connection_id AND m.family_id=c.family_id
      JOIN runtime_registrations d ON d.runtime_device_id=c.runtime_device_id AND d.state='enrolled'
      JOIN agent_connections ac ON ac.connection_id=c.connection_id AND ac.state='active'
      JOIN bootstrap_refresh_families f ON f.family_id=c.family_id AND f.state='active'
      WHERE a.authorization_id=$1 AND a.original_session_hash=$2 AND a.command_digest=$3
        AND a.nonce_hash=$4 AND a.environment=$5 AND a.client_id=$6 AND a.recovery_generation=$7
        AND s.expires_at>clock_timestamp() AND a.issued_at<=clock_timestamp() AND a.expires_at>clock_timestamp()
        AND c.issued_at<=clock_timestamp() AND c.expires_at>clock_timestamp()
        AND ac.issued_at<=clock_timestamp() AND ac.expires_at>clock_timestamp()
        AND f.issued_at<=clock_timestamp() AND f.expires_at>clock_timestamp()`,
    [row.authorization_id,row.original_session_hash,row.command_digest,row.nonce_hash,environment,clientId,r.generation])).rows[0];
    if(!found||r.generation!==row.recovery_generation||Date.parse(r.expiresAt)<=found.now.getTime()
      ||Math.min(row.expires_at.getTime(),found.session_expiry.getTime(),found.credential_expiry.getTime(),Date.parse(r.expiresAt))<=Date.now())invalid();
    return found!;
  }
  async function assertCurrent(q:PoolClient,invocation:OpaqueModelBrokerInvocation):Promise<void> {
    const captured=invocation&&typeof invocation==='object'?invocations.get(invocation):undefined;
    if(!captured||captured.identity!==identity)invalid();
    const r=await recovery();await currentRow(q,captured!.row,r);
    // Re-read the external floor after SQL delivery, then observe SQL/session
    // clock again. These bounded observations do not claim one atomic snapshot.
    const after=await recovery();if(after.generation!==r.generation)invalid();await currentRow(q,captured!.row,after);
  }
  function read(invocation:OpaqueModelBrokerInvocation):ModelBrokerInvocationData {
    const captured=invocation&&typeof invocation==='object'?invocations.get(invocation):undefined;
    if(!captured||captured.identity!==identity)invalid();return captured!.data;
  }
  interface Target {approval_id:string;step_id:string|null;run_id:string;work_item_id:string;grant_id:string;credential_id:string;
    credential_generation:string;credential_recovery:string;model_connection_id:string;model_version:string;approval_expiry:Date;credential_expiry:Date;session_expiry:Date;
    connection_expiry:Date;family_expiry:Date;grant_expiry:Date;step_expiry:Date|null;now:Date}
  async function target(q:PoolClient,actor:Actor,context:MemberScopeContext,command:c.ModelBrokerCommand):Promise<Target> {
    const activate=command.operation==='activate';
    const result=(await q.query<Target>(`SELECT a.approval_id,${activate?'NULL::uuid':'s.step_id'} step_id,a.run_id,a.work_item_id,a.grant_id,
      c.credential_id,c.generation::text credential_generation,c.recovery_generation::text credential_recovery,c.model_connection_id,c.model_version::text,
      a.expires_at approval_expiry,c.expires_at credential_expiry,se.expires_at session_expiry,
      ac.expires_at connection_expiry,f.expires_at family_expiry,g.expires_at grant_expiry,${activate?'NULL::timestamptz':'s.lease_expires_at'} step_expiry,date_trunc('milliseconds',clock_timestamp()) now
      FROM model_export_approvals a ${activate?'':'JOIN model_text_steps s ON s.approval_id=a.approval_id'}
      JOIN execution_grants g ON g.grant_id=a.grant_id AND g.state='active' AND g.aggregate_version=a.grant_version
      JOIN execution_runs run ON run.run_id=a.run_id
      JOIN work_items w ON w.work_item_id=a.work_item_id AND w.state='draft' AND w.aggregate_version=a.input_work_version
      JOIN broker_model_credentials c ON c.model_connection_id=g.model_connection_id AND c.model_version=g.model_version
        AND c.state='active' AND c.selection=g.selection AND c.owner_user_id=a.owner_user_id AND c.owner_principal_id=a.owner_principal_id
        AND c.scope_id=a.scope_id AND c.environment=a.environment AND c.client_id=a.client_id
      JOIN model_connections m ON m.model_connection_id=c.model_connection_id AND m.aggregate_version=c.model_version AND m.state='unverified'
      JOIN runtime_registrations d ON d.runtime_device_id=c.runtime_device_id AND d.state='enrolled' AND d.aggregate_version=g.runtime_version
      JOIN agent_connections ac ON ac.connection_id=c.connection_id AND ac.state='active' AND ac.aggregate_version=g.connection_version
      JOIN bootstrap_refresh_families f ON f.family_id=c.family_id AND f.state='active'
      JOIN sessions se ON se.token_hash=$7 AND se.user_id=a.owner_user_id AND se.revoked_at IS NULL
      WHERE ${activate?'a.approval_id=$1 AND a.aggregate_version=$8 AND run.state=\'created\' AND run.aggregate_version=$9'
        :'s.step_id=$1 AND s.aggregate_version=$8 AND s.state=\'reserved\' AND s.lease_expires_at>clock_timestamp() AND run.state=\'running\' AND run.current_attempt_id=s.attempt_id AND run.aggregate_version=s.activated_run_version AND run.task_lease_epoch=s.task_lease_epoch AND run.control_epoch=s.control_epoch'}
        AND a.owner_user_id=$2 AND a.owner_principal_id=$3 AND a.scope_id=$4 AND a.environment=$5 AND a.client_id=$6 AND a.state='active'
        AND a.issued_at<=clock_timestamp() AND a.expires_at>clock_timestamp() AND g.expires_at>clock_timestamp()
        AND c.issued_at<=clock_timestamp() AND c.expires_at>clock_timestamp() AND se.expires_at>clock_timestamp()
        AND ac.issued_at<=clock_timestamp() AND ac.expires_at>clock_timestamp() AND f.issued_at<=clock_timestamp() AND f.expires_at>clock_timestamp()`,
      activate?[command.input.approvalId,actor.user_id,context.subject_principal.principal_id,context.scope.scope_id,environment,clientId,actor.session_hash,
        command.input.expectedApprovalVersion,command.input.expectedRunVersion]:[command.input.stepId,actor.user_id,context.subject_principal.principal_id,context.scope.scope_id,
        environment,clientId,actor.session_hash,command.input.expectedVersion])).rows[0];
    if(!result)invalid();return result!;
  }
  async function issue(actor:Actor,input:{operation:'activate'|'execute';command:c.ModelBrokerCommand;nonce:string}):Promise<c.ModelBrokerAssertionPayload> {
    actor=Object.freeze({...actor});
    const command=parse(c.ModelBrokerCommandSchema,input.command);
    if(command.operation!==input.operation)invalid();
    const r=await recovery();let row!:Row,existing=false;
    const targetId=command.operation==='activate'?command.input.approvalId:command.input.stepId;
    return scopedMemberCommand(pool,{actor,scope:'personal',operation:`execution.model-broker.issue.${command.operation}`,key:command.input.key,
      target:{kind:command.operation==='activate'?'model_export_approval':'model_text_step',id:targetId},
      body:{environment,clientId,command}},async(q,context)=>{
      const prior=(await q.query<Row>(`SELECT a.*,${columns} FROM model_broker_authorizations a
        WHERE a.owner_principal_id=$1 AND a.scope_id=$2 AND a.environment=$3 AND a.client_id=$4 AND a.operation=$5 AND a.command_key=$6`,
      [context.subject_principal.principal_id,context.scope.scope_id,environment,clientId,command.operation,command.input.key])).rows[0];
      if(prior){
        requireCondition(prior.command_digest===modelBrokerCommandDigest(command),409,'idempotency_conflict','The command key has different semantics.');
        if(prior.original_session_hash!==actor.session_hash)invalid();
        row=prior;existing=true;await currentRow(q,row,r);return;
      }
      const backing=await target(q,actor,context,command);
      if(backing.credential_recovery!==r.generation)invalid();
      const expires=new Date(Math.min(backing.now.getTime()+c.ModelBrokerLimits.authorizationMs,Date.parse(r.expiresAt),backing.approval_expiry.getTime(),
        backing.credential_expiry.getTime(),backing.session_expiry.getTime(),backing.connection_expiry.getTime(),backing.family_expiry.getTime(),backing.grant_expiry.getTime(),backing.step_expiry?.getTime()??Infinity));
      const assertion=parse(c.ModelBrokerAssertionPayloadSchema,{profile:'model-broker.assertion/v1',issuer,audience,
        operation:command.operation,purpose:`model-broker.${command.operation}`,environment,clientId,authorizationRef:randomUUID(),nonce:input.nonce,
        commandDigest:modelBrokerCommandDigest(command),recoveryGeneration:r.generation,issuedAt:backing.now.toISOString(),expiresAt:expires.toISOString()});
      row={authorization_id:assertion.authorizationRef,owner_user_id:actor.user_id,owner_principal_id:context.subject_principal.principal_id,scope_id:context.scope.scope_id,
        original_session_hash:actor.session_hash,environment,client_id:clientId,operation:command.operation,command,command_digest:assertion.commandDigest,
        nonce_hash:hash(assertion.nonce),assertion,credential_id:backing.credential_id,credential_generation:backing.credential_generation,
        model_connection_id:backing.model_connection_id,model_version:backing.model_version,recovery_generation:r.generation,
        issued_at:backing.now,expires_at:expires,accepted_at:null};
      // SQL issue validation captures the actual currently active credential pin.
      if(expires<=backing.now)invalid();
      Object.assign(row,{backing});
    },async(q)=>{
      if(existing)return parse(c.ModelBrokerAssertionPayloadSchema,row.assertion);
      const b=(row as Row&{backing:Target}).backing;
      await q.query(`INSERT INTO model_broker_authorizations(authorization_id,owner_user_id,owner_principal_id,scope_id,original_session_hash,environment,client_id,
        operation,command_key,command,command_digest,nonce_hash,assertion,approval_id,step_id,expected_primary_version,expected_run_version,
        run_id,work_item_id,grant_id,credential_id,credential_generation,model_connection_id,model_version,recovery_generation,issued_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)`,
      [row.authorization_id,row.owner_user_id,row.owner_principal_id,row.scope_id,row.original_session_hash,environment,clientId,row.operation,command.input.key,
        JSON.stringify(command),row.command_digest,row.nonce_hash,JSON.stringify(row.assertion),b.approval_id,b.step_id,
        command.operation==='activate'?command.input.expectedApprovalVersion:command.input.expectedVersion,
        command.operation==='activate'?command.input.expectedRunVersion:null,b.run_id,b.work_item_id,b.grant_id,row.credential_id,row.credential_generation,
        row.model_connection_id,row.model_version,row.recovery_generation,row.issued_at,row.expires_at]);return row.assertion;
    },async(q)=>{
      // Also applies to a receipt retry, which must retain its original session.
      const persisted=(await q.query<Row>(`SELECT a.*,${columns} FROM model_broker_authorizations a WHERE a.owner_principal_id=$1 AND a.scope_id=$2
        AND a.environment=$3 AND a.client_id=$4 AND a.operation=$5 AND a.command_key=$6`,
      [row.owner_principal_id,row.scope_id,environment,clientId,command.operation,command.input.key])).rows[0];
      if(persisted&&persisted.original_session_hash!==actor.session_hash)invalid();
      const freshRecovery=await recovery();
      if(persisted)await currentRow(q,persisted,freshRecovery);
      else {
        const backing=await target(q,actor,{authn_kind:'member_session',subject_principal:{principal_id:row.owner_principal_id,kind:'person'},scope:{scope_id:row.scope_id,kind:'personal'}},command);
        if(backing.credential_id!==row.credential_id||backing.credential_generation!==row.credential_generation
          ||freshRecovery.generation!==row.recovery_generation||backing.credential_recovery!==row.recovery_generation
          ||Math.min(row.expires_at.getTime(),Date.parse(freshRecovery.expiresAt))<=Math.max(backing.now.getTime(),Date.now()))invalid();
      }
    });
  }
  async function claim(raw:c.ModelBrokerAssertionPayload):Promise<Readonly<{invocation:OpaqueModelBrokerInvocation;fresh:boolean}>> {
    const payload=parse(c.ModelBrokerAssertionPayloadSchema,raw);
    if(payload.environment!==environment||payload.clientId!==clientId||payload.issuer!==issuer||payload.audience!==audience
      ||Date.parse(payload.expiresAt)-Date.parse(payload.issuedAt)>c.ModelBrokerLimits.authorizationMs
      ||Date.parse(payload.issuedAt)>Date.now()||Date.parse(payload.expiresAt)<=Date.now())invalid();
    return transaction(pool,async q=>{
      const row=(await q.query<Row>(`SELECT a.*,${columns} FROM model_broker_authorizations a WHERE a.authorization_id=$1 FOR UPDATE`,[payload.authorizationRef])).rows[0];
      if(!row||JSON.stringify(ordered(row.assertion))!==JSON.stringify(ordered(payload))||row.nonce_hash!==hash(payload.nonce)
        ||modelBrokerCommandDigest(row.command)!==payload.commandDigest)invalid();
      const auth=await currentRow(q,row!,await recovery());const fresh=!row!.accepted_at;
      if(fresh){
        const context:MemberScopeContext=Object.freeze({authn_kind:'member_session',subject_principal:{principal_id:row!.owner_principal_id,kind:'person' as const},
          scope:{scope_id:row!.scope_id,kind:'personal' as const}});
        const actor=Object.freeze({user_id:row!.owner_user_id,community_id:auth.community_id,session_hash:row!.original_session_hash}) as Actor;
        await target(q,actor,context,row!.command);
        await q.query("UPDATE model_broker_authorizations SET accepted_at=date_trunc('milliseconds',clock_timestamp()) WHERE authorization_id=$1 AND accepted_at IS NULL",[row!.authorization_id]);
      }
      const actor=Object.freeze({user_id:row!.owner_user_id,community_id:auth.community_id,session_hash:row!.original_session_hash}) as Actor;
      const data=freezeTree({actor,command:parse(c.ModelBrokerCommandSchema,row!.command),operation:row!.operation,
        credentialPin:{credentialId:row!.credential_id,expectedGeneration:row!.credential_generation},
        sessionIdentity:hash(JSON.stringify([row!.owner_user_id,row!.owner_principal_id,row!.scope_id,row!.original_session_hash])),
        authorizationRef:row!.authorization_id,commandDigest:row!.command_digest,recoveryGeneration:row!.recovery_generation,
        expiresAt:row!.expires_at.toISOString(),modelConnectionId:row!.model_connection_id,modelVersion:row!.model_version,
        credentialExpiresAt:auth.credential_expiry.toISOString(),sessionExpiresAt:auth.session_expiry.toISOString()});
      const invocation=Object.freeze(Object.create(null)) as OpaqueModelBrokerInvocation;
      invocations.set(invocation,{identity,row:row!,data});await assertCurrent(q,invocation);return Object.freeze({invocation,fresh});
    });
  }
  return Object.freeze({issue,claim,read,assertCurrent});
}
export type ModelBrokerAuthorizations=ReturnType<typeof createModelBrokerAuthorizations>;
