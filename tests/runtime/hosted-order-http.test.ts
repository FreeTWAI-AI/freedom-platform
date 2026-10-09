import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { serve } from '@hono/node-server';
import { Pool } from 'pg';
import { digest } from '../../packages/db/index.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { createRegistryHarness, type RegistryHarness, type Session, type Reply } from './module-registry-harness.js';

let h: RegistryHarness, runtime: Pool, sellerApp: ReturnType<typeof createApp>, buyerApp: ReturnType<typeof createApp>;
let server: ReturnType<typeof serve>, origin: string;
let damageNextSubmit = false, damagedCommittedResponses = 0;
const role = `ho_http_${process.pid}_${Date.now()}`;
const ok = (reply: Reply, status = 200) => { assert.equal(reply.status, status, JSON.stringify(reply.data)); return reply.data; };
const install = (admission = true, discovery = true) => { buyerApp = createApp(runtime, origin, 'local', { guildLaunchpadEnabled: discovery, hostedReservationsEnabled: admission }); };
async function http(method: string, path: string, session?: Session, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const response = await fetch(origin + '/api/v1' + path, { method, headers: {
    Origin: origin, ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}),
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers,
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json(), response };
}
const post = (path: string, session: Session, body: unknown, key = randomUUID(), version?: string) => http('POST', path, session, body,
  { 'Idempotency-Key': key, ...(version ? { 'If-Match': `"${version}"` } : {}) });
const privateReply = (r: Reply) => {
  assert.equal(r.response.headers.get('cache-control'), 'private, no-store');
  assert.equal(r.response.headers.get('vary'), 'Cookie');
  assert.equal(r.response.headers.get('x-robots-tag'), 'noindex, nofollow');
};
async function fixture() {
  const owner = (await h.person('HTTP 合成賣家')).session;
  await h.fullMember(owner.user.user_id, 'guild_commerce_sales');
  const t = await h.createTenant(owner, 'HTTP 合成商店');
  const sellerPost = (path: string, body: unknown, version?: string) => h.call('POST', path, owner, body,
    { 'Idempotency-Key': randomUUID(), ...(version ? { 'If-Match': `"${version}"` } : {}) }, sellerApp);
  const plan = ok(await sellerPost(`/tenants/${t.tenantId}/application-launch-plans`, h.planBody('guild_commerce_sales', t.workspaceId, 'hosted-store', 'hosted-store@1.0.0')), 201);
  const launch = await sellerPost(`/tenants/${t.tenantId}/application-installations`, { plan_id: plan.plan_id, expected_plan_version: plan.version, configuration_digest: plan.configuration_digest });
  assert.ok([200, 202].includes(launch.status));
  const instanceId = (await h.pool.query("SELECT instance_id FROM module_instances WHERE tenant_id=$1 AND module_key='storefront'", [t.tenantId])).rows[0].instance_id;
  const root = `/tenants/${t.tenantId}/storefronts/${instanceId}`, slug = `ht-${randomUUID()}`;
  ok(await sellerPost(root + '/setup', { slug, name: 'HTTP 合成商品', currency: 'TWD' }), 201);
  const product = ok(await sellerPost(root + '/products', { title: 'HTTP 合成商品', price_minor: 100, stock: 3 }), 201);
  const current = ok(await h.call('GET', root, owner, undefined, {}, sellerApp));
  ok(await sellerPost(root + '/publish', {}, current.version));
  const buyer = await h.person('HTTP 跨社群買家'), stranger = await h.person('HTTP 非買家');
  const community = randomUUID();
  await h.pool.query("INSERT INTO communities(community_id,name) VALUES($1,'HTTP 合成買家社群')", [community]);
  await h.pool.query('UPDATE users SET community_id=$1 WHERE user_id=ANY($2::uuid[])', [community, [buyer.id, stranger.id]]);
  assert.equal((await h.pool.query('SELECT 1 FROM tenant_memberships m JOIN principals p ON p.principal_id=m.principal_id WHERE tenant_id=$1 AND p.user_ref=ANY($2::uuid[])', [t.tenantId, [buyer.id, stranger.id]])).rowCount, 0);
  return { ...t, instanceId, slug, root, product, owner, buyer: buyer.session, buyerEmail: buyer.email, stranger: stranger.session, sellerPost };
}
const enableFixture = (s: Awaited<ReturnType<typeof fixture>>) => h.pool.query('UPDATE commerce_storefront_profiles SET reservation_enabled=true WHERE instance_id=$1', [s.instanceId]);
const quoteInput = (s: Awaited<ReturnType<typeof fixture>>) => ({ publication_revision: '1', items: [{ sku: s.product.sku, quantity: 1 }] });
const submitInput = (q: any, id = randomUUID()) => ({ quote_id: q.quote_id, terms_sha256: q.terms_sha256, client_order_id: id });
before(async () => {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url && ['127.0.0.1', 'localhost'].includes(new URL(url).hostname) && /^\/fp_[a-z0-9_]+$/.test(new URL(url).pathname), 'Explicit disposable loopback TEST_DATABASE_URL required');
  h = await createRegistryHarness('fp_hosted_order_http');
  await h.admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    GRANT USAGE ON SCHEMA ${h.schema} TO ${role}; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${h.schema} TO ${role};
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${h.schema} TO ${role}; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${h.schema} TO ${role};
    REVOKE INSERT,UPDATE,DELETE ON ${h.schema}.module_definitions,${h.schema}.application_definitions,${h.schema}.guild_application_offerings FROM ${role}`);
  const runtimeUrl = new URL(url); runtimeUrl.username = role; runtimeUrl.password = '';
  runtime = new Pool({ connectionString: runtimeUrl.toString(), options: `-c search_path=${h.schema} -c statement_timeout=20000`, max: 8 });
  sellerApp = createApp(runtime, h.origin, 'local', { guildLaunchpadEnabled: true });
  await new Promise<void>(resolve => { server = serve({ fetch: async request => {
    const response = await buyerApp.fetch(request);
    if (damageNextSubmit && request.method === 'POST' && new URL(request.url).pathname.endsWith('/orders') && response.status === 201) {
      damageNextSubmit = false; damagedCommittedResponses++;
      // The real handler has committed. Damage only the response crossing the
      // actual socket; authentication, command and database are never mocked.
      await response.arrayBuffer();
      const headers = new Headers(response.headers); headers.delete('content-length');
      return new Response('{', { status: response.status, headers });
    }
    return response;
  }, hostname: '127.0.0.1', port: 0 }, info => { origin = `http://127.0.0.1:${info.port}`; resolve(); }); });
  install();
});
beforeEach(async () => { await h.reset(); damageNextSubmit = false; damagedCommittedResponses = 0; install(); });
after(async () => {
  if (server) { if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  await runtime?.end();
  if (h) { await h.stop(); const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL }); try { await admin.query(`DROP ROLE ${role}`); } finally { await admin.end(); } }
});

test('real session HTTP requires both explicit host admission and store setting; readiness is private and does not reserve', async () => {
  const s = await fixture(), path = `/hosted-stores/${s.slug}`;
  const initial = await http('GET', path + '/order-readiness', s.buyer); privateReply(initial);
  assert.equal(ok(initial).reservation_enabled, false);
  assert.equal(ok(await http('GET', '/hosted-stores/missing-store/order-readiness', s.buyer)).reason, initial.data.reason);
  await enableFixture(s); install(false);
  assert.equal(ok(await http('GET', path + '/order-readiness', s.buyer)).reservation_enabled, false);
  ok(await post(path + '/quotes', s.buyer, quoteInput(s)), 404);
  install();
  const ready = ok(await http('GET', path + '/order-readiness', s.buyer));
  assert.equal(ready.reservation_enabled, true); assert.equal(ready.payment_enabled, false);
  const reply = await post(path + '/quotes', s.buyer, quoteInput(s)); const quote = ok(reply, 201); privateReply(reply);
  assert.equal(quote.reserves_stock, false);
  assert.equal((await h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1', [s.product.product_id])).rows[0].reserved, 0);
  assert.equal((await h.pool.query('SELECT count(*)::int AS n FROM commerce_orders')).rows[0].n, 0);
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM scoped_command_receipts WHERE operation LIKE '%readiness%' ")).rows[0].n, 0);
  await h.pool.query('ALTER TABLE commerce_storefront_profiles RENAME TO ho_missing_profiles');
  try {
    for (const missingPath of [path + '/order-readiness', `/me/hosted-orders/by-intent/${randomUUID()}?store_slug=${s.slug}`]) {
      const missing = await http('GET', missingPath, s.buyer); ok(missing, 500); privateReply(missing);
      assert.equal(JSON.stringify(missing.data).includes(s.tenantId), false);
      assert.equal(JSON.stringify(missing.data).includes('ho_missing_profiles'), false);
    }
  } finally { await h.pool.query('ALTER TABLE ho_missing_profiles RENAME TO commerce_storefront_profiles'); }
  // A real instance lock makes readiness wait beyond this session's DB expiry.
  const gate = await h.pool.connect();
  await gate.query('BEGIN'); await gate.query('SELECT 1 FROM module_instances WHERE instance_id=$1 FOR UPDATE', [s.instanceId]);
  await h.pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE user_id=$1", [s.buyer.user.user_id]);
  const pending = http('GET', path + '/order-readiness', s.buyer);
  try {
    const end = Date.now() + 5000; let blocked = false, expired = false;
    while (Date.now() < end) {
      const row = (await h.pool.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename=$1
        AND wait_event_type='Lock' AND query LIKE '%SELECT instance_id,status,binding_id%') AS blocked,
        (SELECT bool_and(expires_at<=clock_timestamp()) FROM sessions WHERE user_id=$2) AS expired`, [role, s.buyer.user.user_id])).rows[0];
      blocked ||= row.blocked; expired = row.expired;
      if (blocked && expired) break;
    }
    assert.equal(blocked, true); assert.equal(expired, true);
  } finally { await gate.query('ROLLBACK'); gate.release(); }
  const stale = await pending; ok(stale, 401); privateReply(stale);
  assert.equal(stale.data.code, 'session_expired');
});

test('same HTTP intent/key recovers one current order and old order recovery/cancel survives both flags OFF', async () => {
  const s = await fixture(); await enableFixture(s);
  const root = `/hosted-stores/${s.slug}`, q = ok(await post(root + '/quotes', s.buyer, quoteInput(s)), 201), body = submitInput(q), key = randomUUID();
  damageNextSubmit = true;
  await assert.rejects(post(root + '/orders', s.buyer, body, key), SyntaxError);
  assert.equal(damagedCommittedResponses, 1);
  assert.equal((await h.pool.query('SELECT count(*)::int AS n FROM commerce_orders')).rows[0].n, 1);
  const recovered = await post(root + '/orders', s.buyer, body, key), order = ok(recovered); privateReply(recovered);
  assert.equal(recovered.response.headers.get('etag'), '"1"');
  assert.deepEqual(ok(await post(root + '/orders', s.buyer, body, randomUUID())), order);
  const get = `/me/hosted-orders/${order.order_id}`, intent = `/me/hosted-orders/by-intent/${body.client_order_id}?store_slug=${s.slug}`;
  install(false, false);
  ok(await http('GET', root + '/order-readiness', s.buyer), 404);
  ok(await post(root + '/orders', s.buyer, body, key), 404);
  const fresh = await h.signIn(s.buyerEmail);
  assert.deepEqual(ok(await http('GET', get, fresh)), order);
  assert.deepEqual(ok(await http('GET', intent, fresh)), order);
  const cancelKey = randomUUID(), cancelled = await post(get + '/cancel', fresh, {}, cancelKey, '1');
  assert.equal(ok(cancelled).state, 'cancelled'); assert.equal(cancelled.response.headers.get('etag'), '"2"');
  assert.deepEqual(ok(await post(get + '/cancel', fresh, {}, cancelKey, '1')), cancelled.data);
  ok(await post(get + '/cancel', fresh, {}, randomUUID(), '1'), 412);
  assert.equal(ok(await http('GET', intent, fresh)).state, 'cancelled');
  assert.equal((await h.pool.query('SELECT count(*)::int AS n FROM commerce_orders')).rows[0].n, 1);
  assert.equal((await h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1', [s.product.product_id])).rows[0].reserved, 0);
  for (const row of (await h.pool.query("SELECT response FROM scoped_command_receipts WHERE operation LIKE 'storefront.order.%' ")).rows) assert.deepEqual(Object.keys(row.response), ['id']);
  install(); assert.equal(ok(await post(root + '/orders', fresh, body, key)).state, 'cancelled');
  // Retained historical data obeys the real immutable quote/order/line guards.
  // No clock override, disabled trigger or edited reservation deadline.
  const quoteId = randomUUID(), orderId = randomUUID(), intentId = randomUUID();
  const now = (await h.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
  const quoted = new Date(now.getTime() - 40 * 60000), expires = new Date(quoted.getTime() + 300000);
  await h.pool.query(`INSERT INTO commerce_order_quotes SELECT $2::uuid,tenant_id,instance_id,public_shop_id,buyer_principal_id,publication_id,
    terms || jsonb_build_object('quote_id',$2::text,'quoted_at',$3::text,'expires_at',$4::text),bindings,terms_sha256,$3::timestamptz,$4::timestamptz
    FROM commerce_order_quotes WHERE quote_id=$1`, [q.quote_id, quoteId, quoted.toISOString(), expires.toISOString()]);
  await h.pool.query(`INSERT INTO commerce_orders(order_id,public_shop_id,external_id,request_sha256,currency,total_minor,created_at,expires_at,
    order_profile,quote_id,buyer_principal_id,client_order_id,reservation_state,reservation_version)
    SELECT $2,o.public_shop_id,o.buyer_principal_id::text||':'||$4::text,$5,o.currency,o.total_minor,quote.quoted_at+interval '1 minute',quote.quoted_at+interval '31 minutes',
      'hosted_direct_reservation',$3,o.buyer_principal_id,$4::uuid,'reserved',1 FROM commerce_orders o JOIN commerce_order_quotes quote ON quote.quote_id=$3 WHERE order_id=$1`,
    [order.order_id, orderId, quoteId, intentId, digest({ quote_id: quoteId, terms_sha256: q.terms_sha256, client_order_id: intentId })]);
  await h.pool.query(`INSERT INTO commerce_order_lines SELECT $2,selection_id,transfer_id,item_id,quantity,snapshot,acceptance_id,listing_sha256,order_profile
    FROM commerce_order_lines WHERE order_id=$1`, [order.order_id, orderId]);
  await h.pool.query('UPDATE commerce_items SET reserved=reserved+1 WHERE item_id=$1', [s.product.product_id]);
  install(false, false);
  const expiredPath = `/me/hosted-orders/${orderId}`, expired = ok(await http('GET', expiredPath, fresh));
  assert.equal(expired.state, 'expired'); assert.equal(expired.version, '2');
  assert.deepEqual(ok(await http('GET', `/me/hosted-orders/by-intent/${intentId}?store_slug=${s.slug}`, fresh)), expired);
  assert.deepEqual(ok(await post(expiredPath + '/cancel', fresh, {}, randomUUID(), '2')), expired);
  assert.equal((await h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1', [s.product.product_id])).rows[0].reserved, 0);
  assert.equal((await h.pool.query('SELECT 1 FROM scoped_transition_journal WHERE aggregate_id=$1 AND aggregate_version=2', [orderId])).rowCount, 1);
});

test('HTTP wire rejects unknown fields/query duplicates, missing CSRF/keys and invalid CAS before effects', async () => {
  const s = await fixture(); await enableFixture(s); const root = `/hosted-stores/${s.slug}`;
  for (const bearer of ['fw_read_synthetic', 'fw_shop_synthetic']) {
    const r = await http('GET', root + '/order-readiness', undefined, undefined, { Authorization: `Bearer ${bearer}` }); ok(r, 401); privateReply(r);
  }
  ok(await http('POST', root + '/quotes', s.buyer, quoteInput(s), { 'X-CSRF-Token': '', 'Idempotency-Key': randomUUID() }), 403);
  ok(await http('POST', root + '/quotes', s.buyer, quoteInput(s), { Origin: 'https://foreign.example.invalid', 'Idempotency-Key': randomUUID() }), 403);
  ok(await http('POST', root + '/quotes', s.buyer, quoteInput(s)), 400);
  ok(await post(root + '/quotes', s.buyer, quoteInput(s), randomUUID(), '1'), 400);
  for (const suffix of ['?x=1', '?x=1&x=2']) ok(await http('GET', root + '/order-readiness' + suffix, s.buyer), 422);
  for (const body of [{ ...quoteInput(s), owner_id: randomUUID() }, { ...quoteInput(s), items: [{ ...quoteInput(s).items[0], price_minor: 1 }] }]) ok(await post(root + '/quotes', s.buyer, body), 422);
  ok(await post(root + '/quotes?price=1', s.buyer, quoteInput(s)), 422);
  const q = ok(await post(root + '/quotes', s.buyer, quoteInput(s)), 201);
  ok(await post(root + '/orders', s.buyer, { ...submitInput(q), contact: 'forbidden' }), 422);
  const order = ok(await post(root + '/orders', s.buyer, submitInput(q)), 201), get = `/me/hosted-orders/${order.order_id}`;
  ok(await http('GET', get + '?extra=1', s.buyer), 422);
  ok(await http('GET', `/me/hosted-orders/by-intent/${order.client_order_id}?store_slug=${s.slug}&store_slug=${s.slug}`, s.buyer), 422);
  ok(await post(get + '/cancel', s.buyer, {}), 428);
  ok(await http('POST', get + '/cancel', s.buyer, {}, { 'Idempotency-Key': randomUUID(), 'If-Match': '1' }), 400);
  ok(await post(get + '/cancel', s.buyer, { reason: 'unaccepted' }, randomUUID(), '1'), 422);
  assert.equal(ok(await http('GET', get, s.buyer)).state, 'reserved');
});

test('current buyer ACL and pause precede HTTP replay while retained own history stays private', async () => {
  const s = await fixture(); await enableFixture(s); const root = `/hosted-stores/${s.slug}`;
  const q = ok(await post(root + '/quotes', s.buyer, quoteInput(s)), 201), input = submitInput(q), key = randomUUID();
  const order = ok(await post(root + '/orders', s.buyer, input, key), 201), get = `/me/hosted-orders/${order.order_id}`;
  for (const path of [get, `/me/hosted-orders/by-intent/${input.client_order_id}?store_slug=${s.slug}`]) {
    const denied = await http('GET', path, s.stranger); ok(denied, 404); privateReply(denied);
  }
  ok(await post(get + '/cancel', s.stranger, {}, randomUUID(), '1'), 404);
  const profile = (await h.pool.query('SELECT version FROM commerce_storefront_profiles WHERE instance_id=$1', [s.instanceId])).rows[0];
  ok(await s.sellerPost(s.root + '/unpublish', {}, String(profile.version)));
  assert.equal(ok(await http('GET', root + '/order-readiness', s.buyer)).reservation_enabled, false);
  ok(await post(root + '/orders', s.buyer, input, key), 409);
  assert.equal(ok(await http('GET', get, s.buyer)).order_id, order.order_id);
  await h.pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE user_id=$1', [s.buyer.user.user_id]);
  const revoked = await http('GET', get, s.buyer); ok(revoked, 401); privateReply(revoked);
  ok(await post(root + '/orders', s.buyer, input, key), 401);
});
