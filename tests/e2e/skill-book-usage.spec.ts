import {test, expect, type Page, type Route} from './fixtures.js';
import {communityCatalog} from '../../modules/community/catalog';
import {BLOCK_KINDS} from '../../contracts/guild-launchpad/v1/config';

// API reads are synthetic; the shared fixture still resets isolated auth counters between cases.
const guildKey = 'guild_commerce_sales';
const app = {
  application_key: 'hosted-store', release_ref: 'hosted-store@1.0.0', display_name: '線上商店',
  module_requirements: [], runtime_profiles: ['hosted-reviewed'],
  launch_policy_ref: {policy_key: 'hosted-store.launch', version: '1'},
  license_state: 'reviewed', release_status: 'available', version: '1',
};
const detail = {
  ...app, source_commit: 'a731461c4f1bc38aa5235db8a29cd3e047f1ab9b',
  artifact_digest: {algorithm: 'sha256', value: 'eb9a262e2914af0a8fac3631533f8e4350b4d602b7a682d4497774b60c4d8ac7'},
  skill_book_refs: ['storefront', 'supplier-client'], license_review_ref: null,
};
async function openCatalog(page: Page, release = detail, catalog = app,
  metadata: (route: Route) => Promise<void> = route => route.fulfill({json: communityCatalog}), others: typeof app[] = []) {
  await page.route('**/api/v1/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/v1/community') return metadata(route);
    if (pathname === '/api/v1/session') return route.fulfill({status: 401, json: {code: 'unauthorized'}});
    if (pathname === '/api/v1/site') return route.fulfill({json: {guild_launchpad_enabled: true}});
    if (pathname.endsWith(`/public/guilds/${guildKey}/launchpad`)) return route.fulfill({json: {
      guild: {guild_key: guildKey, name: '開店與銷售公會', purpose: '合成閱讀情境', category: null},
      config: {revision: '1', body: {
        schema_version: 'guild-launchpad.config/v1', guild_key: guildKey, mission_override: null,
        blocks: BLOCK_KINDS.map((kind, order) => ({id: kind, kind, order, enabled: true, title: null})),
        application_refs: [], starter: {title_label: '工作', objective_hint: '目標', note_hint: '筆記'},
        support: {kind: 'platform_help', public_url: null},
      }}, config_problem: null, announcements: [], skill_books: [],
    }});
    if (pathname === '/api/v1/applications') return route.fulfill({json: {items: [catalog, ...others], next_cursor: null, source_version: '1'}});
    if (pathname.includes('/applications/')) return route.fulfill({json: release});
    return route.fulfill({status: 404, json: {code: 'fixture_not_available'}});
  });
  await page.goto(`/#guilds/${guildKey}`);
  const mobile = page.getByRole('combobox', {name: '公會功能', exact: true});
  const navigation = page.getByRole('navigation', {name: '公會功能', exact: true});
  await expect(mobile.or(navigation)).toBeVisible();
  if (await mobile.isVisible()) await mobile.selectOption({label: '工具目錄'});
  else await navigation.getByRole('button', {name: '工具目錄', exact: true}).click();
  await page.getByRole('button', {name: '版本資料', exact: true}).first().click();
  return page.locator('.launchpad-applications');
}

test('original reading versions stay separate from hosted release and unavailable portable download', async ({page}) => {
  const catalog = await openCatalog(page);
  await expect(catalog).toContainText('站內應用版本：hosted-store@1.0.0');
  await expect(catalog).toContainText('9823df79f8ee');
  await expect(catalog.getByRole('link', {name: '閱讀《我的第一間商店》原作 ↗'})).toHaveAttribute('href', 'https://github.com/FreeTWAI/freedom-storefront/blob/9823df79f8eee86008c269437880ed2e49bdc394/README.md');
  await expect(catalog.getByRole('link', {name: '閱讀《供應端工作台》原作 ↗'})).toBeVisible();
  await expect(catalog.getByRole('button', {name: '啟動應用', exact: true})).toHaveCount(0);
  await expect(catalog).toContainText('目前沒有已核對的獨立部署發行物可供下載');
  await expect(catalog.getByRole('link', {name: /下載.*營業/})).toHaveCount(0);
  await catalog.getByText('開店延伸閱讀與來源', {exact: true}).click();
  await expect(catalog).toContainText('尚不表示本站版本已採用或安裝');
  await expect(catalog).toContainText('介面與購物流程參考');
  await expect(catalog).toContainText('Asgard AI Platform');
  await expect(catalog).toContainText('Taiwan Invoice Skills Contributors');
  await page.setViewportSize({width: 390, height: 844});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('absent and unknown references do not infer books or portable capability from external runtime support', async ({page}) => {
  let reads = 0; page.on('request', request => {if (new URL(request.url()).pathname === '/api/v1/community') reads++;});
  const external = {...app, runtime_profiles: ['external-supported']};
  const catalog = await openCatalog(page, {...detail, ...external, skill_book_refs: []}, external);
  await expect(catalog).toContainText('此版本尚未登錄技能書參照');
  expect(reads).toBe(0);
  await expect(catalog).not.toContainText('站內應用版本：');
  await expect(catalog.getByRole('link', {name: /閱讀《/})).toHaveCount(0);
  await expect(catalog).toContainText('目前沒有已核對的獨立部署發行物可供下載');
  await page.unroute('**/api/v1/**');
  await page.goto('about:blank');
  await openCatalog(page, {...detail, skill_book_refs: ['unknown-book', '__proto__']});
  await expect(catalog).toContainText('尚無對應的閱讀指南');
  await expect(catalog.getByRole('link', {name: /閱讀《/})).toHaveCount(0);
});

test('release identity mismatch is rejected and can be retried without showing another release sources', async ({page}) => {
  const catalog = await openCatalog(page, {...detail, release_ref: 'hosted-store@2.0.0'});
  await expect(catalog.getByRole('alert')).toContainText('版本資料與所選應用不一致');
  await expect(catalog.getByRole('region', {name: '線上商店版本資料'})).toHaveCount(0);
  await expect(catalog.getByRole('link', {name: /閱讀《/})).toHaveCount(0);
  await page.route('**/api/v1/applications/*/releases/*', route => route.fulfill({json: detail}));
  await catalog.getByRole('button', {name: '重試', exact: true}).click();
  await expect(catalog.getByRole('link', {name: '閱讀《我的第一間商店》原作 ↗'})).toBeVisible();
});

test('late reading metadata retains edge admission without filling another release', async ({page, baseURL}) => {
  await page.context().addCookies([{name: 'CF_Authorization', value: 'synthetic-edge-admission', url: baseURL!, httpOnly: true, sameSite: 'Lax'}]);
  const other = {...app, application_key: 'manual-workspace', release_ref: 'manual-workspace@1.0.0', display_name: '另一個工具'};
  let firstRead!: () => void;
  const requested = new Promise<void>(resolve => {firstRead = resolve;});
  let finishOld!: () => void;
  const held = new Promise<void>(resolve => {finishOld = resolve;});
  let reads = 0;
  const original = communityCatalog.skill_books.find(book => book.id === 'supplier-client')!;
  const catalog = await openCatalog(page, {...detail, skill_book_refs: ['storefront']}, app, async route => {
    reads++;
    const headers = await route.request().allHeaders();
    expect(headers.cookie).toContain('CF_Authorization=synthetic-edge-admission');
    expect(headers.authorization).toBeUndefined();
    expect(headers['x-csrf-token']).toBeUndefined();
    if (reads === 1) {firstRead(); await held; return route.fulfill({json: communityCatalog});}
    if (reads === 2) return route.fulfill({status: 503, json: {}});
    return route.fulfill({json: {skill_books: [{...original, guide: undefined, source_commit: null}]}});
  }, [other]);
  await requested;
  await page.route('**/api/v1/applications/manual-workspace/releases/*', route => route.fulfill({json: {...detail, ...other, skill_book_refs: ['supplier-client']}}));
  await catalog.locator('.application-card').filter({has: page.getByRole('heading', {name: '另一個工具'})}).getByRole('button', {name: '版本資料'}).click();
  finishOld();
  await expect(catalog.getByRole('alert')).toContainText('原作閱讀資料暫時無法載入');
  await expect(catalog).not.toContainText('閱讀《我的第一間商店》');
  await expect(catalog.getByRole('heading', {name: '線上商店', exact: true})).toBeVisible();
  await catalog.getByRole('button', {name: '重讀閱讀資料'}).click();
  await expect(catalog.getByRole('link', {name: '閱讀《供應端工作台》原作 ↗'})).toHaveAttribute('href', original.upstream_url);
  await expect(catalog).toContainText('閱讀版本未提供');
  await expect(catalog).not.toContainText('可攜營業版本：');
  expect(reads).toBe(3);
});
