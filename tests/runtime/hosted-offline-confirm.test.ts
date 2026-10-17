import assert from 'node:assert/strict';
import {createHash, randomBytes, randomInt, randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {after, before, beforeEach, test} from 'node:test';
import {SellerCheckoutOrderSchema} from '../../contracts/guild-launchpad/v1/hosted-seller-checkout.js';
import {CheckoutTermsSchema} from '../../contracts/guild-launchpad/v1/hosted-checkout.js';
import {authenticate} from '../../modules/identity-membership/service.js';
import {lockStore} from '../../modules/agent-commerce/checkout/authority.js';
import {checkoutInventory} from '../../modules/agent-commerce/checkout/inventory.js';
import {placeCheckoutOrder, type CheckoutOrderRow} from '../../modules/agent-commerce/checkout/orders.js';
import {applyConfirmedPayment, retryAllocation} from '../../modules/agent-commerce/checkout/payments.js';
import {cancelPublicOrder, createPublicCheckout, placePublicOrder, type HostedCheckoutOptions} from '../../modules/agent-commerce/checkout/public-commands.js';
import {listSellerExceptions} from '../../modules/agent-commerce/checkout/seller-exceptions.js';
import {cancelSellerCheckoutOrder, listSellerCheckoutOrders, readSellerCheckoutOrder} from '../../modules/agent-commerce/checkout/seller-orders.js';
import {endOfflinePaymentWindow} from '../../modules/agent-commerce/payments/offline/window.js';
import {recordSellerRefund} from '../../modules/agent-commerce/payments/refunds.js';
import {canonicalJSON, freezeCheckout, type CheckoutPorts} from '../../modules/agent-commerce/checkout/terms.js';
import {completeMeetup, confirmOfflinePayment, recordMeetupHandover} from '../../modules/agent-commerce/payments/offline/confirm.js';
import {createPaymentMethodsPort} from '../../modules/agent-commerce/payments/offline/methods.js';
import {mapPersonPrincipal} from '../../packages/resource-scopes/index.js';
import {Problem} from '../../packages/shared/problem.js';
import {createTenantListCursorCodec} from '../../packages/shared/tenant-list-cursor.js';
import {checkoutHarness, type CheckoutHarness} from './hosted-checkout-harness.js';
import {syntheticShippingPort} from '../../scripts/synthetic-shipping-quote.js';

const syllables = ['青', '禾', '川', '石', '林', '安', '白', '南'];
const synthetic = (n: number) => Array.from({length: n}, () => syllables[randomInt(syllables.length)]).join('');
let x: CheckoutHarness;
before(async () => { x = await checkoutHarness('fp_offline_confirm'); });
beforeEach(async () => x.reset());
after(async () => x?.stop());

const offlinePorts = (method: 'meetup' | 'home' = 'meetup'): CheckoutPorts => ({
  admission: {allowed: () => true},
  shipping: syntheticShippingPort({method_ref: method}),
  paymentMethods: createPaymentMethodsPort({environment: 'sandbox', profiles: ['offline.bank_transfer.v1', 'offline.cash_on_meetup.v1']}),
});
const problem = (status: number, code: string) => (error: unknown) => error instanceof Problem && error.status === status && error.code === code;
const pages = () => ({cursors: createTenantListCursorCodec(randomBytes(32).toString('base64url'), {environment: 'local', origin: x.h.origin})});
const quarantine = {settings: {checkoutEnabled: true, quarantine: true, providerProfiles: [] as const}};

async function actorOf(cookie: string) {
  return authenticate(x.runtime, cookie.split('=')[1].split(';')[0]);
}
async function today() {
  return (await x.h.pool.query<{today: string}>("SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Taipei','YYYY-MM-DD') AS today")).rows[0].today;
}
async function counts(orderId: string) {
  const row = (await x.h.pool.query<{payments: number; handovers: number; outcome: string | null}>(`SELECT
    (SELECT count(*)::int FROM commerce_offline_payments WHERE order_id=$1) AS payments,
    (SELECT count(*)::int FROM commerce_meetup_handovers WHERE order_id=$1) AS handovers,
    (SELECT outcome FROM commerce_checkout_payment_applications WHERE order_id=$1 ORDER BY created_at, application_id LIMIT 1) AS outcome`, [orderId])).rows[0];
  return row;
}
test('replay of meetup completion is denied after fulfil is revoked while orders:manage remains', async () => {
  const {s, order} = await placeOffline('cash_on_meetup');
  const clerk = await operator(s, ['store:orders:manage', 'store:fulfil']);
  const date = await today(), key = randomUUID();
  const done = await completeMeetup(x.runtime, clerk.actor, s.tenantId, s.instanceId, order.order_id, {amount_minor: order.terms.total_minor, completed_on: date}, key, order.version);
  assert.equal(SellerCheckoutOrderSchema.parse(done).meetup_handover !== null, true);
  assert.equal((await counts(order.order_id)).payments, 1);
  const replay = await completeMeetup(x.runtime, clerk.actor, s.tenantId, s.instanceId, order.order_id, {amount_minor: order.terms.total_minor, completed_on: date}, key, order.version);
  assert.equal(replay.order_ref, order.order_id);
  assert.equal((await counts(order.order_id)).payments, 1);
  await x.h.pool.query(`UPDATE tenant_module_permissions SET capabilities=ARRAY['store:read','store:orders:manage'], updated_at=clock_timestamp(), version=version+1
    WHERE tenant_id=$1 AND principal_id=$2`, [s.tenantId, clerk.principal]);
  await assert.rejects(completeMeetup(x.runtime, clerk.actor, s.tenantId, s.instanceId, order.order_id, {amount_minor: order.terms.total_minor, completed_on: date}, key, order.version),
    (error: unknown) => error instanceof Problem && error.status === 403 && error.code === 'capability_denied');
  assert.deepEqual(await counts(order.order_id), {payments: 1, handovers: 1, outcome: 'converted'});
  assert.equal((await x.h.pool.query(`SELECT count(*)::int AS n FROM scoped_command_receipts WHERE operation='commerce.checkout_order.complete_meetup' AND target_id=$1`, [order.order_id])).rows[0].n, 1);
});

test('meetup completion revalidation after a receipt-insert wait denies a fulfil revocation and rolls the effect back', {timeout: 30_000}, async () => {
  const {s, order} = await placeOffline('cash_on_meetup');
  const clerk = await operator(s, ['store:orders:manage', 'store:fulfil']);
  const date = await today(), key = randomUUID();
  const blocker = await x.h.pool.connect();
  let pending!: Promise<{value: unknown} | {error: unknown}>;
  try {
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE scoped_command_receipts IN SHARE ROW EXCLUSIVE MODE');
    const holder = Number((await blocker.query<{pid: number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    pending = completeMeetup(x.runtime, clerk.actor, s.tenantId, s.instanceId, order.order_id, {amount_minor: order.terms.total_minor, completed_on: date}, key, order.version)
      .then(value => ({value}), (error: unknown) => ({error}));
    await blockedBy(holder);
    await blocker.query(`UPDATE tenant_module_permissions SET capabilities=ARRAY['store:read','store:orders:manage'], updated_at=clock_timestamp(), version=version+1
      WHERE tenant_id=$1 AND principal_id=$2`, [s.tenantId, clerk.principal]);
    await blocker.query('COMMIT');
  } finally {
    await blocker.query('ROLLBACK').catch(() => {});
    blocker.release();
  }
  const result = await pending;
  assert.ok('error' in result, 'receipt revalidation must refuse the revoked fulfil capability');
  assert.ok(result.error instanceof Problem && result.error.status === 403 && result.error.code === 'capability_denied');
  assert.deepEqual(await counts(order.order_id), {payments: 0, handovers: 0, outcome: null});
  assert.equal((await x.h.pool.query(`SELECT count(*)::int AS n FROM scoped_command_receipts WHERE operation='commerce.checkout_order.complete_meetup' AND target_id=$1`, [order.order_id])).rows[0].n, 0);
});

test('a bank meetup handover succeeds after allocation retry without rewriting the unallocatable application', async () => {
  const {s, order, owner} = await placeOffline('bank_transfer');
  await x.tx(async q => { await (await checkoutInventory(q, order.order_id)).releaseHolds(); });
  await x.h.pool.query('UPDATE commerce_items SET stock=0 WHERE item_id=$1', [s.product.product_id]);
  const date = await today();
  const confirmed = SellerCheckoutOrderSchema.parse(await confirmOfflinePayment(x.runtime, owner, s.tenantId, s.instanceId, order.order_id, {amount_minor: order.terms.total_minor, received_on: date}, randomUUID(), order.version));
  assert.equal(confirmed.actions.record_meetup_handover, false);
  assert.equal((await counts(order.order_id)).outcome, 'unallocatable');
  await assert.rejects(recordMeetupHandover(x.runtime, owner, s.tenantId, s.instanceId, order.order_id, {completed_on: date}, randomUUID(), order.version),
    (error: unknown) => error instanceof Problem && error.status === 409 && error.code === 'meetup_stock_unavailable');
  await x.h.pool.query('UPDATE commerce_items SET stock=5 WHERE item_id=$1', [s.product.product_id]);
  await x.tx(q => retryAllocation(q, s, order.order_id));
  const recovered = SellerCheckoutOrderSchema.parse(await readSellerCheckoutOrder(x.runtime, owner, s.tenantId, s.instanceId, order.order_id));
  assert.equal(recovered.actions.record_meetup_handover, true);
  assert.equal((await counts(order.order_id)).outcome, 'unallocatable');
  const handed = SellerCheckoutOrderSchema.parse(await recordMeetupHandover(x.runtime, owner, s.tenantId, s.instanceId, order.order_id, {completed_on: date}, randomUUID(), order.version));
  assert.ok(handed.meetup_handover);
  assert.equal(handed.actions.record_meetup_handover, false);
  assert.deepEqual(await counts(order.order_id), {payments: 1, handovers: 1, outcome: 'unallocatable'});
});

test('frozen offline terms require a deadline exactly for each offered method', async () => {
  const {order} = await placeOffline('bank_transfer');
  const offline = order.terms.offline_payment;
  assert.ok(offline);
  assert.deepEqual(order.terms.payment_methods, ['bank_transfer', 'cash_on_meetup']);
  CheckoutTermsSchema.parse(order.terms);
  assert.equal(CheckoutTermsSchema.safeParse({...order.terms, offline_payment: {...offline, meetup_deadline_days: null}}).success, false);
  assert.equal(CheckoutTermsSchema.safeParse({...order.terms, payment_methods: ['bank_transfer']}).success, false);
  assert.equal(CheckoutTermsSchema.safeParse({...order.terms, payment_methods: ['bank_transfer'], offline_payment: {...offline, meetup_deadline_days: null}}).success, true);
});

test('confirmation reports converted and allocated outcomes and rejects every payment check in order', async () => {
  const {s, order, owner} = await placeOffline('bank_transfer', 12);
  const date = await today();
  const before = await balances(s.product.product_id);
  const converted = SellerCheckoutOrderSchema.parse(await confirmOfflinePayment(x.runtime, owner, s.tenantId, s.instanceId, order.order_id, {amount_minor: order.terms.total_minor, received_on: date, reference: 'ref-a'}, randomUUID(), order.version));
  assert.equal((await counts(order.order_id)).outcome, 'converted');
  assert.equal(converted.actions.confirm_offline_payment, false);
  assert.equal(converted.actions.record_meetup_handover, true);
  assert.equal(converted.payment_detail?.offline_payments[0].reference, 'ref-a');
  assert.equal(converted.payment_detail?.applications[0].attempt_ref, null);
  assert.equal(converted.payment_detail?.applications[0].offline_payment_ref, converted.payment_detail?.offline_payments[0].offline_payment_ref);
  const after = await balances(s.product.product_id);
  assert.equal(after.stock, before.stock);
  assert.equal(after.reserved, before.reserved);
  const released = await more(s, 'bank_transfer');
  await x.tx(async q => { await (await checkoutInventory(q, released.order_id)).releaseHolds(); });
  await confirmOfflinePayment(x.runtime, owner, s.tenantId, s.instanceId, released.order_id, {amount_minor: released.terms.total_minor, received_on: date}, randomUUID(), released.version);
  assert.equal((await counts(released.order_id)).outcome, 'allocated');
  const cash = await more(s, 'cash_on_meetup');
  const mismatch = {amount_minor: cash.terms.total_minor, received_on: date};
  await assert.rejects(confirmOfflinePayment(x.runtime, owner, s.tenantId, s.instanceId, cash.order_id, mismatch, randomUUID(), cash.version), problem(409, 'payment_method_mismatch'));
  const tomorrow = (await x.h.pool.query<{d: string}>("SELECT to_char((clock_timestamp() AT TIME ZONE 'Asia/Taipei')::date + 1,'YYYY-MM-DD') AS d")).rows[0].d;
  await assert.rejects(completeMeetup(x.runtime, owner, s.tenantId, s.instanceId, cash.order_id, {amount_minor: 1, completed_on: tomorrow}, randomUUID(), cash.version), problem(422, 'offline_amount_mismatch'));
  await assert.rejects(completeMeetup(x.runtime, owner, s.tenantId, s.instanceId, cash.order_id, {amount_minor: cash.terms.total_minor, completed_on: tomorrow}, randomUUID(), cash.version), problem(422, 'offline_payment_date_invalid'));
  const stockBefore = await balances(s.product.product_id);
  const done = SellerCheckoutOrderSchema.parse(await completeMeetup(x.runtime, owner, s.tenantId, s.instanceId, cash.order_id, {amount_minor: cash.terms.total_minor, completed_on: date}, randomUUID(), cash.version));
  const stockAfter = await balances(s.product.product_id);
  assert.equal(stockAfter.stock, stockBefore.stock - 1);
  assert.equal(stockAfter.reserved, stockBefore.reserved - 1);
  assert.equal((await counts(cash.order_id)).outcome, 'converted');
  assert.ok(done.meetup_handover);
  assert.equal(done.actions.complete_meetup, false);
  await assert.rejects(completeMeetup(x.runtime, owner, s.tenantId, s.instanceId, cash.order_id, {amount_minor: cash.terms.total_minor, completed_on: date}, randomUUID(), cash.version), problem(409, 'payment_already_applied'));
  const cancelled = await more(s, 'bank_transfer');
  const closedBySeller = await cancelSellerCheckoutOrder(x.runtime, owner, s.tenantId, s.instanceId, cancelled.order_id, randomUUID(), cancelled.version);
  await assert.rejects(confirmOfflinePayment(x.runtime, owner, s.tenantId, s.instanceId, cancelled.order_id, {amount_minor: cancelled.terms.total_minor, received_on: date}, randomUUID(), closedBySeller.version), problem(409, 'order_cancelled'));
  const finished = await more(s, 'bank_transfer');
  await x.h.pool.query(`UPDATE commerce_checkout_orders SET lifecycle_state='closed', closed_at=clock_timestamp(), version=version+1 WHERE order_id=$1`, [finished.order_id]);
  await assert.rejects(confirmOfflinePayment(x.runtime, owner, s.tenantId, s.instanceId, finished.order_id, {amount_minor: finished.terms.total_minor, received_on: date}, randomUUID(), '2'), problem(409, 'checkout_order_closed'));
  const dryStore = await placeOffline('cash_on_meetup', 4);
  await x.tx(async q => { await (await checkoutInventory(q, dryStore.order.order_id)).releaseHolds(); });
  await x.h.pool.query('UPDATE commerce_items SET stock=0 WHERE item_id=$1', [dryStore.s.product.product_id]);
  await assert.rejects(completeMeetup(x.runtime, dryStore.owner, dryStore.s.tenantId, dryStore.s.instanceId, dryStore.order.order_id, {amount_minor: dryStore.order.terms.total_minor, completed_on: date}, randomUUID(), dryStore.order.version), problem(409, 'meetup_stock_unavailable'));
  assert.deepEqual(await counts(dryStore.order.order_id), {payments: 0, handovers: 0, outcome: null});
  assert.equal((await extras(dryStore.order.order_id)).applications, 0);
  assert.equal((await extras(dryStore.order.order_id)).exceptions, 0);
  assert.equal(await receipts('commerce.checkout_order.complete_meetup', dryStore.order.order_id), 0);
});

test('meetup handover accepts card and transfer payments and rejects every other state', async () => {
  const {s, order, owner} = await placeOffline('bank_transfer', 12);
  const date = await today();
  const tomorrow = (await x.h.pool.query<{d: string}>("SELECT to_char((clock_timestamp() AT TIME ZONE 'Asia/Taipei')::date + 1,'YYYY-MM-DD') AS d")).rows[0].d;
  const home = await more(s, 'bank_transfer', 'home');
  await assert.rejects(recordMeetupHandover(x.runtime, owner, s.tenantId, s.instanceId, home.order_id, {completed_on: date}, randomUUID(), home.version), problem(409, 'meetup_not_selected'));
  const cancelled = await more(s, 'bank_transfer');
  const sellerCancelled = await cancelSellerCheckoutOrder(x.runtime, owner, s.tenantId, s.instanceId, cancelled.order_id, randomUUID(), cancelled.version);
  await assert.rejects(recordMeetupHandover(x.runtime, owner, s.tenantId, s.instanceId, cancelled.order_id, {completed_on: date}, randomUUID(), sellerCancelled.version), problem(409, 'order_cancelled'));
  const closed = await more(s, 'bank_transfer');
  await x.h.pool.query(`UPDATE commerce_checkout_orders SET lifecycle_state='closed', closed_at=clock_timestamp(), version=version+1 WHERE order_id=$1`, [closed.order_id]);
  await assert.rejects(recordMeetupHandover(x.runtime, owner, s.tenantId, s.instanceId, closed.order_id, {completed_on: date}, randomUUID(), '2'), problem(409, 'checkout_order_closed'));
  const unpaid = await more(s, 'cash_on_meetup');
  await assert.rejects(recordMeetupHandover(x.runtime, owner, s.tenantId, s.instanceId, unpaid.order_id, {completed_on: date}, randomUUID(), unpaid.version), problem(409, 'payment_not_confirmed'));
  const transferred = SellerCheckoutOrderSchema.parse(await confirmOfflinePayment(x.runtime, owner, s.tenantId, s.instanceId, order.order_id, {amount_minor: order.terms.total_minor, received_on: date}, randomUUID(), order.version));
  await assert.rejects(recordMeetupHandover(x.runtime, owner, s.tenantId, s.instanceId, order.order_id, {completed_on: tomorrow}, randomUUID(), transferred.version), problem(422, 'offline_payment_date_invalid'));
  const handed = SellerCheckoutOrderSchema.parse(await recordMeetupHandover(x.runtime, owner, s.tenantId, s.instanceId, order.order_id, {completed_on: date}, randomUUID(), transferred.version));
  assert.ok(handed.meetup_handover);
  assert.equal(handed.actions.record_meetup_handover, false);
  await assert.rejects(recordMeetupHandover(x.runtime, owner, s.tenantId, s.instanceId, order.order_id, {completed_on: date}, randomUUID(), handed.version), problem(409, 'meetup_already_recorded'));
  const completed = SellerCheckoutOrderSchema.parse(await completeMeetup(x.runtime, owner, s.tenantId, s.instanceId, unpaid.order_id, {amount_minor: unpaid.terms.total_minor, completed_on: date}, randomUUID(), unpaid.version));
  await assert.rejects(recordMeetupHandover(x.runtime, owner, s.tenantId, s.instanceId, unpaid.order_id, {completed_on: date}, randomUUID(), completed.version), problem(409, 'meetup_already_recorded'));
  const shipped = await more(s, 'bank_transfer');
  const paid = await confirmOfflinePayment(x.runtime, owner, s.tenantId, s.instanceId, shipped.order_id, {amount_minor: shipped.terms.total_minor, received_on: date}, randomUUID(), shipped.version);
  await shipAll(s, shipped.order_id);
  await assert.rejects(recordMeetupHandover(x.runtime, owner, s.tenantId, s.instanceId, shipped.order_id, {completed_on: date}, randomUUID(), paid.version), problem(409, 'nothing_to_hand_over'));
  const card = await placeCard(s);
  await x.tx(q => applyConfirmedPayment(q, {orderId: card.order_id, paymentRef: randomUUID(), amountMinor: card.terms.total_minor, currency: 'TWD', simulated: false}));
  const cardVersion = (await x.h.pool.query<{version: string}>('SELECT version::text FROM commerce_checkout_orders WHERE order_id=$1', [card.order_id])).rows[0].version;
  const cardHanded = SellerCheckoutOrderSchema.parse(await recordMeetupHandover(x.runtime, owner, s.tenantId, s.instanceId, card.order_id, {completed_on: date}, randomUUID(), cardVersion));
  assert.ok(cardHanded.meetup_handover);
  assert.equal((await counts(card.order_id)).handovers, 1);
});

test('seller lists, finance facts and refunds follow the offline payment', async () => {
  const {s, order, owner} = await placeOffline('bank_transfer', 8);
  const date = await today();
  const cash = await more(s, 'cash_on_meetup');
  const card = await placeCard(s);
  const banks = await listSellerCheckoutOrders(x.runtime, owner, s.tenantId, s.instanceId, {payment_method: 'bank_transfer'}, pages());
  assert.deepEqual(banks.items.map(item => item.order_ref), [order.order_id]);
  const waiting = await listSellerCheckoutOrders(x.runtime, owner, s.tenantId, s.instanceId, {awaiting_offline_payment: 'true'}, pages());
  assert.deepEqual(waiting.items.map(item => item.order_ref).sort(), [order.order_id, cash.order_id].sort());
  assert.equal(waiting.items.every(item => item.payment_method !== 'immediate_card'), true);
  const open = SellerCheckoutOrderSchema.parse(await readSellerCheckoutOrder(x.runtime, owner, s.tenantId, s.instanceId, order.order_id));
  assert.equal(open.actions.confirm_offline_payment, true);
  assert.equal(open.actions.complete_meetup, false);
  assert.equal(open.payment_grace_until !== null, true);
  assert.equal(open.meetup_handover, null);
  const cardView = SellerCheckoutOrderSchema.parse(await readSellerCheckoutOrder(x.runtime, owner, s.tenantId, s.instanceId, card.order_id));
  assert.equal(cardView.payment_grace_until, null);
  assert.equal(cardView.actions.confirm_offline_payment, false);
  const cashView = SellerCheckoutOrderSchema.parse(await readSellerCheckoutOrder(x.runtime, owner, s.tenantId, s.instanceId, cash.order_id));
  assert.equal(cashView.actions.complete_meetup, true);
  const confirmed = SellerCheckoutOrderSchema.parse(await confirmOfflinePayment(x.runtime, owner, s.tenantId, s.instanceId, order.order_id, {amount_minor: order.terms.total_minor, received_on: date, reference: 'ref-a'}, randomUUID(), order.version));
  const stillWaiting = await listSellerCheckoutOrders(x.runtime, owner, s.tenantId, s.instanceId, {awaiting_offline_payment: 'true'}, pages());
  assert.deepEqual(stillWaiting.items.map(item => item.order_ref), [cash.order_id]);
  const reader = await operator(s, ['store:orders:read']);
  const masked = await readSellerCheckoutOrder(x.runtime, reader.actor, s.tenantId, s.instanceId, order.order_id);
  assert.equal(masked.payment_detail, null);
  await assert.rejects(recordSellerRefund(x.runtime, owner, s.tenantId, s.instanceId, order.order_id, {application_ref: confirmed.payment_detail!.applications[0].application_ref, amount_minor: order.terms.total_minor, refunded_on: date}, randomUUID()), problem(409, 'refund_not_available'));
  const exceptionStore = await placeOffline('bank_transfer', 4);
  await x.tx(async q => { await (await checkoutInventory(q, exceptionStore.order.order_id)).releaseHolds(); });
  await x.h.pool.query('UPDATE commerce_items SET stock=0 WHERE item_id=$1', [exceptionStore.s.product.product_id]);
  const unallocated = SellerCheckoutOrderSchema.parse(await confirmOfflinePayment(x.runtime, exceptionStore.owner, exceptionStore.s.tenantId, exceptionStore.s.instanceId, exceptionStore.order.order_id, {amount_minor: exceptionStore.order.terms.total_minor, received_on: date}, randomUUID(), exceptionStore.order.version));
  assert.equal((await counts(exceptionStore.order.order_id)).outcome, 'unallocatable');
  const facts = unallocated.exceptions[0].payment_facts;
  const expectedDate = (await x.h.pool.query<{d: Date}>('SELECT ($1::date::timestamp AT TIME ZONE \'Asia/Taipei\') AS d', [date])).rows[0].d.toISOString();
  assert.equal(facts?.merchant_trade_no, null);
  assert.equal(facts?.trade_no, null);
  assert.equal(facts?.expected_amount_minor, exceptionStore.order.terms.total_minor);
  assert.equal(facts?.paid_amount_minor, exceptionStore.order.terms.total_minor);
  assert.equal(facts?.currency, 'TWD');
  assert.equal(facts?.payment_type, 'bank_transfer');
  assert.equal(facts?.payment_date, expectedDate);
  const listed = await listSellerExceptions(x.runtime, exceptionStore.owner, exceptionStore.s.tenantId, exceptionStore.s.instanceId, {view: 'retailer'}, pages());
  assert.equal(listed.items[0].subject.kind, 'offline_payment');
  assert.equal(listed.items[0].payment_facts?.payment_type, 'bank_transfer');
  const quiet = await operator(exceptionStore.s, ['store:orders:read']);
  const hidden = await listSellerExceptions(x.runtime, quiet.actor, exceptionStore.s.tenantId, exceptionStore.s.instanceId, {view: 'retailer'}, pages());
  assert.equal(hidden.items[0].payment_facts, null);
});

test('replay, version, quarantine and the capability matrix stay on the current grant', async () => {
  const {s, order, owner} = await placeOffline('bank_transfer', 8);
  const date = await today();
  const body = {amount_minor: order.terms.total_minor, received_on: date, reference: 'ref-a'};
  const key = randomUUID();
  const first = await confirmOfflinePayment(x.runtime, owner, s.tenantId, s.instanceId, order.order_id, body, key, order.version);
  const replay = await confirmOfflinePayment(x.runtime, owner, s.tenantId, s.instanceId, order.order_id, body, key, order.version);
  assert.equal(replay.order_ref, first.order_ref);
  await assert.rejects(confirmOfflinePayment(x.runtime, owner, s.tenantId, s.instanceId, order.order_id, {...body, reference: 'ref-b'}, key, order.version), problem(409, 'idempotency_conflict'));
  assert.equal((await counts(order.order_id)).payments, 1);
  const stale = await more(s, 'bank_transfer');
  await assert.rejects(confirmOfflinePayment(x.runtime, owner, s.tenantId, s.instanceId, stale.order_id, {amount_minor: stale.terms.total_minor, received_on: date}, randomUUID(), '2'), problem(412, 'version_conflict'));
  assert.equal((await counts(stale.order_id)).payments, 0);
  const paused = await more(s, 'bank_transfer');
  await assert.rejects(confirmOfflinePayment(x.runtime, owner, s.tenantId, s.instanceId, paused.order_id, {amount_minor: paused.terms.total_minor, received_on: date}, randomUUID(), paused.version, quarantine), problem(503, 'commerce_quarantined'));
  assert.equal(await receipts('commerce.checkout_order.confirm_offline_payment', paused.order_id), 0);
  const blind = await operator(s, ['store:orders:manage']);
  await x.h.pool.query(`UPDATE tenant_module_permissions SET capabilities=ARRAY['store:orders:manage'], updated_at=clock_timestamp(), version=version+1 WHERE tenant_id=$1 AND principal_id=$2`, [s.tenantId, blind.principal]);
  await assert.rejects(confirmOfflinePayment(x.runtime, blind.actor, s.tenantId, s.instanceId, paused.order_id, {amount_minor: paused.terms.total_minor, received_on: date}, randomUUID(), paused.version), problem(404, 'not_found'));
  const manager = await operator(s, ['store:orders:manage']);
  const meetup = await more(s, 'cash_on_meetup');
  await assert.rejects(completeMeetup(x.runtime, manager.actor, s.tenantId, s.instanceId, meetup.order_id, {amount_minor: meetup.terms.total_minor, completed_on: date}, randomUUID(), meetup.version), problem(403, 'capability_denied'));
  const clerk = await operator(s, ['store:fulfil']);
  await assert.rejects(confirmOfflinePayment(x.runtime, clerk.actor, s.tenantId, s.instanceId, paused.order_id, {amount_minor: paused.terms.total_minor, received_on: date}, randomUUID(), paused.version), problem(403, 'capability_denied'));
  const grantKey = randomUUID();
  await confirmOfflinePayment(x.runtime, manager.actor, s.tenantId, s.instanceId, paused.order_id, {amount_minor: paused.terms.total_minor, received_on: date}, grantKey, paused.version);
  await x.h.pool.query(`UPDATE tenant_module_permissions SET capabilities=ARRAY['store:read'], updated_at=clock_timestamp(), version=version+1 WHERE tenant_id=$1 AND principal_id=$2`, [s.tenantId, manager.principal]);
  await assert.rejects(confirmOfflinePayment(x.runtime, manager.actor, s.tenantId, s.instanceId, paused.order_id, {amount_minor: paused.terms.total_minor, received_on: date}, grantKey, paused.version), problem(403, 'capability_denied'));
  assert.equal((await counts(paused.order_id)).payments, 1);
});

test('confirm, cancel, expiry and meetup completion each leave one winner', {timeout: 60_000}, async () => {
  const date = await today();
  const publicBank = await placePublicBank();
  let buyer = '';
  {
    await raceOnce([
      confirmOfflinePayment(x.runtime, publicBank.owner, publicBank.s.tenantId, publicBank.s.instanceId, publicBank.order.order_ref, {amount_minor: publicBank.order.total_minor, received_on: date}, randomUUID(), '1'),
      cancelPublicOrder(x.runtime, publicBank.s.slug, publicBank.order.order_ref, publicBank.access, publicBank.opt),
    ]);
    const row = await extras(publicBank.order.order_ref);
    const payments = (await counts(publicBank.order.order_ref)).payments;
    if (payments === 1 && row.lifecycle === 'open') buyer = 'paid';
    else if (payments === 0 && row.reason === 'buyer_cancelled') buyer = 'cancelled';
  }
  assert.equal(buyer === 'paid' || buyer === 'cancelled', true);
  const pair = await placeOffline('bank_transfer', 4);
  let confirmed = 0;
  {
    const raced = await raceOnce([
      confirmOfflinePayment(x.runtime, pair.owner, pair.s.tenantId, pair.s.instanceId, pair.order.order_id, {amount_minor: pair.order.terms.total_minor, received_on: date}, randomUUID(), pair.order.version),
      confirmOfflinePayment(x.runtime, pair.owner, pair.s.tenantId, pair.s.instanceId, pair.order.order_id, {amount_minor: pair.order.terms.total_minor, received_on: date}, randomUUID(), pair.order.version),
    ]);
    confirmed = (await counts(pair.order.order_id)).payments;
    if (confirmed === 1) assert.equal(raced.filter(item => item.status === 'fulfilled').length, 1);
  }
  assert.equal(confirmed, 1);
  const meetup = await placeOffline('cash_on_meetup', 4);
  let meetupWinner = '';
  {
    await raceOnce([
      completeMeetup(x.runtime, meetup.owner, meetup.s.tenantId, meetup.s.instanceId, meetup.order.order_id, {amount_minor: meetup.order.terms.total_minor, completed_on: date}, randomUUID(), meetup.order.version),
      cancelSellerCheckoutOrder(x.runtime, meetup.owner, meetup.s.tenantId, meetup.s.instanceId, meetup.order.order_id, randomUUID(), meetup.order.version),
    ]);
    const row = await extras(meetup.order.order_id);
    const seen = await counts(meetup.order.order_id);
    if (seen.payments === 1 && seen.handovers === 1 && row.lifecycle === 'open') meetupWinner = 'completed';
    else if (seen.payments === 0 && seen.handovers === 0 && row.reason === 'seller_cancelled') meetupWinner = 'cancelled';
  }
  assert.equal(meetupWinner === 'completed' || meetupWinner === 'cancelled', true);
  const expiring = await placeOffline('bank_transfer', 4);
  const historical = await backdateBank(expiring.order.order_id);
  let expiryWinner = '';
  {
    await raceOnce([
      confirmOfflinePayment(x.runtime, expiring.owner, expiring.s.tenantId, expiring.s.instanceId, historical, {amount_minor: expiring.order.terms.total_minor, received_on: date}, randomUUID(), '1'),
      endOfflinePaymentWindow(x.runtime, historical),
    ]);
    const row = await extras(historical);
    const payments = (await counts(historical)).payments;
    if (payments === 1 && row.lifecycle === 'open' && row.reason === null) expiryWinner = 'paid';
    else if (payments === 0 && row.reason === 'payment_not_completed') expiryWinner = 'expired';
  }
  assert.equal(expiryWinner === 'paid' || expiryWinner === 'expired', true);
});

test('seller payment and handover receipts retain references without payment reference or bank data', async () => {
  const {s, order, owner} = await placeOffline('bank_transfer', 8);
  const date = await today();
  const reference = `ref-${randomBytes(12).toString('hex')}`;
  const document = (await x.h.pool.query('SELECT document FROM commerce_offline_payment_settings WHERE instance_id=$1 AND version=1', [s.instanceId])).rows[0].document;
  const secrets = [reference, document.bank_transfer.account_number];
  const logs: unknown[][] = [];
  const original = {log: console.log, info: console.info, warn: console.warn, error: console.error};
  const checkReceipt = async (operation: string, id: string) => {
    const receipts = (await x.h.pool.query('SELECT response FROM scoped_command_receipts WHERE operation=$1 AND target_id=$2', [operation, id])).rows;
    assert.deepEqual(receipts, [{response: {id}}]);
    const events = (await x.h.pool.query('SELECT detail FROM commerce_control_events WHERE instance_id=$1', [s.instanceId])).rows;
    const journal = (await x.h.pool.query('SELECT * FROM scoped_transition_journal')).rows;
    const serialized = JSON.stringify({receipts, events, journal, logs});
    for (const secret of secrets) assert.equal(serialized.includes(secret), false);
  };
  for (const level of Object.keys(original) as (keyof typeof original)[]) console[level] = (...args: unknown[]) => { logs.push(args); };
  try {
    const paid = await confirmOfflinePayment(x.runtime, owner, s.tenantId, s.instanceId, order.order_id, {amount_minor: order.terms.total_minor, received_on: date, reference}, randomUUID(), order.version);
    assert.equal(paid.payment_detail?.offline_payments[0].reference, reference);
    await checkReceipt('commerce.checkout_order.confirm_offline_payment', order.order_id);
    await recordMeetupHandover(x.runtime, owner, s.tenantId, s.instanceId, order.order_id, {completed_on: date}, randomUUID(), paid.version);
    await checkReceipt('commerce.checkout_order.record_meetup_handover', order.order_id);
    const cash = await more(s, 'cash_on_meetup');
    await completeMeetup(x.runtime, owner, s.tenantId, s.instanceId, cash.order_id, {amount_minor: cash.terms.total_minor, completed_on: date}, randomUUID(), cash.version);
    await checkReceipt('commerce.checkout_order.complete_meetup', cash.order_id);
  } finally {
    Object.assign(console, original);
  }
});

async function raceOnce(operations: Promise<unknown>[]) {
  const results = await Promise.allSettled(operations);
  assert.ok(results.some(result => result.status === 'fulfilled'), 'one operation must complete on the first race');
  for (const result of results) {
    if (result.status === 'rejected') {
      assert.ok(result.reason instanceof Problem, String(result.reason));
      assert.ok(['order_cancelled', 'payment_already_applied', 'version_conflict'].includes(result.reason.code), result.reason.code);
    }
  }
  return results;
}

async function blockedBy(holder: number) {
  const deadline = performance.now() + 15000;
  while (performance.now() < deadline) {
    const seen = await x.h.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND $1=ANY(pg_blocking_pids(pid))", [holder]);
    if (seen.rowCount) return;
  }
  assert.fail('meetup completion never waited on the receipt table lock');
}
async function operator(s: Awaited<ReturnType<CheckoutHarness['store']>>, caps: string[]) {
  const member = await x.h.person(synthetic(3));
  const principal = await x.h.candidate(s.owner, member.id);
  await x.h.accept(member.session, s.tenantId, await x.h.invite(s.owner, s.tenantId, principal, 'operator'));
  await x.h.pool.query(`INSERT INTO tenant_module_permissions(tenant_id,principal_id,instance_id,capabilities,status,granted_by_principal_id)
    SELECT $1,$2,$3,$4,'active',principal_id FROM principals WHERE user_ref=$5`, [s.tenantId, principal, s.instanceId, ['store:read', ...caps], s.owner.user.user_id]);
  return {actor: await actorOf(member.session.cookie), principal};
}
async function placeOffline(method: 'bank_transfer' | 'cash_on_meetup', stock = 10): Promise<{s: Awaited<ReturnType<CheckoutHarness['store']>>; order: CheckoutOrderRow; owner: Awaited<ReturnType<typeof actorOf>>}> {
  const s = await x.store(stock);
  const release = (await x.h.pool.query<{version: string}>('SELECT version::text FROM module_instances WHERE instance_id=$1', [s.instanceId])).rows[0].version;
  const upgraded = await x.h.call('POST', `${s.root}/upgrade`, s.owner, {}, {'Idempotency-Key': randomUUID(), 'If-Match': `"${release}"`}, x.app);
  assert.equal(upgraded.status, 200, JSON.stringify(upgraded.data));
  const ports = offlinePorts();
  const ownerPrincipal = await x.tx(q => mapPersonPrincipal(q, s.owner.user.user_id));
  const document = {schema: 'freedom.offline-payment-settings/v1', bank_transfer: {bank_code: String(100 + randomInt(900)).padStart(3, '0'), bank_name: synthetic(2), branch_name: null, account_number: String(randomBytes(4).readUInt32BE()).padStart(10, '0').slice(0, 12), account_name: synthetic(2), deadline_days: 3, note: null}, cash_on_meetup: {deadline_days: 7}};
  await x.h.pool.query(`INSERT INTO commerce_offline_payment_settings(tenant_id,instance_id,version,document,document_sha256,created_by_principal_id)
    VALUES($1,$2,1,$3,$4,$5)`, [s.tenantId, s.instanceId, document, createHash('sha256').update(canonicalJSON(document)).digest('hex'), ownerPrincipal.principal_id]);
  const buyer = await x.h.person(synthetic(3));
  const principal = await x.tx(q => mapPersonPrincipal(q, buyer.id));
  const {freezeCheckout} = await import('../../modules/agent-commerce/checkout/index.js');
  const saved = await x.tx(q => freezeCheckout(q, s, {...x.input(s.product.sku, 1), idempotencyKey: randomUUID()}, ports));
  const order = await x.tx(q => placeCheckoutOrder(q, s, {checkoutId: saved.checkout_id, termsSha256: saved.terms_sha256, clientOrderId: randomUUID(), buyerPrincipalId: principal.principal_id, environment: 'sandbox', paymentMethod: method}, ports));
  return {s, order, owner: await actorOf(s.owner.cookie)};
}
async function more(s: Awaited<ReturnType<CheckoutHarness['store']>>, method: 'bank_transfer' | 'cash_on_meetup', methodRef: 'meetup' | 'home' = 'meetup') {
  const ports = offlinePorts(methodRef);
  const buyer = await x.tx(q => mapPersonPrincipal(q, s.owner.user.user_id));
  const saved = await x.tx(q => freezeCheckout(q, s, {...x.input(s.product.sku, 1), idempotencyKey: randomUUID()}, ports));
  return x.tx(q => placeCheckoutOrder(q, s, {checkoutId: saved.checkout_id, termsSha256: saved.terms_sha256, clientOrderId: randomUUID(), buyerPrincipalId: buyer.principal_id, environment: 'sandbox', paymentMethod: method}, ports));
}
async function placeCard(s: Awaited<ReturnType<CheckoutHarness['store']>>) {
  const ports: CheckoutPorts = {admission: {allowed: () => true}, shipping: offlinePorts().shipping, paymentMethods: {offlinePaymentRequiresMember: true, async resolve() { return {options: [{method: 'immediate_card', available: true, reason: null}], offline: null}; }, async onOfflineOrderPlaced() {}}};
  const saved = await x.tx(q => freezeCheckout(q, s, {...x.input(s.product.sku, 1), idempotencyKey: randomUUID()}, ports));
  return x.tx(q => placeCheckoutOrder(q, s, {checkoutId: saved.checkout_id, termsSha256: saved.terms_sha256, clientOrderId: randomUUID(), buyerPrincipalId: null, environment: 'sandbox'}, ports));
}
async function balances(itemId: string) {
  return (await x.h.pool.query<{stock: number; reserved: number}>('SELECT stock::int, reserved::int FROM commerce_items WHERE item_id=$1', [itemId])).rows[0];
}
async function receipts(operation: string, orderId: string) {
  return Number((await x.h.pool.query<{n: number}>('SELECT count(*)::int AS n FROM scoped_command_receipts WHERE operation=$1 AND target_id=$2', [operation, orderId])).rows[0].n);
}
async function extras(orderId: string) {
  const row = (await x.h.pool.query<{applications: number; exceptions: number; lifecycle: string; reason: string | null}>(`SELECT
    (SELECT count(*)::int FROM commerce_checkout_payment_applications WHERE order_id=$1) AS applications,
    (SELECT count(*)::int FROM commerce_exception_cases WHERE order_id=$1) AS exceptions,
    lifecycle_state AS lifecycle, cancel_reason AS reason FROM commerce_checkout_orders WHERE order_id=$1`, [orderId])).rows[0];
  return row;
}
async function shipAll(s: {storefront_shop_id: string}, orderId: string) {
  await x.tx(async q => {
    await lockStore(q, {storefront_shop_id: s.storefront_shop_id}, [], [orderId], false);
    const inventory = await checkoutInventory(q, orderId);
    for (const allocation of inventory.allocations) {
      const quantity = allocation.quantity - allocation.shipped_quantity - allocation.released_quantity;
      if (quantity > 0) await inventory.port.ship(allocation.item_id, quantity, randomUUID());
    }
  });
}
async function backdateBank(sourceOrderId: string, days = 8) {
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
async function placePublicBank() {
  const s = await x.store(6);
  const release = (await x.h.pool.query<{version: string}>('SELECT version::text FROM module_instances WHERE instance_id=$1', [s.instanceId])).rows[0].version;
  const upgraded = await x.h.call('POST', `${s.root}/upgrade`, s.owner, {}, {'Idempotency-Key': randomUUID(), 'If-Match': `"${release}"`}, x.app);
  assert.equal(upgraded.status, 200, JSON.stringify(upgraded.data));
  const ports = offlinePorts();
  const ownerPrincipal = await x.tx(q => mapPersonPrincipal(q, s.owner.user.user_id));
  const document = {schema: 'freedom.offline-payment-settings/v1', bank_transfer: {bank_code: String(100 + randomInt(900)).padStart(3, '0'), bank_name: synthetic(2), branch_name: null, account_number: String(randomBytes(4).readUInt32BE()).padStart(10, '0').slice(0, 12), account_name: synthetic(2), deadline_days: 3, note: null}, cash_on_meetup: {deadline_days: 7}};
  await x.h.pool.query(`INSERT INTO commerce_offline_payment_settings(tenant_id,instance_id,version,document,document_sha256,created_by_principal_id)
    VALUES($1,$2,1,$3,$4,$5)`, [s.tenantId, s.instanceId, document, createHash('sha256').update(canonicalJSON(document)).digest('hex'), ownerPrincipal.principal_id]);
  const opt: HostedCheckoutOptions = {origin: x.h.origin, environment: 'sandbox', settings: {checkoutEnabled: true, consoleEnabled: true, quarantine: false, providerProfiles: ['offline.bank_transfer.v1', 'offline.cash_on_meetup.v1']}, ...ports};
  const access = {network: `198.51.${randomInt(1, 200)}.${randomInt(1, 250)}`, sessionToken: s.owner.cookie.split('=')[1].split(';')[0]};
  const created = await createPublicCheckout(x.runtime, s.slug, {...x.input(s.product.sku, 1), contact: {name: synthetic(3), email: `p-${randomUUID()}@example.test`, phone: `09${String(randomInt(10000000, 99999999))}`}}, randomUUID(), access, opt);
  const opened = {...access, deviceToken: created.cookie.split(';')[0].split('=').slice(1).join('=')};
  const placed = await placePublicOrder(x.runtime, s.slug, created.value.checkout_ref, {terms_sha256: created.value.terms_sha256, client_order_id: randomUUID(), payment_method: 'bank_transfer'}, opened, opt);
  return {s, owner: await actorOf(s.owner.cookie), opt, access: opened, order: placed.value.order};
}
