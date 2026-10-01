import { test, expect, type Page } from './fixtures.js';
import { navigate, signOut } from './navigation.js';

async function login(page: Page, email = 'maker@local.test') {
  await page.goto('/');
  await page.getByLabel('電子郵件', { exact: true }).fill(email);
  await page.getByLabel('密碼', { exact: true }).fill('freedom-local-demo');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.getByRole('heading', { name: '會員首頁', exact: true })).toBeVisible();
}
async function fillTool(page: Page, title: string) {
  await page.getByLabel('GitHub 專案網址', { exact: true }).fill('https://github.com/freetwai-test/simple-work');
  await page.getByLabel('作品名稱', { exact: true }).fill(title);
  await page.getByLabel('一句話介紹', { exact: true }).fill('幫創作者把零散想法整理成合作提案。');
}

for (const width of [1280, 320]) test(`${width}px member shares a real work link without an artifact code and another member can request cooperation`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  let galleryReads = 0;
  page.on('request', request => { if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/v1/showcases') galleryReads++; });
  await login(page);
  await navigate(page, '作品與需求');
  const title = `共同創作範例 ${width}`;
  await expect(page.getByLabel('成果引用（例如 artifact:template-v1）')).toBeHidden();
  await page.getByLabel('作品標題', { exact: true }).fill(title);
  await page.getByLabel('一句話介紹', { exact: true }).fill('設計、影片和工具都能用同一個簡單入口分享。');
  await page.getByLabel('作品連結（選填）', { exact: true }).fill('https://example.com/portfolio');
  await page.getByLabel('我同意以社群可見方式分享這件作品').check();
  await page.getByRole('button', { name: '發布作品', exact: true }).click();
  await expect(page.getByRole('region', { name: '作品發布成功' })).toBeFocused();
  expect(galleryReads).toBe(1); // The POST result updates the gallery without another round trip.
  await page.getByRole('button', { name: '查看剛分享的作品' }).click();
  const own = page.getByRole('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  await expect(own).toBeFocused();
  await expect(own.getByRole('link', { name: '查看作品 ↗' })).toHaveAttribute('href', 'https://example.com/portfolio');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/simple-work-sharing/showcase-${width}.png`, fullPage: true });
  await signOut(page); await login(page, 'client@local.test'); await navigate(page, '作品與需求');
  const other = page.getByRole('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  await other.getByRole('button', { name: '我想找你合作' }).click();
  const need = `一起完成一支產品介紹影片 ${width}。`;
  await other.getByLabel('你的需求', { exact: true }).fill(need);
  await other.getByRole('button', { name: '送出合作需求' }).click();
  await expect(page.getByRole('paragraph').filter({ hasText: need })).toBeVisible();
});

test('simple tool submission previews without writes, edits freely, then publishes a real public page and shelf entry', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const writes: string[] = [];
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.includes('skill-submissions')) writes.push(new URL(request.url()).pathname); });
  await login(page); await navigate(page, '技能書架');
  await page.getByRole('button', { name: '投稿開源工具', exact: true }).click();
  await expect(page).toHaveURL(/#opensource$/);
  await expect(page.getByRole('button', { name: '上傳技能' })).toBeHidden();
  await fillTool(page, '想法整理工具');
  await page.getByRole('button', { name: '預覽投稿' }).click();
  await expect(page.getByRole('heading', { name: '確認這樣分享，好嗎？' })).toBeFocused();
  expect(writes).toEqual([]);
  await expect(page.getByRole('button', { name: '確認並公開' })).toBeDisabled();
  await page.getByRole('button', { name: '修改內容' }).click();
  await expect(page.getByLabel('作品名稱', { exact: true })).toHaveValue('想法整理工具');
  await page.getByLabel('作品名稱', { exact: true }).fill('一起完成作品');
  await page.getByRole('button', { name: '預覽投稿' }).click();
  await page.getByLabel('我同意公開這份作品介紹與來源關係', { exact: true }).check();
  await page.getByRole('button', { name: '確認並公開' }).click();
  const completed = page.getByRole('region', { name: '投稿完成' });
  await expect(completed).toBeFocused();
  expect(writes).toHaveLength(2);
  const path = await completed.getByRole('link', { name: '查看作品頁 ↗' }).getAttribute('href');
  const response = await page.request.get(path!);
  expect(response.status()).toBe(200); expect(await response.text()).toContain('一起完成作品');
  await completed.getByRole('button', { name: '複製作品連結' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(new URL(path!, page.url()).href);
  await navigate(page, '技能書架');
  await expect(page.locator('.community-skill-library').getByRole('heading', { name: '一起完成作品', exact: true })).toBeVisible();
});

test('a failed publish keeps one private draft and resumes after reload without duplicate posting', async ({ page }) => {
  let fail = true, manualWrites = 0;
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/skill-submissions/manual')) manualWrites++; });
  await page.route('**/api/v1/me/skill-submissions/*/publish', route => fail ? route.fulfill({ status: 503, json: { title: '暫時無法公開', detail: '請稍後重試。' } }) : route.fallback());
  await login(page); await navigate(page, '開源投稿');
  await fillTool(page, '保留草稿範例');
  await page.getByRole('button', { name: '預覽投稿' }).click();
  await page.getByLabel('我同意公開這份作品介紹與來源關係', { exact: true }).check();
  await page.getByRole('button', { name: '確認並公開' }).click();
  await expect(page.getByRole('alert')).toContainText('請稍後重試');
  await expect(page.getByText(/已保存私人草稿/)).toBeVisible();
  await page.reload();
  await page.getByText(/繼續未公開的草稿/).click();
  await page.getByRole('button', { name: '繼續投稿：保留草稿範例' }).click();
  await page.getByRole('button', { name: '修改內容' }).click();
  await page.getByLabel('作品名稱', { exact: true }).fill('同一份草稿修正版');
  await page.getByRole('button', { name: '預覽投稿' }).click();
  fail = false;
  await page.getByLabel('我同意公開這份作品介紹與來源關係', { exact: true }).check();
  await page.getByRole('button', { name: '重試公開投稿' }).click();
  await expect(page.getByRole('region', { name: '投稿完成' })).toBeVisible();
  const ownDrafts = (await (await page.request.get('/api/v1/me/skill-submissions')).json()).items;
  expect(ownDrafts.filter((item: any) => item.payload?.title === '同一份草稿修正版')).toHaveLength(1);
  expect(manualWrites).toBe(1);
});

test('320px tool form and review remain readable in all three themes with optional fields collapsed', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 }); await login(page); await navigate(page, '開源投稿');
  await fillTool(page, '讓不同專業的夥伴一起完成可分享的作品');
  for (const theme of ['light', 'dark', 'versefolk']) {
    await page.evaluate(value => { localStorage.setItem('freedom-theme', value); document.documentElement.dataset.theme = value; window.dispatchEvent(new Event('freedom-theme-changed')); }, theme);
    await expect(page.getByLabel('如何開始使用', { exact: true })).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const sizes = await page.locator('.work-sharing-form input, .work-sharing-form textarea').evaluateAll(nodes => nodes.filter(node => (node as HTMLElement).offsetParent).map(node => parseFloat(getComputedStyle(node).fontSize)));
    expect(sizes.every(size => size >= 16)).toBe(true);
    await page.screenshot({ path: `test-results/simple-work-sharing/tool-${theme}-320.png`, fullPage: true });
  }
  await page.getByRole('button', { name: '預覽投稿' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/simple-work-sharing/review-320.png', fullPage: true });
});
