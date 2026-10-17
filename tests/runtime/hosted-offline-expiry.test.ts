import assert from 'node:assert/strict';
import {syntheticShippingPort} from '../../scripts/synthetic-shipping-quote.js';
import {createHash, randomBytes, randomInt, randomUUID} from 'node:crypto';
import {after, before, beforeEach, test} from 'node:test';
import {authenticate} from '../../modules/identity-membership/service.js';
import {checkoutInventory} from '../../modules/agent-commerce/checkout/inventory.js';
import {placeCheckoutOrder, type CheckoutOrderRow} from '../../modules/agent-commerce/checkout/orders.js';
import {sweepDueCheckoutHolds, settleDueCheckoutHolds} from '../../modules/agent-commerce/checkout/settlement.js';
import {canonicalJSON, freezeCheckout, type CheckoutPorts} from '../../modules/agent-commerce/checkout/terms.js';
import {runDueCommerceWork} from '../../modules/agent-commerce/operations/due-work.js';
import {confirmOfflinePayment} from '../../modules/agent-commerce/payments/offline/confirm.js';
import {createPaymentMethodsPort} from '../../modules/agent-commerce/payments/offline/methods.js';
import {endOfflinePaymentWindow} from '../../modules/agent-commerce/payments/offline/window.js';
import {settleOrderPayments} from '../../modules/agent-commerce/payments/window.js';
import {mapPersonPrincipal} from '../../packages/resource-scopes/index.js';
import {Problem} from '../../packages/shared/problem.js';
import {checkoutHarness, type CheckoutHarness} from './hosted-checkout-harness.js';

const syllables = ['青', '禾', '川', '石', '林', '安', '白', '南'];
const synthetic = (n: number) => Array.from({length: n}, () => syllables[randomInt(syllables.length)]).join('');
let x: CheckoutHarness;
before(async () => { x = await checkoutHarness('fp_offline_expiry'); });
beforeEach(async () => x.reset());
after(async () => x?.stop());

const ports = (): CheckoutPorts => ({
  admission: {allowed: () => true},
  shipping: syntheticShippingPort({method_ref: 'meetup'}),
  paymentMethods: createPaymentMethodsPort({environment: 'sandbox', profiles: ['offline.bank_transfer.v1', 'offline.cash_on_meetup.v1']}),
});

async function actorOf(cookie: string) {
  return authenticate(x.runtime, cookie.split('=')[1].split(';')[0]);
}
async function today() {
  return (await x.h.pool.query<{today: string}>("SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Taipei','YYYY-MM-DD') AS today")).rows[0].today;
}
async function placeBank(stock = 8): Promise<{s: Awaited<ReturnType<CheckoutHarness['store']>>; order: CheckoutOrderRow; owner: Awaited<ReturnType<typeof actorOf>>}> {
  const s = await x.store(stock);
  const release = (await x.h.pool.query<{version: string}>('SELECT version::text FROM module_instances WHERE instance_id=$1', [s.instanceId])).rows[0].version;
  const upgraded = await x.h.call('POST', `${s.root}/upgrade`, s.owner, {}, {'Idempotency-Key': randomUUID(), 'If-Match': `"${release}"`}, x.app);
  assert.equal(upgraded.status, 200, JSON.stringify(upgraded.data));
  const checkoutPorts = ports();
  const ownerPrincipal = await x.tx(q => mapPersonPrincipal(q, s.owner.user.user_id));
  const document = {schema: 'freedom.offline-payment-settings/v1', bank_transfer: {bank_code: String(100 + randomInt(900)).padStart(3, '0'), bank_name: synthetic(2), branch_name: null, account_number: String(randomBytes(4).readUInt32BE()).padStart(10, '0').slice(0, 12), account_name: synthetic(2), deadline_days: 3, note: null}, cash_on_meetup: {deadline_days: 7}};
  await x.h.pool.query(`INSERT INTO commerce_offline_payment_settings(tenant_id,instance_id,version,document,document_sha256,created_by_principal_id)
    VALUES($1,$2,1,$3,$4,$5)`, [s.tenantId, s.instanceId, document, createHash('sha256').update(canonicalJSON(document)).digest('hex'), ownerPrincipal.principal_id]);
  const buyer = await x.h.person(synthetic(3));
  const principal = await x.tx(q => mapPersonPrincipal(q, buyer.id));
  const saved = await x.tx(q => freezeCheckout(q, s, {...x.input(s.product.sku, 1), idempotencyKey: randomUUID()}, checkoutPorts));
  const order = await x.tx(q => placeCheckoutOrder(q, s, {checkoutId: saved.checkout_id, termsSha256: saved.terms_sha256, clientOrderId: randomUUID(), buyerPrincipalId: principal.principal_id, environment: 'sandbox', paymentMethod: 'bank_transfer'}, checkoutPorts));
  return {s, order, owner: await actorOf(s.owner.cookie)};
}
async function backdate(sourceOrderId: string, days = 8) {
  const id = randomUUID(), client = randomUUID();
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const suffix = [...randomBytes(6)].map(byte => alphabet[byte & 31]).join('');
  const checkoutId = (await x.h.pool.query<{checkout_id: string}>('SELECT checkout_id FROM commerce_checkout_orders WHERE order_id=$1', [sourceOrderId])).rows[0].checkout_id;
  const q = await x.h.pool.connect();
  try {
    await q.query('BEGIN');
    await q.query(`INSERT INTO commerce_orders(order_id,public_shop_id,external_id,request_sha256,currency,total_minor,created_at,expires_at,order_profile,client_order_id)
      SELECT $2::uuid,o.public_shop_id,'chk:'||$3::text||':'||($4::uuid)::text,o.request_sha256,o.currency,o.total_minor,t,t+interval '72 hours','hosted_checkout',$4::uuid
      FROM commerce_orders o CROSS JOIN (SELECT date_trunc('milliseconds',clock_timestamp()-($5::int * interval '1 day')) AS t) n
      WHERE o.order_id=$1::uuid`, [sourceOrderId, id, checkoutId, client, days]);
    await q.query(`INSERT INTO commerce_checkout_orders(order_id,tenant_id,instance_id,checkout_id,customer_id,contact_id,display_number,terms,terms_sha256,environment,payment_method)
      SELECT $1::uuid,c.tenant_id,c.instance_id,c.checkout_id,c.customer_id,c.current_contact_id,to_char(o.created_at AT TIME ZONE 'Asia/Taipei','YYMMDD')||'-'||$3,c.terms,c.terms_sha256,'sandbox','bank_transfer'
      FROM commerce_checkouts c JOIN commerce_orders o ON o.order_id=$1::uuid WHERE c.checkout_id=$2::uuid`, [id, checkoutId, suffix]);
    await q.query(`INSERT INTO commerce_order_lines(order_id,selection_id,item_id,quantity,snapshot,order_profile,supplier_shop_id,hosted_offer_id,acceptance_id,listing_sha256)
      SELECT $2::uuid,selection_id,item_id,quantity,snapshot,order_profile,supplier_shop_id,hosted_offer_id,acceptance_id,listing_sha256 FROM commerce_order_lines WHERE order_id=$1::uuid`, [sourceOrderId, id]);
    await q.query(`INSERT INTO commerce_inventory_reservations(order_id,item_id,supplier_shop_id,quantity,state,created_at,expires_at)
      SELECT o.order_id,l.item_id,l.supplier_shop_id,l.quantity,'held',o.created_at,o.expires_at FROM commerce_orders o JOIN commerce_order_lines l USING(order_id) WHERE o.order_id=$1::uuid`, [id]);
    await q.query('UPDATE commerce_items SET reserved=reserved+l.quantity FROM commerce_order_lines l WHERE l.order_id=$1 AND commerce_items.item_id=l.item_id', [id]);
    await q.query(`INSERT INTO commerce_due_work(tenant_id,instance_id,kind,target_id,due_at)
      SELECT co.tenant_id,co.instance_id,'offline_payment_window_end',o.order_id,o.expires_at+interval '72 hours'
      FROM commerce_orders o JOIN commerce_checkout_orders co USING(order_id) WHERE o.order_id=$1::uuid`, [id]);
    await q.query('COMMIT');
  } catch (error) { await q.query('ROLLBACK'); throw error; } finally { q.release(); }
  return id;
}
async function state(orderId: string) {
  return (await x.h.pool.query<{lifecycle: string; reason: string | null; hold: string | null; due: number; payments: number; outcome: string | null; stock: number; reserved: number}>(`SELECT co.lifecycle_state AS lifecycle, co.cancel_reason AS reason,
    (SELECT state FROM commerce_inventory_reservations WHERE order_id=$1 LIMIT 1) AS hold,
    (SELECT count(*)::int FROM commerce_due_work WHERE target_id=$1 AND kind='offline_payment_window_end') AS due,
    (SELECT count(*)::int FROM commerce_offline_payments WHERE order_id=$1) AS payments,
    (SELECT outcome FROM commerce_checkout_payment_applications WHERE order_id=$1 ORDER BY created_at, application_id LIMIT 1) AS outcome,
    i.stock::int, i.reserved::int
    FROM commerce_checkout_orders co JOIN commerce_order_lines l ON l.order_id=co.order_id JOIN commerce_items i ON i.item_id=l.item_id WHERE co.order_id=$1`, [orderId])).rows[0];
}

test('hold expiry returns stock and leaves the offline order open', async () => {
  const {s, order} = await placeBank();
  const historical = await backdate(order.order_id);
  const before = await state(historical);
  assert.equal(before.hold, 'held');
  const swept = await sweepDueCheckoutHolds(x.runtime, {limit: 200});
  assert.equal(swept >= 1, true);
  const settled = await x.tx(q => settleDueCheckoutHolds(q, [s.product.product_id]));
  assert.equal(settled, 0);
  const after = await state(historical);
  assert.equal(after.lifecycle, 'open');
  assert.equal(after.reason, null);
  assert.equal(after.hold, 'released');
  assert.equal(after.stock, before.stock);
  assert.equal(after.reserved, before.reserved - 1);
  assert.equal((await state(order.order_id)).hold, 'held');
});

test('confirmation inside the grace period allocates or opens an unallocatable exception', async () => {
  const {s, order, owner} = await placeBank();
  const date = await today();
  const inGrace = await backdate(order.order_id, 4);
  await sweepDueCheckoutHolds(x.runtime, {limit: 200});
  assert.equal((await state(inGrace)).hold, 'released');
  await confirmOfflinePayment(x.runtime, owner, s.tenantId, s.instanceId, inGrace, {amount_minor: order.terms.total_minor, received_on: date}, randomUUID(), '1');
  assert.equal((await state(inGrace)).outcome, 'allocated');
  const blocked = await placeBank(4);
  const blockedInGrace = await backdate(blocked.order.order_id, 4);
  await sweepDueCheckoutHolds(x.runtime, {limit: 200});
  await x.tx(async q => { await (await checkoutInventory(q, blocked.order.order_id)).releaseHolds(); });
  await x.h.pool.query('UPDATE commerce_items SET stock=0 WHERE item_id=$1', [blocked.s.product.product_id]);
  await confirmOfflinePayment(x.runtime, blocked.owner, blocked.s.tenantId, blocked.s.instanceId, blockedInGrace, {amount_minor: blocked.order.terms.total_minor, received_on: date}, randomUUID(), '1');
  const row = await state(blockedInGrace);
  assert.equal(row.outcome, 'unallocatable');
  assert.equal(row.lifecycle, 'open');
  assert.equal((await x.h.pool.query<{n: number}>("SELECT count(*)::int AS n FROM commerce_exception_cases WHERE order_id=$1 AND kind='paid_unallocatable' AND subject_kind='offline_payment'", [blockedInGrace])).rows[0].n, 1);
});

test('the offline window reschedules before grace, cancels after it, and never cancels a confirmed order', async () => {
  const {s, order, owner} = await placeBank();
  const date = await today();
  assert.equal(await endOfflinePaymentWindow(x.runtime, order.order_id), 'skipped');
  await x.h.pool.query(`UPDATE commerce_due_work SET due_at=clock_timestamp()-interval '1 minute', lease_until=NULL WHERE target_id=$1 AND kind='offline_payment_window_end'`, [order.order_id]);
  assert.equal(await endOfflinePaymentWindow(x.runtime, order.order_id), 'completed');
  const rescheduled = await state(order.order_id);
  assert.equal(rescheduled.lifecycle, 'open');
  assert.equal(rescheduled.due, 1);
  assert.equal((await x.h.pool.query<{matched: boolean}>('SELECT due_at=(SELECT expires_at+interval \'72 hours\' FROM commerce_orders WHERE order_id=$1) AS matched FROM commerce_due_work WHERE target_id=$1 AND kind=\'offline_payment_window_end\'', [order.order_id])).rows[0].matched, true);
  await confirmOfflinePayment(x.runtime, owner, s.tenantId, s.instanceId, order.order_id, {amount_minor: order.terms.total_minor, received_on: date}, randomUUID(), order.version);
  await x.h.pool.query(`UPDATE commerce_due_work SET due_at=clock_timestamp()-interval '1 minute', lease_until=NULL WHERE target_id=$1`, [order.order_id]);
  assert.equal(await endOfflinePaymentWindow(x.runtime, order.order_id), 'completed');
  const kept = await state(order.order_id);
  assert.equal(kept.lifecycle, 'open');
  assert.equal(kept.reason, null);
  assert.equal(kept.payments, 1);
  assert.equal(kept.due, 0);
  const late = await placeBank();
  const historical = await backdate(late.order.order_id);
  const confirmed = await confirmOfflinePayment(x.runtime, late.owner, late.s.tenantId, late.s.instanceId, historical, {amount_minor: late.order.terms.total_minor, received_on: date}, randomUUID(), '1');
  assert.equal(confirmed.payment_state, 'confirmed');
  assert.equal((await state(historical)).lifecycle, 'open');
  assert.equal(await endOfflinePaymentWindow(x.runtime, historical), 'completed');
  const stillOpen = await state(historical);
  assert.equal(stillOpen.lifecycle, 'open');
  assert.equal(stillOpen.payments, 1);
  assert.equal(stillOpen.due, 0);
  const ending = await placeBank();
  const expired = await backdate(ending.order.order_id);
  assert.equal(await endOfflinePaymentWindow(x.runtime, expired), 'completed');
  const cancelled = await state(expired);
  assert.equal(cancelled.lifecycle, 'cancelled');
  assert.equal(cancelled.reason, 'payment_not_completed');
  assert.equal(cancelled.payments, 0);
  assert.equal(cancelled.due, 0);
  assert.equal(cancelled.hold, 'released');
});

test('card settlement and due work ignore offline orders unless the offline window is due', async () => {
  const {s, order} = await placeBank();
  assert.equal(await x.tx(q => settleOrderPayments(q, order.order_id)), false);
  assert.equal((await state(order.order_id)).lifecycle, 'open');
  const cardPorts: CheckoutPorts = {admission: {allowed: () => true}, shipping: ports().shipping, paymentMethods: {offlinePaymentRequiresMember: true, async resolve() { return {options: [{method: 'immediate_card', available: true, reason: null}], offline: null}; }, async onOfflineOrderPlaced() {}}};
  const saved = await x.tx(q => freezeCheckout(q, s, {...x.input(s.product.sku, 1), idempotencyKey: randomUUID()}, cardPorts));
  const card = await x.tx(q => placeCheckoutOrder(q, s, {checkoutId: saved.checkout_id, termsSha256: saved.terms_sha256, clientOrderId: randomUUID(), buyerPrincipalId: null, environment: 'sandbox'}, cardPorts));
  assert.equal((await x.h.pool.query<{n: number}>("SELECT count(*)::int AS n FROM commerce_due_work WHERE target_id=$1 AND kind='offline_payment_window_end'", [card.order_id])).rows[0].n, 0);
  const historical = await backdate(order.order_id);
  await assert.rejects(endOfflinePaymentWindow(x.runtime, historical, {tenantId: randomUUID()}), (error: unknown) => error instanceof Error && error.message === 'due_work_binding_invalid');
  assert.equal((await state(historical)).lifecycle, 'open');
  const counts = await runDueCommerceWork(x.runtime, {freedomEnv: 'local'}, {targets: [historical]});
  assert.equal(counts.completed, 1);
  assert.equal(counts.failed, 0);
  assert.equal(counts.externalCalls, 0);
  const cancelled = await state(historical);
  assert.equal(cancelled.lifecycle, 'cancelled');
  assert.equal(cancelled.reason, 'payment_not_completed');
  assert.equal((await state(order.order_id)).lifecycle, 'open');
});
