import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {after,before,beforeEach,test} from 'node:test';
import type {PoolClient} from 'pg';
import {applyConfirmedPayment,placeCheckoutOrder,recordHandover,cancelUnpaidOrder,settleDueCheckoutHolds} from '../../modules/agent-commerce/checkout/index.js';
import {checkoutHarness,ports,ok,code,type CheckoutHarness} from './hosted-checkout-harness.js';
let x:CheckoutHarness;
before(async()=>{x=await checkoutHarness('fp_checkout_races');});beforeEach(async()=>x.reset());after(async()=>x?.stop());
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
/** Gate AFTER the real community lock, then observe the contender's real SQL
 * blocker before releasing it. No mocked balances, sleeps or expiry waits. */
async function gated<T>(run:(q:PoolClient)=>Promise<T>){
  const q=await x.runtime.connect(),pid=(await q.query('SELECT pg_backend_pid() pid')).rows[0].pid as number;
  const locked=deferred(),release=deferred(),original=q.query.bind(q);let stopped=false;
  q.query=(async(...args:any[])=>{
    const result=await (original as any)(...args),text=typeof args[0]==='string'?args[0]:args[0]?.text;
    if(!stopped&&text?.includes('pg_advisory_xact_lock')&&args[1]?.[0]?.startsWith('commerce-orders/')){stopped=true;locked.resolve();await release.promise;}
    return result;
  }) as typeof q.query;
  const result=(async()=>{try{await q.query('BEGIN');const value=await run(q);await q.query('COMMIT');return value;}catch(e){await q.query('ROLLBACK');throw e;}finally{q.query=original;q.release();}})();
  // Attach rejection handling before an assertion can abort the orchestration.
  void result.catch(()=>{});return {locked:locked.promise,release:release.resolve,result,pid};
}
async function blockedBy(pid:number){
  const deadline=performance.now()+15000;
  while(performance.now()<deadline){
    const seen=await x.h.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND $1=ANY(pg_blocking_pids(pid))",[pid]);
    if(seen.rowCount)return;
  }
  assert.fail('contender never reached the real PostgreSQL lock barrier');
}
const pay=(q:PoolClient,id:string,ref=randomUUID())=>applyConfirmedPayment(q,{orderId:id,paymentRef:ref,amountMinor:500,currency:'TWD',simulated:false});
async function externalStores(){
  const a=await x.store(),b=await x.store(10,false),c=await x.store(10,false);
  const offer=ok(await x.send(a,`/products/${a.product.product_id}/supply-offer`,{},a.product.version));
  for(const s of [b,c]){
    const proposal=ok(await x.send(s,'/distribution-selections',{offer_id:offer.offer_id,terms_sha256:offer.terms_sha256,retail_price_minor:100}),201);
    ok(await x.send(a,`/supply-requests/${proposal.selection_id}/decision`,{decision:'accepted',listing_sha256:proposal.listing_sha256},proposal.version));
    await x.publish(s);s.product={...a.product,sku:'P0001'};
  }return {a,b,c,offer};
}
test('stock 10, two stores 6 + 5: the winning six pays and the loser observes available four',async()=>{
  const {a,b,c}=await externalStores(),cb=await x.frozen(b,6),cc=await x.frozen(c,5);
  const winner=await gated(async q=>{const o=await placeCheckoutOrder(q,b,{checkoutId:cb.checkout_id,termsSha256:cb.terms_sha256,clientOrderId:randomUUID(),buyerPrincipalId:null,environment:'sandbox'},ports);
    const application=await applyConfirmedPayment(q,{orderId:o.order_id,paymentRef:randomUUID(),amountMinor:600,currency:'TWD',simulated:false});assert.equal(application.outcome,'converted');return o;});
  await winner.locked;const loser=x.place(c,cc).then(value=>({value}),error=>({error}));
  try{await blockedBy(winner.pid);}finally{winner.release();}
  await winner.result;const result=await loser;assert.ok('error' in result);assert.equal(result.error.code,'stock_unavailable');assert.deepEqual(result.error.items,[{sku:'P0001',available:4}]);
  assert.deepEqual((await x.h.pool.query('SELECT stock,reserved FROM commerce_items WHERE item_id=$1',[a.product.product_id])).rows[0],{stock:10,reserved:6});
});
for(const first of ['payment','expiry'] as const)test(`due hold payment vs settlement: ${first} commits first`,async()=>{
  const s=await x.store(),o=await x.due(s);
  const gate=await gated(async q=>first==='payment'?await pay(q,o.order_id):await settleDueCheckoutHolds(q,[s.product.product_id]));await gate.locked;
  const second=x.tx(async q=>first==='payment'?await settleDueCheckoutHolds(q,[s.product.product_id]):await pay(q,o.order_id));
  try{await blockedBy(gate.pid);}finally{gate.release();}
  const a=await gate.result,b=await second,application=first==='payment'?a:b;
  assert.equal((application as {outcome:string}).outcome,first==='payment'?'converted':'allocated');
  assert.equal((await x.h.pool.query('SELECT lifecycle_state FROM commerce_checkout_orders WHERE order_id=$1',[o.order_id])).rows[0].lifecycle_state,'open');
  assert.equal((await x.h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1',[s.product.product_id])).rows[0].reserved,5);
});
for(const first of ['payment','cancel'] as const)test(`buyer cancellation vs payment: ${first} commits first`,async()=>{
  const s=await x.store(),o=await x.place(s,await x.frozen(s));
  const gate=await gated(async q=>first==='payment'?await pay(q,o.order_id):await cancelUnpaidOrder(q,s,o.order_id,'buyer','buyer_cancelled'));await gate.locked;
  const second=x.tx(async q=>first==='payment'?await cancelUnpaidOrder(q,s,o.order_id,'buyer','buyer_cancelled'):await pay(q,o.order_id)).then(value=>({value}),error=>({error}));
  try{await blockedBy(gate.pid);}finally{gate.release();}await gate.result;const result=await second;
  if(first==='payment'){assert.ok('error' in result);assert.equal(result.error.code,'payment_already_applied');}
  else{assert.ok('value' in result);assert.equal((result.value as {outcome:string}).outcome,'after_cancel');}
});
test('identical confirmed notifications concurrently return one stored application and one conversion',async()=>{
  const s=await x.store(),o=await x.place(s,await x.frozen(s)),ref=randomUUID(),gate=await gated(q=>pay(q,o.order_id,ref));await gate.locked;
  const second=x.tx(q=>pay(q,o.order_id,ref));try{await blockedBy(gate.pid);}finally{gate.release();}
  assert.deepEqual(await second,await gate.result);
  assert.equal((await x.h.pool.query('SELECT count(*)::int n FROM commerce_checkout_payment_applications')).rows[0].n,1);
  assert.equal((await x.h.pool.query('SELECT count(*)::int n FROM commerce_inventory_movements')).rows[0].n,1);
});
test('concurrent handover replay ships its allocation exactly once',async()=>{
  const s=await x.store(),o=await x.place(s,await x.frozen(s));await x.tx(q=>pay(q,o.order_id));
  const input={shipmentRef:randomUUID(),lines:[{orderId:o.order_id,itemId:s.product.product_id,quantity:2}]};
  const gate=await gated(q=>recordHandover(q,s,input));await gate.locked;const second=x.tx(q=>recordHandover(q,s,input));
  try{await blockedBy(gate.pid);}finally{gate.release();}await gate.result;await second;
  assert.deepEqual((await x.h.pool.query('SELECT stock,reserved FROM commerce_items WHERE item_id=$1',[s.product.product_id])).rows[0],{stock:8,reserved:3});
});
test('real product stock editing waits for placement and refuses to undercut its hold',async()=>{
  const s=await x.store(),c=await x.frozen(s),gate=await gated(q=>placeCheckoutOrder(q,s,{checkoutId:c.checkout_id,termsSha256:c.terms_sha256,clientOrderId:randomUUID(),buyerPrincipalId:null,environment:'sandbox'},ports));
  await gate.locked;const edit=x.send(s,`/products/${s.product.product_id}`,{stock:0},'1','PATCH');
  try{await blockedBy(gate.pid);}finally{gate.release();}await gate.result;const response=await edit;ok(response,409);assert.equal(response.data.code,'stock_below_reserved');
});
