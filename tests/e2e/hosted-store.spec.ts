import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import type {Pool} from 'pg';
import {test, expect, type Page, type Locator, type TestInfo} from './fixtures.js';
import {navigate, signOut} from './navigation.js';
import {DEMO_COMMUNITY, DEMO_PASSWORD} from '../../packages/testing/seed.js';
import {hashPassword} from '../../modules/identity-membership/service.js';
import {formatMinor} from '../../apps/portal-web/src/format.js';
import {CreateResultSchema} from '../../contracts/guild-launchpad/v1/tenant.js';
import {InstallationViewSchema, LaunchPlanSchema, RegistryOperationSchema} from '../../contracts/guild-launchpad/v1/module-registry.js';
import {StoreViewSchema, ProductViewSchema} from '../../contracts/guild-launchpad/v1/storefront.js';

const commerce = 'guild_commerce_sales';
const production = 'guild_commercial_production';
const notice = '店鋪／商品展示已就緒，交易尚未啟用';
const primary = (page: Page) => page.getByRole('region', {name: '主要動作', exact: true});
const flow = (page: Page) => page.getByRole('region', {name: '啟動應用', exact: true});
const storePage = (page: Page) => page.locator('.hosted-store');
const slugFor = () => 'Island-' + randomUUID().replaceAll('-', '').slice(0, 8).replace(/[0-9]/g, digit => String.fromCharCode(97 + Number(digit)));
async function person(db: Pool) {
  const id = randomUUID(), email = `store-${id}@example.test`;
  await db.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,onboarding_required)
    VALUES($1,$2,$3,'商店測試會員',$4,$5,false)`, [id, DEMO_COMMUNITY, email, hashPassword(DEMO_PASSWORD), randomUUID()]);
  for (const key of [commerce, production]) await db.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier)
    VALUES($1,$2,$3,$4,'active','full')`, [randomUUID(), DEMO_COMMUNITY, id, key]);
  await db.query('INSERT INTO guild_member_preferences(community_id,user_id,primary_guild_key) VALUES($1,$2,$3)', [DEMO_COMMUNITY, id, commerce]);
  return {id, email};
}
async function login(page: Page, email: string) {
  await page.route(url => !['127.0.0.1', 'localhost'].includes(url.hostname), route => route.abort());
  await page.goto('/');
  await page.getByLabel('電子郵件', {exact: true}).fill(email);
  await page.getByLabel('密碼', {exact: true}).fill(DEMO_PASSWORD);
  await page.getByRole('button', {name: '登入', exact: true}).click();
  await expect(page.getByRole('button', {name: '設定', exact: true})).toBeVisible();
}
async function open(page: Page, hash: string) {
  await page.evaluate(value => {window.location.hash = value;}, hash);
  if (hash.startsWith('guilds/')) await expect(page.locator('.guild-launchpad > .guild-launchpad-block')).toHaveCount(7);
  else await expect(storePage(page)).toBeVisible();
}
async function post(page: Page, path: string, body: unknown, status: number, version?: string) {
  const session = await (await page.request.get('/api/v1/session')).json();
  const response = await page.request.post(`/api/v1${path}`, {data: body, headers: {
    Origin: new URL(page.url()).origin, 'X-CSRF-Token': session.csrf_token, 'Idempotency-Key': randomUUID(), ...(version ? {'If-Match': `"${version}"`} : {}),
  }});
  const result = await response.json(); expect(response.status(), JSON.stringify(result)).toBe(status); return result;
}
async function launchStore(page: Page, name: string) {
  const space = CreateResultSchema.parse(await post(page, '/tenants', {display_name: name}, 201));
  const tenant = space.tenant.tenant_id;
  const plan = LaunchPlanSchema.parse(await post(page, `/tenants/${tenant}/application-launch-plans`, {
    guild_key: commerce, workspace_id: space.workspace.workspace_id, application_key: 'hosted-store', release_ref: 'hosted-store@1.0.0',
    installation_choice: 'create_new', dependencies: [{requirement_key: 'storefront', choice: 'create', configuration: {}}], configuration: {},
  }, 201));
  const operation = RegistryOperationSchema.parse(await post(page, `/tenants/${tenant}/application-installations`, {
    plan_id: plan.plan_id, expected_plan_version: plan.version, configuration_digest: plan.configuration_digest,
  }, 200));
  expect(operation.state).toBe('succeeded');
  const installation = InstallationViewSchema.parse(await (await page.request.get(`/api/v1/tenants/${tenant}/application-installations/by-operation/${operation.operation_id}`)).json());
  const instance = installation.modules.find(link => link.requirement_key === 'storefront')!.instance_id;
  return {root: `/tenants/${tenant}/storefronts/${instance}`, hash: `stores/${tenant}/${instance}`};
}
async function addProduct(page: Page, title: string, price: string, stock = '0') {
  const form = page.getByRole('form', {name: '新增商品', exact: true});
  await form.getByLabel('商品名稱', {exact: true}).fill(title);
  await form.getByLabel('價格（新臺幣 TWD）', {exact: true}).fill(price);
  await form.getByLabel('庫存', {exact: true}).fill(stock);
  await form.getByRole('button', {name: '新增商品', exact: true}).click();
  await expect(form.getByLabel('商品名稱', {exact: true})).toHaveValue('');
  await expect(storePage(page).getByRole('status')).toContainText('已新增商品。');
  await expect(storePage(page).getByRole('status')).toBeFocused();
}

test('a commerce member opens, stocks, publishes and re-enters their own store', async ({page, browser, baseURL, e2eAuthPool}) => {
  const member = await person(e2eAuthPool), slug = slugFor();
  await login(page, member.email);
  await open(page, `guilds/${commerce}`);
  await expect(primary(page).getByRole('heading')).toHaveText('線上商店');
  await expect(primary(page).getByRole('button', {name: '建立我的商店', exact: true})).toBeEnabled();
  await open(page, `guilds/${production}`);
  await expect(primary(page).getByRole('heading')).toHaveText('拍攝brief／分鏡／交付');
  await open(page, `guilds/${commerce}`);
  await primary(page).getByRole('button', {name: '建立我的商店', exact: true}).click();
  await expect(flow(page)).toContainText('你還沒有業務空間。');
  await flow(page).getByLabel('業務空間名稱', {exact: true}).fill('小島選物工作室');
  await flow(page).getByRole('button', {name: '建立業務空間', exact: true}).click();
  await expect(flow(page)).toContainText('目前業務空間：小島選物工作室');
  await expect(flow(page).getByRole('group', {name: '工作區', exact: true}).getByRole('button', {name: '小島選物工作室', exact: true})).toHaveAttribute('aria-current', 'true');
  await flow(page).getByRole('button', {name: '產生啟動方案', exact: true}).click();
  await flow(page).getByRole('button', {name: '確認啟動', exact: true}).click();
  await expect(flow(page)).toContainText('已啟用');
  await flow(page).getByRole('button', {name: '設定我的商店', exact: true}).click();
  await expect(page).toHaveURL(/#stores\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
  const hash = new URL(page.url()).hash;
  const setup = page.getByRole('form', {name: '建立商店', exact: true});
  await setup.getByLabel('商店名稱', {exact: true}).fill('小島選物');
  await setup.getByLabel('品牌（選填）', {exact: true}).fill('Island Picks');
  await setup.getByLabel('商店介紹', {exact: true}).fill('小島上的選物\n每天用得到的手作器物');
  await setup.getByLabel('商店網址', {exact: true}).fill(slug);
  await expect(setup.getByText(`可以使用：/shops/${slug.toLowerCase()}`, {exact: true})).toBeVisible();
  await setup.getByRole('button', {name: '建立商店', exact: true}).click();
  await expect(storePage(page).getByRole('note').first()).toHaveText(notice);
  await addProduct(page, '手工茶杯', '350', '5');
  await addProduct(page, '麻布杯墊', '120.5');
  const product = storePage(page).locator('.hosted-store-product').filter({has: page.getByRole('heading', {name: '麻布杯墊', exact: true})});
  await product.getByRole('button', {name: '編輯', exact: true}).click();
  const edit = page.getByRole('form', {name: '編輯麻布杯墊', exact: true});
  await edit.getByLabel('商品名稱', {exact: true}).fill('亞麻杯墊');
  await edit.getByRole('button', {name: '儲存', exact: true}).click();
  await expect(storePage(page).getByRole('status')).toContainText('已儲存。');
  const prices = [formatMinor(35000, 'TWD'), formatMinor(12050, 'TWD')];
  const list = storePage(page).locator('.hosted-store-products');
  await expect(list).toContainText('手工茶杯'); await expect(list).toContainText('亞麻杯墊');
  for (const price of prices) await expect(list).toContainText(price);
  const preview = page.getByRole('region', {name: '展示頁預覽', exact: true});
  await expect(preview).toContainText('手工茶杯'); await expect(preview).toContainText('亞麻杯墊');
  await storePage(page).getByRole('button', {name: '發布展示頁', exact: true}).click();
  await expect(storePage(page).getByRole('status')).toContainText('已發布・第 1 版');
  await expect(storePage(page).getByRole('link', {name: `查看公開頁：/shops/${slug.toLowerCase()}`, exact: true})).toBeVisible();
  const anonymous = await browser.newContext({baseURL});
  try {
    const pub = await anonymous.newPage(); await pub.goto(`/shops/${slug.toLowerCase()}`);
    await expect(pub.getByRole('heading', {level: 1})).toHaveText('小島選物');
    await expect(pub.getByRole('note')).toHaveText(notice);
    for (const title of ['手工茶杯', '亞麻杯墊']) await expect(pub.getByRole('heading', {name: title, exact: true})).toBeVisible();
    for (const price of prices) await expect(pub.getByText(price, {exact: true})).toBeVisible();
    for (const selector of ['form', 'button', 'script', 'input']) await expect(pub.locator(selector)).toHaveCount(0);
    await expect(pub.locator('body')).not.toContainText(/購買|加入購物車|結帳|下單/);
  } finally {await anonymous.close();}
  await signOut(page); await login(page, member.email); await open(page, `guilds/${commerce}`);
  await expect(primary(page)).toContainText('小島選物・已發布');
  const applications = page.locator('.guild-launchpad-block').filter({has: page.getByRole('heading', {level: 2, name: '應用', exact: true})});
  const storeCard = applications.locator('.application-card').filter({has: page.getByRole('heading', {name: '線上商店', exact: true})});
  await storeCard.getByRole('button', {name: '啟動應用', exact: true}).click();
  const space = flow(page).getByRole('group', {name: '業務空間', exact: true}).getByRole('button', {name: /^小島選物工作室・/});
  await expect(space).toBeVisible();
  if (await space.getAttribute('aria-current') !== 'true') await space.click();
  await expect(space).toHaveAttribute('aria-current', 'true');
  const workspace = flow(page).getByRole('group', {name: '工作區', exact: true}).getByRole('button', {name: '小島選物工作室', exact: true});
  await expect(workspace).toBeVisible();
  if (await workspace.getAttribute('aria-current') !== 'true') await workspace.click();
  await expect(workspace).toHaveAttribute('aria-current', 'true');
  await expect(flow(page).getByRole('radio', {name: '另建獨立空白的商店', exact: true})).toBeDisabled();
  await expect(flow(page).getByText('這個業務空間已經有商店，請沿用它。', {exact: true})).toBeVisible();
  await expect(flow(page)).not.toContainText('新實例不複製既有資料，會使用額外容量。');
  await expect(flow(page).getByRole('radio', {name: /^將共用既有的商店（ID 尾碼 /})).toBeVisible();
  await flow(page).getByRole('button', {name: '取消', exact: true}).click();
  await expect(flow(page)).toHaveCount(0);
  await primary(page).getByRole('button', {name: '進入我的商店', exact: true}).click();
  await expect(page).toHaveURL(new RegExp(hash + '$'));
  await expect(storePage(page).getByRole('heading', {level: 2})).toHaveText('小島選物');
  await expect(storePage(page).locator('.hosted-store-product')).toHaveCount(2);
  await navigate(page, '我的商店');
  await expect(storePage(page).locator('article.card')).toHaveCount(1);
  await expect(storePage(page).getByRole('link', {name: '進入我的商店', exact: true})).toHaveAttribute('href', hash);
  const otherMember = await person(e2eAuthPool), other = await browser.newContext({baseURL});
  try {
    const otherPage = await other.newPage(); await login(otherPage, otherMember.email); await open(otherPage, 'stores');
    await expect(storePage(otherPage)).toContainText('你還沒有商店。');
    await open(otherPage, hash); await expect(storePage(otherPage)).toContainText('找不到這間商店。');
    await expect(storePage(otherPage).getByRole('link', {name: '返回我的商店', exact: true})).toBeVisible();
  } finally {await other.close();}
});
async function theme(page: Page, value: string) {
  await page.evaluate(next => {localStorage.setItem('freedom-theme', next); document.documentElement.dataset.theme = next;
    document.documentElement.dataset.experienceProfile = next; window.dispatchEvent(new Event('freedom-theme-changed'));}, value);
}
async function capture(page: Page, container: Locator, name: string, width: number, testInfo: TestInfo) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const boxes = await container.evaluate(element => ({width: element.getBoundingClientRect().width,
    buttons: [...element.querySelectorAll('.btn')].map(button => ({text: button.textContent?.trim(), width: button.getBoundingClientRect().width,
      height: button.getBoundingClientRect().height, container: button.parentElement!.getBoundingClientRect().width})),
    overflow: [...element.querySelectorAll('*')].filter(child => {const r = child.getBoundingClientRect(); return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1);}).map(child => child.tagName),
  }));
  expect(boxes.overflow).toEqual([]);
  for (const box of boxes.buttons) {expect(box.width).toBeLessThanOrEqual(box.container); expect(box.height).toBeGreaterThanOrEqual(44); if (width === 1280) expect(box.width).toBeLessThan(boxes.width / 2);}
  await writeFile(testInfo.outputPath(`${name}-buttons.json`), JSON.stringify(boxes, null, 2));
  await page.screenshot({path: testInfo.outputPath(`${name}.png`), fullPage: true});
}
test('store pages stay readable in every theme and width', async ({page, browser, baseURL, e2eAuthPool}, testInfo) => {
  const member = await person(e2eAuthPool); await login(page, member.email); await page.emulateMedia({reducedMotion: 'reduce'});
  await open(page, `guilds/${commerce}`); await primary(page).getByRole('button', {name: '建立我的商店', exact: true}).click();
  await expect(flow(page).getByLabel('業務空間名稱', {exact: true})).toBeVisible();
  for (const mode of ['light', 'dark']) {await theme(page, mode); for (const width of [360, 1280]) {
    await page.setViewportSize({width, height: 900}); await capture(page, flow(page), `launch-space-${mode}-${width}`, width, testInfo);
  }}
  await flow(page).getByRole('button', {name: '取消', exact: true}).click();
  const ready = await launchStore(page, '小島選物工作室'), setup = await launchStore(page, '第二選物工作室');
  const slug = slugFor().toLowerCase();
  const created = StoreViewSchema.parse(await post(page, ready.root + '/setup', {name: '小島選物', brand: 'Island Picks', description: '小島上的選物\n每天用得到的手作器物', slug, currency: 'TWD'}, 201));
  for (const product of [{title: '手工茶杯', price_minor: 35000, stock: 5}, {title: '亞麻杯墊', price_minor: 12050, stock: 0}]) ProductViewSchema.parse(await post(page, ready.root + '/products', {...product, description: '一件日常器物'}, 201));
  StoreViewSchema.parse(await post(page, ready.root + '/publish', {}, 200, created.version!));
  for (const mode of ['light', 'dark']) {await theme(page, mode); for (const width of [360, 768, 1280]) {
    await page.setViewportSize({width, height: 900});
    await open(page, ready.hash); await expect(storePage(page)).toContainText('已發布・第 1 版'); await expect(storePage(page).locator('.hosted-store-product')).toHaveCount(2);
    await capture(page, storePage(page), `store-ready-${mode}-${width}`, width, testInfo);
    await open(page, setup.hash); await expect(page.getByRole('form', {name: '建立商店', exact: true})).toBeVisible();
    await capture(page, storePage(page), `store-setup-${mode}-${width}`, width, testInfo);
  }}
  const anonymous = await browser.newContext({baseURL});
  try {const pub = await anonymous.newPage(); for (const width of [360, 1280]) {
    await pub.setViewportSize({width, height: 900}); await pub.goto(`/shops/${slug}`); await expect(pub.getByRole('heading', {level: 1})).toHaveText('小島選物');
    expect(await pub.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await pub.screenshot({path: testInfo.outputPath(`store-public-${width}.png`), fullPage: true});
  }} finally {await anonymous.close();}
  // A store can disappear after entry; a slug read must also use the uniform missing state.
  await page.route('**/api/v1' + setup.root + '/slug-availability?*', route => route.fulfill({status: 404, contentType: 'application/problem+json', json: {code: 'not_found', detail: '找不到這間商店。'}}));
  await page.getByRole('form', {name: '建立商店', exact: true}).getByLabel('商店網址', {exact: true}).fill('lost-store');
  await expect(storePage(page)).toContainText('找不到這間商店。');
  await expect(page.getByRole('form', {name: '建立商店', exact: true})).toHaveCount(0);
});

test('unsaved store settings survive publication controls until saved', async ({page, e2eAuthPool}, testInfo) => {
  const member = await person(e2eAuthPool); await login(page, member.email);
  const ready = await launchStore(page, '草稿保護工作室');
  const originalSlug = slugFor().toLowerCase(), nextSlug = slugFor().toLowerCase();
  await post(page, ready.root + '/setup', {name: '原商店名稱', description: '原介紹', slug: originalSlug, currency: 'TWD'}, 201);
  await post(page, ready.root + '/products', {title: '茶杯', price_minor: 35000, stock: 1, description: ''}, 201);
  await open(page, ready.hash);
  const settings = page.getByRole('form', {name: '商店資料', exact: true});
  await settings.getByLabel('商店名稱', {exact: true}).fill('尚未儲存的新名稱');
  await settings.getByRole('textbox', {name: '商店介紹', exact: true}).fill('尚未儲存的新介紹');
  await settings.getByLabel('商店網址', {exact: true}).fill(nextSlug);
  const publish = storePage(page).getByRole('button', {name: '發布展示頁', exact: true});
  await expect(publish).toBeDisabled();
  const publication = page.getByRole('region', {name: '預覽與發布', exact: true});
  await expect(publication).toContainText('還有尚未儲存的內容。');
  for (const mode of ['light', 'dark']) {await theme(page, mode); for (const width of [360, 1280]) {
    await page.setViewportSize({width, height: 900});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await publication.screenshot({path: testInfo.outputPath(`store-draft-${mode}-${width}.png`)});
  }}
  await expect(settings.getByLabel('商店名稱', {exact: true})).toHaveValue('尚未儲存的新名稱');
  await expect(settings.getByRole('textbox', {name: '商店介紹', exact: true})).toHaveValue('尚未儲存的新介紹');
  await expect(settings.getByLabel('商店網址', {exact: true})).toHaveValue(nextSlug);
  await settings.getByRole('button', {name: '儲存商店資料', exact: true}).click();
  await expect(publish).toBeEnabled();
  await publish.click();
  await expect(storePage(page).getByRole('status')).toContainText('已發布・第 1 版');
  const publicPage = await page.request.get(`/shops/${nextSlug}`);
  expect(publicPage.status()).toBe(200);
  const publicHtml = await publicPage.text();
  expect(publicHtml).toContain('尚未儲存的新名稱');
  expect(publicHtml).toContain('尚未儲存的新介紹');
  expect((await page.request.get(`/shops/${originalSlug}`)).status()).toBe(404);
  await settings.getByLabel('商店名稱', {exact: true}).fill('停止公開前的草稿');
  const unpublish = storePage(page).getByRole('button', {name: '停止公開', exact: true});
  await expect(unpublish).toBeDisabled();
  await expect(settings.getByLabel('商店名稱', {exact: true})).toHaveValue('停止公開前的草稿');
  await settings.getByRole('button', {name: '儲存商店資料', exact: true}).click();
  await expect(unpublish).toBeEnabled();
  page.once('dialog', dialog => dialog.accept());
  await unpublish.click();
  await expect(storePage(page).getByRole('status')).toContainText('已停止公開');
  await expect(settings.getByLabel('商店名稱', {exact: true})).toHaveValue('停止公開前的草稿');
});

test('store drafts ask before main navigation and retain edits when leaving is declined', async ({page, e2eAuthPool}) => {
  const member = await person(e2eAuthPool); await login(page, member.email);
  const ready = await launchStore(page, '導覽草稿工作室');
  await post(page, ready.root + '/setup', {name: '導覽商店', description: '', slug: slugFor().toLowerCase(), currency: 'TWD'}, 201);
  await open(page, ready.hash);
  const settings = page.getByRole('form', {name: '商店資料', exact: true});
  await settings.getByLabel('商店名稱', {exact: true}).fill('留下這份草稿');
  let prompts = 0, allowLeave = false;
  page.on('dialog', async dialog => {prompts++; expect(dialog.message()).toBe('還有尚未儲存的內容，要離開嗎？'); if (allowLeave) await dialog.accept(); else await dialog.dismiss();});
  await navigate(page, '職業公會');
  await expect(page).toHaveURL(new RegExp('#' + ready.hash + '$'));
  await expect(settings.getByLabel('商店名稱', {exact: true})).toHaveValue('留下這份草稿');
  expect(prompts).toBe(1);
  await page.evaluate(() => {window.location.hash = 'home';});
  await expect.poll(() => prompts).toBe(2);
  await expect(page).toHaveURL(new RegExp('#' + ready.hash + '$'));
  await expect(settings.getByLabel('商店名稱', {exact: true})).toHaveValue('留下這份草稿');
  allowLeave = true;
  await navigate(page, '職業公會');
  await expect(page).toHaveURL(/#guilds$/);
  await expect(settings).toHaveCount(0);
  expect(prompts).toBe(3);
  await open(page, ready.hash);
  await expect(settings.getByLabel('商店名稱', {exact: true})).toHaveValue('導覽商店');
});

for (const width of [1280, 360]) test(`pending and unknown store writes keep their retry across navigation at ${width}px`, async ({page, e2eAuthPool}, testInfo) => {
  await page.setViewportSize({width, height: 900});
  const member = await person(e2eAuthPool); await login(page, member.email);
  const ready = await launchStore(page, '操作確認工作室');
  await post(page, ready.root + '/setup', {name: '操作確認商店', description: '', slug: slugFor().toLowerCase(), currency: 'TWD'}, 201);
  await open(page, ready.hash);
  const form = page.getByRole('form', {name: '新增商品', exact: true});
  const status = storePage(page).getByRole('status');
  const title = '只建立一次的茶杯';
  const requests: {key: string | undefined; body: string | null}[] = [];
  const productIds: string[] = [];
  let releaseResponse!: () => void;
  const responseGate = new Promise<void>(resolve => {releaseResponse = resolve;});
  let committed = false, prompts = 0;
  // Accepting any draft prompt must not allow an unresolved operation to unmount.
  page.on('dialog', async dialog => {prompts++; await dialog.accept();});
  await page.route('**/api/v1' + ready.root + '/products', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    requests.push({key: route.request().headers()['idempotency-key'], body: route.request().postData()});
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    productIds.push(ProductViewSchema.parse(await response.json()).product_id);
    if (requests.length === 1) {
      committed = true;
      await responseGate;
      // The database committed, but the client cannot validate this damaged success.
      await route.fulfill({response, json: {}});
    } else await route.fulfill({response});
  });
  const savedProducts = async () => (await e2eAuthPool.query(`SELECT i.item_id FROM commerce_items i
    JOIN commerce_storefront_profiles p ON p.supply_shop_id=i.shop_id
    WHERE p.instance_id=$1 AND i.title=$2`, [ready.hash.split('/')[2], title])).rows;
  const stays = async (message: string) => {
    await expect(status).toContainText(message);
    await expect(page).toHaveURL(new RegExp('#' + ready.hash + '$'));
    await expect(form.getByLabel('商品名稱', {exact: true})).toHaveValue(title);
    expect(prompts).toBe(0);
  };
  const attemptNavigation = async (message: string) => {
    // Use an actual history traversal; seed an earlier distinct entry without leaving the store.
    await page.evaluate(hash => {
      history.replaceState(null, '', '#home');
      history.pushState(null, '', '#' + hash);
    }, ready.hash);
    await page.goBack();
    await stays(message);
    await navigate(page, '職業公會');
    await stays(message);
    await storePage(page).getByRole('link', {name: '返回我的商店', exact: true}).click();
    await stays(message);
    await page.evaluate(() => {window.location.hash = 'home';});
    await stays(message);
    const settings = page.getByRole('button', {name: '設定', exact: true});
    if (await settings.getAttribute('aria-expanded') !== 'true') await settings.click();
    await page.getByRole('menu', {name: '個人檔案'}).getByRole('menuitem', {name: '登出', exact: true}).click();
    await stays(message);
    await expect(page.getByRole('heading', {name: '登入', exact: true})).toHaveCount(0);
  };
  try {
    await form.getByLabel('商品名稱', {exact: true}).fill(title);
    await form.getByLabel('價格（新臺幣 TWD）', {exact: true}).fill('350');
    await form.getByLabel('庫存', {exact: true}).fill('1');
    await form.getByRole('button', {name: '新增商品', exact: true}).click();
    await expect.poll(() => committed).toBe(true);
    expect(await savedProducts()).toHaveLength(1);
    await attemptNavigation('正在確認原操作，請等候完成後再離開。');
    releaseResponse();
    const retry = storePage(page).getByRole('button', {name: '重試', exact: true});
    await expect(retry).toBeEnabled();
    await attemptNavigation('尚未確認原操作的結果，請按「重試」確認後再離開。');
    await storePage(page).screenshot({path: testInfo.outputPath(`store-unknown-operation-${width}.png`)});
    expect(await savedProducts()).toHaveLength(1);
    await retry.click();
    await expect(status).toContainText('已新增商品。');
    await expect(form.getByLabel('商品名稱', {exact: true})).toHaveValue('');
    expect(requests).toHaveLength(2);
    expect(requests[0].key).toBeTruthy();
    expect(requests[1]).toEqual(requests[0]);
    expect(productIds).toHaveLength(2);
    expect(productIds[1]).toBe(productIds[0]);
    expect(await savedProducts()).toEqual([{item_id: productIds[0]}]);
    await navigate(page, '職業公會');
    await expect(page).toHaveURL(/#guilds$/);
    await expect(form).toHaveCount(0);
    expect(prompts).toBe(0);
  } finally {releaseResponse();}
});
