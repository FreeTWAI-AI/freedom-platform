import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClaudeSubscriptionAdapter } from '../../modules/agent-execution/adapters/claude.js';
import { createCodexSubscriptionAdapter } from '../../modules/agent-execution/adapters/codex.js';
import { createByokTextAdapter } from '../../modules/agent-execution/adapters/byok.js';
import { AdapterFault, type CliObservation, type CliProbe } from '../../modules/agent-execution/adapters/common.js';

// Independent synthetic protocol vectors. No installed CLI, auth, provider
// connection or secret is accessed, and no test proves genuine model readiness.
const encode=(value:unknown)=>new TextEncoder().encode(typeof value==='string'?value:JSON.stringify(value));
const obs=(value:unknown):CliObservation=>({exitCode:0,signal:null,stdout:encode(value),stderr:encode('PRIVATE_SYNTHETIC_ACCOUNT_DIAGNOSTIC')});
const probe:CliProbe={async probe(){throw new Error('must not call CLI');}};
const claude=createClaudeSubscriptionAdapter({artifact:{executable:'/synthetic/claude',version:'2.1.288',sha256:'0298068b686e7fdbaf9402a7a587bb7f49c0b0e084de09f69145a0719207640c'},probe});
const codex=createCodexSubscriptionAdapter({artifact:{executable:'/synthetic/codex',version:'0.160.0',sha256:'12eb3e81114588aca3b7998f4f19e8997b056aca08e57a7ca7c8a3ec8c652aad'},probe});
const byok=createByokTextAdapter();
const input=(provider='anthropic',custody='official_cli')=>({selection:{providerRef:provider,modelRef:provider==='anthropic'?'claude-synthetic-1':'gpt-synthetic-1',processingLocation:'provider_remote',artifactCustody:'runtime_local',credentialCustody:custody,engineLocation:'runtime_local',billingSource:custody==='official_cli'?'user_cli':'user_byok'},prompt:'Independent synthetic bounded input.',maxOutputTokens:20});
function denied(action:()=>unknown){assert.throws(action,(error:unknown)=>error instanceof AdapterFault&&!error.message.includes('PRIVATE'));}
const claudeResult=()=>({type:'result',subtype:'success',is_error:false,result:'Independent synthetic result',num_turns:1,permission_denials:[],stop_reason:'end_turn',modelUsage:{'claude-synthetic-1':{inputTokens:3,outputTokens:4,cacheReadInputTokens:0,cacheCreationInputTokens:0,webSearchRequests:0,costUSD:0.0007,contextWindow:1000,maxOutputTokens:20}}});
const codexEvents=()=>[{type:'thread.started',thread_id:'synthetic-thread'},{type:'turn.started'},{type:'item.completed',item:{id:'final',type:'agent_message',text:'Independent synthetic result'}},{type:'turn.completed',usage:{input_tokens:3,output_tokens:4,cached_input_tokens:0}}];
const lines=(events:unknown[])=>events.map(v=>JSON.stringify(v)).join('\n')+'\n';
const openaiResult=()=>({id:'resp_synthetic',object:'response',model:'gpt-synthetic-1',status:'completed',output:[{id:'msg_synthetic',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Independent synthetic result',annotations:[]}]}],usage:{input_tokens:3,output_tokens:4,total_tokens:7}});
const anthropicResult=()=>({id:'msg_synthetic',type:'message',model:'claude-synthetic-1',role:'assistant',content:[{type:'text',text:'Independent synthetic result'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:3,output_tokens:4}});
const http=(value:unknown)=>({status:200,headers:{'Content-Type':'application/json'},body:encode(value)});

test('IND-01 each independent minimal protocol vector stays private, unverified and authority false',()=>{
  for(const value of [claude.decode(obs(claudeResult()),input()),codex.decode(obs(lines(codexEvents())),input('openai')),byok.decode(http(openaiResult()),input('openai','local_keychain')),byok.decode(http(anthropicResult()),input('anthropic','local_keychain'))]){
    assert.equal(value.operational_authority,false);assert.equal(value.evidence,'unverified_provider_output');assert(!JSON.stringify(value).includes('PRIVATE'));
  }
});
for(const patch of [{num_turns:2},{num_turns:0},{permission_denials:[{tool_name:'Bash',tool_use_id:'a',tool_input:{command:'PRIVATE_COMMAND'}}]},{tool_calls:[{name:'Bash'}]},{tools:['Read']},{stop_reason:'tool_use'},{structured_output:{model:'claude-other-1',tools:['Bash']}},{fallback_model:'claude-other-1'},{errors:['PRIVATE_TOOL_ERROR']}])test(`IND-02 Claude rejects incompatible final metadata ${Object.keys(patch)[0]} ${JSON.stringify(patch)}`,()=>{
  denied(()=>claude.decode(obs({...claudeResult(),...patch}),input()));
});
for(const patch of [{webSearchRequests:1},{tools:['Read']},{model:'claude-other-1'},{nested_model_usage:{'claude-other-1':{inputTokens:1,outputTokens:1}}}])test(`IND-03 Claude model usage rejects tool/hidden-model counters ${Object.keys(patch)[0]}`,()=>{
  const result=claudeResult();Object.assign(result.modelUsage['claude-synthetic-1'],patch);denied(()=>claude.decode(obs(result),input()));
});
for(const location of ['event','item','usage'] as const)test(`IND-04 Codex rejects hidden tool evidence in ${location}`,()=>{
  const events=codexEvents() as Record<string,unknown>[];
  if(location==='event')events[1].tools=['Bash'];
  if(location==='item')(events[2].item as Record<string,unknown>).tool_calls=[{name:'Bash'}];
  if(location==='usage')(events[3].usage as Record<string,unknown>).web_search_requests=1;
  denied(()=>codex.decode(obs(lines(events)),input('openai')));
});
test('IND-05 Codex rejects unfinished/orphan/switching item lifecycle at final completion',()=>{
  const base=codexEvents();
  const unfinished=[base[0],base[1],{type:'item.started',item:{id:'pending',type:'reasoning',text:''}},base[2],base[3]];
  const orphan=[base[0],base[1],{type:'item.updated',item:{id:'unstarted',type:'reasoning',text:'x'}},base[2],base[3]];
  const switched=[base[0],base[1],{type:'item.started',item:{id:'final',type:'reasoning',text:''}},base[2],base[3]];
  for(const events of [unfinished,orphan,switched])denied(()=>codex.decode(obs(lines(events)),input('openai')));
});
test('IND-06 Codex reasoning records cannot hide command execution or a second model',()=>{
  const base=codexEvents();for(const patch of [{command:'PRIVATE_COMMAND'},{tool_calls:[{name:'Read'}]},{model:'gpt-other-1'}])denied(()=>codex.decode(obs(lines([base[0],base[1],{type:'item.completed',item:{id:'r',type:'reasoning',text:'x',...patch}},base[2],base[3]])),input('openai')));
});
test('IND-07 BYOK OpenAI accepted metadata fields cannot conceal tool/model evidence',()=>{
  for(const patch of [{reasoning:{tool_calls:[{name:'Bash'}]}},{text:{model:'gpt-other-1'}},{metadata:{tool_calls:[{name:'Read'}]}}])denied(()=>byok.decode(http({...openaiResult(),...patch}),input('openai','local_keychain')));
});
test('IND-08 shared numeric grammar does not round fractional token usage into valid integers',()=>{
  const variants=['3.0000000000000001','3.9999999999999999'];
  for(const value of variants){
    denied(()=>claude.decode(obs(JSON.stringify(claudeResult()).replace('"inputTokens":3','"inputTokens":'+value)),input()));
    denied(()=>codex.decode(obs(lines(codexEvents()).replace('"input_tokens":3','"input_tokens":'+value)),input('openai')));
    denied(()=>byok.decode(http(JSON.stringify(openaiResult()).replace('"input_tokens":3','"input_tokens":'+value)),input('openai','local_keychain')));
  }
});
test('IND-09 all codecs reject nonzero or unknown final outcomes and never leak raw private diagnostics',()=>{
  for(const adapter of [claude,codex])for(const exitCode of [null,1])denied(()=>adapter.decode({...obs('PRIVATE_BAD_BODY'),exitCode,signal:exitCode===null?'SIGTERM':null},input(adapter===claude?'anthropic':'openai')));
  for(const status of [302,401,403,429,500])denied(()=>byok.decode({...http('PRIVATE_BAD_BODY'),status},input('openai','local_keychain')));
});
test('IND-10 all codecs reject observation/input getters and cannot mutate caller input',()=>{
  let getters=0;
  for(const [adapter,request,observed] of [[claude,input(),obs(claudeResult())],[codex,input('openai'),obs(lines(codexEvents()))]] as const){
    const raw=Object.defineProperty({...observed},'stdout',{enumerable:true,get(){getters++;return observed.stdout;}});denied(()=>adapter.decode(raw,request));
    const poisoned=Object.defineProperty({...request},'prompt',{enumerable:true,get(){getters++;return'PRIVATE';}});denied(()=>adapter.prepare(poisoned));
    const before=JSON.stringify(request);adapter.prepare(request);assert.equal(JSON.stringify(request),before);assert(!Object.isFrozen(request));
  }
  const request=input('openai','local_keychain'),observed=http(openaiResult());denied(()=>byok.decode(Object.defineProperty({...observed},'body',{enumerable:true,get(){getters++;return observed.body;}}),request));assert.equal(getters,0);
});
test('IND-11 absent optional Claude lifecycle metadata stays an unverified codec observation',()=>{
  const result:Record<string,unknown>=claudeResult();delete result.num_turns;delete result.permission_denials;delete result.stop_reason;
  assert.equal(claude.decode(obs(result),input()).operational_authority,false);
  assert.equal(claude.decode(obs({...result,stop_reason:null}),input()).evidence,'unverified_provider_output');
});
test('IND-12 Claude aggregate usage cannot conceal server tools or additional models',()=>{
  for(const patch of [{server_tool_use:{web_search_requests:1,web_fetch_requests:0}},{models:{'claude-other-1':{input_tokens:1,output_tokens:1}}}])
    denied(()=>claude.decode(obs({...claudeResult(),usage:{input_tokens:3,output_tokens:4,...patch}}),input()));
});
