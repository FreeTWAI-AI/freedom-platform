import assert from 'node:assert/strict';
import test from 'node:test';
import { renderProtectedCredentialSetup } from '../../apps/credential-broker/src/setup-ui.js';

test('protected credential setup names each admitted provider without an Anthropic fallback',()=>{
  for(const [providerRef,name,modelRef] of [['openai','OpenAI','synthetic'],['anthropic','Anthropic','synthetic'],['openrouter','OpenRouter','openai/gpt-4.1-mini']] as const){
    const page=renderProtectedCredentialSetup({operation:'create',modelConnectionId:'00000000-0000-4000-8000-000000000001',csrfToken:'A'.repeat(43),
      expiresAt:new Date(Date.now()+30000).toISOString(),operational_authority:false,
      selection:{providerRef,modelRef,processingLocation:'provider_remote',artifactCustody:'platform_asset',credentialCustody:'platform_vault',engineLocation:'platform',billingSource:'user_byok'}});
    assert(page.html.includes(`<dt>模型服務</dt><dd>${name}</dd>`));
    assert(page.html.includes(`<dt>模型</dt><dd>${modelRef}</dd>`));
  }
});
