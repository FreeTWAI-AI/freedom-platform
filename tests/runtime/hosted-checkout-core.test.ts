import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {after,before,beforeEach,test} from 'node:test';
import {mapPersonPrincipal} from '../../packages/resource-scopes/index.js';
import {authenticate} from '../../modules/identity-membership/service.js';
import {createDirectQuote} from '../../modules/agent-commerce/hosted/direct-quotes.js';
import {createSharedQuote} from '../../modules/agent-commerce/hosted/shared-quotes.js';
import {submitDirectOrder} from '../../modules/agent-commerce/hosted/direct-orders.js';
import {submitSharedOrderOutcome} from '../../modules/agent-commerce/hosted/shared-orders.js';
import {inventoryPositions} from '../../modules/agent-commerce/hosted/inventory.js';
import {applyConfirmedPayment,recordHandover,restockReturn,releaseAllocation,cancelUnpaidOrder,settleDueCheckoutHolds,sweepDueCheckoutHolds,retryAllocation,freezeCheckout,placeCheckoutOrder,ensureCustomer} from '../../modules/agent-commerce/checkout/index.js';
import {checkoutHarness,code,ok,ports,type CheckoutHarness} from './hosted-checkout-harness.js';
let x:CheckoutHarness;
before(async()=>{x=await checkoutHarness('fp_checkout_core');});beforeEach(async()=>x.reset());after(async()=>x?.stop());
const position=async(id:string)=>(await x.tx(q=>inventoryPositions(q,[id]))).get(id);
const payment=(id:string,total=500,ref:string=randomUUID(),extra:Partial<Parameters<typeof applyConfirmedPayment>[1]>={})=>x.tx(q=>applyConfirmedPayment(q,{orderId:id,paymentRef:ref,amountMinor:total,currency:'TWD',simulated:false,...extra}));

test('guest placement → conversion → handover 2/5 → restock 1, with durable identities and all event replays',async()=>{
  const s=await x.store(),c=await x.frozen(s),client=randomUUID();
  assert.deepEqual(await position(s.product.product_id),{stock:10,held:0,allocated:0,available:10});
  const o=await x.place(s,c,client);assert.match(o.display_number,/^[0-9]{6}-[0-9A-HJKMNP-TV-Z]{6}$/);
  assert.deepEqual(await x.place(s,c,client),o);
  assert.equal((await x.h.pool.query('SELECT buyer_principal_id FROM commerce_orders WHERE order_id=$1',[o.order_id])).rows[0].buyer_principal_id,null);
  assert.deepEqual(await position(s.product.product_id),{stock:10,held:5,allocated:0,available:5});
  const app=await payment(o.order_id);assert.equal(app.outcome,'converted');assert.deepEqual(await payment(o.order_id,500,app.payment_ref),app);
  assert.deepEqual(await position(s.product.product_id),{stock:10,held:0,allocated:5,available:5});
  const stockEdit=await x.send(s,`/products/${s.product.product_id}`,{stock:4},'1','PATCH');ok(stockEdit,409);assert.equal(stockEdit.data.code,'stock_below_reserved');
  const shipment={shipmentRef:randomUUID(),lines:[{orderId:o.order_id,itemId:s.product.product_id,quantity:2}]};
  await x.tx(q=>recordHandover(q,s,shipment));await x.tx(q=>recordHandover(q,s,shipment));
  assert.deepEqual(await position(s.product.product_id),{stock:8,held:0,allocated:3,available:5});
  const returned={returnRef:randomUUID(),orderId:o.order_id,itemId:s.product.product_id,quantity:1};
  await x.tx(q=>restockReturn(q,s,returned));await x.tx(q=>restockReturn(q,s,returned));
  assert.deepEqual(await position(s.product.product_id),{stock:9,held:0,allocated:3,available:6});
  await assert.rejects(x.tx(q=>restockReturn(q,s,{...returned,returnRef:randomUUID(),quantity:2})),code('return_exceeded'));
  await assert.rejects(x.tx(q=>recordHandover(q,s,{shipmentRef:randomUUID(),lines:[{...shipment.lines[0],quantity:4}]})),code('allocation_exceeded'));
  assert.equal((await x.h.pool.query('SELECT count(*)::int n FROM commerce_inventory_movements WHERE order_id=$1',[o.order_id])).rows[0].n,3);
});
test('withdrawn supplier consent changes terms and prevents any placement effects',async()=>{
  const supplier=await x.store(),retailer=await x.store(10,false);
  const offer=ok(await x.send(supplier,`/products/${supplier.product.product_id}/supply-offer`,{},supplier.product.version));
  const selection=ok(await x.send(retailer,'/distribution-selections',{offer_id:offer.offer_id,terms_sha256:offer.terms_sha256,retail_price_minor:100}),201);
  ok(await x.send(supplier,`/supply-requests/${selection.selection_id}/decision`,{decision:'accepted',listing_sha256:selection.listing_sha256},selection.version));
  await x.publish(retailer);retailer.product={...supplier.product,sku:'P0001'};const c=await x.frozen(retailer);
  ok(await x.send(supplier,`/supply-offers/${offer.offer_id}/withdraw`,{},offer.version));
  await assert.rejects(x.place(retailer,c),code('terms_changed'));
  assert.equal((await x.h.pool.query('SELECT count(*)::int n FROM commerce_orders')).rows[0].n,0);
  assert.equal((await position(supplier.product.product_id))?.available,10);
});
test('a released multi-item hold allocates all items or none, including an available first item',async()=>{
  const s=await x.store(),second=ok(await x.send(s,'/products',{title:'第二項合成商品',price_minor:100,stock:10}),201);await x.publish(s);
  const c=await x.frozen(s,5,{publication_revision:'2',lines:[{sku:s.product.sku,quantity:5},{sku:second.sku,quantity:5}]}),o=await x.place(s,c);
  // A retained hold may also be released directly by a machine decision; keep
  // the same immutable order and never manufacture replacement reservations.
  await x.tx(async q=>{
    await q.query(`UPDATE commerce_inventory_reservations SET state='released',released_at=clock_timestamp() WHERE order_id=$1`,[o.order_id]);
    await q.query('UPDATE commerce_items SET reserved=reserved-5 WHERE item_id=ANY($1::uuid[])',[[s.product.product_id,second.product_id]]);
  });
  ok(await x.send(s,`/products/${second.product_id}`,{stock:0},'1','PATCH'));
  assert.equal((await payment(o.order_id,1000)).outcome,'unallocatable');
  assert.equal((await x.h.pool.query('SELECT count(*)::int n FROM commerce_inventory_allocations')).rows[0].n,0);
  assert.equal((await position(s.product.product_id))?.available,10);
});
test('checkout rows coexist with direct/shared v1 orders without entering v1 lists, recovery or projections',async()=>{
  const s=await x.store(30),buyer=(await x.h.person('合成跨版本買家')).session;
  const actor=await authenticate(x.runtime,buyer.cookie.split('=')[1].split(';')[0]);
  const principal=await x.tx(q=>mapPersonPrincipal(q,buyer.user.user_id)),intent=randomUUID();
  const before=ok(await x.h.call('GET',`/hosted-stores/${s.slug}/order-readiness`,buyer,undefined,{},x.app));
  const checkout=await x.place(s,await x.frozen(s),intent,principal.principal_id);
  await payment(checkout.order_id);
  const quote=await createDirectQuote(x.runtime,actor,s.slug,{publication_revision:'1',items:[{sku:s.product.sku,quantity:1}]},randomUUID());
  const direct=await submitDirectOrder(x.runtime,actor,s.slug,{quote_id:quote.quote_id,terms_sha256:quote.terms_sha256,client_order_id:intent},randomUUID());
  const sharedQuote=await createSharedQuote(x.runtime,actor,s.slug,{publication_revision:'1',items:[{sku:s.product.sku,quantity:1}]},randomUUID());
  const {order:shared}=await submitSharedOrderOutcome(x.runtime,actor,s.slug,{quote_id:sharedQuote.quote_id,terms_sha256:sharedQuote.terms_sha256,client_order_id:randomUUID()},randomUUID());
  for(const path of ['/me/hosted-orders','/me/reservations']){
    const page=ok(await x.h.call('GET',path,buyer,undefined,{},x.app));assert.ok(page.items.every((o:{order_id:string})=>o.order_id!==checkout.order_id));assert.ok(page.items.some((o:{order_id:string})=>o.order_id===direct.order_id));
  }
  const page=ok(await x.h.call('GET',s.root+'/orders',s.owner,undefined,{},x.app));assert.deepEqual(page.items.map((o:{order_id:string})=>o.order_id),[direct.order_id]);
  const reservations=ok(await x.h.call('GET',s.root+'/reservations',s.owner,undefined,{},x.app));assert.equal(reservations.items.length,2);assert.ok(reservations.items.some((o:{order_id:string})=>o.order_id===shared.order_id));
  const supply=ok(await x.h.call('GET',s.root+'/supply-reservations',s.owner,undefined,{},x.app));assert.deepEqual(supply.items,[]);
  ok(await x.h.call('GET',`/me/hosted-orders/${checkout.order_id}`,buyer,undefined,{},x.app),404);
  const after=ok(await x.h.call('GET',`/hosted-stores/${s.slug}/order-readiness`,buyer,undefined,{},x.app));assert.deepEqual(after,before);
  for(const item of reservations.items){assert.equal(item.payment_enabled,false);assert.equal(item.fulfilment_enabled,false);}
});
test('unresolved open orders return their reference and cancellation permits a new order from the same checkout',async()=>{
  const s=await x.store(),c=await x.frozen(s),o=await x.place(s,c);
  await assert.rejects(x.place(s,c),e=>code('unresolved_order')(e)&&(e as {order_ref:string}).order_ref===o.order_id);
  await x.tx(q=>cancelUnpaidOrder(q,s,o.order_id,'system','payment_not_completed'));
  assert.notEqual((await x.place(s,c)).order_id,o.order_id);
});
test('v1 shortage settlement reclaims expired checkout holds and leaves that checkout order open',async()=>{
  const s=await x.store(),due=await x.due(s,10),b=(await x.h.person('合成舊版買家')).session;
  const actor=await authenticate(x.runtime,b.cookie.split('=')[1].split(';')[0]);
  const quote=await createDirectQuote(x.runtime,actor,s.slug,{publication_revision:'1',items:[{sku:s.product.sku,quantity:1}]},randomUUID());
  await submitDirectOrder(x.runtime,actor,s.slug,{quote_id:quote.quote_id,terms_sha256:quote.terms_sha256,client_order_id:randomUUID()},randomUUID());
  assert.equal((await position(s.product.product_id))?.held,1);
  assert.equal((await x.h.pool.query('SELECT lifecycle_state FROM commerce_checkout_orders WHERE order_id=$1',[due.order_id])).rows[0].lifecycle_state,'open');
});
test('bounded sweep releases due holds without a principal and rejects a limit above 200',async()=>{
  const s=await x.store();await x.due(s);
  await assert.rejects(sweepDueCheckoutHolds(x.runtime,{limit:201}),code('invalid_settlement_bounds'));
  assert.equal(await sweepDueCheckoutHolds(x.runtime,{limit:1}),1);assert.equal(await sweepDueCheckoutHolds(x.runtime,{limit:1}),0);
  assert.equal((await position(s.product.product_id))?.held,0);
});
test('inventoryPositions refuses a transient balance mismatch with reservation_inconsistent',async()=>{
  const s=await x.store();await x.place(s,await x.frozen(s));
  await assert.rejects(x.tx(async q=>{await q.query('UPDATE commerce_items SET reserved=4 WHERE item_id=$1',[s.product.product_id]);await inventoryPositions(q,[s.product.product_id]);}),code('reservation_inconsistent'));
  assert.equal((await position(s.product.product_id))?.held,5);
});
test('revising contact email preserves placed order contact/customer and original keyed response',async()=>{
  const s=await x.store(),c=await x.frozen(s),o=await x.place(s,c);
  const changed=await x.tx(q=>freezeCheckout(q,s,{...x.input(s.product.sku),checkoutId:c.checkout_id,idempotencyKey:randomUUID(),contact:{name:'合成收件買家',email:'synthetic-revised@example.test',phone:'0000000001'}},ports));
  assert.notEqual(changed.terms_sha256,c.terms_sha256);assert.equal(changed.checkout_id,c.checkout_id);
  const rows=(await x.h.pool.query(`SELECT c.customer_id current_customer,co.customer_id placed_customer,c.current_contact_id,co.contact_id FROM commerce_checkouts c JOIN commerce_checkout_orders co USING(checkout_id) WHERE co.order_id=$1`,[o.order_id])).rows[0];
  assert.notEqual(rows.current_customer,rows.placed_customer);assert.notEqual(rows.current_contact_id,rows.contact_id);
  const member=(await x.h.person('合成後登入買家')),principal=await x.tx(q=>mapPersonPrincipal(q,member.id));
  await x.tx(q=>cancelUnpaidOrder(q,s,o.order_id,'buyer','buyer_cancelled'));
  const next=await x.place(s,changed,randomUUID(),principal.principal_id);
  assert.equal((await x.h.pool.query('SELECT member_principal_id FROM commerce_customers WHERE customer_id=$1',[next.customer_id])).rows[0].member_principal_id,principal.principal_id);
});
test('member customer normalization, checkout creation/revision idempotency and member placement',async()=>{
  const s=await x.store(),b=await x.h.person('合成會員買家');const principal=await x.tx(q=>mapPersonPrincipal(q,b.id));
  const customer=await x.tx(q=>ensureCustomer(q,s,'  SYNTHETIC-MEMBER@example.test ',principal.principal_id));
  assert.equal((await x.tx(q=>ensureCustomer(q,s,'synthetic-member@example.test',principal.principal_id))).customer_id,customer.customer_id);
  const input={...x.input(s.product.sku),contact:{name:'合成買家',email:'synthetic-member@example.test',phone:'0000000000'},idempotencyKey:randomUUID(),memberPrincipalId:principal.principal_id};
  const c=await x.tx(q=>freezeCheckout(q,s,input,ports));assert.deepEqual(await x.tx(q=>freezeCheckout(q,s,input,ports)),c);
  await assert.rejects(x.tx(q=>freezeCheckout(q,s,{...input,lines:[{sku:s.product.sku,quantity:2}]},ports)),code('checkout_idempotency_conflict'));
  const revision=await x.tx(q=>freezeCheckout(q,s,{...input,checkoutId:c.checkout_id,idempotencyKey:randomUUID(),lines:[{sku:s.product.sku,quantity:3}]},ports));
  assert.equal(revision.checkout_id,c.checkout_id);assert.equal(revision.version,'2');assert.notEqual(revision.terms_sha256,c.terms_sha256);
  assert.deepEqual(await x.tx(q=>freezeCheckout(q,s,input,ports)),c,'old command retains its original non-PII response');
  const o=await x.place(s,revision,randomUUID(),principal.principal_id);
  assert.equal((await x.h.pool.query('SELECT buyer_principal_id FROM commerce_orders WHERE order_id=$1',[o.order_id])).rows[0].buyer_principal_id,principal.principal_id);
});
test('unpaid cancellation is idempotent; subsequent verified payment is after_cancel',async()=>{
  const s=await x.store(),o=await x.place(s,await x.frozen(s));
  const cancel=()=>x.tx(q=>cancelUnpaidOrder(q,s,o.order_id,'buyer','buyer_cancelled'));
  const closed=await cancel();assert.equal(closed.lifecycle_state,'cancelled');assert.deepEqual(await cancel(),closed);
  assert.equal((await payment(o.order_id)).outcome,'after_cancel');assert.deepEqual(await position(s.product.product_id),{stock:10,held:0,allocated:0,available:10});
});
test('due hold settlement keeps the order open and a late payment allocates available stock',async()=>{
  const s=await x.store(),o=await x.due(s);assert.equal(await x.tx(q=>settleDueCheckoutHolds(q,[s.product.product_id])),1);
  assert.equal((await x.h.pool.query('SELECT lifecycle_state FROM commerce_checkout_orders WHERE order_id=$1',[o.order_id])).rows[0].lifecycle_state,'open');
  assert.equal((await payment(o.order_id)).outcome,'allocated');assert.deepEqual(await position(s.product.product_id),{stock:10,held:0,allocated:5,available:5});
});
test('a due but still held reservation converts without first exposing its units',async()=>{
  const s=await x.store(),o=await x.due(s);assert.equal((await payment(o.order_id)).outcome,'converted');
  assert.equal(await x.tx(q=>settleDueCheckoutHolds(q,[s.product.product_id])),0);assert.equal((await position(s.product.product_id))?.allocated,5);
});
test('late payment cannot partially allocate; restock permits an idempotent retry',async()=>{
  const s=await x.store(),o=await x.due(s);await x.tx(q=>settleDueCheckoutHolds(q,[s.product.product_id]));
  ok(await x.send(s,`/products/${s.product.product_id}`,{stock:0},'1','PATCH'));
  const app=await payment(o.order_id);assert.equal(app.outcome,'unallocatable');assert.deepEqual(await position(s.product.product_id),{stock:0,held:0,allocated:0,available:0});
  ok(await x.send(s,`/products/${s.product.product_id}`,{stock:5},'2','PATCH'));
  await x.tx(q=>retryAllocation(q,s,o.order_id));await x.tx(q=>retryAllocation(q,s,o.order_id));
  assert.deepEqual(await position(s.product.product_id),{stock:5,held:0,allocated:5,available:0});assert.deepEqual(await payment(o.order_id,500,app.payment_ref),app);
});
test('simulated, mismatched and second payments retain distinct outcomes without extra stock effects',async()=>{
  const s=await x.store(),o=await x.place(s,await x.frozen(s));
  assert.equal((await payment(o.order_id,500,randomUUID(),{simulated:true})).outcome,'simulated');assert.equal((await position(s.product.product_id))?.held,5);
  assert.equal((await payment(o.order_id)).outcome,'converted');assert.equal((await payment(o.order_id)).outcome,'overpaid');
  assert.equal((await payment(o.order_id,499)).outcome,'amount_mismatch');assert.equal((await payment(o.order_id,500,randomUUID(),{currency:'USD'})).outcome,'amount_mismatch');
  const command={orderId:o.order_id,commandRef:randomUUID()};const cancelled=await x.tx(q=>releaseAllocation(q,s,command));assert.equal(cancelled.lifecycle_state,'cancelled');
  assert.deepEqual(await x.tx(q=>releaseAllocation(q,s,command)),cancelled);assert.equal((await payment(o.order_id)).outcome,'after_cancel');assert.equal((await position(s.product.product_id))?.available,10);
});
test('default admission refuses and missing shipping configuration cannot freeze a checkout',async()=>{
  const s=await x.store(),c=await x.frozen(s);
  await assert.rejects(x.tx(q=>placeCheckoutOrder(q,s,{checkoutId:c.checkout_id,termsSha256:c.terms_sha256,clientOrderId:randomUUID(),buyerPrincipalId:null,environment:'sandbox'},{})),code('checkout_not_enabled'));
  await assert.rejects(x.tx(q=>freezeCheckout(q,s,{...x.input(s.product.sku),idempotencyKey:randomUUID()})),code('shipping_not_configured'));
  assert.equal((await x.h.pool.query('SELECT count(*)::int n FROM commerce_orders')).rows[0].n,0);
});
for(const change of ['price','publication'] as const)test(`${change} changed after freezing refuses placement without an order or hold`,async()=>{
  const s=await x.store(),c=await x.frozen(s);
  if(change==='price')ok(await x.send(s,`/products/${s.product.product_id}`,{price_minor:200},'1','PATCH'));
  else {
    ok(await x.send(s,`/products/${s.product.product_id}`,{description:'合成新版商品描述'},'1','PATCH'));
    await x.publish(s);
    assert.equal((await x.h.pool.query('SELECT max(revision)::text revision FROM commerce_storefront_publications WHERE instance_id=$1',[s.instanceId])).rows[0].revision,'2');
  }
  await assert.rejects(x.place(s,c),code('terms_changed'));assert.equal((await x.h.pool.query('SELECT count(*)::int n FROM commerce_orders')).rows[0].n,0);
});
