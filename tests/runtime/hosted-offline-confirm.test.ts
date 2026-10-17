import assert from 'node:assert/strict';
import {createHash, randomBytes, randomInt, randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {after, before, beforeEach, test} from 'node:test';
import {SellerCheckoutOrderSchema} from '../../contracts/guild-launchpad/v1/hosted-seller-checkout.js';
import {CheckoutTermsSchema} from '../../contracts/guild-launchpad/v1/hosted-checkout.js';
import {authenticate} from '../../modules/identity-membership/service.js';
import {checkoutInventory} from '../../modules/agent-commerce/checkout/inventory.js';
import {placeCheckoutOrder, type CheckoutOrderRow} from '../../modules/agent-commerce/checkout/orders.js';
import {retryAllocation} from '../../modules/agent-commerce/checkout/payments.js';
import {readSellerCheckoutOrder} from '../../modules/agent-commerce/checkout/seller-orders.js';
import {canonicalJSON, type CheckoutPorts} from '../../modules/agent-commerce/checkout/terms.js';
import {completeMeetup, confirmOfflinePayment, recordMeetupHandover} from '../../modules/agent-commerce/payments/offline/confirm.js';
import {createPaymentMethodsPort} from '../../modules/agent-commerce/payments/offline/methods.js';
import {mapPersonPrincipal} from '../../packages/resource-scopes/index.js';
import {Problem} from '../../packages/shared/problem.js';
import {checkoutHarness, type CheckoutHarness} from './hosted-checkout-harness.js';

const syllables = ['青', '禾', '川', '石', '林', '安', '白', '南'];
const synthetic = (n: number) => Array.from({length: n}, () => syllables[randomInt(syllables.length)]).join('');
let x: CheckoutHarness;
before(async () => { x = await checkoutHarness('fp_offline_confirm'); });
beforeEach(async () => x.reset());
after(async () => x?.stop());

const offlinePorts = (): CheckoutPorts => ({
  admission: {allowed: () => true},
  shipping: {async quote(_q, _s, input) {
    return {groups: [...new Set(input.lines.map(line => line.supplier_shop_id))].sort().map(shop => ({group_ref: shop, supplier_shop_id: shop, method_ref: 'meetup', amount_minor: 0}))};
  }},
  paymentMethods: createPaymentMethodsPort({environment: 'sandbox', profiles: ['offline.bank_transfer.v1', 'offline.cash_on_meetup.v1']}),
});

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

test('seeded bank checkout terms do not list cash_on_meetup without a meetup deadline', () => {
  for (const file of ['tests/integration/tenant-rls-restore-drill.test.ts', 'tests/runtime/tenant-rls-retarget.test.ts']) {
    const source = readFileSync(file, 'utf8');
    const start = source.indexOf('async function seedOfflineBankFixture');
    const body = source.slice(start, source.indexOf('\n}', start));
    assert.match(body, /\["immediate_card","bank_transfer"\]/);
    assert.doesNotMatch(body, /cash_on_meetup"\]/);
    assert.match(body, /meetup_deadline_days":null/);
  }
  const base = {profile: 'freedom.checkout-terms/v1' as const, publication_revision: '1', publication_id: randomUUID(), currency: 'TWD' as const,
    bindings: [{selection_id: randomUUID(), item_id: randomUUID(), version: '1', sku: 'P0001', quantity: 1, supplier_shop_id: randomUUID(), supplier_instance_id: randomUUID(), offer_id: null, offer_sha256: null, acceptance_id: null, listing_sha256: null, unit_price_minor: 100}],
    items: [{sku: 'P0001', title: '合成商品', quantity: 1, unit_price_minor: 100, line_total_minor: 100, offer_sha256: null}],
    merchandise_total_minor: 100, discount_total_minor: 0 as const, discounts: [], shipping: {groups: [{group_ref: 'g', supplier_shop_id: randomUUID(), method_ref: 'meetup', amount_minor: 0}]},
    shipping_total_minor: 0, tax_state: 'not_assessed' as const, total_minor: 100, consents: [], contact_sha256: 'ab'.repeat(32)};
  assert.equal(CheckoutTermsSchema.safeParse({...base, payment_methods: ['immediate_card', 'bank_transfer', 'cash_on_meetup'], offline_payment: {settings_version: '1', bank_transfer_deadline_days: 3, meetup_deadline_days: null}}).success, false);
  assert.equal(CheckoutTermsSchema.safeParse({...base, payment_methods: ['immediate_card', 'bank_transfer'], offline_payment: {settings_version: '1', bank_transfer_deadline_days: 3, meetup_deadline_days: null}}).success, true);
});

async function blockedBy(holder: number) {
  const deadline = performance.now() + 15000;
  while (performance.now() < deadline) {
    const seen = await x.h.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND $1=ANY(pg_blocking_pids(pid))", [holder]);
    if (seen.rowCount) return;
  }
  assert.fail('meetup completion never waited on the receipt table lock');
}
async function operator(s: {tenantId: string; instanceId: string; owner: {user: {user_id: string}; cookie: string}}, caps: string[]) {
  const member = await x.h.person(synthetic(3));
  const principal = await x.h.candidate(s.owner, member.id);
  await x.h.accept(member.session, s.tenantId, await x.h.invite(s.owner, s.tenantId, principal, 'operator'));
  await x.h.pool.query(`INSERT INTO tenant_module_permissions(tenant_id,principal_id,instance_id,capabilities,status,granted_by_principal_id)
    SELECT $1,$2,$3,$4,'active',principal_id FROM principals WHERE user_ref=$5`, [s.tenantId, principal, s.instanceId, ['store:read', ...caps], s.owner.user.user_id]);
  return {actor: await actorOf(member.session.cookie), principal};
}
async function placeOffline(method: 'bank_transfer' | 'cash_on_meetup'): Promise<{s: Awaited<ReturnType<CheckoutHarness['store']>>; order: CheckoutOrderRow; owner: Awaited<ReturnType<typeof actorOf>>}> {
  const s = await x.store(10);
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
