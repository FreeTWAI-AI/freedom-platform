import {test, expect} from './fixtures.js';
import {person, login, launchStore, open, post} from './hosted-store-fixture.js';

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
    await expect(page.getByLabel('商店網址', {exact: true})).toHaveCount(0);
    await expect(page.getByRole('heading', {name: '預覽與發布', exact: true})).toHaveCount(0);
    if (action === 'edit') await page.getByRole('button', {name: '編輯供貨商品', exact: true}).click();
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
    for (const width of [390, 1440]) {
      await page.setViewportSize({width, height: 900});
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({path: info.outputPath(`supply-${action}-${width}.png`), fullPage: true});
    }
    await page.getByRole('link', {name: '返回我的供貨商品庫', exact: true}).click();
    await expect(page).toHaveURL(/#stores\/supply$/);
    await expect(page.getByRole('link', {name: '查看商品與供貨', exact: true})).toHaveAttribute('href', '#' + store.hash + '/supply');
  });
}
