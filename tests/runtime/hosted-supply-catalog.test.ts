import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {after, before, beforeEach, test} from 'node:test';
import {Pool} from 'pg';
import {createApp} from '../../apps/platform-api/src/app.js';
import type {SupplyProductView} from '../../contracts/guild-launchpad/v1/hosted-supply-catalog.js';
import {DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {TENANT_CURSOR_TEST_KEY} from './tenant-cursor-fixture.js';
import {createRegistryHarness, type RegistryHarness, type Reply, type Session} from './module-registry-harness.js';

let h: RegistryHarness, runtime: Pool, app: ReturnType<typeof createApp>, closed: ReturnType<typeof createApp>;
const role = `supply_catalog_${process.pid}_${Date.now()}`;
const supplierGuild = 'guild_product_quality_supply', retailGuild = 'guild_commerce_sales';
type Store = {owner: Session; tenantId: string; instanceId: string; root: string};
const catalog = {name: '合成供貨目錄', description: '只提供供貨資料', currency: 'TWD'};
const product = {title: '供貨茶杯', description: '經授權的商品介紹', cost_minor: 400, stock: 10};
const terms = {cost_minor: 400, shipping_minor: 50, shipping_terms: '確認後三天出貨', return_terms: '瑕疵請聯絡供貨方'};
const ok = (reply: Reply, status = 200) => {
  assert.equal(reply.status, status, JSON.stringify(reply.data));
  return reply.data;
};
const get = (s: Store, path: string, session = s.owner, target = app) =>
  h.call('GET', s.root + path, session, undefined, {}, target);
const send = (s: Store, path: string, body: unknown = {}, version?: string, key = randomUUID(), method = 'POST', session = s.owner, target = app) =>
  h.call(method, s.root + path, session, body, {'Idempotency-Key': key, ...(version ? {'If-Match': `"${version}"`} : {})}, target);
const command = (path: string, session: Session, body: unknown, version?: string, key = randomUUID()) =>
  h.call('POST', path, session, body, {'Idempotency-Key': key, ...(version ? {'If-Match': `"${version}"`} : {})}, app);

async function open(name: string, guild = supplierGuild, owner?: Session): Promise<Store> {
  owner ??= (await h.person(name)).session;
  await h.fullMember(owner.user.user_id, guild);
  const {tenantId, workspaceId} = await h.createTenant(owner, name);
  const planned = await h.plan(owner, tenantId, h.planBody(guild, workspaceId, 'hosted-store', 'hosted-store@1.0.0'));
  ok(planned, 201);
  const launched = await h.launch(owner, tenantId, planned);
  assert.ok([200, 202].includes(launched.status), JSON.stringify(launched.data));
  assert.equal(launched.data.state, 'succeeded');
  const instanceId = (await h.pool.query("SELECT instance_id FROM module_instances WHERE tenant_id=$1 AND module_key='storefront'", [tenantId])).rows[0].instance_id;
  return {owner, tenantId, instanceId, root: `/tenants/${tenantId}/storefronts/${instanceId}`};
}
async function supplier(name = catalog.name) {
  const s = await open(name);
  ok(await send(s, '/supply-profile', {...catalog, name}), 201);
  return s;
}
async function retailer(name = '零售 B') {
  const s = await open(name, retailGuild);
  ok(await send(s, '/setup', {name, slug: `retail-${randomUUID().slice(0, 12)}`, currency: 'TWD'}), 201);
  return s;
}
async function storedReceipt(key: string, expected: Record<string, unknown>) {
  const rows = (await h.pool.query('SELECT response FROM scoped_command_receipts WHERE idempotency_key=$1', [key])).rows;
  assert.deepEqual(rows, [{response: expected}], 'the durable receipt stores only its exact stable acknowledgement');
}
async function readSupplyProduct(s: Store, productId: string): Promise<SupplyProductView> {
  const reply = await get(s, '/supply-products');
  const item = (ok(reply).items as SupplyProductView[]).find(row => row.product_id === productId);
  privateReply(reply); assert.ok(item, 'the authorized GET returns the newly saved product');
  return item;
}
async function createSupplyProduct(s: Store, input = product) {
  const key = randomUUID(), reply = await send(s, '/supply-products', input, undefined, key);
  const receipt = ok(reply, 201); privateReply(reply);
  assert.deepEqual(receipt, {product_id: receipt.product_id, version: '1'});
  await storedReceipt(key, receipt);
  const item = await readSupplyProduct(s, receipt.product_id);
  assert.equal(item.version, receipt.version);
  return item;
}
async function supplyProduct(s: Store) {
  const item = await createSupplyProduct(s);
  const saved = ok(await send(s, `/products/${item.product_id}/supply-terms`, terms, item.version, randomUUID(), 'PATCH'));
  return {...item, version: saved.version};
}
const offer = async (s: Store, item: {product_id: string; version: string}) =>
  ok(await send(s, `/products/${item.product_id}/supply-offer`, {}, item.version));
const propose = async (s: Store, offered: {offer_id: string; terms_sha256: string}, price = 1200) =>
  ok(await send(s, '/distribution-selections', {offer_id: offered.offer_id, terms_sha256: offered.terms_sha256, retail_price_minor: price}), 201);
const accept = async (s: Store, selection: {selection_id: string; listing_sha256: string; version: string}) =>
  ok(await send(s, `/supply-requests/${selection.selection_id}/decision`, {decision: 'accepted', listing_sha256: selection.listing_sha256}, selection.version));
const publish = async (s: Store) => ok(await send(s, '/publish', {}, ok(await get(s, '')).version));
const profileRow = async (s: Store) => (await h.pool.query('SELECT * FROM commerce_storefront_profiles WHERE instance_id=$1', [s.instanceId])).rows[0];
const ownRow = async (s: Store, productId: string) => (await h.pool.query(`SELECT l.selection_id,l.aggregate_version::text AS version,l.retail_price_minor,l.own_retail_enabled,
  i.item_id,i.stock,i.reserved,i.price_minor AS cost_minor
  FROM commerce_items i JOIN commerce_selections l USING(item_id)
  JOIN commerce_storefront_profiles p ON p.supply_shop_id=i.shop_id AND p.storefront_shop_id=l.shop_id
  WHERE p.instance_id=$1 AND i.item_id=$2`, [s.instanceId, productId])).rows[0];
async function invite(s: Store, person: Session, capabilities: string[], memberRole: 'operator' | 'admin' = 'operator') {
  const principal = await h.candidate(s.owner, person.user.user_id);
  const invitation = await h.post(`/tenants/${s.tenantId}/invitations`, s.owner, {
    invitee_principal_id: principal, role: memberRole,
    instance_capabilities: capabilities.length ? [{instance_id: s.instanceId, capabilities}] : [],
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  });
  ok(invitation, 201);
  await h.accept(person, s.tenantId, invitation);
  return principal;
}
async function admit(s: Store) {
  const setting = ok(await get(s, '/reservation-setting'));
  assert.equal(setting.reservation_enabled, false);
  return ok(await send(s, '/reservation-setting', {reservation_enabled: true}, setting.version, randomUUID(), 'PATCH'));
}
function privateReply(reply: Reply) {
  assert.equal(reply.response.headers.get('cache-control'), 'private, no-store');
  assert.match(reply.response.headers.get('vary') ?? '', /Cookie/);
}

before(async () => {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url && /^\/fp_[a-z0-9_]+$/.test(new URL(url).pathname), 'Explicit disposable TEST_DATABASE_URL is required');
  h = await createRegistryHarness('fp_supply_catalog');
  await h.admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    GRANT USAGE ON SCHEMA ${h.schema} TO ${role};
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${h.schema} TO ${role};
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${h.schema} TO ${role};
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${h.schema} TO ${role}`);
  const runtimeUrl = new URL(url); runtimeUrl.username = role; runtimeUrl.password = '';
  runtime = new Pool({connectionString: runtimeUrl.toString(), options: `-c search_path=${h.schema} -c statement_timeout=20000`, max: 6});
  app = createApp(runtime, h.origin, 'local', {guildLaunchpadEnabled: true, hostedReservationsEnabled: true, tenantCursorSigningKey: TENANT_CURSOR_TEST_KEY});
  closed = createApp(runtime, h.origin, 'local');
});
after(async () => {
  await runtime?.end();
  if (h) {
    await h.stop();
    const admin = new Pool({connectionString: process.env.TEST_DATABASE_URL});
    try { await admin.query(`DROP ROLE ${role}`); } finally { await admin.end(); }
  }
});
beforeEach(async () => {
  await h.reset();
  for (const guild of [supplierGuild, retailGuild]) {
    await h.pool.query(`INSERT INTO guild_application_offerings(offering_id,community_id,guild_key,application_key,release_ref,status,display_order,launch_policy_ref,version)
      VALUES($1,$2,$3,'hosted-store','hosted-store@1.0.0','offered',10,'{"policy_key":"hosted-store.launch","version":"1"}',1)`, [randomUUID(), DEMO_COMMUNITY, guild]);
  }
});

test('supplier setup creates one private catalog without a slug, public page or retail price and resumes after login', async () => {
  const s = await open('供貨會員');
  const initial = ok(await get(s, '/supply-profile'));
  assert.equal(initial.setup_state, 'setup_required'); assert.equal(initial.catalog, null);
  const key = randomUUID(), setup = await send(s, '/supply-profile', catalog, undefined, key);
  const setupReceipt = ok(setup, 201); privateReply(setup);
  assert.deepEqual(setupReceipt, {instance_id: s.instanceId, version: '1', created: true});
  await storedReceipt(key, setupReceipt);
  const view = ok(await get(s, '/supply-profile'));
  assert.equal(view.setup_state, 'ready'); assert.deepEqual(view.catalog, catalog);
  assert.equal(view.retail_enabled, false); assert.equal(view.product_limit, 200);
  assert.equal(view.product_count, 0); assert.equal(view.version, '1');
  assert.deepEqual(ok(await send(s, '/supply-profile', catalog, undefined, key), 201), setupReceipt);
  const reuseKey = randomUUID(), reused = ok(await send(s, '/supply-profile', catalog, undefined, reuseKey));
  assert.deepEqual(reused, {instance_id: s.instanceId, version: '1', created: false});
  await storedReceipt(reuseKey, reused);
  const p = await profileRow(s);
  assert.equal(p.slug, null); assert.equal(p.current_publication_id, null);
  assert.equal(p.first_published_at, null); assert.equal(p.reservation_enabled, false);
  const shops = (await h.pool.query('SELECT origin,mode,accepting_orders,website_url,contact FROM commerce_shops ORDER BY shop_id')).rows;
  assert.equal(shops.length, 2);
  for (const shop of shops) assert.deepEqual(shop, {origin: 'hosted', mode: 'test', accepting_orders: false, website_url: '', contact: ''});
  const createKey = randomUUID(), created = await send(s, '/supply-products', product, undefined, createKey);
  const createReceipt = ok(created, 201); privateReply(created);
  assert.deepEqual(createReceipt, {product_id: createReceipt.product_id, version: '1'});
  await storedReceipt(createKey, createReceipt);
  const item = await readSupplyProduct(s, createReceipt.product_id);
  assert.deepEqual(ok(await send(s, '/supply-products', product, undefined, createKey), 201), createReceipt);
  assert.equal(item.sku, 'P0001'); assert.equal(item.cost_minor, 400);
  assert.equal('price_minor' in item, false); assert.equal(item.version, '1');
  const own = await ownRow(s, item.product_id);
  assert.equal(own.item_id, item.product_id); assert.equal(own.own_retail_enabled, false);
  assert.deepEqual([own.stock, own.reserved, own.cost_minor], [10, 0, '400']);
  assert.equal(await h.count('commerce_items'), 1); assert.equal(await h.count('commerce_selections'), 1);
  const facts = (await h.pool.query('SELECT operation,data FROM scoped_transition_journal WHERE aggregate_id=$1', [item.product_id])).rows;
  assert.deepEqual(facts, [{operation: 'storefront.supply-product.create', data: {resource_id: item.product_id, version: '1'}}]);
  assert.equal(await h.count('commerce_storefront_publications'), 0);
  assert.equal(await h.count('commerce_hosted_supply_offers'), 0);
  assert.equal(await h.count('commerce_distribution_acceptances'), 0);
  assert.deepEqual(ok(await send(s, '/supply-profile', catalog, undefined, key), 201), setupReceipt);
  assert.equal(ok(await get(s, '/supply-profile')).product_count, 1);
  await storedReceipt(key, setupReceipt);
  assert.equal(await h.count('commerce_shops'), 2);
  const retail = ok(await get(s, ''), 409);
  assert.equal(retail.code, 'retail_not_activated');
  assert.deepEqual(ok(await h.call('GET', '/me/stores', s.owner, undefined, {}, app)).items, []);
  for (const path of [`/api/v1/public/stores/${s.instanceId}`, `/shops/${s.instanceId}`]) {
    assert.equal((await app.request(h.origin + path)).status, 404);
  }
  ok(await command('/auth/logout', s.owner, {}));
  const fresh = await h.signIn(s.owner.user.email, app);
  const page = ok(await h.call('GET', '/me/supply-catalogs?pagination=cursor', fresh, undefined, {}, app));
  assert.equal(page.items.length, 1); assert.equal(page.items[0].instance_id, s.instanceId);
  assert.equal(page.items[0].setup_state, 'ready'); assert.equal(page.next_cursor, null);
  assert.deepEqual(ok(await get(s, '/supply-products', fresh)).items, [item]);
  assert.equal(ok(await get(s, '/supply-profile', fresh)).product_count, 1);
});

test('supplier-only catalog rejects retail setup, editing, preview and publication without changing its private state', async () => {
  const s = await supplier(), item = await supplyProduct(s), version = ok(await get(s, '/supply-profile')).version;
  const before = await profileRow(s), original = await ownRow(s, item.product_id);
  const attempts: [string, string, unknown, string | undefined][] = [
    ['POST', '/setup', {name: '不得暗中開店', slug: 'forbidden-retail', currency: 'TWD'}, undefined],
    ['PATCH', '', {slug: 'forbidden-retail'}, version],
    ['GET', '/products', undefined, undefined],
    ['POST', '/products', {title: '不得暗中零售', price_minor: 900, stock: 1}, undefined],
    ['PATCH', `/products/${item.product_id}`, {price_minor: 900}, item.version],
    ['GET', '/preview', undefined, undefined], ['GET', '/preview-page', undefined, undefined],
    ['GET', '/appearance', undefined, undefined],
    ['PATCH', '/appearance', {template_id: 'catalog-list-v1'}, version],
    ['POST', '/publish', {}, version], ['POST', '/unpublish', {}, version],
  ];
  for (const [method, path, body, expected] of attempts) {
    const reply = method === 'GET' ? await get(s, path) : await send(s, path, body, expected, randomUUID(), method);
    ok(reply, 409); assert.equal(reply.data.code, 'retail_not_activated', `${method} ${path}`);
  }
  assert.deepEqual(await profileRow(s), before); assert.deepEqual(await ownRow(s, item.product_id), original);
  // The additive SQL boundary also rejects a publication writer that skips the
  // HTTP/service guard. This is a synthetic disposable database counterexample.
  await assert.rejects(runtime.query(`INSERT INTO commerce_storefront_publications(publication_id,instance_id,tenant_id,revision,slug,projection,projection_sha256,published_by_principal_id)
    VALUES($1,$2,$3,1,'forbidden-retail','{}',$4,$5)`, [randomUUID(), s.instanceId, s.tenantId, '0'.repeat(64), before.created_by_principal_id]),
  (error: unknown) => (error as {code?: string}).code === '23514' && /retail publication requires an activated storefront/.test((error as Error).message));
  assert.equal(await h.count('commerce_storefront_publications'), 0);
  assert.equal(await h.count('commerce_items'), 1);
  assert.equal(ok(await get(s, '/reservation-setting')).reservation_enabled, false);
});

test('supplier-only A offers one item to retailer B with exact consent and public allowlisting', async () => {
  const a = await supplier('供貨 A'), b = await retailer(), item = await supplyProduct(a);
  assert.deepEqual(ok(await get(b, '/supply-catalog')).items, []);
  const offered = await offer(a, item), proposal = await propose(b, offered, 1200);
  assert.equal(ok(await get(b, '/supply-catalog')).items[0].terms.cost_minor, 400);
  assert.deepEqual(ok(await get(b, '/preview')).projection.products, []);
  ok(await send(a, `/supply-requests/${proposal.selection_id}/decision`, {decision: 'accepted', listing_sha256: '0'.repeat(64)}, proposal.version), 409);
  ok(await send(b, `/supply-requests/${proposal.selection_id}/decision`, {decision: 'accepted', listing_sha256: proposal.listing_sha256}, proposal.version), 404);
  await accept(a, proposal); await publish(b);
  const bView = ok(await get(b, ''));
  const json = await app.request(h.origin + `/api/v1/public/stores/${bView.store.slug}`);
  assert.equal(json.status, 200);
  const projection = await json.json() as {products: unknown[]};
  assert.deepEqual(projection.products, [{sku: proposal.sku, title: item.title, description: item.description, price_minor: 1200}]);
  const html = await app.request(h.origin + `/shops/${bView.store.slug}`);
  assert.equal(html.status, 200);
  for (const publicText of [JSON.stringify(projection), await html.text()]) {
    for (const privateField of ['cost_minor', 'shipping_terms', 'return_terms', a.tenantId, a.instanceId, item.product_id, terms.shipping_terms, terms.return_terms]) {
      assert.equal(publicText.includes(privateField), false, privateField);
    }
  }
  ok(await get(a, '/supply-products', b.owner), 404);
  ok(await get(a, `/products/${item.product_id}/supply-terms`, b.owner), 404);
  assert.equal(await h.count('commerce_items'), 1);
  assert.equal(await h.count('commerce_distribution_acceptances'), 1);
  assert.equal(await h.count('commerce_storefront_publications', 'WHERE instance_id=$1', [a.instanceId]), 0);
  assert.equal((await profileRow(a)).slug, null);
  const original = await ownRow(a, item.product_id);
  const changed = ok(await send(a, `/supply-products/${item.product_id}`, {cost_minor: 650, stock: 12}, item.version, randomUUID(), 'PATCH'));
  assert.equal(changed.product_id, item.product_id); assert.equal(changed.version, String(BigInt(item.version) + 1n));
  assert.equal((await ownRow(a, item.product_id)).selection_id, original.selection_id);
  assert.equal(ok(await get(b, '/supply-catalog')).items[0].terms.cost_minor, 400, 'private edits do not rewrite the offered version');
  await send(a, `/supply-offers/${offered.offer_id}/withdraw`, {}, offered.version).then(reply => ok(reply));
  assert.deepEqual(ok(await get(b, '/supply-catalog')).items, []);
  assert.deepEqual(ok(await get(b, '/preview')).projection.products, []);
  ok(await send(b, '/publish', {}, bView.version), 409);
  assert.deepEqual(await (await app.request(h.origin + `/api/v1/public/stores/${bView.store.slug}`)).json(), projection);
});

test('supplier-only A explicitly opts into B reservations and keeps one stock balance and durable hold', async () => {
  const a = await supplier('可預留供貨 A'), b = await retailer(), item = await supplyProduct(a);
  const offered = await offer(a, item), selected = await accept(a, await propose(b, offered));
  await publish(b);
  const buyer = (await h.person('合成買家')).session, bView = ok(await get(b, ''));
  const quoteBody = {publication_revision: bView.publication.current_revision, items: [{sku: selected.sku, quantity: 3}]};
  await admit(b);
  ok(await command(`/hosted-stores/${bView.store.slug}/reservation-quotes`, buyer, quoteBody), 409);
  await admit(a);
  const quote = ok(await command(`/hosted-stores/${bView.store.slug}/reservation-quotes`, buyer, quoteBody), 201);
  const intent = {quote_id: quote.quote_id, terms_sha256: quote.terms_sha256, client_order_id: randomUUID()};
  const order = ok(await command(`/hosted-stores/${bView.store.slug}/reservation-orders`, buyer, intent), 201);
  assert.equal(order.state, 'reserved');
  const before = await ownRow(a, item.product_id);
  assert.deepEqual([before.stock, before.reserved], [10, 3]);
  const held = (await h.pool.query('SELECT reservation_id,state,quantity FROM commerce_inventory_reservations WHERE order_id=$1 AND item_id=$2', [order.order_id, item.product_id])).rows[0];
  assert.deepEqual([held.state, held.quantity], ['held', 3]);
  const tooLow = await send(a, `/supply-products/${item.product_id}`, {stock: 2}, item.version, randomUUID(), 'PATCH');
  ok(tooLow, 409); assert.equal(tooLow.data.code, 'stock_below_reserved');
  const edited = ok(await send(a, `/supply-products/${item.product_id}`, {stock: 8}, item.version, randomUUID(), 'PATCH'));
  assert.equal(edited.version, String(BigInt(item.version) + 1n));
  const after = await ownRow(a, item.product_id);
  assert.deepEqual([after.item_id, after.selection_id, after.stock, after.reserved], [before.item_id, before.selection_id, 8, 3]);
  const supplies = ok(await get(a, '/supply-reservations'));
  assert.equal(supplies.items.length, 1); assert.equal(supplies.items[0].items[0].product_id, item.product_id);
  const supplierText = JSON.stringify(supplies);
  for (const privateField of ['buyer_principal_id', 'client_order_id', 'quote_id', buyer.user.email, buyer.user.user_id]) assert.equal(supplierText.includes(privateField), false);
  const cancelKey = randomUUID(), cancelPath = `/me/reservations/${order.order_id}/cancel`;
  const cancelled = ok(await command(cancelPath, buyer, {}, order.version, cancelKey));
  assert.deepEqual(ok(await command(cancelPath, buyer, {}, order.version, cancelKey)), cancelled);
  assert.equal((await ownRow(a, item.product_id)).reserved, 0);
  const released = (await h.pool.query('SELECT reservation_id,state FROM commerce_inventory_reservations WHERE order_id=$1', [order.order_id])).rows;
  assert.deepEqual(released, [{reservation_id: held.reservation_id, state: 'released'}]);
  assert.equal((await profileRow(a)).slug, null);
  assert.equal(await h.count('commerce_items'), 1);
  for (const table of ['commerce_transfers', 'commerce_payment_events', 'commerce_supplier_payables']) assert.equal(await h.count(table), 0);
});

test('an existing retail store reuses its catalog, inventory identities and versions while new supply-only items stay out of publication', async () => {
  const s = await retailer('既有商店');
  const retail = ok(await send(s, '/products', {title: '原零售商品', description: '公開商品', price_minor: 1900, stock: 6}), 201);
  await publish(s);
  const initial = await profileRow(s), original = await ownRow(s, retail.product_id), retailView = ok(await get(s, ''));
  const priorPublic = await (await app.request(h.origin + `/api/v1/public/stores/${initial.slug}`)).text();
  const reuseKey = randomUUID(), reused = ok(await send(s, '/supply-profile', {name: retailView.store.name, description: retailView.store.description, currency: retailView.store.currency}, undefined, reuseKey));
  assert.deepEqual(reused, {instance_id: s.instanceId, version: retailView.version, created: false});
  await storedReceipt(reuseKey, reused);
  const supplyView = ok(await get(s, '/supply-profile'));
  assert.equal(supplyView.retail_enabled, true); assert.equal(supplyView.product_count, 1);
  assert.deepEqual(await profileRow(s), initial); assert.deepEqual(await ownRow(s, retail.product_id), original);
  assert.equal(await h.count('commerce_shops'), 2);
  const listed = ok(await get(s, '/supply-products')).items;
  assert.equal(listed[0].product_id, retail.product_id); assert.equal(listed[0].version, retail.version);
  assert.equal(listed[0].cost_minor, 1900);
  const changed = ok(await send(s, `/supply-products/${retail.product_id}`, {cost_minor: 500, stock: 9}, retail.version, randomUUID(), 'PATCH'));
  assert.equal(changed.version, '2');
  const same = await ownRow(s, retail.product_id);
  assert.equal(same.selection_id, original.selection_id); assert.equal(same.retail_price_minor, '1900');
  assert.equal(same.own_retail_enabled, true); assert.equal(same.cost_minor, '500');
  const savedRetail = ok(await get(s, '/products')).items[0];
  assert.equal(savedRetail.version, changed.version); assert.equal(savedRetail.price_minor, 1900); assert.equal(savedRetail.stock, 9);
  const hidden = await createSupplyProduct(s, {...product, title: '僅供貨且不得公開的商品'});
  assert.equal((await ownRow(s, hidden.product_id)).own_retail_enabled, false);
  assert.equal(ok(await get(s, '/supply-products')).items.length, 2);
  assert.deepEqual(ok(await get(s, '/products')).items.map((p: {product_id: string}) => p.product_id), [retail.product_id]);
  ok(await send(s, `/products/${hidden.product_id}`, {price_minor: 2500}, hidden.version, randomUUID(), 'PATCH'), 404);
  assert.equal((await ownRow(s, hidden.product_id)).own_retail_enabled, false);
  const preview = ok(await get(s, '/preview')).projection;
  assert.deepEqual(preview.products.map((p: {title: string}) => p.title), ['原零售商品']);
  await publish(s);
  const publicText = await (await app.request(h.origin + `/api/v1/public/stores/${initial.slug}`)).text();
  assert.equal(publicText.includes(hidden.title), false); assert.equal(publicText.includes('cost_minor'), false);
  assert.equal(publicText, priorPublic, 'private supply changes do not create a new public revision');
  assert.equal(await h.count('commerce_storefront_publications'), 1);
  assert.equal(await h.count('commerce_items'), 2); assert.equal(await h.count('commerce_shops'), 2);
  assert.equal((await profileRow(s)).slug, initial.slug);
});

test('supply reads and writes enforce current session, tenant, feature gate and private cost capabilities', async () => {
  const s = await supplier(), item = await supplyProduct(s);
  const outsider = (await h.person('無權會員')).session, reader = (await h.person('只讀商品會員')).session;
  await invite(s, reader, ['store:read']);
  const paths = ['/supply-profile', '/supply-products', `/products/${item.product_id}/supply-terms`];
  for (const path of paths) {
    ok(await h.call('GET', s.root + path, undefined, undefined, {}, app), 401);
    ok(await get(s, path, outsider), 404);
    ok(await get(s, path, s.owner, closed), 404);
  }
  ok(await get(s, '/supply-profile', reader));
  ok(await get(s, '/supply-products', reader), 403);
  ok(await get(s, `/products/${item.product_id}/supply-terms`, reader), 403);
  ok(await send(s, '/supply-products', product, undefined, randomUUID(), 'POST', reader), 403);
  ok(await send(s, '/supply-profile', catalog, undefined, randomUUID(), 'POST', reader), 403);
  ok(await send(s, '/supply-products', product, undefined, randomUUID(), 'POST', outsider), 404);
  ok(await h.call('GET', `/tenants/${s.tenantId}/storefronts/${randomUUID()}/supply-products`, s.owner, undefined, {}, app), 404);
  ok(await send(s, `/supply-products/${randomUUID()}`, {stock: 2}, item.version, randomUUID(), 'PATCH'), 404);
  ok(await send(s, '/supply-products', product, undefined, randomUUID(), 'POST', s.owner, closed), 404);
  const badCsrf = {...s.owner, csrf: 'invalid-csrf'};
  ok(await send(s, '/supply-products', product, undefined, randomUUID(), 'POST', badCsrf), 403);
  ok(await h.call('GET', '/me/supply-catalogs', undefined, undefined, {}, app), 401);
  ok(await h.call('GET', '/me/supply-catalogs', s.owner, undefined, {}, closed), 404);
  assert.deepEqual(ok(await h.call('GET', '/me/supply-catalogs', outsider, undefined, {}, app)).items, []);
  for (const query of ['cursor=bad', 'cursor=a&cursor=b', 'unknown=1']) {
    ok(await h.call('GET', '/me/supply-catalogs?' + query, s.owner, undefined, {}, app), 422);
  }
  const admin = (await h.person('非店主管理員')).session;
  await invite(s, admin, [], 'admin');
  ok(await get(s, '/reservation-setting', admin), 403);
  ok(await send(s, '/reservation-setting', {reservation_enabled: true}, ok(await get(s, '/reservation-setting')).version, randomUUID(), 'PATCH', admin), 403);
  assert.equal(await h.count('commerce_items'), 1);
  const quiet = (await runtime.query("SELECT current_setting('freedom.tenant_id',true) AS tenant,(SELECT count(*)::int FROM commerce_resource_tenants) AS mappings")).rows[0];
  assert.ok(!quiet.tenant); assert.equal(quiet.mappings, 0);
});

test('supplier writer receipts recheck current permissions, membership and session instead of replaying private results', async () => {
  const s = await supplier(), writer = (await h.person('供貨編輯者')).session;
  const principal = await invite(s, writer, ['store:read', 'store:write']);
  const key = randomUUID(), item = ok(await send(s, '/supply-products', product, undefined, key, 'POST', writer), 201);
  assert.deepEqual(item, {product_id: item.product_id, version: '1'});
  await storedReceipt(key, item);
  assert.deepEqual(ok(await send(s, '/supply-products', product, undefined, key, 'POST', writer), 201), item);
  ok(await send(s, `/products/${item.product_id}/supply-offer`, {}, item.version, randomUUID(), 'POST', writer), 403);
  await h.pool.query("UPDATE tenant_module_permissions SET capabilities=ARRAY['store:read'] WHERE tenant_id=$1 AND instance_id=$2 AND principal_id=$3", [s.tenantId, s.instanceId, principal]);
  ok(await send(s, '/supply-products', product, undefined, key, 'POST', writer), 403);
  await h.pool.query("UPDATE tenant_module_permissions SET capabilities=ARRAY['store:read','store:write'] WHERE tenant_id=$1 AND instance_id=$2 AND principal_id=$3", [s.tenantId, s.instanceId, principal]);
  await h.pool.query("UPDATE tenant_memberships SET status='revoked',revoked_at=clock_timestamp(),version=version+1 WHERE tenant_id=$1 AND principal_id=$2", [s.tenantId, principal]);
  ok(await send(s, '/supply-products', product, undefined, key, 'POST', writer), 404);
  assert.deepEqual(ok(await h.call('GET', '/me/supply-catalogs', writer, undefined, {}, app)).items, []);
  const ownerKey = randomUUID();
  ok(await send(s, '/supply-products', {...product, title: '第二項'}, undefined, ownerKey), 201);
  ok(await command('/auth/logout', s.owner, {}));
  ok(await send(s, '/supply-products', {...product, title: '第二項'}, undefined, ownerKey), 401);
  assert.equal(await h.count('commerce_items'), 2);
  assert.equal(await h.count('commerce_hosted_supply_offers'), 0);
});

test('supplier input and stable private receipts preserve product concurrency and exact replay after later edits', async () => {
  const s = await open('格式與版本');
  for (const extra of [{slug: 'accidental-store'}, {retail_enabled: true}, {reservation_enabled: true}]) {
    ok(await send(s, '/supply-profile', {...catalog, ...extra}), 422);
  }
  assert.equal(await h.count('commerce_shops'), 0);
  ok(await send(s, '/supply-profile', catalog), 201);
  for (const body of [{...product, price_minor: 1200}, {...product, own_retail_enabled: true}, {...product, cost_minor: 0}, {...product, stock: -1}]) {
    ok(await send(s, '/supply-products', body), 422);
  }
  ok(await h.call('POST', s.root + '/supply-products', s.owner, product, {}, app), 400);
  const key = randomUUID(), item = ok(await send(s, '/supply-products', product, undefined, key), 201);
  assert.deepEqual(item, {product_id: item.product_id, version: '1'});
  await storedReceipt(key, item);
  ok(await send(s, '/supply-products', {...product, cost_minor: 600}, undefined, key), 409);
  ok(await send(s, `/supply-products/${item.product_id}`, {stock: 20}, undefined, randomUUID(), 'PATCH'), 428);
  const patchKey = randomUUID(), patchBody = {cost_minor: 600, stock: 20};
  const updated = ok(await send(s, `/supply-products/${item.product_id}`, patchBody, item.version, patchKey, 'PATCH'));
  assert.deepEqual(updated, {product_id: item.product_id, version: '2'});
  await storedReceipt(patchKey, updated);
  ok(await send(s, `/supply-products/${item.product_id}`, {stock: 21}, item.version, randomUUID(), 'PATCH'), 412);
  ok(await send(s, `/products/${item.product_id}/supply-terms`, terms, item.version, randomUUID(), 'PATCH'), 412);
  const savedTerms = ok(await send(s, `/products/${item.product_id}/supply-terms`, {...terms, cost_minor: 700}, updated.version, randomUUID(), 'PATCH'));
  assert.equal(savedTerms.version, '3');
  const beforeReplay = await ownRow(s, item.product_id);
  const factCount = await h.count('scoped_transition_journal', 'WHERE aggregate_id=$1', [item.product_id]);
  assert.deepEqual(ok(await send(s, '/supply-products', product, undefined, key), 201), item);
  assert.deepEqual(ok(await send(s, `/supply-products/${item.product_id}`, patchBody, item.version, patchKey, 'PATCH')), updated);
  await storedReceipt(key, item); await storedReceipt(patchKey, updated);
  assert.deepEqual(await ownRow(s, item.product_id), beforeReplay);
  assert.equal(await h.count('scoped_transition_journal', 'WHERE aggregate_id=$1', [item.product_id]), factCount);
  assert.deepEqual(ok(await get(s, '/supply-products')).items.map((p: {product_id: string; cost_minor: number; stock: number; version: string}) =>
    [p.product_id, p.cost_minor, p.stock, p.version]), [[item.product_id, 700, 20, '3']]);
  assert.equal(await h.count('commerce_items'), 1); assert.equal(await h.count('commerce_selections'), 1);
});

test('the 200-product bound counts supplier-only items and concurrent creates cannot exceed it', {timeout: 120000}, async () => {
  const s = await supplier('有界供貨目錄');
  for (let index = 0; index < 199; index++) {
    ok(await send(s, '/supply-products', {...product, title: `合成商品 ${index}`}), 201);
  }
  const last = await Promise.all([send(s, '/supply-products', {...product, title: '最後一格 A'}), send(s, '/supply-products', {...product, title: '最後一格 B'})]);
  assert.deepEqual(last.map(reply => reply.status).sort(), [201, 409]);
  const page = ok(await get(s, '/supply-products'));
  assert.equal(page.items.length, 200); assert.equal(page.limit, 200);
  assert.equal(new Set(page.items.map((item: {sku: string}) => item.sku)).size, 200);
  assert.equal(ok(await get(s, '/supply-profile')).product_count, 200);
  assert.equal(await h.count('commerce_items'), 200); assert.equal(await h.count('commerce_selections'), 200);
  assert.equal(await h.count('commerce_storefront_publications'), 0);
});
