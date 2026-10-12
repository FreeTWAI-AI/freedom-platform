import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StoreAppearanceInputSchema } from '../../contracts/guild-launchpad/v1/storefront-presentation.js';
import { PublicStoreProjectionSchema } from '../../contracts/guild-launchpad/v1/storefront.js';
import { storeHtml, productHtml, storeMissingHtml } from '../../modules/agent-commerce/hosted/page.js';
import { projectionDigest } from '../../modules/agent-commerce/hosted/publish.js';

const content = { slug: 'safe-store', name: '<script>shop</script>', brand: null, description: '<img src=x onerror=bad()>', currency: 'TWD',
  products: [{ sku: 'P0001', title: 'One', description: 'plain', price_minor: 123 }, { sku: 'P0002', title: 'Two', description: 'long\ntext', price_minor: 456 }],
  revision: '1', published_at: '2026-10-09T00:00:00.000Z', transaction_state: 'not_enabled' };
test('presentation is a closed extension, not an expansion of the pinned v1 public DTO', () => {
  for (const template_id of ['catalog-grid-v1', 'catalog-list-v1']) assert.ok(StoreAppearanceInputSchema.safeParse({template_id}).success);
  for (const raw of [{template_id: 'master-store'}, {template_id: 'catalog-list-v1', contact: 'private'}, {template_id: '<script>'}, {}]) assert.equal(StoreAppearanceInputSchema.safeParse(raw).success, false);
  assert.ok(PublicStoreProjectionSchema.safeParse(content).success);
  assert.equal(PublicStoreProjectionSchema.safeParse({...content, template_id: 'catalog-list-v1'}).success, false);
  assert.equal(PublicStoreProjectionSchema.safeParse({...content, supplier_price: 100}).success, false);
});
test('default remains the exact grid, while both layouts escape all content and retain all products without checkout', () => {
  const projection = PublicStoreProjectionSchema.parse(content);
  assert.equal(storeHtml(projection), storeHtml(projection, 'catalog-grid-v1'));
  for (const template of ['catalog-grid-v1', 'catalog-list-v1'] as const) {
    const html = storeHtml(projection, template);
    assert.equal((html.match(/<article>/g) ?? []).length, 2);
    assert.match(html, /One/); assert.match(html, /Two/);
    assert.match(html, /&lt;script&gt;/); assert.match(html, /&lt;img/);
    assert.doesNotMatch(html, /<script|onerror="|<form|<button|checkout/);
    assert.equal(html.includes('shop-products-list'), template === 'catalog-list-v1');
  }
});
test('presentation does not redefine the existing publication content digest', () => {
  const projection = PublicStoreProjectionSchema.parse(content);
  assert.equal(projectionDigest(projection), projectionDigest({...projection, revision: '2', published_at: '2026-10-10T00:00:00.000Z'}));
  assert.notEqual(projectionDigest(projection), projectionDigest({...projection, name: 'changed content'}));
});

test('published share metadata uses the configured origin and current public images, never private preview media', () => {
  const projection = PublicStoreProjectionSchema.parse(content);
  const metadata = {content_type: 'image/webp', byte_size: 400, width: 800, height: 600};
  const publicPhoto = {...metadata, read_path: '/shops/safe-store/media/1/P0001'};
  const privatePhoto = {...metadata, read_path: '/api/v1/tenants/11111111-1111-4111-8111-111111111111/storefronts/22222222-2222-4222-8222-222222222222/products/33333333-3333-4333-8333-333333333333/photo/1'};
  const publicOptions = {publicOrigin: 'https://public.example.test'};
  const html = productHtml(projection, 'P0001', [{sku: 'P0001', photo: publicPhoto}], publicOptions)!;
  assert.match(html, /property="og:image" content="https:\/\/public.example.test\/shops\/safe-store\/media\/1\/P0001"/);
  assert.match(html, /rel="canonical" href="https:\/\/public.example.test\/shops\/safe-store\/products\/P0001"/);
  assert.match(html, /property="og:title" content="One｜&lt;script&gt;shop&lt;\/script&gt;"/);
  assert.match(html, /href="\/#reservations\/safe-store\/product\/P0001"/);
  assert.match(html, /name="robots" content="noindex"/);
  assert.doesNotMatch(html, /<script|<form|<button|onerror="/);
  for (const photo of [privatePhoto, {...publicPhoto, read_path: '/shops/safe-store/media/2/P0001'}, {...publicPhoto, read_path: '/shops/other-shop/media/1/P0001'}]) {
    assert.throws(() => productHtml(projection, 'P0001', [{sku: 'P0001', photo}], publicOptions), /storefront_public_photo_required/);
  }
  const preview = storeHtml(projection, 'catalog-grid-v1', [{sku: 'P0001', photo: privatePhoto}], {preview: true});
  assert.match(preview, /這是未發布的預覽/); assert.match(preview, /預覽完整商品內容/);
  assert.doesNotMatch(preview, /property="og:|rel="canonical"|href="\/shops\/safe-store\/products\//);
  assert.equal(productHtml(projection, 'P9999', [], publicOptions), null);
  assert.equal(productHtml(projection, 'P0001\n', [], publicOptions), null);
  assert.doesNotMatch(storeMissingHtml(true), /property="og:|rel="canonical"/);
  for (const publicOrigin of ['javascript:alert(1)', 'https://user:pass@example.test', 'https://example.test/path', 'https://example.test/?host=other.test']) {
    assert.throws(() => storeHtml(projection, 'catalog-grid-v1', [], {publicOrigin}), /storefront_public_origin_invalid/);
  }
});
