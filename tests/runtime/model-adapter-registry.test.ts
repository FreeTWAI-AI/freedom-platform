import test from 'node:test';
import assert from 'node:assert/strict';
import { AdapterFault, selectModelAdapterRoute, createByokTextAdapter } from '../../modules/agent-execution/adapters/index.js';

const cli = { providerRef:'openai', modelRef:'gpt-example', processingLocation:'provider_remote',
  artifactCustody:'runtime_local', credentialCustody:'official_cli', engineLocation:'runtime_local', billingSource:'user_cli' };
const input = (selection = cli) => ({selection,prompt:'Synthetic private draft.',maxOutputTokens:64});
const fault = (code:string) => (e:unknown) => e instanceof AdapterFault && e.code === code && e.message === 'Model adapter request unavailable.';
test('explicit member metadata selects both CLI tracks without a default',()=>{
  assert.equal(selectModelAdapterRoute(input()),'codex_subscription');
  assert.equal(selectModelAdapterRoute(input({...cli,providerRef:'anthropic',modelRef:'claude-example-1'})),'claude_subscription');
  assert.throws(()=>selectModelAdapterRoute({...input(),selection:{...cli,providerRef:'unknown'}}),fault('unsupported_selection'));
  assert.throws(()=>selectModelAdapterRoute({prompt:'x',maxOutputTokens:64}),fault('invalid_input'));
});
test('both explicit BYOK custodies select the same codec without relocating custody',()=>{
  for(const providerRef of ['openai','anthropic'])for(const custody of ['local_keychain','platform_vault']){
    const selected={...cli,providerRef,credentialCustody:custody,engineLocation:custody==='local_keychain'?'runtime_local':'platform',billingSource:'user_byok'};
    assert.equal(selectModelAdapterRoute(input(selected)),'byok');
    const candidate=createByokTextAdapter().prepare(input(selected));
    assert.equal(candidate.credentialCustody,custody);
    assert.equal(candidate.operational_authority,false);
  }
});
test('route selection cannot turn persistence, prompt or an injected ready flag into authority',async()=>{
  assert.throws(()=>selectModelAdapterRoute({...input(),ready:true}),fault('invalid_input'));
  assert.throws(()=>selectModelAdapterRoute(input({...cli,processingLocation:'runtime_local'})),fault('unsupported_selection'));
  assert.throws(()=>selectModelAdapterRoute(input({...cli,billingSource:'user_byok'})),fault('invalid_input'));
  await assert.rejects(createByokTextAdapter().invoke(input({...cli,credentialCustody:'local_keychain',billingSource:'user_byok'})),fault('execution_authority_unavailable'));
});
