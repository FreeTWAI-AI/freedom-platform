import {LIVE_PUBLIC_ORIGIN} from '../../apps/platform-api/src/routes/published-skills.js';
import {test, expect} from './fixtures.js';
import {fixtureStore, apiLogin, enableStore} from './hosted-order-fixture.js';
import {post} from './hosted-store-fixture.js';
import {DEMO_PASSWORD} from '../../packages/testing/seed.js';
import {StoreViewSchema} from '../../contracts/guild-launchpad/v1/storefront.js';

// All people, brand copy and products in these cases are explicitly synthetic.
test('published product link preserves selection through login, review, reservation and a fresh return', async ({page, browser, baseURL, e2eAuthPool}, info) => {
  const s = await fixtureStore(e2eAuthPool, browser, baseURL!);
  await enableStore(e2eAuthPool, s.instance);
  const detail = `/shops/${s.slug}/products/${s.product.sku}`, selected = `#reservations/${s.slug}/product/${s.product.sku}`;
  const mutations: string[] = [];
  page.on('request', request => {if (request.method() === 'POST' && /\/reservation-(quotes|orders)$/.test(new URL(request.url()).pathname)) mutations.push(new URL(request.url()).pathname);});
  await page.goto('/shops/' + s.slug);
  await expect(page.getByRole('heading', {level: 1})).toHaveText('山邊小店');
  await page.getByRole('link', {name: '查看商品：手作茶杯', exact: true}).click();
  await expect(page).toHaveURL(new URL(detail, baseURL!).href);
  await expect(page.getByRole('heading', {level: 1})).toHaveText('手作茶杯');
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', new URL(detail, LIVE_PUBLIC_ORIGIN).href);
  await expect(page.locator('meta[property="og:description"]')).toHaveAttribute('content', '杯口手工成形。');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({width, height: 900});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({path: info.outputPath(`synthetic-product-${width}.png`), fullPage: true});
  }
  await page.getByRole('link', {name: '登入確認預留條件', exact: true}).click();
  await expect(page).toHaveURL(new URL('/' + selected, baseURL!).href);
  await page.getByLabel('電子郵件', {exact: true}).fill(s.buyer.email);
  await page.getByLabel('密碼', {exact: true}).fill(DEMO_PASSWORD);
  await page.getByRole('button', {name: '登入', exact: true}).click();
  const surface = page.locator('.hosted-store'), quantity = surface.getByLabel('手作茶杯數量');
  await expect(quantity).toHaveValue('1');
  await expect(surface).toContainText('從商品頁選擇的商品');
  expect(mutations).toEqual([]);
  await quantity.fill('2');
  for (const theme of ['light', 'dark', 'versefolk']) for (const width of [390, 768, 1440]) {
    await page.evaluate(value => {localStorage.setItem('freedom-theme', value); document.documentElement.dataset.theme = value; document.documentElement.dataset.experienceProfile = value; window.dispatchEvent(new Event('freedom-theme-changed'));}, theme);
    await page.setViewportSize({width, height: 900});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({path: info.outputPath(`product-selection-${theme}-${width}.png`), fullPage: true});
  }
  await surface.getByRole('button', {name: '查看預留內容', exact: true}).click();
  await expect(page.getByRole('region', {name: '確認預留內容'})).toContainText('非應付金額');
  expect(mutations).toHaveLength(1);
  expect((await e2eAuthPool.query('SELECT reserved FROM commerce_items WHERE item_id=$1', [s.product.product_id])).rows[0].reserved).toBe(0);
  await surface.getByRole('button', {name: '確認預留 30 分鐘', exact: true}).click();
  await expect(page.getByRole('region', {name: '我的預留'})).toContainText('預留中');
  expect(mutations).toHaveLength(2);
  const hash = new URL(page.url()).hash;
  expect((await e2eAuthPool.query('SELECT reserved FROM commerce_items WHERE item_id=$1', [s.product.product_id])).rows[0].reserved).toBe(2);
  const fresh = await browser.newContext({baseURL});
  try {
    await apiLogin(fresh, baseURL!, s.buyer.email);
    const returned = await fresh.newPage(); await returned.goto('/' + hash);
    await expect(returned.getByRole('region', {name: '我的預留'})).toContainText('預留中');
    returned.once('dialog', dialog => dialog.accept());
    await returned.getByRole('button', {name: '取消預留', exact: true}).click();
    await expect(returned.getByRole('region', {name: '我的預留'})).toContainText('已取消');
    expect((await e2eAuthPool.query('SELECT reserved FROM commerce_items WHERE item_id=$1', [s.product.product_id])).rows[0].reserved).toBe(0);
  } finally {await fresh.close();}
});

test('draft changes cannot change public product metadata; closed and missing products cannot start a reservation', async ({page, browser, baseURL, e2eAuthPool}) => {
  const s = await fixtureStore(e2eAuthPool, browser, baseURL!);
  const detail = `/shops/${s.slug}/products/${s.product.sku}`;
  await apiLogin(page.context(), baseURL!, s.buyer.email);
  const writes: string[] = [];
  page.on('request', request => {if (request.method() === 'POST') writes.push(new URL(request.url()).pathname);});
  await page.goto(`/#reservations/${s.slug}/product/${s.product.sku}`);
  await expect(page.locator('.hosted-store')).toContainText('商品僅供展示');
  await expect(page.getByLabel('手作茶杯數量')).toHaveCount(0);
  await expect(page.getByRole('button', {name: '查看預留內容', exact: true})).toHaveCount(0);
  await enableStore(e2eAuthPool, s.instance);
  await page.goto(`/#reservations/${s.slug}/product/P999999`);
  await expect(page.locator('.hosted-store')).toContainText('分享的商品目前沒有公開');
  await expect(page.getByRole('button', {name: '查看預留內容', exact: true})).toHaveCount(0);
  expect(writes).toEqual([]);
  const owner = await browser.newContext({baseURL});
  try {
    const session = await apiLogin(owner, baseURL!, s.seller.email);
    const editor = await owner.newPage(); await editor.goto('/');
    const response = await editor.request.patch('/api/v1' + s.root + '/products/' + s.product.product_id, {data: {title: '未發布草稿：新的茶杯'}, headers: {Origin: baseURL!, 'X-CSRF-Token': session.csrf_token, 'Idempotency-Key': crypto.randomUUID(), 'If-Match': `"${s.product.version}"`}});
    expect(response.status()).toBe(200);
    await page.goto(detail);
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', '手作茶杯｜山邊小店');
    const preview = await editor.request.get('/api/v1' + s.root + '/preview-page');
    expect(preview.status()).toBe(200); const html = await preview.text();
    expect(html).toContain('未發布草稿：新的茶杯'); expect(html).not.toContain('property="og:'); expect(html).not.toContain('rel="canonical"');
    const current = StoreViewSchema.parse(await (await editor.request.get('/api/v1' + s.root)).json());
    await post(editor, s.root + '/unpublish', {}, 200, current.version!);
    const missing = await page.goto(detail); expect(missing!.status()).toBe(404);
    await expect(page.getByRole('heading', {level: 1})).toHaveText('找不到這項商品');
    await expect(page.locator('meta[property^="og:"]')).toHaveCount(0);
    await expect(page.getByRole('link', {name: '登入確認預留條件', exact: true})).toHaveCount(0);
  } finally {await owner.close();}
});
