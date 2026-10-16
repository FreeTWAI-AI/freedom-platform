import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {ECPAY_ORIGINS,EcpayKeyPair,newTradeNumber,verifySignedForm,encodeForm} from '../../modules/agent-commerce/providers/ecpay/index.js';
import {buildCreditCheckoutForm} from '../../modules/agent-commerce/providers/ecpay/aio-credit/index.js';
import {createEcpayPaymentGateway,createFixturePaymentGateway,paymentGatewayUrls,assertPaymentGatewayInstallation} from '../../modules/agent-commerce/payments/gateway.js';
const origin='https://payments.freedom.test',localOrigin='http://127.0.0.1:4745';
const fixtureInput=()=>({freedomEnv:'local' as const,environment:'sandbox' as const,publicBaseUrl:'https://e2e-payments.freedom.test',checkoutAction:localOrigin+'/__e2e/ecpay/aio-checkout',localOrigin});
for(const environment of ['sandbox','live'] as const)test(`gateway URLs and action equal the public form builder for ${environment}`,()=>{
  const gateway=createEcpayPaymentGateway(environment,origin),attemptId=randomUUID(),accountRef='0'.repeat(26),urls=paymentGatewayUrls(gateway,{accountRef,attemptId});
  const keys=EcpayKeyPair.of(randomBytes(8).toString('hex'),randomBytes(8).toString('hex'));
  const form=buildCreditCheckoutForm({environment,merchantId:'1234567',merchantTradeNo:newTradeNumber('F'),createdAtEpochMs:Date.parse('2026-01-02T00:00:00.000Z'),currency:'TWD',totalMinor:500,lines:[{name:'合成商品',quantity:1}],storeName:'合成商店',displayNumber:'260102-012345',...urls},keys);
  assert.equal(gateway.checkoutAction,ECPAY_ORIGINS.payment[environment]+'/Cashier/AioCheckOut/V5');assert.equal(gateway.checkoutAction,form.action);
  assert.deepEqual(urls,{returnUrl:origin+'/api/v1/provider-callbacks/ecpay/'+accountRef+'/payment',orderResultUrl:origin+'/pay/ecpay/return/'+accountRef,clientBackUrl:origin+'/pay/ecpay/back/'+attemptId});
  const fields=Object.fromEntries(form.fields);assert.equal(fields.ReturnURL,urls.returnUrl);assert.equal(fields.OrderResultURL,urls.orderResultUrl);assert.equal(fields.ClientBackURL,urls.clientBackUrl);assert.equal(fields.NeedExtraPaidInfo,'Y');
  assert.equal(verifySignedForm(encodeForm(form.fields),[keys],'sha256').ok,true);assert(Object.isFrozen(gateway));
});
for(const invalid of ['http://payments.freedom.test','https://localhost','https://127.0.0.1','https://payments.freedom.test:443','https://payments.freedom.test:8443','https://payments.freedom.test/','https://payments.freedom.test/path','https://payments.freedom.test?','https://payments.freedom.test#','https://user@payments.freedom.test','https://echo.freedom.test','https://Payments.freedom.test','https://bad_host.test','https://payments.freedom.test.','https://'+('x'.repeat(60)+'.').repeat(3)+'test'])test(`gateway refuses unsafe or non-origin public base ${invalid}`,()=>{
  assert.throws(()=>createEcpayPaymentGateway('sandbox',invalid),{message:'payment_gateway_invalid'});
});
test('fixture requires local mode at construction and installation, a synthetic HTTPS base and a same-origin local action',()=>{
  const input=fixtureInput(),gateway=createFixturePaymentGateway(input);
  assert.equal(gateway.checkoutAction,input.checkoutAction);assert.equal(gateway.publicBaseUrl,input.publicBaseUrl);assertPaymentGatewayInstallation(gateway,'local',localOrigin);
  for(const freedomEnv of ['staging','public'] as const){assert.throws(()=>createFixturePaymentGateway({...input,freedomEnv}),{message:'payment_fixture_requires_local'});assert.throws(()=>assertPaymentGatewayInstallation(gateway,freedomEnv,origin),{message:'payment_fixture_requires_local'});}
  for(const change of [{checkoutAction:'https://foreign.test/__e2e/ecpay/aio-checkout'},{localOrigin:origin,checkoutAction:origin+'/__e2e/ecpay/aio-checkout'},{publicBaseUrl:localOrigin},{checkoutAction:input.checkoutAction+'?x=1'},{checkoutAction:input.checkoutAction+'#fragment'}])assert.throws(()=>createFixturePaymentGateway({...input,...change}),{message:'payment_gateway_invalid'});
  assert.throws(()=>assertPaymentGatewayInstallation({...gateway},'public',origin),{message:'payment_gateway_invalid'});
  assert.throws(()=>assertPaymentGatewayInstallation(gateway,'local','http://127.0.0.1:4746'),{message:'payment_gateway_invalid'});
});
test('gateway installation ties provider environment and base to this platform origin',()=>{
  assertPaymentGatewayInstallation(createEcpayPaymentGateway('live',origin),'public',origin);
  assertPaymentGatewayInstallation(createEcpayPaymentGateway('sandbox',origin),'staging',origin);
  assert.throws(()=>assertPaymentGatewayInstallation(createEcpayPaymentGateway('live',origin),'staging',origin),{message:'payment_gateway_invalid'});
  assert.throws(()=>assertPaymentGatewayInstallation(createEcpayPaymentGateway('sandbox',origin),'staging','https://other.freedom.test'),{message:'payment_gateway_invalid'});
});
test('gateway validates route identifiers and CDN rules before they can become signed fields',()=>{
  const gateway=createEcpayPaymentGateway('sandbox',origin);
  for(const input of [{accountRef:'0'.repeat(26),attemptId:'../escape'},{accountRef:'0'.repeat(23)+'ecd',attemptId:randomUUID()},{accountRef:'../escape',attemptId:randomUUID()}])assert.throws(()=>paymentGatewayUrls(gateway,input),{message:'payment_gateway_invalid'});
});
