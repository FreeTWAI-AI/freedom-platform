import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { PublicStoreProjection } from '../../contracts/guild-launchpad/v1/storefront.js';
import { productHtml, storeHtml, storeMissingHtml } from '../../modules/agent-commerce/hosted/page.js';

const V1_SYNTHETIC_PROJECTION: PublicStoreProjection = {
  slug: 'synthetic-tea-shop',
  name: '山邊合成茶鋪',
  brand: 'Mountain Synthetic',
  description: '第一段合成商店介紹。\n第二段合成商店說明。',
  currency: 'TWD',
  revision: '3',
  transaction_state: 'not_enabled',
  products: [
    {
      sku: 'P0001',
      title: `手作茶杯 <b>&"'`,
      description: '杯口手工成形。\n適合日常飲茶。',
      price_minor: 35000,
    },
    {
      sku: 'P0002',
      title: '亞麻茶席巾',
      description: '自然亞麻織紋。',
      price_minor: 12050,
    },
  ],
};

const V1_PUBLIC_ORIGIN = { publicOrigin: 'https://shop.example.test/' } as const;

const V1_PINNED_SHA256 = {
  gridDefault: 'e4632c75738352ee8ef2be7b6a545a159ff16a7d749df304025ef2fa47e2a9cd',
  gridOrigin: '84e1677603b9639d81d47be0e5a79ab7a7f40b9ce1d4fa1b3c4061a919430692',
  gridPreview: 'ac59754059828ceec03cb7e0ef698da637a1d54a43bf7add560334875df56807',
  listDefault: 'e7bedbcc611309f4f973f6a83b111a15bf3915536938d89ff3078524a0ee0410',
  listOrigin: '42359680c955f14aa7d48719a1b2be8faee4a17474f578a9f0361741471c33e4',
  listPreview: '3afbc107234a93b40f29cf4cfdd175179ab40b83bca82da6b1e1be5e0ee83181',
  product1Default: '8d5234fdff1a2c91482b853527df1cd26114d0b8c592e421261edd382704fd2f',
  product1Origin: '2fd1eee6b2d9e20e92ef043b2c13c51818ffe6c9833d2380bb202340192cf699',
  product2Default: '5923e0b9e9c823463e66403d22da965382390e4c616cdd590c39a4f648703062',
  product2Origin: 'ad38b02cca7877d1b57cbc3aea2d613fb66d19d4ed43a07aa83f77edc19a85cc',
  missingStore: '5fafd27a9f9b2e25e9d060e4009528265763ce8b9a4f1b37edd1275f180f5905',
  missingProduct: '5ded05ead3b2a30f84c4a7353f83f57a1b28f252b4b4c04cb30bff53144ee53d',
} as const;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

test('v1 storefront renderer bytes stay byte-identical across templates, publicOrigin, preview and missing pages', () => {
  assert.equal(sha256(storeHtml(V1_SYNTHETIC_PROJECTION, 'catalog-grid-v1')), V1_PINNED_SHA256.gridDefault);
  assert.equal(
    sha256(storeHtml(V1_SYNTHETIC_PROJECTION, 'catalog-grid-v1', [], V1_PUBLIC_ORIGIN)),
    V1_PINNED_SHA256.gridOrigin,
  );
  assert.equal(
    sha256(storeHtml(V1_SYNTHETIC_PROJECTION, 'catalog-grid-v1', [], { preview: true })),
    V1_PINNED_SHA256.gridPreview,
  );

  assert.equal(sha256(storeHtml(V1_SYNTHETIC_PROJECTION, 'catalog-list-v1')), V1_PINNED_SHA256.listDefault);
  assert.equal(
    sha256(storeHtml(V1_SYNTHETIC_PROJECTION, 'catalog-list-v1', [], V1_PUBLIC_ORIGIN)),
    V1_PINNED_SHA256.listOrigin,
  );
  assert.equal(
    sha256(storeHtml(V1_SYNTHETIC_PROJECTION, 'catalog-list-v1', [], { preview: true })),
    V1_PINNED_SHA256.listPreview,
  );

  assert.equal(sha256(productHtml(V1_SYNTHETIC_PROJECTION, 'P0001') ?? ''), V1_PINNED_SHA256.product1Default);
  assert.equal(
    sha256(productHtml(V1_SYNTHETIC_PROJECTION, 'P0001', [], V1_PUBLIC_ORIGIN) ?? ''),
    V1_PINNED_SHA256.product1Origin,
  );
  assert.equal(sha256(productHtml(V1_SYNTHETIC_PROJECTION, 'P0002') ?? ''), V1_PINNED_SHA256.product2Default);
  assert.equal(
    sha256(productHtml(V1_SYNTHETIC_PROJECTION, 'P0002', [], V1_PUBLIC_ORIGIN) ?? ''),
    V1_PINNED_SHA256.product2Origin,
  );

  assert.equal(sha256(storeMissingHtml()), V1_PINNED_SHA256.missingStore);
  assert.equal(sha256(storeMissingHtml(true)), V1_PINNED_SHA256.missingProduct);
});
