// Explicit remote member HTTP subset. No provider key, SQL or infrastructure port.
import {createHash,randomUUID} from 'node:crypto';
import {join,isAbsolute} from 'node:path';
import {z} from 'zod';
import {PrivateAiPrepareConfigSchema} from './verify-cloud-private-ai-prepare.js';
import {durableCreate,privateDirectory,reserveSessionBudget,validateBudget} from './lib/openrouter-acceptance-guard.js';
import {MemberExecutionVersionSchema as Version,ExecutionGrantMetadataSchema,ModelSelectionSchema} from '../contracts/execution/v1/member-execution.js';
import {MemberExecutionHttpRunMetadataSchema} from '../contracts/execution/v1/member-execution-http.js';
import {MemberModelHttpOverviewSchema} from '../contracts/execution/v2/member-model-http.js';
import {MemberModelSettingsOverviewSchema} from '../contracts/execution/v2/member-model-settings.js';
import {ModelStepApprovalMetadataSchema,ModelStepMetadataSchema,ModelStepUsageSchema} from '../contracts/execution/v2/model-step.js';
import type {Account,CandidateClient,Secrets,Target} from './verify-cloud-candidate-lib.js';
const sha=z.string().regex(/^[a-f0-9]{40}$/),digest=z.string().regex(/^[a-f0-9]{64}$/),time=z.iso.datetime({offset:true});
const price=z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/).max(64);
export const PrivateAiExecuteConfigSchema=PrivateAiPrepareConfigSchema.omit({profile:true,paidExecution:true}).extend({
 profile:z.literal('private-ai.staging-owner-execute/v1'),paidExecution:z.literal(true),acknowledgeOnePaidDispatch:z.literal(true),
 modelConnectionId:z.uuid(),modelVersion:Version,budgetEvidenceFile:z.string().refine(isAbsolute),ledgerDirectory:z.string().refine(isAbsolute),
 expiresAt:time,maxUsd:z.number().finite().positive().max(10),maxOutputTokens:z.literal(128),maxExecuteRequests:z.literal(1),
}).strict();
export type PrivateAiExecuteConfig=z.infer<typeof PrivateAiExecuteConfigSchema>;
export const PrivateAiBudgetEvidenceSchema=z.object({profile:z.literal('private-ai.operator-budget-evidence/v1'),
 model:z.string().min(1).max(96),mainReleaseSha:sha,brokerReleaseSha:sha,observedAt:time,expiresAt:time,
 keyExpiresAt:time,keyLimit:z.number().finite().positive().max(10),keyUsage:z.number().finite().nonnegative(),
 promptPrice:price,completionPrice:price,requestPrice:price,
}).strict();
export function validatePrivateAiBudget(raw:unknown,c:PrivateAiExecuteConfig,now=Date.now()) {
 validateBudget(c,now);const e=PrivateAiBudgetEvidenceSchema.parse(raw),observed=Date.parse(e.observedAt),expires=Date.parse(e.expiresAt);
 const bound=17408*Number(e.promptPrice)+128*Number(e.completionPrice)+Number(e.requestPrice);
 if(e.model!==c.model||e.mainReleaseSha!==c.mainReleaseSha||e.brokerReleaseSha!==c.brokerReleaseSha
  ||observed>now||now-observed>60000||expires<=now||expires>observed+60000||expires<=observed
  ||Date.parse(e.keyExpiresAt)!==Date.parse(c.expiresAt)||Date.parse(e.keyExpiresAt)<=now||e.keyLimit>c.maxUsd
  ||!Number.isFinite(bound)||bound<0||bound>0.10||e.keyUsage+bound>e.keyLimit||e.keyUsage+bound>c.maxUsd)throw Error('private_ai_budget_evidence_unavailable');
 return {evidence:e,reviewedUpperEstimateUsd:bound};
}
export function validatePrivateAiExecute(raw:unknown,target:Target,release:string|null|undefined,account:Account|null|undefined){
 const c=PrivateAiExecuteConfigSchema.parse(raw);
 if(target.name!=='staging'||target.origin!==c.mainOrigin||target.mode!=='staging'||target.harness!=='cloud_candidate'
  ||c.mainReleaseSha!==release||c.brokerReleaseSha!==release||c.accountLabel!==account?.label)throw Error('private_ai_execute_binding_mismatch');
 validateBudget(c);return c;
}
const Work=z.object({workId:z.uuid(),aggregateVersion:Version,state:z.literal('draft')}).strict();
const Result=z.object({resultId:z.uuid(),workId:z.uuid(),revision:Version,workVersion:Version,aggregateVersion:Version,
 contentType:z.enum(['text/plain','text/markdown']),byteSize:z.number().int().positive().max(16384),sha256:digest,createdAt:time,
 provenance:z.enum(['human','model']),text:z.string().min(1).max(16384),model:z.object({stepId:z.uuid(),attemptId:z.uuid(),dispatchIntentId:z.uuid(),
 selection:ModelSelectionSchema,evidenceOrigin:z.literal('provider_https'),usage:ModelStepUsageSchema,costStatus:z.literal('unknown')}).strict().optional(),
}).strict();
const Edit=z.object({intentId:z.uuid(),resultId:z.uuid(),workId:z.uuid(),assetId:z.uuid(),revision:Version,aggregateVersion:Version,provenance:z.literal('human')}).strict();
const Connection=z.object({connectionId:z.uuid(),runtimeDeviceId:z.uuid(),environment:z.literal('staging-next'),clientId:z.string(),state:z.enum(['active','revoked']),aggregateVersion:Version,issuedAt:time,expiresAt:time,operational_authority:z.literal(false)}).strict();
type Context={check(id:string,condition:boolean):void;metric(key:string,value:unknown):void;cleanup(item:string,state:'residual_expected'):void};
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const objective='Write one brief, harmless greeting for a fictional garden club. No tools, links, personal data or external actions.';
export async function runPrivateAiExecute(input:{config:PrivateAiExecuteConfig;budgetEvidence:unknown;client:CandidateClient;secrets:Secrets;ctx:Context;authenticate:()=>Promise<{userId:string}>}) {
 const {config:c,client,secrets,ctx}=input;const runId=randomUUID();
 let stage='budget',sequence=0,lastHttpStatus:number|null=null,unknownCommand:string|null=null,executeRequests=0,dispatchOutcomeUnknown=false;
 const checks:Record<string,boolean>={};let budget:Awaited<ReturnType<typeof reserveSessionBudget>>|undefined;
 ctx.metric('scope','synthetic_staging_owner_http_subset');ctx.metric('full_owner_acceptance','incomplete');
 for(const key of ['remote_r2_independent','broker_restart','recovery_withdrawal','foreign_owner_deny','provider_post_count','provider_cost'])ctx.metric(key,'unavailable');
 ctx.metric('budget_evidence','operator_observation_not_attestation');ctx.metric('guaranteed_provider_usd_cap',false);
 const reviewed=validatePrivateAiBudget(input.budgetEvidence,c);await privateDirectory(c.receiptDirectory);
 await durableCreate(join(c.receiptDirectory,'execute-intent.json'),{profile:c.profile,runId,at:new Date().toISOString(),mainRelease:c.mainReleaseSha,
  brokerRelease:c.brokerReleaseSha,bindingReviewSha256:c.bindingReviewSha256,accountLabel:c.accountLabel,modelConnectionId:c.modelConnectionId,
  maxOutputTokens:128,maxExecuteRequests:1,budgetEvidence:reviewed.evidence,reviewedUpperEstimateUsd:reviewed.reviewedUpperEstimateUsd,noAutomaticRetry:true});
 ctx.cleanup('synthetic owner works, grants, Results and permanent paid attempt; reconcile unknown outcomes manually','residual_expected');
 const get=async(path:string)=>{const reply=await client.request('GET',path);lastHttpStatus=reply.status;ctx.check('owner_http_read',reply.status===200);return reply.json();};
 const post=async<T>(name:string,path:string,body:unknown,version:string|undefined,schema:z.ZodType<T>,status=200)=>{
  unknownCommand=null;stage=name;const key=randomUUID();secrets.add(key);
  await durableCreate(join(c.receiptDirectory,`command-${String(++sequence).padStart(2,'0')}-${name}.json`),{path,key,expectedVersion:version??null,at:new Date().toISOString(),noAutomaticRetry:true});
  if(name==='execute'){
   // Recheck *after* durable intent, immediately before the only execute fetch.
   validatePrivateAiBudget(reviewed.evidence,c);ctx.check('one_execute_request',executeRequests===0);executeRequests++;dispatchOutcomeUnknown=true;
  }
  unknownCommand=name;const reply=await client.request('POST',path,{json:body,ifMatch:version,idempotency:key});lastHttpStatus=reply.status;
  // Non-success or malformed ACK can follow partial effects. Never clear unknown
  // from a status alone and never resubmit this or a later command automatically.
  ctx.check('owner_http_command',reply.status===status);const value=schema.parse(reply.json());
  if(value&&typeof value==='object'&&'aggregateVersion'in value)ctx.check('command_etag',reply.headers.get('ETag')===`"${value.aggregateVersion}"`);
  await durableCreate(join(c.receiptDirectory,`ack-${String(sequence).padStart(2,'0')}-${name}.json`),{at:new Date().toISOString(),status,metadata:value});return value;
 };
 try{
  budget=await reserveSessionBudget(c.ledgerDirectory,runId,c);stage='login';await input.authenticate();
  stage='installed_owner_policy';const settings=MemberModelSettingsOverviewSchema.parse(await get('/api/v1/me/model-settings'));
  const model=settings.models.find(v=>v.modelConnectionId===c.modelConnectionId),connection=settings.connections.find(v=>v.connectionId===model?.connectionId);
  const selection={providerRef:'openrouter',modelRef:c.model,processingLocation:'provider_remote',artifactCustody:'platform_asset',credentialCustody:'platform_vault',engineLocation:'platform',billingSource:'user_byok'};
  const sameSelection=(raw:unknown)=>{const parsed=ModelSelectionSchema.safeParse(raw);return parsed.success&&Object.entries(selection).every(([k,v])=>(parsed.data as any)[k]===v);};
  ctx.check('exact_owner_model',!!model&&model.state==='unverified'&&model.aggregateVersion===c.modelVersion&&model.environment===c.environment&&model.clientId===c.clientId&&sameSelection(model.selection));
  ctx.check('exact_active_connection',!!connection&&connection.runtimeDeviceId===model!.runtimeDeviceId&&connection.state==='active'&&Date.parse(connection.expiresAt)>Date.now());
  ctx.check('installed_setup',settings.setup.state==='installed'&&settings.setup.setupOrigin===c.setupOrigin);
  const credentials=settings.credentials.filter(v=>v.modelConnectionId===c.modelConnectionId&&v.state==='active');
  ctx.check('one_matching_active_credential',credentials.length===1&&credentials[0].modelVersion===c.modelVersion&&sameSelection(credentials[0].selection)&&Date.parse(credentials[0].expiresAt)>Date.now());
  const overview=MemberModelHttpOverviewSchema.parse(await get('/api/v1/me/model-step-overview'));
  ctx.check('real_owner_policy_available',overview.persistenceAvailable&&overview.allowedSelections.some(v=>sameSelection(v.selection)&&v.maxOutputTokens>=128));
  async function prepare(label:'draft'|'cancel'){
   const title=label==='draft'?'Synthetic remote acceptance draft':'Synthetic remote reserved draft to cancel';
   const contextText=JSON.stringify({schema:'model-step.context/v1',title,objective});
   const work=await post(label+'_work','/api/v1/me/private-work',{title,objective},undefined,Work,201);
   const run=await post(label+'_run','/api/v1/me/execution-runs',{workId:work.workId},work.aggregateVersion,MemberExecutionHttpRunMetadataSchema,201);
   ctx.check('exact_run',run.workId===work.workId&&run.inputWorkVersion===work.aggregateVersion&&run.state==='created');
   const grant=await post(label+'_grant','/api/v1/me/execution-runs/'+run.runId+'/grants',{expectedWorkVersion:work.aggregateVersion,connectionId:connection!.connectionId,expectedConnectionVersion:connection!.aggregateVersion,modelConnectionId:model!.modelConnectionId,expectedModelVersion:model!.aggregateVersion,consent:true},run.aggregateVersion,ExecutionGrantMetadataSchema,201);
   ctx.check('exact_grant',grant.runId===run.runId&&grant.workId===work.workId&&grant.connectionId===connection!.connectionId&&grant.runtimeDeviceId===model!.runtimeDeviceId&&grant.modelConnectionId===model!.modelConnectionId&&grant.modelVersion===c.modelVersion&&grant.familyId===model!.familyId&&sameSelection(grant.selection)&&grant.state==='active'&&grant.inputWorkVersion===work.aggregateVersion&&grant.runVersion===run.aggregateVersion&&grant.connectionVersion===connection!.aggregateVersion&&Date.parse(grant.expiresAt)>Date.now());
   const approval=await post(label+'_approval','/api/v1/me/model-step-approvals',{runId:run.runId,grantId:grant.grantId,expectedGrantVersion:grant.aggregateVersion,expectedWorkVersion:work.aggregateVersion,consent:true,maxOutputTokens:128},run.aggregateVersion,ModelStepApprovalMetadataSchema,201);
   ctx.check('exact_approval',approval.runId===run.runId&&approval.workId===work.workId&&approval.grantId===grant.grantId&&approval.maxOutputTokens===128&&approval.inputWorkVersion===work.aggregateVersion&&approval.inputByteSize===Buffer.byteLength(contextText)&&approval.contextSha256===hash(contextText)&&sameSelection(approval.selection)&&approval.state==='active'&&Date.parse(approval.expiresAt)>Date.now());
   if(label==='draft')validatePrivateAiBudget(reviewed.evidence,c);
   const step=await post(label+'_activation','/api/v1/me/model-steps',{approvalId:approval.approvalId,expectedRunVersion:run.aggregateVersion},approval.aggregateVersion,ModelStepMetadataSchema,201);
   ctx.check('exact_reserved_step',step.state==='reserved'&&step.evidenceOrigin==='provider_https'&&step.approvalId===approval.approvalId&&step.runId===run.runId&&step.workId===work.workId&&step.inputWorkVersion===work.aggregateVersion&&sameSelection(step.selection)&&step.usageStatus==='not_dispatched'&&Date.parse(step.expiresAt)>Date.now());
   return{work,run,grant,approval,step};
  }
  const first=await prepare('draft');checks.grantAndActivation=true;
  const final=await post('execute','/api/v1/me/model-steps/'+first.step.stepId+':execute',{},first.step.aggregateVersion,ModelStepMetadataSchema);
  ctx.check('execution_committed',final.stepId===first.step.stepId&&final.runId===first.run.runId&&final.attemptId===first.step.attemptId&&final.attemptNumber===first.step.attemptNumber&&final.inputWorkVersion===first.work.aggregateVersion&&final.workId===first.work.workId&&final.approvalId===first.approval.approvalId&&final.state==='succeeded'&&final.evidenceOrigin==='provider_https'&&sameSelection(final.selection)&&final.usageStatus==='known');checks.executeCommitted=true;
  const readResult=async(path:string)=>{const r=Result.parse(await get(path));secrets.add(r.text);ctx.check('result_bytes',Buffer.byteLength(r.text)===r.byteSize&&hash(r.text)===r.sha256);return r;};
  stage='owner_result';const path='/api/v1/me/private-work/'+first.work.workId+'/results';const original=await readResult(path+'/current');
  ctx.check('exact_model_result',original.workId===first.work.workId&&original.provenance==='model'&&original.model?.stepId===first.step.stepId&&original.model.attemptId===first.step.attemptId&&sameSelection(original.model.selection)&&original.model.usage.outputTokens<=128);checks.ownerResultHttpRead=true;dispatchOutcomeUnknown=false;
  await durableCreate(join(c.receiptDirectory,'result-evidence.json'),{workId:first.work.workId,resultId:original.resultId,sha256:original.sha256,byteSize:original.byteSize,evidence:'remote_owner_HTTP_read',independentR2:'unavailable'});
  const editedText=original.text+'\nSynthetic owner clarification: welcome new gardeners.';secrets.add(editedText);ctx.check('edit_byte_bound',Buffer.byteLength(editedText)<=16384);
  const edit=await post('result_edit',path+'/'+original.resultId+'/edit',{text:editedText},original.aggregateVersion,Edit);
  ctx.check('human_revision',edit.workId===original.workId&&BigInt(edit.revision)===BigInt(original.revision)+1n&&edit.resultId!==original.resultId);
  const current=await readResult(path+'/current'),source=await readResult(path+'/'+original.resultId);
  ctx.check('human_edit_preserves_source',current.resultId===edit.resultId&&current.workId===original.workId&&current.revision===edit.revision&&current.aggregateVersion===edit.aggregateVersion&&current.provenance==='human'&&current.text===editedText&&!current.model&&source.resultId===original.resultId&&source.workId===original.workId&&source.revision===original.revision&&source.model?.stepId===first.step.stepId&&source.model.attemptId===first.step.attemptId&&source.text===original.text&&source.sha256===original.sha256&&source.provenance==='model');checks.humanEditPreservesSource=true;
  const second=await prepare('cancel');
  const stopped=await post('stop','/api/v1/me/model-steps/'+second.step.stepId+':stop',{},second.step.aggregateVersion,ModelStepMetadataSchema);
  ctx.check('reserved_step_stopped',stopped.stepId===second.step.stepId&&stopped.runId===second.run.runId&&stopped.workId===second.work.workId&&stopped.approvalId===second.approval.approvalId&&stopped.attemptId===second.step.attemptId&&stopped.state==='cancelled'&&stopped.usageStatus==='not_dispatched');checks.stop=true;
  const revoked=await post('approval_revoke','/api/v1/me/model-step-approvals/'+second.approval.approvalId+':revoke',{},second.approval.aggregateVersion,ModelStepApprovalMetadataSchema);
  ctx.check('approval_revoked',revoked.approvalId===second.approval.approvalId&&revoked.workId===second.work.workId&&revoked.runId===second.run.runId&&revoked.grantId===second.grant.grantId&&revoked.state==='revoked');
  const connectionRevoked=await post('connection_revoke','/api/v1/me/agent-connections/'+connection!.connectionId+':revoke',{},connection!.aggregateVersion,Connection);
  ctx.check('connection_revoked',connectionRevoked.connectionId===connection!.connectionId&&connectionRevoked.runtimeDeviceId===model!.runtimeDeviceId&&connectionRevoked.environment===c.environment&&connectionRevoked.clientId===c.clientId&&connectionRevoked.state==='revoked');checks.revoke=true;
  ctx.metric('owner_http_subset','pass');stage='complete';unknownCommand=null;
 }finally{
  ctx.metric('execute_requests',executeRequests);ctx.metric('dispatch_outcome_unknown',dispatchOutcomeUnknown);ctx.metric('unknown_command_outcome',unknownCommand!==null);
  await durableCreate(join(c.receiptDirectory,'execute-receipt.json'),{profile:c.profile,runId,status:stage==='complete'?'http_subset_pass':'unavailable',fullOwnerAcceptance:'incomplete',stage,lastHttpStatus,checks,unknownCommand,dispatchOutcomeUnknown,executeRequests,budget,
   providerPosts:'unavailable',providerCost:'unknown',guaranteedProviderUsdCap:false,budgetEvidence:'operator_observation_not_attestation',independentRemoteR2:'unavailable',brokerRestart:'unavailable',recoveryWithdrawal:'unavailable',foreignOwnerDeny:'unavailable',noAutomaticRetry:true});
 }
}
