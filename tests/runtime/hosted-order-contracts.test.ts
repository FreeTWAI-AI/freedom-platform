import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import * as c from '../../contracts/guild-launchpad/v1/hosted-order.js';
import * as shared from '../../contracts/guild-launchpad/v1/hosted-shared-order.js';

const id = '12345678-1234-4234-8234-123456789abc';
const digest = 'a'.repeat(64);
const effects = { payment_enabled: false, refund_enabled: false, fulfilment_enabled: false, money_movement_enabled: false };
const terms = { profile: c.HOSTED_ORDER_PROFILE, store: { slug: 'shop-one', name: 'Store' }, publication_revision: '1', currency: 'TWD',
  items: [{ sku: 'P0001', title: 'Item', quantity: 2, unit_price_minor: 300, line_total_minor: 600 }], merchandise_total_minor: 600,
  amount_due_minor: null, shipping_state: 'not_configured', tax_state: 'not_assessed', payment_state: 'not_enabled', terms_sha256: digest, ...effects };
const quote = { ...terms, quote_id: id, quoted_at: '2026-10-08T12:00:00.000Z', expires_at: '2026-10-08T12:05:00.000Z', reserves_stock: false };
const order = { ...terms, order_id: id, client_order_id: id, quote_id: id, version: '1', created_at: '2026-10-08T12:00:00.000Z',
  reservation_expires_at: '2026-10-08T12:30:00.000Z', state: 'reserved', closed_at: null, close_reason: null };
const submit = { quote_id: id, terms_sha256: digest, client_order_id: id };
const input = { publication_revision: '1', items: [{ sku: 'P0001', quantity: 2 }] };

test('shared opt-in retains totals, lifetime, terminal and financial fences without widening the original profile', () => {
  const q = {...quote, profile: shared.HOSTED_SHARED_ORDER_PROFILE};
  const o = {...order, profile: shared.HOSTED_SHARED_ORDER_PROFILE};
  assert.equal(shared.SharedQuoteSchema.safeParse(q).success, true);
  assert.equal(shared.SharedOrderSchema.safeParse(o).success, true);
  assert.equal(c.QuoteSchema.safeParse(q).success, false);
  assert.equal(c.OrderSchema.safeParse(o).success, false);
  for (const invalid of [{...q, merchandise_total_minor: 601}, {...q, expires_at: '2026-10-08T12:06:00.000Z'},
    {...q, items: [...q.items, ...q.items], merchandise_total_minor: 1200}, {...q, supplier_shop_id: id}]) {
    assert.equal(shared.SharedQuoteSchema.safeParse(invalid).success, false);
  }
  for (const invalid of [{...o, payment_enabled: true}, {...o, supplier_payable: 600},
    {...o, reservation_expires_at: '2026-10-08T12:31:00.000Z'}, {...o, merchandise_total_minor: 599},
    {...o, state: 'expired', closed_at: '2026-10-08T12:29:59.999Z', close_reason: 'reservation_expired'},
    {...o, state: 'cancelled', closed_at: o.reservation_expires_at, close_reason: 'buyer_cancelled'}]) {
    assert.equal(shared.SharedOrderSchema.safeParse(invalid).success, false);
  }
  assert.equal(shared.ReservationPageSchema.safeParse({items: [order, o], next_cursor: null}).success, true);
});

test('buyer input cannot supply identities, price, payment, contact or service authority', () => {
  assert.deepEqual(c.SubmitInputSchema.parse(submit), submit);
  for (const field of ['buyer_id', 'principal_id', 'tenant_id', 'seller_id', 'price_minor', 'mode', 'payment_state', 'delivery_ref', 'email', 'address', 'authorization']) {
    assert.equal(c.SubmitInputSchema.safeParse({ ...submit, [field]: 'injected' }).success, false, field);
  }
  assert.equal(c.QuoteInputSchema.safeParse({ ...input, items: [{ ...input.items[0], unit_price_minor: 1 }] }).success, false);
  assert.equal(c.CancelInputSchema.safeParse({ reason: 'seller_cancelled' }).success, false);
  assert.equal(c.SubmitInputSchema.safeParse({ ...submit, terms_sha256: digest + '\n' }).success, false);
  assert.equal(c.QuoteInputSchema.safeParse({ ...input, items: [{ sku: 'P0001\n', quantity: 1 }] }).success, false);
  assert.equal(c.QuoteSchema.safeParse({ ...quote, expires_at: quote.expires_at + '\n' }).success, false);
  assert.equal(c.OrderPageQuerySchema.safeParse({ cursor: 'cursor\n' }).success, false);
});

test('quote has bounded distinct lines and never reserves or claims payable money', () => {
  assert.equal(c.QuoteSchema.safeParse(quote).success, true);
  for (const value of [{ ...quote, reserves_stock: true }, { ...quote, amount_due_minor: 600 },
    { ...quote, merchandise_total_minor: 601 }, { ...quote, items: [{ ...quote.items[0], line_total_minor: 599 }] },
    { ...quote, items: [...quote.items, ...quote.items], merchandise_total_minor: 1200 },
    { ...quote, expires_at: '2026-10-08T12:05:00.001Z' }, { ...quote, quoted_at: '2026-02-30T12:00:00.000Z' }]) assert.equal(c.QuoteSchema.safeParse(value).success, false);
  for (const items of [[], Array(51).fill(input.items[0]), [input.items[0], input.items[0]], [{ sku: 'P0001', quantity: 0 }], [{ sku: 'P0001', quantity: 100 }]]) {
    assert.equal(c.QuoteInputSchema.safeParse({ ...input, items }).success, false);
  }
});

test('reservation state cannot be reported paid or shipped and closure obeys original deadline', () => {
  assert.equal(c.OrderSchema.safeParse(order).success, true);
  const expired = { ...order, state: 'expired', closed_at: order.reservation_expires_at, close_reason: 'reservation_expired', version: '2' };
  assert.equal(c.OrderSchema.safeParse(expired).success, true);
  assert.equal(c.OrderSchema.safeParse({ ...expired, closed_at: '2026-10-08T12:29:59.999Z' }).success, false);
  assert.equal(c.OrderSchema.safeParse({ ...order, state: 'cancelled', close_reason: 'buyer_cancelled', closed_at: '2026-10-08T12:01:00.000Z' }).success, true);
  for (const value of [{ ...order, state: 'paid' }, { ...order, state: 'shipped' }, { ...order, payment_state: 'reported_paid' },
    { ...order, supplier_payable: 600 }, { ...order, transfer_id: id }, { ...order, acceptance_id: id },
    { ...order, reservation_expires_at: '2026-10-08T12:31:00.000Z' }, { ...expired, close_reason: 'buyer_cancelled' }, { ...expired, state: 'cancelled', close_reason: 'buyer_cancelled' },
    { ...order, version: '9223372036854775808' }]) assert.equal(c.OrderSchema.safeParse(value).success, false);
});

test('every readiness branch keeps financial and fulfilment effects disabled', () => {
  const disabled = { profile: c.HOSTED_ORDER_PROFILE, reservation_enabled: false, reason: 'not_implemented', ...effects };
  const enabled = { ...disabled, reservation_enabled: true, reason: null };
  for (const v of [disabled, enabled]) {
    assert.equal(c.ReadinessSchema.safeParse(v).success, true);
    for (const key of Object.keys(effects)) assert.equal(c.ReadinessSchema.safeParse({ ...v, [key]: true }).success, false, key);
  }
  assert.equal(c.ReadinessSchema.safeParse({ ...enabled, reason: 'not_implemented' }).success, false);
  assert.equal(c.ReadinessSchema.safeParse({ ...disabled, reason: null }).success, false);
});

test('generated Draft2020-12 shapes agree on adversarial wire fields without claiming runtime authority', () => {
  const bundle = JSON.parse(readFileSync(new URL('../../contracts/guild-launchpad/v1/hosted-order.schema.json', import.meta.url), 'utf8'));
  const pairs: [string, z.ZodType, unknown][] = [
    ['quote-input', c.QuoteInputSchema, input], ['quote', c.QuoteSchema, quote], ['submit-input', c.SubmitInputSchema, submit],
    ['cancel-input', c.CancelInputSchema, {}],
    ['intent-lookup-query', c.IntentLookupQuerySchema, { store_slug: 'shop-one' }],
    ['order-page-query', c.OrderPageQuerySchema, { limit: 50, cursor: 'signed_cursor-value' }], ['order', c.OrderSchema, order],
    ['order-page', c.OrderPageSchema, { items: [order], next_cursor: null }],
    ['readiness', c.ReadinessSchema, { profile: c.HOSTED_ORDER_PROFILE, reservation_enabled: false, reason: 'not_implemented', ...effects }],
  ];
  const cases = pairs.flatMap(([name, schema, value]) => [
    { name, value, valid: schema.safeParse(value).success },
    { name, value: { ...(value as object), secret: 'forbidden' }, valid: false },
    { name, value: null, valid: false },
  ]);
  const result = spawnSync('python3', ['-c', `import json,sys\nfrom jsonschema import Draft202012Validator,FormatChecker\nx=json.load(sys.stdin)\nfor c in x['cases']:\n s=x['bundle']['$defs'][c['name']]\n Draft202012Validator.check_schema(s)\n assert Draft202012Validator(s,format_checker=FormatChecker()).is_valid(c['value']) == c['valid'],c\nprint(len(x['cases']))`], {
    input: JSON.stringify({ bundle, cases }), encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr); assert.equal(Number(result.stdout), 27);
  assert.match(bundle.$defs.quote.description, /five_minute_quote/);
  // Generated schema documents relational rules rather than pretending to grant stock/identity authority.
  assert.match(bundle.$defs.order.description, /authoritative_state/);
});
