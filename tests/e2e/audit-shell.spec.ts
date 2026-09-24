import { test, expect, type Page } from './fixtures.js';
import { navigate } from './navigation.js';

// Site-wide shell audit (2026-09-24): sign-in/registration and the workspace frame at 1280px, 390px and 320px.
// Functional checks only; screenshots of synthetic demo accounts go to test-results.
const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'phone-390', width: 390, height: 844 },
  { name: 'phone-320', width: 320, height: 640 },
] as const;

async function noHorizontalOverflow(page: Page, label: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), label).toBe(true);
}

async function focusedIsVisiblyOutlined(page: Page) {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body) return false;
    const style = getComputedStyle(active);
    return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2;
  });
}

// DESIGN: every touch target is at least 44px tall and wide enough to hit.
async function expectTouchTargets(page: Page, selector: string, label: string) {
  const sizes = await page.locator(selector).evaluateAll(nodes => nodes
    .filter(node => (node as HTMLElement).offsetParent !== null)
    .map(node => { const box = node.getBoundingClientRect(); return { text: (node.getAttribute('aria-label') ?? node.textContent ?? '').trim().slice(0, 20), width: box.width, height: box.height }; }));
  expect(sizes.length, label).toBeGreaterThan(0);
  for (const size of sizes) {
    expect(size.height, `${label}: ${size.text}`).toBeGreaterThanOrEqual(44);
    expect(size.width, `${label}: ${size.text}`).toBeGreaterThanOrEqual(44);
  }
}

async function signIn(page: Page) {
  await page.getByLabel('電子郵件', { exact: true }).fill('maker@local.test');
  await page.getByLabel('密碼', { exact: true }).fill('freedom-local-demo');
  await page.getByLabel('密碼', { exact: true }).press('Enter');
  await expect(page.getByRole('heading', { name: '會員首頁', level: 1, exact: true })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/me/github', route => route.fulfill({ json: { configured: false, connected: false, github_user: null } }));
});

for (const viewport of VIEWPORTS) {
  test(`sign-in keeps the whole logo, reaches the form first on phones and is keyboard operable (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '登入', exact: true })).toBeVisible();
    await noHorizontalOverflow(page, `${viewport.name} login`);
    const logo = page.locator('.login-story .brand-poster img');
    await expect(logo).toBeVisible();
    expect(await logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0 && getComputedStyle(img).objectFit === 'contain')).toBe(true);
    await expect(page.locator('h1')).toHaveCount(1);
    // One concrete sentence under the logo; no English eyebrow, journey list or duplicate brand subheading.
    const purpose = page.getByRole('heading', { level: 1 });
    await expect(purpose).toHaveText('完成定位、加入公會、領取 Repo 技能書，和夥伴一起供貨、開店與做開源作品。');
    await expect(purpose).toBeVisible();
    expect(await purpose.evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(16);
    await expect(page.locator('.login-layout')).not.toContainText(/BUILD WITHOUT LIMITS|DISCOVER|BELONG|CREATE|FREEDOM WORKSHOP/);
    await expect(page.locator('.login-journey, .login-brand')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 2 })).toHaveText(['登入']);
    await expectTouchTargets(page, '.login-card button, .login-card input:not([type=checkbox]):not([type=radio])', `${viewport.name} login controls`);

    const form = await page.locator('.login-card').boundingBox();
    const story = await page.locator('.login-story-copy').boundingBox();
    const poster = await page.locator('.login-story .brand-poster').boundingBox();
    if (viewport.width <= 860) {
      // Returning members see the logo, then the form, before the pitch copy.
      expect(poster!.y).toBeLessThan(form!.y);
      expect(form!.y).toBeLessThan(story!.y);
      const email = await page.getByLabel('電子郵件', { exact: true }).boundingBox();
      expect(email!.y + email!.height).toBeLessThanOrEqual(viewport.height);
    } else {
      // Desktop stays balanced: logo + sentence on the left, the form on the right, vertically overlapping.
      expect(form!.x).toBeGreaterThan(poster!.x + poster!.width);
      expect(form!.y).toBeLessThan(story!.y + story!.height);
      expect(form!.y + form!.height).toBeGreaterThan(poster!.y);
    }

    const switcher = page.getByRole('group', { name: '登入或建立帳號' });
    await expect(switcher.getByRole('button', { name: '會員登入', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(switcher.getByRole('button', { name: '建立帳號', exact: true })).toHaveAttribute('aria-pressed', 'false');

    // Keyboard order from the top of the page: mode switch, email, password, submit; every stop shows a focus ring.
    const expected = ['會員登入', '建立帳號', 'email', 'password', '登入'];
    for (const stop of expected) {
      await page.keyboard.press('Tab');
      const label = await page.evaluate(() => {
        const el = document.activeElement as HTMLInputElement;
        return el.tagName === 'INPUT' ? el.name : (el.textContent ?? '').trim();
      });
      expect(label).toBe(stop);
      expect(await focusedIsVisiblyOutlined(page)).toBe(true);
      await expect(page.locator(':focus')).toBeInViewport();
    }
    await page.screenshot({ path: `test-results/audit-shell-login-${viewport.name}.png`, fullPage: true });
  });
}

test('registration mode switches by keyboard, keeps one email field and states the real password-recovery limit', async ({ page }) => {
  for (const viewport of [VIEWPORTS[0], VIEWPORTS[2]]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/');
    const register = page.getByRole('button', { name: '建立帳號', exact: true });
    await register.focus();
    await page.keyboard.press('Space');
    await expect(register).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: '會員登入', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('heading', { name: '加入自由工坊', exact: true })).toBeVisible();
    // The accessible name is exactly the label; the hint is a description, not part of the name.
    const nickname = page.getByLabel('社群顯示名稱', { exact: true });
    await expect(nickname).toBeVisible();
    await expect(nickname).toHaveAccessibleName('社群顯示名稱');
    await expect(nickname).toHaveAccessibleDescription('建議使用大家熟悉的社群名字');
    await expect(page.getByText('建議使用大家熟悉的社群名字', { exact: true })).toBeVisible();
    await expect(page.locator('.login-card input')).toHaveCount(3);
    await expect(page.locator('.login-card input[type=email]')).toHaveCount(1);
    await expectTouchTargets(page, '.login-card button, .login-card input', `${viewport.name} registration controls`);
    // Keyboard order in registration: nickname, email, password, submit.
    await page.keyboard.press('Tab');
    await expect(nickname).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('電子郵件', { exact: true })).toBeFocused();
    await expect(page.getByLabel('電子郵件', { exact: true })).toHaveCount(1);
    await expect(page.getByLabel('密碼', { exact: true })).toHaveAttribute('minlength', '12');
    await expect(page.getByText('目前無法用 E-mail 找回密碼', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: '註冊並開始定位', exact: true })).toBeVisible();
    await noHorizontalOverflow(page, `${viewport.name} registration`);
    // Demo shortcuts belong to sign-in only.
    await expect(page.getByRole('complementary', { name: '示範帳號' })).toHaveCount(0);
  }
});

test('a rejected sign-in is announced without leaving the form', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByLabel('電子郵件', { exact: true }).fill('maker@local.test');
  await page.getByLabel('密碼', { exact: true }).fill('not-the-demo-password');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.locator('.login-card').getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('電子郵件', { exact: true })).toHaveValue('maker@local.test');
  await expect(page.locator('.shell')).toHaveCount(0);
});

test('the skip link stays hidden until focused, then moves focus to the page without changing it', async ({ page }) => {
  await page.goto('/');
  await signIn(page);
  await navigate(page, '技能書架');
  await expect(page.getByRole('heading', { name: '技能書架', level: 1, exact: true })).toBeVisible();
  // Fresh load so keyboard navigation starts at the top of the document.
  await page.reload();
  await expect(page.getByRole('heading', { name: '技能書架', level: 1, exact: true })).toBeVisible();
  const skip = page.getByRole('link', { name: '跳到主要內容', exact: true });
  // Regression: the link used to peek a few pixels into the top edge of every page.
  expect((await skip.boundingBox())!.y + (await skip.boundingBox())!.height).toBeLessThanOrEqual(0);
  await page.keyboard.press('Tab');
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await expectTouchTargets(page, '.skip', 'focused skip link');
  expect(await focusedIsVisiblyOutlined(page)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
  await expect(page).toHaveURL(/#skills$/);
  await expect(page.getByRole('heading', { name: '技能書架', level: 1, exact: true })).toBeVisible();
  expect((await skip.boundingBox())!.y + (await skip.boundingBox())!.height).toBeLessThanOrEqual(0);
});

for (const viewport of VIEWPORTS) {
  test(`workspace shell has one page title, reachable account actions and a usable navigation at ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/');
    await signIn(page);
    await expect(page.locator('h1')).toHaveCount(1);
    await noHorizontalOverflow(page, `${viewport.name} home`);
    for (const name of ['我的名片', '登出']) {
      await expect(page.locator('.topbar').getByRole('button', { name, exact: true })).toBeInViewport();
    }
    await expectTouchTargets(page, '.topbar-actions .btn', `${viewport.name} topbar actions`);
    if (viewport.width <= 860) await expectTouchTargets(page, '.mobile-menu-toggle', `${viewport.name} menu toggle`);
    else await expectTouchTargets(page, '.workspace-navigation .nav-item, .nav-section > summary', `${viewport.name} sidebar`);
    const nav = page.getByRole('navigation', { name: '主要工作區', includeHidden: true });
    if (viewport.width <= 860) {
      const menu = page.getByRole('button', { name: /^(開啟|關閉)選單$/ });
      // After scrolling the page the phone header (logo + menu button) remains reachable.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await expect(menu).toBeInViewport();
      await menu.focus();
      await page.keyboard.press('Enter');
      await expect(menu).toHaveAttribute('aria-expanded', 'true');
      await expect(nav).toBeVisible();
      await page.keyboard.press('Tab');
      await expect(nav.getByRole('button', { name: '會員首頁', exact: true })).toBeFocused();
      // Every group opens inside the menu; the last destination can be scrolled into view and chosen.
      for (const summary of await nav.locator('.nav-section > summary').all()) {
        if (!await summary.evaluate(node => (node.parentElement as HTMLDetailsElement).open)) await summary.click();
      }
      const last = nav.getByRole('button', { name: '自由工坊社群', exact: true });
      await last.scrollIntoViewIfNeeded();
      await expect(last).toBeInViewport();
      await noHorizontalOverflow(page, `${viewport.name} open menu`);
      await expectTouchTargets(page, '.workspace-navigation .nav-item, .nav-section > summary', `${viewport.name} open menu`);
      await page.screenshot({ path: `test-results/audit-shell-menu-${viewport.name}.png` });
      await last.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('heading', { name: '自由工坊社群', level: 1, exact: true })).toBeVisible();
      await expect(nav).toBeHidden();
      await expect(page.locator('#main-content')).toBeFocused();
      await expect(page.getByRole('heading', { level: 1 })).toBeInViewport();
    } else {
      await expect(nav).toBeVisible();
      // Keyboard from a fresh load: skip link, then the primary destinations in order.
      await page.reload();
      await expect(page.getByRole('heading', { name: '會員首頁', level: 1, exact: true })).toBeVisible();
      await page.keyboard.press('Tab');
      await expect(page.getByRole('link', { name: '跳到主要內容', exact: true })).toBeFocused();
      for (const name of ['會員首頁', '我的定位', '職業公會', '技能書架', '工坊夥伴']) {
        await page.keyboard.press('Tab');
        await expect(nav.getByRole('button', { name, exact: true })).toBeFocused();
        expect(await focusedIsVisiblyOutlined(page)).toBe(true);
      }
      // A collapsed group opens from the keyboard and its first page is the next stop.
      await page.keyboard.press('Tab');
      const summary = page.locator(':focus');
      await expect(summary).toHaveText(/一起協作/);
      await page.keyboard.press('Enter');
      await expect(nav.locator('details').filter({ has: page.locator('summary', { hasText: '一起協作' }) })).toHaveAttribute('open', '');
      await page.keyboard.press('Tab');
      await expect(nav.getByRole('button', { name: '一起開發', exact: true })).toBeFocused();
      // With every group open the sidebar scrolls on its own and stays pinned while the page scrolls.
      for (const s of await nav.locator('.nav-section > summary').all()) {
        if (!await s.evaluate(node => (node.parentElement as HTMLDetailsElement).open)) await s.click();
      }
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      expect(await page.locator('.sidebar').evaluate(node => node.getBoundingClientRect().top)).toBeLessThanOrEqual(16);
      const last = nav.getByRole('button', { name: '自由工坊社群', exact: true });
      await last.scrollIntoViewIfNeeded();
      await expect(last).toBeInViewport();
      await last.click();
      await expect(page.getByRole('heading', { name: '自由工坊社群', level: 1, exact: true })).toBeVisible();
      await expect(last).toHaveAttribute('aria-current', 'page');
      await expect(page.locator('#main-content')).toBeFocused();
    }
    await noHorizontalOverflow(page, `${viewport.name} community`);
    await page.screenshot({ path: `test-results/audit-shell-workspace-${viewport.name}.png` });
    // Signing out returns to the sign-in form, not an empty page.
    await page.locator('.topbar').getByRole('button', { name: '登出', exact: true }).click();
    await expect(page.getByRole('heading', { name: '登入', exact: true })).toBeVisible();
    await expect(page.getByLabel('電子郵件', { exact: true })).toBeVisible();
  });
}
