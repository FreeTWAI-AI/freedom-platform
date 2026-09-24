import { mkdirSync } from 'node:fs';
import { navigate } from './navigation.js';
import { test, expect, type Page } from './fixtures.js';

// Screenshots are audit evidence only; they never replace the assertions below.
const evidence = process.env.AUDIT_EVIDENCE_DIR ?? 'test-results/audit-operations';
mkdirSync(evidence, { recursive: true });

async function login(page: Page, email = 'maker@local.test') {
  await page.goto('/');
  await page.getByLabel('電子郵件', { exact: true }).fill(email);
  await page.getByLabel('密碼', { exact: true }).fill('freedom-local-demo');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.getByRole('button', { name: '登出', exact: true })).toBeVisible();
}
async function switchTo(page: Page, email: string) {
  await page.getByRole('button', { name: '登出', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登入', exact: true })).toBeVisible();
  await login(page, email);
}
async function settled(page: Page) {
  await expect(page.locator('main').getByText(/^(載入|正在載入)/)).toHaveCount(0, { timeout: 15000 });
}
async function layoutProblems(page: Page) {
  return page.evaluate(() => {
    const width = window.innerWidth;
    const offenders = [...document.querySelectorAll<HTMLElement>('main *')].filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > width + 1 || r.left < -1); }).map(el => el.tagName);
    const unlabeled = [...document.querySelectorAll<HTMLInputElement>('main input,main select,main textarea')].filter(el => el.type !== 'hidden' && !el.labels?.length && !el.getAttribute('aria-label')).map(el => el.outerHTML.slice(0, 80));
    return { overflow: document.documentElement.scrollWidth > width, offenders, unlabeled, h1: document.querySelectorAll('h1').length };
  });
}
const guildCaps = { managed_guilds: [{ guild_key: 'synthetic-guild', name: '測試公會' }], managed_books: [{ book_id: 'video-autopilot', title: '測試剪輯技能' }], can_discuss: true };
const viewports = [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]] as const;
const memberPages: [string, string][] = [['supplier', '供貨中心'], ['retail', '開店與銷售'], ['marketing', '行銷工作室'], ['workbench', '我的工作'], ['showcase', '作品與需求'], ['engagement', '合作紀錄'], ['guild-workspace', '公會管理']];

test('supplier reply needs an explicit choice and manual-quantity products do not ask for stock', async ({ page }) => {
  await login(page);
  await navigate(page, '供貨中心');
  await expect(page.getByText('尚未開放買家結帳，平台不代收款', { exact: false })).toBeVisible();
  await page.getByRole('combobox', { name: /^供貨方式/ }).selectOption('manual_confirmation');
  await expect(page.getByLabel('可供數量（有明確庫存時必填）', { exact: true })).toHaveCount(0);
  await expect(page.getByText('接單前確認數量：銷售者會看到「數量須與供貨商確認」。', { exact: true })).toBeVisible();
  const title = '稽核・手工皂禮盒';
  await page.getByLabel('商品名稱', { exact: true }).fill(title);
  await page.getByLabel('商品規格與介紹', { exact: true }).fill('合成範例：三入手工皂，供稽核演練。');
  await page.getByLabel('供貨價（新台幣）', { exact: true }).fill('180');
  await page.getByLabel('出貨方式與條件', { exact: true }).fill('演練：確認數量後出貨');
  await page.getByLabel('退換貨條件', { exact: true }).fill('演練：瑕疵先聯絡供貨商');
  await page.getByRole('button', { name: '保存商品與供貨條件', exact: true }).click();
  await expect(page.getByRole('article').filter({ hasText: title }).getByText('數量須與供貨商確認', { exact: true })).toBeVisible();

  await switchTo(page, 'reviewer@local.test');
  await navigate(page, '開店與銷售');
  await settled(page);
  // A seller who already has a store keeps the create form one click away instead of at the top.
  const hadStore = await page.getByText('內部預覽 · 尚未開放結帳').count() > 0;
  if (!hadStore) {
    await page.getByLabel('商店名稱', { exact: true }).fill('稽核選物店');
    await page.getByLabel('商店介紹', { exact: true }).fill('合成資料的稽核商店。');
    await page.getByLabel('客服聯絡方式', { exact: true }).fill('演練聯絡');
    await page.getByRole('button', { name: '建立預覽商店', exact: true }).click();
  }
  await expect(page.getByText('再建立一家商店', { exact: true })).toBeVisible();
  await expect(page.getByLabel('商店名稱', { exact: true })).toBeHidden();
  await page.getByRole('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).getByRole('button', { name: '選這件商品', exact: true }).click();
  await page.getByLabel(/預計售價/).fill('320');
  await page.getByLabel('對買家的銷售說明', { exact: true }).fill('稽核演練選品。');
  await page.getByRole('button', { name: '保存選品草稿', exact: true }).click();
  const listing = page.getByRole('region', { name: '我的選品與供貨狀態', exact: true }).getByRole('article').filter({ hasText: title });
  await listing.getByRole('button', { name: '送出供貨確認（內部演練）', exact: true }).click();
  await expect(listing.getByText('待供貨商回覆', { exact: true })).toBeVisible();

  await switchTo(page, 'maker@local.test');
  await navigate(page, '供貨中心');
  const request = page.getByRole('region', { name: '銷售者的供貨請求', exact: true }).getByRole('article').filter({ hasText: title });
  await expect(request.getByRole('combobox', { name: /^回覆/ })).toHaveValue('');
  await request.getByLabel('給銷售者的說明', { exact: true }).fill('先確認數量');
  await request.getByLabel('我已核對以上商品、售價與條件；這是內部演練回覆。', { exact: true }).check();
  const writes: string[] = [];
  page.on('request', r => { if (r.method() === 'POST' && r.url().includes(':decide')) writes.push(r.url()); });
  await request.getByRole('button', { name: '保存供貨回覆', exact: true }).click();
  expect(await request.getByRole('combobox', { name: /^回覆/ }).evaluate(el => (el as HTMLSelectElement).validity.valueMissing)).toBe(true);
  expect(writes).toEqual([]);
  // Keyboard-only choice and submit.
  await request.getByRole('combobox', { name: /^回覆/ }).focus();
  await request.getByRole('combobox', { name: /^回覆/ }).selectOption('declined');
  await request.getByLabel('給銷售者的說明', { exact: true }).press('Tab');
  await request.getByRole('button', { name: '保存供貨回覆', exact: true }).press('Enter');
  await expect(request.getByText('供貨商暫不接受', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '結帳', exact: true })).toHaveCount(0);
});

test('marketing puts drafting first and hides empty source groups', async ({ page }) => {
  await login(page, 'reviewer@local.test');
  await navigate(page, '行銷工作室');
  await settled(page);
  const source = page.getByLabel('內容來源', { exact: true });
  const groups = await source.locator('optgroup').evaluateAll(els => els.map(el => ({ label: el.getAttribute('label'), options: el.children.length })));
  expect(groups.every(group => group.options > 0)).toBe(true);
  if (!groups.length) await expect(page.getByText('登錄開源作品或供貨商品後，可直接引用固定版本作為來源。', { exact: true })).toBeVisible();
  const order = await page.evaluate(() => {
    const form = document.querySelector('main form')!, library = [...document.querySelectorAll('main details summary')].find(el => el.textContent === '行銷與影音公會的技能書')!;
    return form.compareDocumentPosition(library) & Node.DOCUMENT_POSITION_FOLLOWING;
  });
  expect(order).toBeTruthy();
});

test('cooperation cards say who acts next and link between showcase and records', async ({ page }) => {
  // client shares, reviewer asks; neither overlaps the maker/client journey in journeys.spec.
  const title = '稽核・合作提示範例';
  await login(page, 'client@local.test');
  await navigate(page, '作品與需求');
  await expect(page.getByText('填成果代號即可，檔案另行分享；不要貼含登入權限的連結或私人資料。', { exact: true })).toBeVisible();
  await page.getByLabel('作品標題', { exact: true }).fill(title);
  await page.getByLabel('說明', { exact: true }).fill('合成資料的稽核作品。');
  await page.getByLabel('我同意以社群可見方式分享這件作品').check();
  await page.getByRole('button', { name: '發布作品', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();

  await switchTo(page, 'reviewer@local.test');
  await navigate(page, '合作紀錄');
  await settled(page);
  if (await page.getByText('還沒有合作紀錄', { exact: true }).count()) {
    await page.getByRole('link', { name: '作品與需求', exact: true }).click();
    await expect(page.getByRole('heading', { name: '作品與需求', level: 1, exact: true })).toBeVisible();
  } else await navigate(page, '作品與需求');
  const showcase = page.getByRole('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).first();
  await showcase.getByRole('button', { name: '提出商機', exact: true }).click();
  await showcase.getByLabel('你的需求', { exact: true }).fill('稽核需求：調整一個欄位');
  await showcase.getByRole('button', { name: '送出商機', exact: true }).click();
  const opportunity = page.getByRole('article').filter({ hasText: '稽核需求：調整一個欄位' });
  await expect(opportunity.getByText('已送出需求，等待作品作者提出合作範圍與價格。', { exact: true })).toBeVisible();

  await switchTo(page, 'client@local.test');
  await navigate(page, '作品與需求');
  const mine = page.getByRole('article').filter({ hasText: '稽核需求：調整一個欄位' });
  await mine.getByRole('button', { name: '提出合作', exact: true }).click();
  await mine.getByLabel('合作範圍', { exact: true }).fill('稽核合作範圍');
  await mine.getByLabel('完成條件', { exact: true }).fill('稽核完成條件');
  await mine.getByLabel('約定價格（新台幣，最多兩位小數）').fill('500');
  await mine.getByRole('button', { name: '送出合作提案', exact: true }).click();
  await mine.getByRole('link', { name: '合作紀錄', exact: true }).click();
  await expect(page.getByRole('heading', { name: '合作紀錄', level: 1, exact: true })).toBeVisible();
  const providerCard = page.getByRole('article').filter({ hasText: '稽核合作範圍' });
  await expect(providerCard.getByText('等待委託人同意這份合作；對方同意前不需要開始交付。', { exact: true })).toBeVisible();
  await expect(providerCard.getByText(/500\.00（非已收款）/)).toBeVisible();

  await switchTo(page, 'reviewer@local.test');
  await navigate(page, '合作紀錄');
  const clientCard = page.getByRole('article').filter({ hasText: '稽核合作範圍' });
  await clientCard.getByRole('button', { name: '同意這份合作', exact: true }).click();
  await expect(clientCard.getByText('等待提供者交付成果。', { exact: true })).toBeVisible();

  await switchTo(page, 'client@local.test');
  await navigate(page, '合作紀錄');
  const delivering = page.getByRole('article').filter({ hasText: '稽核合作範圍' });
  await delivering.getByRole('button', { name: '標記已交付', exact: true }).click();
  await expect(delivering.getByText('已交付，等待委託人接受。', { exact: true })).toBeVisible();
});

test('guild workspace explains missing authority and shows API errors as alerts', async ({ page }) => {
  await page.route('**/api/v1/guild-workspace', route => route.fulfill({ json: { managed_guilds: [], managed_books: [], can_discuss: false } }));
  await login(page);
  await page.goto('/#guild-workspace');
  await expect(page.getByText('目前沒有公會或技能書的管理職務', { exact: true })).toBeVisible();
  await expect(page.getByText(/由平台管理員任命/)).toBeVisible();
  await page.unroute('**/api/v1/guild-workspace');
  await page.route('**/api/v1/guild-workspace', route => route.fulfill({ status: 403, json: { detail: '沒有公會管理權限。' } }));
  await page.reload();
  const alert = page.locator('.guild-workspace').getByRole('alert');
  await expect(alert).toContainText('沒有公會管理權限');
  await expect(alert).toHaveClass(/banner-error/);
  await page.unroute('**/api/v1/guild-workspace');
  await page.route('**/api/v1/guild-workspace', route => route.fulfill({ json: guildCaps }));
  await page.route('**/api/v1/guilds/synthetic-guild/announcements', route => route.fulfill({ json: { items: [] } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  const tabs = page.getByRole('navigation', { name: '公會管理功能' }).getByRole('button');
  await expect(tabs).toHaveCount(3);
  const heights = await tabs.evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().height)));
  expect(Math.max(...heights)).toBeLessThan(60);
  await tabs.nth(2).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: '公會長議事區', exact: true })).toBeVisible();
});

test('every operations page fits desktop and phone with one h1 and labelled fields', async ({ page }) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/v1/guild-workspace', route => route.fulfill({ json: guildCaps }));
  await page.route('**/api/v1/guilds/synthetic-guild/announcements', route => route.fulfill({ json: { items: [] } }));
  for (const [viewport, size] of viewports) {
    await page.setViewportSize(size);
    await login(page);
    for (const [id, label] of memberPages) {
      await navigate(page, label);
      await expect(page.getByRole('heading', { name: label, level: 1, exact: true })).toBeVisible();
      await settled(page);
      expect(await layoutProblems(page), `${id} ${viewport}`).toEqual({ overflow: false, offenders: [], unlabeled: [], h1: 1 });
      await page.screenshot({ path: `${evidence}/after-${id}-${viewport}.png`, fullPage: true });
    }
    await page.getByRole('button', { name: '登出', exact: true }).click();
    await expect(page.getByRole('heading', { name: '登入', exact: true })).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('admin console fits phone and desktop and never shows an invalid audit time', async ({ page }) => {
  await page.route('**/admin/api/**', route => {
    const path = new URL(route.request().url()).pathname.replace('/admin/api', '');
    if (path === '/bootstrap') return route.fulfill({ json: { admin: { admin_id: 'synthetic-admin', display_name: '稽核管理員', email: 'admin@example.test', role: 'super_admin', community_id: 'synthetic' }, csrf_token: 'synthetic-csrf', summary: { members: 1, active_members: 1, pending_guild_applications: 0, guilds: 1, admins: 1 }, available_skill_books: [], pending_guild_appointments: [] } });
    if (path === '/members') return route.fulfill({ json: { items: [{ user_id: 'synthetic-member', display_name: '很長名字的稽核會員範例', email: 'a-very-long-synthetic-email-address@example.test', active: true, onboarding_required: false, onboarding_completed_at: '2026-09-23T00:00:00Z', aggregate_version: 1, guilds: [], platform_admin: null }], next_offset: null } });
    if (path === '/guilds') return route.fulfill({ json: { items: [{ guild_key: 'synthetic-guild', name: '測試公會', purpose: '合成公會', guild_master: null, officer_version: 1, guild_experts: [] }] } });
    if (path === '/audit') return route.fulfill({ json: { items: [{ audit_id: 'a1', admin_name: '稽核管理員', action: 'member_status', reason: '合成紀錄', target_type: 'member', target_ref: 'synthetic-member' }] } });
    if (path === '/skill-maintainers') return route.fulfill({ json: { items: [] } });
    if (path === '/guild-council/threads') return route.fulfill({ json: { items: [] } });
    return route.fulfill({ json: { items: [] } });
  });
  for (const [viewport, size] of viewports) {
    await page.setViewportSize(size);
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: '會員管理', exact: true })).toBeVisible();
    for (const [tab, heading] of [['會員管理', '會員管理'], ['公會管理', '公會管理'], ['會長與維護者', '技能書維護者'], ['操作紀錄', '操作紀錄']]) {
      await page.getByRole('button', { name: tab, exact: true }).click();
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${tab} ${viewport}`).toBe(true);
      await page.screenshot({ path: `${evidence}/after-admin-${tab}-${viewport}.png`, fullPage: true });
    }
    await expect(page.getByText('時間未記錄', { exact: true })).toBeVisible();
    await expect(page.getByText('Invalid Date')).toHaveCount(0);
  }
});
