import { test, expect } from './fixtures.js';

// text-autospace is new in browsers; this only covers Chromium, the engine Playwright runs here.
test('Chinese text touching Latin letters or digits gets a thin gap site-wide, and other text is unchanged', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('電子郵件', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.body).textAutospace)).toBe('normal');
  const widths = await page.evaluate(() => {
    const samples = { guild: '加入AI 開發公會', count: '已滿3位，請先移除一位', chinese: '到技能書架選一本技能書閱讀，開始練習。', spaced: '讓 AI 整理商品' };
    return Object.fromEntries(Object.entries(samples).map(([key, text]) => {
      const span = document.createElement('span');
      span.textContent = text; span.style.cssText = 'position:absolute;white-space:nowrap;font-size:18px';
      document.body.appendChild(span);
      const withGap = span.getBoundingClientRect().width;
      span.style.textAutospace = 'no-autospace';
      const without = span.getBoundingClientRect().width;
      span.remove();
      return [key, { withGap, without }];
    }));
  }) as Record<string, { withGap: number; without: number }>;
  // 18px text gets about 2px per boundary; a loose lower bound keeps this independent of the installed font.
  expect(widths.guild.withGap - widths.guild.without, 'CJK before Latin').toBeGreaterThan(1);
  expect(widths.count.withGap - widths.count.without, 'CJK before digit and digit before CJK').toBeGreaterThan(1);
  expect(widths.chinese.withGap, 'pure Chinese is unchanged').toBeCloseTo(widths.chinese.without, 1);
  expect(widths.spaced.withGap, 'already-spaced text is unchanged').toBeCloseTo(widths.spaced.without, 1);
});
