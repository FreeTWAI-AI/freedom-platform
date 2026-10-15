import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { authenticate } from '../../modules/identity-membership/service.js';
import { storeCapabilities } from '../../modules/agent-commerce/hosted/capabilities.js';
import { capacitySummary, retainedByteUsage } from '../../modules/opportunity-project-work/tenant-capacity.js';
import { withTenantRead } from '../../packages/resource-scopes/index.js';
import { DEMO_COMMUNITY } from '../../packages/testing/seed.js';
import type { Session } from './module-registry-harness.js';
import { createHostedStorePhotoHarness, photoSourcePng, type HostedStorePhotoHarness } from '../helpers/hosted-store-photo.js';

const supplierGuild = 'guild_product_quality_supply';
const supplyProductInput = { title: '供貨茶杯', description: '經授權的商品介紹', cost_minor: 400, stock: 10 };
const supplyTermsInput = { cost_minor: 400, shipping_minor: 50, shipping_terms: '確認後三天出貨', return_terms: '瑕疵請聯絡供貨方' };

let f: HostedStorePhotoHarness;
let consoleApp: ReturnType<HostedStorePhotoHarness['application']>;

before(async () => {
  f = await createHostedStorePhotoHarness();
  consoleApp = f.application(true, { supplierConsoleEnabled: true });
});
after(async () => { await f?.stop(); });
beforeEach(async () => {
  await f.reset();
  await f.h.pool.query(`INSERT INTO guild_application_offerings(offering_id,community_id,guild_key,application_key,release_ref,status,display_order,launch_policy_ref,version)
    VALUES($1,$2,$3,'hosted-store','hosted-store@1.0.0','offered',10,'{"policy_key":"hosted-store.launch","version":"1"}',1)`,
  [randomUUID(), DEMO_COMMUNITY, supplierGuild]);
  await enable();
});

async function enable() {
  await f.h.pool.query("UPDATE domain_media_storage_policy SET mode='r2_only',persistence_allowed=true,policy_revision='synthetic-sc-photo-1',retained_byte_limit=16777216 WHERE purpose='storefront.product-photo'");
}

interface CatalogTarget {
  owner: Session;
  actor: Awaited<ReturnType<typeof authenticate>>;
  tenantId: string;
  workspaceId: string;
  instanceId: string;
  root: string;
  productId: string;
  version: string;
}

async function openSupplyCatalog(name = '合成供貨目錄'): Promise<CatalogTarget> {
  const owner = (await f.h.person(name)).session;
  await f.h.fullMember(owner.user.user_id, supplierGuild);
  const { tenantId, workspaceId } = await f.h.createTenant(owner, name);
  const planned = await f.h.plan(owner, tenantId, f.h.planBody(supplierGuild, workspaceId, 'hosted-store', 'hosted-store@1.0.0'));
  f.ok(planned, 201);
  const launched = await f.h.launch(owner, tenantId, planned);
  assert.ok([200, 202].includes(launched.status), JSON.stringify(launched.data));
  assert.equal(launched.data.state, 'succeeded');
  const instanceId = (await f.h.pool.query("SELECT instance_id FROM module_instances WHERE tenant_id=$1 AND module_key='storefront'", [tenantId])).rows[0].instance_id as string;
  const root = `/tenants/${tenantId}/storefronts/${instanceId}`;
  f.ok(await f.post(root + '/supply-profile', owner, { name, description: '只提供供貨資料', currency: 'TWD' }), 201);
  const created = f.ok(await f.post(root + '/supply-products', owner, supplyProductInput), 201);
  const actor = await authenticate(f.runtime, owner.cookie.split('=')[1]);
  return { owner, actor, tenantId, workspaceId, instanceId, root, productId: created.product_id as string, version: created.version as string };
}

async function upload(target: { root: string; productId: string; owner: Session }, version: string, app = consoleApp, key = randomUUID(), bytes = photoSourcePng) {
  const response = await app.request(f.h.origin + '/api/v1' + target.root + '/products/' + target.productId + '/photo', {
    method: 'POST',
    headers: {
      Origin: f.h.origin,
      Cookie: target.owner.cookie,
      'X-CSRF-Token': target.owner.csrf,
      'Content-Type': 'image/png',
      'Idempotency-Key': key,
      'If-Match': `"${version}"`,
    },
    body: new Uint8Array(bytes),
  });
  return { status: response.status, data: await response.json() as any, response };
}

async function removePhoto(target: { root: string; productId: string }, session: Session, version: string, app = consoleApp, key = randomUUID()) {
  return f.h.call('POST', `${target.root}/products/${target.productId}/photo/remove`, session, {}, {
    'Idempotency-Key': key,
    'If-Match': `"${version}"`,
  }, app);
}

async function listMedia(target: { root: string }, session: Session, app = consoleApp) {
  return f.h.call('GET', `${target.root}/product-media`, session, undefined, {}, app);
}

async function invite(target: { owner: Session; tenantId: string; instanceId: string }, name: string, capabilities: string[]) {
  const person = (await f.h.person(name)).session;
  const principal = await f.h.candidate(target.owner, person.user.user_id);
  const invitation = await f.h.post(`/tenants/${target.tenantId}/invitations`, target.owner, {
    invitee_principal_id: principal,
    role: 'operator',
    instance_capabilities: [{ instance_id: target.instanceId, capabilities }],
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  });
  f.ok(invitation, 201);
  await f.h.accept(person, target.tenantId, invitation);
  return { person, principal };
}

async function usage(target: { actor: Awaited<ReturnType<typeof authenticate>>; tenantId: string }) {
  return withTenantRead(f.runtime, { actor: target.actor, tenantId: target.tenantId, capabilitiesForRole: storeCapabilities }, async (q, context) => ({
    total: await retainedByteUsage(q, context.scope.scope_id, context.tenant_id),
    summary: await capacitySummary(q, context.scope.scope_id, context.tenant_id),
  }));
}

test('SC-PHOTO-01 flag OFF keeps supply-only products absent from media list and rejects upload, remove and private read without writes', async () => {
  const s = await openSupplyCatalog();
  const initialPuts = f.store.puts;
  const list = f.ok(await listMedia(s, s.owner, f.app));
  assert.deepEqual(list.items, []);

  const up = await upload(s, s.version, f.app);
  assert.equal(up.status, 404);
  assert.equal(up.data.code, 'not_found');

  const rem = await removePhoto(s, s.owner, s.version, f.app);
  assert.equal(rem.status, 404);
  assert.equal(rem.data.code, 'not_found');

  const privPath = `/api/v1${s.root}/products/${s.productId}/photo/1`;
  for (const method of ['GET', 'HEAD'] as const) {
    const res = await f.app.request(f.h.origin + privPath, { method, headers: { Cookie: s.owner.cookie } });
    assert.equal(res.status, 404);
  }

  assert.equal(f.store.puts, initialPuts);
  assert.equal((await f.h.pool.query("SELECT count(*)::int n FROM assets WHERE purpose='storefront.product-photo'")).rows[0].n, 0);
  assert.equal((await f.h.pool.query("SELECT count(*)::int n FROM asset_upload_intents WHERE purpose='storefront.product-photo'")).rows[0].n, 0);
  assert.equal((await f.h.pool.query('SELECT count(*)::int n FROM commerce_product_photo_targets WHERE product_id=$1', [s.productId])).rows[0].n, 0);
  const ver = (await f.h.pool.query('SELECT aggregate_version::text v FROM commerce_selections WHERE item_id=$1', [s.productId])).rows[0].v;
  assert.equal(ver, '1');
});

test('SC-PHOTO-02 flag ON supports private list, upload, byte read, idempotent replay, stale If-Match 412 and remove on supply-only products', async () => {
  const s = await openSupplyCatalog();
  const before = f.ok(await listMedia(s, s.owner, consoleApp));
  assert.equal(before.items.length, 1);
  assert.equal(before.items[0].product_id, s.productId);
  assert.equal(before.items[0].version, '1');
  assert.equal(before.items[0].photo, null);

  const key = randomUUID();
  const uploaded = f.ok(await upload(s, '1', consoleApp, key));
  assert.equal(uploaded.product_id, s.productId);
  assert.equal(uploaded.completed_version, '2');
  assert.equal(uploaded.changed, true);
  assert.equal(uploaded.current.version, '2');
  assert.ok(uploaded.current.photo);

  const readPath = uploaded.current.photo.read_path as string;
  const readRes = await consoleApp.request(f.h.origin + readPath, { headers: { Cookie: s.owner.cookie } });
  assert.equal(readRes.status, 200);
  assert.equal(readRes.headers.get('content-type'), 'image/webp');
  assert.equal(readRes.headers.get('cache-control'), 'private, no-store');
  const readBytes = Buffer.from(await readRes.arrayBuffer());
  assert.equal(readBytes.length, uploaded.current.photo.byte_size);

  const headRes = await consoleApp.request(f.h.origin + readPath, { method: 'HEAD', headers: { Cookie: s.owner.cookie } });
  assert.equal(headRes.status, 200);
  assert.equal(headRes.headers.get('content-length'), String(readBytes.length));

  const afterUploadList = f.ok(await listMedia(s, s.owner, consoleApp));
  assert.deepEqual(afterUploadList.items, [uploaded.current]);

  const putsAfterFirst = f.store.puts;
  const replayed = f.ok(await upload(s, '1', consoleApp, key));
  assert.deepEqual(replayed, uploaded);
  assert.equal(f.store.puts, putsAfterFirst);
  assert.equal((await f.h.pool.query("SELECT count(*)::int n FROM assets WHERE purpose='storefront.product-photo'")).rows[0].n, 1);

  const stale = await upload(s, '1', consoleApp, randomUUID());
  assert.equal(stale.status, 412);
  assert.equal(stale.data.code, 'version_conflict');

  const staleRemove = await removePhoto(s, s.owner, '1', consoleApp);
  assert.equal(staleRemove.status, 412);
  assert.equal(staleRemove.data.code, 'version_conflict');

  const removed = f.ok(await removePhoto(s, s.owner, '2', consoleApp));
  assert.equal(removed.completed_version, '3');
  assert.equal(removed.changed, true);
  assert.equal(removed.current.version, '3');
  assert.equal(removed.current.photo, null);

  const afterRemoveList = f.ok(await listMedia(s, s.owner, consoleApp));
  assert.equal(afterRemoveList.items.length, 1);
  assert.equal(afterRemoveList.items[0].version, '3');
  assert.equal(afterRemoveList.items[0].photo, null);
  assert.equal((await consoleApp.request(f.h.origin + readPath, { headers: { Cookie: s.owner.cookie } })).status, 404);
});

test('SC-PHOTO-03 viewer can list and read metadata-only items without price or text but cannot upload; foreign tenant is isolated (AT-04, AT-37)', async () => {
  const s = await openSupplyCatalog('供應商 A');
  const other = await openSupplyCatalog('供應商 B');
  const viewer = await invite(s, '供貨照片唯讀成員', ['store:read']);

  const uploaded = f.ok(await upload(s, '1', consoleApp));
  const readPath = uploaded.current.photo.read_path as string;

  const viewerList = f.ok(await listMedia(s, viewer.person, consoleApp));
  assert.equal(viewerList.items.length, 1);
  const item = viewerList.items[0];
  assert.deepEqual(Object.keys(item).sort(), ['photo', 'product_id', 'profile', 'version']);
  for (const forbidden of ['price_minor', 'cost_minor', 'supply_price_minor', 'title', 'description', 'sku']) {
    assert.equal(forbidden in item, false, `private media item must not include ${forbidden}`);
  }

  const viewerRead = await consoleApp.request(f.h.origin + readPath, { headers: { Cookie: viewer.person.cookie } });
  assert.equal(viewerRead.status, 200);

  const viewerUpload = await upload({ ...s, owner: viewer.person }, '2', consoleApp);
  assert.equal(viewerUpload.status, 403);
  const viewerRemove = await removePhoto(s, viewer.person, '2', consoleApp);
  assert.equal(viewerRemove.status, 403);

  const otherList = await listMedia(s, other.owner, consoleApp);
  assert.equal(otherList.status, 404);
  assert.equal('items' in (otherList.data ?? {}), false);

  const otherRead = await consoleApp.request(f.h.origin + readPath, { headers: { Cookie: other.owner.cookie } });
  assert.equal(otherRead.status, 404);

  const otherUpload = await upload({ ...s, owner: other.owner }, '2', consoleApp);
  assert.equal(otherUpload.status, 404);
  const otherRemove = await removePhoto(s, other.owner, '2', consoleApp);
  assert.equal(otherRemove.status, 404);
});

test('SC-PHOTO-04 retail publication and seller distribution never expose supply-only products or their photos (AT-11)', async () => {
  const s = await f.openStore();
  const supplyCreated = f.ok(await f.h.call('POST', s.root + '/supply-products', s.owner, supplyProductInput, { 'Idempotency-Key': randomUUID() }, consoleApp), 201);
  const supplyId = supplyCreated.product_id as string;

  const retailUp = f.ok(await upload(s, s.version, consoleApp));
  const supplyUp = f.ok(await upload({ ...s, productId: supplyId }, supplyCreated.version, consoleApp));

  const privateItems = f.ok(await listMedia(s, s.owner, consoleApp)).items;
  assert.equal(privateItems.length, 2);

  const preview = f.ok(await f.h.call('GET', s.root + '/preview', s.owner, undefined, {}, consoleApp));
  assert.deepEqual(preview.projection.products.map((p: { title: string }) => p.title), ['合成商品']);

  const previewPageRes = await consoleApp.request(f.h.origin + '/api/v1' + s.root + '/preview-page', { headers: { Cookie: s.owner.cookie } });
  assert.equal(previewPageRes.status, 200);
  const previewHtml = await previewPageRes.text();
  assert.equal(previewHtml.includes(supplyProductInput.title), false);
  assert.equal(previewHtml.includes(supplyUp.current.photo.read_path), false);
  assert.equal(previewHtml.includes(retailUp.current.photo.read_path), true);

  const storeView = f.ok(await f.h.call('GET', s.root, s.owner, undefined, {}, consoleApp));
  f.ok(await f.h.call('POST', s.root + '/publish', s.owner, {}, { 'Idempotency-Key': randomUUID(), 'If-Match': `"${storeView.version}"` }, consoleApp));

  const pubMediaRes = await consoleApp.request(f.h.origin + '/api/v1/public/stores/' + s.slug + '/media');
  assert.equal(pubMediaRes.status, 200);
  const pubMedia = await pubMediaRes.json() as { photos: { sku: string; photo: { read_path: string } }[] };
  assert.equal(pubMedia.photos.length, 1);
  assert.equal(pubMedia.photos[0].sku, 'P0001');

  const pubRefs = (await f.h.pool.query('SELECT sku,asset_id FROM commerce_publication_photo_refs WHERE instance_id=$1', [s.instanceId])).rows;
  assert.equal(pubRefs.length, 1);
  assert.equal(pubRefs[0].sku, 'P0001');

  const shopHtml = await (await consoleApp.request(f.h.origin + '/shops/' + s.slug)).text();
  assert.equal(shopHtml.includes(supplyProductInput.title), false);
  assert.equal(shopHtml.includes(supplyId), false);

  // Also verify a partner seller publishing an accepted offer of the supply-only product never receives the supplier's photo.
  const termsSaved = f.ok(await f.h.call('PATCH', `${s.root}/products/${supplyId}/supply-terms`, s.owner, supplyTermsInput, {
    'Idempotency-Key': randomUUID(),
    'If-Match': `"${supplyUp.current.version}"`,
  }, consoleApp));
  const offered = f.ok(await f.h.call('POST', `${s.root}/products/${supplyId}/supply-offer`, s.owner, {}, {
    'Idempotency-Key': randomUUID(),
    'If-Match': `"${termsSaved.version}"`,
  }, consoleApp));

  const seller = await f.openStore();
  const proposal = f.ok(await f.h.call('POST', `${seller.root}/distribution-selections`, seller.owner, {
    offer_id: offered.offer_id,
    terms_sha256: offered.terms_sha256,
    retail_price_minor: 1200,
  }, { 'Idempotency-Key': randomUUID() }, consoleApp), 201);
  f.ok(await f.h.call('POST', `${s.root}/supply-requests/${proposal.selection_id}/decision`, s.owner, {
    decision: 'accepted',
    listing_sha256: proposal.listing_sha256,
  }, { 'Idempotency-Key': randomUUID(), 'If-Match': `"${proposal.version}"` }, consoleApp));

  const sellerView = f.ok(await f.h.call('GET', seller.root, seller.owner, undefined, {}, consoleApp));
  f.ok(await f.h.call('POST', seller.root + '/publish', seller.owner, {}, { 'Idempotency-Key': randomUUID(), 'If-Match': `"${sellerView.version}"` }, consoleApp));

  const sellerPubMedia = await (await consoleApp.request(f.h.origin + '/api/v1/public/stores/' + seller.slug + '/media')).json() as { photos: unknown[] };
  assert.deepEqual(sellerPubMedia.photos, []);
  const sellerRefs = (await f.h.pool.query('SELECT * FROM commerce_publication_photo_refs WHERE instance_id=$1', [seller.instanceId])).rows;
  assert.deepEqual(sellerRefs, []);
});

test('SC-PHOTO-05 supply-only product photo counts in retainedByteUsage identically to a retail product photo', async () => {
  const supply = await openSupplyCatalog('容量供貨目錄');
  const retail = await f.openStore();

  assert.equal((await usage(supply)).total, 0n);
  assert.equal((await usage(retail)).total, 0n);

  const supplyUp = f.ok(await upload(supply, supply.version, consoleApp));
  const retailUp = f.ok(await upload(retail, retail.version, consoleApp));

  const supplyUsage = await usage(supply);
  const retailUsage = await usage(retail);
  const expectedBytes = BigInt(supplyUp.current.photo.byte_size);

  assert.ok(expectedBytes > 0n);
  assert.equal(supplyUsage.total, expectedBytes);
  assert.equal(supplyUsage.total, retailUsage.total);
  assert.equal(supplyUsage.summary.used, String(expectedBytes));
  assert.equal(supplyUsage.summary.reserved, '0');
  assert.equal(retailUp.current.photo.byte_size, supplyUp.current.photo.byte_size);
});

test('SC-PHOTO-06 toggling console flag OFF hides supply-only photos while retaining stored rows and leaving retail photos intact (AT-44)', async () => {
  const s = await f.openStore();
  const supplyCreated = f.ok(await f.h.call('POST', s.root + '/supply-products', s.owner, supplyProductInput, { 'Idempotency-Key': randomUUID() }, consoleApp), 201);
  const supplyId = supplyCreated.product_id as string;

  const retailUp = f.ok(await upload(s, s.version, consoleApp));
  const supplyKey = randomUUID();
  const supplyUp = f.ok(await upload({ ...s, productId: supplyId }, supplyCreated.version, consoleApp, supplyKey));
  const supplyReadPath = supplyUp.current.photo.read_path as string;
  const retailReadPath = retailUp.current.photo.read_path as string;

  const beforeTarget = (await f.h.pool.query('SELECT * FROM commerce_product_photo_targets WHERE product_id=$1', [supplyId])).rows[0];
  const beforeAssets = (await f.h.pool.query("SELECT count(*)::int n FROM assets WHERE tenant_ref=$1 AND purpose='storefront.product-photo'", [s.tenantId])).rows[0].n;
  const beforeVersion = (await f.h.pool.query('SELECT aggregate_version::text v FROM commerce_selections WHERE item_id=$1', [supplyId])).rows[0].v;
  assert.equal(beforeAssets, 2);
  assert.equal(beforeVersion, '2');

  // Flag OFF app: supply-only product photo is hidden from private list, private read, replay, upload and remove.
  const offList = f.ok(await listMedia(s, s.owner, f.app));
  assert.deepEqual(offList.items.map((item: { product_id: string }) => item.product_id), [s.productId]);
  assert.equal((await f.app.request(f.h.origin + supplyReadPath, { headers: { Cookie: s.owner.cookie } })).status, 404);
  assert.equal((await upload({ ...s, productId: supplyId }, '1', f.app, supplyKey)).status, 404);
  assert.equal((await upload({ ...s, productId: supplyId }, '2', f.app)).status, 404);
  assert.equal((await removePhoto({ ...s, productId: supplyId }, s.owner, '2', f.app)).status, 404);

  // Retail product photo is unaffected under Flag OFF.
  assert.equal((await f.app.request(f.h.origin + retailReadPath, { headers: { Cookie: s.owner.cookie } })).status, 200);

  // Stored rows for the supply-only photo remain intact and readable when the flag is ON again.
  const afterTarget = (await f.h.pool.query('SELECT * FROM commerce_product_photo_targets WHERE product_id=$1', [supplyId])).rows[0];
  const afterAssets = (await f.h.pool.query("SELECT count(*)::int n FROM assets WHERE tenant_ref=$1 AND purpose='storefront.product-photo'", [s.tenantId])).rows[0].n;
  const afterVersion = (await f.h.pool.query('SELECT aggregate_version::text v FROM commerce_selections WHERE item_id=$1', [supplyId])).rows[0].v;
  assert.deepEqual(afterTarget, beforeTarget);
  assert.equal(afterAssets, beforeAssets);
  assert.equal(afterVersion, beforeVersion);
  assert.equal((await consoleApp.request(f.h.origin + supplyReadPath, { headers: { Cookie: s.owner.cookie } })).status, 200);
});
