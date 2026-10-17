// Material records and copy versions are SQL fixtures: their routes belong to M1B.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, beforeEach, test } from 'node:test';
import sharp from 'sharp';
import { createSupplyMaterialLifecycle } from '../../modules/assets/supply-material.js';
import { createHostedStorePhotoHarness, photoSourcePng, type HostedStorePhotoHarness } from '../helpers/hosted-store-photo.js';
import type { Session } from './module-registry-harness.js';
import { objectKey } from '../../packages/asset-storage/index.js';
import { readWorkerConfig, type WorkerEnv } from '../../apps/platform-api/src/worker.js';
import { ReadinessError } from '../../apps/platform-api/src/readiness.js';
import { checkSupplyMaterialHeaders, isSupplyMaterialUpload } from '../../apps/platform-api/src/routes/hosted-supply-material-media.js';

let f: HostedStorePhotoHarness, assets: ReturnType<typeof createSupplyMaterialLifecycle>;
let app: ReturnType<HostedStorePhotoHarness['application']>;
before(async () => { f = await createHostedStorePhotoHarness(); assets = createSupplyMaterialLifecycle(f.runtime, { store: f.store }); });
after(async () => { await f?.stop(); });
beforeEach(async () => {
  await f.reset();
  await f.h.pool.query("UPDATE tenant_capacity_policies SET max_retained_bytes=104857600 WHERE status='active'");
  await f.h.pool.query("UPDATE domain_media_storage_policy SET persistence_allowed=false,policy_revision=NULL,retained_byte_limit=NULL WHERE purpose IN ('storefront.supply-material','storefront.supply-material-video')");
  app = application();
});
type Store = Awaited<ReturnType<HostedStorePhotoHarness['openStore']>>;
const video = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(244)]);
const application = (extra: NonNullable<Parameters<HostedStorePhotoHarness['application']>[1]> = {}) => f.application(true,
  { supplierConsoleEnabled: true, supplyMaterialAssetStore: f.store, supplyMaterialAssets: assets, supplyMaterialUploadsEnabled: true, ...extra });
async function enable() {
  await f.h.pool.query("UPDATE domain_media_storage_policy SET mode='r2_only',persistence_allowed=true,policy_revision='synthetic-material-http',retained_byte_limit=104857600 WHERE purpose IN ('storefront.supply-material','storefront.supply-material-video')");
}
async function material(s: Store, kind = 'image') {
  const id = randomUUID();
  await f.h.pool.query(`INSERT INTO supply_materials(material_id,tenant_id,instance_id,scope_id,kind,title,created_by_principal_id)
    SELECT $1,$2,$3,r.scope_id,$4,'合成素材',p.principal_id FROM resource_scopes r,principals p WHERE r.tenant_ref=$2 AND r.kind='tenant' AND p.user_ref=$5`,
  [id, s.tenantId, s.instanceId, kind, s.owner.user.user_id]);
  return id;
}
const uploadPath = (s: Store, id: string) => '/api/v1' + s.root + '/supply-materials/' + id + '/content';
const contentPath = (s: Store, id: string, version: string) => '/api/v1' + s.root + '/supply-materials/' + id + '/versions/' + version + '/content';
async function upload(s: Store, id: string, options: { key?: string; expected?: string; mime?: string; bytes?: Uint8Array; session?: Session; app?: typeof app; query?: string } = {}) {
  const response = await (options.app ?? app).request(f.h.origin + uploadPath(s, id) + (options.query ?? ''), { method: 'POST', headers: {
    Origin: f.h.origin, Cookie: (options.session ?? s.owner).cookie, 'X-CSRF-Token': (options.session ?? s.owner).csrf,
    'Content-Type': options.mime ?? 'image/png', 'Idempotency-Key': options.key ?? randomUUID(), 'If-Match': `"${options.expected ?? '1'}"`,
  }, body: new Uint8Array(options.bytes ?? photoSourcePng) });
  const data = await response.json() as any;
  return { status: response.status, response, data };
}
const read = (s: Store, id: string, version: string, headers: Record<string, string> = {}, method = 'GET', session: Session | undefined = s.owner, target = app) => target.request(f.h.origin + contentPath(s, id, version), { method, headers: { ...(session ? { Cookie: session.cookie } : {}), ...headers } });
async function version(id: string) { return (await f.h.pool.query('SELECT * FROM supply_material_versions WHERE material_id=$1 ORDER BY version_no DESC LIMIT 1', [id])).rows[0]; }
async function counts() {
  return (await f.h.pool.query(`SELECT (SELECT count(*)::int FROM assets WHERE purpose IN ('storefront.supply-material','storefront.supply-material-video')) assets,
    (SELECT count(*)::int FROM asset_objects WHERE purpose IN ('storefront.supply-material','storefront.supply-material-video')) objects,
    (SELECT count(*)::int FROM asset_upload_intents WHERE purpose IN ('storefront.supply-material','storefront.supply-material-video')) intents,
    (SELECT count(*)::int FROM supply_material_versions) versions,
    (SELECT count(*)::int FROM scoped_transition_journal WHERE operation='storefront.supply-material.upload') facts`)).rows[0];
}
function privateHeaders(response: Response) {
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store'); assert.equal(response.headers.get('Vary'), 'Cookie');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
}
function byteHeaders(response: Response, type: string) {
  privateHeaders(response); assert.equal(response.headers.get('Content-Type'), type); assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
  assert.match(response.headers.get('ETag')!, /^"[A-Za-z0-9_-]+"$/); assert.equal(response.headers.get('Content-Disposition'), 'inline');
  assert.match(response.headers.get('Content-Length')!, /^\d+$/);
}
function receipt(reply: Awaited<ReturnType<typeof upload>>, id: string, expected = '2') {
  assert([200, 201].includes(reply.status), JSON.stringify(reply.data)); assert.deepEqual(reply.data, { material_id: id, version: expected });
  privateHeaders(reply.response); assert.equal(reply.response.headers.get('ETag'), `"${expected}"`);
  assert(!/asset_id|representation_id|policy_revision|profile_id|bucket|locator|https?:|v1\//i.test(JSON.stringify(reply.data)));
}
async function withdraw(id: string) { await f.h.pool.query("UPDATE supply_materials SET state='withdrawn',withdrawn_at=clock_timestamp(),aggregate_version=aggregate_version+1 WHERE material_id=$1", [id]); }
async function join(s: Store, keys: string[]) {
  const person = (await f.h.person('合成素材協作者')).session;
  const principal = f.ok(await f.call('GET', `/tenants/invite-candidates?user_id=${person.user.user_id}`, s.owner)).principal_id;
  const invitation = f.ok(await f.post(`/tenants/${s.tenantId}/invitations`, s.owner, { invitee_principal_id: principal, role: 'operator',
    instance_capabilities: [{ instance_id: s.instanceId, capabilities: keys }], expires_at: new Date(Date.now() + 86400000).toISOString() }), 201);
  f.ok(await f.post(`/tenants/${s.tenantId}/invitations/${invitation.invitation_id}/accept`, person, {}, invitation.version));
  return { person, principal };
}
async function change(s: Store, principal: string, keys: string[]) {
  const row = f.ok(await f.call('GET', `/tenants/${s.tenantId}/members`, s.owner)).items.find((m: any) => m.principal_id === principal);
  f.ok(await f.post(`/tenants/${s.tenantId}/members/${principal}/change`, s.owner, { role: 'operator', status: 'active',
    instance_capabilities: [{ instance_id: s.instanceId, capabilities: keys }], reason: '合成素材撤權測試' }, row.version));
}

test('MATERIAL-HTTP-01 image receipt appends a ready immutable version; GET decodes stored WebP and HEAD verifies headers without a body', async () => {
  const s = await f.openStore(), id = await material(s);
  assert.equal((await f.h.pool.query("SELECT mode FROM domain_media_storage_policy WHERE purpose='storefront.supply-material'")).rows[0].mode, 'legacy');
  const cold = await upload(s, id); assert.equal(cold.status, 503); assert.equal(cold.data.code, 'material_upload_unavailable');
  await enable(); const result = await upload(s, id); receipt(result, id);
  const row = await version(id), object = (await f.h.pool.query('SELECT o.*,a.state FROM asset_objects o JOIN assets a USING(asset_id) WHERE asset_id=$1', [row.asset_id])).rows[0];
  assert.equal(row.kind, 'image'); assert.equal(row.version_no, 1); assert.equal(object.state, 'ready'); assert.equal(object.purpose, 'storefront.supply-material');
  assert.equal(object.profile_id, object.purpose); assert.equal(object.transform_version, 'storefront.supply-material.webp.v1'); assert.equal(object.pixel_width, 1); assert.equal(object.pixel_height, 1);
  const get = await read(s, id, row.version_id); assert.equal(get.status, 200); byteHeaders(get, 'image/webp');
  const bytes = Buffer.from(await get.arrayBuffer()); assert(bytes.length <= 1048576); assert.equal(bytes.length, Number(object.byte_size));
  const shape = await sharp(bytes).metadata(); assert.equal(shape.format, 'webp'); assert(shape.width! <= 1920 && shape.height! <= 1920); await sharp(bytes).raw().toBuffer();
  const stored = await f.store.get(objectKey({ scopeId: row.scope_id, assetId: row.asset_id, representationId: row.representation_id }));
  assert.deepEqual(bytes, Buffer.from(await new Response(stored!.body).arrayBuffer()));
  const before = f.store.gets, head = await read(s, id, row.version_id, {}, 'HEAD'); assert.equal(head.status, 200); byteHeaders(head, 'image/webp');
  assert.equal(await head.text(), ''); assert.equal(f.store.gets, before, 'HEAD uses metadata without downloading');
  assert.deepEqual(await counts(), { assets: 1, objects: 1, intents: 1, versions: 1, facts: 1 });
  await withdraw(id); assert.equal((await read(s, id, row.version_id)).status, 200, 'supplier keeps withdrawn bytes');
});

test('MATERIAL-HTTP-02 original video bytes support exact ranges, 416 and If-Range fallback', async () => {
  const s = await f.openStore(); await enable();
  for (const [mime, bytes] of [['video/mp4', video], ['video/webm', Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(252)])]] as const) {
    const id = await material(s, 'video'); receipt(await upload(s, id, { mime, bytes }), id); const row = await version(id);
    const full = await read(s, id, row.version_id); byteHeaders(full, mime); assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
    const ranged = await read(s, id, row.version_id, { Range: 'bytes=0-99' }); assert.equal(ranged.status, 206); byteHeaders(ranged, mime);
    assert.equal(ranged.headers.get('Content-Range'), `bytes 0-99/${bytes.length}`); assert.equal(ranged.headers.get('Content-Length'), '100');
    assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), bytes.subarray(0, 100));
    const invalid = await read(s, id, row.version_id, { Range: 'bytes=999-1000' }); assert.equal(invalid.status, 416); byteHeaders(invalid, mime);
    assert.equal(invalid.headers.get('Content-Range'), `bytes */${bytes.length}`); assert.equal(await invalid.text(), '');
    const fallback = await read(s, id, row.version_id, { Range: 'bytes=0-99', 'If-Range': '"another-etag"' }); assert.equal(fallback.status, 200); byteHeaders(fallback, mime);
    assert.deepEqual(Buffer.from(await fallback.arrayBuffer()), bytes);
    const o = (await f.h.pool.query('SELECT pixel_width,pixel_height,transform_version FROM asset_objects WHERE asset_id=$1', [row.asset_id])).rows[0];
    assert.deepEqual(o, { pixel_width: null, pixel_height: null, transform_version: 'storefront.supply-material-video.original.v1' });
  }
});

test('MATERIAL-HTTP-03 exact replay is historical and unique; changed payload, stale CAS, withdrawal and wrong kind refuse', async () => {
  const s = await f.openStore(), id = await material(s); await enable(); const key = randomUUID(), first = await upload(s, id, { key }); receipt(first, id);
  const baseline = await counts(); receipt(await upload(s, id, { key }), id); assert.deepEqual(await counts(), baseline);
  const different = await upload(s, id, { key, bytes: Buffer.concat([photoSourcePng, Buffer.from('different')]) }); assert.equal(different.status, 409); assert.match(different.data.code, /^idempotency_/);
  const stale = await upload(s, id); assert.equal(stale.status, 412); assert.equal(stale.data.code, 'version_conflict');
  const second = await upload(s, id, { expected: '2' }); receipt(second, id, '3'); const older = await f.h.pool.query('SELECT version_id FROM supply_material_versions WHERE material_id=$1 ORDER BY version_no', [id]);
  assert.equal((await read(s, id, older.rows[0].version_id)).status, 200); assert.equal((await read(s, id, older.rows[1].version_id)).status, 200);
  await withdraw(id); const refused = await upload(s, id, { expected: '4' }); assert.equal(refused.status, 409); assert.equal(refused.data.code, 'material_withdrawn');
  receipt(await upload(s, id, { key, app: application({ supplyMaterialAssets: undefined, supplyMaterialUploadsEnabled: false }) }), id);
  for (const [kind, mime, bytes] of [['image', 'video/mp4', video], ['video', 'image/png', photoSourcePng], ['copy', 'image/png', photoSourcePng]] as const) {
    const other = await material(s, kind), reply = await upload(s, other, { mime, bytes }); assert.equal(reply.status, 409); assert.equal(reply.data.code, 'material_kind_mismatch');
  }
});

test('MATERIAL-HTTP-04 AT-24 shared and purpose quotas leave no new rows/bytes; raising each limit admits the SAME key once', async () => {
  const s = await f.openStore(), id = await material(s); await enable(); const key = randomUUID();
  await f.h.pool.query("UPDATE tenant_capacity_policies SET max_retained_bytes=1 WHERE status='active'");
  const blocked = await upload(s, id, { key }); assert.equal(blocked.status, 429); assert.equal(blocked.data.code, 'quota_exceeded'); privateHeaders(blocked.response);
  assert.deepEqual(await counts(), { assets: 0, objects: 0, intents: 0, versions: 0, facts: 0 }); assert.equal(f.store.puts, 0);
  assert.equal((await read(s, id, randomUUID())).status, 404);
  await f.h.pool.query("UPDATE tenant_capacity_policies SET max_retained_bytes=104857600 WHERE status='active'");
  receipt(await upload(s, id, { key }), id); receipt(await upload(s, id, { key }), id);
  for (const [kind, purpose, mime, bytes, limit] of [['image', 'storefront.supply-material', 'image/png', photoSourcePng, 1048576],
    ['video', 'storefront.supply-material-video', 'video/mp4', video, 20971520]] as const) {
    if (kind === 'video') { const seed = await material(s, kind); receipt(await upload(s, seed, { mime, bytes }), seed); }
    await f.h.pool.query('UPDATE domain_media_storage_policy SET retained_byte_limit=$2 WHERE purpose=$1', [purpose, limit]);
    const target = await material(s, kind), retryKey = randomUUID(), before = await counts(); const puts: number = f.store.puts;
    const refused = await upload(s, target, { key: retryKey, mime, bytes }); assert.equal(refused.status, 409); assert.equal(refused.data.code, 'asset_retained_quota');
    assert.deepEqual(await counts(), before); assert.equal(f.store.puts, puts); assert.equal((await read(s, target, randomUUID())).status, 404);
    await f.h.pool.query('UPDATE domain_media_storage_policy SET retained_byte_limit=$2 WHERE purpose=$1', [purpose, 2 * limit]);
    receipt(await upload(s, target, { key: retryKey, mime, bytes }), target); receipt(await upload(s, target, { key: retryKey, mime, bytes }), target);
    const after = await counts(); for (const field of ['assets', 'objects', 'intents', 'versions', 'facts']) assert.equal(after[field], before[field] + 1, field);
  }
});

test('MATERIAL-HTTP-05 cold policy and disabled upload admission fail closed; absent media/console/launchpad leave routes uninstalled', async () => {
  const s = await f.openStore(), id = await material(s);
  for (const mode of ['legacy', 'off']) {
    // off is represented by persistence refusal; the SQL mode enum is unchanged.
    if (mode === 'off') await f.h.pool.query("UPDATE domain_media_storage_policy SET mode='r2_only',persistence_allowed=false,policy_revision='synthetic-off',retained_byte_limit=104857600 WHERE purpose='storefront.supply-material'");
    const reply = await upload(s, id); assert.equal(reply.status, 503); assert.equal(reply.data.code, 'material_upload_unavailable'); privateHeaders(reply.response);
  }
  await enable();
  for (const options of [{ supplyMaterialUploadsEnabled: false }, { supplyMaterialAssets: undefined }]) {
    const reply = await upload(s, id, { app: application(options) }); assert.equal(reply.status, 503); assert.equal(reply.data.code, 'material_upload_unavailable');
  }
  for (const options of [{ supplyMaterialAssetStore: undefined }, { supplierConsoleEnabled: false }, { guildLaunchpadEnabled: false }]) {
    const closed = application(options); assert.equal((await upload(s, id, { app: closed })).status, 404);
    assert.equal((await read(s, id, randomUUID(), {}, 'GET', s.owner, closed)).status, 404);
    const site = await (await closed.request(f.h.origin + '/api/v1/site')).json() as any;
    assert.equal(site.supply_material_media_enabled, false); assert.equal(site.supply_material_uploads_enabled, false);
  }
  const site = await (await app.request(f.h.origin + '/api/v1/site')).json() as any;
  assert.equal(site.supply_material_media_enabled, true); assert.equal(site.supply_material_uploads_enabled, true);
  assert.deepEqual(await counts(), { assets: 0, objects: 0, intents: 0, versions: 0, facts: 0 }); assert.equal(f.store.puts, 0);
});

test('MATERIAL-HTTP-06 raw header gate runs before body reads; unknown query keys and image source overflow refuse', async () => {
  const s = await f.openStore(), id = await material(s); await enable();
  for (const patch of [{ 'Content-Type': 'text/html' }, { 'Content-Length': '20971521' }, { 'Content-Length': '0' }]) {
    let pulls = 0;
    const req = new Request(f.h.origin + uploadPath(s, id), { method: 'POST', headers: { Origin: f.h.origin, Cookie: s.owner.cookie, 'X-CSRF-Token': s.owner.csrf,
      'Content-Type': 'image/png', 'Idempotency-Key': randomUUID(), 'If-Match': '"1"', ...patch },
      body: new ReadableStream({ pull() { pulls++; throw Error('must not read'); } }, { highWaterMark: 0 }), duplex: 'half' } as RequestInit);
    const response = await app.request(req); assert.equal(response.status, patch['Content-Type'] ? 415 : 413); privateHeaders(response); assert.equal(pulls, 0);
  }
  assert.equal((await upload(s, id, { query: '?unknown=1' })).status, 422);
  const overflow = await upload(s, id, { bytes: Buffer.alloc(2097153) }); assert.equal(overflow.status, 413); assert.equal(overflow.data.code, 'material_too_large');
  assert.equal((await read(s, id, randomUUID(), {}, 'GET')).status, 404); assert.equal(f.store.puts, 0);
});

test('MATERIAL-HTTP-07 supplier authority hides foreign material/version and denies viewers, partners, nonmembers and anonymous callers', async () => {
  const s = await f.openStore(), id = await material(s); await enable(); receipt(await upload(s, id), id); const row = await version(id);
  const viewer = await join(s, ['store:read']); assert.equal((await upload(s, id, { session: viewer.person, expected: '2' })).status, 403);
  assert.equal((await read(s, id, row.version_id, {}, 'GET', viewer.person)).status, 403);
  const seller = await f.openStore(), nonmember = (await f.h.person('合成非會員')).session;
  await f.h.pool.query(`INSERT INTO supply_material_grants(grant_id,material_id,tenant_id,instance_id,partner_shop_id,granted_by_principal_id)
    SELECT $1,m.material_id,m.tenant_id,m.instance_id,p.storefront_shop_id,m.created_by_principal_id FROM supply_materials m,commerce_storefront_profiles p
    WHERE m.material_id=$2 AND p.tenant_id=$3 AND p.instance_id=$4`, [randomUUID(), id, seller.tenantId, seller.instanceId]);
  for (const session of [seller.owner, nonmember]) {
    assert.equal((await upload(s, id, { session, expected: '2' })).status, 404);
    const response = await read(s, id, row.version_id, {}, 'GET', session); assert.equal(response.status, 404); privateHeaders(response);
  }
  const anonymous = await app.request(f.h.origin + contentPath(s, id, row.version_id)); assert.equal(anonymous.status, 401); privateHeaders(anonymous);
  const anonymousUpload = await app.request(f.h.origin + uploadPath(s, id), { method: 'POST', headers: { Origin: f.h.origin, 'Content-Type': 'image/png', 'Idempotency-Key': randomUUID(), 'If-Match': '"2"' }, body: new Uint8Array(photoSourcePng) }); assert.equal(anonymousUpload.status, 401); privateHeaders(anonymousUpload);
  const other = await material(s); receipt(await upload(s, other), other); assert.equal((await read(s, other, row.version_id)).status, 404);
  assert.equal((await upload(seller, id)).status, 404); assert.equal((await read(seller, id, row.version_id)).status, 404);
  const copy = await material(s, 'copy'), copyVersion = randomUUID();
  await f.h.pool.query(`INSERT INTO supply_material_versions(version_id,material_id,tenant_id,instance_id,scope_id,kind,version_no,body,created_by_principal_id)
    SELECT $1,material_id,tenant_id,instance_id,scope_id,'copy',1,'合成文案',created_by_principal_id FROM supply_materials WHERE material_id=$2`, [copyVersion, copy]);
  assert.equal((await read(s, copy, copyVersion)).status, 404);
});

test('MATERIAL-HTTP-08 missing objects or mismatched storage metadata are 503 problems, never empty successful reads', async () => {
  const s = await f.openStore(), id = await material(s); await enable(); receipt(await upload(s, id), id); const row = await version(id);
  const originalHead = f.store.head.bind(f.store);
  f.store.head = async key => { const head = await originalHead(key); return head && { ...head, metadata: { ...head.metadata, byteSize: head.metadata.byteSize + 1 } }; };
  try { const bad = await read(s, id, row.version_id); assert.equal(bad.status, 503); assert.equal((await bad.json() as any).code, 'material_content_unavailable'); privateHeaders(bad); }
  finally { f.store.head = originalHead; }
  f.store.failNext('get'); const unavailable = await read(s, id, row.version_id); assert.equal(unavailable.status, 503); assert.equal((await unavailable.json() as any).code, 'material_content_unavailable');
  await f.store.delete(objectKey({ scopeId: row.scope_id, assetId: row.asset_id, representationId: row.representation_id }));
  for (const method of ['GET', 'HEAD']) { const missing = await read(s, id, row.version_id, {}, method); assert.equal(missing.status, 503); privateHeaders(missing); }
});

test('MATERIAL-HTTP-09 after-I/O authority revocation refuses a range and cancels its body; AT-35 receipt replay is also refused', async () => {
  const s = await f.openStore(), id = await material(s, 'video'); await enable(); const writer = await join(s, ['store:read', 'store:write']), key = randomUUID();
  receipt(await upload(s, id, { key, mime: 'video/mp4', bytes: video, session: writer.person }), id); const row = await version(id);
  const original = f.store.get.bind(f.store); let cancelled = false;
  f.store.get = async (...args) => {
    const object = await original(...args); if (!object) return null; const reader = object.body.getReader();
    return { ...object, body: new ReadableStream({ async pull(c) { const next = await reader.read(); if (next.done) c.close(); else c.enqueue(next.value); },
      async cancel() { cancelled = true; await reader.cancel(); } }, { highWaterMark: 0 }) };
  };
  f.store.afterGet = async () => { f.store.afterGet = undefined; await change(s, writer.principal, ['store:read']); };
  try { const refused = await read(s, id, row.version_id, { Range: 'bytes=0-99' }, 'GET', writer.person); assert.equal(refused.status, 404); assert.equal(cancelled, true); privateHeaders(refused); }
  finally { f.store.get = original; f.store.afterGet = undefined; }
  const replay = await upload(s, id, { key, mime: 'video/mp4', bytes: video, session: writer.person }); assert.equal(replay.status, 403); assert.equal(replay.data.code, 'capability_denied');
  assert.deepEqual(await counts(), { assets: 1, objects: 1, intents: 1, versions: 1, facts: 1 });
});

test('MATERIAL-HTTP-10 unknown immutable PUT resumes the original key and intent without duplicating a version or fact', async () => {
  const s = await f.openStore(), id = await material(s); await enable(); const key = randomUUID(); f.store.failNext('put-after'); f.store.failNext('get');
  const failed = await upload(s, id, { key }); assert.equal(failed.status, 503); assert.equal(failed.data.code, 'material_upload_unavailable');
  assert.deepEqual(await counts(), { assets: 1, objects: 0, intents: 1, versions: 0, facts: 0 });
  const pending = (await f.h.pool.query('SELECT intent_id,asset_id FROM asset_upload_intents WHERE target_material_id=$1', [id])).rows[0];
  receipt(await upload(s, id, { key }), id); receipt(await upload(s, id, { key }), id);
  assert.deepEqual(await counts(), { assets: 1, objects: 1, intents: 1, versions: 1, facts: 1 });
  assert.deepEqual((await f.h.pool.query('SELECT intent_id,asset_id FROM asset_upload_intents WHERE target_material_id=$1', [id])).rows, [pending]);
});

test('MATERIAL-HTTP-11 Worker material flags fail closed and header admission is a finite five-type 20 MiB set', () => {
  const base = { FREEDOM_ENV: 'local', APP_ORIGIN: 'http://127.0.0.1:4795', FREEDOM_GUILD_LAUNCHPAD_ENABLED: 'true', FREEDOM_SUPPLIER_CONSOLE_ENABLED: 'true',
    HYPERDRIVE: { connectionString: process.env.TEST_DATABASE_URL! }, ASSETS: { async fetch() { return new Response(); } },
    MEDIA: { get() {}, put() {}, head() {}, delete() {} }, IMAGES: { info() {}, input() {} } } as unknown as WorkerEnv;
  for (const flag of ['FREEDOM_SUPPLY_MATERIAL_MEDIA_ENABLED', 'FREEDOM_SUPPLY_MATERIAL_UPLOADS_ENABLED']) {
    for (const value of ['TRUE', '', ' true']) assert.throws(() => readWorkerConfig({ ...base, [flag]: value }), ReadinessError);
  }
  assert.throws(() => readWorkerConfig({ ...base, FREEDOM_SUPPLY_MATERIAL_MEDIA_ENABLED: 'true', FREEDOM_SUPPLIER_CONSOLE_ENABLED: 'false' }), ReadinessError);
  assert.throws(() => readWorkerConfig({ ...base, FREEDOM_SUPPLY_MATERIAL_MEDIA_ENABLED: 'true', MEDIA: undefined }), ReadinessError);
  assert.throws(() => readWorkerConfig({ ...base, FREEDOM_SUPPLY_MATERIAL_UPLOADS_ENABLED: 'true' }), ReadinessError);
  assert.throws(() => readWorkerConfig({ ...base, FREEDOM_SUPPLY_MATERIAL_MEDIA_ENABLED: 'true', FREEDOM_SUPPLY_MATERIAL_UPLOADS_ENABLED: 'true', IMAGES: undefined }), ReadinessError);
  assert.doesNotThrow(() => readWorkerConfig({ ...base, FREEDOM_SUPPLY_MATERIAL_MEDIA_ENABLED: 'true', IMAGES: undefined }));
  assert.doesNotThrow(() => readWorkerConfig({ ...base, FREEDOM_SUPPLY_MATERIAL_MEDIA_ENABLED: 'true', FREEDOM_SUPPLY_MATERIAL_UPLOADS_ENABLED: 'true' }));
  for (const type of ['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm']) assert.doesNotThrow(() => checkSupplyMaterialHeaders(type, '20971520'));
  for (const length of ['0', '-1', '1.5', '20971521']) assert.throws(() => checkSupplyMaterialHeaders('video/mp4', length));
  const path = '/api/v1/tenants/' + randomUUID() + '/storefronts/' + randomUUID() + '/supply-materials/' + randomUUID() + '/content';
  assert.equal(isSupplyMaterialUpload('POST', path), true); assert.equal(isSupplyMaterialUpload('PUT', path), false); assert.equal(isSupplyMaterialUpload('POST', path + '/other'), false);
});
