import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {before,beforeEach,after,test} from 'node:test';
import type {PoolClient} from 'pg';
import {hostedPaymentHarness} from '../e2e/hosted-payment-fixture.js';
import {authenticate} from '../../modules/identity-membership/service.js';
import {bindStore} from '../../modules/agent-commerce/checkout/authority.js';
import {openException} from '../../modules/agent-commerce/checkout/exceptions.js';
import {SellerRefundSchema,SellerRefundListSchema,SellerCheckoutOrderSchema} from '../../contracts/guild-launchpad/v1/hosted-seller-checkout.js';
import {applyConfirmedPayment} from '../../modules/agent-commerce/checkout/payments.js';
let f:Awaited<ReturnType<typeof hostedPaymentHarness>>;
before(async()=>{f=await hostedPaymentHarness('fp_refund',{randomContact:true});});
beforeEach(async()=>f.reset());
after(async()=>f?.stop());
async function placed(){
  // Schema fixtures do not exercise the public network budget.
  await f.x.h.pool.query("DELETE FROM auth_rate_limits WHERE bucket LIKE 'commerce:%'");
  return f.placed();
}
async function payment(){
  const p=await placed();
  const a=await f.x.tx(q=>applyConfirmedPayment(q,{orderId:p.order.order_ref,paymentRef:p.payment.attempt_ref,amountMinor:600,currency:'TWD',simulated:false}));
  const principal=(await f.x.h.pool.query('SELECT principal_id FROM principals WHERE user_ref=$1',[p.s.owner.user.user_id])).rows[0].principal_id;
  return {p,a,principal};
}
async function insert(q:PoolClient,v:Awaited<ReturnType<typeof payment>>,overrides:Record<string,unknown>={},line:number|null=100){
  const data={refund_id:randomUUID(),tenant_id:v.p.s.tenantId,instance_id:v.p.s.instanceId,order_id:v.p.order.order_ref,application_id:v.a.application_id,attempt_id:v.p.payment.attempt_ref,basis:'unapplied_payment',mode:'manual_record',state:'recorded',amount_minor:100,currency:'TWD',refunded_on:'2026-10-16',provider_reference:null,recorded_by_principal_id:v.principal,version:1,...overrides};
  const row=(await q.query(`INSERT INTO commerce_refunds SELECT (jsonb_populate_record(NULL::commerce_refunds,$1::jsonb)).* RETURNING refund_id`,[JSON.stringify({...data,created_at:new Date().toISOString()})])).rows[0];
  if(line!==null)await q.query("INSERT INTO commerce_refund_lines(refund_id,line_no,kind,amount_minor) VALUES($1,1,'unapplied',$2)",[row.refund_id,line]);
  return row.refund_id as string;
}
const constraint=(e:unknown)=>(e as {code?:string}).code==='23514';
test('refund insert guards payment, participant, currency, state, amount, reference and fixed version',async()=>{
  const v=await payment(),other=await payment();
  for(const overrides of [{tenant_id:other.p.s.tenantId},{instance_id:other.p.s.instanceId},{order_id:other.p.order.order_ref},{attempt_id:other.p.payment.attempt_ref},{currency:'USD'},{basis:'order'},{mode:'provider_api'},{state:'confirmed'},{amount_minor:0},{amount_minor:-1},{amount_minor:601},{provider_reference:'personal value'},{provider_reference:'x'.repeat(65)},{version:2}])
    await assert.rejects(f.x.tx(q=>insert(q,v,overrides)),constraint,JSON.stringify(overrides));
  for(const [simulated,amount] of [[true,500],[false,500]] as const){
    const p=await placed(),a=await f.x.tx(q=>applyConfirmedPayment(q,{orderId:p.order.order_ref,paymentRef:p.payment.attempt_ref,amountMinor:amount,currency:'TWD',simulated}));
    await assert.rejects(f.x.tx(q=>insert(q,{...v,p,a})),constraint);
  }
});
test('refund and line ledgers are append only and balanced at commit',async()=>{
  const v=await payment();
  await assert.rejects(f.x.tx(q=>insert(q,v,{},null)),constraint);
  await assert.rejects(f.x.tx(q=>insert(q,v,{},99)),constraint);
  const id=await f.x.tx(q=>insert(q,v));
  for(const table of ['commerce_refunds','commerce_refund_lines'])for(const action of ['UPDATE','DELETE'])
    await assert.rejects(f.x.tx(q=>q.query(action==='UPDATE'?`UPDATE ${table} SET amount_minor=amount_minor WHERE refund_id=$1`:`DELETE FROM ${table} WHERE refund_id=$1`,[id])),constraint);
  await assert.rejects(f.x.tx(q=>q.query("INSERT INTO commerce_refund_lines(refund_id,line_no,kind,amount_minor) VALUES($1,2,'unapplied',1)",[id])),constraint);
  assert.equal((await f.x.h.pool.query('SELECT version::text FROM commerce_refunds WHERE refund_id=$1',[id])).rows[0].version,'1');
});
test('concurrent refunds serialize on the application cap',async()=>{
  const v=await payment(),a=await f.x.runtime.connect(),b=await f.x.runtime.connect();
  try{
    await a.query('BEGIN');await b.query('BEGIN');await insert(a,v,{amount_minor:360},360);
    const second=insert(b,v,{amount_minor:360},360);await a.query('COMMIT');
    await assert.rejects(second,constraint);await b.query('ROLLBACK');
    assert.equal((await f.x.h.pool.query('SELECT sum(amount_minor)::text n FROM commerce_refunds')).rows[0].n,'360');
  }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');a.release();b.release();}
});

async function today(){return (await f.x.h.pool.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Taipei','YYYY-MM-DD') today")).rows[0].today as string;}
const route=(v:Awaited<ReturnType<typeof payment>>)=>v.p.s.root+'/checkout-orders/'+v.p.order.order_ref;
async function record(v:Awaited<ReturnType<typeof payment>>,amount:number,extra:Record<string,unknown>={},key=randomUUID(),session=v.p.s.owner){return f.x.h.call('POST',route(v)+'/refunds',session,{application_ref:v.a.application_id,amount_minor:amount,refunded_on:await today(),...extra},{'Idempotency-Key':key},f.app);}
async function caseFor(v:Awaited<ReturnType<typeof payment>>){return f.x.tx(async q=>{await bindStore(q,v.p.s.tenantId);return openException(q,{tenantId:v.p.s.tenantId,instanceId:v.p.s.instanceId,orderId:v.p.order.order_ref,kind:'amount_mismatch',subjectKind:'payment_attempt',subjectId:v.p.payment.attempt_ref});});}
async function receipts(){for(const r of (await f.x.h.pool.query("SELECT response FROM scoped_command_receipts WHERE operation IN ('commerce.checkout_order.cancel','commerce.exception_case.resolve_with_evidence','commerce.exception_case.retry_allocation','commerce.refund.record')")).rows){assert.deepEqual(Object.keys(r.response),['id']);assert.match(r.response.id,/^[a-f0-9-]{36}$/);}}
test('manual partial/full records cap the unapplied amount, reproject replay, and close the matching case once',async()=>{
  const v=await payment(),c=await caseFor(v),key=randomUUID(),first=await record(v,100,{provider_reference:'F_'+randomUUID().replaceAll('-','')},key);assert.equal(first.status,201,JSON.stringify(first.data));const refund=SellerRefundSchema.parse(first.data);assert.equal(refund.recorded_without_provider,true);assert.equal(first.response.headers.get('ETag'),null);await receipts();
  const replay=await record(v,100,{provider_reference:refund.provider_reference},key);assert.deepEqual(replay.data,first.data);await receipts();
  let order=SellerCheckoutOrderSchema.parse((await f.x.h.call('GET',route(v),v.p.s.owner,undefined,{},f.app)).data);assert.equal(order.payment_state,'overpaid');assert.equal(order.payment_detail?.applications[0].refundable_minor,500);assert.equal(order.exceptions[0].status,'open');
  const full=await record(v,500);assert.equal(full.status,201,JSON.stringify(full.data));await receipts();
  const row=(await f.x.h.pool.query('SELECT * FROM commerce_exception_cases WHERE case_id=$1',[c.case_id])).rows[0];assert.equal(row.status,'resolved');assert.equal(row.resolution_code,'refunded');assert.equal(row.resolution_note,'店家已登記全額退款。');assert.equal(row.resolved_by_principal_id,v.principal);assert.equal(row.version,'2');
  const list=await f.x.h.call('GET',route(v)+'/refunds',v.p.s.owner,undefined,{},f.app);const items=SellerRefundListSchema.parse(list.data).items;assert.equal(items.length,2);assert.deepEqual(items.map(r=>r.amount_minor),[100,500]);
  order=SellerCheckoutOrderSchema.parse((await f.x.h.call('GET',route(v),v.p.s.owner,undefined,{},f.app)).data);assert.equal(order.payment_state,'refunded');assert.equal(order.payment_detail?.applications[0].refundable_minor,0);assert.equal(order.actions.record_refund,false);
  assert.equal((await record(v,100)).data.code,'refund_exceeds_payment');
});
test('manual refund inputs reject foreign, confirmed and simulated applications, invalid unit/zero/cap/date/reference and version headers',async()=>{
  const v=await payment(),other=await payment();
  const rejected=async(amount:number,extra:Record<string,unknown>,status:number,expected:string)=>{const r=await record(v,amount,extra);assert.equal(r.status,status,JSON.stringify(r.data));assert.equal(r.data.code,expected);};
  await rejected(100,{application_ref:other.a.application_id},409,'refund_not_available');
  for(const amount of [0,1,-100])await rejected(amount,{},422,'validation_failed');await rejected(700,{},409,'refund_exceeds_payment');
  for(const refunded_on of ['2000-01-01','9999-12-31','2026-02-29'])await rejected(100,{refunded_on},422,'refund_date_invalid');
  for(const provider_reference of ['contains space','a@example.test','x'.repeat(65),''])await rejected(100,{provider_reference},422,'validation_failed');
  const version=await f.x.h.call('POST',route(v)+'/refunds',v.p.s.owner,{application_ref:v.a.application_id,amount_minor:100,refunded_on:await today()},{'Idempotency-Key':randomUUID(),'If-Match':'"1"'},f.app);assert.equal(version.status,400);assert.equal(version.data.code,'invalid_version');
  for(const simulated of [false,true]){const p=await placed(),a=await f.x.tx(q=>applyConfirmedPayment(q,{orderId:p.order.order_ref,paymentRef:p.payment.attempt_ref,amountMinor:500,currency:'TWD',simulated}));const r=await record({...v,p,a},100);assert.equal(r.status,409);assert.equal(r.data.code,'refund_not_available');}
  f.settings.quarantine=true;await rejected(100,{},503,'commerce_quarantined');assert.equal((await f.x.h.call('GET',route(v)+'/refunds',v.p.s.owner,undefined,{},f.app)).status,200);
  assert.equal((await f.x.h.pool.query('SELECT count(*)::int n FROM commerce_refunds')).rows[0].n,0);
});
test('refund dates use the earliest verified mismatched payment in Taipei and a previously resolved case stays closed',async()=>{
  const v=await payment(),c=await caseFor(v);
  await f.x.h.pool.query(`INSERT INTO commerce_hosted_payment_events(tenant_id,instance_id,account_id,attempt_id,source,outcome,merchant_trade_no,trade_no,trade_amt_minor,payment_date,query_trigger,credential_version)
    SELECT tenant_id,instance_id,account_id,attempt_id,'query','amount_mismatch',merchant_trade_no,'T1',600,'2026-01-01T23:30:00Z','seller',1 FROM commerce_payment_attempts WHERE attempt_id=$1`,[v.p.payment.attempt_ref]);
  const tooEarly=await record(v,100,{refunded_on:'2026-01-01'});assert.equal(tooEarly.data.code,'refund_date_invalid');
  const a=await authenticate(f.x.runtime,v.p.s.owner.cookie.split('=')[1].split(';')[0]);
  const {actOnSellerException}=await import('../../modules/agent-commerce/checkout/seller-exceptions.js');await actOnSellerException(f.x.runtime,a,v.p.s.tenantId,v.p.s.instanceId,c.case_id,'resolve_with_evidence',{code:'refunded',provider_date:await today(),provider_reference:'F1'},randomUUID(),'1');await receipts();
  const recorded=await record(v,600,{refunded_on:'2026-01-02'});assert.equal(recorded.status,201,JSON.stringify(recorded.data));await receipts();
  const resolved=(await f.x.h.pool.query('SELECT version,resolution_note FROM commerce_exception_cases WHERE case_id=$1',[c.case_id])).rows[0];assert.equal(resolved.version,'2');assert.match(resolved.resolution_note,/店家已在綠界後台退款/);
});
test('recording and listing refunds require independent refund and finance capabilities',async()=>{
  const v=await payment();
  for(const cap of ['store:finance:read','store:refund']){
    const m=await f.x.h.person('合成退款成員'+randomUUID()),principal=await f.x.h.candidate(v.p.s.owner,m.id);await f.x.h.accept(m.session,v.p.s.tenantId,await f.x.h.invite(v.p.s.owner,v.p.s.tenantId,principal,'operator'));
    await f.x.h.pool.query(`INSERT INTO tenant_module_permissions(tenant_id,principal_id,instance_id,capabilities,status,granted_by_principal_id) VALUES($1,$2,$3,$4,'active',$5)`,[v.p.s.tenantId,principal,v.p.s.instanceId,['store:read',cap],v.principal]);
    assert.equal((await f.x.h.call('GET',route(v)+'/refunds',m.session,undefined,{},f.app)).status,cap==='store:finance:read'?200:403);
    assert.equal((await record(v,100,{},randomUUID(),m.session)).status,cap==='store:refund'?201:403);await receipts();
  }
});

test('buyer and seller payment axes move from overpaid to refunded or confirmed while re-pay stays disabled',async()=>{
  for(const confirmed of [false,true]){
    const p=await placed();
    if(confirmed)await f.x.tx(q=>applyConfirmedPayment(q,{orderId:p.order.order_ref,paymentRef:p.payment.attempt_ref,amountMinor:500,currency:'TWD',simulated:false}));
    let attempt=p.payment.attempt_ref;
    if(confirmed){
      await f.x.h.pool.query("UPDATE commerce_payment_attempts SET state='paid',trade_no='T1',paid_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1",[attempt]);
      await f.x.h.pool.query("UPDATE commerce_payment_attempts SET state='confirmed',confirmed_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1",[attempt]);
      const {newTradeNumber}=await import('../../modules/agent-commerce/providers/ecpay/index.js');
      attempt=(await f.x.h.pool.query(`INSERT INTO commerce_payment_attempts(tenant_id,instance_id,kind,order_id,sequence,account_id,purpose,environment,merchant_id,credential_version,provider,profile,merchant_trade_no,amount_minor,currency)
        SELECT tenant_id,instance_id,kind,order_id,sequence+1,account_id,purpose,environment,merchant_id,credential_version,provider,profile,$2,amount_minor,currency FROM commerce_payment_attempts WHERE attempt_id=$1 RETURNING attempt_id`,[attempt,newTradeNumber('F')])).rows[0].attempt_id;
    }
    const a=await f.x.tx(q=>applyConfirmedPayment(q,{orderId:p.order.order_ref,paymentRef:attempt,amountMinor:confirmed?500:600,currency:'TWD',simulated:false}));
    const principal=(await f.x.h.pool.query('SELECT principal_id FROM principals WHERE user_ref=$1',[p.s.owner.user.user_id])).rows[0].principal_id,v={p,a,principal};
    const buyer=()=>f.http('GET',f.root(p.s)+'/orders/'+p.order.order_ref,undefined,p.cookie);
    let before=(await buyer()).data;assert.equal(before.payment_state,'overpaid');assert.equal(before.can_resume_payment,false);
    assert.equal((await record(v,confirmed?500:600)).status,201);await receipts();
    const after=(await buyer()).data;assert.equal(after.payment_state,confirmed?'confirmed':'refunded');assert.equal(after.can_resume_payment,false);
    const seller=SellerCheckoutOrderSchema.parse((await f.x.h.call('GET',route(v),p.s.owner,undefined,{},f.app)).data);assert.equal(seller.payment_state,after.payment_state);assert.equal(seller.payment_detail?.applications.find(r=>r.application_ref===a.application_id)?.refundable_minor,0);
  }
});
