import {randomUUID} from 'node:crypto';
import {test, expect, type BrowserContext, type Page, type Route} from './fixtures.js';
import {setupCartFixtureStore, assertCartResponsiveLayout} from './storefront-cart-fixture.js';
import {apiLogin, member, ownedSchema} from './hosted-order-fixture.js';
import {isolatedTransaction} from '../../packages/resource-scopes/tenant-transaction.js';
import {CheckoutResponseSchema, PlaceOrderResponseSchema, PublicOrderSchema} from '../../contracts/guild-launchpad/v1/hosted-checkout.js';
import {createAccessLink} from '../../modules/agent-commerce/checkout/access.js';
import {sweepDueCheckoutHolds} from '../../modules/agent-commerce/checkout/settlement.js';
import {endOfflinePaymentWindow} from '../../modules/agent-commerce/payments/offline/window.js';
import type {Pool} from 'pg';

type Store = Awaited<ReturnType<typeof setupCartFixtureStore>>;
async function openBuyer(db: Pool, context: BrowserContext, store: Store) {
  const buyer = await member(db);
  expect((await db.query('SELECT 1 FROM principals WHERE user_ref=$1', [buyer.id])).rowCount).toBe(0);
  await apiLogin(context, store.origin, buyer.email);
  return buyer;
}
async function start(page: Page, store: Store) {
  await page.goto(`${store.origin}/shops/${store.slug}/products/${store.products[0].sku}`);
  await page.getByRole('button', {name: '加入購物車', exact: true}).click();
  await page.getByRole('link', {name: '查看購物車', exact: true}).click();
  await page.getByRole('link', {name: '前往結帳', exact: true}).click();
  await page.getByLabel('收件人姓名', {exact: true}).fill('合成買家甲');
  await page.getByLabel('收件人手機', {exact: true}).fill('0900123456');
  await page.getByLabel('Email', {exact: true}).fill('offline-buyer@example.test');
  await page.getByRole('radio', {name: '面交取貨', exact: true}).check();
  await expect(page.getByLabel('收件地址', {exact: true})).toHaveCount(0);
  await expect(page.getByText('請先約定時間，在山邊小店門口面交。', {exact: true})).toBeVisible();
  await expect(page.locator('#shop-checkout')).toHaveAttribute('aria-busy', 'false');
}
async function freeze(page: Page, store: Store) {
  const response = page.waitForResponse(r => r.url().endsWith(`/stores/${store.slug}/checkouts`) && r.request().method() === 'POST');
  await page.getByRole('button', {name: '核對訂單', exact: true}).click();
  const result = await response;
  expect(result.status(), await result.text()).toBe(201);
  return CheckoutResponseSchema.parse(await result.json());
}
async function place(page: Page, method: '銀行匯款' | '面交付款') {
  await page.getByRole('radio', {name: method, exact: true}).check();
  let capture!: (result: {status: number; body: unknown}) => void;
  const response = new Promise<{status: number; body: unknown}>(resolve => {capture = resolve;});
  const observe = async (route: Route) => {
    // Read the real backend response before delivering it: successful placement
    // immediately navigates, at which point Chromium may discard the old body.
    const result = await route.fetch();
    capture({status: result.status(), body: await result.json()});
    await route.fulfill({response: result});
  };
  await page.route('**/checkouts/*/orders', observe);
  await page.getByRole('button', {name: '確認下單', exact: true}).click();
  const result = await response;
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  const placed = PlaceOrderResponseSchema.parse(result.body);
  await expect(page.getByRole('heading', {level: 1})).toHaveText(`訂單 ${placed.order.display_number}`);
  await page.unroute('**/checkouts/*/orders', observe);
  expect(placed.payment).toBeNull();
  expect(placed.order.latest_payment_attempt).toBeNull();
  return placed.order;
}

test('bank checkout uses frozen instructions, member/link access, seller confirmation and responsive layout', async ({browser, e2eAuthPool}, info) => {
  const store = await setupCartFixtureStore(e2eAuthPool, browser, true);
  const context = await browser.newContext({baseURL: store.origin, permissions: ['clipboard-read', 'clipboard-write']});
  try {
    const buyer = await openBuyer(e2eAuthPool, context, store);
    const page = await context.newPage();
    await start(page, store);
    await assertCartResponsiveLayout(page, [390,768,1440], width => info.outputPath(`checkout-contact-${width}.png`));
    const checkout = await freeze(page, store);
    expect(JSON.stringify(checkout)).not.toContain('000000123456');
    await assertCartResponsiveLayout(page, [390,768,1440], width => info.outputPath(`checkout-confirm-${width}.png`));
    const order = await place(page, '銀行匯款');
    expect(await page.evaluate(slug => localStorage.getItem(`freedom.shop.cart.v1:${slug}`), store.slug)).toBeNull();
    expect(order.meetup_notes).toEqual(['請先約定時間，在山邊小店門口面交。']);
    await expect(page.getByText('000000123456', {exact: true})).toBeVisible();
    await expect(page.getByRole('button', {name: /前往付款|重新付款|查詢付款結果/})).toHaveCount(0);
    await page.getByRole('button', {name: '複製帳號', exact: true}).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('000000123456');
    await page.getByRole('button', {name: '複製金額', exact: true}).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('350.00');
    expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toMatch(/000000123456|offline-buyer@example.test/);
    await store.saveOfflineFixture(2);
    await page.reload();
    await expect(page.getByText('000000123456', {exact: true})).toBeVisible();
    await expect(page.getByText('新的面交地點。', {exact: true})).toHaveCount(0);
    await assertCartResponsiveLayout(page, [390,768,1440], width => info.outputPath(`bank-order-${width}.png`));
    const path = new URL(page.url()).pathname;
    const fresh = await browser.newContext({baseURL: store.origin});
    try {
      const strangerPage = await fresh.newPage();
      await strangerPage.goto(path);
      await expect(strangerPage.getByRole('heading', {level: 1})).toHaveText('找不到這筆訂單');
      await expect(strangerPage.locator('body')).not.toContainText('000000123456');
      await apiLogin(fresh, store.origin, buyer.email);
      await strangerPage.reload();
      await expect(strangerPage.getByText('000000123456', {exact: true})).toBeVisible();
    } finally {await fresh.close();}
    const token = await isolatedTransaction(e2eAuthPool, q => createAccessLink(q, {tenant_id: store.tenant, instance_id: store.instance, checkout_id: checkout.checkout_ref, order_id: order.order_ref}));
    const linked = await browser.newContext({baseURL: store.origin});
    try {
      const linkedPage = await linked.newPage();
      await linkedPage.goto(`${path}#access=${token}`);
      await linkedPage.getByRole('button', {name: '在這個瀏覽器開啟訂單', exact: true}).click();
      await expect(linkedPage.getByText('000000123456', {exact: true})).toBeVisible();
      await linkedPage.getByRole('button', {name: '在這個瀏覽器忘記我的訂單', exact: true}).click();
      await linkedPage.getByRole('button', {name: '忘記訂單', exact: true}).click();
      await expect(linkedPage.getByRole('heading', {level: 1})).toHaveText('這個瀏覽器已忘記你的訂單');
      await expect(linkedPage.locator('body')).not.toContainText('000000123456');
    } finally {await linked.close();}
    const date = (await e2eAuthPool.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Taipei','YYYY-MM-DD') AS d")).rows[0].d;
    await store.sellerPost(`${store.root}/checkout-orders/${order.order_ref}/offline-payments`, {amount_minor: order.total_minor, received_on: date}, 200, '1');
    await page.getByRole('button', {name: '更新訂單狀態', exact: true}).click();
    await expect(page.getByText('店家已確認收到付款。', {exact: true})).toBeVisible();
    await expect(page.getByText('000000123456', {exact: true})).toHaveCount(0);
    await expect(page.getByRole('button', {name: '取消訂單', exact: true})).toHaveCount(0);
    const result = PublicOrderSchema.parse(await (await context.request.get(`/api/v1/public/stores/${store.slug}/orders/${order.order_ref}`)).json());
    expect(result.payment_state).toBe('confirmed');
    expect(result.offline_instructions).toBeNull();
  } finally {await context.close(); await store.close();}
});

for (const editedInAnotherTab of [false, true]) test(`unknown checkout and order acknowledgments retry the same identities across refresh${editedInAnotherTab ? ' after an other-tab cart edit' : ''}`, async ({browser, e2eAuthPool}) => {
  const store = await setupCartFixtureStore(e2eAuthPool, browser, true);
  const context = await browser.newContext({baseURL: store.origin});
  try {
    await openBuyer(e2eAuthPool, context, store);
    const page = await context.newPage();
    await start(page, store);
    const keys: string[] = [], bodies: string[] = [];
    await page.route(`**/stores/${store.slug}/checkouts`, async route => {
      keys.push(route.request().headers()['idempotency-key']);
      const response = await route.fetch();
      expect(response.status()).toBe(keys.length === 1 ? 201 : 200);
      if (keys.length === 1) await route.abort('failed'); else await route.fulfill({response});
    });
    await page.getByRole('button', {name: '核對訂單', exact: true}).click();
    await page.getByRole('button', {name: '重試同一筆結帳', exact: true}).click();
    await expect(page.getByRole('button', {name: '確認下單', exact: true})).toBeEnabled();
    expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]);
    await page.getByRole('radio', {name: '面交付款', exact: true}).check();
    await page.route('**/checkouts/*/orders', async route => {
      bodies.push(route.request().postData()!);
      const response = await route.fetch();
      expect(response.status()).toBe(bodies.length === 1 ? 201 : 200);
      if (bodies.length === 1) await route.abort('failed'); else await route.fulfill({response});
    });
    await page.getByRole('button', {name: '確認下單', exact: true}).click();
    await expect(page.getByRole('alert')).toContainText('還沒收到下單結果');
    if (editedInAnotherTab) {
      const otherTab = await context.newPage();
      await otherTab.goto(`${store.origin}/shops/${store.slug}/cart`);
      await otherTab.getByRole('button', {name: `增加${store.products[0].title}數量`, exact: true}).click();
      await expect(otherTab.getByLabel(`${store.products[0].title}數量`, {exact: true})).toHaveValue('2');
      await otherTab.close();
    }
    const cartBeforeRecovery = await page.evaluate(slug => localStorage.getItem(`freedom.shop.cart.v1:${slug}`), store.slug);
    expect(JSON.parse(cartBeforeRecovery!).lines[0].quantity).toBe(editedInAnotherTab ? 2 : 1);
    await page.reload();
    await page.getByRole('button', {name: '重試同一筆訂單', exact: true}).click();
    await expect(page.getByRole('heading', {level: 1})).toHaveText(/^訂單 /);
    expect(bodies).toHaveLength(2); expect(bodies[1]).toBe(bodies[0]);
    expect(await page.evaluate(slug => localStorage.getItem(`freedom.shop.cart.v1:${slug}`), store.slug)).toBe(cartBeforeRecovery);
    await expect(page.getByText('店家會用你留下的手機或 Email 和你約時間地點。', {exact: true})).toBeVisible();
    expect((await e2eAuthPool.query('SELECT count(*)::int AS n FROM commerce_checkout_orders WHERE instance_id=$1', [store.instance])).rows[0].n).toBe(1);
    expect((await e2eAuthPool.query('SELECT l.quantity FROM commerce_order_lines l JOIN commerce_checkout_orders o USING(order_id) WHERE o.instance_id=$1', [store.instance])).rows).toEqual([{quantity: 1}]);
    await page.getByRole('button', {name: '取消訂單', exact: true}).click();
    await page.getByRole('button', {name: '確認取消訂單', exact: true}).click();
    await expect(page.getByText('訂單狀態：已取消（你取消了訂單）', {exact: true})).toBeVisible();
    expect((await e2eAuthPool.query('SELECT reserved FROM commerce_items WHERE item_id=$1', [store.products[0].product_id])).rows[0].reserved).toBe(0);
  } finally {await context.close(); await store.close();}
});

test('guest sees member requirement and revoked buyer access clears bank instructions', async ({browser, e2eAuthPool}) => {
  const store = await setupCartFixtureStore(e2eAuthPool, browser, true);
  const context = await browser.newContext({baseURL: store.origin});
  try {
    const page = await context.newPage();
    await start(page, store);
    await expect(page.getByText('銀行匯款：登入會員後才能選擇匯款或面交', {exact: true})).toBeVisible();
    await expect(page.getByRole('button', {name: '核對訂單', exact: true})).toBeDisabled();
    await openBuyer(e2eAuthPool, context, store);
    await page.getByRole('button', {name: '更新報價', exact: true}).click();
    await freeze(page, store);
    const order = await place(page, '銀行匯款');
    await context.clearCookies();
    await page.getByRole('button', {name: '更新訂單狀態', exact: true}).click();
    await expect(page.getByRole('heading', {level: 1})).toHaveText('找不到這筆訂單');
    await expect(page.locator('body')).not.toContainText('000000123456');
    await page.goto(`${store.origin}/shops/${store.slug}/orders/${randomUUID()}`);
    await expect(page.getByRole('heading', {level: 1})).toHaveText('找不到這筆訂單');
    expect((await e2eAuthPool.query('SELECT lifecycle_state FROM commerce_checkout_orders WHERE order_id=$1', [order.order_ref])).rows[0].lifecycle_state).toBe('open');
  } finally {await context.close(); await store.close();}
});

test('changed terms require explicit editing; cash meetup records seller confirmation and stock handover', async ({browser, e2eAuthPool}) => {
  const store = await setupCartFixtureStore(e2eAuthPool, browser, true);
  const context = await browser.newContext({baseURL: store.origin});
  try {
    await openBuyer(e2eAuthPool, context, store);
    const page = await context.newPage();
    await start(page, store);
    await page.getByLabel('收件人手機', {exact: true}).fill('123');
    const invalid = page.waitForResponse(r => r.url().endsWith(`/stores/${store.slug}/checkouts`) && r.request().method() === 'POST');
    await page.getByRole('button', {name: '核對訂單', exact: true}).click();
    expect((await invalid).status()).toBe(422);
    const mobile = page.getByLabel('收件人手機', {exact: true});
    await expect(mobile).toHaveAttribute('aria-invalid', 'true');
    await expect(mobile).toHaveAccessibleDescription('收件人手機格式不符，請修正後再試。');
    await expect(page.getByLabel('收件人姓名', {exact: true})).toHaveValue('合成買家甲');
    await mobile.fill('0900123456');
    await freeze(page, store);
    await store.saveOfflineFixture(2);
    const rejected = page.waitForResponse(r => /\/checkouts\/[^/]+\/orders$/.test(r.url()));
    await page.getByRole('button', {name: '確認下單', exact: true}).click();
    expect((await rejected).status()).toBe(409);
    await expect(page.getByRole('alert')).toContainText('商品、價格或配送設定已更新');
    expect((await e2eAuthPool.query('SELECT count(*)::int AS n FROM commerce_checkout_orders WHERE instance_id=$1', [store.instance])).rows[0].n).toBe(0);
    await page.getByRole('button', {name: '修改資料', exact: true}).click();
    await freeze(page, store);
    const order = await place(page, '面交付款');
    await expect(page.getByText('新的面交地點。', {exact: true})).toBeVisible();
    const date = (await e2eAuthPool.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Taipei','YYYY-MM-DD') AS d")).rows[0].d;
    await store.sellerPost(`${store.root}/checkout-orders/${order.order_ref}/meetup-completion`, {amount_minor: order.total_minor, completed_on: date}, 200, '1');
    await page.getByRole('button', {name: '更新訂單狀態', exact: true}).click();
    await expect(page.getByText('店家已確認收到付款。', {exact: true})).toBeVisible();
    const item = (await e2eAuthPool.query('SELECT stock,reserved FROM commerce_items WHERE item_id=$1', [store.products[0].product_id])).rows[0];
    expect(item).toEqual({stock: 4, reserved: 0});
    expect((await e2eAuthPool.query('SELECT count(*)::int AS n FROM commerce_meetup_handovers WHERE order_id=$1', [order.order_ref])).rows[0].n).toBe(1);
  } finally {await context.close(); await store.close();}
});

/** Insert valid historical fixture orders; immutable dates and constraints stay enabled. */
async function historicalBankOrder(db: Pool, source: string, days: number) {
  await ownedSchema(db);
  const id = randomUUID(), client = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0,6).toUpperCase();
  return isolatedTransaction(db, async q => {
    const checkout = (await q.query('SELECT checkout_id FROM commerce_checkout_orders WHERE order_id=$1', [source])).rows[0].checkout_id;
    await q.query(`INSERT INTO commerce_orders(order_id,public_shop_id,external_id,request_sha256,currency,total_minor,created_at,expires_at,order_profile,client_order_id,buyer_principal_id)
      SELECT $2::uuid,public_shop_id,'chk:'||$3::text||':'||($4::uuid)::text,request_sha256,currency,total_minor,t,t+interval '72 hours','hosted_checkout',$4::uuid,buyer_principal_id
      FROM commerce_orders CROSS JOIN (SELECT date_trunc('milliseconds',clock_timestamp()-($5::int * interval '1 day')) t) n WHERE order_id=$1::uuid`, [source,id,checkout,client,days]);
    await q.query(`INSERT INTO commerce_checkout_orders(order_id,tenant_id,instance_id,checkout_id,customer_id,contact_id,display_number,terms,terms_sha256,environment,payment_method)
      SELECT $2::uuid,co.tenant_id,co.instance_id,co.checkout_id,co.customer_id,co.contact_id,to_char(o.created_at AT TIME ZONE 'Asia/Taipei','YYMMDD')||'-'||$3,co.terms,co.terms_sha256,co.environment,'bank_transfer'
      FROM commerce_checkout_orders co JOIN commerce_orders o ON o.order_id=$2::uuid WHERE co.order_id=$1::uuid`, [source,id,suffix]);
    await q.query(`INSERT INTO commerce_order_lines(order_id,selection_id,item_id,quantity,snapshot,order_profile,supplier_shop_id,hosted_offer_id,acceptance_id,listing_sha256)
      SELECT $2::uuid,selection_id,item_id,quantity,snapshot,order_profile,supplier_shop_id,hosted_offer_id,acceptance_id,listing_sha256 FROM commerce_order_lines WHERE order_id=$1::uuid`, [source,id]);
    await q.query(`INSERT INTO commerce_inventory_reservations(order_id,item_id,supplier_shop_id,quantity,state,created_at,expires_at)
      SELECT o.order_id,l.item_id,l.supplier_shop_id,l.quantity,'held',o.created_at,o.expires_at FROM commerce_orders o JOIN commerce_order_lines l USING(order_id) WHERE o.order_id=$1::uuid`, [id]);
    await q.query('UPDATE commerce_items SET reserved=reserved+l.quantity FROM commerce_order_lines l WHERE l.order_id=$1 AND commerce_items.item_id=l.item_id', [id]);
    await q.query(`INSERT INTO commerce_due_work(tenant_id,instance_id,kind,target_id,due_at)
      SELECT co.tenant_id,co.instance_id,'offline_payment_window_end',o.order_id,o.expires_at+interval '72 hours' FROM commerce_orders o JOIN commerce_checkout_orders co USING(order_id) WHERE o.order_id=$1`, [id]);
    return id;
  });
}

test('real hold expiry shows grace and window cancellation without a new payment attempt', async ({browser, e2eAuthPool}, info) => {
  const store = await setupCartFixtureStore(e2eAuthPool, browser, true);
  const context = await browser.newContext({baseURL: store.origin});
  try {
    await openBuyer(e2eAuthPool, context, store);
    const page = await context.newPage();
    await start(page, store); await freeze(page, store);
    const source = await place(page, '銀行匯款');
    const grace = await historicalBankOrder(e2eAuthPool, source.order_ref, 4);
    const ended = await historicalBankOrder(e2eAuthPool, source.order_ref, 8);
    await sweepDueCheckoutHolds(e2eAuthPool, {limit: 200});
    await page.goto(`/shops/${store.slug}/orders/${grace}`);
    await expect(page.getByText(/付款期限已過，保留的商品已釋出。如果你已經匯款/)).toBeVisible();
    await expect(page.getByRole('button', {name: '複製帳號', exact: true})).toHaveCount(0);
    await expect(page.getByRole('button', {name: '取消訂單', exact: true})).toBeVisible();
    await assertCartResponsiveLayout(page, [390,768,1440], width => info.outputPath(`bank-grace-${width}.png`));
    await endOfflinePaymentWindow(e2eAuthPool, ended);
    await page.goto(`/shops/${store.slug}/orders/${ended}`);
    await expect(page.getByText('付款期限已結束，訂單已取消。如果你已經匯款，請聯絡店家。', {exact: true})).toBeVisible();
    await expect(page.getByRole('button', {name: '取消訂單', exact: true})).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('000000123456');
    expect((await e2eAuthPool.query('SELECT count(*)::int AS n FROM commerce_payment_attempts WHERE order_id=ANY($1::uuid[])', [[source.order_ref, grace, ended]])).rows[0].n).toBe(0);
  } finally {await context.close(); await store.close();}
});
