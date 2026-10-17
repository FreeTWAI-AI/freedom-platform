import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {test, expect, type Page} from './member-feature-fixture.js';
import {DEMO_COMMUNITY, DEMO_PASSWORD} from '../../packages/testing/seed.js';
import {hashPassword} from '../../modules/identity-membership/service.js';
import {person, login, open, post, launchStore, storeArea} from './hosted-store-fixture.js';
import {buyerLogin, offListener} from './hosted-order-fixture.js';
import {signOut} from './navigation.js';
import {SupplierReservationPageSchema} from '../../contracts/guild-launchpad/v1/hosted-shared-order.js';

test.use({memberFeatures: {guildLaunchpadEnabled: true, hostedReservationsEnabled: true, supplierConsoleEnabled: true}});

const supplierGuild = 'guild_product_quality_supply';

async function supplyPerson(db: Pool) {
  const id = randomUUID(), email = `supply-${id}@example.test`;
  await db.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,onboarding_required)
    VALUES($1,$2,$3,'純供貨測試會員',$4,$5,false)`, [id, DEMO_COMMUNITY, email, hashPassword(DEMO_PASSWORD), randomUUID()]);
  await db.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier)
    VALUES($1,$2,$3,$4,'active','full')`, [randomUUID(), DEMO_COMMUNITY, id, supplierGuild]);
  await db.query('INSERT INTO guild_member_preferences(community_id,user_id,primary_guild_key) VALUES($1,$2,$3)', [DEMO_COMMUNITY, id, supplierGuild]);
  return {id, email};
}

async function expandSellerSection(page: Page, label: string) {
  if (await page.getByRole('navigation', {name: '商店工作區', exact: true}).count()) await storeArea(page, '供貨合作');
  const section = page.locator('.hosted-distribution details').filter({has: page.locator('summary').filter({hasText: label})});
  if (await section.getAttribute('open') === null) await section.locator('summary').click();
  return section;
}

async function assertConsoleWording(page: Page) {
  const consoleRoot = page.locator('.supplier-console');
  await expect(consoleRoot).toBeVisible();
  expect(await consoleRoot.innerText()).not.toMatch(/(營收|佣金|利潤|收入)\s*[:：]?\s*[$＄NT]*\s*\d/);
}

async function captureConsoleWidths(page: Page, info: {outputPath: (...segments: string[]) => string}, prefix: string) {
  for (const width of [1440, 390]) {
    await page.setViewportSize({width, height: 900});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({path: info.outputPath(`${prefix}-${width}.png`), fullPage: true});
  }
  await page.setViewportSize({width: 1440, height: 900});
}

test('SC-E2E-01 supply-only supplier completes the S1 journey from the guild to a fresh login (AT-01,02,05,12,22,31,39,42)', async ({browser, baseURL, e2eAuthPool}, info) => {
  test.setTimeout(180_000);
  const suffix = randomUUID().slice(0, 6);
  const catalogName = `山林供貨商品庫 ${suffix}`;
  const productTitle = `手沖濾杯組 ${suffix}`;
  const productDesc = '陶瓷濾杯與手沖壺組合，適合咖啡選品店。';
  const bStoreName = `海風選物店 ${suffix}`;
  const bSlug = `seller-b-${suffix}-${randomUUID().slice(0, 4)}`;
  const otherTitle = `賣家自有馬克杯 ${suffix}`;

  const supplier = await supplyPerson(e2eAuthPool);
  const retailer = await person(e2eAuthPool);
  const buyer = await person(e2eAuthPool);
  const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext({baseURL})));

  try {
    const [a, b, customer] = await Promise.all(contexts.map(ctx => ctx.newPage()));

    // Prepare B's retail store with its own product and open 30-minute reservations in its store UI.
    await login(b, retailer.email);
    const bStore = await launchStore(b, `海風零售空間 ${suffix}`);
    await post(b, bStore.root + '/setup', {name: bStoreName, slug: bSlug, currency: 'TWD'}, 201);
    await post(b, bStore.root + '/products', {title: otherTitle, price_minor: 9000, stock: 5}, 201);
    await open(b, bStore.hash);
    await b.getByRole('button', {name: '開放 30 分鐘預留', exact: true}).click();
    await expect(b.getByRole('button', {name: '停止接受新預留', exact: true})).toBeEnabled();

    // Step 1: A starts from the supplier guild and creates the supply-only catalog in the console. (AT-01)
    await login(a, supplier.email);
    await open(a, `guilds/${supplierGuild}`);
    const primary = a.getByRole('region', {name: '主要動作', exact: true});
    await expect(primary).toBeVisible();
    await primary.getByRole('button', {name: '開始供貨設定', exact: true}).click();
    const flow = a.getByRole('region', {name: '啟動應用', exact: true});
    await flow.getByLabel('業務空間名稱', {exact: true}).fill(`山林供應空間 ${suffix}`);
    await flow.getByRole('button', {name: '建立業務空間', exact: true}).click();
    await flow.getByRole('button', {name: '產生啟動方案', exact: true}).click();
    await flow.getByRole('button', {name: '確認啟動', exact: true}).click();
    await flow.getByRole('button', {name: '設定供貨資料', exact: true}).click();

    await expect(a).toHaveURL(/#stores\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/supply$/);
    const supplyMatch = new URL(a.url()).hash.match(/^#stores\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/supply$/);
    expect(supplyMatch).not.toBeNull();
    const [, tenantId, instanceId] = supplyMatch!;
    const aRoot = `/tenants/${tenantId}/storefronts/${instanceId}`;
    const storePrefix = `stores/${tenantId}/${instanceId}`;

    const consoleRoot = a.locator('.supplier-console');
    const activeView = consoleRoot.locator('[data-sc-active="true"]');
    await expect(consoleRoot).toBeVisible();
    await expect(consoleRoot.getByText('請先完成商品庫設定，其他頁面暫時停用。', {exact: true})).toBeVisible();
    const nav = a.getByRole('navigation', {name: '營運中心', exact: true});
    await expect(nav.getByRole('link')).toHaveCount(0);
    // Before setup every page this member may use is listed but disabled. 預留與訂單 is absent: the owner check runs after setup.
    await expect(nav.locator('[aria-disabled="true"]')).toHaveText([
      '營運概覽',
      '商品與庫存',
      '合作店家',
      '供貨條件與審核',
      '行銷素材',
      '營運報表',
      '設定與資料',
    ]);
    await expect(consoleRoot.locator('form')).toHaveCount(1);
    const setupForm = a.getByRole('form', {name: '建立供貨商品庫', exact: true});
    await expect(setupForm).toBeVisible();
    await expect(a.getByLabel('商店網址')).toHaveCount(0);
    await assertConsoleWording(a);

    await setupForm.getByLabel('商品庫名稱', {exact: true}).fill(catalogName);
    await setupForm.getByLabel('說明', {exact: true}).fill('山林純供貨商品庫說明');
    await setupForm.getByRole('button', {name: '建立供貨商品庫', exact: true}).click();

    await expect(a.getByRole('heading', {level: 1, name: '營運概覽', exact: true})).toBeVisible();
    await expect(consoleRoot.locator('.sc-business-bar')).toContainText(catalogName);
    await expect(consoleRoot.locator('.sc-business-bar .badge')).toHaveText('純供貨');
    await expect(consoleRoot.locator('.sc-business-bar').getByRole('link', {name: '前往商店', exact: true})).toHaveCount(0);

    // Step 2: Overview metrics are ready zeros, no todo, first step to add a product is available. (AT-39)
    const metricCards = consoleRoot.locator('.sc-metrics article');
    await expect(metricCards).toHaveCount(4);
    for (const metricName of ['公開供貨商品', '待確認售價申請', '有效供貨預留行項', '缺貨商品']) {
      const card = metricCards.filter({has: a.getByRole('heading', {level: 3, name: metricName, exact: true})});
      await expect(card.locator('.sc-metric-value')).toHaveText('0');
    }
    await expect(consoleRoot.getByText('目前沒有待辦。', {exact: true})).toBeVisible();
    await assertConsoleWording(a);
    await captureConsoleWidths(a, info, 'step2-overview');

    const firstAddProductLink = consoleRoot.locator('.sc-content').getByRole('link', {name: '新增商品', exact: true});
    await expect(firstAddProductLink).toBeVisible();
    await firstAddProductLink.click();

    // Step 3: New product form -> submit -> product detail -> reload reads back equal values & 供貨單價 label. (AT-05)
    await expect(a.getByRole('heading', {level: 1, name: '新增商品', exact: true})).toBeVisible();
    const newProductForm = a.getByRole('form', {name: '新增商品', exact: true});
    await newProductForm.getByLabel('商品名稱', {exact: true}).fill(productTitle);
    await newProductForm.getByLabel('說明', {exact: true}).fill(productDesc);
    await newProductForm.getByLabel('供貨單價', {exact: true}).fill('150');
    await newProductForm.getByLabel('庫存', {exact: true}).fill('10');
    await assertConsoleWording(a);
    await newProductForm.getByRole('button', {name: '新增商品', exact: true}).click();

    await expect(a.getByRole('heading', {level: 1, name: '商品詳情', exact: true})).toBeVisible();
    await expect(a.getByRole('heading', {level: 2, name: `商品詳情：${productTitle}`, exact: true})).toBeVisible();
    const productMatch = new URL(a.url()).hash.match(/\/supply\/products\/([0-9a-f-]{36})$/);
    expect(productMatch).not.toBeNull();
    const productId = productMatch![1];

    await a.reload();
    await expect(a.getByRole('heading', {level: 1, name: '商品詳情', exact: true})).toBeVisible();
    const contentForm = a.getByRole('form', {name: '儲存內容', exact: true});
    const stockForm = a.getByRole('form', {name: '儲存庫存', exact: true});
    const termsForm = a.getByRole('form', {name: '儲存供貨條件', exact: true});
    await expect(contentForm.getByLabel('商品名稱', {exact: true})).toHaveValue(productTitle);
    await expect(contentForm.getByRole('textbox', {name: '說明', exact: true})).toHaveValue(productDesc);
    await expect(stockForm.getByLabel('庫存', {exact: true})).toHaveValue('10');
    await expect(termsForm.getByLabel('供貨單價', {exact: true})).toHaveValue('150.00');
    await assertConsoleWording(a);

    // Step 4: Photo section says photos are not enabled in this environment (real upload is D3's photo-pass case).
    const photoSection = consoleRoot.locator('.sc-section').filter({has: a.getByRole('heading', {level: 3, name: '照片', exact: true})});
    await expect(photoSection.getByText('這個環境未開放商品照片。', {exact: true})).toBeVisible();

    // Step 5: Save supply terms -> publish supply offer via confirmation dialog -> overview metric shows 1. (AT-05)
    await termsForm.getByLabel('每件運費', {exact: true}).fill('20');
    await termsForm.getByRole('textbox', {name: '出貨條件', exact: true}).fill('確認訂單後三個工作日內寄出');
    await termsForm.getByRole('textbox', {name: '退貨條件', exact: true}).fill('到貨七日內非人為瑕疵可退換');
    await termsForm.getByRole('button', {name: '儲存供貨條件', exact: true}).click();
    await expect(consoleRoot.locator('.sc-announcement')).toHaveText('已保存：儲存供貨條件。');

    const offerSection = consoleRoot.locator('.sc-section').filter({has: a.getByRole('heading', {level: 3, name: '供貨版本', exact: true})});
    await expect(offerSection.locator('.badge')).toHaveText('尚未公開');
    await offerSection.getByRole('button', {name: '公開供貨版本', exact: true}).click();
    const publishDialog = a.getByRole('dialog', {name: '公開供貨版本的影響', exact: true});
    await expect(publishDialog).toBeVisible();
    await expect(publishDialog).toContainText('目前版本：待確認 0 筆、可售 0 筆。');
    await publishDialog.getByRole('button', {name: '確認公開供貨版本', exact: true}).click();
    await expect(consoleRoot.locator('.sc-announcement')).toHaveText('已保存：公開供貨版本。');
    await expect(offerSection.locator('.badge')).toHaveText('公開中');
    await assertConsoleWording(a);

    await nav.getByRole('link', {name: '營運概覽', exact: true}).click();
    await expect(a.getByRole('heading', {level: 1, name: '營運概覽', exact: true})).toBeVisible();
    await activeView.getByRole('button', {name: '更新資料', exact: true}).click();
    const offeredMetric = metricCards.filter({has: a.getByRole('heading', {level: 3, name: '公開供貨商品', exact: true})});
    await expect(offeredMetric.locator('.sc-metric-value')).toHaveText('1');

    // Step 6: B selects A's published offer in its legacy store UI and submits retail price 220.
    await storeArea(b, '供貨合作');
    const catalogResponse = b.waitForResponse(r => new URL(r.url()).pathname === `/api/v1${bStore.root}/supply-catalog` && r.request().method() === 'GET');
    await b.getByRole('button', {name: '更新供貨狀態', exact: true}).click();
    expect((await catalogResponse).status()).toBe(200);
    const otherCatalog = await expandSellerSection(b, '選用其他商店');
    const offerArticle = otherCatalog.getByRole('article').filter({has: b.getByRole('heading', {name: `${productTitle}・${catalogName}`, exact: true})});
    await expect(offerArticle).toBeVisible();
    await offerArticle.getByRole('button', {name: '設定我的售價', exact: true}).click();
    await offerArticle.getByLabel('我的零售價（TWD）', {exact: true}).fill('220');
    await offerArticle.getByRole('button', {name: '送出供貨申請', exact: true}).click();
    await expect(b.locator('.hosted-store > [role="status"]')).toContainText('已送出選品');

    // Step 7: A refreshes overview -> opens pending price request -> reviews & accepts -> B publishes showcase. (AT-12, AT-31)
    await activeView.getByRole('button', {name: '更新資料', exact: true}).click();
    const pendingMetric = metricCards.filter({has: a.getByRole('heading', {level: 3, name: '待確認售價申請', exact: true})});
    await expect(pendingMetric.locator('.sc-metric-value')).toHaveText('1');
    const todoRow = consoleRoot.locator('.sc-list .sc-row').filter({hasText: productTitle});
    await expect(todoRow).toContainText(bStoreName);
    await expect(todoRow).toContainText('待確認售價申請');
    await todoRow.getByRole('link', {name: '審核', exact: true}).click();

    await expect(a).toHaveURL(/#stores\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/supply\/terms\/[0-9a-f-]{36}$/);
    await expect(a.getByRole('heading', {level: 1, name: '審核售價申請', exact: true})).toBeVisible();
    await expect(consoleRoot).toContainText(bStoreName);
    await expect(consoleRoot).toContainText('$220.00');
    await expect(consoleRoot).toContainText('$150.00');
    await expect(consoleRoot).toContainText('$20.00');
    await expect(consoleRoot).toContainText('每件價格差（售價 − 供貨單價 − 每件運費）：$50.00');
    await expect(consoleRoot.getByText('價格差屬於賣家的定價，不是你的佣金、收入或利潤。', {exact: true})).toBeVisible();
    await assertConsoleWording(a);
    await captureConsoleWidths(a, info, 'step7-review');

    await a.getByRole('button', {name: '同意', exact: true}).click();
    await expect(consoleRoot.locator('.sc-announcement')).toHaveText('已保存：同意售價申請。');
    await expect(activeView.locator('.badge')).toHaveText('可售');

    await storeArea(b, '供貨合作');
    await b.getByRole('button', {name: '更新供貨狀態', exact: true}).click();
    await storeArea(b, '店面與發布');
    const publishButton = b.getByRole('button', {name: '發布展示頁', exact: true});
    await expect(publishButton).toBeEnabled();
    await publishButton.click();
    await expect(b.locator('.hosted-store > [role="status"]')).toContainText('已發布');

    // Step 8: A opens Settings & Data and enables 30-minute reservations as owner.
    await nav.getByRole('link', {name: '設定與資料', exact: true}).click();
    await expect(a.getByRole('heading', {level: 1, name: '設定與資料', exact: true})).toBeVisible();
    await assertConsoleWording(a);
    const openReservationBtn = a.getByRole('button', {name: '開放 30 分鐘預留', exact: true});
    await expect(openReservationBtn).toBeEnabled();
    await openReservationBtn.click();
    await expect(a.getByRole('button', {name: '停止接受新預留', exact: true})).toBeEnabled();
    await expect(consoleRoot.locator('.sc-announcement')).toHaveText('已保存：開放 30 分鐘預留。');

    // Step 9: Buyer reserves 3 of A's supplied product (and 1 of B's own product) at B's public store.
    await login(customer, buyer.email);
    await customer.goto(`/#reservations/${bSlug}`);
    await customer.getByLabel(`${productTitle}數量`, {exact: true}).fill('3');
    await customer.getByLabel(`${otherTitle}數量`, {exact: true}).fill('1');
    await customer.getByRole('button', {name: '查看預留內容', exact: true}).click();
    await expect(customer.getByRole('region', {name: '確認預留內容'})).toContainText('非應付金額');
    await customer.getByRole('button', {name: '確認預留 30 分鐘', exact: true}).click();
    await expect(customer.getByRole('region', {name: '我的預留'})).toContainText('預留中');
    const orderId = await customer.getByLabel('預留編號', {exact: true}).inputValue();
    expect(orderId).toBeTruthy();

    // Step 10: A inspects Reservations & Orders, Products & Stock, and Overview. (AT-22, AT-31)
    await nav.getByRole('link', {name: '預留與訂單', exact: true}).click();
    await expect(a.getByRole('heading', {level: 1, name: '預留與訂單', exact: true})).toBeVisible();
    await expect(activeView.getByText('預留最多 30 分鐘，尚未付款或安排出貨；供貨金額不是請款或營收。', {exact: true})).toBeVisible();
    await expect(activeView.locator('.sc-read-status').filter({hasText: '資料時間'})).toBeVisible();
    const orderItem = activeView.locator('.sc-list > li').filter({hasText: orderId});
    await expect(orderItem).toContainText(bStoreName);
    await expect(orderItem.locator('.badge')).toHaveText('預留中');
    await expect(orderItem).toContainText(productTitle);
    await expect(orderItem).toContainText('3 × 供貨單價 $150.00 ＝ 小計 $450.00');
    await expect(activeView).not.toContainText(buyer.email);
    await expect(activeView).not.toContainText(otherTitle);
    await expect(activeView.getByRole('button', {name: /取消/})).toHaveCount(0);
    await assertConsoleWording(a);
    await captureConsoleWidths(a, info, 'step10-reservations');

    const supplierOrders = SupplierReservationPageSchema.parse(await (await a.request.get(`/api/v1${aRoot}/supply-reservations`)).json());
    expect(supplierOrders.items).toHaveLength(1);
    expect(supplierOrders.items[0].order_id).toBe(orderId);
    expect(supplierOrders.items[0].items.map(line => [line.title, line.quantity, line.unit_supply_price_minor, line.supply_total_minor])).toEqual([[productTitle, 3, 15000, 45000]]);
    expect(JSON.stringify(supplierOrders)).not.toContain(buyer.email);
    expect(JSON.stringify(supplierOrders)).not.toContain(otherTitle);

    await nav.getByRole('link', {name: '商品與庫存', exact: true}).click();
    await expect(a.getByRole('heading', {level: 1, name: '商品與庫存', exact: true})).toBeVisible();
    const productRow = activeView.locator('table.sc-products tbody tr').filter({hasText: productTitle});
    await expect(productRow).toContainText('10／3／7');
    await assertConsoleWording(a);

    await nav.getByRole('link', {name: '營運概覽', exact: true}).click();
    await expect(a.getByRole('heading', {level: 1, name: '營運概覽', exact: true})).toBeVisible();
    const activeLinesMetric = metricCards.filter({has: a.getByRole('heading', {level: 3, name: '有效供貨預留行項', exact: true})});
    await expect(activeLinesMetric.locator('.sc-metric-value')).toHaveText('1');

    // Step 11: Buyer cancels -> A refreshes Reservations & Orders -> stock released once.
    customer.once('dialog', dialog => dialog.accept());
    await customer.getByRole('button', {name: '取消預留', exact: true}).click();
    await expect(customer.getByRole('region', {name: '我的預留'})).toContainText('已取消');

    await nav.getByRole('link', {name: '預留與訂單', exact: true}).click();
    await expect(a.getByRole('heading', {level: 1, name: '預留與訂單', exact: true})).toBeVisible();
    await activeView.getByRole('button', {name: '更新資料', exact: true}).click();
    await expect(activeView.locator('.sc-list > li').filter({hasText: orderId}).locator('.badge')).toHaveText('已取消');

    await nav.getByRole('link', {name: '商品與庫存', exact: true}).click();
    await expect(activeView.locator('table.sc-products tbody tr').filter({hasText: productTitle})).toContainText('10／0／10');
    expect((await e2eAuthPool.query('SELECT stock,reserved FROM commerce_items WHERE title=$1', [productTitle])).rows).toEqual([{stock: 10, reserved: 0}]);

    // Step 12: A signs out and logs in again, then opens bookmark #<t/i>/supply/products?state=offered. (AT-02, AT-42)
    await signOut(a);
    await login(a, supplier.email);
    await a.goto(`/#${storePrefix}/supply/products?state=offered`);
    await expect(a.getByRole('heading', {level: 1, name: '商品與庫存', exact: true})).toBeVisible();
    await expect(consoleRoot.locator('.sc-business-bar')).toContainText(catalogName);
    await expect(a.getByRole('combobox', {name: '供貨狀態', exact: true})).toHaveValue('offered');
    const bookmarkedProductLink = activeView.locator('table.sc-products tbody tr').filter({hasText: productTitle}).getByRole('link');
    await expect(bookmarkedProductLink).toHaveAttribute('href', `#${storePrefix}/supply/products/${productId}`);
    await assertConsoleWording(a);

    const catalogs = await (await a.request.get('/api/v1/me/supply-catalogs?pagination=cursor')).json();
    expect(catalogs.items).toHaveLength(1);
    expect(catalogs.items[0].tenant_id).toBe(tenantId);
    expect(catalogs.items[0].instance_id).toBe(instanceId);

    // Step 13: Old and alternate entries all resolve to the same business. (AT-42)
    await a.goto(`/#${storePrefix}/supply-orders`);
    await expect(a.getByRole('heading', {level: 1, name: '預留與訂單', exact: true})).toBeVisible();
    await expect(activeView.locator('.sc-list > li').filter({hasText: orderId}).locator('.badge')).toHaveText('已取消');
    await assertConsoleWording(a);

    await a.goto('/#stores/supply');
    const catalogCard = a.locator('article.card').filter({has: a.getByRole('heading', {name: catalogName, exact: true})});
    await expect(catalogCard).toBeVisible();
    await catalogCard.getByRole('link', {name: '查看商品與供貨', exact: true}).click();
    await expect(a).toHaveURL(new RegExp(`#${storePrefix}/supply$`));
    await expect(a.getByRole('heading', {level: 1, name: '營運概覽', exact: true})).toBeVisible();
    await assertConsoleWording(a);

    await open(a, `guilds/${supplierGuild}`);
    const guildActions = a.getByRole('region', {name: '主要動作', exact: true});
    await expect(guildActions).toBeVisible();
    await guildActions.getByRole('button', {name: '查看商品與供貨', exact: true}).click();
    await expect(a).toHaveURL(new RegExp(`#${storePrefix}/supply$`));
    await expect(a.getByRole('heading', {level: 1, name: '營運概覽', exact: true})).toBeVisible();
    await assertConsoleWording(a);

    // Step 14: Flag OFF fallback renders legacy supply catalog and legacy supplier orders. (AT-44)
    const off = await offListener(e2eAuthPool, true);
    const offContext = await browser.newContext({baseURL: off.origin});
    try {
      const offPage = await offContext.newPage();
      await buyerLogin(offPage, supplier.email, `#${storePrefix}/supply`, off.origin);
      await expect(offPage.getByRole('navigation', {name: '供貨工作區'})).toBeVisible();
      await expect(offPage.locator('.hosted-store-product')).toContainText(productTitle);
      await expect(offPage.locator('.supplier-console')).toHaveCount(0);

      await offPage.getByRole('navigation', {name: '供貨工作區'}).getByRole('button', {name: '預留與訂單', exact: true}).click();
      await offPage.getByRole('link', {name: '供貨訂單', exact: true}).click();
      await expect(offPage.getByRole('heading', {name: '供貨訂單', exact: true})).toBeVisible();
      await expect(offPage.locator('.hosted-store-product').filter({hasText: orderId})).toContainText('已取消');
      await expect(offPage.locator('.supplier-console')).toHaveCount(0);
    } finally {
      try {
        await offContext.close();
      } finally {
        await off.close();
      }
    }
  } finally {
    await Promise.allSettled(contexts.map(ctx => ctx.close()));
    await e2eAuthPool.query(`UPDATE commerce_hosted_supply_offers o
      SET state='withdrawn',version=o.version+1
      FROM commerce_storefront_profiles p JOIN commerce_shops s ON s.shop_id=p.supply_shop_id
      WHERE o.instance_id=p.instance_id AND o.tenant_id=p.tenant_id
        AND s.owner_id=$1 AND o.state='offered'`, [supplier.id]);
  }
});

test('SC-E2E-02 retail owner sees the same console with 已開零售 and 前往商店 (AT-02)', async ({page, e2eAuthPool}) => {
  test.setTimeout(90_000);
  const suffix = randomUUID().slice(0, 6);
  const retailStoreName = `海島零售兼供貨店 ${suffix}`;
  const retailSlug = `retail-supply-${suffix}-${randomUUID().slice(0, 4)}`;
  const retailProductTitle = `零售花茶禮盒 ${suffix}`;
  const supplyProductTitle = `供貨原葉茶包 ${suffix}`;

  const owner = await person(e2eAuthPool);
  await login(page, owner.email);

  const store = await launchStore(page, `海島零售空間 ${suffix}`);
  await post(page, store.root + '/setup', {name: retailStoreName, slug: retailSlug, currency: 'TWD'}, 201);
  await post(page, store.root + '/products', {title: retailProductTitle, price_minor: 18000, stock: 6}, 201);

  await page.goto(`/#${store.hash}/supply`);
  const consoleRoot = page.locator('.supplier-console');
  const activeView = consoleRoot.locator('[data-sc-active="true"]');
  await expect(consoleRoot).toBeVisible();
  await expect(page.getByRole('heading', {level: 1, name: '營運概覽', exact: true})).toBeVisible();
  await expect(consoleRoot.locator('.sc-business-bar')).toContainText(retailStoreName);
  await expect(consoleRoot.locator('.sc-business-bar .badge')).toHaveText('已開零售');
  const storeLink = consoleRoot.locator('.sc-business-bar').getByRole('link', {name: '前往商店', exact: true});
  await expect(storeLink).toHaveAttribute('href', `#${store.hash}`);
  await assertConsoleWording(page);

  await page.getByRole('navigation', {name: '營運中心', exact: true}).getByRole('link', {name: '商品與庫存', exact: true}).click();
  await expect(page.getByRole('heading', {level: 1, name: '商品與庫存', exact: true})).toBeVisible();
  await activeView.getByRole('link', {name: '新增商品', exact: true}).click();

  await expect(page.getByRole('heading', {level: 1, name: '新增商品', exact: true})).toBeVisible();
  const newProductForm = page.getByRole('form', {name: '新增商品', exact: true});
  await newProductForm.getByLabel('商品名稱', {exact: true}).fill(supplyProductTitle);
  await newProductForm.getByLabel('說明', {exact: true}).fill('供貨給其他選物店的原葉茶包。');
  await newProductForm.getByLabel('供貨單價', {exact: true}).fill('120');
  await newProductForm.getByLabel('庫存', {exact: true}).fill('8');
  await newProductForm.getByRole('button', {name: '新增商品', exact: true}).click();

  await expect(page.getByRole('heading', {level: 1, name: '商品詳情', exact: true})).toBeVisible();
  await expect(page.getByRole('heading', {level: 2, name: `商品詳情：${supplyProductTitle}`, exact: true})).toBeVisible();
  await assertConsoleWording(page);

  await storeLink.click();
  await expect(page).toHaveURL(new RegExp(`#${store.hash}$`));
  await expect(page.locator('.hosted-store')).toBeVisible();
  await expect(page.locator('.supplier-console')).toHaveCount(0);
  await expect(page.locator('.hosted-store-product').filter({hasText: retailProductTitle})).toBeVisible();
});
