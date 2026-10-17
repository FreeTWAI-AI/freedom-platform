import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import * as wire from '../../contracts/guild-launchpad/v1/hosted-commerce-setup.js';
import {STOREFRONT_CONTRACT_ARTIFACT_SHA256} from '../../modules/module-registry/definitions.js';
test('strict setup requests reject credential authority selectors and request-supplied admission environments',()=>{
  const fresh_auth_verification_id=randomUUID(),base={provider:'ecpay',environment:'sandbox',merchant_id:'1234567',fresh_auth_verification_id};
  assert(wire.ProviderAccountCreateInputSchema.safeParse(base).success);
  for(const extra of [{account_ref:'forbidden'},{tenant_id:randomUUID()},{instance_id:randomUUID()},{provider:'unknown'},{merchant_id:'123456'}])assert(!wire.ProviderAccountCreateInputSchema.safeParse({...base,...extra}).success);
  assert(!wire.StoreAdmissionCreateInputSchema.safeParse({tenant_id:randomUUID(),instance_id:randomUUID(),reason:'合成理由',environment:'live'}).success);
  assert(!wire.CommerceSetupEmptyInputSchema.safeParse({module_release_ref:'storefront@1.1.0'}).success);
  assert(!wire.CommerceSetupErrorCodeSchema.safeParse('future_payment_error').success);
  assert.equal(createHash('sha256').update(readFileSync('contracts/guild-launchpad/v1/storefront.schema.json')).digest('hex'),STOREFRONT_CONTRACT_ARTIFACT_SHA256);
});
test('generated commerce setup bundle validates every request and response without extending storefront bytes',()=>{
  const bundle=JSON.parse(readFileSync('contracts/guild-launchpad/v1/hosted-commerce-setup.schema.json','utf8'));
  const id=randomUUID(),time='2028-02-29T12:34:56.789Z',fresh={fresh_auth_verification_id:id};
  const account={logistics_services:[],payment_activation:null,account_id:id,provider:'ecpay',environment:'sandbox',merchant_id:'1234567',version:'1',created_at:time,
    services:[{purpose:'payment',profile:'ecpay.aio.credit.v1',state:'draft',credential_version:1,credential_updated_at:time,activated_at:null,throttled_until:null}]};
  const admission={admission_id:id,tenant_id:id,instance_id:id,environment:'sandbox',admitted_at:time,admitted_by:id,reason:'合成准入理由',revoked_at:null,revoked_by:null,revoke_reason:null};
  const samples:[string,unknown][]=[
    ['empty-input',{}],['store-release',{module_release_ref:'storefront@1.0.0',application_release_ref:'hosted-store@1.0.0',version:'1',capabilities:['store:read'],upgrade:{module_release_ref:'storefront@1.1.0',application_release_ref:'hosted-store@1.1.0'},can_upgrade:true}],
    ['provider-account-create-input',{provider:'ecpay',environment:'sandbox',merchant_id:'1234567',...fresh}],
    ['provider-service-put-input',{profile:'ecpay.aio.credit.v1',hash_key:randomBytes(8).toString('hex'),hash_iv:randomBytes(8).toString('hex'),...fresh}],
    ['payment-activation',{attempt_ref:id,state:'ready',created_at:time}],['provider-activation-payment-input',fresh],['provider-activation-payment',{handoff_url:'/pay/ecpay/'+'A'.repeat(43),attempt_ref:id,expires_at:time}],
    ['logistics-service-create-input',{service_key:'ecpay.logistics.home.tcat',...fresh}],['provider-service-state-input',fresh],['provider-account',account],['provider-account-page',{items:[account]}],
    ['store-admission-create-input',{tenant_id:id,instance_id:id,reason:'合成准入理由'}],['store-admission-revoke-input',{reason:'合成撤銷理由'}],['store-admission-query',{tenant_id:id}],
    ['store-admission',admission],['store-admission-page',{items:[admission]}],['error-code','commerce_credentials_unavailable'],
    ['error',{type:'about:blank',title:'unavailable',status:503,code:'commerce_credentials_unavailable',detail:'合成錯誤'}],
  ];
  assert.deepEqual(Object.keys(bundle.$defs).sort(),samples.map(([name])=>name).sort());
  const cases=samples.flatMap(([name,value])=>[{name,value,valid:true},{name,value:typeof value==='object'?{...(value as object),unexpected:'forbidden'}:'unknown',valid:false},{name,value:null,valid:false}]);
  const result=spawnSync('python3',['-c',`import json,sys
from jsonschema import Draft202012Validator,FormatChecker
x=json.load(sys.stdin)
Draft202012Validator.check_schema(x['bundle'])
for c in x['cases']:
 s=x['bundle']['$defs'][c['name']]
 Draft202012Validator.check_schema(s)
 assert Draft202012Validator(s,format_checker=FormatChecker()).is_valid(c['value']) == c['valid'],c['name']
print(len(x['cases']))`],{input:JSON.stringify({bundle,cases}),encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr);assert.equal(Number(result.stdout),54);
});
test('activation contract requires fresh proof and exposes only its coarse state and bearer response',()=>{
  const id=randomUUID(),time='2028-02-29T12:34:56.789Z',fresh={fresh_auth_verification_id:id};
  assert(wire.ProviderActivationPaymentInputSchema.safeParse(fresh).success);
  for(const value of [{},{...fresh,amount_minor:1000},{...fresh,account_id:id},{...fresh,environment:'sandbox'}])assert(!wire.ProviderActivationPaymentInputSchema.safeParse(value).success);
  for(const state of ['ready','awaiting_result','paid','confirmed','failed','expired'])assert(wire.PaymentActivationSchema.safeParse({attempt_ref:id,state,created_at:time}).success);
  for(const state of ['issued','superseded','expired_unpaid'])assert(!wire.PaymentActivationSchema.safeParse({attempt_ref:id,state,created_at:time}).success);
  assert(!wire.PaymentActivationSchema.safeParse({attempt_ref:id,state:'ready',created_at:time,trade_no:'TSECRET'}).success);
  const response={handoff_url:'/pay/ecpay/'+'A'.repeat(43),attempt_ref:id,expires_at:time};
  assert(wire.ProviderActivationPaymentResponseSchema.safeParse(response).success);
  for(const value of [{...response,handoff_url:'https://foreign.test'+response.handoff_url},{...response,handoff_url:response.handoff_url+'\n'},{...response,token:'forbidden'}])assert(!wire.ProviderActivationPaymentResponseSchema.safeParse(value).success);
  assert(wire.CommerceSetupErrorCodeSchema.safeParse('provider_activation_pending').success);
});
