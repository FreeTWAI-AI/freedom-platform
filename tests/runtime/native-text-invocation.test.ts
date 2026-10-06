import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { NativeTextBindingSchema, NativeTextReceiptSchema, NativeTextLimits } from '../../contracts/execution/v3/native-text-invocation.js';
import { ModelSelectionSchema } from '../../contracts/execution/v1/member-execution.js';
import { nativeBinding, nativeContext, nativeDigest } from '../../modules/agent-execution/adapters/native-text-profile.js';
import { createNativeTextStartAuthority } from '../../modules/agent-execution/adapters/native-text-process.js';
import { parseModelJson } from '../../modules/agent-execution/adapters/common.js';

test('versioned native binding rejects invented authority, provider/model substitution and inflated limits', () => {
  assert.equal(NativeTextBindingSchema.safeParse({ ready: true, approved: true }).success, false);
  for (const [key, value] of [['wallTimeoutMs',60001],['maxLocalDispatches',2],['providerCallLimit',1],
    ['monetaryLimit',0],['credentialCustody','official_cli'],['billingSource','user_byok'],
    ['requestedModelRef','claude-opus-5-5-high'],['expectedReportedModelRef','grok-4.7'],['environment','production']]) {
    assert.equal(NativeTextBindingSchema.shape[key as keyof typeof NativeTextBindingSchema.shape].safeParse(value).success, false, key as string);
  }
  assert.equal(NativeTextLimits.leaseMs,90000); assert.equal(NativeTextLimits.startMs,5000); assert.equal(NativeTextLimits.wallMs,60000);
  assert.equal(ModelSelectionSchema.safeParse({ providerRef:'xai', modelRef:'grok-4.7', credentialCustody:'runtime_cli',
    engineLocation:'runtime_local',processingLocation:'provider_remote',artifactCustody:'platform_asset',billingSource:'owner_cli' }).success,false,
  'Native profile must not silently widen or relabel the old official_cli/BYOK contract.');
});

test('claim authority cannot be JSON, getters, or a copied opaque value', () => {
  let reads = 0;
  assert.throws(() => createNativeTextStartAuthority({ claim:true,assertCurrent:true } as never));
  assert.throws(() => createNativeTextStartAuthority({ get claim() { reads++; throw Error('PRIVATE'); }, assertCurrent:async()=>{} } as never));
  assert.equal(reads,0);
  const authority = createNativeTextStartAuthority({ claim:async()=>({issuedAt:new Date().toISOString(),startExpiresAt:new Date().toISOString()}),assertCurrent:async()=>{} });
  assert.deepEqual(Object.keys(authority),[]); assert.equal(JSON.stringify(authority),'{}');
});

test('receipt does not claim provider verification, known charges, generic execution or embed private text', () => {
  const base = { profile:'freedom.native-text.receipt/v1',dispatchId:randomUUID(),attemptId:randomUUID(),runId:randomUUID(),
    bindingSha256:'a'.repeat(64),contextSha256:'b'.repeat(64),adapterProfile:'grok-1.0.46-text/v1',executableSha256:'c'.repeat(64),
    requestedModelRef:'grok-4.7',evidenceOrigin:'native_cli_local_observed',assurance:'local_observed',capability:'assisted_local',
    localDispatches:1,providerCalls:'unknown',usageStatus:'unknown',costStatus:'unknown',operational_authority:false,
    outcome:'observed_unknown',reportedModelRef:null,outputSha256:null,outputByteSize:null };
  assert.equal(NativeTextReceiptSchema.safeParse(base).success,true);
  for (const extra of [{costStatus:'known'},{providerCalls:1},{operational_authority:true},{evidenceOrigin:'provider_https'},
    {assurance:'provider_verified'},{capability:'managed_local'},{text:'PRIVATE'}, {outcome:'observed_success'}])
    assert.equal(NativeTextReceiptSchema.safeParse({...base,...extra}).success,false);
});

test('semantic lifetime/context checks cannot be replaced by structural schema parsing', () => {
  // Only the context-relevant properties are needed to test the private parser.
  const bytes = new TextEncoder().encode('{"schema":"native-text.context/v1","title":"T","objective":"O"}');
  const binding = {inputByteSize:bytes.length,contextSha256:nativeDigest(bytes)} as never;
  assert.deepEqual(nativeContext(bytes,binding),bytes);
  const duplicate = new TextEncoder().encode('{"schema":"native-text.context/v1","title":"T","title":"X","objective":"O"}');
  assert.throws(()=>nativeContext(duplicate,{inputByteSize:duplicate.length,contextSha256:nativeDigest(duplicate)} as never));
  const reordered = new TextEncoder().encode('{"objective":"O","title":"T","schema":"native-text.context/v1"}');
  assert.throws(()=>nativeContext(reordered,{inputByteSize:reordered.length,contextSha256:nativeDigest(reordered)} as never));
  assert.throws(()=>nativeBinding({profile:'freedom.native-text.binding/v1',leaseExpiresAt:new Date(Date.now()+180000).toISOString()}));
});

test('native 64 KiB JSON bound is explicit while old provider default remains exactly 32 KiB', () => {
  const json = (size: number) => new TextEncoder().encode('"' + 'x'.repeat(size-2) + '"');
  assert.equal((parseModelJson(json(32768)) as string).length,32766);
  assert.throws(()=>parseModelJson(json(32769)),{code:'response_limit'});
  assert.equal((parseModelJson(json(65536),65536) as string).length,65534);
  assert.throws(()=>parseModelJson(json(65537),65536),{code:'response_limit'});
  assert.throws(()=>parseModelJson(json(65537),65537),{code:'invalid_input'});
  assert.throws(()=>parseModelJson(new TextEncoder().encode('{"a":1,"a":2}'),65536),{code:'invalid_response'});
});
