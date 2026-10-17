import { applyDeferredPaymentEvents } from '../../modules/agent-commerce/payments/events.js';
import assert from 'node:assert/strict';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { before, after, beforeEach, test } from 'node:test';
import type { PoolClient } from 'pg';
import { hostedPaymentHarness } from '../e2e/hosted-payment-fixture.js';
import { EcpayKeyPair, encodeForm, signFields, newTradeNumber } from '../../modules/agent-commerce/providers/ecpay/index.js';
import { sealCredential } from '../../modules/agent-commerce/payments/credentials.js';
import { bindStore, lockMachineOrder } from '../../modules/agent-commerce/checkout/authority.js';
import { cancelUnpaidOrder, lockCheckoutOrders } from '../../modules/agent-commerce/checkout/orders.js';
import { scheduleDueWork } from '../../modules/agent-commerce/operations/due-work.js';
import { resolvePaymentReturn } from '../../modules/agent-commerce/payments/browser-return.js';
import { publicOrder } from '../../modules/agent-commerce/checkout/public-order.js';
import { formatTaipeiDateTime } from '../../modules/agent-commerce/providers/ecpay/aio-credit/index.js';
import { settleDueCheckoutHolds, sweepDueCheckoutHolds } from '../../modules/agent-commerce/checkout/settlement.js';
import { isCommerceProviderEntry } from '../../modules/agent-commerce/operations/provider-entry-paths.js';
import { COMMERCE_LIMITS } from '../../modules/agent-commerce/checkout/limits.js';
import { hashKey } from '../../modules/agent-commerce/checkout/terms.js';
let f: Awaited<ReturnType<typeof hostedPaymentHarness>>;
type Placed = Awaited<ReturnType<typeof f.placed>>;
before(async () => { f = await hostedPaymentHarness('fp_payment_notifications'); });
beforeEach(async () => f.reset());
after(async () => f?.stop());
async function body(p: Placed, overrides: Record<string, string> = {}, material = p.provider.material) {
  const a = (await f.x.h.pool.query('SELECT merchant_trade_no FROM commerce_payment_attempts WHERE attempt_id=$1', [p.payment.attempt_ref])).rows[0];
  return encodeForm(signFields({ MerchantID: '1234567', MerchantTradeNo: a.merchant_trade_no, TradeNo: 'T' + randomBytes(8).toString('hex').toUpperCase(), RtnCode: '1', RtnMsg: '合成付款結果', TradeAmt: '5', SimulatePaid: '0', PaymentDate: '2026/10/15 10:20:30', PaymentType: 'Credit_CreditCard', PaymentTypeChargeFee: '0.3', gwsr: '12345', card6no: String(randomInt(1000000)).padStart(6, '0'), card4no: String(randomInt(10000)).padStart(4, '0'), auth_code: randomBytes(3).toString('hex'), ...overrides }, EcpayKeyPair.of(material.hash_key, material.hash_iv), 'sha256'));
}
const path = (p: Placed) => '/api/v1/provider-callbacks/ecpay/' + p.provider.accountRef + '/payment';
async function post(url: string, value: string | ReadableStream<Uint8Array>, headers: Record<string, string> = {}, method = 'POST') {
  const request = new Request(f.origin + url, { method, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '192.0.2.1', ...headers }, ...(method === 'GET' || method === 'HEAD' ? {} : { body: value, ...(typeof value === 'string' ? {} : { duplex: 'half' }) }) } as RequestInit);
  Object.defineProperty(request, 'cf', { value: { colo: 'TEST' } });
  const response = await f.app.fetch(request);
  return { response, status: response.status, text: await response.text() };
}
async function facts(p: Placed) { return { attempt: (await f.x.h.pool.query('SELECT * FROM commerce_payment_attempts WHERE attempt_id=$1', [p.payment.attempt_ref])).rows[0], events: (await f.x.h.pool.query('SELECT * FROM commerce_hosted_payment_events ORDER BY received_at,event_id')).rows, applications: (await f.x.h.pool.query('SELECT * FROM commerce_checkout_payment_applications ORDER BY created_at,application_id')).rows, cases: (await f.x.h.pool.query('SELECT * FROM commerce_exception_cases ORDER BY created_at,case_id')).rows }; }
const count = async (table: string) => (await f.x.h.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n;
async function ack(result: Awaited<ReturnType<typeof post>>) { assert.equal(result.status, 200, result.text); assert.equal(result.text, '1|OK'); assert.match(result.response.headers.get('Content-Type')!, /^text\/plain/); assert.equal(result.response.headers.get('Set-Cookie'), null); }
for (const variant of ['member', 'buyer', 'foreign_origin', 'no_origin'] as const)
  test(`signed callback ignores ${variant} browser authority and returns identical acknowledgement`, async () => {
    const p = await f.placed(), headers: Record<string, string> = {};
    if (variant === 'member')
      headers.Cookie = p.s.owner.cookie;
    if (variant === 'buyer')
      headers.Cookie = p.cookie;
    if (variant === 'foreign_origin')
      headers.Origin = 'https://foreign.test';
    await ack(await post(path(p), await body(p), headers));
    const actual = await facts(p);
    assert.equal(actual.attempt.state, 'paid');
    assert.equal(actual.applications[0].outcome, 'converted');
    assert(actual.events[0].applied_at);
    assert.equal(actual.events[0].credential_version, 1);
    assert.equal(actual.attempt.trade_no, actual.events[0].trade_no);
    assert.equal(actual.attempt.charge_fee_minor, '30');
    assert.equal(actual.attempt.gwsr, '12345');
  });
test('only exact signed POST paths bypass the browser gate; other provider methods and paths are 404', async () => {
  const p = await f.placed();
  assert(isCommerceProviderEntry('POST', path(p)));
  assert(isCommerceProviderEntry('POST', '/pay/ecpay/return/' + p.provider.accountRef));
  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'])
    for (const url of [path(p), '/pay/ecpay/return/' + p.provider.accountRef]) {
      assert(!isCommerceProviderEntry(method, url));
      assert.equal((await post(url, '', {}, method)).status, 404);
    }
  for (const url of [path(p) + '/', path(p) + '/extra', path(p).replace(p.provider.accountRef, p.provider.accountRef.toUpperCase()), '/api/v1/provider-callbacks/ecpay/invalid/payment', '/pay/ecpay/return/invalid'])
    assert.equal((await post(url, '')).status, 404);
  assert.equal(await count('commerce_hosted_payment_events'), 0);
  const wrongHost = new Request('https://other.test' + path(p), { method: 'POST', body: await body(p), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal((await f.app.fetch(wrongHost)).status, 403);
});
for (const format of ['json', 'duplicate', 'case_duplicate', 'invalid_name', 'invalid_utf8', 'empty', 'stream_oversize'] as const)
  test(`callback refuses ${format} with 400 and no inbox effect`, async () => {
    const p = await f.placed();
    let data: string | ReadableStream<Uint8Array> = await body(p);
    const headers: Record<string, string> = {};
    if (format === 'json')
      headers['Content-Type'] = 'application/json';
    if (format === 'duplicate')
      data += '&MerchantID=1234567';
    if (format === 'case_duplicate')
      data += '&merchantid=1234567';
    if (format === 'invalid_name')
      data += '&bad-name=x';
    if (format === 'empty')
      data = '';
    if (format === 'invalid_utf8')
      data = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([255])); c.close(); } });
    if (format === 'stream_oversize') {
      let chunks = 0;
      data = new ReadableStream({
        pull(c) {
          c.enqueue(new Uint8Array(4096).fill(65)); if (++chunks === 5)
            c.close();
        }
      });
      headers['Content-Length'] = '1';
    }
    const r = await post(path(p), data, headers);
    assert.equal(r.status, 400, r.text);
    assert.equal(r.text, '0|invalid');
    assert.equal(await count('commerce_hosted_payment_events'), 0);
    assert.equal((await facts(p)).attempt.state, 'issued');
  });
test('a charset parameter is accepted without changing verification of the original bytes', async () => { const p = await f.placed(); await ack(await post(path(p), await body(p), { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' })); });
test('unknown references are empty 404s, with only the unknown-network budget', async () => {
  const p = await f.placed(), url = '/api/v1/provider-callbacks/ecpay/' + '0'.repeat(26) + '/payment', value = await body(p);
  const first = await post(url, value);
  assert.equal(first.status, 404);
  assert.equal(first.text, '');
  await f.x.h.pool.query('UPDATE auth_rate_limits SET attempts=$2 WHERE bucket=$1', ['commerce:providerUnknownNetwork:' + hashKey('192.0.2.1'), COMMERCE_LIMITS.providerUnknownNetwork.limit]);
  const limited = await post(url, value);
  assert.equal(limited.status, 429);
  assert.match(limited.text, /^0\|/);
  assert(Number(limited.response.headers.get('Retry-After')) > 0);
  await ack(await post(path(p), value));
  assert.equal((await f.x.h.pool.query("SELECT count(*)::int n FROM auth_rate_limits WHERE bucket LIKE 'commerce:providerAccount:%'")).rows[0].n, 1);
});
test('known-account and network budget is 600 per minute and returns text 429', async () => {
  const p = await f.placed();
  await f.x.h.pool.query('INSERT INTO auth_rate_limits(bucket,window_start,attempts) VALUES($1,clock_timestamp(),$2)', ['commerce:providerAccount:' + hashKey(p.provider.accountId + ':198.51.100.2'), 600]);
  const r = await post(path(p), await body(p), { 'CF-Connecting-IP': '198.51.100.2' });
  assert.equal(r.status, 429);
  assert(Number(r.response.headers.get('Retry-After')) > 0);
  assert.equal(await count('commerce_hosted_payment_events'), 0);
});
test('missing keyring asks the provider to retry with 503, without storing anything', async () => { const p = await f.placed(); f.install({ commerceCredentialKeyring: null }); const r = await post(path(p), await body(p)); assert.equal(r.status, 503); assert.equal(await count('commerce_hosted_payment_events'), 0); });
for (const invalid of ['signature', 'merchant', 'platform', 'foreign_account'] as const)
  test(`callback rejects ${invalid} and logs only a fixed reason/account`, async () => {
    const p = await f.placed();
    let url = path(p), value = await body(p), logs: string[] = [];
    if (invalid === 'signature')
      value = value.replace(/CheckMacValue=[A-Fa-f0-9]+/, 'CheckMacValue=' + '0'.repeat(64));
    if (invalid === 'merchant')
      value = await body(p, { MerchantID: '7654321' });
    if (invalid === 'platform')
      value = await body(p, { PlatformID: '1234567' });
    if (invalid === 'foreign_account') {
      const other = await f.x.store();
      const provider = await f.setup(other);
      url = '/api/v1/provider-callbacks/ecpay/' + provider.accountRef + '/payment';
    }
    const warn = console.warn;
    console.warn = (...args) => { logs.push(args.join(' ')); };
    let r;
    try {
      r = await post(url, value);
    }
    finally {
      console.warn = warn;
    }
    assert.equal(r.status, 400, r.text);
    assert.equal(r.text, '0|invalid');
    assert.equal(await count('commerce_hosted_payment_events'), 0);
    assert.equal(logs.length, 1);
    const log = JSON.parse(logs[0]);
    assert.equal(log.event, 'provider_callback_invalid');
    assert.match(log.account, /^[0-9a-f-]{36}$/);
    assert.match(log.reason, /^[a-z0-9_]+$/);
    assert.deepEqual(Object.keys(log).sort(), ['account', 'event', 'reason']);
  });
for (const outcome of ['failed', 'pending_confirmation', 'simulated', 'amount_mismatch'] as const)
  test(`${outcome} keeps the prescribed attempt, application, exception and schedule`, async () => {
    const p = await f.placed();
    const overrides: Record<string, string> = outcome === 'failed' ? { RtnCode: '0' } : outcome === 'pending_confirmation' ? { RtnCode: '10300066' } : outcome === 'simulated' ? { SimulatePaid: '1' } : { TradeAmt: '6' };
    await ack(await post(path(p), await body(p, overrides)));
    const r = await facts(p);
    assert.equal(r.events[0].outcome, outcome === 'amount_mismatch' ? 'paid' : outcome);
    assert(r.events[0].applied_at);
    assert.equal(r.attempt.state, outcome === 'failed' ? 'failed' : 'issued');
    assert.equal(r.attempt.trade_no, null);
    assert.deepEqual(r.applications.map(a => a.outcome), outcome === 'simulated' ? ['simulated'] : outcome === 'amount_mismatch' ? ['amount_mismatch'] : []);
    assert.deepEqual(r.cases.map(c => c.kind), outcome === 'amount_mismatch' ? ['amount_mismatch'] : []);
    const due = (await f.x.h.pool.query("SELECT w.due_at<=clock_timestamp() AS immediate FROM commerce_due_work w WHERE kind='payment_query' AND target_id=$1", [p.payment.attempt_ref])).rows[0];
    if(outcome==='amount_mismatch')assert.equal(due,undefined);
    else assert.equal(due.immediate, outcome === 'pending_confirmation');
    assert.equal((await f.x.h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1', [p.s.product.product_id])).rows[0].reserved, 5);
  });
test('notification dedupe is sequential, concurrent and insensitive to trade-number case', async () => {
  const p = await f.placed(), value = await body(p);
  await Promise.all([post(path(p), value).then(ack), post(path(p), value).then(ack)]);
  await ack(await post(path(p), value));
  const lower = value.replace(/MerchantTradeNo=([^&]+)/, (_m, v) => 'MerchantTradeNo=' + v.toLowerCase()).replace(/TradeNo=([^&]+)/, (_m, v) => 'TradeNo=' + v.toLowerCase());
  await ack(await post(path(p), lower));
  const r = await facts(p);
  assert.equal(r.events.length, 1);
  assert.equal(r.applications.length, 1);
  assert.equal(r.attempt.state, 'paid');
  assert.equal(r.attempt.version, '2');
});
test('failure followed by payment advances to paid; a later failure opens one contradicting case', async () => {
  const p = await f.placed();
  await ack(await post(path(p), await body(p, { RtnCode: '0' })));
  assert.equal((await facts(p)).attempt.state, 'failed');
  await ack(await post(path(p), await body(p)));
  const paid = (await facts(p)).attempt;
  await ack(await post(path(p), await body(p, { RtnCode: '0' })));
  const r = await facts(p);
  assert.equal(r.attempt.state, 'paid');
  assert.deepEqual(r.attempt, paid);
  assert.equal(r.applications.length, 1);
  assert.deepEqual(r.cases.map(c => c.kind), ['contradicting_event']);
});
test('an unmatched verified trade opens an event case and is acknowledged once', async () => {
  const p = await f.placed(), value = await body(p, { MerchantTradeNo: newTradeNumber('F') });
  await ack(await post(path(p), value));
  await ack(await post(path(p), value));
  const r = await facts(p);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].attempt_id, null);
  assert(r.events[0].applied_at);
  assert.equal(r.cases[0].kind, 'unmatched_payment');
  assert.equal(r.cases[0].subject_kind, 'payment_event');
  assert.equal(r.cases[0].order_id, null);
  assert.equal(r.attempt.state, 'issued');
});
test('quarantine acknowledges the verified event and leaves it unapplied', async () => { const p = await f.placed(); f.settings.quarantine = true; await ack(await post(path(p), await body(p))); const r = await facts(p); assert.equal(r.events[0].applied_at, null); assert.equal(r.attempt.state, 'issued'); assert.equal(r.applications.length, 0); });
test('a forced commit failure returns 500 and rolls back the inbox, attempt and inventory', async () => {
  const p = await f.placed(), connect = f.x.runtime.connect;
  let refused = false;
  f.x.runtime.connect = (async () => {
    const q = await (connect as () => Promise<PoolClient>).call(f.x.runtime), query = q.query, release = q.release;
    let applying = false;
    q.query = (async (...args: unknown[]) => {
      if (String(args[0]).startsWith('INSERT INTO commerce_hosted_payment_events'))
        applying = true; if (applying && args[0] === 'COMMIT') {
          refused = true;
          throw Error('synthetic_commit_failure');
        } return (query as Function).apply(q, args);
    }) as typeof q.query;
    q.release = (error?: Error | boolean) => { q.query = query; q.release = release; release.call(q, error); };
    return q;
  }) as typeof f.x.runtime.connect;
  let r;
  try {
    r = await post(path(p), await body(p));
  }
  finally {
    f.x.runtime.connect = connect;
  }
  assert(refused);
  assert.equal(r.status, 500);
  assert.notEqual(r.text, '1|OK');
  const actual = await facts(p);
  assert.equal(actual.events.length, 0);
  assert.equal(actual.attempt.state, 'issued');
  assert.equal(actual.applications.length, 0);
  assert.equal((await f.x.h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1', [p.s.product.product_id])).rows[0].reserved, 5);
});
async function rotate(p: Placed) {
  const material = { hash_key: randomBytes(8).toString('hex'), hash_iv: randomBytes(8).toString('hex'), credit_check_code: String(randomInt(100000000)).padStart(8, '0') };
  const sealed = sealCredential(f.ring, { account_id: p.provider.accountId, purpose: 'payment', environment: 'sandbox', credential_version: 2 }, material);
  await f.x.tx(async (q) => {
    await bindStore(q, p.s.tenantId);
    await q.query(`INSERT INTO commerce_provider_credentials(account_id,purpose,credential_version,tenant_id,instance_id,environment,key_id,sealed,created_by_principal_id)
      SELECT account_id,'payment',2,tenant_id,instance_id,environment,$2,$3,created_by_principal_id FROM commerce_provider_accounts WHERE account_id=$1`, [p.provider.accountId, sealed.key_id, sealed.sealed]);
    await q.query("UPDATE commerce_provider_account_services SET credential_version=2,version=version+1,updated_at=clock_timestamp() WHERE account_id=$1 AND purpose='payment'", [p.provider.accountId]);
  });
  return material;
}
async function anotherAttempt(p: Placed, credentialVersion = 1, kind: 'order' | 'service_activation' = 'order') {
  if (kind === 'order')
    await f.x.h.pool.query("UPDATE commerce_payment_attempts SET state='superseded',superseded_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1 AND state='issued'", [p.payment.attempt_ref]);
  const a = (await f.x.h.pool.query(`INSERT INTO commerce_payment_attempts(tenant_id,instance_id,kind,order_id,sequence,account_id,environment,merchant_id,credential_version,merchant_trade_no,amount_minor,currency)
    SELECT tenant_id,instance_id,$2,CASE WHEN $2='order' THEN order_id ELSE NULL END,2,account_id,environment,merchant_id,$3,$4,amount_minor,currency FROM commerce_payment_attempts WHERE attempt_id=$1 RETURNING attempt_id`, [p.payment.attempt_ref, kind, credentialVersion, newTradeNumber('F')])).rows[0];
  return { ...p, payment: { ...p.payment, attempt_ref: a.attempt_id } } as Placed;
}
test('old unretired keys still verify their attempt after rotation, and newer keys may verify it too', async () => {
  const p = await f.placed(), material = await rotate(p);
  await ack(await post(path(p), await body(p)));
  assert.equal((await facts(p)).events[0].credential_version, 1);
  await ack(await post(path(p), await body(p, {}, material)));
  const r = await facts(p);
  assert.equal(r.events[1].credential_version, 2);
  assert.equal(r.applications.length, 1);
});
test('a credential older than the attempt and a retired credential are refused without an event', async () => {
  const p = await f.placed();
  await rotate(p);
  const newer = await anotherAttempt(p, 2);
  assert.equal((await post(path(p), await body(newer))).status, 400);
  assert.equal(await count('commerce_hosted_payment_events'), 0);
  await f.x.tx(async (q) => { await bindStore(q, p.s.tenantId); await q.query("UPDATE commerce_provider_credentials SET retired_at=clock_timestamp() WHERE account_id=$1 AND purpose='payment' AND credential_version=1", [p.provider.accountId]); });
  assert.equal((await post(path(p), await body(p))).status, 400);
  assert.equal(await count('commerce_hosted_payment_events'), 0);
});
for (const state of ['superseded', 'expired_unpaid', 'failed', 'confirmed'] as const)
  test(`paid notification safely handles an attempt already ${state}`, async () => {
    const p = await f.placed();
    if (state === 'confirmed') {
      await ack(await post(path(p), await body(p)));
      await f.x.h.pool.query("UPDATE commerce_payment_attempts SET state='confirmed',confirmed_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1", [p.payment.attempt_ref]);
    }
    else
      await f.x.h.pool.query(`UPDATE commerce_payment_attempts SET state=$2,${state === 'expired_unpaid' ? 'expired' : state}_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1`, [p.payment.attempt_ref, state]);
    await ack(await post(path(p), await body(p)));
    const r = await facts(p);
    assert.equal(r.attempt.state, state === 'confirmed' ? 'confirmed' : 'paid');
    assert.equal(r.applications.length, 1);
    if (state === 'confirmed') {
      await ack(await post(path(p), await body(p, { RtnCode: '0' })));
      assert.equal((await facts(p)).cases[0].kind, 'contradicting_event');
    }
  });
test('a second paid attempt is retained as overpaid without allocating twice', async () => {
  const p = await f.placed(), second = await anotherAttempt(p);
  await ack(await post(path(p), await body(p)));
  await ack(await post(path(p), await body(second)));
  const r = await facts(p);
  assert.deepEqual(r.applications.map(a => a.outcome), ['converted', 'overpaid']);
  assert.equal(r.cases[0].kind, 'overpaid');
  assert.equal(r.cases[0].subject_id, second.payment.attempt_ref);
  assert.equal((await f.x.h.pool.query('SELECT count(*)::int n FROM commerce_inventory_allocations')).rows[0].n, 1);
});
test('activation receipt only marks the attempt paid and schedules confirmation', async () => {
  const p = await f.placed(), activation = await anotherAttempt(p, 1, 'service_activation');
  await ack(await post(path(p), await body(activation)));
  assert.equal((await facts(activation)).attempt.state, 'paid');
  assert.equal(await count('commerce_checkout_payment_applications'), 0);
  assert.equal((await f.x.h.pool.query("SELECT due_at<=clock_timestamp() AS due FROM commerce_due_work WHERE kind='payment_query' AND target_id=$1", [activation.payment.attempt_ref])).rows[0].due, true);
});
test('provider facts outside the storage allowlist are discarded after signature verification', async () => {
  const p = await f.placed();
  await ack(await post(path(p), await body(p, { PaymentType: '合成未知付款方式', RtnMsg: '合成不可留存訊息', auth_code: 'SYNTHETIC_AUTH' })));
  const r = await facts(p);
  assert.equal(r.events[0].payment_type, null);
  assert.equal(r.attempt.payment_type, null);
  const text = JSON.stringify(r);
  assert(!text.includes('合成未知付款方式'));
  assert(!text.includes('合成不可留存訊息'));
  assert(!text.includes('SYNTHETIC_AUTH'));
});
for (const order of ['cancel_first', 'payment_first'] as const)
  test(`notification and cancellation serialize with ${order}`, async () => {
    const p = await f.placed(), value = await body(p);
    if (order === 'cancel_first') {
      let release!: () => void, ready!: () => void;
      const held = new Promise<void>(r => release = r), started = new Promise<void>(r => ready = r);
      const cancellation = f.x.tx(async (q) => { await cancelUnpaidOrder(q, p.s, p.order.order_ref, 'buyer', 'buyer_cancelled', f.runtime.commercePorts); ready(); await held; });
      await started;
      const notification = post(path(p), value);
      release();
      await cancellation;
      await ack(await notification);
      const r = await facts(p);
      assert.equal(r.applications[0].outcome, 'after_cancel');
      assert.equal(r.cases[0].kind, 'paid_after_cancel');
    }
    else {
      await ack(await post(path(p), value));
      await assert.rejects(f.x.tx(q => cancelUnpaidOrder(q, p.s, p.order.order_ref, 'buyer', 'buyer_cancelled', f.runtime.commercePorts)), e => (e as {
        code?: string;
      }).code === 'payment_already_applied');
      assert.equal((await facts(p)).cases.length, 0);
    }
  });
for (const order of ['expiry_first', 'payment_first'] as const)
  test(`notification and expired-hold settlement serialize with ${order}`, async () => {
    const s = await f.x.store(100), provider = await f.setup(s), due = await f.x.due(s);
    await f.x.tx(q => f.runtime.commercePorts!.payment!.createOrderAttempt(q, { store: s, orderId: due.order_id, amountMinor: 500, currency: 'TWD', environment: 'sandbox' }));
    const attempt = (await f.x.h.pool.query('SELECT attempt_id FROM commerce_payment_attempts WHERE order_id=$1', [due.order_id])).rows[0];
    const p = { s, provider, order: { order_ref: due.order_id }, payment: { attempt_ref: attempt.attempt_id } } as Placed;
    if (order === 'expiry_first')
      await f.x.tx(q => settleDueCheckoutHolds(q, [s.product.product_id]));
    await ack(await post(path(p), await body(p)));
    if (order === 'payment_first')
      await f.x.tx(q => settleDueCheckoutHolds(q, [s.product.product_id]));
    const r = await facts(p);
    assert.equal(r.applications[0].outcome, order === 'expiry_first' ? 'allocated' : 'converted');
    assert.equal(r.attempt.state, 'paid');
    assert.equal(r.cases.length, 0);
  });
test('late payment with unavailable inventory opens paid_unallocatable without a partial allocation', async () => {
  const p = await f.placed();
  await f.x.tx(async (q) => { await q.query("UPDATE commerce_inventory_reservations SET state='released',released_at=clock_timestamp() WHERE order_id=$1", [p.order.order_ref]); await q.query('UPDATE commerce_items SET reserved=0,stock=0 WHERE item_id=$1', [p.s.product.product_id]); });
  await ack(await post(path(p), await body(p)));
  const r = await facts(p);
  assert.equal(r.attempt.state, 'paid');
  assert.equal(r.applications[0].outcome, 'unallocatable');
  assert.equal(r.cases[0].kind, 'paid_unallocatable');
  assert.equal(await count('commerce_inventory_allocations'), 0);
});
const signal = () => { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; };
for (const competitor of ['cancellation', 'expiry'] as const)
  test(`a notification holds its commit while concurrent ${competitor} waits on the same community lock`, async () => {
    let p: Placed;
    if (competitor === 'cancellation')
      p = await f.placed();
    else {
      const s = await f.x.store(100), provider = await f.setup(s), due = await f.x.due(s);
      await f.x.tx(q => f.runtime.commercePorts!.payment!.createOrderAttempt(q, { store: s, orderId: due.order_id, amountMinor: 500, currency: 'TWD', environment: 'sandbox' }));
      const a = (await f.x.h.pool.query('SELECT attempt_id FROM commerce_payment_attempts WHERE order_id=$1', [due.order_id])).rows[0];
      p = { s, provider, order: { order_ref: due.order_id }, payment: { attempt_ref: a.attempt_id } } as Placed;
    }
    const value = await body(p), atCommit = signal(), competing = signal(), releaseCommit = signal(), connect = f.x.runtime.connect;
    let paused = false;
    f.x.runtime.connect = (async () => {
      const q = await (connect as () => Promise<PoolClient>).call(f.x.runtime), query = q.query, release = q.release;
      let receipt = false;
      q.query = (async (...args: unknown[]) => {
        if (String(args[0]).startsWith('INSERT INTO commerce_hosted_payment_events'))
          receipt = true;
        if (receipt && args[0] === 'COMMIT') {
          paused = true;
          atCommit.resolve();
          await releaseCommit.promise;
        }
        if (!receipt && paused && String(args[0]).startsWith('SELECT pg_advisory_xact_lock') && String((args[1] as unknown[])?.[0]).startsWith('commerce-orders/'))
          competing.resolve();
        return (query as Function).apply(q, args);
      }) as typeof q.query;
      q.release = (error?: Error | boolean) => { q.query = query; q.release = release; release.call(q, error); };
      return q;
    }) as typeof f.x.runtime.connect;
    try {
      const notification = post(path(p), value);
      await atCommit.promise;
      const other = f.x.tx(async (q) => competitor === 'cancellation' ? cancelUnpaidOrder(q, p.s, p.order.order_ref, 'buyer', 'buyer_cancelled', f.runtime.commercePorts) : settleDueCheckoutHolds(q, [p.s.product.product_id])).then(result => ({ result, error: null }), error => ({ result: null, error }));
      await competing.promise;
      releaseCommit.resolve();
      await ack(await notification);
      const completed = await other;
      if (competitor === 'cancellation')
        assert.equal(completed.error?.code, 'payment_already_applied');
      else {
        assert.equal(completed.error, null);
        assert.equal(completed.result, 0);
      }
      assert.equal((await facts(p)).applications[0].outcome, 'converted');
    }
    finally {
      releaseCommit.resolve();
      f.x.runtime.connect = connect;
    }
  });
for (const competitor of ['cancellation', 'expiry'] as const)
  test(`a concurrent notification waits until ${competitor} commits first`, async () => {
    let p: Placed;
    if (competitor === 'cancellation')
      p = await f.placed();
    else {
      const s = await f.x.store(100), provider = await f.setup(s), due = await f.x.due(s);
      await f.x.tx(q => f.runtime.commercePorts!.payment!.createOrderAttempt(q, { store: s, orderId: due.order_id, amountMinor: 500, currency: 'TWD', environment: 'sandbox' }));
      const a = (await f.x.h.pool.query('SELECT attempt_id FROM commerce_payment_attempts WHERE order_id=$1', [due.order_id])).rows[0];
      p = { s, provider, order: { order_ref: due.order_id }, payment: { attempt_ref: a.attempt_id } } as Placed;
    }
    const value = await body(p), ready = signal(), releaseFirst = signal(), inserted = signal(), connect = f.x.runtime.connect;
    const first = f.x.tx(async (q) => {
      if (competitor === 'cancellation')
        await cancelUnpaidOrder(q, p.s, p.order.order_ref, 'buyer', 'buyer_cancelled', f.runtime.commercePorts);
      else
        await settleDueCheckoutHolds(q, [p.s.product.product_id]); ready.resolve(); await releaseFirst.promise;
    });
    await ready.promise;
    f.x.runtime.connect = (async () => {
      const q = await (connect as () => Promise<PoolClient>).call(f.x.runtime), query = q.query, release = q.release;
      q.query = (async (...args: unknown[]) => {
        const result = await (query as Function).apply(q, args); if (String(args[0]).startsWith('INSERT INTO commerce_hosted_payment_events'))
          inserted.resolve(); return result;
      }) as typeof q.query;
      q.release = (error?: Error | boolean) => { q.query = query; q.release = release; release.call(q, error); };
      return q;
    }) as typeof f.x.runtime.connect;
    try {
      const notification = post(path(p), value);
      await inserted.promise;
      releaseFirst.resolve();
      await first;
      await ack(await notification);
      const r = await facts(p);
      assert.equal(r.applications[0].outcome, competitor === 'cancellation' ? 'after_cancel' : 'allocated');
      assert.deepEqual(r.cases.map(c => c.kind), competitor === 'cancellation' ? ['paid_after_cancel'] : []);
    }
    finally {
      releaseFirst.resolve();
      f.x.runtime.connect = connect;
    }
  });
const returnPath = (p: Placed) => '/pay/ecpay/return/' + p.provider.accountRef;
for (const variant of ['member', 'buyer', 'foreign_origin', 'no_origin'] as const)
  test(`browser return ignores ${variant}, records a hint and redirects without changing payment or inventory`, async () => {
    const p = await f.placed(), before = (await facts(p)).attempt, headers: Record<string, string> = {};
    if (variant === 'member')
      headers.Cookie = p.s.owner.cookie;
    if (variant === 'buyer')
      headers.Cookie = p.cookie;
    if (variant === 'foreign_origin')
      headers.Origin = 'https://foreign.test';
    const r = await post(returnPath(p), await body(p), headers);
    assert.equal(r.status, 303, r.text);
    assert.equal(r.response.headers.get('Location'), `/shops/${p.s.slug}/payment-return/${p.payment.attempt_ref}`);
    assert.equal(r.response.headers.get('Set-Cookie'), null);
    assert.equal(r.response.headers.get('Cache-Control'), 'no-store');
    assert.equal(r.response.headers.get('Referrer-Policy'), 'no-referrer');
    const actual = await facts(p);
    assert.deepEqual(actual.attempt, before);
    assert.equal(actual.applications.length, 0);
    assert.equal(actual.cases.length, 0);
    assert.equal(actual.events[0].source, 'browser_return');
    assert.equal(actual.events[0].outcome, 'returned');
    assert(actual.events[0].applied_at);
    assert.equal(actual.events[0].dedupe_key, null);
    assert.match(actual.events[0].body_sha256, /^[a-f0-9]{64}$/);
    assert.equal((await f.x.h.pool.query("SELECT due_at<=clock_timestamp() AS immediate FROM commerce_due_work WHERE kind='payment_query' AND target_id=$1", [p.payment.attempt_ref])).rows[0].immediate, true);
    assert.equal((await f.x.h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1', [p.s.product.product_id])).rows[0].reserved, 5);
  });
test('return query budget permits one schedule per attempt per minute and retains one hint', async () => {
  const p = await f.placed(), value = await body(p);
  assert.equal((await post(returnPath(p), value)).status, 303);
  const first = (await f.x.h.pool.query("SELECT updated_at::text,due_at::text FROM commerce_due_work WHERE kind='payment_query' AND target_id=$1", [p.payment.attempt_ref])).rows[0];
  assert.equal((await post(returnPath(p), value)).status, 303);
  assert.deepEqual((await f.x.h.pool.query("SELECT updated_at::text,due_at::text FROM commerce_due_work WHERE kind='payment_query' AND target_id=$1", [p.payment.attempt_ref])).rows[0], first);
  assert.equal(await count('commerce_hosted_payment_events'), 1);
  await f.x.h.pool.query("UPDATE auth_rate_limits SET window_start=clock_timestamp()-interval '61 seconds' WHERE bucket=$1", ['commerce:paymentReturnQuery:' + hashKey(p.payment.attempt_ref)]);
  assert.equal((await post(returnPath(p), value)).status, 303);
  assert.notEqual((await f.x.h.pool.query("SELECT updated_at::text FROM commerce_due_work WHERE kind='payment_query' AND target_id=$1", [p.payment.attempt_ref])).rows[0].updated_at, first.updated_at);
});
for (const reason of ['unknown_account', 'unknown_trade', 'invalid_signature', 'wrong_merchant', 'platform'] as const)
  test(`browser return ${reason} redirects to the root with no data`, async () => {
    const p = await f.placed();
    let url = returnPath(p), value = await body(p);
    if (reason === 'unknown_account')
      url = '/pay/ecpay/return/' + '0'.repeat(26);
    if (reason === 'unknown_trade')
      value = await body(p, { MerchantTradeNo: newTradeNumber('F') });
    if (reason === 'invalid_signature')
      value = value.replace(/CheckMacValue=[A-Fa-f0-9]+/, 'CheckMacValue=' + '0'.repeat(64));
    if (reason === 'wrong_merchant')
      value = await body(p, { MerchantID: '7654321' });
    if (reason === 'platform')
      value = await body(p, { PlatformID: '1234567' });
    const r = await post(url, value);
    assert.equal(r.status, 303);
    assert.equal(r.response.headers.get('Location'), '/');
    assert.equal(await count('commerce_hosted_payment_events'), 0);
    assert.equal(await count('commerce_checkout_payment_applications'), 0);
  });
test('over-budget browser returns still verify and redirect but write no event or query', async () => {
  const p = await f.placed();
  await f.x.h.pool.query('INSERT INTO auth_rate_limits(bucket,window_start,attempts) VALUES($1,clock_timestamp(),60)', ['commerce:paymentReturnNetwork:' + hashKey('192.0.2.1')]);
  const value = await body(p);
  let r = await post(returnPath(p), value);
  assert.equal(r.status, 303);
  assert.equal(r.response.headers.get('Location'), `/shops/${p.s.slug}/payment-return/${p.payment.attempt_ref}`);
  r = await post(returnPath(p), value.replace(/CheckMacValue=[A-Fa-f0-9]+/, 'CheckMacValue=' + '0'.repeat(64)));
  assert.equal(r.status, 303);
  assert.equal(r.response.headers.get('Location'), '/');
  assert.equal(await count('commerce_hosted_payment_events'), 0);
  assert.equal((await f.x.h.pool.query("SELECT due_at>clock_timestamp() AS later FROM commerce_due_work WHERE kind='payment_query' AND target_id=$1", [p.payment.attempt_ref])).rows[0].later, true);
  assert.equal((await f.x.h.pool.query("SELECT count(*)::int n FROM auth_rate_limits WHERE bucket LIKE 'commerce:paymentReturnQuery:%'")).rows[0].n, 0);
});
test('quarantine return verifies and redirects while leaving the inbox, order and due work untouched', async () => {
  const p = await f.placed(), before = await facts(p), due = (await f.x.h.pool.query('SELECT * FROM commerce_due_work ORDER BY kind')).rows;
  f.settings.quarantine = true;
  const r = await post(returnPath(p), await body(p));
  assert.equal(r.status, 303);
  assert.equal(r.response.headers.get('Location'), `/shops/${p.s.slug}/payment-return/${p.payment.attempt_ref}`);
  assert.deepEqual(await facts(p), before);
  assert.deepEqual((await f.x.h.pool.query('SELECT * FROM commerce_due_work ORDER BY kind')).rows, due);
});
test('review 1: malformed browser-return forms redirect to root without data', async () => {
  const p = await f.placed(), value = await body(p);
  for (const invalid of [value + '&MerchantID=1234567', value + '&bad-name=x', 'x=' + 'a'.repeat(16384)]) {
    const r = await post(returnPath(p), invalid);
    assert.equal(r.status, 303);
    assert.equal(r.response.headers.get('Location'), '/');
  }
  assert.equal((await post(returnPath(p), value, { 'Content-Type': 'application/json' })).status, 303);
  assert.equal(await count('commerce_hosted_payment_events'), 0);
});
test('activation return redirects to root and does not activate its service', async () => {
  const p = await f.placed(), activation = await anotherAttempt(p, 1, 'service_activation'), r = await post(returnPath(p), await body(activation));
  assert.equal(r.status, 303);
  assert.equal(r.response.headers.get('Location'), '/');
  assert.equal((await facts(activation)).attempt.state, 'issued');
  assert.equal(await count('commerce_checkout_payment_applications'), 0);
});
test('back links resolve only retained order attempts and have no payment side effects', async () => {
  const p = await f.placed(), before = await facts(p), r = await post('/pay/ecpay/back/' + p.payment.attempt_ref, '', {}, 'GET');
  assert.equal(r.status, 303);
  assert.equal(r.response.headers.get('Location'), `/shops/${p.s.slug}/orders/${p.order.order_ref}`);
  assert.deepEqual(await facts(p), before);
  const activation = await anotherAttempt(p, 1, 'service_activation');
  const activationBack=await post('/pay/ecpay/back/'+activation.payment.attempt_ref,'',{},'GET');
  assert.equal(activationBack.status,303);assert.equal(activationBack.response.headers.get('Location'),'/');
  for (const id of [randomUUID(), 'invalid']) {
    const missing = await post('/pay/ecpay/back/' + id, '', {}, 'GET');
    assert.equal(missing.status, 404);
    assert.match(missing.response.headers.get('Content-Type')!, /text\/html/);
  }
});
test('payment returns resolve only order attempts of the named store and write nothing', async () => {
  const p = await f.placed(), other = await f.x.store(1, false), activation = await anotherAttempt(p, 1, 'service_activation'), before = await facts(p);
  assert.deepEqual(await resolvePaymentReturn(f.x.runtime, p.s.slug, p.payment.attempt_ref), { order_ref: p.order.order_ref });
  for (const [slug, id] of [[other.slug, p.payment.attempt_ref], [p.s.slug, activation.payment.attempt_ref], [p.s.slug, randomUUID()]])
    assert.equal(await resolvePaymentReturn(f.x.runtime, slug, id), null);
  assert.deepEqual(await facts(p), before);
});
async function buyerView(p: Placed) { const r = await f.http('GET', f.root(p.s) + '/orders/' + p.order.order_ref, undefined, p.cookie); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; }
test('buyer payment state orders confirmed above pending above simulated above unpaid', async () => {
  const p = await f.placed();
  assert.equal((await buyerView(p)).payment_state, 'unpaid');
  await ack(await post(path(p), await body(p, { SimulatePaid: '1' })));
  let view = await buyerView(p);
  assert.equal(view.payment_state, 'simulated');
  assert.equal(view.latest_payment_attempt.state, 'ready');
  await post(returnPath(p), await body(p));
  view = await buyerView(p);
  assert.equal(view.payment_state, 'pending');
  await ack(await post(path(p), await body(p)));
  view = await buyerView(p);
  assert.equal(view.payment_state, 'confirmed');
  assert.equal(view.latest_payment_attempt.state, 'paid');
  assert.equal(view.can_resume_payment, false);
});
for (const outcome of ['amount_mismatch', 'after_cancel', 'overpaid'] as const)
  test(`buyer payment state shows ${outcome} money as overpaid above confirmed and offers no payment`, async () => {
    const p = await f.placed();
    if (outcome === 'amount_mismatch') {
      await ack(await post(path(p), await body(p, { TradeAmt: '6' })));
      const view = await buyerView(p);
      assert.equal(view.payment_state, 'overpaid');
      assert.equal(view.latest_payment_attempt.state, 'ready');
      assert.equal(view.can_resume_payment, false);
      const second = await anotherAttempt(p);
      await ack(await post(path(p), await body(second)));
    }
    else if (outcome === 'after_cancel') {
      await f.x.tx(q => cancelUnpaidOrder(q, p.s, p.order.order_ref, 'buyer', 'buyer_cancelled', f.runtime.commercePorts));
      await ack(await post(path(p), await body(p)));
    }
    else {
      const second = await anotherAttempt(p);
      await ack(await post(path(p), await body(p)));
      await ack(await post(path(p), await body(second)));
    }
    assert.deepEqual((await facts(p)).applications.map(a => a.outcome), { amount_mismatch: ['amount_mismatch', 'converted'], after_cancel: ['after_cancel'], overpaid: ['converted', 'overpaid'] }[outcome]);
    const view = await buyerView(p);
    assert.equal(view.payment_state, 'overpaid');
    assert.equal(view.can_resume_payment, false);
  });
test('a quarantined verified paid event projects pending before application', async () => {
  const p = await f.placed();
  f.settings.quarantine = true;
  await ack(await post(path(p), await body(p)));
  const view = await buyerView(p);
  assert.equal(view.payment_state, 'pending');
  assert.equal(view.latest_payment_attempt.state, 'ready');
  assert.equal(view.can_resume_payment, false);
});
test('pending confirmation on the latest attempt ends on a later failure', async () => {
  const p = await f.placed();
  await ack(await post(path(p), await body(p, { RtnCode: '10300066' })));
  assert.equal((await buyerView(p)).payment_state, 'pending');
  await ack(await post(path(p), await body(p, { RtnCode: '0' })));
  const view = await buyerView(p);
  assert.equal(view.payment_state, 'unpaid');
  assert.equal(view.latest_payment_attempt.state, 'failed');
});
test('a browser hint beyond the latest attempt confirmation window is not pending', async () => {
  const p = await f.placed();
  await f.x.h.pool.query("UPDATE commerce_payment_attempts SET state='superseded',superseded_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1", [p.payment.attempt_ref]);
  const a = (await f.x.h.pool.query(`INSERT INTO commerce_payment_attempts(tenant_id,instance_id,kind,order_id,sequence,account_id,environment,merchant_id,credential_version,merchant_trade_no,amount_minor,currency,created_at)
    SELECT tenant_id,instance_id,kind,order_id,2,account_id,environment,merchant_id,credential_version,$2,amount_minor,currency,clock_timestamp()-interval '61 minutes' FROM commerce_payment_attempts WHERE attempt_id=$1 RETURNING attempt_id`, [p.payment.attempt_ref, newTradeNumber('F')])).rows[0];
  const latest = { ...p, payment: { ...p.payment, attempt_ref: a.attempt_id } };
  await post(returnPath(p), await body(latest));
  const view = await buyerView(p);
  assert.equal(view.latest_payment_attempt.attempt_ref, a.attempt_id);
  assert.equal(view.payment_state, 'unpaid');
});
test('a pending event on an older attempt does not make the latest attempt pending', async () => {
  const p = await f.placed();
  await ack(await post(path(p), await body(p, { RtnCode: '10300066' })));
  const latest = await anotherAttempt(p);
  const view = await buyerView(p);
  assert.equal(view.latest_payment_attempt.attempt_ref, latest.payment.attempt_ref);
  assert.equal(view.payment_state, 'unpaid');
});
test('quarantined notifications replay in receipt order, once per transaction and once per event', async () => {
  const p = await f.placed();
  f.settings.quarantine = true;
  for (const overrides of [{ RtnCode: '0' }, { RtnCode: '10300066' }, { RtnCode: '1' }])
    await ack(await post(path(p), await body(p, overrides)));
  let actual = await facts(p);
  assert.equal(actual.events.length, 3);
  assert(actual.events.every(e => e.applied_at === null));
  assert.equal(actual.attempt.state, 'issued');
  f.settings.quarantine = false;
  assert.deepEqual(await applyDeferredPaymentEvents(f.x.runtime, { limit: 1 }), { applied: 1, failed: 0, skipped: 0 });
  actual = await facts(p);
  assert.equal(actual.attempt.state, 'failed');
  assert(actual.events[0].applied_at);
  assert.equal(actual.events[1].applied_at, null);
  assert.deepEqual(await applyDeferredPaymentEvents(f.x.runtime, { limit: 200 }), { applied: 2, failed: 0, skipped: 0 });
  actual = await facts(p);
  assert.equal(actual.attempt.state, 'paid');
  assert(actual.events.every(e => e.applied_at));
  assert.equal(actual.applications.length, 1);
  assert.equal(actual.cases.length, 0);
  assert.equal((await buyerView(p)).payment_state, 'confirmed');
  assert.deepEqual(await applyDeferredPaymentEvents(f.x.runtime, { limit: 200 }), { applied: 0, failed: 0, skipped: 0 });
  for (const limit of [0, 201, 1.5])
    await assert.rejects(applyDeferredPaymentEvents(f.x.runtime, { limit }), { message: 'payment_deferred_limit_invalid' });
});
test('concurrent deferred replays apply a verified paid event once', async () => {
  const p = await f.placed();
  f.settings.quarantine = true;
  await ack(await post(path(p), await body(p)));
  f.settings.quarantine = false;
  const counts = await Promise.all([applyDeferredPaymentEvents(f.x.runtime, { limit: 200 }), applyDeferredPaymentEvents(f.x.runtime, { limit: 200 })]);
  assert.equal(counts.reduce((a, b) => a + b.applied, 0), 1);
  assert.equal((await facts(p)).applications.length, 1);
});

test('review 1: browser return locks its attempt before due work without a payment deadlock', async () => {
  const p = await f.placed(), value = await body(p), locked = signal(), release = signal();
  let pid = 0;
  const transaction = f.x.tx(async q => {
    pid = (await q.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await bindStore(q, p.s.tenantId);
    await lockMachineOrder(q, p.order.order_ref);
    await lockCheckoutOrders(q, [p.order.order_ref], undefined, p.payment.attempt_ref);
    locked.resolve();
    await release.promise;
    await scheduleDueWork(q, { tenantId: p.s.tenantId, instanceId: p.s.instanceId,
      kind: 'payment_query', targetId: p.payment.attempt_ref, dueAt: new Date() });
  }).then(() => null, error => error as Error & { code?: string });
  let returned: ReturnType<typeof post> | undefined;
  try {
    await locked.promise;
    returned = post(returnPath(p), value);
    const deadline = Date.now() + 15000;
    let blocked = false;
    while (Date.now() < deadline) {
      if ((await f.x.h.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND $1=ANY(pg_blocking_pids(pid))", [pid])).rowCount) {
        blocked = true;
        break;
      }
    }
    assert(blocked, 'return never reached the real attempt lock barrier');
    release.resolve();
    const [failure, response] = await Promise.all([transaction, returned]);
    assert.equal(failure?.code ?? null, null, 'notification-side transaction must not deadlock');
    assert.equal(response.status, 303, response.text);
    assert.equal(response.response.headers.get('Location'), `/shops/${p.s.slug}/payment-return/${p.payment.attempt_ref}`);
    assert.equal((await f.x.h.pool.query("SELECT count(*)::int n FROM commerce_hosted_payment_events WHERE source='browser_return' AND attempt_id=$1", [p.payment.attempt_ref])).rows[0].n, 1);
    assert.equal((await f.x.h.pool.query("SELECT count(*)::int n FROM commerce_due_work WHERE kind='payment_query' AND target_id=$1", [p.payment.attempt_ref])).rows[0].n, 1);
  } finally {
    release.resolve();
    await transaction;
    await returned;
  }
});

for (const failure of ['query_budget', 'record'] as const)
  test(`review 1: ${failure} failure after resolving a browser return preserves the order redirect`, async () => {
    const p = await f.placed(), value = await body(p), connect = f.x.runtime.connect;
    const errors: unknown[][] = [], log = console.error;
    f.x.runtime.connect = (async () => {
      const q = await (connect as () => Promise<PoolClient>).call(f.x.runtime), query = q.query, release = q.release;
      q.query = (async (...args: unknown[]) => {
        const sql = String(args[0]);
        if (failure === 'record' && sql.startsWith('INSERT INTO commerce_hosted_payment_events')
          || failure === 'query_budget' && sql.includes('auth_rate_limits') && (args[1] as string[] | undefined)?.some(v => String(v).includes('commerce:paymentReturnQuery:')))
          throw Error('synthetic_browser_hint_failure');
        return (query as Function).apply(q, args);
      }) as typeof q.query;
      q.release = (error?: Error | boolean) => { q.query = query; q.release = release; release.call(q, error); };
      return q;
    }) as typeof f.x.runtime.connect;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      const result = await post(returnPath(p), value);
      assert.equal(result.status, 303, result.text);
      assert.equal(result.response.headers.get('Location'), `/shops/${p.s.slug}/payment-return/${p.payment.attempt_ref}`);
      assert(errors.some(row => row.length === 1 && row[0] === 'payment_browser_return_record_failed'));
      assert.equal(await count('commerce_hosted_payment_events'), 0);
    } finally {
      f.x.runtime.connect = connect;
      console.error = log;
    }
  });

test('review 1: missing browser-return keyring serves an HTML result-unavailable page', async () => {
  const p = await f.placed(), value = await body(p);
  f.install({ commerceCredentialKeyring: null });
  const result = await post(returnPath(p), value);
  assert.equal(result.status, 503);
  assert.match(result.response.headers.get('Content-Type')!, /^text\/html/);
  assert.match(result.text, /暫時無法確認付款結果，請稍後到訂單頁查看。/);
});

test('review 1: unexpected pre-resolution return failure serves HTML rather than machine text', async () => {
  const p = await f.placed(), value = await body(p), connect = f.x.runtime.connect;
  f.x.runtime.connect = (async () => {
    const q = await (connect as () => Promise<PoolClient>).call(f.x.runtime), query = q.query, release = q.release;
    q.query = (async (...args: unknown[]) => {
      if (String(args[0]).includes('SELECT tenant_id,instance_id,target_id AS account_id'))
        throw Error('synthetic_browser_resolution_failure');
      return (query as Function).apply(q, args);
    }) as typeof q.query;
    q.release = (error?: Error | boolean) => { q.query = query; q.release = release; release.call(q, error); };
    return q;
  }) as typeof f.x.runtime.connect;
  try {
    const result = await post(returnPath(p), value);
    assert.equal(result.status, 500);
    assert.match(result.response.headers.get('Content-Type')!, /^text\/html/);
    assert.match(result.text, /暫時無法確認付款結果，請稍後到訂單頁查看。/);
  } finally { f.x.runtime.connect = connect; }
});

test('review 2: unsigned traffic exhausts only its account and network budget', async () => {
  const p = await f.placed(), signed = await body(p), warn = console.warn;
  console.warn = () => {};
  try {
    for (let i = 0; i < 600; i++)
      assert.equal((await post(path(p), 'MerchantID=1234567', { 'CF-Connecting-IP': '192.0.2.10' })).status, 400);
    const limited = await post(path(p), 'MerchantID=1234567', { 'CF-Connecting-IP': '192.0.2.10' });
    assert.equal(limited.status, 429);
    assert(Number(limited.response.headers.get('Retry-After')) > 0);
    await ack(await post(path(p), signed, { 'CF-Connecting-IP': '192.0.2.20' }));
    const actual = await facts(p);
    assert.equal(actual.attempt.state, 'paid');
    assert.equal(actual.applications[0].outcome, 'converted');
  } finally { console.warn = warn; }
});


test('review 3: deferred paid facts protect expired holds from placement and sweep until conversion', async () => {
  const s = await f.x.store(5), provider = await f.setup(s);
  const checkout = await f.http('POST', f.root(s) + '/checkouts', f.x.input(s.product.sku, 5), undefined, { 'Idempotency-Key': randomUUID() });
  assert.equal(checkout.status, 201);
  const cookie = checkout.response.headers.get('Set-Cookie')!.split(';')[0], due = await f.x.due(s, 5);
  await f.x.tx(q => f.runtime.commercePorts!.payment!.createOrderAttempt(q, { store: s, orderId: due.order_id, amountMinor: 500, currency: 'TWD', environment: 'sandbox' }));
  const attempt = (await f.x.h.pool.query('SELECT attempt_id FROM commerce_payment_attempts WHERE order_id=$1', [due.order_id])).rows[0];
  const p = { s, provider, order: { order_ref: due.order_id }, payment: { attempt_ref: attempt.attempt_id } } as Placed;
  // The frozen-clock fixture retains expired holds; the provider paid inside their original window.
  const paidAt = (await f.x.h.pool.query("SELECT created_at+interval '1 minute' AS paid FROM commerce_orders WHERE order_id=$1", [due.order_id])).rows[0].paid;
  f.settings.quarantine = true;
  await ack(await post(path(p), await body(p, { PaymentDate: formatTaipeiDateTime(paidAt.getTime()) })));
  f.settings.quarantine = false;
  const view = await f.x.tx(async q => {
    await bindStore(q, s.tenantId);
    return publicOrder(q, { ...s, projection: { slug: s.slug, name: '合成商店' } }, due.order_id, f.runtime.commercePorts!.payment);
  });
  assert.equal(view.payment_state, 'pending');
  const competing = await f.http('POST', f.root(s) + `/checkouts/${checkout.data.checkout_ref}/orders`, { terms_sha256: checkout.data.terms_sha256, client_order_id: randomUUID() }, cookie);
  assert.equal(competing.status, 409, JSON.stringify(competing.data));
  assert.equal(competing.data.code, 'stock_unavailable');
  assert.equal(await sweepDueCheckoutHolds(f.x.runtime), 0);
  assert.equal((await f.x.h.pool.query('SELECT state FROM commerce_inventory_reservations WHERE order_id=$1', [due.order_id])).rows[0].state, 'held');
  await applyDeferredPaymentEvents(f.x.runtime);
  const actual = await facts(p);
  assert.equal(actual.applications[0].outcome, 'converted');
  assert.equal(actual.cases.length, 0);
});

test('review 3: a new paid notification waits for the same attempt older deferred failure', async () => {
  const p = await f.placed();
  f.settings.quarantine = true;
  await ack(await post(path(p), await body(p, { RtnCode: '0' })));
  f.settings.quarantine = false;
  await ack(await post(path(p), await body(p)));
  let actual = await facts(p);
  assert(actual.events.every(e => e.applied_at === null));
  assert.equal(actual.attempt.state, 'issued');
  await applyDeferredPaymentEvents(f.x.runtime);
  actual = await facts(p);
  assert(actual.events.every(e => e.applied_at));
  assert(actual.events[0].applied_at <= actual.events[1].applied_at);
  assert.equal(actual.attempt.state, 'paid');
  assert.equal(actual.cases.length, 0);
});


test('review 8: one poison event skips its attempt siblings and does not block another attempt', async () => {
  const a = await f.placed(), b = await f.placed();
  f.settings.quarantine = true;
  await ack(await post(path(a), await body(a, { RtnCode: '0' })));
  await ack(await post(path(a), await body(a)));
  await ack(await post(path(b), await body(b)));
  const events = (await f.x.h.pool.query('SELECT event_id,attempt_id FROM commerce_hosted_payment_events ORDER BY received_at,event_id')).rows;
  const poison = events[0].event_id, original = console.error, logs: unknown[][] = [];
  f.settings.quarantine = false;
  const pool = { query: f.x.runtime.query.bind(f.x.runtime), connect: async () => {
    const q = await f.x.runtime.connect(), query = q.query, release = q.release;
    q.query = (async (...args: unknown[]) => {
      if (String(args[0]).includes('FROM commerce_hosted_payment_events WHERE event_id=$1') && String(args[0]).includes('FOR UPDATE') && (args[1] as string[])[0] === poison)
        throw Error('synthetic_poison_fact');
      return (query as Function).apply(q, args);
    }) as typeof q.query;
    q.release = (error?: Error | boolean) => { q.query = query; q.release = release; release.call(q, error); };
    return q;
  } } as unknown as import('pg').Pool;
  console.error = (...args: unknown[]) => { logs.push(args); };
  try {
    assert.deepEqual(await applyDeferredPaymentEvents(pool), { applied: 1, failed: 1, skipped: 1 });
    assert.deepEqual(logs, [['commerce_payment_event_apply_failed', poison]]);
    const rows = (await f.x.h.pool.query('SELECT event_id,applied_at FROM commerce_hosted_payment_events ORDER BY received_at,event_id')).rows;
    assert.equal(rows[0].applied_at, null);
    assert.equal(rows[1].applied_at, null);
    assert(rows[2].applied_at);
    assert.equal((await facts(b)).attempt.state, 'paid');
  } finally { console.error = original; }
});


test('review 10: notification locks its account before the credential and inbox insert', async () => {
  const p = await f.placed(), value = await body(p), connect = f.x.runtime.connect, statements: string[] = [];
  f.x.runtime.connect = (async () => {
    const q = await (connect as () => Promise<PoolClient>).call(f.x.runtime), query = q.query, release = q.release;
    q.query = (async (...args: unknown[]) => { statements.push(String(args[0])); return (query as Function).apply(q, args); }) as typeof q.query;
    q.release = (error?: Error | boolean) => { q.query = query; q.release = release; release.call(q, error); };
    return q;
  }) as typeof f.x.runtime.connect;
  try { await ack(await post(path(p), value)); } finally { f.x.runtime.connect = connect; }
  const account = statements.findIndex(sql => sql.includes('FROM commerce_provider_accounts') && sql.includes('FOR KEY SHARE'));
  const credential = statements.findIndex(sql => sql.includes('FROM commerce_provider_credentials') && sql.includes('FOR SHARE'));
  const inbox = statements.findIndex(sql => sql.startsWith('INSERT INTO commerce_hosted_payment_events'));
  assert(account >= 0, 'account KEY SHARE must precede the credential lock');
  assert(credential > account, 'credential lock must follow the account lock');
  assert(inbox > credential, 'inbox FK must follow both account and credential locks');
});


test('review 11: replayed verified browser returns retain one hint and the same redirect', async () => {
  const p = await f.placed(), value = await body(p);
  const first = await post(returnPath(p), value), second = await post(returnPath(p), value);
  for (const result of [first, second]) {
    assert.equal(result.status, 303);
    assert.equal(result.response.headers.get('Location'), `/shops/${p.s.slug}/payment-return/${p.payment.attempt_ref}`);
  }
  assert.equal((await f.x.h.pool.query("SELECT count(*)::int n FROM commerce_hosted_payment_events WHERE attempt_id=$1 AND source='browser_return'", [p.payment.attempt_ref])).rows[0].n, 1);
});

import {createFixtureQueryTransport} from '../../modules/agent-commerce/payments/query-transport.js';
import {FixtureEmailSender} from '../../modules/agent-commerce/operations/notifications/email-port.js';
test('notification commits and acknowledges before its collected confirmation query runs',async()=>{
  const p=await f.placed(),value=await body(p),fields=new URLSearchParams(value),pending:(()=>Promise<void>)[]=[];
  await f.x.h.pool.query('UPDATE commerce_payment_attempts SET journaled_at=clock_timestamp(),handed_off_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1',[p.payment.attempt_ref]);
  let calls=0;
  f.install({afterResponse:work=>{pending.push(work);},commerceQueryTransport:createFixtureQueryTransport(async()=>{
    calls++;assert.equal((await facts(p)).attempt.state,'paid');
    return {kind:'response',status:200,body:encodeForm(signFields({MerchantID:'1234567',MerchantTradeNo:fields.get('MerchantTradeNo')!,TradeNo:fields.get('TradeNo')!,TradeAmt:'5',TradeStatus:'1'},EcpayKeyPair.of(p.provider.material.hash_key,p.provider.material.hash_iv),'sha256'))};
  },'local')});
  await ack(await post(path(p),value));assert.equal(calls,0);assert.equal(pending.length,1);assert.equal((await facts(p)).attempt.state,'paid');
  await pending[0]();assert.equal(calls,1);const actual=await facts(p);assert.equal(actual.attempt.state,'confirmed');assert.equal(actual.applications.length,1);assert.equal(actual.events[1].query_trigger,'notification');
  assert.equal((await f.x.h.pool.query("SELECT count(*)::int n FROM auth_rate_limits WHERE bucket LIKE 'commerce:paymentQuery%'")).rows[0].n,0);
});
test('browser return queues only a committed new hint that scheduled a query',async()=>{
  const p=await f.placed(),value=await body(p),pending:(()=>Promise<void>)[]=[];
  f.install({afterResponse:work=>{pending.push(work);},commerceQueryTransport:createFixtureQueryTransport(async()=>({kind:'error',code:'network'}),'local')});
  assert.equal((await post(returnPath(p),value)).status,303);assert.equal(pending.length,1);
  assert.equal((await post(returnPath(p),value)).status,303);assert.equal(pending.length,1);
  f.settings.quarantine=true;assert.equal((await post(returnPath(p),value)).status,303);assert.equal(pending.length,1);
});
test('after-response work delivers payment emails right after browser-return query, late payment notification, and common notification when email is on, and queues/sends nothing when off',async()=>{
  try {
    // 1. Browser return first (email on): query runs first in afterResponse, applies payment & queues order_confirmed, then step 2 delivers it
    f.settings.emailEnabled=true;
    const p1=await f.placed(),value1=await body(p1),fields1=new URLSearchParams(value1),pending1:(()=>Promise<void>)[]=[],sender1=new FixtureEmailSender();
    await f.x.h.pool.query('UPDATE commerce_payment_attempts SET journaled_at=clock_timestamp(),handed_off_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1',[p1.payment.attempt_ref]);
    f.install({
      afterResponse:work=>{pending1.push(work);},
      commerceEmailSender:sender1,
      commerceQueryTransport:createFixtureQueryTransport(async()=>({
        kind:'response',
        status:200,
        body:encodeForm(signFields({MerchantID:'1234567',MerchantTradeNo:fields1.get('MerchantTradeNo')!,TradeNo:fields1.get('TradeNo')!,TradeAmt:'5',TradeStatus:'1'},EcpayKeyPair.of(p1.provider.material.hash_key,p1.provider.material.hash_iv),'sha256'))
      }),'local')
    });
    assert.equal((await post(returnPath(p1),value1)).status,303);
    assert.equal(pending1.length,1);
    assert.equal(sender1.messages.length,0);
    await pending1[0]();
    assert.equal(sender1.messages.length,1);
    assert(sender1.messages[0].subject.includes(p1.order.display_number));
    assert(sender1.messages[0].subject.includes('已成立'));
    const row1=(await f.x.h.pool.query('SELECT template,state,sent_at FROM commerce_outbound_emails WHERE order_id=$1',[p1.order.order_ref])).rows;
    assert.equal(row1.length,1);assert.equal(row1[0].template,'order_confirmed');assert.equal(row1[0].state,'sent');assert(row1[0].sent_at instanceof Date);

    // 2. Late payment (email on): notification arrives for an expired_unpaid attempt (no payment_query due), afterResponse still delivers the queued email
    const p2=await f.placed(),value2=await body(p2),pending2:(()=>Promise<void>)[]=[],sender2=new FixtureEmailSender();
    await f.x.h.pool.query("UPDATE commerce_payment_attempts SET state='expired_unpaid',expired_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1",[p2.payment.attempt_ref]);
    await f.x.h.pool.query("DELETE FROM commerce_due_work WHERE target_id=$1",[p2.payment.attempt_ref]);
    f.install({afterResponse:work=>{pending2.push(work);},commerceEmailSender:sender2});
    await ack(await post(path(p2),value2));
    assert.equal(pending2.length,1);
    assert.equal(sender2.messages.length,0);
    await pending2[0]();
    assert.equal(sender2.messages.length,1);
    assert(sender2.messages[0].subject.includes(p2.order.display_number));
    const row2=(await f.x.h.pool.query('SELECT template,state,sent_at FROM commerce_outbound_emails WHERE order_id=$1',[p2.order.order_ref])).rows;
    assert.equal(row2.length,1);assert.equal(row2[0].template,'order_confirmed');assert.equal(row2[0].state,'sent');assert(row2[0].sent_at instanceof Date);

    // 3. Common case (email on): paid notification sends order_confirmed from the captured afterResponse work and leaves the row sent
    const p3=await f.placed(),value3=await body(p3),fields3=new URLSearchParams(value3),pending3:(()=>Promise<void>)[]=[],sender3=new FixtureEmailSender();
    await f.x.h.pool.query('UPDATE commerce_payment_attempts SET journaled_at=clock_timestamp(),handed_off_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1',[p3.payment.attempt_ref]);
    f.install({
      afterResponse:work=>{pending3.push(work);},
      commerceEmailSender:sender3,
      commerceQueryTransport:createFixtureQueryTransport(async()=>({
        kind:'response',
        status:200,
        body:encodeForm(signFields({MerchantID:'1234567',MerchantTradeNo:fields3.get('MerchantTradeNo')!,TradeNo:fields3.get('TradeNo')!,TradeAmt:'5',TradeStatus:'1'},EcpayKeyPair.of(p3.provider.material.hash_key,p3.provider.material.hash_iv),'sha256'))
      }),'local')
    });
    await ack(await post(path(p3),value3));
    assert.equal(pending3.length,1);
    assert.equal(sender3.messages.length,0);
    await pending3[0]();
    assert.equal(sender3.messages.length,1);
    assert(sender3.messages[0].subject.includes(p3.order.display_number));
    const row3=(await f.x.h.pool.query('SELECT template,state,sent_at FROM commerce_outbound_emails WHERE order_id=$1',[p3.order.order_ref])).rows;
    assert.equal(row3.length,1);assert.equal(row3[0].template,'order_confirmed');assert.equal(row3[0].state,'sent');assert(row3[0].sent_at instanceof Date);
  } finally {
    f.settings.emailEnabled=false;
  }
});
test('when email is off, browser-return query, late payment notification, and common notification queue nothing and send nothing',async()=>{
  f.settings.emailEnabled=false;
  const pOff1=await f.placed(),valOff1=await body(pOff1),fOff1=new URLSearchParams(valOff1);
  const pOff2=await f.placed(),valOff2=await body(pOff2);
  const pOff3=await f.placed(),valOff3=await body(pOff3);
  const pendingOff:(()=>Promise<void>)[]=[],senderOff=new FixtureEmailSender();
  await f.x.h.pool.query('UPDATE commerce_payment_attempts SET journaled_at=clock_timestamp(),handed_off_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1',[pOff1.payment.attempt_ref]);
  await f.x.h.pool.query("UPDATE commerce_payment_attempts SET state='expired_unpaid',expired_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1",[pOff2.payment.attempt_ref]);
  await f.x.h.pool.query("DELETE FROM commerce_due_work WHERE target_id=$1",[pOff2.payment.attempt_ref]);
  await f.x.h.pool.query('UPDATE commerce_payment_attempts SET journaled_at=clock_timestamp(),handed_off_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1',[pOff3.payment.attempt_ref]);
  f.install({
    afterResponse:work=>{pendingOff.push(work);},
    commerceEmailSender:senderOff,
    commerceQueryTransport:createFixtureQueryTransport(async()=>({
      kind:'response',
      status:200,
      body:encodeForm(signFields({MerchantID:'1234567',MerchantTradeNo:fOff1.get('MerchantTradeNo')!,TradeNo:fOff1.get('TradeNo')!,TradeAmt:'5',TradeStatus:'1'},EcpayKeyPair.of(pOff1.provider.material.hash_key,pOff1.provider.material.hash_iv),'sha256'))
    }),'local')
  });
  assert.equal((await post(returnPath(pOff1),valOff1)).status,303);
  await ack(await post(path(pOff2),valOff2));
  await ack(await post(path(pOff3),valOff3));
  for(const work of pendingOff) await work();
  assert.equal(senderOff.messages.length,0);
  assert.equal(
    (await f.x.h.pool.query('SELECT count(*)::int n FROM commerce_outbound_emails WHERE order_id = ANY($1::uuid[])',[[pOff1.order.order_ref,pOff2.order.order_ref,pOff3.order.order_ref]])).rows[0].n,
    0
  );
});
