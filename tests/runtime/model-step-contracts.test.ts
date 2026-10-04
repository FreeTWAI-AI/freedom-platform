import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// @ts-expect-error Existing clean host verification environment is ESM JavaScript.
import { verificationEnvironment } from '../../packages/contribution-tools/process-env.mjs';
import { ApprovalCreateSchema, ApprovalReadSchema, ApprovalRevokeSchema, ActivateSchema, BeginSchema, ReadSchema, ControlSchema,
  ModelStepBindingSchema, ModelStepMetadataSchema, ModelStepApprovalMetadataSchema, type ModelStepBinding } from '../../contracts/execution/v2/model-step.js';
import { createLocalFixtureModelStepHost, createByokModelStepHost, createUnavailableModelStepHost,
  encodeModelStepContext, parseModelStepBinding, createModelStepCapability, readModelStepCapability,
  readVerifiedModelBinding, readModelObservation, readBoundModelObservation, assertModelObservationCurrent, assertModelObservationHost,
  type OpaqueModelStepCapability, type OpaqueModelObservation, type OpaqueVerifiedModelBinding,
} from '../../modules/agent-execution/model-step-host.js';
import { transitionModelStep } from '../../modules/agent-execution/model-step-state.js';
import { createModelStepRunner, type ModelStepRunnerService } from '../../modules/agent-execution/model-step-runner.js';
import type { Actor } from '../../modules/identity-membership/service.js';
import { AdapterFault } from '../../modules/agent-execution/adapters/common.js';

const expiry = () => new Date(Date.now() + 60000).toISOString();
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const context = () => encodeModelStepContext({ schema: 'model-step.context/v1', title: 'Synthetic title', objective: 'A private synthetic objective.' });
function binding(): ModelStepBinding {
  const bytes = context(), id = randomUUID;
  return { profile: 'model-step.binding/v1', stepId:id(), attemptId:id(), intentId:id(), approvalId:id(), approvalVersion:'1',
    runId:id(), workId:id(), inputWorkVersion:'1', baseRunVersion:'1',runVersion:'2',baseTaskLeaseEpoch:'1',taskLeaseEpoch:'2',controlEpoch:'1',
    ownerUserId:id(),ownerPrincipalId:id(),scopeId:id(),environment:'local',clientId:'synthetic-model-test',
    runtimeDeviceId:id(),runtimeVersion:'1',connectionId:id(),connectionVersion:'1',familyId:id(),modelConnectionId:id(),modelVersion:'1',
    selection:{providerRef:'openai',modelRef:'synthetic-model',processingLocation:'provider_remote',artifactCustody:'platform_asset',
      credentialCustody:'platform_vault',engineLocation:'platform',billingSource:'user_byok'},
    grantId:id(),grantVersion:'1',persistencePolicyRevision:'private-work.v1',exportPolicyId:id(),exportPolicyRevision:'1',
    contextSha256:createHash('sha256').update(bytes).digest('hex'),inputByteSize:bytes.byteLength,maxOutputTokens:8 };
}
const fault = (code: string) => (error: unknown) => error instanceof AdapterFault && error.code === code;
async function fixture(fn: (value: {host:ReturnType<typeof createLocalFixtureModelStepHost>;calls:{method:string;path:string;body:unknown}[];setGeneration:(v:string)=>void}) => Promise<void>, provider: 'openai' | 'anthropic' = 'openai') {
  const calls: {method:string;path:string;body:unknown}[]=[]; let generation='7';
  const server = createServer(async (req,res) => {
    const parts:Buffer[]=[]; for await(const chunk of req)parts.push(Buffer.from(chunk));
    const bytes=Buffer.concat(parts); const body=bytes.length?JSON.parse(bytes.toString()):null;
    calls.push({method:req.method!,path:req.url!,body});
    if(provider==='openai')assert.equal(req.headers.authorization,'Bearer SYNTHETIC_FIXTURE_KEY');
    else{assert.equal(req.headers['x-api-key'],'SYNTHETIC_FIXTURE_KEY');assert.equal(req.headers['anthropic-version'],'2023-06-01');assert.equal(req.headers.authorization,undefined);}
    const output=provider==='anthropic'?(req.method==='GET'?{id:'synthetic-model',type:'model',display_name:'Synthetic only',created_at:'2026-01-01T00:00:00Z',capabilities:null,max_input_tokens:4096,max_tokens:4096}:
      {id:'synthetic-message',type:'message',model:'synthetic-model',role:'assistant',content:[{type:'text',text:'Synthetic draft.'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:2,output_tokens:3}}):
      req.method==='GET'?{id:'synthetic-model',object:'model',created:1,owned_by:'synthetic-fixture',shutdown_date:null}:
      {id:'synthetic-response',object:'response',model:'synthetic-model',status:'completed',output:[{id:'synthetic-message',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Synthetic draft.',annotations:[]}]}],usage:{input_tokens:2,output_tokens:3,total_tokens:5}};
    const out=encode(output); res.writeHead(200,{'Content-Type':'application/json','Content-Length':String(out.byteLength)});res.end(out);
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const address=server.address(); assert.ok(address&&typeof address!=='string');
  const host=createLocalFixtureModelStepHost({environment:'local',origin:`http://127.0.0.1:${address.port}`,
    recover:async()=>({generation,expiresAt:expiry()}),resolveCredential:async()=>({key:new TextEncoder().encode('SYNTHETIC_FIXTURE_KEY'),expiresAt:expiry()})});
  try{await fn({host,calls,setGeneration:v=>{generation=v;}});}finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}

test('model-step closed public commands require every CAS/consent and reject authority, transport and private prompt overrides',()=>{
  const id=randomUUID(), profiles=[
    [ApprovalCreateSchema,{key:'synthetic_key',runId:id,grantId:id,expectedRunVersion:'1',expectedGrantVersion:'1',expectedWorkVersion:'1',consent:true,maxOutputTokens:8}],
    [ApprovalReadSchema,{approvalId:id}], [ApprovalRevokeSchema,{key:'synthetic_key',approvalId:id,expectedVersion:'1'}],
    [ActivateSchema,{key:'synthetic_key',approvalId:id,expectedApprovalVersion:'1',expectedRunVersion:'1'}],
    [BeginSchema,{key:'synthetic_key',stepId:id,expectedVersion:'1'}],[ReadSchema,{stepId:id}],
    [ControlSchema,{key:'synthetic_key',stepId:id,expectedVersion:'1',action:'stop'}],
  ] as const;
  for(const [schema,value] of profiles){
    assert.equal(schema.safeParse(value).success,true);
    for(const key of Object.keys(value)){const incomplete={...value};delete (incomplete as Record<string,unknown>)[key];assert.equal(schema.safeParse(incomplete).success,false,key);}
    for(const key of ['owner','Actor','prompt','selection','providerEndpoint','credential','recoveryGeneration','modelReady','operational_authority','capability','evidenceOrigin','fixture','beforeDispatch','ttl'])assert.equal(schema.safeParse({...value,[key]:true}).success,false,key);
    for(const field of Object.keys(value).filter(k=>k.includes('Version'))){
      for(const version of ['1','9223372036854775807'])assert.equal(schema.safeParse({...value,[field]:version}).success,true);
      for(const version of ['0','01','+1','1e1','1\n','9223372036854775808',1])assert.equal(schema.safeParse({...value,[field]:version}).success,false);
    }
  }
  for(const change of [{consent:false},{maxOutputTokens:4097},{maxOutputTokens:0},{maxOutputTokens:1.1}])assert.equal(ApprovalCreateSchema.safeParse({...profiles[0][1],...change}).success,false);
});

test('actual Anthropic fixture uses exact model metadata and fixed Messages tool-free auth/body profile',async()=>{
  await fixture(async({host,calls})=>{
    const selected=binding();selected.selection.providerRef='anthropic';
    const proof=await host.verify(selected),cap=createModelStepCapability(selected,proof,new Date(Date.now()+4000).toISOString(),async()=>{});
    const observation=await host.dispatch(cap,context()),output=readModelObservation(observation,cap);
    assert.equal(output.reportedModelRef,'synthetic-model');assert.deepEqual(output.usage,{inputTokens:2,outputTokens:3,totalTokens:5});
    assert.deepEqual(calls.map(c=>[c.method,c.path]),[['GET','/v1/models/synthetic-model'],['POST','/v1/messages']]);
    const payload=calls[1].body as Record<string,unknown>;assert.deepEqual(payload.tools,[]);assert.deepEqual(payload.tool_choice,{type:'none'});assert.equal(payload.max_tokens,8);assert.equal(payload.stream,false);
    assert.equal(output.evidenceOrigin,'synthetic_local_fixture');await assertModelObservationCurrent(observation);
  },'anthropic');
});

test('server binding has exact immutable activated fences; context is ordered actual UTF-8 bytes without normalization or truncation',()=>{
  const value=binding();assert.ok(Object.isFrozen(parseModelStepBinding(value).selection));
  for(const change of [{runVersion:'1'},{taskLeaseEpoch:'1'},{baseRunVersion:'9223372036854775807',runVersion:'1'}])assert.throws(()=>parseModelStepBinding({...value,...change}),fault('invalid_input'));
  assert.equal(ModelStepBindingSchema.safeParse({...value,modelReady:true}).success,false);
  const one=encodeModelStepContext({objective:'é',title:'A',schema:'model-step.context/v1'});
  assert.equal(new TextDecoder().decode(one),'{'+'"schema":"model-step.context/v1","title":"A","objective":"é"}');
  assert.notDeepEqual(one,encodeModelStepContext({schema:'model-step.context/v1',title:'A',objective:'e\u0301'}));
  for(const objective of ['\0','\ud800','😀'.repeat(4097),'x'.repeat(16384)])assert.throws(()=>encodeModelStepContext({schema:'model-step.context/v1',title:'A',objective}),fault('invalid_input'));
  let reads=0;const hostile={schema:'model-step.context/v1',title:'A',get objective(){reads++;return 'secret';}};
  assert.throws(()=>encodeModelStepContext(hostile),fault('invalid_input'));assert.equal(reads,0);
});

test('actual local model metadata + single HTTP text dispatch mint only fixture-origin opaque evidence, not JSON readiness',async()=>{
  await fixture(async({host,calls})=>{
    const selected=binding(),proof=await host.verify(selected);
    assert.deepEqual(calls.map(c=>[c.method,c.path]),[['GET','/v1/models/synthetic-model']]);
    assert.equal(calls[0].body,null);
    const verified=readVerifiedModelBinding(proof,selected);assert.equal(verified.evidenceOrigin,'synthetic_local_fixture');assert.equal(verified.recoveryGeneration,'7');
    assert.equal(JSON.stringify(proof),'{}');
    const cap=createModelStepCapability(selected,proof,new Date(Date.now()+4000).toISOString(),async()=>{});
    const result=await host.dispatch(cap,context());const output=readModelObservation(result,cap);
    assert.equal(output.text,'Synthetic draft.');assert.equal(output.reportedModelRef,'synthetic-model');assert.deepEqual(output.usage,{inputTokens:2,outputTokens:3,totalTokens:5});
    assert.equal(output.outputSha256,createHash('sha256').update(output.text).digest('hex'));assert.equal(output.evidenceOrigin,'synthetic_local_fixture');
    assert.equal(readModelStepCapability(cap).consumed,true);assert.equal(JSON.stringify(result),'{}');
    const request=calls[1].body as Record<string,unknown>;assert.deepEqual(request.tools,[]);assert.equal(request.tool_choice,'none');assert.equal(request.store,false);assert.equal(request.max_output_tokens,8);
    await assertModelObservationCurrent(result);
    assertModelObservationHost(result,host);
    assert.throws(()=>assertModelObservationHost(result,createUnavailableModelStepHost()),fault('execution_authority_unavailable'));
    await fixture(async({host:other})=>{assert.throws(()=>assertModelObservationHost(result,other),fault('execution_authority_unavailable'));});
    await assert.rejects(host.dispatch(cap,context()),fault('execution_authority_unavailable'));assert.equal(calls.length,2);
    for(const raw of [{},{...cap},JSON.parse(JSON.stringify(cap))])await assert.rejects(host.dispatch(raw as OpaqueModelStepCapability,context()),fault('execution_authority_unavailable'));
    for(const raw of [{},{...proof}])assert.throws(()=>readVerifiedModelBinding(raw as OpaqueVerifiedModelBinding,selected),fault('execution_authority_unavailable'));
    assert.throws(()=>readBoundModelObservation(result,{...selected,workId:randomUUID()}),fault('execution_authority_unavailable'));
    assert.throws(()=>readBoundModelObservation({} as OpaqueModelObservation,selected),fault('execution_authority_unavailable'));
  });
});

test('capability rejects wrong bytes, exact target changes, another host and recovery fencing without a second POST',async()=>{
  await fixture(async({host,calls,setGeneration})=>{
    const selected=binding(),proof=await host.verify(selected);
    assert.throws(()=>createModelStepCapability({...selected,maxOutputTokens:9},proof,new Date(Date.now()+4000).toISOString(),async()=>{}),fault('execution_authority_unavailable'));
    assert.throws(()=>createModelStepCapability(selected,proof,new Date(Date.now()+6000).toISOString(),async()=>{}),fault('execution_authority_unavailable'));
    const cap=createModelStepCapability(selected,proof,new Date(Date.now()+4000).toISOString(),async()=>{});
    await assert.rejects(host.dispatch(cap,encode({schema:'model-step.context/v1',title:'changed',objective:'changed'})),fault('invalid_input'));
    const recoveryCap=createModelStepCapability(selected,proof,new Date(Date.now()+4000).toISOString(),async()=>{});
    setGeneration('8');await assert.rejects(host.dispatch(recoveryCap,context()),fault('execution_authority_unavailable'));
    assert.equal(calls.length,1);assert.equal(readModelStepCapability(cap).consumed,true);
    await fixture(async({host:other})=>{const second=createModelStepCapability(selected,proof,new Date(Date.now()+4000).toISOString(),async()=>{});await assert.rejects(other.dispatch(second,context()),fault('execution_authority_unavailable'));});
  });
});

test('CLI and nonlocal fixture selections never reach metadata requests; production host has no endpoint/fetch override or ambient default',async()=>{
  await fixture(async({host,calls})=>{
    const selected=binding();
    await assert.rejects(host.verify({...selected,environment:'next'}),fault('unsupported_selection'));
    await assert.rejects(host.verify({...selected,selection:{...selected.selection,artifactCustody:'runtime_local'}}),fault('unsupported_selection'));
    await assert.rejects(host.verify({...selected,selection:{...selected.selection,credentialCustody:'official_cli',engineLocation:'runtime_local',billingSource:'user_cli'}}),fault('unsupported_selection'));
    assert.equal(calls.length,0);
  });
  await assert.rejects(createUnavailableModelStepHost().verify(binding()),fault('execution_authority_unavailable'));
  const ports={recover:async()=>({generation:'1',expiresAt:expiry()}),resolveCredential:async()=>({key:new TextEncoder().encode('SYNTHETIC'),expiresAt:expiry()})};
  for(const origin of ['https://127.0.0.1:1234','http://127.0.0.1','http://127.0.0.2:1234','http://example.test:1234','http://127.0.0.1:1234/path','http://a@127.0.0.1:1234','http://127.0.0.1:1234?x=1'])assert.throws(()=>createLocalFixtureModelStepHost({...ports,environment:'local',origin}),fault('invalid_input'));
  assert.throws(()=>createByokModelStepHost({...ports,endpoint:'http://127.0.0.1:1234'} as typeof ports),fault('invalid_input'));
  const platformHost=createByokModelStepHost(ports),selected=binding();
  await assert.rejects(platformHost.verify({...selected,selection:{...selected.selection,credentialCustody:'local_keychain',engineLocation:'runtime_local',billingSource:'user_byok'}}),fault('unsupported_selection'));
});

test('model-step lifecycle retains unknown usage until genuine observation and typed Result finalization',()=>{
  const selected=binding();const start=ModelStepMetadataSchema.parse({stepId:selected.stepId,attemptId:selected.attemptId,attemptNumber:1,runId:selected.runId,workId:selected.workId,inputWorkVersion:'1',approvalId:selected.approvalId,state:'reserved',aggregateVersion:'1',activatedRunVersion:'2',taskLeaseEpoch:'2',controlEpoch:'1',selection:selected.selection,evidenceOrigin:'synthetic_local_fixture',expiresAt:expiry(),usageStatus:'not_dispatched',costStatus:'unknown',operational_authority:false});
  const claimed=transitionModelStep(start,'begin');assert.equal(claimed.state,'dispatched');assert.equal(claimed.usageStatus,'unknown');assert.equal(start.state,'reserved');
  assert.throws(()=>transitionModelStep(claimed,'begin'),fault('execution_authority_unavailable'));
  assert.throws(()=>transitionModelStep(claimed,'finalize'),fault('execution_authority_unavailable'));
  const unknown=transitionModelStep(claimed,'unknown');assert.equal(unknown.usageStatus,'unknown');assert.equal(unknown.state,'outcome_unknown');
  assert.throws(()=>transitionModelStep(unknown,'begin'),fault('execution_authority_unavailable'));
  const observed=transitionModelStep(claimed,'observe'),done=transitionModelStep(observed,'finalize');assert.equal(done.state,'succeeded');assert.equal(done.usageStatus,'known');assert.equal(done.operational_authority,false);
  const lost=transitionModelStep(observed,'unknown');assert.equal(lost.usageStatus,'known');assert.equal(transitionModelStep(start,'cancel').usageStatus,'not_dispatched');
  assert.throws(()=>transitionModelStep({...start,usageStatus:'known'},'begin'),fault('invalid_input'));
  assert.equal(done.costStatus,'unknown');
});

test('private post-await authority check denies stopped dispatch and cannot be omitted or bypassed by JSON',async()=>{
  await fixture(async({host,calls})=>{
    const selected=binding(),proof=await host.verify(selected);let checked=0;
    assert.throws(()=>createModelStepCapability(selected,proof,new Date(Date.now()+4000).toISOString(),undefined!),fault('execution_authority_unavailable'));
    const cap=createModelStepCapability(selected,proof,new Date(Date.now()+4000).toISOString(),async()=>{checked++;throw Error('PRIVATE DENIED');});
    await assert.rejects(host.dispatch(cap,context()),fault('execution_authority_unavailable'));
    assert.equal(checked,1);assert.equal(calls.length,1);assert.equal(readModelStepCapability(cap).consumed,true);
    await assert.rejects(host.dispatch(cap,context()),fault('execution_authority_unavailable'));
  });
});

test('runner calls claim/context/dispatch/record/finalize once and a receipt replay never remints or sends',async()=>{
  await fixture(async({host,calls})=>{
    const selected=binding(),proof=await host.verify(selected),order:string[]=[];
    let current=ModelStepMetadataSchema.parse({stepId:selected.stepId,attemptId:selected.attemptId,attemptNumber:1,runId:selected.runId,workId:selected.workId,inputWorkVersion:'1',approvalId:selected.approvalId,state:'reserved',aggregateVersion:'1',activatedRunVersion:'2',taskLeaseEpoch:'2',controlEpoch:'1',selection:selected.selection,evidenceOrigin:'synthetic_local_fixture',expiresAt:expiry(),usageStatus:'not_dispatched',costStatus:'unknown',operational_authority:false});
    let cap:OpaqueModelStepCapability|null=null;
    const service:ModelStepRunnerService={
      async begin(){order.push('begin');if(cap)return {metadata:current,capability:null};current=transitionModelStep(current,'begin');cap=createModelStepCapability(selected,proof,new Date(Date.now()+4000).toISOString(),async()=>{order.push('beforeDispatch');});return {metadata:current,capability:cap};},
      async context(){order.push('context');return context();},
      async record(_actor,capability,observation){order.push('record');assert.equal(readModelObservation(observation,capability).text,'Synthetic draft.');current=transitionModelStep(current,'observe');return current;},
      async unknown(){order.push('unknown');current=transitionModelStep(current,'unknown');return current;},
      async read(){order.push('read');return current;},
    };
    const finalizer={async finalize(_actor:Actor,input:{key:string;stepId:string;expectedVersion:string},observation:OpaqueModelObservation){order.push('finalize');assert.equal(input.key,selected.intentId);assert.equal(input.expectedVersion,'3');await assertModelObservationCurrent(observation);current=transitionModelStep(current,'finalize');return {fixtureOnly:true,operational_authority:false as const};}};
    const runner=createModelStepRunner({service,host,resultFinalizer:finalizer});
    const input={key:'synthetic_begin',stepId:selected.stepId,expectedVersion:'1'};const actor={} as Actor;
    const completed=await runner.execute(actor,input);assert.equal(completed.metadata.state,'succeeded');assert.equal(calls.length,2);
    assert.deepEqual(order,['begin','context','beforeDispatch','record','finalize','read']);
    const replay=await runner.execute(actor,input);assert.equal(replay.result,null);assert.equal(replay.metadata.state,'succeeded');assert.equal(calls.length,2);assert.equal(order.at(-1),'begin');
  });
});

test('generated v2 structural schemas are deterministic and preserve Python JSON Schema/Zod CAS and strict-field parity',()=>{
  const check=spawnSync(process.execPath,['--import','tsx','modules/agent-execution/generate-model-step.ts','--check'],{cwd:projectRoot,env:verificationEnvironment(),encoding:'utf8',timeout:30000,maxBuffer:128*1024});
  assert.equal(check.status,0,check.stdout+check.stderr);
  const id=randomUUID();const profiles=[
    ['model-step-approval-create',ApprovalCreateSchema,{key:'synthetic_key',runId:id,grantId:id,expectedRunVersion:'1',expectedGrantVersion:'1',expectedWorkVersion:'1',consent:true,maxOutputTokens:8}],
    ['model-step-approval-read',ApprovalReadSchema,{approvalId:id}],['model-step-approval-revoke',ApprovalRevokeSchema,{key:'synthetic_key',approvalId:id,expectedVersion:'1'}],
    ['model-step-activate',ActivateSchema,{key:'synthetic_key',approvalId:id,expectedApprovalVersion:'1',expectedRunVersion:'1'}],
    ['model-step-begin',BeginSchema,{key:'synthetic_key',stepId:id,expectedVersion:'1'}],['model-step-read',ReadSchema,{stepId:id}],
    ['model-step-control',ControlSchema,{key:'synthetic_key',stepId:id,expectedVersion:'1',action:'pause'}],
    ['model-step-binding',ModelStepBindingSchema,binding()],
    ['model-step-approval-metadata',ModelStepApprovalMetadataSchema,{approvalId:id,runId:id,workId:id,grantId:id,inputWorkVersion:'1',selection:binding().selection,exportPolicyRevision:'1',maxOutputTokens:8,contextSha256:'a'.repeat(64),inputByteSize:80,aggregateVersion:'1',state:'active',issuedAt:expiry(),expiresAt:expiry(),operational_authority:false}],
    ['model-step-metadata',ModelStepMetadataSchema,{stepId:id,attemptId:id,attemptNumber:1,runId:id,workId:id,inputWorkVersion:'1',approvalId:id,state:'reserved',aggregateVersion:'1',activatedRunVersion:'2',taskLeaseEpoch:'2',controlEpoch:'1',selection:binding().selection,evidenceOrigin:'synthetic_local_fixture',expiresAt:expiry(),usageStatus:'not_dispatched',costStatus:'unknown',operational_authority:false}],
  ] as const;
  const payload=[];
  for(const[name,schema,value]of profiles){
    const cases:{name:string;value:unknown;valid:boolean}[]=[{name:'minimal',value,valid:true}];
    for(const field of Object.keys(value)){const copy={...value};delete (copy as Record<string,unknown>)[field];cases.push({name:`missing ${field}`,value:copy,valid:false});}
    for(const field of ['ready','owner','credential','capability','evidenceOrigin','beforeDispatch','ttl','operational_authority'])cases.push({name:`unknown or invalid ${field}`,value:{...value,[field]:true},valid:false});
    for(const field of Object.keys(value).filter(k=>k.includes('Version')||k.includes('Epoch'))){
      for(const version of ['1','9223372036854775807'])cases.push({name:`valid ${field} ${version}`,value:{...value,[field]:version},valid:true});
      for(const version of ['0','01','1\n','9223372036854775808',1])cases.push({name:`invalid ${field} ${version}`,value:{...value,[field]:version},valid:false});
    }
    for(const item of cases)assert.equal(schema.safeParse(item.value).success,item.valid,`${name}: ${item.name}`);
    payload.push({schema:JSON.parse(readFileSync(new URL(`../../contracts/execution/v2/${name}.schema.json`,import.meta.url),'utf8')),cases});
  }
  const script="import json,sys\nfrom jsonschema import Draft202012Validator,FormatChecker\nfor profile in json.load(sys.stdin):\n Draft202012Validator.check_schema(profile['schema'])\n validator=Draft202012Validator(profile['schema'],format_checker=FormatChecker())\n for case in profile['cases']:\n  assert validator.is_valid(case['value']) == case['valid'],case['name']\nprint('conformant')";
  const result=spawnSync('python3',['-c',script],{cwd:projectRoot,env:verificationEnvironment(),input:JSON.stringify(payload),encoding:'utf8',timeout:30000,maxBuffer:128*1024});
  assert.equal(result.status,0,result.stdout+result.stderr);assert.equal(result.stdout.trim(),'conformant');
});
