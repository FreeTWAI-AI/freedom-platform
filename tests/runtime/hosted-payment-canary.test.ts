import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { formatWithOptions } from 'node:util';
import { hostedPaymentHarness } from '../e2e/hosted-payment-fixture.js';
import { EcpayKeyPair, signFields, encodeForm } from '../../modules/agent-commerce/providers/ecpay/index.js';
import { applyDeferredPaymentEvents } from '../../modules/agent-commerce/payments/events.js';
const encodings = (value: string) => [value, Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url'), encodeURIComponent(value), Buffer.from(value).toString('hex'), Buffer.from(value).toString('hex').toUpperCase()];
function checker(values: readonly string[]) {
  const needles = values.flatMap(encodings);
  return (location: string, value: string) => {
    if (needles.some(needle => value.includes(needle)))
      throw Error('payment_canary_leak_at_' + location);
  };
}
test('canary detection covers every required encoding and reports location without the value', () => {
  const canary = 'CANARY_' + randomBytes(16).toString('hex'), check = checker([canary]);
  for (const encoded of encodings(canary))
    assert.throws(() => check('synthetic_location', encoded), { message: 'payment_canary_leak_at_synthetic_location' });
  assert.throws(() => check('console_error', formatWithOptions({ colors: false }, new Error(canary))), { message: 'payment_canary_leak_at_console_error' });
});
test('payment keys and ignored card fields never reach responses, public database columns, logs or the effect journal', async () => {
  const material = { hash_key: randomBytes(8).toString('hex'), hash_iv: randomBytes(8).toString('hex'), credit_check_code: String(randomInt(100000000)).padStart(8, '0') };
  // Long random taint markers in ignored fields avoid accidental matches against
  // unrelated four-digit substrings of UUIDs, timestamps and SHA-256 digests.
  const card6 = 'CANARY_CARD6_' + randomBytes(16).toString('hex'), card4 = 'CANARY_CARD4_' + randomBytes(16).toString('hex');
  const auth = 'CANARY_AUTH_' + randomBytes(16).toString('hex'), message = 'CANARY_MESSAGE_' + randomBytes(16).toString('hex');
  const check = checker([...Object.values(material), card6, card4, auth, message]), f = await hostedPaymentHarness('fp_payment_canary', { publicSchema: true });
  const responses: {
    location: string;
    body: string;
    headers: string;
  }[] = [], pending: Promise<void>[] = [], logs: string[] = [];
  const methods = ['log', 'info', 'debug', 'warn', 'error', 'trace', 'dir', 'table'] as const;
  const originals = Object.fromEntries(methods.map(key => [key, console[key]]));
  for (const key of methods)
    console[key] = (...args: unknown[]) => { logs.push(formatWithOptions({ colors: false }, ...args)); };
  function capture(app: typeof f.app, label: string) {
    const original = app.fetch;
    app.fetch = (async (...args: Parameters<typeof original>) => {
      const response = await original(...args), copy = response.clone(), location = label + '/' + responses.length;
      pending.push(copy.text().then(body => { responses.push({ location, body, headers: JSON.stringify([...copy.headers]) }); }));
      return response;
    }) as typeof original;
  }
  try {
    await f.reset();
    capture(f.app, 'payment_http');
    capture(f.x.app, 'setup_http');
    const p = await f.placed(material), a = (await f.x.h.pool.query('SELECT merchant_trade_no FROM commerce_payment_attempts WHERE attempt_id=$1', [p.payment.attempt_ref])).rows[0];
    const keys = EcpayKeyPair.of(material.hash_key, material.hash_iv), base = { MerchantID: '1234567', MerchantTradeNo: a.merchant_trade_no, TradeNo: 'T' + randomBytes(8).toString('hex').toUpperCase(), RtnCode: '1', TradeAmt: '5', PaymentDate: '2026/10/15 12:34:56', PaymentType: 'Credit_CreditCard', PaymentTypeChargeFee: '0', gwsr: '123456', RtnMsg: message, card6no: card6, card4no: card4, auth_code: auth };
    const send = async (path: string, fields: Record<string, string>) => { const request = new Request(f.origin + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://foreign.test' }, body: encodeForm(signFields(fields, keys, 'sha256')) }); return f.app.fetch(request); };
    let response = await f.app.fetch(new Request(f.origin + p.payment.handoff_url));
    assert.equal(response.status, 200);
    const notification = '/api/v1/provider-callbacks/ecpay/' + p.provider.accountRef + '/payment';
    response = await send(notification, { ...base, SimulatePaid: '1' });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '1|OK');
    response = await send('/pay/ecpay/return/' + p.provider.accountRef, { MerchantID: base.MerchantID, MerchantTradeNo: base.MerchantTradeNo });
    assert.equal(response.status, 303);
    f.settings.quarantine = true;
    response = await send(notification, { ...base, SimulatePaid: '0' });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '1|OK');
    assert.equal((await f.x.h.pool.query("SELECT count(*)::int n FROM commerce_hosted_payment_events WHERE applied_at IS NULL")).rows[0].n, 1);
    f.settings.quarantine = false;
    assert.deepEqual(await applyDeferredPaymentEvents(f.x.runtime, { limit: 200 }), { applied: 1, failed: 0, skipped: 0 });
    const read = await f.http('GET', f.root(p.s) + '/orders/' + p.order.order_ref, undefined, p.cookie);
    assert.equal(read.status, 200);
    assert.equal(read.data.payment_state, 'confirmed');
    // Failed verification also exercises the fixed invalid-callback log path.
    response = await send(notification, { ...base, MerchantID: '7654321', SimulatePaid: '0' });
    assert.equal(response.status, 400);
    const columns = (await f.x.h.pool.query(`SELECT c.table_name,c.column_name FROM information_schema.columns c JOIN information_schema.tables t USING(table_catalog,table_schema,table_name)
      WHERE c.table_schema='public' AND t.table_type='BASE TABLE' AND c.data_type IN ('text','character varying','jsonb','bytea')
      AND NOT(c.table_name='commerce_provider_credentials' AND c.column_name='sealed') ORDER BY c.table_name,c.ordinal_position`)).rows;
    const tables = new Map<string, string[]>();
    for (const row of columns)
      tables.set(row.table_name, [...(tables.get(row.table_name) ?? []), row.column_name]);
    const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
    for (const [table, names] of tables) {
      const rows = (await f.x.h.pool.query(`SELECT ${names.map(quote).join(',')} FROM public.${quote(table)}`)).rows;
      for (let index = 0;index < rows.length;index++)
        for (const name of names) {
          const value = rows[index][name], location = `database/${table}/${name}/${index}`;
          if (Buffer.isBuffer(value)) {
            check(location, value.toString('utf8'));
            check(location, value.toString('hex'));
            check(location, value.toString('base64'));
          }
          else
            check(location, typeof value === 'string' ? value : JSON.stringify(value));
        }
    }
    await Promise.all(pending);
    for (const response of responses) {
      check(response.location + '/body', response.body);
      check(response.location + '/headers', response.headers);
    }
    for (const [key, body] of f.journal.objects) {
      check('journal/key', key);
      check('journal/body', body);
    }
    for (let i = 0;i < logs.length;i++)
      check('console/' + i, logs[i]);
  }
  finally {
    try {
      await f.stop();
    }
    finally {
      Object.assign(console, originals);
    }
  }
  for (let i = 0;i < logs.length;i++)
    check('console/' + i, logs[i]);
});
test('public ECPay fixture key strings do not occur under docs, modules or apps', async () => {
  const { ALL_STAGE_KEY_STRINGS } = await import('../worker/ecpay-fixtures/vectors.js');
  async function scan(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const next = join(path, entry.name);
      if (entry.isDirectory())
        await scan(next);
      else if (entry.isFile()) {
        const bytes = await readFile(next);
        if (ALL_STAGE_KEY_STRINGS.some(value => bytes.includes(Buffer.from(value))))
          throw Error('public_provider_key_at_' + next);
      }
    }
  }
  for (const root of ['docs', 'modules', 'apps'])
    await scan(root);
});
