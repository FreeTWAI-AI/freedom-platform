// Material records are SQL fixtures: their create route belongs to M1B.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { before, after, beforeEach, test } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import sharp from 'sharp';
import { SUPPLY_MATERIAL_IMAGE_SOURCE_MAX_BYTES, SUPPLY_MATERIAL_IMAGE_MAX_BYTES, SUPPLY_MATERIAL_IMAGE_MAX_EDGE,
  SUPPLY_MATERIAL_VIDEO_MAX_BYTES } from '../../contracts/guild-launchpad/v1/supplier-console.js';
import { normalizeSupplyMaterialImage, assertSupplyMaterialVideo, lockSupplyMaterialPolicy, createSupplyMaterialLifecycle } from '../../modules/assets/supply-material.js';
import { uploadSupplyMaterialFile, lockSupplyMaterialTarget } from '../../modules/agent-commerce/supplier-console/material-media.js';
import { createAssetLifecycleWithAuthority, type LifecycleProfile, type LifecyclePrepare } from '../../modules/assets/engine.js';
import { memberLifecycleAuthority } from '../../modules/assets/lifecycle-authority.js';
import { createTenantLifecycleAuthority } from '../../modules/assets/tenant-lifecycle-authority.js';
import { createStorefrontLifecycleAuthority } from '../../modules/assets/storefront-lifecycle-authority.js';
import { runWithImageProcessor, createUnavailableImageProcessor } from '../../packages/shared/image-runtime.js';
import { FakeObjectStore } from '../../packages/asset-storage/fake-store.js';
import { MEDIA_OBJECT_PROFILES, OBJECT_IO_MAX_BYTES, prepareLegacyMediaRepresentation, writeVerifiedObject, objectKey, sha256, AssetStorageError } from '../../packages/asset-storage/index.js';
import { Problem } from '../../packages/shared/problem.js';
import { retainedByteUsage, capacitySummary } from '../../modules/opportunity-project-work/tenant-capacity.js';
import { withTenantRead } from '../../packages/resource-scopes/index.js';
import { storeCapabilities } from '../../modules/agent-commerce/hosted/capabilities.js';
import { createHostedStorePhotoHarness, photoSourcePng, type HostedStorePhotoHarness } from '../helpers/hosted-store-photo.js';

let f: HostedStorePhotoHarness;
before(async () => { f = await createHostedStorePhotoHarness(); });
after(async () => { await f?.stop(); });
beforeEach(async () => { await f.reset(); });
const problem = (status: number, code: string) => (error: unknown) => error instanceof Problem && error.status === status && error.code === code;
const stream = (bytes: Uint8Array) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const video = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(244)]);
const policy = { revision: 'synthetic-material-policy', platformPersistenceAllowed: true };

test('MATERIAL-ASSET-01 real PNG JPEG WebP normalize inside contract bounds and strip metadata', async () => {
  assert.deepEqual([SUPPLY_MATERIAL_IMAGE_SOURCE_MAX_BYTES, SUPPLY_MATERIAL_IMAGE_MAX_BYTES, SUPPLY_MATERIAL_IMAGE_MAX_EDGE, SUPPLY_MATERIAL_VIDEO_MAX_BYTES], [2097152, 1048576, 1920, 20971520]);
  for (const format of ['png', 'jpeg', 'webp'] as const) {
    const bytes = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: '#abcdef' } })[format]().withMetadata().toBuffer();
    const original = Buffer.from(bytes), output = await normalizeSupplyMaterialImage('image/' + format, bytes);
    assert.deepEqual(bytes, original); assert(output.length > 0 && output.length <= 1048576);
    const shape = await sharp(output).metadata(); assert.deepEqual([shape.format, shape.width, shape.height], ['webp', 1920, 960]);
    assert.equal(shape.exif, undefined); assert.equal(shape.icc, undefined);
    assert.equal((await sharp(output).raw().toBuffer()).length, 1920 * 960 * 3);
  }
});

test('MATERIAL-ASSET-02 source errors use material codes; a decoder outage stays 503 before quota', async () => {
  await assert.rejects(normalizeSupplyMaterialImage('image/gif', photoSourcePng), problem(415, 'material_format'));
  await assert.rejects(normalizeSupplyMaterialImage('image/png', Buffer.alloc(2097153)), problem(413, 'material_too_large'));
  for (const [mime, bytes] of [['image/png', Buffer.from('garbage')], ['image/jpeg', photoSourcePng], ['image/png', photoSourcePng.subarray(0, -1)],
    ['image/png', await sharp({ create: { width: 4097, height: 1, channels: 3, background: 'red' } }).png().toBuffer()]] as const) {
    await assert.rejects(normalizeSupplyMaterialImage(mime, bytes), problem(422, 'invalid_material_file'));
  }
  const frames = await Promise.all(['red', 'blue'].map(background => sharp({ create: { width: 8, height: 8, channels: 3, background } }).png().toBuffer()));
  const animated = await sharp(frames, { join: { animated: true } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
  await assert.rejects(normalizeSupplyMaterialImage('image/webp', animated), problem(422, 'invalid_material_file'));
  await runWithImageProcessor(createUnavailableImageProcessor(), async () => {
    await assert.rejects(normalizeSupplyMaterialImage('image/png', photoSourcePng), problem(503, 'material_upload_unavailable'));
  });
  assert.equal(f.store.puts, 0);
  assert.equal((await f.h.pool.query("SELECT count(*)::int n FROM assets WHERE purpose LIKE 'storefront.supply-material%'")).rows[0].n, 0);
});

test('MATERIAL-ASSET-03 video validation preserves exact MP4/WebM bytes and refuses MIME, size and header failures', () => {
  const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 1]);
  assert.equal(assertSupplyMaterialVideo('video/mp4', video), video);
  assert.equal(assertSupplyMaterialVideo('video/webm', webm), webm);
  assert.throws(() => assertSupplyMaterialVideo('video/ogg', video), problem(415, 'material_format'));
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(20971521)]) assert.throws(() => assertSupplyMaterialVideo('video/mp4', bytes), problem(413, 'material_too_large'));
  for (const mime of ['video/mp4', 'video/webm']) assert.throws(() => assertSupplyMaterialVideo(mime, Buffer.alloc(12)), problem(422, 'invalid_material_file'));
});

test('MATERIAL-ASSET-04 storage profiles enforce exact MIME/transform/size, canonical dimensions and video framing before PUT', async () => {
  assert.deepEqual(MEDIA_OBJECT_PROFILES['storefront.supply-material'], { maxBytes: 1048576, contentTypes: ['image/webp'], transformVersion: 'storefront.supply-material.webp.v1', source: 'modules/assets/supply-material.ts' });
  assert.deepEqual(MEDIA_OBJECT_PROFILES['storefront.supply-material-video'], { maxBytes: OBJECT_IO_MAX_BYTES, contentTypes: ['video/mp4', 'video/webm'], transformVersion: 'storefront.supply-material-video.original.v1', source: 'modules/assets/supply-material.ts' });
  const store = new FakeObjectStore(), goodImage = await normalizeSupplyMaterialImage('image/png', photoSourcePng);
  for (const [purpose, mime, bytes] of [['storefront.supply-material', 'image/webp', goodImage], ['storefront.supply-material-video', 'video/mp4', video],
    ['storefront.supply-material-video', 'video/webm', Buffer.from([0x1a, 0x45, 0xdf, 0xa3])]] as const) {
    const prepared = await prepareLegacyMediaRepresentation(stream(bytes), mime, purpose, policy);
    const key = objectKey({ scopeId: randomUUID(), assetId: randomUUID(), representationId: randomUUID() });
    await writeVerifiedObject(store, key, prepared, policy); assert((await store.head(key))?.metadata.profileId === purpose);
    const bad = purpose === 'storefront.supply-material' ? await sharp({ create: { width: 1921, height: 1, channels: 3, background: 'red' } }).webp().toBuffer() : Buffer.alloc(12);
    await assert.rejects(prepareLegacyMediaRepresentation(stream(bad), mime, purpose, policy), AssetStorageError);
    await assert.rejects(writeVerifiedObject(store, key, { bytes: bad, metadata: { ...prepared.metadata, byteSize: bad.length, sha256: await sha256(bad) } }, policy), AssetStorageError);
  }
  await assert.rejects(prepareLegacyMediaRepresentation(stream(photoSourcePng), 'image/png', 'storefront.supply-material', policy), AssetStorageError);
  await assert.rejects(prepareLegacyMediaRepresentation(stream(video), 'video/ogg', 'storefront.supply-material-video', policy), AssetStorageError);
});

test('MATERIAL-ASSET-05 engine admits exactly the two storefront tuples and rejects invalid variants, sizes, retirement and authority', () => {
  const fail = async (): Promise<never> => { throw Error('unexpected port'); };
  const base: LifecycleProfile<LifecyclePrepare, never, any, any> = { purpose: 'storefront.supply-material', targetKind: 'storefront.supply-material', variant: 'image',
    inputMaxBytes: 2097152, outputMaxBytes: 1048576, retireReplacedAsset: false, parsePrepare: value => value, targetId: () => '',
    lockTarget: fail, resolvePolicy: fail, requireCapacity: fail, prepareRepresentation: fail, lockPublication: fail, publish: fail };
  const authority = createStorefrontLifecycleAuthority(), dependencies = { store: new FakeObjectStore() };
  for (const p of [base, { ...base, purpose: 'storefront.supply-material-video', targetKind: 'storefront.supply-material-video', variant: 'video', inputMaxBytes: 20971520, outputMaxBytes: 20971520 } as typeof base]) {
    assert.doesNotThrow(() => createAssetLifecycleWithAuthority({} as Pool, dependencies, p, authority));
    for (const patch of [{ variant: 'draft' }, { inputMaxBytes: p.inputMaxBytes + 1 }, { outputMaxBytes: p.outputMaxBytes + 1 }, { retireReplacedAsset: true }, { targetKind: 'storefront.product-photo' }]) {
      assert.throws(() => createAssetLifecycleWithAuthority({} as Pool, dependencies, { ...p, ...patch } as typeof base, authority), problem(500, 'asset_profile_invalid'));
    }
    for (const wrong of [memberLifecycleAuthority, createTenantLifecycleAuthority(), { ...authority }]) {
      assert.throws(() => createAssetLifecycleWithAuthority({} as Pool, dependencies, p, wrong as any), problem(500, 'asset_authority_profile_invalid'));
    }
  }
});

test('MATERIAL-ASSET-06 both policy locks are required, revision is stable and every pinned policy input changes it', async () => {
  const tenant = { policy_id: randomUUID(), revision: '1', max_retained_bytes: '104857600' };
  const media = { mode: 'r2_only', policy_revision: 'synthetic-1', persistence_allowed: true, retained_byte_limit: '104857600' };
  const calls: string[] = [];
  const q = (t: unknown, m: unknown) => ({ async query(sql: string) { calls.push(sql); return { rows: sql.includes('FROM tenant_capacity_policies') ? (t ? [t] : []) : sql.includes('FROM domain_media_storage_policy') ? (m ? [m] : []) : [] }; } } as unknown as PoolClient);
  for (const purpose of ['storefront.supply-material', 'storefront.supply-material-video'] as const) {
    calls.length = 0; const first = await lockSupplyMaterialPolicy(q(tenant, media), 'synthetic-tenant', purpose);
    assert(calls[0].includes('pg_advisory_xact_lock')); assert(calls[1].includes('tenant_capacity_policies')); assert(calls[2].endsWith('FOR SHARE'));
    assert.equal(first.policy.revision, (await lockSupplyMaterialPolicy(q(tenant, media), 'synthetic-tenant', purpose)).policy.revision);
    for (const bad of [null, { ...media, mode: 'legacy' }, { ...media, mode: 'off' }, { ...media, persistence_allowed: false }, { ...media, policy_revision: null }, { ...media, retained_byte_limit: purpose.endsWith('-video') ? '20971519' : '1048575' }]) {
      await assert.rejects(lockSupplyMaterialPolicy(q(tenant, bad), 'synthetic-tenant', purpose), problem(503, 'material_upload_unavailable'));
    }
    await assert.rejects(lockSupplyMaterialPolicy(q(null, media), 'synthetic-tenant', purpose), problem(503, 'material_upload_unavailable'));
    for (const patch of [{ policy_id: randomUUID() }, { revision: '2' }, { max_retained_bytes: '209715200' }]) assert.notEqual(first.policy.revision, (await lockSupplyMaterialPolicy(q({ ...tenant, ...patch }, media), 'synthetic-tenant', purpose)).policy.revision);
    for (const patch of [{ policy_revision: 'synthetic-2' }, { retained_byte_limit: '209715200' }, { mode: 'bridge' }]) assert.notEqual(first.policy.revision, (await lockSupplyMaterialPolicy(q(tenant, { ...media, ...patch }), 'synthetic-tenant', purpose)).policy.revision);
  }
});

test('MATERIAL-ASSET-07 both capacity readers charge BOTH ready purposes, unfinished intents and purpose fallback reservations', async () => {
  const s = await f.openStore(), owner = { ...s.actor, tenant_id: s.tenantId, instance_id: s.instanceId }, assets = createSupplyMaterialLifecycle(f.runtime, { store: f.store });
  await f.h.pool.query("UPDATE tenant_capacity_policies SET max_retained_bytes=104857600 WHERE status='active'");
  await f.h.pool.query("UPDATE domain_media_storage_policy SET mode='r2_only',persistence_allowed=true,policy_revision='synthetic-capacity',retained_byte_limit=104857600 WHERE purpose IN ('storefront.supply-material','storefront.supply-material-video')");
  const material = async (kind: string) => {
    const id = randomUUID(); await f.h.pool.query(`INSERT INTO supply_materials(material_id,tenant_id,instance_id,scope_id,kind,title,created_by_principal_id)
      SELECT $1,$2,$3,scope_id,$4,'合成素材',$5 FROM resource_scopes WHERE tenant_ref=$2 AND kind='tenant'`, [id, s.tenantId, s.instanceId, kind, (await f.h.pool.query('SELECT principal_id FROM principals WHERE user_ref=$1', [s.owner.user.user_id])).rows[0].principal_id]); return id;
  };
  for (const kind of ['image', 'video'] as const) {
    const mime = kind === 'image' ? 'image/png' : 'video/mp4', bytes = kind === 'image' ? photoSourcePng : video;
    await uploadSupplyMaterialFile(f.runtime, s.actor, s.tenantId, s.instanceId, await material(kind), randomUUID(), '1', { bytes, mime }, assets, true);
    const api = await (kind === 'image' ? assets.forImage({ bytes, mime }) : assets.forVideo({ bytes, mime }));
    await api.prepare(owner, { key: randomUUID(), targetMaterialId: await material(kind), expectedVersion: '1', contentType: mime, byteSize: bytes.length, sha256: hash(bytes) });
    const source = (await f.h.pool.query('SELECT * FROM assets WHERE tenant_ref=$1 AND purpose=$2 LIMIT 1', [s.tenantId, kind === 'image' ? 'storefront.supply-material' : 'storefront.supply-material-video'])).rows[0];
    await f.h.pool.query(`INSERT INTO assets(asset_id,scope_id,owner_principal_id,owner_user_id,policy_revision,representation_id,purpose,scope_kind,tenant_ref,write_effect_coverage)
      VALUES($1,$2,$3,$4,$5,$6,$7,'tenant',$8,true)`, [randomUUID(), source.scope_id, source.owner_principal_id, source.owner_user_id, source.policy_revision, randomUUID(), source.purpose, s.tenantId]);
  }
  const used = Number((await f.h.pool.query("SELECT sum(byte_size) n FROM asset_objects WHERE purpose IN ('storefront.supply-material','storefront.supply-material-video')")).rows[0].n);
  await withTenantRead(f.runtime, { actor: s.actor, tenantId: s.tenantId, capabilitiesForRole: storeCapabilities }, async (q, context) => {
    assert.equal(await retainedByteUsage(q, context.scope.scope_id, s.tenantId), BigInt(used + 2 * (1048576 + 20971520)));
    const summary = await capacitySummary(q, context.scope.scope_id, s.tenantId);
    assert.equal(summary.used, String(used)); assert.equal(summary.reserved, String(2 * (1048576 + 20971520)));
  });
});

test('MATERIAL-ASSET-08 locked targets refuse missing, withdrawn, mismatched kinds and the 100-version ceiling', async () => {
  const materialId = randomUUID(), context = { tenant_id: randomUUID() } as any, actor = { instance_id: randomUUID() } as any;
  const row = { material_id: materialId, kind: 'image', state: 'active', version: '1' };
  const q = (r: unknown, n: number) => ({ async query(sql: string) { return { rows: sql.includes('FROM supply_materials') ? (r ? [r] : []) : [{ n }] }; } } as unknown as PoolClient);
  await assert.rejects(lockSupplyMaterialTarget(q(null, 0), context, actor, materialId, 'storefront.supply-material'), problem(404, 'not_found'));
  await assert.rejects(lockSupplyMaterialTarget(q({ ...row, state: 'withdrawn' }, 0), context, actor, materialId, 'storefront.supply-material'), problem(409, 'material_withdrawn'));
  await assert.rejects(lockSupplyMaterialTarget(q(row, 0), context, actor, materialId, 'storefront.supply-material-video'), problem(409, 'material_kind_mismatch'));
  await assert.rejects(lockSupplyMaterialTarget(q(row, 100), context, actor, materialId, 'storefront.supply-material'), problem(409, 'material_version_limit'));
});
