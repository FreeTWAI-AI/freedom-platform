import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures.js';
import { formatTaipeiDateTime } from '../../apps/portal-web/src/storefront/format.js';
import { StoreViewSchema } from '../../contracts/guild-launchpad/v1/storefront.js';
import {
  RESPONSIVE_WIDTHS,
  PublicOrderSchema,
  advancePaymentReturnPolls,
  apiLogin,
  assertResponsiveLayout,
  buildVerifiedError,
  buildVerifiedOrder,
  createE2ePaymentOrder,
  createMemberPaymentOrder,
  placeAdditionalPaymentOrder,
  readOrderDtoWithPageCookies,
} from './storefront-payment-fixture.js';
import type { Page } from '@playwright/test';
import type { Pool } from 'pg';
import { formatRetryAfterTaipeiTime, formatTaipeiTime } from '../../apps/portal-web/src/storefront/format.js';

test('1 & 10. Pay flow and B06 privacy: B07 starts payment -> fixture checkout -> 付款成功 -> B06 已收到付款 (status only, no PII/lines/amounts) -> B07 已付款', async ({
  page,
  browser,
  baseURL,
  e2eAuthPool,
}) => {
  const p = await createE2ePaymentOrder(e2eAuthPool, browser, baseURL!, page.context());
  const orderPath = `/shops/${p.store.slug}/orders/${p.order.order_ref}`;

  await page.goto(orderPath);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`訂單 ${p.order.display_number}`);

  const actionSection = page.getByRole('region', { name: '需要你處理' });
  await expect(actionSection).toContainText(
    `請在 ${formatTaipeiDateTime(p.order.pay_by)} 前完成付款，逾時保留的商品會釋出。`,
  );
  const payButton = actionSection.getByRole('button', { name: '前往付款', exact: true });
  await expect(payButton).toBeVisible();
  await expect(page.getByRole('region', { name: '付款' })).toContainText('尚未付款');

  await payButton.click();
  await expect(page.getByRole('heading', { name: '本機付款測試', exact: true })).toBeVisible();
  await expect(page.locator('[data-trade-number]')).toHaveText(/^F[0-9A-HJKMNP-TV-Z]{19}$/);
  await expect(page.locator('main')).toContainText(`金額：${p.order.total_minor / 100} TWD`);

  await page.getByRole('button', { name: '付款成功', exact: true }).click();
  await page.getByRole('button', { name: '返回商店查看結果', exact: true }).click();

  await expect(page).toHaveURL(`${baseURL}/shops/${p.store.slug}/payment-return/${p.payment.attempt_ref}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('已收到付款');
  await expect(page).toHaveTitle(`付款結果｜${p.order.store.name}｜自由工坊`);
  await expect(page.locator('#shop-pay-return')).toContainText(`訂單 ${p.order.display_number}`);
  await expect(page.locator('#shop-pay-return')).toContainText(
    `訂單 ${p.order.display_number} 的後續進度會顯示在訂單頁。`,
  );

  // #10 Privacy: B06 contains no contact name, email, phone, product title or amount
  const b06Text = await page.locator('#shop-pay-return').innerText();
  expect(b06Text).not.toContain('合成付款買家');
  expect(b06Text).not.toContain('synthetic-payment@example.test');
  expect(b06Text).not.toContain('0000000000');
  expect(b06Text).not.toContain(p.order.lines[0].title);
  expect(b06Text).not.toContain('NT$');
  expect(b06Text).not.toContain(String(p.order.total_minor / 100));

  const viewOrderLink = page.getByRole('link', { name: '查看訂單', exact: true });
  await expect(viewOrderLink).toHaveAttribute('href', orderPath);
  await viewOrderLink.click();

  await expect(page).toHaveURL(`${baseURL}${orderPath}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`訂單 ${p.order.display_number}`);
  await expect(page.getByRole('region', { name: '需要你處理' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '付款' })).toContainText('已付款');
});

test('2. Polling: 付款成功但通知延後 -> B06 polls every 5 s with at most 1 in flight -> deliver-pending updates to 已收到付款 and announces status', async ({
  page,
  browser,
  baseURL,
  e2eAuthPool,
}) => {
  const p = await createE2ePaymentOrder(e2eAuthPool, browser, baseURL!, page.context());
  await page.clock.install({ time: new Date('2026-10-16T02:00:00.000Z') });
  await page.clock.pauseAt(new Date('2026-10-16T02:00:00.000Z'));

  await page.goto(p.payment.handoff_url);
  await expect(page.getByRole('heading', { name: '本機付款測試', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '付款成功但通知延後', exact: true }).click();

  const orderApiPath = `/api/v1/public/stores/${p.store.slug}/orders/${p.order.order_ref}`;
  let inFlight = 0;
  let maxInFlight = 0;
  let getRequests = 0;

  page.on('request', req => {
    if (req.method() === 'GET' && new URL(req.url()).pathname === orderApiPath) {
      getRequests += 1;
      inFlight += 1;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
    }
  });
  page.on('requestfinished', req => {
    if (req.method() === 'GET' && new URL(req.url()).pathname === orderApiPath) {
      inFlight -= 1;
    }
  });
  page.on('requestfailed', req => {
    if (req.method() === 'GET' && new URL(req.url()).pathname === orderApiPath) {
      inFlight -= 1;
    }
  });

  const initialGet = page.waitForResponse(
    res => new URL(res.url()).pathname === orderApiPath && res.request().method() === 'GET',
  );
  await page.getByRole('button', { name: '返回商店查看結果', exact: true }).click();
  await initialGet;

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('付款結果確認中');
  await expect(page.locator('#shop-pay-return')).toContainText(
    '已回到商店，正在向付款服務確認結果，請不要重複付款。',
  );
  expect(getRequests).toBe(1);

  // Advance 4999 ms: no second GET yet
  await page.clock.runFor(4999);
  expect(getRequests).toBe(1);

  // Advance 1 ms (total 5000 ms): poll #1 fires
  const poll1 = page.waitForResponse(
    res => new URL(res.url()).pathname === orderApiPath && res.request().method() === 'GET',
  );
  await page.clock.runFor(1);
  await poll1;
  expect(getRequests).toBe(2);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('付款結果確認中');

  // Deliver the delayed notification on the server
  const delivered = await page.request.post('/__e2e/ecpay/deliver-pending', { data: {} });
  expect(delivered.status()).toBe(200);
  expect(await delivered.json()).toEqual({ delivered: 1 });

  // Advance 4999 ms: no third GET yet
  await page.clock.runFor(4999);
  expect(getRequests).toBe(2);

  // Advance 1 ms (total 5000 ms): poll #2 receives confirmed order and stops polling
  const poll2 = page.waitForResponse(
    res => new URL(res.url()).pathname === orderApiPath && res.request().method() === 'GET',
  );
  await page.clock.runFor(1);
  await poll2;

  expect(getRequests).toBe(3);
  expect(maxInFlight).toBe(1);

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('已收到付款');
  await expect(page.getByRole('status')).toHaveText('已收到付款');
  await expect(page.locator('#shop-pay-return')).toContainText(
    `訂單 ${p.order.display_number} 的後續進度會顯示在訂單頁。`,
  );

  // Verify polling stopped after reaching a final view
  await page.clock.runFor(15000);
  expect(getRequests).toBe(3);
});

test('3. After polling: 結果待確認 -> 2 minutes of polling -> 重新查詢 & 稍後再看 -> 409 pending disables button for 30 s -> confirmed moves focus to h1', async ({
  page,
  browser,
  baseURL,
  e2eAuthPool,
}) => {
  const p = await createE2ePaymentOrder(e2eAuthPool, browser, baseURL!, page.context());
  await page.clock.install({ time: new Date('2026-10-16T02:10:00.000Z') });

  await page.goto(p.payment.handoff_url);
  await page.getByRole('button', { name: '結果待確認', exact: true }).click();

  const orderApiPath = `/api/v1/public/stores/${p.store.slug}/orders/${p.order.order_ref}`;
  let pollCounter = 0;
  await page.route(`**${orderApiPath}`, async route => {
    if (route.request().method() === 'GET') {
      pollCounter += 1;
      // Inject one transient poll failure on poll #5 to verify failed polls keep the last view and count toward the 24
      if (pollCounter === 6) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify(buildVerifiedError(503, 'commerce_quarantined', '暫停')),
        });
        return;
      }
    }
    await route.continue();
  });

  const firstGet = page.waitForResponse(
    res => new URL(res.url()).pathname === orderApiPath && res.request().method() === 'GET',
  );
  await page.getByRole('button', { name: '返回商店查看結果', exact: true }).click();
  await firstGet;

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('付款結果確認中');
  await expect(page.locator('#shop-pay-return')).toContainText(
    '已回到商店，正在向付款服務確認結果，請不要重複付款。',
  );

  // Advance 24 polls (2 minutes)
  await advancePaymentReturnPolls(page, p.order.order_ref, 24);
  expect(pollCounter).toBe(25); // 1 initial + 24 polls

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('付款結果確認中');
  await expect(page.locator('#shop-pay-return')).toContainText(
    '目前還沒有確認結果。你可以重新查詢，或稍後到訂單頁查看；請不要重複付款。',
  );
  const reQueryBtn = page.getByRole('button', { name: '重新查詢', exact: true });
  const laterLink = page.getByRole('link', { name: '稍後再看', exact: true });
  await expect(reQueryBtn).toBeVisible();
  await expect(reQueryBtn).toBeEnabled();
  await expect(laterLink).toHaveAttribute('href', `/shops/${p.store.slug}/orders/${p.order.order_ref}`);

  // Manual query 1: 409 payment_result_pending with Retry-After: 30
  const baseDto = await readOrderDtoWithPageCookies(page, p.store.slug, p.order.order_ref);
  const pendingError = buildVerifiedError(409, 'payment_result_pending', '結果尚未確認。');
  const stillCheckingOrder = buildVerifiedOrder(baseDto, {
    payment_state: 'pending',
    can_resume_payment: false,
  });
  const confirmedOrder = buildVerifiedOrder(baseDto, {
    payment_state: 'confirmed',
    can_resume_payment: false,
  });

  let queryAttempt = 0;
  await page.route(`**${orderApiPath}/payment-queries`, async route => {
    queryAttempt += 1;
    if (queryAttempt === 1) {
      await route.fulfill({
        status: 409,
        headers: { 'Retry-After': '30' },
        contentType: 'application/json',
        body: JSON.stringify(pendingError),
      });
      return;
    }
    if (queryAttempt === 2) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(stillCheckingOrder),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(confirmedOrder),
    });
  });

  await reQueryBtn.click();
  await expect(page.getByRole('alert')).toHaveText('暫時無法確認這次付款的結果，請不要重複付款。');
  await expect(reQueryBtn).toBeDisabled();

  await page.clock.runFor(29_000);
  await expect(reQueryBtn).toBeDisabled();
  await page.clock.runFor(1_000);
  await expect(reQueryBtn).toBeEnabled();

  // Manual query 2: 200 but still checking -> status shows "{HH:mm} 已查詢，仍在確認中。" and no new auto-polling
  await reQueryBtn.click();
  await expect(page.getByRole('status')).toHaveText(/^[0-9]{2}:[0-9]{2} 已查詢，仍在確認中。$/);
  await page.clock.runFor(10_000);
  expect(pollCounter).toBe(25);

  // Manual query 3: 200 confirmed -> 已收到付款 and focus moves to h1
  await reQueryBtn.click();
  const h1 = page.getByRole('heading', { level: 1, name: '已收到付款' });
  await expect(h1).toBeVisible();
  await expect(h1).toBeFocused();
  await expect(page.getByRole('status')).toHaveText('已收到付款');
});

test('4 & 5. Failure and Simulated: 付款失敗 follows DTO can_resume_payment on B06 and B07; 模擬付款 never shows 已收到付款, 已付款, 模擬 or 測試', async ({
  page,
  browser,
  baseURL,
  e2eAuthPool,
}) => {
  // #4 Failure
  const p = await createE2ePaymentOrder(e2eAuthPool, browser, baseURL!, page.context());
  await page.goto(p.payment.handoff_url);
  await page.getByRole('button', { name: '付款失敗', exact: true }).click();
  await page.getByRole('button', { name: '返回商店查看結果', exact: true }).click();

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('付款未完成');
  await expect(page.locator('#shop-pay-return')).toContainText('這次付款沒有完成，沒有扣款。');

  const dto = await readOrderDtoWithPageCookies(page, p.store.slug, p.order.order_ref);
  await expect(page.getByRole('button', { name: '重新付款', exact: true })).toHaveCount(
    dto.can_resume_payment ? 1 : 0,
  );

  await page.getByRole('link', { name: '查看訂單', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`訂單 ${p.order.display_number}`);
  const paymentSection = page.getByRole('region', { name: '付款' });
  await expect(paymentSection).toContainText('付款未完成');
  await expect(paymentSection).toContainText('這次付款沒有完成，沒有扣款。');
  await expect(page.getByRole('button', { name: '重新付款', exact: true })).toHaveCount(
    dto.can_resume_payment ? 1 : 0,
  );

  // #5 Simulated
  const sim = await placeAdditionalPaymentOrder(baseURL!, page.context(), p.store.slug, p.store.product.sku);
  await page.goto(sim.payment.handoff_url);
  await page.getByRole('button', { name: '模擬付款', exact: true }).click();
  await page.getByRole('button', { name: '返回商店查看結果', exact: true }).click();

  await expect(page.locator('#shop-pay-return')).toContainText(`訂單 ${sim.order.display_number}`);
  const b06SimText = await page.locator('#shop-pay-return').innerText();
  expect(b06SimText).not.toContain('已收到付款');
  expect(b06SimText).not.toContain('已付款');
  expect(b06SimText).not.toContain('模擬');
  expect(b06SimText).not.toContain('測試');

  await page.goto(`/shops/${p.store.slug}/orders/${sim.order.order_ref}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`訂單 ${sim.order.display_number}`);
  const b07SimText = await page.locator('#shop-order').innerText();
  expect(b07SimText).not.toContain('已收到付款');
  expect(b07SimText).not.toContain('已付款');
  expect(b07SimText).not.toContain('模擬');
  expect(b07SimText).not.toContain('測試');
});

test('6 & 8. Back link without paying and back-forward cache: 返回商店 and page.goBack() show awaiting_result view on B07', async ({
  page,
  browser,
  baseURL,
  e2eAuthPool,
}) => {
  const p = await createE2ePaymentOrder(e2eAuthPool, browser, baseURL!, page.context());
  const orderPath = `/shops/${p.store.slug}/orders/${p.order.order_ref}`;

  await page.goto(orderPath);
  await page.getByRole('button', { name: '前往付款', exact: true }).click();
  await expect(page.getByRole('heading', { name: '本機付款測試', exact: true })).toBeVisible();

  // #8 Back-forward cache: page.goBack() returns to B07 and re-reads current awaiting_result state
  await page.goBack();
  await expect(page).toHaveURL(`${baseURL}${orderPath}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`訂單 ${p.order.display_number}`);
  const paymentSection = page.getByRole('region', { name: '付款' });
  await expect(paymentSection).toContainText('付款確認中');
  await expect(paymentSection).toContainText('還沒收到這次付款的結果。');
  await expect(paymentSection.getByRole('button', { name: '查詢付款結果', exact: true })).toBeEnabled();

  // Also test synthetic pageshow with persisted=true while in redirecting state
  const second = await placeAdditionalPaymentOrder(baseURL!, page.context(), p.store.slug, p.store.product.sku);
  const secondOrderPath = `/shops/${p.store.slug}/orders/${second.order.order_ref}`;
  await page.goto(secondOrderPath);
  await page.getByRole('button', { name: '前往付款', exact: true }).click();
  await expect(page.getByRole('heading', { name: '本機付款測試', exact: true })).toBeVisible();

  // #6 Click 返回商店 on the fixture page -> 303 to B07 with awaiting_result view
  await page.getByRole('link', { name: '返回商店', exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}${secondOrderPath}`);
  await expect(page.getByRole('region', { name: '付款' })).toContainText('付款確認中');
  await expect(page.getByRole('region', { name: '付款' })).toContainText('還沒收到這次付款的結果。');
  await expect(
    page.getByRole('region', { name: '付款' }).getByRole('button', { name: '查詢付款結果', exact: true }),
  ).toBeVisible();

  const currentDto = await readOrderDtoWithPageCookies(page, p.store.slug, second.order.order_ref);
  await expect(page.getByRole('button', { name: '重新付款', exact: true })).toHaveCount(
    currentDto.can_resume_payment ? 1 : 0,
  );
});

test('7. B07 actions with page.route: every §2 outcome row for startPayment and queryPayment, Retry-After rounding, pending hide surviving re-read, evil handoff_url and network failures', async ({
  page,
  browser,
  baseURL,
  e2eAuthPool,
}) => {
  const p = await createE2ePaymentOrder(e2eAuthPool, browser, baseURL!, page.context());
  // Fix clock at 2026-10-16T02:05:15.000Z = 10:05:15 Asia/Taipei
  await page.clock.install({ time: new Date('2026-10-16T02:05:15.000Z') });

  const baseDto = await readOrderDtoWithPageCookies(page, p.store.slug, p.order.order_ref);
  const orderPath = `/shops/${p.store.slug}/orders/${p.order.order_ref}`;
  const orderApiPath = `/api/v1/public/stores/${p.store.slug}/orders/${p.order.order_ref}`;

  let currentOrder = buildVerifiedOrder(baseDto, {
    payment_state: 'unpaid',
    latest_payment_attempt: {
      attempt_ref: p.payment.attempt_ref,
      state: 'awaiting_result',
      created_at: '2026-10-16T02:00:00.000Z',
    },
    can_resume_payment: true,
  });
  let getOrderCount = 0;
  let returnsNotFound = false;

  await page.route(`**${orderApiPath}`, async route => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    getOrderCount += 1;
    if (returnsNotFound) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify(buildVerifiedError(404, 'checkout_order_not_found', '找不到訂單。')),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(currentOrder),
    });
  });

  type MockResponseSpec =
    | { kind: 'abort' }
    | { status: number; headers?: Record<string, string>; body: unknown };

  let nextHandoffSpec: MockResponseSpec = { kind: 'abort' };
  await page.route(`**${orderApiPath}/payment-handoffs`, async route => {
    const spec = nextHandoffSpec;
    if ('kind' in spec) {
      await route.abort('failed');
      return;
    }
    await route.fulfill({
      status: spec.status,
      headers: spec.headers,
      contentType: 'application/json',
      body: JSON.stringify(spec.body),
    });
  });

  let nextQuerySpec: MockResponseSpec = { kind: 'abort' };
  await page.route(`**${orderApiPath}/payment-queries`, async route => {
    const spec = nextQuerySpec;
    if ('kind' in spec) {
      await route.abort('failed');
      return;
    }
    await route.fulfill({
      status: spec.status,
      headers: spec.headers,
      contentType: 'application/json',
      body: JSON.stringify(spec.body),
    });
  });

  await page.goto(orderPath);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`訂單 ${p.order.display_number}`);
  expect(getOrderCount).toBe(1);

  const actionSection = page.getByRole('region', { name: '需要你處理' });
  const paymentSection = page.getByRole('region', { name: '付款' });
  await expect(actionSection).toContainText(
    '如果你沒有完成付款，可以重新付款；我們會先向付款服務確認，不會重複扣款。',
  );
  const repayBtn = actionSection.getByRole('button', { name: '重新付款', exact: true });
  const queryBtn = paymentSection.getByRole('button', { name: '查詢付款結果', exact: true });

  // --- startPayment outcomes ---
  // 1. refused: checkout_hold_expired (re-reads order + shows cart link)
  nextHandoffSpec = {
    status: 409,
    body: buildVerifiedError(409, 'checkout_hold_expired', '保留時間已結束。'),
  };
  await repayBtn.click();
  await expect(actionSection.getByRole('alert')).toContainText('保留時間已結束，請回到購物車重新下單。');
  await expect(actionSection.getByRole('link', { name: '前往購物車', exact: true })).toHaveAttribute(
    'href',
    `/shops/${p.store.slug}/cart`,
  );
  expect(getOrderCount).toBe(2);

  // 2–6. refused codes that re-read the order
  for (const [code, expectedCopy] of [
    ['payment_already_applied', '這筆訂單已收到付款。'],
    ['payment_attempts_exhausted', '付款次數已達上限，請聯絡店家。'],
    ['checkout_order_closed', '這筆訂單已結束，不能再付款。'],
    ['payment_handoff_unavailable', '目前無法前往付款，請稍後再試。'],
    ['checkout_not_enabled', '這間店目前沒有開放線上付款。'],
  ] as const) {
    const beforeGets = getOrderCount;
    nextHandoffSpec = {
      status: 409,
      body: buildVerifiedError(409, code, expectedCopy),
    };
    await repayBtn.click();
    await expect(actionSection.getByRole('alert')).toHaveText(expectedCopy);
    expect(getOrderCount).toBe(beforeGets + 1);
  }

  // 7. pending: hides 重新付款/前往付款 for Retry-After seconds, surviving re-read with can_resume_payment: true
  {
    const beforeGets = getOrderCount;
    nextHandoffSpec = {
      status: 409,
      headers: { 'Retry-After': '25' },
      body: buildVerifiedError(409, 'payment_result_pending', '確認中。'),
    };
    await repayBtn.click();
    await expect(actionSection.getByRole('alert')).toHaveText(
      '暫時無法確認這次付款的結果，請不要重複付款。',
    );
    expect(getOrderCount).toBe(beforeGets + 1);
    await expect(repayBtn).toHaveCount(0);

    await page.clock.runFor(24_000);
    await expect(repayBtn).toHaveCount(0);
    await page.clock.runFor(1_000);
    await expect(repayBtn).toBeVisible();
  }

  // 8. rate_limited: Retry-After: 20 from 10:05:40 Taipei -> 10:06:00 -> 10:06; disables button for 20s, no GET
  // Advance 30s first so current time is 10:06:10 Taipei, then Retry-After: 15 -> 10:06:25 rounds up to 10:07!
  await page.clock.runFor(30_000);
  {
    const beforeGets = getOrderCount;
    nextHandoffSpec = {
      status: 429,
      headers: { 'Retry-After': '15' },
      body: buildVerifiedError(429, 'commerce_rate_limited', '太頻繁。'),
    };
    await repayBtn.click();
    await expect(actionSection.getByRole('alert')).toHaveText('操作太頻繁，請在 10:07 後再試。');
    expect(getOrderCount).toBe(beforeGets);
    await expect(repayBtn).toBeDisabled();
    await expect(queryBtn).toBeEnabled();

    await page.clock.runFor(14_000);
    await expect(repayBtn).toBeDisabled();
    await page.clock.runFor(1_000);
    await expect(repayBtn).toBeEnabled();
  }

  // 9. paused (503 commerce_quarantined): no GET
  {
    const beforeGets = getOrderCount;
    nextHandoffSpec = {
      status: 503,
      body: buildVerifiedError(503, 'commerce_quarantined', '暫停中。'),
    };
    await repayBtn.click();
    await expect(actionSection.getByRole('alert')).toHaveText('商店服務暫停中，請稍後再試。');
    expect(getOrderCount).toBe(beforeGets);
  }

  // 10. payment_unavailable (other 503): no GET
  {
    const beforeGets = getOrderCount;
    nextHandoffSpec = {
      status: 503,
      body: buildVerifiedError(503, 'payment_profile_unavailable', '金流維護中。'),
    };
    await repayBtn.click();
    await expect(actionSection.getByRole('alert')).toHaveText(
      '付款服務暫時無法使用，訂單與保留的商品不受影響，請稍後再試。',
    );
    expect(getOrderCount).toBe(beforeGets);
  }

  // 11. 201 with evil handoff_url: no navigation, no GET, failure text
  {
    const beforeGets = getOrderCount;
    nextHandoffSpec = {
      status: 201,
      body: {
        handoff_url: 'https://evil.example/pay',
        attempt_ref: p.payment.attempt_ref,
        expires_at: '2026-10-16T03:00:00.000Z',
      },
    };
    await repayBtn.click();
    await expect(actionSection.getByRole('alert')).toHaveText('無法完成，請稍後重試。');
    expect(page.url()).toBe(`${baseURL}${orderPath}`);
    expect(getOrderCount).toBe(beforeGets);
  }

  // 12. network failure on startPayment: no GET, failure text
  {
    const beforeGets = getOrderCount;
    nextHandoffSpec = { kind: 'abort' };
    await repayBtn.click();
    await expect(actionSection.getByRole('alert')).toHaveText('無法完成，請稍後重試。');
    expect(getOrderCount).toBe(beforeGets);
  }

  // --- queryPayment outcomes ---
  // 1. pending on queryPayment: hides 重新付款 for Retry-After seconds, re-reads order
  {
    const beforeGets = getOrderCount;
    nextQuerySpec = {
      status: 409,
      headers: { 'Retry-After': '10' },
      body: buildVerifiedError(409, 'payment_result_pending', '確認中。'),
    };
    await queryBtn.click();
    await expect(paymentSection.getByRole('alert')).toHaveText(
      '暫時無法確認這次付款的結果，請不要重複付款。',
    );
    expect(getOrderCount).toBe(beforeGets + 1);
    await expect(repayBtn).toHaveCount(0);
    await page.clock.runFor(10_000);
    await expect(repayBtn).toBeVisible();
  }

  // 2. refused checkout_not_enabled on queryPayment: re-reads order
  {
    const beforeGets = getOrderCount;
    nextQuerySpec = {
      status: 409,
      body: buildVerifiedError(409, 'checkout_not_enabled', '未開放。'),
    };
    await queryBtn.click();
    await expect(paymentSection.getByRole('alert')).toHaveText('這間店目前沒有開放線上付款。');
    expect(getOrderCount).toBe(beforeGets + 1);
  }

  // 3. rate_limited on queryPayment: Retry-After: 15 at 10:06:35 Taipei -> 10:06:50 rounds up to 10:07; no GET
  {
    const beforeGets = getOrderCount;
    nextQuerySpec = {
      status: 429,
      headers: { 'Retry-After': '15' },
      body: buildVerifiedError(429, 'commerce_rate_limited', '太頻繁。'),
    };
    await queryBtn.click();
    await expect(paymentSection.getByRole('alert')).toHaveText('操作太頻繁，請在 10:07 後再試。');
    expect(getOrderCount).toBe(beforeGets);
    await expect(queryBtn).toBeDisabled();
    await page.clock.runFor(15_000);
    await expect(queryBtn).toBeEnabled();
  }

  // 4. paused, payment_unavailable, network failure on queryPayment: no GET
  for (const [spec, expectedText] of [
    [
      { status: 503, body: buildVerifiedError(503, 'commerce_quarantined', '暫停中。') },
      '商店服務暫停中，請稍後再試。',
    ],
    [
      { status: 503, body: buildVerifiedError(503, 'payment_profile_unavailable', '維護中。') },
      '付款服務暫時無法使用，訂單與保留的商品不受影響，請稍後再試。',
    ],
    [{ kind: 'abort' as const }, '無法完成，請稍後重試。'],
  ] as const) {
    const beforeGets = getOrderCount;
    nextQuerySpec = spec;
    await queryBtn.click();
    await expect(paymentSection.getByRole('alert')).toHaveText(expectedText);
    expect(getOrderCount).toBe(beforeGets);
  }

  // 5. ok (still awaiting): status reads "{HH:mm} 已查詢：付款確認中", no extra GET
  {
    const beforeGets = getOrderCount;
    nextQuerySpec = {
      status: 200,
      body: currentOrder,
    };
    await queryBtn.click();
    await expect(paymentSection.getByRole('status')).toHaveText('10:06 已查詢：付款確認中');
    expect(getOrderCount).toBe(beforeGets);
  }

  // 6. ok (now confirmed): replaces order, status reads "{HH:mm} 已查詢：已付款", button disappears, focus moves to 付款 h2
  {
    const beforeGets = getOrderCount;
    const paidOrder = buildVerifiedOrder(currentOrder, {
      payment_state: 'confirmed',
      can_resume_payment: false,
    });
    nextQuerySpec = {
      status: 200,
      body: paidOrder,
    };
    await queryBtn.click();
    await expect(paymentSection).toContainText('已付款');
    await expect(paymentSection.getByRole('status')).toHaveText('10:06 已查詢：已付款');
    await expect(queryBtn).toHaveCount(0);
    await expect(paymentSection.getByRole('heading', { level: 2, name: '付款' })).toBeFocused();
    expect(getOrderCount).toBe(beforeGets);
  }

  // 7. not_found on startPayment: re-reads order -> 404 shows not-found view
  currentOrder = buildVerifiedOrder(baseDto, {
    payment_state: 'unpaid',
    can_resume_payment: true,
  });
  await page.reload();
  const readyPayBtn = page.getByRole('button', { name: '前往付款', exact: true });
  await expect(readyPayBtn).toBeVisible();
  {
    const beforeGets = getOrderCount;
    returnsNotFound = true;
    nextHandoffSpec = {
      status: 404,
      body: buildVerifiedError(404, 'checkout_order_not_found', '找不到訂單。'),
    };
    await readyPayBtn.click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('找不到這筆訂單');
    expect(getOrderCount).toBe(beforeGets + 1);
  }
});

test('9, 11, 12, 13, 14. No access & member access, EC-AT18, Review (overpaid), Keyboard, No JS and Isolation', async ({
  browser,
  baseURL,
  e2eAuthPool,
}) => {
  const { store, guestOrder, guestPayment, memberOrder, memberPayment } =
    await createMemberPaymentOrder(e2eAuthPool, browser, baseURL!);

  const guestReturnPath = `/shops/${store.slug}/payment-return/${guestPayment.attempt_ref}`;
  const memberReturnPath = `/shops/${store.slug}/payment-return/${memberPayment.attempt_ref}`;

  // #9a: Fresh context (no cookies) -> no-access view with 找回訂單
  const freshContext = await browser.newContext({ baseURL });
  try {
    const freshPage = await freshContext.newPage();
    await freshPage.goto(guestReturnPath);
    await expect(freshPage.getByRole('heading', { level: 1 })).toHaveText(
      '無法在這個瀏覽器查看付款結果',
    );
    await expect(freshPage.locator('#shop-pay-return')).toContainText(
      '這個瀏覽器沒有這筆訂單的查看權限。訂單只能在下單時使用的瀏覽器，或以下單時登入的會員帳號查看。',
    );
    await expect(freshPage.getByRole('link', { name: '找回訂單', exact: true })).toHaveAttribute(
      'href',
      `/shops/${store.slug}/order-access`,
    );
    await expect(
      freshPage.getByRole('link', { name: `回到「${guestOrder.store.name}」`, exact: true }),
    ).toHaveAttribute('href', `/shops/${store.slug}`);
  } finally {
    await freshContext.close();
  }

  // #9b: Member who placed the order sees the order on B06 in a context with only the member session
  // plus #11 EC-AT18, #12 Keyboard, #13 Review (overpaid), and #14 Isolation
  const memberOnlyContext = await browser.newContext({ baseURL });
  try {
    await apiLogin(memberOnlyContext, baseURL!, store.buyer.email);
    const cookies = await memberOnlyContext.cookies();
    expect(cookies.find(c => c.name === 'freedom_local_shop')).toBeUndefined();

    const page = await memberOnlyContext.newPage();
    const recordedRequests: string[] = [];
    page.on('request', req => recordedRequests.push(req.url()));

    // #11 EC-AT18: B06 of an unpaid order opened with ?RtnCode=1&TradeStatus=1#paid never shows 已收到付款
    await page.goto(`${memberReturnPath}?RtnCode=1&TradeStatus=1#paid`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('尚未付款');
    await expect(page.locator('#shop-pay-return')).toContainText(`訂單 ${memberOrder.display_number}`);
    expect(await page.locator('#shop-pay-return').innerText()).not.toContain('已收到付款');

    // #14 Isolation: only /shops.css, scripts only from /assets/, no external requests
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
    expect(recordedRequests.every(url => new URL(url).origin === new URL(baseURL!).origin)).toBe(true);

    // #12 Keyboard: first Tab on B06 focuses 跳到主要內容; 前往付款, 查詢付款結果, 重新查詢 and 查看訂單 work by keyboard alone
    await page.goto(memberReturnPath);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('尚未付款');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: '跳到主要內容', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main')).toBeFocused();

    // Activate 查看訂單 by keyboard
    const viewOrderLink = page.getByRole('link', { name: '查看訂單', exact: true });
    await viewOrderLink.focus();
    await expect(viewOrderLink).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`${baseURL}/shops/${store.slug}/orders/${memberOrder.order_ref}`);

    // Activate 前往付款 by keyboard on B07 -> navigates to fixture checkout -> 返回商店 returns to B07 awaiting_result
    const startPayBtn = page.getByRole('button', { name: '前往付款', exact: true });
    await startPayBtn.focus();
    await expect(startPayBtn).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: '本機付款測試', exact: true })).toBeVisible();
    await page.getByRole('link', { name: '返回商店', exact: true }).click();
    await expect(page).toHaveURL(`${baseURL}/shops/${store.slug}/orders/${memberOrder.order_ref}`);

    const memberOrderApi = `**/api/v1/public/stores/${store.slug}/orders/${memberOrder.order_ref}`;
    await page.route(`${memberOrderApi}/payment-queries`, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          buildVerifiedOrder(memberOrder, {
            payment_state: 'pending',
            can_resume_payment: false,
          }),
        ),
      });
    });

    // Activate 查詢付款結果 by keyboard on B07
    const b07QueryBtn = page.getByRole('button', { name: '查詢付款結果', exact: true });
    await b07QueryBtn.focus();
    await expect(b07QueryBtn).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: '付款' }).getByRole('status')).toHaveText(
      /^[0-9]{2}:[0-9]{2} 已查詢：付款確認中$/,
    );

    // B06 initial load failure (503) -> shows 付款結果確認中, alert, and 重試 button;
    // pressing Enter on 重試 recovers to checking -> after 24 polls, activate 重新查詢 by keyboard
    await page.clock.install();
    let b06Mode: 'fail_503' | 'paid' | 'pending' = 'fail_503';
    await page.route(memberOrderApi, async route => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      if (b06Mode === 'fail_503') {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify(buildVerifiedError(503, 'commerce_quarantined', '暫停中。')),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          buildVerifiedOrder(memberOrder, {
            payment_state: b06Mode === 'paid' ? 'confirmed' : 'pending',
            can_resume_payment: false,
          }),
        ),
      });
    });

    await page.goto(memberReturnPath);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('付款結果確認中');
    await expect(page.getByRole('alert')).toHaveText('商店服務暫停中，請稍後再試。');
    b06Mode = 'paid';
    const retryBtn = page.getByRole('button', { name: '重試', exact: true });
    await retryBtn.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: '已收到付款' })).toBeFocused();
    await expect(page.getByRole('status')).toHaveText('已收到付款');

    b06Mode = 'pending';
    await page.goto(memberReturnPath);
    await expect(page.locator('#shop-pay-return')).toContainText(
      '已回到商店，正在向付款服務確認結果，請不要重複付款。',
    );
    await advancePaymentReturnPolls(page, memberOrder.order_ref, 24);
    const reQueryBtn = page.getByRole('button', { name: '重新查詢', exact: true });
    await reQueryBtn.focus();
    await expect(reQueryBtn).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status')).toHaveText(/^[0-9]{2}:[0-9]{2} 已查詢，仍在確認中。$/);
    await page.unroute(`${memberOrderApi}/payment-queries`);
    await page.unroute(memberOrderApi);

    // #13 Review: payment_state: 'overpaid' (open order with can_resume_payment: true, and cancelled one)
    let overpaidVariant: 'open' | 'cancelled' = 'open';
    let reviewGets = 0;
    await page.route(memberOrderApi, async route => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      reviewGets += 1;
      const body =
        overpaidVariant === 'open'
          ? buildVerifiedOrder(memberOrder, {
              lifecycle_state: 'open',
              cancel_reason: null,
              payment_state: 'overpaid',
              can_resume_payment: true,
            })
          : buildVerifiedOrder(memberOrder, {
              lifecycle_state: 'cancelled',
              cancel_reason: 'buyer_cancelled',
              payment_state: 'overpaid',
              can_resume_payment: false,
            });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    });

    for (const variant of ['open', 'cancelled'] as const) {
      overpaidVariant = variant;
      reviewGets = 0;
      await page.goto(memberReturnPath);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('付款金額待店家確認');
      await expect(page.locator('#shop-pay-return')).toContainText(
        '我們收到的付款和這筆訂單不符，店家會確認並處理退款。請不要再付款。',
      );
      await expect(page.getByRole('button', { name: /前往付款|重新付款/ })).toHaveCount(0);
      expect(reviewGets).toBe(1);
      await page.clock.runFor(15_000);
      expect(reviewGets).toBe(1); // B06 polling stops at once

      await page.goto(`/shops/${store.slug}/orders/${memberOrder.order_ref}`);
      await expect(page.getByRole('region', { name: '付款' })).toContainText('付款金額待店家確認');
      await expect(page.getByRole('region', { name: '付款' })).toContainText(
        '我們收到的付款和這筆訂單不符，店家會確認並處理退款。請不要再付款。',
      );
      await expect(page.getByRole('region', { name: '需要你處理' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /前往付款|重新付款/ })).toHaveCount(0);
    }
    await page.unroute(memberOrderApi);
  } finally {
    await memberOnlyContext.close();
  }

  // #13 No JavaScript: B06 shows its noscript text and 查看訂單 link
  const noJsContext = await browser.newContext({ baseURL, javaScriptEnabled: false });
  try {
    const noJsPage = await noJsContext.newPage();
    await noJsPage.goto(memberReturnPath);
    const noscriptNotice = noJsPage.locator('#shop-pay-return noscript p').first();
    await expect(noscriptNotice).toBeVisible();
    await expect(noscriptNotice).toHaveText('確認付款結果需要開啟瀏覽器的 JavaScript。');
    const noscriptLink = noJsPage.locator('#shop-pay-return noscript a');
    await expect(noscriptLink).toBeVisible();
    await expect(noscriptLink).toHaveText('查看訂單');
    await expect(noscriptLink).toHaveAttribute('href', `/shops/${store.slug}/orders/${memberOrder.order_ref}`);
  } finally {
    await noJsContext.close();
  }
});

test('15. Responsive layout and full-page screenshots across 1440, 1280, 768, 390 and 320 for B06 and B07 payment states including 80-char store name', async ({
  page,
  browser,
  baseURL,
  e2eAuthPool,
}, info) => {
  const p = await createE2ePaymentOrder(e2eAuthPool, browser, baseURL!, page.context());
  await page.clock.install({ time: new Date('2026-10-16T02:00:00.000Z') });

  const baseDto = await readOrderDtoWithPageCookies(page, p.store.slug, p.order.order_ref);
  const returnPath = `/shops/${p.store.slug}/payment-return/${p.payment.attempt_ref}`;
  const orderPath = `/shops/${p.store.slug}/orders/${p.order.order_ref}`;
  const orderApi = `**/api/v1/public/stores/${p.store.slug}/orders/${p.order.order_ref}`;

  let activeOrder = baseDto;
  let force404 = false;
  await page.route(orderApi, async route => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    if (force404) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify(buildVerifiedError(404, 'checkout_order_not_found', '找不到訂單。')),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(activeOrder),
    });
  });

  await page.route(`${orderApi}/payment-queries`, async route => {
    await route.fulfill({
      status: 409,
      headers: { 'Retry-After': '60' },
      contentType: 'application/json',
      body: JSON.stringify(buildVerifiedError(409, 'payment_result_pending', '確認中。')),
    });
  });

  await page.route(`${orderApi}/payment-handoffs`, async route => {
    await route.fulfill({
      status: 409,
       contentType: 'application/json',
      body: JSON.stringify(buildVerifiedError(409, 'checkout_hold_expired', '保留時間已結束。')),
    });
  });

  // --- B06 layout states ---
  // 1. B06 確認中 (checking while polling) + 2. B06 after polling + 5. B06 結果不明
  activeOrder = buildVerifiedOrder(baseDto, {
    payment_state: 'pending',
    can_resume_payment: false,
  });
  await page.goto(returnPath);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('付款結果確認中');
  await assertResponsiveLayout(page, RESPONSIVE_WIDTHS, w => info.outputPath(`b06-checking-${w}.png`));

  await advancePaymentReturnPolls(page, p.order.order_ref, 24);
  await expect(page.getByRole('button', { name: '重新查詢', exact: true })).toBeVisible();
  await assertResponsiveLayout(page, RESPONSIVE_WIDTHS, w => info.outputPath(`b06-after-polling-${w}.png`));

  await page.getByRole('button', { name: '重新查詢', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('暫時無法確認這次付款的結果，請不要重複付款。');
  await assertResponsiveLayout(page, RESPONSIVE_WIDTHS, w => info.outputPath(`b06-result-unknown-${w}.png`));

  // 3. B06 已收到付款
  activeOrder = buildVerifiedOrder(baseDto, {
    payment_state: 'confirmed',
    can_resume_payment: false,
  });
  await page.goto(returnPath);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('已收到付款');
  await assertResponsiveLayout(page, RESPONSIVE_WIDTHS, w => info.outputPath(`b06-paid-${w}.png`));

  // 4. B06 付款未完成
  activeOrder = buildVerifiedOrder(baseDto, {
    payment_state: 'unpaid',
    latest_payment_attempt: {
      attempt_ref: p.payment.attempt_ref,
      state: 'failed',
      created_at: '2026-10-16T01:00:00.000Z',
    },
    can_resume_payment: true,
  });
  await page.goto(returnPath);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('付款未完成');
  await assertResponsiveLayout(page, RESPONSIVE_WIDTHS, w => info.outputPath(`b06-failed-${w}.png`));

  // 6. B06 尚未付款
  activeOrder = buildVerifiedOrder(baseDto, {
    payment_state: 'unpaid',
    latest_payment_attempt: {
      attempt_ref: p.payment.attempt_ref,
      state: 'ready',
      created_at: '2026-10-16T01:00:00.000Z',
    },
    can_resume_payment: true,
  });
  await page.goto(returnPath);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('尚未付款');
  await assertResponsiveLayout(page, RESPONSIVE_WIDTHS, w => info.outputPath(`b06-ready-${w}.png`));

  // 7. B06 付款期限已過 (plus closed coverage)
  activeOrder = buildVerifiedOrder(baseDto, {
    payment_state: 'unpaid',
    reservation_expired: true,
    can_resume_payment: false,
  });
  await page.goto(returnPath);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('付款期限已過');
  await assertResponsiveLayout(page, RESPONSIVE_WIDTHS, w => info.outputPath(`b06-expired-${w}.png`));

  activeOrder = buildVerifiedOrder(baseDto, {
    lifecycle_state: 'cancelled',
    cancel_reason: 'buyer_cancelled',
    payment_state: 'unpaid',
    can_resume_payment: false,
  });
  await page.goto(returnPath);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('訂單已取消');
  await expect(page.locator('#shop-pay-return')).toContainText('這筆訂單已取消，不能再付款。');

  // 8. B06 no access
  force404 = true;
  await page.goto(returnPath);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('無法在這個瀏覽器查看付款結果');
  await assertResponsiveLayout(page, RESPONSIVE_WIDTHS, w => info.outputPath(`b06-no-access-${w}.png`));
  force404 = false;

  // 9. B06 missing
  await page.goto(`/shops/${p.store.slug}/payment-return/${randomUUID()}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('找不到這次付款');
  await assertResponsiveLayout(page, RESPONSIVE_WIDTHS, w => info.outputPath(`b06-missing-${w}.png`));

  // --- B07 layout states ---
  // 1. B07 ready with 前往付款 + 6. B07 action alert
  activeOrder = buildVerifiedOrder(baseDto, {
    payment_state: 'unpaid',
    latest_payment_attempt: {
      attempt_ref: p.payment.attempt_ref,
      state: 'ready',
      created_at: '2026-10-16T01:00:00.000Z',
    },
    can_resume_payment: true,
  });
  await page.goto(orderPath);
  await expect(page.getByRole('button', { name: '前往付款', exact: true })).toBeVisible();
  await assertResponsiveLayout(page, RESPONSIVE_WIDTHS, w => info.outputPath(`b07-ready-${w}.png`));

  await page.getByRole('button', { name: '前往付款', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('保留時間已結束，請回到購物車重新下單。');
  await assertResponsiveLayout(page, RESPONSIVE_WIDTHS, w => info.outputPath(`b07-action-alert-${w}.png`));

  // 2. B07 failed with 重新付款
  activeOrder = buildVerifiedOrder(baseDto, {
    payment_state: 'unpaid',
    latest_payment_attempt: {
      attempt_ref: p.payment.attempt_ref,
      state: 'failed',
      created_at: '2026-10-16T01:00:00.000Z',
    },
    can_resume_payment: true,
  });
  await page.goto(orderPath);
  await expect(page.getByRole('button', { name: '重新付款', exact: true })).toBeVisible();
  await assertResponsiveLayout(page, RESPONSIVE_WIDTHS, w => info.outputPath(`b07-failed-${w}.png`));

  // 3. B07 awaiting with 重新付款
  activeOrder = buildVerifiedOrder(baseDto, {
    payment_state: 'unpaid',
    latest_payment_attempt: {
      attempt_ref: p.payment.attempt_ref,
      state: 'awaiting_result',
      created_at: '2026-10-16T01:00:00.000Z',
    },
    can_resume_payment: true,
  });
  await page.goto(orderPath);
  await expect(page.getByRole('button', { name: '重新付款', exact: true })).toBeVisible();
  await assertResponsiveLayout(page, RESPONSIVE_WIDTHS, w => info.outputPath(`b07-awaiting-${w}.png`));

  // 4. B07 checking
  activeOrder = buildVerifiedOrder(baseDto, {
    payment_state: 'pending',
    can_resume_payment: false,
  });
  await page.goto(orderPath);
  await expect(page.getByRole('button', { name: '查詢付款結果', exact: true })).toBeVisible();
  await assertResponsiveLayout(page, RESPONSIVE_WIDTHS, w => info.outputPath(`b07-checking-${w}.png`));

  // 5. B07 paid
  activeOrder = buildVerifiedOrder(baseDto, {
    payment_state: 'confirmed',
    can_resume_payment: false,
  });
  await page.goto(orderPath);
  await expect(page.getByRole('region', { name: '付款' })).toContainText('已付款');
  await assertResponsiveLayout(page, RESPONSIVE_WIDTHS, w => info.outputPath(`b07-paid-${w}.png`));

  // 10. B06 with an 80-character store name across all widths
  const longStoreName = '山邊小店合成長名測試'.repeat(8);
  expect([...longStoreName].length).toBe(80);
  const sellerContext = await browser.newContext({ baseURL });
  try {
    const session = await apiLogin(sellerContext, baseURL!, p.store.seller.email);
    const headers = (version?: string) => ({
      Origin: baseURL!,
      'X-CSRF-Token': session.csrf_token,
      'Idempotency-Key': randomUUID(),
      ...(version ? { 'If-Match': `"${version}"` } : {}),
    });
    const beforeStore = StoreViewSchema.parse(
      await (await sellerContext.request.get(`/api/v1${p.store.root}`)).json(),
    );
    const patchRes = await sellerContext.request.patch(`/api/v1${p.store.root}`, {
      data: { name: longStoreName },
      headers: headers(beforeStore.version!),
    });
    expect(patchRes.status()).toBe(200);
    const afterStore = StoreViewSchema.parse(
      await (await sellerContext.request.get(`/api/v1${p.store.root}`)).json(),
    );
    const publishRes = await sellerContext.request.post(`/api/v1${p.store.root}/publish`, {
      data: {},
      headers: headers(afterStore.version!),
    });
    expect(publishRes.status()).toBe(200);
  } finally {
    await sellerContext.close();
  }

  activeOrder = buildVerifiedOrder(baseDto, {
    store: { slug: p.store.slug, name: longStoreName },
    payment_state: 'unpaid',
    latest_payment_attempt: {
      attempt_ref: p.payment.attempt_ref,
      state: 'ready',
      created_at: '2026-10-16T01:00:00.000Z',
    },
    can_resume_payment: true,
  });
  await page.goto(returnPath);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('尚未付款');
  await assertResponsiveLayout(page, RESPONSIVE_WIDTHS, w => info.outputPath(`b06-long-store-name-${w}.png`));
});

const row = async (db: Pool, id: string) =>
  (await db.query('SELECT * FROM commerce_payment_attempts WHERE attempt_id=$1', [id])).rows[0];
async function enter(page: Page, url: string) {
  await page.goto(url);
  await expect(page.getByRole('heading', { name: '本機付款測試', exact: true })).toBeVisible();
}

test('16. Live query: paid without notification, then 查詢付款結果 → 已付款', async ({
  page,
  browser,
  baseURL,
  e2eAuthPool,
}) => {
  await page.route(url => !['127.0.0.1', 'localhost'].includes(url.hostname), route => route.abort());
  const p = await createE2ePaymentOrder(e2eAuthPool, browser, baseURL!, page.context());
  const orderPath = `/shops/${p.store.slug}/orders/${p.order.order_ref}`;

  await enter(page, p.payment.handoff_url);
  await page.getByRole('button', { name: '付款成功但不通知', exact: true }).click();
  await expect(page.getByText('結果已送出。', { exact: true })).toBeVisible();

  await page.goto(orderPath);
  const paymentSection = page.getByRole('region', { name: '付款' });
  await expect(paymentSection).toContainText('付款確認中');
  await expect(paymentSection).toContainText('還沒收到這次付款的結果。');

  const queryButton = paymentSection.getByRole('button', { name: '查詢付款結果', exact: true });
  await expect(queryButton).toBeEnabled();

  await queryButton.click();
  await expect(paymentSection).toContainText('已付款');
  await expect(paymentSection.getByRole('button', { name: '查詢付款結果', exact: true })).toHaveCount(0);

  const events = (await e2eAuthPool.query(
    'SELECT source, query_trigger, outcome FROM commerce_hosted_payment_events WHERE attempt_id=$1',
    [p.payment.attempt_ref],
  )).rows;
  expect(events).toEqual([
    { source: 'query', query_trigger: 'buyer', outcome: 'paid' },
  ]);
  expect((await row(e2eAuthPool, p.payment.attempt_ref)).state).toBe('confirmed');
});

test('17. Live re-pay: 付款失敗 → 重新付款 → attempt 2 → 付款成功 → 已付款', async ({
  page,
  browser,
  baseURL,
  e2eAuthPool,
}) => {
  await page.route(url => !['127.0.0.1', 'localhost'].includes(url.hostname), route => route.abort());
  const p = await createE2ePaymentOrder(e2eAuthPool, browser, baseURL!, page.context());
  const orderPath = `/shops/${p.store.slug}/orders/${p.order.order_ref}`;

  await enter(page, p.payment.handoff_url);
  await page.getByRole('button', { name: '付款失敗', exact: true }).click();
  await expect(page.getByText('結果已送出。', { exact: true })).toBeVisible();

  await page.goto(orderPath);
  const paymentSection = page.getByRole('region', { name: '付款' });
  await expect(paymentSection).toContainText('付款未完成');
  await expect(paymentSection).toContainText('這次付款沒有完成，沒有扣款。');

  const dto = await readOrderDtoWithPageCookies(page, p.store.slug, p.order.order_ref);
  expect(dto.can_resume_payment).toBe(true);

  await page.getByRole('button', { name: '重新付款', exact: true }).click();
  await expect(page.getByRole('heading', { name: '本機付款測試', exact: true })).toBeVisible();

  const attempts = (await e2eAuthPool.query(
    'SELECT attempt_id, sequence, state, handed_off_at FROM commerce_payment_attempts WHERE order_id=$1 ORDER BY sequence ASC',
    [p.order.order_ref],
  )).rows;
  expect(attempts).toHaveLength(2);
  expect(attempts[0].sequence).toBe(1);
  expect(attempts[0].state).toBe('failed');
  expect(attempts[1].sequence).toBe(2);
  expect(attempts[1].state).toBe('issued');
  expect(attempts[1].handed_off_at).not.toBeNull();

  const queryEvents = (await e2eAuthPool.query(
    "SELECT 1 FROM commerce_hosted_payment_events e JOIN commerce_payment_attempts a USING(attempt_id) WHERE a.order_id=$1 AND e.source='query'",
    [p.order.order_ref],
  )).rows;
  expect(queryEvents).toHaveLength(0);

  await page.getByRole('button', { name: '付款成功', exact: true }).click();
  await page.getByRole('button', { name: '返回商店查看結果', exact: true }).click();

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('已收到付款');
  const viewOrderLink = page.getByRole('link', { name: '查看訂單', exact: true });
  await viewOrderLink.click();

  await expect(page).toHaveURL(`${baseURL}${orderPath}`);
  const paymentSectionAfter = page.getByRole('region', { name: '付款' });
  await expect(paymentSectionAfter).toContainText('已付款');

  expect((await row(e2eAuthPool, attempts[1].attempt_id)).state).toBe('confirmed');
});

test('18. Live order budget: an unpaid handoff queried twice → 操作太頻繁', async ({
  page,
  browser,
  baseURL,
  e2eAuthPool,
}) => {
  await page.route(url => !['127.0.0.1', 'localhost'].includes(url.hostname), route => route.abort());
  const p = await createE2ePaymentOrder(e2eAuthPool, browser, baseURL!, page.context());
  const orderPath = `/shops/${p.store.slug}/orders/${p.order.order_ref}`;

  await enter(page, p.payment.handoff_url);
  await page.goto(orderPath);

  const paymentSection = page.getByRole('region', { name: '付款' });
  await expect(paymentSection).toContainText('付款確認中');
  const queryButton = paymentSection.getByRole('button', { name: '查詢付款結果', exact: true });
  await expect(queryButton).toBeEnabled();

  const firstQueryPromise = page.waitForResponse(
    res => res.url().includes('/payment-queries') && res.request().method() === 'POST',
  );
  await queryButton.click();
  const firstQueryRes = await firstQueryPromise;
  expect(firstQueryRes.status()).toBe(200);

  await expect(paymentSection).toContainText('付款確認中');
  await expect(queryButton).toBeEnabled();

  const events1 = (await e2eAuthPool.query(
    'SELECT source, query_trigger, outcome FROM commerce_hosted_payment_events WHERE attempt_id=$1',
    [p.payment.attempt_ref],
  )).rows;
  expect(events1).toEqual([
    { source: 'query', query_trigger: 'buyer', outcome: 'unpaid' },
  ]);
  expect((await row(e2eAuthPool, p.payment.attempt_ref)).state).toBe('issued');

  const secondQueryPromise = page.waitForResponse(
    res => res.url().includes('/payment-queries') && res.request().method() === 'POST',
  );
  const testNowBefore = Date.now();
  await queryButton.click();
  const secondQueryRes = await secondQueryPromise;
  const testNowAfter = Date.now();

  expect(secondQueryRes.status()).toBe(429);
  const retryAfterHeader = secondQueryRes.headers()['retry-after'];
  expect(retryAfterHeader).toBeDefined();
  const retryAfter = Number(retryAfterHeader);
  expect(Number.isFinite(retryAfter)).toBe(true);
  expect(retryAfter).toBeGreaterThan(0);

  const alert = paymentSection.getByRole('alert');
  await expect(alert).toHaveText(/^操作太頻繁，請在 \d{2}:\d{2} 後再試。$/);
  const alertText = await alert.innerText();
  const match = alertText.match(/^操作太頻繁，請在 (\d{2}:\d{2}) 後再試。$/);
  expect(match).not.toBeNull();
  const displayedTime = match![1];

  const candidateTimes = new Set<string>([
    formatRetryAfterTaipeiTime(retryAfter, testNowBefore),
    formatRetryAfterTaipeiTime(retryAfter, testNowAfter),
    formatTaipeiTime(Math.ceil((testNowBefore + retryAfter * 1000) / 60_000) * 60_000 + 60_000),
    formatTaipeiTime(Math.ceil((testNowAfter + retryAfter * 1000) / 60_000) * 60_000 + 60_000),
  ]);
  expect(candidateTimes.has(displayedTime)).toBe(true);

  await expect(queryButton).toBeDisabled();

  const events2 = (await e2eAuthPool.query(
    'SELECT source, query_trigger, outcome FROM commerce_hosted_payment_events WHERE attempt_id=$1',
    [p.payment.attempt_ref],
  )).rows;
  expect(events2).toHaveLength(1);
  expect(events2[0]).toEqual({ source: 'query', query_trigger: 'buyer', outcome: 'unpaid' });
});

test('19. Refunded B06 and B07 are final, with only order navigation and no payment actions at mobile and desktop widths', async ({ page, browser, baseURL, e2eAuthPool }, info) => {
  const p = await createE2ePaymentOrder(e2eAuthPool, browser, baseURL!, page.context(), { randomContact: true });
  await page.clock.install({ time: new Date('2026-10-16T02:00:00.000Z') });
  const base = await readOrderDtoWithPageCookies(page, p.store.slug, p.order.order_ref);
  const dto = PublicOrderSchema.parse({
    ...base,
    payment_state: 'refunded',
    can_resume_payment: true,
    latest_payment_attempt: { attempt_ref: p.payment.attempt_ref, state: 'paid', created_at: base.created_at },
  });
  const api = `**/api/v1/public/stores/${p.store.slug}/orders/${p.order.order_ref}`;
  let reads = 0;
  await page.route(api, async route => {
    expect(route.request().method()).toBe('GET');
    reads++;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(dto) });
  });
  const copy = '店家已登記退回這筆訂單收到的全部款項。入帳時間依發卡銀行而定，沒有收到時請聯絡店家。';
  await page.goto(`/shops/${p.store.slug}/payment-return/${p.payment.attempt_ref}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('已退款');
  await expect(page.locator('#shop-pay-return')).toContainText(copy);
  await expect(page.locator('#shop-pay-return .shop-order-actions').getByRole('link')).toHaveText(['查看訂單']);
  await expect(page.locator('#shop-pay-return').getByRole('button')).toHaveCount(0);
  const initialReads = reads;
  await page.clock.runFor(20000);
  expect(reads).toBe(initialReads);
  await assertResponsiveLayout(page, [390, 768, 1440], w => info.outputPath(`b06-refunded-${w}.png`));
  await page.getByRole('link', { name: '查看訂單', exact: true }).click();
  await expect(page.getByRole('region', { name: '付款', exact: true })).toContainText('已退款');
  await expect(page.getByRole('region', { name: '付款', exact: true })).toContainText(copy);
  await expect(page.getByRole('heading', { name: '需要你處理', exact: true })).toHaveCount(0);
  for (const name of ['前往付款', '重新付款', '查詢付款結果', '重新查詢']) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  await assertResponsiveLayout(page, [390, 768, 1440], w => info.outputPath(`b07-refunded-${w}.png`));
});
