import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  HOSTED_STORE_MEDIA_PROFILE as profile, ProductMediaViewSchema, ProductPhotoMetadataSchema,
  PublicStoreMediaSchema, RemoveProductPhotoInputSchema,
} from '../../contracts/guild-launchpad/v1/hosted-store-media.js';
import { PublicStoreProjectionSchema } from '../../contracts/guild-launchpad/v1/storefront.js';
import {
  PRODUCT_PHOTO_POLICY, EMPTY_PUBLICATION_MEDIA_SHA256, publicationMediaSnapshot,
  privateProductPhotoPath, publicProductPhotoPath, projectPrivateProductMedia,
  projectPublicStoreMedia, publicStoreMediaRenderProducts,
} from '../../modules/agent-commerce/hosted/media.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const binding = { tenant_id: id(1), instance_id: id(2), product_id: id(3), version: '12' };
const metadata = { content_type: 'image/webp', byte_size: 1234, width: 640, height: 480 };
const ref = { ...metadata, sku: 'P0001', asset_id: id(4), representation_id: id(5), sha256: 'a'.repeat(64),
  purpose: PRODUCT_PHOTO_POLICY.purpose, transform_version: PRODUCT_PHOTO_POLICY.transform_version };
const manifest = { profile, photos: [ref] };
const projection = { slug: 'test-store', name: 'Shop', brand: null, description: 'Draft', currency: 'TWD',
  products: [{ sku: 'P0002', title: 'Two', description: '', price_minor: 200 }, { sku: 'P0001', title: 'One', description: '', price_minor: 100 }],
  revision: '7', published_at: '2026-10-09T00:00:00.000Z', transaction_state: 'not_enabled' };

test('closed metadata and product DTOs never accept borrowed URLs, storage locators or trusted flags', () => {
  assert.equal(PRODUCT_PHOTO_POLICY.uploads_enabled, false);
  assert.ok(Object.isFrozen(PRODUCT_PHOTO_POLICY));
  assert.ok(Object.isFrozen(PRODUCT_PHOTO_POLICY.input_content_types));
  assert.equal(projectPrivateProductMedia(binding, null).photo, null);
  const view = projectPrivateProductMedia(binding, metadata);
  assert.equal(view.version, binding.version);
  assert.equal(view.product_id, binding.product_id);
  for (const key of ['photo_url', 'externalURL', 'object_key', 'bucket', 'asset_id', 'trusted_normalized', 'cost_minor']) {
    assert.equal(ProductPhotoMetadataSchema.safeParse({ ...metadata, [key]: 'untrusted' }).success, false);
    assert.equal(ProductMediaViewSchema.safeParse({ ...view, [key]: 'untrusted' }).success, false);
    assert.equal(RemoveProductPhotoInputSchema.safeParse({ [key]: 'untrusted' }).success, false);
  }
  for (const bad of [{ content_type: 'image/svg+xml' }, { content_type: 'image/png' }, { width: 1921 }, { height: 0 }, { byte_size: 1048577 }, { byte_size: 0 }, { width: 1.5 }]) {
    assert.equal(ProductPhotoMetadataSchema.safeParse({ ...metadata, ...bad }).success, false);
  }
  assert.equal(PublicStoreProjectionSchema.safeParse({ ...projection, media: view }).success, false);
  assert.equal(PublicStoreProjectionSchema.safeParse({ ...projection, products: [{ ...projection.products[0], photo: view.photo }] }).success, false);
});

test('paths preserve exact IDs and bounded versions and reject external, injected or mismatched paths', () => {
  const view = projectPrivateProductMedia(binding, metadata);
  assert.equal(view.photo?.read_path, privateProductPhotoPath(binding));
  assert.notEqual(privateProductPhotoPath({ ...binding, version: '13' }), view.photo?.read_path);
  for (const read_path of ['https://other.test/image.webp', '//other.test/image.webp', '/shops/test-store/media/7/P0001',
    privateProductPhotoPath({ ...binding, product_id: id(8) }), privateProductPhotoPath({ ...binding, version: '13' }),
    `${view.photo!.read_path}?asset_id=${id(4)}`, `${view.photo!.read_path}\n`]) {
    assert.equal(ProductMediaViewSchema.safeParse({ ...view, photo: { ...view.photo, read_path } }).success, false);
  }
  for (const version of ['0', '01', '-1', '9223372036854775808', '1\n', '1/../2']) {
    assert.throws(() => privateProductPhotoPath({ ...binding, version }));
    assert.throws(() => publicProductPhotoPath('test-store', version, 'P0001'));
  }
  for (const slug of ['//evil', 'test-store?next=evil', 'Test-store', 'test-store\n']) assert.throws(() => publicProductPhotoPath(slug, '1', 'P0001'));
  for (const sku of ['P0001/../../evil', 'P0001" onerror="x', 'P0001\n']) assert.throws(() => publicProductPhotoPath('test-store', '1', sku));
  assert.equal(publicProductPhotoPath('test-store', '9223372036854775807', 'P0001'), '/shops/test-store/media/9223372036854775807/P0001');
});

test('publication snapshot has deterministic independent digest and cannot follow later draft mutation', () => {
  const input = { profile, photos: [{ ...ref }, { ...ref, sku: 'P0002', asset_id: id(8) }] };
  const snapshot = publicationMediaSnapshot(input);
  assert.equal(snapshot.sha256, publicationMediaSnapshot({ profile, photos: [...input.photos].reverse() }).sha256);
  assert.equal(snapshot.sha256, createHash('sha256').update(snapshot.bytes).digest('hex'));
  assert.ok(Object.isFrozen(snapshot)); assert.ok(Object.isFrozen(snapshot.manifest));
  assert.ok(Object.isFrozen(snapshot.manifest.photos)); assert.ok(Object.isFrozen(snapshot.manifest.photos[0]));
  input.photos[0].sha256 = 'b'.repeat(64); input.photos.pop();
  assert.equal(snapshot.manifest.photos[0].sha256, 'a'.repeat(64));
  assert.equal(snapshot.manifest.photos.length, 2);
  const original = publicationMediaSnapshot(manifest);
  for (const change of [{ sha256: 'b'.repeat(64) }, { asset_id: id(9) }, { representation_id: id(9) }, { width: 639 }, { height: 479 }, { byte_size: 1235 }, { sku: 'P0002' }]) {
    assert.notEqual(original.sha256, publicationMediaSnapshot({ profile, photos: [{ ...ref, ...change }] }).sha256);
  }
  assert.notEqual(original.sha256, EMPTY_PUBLICATION_MEDIA_SHA256);
  assert.equal(EMPTY_PUBLICATION_MEDIA_SHA256, publicationMediaSnapshot({ profile, photos: [] }).sha256);
  for (const bad of [{ ...manifest, projection_sha256: 'a'.repeat(64) }, { profile, photos: [ref, ref] },
    { profile, photos: [{ ...ref, purpose: 'work.tenant-result' }] }, { profile, photos: [{ ...ref, purpose: 'member.message-image' }] },
    { profile, photos: [{ ...ref, object_key: 'private' }] }, { profile, photos: [{ ...ref, sha256: 'A'.repeat(64) }] }]) {
    assert.throws(() => publicationMediaSnapshot(bad));
  }
});

test('public mapping is publication-bound, strips Asset identity and keeps existing product order and prices', () => {
  const snapshot = publicationMediaSnapshot(manifest);
  const media = projectPublicStoreMedia(projection, snapshot.manifest, snapshot.sha256);
  assert.equal(media.photos[0].photo.read_path, '/shops/test-store/media/7/P0001');
  const serialized = JSON.stringify(media);
  for (const secret of ['asset_id', 'representation_id', 'purpose', 'sha256', 'transform_version', 'product_id', 'tenant_id', 'instance_id', id(4), id(5)]) assert.equal(serialized.includes(secret), false);
  assert.throws(() => projectPublicStoreMedia(projection, snapshot.manifest, 'f'.repeat(64)), /digest_mismatch/);
  assert.throws(() => projectPublicStoreMedia({ ...projection, products: [projection.products[0]] }, snapshot.manifest, snapshot.sha256), /product_missing/);
  assert.throws(() => projectPublicStoreMedia({ ...projection, products: [projection.products[1], projection.products[1]] }, snapshot.manifest, snapshot.sha256), /sku_duplicate/);
  const changedRevision = projectPublicStoreMedia({ ...projection, revision: '8' }, snapshot.manifest, snapshot.sha256);
  assert.equal(changedRevision.photos[0].photo.read_path, '/shops/test-store/media/8/P0001');
  assert.equal(media.photos[0].photo.read_path, '/shops/test-store/media/7/P0001');
  assert.equal(PublicStoreMediaSchema.safeParse({ ...media, revision: '8' }).success, false);
  assert.equal(PublicStoreMediaSchema.safeParse({ ...media, photos: [...media.photos, ...media.photos] }).success, false);
  const rendered = publicStoreMediaRenderProducts(projection, snapshot.manifest, snapshot.sha256);
  assert.deepEqual(rendered.map(({ photo: _photo, ...product }) => product), projection.products);
  assert.equal(rendered[0].photo, null); assert.deepEqual(rendered[1].photo, media.photos[0].photo);
  assert.ok(publicStoreMediaRenderProducts(projection, { profile, photos: [] }, EMPTY_PUBLICATION_MEDIA_SHA256).every(product => product.photo === null));
});
