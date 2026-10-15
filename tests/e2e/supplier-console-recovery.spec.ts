import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {test,expect,type Page,type Request,type TestInfo} from './member-feature-fixture.js';
import {person,login,post,launchStore} from './hosted-store-fixture.js';
import {navigate,signOut} from './navigation.js';
import {DEMO_PASSWORD} from '../../packages/testing/seed.js';
import {SupplyProductReceiptSchema,SupplyProductPageSchema} from '../../contracts/guild-launchpad/v1/hosted-supply-catalog.js';
import {SupplierProductDetailSchema} from '../../contracts/guild-launchpad/v1/supplier-console.js';
import {SupplyOfferSchema,DistributionSchema} from '../../contracts/guild-launchpad/v1/hosted-distribution.js';

test.use({memberFeatures:{guildLaunchpadEnabled:true,hostedReservationsEnabled:true,supplierConsoleEnabled:true}});
const consoleArea=(page:Page)=>page.locator('.supplier-console');
const active=(page:Page)=>page.locator('.sc-content > [data-sc-active="true"]');
const held=(page:Page)=>consoleArea(page).getByRole('status').filter({hasText:'尚未確認原操作的結果：新增商品。'});
const leaveNotice='尚未確認原操作的結果，請按「重試」確認後再離開。';
const draftNotice='還有尚未儲存的內容，要離開嗎？';
const unique=(name:string)=>name+' '+randomUUID().slice(0,6);
function barrier(){let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return {promise,resolve};}
function signature(request:Request){return {method:request.method(),path:new URL(request.url()).pathname,body:request.postData(),key:request.headers()['idempotency-key'],version:request.headers()['if-match']??null};}
type Store=Awaited<ReturnType<typeof launchStore>>;
async function get(page:Page,path:string){const response=await page.request.get('/api/v1'+path);expect(response.status()).toBe(200);return response.json();}
async function patch(page:Page,path:string,body:unknown,version:string){
 const session=await get(page,'/session');
 const response=await page.request.patch('/api/v1'+path,{data:body,headers:{Origin:new URL(page.url()).origin,'X-CSRF-Token':session.csrf_token,'Idempotency-Key':randomUUID(),'If-Match':`"${version}"`}});
 const result=await response.json();expect(response.status(),JSON.stringify(result)).toBe(200);return result;
}
async function loginHere(page:Page,email:string){
 await page.getByLabel('電子郵件',{exact:true}).fill(email);await page.getByLabel('密碼',{exact:true}).fill(DEMO_PASSWORD);
 await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.getByRole('button',{name:'設定',exact:true})).toBeVisible();
}
async function supplier(page:Page,db:Pool){
 const member=await person(db);await login(page,member.email);const name=unique('合成恢復商品庫'),store=await launchStore(page,unique('合成供貨空間'));
 await post(page,store.root+'/supply-profile',{name,currency:'TWD',description:'合成恢復驗收'},201);return {...store,member,name};
}
async function product(page:Page,store:Store,title=unique('合成恢復茶杯')){
 const receipt=SupplyProductReceiptSchema.parse(await post(page,store.root+'/supply-products',{title,description:'合成原始說明',cost_minor:400,stock:10},201));return {...receipt,title};
}
async function detail(page:Page,store:Store,id:string){return SupplierProductDetailSchema.parse(await get(page,store.root+'/supplier-console/products/'+id));}
async function go(page:Page,store:Store,suffix=''){
 const profileRead=await consoleArea(page).isVisible()?null:page.waitForResponse(r=>r.request().method()==='GET'&&r.url().endsWith(store.root+'/supply-profile'));
 await page.evaluate(hash=>{location.hash=hash;},store.hash+'/supply'+suffix);if(profileRead)expect((await profileRead).status()).toBe(200);await expect(consoleArea(page)).toBeVisible();
}
async function nav(page:Page,name:string){await page.getByRole('navigation',{name:'營運中心',exact:true}).getByRole('link',{name,exact:true}).click();}
async function newProduct(page:Page,store:Store,title:string){
 await go(page,store,'/products/new');const form=active(page).getByRole('form',{name:'新增商品',exact:true});
 await form.getByLabel('商品名稱',{exact:true}).fill(title);await form.getByRole('textbox',{name:'說明',exact:true}).fill('合成遺失回應內容');
 await form.getByLabel('供貨單價',{exact:true}).fill('4');await form.getByLabel('庫存',{exact:true}).fill('10');
 await form.getByRole('button',{name:'新增商品',exact:true}).click();await expect(held(page)).toBeVisible();
}
async function loseCreateAck(page:Page,store:Store){
 const requests:ReturnType<typeof signature>[]=[],statuses:number[]=[];
 await page.route('**/api/v1'+store.root+'/supply-products',async route=>{
  if(route.request().method()!=='POST')return route.continue();requests.push(signature(route.request()));
  const response=await route.fetch();statuses.push(response.status());
  if(requests.length===1){expect(response.status()).toBe(201);await route.abort('failed');}else await route.fulfill({response});
 });return {requests,statuses};
}
async function retryCreate(page:Page,store:Store){
 const replay=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith(store.root+'/supply-products'));
 const refreshed=Promise.all(['/supply-profile','/supplier-console/products','/supplier-console/overview'].map(path=>page.waitForResponse(r=>r.request().method()==='GET'&&r.url().endsWith(store.root+path))));
 const productRead=page.waitForResponse(r=>r.request().method()==='GET'&&r.url().includes(store.root+'/supplier-console/products/'));
 await held(page).getByRole('button',{name:'重試',exact:true}).click();expect((await replay).status()).toBe(201);for(const response of await refreshed)expect(response.status()).toBe(200);expect((await productRead).status()).toBe(200);
 await expect(page.locator('#workspace-page-title')).toHaveText('商品詳情');
}
async function exactlyOne(page:Page,db:Pool,store:Store,title:string){
 const products=SupplyProductPageSchema.parse(await get(page,store.root+'/supply-products')),matches=products.items.filter(item=>item.title===title);
 expect(matches).toHaveLength(1);expect((await db.query('SELECT item_id FROM commerce_items WHERE title=$1',[title])).rows).toEqual([{item_id:matches[0].product_id}]);return matches[0];
}
async function evidence(page:Page,info:TestInfo,name:string,data?:unknown){
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:info.outputPath(name+'.png'),fullPage:true});
 if(data)await info.attach(name,{body:JSON.stringify(data),contentType:'application/json'});
}

test('SC-E2E-20 a lost create acknowledgement is retried with the same key and body (AT-06)',async({page,e2eAuthPool},info)=>{
 test.setTimeout(120_000);
 const s=await supplier(page,e2eAuthPool),title=unique('合成遺失新增回應'),fault=await loseCreateAck(page,s);
 await newProduct(page,s,title);expect(fault.requests).toHaveLength(1);
 await nav(page,'合作店家');await expect(page.locator('#workspace-page-title')).toHaveText('合作店家');await expect(held(page)).toBeVisible();
 await retryCreate(page,s);
 await expect(consoleArea(page).locator('.sc-announcement')).toHaveText('已保存：新增商品。');
 await expect(page.locator('#workspace-page-title')).toHaveText('商品詳情');await expect(active(page).getByRole('heading',{name:'商品詳情：'+title,exact:true})).toBeVisible();
 await expect(held(page)).toHaveCount(0);expect(fault.requests).toHaveLength(2);expect(fault.requests[0].key).toBeTruthy();expect(fault.requests[1]).toEqual(fault.requests[0]);
 const saved=await exactlyOne(page,e2eAuthPool,s,title);await expect(page).toHaveURL(new RegExp('/supply/products/'+saved.product_id+'$'));
 await evidence(page,info,'lost-create-ack',fault);
});

test('SC-E2E-21 leaving while the outcome is unknown is refused (AT-36)',async({page,e2eAuthPool},info)=>{
 test.setTimeout(120_000);
 const s=await supplier(page,e2eAuthPool),title=unique('合成離開保護'),fault=await loseCreateAck(page,s);
 await newProduct(page,s,title);const hash=new URL(page.url()).hash;
 await navigate(page,'會員首頁');await expect(page).toHaveURL(new RegExp(hash+'$'));await expect(consoleArea(page).locator('.sc-announcement')).toHaveText(leaveNotice);
 await page.evaluate(()=>history.back());await expect(page).toHaveURL(new RegExp(hash+'$'));await expect(consoleArea(page).locator('.sc-announcement')).toHaveText(leaveNotice);
 await page.getByRole('button',{name:'設定',exact:true}).click();await page.getByRole('menuitem',{name:'登出',exact:true}).click();
 await expect(page).toHaveURL(new RegExp(hash+'$'));await expect(consoleArea(page).locator('.sc-announcement')).toHaveText(leaveNotice);await expect(page.getByRole('button',{name:'設定',exact:true})).toBeVisible();
 await nav(page,'商品與庫存');await expect(page.locator('#workspace-page-title')).toHaveText('商品與庫存');await expect(held(page)).toBeVisible();expect(fault.requests).toHaveLength(1);
 await retryCreate(page,s);
 const saved=await exactlyOne(page,e2eAuthPool,s,title);expect(fault.requests).toHaveLength(2);expect(fault.requests[1]).toEqual(fault.requests[0]);
 await navigate(page,'會員首頁');await expect(page.locator('#workspace-page-title')).toHaveText('會員首頁');
 await go(page,s,'/products/'+saved.product_id);const form=active(page).getByRole('form',{name:'儲存內容',exact:true}),draft=unique('合成未儲存草稿');
 await form.getByRole('textbox',{name:'說明',exact:true}).fill(draft);const draftHash=new URL(page.url()).hash;
 const dismiss=barrier();page.once('dialog',async dialog=>{expect(dialog.type()).toBe('confirm');expect(dialog.message()).toBe(draftNotice);await dialog.dismiss();dismiss.resolve();});
 await navigate(page,'會員首頁');await dismiss.promise;await expect(page).toHaveURL(new RegExp(draftHash+'$'));await expect(form.getByRole('textbox',{name:'說明',exact:true})).toHaveValue(draft);
 await evidence(page,info,'leave-refused-keeps-draft',fault);
 const accept=barrier();page.once('dialog',async dialog=>{expect(dialog.message()).toBe(draftNotice);await dialog.accept();accept.resolve();});
 await navigate(page,'會員首頁');await accept.promise;await expect(page.locator('#workspace-page-title')).toHaveText('會員首頁');
 expect((await detail(page,s,saved.product_id)).product.description).toBe('合成遺失回應內容');
});

test('SC-E2E-22 two tabs: the later save gets 412, keeps the draft and needs an explicit reapply (AT-07)',async({page,context,e2eAuthPool},info)=>{
 test.setTimeout(120_000);
 const s=await supplier(page,e2eAuthPool),p=await product(page,s),second=await context.newPage(),requests:ReturnType<typeof signature>[]=[],statuses:number[]=[];
 try{
  await go(page,s,'/products/'+p.product_id);await second.goto('/#'+s.hash+'/supply/products/'+p.product_id);
  const firstForm=active(page).getByRole('form',{name:'儲存內容',exact:true}),secondForm=active(second).getByRole('form',{name:'儲存內容',exact:true});
  const firstTitle=unique('合成第一分頁保存'),secondTitle=unique('合成第二分頁草稿'),firstDescription=unique('合成最新說明'),secondDescription=unique('合成保留說明');
  await secondForm.getByLabel('商品名稱',{exact:true}).fill(secondTitle);await secondForm.getByRole('textbox',{name:'說明',exact:true}).fill(secondDescription);
  await firstForm.getByLabel('商品名稱',{exact:true}).fill(firstTitle);await firstForm.getByRole('textbox',{name:'說明',exact:true}).fill(firstDescription);
  await firstForm.getByRole('button',{name:'儲存內容',exact:true}).click();await expect(firstForm.getByRole('status')).toHaveText('已保存：儲存內容。');
  await expect(firstForm.getByRole('button',{name:'儲存內容',exact:true})).toBeDisabled();
  await second.route('**/api/v1'+s.root+'/supply-products/'+p.product_id,async route=>{
   if(route.request().method()!=='PATCH')return route.continue();requests.push(signature(route.request()));const response=await route.fetch();statuses.push(response.status());await route.fulfill({response});
  });
  await secondForm.getByRole('button',{name:'儲存內容',exact:true}).click();await expect(secondForm.getByRole('button',{name:'以最新版本重新套用',exact:true})).toBeEnabled();
  expect(statuses).toEqual([412]);expect(requests).toHaveLength(1);expect(requests[0].version).toBe(`"${p.version}"`);
  await expect(secondForm.getByLabel('商品名稱',{exact:true})).toHaveValue(secondTitle);await expect(secondForm.getByRole('textbox',{name:'說明',exact:true})).toHaveValue(secondDescription);
  await expect(secondForm).toContainText('你的修改：'+secondTitle);await expect(secondForm).toContainText('目前資料：'+firstTitle);await expect(secondForm).toContainText('目前資料：'+firstDescription);
  expect((await detail(page,s,p.product_id)).product.title).toBe(firstTitle);await evidence(second,info,'two-tabs-conflict',{requests,statuses});expect(requests).toHaveLength(1);
  await secondForm.getByRole('button',{name:'以最新版本重新套用',exact:true}).click();await expect(secondForm.getByRole('status')).toHaveText('已保存：儲存內容。');
  expect(statuses).toEqual([412,200]);expect(requests).toHaveLength(2);expect(requests[1].key).not.toBe(requests[0].key);expect(requests[1].key).toBeTruthy();expect(requests[1].version).toBe(`"${Number(p.version)+1}"`);expect(requests[1].body).toBe(requests[0].body);
  expect((await detail(page,s,p.product_id)).product).toMatchObject({title:secondTitle,description:secondDescription,version:String(Number(p.version)+2)});
  await info.attach('two-tabs-reapply',{body:JSON.stringify({requests,statuses}),contentType:'application/json'});
 }finally{await second.close();}
});

test('SC-E2E-23 stock below the reserved quantity is refused and the input is kept (AT-08)',async({page,browser,baseURL,e2eAuthPool},info)=>{
 test.setTimeout(120_000);
 const s=await supplier(page,e2eAuthPool),p=await product(page,s),contexts=await Promise.all([browser.newContext({baseURL}),browser.newContext({baseURL})]);
 try{
  const [seller,buyer]=await Promise.all(contexts.map(c=>c.newPage())),retailer=await person(e2eAuthPool),customer=await person(e2eAuthPool);
  await login(seller,retailer.email);await login(buyer,customer.email);const b=await launchStore(seller,unique('合成預留零售空間')),slug='recovery-'+randomUUID().slice(0,12);
  await post(seller,b.root+'/setup',{name:unique('合成預留零售店'),slug,currency:'TWD'},201);
  const terms=await patch(page,s.root+`/products/${p.product_id}/supply-terms`,{cost_minor:400,shipping_minor:0,shipping_terms:'合成確認後出貨',return_terms:'合成瑕疵退換'},p.version);
  const offer=SupplyOfferSchema.parse(await post(page,s.root+`/products/${p.product_id}/supply-offer`,{},200,terms.version));
  const selection=DistributionSchema.parse(await post(seller,b.root+'/distribution-selections',{offer_id:offer.offer_id,terms_sha256:offer.terms_sha256,retail_price_minor:1100},201));
  await go(page,s,'/terms/'+selection.selection_id);await active(page).getByRole('button',{name:'同意',exact:true}).click();await expect(consoleArea(page).locator('.sc-announcement')).toHaveText('已保存：同意售價申請。');
  await nav(page,'預留與訂單');await active(page).getByRole('button',{name:'開放 30 分鐘預留',exact:true}).click();await expect(active(page).getByRole('button',{name:'停止接受新預留',exact:true})).toBeEnabled();
  const setting=await get(seller,b.root+'/reservation-setting');await patch(seller,b.root+'/reservation-setting',{reservation_enabled:true},setting.version);
  const store=await get(seller,b.root);await post(seller,b.root+'/publish',{},200,store.version);
  await buyer.goto('/#reservations/'+slug);await buyer.getByLabel(p.title+'數量',{exact:true}).fill('3');await buyer.getByRole('button',{name:'查看預留內容',exact:true}).click();
  await expect(buyer.getByRole('region',{name:'確認預留內容',exact:true})).toBeVisible();await buyer.getByRole('button',{name:'確認預留 30 分鐘',exact:true}).click();await expect(buyer.getByRole('region',{name:'我的預留',exact:true})).toContainText('預留中');
  const balance=async()=>(await e2eAuthPool.query('SELECT stock,reserved FROM commerce_items WHERE item_id=$1',[p.product_id])).rows;
  expect(await balance()).toEqual([{stock:10,reserved:3}]);await go(page,s,'/products/'+p.product_id);
  const form=active(page).getByRole('form',{name:'儲存庫存',exact:true});await form.getByLabel('庫存',{exact:true}).fill('2');
  const refused=page.waitForResponse(r=>r.request().method()==='PATCH'&&r.url().endsWith('/supply-products/'+p.product_id));await form.getByRole('button',{name:'儲存庫存',exact:true}).click();expect((await refused).status()).toBe(409);
  await expect(form.getByRole('status')).toContainText('庫存不能低於已保留的數量');await expect(form.getByLabel('庫存',{exact:true})).toHaveValue('2');await expect(active(page)).toContainText('庫存 10／已預留 3／可用 7');expect(await balance()).toEqual([{stock:10,reserved:3}]);
  await evidence(page,info,'stock-below-real-reservation');await form.getByLabel('庫存',{exact:true}).fill('5');
  const accepted=page.waitForResponse(r=>r.request().method()==='PATCH'&&r.url().endsWith('/supply-products/'+p.product_id));await form.getByRole('button',{name:'儲存庫存',exact:true}).click();expect((await accepted).status()).toBe(200);
  await expect(form.getByRole('status')).toHaveText('已保存：儲存庫存。');expect(await balance()).toEqual([{stock:5,reserved:3}]);
  buyer.once('dialog',dialog=>dialog.accept());await buyer.getByRole('button',{name:'取消預留',exact:true}).click();await expect(buyer.getByRole('region',{name:'我的預留',exact:true})).toContainText('已取消');
 }finally{
  await Promise.allSettled(contexts.map(c=>c.close()));await e2eAuthPool.query(`UPDATE commerce_hosted_supply_offers o SET state='withdrawn',version=o.version+1
   FROM commerce_storefront_profiles p JOIN commerce_shops s ON s.shop_id=p.supply_shop_id
   WHERE o.instance_id=p.instance_id AND o.tenant_id=p.tenant_id AND s.owner_id=$1 AND o.state='offered'`,[s.member.id]);
 }
});

test('SC-E2E-24 a failed overview read is shown as unavailable, never as zero (AT-29)',async({page,e2eAuthPool},info)=>{
 test.setTimeout(120_000);
 const s=await supplier(page,e2eAuthPool),p=await product(page,s);let fail=true;const failures:boolean[]=[];
 await page.route('**/api/v1'+s.root+'/supplier-console/overview',async route=>{
  if(route.request().method()!=='GET')return route.continue();failures.push(fail);
  if(fail)await route.fulfill({status:503,contentType:'application/problem+json',body:JSON.stringify({type:'urn:freedom:problem:service_unavailable',title:'service_unavailable',status:503,code:'service_unavailable',detail:'合成測試：營運概覽暫時無法讀取。'})});else await route.continue();
 });
 await go(page,s);await expect(active(page).getByRole('alert')).toContainText('暫時無法讀取營運概覽');await expect(active(page).getByRole('button',{name:'重試',exact:true})).toBeEnabled();
 await expect(consoleArea(page).locator('.sc-metric-value')).toHaveCount(0);await expect(consoleArea(page).locator('.sc-metrics')).toHaveCount(0);expect(failures.length).toBeGreaterThan(0);expect(failures.every(Boolean)).toBe(true);
 await evidence(page,info,'overview-first-read-unavailable');fail=false;await active(page).getByRole('button',{name:'重試',exact:true}).click();
 await expect(consoleArea(page).locator('.sc-metric-value')).toHaveCount(4);await expect(active(page).getByRole('status')).toContainText('資料時間');const values=await consoleArea(page).locator('.sc-metric-value').allTextContents();
 await nav(page,'商品與庫存');await active(page).getByRole('link',{name:new RegExp(p.title)}).click();const form=active(page).getByRole('form',{name:'儲存庫存',exact:true});
 await form.getByLabel('庫存',{exact:true}).fill('9');await form.getByRole('button',{name:'儲存庫存',exact:true}).click();await expect(consoleArea(page).locator('.sc-announcement')).toHaveText('已保存：儲存庫存。');
 await nav(page,'營運概覽');await expect(active(page).getByRole('status')).toContainText('資料時間');await expect(consoleArea(page).locator('.sc-metric-value')).toHaveText(values);
 fail=true;await active(page).getByRole('button',{name:'更新資料',exact:true}).click();await expect(active(page).getByRole('alert')).toContainText('未更新（最後成功');
 await expect(consoleArea(page).locator('.sc-metric-value')).toHaveText(values);for(const card of await consoleArea(page).locator('.sc-metrics article').all()){await expect(card.getByRole('paragraph').filter({hasText:/^(資料時間|更新中|未更新) /})).toHaveText(/^未更新 /);}
 await expect(consoleArea(page).locator('.sc-announcement')).toHaveText('已保存：儲存庫存。');expect((await detail(page,s,p.product_id)).product.stock).toBe(9);await evidence(page,info,'overview-refresh-keeps-facts',{values,failures});
});

test('SC-E2E-25 a late response after sign-out never reaches the next member (AT-34)',async({page,e2eAuthPool},info)=>{
 test.setTimeout(120_000);
 const a=await supplier(page,e2eAuthPool),p=await product(page,a),other=await person(e2eAuthPool);
 await signOut(page);await loginHere(page,other.email);const b=await launchStore(page,unique('合成下一會員空間')),bName=unique('合成下一會員商品庫');
 await post(page,b.root+'/supply-profile',{name:bName,currency:'TWD'},201);const bp=await product(page,b,unique('合成下一會員商品'));
 await signOut(page);await loginHere(page,a.member.email);await go(page,a,'/products');await expect(active(page)).toContainText(p.title);
 const release=barrier(),entered=barrier(),completed=barrier();let intercepted=false,asB=false;const wrongPaths:string[]=[];
 page.on('request',request=>{const path=new URL(request.url()).pathname;if(asB&&path.startsWith('/api/v1/tenants/'+a.hash.split('/')[1]+'/'))wrongPaths.push(path);});
 await page.route('**/api/v1'+a.root+'/supplier-console/products',async route=>{
  if(route.request().method()!=='GET'||intercepted)return route.continue();intercepted=true;
  try{const response=await route.fetch();expect(response.status()).toBe(200);entered.resolve();await release.promise;await route.fulfill({response});}finally{completed.resolve();}
 });
 try{
  await active(page).getByRole('button',{name:'更新資料',exact:true}).first().click();await entered.promise;await signOut(page);asB=true;await loginHere(page,other.email);await go(page,b,'/products');await expect(active(page)).toContainText(bp.title);
  const forbidden=[a.name,p.title,p.product_id,...a.hash.split('/').slice(1)];
  await page.evaluate(needles=>{
   const state={leaks:[] as string[],observer:null as MutationObserver|null};
   const check=()=>{const root=document.querySelector('.supplier-console');if(!root)return;const text=root.outerHTML;for(const needle of needles)if(text.includes(needle)&&!state.leaks.includes(needle))state.leaks.push(needle);};
   state.observer=new MutationObserver(check);state.observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true});check();Object.assign(window,{recoveryIdentityWatch:state});
  },forbidden);
  release.resolve();await completed.promise;await active(page).getByRole('button',{name:'更新資料',exact:true}).first().click();await expect(active(page).getByRole('status').first()).toContainText('資料時間');await expect(active(page)).toContainText(bp.title);
  for(const value of forbidden)await expect(consoleArea(page)).not.toContainText(value);
  const leaks=await page.evaluate(()=>{const state=(window as unknown as {recoveryIdentityWatch:{leaks:string[];observer:MutationObserver}}).recoveryIdentityWatch;state.observer.disconnect();return state.leaks;});expect(leaks).toEqual([]);expect(wrongPaths).toEqual([]);
  await evidence(page,info,'late-response-next-member',{leaks,wrongPaths});
 }finally{release.resolve();await completed.promise;await page.unroute('**/api/v1'+a.root+'/supplier-console/products');}
 asB=false;await signOut(page);await loginHere(page,a.member.email);const title=unique('合成跨會員未知新增'),fault=await loseCreateAck(page,a);await newProduct(page,a,title);
 expect((await e2eAuthPool.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now()",[a.member.id])).rowCount).toBe(1);
 await held(page).getByRole('button',{name:'重試',exact:true}).click();await expect(page.getByRole('heading',{name:'登入',exact:true})).toBeVisible();await expect(consoleArea(page)).toHaveCount(0);expect(fault.statuses).toEqual([201,401]);
 await loginHere(page,other.email);await go(page,b,'/products');await expect(active(page)).toContainText(bp.title);await expect(held(page)).toHaveCount(0);await expect(consoleArea(page)).not.toContainText(title);await expect(consoleArea(page)).not.toContainText(a.name);expect(fault.requests).toHaveLength(2);
 await signOut(page);await loginHere(page,a.member.email);await go(page,a);await expect(held(page)).toBeVisible();expect(fault.requests).toHaveLength(2);
 await retryCreate(page,a);await expect(held(page)).toHaveCount(0);
 expect(fault.statuses).toEqual([201,401,201]);expect(fault.requests).toHaveLength(3);expect(fault.requests[1]).toEqual(fault.requests[0]);expect(fault.requests[2]).toEqual(fault.requests[0]);await exactlyOne(page,e2eAuthPool,a,title);await evidence(page,info,'held-attempt-original-member-only',fault);
});

test('SC-E2E-26 a writer who loses permission keeps the saved data and gets clear read-only state (AT-37)',async({page,browser,baseURL,e2eAuthPool},info)=>{
 test.setTimeout(120_000);
 const s=await supplier(page,e2eAuthPool),p=await product(page,s),operator=await person(e2eAuthPool),context=await browser.newContext({baseURL}),release=barrier(),committed=barrier();
 const [,tenant,instance]=s.hash.split('/'),requests:ReturnType<typeof signature>[]=[],statuses:number[]=[];
 try{
  const writer=await context.newPage();await login(writer,operator.email);const candidate=await get(page,'/tenants/invite-candidates?user_id='+operator.id);
  const invitation=await post(page,`/tenants/${tenant}/invitations`,{invitee_principal_id:candidate.principal_id,role:'operator',instance_capabilities:[{instance_id:instance,capabilities:['store:read','store:write']}],expires_at:new Date(Date.now()+86400000).toISOString()},201);
  await post(writer,`/tenants/${tenant}/invitations/${invitation.invitation_id}/accept`,{},200,invitation.version);await go(writer,s,'/products/'+p.product_id);
  await writer.route('**/api/v1'+s.root+'/supply-products/'+p.product_id,async route=>{
   if(route.request().method()!=='PATCH')return route.continue();requests.push(signature(route.request()));const response=await route.fetch();statuses.push(response.status());expect(response.status()).toBe(200);committed.resolve();await release.promise;await route.fulfill({response});
  });
  const form=active(writer).getByRole('form',{name:'儲存庫存',exact:true});await form.getByLabel('庫存',{exact:true}).fill('7');await form.getByRole('button',{name:'儲存庫存',exact:true}).click();await committed.promise;
  expect((await e2eAuthPool.query('SELECT stock,reserved FROM commerce_items WHERE item_id=$1',[p.product_id])).rows).toEqual([{stock:7,reserved:0}]);
  const members=await get(page,`/tenants/${tenant}/members`),membership=members.items.find((item:{principal_id:string})=>item.principal_id===candidate.principal_id);
  await post(page,`/tenants/${tenant}/members/${candidate.principal_id}/change`,{role:'operator',status:'active',instance_capabilities:[{instance_id:instance,capabilities:['store:read']}],reason:'Synthetic supplier console permission recovery'},200,membership.version);release.resolve();
  await expect(consoleArea(writer).locator('.sc-announcement')).toHaveText('已保存：儲存庫存。');await expect(active(writer)).toContainText('需要商品編輯權限才能查看');await expect(active(writer).getByRole('form')).toHaveCount(0);expect(requests).toHaveLength(1);expect(statuses).toEqual([200]);
  expect((await detail(page,s,p.product_id)).product).toMatchObject({stock:7,version:String(Number(p.version)+1)});
  await evidence(writer,info,'committed-save-after-write-revocation',{requests,statuses});
  for(const suffix of ['/products','/products/'+p.product_id,'/products/new','/partners','/terms']){await go(writer,s,suffix);await expect(active(writer)).toContainText('需要商品編輯權限才能查看');await expect(active(writer).getByRole('form')).toHaveCount(0);}
  expect(requests).toHaveLength(1);expect((await e2eAuthPool.query('SELECT stock,reserved FROM commerce_items WHERE item_id=$1',[p.product_id])).rows).toEqual([{stock:7,reserved:0}]);
 }finally{release.resolve();await context.close();}
});
