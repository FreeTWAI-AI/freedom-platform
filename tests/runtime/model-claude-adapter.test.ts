import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClaudeSubscriptionAdapter } from '../../modules/agent-execution/adapters/claude.js';
import { AdapterFault, type CliArtifact, type CliObservation, type CliProbe } from '../../modules/agent-execution/adapters/common.js';
import type { ModelSelection } from '../../contracts/execution/v1/member-execution.js';

const artifact:CliArtifact={executable:'/synthetic/claude',version:'2.1.288',sha256:'0298068b686e7fdbaf9402a7a587bb7f49c0b0e084de09f69145a0719207640c'};
const selection:ModelSelection={providerRef:'anthropic',modelRef:'claude-synthetic-1',processingLocation:'provider_remote',artifactCustody:'runtime_local',credentialCustody:'official_cli',engineLocation:'runtime_local',billingSource:'user_cli'};
const input={selection,prompt:'SYNTHETIC PRIVATE INPUT $() --fallback-model haiku',maxOutputTokens:64};
const bytes=(v:unknown)=>new TextEncoder().encode(typeof v==='string'?v:JSON.stringify(v));
const observed=(v:unknown,exitCode:number|null=0,signal:string|null=null):CliObservation=>({stdout:bytes(v),stderr:bytes('SYNTHETIC PRIVATE STDERR'),exitCode,signal});
const help='--restricted --safe-mode --tools --strict-mcp-config --permission-prompts --no-session-persistence';
function fixture(status:unknown={loggedIn:false,authMethod:'none'},overrides:Partial<Record<'version'|'help'|'auth_status',CliObservation>>={}) {
  const calls:string[]=[];
  const probe:CliProbe={probe:async operation=>{calls.push(operation);return overrides[operation]??(operation==='version'?observed('2.1.288 (Claude Code)\n'):operation==='help'?observed(help):observed(status,(status as {loggedIn:boolean}).loggedIn?0:1));}};
  return {adapter:createClaudeSubscriptionAdapter({artifact,probe}),probe,calls};
}
const fault=(code:string)=>(error:unknown)=>error instanceof AdapterFault&&error.code===code&&!error.message.includes('PRIVATE');
function result(overrides:Record<string,unknown>={}) {return {type:'result',subtype:'success',is_error:false,result:'Synthetic bounded draft',num_turns:1,permission_denials:[],stop_reason:'end_turn',modelUsage:{'claude-synthetic-1':{inputTokens:12,outputTokens:7,costUSD:0.00042,cacheReadInputTokens:3}},session_id:'PRIVATE_SESSION_DO_NOT_EXPORT',...overrides};}

test('CLAUDE-01 explicit pinned profile prepares stdin-only bounded tool-free candidate; no CLI call or readiness',()=>{
  const {adapter,calls}=fixture(),plan=adapter.prepare(input);assert.deepEqual(calls,[]);
  assert(Object.isFrozen(plan));assert(Object.isFrozen(plan.argv));assert(Object.isFrozen(plan.environment));
  assert.equal(new TextDecoder().decode(plan.stdin),input.prompt);assert(!plan.argv.includes(input.prompt));assert.equal(plan.kind,'cli_text_candidate');
  assert.equal(plan.argv[plan.argv.indexOf('--model')+1],selection.modelRef);assert.equal(plan.argv[plan.argv.indexOf('--tools')+1],'');
  assert.equal(plan.argv[plan.argv.indexOf('--disallowedTools')+1],'*');assert.equal(plan.argv[plan.argv.indexOf('--mcp-config')+1],'{"mcpServers":{}}');
  const settings=JSON.parse(plan.argv[plan.argv.indexOf('--settings')+1]);assert.deepEqual(settings.availableModels,[selection.modelRef]);assert.deepEqual(settings.fallbackModel,[]);assert.equal(settings.disableAllHooks,true);assert.equal(settings.switchModelsOnFlag,false);
  for(const flag of ['--restricted','--safe-mode','--strict-mcp-config','--no-session-persistence','--disable-slash-commands'])assert(plan.argv.includes(flag));
  for(const flag of ['--bare','--fallback-model','--dangerously-skip-permissions','--add-dir','--resume','--debug'])assert(!plan.argv.includes(flag));
  assert.equal(plan.environment.CLAUDE_CODE_MAX_OUTPUT_TOKENS,'64');assert.equal(plan.environment.CLAUDE_CODE_MAX_RETRIES,'0');assert.equal(plan.environment.ANTHROPIC_API_KEY,undefined);
  assert.equal(plan.assessment.support,'unsupported');assert.deepEqual(plan.assessment.blockers,['effective_tool_policy_unavailable']);assert.equal(plan.operational_authority,false);
});
test('CLAUDE-02 subscription-looking local status is sanitized and never authorizes invoke',async()=>{
  const {adapter,calls}=fixture({loggedIn:true,authMethod:'claude.ai',email:'PRIVATE_EMAIL',account:{token:'PRIVATE_TOKEN'},configDirectory:'/PRIVATE/PATH',subscriptionType:'max',modelReady:true});
  const status=await adapter.inspect();assert.deepEqual(calls,['version','help','auth_status']);assert.equal(status.authentication,'local_observed_subscription');assert.equal(status.installedVersion,'2.1.288');assert.equal(status.support,'unsupported');assert.equal(status.operational_authority,false);
  assert(!JSON.stringify(status).includes('PRIVATE'));await assert.rejects(adapter.invoke(input),fault('execution_authority_unavailable'));assert.deepEqual(calls,['version','help','auth_status']);
});
for(const method of ['none','oauth_token','api_key','api_key_helper','third_party'] as const)test(`CLAUDE-03 ${method} cannot attest subscription billing`,async()=>{
  const {adapter}=fixture({loggedIn:method!=='none',authMethod:method,email:'PRIVATE_AUTH_ACCOUNT'});const status=await adapter.inspect();
  assert.equal(status.authentication,['api_key','api_key_helper'].includes(method)?'local_observed_api_key':'unavailable');assert(status.blockers.includes('authentication_unavailable'));assert(status.blockers.includes('effective_tool_policy_unavailable'));assert.equal(status.operational_authority,false);
});
test('CLAUDE-04 mismatched version/digest, malformed path and configuration getters fail before probe',()=>{
  let called=0;const probe:CliProbe={probe:async()=>{called++;return observed('');}};
  for(const change of [{version:'2.1.289'},{sha256:'0'.repeat(64)},{executable:'claude'},{executable:'/synthetic/../claude'},{executable:'/synthetic/claude\0'}])assert.throws(()=>createClaudeSubscriptionAdapter({artifact:{...artifact,...change},probe}));
  let getter=0;const options=Object.defineProperty({artifact,probe},'artifact',{enumerable:true,get(){getter++;return artifact;}});assert.throws(()=>createClaudeSubscriptionAdapter(options),fault('invalid_input'));assert.equal(getter,0);assert.equal(called,0);
  assert.throws(()=>createClaudeSubscriptionAdapter({...{artifact,probe},policyVerified:true} as {artifact:CliArtifact;probe:CliProbe}),fault('invalid_input'));
});
test('CLAUDE-05 wrong version/help, invalid auth status and thrown private diagnostics remain bounded generic failures',async()=>{
  for(const [operation,value] of [['version',observed('PRIVATE_VERSION_HINT')],['help',observed('old flags')],['auth_status',observed('{"loggedIn":true,"loggedIn":false,"authMethod":"claude.ai"}')],['auth_status',observed({loggedIn:true,authMethod:'claude.ai'},1)],['auth_status',observed({loggedIn:true,authMethod:'unknown'})]] as const){
    const status=await fixture(undefined,{[operation]:value}).adapter.inspect();assert.equal(status.support,'unsupported');assert.equal(status.operational_authority,false);assert(!JSON.stringify(status).includes('PRIVATE'));
  }
  const probe:CliProbe={probe:async()=>{throw new Error('PRIVATE_PROVIDER_CREDENTIAL');}};const status=await createClaudeSubscriptionAdapter({artifact,probe}).inspect();assert.deepEqual(status.blockers,['probe_unavailable']);
});
test('CLAUDE-06 explicit selection rejects alias, wrong provider/processing/custody/billing and arbitrary hooks',()=>{
  const {adapter}=fixture();
  for(const change of [{providerRef:'openai'},{modelRef:'sonnet'},{modelRef:'default'},{modelRef:'claude-synthetic-1[1m]'},{processingLocation:'local'},{credentialCustody:'platform_vault',engineLocation:'platform',billingSource:'user_byok'},{credentialCustody:'local_keychain',billingSource:'user_byok'}])assert.throws(()=>adapter.prepare({...input,selection:{...selection,...change}}));
  for(const extra of [{modelReady:true},{argv:['--fallback-model','haiku']},{environment:{ANTHROPIC_API_KEY:'PRIVATE'}},{maxBudgetUsd:1},{effectivePolicy:{tools:[]}}])assert.throws(()=>adapter.prepare({...input,...extra}));
  assert.equal(adapter.prepare({...input,selection:{...selection,artifactCustody:'platform_asset'}}).operational_authority,false);
});
test('CLAUDE-07 prompt/token bounds and own-data snapshot reject getters without running them',()=>{
  const {adapter}=fixture();for(const prompt of ['', 'x'.repeat(16385),'中'.repeat(5462),'\ud800'])assert.throws(()=>adapter.prepare({...input,prompt}));
  for(const maxOutputTokens of [0,4097,1.1,NaN])assert.throws(()=>adapter.prepare({...input,maxOutputTokens}));
  let getter=0;const poisoned=Object.defineProperty({...input},'prompt',{enumerable:true,get(){getter++;return'PRIVATE';}});assert.throws(()=>adapter.prepare(poisoned));assert.equal(getter,0);
});
test('CLAUDE-08 finite decimal CLI metadata decodes only selected text/model/token counters and no Result authority',()=>{
  const {adapter}=fixture(),decoded=adapter.decode(observed(result()),input);
  assert.deepEqual(decoded,{text:'Synthetic bounded draft',modelRef:selection.modelRef,reportedModelRef:selection.modelRef,usage:{inputTokens:12,outputTokens:7,totalTokens:null},evidence:'unverified_provider_output',operational_authority:false});
  assert(Object.isFrozen(decoded));assert(Object.isFrozen(decoded.usage));assert(!JSON.stringify(decoded).includes('PRIVATE'));
});
test('CLAUDE-09 absent/switched/mixed reported models and unknown/malformed usage cannot become successful text',()=>{
  const {adapter}=fixture();
  for(const modelUsage of [{},{'claude-fallback-1':{inputTokens:1,outputTokens:1}},{'claude-synthetic-1':{inputTokens:1,outputTokens:1},'claude-fallback-1':{inputTokens:1,outputTokens:1}}])assert.throws(()=>adapter.decode(observed(result({modelUsage})),input),fault('model_mismatch'));
  for(const value of [null,{},[],{inputTokens:1,outputTokens:-1},{inputTokens:1,outputTokens:1.5},{inputTokens:1,outputTokens:Number.MAX_SAFE_INTEGER+1}])assert.throws(()=>adapter.decode(observed(result({modelUsage:{[selection.modelRef]:value}})),input),fault('invalid_response'));
  assert.throws(()=>adapter.decode(observed(result({modelUsage:{[selection.modelRef]:{inputTokens:1,outputTokens:65}}})),input),fault('response_limit'));
});
test('CLAUDE-10 duplicate/prototype/UTF8/depth/size bounds reject malformed structured stdout',()=>{
  const {adapter}=fixture();
  for(const raw of ['{"type":"result","type":"result"}', '{"__proto__":{}}','{"x":"\ud800"}','{"x":1e999}', '{"x":'+ '['.repeat(25)+'0'+']'.repeat(25)+'}', '\ufeff'+JSON.stringify(result()),JSON.stringify(result()).replace('"inputTokens":12','"inputTokens":12,"input\\u0054okens":1')])assert.throws(()=>adapter.decode(observed(raw),input));
  assert.throws(()=>adapter.decode({...observed(result()),stdout:new Uint8Array([0xc3,0x28])},input));
  assert.throws(()=>adapter.decode({...observed(result()),stdout:bytes('x'.repeat(32769))},input),fault('response_limit'));
  assert.throws(()=>adapter.decode(observed(result({result:'x'.repeat(16385)})),input),fault('invalid_response'));
});
test('CLAUDE-11 interrupted/nonzero provider output stays unknown/error without echoing stderr or retrying',()=>{
  const {adapter,calls}=fixture();assert.throws(()=>adapter.decode(observed(result(),null,'SIGKILL'),input),fault('outcome_unknown'));
  assert.throws(()=>adapter.decode(observed(result(),1),input),fault('outcome_unknown'));assert.throws(()=>adapter.decode(observed(result({is_error:true,result:'PRIVATE_TOKEN'})),input),fault('invalid_response'));assert.deepEqual(calls,[]);
});
test('CLAUDE-12 observations and config are snapshots; getters never run and later mutations cannot switch binary/model',()=>{
  const {probe}=fixture(),config={artifact:{...artifact},probe},adapter=createClaudeSubscriptionAdapter(config);config.artifact.version='OTHER';config.artifact.sha256='0'.repeat(64);
  assert.equal(adapter.prepare(input).argv[adapter.prepare(input).argv.indexOf('--model')+1],selection.modelRef);
  let getter=0;const raw=Object.defineProperty(observed(result()),'stdout',{enumerable:true,get(){getter++;return bytes(result());}});assert.throws(()=>adapter.decode(raw,input),fault('invalid_response'));assert.equal(getter,0);
});
