import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {before,beforeEach,after,test} from 'node:test';
import type {PoolClient} from 'pg';
import {hostedPaymentHarness} from '../e2e/hosted-payment-fixture.js';
import {applyConfirmedPayment} from '../../modules/agent-commerce/checkout/payments.js';
let f:Awaited<ReturnType<typeof hostedPaymentHarness>>;
before(async()=>{f=await hostedPaymentHarness('fp_refund');});
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
