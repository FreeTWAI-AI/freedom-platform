import { randomBytes } from 'node:crypto';
import { test, expect } from './fixtures.js';
import { createE2ePaymentOrder } from './hosted-payment-fixture.js';
import { PublicOrderSchema } from '../../contracts/guild-launchpad/v1/hosted-checkout.js';
import { hashKey } from '../../modules/agent-commerce/checkout/terms.js';
for (const mode of ['success', 'failure', 'delayed'] as const)
  test(`payment handoff and local provider: ${mode}`, async ({ page, browser, baseURL, e2eAuthPool }) => {
    const p = await createE2ePaymentOrder(e2eAuthPool, browser, baseURL!, page.context()), handoffResponse = page.waitForResponse(r => new URL(r.url()).pathname === p.payment.handoff_url && r.request().method() === 'GET');
    await page.goto(p.payment.handoff_url);
    const response = await handoffResponse;
    expect(response.status()).toBe(200);
    expect(response.headers()['content-security-policy']).toContain("form-action 'self' " + baseURL);
    expect(response.headers()['referrer-policy']).toBe('no-referrer');
    await expect(page.getByRole('heading', { name: '本機付款測試', exact: true })).toBeVisible();
    await expect(page.locator('[data-trade-number]')).toHaveText(/^F[0-9A-HJKMNP-TV-Z]{19}$/);
    await page.getByRole('button', { name: mode === 'success' ? '付款成功' : mode === 'failure' ? '付款失敗' : '付款成功但通知延後', exact: true }).click();
    await page.getByRole('button', { name: '返回商店查看結果', exact: true }).click();
    await expect(page).toHaveURL(baseURL + `/shops/${p.store.slug}/payment-return/${p.payment.attempt_ref}`);
    const read = async () => { const response = await page.request.get(`/api/v1/public/stores/${p.store.slug}/orders/${p.order.order_ref}`); expect(response.status()).toBe(200); return PublicOrderSchema.parse(await response.json()); };
    const value = await read();
    expect(value.payment_state).toBe(mode === 'success' ? 'confirmed' : mode === 'delayed' ? 'pending' : 'unpaid');
    expect(value.latest_payment_attempt?.state).toBe(mode === 'failure' ? 'failed' : mode === 'success' ? 'paid' : 'awaiting_result');
    if (mode === 'delayed') {
      const response = await page.request.post('/__e2e/ecpay/deliver-pending', { data: {} });
      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual({ delivered: 1 });
      expect((await read()).payment_state).toBe('confirmed');
    }
    const reused = await page.goto(p.payment.handoff_url);
    expect(reused?.status()).toBe(410);
    await expect(page.getByText('付款連結已失效或不存在。', { exact: true })).toBeVisible();
  });
test('expired and unknown bearer links are private invalid-link pages', async ({ page, browser, baseURL, e2eAuthPool }) => {
  const p = await createE2ePaymentOrder(e2eAuthPool, browser, baseURL!, page.context()), token = randomBytes(32).toString('base64url');
  await e2eAuthPool.query(`INSERT INTO commerce_entry_routes(route_kind,route_key,tenant_id,instance_id,target_id,created_at,expires_at) VALUES('payment_handoff',$1,$2,$3,$4,clock_timestamp()-interval '16 minutes',clock_timestamp()-interval '1 minute')`, [hashKey(token), p.store.tenant, p.store.instance, p.payment.attempt_ref]);
  let response = await page.goto('/pay/ecpay/' + token);
  expect(response?.status()).toBe(410);
  await expect(page.getByRole('link', { name: '返回訂單', exact: true })).toHaveAttribute('href', '/pay/ecpay/back/' + p.payment.attempt_ref);
  await page.getByRole('link', { name: '返回訂單', exact: true }).click();
  await expect(page).toHaveURL(baseURL + `/shops/${p.store.slug}/orders/${p.order.order_ref}`);
  response = await page.goto('/pay/ecpay/' + randomBytes(32).toString('base64url'));
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('link', { name: '返回首頁', exact: true })).toHaveAttribute('href', '/');
});
test('JavaScript-disabled handoff uses the noscript submit button and fits narrow viewports', async ({ browser, baseURL, e2eAuthPool }, testInfo) => {
  const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
  try {
    const p = await createE2ePaymentOrder(e2eAuthPool, browser, baseURL!, context), page = await context.newPage(), response = await page.goto(p.payment.handoff_url);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('button', { name: '前往綠界付款', exact: true })).toBeVisible();
    await expect(page.locator('#handoff-manual')).toBeHidden();
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`handoff-${width}.png`) });
    }
    await page.getByRole('button', { name: '前往綠界付款', exact: true }).click();
    await expect(page.getByRole('heading', { name: '本機付款測試', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '付款成功', exact: true }).click();
    await page.getByRole('button', { name: '返回商店查看結果', exact: true }).click();
    const value = PublicOrderSchema.parse(await (await context.request.get(`/api/v1/public/stores/${p.store.slug}/orders/${p.order.order_ref}`)).json());
    expect(value.payment_state).toBe('confirmed');
  }
  finally {
    await context.close();
  }
});
