import { test, expect } from './fixtures.js';
import {
  assertCartResponsiveLayout,
  assertExactQuoteInput,
  buildVerifiedError,
  buildVerifiedQuote,
  setupCartFixtureStore,
} from './storefront-cart-fixture.js';
import { formatMinor } from '../../modules/agent-commerce/hosted/format.js';

const RESPONSIVE_WIDTHS = [1440, 1280, 768, 390, 320] as const;

test('1. checkout off (main E2E server) serves v1 B01/B03 without scripts or /assets/storefront.js requests, and 409 on B04 for real', async ({
  browser,
  baseURL,
  e2eAuthPool,
}) => {
  const store = await setupCartFixtureStore(e2eAuthPool, browser);
  const context = await browser.newContext({ baseURL });
  try {
    const page = await context.newPage();
    const assetRequests: string[] = [];
    page.on('request', req => {
      if (new URL(req.url()).pathname.includes('storefront.js')) {
        assetRequests.push(req.url());
      }
    });

    await page.goto(`/shops/${store.slug}`);
    await expect(page.getByRole('heading', { level: 1, name: store.storeName })).toBeVisible();
    await expect(page.locator('script')).toHaveCount(0);
    await expect(page.locator('.shop-top')).toContainText('會員的商品與商店');
    await expect(page.getByRole('link', { name: '登入查看預留狀態', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: '查詢我的預留', exact: true })).toBeVisible();
    expect(assetRequests).toEqual([]);

    const p1 = store.products[0];
    await page.goto(`/shops/${store.slug}/products/${p1.sku}`);
    await expect(page.getByRole('heading', { level: 1, name: p1.title })).toBeVisible();
    await expect(page.locator('script')).toHaveCount(0);
    await expect(page.getByRole('link', { name: '登入確認預留條件', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: '登入查看預留狀態', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: '查詢我的預留', exact: true })).toBeVisible();
    await expect(page.locator('#shop-add-to-cart')).toHaveCount(0);
    expect(assetRequests).toEqual([]);

    // Real 409 checkout_not_enabled on the main E2E server (checkout off) with a stored cart
    await page.evaluate(
      ({ slug, revision, sku, title, priceMinor }) => {
        window.localStorage.setItem(
          `freedom.shop.cart.v1:${slug}`,
          JSON.stringify({
            revision,
            lines: [{ sku, quantity: 2, title, price_minor: priceMinor, currency: 'TWD' }],
          }),
        );
      },
      {
        slug: store.slug,
        revision: store.revision,
        sku: p1.sku,
        title: p1.title,
        priceMinor: p1.price_minor,
      },
    );

    const quoteResponsePromise = page.waitForResponse(
      res => res.url().includes(`/api/v1/public/stores/${store.slug}/cart-quotes`) && res.request().method() === 'POST',
    );
    await page.goto(`/shops/${store.slug}/cart`);
    const quoteResponse = await quoteResponsePromise;
    expect(quoteResponse.status()).toBe(409);

    await expect(page.getByRole('status')).toHaveText('這間店目前沒有開放線上購物。購物車會保留在這個瀏覽器。');
    await expect(page.getByRole('region', { name: '商品' })).toContainText(p1.title);
    await expect(page.getByRole('region', { name: '金額明細' })).toHaveCount(0);
    await expect(page.locator('#shop-cart')).not.toContainText('單價');
    await expect(page.locator('#shop-cart')).not.toContainText('小計');
    await expect(page.getByRole('link', { name: `回到「${store.storeName}」`, exact: true })).toHaveAttribute(
      'href',
      `/shops/${store.slug}`,
    );
  } finally {
    try {
      await context.close();
    } finally {
      await store.close();
    }
  }
});

test('2 & 3. B03 add to cart, sheet modal, capped 99 message, header count/announcer and cross-tab sync to B01 and B04', async ({
  browser,
  e2eAuthPool,
}) => {
  const store = await setupCartFixtureStore(e2eAuthPool, browser);
  const context = await browser.newContext({ baseURL: store.origin });
  try {
    const p1 = store.products[0];
    const p2 = store.products[1];
    const page1 = await context.newPage();
    const page2 = await context.newPage();

    await page1.goto(`/shops/${store.slug}`);
    const headerLink1 = page1.locator('.shop-cart-link');
    await expect(headerLink1).toHaveText('購物車');
    await expect(page1.locator('#shop-cart-status')).toHaveText('');

    const b03Requests: string[] = [];
    await page2.goto(`/shops/${store.slug}/products/${p1.sku}`);
    await expect(page2.getByRole('button', { name: '加入購物車', exact: true })).toBeVisible();
    await expect(page2.locator('#shop-cart-status')).toHaveText('');
    page2.on('request', req => b03Requests.push(req.url()));

    // Invalid quantity validation on B03
    const qtyInput = page2.getByLabel('數量', { exact: true });
    const addButton = page2.getByRole('button', { name: '加入購物車', exact: true });
    await qtyInput.fill('0');
    await expect(qtyInput).toHaveAttribute('aria-invalid', 'true');
    await expect(page2.locator('#shop-add-quantity-error')).toHaveText('請輸入 1 到 99 的數量。');
    await addButton.click();
    await expect(qtyInput).toBeFocused();
    await expect(page2.getByRole('dialog')).toHaveCount(0);

    // Valid quantity 2 -> add to cart -> sheet opens with focus on 查看購物車
    await qtyInput.fill('2');
    await expect(qtyInput).not.toHaveAttribute('aria-invalid', 'true');
    await addButton.click();

    const sheet = page2.getByRole('dialog', { name: '已加入購物車' });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText(p1.title);
    await expect(sheet).toContainText('購物車裡的數量：2');
    await expect(sheet).not.toContainText('每項商品最多 99 件，已調整為 99 件。');
    const viewCartLink = sheet.getByRole('link', { name: '查看購物車', exact: true });
    await expect(viewCartLink).toHaveAttribute('href', `/shops/${store.slug}/cart`);
    await expect(viewCartLink).toBeFocused();

    // Esc closes the sheet and returns focus to 加入購物車
    await page2.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(addButton).toBeFocused();

    // Header and live announcer on both tabs
    await expect(page2.locator('.shop-cart-link')).toHaveText('購物車（2）');
    await expect(page2.locator('#shop-cart-status')).toHaveText('購物車有 2 件商品');
    await expect(headerLink1).toHaveText('購物車（2）');
    await expect(page1.locator('#shop-cart-status')).toHaveText('購物車有 2 件商品');

    // localStorage holds exact §3 JSON under the single key and nothing else
    const storageSnapshot = await page2.evaluate(() => {
      const entries: Record<string, unknown> = {};
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const key = window.localStorage.key(i)!;
        entries[key] = JSON.parse(window.localStorage.getItem(key)!);
      }
      return {
        localKeys: Object.keys(entries),
        entries,
        sessionLength: window.sessionStorage.length,
      };
    });
    expect(storageSnapshot.localKeys).toEqual([`freedom.shop.cart.v1:${store.slug}`]);
    expect(storageSnapshot.sessionLength).toBe(0);
    expect(storageSnapshot.entries[`freedom.shop.cart.v1:${store.slug}`]).toEqual({
      revision: store.revision,
      lines: [
        {
          sku: p1.sku,
          quantity: 2,
          title: p1.title,
          price_minor: p1.price_minor,
          currency: 'TWD',
        },
      ],
    });

    // Adding 98 more caps at 99 and shows the capped message; closing via 關閉 and 繼續購物 returns focus
    await qtyInput.fill('98');
    await addButton.click();
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('購物車裡的數量：99');
    await expect(sheet).toContainText('每項商品最多 99 件，已調整為 99 件。');
    await sheet.getByRole('button', { name: '關閉', exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect(addButton).toBeFocused();

    await qtyInput.fill('1');
    await addButton.click();
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: '繼續購物', exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect(addButton).toBeFocused();

    expect(b03Requests).toEqual([]);

    // Open B04 in tab 1 while tab 2 adds a second product -> new line appears and is quoted on B04
    await qtyInput.fill('1');
    await page2.evaluate(
      ({ slug, revision, sku, title, priceMinor }) => {
        window.localStorage.setItem(
          `freedom.shop.cart.v1:${slug}`,
          JSON.stringify({
            revision,
            lines: [{ sku, quantity: 2, title, price_minor: priceMinor, currency: 'TWD' }],
          }),
        );
      },
      { slug: store.slug, revision: store.revision, sku: p1.sku, title: p1.title, priceMinor: p1.price_minor },
    );

    const firstQuoteDone = page1.waitForResponse(
      res => res.url().includes(`/api/v1/public/stores/${store.slug}/cart-quotes`) && res.status() === 200,
    );
    await page1.goto(`/shops/${store.slug}/cart`);
    await firstQuoteDone;
    await expect(page1.getByRole('region', { name: '商品' })).toContainText(p1.title);

    await page2.goto(`/shops/${store.slug}/products/${p2.sku}`);
    const secondQuoteDone = page1.waitForResponse(
      res => res.url().includes(`/api/v1/public/stores/${store.slug}/cart-quotes`) && res.status() === 200,
    );
    await page2.getByRole('button', { name: '加入購物車', exact: true }).click();
    await secondQuoteDone;
    await expect(page1.getByRole('region', { name: '商品' })).toContainText(p2.title);
    await expect(page1.getByRole('region', { name: '金額明細' })).toContainText(
      formatMinor(p1.price_minor * 2 + p2.price_minor, 'TWD'),
    );
  } finally {
    try {
      await context.close();
    } finally {
      await store.close();
    }
  }
});

test('4 & 5. B04 three-line quote formatting, 600ms debounce coalescing, exact request schema, and seller price change notice', async ({
  browser,
  e2eAuthPool,
}) => {
  const store = await setupCartFixtureStore(e2eAuthPool, browser);
  const context = await browser.newContext({ baseURL: store.origin });
  try {
    const [p1, p2, p3] = store.products;
    const page = await context.newPage();

    const quoteRequests: { publication_revision: string; lines: { sku: string; quantity: number }[] }[] = [];
    page.on('request', req => {
      if (req.url().includes(`/api/v1/public/stores/${store.slug}/cart-quotes`) && req.method() === 'POST') {
        quoteRequests.push(assertExactQuoteInput(req.postData()));
      }
    });

    await page.goto(`/shops/${store.slug}`);
    await page.evaluate(
      ({ slug, revision, items }) => {
        window.localStorage.setItem(
          `freedom.shop.cart.v1:${slug}`,
          JSON.stringify({
            revision,
            lines: items,
          }),
        );
      },
      {
        slug: store.slug,
        revision: store.revision,
        items: [
          { sku: p1.sku, quantity: 2, title: p1.title, price_minor: p1.price_minor, currency: 'TWD' },
          { sku: p2.sku, quantity: 3, title: p2.title, price_minor: p2.price_minor, currency: 'TWD' },
          { sku: p3.sku, quantity: 1, title: p3.title, price_minor: p3.price_minor, currency: 'TWD' },
        ],
      },
    );

    const initialQuoteRes = page.waitForResponse(
      res => res.url().includes(`/api/v1/public/stores/${store.slug}/cart-quotes`) && res.status() === 200,
    );
    await page.goto(`/shops/${store.slug}/cart`);
    await initialQuoteRes;

    await expect(page).toHaveTitle(`購物車｜${store.storeName}｜自由工坊`);
    expect(quoteRequests).toHaveLength(1);
    expect(quoteRequests[0]).toEqual({
      publication_revision: store.revision,
      lines: [
        { sku: p1.sku, quantity: 2 },
        { sku: p2.sku, quantity: 3 },
        { sku: p3.sku, quantity: 1 },
      ],
    });

    const itemsSection = page.getByRole('region', { name: '商品' });
    for (const [product, qty] of [
      [p1, 2],
      [p2, 3],
      [p3, 1],
    ] as const) {
      const link = itemsSection.getByRole('link', { name: product.title, exact: true });
      await expect(link).toHaveAttribute('href', `/shops/${store.slug}/products/${product.sku}`);
      await expect(itemsSection.getByLabel(`${product.title}數量`, { exact: true })).toHaveValue(String(qty));
      await expect(itemsSection).toContainText(`單價 ${formatMinor(product.price_minor, 'TWD')}`);
      await expect(itemsSection).toContainText(`小計 ${formatMinor(product.price_minor * qty, 'TWD')}`);
    }

    const expectedMerchandise = p1.price_minor * 2 + p2.price_minor * 3 + p3.price_minor * 1;
    const totalsSection = page.getByRole('region', { name: '金額明細' });
    await expect(totalsSection).toContainText(formatMinor(expectedMerchandise, 'TWD'));
    await expect(totalsSection).toContainText('於下一步依配送方式計算');
    await expect(totalsSection).toContainText('選擇配送方式後顯示');
    await expect(totalsSection).not.toContainText('折扣');
    await expect(page.locator('#shop-cart')).toContainText('請到結帳頁選擇取貨與付款方式，核對最新價格。');
    await expect(page.getByRole('link', {name: '前往結帳', exact: true})).toHaveAttribute('href', `/shops/${store.slug}/checkout`);
    await expect(page.getByRole('link', { name: '繼續購物', exact: true })).toHaveAttribute(
      'href',
      `/shops/${store.slug}`,
    );

    // Invalid quantity in B04 field is not saved and is restored on blur
    const p1Input = itemsSection.getByLabel(`${p1.title}數量`, { exact: true });
    await p1Input.fill('0');
    await expect(p1Input).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator(`#shop-cart-qty-error-${p1.sku}`)).toHaveText('請輸入 1 到 99 的數量。');
    await p1Input.blur();
    await expect(p1Input).toHaveValue('2');
    await expect(p1Input).not.toHaveAttribute('aria-invalid', 'true');
    expect(quoteRequests).toHaveLength(1);

    // Typing a new quantity and pressing + / - quickly sends ONE quote for the final state
    const debouncedQuoteRes = page.waitForResponse(
      res => res.url().includes(`/api/v1/public/stores/${store.slug}/cart-quotes`) && res.status() === 200,
    );
    await p1Input.fill('4');
    await itemsSection.getByRole('button', { name: `增加${p1.title}數量`, exact: true }).click();
    await itemsSection.getByRole('button', { name: `減少${p1.title}數量`, exact: true }).click();
    await itemsSection.getByRole('button', { name: `減少${p1.title}數量`, exact: true }).click();
    await debouncedQuoteRes;

    expect(quoteRequests).toHaveLength(2);
    expect(quoteRequests[1]).toEqual({
      publication_revision: store.revision,
      lines: [
        { sku: p1.sku, quantity: 3 },
        { sku: p2.sku, quantity: 3 },
        { sku: p3.sku, quantity: 1 },
      ],
    });
    await expect(totalsSection).toContainText(
      formatMinor(p1.price_minor * 3 + p2.price_minor * 3 + p3.price_minor, 'TWD'),
    );

    // 5. Seller changes p1's price and republishes
    const newPriceMinor = 39000;
    const { projection: newProjection } = await store.updatePriceAndRepublish(p1, newPriceMinor);
    expect(newProjection.revision).not.toBe(store.revision);

    const priceChangeQuoteRes = page.waitForResponse(
      res => res.url().includes(`/api/v1/public/stores/${store.slug}/cart-quotes`) && res.status() === 200,
    );
    await page.reload();
    await priceChangeQuoteRes;

    expect(quoteRequests).toHaveLength(3);
    expect(quoteRequests[2].publication_revision).toBe(store.revision);
    await expect(itemsSection).toContainText(
      `價格已更新，加入時為 ${formatMinor(p1.price_minor, 'TWD')}`,
    );
    await expect(itemsSection).toContainText(`單價 ${formatMinor(newPriceMinor, 'TWD')}`);
    await expect(itemsSection).toContainText(`小計 ${formatMinor(newPriceMinor * 3, 'TWD')}`);

    // Next quote carries the new publication_revision
    const nextRevQuoteRes = page.waitForResponse(
      res => res.url().includes(`/api/v1/public/stores/${store.slug}/cart-quotes`) && res.status() === 200,
    );
    await itemsSection.getByRole('button', { name: `減少${p1.title}數量`, exact: true }).click();
    await nextRevQuoteRes;

    expect(quoteRequests).toHaveLength(4);
    expect(quoteRequests[3].publication_revision).toBe(newProjection.revision);
  } finally {
    try {
      await context.close();
    } finally {
      await store.close();
    }
  }
});

test('6, 7 & 8. insufficient stock recovery, sold-out B03 & B04, delisted product, and removal announcements & focus order', async ({
  browser,
  e2eAuthPool,
}) => {
  const store = await setupCartFixtureStore(e2eAuthPool, browser);
  const context = await browser.newContext({ baseURL: store.origin });
  try {
    const [p1, p2, p3] = store.products;
    const soldOut = store.soldOutProduct;
    const page = await context.newPage();

    // 7. Sold-out product on B03 shows 目前沒有可售數量 and no add controls
    await page.goto(`/shops/${store.slug}/products/${soldOut.sku}`);
    await expect(page.getByRole('heading', { level: 1, name: soldOut.title })).toBeVisible();
    await expect(page.locator('.shop-availability')).toHaveText('目前沒有可售數量');
    await expect(page.locator('#shop-add-to-cart')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '加入購物車' })).toHaveCount(0);

    // 6. Insufficient stock (p3 has stock 3; put quantity 6 in cart alongside soldOut product)
    await page.evaluate(
      ({ slug, revision, items }) => {
        window.localStorage.setItem(
          `freedom.shop.cart.v1:${slug}`,
          JSON.stringify({ revision, lines: items }),
        );
      },
      {
        slug: store.slug,
        revision: store.revision,
        items: [
          { sku: p3.sku, quantity: 6, title: p3.title, price_minor: p3.price_minor, currency: 'TWD' },
          { sku: soldOut.sku, quantity: 1, title: soldOut.title, price_minor: soldOut.price_minor, currency: 'TWD' },
        ],
      },
    );

    const quote1 = page.waitForResponse(
      res => res.url().includes(`/api/v1/public/stores/${store.slug}/cart-quotes`) && res.status() === 200,
    );
    await page.goto(`/shops/${store.slug}/cart`);
    await quote1;

    const itemsSection = page.getByRole('region', { name: '商品' });
    await expect(itemsSection).toContainText('數量不足，目前最多可購買 3 件。');
    await expect(itemsSection).toContainText('目前沒有可售數量。');
    await expect(itemsSection).toContainText('商品小計不含上面標示的商品。');
    await expect(page.getByRole('region', { name: '金額明細' })).toContainText('處理上面標示的商品後顯示');
    await expect(page.locator('#shop-cart')).toContainText('請先處理上面標示的商品。');

    // Sold-out line has no quantity controls, only 移除
    await expect(itemsSection.getByLabel(`${soldOut.title}數量`)).toHaveCount(0);
    await expect(itemsSection.getByRole('button', { name: `從購物車移除${soldOut.title}`, exact: true })).toBeVisible();

    // Clicking 改為可購買數量 sets quantity to 3, focuses the field, and quotes p3 as ok
    const capButton = itemsSection.getByRole('button', { name: `把${p3.title}改為可購買數量`, exact: true });
    const quoteAfterCap = page.waitForResponse(
      res => res.url().includes(`/api/v1/public/stores/${store.slug}/cart-quotes`) && res.status() === 200,
    );
    await capButton.click();
    const p3Input = itemsSection.getByLabel(`${p3.title}數量`, { exact: true });
    await expect(p3Input).toHaveValue('3');
    await expect(p3Input).toBeFocused();
    await quoteAfterCap;
    await expect(itemsSection).not.toContainText('數量不足，目前最多可購買 3 件。');
    await expect(itemsSection).toContainText(`小計 ${formatMinor(p3.price_minor * 3, 'TWD')}`);

    // 8. Delisted product: seller removes p2 and republishes; test removal focus movement across 3 lines
    await page.evaluate(
      ({ slug, revision, items }) => {
        window.localStorage.setItem(
          `freedom.shop.cart.v1:${slug}`,
          JSON.stringify({ revision, lines: items }),
        );
      },
      {
        slug: store.slug,
        revision: store.revision,
        items: [
          { sku: p2.sku, quantity: 1, title: p2.title, price_minor: p2.price_minor, currency: 'TWD' },
          { sku: p1.sku, quantity: 1, title: p1.title, price_minor: p1.price_minor, currency: 'TWD' },
          { sku: p3.sku, quantity: 1, title: p3.title, price_minor: p3.price_minor, currency: 'TWD' },
        ],
      },
    );
    await store.removeProductAndRepublish(p2);

    const delistedQuote = page.waitForResponse(
      res => res.url().includes(`/api/v1/public/stores/${store.slug}/cart-quotes`) && res.status() === 200,
    );
    await page.reload();
    await delistedQuote;

    // Delisted p2 shows stored title without a link, 已下架。, and no quantity controls except 移除
    await expect(itemsSection.getByRole('link', { name: p2.title })).toHaveCount(0);
    await expect(itemsSection).toContainText(p2.title);
    await expect(itemsSection).toContainText('已下架。');
    await expect(itemsSection.getByLabel(`${p2.title}數量`)).toHaveCount(0);

    // Remove first line (p2) -> announces removal and moves focus to next line's (p1's) 移除
    await itemsSection.getByRole('button', { name: `從購物車移除${p2.title}`, exact: true }).click();
    await expect(page.locator('#shop-cart [role="status"]')).toHaveText(`已從購物車移除「${p2.title}」。`);
    const removeP1 = itemsSection.getByRole('button', { name: `從購物車移除${p1.title}`, exact: true });
    await expect(removeP1).toBeFocused();

    // Remove last line of remaining two (p3) -> moves focus to previous line's (p1's) 移除
    await itemsSection.getByRole('button', { name: `從購物車移除${p3.title}`, exact: true }).click();
    await expect(page.locator('#shop-cart [role="status"]')).toHaveText(`已從購物車移除「${p3.title}」。`);
    await expect(removeP1).toBeFocused();

    // Remove the final remaining line (p1) -> moves focus to h1 and renders empty cart state
    await removeP1.click();
    const heading = page.getByRole('heading', { level: 1, name: '購物車' });
    await expect(heading).toBeFocused();
    await expect(page.locator('#shop-cart [role="status"]')).toHaveText(`已從購物車移除「${p1.title}」。`);
    await expect(page.locator('#shop-cart')).toContainText('購物車是空的。');
    await expect(page.getByRole('link', { name: `回到「${store.storeName}」`, exact: true })).toHaveAttribute(
      'href',
      `/shops/${store.slug}`,
    );
  } finally {
    try {
      await context.close();
    } finally {
      await store.close();
    }
  }
});

test('9. B04 error table (429, 503, 409, 404, network/malformed), retry focus to h1, not_configured shipping and unavailable with title', async ({
  browser,
  e2eAuthPool,
}) => {
  const store = await setupCartFixtureStore(e2eAuthPool, browser);
  const context = await browser.newContext({ baseURL: store.origin });
  try {
    const p1 = store.products[0];
    const page = await context.newPage();

    await page.goto(`/shops/${store.slug}`);
    await page.evaluate(
      ({ slug, revision, sku, title, priceMinor }) => {
        window.localStorage.setItem(
          `freedom.shop.cart.v1:${slug}`,
          JSON.stringify({
            revision,
            lines: [{ sku, quantity: 2, title, price_minor: priceMinor, currency: 'TWD' }],
          }),
        );
      },
      { slug: store.slug, revision: store.revision, sku: p1.sku, title: p1.title, priceMinor: p1.price_minor },
    );

    const rateLimitedBody = buildVerifiedError(429, 'commerce_rate_limited', '更新太頻繁。');
    const quarantinedBody = buildVerifiedError(503, 'commerce_quarantined', '商務服務暫停中。');
    const notEnabledBody = buildVerifiedError(409, 'checkout_not_enabled', '尚未開放。');
    const storeNotFoundBody = buildVerifiedError(404, 'checkout_store_not_found', '找不到商店。');

    const notConfiguredQuote = buildVerifiedQuote({
      payment_options: [{ method: 'immediate_card', available: true, reason: null }],
      publication_revision: store.revision,
      currency: 'TWD',
      lines: [
        {
          sku: p1.sku,
          title: p1.title,
          options: [{ name: '容量', value: '180ml' }],
          unit_price_minor: p1.price_minor,
          quantity: 2,
          line_total_minor: p1.price_minor * 2,
          state: 'ok',
        },
      ],
      merchandise_total_minor: p1.price_minor * 2,
      discounts: [],
      delivery_options: [],
      shipping: { state: 'not_configured', groups: [], total_minor: null },
      total_minor: null,
    });

    const unavailableWithTitleQuote = buildVerifiedQuote({
      payment_options: [{ method: 'immediate_card', available: true, reason: null }],
      publication_revision: store.revision,
      currency: 'TWD',
      lines: [
        {
          sku: p1.sku,
          title: p1.title,
          options: [],
          unit_price_minor: p1.price_minor,
          quantity: 2,
          line_total_minor: null,
          state: 'unavailable',
        },
      ],
      merchandise_total_minor: 0,
      discounts: [],
      delivery_options: [],
      shipping: { state: 'needs_delivery_data', groups: [], total_minor: null },
      total_minor: null,
    });

    const quotePattern = `**/api/v1/public/stores/${store.slug}/cart-quotes`;
    let attempt = 0;
    await page.route(quotePattern, async route => {
      attempt += 1;
      if (attempt === 1) {
        await route.fulfill({
          status: 429,
          headers: { 'Retry-After': '10' },
          contentType: 'application/json',
          body: JSON.stringify(rateLimitedBody),
        });
        return;
      }
      if (attempt === 2) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify(quarantinedBody),
        });
        return;
      }
      if (attempt === 3) {
        await route.abort('failed');
        return;
      }
      if (attempt === 4) {
        // Deliberately malformed 200 body
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ publication_revision: '1', lines: [] }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(notConfiguredQuote),
      });
    });

    // Attempt 1: 429
    await page.goto(`/shops/${store.slug}/cart`);
    await expect(page.getByRole('alert')).toHaveText('更新太頻繁，請稍後再試。');
    await expect(page.getByRole('region', { name: '商品' })).toContainText('單價 無法取得');
    await expect(page.getByRole('region', { name: '商品' })).toContainText('小計 無法取得');
    const totals = page.getByRole('region', { name: '金額明細' });
    await expect(totals).toContainText('無法取得');

    // Attempt 2: 503 commerce_quarantined
    await page.getByRole('button', { name: '重試', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('商店服務暫停中，請稍後再試。');
    await expect(totals).toContainText('無法取得');

    // Attempt 3: network error
    await page.getByRole('button', { name: '重試', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('無法取得最新價格，請稍後重試。');

    // Attempt 4: malformed 200 body
    await page.getByRole('button', { name: '重試', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('無法取得最新價格，請稍後重試。');

    // Attempt 5: retry succeeds -> alert disappears, focus moves to h1, not_configured copy shown
    await page.getByRole('button', { name: '重試', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: '購物車' })).toBeFocused();
    await expect(page.getByRole('region', { name: '商品' })).toContainText('容量：180ml');
    await expect(totals).toContainText('這間店尚未設定配送方式');
    await expect(totals).toContainText('店家設定配送方式後顯示');
    await page.unroute(quotePattern);

    // Unavailable with quoted title
    await page.route(quotePattern, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(unavailableWithTitleQuote),
      });
    });
    await page.reload();
    await expect(page.getByRole('region', { name: '商品' }).getByRole('link', { name: p1.title })).toBeVisible();
    await expect(page.getByRole('region', { name: '商品' })).toContainText('目前沒有可售數量。');
    await expect(page.getByRole('region', { name: '商品' }).getByLabel(`${p1.title}數量`)).toHaveCount(0);
    await page.unroute(quotePattern);

    // 409 checkout_not_enabled via route
    await page.route(quotePattern, async route => {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify(notEnabledBody),
      });
    });
    await page.reload();
    await expect(page.getByRole('status')).toHaveText('這間店目前沒有開放線上購物。購物車會保留在這個瀏覽器。');
    await expect(page.getByRole('region', { name: '金額明細' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: `回到「${store.storeName}」`, exact: true })).toHaveAttribute(
      'href',
      `/shops/${store.slug}`,
    );
    await page.unroute(quotePattern);

    // 404 checkout_store_not_found via route
    await page.route(quotePattern, async route => {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify(storeNotFoundBody),
      });
    });
    await page.reload();
    await expect(page.getByRole('status')).toHaveText('這間商店目前沒有公開。');
    await expect(page.getByRole('region', { name: '金額明細' })).toHaveCount(0);
    await expect(
      page.locator('#shop-cart').getByRole('link', { name: '返回自由工坊', exact: true }),
    ).toHaveAttribute('href', '/');
    await page.unroute(quotePattern);

    // In-flight request coalescing: while quote 1 (qty 2) is held open, change quantity to 3 and 4 ->
    // at most 1 in flight; when quote 1 settles, its stale response is ignored and 1 follow-up quote (qty 4) runs.
    let inFlightCount = 0;
    let maxConcurrent = 0;
    let releaseFirstQuote!: () => void;
    const firstQuoteEntered = new Promise<void>(resolve => {
      releaseFirstQuote = resolve;
    });
    let holdGateResolve!: () => void;
    const holdGate = new Promise<void>(resolve => {
      holdGateResolve = resolve;
    });
    const seenQuantities: number[] = [];

    await page.route(quotePattern, async route => {
      const input = assertExactQuoteInput(route.request().postData());
      const qty = input.lines[0].quantity;
      seenQuantities.push(qty);
      inFlightCount += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlightCount);
      if (seenQuantities.length === 1) {
        releaseFirstQuote();
        await holdGate;
      }
      inFlightCount -= 1;
      const body = buildVerifiedQuote({
        payment_options: [{ method: 'immediate_card', available: true, reason: null }],
        publication_revision: store.revision,
        currency: 'TWD',
        lines: [
          {
            sku: p1.sku,
            title: p1.title,
            options: [],
            unit_price_minor: p1.price_minor,
            quantity: qty,
            line_total_minor: p1.price_minor * qty,
            state: 'ok',
          },
        ],
        merchandise_total_minor: p1.price_minor * qty,
        discounts: [],
        delivery_options: [],
        shipping: {
          state: 'quoted',
          method: 'home',
          groups: [{ group_ref: 'g1', amount_minor: 6000 }],
          total_minor: 6000,
        },
        total_minor: p1.price_minor * qty + 6000,
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    });

    const reloadPromise = page.reload();
    await firstQuoteEntered;
    await expect(page.locator('#shop-cart')).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByRole('region', { name: '商品' })).toContainText('單價 計算中…');
    await page.getByRole('button', { name: `增加${p1.title}數量`, exact: true }).click();
    await page.getByRole('button', { name: `增加${p1.title}數量`, exact: true }).click();
    const followUpResponse = page.waitForResponse(
      res =>
        res.url().includes(`/api/v1/public/stores/${store.slug}/cart-quotes`) &&
        res.status() === 200 &&
        (res.request().postData() ?? '').includes('"quantity":4'),
    );
    holdGateResolve();
    await reloadPromise;
    await followUpResponse;
    await expect(page.locator('#shop-cart')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByRole('region', { name: '金額明細' })).toContainText(
      formatMinor(p1.price_minor * 4 + 6000, 'TWD'),
    );
    expect(maxConcurrent).toBe(1);
    expect(seenQuantities).toEqual([2, 4]);
    await page.unroute(quotePattern);
  } finally {
    try {
      await context.close();
    } finally {
      await store.close();
    }
  }
});

test('10. defensive storage cleanup, 50-line cap alert on B03, and Storage.prototype.setItem failure alert on B03', async ({
  browser,
  e2eAuthPool,
}) => {
  const store = await setupCartFixtureStore(e2eAuthPool, browser);
  const context = await browser.newContext({ baseURL: store.origin });
  try {
    const p1 = store.products[0];
    const page = await context.newPage();

    // Corrupt JSON and wrong top-level shape fall back to empty cart
    await page.goto(`/shops/${store.slug}`);
    await page.evaluate((slug: string) => {
      window.localStorage.setItem(`freedom.shop.cart.v1:${slug}`, '{corrupt-json');
    }, store.slug);
    await page.goto(`/shops/${store.slug}/cart`);
    await expect(page.locator('#shop-cart')).toContainText('購物車是空的。');

    await page.evaluate((slug: string) => {
      window.localStorage.setItem(`freedom.shop.cart.v1:${slug}`, JSON.stringify({ revision: '0', lines: [] }));
    }, store.slug);
    await page.reload();
    await expect(page.locator('#shop-cart')).toContainText('購物車是空的。');

    // 60 lines with duplicate SKUs and quantity 500 -> cleaned to at most 50 unique valid lines with quantity <= 99
    await page.evaluate((slug: string) => {
      const lines: unknown[] = [
        { sku: 'P0001', quantity: 500, title: '無效五百件', price_minor: 1000, currency: 'TWD' },
        { sku: 'P0001', quantity: 3, title: '有效三件', price_minor: 1000, currency: 'TWD' },
        { sku: 'P0001', quantity: 9, title: '重複被略過', price_minor: 1000, currency: 'TWD' },
      ];
      for (let i = 2; i <= 65; i += 1) {
        const sku = `P${String(i).padStart(4, '0')}`;
        lines.push({
          sku,
          quantity: (i % 99) + 1,
          title: `合成商品 ${i}`,
          price_minor: 1000,
          currency: 'TWD',
        });
      }
      window.localStorage.setItem(`freedom.shop.cart.v1:${slug}`, JSON.stringify({ revision: '1', lines }));
    }, store.slug);

    let capturedLines: { sku: string; quantity: number }[] = [];
    const quotePattern = `**/api/v1/public/stores/${store.slug}/cart-quotes`;
    await page.route(quotePattern, async route => {
      const parsed = assertExactQuoteInput(route.request().postData());
      capturedLines = parsed.lines;
      const fulfilled = buildVerifiedQuote({
        payment_options: [{ method: 'immediate_card', available: true, reason: null }],
        publication_revision: store.revision,
        currency: 'TWD',
        lines: parsed.lines.map(l => ({
          sku: l.sku,
          title: `商品 ${l.sku}`,
          options: [],
          unit_price_minor: 1000,
          quantity: l.quantity,
          line_total_minor: 1000 * l.quantity,
          state: 'ok' as const,
        })),
        merchandise_total_minor: parsed.lines.reduce((sum, l) => sum + 1000 * l.quantity, 0),
        discounts: [],
        delivery_options: [],
        shipping: { state: 'needs_delivery_data', groups: [], total_minor: null },
        total_minor: null,
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(fulfilled),
      });
    });

    await page.goto(`/shops/${store.slug}/cart`);
    await expect(page.getByRole('region', { name: '商品' }).locator('li.shop-cart-line')).toHaveCount(50);
    expect(capturedLines).toHaveLength(50);
    expect(new Set(capturedLines.map(l => l.sku)).size).toBe(50);
    expect(capturedLines[0]).toEqual({ sku: 'P0001', quantity: 3 });
    expect(capturedLines.every(l => l.quantity >= 1 && l.quantity <= 99)).toBe(true);
    await page.unroute(quotePattern);

    // B03 with 50 distinct lines already in localStorage (none matching p1.sku) -> 50-line alert with 查看購物車 link
    await page.evaluate((slug: string) => {
      const fiftyLines = Array.from({ length: 50 }, (_, idx) => ({
        sku: `P${String(idx + 1000).padStart(4, '0')}`,
        quantity: 1,
        title: `既有商品 ${idx + 1}`,
        price_minor: 500,
        currency: 'TWD',
      }));
      window.localStorage.setItem(`freedom.shop.cart.v1:${slug}`, JSON.stringify({ revision: '1', lines: fiftyLines }));
    }, store.slug);

    await page.goto(`/shops/${store.slug}/products/${p1.sku}`);
    await page.getByRole('button', { name: '加入購物車', exact: true }).click();
    const maxAlert = page.getByRole('alert');
    await expect(maxAlert).toContainText('購物車最多放 50 項商品，請先到購物車移除一些商品。');
    await expect(maxAlert.getByRole('link', { name: '查看購物車', exact: true })).toHaveAttribute(
      'href',
      `/shops/${store.slug}/cart`,
    );
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Storage.prototype.setItem throwing on B03 -> shows storage error alert and opens no sheet
    const blockedContext = await browser.newContext({ baseURL: store.origin });
    try {
      await blockedContext.addInitScript(() => {
        Storage.prototype.setItem = () => {
          throw new Error('QuotaExceededError');
        };
      });
      const blockedPage = await blockedContext.newPage();
      await blockedPage.goto(`/shops/${store.slug}/products/${p1.sku}`);
      await blockedPage.getByRole('button', { name: '加入購物車', exact: true }).click();
      await expect(blockedPage.getByRole('alert')).toHaveText(
        '這個瀏覽器無法保存購物車。請允許這個網站儲存資料後再試一次。',
      );
      await expect(blockedPage.getByRole('dialog')).toHaveCount(0);
    } finally {
      await blockedContext.close();
    }
  } finally {
    try {
      await context.close();
    } finally {
      await store.close();
    }
  }
});

test('11, 12 & 13. keyboard-only operation, noscript fallbacks on B03/B04, and stylesheet/script/origin isolation', async ({
  browser,
  e2eAuthPool,
}) => {
  const store = await setupCartFixtureStore(e2eAuthPool, browser);
  const context = await browser.newContext({ baseURL: store.origin });
  try {
    const p1 = store.products[0];
    const page = await context.newPage();
    const pageRequests: string[] = [];
    page.on('request', req => pageRequests.push(req.url()));

    // B03 keyboard navigation + isolation
    await page.goto(`/shops/${store.slug}/products/${p1.sku}`);
    await expect(page.getByRole('button', { name: '加入購物車', exact: true })).toBeVisible();

    const b03Resources = await page.evaluate(() => ({
      stylesheets: [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map(l =>
        new URL(l.href).pathname,
      ),
      scripts: [...document.querySelectorAll<HTMLScriptElement>('script')].map(s =>
        s.src ? new URL(s.src).pathname : 'inline',
      ),
    }));
    expect(b03Resources.stylesheets).toEqual(['/shops.css']);
    expect(b03Resources.scripts.every(src => src.startsWith('/assets/'))).toBe(true);

    // First Tab focuses 跳到主要內容 on B03
    await page.keyboard.press('Tab');
    const skipB03 = page.getByRole('link', { name: '跳到主要內容', exact: true });
    await expect(skipB03).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main')).toBeFocused();

    // Keyboard add to cart & sheet operation
    const qtyInput = page.getByLabel('數量', { exact: true });
    await qtyInput.focus();
    await page.keyboard.press('ArrowUp');
    await expect(qtyInput).toHaveValue('2');
    await page.keyboard.press('Tab');
    const addButton = page.getByRole('button', { name: '加入購物車', exact: true });
    await expect(addButton).toBeFocused();
    await page.keyboard.press('Enter');

    const sheet = page.getByRole('dialog', { name: '已加入購物車' });
    await expect(sheet).toBeVisible();
    const viewCartLink = sheet.getByRole('link', { name: '查看購物車', exact: true });
    await expect(viewCartLink).toBeFocused();

    // Navigate to B04 via keyboard Enter on 查看購物車
    const quoteDone = page.waitForResponse(
      res => res.url().includes(`/api/v1/public/stores/${store.slug}/cart-quotes`) && res.status() === 200,
    );
    await page.keyboard.press('Enter');
    await quoteDone;
    await expect(page.getByRole('heading', { level: 1, name: '購物車' })).toBeVisible();

    // B04 isolation check
    const b04Resources = await page.evaluate(() => ({
      stylesheets: [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map(l =>
        new URL(l.href).pathname,
      ),
      scripts: [...document.querySelectorAll<HTMLScriptElement>('script')].map(s =>
        s.src ? new URL(s.src).pathname : 'inline',
      ),
    }));
    expect(b04Resources.stylesheets).toEqual(['/shops.css']);
    expect(b04Resources.scripts.every(src => src.startsWith('/assets/'))).toBe(true);
    expect(pageRequests.every(url => new URL(url).origin === store.origin)).toBe(true);

    // Reload B04 so first Tab focuses 跳到主要內容
    const reloadQuoteDone = page.waitForResponse(
      res => res.url().includes(`/api/v1/public/stores/${store.slug}/cart-quotes`) && res.status() === 200,
    );
    await page.reload();
    await reloadQuoteDone;

    await page.keyboard.press('Tab');
    const skipB04 = page.getByRole('link', { name: '跳到主要內容', exact: true });
    await expect(skipB04).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main')).toBeFocused();

    // Keyboard stepper, field and remove on B04
    const incBtn = page.getByRole('button', { name: `增加${p1.title}數量`, exact: true });
    await incBtn.focus();
    await page.keyboard.press('Enter');
    const b04Input = page.getByLabel(`${p1.title}數量`, { exact: true });
    await expect(b04Input).toHaveValue('3');

    const decBtn = page.getByRole('button', { name: `減少${p1.title}數量`, exact: true });
    await decBtn.focus();
    await page.keyboard.press('Enter');
    await expect(b04Input).toHaveValue('2');

    const removeBtn = page.getByRole('button', { name: `從購物車移除${p1.title}`, exact: true });
    await removeBtn.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: '購物車' })).toBeFocused();
    await expect(page.locator('#shop-cart')).toContainText('購物車是空的。');

    // 12. No JavaScript on B03 (open) and B04
    const noJsContext = await browser.newContext({ baseURL: store.origin, javaScriptEnabled: false });
    try {
      const noJsPage = await noJsContext.newPage();
      await noJsPage.goto(`/shops/${store.slug}/products/${p1.sku}`);
      await expect(noJsPage.locator('#shop-add-to-cart noscript p')).toHaveText(
        '加入購物車需要開啟瀏覽器的 JavaScript。',
      );

      await noJsPage.goto(`/shops/${store.slug}/cart`);
      await expect(noJsPage.locator('#shop-cart noscript p')).toHaveText('使用購物車需要開啟瀏覽器的 JavaScript。');
    } finally {
      await noJsContext.close();
    }
  } finally {
    try {
      await context.close();
    } finally {
      await store.close();
    }
  }
});

test('14. responsive layout and full-page screenshots across 1440, 1280, 768, 390 and 320 widths', async ({
  browser,
  baseURL,
  e2eAuthPool,
}, info) => {
  const store = await setupCartFixtureStore(e2eAuthPool, browser);
  const openContext = await browser.newContext({ baseURL: store.origin });
  const closedContext = await browser.newContext({ baseURL });
  try {
    const [p1, p2, p3] = store.products;
    const soldOut = store.soldOutProduct;
    const page = await openContext.newPage();
    const closedPage = await closedContext.newPage();

    // 1. B01 open
    await page.goto(`/shops/${store.slug}`);
    await expect(page.getByRole('heading', { level: 1, name: store.storeName })).toBeVisible();
    await assertCartResponsiveLayout(page, RESPONSIVE_WIDTHS, w => info.outputPath(`b01-open-${w}.png`));

    // 2. B03 open (available)
    await page.goto(`/shops/${store.slug}/products/${p1.sku}`);
    await expect(page.getByRole('button', { name: '加入購物車', exact: true })).toBeVisible();
    await assertCartResponsiveLayout(page, RESPONSIVE_WIDTHS, w => info.outputPath(`b03-open-available-${w}.png`));

    // 3. The sheet open (checks right edge <= 420px above 600px, and full width at bottom edge at <= 600px)
    await page.getByRole('button', { name: '加入購物車', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '已加入購物車' })).toBeVisible();
    await assertCartResponsiveLayout(page, RESPONSIVE_WIDTHS, w => info.outputPath(`b03-sheet-open-${w}.png`), {
      checkSheet: true,
    });
    await page.keyboard.press('Escape');

    // 4. B03 open (sold out)
    await page.goto(`/shops/${store.slug}/products/${soldOut.sku}`);
    await expect(page.locator('.shop-availability')).toHaveText('目前沒有可售數量');
    await assertCartResponsiveLayout(page, RESPONSIVE_WIDTHS, w => info.outputPath(`b03-open-sold-out-${w}.png`));

    // 5. B03 closed (v1 on main E2E server)
    await closedPage.goto(`/shops/${store.slug}/products/${p1.sku}`);
    await expect(closedPage.getByRole('link', { name: '登入確認預留條件', exact: true })).toBeVisible();
    await assertCartResponsiveLayout(closedPage, RESPONSIVE_WIDTHS, w => info.outputPath(`b03-closed-v1-${w}.png`));

    // 6. B04 empty
    await page.evaluate((slug: string) => window.localStorage.removeItem(`freedom.shop.cart.v1:${slug}`), store.slug);
    await page.goto(`/shops/${store.slug}/cart`);
    await expect(page.locator('#shop-cart')).toContainText('購物車是空的。');
    await assertCartResponsiveLayout(page, RESPONSIVE_WIDTHS, w => info.outputPath(`b04-empty-${w}.png`));

    // 7. B04 with three lines
    await page.evaluate(
      ({ slug, revision, items }) => {
        window.localStorage.setItem(
          `freedom.shop.cart.v1:${slug}`,
          JSON.stringify({ revision, lines: items }),
        );
      },
      {
        slug: store.slug,
        revision: store.revision,
        items: [
          { sku: p1.sku, quantity: 2, title: p1.title, price_minor: p1.price_minor, currency: 'TWD' },
          { sku: p2.sku, quantity: 1, title: p2.title, price_minor: p2.price_minor, currency: 'TWD' },
          { sku: p3.sku, quantity: 1, title: p3.title, price_minor: p3.price_minor, currency: 'TWD' },
        ],
      },
    );
    const threeLinesQuote = page.waitForResponse(
      res => res.url().includes(`/api/v1/public/stores/${store.slug}/cart-quotes`) && res.status() === 200,
    );
    await page.goto(`/shops/${store.slug}/cart`);
    await threeLinesQuote;
    await assertCartResponsiveLayout(page, RESPONSIVE_WIDTHS, w => info.outputPath(`b04-three-lines-${w}.png`));

    // 8. B04 price updated (stored price differs from quoted price)
    await page.evaluate(
      ({ slug, revision, sku, title }) => {
        window.localStorage.setItem(
          `freedom.shop.cart.v1:${slug}`,
          JSON.stringify({
            revision,
            lines: [{ sku, quantity: 1, title, price_minor: 30000, currency: 'TWD' }],
          }),
        );
      },
      { slug: store.slug, revision: store.revision, sku: p1.sku, title: p1.title },
    );
    const priceUpdatedQuote = page.waitForResponse(
      res => res.url().includes(`/api/v1/public/stores/${store.slug}/cart-quotes`) && res.status() === 200,
    );
    await page.reload();
    await priceUpdatedQuote;
    await expect(page.locator('#shop-cart')).toContainText('價格已更新，加入時為');
    await assertCartResponsiveLayout(page, RESPONSIVE_WIDTHS, w => info.outputPath(`b04-price-updated-${w}.png`));

    // 9. B04 insufficient
    await page.evaluate(
      ({ slug, revision, sku, title, priceMinor }) => {
        window.localStorage.setItem(
          `freedom.shop.cart.v1:${slug}`,
          JSON.stringify({
            revision,
            lines: [{ sku, quantity: 10, title, price_minor: priceMinor, currency: 'TWD' }],
          }),
        );
      },
      { slug: store.slug, revision: store.revision, sku: p3.sku, title: p3.title, priceMinor: p3.price_minor },
    );
    const insufficientQuote = page.waitForResponse(
      res => res.url().includes(`/api/v1/public/stores/${store.slug}/cart-quotes`) && res.status() === 200,
    );
    await page.reload();
    await insufficientQuote;
    await expect(page.locator('#shop-cart')).toContainText('數量不足，目前最多可購買 3 件。');
    await assertCartResponsiveLayout(page, RESPONSIVE_WIDTHS, w => info.outputPath(`b04-insufficient-${w}.png`));

    // 10. B04 delisted (unlisted SKU in localStorage)
    await page.evaluate(
      ({ slug, revision }) => {
        window.localStorage.setItem(
          `freedom.shop.cart.v1:${slug}`,
          JSON.stringify({
            revision,
            lines: [{ sku: 'P9999', quantity: 1, title: '已下架手作茶盤', price_minor: 28000, currency: 'TWD' }],
          }),
        );
      },
      { slug: store.slug, revision: store.revision },
    );
    const delistedQuote = page.waitForResponse(
      res => res.url().includes(`/api/v1/public/stores/${store.slug}/cart-quotes`) && res.status() === 200,
    );
    await page.reload();
    await delistedQuote;
    await expect(page.locator('#shop-cart')).toContainText('已下架。');
    await assertCartResponsiveLayout(page, RESPONSIVE_WIDTHS, w => info.outputPath(`b04-delisted-${w}.png`));

    // 11. B04 not open (on main E2E server with checkout off)
    await closedPage.goto(`/shops/${store.slug}`);
    await closedPage.evaluate(
      ({ slug, revision, sku, title, priceMinor }) => {
        window.localStorage.setItem(
          `freedom.shop.cart.v1:${slug}`,
          JSON.stringify({
            revision,
            lines: [{ sku, quantity: 1, title, price_minor: priceMinor, currency: 'TWD' }],
          }),
        );
      },
      { slug: store.slug, revision: store.revision, sku: p1.sku, title: p1.title, priceMinor: p1.price_minor },
    );
    await closedPage.goto(`/shops/${store.slug}/cart`);
    await expect(closedPage.getByRole('status')).toHaveText('這間店目前沒有開放線上購物。購物車會保留在這個瀏覽器。');
    await assertCartResponsiveLayout(closedPage, RESPONSIVE_WIDTHS, w => info.outputPath(`b04-not-open-${w}.png`));

    // 12. B04 error alert (503 commerce_quarantined)
    const quotePattern = `**/api/v1/public/stores/${store.slug}/cart-quotes`;
    const quarantinedBody = buildVerifiedError(503, 'commerce_quarantined', '服務暫停中。');
    await page.route(quotePattern, async route => {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify(quarantinedBody),
      });
    });
    await page.reload();
    await expect(page.getByRole('alert')).toHaveText('商店服務暫停中，請稍後再試。');
    await assertCartResponsiveLayout(page, RESPONSIVE_WIDTHS, w => info.outputPath(`b04-error-alert-${w}.png`));
    await page.unroute(quotePattern);

    // 13. B03 open with an 80-character store name and a 120-character product title
    const longStoreName = '山邊小店合成長名測試'.repeat(8);
    const longProductTitle = '手作茶杯合成長標題測試品'.repeat(10);
    expect([...longStoreName].length).toBe(80);
    expect([...longProductTitle].length).toBe(120);

    const updatedLong = await store.updateLongNamesAndRepublish(longStoreName, p1, longProductTitle);
    await page.goto(`/shops/${store.slug}/products/${p1.sku}`);
    await expect(page.getByRole('heading', { level: 1, name: longProductTitle })).toBeVisible();
    await assertCartResponsiveLayout(page, RESPONSIVE_WIDTHS, w => info.outputPath(`b03-open-long-text-${w}.png`));

    // 14. B04 with the 80-character store name and 120-character product title (quantity 2)
    await page.evaluate(
      ({ slug, revision, sku, title, priceMinor }) => {
        window.localStorage.setItem(
          `freedom.shop.cart.v1:${slug}`,
          JSON.stringify({
            revision,
            lines: [{ sku, quantity: 2, title, price_minor: priceMinor, currency: 'TWD' }],
          }),
        );
      },
      {
        slug: store.slug,
        revision: updatedLong.projection.revision,
        sku: p1.sku,
        title: longProductTitle,
        priceMinor: p1.price_minor,
      },
    );
    const longTextQuote = page.waitForResponse(
      res => res.url().includes(`/api/v1/public/stores/${store.slug}/cart-quotes`) && res.status() === 200,
    );
    await page.goto(`/shops/${store.slug}/cart`);
    await longTextQuote;
    await expect(page.locator('.shop-top-store')).toHaveText(longStoreName);
    await expect(page.getByRole('region', { name: '商品' })).toContainText(longProductTitle);
    await assertCartResponsiveLayout(page, RESPONSIVE_WIDTHS, w => info.outputPath(`b04-long-text-${w}.png`));
  } finally {
    try {
      await closedContext.close();
    } finally {
      try {
        await openContext.close();
      } finally {
        await store.close();
      }
    }
  }
});
