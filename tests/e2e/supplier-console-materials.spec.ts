import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {BrowserContext, Page, Request} from '@playwright/test';
import {test, expect as baseExpect} from './member-feature-fixture.js';
import {person, post, launchStore, storeArea} from './hosted-store-fixture.js';
import {DEMO_PASSWORD} from '../../packages/testing/seed.js';
import {FakeObjectStore} from '../../packages/asset-storage/fake-store.js';
import {createSupplyMaterialLifecycle} from '../../modules/assets/supply-material.js';
import {uploadSupplyMaterialFile} from '../../modules/agent-commerce/supplier-console/material-media.js';
import type {Actor} from '../../modules/identity-membership/service.js';
import {photoSourcePng} from '../helpers/hosted-store-photo.js';

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
const partnerMaterials = (page: Page) => page.locator('.partner-materials');

const EMPTY_PARTNER_MATERIALS_TEXT =
  '目前沒有供應商授權給這間店的素材。供應商授權後會出現在這裡；你停止販售或對方撤回後，素材會從這裡移除。';

function parseStore(store: {root: string; hash: string}) {
  const [, , tenantId, , instanceId] = store.root.split('/');
  return {root: store.root, hash: store.hash, tenantId, instanceId};
}

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return {promise, resolve};
}

function signature(request: Request) {
  return {
    method: request.method(),
    path: new URL(request.url()).pathname,
    body: request.postData(),
    key: request.headers()['idempotency-key'],
    version: request.headers()['if-match'] ?? null,
  };
}

async function login(page: Page, email: string) {
  await page.route(url => !['127.0.0.1', 'localhost'].includes(url.hostname), route => route.abort());
  await page.goto('/');
  await page.getByLabel('電子郵件', {exact: true}).fill(email);
  await page.getByLabel('密碼', {exact: true}).fill(DEMO_PASSWORD);
  await page.getByRole('button', {name: '登入', exact: true}).click();
  await expect(page.getByRole('button', {name: '設定', exact: true})).toBeVisible({timeout: 15_000});
}

async function getJson(page: Page, path: string, expectedStatus = 200) {
  const response = await page.request.get(`/api/v1${path}`);
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

async function openSellerCooperation(page: Page, storeHash: string) {
  const targetHash = storeHash.startsWith('#') ? storeHash : `#${storeHash}`;
  await page.evaluate(h => {
    window.location.hash = h;
  }, targetHash);
  await expect(page.locator('.hosted-store')).toBeVisible();
  await storeArea(page, '供貨合作');
  await expect(partnerMaterials(page).getByRole('heading', {level: 3, name: '合作素材', exact: true})).toBeVisible();
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

async function setupSupplierWithProductAndOffer(
  page: Page,
  db: Pool,
  suffix: string,
  productTitle = `供貨茶杯 ${suffix}`,
) {
  const member = await person(db);
  await login(page, member.email);
  const rawStore = await launchStore(page, `供貨空間 ${suffix}`);
  const store = parseStore(rawStore);
  const supplierName = `供貨目錄 ${suffix}`;
  await post(page, `${store.root}/supply-profile`, {name: supplierName, currency: 'TWD'}, 201);
  const created = await post(
    page,
    `${store.root}/supply-products`,
    {
      title: productTitle,
      description: '經授權的商品介紹',
      cost_minor: 400,
      stock: 20,
    },
    201,
  );
  const list = await getJson(page, `${store.root}/supply-products`);
  const item = list.items.find((r: {product_id: string}) => r.product_id === created.product_id);
  const terms = await patchJson(
    page,
    `${store.root}/products/${created.product_id}/supply-terms`,
    {
      cost_minor: 400,
      shipping_minor: 50,
      shipping_terms: '確認後三天內出貨',
      return_terms: '瑕疵由供貨方處理',
    },
    200,
    created.version,
  );
  const offer = await post(page, `${store.root}/products/${created.product_id}/supply-offer`, {}, 200, terms.version);
  return {
    member,
    store,
    supplierName,
    product: {
      productId: created.product_id as string,
      sku: item.sku as string,
      title: productTitle,
    },
    offer,
  };
}

async function setupSellerStore(
  browser: {newContext: (opts: {baseURL?: string}) => Promise<BrowserContext>},
  baseURL: string | undefined,
  db: Pool,
  contexts: BrowserContext[],
  label: string,
  slug: string,
) {
  const ctx = await browser.newContext({baseURL});
  contexts.push(ctx);
  const member = await person(db);
  const page = await ctx.newPage();
  await login(page, member.email);
  const rawStore = await launchStore(page, `${label}空間`);
  const store = parseStore(rawStore);
  await post(page, `${store.root}/setup`, {name: label, slug, currency: 'TWD'}, 201);
  return {ctx, member, page, store, name: label};
}

async function inviteMember(
  ownerPage: Page,
  memberPage: Page,
  db: Pool,
  store: {tenantId: string; instanceId: string},
  capabilities: string[],
  role: 'operator' | 'admin' | 'viewer' = 'operator',
) {
  const member = await person(db);
  await login(memberPage, member.email);
  const candidate = await getJson(ownerPage, `/tenants/invite-candidates?user_id=${member.id}`);
  const invitation = await post(
    ownerPage,
    `/tenants/${store.tenantId}/invitations`,
    {
      invitee_principal_id: candidate.principal_id,
      role,
      instance_capabilities: capabilities.length ? [{instance_id: store.instanceId, capabilities}] : [],
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

async function createCopyMaterialInUi(
  page: Page,
  store: {hash: string},
  input: {title: string; description: string; body: string; productId?: string},
) {
  await openSupplyPage(page, `${store.hash}/supply/materials/new`, '新增素材');
  const form = activePage(page).getByRole('form', {name: '新增素材', exact: true});
  await form.getByLabel('種類').selectOption('copy');
  if (input.productId) {
    await form.getByLabel('素材對象').selectOption(input.productId);
  } else {
    await form.getByLabel('素材對象').selectOption('');
  }
  await form.getByLabel('標題').fill(input.title);
  await form.getByLabel('說明').fill(input.description);
  await form.getByLabel('文案內容').fill(input.body);
  await form.getByRole('button', {name: '建立素材', exact: true}).click();
  await expect(activePage(page).getByRole('heading', {level: 2, name: `素材詳情：${input.title}`, exact: true})).toBeVisible();
  const match = new URL(page.url()).hash.match(/\/supply\/materials\/([0-9a-f-]{36})$/);
  expect(match).not.toBeNull();
  return match![1];
}

test('SC-E2E-60 copy material from creation to partner use, revoke and withdraw (AT-25,26)', async ({
  browser,
  baseURL,
  e2eAuthPool,
}) => {
  test.setTimeout(240_000);
  const contexts: BrowserContext[] = [];
  const supplierIds: string[] = [];
  const suffix = randomUUID().slice(0, 6);

  try {
    const ctxA = await browser.newContext({baseURL});
    contexts.push(ctxA);
    const pageA = await ctxA.newPage();
    const sup = await setupSupplierWithProductAndOffer(pageA, e2eAuthPool, suffix);
    supplierIds.push(sup.member.id);

    const sellerB = await setupSellerStore(browser, baseURL, e2eAuthPool, contexts, `賣家 B ${suffix}`, `seller-b-${suffix}`);
    const propB = await post(
      sellerB.page,
      `${sellerB.store.root}/distribution-selections`,
      {offer_id: sup.offer.offer_id, terms_sha256: sup.offer.terms_sha256, retail_price_minor: 1100},
      201,
    );
    await post(
      pageA,
      `${sup.store.root}/supply-requests/${propB.selection_id}/decision`,
      {decision: 'accepted', listing_sha256: propB.listing_sha256},
      200,
      propB.version,
    );

    const sellerC = await setupSellerStore(browser, baseURL, e2eAuthPool, contexts, `賣家 C ${suffix}`, `seller-c-${suffix}`);
    await post(
      sellerC.page,
      `${sellerC.store.root}/distribution-selections`,
      {offer_id: sup.offer.offer_id, terms_sha256: sup.offer.terms_sha256, retail_price_minor: 1250},
      201,
    );

    const sellerD = await setupSellerStore(browser, baseURL, e2eAuthPool, contexts, `賣家 D ${suffix}`, `seller-d-${suffix}`);

    // Console: 行銷素材 shows empty state
    await openSupplyPage(pageA, `${sup.store.hash}/supply/materials`, '行銷素材');
    await expect(activePage(pageA).getByRole('heading', {level: 3, name: '還沒有行銷素材', exact: true})).toBeVisible();
    await expect(activePage(pageA)).toContainText('使用中 0／200');

    // 新增素材 → 文案, 品牌素材, title/description/body → 建立素材 → detail page
    await activePage(pageA).getByRole('link', {name: '新增素材', exact: true}).click();
    await expect(activePage(pageA).getByRole('heading', {level: 2, name: '新增素材', exact: true})).toBeVisible();

    const title = `春季品牌故事 ${suffix}`;
    const description = `授權店家品牌介紹 ${suffix}`;
    const bodyV1 = `第一版品牌文案：職人手作茶器 ${suffix}`;
    const bodyV2 = `第二版正式文案：嚴選台灣陶土燒製 ${suffix}`;

    const newForm = activePage(pageA).getByRole('form', {name: '新增素材', exact: true});
    await newForm.getByLabel('種類').selectOption('copy');
    await newForm.getByLabel('素材對象').selectOption('');
    await newForm.getByLabel('標題').fill(title);
    await newForm.getByLabel('說明').fill(description);
    await newForm.getByLabel('文案內容').fill(bodyV1);
    await newForm.getByRole('button', {name: '建立素材', exact: true}).click();

    await expect(activePage(pageA).getByRole('heading', {level: 2, name: `素材詳情：${title}`, exact: true})).toBeVisible();
    await expect(pageA).toHaveURL(new RegExp(`#${sup.store.hash}/supply/materials/[0-9a-f-]{36}$`));
    const materialId = new URL(pageA.url()).hash.split('/').pop()!;

    // 內容 shows bodyV1
    const contentSection = activePage(pageA)
      .locator('.sc-section')
      .filter({has: pageA.getByRole('heading', {level: 3, name: '內容', exact: true})});
    await expect(contentSection.locator('.sc-material-copy')).toHaveText(bodyV1);

    // 新版本 → change text → 儲存為新版本 → 版本紀錄 shows 第 2 版 with 目前版本 and 第 1 版 without it
    const newVersionForm = activePage(pageA).getByRole('form', {name: '儲存為新版本', exact: true});
    await newVersionForm.getByLabel('文案內容').fill(bodyV2);
    await newVersionForm.getByRole('button', {name: '儲存為新版本', exact: true}).click();
    await expect(consoleRoot(pageA).locator('.sc-announcement')).toHaveText('已保存：儲存為新版本。');
    await expect(contentSection.locator('.sc-material-copy')).toHaveText(bodyV2);

    const historySection = activePage(pageA)
      .locator('.sc-section')
      .filter({has: pageA.getByRole('heading', {level: 3, name: '版本紀錄', exact: true})});
    const v2Row = historySection.locator('li.sc-row').filter({hasText: '第 2 版'});
    const v1Row = historySection.locator('li.sc-row').filter({hasText: '第 1 版'});
    await expect(v2Row.locator('.badge')).toHaveText('目前版本');
    await expect(v2Row).toContainText(bodyV2);
    await expect(v1Row).toBeVisible();
    await expect(v1Row.locator('.badge')).toHaveCount(0);
    await expect(v1Row).toContainText(bodyV1);

    // 店家授權 lists B (可售) and C (待確認), not D
    const grantSection = activePage(pageA)
      .locator('.sc-section')
      .filter({has: pageA.getByRole('heading', {level: 3, name: '店家授權', exact: true})});
    const partnerFieldset = grantSection.locator('fieldset');
    await expect(partnerFieldset).toContainText(`${sellerB.name} · 可售`);
    await expect(partnerFieldset).toContainText(`${sellerC.name} · 待確認`);
    await expect(partnerFieldset).not.toContainText(sellerD.name);

    const checkboxB = partnerFieldset.getByLabel(`${sellerB.name} · 可售`, {exact: true});
    const checkboxC = partnerFieldset.getByLabel(`${sellerC.name} · 待確認`, {exact: true});
    await partnerFieldset.getByRole('button', {name: '授權給目前所有可售的合作店家（1 間）', exact: true}).click();
    await expect(checkboxB).toBeChecked();
    await expect(checkboxC).not.toBeChecked();

    await partnerFieldset.getByRole('button', {name: '授權選取的店家', exact: true}).click();
    await expect(consoleRoot(pageA).locator('.sc-announcement')).toHaveText('已保存：授權選取的店家。');
    await expect(partnerFieldset).toContainText(`${sellerB.name} · 可售 · 已授權`);
    await expect(grantSection.locator('ul.sc-list li.sc-row').filter({hasText: sellerB.name})).toContainText('已授權');

    // Material list row shows 已授權 1 間店
    await navLink(pageA, '行銷素材').click();
    await expect(activePage(pageA).getByRole('heading', {level: 2, name: '行銷素材', exact: true})).toBeVisible();
    const listRow = activePage(pageA).locator('ul.sc-list li.sc-row').filter({hasText: title});
    await expect(listRow).toContainText('已授權 1 間店');
    await expect(listRow).toContainText('僅授權的合作店家 · 使用中');

    // Seller B opens 供貨合作: 合作素材 shows supplier group, title, current text (version 2 only), 複製文字 works
    await sellerB.ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openSellerCooperation(sellerB.page, sellerB.store.hash);
    const panelB = partnerMaterials(sellerB.page);
    await expect(panelB.getByRole('heading', {level: 4, name: sup.supplierName, exact: true})).toBeVisible();
    await expect(panelB.locator('strong').filter({hasText: title})).toBeVisible();
    await expect(panelB.locator('.partner-material-copy')).toHaveText(bodyV2);
    await expect(panelB).not.toContainText(bodyV1);

    await panelB.getByRole('button', {name: '複製文字', exact: true}).click();
    await expect(panelB.getByRole('status')).toHaveText('已複製。');
    expect(await sellerB.page.evaluate(() => navigator.clipboard.readText())).toBe(bodyV2);

    // Seller C and seller D see the empty text and never the title
    for (const other of [sellerC, sellerD]) {
      await openSellerCooperation(other.page, other.store.hash);
      const otherPanel = partnerMaterials(other.page);
      await expect(otherPanel).toContainText(EMPTY_PARTNER_MATERIALS_TEXT);
      await expect(otherPanel).not.toContainText(title);
      await expect(otherPanel).not.toContainText(bodyV2);
    }

    // Supplier revokes B (dialog) → B after 重新整理 no longer sees the material
    await openSupplyPage(pageA, `${sup.store.hash}/supply/materials/${materialId}`, `素材詳情：${title}`);
    const grantRowB = grantSection.locator('ul.sc-list li.sc-row').filter({hasText: sellerB.name});
    await grantRowB.getByRole('button', {name: '撤銷', exact: true}).click();
    const revokeDialog = pageA.getByRole('dialog', {name: '撤銷店家授權', exact: true});
    await expect(revokeDialog).toBeVisible();
    await revokeDialog.getByRole('button', {name: '確認撤銷', exact: true}).click();
    await expect(consoleRoot(pageA).locator('.sc-announcement')).toHaveText('已保存：撤銷授權。');
    await expect(grantRowB).toContainText('已撤銷');

    await panelB.getByRole('button', {name: '重新整理', exact: true}).click();
    await expect(panelB).toContainText(EMPTY_PARTNER_MATERIALS_TEXT);
    await expect(panelB).not.toContainText(title);

    // Create a second active material so we can verify withdrawn rows sort last
    const activeTitle = `常駐品牌簡介 ${suffix}`;
    await createCopyMaterialInUi(pageA, sup.store, {
      title: activeTitle,
      description: '保持使用中的素材',
      body: `常駐品牌文案 ${suffix}`,
    });

    // Grant B again on the first material, then 撤回素材 (dialog)
    await openSupplyPage(pageA, `${sup.store.hash}/supply/materials/${materialId}`, `素材詳情：${title}`);
    await partnerFieldset.getByRole('button', {name: '授權給目前所有可售的合作店家（1 間）', exact: true}).click();
    await partnerFieldset.getByRole('button', {name: '授權選取的店家', exact: true}).click();
    await expect(consoleRoot(pageA).locator('.sc-announcement')).toHaveText('已保存：授權選取的店家。');

    await panelB.getByRole('button', {name: '重新整理', exact: true}).click();
    await expect(panelB.locator('strong').filter({hasText: title})).toBeVisible();

    const withdrawSection = activePage(pageA)
      .locator('.sc-section')
      .filter({has: pageA.getByRole('heading', {level: 3, name: '撤回素材', exact: true})});
    await withdrawSection.getByRole('button', {name: '撤回素材', exact: true}).click();
    const withdrawDialog = pageA.getByRole('dialog', {name: '永久撤回這個素材', exact: true});
    await expect(withdrawDialog).toBeVisible();
    await withdrawDialog.getByRole('button', {name: '確認撤回素材', exact: true}).click();
    await expect(consoleRoot(pageA).locator('.sc-announcement')).toHaveText('已保存：撤回素材。');

    // Detail shows 已撤回 and no edit/upload/grant controls
    await expect(activePage(pageA).locator('.detail-list')).toContainText('已撤回');
    await expect(activePage(pageA).getByRole('button', {name: '編輯標題與說明', exact: true})).toHaveCount(0);
    await expect(activePage(pageA).getByRole('form', {name: '儲存為新版本', exact: true})).toHaveCount(0);
    await expect(activePage(pageA).getByRole('button', {name: '授權選取的店家', exact: true})).toHaveCount(0);
    await expect(activePage(pageA).getByRole('button', {name: '撤銷', exact: true})).toHaveCount(0);
    await expect(activePage(pageA).getByRole('button', {name: '撤回素材', exact: true})).toHaveCount(0);

    // List shows it last with 已撤回
    await navLink(pageA, '行銷素材').click();
    await expect(activePage(pageA).getByRole('heading', {level: 2, name: '行銷素材', exact: true})).toBeVisible();
    const rows = activePage(pageA).locator('ul.sc-list > li.sc-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText(activeTitle);
    await expect(rows.first()).toContainText('使用中');
    await expect(rows.last()).toContainText(title);
    await expect(rows.last()).toContainText('已撤回');
    await expect(rows.last()).toHaveClass(/sc-material-withdrawn/);

    // Seller B no longer sees it
    await panelB.getByRole('button', {name: '重新整理', exact: true}).click();
    await expect(panelB).toContainText(EMPTY_PARTNER_MATERIALS_TEXT);
    await expect(panelB).not.toContainText(title);
  } finally {
    await withdrawSupplierOffers(e2eAuthPool, supplierIds);
    await Promise.all(contexts.map(c => c.close()));
  }
});

test('SC-E2E-61 file materials say plainly that files are not available here', async ({
  browser,
  baseURL,
  e2eAuthPool,
}) => {
  test.setTimeout(240_000);
  const contexts: BrowserContext[] = [];
  const supplierIds: string[] = [];
  const suffix = randomUUID().slice(0, 6);
  let policyTouched = false;

  try {
    const ctxA = await browser.newContext({baseURL});
    contexts.push(ctxA);
    const pageA = await ctxA.newPage();
    const sup = await setupSupplierWithProductAndOffer(pageA, e2eAuthPool, suffix);
    supplierIds.push(sup.member.id);

    const sellerB = await setupSellerStore(browser, baseURL, e2eAuthPool, contexts, `賣家檔案面板 ${suffix}`, `seller-file-${suffix}`);
    const propB = await post(
      sellerB.page,
      `${sellerB.store.root}/distribution-selections`,
      {offer_id: sup.offer.offer_id, terms_sha256: sup.offer.terms_sha256, retail_price_minor: 1100},
      201,
    );
    await post(
      pageA,
      `${sup.store.root}/supply-requests/${propB.selection_id}/decision`,
      {decision: 'accepted', listing_sha256: propB.listing_sha256},
      200,
      propB.version,
    );

    const imgTitle = `商品主圖 ${suffix}`;
    const vidTitle = `商品短片 ${suffix}`;
    const createdIds: {image: string; video: string} = {image: '', video: ''};

    for (const [kind, title] of [
      ['image', imgTitle],
      ['video', vidTitle],
    ] as const) {
      await openSupplyPage(pageA, `${sup.store.hash}/supply/materials/new`, '新增素材');
      const form = activePage(pageA).getByRole('form', {name: '新增素材', exact: true});
      await form.getByLabel('種類').selectOption(kind);
      await form.getByLabel('素材對象').selectOption(sup.product.productId);
      await form.getByLabel('標題').fill(title);
      await form.getByLabel('說明').fill(`商品素材說明 ${title}`);
      await form.getByRole('button', {name: '建立素材', exact: true}).click();

      await expect(activePage(pageA).getByRole('heading', {level: 2, name: `素材詳情：${title}`, exact: true})).toBeVisible();
      await expect(consoleRoot(pageA).locator('.sc-announcement')).toHaveText('素材已建立，請上傳第一個檔案。');
      const id = new URL(pageA.url()).hash.split('/').pop()!;
      createdIds[kind] = id;

      await expect(activePage(pageA)).toContainText('這個環境未開放素材檔案上傳。');
      await expect(activePage(pageA)).toContainText('尚未上傳檔案');
      await expect(activePage(pageA)).toContainText(
        '業務空間已用 0.0 MB，處理中 0.0 MB，上限 100.0 MB，還可使用 100.0 MB。',
      );
      await expect(activePage(pageA).locator('.detail-list')).toContainText(
        `商品 ${sup.product.sku}・${sup.product.title}`,
      );
    }

    // Capacity card on 行銷素材 list shows real capacity text, and never 0 when the read failed
    await openSupplyPage(pageA, `${sup.store.hash}/supply/materials`, '行銷素材');
    const capacityCard = activePage(pageA)
      .locator('section.card')
      .filter({has: pageA.getByRole('heading', {level: 3, name: '業務空間容量', exact: true})});
    await expect(capacityCard).toContainText(
      '業務空間已用 0.0 MB，處理中 0.0 MB，上限 100.0 MB，還可使用 100.0 MB。',
    );

    let failMaterialsRead = true;
    await pageA.route(`**/api/v1${sup.store.root}/supply-materials`, async route => {
      if (route.request().method() === 'GET' && failMaterialsRead) {
        failMaterialsRead = false;
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({code: 'internal_error', detail: '素材資料目前無法讀取。'}),
        });
        return;
      }
      await route.continue();
    });
    await activePage(pageA).getByRole('button', {name: '更新資料', exact: true}).click();
    await expect(capacityCard).toContainText('目前無法讀取業務空間容量。');
    expect(await capacityCard.textContent()).not.toContain('0');
    await pageA.unroute(`**/api/v1${sup.store.root}/supply-materials`);
    await activePage(pageA).getByRole('button', {name: '重試', exact: true}).click();
    await expect(capacityCard).toContainText(
      '業務空間已用 0.0 MB，處理中 0.0 MB，上限 100.0 MB，還可使用 100.0 MB。',
    );

    // Seed version 1 for both file materials so they can be projected to the granted seller panel in this media-disabled host
    const actor = (
      await e2eAuthPool.query<Actor>(
        `SELECT u.user_id,u.community_id,u.email,u.display_name,u.profession_membership_ref,u.onboarding_required,u.onboarding_completed_at,
                s.token_hash AS session_hash,s.csrf_token
         FROM sessions s JOIN users u USING(user_id)
         WHERE u.user_id=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
         LIMIT 1`,
        [sup.member.id],
      )
    ).rows[0];
    expect(actor).toBeTruthy();
    const fakeStore = new FakeObjectStore();
    const assets = createSupplyMaterialLifecycle(e2eAuthPool, {store: fakeStore});
    const videoStub = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(244)]);

    policyTouched = true;
    await e2eAuthPool.query(
      `UPDATE domain_media_storage_policy
       SET mode='r2_only',persistence_allowed=true,policy_revision='e2e-supply-material-policy',retained_byte_limit=104857600
       WHERE purpose IN ('storefront.supply-material','storefront.supply-material-video')`,
    );
    await uploadSupplyMaterialFile(
      e2eAuthPool,
      actor,
      sup.store.tenantId,
      sup.store.instanceId,
      createdIds.image,
      randomUUID(),
      '1',
      {bytes: photoSourcePng, mime: 'image/png'},
      assets,
      true,
    );
    await uploadSupplyMaterialFile(
      e2eAuthPool,
      actor,
      sup.store.tenantId,
      sup.store.instanceId,
      createdIds.video,
      randomUUID(),
      '1',
      {bytes: videoStub, mime: 'video/mp4'},
      assets,
      true,
    );

    // Grant seller B on both file materials via the console UI
    for (const [kind, title] of [
      ['image', imgTitle],
      ['video', vidTitle],
    ] as const) {
      await openSupplyPage(pageA, `${sup.store.hash}/supply/materials/${createdIds[kind]}`, `素材詳情：${title}`);
      await activePage(pageA).getByRole('button', {name: '更新資料', exact: true}).first().click();
      await expect(activePage(pageA)).toContainText('這個環境未開放素材檔案。');
      await expect(activePage(pageA)).toContainText('這個環境未開放素材檔案上傳。');
      const grantSection = activePage(pageA)
        .locator('.sc-section')
        .filter({has: pageA.getByRole('heading', {level: 3, name: '店家授權', exact: true})});
      await grantSection.getByRole('button', {name: '授權給目前所有可售的合作店家（1 間）', exact: true}).click();
      await grantSection.getByRole('button', {name: '授權選取的店家', exact: true}).click();
      await expect(consoleRoot(pageA).locator('.sc-announcement')).toHaveText('已保存：授權選取的店家。');
    }

    // Seller panel shows both titles with 這個環境尚未開放素材檔案。 and no <img>/<video> element
    await openSellerCooperation(sellerB.page, sellerB.store.hash);
    const panelB = partnerMaterials(sellerB.page);
    const imgCard = panelB.locator('article.card').filter({hasText: imgTitle});
    const vidCard = panelB.locator('article.card').filter({hasText: vidTitle});
    await expect(imgCard).toBeVisible();
    await expect(imgCard).toContainText('這個環境尚未開放素材檔案。');
    await expect(vidCard).toBeVisible();
    await expect(vidCard).toContainText('這個環境尚未開放素材檔案。');
    await expect(panelB.locator('img, video')).toHaveCount(0);
  } finally {
    if (policyTouched) {
      await e2eAuthPool.query(
        `UPDATE domain_media_storage_policy
         SET persistence_allowed=false
         WHERE purpose IN ('storefront.supply-material','storefront.supply-material-video')`,
      );
    }
    await withdrawSupplierOffers(e2eAuthPool, supplierIds);
    await Promise.all(contexts.map(c => c.close()));
  }
});

test('SC-E2E-62 an unknown material command result is retried with the same key (AT-24 UI)', async ({
  browser,
  baseURL,
  e2eAuthPool,
}) => {
  test.setTimeout(240_000);
  const contexts: BrowserContext[] = [];
  const supplierIds: string[] = [];
  const suffix = randomUUID().slice(0, 6);

  try {
    const ctxA = await browser.newContext({baseURL});
    contexts.push(ctxA);
    const pageA = await ctxA.newPage();
    const sup = await setupSupplierWithProductAndOffer(pageA, e2eAuthPool, suffix);
    supplierIds.push(sup.member.id);

    const sellerB = await setupSellerStore(browser, baseURL, e2eAuthPool, contexts, `賣家重試 ${suffix}`, `seller-retry-${suffix}`);
    const propB = await post(
      sellerB.page,
      `${sellerB.store.root}/distribution-selections`,
      {offer_id: sup.offer.offer_id, terms_sha256: sup.offer.terms_sha256, retail_price_minor: 1100},
      201,
    );
    await post(
      pageA,
      `${sup.store.root}/supply-requests/${propB.selection_id}/decision`,
      {decision: 'accepted', listing_sha256: propB.listing_sha256},
      200,
      propB.version,
    );

    const title = `重試素材 ${suffix}`;
    const materialId = await createCopyMaterialInUi(pageA, sup.store, {
      title,
      description: '測試未知結果重試',
      body: `重試文案內容 ${suffix}`,
    });

    // 1. Lose the answer of 授權選取的店家
    const grantRequests: ReturnType<typeof signature>[] = [];
    const grantStatuses: number[] = [];
    await pageA.route(`**/api/v1${sup.store.root}/supply-materials/${materialId}/grants`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      grantRequests.push(signature(route.request()));
      const response = await route.fetch();
      grantStatuses.push(response.status());
      if (grantRequests.length === 1) {
        expect(response.status()).toBe(200);
        await route.abort('failed');
      } else {
        await route.fulfill({response});
      }
    });

    const grantSection = activePage(pageA)
      .locator('.sc-section')
      .filter({has: pageA.getByRole('heading', {level: 3, name: '店家授權', exact: true})});
    await grantSection.getByRole('button', {name: '授權給目前所有可售的合作店家（1 間）', exact: true}).click();
    await grantSection.getByRole('button', {name: '授權選取的店家', exact: true}).click();

    const grantHeldBanner = consoleRoot(pageA)
      .getByRole('status')
      .filter({hasText: '尚未確認原操作的結果：授權選取的店家。請按『重試』確認。'});
    await expect(grantHeldBanner).toBeVisible();
    expect(grantRequests).toHaveLength(1);

    await grantHeldBanner.getByRole('button', {name: '重試', exact: true}).click();
    await expect(consoleRoot(pageA).locator('.sc-announcement')).toHaveText('已保存：授權選取的店家。');
    await expect(grantHeldBanner).toHaveCount(0);

    expect(grantStatuses).toEqual([200, 200]);
    expect(grantRequests).toHaveLength(2);
    expect(grantRequests[0].key).toBeTruthy();
    expect(grantRequests[0].version).toBe('"2"');
    expect(grantRequests[1]).toEqual(grantRequests[0]);

    const activeGrantsAfterGrant = (
      await e2eAuthPool.query<{n: number}>(
        'SELECT count(*)::int AS n FROM supply_material_grants WHERE material_id=$1 AND revoked_at IS NULL',
        [materialId],
      )
    ).rows[0].n;
    expect(activeGrantsAfterGrant).toBe(1);

    // 2. Repeat once with 撤回素材
    const withdrawRequests: ReturnType<typeof signature>[] = [];
    const withdrawStatuses: number[] = [];
    await pageA.route(`**/api/v1${sup.store.root}/supply-materials/${materialId}/withdraw`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      withdrawRequests.push(signature(route.request()));
      const response = await route.fetch();
      withdrawStatuses.push(response.status());
      if (withdrawRequests.length === 1) {
        expect(response.status()).toBe(200);
        await route.abort('failed');
      } else {
        await route.fulfill({response});
      }
    });

    const withdrawSection = activePage(pageA)
      .locator('.sc-section')
      .filter({has: pageA.getByRole('heading', {level: 3, name: '撤回素材', exact: true})});
    await withdrawSection.getByRole('button', {name: '撤回素材', exact: true}).click();
    const withdrawDialog = pageA.getByRole('dialog', {name: '永久撤回這個素材', exact: true});
    await expect(withdrawDialog).toBeVisible();
    await withdrawDialog.getByRole('button', {name: '確認撤回素材', exact: true}).click();

    const withdrawHeldBanner = consoleRoot(pageA)
      .getByRole('status')
      .filter({hasText: '尚未確認原操作的結果：撤回素材。請按『重試』確認。'});
    await expect(withdrawHeldBanner).toBeVisible();
    expect(withdrawRequests).toHaveLength(1);

    await withdrawHeldBanner.getByRole('button', {name: '重試', exact: true}).click();
    await expect(consoleRoot(pageA).locator('.sc-announcement')).toHaveText('已保存：撤回素材。');
    await expect(withdrawHeldBanner).toHaveCount(0);
    await expect(activePage(pageA).locator('.detail-list')).toContainText('已撤回');

    expect(withdrawStatuses).toEqual([200, 200]);
    expect(withdrawRequests).toHaveLength(2);
    expect(withdrawRequests[0].key).toBeTruthy();
    expect(withdrawRequests[0].version).toBe('"3"');
    expect(withdrawRequests[1]).toEqual(withdrawRequests[0]);

    const stateAfterWithdraw = (
      await e2eAuthPool.query<{state: string; active_grants: number}>(
        `SELECT state,
                (SELECT count(*)::int FROM supply_material_grants WHERE material_id=$1 AND revoked_at IS NULL) AS active_grants
         FROM supply_materials WHERE material_id=$1`,
        [materialId],
      )
    ).rows[0];
    expect(stateAfterWithdraw).toEqual({state: 'withdrawn', active_grants: 0});
  } finally {
    await withdrawSupplierOffers(e2eAuthPool, supplierIds);
    await Promise.all(contexts.map(c => c.close()));
  }
});

test('SC-E2E-63 permissions: viewer and admin in the supplier business, viewer in the seller business', async ({
  browser,
  baseURL,
  e2eAuthPool,
}) => {
  test.setTimeout(240_000);
  const contexts: BrowserContext[] = [];
  const supplierIds: string[] = [];
  const suffix = randomUUID().slice(0, 6);

  try {
    const ctxOwnerA = await browser.newContext({baseURL});
    contexts.push(ctxOwnerA);
    const ownerPageA = await ctxOwnerA.newPage();
    const sup = await setupSupplierWithProductAndOffer(ownerPageA, e2eAuthPool, suffix);
    supplierIds.push(sup.member.id);

    const sellerB = await setupSellerStore(browser, baseURL, e2eAuthPool, contexts, `賣家權限 ${suffix}`, `seller-perm-${suffix}`);
    const propB = await post(
      sellerB.page,
      `${sellerB.store.root}/distribution-selections`,
      {offer_id: sup.offer.offer_id, terms_sha256: sup.offer.terms_sha256, retail_price_minor: 1100},
      201,
    );
    await post(
      ownerPageA,
      `${sup.store.root}/supply-requests/${propB.selection_id}/decision`,
      {decision: 'accepted', listing_sha256: propB.listing_sha256},
      200,
      propB.version,
    );

    // Admin in the supplier business (with store:write) can access 行銷素材, create and grant material
    const ctxAdminA = await browser.newContext({baseURL});
    contexts.push(ctxAdminA);
    const adminPageA = await ctxAdminA.newPage();
    await inviteMember(ownerPageA, adminPageA, e2eAuthPool, sup.store, [], 'admin');

    await openSupplyPage(adminPageA, `${sup.store.hash}/supply`, '營運概覽');
    await expect(navLink(adminPageA, '行銷素材')).toBeVisible();

    const secretTitle = `內部授權素材 ${suffix}`;
    const secretBody = `僅限授權賣家讀取的文案內容 ${suffix}`;
    const materialId = await createCopyMaterialInUi(adminPageA, sup.store, {
      title: secretTitle,
      description: '供應商管理員建立的文案',
      body: secretBody,
    });
    const grantSection = activePage(adminPageA)
      .locator('.sc-section')
      .filter({has: adminPageA.getByRole('heading', {level: 3, name: '店家授權', exact: true})});
    await grantSection.getByRole('button', {name: '授權給目前所有可售的合作店家（1 間）', exact: true}).click();
    await grantSection.getByRole('button', {name: '授權選取的店家', exact: true}).click();
    await expect(consoleRoot(adminPageA).locator('.sc-announcement')).toHaveText('已保存：授權選取的店家。');

    // Viewer (store:read) in the supplier business: no 行銷素材 nav item; direct links explain 需要商品編輯權限才能查看 and show no material data
    const ctxViewerA = await browser.newContext({baseURL});
    contexts.push(ctxViewerA);
    const viewerPageA = await ctxViewerA.newPage();
    await inviteMember(ownerPageA, viewerPageA, e2eAuthPool, sup.store, ['store:read'], 'operator');

    await openSupplyPage(viewerPageA, `${sup.store.hash}/supply`, '營運概覽');
    await expect(navLink(viewerPageA, '行銷素材')).toHaveCount(0);

    await openSupplyPage(viewerPageA, `${sup.store.hash}/supply/materials`, '行銷素材');
    await expect(activePage(viewerPageA)).toContainText('需要商品編輯權限才能查看');
    await expect(activePage(viewerPageA)).not.toContainText(secretTitle);
    await expect(activePage(viewerPageA)).not.toContainText(secretBody);

    await openSupplyPage(viewerPageA, `${sup.store.hash}/supply/materials/${materialId}`, '素材詳情');
    await expect(activePage(viewerPageA)).toContainText('需要商品編輯權限才能查看');
    await expect(activePage(viewerPageA)).not.toContainText(secretTitle);
    await expect(activePage(viewerPageA)).not.toContainText(secretBody);

    // Viewer (store:read) in seller B's business sees B's 合作素材 (reads allowed) but no supplier controls
    const ctxViewerB = await browser.newContext({baseURL});
    contexts.push(ctxViewerB);
    const viewerPageB = await ctxViewerB.newPage();
    await inviteMember(sellerB.page, viewerPageB, e2eAuthPool, sellerB.store, ['store:read'], 'operator');

    await openSellerCooperation(viewerPageB, sellerB.store.hash);
    const panelViewerB = partnerMaterials(viewerPageB);
    await expect(panelViewerB.getByRole('heading', {level: 4, name: sup.supplierName, exact: true})).toBeVisible();
    await expect(panelViewerB.locator('strong').filter({hasText: secretTitle})).toBeVisible();
    await expect(panelViewerB.locator('.partner-material-copy')).toHaveText(secretBody);

    await expect(viewerPageB.getByRole('navigation', {name: '營運中心', exact: true})).toHaveCount(0);
    await expect(viewerPageB.getByRole('button', {name: '新增素材', exact: true})).toHaveCount(0);
    await expect(viewerPageB.getByRole('button', {name: '編輯標題與說明', exact: true})).toHaveCount(0);
    await expect(viewerPageB.getByRole('button', {name: '儲存為新版本', exact: true})).toHaveCount(0);
    await expect(viewerPageB.getByRole('button', {name: '授權選取的店家', exact: true})).toHaveCount(0);
    await expect(viewerPageB.getByRole('button', {name: '撤銷', exact: true})).toHaveCount(0);
    await expect(viewerPageB.getByRole('button', {name: '撤回素材', exact: true})).toHaveCount(0);
  } finally {
    await withdrawSupplierOffers(e2eAuthPool, supplierIds);
    await Promise.all(contexts.map(c => c.close()));
  }
});

test('SC-E2E-64 leaving with an unsaved material draft asks first', async ({browser, baseURL, e2eAuthPool}) => {
  test.setTimeout(240_000);
  const contexts: BrowserContext[] = [];
  const supplierIds: string[] = [];
  const suffix = randomUUID().slice(0, 6);

  try {
    const ctxA = await browser.newContext({baseURL});
    contexts.push(ctxA);
    const pageA = await ctxA.newPage();
    const sup = await setupSupplierWithProductAndOffer(pageA, e2eAuthPool, suffix);
    supplierIds.push(sup.member.id);

    // 1. Type into 新增素材, then click console leave link (切換事業)
    await openSupplyPage(pageA, `${sup.store.hash}/supply/materials/new`, '新增素材');
    const newForm = activePage(pageA).getByRole('form', {name: '新增素材', exact: true});
    const draftTitle = `未儲存素材標題 ${suffix}`;
    await newForm.getByLabel('標題').fill(draftTitle);

    const dismissNew = barrier();
    pageA.once('dialog', async dialog => {
      expect(dialog.type()).toBe('confirm');
      expect(dialog.message()).toBe('還有尚未儲存的內容，要離開嗎？');
      await dialog.dismiss();
      dismissNew.resolve();
    });
    await consoleRoot(pageA).getByRole('link', {name: '切換事業', exact: true}).click();
    await dismissNew.promise;
    await expect(pageA).toHaveURL(new RegExp(`#${sup.store.hash}/supply/materials/new$`));
    await expect(newForm.getByLabel('標題')).toHaveValue(draftTitle);

    const acceptNew = barrier();
    pageA.once('dialog', async dialog => {
      expect(dialog.type()).toBe('confirm');
      expect(dialog.message()).toBe('還有尚未儲存的內容，要離開嗎？');
      await dialog.accept();
      acceptNew.resolve();
    });
    await consoleRoot(pageA).getByRole('link', {name: '切換事業', exact: true}).click();
    await acceptNew.promise;
    await expect(pageA).toHaveURL(/#stores\/supply$/);

    // 2. Same for an unsaved 儲存為新版本 text on the detail page
    const savedTitle = `正式素材 ${suffix}`;
    const savedBody = `第一版正式文案 ${suffix}`;
    const materialId = await createCopyMaterialInUi(pageA, sup.store, {
      title: savedTitle,
      description: '測試新版本草稿離開確認',
      body: savedBody,
    });

    const copyForm = activePage(pageA).getByRole('form', {name: '儲存為新版本', exact: true});
    const unsavedBody = `尚未儲存的第二版草稿 ${suffix}`;
    await copyForm.getByLabel('文案內容').fill(unsavedBody);

    const dismissDetail = barrier();
    pageA.once('dialog', async dialog => {
      expect(dialog.type()).toBe('confirm');
      expect(dialog.message()).toBe('還有尚未儲存的內容，要離開嗎？');
      await dialog.dismiss();
      dismissDetail.resolve();
    });
    await consoleRoot(pageA).getByRole('link', {name: '切換事業', exact: true}).click();
    await dismissDetail.promise;
    await expect(pageA).toHaveURL(new RegExp(`#${sup.store.hash}/supply/materials/${materialId}$`));
    await expect(copyForm.getByLabel('文案內容')).toHaveValue(unsavedBody);

    const acceptDetail = barrier();
    pageA.once('dialog', async dialog => {
      expect(dialog.type()).toBe('confirm');
      expect(dialog.message()).toBe('還有尚未儲存的內容，要離開嗎？');
      await dialog.accept();
      acceptDetail.resolve();
    });
    await consoleRoot(pageA).getByRole('link', {name: '切換事業', exact: true}).click();
    await acceptDetail.promise;
    await expect(pageA).toHaveURL(/#stores\/supply$/);
  } finally {
    await withdrawSupplierOffers(e2eAuthPool, supplierIds);
    await Promise.all(contexts.map(c => c.close()));
  }
});

test('SC-E2E-65 material pages fit narrow and wide screens', async ({browser, baseURL, e2eAuthPool}, info) => {
  test.setTimeout(240_000);
  const contexts: BrowserContext[] = [];
  const supplierIds: string[] = [];
  const suffix = randomUUID().slice(0, 6);

  async function assertControlsFontAt390(page: Page, rootSelector: string) {
    const fonts = await page.locator(`${rootSelector} input:not([type="checkbox"]):not([type="radio"]):not([type="file"]), ${rootSelector} select, ${rootSelector} textarea`).evaluateAll(
      elements =>
        elements
          .filter(el => (el as HTMLElement).offsetParent !== null)
          .map(el => parseFloat(getComputedStyle(el).fontSize)),
    );
    expect(fonts.length).toBeGreaterThan(0);
    for (const size of fonts) {
      expect(size).toBeGreaterThanOrEqual(16);
    }
  }

  async function assertSmallButtonsOnDesktop(page: Page, rootSelector: string) {
    const violations = await page.locator(`${rootSelector} .btn-small`).evaluateAll(elements =>
      elements
        .filter(el => (el as HTMLElement).offsetParent !== null)
        .flatMap(el => {
          const btnRect = el.getBoundingClientRect();
          const row = el.closest('.sc-row, .sc-section, .card, .partner-materials') ?? el.parentElement!;
          const rowRect = row.getBoundingClientRect();
          return btnRect.width > rowRect.width || btnRect.width >= rowRect.width * 0.9 ? [{text: el.textContent, btnWidth: btnRect.width, rowWidth: rowRect.width}] : [];
        }),
    );
    expect(violations).toEqual([]);
  }

  try {
    const ctxA = await browser.newContext({baseURL});
    contexts.push(ctxA);
    const pageA = await ctxA.newPage();
    const sup = await setupSupplierWithProductAndOffer(pageA, e2eAuthPool, suffix);
    supplierIds.push(sup.member.id);

    const sellerB = await setupSellerStore(browser, baseURL, e2eAuthPool, contexts, `賣家版面 ${suffix}`, `seller-layout-${suffix}`);
    const propB = await post(
      sellerB.page,
      `${sellerB.store.root}/distribution-selections`,
      {offer_id: sup.offer.offer_id, terms_sha256: sup.offer.terms_sha256, retail_price_minor: 1100},
      201,
    );
    await post(
      pageA,
      `${sup.store.root}/supply-requests/${propB.selection_id}/decision`,
      {decision: 'accepted', listing_sha256: propB.listing_sha256},
      200,
      propB.version,
    );

    const title1 = `版面檢視素材一 ${suffix}`;
    const material1Id = await createCopyMaterialInUi(pageA, sup.store, {
      title: title1,
      description: '包含店家授權與公開店面範圍對話框的素材詳情測試',
      body: `第一筆素材文案內容，確認窄螢幕與寬螢幕排版正常 ${suffix}`,
    });

    const grantSection = activePage(pageA)
      .locator('.sc-section')
      .filter({has: pageA.getByRole('heading', {level: 3, name: '店家授權', exact: true})});
    await grantSection.getByRole('button', {name: '授權給目前所有可售的合作店家（1 間）', exact: true}).click();
    await grantSection.getByRole('button', {name: '授權選取的店家', exact: true}).click();
    await expect(consoleRoot(pageA).locator('.sc-announcement')).toHaveText('已保存：授權選取的店家。');

    await createCopyMaterialInUi(pageA, sup.store, {
      title: `版面檢視素材二 ${suffix}`,
      description: '商品專屬素材列表列顯示測試',
      body: `第二筆商品素材文案內容 ${suffix}`,
      productId: sup.product.productId,
    });

    // 1. 行銷素材 (with rows)
    await openSupplyPage(pageA, `${sup.store.hash}/supply/materials`, '行銷素材');
    await expect(activePage(pageA).locator('ul.sc-list > li.sc-row')).toHaveCount(2);

    await pageA.setViewportSize({width: 390, height: 844});
    expect(await pageA.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await pageA.screenshot({path: info.outputPath('materials-list-390.png'), fullPage: true});

    await pageA.setViewportSize({width: 1440, height: 900});
    expect(await pageA.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await assertSmallButtonsOnDesktop(pageA, '.supplier-console');
    await pageA.screenshot({path: info.outputPath('materials-list-1440.png'), fullPage: true});

    // 2. 新增素材
    await openSupplyPage(pageA, `${sup.store.hash}/supply/materials/new`, '新增素材');
    await activePage(pageA).getByRole('form', {name: '新增素材', exact: true}).getByLabel('種類').selectOption('copy');

    await pageA.setViewportSize({width: 390, height: 844});
    expect(await pageA.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await assertControlsFontAt390(pageA, '.supplier-console');
    await pageA.screenshot({path: info.outputPath('materials-new-390.png'), fullPage: true});

    await pageA.setViewportSize({width: 1440, height: 900});
    expect(await pageA.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await pageA.screenshot({path: info.outputPath('materials-new-1440.png'), fullPage: true});

    // 3. 素材詳情 (with grants and the public-use dialog open)
    await openSupplyPage(pageA, `${sup.store.hash}/supply/materials/${material1Id}`, `素材詳情：${title1}`);
    const accessSection = activePage(pageA)
      .locator('.sc-section')
      .filter({has: pageA.getByRole('heading', {level: 3, name: '授權範圍', exact: true})});
    await accessSection.getByLabel('使用範圍').selectOption('public_use');
    const publicDialog = pageA.getByRole('dialog', {name: '可用於合作店家的公開店面', exact: true});
    await expect(publicDialog).toBeVisible();

    await pageA.setViewportSize({width: 390, height: 844});
    expect(await pageA.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await assertControlsFontAt390(pageA, '.supplier-console');
    const dialogFits390 = await publicDialog.evaluate(el => {
      const r = el.getBoundingClientRect();
      return r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight && r.width > 0;
    });
    expect(dialogFits390).toBe(true);
    await pageA.screenshot({path: info.outputPath('materials-detail-390.png'), fullPage: true});

    await pageA.setViewportSize({width: 1440, height: 900});
    expect(await pageA.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await assertSmallButtonsOnDesktop(pageA, '.supplier-console');
    await pageA.screenshot({path: info.outputPath('materials-detail-1440.png'), fullPage: true});
    await publicDialog.getByRole('button', {name: '取消', exact: true}).click();

    // 4. Seller's 合作素材 panel
    await openSellerCooperation(sellerB.page, sellerB.store.hash);
    await expect(partnerMaterials(sellerB.page).locator('strong').filter({hasText: title1})).toBeVisible();

    await sellerB.page.setViewportSize({width: 390, height: 844});
    expect(await sellerB.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await sellerB.page.screenshot({path: info.outputPath('partner-materials-390.png'), fullPage: true});

    await sellerB.page.setViewportSize({width: 1440, height: 900});
    expect(await sellerB.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await assertSmallButtonsOnDesktop(sellerB.page, '.partner-materials');
    await sellerB.page.screenshot({path: info.outputPath('partner-materials-1440.png'), fullPage: true});
  } finally {
    await withdrawSupplierOffers(e2eAuthPool, supplierIds);
    await Promise.all(contexts.map(c => c.close()));
  }
});
