import {openPageTools} from './navigation.js';
import {test,expect,type Page} from './fixtures.js';
import {navigate,signOut} from './navigation.js';
import {readFile} from 'node:fs/promises';
async function login(page:Page,email='maker@local.test'){
 const field=page.getByLabel('電子郵件',{exact:true});
 // signOut already waits for the real login screen; keep that document instead of reloading it.
 if(!await field.isVisible())await page.goto('/');
 await field.fill(email);await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.getByRole('button',{name:'設定',exact:true})).toBeVisible();
}
const productManifest={schema:'freedom-shop/v1',kind:'internal',access:'authenticated',name:'AI 整理的內部茶店',description:'合成資料，不是真實商品',website_url:'https://private.example.com',contact:'合成聯絡方式',currency:'TWD',products:[{sku:'AI-TEA',title:'AI 茶葉目錄',description:'150g 合成茶葉',photo_url:null,price_minor:30000,shipping_minor:6000,stock:10,shipping_terms:'合成出貨條件',return_terms:'合成退貨條件'}]};
async function upload(page:Page,value:unknown){await page.getByLabel('上傳成果檔',{exact:true}).setInputFiles({name:'freedom-shop.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(value))});}
const layoutWidths=[1920,1280,820,390,320];
async function archiveUpload(page:Page,value:{name:string}){
 await upload(page,value);await expect(page.getByRole('heading',{name:`確認這次成果：${value.name}`,exact:true})).toBeVisible();
 const waiting=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/v1/commerce/import');
 await page.getByRole('button',{name:'確認並歸檔',exact:true}).click();
 const response=await waiting;expect(response.status()).toBe(201);const receipt=await response.json();
 await expect(page.getByText('成果已歸檔，可在我的商店查看。',{exact:true})).toBeVisible();
 return receipt.shop_id;
}

test('AI-first shops download complete MD, preview/import files, select catalog and register a public shop',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await login(page);await navigate(page,'我有東西要賣');
 await expect(page.getByRole('heading',{name:'有商品，就能開始。',exact:true})).toBeVisible();
 await expect(page.getByLabel('商品名稱',{exact:true})).toHaveCount(0);
 const waiting=page.waitForEvent('download');await page.getByRole('button',{name:'下載內部商店 MD',exact:true}).click();const d=await waiting;
 const md=await readFile((await d.path())!,'utf8');for(const marker of ['freedom-shop/v1','shop-api/v1','delivery_ref'])expect(md).toContain(marker);
 const internalInstructions=(await readFile(new URL('../../packages/shop-agent/internal.md',import.meta.url),'utf8')).trim();
 expect(internalInstructions).not.toBe('');expect(md).toContain(internalInstructions);
 await upload(page,productManifest);await expect(page.getByRole('heading',{name:'確認這次成果：AI 整理的內部茶店',exact:true})).toBeVisible();
 await expect(page.getByRole('region',{name:'我的內部商店',exact:true}).getByRole('article')).toHaveCount(0);
 await page.getByRole('button',{name:'確認並歸檔',exact:true}).click();const privateShop=page.getByRole('region',{name:'我的內部商店',exact:true}).getByRole('article').filter({has:page.getByRole('heading',{name:productManifest.name,exact:true})});await expect(privateShop).toBeVisible();
 await page.reload();await expect(privateShop).toBeVisible();
 const shops=await page.request.get('/api/v1/commerce/shops');const privateId=(await shops.json()).items.find((s:any)=>s.name===productManifest.name).shop_id;
 expect((await page.request.get(`/api/v1/public-shops/${privateId}`)).status()).toBe(404);
 await privateShop.getByText('連線設定（交給 AI 協助）',{exact:true}).click();await privateShop.getByRole('button',{name:'產生／重建連線金鑰'}).click();const privateToken=await privateShop.getByLabel('一次性顯示的連線金鑰').inputValue();await privateShop.getByText('連線設定（交給 AI 協助）',{exact:true}).click();
 // The removed sweep ended at 320px; keep the remaining real business journey on phone.
 await page.setViewportSize({width:320,height:900});
 await signOut(page);await login(page,'client@local.test');await navigate(page,'我可以賣東西');
 await expect(page.getByRole('button',{name:'下載公開商店 MD',exact:true})).toBeDisabled();
 await page.getByRole('region',{name:'挑選這次想賣的商品',exact:true}).getByLabel('搜尋商品',{exact:true}).fill('AI 茶葉目錄');
 await page.getByLabel('選入「AI 茶葉目錄」',{exact:true}).check();
 const publicDownload=page.waitForEvent('download');await page.getByRole('button',{name:'下載公開商店 MD',exact:true}).click();const pd=await publicDownload,publicMd=await readFile((await pd.path())!,'utf8');expect(publicMd).toContain('AI 茶葉目錄');expect(publicMd).not.toContain('https://private.example.com');
 const publicInstructions=(await readFile(new URL('../../packages/shop-agent/public.md',import.meta.url),'utf8')).trim();
 expect(publicInstructions).not.toBe('');expect(publicMd).toContain(publicInstructions);
 const catalog=await page.request.get('/api/v1/commerce/catalog'),item=(await catalog.json()).items.find((i:any)=>i.title==='AI 茶葉目錄');
 const manifest={schema:'freedom-shop/v1',kind:'public',name:'AI 公開選物店',description:'合成測試商店',website_url:'https://public.example.com',contact:'合成客服',currency:'TWD',selections:[{item_id:item.item_id,retail_price_minor:50000,sale_terms:'含運售價'}]};
 await upload(page,manifest);await page.getByRole('button',{name:'取消',exact:true}).click();await expect(page.getByRole('heading',{name:'AI 公開選物店',exact:true})).toHaveCount(0);
 await upload(page,manifest);await page.getByRole('button',{name:'確認並歸檔',exact:true}).click();const publicShop=page.getByRole('region',{name:'我的公開商店',exact:true}).getByRole('article').filter({has:page.getByRole('heading',{name:manifest.name,exact:true})});await expect(publicShop).toBeVisible();await expect(publicShop.getByRole('link',{name:'開啟公開商店'})).toHaveAttribute('href',manifest.website_url);
 await publicShop.getByRole('button',{name:'查看訂單與付款'}).click();await expect(publicShop.getByText('目前沒有訂單。完成金流與商店連線後，交易會出現在這裡。',{exact:true})).toBeVisible();
 await publicShop.getByText('連線設定（交給 AI 協助）',{exact:true}).click();await publicShop.getByRole('button',{name:'產生／重建連線金鑰'}).click();await expect(publicShop.getByLabel('一次性顯示的連線金鑰')).toHaveValue(/^fw_shop_/);const publicToken=await publicShop.getByLabel('一次性顯示的連線金鑰').inputValue();
 await publicShop.getByText('連線設定（交給 AI 協助）',{exact:true}).click();await expect(publicShop.getByLabel('一次性顯示的連線金鑰')).toHaveCount(0);
 await signOut(page);await login(page);await navigate(page,'我有東西要賣');
 const requests=page.getByRole('region',{name:'待接受的實際售價',exact:true});
 await expect(requests.getByRole('heading',{name:'AI 茶葉目錄',exact:true})).toBeVisible();
 await requests.getByRole('button',{name:'接受這一版售價',exact:true}).click();
 await expect(requests.getByText('已接受這一版售價',{exact:true})).toBeVisible();
 await signOut(page);await login(page,'client@local.test');await navigate(page,'我可以賣東西');
 const selling=page.getByRole('region',{name:'我的公開商店',exact:true}).getByRole('article').filter({has:page.getByRole('heading',{name:manifest.name,exact:true})});
 await selling.getByRole('button',{name:'查看訂單與付款'}).click();
 const headers={Authorization:`Bearer ${publicToken}`},privateHeaders={Authorization:`Bearer ${privateToken}`};
 const connection=await page.request.get('/shop-api/v1/connection',{headers});const selection=(await connection.json()).selections[0];
 const quoted=await page.request.post('/shop-api/v1/orders',{headers,data:{external_id:'browser-synthetic-order',items:[{selection_id:selection.selection_id,quantity:1,delivery_ref:'browser_delivery_ref'}]}});expect(quoted.status()).toBe(201);const order=await quoted.json(),transfer=order.transfers[0];
 const receipt={event_id:'browser-buyer-paid',type:'paid',provider:'synthetic',transaction_ref:'browser-buyer-transaction',amount_minor:50000,currency:'TWD',mode:'test',verification:'provider_verified_by_merchant'};
 expect((await page.request.post(`/shop-api/v1/orders/${order.order_id}/payment`,{headers,data:receipt})).status()).toBe(200);
 expect((await page.request.post(`/shop-api/v1/transfers/${transfer.transfer_id}/payment-link`,{headers:privateHeaders,data:{url:'https://private.example.com/pay/browser-order'}})).status()).toBe(200);
 await selling.getByRole('button',{name:'重新整理訂單'}).click();await expect(selling.getByRole('link',{name:'支付商品成本'})).toHaveAttribute('href','https://private.example.com/pay/browser-order');
 expect((await page.request.post(`/shop-api/v1/orders/${order.order_id}/transfers/${transfer.transfer_id}/payment`,{headers:privateHeaders,data:{...receipt,event_id:'browser-cost-paid',transaction_ref:'browser-cost-transaction',amount_minor:36000}})).status()).toBe(200);
 await signOut(page);await login(page);await navigate(page,'我有東西要賣');await privateShop.getByRole('button',{name:'查看訂單與付款'}).click();await privateShop.getByText('登記出貨',{exact:true}).click();
 await privateShop.getByLabel('物流公司',{exact:true}).fill('合成物流');await privateShop.getByLabel('物流單號',{exact:true}).fill('BROWSER-SYNTHETIC');await privateShop.getByLabel('出貨日期與時間',{exact:true}).fill('2026-09-01T10:00');await privateShop.getByRole('button',{name:'保存出貨登記'}).click();await expect(privateShop.getByText(/出貨方已登記：.*BROWSER-SYNTHETIC/)).toBeVisible();
 const read=await page.request.get(`/shop-api/v1/orders/${order.order_id}`,{headers});expect((await read.json()).transfers[0].shipment.source).toBe('shipper_entered');
 expect(errors).toEqual([]);
});

for(const kind of ['internal','public'] as const)test(`${kind} shop layout keeps readable controls inside the workspace at every viewport`,async({page})=>{
 // Each layout case owns its setup; none borrows a shop from the business journey.
 await login(page,'reviewer@local.test');await navigate(page,'我有東西要賣');
 const internal={...productManifest,mode:'test',name:`版型 ${kind} 供貨店`,products:[{...productManifest.products[0],sku:`LAYOUT-${kind}`,title:`版型 ${kind} 商品`}]};
 const internalId=await archiveUpload(page,internal);let shopName=internal.name;
 if(kind==='public'){
  const catalog=await page.request.get('/api/v1/commerce/catalog'),item=(await catalog.json()).items.find((row:any)=>row.shop_id===internalId);
  const manifest={schema:'freedom-shop/v1',mode:'test',kind:'public',name:'版型公開選物店',description:'合成版型資料',website_url:'https://layout.example.com',contact:'合成客服',currency:'TWD',selections:[{item_id:item.item_id,retail_price_minor:50000,sale_terms:'合成選品條件'}]};
  await navigate(page,'我可以賣東西');await archiveUpload(page,manifest);shopName=manifest.name;
 }
 const card=page.getByRole('region',{name:kind==='internal'?'我的內部商店':'我的公開商店',exact:true}).getByRole('article').filter({has:page.getByRole('heading',{name:shopName,exact:true})});
 const controls=[card.getByRole('link',{name:kind==='internal'?'開啟我的內部商店':'開啟公開商店',exact:true}),card.getByRole('button',{name:'查看訂單與付款',exact:true}),card.getByRole('button',{name:/接單/})];
 const selection=kind==='public'?page.getByLabel(`選入「${internal.products[0].title}」`,{exact:true}):null;
 await expect(card).toBeVisible();
 for(const width of layoutWidths){
  await page.setViewportSize({width,height:900});
  for(const control of controls){await expect(control).toBeVisible();await expect(control).toBeEnabled();}
  if(selection){await expect(selection).toBeVisible();await expect(selection).toBeEnabled();}
  const layout=await card.evaluate(el=>{
   const main=document.querySelector('.workspace-main')!.getBoundingClientRect(),panel=document.querySelector('.agent-shops')!.getBoundingClientRect(),card=el.getBoundingClientRect();
   const measure=(control:HTMLElement)=>{const rect=control.getBoundingClientRect();return {left:rect.left,right:rect.right,width:rect.width,height:rect.height,clipped:control.scrollWidth>control.clientWidth+1};};
   return {viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,main:{left:main.left,right:main.right},panel:{left:panel.left,right:panel.right},card:{left:card.left,right:card.right},
    products:Array.from(document.querySelectorAll('.shop-catalog .shop-product'),product=>{const rect=product.getBoundingClientRect();return {left:rect.left,right:rect.right};}),
    controls:Array.from(el.querySelectorAll<HTMLElement>('.shop-card-actions > .btn'),measure),
    selectionControls:Array.from(document.querySelectorAll<HTMLInputElement>('.shop-catalog input[type="checkbox"]'),input=>input.labels?.[0]?measure(input.labels[0]):null)};
  });
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewport);
  expect(layout.panel.left).toBeGreaterThanOrEqual(layout.main.left);expect(layout.panel.right).toBeLessThanOrEqual(layout.main.right);
  expect(layout.card.left).toBeGreaterThanOrEqual(layout.panel.left);expect(layout.card.right).toBeLessThanOrEqual(layout.panel.right);
  for(const product of layout.products){expect(product.left).toBeGreaterThanOrEqual(layout.panel.left);expect(product.right).toBeLessThanOrEqual(layout.panel.right);}
  for(const control of layout.controls){
   expect(control.left).toBeGreaterThanOrEqual(layout.card.left);expect(control.right).toBeLessThanOrEqual(layout.card.right);
   expect(control.width).toBeGreaterThanOrEqual(44);expect(control.height).toBeGreaterThanOrEqual(44);expect(control.clipped).toBe(false);
  }
  if(selection)expect(layout.selectionControls.length).toBeGreaterThan(0);
  for(const control of layout.selectionControls){
   expect(control,'each product selector has an associated click target').not.toBeNull();
   expect(control!.left).toBeGreaterThanOrEqual(layout.panel.left);expect(control!.right).toBeLessThanOrEqual(layout.panel.right);
   expect(control!.width).toBeGreaterThanOrEqual(44);expect(control!.height).toBeGreaterThanOrEqual(44);expect(control!.clipped).toBe(false);
  }
  await page.evaluate(()=>window.scrollTo({top:0,left:0,behavior:'instant'}));
  await page.screenshot({path:`test-results/agent-layout-${kind}-${width}.png`,fullPage:true});
 }
});

test('bad or wrong-role manifests never create a shop; form stays simple',async({page})=>{
 await login(page,'reviewer@local.test');await navigate(page,'我可以賣東西');
 await upload(page,productManifest);await expect(page.getByRole('alert')).toContainText('請到另一個開店入口匯入');await expect(page.getByRole('button',{name:'確認並歸檔'})).toHaveCount(0);
 await upload(page,{...productManifest,api_key:'must-not-import'});await expect(page.getByRole('alert')).toBeVisible();await expect(page.getByRole('button',{name:'確認並歸檔'})).toHaveCount(0);
 await page.getByText('我有成果檔網址',{exact:true}).click();await page.getByLabel('成果檔網址',{exact:true}).fill('https://127.0.0.1/secrets.json');await page.getByRole('button',{name:'讀取成果',exact:true}).click();await expect(page.getByRole('alert')).toContainText('原始 JSON');
});

test('result files reject malformed UTF-8, clear stale previews and preserve valid Unicode at the byte limit',async({page})=>{
 await login(page);await navigate(page,'我有東西要賣');await page.setViewportSize({width:320,height:900});
 // Literal U+FFFD is valid input; only malformed source bytes must fail.
 const value={...productManifest,mode:'test',name:'UTF-8 合成茶店 🫖 �',products:[{...productManifest.products[0],sku:'UTF8-ROUNDTRIP',title:'茶葉 🫖 �'}]};
 const json=Buffer.from(JSON.stringify(value)),bom=Buffer.from([0xef,0xbb,0xbf]);
 const atLimit=Buffer.concat([bom,json,Buffer.alloc(24000-bom.length-json.length,0x20)]);
 const invalidSource=Buffer.from(JSON.stringify({...value,products:[{...value.products[0],title:'BROKEN'}]})),offset=invalidSource.indexOf('BROKEN');
 const invalid=Buffer.concat([invalidSource.subarray(0,offset),Buffer.from([0xc3,0x28]),invalidSource.subarray(offset+'BROKEN'.length)]);
 let previews=0,imports=0;
 page.on('request',request=>{if(request.method()!=='POST')return;const path=new URL(request.url()).pathname;if(path==='/api/v1/commerce/preview')previews++;if(path==='/api/v1/commerce/import')imports++;});
 const input=page.getByLabel('上傳成果檔',{exact:true});
 const firstPreview=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/v1/commerce/preview');
 await input.setInputFiles({name:'freedom-shop.json',mimeType:'application/json',buffer:atLimit});
 expect((await firstPreview).status()).toBe(200);
 await expect(page.locator('.shop-import-preview')).toContainText(value.products[0].title);
 await input.setInputFiles({name:'invalid-utf8.json',mimeType:'application/json',buffer:invalid});
 await expect(page.getByRole('alert')).toContainText('有效的 UTF-8 編碼');
 await expect(page.getByRole('button',{name:'確認並歸檔',exact:true})).toHaveCount(0);
 expect(previews).toBe(1);expect(imports).toBe(0);await expect(input).toBeEnabled();
 await input.setInputFiles({name:'too-large.json',mimeType:'application/json',buffer:Buffer.concat([atLimit,Buffer.from(' ')])});
 await expect(page.getByRole('alert')).toContainText('24 KB');
 expect(previews).toBe(1);expect(imports).toBe(0);
 const markdown=Buffer.concat([bom,Buffer.from('# 合成成果\n\n```json\n'+JSON.stringify(value)+'\n```\n')]);
 const secondPreview=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/v1/commerce/preview');
 await input.setInputFiles({name:'freedom-shop.md',mimeType:'text/markdown',buffer:markdown});
 expect((await secondPreview).status()).toBe(200);
 await expect(page.locator('.shop-import-preview')).toContainText(value.products[0].title);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 const imported=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/v1/commerce/import');
 await page.getByRole('button',{name:'確認並歸檔',exact:true}).click();
 const response=await imported;expect(response.status()).toBe(201);const receipt=await response.json();
 await expect(page.getByText('成果已歸檔，可在我的商店查看。',{exact:true})).toBeVisible();
 const catalog=await page.request.get('/api/v1/commerce/catalog');expect(catalog.status()).toBe(200);
 const item=(await catalog.json()).items.find((row:any)=>row.shop_id===receipt.shop_id);
 expect(item).toMatchObject({title:value.products[0].title,shop_name:value.name});
 expect(previews).toBe(2);expect(imports).toBe(1);
});

test('both shop page guides open and close without clipping on phone',async({page})=>{
 await login(page);await page.setViewportSize({width:320,height:900});
 for(const title of ['我有東西要賣','我可以賣東西']){
  await navigate(page,title);await openPageTools(page); await page.getByRole('button',{name:'頁面說明',exact:true}).click();
  const guide=page.getByRole('dialog',{name:`${title}：頁面說明`,exact:true});
  await expect(guide).toBeVisible();
  const summary=guide.locator('.page-tools-lead'),steps=guide.locator('.page-tools-help-steps li');
  await expect(summary).toBeVisible();await expect(summary).toHaveText(/\S/);await expect(steps.first()).toBeVisible();
  for(const step of await steps.all()){await expect(step).toBeVisible();await expect(step).toHaveText(/\S/);}
  expect(await guide.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  await page.screenshot({path:`test-results/agent-guide-${title}.png`,fullPage:true});
  await page.keyboard.press('Escape');await expect(guide).toHaveCount(0);
 }
});

for(const nextEmail of ['reviewer@local.test','maker@local.test'])test(`a pending file read cannot preview under a replacement login (${nextEmail})`,async({page})=>{
 await login(page);await navigate(page,'我有東西要賣');
 const previews:string[]=[];page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/v1/commerce/preview')previews.push(request.postData()??'');});
 await page.evaluate(()=>{
  const state=window as unknown as {heldFile?:{started:boolean;release:()=>void}};
  const original=File.prototype.arrayBuffer;let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  state.heldFile={started:false,release};
  File.prototype.arrayBuffer=async function(){state.heldFile!.started=true;await held;return original.call(this);};
 });
 await upload(page,productManifest);
 await expect.poll(()=>page.evaluate(()=>(window as unknown as {heldFile:{started:boolean}}).heldFile.started)).toBe(true);
 await signOut(page);
 // Keep this document alive: a page.goto() would discard the held File promise.
 await page.getByLabel('電子郵件',{exact:true}).fill(nextEmail);await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.getByRole('button',{name:'設定',exact:true})).toBeVisible();await navigate(page,'我有東西要賣');
 await page.evaluate(async()=>{(window as unknown as {heldFile:{release:()=>void}}).heldFile.release();await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));});
 expect(previews).toEqual([]);await expect(page.getByRole('heading',{name:`確認這次成果：${productManifest.name}`,exact:true})).toHaveCount(0);
 await upload(page,productManifest);await expect(page.getByRole('heading',{name:`確認這次成果：${productManifest.name}`,exact:true})).toBeVisible();
 expect(previews).toHaveLength(1);await expect(page.getByRole('button',{name:'確認並歸檔',exact:true})).toBeVisible();
});

test('a completed kit response cannot download after its page is replaced',async({page})=>{
 await login(page);await navigate(page,'我有東西要賣');
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
 const downloads:string[]=[];page.on('download',download=>downloads.push(download.suggestedFilename()));
 const path='**/api/v1/commerce/agent-kit';
 await page.route(path,async route=>{const response=await route.fetch();expect(response.ok()).toBe(true);entered();await held;await route.fulfill({response});});
 try{
  await page.getByRole('button',{name:'下載內部商店 MD',exact:true}).click();await started;
  await navigate(page,'會員首頁');const completed=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/v1/commerce/agent-kit');release();await completed;
  await page.evaluate(async()=>{await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));});
  expect(downloads).toEqual([]);await page.unroute(path);
  await navigate(page,'我有東西要賣');const current=page.waitForEvent('download');await page.getByRole('button',{name:'下載內部商店 MD',exact:true}).click();await current;expect(downloads).toHaveLength(1);
 }finally{release();await page.unroute(path);}
});
