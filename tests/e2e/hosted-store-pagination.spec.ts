import {test, expect, type Page} from './fixtures.js';
import {person, login, open, launchStore} from './hosted-store-fixture.js';
import {signOut} from './navigation.js';
import {MyStoresPageSchema} from '../../contracts/guild-launchpad/v1/storefront-pagination.js';

async function twoStores(page: Page) {
  await launchStore(page, '第一間分頁空間');
  await launchStore(page, '第二間分頁空間');
  const response = await page.request.get('/api/v1/me/stores?pagination=cursor');
  expect(response.status()).toBe(200);
  const {items} = MyStoresPageSchema.parse(await response.json());
  expect(items).toHaveLength(2);
  return items;
}

// The runtime test exercises real 100 + 5 pagination and authorization. These
// browser tests split real store DTOs into two controlled transport pages so
// retries and a delayed response can be exercised without 105 UI installations.
test('store continuation retains the first page on failure and appends without duplicates on retry', async ({page, e2eAuthPool}) => {
  const member = await person(e2eAuthPool);
  await login(page, member.email);
  const items = await twoStores(page);
  let continuations = 0;
  await page.route('**/api/v1/me/stores?**', async route => {
    const query = new URL(route.request().url()).searchParams;
    expect(query.get('pagination')).toBe('cursor');
    if (!query.has('cursor')) return route.fulfill({json: {items: items.slice(0, 1), next_cursor: 'browser-page-two'}});
    expect(query.get('cursor')).toBe('browser-page-two');
    if (++continuations === 1) return route.fulfill({status: 503, json: {error: {code: 'unavailable'}}});
    return route.fulfill({json: {items, next_cursor: null}});
  });
  await open(page, 'stores');
  const list = page.locator('.hosted-store'), cards = list.locator('article');
  await expect(cards).toHaveCount(1);
  await list.getByRole('button', {name: '載入更多商店', exact: true}).click();
  await expect(list.getByRole('alert')).toContainText('暫時');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText(items[0].tenant_display_name);
  await list.getByRole('button', {name: '重試載入其餘商店', exact: true}).click();
  await expect(cards).toHaveCount(2);
  expect(continuations).toBe(2);
  for (const item of items) await expect(list.locator(`a[href="#stores/${item.tenant_id}/${item.instance_id}"]`)).toHaveCount(1);
  await expect(list.getByRole('alert')).toHaveCount(0);
  await expect(list.getByRole('button', {name: /載入.*商店/})).toHaveCount(0);
});

test('a late continuation cannot restore the previous account stores after sign-out', async ({page, e2eAuthPool}) => {
  const owner = await person(e2eAuthPool), outsider = await person(e2eAuthPool);
  await login(page, owner.email);
  const items = await twoStores(page);
  let secondAccount = false, started = false;
  let release!: () => void, finished!: () => void;
  const pending = new Promise<void>(resolve => {release = resolve;});
  const delivered = new Promise<void>(resolve => {finished = resolve;});
  await page.route('**/api/v1/me/stores?**', async route => {
    if (secondAccount) return route.continue();
    if (!new URL(route.request().url()).searchParams.has('cursor')) {
      return route.fulfill({json: {items: items.slice(0, 1), next_cursor: 'browser-delayed-page'}});
    }
    started = true;
    await pending;
    try { await route.fulfill({json: {items: items.slice(1), next_cursor: null}}); }
    finally { finished(); }
  });
  try {
    await open(page, 'stores');
    await page.getByRole('button', {name: '載入更多商店', exact: true}).click();
    await expect.poll(() => started).toBe(true);
    await signOut(page);
    secondAccount = true;
    await login(page, outsider.email);
    await open(page, 'stores');
    await expect(page.locator('.hosted-store')).toContainText('你還沒有商店。');
    release(); await delivered;
    await expect(page.locator('.hosted-store article')).toHaveCount(0);
    for (const item of items) await expect(page.locator('.hosted-store')).not.toContainText(item.tenant_display_name);
  } finally {release();}
});
