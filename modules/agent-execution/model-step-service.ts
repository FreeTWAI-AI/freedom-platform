import { randomUUID, createHash } from 'node:crypto';
import { captureModelStepInvocation, assertModelStepInvocationTime, modelStepInvocationExpiry, type ModelStepInvocationGuard } from './model-step-invocation.js';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import type { Actor } from '../identity-membership/service.js';
import { withMemberScope, type MemberScopeContext } from '../../packages/resource-scopes/index.js';
import { scopedMemberCommand, scopedJournal } from '../../packages/scoped-commands/index.js';
import { assertCurrentSessionClock } from '../../packages/db/member-session.js';
import { checkVersion } from '../../packages/db/index.js';
import { requireCondition } from '../../packages/shared/problem.js';
import { snapshotInput, freezeTree } from '../../packages/execution-state/decode.js';
import { RuntimeEnvironmentSchema } from '../../contracts/execution/v1/runtime-registration.js';
import { BootstrapClientIdSchema } from '../../contracts/execution/v1/bootstrap.js';
import * as c from '../../contracts/execution/v2/model-step.js';
import { resolvePrivateWorkPersistencePolicy } from '../autopilot-work/policy.js';
import { resolveInferenceExportPolicy, type InferenceExportPolicy } from './export-policy.js';
import { encodeModelStepContext, readVerifiedModelBinding, createModelStepCapability, readModelStepCapability, assertModelObservationCurrent,
  readModelObservation, type ModelStepHost, type OpaqueVerifiedModelBinding, type OpaqueModelStepCapability,
  type OpaqueModelObservation } from './model-step-host.js';

interface Owned { owner_user_id:string;owner_principal_id:string;scope_id:string }
interface Backing extends Owned { runtime_device_id:string;connection_id:string;family_id:string;environment:string;client_id:string;
  runtime_version:string;connection_version:string;model_connection_id:string;model_version:string;selection:c.ModelStepBinding['selection'] }
interface Grant extends Backing { grant_id:string;run_id:string;work_item_id:string;input_work_version:string;run_version:string;
  task_lease_epoch:string;control_epoch:string;persistence_policy_revision:string;aggregate_version:string;state:string;created_at:Date;expires_at:Date }
interface Approval extends Owned { approval_id:string;grant_id:string;run_id:string;work_item_id:string;environment:string;client_id:string;
  selection:c.ModelStepBinding['selection'];input_work_version:string;grant_version:string;base_run_version:string;policy_id:string;
  export_policy_revision:string;persistence_policy_revision:string;context_sha256:string;input_byte_size:number;max_output_tokens:number;
  state:'active'|'revoked';aggregate_version:string;issued_at:Date;expires_at:Date }
interface Step extends Owned { step_id:string;attempt_id:string;intent_id:string;approval_id:string;run_id:string;work_item_id:string;
  environment:string;client_id:string;binding:c.ModelStepBinding;verified_binding:ReturnType<typeof readVerifiedModelBinding>;
  evidence_origin:c.ModelStepEvidenceOrigin;activated_run_version:string;task_lease_epoch:string;control_epoch:string;context_sha256:string;
  input_byte_size:number;max_output_tokens:number;state:c.ModelStepMetadata['state'];aggregate_version:string;usage_status:c.ModelStepMetadata['usageStatus'];
  created_at:Date;lease_expires_at:Date;permit_expires_at:Date|null;dispatched_at:Date|null;observation:Record<string,unknown>|null;attempt_number:number }
interface BindingRows {grant:Grant;runtime:{state:string;aggregate_version:string;expires_at?:Date};connection:{state:string;aggregate_version:string;issued_at:Date;expires_at:Date};
  family:{state:string;issued_at:Date;expires_at:Date};work:{work_item_id:string;state:string;aggregate_version:string;title:string;objective:string};
  run:{state:string;aggregate_version:string;input_work_version:string;task_lease_epoch:string;control_epoch:string;current_attempt_id:string|null};
  model:{state:string;aggregate_version:string;selection:c.ModelStepBinding['selection']};approval?:Approval;step?:Step;policy?:InferenceExportPolicy;persistence?:string;bytes?:Uint8Array}
const max=9223372036854775807n;
const approvalColumns='aggregate_version::text,input_work_version::text,grant_version::text,base_run_version::text,export_policy_revision::text';
const stepColumns='s.aggregate_version::text,s.activated_run_version::text,s.task_lease_epoch::text,s.control_epoch::text,a.attempt_number';
const grantColumns='aggregate_version::text,input_work_version::text,run_version::text,task_lease_epoch::text,control_epoch::text,runtime_version::text,connection_version::text,model_version::text';
const found=<T>(row:T|undefined):T=>{requireCondition(row,404,'not_found','找不到這項模型步驟。');return row;};
const stale=()=>requireCondition(false,409,'model_step_binding_stale','模型步驟授權已變更。');
const sameSelection=(a:c.ModelStepBinding['selection'],b:c.ModelStepBinding['selection'])=>Object.keys(a).every(k=>a[k as keyof typeof a]===b[k as keyof typeof b]);
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const approvalMetadata=(a:Approval):c.ModelStepApprovalMetadata=>freezeTree(c.ModelStepApprovalMetadataSchema.parse({approvalId:a.approval_id,runId:a.run_id,workId:a.work_item_id,
  grantId:a.grant_id,inputWorkVersion:a.input_work_version,selection:a.selection,exportPolicyRevision:a.export_policy_revision,maxOutputTokens:a.max_output_tokens,
  contextSha256:a.context_sha256,inputByteSize:a.input_byte_size,aggregateVersion:a.aggregate_version,state:a.state,issuedAt:a.issued_at.toISOString(),expiresAt:a.expires_at.toISOString(),operational_authority:false}));
const metadata=(s:Step):c.ModelStepMetadata=>freezeTree(c.ModelStepMetadataSchema.parse({stepId:s.step_id,attemptId:s.attempt_id,attemptNumber:s.attempt_number,runId:s.run_id,
  workId:s.work_item_id,inputWorkVersion:s.binding.inputWorkVersion,approvalId:s.approval_id,state:s.state,aggregateVersion:s.aggregate_version,activatedRunVersion:s.activated_run_version,
  taskLeaseEpoch:s.task_lease_epoch,controlEpoch:s.control_epoch,selection:s.binding.selection,evidenceOrigin:s.evidence_origin,expiresAt:s.lease_expires_at.toISOString(),usageStatus:s.usage_status,costStatus:'unknown',operational_authority:false}));

/** Closed member/host service. Production host verification defaults to deny.
 * Receipts contain only metadata, never context, capabilities or observation text. */
export function createModelStepService(pool:Pool, rawOptions:{environment:c.ModelStepBinding['environment'];clientId:string;host:ModelStepHost}) {
  const descriptors=Object.getOwnPropertyDescriptors(rawOptions);
  requireCondition(Object.getPrototypeOf(rawOptions)===Object.prototype && Reflect.ownKeys(rawOptions).length===3
    && ['environment','clientId','host'].every(k=>descriptors[k]?.enumerable && 'value' in descriptors[k]),400,'invalid_model_step_configuration','模型步驟設定無效。');
  const {environment,clientId}=z.object({environment:RuntimeEnvironmentSchema,clientId:BootstrapClientIdSchema}).strict()
    .parse(snapshotInput({environment:descriptors.environment.value,clientId:descriptors.clientId.value}));
  const rawHost=descriptors.host.value as ModelStepHost,hostDescriptors=Object.getOwnPropertyDescriptors(rawHost);
  requireCondition(rawHost && ['verify','dispatch'].every(k=>hostDescriptors[k]?.enumerable && 'value' in hostDescriptors[k] && typeof hostDescriptors[k].value==='function'),
    503,'model_authentication_unavailable','模型認證尚未提供。');
  const verifyHost=hostDescriptors.verify.value as ModelStepHost['verify'],dispatchHost=hostDescriptors.dispatch.value as ModelStepHost['dispatch'];
  const host=Object.freeze({verify:verifyHost.bind(rawHost),dispatch:dispatchHost.bind(rawHost)});
  const capabilities=new WeakMap<object,string>();
  const parse=<T>(schema:z.ZodType<T>,raw:unknown):T=>freezeTree(schema.parse(snapshotInput(raw)));
  const owners=(actor:Actor,context:MemberScopeContext)=>[actor.user_id,context.subject_principal.principal_id,context.scope.scope_id];
  async function now(q:PoolClient,actor:Actor) {await assertCurrentSessionClock(q,actor);return (await q.query<{now:Date}>("SELECT date_trunc('milliseconds',clock_timestamp()) now")).rows[0].now;}
  async function eligible(q:PoolClient,actor:Actor) {requireCondition((await q.query('SELECT user_id FROM users WHERE user_id=$1 AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL)',[actor.user_id])).rowCount===1,403,'onboarding_required','請先完成加入。');}
  async function ownerLock(q:PoolClient,context:MemberScopeContext) {
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`freedom.execution-prerequisites.owner/v1:${context.subject_principal.principal_id}`]);
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['freedom.runtime-enrollment.owner/v1',environment,context.subject_principal.principal_id])]);
  }
  async function approval(q:PoolClient,actor:Actor,context:MemberScopeContext,id:string,lock=false):Promise<Approval> {
    return found((await q.query<Approval>(`SELECT *,${approvalColumns} FROM model_export_approvals WHERE approval_id=$1 AND owner_user_id=$2
      AND owner_principal_id=$3 AND scope_id=$4 AND environment=$5 AND client_id=$6 ${lock?'FOR UPDATE':''}`,[id,...owners(actor,context),environment,clientId])).rows[0]);
  }
  async function step(q:PoolClient,actor:Actor,context:MemberScopeContext,id:string,lock=false):Promise<Step> {
    return found((await q.query<Step>(`SELECT s.*,${stepColumns} FROM model_text_steps s JOIN execution_attempts a ON a.attempt_id=s.attempt_id
      WHERE s.step_id=$1 AND s.owner_user_id=$2 AND s.owner_principal_id=$3 AND s.scope_id=$4 AND s.environment=$5 AND s.client_id=$6 ${lock?'FOR UPDATE OF s':''}`,
    [id,...owners(actor,context),environment,clientId])).rows[0]);
  }
  async function lock(q:PoolClient,actor:Actor,context:MemberScopeContext,grantId:string,approvalId?:string,stepId?:string):Promise<BindingRows> {
    await eligible(q,actor);await ownerLock(q,context);
    const g=found((await q.query<Grant>(`SELECT *,${grantColumns} FROM execution_grants WHERE grant_id=$1 AND owner_user_id=$2 AND owner_principal_id=$3
      AND scope_id=$4 AND environment=$5 AND client_id=$6`,[grantId,...owners(actor,context),environment,clientId])).rows[0]);
    const first=found((await q.query<{challenge_id:string;key_thumbprint:string}>('SELECT challenge_id,key_thumbprint FROM runtime_registrations WHERE runtime_device_id=$1',[g.runtime_device_id])).rows[0]);
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['freedom.runtime-enrollment.key/v1',environment,first.key_thumbprint])]);
    await q.query('SELECT challenge_id FROM runtime_registration_challenges WHERE challenge_id=$1 FOR UPDATE',[first.challenge_id]);
    const runtime=found((await q.query<BindingRows['runtime']>('SELECT state,aggregate_version::text FROM runtime_registrations WHERE runtime_device_id=$1 FOR UPDATE',[g.runtime_device_id])).rows[0]);
    const connection=found((await q.query<BindingRows['connection']>('SELECT state,aggregate_version::text,issued_at,expires_at FROM agent_connections WHERE connection_id=$1 FOR UPDATE',[g.connection_id])).rows[0]);
    const family=found((await q.query<BindingRows['family']>('SELECT state,issued_at,expires_at FROM bootstrap_refresh_families WHERE family_id=$1 FOR UPDATE',[g.family_id])).rows[0]);
    const work=found((await q.query<BindingRows['work']>(`SELECT work_item_id,state,aggregate_version::text,title,objective FROM work_items WHERE work_item_id=$1 AND work_mode='personal_execution'
      AND owner_ref=$2 AND owner_principal_id=$3 AND scope_id=$4 FOR UPDATE`,[g.work_item_id,...owners(actor,context)])).rows[0]);
    const run=found((await q.query<BindingRows['run']>('SELECT state,aggregate_version::text,input_work_version::text,task_lease_epoch::text,control_epoch::text,current_attempt_id FROM execution_runs WHERE run_id=$1 FOR UPDATE',[g.run_id])).rows[0]);
    const model=found((await q.query<BindingRows['model']>('SELECT state,aggregate_version::text,selection FROM model_connections WHERE model_connection_id=$1 FOR UPDATE',[g.model_connection_id])).rows[0]);
    const grant=found((await q.query<Grant>(`SELECT *,${grantColumns} FROM execution_grants WHERE grant_id=$1 FOR UPDATE`,[grantId])).rows[0]);
    const a=approvalId?await approval(q,actor,context,approvalId,true):undefined;
    if(stepId) await q.query('SELECT attempt_id FROM execution_attempts WHERE attempt_id=(SELECT attempt_id FROM model_text_steps WHERE step_id=$1) FOR UPDATE',[stepId]);
    const s=stepId?await step(q,actor,context,stepId,true):undefined;
    return {grant,runtime,connection,family,work,run,model,approval:a,step:s};
  }
  async function policy(q:PoolClient,context:MemberScopeContext,b:BindingRows) {
    b.persistence=(await resolvePrivateWorkPersistencePolicy(q,context)).revision;
    b.policy=await resolveInferenceExportPolicy(q,context,environment,clientId,b.model.selection);
    b.bytes=encodeModelStepContext({schema:'model-step.context/v1',title:b.work.title,objective:b.work.objective});
  }
  async function current(q:PoolClient,actor:Actor,b:BindingRows,operational=false) {
    const t=await now(q,actor),g=b.grant,a=b.approval,s=b.step;
    if(b.runtime.state!=='enrolled'||b.runtime.aggregate_version!==g.runtime_version||b.connection.state!=='active'||b.connection.aggregate_version!==g.connection_version
      ||b.family.state!=='active'||t<b.connection.issued_at||t>=b.connection.expires_at||t<b.family.issued_at||t>=b.family.expires_at
      ||b.work.state!=='draft'||b.work.aggregate_version!==g.input_work_version||b.run.input_work_version!==g.input_work_version
      ||b.model.state!=='unverified'||b.model.aggregate_version!==g.model_version||!sameSelection(b.model.selection,g.selection)
      ||g.state!=='active'||g.aggregate_version!=='1'||t<g.created_at||t>=g.expires_at||g.persistence_policy_revision!==b.persistence) stale();
    if(!operational && (b.run.state!=='created'||b.run.aggregate_version!==g.run_version||b.run.task_lease_epoch!==g.task_lease_epoch||b.run.control_epoch!==g.control_epoch))stale();
    if(a && (a.state!=='active'||t<a.issued_at||t>=a.expires_at||a.grant_id!==g.grant_id||a.grant_version!==g.aggregate_version
      ||a.export_policy_revision!==b.policy?.revision||a.policy_id!==b.policy?.policyId||a.persistence_policy_revision!==b.persistence
      ||a.input_work_version!==b.work.aggregate_version||a.context_sha256!==hash(b.bytes!)||a.input_byte_size!==b.bytes!.byteLength
      ||a.max_output_tokens>b.policy!.maxOutputTokens||a.input_byte_size>b.policy!.maxPromptBytes||!sameSelection(a.selection,b.model.selection)))stale();
    if(operational && (!s||b.run.state!=='running'||b.run.current_attempt_id!==s.attempt_id||b.run.aggregate_version!==s.activated_run_version
      ||b.run.task_lease_epoch!==s.task_lease_epoch||b.run.control_epoch!==s.control_epoch||t>=s.lease_expires_at||t< s.created_at
      ||new Date(s.verified_binding.expiresAt)<=t))stale();
    if(operational && b.model.selection.artifactCustody!=='platform_asset')stale();
    return t;
  }
  async function journal(q:PoolClient,context:MemberScopeContext,operation:string,type:string,id:string,version:string,state:string) {
    await scopedJournal(q,context,{aggregate_type:type,id,version,operation,data:{state,operational_authority:false},eventType:'freedom.execution.model-step.recorded.v1'});
  }
  async function createApproval(actor:Actor,raw:c.ModelStepApprovalCreateInput) {
    actor=Object.freeze({...actor});const input=parse(c.ApprovalCreateSchema,raw),operation='execution.export-approval.create';let b!:BindingRows;
    const validate=async(q:PoolClient)=>{await current(q,actor,b);checkVersion(b.run.aggregate_version,input.expectedRunVersion);
      checkVersion(b.grant.aggregate_version,input.expectedGrantVersion);checkVersion(b.work.aggregate_version,input.expectedWorkVersion);};
    return scopedMemberCommand(pool,{actor,scope:'personal',operation,key:input.key,target:{kind:'execution_run',id:input.runId},expected:input.expectedRunVersion,
      body:{environment,clientId,grantId:input.grantId,expectedGrantVersion:input.expectedGrantVersion,expectedWorkVersion:input.expectedWorkVersion,consent:true,maxOutputTokens:input.maxOutputTokens}},
    async(q,context)=>{await eligible(q,actor);await ownerLock(q,context);const prior=(await q.query<{approval_id:string}>(`SELECT approval_id FROM model_export_approvals WHERE owner_principal_id=$1 AND scope_id=$2 AND environment=$3 AND client_id=$4 AND creation_key=$5`,
      [context.subject_principal.principal_id,context.scope.scope_id,environment,clientId,input.key])).rows[0];b=await lock(q,actor,context,input.grantId,prior?.approval_id);requireCondition(b.grant.run_id===input.runId,409,'model_step_binding_mismatch','模型步驟綁定不符。');
      await policy(q,context,b);await validate(q);requireCondition(b.bytes!.byteLength<=b.policy!.maxPromptBytes && input.maxOutputTokens<=b.policy!.maxOutputTokens,403,'model_export_policy_denied','模型輸入超出政策範圍。');},
    async(q,context)=>{const t=await current(q,actor,b),expires=new Date(Math.min(t.getTime()+3600000,b.grant.expires_at.getTime()));
      const row=found((await q.query<Approval>(`INSERT INTO model_export_approvals(approval_id,grant_id,run_id,work_item_id,owner_user_id,owner_principal_id,scope_id,
        environment,client_id,selection,input_work_version,grant_version,base_run_version,policy_id,export_policy_revision,persistence_policy_revision,
        context_sha256,input_byte_size,max_output_tokens,consent,creation_key,issued_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,true,$20,$21,$22) RETURNING *,${approvalColumns}`,
      [randomUUID(),input.grantId,input.runId,b.grant.work_item_id,...owners(actor,context),environment,clientId,JSON.stringify(b.model.selection),b.work.aggregate_version,
        b.grant.aggregate_version,b.run.aggregate_version,b.policy!.policyId,b.policy!.revision,b.persistence,hash(b.bytes!),b.bytes!.byteLength,input.maxOutputTokens,input.key,t,expires])).rows[0]);
      b.approval=row;await journal(q,context,operation,'model_export_approval',row.approval_id,row.aggregate_version,row.state);return approvalMetadata(row);},async q=>validate(q));
  }
  async function readApproval(actor:Actor,raw:c.ModelStepApprovalReadInput) {actor=Object.freeze({...actor});const input=parse(c.ApprovalReadSchema,raw);
    return withMemberScope(pool,{actor,scope:'personal'},async q=>eligible(q,actor),async(q,context)=>{const a=await approval(q,actor,context,input.approvalId),b=await lock(q,actor,context,a.grant_id,a.approval_id);
      await now(q,actor);return approvalMetadata(b.approval!);});}
  async function revokeApproval(actor:Actor,raw:c.ModelStepApprovalRevokeInput) {actor=Object.freeze({...actor});const input=parse(c.ApprovalRevokeSchema,raw),operation='execution.export-approval.revoke';let b!:BindingRows;
    return scopedMemberCommand(pool,{actor,scope:'personal',operation,key:input.key,target:{kind:'model_export_approval',id:input.approvalId},expected:input.expectedVersion,body:{environment,clientId}},
    async(q,context)=>{const a=await approval(q,actor,context,input.approvalId);b=await lock(q,actor,context,a.grant_id,a.approval_id);},async(q,context)=>{
      checkVersion(b.approval!.aggregate_version,input.expectedVersion);requireCondition(b.approval!.state==='active',409,'model_export_approval_revoked','出口同意已撤銷。');
      const t=await now(q,actor);const row=found((await q.query<Approval>(`UPDATE model_export_approvals SET state='revoked',aggregate_version=aggregate_version+1,revoked_at=$3
        WHERE approval_id=$1 AND aggregate_version=$2 RETURNING *,${approvalColumns}`,[input.approvalId,input.expectedVersion,t])).rows[0]);
      await journal(q,context,operation,'model_export_approval',row.approval_id,row.aggregate_version,row.state);return approvalMetadata(row);},async q=>{await now(q,actor);});}
  async function locateStep(q:PoolClient,actor:Actor,context:MemberScopeContext,id:string,check=true) {
    const first=await step(q,actor,context,id),a=await approval(q,actor,context,first.approval_id);const b=await lock(q,actor,context,a.grant_id,a.approval_id,id);
    if(check){await policy(q,context,b);await current(q,actor,b,true);}else await now(q,actor);return b;
  }
  async function activate(actor:Actor,raw:c.ModelStepActivateInput, invocation?:ModelStepInvocationGuard) {
    const guard=captureModelStepInvocation(invocation);
    actor=Object.freeze({...actor});const input=parse(c.ActivateSchema,raw),operation='execution.model-step.activate';
    const derive=async(q:PoolClient,context:MemberScopeContext)=>{await guard(q);await eligible(q,actor);await ownerLock(q,context);const a=await approval(q,actor,context,input.approvalId);
      const prior=(await q.query<{step_id:string}>('SELECT step_id FROM model_text_steps WHERE owner_principal_id=$1 AND scope_id=$2 AND environment=$3 AND client_id=$4 AND creation_key=$5',
      [context.subject_principal.principal_id,context.scope.scope_id,environment,clientId,input.key])).rows[0];
      const b=await lock(q,actor,context,a.grant_id,a.approval_id,prior?.step_id);await policy(q,context,b);await current(q,actor,b,!!b.step);
      requireCondition(b.model.selection.artifactCustody==='platform_asset',403,'model_step_custody_unavailable','目前模型成果需要明選平台保管。');
      checkVersion(b.approval!.aggregate_version,input.expectedApprovalVersion);checkVersion(b.step?.binding.baseRunVersion??b.run.aggregate_version,input.expectedRunVersion);
      if(b.step){requireCondition(b.step.approval_id===input.approvalId,409,'idempotency_conflict','同一操作不可改綁。');return b;}
      requireCondition(BigInt(b.run.aggregate_version)<max && BigInt(b.run.task_lease_epoch)<max,409,'execution_version_exhausted','模型步驟版本已達上限。');return b;};
    const initial=await withMemberScope(pool,{actor,scope:'personal'},async()=>{},derive);
    const g=initial.grant,a=initial.approval!;
    const binding=initial.step?.binding??freezeTree(c.ModelStepBindingSchema.parse({profile:'model-step.binding/v1',stepId:randomUUID(),attemptId:randomUUID(),intentId:randomUUID(),approvalId:a.approval_id,approvalVersion:a.aggregate_version,
      runId:g.run_id,workId:g.work_item_id,inputWorkVersion:g.input_work_version,baseRunVersion:g.run_version,runVersion:(BigInt(g.run_version)+1n).toString(),baseTaskLeaseEpoch:g.task_lease_epoch,
      taskLeaseEpoch:(BigInt(g.task_lease_epoch)+1n).toString(),controlEpoch:g.control_epoch,ownerUserId:g.owner_user_id,ownerPrincipalId:g.owner_principal_id,scopeId:g.scope_id,
      environment,clientId,runtimeDeviceId:g.runtime_device_id,runtimeVersion:g.runtime_version,connectionId:g.connection_id,connectionVersion:g.connection_version,familyId:g.family_id,
      modelConnectionId:g.model_connection_id,modelVersion:g.model_version,selection:g.selection,grantId:g.grant_id,grantVersion:g.aggregate_version,persistencePolicyRevision:a.persistence_policy_revision,
      exportPolicyId:a.policy_id,exportPolicyRevision:a.export_policy_revision,contextSha256:a.context_sha256,inputByteSize:a.input_byte_size,maxOutputTokens:a.max_output_tokens}));
    const verified=await host.verify(binding),proof=readVerifiedModelBinding(verified,binding);let b!:BindingRows;
    const validate=async(q:PoolClient)=>{await current(q,actor,b,!!b.step);readVerifiedModelBinding(verified,binding);
      if(b.step && b.step.step_id===binding.stepId && b.step.verified_binding.recoveryGeneration!==proof.recoveryGeneration)stale();await guard(q);};
    const result=await scopedMemberCommand(pool,{actor,scope:'personal',operation,key:input.key,target:{kind:'model_export_approval',id:input.approvalId},expected:input.expectedApprovalVersion,
      body:{environment,clientId,expectedRunVersion:input.expectedRunVersion}},async(q,context)=>{b=await derive(q,context);await validate(q);},async(q,context)=>{
      requireCondition(!b.step,409,'model_step_already_activated','模型步驟已啟用。');
      const t=await current(q,actor,b),expiry=new Date(Math.min(t.getTime()+90000,a.expires_at.getTime(),g.expires_at.getTime(),b.connection.expires_at.getTime(),b.family.expires_at.getTime(),new Date(proof.expiresAt).getTime()));
      requireCondition(expiry>t,409,'model_step_binding_stale','模型步驟時效不足。');
      const n=(await q.query<{n:number}>('SELECT count(*)::int n FROM execution_attempts WHERE run_id=$1',[binding.runId])).rows[0].n;
      requireCondition(n<16,429,'execution_attempt_limit','執行次數已達上限。');
      await q.query(`INSERT INTO execution_attempts(attempt_id,run_id,work_item_id,owner_user_id,owner_principal_id,scope_id,grant_id,attempt_number,grant_snapshot,state,blockers,activation_binding,created_at)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,execution_prerequisite_grant_snapshot(to_jsonb(g)),'active','[]'::jsonb,$9,$10 FROM execution_grants g WHERE grant_id=$7`,
      [binding.attemptId,binding.runId,binding.workId,...owners(actor,context),binding.grantId,n+1,JSON.stringify(binding),t]);
      await q.query(`INSERT INTO model_text_steps(step_id,attempt_id,intent_id,approval_id,run_id,work_item_id,owner_user_id,owner_principal_id,scope_id,environment,client_id,binding,verified_binding,
        evidence_origin,activated_run_version,task_lease_epoch,control_epoch,context_sha256,input_byte_size,max_output_tokens,creation_key,created_at,lease_expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
      [binding.stepId,binding.attemptId,binding.intentId,binding.approvalId,binding.runId,binding.workId,...owners(actor,context),environment,clientId,JSON.stringify(binding),JSON.stringify(proof),proof.evidenceOrigin,
        binding.runVersion,binding.taskLeaseEpoch,binding.controlEpoch,binding.contextSha256,binding.inputByteSize,binding.maxOutputTokens,input.key,t,expiry]);
      await q.query("UPDATE execution_runs SET state='running',current_attempt_id=$2,aggregate_version=aggregate_version+1,task_lease_epoch=task_lease_epoch+1 WHERE run_id=$1 AND aggregate_version=$3",[binding.runId,binding.attemptId,binding.baseRunVersion]);
      b=await locateStep(q,actor,context,binding.stepId);await journal(q,context,operation,'model_text_step',binding.stepId,b.step!.aggregate_version,b.step!.state);return metadata(b.step!);
    },async q=>validate(q));
    return result;
  }
  async function read(actor:Actor,raw:c.ModelStepReadInput,invocation?:ModelStepInvocationGuard) {const guard=captureModelStepInvocation(invocation);actor=Object.freeze({...actor});const input=parse(c.ReadSchema,raw);
    return withMemberScope(pool,{actor,scope:'personal'},async()=>{},async(q,context)=>{const value=metadata((await locateStep(q,actor,context,input.stepId,false)).step!);await guard(q);await now(q,actor);return value;});}
  // Acknowledgement replay reads durable identity only; it cannot mint execution authority.
  async function readActivation(actor:Actor,raw:c.ModelStepActivateInput,invocation?:ModelStepInvocationGuard) {
    const guard=captureModelStepInvocation(invocation);actor=Object.freeze({...actor});const input=parse(c.ActivateSchema,raw);
    return withMemberScope(pool,{actor,scope:'personal'},async()=>{},async(q,context)=>{
      const prior=(await q.query<{step_id:string}>('SELECT step_id FROM model_text_steps WHERE owner_principal_id=$1 AND scope_id=$2 AND environment=$3 AND client_id=$4 AND creation_key=$5',
        [context.subject_principal.principal_id,context.scope.scope_id,environment,clientId,input.key])).rows[0];
      requireCondition(prior,409,'model_step_binding_stale','模型步驟尚未可用。');
      const s=(await locateStep(q,actor,context,prior.step_id,false)).step!;
      requireCondition(s.approval_id===input.approvalId && s.binding.approvalVersion===input.expectedApprovalVersion
        && s.binding.baseRunVersion===input.expectedRunVersion,409,'idempotency_conflict','同一操作不可改綁。');
      await guard(q);await now(q,actor);return metadata(s);
    });
  }
  async function begin(actor:Actor,raw:c.ModelStepBeginInput,invocation?:ModelStepInvocationGuard):Promise<{metadata:c.ModelStepMetadata;capability:OpaqueModelStepCapability|null}> {
    const guard=captureModelStepInvocation(invocation);actor=Object.freeze({...actor});const input=parse(c.BeginSchema,raw),operation='execution.model-step.begin';let b!:BindingRows,fresh=false;
    // SQL metadata selects the exact binding; only a fresh genuine host verification
    // creates authority. Never verify or mint another capability for a consumed step.
    const initial=await withMemberScope(pool,{actor,scope:'personal'},async()=>{},async(q,context)=>{
      const value=await locateStep(q,actor,context,input.stepId);await guard(q);
      if(value.step!.state==='reserved')checkVersion(value.step!.aggregate_version,input.expectedVersion);
      return value.step!;
    });
    const opaque:OpaqueVerifiedModelBinding|null=initial.state==='reserved'?await host.verify(initial.binding):null;
    const validate=async(q:PoolClient)=>{await current(q,actor,b,true);if(b.step!.state==='reserved')checkVersion(b.step!.aggregate_version,input.expectedVersion);
      else requireCondition(b.step!.state==='dispatched',409,'model_step_already_consumed','模型步驟不能重送。');
      if(fresh && (!b.step!.permit_expires_at || await now(q,actor)>=b.step!.permit_expires_at))stale();await guard(q);};
    const result=await scopedMemberCommand(pool,{actor,scope:'personal',operation,key:input.key,target:{kind:'model_text_step',id:input.stepId},expected:input.expectedVersion,body:{environment,clientId}},
    async(q,context)=>{b=await locateStep(q,actor,context,input.stepId);await validate(q);},async(q,context)=>{
      checkVersion(b.step!.aggregate_version,input.expectedVersion);requireCondition(b.step!.state==='reserved',409,'model_step_already_consumed','模型步驟不能重送。');
      requireCondition(opaque,503,'model_authentication_unavailable','模型認證暫時無法使用。');
      const verified=readVerifiedModelBinding(opaque,b.step!.binding);requireCondition(verified.recoveryGeneration===b.step!.verified_binding.recoveryGeneration && verified.evidenceOrigin===b.step!.evidence_origin,409,'model_step_binding_stale','復原世代已變更。');
      const t=await current(q,actor,b,true),expiry=new Date(Math.min(t.getTime()+5000,b.step!.lease_expires_at.getTime(),new Date(verified.expiresAt).getTime(),modelStepInvocationExpiry(guard)));
      await q.query(`UPDATE model_text_steps SET state='dispatched',aggregate_version=aggregate_version+1,usage_status='unknown',dispatched_at=$3,permit_expires_at=$4,verified_binding=$5
        WHERE step_id=$1 AND aggregate_version=$2`,[input.stepId,input.expectedVersion,t,expiry,JSON.stringify(verified)]);
      b.step=await step(q,actor,context,input.stepId,true);fresh=true;await journal(q,context,operation,'model_text_step',input.stepId,b.step.aggregate_version,b.step.state);return metadata(b.step);
    },async q=>validate(q));
    if(!fresh)return Object.freeze({metadata:result,capability:null});
    const beforeDispatch=async()=>{await withMemberScope(pool,{actor,scope:'personal'},async()=>{},async(q,context)=>{
      const latest=await locateStep(q,actor,context,input.stepId);const t=await current(q,actor,latest,true);
      if(latest.step!.state!=='dispatched'||!latest.step!.permit_expires_at||t>=latest.step!.permit_expires_at)stale();await guard(q);});assertModelStepInvocationTime(guard);};
    const capability=createModelStepCapability(b.step!.binding,opaque!,b.step!.permit_expires_at!.toISOString(),beforeDispatch);
    capabilities.set(capability,input.stepId);return Object.freeze({metadata:result,capability});
  }
  async function contextBytes(actor:Actor,capability:OpaqueModelStepCapability,invocation?:ModelStepInvocationGuard) {
    const guard=captureModelStepInvocation(invocation);
    actor=Object.freeze({...actor});const cap=readModelStepCapability(capability);requireCondition(capabilities.get(capability)===cap.binding.stepId,403,'model_step_capability_invalid','模型步驟憑證無效。');
    return withMemberScope(pool,{actor,scope:'personal'},async()=>{},async(q,context)=>{const b=await locateStep(q,actor,context,cap.binding.stepId);const t=await current(q,actor,b,true);
      if(b.step!.state!=='dispatched'||t>=new Date(cap.expiresAt))stale();await guard(q);return new Uint8Array(b.bytes!);});
  }
  async function record(actor:Actor,capability:OpaqueModelStepCapability,observation:OpaqueModelObservation,invocation?:ModelStepInvocationGuard) {
    const guard=captureModelStepInvocation(invocation);
    actor=Object.freeze({...actor});const cap=readModelStepCapability(capability);requireCondition(capabilities.get(capability)===cap.binding.stepId,403,'model_step_capability_invalid','模型步驟憑證無效。');
    const observed=readModelObservation(observation,capability);await assertModelObservationCurrent(observation);
    const {text:_text,binding:_binding,...safe}=observed;let b!:BindingRows;const operation='execution.model-step.record';
    return scopedMemberCommand(pool,{actor,scope:'personal',operation,key:cap.binding.intentId,target:{kind:'model_text_step',id:cap.binding.stepId},body:{outputSha256:observed.outputSha256}},
    async(q,context)=>{b=await locateStep(q,actor,context,cap.binding.stepId);if(b.step!.state!=='dispatched'&&b.step!.state!=='awaiting_result')stale();
      if(b.step!.verified_binding.bindingId!==observed.bindingId||b.step!.verified_binding.recoveryGeneration!==observed.recoveryGeneration)stale();await guard(q);},
    async(q,context)=>{const t=await current(q,actor,b,true);await q.query(`UPDATE model_text_steps SET state='awaiting_result',aggregate_version=aggregate_version+1,
      usage_status='known',observation=$2,observed_at=$3 WHERE step_id=$1 AND state='dispatched'`,[cap.binding.stepId,JSON.stringify(safe),t]);b.step=await step(q,actor,context,cap.binding.stepId,true);
      await journal(q,context,operation,'model_text_step',b.step.step_id,b.step.aggregate_version,b.step.state);return metadata(b.step);},async q=>{
        await assertModelObservationCurrent(observation);await current(q,actor,b,true);await guard(q);});
  }
  async function control(actor:Actor,raw:c.ModelStepControlInput) {actor=Object.freeze({...actor});const input=parse(c.ControlSchema,raw),operation=`execution.model-step.${input.action}`;let b!:BindingRows;
    return scopedMemberCommand(pool,{actor,scope:'personal',operation,key:input.key,target:{kind:'model_text_step',id:input.stepId},expected:input.expectedVersion,body:{environment,clientId}},
    async(q,context)=>{b=await locateStep(q,actor,context,input.stepId,false);},async(q,context)=>{checkVersion(b.step!.aggregate_version,input.expectedVersion);
      requireCondition(b.step!.state!=='cancelled'&&b.step!.state!=='succeeded',409,'model_step_already_consumed','模型步驟已結束。');
      requireCondition(b.run.state!=='cancelled'&&b.run.state!=='succeeded',409,'execution_run_terminal','執行紀錄已結束。');
      if(b.step!.state==='reserved')await q.query("UPDATE model_text_steps SET state='cancelled',aggregate_version=aggregate_version+1,reservation_held=false WHERE step_id=$1",[input.stepId]);
      if(b.step!.state==='dispatched')await q.query("UPDATE model_text_steps SET state='outcome_unknown',aggregate_version=aggregate_version+1 WHERE step_id=$1",[input.stepId]);
      if(b.step!.state==='awaiting_result'||b.step!.state==='outcome_unknown')await q.query('UPDATE model_text_steps SET aggregate_version=aggregate_version+1 WHERE step_id=$1',[input.stepId]);
      const runState=input.action==='pause'?'paused':(['dispatched','outcome_unknown'].includes(b.step!.state)?'reconciling':'cancelled');
      await q.query("UPDATE execution_runs SET state=$2,aggregate_version=aggregate_version+1,task_lease_epoch=task_lease_epoch+1,control_epoch=control_epoch+1 WHERE run_id=$1",[b.grant.run_id,runState]);
      b.step=await step(q,actor,context,input.stepId,true);await journal(q,context,operation,'model_text_step',input.stepId,b.step.aggregate_version,b.step.state);return metadata(b.step);},async q=>{await now(q,actor);});}
  async function unknown(actor:Actor,capability:OpaqueModelStepCapability) {actor=Object.freeze({...actor});const cap=readModelStepCapability(capability);requireCondition(capabilities.get(capability)===cap.binding.stepId,403,'model_step_capability_invalid','模型步驟憑證無效。');
    return withMemberScope(pool,{actor,scope:'personal'},async()=>{},async(q,context)=>{const b=await locateStep(q,actor,context,cap.binding.stepId,false);
      if(b.step!.state==='dispatched'){await q.query("UPDATE model_text_steps SET state='outcome_unknown',aggregate_version=aggregate_version+1 WHERE step_id=$1",[b.step!.step_id]);
        if(b.run.state==='running')await q.query("UPDATE execution_runs SET state='reconciling',aggregate_version=aggregate_version+1,task_lease_epoch=task_lease_epoch+1 WHERE run_id=$1",[b.grant.run_id]);}
      await now(q,actor);return metadata(await step(q,actor,context,cap.binding.stepId,true));});}
  async function lockResult(q:PoolClient,context:MemberScopeContext,actor:Actor,stepId:string) {
    const b=await locateStep(q,actor,context,stepId);const s=b.step!;requireCondition(s.state==='awaiting_result'&&s.observation,409,'model_step_result_unavailable','模型成果尚未可用。');
    const o=s.observation!;return freezeTree({stepId:s.step_id,attemptId:s.attempt_id,intentId:s.intent_id,runId:s.run_id,workId:s.work_item_id,inputWorkVersion:s.binding.inputWorkVersion,
      aggregateVersion:s.aggregate_version,selection:s.binding.selection,sourceOrigin:s.evidence_origin,evidenceOrigin:s.evidence_origin,outputSha256:String(o.outputSha256),
      outputByteSize:Number(o.outputByteSize),usage:c.ModelStepUsageSchema.parse(o.usage),binding:s.binding,bindingId:String(o.bindingId),evidenceDigest:String(o.evidenceDigest),
      recoveryGeneration:String(o.recoveryGeneration),adapterProfile:String(o.adapterProfile),reportedModelRef:String(o.reportedModelRef),observation:o});
  }
  async function markResult(q:PoolClient,_context:MemberScopeContext,actor:Actor,stepId:string,resultId:string) {
    await now(q,actor);const updated=await q.query(`UPDATE model_text_steps SET state='succeeded',aggregate_version=aggregate_version+1,reservation_held=false,result_id=$2
      WHERE step_id=$1 AND state='awaiting_result' RETURNING run_id`,[stepId,resultId]);requireCondition(updated.rowCount===1,409,'model_step_result_unavailable','模型成果狀態已變更。');
    await q.query("UPDATE execution_runs SET state='succeeded',aggregate_version=aggregate_version+1 WHERE run_id=$1 AND state='running'",[updated.rows[0].run_id]);
  }
  return Object.freeze({approvals:Object.freeze({create:createApproval,read:readApproval,revoke:revokeApproval}),activate,readActivation,begin,read,control,record,unknown,context:contextBytes,lockResult,markResult});
}
