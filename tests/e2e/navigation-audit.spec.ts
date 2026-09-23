import { test, expect, type Page } from './fixtures.js';
import { navigate } from './navigation.js';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('電子郵件', { exact: true }).fill('maker@local.test');
  await page.getByLabel('密碼', { exact: true }).fill('freedom-local-demo');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.locator('.shell')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/me/github', route => route.fulfill({ json: { configured: false, connected: false, github_user: null } }));
});

test('navigation separates collaboration, commerce and management without granting a member a guild role', async ({ page }) => {
  await page.route('**/api/v1/guild-workspace', route => route.fulfill({ json: { managed_guilds: [], managed_books: [], can_discuss: false } }));
  await login(page);
  const nav = page.getByRole('navigation', { name: '主要工作區' });
  const collaboration = nav.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^一起協作/ }) });
  const commerce = nav.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^供貨與銷售/ }) });
  const management = nav.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^管理/ }) });
  await expect(collaboration).toHaveCount(1); await expect(commerce).toHaveCount(1); await expect(management).toHaveCount(1);
  await expect(management.getByRole('button', { name: '公會管理', includeHidden: true, exact: true })).toHaveCount(0);
  await management.locator(':scope > summary').click();
  await expect(management.getByRole('link', { name: /平台管理/ })).toHaveAttribute('href', '/admin');
  await expect(nav.getByText('參與平台', { exact: true })).toHaveCount(0);
  await expect(nav.getByText('我的協作', { exact: true })).toHaveCount(0);
  await navigate(page, '開源投稿');
  await expect(page.getByRole('heading', { name: '開源投稿', level: 1, exact: true })).toBeVisible();
  await expect(page.locator('.community-library')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '登錄開源作品', exact: true })).toBeVisible();
  await navigate(page, '供貨中心');
  await expect(page.getByRole('heading', { name: '供貨中心', level: 1, exact: true })).toBeVisible();
  await expect(commerce.getByRole('button', { name: '供貨中心', exact: true })).toHaveAttribute('aria-current', 'page');
});

test('a synthetic maintainer permission projection reveals guild management beside platform management', async ({ page }) => {
  await page.route('**/api/v1/guild-workspace', route => route.fulfill({ json: { managed_guilds: [], managed_books: [{ book_id: 'social-post', title: '測試維護技能' }], can_discuss: false } }));
  await page.route('**/api/v1/skill-books/social-post/editor', route => route.fulfill({ json: { book_id: 'social-post', summary: '測試技能摘要', collaboration_intro: '從公開任務開始', tasks: [], milestones: [], aggregate_version: 1 } }));
  await login(page); await navigate(page, '公會管理');
  const nav = page.getByRole('navigation', { name: '主要工作區' });
  const group = nav.getByRole('button', { name: '公會管理', exact: true }).locator('xpath=ancestor::details[1]');
  await expect(group.locator(':scope > summary')).toContainText('管理');
  await expect(group.getByRole('link', { name: /平台管理/ })).toHaveAttribute('href', '/admin');
  await expect(page.getByRole('heading', { name: '公會管理', level: 1, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '技能書編輯', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '公會長議事區', exact: true })).toHaveCount(0);
});

test('phone navigation opens, escapes and closes after selection while keeping every destination reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await login(page);
  const menu = page.getByRole('button', { name: /^(開啟|關閉)選單$/ });
  const nav = page.getByRole('navigation', { name: '主要工作區', includeHidden: true });
  await expect(menu).toHaveAttribute('aria-expanded', 'false'); await expect(nav).toBeHidden();
  await menu.click(); await expect(menu).toHaveAttribute('aria-expanded', 'true'); await expect(nav).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(nav).toBeHidden(); await expect(menu).toBeFocused();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const label of ['技能書架', '一起開發', '供貨中心', '工坊夥伴', '自由工坊社群', '會員首頁']) {
      await navigate(page, label);
      await expect(page.getByRole('heading', { name: label, level: 1, exact: true })).toBeVisible();
      await expect(nav).toBeHidden(); await expect(menu).toHaveAttribute('aria-expanded', 'false');
      await expect(menu).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      // Selecting the current page still closes the menu and releases hidden navigation focus.
      await navigate(page, label);
      await expect(nav).toBeHidden();
      await expect(page.locator('#main-content')).toBeFocused();
    }
  }
});

test('skip navigation preserves the module, and deep links plus browser history preserve selected destinations', async ({ page }) => {
  await login(page); await page.goto('/#positioning');
  await expect(page.getByRole('heading', { name: '我的定位', level: 1, exact: true })).toBeVisible();
  const skip = page.getByRole('link', { name: '跳到主要內容', exact: true });
  await skip.focus(); await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#positioning$/); await expect(page.locator('#main-content')).toBeFocused();
  await expect(page.locator('.positioning-heading')).toHaveCount(0);
  await navigate(page, '技能書架'); await navigate(page, '開源投稿');
  await page.goBack(); await expect(page).toHaveURL(/#skills$/);
  await expect(page.getByRole('heading', { name: '技能書架', level: 1, exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '技能書架', level: 1, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await navigate(page, '自由工坊社群');
  await expect(page.locator('.community-library')).toHaveCount(0);
  await page.getByRole('button', { name: '前往技能書架', exact: true }).click();
  await expect(page).toHaveURL(/#skills$/);
  await page.getByRole('button', { name: '我的名片', exact: true }).click();
  await expect(page.locator('.member-bookshelf,.community-library')).toHaveCount(0);
});

test('the personal shelf displays only authoritative granted book IDs and can return to the full catalog', async ({ page }) => {
  await login(page);
  const catalog = await (await page.request.get('/api/v1/community')).json();
  const chosen = catalog.skill_books.filter((book: { id: string }) => ['social-post', 'video-autopilot'].includes(book.id));
  expect(chosen).toHaveLength(2);
  await page.route('**/api/v1/me/skill-books', route => route.fulfill({ json: { items: chosen.map((book: { id: string }) => ({ ...book, book_id: book.id })) } }));
  await navigate(page, '技能書架');
  const library = page.locator('.community-library');
  await expect(library.locator('article[data-book-id]')).toHaveCount(catalog.skill_books.length);
  const tabs = page.getByRole('group', { name: '技能書範圍', exact: true });
  // This category exists only in the full catalog, not in these two granted books.
  const category = library.getByRole('combobox', { name: '依工坊用途篩選', exact: true });
  await category.selectOption({ label: '資訊安全' });
  await expect(library.locator('article[data-book-id]')).toHaveCount(1);
  await expect(library.locator('article[data-book-id]')).toHaveAttribute('data-book-id', 'security-scanner');
  await tabs.getByRole('button', { name: /^我的技能書(?: · \d+)?$/ }).click();
  await expect(tabs.getByRole('button', { name: /^我的技能書(?: · \d+)?$/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(library.locator('article[data-book-id]')).toHaveCount(2);
  await expect(category).toHaveValue('');
  await expect(category.locator('option').filter({ hasText: /^資訊安全$/ })).toHaveCount(0);
  expect(await library.locator('article[data-book-id]').evaluateAll(cards => cards.map(card => card.getAttribute('data-book-id')).sort())).toEqual(['social-post', 'video-autopilot']);
  await tabs.getByRole('button', { name: '全部技能書', exact: true }).click();
  await expect(library.locator('article[data-book-id]')).toHaveCount(catalog.skill_books.length);
  await expect(tabs.getByRole('button', { name: '全部技能書', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('a failed personal-shelf read never falls back to all books and retries without changing scope', async ({ page }) => {
  await login(page);
  let failing = true;
  await page.route('**/api/v1/me/skill-books', route => failing
    ? route.fulfill({ status: 503, json: { detail: 'Synthetic shelf read failure' } })
    : route.fulfill({ json: { items: [{ book_id: 'social-post' }] } }));
  await navigate(page, '技能書架');
  await expect(page.locator('.community-library article[data-book-id]')).toHaveCount(25);
  await page.getByRole('group', { name: '技能書範圍' }).getByRole('button', { name: /^我的技能書(?: · \d+)?$/ }).click();
  await expect(page.getByRole('alert')).toContainText('我的技能書暫時無法載入');
  await expect(page.locator('.community-library article[data-book-id]')).toHaveCount(0);
  failing = false;
  await page.getByRole('button', { name: '重新載入我的技能書', exact: true }).click();
  await expect(page.locator('.community-library article[data-book-id]')).toHaveCount(1);
  await expect(page.locator('.community-library article[data-book-id]')).toHaveAttribute('data-book-id', 'social-post');
  await expect(page.getByRole('group', { name: '技能書範圍' }).getByRole('button', { name: /^我的技能書(?: · \d+)?$/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('alert')).toHaveCount(0);
});
