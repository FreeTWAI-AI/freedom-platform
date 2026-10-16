import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {test,before,after,beforeEach} from 'node:test';
import {ECPAY_ORIGINS,EcpayKeyPair,newTradeNumber,verifySignedForm,encodeForm} from '../../modules/agent-commerce/providers/ecpay/index.js';
import {buildCreditCheckoutForm} from '../../modules/agent-commerce/providers/ecpay/aio-credit/index.js';
import {createEcpayPaymentGateway,createFixturePaymentGateway,paymentGatewayUrls,assertPaymentGatewayInstallation} from '../../modules/agent-commerce/payments/gateway.js';
import {hostedPaymentHarness} from '../e2e/hosted-payment-fixture.js';
import {hashKey} from '../../modules/agent-commerce/checkout/terms.js';
import {COMMERCE_LIMITS} from '../../modules/agent-commerce/checkout/limits.js';
import {createStoreAdmissionPort} from '../../modules/agent-commerce/operations/admissions.js';
import {creditUnavailableMessage} from '../../modules/agent-commerce/payments/availability.js';
import type {CreditUnavailableReason} from '../../modules/agent-commerce/providers/ecpay/aio-credit/index.js';
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
let f:Awaited<ReturnType<typeof hostedPaymentHarness>>;
before(async()=>{f=await hostedPaymentHarness('fp_payment_handoff');});
beforeEach(async()=>{await f.reset();});
after(async()=>f?.stop());
const expect=(r:Awaited<ReturnType<typeof f.http>>,status:number,code?:string)=>{assert.equal(r.status,status,JSON.stringify(r.data));if(code)assert.equal(r.data.code,code);return r.data;};
const resume=(p:Awaited<ReturnType<typeof f.placed>>,cookie:string|undefined=p.cookie)=>f.http('POST',f.root(p.s)+`/orders/${p.order.order_ref}/payment-handoffs`,{},cookie);
test('placement atomically creates attempt 1, two exact due times and one hashed fifteen-minute token',async()=>{
  const p=await f.placed(),a=(await f.x.h.pool.query('SELECT * FROM commerce_payment_attempts WHERE order_id=$1',[p.order.order_ref])).rows[0];
  assert.equal(a.sequence,1);assert.equal(a.state,'issued');assert.equal(a.account_id,p.provider.accountId);assert.equal(a.credential_version,1);assert.equal(a.amount_minor,'500');assert.equal(a.journaled_at,null);assert.equal(a.handed_off_at,null);assert.equal(a.version,'1');
  assert.match(p.payment.handoff_url,/^\/pay\/ecpay\/[A-Za-z0-9_-]{43}$/);assert.equal(p.payment.attempt_ref,a.attempt_id);
  const route=(await f.x.h.pool.query("SELECT *,expires_at=created_at+interval '15 minutes' AS exact FROM commerce_entry_routes WHERE route_kind='payment_handoff' AND target_id=$1",[a.attempt_id])).rows[0];
  assert.equal(route.route_key,hashKey(p.payment.handoff_url.split('/').at(-1)!));assert(route.exact);assert.equal(route.revoked_at,null);assert.equal(route.expires_at.toISOString(),p.payment.expires_at);
  const due=(await f.x.h.pool.query(`SELECT w.kind,w.due_at=a.created_at+CASE w.kind WHEN 'payment_query' THEN interval '10 minutes' ELSE interval '60 minutes' END AS exact
    FROM commerce_due_work w JOIN commerce_payment_attempts a ON a.attempt_id=w.target_id WHERE a.attempt_id=$1 ORDER BY kind`,[a.attempt_id])).rows;
  assert.deepEqual(due,[{kind:'payment_query',exact:true},{kind:'payment_window_end',exact:true}]);
});
test('placement replay replaces the token without a new attempt, order or due row',async()=>{
  const p=await f.placed(),replay=expect(await f.http('POST',f.root(p.s)+`/checkouts/${p.checkout.checkout_ref}/orders`,p.intent,p.cookie),200);
  assert.equal(replay.payment.attempt_ref,p.payment.attempt_ref);assert.notEqual(replay.payment.handoff_url,p.payment.handoff_url);assert.deepEqual(replay.order,p.order);
  assert.equal((await f.x.h.pool.query('SELECT count(*)::int n FROM commerce_payment_attempts')).rows[0].n,1);assert.equal((await f.x.h.pool.query('SELECT count(*)::int n FROM commerce_due_work')).rows[0].n,2);
  const routes=(await f.x.h.pool.query("SELECT route_key,revoked_at FROM commerce_entry_routes WHERE route_kind='payment_handoff' ORDER BY created_at")).rows;
  assert(routes[0].revoked_at instanceof Date);assert.equal(routes[1].revoked_at,null);
});
test('resume shares buyer access, replaces older links and returns private no-store/no-referrer responses',async()=>{
  const p=await f.placed();expect(await resume(p,''),404,'checkout_order_not_found');
  expect(await f.http('POST',f.root(p.s)+`/orders/${randomUUID()}/payment-handoffs`,{},p.cookie),404,'checkout_order_not_found');
  const r=await resume(p);expect(r,201);assert.equal(r.data.attempt_ref,p.payment.attempt_ref);assert.notEqual(r.data.handoff_url,p.payment.handoff_url);
  assert.equal(r.response.headers.get('Cache-Control'),'no-store');assert.equal(r.response.headers.get('Referrer-Policy'),'no-referrer');assert.equal(r.response.headers.get('Set-Cookie'),null);
  expect(await f.http('POST',f.root(p.s)+`/orders/${p.order.order_ref}/payment-handoffs`,{extra:true},p.cookie),422,'validation_failed');
  expect(await f.http('POST',f.root(p.s)+`/orders/${p.order.order_ref}/payment-handoffs`,{},p.cookie,{Origin:'https://foreign.test'}),403,'origin_rejected');
});
test('resume keeps quarantine/checkout codes and charges its own durable network budget',async()=>{
  const p=await f.placed();f.settings.quarantine=true;expect(await resume(p),503,'commerce_quarantined');
  f.settings.quarantine=false;f.settings.checkoutEnabled=false;expect(await resume(p),409,'checkout_not_enabled');f.settings.checkoutEnabled=true;
  const bucket='commerce:handoffNetwork:'+hashKey('192.0.2.1');await f.x.h.pool.query('INSERT INTO auth_rate_limits(bucket,window_start,attempts) VALUES($1,clock_timestamp(),$2)',[bucket,COMMERCE_LIMITS.handoffNetwork.limit]);
  const r=await resume(p);expect(r,429,'commerce_rate_limited');assert(Number(r.response.headers.get('Retry-After'))>0);
});
test('a handed-off attempt cannot receive another token, including a placement replay',async()=>{
  const p=await f.placed();
  await f.x.h.pool.query('UPDATE commerce_payment_attempts SET journaled_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1',[p.payment.attempt_ref]);
  await f.x.h.pool.query('UPDATE commerce_payment_attempts SET handed_off_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1',[p.payment.attempt_ref]);
  expect(await resume(p),409,'payment_handoff_unavailable');
  const replay=expect(await f.http('POST',f.root(p.s)+`/checkouts/${p.checkout.checkout_ref}/orders`,p.intent,p.cookie),200);assert.equal(replay.payment,null);
  assert.equal((await f.x.h.pool.query("SELECT count(*)::int n FROM commerce_entry_routes WHERE route_kind='payment_handoff'")).rows[0].n,1);
});
test('an attempt write failure rolls back the order and its already-created holds',async()=>{
  const p=await f.readyCheckout(),payment=f.runtime.commercePorts!.payment!;
  let called=false;
  f.install({commercePorts:{...f.runtime.commercePorts,payment:{...payment,async createOrderAttempt(q,input){
    called=true;assert.equal((await q.query("SELECT count(*)::int n FROM commerce_inventory_reservations WHERE order_id=$1 AND state='held'",[input.orderId])).rows[0].n,1);
    throw Error('payment_trade_number_unavailable');
  }}}});
  expect(await f.http('POST',f.root(p.s)+`/checkouts/${p.checkout.checkout_ref}/orders`,p.intent,p.cookie),500,'internal_error');assert(called);
  for(const table of ['commerce_checkout_orders','commerce_inventory_reservations','commerce_payment_attempts','commerce_due_work'])assert.equal((await f.x.h.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,0,table);
  assert.equal((await f.x.h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1',[p.s.product.product_id])).rows[0].reserved,0);
});
test('five real trade-number conflicts draw fresh numbers and then roll back placement',async()=>{
  const p=await f.readyCheckout(),connect=f.x.runtime.connect,draws:string[]=[];
  f.x.runtime.connect=(async()=>{
    const q=await (connect as ()=>Promise<import('pg').PoolClient>).call(f.x.runtime),query=q.query,release=q.release;
    q.query=(async(...args:unknown[])=>{
      if(/^INSERT INTO commerce_payment_attempts/.test(String(args[0]))){
        const values=args[1] as unknown[];draws.push(String(values[8]));
        await (query as Function).call(q,`INSERT INTO commerce_payment_attempts(tenant_id,instance_id,kind,sequence,account_id,purpose,environment,merchant_id,credential_version,provider,profile,merchant_trade_no,amount_minor,currency)
          VALUES($1,$2,'service_activation',$11,$3,'payment',$4,$5,$6,'ecpay',$7,$8,$9,$10)`,[values[0],values[1],values[3],values[4],values[5],values[6],values[7],values[8],values[9],values[10],100+draws.length]);
      }
      return (query as Function).apply(q,args);
    }) as typeof q.query;
    q.release=(error?:Error|boolean)=>{q.query=query;q.release=release;release.call(q,error);};return q;
  }) as typeof f.x.runtime.connect;
  try{expect(await f.http('POST',f.root(p.s)+`/checkouts/${p.checkout.checkout_ref}/orders`,p.intent,p.cookie),500,'internal_error');}
  finally{f.x.runtime.connect=connect;}
  assert.equal(draws.length,5);assert.equal(new Set(draws).size,5);
  for(const table of ['commerce_checkout_orders','commerce_inventory_reservations','commerce_payment_attempts','commerce_due_work'])assert.equal((await f.x.h.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,0,table);
});
test('admission requires a listed active payment service in this environment, and an unrevoked admission',async()=>{
  const s=await f.x.store(),before=f.runtime.commercePorts!.admission!;assert.equal(await f.x.tx(async q=>before.allowed(q,s)),false);
  const provider=await f.setup(s);assert.equal(await f.x.tx(async q=>before.allowed(q,s)),true);
  for(const port of [createStoreAdmissionPort('sandbox',[]),createStoreAdmissionPort('sandbox',['unknown']),createStoreAdmissionPort('live',['ecpay.aio.credit.v1'])])assert.equal(await f.x.tx(async q=>port.allowed(q,s)),false);
  for(const state of ['suspended','retired'])await f.x.tx(async q=>{
    assert.equal(await before.allowed(q,s),true);
    await q.query('SAVEPOINT inactive');await q.query('UPDATE commerce_provider_account_services SET state=$2,version=version+1,updated_at=clock_timestamp() WHERE account_id=$1',[provider.accountId,state]);
    assert.equal(await before.allowed(q,s),false);await q.query('ROLLBACK TO SAVEPOINT inactive');
  });
  await f.x.h.pool.query(`UPDATE commerce_store_admissions SET revoked_at=clock_timestamp(),revoked_by=(SELECT admin_id FROM platform_admins LIMIT 1),revoke_reason='合成撤銷' WHERE admission_id=$1`,[provider.admissionId]);
  assert.equal(await f.x.tx(async q=>before.allowed(q,s)),false);
});
const unavailableCases=[
  {reason:'currency_not_supported',message:'這間店的幣別不能用信用卡付款。'},
  {reason:'amount_not_whole_twd',message:'金額有不到 1 元的零頭，不能用信用卡付款。'},
  {reason:'amount_below_minimum',message:'信用卡付款的總額至少 5 元。'},
  {reason:'amount_above_maximum',message:'信用卡付款的總額最多 999,999,999 元。'},
] as const;
for(const phase of ['checkout','placement'] as const)for(const scenario of unavailableCases)test(`${phase} rejects ${scenario.reason} with its fixed Chinese message and no partial effect`,async()=>{
  const s=await f.x.store(100);await f.setup(s);let revision='1',quantity=5;
  const basePorts={...f.runtime.commercePorts};
  if(scenario.reason==='currency_not_supported'){
    await f.x.h.pool.query("UPDATE commerce_shops SET currency='USD' WHERE shop_id=ANY($1::uuid[])",[[s.storefront_shop_id,s.supply_shop_id]]);await f.x.publish(s);revision='2';
  }
  if(scenario.reason==='amount_not_whole_twd'){
    expect(await f.x.send(s,'/products/'+s.product.product_id,{price_minor:150},s.product.version,'PATCH'),200);await f.x.publish(s);revision='2';quantity=2;
    basePorts.shipping={quote:async(_q,_store,input)=>({groups:[{group_ref:'synthetic',supplier_shop_id:input.lines[0].supplier_shop_id,method_ref:'synthetic',amount_minor:200}]})};
  }
  if(scenario.reason==='amount_below_minimum')quantity=1;
  if(scenario.reason==='amount_above_maximum')basePorts.shipping={quote:async(_q,_store,input)=>({groups:[{group_ref:'synthetic',supplier_shop_id:input.lines[0].supplier_shop_id,method_ref:'synthetic',amount_minor:99_999_999_900}]})};
  f.install({commercePorts:{...basePorts,...(phase==='placement'?{payment:undefined}:{})}});
  const input={...f.x.input(s.product.sku,quantity),publication_revision:revision};
  let response=await f.http('POST',f.root(s)+'/checkouts',input,undefined,{'Idempotency-Key':randomUUID()});
  if(phase==='placement'){
    expect(response,201);const saved=response.data,cookie=response.response.headers.get('Set-Cookie')!.split(';')[0];f.install({commercePorts:basePorts});
    response=await f.http('POST',f.root(s)+`/checkouts/${saved.checkout_ref}/orders`,{terms_sha256:saved.terms_sha256,client_order_id:randomUUID()},cookie);
  }
  expect(response,409,'payment_profile_unavailable');assert.equal(response.data.detail,scenario.message);
  for(const table of ['commerce_checkout_orders','commerce_inventory_reservations','commerce_payment_attempts','commerce_due_work'])assert.equal((await f.x.h.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,0,table);
  if(phase==='checkout')for(const table of ['commerce_checkouts','commerce_checkout_contacts','commerce_customers','commerce_order_access_grants'])assert.equal((await f.x.h.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,0,table);
});
test('availability checks each shipping group even when their sum and the order total are whole TWD',async()=>{
  const s=await f.x.store();await f.setup(s);
  f.install({commercePorts:{shipping:{quote:async(_q,_store,input)=>({groups:['a','b'].map(group_ref=>({group_ref,supplier_shop_id:input.lines[0].supplier_shop_id,method_ref:'synthetic',amount_minor:50}))})}}});
  const r=await f.http('POST',f.root(s)+'/checkouts',f.x.input(s.product.sku,5),undefined,{'Idempotency-Key':randomUUID()});expect(r,409,'payment_profile_unavailable');assert.equal(r.data.detail,'金額有不到 1 元的零頭，不能用信用卡付款。');
});
test('the availability reason list is closed at runtime',()=>{
  assert.throws(()=>creditUnavailableMessage('future_reason' as CreditUnavailableReason),{message:'payment_availability_reason_unknown'});
});
