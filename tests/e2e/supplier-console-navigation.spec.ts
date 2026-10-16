import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {Locator} from '@playwright/test';
import {test,expect,type Page} from './member-feature-fixture.js';
import {person,login,open,post,launchStore} from './hosted-store-fixture.js';
import {SupplyProductReceiptSchema,SupplyProductPageSchema,type SupplyProductView} from '../../contracts/guild-launchpad/v1/hosted-supply-catalog.js';

test.use({memberFeatures:{guildLaunchpadEnabled:true,hostedReservationsEnabled:true,supplierConsoleEnabled:true}});
const consoleArea=(page:Page)=>page.locator('.supplier-console');
const active=(page:Page)=>page.locator('.sc-content > [data-sc-active="true"]');
const heading=(page:Page,name:string)=>active(page).getByRole('heading',{level:2,name,exact:true});
const navigation=(page:Page,name:string)=>page.getByRole('navigation',{name:'營運中心',exact:true}).getByRole('link',{name,exact:true});
const countLine=(page:Page)=>active(page).getByRole('status').filter({hasText:/^(共 \d+ 件|符合 \d+ 件，共 \d+ 件)（完整清單）$/});
const productLinks=(page:Page)=>active(page).getByRole('table').getByRole('link');
type Store=Awaited<ReturnType<typeof launchStore>>;
function barrier(){let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return {promise,resolve};}
async function patch(page:Page,path:string,body:unknown,version:string){
 const session=await (await page.request.get('/api/v1/session')).json();
 const response=await page.request.patch('/api/v1'+path,{data:body,headers:{Origin:new URL(page.url()).origin,'X-CSRF-Token':session.csrf_token,'Idempotency-Key':randomUUID(),'If-Match':`"${version}"`}});
 const result=await response.json();expect(response.status(),JSON.stringify(result)).toBe(200);return result;
}
async function catalogue(page:Page,suffix:string,label='合成導航'){
 const store=await launchStore(page,`${label}空間 ${suffix}`),name=`${label}商品庫 ${suffix}`;
 await post(page,store.root+'/supply-profile',{name,currency:'TWD'},201);return {...store,name};
}
async function createProduct(page:Page,s:Store,title:string,stock=10,description='合成導航驗收'){
 return {...SupplyProductReceiptSchema.parse(await post(page,s.root+'/supply-products',{title,description,cost_minor:400,stock},201)),title,stock};
}
async function saveTerms(page:Page,s:Store,p:{product_id:string;version:string},cost=400){
 return patch(page,s.root+`/products/${p.product_id}/supply-terms`,{cost_minor:cost,shipping_minor:50,shipping_terms:'合成確認後三天內出貨',return_terms:'合成瑕疵退換'},p.version);
}
async function withdrawSupplierOffers(db:Pool,supplierUserIds:string[]){
 if(!supplierUserIds.length)return;
 await db.query(`UPDATE commerce_hosted_supply_offers o SET state='withdrawn',version=o.version+1
  FROM commerce_storefront_profiles p JOIN commerce_shops s ON s.shop_id=p.supply_shop_id
  WHERE o.instance_id=p.instance_id AND o.tenant_id=p.tenant_id AND s.owner_id=ANY($1::uuid[]) AND o.state='offered'`,[supplierUserIds]);
}
async function go(page:Page,s:Store,suffix=''){
 await open(page,'stores/supply');
 await page.getByRole('link',{name:'查看商品與供貨',exact:true}).and(page.locator(`a[href="#${s.hash}/supply"]`)).click();
 await expect(consoleArea(page)).toBeVisible();
 if(suffix)await page.evaluate(hash=>{location.hash=hash;},s.hash+'/supply'+suffix);
}
async function assertRows(page:Page,items:SupplyProductView[],total=200){
 await expect(countLine(page)).toHaveText(items.length===total?`共 ${total} 件（完整清單）`:`符合 ${items.length} 件，共 ${total} 件（完整清單）`);
 await expect(productLinks(page)).toHaveText(items.map(p=>p.title+p.sku));
}
async function tabTo(page:Page,target:Locator,limit=30){
 for(let n=0;n<limit;n++){
  await page.keyboard.press('Tab');
  if(await target.evaluate(el=>el===document.activeElement))return;
 }
 await expect(target,'Keyboard target was not reached within the bounded Tab sequence').toBeFocused();
}
async function accessibleControls(page:Page){
 const controls=consoleArea(page).locator('button:visible,a[href]:visible,input:visible,select:visible,textarea:visible');
 for(const control of await controls.all())await expect.soft(control,`Missing accessible name: ${await control.evaluate(el=>el.outerHTML)}`).toHaveAccessibleName(/\S/);
}
async function focusInside(page:Page){
 await expect.soft(consoleArea(page).locator(':focus'),'A keyboard save must keep focus inside the console').toHaveCount(1);
}

test('SC-E2E-30 switching business while a read is late shows only the new business (AT-03)',async({browser,baseURL,e2eAuthPool},info)=>{
 test.setTimeout(180_000);
 const suffix=randomUUID().slice(0,6),member=await person(e2eAuthPool),context=await browser.newContext({baseURL});
 const release=barrier(),entered=barrier(),completed=barrier();let intercepted=false;
 try{
  const page=await context.newPage();await login(page,member.email);
  const a=await catalogue(page,suffix,'甲'),b=await catalogue(page,suffix,'乙');
  const ap=await createProduct(page,a,`甲商品 ${suffix}`),bp=await createProduct(page,b,`乙商品 ${suffix}`);
  await go(page,a,'/products');await expect(productLinks(page)).toContainText([ap.title]);
  const requests:{method:string;path:string;afterSwitch:boolean}[]=[];let afterSwitch=false;
  page.on('request',request=>requests.push({method:request.method(),path:new URL(request.url()).pathname,afterSwitch}));
  const heldPath='/api/v1'+a.root+'/supplier-console/products';
  await page.route('**'+heldPath,async route=>{
   if(route.request().method()!=='GET'||intercepted)return route.continue();intercepted=true;
   try{const response=await route.fetch();expect(response.status()).toBe(200);entered.resolve();await release.promise;await route.fulfill({response});}finally{completed.resolve();}
  });
  await active(page).getByRole('button',{name:'更新資料',exact:true}).first().click();await entered.promise;
  await consoleArea(page).getByRole('link',{name:'切換事業',exact:true}).click();
  await expect(page.getByRole('heading',{level:2,name:'我的供貨商品庫',exact:true})).toBeVisible();
  const card=page.getByRole('article').filter({has:page.getByRole('heading',{name:b.name,exact:true})});
  afterSwitch=true;await card.getByRole('link',{name:'查看商品與供貨',exact:true}).click();
  await expect(consoleArea(page).locator('.sc-business-bar')).toContainText(b.name);
  await navigation(page,'商品與庫存').click();await expect(productLinks(page)).toContainText([bp.title]);
  const aTenant=a.hash.split('/')[1],forbidden=[a.name,ap.title,aTenant];
  await page.evaluate(needles=>{
   const state={leaks:[] as string[],observer:null as MutationObserver|null};
   const check=()=>{const root=document.querySelector('.supplier-console');if(!root)return;for(const needle of needles)if(root.outerHTML.includes(needle)&&!state.leaks.includes(needle))state.leaks.push(needle);};
   state.observer=new MutationObserver(check);state.observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true});check();Object.assign(window,{navigationBusinessWatch:state});
  },forbidden);
  release.resolve();await completed.promise;
  await active(page).getByRole('button',{name:'更新資料',exact:true}).first().click();
  await expect(active(page).getByRole('status').first()).toContainText('資料時間');
  await expect(consoleArea(page).locator('.sc-business-bar')).toContainText(b.name);await expect(productLinks(page)).toContainText([bp.title]);
  for(const value of forbidden)await expect(consoleArea(page)).not.toContainText(value);
  await expect(consoleArea(page).locator(`a[href*="${aTenant}"]`)).toHaveCount(0);
  await productLinks(page).first().click();const stock=active(page).getByRole('form',{name:'儲存庫存',exact:true});
  await stock.getByLabel('庫存',{exact:true}).fill('17');
  const saved=page.waitForResponse(r=>r.request().method()==='PATCH'&&r.url().endsWith('/supply-products/'+bp.product_id));
  await stock.getByRole('button',{name:'儲存庫存',exact:true}).click();expect((await saved).status()).toBe(200);
  await expect(consoleArea(page).locator('.sc-announcement')).toHaveText('已保存：儲存庫存。');
  const scoped=requests.filter(r=>r.afterSwitch&&r.path.startsWith('/api/v1/tenants/'));
  expect(scoped.length).toBeGreaterThan(0);for(const r of scoped)expect(r.path).toMatch(new RegExp('^/api/v1'+b.root+'(?:/|$)'));
  expect(scoped.filter(r=>r.method==='PATCH').map(r=>r.path)).toEqual(['/api/v1'+b.root+'/supply-products/'+bp.product_id]);
  expect((await e2eAuthPool.query('SELECT item_id,stock FROM commerce_items WHERE item_id=ANY($1::uuid[]) ORDER BY item_id',[[ap.product_id,bp.product_id]])).rows).toEqual([{item_id:ap.product_id,stock:10},{item_id:bp.product_id,stock:17}].sort((x,y)=>x.item_id.localeCompare(y.item_id)));
  const leaks=await page.evaluate(()=>{const state=(window as unknown as {navigationBusinessWatch:{leaks:string[];observer:MutationObserver}}).navigationBusinessWatch;state.observer.disconnect();return state.leaks;});expect(leaks).toEqual([]);
  await info.attach('business-switch-requests',{body:JSON.stringify({requests,leaks}),contentType:'application/json'});
 }finally{release.resolve();if(intercepted)await completed.promise;await Promise.allSettled([context.close()]);await withdrawSupplierOffers(e2eAuthPool,[member.id]);}
});

test('SC-E2E-31 a full 200-product catalogue keeps search, filters, counts and the return position (AT-09,10,30)',async({browser,baseURL,e2eAuthPool},info)=>{
 test.setTimeout(180_000);
 const suffix=randomUUID().slice(0,6),member=await person(e2eAuthPool),context=await browser.newContext({baseURL});
 try{
  const page=await context.newPage();await page.setViewportSize({width:1440,height:900});await login(page,member.email);const s=await catalogue(page,suffix);
  const word=`遠端描述${suffix}`,search=`返回群組${suffix}`,special=[4,119,194],zero=[30,180];
  const created:Awaited<ReturnType<typeof createProduct>>[]=[];
  for(let start=0;start<200;start+=10)created.push(...await Promise.all(Array.from({length:10},(_,offset)=>{
   const n=start+offset;return createProduct(page,s,`合成品 ${String(200-n).padStart(3,'0')} ${suffix}`,zero.includes(n)?0:10+n%7,`${n>=140?search:'一般說明'}${special.includes(n)?' '+word:''}`);
  })));
  for(const n of special){const terms=await saveTerms(page,s,created[n]);await post(page,s.root+`/products/${created[n].product_id}/supply-offer`,{},200,terms.version);if(n===119)await saveTerms(page,s,{...created[n],version:terms.version},500);}
  expect(await post(page,s.root+'/supply-products',{title:`超額商品 ${suffix}`,cost_minor:400,stock:1},409)).toMatchObject({code:'storefront_product_limit'});
  const response=await page.request.get('/api/v1'+s.root+'/supply-products');expect(response.status()).toBe(200);
  const items=SupplyProductPageSchema.parse(await response.json()).items.sort((a,b)=>a.sku.localeCompare(b.sku));expect(items).toHaveLength(200);
  const byIds=(ids:string[])=>items.filter(p=>ids.includes(p.product_id));
  const offered=byIds(special.map(n=>created[n].product_id)),outdated=byIds([created[119].product_id]),outOfStock=items.filter(p=>p.stock===0);
  const notOffered=items.filter(p=>!offered.some(o=>o.product_id===p.product_id));
  for(const n of special){const position=items.findIndex(p=>p.product_id===created[n].product_id),batch=Math.floor(n/10)*10;expect(position).toBeGreaterThanOrEqual(batch);expect(position).toBeLessThan(batch+10);}
  await go(page,s);const metric=(name:string)=>consoleArea(page).locator('.sc-metrics article').filter({has:page.getByRole('heading',{level:3,name,exact:true})}).locator('.sc-metric-value');
  await expect(metric('公開供貨商品')).toHaveText('3');await expect(metric('缺貨商品')).toHaveText('2');
  await expect(consoleArea(page).getByText('共用商品容量 200／200（含供貨商品與商店選品）',{exact:true})).toBeVisible();
  const todos=active(page).locator('.sc-list .sc-row'),expectedTodos=[...outdated.map(p=>({p,text:'供貨條件已修改，需重新公開'})),...outOfStock.map(p=>({p,text:'可用庫存已用完'})),...notOffered.map(p=>({p,text:'尚未公開供貨版本'}))].slice(0,20);
  await expect(todos).toHaveCount(20);await expect(active(page).getByText('只顯示前 20 項待辦',{exact:true})).toBeVisible();
  for(let n=0;n<expectedTodos.length;n++){await expect(todos.nth(n).getByRole('strong')).toHaveText(expectedTodos[n].p.title);await expect(todos.nth(n)).toContainText(expectedTodos[n].text);}
  await navigation(page,'商品與庫存').click();await assertRows(page,items);
  await expect(active(page).getByRole('button',{name:'新增商品',exact:true})).toBeDisabled();await expect(active(page).getByText('商品容量已達 200 件',{exact:true})).toBeVisible();
  const searchBox=active(page).getByRole('searchbox',{name:'搜尋商品',exact:true}),state=active(page).getByRole('combobox',{name:'供貨狀態',exact:true}),sort=active(page).getByRole('combobox',{name:'排序',exact:true});
  await searchBox.fill(word);await assertRows(page,offered);expect(offered.every(p=>!p.title.includes(word)&&!p.sku.includes(word)&&p.description.includes(word))).toBe(true);
  await searchBox.fill('');
  for(const [value,expected] of [['out_of_stock',outOfStock],['offered',offered],['outdated',outdated]] as const){await state.selectOption(value);await expect(page).toHaveURL(new RegExp('[?&]state='+value));await assertRows(page,expected);}
  await navigation(page,'營運概覽').click();await active(page).getByRole('link',{name:/^查看清單\s*：缺貨商品$/}).click();await assertRows(page,outOfStock);
  await state.selectOption('');
  const titleOrder=[...items].sort((a,b)=>a.title.localeCompare(b.title,'zh-TW')||a.sku.localeCompare(b.sku));
  await sort.selectOption('title');await assertRows(page,titleOrder);
  await sort.selectOption('available');await assertRows(page,[...items].sort((a,b)=>a.stock-b.stock||a.sku.localeCompare(b.sku)));
  await sort.selectOption('title');await searchBox.fill(search);const matching=titleOrder.filter(p=>p.description.includes(search));expect(matching.length).toBeGreaterThanOrEqual(30);await assertRows(page,matching);
  expect([...new URLSearchParams(new URL(page.url()).hash.split('?')[1]).keys()]).toEqual(['sort']);
  const target=matching[matching.length-5],link=()=>active(page).getByRole('link',{name:target.title+' '+target.sku,exact:true});
  await link().focus();await link().scrollIntoViewIfNeeded();const scroll=await page.evaluate(()=>window.scrollY);expect(scroll).toBeGreaterThan(0);
  const openDetail=async()=>{await link().focus();await page.keyboard.press('Enter');await expect(heading(page,'商品詳情：'+target.title)).toBeFocused();};
  const restored=async()=>{await expect(page).toHaveURL(/\/supply\/products\?sort=title$/);await expect(searchBox).toHaveValue(search);await assertRows(page,matching);await expect(link()).toBeFocused();await expect.poll(async()=>Math.abs(await page.evaluate(()=>window.scrollY)-scroll)).toBeLessThanOrEqual(50);};
  await openDetail();const detailRead=page.waitForResponse(r=>r.url().endsWith('/supplier-console/products/'+target.product_id));await active(page).getByRole('button',{name:'更新資料',exact:true}).click();expect((await detailRead).status()).toBe(200);
  await active(page).getByRole('link',{name:'返回商品與庫存',exact:true}).click();await restored();
  await openDetail();await page.goBack();await restored();
  await openDetail();await page.reload();await expect(heading(page,'商品詳情：'+target.title)).toBeVisible();await expect(active(page).getByText('SKU '+target.sku,{exact:true})).toBeVisible();
  await page.goBack();await expect(page).toHaveURL(/\/supply\/products\?sort=title$/);await expect(searchBox).toHaveValue('');await assertRows(page,titleOrder);await expect(heading(page,'商品與庫存')).toBeFocused();
  await info.attach('catalogue-scope-and-position',{body:JSON.stringify({products:items.length,special:offered.map(p=>p.sku),outdated:outdated.map(p=>p.sku),outOfStock:outOfStock.map(p=>p.sku),target:target.product_id,scroll,searchCount:matching.length}),contentType:'application/json'});
 }finally{await Promise.allSettled([context.close()]);await withdrawSupplierOffers(e2eAuthPool,[member.id]);}
});

test('SC-E2E-32 keyboard reaches navigation, dialogs, saves and errors with focus returned (AT-41)',async({browser,baseURL,e2eAuthPool},info)=>{
 test.setTimeout(180_000);
 const suffix=randomUUID().slice(0,6),member=await person(e2eAuthPool),context=await browser.newContext({baseURL,viewport:{width:1440,height:900}});
 try{
  const page=await context.newPage();await login(page,member.email);const s=await catalogue(page,suffix),p=await createProduct(page,s,`鍵盤商品 ${suffix}`);await createProduct(page,s,`第二商品 ${suffix}`);await saveTerms(page,s,p);
  const writes:{method:string;path:string}[]=[];page.on('request',r=>{if(['POST','PATCH'].includes(r.method()))writes.push({method:r.method(),path:new URL(r.url()).pathname});});
  await go(page,s);await expect(active(page).locator('.sc-metrics')).toBeVisible();await accessibleControls(page);
  await consoleArea(page).getByRole('link',{name:'切換事業',exact:true}).focus();await tabTo(page,navigation(page,'商品與庫存'));await page.keyboard.press('Enter');await expect(heading(page,'商品與庫存')).toBeFocused();await expect(countLine(page)).toHaveText('共 2 件（完整清單）');await accessibleControls(page);
  let reachedSearch=false;const searchBox=active(page).getByRole('searchbox',{name:'搜尋商品',exact:true});
  for(let n=0;n<30;n++){await page.keyboard.press('Tab');expect(await productLinks(page).evaluateAll(links=>links.some(el=>el===document.activeElement)),'A product link was reached before search').toBe(false);if(await searchBox.evaluate(el=>el===document.activeElement)){reachedSearch=true;break;}}
  expect(reachedSearch).toBe(true);
  const productLink=active(page).getByRole('link',{name:new RegExp('^'+p.title+' ')});await productLink.focus();await page.keyboard.press('Enter');await expect(heading(page,'商品詳情：'+p.title)).toBeFocused();
  const trigger=active(page).getByRole('button',{name:'公開供貨版本',exact:true}),dialog=page.getByRole('dialog',{name:'公開供貨版本的影響',exact:true}),offerPath='/api/v1'+s.root+`/products/${p.product_id}/supply-offer`;
  await expect(trigger).toBeEnabled();await accessibleControls(page);await trigger.focus();await page.keyboard.press('Enter');await expect(dialog).toBeVisible();await expect(dialog.getByRole('button',{name:'取消',exact:true})).toBeFocused();await accessibleControls(page);
  await page.keyboard.press('Escape');await expect(dialog).toBeHidden();await expect(trigger).toBeFocused();expect(writes.filter(r=>r.path===offerPath)).toHaveLength(0);
  await page.keyboard.press('Space');await expect(dialog).toBeVisible();await expect(dialog.getByRole('button',{name:'取消',exact:true})).toBeFocused();await page.keyboard.press('Tab');await expect(dialog.getByRole('button',{name:'確認公開供貨版本',exact:true})).toBeFocused();await page.keyboard.press('Enter');
  await expect(consoleArea(page).locator('.sc-announcement')).toHaveText('已保存：公開供貨版本。');await expect(dialog).toBeHidden();expect(writes.filter(r=>r.path===offerPath)).toEqual([{method:'POST',path:offerPath}]);
  if(await trigger.isEnabled())await expect.soft(trigger).toBeFocused();else await expect.soft(active(page).locator(':focus'),'Publishing must return focus inside the product page when its trigger is disabled').toHaveCount(1);
  const publishFocus=await page.evaluate(()=>({tag:document.activeElement?.tagName,inside:!!document.activeElement?.closest('.sc-content > [data-sc-active="true"]')}));
  const stock=active(page).getByRole('form',{name:'儲存庫存',exact:true}).getByLabel('庫存',{exact:true});await expect(stock).toBeEnabled();await stock.focus();await page.keyboard.press('ControlOrMeta+A');await page.keyboard.type('23');await page.keyboard.press('Enter');
  await expect(consoleArea(page).locator('.sc-announcement')).toHaveText('已保存：儲存庫存。');expect(writes.filter(r=>r.path==='/api/v1'+s.root+'/supply-products/'+p.product_id)).toEqual([{method:'PATCH',path:'/api/v1'+s.root+'/supply-products/'+p.product_id}]);await focusInside(page);const stockFocus=await page.evaluate(()=>({tag:document.activeElement?.tagName,inside:!!document.activeElement?.closest('.supplier-console')}));await accessibleControls(page);
  await consoleArea(page).getByRole('link',{name:'切換事業',exact:true}).focus();await tabTo(page,navigation(page,'營運概覽'));await page.keyboard.press('Enter');await expect(heading(page,'營運概覽')).toBeFocused();await page.reload();await expect(active(page).locator('.sc-metrics')).toBeVisible();await accessibleControls(page);
  const productsPath='**/api/v1'+s.root+'/supplier-console/products';let failures=0;
  await page.route(productsPath,async route=>{if(route.request().method()!=='GET')return route.continue();failures++;await route.fulfill({status:503,contentType:'application/problem+json',body:JSON.stringify({type:'urn:freedom:problem:service_unavailable',title:'service_unavailable',status:503,code:'service_unavailable',detail:'合成測試：商品清單暫時無法讀取。'})});});
  await consoleArea(page).getByRole('link',{name:'切換事業',exact:true}).focus();await tabTo(page,navigation(page,'商品與庫存'));await page.keyboard.press('Enter');await expect(heading(page,'商品與庫存')).toBeFocused();await expect(active(page).getByRole('alert')).toHaveText(/^暫時無法讀取商品清單/);await expect(active(page).getByRole('table')).toHaveCount(0);await expect(countLine(page)).toHaveCount(0);expect(failures).toBeGreaterThan(0);await accessibleControls(page);
  await page.unroute(productsPath);const retry=active(page).getByRole('button',{name:'重試',exact:true});await heading(page,'商品與庫存').focus();await tabTo(page,retry);await page.keyboard.press('Enter');await expect(countLine(page)).toHaveText('共 2 件（完整清單）');await expect(productLinks(page)).toHaveCount(2);await accessibleControls(page);
  await page.setViewportSize({width:390,height:900});const mobileNav=consoleArea(page).getByRole('combobox',{name:'營運中心頁面',exact:true});await mobileNav.focus();await mobileNav.selectOption({label:'設定與資料'});await expect(heading(page,'設定與資料')).toBeFocused();await accessibleControls(page);
  await info.attach('keyboard-writes-and-read-errors',{body:JSON.stringify({writes,failures,publishFocus,stockFocus}),contentType:'application/json'});
 }finally{await Promise.allSettled([context.close()]);await withdrawSupplierOffers(e2eAuthPool,[member.id]);}
});
