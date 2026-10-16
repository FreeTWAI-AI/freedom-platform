import {randomUUID} from 'node:crypto';
import type {Route} from '@playwright/test';
import {test, expect, type Page} from './fixtures.js';
import {person, login, launchStore, open, post, storeArea} from './hosted-store-fixture.js';
import {buyerLogin, offListener} from './hosted-order-fixture.js';
import {signOut} from './navigation.js';
import {ReservationSettingSchema} from '../../contracts/guild-launchpad/v1/hosted-shared-order.js';
import {DEMO_PASSWORD} from '../../packages/testing/seed.js';

const workspace = (page: Page, name: string) => page.getByRole('navigation', {name: '供貨工作區', exact: true}).getByRole('button', {name, exact: true});
const supplySurface = (page: Page) => page.locator('.hosted-supply-catalog');
function settingTuple(route: Route) {
  const request = route.request();
  return {body: request.postData(), key: request.headers()['idempotency-key'], version: request.headers()['if-match']};
}
async function readSetting(page: Page, root: string) {
  const response = await page.request.get('/api/v1' + root + '/reservation-setting');
  expect(response.status()).toBe(200);
  return ReservationSettingSchema.parse(await response.json());
}
async function patchSetting(page: Page, root: string, enabled: boolean, version: string) {
  const session = await (await page.request.get('/api/v1/session')).json();
  const response = await page.request.patch('/api/v1' + root + '/reservation-setting', {data: {reservation_enabled: enabled}, headers: {
    Origin: new URL(page.url()).origin, 'X-CSRF-Token': session.csrf_token,
    'Idempotency-Key': randomUUID(), 'If-Match': `"${version}"`,
  }});
  expect(response.status()).toBe(200);
  return ReservationSettingSchema.parse(await response.json());
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {resolve = done;});
  return {promise, resolve};
}

async function readyCatalog(page: Parameters<typeof login>[0], db: Parameters<typeof person>[0]) {
  const member = await person(db); await login(page, member.email);
  const store = await launchStore(page, '預留設定測試空間');
  await post(page, store.root + '/supply-profile', {name: '供貨預留商品庫', currency: 'TWD'}, 201);
  return store;
}

test('supply reservation controls require a successful owner read and recover from read failure', async ({page, e2eAuthPool}) => {
  const store = await readyCatalog(page, e2eAuthPool);
  let status = 503;
  await page.route('**/api/v1' + store.root + '/reservation-setting', route => status === 200 ? route.continue()
    : route.fulfill({status, contentType: 'application/problem+json', json: {title: '目前無法讀取預留設定', status, code: status === 403 ? 'seller_owner_required' : 'unavailable'}}));
  await open(page, store.hash + '/supply');
  await expect(page.locator('.hosted-supply-catalog').getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', {name: '開放 30 分鐘預留', exact: true})).toHaveCount(0);
  status = 403;
  await page.getByRole('button', {name: '重新載入', exact: true}).click();
  await workspace(page, '預留與訂單').click();
  await expect(page.locator('.hosted-supply-catalog')).toContainText('只有目前業務空間擁有者');
  await expect(page.getByRole('button', {name: '開放 30 分鐘預留', exact: true})).toHaveCount(0);
  await workspace(page, '商品').click();
  await page.getByRole('button', {name: '新增供貨商品', exact: true}).click();
  await expect(page.getByRole('form', {name: '新增供貨商品', exact: true})).toBeVisible();
  status = 200; await page.reload();
  await workspace(page, '預留與訂單').click();
  await expect(page.getByRole('button', {name: '開放 30 分鐘預留', exact: true})).toBeEnabled();
});

for (const action of ['setup', 'create', 'edit'] as const) {
  test(`supply-only ${action} retains the original operation after a committed unreadable response`, async ({page, e2eAuthPool}, info) => {
    let prompts = 0;
    page.on('dialog', async dialog => {prompts++; await dialog.accept();});
    const member = await person(e2eAuthPool); await login(page, member.email);
    const store = await launchStore(page, '私人供貨空間');
    if (action !== 'setup') await post(page, store.root + '/supply-profile', {name: '私人商品庫', currency: 'TWD'}, 201);
    const product = action === 'edit' ? await post(page, store.root + '/supply-products', {title: '供貨茶杯', cost_minor: 15000, stock: 10}, 201) : null;
    const retailReads: string[] = [];
    page.on('request', request => {
      if (new RegExp(store.root + '/(appearance|preview|supply-catalog|distribution-selections)(?:\\?|$)').test(request.url())) retailReads.push(request.url());
    });
    await open(page, store.hash + '/supply');
    await expect(page.locator('.hosted-supply-catalog')).toBeVisible();
    await expect(page.getByRole('heading', {level: 1, name: '我的供貨商品庫', exact: true})).toBeVisible();
    await expect(page.getByLabel('商店網址', {exact: true})).toHaveCount(0);
    await expect(page.getByRole('heading', {name: '預覽與發布', exact: true})).toHaveCount(0);
    if (action === 'create') await page.getByRole('button', {name: '新增供貨商品', exact: true}).click();
    if (action === 'edit') {
      const card = page.getByRole('article').filter({has: page.getByRole('heading', {level: 4, name: '供貨茶杯', exact: true})});
      // The initial cooperation projection inserts a state row above the actions.
      await expect(card.getByText('供貨版本：尚未公開', {exact: true})).toBeVisible();
      await card.getByRole('button', {name: '編輯供貨商品', exact: true}).click();
    }
    const form = page.getByRole('form', {name: action === 'setup' ? '建立供貨商品庫' : action === 'create' ? '新增供貨商品' : '編輯供貨商品', exact: true});
    if (action === 'setup') await form.getByLabel('商品庫名稱', {exact: true}).fill('私人商品庫');
    else {
      await form.getByLabel('商品名稱', {exact: true}).fill('供貨茶杯');
      await form.getByLabel('供貨單價（TWD）', {exact: true}).fill('180');
      await form.getByLabel('庫存', {exact: true}).fill('10');
    }
    const path = store.root + (action === 'setup' ? '/supply-profile' : action === 'create' ? '/supply-products' : '/supply-products/' + product.product_id);
    const tuples: {body: string | null; key: string; version?: string}[] = [];
    await page.route('**/api/v1' + path, async route => {
      if (route.request().method() !== (action === 'edit' ? 'PATCH' : 'POST')) return route.continue();
      const request = route.request(); tuples.push({body: request.postData(), key: request.headers()['idempotency-key'], version: request.headers()['if-match']});
      const response = await route.fetch(); expect(response.status()).toBe(action === 'edit' ? 200 : 201);
      if (tuples.length === 1) await route.fulfill({status: response.status(), contentType: 'application/json', body: '{"incomplete":true}'});
      else await route.fulfill({response});
    });
    await form.getByRole('button', {name: action === 'setup' ? '建立供貨商品庫' : action === 'create' ? '新增供貨商品' : '儲存供貨商品', exact: true}).click();
    await expect(page.locator('.hosted-supply-catalog').getByRole('alert')).toContainText('尚未確認原操作的結果');
    await expect(form.getByLabel(action === 'setup' ? '商品庫名稱' : '商品名稱', {exact: true})).toBeDisabled();
    await page.getByRole('link', {name: '返回我的供貨商品庫', exact: true}).click();
    await expect(page).toHaveURL(new RegExp('#' + store.hash + '/supply$'));
    await page.evaluate(() => {window.location.hash = 'stores/supply';});
    await expect(page).toHaveURL(new RegExp('#' + store.hash + '/supply$'));
    await page.evaluate(hash => {history.replaceState(null, '', '#home'); history.pushState(null, '', '#' + hash + '/supply');}, store.hash);
    await page.goBack();
    await expect(page).toHaveURL(new RegExp('#' + store.hash + '/supply$'));
    expect(prompts).toBe(0);
    expect(tuples).toHaveLength(1);
    if (action !== 'setup') {
      await workspace(page, '供貨合作').click();
      await expect(form).toBeHidden();
      await expect(page.getByRole('button', {name: '更新供貨狀態', exact: true})).toBeDisabled();
      await expect(supplySurface(page).getByRole('alert')).toContainText('尚未確認原操作的結果');
      await workspace(page, '商品').click();
      await expect(form.getByLabel('商品名稱', {exact: true})).toHaveValue('供貨茶杯');
      expect(tuples).toHaveLength(1);
    }
    await page.locator('.hosted-supply-catalog').getByRole('button', {name: '重試', exact: true}).click();
    await expect(page.locator('.hosted-supply-catalog > [role="status"]')).toContainText(action === 'setup' ? '已建立供貨商品庫。' : action === 'create' ? '已新增供貨商品。' : '已儲存供貨商品。');
    expect(tuples).toHaveLength(2); expect(tuples[1]).toEqual(tuples[0]);
    expect(tuples[0].key).toBeTruthy();
    if (action === 'edit') expect(tuples[0].version).toBe(`"${product.version}"`);
    expect(retailReads).toEqual([]);
    const view = await (await page.request.get('/api/v1' + store.root + '/supply-profile')).json();
    expect(view.retail_enabled).toBe(false); expect(view.product_count).toBe(action === 'setup' ? 0 : 1);
    expect((await (await page.request.get('/api/v1/me/stores?pagination=cursor')).json()).items).toEqual([]);
    if (action !== 'setup') {
      const products = await (await page.request.get('/api/v1' + store.root + '/supply-products')).json();
      expect(products.items).toHaveLength(1); expect(products.items[0].cost_minor).toBe(18000);
      if (product) expect(products.items[0].product_id).toBe(product.product_id);
    }
    for (const theme of action === 'create' ? ['light', 'dark', 'versefolk'] : ['light']) {
      await page.evaluate(value => {localStorage.setItem('freedom-theme', value); document.documentElement.dataset.theme = value; document.documentElement.dataset.experienceProfile = value; window.dispatchEvent(new Event('freedom-theme-changed'));}, theme);
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({width, height: 900});
      await page.evaluate(() => window.scrollTo(0, 0));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({path: info.outputPath(`supply-${action}-${theme}-${width}.png`), fullPage: true, animations: 'disabled'});
    }
    }
    await page.getByRole('link', {name: '返回我的供貨商品庫', exact: true}).click();
    await expect(page).toHaveURL(/#stores\/supply$/);
    await expect(page.getByRole('heading', {level: 1, name: '我的供貨商品庫', exact: true})).toBeVisible();
    await expect(page.getByRole('link', {name: '查看商品與供貨', exact: true})).toHaveAttribute('href', '#' + store.hash + '/supply');
  });
}

test('supply-only reservation opt-in keeps its exact tuple and navigation guard until an unknown response is recovered', async ({page, e2eAuthPool}) => {
  const member = await person(e2eAuthPool); await login(page, member.email);
  const store = await launchStore(page, '未知預留設定空間');
  await post(page, store.root + '/supply-profile', {name: '未知預留設定商品庫', currency: 'TWD'}, 201);
  await open(page, store.hash + '/supply');
  const setting = await readSetting(page, store.root);
  expect(setting.reservation_enabled).toBe(false);
  const toggle = page.getByRole('button', {name: '開放 30 分鐘預留', exact: true});
  await workspace(page, '預留與訂單').click();
  await expect(toggle).toBeEnabled();
  await workspace(page, '商品').click();
  await page.getByRole('button', {name: '新增供貨商品', exact: true}).click();
  const draftTitle = page.getByRole('form', {name: '新增供貨商品', exact: true}).getByLabel('商品名稱', {exact: true});
  await draftTitle.fill('尚未儲存的供貨商品');
  await workspace(page, '預留與訂單').click();
  await expect(toggle).toBeDisabled();
  await workspace(page, '商品').click();
  await expect(draftTitle).toHaveValue('尚未儲存的供貨商品');
  await draftTitle.clear();
  await workspace(page, '預留與訂單').click();
  await expect(toggle).toBeEnabled();
  const tuples: ReturnType<typeof settingTuple>[] = [];
  await page.route('**/api/v1' + store.root + '/reservation-setting', async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    tuples.push(settingTuple(route));
    const response = await route.fetch(); expect(response.status()).toBe(200);
    if (tuples.length === 1) await route.fulfill({response, json: {incomplete: true}});
    else if (tuples.length === 2) await route.fulfill({status: 503, contentType: 'application/problem+json', body: JSON.stringify({status: 503, code: 'temporarily_unavailable', title: '暫時無法確認'})});
    else await route.fulfill({response});
  });
  await toggle.click();
  await expect(supplySurface(page).getByRole('alert')).toContainText('尚未確認原操作的結果');
  await expect(toggle).toBeDisabled();
  await workspace(page, '商品').click();
  await expect(page.getByRole('form', {name: '新增供貨商品', exact: true}).getByLabel('商品名稱', {exact: true})).toBeDisabled();
  await workspace(page, '供貨合作').click();
  await expect(page.getByRole('button', {name: '更新供貨狀態', exact: true})).toBeDisabled();
  await workspace(page, '預留與訂單').click();
  await page.getByRole('link', {name: '返回我的供貨商品庫', exact: true}).click();
  await expect(page).toHaveURL(new RegExp('#' + store.hash + '/supply$'));
  await page.evaluate(() => {location.hash = 'home';});
  await expect(page).toHaveURL(new RegExp('#' + store.hash + '/supply$'));
  await page.evaluate(hash => {history.replaceState(null, '', '#home'); history.pushState(null, '', '#' + hash + '/supply');}, store.hash);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp('#' + store.hash + '/supply$'));
  // A full-page close can only warn; this checks the installed warning without closing the test page.
  expect(await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', {cancelable: true})))).toBe(true);
  await page.getByRole('button', {name: '設定', exact: true}).click();
  await page.getByRole('menuitem', {name: '登出', exact: true}).click();
  await expect(page.getByRole('heading', {name: '登入', exact: true})).toHaveCount(0);
  if (await page.getByRole('button', {name: '設定', exact: true}).getAttribute('aria-expanded') === 'true') await page.getByRole('button', {name: '設定', exact: true}).click();
  expect(tuples).toHaveLength(1);
  await supplySurface(page).getByRole('button', {name: '重試', exact: true}).click();
  await expect(supplySurface(page).getByRole('alert')).toContainText('尚未確認原操作的結果');
  await expect(toggle).toBeDisabled();
  await supplySurface(page).getByRole('button', {name: '重試', exact: true}).click();
  await expect(page.getByRole('button', {name: '停止接受新預留', exact: true})).toBeEnabled();
  await expect(supplySurface(page).locator(':scope > [role="status"]')).toContainText('已開放 30 分鐘預留');
  expect(tuples).toHaveLength(3);
  expect(tuples[1]).toEqual(tuples[0]); expect(tuples[2]).toEqual(tuples[0]);
  expect(tuples[0]).toEqual({body: '{"reservation_enabled":true}', key: expect.any(String), version: `"${setting.version}"`});
  expect(tuples[0].key).toBeTruthy();
  const current = await readSetting(page, store.root);
  expect(current.reservation_enabled).toBe(true);
  expect(BigInt(current.version)).toBe(BigInt(setting.version) + 1n);
  await page.getByRole('link', {name: '返回我的供貨商品庫', exact: true}).click();
  await expect(page).toHaveURL(/#stores\/supply$/);
});

test('supply-only reservation setting handles a known CAS conflict by refreshing and waiting for an explicit new choice', async ({page, e2eAuthPool}) => {
  const member = await person(e2eAuthPool); await login(page, member.email);
  const store = await launchStore(page, '並行預留設定空間');
  await post(page, store.root + '/supply-profile', {name: '並行預留設定商品庫', currency: 'TWD'}, 201);
  await open(page, store.hash + '/supply');
  await workspace(page, '預留與訂單').click();
  await expect(page.getByRole('button', {name: '開放 30 分鐘預留', exact: true})).toBeEnabled();
  const initial = await readSetting(page, store.root);
  const newer = await patchSetting(page, store.root, true, initial.version);
  const tuples: ReturnType<typeof settingTuple>[] = [];
  await page.route('**/api/v1' + store.root + '/reservation-setting', async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    tuples.push(settingTuple(route));
    const response = await route.fetch(); expect(response.status()).toBe(tuples.length === 1 ? 412 : 200);
    await route.fulfill({response});
  });
  await page.getByRole('button', {name: '開放 30 分鐘預留', exact: true}).click();
  await expect(supplySurface(page).locator(':scope > [role="status"]')).toContainText('重新載入');
  await expect(page.getByRole('button', {name: '停止接受新預留', exact: true})).toBeEnabled();
  await expect(supplySurface(page).getByRole('button', {name: '重試', exact: true})).toHaveCount(0);
  expect(tuples).toHaveLength(1); expect(tuples[0].version).toBe(`"${initial.version}"`);
  expect(await readSetting(page, store.root)).toEqual(newer);
  await page.getByRole('button', {name: '停止接受新預留', exact: true}).click();
  await expect(page.getByRole('button', {name: '開放 30 分鐘預留', exact: true})).toBeEnabled();
  expect(tuples).toHaveLength(2); expect(tuples[1].version).toBe(`"${newer.version}"`);
  expect(tuples[1].body).toBe('{"reservation_enabled":false}'); expect(tuples[1].key).not.toBe(tuples[0].key);
});

test('supply-only reservation controls require owner reads and never follow admin or read-only capabilities', async ({page, browser, baseURL, e2eAuthPool}) => {
  test.setTimeout(90000);
  const owner = await person(e2eAuthPool); await login(page, owner.email);
  const store = await launchStore(page, '預留權限空間');
  await post(page, store.root + '/supply-profile', {name: '預留權限商品庫', currency: 'TWD'}, 201);
  const [, tenant, instance] = store.hash.split('/');
  for (const role of ['admin', 'reader'] as const) {
    const member = await person(e2eAuthPool), context = await browser.newContext({baseURL});
    try {
      const memberPage = await context.newPage(); await login(memberPage, member.email);
      const candidate = await (await page.request.get(`/api/v1/tenants/invite-candidates?user_id=${member.id}`)).json();
      const invitation = await post(page, `/tenants/${tenant}/invitations`, {
        invitee_principal_id: candidate.principal_id, role: role === 'admin' ? 'admin' : 'operator',
        instance_capabilities: role === 'reader' ? [{instance_id: instance, capabilities: ['store:read']}] : [],
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      }, 201);
      await post(memberPage, `/tenants/${tenant}/invitations/${invitation.invitation_id}/accept`, {}, 200, invitation.version);
      for (const path of ['/reservation-setting', '/supply-reservations']) {
        expect((await memberPage.request.get('/api/v1' + store.root + path)).status()).toBe(403);
      }
      await open(memberPage, store.hash + '/supply');
      await expect(supplySurface(memberPage).getByRole('heading', {name: '預留權限商品庫', exact: true})).toBeVisible();
      await expect(supplySurface(memberPage).getByRole('region', {name: '預留設定', exact: true})).toHaveCount(0);
      await expect(memberPage.getByRole('button', {name: '開放 30 分鐘預留', exact: true})).toHaveCount(0);
      await expect(memberPage.getByRole('button', {name: '停止接受新預留', exact: true})).toHaveCount(0);
      await expect(memberPage.getByRole('link', {name: '供貨訂單', exact: true})).toHaveCount(0);
      if (role === 'admin') {
        await memberPage.getByRole('button', {name: '新增供貨商品', exact: true}).click();
        await expect(memberPage.getByRole('form', {name: '新增供貨商品', exact: true})).toBeVisible();
      }
      else await expect(memberPage.getByRole('form', {name: '新增供貨商品', exact: true})).toHaveCount(0);
    } finally {await context.close();}
  }
});

test('supply-only order entry waits for the authorized supplier read and stays absent after a denied read', async ({page, e2eAuthPool}) => {
  const member = await person(e2eAuthPool); await login(page, member.email);
  const store = await launchStore(page, '供貨訂單入口空間');
  await post(page, store.root + '/supply-profile', {name: '供貨訂單入口商品庫', currency: 'TWD'}, 201);
  const requested = deferred(), release = deferred();
  let phase: 'denied' | 'unavailable' | 'malformed' | 'allowed' = 'denied';
  const reads: string[] = [];
  const path = '**/api/v1' + store.root + '/supply-reservations*';
  await page.route(path, async route => {
    reads.push(phase);
    if (phase === 'denied') {
      requested.resolve(); await release.promise;
      await route.fulfill({status: 404, contentType: 'application/problem+json', body: JSON.stringify({status: 404, code: 'not_found', title: '找不到資料'})});
    } else if (phase === 'unavailable') await route.fulfill({status: 500, contentType: 'application/problem+json', body: JSON.stringify({status: 500, code: 'unavailable', title: '暫時無法讀取'})});
    else if (phase === 'malformed') await route.fulfill({status: 200, contentType: 'application/json', body: '{"items":[]}'});
    else await route.continue();
  });
  try {
    await open(page, store.hash + '/supply'); await requested.promise;
    await workspace(page, '預留與訂單').click();
    await expect(page.getByRole('link', {name: '供貨訂單', exact: true})).toHaveCount(0);
    const denial = page.waitForResponse(response => response.url().includes(store.root + '/supply-reservations'));
    release.resolve();
    expect((await denial).status()).toBe(404);
    await expect(page.getByRole('button', {name: '開放 30 分鐘預留', exact: true})).toBeEnabled();
    await expect(page.getByRole('link', {name: '供貨訂單', exact: true})).toHaveCount(0);
    phase = 'unavailable'; await page.reload();
    await workspace(page, '預留與訂單').click();
    await expect(supplySurface(page)).toContainText('暫時無法確認供貨訂單入口');
    await expect(page.getByRole('link', {name: '供貨訂單', exact: true})).toHaveCount(0);
    phase = 'malformed';
    const malformed = page.waitForResponse(response => response.url().includes(store.root + '/supply-reservations'));
    await page.getByRole('button', {name: '重新確認供貨訂單入口', exact: true}).click();
    expect(await (await malformed).json()).toEqual({items: []});
    await expect(page.getByRole('button', {name: '重新確認供貨訂單入口', exact: true})).toBeVisible();
    await expect(page.getByRole('link', {name: '供貨訂單', exact: true})).toHaveCount(0);
    phase = 'allowed'; await page.getByRole('button', {name: '重新確認供貨訂單入口', exact: true}).click();
    await expect(page.getByRole('link', {name: '供貨訂單', exact: true})).toHaveAttribute('href', '#' + store.hash + '/supply-orders');
    expect(reads).toEqual(['denied', 'unavailable', 'malformed', 'allowed']);
  } finally {release.resolve(); await page.unroute(path);}
});

test('supply-only admission OFF disables opening but allows the owner to stop an existing opt-in', async ({page, browser, e2eAuthPool}) => {
  const member = await person(e2eAuthPool); await login(page, member.email);
  const store = await launchStore(page, '暫停預留空間');
  await post(page, store.root + '/supply-profile', {name: '暫停預留商品庫', currency: 'TWD'}, 201);
  const off = await offListener(e2eAuthPool, true), context = await browser.newContext({baseURL: off.origin});
  try {
    const offPage = await context.newPage();
    await buyerLogin(offPage, member.email, '#' + store.hash + '/supply', off.origin);
    await workspace(offPage, '預留與訂單').click();
    await expect(offPage.getByRole('button', {name: '開放 30 分鐘預留', exact: true})).toBeDisabled();
    await expect(supplySurface(offPage)).toContainText('平台目前未開放新預留');
    expect((await readSetting(offPage, store.root)).admission_enabled).toBe(false);
    const setting = await readSetting(page, store.root); await patchSetting(page, store.root, true, setting.version);
    await offPage.reload();
    await workspace(offPage, '預留與訂單').click();
    await expect(offPage.getByRole('button', {name: '停止接受新預留', exact: true})).toBeEnabled();
    await offPage.getByRole('button', {name: '停止接受新預留', exact: true}).click();
    await expect(offPage.getByRole('button', {name: '開放 30 分鐘預留', exact: true})).toBeDisabled();
    expect((await readSetting(offPage, store.root)).reservation_enabled).toBe(false);
    await offPage.getByRole('link', {name: '供貨訂單', exact: true}).click();
    await expect(offPage.locator('.hosted-store')).toContainText('這一頁沒有供貨預留');
    await expect(offPage.getByRole('link', {name: '查看本店預留', exact: true})).toHaveCount(0);
    await expect(offPage.getByRole('link', {name: '返回供貨商品庫', exact: true})).toHaveAttribute('href', '#' + store.hash + '/supply');
  } finally {try {await context.close();} finally {await off.close();}}
});

test('a delayed supplier owner-setting read cannot restore controls after logout and a different member login', async ({page, e2eAuthPool}) => {
  const owner = await person(e2eAuthPool), stranger = await person(e2eAuthPool);
  await login(page, owner.email);
  const store = await launchStore(page, '登入隔離供貨空間');
  await post(page, store.root + '/supply-profile', {name: '上一位會員的供貨商品庫', currency: 'TWD'}, 201);
  const requested = deferred(), release = deferred(), finished = deferred();
  let delay = true;
  const path = '**/api/v1' + store.root + '/reservation-setting';
  await page.route(path, async route => {
    if (!delay || route.request().method() !== 'GET') return route.continue();
    delay = false;
    const response = await route.fetch(); expect(response.status()).toBe(200); requested.resolve();
    await release.promise;
    try {await route.fulfill({response});} finally {finished.resolve();}
  });
  try {
    await open(page, store.hash + '/supply'); await requested.promise;
    await signOut(page);
    // Stay in the same document so this exercises the app's session boundary.
    await page.getByLabel('電子郵件', {exact: true}).fill(stranger.email);
    await page.getByLabel('密碼', {exact: true}).fill(DEMO_PASSWORD);
    await page.getByRole('button', {name: '登入', exact: true}).click();
    await expect(page.getByRole('button', {name: '設定', exact: true})).toBeVisible();
    release.resolve(); await finished.promise;
    await open(page, store.hash + '/supply');
    await expect(supplySurface(page)).toContainText('找不到這個供貨商品庫');
    await expect(page.getByRole('button', {name: '開放 30 分鐘預留', exact: true})).toHaveCount(0);
    await expect(page.getByRole('link', {name: '供貨訂單', exact: true})).toHaveCount(0);
    await expect(supplySurface(page)).not.toContainText('上一位會員的供貨商品庫');
  } finally {release.resolve(); await page.unroute(path);}
});


test('supplier work areas preserve drafts, show one task at a time and discard only after confirmation', async ({page, e2eAuthPool}, info) => {
  const store = await readyCatalog(page, e2eAuthPool);
  await post(page, store.root + '/supply-products', {title: '草稿測試茶杯', cost_minor: 15000, stock: 10}, 201);
  await open(page, store.hash + '/supply');
  const products = page.getByRole('region', {name: '供貨商品', exact: true});
  const form = page.getByRole('form', {name: '新增供貨商品', exact: true});
  await expect(workspace(page, '商品')).toHaveAttribute('aria-pressed', 'true');
  await expect(form).toHaveCount(0);
  await expect(page.getByRole('button', {name: '更新供貨狀態', exact: true})).toBeHidden();
  await expect(page.getByRole('button', {name: '開放 30 分鐘預留', exact: true})).toBeHidden();
  await page.getByRole('button', {name: '新增供貨商品', exact: true}).click();
  await expect(form.getByLabel('商品名稱', {exact: true})).toBeFocused();
  await form.getByLabel('商品名稱', {exact: true}).fill('留在商品區的草稿');
  await form.getByLabel('供貨單價（TWD）', {exact: true}).fill('180');
  await workspace(page, '供貨合作').click();
  await expect(products).toBeHidden();
  await expect(page.getByRole('button', {name: '更新供貨狀態', exact: true})).toBeVisible();
  await workspace(page, '預留與訂單').click();
  await expect(page.getByRole('button', {name: '更新供貨狀態', exact: true})).toBeHidden();
  await expect(page.getByRole('button', {name: '開放 30 分鐘預留', exact: true})).toBeDisabled();
  await expect(page.getByRole('region', {name: '預留與訂單', exact: true})).toContainText('還有尚未儲存');
  await workspace(page, '商品').click();
  await expect(form.getByLabel('商品名稱', {exact: true})).toHaveValue('留在商品區的草稿');
  await expect(form.getByLabel('供貨單價（TWD）', {exact: true})).toHaveValue('180');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', {name: '編輯供貨商品', exact: true}).click();
  await expect(form.getByLabel('商品名稱', {exact: true})).toHaveValue('留在商品區的草稿');
  page.once('dialog', dialog => dialog.accept());
  await form.getByRole('button', {name: '取消編輯', exact: true}).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByRole('heading', {name: '供貨商品', exact: true})).toBeFocused();
  await page.getByRole('button', {name: '供貨條件', exact: true}).click();
  const terms = page.getByRole('form', {name: '草稿測試茶杯供貨條件', exact: true});
  await terms.getByRole('textbox', {name: '出貨條件', exact: true}).fill('供貨條件草稿');
  await workspace(page, '供貨合作').click();
  await workspace(page, '商品').click();
  await expect(terms.getByRole('textbox', {name: '出貨條件', exact: true})).toHaveValue('供貨條件草稿');
  page.once('dialog', dialog => dialog.accept());
  await terms.getByRole('button', {name: '返回商品', exact: true}).click();
  for (const area of ['供貨合作', '預留與訂單']) {
    await workspace(page, area).click();
    for (const theme of ['light', 'dark', 'versefolk']) {
      await page.evaluate(value => {localStorage.setItem('freedom-theme', value); document.documentElement.dataset.theme = value; document.documentElement.dataset.experienceProfile = value; window.dispatchEvent(new Event('freedom-theme-changed'));}, theme);
      for (const width of [390, 768, 1440]) {
        await page.setViewportSize({width, height: 900});
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({path: info.outputPath(`supply-area-${area}-${theme}-${width}.png`), fullPage: true, animations: 'disabled'});
      }
    }
  }
  expect((await (await page.request.get('/api/v1' + store.root + '/supply-products')).json()).items).toHaveLength(1);
});

test('supply product card shows offer state and requests waiting for the supplier', async ({page, browser, baseURL, e2eAuthPool}, info) => {
  test.setTimeout(120000);
  const title = '狀態茶杯';
  const store = await readyCatalog(page, e2eAuthPool);
  const profile = await (await page.request.get('/api/v1' + store.root + '/supply-profile')).json() as {catalog: {name: string}};
  const catalogName = profile.catalog.name;
  await post(page, store.root + '/supply-products', {title, description: '供貨狀態說明', cost_minor: 12000, stock: 6}, 201);
  const offersHeld = deferred();
  const offersStarted = deferred();
  let offersPhase: 'hold' | 'fail' | 'truncated' | 'live' = 'hold';
  const offersPath = (url: URL) => url.pathname === `/api/v1${store.root}/supply-offers`;
  const requestsPath = (url: URL) => url.pathname === `/api/v1${store.root}/supply-requests`;
  const parentSuffix = {profile: '/supply-profile', products: '/supply-products', reservation: '/reservation-setting'} as const;
  const parentReadPath = (url: URL) => (Object.values(parentSuffix) as string[]).some(suffix => url.pathname === `/api/v1${store.root}${suffix}`);
  let truncateRequests = false;
  let parentFail: keyof typeof parentSuffix | null = null;
  let parentFollowUpReads = 0;
  const lateRequestsHeld = deferred(), lateRequestsStarted = deferred();
  let delayRequests = false;
  await page.route(offersPath, async route => {
    if (route.request().method() !== 'GET') return route.continue();
    if (parentFail) parentFollowUpReads += 1;
    if (offersPhase === 'hold') {offersStarted.resolve(); await offersHeld.promise;}
    if (offersPhase === 'fail') {
      await route.fulfill({status: 503, contentType: 'application/problem+json', body: JSON.stringify({status: 503, title: '暫時無法讀取供貨', code: 'unavailable'})});
      return;
    }
    if (offersPhase === 'truncated') {
      await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({items: [], truncated: true})});
      return;
    }
    await route.continue();
  });
  await page.route(requestsPath, async route => {
    if (route.request().method() !== 'GET') return route.continue();
    if (parentFail) parentFollowUpReads += 1;
    if (delayRequests) {
      delayRequests = false;
      const response = await route.fetch(), snapshot = await response.json();
      lateRequestsStarted.resolve(); await lateRequestsHeld.promise;
      // This visible suffix proves adoption of the delayed, pre-command child
      // snapshot before checking that it cannot restore the parent summary.
      return route.fulfill({response, json: {...snapshot, truncated: true}});
    }
    if (!truncateRequests) return route.continue();
    const response = await route.fetch();
    const body = await response.json() as {truncated?: boolean};
    body.truncated = true;
    await route.fulfill({response, json: body});
  });
  await page.route(parentReadPath, async route => {
    if (route.request().method() !== 'GET' || !parentFail) return route.continue();
    const target = `/api/v1${store.root}${parentSuffix[parentFail]}`;
    if (new URL(route.request().url()).pathname !== target) return route.continue();
    await route.fulfill({status: 503, contentType: 'application/problem+json', body: JSON.stringify({status: 503, title: '暫時無法讀取供貨', code: 'unavailable'})});
  });
  const card = () => page.locator('.hosted-store-product').filter({has: page.getByRole('heading', {name: title, exact: true})});
  const requests = () => page.locator('.hosted-distribution details').filter({has: page.locator('summary').filter({hasText: '供貨申請'})});
  const status = () => supplySurface(page).locator(':scope > [role="status"]');
  try {
    await open(page, store.hash + '/supply');
    await expect(card().getByRole('heading', {name: title, exact: true})).toBeVisible();
    await offersStarted.promise;
    await expect(card()).not.toContainText('供貨版本：');
    offersPhase = 'fail';
    offersHeld.resolve();
    await expect(card().getByText('供貨版本：狀態未完整載入', {exact: true})).toBeVisible();
    await expect(card()).not.toContainText('尚未公開');
    offersPhase = 'truncated';
    await workspace(page, '供貨合作').click();
    const truncatedOffers = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1${store.root}/supply-offers` && response.request().method() === 'GET');
    await page.getByRole('button', {name: '更新供貨狀態', exact: true}).click();
    expect((await truncatedOffers).status()).toBe(200);
    await expect(page.locator('.hosted-distribution')).toContainText('目前只顯示部分供貨與申請，這份清單尚未包含全部資料。');
    await workspace(page, '商品').click();
    await expect(card().getByText('供貨版本：狀態未完整載入', {exact: true})).toBeVisible();
    await expect(card()).not.toContainText('尚未公開');
    offersPhase = 'live';
    const liveOffers = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1${store.root}/supply-offers` && response.request().method() === 'GET');
    await workspace(page, '供貨合作').click();
    await page.getByRole('button', {name: '更新供貨狀態', exact: true}).click();
    expect((await liveOffers).status()).toBe(200);
    await workspace(page, '商品').click();
    await expect(card().getByText('供貨版本：尚未公開', {exact: true})).toBeVisible();
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({width, height: 900});
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({path: info.outputPath(`offer-before-publish-${width}.png`), fullPage: true, animations: 'disabled'});
    }

    await page.getByRole('button', {name: '供貨條件', exact: true}).click();
    const terms = () => page.getByRole('form', {name: `${title}供貨條件`, exact: true});
    await expect(terms().getByRole('button', {name: '公開供貨版本', exact: true})).toBeEnabled();
    const staleNotice = () => page.getByText('供貨申請狀態未完整載入。', {exact: true});
    const parentGet = (suffix: string) => page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1${store.root}${suffix}` && response.request().method() === 'GET');
    async function failParentRead(target: keyof typeof parentSuffix, receipt: string, action: () => Promise<void>, shots = false) {
      parentFail = target;
      parentFollowUpReads = 0;
      const failed = parentGet(parentSuffix[target]);
      const command = page.waitForResponse(response => {
        const url = new URL(response.url());
        return response.request().method() === 'POST' && (url.pathname.endsWith('/supply-offer') || url.pathname.endsWith('/decision'));
      });
      await action();
      expect((await command).ok()).toBeTruthy();
      expect((await failed).status()).toBe(503);
      await expect(status()).toContainText(receipt);
      await expect(page.getByRole('alert').filter({hasText: '服務暫時無法回應（503）。請稍後重試。'})).toBeVisible();
      await expect(page.getByRole('button', {name: '重新載入', exact: true})).toBeEnabled();
      await expect(page.getByRole('button', {name: '重試', exact: true})).toHaveCount(0);
      await expect(supplySurface(page)).not.toContainText('尚未確認原操作的結果');
      await workspace(page, '商品').click();
      await expect(card().getByText('供貨版本：狀態未完整載入', {exact: true})).toBeVisible();
      await expect(card()).not.toContainText('尚未公開');
      await expect(card()).not.toContainText('公開中');
      await expect(staleNotice()).toBeVisible();
      await expect(page.getByText('有 1 件供貨申請等待你確認。', {exact: true})).toHaveCount(0);
      await expect(page.getByText('有至少 1 件供貨申請等待你確認。', {exact: true})).toHaveCount(0);
      await expect(page.getByRole('button', {name: '供貨條件', exact: true})).toBeDisabled();
      if (shots) {
        for (const theme of ['light', 'dark', 'versefolk']) {
          await page.evaluate(value => {localStorage.setItem('freedom-theme', value); document.documentElement.dataset.theme = value; document.documentElement.dataset.experienceProfile = value; window.dispatchEvent(new Event('freedom-theme-changed'));}, theme);
          for (const width of [390, 768, 1440]) {
            await page.setViewportSize({width, height: 900});
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            await page.screenshot({path: info.outputPath(`offer-parent-read-${theme}-${width}.png`), fullPage: true, animations: 'disabled'});
          }
        }
        await page.evaluate(() => {localStorage.setItem('freedom-theme', 'light'); document.documentElement.dataset.theme = 'light'; document.documentElement.dataset.experienceProfile = 'light'; window.dispatchEvent(new Event('freedom-theme-changed'));});
        await page.setViewportSize({width: 1280, height: 900});
      }
      await workspace(page, '供貨合作').click();
      await expect(page.locator('.hosted-distribution')).not.toContainText('目前無法讀取供貨合作');
      await expect(page.getByRole('button', {name: '更新供貨狀態', exact: true})).toBeDisabled();
      await expect(staleNotice()).toBeVisible();
      if (receipt === '已同意這一版選品') await expect(requests().locator('summary')).toContainText('待你確認');
      expect(parentFollowUpReads).toBe(0);
      await workspace(page, '預留與訂單').click();
      await expect(staleNotice()).toBeVisible();
      await expect(page.locator('#supply-cooperation-panel')).toBeHidden();
    }
    async function recoverParentLoad(holdReads = false) {
      parentFail = null;
      const parentStarted = deferred(), parentReleased = deferred();
      const childStarted = deferred(), childReleased = deferred();
      const profilePath = (url: URL) => url.pathname === `/api/v1${store.root}/supply-profile`;
      const holdParent = async (route: Route) => {
        const response = await route.fetch(); expect(response.status()).toBe(200);
        parentStarted.resolve(); await parentReleased.promise;
        await route.fulfill({response});
      };
      const holdChild = async (route: Route) => {
        const response = await route.fetch(); expect(response.status()).toBe(200);
        childStarted.resolve(); await childReleased.promise;
        await route.fulfill({response});
      };
      if (holdReads) {await page.route(profilePath, holdParent); await page.route(requestsPath, holdChild);}
      try {
        const reads = ['/supply-profile', '/supply-products', '/reservation-setting', '/supply-offers'].map(parentGet);
        await page.getByRole('button', {name: '重新載入', exact: true}).click();
        if (holdReads) {
          await parentStarted.promise;
          await expect(card().getByText('供貨版本：狀態未完整載入', {exact: true})).toBeVisible();
          await expect(staleNotice()).toBeVisible();
          await expect(page.getByText('有至少 1 件供貨申請等待你確認。', {exact: true})).toHaveCount(0);
          await expect(status()).toContainText('已同意這一版選品');
          await expect(page.getByRole('button', {name: '供貨條件', exact: true})).toBeDisabled();
          parentReleased.resolve(); await childStarted.promise;
          await expect(card().getByText('供貨版本：狀態未完整載入', {exact: true})).toBeVisible();
          await expect(staleNotice()).toBeVisible();
          await expect(page.getByText('有至少 1 件供貨申請等待你確認。', {exact: true})).toHaveCount(0);
          childReleased.resolve();
        }
        for (const read of reads) expect((await read).status()).toBe(200);
        await workspace(page, '商品').click();
        await expect(card().getByText('供貨版本：公開中', {exact: true})).toBeVisible();
        await expect(staleNotice()).toHaveCount(0);
        await expect(page.getByRole('button', {name: '重新載入', exact: true})).toHaveCount(0);
        await expect(page.getByRole('button', {name: '供貨條件', exact: true})).toBeEnabled();
        await expect(page.getByRole('alert').filter({hasText: '服務暫時無法回應（503）'})).toHaveCount(0);
      } finally {
        parentReleased.resolve(); childReleased.resolve();
        if (holdReads) {await page.unroute(profilePath, holdParent); await page.unroute(requestsPath, holdChild);}
      }
    }
    offersPhase = 'fail';
    const failedPublishRead = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1${store.root}/supply-offers` && response.request().method() === 'GET');
    await terms().getByRole('button', {name: '公開供貨版本', exact: true}).click();
    expect((await failedPublishRead).status()).toBe(503);
    await expect(status()).toContainText('已公開供貨版本');
    await expect(card().getByText('供貨版本：狀態未完整載入', {exact: true})).toBeVisible();
    await expect(card()).not.toContainText('尚未公開');
    await expect(card()).not.toContainText('公開中');
    await expect(staleNotice()).toBeVisible();
    await expect(page.locator('#supply-cooperation-panel')).toBeHidden();
    await workspace(page, '預留與訂單').click();
    await expect(staleNotice()).toBeVisible();
    await expect(page.getByText('有 1 件供貨申請等待你確認。', {exact: true})).toHaveCount(0);
    await expect(page.locator('#supply-cooperation-panel')).toBeHidden();
    await workspace(page, '商品').click();
    for (const theme of ['light', 'dark', 'versefolk']) {
      await page.evaluate(value => {localStorage.setItem('freedom-theme', value); document.documentElement.dataset.theme = value; document.documentElement.dataset.experienceProfile = value; window.dispatchEvent(new Event('freedom-theme-changed'));}, theme);
      for (const width of [390, 768, 1440]) {
        await page.setViewportSize({width, height: 900});
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({path: info.outputPath(`offer-stale-${theme}-${width}.png`), fullPage: true, animations: 'disabled'});
      }
    }
    await page.evaluate(() => {localStorage.setItem('freedom-theme', 'light'); document.documentElement.dataset.theme = 'light'; document.documentElement.dataset.experienceProfile = 'light'; window.dispatchEvent(new Event('freedom-theme-changed'));});
    offersPhase = 'live';
    const recoveredPublish = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1${store.root}/supply-offers` && response.request().method() === 'GET');
    await workspace(page, '供貨合作').click();
    await page.getByRole('button', {name: '更新供貨狀態', exact: true}).click();
    expect((await recoveredPublish).status()).toBe(200);
    await workspace(page, '商品').click();
    await expect(card().getByText('供貨版本：公開中', {exact: true})).toBeVisible();
    await expect(staleNotice()).toHaveCount(0);
    await workspace(page, '預留與訂單').click();
    await expect(staleNotice()).toHaveCount(0);
    await workspace(page, '商品').click();
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({width, height: 900});
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({path: info.outputPath(`offer-recovered-${width}.png`), fullPage: true, animations: 'disabled'});
    }
    await page.setViewportSize({width: 1280, height: 900});

    for (const target of ['profile', 'products', 'reservation'] as const) {
      await page.getByRole('button', {name: '供貨條件', exact: true}).click();
      await expect(terms().getByRole('button', {name: '公開供貨版本', exact: true})).toBeEnabled();
      await failParentRead(target, '已公開供貨版本', () => terms().getByRole('button', {name: '公開供貨版本', exact: true}).click(), target === 'profile');
      await recoverParentLoad();
    }

    const retailerContext = await browser.newContext({baseURL});
    try {
      const retailer = await retailerContext.newPage();
      const member = await person(e2eAuthPool);
      await login(retailer, member.email);
      const shop = await launchStore(retailer, '狀態選物');
      await post(retailer, shop.root + '/setup', {name: '狀態選物', slug: `state-${randomUUID().slice(0, 8)}`, currency: 'TWD'}, 201);
      await open(retailer, shop.hash);
      await storeArea(retailer, '供貨合作');
      await retailer.getByRole('button', {name: '更新供貨狀態', exact: true}).click();
      const catalog = retailer.locator('.hosted-distribution details').filter({has: retailer.locator('summary').filter({hasText: '選用其他商店'})});
      if (await catalog.getAttribute('open') === null) await catalog.locator('summary').click();
      const offer = catalog.locator('article').filter({has: retailer.getByRole('heading', {name: `${title}・${catalogName}`, exact: true})});
      await expect(offer).toBeVisible();
      await offer.getByRole('button', {name: '設定我的售價', exact: true}).click();
      await offer.getByLabel('我的零售價（TWD）', {exact: true}).fill('20');
      await offer.getByRole('button', {name: '送出供貨申請', exact: true}).click();
      await expect(retailer.locator('.hosted-store > [role="status"]')).toContainText('已送出選品');
    } finally {await retailerContext.close();}

    await workspace(page, '供貨合作').click();
    const loadedRequests = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1${store.root}/supply-requests` && response.request().method() === 'GET');
    await page.getByRole('button', {name: '更新供貨狀態', exact: true}).click();
    expect((await loadedRequests).status()).toBe(200);
    await expect(requests().locator('summary')).toHaveText('供貨申請（1・待你確認 1）');
    await expect.poll(() => requests().evaluate(element => (element as HTMLDetailsElement).open)).toBe(true);
    await expect(requests().getByRole('button', {name: '同意這一版', exact: true})).toBeVisible();
    await expect(page.getByText('有 1 件供貨申請等待你確認。', {exact: true})).toBeVisible();
    await workspace(page, '商品').click();
    await expect(page.getByText('有 1 件供貨申請等待你確認。', {exact: true})).toBeVisible();
    await workspace(page, '預留與訂單').click();
    await expect(page.getByText('有 1 件供貨申請等待你確認。', {exact: true})).toBeVisible();
    await workspace(page, '供貨合作').click();

    await requests().locator('summary').click();
    await expect.poll(() => requests().evaluate(element => (element as HTMLDetailsElement).open)).toBe(false);
    const refreshedClosed = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1${store.root}/supply-offers` && response.request().method() === 'GET');
    await page.getByRole('button', {name: '更新供貨狀態', exact: true}).click();
    expect((await refreshedClosed).status()).toBe(200);
    await expect.poll(() => requests().evaluate(element => (element as HTMLDetailsElement).open)).toBe(false);
    await requests().locator('summary').click();
    await expect(requests().getByRole('button', {name: '同意這一版', exact: true})).toBeVisible();

    truncateRequests = true;
    const truncatedRequests = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1${store.root}/supply-requests` && response.request().method() === 'GET');
    await page.getByRole('button', {name: '更新供貨狀態', exact: true}).click();
    expect((await truncatedRequests).status()).toBe(200);
    await expect(requests().locator('summary')).toHaveText('供貨申請（1・待你確認至少 1 件）');
    await expect(page.getByText('有至少 1 件供貨申請等待你確認。', {exact: true})).toBeVisible();
    await expect(page.locator('.hosted-distribution')).toContainText('目前只顯示部分供貨與申請，這份清單尚未包含全部資料。');
    truncateRequests = false;
    const restoredRequests = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1${store.root}/supply-requests` && response.request().method() === 'GET');
    await page.getByRole('button', {name: '更新供貨狀態', exact: true}).click();
    expect((await restoredRequests).status()).toBe(200);
    await expect(requests().locator('summary')).toHaveText('供貨申請（1・待你確認 1）');
    await expect(page.getByText('有 1 件供貨申請等待你確認。', {exact: true})).toBeVisible();
    await expect(page.locator('.hosted-distribution')).not.toContainText('目前只顯示部分供貨與申請');

    offersPhase = 'fail';
    const failedAcceptRead = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1${store.root}/supply-offers` && response.request().method() === 'GET');
    await requests().getByRole('button', {name: '同意這一版', exact: true}).click();
    expect((await failedAcceptRead).status()).toBe(503);
    await expect(status()).toContainText('已同意這一版選品');
    await workspace(page, '商品').click();
    await expect(page.getByText('有 1 件供貨申請等待你確認。', {exact: true})).toHaveCount(0);
    await expect(page.getByText('有至少 1 件供貨申請等待你確認。', {exact: true})).toHaveCount(0);
    await expect(staleNotice()).toBeVisible();
    await expect(card().getByText('供貨版本：狀態未完整載入', {exact: true})).toBeVisible();
    await expect(card()).not.toContainText('公開中');
    await expect(page.locator('#supply-cooperation-panel')).toBeHidden();
    await workspace(page, '預留與訂單').click();
    await expect(staleNotice()).toBeVisible();
    await expect(page.getByText('有 1 件供貨申請等待你確認。', {exact: true})).toHaveCount(0);
    await expect(page.locator('#supply-cooperation-panel')).toBeHidden();
    offersPhase = 'live';
    const recoveredAccept = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1${store.root}/supply-requests` && response.request().method() === 'GET');
    await workspace(page, '供貨合作').click();
    await page.getByRole('button', {name: '更新供貨狀態', exact: true}).click();
    expect((await recoveredAccept).status()).toBe(200);
    await expect(requests().locator('summary')).toHaveText('供貨申請（1）');
    await expect(page.getByText('有 1 件供貨申請等待你確認。', {exact: true})).toHaveCount(0);
    await expect(page.getByText('有至少 1 件供貨申請等待你確認。', {exact: true})).toHaveCount(0);
    await expect(staleNotice()).toHaveCount(0);
    await workspace(page, '商品').click();
    await expect(page.getByText('有 1 件供貨申請等待你確認。', {exact: true})).toHaveCount(0);
    await expect(staleNotice()).toHaveCount(0);
    await expect(card().getByText('供貨版本：公開中', {exact: true})).toBeVisible();

    const retailerAgain = await browser.newContext({baseURL});
    try {
      const retailer = await retailerAgain.newPage();
      const member = await person(e2eAuthPool);
      await login(retailer, member.email);
      const shop = await launchStore(retailer, '狀態選物再申請');
      await post(retailer, shop.root + '/setup', {name: '狀態選物再申請', slug: `stateb-${randomUUID().slice(0, 8)}`, currency: 'TWD'}, 201);
      await open(retailer, shop.hash);
      await storeArea(retailer, '供貨合作');
      await retailer.getByRole('button', {name: '更新供貨狀態', exact: true}).click();
      const catalog = retailer.locator('.hosted-distribution details').filter({has: retailer.locator('summary').filter({hasText: '選用其他商店'})});
      if (await catalog.getAttribute('open') === null) await catalog.locator('summary').click();
      const offer = catalog.locator('article').filter({has: retailer.getByRole('heading', {name: `${title}・${catalogName}`, exact: true})});
      await expect(offer).toBeVisible();
      await offer.getByRole('button', {name: '設定我的售價', exact: true}).click();
      await offer.getByLabel('我的零售價（TWD）', {exact: true}).fill('21');
      await offer.getByRole('button', {name: '送出供貨申請', exact: true}).click();
      await expect(retailer.locator('.hosted-store > [role="status"]')).toContainText('已送出選品');
    } finally {await retailerAgain.close();}

    await workspace(page, '供貨合作').click();
    const loadedAgain = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1${store.root}/supply-requests` && response.request().method() === 'GET');
    await page.getByRole('button', {name: '更新供貨狀態', exact: true}).click();
    expect((await loadedAgain).status()).toBe(200);
    await expect(requests().locator('summary')).toHaveText('供貨申請（2・待你確認 1）');
    await expect(requests().getByRole('button', {name: '同意這一版', exact: true})).toBeVisible();
    await expect(page.getByText('有 1 件供貨申請等待你確認。', {exact: true})).toBeVisible();
    delayRequests = true;
    await page.getByRole('button', {name: '更新供貨狀態', exact: true}).click();
    await lateRequestsStarted.promise;
    await expect(requests().getByRole('button', {name: '同意這一版', exact: true})).toBeEnabled();
    await failParentRead('reservation', '已同意這一版選品', () => requests().getByRole('button', {name: '同意這一版', exact: true}).click());
    const lateResponse = page.waitForResponse(response => requestsPath(new URL(response.url())) && response.request().method() === 'GET');
    lateRequestsHeld.resolve(); expect((await lateResponse).status()).toBe(200);
    await workspace(page, '供貨合作').click();
    await expect(requests().locator('summary')).toHaveText('供貨申請（2・待你確認至少 1 件）');
    await expect(staleNotice()).toBeVisible();
    for (const area of ['商品', '預留與訂單']) {
      await workspace(page, area).click();
      await expect(staleNotice()).toBeVisible();
      await expect(page.getByText('有 1 件供貨申請等待你確認。', {exact: true})).toHaveCount(0);
      await expect(page.getByText('有至少 1 件供貨申請等待你確認。', {exact: true})).toHaveCount(0);
    }
    await workspace(page, '商品').click();
    await expect(card().getByText('供貨版本：狀態未完整載入', {exact: true})).toBeVisible();
    await expect(card()).not.toContainText('公開中');
    await recoverParentLoad(true);
    await workspace(page, '供貨合作').click();
    await expect(requests().locator('summary')).toHaveText('供貨申請（2）');
    await expect(page.getByText('有 1 件供貨申請等待你確認。', {exact: true})).toHaveCount(0);
    await expect(page.getByText('有至少 1 件供貨申請等待你確認。', {exact: true})).toHaveCount(0);
    await expect(staleNotice()).toHaveCount(0);
  } finally {
    lateRequestsHeld.resolve();
    offersHeld.resolve();
    await page.unroute(offersPath);
    await page.unroute(requestsPath);
    await page.unroute(parentReadPath);
  }
});
