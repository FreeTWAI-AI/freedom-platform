import {randomUUID} from 'node:crypto';
import {test,expect,type Page} from './fixtures.js';
import {person,login,open,post,launchStore} from './hosted-store-fixture.js';

const panel=(p:Page)=>p.locator('.hosted-distribution');
async function expand(p:Page,label:string) {
  const section=panel(p).locator('details').filter({has:p.locator('summary').filter({hasText:label})});
  if(await section.getAttribute('open')===null)await section.locator('summary').click(); return section;
}
test('supplier A and independent B/C complete exact-version consent, publication, repricing and withdrawal through their own UI',async ({browser,baseURL,e2eAuthPool},info)=>{
  const contexts=await Promise.all([0,1,2].map(()=>browser.newContext({baseURL})));
  try {
    const stores=[];
    for(const [n,ctx] of contexts.entries()) {
      const member=await person(e2eAuthPool),page=await ctx.newPage(); await login(page,member.email);
      const s=await launchStore(page,['供貨茶坊','小島選物','山城選物'][n]);
      const slug=`supply-${randomUUID().slice(0,12)}`;
      await post(page,s.root+'/setup',{name:['供貨茶坊','小島選物','山城選物'][n],slug,currency:'TWD'},201);
      await open(page,s.hash); stores.push({...s,page,slug});
    }
    const [a,b,c]=stores;
    const add=a.page.getByRole('form',{name:'新增商品',exact:true});
    await add.getByLabel('商品名稱',{exact:true}).fill('共用庫存茶杯');
    await add.getByLabel('價格（新臺幣 TWD）',{exact:true}).fill('10');
    await add.getByLabel('庫存',{exact:true}).fill('10');
    await add.getByRole('button',{name:'新增商品',exact:true}).click();
    await expect(a.page.locator('.hosted-store > [role="status"]')).toContainText('已新增商品');
    await a.page.getByRole('button',{name:'供貨條件',exact:true}).click();
    let supply=a.page.getByRole('form',{name:'共用庫存茶杯供貨條件',exact:true});
    await supply.getByLabel('供貨單價（TWD）',{exact:true}).fill('4');
    await supply.getByLabel('每件運費（TWD）',{exact:true}).fill('0.5');
    await supply.getByRole('textbox',{name:'出貨條件',exact:true}).fill('收到供貨通知後三天出貨');
    await supply.getByRole('textbox',{name:'退貨條件',exact:true}).fill('瑕疵品由茶坊處理');
    await supply.getByRole('button',{name:'儲存供貨條件',exact:true}).click();
    await expect(a.page.locator('.hosted-store > [role="status"]')).toContainText('已儲存供貨條件');
    await b.page.getByRole('button',{name:'更新供貨狀態',exact:true}).click();
    await expect(await expand(b.page,'選用其他商店')).toContainText('目前沒有其他店主公開');
    await a.page.getByRole('button',{name:'供貨條件',exact:true}).click();
    supply=a.page.getByRole('form',{name:'共用庫存茶杯供貨條件',exact:true});
    await supply.getByRole('button',{name:'公開供貨版本',exact:true}).click();
    await expect(a.page.locator('.hosted-store > [role="status"]')).toContainText('已公開供貨版本');
    for(const [s,price] of [[b,'11'],[c,'13']] as const) {
      await s.page.getByRole('button',{name:'更新供貨狀態',exact:true}).click();
      const catalog=await expand(s.page,'選用其他商店');
      await expect(catalog.getByRole('heading',{name:'共用庫存茶杯・供貨茶坊',exact:true})).toBeVisible();
      await catalog.getByRole('button',{name:'設定我的售價',exact:true}).click();
      await catalog.getByLabel('我的零售價（TWD）',{exact:true}).fill(price);
      await catalog.getByRole('button',{name:'送出供貨申請',exact:true}).click();
      await expect(s.page.locator('.hosted-store > [role="status"]')).toContainText('已送出選品');
      await expect(s.page.getByRole('button',{name:'發布展示頁',exact:true})).toBeDisabled();
    }
    await a.page.getByRole('button',{name:'更新供貨狀態',exact:true}).click();
    const requests=await expand(a.page,'供貨申請');
    for(const name of ['小島選物','山城選物']) {
      const row=requests.locator('article').filter({has:a.page.getByRole('heading',{name:`共用庫存茶杯・${name}`,exact:true})});
      await row.getByRole('button',{name:'同意這一版',exact:true}).click();
      await expect(row).toContainText('已同意，可加入展示頁');
    }
    for(const s of [b,c]) {
      await s.page.getByRole('button',{name:'更新供貨狀態',exact:true}).click();
      await expect(s.page.getByRole('button',{name:'發布展示頁',exact:true})).toBeEnabled();
      await s.page.getByRole('button',{name:'發布展示頁',exact:true}).click();
      await expect(s.page.locator('.hosted-store > [role="status"]')).toContainText('已發布展示頁');
      const published=await s.page.request.get(`/api/v1/public/stores/${s.slug}`); expect(published.status()).toBe(200);
      const dto=await published.json(); expect(dto.products[0].price_minor).toBe(s===b?1100:1300);
      expect(JSON.stringify(dto)).not.toContain('cost_minor'); expect(JSON.stringify(dto)).not.toContain('瑕疵品');
    }
    await expand(b.page,'我的選品');
    for(const width of [390,768,1440]) {
      await b.page.setViewportSize({width,height:900});
      expect(await b.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await panel(b.page).screenshot({path:info.outputPath(`distribution-${width}.png`)});
    }
    const priceForm=(await expand(b.page,'我的選品')).getByRole('form',{name:'共用庫存茶杯選品售價',exact:true});
    await priceForm.getByLabel('我的零售價（TWD）',{exact:true}).fill('12');
    // A lost acknowledgement retains the same command, preventing a second proposal.
    let failed=false; const keys:string[]=[];
    await b.page.route('**/api/v1/tenants/*/storefronts/*/distribution-selections/*',async route=>{
      if(route.request().method()!=='PATCH')return route.continue();
      keys.push(route.request().headers()['idempotency-key']);
      if(!failed){failed=true;await route.fetch();await route.abort('failed');}else await route.continue();
    });
    await priceForm.getByRole('button',{name:'送出供貨申請',exact:true}).click();
    await expect(b.page.locator('.hosted-store > [role="alert"]')).toContainText('尚未確認原操作');
    await b.page.getByRole('button',{name:'重試',exact:true}).click();
    await expect(b.page.locator('.hosted-store > [role="status"]')).toContainText('等待供應商重新確認');
    expect(keys.length).toBe(2); expect(keys[0]).toBe(keys[1]);
    await a.page.getByRole('button',{name:'更新供貨狀態',exact:true}).click();
    const selected=requests.locator('article').filter({has:a.page.getByRole('heading',{name:'共用庫存茶杯・小島選物',exact:true})});
    await selected.getByRole('button',{name:'同意這一版',exact:true}).click();
    await expect(selected).toContainText('已同意，可加入展示頁');
    await selected.getByRole('button',{name:'撤回這間店的同意',exact:true}).click();
    await expect(selected).toContainText('已撤回供貨');
    await b.page.getByRole('button',{name:'更新供貨狀態',exact:true}).click();
    await expect(await expand(b.page,'我的選品')).toContainText('已撤回供貨');
    await expect(b.page.getByRole('button',{name:'發布更新',exact:true})).toBeDisabled();
    const privateAttempt=await c.page.request.get(`/api/v1${b.root}/distribution-selections`);expect(privateAttempt.status()).toBe(404);
  } finally {await Promise.allSettled(contexts.map(ctx=>ctx.close()));}
});
