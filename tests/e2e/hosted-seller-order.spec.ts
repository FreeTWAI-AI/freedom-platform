import {randomUUID} from 'node:crypto';
import type {Route, Browser} from '@playwright/test';
import type {Pool} from 'pg';
import {test, expect, type Page} from './fixtures.js';
import {navigate} from './navigation.js';
import {apiLogin, buyerLogin, enableStore, fixtureStore, offListener} from './hosted-order-fixture.js';
import {OrderSchema, QuoteSchema} from '../../contracts/guild-launchpad/v1/hosted-order.js';
const surface = (page: Page) => page.locator('.hosted-store');
function gate() {let resolve!: () => void; const promise = new Promise<void>(done => {resolve = done;}); return {promise, resolve};}
function tuple(route: Route) {const r = route.request(); return {body: r.postData(), key: r.headers()['idempotency-key'], version: r.headers()['if-match']};}
async function reserved(db: Pool, browser: Browser, origin: string) {
  const store = await fixtureStore(db, browser, origin); await enableStore(db, store.instance);
  const context = await browser.newContext({baseURL: origin});
  try {
    const session = await apiLogin(context, origin, store.buyer.email);
    const post = async (path: string, data: unknown) => {
      const r = await context.request.post('/api/v1' + path, {data, headers: {Origin: origin, 'X-CSRF-Token': session.csrf_token, 'Idempotency-Key': randomUUID()}});
      expect(r.status()).toBe(201); return r.json();
    };
    const quote = QuoteSchema.parse(await post(`/hosted-stores/${store.slug}/quotes`, {publication_revision: '1', items: [{sku: store.product.sku, quantity: 2}]}));
    const order = OrderSchema.parse(await post(`/hosted-stores/${store.slug}/orders`, {quote_id: quote.quote_id, terms_sha256: quote.terms_sha256, client_order_id: randomUUID()}));
    return {...store, order};
  } finally {await context.close();}
}
async function blocked(page: Page, hash: string) {
  await navigate(page, '會員首頁'); await expect(page).toHaveURL(new RegExp(hash + '$'));
  await surface(page).getByRole('link', {name: '返回商店後台'}).click(); await expect(page).toHaveURL(new RegExp(hash + '$'));
  await page.evaluate(value => new Promise<void>(resolve => {
    history.pushState(null, '', '#home'); history.pushState(null, '', value);
    window.addEventListener('popstate', () => resolve(), {once: true}); history.back();
  }), hash);
  await expect(page).toHaveURL(new RegExp(hash + '$'));
  await page.evaluate(() => {location.hash = 'skills';}); await expect(page).toHaveURL(new RegExp(hash + '$'));
  await page.getByRole('button', {name: '設定', exact: true}).click();
  await page.getByRole('menuitem', {name: '登出', exact: true}).click();
  await expect(page).toHaveURL(new RegExp(hash + '$')); await expect(surface(page)).toContainText('請先確認原取消結果');
  const settings = page.getByRole('button', {name: '設定', exact: true});
  if (await settings.getAttribute('aria-expanded') === 'true') await settings.click();
}

test('HO-SUI01 owner entry, committed stale cancel ACK, original tuple guards and one stock release', async ({page, browser, baseURL, e2eAuthPool}) => {
  test.setTimeout(120000);
  const s = await reserved(e2eAuthPool, browser, baseURL!); const hash = `#stores/${s.tenant}/${s.instance}/orders`;
  await buyerLogin(page, s.seller.email, `#stores/${s.tenant}/${s.instance}`);
  await surface(page).getByRole('link', {name: '預留訂單', exact: true}).click();
  await surface(page).getByRole('button', {name: '查看這筆預留'}).click();
  await expect(page.getByRole('region', {name: '預留明細'})).toContainText('預留中');
  const committed = gate(), release = gate(); const sent: ReturnType<typeof tuple>[] = []; let damaged = false;
  const path = `**/api/v1${s.root}/orders/${s.order.order_id}/cancel`;
  await page.route(path, async route => {
    sent.push(tuple(route)); const response = await route.fetch(); expect(response.status()).toBe(200);
    expect(OrderSchema.parse(await response.json()).state).toBe('cancelled');
    if (!damaged) {damaged = true; committed.resolve(); await release.promise; await route.fulfill({response, json: s.order});}
    else await route.fulfill({response});
  });
  try {
    page.once('dialog', d => d.accept()); await surface(page).getByRole('button', {name: '取消這筆預留'}).click();
    await committed.promise; await blocked(page, hash); release.resolve();
    await expect(surface(page).getByRole('button', {name: '重試原取消'})).toBeEnabled(); await blocked(page, hash);
    const readPath = `**/api/v1${s.root}/orders/${s.order.order_id}`;
    await page.route(readPath, async route => {const response = await route.fetch(); await route.fulfill({response, json: s.order});});
    await surface(page).getByRole('button', {name: '查詢原預留'}).click();
    await expect(surface(page).getByRole('button', {name: '重試原取消'})).toBeEnabled();
    await page.unroute(readPath);
    await surface(page).getByRole('button', {name: '重試原取消'}).click();
    await expect(page.getByRole('region', {name: '預留明細'})).toContainText('已取消');
    expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0]); expect(sent[0].body).toBe('{}'); expect(sent[0].version).toBe(`"${s.order.version}"`);
    expect((await e2eAuthPool.query('SELECT reservation_version,reservation_state FROM commerce_orders WHERE order_id=$1', [s.order.order_id])).rows[0]).toEqual({reservation_version: '2', reservation_state: 'cancelled'});
    expect((await e2eAuthPool.query('SELECT reserved FROM commerce_items WHERE item_id=$1', [s.product.product_id])).rows[0].reserved).toBe(0);
    await navigate(page, '會員首頁'); await expect(page).toHaveURL(/#home$/);
  } finally {release.resolve(); await page.unroute(path);}
});

test('HO-SUI02 saved owner link survives fresh login with both flags OFF; stranger cannot operate', async ({browser, baseURL, e2eAuthPool}) => {
  test.setTimeout(90000);
  const s = await reserved(e2eAuthPool, browser, baseURL!); const off = await offListener(e2eAuthPool, false);
  const owner = await browser.newContext(), stranger = await browser.newContext();
  try {
    const page = await owner.newPage(); let cancelPosts = 0;
    page.on('request', r => {if (r.method() === 'POST' && r.url().endsWith('/cancel')) cancelPosts++;});
    await buyerLogin(page, s.seller.email, `#stores/${s.tenant}/${s.instance}`, off.origin);
    await surface(page).getByRole('button', {name: '查看這筆預留'}).click(); expect(cancelPosts).toBe(0);
    const other = await stranger.newPage(); await buyerLogin(other, s.stranger.email, `#stores/${s.tenant}/${s.instance}/orders`, off.origin);
    await expect(surface(other)).toContainText('目前無法讀取這間商店的預留');
    await expect(surface(other).getByRole('button', {name: '取消這筆預留'})).toHaveCount(0);
    page.once('dialog', d => d.accept()); await surface(page).getByRole('button', {name: '取消這筆預留'}).click();
    await expect(page.getByRole('region', {name: '預留明細'})).toContainText('已取消'); expect(cancelPosts).toBe(1);
    await page.reload(); await surface(page).getByRole('button', {name: '查看這筆預留'}).click();
    await expect(page.getByRole('region', {name: '預留明細'})).toContainText('已取消'); expect(cancelPosts).toBe(1);
  } finally {try {await Promise.all([owner.close(), stranger.close()]);} finally {await off.close();}}
});

test('HO-SUI03 a known 412 refreshes the terminal state without silently resubmitting', async ({page, browser, baseURL, e2eAuthPool}) => {
  test.setTimeout(90000);
  const s = await reserved(e2eAuthPool, browser, baseURL!);
  await buyerLogin(page, s.seller.email, `#stores/${s.tenant}/${s.instance}/orders`);
  await surface(page).getByRole('button', {name: '查看這筆預留'}).click();
  await expect(page.getByRole('region', {name: '預留明細'})).toContainText('預留中');
  const buyer = await browser.newContext({baseURL});
  try {
    const session = await apiLogin(buyer, baseURL!, s.buyer.email);
    const response = await buyer.request.post(`/api/v1/me/hosted-orders/${s.order.order_id}/cancel`, {data: {}, headers: {Origin: baseURL!, 'X-CSRF-Token': session.csrf_token, 'Idempotency-Key': randomUUID(), 'If-Match': `"${s.order.version}"`}});
    expect(response.status()).toBe(200);
  } finally {await buyer.close();}
  let posts = 0;
  page.on('request', r => {if (r.method() === 'POST' && r.url().endsWith(`/orders/${s.order.order_id}/cancel`)) posts++;});
  page.once('dialog', d => d.accept()); await surface(page).getByRole('button', {name: '取消這筆預留'}).click();
  await expect(surface(page)).toContainText('預留版本已更新');
  await expect(page.getByRole('region', {name: '預留明細'})).toContainText('已取消');
  await expect(surface(page).getByRole('button', {name: '取消這筆預留'})).toHaveCount(0);
  expect(posts).toBe(1); await navigate(page, '會員首頁'); await expect(page).toHaveURL(/#home$/);
});
