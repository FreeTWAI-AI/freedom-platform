import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {after,before,beforeEach,test} from 'node:test';
import {mapPersonPrincipal} from '../../packages/resource-scopes/index.js';
import {authenticate} from '../../modules/identity-membership/service.js';
import {createDirectQuote} from '../../modules/agent-commerce/hosted/direct-quotes.js';
import {createSharedQuote} from '../../modules/agent-commerce/hosted/shared-quotes.js';
import {submitDirectOrder} from '../../modules/agent-commerce/hosted/direct-orders.js';
import {submitSharedOrderOutcome} from '../../modules/agent-commerce/hosted/shared-orders.js';
import {inventoryPositions} from '../../modules/agent-commerce/hosted/inventory.js';
import {applyConfirmedPayment,recordHandover,restockReturn,releaseAllocation,cancelPaidOrder,cancelUnpaidOrder,settleDueCheckoutHolds,sweepDueCheckoutHolds,retryAllocation,freezeCheckout,placeCheckoutOrder,ensureCustomer,hashJSON,canonicalJSON} from '../../modules/agent-commerce/checkout/index.js';
import {checkoutHarness,code,ok,ports,type CheckoutHarness} from './hosted-checkout-harness.js';
let x:CheckoutHarness;
before(async()=>{x=await checkoutHarness('fp_checkout_core');});beforeEach(async()=>x.reset());after(async()=>x?.stop());
const stockFacts=async()=>Promise.all(['SELECT * FROM commerce_items ORDER BY item_id','SELECT * FROM commerce_inventory_allocations ORDER BY allocation_id','SELECT * FROM commerce_inventory_movements ORDER BY movement_id','SELECT * FROM commerce_checkout_orders ORDER BY order_id','SELECT * FROM commerce_checkout_allocation_commands ORDER BY command_ref'].map(async sql=>(await x.h.pool.query(sql)).rows));
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
// Supplied line freezes through the test port's synthetic drop_ship agreement, then withdrawn consent is terms_changed. Production still rejects supplied lines.
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
  assert.equal((await x.h.pool.query('SELECT member_principal_id FROM commerce_customers WHERE customer_id=$1',[next.customer_id])).rows[0].member_principal_id,null);
});
test('member customer normalization, checkout creation/revision idempotency and member placement',async()=>{
  const s=await x.store(),b=await x.h.person('合成會員買家');const principal=await x.tx(q=>mapPersonPrincipal(q,b.id));
  await x.h.pool.query("UPDATE users SET email='synthetic-member@example.test',email_verified_at=clock_timestamp() WHERE user_id=$1",[b.id]);
  const customer=await x.tx(q=>ensureCustomer(q,s,'  SYNTHETIC-MEMBER@example.test ',principal.principal_id));
  assert.equal(customer.member_principal_id,principal.principal_id);
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

test('releasing the remaining 3 after shipping 2 of 5 keeps the order open with exact positions',async()=>{
  const s=await x.store(),o=await x.place(s,await x.frozen(s));await payment(o.order_id);
  await x.tx(q=>recordHandover(q,s,{shipmentRef:randomUUID(),lines:[{orderId:o.order_id,itemId:s.product.product_id,quantity:2}]}));
  const released=await x.tx(q=>releaseAllocation(q,s,{orderId:o.order_id,commandRef:randomUUID()}));
  assert.equal(released.lifecycle_state,'open');assert.equal(released.version,'1');assert.equal(released.cancel_reason,null);
  assert.deepEqual(await position(s.product.product_id),{stock:8,held:0,allocated:0,available:8});
  assert.deepEqual((await x.h.pool.query('SELECT quantity,shipped_quantity,released_quantity FROM commerce_inventory_allocations WHERE order_id=$1',[o.order_id])).rows,[{quantity:5,shipped_quantity:2,released_quantity:3}]);
  assert.deepEqual((await x.h.pool.query('SELECT kind,quantity,delta_stock,delta_reserved FROM commerce_inventory_movements WHERE order_id=$1 ORDER BY created_at,movement_id',[o.order_id])).rows,[
    {kind:'convert',quantity:5,delta_stock:0,delta_reserved:0},{kind:'ship',quantity:2,delta_stock:-2,delta_reserved:-2},{kind:'allocation_release',quantity:3,delta_stock:0,delta_reserved:-3}]);
});

for(const expired of [false,true])test(`amount mismatch then correct payment ${expired?'after hold expiry allocates':'while held converts'}`,async()=>{
  const s=await x.store(),o=expired?await x.due(s):await x.place(s,await x.frozen(s));
  assert.equal((await payment(o.order_id,499)).outcome,'amount_mismatch');
  if(expired)await x.tx(q=>settleDueCheckoutHolds(q,[s.product.product_id]));
  assert.equal((await payment(o.order_id)).outcome,expired?'allocated':'converted');
  assert.deepEqual(await position(s.product.product_id),{stock:10,held:0,allocated:5,available:5});
});
for(const simulated of [true,false])test(`${simulated?'simulated':'amount mismatch'} payment still permits unpaid cancellation`,async()=>{
  const s=await x.store(),o=await x.place(s,await x.frozen(s));
  assert.equal((await payment(o.order_id,simulated?500:499,randomUUID(),{simulated})).outcome,simulated?'simulated':'amount_mismatch');
  assert.equal((await x.tx(q=>cancelUnpaidOrder(q,s,o.order_id,'buyer','buyer_cancelled'))).lifecycle_state,'cancelled');
  assert.deepEqual(await position(s.product.product_id),{stock:10,held:0,allocated:0,available:10});
});
test('an open order with only an amount mismatch remains unresolved on the same checkout',async()=>{
  const s=await x.store(),c=await x.frozen(s),o=await x.place(s,c);await payment(o.order_id,499);
  await assert.rejects(x.place(s,c),e=>code('unresolved_order')(e)&&(e as {order_ref:string}).order_ref===o.order_id);
  assert.equal((await x.h.pool.query('SELECT count(*)::int n FROM commerce_orders')).rows[0].n,1);
  assert.deepEqual(await position(s.product.product_id),{stock:10,held:5,allocated:0,available:5});
});

for(const unallocatable of [false,true])test(`paid cancellation of ${unallocatable?'an unallocatable order without allocations':'a converted order'} releases stock and replays`,async()=>{
  const s=await x.store(),o=unallocatable?await x.due(s):await x.place(s,await x.frozen(s));
  if(unallocatable){await x.tx(q=>settleDueCheckoutHolds(q,[s.product.product_id]));ok(await x.send(s,`/products/${s.product.product_id}`,{stock:0},'1','PATCH'));}
  assert.equal((await payment(o.order_id)).outcome,unallocatable?'unallocatable':'converted');
  const input={orderId:o.order_id,commandRef:randomUUID()},cancel=()=>x.tx(q=>cancelPaidOrder(q,s,input)),closed=await cancel();
  assert.equal(closed.lifecycle_state,'cancelled');assert.equal(closed.cancel_reason,'paid_cancelled');assert.equal(closed.version,'2');
  const facts=await stockFacts();assert.deepEqual(await cancel(),closed);assert.deepEqual(await stockFacts(),facts);
  await assert.rejects(x.tx(q=>retryAllocation(q,s,o.order_id)),code('checkout_order_closed'));assert.deepEqual(await stockFacts(),facts);
  assert.deepEqual(await position(s.product.product_id),{stock:unallocatable?0:10,held:0,allocated:0,available:unallocatable?0:10});
  assert.equal((await x.h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1',[s.product.product_id])).rows[0].reserved,0);
  assert.deepEqual((await x.h.pool.query("SELECT kind,quantity FROM commerce_inventory_movements WHERE order_id=$1 AND kind='allocation_release'",[o.order_id])).rows,unallocatable?[]:[{kind:'allocation_release',quantity:5}]);
});
test('paid cancellation rejects a partial handover without any effect',async()=>{
  const s=await x.store(),o=await x.place(s,await x.frozen(s));await payment(o.order_id);
  await x.tx(q=>recordHandover(q,s,{shipmentRef:randomUUID(),lines:[{orderId:o.order_id,itemId:s.product.product_id,quantity:2}]}));
  const before=await stockFacts();await assert.rejects(x.tx(q=>cancelPaidOrder(q,s,{orderId:o.order_id,commandRef:randomUUID()})),code('order_partially_shipped'));assert.deepEqual(await stockFacts(),before);
});
for(const outcome of ['none','simulated','amount_mismatch'] as const)test(`paid cancellation rejects ${outcome} payment without any effect`,async()=>{
  const s=await x.store(),o=await x.place(s,await x.frozen(s));
  if(outcome!=='none')await payment(o.order_id,outcome==='simulated'?500:499,randomUUID(),{simulated:outcome==='simulated'});
  const before=await stockFacts();await assert.rejects(x.tx(q=>cancelPaidOrder(q,s,{orderId:o.order_id,commandRef:randomUUID()})),code('payment_not_confirmed'));assert.deepEqual(await stockFacts(),before);
});

for(const stage of ['ensure','placement'] as const)for(const account of ['verified','different','unverified','inactive_user','inactive_principal'] as const)test(`${stage} customer link requires an active verified matching member (${account})`,async()=>{
  const s=await x.store(),b=await x.h.person('合成買家'),principal=await x.tx(q=>mapPersonPrincipal(q,b.id));
  await x.h.pool.query('UPDATE users SET email_verified_at=$2,active=$3 WHERE user_id=$1',[b.id,account==='unverified'?null:new Date(),account!=='inactive_user']);
  if(account==='inactive_principal')await x.h.pool.query("UPDATE principals SET status='disabled' WHERE principal_id=$1",[principal.principal_id]);
  const email=account==='different'?'different@example.test':b.email,contact={name:'合成買家',email,phone:'0000000000'};
  let customerId:string;
  if(stage==='ensure')customerId=(await x.tx(q=>ensureCustomer(q,s,email,principal.principal_id))).customer_id;
  else {
    const c=await x.frozen(s,5,{contact}),o=await x.place(s,c,randomUUID(),principal.principal_id);customerId=o.customer_id;
    assert.equal((await x.h.pool.query('SELECT buyer_principal_id FROM commerce_orders WHERE order_id=$1',[o.order_id])).rows[0].buyer_principal_id,principal.principal_id);
  }
  assert.equal((await x.h.pool.query('SELECT member_principal_id FROM commerce_customers WHERE customer_id=$1',[customerId])).rows[0].member_principal_id,account==='verified'?principal.principal_id:null);
});
test('a second member may order with an already linked email; guests never link or unlink',async()=>{
  const s=await x.store(),a=await x.h.person('合成買家甲'),b=await x.h.person('合成買家乙');
  await x.h.pool.query('UPDATE users SET email_verified_at=clock_timestamp() WHERE user_id=ANY($1::uuid[])',[[a.id,b.id]]);
  const pa=await x.tx(q=>mapPersonPrincipal(q,a.id)),pb=await x.tx(q=>mapPersonPrincipal(q,b.id));
  const customer=await x.tx(q=>ensureCustomer(q,s,a.email,pa.principal_id));assert.equal(customer.member_principal_id,pa.principal_id);
  assert.deepEqual(await x.tx(q=>ensureCustomer(q,s,a.email,pb.principal_id)),customer);
  assert.deepEqual(await x.tx(q=>ensureCustomer(q,s,a.email)),customer);
  const c=await x.frozen(s,5,{contact:{name:'合成買家',email:a.email,phone:'0000000000'}}),o=await x.place(s,c,randomUUID(),pb.principal_id);
  assert.equal((await x.h.pool.query('SELECT buyer_principal_id FROM commerce_orders WHERE order_id=$1',[o.order_id])).rows[0].buyer_principal_id,pb.principal_id);
  assert.deepEqual(await x.tx(q=>ensureCustomer(q,s,a.email)),customer);
  await x.tx(q=>cancelUnpaidOrder(q,s,o.order_id,'buyer','buyer_cancelled'));await x.place(s,c);
  assert.deepEqual(await x.tx(q=>ensureCustomer(q,s,a.email)),customer);
  assert.equal((await x.tx(q=>ensureCustomer(q,s,b.email))).member_principal_id,null);
});

async function twoPaidOrders(){
  const s=await x.store(20),second=ok(await x.send(s,'/products',{title:'第二項合成商品',price_minor:100,stock:20}),201);await x.publish(s);
  const extra={publication_revision:'2',lines:[{sku:s.product.sku,quantity:5},{sku:second.sku,quantity:5}]};
  const a=await x.place(s,await x.frozen(s,5,extra)),b=await x.place(s,await x.frozen(s,5,extra));await payment(a.order_id,1000);await payment(b.order_id,1000);
  return {s,a,b,ids:[s.product.product_id,second.product_id] as string[]};
}
test('shipment reference compares the complete multiset; reordered replay and content conflicts have no effects',async()=>{
  const {s,a,b,ids}=await twoPaidOrders(),input={shipmentRef:randomUUID(),lines:ids.map(itemId=>({orderId:a.order_id,itemId,quantity:2}))};
  await x.tx(q=>recordHandover(q,s,input));const before=await stockFacts();
  await x.tx(q=>recordHandover(q,s,{...input,lines:[...input.lines].reverse()}));assert.deepEqual(await stockFacts(),before);
  for(const lines of [[{...input.lines[0],quantity:1},input.lines[1]],[{...input.lines[0],orderId:b.order_id},input.lines[1]],input.lines.slice(0,1),[input.lines[0],input.lines[0]]]){
    await assert.rejects(x.tx(q=>recordHandover(q,s,{...input,lines})),code('shipment_ref_conflict'));assert.deepEqual(await stockFacts(),before);
  }
});
test('return reference compares order, item, allocation and quantity before any effects',async()=>{
  const {s,a,b,ids}=await twoPaidOrders();await x.tx(q=>recordHandover(q,s,{shipmentRef:randomUUID(),lines:[a,b].flatMap(o=>ids.map(itemId=>({orderId:o.order_id,itemId,quantity:2})))}));
  const input={returnRef:randomUUID(),orderId:a.order_id,itemId:ids[0],quantity:1};await x.tx(q=>restockReturn(q,s,input));const before=await stockFacts();
  await x.tx(q=>restockReturn(q,s,input));assert.deepEqual(await stockFacts(),before);
  for(const change of [{quantity:2},{itemId:ids[1]},{orderId:b.order_id}]){
    await assert.rejects(x.tx(q=>restockReturn(q,s,{...input,...change})),code('return_ref_conflict'));assert.deepEqual(await stockFacts(),before);
  }
});
test('release command reference compares explicit lines as a set and rejects another order across both APIs',async()=>{
  const {s,a,b,ids}=await twoPaidOrders(),input={orderId:a.order_id,commandRef:randomUUID(),lines:ids.map((itemId,i)=>({itemId,quantity:i+1}))};
  const row=await x.tx(q=>releaseAllocation(q,s,input)),before=await stockFacts();
  assert.deepEqual(await x.tx(q=>releaseAllocation(q,s,{...input,lines:[...input.lines].reverse()})),row);
  assert.deepEqual(await x.tx(q=>releaseAllocation(q,s,{orderId:a.order_id,commandRef:input.commandRef})),row);assert.deepEqual(await stockFacts(),before);
  for(const lines of [[{...input.lines[0],quantity:2},input.lines[1]],input.lines.slice(0,1),[input.lines[0],input.lines[0]]]){
    await assert.rejects(x.tx(q=>releaseAllocation(q,s,{...input,lines})),code('command_ref_conflict'));assert.deepEqual(await stockFacts(),before);
  }
  await assert.rejects(x.tx(q=>releaseAllocation(q,s,{...input,orderId:b.order_id})),code('command_ref_conflict'));
  await assert.rejects(x.tx(q=>cancelPaidOrder(q,s,{...input,orderId:b.order_id})),code('command_ref_conflict'));assert.deepEqual(await stockFacts(),before);
});
for(const unallocatable of [false,true])test(`paid cancellation retains its command even ${unallocatable?'without allocations':'after releasing all allocations'}`,async()=>{
  const s=await x.store(20),a=unallocatable?await x.due(s):await x.place(s,await x.frozen(s));
  if(unallocatable){await x.tx(q=>settleDueCheckoutHolds(q,[s.product.product_id]));ok(await x.send(s,`/products/${s.product.product_id}`,{stock:0},'1','PATCH'));}
  assert.equal((await payment(a.order_id)).outcome,unallocatable?'unallocatable':'converted');
  if(unallocatable)ok(await x.send(s,`/products/${s.product.product_id}`,{stock:20},'2','PATCH'));
  const b=await x.place(s,await x.frozen(s));await payment(b.order_id);
  const input={orderId:a.order_id,commandRef:randomUUID()},row=await x.tx(q=>cancelPaidOrder(q,s,input)),before=await stockFacts();
  assert.deepEqual(await x.tx(q=>cancelPaidOrder(q,s,input)),row);
  assert.deepEqual(await x.tx(q=>cancelPaidOrder(q,s,{...input,commandRef:randomUUID()})),row);
  for(const cancel of [cancelPaidOrder,releaseAllocation])await assert.rejects(x.tx(q=>cancel(q,s,{...input,orderId:b.order_id})),code('command_ref_conflict'));
  if(unallocatable)await assert.rejects(x.tx(q=>releaseAllocation(q,s,{...input,lines:[{itemId:s.product.product_id,quantity:1}]})),code('command_ref_conflict'));
  assert.deepEqual(await stockFacts(),before);
});

for(const invalid of ['contact_nul','delivery_surrogate','delivery_key_surrogate','invoice_nested_nul','unknown_key_surrogate','idempotency_surrogate'] as const)test(`invalid checkout JSON (${invalid}) is rejected before writes`,async()=>{
  const s=await x.store(),input={...x.input(s.product.sku),idempotencyKey:randomUUID()} as Parameters<typeof freezeCheckout>[2]&Record<string,unknown>;
  if(invalid==='contact_nul')input.contact.name='合成\u0000買家';
  if(invalid==='delivery_surrogate')input.delivery={nested:[{address:'\ud800'}]};
  if(invalid==='delivery_key_surrogate')input.delivery={nested:{['\udc00']:'合成地址'}};
  if(invalid==='invoice_nested_nul')input.invoice={nested:[{name:'合成\u0000買家'}]};
  if(invalid==='unknown_key_surrogate')input['\ud800']='合成資料';
  if(invalid==='idempotency_surrogate')input.idempotencyKey='\ud800';
  const before=await stockFacts();await assert.rejects(x.tx(q=>freezeCheckout(q,s,input,ports)),code('invalid_checkout_json'));assert.deepEqual(await stockFacts(),before);
  for(const table of ['commerce_customers','commerce_checkouts','commerce_checkout_contacts','commerce_checkout_idempotency_keys'])assert.equal((await x.h.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,0);
});

test('contact digests are salted and freeze request digests are keyed without breaking replay',async()=>{
  const s=await x.store(),input=x.input(s.product.sku),idempotencyKey=randomUUID(),request={...input,idempotencyKey};
  const c=await x.tx(q=>freezeCheckout(q,s,request,ports)),contact=(await x.h.pool.query('SELECT * FROM commerce_checkout_contacts WHERE checkout_id=$1',[c.checkout_id])).rows[0];
  assert.match(contact.contact_salt,/^[a-f0-9]{32}$/);
  const pii={contact:input.contact,delivery:input.delivery,invoice:input.invoice};
  assert.notEqual(contact.contact_sha256,hashJSON(pii));assert.equal(contact.contact_sha256,hashJSON({...pii,salt:contact.contact_salt}));
  const canonicalRequest={input,checkout_id:null},digest=createHmac('sha256',Buffer.from(idempotencyKey,'utf8')).update(canonicalJSON(canonicalRequest),'utf8').digest('hex');
  const checkout=(await x.h.pool.query('SELECT * FROM commerce_checkouts WHERE checkout_id=$1',[c.checkout_id])).rows[0],key=(await x.h.pool.query('SELECT * FROM commerce_checkout_idempotency_keys WHERE checkout_id=$1',[c.checkout_id])).rows[0];
  assert.notEqual(checkout.request_sha256,hashJSON(canonicalRequest));assert.equal(checkout.request_sha256,digest);assert.equal(key.request_sha256,digest);
  assert.ok(!JSON.stringify([checkout,key]).includes(idempotencyKey));
  assert.deepEqual(await x.tx(q=>freezeCheckout(q,s,request,ports)),c);
  await assert.rejects(x.tx(q=>freezeCheckout(q,s,{...request,contact:{...input.contact,name:'另一位合成買家'}},ports)),code('checkout_idempotency_conflict'));
  const other=await x.frozen(s);assert.notEqual(other.terms.contact_sha256,c.terms.contact_sha256);
  await x.place(s,c);
});

test('paid cancellation of a closed order is refused without effects',async()=>{
  const s=await x.store(),o=await x.place(s,await x.frozen(s));await payment(o.order_id);
  await x.tx(q=>q.query("UPDATE commerce_checkout_orders SET lifecycle_state='closed',closed_at=clock_timestamp(),version=version+1 WHERE order_id=$1",[o.order_id]));
  const before=await stockFacts();await assert.rejects(x.tx(q=>cancelPaidOrder(q,s,{orderId:o.order_id,commandRef:randomUUID()})),code('checkout_order_closed'));assert.deepEqual(await stockFacts(),before);
});

for (const transition of ['guest to member', 'member to guest', 'member A to member B'] as const) {
  test(`placement replay preserves the original buyer: ${transition}`, async () => {
    const s = await x.store(), c = await x.frozen(s), intent = randomUUID();
    const a = await x.h.person('測試買家甲'), b = await x.h.person('測試買家乙');
    const principalA = await x.tx(q => mapPersonPrincipal(q, a.id));
    const principalB = await x.tx(q => mapPersonPrincipal(q, b.id));
    const firstBuyer = transition === 'guest to member' ? null : principalA.principal_id;
    const nextBuyer = transition === 'member to guest' ? null : principalB.principal_id;
    const first = await x.place(s, c, intent, firstBuyer);
    const before = await stockFacts();
    assert.deepEqual(await x.place(s, c, intent, nextBuyer), first);
    assert.equal((await x.h.pool.query('SELECT buyer_principal_id FROM commerce_orders WHERE order_id=$1', [first.order_id])).rows[0].buyer_principal_id, firstBuyer);
    assert.deepEqual(await stockFacts(), before);
    await assert.rejects(x.place(s, { ...c, terms_sha256: 'f'.repeat(64) }, intent, nextBuyer), code('order_intent_conflict'));
    assert.deepEqual(await stockFacts(), before);
  });
}

// M1's default stays broad; the installed payment port narrows it to attempts
// that can still be handed off or whose provider result remains outstanding.
for(const scenario of ['issued_held','issued_released','issued_handed','superseded_handed','superseded_unhanded','paid_released','failed','expired_unpaid','confirmed_application'] as const)
  test(`payment unresolved port: ${scenario}`,async()=>{
    const {seedAdmissionPaymentService}=await import('../e2e/hosted-payment-fixture.js');
    const {createCheckoutPaymentPorts}=await import('../../modules/agent-commerce/payments/attempts.js');
    const {bindStore}=await import('../../modules/agent-commerce/checkout/authority.js');
    const s=await x.store(100),c=await x.frozen(s);await seedAdmissionPaymentService(x,s);
    const paymentPorts={...ports,...createCheckoutPaymentPorts({settings:{checkoutEnabled:true,consoleEnabled:true,quarantine:false,providerProfiles:['ecpay.aio.credit.v1']},profiles:['ecpay.aio.credit.v1'],environment:'sandbox',admission:ports.admission!,keyring:null})};
    const place=()=>x.tx(q=>placeCheckoutOrder(q,s,{checkoutId:c.checkout_id,termsSha256:c.terms_sha256,clientOrderId:randomUUID(),buyerPrincipalId:null,environment:'sandbox'},paymentPorts));
    const o=await place(),a=(await x.h.pool.query('SELECT * FROM commerce_payment_attempts WHERE order_id=$1',[o.order_id])).rows[0];
    await x.tx(async q=>{
      await bindStore(q,s.tenantId);
      if(scenario.endsWith('_handed'))await q.query('UPDATE commerce_payment_attempts SET journaled_at=clock_timestamp(),handed_off_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1',[a.attempt_id]);
      if(scenario.startsWith('superseded'))await q.query("UPDATE commerce_payment_attempts SET state='superseded',superseded_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1",[a.attempt_id]);
      if(scenario.startsWith('paid'))await q.query("UPDATE commerce_payment_attempts SET state='paid',paid_at=clock_timestamp(),trade_no='TUNRESOLVED',version=version+1 WHERE attempt_id=$1",[a.attempt_id]);
      if(scenario==='failed'||scenario==='expired_unpaid')await q.query(`UPDATE commerce_payment_attempts SET state=$2,${scenario==='failed'?'failed_at':'expired_at'}=clock_timestamp(),version=version+1 WHERE attempt_id=$1`,[a.attempt_id,scenario]);
      if(scenario.endsWith('_released')){
        await q.query("UPDATE commerce_inventory_reservations SET state='released',released_at=clock_timestamp() WHERE order_id=$1",[o.order_id]);
        await q.query('UPDATE commerce_items SET reserved=reserved-5 WHERE item_id=$1',[s.product.product_id]);
      }
      if(scenario==='confirmed_application')await applyConfirmedPayment(q,{orderId:o.order_id,paymentRef:a.attempt_id,amountMinor:500,currency:'TWD',simulated:false});
      assert.equal((await paymentPorts.unresolved.find(q,c.checkout_id))?.order_id??null,['issued_held','issued_handed','superseded_handed','paid_released'].includes(scenario)?o.order_id:null);
    });
    if(['issued_held','issued_handed','superseded_handed','paid_released'].includes(scenario))await assert.rejects(place(),e=>code('unresolved_order')(e)&&(e as {order_ref:string}).order_ref===o.order_id);
    else assert.notEqual((await place()).order_id,o.order_id);
  });
test('payment unresolved port ignores expired unhanded holds and considers every attempt',async()=>{
  const {seedAdmissionPaymentService}=await import('../e2e/hosted-payment-fixture.js');
  const {createCheckoutPaymentPorts,createOrderPaymentAttempt}=await import('../../modules/agent-commerce/payments/attempts.js');
  const {bindStore}=await import('../../modules/agent-commerce/checkout/authority.js');
  const s=await x.store(100),due=await x.due(s,5);await seedAdmissionPaymentService(x,s);
  const options={settings:{checkoutEnabled:true,consoleEnabled:true,quarantine:false,providerProfiles:['ecpay.aio.credit.v1']},profiles:['ecpay.aio.credit.v1'],environment:'sandbox' as const,admission:ports.admission!,keyring:null},p=createCheckoutPaymentPorts(options);
  await x.tx(async q=>{
    await bindStore(q,s.tenantId);
    await p.payment.createOrderAttempt(q,{store:s,orderId:due.order_id,amountMinor:500,currency:'TWD',environment:'sandbox'});
    assert.equal(await p.unresolved.find(q,due.checkout.checkout_id),null);
    await q.query("UPDATE commerce_payment_attempts SET state='superseded',superseded_at=clock_timestamp(),handed_off_at=clock_timestamp(),journaled_at=clock_timestamp(),version=version+1 WHERE order_id=$1",[due.order_id]);
    await createOrderPaymentAttempt(q,{store:s,orderId:due.order_id,amountMinor:500,currency:'TWD',environment:'sandbox',sequence:2},options);
    await q.query("UPDATE commerce_payment_attempts SET state='failed',failed_at=clock_timestamp(),version=version+1 WHERE order_id=$1 AND sequence=2",[due.order_id]);
    assert.equal((await p.unresolved.find(q,due.checkout.checkout_id))?.order_id,due.order_id,'older handed-off superseded attempt still blocks');
    await q.query("UPDATE commerce_payment_attempts SET state='expired_unpaid',expired_at=clock_timestamp(),version=version+1 WHERE order_id=$1 AND sequence=1",[due.order_id]);
    assert.equal(await p.unresolved.find(q,due.checkout.checkout_id),null,'every attempt is now definite unpaid');
  });
});
