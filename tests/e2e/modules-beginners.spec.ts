import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';

async function login(page: Page, email = 'maker@local.test') {
  await page.goto('/');
  await page.getByLabel('電子郵件', { exact: true }).fill(email);
  await page.getByLabel('密碼', { exact: true }).fill('freedom-local-demo');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.getByRole('button', { name: '登出', exact: true })).toBeVisible();
}

async function command(page: Page, path: string, data: unknown) {
  const session = await (await page.request.get('/api/v1/session')).json();
  const response = await page.request.post(`/api/v1${path}`, {
    headers: { Origin: 'http://127.0.0.1:4311', 'X-CSRF-Token': session.csrf_token, 'Idempotency-Key': randomUUID() },
    data,
  });
  expect(response.ok(), `Create isolated test fixture: ${path}`).toBe(true);
  return response.json();
}

test('task discovery combines real labels and assignment, remembers filters, and keeps briefs usable', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  // Add a second synthetic display record to the real, authenticated fixture response.
  // The original Issue and its brief still use the dedicated test server routes.
  await page.route('**/api/v1/co-creation/projects/*/activity', async route => {
    const response = await route.fetch(), activity = await response.json();
    await route.fulfill({ response, json: { ...activity, issues: [...activity.issues, {
      number: 92, title: '整理新手操作文件', body: '補上安裝步驟與使用範例。',
      url: 'https://github.com/FreeTWAI-AI/video-autopilot-kit/issues/92', labels: ['documentation'], assignees: ['documentation-helper'],
    }] } });
  });
  await login(page);
  await page.getByRole('button', { name: '一起開發', exact: true }).click();
  const issues = page.locator('.expedition-issue');
  await expect(issues).toHaveCount(2);
  await page.getByRole('combobox', { name: '任務標籤', exact: true }).selectOption('documentation');
  await page.getByRole('combobox', { name: '任務負責人', exact: true }).selectOption('assigned');
  await page.getByLabel('搜尋任務', { exact: true }).fill('安裝步驟');
  await expect(issues).toHaveCount(1);
  await expect(issues).toContainText('整理新手操作文件');
  await expect(issues.getByRole('link', { name: '到任務頁參與 ↗', exact: true })).toHaveAttribute('href', /issues\/92$/);
  await page.reload();
  await expect(page.getByLabel('搜尋任務', { exact: true })).toHaveValue('安裝步驟');
  await expect(page.getByRole('combobox', { name: '任務標籤', exact: true })).toHaveValue('documentation');
  await expect(page.getByRole('combobox', { name: '任務負責人', exact: true })).toHaveValue('assigned');
  await expect(issues).toHaveCount(1);
  await page.getByRole('combobox', { name: '任務負責人', exact: true }).selectOption('unassigned');
  await expect(page.getByRole('heading', { name: '沒有符合條件的任務', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '已合併的貢獻', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '查看未指派任務', exact: true }).click();
  await expect(page.getByLabel('搜尋任務', { exact: true })).toBeFocused();
  await expect(page.getByRole('combobox', { name: '任務標籤', exact: true })).toHaveValue('');
  await expect(issues).toHaveCount(1);
  await expect(issues).toContainText('建立可重現的剪輯測試素材');
  await expect(issues).toContainText('尚未指派負責人；請先到任務頁留言協調。');
  await issues.getByRole('button', { name: '複製工作說明', exact: true }).click();
  await expect(page.getByLabel('給協作夥伴與 AI 的工作說明', { exact: true })).toHaveValue(/建立可重現的剪輯測試素材/);
  await page.getByRole('button', { name: '清除任務篩選', exact: true }).click();
  await expect(issues).toHaveCount(2);
  await page.setViewportSize({ width: 320, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('product discovery distinguishes self-reported stock and leads to a real selection draft', async ({ page }) => {
  const prefix = `找商品 ${Date.now()}`;
  await login(page);
  for (const item of [
    { suffix: '有庫存茶杯', availability: 'finite', stock: 3 },
    { suffix: '零庫存茶杯', availability: 'finite', stock: 0 },
    { suffix: '訂製茶杯', availability: 'manual_confirmation', stock: null },
  ]) await command(page, '/supplier/products', {
    title: `${prefix} ${item.suffix}`, photo_url: null, specifications: '合成測試商品，陶瓷 200ml。',
    net_price_minor: 20000, currency: 'TWD', availability: item.availability, stock: item.stock,
    shipping_terms: '演練出貨方式', return_terms: '演練退換貨方式',
  });
  await page.getByRole('button', { name: '登出', exact: true }).click();
  await login(page, 'client@local.test');
  const store = await command(page, '/retail/stores', { name: `${prefix} 選物店`, description: '合成選品測試', support_contact: '請聯絡測試店主' });
  await page.getByRole('button', { name: '開店與銷售', exact: true }).click();
  const catalog = page.getByRole('region', { name: '挑選供貨商品', exact: true });
  await catalog.getByLabel('搜尋商品', { exact: true }).fill(prefix);
  await expect(catalog.locator('.product-card')).toHaveCount(3);
  await catalog.getByRole('combobox', { name: '篩選供貨方式', exact: true }).selectOption('in_stock');
  await expect(catalog.locator('.product-card')).toHaveCount(1);
  await expect(catalog.locator('.product-card')).toContainText('供貨商自報庫存 3 件');
  await catalog.getByRole('combobox', { name: '篩選供貨方式', exact: true }).selectOption('manual_confirmation');
  await expect(catalog.locator('.product-card')).toHaveCount(1);
  await expect(catalog.locator('.product-card')).toContainText('數量須與供貨商確認');
  await catalog.getByLabel('搜尋商品', { exact: true }).fill('找不到的規格');
  await expect(catalog.getByRole('heading', { name: '沒有符合條件的商品', exact: true })).toBeVisible();
  await catalog.getByRole('button', { name: '清除商品篩選', exact: true }).click();
  await expect(catalog.getByRole('combobox', { name: '篩選供貨方式', exact: true })).toHaveValue('all');
  await catalog.getByLabel('搜尋商品', { exact: true }).fill(`${prefix} 有庫存茶杯`);
  await catalog.getByRole('button', { name: '選這件商品', exact: true }).click();
  const selection = page.getByRole('form', { name: `準備選品：${prefix} 有庫存茶杯`, exact: true });
  await expect(selection).toBeFocused();
  await selection.getByRole('combobox', { name: '放入商店', exact: true }).selectOption(store.store_id);
  await selection.getByLabel('預計售價（新台幣）', { exact: true }).fill('300.00');
  await selection.getByLabel('對買家的銷售說明', { exact: true }).fill('合成商品選品演練。');
  await selection.getByRole('button', { name: '保存選品草稿', exact: true }).click();
  const listing = page.getByRole('region', { name: '我的選品與供貨狀態', exact: true }).getByRole('article').filter({ has: page.getByRole('heading', { name: `${prefix} 有庫存茶杯`, exact: true }) });
  await expect(listing.getByText('選品草稿',{exact:true})).toBeVisible();
  await listing.getByRole('button', { name: '送出供貨確認（內部演練）', exact: true }).click();
  await expect(listing.getByText('待供貨商回覆',{exact:true})).toBeVisible();
  await listing.getByRole('button',{name:'重新選品',exact:true}).click();
  await expect(catalog.getByLabel('搜尋商品',{exact:true})).toBeFocused();
  await expect(catalog.getByLabel('搜尋商品',{exact:true})).toHaveValue(`${prefix} 有庫存茶杯`);
  await expect(catalog.locator('.product-card')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '結帳', exact: true })).toHaveCount(0);
  await expect(page.getByText('目前可保存商品、選品與供貨回覆。供貨確認僅供內部演練，商品待品質確認；尚未開放買家結帳，平台不代收款。')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Fork 我的商店 ↗', exact: true })).toBeHidden();
  await page.getByText('進階：建立自己的商店網站', { exact: true }).click();
  await expect(page.getByText('Fork 是把專案複製到自己的 GitHub。依專案說明啟動後，到「我的名片」輸入一次性代碼，核准讀取連線。')).toBeVisible();
  await page.setViewportSize({ width: 320, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('squad search recovers after failure and preserves pending membership until the owner accepts', async ({ page }) => {
  const prefix = `找小隊 ${Date.now()}`;
  await login(page);
  const project = await command(page, '/squads', { name: `${prefix} 工具共創`, kind: 'project', purpose: '一起整理新手文件。' });
  await command(page, '/squads', { name: `${prefix} 每週練習`, kind: 'mutual_help', purpose: '每週交流一次練習心得。' });
  await page.getByRole('button', { name: '登出', exact: true }).click();
  await login(page, 'reviewer@local.test');
  let failList = true;
  await page.route('**/api/v1/squads?*', route => failList ? route.abort() : route.continue());
  await page.getByRole('button', { name: '小隊集合', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('無法連線');
  await expect(page.getByRole('heading', { name: '還沒有小隊', exact: true })).toHaveCount(0);
  failList = false;
  await page.getByRole('button', { name: '重新載入小隊', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByLabel('搜尋小隊', { exact: true }).fill(prefix);
  await expect(page.locator('.expedition-squad')).toHaveCount(2);
  await page.getByRole('combobox', { name: '篩選小隊類型', exact: true }).selectOption('mutual_help');
  await expect(page.locator('.expedition-squad')).toHaveCount(1);
  await expect(page.locator('.expedition-squad')).toContainText('每週練習');
  await page.getByRole('combobox', { name: '篩選小隊類型', exact: true }).selectOption('project');
  await expect(page.locator('.expedition-squad')).toContainText('工具共創');
  await expect(page.getByText('申請加入後，需由隊主接受。接受前，看不到只分享給小隊夥伴的聯絡方式。')).toBeVisible();
  await page.locator('.expedition-squad').getByRole('button', { name: '申請加入', exact: true }).click();
  await expect(page.locator('.expedition-squad')).toContainText('等候隊主接受');
  const detail = await (await page.request.get(`/api/v1/squads/${project.squad_id}`)).json();
  const session = await (await page.request.get('/api/v1/session')).json();
  expect(detail.members.find((member: { user_id: string }) => member.user_id === session.user.user_id)?.state).toBe('pending');
  await page.getByLabel('搜尋小隊', { exact: true }).fill('沒有這個小隊');
  await expect(page.getByRole('heading', { name: '沒有符合條件的小隊', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '清除小隊篩選', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '篩選小隊類型', exact: true })).toHaveValue('all');
  await page.getByRole('button', { name: '成立一支小隊', exact: true }).click();
  await expect(page.getByLabel('小隊名稱', { exact: true })).toBeFocused();
  await page.setViewportSize({ width: 320, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
