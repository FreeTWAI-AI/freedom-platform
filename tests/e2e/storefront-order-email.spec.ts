import { test, expect } from './fixtures.js';
import {
  assertResponsiveLayout,
  createE2ePaymentOrder,
} from './storefront-payment-fixture.js';

const EMAIL_NOTE_BEFORE_PAYMENT = '付款確認後，訂單成立信會寄到你填寫的 Email。';
const B10_RESULT_NOTICE = '如果資料相符，我們會把查看連結寄到這個 Email。連結 7 天內有效，只能使用一次。';
const LAYOUT_WIDTHS = [1440, 390] as const;

test('buyer transactional email E2E: B07 pre/post-payment email note, order_confirmed mail link, B10 form recovery mail link, one-time link rejection, and 390/1440 layout', async ({
  page,
  browser,
  baseURL,
  e2eAuthPool,
}, info) => {
  // Execute and drain any prior due work and messages from earlier tests in the shared E2E server
  await page.request.post('/__e2e/commerce/run-due-work', { data: {} });
  await page.request.get('/__e2e/commerce/mail');

  const p = await createE2ePaymentOrder(e2eAuthPool, browser, baseURL!, page.context());
  const orderPath = `/shops/${p.store.slug}/orders/${p.order.order_ref}`;

  // 1. Before payment: B07 shows the email confirmation note inside the 付款 section
  await page.goto(orderPath);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`訂單 ${p.order.display_number}`);
  const paymentSection = page.getByRole('region', { name: '付款' });
  await expect(paymentSection).toContainText('尚未付款');
  await expect(paymentSection).toContainText(EMAIL_NOTE_BEFORE_PAYMENT);
  await assertResponsiveLayout(page, LAYOUT_WIDTHS, w => info.outputPath(`b07-email-before-pay-${w}.png`));

  // 2. Pay the order through the fixture checkout
  const actionSection = page.getByRole('region', { name: '需要你處理' });
  await actionSection.getByRole('button', { name: '前往付款', exact: true }).click();
  await expect(page.getByRole('heading', { name: '本機付款測試', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '付款成功', exact: true }).click();
  await page.getByRole('button', { name: '返回商店查看結果', exact: true }).click();

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('已收到付款');
  await page.getByRole('link', { name: '查看訂單', exact: true }).click();

  // 3. After 已付款: B07 shows 已付款 and no longer shows the pre-payment email note
  await expect(page).toHaveURL(`${baseURL}${orderPath}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`訂單 ${p.order.display_number}`);
  await expect(paymentSection).toContainText('已付款');
  await expect(paymentSection).not.toContainText(EMAIL_NOTE_BEFORE_PAYMENT);
  await assertResponsiveLayout(page, LAYOUT_WIDTHS, w => info.outputPath(`b07-email-after-pay-${w}.png`));

  // 4. Exactly one order_confirmed mail is sent; open its link in a fresh browser context -> the order shows
  const confirmedMails: Array<{ to: string; subject: string; text: string }> = [];
  await expect
    .poll(async () => {
      await page.request.post('/__e2e/commerce/run-due-work', { data: {} });
      const res = await page.request.get('/__e2e/commerce/mail');
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { messages: Array<{ to: string; subject: string; text: string }> };
      confirmedMails.push(...body.messages);
      return confirmedMails.length;
    })
    .toBe(1);

  expect(confirmedMails[0].to).toBe('synthetic-payment@example.test');
  expect(confirmedMails[0].subject).toContain(p.order.display_number);
  const confirmedLinkMatch = confirmedMails[0].text.match(/https?:\/\/[^\s]+#access=[A-Za-z0-9_-]+/);
  expect(confirmedLinkMatch).not.toBeNull();
  const confirmedLinkUrl = confirmedLinkMatch![0];

  const freshContext1 = await browser.newContext({ baseURL });
  try {
    const freshPage1 = await freshContext1.newPage();
    await freshPage1.goto(confirmedLinkUrl);
    await expect(freshPage1.getByRole('heading', { level: 1 })).toHaveText('開啟訂單');
    await freshPage1.getByRole('button', { name: '在這個瀏覽器開啟訂單', exact: true }).click();
    await expect(freshPage1.getByRole('heading', { level: 1 })).toHaveText(`訂單 ${p.order.display_number}`);
    await expect(freshPage1.getByRole('region', { name: '付款' })).toContainText('已付款');
  } finally {
    await freshContext1.close();
  }

  // 5. B10 form -> mail -> link -> order; same link a second time -> not-found / invalid-link page
  const b10Context = await browser.newContext({ baseURL });
  let b10LinkUrl = '';
  try {
    const b10Page = await b10Context.newPage();
    await b10Page.goto(`/shops/${p.store.slug}/order-access`);
    await expect(b10Page.getByRole('heading', { level: 1 })).toHaveText('找回訂單');
    await assertResponsiveLayout(b10Page, LAYOUT_WIDTHS, w => info.outputPath(`b10-form-${w}.png`));

    await b10Page.getByLabel('Email', { exact: true }).fill('synthetic-payment@example.test');
    await b10Page.getByLabel('訂單編號', { exact: true }).fill(p.order.display_number);
    await b10Page.getByRole('button', { name: '寄送查看連結', exact: true }).click();

    await expect(b10Page.getByRole('status')).toHaveText(B10_RESULT_NOTICE);
    await assertResponsiveLayout(b10Page, LAYOUT_WIDTHS, w => info.outputPath(`b10-submitted-${w}.png`));

    const accessMails: Array<{ to: string; subject: string; text: string }> = [];
    await expect
      .poll(async () => {
        await b10Page.request.post('/__e2e/commerce/run-due-work', { data: {} });
        const res = await b10Page.request.get('/__e2e/commerce/mail');
        expect(res.status()).toBe(200);
        const body = (await res.json()) as { messages: Array<{ to: string; subject: string; text: string }> };
        accessMails.push(...body.messages);
        return accessMails.length;
      })
      .toBe(1);

    expect(accessMails[0].to).toBe('synthetic-payment@example.test');
    expect(accessMails[0].subject).toContain(p.order.display_number);
    const b10LinkMatch = accessMails[0].text.match(/https?:\/\/[^\s]+#access=[A-Za-z0-9_-]+/);
    expect(b10LinkMatch).not.toBeNull();
    b10LinkUrl = b10LinkMatch![0];

    await b10Page.goto(b10LinkUrl);
    await expect(b10Page.getByRole('heading', { level: 1 })).toHaveText('開啟訂單');
    await b10Page.getByRole('button', { name: '在這個瀏覽器開啟訂單', exact: true }).click();
    await expect(b10Page.getByRole('heading', { level: 1 })).toHaveText(`訂單 ${p.order.display_number}`);
  } finally {
    await b10Context.close();
  }

  // Opening the same B10 link a second time in another fresh context shows the not-found / invalid-link page
  const secondUseContext = await browser.newContext({ baseURL });
  try {
    const secondUsePage = await secondUseContext.newPage();
    await secondUsePage.goto(b10LinkUrl);
    await expect(secondUsePage.getByRole('heading', { level: 1 })).toHaveText('開啟訂單');
    await secondUsePage.getByRole('button', { name: '在這個瀏覽器開啟訂單', exact: true }).click();
    await expect(secondUsePage.getByRole('heading', { level: 1 })).toHaveText('這個訂單連結無法使用');
    await expect(secondUsePage.getByRole('link', { name: '找回訂單', exact: true })).toHaveAttribute(
      'href',
      `/shops/${p.store.slug}/order-access`,
    );
  } finally {
    await secondUseContext.close();
  }
});
