import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { createAssetLifecycleWithAuthority, type LifecycleProfile, type LifecyclePrepare } from '../../modules/assets/engine.js';
import { memberLifecycleAuthority } from '../../modules/assets/lifecycle-authority.js';
import { createTenantLifecycleAuthority } from '../../modules/assets/tenant-lifecycle-authority.js';
import { createStorefrontLifecycleAuthority } from '../../modules/assets/storefront-lifecycle-authority.js';
import { assertProductPhotoSource, normalizeProductPhoto, lockProductPhotoPolicy } from '../../modules/assets/storefront-product-photo.js';
import { runWithImageProcessor, createUnavailableImageProcessor } from '../../packages/shared/image-runtime.js';
import { FakeObjectStore } from '../../packages/asset-storage/fake-store.js';
import { prepareLegacyMediaRepresentation, validateMetadata, writeVerifiedObject, objectKey, sha256, AssetStorageError, type ObjectMetadata } from '../../packages/asset-storage/index.js';
import { Problem } from '../../packages/shared/problem.js';

// Container fixture only; no test below labels this a native decoded pixel stream.
function container(width = 1, height = 1): Buffer {
  const b = Buffer.alloc(26); b.write('RIFF'); b.writeUInt32LE(18, 4); b.write('WEBP', 8);
  b.write('VP8L', 12); b.writeUInt32LE(5, 16); b[20] = 0x2f; b.writeUInt32LE((width - 1) | ((height - 1) << 14), 21); return b;
}
const stream = (bytes: Uint8Array) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
const policy = { revision: 'photo-synthetic-policy', platformPersistenceAllowed: true };
const sourcePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jIioAAAAASUVORK5CYII=', 'base64');

test('PHOTO-CORE-01 storefront profile rejects member, Work and copied authority before any port executes', () => {
  let touched = false; const fail = async () => { touched = true; throw Error('unexpected port'); };
  const photo: LifecycleProfile<LifecyclePrepare, never, any, any> = {
    purpose: 'storefront.product-photo', targetKind: 'storefront.product-photo', variant: 'image', inputMaxBytes: 2097152,
    outputMaxBytes: 1048576, retireReplacedAsset: false, parsePrepare: value => value, targetId: () => '',
    lockTarget: fail, resolvePolicy: fail, requireCapacity: fail, prepareRepresentation: fail, lockPublication: fail, publish: fail,
  };
  const authority = createStorefrontLifecycleAuthority();
  for (const wrong of [memberLifecycleAuthority, createTenantLifecycleAuthority(), { ...authority }]) {
    assert.throws(() => createAssetLifecycleWithAuthority({} as Pool, { store: new FakeObjectStore() }, photo, wrong as any),
      (e: unknown) => e instanceof Problem && e.code === 'asset_authority_profile_invalid');
  }
  assert.doesNotThrow(() => createAssetLifecycleWithAuthority({} as Pool, { store: new FakeObjectStore() }, photo, authority));
  assert.throws(() => createAssetLifecycleWithAuthority({} as Pool, { store: new FakeObjectStore() }, { ...photo, retireReplacedAsset: true }, authority),
    (e: unknown) => e instanceof Problem && e.code === 'asset_profile_invalid');
  assert.throws(() => createAssetLifecycleWithAuthority({} as Pool, { store: new FakeObjectStore() }, {
    ...photo, purpose: 'work.tenant-result', targetKind: 'work.tenant-result', variant: 'draft', inputMaxBytes: 262144, outputMaxBytes: 262144,
  }, authority), (e: unknown) => e instanceof Problem && e.code === 'asset_authority_profile_invalid');
  assert.equal(touched, false);
});

test('PHOTO-CORE-02 MIME/trailing markup/truncation refuse before decoder; unavailable never returns raw input', async () => {
  let calls = 0;
  await runWithImageProcessor({ name: 'controlled-unused', async normalize() { calls++; return container(); } }, async () => {
    for (const [mime, bytes] of [['image/png', Buffer.from('<svg><script/></svg>')], ['image/jpeg', sourcePng],
      ['image/png', sourcePng.subarray(0, -1)], ['image/png', Buffer.concat([sourcePng, Buffer.from('<script/>')])]] as const) {
      await assert.rejects(normalizeProductPhoto(mime, bytes), (e: unknown) => e instanceof Problem && e.code === 'invalid_product_photo');
    }
  });
  assert.equal(calls, 0);
  assert.equal(assertProductPhotoSource('image/png', sourcePng), 'png');
  await runWithImageProcessor(createUnavailableImageProcessor(), async () => {
    await assert.rejects(normalizeProductPhoto('image/png', sourcePng), (e: unknown) => e instanceof Problem && e.status === 503);
  });
});

test('PHOTO-CORE-03 controlled processor receives independent bytes and bounded no-upscale spec; oversized output rejected', async () => {
  const original = Buffer.from(sourcePng);
  await runWithImageProcessor({ name: 'controlled-shape', async normalize(bytes, spec) {
    assert.equal(spec.purpose, 'storefront_product_photo'); assert.equal(spec.maxPixels, 16777216);
    assert.deepEqual(spec.output, { width: 1920, height: 1920, fit: 'inside', quality: 80, effort: 4 });
    bytes.fill(0); return container(1920, 1920);
  } }, async () => assert.equal((await normalizeProductPhoto('image/png', original)).length, 26));
  assert.deepEqual(original, sourcePng);
  await runWithImageProcessor({ name: 'controlled-oversized', async normalize() { return container(1921, 1); } }, async () => {
    await assert.rejects(normalizeProductPhoto('image/png', sourcePng), (e: unknown) => e instanceof Problem && e.status === 422);
  });
});

test('PHOTO-CORE-04 storage profile rejects legacy transforms, metadata-bearing or over-dimension containers before PUT', async () => {
  const bytes = container(), value = await prepareLegacyMediaRepresentation(stream(bytes), 'image/webp', 'storefront.product-photo', policy);
  validateMetadata(value.metadata);
  for (const extra of [{ transformVersion: 'member.message-image.webp.v1' }, { contentType: 'image/png' }, { byteSize: 1048577 }, { pixel_width: 1 }]) {
    assert.throws(() => validateMetadata({ ...value.metadata, ...extra } as ObjectMetadata), AssetStorageError);
  }
  let puts = 0; const store = new FakeObjectStore(); const actualPut = store.putImmutable.bind(store);
  store.putImmutable = async (...args) => { puts++; return actualPut(...args); };
  const key = objectKey({ scopeId: '10000000-0000-4000-8000-000000000001', assetId: '10000000-0000-4000-8000-000000000002', representationId: '10000000-0000-4000-8000-000000000003' });
  const bad = container(1921, 1);
  await assert.rejects(writeVerifiedObject(store, key, { bytes: bad, metadata: { ...value.metadata, sha256: await sha256(bad) } }, policy), AssetStorageError);
  assert.equal(puts, 0);
  await writeVerifiedObject(store, key, value, policy); assert.equal(puts, 1);
});

test('PHOTO-CORE-05 both current policies required, lock order fixed, any tenant/media revision changes pinned digest', async () => {
  const tenant = { policy_id: '10000000-0000-4000-8000-000000000001', revision: '1', max_retained_bytes: '2097152' };
  const media = { mode: 'r2_only', policy_revision: 'reviewed-photo-1', persistence_allowed: true, retained_byte_limit: '1048576' };
  const calls: string[] = [];
  const q = (t: unknown, m: unknown) => ({ async query(sql: string) {
    calls.push(sql); return { rows: sql.includes('FROM tenant_capacity_policies') ? (t ? [t] : []) : sql.includes('FROM domain_media_storage_policy') ? (m ? [m] : []) : [] };
  } } as unknown as PoolClient);
  const first = await lockProductPhotoPolicy(q(tenant, media), 'tenant-test');
  assert(calls[0].includes('pg_advisory_xact_lock')); assert(calls[1].includes('tenant_capacity_policies')); assert(calls[2].includes('domain_media_storage_policy'));
  for (const [t, m] of [[null, media], [tenant, null], [tenant, { ...media, mode: 'legacy' }], [tenant, { ...media, persistence_allowed: false }], [tenant, { ...media, retained_byte_limit: '1048575' }]]) {
    await assert.rejects(lockProductPhotoPolicy(q(t, m), 'tenant-test'), (e: unknown) => e instanceof Problem && e.status === 503);
  }
  assert.notEqual(first.policy.revision, (await lockProductPhotoPolicy(q({ ...tenant, revision: '2' }, media), 'tenant-test')).policy.revision);
  assert.notEqual(first.policy.revision, (await lockProductPhotoPolicy(q(tenant, { ...media, policy_revision: 'reviewed-photo-2' }), 'tenant-test')).policy.revision);
});
