import { mkdirSync } from 'node:fs';
import { navigate, signOut } from './navigation.js';
import { test, expect, type Browser, type Page } from './fixtures.js';

const GUEST_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const SHOTS = process.env.AUDIT_EVIDENCE_DIR ?? 'test-results/member-services';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const COVER_TITLE = 'E2E 假髮造型';
const PLACEHOLDER_TITLE = 'E2E 語言課';
const CATEGORIES = ['hair_beauty', 'courses', 'language', 'design', 'photo_video', 'tech', 'consulting', 'handmade', 'other'];

test.use({ userAgent: GUEST_UA });
test.describe.configure({ mode: 'serial' });
mkdirSync(SHOTS, { recursive: true });

let servicePath = '';
let goUrl = '';

test.beforeEach(async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  await page.addInitScript(() => {
    try { Object.defineProperty(navigator, 'share', { configurable: true, value: undefined }); } catch { /* Copy stays available. */ }
  });
});

test.afterAll(async ({ e2eAuthPool }) => {
  await e2eAuthPool.query(`DELETE FROM promotion_clicks WHERE link_id IN (SELECT link_id FROM promotion_links WHERE kind='member_service')`);
  await e2eAuthPool.query(`DELETE FROM promotion_links WHERE kind='member_service'`);
  await e2eAuthPool.query(`DELETE FROM member_services WHERE title LIKE 'E2E %'`);
});

async function login(page: Page, email = 'maker@local.test') {
  await page.goto('/');
  await page.getByLabel('電子郵件', { exact: true }).fill(email);
  await page.getByLabel('密碼', { exact: true }).fill('freedom-local-demo');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.locator('.shell')).toBeVisible({ timeout: 20_000 });
}

async function themeOf(page: Page, theme: 'light' | 'dark' | 'versefolk') {
  await page.evaluate(value => {
    localStorage.setItem('freedom-theme', value);
    document.documentElement.dataset.theme = value;
    window.dispatchEvent(new Event('freedom-theme-changed'));
  }, theme);
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

function channel(value: number) {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}
function parseColor(value: string) {
  const srgb = value.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  if (srgb) return srgb.slice(1, 4).map(channel => Number(channel) * 255);
  const rgb = value.match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  if (rgb) return rgb.slice(1, 4).map(Number);
  throw new Error(`unparsed colour ${value}`);
}
function contrast(foreground: string, background: string) {
  const luminance = (value: string) => {
    const [r, g, b] = parseColor(value).map(channel);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const left = luminance(foreground), right = luminance(background);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

function card(page: Page, title: string) {
  return page.locator('article.service-card').filter({ has: page.getByRole('heading', { name: title, level: 3 }) });
}

async function fillService(page: Page, title: string, category: string, summary: string, file = false) {
  await page.getByRole('button', { name: '新增服務', exact: true }).click();
  const form = page.locator('form.service-form');
  await expect(form).toBeVisible();
  await expect(form.getByText('服務頁會公開，任何拿到連結的人都看得到。')).toBeVisible();
  await form.getByLabel('標題', { exact: true }).fill(title);
  await form.locator('select').selectOption({ label: category });
  await form.getByLabel('簡介', { exact: true }).fill(summary);
  await form.getByLabel('說明', { exact: true }).fill('到府討論，也可以線上。');
  await form.getByLabel('價格', { exact: true }).fill('每堂 NT$800 起');
  await form.getByLabel('地區', { exact: true }).fill('台北・線上');
  await form.getByLabel('聯絡名稱', { exact: true }).fill('官方網站');
  await form.getByLabel('https 連結', { exact: true }).fill('https://example.com/wig');
  if (file) await form.locator('input[type="file"]').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: PNG });
  return form;
}

test('a member lists a service with a cover and one with a placeholder', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  await navigate(page, '社員服務');
  await expect(page.getByText('還沒有社員分享服務。你可以先新增自己的服務。')).toBeVisible();
  const form = await fillService(page, COVER_TITLE, '美髮造型・假髮', '客製假髮與造型調整', true);
  await themeOf(page, 'light');
  await page.setViewportSize({ width: 1280, height: 900 });
  await shot(page, 'form-light-1280');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, 'form-light-390');
  await themeOf(page, 'versefolk');
  await page.setViewportSize({ width: 1280, height: 900 });
  await shot(page, 'form-versefolk-1280');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, 'form-versefolk-390');
  await form.getByRole('button', { name: '建立服務', exact: true }).click();
  await expect(page.getByText('已新增服務。')).toBeVisible();
  await expect(page.locator('li.service-mine-row').filter({ hasText: COVER_TITLE })).toBeVisible();
  await expect(card(page, COVER_TITLE).locator('img.service-cover')).toBeVisible();
  await fillService(page, PLACEHOLDER_TITLE, '語言教學', '一對一對話練習');
  await page.locator('form.service-form').getByRole('button', { name: '建立服務', exact: true }).click();
  await expect(card(page, PLACEHOLDER_TITLE).locator('.service-placeholder')).toContainText('語言教學');
  await expect(page.locator('li.service-mine-row').filter({ hasText: PLACEHOLDER_TITLE })).toBeVisible();
  servicePath = (await card(page, COVER_TITLE).getByRole('link', { name: '服務頁 ↗' }).getAttribute('href'))!;
  for (const theme of ['light', 'versefolk'] as const) {
    await themeOf(page, theme);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await shot(page, `services-${theme}-${width}`);
      await noOverflow(page);
    }
  }
});

test('another member shares it and a signed-out visitor lands on the public page', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await login(page, 'reviewer@local.test');
  await navigate(page, '社員服務');
  const target = card(page, COVER_TITLE);
  await target.getByRole('button', { name: '分享', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `分享「${COVER_TITLE}」` });
  await expect(dialog.locator('.skill-share-url')).toHaveText(/\/go\/[A-Za-z0-9_-]{10}$/);
  await expect(dialog).toContainText(`${COVER_TITLE}｜示範創作者：客製假髮與造型調整`);
  goUrl = (await dialog.locator('.skill-share-url').innerText()).trim();
  for (const theme of ['light', 'versefolk'] as const) {
    await themeOf(page, theme);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await dialog.screenshot({ path: `${SHOTS}/share-${theme}-${width}.png` });
    }
  }
  await dialog.getByRole('button', { name: '關閉分享', exact: true }).click();

  const context = await browser.newContext({ userAgent: GUEST_UA });
  const guest = await context.newPage();
  const clicked = guest.waitForResponse(response => response.url().includes('/api/v1/promotion/clicks') && response.request().method() === 'POST');
  const landed = guest.waitForURL(/\/services\/[0-9a-f-]{36}$/i);
  await guest.goto(goUrl, { waitUntil: 'commit' });
  expect((await clicked).ok()).toBe(true);
  await landed;
  await expect(guest.getByRole('heading', { name: COVER_TITLE, level: 1 })).toBeVisible();
  await expect(guest.locator('meta[property="og:title"]')).toHaveAttribute('content', `${COVER_TITLE}｜示範創作者 的服務｜自由工坊`);
  await expect(guest.locator('meta[property="og:description"]')).toHaveAttribute('content', '客製假髮與造型調整');
  await expect(guest.locator('a.service-contact')).toHaveAttribute('href', 'https://example.com/wig');
  await expect(guest.locator('a.service-contact')).toHaveAttribute('rel', 'noopener noreferrer nofollow');
  expect(await guest.content()).not.toContain('maker@local.test');
  const origin = new URL(guest.url()).origin;
  await guest.goto(`${origin}/services`);
  await expect(guest.getByRole('heading', { name: COVER_TITLE, level: 2 })).toBeVisible();
  await expect(guest.getByRole('heading', { name: PLACEHOLDER_TITLE, level: 2 })).toBeVisible();
  for (const scheme of ['light', 'dark'] as const) {
    await guest.emulateMedia({ colorScheme: scheme });
    for (const width of [1280, 390]) {
      await guest.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await guest.screenshot({ path: `${SHOTS}/public-list-${scheme}-${width}.png`, fullPage: true });
      await noOverflow(guest);
    }
  }
  await guest.goto(`${origin}${servicePath}`);
  for (const scheme of ['light', 'dark'] as const) {
    await guest.emulateMedia({ colorScheme: scheme });
    for (const width of [1280, 390]) {
      await guest.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await guest.screenshot({ path: `${SHOTS}/public-detail-${scheme}-${width}.png`, fullPage: true });
      await noOverflow(guest);
    }
  }
  await context.close();
});

test('the click shows on the business board for the sharer', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, 'reviewer@local.test');
  await navigate(page, '推廣排行榜');
  const business = page.getByRole('article', { name: '業務推廣排行榜', exact: true });
  await expect(business).toContainText('在社員服務分享區分享社員的服務，每次點擊 +1。');
  await expect(page.getByRole('button', { name: '本週', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(business.locator('li').filter({ hasText: '示範需求者' }).locator('strong')).toHaveText('1');
  await expect(business).toContainText('我的名次：第 1 名・1 分');
  for (const theme of ['light', 'versefolk'] as const) {
    await themeOf(page, theme);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await business.scrollIntoViewIfNeeded();
      await shot(page, `leaderboard-${theme}-${width}`);
      await noOverflow(page);
    }
  }
});

test('chips, covers and colours stay readable at phone, tablet and desktop', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await login(page);
  await navigate(page, '社員服務');
  await page.getByRole('button', { name: '語言教學', exact: true }).click();
  await expect(page.getByRole('button', { name: '語言教學', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(card(page, PLACEHOLDER_TITLE)).toBeVisible();
  await expect(card(page, COVER_TITLE)).toHaveCount(0);
  await page.getByRole('button', { name: '美髮造型・假髮', exact: true }).click();
  await expect(card(page, COVER_TITLE)).toBeVisible();
  await expect(card(page, PLACEHOLDER_TITLE)).toHaveCount(0);
  await page.getByRole('button', { name: '全部', exact: true }).click();
  await expect(page.getByLabel('標題', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '新增服務', exact: true }).click();
  await expect(page.getByLabel('標題', { exact: true })).toHaveCSS('font-size', '16px');
  await page.getByRole('button', { name: '關閉表單', exact: true }).click();

  for (const width of [390, 820, 1280]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await noOverflow(page);
    const cover = card(page, COVER_TITLE).locator('img.service-cover');
    const box = (await cover.boundingBox())!;
    expect(Math.abs(box.height - box.width * 9 / 16)).toBeLessThanOrEqual(2);
    const avatar = card(page, COVER_TITLE).locator('.service-avatar');
    expect((await avatar.boundingBox())!.width).toBeLessThanOrEqual(36);
    if (width === 390) {
      const open = await card(page, COVER_TITLE).getByRole('link', { name: '服務頁 ↗' }).boundingBox();
      const share = await card(page, COVER_TITLE).getByRole('button', { name: '分享', exact: true }).boundingBox();
      expect(Math.abs(open!.y - share!.y)).toBeLessThanOrEqual(1);
      expect(open!.height).toBeGreaterThanOrEqual(44);
    }
  }

  for (const theme of ['light', 'dark', 'versefolk'] as const) {
    await themeOf(page, theme);
    const swatches = await page.locator('.service-badge').first().evaluate((element, categories) => {
      const parent = element.parentElement!;
      return (categories as string[]).map(category => {
        const clone = element.cloneNode(true) as HTMLElement;
        clone.dataset.category = category;
        parent.appendChild(clone);
        const style = getComputedStyle(clone);
        const colors = { backgroundColor: style.backgroundColor, color: style.color };
        clone.remove();
        return colors;
      });
    }, CATEGORIES);
    expect(new Set(swatches.map(item => item.backgroundColor)).size, theme).toBe(CATEGORIES.length);
    swatches.forEach((colors, index) => expect(contrast(colors.color, colors.backgroundColor), `${theme} ${CATEGORIES[index]} ${colors.color} on ${colors.backgroundColor}`).toBeGreaterThanOrEqual(3));
    const placeholder = card(page, PLACEHOLDER_TITLE).locator('.service-placeholder');
    const placeholderColors = await placeholder.evaluate(element => {
      const style = getComputedStyle(element);
      return { backgroundColor: style.backgroundColor, color: style.color };
    });
    const cardColor = await card(page, PLACEHOLDER_TITLE).evaluate(element => getComputedStyle(element).backgroundColor);
    expect(placeholderColors.backgroundColor, theme).not.toBe(cardColor);
    expect(contrast(placeholderColors.color, placeholderColors.backgroundColor), theme).toBeGreaterThanOrEqual(3);
    const pressed = page.getByRole('button', { name: '全部', exact: true });
    const resting = page.getByRole('button', { name: '其他', exact: true });
    const on = await pressed.evaluate(element => { const style = getComputedStyle(element); return { backgroundColor: style.backgroundColor, color: style.color }; });
    const off = await resting.evaluate(element => getComputedStyle(element).backgroundColor);
    expect(on.backgroundColor, theme).not.toBe(off);
    expect(contrast(on.color, on.backgroundColor), theme).toBeGreaterThanOrEqual(3);
  }

  const origin = new URL(page.url()).origin;
  const context = await browser.newContext({ userAgent: GUEST_UA });
  const guest = await context.newPage();
  await guest.goto(`${origin}${servicePath}`);
  for (const width of [390, 820, 1280]) {
    await guest.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await noOverflow(guest);
    const cover = guest.locator('img.service-cover');
    const box = (await cover.boundingBox())!;
    expect(Math.abs(box.height - box.width * 9 / 16)).toBeLessThanOrEqual(2);
    expect((await guest.locator('a.service-contact').boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  for (const scheme of ['light', 'dark'] as const) {
    await guest.emulateMedia({ colorScheme: scheme });
    const chip = guest.locator('.service-chips a[aria-current="page"]');
    await guest.goto(`${origin}/services`);
    const on = await chip.evaluate(element => { const style = getComputedStyle(element); return { backgroundColor: style.backgroundColor, color: style.color }; });
    const off = await guest.locator('.service-chips a:not([aria-current="page"])').first().evaluate(element => getComputedStyle(element).backgroundColor);
    expect(on.backgroundColor, scheme).not.toBe(off);
    expect(contrast(on.color, on.backgroundColor), scheme).toBeGreaterThanOrEqual(3);
    const placeholder = guest.locator('.service-placeholder').first();
    const colors = await placeholder.evaluate(element => {
      const style = getComputedStyle(element);
      return { backgroundColor: style.backgroundColor, color: style.color, card: getComputedStyle(element.closest('article')!).backgroundColor };
    });
    expect(colors.backgroundColor, scheme).not.toBe(colors.card);
    expect(contrast(colors.color, colors.backgroundColor), scheme).toBeGreaterThanOrEqual(3);
  }
  await context.close();
});

test('the owner can pause, resume and delete a service', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await login(page);
  await navigate(page, '社員服務');
  await card(page, COVER_TITLE).getByRole('button', { name: '暫停', exact: true }).click();
  await expect(page.locator('li.service-mine-row').filter({ hasText: COVER_TITLE })).toContainText('暫停中');
  await expect(card(page, COVER_TITLE)).toHaveCount(0);
  const origin = new URL(page.url()).origin;
  const context = await browser.newContext({ userAgent: GUEST_UA });
  const guest = await context.newPage();
  const missing = await guest.goto(`${origin}${servicePath}`);
  expect(missing?.status()).toBe(404);
  await expect(guest.getByRole('heading', { name: '找不到這項服務' })).toBeVisible();
  await guest.goto(goUrl);
  await expect.poll(() => new URL(guest.url()).pathname).toBe('/');
  await context.close();

  await page.locator('li.service-mine-row').filter({ hasText: COVER_TITLE }).getByRole('button', { name: '恢復', exact: true }).click();
  await expect(card(page, COVER_TITLE)).toBeVisible();
  const restored = await page.request.get(servicePath);
  expect(restored.status()).toBe(200);

  await card(page, PLACEHOLDER_TITLE).getByRole('button', { name: '刪除', exact: true }).click();
  await card(page, PLACEHOLDER_TITLE).getByRole('button', { name: '確定刪除', exact: true }).click();
  await expect(page.getByText('服務已刪除。')).toBeVisible();
  await expect(card(page, PLACEHOLDER_TITLE)).toHaveCount(0);
  await expect(page.locator('li.service-mine-row').filter({ hasText: PLACEHOLDER_TITLE })).toHaveCount(0);
  await signOut(page);
});
