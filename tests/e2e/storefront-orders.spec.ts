import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures.js';
import { apiLogin } from './hosted-order-fixture.js';
import {
  assertResponsiveLayout,
  buildVerifiedError,
  buildVerifiedOrder,
  seedStorefrontOrder,
  setupStorefrontOrderStore,
  updateAndRepublishStore,
} from './storefront-order-fixture.js';
import { formatTaipeiDateTime } from '../../apps/portal-web/src/storefront/format.js';
import { formatMinor } from '../../modules/agent-commerce/hosted/format.js';

const RESPONSIVE_WIDTHS = [1440, 1280, 768, 390, 320] as const;

test('one-time link redemption, same-link revisit, used-link rejection, no-access 404s and forget flow preserve token isolation', async ({
  browser,
  baseURL,
  e2eAuthPool,
}) => {
  const store = await setupStorefrontOrderStore(e2eAuthPool, browser, baseURL!);
  const seeded = await seedStorefrontOrder(e2eAuthPool, store, { quantity: 2 });

  const firstContext = await browser.newContext({ baseURL });
  try {
    const page = await firstContext.newPage();
    const recordedRequests: { method: string; url: string; postData: string | null }[] = [];
    page.on('request', req => {
      recordedRequests.push({
        method: req.method(),
        url: req.url(),
        postData: req.postData(),
      });
    });

    await page.goto(seeded.linkPath);
    expect(page.url()).toBe(new URL(seeded.orderPath, baseURL!).href);
    expect(new URL(page.url()).hash).toBe('');

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('開啟訂單');
    await expect(page.getByRole('status')).toHaveText(
      '這個訂單連結只能使用一次。開啟後，這個瀏覽器會記住這筆訂單，之後可以直接查看。',
    );
    expect(recordedRequests.some(req => req.method === 'POST')).toBe(false);

    await page.getByRole('button', { name: '在這個瀏覽器開啟訂單', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`訂單 ${seeded.view.display_number}`);
    await expect(page).toHaveTitle(`訂單 ${seeded.view.display_number}｜山邊小店｜自由工坊`);
    await expect(page.locator('#shop-order')).toContainText(`下單時間 ${formatTaipeiDateTime(seeded.view.created_at)}`);
    await expect(page.locator('#shop-order')).toContainText('訂單狀態：進行中');
    await expect(page.getByRole('region', { name: '需要你處理' })).toContainText(
      `請在 ${formatTaipeiDateTime(seeded.view.pay_by)} 前完成付款，逾時保留的商品會釋出。`,
    );
    await expect(page.getByRole('region', { name: '付款' })).toContainText('尚未付款');
    await expect(page.getByRole('region', { name: '商品' })).toContainText('手作茶杯');
    await expect(page.getByRole('region', { name: '商品' })).toContainText('數量 2');
    await expect(page.getByRole('region', { name: '商品' })).toContainText(formatMinor(70000, 'TWD'));
    await expect(page.getByRole('region', { name: '商品' })).toContainText(formatMinor(6000, 'TWD'));
    await expect(page.getByRole('region', { name: '商品' })).toContainText(formatMinor(76000, 'TWD'));
    await expect(page.getByRole('region', { name: '聯絡資料' })).toContainText('合成買家甲');
    await expect(page.getByRole('region', { name: '聯絡資料' })).toContainText('synthetic-order-buyer@example.test');
    await expect(page.getByRole('region', { name: '聯絡資料' })).toContainText('0900123456');

    const cookies = await firstContext.cookies();
    const shopCookie = cookies.find(cookie => cookie.name === 'freedom_local_shop');
    expect(shopCookie).toBeDefined();
    expect(shopCookie!.httpOnly).toBe(true);
    expect(shopCookie!.sameSite).toBe('Lax');

    const browserSurface = await page.evaluate(() => ({
      html: document.documentElement.outerHTML,
      localStorage: JSON.stringify(window.localStorage),
      sessionStorage: JSON.stringify(window.sessionStorage),
      documentCookie: document.cookie,
    }));
    expect(browserSurface.html.includes(seeded.token)).toBe(false);
    expect(browserSurface.localStorage.includes(seeded.token)).toBe(false);
    expect(browserSurface.sessionStorage.includes(seeded.token)).toBe(false);
    expect(browserSurface.documentCookie.includes(seeded.token)).toBe(false);

    const tokenInUrls = recordedRequests.filter(req => req.url.includes(seeded.token));
    expect(tokenInUrls).toEqual([]);
    const tokenInBodies = recordedRequests.filter(req => (req.postData ?? '').includes(seeded.token));
    expect(tokenInBodies).toHaveLength(1);
    expect(new URL(tokenInBodies[0].url).pathname).toBe(
      `/api/v1/public/stores/${store.slug}/orders/${seeded.order.order_id}/access`,
    );

    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`訂單 ${seeded.view.display_number}`);
    expect(recordedRequests.filter(req => req.method === 'POST')).toHaveLength(1);

    // 2. Same link again in that context: opens order directly without prompt or POST.
    await page.goto(seeded.linkPath);
    expect(new URL(page.url()).hash).toBe('');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`訂單 ${seeded.view.display_number}`);
    expect(recordedRequests.filter(req => req.method === 'POST')).toHaveLength(1);

    // 3. Used link in a second fresh context: prompt -> click -> invalid-link message and B10 link.
    const secondContext = await browser.newContext({ baseURL });
    try {
      const page2 = await secondContext.newPage();
      await page2.goto(seeded.linkPath);
      expect(new URL(page2.url()).hash).toBe('');
      await expect(page2.getByRole('heading', { level: 1 })).toHaveText('開啟訂單');
      await page2.getByRole('button', { name: '在這個瀏覽器開啟訂單', exact: true }).click();
      await expect(page2.getByRole('heading', { level: 1 })).toHaveText('這個訂單連結無法使用');
      await expect(page2.getByRole('status')).toHaveText(
        '連結可能已經用過、超過 7 天，或不屬於這筆訂單。每個訂單連結只能在一個瀏覽器開啟一次。',
      );
      await expect(page2.getByRole('link', { name: '找回訂單', exact: true })).toHaveAttribute(
        'href',
        `/shops/${store.slug}/order-access`,
      );
      await expect(page2.getByRole('link', { name: '回到「山邊小店」', exact: true })).toHaveAttribute(
        'href',
        `/shops/${store.slug}`,
      );
    } finally {
      await secondContext.close();
    }

    // 4. No access: fresh context without fragment, random UUID order, and malformed #access=abc.
    const thirdContext = await browser.newContext({ baseURL });
    try {
      const page3 = await thirdContext.newPage();
      const thirdPosts: string[] = [];
      page3.on('request', req => {
        if (req.method() === 'POST') thirdPosts.push(req.url());
      });

      await page3.goto(seeded.orderPath);
      await expect(page3.getByRole('heading', { level: 1 })).toHaveText('找不到這筆訂單');
      const notFoundRealText = await page3.locator('#shop-order').innerText();

      await page3.goto(`/shops/${store.slug}/orders/${randomUUID()}`);
      await expect(page3.getByRole('heading', { level: 1 })).toHaveText('找不到這筆訂單');
      const notFoundRandomText = await page3.locator('#shop-order').innerText();
      expect(notFoundRandomText).toBe(notFoundRealText);

      await page3.goto(`${seeded.orderPath}#access=abc`);
      expect(new URL(page3.url()).hash).toBe('');
      await expect(page3.getByRole('heading', { level: 1 })).toHaveText('這個訂單連結無法使用');
      await expect(page3.getByRole('status')).toHaveText(
        '連結可能已經用過、超過 7 天，或不屬於這筆訂單。每個訂單連結只能在一個瀏覽器開啟一次。',
      );
      expect(thirdPosts).toEqual([]);
    } finally {
      await thirdContext.close();
    }

    // 5. Forget: Esc closes dialog and returns focus; failed forget shows alert and keeps trigger usable; confirm revokes device.
    const trigger = page.getByRole('button', { name: '在這個瀏覽器忘記我的訂單', exact: true });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: '要在這個瀏覽器忘記你的訂單嗎？' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      '忘記後，這個瀏覽器就不能再打開你在任何自由工坊商店的訂單。這些商店目前不寄訂單信件；如果你下單時沒有登入會員，之後只能聯絡店家。',
    );
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();

    // Cancel button also closes dialog and returns focus to trigger.
    await trigger.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();

    // Simulated 503 on forget closes dialog, shows alert next to trigger, and keeps trigger usable.
    const forgetQuarantinedError = buildVerifiedError(503, 'commerce_quarantined', '商務服務暫停中。');
    let failForgetOnce = true;
    await page.route('**/api/v1/public/order-access/forget', async route => {
      if (failForgetOnce) {
        failForgetOnce = false;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify(forgetQuarantinedError),
        });
        return;
      }
      await route.continue();
    });

    await trigger.click();
    await dialog.getByRole('button', { name: '忘記訂單', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('alert')).toHaveText('無法忘記訂單，請稍後重試。');
    await expect(trigger).toBeEnabled();
    await expect(trigger).toBeFocused();

    // Real confirm forget: transitions to forgotten state, clears cookie, revokes DB row, reload shows not found.
    await trigger.click();
    await dialog.getByRole('button', { name: '忘記訂單', exact: true }).click();
    const forgottenHeading = page.getByRole('heading', { level: 1, name: '這個瀏覽器已忘記你的訂單' });
    await expect(forgottenHeading).toBeVisible();
    await expect(forgottenHeading).toBeFocused();
    await expect(page).toHaveTitle('訂單｜山邊小店｜自由工坊');
    await expect(page.getByRole('status')).toHaveText('之後在這個瀏覽器打開訂單網址，會顯示找不到訂單。');
    await expect(page.getByRole('link', { name: '回到「山邊小店」', exact: true })).toHaveAttribute(
      'href',
      `/shops/${store.slug}`,
    );

    const cookiesAfterForget = await firstContext.cookies();
    expect(cookiesAfterForget.find(c => c.name === 'freedom_local_shop')).toBeUndefined();

    const deviceRows = (
      await e2eAuthPool.query<{ revoked_at: Date | null }>(
        `SELECT d.revoked_at
           FROM commerce_access_devices d
           JOIN commerce_order_access_grants g ON g.device_id = d.device_id
          WHERE g.kind = 'device' AND g.order_id = $1`,
        [seeded.order.order_id],
      )
    ).rows;
    expect(deviceRows).toHaveLength(1);
    expect(deviceRows[0].revoked_at).not.toBeNull();

    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('找不到這筆訂單');
  } finally {
    await firstContext.close();
  }
});

test('member-owned order opens for the logged-in buyer without a device cookie and returns not found for a stranger', async ({
  browser,
  baseURL,
  e2eAuthPool,
}) => {
  const store = await setupStorefrontOrderStore(e2eAuthPool, browser, baseURL!);
  const memberOrder = await seedStorefrontOrder(e2eAuthPool, store, {
    quantity: 1,
    buyerUserId: store.buyer.id,
  });

  const buyerContext = await browser.newContext({ baseURL });
  try {
    await apiLogin(buyerContext, baseURL!, store.buyer.email);
    const buyerPage = await buyerContext.newPage();
    await buyerPage.goto(memberOrder.orderPath);
    await expect(buyerPage.getByRole('heading', { level: 1 })).toHaveText(`訂單 ${memberOrder.view.display_number}`);
    expect((await buyerContext.cookies()).find(c => c.name === 'freedom_local_shop')).toBeUndefined();
  } finally {
    await buyerContext.close();
  }

  const strangerContext = await browser.newContext({ baseURL });
  try {
    await apiLogin(strangerContext, baseURL!, store.stranger.email);
    const strangerPage = await strangerContext.newPage();
    await strangerPage.goto(memberOrder.orderPath);
    await expect(strangerPage.getByRole('heading', { level: 1 })).toHaveText('找不到這筆訂單');
    await expect(strangerPage.getByRole('status')).toHaveText(
      '這個瀏覽器沒有這筆訂單的查看權限，或訂單不存在。訂單只能在下單時使用的瀏覽器，或以下單時登入的會員帳號查看。',
    );
  } finally {
    await strangerContext.close();
  }
});

test('real cancelled and paid orders plus fulfilled edge states and retry flows render exact copy', async ({
  browser,
  baseURL,
  e2eAuthPool,
}) => {
  const store = await setupStorefrontOrderStore(e2eAuthPool, browser, baseURL!);
  const cancelledSeed = await seedStorefrontOrder(e2eAuthPool, store, {
    quantity: 1,
    cancelReason: 'buyer_cancelled',
  });
  const paidSeed = await seedStorefrontOrder(e2eAuthPool, store, {
    quantity: 1,
    confirmPayment: true,
  });

  const context = await browser.newContext({ baseURL });
  try {
    const page = await context.newPage();

    // Real cancelled order (buyer_cancelled)
    await page.goto(cancelledSeed.linkPath);
    await page.getByRole('button', { name: '在這個瀏覽器開啟訂單', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`訂單 ${cancelledSeed.view.display_number}`);
    await expect(page.locator('#shop-order')).toContainText('訂單狀態：已取消（你取消了訂單）');
    await expect(page.getByRole('region', { name: '需要你處理' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: '付款' })).toContainText('尚未付款');

    // Real paid order (applyConfirmedPayment)
    await page.goto(paidSeed.linkPath);
    await page.getByRole('button', { name: '在這個瀏覽器開啟訂單', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`訂單 ${paidSeed.view.display_number}`);
    await expect(page.locator('#shop-order')).toContainText('訂單狀態：進行中');
    await expect(page.getByRole('region', { name: '需要你處理' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: '付款' })).toContainText('已付款');

    // Fulfilled states on GET and POST (every body validated with PublicOrderSchema / CheckoutErrorSchema)
    const baseOrder = paidSeed.view;
    const rateLimitedBody = buildVerifiedError(429, 'commerce_rate_limited', '嘗試次數太多，請稍後再試。');
    const pausedBody = buildVerifiedError(503, 'commerce_quarantined', '商務服務暫停中。');
    const notFoundBody = buildVerifiedError(404, 'checkout_order_not_found', '找不到訂單。');

    const expiredHoldOrder = buildVerifiedOrder(baseOrder, {
      lifecycle_state: 'open',
      cancel_reason: null,
      payment_state: 'unpaid',
      reservation_expired: true,
    });
    const optionsDiscountRedactedOrder = buildVerifiedOrder(baseOrder, {
      lifecycle_state: 'closed',
      cancel_reason: null,
      payment_state: 'confirmed',
      lines: [
        {
          sku: baseOrder.lines[0].sku,
          title: baseOrder.lines[0].title,
          options: [
            { name: '釉色', value: '天青' },
            { name: '容量', value: '200ml' },
          ],
          quantity: 2,
          unit_price_minor: 35000,
          line_total_minor: 70000,
        },
      ],
      merchandise_total_minor: 70000,
      discount_total_minor: 5000,
      shipping_total_minor: 6000,
      total_minor: 71000,
      redacted: true,
      contact: null,
      delivery: null,
      invoice: null,
    });
    const sellerCancelledOrder = buildVerifiedOrder(baseOrder, {
      lifecycle_state: 'cancelled',
      cancel_reason: 'seller_cancelled',
      payment_state: 'unpaid',
    });
    const timeoutCancelledOrder = buildVerifiedOrder(baseOrder, {
      lifecycle_state: 'cancelled',
      cancel_reason: 'payment_not_completed',
      payment_state: 'unpaid',
    });
    const paidCancelledOrder = buildVerifiedOrder(baseOrder, {
      lifecycle_state: 'cancelled',
      cancel_reason: 'paid_cancelled',
      payment_state: 'confirmed',
    });

    // Test GET retry sequence: 429 -> 503 -> network failure -> 200 expiredHoldOrder
    let getAttempt = 0;
    const orderApiPattern = `**/api/v1/public/stores/${store.slug}/orders/${paidSeed.order.order_id}`;
    await page.route(orderApiPattern, async route => {
      getAttempt += 1;
      if (getAttempt === 1) {
        await route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify(rateLimitedBody) });
        return;
      }
      if (getAttempt === 2) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(pausedBody) });
        return;
      }
      if (getAttempt === 3) {
        await route.abort('failed');
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(expiredHoldOrder) });
    });

    await page.goto(paidSeed.orderPath);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('訂單');
    await expect(page.getByRole('alert')).toHaveText('嘗試次數太多，請稍後再試。');

    await page.getByRole('button', { name: '重試', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('訂單');
    await expect(page.getByRole('alert')).toHaveText('商店服務暫停中，請稍後再試。');

    await page.getByRole('button', { name: '重試', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('訂單');
    await expect(page.getByRole('alert')).toHaveText('無法取得訂單，請稍後重試。');

    await page.getByRole('button', { name: '重試', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`訂單 ${expiredHoldOrder.display_number}`);
    const actionSection = page.getByRole('region', { name: '需要你處理' });
    await expect(actionSection).toContainText('付款期限已過，保留的商品已釋出。');
    await expect(actionSection.getByRole('link', { name: '回到「山邊小店」', exact: true })).toHaveAttribute(
      'href',
      `/shops/${store.slug}`,
    );
    await page.unroute(orderApiPattern);

    // Closed + options + discount + redacted contact
    for (const [fulfilledOrder, expectedStatus] of [
      [optionsDiscountRedactedOrder, '訂單狀態：已完成'],
      [sellerCancelledOrder, '訂單狀態：已取消（店家取消了訂單）'],
      [timeoutCancelledOrder, '訂單狀態：已取消（未在期限內完成付款）'],
      [paidCancelledOrder, '訂單狀態：已取消（店家無法出貨，將退款）'],
    ] as const) {
      await page.route(orderApiPattern, async route => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fulfilledOrder) });
      });
      await page.goto(paidSeed.orderPath);
      await expect(page.locator('#shop-order')).toContainText(expectedStatus);
      if (fulfilledOrder === optionsDiscountRedactedOrder) {
        await expect(page.getByRole('region', { name: '商品' })).toContainText('釉色：天青、容量：200ml');
        await expect(page.getByRole('region', { name: '商品' })).toContainText('折扣');
        await expect(page.getByRole('region', { name: '商品' })).toContainText(`−${formatMinor(5000, 'TWD')}`);
        const contactSection = page.getByRole('region', { name: '聯絡資料' });
        await expect(contactSection).toHaveText('聯絡資料這筆訂單的聯絡資料已依保存期限遮罩。');
        await expect(contactSection).not.toContainText('合成買家甲');
        await expect(contactSection).not.toContainText('Email');
      }
      await page.unroute(orderApiPattern);
    }

    // Link prompt POST retry (429 -> 404 where another tab redeemed so follow-up GET returns 200)
    const syntheticToken = 'A'.repeat(43);
    let getAfterRedeem = false;
    let redeemAttempts = 0;
    await page.route(orderApiPattern, async route => {
      if (!getAfterRedeem) {
        await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify(notFoundBody) });
      } else {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(baseOrder) });
      }
    });
    await page.route(`${orderApiPattern}/access`, async route => {
      redeemAttempts += 1;
      if (redeemAttempts === 1) {
        await route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify(rateLimitedBody) });
        return;
      }
      getAfterRedeem = true;
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify(notFoundBody) });
    });

    await page.goto(`${paidSeed.orderPath}#access=${syntheticToken}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('開啟訂單');
    await page.getByRole('button', { name: '在這個瀏覽器開啟訂單', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('開啟訂單');
    await expect(page.getByRole('alert')).toHaveText('嘗試次數太多，請稍後再試。');
    await page.getByRole('button', { name: '重試', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`訂單 ${baseOrder.display_number}`);
    await page.unroute(orderApiPattern);
    await page.unroute(`${orderApiPattern}/access`);

    // Hashchange GET error while an order is shown: alert appears, order stays on screen, retry clears alert
    let orderViewGetAttempt = 0;
    await page.route(orderApiPattern, async route => {
      orderViewGetAttempt += 1;
      if (orderViewGetAttempt === 1) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(pausedBody) });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(baseOrder) });
    });

    await page.evaluate(() => {
      window.location.hash = '#access=' + 'B'.repeat(43);
    });
    await expect(page.getByRole('alert')).toHaveText('商店服務暫停中，請稍後再試。');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`訂單 ${baseOrder.display_number}`);
    await expect(page.getByRole('region', { name: '商品' })).toContainText('手作茶杯');

    await page.getByRole('button', { name: '重試', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`訂單 ${baseOrder.display_number}`);
    await page.unroute(orderApiPattern);

    // Rejected link with failed follow-up GET: POST 404 -> GET 503 -> click 重試 -> GET 404 -> invalid-link view with both links
    let rejectedFlowGetAttempt = 0;
    await page.route(orderApiPattern, async route => {
      rejectedFlowGetAttempt += 1;
      if (rejectedFlowGetAttempt === 2) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(pausedBody) });
        return;
      }
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify(notFoundBody) });
    });
    await page.route(`${orderApiPattern}/access`, async route => {
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify(notFoundBody) });
    });

    await page.goto(`${paidSeed.orderPath}#access=${'C'.repeat(43)}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('開啟訂單');
    await page.getByRole('button', { name: '在這個瀏覽器開啟訂單', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('商店服務暫停中，請稍後再試。');
    await page.getByRole('button', { name: '重試', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('這個訂單連結無法使用');
    await expect(page.getByRole('link', { name: '找回訂單', exact: true })).toHaveAttribute(
      'href',
      `/shops/${store.slug}/order-access`,
    );
    await expect(page.getByRole('link', { name: '回到「山邊小店」', exact: true })).toHaveAttribute(
      'href',
      `/shops/${store.slug}`,
    );
    await page.unroute(orderApiPattern);
    await page.unroute(`${orderApiPattern}/access`);
  } finally {
    await context.close();
  }
});

test('B10 page, keyboard navigation, noscript fallback and asset isolation', async ({
  browser,
  baseURL,
  e2eAuthPool,
}) => {
  const store = await setupStorefrontOrderStore(e2eAuthPool, browser, baseURL!);
  const seeded = await seedStorefrontOrder(e2eAuthPool, store, { quantity: 1 });

  // 8. B10 page
  const context = await browser.newContext({ baseURL });
  try {
    const page = await context.newPage();
    await page.goto(`/shops/${store.slug}/order-access`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('找回訂單');
    await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
    await expect(page.getByLabel('訂單編號', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '寄送查看連結', exact: true })).toBeVisible();
    const backLink = page.getByRole('link', { name: '回到「山邊小店」', exact: true });
    await expect(backLink).toHaveAttribute('href', `/shops/${store.slug}`);

    // 9. Keyboard navigation + 11. Isolation
    const pageRequests: string[] = [];
    page.on('request', req => pageRequests.push(req.url()));

    await page.goto(seeded.linkPath);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('開啟訂單');

    await page.keyboard.press('Tab');
    const skipLink = page.getByRole('link', { name: '跳到主要內容', exact: true });
    await expect(skipLink).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main')).toBeFocused();

    await page.keyboard.press('Tab');
    const openButton = page.getByRole('button', { name: '在這個瀏覽器開啟訂單', exact: true });
    await expect(openButton).toBeFocused();
    await page.keyboard.press('Enter');

    const orderHeading = page.getByRole('heading', { level: 1, name: `訂單 ${seeded.view.display_number}` });
    await expect(orderHeading).toBeVisible();
    await expect(orderHeading).toBeFocused();

    // Isolation check on the loaded order page
    const resources = await page.evaluate(() => ({
      stylesheets: [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map(l =>
        new URL(l.href).pathname,
      ),
      scripts: [...document.querySelectorAll<HTMLScriptElement>('script')].map(s =>
        s.src ? new URL(s.src).pathname : 'inline',
      ),
    }));
    expect(resources.stylesheets).toEqual(['/shops.css']);
    expect(resources.scripts.every(src => src.startsWith('/assets/'))).toBe(true);
    expect(pageRequests.every(url => new URL(url).origin === new URL(baseURL!).origin)).toBe(true);

    // Keyboard-only dialog interaction
    const forgetButton = page.getByRole('button', { name: '在這個瀏覽器忘記我的訂單', exact: true });
    await forgetButton.focus();
    await expect(forgetButton).toBeFocused();
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog', { name: '要在這個瀏覽器忘記你的訂單嗎？' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: '忘記訂單', exact: true })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(forgetButton).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Enter');

    const forgottenHeading = page.getByRole('heading', { level: 1, name: '這個瀏覽器已忘記你的訂單' });
    await expect(forgottenHeading).toBeVisible();
    await expect(forgottenHeading).toBeFocused();
  } finally {
    await context.close();
  }

  // 10. No JavaScript
  const noJsContext = await browser.newContext({ baseURL, javaScriptEnabled: false });
  try {
    const noJsPage = await noJsContext.newPage();
    await noJsPage.goto(seeded.orderPath);
    const noscriptNotice = noJsPage.locator('#shop-order noscript p');
    await expect(noscriptNotice).toBeVisible();
    await expect(noscriptNotice).toHaveText('查看訂單需要開啟瀏覽器的 JavaScript。');
  } finally {
    await noJsContext.close();
  }
});

test('responsive layout and full-page screenshots across 1440, 1280, 768, 390 and 320 widths including 80-char store name and 120-char product title', async ({
  browser,
  baseURL,
  e2eAuthPool,
}, info) => {
  const store = await setupStorefrontOrderStore(e2eAuthPool, browser, baseURL!);
  const unpaidSeed = await seedStorefrontOrder(e2eAuthPool, store, { quantity: 1 });
  const paidSeed = await seedStorefrontOrder(e2eAuthPool, store, { quantity: 1, confirmPayment: true });
  const cancelledSeed = await seedStorefrontOrder(e2eAuthPool, store, {
    quantity: 1,
    cancelReason: 'buyer_cancelled',
  });

  // 1. Prompt, 2. Open unpaid, 7. Open dialog, 8. Forgotten
  const buyerContext = await browser.newContext({ baseURL });
  try {
    const page = await buyerContext.newPage();

    await page.goto(unpaidSeed.linkPath);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('開啟訂單');
    await assertResponsiveLayout(page, RESPONSIVE_WIDTHS, w => info.outputPath(`order-prompt-${w}.png`));

    await page.getByRole('button', { name: '在這個瀏覽器開啟訂單', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`訂單 ${unpaidSeed.view.display_number}`);
    await assertResponsiveLayout(page, RESPONSIVE_WIDTHS, w => info.outputPath(`order-open-unpaid-${w}.png`));

    await page.getByRole('button', { name: '在這個瀏覽器忘記我的訂單', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '要在這個瀏覽器忘記你的訂單嗎？' })).toBeVisible();
    await assertResponsiveLayout(page, RESPONSIVE_WIDTHS, w => info.outputPath(`order-open-dialog-${w}.png`));

    await page.getByRole('dialog').getByRole('button', { name: '忘記訂單', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('這個瀏覽器已忘記你的訂單');
    await assertResponsiveLayout(page, RESPONSIVE_WIDTHS, w => info.outputPath(`order-forgotten-${w}.png`));
  } finally {
    await buyerContext.close();
  }

  // 3. Paid order, 4. Cancelled order
  const secondContext = await browser.newContext({ baseURL });
  try {
    const page = await secondContext.newPage();

    await page.goto(paidSeed.linkPath);
    await page.getByRole('button', { name: '在這個瀏覽器開啟訂單', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`訂單 ${paidSeed.view.display_number}`);
    await assertResponsiveLayout(page, RESPONSIVE_WIDTHS, w => info.outputPath(`order-paid-${w}.png`));

    await page.goto(cancelledSeed.linkPath);
    await page.getByRole('button', { name: '在這個瀏覽器開啟訂單', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`訂單 ${cancelledSeed.view.display_number}`);
    await assertResponsiveLayout(page, RESPONSIVE_WIDTHS, w => info.outputPath(`order-cancelled-${w}.png`));
  } finally {
    await secondContext.close();
  }

  // 5. Not found, 6. Invalid link, 9. B10, and 320px long-text check
  const guestContext = await browser.newContext({ baseURL });
  try {
    const page = await guestContext.newPage();

    await page.goto(`/shops/${store.slug}/orders/${randomUUID()}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('找不到這筆訂單');
    await assertResponsiveLayout(page, RESPONSIVE_WIDTHS, w => info.outputPath(`order-not-found-${w}.png`));

    await page.goto(`${unpaidSeed.orderPath}#access=invalid-token`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('這個訂單連結無法使用');
    await assertResponsiveLayout(page, RESPONSIVE_WIDTHS, w => info.outputPath(`order-invalid-link-${w}.png`));

    await page.goto(`/shops/${store.slug}/order-access`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('找回訂單');
    await assertResponsiveLayout(page, RESPONSIVE_WIDTHS, w => info.outputPath(`order-b10-${w}.png`));

    // Repeat 320px check with an 80-character store name and a 120-character product title
    const longStoreName = '山邊小店合成長名測試'.repeat(8);
    const longProductTitle = '手作茶杯合成長標題測試品'.repeat(10);
    expect([...longStoreName].length).toBe(80);
    expect([...longProductTitle].length).toBe(120);

    const updatedStore = await updateAndRepublishStore(browser, baseURL!, store, {
      storeName: longStoreName,
      productTitle: longProductTitle,
      stock: 10,
    });
    const longSeed = await seedStorefrontOrder(e2eAuthPool, updatedStore, { quantity: 1 });

    await page.goto(longSeed.linkPath);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('開啟訂單');
    await assertResponsiveLayout(page, [320]);

    await page.getByRole('button', { name: '在這個瀏覽器開啟訂單', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`訂單 ${longSeed.view.display_number}`);
    await expect(page.getByRole('region', { name: '商品' })).toContainText(longProductTitle);
    await assertResponsiveLayout(page, [320], w => info.outputPath(`order-long-text-${w}.png`));
  } finally {
    await guestContext.close();
  }
});
