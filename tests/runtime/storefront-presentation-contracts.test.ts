import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StoreAppearanceInputSchema } from '../../contracts/guild-launchpad/v1/storefront-presentation.js';
import { PublicStoreProjectionSchema } from '../../contracts/guild-launchpad/v1/storefront.js';
import { storeHtml } from '../../modules/agent-commerce/hosted/page.js';
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
