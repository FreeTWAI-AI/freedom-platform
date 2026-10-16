import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from './fixtures.js';
import { navigate, signOut } from './navigation.js';
import { quickJoin } from './quick-join.js';
import { DEMO_COMMUNITY, DEMO_PASSWORD } from '../../packages/testing/seed.js';
import { hashPassword } from '../../modules/identity-membership/service.js';
import {person, login as fixtureLogin, launchStore, open, post, storeArea} from './hosted-store-fixture.js';
import {buyerLogin, offListener} from './hosted-order-fixture.js';
import {SupplierReservationPageSchema} from '../../contracts/guild-launchpad/v1/hosted-shared-order.js';

const guild = 'guild_commerce_sales';
async function register(page: Page, nickname: string) {
  await page.route(url => !['127.0.0.1','localhost'].includes(url.hostname),route => route.abort());
  const email = `merchant-journey-${randomUUID()}@example.test`;
  await page.goto('/');
  await page.getByRole('button', {name: '建立帳號', exact: true}).click();
  await page.getByLabel('社群顯示名稱', {exact: true}).fill(nickname);
  await page.getByLabel('電子郵件', {exact: true}).fill(email);
  await page.getByLabel('密碼', {exact: true}).fill(DEMO_PASSWORD);
  await page.getByRole('button', {name: '建立帳號，先逛工坊', exact: true}).click();
  await quickJoin(page, guild);
  await expect(page.getByRole('heading', {name: '會員首頁', level: 1})).toBeVisible();
  return email;
}
async function login(page: Page, email: string) {
  await page.goto('/');
  await page.getByLabel('電子郵件', {exact: true}).fill(email);
  await page.getByLabel('密碼', {exact: true}).fill(DEMO_PASSWORD);
  await page.getByRole('button', {name: '登入', exact: true}).click();
  await expect(page.getByRole('button', {name: '設定', exact: true})).toBeVisible();
}
async function guildHome(page: Page) {
  await page.goto('/#guilds/' + guild);
  await expect(page.getByRole('region', {name: '主要動作', exact: true})).toBeVisible();
}


async function expand(page:Page,label:string) {
  if(await page.getByRole('navigation',{name:'商店工作區',exact:true}).count())await storeArea(page,'供貨合作');
  const section=page.locator('.hosted-distribution details').filter({has:page.locator('summary').filter({hasText:label})});
  if(await section.getAttribute('open')===null)await section.locator('summary').click();return section;
}
async function createStore(page:Page,name:string) {
  await guildHome(page);
  const primary=page.getByRole('region',{name:'主要動作',exact:true});
  await primary.getByRole('button',{name:'建立我的商店',exact:true}).click();
  const flow=page.getByRole('region',{name:'啟動應用',exact:true});
  await flow.getByLabel('業務空間名稱',{exact:true}).fill(name+'工作室');
  await flow.getByRole('button',{name:'建立業務空間',exact:true}).click();
  await flow.getByRole('button',{name:'產生啟動方案',exact:true}).click();
  await flow.getByRole('button',{name:'確認啟動',exact:true}).click();
  await flow.getByRole('button',{name:'設定我的商店',exact:true}).click();
  await expect(page).toHaveURL(/#stores\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
  const hash=new URL(page.url()).hash,slug='shared-'+randomUUID().slice(0,8);
  const setup=page.getByRole('form',{name:'建立商店',exact:true});
  await setup.getByLabel('商店名稱',{exact:true}).fill(name);await setup.getByLabel('商店網址',{exact:true}).fill(slug);
  await setup.getByRole('button',{name:'建立商店',exact:true}).click();
  await expect(page.getByRole('button',{name:'開放 30 分鐘預留',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'開放 30 分鐘預留',exact:true}).click();
  await expect(page.getByRole('button',{name:'停止接受新預留',exact:true})).toBeEnabled();
  return {page,name,hash,slug};
}
async function reviewShared(page:Page,slug:string,quantity:string,title:string) {
  await page.goto('/#reservations/'+slug);
  await page.getByLabel(title+'數量',{exact:true}).fill(quantity);
  await page.getByRole('button',{name:'查看預留內容',exact:true}).click();
  await expect(page.getByRole('region',{name:'確認預留內容'})).toContainText('非應付金額');
}

test('ordinary A/B/C members open stores, agree supply, opt in, race shared stock, recover and cancel through browser UI',async({browser,baseURL,e2eAuthPool},info)=>{
  test.setTimeout(180000);
  // Only the pre-existing guild officer is fixture infrastructure. Merchants,
  // buyers, memberships, stores, offers and admission are created through UI.
  const title='共用庫存茶杯 '+randomUUID().slice(0,6);
  const officerId=randomUUID(),officerEmail=`cross-officer-${officerId}@example.test`;
  const prior=(await e2eAuthPool.query('SELECT user_id,appointed_at FROM positioning_guild_officers WHERE community_id=$1 AND guild_key=$2',[DEMO_COMMUNITY,guild])).rows;
  const contexts=await Promise.all(Array.from({length:6},()=>browser.newContext({baseURL})));
  try {
    await e2eAuthPool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,onboarding_required)
      VALUES($1,$2,$3,'供貨驗收會長',$4,$5,false)`,[officerId,DEMO_COMMUNITY,officerEmail,hashPassword(DEMO_PASSWORD),randomUUID()]);
    await e2eAuthPool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier)
      VALUES($1,$2,$3,$4,'active','full')`,[randomUUID(),DEMO_COMMUNITY,officerId,guild]);
    await e2eAuthPool.query(`INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) VALUES($1,$2,$3)
      ON CONFLICT(community_id,guild_key) DO UPDATE SET user_id=EXCLUDED.user_id`,[DEMO_COMMUNITY,guild,officerId]);
    const officer=await contexts[0].newPage();await login(officer,officerEmail);
    const stores=[];
    for(let i=1;i<=3;i++) {
      const page=await contexts[i].newPage(),name=['供貨茶坊','小島選物','山城選物'][i-1],nickname=name+' '+randomUUID().slice(0,6);
      const email=await register(page,nickname);
      await officer.goto('/#guilds');
      const card=officer.getByRole('article').filter({has:officer.getByRole('heading',{name:/電商/})});
      await card.getByRole('button',{name:'查看成員',exact:true}).click();
      const dialog=officer.getByRole('dialog');await dialog.getByRole('searchbox',{name:'搜尋公會成員'}).fill(nickname);
      await dialog.getByRole('button',{name:'搜尋成員',exact:true}).click();
      const member=dialog.locator('.directory-member');await expect(member).toHaveCount(1);
      await member.getByRole('button',{name:'設為正式成員',exact:true}).click();
      await expect(member.locator('.guild-member-tier-full')).toHaveText('正式成員');
      await dialog.getByRole('button',{name:'關閉公會視窗',exact:true}).click();
      await page.reload();stores.push({...await createStore(page,name),email});
    }
    const [a,b,c]=stores;
    const add=a.page.getByRole('form',{name:'新增商品',exact:true});
    await add.getByLabel('商品名稱',{exact:true}).fill(title);await add.getByLabel('價格（新臺幣 TWD）',{exact:true}).fill('10');
    await add.getByLabel('庫存',{exact:true}).fill('10');await add.getByRole('button',{name:'新增商品',exact:true}).click();
    await expect(a.page.locator('.hosted-store > [role="status"]')).toContainText('已新增商品');
    await a.page.getByRole('button',{name:'供貨條件',exact:true}).click();
    const supply=a.page.getByRole('form',{name:title+'供貨條件',exact:true});
    await supply.getByLabel('供貨單價（TWD）',{exact:true}).fill('4');await supply.getByLabel('每件運費（TWD）',{exact:true}).fill('0');
    await supply.getByRole('textbox',{name:'出貨條件',exact:true}).fill('另行確認出貨');await supply.getByRole('textbox',{name:'退貨條件',exact:true}).fill('另行確認退貨');
    await supply.getByRole('button',{name:'儲存供貨條件',exact:true}).click();
    await expect(a.page.locator('.hosted-store > [role="status"]')).toContainText('已儲存供貨條件');
    await supply.getByRole('button',{name:'公開供貨版本',exact:true}).click();
    await expect(a.page.locator('.hosted-store > [role="status"]')).toContainText('已公開供貨版本');
    for(const [store,price] of [[b,'11'],[c,'13']] as const) {
      await storeArea(store.page,'供貨合作');
      await store.page.getByRole('button',{name:'更新供貨狀態',exact:true}).click();const catalog=(await expand(store.page,'選用其他商店')).getByRole('article').filter({has:store.page.getByRole('heading',{name:title+'・'+a.name,exact:true})});
      await catalog.getByRole('button',{name:'設定我的售價',exact:true}).click();await catalog.getByLabel('我的零售價（TWD）',{exact:true}).fill(price);
      await catalog.getByRole('button',{name:'送出供貨申請',exact:true}).click();
      await expect(store.page.locator('.hosted-store > [role="status"]')).toContainText('已送出選品');
    }
    await storeArea(a.page,'供貨合作');
    await a.page.getByRole('button',{name:'更新供貨狀態',exact:true}).click();const requests=await expand(a.page,'供貨申請');
    for(const name of [b.name,c.name]) {
      const row=requests.locator('article').filter({has:a.page.getByRole('heading',{name:`${title}・${name}`,exact:true})});
      await row.getByRole('button',{name:'同意這一版',exact:true}).click();await expect(row).toContainText('已同意');
    }
    for(const store of [b,c]) {
      await store.page.getByRole('button',{name:'更新供貨狀態',exact:true}).click();await storeArea(store.page,'店面與發布');await store.page.getByRole('button',{name:'發布展示頁',exact:true}).click();
      await expect(store.page.locator('.hosted-store > [role="status"]')).toContainText('已發布');
    }
    const buyerB=await contexts[4].newPage(),buyerC=await contexts[5].newPage();
    const emailB=await register(buyerB,'茶杯買家 B'),emailC=await register(buyerC,'茶杯買家 C');
    await reviewShared(buyerB,b.slug,'6',title);await reviewShared(buyerC,c.slug,'5',title);
    const responses=[buyerB.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/reservation-orders')),
      buyerC.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/reservation-orders'))];
    await Promise.all([buyerB,buyerC].map(p=>p.getByRole('button',{name:'確認預留 30 分鐘',exact:true}).click()));
    const completed=await Promise.all(responses),codes=completed.map(r=>r.status());expect([...codes].sort()).toEqual([201,409]);
    const winner=codes[0]===201?buyerB:buyerC,loser=codes[0]===201?buyerC:buyerB,winnerStore=codes[0]===201?b:c;
    const winnerEmail=codes[0]===201?emailB:emailC;
    await expect(loser.getByRole('alert')).toContainText('商品庫存不足');await expect(winner.getByRole('region',{name:'我的預留'})).toContainText('預留中');
    const orderId=await winner.getByLabel('預留編號',{exact:true}).inputValue(),recovery=new URL(winner.url()).hash;
    const balances=await e2eAuthPool.query('SELECT stock,reserved FROM commerce_items WHERE title=$1',[title]);
    expect(balances.rows).toEqual([{stock:10,reserved:codes[0]===201?6:5}]);
    await a.page.getByRole('link',{name:'供貨訂單',exact:true}).click();await expect(a.page.locator('.hosted-store')).toContainText(winnerStore.name);
    await expect(a.page.locator('.hosted-store')).toContainText(title);await expect(a.page.locator('.hosted-store')).not.toContainText(winnerEmail);
    for(const width of [390,768,1440]) {
      await a.page.setViewportSize({width,height:900});expect(await a.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await a.page.screenshot({path:info.outputPath(`supplier-${width}.png`),fullPage:true});
      await winner.setViewportSize({width,height:900});expect(await winner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await winner.screenshot({path:info.outputPath(`buyer-${width}.png`),fullPage:true});
    }
    await signOut(winner);await login(winner,winnerEmail);await winner.goto('/'+recovery);
    await expect(winner.getByLabel('預留編號',{exact:true})).toHaveValue(orderId);
    winner.once('dialog',dialog=>dialog.accept());await winner.getByRole('button',{name:'取消預留',exact:true}).click();
    await expect(winner.getByRole('region',{name:'我的預留'})).toContainText('已取消');
    await a.page.getByRole('button',{name:'更新供貨訂單',exact:true}).click();await expect(a.page.locator('.hosted-store')).toContainText('已取消');
    expect((await e2eAuthPool.query('SELECT reserved FROM commerce_items WHERE title=$1',[title])).rows).toEqual([{reserved:0}]);
    await b.page.goto('/'+b.hash);await b.page.getByRole('button',{name:'停止接受新預留',exact:true}).click();
    await expect(b.page.getByRole('button',{name:'開放 30 分鐘預留',exact:true})).toBeEnabled();
    await buyerB.goto('/#reservations/'+b.slug);await expect(buyerB.locator('.hosted-store')).toContainText('商品僅供展示');
  }finally{
    await Promise.allSettled(contexts.map(ctx=>ctx.close()));
    if(prior.length) await e2eAuthPool.query('UPDATE positioning_guild_officers SET user_id=$4 WHERE community_id=$1 AND guild_key=$2 AND user_id=$3',[DEMO_COMMUNITY,guild,officerId,prior[0].user_id]);
    else await e2eAuthPool.query('DELETE FROM positioning_guild_officers WHERE community_id=$1 AND guild_key=$2 AND user_id=$3',[DEMO_COMMUNITY,guild,officerId]);
    expect((await e2eAuthPool.query('SELECT user_id,appointed_at FROM positioning_guild_officers WHERE community_id=$1 AND guild_key=$2',[DEMO_COMMUNITY,guild])).rows).toEqual(prior);
  }
});

test('supplier-only A accepts B, explicitly opens reservations, reads only its own lines and returns to its supply catalog', async ({browser, baseURL, e2eAuthPool}, info) => {
  test.setTimeout(150000);
  const contexts = await Promise.all(Array.from({length: 3}, () => browser.newContext({baseURL})));
  const title = '純供貨茶杯 ' + randomUUID().slice(0, 6), otherTitle = '零售商自己的商品 ' + randomUUID().slice(0, 6);
  const supplier = await person(e2eAuthPool), retailer = await person(e2eAuthPool), buyer = await person(e2eAuthPool);
  try {
    const [a, b, customer] = await Promise.all(contexts.map(context => context.newPage()));
    await fixtureLogin(a, supplier.email); await fixtureLogin(b, retailer.email); await fixtureLogin(customer, buyer.email);
    const supplierStore = await launchStore(a, '純供貨 A 空間'), sellerStore = await launchStore(b, '零售 B 空間');
    const slug = 'supplier-ui-' + randomUUID().slice(0, 12);
    await open(a, supplierStore.hash + '/supply');
    await expect(a.getByRole('button', {name: '開放 30 分鐘預留', exact: true})).toHaveCount(0);
    const setup = a.getByRole('form', {name: '建立供貨商品庫', exact: true});
    await setup.getByLabel('商品庫名稱', {exact: true}).fill('純供貨 A');
    await setup.getByRole('button', {name: '建立供貨商品庫', exact: true}).click();
    await a.getByRole('navigation', {name: '供貨工作區'}).getByRole('button', {name: '預留與訂單', exact: true}).click();
    await expect(a.getByRole('button', {name: '開放 30 分鐘預留', exact: true})).toBeEnabled();
    await expect(a.getByLabel('商店網址', {exact: true})).toHaveCount(0);
    await expect(a.getByRole('button', {name: '發布展示頁', exact: true})).toHaveCount(0);
    await post(b, sellerStore.root + '/setup', {name: '零售 B', slug, currency: 'TWD'}, 201);
    await post(b, sellerStore.root + '/products', {title: otherTitle, price_minor: 900, stock: 5}, 201);
    await open(b, sellerStore.hash);
    await b.getByRole('button', {name: '開放 30 分鐘預留', exact: true}).click();
    await expect(b.getByRole('button', {name: '停止接受新預留', exact: true})).toBeEnabled();
    await a.getByRole('navigation', {name: '供貨工作區'}).getByRole('button', {name: '商品', exact: true}).click();
    await a.getByRole('button', {name: '新增供貨商品', exact: true}).click();
    const add = a.getByRole('form', {name: '新增供貨商品', exact: true});
    await add.getByLabel('商品名稱', {exact: true}).fill(title);
    await add.getByLabel('供貨單價（TWD）', {exact: true}).fill('4');
    await add.getByLabel('庫存', {exact: true}).fill('10');
    await add.getByRole('button', {name: '新增供貨商品', exact: true}).click();
    await expect(a.locator('.hosted-store > [role="status"]')).toContainText('已新增供貨商品');
    await a.getByRole('button', {name: '供貨條件', exact: true}).click();
    const terms = a.getByRole('form', {name: title + '供貨條件', exact: true});
    await terms.getByLabel('每件運費（TWD）', {exact: true}).fill('0');
    await terms.getByRole('textbox', {name: '出貨條件', exact: true}).fill('另行確認出貨');
    await terms.getByRole('textbox', {name: '退貨條件', exact: true}).fill('另行確認退貨');
    await terms.getByRole('button', {name: '儲存供貨條件', exact: true}).click();
    await expect(a.locator('.hosted-store > [role="status"]')).toContainText('已儲存供貨條件');
    await terms.getByRole('button', {name: '公開供貨版本', exact: true}).click();
    await expect(a.locator('.hosted-store > [role="status"]')).toContainText('已公開供貨版本');
    await storeArea(b,'供貨合作');
    await b.getByRole('button', {name: '更新供貨狀態', exact: true}).click();
    const offer = (await expand(b, '選用其他商店')).getByRole('article').filter({has: b.getByRole('heading', {name: title + '・純供貨 A', exact: true})});
    await offer.getByRole('button', {name: '設定我的售價', exact: true}).click();
    await offer.getByLabel('我的零售價（TWD）', {exact: true}).fill('11');
    await offer.getByRole('button', {name: '送出供貨申請', exact: true}).click();
    await expect(b.locator('.hosted-store > [role="status"]')).toContainText('已送出選品');
    await a.getByRole('navigation', {name: '供貨工作區'}).getByRole('button', {name: '供貨合作', exact: true}).click();
    await a.getByRole('button', {name: '更新供貨狀態', exact: true}).click();
    // A supplier-only response auto-opens this section. Wait for this refresh
    // before expand() reads its state, so its click cannot close a newly opened list.
    await expect(a.locator('.hosted-distribution summary').filter({hasText: '供貨申請'})).toContainText('供貨申請（1');
    const request = (await expand(a, '供貨申請')).getByRole('article').filter({has: a.getByRole('heading', {name: title + '・零售 B', exact: true})});
    await request.getByRole('button', {name: '同意這一版', exact: true}).click();
    await expect(request).toContainText('已同意');
    await b.getByRole('button', {name: '更新供貨狀態', exact: true}).click();
    await storeArea(b,'店面與發布');
    await b.getByRole('button', {name: '發布展示頁', exact: true}).click();
    await expect(b.locator('.hosted-store > [role="status"]')).toContainText('已發布');
    // Exact-version supply consent alone must not opt A into reservations.
    await customer.goto('/#reservations/' + slug);
    await customer.getByLabel(title + '數量', {exact: true}).fill('3');
    await customer.getByLabel(otherTitle + '數量', {exact: true}).fill('1');
    const refused = customer.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/reservation-quotes'));
    await customer.getByRole('button', {name: '查看預留內容', exact: true}).click();
    expect((await refused).status()).toBe(409);
    await expect(customer.getByRole('button', {name: '確認預留 30 分鐘', exact: true})).toHaveCount(0);
    await a.getByRole('navigation', {name: '供貨工作區'}).getByRole('button', {name: '預留與訂單', exact: true}).click();
    await a.getByRole('button', {name: '開放 30 分鐘預留', exact: true}).click();
    await expect(a.getByRole('button', {name: '停止接受新預留', exact: true})).toBeEnabled();
    await customer.getByRole('button', {name: '查看預留內容', exact: true}).click();
    await expect(customer.getByRole('region', {name: '確認預留內容'})).toContainText('非應付金額');
    await customer.getByRole('button', {name: '確認預留 30 分鐘', exact: true}).click();
    await expect(customer.getByRole('region', {name: '我的預留'})).toContainText('預留中');
    const orderId = await customer.getByLabel('預留編號', {exact: true}).inputValue();
    await a.getByRole('link', {name: '供貨訂單', exact: true}).click();
    await expect(a).toHaveURL(new RegExp('#' + supplierStore.hash + '/supply-orders$'));
    const orders = a.locator('.hosted-store');
    await expect(orders).toContainText('零售 B'); await expect(orders).toContainText(title + ' × 3');
    await expect(orders).not.toContainText(otherTitle); await expect(orders).not.toContainText(buyer.email);
    await expect(orders.getByRole('button', {name: /取消.*預留/})).toHaveCount(0);
    await expect(a.getByRole('link', {name: '查看本店預留', exact: true})).toHaveCount(0);
    await expect(a.getByRole('link', {name: '返回商店後台', exact: true})).toHaveCount(0);
    const supplierOrders = SupplierReservationPageSchema.parse(await (await a.request.get('/api/v1' + supplierStore.root + '/supply-reservations')).json());
    expect(supplierOrders.items).toHaveLength(1); expect(supplierOrders.items[0].order_id).toBe(orderId);
    expect(supplierOrders.items[0].items.map(line => [line.title, line.quantity, line.unit_supply_price_minor])).toEqual([[title, 3, 400]]);
    expect(JSON.stringify(supplierOrders)).not.toContain(buyer.email); expect(JSON.stringify(supplierOrders)).not.toContain(otherTitle);
    for (const theme of ['light', 'dark', 'versefolk']) {
      await a.evaluate(value => {localStorage.setItem('freedom-theme', value); document.documentElement.dataset.theme = value; document.documentElement.dataset.experienceProfile = value; window.dispatchEvent(new Event('freedom-theme-changed'));}, theme);
      for (const width of [390, 768, 1440]) {
        await a.setViewportSize({width, height: 900});
        expect(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await a.screenshot({path: info.outputPath(`supply-only-orders-${theme}-${width}.png`), fullPage: true});
      }
    }
    await a.getByRole('link', {name: '返回供貨商品庫', exact: true}).click();
    await expect(a).toHaveURL(new RegExp('#' + supplierStore.hash + '/supply$'));
    await expect(a.getByRole('button', {name: '新增供貨商品', exact: true})).toBeVisible();
    await a.getByRole('navigation', {name: '供貨工作區'}).getByRole('button', {name: '預留與訂單', exact: true}).click();
    await a.getByRole('button', {name: '停止接受新預留', exact: true}).click();
    await expect(a.getByRole('button', {name: '開放 30 分鐘預留', exact: true})).toBeEnabled();
    await a.getByRole('link', {name: '供貨訂單', exact: true}).click();
    await expect(orders).toContainText(orderId); await expect(orders).toContainText('預留中');
    // Recovery remains a real authorized read when both host flags are OFF.
    const off = await offListener(e2eAuthPool, false), recoveryContext = await browser.newContext({baseURL: off.origin});
    try {
      const recovery = await recoveryContext.newPage();
      await buyerLogin(recovery, supplier.email, '#' + supplierStore.hash + '/supply-orders', off.origin);
      await expect(recovery.locator('.hosted-store')).toContainText(orderId);
      await expect(recovery.locator('.hosted-store')).toContainText(title + ' × 3');
      await expect(recovery.getByRole('link', {name: '查看本店預留', exact: true})).toHaveCount(0);
    } finally {try {await recoveryContext.close();} finally {await off.close();}}
    customer.once('dialog', dialog => dialog.accept()); await customer.getByRole('button', {name: '取消預留', exact: true}).click();
    await expect(customer.getByRole('region', {name: '我的預留'})).toContainText('已取消');
    await a.getByRole('button', {name: '更新供貨訂單', exact: true}).click(); await expect(orders).toContainText('已取消');
    expect((await e2eAuthPool.query('SELECT stock,reserved FROM commerce_items WHERE title=$1', [title])).rows).toEqual([{stock: 10, reserved: 0}]);
    const profile = await (await a.request.get('/api/v1' + supplierStore.root + '/supply-profile')).json();
    expect(profile.retail_enabled).toBe(false);
    expect((await (await a.request.get('/api/v1/me/stores?pagination=cursor')).json()).items).toEqual([]);
    expect((await e2eAuthPool.query(`SELECT count(*)::int AS n FROM commerce_storefront_publications p
      JOIN commerce_storefront_profiles f USING(instance_id) JOIN commerce_shops s ON s.shop_id=f.supply_shop_id
      WHERE s.owner_id=$1`, [supplier.id])).rows[0].n).toBe(0);
  } finally {
    await Promise.allSettled(contexts.map(context => context.close()));
    await e2eAuthPool.query(`UPDATE commerce_hosted_supply_offers o SET state='withdrawn',version=o.version+1
      FROM commerce_storefront_profiles p JOIN commerce_shops s ON s.shop_id=p.supply_shop_id
      WHERE o.instance_id=p.instance_id AND o.tenant_id=p.tenant_id AND s.owner_id=$1 AND o.state='offered'`, [supplier.id]);
  }
});
