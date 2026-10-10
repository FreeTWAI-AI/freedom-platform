import {randomUUID} from 'node:crypto';
import {test, expect, type Page} from './fixtures.js';
import {apiLogin, buyerLogin, enableStore, fixtureStore} from './hosted-order-fixture.js';
import {SupplyTermsSchema} from '../../contracts/guild-launchpad/v1/hosted-supply-terms.js';
import {signOut} from './navigation.js';

const form = (page: Page) => page.getByRole('form', {name: '手作茶杯供貨條件'});
async function edit(page: Page) {
  await page.locator('.hosted-store').getByRole('button', {name: '供貨條件', exact: true}).click();
  await expect(form(page).getByLabel('供貨單價（TWD）', {exact: true})).toBeVisible();
}
async function fill(page: Page, cost = '180.00') {
  await form(page).getByLabel('供貨單價（TWD）', {exact: true}).fill(cost);
  await form(page).getByLabel('每件運費（TWD）', {exact: true}).fill('0');
  await form(page).getByRole('textbox', {name: '出貨條件', exact: true}).fill('供貨確認後三個工作日內出貨。');
  await form(page).getByRole('textbox', {name: '退貨條件', exact: true}).fill('瑕疵品由供貨方協助換貨。');
}

test('supplier terms persist across login, keep retail separate and show the shared reservation balance', async ({page, browser, e2eAuthPool: db, baseURL}, info) => {
  const s = await fixtureStore(db, browser, baseURL!); await enableStore(db, s.instance);
  const buyer = await browser.newContext({baseURL});
  try {
    const session = await apiLogin(buyer, baseURL!, s.buyer.email);
    const post = async (path: string, data: unknown) => {
      const r = await buyer.request.post('/api/v1' + path, {data, headers: {Origin: baseURL!, 'X-CSRF-Token': session.csrf_token, 'Idempotency-Key': randomUUID()}});
      expect(r.status()).toBe(201); return r.json();
    };
    const quote = await post(`/hosted-stores/${s.slug}/quotes`, {publication_revision: '1', items: [{sku: s.product.sku, quantity: 2}]});
    await post(`/hosted-stores/${s.slug}/orders`, {quote_id: quote.quote_id, terms_sha256: quote.terms_sha256, client_order_id: randomUUID()});
  } finally {await buyer.close();}
  await buyerLogin(page, s.seller.email, `#stores/${s.tenant}/${s.instance}`); await edit(page);
  await expect(form(page).getByText('庫存 4・已預留 2・可供 2', {exact: true})).toBeVisible();
  await fill(page);
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({width, height: width === 390 ? 844 : 900});
    await form(page).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const button = await form(page).getByRole('button', {name: '儲存供貨條件', exact: true}).boundingBox();
    expect(button!.height).toBeGreaterThanOrEqual(44);
    await page.evaluate(async () => {window.scrollTo(0, 0); await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));});
    await page.screenshot({path: info.outputPath(`supply-${width}.png`), fullPage: true});
  }
  await form(page).getByRole('button', {name: '儲存供貨條件', exact: true}).click();
  await expect(page.locator('.hosted-store [role="status"]').first()).toContainText('已儲存供貨條件。');
  await page.locator('.hosted-store-product').getByRole('button', {name: '編輯', exact: true}).click();
  const retail = page.getByRole('form', {name: '編輯手作茶杯'});
  await retail.getByLabel('價格（新臺幣 TWD）', {exact: true}).fill('420');
  await retail.getByRole('button', {name: '儲存', exact: true}).click();
  await expect(retail).toHaveCount(0);
  const row = (await db.query(`SELECT i.price_minor AS cost,l.retail_price_minor,i.stock,i.reserved,i.shipping_minor FROM commerce_items i JOIN commerce_selections l USING(item_id) WHERE i.item_id=$1`, [s.product.product_id])).rows[0];
  expect(row).toEqual({cost: '18000', retail_price_minor: '42000', stock: 4, reserved: 2, shipping_minor: '0'});
  const published = await (await page.request.get('/api/v1/public/stores/' + s.slug)).json();
  expect(published.products[0].price_minor).toBe(35000);
  expect(JSON.stringify(published)).not.toContain('cost_minor'); expect(JSON.stringify(published)).not.toContain('瑕疵品');
  await signOut(page);
  await buyerLogin(page, s.seller.email, `#stores/${s.tenant}/${s.instance}`); await edit(page);
  await expect(form(page).getByLabel('供貨單價（TWD）', {exact: true})).toHaveValue('180.00');
  await expect(form(page).getByRole('textbox', {name: '退貨條件', exact: true})).toHaveValue('瑕疵品由供貨方協助換貨。');
});

test('committed response loss retries the same supplier edit and a stale tab must review the current version', async ({page, browser, e2eAuthPool: db, baseURL}) => {
  const s = await fixtureStore(db, browser, baseURL!);
  await buyerLogin(page, s.seller.email, `#stores/${s.tenant}/${s.instance}`); await edit(page); await fill(page);
  const tuples: unknown[] = [];
  await page.route('**/products/*/supply-terms', async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    const request = route.request();
    tuples.push({body: request.postData(), key: request.headers()['idempotency-key'], version: request.headers()['if-match']});
    const response = await route.fetch(); expect(response.status()).toBe(200);
    if (tuples.length === 1) await route.abort('failed'); else await route.fulfill({response});
  });
  await form(page).getByRole('button', {name: '儲存供貨條件', exact: true}).click();
  await expect(page.getByRole('alert')).toContainText('尚未確認原操作的結果');
  await expect(form(page).getByLabel('供貨單價（TWD）', {exact: true})).toBeDisabled();
  await page.locator('.hosted-store').getByRole('button', {name: '重試', exact: true}).click();
  await expect(form(page)).toHaveCount(0);
  expect(tuples).toHaveLength(2); expect(tuples[0]).toEqual(tuples[1]);
  expect((await db.query(`SELECT count(*)::int AS n FROM scoped_transition_journal WHERE aggregate_id=$1 AND operation='storefront.supply-terms.update'`, [s.product.product_id])).rows[0].n).toBe(1);
  await page.unroute('**/products/*/supply-terms');
  await edit(page); await fill(page, '200');
  // A second real HTTP client changes the same product while this tab is open.
  const session = await (await page.request.get('/api/v1/session')).json();
  const path = '/api/v1' + s.root + '/products/' + s.product.product_id + '/supply-terms';
  const current = SupplyTermsSchema.parse(await (await page.request.get(path)).json());
  const response = await page.request.patch(path, {data: {cost_minor: 19000, shipping_minor: 0, shipping_terms: '隔日出貨', return_terms: '瑕疵換貨'}, headers: {Origin: baseURL!, 'X-CSRF-Token': session.csrf_token, 'Idempotency-Key': randomUUID(), 'If-Match': `"${current.version}"`}});
  expect(response.status()).toBe(200);
  await form(page).getByRole('button', {name: '儲存供貨條件', exact: true}).click();
  await expect(page.locator('.hosted-store [role="status"]').first()).toContainText('這件商品剛剛被更新');
  await edit(page);
  await expect(form(page).getByLabel('供貨單價（TWD）', {exact: true})).toHaveValue('190.00');
});
