import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { createApp } from '../../apps/platform-api/src/app.js';
import type { PublicStoreProjection } from '../../contracts/guild-launchpad/v1/storefront.js';
import { productHtml, storeHtml, storeMissingHtml } from '../../modules/agent-commerce/hosted/page.js';
import { cartPageHtml, checkoutPageHtml } from '../../modules/agent-commerce/storefront/pages.js';
import { checkoutHarness, ok, ports, type CheckoutHarness } from './hosted-checkout-harness.js';
import { TENANT_CURSOR_TEST_KEY } from './tenant-cursor-fixture.js';

const V1_SYNTHETIC_PROJECTION: PublicStoreProjection = {
  slug: 'synthetic-tea-shop',
  name: '山邊合成茶鋪',
  brand: 'Mountain Synthetic',
  description: '第一段合成商店介紹。\n第二段合成商店說明。',
  currency: 'TWD',
  revision: '3',
  published_at: '2026-10-15T12:00:00.000Z',
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

let x: CheckoutHarness;

async function tableCounts() {
  return (
    await x.h.pool.query<{
      checkouts: number;
      orders: number;
      reservations: number;
      budgets: number;
    }>(
      `SELECT
        (SELECT count(*)::int FROM commerce_checkouts) AS checkouts,
        (SELECT count(*)::int FROM commerce_orders) AS orders,
        (SELECT count(*)::int FROM commerce_inventory_reservations) AS reservations,
        (SELECT count(*)::int FROM auth_rate_limits) AS budgets`,
    )
  ).rows[0];
}

function makeApp(options: {
  checkoutEnabled: boolean;
  quarantine?: boolean;
  admitted?: boolean;
}) {
  return createApp(x.runtime, x.h.origin, 'local', {
    guildLaunchpadEnabled: true,
    hostedReservationsEnabled: true,
    tenantCursorSigningKey: TENANT_CURSOR_TEST_KEY,
    commerceSettings: {
      checkoutEnabled: options.checkoutEnabled,
      consoleEnabled: true,
      quarantine: options.quarantine ?? false,
      providerProfiles: [],
    },
    commercePorts: {
      admission: { allowed: () => options.admitted ?? true },
      shipping: ports.shipping,
    },
  });
}

before(async () => {
  x = await checkoutHarness('fc_storefront_cart');
});

beforeEach(async () => {
  await x.reset();
});

after(async () => {
  await x?.stop();
});

test('v1 storefront renderer bytes stay byte-identical across templates, publicOrigin, preview, explicit {open: false} and missing pages', () => {
  assert.equal(sha256(storeHtml(V1_SYNTHETIC_PROJECTION, 'catalog-grid-v1')), V1_PINNED_SHA256.gridDefault);
  assert.equal(
    sha256(storeHtml(V1_SYNTHETIC_PROJECTION, 'catalog-grid-v1', [], undefined, { open: false })),
    V1_PINNED_SHA256.gridDefault,
  );
  assert.equal(
    sha256(storeHtml(V1_SYNTHETIC_PROJECTION, 'catalog-grid-v1', [], V1_PUBLIC_ORIGIN)),
    V1_PINNED_SHA256.gridOrigin,
  );
  assert.equal(
    sha256(storeHtml(V1_SYNTHETIC_PROJECTION, 'catalog-grid-v1', [], V1_PUBLIC_ORIGIN, { open: false })),
    V1_PINNED_SHA256.gridOrigin,
  );
  assert.equal(
    sha256(storeHtml(V1_SYNTHETIC_PROJECTION, 'catalog-grid-v1', [], { preview: true })),
    V1_PINNED_SHA256.gridPreview,
  );
  assert.equal(
    sha256(storeHtml(V1_SYNTHETIC_PROJECTION, 'catalog-grid-v1', [], { preview: true }, { open: true })),
    V1_PINNED_SHA256.gridPreview,
  );

  assert.equal(sha256(storeHtml(V1_SYNTHETIC_PROJECTION, 'catalog-list-v1')), V1_PINNED_SHA256.listDefault);
  assert.equal(
    sha256(storeHtml(V1_SYNTHETIC_PROJECTION, 'catalog-list-v1', [], undefined, { open: false })),
    V1_PINNED_SHA256.listDefault,
  );
  assert.equal(
    sha256(storeHtml(V1_SYNTHETIC_PROJECTION, 'catalog-list-v1', [], V1_PUBLIC_ORIGIN)),
    V1_PINNED_SHA256.listOrigin,
  );
  assert.equal(
    sha256(storeHtml(V1_SYNTHETIC_PROJECTION, 'catalog-list-v1', [], V1_PUBLIC_ORIGIN, { open: false })),
    V1_PINNED_SHA256.listOrigin,
  );
  assert.equal(
    sha256(storeHtml(V1_SYNTHETIC_PROJECTION, 'catalog-list-v1', [], { preview: true })),
    V1_PINNED_SHA256.listPreview,
  );
  assert.equal(
    sha256(storeHtml(V1_SYNTHETIC_PROJECTION, 'catalog-list-v1', [], { preview: true }, { open: true })),
    V1_PINNED_SHA256.listPreview,
  );

  assert.equal(sha256(productHtml(V1_SYNTHETIC_PROJECTION, 'P0001') ?? ''), V1_PINNED_SHA256.product1Default);
  assert.equal(
    sha256(productHtml(V1_SYNTHETIC_PROJECTION, 'P0001', [], undefined, { open: false }) ?? ''),
    V1_PINNED_SHA256.product1Default,
  );
  assert.equal(
    sha256(productHtml(V1_SYNTHETIC_PROJECTION, 'P0001', [], V1_PUBLIC_ORIGIN) ?? ''),
    V1_PINNED_SHA256.product1Origin,
  );
  assert.equal(
    sha256(productHtml(V1_SYNTHETIC_PROJECTION, 'P0001', [], V1_PUBLIC_ORIGIN, { open: false }) ?? ''),
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

test('B01 and B03 serve open variants only when checkout is open, and keep v1 bytes when closed, quarantined or unadmitted', async () => {
  const s = await x.store(5);
  const soldOut = await x.store(0);
  const openApp = makeApp({ checkoutEnabled: true });
  const quarantinedApp = makeApp({ checkoutEnabled: true, quarantine: true });
  const unadmittedApp = makeApp({ checkoutEnabled: true, admitted: false });
  const before = await tableCounts();

  const closedStoreHtml = await (await x.app.request(`${x.h.origin}/shops/${s.slug}`)).text();
  const closedProductHtml = await (
    await x.app.request(`${x.h.origin}/shops/${s.slug}/products/${s.product.sku}`)
  ).text();
  assert.equal(closedStoreHtml.includes('<script'), false);
  assert.ok(closedStoreHtml.includes('<span>會員的商品與商店</span>'));
  assert.ok(closedStoreHtml.includes('登入查看預留狀態'));
  assert.ok(closedStoreHtml.includes('查詢我的預留'));
  assert.equal(closedProductHtml.includes('<script'), false);
  assert.ok(closedProductHtml.includes('登入確認預留條件'));
  assert.ok(closedProductHtml.includes('登入查看預留狀態'));
  assert.ok(closedProductHtml.includes('查詢我的預留'));

  for (const appVariant of [quarantinedApp, unadmittedApp]) {
    const storeRes = await appVariant.request(`${x.h.origin}/shops/${s.slug}`);
    const prodRes = await appVariant.request(`${x.h.origin}/shops/${s.slug}/products/${s.product.sku}`);
    assert.equal(await storeRes.text(), closedStoreHtml);
    assert.equal(await prodRes.text(), closedProductHtml);
  }

  const openStoreRes = await openApp.request(`${x.h.origin}/shops/${s.slug}`);
  const openStoreBody = await openStoreRes.text();
  assert.equal(openStoreRes.status, 200);
  assert.equal(openStoreBody.match(/<script\b/gi)?.length, 1);
  assert.ok(openStoreBody.includes('<script type="module" src="/assets/storefront.js"></script>'));
  assert.ok(openStoreBody.includes('<body><a class="shop-skip-link" href="#main">跳到主要內容</a>'));
  assert.ok(openStoreBody.includes('<main id="main" tabindex="-1">'));
  assert.ok(
    openStoreBody.includes(`<a class="shop-cart-link" href="/shops/${s.slug}/cart" data-store-slug="${s.slug}">購物車</a>`),
  );
  assert.ok(openStoreBody.includes('<p class="shop-sr-only" id="shop-cart-status" role="status"></p>'));
  assert.ok(openStoreBody.includes(`<a href="/shops/${s.slug}/order-access">找回訂單</a>`));
  assert.equal(openStoreBody.includes('會員的商品與商店'), false);
  assert.equal(openStoreBody.includes('登入查看預留狀態'), false);
  assert.equal(openStoreBody.includes('查詢我的預留'), false);

  const openProdRes = await openApp.request(`${x.h.origin}/shops/${s.slug}/products/${s.product.sku}`);
  const openProdBody = await openProdRes.text();
  assert.equal(openProdRes.status, 200);
  assert.equal(openProdBody.match(/<script\b/gi)?.length, 1);
  assert.ok(openProdBody.includes('<script type="module" src="/assets/storefront.js"></script>'));
  assert.ok(openProdBody.includes('<body><a class="shop-skip-link" href="#main">跳到主要內容</a>'));
  assert.ok(openProdBody.includes('<main id="main" tabindex="-1">'));
  assert.ok(
    openProdBody.includes(`<a class="shop-cart-link" href="/shops/${s.slug}/cart" data-store-slug="${s.slug}">購物車</a>`),
  );
  assert.ok(openProdBody.includes('<p class="shop-sr-only" id="shop-cart-status" role="status"></p>'));
  assert.ok(openProdBody.includes(`id="shop-add-to-cart"`));
  assert.ok(openProdBody.includes(`data-store-slug="${s.slug}"`));
  assert.ok(openProdBody.includes(`data-store-name="合成商店"`));
  assert.ok(openProdBody.includes(`data-sku="${s.product.sku}"`));
  assert.ok(openProdBody.includes(`data-title="合成商品"`));
  assert.ok(openProdBody.includes(`data-price-minor="100"`));
  assert.ok(openProdBody.includes(`data-currency="TWD"`));
  assert.ok(openProdBody.includes(`data-revision="1"`));
  assert.ok(openProdBody.includes('<noscript><p class="shop-action-note">加入購物車需要開啟瀏覽器的 JavaScript。</p></noscript>'));
  assert.ok(openProdBody.includes(`<a href="/shops/${s.slug}/order-access">找回訂單</a>`));
  assert.equal(openProdBody.includes('登入確認預留條件'), false);
  assert.equal(openProdBody.includes('登入查看預留狀態'), false);
  assert.equal(openProdBody.includes('查詢我的預留'), false);

  const soldOutProdRes = await openApp.request(
    `${x.h.origin}/shops/${soldOut.slug}/products/${soldOut.product.sku}`,
  );
  const soldOutProdBody = await soldOutProdRes.text();
  assert.equal(soldOutProdRes.status, 200);
  assert.equal(soldOutProdBody.match(/<script\b/gi)?.length, 1);
  assert.ok(soldOutProdBody.includes('<p class="shop-availability">目前沒有可售數量</p>'));
  assert.equal(soldOutProdBody.includes('shop-add-to-cart'), false);
  assert.equal(soldOutProdBody.includes('登入確認預留條件'), false);
  assert.equal(soldOutProdBody.includes('登入查看預留狀態'), false);
  assert.equal(soldOutProdBody.includes('查詢我的預留'), false);

  for (const invalidSku of ['P1', 'p0001']) {
    const missingProdRes = await openApp.request(`${x.h.origin}/shops/${s.slug}/products/${invalidSku}`);
    assert.equal(missingProdRes.status, 404);
    assert.equal(missingProdRes.headers.get('set-cookie'), null);
    assert.equal(await missingProdRes.text(), storeMissingHtml(true));
  }

  assert.deepEqual(await tableCounts(), before);
});

test('B04 cart route serves no-store HTML shell identically with checkout on and off, and 404s for unknown or unpublished stores', async () => {
  const s = await x.store(5);
  const openApp = makeApp({ checkoutEnabled: true });
  const before = await tableCounts();

  const closedRes = await x.app.request(`${x.h.origin}/shops/${s.slug}/cart`);
  const openRes = await openApp.request(`${x.h.origin}/shops/${s.slug.toUpperCase()}/cart`);
  const closedHtml = await closedRes.text();
  const openHtml = await openRes.text();

  for (const res of [closedRes, openRes]) {
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/html\b/i);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-robots-tag'), 'noindex');
    assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'self'/);
    assert.equal(res.headers.get('set-cookie'), null);
  }

  assert.equal(closedHtml, openHtml);
  assert.equal(closedHtml, cartPageHtml({ slug: s.slug, name: '合成商店' }));
  assert.ok(closedHtml.includes('<title>購物車｜合成商店｜自由工坊</title>'));
  assert.ok(closedHtml.includes('<body><a class="shop-skip-link" href="#main">跳到主要內容</a>'));
  assert.equal(closedHtml.match(/<script\b/gi)?.length, 1);
  assert.ok(closedHtml.includes('<script type="module" src="/assets/storefront.js"></script>'));
  assert.equal(/\bon[a-z]+\s*=/i.test(closedHtml), false);
  assert.equal(closedHtml.match(/<h1\b/gi)?.length, 1);
  assert.ok(closedHtml.includes('<h1 id="shop-cart-title" tabindex="-1">購物車</h1>'));
  assert.ok(closedHtml.includes('<p role="status">正在讀取購物車…</p>'));
  assert.ok(closedHtml.includes('<noscript><p>使用購物車需要開啟瀏覽器的 JavaScript。</p></noscript>'));
  assert.ok(closedHtml.includes(`data-store-slug="${s.slug}"`));
  assert.ok(closedHtml.includes('data-store-name="合成商店"'));

  const unknownRes = await openApp.request(`${x.h.origin}/shops/no-such-store/cart`);
  assert.equal(unknownRes.status, 404);
  assert.equal(unknownRes.headers.get('cache-control'), 'no-store');
  assert.equal(unknownRes.headers.get('x-robots-tag'), 'noindex');
  assert.equal(unknownRes.headers.get('set-cookie'), null);
  assert.equal(await unknownRes.text(), storeMissingHtml());

  const current = ok(await x.h.call('GET', s.root, s.owner, undefined, {}, x.app));
  ok(await x.send(s, '/unpublish', {}, current.version));

  const unpubRes = await openApp.request(`${x.h.origin}/shops/${s.slug}/cart`);
  assert.equal(unpubRes.status, 404);
  assert.equal(unpubRes.headers.get('set-cookie'), null);
  assert.equal(await unpubRes.text(), storeMissingHtml());

  assert.deepEqual(await tableCounts(), before);
});

test('B05 is a no-store shell with no order effects and follows store publication visibility', async () => {
  const s = await x.store(5);
  const app = makeApp({checkoutEnabled: true});
  const before = await tableCounts();
  for (const candidate of [app, x.app]) {
    const response = await candidate.request(`${x.h.origin}/shops/${s.slug.toUpperCase()}/checkout`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('x-robots-tag'), 'noindex');
    assert.equal(await response.text(), checkoutPageHtml({slug: s.slug, name: '合成商店'}));
  }
  const missing = await app.request(`${x.h.origin}/shops/no-such-store/checkout`);
  assert.equal(missing.status, 404);
  const current = ok(await x.h.call('GET', s.root, s.owner, undefined, {}, x.app));
  ok(await x.send(s, '/unpublish', {}, current.version));
  assert.equal((await app.request(`${x.h.origin}/shops/${s.slug}/checkout`)).status, 404);
  assert.deepEqual(await tableCounts(), before);
});

test('HTML characters in store name and product title are escaped in B01, B03 and B04', async () => {
  const s = await x.store(5);
  const openApp = makeApp({ checkoutEnabled: true });
  const rawXss = `<img src=x onerror=alert(1)>&"'`;
  const escapedXss = '&lt;img src=x onerror=alert(1)&gt;&amp;&quot;&#39;';

  const current = ok(await x.h.call('GET', s.root, s.owner, undefined, {}, x.app));
  ok(await x.send(s, '', { name: rawXss }, current.version, 'PATCH'));
  ok(
    await x.send(
      s,
      `/products/${s.product.product_id}`,
      { title: rawXss, price_minor: 2500 },
      s.product.version,
      'PATCH',
    ),
  );
  await x.publish(s);

  const before = await tableCounts();

  const b01Res = await openApp.request(`${x.h.origin}/shops/${s.slug}`);
  const b01Html = await b01Res.text();
  assert.equal(b01Res.status, 200);
  assert.ok(b01Html.includes(`<title>${escapedXss}｜自由工坊</title>`));
  assert.ok(b01Html.includes(`<h1>${escapedXss}</h1>`));
  assert.equal(b01Html.includes('<img src=x'), false);

  const b03Res = await openApp.request(`${x.h.origin}/shops/${s.slug}/products/${s.product.sku}`);
  const b03Html = await b03Res.text();
  assert.equal(b03Res.status, 200);
  assert.ok(b03Html.includes(`<title>${escapedXss}｜${escapedXss}｜自由工坊</title>`));
  assert.ok(b03Html.includes(`data-store-name="${escapedXss}"`));
  assert.ok(b03Html.includes(`data-title="${escapedXss}"`));
  assert.equal(b03Html.includes('<img src=x'), false);
  assert.equal(/\bon[a-z]+\s*=/i.test(b03Html.replaceAll(escapedXss, '')), false);

  const b04Res = await openApp.request(`${x.h.origin}/shops/${s.slug}/cart`);
  const b04Html = await b04Res.text();
  assert.equal(b04Res.status, 200);
  assert.ok(b04Html.includes(`<title>購物車｜${escapedXss}｜自由工坊</title>`));
  assert.ok(b04Html.includes(`<a class="shop-top-store" href="/shops/${s.slug}">${escapedXss}</a>`));
  assert.ok(b04Html.includes(`data-store-name="${escapedXss}"`));
  assert.equal(b04Html.includes('<img src=x'), false);
  assert.equal(/\bon[a-z]+\s*=/i.test(b04Html.replaceAll(escapedXss, '')), false);

  assert.deepEqual(await tableCounts(), before);
});
