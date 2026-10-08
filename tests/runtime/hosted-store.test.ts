import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import { createApp } from '../../apps/platform-api/src/app.js';
import { STOREFRONT_CONTRACT, STOREFRONT_CONTRACT_SOURCE_COMMIT, STOREFRONT_CONTRACT_ARTIFACT_SHA256 } from '../../modules/module-registry/definitions.js';
import { changeMemberStatus, type AdminActor } from '../../modules/platform-admin/service.js';
import { formatMinor } from '../../modules/agent-commerce/hosted/format.js';
import { formatMinor as portalFormatMinor } from '../../apps/portal-web/src/format.js';
import { DEMO_COMMUNITY } from '../../packages/testing/seed.js';
import { createRegistryHarness, type RegistryHarness, type Session, type Reply } from './module-registry-harness.js';

const guild = 'guild_commerce_sales';
let h: RegistryHarness, runtime: Pool, app: ReturnType<typeof createApp>, closed: ReturnType<typeof createApp>;
const role = `hs_runtime_${process.pid}_${Date.now()}`;
type Store = { owner: Session; tenantId: string; workspaceId: string; instanceId: string; root: string };
const settings = { name: '同名品牌', brand: '合成品牌', description: '合成商店\n商品展示', slug: 'myshop', currency: 'TWD' };
const product = { title: '合成商品', description: '商品說明', price_minor: 12345, stock: 17 };
const expect = (r: Reply, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.data)); return r.data; };
const call = (method: string, path: string, session?: Session, body?: unknown, headers: Record<string, string> = {}, target = app) => h.call(method, path, session, body, headers, target);
const post = (path: string, session: Session | undefined, body: unknown, version?: string, key = randomUUID()) =>
  call('POST', path, session, body, { 'Idempotency-Key': key, ...(version === undefined ? {} : { 'If-Match': `"${version}"` }) });
const patch = (path: string, session: Session, body: unknown, version: string, key = randomUUID()) =>
  call('PATCH', path, session, body, { 'Idempotency-Key': key, 'If-Match': `"${version}"` });
async function view(s: Store, session = s.owner) { return expect(await call('GET', s.root, session)); }
async function publish(s: Store, action = 'publish') { return post(s.root + '/' + action, s.owner, {}, (await view(s)).version); }
async function add(s: Store, body = product) { return expect(await post(s.root + '/products', s.owner, body), 201); }
async function publicPair(slug: string) {
  const json = await app.request(h.origin + '/api/v1/public/stores/' + slug);
  const html = await app.request(h.origin + '/shops/' + slug);
  return { json, html, jsonText: await json.text(), htmlText: await html.text() };
}
async function offering(key = guild) {
  await h.pool.query(`INSERT INTO guild_application_offerings(offering_id,community_id,guild_key,application_key,release_ref,status,display_order,launch_policy_ref,version)
    VALUES($1,$2,$3,'hosted-store','hosted-store@1.0.0','offered',10,'{"policy_key":"hosted-store.launch","version":"1"}',1)`, [randomUUID(), DEMO_COMMUNITY, key]);
}
async function plan(owner: Session, tenantId: string, workspaceId: string, extra: Record<string, unknown> = {}) {
  return post(`/tenants/${tenantId}/application-launch-plans`, owner, h.planBody(guild, workspaceId, 'hosted-store', 'hosted-store@1.0.0', extra));
}
async function launch(owner: Session, tenantId: string, planned: Reply) {
  return post(`/tenants/${tenantId}/application-installations`, owner, {
    plan_id: planned.data.plan_id, expected_plan_version: planned.data.version, configuration_digest: planned.data.configuration_digest,
  });
}
async function open(owner?: Session, tenantName = '同名業務空間'): Promise<Store> {
  owner ??= (await h.person('合成商店會員')).session;
  await h.fullMember(owner.user.user_id, guild);
  const made = expect(await post('/tenants', owner, { display_name: tenantName, workspace_name: '同名工作區' }), 201);
  const tenantId = made.tenant.tenant_id, workspaceId = made.workspace.workspace_id;
  const planned = await plan(owner, tenantId, workspaceId); expect(planned, 201);
  const launched = await launch(owner, tenantId, planned);
  assert.ok([200, 202].includes(launched.status), JSON.stringify(launched.data));
  assert.equal(launched.data.state, 'succeeded');
  const instanceId = (await h.pool.query(`SELECT instance_id FROM module_instances WHERE tenant_id=$1 AND module_key='storefront'`, [tenantId])).rows[0].instance_id;
  return { owner, tenantId, workspaceId, instanceId, root: `/tenants/${tenantId}/storefronts/${instanceId}` };
}
async function ready(owner?: Session, slug = 'myshop') {
  const s = await open(owner); expect(await post(s.root + '/setup', s.owner, { ...settings, slug }), 201); return s;
}
async function join(s: Store, session: Session, memberRole: 'admin' | 'operator' | 'viewer', keys: string[] = []) {
  const principalId = expect(await call('GET', `/tenants/invite-candidates?user_id=${session.user.user_id}`, s.owner)).principal_id;
  const invitation = await post(`/tenants/${s.tenantId}/invitations`, s.owner, {
    invitee_principal_id: principalId, role: memberRole,
    instance_capabilities: keys.length ? [{ instance_id: s.instanceId, capabilities: keys }] : [],
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  });
  expect(invitation, 201);
  expect(await post(`/tenants/${s.tenantId}/invitations/${invitation.data.invitation_id}/accept`, session, {}, invitation.data.version));
  return principalId;
}
function commands(s: Store) {
  return [
    ['GET', s.root, undefined, undefined], ['POST', s.root + '/setup', settings, undefined],
    ['PATCH', s.root, { name: '更新名字' }, '1'], ['GET', s.root + '/slug-availability?slug=myshop', undefined, undefined],
    ['GET', s.root + '/products', undefined, undefined], ['POST', s.root + '/products', product, undefined],
    ['PATCH', s.root + '/products/' + randomUUID(), { title: '更新商品' }, '1'],
    ['POST', s.root + '/products/' + randomUUID() + '/remove', {}, '1'],
    ['GET', s.root + '/preview', undefined, undefined], ['POST', s.root + '/publish', {}, '1'], ['POST', s.root + '/unpublish', {}, '1'],
  ] as const;
}
async function execute(c: readonly [string, string, unknown, string | undefined], session: Session, target = app) {
  return call(c[0], c[1], session, c[2], c[0] === 'GET' ? {} : { 'Idempotency-Key': randomUUID(), ...(c[3] ? { 'If-Match': `"${c[3]}"` } : {}) }, target);
}
before(async () => {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url && /^\/fp_[a-z0-9_]+$/.test(new URL(url).pathname), 'Explicit disposable TEST_DATABASE_URL is required');
  h = await createRegistryHarness('fp_hosted');
  await h.admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    GRANT USAGE ON SCHEMA ${h.schema} TO ${role};
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${h.schema} TO ${role};
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${h.schema} TO ${role};
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${h.schema} TO ${role};
    REVOKE INSERT,UPDATE,DELETE ON ${h.schema}.module_definitions,${h.schema}.application_definitions,${h.schema}.guild_application_offerings,${h.schema}.tenant_capacity_policies,${h.schema}.tenant_authority_policies FROM ${role};
    GRANT UPDATE(policy_lock) ON ${h.schema}.tenant_capacity_policies,${h.schema}.tenant_authority_policies TO ${role}`);
  const runtimeUrl = new URL(url); runtimeUrl.username = role; runtimeUrl.password = '';
  runtime = new Pool({ connectionString: runtimeUrl.toString(), options: `-c search_path=${h.schema} -c statement_timeout=20000`, max: 12 });
  app = createApp(runtime, h.origin, 'local', { guildLaunchpadEnabled: true });
  closed = createApp(runtime, h.origin, 'local');
});
after(async () => {
  if (runtime) await runtime.end();
  if (h) { await h.stop(); const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL }); try { await admin.query(`DROP ROLE ${role}`); } finally { await admin.end(); } }
});
beforeEach(async () => { await h.reset(); await offering(); });

test('T-024 restricted runtime launches, sets up, edits, previews, publishes and resumes a store in a fresh session', async () => {
  const facts = (await runtime.query(`SELECT r.rolsuper,r.rolbypassrls,c.relowner<>r.oid AS non_owner FROM pg_roles r JOIN pg_class c ON c.relname='commerce_resource_tenants'
    JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname=current_schema() WHERE r.rolname=current_user`)).rows[0];
  assert.deepEqual(facts, { rolsuper: false, rolbypassrls: false, non_owner: true });
  const s = await open();
  const binding = (await h.pool.query(`SELECT instance_id,entry_capability FROM workspace_module_bindings WHERE tenant_id=$1`, [s.tenantId])).rows[0];
  assert.deepEqual(binding, { instance_id: s.instanceId, entry_capability: 'store:manage' });
  const unfinished = expect(await call('GET', '/me/stores', s.owner));
  assert.equal(unfinished.items[0].setup_state, 'setup_required'); assert.equal(unfinished.items[0].instance_id, s.instanceId);
  const setup = expect(await post(s.root + '/setup', s.owner, settings), 201);
  assert.equal(setup.version, '1'); assert.equal(setup.transaction_state, 'not_enabled');
  const first = await add(s), second = await add(s, { ...product, title: '第二項' });
  assert.deepEqual([first.sku, second.sku], ['P0001', 'P0002']);
  const edited = expect(await patch(s.root + '/products/' + first.product_id, s.owner, { title: '更新商品', price_minor: 456, stock: 3 }, first.version));
  assert.equal(edited.version, '2'); assert.equal((await view(s)).version, setup.version);
  const preview = expect(await call('GET', s.root + '/preview', s.owner)); assert.equal(preview.dirty, true); assert.equal(preview.projection.products[0].title, '更新商品');
  const published = expect(await publish(s)); assert.equal(published.publication.current_revision, '1');
  const pair = await publicPair(settings.slug); assert.equal(pair.json.status, 200); assert.equal(pair.html.status, 200);
  assert.equal(pair.json.headers.get('cache-control'), 'public, max-age=60');
  const row = (await h.pool.query(`SELECT i.*,l.snapshot FROM commerce_items i JOIN commerce_selections l USING(item_id) WHERE i.item_id=$1`, [first.product_id])).rows[0];
  assert.equal(row.photo_url, null); assert.equal(row.reserved, 0); assert.equal(row.shipping_minor, '0'); assert.equal(row.snapshot.title, edited.title);
  assert.equal(await h.count('commerce_distribution_acceptances'), 0);
  expect(await post('/auth/logout', s.owner, {}));
  const fresh = await h.signIn(s.owner.user.email, app);
  const resumed = expect(await call('GET', '/me/stores', fresh));
  assert.equal(resumed.items[0].instance_id, s.instanceId); assert.equal(resumed.items[0].setup_state, 'ready'); assert.equal(resumed.items[0].publication_state, 'published');
  assert.equal((await view(s, fresh)).store.slug, settings.slug);
  const quiet = (await runtime.query(`SELECT current_setting('freedom.tenant_id',true) AS t,current_setting('freedom.principal_id',true) AS p,(SELECT count(*)::int FROM commerce_resource_tenants) AS n`)).rows[0];
  assert.ok(!quiet.t && !quiet.p); assert.equal(quiet.n, 0);
});

test('T-017 twenty concurrent launches across workspaces leave exactly one live storefront', async () => {
  const owner = (await h.person('併發會員')).session; await h.fullMember(owner.user.user_id, guild);
  const made = expect(await post('/tenants', owner, { display_name: '併發業務', workspace_name: '櫃檯' }), 201);
  const tenantId = made.tenant.tenant_id, firstWorkspace = made.workspace.workspace_id;
  const other = expect(await post(`/tenants/${tenantId}/workspaces`, owner, { name: '第二櫃檯' }), 201).workspace_id;
  const plans = await Promise.all(Array.from({ length: 20 }, (_, i) => plan(owner, tenantId, i % 2 ? other : firstWorkspace)));
  plans.forEach(r => expect(r, 201));
  const results = await Promise.all(plans.map(p => launch(owner, tenantId, p)));
  for (const r of results) {
    assert.ok([200, 202, 409].includes(r.status), JSON.stringify(r.data));
    if (r.status === 409) assert.ok(['storefront_exists', 'plan_stale', 'installation_selection_required'].includes(r.data.code), JSON.stringify(r.data));
  }
  assert.ok(results.some(r => [200, 202].includes(r.status)));
  assert.equal(await h.count('module_instances', `WHERE tenant_id=$1 AND module_key='storefront' AND status<>'archived'`, [tenantId]), 1);
});

test('T-017 interrupted setup, identical replay and ten concurrent setups preserve one profile and two shops', async () => {
  const s = await open(); assert.equal((await view(s)).version, null);
  assert.equal(expect(await call('GET', '/me/stores', s.owner)).items[0].setup_state, 'setup_required');
  const key = randomUUID(); const first = await post(s.root + '/setup', s.owner, settings, undefined, key); expect(first, 201);
  assert.deepEqual(expect(await post(s.root + '/setup', s.owner, settings, undefined, key), 201), first.data);
  assert.deepEqual(expect(await post(s.root + '/setup', s.owner, settings)), first.data);
  const different = await post(s.root + '/setup', s.owner, { ...settings, name: '不同' }); expect(different, 409); assert.equal(different.data.code, 'storefront_already_set_up');
  const second = await open(s.owner, '第二業務');
  const setup = { ...settings, slug: 'parallel-shop' };
  const results = await Promise.all(Array.from({ length: 10 }, () => post(second.root + '/setup', second.owner, setup)));
  assert.equal(results.filter(r => r.status === 201).length, 1); assert.equal(results.filter(r => r.status === 200).length, 9);
  assert.equal(await h.count('commerce_storefront_profiles', 'WHERE instance_id=$1', [second.instanceId]), 1);
  assert.equal(await h.count('commerce_resource_tenants', 'WHERE instance_id=$1', [second.instanceId]), 2);
  const rows = (await h.pool.query(`SELECT s.*,m.source_owner_id,m.mapping_state FROM commerce_shops s JOIN commerce_resource_tenants m ON m.resource_id=s.shop_id WHERE m.instance_id=$1`, [second.instanceId])).rows;
  assert.equal(rows.length, 2); assert.deepEqual(rows.map(r => r.kind).sort(), ['internal', 'public']);
  const principal = (await h.pool.query(`SELECT principal_id FROM principals WHERE user_ref=$1 AND kind='person'`, [second.owner.user.user_id])).rows[0].principal_id;
  for (const r of rows) {
    assert.equal(r.origin, 'hosted'); assert.equal(r.mode, 'test'); assert.equal(r.accepting_orders, false); assert.equal(r.contact, ''); assert.equal(r.website_url, '');
    assert.equal(r.source_owner_id, principal); assert.equal(r.mapping_state, 'confirmed');
    assert.equal(r.manifest_sha256, createHash('sha256').update(`freedom.hosted-store/v1\n${second.instanceId}\n${r.kind === 'internal' ? 'supply' : 'storefront'}`).digest('hex'));
  }
});

test('T-008 T-020 another workspace reuses products and grants, explicit create refuses, and archive permits replacement', async () => {
  const s = await ready(); const item = await add(s); expect(await publish(s));
  const workspace = expect(await post(`/tenants/${s.tenantId}/workspaces`, s.owner, { name: '沿用櫃檯' }), 201).workspace_id;
  const planned = await plan(s.owner, s.tenantId, workspace); expect(planned, 201); const launched = await launch(s.owner, s.tenantId, planned); assert.ok([200, 202].includes(launched.status));
  assert.equal(await h.count('module_instances', `WHERE tenant_id=$1 AND module_key='storefront'`, [s.tenantId]), 1);
  assert.deepEqual((await h.pool.query(`SELECT instance_id FROM workspace_module_bindings WHERE tenant_id=$1 ORDER BY workspace_id`, [s.tenantId])).rows.map(r => r.instance_id), [s.instanceId, s.instanceId]);
  assert.equal(expect(await call('GET', s.root + '/products', s.owner)).items[0].product_id, item.product_id);
  const member = (await h.person('沿用讀者')).session; await join(s, member, 'operator', ['store:read']); assert.equal((await view(s, member)).writable, false);
  const third = expect(await post(`/tenants/${s.tenantId}/workspaces`, s.owner, { name: '新建拒絕' }), 201).workspace_id;
  const explicit = await plan(s.owner, s.tenantId, third, { dependencies: [{ requirement_key: 'storefront', choice: 'create', configuration: {} }] }); expect(explicit, 201);
  const refused = await launch(s.owner, s.tenantId, explicit); expect(refused, 409); assert.equal(refused.data.code, 'storefront_exists');
  const detail = expect(await call('GET', `/tenants/${s.tenantId}/module-instances/${s.instanceId}`, s.owner));
  expect(await post(`/tenants/${s.tenantId}/module-instances/${s.instanceId}/archive`, s.owner, { reason: '合成封存' }, detail.version));
  assert.equal((await publicPair(settings.slug)).json.status, 404);
  assert.equal(expect(await call('GET', '/me/stores', s.owner)).items.length, 0);
  const replacement = await plan(s.owner, s.tenantId, third); expect(replacement, 201); const next = await launch(s.owner, s.tenantId, replacement); assert.ok([200, 202].includes(next.status), JSON.stringify(next.data));
  assert.equal(await h.count('module_instances', `WHERE tenant_id=$1 AND module_key='storefront' AND status<>'archived'`, [s.tenantId]), 1);
  assert.notEqual(expect(await call('GET', '/me/stores', s.owner)).items[0].instance_id, s.instanceId);
});

test('T-017 a failed storefront without a profile is hidden and permits a new store in another workspace', async () => {
  const s = await open();
  assert.equal(await h.count('commerce_storefront_profiles', 'WHERE instance_id=$1', [s.instanceId]), 0);
  assert.equal(expect(await call('GET', '/me/stores', s.owner)).items[0].instance_id, s.instanceId);
  const q = await h.pool.connect();
  try {
    await q.query('BEGIN');
    // Simulate the terminal state setInstance writes during provisioning in
    // operations.ts. There is no transition trigger; no store setup has run.
    await q.query(`UPDATE module_instances SET status='failed',version=version+1 WHERE tenant_id=$1 AND instance_id=$2`, [s.tenantId, s.instanceId]);
    await q.query(`UPDATE deployment_bindings SET state='retired',version=version+1
      WHERE tenant_id=$1 AND instance_id=$2 AND state<>'retired'`, [s.tenantId, s.instanceId]);
    await q.query('COMMIT');
  } finally { await q.query('ROLLBACK'); q.release(); }
  assert.deepEqual(expect(await call('GET', '/me/stores', s.owner)).items, []);
  const missing = await app.request(h.origin + '/api/v1' + s.root.replace(s.instanceId, randomUUID()), { headers: { Cookie: s.owner.cookie } });
  const failed = await app.request(h.origin + '/api/v1' + s.root, { headers: { Cookie: s.owner.cookie } });
  assert.equal(missing.status, 404); assert.equal(failed.status, 404);
  assert.deepEqual(await failed.arrayBuffer(), await missing.arrayBuffer());
  assert.deepEqual([...failed.headers], [...missing.headers]);
  const unavailable = await post(s.root + '/setup', s.owner, settings);
  expect(unavailable, 409); assert.equal(unavailable.data.code, 'storefront_unavailable');
  // A real provisioning failure has no entry binding. This simulated failure
  // follows a successful launch, so retain its binding and use another workspace.
  const workspace = expect(await post(`/tenants/${s.tenantId}/workspaces`, s.owner, { name: '失敗後新櫃檯' }), 201).workspace_id;
  const planned = await plan(s.owner, s.tenantId, workspace); expect(planned, 201);
  const launched = await launch(s.owner, s.tenantId, planned);
  assert.ok([200, 202].includes(launched.status), JSON.stringify(launched.data));
  assert.equal(launched.data.state, 'succeeded');
  assert.equal(await h.count('module_instances', `WHERE tenant_id=$1 AND module_key='storefront' AND status NOT IN ('archived','failed')`, [s.tenantId]), 1);
  const next = expect(await call('GET', '/me/stores', s.owner)).items;
  assert.equal(next.length, 1); assert.notEqual(next[0].instance_id, s.instanceId);
  assert.equal(next[0].setup_state, 'setup_required');
  const root = `/tenants/${s.tenantId}/storefronts/${next[0].instance_id}`;
  assert.equal(expect(await post(root + '/setup', s.owner, settings), 201).setup_state, 'ready');
  assert.equal(await h.count('commerce_storefront_profiles', 'WHERE instance_id=$1', [s.instanceId]), 0);
});

test('T-011 names preserve identity, draft slug can change and published slug is locked by API and SQL', async () => {
  const s = await ready(); let v = await view(s);
  v = expect(await patch(s.root, s.owner, { name: '新名字' }, v.version)); assert.equal(v.instance_id, s.instanceId); assert.equal(v.store.slug, settings.slug);
  v = expect(await patch(s.root, s.owner, { slug: 'NewShop', description: '新說明' }, v.version)); assert.equal(v.store.slug, 'newshop');
  const shops = (await h.pool.query(`SELECT name,description FROM commerce_shops s JOIN commerce_resource_tenants m ON m.resource_id=s.shop_id WHERE m.instance_id=$1`, [s.instanceId])).rows;
  assert.deepEqual(shops, [{ name: '新名字', description: '新說明' }, { name: '新名字', description: '新說明' }]);
  await add(s); expect(await publish(s)); v = await view(s);
  const locked = await patch(s.root, s.owner, { slug: 'another-shop' }, v.version); expect(locked, 409); assert.equal(locked.data.code, 'storefront_slug_locked');
  await assert.rejects(h.pool.query(`UPDATE commerce_storefront_profiles SET slug='sql-shop' WHERE instance_id=$1`, [s.instanceId]), { code: '23514' });
  v = expect(await patch(s.root, s.owner, { name: '公開新名字' }, v.version)); assert.equal(v.publication.public_path, '/shops/newshop'); assert.equal(v.instance_id, s.instanceId);
});

test('T-012 text, amount, stock, currency, slug and 200-product bounds reject invalid inputs', async () => {
  const s = await open();
  for (const bad of [
    { name: '' }, { name: 'x'.repeat(81) }, { brand: '' }, { brand: 'x'.repeat(81) }, { description: 'x'.repeat(2001) },
    { slug: 'ab' }, { slug: 'x'.repeat(41) }, { slug: 'ends-' }, { currency: 'JPY' }, { name: 'has\u0001control' }, { description: 'has\tcontrol' }, { owner_id: randomUUID() },
  ]) expect(await post(s.root + '/setup', s.owner, { ...settings, ...bad }), 422);
  const reserved = await post(s.root + '/setup', s.owner, { ...settings, slug: 'AdMiN' }); expect(reserved, 422); assert.equal(reserved.data.code, 'storefront_slug_reserved');
  expect(await post(s.root + '/setup', s.owner, { ...settings, name: ' ' + 'x'.repeat(80) + ' ', brand: 'x'.repeat(80), description: 'x'.repeat(2000), slug: 'MyShop' }), 201);
  assert.equal((await view(s)).store.slug, 'myshop');
  expect(await patch(s.root, s.owner, { currency: 'USD' }, '1'), 422); expect(await patch(s.root, s.owner, {}, '1'), 422);
  const second = await open(s.owner); const taken = await post(second.root + '/setup', second.owner, { ...settings, slug: 'MYSHOP' }); expect(taken, 409); assert.equal(taken.data.code, 'storefront_slug_taken');
  for (const [slug, reason] of [['MYSHOP', 'taken'], ['admin', 'reserved'], ['bad_', 'invalid'], ['free-shop', null]] as const) {
    const answer = expect(await call('GET', second.root + '/slug-availability?slug=' + slug, second.owner)); assert.equal(answer.reason, reason); assert.equal(answer.available, reason === null);
  }
  for (const bad of [
    { title: '' }, { title: 'x'.repeat(121) }, { description: 'x'.repeat(2001) }, { price_minor: 0 }, { price_minor: -1 }, { price_minor: 100000001 }, { price_minor: 1.1 },
    { stock: -1 }, { stock: 1000001 }, { stock: 1.1 }, { title: 'control\u0002' }, { description: 'control\r' }, { principal_id: randomUUID() },
  ]) expect(await post(s.root + '/products', s.owner, { ...product, ...bad }), 422);
  const valid = await add(s, { title: 'x'.repeat(120), description: 'x'.repeat(2000), price_minor: 100000000, stock: 1000000 });
  expect(await patch(s.root + '/products/' + valid.product_id, s.owner, {}, valid.version), 422);
  const p = (await h.pool.query(`SELECT * FROM commerce_storefront_profiles WHERE instance_id=$1`, [s.instanceId])).rows[0];
  await h.pool.query(`INSERT INTO commerce_items(item_id,shop_id,sku,title,description,price_minor,shipping_minor,stock,reserved,shipping_terms,return_terms)
    SELECT gen_random_uuid(),$1,'P'||lpad(n::text,4,'0'),'合成批次','',1,0,0,0,'尚未設定','尚未設定' FROM generate_series(2,200) n`, [p.supply_shop_id]);
  await h.pool.query(`INSERT INTO commerce_selections(selection_id,shop_id,item_id,retail_price_minor,sale_terms,snapshot)
    SELECT gen_random_uuid(),$1,item_id,1,'尚未啟用',jsonb_build_object('sku',sku,'title',title,'description',description,'price_minor',1,'currency','TWD')
    FROM commerce_items WHERE shop_id=$2 AND item_id<>$3`, [p.storefront_shop_id, p.supply_shop_id, valid.product_id]);
  await h.pool.query(`UPDATE commerce_storefront_profiles SET product_seq=200 WHERE instance_id=$1`, [s.instanceId]);
  const capped = await post(s.root + '/products', s.owner, product); expect(capped, 409); assert.equal(capped.data.code, 'storefront_product_limit');
  assert.equal((await view(s)).product_count, 200);
});

test('T-012 every member text field is escaped in HTML while public JSON preserves raw text', async () => {
  const s = await open(); const attack = '<script>x</script> "><img onerror=x> &';
  expect(await post(s.root + '/setup', s.owner, { ...settings, name: attack, brand: attack, description: attack + '\n第二段' }), 201);
  await add(s, { ...product, title: attack, description: attack + '\n第二段' }); expect(await publish(s));
  const pair = await publicPair(settings.slug); const json = JSON.parse(pair.jsonText);
  assert.equal(json.name, attack); assert.equal(json.brand, attack); assert.equal(json.description, attack + '\n第二段'); assert.equal(json.products[0].title, attack); assert.equal(json.products[0].description, attack + '\n第二段');
  assert.doesNotMatch(pair.htmlText, /<script|<img onerror/i);
  assert.match(pair.htmlText, /&lt;script&gt;/); assert.match(pair.htmlText, /&quot;&gt;&lt;img onerror=x&gt; &amp;/); assert.match(pair.htmlText, /<p>第二段<\/p>/);
});

test('T-006 public allowlist hides identifiers and all hidden cases return identical bodies and headers', async () => {
  const s = await ready(); const item = await add(s); expect(await publish(s));
  const shown = await publicPair(settings.slug); const json = JSON.parse(shown.jsonText);
  assert.deepEqual(Object.keys(json).sort(), ['slug','name','brand','description','currency','products','revision','published_at','transaction_state'].sort());
  assert.deepEqual(Object.keys(json.products[0]).sort(), ['sku','title','description','price_minor'].sort());
  const p = (await h.pool.query(`SELECT * FROM commerce_storefront_profiles WHERE instance_id=$1`, [s.instanceId])).rows[0];
  for (const secret of [s.tenantId,s.instanceId,p.supply_shop_id,p.storefront_shop_id,p.created_by_principal_id,s.owner.user.user_id,s.owner.user.email,item.product_id,'"stock"']) {
    assert.equal(shown.jsonText.includes(secret), false, secret); assert.equal(shown.htmlText.includes(secret), false, secret);
  }
  assert.doesNotMatch(shown.htmlText, /<form|<button|<script|checkout|cart/i); assert.match(shown.htmlText, /店鋪／商品展示已就緒，交易尚未啟用/); assert.match(shown.htmlText, /name="robots" content="noindex"/);
  const missing = await publicPair('unknown-shop');
  async function hidden(slug = settings.slug) {
    const r = await publicPair(slug); assert.equal(r.json.status, 404); assert.equal(r.html.status, 404);
    assert.equal(r.jsonText, missing.jsonText); assert.equal(r.htmlText, missing.htmlText);
    assert.deepEqual([...r.json.headers], [...missing.json.headers]); assert.deepEqual([...r.html.headers], [...missing.html.headers]);
    assert.equal(r.json.headers.get('cache-control'), 'no-store'); assert.equal(r.html.headers.get('cache-control'), 'no-store');
  }
  await hidden('bad_slug');
  const never = await ready(s.owner, 'never-published'); await hidden('never-published'); assert.equal((await view(never)).publication.state, 'never_published');
  expect(await publish(s, 'unpublish')); await hidden(); expect(await publish(s));
  for (const status of ['suspended', 'recovery_required']) {
    await h.pool.query('UPDATE tenants SET status=$2 WHERE tenant_id=$1', [s.tenantId, status]); await hidden();
  }
  await h.pool.query(`UPDATE tenants SET status='active' WHERE tenant_id=$1`, [s.tenantId]);
  await h.pool.query(`UPDATE module_instances SET status='suspended' WHERE instance_id=$1`, [s.instanceId]); await hidden();
  await h.pool.query(`UPDATE module_instances SET status='active' WHERE instance_id=$1`, [s.instanceId]);
  await h.pool.query(`UPDATE commerce_resource_tenants SET mapping_state='ambiguous' WHERE resource_id=$1`, [p.storefront_shop_id]); await hidden();
  await h.pool.query(`UPDATE commerce_resource_tenants SET mapping_state='confirmed' WHERE resource_id=$1`, [p.storefront_shop_id]);
  await h.pool.query(`DELETE FROM commerce_resource_tenants WHERE resource_id=$1`, [p.storefront_shop_id]); await hidden();
  await h.pool.query(`INSERT INTO commerce_resource_tenants(resource_kind,resource_id,tenant_id,instance_id,source_owner_id,mapping_state) VALUES('shop',$1,$2,$3,$4,'confirmed')`, [p.storefront_shop_id,s.tenantId,s.instanceId,p.created_by_principal_id]);
  await h.pool.query(`UPDATE users SET email='synthetic-verification@example.invalid' WHERE user_id=$1`, [s.owner.user.user_id]); await hidden();
  await h.pool.query(`UPDATE users SET email=$2,active=false WHERE user_id=$1`, [s.owner.user.user_id,s.owner.user.email]); await hidden();
});

test('T-006 T-024 public stores derive tenant context only from the slug regardless of sessions, headers or query', async () => {
  const a = await open();
  expect(await post(a.root + '/setup', a.owner, { ...settings, name: '甲店展示', slug: 'tenant-a-shop' }), 201);
  await add(a, { ...product, title: '甲店商品一' }); await add(a, { ...product, title: '甲店商品二' }); expect(await publish(a));
  const b = await open();
  expect(await post(b.root + '/setup', b.owner, { ...settings, name: '乙店專屬名稱', slug: 'tenant-b-shop' }), 201);
  await add(b, { ...product, title: '乙店專屬商品' }); expect(await publish(b));
  assert.notEqual(a.tenantId, b.tenantId); assert.notEqual(a.owner.user.user_id, b.owner.user.user_id);
  const memberships = (await h.pool.query(`SELECT m.tenant_id FROM tenant_memberships m JOIN principals p USING(principal_id)
    WHERE p.user_ref=$1 AND m.status='active' ORDER BY m.tenant_id`, [b.owner.user.user_id])).rows;
  assert.deepEqual(memberships, [{ tenant_id: b.tenantId }]);
  const stray = { 'X-Freedom-Tenant': b.tenantId, 'X-Tenant-Id': b.tenantId, 'Freedom-Tenant-Id': b.tenantId,
    Authorization: 'Bearer fw_shop_' + randomBytes(32).toString('base64url') };
  const query = `?tenant_id=${b.tenantId}&instance_id=${b.instanceId}&slug=tenant-b-shop`;
  const memberB = { Cookie: b.owner.cookie, 'X-CSRF-Token': b.owner.csrf };
  const variants: { name: string; headers: Record<string, string>; query: string }[] = [
    { name: 'anonymous', headers: {}, query: '' },
    { name: 'tenant B session', headers: memberB, query: '' },
    { name: 'owner A session', headers: { Cookie: a.owner.cookie }, query: '' },
    { name: 'stray tenant and bearer headers', headers: stray, query: '' },
    { name: 'stray tenant query', headers: {}, query },
    { name: 'tenant B session plus all stray inputs', headers: { ...memberB, ...stray }, query },
  ];
  async function snapshot(path: string, headers: HeadersInit = {}) {
    const response = await app.request(h.origin + path, { headers });
    // app.request adds no Date header, so compare the complete header list.
    return { status: response.status, body: Buffer.from(await response.arrayBuffer()), headers: [...response.headers] };
  }
  for (const state of ['published', 'unpublished', 'never existed']) {
    if (state === 'unpublished') expect(await publish(a, 'unpublish'));
    const slug = state === 'never existed' ? 'never-existed-shop' : 'tenant-a-shop';
    for (const path of [`/shops/${slug}`, `/api/v1/public/stores/${slug}`]) {
      const reference = await snapshot(path);
      assert.equal(reference.status, state === 'published' ? 200 : 404);
      if (state === 'published') {
        for (const privateB of ['乙店專屬名稱', 'tenant-b-shop', '乙店專屬商品']) assert.equal(reference.body.toString('utf8').includes(privateB), false);
        if (path.startsWith('/api/')) assert.equal(JSON.parse(reference.body.toString('utf8')).products.length, 2);
      }
      for (const variant of variants) {
        assert.deepEqual(await snapshot(path + variant.query, variant.headers), reference, `${state}: ${path}: ${variant.name}`);
      }
    }
  }
  // Hold every runtime pool client together so an idle connection cannot escape
  // the context check by being repeatedly reused for each checkout.
  const clients: PoolClient[] = [];
  try {
    for (let n = 0; n < runtime.options.max; n++) clients.push(await runtime.connect());
    const contexts = await Promise.all(clients.map(async q => (await q.query(`SELECT pg_backend_pid() AS pid,
      current_setting('freedom.tenant_id',true) AS tenant_id,current_setting('freedom.tenant_scope_id',true) AS tenant_scope_id,
      current_setting('freedom.principal_id',true) AS principal_id`)).rows[0]));
    assert.equal(new Set(contexts.map(c => c.pid)).size, runtime.options.max);
    for (const c of contexts) assert.ok(!c.tenant_id && !c.tenant_scope_id && !c.principal_id, 'Runtime connection must have no residual tenant or principal context');
  } finally { for (const q of clients) q.release(); }
});

test('T-016 a disabled setup admin does not hide a store with a current active owner', async () => {
  const s = await open();
  const setupAdmin = (await h.person('合成設定管理者')).session;
  await join(s, setupAdmin, 'admin');
  expect(await post(s.root + '/setup', setupAdmin, settings), 201);
  await add(s); expect(await publish(s));
  const profile = (await h.pool.query('SELECT storefront_shop_id FROM commerce_storefront_profiles WHERE instance_id=$1', [s.instanceId])).rows[0];
  assert.equal((await h.pool.query('SELECT owner_id FROM commerce_shops WHERE shop_id=$1', [profile.storefront_shop_id])).rows[0].owner_id, setupAdmin.user.user_id);
  const id = randomUUID();
  const admin: AdminActor = { admin_id:id, community_id:DEMO_COMMUNITY, email:'synthetic-admin@example.test', display_name:'合成管理員', role:'super_admin', subject:id };
  await h.pool.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)', [id,DEMO_COMMUNITY,admin.email,admin.display_name]);
  await changeMemberStatus(h.pool, { admin, operation:'member.status', key:randomUUID(), body:{active:false,reason:'合成設定者停用'}, expected:'1' }, setupAdmin.user.user_id);
  assert.equal((await h.pool.query('SELECT status FROM tenants WHERE tenant_id=$1', [s.tenantId])).rows[0].status, 'active');
  assert.equal((await h.pool.query('SELECT status FROM module_instances WHERE instance_id=$1', [s.instanceId])).rows[0].status, 'active');
  const shown = await publicPair(settings.slug);
  assert.equal(shown.json.status, 200); assert.equal(shown.html.status, 200);
  expect(await publish(s));
  await changeMemberStatus(h.pool, { admin, operation:'member.status', key:randomUUID(), body:{active:false,reason:'合成最後店主停用'}, expected:'1' }, s.owner.user.user_id);
  const hidden = await publicPair(settings.slug), missing = await publicPair('unknown-shop');
  assert.equal(hidden.json.status, 404); assert.equal(hidden.html.status, 404);
  assert.equal(hidden.jsonText, missing.jsonText); assert.equal(hidden.htmlText, missing.htmlText);
  assert.deepEqual([...hidden.json.headers], [...missing.json.headers]);
  assert.deepEqual([...hidden.html.headers], [...missing.html.headers]);
});

test('T-016 account closure revokes sessions, tenant and instance liveness hide public pages, and FK cleanup cascades', async () => {
  const s = await ready(); await add(s); expect(await publish(s));
  const id = randomUUID(); const admin: AdminActor = { admin_id:id,community_id:DEMO_COMMUNITY,email:'synthetic-admin@example.test',display_name:'合成管理員',role:'super_admin',subject:id };
  await h.pool.query(`INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)`, [id,DEMO_COMMUNITY,admin.email,admin.display_name]);
  const changed = await changeMemberStatus(h.pool, { admin,operation:'member.status',key:randomUUID(),body:{active:false,reason:'合成停用'},expected:'1' }, s.owner.user.user_id);
  const hidden = await publicPair(settings.slug); assert.equal(hidden.json.status,404); assert.equal(hidden.html.status,404); assert.equal((await call('GET','/me/stores',s.owner)).status,401);
  assert.equal((await h.pool.query('SELECT status FROM tenants WHERE tenant_id=$1',[s.tenantId])).rows[0].status,'recovery_required');
  await changeMemberStatus(h.pool, { admin,operation:'member.status',key:randomUUID(),body:{active:true,reason:'合成恢復'},expected:String(changed.aggregate_version) }, s.owner.user.user_id);
  assert.equal((await h.pool.query('SELECT status FROM tenants WHERE tenant_id=$1',[s.tenantId])).rows[0].status,'active'); assert.equal((await publicPair(settings.slug)).json.status,200);
  s.owner = await h.signIn(s.owner.user.email,app);
  const detail=expect(await call('GET',`/tenants/${s.tenantId}/module-instances/${s.instanceId}`,s.owner));
  expect(await post(`/tenants/${s.tenantId}/module-instances/${s.instanceId}/suspend`,s.owner,{reason:'合成暫停'},detail.version));
  assert.equal((await publicPair(settings.slug)).json.status,404);
  const denied=await post(s.root+'/products',s.owner,product); expect(denied,409); assert.equal(denied.data.code,'storefront_unavailable');
  const fks=(await h.pool.query(`SELECT target.relname FROM pg_constraint f JOIN pg_class source ON source.oid=f.conrelid JOIN pg_namespace n ON n.oid=source.relnamespace
    JOIN pg_class target ON target.oid=f.confrelid WHERE n.nspname=current_schema() AND f.contype='f' AND source.relname=ANY($1::text[])`,[['commerce_resource_tenants','commerce_storefront_profiles','commerce_storefront_publications']])).rows;
  assert.equal(fks.some(r=>['users','sessions'].includes(r.relname)),false);
  const p=(await h.pool.query('SELECT * FROM commerce_storefront_profiles WHERE instance_id=$1',[s.instanceId])).rows[0];
  await h.pool.query('DELETE FROM commerce_selections WHERE shop_id=$1',[p.storefront_shop_id]);
  await h.pool.query('DELETE FROM commerce_items WHERE shop_id=$1',[p.supply_shop_id]);
  await h.pool.query('DELETE FROM commerce_shops WHERE shop_id=ANY($1::uuid[])',[[p.supply_shop_id,p.storefront_shop_id]]);
  for(const table of ['commerce_storefront_profiles','commerce_resource_tenants','commerce_storefront_publications']) assert.equal(await h.count(table,'WHERE instance_id=$1',[s.instanceId]),0);
});

test('T-013 owner and admin can write, explicit read grants cannot write, foreign tenants and non-members see uniform 404', async () => {
  const s=await ready(); const admin=(await h.person('合成管理者')).session; await join(s,admin,'admin');
  assert.deepEqual((await view(s,admin)).capabilities,['store:manage','store:read','store:write','store:publish']);
  expect(await post(s.root+'/products',admin,product),201);
  const reader=(await h.person('合成操作者')).session; const principal=await join(s,reader,'operator',['store:read']);
  assert.deepEqual((await view(s,reader)).capabilities,['store:read']);
  for(const c of commands(s).filter(c=>c[0]!=='GET')) { const denied=await execute(c,reader); expect(denied,403); assert.equal(denied.data.code,'capability_denied'); }
  const viewer=(await h.person('合成檢視者')).session; await join(s,viewer,'viewer',['store:read']); assert.equal((await view(s,viewer)).writable,false);
  const viewerPrincipal=expect(await call('GET',`/tenants/invite-candidates?user_id=${viewer.user.user_id}`,s.owner)).principal_id;
  const bad=await post(`/tenants/${s.tenantId}/members/${viewerPrincipal}/change`,s.owner,{role:'viewer',status:'active',instance_capabilities:[{instance_id:s.instanceId,capabilities:['store:read','store:write']}],reason:'合成權限'},'1'); expect(bad,422);
  const foreign=await ready(undefined,'tenant-b-shop'); const outsider=(await h.person('合成外人')).session;
  for(const session of [foreign.owner,outsider]) for(const c of commands(s)) {
    const denied=await execute(c,session); expect(denied,404); assert.equal(denied.data.code,'not_found'); assert.equal(denied.data.detail,'找不到這間商店。');
    assert.equal(denied.response.headers.get('cache-control'),'private, no-store'); assert.equal(denied.response.headers.get('x-robots-tag'),'noindex, nofollow');
  }
  assert.deepEqual(expect(await call('GET','/me/stores',reader)).items.map((x:any)=>x.instance_id),[s.instanceId]);
  assert.deepEqual(expect(await call('GET','/me/stores',foreign.owner)).items.map((x:any)=>x.instance_id),[foreign.instanceId]);
  assert.deepEqual(expect(await call('GET','/me/stores',outsider)).items,[]);
  // A revoked grant must invalidate old command receipts as well as reads.
  const receiptKey=randomUUID(); expect(await post(s.root+'/products',admin,product,undefined,receiptKey),201);
  const adminPrincipal=expect(await call('GET',`/tenants/invite-candidates?user_id=${admin.user.user_id}`,s.owner)).principal_id;
  expect(await post(`/tenants/${s.tenantId}/members/${adminPrincipal}/change`,s.owner,{role:'viewer',status:'active',instance_capabilities:[],reason:'合成撤銷'},'1'));
  expect(await post(s.root+'/products',admin,product,undefined,receiptKey),404);
  const member=expect(await call('GET',`/tenants/${s.tenantId}/members`,s.owner)).items.find((x:any)=>x.principal_id===principal);
  expect(await post(`/tenants/${s.tenantId}/members/${principal}/change`,s.owner,{role:'operator',status:'revoked',instance_capabilities:[],reason:'合成離開'},member.version));
  expect(await call('GET',s.root,reader),404); assert.deepEqual(expect(await call('GET','/me/stores',reader)).items,[]);
});

test('T-016 a deployment hold committed during authorization refuses both a fresh product write and receipt replay', async () => {
  const s=await ready(); const key=randomUUID();
  const command=()=>post(s.root+'/products',s.owner,product,undefined,key);
  async function holdThenRefuse() {
    const blocker=await h.pool.connect(); let pending: Promise<Reply> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM deployment_bindings WHERE tenant_id=$1 AND instance_id=$2 FOR UPDATE',[s.tenantId,s.instanceId]);
      const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      pending=command();
      let waiting=false;
      const deadline=Date.now()+20000;
      while(Date.now()<deadline) {
        const blocked=await h.pool.query(`SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND usename=$2 AND query LIKE '%deployment_bindings%'`,[pid,role]);
        if(blocked.rowCount) { waiting=true;break; }
        await delay(10);
      }
      assert.equal(waiting,true,'Command did not block on the held deployment row within 20 seconds before changing products');
      await blocker.query(`UPDATE deployment_bindings SET state='suspended' WHERE tenant_id=$1 AND instance_id=$2`,[s.tenantId,s.instanceId]);
      await blocker.query('COMMIT');
      const refused=await pending;expect(refused,409);assert.equal(refused.data.code,'storefront_unavailable');
    } finally {
      await blocker.query('ROLLBACK');blocker.release();
      if(pending)await pending;
    }
  }
  await holdThenRefuse(); assert.equal((await view(s)).product_count,0);
  await h.pool.query(`UPDATE deployment_bindings SET state='active' WHERE tenant_id=$1 AND instance_id=$2`,[s.tenantId,s.instanceId]);
  expect(await command(),201);
  await holdThenRefuse(); assert.equal((await view(s)).product_count,1);
});

test('T-007 commerce guild leadership gives no access to another member store', async () => {
  const s=await ready(); await add(s);
  const leader=(await h.person('合成公會長')).session; await h.fullMember(leader.user.user_id,guild);
  await h.pool.query(`INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) VALUES($1,$2,$3) ON CONFLICT(community_id,guild_key) DO UPDATE SET user_id=$3`,[DEMO_COMMUNITY,guild,leader.user.user_id]);
  for(const c of commands(s)) expect(await execute(c,leader),404);
  assert.deepEqual(expect(await call('GET','/me/stores',leader)).items,[]);
  for(const path of ['/guilds','/me/guilds',`/guilds/${guild}/profile`,`/guilds/${guild}/launchpad`]) {
    const r=await call('GET',path,leader); const text=JSON.stringify(r.data); assert.equal(text.includes(s.instanceId),false); assert.equal(text.includes(s.tenantId),false); assert.equal(text.includes(settings.slug),false);
  }
});

test('T-008 changing the primary guild preserves store identity, products and publication', async () => {
  const s=await ready(); const item=await add(s); expect(await publish(s));
  const nextGuild='guild_ai_field'; await h.fullMember(s.owner.user.user_id,nextGuild);
  const prefs=expect(await call('GET','/me/guild-preferences',s.owner));
  expect(await post(`/guilds/${nextGuild}/primary`,s.owner,{},prefs.aggregate_version==null?undefined:String(prefs.aggregate_version)));
  assert.equal(expect(await call('GET','/me/guild-preferences',s.owner)).primary_guild_key,nextGuild);
  assert.equal(expect(await call('GET','/me/stores',s.owner)).items[0].instance_id,s.instanceId);
  assert.equal((await view(s)).store.slug,settings.slug); assert.equal(expect(await call('GET',s.root+'/products',s.owner)).items[0].product_id,item.product_id);
  assert.equal((await publicPair(settings.slug)).json.status,200);
});

test('T-006 publication revisions, unpublish, immutable snapshots and disabled orders are enforced', async () => {
  const s=await ready(); const empty=await publish(s); expect(empty,409); assert.equal(empty.data.code,'storefront_has_no_products');
  let item=await add(s); let v=expect(await publish(s)); assert.equal(v.publication.current_revision,'1');
  const same=expect(await publish(s)); assert.equal(same.version,v.version); assert.equal(same.publication.current_revision,'1');
  item=expect(await patch(s.root+'/products/'+item.product_id,s.owner,{title:'新商品'},item.version));
  assert.equal(JSON.parse((await publicPair(settings.slug)).jsonText).products[0].title,product.title);
  v=expect(await publish(s)); assert.equal(v.publication.current_revision,'2');
  expect(await publish(s,'unpublish')); assert.equal((await publicPair(settings.slug)).json.status,404);
  v=await view(s); assert.equal(expect(await publish(s,'unpublish')).version,v.version);
  assert.equal(expect(await publish(s)).publication.current_revision,'3');
  await assert.rejects(h.pool.query('UPDATE commerce_storefront_publications SET projection=projection WHERE instance_id=$1',[s.instanceId]),{code:'23514'});
  await assert.rejects(h.pool.query(`UPDATE commerce_shops SET accepting_orders=true WHERE origin='hosted'`),{code:'23514'});
  const removeKey=randomUUID(); expect(await post(s.root+'/products/'+item.product_id+'/remove',s.owner,{},item.version,removeKey));
  expect(await post(s.root+'/products/'+item.product_id+'/remove',s.owner,{},item.version,removeKey));
  assert.equal((await add(s)).sku,'P0002');
});

test('T-022 command header, CAS, strict query and idempotency errors follow platform conventions', async () => {
  const s=await ready();
  const other=await ready(s.owner,'other-store'); const foreignProduct=await add(other);
  for(const c of commands(s)) {
    const missing=await execute([c[0],c[1].replace(s.instanceId,randomUUID()),c[2],c[3]],s.owner);
    const foreign=await execute([c[0],c[1].replace(s.instanceId,other.instanceId),c[2],c[3]],s.owner);
    expect(missing,404); assert.deepEqual(foreign.data,missing.data); assert.equal(foreign.status,404);
  }
  const work=expect(await post(`/tenants/${s.tenantId}/workspaces`,s.owner,{name:'人工櫃檯'}),201).workspace_id;
  await h.fullMember(s.owner.user.user_id,'guild_ai_field');
  expect(await h.enable(s.owner,s.tenantId,work,'guild_ai_field'));
  const workId=(await h.pool.query(`SELECT instance_id FROM module_instances WHERE tenant_id=$1 AND module_key='work'`,[s.tenantId])).rows[0].instance_id;
  for(const c of commands(s)) expect(await execute([c[0],c[1].replace(s.instanceId,workId),c[2],c[3]],s.owner),404);
  const hiddenProduct=await patch(s.root+'/products/'+foreignProduct.product_id,s.owner,{title:'跨租戶'},foreignProduct.version); expect(hiddenProduct,404);
  const missingProduct=await patch(s.root+'/products/'+randomUUID(),s.owner,{title:'跨租戶'},'1'); assert.deepEqual(hiddenProduct.data,missingProduct.data);
  await h.pool.query(`UPDATE module_instances SET status='archived' WHERE instance_id=$1`,[other.instanceId]);
  const archived=await post(other.root+'/products',s.owner,product); expect(archived,409); assert.equal(archived.data.code,'storefront_unavailable');
  expect(await call('GET',other.root,s.owner),404);
  for(const [headers,status,code] of [
    [{},400,'idempotency_required'],[{'Idempotency-Key':randomUUID()},428,'version_required'],
    [{'Idempotency-Key':randomUUID(),'If-Match':'bad'},400,'invalid_version'],
    [{'Idempotency-Key':randomUUID(),'If-Match':'"99"'},412,'version_conflict'],
  ] as const) { const r=await call('PATCH',s.root,s.owner,{name:'修改'},headers); expect(r,status); assert.equal(r.data.code,code); }
  const key=randomUUID(); const first=expect(await patch(s.root,s.owner,{name:'修改'},'1',key));
  assert.deepEqual(expect(await patch(s.root,s.owner,{name:'修改'},'1',key)),first);
  const conflict=await patch(s.root,s.owner,{name:'不同'},first.version,key); expect(conflict,409); assert.equal(conflict.data.code,'idempotency_conflict');
  expect(await call('GET',s.root+'?extra=value',s.owner),422); expect(await call('GET',s.root+'/slug-availability?slug=abc&slug=def',s.owner),422);
  const malformed=await app.request(h.origin+'/api/v1'+s.root+'/products',{method:'POST',headers:{Origin:h.origin,Cookie:s.owner.cookie,'X-CSRF-Token':s.owner.csrf,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:'{'});
  assert.equal(malformed.status,400); assert.equal((await malformed.json() as any).code,'invalid_json');
});

test('Flag off leaves every hosted public, member and tenant path equivalent to an unknown path', async () => {
  const s=await ready(); await add(s); expect(await publish(s));
  for(const c of commands(s)) {
    const r=await execute(c,s.owner,closed),unknown=await call(c[0],'/unknown-hosted-path',s.owner,c[2],{},closed);
    assert.equal(r.status,unknown.status); assert.deepEqual(r.data,unknown.data);
  }
  for(const path of ['/api/v1/public/stores/myshop','/api/v1/me/stores','/shops/myshop']) {
    const prefix=path.startsWith('/api/')?'/api/v1/unknown-hosted-path':'/unknown-hosted-path';
    const r=await closed.request(h.origin+path),unknown=await closed.request(h.origin+prefix); assert.equal(r.status,unknown.status); assert.equal(await r.text(),await unknown.text());
  }
});

test('Storefront contract pin matches committed bytes, generated artifact, definition constants and database rows', async () => {
  const file='contracts/guild-launchpad/v1/storefront.schema.json';
  const current=await readFile(file);
  assert.equal(createHash('sha256').update(current).digest('hex'),STOREFRONT_CONTRACT_ARTIFACT_SHA256);
  const module=(await h.pool.query(`SELECT contract_ref FROM module_definitions WHERE release_ref='storefront@1.0.0'`)).rows[0]; assert.deepEqual(module.contract_ref,STOREFRONT_CONTRACT);
  const application=(await h.pool.query(`SELECT source_commit,artifact_digest,module_requirements FROM application_definitions WHERE release_ref='hosted-store@1.0.0'`)).rows[0];
  assert.equal(application.source_commit,STOREFRONT_CONTRACT_SOURCE_COMMIT); assert.equal(application.artifact_digest.value,STOREFRONT_CONTRACT_ARTIFACT_SHA256); assert.deepEqual(application.module_requirements[0].compatible_contracts,[STOREFRONT_CONTRACT]);
  for(const currency of ['TWD','USD']) for(const amount of [1,100,12345,100000000]) assert.equal(formatMinor(amount,currency),portalFormatMinor(amount,currency));
});
