import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { navigate } from './navigation.js';
import { test, expect, type Browser, type Page } from './fixtures.js';

const GUEST_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const SHOTS = process.env.AUDIT_EVIDENCE_DIR ?? 'test-results/share-promotion';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const EVENT_TITLE = 'E2E 推廣點擊活動';
const YOUTUBE = 'https://www.youtube.com/watch?v=e2eDemo0001';
const LAYOUT = 'https://example.com/e2e-layout-thumb';
const PLACEHOLDER = 'https://example.com/e2e-placeholder';
const INSTAGRAM = 'https://www.instagram.com/p/E2E0001/';
const FACEBOOK = 'https://www.facebook.com/share/e2eDemoPost';
const MAKER = '20000000-0000-4000-8000-000000000001';
const COMMUNITY = '10000000-0000-4000-8000-000000000001';

test.use({ userAgent: GUEST_UA });
mkdirSync(SHOTS, { recursive: true });

let eventId = '';
let eventGo = '';
let platformGo = '';

test.beforeEach(async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  await page.addInitScript(() => {
    try { Object.defineProperty(navigator, 'share', { configurable: true, value: undefined }); } catch { /* The click still falls through to copy. */ }
  });
});

test.afterAll(async ({ e2eAuthPool }) => {
  await e2eAuthPool.query(`DELETE FROM community_event_rsvps WHERE event_id IN (SELECT event_id FROM community_events WHERE title=$1)`, [EVENT_TITLE]);
  await e2eAuthPool.query(`DELETE FROM community_event_bulletins WHERE event_id IN (SELECT event_id FROM community_events WHERE title=$1)`, [EVENT_TITLE]);
  await e2eAuthPool.query(`DELETE FROM community_events WHERE title=$1`, [EVENT_TITLE]);
  await e2eAuthPool.query(`DELETE FROM community_social_posts WHERE url IN ($1,$2,$3,$4,$5) OR url LIKE 'https://www.youtube.com/watch?v=e2eDemo%'`, [YOUTUBE, PLACEHOLDER, INSTAGRAM, FACEBOOK, LAYOUT]);
});

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('電子郵件', { exact: true }).fill('maker@local.test');
  await page.getByLabel('密碼', { exact: true }).fill('freedom-local-demo');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.locator('.shell')).toBeVisible({ timeout: 20_000 });
}

async function creditVisit(browser: Browser, url: string, expected: (url: URL) => boolean, intercept?: string) {
  const context = await browser.newContext({ userAgent: GUEST_UA });
  const guest = await context.newPage();
  if (intercept) await guest.route(intercept, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>intercepted</title>' }));
  const clicked = guest.waitForResponse(response => response.url().includes('/api/v1/promotion/clicks') && response.request().method() === 'POST');
  const landed = guest.waitForURL(expected);
  await guest.goto(url, { waitUntil: 'commit' });
  expect((await clicked).ok()).toBe(true);
  await landed;
  await context.close();
}

function board(page: Page, name: string) {
  return page.getByRole('article', { name, exact: true });
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

function channel(value: number) {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}
function contrast(foreground: string, background: string) {
  const parse = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number);
  const luminance = (value: string) => {
    const [r, g, b] = parse(value).map(channel);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const left = luminance(foreground), right = luminance(background);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

test('a skill-book share link credits one guest click on the weekly board', async ({ page, browser }) => {
  test.setTimeout(60_000);
  await login(page);
  await navigate(page, '技能書架');
  await page.getByRole('button', { name: '未解鎖', exact: true }).click();
  const library = page.locator('.community-library');
  await library.getByLabel('搜尋技能書', { exact: true }).fill('社群貼文');
  const card = library.locator('article[data-book-id="social-post"]');
  await card.getByRole('button', { name: '分享技能', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '分享「Hao 社群貼文技能書」', exact: true });
  const url = dialog.locator('.skill-share-url');
  await expect(url).toHaveText(/\/go\/[A-Za-z0-9_-]{10}(\?intro=\d+)?$/);
  await expect(dialog.locator('.promotion-share-points')).toHaveText(/這個連結：本週 \d+ 分・累計 \d+ 分/);
  const before = await dialog.locator('.promotion-share-points').innerText();
  const weekBefore = Number(/本週 (\d+) 分/.exec(before)![1]);
  const go = (await url.innerText()).trim();
  await page.keyboard.press('Escape');

  await creditVisit(browser, go, url => url.pathname === '/development/skills/social-post');
  await page.goto('/');
  await navigate(page, '推廣排行榜');
  const skill = board(page, '技能推廣排行榜');
  await expect(skill).toContainText('示範創作者');
  await expect(skill).toContainText(`我的名次：第 1 名・${weekBefore + 1} 分`);

  await creditVisit(browser, go, url => url.pathname === '/development/skills/social-post');
  await page.goto(go);
  await expect(page).toHaveURL(/\/development\/skills\/social-post/);
  await page.goto('/');
  await navigate(page, '推廣排行榜');
  await expect(board(page, '技能推廣排行榜')).toContainText(`我的名次：第 1 名・${weekBefore + 1} 分`);
});

test('an event share link lands on the public page and shows the click', async ({ page, browser, e2eAuthPool }) => {
  test.setTimeout(60_000);
  eventId = randomUUID();
  await e2eAuthPool.query(`INSERT INTO community_events(event_id,community_id,organizer_ref,title,description,starts_at,ends_at,mode,location,state,visibility,event_kind)
    VALUES($1,$2,$3,$4,'用來確認活動分享點擊。',now()-interval '29 days',now()+interval '2 days','online','線上','published','open','other')`,
  [eventId, COMMUNITY, MAKER, EVENT_TITLE]);
  await login(page);
  await navigate(page, '社群活動');
  const card = page.locator('article.experience-card').filter({ has: page.getByRole('heading', { name: EVENT_TITLE, level: 3 }) });
  await card.scrollIntoViewIfNeeded();
  await card.getByRole('button', { name: '分享活動', exact: true }).click();
  const field = card.getByLabel('分享連結');
  await expect(field).toHaveValue(/\/go\/[A-Za-z0-9_-]{10}$/);
  await expect(card.getByText('推薦碼已包含在連結內；訪客每天點開算 1 分（活動推廣排行榜）。')).toBeVisible();
  eventGo = await field.inputValue();
  await creditVisit(browser, eventGo, url => url.pathname === `/events/${eventId}` && url.searchParams.has('ref'));
  await card.getByRole('button', { name: '分享報名統計', exact: true }).click();
  await expect(card).toContainText('示範創作者：點擊 1・報名 0 人');
});

test('sharing the workshop from home and the leaderboard uses one personal link', async ({ page, browser }) => {
  test.setTimeout(60_000);
  await login(page);
  await page.getByRole('button', { name: '分享自由工坊', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '分享「自由工坊」', exact: true });
  await expect(dialog.locator('.skill-share-url')).toHaveText(/\/go\/[A-Za-z0-9_-]{10}$/);
  await expect(dialog).toContainText('自由工坊：加入公會、領取 Repo 技能書，和夥伴一起供貨、開店與做開源作品。');
  await expect(dialog).toContainText('訪客每天點開算 1 分，自己點不算。');
  const points = dialog.locator('.promotion-share-points');
  await expect(points).toHaveText(/這個連結：本週 \d+ 分・累計 \d+ 分/);
  const weekBefore = Number(/本週 (\d+) 分/.exec(await points.innerText())![1]);
  platformGo = (await dialog.locator('.skill-share-url').innerText()).trim();
  await dialog.getByRole('button', { name: '關閉分享', exact: true }).click();

  await creditVisit(browser, platformGo, url => url.pathname === '/' && url.search === '');
  await page.goto(platformGo);
  await expect(page).toHaveURL(url => url.pathname === '/' && url.search === '');
  await navigate(page, '推廣排行榜');
  await expect(board(page, '平台推廣排行榜')).toContainText(`我的名次：第 1 名・${weekBefore + 1} 分`);
  await page.getByRole('button', { name: '分享自由工坊', exact: true }).click();
  const again = page.getByRole('dialog', { name: '分享「自由工坊」', exact: true });
  await expect(again.locator('.skill-share-url')).toHaveText(platformGo);
  await again.getByRole('button', { name: '關閉分享', exact: true }).click();
  await creditVisit(browser, platformGo, url => url.pathname === '/' && url.search === '');
  await page.reload();
  await expect(board(page, '平台推廣排行榜')).toContainText(`我的名次：第 1 名・${weekBefore + 1} 分`);
});

test('the home share button stays as compact as the profile button', async ({ page }) => {
  await login(page);
  await themeOf(page, 'light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const edit = page.getByRole('button', { name: '編輯我的名片', exact: true });
  const share = page.getByRole('button', { name: '分享自由工坊', exact: true });
  const row = page.locator('.home-member-actions');
  await expect(edit).toBeVisible();
  await expect(share).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  const phoneShare = (await share.boundingBox())!;
  const phoneEdit = (await edit.boundingBox())!;
  const phoneRow = (await row.boundingBox())!;
  expect(phoneShare.height).toBeGreaterThanOrEqual(44);
  expect(phoneShare.width).toBeLessThan(phoneRow.width * 0.6);
  expect(phoneShare.width).toBeLessThanOrEqual(phoneEdit.width + 16);
  await noOverflow(page);

  await page.setViewportSize({ width: 1280, height: 900 });
  const deskShare = (await share.boundingBox())!;
  const deskEdit = (await edit.boundingBox())!;
  expect(Math.abs(deskShare.y - deskEdit.y)).toBeLessThanOrEqual(4);

  await shot(page, 'home-light-1280');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, 'home-light-390');
  await themeOf(page, 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await shot(page, 'home-dark-390');
  await noOverflow(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await shot(page, 'home-dark-1280');
});

async function sharePost(page: Page, url: string, title?: string) {
  const details = page.locator('details.social-composer');
  if (!await details.evaluate(element => (element as HTMLDetailsElement).open)) await details.locator('summary').click();
  await page.getByLabel('連結').fill(url);
  await page.getByLabel('標題（選填）').fill(title ?? '');
  const before = await page.locator('article.social-card').count();
  await page.getByRole('button', { name: '分享貼文', exact: true }).click();
  await expect(page.locator('article.social-card')).toHaveCount(before + 1);
}

test('the social zone previews, shares, replaces and keeps a thumbnail', async ({ page, browser }) => {
  test.setTimeout(90_000);
  await login(page);
  await navigate(page, '社群分享');
  await sharePost(page, YOUTUBE);
  const youtube = page.locator('article.social-card').filter({ has: page.getByRole('heading', { name: 'E2E 示範影片', level: 3 }) });
  await expect(youtube.locator('img.social-thumb')).toBeVisible();
  await expect(youtube).toContainText('推廣點擊 0');
  await sharePost(page, PLACEHOLDER, '沒有縮圖的貼文');
  const placeholder = page.locator('article.social-card').filter({ has: page.getByRole('heading', { name: '沒有縮圖的貼文', level: 3 }) });
  await expect(placeholder.locator('.social-placeholder')).toContainText('example.com');
  await expect(placeholder.locator('img')).toHaveCount(0);
  await sharePost(page, INSTAGRAM);
  await sharePost(page, FACEBOOK, 'Facebook 示範');

  await youtube.getByRole('button', { name: '分享', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '分享「E2E 示範影片」', exact: true });
  await expect(dialog.locator('.skill-share-url')).toHaveText(/\/go\/[A-Za-z0-9_-]{10}$/);
  const go = (await dialog.locator('.skill-share-url').innerText()).trim();
  await dialog.getByRole('button', { name: '關閉分享', exact: true }).click();
  await creditVisit(browser, go, url => url.href === YOUTUBE, 'https://www.youtube.com/**');
  await page.reload();
  await expect(page.locator('article.social-card').filter({ has: page.getByRole('heading', { name: 'E2E 示範影片', level: 3 }) })).toContainText('推廣點擊 1');

  await youtube.locator('input[type="file"]').setInputFiles({ name: 'tiny.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByText('縮圖已更新。')).toBeVisible();
  await expect(youtube.locator('img.social-thumb')).toBeVisible();
  await youtube.getByRole('link', { name: '開啟原文 ↗', exact: true }).getAttribute('href').then(href => expect(href).toBe(YOUTUBE));
  await expect(youtube.getByRole('link', { name: '開啟原文 ↗' })).toHaveAttribute('rel', 'noopener noreferrer');
});

test('social cards keep a 16:9 thumbnail, a small byline and actions on one row', async ({ page, browser }) => {
  test.setTimeout(60_000);
  await login(page);
  await navigate(page, '社群分享');
  await sharePost(page, LAYOUT, '版面縮圖');
  const card = page.locator('article.social-card').filter({ has: page.getByRole('heading', { name: '版面縮圖', level: 3 }) });
  await card.locator('input[type="file"]').setInputFiles({ name: 'tiny.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByText('縮圖已更新。')).toBeVisible();
  const thumb = card.locator('img.social-thumb');
  await expect(thumb).toBeVisible();
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const box = await thumb.boundingBox();
    expect(box?.width).toBeGreaterThan(120);
    expect(Math.abs(box!.height - box!.width * 9 / 16)).toBeLessThanOrEqual(2);
  }
  await page.setViewportSize({ width: 390, height: 900 });
  const avatar = await card.locator('.social-byline .social-avatar').boundingBox();
  expect(avatar!.width).toBeLessThanOrEqual(36);
  const open = await card.getByRole('link', { name: '開啟原文 ↗', exact: true }).boundingBox();
  const share = await card.getByRole('button', { name: '分享', exact: true }).boundingBox();
  expect(Math.abs(open!.y - share!.y)).toBeLessThanOrEqual(1);

  await navigate(page, '推廣排行榜');
  await page.getByRole('button', { name: '分享自由工坊', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '分享「自由工坊」' });
  await expect(dialog.locator('.skill-share-url')).toHaveText(/\/go\/[A-Za-z0-9_-]{10}$/);
  const go = (await dialog.locator('.skill-share-url').innerText()).trim();
  await dialog.getByRole('button', { name: '關閉分享', exact: true }).click();
  await creditVisit(browser, go, url => url.pathname === '/');
  await page.reload();
  await navigate(page, '推廣排行榜');
  const leader = page.locator('.promotion-person .promotion-avatar').first();
  await expect(leader).toBeVisible();
  expect((await leader.boundingBox())!.width).toBeLessThanOrEqual(36);
});

test('all six boards render, and a board with no clicks says so', async ({ page }) => {
  await login(page);
  await navigate(page, '推廣排行榜');
  for (const name of ['名片點擊排行榜', '平台推廣排行榜', '技能推廣排行榜', '社群推廣排行榜', '業務推廣排行榜', '活動推廣排行榜']) {
    await expect(board(page, name)).toBeVisible();
  }
  const cards = board(page, '名片點擊排行榜');
  await expect(cards).toContainText('在我的名片分享名片連結，每次點擊 +1。');
  await expect(cards).toContainText('你在這個排行榜還沒有分數。');
  await expect(board(page, '業務推廣排行榜')).toContainText('還沒有人得分，分享第一個連結吧。');
  await expect(page.getByText('計分規則', { exact: true })).toBeVisible();
});

test('share pages stay inside the viewport and stay readable in every theme', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page);
  await navigate(page, '社群分享');
  await page.getByText('分享一則貼文', { exact: true }).click();
  await expect(page.getByLabel('連結')).toHaveCSS('font-size', '16px');
  for (const width of [390, 820, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await noOverflow(page);
    const open = page.locator('article.social-card').filter({ has: page.getByRole('heading', { name: 'E2E 示範影片' }) }).getByRole('link', { name: '開啟原文 ↗' });
    expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  for (const theme of ['light', 'dark', 'versefolk'] as const) {
    await page.evaluate(value => { localStorage.setItem('freedom-theme', value); document.documentElement.dataset.theme = value; }, theme);
    if (theme !== 'light') await navigate(page, '社群分享');
    const backgrounds: string[] = [];
    for (const platform of ['youtube', 'instagram', 'facebook', 'other']) {
      const badge = page.locator(`.social-card-body .social-platform-badge[data-platform="${platform}"]`).first();
      await expect(badge).toBeVisible();
      const colors = await badge.evaluate(element => {
        const style = getComputedStyle(element);
        return { backgroundColor: style.backgroundColor, color: style.color };
      });
      expect(contrast(colors.color, colors.backgroundColor), `${theme} ${platform}`).toBeGreaterThanOrEqual(3);
      backgrounds.push(colors.backgroundColor);
    }
    expect(new Set(backgrounds).size, theme).toBe(4);
    const placeholder = page.locator('.social-placeholder').first();
    const placeholderColors = await placeholder.evaluate(element => {
      const style = getComputedStyle(element);
      return { backgroundColor: style.backgroundColor, color: style.color };
    });
    const cardColors = await placeholder.locator('xpath=ancestor::article[1]').evaluate(element => getComputedStyle(element).backgroundColor);
    expect(placeholderColors.backgroundColor, theme).not.toBe(cardColors);
    expect(contrast(placeholderColors.color, placeholderColors.backgroundColor), theme).toBeGreaterThanOrEqual(3);
    await navigate(page, '推廣排行榜');
    const pressed = page.getByRole('button', { name: '本週', exact: true });
    const resting = page.getByRole('button', { name: '累計', exact: true });
    const on = await pressed.evaluate(element => { const style = getComputedStyle(element); return { backgroundColor: style.backgroundColor, color: style.color }; });
    const off = await resting.evaluate(element => getComputedStyle(element).backgroundColor);
    expect(on.backgroundColor, theme).not.toBe(off);
    expect(contrast(on.color, on.backgroundColor), theme).toBeGreaterThanOrEqual(3);
    expect((await pressed.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  for (const width of [390, 820, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await noOverflow(page);
  }
});

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

async function themeOf(page: Page, theme: 'light' | 'dark' | 'versefolk') {
  await page.evaluate(value => { localStorage.setItem('freedom-theme', value); document.documentElement.dataset.theme = value; }, theme);
}

test('screenshots cover the boards, social zone, dialogs and interstitial', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await login(page);
  for (const theme of ['light', 'versefolk'] as const) {
    await navigate(page, '推廣排行榜');
    await themeOf(page, theme);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await shot(page, `leaderboard-${theme}-${width}`);
      await noOverflow(page);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('button', { name: '分享自由工坊', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '分享「自由工坊」' });
    await expect(dialog.locator('.skill-share-url')).toBeVisible();
    await dialog.screenshot({ path: `${SHOTS}/share-dialog-${theme}-1280.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog.screenshot({ path: `${SHOTS}/share-dialog-${theme}-390.png` });
    await dialog.getByRole('button', { name: '關閉分享', exact: true }).click();

    await navigate(page, '社群分享');
    await themeOf(page, theme);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await shot(page, `social-${theme}-${width}`);
      await noOverflow(page);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await navigate(page, '社群活動');
    const card = page.locator('article.experience-card').filter({ has: page.getByRole('heading', { name: EVENT_TITLE, level: 3 }) });
    await card.scrollIntoViewIfNeeded();
    if (!await card.getByLabel('分享連結').count()) await card.getByRole('button', { name: '分享活動', exact: true }).click();
    await expect(card.getByLabel('分享連結')).toBeVisible();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await card.screenshot({ path: `${SHOTS}/event-share-${theme}-${width}.png` });
    }
  }

  const context = await browser.newContext({ userAgent: GUEST_UA });
  const guest = await context.newPage();
  let release = () => {};
  const hold = new Promise<void>(resolve => { release = resolve; });
  await guest.route('**/api/v1/promotion/clicks', async route => { await hold; await route.fulfill({ json: { ok: true } }); });
  await guest.addInitScript(() => {
    const native = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => timeout === 1200 ? native(() => {}, 600_000) : native(handler, timeout, ...args)) as typeof setTimeout;
  });
  await guest.setViewportSize({ width: 1280, height: 900 });
  await guest.goto(eventGo || platformGo);
  await expect(guest.getByText(/正在前往/)).toBeVisible();
  await guest.screenshot({ path: `${SHOTS}/interstitial-light-1280.png`, fullPage: true });
  await guest.setViewportSize({ width: 390, height: 844 });
  await guest.screenshot({ path: `${SHOTS}/interstitial-light-390.png`, fullPage: true });
  await guest.setViewportSize({ width: 1280, height: 900 });
  await guest.emulateMedia({ colorScheme: 'dark' });
  await guest.screenshot({ path: `${SHOTS}/interstitial-dark-1280.png`, fullPage: true });
  await guest.setViewportSize({ width: 390, height: 844 });
  await guest.screenshot({ path: `${SHOTS}/interstitial-dark-390.png`, fullPage: true });
  release();
  await context.close();
});

test('the author can delete their social post', async ({ page }) => {
  await login(page);
  await navigate(page, '社群分享');
  const youtube = page.locator('article.social-card').filter({ has: page.getByRole('heading', { name: 'E2E 示範影片', level: 3 }) });
  await youtube.getByRole('button', { name: '刪除', exact: true }).click();
  await youtube.getByRole('button', { name: '確定刪除', exact: true }).click();
  await expect(youtube).toHaveCount(0);
});
