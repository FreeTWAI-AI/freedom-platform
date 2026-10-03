import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createByokTextAdapter, type ByokObservation } from '../../modules/agent-execution/adapters/byok.js';
import { AdapterFault } from '../../modules/agent-execution/adapters/common.js';

const adapter = createByokTextAdapter(), encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
function input(providerRef = 'openai', custody = 'local_keychain') {
  return { selection: { providerRef, modelRef: providerRef === 'openai' ? 'synthetic-openai-model' : 'synthetic-anthropic-model',
    processingLocation: 'provider_remote', artifactCustody: 'runtime_local', credentialCustody: custody,
    engineLocation: custody === 'platform_vault' ? 'platform' : 'runtime_local', billingSource: 'user_byok' },
    prompt: 'Synthetic private text only. No real provider request.', maxOutputTokens: 20 };
}
function openai(model = input().selection.modelRef) {
  return { id: 'resp_synthetic', object: 'response', model, status: 'completed', error: null, incomplete_details: null,
    output: [{ id: 'msg_synthetic', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'Synthetic decoded draft.', annotations: [], logprobs: [] }] }],
    usage: { input_tokens: 7, output_tokens: 5, total_tokens: 12,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    tools: [], tool_choice: 'none', parallel_tool_calls: false, store: false, background: false,
    previous_response_id: null, conversation: null, temperature: 0.7 };
}
function anthropic(model = input('anthropic').selection.modelRef) {
  return { id: 'msg_synthetic', type: 'message', model, role: 'assistant',
    content: [{ type: 'text', text: 'Synthetic decoded draft.', citations: [] }], stop_reason: 'end_turn', stop_sequence: null,
    stop_details: null, usage: { input_tokens: 7, output_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 3,
      cache_creation: { ephemeral_1h_input_tokens: 1, ephemeral_5m_input_tokens: 1 },
      output_tokens_details: { thinking_tokens: 0 }, server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 } } };
}
function observed(value: unknown, headers = { 'Content-Type': 'application/json' }): ByokObservation {
  return { status: 200, headers, body: encode(value) };
}
function denied(action: () => unknown, code?: string) {
  assert.throws(action, (error: unknown) => error instanceof AdapterFault && (!code || error.code === code)
    && !error.message.includes('synthetic-secret') && !error.message.includes('Synthetic decoded draft.'));
}

test('BYOK explicit providers and both custodians produce credential-free fixed text plans; no observation mints authentication', async () => {
  for (const provider of ['openai','anthropic']) for (const custody of ['local_keychain','platform_vault']) {
    const raw = input(provider,custody), plan = adapter.prepare(raw), assessment = adapter.inspect(raw);
    assert.equal(assessment.route,'byok'); assert.equal(assessment.support,'candidate_only');
    assert.equal(assessment.authentication,'unavailable'); assert.equal(assessment.operational_authority,false);
    assert.ok(assessment.blockers.includes('authentication_unavailable'));
    assert.ok(assessment.blockers.includes('execution_authority_unavailable'));
    assert.equal(plan.endpoint,provider === 'openai' ? 'https://api.openai.com/v1/responses' : 'https://api.anthropic.com/v1/messages');
    assert.equal(plan.method,'POST'); assert.equal(plan.credentialCustody,custody);
    assert.equal(plan.engineLocation,raw.selection.engineLocation); assert.equal(plan.billingSource,'user_byok');
    assert.equal(plan.operational_authority,false); assert.equal(new Headers(plan.headers).get('Authorization'),null);
    assert.equal(new Headers(plan.headers).get('X-Api-Key'),null); assert.ok(Object.isFrozen(plan));
    const body = JSON.parse(new TextDecoder().decode(plan.body));
    assert.equal(body.model,raw.selection.modelRef); assert.equal(body.stream,false); assert.deepEqual(body.tools,[]);
    assert.ok(!JSON.stringify(body).includes('apiKey')); assert.ok(!Object.hasOwn(body,'fallback'));
    if (provider === 'openai') {
      assert.equal(body.store,false); assert.equal(body.background,false); assert.equal(body.parallel_tool_calls,false);
      assert.equal(body.tool_choice,'none'); assert.equal(body.max_output_tokens,20); assert.equal(body.truncation,'disabled');
      assert.deepEqual(body.input,[{ role:'user',content:[{type:'input_text',text:raw.prompt}] }]);
    } else {
      assert.equal(plan.headers['anthropic-version'],'2023-06-01'); assert.equal(body.max_tokens,20);
      assert.deepEqual(body.tool_choice,{ type:'none' }); assert.deepEqual(body.messages,[{role:'user',content:[{type:'text',text:raw.prompt}]}]);
    }
    const decoded = adapter.decode(observed(provider === 'openai' ? openai() : anthropic()),raw);
    assert.equal(decoded.reportedModelRef,raw.selection.modelRef); assert.equal(decoded.modelRef,raw.selection.modelRef);
    assert.equal(decoded.evidence,'unverified_provider_output'); assert.equal(decoded.operational_authority,false);
    assert.equal(adapter.inspect(raw).authentication,'unavailable');
    await assert.rejects(adapter.invoke(raw),(e: unknown) => e instanceof AdapterFault && e.code === 'execution_authority_unavailable');
  }
});

test('BYOK no model/provider/custody defaults, unsupported locations and caller transport/key/tool hooks are rejected', () => {
  for (const key of ['providerRef','modelRef','processingLocation','credentialCustody','engineLocation','billingSource','artifactCustody']) {
    const raw = input(); delete (raw.selection as Record<string,unknown>)[key]; denied(() => adapter.prepare(raw));
    assert.equal(adapter.inspect(raw).support,'unsupported');
  }
  for (const extra of [{url:'http://127.0.0.1/secret'},{apiKey:'synthetic-secret'},{tools:[]},{fallback:'anthropic'},
    {fetch:() => {throw new Error('must not run');}},{modelReady:true},{permit:{operational_authority:true}}]) denied(() => adapter.prepare({...input(),...extra}));
  for (const providerRef of ['OpenAI','openai-compatible','grok']) denied(() => adapter.prepare(input(providerRef)),'unsupported_selection');
  denied(() => adapter.prepare(input('https://api.openai.com')),'invalid_input');
  denied(() => adapter.prepare({...input(),selection:{...input().selection,processingLocation:'runtime_local'}}),'unsupported_selection');
  denied(() => adapter.prepare({...input(),selection:{...input().selection,credentialCustody:'official_cli',billingSource:'user_cli'}}),'unsupported_selection');
  denied(() => adapter.prepare({...input(),selection:{...input().selection,credentialCustody:'platform_vault',engineLocation:'runtime_local'}}));
});

test('BYOK bounded prompt/tokens and descriptor-safe inputs cannot invoke getters or credential hooks', () => {
  for (const prompt of ['', '\ud800','\0','中'.repeat(5462), 'x'.repeat(16385)]) denied(() => adapter.prepare({...input(),prompt}));
  for (const maxOutputTokens of [undefined,0,-1,1.5,4097,Number.MAX_SAFE_INTEGER,'20']) denied(() => adapter.prepare({...input(),maxOutputTokens}));
  assert.equal(adapter.prepare({...input(),prompt:'x'.repeat(16384),maxOutputTokens:4096}).operational_authority,false);
  let reads = 0; const raw = { ...input(), get url() { reads++; return 'https://evil.invalid'; } };
  denied(() => adapter.prepare(raw)); assert.equal(reads,0);
  const cyclic: Record<string,unknown> = {...input()}; cyclic.loop = cyclic; denied(() => adapter.prepare(cyclic));
});

test('BYOK official text envelopes preserve precise usage including Anthropic input cache tokens', () => {
  const a = adapter.decode(observed(openai()),input()), b = adapter.decode(observed(anthropic()),input('anthropic'));
  assert.deepEqual(a.usage,{inputTokens:7,outputTokens:5,totalTokens:12});
  assert.deepEqual(b.usage,{inputTokens:12,outputTokens:5,totalTokens:17});
  assert.equal(a.text,'Synthetic decoded draft.'); assert.ok(Object.isFrozen(a.usage)); assert.ok(Object.isFrozen(a));
});

test('BYOK response model mismatch and alias substitution fail even with a valid final and usage', () => {
  for (const provider of ['openai','anthropic']) {
    const value = provider === 'openai' ? openai('another-snapshot') : anthropic('another-snapshot');
    denied(() => adapter.decode(observed(value),input(provider)),'model_mismatch');
  }
});

test('BYOK missing, unknown, noninteger, unsafe, inconsistent or over-budget usage cannot produce text evidence', () => {
  for (const usage of [null,{}, {...openai().usage,output_tokens:null},{...openai().usage,input_tokens:1.5},
    {...openai().usage,input_tokens:9007199254740992},{...openai().usage,input_tokens:-1},{...openai().usage,output_tokens:0,total_tokens:7},
    {...openai().usage,total_tokens:11},{...openai().usage,output_tokens:21,total_tokens:28},
    {...openai().usage,billingConfirmed:true},{...openai().usage,input_tokens_details:{cached_tokens:8}},
    {...openai().usage,output_tokens_details:{reasoning_tokens:6}}]) denied(() => adapter.decode(observed({...openai(),usage}),input()));
  for (const usage of [{...anthropic().usage,output_tokens:21},{...anthropic().usage,input_tokens:-1},
    {...anthropic().usage,cache_creation_input_tokens:3},{...anthropic().usage,server_tool_use:{web_fetch_requests:1,web_search_requests:0}},
    {...anthropic().usage,output_tokens_details:{thinking_tokens:1}},{...anthropic().usage,unverifiedCost:4}])
    denied(() => adapter.decode(observed({...anthropic(),usage}),input('anthropic')));
});

test('BYOK OpenAI incomplete, mixed outputs, multiple finals, tool calls and forged readiness never become a final', () => {
  const base = openai();
  for (const change of [{status:'incomplete'},{status:'in_progress'},{error:{message:'synthetic-secret'}},
    {output:[]},{output:[...base.output,...base.output]},{output:[{type:'function_call',name:'evil'},...base.output]},
    {output:[{...base.output[0],status:'incomplete'}]}, {output:[{...base.output[0],role:'user'}]},
    {output:[{...base.output[0],content:[{type:'refusal',refusal:'no'}]}]},
    {output_text:'different final'}, {tools:[{type:'web_search'}]}, {tool_choice:'auto'}, {store:true},
    {previous_response_id:'resp_other'},{conversation:{id:'another'}},{modelReady:true},{operational_authority:true}])
    denied(() => adapter.decode(observed({...base,...change}),input()));
  for (const change of [{reasoning:{tool_calls:[{name:'Bash'}]}},{text:{model:'another-model'}},{metadata:{tool_calls:[{name:'Read'}]}},
    {prompt_cache_options:{mode:'implicit',ttl:'30m',model:'another-model'}}]) denied(() => adapter.decode(observed({...base,...change}),input()));
  const normal = {...base,reasoning:{effort:null,summary:null,context:null},text:{format:{type:'text'}},metadata:{},created_at:1,completed_at:2};
  assert.equal(adapter.decode(observed(normal),input()).text,'Synthetic decoded draft.');
});

test('BYOK Anthropic truncation, refusal, pause/tool/thinking blocks, citations and unknown content fail closed', () => {
  const base = anthropic();
  for (const stop_reason of ['max_tokens','refusal','pause_turn','tool_use','stop_sequence',null])
    denied(() => adapter.decode(observed({...base,stop_reason}),input('anthropic')));
  for (const content of [[],[...base.content,...base.content],[{type:'tool_use',id:'x',name:'evil',input:{}}],
    [{type:'thinking',thinking:'secret'}],[{type:'text',text:'text',citations:[{url:'https://evil.invalid'}]}]])
    denied(() => adapter.decode(observed({...base,content}),input('anthropic')));
  denied(() => adapter.decode(observed({...base,stop_details:{type:'refusal'}}),input('anthropic')));
});

test('BYOK hostile HTTP status, redirects, encoding, media type, malformed length and excess bytes are safe failures', () => {
  for (const status of [201,301,302,307,400,401,403,429,500,503]) denied(() => adapter.decode({...observed(openai()),status},input()));
  for (const headers of [{'Content-Type':'text/event-stream'},{'Content-Type':'text/html'},{'Content-Type':'application/json','Location':'https://evil.invalid'},
    {'Content-Type':'application/json','Content-Encoding':'gzip'}, {'Content-Type':'application/json','Content-Length':'0'},
    {'Content-Type':'application/json','Content-Length':'1e3'},{'Content-Type':'application/json','content-type':'text/html'}])
    denied(() => adapter.decode(observed(openai(),headers),input()));
  denied(() => adapter.decode({...observed(openai()),body:new Uint8Array(32769)},input()),'response_limit');
  const observedGetter = {...observed(openai()),get status(): number {throw new Error('synthetic-secret');}};
  denied(() => adapter.decode(observedGetter,input()));
});

test('BYOK strict UTF8/JSON rejects duplicates at every depth, BOM, surrogate, concatenation and authority smuggling', () => {
  const good = JSON.stringify(openai());
  const mutations = [good.replace('"model":','"model":"forged","mo\\u0064el":'),
    good.replace('"input_tokens":7','"input_tokens":7,"input_tokens":8'), '\ufeff'+good,good+good,
    good.replace('Synthetic decoded draft.','\\ud800'), good.replace('"id":"resp_synthetic"','"__proto__":{},"id":"resp_synthetic"'),
    '{"nested":'+ '['.repeat(25)+'0'+']'.repeat(25)+'}', '[0,'+'0,'.repeat(4096)+'0]'];
  for (const text of mutations) denied(() => adapter.decode({...observed(openai()),body:new TextEncoder().encode(text)},input()));
  denied(() => adapter.decode({...observed(openai()),body:new Uint8Array([0xc3,0x28])},input()));
  const over = openai(); over.output[0].content[0].text = '中'.repeat(5462); denied(() => adapter.decode(observed(over),input()));
  const blank = openai(); blank.output[0].content[0].text = ' \n\t'; denied(() => adapter.decode(observed(blank),input()));
});

test('BYOK fractional usage cannot round into an apparently valid integer token count', () => {
  for (const wire of ['7.0000000000000001','7.0000000000000001e0']) {
    const raw = JSON.stringify(openai()).replace('"input_tokens":7','"input_tokens":'+wire);
    denied(() => adapter.decode({...observed(openai()),body:new TextEncoder().encode(raw)},input()));
  }
});

test('BYOK synthetic local HTTP verifies both codecs and headers without reading a key or calling either provider', async () => {
  const syntheticCredential = 'synthetic-byok-fixture-not-a-real-key', requests: {path:string;headers:Record<string,unknown>;body:unknown}[] = [];
  const server = createServer(async (request,response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({path:request.url!,headers:request.headers,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))});
    response.writeHead(200,{'Content-Type':'application/json'});
    response.end(JSON.stringify(request.url === '/v1/responses' ? openai() : anthropic()));
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    for (const provider of ['openai','anthropic']) {
      const raw = input(provider), plan = adapter.prepare(raw), url = new URL(plan.endpoint), headers = new Headers(plan.headers);
      headers.set(provider === 'openai' ? 'Authorization' : 'X-Api-Key',provider === 'openai' ? 'Bearer '+syntheticCredential : syntheticCredential);
      // The private test harness sends the credential-free plan only to this
      // controlled loopback listener. No production adapter can dispatch it.
      const response = await fetch(`http://127.0.0.1:${address.port}${url.pathname}`,{method:plan.method,headers,body:Buffer.from(plan.body),redirect:'manual'});
      const decoded = adapter.decode({status:response.status,headers:Object.fromEntries(response.headers),body:new Uint8Array(await response.arrayBuffer())},raw);
      assert.equal(decoded.evidence,'unverified_provider_output'); assert.equal(decoded.operational_authority,false);
      assert.ok(!JSON.stringify(decoded).includes(syntheticCredential));
      assert.equal(adapter.inspect(raw).authentication,'unavailable');
    }
    assert.deepEqual(requests.map(r=>r.path),['/v1/responses','/v1/messages']);
    assert.equal(requests[0].headers.authorization,'Bearer '+syntheticCredential); assert.equal(requests[1].headers['x-api-key'],syntheticCredential);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())); }
});
