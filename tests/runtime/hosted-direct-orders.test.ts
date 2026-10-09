import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { Pool } from 'pg';
import { createApp } from '../../apps/platform-api/src/app.js';
import { authenticate, type Actor } from '../../modules/identity-membership/service.js';
import { createDirectQuote } from '../../modules/agent-commerce/hosted/direct-quotes.js';
import { submitDirectOrder, readDirectOrder, readDirectOrderByIntent, cancelDirectOrder } from '../../modules/agent-commerce/hosted/direct-orders.js';
import { createRegistryHarness, type RegistryHarness, type Session, type Reply } from './module-registry-harness.js';

let h: RegistryHarness, runtime: Pool, app: ReturnType<typeof createApp>;
const role = `ho_runtime_${process.pid}_${Date.now()}`;
const ok = (r: Reply, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.data)); return r.data; };
async function actor(session: Session): Promise<Actor> { return authenticate(runtime, session.cookie.split('=')[1].split(';')[0]); }
const post = (path: string, session: Session, body: unknown, version?: string) => h.call('POST', path, session, body,
  { 'Idempotency-Key': randomUUID(), ...(version ? { 'If-Match': `"${version}"` } : {}) }, app);
async function fixture(stock = 3) {
  const owner = (await h.person('合成賣家')).session;
  await h.fullMember(owner.user.user_id, 'guild_commerce_sales');
  const t = await h.createTenant(owner, '合成直售商店');
  const plan = ok(await post(`/tenants/${t.tenantId}/application-launch-plans`, owner,
    h.planBody('guild_commerce_sales', t.workspaceId, 'hosted-store', 'hosted-store@1.0.0')), 201);
  const launched = await post(`/tenants/${t.tenantId}/application-installations`, owner,
    { plan_id: plan.plan_id, expected_plan_version: plan.version, configuration_digest: plan.configuration_digest });
  assert.ok([200, 202].includes(launched.status), JSON.stringify(launched.data));
  const instanceId = (await h.pool.query("SELECT instance_id FROM module_instances WHERE tenant_id=$1 AND module_key='storefront'", [t.tenantId])).rows[0].instance_id;
  const root = `/tenants/${t.tenantId}/storefronts/${instanceId}`, slug = `s-${randomUUID()}`;
  ok(await post(root + '/setup', owner, { slug, name: '合成直售商品', currency: 'TWD' }), 201);
  const product = ok(await post(root + '/products', owner, { title: '合成商品', price_minor: 100, stock }), 201);
  const current = ok(await h.call('GET', root, owner, undefined, {}, app));
  ok(await post(root + '/publish', owner, {}, current.version));
  // Explicit local fixture activation only. No production setting API/release exists.
  await h.pool.query('UPDATE commerce_storefront_profiles SET reservation_enabled=true WHERE instance_id=$1', [instanceId]);
  const b = await h.person('合成買家'), c = await h.person('另一合成買家');
  const buyerCommunity = randomUUID();
  await h.pool.query("INSERT INTO communities(community_id,name) VALUES($1,'合成買家社群')", [buyerCommunity]);
  await h.pool.query('UPDATE users SET community_id=$1 WHERE user_id=$2', [buyerCommunity, b.id]);
  return { ...t, instanceId, root, slug, owner, product, b, c, buyer: await actor(b.session), other: await actor(c.session) };
}
async function quote(s: Awaited<ReturnType<typeof fixture>>, buyer = s.buyer, quantity = 1, key = randomUUID()) {
  return createDirectQuote(runtime, buyer, s.slug, { publication_revision: '1', items: [{ sku: s.product.sku, quantity }] }, key);
}
const body = (q: Awaited<ReturnType<typeof quote>>, intent = randomUUID()) => ({ quote_id: q.quote_id, terms_sha256: q.terms_sha256, client_order_id: intent });
const code = (expected: string) => (e: unknown) => (e as { code?: string }).code === expected;
before(async () => {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url && ['127.0.0.1','localhost'].includes(new URL(url).hostname) && /^\/fp_[a-z0-9_]+$/.test(new URL(url).pathname), 'Explicit disposable loopback TEST_DATABASE_URL required');
  h = await createRegistryHarness('fp_direct_orders');
  await h.admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    GRANT USAGE ON SCHEMA ${h.schema} TO ${role}; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${h.schema} TO ${role};
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${h.schema} TO ${role}; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${h.schema} TO ${role};
    REVOKE INSERT,UPDATE,DELETE ON ${h.schema}.module_definitions,${h.schema}.application_definitions,${h.schema}.guild_application_offerings FROM ${role}`);
  const runtimeUrl = new URL(url); runtimeUrl.username = role; runtimeUrl.password = '';
  runtime = new Pool({ connectionString: runtimeUrl.toString(), options: `-c search_path=${h.schema} -c statement_timeout=20000`, max: 12 });
  app = createApp(runtime, h.origin, 'local', { guildLaunchpadEnabled: true, shopKeyPolicy: 'legacy-compatible' });
});
beforeEach(async () => h.reset());
after(async () => {
  await runtime?.end();
  if (h) { await h.stop(); const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL }); try { await admin.query(`DROP ROLE ${role}`); } finally { await admin.end(); } }
});

test('direct buyer outside seller tenant reserves once, resumes login, cancels CAS and replays current state without financial facts', async () => {
  const s = await fixture();
  assert.equal((await h.pool.query('SELECT 1 FROM tenant_memberships m JOIN principals p ON p.principal_id=m.principal_id WHERE tenant_id=$1 AND p.user_ref=$2', [s.tenantId, s.b.id])).rowCount, 0);
  const quoteKey = randomUUID(), q = await quote(s, s.buyer, 1, quoteKey), input = body(q), key = randomUUID();
  assert.deepEqual(await quote(s, s.buyer, 1, quoteKey), q, 'same-key quote retry preserves ID and original deadline');
  assert.equal((await h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1', [s.product.product_id])).rows[0].reserved, 0);
  const order = await submitDirectOrder(runtime, s.buyer, s.slug, input, key);
  assert.equal(order.state, 'reserved'); assert.equal(order.payment_enabled, false); assert.equal(order.amount_due_minor, null);
  assert.notEqual(s.buyer.community_id, (await actor(s.owner)).community_id);
  assert.equal((await h.call('GET', s.root, s.b.session, undefined, {}, app)).status, 404);
  const receipt = (await h.pool.query('SELECT scope_kind,response FROM scoped_command_receipts WHERE idempotency_key=$1', [key])).rows[0];
  assert.equal(receipt.scope_kind, 'personal'); assert.deepEqual(receipt.response, { id: order.order_id });
  const retried = await submitDirectOrder(runtime, s.buyer, s.slug, input, randomUUID());
  assert.equal(retried.order_id, order.order_id); assert.equal(retried.created_at, order.created_at);
  assert.equal(retried.reservation_expires_at, order.reservation_expires_at);
  await assert.rejects(submitDirectOrder(runtime, s.buyer, s.slug, body(q), randomUUID()), code('quote_consumed'));
  await assert.rejects(readDirectOrder(runtime, s.other, order.order_id), code('hosted_order_not_found'));
  await assert.rejects(cancelDirectOrder(runtime, s.other, order.order_id, randomUUID(), '1'), code('hosted_order_not_found'));
  const fresh = await actor(await h.signIn(s.b.email));
  assert.equal((await readDirectOrderByIntent(runtime, fresh, s.slug, input.client_order_id)).order_id, order.order_id);
  await assert.rejects(cancelDirectOrder(runtime, fresh, order.order_id, randomUUID(), '2'), code('version_conflict'));
  const cancelKey = randomUUID(), cancelled = await cancelDirectOrder(runtime, fresh, order.order_id, cancelKey, '1');
  assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.version, '2');
  assert.equal((await cancelDirectOrder(runtime, fresh, order.order_id, cancelKey, '1')).state, 'cancelled');
  assert.equal((await submitDirectOrder(runtime, fresh, s.slug, input, key)).state, 'cancelled');
  assert.equal((await h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1', [s.product.product_id])).rows[0].reserved, 0);
  for (const table of ['commerce_transfers','commerce_payment_events','commerce_supplier_payables','commerce_settlement_records'])
    assert.equal((await h.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0);
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM scoped_transition_journal WHERE aggregate_id=$1 AND aggregate_type='hosted_order'", [order.order_id])).rows[0].n, 2);
});

test('two distinct buyers race stock=1; stock edit below reservation is a domain conflict', async () => {
  const s = await fixture(1), a = await quote(s), b = await quote(s, s.other);
  const results = await Promise.allSettled([submitDirectOrder(runtime, s.buyer, s.slug, body(a), randomUUID()), submitDirectOrder(runtime, s.other, s.slug, body(b), randomUUID())]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const failure = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
  assert.equal(failure.reason.code, 'stock_unavailable');
  const change = await h.call('PATCH', s.root + '/products/' + s.product.product_id, s.owner, { stock: 0 }, { 'Idempotency-Key': randomUUID(), 'If-Match': '"1"' }, app);
  assert.equal(change.status, 409); assert.equal(change.data.code, 'stock_below_reserved');
  assert.equal((await h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1', [s.product.product_id])).rows[0].reserved, 1);
});

test('publication/price/current pause authority precedes receipts; pause permits history and release', async () => {
  const s = await fixture(), q = await quote(s);
  const orderInput = body(q), key = randomUUID(), order = await submitDirectOrder(runtime, s.buyer, s.slug, orderInput, key);
  await h.pool.query('UPDATE commerce_storefront_profiles SET reservation_enabled=false WHERE instance_id=$1', [s.instanceId]);
  await assert.rejects(submitDirectOrder(runtime, s.buyer, s.slug, orderInput, key), code('reservation_not_enabled'));
  assert.equal((await readDirectOrder(runtime, s.buyer, order.order_id)).state, 'reserved');
  assert.equal((await cancelDirectOrder(runtime, s.buyer, order.order_id, randomUUID(), '1')).state, 'cancelled');
  await h.pool.query('UPDATE commerce_storefront_profiles SET reservation_enabled=true WHERE instance_id=$1', [s.instanceId]);
  ok(await h.call('PATCH', s.root + '/products/' + s.product.product_id, s.owner, { price_minor: 200 }, { 'Idempotency-Key': randomUUID(), 'If-Match': '"1"' }, app));
  await assert.rejects(quote(s), code('publication_changed'));
});

test('multi-line shortage rolls back every reserve, order, receipt and journal', async () => {
  const s = await fixture(1);
  const second = ok(await post(s.root + '/products', s.owner, { title: '第二件合成商品', price_minor: 500, stock: 1 }), 201);
  const current = ok(await h.call('GET', s.root, s.owner, undefined, {}, app)); ok(await post(s.root + '/publish', s.owner, {}, current.version));
  const q = await createDirectQuote(runtime, s.buyer, s.slug, { publication_revision: '2', items: [{ sku: s.product.sku, quantity: 1 }, { sku: second.sku, quantity: 1 }] }, randomUUID());
  const other = await createDirectQuote(runtime, s.other, s.slug, { publication_revision: '2', items: [{ sku: second.sku, quantity: 1 }] }, randomUUID());
  await submitDirectOrder(runtime, s.other, s.slug, body(other), randomUUID());
  const key = randomUUID(); await assert.rejects(submitDirectOrder(runtime, s.buyer, s.slug, body(q), key), code('stock_unavailable'));
  assert.equal((await h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1', [s.product.product_id])).rows[0].reserved, 0);
  assert.equal((await h.pool.query('SELECT count(*)::int AS n FROM commerce_orders')).rows[0].n, 1);
  assert.equal((await h.pool.query('SELECT 1 FROM scoped_command_receipts WHERE idempotency_key=$1', [key])).rowCount, 0);
});

test('direct profile refuses financial rows, foreign-store lines and mutation of immutable profile/quote', async () => {
  const s = await fixture(), q = await quote(s), order = await submitDirectOrder(runtime, s.buyer, s.slug, body(q), randomUUID());
  const shop = (await h.pool.query('SELECT supply_shop_id FROM commerce_storefront_profiles WHERE instance_id=$1', [s.instanceId])).rows[0].supply_shop_id;
  await assert.rejects(h.pool.query(`INSERT INTO commerce_transfers(transfer_id,order_id,internal_shop_id,total_minor,delivery_ref) VALUES($1,$2,$3,100,'not-a-shipment')`, [randomUUID(), order.order_id, shop]), code('23503'));
  await assert.rejects(h.pool.query(`INSERT INTO commerce_payment_events(event_id,shop_id,external_event_id,request_sha256,order_id,event_type,provider,transaction_ref,amount_minor)
    VALUES($1,$2,$3,$4,$5,'paid','synthetic',$3,100)`, [randomUUID(), shop, randomUUID(), '0'.repeat(64), order.order_id]),
    (e: unknown) => (e as { constraint?: string }).constraint === 'commerce_payment_imported_order');
  await assert.rejects(h.pool.query("UPDATE commerce_orders SET buyer_payment='reported_paid' WHERE order_id=$1", [order.order_id]), code('23514'));
  await assert.rejects(h.pool.query("UPDATE commerce_orders SET order_profile='imported_reseller' WHERE order_id=$1", [order.order_id]), code('23514'));
  await assert.rejects(h.pool.query('UPDATE commerce_order_quotes SET expires_at=expires_at WHERE quote_id=$1', [q.quote_id]), code('23514'));
  const foreign = await fixture();
  const line = (await h.pool.query('SELECT selection_id FROM commerce_selections WHERE item_id=$1', [foreign.product.product_id])).rows[0];
  await assert.rejects(h.pool.query(`INSERT INTO commerce_order_lines(order_id,selection_id,item_id,quantity,snapshot,order_profile) VALUES($1,$2,$3,1,'{}','hosted_direct_reservation')`,
    [order.order_id, line.selection_id, foreign.product.product_id]), code('23514'));
  await assert.rejects(h.pool.query('UPDATE commerce_order_lines SET selection_id=$2,item_id=$3 WHERE order_id=$1',
    [order.order_id, line.selection_id, foreign.product.product_id]), code('23514'));
});

/** A retained historical quote fixture, not a clock override or live approval.
 * Immutable rows are INSERTed; production triggers are never disabled. */
async function pastQuote(id: string, minutes = 40) {
  const now = (await h.pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now;
  const quoted = new Date(now.getTime() - minutes * 60000), expires = new Date(quoted.getTime() + 300000), next = randomUUID();
  await h.pool.query(`INSERT INTO commerce_order_quotes SELECT $2::uuid,tenant_id,instance_id,public_shop_id,buyer_principal_id,publication_id,
    terms || jsonb_build_object('quote_id',$2::text,'quoted_at',$3::text,'expires_at',$4::text),bindings,terms_sha256,$3::timestamptz,$4::timestamptz
    FROM commerce_order_quotes WHERE quote_id=$1`, [id, next, quoted.toISOString(), expires.toISOString()]);
  return next;
}
test('expired quote refuses a fresh effect; historical committed intent recovers and exact expired order releases once through archive', async () => {
  const s = await fixture(), q = await quote(s), expiredQuote = await pastQuote(q.quote_id), intent = randomUUID();
  await assert.rejects(submitDirectOrder(runtime, s.buyer, s.slug, { ...body(q, intent), quote_id: expiredQuote }, randomUUID()), code('quote_expired'));
  const source = await submitDirectOrder(runtime, s.buyer, s.slug, body(q), randomUUID());
  await cancelDirectOrder(runtime, s.buyer, source.order_id, randomUUID(), '1');
  const orderId = randomUUID();
  // Retained order at a historical DB clock, built from actual service terms.
  const input = { quote_id: expiredQuote, terms_sha256: q.terms_sha256, client_order_id: intent };
  const { digest } = await import('../../packages/db/index.js');
  await h.pool.query(`INSERT INTO commerce_orders(order_id,public_shop_id,external_id,request_sha256,currency,total_minor,created_at,expires_at,
    order_profile,quote_id,buyer_principal_id,client_order_id,reservation_state,reservation_version)
    SELECT $2,o.public_shop_id,o.buyer_principal_id::text||':'||$4::text,$5,o.currency,o.total_minor,quote.quoted_at+interval '1 minute',quote.quoted_at+interval '31 minutes',
      'hosted_direct_reservation',$3,o.buyer_principal_id,$4::uuid,'reserved',1 FROM commerce_orders o JOIN commerce_order_quotes quote ON quote.quote_id=$3 WHERE order_id=$1`,
  [source.order_id, orderId, expiredQuote, intent, digest(input)]);
  await h.pool.query(`INSERT INTO commerce_order_lines SELECT $2,selection_id,transfer_id,item_id,quantity,snapshot,acceptance_id,listing_sha256,order_profile
    FROM commerce_order_lines WHERE order_id=$1`, [source.order_id, orderId]);
  await h.pool.query('UPDATE commerce_items SET reserved=reserved+1 WHERE item_id=$1', [s.product.product_id]);
  const recovered = await submitDirectOrder(runtime, s.buyer, s.slug, input, randomUUID());
  assert.equal(recovered.order_id, orderId); assert.equal(recovered.state, 'expired'); assert.equal(recovered.version, '2');
  await h.pool.query("UPDATE module_instances SET status='archived' WHERE instance_id=$1", [s.instanceId]);
  assert.equal((await readDirectOrder(runtime, s.buyer, orderId)).state, 'expired');
  assert.equal((await cancelDirectOrder(runtime, s.buyer, orderId, randomUUID(), '2')).state, 'expired');
  assert.equal((await h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1', [s.product.product_id])).rows[0].reserved, 0);
  assert.equal((await h.pool.query("SELECT 1 FROM scoped_transition_journal WHERE aggregate_id=$1 AND aggregate_version=2", [orderId])).rowCount, 1);
});

test('session expiry at receipt storage rolls back reservation and every command fact', async () => {
  const s = await fixture(), q = await quote(s), key = randomUUID();
  await h.pool.query(`CREATE FUNCTION ho_test_expire_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.operation='storefront.order.submit' THEN UPDATE sessions SET expires_at=clock_timestamp()-interval '1 millisecond'
      WHERE user_id=(SELECT user_ref FROM principals WHERE principal_id=NEW.principal_id); END IF; RETURN NEW; END $$;
    CREATE TRIGGER ho_test_expire_session BEFORE INSERT ON scoped_command_receipts FOR EACH ROW EXECUTE FUNCTION ho_test_expire_session()`);
  try {
    await assert.rejects(submitDirectOrder(runtime, s.buyer, s.slug, body(q), key), code('session_expired'));
    assert.equal((await h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1', [s.product.product_id])).rows[0].reserved, 0);
    assert.equal((await h.pool.query('SELECT count(*)::int AS n FROM commerce_orders')).rows[0].n, 0);
    assert.equal((await h.pool.query('SELECT 1 FROM scoped_command_receipts WHERE idempotency_key=$1', [key])).rowCount, 0);
  } finally { await h.pool.query('DROP TRIGGER ho_test_expire_session ON scoped_command_receipts; DROP FUNCTION ho_test_expire_session()'); }
});

test('quote decision clock crosses an actual receipt-insert barrier and rolls back fresh effects', async () => {
  const s = await fixture(), q = await quote(s), key = randomUUID();
  const gate = await h.pool.connect();
  await gate.query('SELECT pg_advisory_lock(918273645)');
  await h.pool.query(`CREATE FUNCTION ho_test_receipt_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.operation='storefront.order.submit' THEN PERFORM pg_advisory_xact_lock(918273645); END IF; RETURN NEW; END $$;
    CREATE TRIGGER ho_test_receipt_gate AFTER INSERT ON scoped_command_receipts FOR EACH ROW EXECUTE FUNCTION ho_test_receipt_gate()`);
  // Full five-minute terms; this retained quote has one second left on the DB clock.
  const near = await pastQuote(q.quote_id, 299 / 60);
  const pending = submitDirectOrder(runtime, s.buyer, s.slug, { ...body(q), quote_id: near }, key).then(value => ({ value }), error => ({ error }));
  try {
    const end = Date.now() + 5000; let blocked = false, expired = false;
    while (Date.now() < end) {
      const state = (await h.pool.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event='advisory' AND query LIKE '%INSERT INTO scoped_command_receipts%') AS blocked,
        (SELECT expires_at<=clock_timestamp() FROM commerce_order_quotes WHERE quote_id=$1) AS expired`, [near])).rows[0];
      blocked ||= state.blocked; expired = state.expired;
      if (blocked && expired) break;
    }
    assert.equal(blocked, true, 'actual receipt INSERT waited on the test barrier'); assert.equal(expired, true);
  } finally { await gate.query('SELECT pg_advisory_unlock(918273645)'); gate.release(); }
  try {
    const result = await pending; assert.ok('error' in result); assert.equal(result.error.code, 'quote_expired');
    assert.equal((await h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1', [s.product.product_id])).rows[0].reserved, 0);
    assert.equal((await h.pool.query('SELECT count(*)::int AS n FROM commerce_orders')).rows[0].n, 0);
    assert.equal((await h.pool.query('SELECT 1 FROM scoped_command_receipts WHERE idempotency_key=$1', [key])).rowCount, 0);
  } finally { await h.pool.query('DROP TRIGGER ho_test_receipt_gate ON scoped_command_receipts; DROP FUNCTION ho_test_receipt_gate()'); }
});

test('100 polls use bounded ID receipts and a cached read reference still expires exactly once', async () => {
  const s = await fixture(), q = await quote(s), intent = randomUUID();
  const source = await submitDirectOrder(runtime, s.buyer, s.slug, body(q), randomUUID());
  await cancelDirectOrder(runtime, s.buyer, source.order_id, randomUUID(), '1');
  // Historical committed order has three seconds left. No production clock or
  // immutable trigger is modified. Its actual buyer and quote bindings persist.
  const retainedQuote = await pastQuote(q.quote_id, 30 + 57 / 60), orderId = randomUUID();
  const { digest } = await import('../../packages/db/index.js');
  await h.pool.query(`INSERT INTO commerce_orders(order_id,public_shop_id,external_id,request_sha256,currency,total_minor,created_at,expires_at,
    order_profile,quote_id,buyer_principal_id,client_order_id,reservation_state,reservation_version)
    SELECT $2,o.public_shop_id,o.buyer_principal_id::text||':'||$4::text,$5,o.currency,o.total_minor,quote.quoted_at+interval '1 minute',quote.quoted_at+interval '31 minutes',
      'hosted_direct_reservation',$3,o.buyer_principal_id,$4::uuid,'reserved',1 FROM commerce_orders o JOIN commerce_order_quotes quote ON quote.quote_id=$3 WHERE order_id=$1`,
  [source.order_id, orderId, retainedQuote, intent, digest({ quote_id: retainedQuote, terms_sha256: q.terms_sha256, client_order_id: intent })]);
  await h.pool.query(`INSERT INTO commerce_order_lines SELECT $2,selection_id,transfer_id,item_id,quantity,snapshot,acceptance_id,listing_sha256,order_profile
    FROM commerce_order_lines WHERE order_id=$1`, [source.order_id, orderId]);
  await h.pool.query('UPDATE commerce_items SET reserved=reserved+1 WHERE item_id=$1', [s.product.product_id]);
  assert.equal((await readDirectOrder(runtime, s.buyer, orderId)).state, 'reserved');
  // A projection can cross the actual database expiry before the final fence.
  // Retry only that deliberate conflict once, with the same public read tuple;
  // other failures and a second conflict still fail this test immediately.
  const current = async <T>(read: () => Promise<T>) => {
    try { return await read(); }
    catch (error) {
      if ((error as { code?: string }).code !== 'reservation_clock_changed') throw error;
      return read();
    }
  };
  for (let n = 0; n < 100; n++) {
    await current(() => readDirectOrder(runtime, s.buyer, orderId));
    await current(() => readDirectOrderByIntent(runtime, s.buyer, s.slug, intent));
  }
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM scoped_command_receipts WHERE operation='storefront.order.read' AND target_id=ANY($1::uuid[])", [[orderId, intent]])).rows[0].n, 2);
  const end = Date.now() + 5000;
  while (Date.now() < end && !(await h.pool.query('SELECT expires_at<=clock_timestamp() AS expired FROM commerce_orders WHERE order_id=$1', [orderId])).rows[0].expired) { /* DB clock, no wall-time sleep */ }
  assert.equal((await current(() => readDirectOrder(runtime, s.buyer, orderId))).state, 'expired');
  assert.equal((await current(() => readDirectOrderByIntent(runtime, s.buyer, s.slug, intent))).state, 'expired');
  assert.equal((await h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1', [s.product.product_id])).rows[0].reserved, 0);
  assert.equal((await h.pool.query("SELECT 1 FROM scoped_transition_journal WHERE aggregate_id=$1 AND aggregate_version=2", [orderId])).rowCount, 1);
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM scoped_command_receipts WHERE operation='storefront.order.read' AND target_id=ANY($1::uuid[])", [[orderId, intent]])).rows[0].n, 2);
  const absent = randomUUID();
  await assert.rejects(readDirectOrderByIntent(runtime, s.buyer, s.slug, absent), code('hosted_order_not_found'));
  assert.equal((await h.pool.query("SELECT 1 FROM scoped_command_receipts WHERE operation='storefront.order.read' AND target_id=$1", [absent])).rowCount, 0);
});

test('real imported acceptance/payment facts cannot be inserted or reassigned to a direct order', async () => {
  const s = await fixture(), q = await quote(s), direct = await submitDirectOrder(runtime, s.buyer, s.slug, body(q), randomUUID());
  // Separate imported reseller fixture uses its actual member/merchant commands;
  // no acceptance, transfer or payable is ever created for direct sale.
  const supply = ok(await post('/commerce/import', s.owner, { confirmed: true, manifest: {
    schema: 'freedom-shop/v1', kind: 'internal', access: 'authenticated', name: '合成進口供貨', description: '測試',
    website_url: 'https://supplier.example.test', contact: 'synthetic', currency: 'TWD', products: [{ sku: 'IMPORT', title: '合成進口品', description: '測試',
      photo_url: null, price_minor: 50, shipping_minor: 0, stock: 3, shipping_terms: 'synthetic', return_terms: 'synthetic' }],
  } }), 201);
  const item = (await h.pool.query('SELECT item_id FROM commerce_items WHERE shop_id=$1', [supply.shop_id])).rows[0];
  const retail = ok(await post('/commerce/import', s.c.session, { confirmed: true, manifest: {
    schema: 'freedom-shop/v1', kind: 'public', name: '合成轉售', description: '測試', website_url: 'https://retail.example.test', contact: 'synthetic', currency: 'TWD',
    selections: [{ item_id: item.item_id, retail_price_minor: 100, sale_terms: 'synthetic' }],
  } }), 201);
  const selection = (await h.pool.query('SELECT * FROM commerce_selections WHERE shop_id=$1', [retail.shop_id])).rows[0];
  ok(await post(`/commerce/selections/${selection.selection_id}/distribution-acceptance`, s.owner,
    { decision: 'accepted', listing_sha256: selection.listing_sha256, note: 'synthetic imported acceptance' }, String(selection.aggregate_version)));
  const key = ok(await post(`/commerce/shops/${retail.shop_id}/key`, s.c.session, {})).token;
  const machine = async (path: string, input: unknown) => {
    const response = await app.request(h.origin + '/shop-api/v1' + path, { method: 'POST', headers: {
      Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(input) });
    const result = await response.json() as Record<string, any>;
    assert.ok([200,201].includes(response.status), JSON.stringify(result)); return result;
  };
  const imported = await machine('/orders', { external_id: randomUUID(), items: [{ selection_id: selection.selection_id, quantity: 1, delivery_ref: 'synthetic-opaque-ref' }] });
  await machine(`/orders/${imported.order_id}/payment`, { event_id: randomUUID(), type: 'paid', provider: 'synthetic', transaction_ref: randomUUID(),
    amount_minor: 100, currency: 'TWD', mode: 'test', verification: 'provider_verified_by_merchant' });
  const fk = (name: string) => (e: unknown) => (e as { constraint?: string }).constraint === name;
  await assert.rejects(h.pool.query('UPDATE commerce_transfers SET order_id=$2 WHERE order_id=$1', [imported.order_id, direct.order_id]), fk('commerce_transfer_imported_order'));
  await assert.rejects(h.pool.query('UPDATE commerce_payment_events SET order_id=$2 WHERE order_id=$1', [imported.order_id, direct.order_id]), fk('commerce_payment_imported_order'));
  const payable = (await h.pool.query('SELECT * FROM commerce_supplier_payables WHERE order_id=$1', [imported.order_id])).rows[0];
  assert.ok(payable);
  await assert.rejects(h.pool.query(`INSERT INTO commerce_supplier_payables(payable_id,order_id,transfer_id,selection_id,acceptance_id,listing_sha256,beneficiary_user_id,
    supplier_net_minor,shipping_minor,tax_minor,currency,source_payment_event_id) SELECT $2,$3,transfer_id,selection_id,acceptance_id,listing_sha256,beneficiary_user_id,
    supplier_net_minor,shipping_minor,tax_minor,currency,source_payment_event_id FROM commerce_supplier_payables WHERE payable_id=$1`,
  [payable.payable_id, randomUUID(), direct.order_id]), fk('commerce_payable_imported_order'));
  await assert.rejects(h.pool.query('UPDATE commerce_supplier_payables SET order_id=$2 WHERE payable_id=$1', [payable.payable_id, direct.order_id]),
    (e: unknown) => /append-only/.test((e as Error).message));
  assert.equal((await h.pool.query('SELECT 1 FROM commerce_supplier_payables WHERE order_id=$1', [direct.order_id])).rowCount, 0);
});

test('requested item 101 makes physical expiry progress without cycling an unrelated first-100 batch', async () => {
  const s = await fixture(1);
  for (let n = 2; n <= 101; n++) ok(await post(s.root + '/products', s.owner, { title: '合成商品', price_minor: 100, stock: 1 }), 201);
  const current = ok(await h.call('GET', s.root, s.owner, undefined, {}, app)); ok(await post(s.root + '/publish', s.owner, {}, current.version));
  const template = await createDirectQuote(runtime, s.buyer, s.slug,
    { publication_revision: '2', items: [{ sku: s.product.sku, quantity: 1 }] }, randomUUID());
  const source = (await h.pool.query('SELECT * FROM commerce_order_quotes WHERE quote_id=$1', [template.quote_id])).rows[0];
  const items = (await h.pool.query(`SELECT i.item_id,i.sku,l.selection_id FROM commerce_items i JOIN commerce_selections l USING(item_id)
    WHERE l.shop_id=$1 ORDER BY i.sku`, [source.public_shop_id])).rows;
  assert.equal(items.length, 101);
  const now = (await h.pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now;
  const quoted = new Date(now.getTime() - 40 * 60000), created = new Date(quoted.getTime() + 60000);
  const { digest } = await import('../../packages/db/index.js');
  // Explicit retained-history fixtures: real shop/member/product bindings,
  // deterministic ordered IDs, one expired physical reservation per item.
  for (const [index, item] of items.entries()) {
    const orderId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, quoteId = randomUUID(), intent = randomUUID();
    const line = { ...template.items[0], sku: item.sku }, bindings = [{ ...item, version: '1', quantity: 1 }];
    const hash = digest({ synthetic_retained_quote: quoteId, bindings });
    const terms = { ...template, quote_id: quoteId, items: [line], terms_sha256: hash,
      quoted_at: quoted.toISOString(), expires_at: new Date(quoted.getTime() + 300000).toISOString() };
    await h.pool.query(`INSERT INTO commerce_order_quotes(quote_id,tenant_id,instance_id,public_shop_id,buyer_principal_id,publication_id,terms,bindings,terms_sha256,quoted_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10::timestamptz+interval '5 minutes')`,
    [quoteId, source.tenant_id, source.instance_id, source.public_shop_id, source.buyer_principal_id, source.publication_id, terms, JSON.stringify(bindings), hash, quoted]);
    await h.pool.query(`INSERT INTO commerce_orders(order_id,public_shop_id,external_id,request_sha256,currency,total_minor,created_at,expires_at,
      order_profile,quote_id,buyer_principal_id,client_order_id,reservation_state,reservation_version)
      VALUES($1,$2,$3,$4,'TWD',100,$5,$5::timestamptz+interval '30 minutes','hosted_direct_reservation',$6,$7,$8,'reserved',1)`,
    [orderId, source.public_shop_id, `${source.buyer_principal_id}:${intent}`, hash, created, quoteId, source.buyer_principal_id, intent]);
    await h.pool.query(`INSERT INTO commerce_order_lines(order_id,selection_id,item_id,quantity,snapshot,order_profile)
      VALUES($1,$2,$3,1,$4,'hosted_direct_reservation')`, [orderId, item.selection_id, item.item_id, line]);
    await h.pool.query('UPDATE commerce_items SET reserved=1 WHERE item_id=$1', [item.item_id]);
  }
  const target = items[100], targetId = '00000000-0000-4000-8000-000000000101';
  const fresh = await createDirectQuote(runtime, s.other, s.slug, { publication_revision: '2', items: [{ sku: target.sku, quantity: 1 }] }, randomUUID());
  const states = (await h.pool.query('SELECT reservation_state,count(*)::int AS n FROM commerce_orders GROUP BY reservation_state')).rows;
  assert.deepEqual(states.sort((a, b) => a.reservation_state.localeCompare(b.reservation_state)), [{ reservation_state: 'expired', n: 1 }, { reservation_state: 'reserved', n: 100 }]);
  assert.equal((await h.pool.query('SELECT reservation_state FROM commerce_orders WHERE order_id=$1', [targetId])).rows[0].reservation_state, 'expired');
  assert.equal((await h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1', [target.item_id])).rows[0].reserved, 0);
  const reserved = await submitDirectOrder(runtime, s.other, s.slug, body(fresh), randomUUID());
  assert.equal(reserved.state, 'reserved');
  assert.equal((await h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1', [target.item_id])).rows[0].reserved, 1);
  assert.equal((await h.pool.query('SELECT 1 FROM scoped_transition_journal WHERE aggregate_id=$1 AND aggregate_version=2', [targetId])).rowCount, 1);
});

// Local diagnostic only: original cases above remain byte-identical to 41c.
// These barriers execute real SQL on the same transaction; no clock, DTO,
// receipt result or production trigger is mocked/disabled.
async function diagnosticRetainedOrder() {
  const s = await fixture(), q = await quote(s), intent = randomUUID();
  const source = await submitDirectOrder(runtime, s.buyer, s.slug, body(q), randomUUID());
  await cancelDirectOrder(runtime, s.buyer, source.order_id, randomUUID(), '1');
  // Historical committed order has three seconds left. No production clock or
  // immutable trigger is modified. Its actual buyer and quote bindings persist.
  const retainedQuote = await pastQuote(q.quote_id, 30 + 57 / 60), orderId = randomUUID();
  const { digest } = await import('../../packages/db/index.js');
  await h.pool.query(`INSERT INTO commerce_orders(order_id,public_shop_id,external_id,request_sha256,currency,total_minor,created_at,expires_at,
    order_profile,quote_id,buyer_principal_id,client_order_id,reservation_state,reservation_version)
    SELECT $2,o.public_shop_id,o.buyer_principal_id::text||':'||$4::text,$5,o.currency,o.total_minor,quote.quoted_at+interval '1 minute',quote.quoted_at+interval '31 minutes',
      'hosted_direct_reservation',$3,o.buyer_principal_id,$4::uuid,'reserved',1 FROM commerce_orders o JOIN commerce_order_quotes quote ON quote.quote_id=$3 WHERE order_id=$1`,
  [source.order_id, orderId, retainedQuote, intent, digest({ quote_id: retainedQuote, terms_sha256: q.terms_sha256, client_order_id: intent })]);
  await h.pool.query(`INSERT INTO commerce_order_lines SELECT $2,selection_id,transfer_id,item_id,quantity,snapshot,acceptance_id,listing_sha256,order_profile
    FROM commerce_order_lines WHERE order_id=$1`, [source.order_id, orderId]);
  await h.pool.query('UPDATE commerce_items SET reserved=reserved+1 WHERE item_id=$1', [s.product.product_id]);
  return { s, orderId, intent };
}
async function diagnosticWaitForExpiry(orderId: string, queryMarker: string) {
  const end = Date.now() + 10000;
  let blocked = false, expired = false;
  while (Date.now() < end) {
    const state = (await h.pool.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event='advisory' AND query LIKE $2) AS blocked,
      (SELECT expires_at<=clock_timestamp() FROM commerce_orders WHERE order_id=$1) AS expired`,
    [orderId, `%${queryMarker}%`])).rows[0];
    blocked ||= state.blocked; expired = state.expired;
    if (blocked && expired) break;
  }
  assert.equal(blocked, true, 'observed the actual command blocked at the selected SQL barrier');
  assert.equal(expired, true, 'database clock reached the immutable reservation deadline');
}
async function diagnosticAssertTerminal(f: Awaited<ReturnType<typeof diagnosticRetainedOrder>>) {
  const { s, orderId, intent } = f;
  for (let n = 0; n < 100; n++) {
    assert.equal((await readDirectOrder(runtime, s.buyer, orderId)).state, 'expired');
    assert.equal((await readDirectOrderByIntent(runtime, s.buyer, s.slug, intent)).state, 'expired');
  }
  assert.deepEqual((await h.pool.query('SELECT reservation_state,reservation_version::text,close_reason FROM commerce_orders WHERE order_id=$1', [orderId])).rows[0],
    { reservation_state: 'expired', reservation_version: '2', close_reason: 'reservation_expired' });
  assert.equal((await h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1', [s.product.product_id])).rows[0].reserved, 0);
  assert.equal((await h.pool.query("SELECT 1 FROM scoped_transition_journal WHERE aggregate_id=$1 AND aggregate_version=2", [orderId])).rowCount, 1);
  const receipts = (await h.pool.query(`SELECT idempotency_key,response FROM scoped_command_receipts
    WHERE operation='storefront.order.read' AND target_id=ANY($1::uuid[])`, [[orderId, intent]])).rows;
  const { digest } = await import('../../packages/db/index.js');
  assert.deepEqual(receipts.map(r => r.idempotency_key).sort(),
    [`order-read-${orderId}`, `intent-read-${digest({ slug: s.slug, client_order_id: intent })}`].sort());
  for (const receipt of receipts) assert.deepEqual(receipt.response, { id: orderId });
}

test('diagnostic A: actual read receipt INSERT crosses expiry before projection and releases once', async () => {
  const gate = await h.pool.connect();
  await gate.query('SELECT pg_advisory_lock(918273646)');
  let pending: Promise<{ value?: unknown; error?: unknown }> | undefined;
  try {
    const f = await diagnosticRetainedOrder();
    await h.pool.query(`CREATE FUNCTION ho_diag_read_receipt_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.operation='storefront.order.read' AND NEW.idempotency_key='order-read-${f.orderId}'
        THEN
          IF NOT EXISTS(SELECT 1 FROM commerce_orders WHERE order_id=NEW.target_id AND expires_at>clock_timestamp())
            THEN RAISE EXCEPTION 'diagnostic fixture expired before receipt barrier'; END IF;
          PERFORM pg_advisory_xact_lock(918273646);
        END IF; RETURN NEW; END $$;
      CREATE TRIGGER ho_diag_read_receipt_gate AFTER INSERT ON scoped_command_receipts
      FOR EACH ROW EXECUTE FUNCTION ho_diag_read_receipt_gate()`);
    pending = readDirectOrder(runtime, f.s.buyer, f.orderId).then(value => ({ value }), error => ({ error }));
    try { await diagnosticWaitForExpiry(f.orderId, 'INSERT INTO scoped_command_receipts'); }
    finally { await gate.query('SELECT pg_advisory_unlock(918273646)'); }
    const result = await pending;
    assert.ok(!('error' in result), String(result.error));
    assert.equal((result.value as { state: string }).state, 'expired');
    await diagnosticAssertTerminal(f);
  } finally {
    await gate.query('SELECT pg_advisory_unlock(918273646)'); gate.release();
    await pending;
    await h.pool.query('DROP TRIGGER IF EXISTS ho_diag_read_receipt_gate ON scoped_command_receipts; DROP FUNCTION IF EXISTS ho_diag_read_receipt_gate()');
  }
});

test('diagnostic B: actual reserved projection crosses expiry, exact error then original read key recovers', async () => {
  const f = await diagnosticRetainedOrder(), { s, orderId, intent } = f;
  assert.equal((await readDirectOrder(runtime, s.buyer, orderId)).state, 'reserved');
  assert.equal((await readDirectOrderByIntent(runtime, s.buyer, s.slug, intent)).state, 'reserved');
  const { directCommand } = await import('../../modules/agent-commerce/hosted/direct-authority.js');
  const { directOrderView } = await import('../../modules/agent-commerce/hosted/direct-effects.js');
  const gate = await h.pool.connect();
  await gate.query('SELECT pg_advisory_lock(918273647)');
  // Exact public read operation/body/key/target and real projector. Only this
  // server-owned diagnostic wrapper introduces the inter-statement DB wait.
  const pending = directCommand(runtime, s.buyer, { order_id: orderId }, 'storefront.order.read', {},
    `order-read-${orderId}`, orderId, undefined,
    async () => { assert.fail('already committed ID receipt must replay without running the effect'); },
    async (q, context, id) => {
      const view = await directOrderView(q, context, id);
      assert.equal(view.state, 'reserved', 'barrier must start after a real reserved projection');
      await q.query('SELECT pg_advisory_xact_lock(918273647) /* ho307-projector-barrier */');
      return view;
    }).then(value => ({ value }), error => ({ error }));
  try {
    await diagnosticWaitForExpiry(orderId, 'ho307-projector-barrier');
  } finally { await gate.query('SELECT pg_advisory_unlock(918273647)'); gate.release(); }
  const result = await pending;
  assert.ok('error' in result); assert.equal(result.error.code, 'reservation_clock_changed');
  // Rejected stale projection rolled back: no premature release or terminal fact.
  assert.equal((await h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1', [s.product.product_id])).rows[0].reserved, 1);
  assert.equal((await h.pool.query('SELECT 1 FROM scoped_transition_journal WHERE aggregate_id=$1 AND aggregate_version=2', [orderId])).rowCount, 0);
  assert.equal((await readDirectOrder(runtime, s.buyer, orderId)).state, 'expired');
  await diagnosticAssertTerminal(f);
});
