import {randomUUID} from 'node:crypto';
import {digest} from '../../packages/db/index.js';
import {navigate} from './navigation.js';
import type {Pool} from 'pg';
import type {BrowserContext, Page} from '@playwright/test';
import {test, expect} from './member-feature-fixture.js';
import {person, login, post, launchStore, storeArea} from './hosted-store-fixture.js';

test.use({
  memberFeatures: {
    guildLaunchpadEnabled: true,
    hostedReservationsEnabled: true,
    supplierConsoleEnabled: true,
  },
});

function parseStore(store: {root: string; hash: string}) {
  const [, , tenantId, , instanceId] = store.root.split('/');
  return {root: store.root, hash: store.hash, tenantId, instanceId};
}

async function patch(page: Page, path: string, body: unknown, status: number, version?: string) {
  const session = await (await page.request.get('/api/v1/session')).json();
  const response = await page.request.patch(`/api/v1${path}`, {
    data: body,
    headers: {
      Origin: new URL(page.url()).origin,
      'X-CSRF-Token': session.csrf_token,
      'Idempotency-Key': randomUUID(),
      ...(version ? {'If-Match': `"${version}"`} : {}),
    },
  });
  const result = await response.json();
  expect(response.status(), JSON.stringify(result)).toBe(status);
  return result;
}

const panel = (p: Page) => p.locator('.hosted-distribution');
async function expand(p: Page, label: string) {
  if (await p.getByRole('navigation', {name: '商店工作區', exact: true}).count()) await storeArea(p, '供貨合作');
  const section = panel(p).locator('details').filter({has: p.locator('summary').filter({hasText: label})});
  if (await section.getAttribute('open') === null) await section.locator('summary').click();
  return section;
}

const activePage = (page: Page) => page.locator('[data-sc-active="true"]');

async function openSupplyPage(page: Page, hash: string, expectedHeading?: string) {
  const targetHash = hash.startsWith('#') ? hash : `#${hash}`;
  await page.evaluate(h => { window.location.hash = h; }, targetHash);
  await expect(page.locator('.supplier-console')).toBeVisible();
  if (expectedHeading) {
    await expect(activePage(page).locator('h2').first()).toHaveText(expectedHeading);
  }
}

async function withdrawSupplierOffers(db: Pool, supplierUserIds: string[]) {
  if (!supplierUserIds.length) return;
  await db.query(`UPDATE commerce_hosted_supply_offers o
    SET state='withdrawn',version=o.version+1
    FROM commerce_storefront_profiles p JOIN commerce_shops s ON s.shop_id=p.supply_shop_id
    WHERE o.instance_id=p.instance_id AND o.tenant_id=p.tenant_id
      AND s.owner_id=ANY($1::uuid[]) AND o.state='offered'`, [supplierUserIds]);
}

test('SC-E2E-10 same-name shops stay separate; accept one, decline the other with confirmation (AT-12,14,16)', async ({browser, baseURL, e2eAuthPool}, testInfo) => {
  test.setTimeout(120_000);
  const contexts: BrowserContext[] = [];
  const supplierIds: string[] = [];
  const suffix = randomUUID().slice(0, 6);

  try {
    // 1. Prepare supplier A
    const ctxA = await browser.newContext({baseURL});
    contexts.push(ctxA);
    const memberA = await person(e2eAuthPool);
    supplierIds.push(memberA.id);
    const pageA = await ctxA.newPage();
    await login(pageA, memberA.email);

    const rawStoreA = await launchStore(pageA, `供貨空間 ${suffix}`);
    const storeA = parseStore(rawStoreA);
    await post(pageA, storeA.root + '/supply-profile', {name: `供貨目錄 ${suffix}`, currency: 'TWD'}, 201);
    const product = await post(pageA, storeA.root + '/supply-products', {
      title: `共用茶壺 ${suffix}`,
      description: '優質茶壺',
      cost_minor: 400,
      stock: 10,
    }, 201);
    const terms = await patch(pageA, storeA.root + `/products/${product.product_id}/supply-terms`, {
      cost_minor: 400,
      shipping_minor: 50,
      shipping_terms: '確認後三天內出貨',
      return_terms: '瑕疵由供貨方處理',
    }, 200, product.version);
    const offer = await post(pageA, storeA.root + `/products/${product.product_id}/supply-offer`, {}, 200, terms.version);

    // 2. Prepare sellers B and C with SAME shop display name
    const shopName = `日常選物 ${suffix}`;

    // Seller B
    const ctxB = await browser.newContext({baseURL});
    contexts.push(ctxB);
    const memberB = await person(e2eAuthPool);
    const pageB = await ctxB.newPage();
    await login(pageB, memberB.email);
    const rawStoreB = await launchStore(pageB, `賣家空間 B ${suffix}`);
    const storeB = parseStore(rawStoreB);
    await post(pageB, storeB.root + '/setup', {name: shopName, slug: `shop-b-${suffix}`, currency: 'TWD'}, 201);
    const propB = await post(pageB, storeB.root + '/distribution-selections', {
      offer_id: offer.offer_id,
      terms_sha256: offer.terms_sha256,
      retail_price_minor: 1100,
    }, 201);

    // Seller C
    const ctxC = await browser.newContext({baseURL});
    contexts.push(ctxC);
    const memberC = await person(e2eAuthPool);
    const pageC = await ctxC.newPage();
    await login(pageC, memberC.email);
    const rawStoreC = await launchStore(pageC, `賣家空間 C ${suffix}`);
    const storeC = parseStore(rawStoreC);
    await post(pageC, storeC.root + '/setup', {name: shopName, slug: `shop-c-${suffix}`, currency: 'TWD'}, 201);
    const propC = await post(pageC, storeC.root + '/distribution-selections', {
      offer_id: offer.offer_id,
      terms_sha256: offer.terms_sha256,
      retail_price_minor: 1300,
    }, 201);

    const partnerBId = (await e2eAuthPool.query('SELECT storefront_shop_id FROM commerce_storefront_profiles WHERE instance_id=$1', [storeB.instanceId])).rows[0].storefront_shop_id;
    const partnerCId = (await e2eAuthPool.query('SELECT storefront_shop_id FROM commerce_storefront_profiles WHERE instance_id=$1', [storeC.instanceId])).rows[0].storefront_shop_id;
    expect(partnerBId).not.toBe(partnerCId);

    // 3. A's overview todo lists two requests distinguished by shop ID
    await openSupplyPage(pageA, `${storeA.hash}/supply`, '營運概覽');
    await expect(pageA.locator('.sc-metrics').getByText('待確認售價申請').locator('..').locator('.sc-metric-value')).toHaveText('2');

    const todoItems = activePage(pageA).locator('.sc-list li');
    await expect(todoItems).toHaveCount(2);

    const labelB = `${shopName}（店家 ID …${partnerBId.slice(-6)}）`;
    const labelC = `${shopName}（店家 ID …${partnerCId.slice(-6)}）`;

    const todoB = todoItems.filter({hasText: labelB});
    await expect(todoB).toBeVisible();
    await expect(todoB).toContainText('待確認售價申請');
    await expect(todoB.getByRole('link', {name: '審核', exact: true})).toBeVisible();

    const todoC = todoItems.filter({hasText: labelC});
    await expect(todoC).toBeVisible();
    await expect(todoC).toContainText('待確認售價申請');
    await expect(todoC.getByRole('link', {name: '審核', exact: true})).toBeVisible();

    for (const width of [1440, 768, 390]) {
      await pageA.setViewportSize({width, height: 900});
      expect(await pageA.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await pageA.screenshot({path: testInfo.outputPath(`overview-todos-${width}.png`)});
    }
    await pageA.setViewportSize({width: 1440, height: 900});

    // 4. 合作店家 lists two rows with that name and different IDs
    await pageA.getByRole('navigation', {name: '營運中心', exact: true}).getByRole('link', {name: '合作店家', exact: true}).click();
    await expect(activePage(pageA).locator('h2')).toHaveText('合作店家');

    const partnerRows = activePage(pageA).locator('.sc-list li');
    await expect(partnerRows).toHaveCount(2);

    const rowB = partnerRows.filter({hasText: labelB});
    await expect(rowB).toBeVisible();
    await expect(rowB).toContainText('待確認 1／可售 0／需修改 0／停用 0');

    const rowC = partnerRows.filter({hasText: labelC});
    await expect(rowC).toBeVisible();
    await expect(rowC).toContainText('待確認 1／可售 0／需修改 0／停用 0');

    // 5. Each partner detail lists only its own request
    await rowB.getByRole('link', {name: labelB, exact: true}).click();
    await expect(activePage(pageA).locator('h2')).toHaveText('合作店家詳情');
    await expect(activePage(pageA).locator('h3')).toHaveText(labelB);
    const detailListB = activePage(pageA).locator('.sc-list');
    await expect(detailListB.getByText('$11.00')).toBeVisible();
    await expect(detailListB.getByText('$13.00')).toHaveCount(0);

    await pageA.getByRole('link', {name: '返回合作店家', exact: true}).click();
    await expect(activePage(pageA).locator('h2')).toHaveText('合作店家');
    await partnerRows.filter({hasText: labelC}).getByRole('link', {name: labelC, exact: true}).click();
    await expect(activePage(pageA).locator('h2')).toHaveText('合作店家詳情');
    await expect(activePage(pageA).locator('h3')).toHaveText(labelC);
    const detailListC = activePage(pageA).locator('.sc-list');
    await expect(detailListC.getByText('$13.00')).toBeVisible();
    await expect(detailListC.getByText('$11.00')).toHaveCount(0);

    // 6. A accepts B on its review page (同意 → 可售)
    await openSupplyPage(pageA, `${storeA.hash}/supply/terms/${propB.selection_id}`, '審核售價申請');
    await expect(activePage(pageA).getByText('$11.00')).toBeVisible();
    await expect(activePage(pageA).locator('.badge').filter({hasText: '待確認'})).toBeVisible();
    await pageA.getByRole('button', {name: '同意', exact: true}).click();
    await expect(activePage(pageA).locator('.badge').filter({hasText: '可售'})).toBeVisible();
    await expect(pageA.locator('.sc-announcement')).toContainText('已保存：同意售價申請');

    // 7. A declines C (不同意 → dialog → the dialog's 取消 keeps the request pending and returns focus to 不同意; then 確認不同意 → 未同意)
    await openSupplyPage(pageA, `${storeA.hash}/supply/terms/${propC.selection_id}`, '審核售價申請');
    await expect(activePage(pageA).getByText('$13.00')).toBeVisible();
    await expect(activePage(pageA).locator('.badge').filter({hasText: '待確認'})).toBeVisible();

    const declineBtn = pageA.getByRole('button', {name: '不同意', exact: true});
    await declineBtn.click();

    const declineDialog = pageA.locator('dialog[open]');
    await expect(declineDialog).toBeVisible();
    await expect(declineDialog.getByRole('heading', {name: '確認不同意這版售價申請', exact: true})).toBeVisible();
    await expect(declineDialog.getByText('這間店需重新提出申請，才能再請你確認。')).toBeVisible();

    // Dialog 取消: keeps request pending, returns focus to 不同意
    await declineDialog.getByRole('button', {name: '取消', exact: true}).click();
    await expect(declineDialog).toHaveCount(0);
    await expect(declineBtn).toBeFocused();
    await expect(activePage(pageA).locator('.badge').filter({hasText: '待確認'})).toBeVisible();

    // Now confirm decline
    await declineBtn.click();
    await expect(declineDialog).toBeVisible();
    await declineDialog.getByRole('button', {name: '確認不同意', exact: true}).click();
    await expect(pageA.locator('.sc-announcement')).toContainText('已保存：不同意售價申請');
    await expect(activePage(pageA).locator('.badge').filter({hasText: '未同意'})).toBeVisible();

    // 8. The terms page still shows C under its history list
    await pageA.getByRole('link', {name: '返回供貨條件與審核', exact: true}).click();
    await expect(activePage(pageA).locator('h2')).toHaveText('供貨條件與審核');
    await expect(activePage(pageA).getByRole('heading', {name: '待確認申請', exact: true})).toBeVisible();
    await expect(activePage(pageA).getByText('目前沒有申請。')).toBeVisible();

    const declinedItemC = activePage(pageA).locator('.sc-row').filter({hasText: '$13.00'});
    await expect(declinedItemC).toBeVisible();
    await expect(declinedItemC.locator('.badge')).toHaveText('未同意');

    const acceptedItemB = activePage(pageA).locator('.sc-row').filter({hasText: '$11.00'});
    await expect(acceptedItemB).toBeVisible();
    await expect(acceptedItemB.locator('.badge')).toHaveText('可售');

    // 9. B is sellable (B's store can publish); C is not
    await pageB.goto(`/#stores/${storeB.tenantId}/${storeB.instanceId}`);
    await storeArea(pageB, '店面與發布');
    const publishBtnB = pageB.getByRole('button', {name: '發布展示頁', exact: true});
    await expect(publishBtnB).toBeEnabled();
    await publishBtnB.click();
    await expect(pageB.locator('.hosted-store > [role="status"]')).toContainText('已發布展示頁');

    const pubResB = await pageB.request.get(`/api/v1/public/stores/shop-b-${suffix}`);
    expect(pubResB.status()).toBe(200);
    const pubDataB = await pubResB.json();
    expect(pubDataB.products[0].price_minor).toBe(1100);

    await pageC.goto(`/#stores/${storeC.tenantId}/${storeC.instanceId}`);
    await storeArea(pageC, '店面與發布');
    const publishBtnC = pageC.getByRole('button', {name: '發布展示頁', exact: true});
    await expect(publishBtnC).toBeDisabled();
  } finally {
    await Promise.allSettled(contexts.map(ctx => ctx.close()));
    await withdrawSupplierOffers(e2eAuthPool, supplierIds);
  }
});

test('SC-E2E-11 a reprice needs new consent; withdrawing consent keeps history (AT-13,14)', async ({browser, baseURL, e2eAuthPool}) => {
  test.setTimeout(120_000);
  const contexts: BrowserContext[] = [];
  const supplierIds: string[] = [];
  const suffix = randomUUID().slice(0, 6);

  try {
    // 1. Supplier A setup
    const ctxA = await browser.newContext({baseURL});
    contexts.push(ctxA);
    const memberA = await person(e2eAuthPool);
    supplierIds.push(memberA.id);
    const pageA = await ctxA.newPage();
    await login(pageA, memberA.email);

    const rawStoreA = await launchStore(pageA, `供貨空間 ${suffix}`);
    const storeA = parseStore(rawStoreA);
    await post(pageA, storeA.root + '/supply-profile', {name: `供貨目錄 ${suffix}`, currency: 'TWD'}, 201);
    const product = await post(pageA, storeA.root + '/supply-products', {
      title: `改價茶杯 ${suffix}`,
      description: '可重複調整售價的測試品',
      cost_minor: 400,
      stock: 10,
    }, 201);
    const terms = await patch(pageA, storeA.root + `/products/${product.product_id}/supply-terms`, {
      cost_minor: 400,
      shipping_minor: 50,
      shipping_terms: '三日內出貨',
      return_terms: '瑕疵請聯絡供貨方',
    }, 200, product.version);
    const offer = await post(pageA, storeA.root + `/products/${product.product_id}/supply-offer`, {}, 200, terms.version);

    // 2. Seller B proposes P1 (1100)
    const ctxB = await browser.newContext({baseURL});
    contexts.push(ctxB);
    const memberB = await person(e2eAuthPool);
    const pageB = await ctxB.newPage();
    await login(pageB, memberB.email);
    const rawStoreB = await launchStore(pageB, `零售店 B ${suffix}`);
    const storeB = parseStore(rawStoreB);
    await post(pageB, storeB.root + '/setup', {name: `選品零售 ${suffix}`, slug: `retail-b-${suffix}`, currency: 'TWD'}, 201);
    const propB = await post(pageB, storeB.root + '/distribution-selections', {
      offer_id: offer.offer_id,
      terms_sha256: offer.terms_sha256,
      retail_price_minor: 1100,
    }, 201);

    // 3. A accepts B at price P1 on Review page
    await openSupplyPage(pageA, `${storeA.hash}/supply/terms/${propB.selection_id}`, '審核售價申請');
    await expect(activePage(pageA).getByText('$11.00')).toBeVisible();
    await pageA.getByRole('button', {name: '同意', exact: true}).click();
    await expect(activePage(pageA).locator('.badge').filter({hasText: '可售'})).toBeVisible();

    // Verify B's accepted state in seller store
    const selBeforeReprice = (await (await pageB.request.get(`/api/v1${storeB.root}/distribution-selections`)).json()).items[0];
    expect(selBeforeReprice.state).toBe('sellable');

    // 4. B reprices to P2 (1500) via seller API
    const repriced = await patch(pageB, storeB.root + `/distribution-selections/${selBeforeReprice.selection_id}`, {
      offer_id: offer.offer_id,
      terms_sha256: offer.terms_sha256,
      retail_price_minor: 1500,
    }, 200, selBeforeReprice.version);
    expect(repriced.state).toBe('awaiting_supply_acceptance');

    // 5. A's terms page shows B again as pending with P2 and overview pending count increased
    await openSupplyPage(pageA, `${storeA.hash}/supply`, '營運概覽');
    await expect(pageA.locator('.sc-metrics').getByText('待確認售價申請').locator('..').locator('.sc-metric-value')).toHaveText('1');

    await openSupplyPage(pageA, `${storeA.hash}/supply/terms`, '供貨條件與審核');
    // Earlier acceptance is not presented as covering P2: once the refreshed list shows P2, the one selection is a
    // single pending row, the history list is empty, and nothing on the page still shows it as sellable.
    const rowsB = activePage(pageA).locator('.sc-row').filter({has: pageA.locator(`[data-sc-item="${propB.selection_id}"]`)});
    const pendingRows = activePage(pageA).locator('h3:text-is("待確認申請") + ul.sc-list > .sc-row');
    await expect(pendingRows.filter({hasText: '$15.00'})).toHaveCount(1);
    await expect(rowsB).toHaveCount(1);
    await expect(pendingRows).toHaveCount(1);
    await expect(rowsB).not.toContainText('$11.00');
    await expect(rowsB.locator('.badge')).toHaveText('待確認');
    await expect(activePage(pageA).locator('h3:text-is("其他申請紀錄") + p')).toHaveText('目前沒有申請。');
    await expect(activePage(pageA).locator('.sc-row .badge').filter({hasText: '可售'})).toHaveCount(0);

    // 6. A accepts P2 on review page
    await openSupplyPage(pageA, `${storeA.hash}/supply/terms/${selBeforeReprice.selection_id}`, '審核售價申請');
    await expect(activePage(pageA).getByText('$15.00')).toBeVisible();
    await pageA.getByRole('button', {name: '同意', exact: true}).click();
    await expect(activePage(pageA).locator('.badge').filter({hasText: '可售'})).toBeVisible();

    // 7. Withdraw consent: 撤回同意 → dialog → 確認撤回同意 → state 停用
    const withdrawBtn = pageA.getByRole('button', {name: '撤回同意', exact: true});
    await withdrawBtn.click();

    const withdrawDialog = pageA.locator('dialog[open]');
    await expect(withdrawDialog).toBeVisible();
    await expect(withdrawDialog.getByRole('heading', {name: '確認撤回同意', exact: true})).toBeVisible();
    await expect(withdrawDialog.getByText('撤回後，這版選品不能建立新預留。既有預留與歷史仍保留。')).toBeVisible();

    await withdrawDialog.getByRole('button', {name: '確認撤回同意', exact: true}).click();
    await expect(activePage(pageA).locator('.badge').filter({hasText: '停用'})).toBeVisible();
    await expect(pageA.locator('.sc-announcement')).toContainText('已保存：撤回同意');

    // 8. The row stays in history
    await pageA.getByRole('link', {name: '返回供貨條件與審核', exact: true}).click();
    await expect(activePage(pageA).locator('h2')).toHaveText('供貨條件與審核');
    const revokedItem = activePage(pageA).locator('.sc-row').filter({hasText: '停用'});
    await expect(revokedItem).toBeVisible();
    await expect(revokedItem).toContainText('$15.00');

    // 9. B's selection is no longer sellable (withdrawn state, publish disabled)
    const selAfterRevoke = (await (await pageB.request.get(`/api/v1${storeB.root}/distribution-selections`)).json()).items[0];
    expect(selAfterRevoke.state).toBe('revoked');

    await pageB.goto(`/#stores/${storeB.tenantId}/${storeB.instanceId}`);
    await storeArea(pageB, '供貨合作');
    await pageB.getByRole('button', {name: '更新供貨狀態', exact: true}).click();
    const mySelections = await expand(pageB, '我的選品');
    await expect(mySelections).toContainText('已撤回供貨');

    await storeArea(pageB, '店面與發布');
    const publishBtn = pageB.getByRole('button', {name: '發布展示頁', exact: true});
    await expect(publishBtn).toBeDisabled();
  } finally {
    await Promise.allSettled(contexts.map(ctx => ctx.close()));
    await withdrawSupplierOffers(e2eAuthPool, supplierIds);
  }
});

test('SC-E2E-12 changing terms marks the version outdated and republishing needs new requests (AT-15)', async ({browser, baseURL, e2eAuthPool}) => {
  test.setTimeout(120_000);
  const contexts: BrowserContext[] = [];
  const supplierIds: string[] = [];
  const suffix = randomUUID().slice(0, 6);

  try {
    // 1. Supplier A setup
    const ctxA = await browser.newContext({baseURL});
    contexts.push(ctxA);
    const memberA = await person(e2eAuthPool);
    supplierIds.push(memberA.id);
    const pageA = await ctxA.newPage();
    await login(pageA, memberA.email);

    const rawStoreA = await launchStore(pageA, `供貨業務 ${suffix}`);
    const storeA = parseStore(rawStoreA);
    await post(pageA, storeA.root + '/supply-profile', {name: `供貨目錄 ${suffix}`, currency: 'TWD'}, 201);
    const product = await post(pageA, storeA.root + '/supply-products', {
      title: `更新條件盤 ${suffix}`,
      description: '測試供貨條件版本變更',
      cost_minor: 400,
      stock: 10,
    }, 201);
    const terms = await patch(pageA, storeA.root + `/products/${product.product_id}/supply-terms`, {
      cost_minor: 400,
      shipping_minor: 50,
      shipping_terms: '三日內出貨',
      return_terms: '原件退回',
    }, 200, product.version);
    const offer1 = await post(pageA, storeA.root + `/products/${product.product_id}/supply-offer`, {}, 200, terms.version);

    // 2. Seller B accepted on version 1
    const ctxB = await browser.newContext({baseURL});
    contexts.push(ctxB);
    const memberB = await person(e2eAuthPool);
    const pageB = await ctxB.newPage();
    await login(pageB, memberB.email);
    const shopNameB = `合作品牌店 ${suffix}`;
    const rawStoreB = await launchStore(pageB, `賣家空間 ${suffix}`);
    const storeB = parseStore(rawStoreB);
    await post(pageB, storeB.root + '/setup', {name: shopNameB, slug: `partner-b-${suffix}`, currency: 'TWD'}, 201);
    const propB = await post(pageB, storeB.root + '/distribution-selections', {
      offer_id: offer1.offer_id,
      terms_sha256: offer1.terms_sha256,
      retail_price_minor: 1100,
    }, 201);

    await openSupplyPage(pageA, `${storeA.hash}/supply/terms/${propB.selection_id}`, '審核售價申請');
    await pageA.getByRole('button', {name: '同意', exact: true}).click();
    await expect(activePage(pageA).locator('.badge').filter({hasText: '可售'})).toBeVisible();

    // 3. A edits 供貨單價 on the product page (儲存供貨條件)
    await openSupplyPage(pageA, `${storeA.hash}/supply/products/${product.product_id}`);
    await expect(activePage(pageA).locator('h2').first()).toContainText('商品詳情');

    const termsForm = pageA.getByRole('form', {name: '儲存供貨條件', exact: true});
    await termsForm.getByLabel('供貨單價', {exact: true}).fill('6');
    await termsForm.getByRole('button', {name: '儲存供貨條件', exact: true}).click();
    await expect(pageA.locator('.sc-announcement')).toContainText('已保存：儲存供貨條件');

    // 4. The product shows the needs-republish state
    const offerSection = activePage(pageA).locator('.sc-section').filter({has: pageA.getByRole('heading', {name: '供貨版本', exact: true})});
    await expect(offerSection.locator('.badge')).toHaveText('需要重新公開');

    // 5. The products list filter for outdated versions (?state=outdated) includes it
    await openSupplyPage(pageA, `${storeA.hash}/supply/products?state=outdated`, '商品與庫存');
    const outdatedRow = activePage(pageA).locator('.sc-products tbody tr').filter({hasText: `更新條件盤 ${suffix}`});
    await expect(outdatedRow).toBeVisible();
    await expect(outdatedRow.locator('.badge')).toHaveText('需要重新公開');

    // 6. A opens 公開供貨版本: dialog preview names B among affected shops with its state
    await openSupplyPage(pageA, `${storeA.hash}/supply/products/${product.product_id}`);
    const productOfferSec = activePage(pageA).locator('.sc-section').filter({has: pageA.getByRole('heading', {name: '供貨版本', exact: true})});
    const publishOfferBtn = productOfferSec.getByRole('button', {name: '公開供貨版本', exact: true});
    await publishOfferBtn.click();

    const publishDialog = pageA.locator('dialog[open]');
    await expect(publishDialog).toBeVisible();
    await expect(publishDialog.getByRole('heading', {name: '公開供貨版本的影響', exact: true})).toBeVisible();
    await expect(publishDialog.getByRole('list')).toContainText(shopNameB);
    await expect(publishDialog.getByRole('list')).toContainText('可售');

    // 取消 first (nothing is sent)
    let publishReqSent = false;
    const publishListener = (req: {url: () => string; method: () => string}) => {
      if (req.url().includes('/supply-offer') && req.method() === 'POST') publishReqSent = true;
    };
    pageA.on('request', publishListener);
    await publishDialog.getByRole('button', {name: '取消', exact: true}).click();
    await expect(publishDialog).toHaveCount(0);
    expect(publishReqSent).toBe(false);

    // Then confirm
    await publishOfferBtn.click();
    await expect(publishDialog).toBeVisible();
    await publishDialog.getByRole('button', {name: '確認公開供貨版本', exact: true}).click();
    pageA.off('request', publishListener);

    await expect(pageA.locator('.sc-announcement')).toContainText('已保存：公開供貨版本');
    await expect(productOfferSec.locator('.badge')).toHaveText('公開中');

    // 7. After republishing, B's earlier selection is shown against the old version (selectionState: 供貨版本已撤回)
    const coopSection = activePage(pageA).locator('.sc-section').filter({has: pageA.getByRole('heading', {name: '合作', exact: true})});
    const oldBSelectionRow = coopSection.locator('.sc-row').filter({hasText: shopNameB});
    await expect(oldBSelectionRow.locator('.badge')).toHaveText('供貨版本已撤回');

    // 8. B must send a new request on the new version, which A sees as pending
    const catalog = await (await pageB.request.get(`/api/v1${storeB.root}/supply-catalog`)).json();
    const newOffer = catalog.items.find((o: {product_id: string; terms: {cost_minor: number}}) => o.product_id === product.product_id);
    expect(newOffer).toBeTruthy();
    expect(newOffer.terms.cost_minor).toBe(600);

    const selB = (await (await pageB.request.get(`/api/v1${storeB.root}/distribution-selections`)).json()).items[0];
    await patch(pageB, storeB.root + `/distribution-selections/${selB.selection_id}`, {
      offer_id: newOffer.offer_id,
      terms_sha256: newOffer.terms_sha256,
      retail_price_minor: 1400,
    }, 200, selB.version);

    await openSupplyPage(pageA, `${storeA.hash}/supply/terms`, '供貨條件與審核');
    const newPendingRow = activePage(pageA).locator('.sc-row').filter({hasText: '$14.00'});
    await expect(newPendingRow).toBeVisible();
    await expect(newPendingRow.locator('.badge')).toHaveText('待確認');
  } finally {
    await Promise.allSettled(contexts.map(ctx => ctx.close()));
    await withdrawSupplierOffers(e2eAuthPool, supplierIds);
  }
});

test('SC-E2E-13 a read-only member sees overview and settings without write controls (AT-04,33)', async ({browser, baseURL, e2eAuthPool}) => {
  test.setTimeout(120_000);
  const contexts: BrowserContext[] = [];
  const supplierIds: string[] = [];
  const suffix = randomUUID().slice(0, 6);

  try {
    // 1. Supplier A setup
    const ctxA = await browser.newContext({baseURL});
    contexts.push(ctxA);
    const memberA = await person(e2eAuthPool);
    supplierIds.push(memberA.id);
    const pageA = await ctxA.newPage();
    await login(pageA, memberA.email);

    const catalogName = `唯讀測試供貨庫 ${suffix}`;
    const rawStoreA = await launchStore(pageA, `供貨業務 ${suffix}`);
    const storeA = parseStore(rawStoreA);
    await post(pageA, storeA.root + '/supply-profile', {name: catalogName, currency: 'TWD'}, 201);
    const product = await post(pageA, storeA.root + '/supply-products', {
      title: `展示樣品 ${suffix}`,
      description: '唯讀權限測試品',
      cost_minor: 400,
      stock: 10,
    }, 201);
    const terms = await patch(pageA, storeA.root + `/products/${product.product_id}/supply-terms`, {
      cost_minor: 400,
      shipping_minor: 50,
      shipping_terms: '三日內出貨',
      return_terms: '聯絡供貨方',
    }, 200, product.version);
    await post(pageA, storeA.root + `/products/${product.product_id}/supply-offer`, {}, 200, terms.version);

    // 2. A invites A2 as operator with only store:read
    const ctxA2 = await browser.newContext({baseURL});
    contexts.push(ctxA2);
    const memberA2 = await person(e2eAuthPool);
    const pageA2 = await ctxA2.newPage();
    await login(pageA2, memberA2.email);

    const candidate = await (await pageA.request.get(`/api/v1/tenants/invite-candidates?user_id=${memberA2.id}`)).json();
    const invitation = await post(pageA, `/tenants/${storeA.tenantId}/invitations`, {
      invitee_principal_id: candidate.principal_id,
      role: 'operator',
      instance_capabilities: [{instance_id: storeA.instanceId, capabilities: ['store:read']}],
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    }, 201);
    await post(pageA2, `/tenants/${storeA.tenantId}/invitations/${invitation.invitation_id}/accept`, {}, 200, invitation.version);

    const profileA2 = await (await pageA2.request.get(`/api/v1${storeA.root}/supply-profile`)).json();
    expect(profileA2.capabilities).toEqual(['store:read']);

    // 3. Record every request A2's page sends
    const a2Requests: {method: string; url: string; body?: unknown}[] = [];
    pageA2.on('request', req => {
      if (req.url().includes('/api/v1/')) {
        a2Requests.push({method: req.method(), url: req.url(), body: new URL(req.url()).pathname === '/api/v1/me/client-errors' ? req.postDataJSON() : undefined});
      }
    });

    // 4. A2 opens overview (#stores/<t>/<i>/supply)
    await openSupplyPage(pageA2, `${storeA.hash}/supply`, '營運概覽');
    await expect(pageA2.getByText('目前只有查看商品庫的權限。供貨價與條件不會顯示，需要商品編輯權限才能查看指標與清單。')).toBeVisible();

    const metricsCards = activePage(pageA2).locator('.sc-metrics .card');
    await expect(metricsCards).toHaveCount(4);
    for (const card of await metricsCards.all()) {
      await expect(card.locator('.sc-metric-value')).toContainText('無法取得');
    }
    // 待辦 and 近期變更 each say why they are unavailable, right under their own heading, with no list.
    for (const heading of ['待辦', '近期變更']) {
      const sectionHeading = activePage(pageA2).getByRole('heading', {name: heading, exact: true});
      await expect(sectionHeading).toBeVisible();
      await expect(sectionHeading.locator('xpath=following-sibling::p[1]')).toHaveText('無法取得：需要商品編輯權限才能查看');
    }
    await expect(activePage(pageA2).locator('.sc-history')).toHaveCount(0);

    // No write controls
    await expect(activePage(pageA2).getByRole('link', {name: '新增商品', exact: true})).toHaveCount(0);
    await expect(activePage(pageA2).getByRole('button', {name: '新增商品', exact: true})).toHaveCount(0);

    // 5. Navigation shows only pages A2 may use (no 預留與訂單, no write pages)
    const nav = pageA2.getByRole('navigation', {name: '營運中心', exact: true});
    await expect(nav.getByRole('link', {name: '營運概覽', exact: true})).toBeVisible();
    await expect(nav.getByRole('link', {name: '設定與資料', exact: true})).toBeVisible();

    await expect(nav.getByRole('link', {name: '商品與庫存', exact: true})).toHaveCount(0);
    await expect(nav.getByRole('link', {name: '預留與訂單', exact: true})).toHaveCount(0);
    await expect(nav.getByRole('link', {name: '合作店家', exact: true})).toHaveCount(0);
    await expect(nav.getByRole('link', {name: '供貨條件與審核', exact: true})).toHaveCount(0);

    // 6. Opening …/supply/products, …/supply/terms and …/supply/reservations directly shows permission explanation
    // and no supply prices, terms or reservation lines

    // Products directly
    await openSupplyPage(pageA2, `${storeA.hash}/supply/products`, '商品與庫存');
    await expect(activePage(pageA2).getByText('需要商品編輯權限才能查看。供貨價與條件不會顯示，請聯絡業務空間擁有者。')).toBeVisible();
    await expect(pageA2.locator('.sc-products')).toHaveCount(0);
    await expect(activePage(pageA2).getByText('$4.00')).toHaveCount(0);

    // Terms directly
    await openSupplyPage(pageA2, `${storeA.hash}/supply/terms`, '供貨條件與審核');
    await expect(activePage(pageA2).getByText('需要商品編輯權限才能查看。供貨價與條件不會顯示，請聯絡業務空間擁有者。')).toBeVisible();
    await expect(activePage(pageA2).getByRole('button', {name: '同意', exact: true})).toHaveCount(0);
    await expect(activePage(pageA2).getByRole('button', {name: '不同意', exact: true})).toHaveCount(0);

    // Reservations directly
    await openSupplyPage(pageA2, `${storeA.hash}/supply/reservations`, '預留與訂單');
    await expect(activePage(pageA2).getByText('只有業務空間擁有者可以查看預留')).toBeVisible();
    await expect(activePage(pageA2).getByRole('button', {name: '開放 30 分鐘預留', exact: true})).toHaveCount(0);
    await expect(activePage(pageA2).getByRole('button', {name: '停止接受新預留', exact: true})).toHaveCount(0);

    // 7. Settings shows read-only texts (catalog data and reservation setting)
    await openSupplyPage(pageA2, `${storeA.hash}/supply/settings`, '設定與資料');
    await expect(activePage(pageA2).getByText('你沒有修改商品庫資料的權限，請聯絡業務空間擁有者。')).toBeVisible();
    await expect(activePage(pageA2).getByText(catalogName)).toBeVisible();
    await expect(activePage(pageA2).getByText('幣別：TWD（建立後不可變更）')).toBeVisible();
    await expect(activePage(pageA2).getByText('只有業務空間擁有者可以修改預留設定。')).toBeVisible();
    await expect(activePage(pageA2).getByRole('button', {name: '儲存商品庫資料', exact: true})).toHaveCount(0);
    await expect(activePage(pageA2).getByRole('button', {name: '開放 30 分鐘預留', exact: true})).toHaveCount(0);

    // 8. Assert recorded requests of A2's page.
    // The only POST allowed is the client's own error report for the owner probe a non-owner is refused.
    const reports = a2Requests.filter(r => new URL(r.url).pathname === '/api/v1/me/client-errors');
    for (const report of reports) expect(report.body).toMatchObject({action: 'GET /tenants/:id/storefronts/:id/reservation-setting', http_status: 403});
    const writeRequests = a2Requests.filter(r => !reports.includes(r) && ['POST', 'PATCH', 'PUT', 'DELETE'].includes(r.method));
    expect(writeRequests).toEqual([]);

    // Reads that need product editing or the owner are not even requested.
    const gated = ['/supplier-console/products', '/supplier-console/partners', '/supply-requests', '/supply-offers', '/supply-reservations', '/product-media'];
    expect(a2Requests.filter(r => gated.some(path => new URL(r.url).pathname.includes(path)))).toEqual([]);
  } finally {
    await Promise.allSettled(contexts.map(ctx => ctx.close()));
    await withdrawSupplierOffers(e2eAuthPool, supplierIds);
  }
});

test('SC-E2E-14 a request outside the first 200 opens from every entry and after reload (AT-30,AT-12)', async ({browser, baseURL, e2eAuthPool}, info) => {
  test.setTimeout(150_000);
  const contexts: BrowserContext[] = [], supplierIds: string[] = [];
  const suffix=randomUUID().slice(0,6),title=`清單外茶杯 ${suffix}`,shopName=`目標選物店 ${suffix}`,catalogName=`單筆審核商品庫 ${suffix}`;
  const items=Array.from({length:101},(_,n)=>({item_id:randomUUID(),offer_id:randomUUID(),own_id:randomUUID(),sku:`P${1001+n}`}));
  const clonedSelectionIds:string[]=[];
  let sawCappedReview=false;
  try {
    const ctxA=await browser.newContext({baseURL});contexts.push(ctxA);
    const memberA=await person(e2eAuthPool);supplierIds.push(memberA.id);
    const pageA=await ctxA.newPage();
    await pageA.exposeFunction('recordCappedReview',()=>{sawCappedReview=true;});
    await pageA.addInitScript(()=>{
      new MutationObserver(()=>{
        if(document.body?.textContent?.includes('未在目前的部分清單中'))void (window as unknown as {recordCappedReview:()=>Promise<void>}).recordCappedReview();
      }).observe(document,{subtree:true,childList:true,characterData:true});
    });
    await login(pageA,memberA.email);
    const storeA=parseStore(await launchStore(pageA,`單筆審核供貨空間 ${suffix}`));
    await post(pageA,storeA.root+'/supply-profile',{name:catalogName,currency:'TWD'},201);
    const product=await post(pageA,storeA.root+'/supply-products',{title,description:'清單外申請驗收',cost_minor:400,stock:10},201);
    const terms=await patch(pageA,storeA.root+`/products/${product.product_id}/supply-terms`,
      {cost_minor:400,shipping_minor:50,shipping_terms:'三日內出貨',return_terms:'瑕疵請聯絡供貨方'},200,product.version);
    const offer=await post(pageA,storeA.root+`/products/${product.product_id}/supply-offer`,{},200,terms.version);
    const sellers=[];
    for(let n=0;n<3;n++) {
      const ctx=await browser.newContext({baseURL});contexts.push(ctx);
      const member=await person(e2eAuthPool),page=await ctx.newPage();await login(page,member.email);
      const store=parseStore(await launchStore(page,`單筆審核賣家 ${n} ${suffix}`));
      await post(page,store.root+'/setup',{name:n===0?shopName:`批次選物店 ${n} ${suffix}`,slug:`target-${n}-${suffix}`,currency:'TWD'},201);
      const selection=await post(page,store.root+'/distribution-selections',
        {offer_id:offer.offer_id,terms_sha256:offer.terms_sha256,retail_price_minor:1100+n*100},201);
      sellers.push({page,store,selection});
    }
    const target=sellers[0].selection;
    const partnerId=(await e2eAuthPool.query('SELECT shop_id FROM commerce_selections WHERE selection_id=$1',[target.selection_id])).rows[0].shop_id;
    const label=`${shopName}（店家 ID …${partnerId.slice(-6)}）`;
    const templates=(await e2eAuthPool.query('SELECT * FROM commerce_selections WHERE selection_id=ANY($1::uuid[])',
      [sellers.slice(1).map(s=>s.selection.selection_id)])).rows;
    const selections=items.flatMap((item,n)=>templates.map((source,k)=>{
      const snapshot={...source.snapshot,item_id:item.item_id,offer_id:item.offer_id,sku:item.sku};
      return {...item,selection_id:`00000000-0000-4000-8000-${String(n*2+k+1).padStart(12,'0')}`,
        source_id:source.selection_id,snapshot,hash:digest(snapshot)};
    }));
    clonedSelectionIds.push(...selections.map(s=>s.selection_id));
    const data=JSON.stringify(items),shape=`jsonb_to_recordset($1) AS f(item_id uuid,offer_id uuid,own_id uuid,sku text)`;
    const q=await e2eAuthPool.connect();
    try {
      await q.query('BEGIN');
      await q.query(`INSERT INTO commerce_items(item_id,shop_id,sku,title,description,photo_url,price_minor,shipping_minor,stock,reserved,shipping_terms,return_terms)
        SELECT f.item_id,i.shop_id,f.sku,i.title,i.description,i.photo_url,i.price_minor,i.shipping_minor,i.stock,0,i.shipping_terms,i.return_terms
        FROM ${shape} CROSS JOIN commerce_items i WHERE i.item_id=$2`,[data,product.product_id]);
      await q.query(`INSERT INTO commerce_hosted_supply_offers(offer_id,tenant_id,instance_id,item_id,community_id,supplier_name,source_version,terms,terms_sha256,state,version)
        SELECT f.offer_id,o.tenant_id,o.instance_id,f.item_id,o.community_id,o.supplier_name,o.source_version,o.terms,o.terms_sha256,'withdrawn',o.version
        FROM ${shape} CROSS JOIN commerce_hosted_supply_offers o WHERE o.offer_id=$2`,[data,offer.offer_id]);
      await q.query(`INSERT INTO commerce_selections(selection_id,shop_id,item_id,retail_price_minor,sale_terms,snapshot,listing_sha256,own_retail_enabled)
        SELECT f.own_id,l.shop_id,f.item_id,l.retail_price_minor,l.sale_terms,l.snapshot,l.listing_sha256,l.own_retail_enabled
        FROM ${shape} CROSS JOIN commerce_selections l JOIN commerce_storefront_profiles p ON p.storefront_shop_id=l.shop_id
        WHERE l.item_id=$2 AND p.instance_id=$3`,[data,product.product_id,storeA.instanceId]);
      await q.query(`INSERT INTO commerce_selections(selection_id,shop_id,item_id,retail_price_minor,sale_terms,snapshot,listing_sha256,hosted_offer_id,hosted_sku,acceptance_state,current_acceptance_id)
        SELECT f.selection_id,l.shop_id,f.item_id,l.retail_price_minor,l.sale_terms,f.snapshot,f.hash,f.offer_id,f.sku,'awaiting_supply_acceptance',NULL
        FROM jsonb_to_recordset($1) AS f(selection_id uuid,source_id uuid,item_id uuid,offer_id uuid,sku text,snapshot jsonb,hash text)
        JOIN commerce_selections l ON l.selection_id=f.source_id`,[JSON.stringify(selections)]);
      await q.query('COMMIT');
    }catch(error){await q.query('ROLLBACK');throw error;}finally{q.release();}
    const listResponse=await pageA.request.get('/api/v1'+storeA.root+'/supply-requests');expect(listResponse.status()).toBe(200);
    const list=await listResponse.json();expect(list.items).toHaveLength(200);expect(list.truncated).toBe(true);
    expect(list.items.some((s:{selection_id:string})=>s.selection_id===target.selection_id)).toBe(false);
    const requestPath='/api/v1'+storeA.root+`/supplier-console/requests/${target.selection_id}`;
    const reviewHash=`#${storeA.hash}/supply/terms/${target.selection_id}`;
    const review=activePage(pageA),nav=pageA.getByRole('navigation',{name:'營運中心',exact:true});
    const assertReview=async()=>{
      await expect(review.getByRole('heading',{name:'審核售價申請',exact:true})).toBeVisible();
      await expect(review.getByText(label,{exact:true})).toBeVisible();
      await expect(review.getByText(target.sku,{exact:true})).toBeVisible();
      await expect(review.getByText('$11.00',{exact:true})).toBeVisible();
      await expect(review.getByRole('button',{name:'同意',exact:true})).toBeEnabled();
      await expect(review.getByText('未在目前的部分清單中',{exact:false})).toHaveCount(0);
      expect(new URL(pageA.url()).hash).toBe(reviewHash);
    };
    const openReview=async(action:()=>Promise<unknown>)=>{
      const [response]=await Promise.all([
        pageA.waitForResponse(r=>new URL(r.url()).pathname===requestPath&&r.request().method()==='GET'&&r.status()===200),action(),
      ]);
      const detail=await response.json();expect(detail.request.selection_id).toBe(target.selection_id);
      expect(detail.request.version).toBe(target.version);expect(detail.request.listing_sha256).toBe(target.listing_sha256);
      await assertReview();return detail;
    };

    // All list/detail entry paths are reached through visible navigation and links.
    await navigate(pageA,'我的供貨商品庫');
    await pageA.getByRole('article').filter({has:pageA.getByRole('heading',{name:catalogName,exact:true})})
      .getByRole('link',{name:'查看商品與供貨',exact:true}).click();
    const todo=activePage(pageA).getByRole('listitem').filter({hasText:label});
    await openReview(()=>todo.getByRole('link',{name:'審核',exact:true}).click());
    for(const width of [1440,768,390]) {
      await pageA.setViewportSize({width,height:900});
      expect(await pageA.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await pageA.screenshot({path:info.outputPath(`outside-list-review-${width}.png`),fullPage:true});
    }
    await pageA.setViewportSize({width:1440,height:900});
    await nav.getByRole('link',{name:'商品與庫存',exact:true}).click();
    await activePage(pageA).getByLabel('搜尋商品',{exact:true}).fill('P0001');
    await activePage(pageA).getByRole('table').getByRole('link').click();
    const cooperation=activePage(pageA).locator('.sc-section').filter({has:pageA.getByRole('heading',{name:'合作',exact:true})});
    await openReview(()=>cooperation.getByRole('listitem').filter({hasText:shopName}).getByRole('link',{name:'審核',exact:true}).click());
    await nav.getByRole('link',{name:'合作店家',exact:true}).click();
    await activePage(pageA).getByRole('link',{name:shopName,exact:true}).click();
    await openReview(()=>activePage(pageA).getByRole('listitem').filter({hasText:target.sku}).getByRole('link',{name:'審核',exact:true}).click());
    await review.getByRole('link',{name:'返回供貨條件與審核',exact:true}).click();
    await expect(activePage(pageA).getByText('只顯示部分，完整數量見營運概覽。',{exact:false})).toBeVisible();
    await expect(activePage(pageA).getByRole('link').filter({hasText:shopName})).toHaveCount(0);
    await openReview(()=>pageA.goBack());

    await openReview(()=>pageA.reload());
    await nav.getByRole('link',{name:'設定與資料',exact:true}).click();
    await expect(activePage(pageA).getByRole('heading',{name:'設定與資料',exact:true})).toBeVisible();
    await openReview(()=>pageA.goto('/'+reviewHash));
    const decision=pageA.waitForRequest(r=>new URL(r.url()).pathname==='/api/v1'+storeA.root+`/supply-requests/${target.selection_id}/decision`&&r.method()==='POST');
    const refreshed=pageA.waitForResponse(async r=>new URL(r.url()).pathname===requestPath&&r.request().method()==='GET'&&r.status()===200&&(await r.json()).request.state==='sellable');
    await review.getByRole('button',{name:'同意',exact:true}).click();
    const sent=await decision;
    expect(sent.headers()['if-match']).toBe(`"${target.version}"`);
    expect(sent.postDataJSON()).toEqual({decision:'accepted',listing_sha256:target.listing_sha256});
    await refreshed;
    await expect(pageA.locator('.sc-announcement')).toHaveText('已保存：同意售價申請。');
    await expect(review.locator('.badge')).toHaveText('可售');
    await expect(review.getByText('未在目前的部分清單中',{exact:false})).toHaveCount(0);
    expect(sawCappedReview).toBe(false);
  } finally {
    await Promise.allSettled(contexts.map(ctx=>ctx.close()));
    // Offers are retained by design, so the cloned products stay in this synthetic business with withdrawn offers;
    // only the cloned seller requests are removed.
    try {await e2eAuthPool.query('DELETE FROM commerce_selections WHERE selection_id=ANY($1::uuid[])',[clonedSelectionIds]);}
    finally {await withdrawSupplierOffers(e2eAuthPool,supplierIds);}
  }
});
