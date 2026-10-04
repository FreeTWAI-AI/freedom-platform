import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { serve } from '@hono/node-server';
import { createPool } from '../../packages/db/index.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal } from '../../packages/testing/seed.js';

// Deliberate operator-selected candidate checkouts, separate from repositories.lock baseline.
const roots = [process.env.FREEDOM_AGENT_KIT_ROOT, process.env.FREEDOM_STOREFRONT_ROOT, process.env.FREEDOM_SUPPLIER_CLIENT_ROOT];
if (roots.some(root => !root || !isAbsolute(root))) throw new Error('Set absolute FREEDOM_AGENT_KIT_ROOT, FREEDOM_STOREFRONT_ROOT and FREEDOM_SUPPLIER_CLIENT_ROOT.');
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Explicit isolated TEST_DATABASE_URL required.');
const sourceCommit = process.env.FREEDOM_CONSUMER_SOURCE_COMMIT;
if (!/^[a-f0-9]{40}$/.test(sourceCommit ?? '')) throw new Error('Set exact FREEDOM_CONSUMER_SOURCE_COMMIT.');
const verifierPath = '../../packages/contribution-tools/consumer-libraries.mjs';
const { verifyConsumerLibraries } = await import(verifierPath);
for (const [index, name] of ['freedom-agent-kit', 'freedom-storefront', 'freedom-supplier-client'].entries()) {
  await verifyConsumerLibraries(roots[index], { repository: 'FreeTWAI-AI/' + name,
    expectedSourceCommit: index === 2 ? process.env.FREEDOM_SUPPLIER_SOURCE_COMMIT ?? sourceCommit : sourceCommit, sourceRoot: resolve('.') });
}
const importConsumer = (index: number, path: string) => import(pathToFileURL(resolve(roots[index]!, path)).href);
const kit = await importConsumer(0, 'src/index.mjs');
const { PlatformClient } = await importConsumer(0, 'packages/client/index.mjs');
const storefront = await importConsumer(1, 'src/index.mjs');
const supplierClient = await importConsumer(2, 'src/index.mjs');
const { startPairing, pollPairing } = await importConsumer(1, 'vendor/freedom-libraries/packages/client-connections/read-client.mjs');
const schema = `fp_consumer_libraries_${process.pid}_${Date.now()}`;
const admin = createPool(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 8 });
let server: ReturnType<typeof serve> | undefined, origin: string, app: ReturnType<typeof createApp>, created = false;

before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`); created = true;
  await migrate(pool); await seedLocal(pool);
  server = serve({ fetch: request => app.fetch(request), hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`; app = createApp(pool, origin);
});
after(async () => {
  if (server) await new Promise<void>((done, reject) => server!.close(error => error ? reject(error) : done()));
  await pool.end(); if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
});
const intent = () => ({ idempotencyKey: randomUUID() });
const login = () => PlatformClient.loginDemo({ baseUrl: origin + '/api/v1', email: 'maker@local.test', password: 'freedom-local-demo' });

test('updated kit executes the central shared member workspace through its own pinned preview SDK', async () => {
  const client = await login();
  const workspace = await kit.loadMemberWorkspace(client);
  assert.equal(workspace.member.email, 'maker@local.test');
  assert.equal(workspace.guilds.length, 18); assert(Array.isArray(workspace.work));
  assert.equal(workspace.agent_execution_grant, false);
  assert.equal(Object.hasOwn(workspace, 'csrf_token'), false);
  await client.call('logout', { body: {} });
  await assert.rejects(kit.loadMemberWorkspace(client), { status: 401 });
});

test('updated storefront and supplier pair through HTTP, read scoped SQL rows and reject wrong-scope/revoked access', async () => {
  const member = await login(), session = await member.call('getSession');
  // Synthetic fixture readiness; not a claim of human onboarding acceptance.
  await pool.query('UPDATE users SET onboarding_completed_at=now() WHERE user_id=$1', [session.user.user_id]);
  const store = await member.call('createStore', { ...intent(), body: { name: 'Consumer fixture', description: 'Private integration fixture', support_contact: 'No external contact' } });
  await member.call('createStore', { ...intent(), body: { name: 'Other fixture', description: 'Must stay outside this connection', support_contact: 'No external contact' } });
  const product = await member.call('createSupplierProduct', { ...intent(), body: {
    title: 'Fixture tea', specifications: 'Synthetic 100g', net_price_minor: 12000, currency: 'TWD', availability: 'manual_confirmation', stock: null,
    shipping_terms: 'Synthetic only', return_terms: 'Synthetic only',
  } });
  const listing = await member.call('createListing', { ...intent(), body: { store_id: store.store_id,
    offer_version_id: product.current_offer.offer_version_id, retail_price_minor: 16000, sale_terms: 'Synthetic only' } });
  await member.call('requestSupply', { ...intent(), params: { id: listing.listing_id }, version: listing.aggregate_version,
    body: { snapshot_sha256: listing.snapshot_sha256 } });
  const otherMember = await PlatformClient.loginDemo({ baseUrl: origin + '/api/v1', email: 'client@local.test', password: 'freedom-local-demo' });
  await otherMember.call('createSupplierProduct', { ...intent(), body: {
    title: 'Other supplier fixture', specifications: 'Must not appear in supplier workspace', net_price_minor: 14000,
    currency: 'TWD', availability: 'manual_confirmation', stock: null, shipping_terms: 'Synthetic only', return_terms: 'Synthetic only',
  } });
  await otherMember.call('logout', { body: {} });
  // Browser authority is used only for approval/revoke, never handed to the read adapter.
  const response = await fetch(origin + '/api/v1/auth/login', { method: 'POST', redirect: 'error',
    headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'maker@local.test', password: 'freedom-local-demo' }) });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie')!.split(';')[0], browser = await response.json() as any;
  async function command(path: string, body: unknown, version?: number) {
    const response = await fetch(origin + '/api/v1' + path, { method: 'POST', redirect: 'error',
      headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': browser.csrf_token, 'Content-Type': 'application/json',
        'Idempotency-Key': randomUUID(), ...(version ? { 'If-Match': `"${version}"` } : {}) }, body: JSON.stringify(body) });
    assert.equal(response.status, 200); return response.json();
  }
  const seen: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers); assert.equal(headers.has('Cookie'), false); assert.equal(headers.has('X-CSRF-Token'), false);
    assert.equal(init?.redirect, 'error'); seen.push(new URL(String(input)).pathname); return fetch(input, init);
  };
  async function connect(kind: string) {
    const pair = await startPairing({ origin, kind, clientName: 'Consumer integration fixture', fetcher });
    await command('/client-connections/' + pair.user_code + '/approve', { confirmed: true, ...(kind === 'storefront' ? { store_id: store.store_id } : {}) });
    const issued = await pollPairing({ origin, deviceSecret: pair.device_secret, fetcher });
    assert.equal(issued.status, 'authorized'); return issued;
  }
  const connected = await connect('storefront');
  const workspace = await storefront.loadConnectedStorefront({ origin, token: connected.access_token, fetcher });
  assert.deepEqual(workspace.stores.map((row: any) => row.store_id), [store.store_id]);
  assert.deepEqual(workspace.listings.map((row: any) => row.listing_id), [listing.listing_id]);
  assert(workspace.catalog.some((row: any) => row.product_id === product.product_id));
  assert.equal(workspace.capabilities.checkout, false); assert.equal(workspace.capabilities.public_publication, false);
  assert(!JSON.stringify(workspace).includes(connected.access_token));
  const supplier = await connect('supplier'), start = seen.length;
  await assert.rejects(storefront.loadConnectedStorefront({ origin, token: supplier.access_token, fetcher }), /storefront:read/);
  assert.deepEqual(seen.slice(start), ['/client-api/v1/connection']);
  const readClient = new supplierClient.ScopedReadClient({ origin, token: supplier.access_token, fetcher });
  const supplierWorkspace = await supplierClient.loadSupplierWorkspace(readClient);
  assert.deepEqual(supplierWorkspace.products.map((row: any) => row.product_id), [product.product_id]);
  assert.deepEqual(supplierWorkspace.requests.map((row: any) => row.listing_id), [listing.listing_id]);
  assert.equal(supplierWorkspace.read_only, true);
  assert(!JSON.stringify(supplierWorkspace).includes(supplier.access_token));
  const wrongScopeStart = seen.length;
  await assert.rejects(supplierClient.loadSupplierWorkspace(new supplierClient.ScopedReadClient({ origin, token: connected.access_token, fetcher })), /supplier read connection/);
  assert.deepEqual(seen.slice(wrongScopeStart), ['/client-api/v1/connection']);
  await command('/me/client-connections/' + connected.connection_id + '/revoke', {}, 1);
  const revokedStart = seen.length;
  await assert.rejects(storefront.loadConnectedStorefront({ origin, token: connected.access_token, fetcher }), { status: 401 });
  assert.deepEqual(seen.slice(revokedStart), ['/client-api/v1/connection']);
  await command('/me/client-connections/' + supplier.connection_id + '/revoke', {}, 1);
  const supplierRevokedStart = seen.length;
  await assert.rejects(supplierClient.loadSupplierWorkspace(readClient), { status: 401 });
  assert.deepEqual(seen.slice(supplierRevokedStart), ['/client-api/v1/connection']);
  await member.call('logout', { body: {} });
});
