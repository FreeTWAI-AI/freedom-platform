import { test, before, beforeEach, after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { serve } from '@hono/node-server';
import { createPool, LOCAL_DATABASE_URL, digest } from '../../packages/db/index.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal } from '../../packages/testing/seed.js';
import metadata from '../../contracts/preview/v1/metadata.json' with { type: 'json' };

// This suite must never silently pass when the independently checked-out consumers are absent.
const repositoriesRoot = process.env.FREEDOM_REPOSITORIES_ROOT;
if (!repositoriesRoot || !isAbsolute(repositoriesRoot)) {
  throw new Error('FREEDOM_REPOSITORIES_ROOT must be an absolute directory containing the checked-out consumer repositories.');
}
const importRepo = (name: string, path = 'src/index.mjs') => import(pathToFileURL(resolve(repositoriesRoot, name, path)).href);
const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_repositories_${process.pid}_${Date.now()}`;
const admin = createPool(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
// The clients always use real HTTP. Only the Platform's outbound GitHub reads are replaced below.
const nativeFetch = globalThis.fetch.bind(globalThis);
const key = () => ({ idempotencyKey: randomUUID() });
let app: ReturnType<typeof createApp>, server: ReturnType<typeof serve> | undefined;
let origin: string, baseUrl: string, schemaCreated = false;
let storefront: any, growth: any, registry: any, page: any;
let StorefrontClient: any, GrowthClient: any, RegistryClient: any;

before(async () => {
  [storefront, growth, registry, page] = await Promise.all([
    importRepo('freedom-storefront'), importRepo('freedom-growth-automation'),
    importRepo('freedom-skill-registry'), importRepo('freedom-project-page'),
  ]);
  const clients = await Promise.all(['freedom-storefront', 'freedom-growth-automation', 'freedom-skill-registry']
    .map(name => importRepo(name, 'vendor/freedom-platform/client.mjs')));
  [StorefrontClient, GrowthClient, RegistryClient] = clients.map(module => module.PlatformClient);
  assert.notEqual(StorefrontClient, GrowthClient, 'Load each repository copy, not a shared core import.');
  assert.notEqual(GrowthClient, RegistryClient, 'Load each repository copy, not a shared core import.');
  await admin.query(`CREATE SCHEMA ${schema}`);
  schemaCreated = true;
  await migrate(pool);
  server = serve({ fetch: request => app.fetch(request), hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  baseUrl = `${origin}/api/v1`;
  app = createApp(pool, origin);
});

beforeEach(async () => {
  await pool.query('TRUNCATE communities,login_attempts CASCADE');
  await seedLocal(pool);
});

after(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  await pool.end();
  if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

async function login(Client: any, email = 'maker@local.test') {
  return Client.loginDemo({ baseUrl, email, password: 'freedom-local-demo', fetcher: nativeFetch });
}

const supplyTerms = {
  net_price_minor: 30000, currency: 'TWD', availability: 'manual_confirmation', stock: null,
  shipping_terms: '由當事人確認出貨；整合測試資料。', return_terms: '整合測試退換貨說明。',
};
async function createProduct(client: any) {
  return client.call('createSupplierProduct', {
    ...key(), body: { title: '跨倉測試茶葉', specifications: '150g；虛構商品', ...supplyTerms },
  });
}

function mockGitHub(t: TestContext) {
  const state = { sha: 'a'.repeat(40), archived: false };
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.hostname, 'api.github.com', 'No other outbound provider network is allowed in this suite.');
    assert.equal(options.redirect, 'error');
    assert.equal(new Headers(options.headers).get('Authorization'), null);
    requests.push(url.href);
    if (url.href === 'https://api.github.com/repos/example/integration-project') return Response.json({
      id: 550011, full_name: 'example/integration-project', private: false, visibility: 'public',
      default_branch: 'main', fork: true, archived: state.archived,
    });
    if (url.href === 'https://api.github.com/repos/example/integration-project/commits/main') return Response.json({ sha: state.sha });
    if (url.href === `https://api.github.com/repos/example/integration-project/license?ref=${state.sha}`) return Response.json({ path: 'LICENSE', license: { spdx_id: 'MIT' } });
    throw new Error(`Unexpected GitHub fixture request: ${url.href}`);
  });
  return { state, requests };
}

test('each checked-out consumer negotiates its own vendored protocol with the running HTTP API', async () => {
  for (const Client of [StorefrontClient, GrowthClient, RegistryClient]) {
    const client = await login(Client);
    assert.equal((await client.assertCompatible()).protocol_sha256, metadata.protocol_sha256);
    assert.equal((await client.call('getSession')).user.email, 'maker@local.test');
    await client.call('logout', { body: {} });
    await assert.rejects(client.call('getSession'), { status: 401 });
  }
});

test('storefront commands traverse HTTP and persist one exact accepted supplier/listing snapshot', async () => {
  const supplier = await login(StorefrontClient);
  const seller = await login(StorefrontClient, 'client@local.test');
  const stranger = await login(StorefrontClient, 'reviewer@local.test');
  const product = await createProduct(supplier);
  const store = await storefront.createStore(seller, {
    name: '跨倉整合商店', description: '只供內部預覽', support_contact: '平台內聯絡',
  }, key());
  const selection = {
    store_id: store.store_id, offer_version_id: product.current_offer.offer_version_id,
    retail_price_minor: 55000, sale_terms: '固定供貨版本與售價，沒有結帳。',
  };
  const intent = key();
  const listing = await storefront.selectProduct(seller, selection, intent);
  assert.equal((await storefront.selectProduct(seller, selection, intent)).listing_id, listing.listing_id);
  await assert.rejects(storefront.selectProduct(seller, { ...selection, retail_price_minor: 56000 }, intent), { status: 409, code: 'idempotency_conflict' });
  await assert.rejects(storefront.selectProduct(stranger, selection, key()), { status: 404 });
  await assert.rejects(storefront.loadStorefront(stranger, { storeId: store.store_id }), /unavailable/);
  await assert.rejects(storefront.requestSupply(seller, { ...listing, aggregate_version: listing.aggregate_version + 1 }, key()), { status: 412 });
  await assert.rejects(storefront.requestSupply(seller, { ...listing, snapshot_sha256: 'f'.repeat(64) }, key()), { status: 409, code: 'snapshot_changed' });

  const requestIntent = key();
  const requested = await storefront.requestSupply(seller, listing, requestIntent);
  assert.equal((await storefront.requestSupply(seller, listing, requestIntent)).acceptance_id, requested.acceptance_id);
  const request = (await supplier.call('listSupplyRequests')).items[0];
  const decision = { decision: 'accepted', note: '跨倉測試內部確認', snapshot_sha256: request.snapshot_sha256, acknowledge_internal_preview: true };
  await assert.rejects(seller.call('decideSupplyRequest', {
    ...key(), params: { id: request.acceptance_id }, body: decision, version: request.aggregate_version,
  }), { status: 404 });
  await supplier.call('decideSupplyRequest', {
    ...key(), params: { id: request.acceptance_id }, body: decision, version: request.aggregate_version,
  });
  await supplier.call('createSupplierOffer', {
    ...key(), params: { id: product.product_id }, version: product.aggregate_version,
    body: { ...supplyTerms, net_price_minor: 39000 },
  });
  // A fresh application instance reads the same persisted transaction through HTTP.
  app = createApp(pool, origin);
  const view = await storefront.loadStorefront(seller, { storeId: store.store_id });
  assert.equal(view.listings.length, 1);
  const saved = view.listings[0];
  assert.equal(saved.state, 'accepted');
  assert.equal(saved.snapshot_sha256, listing.snapshot_sha256);
  assert.equal(saved.snapshot.offer_version_id, product.current_offer.offer_version_id);
  assert.equal(Number(saved.snapshot.supply.net_price_minor), 30000);
  assert.equal(Number(saved.snapshot.retail_price_minor), 55000);
  assert.equal(Number(view.catalog[0].current_offer.net_price_minor), 39000);
  assert.equal(saved.checkout_enabled, false);
  assert.equal(saved.money_movement_enabled, false);
  const html = storefront.renderPreview('catalog-store', view);
  assert.match(html, /TWD 550.00/);
  assert.match(html, /供貨已確認（內部演練）/);
  assert.doesNotMatch(html, /<(?:form|script)\b/);
  const persisted = await pool.query('SELECT state,snapshot_sha256 FROM retail_listing_revisions WHERE listing_id=$1', [listing.listing_id]);
  assert.deepEqual(persisted.rows, [{ state: 'accepted', snapshot_sha256: listing.snapshot_sha256 }]);
  assert.equal((await pool.query('SELECT count(*) FROM distribution_acceptances')).rows[0].count, '1');
});

test('growth adapter owns private drafts and preserves product evidence across later supplier changes', async () => {
  const maker = await login(GrowthClient), other = await login(GrowthClient, 'client@local.test');
  const product = await createProduct(maker);
  const body = growth.prepareCampaignDraft({
    title: '測試茶葉介紹', audience: '內部會員', goal: '閱讀商品說明', draftText: '供貨來源已固定；這是內部測試。',
    source: { kind: 'supplier_product', product_id: product.product_id },
  });
  const intent = key();
  const campaign = await growth.createCampaignDraft(maker, body, intent);
  assert.equal((await growth.createCampaignDraft(maker, body, intent)).campaign_id, campaign.campaign_id);
  await assert.rejects(growth.createCampaignDraft(other, body, key()), { status: 404 });
  await maker.call('createSupplierOffer', {
    ...key(), params: { id: product.product_id }, version: product.aggregate_version,
    body: { ...supplyTerms, net_price_minor: 42000 },
  });
  const content = { title: '已修訂介紹', audience: '內部會員', goal: '閱讀商品說明', draft_text: '第二版內部文案。' };
  const revised = await growth.reviseCampaignDraft(maker, campaign, content, key());
  assert.deepEqual(revised.source_snapshot, campaign.source_snapshot);
  assert.equal(revised.source_sha256, digest(campaign.source_snapshot));
  assert.equal(revised.source_supplier_offer_id, product.current_offer.offer_version_id);
  assert.equal(Number(revised.source_snapshot.net_price_minor), 30000);
  await assert.rejects(growth.reviseCampaignDraft(maker, campaign, content, key()), { status: 412 });
  await assert.rejects(growth.reviseCampaignDraft(other, revised, content, key()), { status: 404 });
  const shared = await growth.recordManualShare(maker, revised, {
    channel: 'internal-test', share_url: 'https://github.com/example/integration-project', note: '合成分享紀錄，不是外部發布。',
  }, key());
  assert.equal(shared.shares[0].verification_status, 'self_reported');
  assert.equal(shared.state, 'draft');
  assert.equal((await growth.loadCampaignWorkspace(other)).campaigns.length, 0);
  const workspace = await growth.loadCampaignWorkspace(maker);
  assert.equal(workspace.campaigns.length, 1);
  assert.equal(workspace.campaigns[0].source_sha256, campaign.source_sha256);
  assert.equal(Number(workspace.supplierProducts[0].current_offer.net_price_minor), 42000);
  assert.equal((await pool.query("SELECT count(*) FROM outbox WHERE event_type LIKE '%publication%' OR event_type LIKE '%payment%'")).rows[0].count, '0');
});

test('registry import joins growth and public page metadata without inheriting official status', async t => {
  const { state, requests } = mockGitHub(t);
  const member = await login(RegistryClient);
  const growthMember = await login(GrowthClient);
  const reader = await login(RegistryClient, 'reviewer@local.test');
  const manifest = {
    schema_version: 'freedom.project/v1', kind: 'Project', project_id: 'project:integration-example',
    name: '跨倉測試開源作品', summary: '合成 fixture；驗證來源、展示與行銷串接。',
    repository: {
      visibility: 'public', full_name: 'example/integration-project', html_url: 'https://github.com/example/integration-project', repository_id: '550011',
      source_lineage: [{ full_name: 'example/upstream', html_url: 'https://github.com/example/upstream', based_on_commit: 'c'.repeat(40) }],
    },
    data_boundary: { classification: 'public', customer_data_mode: 'none' },
    description: { problem: '串接作品與行銷。', audiences: ['開發者'], capabilities: ['登錄公開作品'], limitations: ['Fixture，不是正式信任證據。'] },
    page: { publication: 'github_pages', canonical_platform_url: 'https://staging.freetwai.com/', requested_trust_label: 'official' },
    ownership: { external_owner: { login: 'example' }, security_contact: 'https://github.com/example/integration-project/security' },
    licensing: { spdx_expression: 'MIT', source_distribution: 'source_available' },
    release: { policy: 'freedom.no-release/v1' }, links: { documentation: 'https://github.com/example/integration-project' },
  };
  const body = registry.projectManifestToImport(manifest, { relationship: 'curator', consentToShare: true, useNotes: '請先讀 README；整合測試資料。' });
  const intent = key();
  const project = await registry.registerProject(member, body, intent);
  assert.equal((await registry.registerProject(member, body, intent)).project_id, project.project_id);
  assert.equal(requests.length, 3, 'Idempotent replay must not fetch GitHub again.');
  assert.equal(project.repository_id, '550011');
  assert.equal(project.current_version.commit_sha, 'a'.repeat(40));
  assert.equal(project.current_version.license_spdx, 'MIT');
  assert.equal(project.relationship_verification, 'self_declared');
  assert.equal(project.official, false);
  assert.equal(project.current_version.is_fork, true);
  assert.equal((await registry.listRegisteredProjects(reader)).items[0].project_id, project.project_id);

  const campaignBody = growth.prepareCampaignDraft({
    title: '作品介紹', audience: '開發者', goal: '閱讀來源', draftText: '這是 curator 登錄的開源作品，不代表官方認證。',
    source: { kind: 'oss_project', project_id: project.project_id },
  });
  const campaign = await growth.createCampaignDraft(growthMember, campaignBody, key());
  await assert.rejects(growth.createCampaignDraft(reader, campaignBody, key()), { status: 404 });
  state.sha = 'b'.repeat(40);
  await member.call('refreshProject', { ...key(), params: { id: project.project_id }, body: {}, version: project.aggregate_version });
  const refreshed = (await registry.listRegisteredProjects(member)).items[0];
  assert.equal(refreshed.current_version.commit_sha, state.sha);
  const saved = (await growth.loadCampaignWorkspace(growthMember)).campaigns[0];
  assert.equal(saved.source_snapshot.commit_sha, 'a'.repeat(40));
  assert.equal(saved.source_sha256, campaign.source_sha256);
  assert.equal(requests.length, 6);
  assert.equal((await pool.query('SELECT count(*) FROM oss_project_versions')).rows[0].count, '2');

  const view = page.projectPublicView(manifest);
  assert.equal(view.official, false);
  const html = page.renderProjectPage(manifest, { sourceCommit: refreshed.current_version.commit_sha });
  assert.match(html, /example\/upstream/);
  assert.match(html, new RegExp('c'.repeat(40)));
  assert.match(html, /Official status is false/);
  assert.match(html, /does not inherit official status/);
  assert.doesNotMatch(html, /<script/);
  assert.throws(() => page.renderProjectPage({ ...manifest, data_boundary: { ...manifest.data_boundary, classification: 'internal' } }), /Private\/internal/);
});

test('agent-kit uses its pinned client for canonical member/work state without exposing session secrets',async()=>{
 const kit=await importRepo('freedom-agent-kit');
 const {PlatformClient}=await importRepo('freedom-agent-kit','packages/client/index.mjs');
 const client=await login(PlatformClient);
 const workspace=await kit.loadMemberWorkspace(client);
 assert.equal(workspace.member.email,'maker@local.test');assert(Array.isArray(workspace.work));assert.equal(workspace.guilds.length,15);
 assert.equal(workspace.agent_execution_grant,false);assert.equal(Object.hasOwn(workspace,'csrf_token'),false);
 assert(!JSON.stringify(workspace).includes('freedom_local_session='));
 await client.call('logout',{body:{}});
 await assert.rejects(kit.loadMemberWorkspace(client),{status:401});
});
