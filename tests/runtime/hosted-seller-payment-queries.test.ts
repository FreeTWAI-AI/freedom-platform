import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {before,beforeEach,after,test} from 'node:test';
import {hostedPaymentHarness} from '../e2e/hosted-payment-fixture.js';
import {createFixtureQueryTransport} from '../../modules/agent-commerce/payments/query-transport.js';
import {EcpayKeyPair,encodeForm,signFields,newTradeNumber} from '../../modules/agent-commerce/providers/ecpay/index.js';
import {SellerCheckoutOrderSchema} from '../../contracts/guild-launchpad/v1/hosted-seller-checkout.js';
import {hashKey} from '../../modules/agent-commerce/checkout/terms.js';
let f:Awaited<ReturnType<typeof hostedPaymentHarness>>;
type Placed=Awaited<ReturnType<typeof f.placed>>;
before(async()=>{f=await hostedPaymentHarness('fp_seller_query',{randomContact:true});});
beforeEach(async()=>{await f.reset();f.settings.consoleEnabled=true;});
after(async()=>f?.stop());
const path=(p:Placed)=>p.s.root+'/checkout-orders/'+p.order.order_ref+'/payment-queries';
const seller=(p:Placed,session=p.s.owner,body:unknown={})=>f.x.h.call('POST',path(p),session,body,{},f.app);
const buyer=(p:Placed)=>f.http('POST',f.root(p.s)+'/orders/'+p.order.order_ref+'/payment-queries',{},p.cookie);
async function handed(p:Placed){await f.x.h.pool.query('UPDATE commerce_payment_attempts SET journaled_at=clock_timestamp(),handed_off_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1',[p.payment.attempt_ref]);return p;}
async function response(p:Placed,status='0'){
  const a=(await f.x.h.pool.query('SELECT merchant_trade_no FROM commerce_payment_attempts WHERE attempt_id=$1',[p.payment.attempt_ref])).rows[0];
  return encodeForm(signFields({MerchantID:'1234567',MerchantTradeNo:a.merchant_trade_no,TradeStatus:status,...(status==='1'?{TradeNo:'T1234567',TradeAmt:'5',PaymentDate:'2026/10/15 10:20:30',PaymentType:'Credit_CreditCard'}:{})},EcpayKeyPair.of(p.provider.material.hash_key,p.provider.material.hash_iv),'sha256'));
}
async function grant(p:Placed,cap:string){
  const m=await f.x.h.person('合成查詢成員'+randomUUID()),id=await f.x.h.candidate(p.s.owner,m.id);await f.x.h.accept(m.session,p.s.tenantId,await f.x.h.invite(p.s.owner,p.s.tenantId,id,'viewer'));
  const by=(await f.x.h.pool.query('SELECT principal_id FROM principals WHERE user_ref=$1',[p.s.owner.user.user_id])).rows[0].principal_id;
  await f.x.h.pool.query("INSERT INTO tenant_module_permissions(tenant_id,instance_id,principal_id,capabilities,status,granted_by_principal_id) VALUES($1,$2,$3,$4,'active',$5)",[p.s.tenantId,p.s.instanceId,id,['store:read',cap],by]);return m.session;
}
async function clearOrderBudget(p:Placed){await f.x.h.pool.query('DELETE FROM auth_rate_limits WHERE bucket=ANY($1::text[])',[['commerce:paymentQueryOrder:'+hashKey(p.order.order_ref),'commerce:paymentQueryOrderHour:'+hashKey(p.order.order_ref)]]);}
test('seller query uses either orders or finance capability, stamps seller, and releases every client before transport',async()=>{
  const p=await handed(await f.placed()),body=await response(p);let calls=0;
  f.install({commerceQueryTransport:createFixtureQueryTransport(async()=>{calls++;assert.equal(f.x.runtime.totalCount,f.x.runtime.idleCount);const due=(await f.x.h.pool.query("SELECT lease_until FROM commerce_due_work WHERE target_id=$1 AND kind='payment_query'",[p.payment.attempt_ref])).rows[0];assert(due.lease_until);return {kind:'response',status:200,body};},'local')});
  for(const cap of ['store:orders:read','store:finance:read']){
    const session=await grant(p,cap),r=await seller(p,session);assert.equal(r.status,200,JSON.stringify(r.data));const dto=SellerCheckoutOrderSchema.parse(r.data);assert.equal(dto.payment_detail!==null,cap==='store:finance:read');await clearOrderBudget(p);
  }
  assert.equal(calls,2);const events=(await f.x.h.pool.query("SELECT query_trigger FROM commerce_hosted_payment_events WHERE source='query'")).rows;assert.equal(events.length,2);assert(events.every(e=>e.query_trigger==='seller'));
  assert.equal((await f.x.h.pool.query("SELECT count(*)::int n FROM scoped_command_receipts WHERE operation LIKE 'commerce.checkout_order.%'")).rows[0].n,0);
  const names=(await f.x.h.pool.query("SELECT bucket FROM auth_rate_limits WHERE bucket LIKE 'commerce:paymentQuery%'" )).rows.map(r=>r.bucket);assert(!names.some(b=>b.startsWith('commerce:paymentQueryNetwork:')));
});
test('seller and buyer queries share minute and hour order budgets in both directions',async()=>{
  const p=await handed(await f.placed()),body=await response(p);let calls=0;f.install({commerceQueryTransport:createFixtureQueryTransport(async()=>{calls++;return {kind:'response',status:200,body};},'local')});
  assert.equal((await seller(p)).status,200);let denied=await buyer(p);assert.equal(denied.status,429);assert.equal(denied.data.code,'commerce_rate_limited');assert(Number(denied.response.headers.get('Retry-After'))>0);
  await clearOrderBudget(p);assert.equal((await buyer(p)).status,200);denied=await seller(p);assert.equal(denied.status,429);assert.equal(denied.data.code,'commerce_rate_limited');assert(Number(denied.response.headers.get('Retry-After'))>0);assert.equal(calls,2);
  await f.x.h.pool.query("UPDATE auth_rate_limits SET window_start=clock_timestamp()-interval '2 minutes' WHERE bucket=$1",['commerce:paymentQueryOrder:'+hashKey(p.order.order_ref)]);
  await f.x.h.pool.query("UPDATE auth_rate_limits SET attempts=10 WHERE bucket=$1",['commerce:paymentQueryOrderHour:'+hashKey(p.order.order_ref)]);
  assert.equal((await seller(p)).status,429);assert.equal(calls,2);
});
test('authorization failures spend no order or network budget and the attempt-choice transaction rechecks grants',async()=>{
  const p=await handed(await f.placed()),session=await grant(p,'store:customers:read');let calls=0;f.install({commerceQueryTransport:createFixtureQueryTransport(async()=>{calls++;return {kind:'error',code:'network'};},'local')});
  assert.equal((await seller(p,session)).status,403);const foreign=await f.x.store();await f.setup(foreign);assert.equal((await f.x.h.call('POST',foreign.root+'/checkout-orders/'+p.order.order_ref+'/payment-queries',foreign.owner,{}, {},f.app)).status,404);
  assert.equal((await f.x.h.pool.query("SELECT count(*)::int n FROM auth_rate_limits WHERE bucket LIKE 'commerce:paymentQuery%'")).rows[0].n,0);assert.equal(calls,0);
  const actions=f.runtime.commercePorts!.paymentActions!;f.install({commercePorts:{paymentActions:{...actions,async query(pool,input){await f.x.h.pool.query("UPDATE tenant_module_permissions SET capabilities=ARRAY['store:read'] WHERE tenant_id=$1 AND instance_id=$2",[p.s.tenantId,p.s.instanceId]);return actions.query!(pool,input);}}}});
  await f.x.h.pool.query("UPDATE tenant_module_permissions SET capabilities=ARRAY['store:read','store:orders:read'] WHERE tenant_id=$1 AND instance_id=$2",[p.s.tenantId,p.s.instanceId]);
  assert.equal((await seller(p,session)).status,403);assert.equal(calls,0);
});
test('busy lease returns payment_result_pending; unhanded, confirmed, failed and definite mismatches make no call',async()=>{
  const p=await f.placed();let calls=0;f.install({commerceQueryTransport:createFixtureQueryTransport(async()=>{calls++;return {kind:'error',code:'network'};},'local')});
  assert.equal((await seller(p)).status,200);assert.equal(calls,0);await clearOrderBudget(p);await handed(p);
  await f.x.h.pool.query("INSERT INTO commerce_due_work(tenant_id,instance_id,kind,target_id,due_at,lease_until) SELECT tenant_id,instance_id,'payment_query',attempt_id,clock_timestamp(),clock_timestamp()+interval '1 minute' FROM commerce_payment_attempts WHERE attempt_id=$1 ON CONFLICT(kind,target_id) DO UPDATE SET lease_until=excluded.lease_until",[p.payment.attempt_ref]);
  const busy=await seller(p);assert.equal(busy.status,409,JSON.stringify(busy.data));assert.equal(busy.data.code,'payment_result_pending');assert.equal(calls,0);
  await clearOrderBudget(p);await f.x.h.pool.query("UPDATE commerce_payment_attempts SET state='failed',failed_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1",[p.payment.attempt_ref]);assert.equal((await seller(p)).status,200);assert.equal(calls,0);
});
test('a paid seller query returns the current confirmed order; quarantine blocks before budgets and checkout off stays serviceable',async()=>{
  const p=await handed(await f.placed()),body=await response(p,'1');let calls=0;f.install({commerceQueryTransport:createFixtureQueryTransport(async()=>{calls++;assert.equal(f.x.runtime.totalCount,f.x.runtime.idleCount);return {kind:'response',status:200,body};},'local')});
  f.settings.quarantine=true;const blocked=await seller(p);assert.equal(blocked.status,503);assert.equal(blocked.data.code,'commerce_quarantined');assert.equal(calls,0);assert.equal((await f.x.h.pool.query("SELECT count(*)::int n FROM auth_rate_limits WHERE bucket LIKE 'commerce:paymentQuery%'")).rows[0].n,0);
  f.settings.quarantine=false;f.settings.checkoutEnabled=false;const r=await seller(p);assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(SellerCheckoutOrderSchema.parse(r.data).payment_state,'confirmed');assert.equal(calls,1);
  await clearOrderBudget(p);assert.equal((await seller(p)).status,200);assert.equal(calls,1);
});

test('shared attempt choice skips the newest definite mismatch and queries the older superseded handoff; no-attempt orders make no call',async()=>{
  const p=await handed(await f.placed()),body=await response(p);let calls=0;
  const detail=async(orderId=p.order.order_ref)=>{
    const r=await f.x.h.call('GET',p.s.root+'/checkout-orders/'+orderId,p.s.owner,undefined,{},f.app);
    assert.equal(r.status,200,JSON.stringify(r.data));return SellerCheckoutOrderSchema.parse(r.data);
  };
  f.install({commerceQueryTransport:createFixtureQueryTransport(async()=>{calls++;return {kind:'response',status:200,body};},'local')});
  const frozen=await f.x.frozen(p.s,1,{contact:{name:'合成'+randomUUID(),email:randomUUID()+'@example.test',phone:randomUUID().slice(0,8)}}),plain=await f.x.place(p.s,frozen);
  const noAttempt=await f.x.h.call('POST',p.s.root+'/checkout-orders/'+plain.order_id+'/payment-queries',p.s.owner,{}, {},f.app);assert.equal(noAttempt.status,200);assert.equal(calls,0);assert.equal(noAttempt.data.actions.query_payment,false);
  assert.equal((await detail(plain.order_id)).actions.query_payment,false);
  await f.x.h.pool.query("UPDATE commerce_payment_attempts SET state='superseded',superseded_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1",[p.payment.attempt_ref]);
  const latest=(await f.x.h.pool.query(`INSERT INTO commerce_payment_attempts(tenant_id,instance_id,kind,order_id,sequence,account_id,purpose,environment,merchant_id,credential_version,provider,profile,merchant_trade_no,amount_minor,currency)
    SELECT tenant_id,instance_id,kind,order_id,sequence+1,account_id,purpose,environment,merchant_id,credential_version,provider,profile,$2,amount_minor,currency FROM commerce_payment_attempts WHERE attempt_id=$1 RETURNING attempt_id`,[p.payment.attempt_ref,newTradeNumber('F')])).rows[0].attempt_id;
  await f.x.h.pool.query('UPDATE commerce_payment_attempts SET journaled_at=clock_timestamp(),handed_off_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1',[latest]);
  await f.x.h.pool.query(`INSERT INTO commerce_hosted_payment_events(tenant_id,instance_id,account_id,attempt_id,source,outcome,merchant_trade_no,trade_no,trade_amt_minor,query_trigger,credential_version)
    SELECT tenant_id,instance_id,account_id,attempt_id,'query','amount_mismatch',merchant_trade_no,'T1',600,'seller',1 FROM commerce_payment_attempts WHERE attempt_id=$1`,[latest]);
  assert.equal((await detail()).actions.query_payment,true);
  const r=await seller(p);assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(calls,1);const queried=(await f.x.h.pool.query("SELECT attempt_id FROM commerce_hosted_payment_events WHERE source='query' AND outcome='unpaid'")).rows;assert.deepEqual(queried.map(e=>e.attempt_id),[p.payment.attempt_ref]);
  await clearOrderBudget(p);await f.x.h.pool.query("UPDATE commerce_payment_attempts SET state='failed',failed_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1",[p.payment.attempt_ref]);assert.equal((await seller(p)).status,200);assert.equal(calls,1);
  assert.equal((await detail()).actions.query_payment,false);
});
