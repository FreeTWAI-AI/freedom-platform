import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { CommerceCredentialKeyring } from '../../modules/agent-commerce/payments/credentials.js';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test, before, after, beforeEach } from 'node:test';
import { ECPAY_ORIGINS, EcpayKeyPair, newTradeNumber, verifySignedForm, encodeForm } from '../../modules/agent-commerce/providers/ecpay/index.js';
import { buildCreditCheckoutForm } from '../../modules/agent-commerce/providers/ecpay/aio-credit/index.js';
import { createEcpayPaymentGateway, createFixturePaymentGateway, paymentGatewayUrls, assertPaymentGatewayInstallation } from '../../modules/agent-commerce/payments/gateway.js';
import { hostedPaymentHarness } from '../e2e/hosted-payment-fixture.js';
import { ok } from './hosted-checkout-harness.js';
import { syntheticShippingPort } from '../../scripts/synthetic-shipping-quote.js';
import { hashKey } from '../../modules/agent-commerce/checkout/terms.js';
import { COMMERCE_LIMITS } from '../../modules/agent-commerce/checkout/limits.js';
import { createStoreAdmissionPort } from '../../modules/agent-commerce/operations/admissions.js';
import { creditUnavailableMessage } from '../../modules/agent-commerce/payments/availability.js';
import type { CreditUnavailableReason } from '../../modules/agent-commerce/providers/ecpay/aio-credit/index.js';
import { runInNewContext } from 'node:vm';
import { HANDOFF_SCRIPT, handoffFormPage } from '../../modules/agent-commerce/payments/handoff-page.js';
import { cancelUnpaidOrder } from '../../modules/agent-commerce/checkout/orders.js';
import { platformContentSecurityPolicy } from '../../apps/platform-api/src/platform-app.js';
const origin = 'https://payments.freedom.test', localOrigin = 'http://127.0.0.1:4745';
const fixtureInput = () => ({ freedomEnv: 'local' as const, environment: 'sandbox' as const, publicBaseUrl: 'https://e2e-payments.freedom.test', checkoutAction: localOrigin + '/__e2e/ecpay/aio-checkout', localOrigin });
for (const environment of ['sandbox', 'live'] as const)
  test(`gateway URLs and action equal the public form builder for ${environment}`, () => {
    const gateway = createEcpayPaymentGateway(environment, origin), attemptId = randomUUID(), accountRef = '0'.repeat(26), urls = paymentGatewayUrls(gateway, { accountRef, attemptId });
    const keys = EcpayKeyPair.of(randomBytes(8).toString('hex'), randomBytes(8).toString('hex'));
    const form = buildCreditCheckoutForm({ environment, merchantId: '1234567', merchantTradeNo: newTradeNumber('F'), createdAtEpochMs: Date.parse('2026-01-02T00:00:00.000Z'), currency: 'TWD', totalMinor: 500, lines: [{ name: '合成商品', quantity: 1 }], storeName: '合成商店', displayNumber: '260102-012345', ...urls }, keys);
    assert.equal(gateway.checkoutAction, ECPAY_ORIGINS.payment[environment] + '/Cashier/AioCheckOut/V5');
    assert.equal(gateway.checkoutAction, form.action);
    assert.deepEqual(urls, { returnUrl: origin + '/api/v1/provider-callbacks/ecpay/' + accountRef + '/payment', orderResultUrl: origin + '/pay/ecpay/return/' + accountRef, clientBackUrl: origin + '/pay/ecpay/back/' + attemptId });
    const fields = Object.fromEntries(form.fields);
    assert.equal(fields.ReturnURL, urls.returnUrl);
    assert.equal(fields.OrderResultURL, urls.orderResultUrl);
    assert.equal(fields.ClientBackURL, urls.clientBackUrl);
    assert.equal(fields.NeedExtraPaidInfo, 'Y');
    assert.equal(verifySignedForm(encodeForm(form.fields), [keys], 'sha256').ok, true);
    assert(Object.isFrozen(gateway));
  });
for (const invalid of ['http://payments.freedom.test', 'https://localhost', 'https://127.0.0.1', 'https://payments.freedom.test:443', 'https://payments.freedom.test:8443', 'https://payments.freedom.test/', 'https://payments.freedom.test/path', 'https://payments.freedom.test?', 'https://payments.freedom.test#', 'https://user@payments.freedom.test', 'https://echo.freedom.test', 'https://Payments.freedom.test', 'https://bad_host.test', 'https://payments.freedom.test.', 'https://' + ('x'.repeat(60) + '.').repeat(3) + 'test'])
  test(`gateway refuses unsafe or non-origin public base ${invalid}`, () => {
    assert.throws(() => createEcpayPaymentGateway('sandbox', invalid), { message: 'payment_gateway_invalid' });
  });
test('fixture requires local mode at construction and installation, a synthetic HTTPS base and a same-origin local action', () => {
  const input = fixtureInput(), gateway = createFixturePaymentGateway(input);
  assert.equal(gateway.checkoutAction, input.checkoutAction);
  assert.equal(gateway.publicBaseUrl, input.publicBaseUrl);
  assertPaymentGatewayInstallation(gateway, 'local', localOrigin);
  for (const freedomEnv of ['staging', 'public'] as const) {
    assert.throws(() => createFixturePaymentGateway({ ...input, freedomEnv }), { message: 'payment_fixture_requires_local' });
    assert.throws(() => assertPaymentGatewayInstallation(gateway, freedomEnv, origin), { message: 'payment_fixture_requires_local' });
  }
  for (const change of [{ checkoutAction: 'https://foreign.test/__e2e/ecpay/aio-checkout' }, { localOrigin: origin, checkoutAction: origin + '/__e2e/ecpay/aio-checkout' }, { publicBaseUrl: localOrigin }, { checkoutAction: input.checkoutAction + '?x=1' }, { checkoutAction: input.checkoutAction + '#fragment' }])
    assert.throws(() => createFixturePaymentGateway({ ...input, ...change }), { message: 'payment_gateway_invalid' });
  assert.throws(() => assertPaymentGatewayInstallation({ ...gateway }, 'public', origin), { message: 'payment_gateway_invalid' });
  assert.throws(() => assertPaymentGatewayInstallation(gateway, 'local', 'http://127.0.0.1:4746'), { message: 'payment_gateway_invalid' });
});
test('gateway installation ties provider environment and base to this platform origin', () => {
  assertPaymentGatewayInstallation(createEcpayPaymentGateway('live', origin), 'public', origin);
  assertPaymentGatewayInstallation(createEcpayPaymentGateway('sandbox', origin), 'staging', origin);
  assert.throws(() => assertPaymentGatewayInstallation(createEcpayPaymentGateway('live', origin), 'staging', origin), { message: 'payment_gateway_invalid' });
  assert.throws(() => assertPaymentGatewayInstallation(createEcpayPaymentGateway('sandbox', origin), 'staging', 'https://other.freedom.test'), { message: 'payment_gateway_invalid' });
});
test('gateway validates route identifiers and CDN rules before they can become signed fields', () => {
  const gateway = createEcpayPaymentGateway('sandbox', origin);
  for (const input of [{ accountRef: '0'.repeat(26), attemptId: '../escape' }, { accountRef: '0'.repeat(23) + 'ecd', attemptId: randomUUID() }, { accountRef: '../escape', attemptId: randomUUID() }])
    assert.throws(() => paymentGatewayUrls(gateway, input), { message: 'payment_gateway_invalid' });
});
let f: Awaited<ReturnType<typeof hostedPaymentHarness>>;
before(async () => { f = await hostedPaymentHarness('fp_payment_handoff'); });
beforeEach(async () => { await f.reset(); });
after(async () => f?.stop());
const expect = (r: Awaited<ReturnType<typeof f.http>>, status: number, code?: string) => {
  assert.equal(r.status, status, JSON.stringify(r.data)); if (code)
    assert.equal(r.data.code, code); return r.data;
};
const resume = (p: Awaited<ReturnType<typeof f.placed>>, cookie: string | undefined = p.cookie) => f.http('POST', f.root(p.s) + `/orders/${p.order.order_ref}/payment-handoffs`, {}, cookie);
test('placement atomically creates attempt 1, two exact due times and one hashed fifteen-minute token', async () => {
  const p = await f.placed(), a = (await f.x.h.pool.query('SELECT * FROM commerce_payment_attempts WHERE order_id=$1', [p.order.order_ref])).rows[0];
  assert.equal(a.sequence, 1);
  assert.equal(a.state, 'issued');
  assert.equal(a.account_id, p.provider.accountId);
  assert.equal(a.credential_version, 1);
  assert.equal(a.amount_minor, '500');
  assert.equal(a.journaled_at, null);
  assert.equal(a.handed_off_at, null);
  assert.equal(a.version, '1');
  assert.match(p.payment.handoff_url, /^\/pay\/ecpay\/[A-Za-z0-9_-]{43}$/);
  assert.equal(p.payment.attempt_ref, a.attempt_id);
  const route = (await f.x.h.pool.query("SELECT *,expires_at=created_at+interval '15 minutes' AS exact FROM commerce_entry_routes WHERE route_kind='payment_handoff' AND target_id=$1", [a.attempt_id])).rows[0];
  assert.equal(route.route_key, hashKey(p.payment.handoff_url.split('/').at(-1)!));
  assert(route.exact);
  assert.equal(route.revoked_at, null);
  assert.equal(route.expires_at.toISOString(), p.payment.expires_at);
  const due = (await f.x.h.pool.query(`SELECT w.kind,w.due_at=a.created_at+CASE w.kind WHEN 'payment_query' THEN interval '10 minutes' ELSE interval '60 minutes' END AS exact
    FROM commerce_due_work w JOIN commerce_payment_attempts a ON a.attempt_id=w.target_id WHERE a.attempt_id=$1 ORDER BY kind`, [a.attempt_id])).rows;
  assert.deepEqual(due, [{ kind: 'payment_query', exact: true }, { kind: 'payment_window_end', exact: true }]);
});
test('placement replay replaces the token without a new attempt, order or due row', async () => {
  const p = await f.placed(), replay = expect(await f.http('POST', f.root(p.s) + `/checkouts/${p.checkout.checkout_ref}/orders`, p.intent, p.cookie), 200);
  assert.equal(replay.payment.attempt_ref, p.payment.attempt_ref);
  assert.notEqual(replay.payment.handoff_url, p.payment.handoff_url);
  assert.deepEqual(replay.order, p.order);
  assert.equal((await f.x.h.pool.query('SELECT count(*)::int n FROM commerce_payment_attempts')).rows[0].n, 1);
  assert.equal((await f.x.h.pool.query('SELECT count(*)::int n FROM commerce_due_work')).rows[0].n, 2);
  const routes = (await f.x.h.pool.query("SELECT route_key,revoked_at FROM commerce_entry_routes WHERE route_kind='payment_handoff' ORDER BY created_at")).rows;
  assert(routes[0].revoked_at instanceof Date);
  assert.equal(routes[1].revoked_at, null);
});
test('resume shares buyer access, replaces older links and returns private no-store/no-referrer responses', async () => {
  const p = await f.placed();
  expect(await resume(p, ''), 404, 'checkout_order_not_found');
  expect(await f.http('POST', f.root(p.s) + `/orders/${randomUUID()}/payment-handoffs`, {}, p.cookie), 404, 'checkout_order_not_found');
  const r = await resume(p);
  expect(r, 201);
  assert.equal(r.data.attempt_ref, p.payment.attempt_ref);
  assert.notEqual(r.data.handoff_url, p.payment.handoff_url);
  assert.equal(r.response.headers.get('Cache-Control'), 'no-store');
  assert.equal(r.response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(r.response.headers.get('Set-Cookie'), null);
  expect(await f.http('POST', f.root(p.s) + `/orders/${p.order.order_ref}/payment-handoffs`, { extra: true }, p.cookie), 422, 'validation_failed');
  expect(await f.http('POST', f.root(p.s) + `/orders/${p.order.order_ref}/payment-handoffs`, {}, p.cookie, { Origin: 'https://foreign.test' }), 403, 'origin_rejected');
});
test('resume keeps quarantine/checkout codes and charges its own durable network budget', async () => {
  const p = await f.placed();
  f.settings.quarantine = true;
  expect(await resume(p), 503, 'commerce_quarantined');
  f.settings.quarantine = false;
  f.settings.checkoutEnabled = false;
  expect(await resume(p), 409, 'checkout_not_enabled');
  f.settings.checkoutEnabled = true;
  const bucket = 'commerce:handoffNetwork:' + hashKey('192.0.2.1');
  await f.x.h.pool.query('INSERT INTO auth_rate_limits(bucket,window_start,attempts) VALUES($1,clock_timestamp(),$2)', [bucket, COMMERCE_LIMITS.handoffNetwork.limit]);
  const r = await resume(p);
  expect(r, 429, 'commerce_rate_limited');
  assert(Number(r.response.headers.get('Retry-After')) > 0);
});
test('a handed-off attempt cannot receive another token, including a placement replay', async () => {
  const p = await f.placed();
  await f.x.h.pool.query('UPDATE commerce_payment_attempts SET journaled_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1', [p.payment.attempt_ref]);
  await f.x.h.pool.query('UPDATE commerce_payment_attempts SET handed_off_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1', [p.payment.attempt_ref]);
  const pending=await resume(p);expect(pending,409,'payment_result_pending');assert(Number(pending.response.headers.get('Retry-After'))>0);
  const replay = expect(await f.http('POST', f.root(p.s) + `/checkouts/${p.checkout.checkout_ref}/orders`, p.intent, p.cookie), 200);
  assert.equal(replay.payment, null);
  assert.equal((await f.x.h.pool.query("SELECT count(*)::int n FROM commerce_entry_routes WHERE route_kind='payment_handoff'")).rows[0].n, 1);
});
test('an attempt write failure rolls back the order and its already-created holds', async () => {
  const p = await f.readyCheckout(), payment = f.runtime.commercePorts!.payment!;
  let called = false;
  f.install({
    commercePorts: {
      ...f.runtime.commercePorts, payment: {
        ...payment, async createOrderAttempt(q, input) {
          called = true;
          assert.equal((await q.query("SELECT count(*)::int n FROM commerce_inventory_reservations WHERE order_id=$1 AND state='held'", [input.orderId])).rows[0].n, 1);
          throw Error('payment_trade_number_unavailable');
        }
      }
    }
  });
  expect(await f.http('POST', f.root(p.s) + `/checkouts/${p.checkout.checkout_ref}/orders`, p.intent, p.cookie), 500, 'internal_error');
  assert(called);
  for (const table of ['commerce_checkout_orders', 'commerce_inventory_reservations', 'commerce_payment_attempts', 'commerce_due_work'])
    assert.equal((await f.x.h.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0, table);
  assert.equal((await f.x.h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1', [p.s.product.product_id])).rows[0].reserved, 0);
});
test('five real trade-number conflicts draw fresh numbers and then roll back placement', async () => {
  const p = await f.readyCheckout(), connect = f.x.runtime.connect, draws: string[] = [];
  f.x.runtime.connect = (async () => {
    const q = await (connect as () => Promise<import('pg').PoolClient>).call(f.x.runtime), query = q.query, release = q.release;
    q.query = (async (...args: unknown[]) => {
      if (/^INSERT INTO commerce_payment_attempts/.test(String(args[0]))) {
        const values = args[1] as unknown[];
        draws.push(String(values[8]));
        await (query as Function).call(q, `INSERT INTO commerce_payment_attempts(tenant_id,instance_id,kind,sequence,account_id,purpose,environment,merchant_id,credential_version,provider,profile,merchant_trade_no,amount_minor,currency)
          VALUES($1,$2,'service_activation',$11,$3,'payment',$4,$5,$6,'ecpay',$7,$8,$9,$10)`, [values[0], values[1], values[3], values[4], values[5], values[6], values[7], values[8], values[9], values[10], 100 + draws.length]);
      }
      return (query as Function).apply(q, args);
    }) as typeof q.query;
    q.release = (error?: Error | boolean) => { q.query = query; q.release = release; release.call(q, error); };
    return q;
  }) as typeof f.x.runtime.connect;
  try {
    expect(await f.http('POST', f.root(p.s) + `/checkouts/${p.checkout.checkout_ref}/orders`, p.intent, p.cookie), 500, 'internal_error');
  }
  finally {
    f.x.runtime.connect = connect;
  }
  assert.equal(draws.length, 5);
  assert.equal(new Set(draws).size, 5);
  for (const table of ['commerce_checkout_orders', 'commerce_inventory_reservations', 'commerce_payment_attempts', 'commerce_due_work'])
    assert.equal((await f.x.h.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0, table);
});
test('admission requires a listed active payment service in this environment, and an unrevoked admission', async () => {
  const s = await f.x.store(), before = f.runtime.commercePorts!.admission!;
  assert.equal(await f.x.tx(async (q) => before.allowed(q, s)), false);
  const provider = await f.setup(s);
  assert.equal(await f.x.tx(async (q) => before.allowed(q, s)), true);
  for (const port of [createStoreAdmissionPort('sandbox', []), createStoreAdmissionPort('sandbox', ['unknown']), createStoreAdmissionPort('live', ['ecpay.aio.credit.v1'])])
    assert.equal(await f.x.tx(async (q) => port.allowed(q, s)), false);
  for (const state of ['suspended', 'retired'])
    await f.x.tx(async (q) => {
      assert.equal(await before.allowed(q, s), true);
      await q.query('SAVEPOINT inactive');
      await q.query('UPDATE commerce_provider_account_services SET state=$2,version=version+1,updated_at=clock_timestamp() WHERE account_id=$1', [provider.accountId, state]);
      assert.equal(await before.allowed(q, s), false);
      await q.query('ROLLBACK TO SAVEPOINT inactive');
    });
  await f.x.h.pool.query(`UPDATE commerce_store_admissions SET revoked_at=clock_timestamp(),revoked_by=(SELECT admin_id FROM platform_admins LIMIT 1),revoke_reason='合成撤銷' WHERE admission_id=$1`, [provider.admissionId]);
  assert.equal(await f.x.tx(async (q) => before.allowed(q, s)), false);
});
const unavailableCases = [
  { reason: 'currency_not_supported', message: '這間店的幣別不能用信用卡付款。' },
  { reason: 'amount_not_whole_twd', message: '金額有不到 1 元的零頭，不能用信用卡付款。' },
  { reason: 'amount_below_minimum', message: '信用卡付款的總額至少 5 元。' },
  { reason: 'amount_above_maximum', message: '信用卡付款的總額最多 999,999,999 元。' },
] as const;
for (const phase of ['checkout', 'placement'] as const)
  for (const scenario of unavailableCases)
    test(`${phase} rejects ${scenario.reason} with its fixed Chinese message and no partial effect`, async () => {
      const s = await f.x.store(100);
      await f.setup(s);
      let revision = '1', quantity = 5;
      const basePorts = { ...f.runtime.commercePorts };
      if (scenario.reason === 'currency_not_supported') {
        await f.x.h.pool.query("UPDATE commerce_shops SET currency='USD' WHERE shop_id=ANY($1::uuid[])", [[s.storefront_shop_id, s.supply_shop_id]]);
        await f.x.publish(s);
        revision = '2';
      }
      if (scenario.reason === 'amount_not_whole_twd') {
        expect(await f.x.send(s, '/products/' + s.product.product_id, { price_minor: 150 }, s.product.version, 'PATCH'), 200);
        await f.x.publish(s);
        revision = '2';
        quantity = 2;
        basePorts.shipping = syntheticShippingPort({ fee_per_parcel_minor: 200 });
      }
      if (scenario.reason === 'amount_below_minimum')
        quantity = 1;
      if (scenario.reason === 'amount_above_maximum')
        basePorts.shipping = syntheticShippingPort({ fee_per_parcel_minor: 99999999900 });
      // Freeze the invalid terms without either quote-time card gate, then restore
      // both real ports so placement must reject them without partial effects.
      f.install({ commercePorts: { ...basePorts, ...(phase === 'placement' ? { payment: undefined, paymentMethods: undefined } : {}) } });
      const input = { ...f.x.input(s.product.sku, quantity), publication_revision: revision };
      let response = await f.http('POST', f.root(s) + '/checkouts', input, undefined, { 'Idempotency-Key': randomUUID() });
      if (phase === 'placement') {
        expect(response, 201);
        const saved = response.data, cookie = response.response.headers.get('Set-Cookie')!.split(';')[0];
        f.install({ commercePorts: basePorts });
        response = await f.http('POST', f.root(s) + `/checkouts/${saved.checkout_ref}/orders`, { terms_sha256: saved.terms_sha256, client_order_id: randomUUID() }, cookie);
      }
      expect(response, 409, 'payment_profile_unavailable');
      assert.equal(response.data.detail, scenario.message);
      for (const table of ['commerce_checkout_orders', 'commerce_inventory_reservations', 'commerce_payment_attempts', 'commerce_due_work'])
        assert.equal((await f.x.h.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0, table);
      if (phase === 'checkout')
        for (const table of ['commerce_checkouts', 'commerce_checkout_contacts', 'commerce_customers', 'commerce_order_access_grants'])
          assert.equal((await f.x.h.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0, table);
    });
test('availability checks each shipping group even when their sum and the order total are whole TWD', async () => {
  // Two real lines (own and supplied) so strict grouping still yields two groups of 50. The test port's drop_ship agreement is synthetic, not a production agreement.
  const retailer = await f.x.store(), supplier = await f.x.store();
  await f.setup(retailer);
  const offer = ok(await f.x.send(supplier, `/products/${supplier.product.product_id}/supply-offer`, {}, supplier.product.version));
  const selection = ok(await f.x.send(retailer, '/distribution-selections', { offer_id: offer.offer_id, terms_sha256: offer.terms_sha256, retail_price_minor: 100 }), 201);
  ok(await f.x.send(supplier, `/supply-requests/${selection.selection_id}/decision`, { decision: 'accepted', listing_sha256: selection.listing_sha256 }, selection.version));
  await f.x.publish(retailer);
  f.install({ commercePorts: { shipping: syntheticShippingPort({ fee_per_parcel_minor: 50 }) } });
  const input = { ...f.x.input(retailer.product.sku, 5), publication_revision: '2', lines: [{ sku: retailer.product.sku, quantity: 5 }, { sku: 'P0002', quantity: 5 }] };
  const r = await f.http('POST', f.root(retailer) + '/checkouts', input, undefined, { 'Idempotency-Key': randomUUID() });
  expect(r, 409, 'payment_profile_unavailable');
  assert.equal(r.data.detail, '金額有不到 1 元的零頭，不能用信用卡付款。');
});
test('the availability reason list is closed at runtime', () => {
  assert.throws(() => creditUnavailableMessage('future_reason' as CreditUnavailableReason), { message: 'payment_availability_reason_unknown' });
});
async function page(path: string, method = 'GET') {
  const request = new Request(f.origin + path, { method, headers: { 'CF-Connecting-IP': '192.0.2.1' } });
  Object.defineProperty(request, 'cf', { value: { colo: 'TEST' } });
  const response = await f.app.fetch(request);
  return { response, status: response.status, html: await response.text() };
}
async function unused(attemptId: string) {
  const a = (await f.x.h.pool.query('SELECT * FROM commerce_payment_attempts WHERE attempt_id=$1', [attemptId])).rows[0];
  assert.equal(a.handed_off_at, null);
  const row = (await f.x.h.pool.query("SELECT * FROM commerce_entry_routes WHERE route_kind='payment_handoff' AND target_id=$1 ORDER BY created_at DESC LIMIT 1", [attemptId])).rows[0];
  assert.equal(row.revoked_at, null);
}
test('handoff page signs stored data, journals outside transactions, then consumes the token once', async () => {
  const p = await f.placed();
  let appends = 0;
  const journal = {
    environment: 'local' as const, async append(record: import('../../modules/agent-commerce/operations/journal/journal.js').EffectRecord) {
      appends++;
      assert.equal((await f.x.runtime.query("SELECT count(*)::int n FROM pg_stat_activity WHERE usename=current_user AND state='idle in transaction'")).rows[0].n, 0);
      assert.equal((await f.x.h.pool.query('SELECT journaled_at FROM commerce_payment_attempts WHERE attempt_id=$1', [p.payment.attempt_ref])).rows[0].journaled_at, null);
      await f.journal.append(record);
    }
  };
  f.install({ commercePayments: { gateway: f.gateway, journal, profiles: f.settings.providerProfiles } });
  const result = await page(p.payment.handoff_url);
  assert.equal(result.status, 200, result.html);
  assert.equal(appends, 1);
  assert.match(result.html, /<html lang="zh-Hant">/);
  assert.match(result.html, /<title>前往付款｜自由工坊<\/title>/);
  assert.match(result.html, /正在前往綠界付款頁…/);
  assert.match(result.html, /<noscript><button type="submit">前往綠界付款<\/button><\/noscript>/);
  assert.match(result.html, new RegExp('<form method="post" action="' + f.origin + '/__e2e/ecpay/aio-checkout">'));
  assert(!/\btarget=|<iframe|<style|<script(?! src=)/.test(result.html));
  const fields = Object.fromEntries([...result.html.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)].map(m => [m[1], m[2].replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')]));
  const a = (await f.x.h.pool.query('SELECT *,journaled_at<=handed_off_at AS ordered FROM commerce_payment_attempts WHERE attempt_id=$1', [p.payment.attempt_ref])).rows[0];
  assert(a.journaled_at instanceof Date);
  assert(a.handed_off_at instanceof Date);
  assert(a.ordered);
  assert.equal(a.version, '3');
  const keys = EcpayKeyPair.of(p.provider.material.hash_key, p.provider.material.hash_iv), urls = paymentGatewayUrls(f.gateway, { accountRef: p.provider.accountRef, attemptId: a.attempt_id });
  const expected = buildCreditCheckoutForm({ environment: 'sandbox', merchantId: '1234567', merchantTradeNo: a.merchant_trade_no, createdAtEpochMs: a.created_at.getTime(), currency: 'TWD', totalMinor: 500, lines: [{ name: '合成商品', quantity: 5 }], storeName: '合成商店', displayNumber: p.order.display_number, ...urls }, keys);
  assert.deepEqual(fields, Object.fromEntries(expected.fields));
  const [key, body] = [...f.journal.objects].find(([key]) => key.endsWith('/payment_handoff/' + a.attempt_id))!;
  assert.equal(key, `local/${a.created_at.toISOString().slice(0, 10).replaceAll('-', '/')}/payment_handoff/${a.attempt_id}`);
  assert.deepEqual(JSON.parse(body), { environment: 'local', kind: 'payment_handoff', id: a.attempt_id, occurred_at: a.created_at.toISOString(), tenant_id: p.s.tenantId, instance_id: p.s.instanceId, detail: { account_ref: p.provider.accountRef, merchant_trade_no: a.merchant_trade_no, amount_minor: 500, currency: 'TWD', order_id: p.order.order_ref } });
  for (const header of ['Cache-Control', 'Referrer-Policy', 'X-Robots-Tag'])
    assert.equal(result.response.headers.get(header), { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' }[header]);
  assert.equal((await page(p.payment.handoff_url)).status, 410);
});
test('concurrent GETs return exactly one form and one consumed-link page', async () => {
  const p = await f.placed(), results = await Promise.all([page(p.payment.handoff_url), page(p.payment.handoff_url)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 410]);
  assert.equal(results.filter(r => r.html.includes('<form ')).length, 1);
});
test('a journal outage does not consume a token and an identical retry can succeed', async () => {
  const p = await f.placed();
  f.install({ commercePayments: { gateway: f.gateway, profiles: f.settings.providerProfiles, journal: { environment: 'local', append: async () => { throw Error('synthetic-private'); } } } });
  const result = await page(p.payment.handoff_url);
  assert.equal(result.status, 503);
  assert(!result.html.includes('synthetic-private'));
  await unused(p.payment.attempt_ref);
  assert.equal((await f.x.h.pool.query('SELECT journaled_at FROM commerce_payment_attempts WHERE attempt_id=$1', [p.payment.attempt_ref])).rows[0].journaled_at, null);
  f.install();
  assert.equal((await page(p.payment.handoff_url)).status, 200);
});
for (const reason of ['quarantine', 'checkout_off', 'unlisted_profile', 'missing_gateway', 'missing_keyring', 'unseal_failure'] as const)
  test(`handoff ${reason} gate returns 503 without consuming the token`, async () => {
    const p = await f.placed();
    if (reason === 'quarantine')
      f.settings.quarantine = true;
    if (reason === 'checkout_off')
      f.settings.checkoutEnabled = false;
    if (reason === 'unlisted_profile')
      f.install({ commercePayments: { gateway: f.gateway, journal: f.journal, profiles: [] } });
    if (reason === 'missing_gateway')
      f.install({ commercePayments: { journal: f.journal, profiles: f.settings.providerProfiles } });
    if (reason === 'missing_keyring')
      f.install({ commerceCredentialKeyring: null });
    if (reason === 'unseal_failure')
      f.install({ commerceCredentialKeyring: CommerceCredentialKeyring.parse('different:' + randomBytes(32).toString('base64')) });
    const result = await page(p.payment.handoff_url);
    assert.equal(result.status, 503, result.html);
    assert(!result.html.includes('<form '));
    await unused(p.payment.attempt_ref);
  });
test('HEAD and invalid/unknown tokens never consume an attempt or reveal its reference', async () => {
  const p = await f.placed();
  assert.equal((await page(p.payment.handoff_url, 'HEAD')).status, 404);
  await unused(p.payment.attempt_ref);
  for (const token of ['invalid', randomBytes(32).toString('base64url')]) {
    const r = await page('/pay/ecpay/' + token);
    assert.equal(r.status, 404);
    assert.match(r.html, /href="\/"/);
    assert(!r.html.includes(p.payment.attempt_ref));
  }
});
test('revoked and expired links use the invalid-link text with an order back link', async () => {
  const p = await f.placed();
  expect(await resume(p), 201);
  let result = await page(p.payment.handoff_url);
  assert.equal(result.status, 410);
  assert.match(result.html, /付款連結已失效或不存在。/);
  assert(result.html.includes('/pay/ecpay/back/' + p.payment.attempt_ref));
  const token = randomBytes(32).toString('base64url');
  await f.x.h.pool.query(`INSERT INTO commerce_entry_routes(route_kind,route_key,tenant_id,instance_id,target_id,created_at,expires_at)
    VALUES('payment_handoff',$1,$2,$3,$4,clock_timestamp()-interval '16 minutes',clock_timestamp()-interval '1 minute')`, [hashKey(token), p.s.tenantId, p.s.instanceId, p.payment.attempt_ref]);
  result = await page('/pay/ecpay/' + token);
  assert.equal(result.status, 410);
  assert(result.html.includes('/pay/ecpay/back/' + p.payment.attempt_ref));
});
test('handoff rate limit returns a 429 HTML page with Retry-After before resolving the token', async () => {
  const p = await f.placed();
  await f.x.h.pool.query('INSERT INTO auth_rate_limits(bucket,window_start,attempts) VALUES($1,clock_timestamp(),$2)', ['commerce:handoffPageNetwork:' + hashKey('192.0.2.1'), COMMERCE_LIMITS.handoffPageNetwork.limit]);
  const r = await page(p.payment.handoff_url);
  assert.equal(r.status, 429);
  assert.match(r.response.headers.get('Content-Type')!, /text\/html/);
  assert(Number(r.response.headers.get('Retry-After')) > 0);
  await unused(p.payment.attempt_ref);
});
test('HTML escapes every signed name/value and the form action', () => {
  const html = handoffFormPage({ action: 'https://unused.test', fields: [['a"<&\'', 'b"<&\'>']] }, 'https://safe.test/?x="<&\'', randomUUID());
  assert(html.includes('name="a&quot;&lt;&amp;&#39;" value="b&quot;&lt;&amp;&#39;&gt;"'));
  assert(html.includes('action="https://safe.test/?x=&quot;&lt;&amp;&#39;"'));
});
test('handoff CSP permits the configured destination on token paths alone', async () => {
  const p = await f.placed(), policy = platformContentSecurityPolicy(p.payment.handoff_url, undefined, 'https://payment-stage.ecpay.com.tw');
  assert(policy.endsWith("form-action 'self' https://payment-stage.ecpay.com.tw"));
  assert(!policy.includes('unsafe-inline'));
  for (const path of ['/', '/api/v1/site', '/shops/synthetic-shop', '/pay/ecpay/handoff.js', '/pay/ecpay/handoff.css', '/pay/ecpay/back/' + p.payment.attempt_ref, '/pay/ecpay/return/' + p.provider.accountRef])
    assert.equal(platformContentSecurityPolicy(path, undefined, 'https://payment-stage.ecpay.com.tw'), platformContentSecurityPolicy(path));
  const r = await page(p.payment.handoff_url);
  assert(r.response.headers.get('Content-Security-Policy')!.endsWith("form-action 'self' " + f.origin));
});
test('review 7: handoff fallback waits ten seconds and submits at most once per deliberate tap', async () => {
  const handlers = new Map<string, Function>(), clicks = new Map<string, Function>(), timers: Function[] = [];
  let submissions = 0, prevented = 0;
  const form = { hidden: false }, status = { textContent: '' }, help = { hidden: true }, back = { hidden: true };
  const manual = { hidden: true, disabled: false, addEventListener: (name: string, fn: Function) => clicks.set(name, fn) };
  const elements = { 'handoff-status': status, 'handoff-manual': manual, 'handoff-help': help, 'handoff-back': back };
  const context = { document: { querySelector: () => form, getElementById: (id: keyof typeof elements) => elements[id] }, window: { addEventListener: (name: string, fn: Function) => handlers.set(name, fn) }, HTMLFormElement: { prototype: { submit() { assert.equal(this, form); submissions++; } } }, setTimeout: (fn: Function, ms: number) => { assert.equal(ms, 10000); timers.push(fn); return 1; }, clearTimeout() {} };
  runInNewContext(HANDOFF_SCRIPT, context);
  handlers.get('load')!();
  handlers.get('load')!();
  assert.equal(submissions, 1);
  assert(manual.hidden && help.hidden);
  timers[0]();
  assert(!manual.hidden && !help.hidden);
  const click = () => clicks.get('click')!({ preventDefault() { prevented++; } });
  click();
  assert(manual.disabled);
  assert.equal(submissions, 2);
  click();
  assert.equal(submissions, 2);
  assert.equal(prevented, 2);
  handlers.get('pageshow')!({ persisted: true });
  assert(form.hidden && manual.hidden && manual.disabled && help.hidden);
  assert(!back.hidden);
  assert.equal(status.textContent, '已前往付款頁。要重新付款，請回到訂單頁。');
  handlers.get('load')!();
  timers[0]();
  click();
  assert.equal(submissions, 2);
  const asset = await page('/pay/ecpay/handoff.js');
  assert.equal(asset.status, 200);
  assert.equal(asset.html, HANDOFF_SCRIPT);
  assert.match(asset.response.headers.get('Content-Type')!, /javascript/);
});
test('review 7: restored handoff markup retains a hidden order back link and consistent buttons', async () => {
  const p = await f.placed(), result = await page(p.payment.handoff_url);
  assert.match(result.html, new RegExp('id="handoff-back" href="/pay/ecpay/back/' + p.payment.attempt_ref + '" hidden>返回訂單</a>'));
  assert.equal((result.html.match(/>前往綠界付款<\/button>/g) ?? []).length, 2);
  assert.match(result.html, /id="handoff-help" hidden>如果畫面一直沒有變化，請按「前往綠界付款」。/);
});
for (const reason of ['tenant_inactive', 'instance_inactive', 'service_inactive', 'admission_revoked', 'order_cancelled', 'holds_released', 'attempt_failed'] as const)
  test(`handoff ${reason} gate leaves the token unconsumed`, async () => {
    const p = await f.placed();
    if (reason === 'tenant_inactive')
      await f.x.h.pool.query("UPDATE tenants SET status='suspended' WHERE tenant_id=$1", [p.s.tenantId]);
    if (reason === 'instance_inactive')
      await f.x.h.pool.query("UPDATE module_instances SET status='suspended' WHERE instance_id=$1", [p.s.instanceId]);
    if (reason === 'service_inactive')
      await f.x.tx(async (q) => { await f.runtime.commercePorts!.admission!.allowed(q, p.s); await q.query("UPDATE commerce_provider_account_services SET state='suspended',version=version+1,updated_at=clock_timestamp() WHERE account_id=$1", [p.provider.accountId]); });
    if (reason === 'admission_revoked')
      await f.x.h.pool.query("UPDATE commerce_store_admissions SET revoked_at=clock_timestamp(),revoked_by=(SELECT admin_id FROM platform_admins LIMIT 1),revoke_reason='合成撤銷' WHERE admission_id=$1", [p.provider.admissionId]);
    if (reason === 'order_cancelled')
      await f.x.tx(q => cancelUnpaidOrder(q, p.s, p.order.order_ref, 'buyer', 'buyer_cancelled'));
    if (reason === 'holds_released')
      await f.x.tx(async (q) => { await q.query("UPDATE commerce_inventory_reservations SET state='released',released_at=clock_timestamp() WHERE order_id=$1", [p.order.order_ref]); await q.query('UPDATE commerce_items SET reserved=reserved-5 WHERE item_id=$1', [p.s.product.product_id]); });
    if (reason === 'attempt_failed')
      await f.x.h.pool.query("UPDATE commerce_payment_attempts SET state='failed',failed_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1", [p.payment.attempt_ref]);
    const r = await page(p.payment.handoff_url);
    assert.equal(r.status, reason === 'attempt_failed' ? 410 : 409, r.html);
    await unused(p.payment.attempt_ref);
    if (reason === 'holds_released')
      assert.match(r.html, /付款期限已過，保留的商品已釋出。/);
    assert(!r.html.includes('<form '));
    assert.equal([...f.journal.objects.keys()].filter(k => k.endsWith('/payment_handoff/' + p.payment.attempt_ref)).length, 0);
  });
test('review 7: expired retained holds refuse handoff before journaling and leave the token usable for the back link', async () => {
  const s = await f.x.store(100);
  await f.setup(s);
  const due = await f.x.due(s);
  await f.x.tx(q => f.runtime.commercePorts!.payment!.createOrderAttempt(q, { store: s, orderId: due.order_id, amountMinor: 500, currency: 'TWD', environment: 'sandbox' }));
  const a = (await f.x.h.pool.query('SELECT attempt_id FROM commerce_payment_attempts WHERE order_id=$1', [due.order_id])).rows[0], token = randomBytes(32).toString('base64url');
  await f.x.h.pool.query("INSERT INTO commerce_entry_routes(route_kind,route_key,tenant_id,instance_id,target_id,expires_at) VALUES('payment_handoff',$1,$2,$3,$4,clock_timestamp()+interval '15 minutes')", [hashKey(token), s.tenantId, s.instanceId, a.attempt_id]);
  const r = await page('/pay/ecpay/' + token);
  assert.equal(r.status, 409);
  assert.match(r.html, /付款期限已過，保留的商品已釋出。/);
  assert(r.html.includes('/pay/ecpay/back/' + a.attempt_id));
  await unused(a.attempt_id);
});
for (const actor of ['buyer', 'seller', 'system'] as const)
  for (const handedOff of [false, true])
    test(`${actor} cancellation revokes all tokens and queries only handed-off attempts (${handedOff})`, async () => {
      const p = await f.placed();
      expect(await resume(p), 201);
      if (handedOff) {
        const latest = (await f.x.h.pool.query("SELECT route_key FROM commerce_entry_routes WHERE target_id=$1 AND route_kind='payment_handoff' AND revoked_at IS NULL", [p.payment.attempt_ref])).rows[0];
        assert(latest);
        await f.x.h.pool.query('UPDATE commerce_payment_attempts SET journaled_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1', [p.payment.attempt_ref]);
        await f.x.h.pool.query('UPDATE commerce_payment_attempts SET handed_off_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1', [p.payment.attempt_ref]);
      }
      const reason = { buyer: 'buyer_cancelled', seller: 'seller_cancelled', system: 'payment_not_completed' } as const;
      const cancelled = await f.x.tx(q => cancelUnpaidOrder(q, p.s, p.order.order_ref, actor, reason[actor], f.runtime.commercePorts));
      assert.equal(cancelled.lifecycle_state, 'cancelled');
      assert.equal((await f.x.h.pool.query("SELECT count(*)::int n FROM commerce_entry_routes WHERE target_id=$1 AND route_kind='payment_handoff' AND revoked_at IS NULL", [p.payment.attempt_ref])).rows[0].n, 0);
      assert.equal((await f.x.h.pool.query("SELECT due_at<=clock_timestamp() AS immediate FROM commerce_due_work WHERE kind='payment_query' AND target_id=$1", [p.payment.attempt_ref])).rows[0].immediate, handedOff);
      const due = (await f.x.h.pool.query("SELECT due_at::text FROM commerce_due_work WHERE kind='payment_query' AND target_id=$1", [p.payment.attempt_ref])).rows[0].due_at;
      await f.x.tx(q => cancelUnpaidOrder(q, p.s, p.order.order_ref, actor, reason[actor], f.runtime.commercePorts));
      assert.equal((await f.x.h.pool.query("SELECT due_at::text FROM commerce_due_work WHERE kind='payment_query' AND target_id=$1", [p.payment.attempt_ref])).rows[0].due_at, due);
    });
test('a cancellation hook failure rolls back hold release, token revocation and the order transition', async () => {
  const p = await f.placed(), payment = f.runtime.commercePorts!.payment!;
  await assert.rejects(f.x.tx(q => cancelUnpaidOrder(q, p.s, p.order.order_ref, 'buyer', 'buyer_cancelled', { payment: { ...payment, async onOrdersCancelled(q, ids) { await payment.onOrdersCancelled(q, ids); throw Error('synthetic_hook_failure'); } } })), { message: 'synthetic_hook_failure' });
  await unused(p.payment.attempt_ref);
  assert.equal((await f.x.h.pool.query('SELECT lifecycle_state FROM commerce_checkout_orders WHERE order_id=$1', [p.order.order_ref])).rows[0].lifecycle_state, 'open');
  assert.equal((await f.x.h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1', [p.s.product.product_id])).rows[0].reserved, 5);
});
const buyerOrder = (p: Awaited<ReturnType<typeof f.placed>>) => f.http('GET', f.root(p.s) + '/orders/' + p.order.order_ref, undefined, p.cookie);
test('buyer summaries expose only the latest attempt and agree with token resumption', async () => {
  const p = await f.placed();
  let value = expect(await buyerOrder(p), 200);
  assert.equal(value.payment_state, 'unpaid');
  assert.deepEqual(value.latest_payment_attempt, { attempt_ref: p.payment.attempt_ref, state: 'ready', created_at: (await f.x.h.pool.query('SELECT created_at FROM commerce_payment_attempts WHERE attempt_id=$1', [p.payment.attempt_ref])).rows[0].created_at.toISOString() });
  assert.equal(value.can_resume_payment, true);
  expect(await resume(p), 201);
  const fresh = expect(await resume(p), 201);
  assert.equal((await page(fresh.handoff_url)).status, 200);
  value = expect(await buyerOrder(p), 200);
  assert.equal(value.latest_payment_attempt.state, 'awaiting_result');
  assert.equal(value.can_resume_payment, false);
  const pending=await resume(p);expect(pending,409,'payment_result_pending');assert(Number(pending.response.headers.get('Retry-After'))>0);
  assert.deepEqual(Object.keys(value.latest_payment_attempt).sort(), ['attempt_ref', 'created_at', 'state']);
  for (const field of ['account_id', 'merchant_id', 'trade_no', 'amount_received', 'exceptions', 'credential_version'])
    assert(!JSON.stringify(value).includes(field));
});
for (const state of ['failed', 'expired_unpaid', 'paid', 'confirmed'] as const)
  test(`buyer summary maps ${state} to the closed buyer state vocabulary`, async () => {
    const p = await f.placed();
    if (state === 'confirmed')
      await f.x.h.pool.query("UPDATE commerce_payment_attempts SET state='paid',paid_at=clock_timestamp(),trade_no='SYNTHETIC',payment_date=clock_timestamp(),version=version+1 WHERE attempt_id=$1", [p.payment.attempt_ref]);
    await f.x.h.pool.query(`UPDATE commerce_payment_attempts SET state=$2,${state === 'expired_unpaid' ? 'expired' : state}_at=clock_timestamp(),${state === 'paid' ? "trade_no='SYNTHETIC',payment_date=clock_timestamp()," : ''}version=version+1 WHERE attempt_id=$1`, [p.payment.attempt_ref, state]);
    const value = expect(await buyerOrder(p), 200);
    assert.equal(value.latest_payment_attempt.state, state === 'expired_unpaid' ? 'expired' : state === 'confirmed' ? 'paid' : state);
    assert.equal(value.payment_state, 'unpaid');
    assert.equal(value.can_resume_payment, state==='failed');
    if(state==='failed'){const next=expect(await resume(p),201);assert.notEqual(next.attempt_ref,p.payment.attempt_ref);assert.equal((await f.x.h.pool.query('SELECT sequence FROM commerce_payment_attempts WHERE attempt_id=$1',[next.attempt_ref])).rows[0].sequence,2);}
    else expect(await resume(p), 409);
  });
for (const gate of ['quarantine', 'checkout_off', 'service_suspended', 'admission_revoked', 'keyring_missing'] as const)
  test(`buyer can_resume_payment agrees with the resume endpoint under ${gate}`, async () => {
    const p = await f.placed();
    if (gate === 'quarantine')
      f.settings.quarantine = true;
    if (gate === 'checkout_off')
      f.settings.checkoutEnabled = false;
    if (gate === 'keyring_missing')
      f.install({ commerceCredentialKeyring: null });
    if (gate === 'service_suspended')
      await f.x.tx(async (q) => { await f.runtime.commercePorts!.admission!.allowed(q, p.s); await q.query("UPDATE commerce_provider_account_services SET state='suspended',version=version+1,updated_at=clock_timestamp() WHERE account_id=$1", [p.provider.accountId]); });
    if (gate === 'admission_revoked')
      await f.x.h.pool.query("UPDATE commerce_store_admissions SET revoked_at=clock_timestamp(),revoked_by=(SELECT admin_id FROM platform_admins LIMIT 1),revoke_reason='合成撤銷' WHERE admission_id=$1", [p.provider.admissionId]);
    const value = expect(await buyerOrder(p), 200);
    assert.equal(value.can_resume_payment, false);
    assert.notEqual((await resume(p)).status, 201);
  });
test('the E2E provider fixture refuses non-local installation', async () => {
  const { createE2eEcpayFixture } = await import('../../scripts/e2e-ecpay-fixture.js');
  for (const freedomEnv of ['staging', 'public'] as const)
    assert.throws(() => createE2eEcpayFixture({ freedomEnv, origin: f.origin, pool: f.x.runtime, keyring: f.ring, forward: request => Promise.resolve(f.app.fetch(request)) }), { message: 'payment_fixture_requires_local' });
});
for (const mode of ['paid', 'failed', 'pending', 'simulated', 'delayed'] as const)
  test(`the local provider verifies the handoff and delivers ${mode} without a network client`, async () => {
    const { createE2eEcpayFixture } = await import('../../scripts/e2e-ecpay-fixture.js'), p = await f.placed(), delivered: string[] = [];
    const fixture = createE2eEcpayFixture({ freedomEnv: 'local', origin: f.origin, pool: f.x.runtime, keyring: f.ring, forward: request => { delivered.push(request.url); assert(request.url.startsWith(f.origin + '/api/v1/provider-callbacks/ecpay/')); return Promise.resolve(f.app.fetch(request)); } });
    const handoff = await page(p.payment.handoff_url);
    assert.equal(handoff.status, 200);
    const fields = [...handoff.html.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)].map(m => [m[1], m[2].replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')] as const);
    const postFixture = (path: string, body: string) => fixture.routes.fetch(new Request(f.origin + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }));
    const invalid = fields.map(([key, value]) => [key, key === 'CheckMacValue' ? '0'.repeat(64) : value] as const);
    assert.equal((await postFixture('/__e2e/ecpay/aio-checkout', encodeForm(invalid))).status, 400);
    const checkout = await postFixture('/__e2e/ecpay/aio-checkout', encodeForm(fields));
    assert.equal(checkout.status, 200);
    const html = await checkout.text();
    for (const label of ['付款成功', '付款失敗', '結果待確認', '模擬付款', '付款成功但通知延後', '返回商店'])
      assert(html.includes(label));
    const session = html.match(/name="session" value="([^"]+)"/)![1], result = await postFixture('/__e2e/ecpay/result', encodeForm({ session, mode }));
    assert.equal(result.status, 200);
    assert((await result.text()).includes('/pay/ecpay/return/' + p.provider.accountRef));
    if (mode === 'delayed') {
      assert.equal(delivered.length, 0);
      const flush = await postFixture('/__e2e/ecpay/deliver-pending', '');
      assert.deepEqual(await flush.json(), { delivered: 1 });
    }
    assert.equal(delivered.length, 1);
    const event = (await f.x.h.pool.query('SELECT * FROM commerce_hosted_payment_events')).rows[0];
    assert.equal(event.outcome, mode === 'delayed' ? 'paid' : mode === 'pending' ? 'pending_confirmation' : mode);
    const a = (await f.x.h.pool.query('SELECT state FROM commerce_payment_attempts WHERE attempt_id=$1', [p.payment.attempt_ref])).rows[0];
    assert.equal(a.state, mode === 'paid' || mode === 'delayed' ? 'paid' : mode === 'failed' ? 'failed' : 'issued');
  });


test('review 5: twenty buyer DTO reads never unseal credentials and a handoff unseals once', async () => {
  const p = await f.placed(), original = crypto.createDecipheriv;
  let unseals = 0;
  crypto.createDecipheriv = ((...args: Parameters<typeof original>) => { unseals++; return original(...args); }) as typeof original;
  syncBuiltinESMExports();
  try {
    for (let i = 0; i < 20; i++) {
      const dto = expect(await f.http('GET', f.root(p.s) + '/orders/' + p.order.order_ref, undefined, p.cookie), 200);
      assert.equal(dto.can_resume_payment, true);
    }
    assert.equal(unseals, 0);
    assert.equal((await page(p.payment.handoff_url)).status, 200);
    assert.equal(unseals, 1);
  } finally { crypto.createDecipheriv = original; syncBuiltinESMExports(); }
});

test('review 5: one payment summary cannot mix orders from different stores', async () => {
  const a = await f.placed(), b = await f.placed();
  await assert.rejects(f.x.tx(q => f.runtime.commercePorts!.payment!.summarize(q, [a.order.order_ref, b.order.order_ref])),
    { message: 'payment_summary_scope_invalid' });
});


test('review 6: a cancelled-order replay leaves due-work timestamps and entry routes unchanged', async () => {
  const p = await f.placed();
  assert.equal((await page(p.payment.handoff_url)).status, 200);
  const cancel = () => f.x.tx(q => cancelUnpaidOrder(q, p.s, p.order.order_ref, 'buyer', 'buyer_cancelled', f.runtime.commercePorts));
  const snapshot = async () => ({
    due: (await f.x.h.pool.query('SELECT *,due_at::text AS exact_due,updated_at::text AS exact_updated FROM commerce_due_work WHERE target_id=$1 ORDER BY kind', [p.payment.attempt_ref])).rows,
    routes: (await f.x.h.pool.query("SELECT *,revoked_at::text AS exact_revoked FROM commerce_entry_routes WHERE route_kind='payment_handoff' AND target_id=$1 ORDER BY route_key", [p.payment.attempt_ref])).rows
  });
  const cancelled = await cancel(), before = await snapshot();
  assert.deepEqual(await cancel(), cancelled);
  assert.deepEqual(await snapshot(), before);
});
for(const mode of ['query_unpaid','query_unknown_status','query_amount_mismatch','query_403','query_timeout','query_invalid_signature'] as const)
  test(`local query fixture answers ${mode} without network access`,async()=>{
    const {createE2eEcpayFixture}=await import('../../scripts/e2e-ecpay-fixture.js');
    const {buildTradeInfoQuery,parseTradeInfoResponse}=await import('../../modules/agent-commerce/providers/ecpay/aio-credit/index.js');
    const p=await f.placed(),a=(await f.x.h.pool.query('SELECT * FROM commerce_payment_attempts WHERE attempt_id=$1',[p.payment.attempt_ref])).rows[0],keys=EcpayKeyPair.of(p.provider.material.hash_key,p.provider.material.hash_iv);
    const fixture=createE2eEcpayFixture({freedomEnv:'local',origin:f.origin,pool:f.x.runtime,keyring:f.ring,forward:()=>{throw Error('query_must_not_notify');}});
    const configured=await fixture.routes.fetch(new Request(f.origin+'/__e2e/ecpay/query-mode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({attempt_ref:a.attempt_id,mode})}));assert.equal(configured.status,200);
    const request=buildTradeInfoQuery({environment:'sandbox',merchantId:a.merchant_id,merchantTradeNo:a.merchant_trade_no,timestampSeconds:Math.floor(Date.now()/1000)},keys),response=await fixture.transport.send(request,'sandbox');
    if(mode==='query_timeout')assert.deepEqual(response,{kind:'error',code:'timeout'});
    else {assert.equal(response.kind,'response');if(response.kind!=='response')throw Error('response_missing');assert.equal(response.status,mode==='query_403'?403:200);
      if(response.status===200){const result=parseTradeInfoResponse(response.body,keys,{merchantId:a.merchant_id,merchantTradeNo:a.merchant_trade_no,expectedAmountMinor:Number(a.amount_minor)});assert.equal(result.kind,mode==='query_unpaid'?'unpaid':mode==='query_amount_mismatch'?'amount_mismatch':'unknown');if(result.kind==='unknown')assert.equal(result.reason,mode==='query_invalid_signature'?'mac_mismatch':'unrecognized_status');}
    }
    assert.equal((await f.x.h.pool.query('SELECT count(*)::int n FROM commerce_hosted_payment_events')).rows[0].n,0);
    const unsigned=buildTradeInfoQuery({environment:'sandbox',merchantId:a.merchant_id,merchantTradeNo:a.merchant_trade_no,timestampSeconds:Math.floor(Date.now()/1000)-181},keys);
    assert.deepEqual(await fixture.transport.send(unsigned,'sandbox'),{kind:'response',status:403,body:''});
    const wrong=buildTradeInfoQuery({environment:'sandbox',merchantId:a.merchant_id,merchantTradeNo:a.merchant_trade_no,timestampSeconds:Math.floor(Date.now()/1000)},EcpayKeyPair.of(randomBytes(8).toString('hex'),randomBytes(8).toString('hex')));
    assert.deepEqual(await fixture.transport.send(wrong,'sandbox'),{kind:'response',status:403,body:''});
  });
test('paid without notification is discovered only through the local query transport',async()=>{
  const {createE2eEcpayFixture}=await import('../../scripts/e2e-ecpay-fixture.js');
  const {queryAttempt}=await import('../../modules/agent-commerce/payments/queries.js');
  const p=await f.placed(),fixture=createE2eEcpayFixture({freedomEnv:'local',origin:f.origin,pool:f.x.runtime,keyring:f.ring,forward:()=>{throw Error('must_not_notify');}}),handoff=await page(p.payment.handoff_url);
  const fields=[...handoff.html.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)].map(m=>[m[1],m[2].replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&')] as const);
  const post=(path:string,body:string)=>fixture.routes.fetch(new Request(f.origin+path,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body}));
  const checkout=await post('/__e2e/ecpay/aio-checkout',encodeForm(fields)),session=(await checkout.text()).match(/name="session" value="([^"]+)"/)![1];
  const result=await post('/__e2e/ecpay/result',encodeForm({session,mode:'paid_no_notify'}));assert.equal(result.status,200);
  assert.equal((await f.x.h.pool.query('SELECT count(*)::int n FROM commerce_hosted_payment_events')).rows[0].n,0);
  assert.equal((await queryAttempt(f.x.runtime,p.payment.attempt_ref,{transport:fixture.transport,keyring:f.ring,freedomEnv:'local'},'buyer')).status,'paid');
  assert.equal((await f.x.h.pool.query('SELECT state FROM commerce_payment_attempts WHERE attempt_id=$1',[p.payment.attempt_ref])).rows[0].state,'confirmed');
});
