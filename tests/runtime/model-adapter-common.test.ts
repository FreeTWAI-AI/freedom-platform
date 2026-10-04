import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterFault, parseAdapterTextInput, parseModelJson, parseModelJsonLines, copyModelBytes,
  assertOutputText } from '../../modules/agent-execution/adapters/common.js';
import { selectModelAdapterRoute } from '../../modules/agent-execution/adapters/index.js';

const bytes = (text: string) => new TextEncoder().encode(text);
const input = () => ({ selection: { providerRef:'openai',modelRef:'synthetic-model',processingLocation:'provider_remote',
  artifactCustody:'runtime_local',credentialCustody:'local_keychain',engineLocation:'runtime_local',billingSource:'user_byok' },
  prompt:'A synthetic private prompt.',maxOutputTokens:20 });
function denied(operation: () => unknown, code?: string) {
  assert.throws(operation,(error: unknown) => error instanceof AdapterFault && (!code || error.code === code)
    && error.message === 'Model adapter request unavailable.');
}

test('MODEL-COMMON decoded duplicate members and prototype keys are rejected throughout nested provider data', () => {
  for (const wire of ['{"id":1,"id":2}','{"id":1,"i\\u0064":2}','{"metadata":{"usage":1,"usage":2}}',
    '{"outer":[{"__proto__":{}}]}','{"constructor":{}}','{"prototype":{}}','{"\\u005f_proto__":{}}'])
    denied(() => parseModelJson(bytes(wire)),'invalid_response');
});

test('MODEL-COMMON fatal UTF8, BOM, malformed JSON and invalid Unicode fail while supplementary scalar text survives', () => {
  for (const wire of ['\ufeff{}','{"value":"\\ud800"}','{"value":"\\udfff"}','{"value":"\\ud800x"}',
    '{"value":"\0"}','{}{}','{} trailing','{"a":1,}','[1,]','{"a":01}','{"a":+1}','{"a":NaN}','{"a":Infinity}'])
    denied(() => parseModelJson(bytes(wire)),'invalid_response');
  for (const raw of [new Uint8Array([0xc3,0x28]),new Uint8Array([0xed,0xa0,0x80]),new Uint8Array([0xf0,0x80,0x80,0x80]),new Uint8Array([0xff])])
    denied(() => parseModelJson(raw),'invalid_response');
  assert.equal((parseModelJson(bytes('{"value":"🧭","escaped":"\\ud83e\\udded"}')) as Record<string,string>).escaped,'🧭');
});

test('MODEL-COMMON genuine finite metadata fractions and exactly integral safe decimal/exponent values remain usable', () => {
  for (const wire of ['0.7','-0.7','0.0001','1.5e-2','1.1e-20']) assert.equal(parseModelJson(bytes(wire)),Number(wire));
  for (const [wire,value] of [['7.000',7],['7e0',7],['70e-1',7],['700.00e-2',7],['9007199254740991.0',Number.MAX_SAFE_INTEGER],
    ['0e-999999999999999',0],['0.000',0]] as const) assert.equal(parseModelJson(bytes(wire)),value);
});

test('MODEL-COMMON rounding cannot manufacture safe integer token counts or hide nonzero underflow', () => {
  for (const wire of ['7.0000000000000001','7.0000000000000001e0','0.9999999999999999999','9007199254740991.1',
    '1e-999999999999999','1e-324','-1e-324','9007199254740992','9007199254740992.0','9.007199254740992e15','1e99999','-0','-0.0'])
    denied(() => parseModelJson(bytes('{"usage":'+wire+'}')),'invalid_response');
});

test('MODEL-COMMON actual bytes, nesting and member count bound hostile data before a small-looking envelope can escape', () => {
  denied(() => parseModelJson(bytes('"'+'中'.repeat(10923)+'"')),'response_limit');
  denied(() => parseModelJson(bytes('['.repeat(25)+'1'+']'.repeat(25))),'response_limit');
  denied(() => parseModelJson(bytes('['+Array(4097).fill('0').join(',')+']')),'response_limit');
  const full = bytes('"'+'x'.repeat(32766)+'"'); assert.equal(full.byteLength,32768);
  assert.equal((parseModelJson(full) as string).length,32766);
});

test('MODEL-COMMON byte snapshots ignore spoofed lengths, iterators and subclass getters and detach caller mutations', () => {
  let reads = 0;
  class HostileBytes extends Uint8Array {
    get byteLength(): number { reads++; throw new Error('synthetic-secret'); }
    get buffer(): ArrayBuffer { reads++; throw new Error('synthetic-secret'); }
    get byteOffset(): number { reads++; throw new Error('synthetic-secret'); }
    [Symbol.iterator](): ArrayIterator<number> { reads++; throw new Error('synthetic-secret'); }
  }
  const raw = new HostileBytes(bytes('{"ok":true}'));
  const copy = copyModelBytes(raw); assert.equal(reads,0);
  raw.fill(0); assert.equal(new TextDecoder().decode(copy),'{"ok":true}');
  const oversized = new HostileBytes(32769); denied(() => copyModelBytes(oversized),'response_limit'); assert.equal(reads,0);
  const fake = new Uint8Array(32769); Object.defineProperty(fake,'byteLength',{get(){reads++;return 1;}});
  denied(() => copyModelBytes(fake),'response_limit'); assert.equal(reads,0);
});

test('MODEL-COMMON arrays, proxy views, detached storage and invalid binary alternatives never become model bytes', () => {
  for (const raw of [1,[1,2],new ArrayBuffer(8),new DataView(new ArrayBuffer(8)),new Uint16Array(8),
    {length:2,0:123,1:125},new Proxy(new Uint8Array([123,125]),{})]) denied(() => copyModelBytes(raw),'invalid_response');
  const detached = new Uint8Array([123,125]); structuredClone(detached.buffer,{transfer:[detached.buffer]});
  denied(() => copyModelBytes(detached),'invalid_response');
});

test('MODEL-COMMON immutable input snapshots do not invoke getters, freeze callers or retain changed selection/prompt', () => {
  const raw = input(), snapshot = parseAdapterTextInput(raw); raw.selection.modelRef = 'changed'; raw.prompt = 'changed';
  assert.equal(snapshot.selection.modelRef,'synthetic-model'); assert.equal(snapshot.prompt,'A synthetic private prompt.');
  assert.ok(Object.isFrozen(snapshot)); assert.ok(Object.isFrozen(snapshot.selection)); assert.ok(!Object.isFrozen(raw));
  let reads = 0;
  const getter = {...input(),get prompt(): string {reads++;throw new Error('synthetic-secret');}};
  denied(() => parseAdapterTextInput(getter),'invalid_input'); assert.equal(reads,0);
  const nested = input(); Object.defineProperty(nested.selection,'modelRef',{get(){reads++;return 'synthetic-model';},enumerable:true});
  denied(() => parseAdapterTextInput(nested),'invalid_input'); assert.equal(reads,0);
  const cyclic: Record<string,unknown> = {...input()}; cyclic.loop = cyclic; denied(() => parseAdapterTextInput(cyclic),'invalid_input');
  denied(() => parseAdapterTextInput({...input(),[Symbol('modelReady')]:true}),'invalid_input');
  denied(() => parseAdapterTextInput({...input(),toJSON(){reads++;return input();}}),'invalid_input'); assert.equal(reads,0);
});

test('MODEL-COMMON exact input fields, explicit selection, real UTF8 size and integer token caps cannot be widened', () => {
  for (const raw of [{...input(),modelReady:true},{...input(),apiKey:'synthetic-secret'},{...input(),selection:undefined},
    {...input(),selection:{...input().selection,apiKey:'synthetic-secret'}},{...input(),prompt:'中'.repeat(5462)},
    {...input(),prompt:'\ud800'},{...input(),prompt:'\0'},{...input(),prompt:''}]) denied(() => parseAdapterTextInput(raw),'invalid_input');
  for (const maxOutputTokens of [0,-1,4097,1.25,NaN,Infinity,'20',null]) denied(() => parseAdapterTextInput({...input(),maxOutputTokens}),'invalid_input');
  assert.equal(parseAdapterTextInput({...input(),prompt:'x'.repeat(16384),maxOutputTokens:4096}).maxOutputTokens,4096);
});

test('MODEL-COMMON private output text bounds reject null bytes/surrogates and count UTF8 rather than characters', () => {
  for (const text of [null,0,'','\0','\udfff','x'.repeat(16385),'中'.repeat(5462)]) denied(() => assertOutputText(text),'invalid_response');
  assert.equal(assertOutputText('🧭'.repeat(4096)).length,8192);
});

test('MODEL-COMMON NDJSON limits events, individual frames and cumulative bytes, with no partial success on forged later records', () => {
  assert.equal(parseModelJsonLines(bytes('{"a":0.7}\r\n{"b":2}\n')).length,2);
  assert.equal(parseModelJsonLines(bytes(Array(64).fill('{}').join('\n'))).length,64);
  for (const text of [Array(65).fill('{}').join('\n'),'{"ok":1}\n\n','{"ok":1}\n{"k":1,"k":2}',
    '{"ok":1}\n{"value":"\\ud800"}','"'+'x'.repeat(32767)+'"',Array(3).fill('"'+'x'.repeat(22000)+'"').join('\n')])
    denied(() => parseModelJsonLines(bytes(text)));
});

test('MODEL-REGISTRY only explicit remote provider and custody choose a route, without treating selection as authority', () => {
  for (const providerRef of ['openai','anthropic']) {
    const raw = input(); raw.selection.providerRef = providerRef;
    assert.equal(selectModelAdapterRoute(raw),'byok');
    assert.equal(selectModelAdapterRoute({...raw,selection:{...raw.selection,credentialCustody:'platform_vault',engineLocation:'platform'}}),'byok');
    const cli = {...raw,selection:{...raw.selection,credentialCustody:'official_cli',billingSource:'user_cli'}};
    assert.equal(selectModelAdapterRoute(cli),providerRef === 'openai' ? 'codex_subscription' : 'claude_subscription');
  }
});

test('MODEL-REGISTRY hostile provider endpoints, wrong custody/billing/location and injected readiness cannot select a fallback', () => {
  for (const providerRef of ['OpenAI','openai-compatible','https://api.openai.com','grok',''])
    denied(() => selectModelAdapterRoute({...input(),selection:{...input().selection,providerRef}}));
  for (const selection of [{...input().selection,processingLocation:'runtime_local'},
    {...input().selection,credentialCustody:'official_cli',billingSource:'user_byok'},
    {...input().selection,credentialCustody:'local_keychain',engineLocation:'platform'},
    {...input().selection,credentialCustody:'platform_vault',engineLocation:'runtime_local'},
    {...input().selection,modelRef:undefined}]) denied(() => selectModelAdapterRoute({...input(),selection}));
  for (const fields of [{endpoint:'https://evil.invalid'},{fallback:'claude_subscription'},{modelReady:true},
    {operational_authority:true},{permit:{approved:true}}]) denied(() => selectModelAdapterRoute({...input(),...fields}),'invalid_input');
});
