import assert from 'node:assert/strict';
import {syntheticShippingPort} from '../../scripts/synthetic-shipping-quote.js';
import {createHash, randomBytes, randomInt, randomUUID} from 'node:crypto';
import {after, before, beforeEach, test} from 'node:test';
import {Problem} from '../../packages/shared/problem.js';
import {mapPersonPrincipal} from '../../packages/resource-scopes/index.js';
import {checkoutInventory} from '../../modules/agent-commerce/checkout/inventory.js';
import {cancelPublicOrder, createPublicCheckout, placePublicOrder, publicPurchaseState, queryPublicPayment, quotePublicCart, readPublicOrder, resumePublicPayment, type BrowserAccess, type HostedCheckoutOptions} from '../../modules/agent-commerce/checkout/public-commands.js';
import {profile} from '../../modules/agent-commerce/hosted/store.js';
import {bindStore} from '../../modules/agent-commerce/checkout/authority.js';
import {freezeCheckout, hashJSON, canonicalJSON, type CheckoutPorts} from '../../modules/agent-commerce/checkout/terms.js';
import {createPaymentMethodsPort} from '../../modules/agent-commerce/payments/offline/methods.js';
import {confirmOfflinePayment} from '../../modules/agent-commerce/payments/offline/confirm.js';
import {createStoreAdmissionPort} from '../../modules/agent-commerce/operations/admissions.js';
import {authenticate} from '../../modules/identity-membership/service.js';
import {checkoutHarness, type CheckoutHarness} from './hosted-checkout-harness.js';

const syllables = ['青', '禾', '川', '石', '林', '安', '白', '南'];
const synthetic = (n: number) => Array.from({length: n}, () => syllables[randomInt(syllables.length)]).join('');
let x: CheckoutHarness;
let net = 0;
before(async () => { x = await checkoutHarness('fp_offline_checkout'); });
beforeEach(async () => x.reset());
after(async () => x?.stop());
const problem = (status: number, code: string) => (error: unknown) => error instanceof Problem && error.status === status && error.code === code;
const network = () => `198.51.${net++ % 250}.${randomInt(1, 250)}`;
const sessionOf = (cookie: string) => cookie.split('=')[1].split(';')[0];
const deviceOf = (cookie: string) => cookie.split(';')[0].split('=').slice(1).join('=');
const ship = (method: 'meetup' | 'home'): CheckoutPorts['shipping'] => syntheticShippingPort({method_ref: method});
function settingsDocument(bank = true, meetup = true, account = String(randomBytes(4).readUInt32BE()).padStart(10, '0').slice(0, 12)) {
  return {schema: 'freedom.offline-payment-settings/v1' as const, account, document: {
    schema: 'freedom.offline-payment-settings/v1',
    bank_transfer: bank ? {bank_code: String(100 + randomInt(900)).padStart(3, '0'), bank_name: synthetic(2), branch_name: null, account_number: account, account_name: synthetic(2), deadline_days: 3, note: null} : null,
    cash_on_meetup: meetup ? {deadline_days: 7} : null,
  }};
}
async function saveSettings(s: {tenantId: string; instanceId: string; owner: {user: {user_id: string}}}, bank = true, meetup = true, account?: string) {
  const body = settingsDocument(bank, meetup, account);
  const principal = await x.tx(q => mapPersonPrincipal(q, s.owner.user.user_id));
  const version = Number((await x.h.pool.query<{n: number}>('SELECT coalesce(max(version),0)::int AS n FROM commerce_offline_payment_settings WHERE instance_id=$1', [s.instanceId])).rows[0].n) + 1;
  await x.h.pool.query(`INSERT INTO commerce_offline_payment_settings(tenant_id,instance_id,version,document,document_sha256,created_by_principal_id)
    VALUES($1,$2,$3,$4,$5,$6)`, [s.tenantId, s.instanceId, version, body.document, createHash('sha256').update(canonicalJSON(body.document)).digest('hex'), principal.principal_id]);
  return body;
}
async function upgrade(s: Awaited<ReturnType<CheckoutHarness['store']>>) {
  const release = (await x.h.pool.query<{version: string}>('SELECT version::text FROM module_instances WHERE instance_id=$1', [s.instanceId])).rows[0].version;
  const upgraded = await x.h.call('POST', `${s.root}/upgrade`, s.owner, {}, {'Idempotency-Key': randomUUID(), 'If-Match': `"${release}"`}, x.app);
  assert.equal(upgraded.status, 200, JSON.stringify(upgraded.data));
}
function options(ports: CheckoutPorts, profiles: string[] = ['offline.bank_transfer.v1', 'offline.cash_on_meetup.v1']): HostedCheckoutOptions {
  return {origin: x.h.origin, environment: 'sandbox', settings: {checkoutEnabled: true, consoleEnabled: true, quarantine: false, providerProfiles: profiles}, ...ports};
}
const buyer = (email: string) => ({name: synthetic(3), email, phone: `09${String(randomInt(10000000, 99999999))}`});
async function openCheckout(s: Awaited<ReturnType<CheckoutHarness['store']>>, opt: HostedCheckoutOptions, access: BrowserAccess, email = `b-${randomUUID()}@example.test`, quantity = 1) {
  const created = await createPublicCheckout(x.runtime, s.slug, {...x.input(s.product.sku, quantity), contact: buyer(email)}, randomUUID(), access, opt);
  return {created, access: {...access, deviceToken: deviceOf(created.cookie)}};
}

test('quotes show every offline reason for profiles, settings, shipping and membership', async () => {
  const s = await x.store();
  await saveSettings(s);
  const profiles = ['offline.bank_transfer.v1', 'offline.cash_on_meetup.v1', 'ecpay.aio.credit.v1'];
  const port = createPaymentMethodsPort({environment: 'sandbox', profiles});
  const store = await x.tx(async q => { await bindStore(q, s.tenantId); return profile(q, s.tenantId, s.instanceId); });
  assert.ok(store);
  const resolved = async (total: number, refs: string[] | null) => x.tx(async q => {
    await bindStore(q, s.tenantId);
    return port.resolve(q, store, {currency: 'TWD', totalMinor: total, amountsMinor: [total], shippingMethodRefs: refs});
  });
  const meetup = await resolved(100, ['meetup']);
  assert.deepEqual(meetup.options.map(option => [option.method, option.available, option.reason]), [
    ['bank_transfer', true, null], ['cash_on_meetup', true, null],
  ]);
  assert.deepEqual(meetup.offline, {settings_version: '1', bank_transfer_deadline_days: 3, meetup_deadline_days: 7});
  assert.equal((await resolved(150, ['meetup'])).options.every(option => option.reason === 'payment_profile_unavailable'), true);
  assert.equal((await resolved(100, ['home'])).options.find(option => option.method === 'cash_on_meetup')?.reason, 'meetup_required');
  assert.equal((await resolved(100, ['meetup', 'home'])).options.find(option => option.method === 'cash_on_meetup')?.reason, 'meetup_required');
  assert.equal((await resolved(100, null)).options.find(option => option.method === 'cash_on_meetup')?.reason, 'meetup_required');
  assert.equal((await x.tx(async q => {
    await bindStore(q, s.tenantId);
    return createPaymentMethodsPort({environment: 'sandbox', profiles: ['offline.bank_transfer.v1']}).resolve(q, store, {currency: 'TWD', totalMinor: 100, amountsMinor: [100], shippingMethodRefs: ['meetup']});
  })).options.some(option => option.method === 'cash_on_meetup'), false);
  const none = await x.tx(async q => {
    await bindStore(q, s.tenantId);
    return createPaymentMethodsPort({environment: 'sandbox', profiles: []}).resolve(q, store, {currency: 'TWD', totalMinor: 100, amountsMinor: [100], shippingMethodRefs: ['meetup']});
  });
  assert.deepEqual(none.options, []);
  const guest = await quotePublicCart(x.runtime, s.slug, {publication_revision: '1', lines: [{sku: s.product.sku, quantity: 1}], delivery: {method: 'meetup'}}, {network: network()}, options({admission: {allowed: () => true}, shipping: ship('meetup'), paymentMethods: port}));
  assert.equal(guest.payment_options.find(option => option.method === 'bank_transfer')?.reason, 'member_required');
  assert.equal(guest.payment_options.find(option => option.method === 'cash_on_meetup')?.reason, 'member_required');
  assert.equal(JSON.stringify(guest).includes(String((await x.h.pool.query(`SELECT document->'bank_transfer'->>'account_number' AS n FROM commerce_offline_payment_settings WHERE instance_id=$1`, [s.instanceId])).rows[0].n)), false);
  const member = await quotePublicCart(x.runtime, s.slug, {publication_revision: '1', lines: [{sku: s.product.sku, quantity: 1}]}, {network: network(), sessionToken: sessionOf(s.owner.cookie)}, options({admission: {allowed: () => true}, shipping: ship('meetup'), paymentMethods: {...port, offlinePaymentRequiresMember: false}}));
  assert.equal(member.payment_options.find(option => option.method === 'cash_on_meetup')?.reason, 'meetup_required');
  const home = await quotePublicCart(x.runtime, s.slug, {publication_revision: '1', lines: [{sku: s.product.sku, quantity: 1}], delivery: {method: 'home'}}, {network: network(), sessionToken: sessionOf(s.owner.cookie)}, options({admission: {allowed: () => true}, shipping: ship('home'), paymentMethods: port}));
  assert.equal(home.payment_options.find(option => option.method === 'bank_transfer')?.available, true);
  assert.equal(home.payment_options.find(option => option.method === 'cash_on_meetup')?.reason, 'meetup_required');
});

test('first-time members get offline quotes without writes, while disabled mapped principals remain unavailable', async () => {
  const s = await x.store();
  await saveSettings(s);
  const profiles = ['offline.bank_transfer.v1', 'offline.cash_on_meetup.v1'];
  const opt = options({admission: {allowed: () => true}, shipping: ship('meetup'), paymentMethods: createPaymentMethodsPort({environment: 'sandbox', profiles})});
  const newcomer = await x.h.person(synthetic(3));
  assert.equal((await x.h.pool.query('SELECT 1 FROM principals WHERE user_ref=$1', [newcomer.id])).rowCount, 0);
  const access = {network: network(), sessionToken: sessionOf(newcomer.session.cookie)};
  const input = {publication_revision: '1', lines: [{sku: s.product.sku, quantity: 1}], delivery: {method: 'meetup'}};
  const first = await quotePublicCart(x.runtime, s.slug, input, access, opt);
  assert.equal(first.payment_options.every(option => option.available), true);
  assert.equal(first.payment_options.length, 2);
  assert.equal((await x.h.pool.query('SELECT 1 FROM principals WHERE user_ref=$1', [newcomer.id])).rowCount, 0);
  const principal = await x.tx(q => mapPersonPrincipal(q, newcomer.id));
  await x.h.pool.query("UPDATE principals SET status='disabled' WHERE principal_id=$1", [principal.principal_id]);
  const disabled = await quotePublicCart(x.runtime, s.slug, input, access, opt);
  assert.equal(disabled.payment_options.every(option => !option.available && option.reason === 'member_required'), true);
});

test('frozen terms keep the offline block, change with settings, and never carry account data', async () => {
  const s = await x.store();
  const saved = await saveSettings(s);
  const port = createPaymentMethodsPort({environment: 'sandbox', profiles: ['offline.bank_transfer.v1', 'offline.cash_on_meetup.v1']});
  const opt = options({admission: {allowed: () => true}, shipping: ship('meetup'), paymentMethods: port});
  const access = {network: network(), sessionToken: sessionOf(s.owner.cookie)};
  const opened = await openCheckout(s, opt, access);
  assert.deepEqual(opened.created.value.terms.payment_methods, ['bank_transfer', 'cash_on_meetup']);
  assert.deepEqual(opened.created.value.terms.offline_payment, {settings_version: '1', bank_transfer_deadline_days: 3, meetup_deadline_days: 7});
  assert.equal(JSON.stringify(opened.created.value.terms).includes(saved.account), false);
  await saveSettings(s, true, true, String(randomBytes(4).readUInt32BE()).padStart(12, '7'));
  await assert.rejects(placePublicOrder(x.runtime, s.slug, opened.created.value.checkout_ref, {terms_sha256: opened.created.value.terms_sha256, client_order_id: randomUUID(), payment_method: 'bank_transfer'}, opened.access, opt), problem(409, 'terms_changed'));
  const cardOnly: CheckoutPorts = {admission: {allowed: () => true}, shipping: ship('meetup'), payment: {assertTermsAvailable() { throw new Problem(409, 'payment_profile_unavailable', '信用卡目前無法使用。'); }, async createOrderAttempt() { assert.fail('unavailable card must not create an attempt'); }, async issueHandoff() { assert.fail('unavailable card must not issue a handoff'); }, async onOrdersCancelled() { assert.fail('quote must not cancel orders'); }, async summarize() { assert.fail('quote must not summarize payments'); }},
    paymentMethods: {offlinePaymentRequiresMember: true, async resolve() { return {options: [{method: 'immediate_card', available: false, reason: 'payment_profile_unavailable'}], offline: null}; }, async onOfflineOrderPlaced() {}}};
  await assert.rejects(x.tx(q => freezeCheckout(q, s, {...x.input(s.product.sku, 1), idempotencyKey: randomUUID()}, cardOnly)), problem(409, 'payment_profile_unavailable'));
  const bare = await x.store();
  await assert.rejects(x.tx(q => freezeCheckout(q, bare, {...x.input(bare.product.sku, 1), idempotencyKey: randomUUID()}, opt)), problem(409, 'payment_method_unavailable'));
});

test('an offline-only store is admitted without an ECPay account', async () => {
  const s = await x.store();
  await upgrade(s);
  const admission = createStoreAdmissionPort('sandbox', ['offline.bank_transfer.v1', 'offline.cash_on_meetup.v1']);
  const community = (await x.h.pool.query<{community_id: string}>('SELECT community_id FROM tenants WHERE tenant_id=$1', [s.tenantId])).rows[0].community_id;
  const admin = randomUUID();
  await x.h.pool.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)', [admin, community, `adm-${randomUUID()}@example.test`, synthetic(2)]);
  await x.h.pool.query(`INSERT INTO commerce_store_admissions(tenant_id,instance_id,environment,admitted_by,reason) VALUES($1,$2,'sandbox',$3,$4)`, [s.tenantId, s.instanceId, admin, '合成准入']);
  assert.equal(await x.tx(async q => admission.allowed(q, s)), false);
  await saveSettings(s);
  assert.equal(await x.tx(async q => admission.allowed(q, s)), true);
  assert.equal((await x.h.pool.query('SELECT count(*)::int AS n FROM commerce_provider_account_services WHERE instance_id=$1', [s.instanceId])).rows[0].n, 0);
  const opt = options({admission, shipping: ship('meetup'), paymentMethods: createPaymentMethodsPort({environment: 'sandbox', profiles: ['offline.bank_transfer.v1', 'offline.cash_on_meetup.v1']})});
  assert.deepEqual(await publicPurchaseState(x.runtime, s.slug, opt, s.product.sku), {open: true, product: 'available'});
});

test('placement enforces membership, the frozen method, expiry, holds, due work and intent identity', async () => {
  const s = await x.store(20);
  const saved = await saveSettings(s);
  const port = createPaymentMethodsPort({environment: 'sandbox', profiles: ['offline.bank_transfer.v1', 'offline.cash_on_meetup.v1']});
  const opt = options({admission: {allowed: () => true}, shipping: ship('meetup'), paymentMethods: port});
  const guest = await openCheckout(s, opt, {network: network()});
  const before = (await x.h.pool.query('SELECT count(*)::int AS n FROM commerce_checkout_orders')).rows[0].n;
  await assert.rejects(placePublicOrder(x.runtime, s.slug, guest.created.value.checkout_ref, {terms_sha256: guest.created.value.terms_sha256, client_order_id: randomUUID(), payment_method: 'bank_transfer'}, guest.access, opt), problem(403, 'offline_payment_requires_member'));
  assert.equal((await x.h.pool.query('SELECT count(*)::int AS n FROM commerce_checkout_orders')).rows[0].n, before);
  const guestPort = {...port, offlinePaymentRequiresMember: false as const};
  const opted = options({admission: {allowed: () => true}, shipping: ship('meetup'), paymentMethods: guestPort});
  const loose = await openCheckout(s, opted, {network: network()});
  const looseOrder = await placePublicOrder(x.runtime, s.slug, loose.created.value.checkout_ref, {terms_sha256: loose.created.value.terms_sha256, client_order_id: randomUUID(), payment_method: 'cash_on_meetup'}, loose.access, opted);
  assert.equal(looseOrder.value.order.payment_method, 'cash_on_meetup');
  const cashDeadline = (await x.h.pool.query(`SELECT extract(epoch FROM o.expires_at-o.created_at)/3600 AS hours,
    d.due_at=o.expires_at+interval '72 hours' AS grace_matches,
    h.expires_at=o.expires_at AS hold_matches
    FROM commerce_orders o JOIN commerce_due_work d ON d.target_id=o.order_id AND d.kind='offline_payment_window_end'
    JOIN commerce_inventory_reservations h ON h.order_id=o.order_id WHERE o.order_id=$1`, [looseOrder.value.order.order_ref])).rows[0];
  assert.equal(Number(cashDeadline.hours), 168);
  assert.equal(cashDeadline.grace_matches, true);
  assert.equal(cashDeadline.hold_matches, true);
  const access = {network: network(), sessionToken: sessionOf(s.owner.cookie)};
  const opened = await openCheckout(s, opt, access);
  await assert.rejects(placePublicOrder(x.runtime, s.slug, opened.created.value.checkout_ref, {terms_sha256: opened.created.value.terms_sha256, client_order_id: randomUUID(), payment_method: 'immediate_card'}, opened.access, opt), problem(409, 'payment_method_unavailable'));
  const client = randomUUID();
  const placed = await placePublicOrder(x.runtime, s.slug, opened.created.value.checkout_ref, {terms_sha256: opened.created.value.terms_sha256, client_order_id: client, payment_method: 'bank_transfer'}, opened.access, opt);
  const order = placed.value.order;
  assert.equal(order.payment_method, 'bank_transfer');
  assert.equal(order.payment_state, 'unpaid');
  assert.equal(order.latest_payment_attempt, null);
  assert.equal(order.can_resume_payment, false);
  assert.equal(order.offline_instructions?.account_number, saved.account);
  assert.equal(order.offline_instructions?.amount_minor, order.total_minor);
  const row = (await x.h.pool.query<{hours: number; due: string; holds: number; attempts: number; hash: string}>(`SELECT extract(epoch FROM o.expires_at-o.created_at)/3600 AS hours,
    (SELECT kind||':'||to_char(due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM commerce_due_work WHERE target_id=o.order_id) AS due,
    (SELECT count(*)::int FROM commerce_inventory_reservations h WHERE h.order_id=o.order_id AND h.state='held' AND h.quantity=1 AND h.expires_at=o.expires_at) AS holds,
    (SELECT count(*)::int FROM commerce_payment_attempts a WHERE a.order_id=o.order_id) AS attempts, o.request_sha256 AS hash
    FROM commerce_orders o WHERE o.order_id=$1`, [order.order_ref])).rows[0];
  assert.equal(Number(row.hours), 72);
  assert.equal(row.holds, 1);
  assert.equal(row.attempts, 0);
  assert.equal(row.hash, hashJSON({checkoutId: opened.created.value.checkout_ref, termsSha256: opened.created.value.terms_sha256, clientOrderId: client, environment: 'sandbox', paymentMethod: 'bank_transfer'}));
  assert.match(row.due, /^offline_payment_window_end:/);
  const replay = await placePublicOrder(x.runtime, s.slug, opened.created.value.checkout_ref, {terms_sha256: opened.created.value.terms_sha256, client_order_id: client, payment_method: 'bank_transfer'}, opened.access, opt);
  assert.equal(replay.created, false);
  assert.equal(replay.value.order.order_ref, order.order_ref);
  await assert.rejects(placePublicOrder(x.runtime, s.slug, opened.created.value.checkout_ref, {terms_sha256: opened.created.value.terms_sha256, client_order_id: client, payment_method: 'cash_on_meetup'}, opened.access, opt), problem(409, 'order_intent_conflict'));
  await assert.rejects(placePublicOrder(x.runtime, s.slug, opened.created.value.checkout_ref, {terms_sha256: opened.created.value.terms_sha256, client_order_id: randomUUID(), payment_method: 'bank_transfer'}, opened.access, opt), problem(409, 'unresolved_order'));
  const nextAccount = String(randomBytes(4).readUInt32BE()).padStart(12, '8');
  await saveSettings(s, true, true, nextAccount);
  const read = await readPublicOrder(x.runtime, s.slug, order.order_ref, opened.access, opt);
  assert.equal(read.offline_instructions?.account_number, saved.account);
  assert.notEqual(read.offline_instructions?.account_number, nextAccount);
  await upgrade(s);
  const owner = await authenticate(x.runtime, sessionOf(s.owner.cookie));
  const confirmed = await confirmOfflinePayment(x.runtime, owner, s.tenantId, s.instanceId, order.order_ref, {amount_minor: order.total_minor, received_on: (await x.h.pool.query<{d: string}>("SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Taipei','YYYY-MM-DD') AS d")).rows[0].d}, randomUUID(), '1');
  assert.equal(confirmed.payment_state, 'confirmed');
  const afterPay = await readPublicOrder(x.runtime, s.slug, order.order_ref, opened.access, opt);
  assert.equal(afterPay.payment_state, 'confirmed');
  assert.equal(afterPay.offline_instructions, null);
  assert.equal(afterPay.can_resume_payment, false);
  const stranger = await x.h.person(synthetic(3));
  await assert.rejects(readPublicOrder(x.runtime, s.slug, order.order_ref, {network: network(), sessionToken: sessionOf(stranger.session.cookie)}, opt), problem(404, 'checkout_order_not_found'));
  const other = await x.store();
  await assert.rejects(readPublicOrder(x.runtime, other.slug, order.order_ref, opened.access, opt), problem(404, 'checkout_order_not_found'));
  await assert.rejects(resumePublicPayment(x.runtime, s.slug, order.order_ref, opened.access, opt), problem(409, 'payment_handoff_unavailable'));
  const queried = await queryPublicPayment(x.runtime, s.slug, order.order_ref, opened.access, opt);
  assert.equal(queried.order_ref, order.order_ref);
  assert.equal(queried.latest_payment_attempt, null);
});

test('open-order limits admit one racer at each boundary', async () => {
  const s = await x.store(80);
  await saveSettings(s);
  const port = createPaymentMethodsPort({environment: 'sandbox', profiles: ['offline.bank_transfer.v1']});
  const shipping = ship('home');
  const opt = options({admission: {allowed: () => true}, shipping, paymentMethods: port}, ['offline.bank_transfer.v1']);
  const session = sessionOf(s.owner.cookie);
  const shared = 'same-device@example.test';
  const cardOpt: HostedCheckoutOptions = {...opt, paymentMethods: {offlinePaymentRequiresMember: true, async resolve() { return {options: [{method: 'immediate_card', available: true, reason: null}], offline: null}; }, async onOfflineOrderPlaced() {}}};
  let device: string | undefined;
  const cardPlace = async () => {
    const opened = await openCheckout(s, cardOpt, {network: network(), deviceToken: device}, shared);
    device = deviceOf(opened.created.cookie);
    return placePublicOrder(x.runtime, s.slug, opened.created.value.checkout_ref, {terms_sha256: opened.created.value.terms_sha256, client_order_id: randomUUID()}, opened.access, cardOpt);
  };
  await cardPlace(); await cardPlace();
  const leftCard = cardPlace(), rightCard = cardPlace();
  const cards = await Promise.allSettled([leftCard, rightCard]);
  assert.equal(cards.filter(item => item.status === 'fulfilled').length, 1);
  const cardLost = cards.find(item => item.status === 'rejected') as PromiseRejectedResult;
  assert.equal(cardLost.reason instanceof Problem && cardLost.reason.status === 429 && cardLost.reason.code === 'too_many_open_orders' && (cardLost.reason.retryAfterSeconds ?? 0) > 0, true);
  const memberPlace = async (email: string) => {
    const opened = await openCheckout(s, opt, {network: network(), sessionToken: session}, email);
    return placePublicOrder(x.runtime, s.slug, opened.created.value.checkout_ref, {terms_sha256: opened.created.value.terms_sha256, client_order_id: randomUUID(), payment_method: 'bank_transfer'}, opened.access, opt);
  };
  await memberPlace(`m1-${randomUUID()}@example.test`);
  await memberPlace(`m2-${randomUUID()}@example.test`);
  const held = await memberPlace(`m3-${randomUUID()}@example.test`);
  await assert.rejects(memberPlace(`m4-${randomUUID()}@example.test`), (error: unknown) => error instanceof Problem && error.status === 429 && error.code === 'too_many_open_orders' && (error.retryAfterSeconds ?? 0) > 0);
  const source = held.value.order.order_ref;
  const checkoutId = (await x.h.pool.query<{checkout_id: string}>('SELECT checkout_id FROM commerce_checkout_orders WHERE order_id=$1', [source])).rows[0].checkout_id;
  const q = await x.h.pool.connect();
  try {
    await q.query('BEGIN');
    for (let i = 0; i < 46; i++) {
      const id = randomUUID(), client = randomUUID();
      const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
      let n = i + 10, suffix = '';
      for (let k = 0; k < 6; k++) { suffix = alphabet[n % 32] + suffix; n = Math.floor(n / 32); }
      await q.query(`INSERT INTO commerce_orders(order_id,public_shop_id,external_id,request_sha256,currency,total_minor,created_at,expires_at,order_profile,client_order_id)
        SELECT $2::uuid,public_shop_id,'chk:'||$3::text||':'||($4::uuid)::text,request_sha256,currency,total_minor,t,t+interval '72 hours','hosted_checkout',$4::uuid
        FROM commerce_orders CROSS JOIN (SELECT date_trunc('milliseconds',clock_timestamp()) t) n WHERE order_id=$1::uuid`, [source, id, checkoutId, client]);
      await q.query(`INSERT INTO commerce_checkout_orders(order_id,tenant_id,instance_id,checkout_id,customer_id,contact_id,display_number,terms,terms_sha256,environment,payment_method)
        SELECT $1::uuid,c.tenant_id,c.instance_id,c.checkout_id,c.customer_id,c.current_contact_id,to_char(o.created_at AT TIME ZONE 'Asia/Taipei','YYMMDD')||'-'||$3,c.terms,c.terms_sha256,'sandbox','bank_transfer'
        FROM commerce_checkouts c JOIN commerce_orders o ON o.order_id=$1::uuid WHERE c.checkout_id=$2::uuid`, [id, checkoutId, suffix]);
      await q.query(`INSERT INTO commerce_order_lines(order_id,selection_id,item_id,quantity,snapshot,order_profile,supplier_shop_id,hosted_offer_id,acceptance_id,listing_sha256)
        SELECT $2::uuid,selection_id,item_id,quantity,snapshot,order_profile,supplier_shop_id,hosted_offer_id,acceptance_id,listing_sha256 FROM commerce_order_lines WHERE order_id=$1::uuid`, [source, id]);
      await q.query(`INSERT INTO commerce_inventory_reservations(order_id,item_id,supplier_shop_id,quantity,state,created_at,expires_at)
        SELECT o.order_id,l.item_id,l.supplier_shop_id,l.quantity,'held',o.created_at,o.expires_at FROM commerce_orders o JOIN commerce_order_lines l USING(order_id) WHERE o.order_id=$1::uuid`, [id]);
      await q.query('UPDATE commerce_items SET reserved=reserved+l.quantity FROM commerce_order_lines l WHERE l.order_id=$1 AND commerce_items.item_id=l.item_id', [id]);
    }
    await q.query('COMMIT');
  } catch (error) { await q.query('ROLLBACK'); throw error; } finally { q.release(); }
  const raceMember = async () => {
    const person = await x.h.person(synthetic(3));
    const opened = await openCheckout(s, opt, {network: network(), sessionToken: sessionOf(person.session.cookie)}, `r-${randomUUID()}@example.test`);
    return placePublicOrder(x.runtime, s.slug, opened.created.value.checkout_ref, {terms_sha256: opened.created.value.terms_sha256, client_order_id: randomUUID(), payment_method: 'bank_transfer'}, opened.access, opt);
  };
  const raced = await Promise.allSettled([raceMember(), raceMember()]);
  assert.equal(raced.filter(item => item.status === 'fulfilled').length, 1);
  const lost = raced.find(item => item.status === 'rejected') as PromiseRejectedResult;
  assert.equal(lost.reason instanceof Problem && lost.reason.code === 'offline_order_limit', true);
  const boundary = await x.store(10);
  await saveSettings(boundary);
  const fresh = options({admission: {allowed: () => true}, shipping, paymentMethods: port}, ['offline.bank_transfer.v1']);
  const token = sessionOf(boundary.owner.cookie);
  const two = async (email: string) => {
    const opened = await openCheckout(boundary, fresh, {network: network(), sessionToken: token}, email);
    return {opened, run: () => placePublicOrder(x.runtime, boundary.slug, opened.created.value.checkout_ref, {terms_sha256: opened.created.value.terms_sha256, client_order_id: randomUUID(), payment_method: 'bank_transfer'}, opened.access, fresh)};
  };
  await (await two(`a-${randomUUID()}@example.test`)).run();
  await (await two(`b-${randomUUID()}@example.test`)).run();
  const left = await two(`c-${randomUUID()}@example.test`), right = await two(`d-${randomUUID()}@example.test`);
  const members = await Promise.allSettled([left.run(), right.run()]);
  assert.equal(members.filter(item => item.status === 'fulfilled').length, 1);
  const memberLost = members.find(item => item.status === 'rejected') as PromiseRejectedResult;
  assert.equal(memberLost.reason instanceof Problem && memberLost.reason.status === 429 && memberLost.reason.code === 'too_many_open_orders', true);
});

test('buyers cancel card and offline orders once, and quarantine blocks the command', async () => {
  const s = await x.store(10);
  await saveSettings(s);
  const port = createPaymentMethodsPort({environment: 'sandbox', profiles: ['offline.bank_transfer.v1', 'offline.cash_on_meetup.v1']});
  const opt = options({admission: {allowed: () => true}, shipping: ship('meetup'), paymentMethods: port});
  const access = {network: network(), sessionToken: sessionOf(s.owner.cookie)};
  const place = async (method: 'bank_transfer' | 'cash_on_meetup' | 'immediate_card') => {
    const use = method === 'immediate_card' ? {...opt, paymentMethods: {offlinePaymentRequiresMember: true, async resolve() { return {options: [{method: 'immediate_card' as const, available: true, reason: null}], offline: null}; }, async onOfflineOrderPlaced() {}}} : opt;
    const opened = await openCheckout(s, use, {network: network(), sessionToken: access.sessionToken});
    const placed = await placePublicOrder(x.runtime, s.slug, opened.created.value.checkout_ref, {terms_sha256: opened.created.value.terms_sha256, client_order_id: randomUUID(), ...(method === 'immediate_card' ? {} : {payment_method: method})}, opened.access, use);
    return {opened, order: placed.value.order};
  };
  const card = await place('immediate_card');
  const cancelled = await cancelPublicOrder(x.runtime, s.slug, card.order.order_ref, card.opened.access, opt);
  assert.equal(cancelled.lifecycle_state, 'cancelled');
  assert.equal(cancelled.cancel_reason, 'buyer_cancelled');
  const again = await cancelPublicOrder(x.runtime, s.slug, card.order.order_ref, card.opened.access, opt);
  assert.equal(again.lifecycle_state, 'cancelled');
  assert.equal(again.order_ref, cancelled.order_ref);
  assert.equal((await x.h.pool.query('SELECT version::text FROM commerce_checkout_orders WHERE order_id=$1', [card.order.order_ref])).rows[0].version, '2');
  const bank = await place('bank_transfer');
  await x.h.pool.query(`UPDATE commerce_checkout_orders SET lifecycle_state='closed', closed_at=clock_timestamp(), version=version+1 WHERE order_id=$1`, [bank.order.order_ref]);
  await assert.rejects(cancelPublicOrder(x.runtime, s.slug, bank.order.order_ref, bank.opened.access, opt), problem(409, 'checkout_order_closed'));
  const payable = await place('bank_transfer');
  await upgrade(s);
  const owner = await authenticate(x.runtime, sessionOf(s.owner.cookie));
  const date = (await x.h.pool.query<{d: string}>("SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Taipei','YYYY-MM-DD') AS d")).rows[0].d;
  await confirmOfflinePayment(x.runtime, owner, s.tenantId, s.instanceId, payable.order.order_ref, {amount_minor: payable.order.total_minor, received_on: date}, randomUUID(), '1');
  await assert.rejects(cancelPublicOrder(x.runtime, s.slug, payable.order.order_ref, payable.opened.access, opt), problem(409, 'payment_already_applied'));
  const open = await place('cash_on_meetup');
  await assert.rejects(cancelPublicOrder(x.runtime, s.slug, open.order.order_ref, open.opened.access, {...opt, settings: {...opt.settings!, quarantine: true}}), problem(503, 'commerce_quarantined'));
  assert.equal((await x.h.pool.query('SELECT lifecycle_state FROM commerce_checkout_orders WHERE order_id=$1', [open.order.order_ref])).rows[0].lifecycle_state, 'open');
  const cash = await readPublicOrder(x.runtime, s.slug, open.order.order_ref, open.opened.access, opt);
  assert.equal(cash.payment_method, 'cash_on_meetup');
  assert.equal(cash.offline_instructions, null);
  assert.equal(cash.payment_grace_until !== null, true);
  const holds = await x.tx(async q => (await checkoutInventory(q, open.order.order_ref)).holds);
  assert.equal(holds.every(hold => hold.state === 'held'), true);
});
