import { test, expect, type Page } from './fixtures.js';

async function fits(page: Page, label: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), label).toBe(true);
}

// Real demo routes + real local assets. No screenshot snapshots of actual members.
test('logo stays whole and RPG modules remain navigable across desktop and narrow phones', async ({ page }) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  const logo = page.locator('.login-story .brand-poster img');
  await expect(logo).toBeVisible();
  expect(await logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0 && getComputedStyle(img).objectFit === 'contain')).toBe(true);
  await page.screenshot({ path: 'test-results/design-login-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 320, height: 740 });
  await fits(page, '320px login');
  await page.screenshot({ path: 'test-results/design-login-phone.png', fullPage: true });
  await page.getByLabel('電子郵件', { exact: true }).fill('maker@local.test');
  await page.getByLabel('密碼', { exact: true }).fill('freedom-local-demo');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.getByRole('heading', { name: '會員首頁', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  for(const cover of await page.locator('.home-module-cover').all()){
    const box=await cover.boundingBox();expect(box!.width).toBeLessThanOrEqual(112);expect(box!.height).toBeLessThanOrEqual(112);
  }
  await page.screenshot({ path: 'test-results/design-home-desktop.png', fullPage: true });
  const destinations = [
    ['會員首頁', '會員首頁'], ['我的定位', '我的定位'], ['職業公會', '職業公會'], ['小隊集合', '小隊集合'],
    ['供貨中心', '供貨中心'], ['開店與銷售', '開店與銷售'], ['開源作品', '開源作品'], ['一起開發', '一起開發'],
    ['行銷工作室', '行銷工作室'], ['我的工作', '工作台'], ['一般作品與需求', '一般作品與需求'], ['合作紀錄', '合作紀錄'], ['自由工坊社群', '自由工坊社群'],
  ];
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const [button, heading] of destinations) {
      await page.getByRole('navigation', { name: '主要工作區' }).getByRole('button', { name: button, exact: true }).click();
      await expect(page.getByRole('heading', { name: heading, level: 1, exact: true })).toBeVisible();
      await expect(page.locator('.development-context')).toBeVisible();
      await expect(page.getByRole('status').filter({ hasText: /載入|讀取/ })).toHaveCount(0);
      await expect(page.getByRole('alert')).toHaveCount(0);
      if(button==='會員首頁'){
        await expect(page.locator('.home-module-card')).toHaveCount(4);
        for(const card of await page.locator('.home-module-card').all()){
          const cover=card.locator('.home-module-cover'),box=await cover.boundingBox();
          expect(box!.height,'Module artwork should not dominate the phone').toBeLessThanOrEqual(96);
          expect(box!.width).toBeLessThanOrEqual(96);
          expect((await card.boundingBox())!.height).toBeLessThan(220);
        }
      }
      for(const banner of await page.locator('.expedition-banner-illustrated').all()){
        const art=await banner.locator('.expedition-banner-art').boundingBox();
        expect(art!.width,'Module decoration stays beside the content on phones').toBeLessThanOrEqual(140);
      }
      if (width === 390 && button === '職業公會') await page.screenshot({ path: 'test-results/design-guild-phone.png' });
      if(width===390&&['我的定位','小隊集合','供貨中心','一起開發'].includes(button))await page.screenshot({path:`test-results/compact-module-${destinations.findIndex(item=>item[0]===button)}-phone.png`});
      await fits(page, `${width}px ${heading}`);
    }
  }
  await page.getByRole('button', { name: '會員首頁', exact: true }).click();
  await page.screenshot({ path: 'test-results/design-home-phone.png', fullPage: true });
  await page.screenshot({ path: 'test-results/design-home-phone-viewport.png' });
  for (const file of ['workshop-hub', 'skill-codex', 'cooperation-forge', 'market-network']) {
    const response = await page.request.get(`/art/rpg/${file}.webp`);
    expect(response.status()).toBe(200);expect(response.headers()['content-type']).toContain('image/webp');
  }
  await expect.poll(async () => page.locator('img[src^="/art/rpg/"]').evaluateAll(images => images.every(img => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0))).toBe(true);
  expect(errors).toEqual([]);
});
