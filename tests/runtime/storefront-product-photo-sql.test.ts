import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { before, after, beforeEach, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createHostedStorePhotoHarness, photoSourcePng, type HostedStorePhotoHarness } from '../helpers/hosted-store-photo.js';
import { createStorefrontProductPhotoLifecycle } from '../../modules/assets/storefront-product-photo.js';
import { createTenantResultService } from '../../modules/autopilot-work/tenant-results.js';
import { retainedByteUsage, capacitySummary } from '../../modules/opportunity-project-work/tenant-capacity.js';
import { withTenantRead } from '../../packages/resource-scopes/index.js';
import { storeCapabilities } from '../../modules/agent-commerce/hosted/capabilities.js';
import { authenticate } from '../../modules/identity-membership/service.js';
import { AssetStorageError } from '../../packages/asset-storage/index.js';
import { Problem } from '../../packages/shared/problem.js';
import { OperationSchema } from '../../contracts/guild-launchpad/v1/tenant-work.js';

let f: HostedStorePhotoHarness;
before(async () => { f = await createHostedStorePhotoHarness(); });
after(async () => { await f?.stop(); });
beforeEach(async () => { await f.reset(); });
type Store = Awaited<ReturnType<HostedStorePhotoHarness['openStore']>>;
type PhotoApi = Awaited<ReturnType<HostedStorePhotoHarness['assets']['forProduct']>>;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const bytes = () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from(photoSourcePng)); c.close(); } });
const actor = (s: Store) => ({ ...s.actor, tenant_id: s.tenantId, instance_id: s.instanceId });
const sqlCode = (code: string) => (error: unknown) => (error as { code?: string }).code === code;
const problem = (status: number, code?: string) => (error: unknown) => error instanceof Problem && error.status === status && (!code || error.code === code);
async function enable() {
  await f.h.pool.query("UPDATE domain_media_storage_policy SET mode='r2_only',persistence_allowed=true,policy_revision='synthetic-photo-sql-1',retained_byte_limit=16777216 WHERE purpose='storefront.product-photo'");
}
async function begin(s: Store, version = '1', api?: PhotoApi, key = randomUUID()) {
  api ??= await f.assets.forProduct({ mime: 'image/png', bytes: photoSourcePng });
  const input = { key, targetProductId: s.productId, expectedVersion: version, contentType: 'image/png' as const,
    byteSize: photoSourcePng.length, sha256: hash(photoSourcePng) };
  const prepared = await api.prepare(actor(s), input);
  const lease = await api.claim(actor(s), { key: randomUUID(), intentId: prepared.intentId });
  return { api, input, prepared, binding: { intentId: prepared.intentId, fence: lease.fence, leaseToken: lease.leaseToken }, writeKey: randomUUID(), finalizeKey: randomUUID() };
}
async function write(s: Store, p: Awaited<ReturnType<typeof begin>>) {
  return p.api.write(actor(s), { ...p.binding, key: p.writeKey }, bytes());
}
async function finish(s: Store, version = '1') {
  const p = await begin(s, version); await write(s, p);
  const completion = await p.api.finalize(actor(s), { ...p.binding, key: p.finalizeKey });
  return { ...p, completion };
}
async function publish(s: Store) {
  const view = f.ok(await f.call('GET', s.root, s.owner));
  f.ok(await f.post(s.root + '/publish', s.owner, {}, view.version));
  return (await f.h.pool.query('SELECT * FROM commerce_storefront_publications WHERE instance_id=$1 ORDER BY revision DESC LIMIT 1', [s.instanceId])).rows[0];
}
async function usage(s: Store) {
  return withTenantRead(f.runtime, { actor: s.actor, tenantId: s.tenantId, capabilitiesForRole: storeCapabilities }, async (q, context) => ({
    total: await retainedByteUsage(q, context.scope.scope_id, context.tenant_id), summary: await capacitySummary(q, context.scope.scope_id, context.tenant_id),
  }));
}
async function work(s: Store) {
  const enabled = await f.h.enable(s.owner, s.tenantId, s.workspaceId, 'guild_commerce_sales');
  assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
  const made = f.ok(await f.post(`/tenants/${s.tenantId}/workspaces/${s.workspaceId}/works`, s.owner,
    { title: '照片共用容量的工作', objective: '驗證原 Work 成果', progress: 'todo' }), 201);
  const id = made.resource_ref.resource_id as string;
  return { id, service: createTenantResultService(f.runtime, f.store), input: {
    content_type: 'text/plain', byte_size: 3, sha256: hash(Buffer.from('abc')), display_name: 'result.txt', expected_work_version: '1',
  } };
}
async function object(p: Awaited<ReturnType<typeof begin>>) {
  return (await f.h.pool.query(`SELECT o.*,a.tenant_ref FROM asset_objects o JOIN assets a USING(asset_id) WHERE o.asset_id=$1`, [p.prepared.assetId])).rows[0];
}
async function addRef(pub: any, sku: string, o: any, extra: { tenant?: string; instance?: string; representation?: string; policy?: string; width?: number } = {}) {
  return f.h.pool.query(`INSERT INTO commerce_publication_photo_refs(publication_id,sku,tenant_id,instance_id,scope_id,asset_id,representation_id,policy_revision,width)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [pub.publication_id, sku, extra.tenant ?? pub.tenant_id, extra.instance ?? pub.instance_id,
    o.scope_id, o.asset_id, extra.representation ?? o.representation_id, extra.policy ?? o.policy_revision, extra.width ?? null]);
}
async function waitFor(check: () => Promise<boolean>, message: string, milliseconds = 5000) {
  const until = Date.now() + milliseconds;
  while (Date.now() < until) { if (await check()) return; await delay(20); }
  assert.fail(message);
}

test('PHOTO-SQL-01 cold policy and restricted grants fail closed while original Work text remains usable', async () => {
  const policy = (await f.h.pool.query("SELECT mode,persistence_allowed,policy_revision,retained_byte_limit FROM domain_media_storage_policy WHERE purpose='storefront.product-photo'")).rows[0];
  assert.deepEqual(policy, { mode: 'legacy', persistence_allowed: false, policy_revision: null, retained_byte_limit: null });
  const role = (await f.runtime.query(`SELECT r.rolsuper,r.rolbypassrls,c.relowner<>r.oid AS non_owner FROM pg_roles r
    JOIN pg_class c ON c.relname='commerce_product_photo_targets' JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname=current_schema()
    WHERE r.rolname=current_user`)).rows[0];
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false, non_owner: true });
  await assert.rejects(f.runtime.query("UPDATE domain_media_storage_policy SET persistence_allowed=true WHERE purpose='storefront.product-photo'"), sqlCode('42501'));
  const s = await f.openStore();
  await assert.rejects(begin(s), problem(503, 'product_photo_unavailable'));
  assert.equal(f.store.puts, 0); assert.equal((await f.h.pool.query("SELECT count(*)::int n FROM assets WHERE purpose='storefront.product-photo'")).rows[0].n, 0);
  const w = await work(s), prepared = await w.service.prepare(s.actor, s.tenantId, w.id, w.input, randomUUID());
  const uploadId = OperationSchema.parse(prepared).resource_ref.resource_id;
  await w.service.writeContent(s.actor, s.tenantId, w.id, uploadId, Buffer.from('abc'), randomUUID(), '1');
  const current = await w.service.readUpload(s.actor, s.tenantId, w.id, uploadId);
  await w.service.finalize(s.actor, s.tenantId, w.id, uploadId, { expected_work_version: '1' }, randomUUID(), current.version);
  const old = (await f.h.pool.query(`SELECT i.target_product_id,i.target_instance_id,o.pixel_width,o.pixel_height,o.profile_id
    FROM asset_upload_intents i JOIN asset_objects o USING(asset_id) WHERE i.intent_id=$1`, [uploadId])).rows[0];
  assert.deepEqual(old, { target_product_id: null, target_instance_id: null, pixel_width: null, pixel_height: null, profile_id: null });
  assert.equal((await usage(s)).total, 3n);
});

test('PHOTO-SQL-02 typed ready references require the exact publication SKU and tenant/object tuple', async () => {
  const s = await f.openStore(); await enable(); const ready = await finish(s), o = await object(ready), first = await publish(s);
  assert.equal(o.pixel_width, 1); assert.equal(o.pixel_height, 1);
  const secondProduct = f.ok(await f.post(s.root + '/products', s.owner, { title: '第二商品', price_minor: 2222, stock: 1 }), 201);
  const second = await publish(s);
  assert.notEqual(first.publication_id, second.publication_id);
  await assert.rejects(addRef(first, 'P9999', o), sqlCode('23514'));
  await assert.rejects(addRef(first, secondProduct.sku, o), sqlCode('23514'));
  const count = (await f.h.pool.query('SELECT count(*)::int n FROM commerce_publication_photo_refs')).rows[0].n;
  for (const extra of [{ tenant: randomUUID() }, { instance: randomUUID() }, { width: 1920 }]) {
    await assert.rejects(addRef(second, secondProduct.sku, o, extra), sqlCode('23514'));
  }
  // A mismatching immutable object identity cannot be re-labelled as this photo.
  for (const extra of [{ representation: randomUUID() }, { policy: 'another-reviewed-policy' }]) {
    await assert.rejects(addRef(second, secondProduct.sku, o, extra), sqlCode('P0002'));
  }
  await assert.rejects(f.h.pool.query(`INSERT INTO commerce_publication_photo_refs(publication_id,sku,tenant_id,instance_id,scope_id,asset_id,representation_id,policy_revision,purpose)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'work.tenant-result')`, [second.publication_id, secondProduct.sku, s.tenantId, s.instanceId, o.scope_id, o.asset_id, o.representation_id, o.policy_revision]), sqlCode('428C9'));
  const pending = await begin({ ...s, productId: secondProduct.product_id }); await write(s, pending);
  await assert.rejects(addRef(second, secondProduct.sku, await object(pending)), sqlCode('23503'));
  assert.equal((await f.h.pool.query('SELECT count(*)::int n FROM commerce_publication_photo_refs')).rows[0].n, count);
  await assert.rejects(f.h.pool.query("UPDATE asset_objects SET pixel_width=2 WHERE asset_id=$1", [o.asset_id]), sqlCode('23514'));
  await assert.rejects(f.h.pool.query('UPDATE commerce_product_photo_targets SET product_id=$2 WHERE product_id=$1', [s.productId, secondProduct.product_id]), sqlCode('23514'));
  const other = await f.openStore();
  await withTenantRead(f.runtime, { actor: other.actor, tenantId: other.tenantId, capabilitiesForRole: storeCapabilities }, async q => {
    assert.equal((await q.query('SELECT * FROM commerce_publication_photo_refs WHERE publication_id=$1', [first.publication_id])).rowCount, 0);
    assert.equal((await q.query('SELECT * FROM commerce_product_photo_targets WHERE product_id=$1', [s.productId])).rowCount, 0);
  });
  assert.equal((await f.runtime.query('SELECT * FROM commerce_publication_photo_refs')).rowCount, 0, 'transaction context is not leaked into the pooled runtime');
});

test('PHOTO-SQL-03 replace/edit/clear/delete keep one product CAS and immutable old publication membership', async () => {
  const s = await f.openStore(); await enable(); const first = await finish(s), pub = await publish(s);
  const saved = (await f.h.pool.query('SELECT * FROM commerce_publication_photo_refs WHERE publication_id=$1', [pub.publication_id])).rows;
  const second = await finish(s, first.completion.completedVersion);
  assert.equal(second.completion.completedVersion, '3');
  const replay = await second.api.finalize(actor(s), { ...second.binding, key: second.finalizeKey });
  assert.deepEqual(replay, second.completion);
  assert.equal((await f.h.pool.query("SELECT count(*)::int n FROM scoped_transition_journal WHERE aggregate_id=$1 AND operation='asset.upload.finalize'", [s.productId])).rows[0].n, 2);
  f.ok(await f.call('PATCH', s.root + '/products/' + s.productId, s.owner, { title: '改標題仍保留照片' }, { 'Idempotency-Key': randomUUID(), 'If-Match': '"3"' }));
  const media = f.ok(await f.call('GET', s.root + '/product-media', s.owner));
  assert.equal(media.items[0].version, '4'); assert(media.items[0].photo);
  assert.equal((await f.h.pool.query('SELECT linked_at_product_version::text v FROM commerce_product_photo_targets WHERE product_id=$1', [s.productId])).rows[0].v, '3');
  await assert.rejects(f.h.pool.query('DELETE FROM commerce_items WHERE item_id=$1', [s.productId]), sqlCode('23514'));
  await assert.rejects(f.h.pool.query('DELETE FROM commerce_selections WHERE item_id=$1', [s.productId]), sqlCode('23514'));
  await f.h.pool.query("UPDATE domain_media_storage_policy SET persistence_allowed=false WHERE purpose='storefront.product-photo'");
  const removed = f.ok(await f.post(s.root + '/products/' + s.productId + '/photo/remove', s.owner, {}, '4'));
  assert.equal(removed.completed_version, '5'); assert.equal(removed.changed, true);
  const noop = f.ok(await f.post(s.root + '/products/' + s.productId + '/photo/remove', s.owner, {}, '5'));
  assert.equal(noop.completed_version, '5'); assert.equal(noop.changed, false);
  const retained = (await usage(s)).total;
  f.ok(await f.post(s.root + '/products/' + s.productId + '/remove', s.owner, {}, '5'));
  assert.equal((await f.h.pool.query('SELECT count(*)::int n FROM commerce_items WHERE item_id=$1', [s.productId])).rows[0].n, 0);
  assert.deepEqual((await f.h.pool.query('SELECT * FROM commerce_publication_photo_refs WHERE publication_id=$1', [pub.publication_id])).rows, saved);
  assert.equal((await f.h.pool.query('SELECT count(*)::int n FROM asset_upload_intents WHERE target_product_id=$1', [s.productId])).rows[0].n, 2);
  assert.equal((await usage(s)).total, retained);
  const publicMedia = await f.app.request(f.h.origin + '/api/v1/public/stores/' + s.slug + '/media');
  assert.equal(publicMedia.status, 200); const body = await publicMedia.json() as any;
  assert.equal((await f.app.request(f.h.origin + body.photos[0].photo.read_path)).status, 200);
  await assert.rejects(f.h.pool.query('DELETE FROM commerce_publication_photo_refs WHERE publication_id=$1', [pub.publication_id]), sqlCode('23514'));
  await assert.rejects(f.h.pool.query('UPDATE commerce_storefront_publications SET media_sha256=media_sha256 WHERE publication_id=$1', [pub.publication_id]), sqlCode('23514'));
});

test('PHOTO-SQL-04 committed unknown PUT and expired pending remain charged; original retry stores one representation', async () => {
  const s = await f.openStore(); await enable(); const p = await begin(s);
  const put = f.store.putImmutable.bind(f.store), get = f.store.get.bind(f.store);
  f.store.putImmutable = async (...args) => { await put(...args); throw Error('synthetic ACK loss after committed PUT'); };
  f.store.get = async () => { throw Error('synthetic readback outage'); };
  try { await assert.rejects(write(s, p), AssetStorageError); }
  finally { f.store.putImmutable = put; f.store.get = get; }
  assert.equal((await usage(s)).total, 1048576n);
  assert.equal((await f.h.pool.query('SELECT state FROM asset_object_write_effects WHERE intent_id=$1', [p.prepared.intentId])).rows[0].state, 'unknown');
  await write(s, p); await p.api.finalize(actor(s), { ...p.binding, key: p.finalizeKey });
  assert.deepEqual(await p.api.prepare(actor(s), p.input), p.prepared);
  assert.equal((await f.h.pool.query('SELECT count(*)::int n FROM assets WHERE asset_id=$1', [p.prepared.assetId])).rows[0].n, 1);
  const o = await object(p); assert.equal((await usage(s)).total, BigInt(o.byte_size));
  assert.deepEqual((await f.h.pool.query('SELECT state FROM asset_object_write_effects WHERE intent_id=$1 ORDER BY begun_at', [p.prepared.intentId])).rows.map(r => r.state), ['unknown', 'fulfilled']);
  const short = await createStorefrontProductPhotoLifecycle(f.runtime, { store: f.store, intentTtlSeconds: 1 }).forProduct({ mime: 'image/png', bytes: photoSourcePng });
  const expired = await short.prepare(actor(s), { ...p.input, key: randomUUID(), expectedVersion: '2' });
  await waitFor(async () => (await f.h.pool.query('SELECT expires_at<=clock_timestamp() done FROM asset_upload_intents WHERE intent_id=$1', [expired.intentId])).rows[0].done, 'short supported intent TTL did not expire');
  await assert.rejects(short.claim(actor(s), { key: randomUUID(), intentId: expired.intentId }), problem(409, 'asset_intent_expired'));
  const total = BigInt(o.byte_size) + 1048576n; assert.equal((await usage(s)).total, total);
  await publish(s); const count = (await f.h.pool.query('SELECT count(*)::int n FROM commerce_publication_photo_refs')).rows[0].n;
  f.ok(await f.call('PATCH', s.root, s.owner, { name: '同照片的新發布' }, { 'Idempotency-Key': randomUUID(), 'If-Match': `"${f.ok(await f.call('GET', s.root, s.owner)).version}"` }));
  await publish(s);
  assert.equal((await f.h.pool.query('SELECT count(*)::int n FROM commerce_publication_photo_refs')).rows[0].n, count + 1);
  assert.equal((await usage(s)).total, total, 'repeated publication refs do not multiply retained bytes');
});

test('PHOTO-SQL-05 Work and photo reservations serialize one shared budget in both observed arrival orders', async () => {
  await enable();
  const initial = (await f.h.pool.query("SELECT max_retained_bytes::text n FROM tenant_capacity_policies WHERE status='active' AND tenant_id IS NULL")).rows[0].n;
  try {
    await f.h.pool.query("UPDATE tenant_capacity_policies SET max_retained_bytes=1048576 WHERE status='active' AND tenant_id IS NULL");
    for (const first of ['photo', 'work'] as const) {
      const s = await f.openStore(), w = await work(s), api = await f.assets.forProduct({ mime: 'image/png', bytes: photoSourcePng });
      const photoInput = { key: randomUUID(), targetProductId: s.productId, expectedVersion: '1', contentType: 'image/png' as const, byteSize: photoSourcePng.length, sha256: hash(photoSourcePng) };
      const holder = await f.h.pool.connect(); const running: Promise<unknown>[] = [];
      try {
        await holder.query('BEGIN'); const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`tenant.capacity/v1/${s.tenantId}/policy`]);
        const photo = () => api.prepare(actor(s), photoInput);
        const text = () => w.service.prepare(s.actor, s.tenantId, w.id, w.input, randomUUID());
        const a = first === 'photo' ? photo() : text(); running.push(a); a.catch(() => {});
        await waitFor(async () => (await f.h.pool.query('SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid])).rows[0].n >= 1, 'first request never blocked on the held policy');
        const b = first === 'photo' ? text() : photo(); running.push(b); b.catch(() => {}); const pending = Promise.allSettled([a, b]);
        await waitFor(async () => (await f.h.pool.query(`SELECT count(*)::int n FROM pg_stat_activity a WHERE a.datname=current_database() AND a.usename=$1 AND a.wait_event_type='Lock'`, [f.role])).rows[0].n >= 2, 'both real requests must be waiting before release');
        await holder.query('COMMIT');
        const outcomes = await pending; assert.equal(outcomes.filter(v => v.status === 'fulfilled').length, 1);
        const rejected = outcomes.find(v => v.status === 'rejected') as PromiseRejectedResult;
        assert(problem(429, 'quota_exceeded')(rejected.reason));
        const used = (await usage(s)).total; assert(used === 262144n || used === 1048576n);
        assert.equal((await f.h.pool.query('SELECT count(*)::int n FROM assets WHERE tenant_ref=$1', [s.tenantId])).rows[0].n, 1);
      } finally { try { await holder.query('ROLLBACK'); } finally { holder.release(); await Promise.allSettled(running); } }
    }
  } finally { await f.h.pool.query("UPDATE tenant_capacity_policies SET max_retained_bytes=$1 WHERE status='active' AND tenant_id IS NULL", [initial]); }
  await f.h.pool.query("UPDATE domain_media_storage_policy SET retained_byte_limit=1048576 WHERE purpose='storefront.product-photo'");
  const s = await f.openStore(), first = await begin(s);
  await assert.rejects(first.api.prepare(actor(s), { ...first.input, key: randomUUID() }), problem(409, 'asset_retained_quota'));
  assert.equal((await usage(s)).total, 1048576n, 'independent photo cap still applies below the larger shared limit');
});

test('PHOTO-SQL-06 current policy and membership are rechecked after stored bytes and Object I/O waits', async () => {
  const s = await f.openStore(); await enable(); const prepared = await begin(s);
  await f.h.pool.query("UPDATE domain_media_storage_policy SET policy_revision='synthetic-photo-sql-2' WHERE purpose='storefront.product-photo'");
  await assert.rejects(write(s, prepared), problem(409, 'asset_policy_changed')); assert.equal(f.store.puts, 0);
  await enable();
  const invited = await f.h.person('照片權限測試管理員'), principal = await f.h.candidate(s.owner, invited.id);
  const invitation = await f.h.invite(s.owner, s.tenantId, principal, 'admin'); f.ok(invitation, 201); await f.h.accept(invited.session, s.tenantId, invitation);
  const member = { ...s, owner: invited.session, actor: await authenticate(f.runtime, invited.session.cookie.split('=')[1]) };
  const p = await begin(member); await write(member, p);
  const other = await f.openStore(member.owner);
  await assert.rejects(p.api.resumeUpload(actor(other), { key: randomUUID(), intentId: p.prepared.intentId }), problem(404, 'asset_intent_not_found'));
  f.store.afterGet = async () => {
    f.store.afterGet = undefined;
    const page = f.ok(await f.call('GET', `/tenants/${s.tenantId}/members?limit=100`, s.owner));
    const row = page.items.find((item: any) => item.principal_id === principal); assert(row);
    f.ok(await f.post(`/tenants/${s.tenantId}/members/${principal}/change`, s.owner,
      { role: 'viewer', status: 'active', instance_capabilities: [], reason: '撤回照片寫入權' }, row.version));
  };
  await assert.rejects(p.api.finalize(actor(member), { ...p.binding, key: p.finalizeKey }), problem(404, 'not_found'));
  assert.equal((await f.h.pool.query('SELECT asset_id FROM commerce_product_photo_targets WHERE product_id=$1', [s.productId])).rows[0].asset_id, null);
  assert.equal((await f.h.pool.query('SELECT aggregate_version::text v FROM commerce_selections WHERE item_id=$1', [s.productId])).rows[0].v, '1');
  await assert.rejects(p.api.prepare(actor(member), p.input), problem(404, 'not_found'), 'old prepare receipt cannot restore revoked write authority');
});
