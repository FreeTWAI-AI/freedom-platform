import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {executionTextCommand} from '../../packages/scoped-commands/execution-text.js';
import {runCommandCore} from '../../packages/db/command-core.js';
import {transaction} from '../../packages/db/transaction.js';
import {digest} from '../../packages/db/index.js';
import {freezeTree,snapshotInput} from '../../packages/execution-state/decode.js';
import {requireCondition} from '../../packages/shared/problem.js';
import {scopedJournal} from '../../packages/scoped-commands/index.js';
import {registerScopedCommand,authorizeScopedCommand,bindScopedExecutionFact,forgetScopedCommand,type ScopedFactContext} from '../../packages/scoped-commands/command-context.js';
import {readLockedPrivateWorkPersistencePolicy} from '../autopilot-work/policy.js';
import {readLockedInferenceExportPolicy} from './export-policy.js';
import {type MachineTextAuthority,type MachineModelSubject,type MachineModelContext} from '../agent-control/machine-text-authority.js';
import type {MachineBrokerBinding} from '../agent-control/machine-model-broker-authorizations.js';
import type {ModelStepAuthority} from './model-step-authority.js';
import type {AuthorityCommand} from '../assets/lifecycle-authority.js';
import {createModelStepServiceWithAuthority} from './model-step-service.js';
import {createPrivateModelResultServiceWithAuthority} from './model-results.js';
import {createModelStepRunner} from './model-step-runner.js';
import type {ModelStepHost} from './model-step-host.js';
import type {ObjectStore} from '../../packages/asset-storage/index.js';
import type {RuntimeEnvironment} from '../../contracts/execution/v1/runtime-registration.js';
import {ActivateSchema,BeginSchema,ReadSchema} from '../../contracts/execution/v2/model-step.js';

export const MachineDispatchEvidenceSchema=z.object({profile:z.literal('freedom.machine-dispatch-evidence/v1'),outcome:z.enum(['outcome_unknown','observed_completion','observed_failure']),reason:z.enum(['client_lost_response','transport_aborted','process_restarted','provider_observation']),evidenceSha256:z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/)}).strict();
const deny=()=>requireCondition(false,403,'machine_model_operation_denied','機器執行範圍不符。');
const metadata=(raw:unknown)=>{const value=snapshotInput(raw),json=JSON.stringify(value);requireCondition(json!==undefined&&Buffer.byteLength(json)<=32768,500,'invalid_machine_metadata','機器中繼資料無效。');return {value:freezeTree(value),json};};
/** Internal fixed adapter. Authn kind and the opaque JS handle confer no SQL
 * authority: resume verifies the captured signatures and exact durable proof,
 * current device and domain admission on this transaction before callbacks. */
export function createMachineModelPorts(authority:MachineTextAuthority):ModelStepAuthority<MachineModelSubject,MachineModelContext>{
  // Capture immutable functions once; no mutable port lookup across awaits.
  requireCondition(Object.isFrozen(authority),500,'machine_authority_required','機器授權尚未設定。');
  const {resume,current,finish,fact,snapshot,describe,attachModel}=authority;
  const active=new WeakMap<MachineModelContext,{q:PoolClient;actor:MachineModelSubject}>();
  async function scope(q:PoolClient,actor:MachineModelSubject,selected:unknown){
    if(selected!=='personal')deny();const c=await resume(q,actor);active.set(c,{q,actor});return c;
  }
  async function check(q:PoolClient,c:MachineModelContext){const a=active.get(c);if(!a||a.q!==q)deny();await current(q,a!.actor);}
  function done(q:PoolClient,c:MachineModelContext){active.delete(c);finish(q,c);forgetScopedCommand(c);}
  async function target(q:PoolClient,input:AuthorityCommand<MachineModelSubject>){
    const d=describe(input.actor);
    if(d.kind==='activate'){
      if(input.operation!=='execution.model-step.activate'||input.target.kind!=='model_export_approval'||input.target.id!==d.approvalId)deny();return;
    }
    if(d.kind!=='execute')deny();const b=d.binding!;
    if(['execution.model-step.begin','execution.model-step.record','execution.model.result.finalize'].includes(input.operation)){
      if(input.target.kind!=='model_text_step'||input.target.id!==b.stepId)deny();return;
    }
    const step=(await q.query('SELECT work_item_id FROM model_text_steps WHERE step_id=$1',[b.stepId])).rows[0];if(!step)deny();
    if(input.operation==='asset.upload.prepare'){
      if(input.target.kind!=='work.model-result'||input.target.id!==step.work_item_id)deny();return;
    }
    if(['asset.upload.claim','asset.upload.write'].includes(input.operation)&&input.target.kind==='asset_upload_intent'){
      const intent=(await q.query(`SELECT 1 FROM asset_upload_intents WHERE intent_id=$1 AND target_kind='work.model-result' AND target_work_id=$2
        AND target_user_id=$3 AND owner_principal_id=$4 AND scope_id=$5`,[input.target.id,step.work_item_id,b.ownerUserId,b.principalId,b.scopeId])).rowCount;
      if(intent!==1)deny();return;
    }
    deny();
  }
  const ports:ModelStepAuthority<MachineModelSubject,MachineModelContext>={
    snapshot,clock:current,communityId:()=>{deny();return '';},
    async read(pool,input,authorize,run){const actor=snapshot(input.actor);let c:MachineModelContext|undefined,q0:PoolClient|undefined;
      try{return await transaction(pool,async q=>{q0=q;c=await scope(q,actor,input.scope);await authorize(q,c);await check(q,c);const value=await run(q,c);await check(q,c);return value;});}
      finally{if(c&&q0)done(q0,c);}},
    async command<T>(pool:Pool,raw:AuthorityCommand<MachineModelSubject>,authorize:(q:PoolClient,c:MachineModelContext)=>Promise<unknown>,run:(q:PoolClient,c:MachineModelContext)=>Promise<T>,revalidate?:(q:PoolClient,c:MachineModelContext)=>Promise<unknown>,assertCurrentTime?:()=>void):Promise<T>{
      const actor=snapshot(raw.actor),{actor:_actor,...fields}=raw,input={...(freezeTree(snapshotInput(fields)) as object),actor} as AuthorityCommand<MachineModelSubject>;
      z.string().regex(/^[A-Za-z0-9_-]{8,128}$(?![\s\S])/).parse(input.key);
      const d=describe(actor);let c!:MachineModelContext,q0:PoolClient|undefined;
      const ns=()=>[c.subject_principal.principal_id,'execution_token',c.scope.scope_id,input.operation,input.key];
      const validate=async(q:PoolClient)=>{await check(q,c);if(revalidate){await revalidate(q,c);await check(q,c);}assertCurrentTime?.();};
      const binding=()=>fact(q0!,c);
      try{return await runCommandCore<T>(pool,{
        async authenticateAndLock(q){q0=q;c=await scope(q,actor,input.scope);await target(q,input);registerScopedCommand(c,q,input.operation);},
        async lockReceipt(q){await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['freedom.machine-model-command/v1',...ns()])]);},
        requestDigest:()=>digest({profile:'freedom.machine-model-command/v1',invocation:d,scope:c.scope,target:input.target,expected:input.expected??null,body:input.body}),
        async readReceipt(q){const prior=(await q.query(`SELECT request_sha256,response FROM scoped_command_receipts WHERE principal_id=$1 AND authn_kind=$2 AND scope_id=$3 AND operation=$4 AND idempotency_key=$5`,ns())).rows[0];
          await validate(q);if(prior&&input.operation==='asset.upload.claim')deny();return prior?{request_sha256:prior.request_sha256,response:metadata(prior.response).value as T}:null;},
        async writeReceipt(q,hash,result){const b=binding();
          // The internal Asset lease remains only on the current server call;
          // a replay cannot mint/recover it from a machine command receipt.
          const safe=input.operation==='asset.upload.claim'?Object.fromEntries(Object.entries(result as object).filter(([key])=>key!=='leaseToken')):result;
          await q.query(`INSERT INTO scoped_command_receipts(principal_id,authn_kind,scope_id,operation,idempotency_key,principal_kind,scope_kind,target_kind,target_id,request_sha256,response,
            execution_authorization_id,execution_attempt_id,execution_grant_id,execution_runtime_device_id,execution_connection_id)
            VALUES($1,$2,$3,$4,$5,'person','personal',$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[...ns(),input.target.kind,input.target.id,hash,metadata(safe).json,
            b.authorizationId,b.attemptId,b.grantId,b.runtimeDeviceId,b.connectionId]);await validate(q);},
      },async q=>{await authorize(q,c);await check(q,c);assertCurrentTime?.();authorizeScopedCommand(c);if(d.kind!=='activate')bindScopedExecutionFact(q,c,binding());},
      async q=>metadata(await run(q,c)).value as T);}finally{if(c&&q0)done(q0,c);}
    },
    async stepCreated(q,actor,c,stepId){await attachModel(q,actor,c,stepId);bindScopedExecutionFact(q,c,fact(q,c));},
    async journal(q,c,input){await check(q,c);await scopedJournal(q,c,input);await check(q,c);},
    async persistencePolicy(q,c){await check(q,c);const value=await readLockedPrivateWorkPersistencePolicy(q,c.subject_principal.principal_id,c.scope.scope_id);await check(q,c);return value;},
    async exportPolicy(q,c,environment,clientId,selection){await check(q,c);const value=await readLockedInferenceExportPolicy(q,c.subject_principal.principal_id,c.scope.scope_id,environment,clientId,selection);await check(q,c);return value;},
  };
  return Object.freeze(ports);
}

declare const sqlSubjectBrand:unique symbol;
export interface SqlMachineSubject {readonly user_id:string;readonly [sqlSubjectBrand]:never}
interface SqlMachineContext extends ScopedFactContext {readonly authn_kind:'execution_token';readonly ownerUserId:string}
/** Broker scope built only from the claimed SQL pins. No transported Actor and
 * no borrowed session. The executor has no UPDATE on the machine authorization,
 * so that row is not locked; the Step row is the fence. Policy FOR SHARE runs
 * only after the work row is locked. */
export function openSqlMachineModel(options:{environment:RuntimeEnvironment;clientId:string;binding:MachineBrokerBinding;assertCurrent:(q:PoolClient)=>Promise<void>}):{subject:SqlMachineSubject;ports:ModelStepAuthority<SqlMachineSubject,SqlMachineContext>}{
  const {environment,clientId,binding,assertCurrent}=options;
  requireCondition(binding.environment===environment&&binding.clientId===clientId&&typeof assertCurrent==='function',403,'machine_broker_authorization_invalid','機器模型授權無效。');
  const subjects=new WeakSet<SqlMachineSubject>();
  const subject=Object.freeze({user_id:binding.ownerUserId}) as SqlMachineSubject;subjects.add(subject);
  const active=new WeakMap<SqlMachineContext,{q:PoolClient}>();
  const deny=()=>requireCondition(false,403,'machine_broker_authorization_invalid','機器模型授權無效。');
  const snapshot=(actor:SqlMachineSubject)=>{if(!subjects.has(actor))deny();return actor;};
  async function scope(q:PoolClient,actor:SqlMachineSubject,selected:unknown){
    if(selected!=='personal'||!subjects.has(actor))deny();
    const first=(await q.query(`SELECT c.owner_user_id,c.owner_principal_id,c.scope_id,r.challenge_id,r.key_thumbprint,r.environment,g.work_item_id,g.model_connection_id
      FROM agent_connections c JOIN runtime_registrations r USING(runtime_device_id) JOIN execution_grants g ON g.grant_id=$2
      WHERE c.connection_id=$1`,[binding.connectionId,binding.grantId])).rows[0];
    if(!first||first.owner_user_id!==binding.ownerUserId||first.environment!==environment)deny();
    await q.query('SELECT user_id FROM users WHERE user_id=$1 FOR SHARE',[binding.ownerUserId]);
    await q.query('SELECT principal_id FROM principals WHERE principal_id=$1 FOR SHARE',[binding.principalId]);
    await q.query('SELECT scope_id FROM resource_scopes WHERE scope_id=$1 FOR SHARE',[binding.scopeId]);
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`freedom.execution-prerequisites.owner/v1:${binding.principalId}`]);
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['freedom.runtime-enrollment.owner/v1',environment,binding.principalId])]);
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['freedom.runtime-enrollment.key/v1',environment,first.key_thumbprint])]);
    await q.query('SELECT challenge_id FROM runtime_registration_challenges WHERE challenge_id=$1 FOR UPDATE',[first.challenge_id]);
    await q.query('SELECT runtime_device_id FROM runtime_registrations WHERE runtime_device_id=$1 FOR UPDATE',[binding.runtimeDeviceId]);
    await q.query('SELECT connection_id FROM agent_connections WHERE connection_id=$1 FOR UPDATE',[binding.connectionId]);
    await q.query('SELECT family_id FROM bootstrap_refresh_families WHERE family_id=$1 FOR UPDATE',[binding.familyId]);
    await q.query('SELECT work_item_id FROM work_items WHERE work_item_id=$1 FOR UPDATE',[first.work_item_id]);
    await q.query('SELECT run_id FROM execution_runs WHERE run_id=$1 FOR UPDATE',[binding.runId]);
    await q.query('SELECT model_connection_id FROM model_connections WHERE model_connection_id=$1 FOR UPDATE',[binding.modelConnectionId]);
    await q.query('SELECT grant_id FROM execution_grants WHERE grant_id=$1 FOR UPDATE',[binding.grantId]);
    await q.query('SELECT approval_id FROM model_export_approvals WHERE approval_id=$1 FOR UPDATE',[binding.approvalId]);
    await q.query('SELECT attempt_id FROM execution_attempts WHERE attempt_id=$1 FOR UPDATE',[binding.attemptId]);
    await q.query('SELECT step_id FROM model_text_steps WHERE step_id=$1 FOR UPDATE',[binding.stepId]);
    await assertCurrent(q);
    const c=freezeTree({authn_kind:'execution_token' as const,ownerUserId:binding.ownerUserId,
      subject_principal:{principal_id:binding.principalId,kind:'person' as const},scope:{scope_id:binding.scopeId,kind:'personal' as const}});
    active.set(c,{q});return c;
  }
  async function check(q:PoolClient,c:SqlMachineContext){const a=active.get(c);if(!a||a.q!==q)deny();await assertCurrent(q);}
  function done(q:PoolClient,c:SqlMachineContext){if(active.get(c)?.q!==q)deny();active.delete(c);forgetScopedCommand(c);}
  const fact=()=>({authorizationId:binding.authorizationId,attemptId:binding.attemptId,grantId:binding.grantId,runtimeDeviceId:binding.runtimeDeviceId,connectionId:binding.connectionId});
  async function target(q:PoolClient,input:AuthorityCommand<SqlMachineSubject>){
    if(['execution.model-step.begin','execution.model-step.record','execution.model.result.finalize'].includes(input.operation)){
      if(input.target.kind!=='model_text_step'||input.target.id!==binding.stepId)deny();return;}
    const step=(await q.query('SELECT work_item_id FROM model_text_steps WHERE step_id=$1',[binding.stepId])).rows[0];if(!step)deny();
    if(input.operation==='asset.upload.prepare'){if(input.target.kind!=='work.model-result'||input.target.id!==step.work_item_id)deny();return;}
    if(['asset.upload.claim','asset.upload.write'].includes(input.operation)&&input.target.kind==='asset_upload_intent'){
      const intent=(await q.query(`SELECT 1 FROM asset_upload_intents WHERE intent_id=$1 AND target_kind='work.model-result' AND target_work_id=$2
        AND target_user_id=$3 AND owner_principal_id=$4 AND scope_id=$5`,[input.target.id,step.work_item_id,binding.ownerUserId,binding.principalId,binding.scopeId])).rowCount;
      if(intent!==1)deny();return;}
    deny();
  }
  const ports:ModelStepAuthority<SqlMachineSubject,SqlMachineContext>={
    snapshot,clock:async q=>assertCurrent(q),communityId:()=>{deny();return '';},
    async read(pool,input,authorize,run){const actor=snapshot(input.actor);let c:SqlMachineContext|undefined,q0:PoolClient|undefined;
      try{return await transaction(pool,async q=>{q0=q;c=await scope(q,actor,input.scope);await authorize(q,c);await check(q,c);const value=await run(q,c);await check(q,c);return value;});}
      finally{if(c&&q0)done(q0,c);}},
    async command<T>(pool:Pool,raw:AuthorityCommand<SqlMachineSubject>,authorize:(q:PoolClient,c:SqlMachineContext)=>Promise<unknown>,run:(q:PoolClient,c:SqlMachineContext)=>Promise<T>,revalidate?:(q:PoolClient,c:SqlMachineContext)=>Promise<unknown>,assertCurrentTime?:()=>void):Promise<T>{
      const actor=snapshot(raw.actor),{actor:_actor,...fields}=raw,input={...(freezeTree(snapshotInput(fields)) as object),actor} as AuthorityCommand<SqlMachineSubject>;
      z.string().regex(/^[A-Za-z0-9_-]{8,128}$(?![\s\S])/).parse(input.key);let c!:SqlMachineContext,q0:PoolClient|undefined;
      const ns=()=>[c.subject_principal.principal_id,'execution_token',c.scope.scope_id,input.operation,input.key];
      const validate=async(q:PoolClient)=>{await check(q,c);if(revalidate){await revalidate(q,c);await check(q,c);}assertCurrentTime?.();};
      try{return await runCommandCore<T>(pool,{
        async authenticateAndLock(q){q0=q;c=await scope(q,actor,input.scope);await target(q,input);registerScopedCommand(c,q,input.operation);},
        async lockReceipt(q){await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['freedom.machine-model-command/v1',...ns()])]);},
        requestDigest:()=>digest({profile:'freedom.machine-model-command/v1',binding,scope:c.scope,target:input.target,expected:input.expected??null,body:input.body}),
        async readReceipt(q){const prior=(await q.query(`SELECT request_sha256,response FROM scoped_command_receipts WHERE principal_id=$1 AND authn_kind=$2 AND scope_id=$3 AND operation=$4 AND idempotency_key=$5`,ns())).rows[0];
          await validate(q);if(prior&&input.operation==='asset.upload.claim')deny();return prior?{request_sha256:prior.request_sha256,response:metadata(prior.response).value as T}:null;},
        async writeReceipt(q,hash,result){const b=fact();
          const safe=input.operation==='asset.upload.claim'?Object.fromEntries(Object.entries(result as object).filter(([key])=>key!=='leaseToken')):result;
          await q.query(`INSERT INTO scoped_command_receipts(principal_id,authn_kind,scope_id,operation,idempotency_key,principal_kind,scope_kind,target_kind,target_id,request_sha256,response,
            execution_authorization_id,execution_attempt_id,execution_grant_id,execution_runtime_device_id,execution_connection_id)
            VALUES($1,$2,$3,$4,$5,'person','personal',$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[...ns(),input.target.kind,input.target.id,hash,metadata(safe).json,
            b.authorizationId,b.attemptId,b.grantId,b.runtimeDeviceId,b.connectionId]);await validate(q);},
      },async q=>{await authorize(q,c);await check(q,c);assertCurrentTime?.();authorizeScopedCommand(c);bindScopedExecutionFact(q,c,fact());},
      async q=>metadata(await run(q,c)).value as T);}finally{if(c&&q0)done(q0,c);}
    },
    async journal(q,c,input){await check(q,c);await scopedJournal(q,c,input);await check(q,c);},
    async persistencePolicy(q,c){await check(q,c);const value=await readLockedPrivateWorkPersistencePolicy(q,c.subject_principal.principal_id,c.scope.scope_id);await check(q,c);return value;},
    async exportPolicy(q,c,env,id,selection){await check(q,c);const value=await readLockedInferenceExportPolicy(q,c.subject_principal.principal_id,c.scope.scope_id,env,id,selection);await check(q,c);return value;},
  };
  return {subject,ports:Object.freeze(ports)};
}

/** Complete server-side text composition; real broker HTTP installation is a
 * separate caller. There is no member Actor/cookie or native CLI fallback. */
export function createMachineModelStepService(pool:Pool,options:{environment:RuntimeEnvironment;clientId:string;authority:MachineTextAuthority;host:ModelStepHost;store:ObjectStore}){
  const {environment,clientId,authority,host,store}=options,ports=createMachineModelPorts(authority);
  const steps=createModelStepServiceWithAuthority(pool,{environment,clientId,host},ports);
  const results=createPrivateModelResultServiceWithAuthority(pool,{steps,host,store,resolvePolicy:ports.persistencePolicy},ports);
  const runner=createModelStepRunner({service:steps,host,resultFinalizer:results});
  return Object.freeze({
    async activate(proof:Parameters<MachineTextAuthority['activation']>[0],raw:z.infer<typeof ActivateSchema>,signal?:AbortSignal){
      const input=freezeTree(ActivateSchema.parse(snapshotInput(raw))),actor=await authority.activation(proof,input.approvalId);
      try{const metadata=await steps.activate(actor,input,async q=>{requireCondition(!signal?.aborted,400,'request_aborted','Request aborted.');await authority.current(q,actor);requireCondition(!signal?.aborted,400,'request_aborted','Request aborted.');});const credentials=authority.takeIssued(actor);
        requireCondition(credentials,409,'machine_activation_consumed','機器啟用已消耗。');return Object.freeze({metadata,credentials});}finally{authority.forget(actor);}
    },
    async execute(proof:Parameters<MachineTextAuthority['execution']>[0],raw:z.infer<typeof BeginSchema>,signal?:AbortSignal){
      if(proof.operation!=='execute')deny();const input=freezeTree(BeginSchema.parse(snapshotInput(raw))),actor=await authority.execution(proof);
      try{const d=authority.describe(actor);if(d.kind!=='execute'||d.binding!.stepId!==input.stepId)deny();
        const metadata=await steps.read(actor,{stepId:input.stepId});
        if(metadata.state!=='reserved')return Object.freeze({metadata,result:null});
        return await runner.execute(actor,input,async q=>{requireCondition(!signal?.aborted,400,'request_aborted','Request aborted.');await authority.current(q,actor);requireCondition(!signal?.aborted,400,'request_aborted','Request aborted.');});}finally{authority.forget(actor);}
    },
    async evidence(proof:Parameters<MachineTextAuthority['execution']>[0],stepId:string,key:string,raw:z.infer<typeof MachineDispatchEvidenceSchema>){
      if(proof.operation!=='evidence')deny();const input=freezeTree(MachineDispatchEvidenceSchema.parse(snapshotInput(raw)));
      return executionTextCommand(pool,authority,{...proof,operation:'evidence',key,expected:'1'},async(q,c)=>{
        if(c.binding.stepId!==stepId)deny();const row=(await q.query('SELECT dispatched_at FROM model_text_steps WHERE step_id=$1',[stepId])).rows[0];if(!row?.dispatched_at)deny();
      },async(q,c)=>{const prior=(await q.query('SELECT * FROM execution_machine_dispatch_evidence WHERE authorization_id=$1',[c.binding.authorizationId])).rows[0];
        if(prior)requireCondition(prior.outcome===input.outcome&&prior.reason===input.reason&&prior.evidence_sha256===input.evidenceSha256,409,'idempotency_conflict','同一證據不可變更。');
        else await q.query(`INSERT INTO execution_machine_dispatch_evidence(authorization_id,profile,outcome,reason,evidence_sha256,received_at)
          VALUES($1,$2,$3,$4,$5,date_trunc('milliseconds',clock_timestamp()))`,[c.binding.authorizationId,input.profile,input.outcome,input.reason,input.evidenceSha256]);
        return {stepId,evidenceAccepted:true,operational_authority:false};});
    },
    async read(proof:Parameters<MachineTextAuthority['execution']>[0],raw:z.infer<typeof ReadSchema>){
      if(proof.operation!=='status')deny();const input=freezeTree(ReadSchema.parse(snapshotInput(raw))),actor=await authority.execution(proof);
      try{const d=authority.describe(actor);if(d.kind!=='status'||d.binding!.stepId!==input.stepId)deny();return await steps.read(actor,input);}finally{authority.forget(actor);}
    },
    async readSubject(actor:MachineModelSubject,stepId:string){
      const d=authority.describe(actor);if((d.kind!=='execute'&&d.kind!=='status')||d.binding!.stepId!==stepId)deny();return steps.read(actor,{stepId});
    },
    /** Same-request lost reply only. Dispatched stays reserved in its budget and
     * becomes unknown without moving control_epoch, so a later read can still
     * pass admission. Succeeded and reserved rows are left unchanged. No retry. */
    async reconcileLost(actor:MachineModelSubject,stepId:string){
      const d=authority.describe(actor);if(d.kind!=='execute'||d.binding!.stepId!==stepId)deny();
      let c:MachineModelContext|undefined,q0:PoolClient|undefined;
      try{await transaction(pool,async q=>{q0=q;c=await authority.resume(q,actor);
        const row=(await q.query<{state:string;run_state:string;run_id:string}>(`SELECT s.state,r.state run_state,s.run_id FROM model_text_steps s
          JOIN execution_runs r ON r.run_id=s.run_id WHERE s.step_id=$1`,[stepId])).rows[0];
        if(row?.state==='dispatched'&&row.run_state==='running'){
          await q.query(`UPDATE model_text_steps SET state='outcome_unknown',aggregate_version=aggregate_version+1 WHERE step_id=$1 AND state='dispatched'`,[stepId]);
          await q.query(`UPDATE execution_runs SET state='reconciling',aggregate_version=aggregate_version+1,task_lease_epoch=task_lease_epoch+1 WHERE run_id=$1 AND state='running'`,[row.run_id]);
        }
        await authority.current(q,actor);});}
      finally{if(c&&q0)authority.finish(q0,c);}
    },
  });
}
