import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { navigate } from './navigation.js';
import { test, expect, type Locator, type Page } from './fixtures.js';

// 2026-09-24 skills / GitHub / co-creation audit: regressions found on desktop and 390px phones.
// Each case owns its data: UI-only cases stub reads explicitly; flows that write use a new synthetic member.
async function login(page: Page, email = 'maker@local.test') {
  await page.goto('/');
  await page.getByLabel('電子郵件', { exact: true }).fill(email);
  await page.getByLabel('密碼', { exact: true }).fill('freedom-local-demo');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.getByRole('button', { name: '登出', exact: true })).toBeVisible();
}
/** A member with no guilds, copied from the seeded community; never shared between tests. */
async function syntheticMember(pool: Pool, label: string) {
  const id = randomUUID(), email = `audit-${label}-${id}@local.test`;
  await pool.query("INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) SELECT $1,community_id,$2,'Audit member',password_hash,$3 FROM users WHERE email='maker@local.test'", [id, email, randomUUID()]);
  return email;
}
/** UI fixture: an empty grant list, independent of whatever memberships earlier specs created. */
async function emptyShelf(page: Page) {
  await page.route('**/api/v1/me/skill-books', route => route.fulfill({ json: { items: [] } }));
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
}
async function summariesReachable(scope: Locator) {
  const heights = await scope.locator('summary').evaluateAll(nodes => nodes.filter(node => (node as HTMLElement).offsetParent).map(node => [node.textContent?.trim(), node.getBoundingClientRect().height] as const));
  for (const [label, height] of heights) expect(height, `summary「${label}」觸控高度`).toBeGreaterThanOrEqual(44);
}
async function readableText(scope: Locator, selector: string) {
  const sizes = await scope.locator(selector).evaluateAll(nodes => nodes.filter(node => (node as HTMLElement).offsetParent && node.textContent?.trim()).map(node => [node.textContent!.trim().slice(0, 24), parseFloat(getComputedStyle(node).fontSize)] as const));
  for (const [label, size] of sizes) expect(size, `「${label}」字級`).toBeGreaterThanOrEqual(14);
  return sizes.length;
}
async function developmentFooter(page: Page) {
  const summary = page.locator('.development-context summary');
  await expect(summary).toBeVisible();
  expect((await summary.boundingBox())!.height, '共用開發入口觸控高度').toBeGreaterThanOrEqual(44);
  await summary.focus();
  await expect(summary).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.development-context details')).toHaveAttribute('open', '');
  expect(await summary.evaluate(node => getComputedStyle(node).outlineStyle)).not.toBe('none');
}

for (const width of [1280, 390]) {
  test.describe(`${width}px`, () => {
    test.beforeEach(async ({ page }) => { await page.setViewportSize({ width, height: 900 }); });

    test('an empty unlocked shelf offers guilds and the free preview instead of dead filters', async ({ page }) => {
      await emptyShelf(page);
      await login(page); await navigate(page, '技能書架');
      await expect(page.getByRole('button', { name: '已解鎖 · 0', exact: true })).toBeVisible();
      await expect(page.getByText('還沒有已解鎖的技能書。加入公會即可領取，也可先免費預覽。', { exact: true })).toBeVisible();
      await expect(page.getByLabel('搜尋技能書', { exact: true })).toHaveCount(0);
      await expect(page.getByText('沒有符合的技能書。試試另一個關鍵字或用途。')).toHaveCount(0);
      await expect(page.getByRole('button', { name: '選擇公會', exact: true })).toBeVisible();
      const catalog = await (await page.request.get('/api/v1/community')).json() as { skill_books: unknown[] };
      expect(catalog.skill_books).toHaveLength(37);
      await page.getByRole('button', { name: '免費預覽技能書', exact: true }).click();
      await expect(page.getByRole('button', { name: '未解鎖', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByText('顯示 37 / 37 本技能書', { exact: true })).toBeVisible();
      await expect(page.locator('.community-library article[data-access="locked"]')).toHaveCount(37);
      expect(await readableText(page.locator('.community-library'), '.skill-library-description .field-hint')).toBeGreaterThan(0);
      await summariesReachable(page.locator('main'));
      await developmentFooter(page);
      await noOverflow(page);
      await page.screenshot({ path: `test-results/audit-skills/skills-${width}.png`, fullPage: true });
    });

    test('the skill intro keeps Star/Fork/Follow and source links without repeating them', async ({ page }) => {
      await emptyShelf(page);
      await login(page); await navigate(page, '技能書架');
      await page.getByRole('button', { name: '免費預覽技能書', exact: true }).click();
      const card = page.locator('.community-library article[data-book-id="social-post"]');
      await card.getByRole('button', { name: '預覽技能書', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Hao 社群貼文技能書', exact: true });
      const upstream = 'https://github.com/Hao0321/claude-skill-social-post';
      await expect(dialog.getByRole('link', { name: '開啟原作 ↗', exact: true })).toHaveAttribute('href', upstream);
      await expect(dialog.getByRole('link', { name: 'Fork 原作 ↗', exact: true })).toHaveAttribute('href', `${upstream}/fork`);
      await expect(dialog.getByRole('link', { name: 'Fork 專案 ↗', exact: true })).toHaveAttribute('href', `${upstream}/fork`);
      await expect(dialog.getByRole('link', { name: 'Follow 原作者 ↗', exact: true })).toHaveAttribute('href', 'https://github.com/Hao0321');
      await expect(dialog.locator('.github-star-control')).toHaveCount(1);
      const collaboration = dialog.locator('.skill-intro-collaboration');
      await expect(collaboration.getByRole('link', { name: '查看原作 PR ↗', exact: true })).toHaveAttribute('href', `${upstream}/pulls`);
      await expect(collaboration.getByRole('link', { name: '交給 Agent ↗', exact: true })).toHaveAttribute('href', '/development/skills/social-post/SKILL.md');
      await expect(dialog.getByText('參與開發', { exact: true })).toHaveCount(0);
      await expect(dialog.getByRole('link', { name: '查看來源專案 ↗', exact: true })).toHaveCount(0);
      await expect(dialog.getByRole('link', { name: '工坊協作版本 ↗', exact: true })).toHaveCount(0);
      await dialog.getByText('作者、授權與收錄來源', { exact: true }).click();
      await expect(dialog).toContainText('來源 GitHub 帳號：Hao0321');
      await expect(dialog).toContainText('收錄版本：');
      // Source, status and help text in the dialog must stay readable on phones (DESIGN: body ≥ 14px).
      expect(await readableText(dialog, '.field-hint, .github-social-source a, .github-metrics-note, .github-action-status, .github-social-error, .github-book-metrics dt')).toBeGreaterThan(0);
      await noOverflow(page);
      await page.screenshot({ path: `test-results/audit-skills/skill-intro-${width}.png` });
      await page.keyboard.press('Escape');
      await expect(card.getByRole('button', { name: '預覽技能書', exact: true })).toBeFocused();
    });

    test('co-creation states the claim rule once and keeps task filters compact', async ({ page }) => {
      await login(page); await navigate(page, '一起開發');
      await expect(page.getByText('到 GitHub 任務留言認領；完成程式、測試、設計或文件後提交 PR，交由維護者審查。', { exact: true })).toHaveCount(1);
      await expect(page.getByText('篩選本次載入的任務', { exact: false })).toHaveCount(0);
      const filters = page.getByRole('region', { name: '任務篩選' });
      await expect(filters).toBeVisible();
      const [type, owner] = [await filters.locator('select').nth(0).boundingBox(), await filters.locator('select').nth(1).boundingBox()];
      expect(Math.abs(type!.y - owner!.y), '類型與負責人並排').toBeLessThan(4);
      await summariesReachable(page.locator('main'));
      await developmentFooter(page);
      await noOverflow(page);
      await page.screenshot({ path: `test-results/audit-skills/cocreation-${width}.png`, fullPage: true });
    });

    test('open-source registration recovers from a failed load and keeps the self-declared relationship precise', async ({ page }) => {
      let failures = 1;
      await page.route('**/api/v1/opensource/projects', route => route.request().method() === 'GET' && failures-- > 0 ? route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: '開源作品暫時無法載入。' } } }) : route.fallback());
      await login(page); await navigate(page, '開源投稿');
      const failure = page.getByRole('alert').filter({ has: page.getByRole('button', { name: '重新載入', exact: true }) });
      await expect(failure).toBeVisible();
      await failure.getByRole('button', { name: '重新載入', exact: true }).click();
      await expect(failure).toHaveCount(0);
      await expect(page.getByRole('region', { name: '社群開源作品' }).getByText(/已登錄 \d+ 件/)).toBeVisible();
      await page.getByText('手動上傳', { exact: true }).click();
      await expect(page.getByText('由你自行聲明；平台不以這次登錄驗證你與作品的來源、作者或擁有權關係。', { exact: true })).toBeVisible();
      await expect(page.getByText('平台目前尚未驗證你的 GitHub 身分', { exact: false })).toHaveCount(0);
      await page.getByLabel('GitHub 儲存庫網址', { exact: true }).fill('https://untrusted.example/owner/repository');
      await page.getByLabel('作品名稱', { exact: true }).fill('稽核：非 GitHub 來源');
      await page.getByLabel('這個作品可以做什麼', { exact: true }).fill('確認只接受 GitHub 儲存庫。');
      await page.getByLabel('如何開始使用', { exact: true }).fill('先閱讀使用文件。');
      await page.getByLabel('我同意讓社群會員看見作品介紹與來源關係', { exact: true }).check();
      await page.getByRole('button', { name: '從 GitHub 登錄', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('請使用 https://github.com/');
      await expect(page.getByLabel('作品名稱', { exact: true })).toHaveValue('稽核：非 GitHub 來源');
      await summariesReachable(page.locator('main'));
      await developmentFooter(page);
      await noOverflow(page);
      await page.screenshot({ path: `test-results/audit-skills/opensource-${width}.png`, fullPage: true });
    });

    test('community footprint offers an explicit reload after a failed read', async ({ page }) => {
      let failures = 1;
      await page.route('**/api/v1/community', route => failures-- > 0 ? route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'unavailable' } } }) : route.fallback());
      await login(page); await navigate(page, '自由工坊社群');
      const failure = page.getByRole('alert').filter({ hasText: '社群資料暫時無法載入。' });
      await expect(failure).toBeVisible();
      await failure.getByRole('button', { name: '重新載入社群足跡', exact: true }).click();
      await expect(failure).toHaveCount(0);
      await expect(page.locator('.community-metric').first()).toBeVisible();
      await expect(page.getByRole('link', { name: '查看社群開放資料 ↗', exact: true })).toBeVisible();
      const links = page.getByRole('navigation', { name: '自由工坊社群' }).getByRole('link');
      await expect(links).toHaveCount(4);
      for (const box of await links.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height))) expect(box).toBeGreaterThanOrEqual(44);
      await developmentFooter(page);
      await noOverflow(page);
      await page.screenshot({ path: `test-results/audit-skills/community-${width}.png`, fullPage: true });
    });

    test('public skill page and Agent SKILL.md stay usable without a session', async ({ page }) => {
      await page.goto('/development/skills/social-post');
      await expect(page.getByRole('heading', { name: 'Hao 社群貼文技能書', level: 1 })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Follow 原作者 ↗', exact: true }).first()).toHaveAttribute('href', 'https://github.com/Hao0321');
      await summariesReachable(page.locator('body'));
      await noOverflow(page);
      const response = await page.request.get('/development/skills/social-post/SKILL.md');
      expect(response.headers()['content-type']).toContain('text/markdown');
      const [, frontmatter] = (await response.text()).split('---\n');
      const keys = frontmatter.trim().split('\n').map(line => line.split(':')[0]);
      expect(keys).toEqual(['name', 'description']);
      expect(frontmatter).toMatch(/^name: [a-z0-9-]{1,64}$/m);
      await page.screenshot({ path: `test-results/audit-skills/public-skill-${width}.png`, fullPage: true });
    });

    test('a cancelled GitHub authorization does not misstate an existing connection', async ({ page }) => {
      await page.goto('/github/callback?error=access_denied&state=synthetic');
      await expect(page.getByRole('alert')).toHaveText('你已取消這次 GitHub 授權，原有的連結狀態不受影響。需要時可回到原頁面再連結。');
      await expect(page.getByText('帳號尚未連結', { exact: false })).toHaveCount(0);
      await expect(page).toHaveURL(/\/github\/callback$/);
      await expect(page.getByRole('link', { name: '返回技能書架', exact: true })).toHaveAttribute('href', '/#skills');
      await noOverflow(page);
    });

    test('the shelf top connects GitHub once, returns to #skills and never stars on its own', async ({ page }) => {
      let connected = false, starWrites = 0; const connects: unknown[] = [];
      await emptyShelf(page);
      await page.route('**/api/v1/me/github', route => route.fulfill({ json: { configured: true, connected, github_user: connected ? { id: 'synthetic-shelf', login: 'synthetic-shelf' } : null } }));
      await page.route('**/api/v1/me/github/books/*/star', route => { if (route.request().method() === 'POST') starWrites++; return route.fulfill({ json: { book_id: route.request().url().split('/').at(-2), starred: false, connected } }); });
      await page.route('**/api/v1/me/github/connect', route => { connects.push(route.request().postDataJSON()); return route.fulfill({ json: { authorization_url: 'https://github.com/login/oauth/authorize?client_id=synthetic&state=synthetic' } }); });
      await page.route('https://github.com/login/oauth/authorize?*', route => route.fulfill({ contentType: 'text/html', body: '<p>Synthetic authorization</p>' }));
      await page.route('**/api/v1/me/github/complete', route => { connected = true; return route.fulfill({ json: { return_to: '#skills' } }); });
      await login(page); await navigate(page, '技能書架');
      const shelf = page.getByRole('region', { name: 'GitHub 連結', exact: true });
      await expect(shelf).toContainText('連結本身不會替你 Star');
      await expect(shelf.getByRole('button', { name: '解除 GitHub 連結', exact: true })).toHaveCount(0);
      expect(await readableText(shelf, 'p')).toBeGreaterThan(0);
      await noOverflow(page);
      await page.screenshot({ path: `test-results/audit-skills/shelf-github-${width}.png` });
      await shelf.getByRole('button', { name: '連結 GitHub', exact: true }).click();
      await expect(page).toHaveURL(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);
      expect(connects).toEqual([{ return_to: '#skills' }]);
      await page.goto('/github/callback?code=synthetic&state=synthetic-shelf-return-state');
      await expect(page).toHaveURL(/\/#skills$/);
      const linked = page.getByRole('region', { name: 'GitHub 連結', exact: true });
      await expect(linked).toContainText('GitHub 已連結 @synthetic-shelf');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.getByRole('button', { name: '免費預覽技能書', exact: true }).click();
      const card = page.locator('.community-library article[data-book-id="social-post"]');
      await card.scrollIntoViewIfNeeded();
      await expect(card.getByRole('button', { name: 'Star', exact: true })).toBeEnabled();
      await expect(card.getByRole('link', { name: 'Fork 專案 ↗', exact: true })).toHaveAttribute('href', 'https://github.com/Hao0321/claude-skill-social-post/fork');
      expect(starWrites).toBe(0);
      await linked.getByRole('button', { name: '管理 GitHub 連結', exact: true }).click();
      await expect(page.locator('.github-connection-panel').getByRole('button', { name: '解除 GitHub 連結', exact: true })).toBeVisible();
      expect(starWrites).toBe(0);
    });

    test('the shelf GitHub entry reports unconfigured and failed reads honestly', async ({ page, e2eAuthPool }) => {
      let fail = true;
      await page.route('**/api/v1/me/github', route => fail ? route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'GitHub 連結狀態暫時無法讀取。' } } }) : route.fallback());
      // An ordinary member with no guild uses the real (unconfigured) local GitHub setting.
      await login(page, await syntheticMember(e2eAuthPool, 'github'));
      await navigate(page, '技能書架');
      const shelf = page.getByRole('region', { name: 'GitHub 連結', exact: true });
      await expect(shelf.getByRole('alert')).toBeVisible();
      await expect(shelf).not.toContainText('已連結');
      fail = false;
      await shelf.getByRole('button', { name: '重新讀取 GitHub 連結', exact: true }).click();
      await expect(shelf).toHaveText('GitHub 連結尚未啟用；仍可到 GitHub 上 Star、Fork 原作。');
      await expect(shelf.getByRole('button')).toHaveCount(0);
      await noOverflow(page);
    });

    test('joining a guild from an open book refreshes grants after the dialogs close', async ({ page, e2eAuthPool }) => {
      await login(page, await syntheticMember(e2eAuthPool, 'refresh'));
      await navigate(page, '技能書架');
      await expect(page.getByRole('button', { name: '已解鎖 · 0', exact: true })).toBeVisible();
      await page.getByRole('button', { name: '未解鎖', exact: true }).click();
      // multi-ai-chat is one of the AI 開發公會 books, so it leaves the locked list once granted.
      const card = page.locator('.community-library article[data-book-id="multi-ai-chat"]');
      await card.getByRole('button', { name: '預覽技能書', exact: true }).click();
      const intro = page.locator('dialog.skill-intro-dialog[data-book-id="multi-ai-chat"]');
      await expect(intro).toBeVisible();
      await intro.getByRole('button', { name: '開發這本技能書', exact: true }).click();
      const access = page.getByRole('dialog', { name: '開發啟用任務', exact: true });
      await access.getByRole('button', { name: '加入AI 開發公會', exact: true }).click();
      await expect(access.getByText(/已有開發資格/)).toBeVisible();
      const granted = await (await page.request.get('/api/v1/me/skill-books')).json() as { items: { book_id: string }[] };
      const total = new Set(granted.items.map(item => item.book_id)).size;
      expect(total).toBeGreaterThan(0);
      expect(granted.items.map(item => item.book_id)).toContain('multi-ai-chat');
      // Closing the development dialog returns to the still-open book; the shelf does not re-render beneath it.
      await page.keyboard.press('Escape');
      await expect(access).toHaveCount(0);
      await expect(intro).toBeVisible();
      await expect(intro.getByRole('button', { name: '開發這本技能書', exact: true })).toBeFocused();
      await expect(page.getByRole('button', { name: '已解鎖 · 0', exact: true, includeHidden: true })).toHaveCount(1);
      await page.keyboard.press('Escape');
      await expect(intro).toBeHidden();
      await expect(page.getByRole('button', { name: `已解鎖 · ${total}`, exact: true })).toBeVisible();
      await expect(page.getByRole('status').filter({ hasText: `已解鎖 ${total} 本新技能書` })).toBeVisible();
      // The unlocked book left the locked list, so focus moves to the unlocked tab instead of being lost.
      await expect(page.getByRole('button', { name: `已解鎖 · ${total}`, exact: true })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.locator('.community-library article[data-access="unlocked"]')).toHaveCount(total);
      await expect(page.locator('.community-library article[data-book-id="multi-ai-chat"][data-access="unlocked"]')).toBeVisible();
      await noOverflow(page);
    });
  });
}
