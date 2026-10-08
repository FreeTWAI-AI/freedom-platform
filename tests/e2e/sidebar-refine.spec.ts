import { test, expect, type Page } from './fixtures.js';
import {openFeatureSearch} from './navigation.js';

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

// Primary actions stay visible; secondary groups and search open from More.
for (const width of [1280, 390]) {
  for (const theme of ['light', 'versefolk']) {
    test(`navigation is quiet and still touch-sized at ${width}px in ${theme} theme`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await login(page);
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      const menu = page.getByRole('button', { name: '開啟選單', exact: true });
      if (await menu.isVisible()) await menu.click();
      const nav = page.getByRole('navigation', { name: '主要工作區' });
      await expect(nav).toBeVisible();
      await openFeatureSearch(page);

      const active = nav.locator('.nav-item.is-active');
      await expect(active).toHaveCount(1);
      const style = (selector: string, prop: string) => nav.locator(selector).first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);

      // Active state: heavier text and no left bar. Inactive items stay medium weight.
      expect(await active.evaluate(el => getComputedStyle(el).fontWeight)).toBe('700');
      expect(await active.evaluate(el => getComputedStyle(el).boxShadow)).toBe('none');
      expect(await style('.nav-item:not(.is-active)', 'font-weight')).toBe('500');

      // More stays quiet; nested groups use a thin divider inside its menu.
      expect(await style('.nav-more', 'border-top-width')).toBe('0px');
      expect(await style('.nav-more-content .nav-section', 'border-top-width')).toBe('1px');
      expect(await style('.nav-search input', 'background-image')).toContain('data:image/svg+xml');

      // The search icon takes room on the left; the placeholder must still fit unclipped.
      const fit = await nav.locator('.nav-search input').evaluate(el => {
        const css = getComputedStyle(el), hint = getComputedStyle(el, '::placeholder'), ctx = document.createElement('canvas').getContext('2d')!;
        ctx.font = `${css.fontWeight} ${hint.fontSize} ${css.fontFamily}`;
        ctx.letterSpacing = css.letterSpacing === 'normal' ? '0px' : css.letterSpacing;
        const room = el.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
        return { text: ctx.measureText((el as HTMLInputElement).placeholder).width, room };
      });
      expect(fit.text, `${theme} ${width}px placeholder width`).toBeLessThanOrEqual(fit.room);

      // Every visible target is at least 44px tall.
      for (const selector of ['.nav-item', '.nav-more > summary', '.nav-section > summary', '.nav-search input']) {
        for (const box of await nav.locator(selector).evaluateAll(els => els.filter(el => (el as HTMLElement).offsetParent).map(el => el.getBoundingClientRect().height))) {
          expect(box, `${theme} ${width}px ${selector} height`).toBeGreaterThanOrEqual(44);
        }
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }
}
