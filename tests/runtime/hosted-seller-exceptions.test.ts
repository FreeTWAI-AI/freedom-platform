import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {before,beforeEach,after,test} from 'node:test';
import {hostedPaymentHarness} from '../e2e/hosted-payment-fixture.js';
import {authenticate} from '../../modules/identity-membership/service.js';
import {createTenantListCursorCodec} from '../../packages/shared/tenant-list-cursor.js';
import {bindStore} from '../../modules/agent-commerce/checkout/authority.js';
import {openException,type PaymentExceptionKind} from '../../modules/agent-commerce/checkout/exceptions.js';
import {CASE_RESOLUTION_CODES} from '../../modules/agent-commerce/checkout/seller-orders.js';
import {actOnSellerException,readSellerException,listSellerExceptions,validateSellerDate,ResolveWithEvidenceInputSchema} from '../../modules/agent-commerce/checkout/seller-exceptions.js';
import {settleDueCheckoutHolds} from '../../modules/agent-commerce/checkout/settlement.js';
import {applyConfirmedPayment} from '../../modules/agent-commerce/checkout/payments.js';
import {code} from './hosted-checkout-harness.js';
let f:Awaited<ReturnType<typeof hostedPaymentHarness>>;
before(async()=>{f=await hostedPaymentHarness('fp_seller_exceptions');});
beforeEach(async()=>{await f.reset();f.install({tenantListCursors:createTenantListCursorCodec(randomBytes(32).toString('base64url'),{environment:'local',origin:f.origin})});});
after(async()=>f?.stop());
async function fixture(){const p=await f.placed(),actor=await authenticate(f.x.runtime,p.s.owner.cookie.split('=')[1].split(';')[0]);return {...p,actor};}
async function open(p:Awaited<ReturnType<typeof fixture>>,kind:PaymentExceptionKind,order=true,subject=p.payment.attempt_ref){return f.x.tx(async q=>{await bindStore(q,p.s.tenantId);return openException(q,{tenantId:p.s.tenantId,instanceId:p.s.instanceId,orderId:order?p.order.order_ref:null,kind,subjectKind:'payment_attempt',subjectId:subject});});}
const read=(p:Awaited<ReturnType<typeof fixture>>,id:string)=>readSellerException(f.x.runtime,p.actor,p.s.tenantId,p.s.instanceId,id);
const act=(p:Awaited<ReturnType<typeof fixture>>,id:string,action:'resolve_with_evidence'|'retry_allocation',body:unknown,version='1',key=randomUUID())=>actOnSellerException(f.x.runtime,p.actor,p.s.tenantId,p.s.instanceId,id,action,body,key,version,{settings:f.settings});
async function today(){return (await f.x.h.pool.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Taipei','YYYY-MM-DD') today")).rows[0].today;}
test('all payment kinds expose only their legal actions and resolution codes; fixed notes and reference-only receipts',async()=>{
  const p=await fixture();
  for(const kind of Object.keys(CASE_RESOLUTION_CODES) as PaymentExceptionKind[]){
    const c=await open(p,kind),v=await read(p,c.case_id);
    assert.deepEqual(v.allowed_actions,kind==='paid_unallocatable'?['retry_allocation']:['resolve_with_evidence']);assert.deepEqual(v.resolution_codes,CASE_RESOLUTION_CODES[kind]);
    if(kind==='paid_unallocatable') {await assert.rejects(act(p,c.case_id,'resolve_with_evidence',{code:'confirmed'}),code('exception_action_unavailable'));continue;}
    await assert.rejects(act(p,c.case_id,'retry_allocation',{}),code('exception_action_unavailable'));
    const good=CASE_RESOLUTION_CODES[kind].includes('refunded')?'refunded':'checked_with_provider',wrong=good==='refunded'?'checked_with_provider':'refunded',evidence={provider_date:await today(),provider_reference:'fixture_'+randomBytes(8).toString('hex')};
    await assert.rejects(act(p,c.case_id,'resolve_with_evidence',{code:wrong,...evidence}),code('resolution_code_invalid'));
    const key=randomUUID(),resolved=await act(p,c.case_id,'resolve_with_evidence',{code:good,...evidence},'1',key);
    assert.equal(resolved.status,'resolved');assert.equal(resolved.version,'2');assert.equal(resolved.resolution?.code,good);assert.match(resolved.resolution!.note,new RegExp(good==='refunded'?'^店家已在綠界後台退款':'^店家已在綠界後台核對'));
    assert.equal(resolved.resolution?.resolved_by,(await f.x.h.pool.query('SELECT principal_id FROM principals WHERE user_ref=$1',[p.s.owner.user.user_id])).rows[0].principal_id);
    assert.equal((await act(p,c.case_id,'resolve_with_evidence',{code:good,...evidence},'1',key)).version,'2');
    await assert.rejects(act(p,c.case_id,'resolve_with_evidence',{code:good,...evidence},'2'),code('exception_action_unavailable'));
    assert.deepEqual(resolved.allowed_actions,[]);assert.deepEqual(resolved.resolution_codes,[]);
  }
  const receipts=(await f.x.h.pool.query("SELECT response FROM scoped_command_receipts WHERE operation LIKE 'commerce.exception_case.%'")).rows;assert.equal(receipts.length,6);for(const r of receipts)assert.deepEqual(Object.keys(r.response),['id']);
});
test('evidence calendar validation uses Taipei today, rejects future/invalid dates, personal text and unknown keys',async()=>{
  for(const instant of ['2026-10-15T23:30:00Z','2026-10-16T00:30:00Z']){
    const day=(await f.x.h.pool.query("SELECT to_char($1::timestamptz AT TIME ZONE 'Asia/Taipei','YYYY-MM-DD') AS calendar_date",[instant])).rows[0].calendar_date;
    assert.doesNotThrow(()=>validateSellerDate('2026-10-16',day));assert.throws(()=>validateSellerDate('2026-10-17',day),code('validation_failed'));
  }
  for(const value of ['2026-02-29','2026-04-31','2026-1-01','0000-01-01','2026-10-16\n'])assert.equal(ResolveWithEvidenceInputSchema.safeParse({code:'refunded',provider_date:value,provider_reference:'F1'}).success,false);
  for(const ref of ['name value','a@example.test','', 'x'.repeat(65),'F1\n'])assert.equal(ResolveWithEvidenceInputSchema.safeParse({code:'refunded',provider_date:'2026-10-16',provider_reference:ref}).success,false);
  assert.equal(ResolveWithEvidenceInputSchema.safeParse({code:'confirmed',note:'no free text'}).success,false);
  const p=await fixture(),c=await open(p,'amount_mismatch');await assert.rejects(act(p,c.case_id,'resolve_with_evidence',{code:'refunded',provider_date:'9999-12-31',provider_reference:'F1'}),code('validation_failed'));
});
test('confirmed evidence requires the subject attempt to be confirmed',async()=>{
  const p=await fixture(),c=await open(p,'payment_unconfirmed');await assert.rejects(act(p,c.case_id,'resolve_with_evidence',{code:'confirmed'}),code('payment_not_confirmed'));
  await f.x.h.pool.query("UPDATE commerce_payment_attempts SET state='paid',trade_no='T1',paid_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1",[p.payment.attempt_ref]);
  await f.x.h.pool.query("UPDATE commerce_payment_attempts SET state='confirmed',confirmed_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1",[p.payment.attempt_ref]);
  const v=await act(p,c.case_id,'resolve_with_evidence',{code:'confirmed'});assert.equal(v.resolution?.note,'付款已向綠界確認。');
});
test('exception lists include orderless cases and bind open/closed cursors to their ordered view',async()=>{
  const p=await fixture(),ids=[];
  for(let i=0;i<3;i++)ids.push((await open(p,'unmatched_payment',false,randomUUID())).case_id);
  const list=(q:unknown)=>listSellerExceptions(f.x.runtime,p.actor,p.s.tenantId,p.s.instanceId,q,{cursors:f.runtime.tenantListCursors});
  const first=await list({view:'retailer',limit:'2'}),second=await list({view:'retailer',cursor:first.next_cursor});
  assert.deepEqual([...first.items,...second.items].map(r=>r.case_ref),ids);for(const v of [...first.items,...second.items])assert.equal(v.order,null);
  await assert.rejects(list({}));await assert.rejects(list({view:'executor'}));await assert.rejects(list({view:'retailer',unknown:'x'}));
  await assert.rejects(list({view:'retailer',state:'closed',cursor:first.next_cursor}),code('invalid_cursor'));
  for(const id of ids)await act(p,id,'resolve_with_evidence',{code:'checked_with_provider',provider_date:await today(),provider_reference:'F1'});
  assert.deepEqual((await list({view:'retailer',state:'closed'})).items.map(v=>v.case_ref),[...ids].reverse());
});
test('allocation retry and case closing commit together; stock or post-allocation version failure leaves both unchanged',async()=>{
  const s=await f.x.store(5);await f.setup(s);const due=await f.x.due(s),a=await authenticate(f.x.runtime,s.owner.cookie.split('=')[1].split(';')[0]);
  await f.x.tx(q=>settleDueCheckoutHolds(q,[s.product.product_id]));await f.x.h.pool.query('UPDATE commerce_items SET stock=0 WHERE item_id=$1',[s.product.product_id]);
  await f.x.tx(q=>applyConfirmedPayment(q,{orderId:due.order_id,paymentRef:randomUUID(),amountMinor:500,currency:'TWD',simulated:false}));
  const c=await f.x.tx(async q=>{await bindStore(q,s.tenantId);return openException(q,{tenantId:s.tenantId,instanceId:s.instanceId,orderId:due.order_id,kind:'paid_unallocatable',subjectKind:'payment_attempt',subjectId:randomUUID()});});
  const retry=(version='1')=>actOnSellerException(f.x.runtime,a,s.tenantId,s.instanceId,c.case_id,'retry_allocation',{},randomUUID(),version);
  await assert.rejects(retry(),code('stock_unavailable'));
  await f.x.h.pool.query('UPDATE commerce_items SET stock=5 WHERE item_id=$1',[s.product.product_id]);await assert.rejects(retry('2'),code('version_conflict'));
  assert.equal((await f.x.h.pool.query('SELECT count(*)::int n FROM commerce_inventory_allocations WHERE order_id=$1',[due.order_id])).rows[0].n,0);
  assert.equal((await readSellerException(f.x.runtime,a,s.tenantId,s.instanceId,c.case_id)).status,'open');
  const v=await retry();assert.equal(v.resolution?.code,'allocated');assert.equal(v.resolution?.note,'補貨後已重新配貨。');assert.equal(v.version,'2');
  assert.equal((await f.x.h.pool.query('SELECT quantity FROM commerce_inventory_allocations WHERE order_id=$1',[due.order_id])).rows[0].quantity,5);
});
