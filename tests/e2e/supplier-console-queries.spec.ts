import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {BrowserContext, Page, TestInfo} from '@playwright/test';
import {test, expect as baseExpect} from './member-feature-fixture.js';
import {person, post, launchStore} from './hosted-store-fixture.js';
import {DEMO_COMMUNITY, DEMO_PASSWORD} from '../../packages/testing/seed.js';
import {convertV1} from '../../contracts/guild-launchpad/v2/config.js';

const expect = baseExpect.configure({timeout: 20_000});

test.use({
  memberFeatures: {
    guildLaunchpadEnabled: true,
    hostedReservationsEnabled: true,
    supplierConsoleEnabled: true,
  },
});

const consoleRoot = (page: Page) => page.locator('.supplier-console');
const activePage = (page: Page) => page.locator('.sc-content > [data-sc-active="true"]');
const navLink = (page: Page, name: string) =>
  page.getByRole('navigation', {name: '營運中心', exact: true}).getByRole('link', {name, exact: true});

async function login(page: Page, email: string) {
  await page.route(url => !['127.0.0.1', 'localhost'].includes(url.hostname), route => route.abort());
  await page.goto('/');
  await page.getByLabel('電子郵件', {exact: true}).fill(email);
  await page.getByLabel('密碼', {exact: true}).fill(DEMO_PASSWORD);
  await page.getByRole('button', {name: '登入', exact: true}).click();
  await expect(page.getByRole('button', {name: '設定', exact: true})).toBeVisible({timeout: 15_000});
}

function parseStore(store: {root: string; hash: string}) {
  const [, , tenantId, , instanceId] = store.root.split('/');
  return {root: store.root, hash: store.hash, tenantId, instanceId};
}

async function getJson(page: Page, path: string, expectedStatus = 200) {
  const response = await page.request.get(`/api/v1${path}`);
  const body = await response.json();
  expect(response.status(), JSON.stringify(body)).toBe(expectedStatus);
  return body;
}

async function putJson(page: Page, path: string, data: unknown, expectedStatus = 200, version?: string) {
  const session = await getJson(page, '/session');
  const response = await page.request.put(`/api/v1${path}`, {
    data,
    headers: {
      Origin: new URL(page.url()).origin,
      'X-CSRF-Token': session.csrf_token,
      'Idempotency-Key': randomUUID(),
      ...(version ? {'If-Match': `"${version}"`} : {}),
    },
  });
  const body = await response.json();
  expect(response.status(), JSON.stringify(body)).toBe(expectedStatus);
  return body;
}

async function patchJson(page: Page, path: string, data: unknown, expectedStatus = 200, version?: string) {
  const session = await getJson(page, '/session');
  const response = await page.request.patch(`/api/v1${path}`, {
    data,
    headers: {
      Origin: new URL(page.url()).origin,
      'X-CSRF-Token': session.csrf_token,
      'Idempotency-Key': randomUUID(),
      ...(version ? {'If-Match': `"${version}"`} : {}),
    },
  });
  const body = await response.json();
  expect(response.status(), JSON.stringify(body)).toBe(expectedStatus);
  return body;
}

async function openSupplyPage(page: Page, hash: string, expectedHeading?: string) {
  const targetHash = hash.startsWith('#') ? hash : `#${hash}`;
  await page.evaluate(h => {
    window.location.hash = h;
  }, targetHash);
  await expect(consoleRoot(page)).toBeVisible();
  if (expectedHeading) {
    await expect(activePage(page).locator('h2').first()).toHaveText(expectedHeading, {timeout: 15_000});
  }
}

async function withdrawSupplierOffers(db: Pool, supplierUserIds: string[]) {
  if (!supplierUserIds.length) return;
  await db.query(
    `UPDATE commerce_hosted_supply_offers o
     SET state='withdrawn',version=o.version+1
     FROM commerce_storefront_profiles p JOIN commerce_shops s ON s.shop_id=p.supply_shop_id
     WHERE o.instance_id=p.instance_id AND o.tenant_id=p.tenant_id
       AND s.owner_id=ANY($1::uuid[]) AND o.state='offered'`,
    [supplierUserIds],
  );
}

async function inviteMember(
  ownerPage: Page,
  memberPage: Page,
  db: Pool,
  store: {tenantId: string; instanceId: string},
  capabilities: string[],
) {
  const member = await person(db);
  await login(memberPage, member.email);
  const candidate = await getJson(ownerPage, `/tenants/invite-candidates?user_id=${member.id}`);
  const invitation = await post(
    ownerPage,
    `/tenants/${store.tenantId}/invitations`,
    {
      invitee_principal_id: candidate.principal_id,
      role: 'operator',
      instance_capabilities: [{instance_id: store.instanceId, capabilities}],
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    },
    201,
  );
  await post(
    memberPage,
    `/tenants/${store.tenantId}/invitations/${invitation.invitation_id}/accept`,
    {},
    200,
    invitation.version,
  );
  return {member, principalId: candidate.principal_id as string};
}

async function createProductAndPublishInUi(
  page: Page,
  store: {root: string; hash: string},
  input: {title: string; description: string; cost: string; stock: string; shipping: string},
) {
  await openSupplyPage(page, `${store.hash}/supply/products/new`, '新增商品');
  const createForm = activePage(page).getByRole('form', {name: '新增商品', exact: true});
  await createForm.getByLabel('商品名稱', {exact: true}).fill(input.title);
  await createForm.getByRole('textbox', {name: '說明', exact: true}).fill(input.description);
  await createForm.getByLabel('供貨單價', {exact: true}).fill(input.cost);
  await createForm.getByLabel('庫存', {exact: true}).fill(input.stock);
  await createForm.getByRole('button', {name: '新增商品', exact: true}).click();

  await expect(activePage(page).getByRole('heading', {level: 2, name: `商品詳情：${input.title}`, exact: true})).toBeVisible();
  const productMatch = new URL(page.url()).hash.match(/\/supply\/products\/([0-9a-f-]{36})$/);
  expect(productMatch).not.toBeNull();
  const productId = productMatch![1];

  const termsForm = activePage(page).getByRole('form', {name: '儲存供貨條件', exact: true});
  await termsForm.getByLabel('每件運費', {exact: true}).fill(input.shipping);
  await termsForm.getByRole('textbox', {name: '出貨條件', exact: true}).fill('確認訂單後三個工作日內寄出');
  await termsForm.getByRole('textbox', {name: '退貨條件', exact: true}).fill('到貨七日內非人為瑕疵可退換');
  await termsForm.getByRole('button', {name: '儲存供貨條件', exact: true}).click();
  await expect(consoleRoot(page).locator('.sc-announcement')).toHaveText('已保存：儲存供貨條件。');

  const offerSection = activePage(page)
    .locator('.sc-section')
    .filter({has: page.getByRole('heading', {level: 3, name: '供貨版本', exact: true})});
  await offerSection.getByRole('button', {name: '公開供貨版本', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: '公開供貨版本的影響', exact: true});
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', {name: '確認公開供貨版本', exact: true}).click();
  await expect(consoleRoot(page).locator('.sc-announcement')).toHaveText('已保存：公開供貨版本。');
  await expect(offerSection.locator('.badge')).toHaveText('公開中');

  const detail = await getJson(page, `${store.root}/supplier-console/products/${productId}`);
  return {
    productId,
    sku: detail.product.sku as string,
    offerId: detail.current_offer.offer_id as string,
    termsSha256: detail.current_offer.terms_sha256 as string,
  };
}

async function enableSupplierReservationsInUi(page: Page) {
  await navLink(page, '設定與資料').click();
  await expect(activePage(page).getByRole('heading', {level: 2, name: '設定與資料', exact: true})).toBeVisible();
  await activePage(page).getByRole('button', {name: '開放 30 分鐘預留', exact: true}).click();
  await expect(consoleRoot(page).locator('.sc-announcement')).toHaveText('已保存：開放 30 分鐘預留。');
}

async function acceptProposalInUi(page: Page, storeHash: string, selectionId: string) {
  await openSupplyPage(page, `${storeHash}/supply/terms/${selectionId}`, '審核售價申請');
  await activePage(page).getByRole('button', {name: '同意', exact: true}).click();
  await expect(consoleRoot(page).locator('.sc-announcement')).toHaveText('已保存：同意售價申請。');
  await expect(activePage(page).locator('.badge').filter({hasText: '可售'})).toBeVisible();
}

async function publishAndEnableSellerStore(page: Page, storeRoot: string) {
  const view = await getJson(page, storeRoot);
  await post(page, `${storeRoot}/publish`, {}, 200, view.version);
  const setting = await getJson(page, `${storeRoot}/reservation-setting`);
  if (!setting.reservation_enabled) {
    await patchJson(page, `${storeRoot}/reservation-setting`, {reservation_enabled: true}, 200, setting.version);
  }
}

async function createBuyerReservation(
  buyerPage: Page,
  slug: string,
  items: Array<{sku: string; quantity: number}>,
) {
  const store = await getJson(buyerPage, `/public/stores/${slug}`);
  const quote = await post(
    buyerPage,
    `/hosted-stores/${slug}/reservation-quotes`,
    {publication_revision: store.revision, items},
    201,
  );
  return post(
    buyerPage,
    `/hosted-stores/${slug}/reservation-orders`,
    {
      quote_id: quote.quote_id,
      terms_sha256: quote.terms_sha256,
      client_order_id: randomUUID(),
    },
    201,
  );
}

test('SC-E2E-50 reservation filters, totals and detail keep one definition (AT-22,30,31)', async ({browser, baseURL, e2eAuthPool}) => {
  test.setTimeout(240_000);
  const contexts: BrowserContext[] = [];
  const supplierIds: string[] = [];
  const suffix = randomUUID().slice(0, 6);

  try {
    const supplierCtx = await browser.newContext({baseURL, timezoneId: 'America/Los_Angeles'});
    contexts.push(supplierCtx);
    const seller1Ctx = await browser.newContext({baseURL});
    contexts.push(seller1Ctx);
    const seller2Ctx = await browser.newContext({baseURL});
    contexts.push(seller2Ctx);
    const buyerCtx = await browser.newContext({baseURL});
    contexts.push(buyerCtx);

    const supplierMember = await person(e2eAuthPool);
    supplierIds.push(supplierMember.id);
    const seller1Member = await person(e2eAuthPool);
    const seller2Member = await person(e2eAuthPool);
    const buyerMember = await person(e2eAuthPool);
    const buyerNickname = `買家隱藏暱稱-${suffix}`;
    await e2eAuthPool.query('UPDATE users SET display_name=$1 WHERE user_id=$2', [buyerNickname, buyerMember.id]);

    const [supplierPage, seller1Page, seller2Page, buyerPage] = await Promise.all([
      supplierCtx.newPage(),
      seller1Ctx.newPage(),
      seller2Ctx.newPage(),
      buyerCtx.newPage(),
    ]);

    await login(supplierPage, supplierMember.email);
    const storeA = parseStore(await launchStore(supplierPage, `供貨空間50 ${suffix}`));
    const catalogName = `山海供貨商品庫 ${suffix}`;
    await openSupplyPage(supplierPage, `${storeA.hash}/supply`);
    const setupForm = supplierPage.getByRole('form', {name: '建立供貨商品庫', exact: true});
    await setupForm.getByLabel('商品庫名稱', {exact: true}).fill(catalogName);
    await setupForm.getByLabel('說明', {exact: true}).fill('SC-E2E-50 供貨商品庫');
    await setupForm.getByRole('button', {name: '建立供貨商品庫', exact: true}).click();
    await expect(activePage(supplierPage).getByRole('heading', {level: 2, name: '營運概覽', exact: true})).toBeVisible();

    const prod1Title = `濾掛咖啡組 ${suffix}`;
    const prod2Title = `手沖銅壺 ${suffix}`;
    const prod1 = await createProductAndPublishInUi(supplierPage, storeA, {
      title: prod1Title,
      description: '中深焙濾掛咖啡禮盒',
      cost: '150',
      stock: '20',
      shipping: '20',
    });
    const prod2 = await createProductAndPublishInUi(supplierPage, storeA, {
      title: prod2Title,
      description: '細口手沖銅壺',
      cost: '200',
      stock: '20',
      shipping: '30',
    });
    await enableSupplierReservationsInUi(supplierPage);

    const shop1Name = `晨光選物店 ${suffix}`;
    const shop1Slug = `shop50-a-${suffix}`;
    const shop1OwnTitle = `晨光自有玻璃杯 ${suffix}`;
    await login(seller1Page, seller1Member.email);
    const store1 = parseStore(await launchStore(seller1Page, `賣家空間50A ${suffix}`));
    await post(seller1Page, `${store1.root}/setup`, {name: shop1Name, slug: shop1Slug, currency: 'TWD'}, 201);
    const shop1Own = await post(seller1Page, `${store1.root}/products`, {title: shop1OwnTitle, price_minor: 9000, stock: 10}, 201);
    const prop1A = await post(seller1Page, `${store1.root}/distribution-selections`, {
      offer_id: prod1.offerId,
      terms_sha256: prod1.termsSha256,
      retail_price_minor: 24000,
    }, 201);
    const prop1B = await post(seller1Page, `${store1.root}/distribution-selections`, {
      offer_id: prod2.offerId,
      terms_sha256: prod2.termsSha256,
      retail_price_minor: 32000,
    }, 201);

    const shop2Name = `暮色生活館 ${suffix}`;
    const shop2Slug = `shop50-b-${suffix}`;
    const shop2OwnTitle = `暮色自有木盤 ${suffix}`;
    await login(seller2Page, seller2Member.email);
    const store2 = parseStore(await launchStore(seller2Page, `賣家空間50B ${suffix}`));
    await post(seller2Page, `${store2.root}/setup`, {name: shop2Name, slug: shop2Slug, currency: 'TWD'}, 201);
    const shop2Own = await post(seller2Page, `${store2.root}/products`, {title: shop2OwnTitle, price_minor: 11000, stock: 10}, 201);
    const prop2A = await post(seller2Page, `${store2.root}/distribution-selections`, {
      offer_id: prod1.offerId,
      terms_sha256: prod1.termsSha256,
      retail_price_minor: 25000,
    }, 201);

    await acceptProposalInUi(supplierPage, storeA.hash, prop1A.selection_id);
    await acceptProposalInUi(supplierPage, storeA.hash, prop1B.selection_id);
    await acceptProposalInUi(supplierPage, storeA.hash, prop2A.selection_id);

    await publishAndEnableSellerStore(seller1Page, store1.root);
    await publishAndEnableSellerStore(seller2Page, store2.root);

    const partner1Id = (
      await e2eAuthPool.query('SELECT storefront_shop_id FROM commerce_storefront_profiles WHERE instance_id=$1', [store1.instanceId])
    ).rows[0].storefront_shop_id as string;
    const partner2Id = (
      await e2eAuthPool.query('SELECT storefront_shop_id FROM commerce_storefront_profiles WHERE instance_id=$1', [store2.instanceId])
    ).rows[0].storefront_shop_id as string;

    await login(buyerPage, buyerMember.email);
    // Reservation 1 on Shop 1: holds both prod1 (qty 2) and prod2 (qty 1) -> 2 supply lines
    const order1 = await createBuyerReservation(buyerPage, shop1Slug, [
      {sku: prop1A.sku, quantity: 2},
      {sku: prop1B.sku, quantity: 1},
      {sku: shop1Own.sku, quantity: 1},
    ]);
    // Reservation 2 on Shop 1: holds prod1 (qty 1) -> cancelled through the buyer UI
    const order2 = await createBuyerReservation(buyerPage, shop1Slug, [{sku: prop1A.sku, quantity: 1}]);
    // Reservation 3 on Shop 2: holds prod1 (qty 3) + seller 2's own product -> 1 supply line from this supplier
    const order3 = await createBuyerReservation(buyerPage, shop2Slug, [
      {sku: prop2A.sku, quantity: 3},
      {sku: shop2Own.sku, quantity: 1},
    ]);

    await buyerPage.evaluate(h => {
      window.location.hash = h;
    }, `reservations/order/${order2.order_id}`);
    await expect(buyerPage.getByRole('region', {name: '我的預留'})).toBeVisible();
    await expect(buyerPage.getByRole('region', {name: '我的預留'})).toContainText('預留中');
    buyerPage.once('dialog', d => d.accept());
    await buyerPage.getByRole('button', {name: '取消預留', exact: true}).click();
    await expect(buyerPage.getByRole('region', {name: '我的預留'})).toContainText('已取消');

    await navLink(supplierPage, '預留與訂單').click();
    await expect(activePage(supplierPage).getByRole('heading', {level: 2, name: '預留與訂單', exact: true})).toBeVisible();

    const filterForm = activePage(supplierPage).getByRole('form', {name: '篩選預留', exact: true});
    const stateSelect = filterForm.getByRole('combobox', {name: '狀態', exact: true});
    const partnerSelect = filterForm.getByRole('combobox', {name: '合作店家', exact: true});
    const productSelect = filterForm.getByRole('combobox', {name: '商品', exact: true});
    const fromInput = filterForm.getByLabel('建立日期起（台灣時間）', {exact: true});
    const toInput = filterForm.getByLabel('建立日期迄（台灣時間）', {exact: true});
    const applyBtn = filterForm.getByRole('button', {name: '套用篩選', exact: true});
    const clearBtn = filterForm.getByRole('button', {name: '清除篩選', exact: true});

    // Unfiltered: 3 reservations, 4 supply lines
    await expect(activePage(supplierPage)).toContainText('符合條件：3 筆預留、4 個供貨行項');
    await expect(activePage(supplierPage).locator('ul.sc-list > li')).toHaveCount(3);

    // Filter by 狀態=已取消 -> only order2
    await stateSelect.selectOption('cancelled');
    await applyBtn.click();
    await expect(activePage(supplierPage)).toContainText('符合條件：1 筆預留、1 個供貨行項');
    await expect(activePage(supplierPage).locator('ul.sc-list > li')).toHaveCount(1);
    await expect(activePage(supplierPage).locator('ul.sc-list > li').first()).toContainText(order2.order_id);
    await expect(activePage(supplierPage).locator('ul.sc-list > li').first().locator('.badge')).toHaveText('已取消');

    // Filter by 合作店家=shop2 -> only order3
    await stateSelect.selectOption('');
    await partnerSelect.selectOption(partner2Id);
    await applyBtn.click();
    await expect(activePage(supplierPage)).toContainText('符合條件：1 筆預留、1 個供貨行項');
    await expect(activePage(supplierPage).locator('ul.sc-list > li')).toHaveCount(1);
    await expect(activePage(supplierPage).locator('ul.sc-list > li').first()).toContainText(order3.order_id);
    await expect(activePage(supplierPage).locator('ul.sc-list > li').first()).toContainText(shop2Name);

    // Filter by 商品=prod2 -> only order1, and both prod1 and prod2 lines of order1 still show
    await partnerSelect.selectOption('');
    await productSelect.selectOption(prod2.productId);
    await applyBtn.click();
    await expect(activePage(supplierPage)).toContainText('符合條件：1 筆預留、2 個供貨行項');
    const prod2FilteredItem = activePage(supplierPage).locator('ul.sc-list > li');
    await expect(prod2FilteredItem).toHaveCount(1);
    await expect(prod2FilteredItem.first()).toContainText(order1.order_id);
    await expect(prod2FilteredItem.first()).toContainText(`${prod1Title} · ${prop1A.sku}`);
    await expect(prod2FilteredItem.first()).toContainText(`${prod2Title} · ${prop1B.sku}`);

    // 清除篩選 restores all
    await clearBtn.click();
    await expect(activePage(supplierPage)).toContainText('符合條件：3 筆預留、4 個供貨行項');
    await expect(activePage(supplierPage).locator('ul.sc-list > li')).toHaveCount(3);

    // Dates in Asia/Taipei while browser context is in America/Los_Angeles
    const taipeiFormatter = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Taipei'});
    const todayTaipei = taipeiFormatter.format(new Date());
    const yesterdayTaipei = taipeiFormatter.format(new Date(Date.now() - 86_400_000));

    await fromInput.fill(todayTaipei);
    await toInput.fill(todayTaipei);
    await applyBtn.click();
    await expect(activePage(supplierPage)).toContainText('符合條件：3 筆預留、4 個供貨行項');
    await expect(activePage(supplierPage).locator('ul.sc-list > li')).toHaveCount(3);

    await fromInput.fill(yesterdayTaipei);
    await toInput.fill(yesterdayTaipei);
    await applyBtn.click();
    await expect(activePage(supplierPage)).toContainText('符合條件：0 筆預留、0 個供貨行項');
    await expect(activePage(supplierPage).getByText('沒有符合條件的供貨預留。', {exact: true})).toBeVisible();

    // Put 起 after 迄: alert shows and 套用篩選 is disabled
    await fromInput.fill(todayTaipei);
    await toInput.fill(yesterdayTaipei);
    await expect(filterForm.getByRole('alert')).toHaveText('建立日期起不能晚於建立日期迄，請檢查日期。');
    await expect(applyBtn).toBeDisabled();

    // Filter to shop2 (which holds order3 with 1 supplier line) and open 查看預留明細
    await clearBtn.click();
    await partnerSelect.selectOption(partner2Id);
    await applyBtn.click();
    await expect(activePage(supplierPage)).toContainText('符合條件：1 筆預留、1 個供貨行項');
    const filteredHash = await supplierPage.evaluate(() => window.location.hash);
    expect(filteredHash).toContain(`partner=${partner2Id}`);

    const detailLink = activePage(supplierPage).getByRole('link', {
      name: new RegExp(`^查看預留明細\\s*：預留編號 …${order3.order_id.slice(-8)}$`),
    });
    await detailLink.click();

    await expect(activePage(supplierPage).getByRole('heading', {level: 2, name: '預留明細', exact: true})).toBeVisible();
    await expect(activePage(supplierPage)).toContainText(`${prod1Title} · ${prop2A.sku}`);
    await expect(activePage(supplierPage)).toContainText('3 × 供貨單價 $150.00 ＝ 小計 $450.00');
    const offerVersionSection = activePage(supplierPage)
      .locator('section.sc-section')
      .filter({has: supplierPage.getByRole('heading', {level: 3, name: '供貨版本', exact: true})});
    await expect(offerVersionSection).toBeVisible();
    await expect(offerVersionSection).toContainText(prod1Title);
    await expect(offerVersionSection).toContainText(`供貨版本 …${prod1.termsSha256.slice(-8)}`);
    await expect(activePage(supplierPage)).not.toContainText(shop2OwnTitle);
    await expect(activePage(supplierPage)).not.toContainText(buyerMember.email);
    await expect(activePage(supplierPage)).not.toContainText(buyerNickname);

    // 返回預留與訂單 returns to the same filtered list (hash query unchanged)
    await activePage(supplierPage).getByRole('link', {name: '返回預留與訂單', exact: true}).click();
    await expect(activePage(supplierPage).getByRole('heading', {level: 2, name: '預留與訂單', exact: true})).toBeVisible();
    expect(await supplierPage.evaluate(() => window.location.hash)).toBe(filteredHash);
    await expect(activePage(supplierPage)).toContainText('符合條件：1 筆預留、1 個供貨行項');

    // Reload the filtered list and confirm the same filters and totals come back
    await supplierPage.reload();
    await expect(activePage(supplierPage).getByRole('heading', {level: 2, name: '預留與訂單', exact: true})).toBeVisible();
    expect(await supplierPage.evaluate(() => window.location.hash)).toBe(filteredHash);
    await expect(partnerSelect).toHaveValue(partner2Id);
    await expect(activePage(supplierPage)).toContainText('符合條件：1 筆預留、1 個供貨行項');
    await expect(activePage(supplierPage).locator('ul.sc-list > li')).toHaveCount(1);
    await expect(activePage(supplierPage).locator('ul.sc-list > li').first()).toContainText(order3.order_id);
  } finally {
    await Promise.allSettled(contexts.map(ctx => ctx.close()));
    await withdrawSupplierOffers(e2eAuthPool, supplierIds);
  }
});

test("SC-E2E-51 partner detail shows that shop's reservations for the owner only (AT-04,22)", async ({browser, baseURL, e2eAuthPool}) => {
  test.setTimeout(240_000);
  const contexts: BrowserContext[] = [];
  const supplierIds: string[] = [];
  const suffix = randomUUID().slice(0, 6);

  try {
    const ownerCtx = await browser.newContext({baseURL});
    contexts.push(ownerCtx);
    const seller1Ctx = await browser.newContext({baseURL});
    contexts.push(seller1Ctx);
    const seller2Ctx = await browser.newContext({baseURL});
    contexts.push(seller2Ctx);
    const buyerCtx = await browser.newContext({baseURL});
    contexts.push(buyerCtx);
    const adminCtx = await browser.newContext({baseURL});
    contexts.push(adminCtx);

    const ownerMember = await person(e2eAuthPool);
    supplierIds.push(ownerMember.id);
    const seller1Member = await person(e2eAuthPool);
    const seller2Member = await person(e2eAuthPool);
    const buyerMember = await person(e2eAuthPool);

    const [ownerPage, seller1Page, seller2Page, buyerPage, adminPage] = await Promise.all([
      ownerCtx.newPage(),
      seller1Ctx.newPage(),
      seller2Ctx.newPage(),
      buyerCtx.newPage(),
      adminCtx.newPage(),
    ]);

    await login(ownerPage, ownerMember.email);
    const storeA = parseStore(await launchStore(ownerPage, `供貨空間51 ${suffix}`));
    await post(ownerPage, `${storeA.root}/supply-profile`, {name: `供貨商品庫51 ${suffix}`, currency: 'TWD'}, 201);
    const prodTitle = `焙茶拿鐵粉 ${suffix}`;
    const prod = await createProductAndPublishInUi(ownerPage, storeA, {
      title: prodTitle,
      description: '京都風焙茶粉',
      cost: '120',
      stock: '30',
      shipping: '15',
    });
    await enableSupplierReservationsInUi(ownerPage);

    const shop1Name = `青島選品店 ${suffix}`;
    const shop1Slug = `shop51-a-${suffix}`;
    await login(seller1Page, seller1Member.email);
    const store1 = parseStore(await launchStore(seller1Page, `賣家空間51A ${suffix}`));
    await post(seller1Page, `${store1.root}/setup`, {name: shop1Name, slug: shop1Slug, currency: 'TWD'}, 201);
    const prop1 = await post(seller1Page, `${store1.root}/distribution-selections`, {
      offer_id: prod.offerId,
      terms_sha256: prod.termsSha256,
      retail_price_minor: 20000,
    }, 201);

    const shop2Name = `白沙生活店 ${suffix}`;
    const shop2Slug = `shop51-b-${suffix}`;
    await login(seller2Page, seller2Member.email);
    const store2 = parseStore(await launchStore(seller2Page, `賣家空間51B ${suffix}`));
    await post(seller2Page, `${store2.root}/setup`, {name: shop2Name, slug: shop2Slug, currency: 'TWD'}, 201);
    const prop2 = await post(seller2Page, `${store2.root}/distribution-selections`, {
      offer_id: prod.offerId,
      terms_sha256: prod.termsSha256,
      retail_price_minor: 21000,
    }, 201);

    await acceptProposalInUi(ownerPage, storeA.hash, prop1.selection_id);
    await acceptProposalInUi(ownerPage, storeA.hash, prop2.selection_id);
    await publishAndEnableSellerStore(seller1Page, store1.root);
    await publishAndEnableSellerStore(seller2Page, store2.root);

    const partner1Id = (
      await e2eAuthPool.query('SELECT storefront_shop_id FROM commerce_storefront_profiles WHERE instance_id=$1', [store1.instanceId])
    ).rows[0].storefront_shop_id as string;

    await login(buyerPage, buyerMember.email);
    const shop1Orders: Array<{order_id: string}> = [];
    for (let i = 0; i < 6; i++) {
      shop1Orders.push(await createBuyerReservation(buyerPage, shop1Slug, [{sku: prop1.sku, quantity: 1}]));
    }
    const shop2Order = await createBuyerReservation(buyerPage, shop2Slug, [{sku: prop2.sku, quantity: 2}]);

    // Owner opens 合作店家詳情 of shop1
    await navLink(ownerPage, '合作店家').click();
    await expect(activePage(ownerPage).getByRole('heading', {level: 2, name: '合作店家', exact: true})).toBeVisible();
    await activePage(ownerPage).getByRole('link', {name: shop1Name, exact: true}).click();
    await expect(activePage(ownerPage).getByRole('heading', {level: 2, name: '合作店家詳情', exact: true})).toBeVisible();

    const relSection = activePage(ownerPage)
      .locator('section.sc-section')
      .filter({has: ownerPage.getByRole('heading', {level: 4, name: '相關預留', exact: true})});
    await expect(relSection).toBeVisible();
    await expect(relSection).toContainText('符合條件：6 筆預留、6 個供貨行項');
    const relItems = relSection.locator('ul.sc-history > li.sc-row');
    await expect(relItems).toHaveCount(5);
    await expect(relSection).not.toContainText(shop2Order.order_id);

    // 查看這間店的全部預留 opens 預留與訂單 filtered by that shop
    await relSection.getByRole('link', {name: '查看這間店的全部預留', exact: true}).click();
    await expect(activePage(ownerPage).getByRole('heading', {level: 2, name: '預留與訂單', exact: true})).toBeVisible();
    expect(await ownerPage.evaluate(() => window.location.hash)).toBe(
      `#${storeA.hash}/supply/reservations?partner=${partner1Id}`,
    );
    await expect(
      activePage(ownerPage).getByRole('form', {name: '篩選預留', exact: true}).getByRole('combobox', {name: '合作店家', exact: true}),
    ).toHaveValue(partner1Id);
    await expect(activePage(ownerPage)).toContainText('符合條件：6 筆預留、6 個供貨行項');
    await expect(activePage(ownerPage)).not.toContainText(shop2Order.order_id);

    // Invite an operator with store:write (non-owner) into the supplier business
    await inviteMember(ownerPage, adminPage, e2eAuthPool, storeA, ['store:read', 'store:write', 'store:publish']);

    await openSupplyPage(adminPage, `${storeA.hash}/supply/partners/${partner1Id}`, '合作店家詳情');
    const adminNav = adminPage.getByRole('navigation', {name: '營運中心', exact: true});
    await expect(adminNav.getByRole('link', {name: '預留與訂單', exact: true})).toHaveCount(0);

    const adminRelSection = activePage(adminPage)
      .locator('section.sc-section')
      .filter({has: adminPage.getByRole('heading', {level: 4, name: '相關預留', exact: true})});
    await expect(adminRelSection).toContainText('只有業務空間擁有者可以查看預留');
    await expect(adminRelSection).not.toContainText('符合條件：');
    await expect(adminRelSection.locator('ul.sc-history')).toHaveCount(0);
    await expect(adminRelSection.getByRole('link', {name: '查看這間店的全部預留'})).toHaveCount(0);

    // Direct link to .../supply/reservations
    await openSupplyPage(adminPage, `${storeA.hash}/supply/reservations`, '預留與訂單');
    await expect(activePage(adminPage)).toContainText('只有業務空間擁有者可以查看預留');
    await expect(activePage(adminPage).getByRole('form', {name: '篩選預留'})).toHaveCount(0);
    await expect(activePage(adminPage)).not.toContainText('符合條件：');
    await expect(activePage(adminPage)).not.toContainText(shop1Orders[0].order_id.slice(-8));

    // Direct link to a reservation detail
    await openSupplyPage(adminPage, `${storeA.hash}/supply/reservations/${shop1Orders[0].order_id}`, '預留明細');
    await expect(activePage(adminPage)).toContainText('只有業務空間擁有者可以查看預留');
    await expect(activePage(adminPage)).not.toContainText(prodTitle);
    await expect(activePage(adminPage)).not.toContainText(shop1Orders[0].order_id.slice(-8));
  } finally {
    await Promise.allSettled(contexts.map(ctx => ctx.close()));
    await withdrawSupplierOffers(e2eAuthPool, supplierIds);
  }
});

test('SC-E2E-52 recent changes and product records follow console actions (AT-15,30)', async ({browser, baseURL, e2eAuthPool}) => {
  test.setTimeout(240_000);
  const contexts: BrowserContext[] = [];
  const supplierIds: string[] = [];
  const suffix = randomUUID().slice(0, 6);

  try {
    const ownerCtx = await browser.newContext({baseURL});
    contexts.push(ownerCtx);
    const viewerCtx = await browser.newContext({baseURL});
    contexts.push(viewerCtx);

    const ownerMember = await person(e2eAuthPool);
    supplierIds.push(ownerMember.id);
    const [ownerPage, viewerPage] = await Promise.all([ownerCtx.newPage(), viewerCtx.newPage()]);

    await login(ownerPage, ownerMember.email);
    const storeA = parseStore(await launchStore(ownerPage, `供貨空間52 ${suffix}`));
    await openSupplyPage(ownerPage, `${storeA.hash}/supply`);
    const setupForm = ownerPage.getByRole('form', {name: '建立供貨商品庫', exact: true});
    await setupForm.getByLabel('商品庫名稱', {exact: true}).fill(`變更紀錄商品庫 ${suffix}`);
    await setupForm.getByLabel('說明', {exact: true}).fill('SC-E2E-52 測試商品庫');
    await setupForm.getByRole('button', {name: '建立供貨商品庫', exact: true}).click();

    await expect(activePage(ownerPage).getByRole('heading', {level: 2, name: '營運概覽', exact: true})).toBeVisible();
    const recentSection = activePage(ownerPage)
      .locator('section.sc-section')
      .filter({has: ownerPage.getByRole('heading', {level: 3, name: '近期變更', exact: true})});
    await expect(recentSection).toBeVisible();
    await expect(recentSection.locator('ol.sc-history > li.sc-row')).toHaveCount(1);
    await expect(recentSection.locator('ol.sc-history > li.sc-row').first()).toContainText('建立供貨商品庫');
    await expect(recentSection.locator('ol.sc-history > li.sc-row').first()).toContainText('商品庫設定');

    // Create product 1, change stock, change supply terms, publish supply version, publish again after another terms change
    const prod1Title = `金萱烏龍茶包 ${suffix}`;
    await activePage(ownerPage).getByRole('link', {name: '新增商品', exact: true}).click();
    await expect(activePage(ownerPage).getByRole('heading', {level: 2, name: '新增商品', exact: true})).toBeVisible();
    const createForm = activePage(ownerPage).getByRole('form', {name: '新增商品', exact: true});
    await createForm.getByLabel('商品名稱', {exact: true}).fill(prod1Title);
    await createForm.getByRole('textbox', {name: '說明', exact: true}).fill('高山金萱茶包');
    await createForm.getByLabel('供貨單價', {exact: true}).fill('130');
    await createForm.getByLabel('庫存', {exact: true}).fill('10');
    await createForm.getByRole('button', {name: '新增商品', exact: true}).click();
    await expect(activePage(ownerPage).getByRole('heading', {level: 2, name: `商品詳情：${prod1Title}`, exact: true})).toBeVisible();
    const prod1Id = new URL(ownerPage.url()).hash.match(/\/supply\/products\/([0-9a-f-]{36})$/)![1];

    // Change stock
    const stockForm = activePage(ownerPage).getByRole('form', {name: '儲存庫存', exact: true});
    await stockForm.getByLabel('庫存', {exact: true}).fill('16');
    await stockForm.getByRole('button', {name: '儲存庫存', exact: true}).click();
    await expect(consoleRoot(ownerPage).locator('.sc-announcement')).toHaveText('已保存：儲存庫存。');

    // Change supply terms
    const termsForm = activePage(ownerPage).getByRole('form', {name: '儲存供貨條件', exact: true});
    await termsForm.getByLabel('每件運費', {exact: true}).fill('25');
    await termsForm.getByRole('textbox', {name: '出貨條件', exact: true}).fill('訂單確認後二日內出貨');
    await termsForm.getByRole('textbox', {name: '退貨條件', exact: true}).fill('七日內非人為損壞可退');
    await termsForm.getByRole('button', {name: '儲存供貨條件', exact: true}).click();
    await expect(consoleRoot(ownerPage).locator('.sc-announcement')).toHaveText('已保存：儲存供貨條件。');

    // Publish first supply version
    const offerSection = activePage(ownerPage)
      .locator('.sc-section')
      .filter({has: ownerPage.getByRole('heading', {level: 3, name: '供貨版本', exact: true})});
    await offerSection.getByRole('button', {name: '公開供貨版本', exact: true}).click();
    await ownerPage
      .getByRole('dialog', {name: '公開供貨版本的影響', exact: true})
      .getByRole('button', {name: '確認公開供貨版本', exact: true})
      .click();
    await expect(consoleRoot(ownerPage).locator('.sc-announcement')).toHaveText('已保存：公開供貨版本。');
    await expect(offerSection.locator('.badge')).toHaveText('公開中');

    // Change supply terms again and publish again
    await termsForm.getByLabel('供貨單價', {exact: true}).fill('145');
    await termsForm.getByRole('button', {name: '儲存供貨條件', exact: true}).click();
    await expect(consoleRoot(ownerPage).locator('.sc-announcement')).toHaveText('已保存：儲存供貨條件。');
    await expect(offerSection.locator('.badge')).toHaveText('需要重新公開');

    await offerSection.getByRole('button', {name: '公開供貨版本', exact: true}).click();
    await ownerPage
      .getByRole('dialog', {name: '公開供貨版本的影響', exact: true})
      .getByRole('button', {name: '確認公開供貨版本', exact: true})
      .click();
    await expect(consoleRoot(ownerPage).locator('.sc-announcement')).toHaveText('已保存：公開供貨版本。');
    await expect(offerSection.locator('.badge')).toHaveText('公開中');

    // Check product 1's 紀錄 section
    const prod1HistorySection = activePage(ownerPage)
      .locator('section.sc-section')
      .filter({has: ownerPage.getByRole('heading', {level: 3, name: '紀錄', exact: true})});
    await expect(prod1HistorySection).toBeVisible();
    await expect(prod1HistorySection.locator('ol.sc-history > li.sc-row')).toHaveCount(7);
    const prod1Labels = await prod1HistorySection.locator('ol.sc-history > li.sc-row strong').allTextContents();
    expect(prod1Labels).toContain('新增商品');
    expect(prod1Labels).toContain('更新商品內容或庫存');
    expect(prod1Labels).toContain('更新供貨條件');
    expect(prod1Labels).toContain('公開新的供貨版本');
    expect(prod1Labels).toContain('供貨版本由新版本取代');
    expect(prod1Labels).not.toContain('建立供貨商品庫');

    // Back on overview, 近期變更 lists these as newest rows with current product title
    await navLink(ownerPage, '營運概覽').click();
    await expect(activePage(ownerPage).getByRole('heading', {level: 2, name: '營運概覽', exact: true})).toBeVisible();
    const overviewRows = recentSection.locator('ol.sc-history > li.sc-row');
    await expect(overviewRows).toHaveCount(prod1Labels.length + 1);
    const overviewLabels = await overviewRows.locator('strong').allTextContents();
    expect(overviewLabels.slice(0, prod1Labels.length)).toEqual(prod1Labels);
    expect(overviewLabels[overviewLabels.length - 1]).toBe('建立供貨商品庫');
    for (let i = 0; i < prod1Labels.length; i++) {
      await expect(overviewRows.nth(i)).toContainText(prod1Title);
    }

    // Create a second product and verify its 紀錄 does not show the first product's rows
    const prod2Title = `紅玉紅茶罐 ${suffix}`;
    await openSupplyPage(ownerPage, `${storeA.hash}/supply/products/new`, '新增商品');
    const createForm2 = activePage(ownerPage).getByRole('form', {name: '新增商品', exact: true});
    await createForm2.getByLabel('商品名稱', {exact: true}).fill(prod2Title);
    await createForm2.getByRole('textbox', {name: '說明', exact: true}).fill('日月潭紅玉紅茶');
    await createForm2.getByLabel('供貨單價', {exact: true}).fill('210');
    await createForm2.getByLabel('庫存', {exact: true}).fill('8');
    await createForm2.getByRole('button', {name: '新增商品', exact: true}).click();
    await expect(activePage(ownerPage).getByRole('heading', {level: 2, name: `商品詳情：${prod2Title}`, exact: true})).toBeVisible();

    const prod2HistorySection = activePage(ownerPage)
      .locator('section.sc-section')
      .filter({has: ownerPage.getByRole('heading', {level: 3, name: '紀錄', exact: true})});
    await expect(prod2HistorySection.locator('ol.sc-history > li.sc-row')).toHaveCount(1);
    await expect(prod2HistorySection.locator('ol.sc-history > li.sc-row strong')).toHaveText(['新增商品']);
    await expect(prod2HistorySection).not.toContainText('更新商品內容或庫存');
    await expect(prod2HistorySection).not.toContainText('更新供貨條件');
    await expect(prod2HistorySection).not.toContainText('公開新的供貨版本');
    await expect(prod2HistorySection).not.toContainText(prod1Title);

    // Product 1's 紀錄 still only lists Product 1's rows
    await openSupplyPage(ownerPage, `${storeA.hash}/supply/products/${prod1Id}`, `商品詳情：${prod1Title}`);
    await expect(prod1HistorySection.locator('ol.sc-history > li.sc-row')).toHaveCount(prod1Labels.length);
    await expect(prod1HistorySection).not.toContainText(prod2Title);

    // A member with only store:read sees 無法取得：需要商品編輯權限才能查看 in place of 近期變更 and no change rows
    await inviteMember(ownerPage, viewerPage, e2eAuthPool, storeA, ['store:read']);
    await openSupplyPage(viewerPage, `${storeA.hash}/supply`, '營運概覽');
    const viewerRecentSection = activePage(viewerPage)
      .locator('section.sc-section')
      .filter({has: viewerPage.getByRole('heading', {level: 3, name: '近期變更', exact: true})});
    await expect(viewerRecentSection).toContainText('無法取得：需要商品編輯權限才能查看');
    await expect(viewerRecentSection.locator('ol.sc-history')).toHaveCount(0);
    await expect(viewerRecentSection).not.toContainText('建立供貨商品庫');
    await expect(viewerRecentSection).not.toContainText(prod1Title);
  } finally {
    await Promise.allSettled(contexts.map(ctx => ctx.close()));
    await withdrawSupplierOffers(e2eAuthPool, supplierIds);
  }
});

test('SC-E2E-53 guild block to-do summary per catalog, permission and failure (AT-04,29,39)', async ({browser, baseURL, e2eAuthPool}) => {
  test.setTimeout(240_000);
  const contexts: BrowserContext[] = [];
  const supplierIds: string[] = [];
  const suffix = randomUUID().slice(0, 6);
  const guildKey = 'guild_product_quality_supply';
  const previousOfficer = (
    await e2eAuthPool.query(
      'SELECT user_id FROM positioning_guild_officers WHERE community_id=$1 AND guild_key=$2',
      [DEMO_COMMUNITY, guildKey],
    )
  ).rows[0]?.user_id as string | undefined;
  let ownerIdForOfficerCleanup: string | null = null;
  let ownerPageForCleanup: Page | null = null;
  let originalConfigBody: unknown = null;

  try {
    const ownerCtx = await browser.newContext({baseURL});
    contexts.push(ownerCtx);
    const sellerCtx = await browser.newContext({baseURL});
    contexts.push(sellerCtx);
    const viewerCtx = await browser.newContext({baseURL});
    contexts.push(viewerCtx);

    const ownerMember = await person(e2eAuthPool);
    supplierIds.push(ownerMember.id);
    ownerIdForOfficerCleanup = ownerMember.id;
    const sellerMember = await person(e2eAuthPool);

    const [ownerPage, sellerPage, viewerPage] = await Promise.all([
      ownerCtx.newPage(),
      sellerCtx.newPage(),
      viewerCtx.newPage(),
    ]);
    ownerPageForCleanup = ownerPage;

    await login(ownerPage, ownerMember.email);

    // Ensure ownerMember is an active full member and officer of guild_product_quality_supply
    await e2eAuthPool.query(
      `INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier)
       VALUES($1,$2,$3,$4,'active','full') ON CONFLICT DO NOTHING`,
      [randomUUID(), DEMO_COMMUNITY, ownerMember.id, guildKey],
    );
    await e2eAuthPool.query(
      `INSERT INTO positioning_guild_officers(community_id,guild_key,user_id)
       VALUES($1,$2,$3) ON CONFLICT(community_id,guild_key) DO UPDATE SET user_id=$3`,
      [DEMO_COMMUNITY, guildKey, ownerMember.id],
    );
    const currentConfig = await getJson(ownerPage, `/guilds/${guildKey}/launchpad-config`);
    originalConfigBody = currentConfig.body;
    const v2Body = {
      ...convertV1(currentConfig.body),
      blocks: [
        {
          id: 'supply',
          kind: 'extension' as const,
          extension_id: 'guild-block.supply-catalog.v1',
          order: 0,
          enabled: true,
          title: null,
          settings: {},
        },
        ...currentConfig.body.blocks.map((block: {id: string; kind: string; enabled: boolean; title: string | null}, index: number) => ({
          ...block,
          order: index + 1,
        })),
      ],
    };
    const draftConfig = await post(
      ownerPage,
      `/guilds/${guildKey}/launchpad-config/drafts`,
      {body: v2Body},
      201,
      currentConfig.pointer_version,
    );
    await post(
      ownerPage,
      `/guilds/${guildKey}/launchpad-config/${draftConfig.config_id}/publish`,
      {expected_body_sha256: draftConfig.body_sha256},
      200,
      draftConfig.pointer_version,
    );

    // Set up 1 ready catalog with 1 published offer and 1 pending seller proposal
    const storeA = parseStore(await launchStore(ownerPage, `供貨空間53 ${suffix}`));
    const catalogName = `公會待辦商品庫 ${suffix}`;
    await post(ownerPage, `${storeA.root}/supply-profile`, {name: catalogName, currency: 'TWD'}, 201);
    const prod = await createProductAndPublishInUi(ownerPage, storeA, {
      title: `公會待辦濾杯 ${suffix}`,
      description: '測試公會區塊待辦摘要',
      cost: '160',
      stock: '12',
      shipping: '20',
    });

    await login(sellerPage, sellerMember.email);
    const storeB = parseStore(await launchStore(sellerPage, `賣家空間53 ${suffix}`));
    await post(sellerPage, `${storeB.root}/setup`, {name: `公會待辦選物店 ${suffix}`, slug: `shop53-${suffix}`, currency: 'TWD'}, 201);
    const proposal = await post(sellerPage, `${storeB.root}/distribution-selections`, {
      offer_id: prod.offerId,
      terms_sha256: prod.termsSha256,
      retail_price_minor: 26000,
    }, 201);

    // Owner views the 商品與供貨 block on the supply guild launchpad
    await ownerPage.evaluate(h => {
      window.location.hash = h;
    }, `guilds/${guildKey}`);
    const supplyBlock = ownerPage
      .locator('section.guild-launchpad-block')
      .filter({has: ownerPage.getByRole('heading', {level: 2, name: '商品與供貨', exact: true})});
    await expect(supplyBlock).toBeVisible();
    await expect(supplyBlock).toContainText(catalogName);
    await expect(supplyBlock).toContainText('供貨資料已就緒');
    await expect(supplyBlock).toContainText('待辦：待確認售價申請 1、供貨版本需重新公開 0、缺貨商品 0');

    // Failure: route summary URL to abort('failed') once -> shows 暫時無法讀取待辦。 and no digit; clicking 重新讀取待辦 shows numbers again
    const summaryUrlPattern = `**/api/v1${storeA.root}/supplier-console/summary`;
    await ownerPage.route(summaryUrlPattern, async route => {
      await route.abort('failed');
    });
    await ownerPage.reload();
    await expect(supplyBlock).toBeVisible();
    const errorStatus = supplyBlock.getByText('暫時無法讀取待辦。');
    await expect(errorStatus).toBeVisible();
    expect(((await errorStatus.textContent()) ?? '').replace(catalogName, '')).not.toMatch(/\d/);
    const retryBtn = supplyBlock.getByRole('button', {name: new RegExp(`^重新讀取待辦\\s*：${catalogName}$`)});
    await expect(retryBtn).toBeVisible();

    await ownerPage.unroute(summaryUrlPattern);
    await retryBtn.click();
    await expect(supplyBlock).toContainText('待辦：待確認售價申請 1、供貨版本需重新公開 0、缺貨商品 0');

    // Viewer (store:read only) of the same business sees 需要商品編輯權限才能查看待辦。 and no digits in that line
    const invitedViewer = await inviteMember(ownerPage, viewerPage, e2eAuthPool, storeA, ['store:read']);
    await e2eAuthPool.query(
      `INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier)
       VALUES($1,$2,$3,$4,'active','full') ON CONFLICT DO NOTHING`,
      [randomUUID(), DEMO_COMMUNITY, invitedViewer.member.id, guildKey],
    );
    await viewerPage.evaluate(h => {
      window.location.hash = h;
    }, `guilds/${guildKey}`);
    const viewerBlock = viewerPage
      .locator('section.guild-launchpad-block')
      .filter({has: viewerPage.getByRole('heading', {level: 2, name: '商品與供貨', exact: true})});
    await expect(viewerBlock).toBeVisible();
    await expect(viewerBlock).toContainText(catalogName);
    await expect(viewerBlock).toContainText('供貨資料已就緒');
    const viewerHint = viewerBlock.getByText('需要商品編輯權限才能查看待辦。', {exact: true});
    await expect(viewerHint).toBeVisible();
    expect(await viewerHint.textContent()).not.toMatch(/\d/);

    // Owner accepts the pending proposal in the console -> after reload, the guild block shows 目前沒有待辦。
    await acceptProposalInUi(ownerPage, storeA.hash, proposal.selection_id);
    await ownerPage.evaluate(h => {
      window.location.hash = h;
    }, `guilds/${guildKey}`);
    await ownerPage.reload();
    await expect(supplyBlock).toBeVisible();
    await expect(supplyBlock).toContainText(catalogName);
    await expect(supplyBlock).toContainText('供貨資料已就緒');
    await expect(supplyBlock.getByText('目前沒有待辦。', {exact: true})).toBeVisible();
  } finally {
    try {
      if (originalConfigBody && ownerPageForCleanup) {
        const latest = await getJson(ownerPageForCleanup, `/guilds/${guildKey}/launchpad-config`);
        const restoredDraft = await post(
          ownerPageForCleanup,
          `/guilds/${guildKey}/launchpad-config/drafts`,
          {body: originalConfigBody},
          201,
          latest.pointer_version,
        );
        await post(
          ownerPageForCleanup,
          `/guilds/${guildKey}/launchpad-config/${restoredDraft.config_id}/publish`,
          {expected_body_sha256: restoredDraft.body_sha256},
          200,
          restoredDraft.pointer_version,
        );
      }
    } finally {
      await Promise.allSettled(contexts.map(ctx => ctx.close()));
      await withdrawSupplierOffers(e2eAuthPool, supplierIds);
      if (previousOfficer) {
        await e2eAuthPool.query(
          'UPDATE positioning_guild_officers SET user_id=$3 WHERE community_id=$1 AND guild_key=$2',
          [DEMO_COMMUNITY, guildKey, previousOfficer],
        );
      } else if (ownerIdForOfficerCleanup) {
        await e2eAuthPool.query(
          'DELETE FROM positioning_guild_officers WHERE community_id=$1 AND guild_key=$2 AND user_id=$3',
          [DEMO_COMMUNITY, guildKey, ownerIdForOfficerCleanup],
        );
      }
    }
  }
});

async function withReadyGuildCatalog(page: Page, db: Pool, check: (store: ReturnType<typeof parseStore>, catalogName: string) => Promise<void>) {
  const guildKey = 'guild_product_quality_supply';
  const previousOfficer = (await db.query(
    'SELECT user_id FROM positioning_guild_officers WHERE community_id=$1 AND guild_key=$2',
    [DEMO_COMMUNITY, guildKey],
  )).rows[0]?.user_id as string | undefined;
  let ownerId: string | null = null;
  let originalConfigBody: unknown = null;
  try {
    const owner = await person(db);
    ownerId = owner.id;
    await login(page, owner.email);
    await db.query(
      `INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier)
       VALUES($1,$2,$3,$4,'active','full') ON CONFLICT DO NOTHING`,
      [randomUUID(), DEMO_COMMUNITY, owner.id, guildKey],
    );
    await db.query(
      `INSERT INTO positioning_guild_officers(community_id,guild_key,user_id)
       VALUES($1,$2,$3) ON CONFLICT(community_id,guild_key) DO UPDATE SET user_id=$3`,
      [DEMO_COMMUNITY, guildKey, owner.id],
    );
    const currentConfig = await getJson(page, `/guilds/${guildKey}/launchpad-config`);
    originalConfigBody = currentConfig.body;
    const draft = await post(page, `/guilds/${guildKey}/launchpad-config/drafts`, {body: {
      ...convertV1(currentConfig.body),
      blocks: [
        {id: 'supply', kind: 'extension', extension_id: 'guild-block.supply-catalog.v1', order: 0, enabled: true, title: null, settings: {}},
        ...currentConfig.body.blocks.map((block: {id: string; kind: string; enabled: boolean; title: string | null}, index: number) => ({...block, order: index + 1})),
      ],
    }}, 201, currentConfig.pointer_version);
    await post(page, `/guilds/${guildKey}/launchpad-config/${draft.config_id}/publish`,
      {expected_body_sha256: draft.body_sha256}, 200, draft.pointer_version);

    const suffix = randomUUID().slice(0, 6);
    const store = parseStore(await launchStore(page, `旗標供貨空間 ${suffix}`));
    const catalogName = `旗標供貨商品庫 ${suffix}`;
    await post(page, `${store.root}/supply-profile`, {name: catalogName, currency: 'TWD'}, 201);
    const catalogs = await getJson(page, '/me/supply-catalogs?pagination=cursor');
    expect(catalogs.items).toHaveLength(1);
    expect(catalogs.items[0]).toMatchObject({tenant_id: store.tenantId, instance_id: store.instanceId, setup_state: 'ready'});
    await page.evaluate(key => {window.location.hash = `guilds/${key}`;}, guildKey);
    await check(store, catalogName);
  } finally {
    try {
      if (originalConfigBody) {
        const latest = await getJson(page, `/guilds/${guildKey}/launchpad-config`);
        const restoredDraft = await post(page, `/guilds/${guildKey}/launchpad-config/drafts`,
          {body: originalConfigBody}, 201, latest.pointer_version);
        await post(page, `/guilds/${guildKey}/launchpad-config/${restoredDraft.config_id}/publish`,
          {expected_body_sha256: restoredDraft.body_sha256}, 200, restoredDraft.pointer_version);
      }
    } finally {
      if (previousOfficer) {
        await db.query('UPDATE positioning_guild_officers SET user_id=$3 WHERE community_id=$1 AND guild_key=$2',
          [DEMO_COMMUNITY, guildKey, previousOfficer]);
      } else if (ownerId) {
        await db.query('DELETE FROM positioning_guild_officers WHERE community_id=$1 AND guild_key=$2 AND user_id=$3',
          [DEMO_COMMUNITY, guildKey, ownerId]);
      }
    }
  }
}

test.describe('supplier console off', () => {
  test.use({memberFeatures: {guildLaunchpadEnabled: true, hostedReservationsEnabled: true}});

  test('SC-E2E-55 guild block sends no to-do read when the supplier console is off (AT-44)', async ({page, e2eAuthPool}) => {
    const summaries: string[] = [];
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (path.endsWith('/supplier-console/summary')) summaries.push(path);
    });
    await withReadyGuildCatalog(page, e2eAuthPool, async (_store, catalogName) => {
      expect((await getJson(page, '/site')).supplier_console_enabled).toBe(false);
      const item = page.locator('section.guild-launchpad-block li').filter({has: page.getByRole('button', {name: catalogName, exact: true})});
      await expect(item).toBeVisible();
      await expect(item).toContainText('供貨資料已就緒');
      await page.evaluate(async () => {
        await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
        await fetch('/api/v1/site', {credentials: 'same-origin'});
      });
      expect(summaries).toEqual([]);
      await expect(item).not.toContainText('正在讀取待辦…');
      await expect(item).not.toContainText('待辦');
      await expect(item.getByRole('button', {name: catalogName, exact: true})).toBeEnabled();
      await expect(page.getByRole('button', {name: '開始供貨設定', exact: true})).toBeVisible();
    });
  });
});

test('SC-E2E-56 guild block reads the to-do summary once per ready catalog when the console is on (AT-04,39)', async ({page, e2eAuthPool}) => {
  const summaries: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/supplier-console/summary')) summaries.push(path);
  });
  await withReadyGuildCatalog(page, e2eAuthPool, async (store, catalogName) => {
    expect((await getJson(page, '/site')).supplier_console_enabled).toBe(true);
    const item = page.locator('section.guild-launchpad-block li').filter({has: page.getByRole('button', {name: catalogName, exact: true})});
    await expect(item).toBeVisible();
    await expect(item).toContainText('供貨資料已就緒');
    await page.evaluate(async () => {
      await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
      await fetch('/api/v1/site', {credentials: 'same-origin'});
    });
    expect(summaries).toEqual([`/api/v1${store.root}/supplier-console/summary`]);
    await expect(item.getByText('目前沒有待辦。', {exact: true})).toBeVisible();
  });
});

async function assertS2LayoutAtViewports(
  page: Page,
  info: TestInfo,
  pageKey: string,
  expectedHeading: string,
  checkFilterControlsAtNarrow: boolean,
) {
  for (const viewport of [
    {width: 390, height: 844},
    {width: 1440, height: 900},
  ] as const) {
    await page.setViewportSize(viewport);
    await expect(consoleRoot(page)).toBeVisible();
    await expect(activePage(page).locator('h2').first()).toHaveText(expectedHeading);
    await expect(consoleRoot(page)).not.toContainText('正在讀取');

    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(noOverflow, `[${pageKey} ${viewport.width}x${viewport.height}] horizontal overflow`).toBe(true);

    if (checkFilterControlsAtNarrow && viewport.width === 390) {
      const controlFontSizes = await page.evaluate(() => {
        const form = document.querySelector('form[aria-label="篩選預留"]');
        if (!form) return [];
        const controls = Array.from(form.querySelectorAll('select, input'));
        return controls.map(el => ({
          tag: el.tagName,
          fontSize: parseFloat(window.getComputedStyle(el).fontSize) || 0,
        }));
      });
      expect(controlFontSizes.length).toBeGreaterThanOrEqual(5);
      for (const ctrl of controlFontSizes) {
        expect(ctrl.fontSize, `[${pageKey} 390] filter control ${ctrl.tag} font-size`).toBeGreaterThanOrEqual(16);
      }
    }

    if (viewport.width === 1440) {
      const inlineButtons = await page.evaluate(() => {
        const active = document.querySelector('.sc-content > [data-sc-active="true"]');
        if (!active) return [];
        const isVisible = (el: Element) => {
          const cs = window.getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        return Array.from(active.querySelectorAll('.btn-small'))
          .filter(isVisible)
          .map(btn => {
            const container = btn.closest('.sc-row, .sc-section, .sc-read-status, form') ?? active;
            const btnRect = btn.getBoundingClientRect();
            const containerRect = container.getBoundingClientRect();
            return {
              text: (btn.textContent || '').trim().slice(0, 30),
              btnWidth: btnRect.width,
              containerWidth: containerRect.width,
            };
          });
      });
      expect(inlineButtons.length).toBeGreaterThan(0);
      for (const b of inlineButtons) {
        expect(
          b.btnWidth,
          `[${pageKey} 1440] inline .btn-small "${b.text}" should not be wider than its row/container`,
        ).toBeLessThan(b.containerWidth);
      }
    }

    await page.screenshot({
      path: info.outputPath(`s2-${pageKey}-${viewport.width}x${viewport.height}.png`),
      fullPage: true,
    });
  }
}

test('SC-E2E-54 S2 pages fit narrow and wide screens', async ({browser, baseURL, e2eAuthPool}, info) => {
  test.setTimeout(240_000);
  const contexts: BrowserContext[] = [];
  const supplierIds: string[] = [];
  const suffix = randomUUID().slice(0, 6);

  try {
    const ownerCtx = await browser.newContext({baseURL});
    contexts.push(ownerCtx);
    const sellerCtx = await browser.newContext({baseURL});
    contexts.push(sellerCtx);
    const buyerCtx = await browser.newContext({baseURL});
    contexts.push(buyerCtx);

    const ownerMember = await person(e2eAuthPool);
    supplierIds.push(ownerMember.id);
    const sellerMember = await person(e2eAuthPool);
    const buyerMember = await person(e2eAuthPool);

    const [ownerPage, sellerPage, buyerPage] = await Promise.all([
      ownerCtx.newPage(),
      sellerCtx.newPage(),
      buyerCtx.newPage(),
    ]);

    await login(ownerPage, ownerMember.email);
    const storeA = parseStore(await launchStore(ownerPage, `供貨空間54 ${suffix}`));
    await post(ownerPage, `${storeA.root}/supply-profile`, {name: `版面檢視商品庫 ${suffix}`, currency: 'TWD'}, 201);
    const prod = await createProductAndPublishInUi(ownerPage, storeA, {
      title: `版面檢視咖啡豆 ${suffix}`,
      description: '窄寬螢幕版面檢視商品',
      cost: '180',
      stock: '15',
      shipping: '20',
    });
    await enableSupplierReservationsInUi(ownerPage);

    const shopName = `版面檢視選物店 ${suffix}`;
    const shopSlug = `shop54-${suffix}`;
    await login(sellerPage, sellerMember.email);
    const storeB = parseStore(await launchStore(sellerPage, `賣家空間54 ${suffix}`));
    await post(sellerPage, `${storeB.root}/setup`, {name: shopName, slug: shopSlug, currency: 'TWD'}, 201);
    const prop = await post(sellerPage, `${storeB.root}/distribution-selections`, {
      offer_id: prod.offerId,
      terms_sha256: prod.termsSha256,
      retail_price_minor: 28000,
    }, 201);

    await acceptProposalInUi(ownerPage, storeA.hash, prop.selection_id);
    await publishAndEnableSellerStore(sellerPage, storeB.root);

    const partnerId = (
      await e2eAuthPool.query('SELECT storefront_shop_id FROM commerce_storefront_profiles WHERE instance_id=$1', [storeB.instanceId])
    ).rows[0].storefront_shop_id as string;

    await login(buyerPage, buyerMember.email);
    const order = await createBuyerReservation(buyerPage, shopSlug, [{sku: prod.sku, quantity: 2}]);

    // 1. Filtered reservations list
    await openSupplyPage(
      ownerPage,
      `${storeA.hash}/supply/reservations?state=reserved&partner=${partnerId}`,
      '預留與訂單',
    );
    await expect(activePage(ownerPage)).toContainText('符合條件：1 筆預留、1 個供貨行項');
    await assertS2LayoutAtViewports(ownerPage, info, 'reservations-list', '預留與訂單', true);

    // 2. Reservation detail
    await openSupplyPage(ownerPage, `${storeA.hash}/supply/reservations/${order.order_id}`, '預留明細');
    await expect(activePage(ownerPage)).toContainText(prod.sku);
    await assertS2LayoutAtViewports(ownerPage, info, 'reservation-detail', '預留明細', false);

    // 3. Overview with 近期變更
    await openSupplyPage(ownerPage, `${storeA.hash}/supply`, '營運概覽');
    await expect(
      activePage(ownerPage)
        .locator('section.sc-section')
        .filter({has: ownerPage.getByRole('heading', {level: 3, name: '近期變更', exact: true})})
        .locator('ol.sc-history > li.sc-row')
        .first(),
    ).toBeVisible();
    await assertS2LayoutAtViewports(ownerPage, info, 'overview-changes', '營運概覽', false);

    // 4. Partner detail with 相關預留
    await openSupplyPage(ownerPage, `${storeA.hash}/supply/partners/${partnerId}`, '合作店家詳情');
    await expect(
      activePage(ownerPage)
        .locator('section.sc-section')
        .filter({has: ownerPage.getByRole('heading', {level: 4, name: '相關預留', exact: true})})
        .locator('ul.sc-history > li.sc-row')
        .first(),
    ).toBeVisible();
    await assertS2LayoutAtViewports(ownerPage, info, 'partner-reservations', '合作店家詳情', false);
  } finally {
    await Promise.allSettled(contexts.map(ctx => ctx.close()));
    await withdrawSupplierOffers(e2eAuthPool, supplierIds);
  }
});
