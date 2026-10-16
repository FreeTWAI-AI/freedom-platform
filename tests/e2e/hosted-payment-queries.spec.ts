import {randomUUID} from 'node:crypto';
import {test,expect} from './fixtures.js';
import {createE2ePaymentOrder,setupE2ePayment} from './hosted-payment-fixture.js';
import {fixtureStore,apiLogin,ownedSchema} from './hosted-order-fixture.js';
import {PublicOrderSchema,CheckoutResponseSchema,PaymentHandoffResponseSchema} from '../../contracts/guild-launchpad/v1/hosted-checkout.js';
import {ProviderActivationPaymentResponseSchema} from '../../contracts/guild-launchpad/v1/hosted-commerce-setup.js';
import {DEMO_PASSWORD} from '../../packages/testing/seed.js';
import type {Page,APIRequestContext} from '@playwright/test';
import type {Pool} from 'pg';
const row=async(db:Pool,id:string)=>(await db.query('SELECT * FROM commerce_payment_attempts WHERE attempt_id=$1',[id])).rows[0];
const read=async(request:APIRequestContext,slug:string,id:string)=>{const r=await request.get(`/api/v1/public/stores/${slug}/orders/${id}`);expect(r.status()).toBe(200);return PublicOrderSchema.parse(await r.json());};
// PostgreSQL retains microseconds; JS Date truncates them. Advance one millisecond
// past the chosen boundary so the claim includes the original exact due time.
async function run(request:APIRequestContext,db:Pool,id:string,minutes=11){
  const a=await row(db,id),r=await request.post('/__e2e/commerce/run-due-work',{data:{targets:[id],now:new Date(a.created_at.getTime()+minutes*60_000+1).toISOString()}});expect(r.status()).toBe(200);return r.json();
}
async function enter(page:Page,url:string){await page.goto(url);await expect(page.getByRole('heading',{name:'本機付款測試',exact:true})).toBeVisible();}
test.beforeEach(async({page})=>{await page.route(url=>!['127.0.0.1','localhost'].includes(url.hostname),route=>route.abort());});
test('paid without notification is confirmed by due work and exposed by the B07 order API',async({page,browser,baseURL,e2eAuthPool:db})=>{
  const p=await createE2ePaymentOrder(db,browser,baseURL!,page.context());await enter(page,p.payment.handoff_url);
  await page.getByRole('button',{name:'付款成功但不通知',exact:true}).click();
  expect((await read(page.request,p.store.slug,p.order.order_ref)).payment_state).toBe('unpaid');
  expect((await db.query('SELECT count(*)::int n FROM commerce_hosted_payment_events WHERE attempt_id=$1',[p.payment.attempt_ref])).rows[0].n).toBe(0);
  expect((await run(page.request,db,p.payment.attempt_ref)).externalCalls).toBe(1);
  expect((await row(db,p.payment.attempt_ref)).state).toBe('confirmed');expect((await read(page.request,p.store.slug,p.order.order_ref)).payment_state).toBe('confirmed');
});
test('a pending result stays pending until a verified paid query confirms it',async({page,browser,baseURL,e2eAuthPool:db})=>{
  const p=await createE2ePaymentOrder(db,browser,baseURL!,page.context());await enter(page,p.payment.handoff_url);
  await page.getByRole('button',{name:'結果待確認',exact:true}).click();await page.getByRole('button',{name:'返回商店查看結果',exact:true}).click();
  expect((await read(page.request,p.store.slug,p.order.order_ref)).payment_state).toBe('pending');
  await expect.poll(async()=>(await db.query("SELECT count(*)::int n FROM commerce_hosted_payment_events WHERE attempt_id=$1 AND source='query' AND outcome='unknown' AND applied_at IS NOT NULL",[p.payment.attempt_ref])).rows[0].n).toBeGreaterThanOrEqual(1);
  await expect.poll(async()=>(await db.query("SELECT lease_until FROM commerce_due_work WHERE target_id=$1 AND kind='payment_query'",[p.payment.attempt_ref])).rows[0]?.lease_until??null).toBeNull();
  expect((await page.request.post('/__e2e/ecpay/query-mode',{data:{attempt_ref:p.payment.attempt_ref,mode:null}})).status()).toBe(200);
  await run(page.request,db,p.payment.attempt_ref);expect((await row(db,p.payment.attempt_ref)).state).toBe('confirmed');expect((await read(page.request,p.store.slug,p.order.order_ref)).payment_state).toBe('confirmed');
});
test('failure then the same pay endpoint issues attempt two and accepts its successful payment',async({page,browser,baseURL,e2eAuthPool:db})=>{
  const p=await createE2ePaymentOrder(db,browser,baseURL!,page.context());await enter(page,p.payment.handoff_url);await page.getByRole('button',{name:'付款失敗',exact:true}).click();
  expect((await read(page.request,p.store.slug,p.order.order_ref)).can_resume_payment).toBe(true);
  const response=await page.request.post(`/api/v1/public/stores/${p.store.slug}/orders/${p.order.order_ref}/payment-handoffs`,{data:{},headers:{Origin:baseURL!}});expect(response.status()).toBe(201);
  const next=PaymentHandoffResponseSchema.parse(await response.json());expect(next.attempt_ref).not.toBe(p.payment.attempt_ref);expect((await row(db,next.attempt_ref)).sequence).toBe(2);
  await enter(page,next.handoff_url);await page.getByRole('button',{name:'付款成功',exact:true}).click();await page.getByRole('button',{name:'返回商店查看結果',exact:true}).click();
  await expect.poll(async()=>(await row(db,next.attempt_ref)).state).toBe('confirmed');expect((await read(page.request,p.store.slug,p.order.order_ref)).payment_state).toBe('confirmed');
});
test('an aged abandoned handoff is queried unpaid before re-pay, without waiting on wall time',async({page,browser,baseURL,e2eAuthPool:db})=>{
  await ownedSchema(db);const store=await fixtureStore(db,browser,baseURL!),provider=await setupE2ePayment(db,browser,baseURL!,store),root='/api/v1/public/stores/'+store.slug;
  const c=await page.request.post(root+'/checkouts',{data:{publication_revision:'1',lines:[{sku:store.product.sku,quantity:1}],contact:{name:'合成棄置付款買家',email:'abandoned@example.test',phone:'0000000000'},delivery:{method:'synthetic',address:'合成測試地址'},invoice:null,consents:[]},headers:{Origin:baseURL!,'Idempotency-Key':randomUUID()}});expect(c.status()).toBe(201);const checkout=CheckoutResponseSchema.parse(await c.json());
  // Insert the age once, through the ordinary checkout/hold core. Never rewrite
  // immutable attempt identity or set-once handoff facts to advance the clock.
  const {isolatedTransaction}=await import('../../packages/resource-scopes/tenant-transaction.js'),{placeCheckoutOrder}=await import('../../modules/agent-commerce/checkout/orders.js'),{newTradeNumber}=await import('../../modules/agent-commerce/providers/ecpay/index.js'),{createStoreAdmissionPort,providerEnvironment}=await import('../../modules/agent-commerce/operations/admissions.js'),{ports}=await import('../runtime/hosted-checkout-harness.js');
  const seeded=await isolatedTransaction(db,async q=>{
    const s=(await q.query('SELECT storefront_shop_id FROM commerce_storefront_profiles WHERE instance_id=$1',[store.instance])).rows[0];
    const order=await placeCheckoutOrder(q,s,{checkoutId:checkout.checkout_ref,termsSha256:checkout.terms_sha256,clientOrderId:randomUUID(),buyerPrincipalId:null,environment:providerEnvironment('local')},{shipping:ports.shipping,admission:createStoreAdmissionPort(providerEnvironment('local'),['ecpay.aio.credit.v1'])});
    const a=(await q.query(`INSERT INTO commerce_payment_attempts(tenant_id,instance_id,kind,order_id,sequence,account_id,environment,merchant_id,credential_version,merchant_trade_no,amount_minor,currency,created_at)
      VALUES($1,$2,'order',$3,1,$4,'sandbox','1234567',1,$5,35000,'TWD',clock_timestamp()-interval '61 seconds') RETURNING *`,[store.tenant,store.instance,order.order_id,provider.accountId,newTradeNumber('F')])).rows[0];
    await q.query('UPDATE commerce_payment_attempts SET handed_off_at=created_at,journaled_at=created_at,version=version+1 WHERE attempt_id=$1',[a.attempt_id]);
    for(const [kind,minutes] of [['payment_query',10],['payment_window_end',60]] as const)await q.query('INSERT INTO commerce_due_work(tenant_id,instance_id,kind,target_id,due_at) VALUES($1,$2,$3,$4,$5)',[store.tenant,store.instance,kind,a.attempt_id,new Date(a.created_at.getTime()+minutes*60_000+1)]);
    return {order,a};
  });
  expect((await read(page.request,store.slug,seeded.order.order_id)).can_resume_payment).toBe(true);
  const r=await page.request.post(root+`/orders/${seeded.order.order_id}/payment-handoffs`,{data:{},headers:{Origin:baseURL!}});expect(r.status()).toBe(201);const next=PaymentHandoffResponseSchema.parse(await r.json());
  expect((await row(db,next.attempt_ref)).sequence).toBe(2);expect((await row(db,seeded.a.attempt_id)).state).toBe('superseded');
  expect((await db.query("SELECT outcome,query_trigger FROM commerce_hosted_payment_events WHERE attempt_id=$1 AND source='query'",[seeded.a.attempt_id])).rows).toEqual([{outcome:'unpaid',query_trigger:'repay'}]);
});
test('the confirmation window cancels an order whose only unhanded attempt expires',async({page,browser,baseURL,e2eAuthPool:db})=>{
  const p=await createE2ePaymentOrder(db,browser,baseURL!,page.context()),work=await run(page.request,db,p.payment.attempt_ref,60);
  expect(work.externalCalls).toBe(0);const view=await read(page.request,p.store.slug,p.order.order_ref);expect(view.lifecycle_state).toBe('cancelled');expect(view.cancel_reason).toBe('payment_not_completed');expect(view.latest_payment_attempt?.state).toBe('expired');
});
test('activation uses the real handoff page and a query activates the draft service',async({page,browser,baseURL,e2eAuthPool:db})=>{
  const store=await fixtureStore(db,browser,baseURL!),provider=await setupE2ePayment(db,browser,baseURL!,store,{activationOnly:true}),seller=await browser.newContext({baseURL});
  try{
    const session=await apiLogin(seller,baseURL!,store.seller.email),headers={Origin:baseURL!,'X-CSRF-Token':session.csrf_token,'Idempotency-Key':randomUUID()};
    const proof=await seller.request.post('/api/v1/me/high-risk-verifications',{data:{tenant_id:store.tenant,purpose:'commerce.provider_account.write',password:DEMO_PASSWORD},headers});expect(proof.status()).toBe(201);
    const r=await seller.request.post('/api/v1'+store.root+`/provider-accounts/${provider.accountId}/services/payment/activation-payments`,{data:{fresh_auth_verification_id:(await proof.json()).verification_id},headers:{...headers,'Idempotency-Key':randomUUID(),'If-Match':`"${provider.version}"`}});expect(r.status()).toBe(201);
    const payment=ProviderActivationPaymentResponseSchema.parse(await r.json());await enter(page,payment.handoff_url);await expect(page.getByText('金額：10 TWD',{exact:true})).toBeVisible();
    await page.getByRole('button',{name:'付款成功但不通知',exact:true}).click();await run(page.request,db,payment.attempt_ref);
    expect((await row(db,payment.attempt_ref)).state).toBe('confirmed');expect((await db.query("SELECT state,activation_ref FROM commerce_provider_account_services WHERE account_id=$1 AND purpose='payment'",[provider.accountId])).rows).toEqual([{state:'active',activation_ref:payment.attempt_ref}]);
    const accounts=await seller.request.get('/api/v1'+store.root+'/provider-accounts');expect(accounts.status()).toBe(200);expect((await accounts.json()).items[0].payment_activation.state).toBe('confirmed');
    const back=await page.request.get('/pay/ecpay/back/'+payment.attempt_ref,{maxRedirects:0});expect(back.status()).toBe(303);expect(back.headers().location).toBe('/');
  }finally{await seller.close();}
});
