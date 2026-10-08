import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buyerRoute, readOrder, readQuote, readCancelObservation} from '../../apps/portal-web/src/modules/hosted-order-state.js';
import {storeHtml} from '../../modules/agent-commerce/hosted/page.js';
import {HOSTED_ORDER_PROFILE} from '../../contracts/guild-launchpad/v1/hosted-order.js';
const id = '12345678-1234-4234-8234-123456789abc', other = '23456789-1234-4234-8234-123456789abc';
const terms = {profile: HOSTED_ORDER_PROFILE, store: {slug: 'small-shop', name: '小店'}, publication_revision: '1', currency: 'TWD',
  items: [{sku: 'P0001', title: '杯子', quantity: 2, unit_price_minor: 300, line_total_minor: 600}], merchandise_total_minor: 600,
  amount_due_minor: null, shipping_state: 'not_configured', tax_state: 'not_assessed', payment_state: 'not_enabled', terms_sha256: 'a'.repeat(64),
  payment_enabled: false, refund_enabled: false, fulfilment_enabled: false, money_movement_enabled: false};
const quote = {...terms, quote_id: id, quoted_at: '2026-10-08T12:00:00.000Z', expires_at: '2026-10-08T12:05:00.000Z', reserves_stock: false};
const order = {...terms, order_id: id, client_order_id: id, quote_id: id, version: '1', created_at: '2026-10-08T12:00:00.000Z', reservation_expires_at: '2026-10-08T12:30:00.000Z', state: 'reserved', closed_at: null, close_reason: null};
const body = {publication_revision: '1', items: [{sku: 'P0001', quantity: 2}]};
const submit = {quote_id: id, client_order_id: id, terms_sha256: terms.terms_sha256};

test('only bounded buyer hashes survive the existing login/onboarding destination gate', () => {
  assert.deepEqual(buyerRoute('#reservations'), {kind: 'lookup'});
  assert.deepEqual(buyerRoute('#reservations/small-shop'), {kind: 'shop', slug: 'small-shop'});
  assert.deepEqual(buyerRoute(`#reservations/order/${id}`), {kind: 'order', id});
  assert.deepEqual(buyerRoute(`#reservations/small-shop/intent/${id}`), {kind: 'intent', slug: 'small-shop', intent: id});
  for (const hash of ['#home', '#reservations/', '#reservations/../', '#reservations/%2F', '#reservations/small-shop?key=private', '#reservations/small-shop\n', `#reservations/order/${id}?buyer=other`, `#reservations/small-shop/intent/${id}/extra`, `https://other.test/#reservations/order/${id}`]) assert.equal(buyerRoute(hash), null, hash);
});
test('a valid quote for another store, revision or selection cannot become reviewed terms', () => {
  assert.ok(readQuote(quote, 'small-shop', body));
  for (const raw of [{}, {...quote, store: {...terms.store, slug: 'other-shop'}}, {...quote, publication_revision: '2'}, {...quote, payment_enabled: true}, {...quote, private_person: id}]) assert.equal(readQuote(raw, 'small-shop', body), null);
  assert.equal(readQuote(quote, 'small-shop', {...body, items: [{sku: 'P0002', quantity: 2}]}), null);
  assert.equal(readQuote(quote, 'small-shop', {...body, items: [{sku: 'P0001', quantity: 1}]}), null);
});
test('unreadable or unrelated successful order payload cannot confirm the held intent', () => {
  const expected = {kind: 'intent' as const, slug: 'small-shop', intent: id};
  assert.ok(readOrder(order, expected, submit));
  for (const raw of [{}, {...order, client_order_id: other}, {...order, quote_id: other}, {...order, terms_sha256: 'b'.repeat(64)}, {...order, store: {...terms.store, slug: 'other-shop'}}, {...order, amount_due_minor: 600}, {...order, state: 'paid'}]) assert.equal(readOrder(raw, expected, submit), null);
  assert.equal(readOrder(order, {kind: 'order', id: other}), null);
  // A committed retry can return current terminal state, never resurrect the old projection.
  assert.equal(readOrder({...order, version: '2', state: 'expired', closed_at: order.reservation_expires_at, close_reason: 'reservation_expired'}, expected, submit)?.state, 'expired');
});
test('public display links to member status without script, purchase action or private identity', () => {
  const html = storeHtml({slug: 'small-shop', name: '<小店>', brand: null, description: '展示', currency: 'TWD', products: [], revision: '1', published_at: '2026-10-08T12:00:00.000Z', transaction_state: 'not_enabled'});
  assert.match(html, /href="\/#reservations\/small-shop"/); assert.match(html, /登入查看預留狀態/);
  assert.match(html, /&lt;小店&gt;/); assert.doesNotMatch(html, /<script|<form|<button|購買|結帳|buyer_id|tenant_id|csrf/);
});


test('cancellation acknowledgement binds order, store and intent and requires a terminal state', () => {
  const expected = {id, slug: 'small-shop', intent: id};
  const cancelled = {...order, version: '2', state: 'cancelled', closed_at: '2026-10-08T12:01:00.000Z', close_reason: 'buyer_cancelled'};
  assert.equal(readCancelObservation(cancelled, expected)?.confirmed, true);
  assert.equal(readCancelObservation({...order, version: '2', state: 'expired', closed_at: order.reservation_expires_at, close_reason: 'reservation_expired'}, expected)?.confirmed, true);
  // A canonical old reserved DTO can be displayed by GET but cannot clear a held cancel.
  const observed = readCancelObservation(order, expected);
  assert.equal(observed?.order.state, 'reserved'); assert.equal(observed?.confirmed, false);
  for (const raw of [{}, {...cancelled, order_id: other}, {...cancelled, client_order_id: other}, {...cancelled, store: {...terms.store, slug: 'other-shop'}}]) assert.equal(readCancelObservation(raw, expected), null);
});
