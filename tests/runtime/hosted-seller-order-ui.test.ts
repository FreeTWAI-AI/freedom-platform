import assert from 'node:assert/strict';
import {test} from 'node:test';
import {HOSTED_ORDER_PROFILE, OrderSchema} from '../../contracts/guild-launchpad/v1/hosted-order.js';
import {sellerOrdersRoute, readSellerPage, readSellerCancel} from '../../apps/portal-web/src/modules/hosted-seller-order-state.js';
const id = '12345678-1234-4234-8234-123456789abc', other = '23456789-1234-4234-8234-123456789abc';
const order = OrderSchema.parse({profile: HOSTED_ORDER_PROFILE, store: {slug: 'small-shop', name: '小店'}, publication_revision: '1', currency: 'TWD',
  items: [{sku: 'P0001', title: '杯子', quantity: 2, unit_price_minor: 300, line_total_minor: 600}], merchandise_total_minor: 600,
  amount_due_minor: null, shipping_state: 'not_configured', tax_state: 'not_assessed', payment_state: 'not_enabled', terms_sha256: 'a'.repeat(64),
  payment_enabled: false, refund_enabled: false, fulfilment_enabled: false, money_movement_enabled: false,
  order_id: id, client_order_id: id, quote_id: id, version: '1', created_at: '2026-10-08T12:00:00.000Z', reservation_expires_at: '2026-10-08T12:30:00.000Z', state: 'reserved', closed_at: null, close_reason: null});
const cancelled = {...order, version: '2', state: 'cancelled', closed_at: '2026-10-08T12:01:00.000Z', close_reason: 'seller_cancelled'};

test('seller recovery accepts only the exact same-origin store locator grammar', () => {
  assert.deepEqual(sellerOrdersRoute(`#stores/${id}/${other}/orders`), {tenantId: id, instanceId: other});
  for (const hash of [`#stores/${id}/${other}`,`#stores/${id}/${other}/orders/extra`,`#stores/${id}/${other}/orders?buyer=x`,`#stores/${id}/${other}/orders\n`,`https://other.test/#stores/${id}/${other}/orders`, '#stores/%2F/../orders']) assert.equal(sellerOrdersRoute(hash), null);
});
test('strict owner history rejects duplicated orders and private extra fields and retains opaque cursor bytes', () => {
  const cursor = 'v1.server_signed.continuation';
  assert.equal(readSellerPage({items: [order], next_cursor: cursor})?.next_cursor, cursor);
  assert.ok(readSellerPage({items: [], next_cursor: null}));
  for (const raw of [{items: [order, order], next_cursor: null}, {items: [{...order, buyer_email: 'not-allowed'}], next_cursor: null}, {items: [order], next_cursor: ''}, {}]) assert.equal(readSellerPage(raw), null);
});
test('seller cancellation requires original identity, immutable terms and a newer terminal version', () => {
  assert.equal(readSellerCancel(cancelled, order)?.confirmed, true);
  assert.equal(readSellerCancel({...order, state: 'expired', version: '2', closed_at: order.reservation_expires_at, close_reason: 'reservation_expired'}, order)?.confirmed, true);
  assert.equal(readSellerCancel(order, order)?.confirmed, false);
  assert.equal(readSellerCancel({...cancelled, version: '1'}, order)?.confirmed, false);
  for (const raw of [{}, {...cancelled, order_id: other}, {...cancelled, client_order_id: other}, {...cancelled, quote_id: other}, {...cancelled, terms_sha256: 'b'.repeat(64)}, {...cancelled, store: {...order.store, slug: 'other-shop'}}]) assert.equal(readSellerCancel(raw, order), null);
  const later = {...order, version: '9007199254740993'};
  assert.equal(readSellerCancel({...cancelled, version: '9007199254740994'}, later)?.confirmed, true);
  assert.equal(readSellerCancel({...cancelled, version: '9007199254740992'}, later), null);
});
