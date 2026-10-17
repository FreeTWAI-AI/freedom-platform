import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {before,beforeEach,after,test} from 'node:test';
import {hostedPaymentHarness} from '../e2e/hosted-payment-fixture.js';
import {ports} from './hosted-checkout-harness.js';
import {placeCheckoutOrder,cancelUnpaidOrder} from '../../modules/agent-commerce/checkout/orders.js';
import {applyConfirmedPayment} from '../../modules/agent-commerce/checkout/payments.js';
import {bindStore} from '../../modules/agent-commerce/checkout/authority.js';
import {newTradeNumber,encodeForm,signFields,EcpayKeyPair} from '../../modules/agent-commerce/providers/ecpay/index.js';
import {createFixtureQueryTransport} from '../../modules/agent-commerce/payments/query-transport.js';
import {queryAttempt} from '../../modules/agent-commerce/payments/queries.js';
import {CommerceCredentialKeyring} from '../../modules/agent-commerce/payments/credentials.js';
let f:Awaited<ReturnType<typeof hostedPaymentHarness>>;
type Placed=Awaited<ReturnType<typeof f.placed>>;
before(async()=>{f=await hostedPaymentHarness('fp_payment_repay');});beforeEach(async()=>f.reset());after(async()=>f?.stop());
const attempts=async(p:Placed)=>(await f.x.h.pool.query('SELECT * FROM commerce_payment_attempts WHERE order_id=$1 ORDER BY sequence',[p.order.order_ref])).rows;
const url=(p:Placed)=>f.root(p.s)+'/orders/'+p.order.order_ref;
const resume=(p:Placed)=>f.http('POST',url(p)+'/payment-handoffs',{},p.cookie);
const view=async(p:Placed)=>{const r=await f.http('GET',url(p),undefined,p.cookie);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
/** Insert an old attempt through the ordinary order/hold core. Its identity is
 * never rewritten to advance a clock after creation. */
async function oldAttempt(){
  const ready=await f.readyCheckout();
  const order=await f.x.tx(q=>placeCheckoutOrder(q,ready.s,{checkoutId:ready.checkout.checkout_ref,termsSha256:ready.checkout.terms_sha256,clientOrderId:randomUUID(),buyerPrincipalId:null,environment:'sandbox'},ports));
  const a=(await f.x.h.pool.query(`INSERT INTO commerce_payment_attempts(tenant_id,instance_id,kind,order_id,sequence,account_id,environment,merchant_id,credential_version,merchant_trade_no,amount_minor,currency,created_at)
    VALUES($1,$2,'order',$3,1,$4,'sandbox','1234567',1,$5,500,'TWD',clock_timestamp()-interval '61 seconds') RETURNING *`,[ready.s.tenantId,ready.s.instanceId,order.order_id,ready.provider.accountId,newTradeNumber('F')])).rows[0];
  await f.x.h.pool.query('UPDATE commerce_payment_attempts SET journaled_at=created_at,handed_off_at=created_at,version=version+1 WHERE attempt_id=$1',[a.attempt_id]);
  for(const [kind,minutes] of [['payment_query',10],['payment_window_end',60]] as const)await f.x.h.pool.query('INSERT INTO commerce_due_work(tenant_id,instance_id,kind,target_id,due_at) VALUES($1,$2,$3,$4,$5)',[a.tenant_id,a.instance_id,kind,a.attempt_id,new Date(a.created_at.getTime()+minutes*60_000)]);
  const result=await f.http('GET',f.root(ready.s)+'/orders/'+order.order_id,undefined,ready.cookie);assert.equal(result.status,200);
  return {...ready,order:result.data,payment:{attempt_ref:a.attempt_id,handoff_url:'',expires_at:''}} as Placed;
}
function install(p:Placed,status='0',error?:'timeout'|'network'){
  let calls=0;
  const transport=createFixtureQueryTransport(async req=>{calls++;return error?{kind:'error',code:error}:{kind:'response',status:200,body:encodeForm(signFields({MerchantID:'1234567',MerchantTradeNo:new URLSearchParams(req.bodyText()).get('MerchantTradeNo')!,TradeStatus:status,TradeNo:'T1234567',TradeAmt:'5'},EcpayKeyPair.of(p.provider.material.hash_key,p.provider.material.hash_iv),'sha256'))};},'local');
  f.install({commerceQueryTransport:transport});return {transport,get calls(){return calls;}};
}
async function failed(p:Placed){await f.x.h.pool.query("UPDATE commerce_payment_attempts SET state='failed',failed_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1",[p.payment.attempt_ref]);}
async function expectFailure(p:Placed,code:string){const r=await resume(p);assert.equal(r.status,409,JSON.stringify(r.data));assert.equal(r.data.code,code);return r;}
async function notify(p:Placed,rtnCode:string){
  const attempt=(await attempts(p))[0],body=encodeForm(signFields({MerchantID:'1234567',MerchantTradeNo:attempt.merchant_trade_no,
    TradeNo:'T1234567',RtnCode:rtnCode,RtnMsg:'合成付款結果',TradeAmt:'5',SimulatePaid:'0',PaymentDate:'2026/10/15 10:20:30',PaymentType:'Credit_CreditCard'},
    EcpayKeyPair.of(p.provider.material.hash_key,p.provider.material.hash_iv),'sha256'));
  const request=new Request(f.origin+'/api/v1/provider-callbacks/ecpay/'+p.provider.accountRef+'/payment',
    {method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','CF-Connecting-IP':'192.0.2.1'},body});
  Object.defineProperty(request,'cf',{value:{colo:'TEST'}});
  const response=await f.app.fetch(request);assert.equal(response.status,200);assert.equal(await response.text(),'1|OK');
}
test('a pending confirmation followed by a failed notification permits re-pay and its DTO',async()=>{
  const p=await oldAttempt();await notify(p,'10300066');await notify(p,'0');const t=install(p);
  assert.equal((await attempts(p))[0].state,'failed');
  const dto=await view(p);assert.equal(dto.payment_state,'unpaid');assert.equal(dto.can_resume_payment,true);
  const result=await resume(p);assert.equal(result.status,201,JSON.stringify(result.data));
  const rows=await attempts(p);assert.equal(rows.length,2);assert.equal(rows[1].sequence,2);assert.equal(result.data.attempt_ref,rows[1].attempt_id);assert.equal(t.calls,0);
});
test('an unresolved pending confirmation still blocks re-pay and its DTO',async()=>{
  const p=await oldAttempt();await notify(p,'10300066');const t=install(p);
  const dto=await view(p);assert.equal(dto.payment_state,'pending');assert.equal(dto.can_resume_payment,false);
  await expectFailure(p,'payment_result_pending');assert.equal((await attempts(p)).length,1);assert.equal(t.calls,0);
});
test('an unconsumed attempt resumes with one new token and no new attempt',async()=>{
  const p=await f.placed(),t=install(p);assert.equal((await view(p)).can_resume_payment,true);
  const r=await resume(p);assert.equal(r.status,201,JSON.stringify(r.data));assert.equal(r.data.attempt_ref,p.payment.attempt_ref);assert.notEqual(r.data.handoff_url,p.payment.handoff_url);assert.equal((await attempts(p)).length,1);assert.equal(t.calls,0);assert.equal(r.response.headers.get('Cache-Control'),'no-store');assert.equal(r.response.headers.get('Referrer-Policy'),'no-referrer');
});
const queryBudgets=async()=>(await f.x.h.pool.query("SELECT * FROM auth_rate_limits WHERE bucket LIKE 'commerce:paymentQueryOrder:%' OR bucket LIKE 'commerce:paymentQueryOrderHour:%' ORDER BY bucket")).rows;
async function breakHandoff(p:Placed,reason:'credential'|'route',transport:ReturnType<typeof install>['transport']){
  if(reason==='credential')f.install({commerceQueryTransport:transport,commerceCredentialKeyring:CommerceCredentialKeyring.parse('different:'+randomBytes(32).toString('base64'))});
  else await f.x.h.pool.query("UPDATE commerce_entry_routes SET revoked_at=clock_timestamp() WHERE route_kind='provider_account' AND target_id=$1",[p.provider.accountId]);
}
function expectUnavailable(result:Awaited<ReturnType<typeof resume>>){
  assert.equal(result.status,503,JSON.stringify(result.data));assert.equal(result.data.code,'payment_handoff_unavailable');
  assert.equal(result.data.detail,'付款服務暫時無法使用。');assert.equal(result.response.headers.get('Retry-After'),null);
}
for(const reason of ['credential','route'] as const)test(`an unhanded ${reason} failure returns the handoff error without re-pay side effects`,async()=>{
  const p=await f.placed(),t=install(p);await breakHandoff(p,reason,t.transport);
  const before=await attempts(p),budgetBefore=await queryBudgets();assert.equal((await view(p)).can_resume_payment,true);
  expectUnavailable(await resume(p));assert.deepEqual(await attempts(p),before);assert.deepEqual(await queryBudgets(),budgetBefore);assert.equal(t.calls,0);
});
for(const reason of ['credential','route'] as const)test(`a new re-pay attempt rolls back on its ${reason} handoff failure`,async()=>{
  const p=await oldAttempt();await failed(p);const t=install(p);await breakHandoff(p,reason,t.transport);
  const before=await attempts(p),budgetBefore=await queryBudgets(),workBefore=(await f.x.h.pool.query('SELECT * FROM commerce_due_work ORDER BY due_work_id')).rows;
  expectUnavailable(await resume(p));assert.deepEqual(await attempts(p),before);assert.deepEqual(await queryBudgets(),budgetBefore);
  assert.deepEqual((await f.x.h.pool.query('SELECT * FROM commerce_due_work ORDER BY due_work_id')).rows,workBefore);assert.equal(t.calls,0);
});
for(const condition of ['closed','holds','overpaid','exhausted'] as const)test(`an unhanded credential failure preserves the earlier ${condition} answer`,async()=>{
  const p=await f.placed(),t=install(p);
  if(condition==='closed')await f.x.tx(async q=>{await bindStore(q,p.s.tenantId);await cancelUnpaidOrder(q,p.s,p.order.order_ref,'buyer','buyer_cancelled');});
  if(condition==='holds')await f.x.tx(async q=>{const {checkoutInventory}=await import('../../modules/agent-commerce/checkout/inventory.js');await bindStore(q,p.s.tenantId);await (await checkoutInventory(q,p.order.order_ref)).releaseHolds();});
  if(condition==='overpaid')await f.x.tx(async q=>{await bindStore(q,p.s.tenantId);await applyConfirmedPayment(q,{orderId:p.order.order_ref,paymentRef:randomUUID(),amountMinor:600,currency:'TWD',simulated:false});});
  if(condition==='exhausted')for(let sequence=2;sequence<=5;sequence++){
    await failed({...p,payment:{...p.payment,attempt_ref:(await attempts(p)).at(-1)!.attempt_id}});assert.equal((await resume(p)).status,201);
  }
  await breakHandoff(p,'credential',t.transport);const before=await attempts(p);
  await expectFailure(p,condition==='closed'?'checkout_order_closed':condition==='holds'?'checkout_hold_expired':condition==='overpaid'?'payment_already_applied':'payment_attempts_exhausted');
  assert.deepEqual(await attempts(p),before);assert.deepEqual(await queryBudgets(),[]);assert.equal(t.calls,0);
});
test('a concurrent re-pay handoff preserves its route failure instead of returning pending',async()=>{
  const p=await oldAttempt();let release!:()=>void,entered!:()=>void,calls=0;
  const waiting=new Promise<void>(resolve=>{release=resolve;}),sent=new Promise<void>(resolve=>{entered=resolve;});
  const transport=createFixtureQueryTransport(async request=>{calls++;entered();await waiting;return {kind:'response',status:200,body:encodeForm(signFields({MerchantID:'1234567',MerchantTradeNo:new URLSearchParams(request.bodyText()).get('MerchantTradeNo')!,TradeStatus:'0'},EcpayKeyPair.of(p.provider.material.hash_key,p.provider.material.hash_iv),'sha256'))};},'local');
  f.install({commerceQueryTransport:transport});const pending=resume(p);
  try{
    await sent;await failed(p);const other=await resume(p);assert.equal(other.status,201,JSON.stringify(other.data));
    await breakHandoff(p,'route',transport);const before=await attempts(p);
    const routesBefore=(await f.x.h.pool.query("SELECT * FROM commerce_entry_routes WHERE route_kind='payment_handoff' ORDER BY route_key")).rows;
    release();expectUnavailable(await pending);assert.deepEqual(await attempts(p),before);
    assert.deepEqual((await f.x.h.pool.query("SELECT * FROM commerce_entry_routes WHERE route_kind='payment_handoff' ORDER BY route_key")).rows,routesBefore);assert.equal(calls,1);
  }finally{release();await pending;}
});
test('a live unpaid query supersedes the old attempt and issues attempt two with its own deadlines',async()=>{
  const p=await oldAttempt(),t=install(p);assert.equal((await view(p)).can_resume_payment,true);
  const r=await resume(p);assert.equal(r.status,201,JSON.stringify(r.data));assert.equal(t.calls,1);
  const rows=await attempts(p);assert.equal(rows.length,2);assert.equal(rows[0].state,'superseded');assert.equal(rows[1].state,'issued');assert.equal(rows[1].sequence,2);assert.notEqual(rows[0].merchant_trade_no,rows[1].merchant_trade_no);assert.equal(r.data.attempt_ref,rows[1].attempt_id);
  const work=(await f.x.h.pool.query('SELECT kind,due_at FROM commerce_due_work WHERE target_id=$1 ORDER BY due_at',[rows[1].attempt_id])).rows;
  assert.deepEqual(work.map(w=>w.kind),['payment_query','payment_window_end']);assert.deepEqual(work.map(w=>w.due_at.getTime()-rows[1].created_at.getTime()),[600_000,3600_000]);
});
test('a failed attempt re-pays without calling the provider',async()=>{
  const p=await oldAttempt();await failed(p);const t=install(p);assert.equal((await view(p)).can_resume_payment,true);
  const r=await resume(p);assert.equal(r.status,201,JSON.stringify(r.data));assert.equal(t.calls,0);const rows=await attempts(p);assert.equal(rows.length,2);assert.equal(rows[0].state,'failed');assert.equal(rows[1].state,'issued');
});
for(const reason of ['unknown','transport','lease'] as const)test(`${reason} returns payment_result_pending without creating an attempt`,async()=>{
  const p=await oldAttempt(),t=install(p,reason==='unknown'?'777':'0',reason==='transport'?'network':undefined);
  if(reason==='lease')await f.x.h.pool.query("UPDATE commerce_due_work SET lease_until=clock_timestamp()+interval '1 minute' WHERE target_id=$1 AND kind='payment_query'",[p.payment.attempt_ref]);
  assert.equal((await view(p)).can_resume_payment,true);await expectFailure(p,'payment_result_pending');assert.equal((await attempts(p)).length,1);assert.equal(t.calls,reason==='lease'?0:1);
});
test('a paid live query applies payment before refusing re-pay',async()=>{
  const p=await oldAttempt(),t=install(p,'1');await expectFailure(p,'payment_already_applied');assert.equal(t.calls,1);
  assert.equal((await attempts(p))[0].state,'confirmed');assert.equal((await view(p)).payment_state,'confirmed');assert.equal((await view(p)).can_resume_payment,false);
  assert.equal((await f.x.h.pool.query('SELECT count(*)::int n FROM commerce_checkout_payment_applications WHERE order_id=$1',[p.order.order_ref])).rows[0].n,1);
});
test('the first sixty seconds carry Retry-After and hide re-pay in the DTO',async()=>{
  const p=await f.placed();await f.x.h.pool.query('UPDATE commerce_payment_attempts SET journaled_at=clock_timestamp(),handed_off_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1',[p.payment.attempt_ref]);const t=install(p);
  assert.equal((await view(p)).can_resume_payment,false);const r=await expectFailure(p,'payment_result_pending');const retry=Number(r.response.headers.get('Retry-After'));assert(retry>=1&&retry<=60);assert.equal(t.calls,0);
});
for(const condition of ['closed','holds','paid','confirmed','overpaid','pending_paid','pending_confirmation'] as const)test(`re-pay condition ${condition} has its prescribed failure and DTO`,async()=>{
  const p=await oldAttempt(),t=install(p);
  if(condition==='closed')await f.x.tx(async q=>{await bindStore(q,p.s.tenantId);await cancelUnpaidOrder(q,p.s,p.order.order_ref,'buyer','buyer_cancelled');});
  if(condition==='holds')await f.x.tx(async q=>{const {checkoutInventory}=await import('../../modules/agent-commerce/checkout/inventory.js');await bindStore(q,p.s.tenantId);await (await checkoutInventory(q,p.order.order_ref)).releaseHolds();});
  if(['paid','confirmed'].includes(condition)){
    await f.x.h.pool.query("UPDATE commerce_payment_attempts SET state='paid',paid_at=clock_timestamp(),trade_no='T1234567',version=version+1 WHERE attempt_id=$1",[p.payment.attempt_ref]);
    if(condition==='confirmed')await f.x.h.pool.query("UPDATE commerce_payment_attempts SET state='confirmed',confirmed_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1",[p.payment.attempt_ref]);
  }
  if(condition==='overpaid')await f.x.tx(async q=>{await bindStore(q,p.s.tenantId);await applyConfirmedPayment(q,{orderId:p.order.order_ref,paymentRef:randomUUID(),amountMinor:600,currency:'TWD',simulated:false});});
  if(condition==='pending_paid'||condition==='pending_confirmation')await f.x.h.pool.query(`INSERT INTO commerce_hosted_payment_events(tenant_id,instance_id,account_id,attempt_id,source,outcome,merchant_trade_no,trade_no,payment_date,trade_amt_minor,rtn_code,simulate_paid,credential_version,body_sha256,dedupe_key)
    SELECT tenant_id,instance_id,account_id,attempt_id,'notification',$2,merchant_trade_no,'T1234567',clock_timestamp(),500,CASE WHEN $2='paid' THEN 1 ELSE 10300066 END,false,credential_version,repeat('a',64),repeat('b',64) FROM commerce_payment_attempts WHERE attempt_id=$1`,[p.payment.attempt_ref,condition==='pending_paid'?'paid':'pending_confirmation']);
  assert.equal((await view(p)).can_resume_payment,false);
  await expectFailure(p,condition==='closed'?'checkout_order_closed':condition==='holds'?'checkout_hold_expired':['paid','confirmed','overpaid'].includes(condition)?'payment_already_applied':'payment_result_pending');assert.equal(t.calls,0);
});
test('attempt five can be created and a sixth is refused',async()=>{
  const p=await oldAttempt(),t=install(p);
  for(let sequence=2;sequence<=5;sequence++){
    const latest=(await attempts(p)).at(-1)!;await failed({...p,payment:{...p.payment,attempt_ref:latest.attempt_id}});assert.equal((await view(p)).can_resume_payment,true);
    const r=await resume(p);assert.equal(r.status,201,JSON.stringify(r.data));assert.equal((await attempts(p)).at(-1)!.sequence,sequence);
  }
  await failed({...p,payment:{...p.payment,attempt_ref:(await attempts(p)).at(-1)!.attempt_id}});
  assert.equal((await view(p)).can_resume_payment,false);await expectFailure(p,'payment_attempts_exhausted');assert.equal((await attempts(p)).length,5);assert.equal(t.calls,0);
});
test('concurrent re-pays of a failed attempt create one new attempt',async()=>{
  const p=await oldAttempt();await failed(p);install(p);
  const results=await Promise.all([resume(p),resume(p)]);assert(results.every(r=>r.status===201),JSON.stringify(results.map(r=>r.data)));
  assert.equal(results[0].data.attempt_ref,results[1].data.attempt_ref);assert.equal((await attempts(p)).length,2);
});
test('a late superseded payment applies and a second paid attempt becomes overpaid',async()=>{
  const p=await oldAttempt();install(p);assert.equal((await resume(p)).status,201);const rows=await attempts(p);
  const t=install(p,'1').transport;
  await queryAttempt(f.x.runtime,rows[0].attempt_id,{transport:t,keyring:f.ring,freedomEnv:'local'},'buyer');
  await f.x.h.pool.query('UPDATE commerce_payment_attempts SET journaled_at=clock_timestamp(),handed_off_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1',[rows[1].attempt_id]);
  await queryAttempt(f.x.runtime,rows[1].attempt_id,{transport:t,keyring:f.ring,freedomEnv:'local'},'buyer');
  assert.deepEqual((await f.x.h.pool.query('SELECT outcome FROM commerce_checkout_payment_applications WHERE order_id=$1 ORDER BY created_at',[p.order.order_ref])).rows.map(r=>r.outcome),['converted','overpaid']);
  const dto=await view(p);assert.equal(dto.payment_state,'overpaid');assert.equal(dto.can_resume_payment,false);
});
for(const gate of ['quarantine','checkout','profile','gateway','keyring','service','admission'] as const)test(`re-pay DTO applies the ${gate} gate without querying or charging budgets`,async()=>{
  const p=await oldAttempt();await failed(p);const t=install(p);
  if(gate==='quarantine')f.settings.quarantine=true;
  if(gate==='checkout')f.settings.checkoutEnabled=false;
  if(gate==='profile'){f.settings.providerProfiles=[];f.install({commerceQueryTransport:t.transport});}
  if(gate==='gateway')f.install({commercePayments:{journal:f.journal,profiles:f.settings.providerProfiles},commerceQueryTransport:t.transport});
  if(gate==='keyring')f.install({commerceCredentialKeyring:null,commerceQueryTransport:t.transport});
  if(gate==='service')await f.x.h.pool.query("UPDATE commerce_provider_account_services SET state='suspended',version=version+1,updated_at=clock_timestamp() WHERE account_id=$1 AND purpose='payment'",[p.provider.accountId]);
  if(gate==='admission')await f.x.h.pool.query("UPDATE commerce_store_admissions SET revoked_at=clock_timestamp(),revoked_by=admitted_by,revoke_reason='synthetic test' WHERE admission_id=$1",[p.provider.admissionId]);
  const before=(await f.x.h.pool.query('SELECT * FROM auth_rate_limits ORDER BY bucket')).rows;
  assert.equal((await view(p)).can_resume_payment,false);
  assert.deepEqual((await f.x.h.pool.query('SELECT * FROM auth_rate_limits ORDER BY bucket')).rows,before);assert.equal(t.calls,0);
});
test('eligible summary reads neither sealed credentials nor provider routes',async()=>{
  const p=await oldAttempt();await failed(p);const t=install(p),connect=f.x.runtime.connect;
  f.x.runtime.connect=(async()=>{const q=await (connect as Function).call(f.x.runtime),query=q.query,release=q.release;
    q.query=(async(...args:unknown[])=>{const sql=String(args[0]);assert(!sql.includes('SELECT c.* FROM commerce_provider_credentials'));assert(!sql.includes('commerce_entry_routes'));return (query as Function).apply(q,args);}) as typeof q.query;
    q.release=(error?:Error|boolean)=>{q.query=query;q.release=release;release.call(q,error);};return q;}) as typeof f.x.runtime.connect;
  try{assert.equal((await view(p)).can_resume_payment,true);assert.equal(t.calls,0);}finally{f.x.runtime.connect=connect;}
});
test('re-pay live queries and buyer on-demand queries share the order budget',async()=>{
  const p=await oldAttempt(),t=install(p);assert.equal((await resume(p)).status,201);assert.equal(t.calls,1);
  const r=await f.http('POST',url(p)+'/payment-queries',{},p.cookie);assert.equal(r.status,429,JSON.stringify(r.data));assert.equal(r.data.code,'commerce_rate_limited');assert(Number(r.response.headers.get('Retry-After'))>0);assert.equal(t.calls,1);
});
