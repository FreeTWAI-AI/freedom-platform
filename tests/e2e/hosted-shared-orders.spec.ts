import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from './fixtures.js';
import { navigate, signOut } from './navigation.js';
import { quickJoin } from './quick-join.js';
import { DEMO_COMMUNITY, DEMO_PASSWORD } from '../../packages/testing/seed.js';
import { hashPassword } from '../../modules/identity-membership/service.js';

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
    let supply=a.page.getByRole('form',{name:title+'供貨條件',exact:true});
    await supply.getByLabel('供貨單價（TWD）',{exact:true}).fill('4');await supply.getByLabel('每件運費（TWD）',{exact:true}).fill('0');
    await supply.getByRole('textbox',{name:'出貨條件',exact:true}).fill('另行確認出貨');await supply.getByRole('textbox',{name:'退貨條件',exact:true}).fill('另行確認退貨');
    await supply.getByRole('button',{name:'儲存供貨條件',exact:true}).click();
    await expect(a.page.locator('.hosted-store > [role="status"]')).toContainText('已儲存供貨條件');
    await a.page.getByRole('button',{name:'供貨條件',exact:true}).click();supply=a.page.getByRole('form',{name:title+'供貨條件',exact:true});
    await supply.getByRole('button',{name:'公開供貨版本',exact:true}).click();
    await expect(a.page.locator('.hosted-store > [role="status"]')).toContainText('已公開供貨版本');
    for(const [store,price] of [[b,'11'],[c,'13']] as const) {
      await store.page.getByRole('button',{name:'更新供貨狀態',exact:true}).click();const catalog=(await expand(store.page,'選用其他商店')).getByRole('article').filter({has:store.page.getByRole('heading',{name:title+'・'+a.name,exact:true})});
      await catalog.getByRole('button',{name:'設定我的售價',exact:true}).click();await catalog.getByLabel('我的零售價（TWD）',{exact:true}).fill(price);
      await catalog.getByRole('button',{name:'送出供貨申請',exact:true}).click();
      await expect(store.page.locator('.hosted-store > [role="status"]')).toContainText('已送出選品');
    }
    await a.page.getByRole('button',{name:'更新供貨狀態',exact:true}).click();const requests=await expand(a.page,'供貨申請');
    for(const name of [b.name,c.name]) {
      const row=requests.locator('article').filter({has:a.page.getByRole('heading',{name:`${title}・${name}`,exact:true})});
      await row.getByRole('button',{name:'同意這一版',exact:true}).click();await expect(row).toContainText('已同意');
    }
    for(const store of [b,c]) {
      await store.page.getByRole('button',{name:'更新供貨狀態',exact:true}).click();await store.page.getByRole('button',{name:'發布展示頁',exact:true}).click();
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
