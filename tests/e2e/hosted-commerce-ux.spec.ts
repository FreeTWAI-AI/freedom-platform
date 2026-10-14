import {test,expect} from './fixtures.js';
import {person,login,launchStore,post,open,storeArea} from './hosted-store-fixture.js';

test('supplier finds own goods, retains the conditions draft across work areas and publishes directly after save',async({page,e2eAuthPool})=>{
  const member=await person(e2eAuthPool);await login(page,member.email);const store=await launchStore(page,'Synthetic supply UX');
  await post(page,store.root+'/supply-profile',{name:'Synthetic 供貨商品庫',currency:'TWD'},201);
  await post(page,store.root+'/supply-products',{title:'陶瓷茶杯',cost_minor:18000,stock:10},201);
  await post(page,store.root+'/supply-products',{title:'手作購物袋',cost_minor:10000,stock:5},201);
  await open(page,store.hash+'/supply');await page.getByLabel('搜尋商品',{exact:true}).fill('茶杯');
  await expect(page.locator('.hosted-store-product:visible')).toHaveCount(1);await page.getByRole('button',{name:'供貨條件',exact:true}).click();
  const form=page.getByRole('form',{name:'陶瓷茶杯供貨條件',exact:true});
  await form.getByRole('textbox',{name:'出貨條件',exact:true}).fill('確認供貨後三天出貨');await form.getByRole('textbox',{name:'退貨條件',exact:true}).fill('瑕疵可換貨');
  const areas=page.getByRole('navigation',{name:'供貨工作區',exact:true});await areas.getByRole('button',{name:'供貨合作',exact:true}).click();await areas.getByRole('button',{name:'商品',exact:true}).click();
  await expect(form.getByRole('textbox',{name:'出貨條件',exact:true})).toHaveValue('確認供貨後三天出貨');await expect(page.getByLabel('搜尋商品',{exact:true})).toBeDisabled();
  await form.getByRole('button',{name:'儲存供貨條件',exact:true}).click();await expect(form.getByRole('button',{name:'公開供貨版本',exact:true})).toBeEnabled();
  await form.getByRole('button',{name:'公開供貨版本',exact:true}).click();await expect(page.locator('.hosted-supply-catalog > [role="status"]')).toContainText('已公開供貨版本');
  await page.getByRole('button',{name:'清除搜尋',exact:true}).click();await expect(page.locator('.hosted-store-product:visible')).toHaveCount(2);
});

test('retail work areas preserve a draft, prevent another area overwriting it, and remain reachable across themes and widths',async({page,e2eAuthPool})=>{
  const member=await person(e2eAuthPool);await login(page,member.email);const store=await launchStore(page,'Synthetic retail UX');
  await post(page,store.root+'/setup',{name:'Synthetic 選物店',slug:'ux-'+member.id.slice(0,8),currency:'TWD'},201);
  await post(page,store.root+'/products',{title:'陶瓷茶杯',price_minor:35000,stock:10},201);
  await post(page,store.root+'/products',{title:'手作購物袋',price_minor:20000,stock:5},201);
  await open(page,store.hash);await page.getByLabel('搜尋商品',{exact:true}).fill('茶杯');await expect(page.locator('.hosted-store-product:visible')).toHaveCount(1);
  await page.getByRole('button',{name:'清除搜尋',exact:true}).click();await storeArea(page,'商店資料');
  const settings=page.getByRole('form',{name:'商店資料',exact:true});await settings.getByLabel('商店名稱',{exact:true}).fill('我的未儲存店名');
  await storeArea(page,'商品');await expect(page.getByRole('form',{name:'新增商品',exact:true}).getByRole('button',{name:'新增商品',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'回到未儲存的工作區',exact:true}).click();await expect(settings.getByLabel('商店名稱',{exact:true})).toHaveValue('我的未儲存店名');
  await settings.getByRole('button',{name:'儲存商店資料',exact:true}).click();await storeArea(page,'店面與發布');await expect(page.getByRole('button',{name:'發布展示頁',exact:true})).toBeEnabled();
  for(const theme of ['light','dark','versefolk'])for(const width of [320,390,1280]){
    await page.evaluate(theme=>{localStorage.setItem('freedom-theme',theme);dispatchEvent(new StorageEvent('storage',{key:'freedom-theme',newValue:theme}));},theme);await page.setViewportSize({width,height:900});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    for(const button of await page.getByRole('navigation',{name:'商店工作區',exact:true}).getByRole('button').all())expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({path:`.rd/commerce/retail-${theme}-${width}.png`,fullPage:true});
  }
});
