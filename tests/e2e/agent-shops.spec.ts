import {openPageTools} from './navigation.js';
import {test,expect,type Page} from './fixtures.js';
import {navigate,signOut} from './navigation.js';
import {readFile} from 'node:fs/promises';
async function login(page:Page,email='maker@local.test'){
 await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill(email);await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.getByRole('button',{name:'設定',exact:true})).toBeVisible();
}
const productManifest={schema:'freedom-shop/v1',kind:'internal',access:'authenticated',name:'AI 整理的內部茶店',description:'合成資料，不是真實商品',website_url:'https://private.example.com',contact:'合成聯絡方式',currency:'TWD',products:[{sku:'AI-TEA',title:'AI 茶葉目錄',description:'150g 合成茶葉',photo_url:null,price_minor:30000,shipping_minor:6000,stock:10,shipping_terms:'合成出貨條件',return_terms:'合成退貨條件'}]};
async function upload(page:Page,value:unknown){await page.getByLabel('上傳成果檔',{exact:true}).setInputFiles({name:'freedom-shop.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(value))});}

test('AI-first shops download complete MD, preview/import files, select catalog and register a public shop',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await login(page);await navigate(page,'我有東西要賣');
 await expect(page.getByRole('heading',{name:'有商品，就能開始。',exact:true})).toBeVisible();
 await expect(page.getByLabel('商品名稱',{exact:true})).toHaveCount(0);
 const waiting=page.waitForEvent('download');await page.getByRole('button',{name:'下載內部商店 MD',exact:true}).click();const d=await waiting;
 const md=await readFile((await d.path())!,'utf8');for(const text of ['內部商店','freedom-shop/v1','身分','付款','環境變數','shop-api/v1','delivery_ref'])expect(md).toContain(text);
 await upload(page,productManifest);await expect(page.getByRole('heading',{name:'確認這次成果：AI 整理的內部茶店',exact:true})).toBeVisible();
 await expect(page.getByRole('region',{name:'我的內部商店',exact:true}).getByRole('article')).toHaveCount(0);
 await page.getByRole('button',{name:'確認並歸檔',exact:true}).click();const privateShop=page.getByRole('region',{name:'我的內部商店',exact:true}).getByRole('article').filter({has:page.getByRole('heading',{name:productManifest.name,exact:true})});await expect(privateShop).toBeVisible();
 await page.reload();await expect(privateShop).toBeVisible();
 const shops=await page.request.get('/api/v1/commerce/shops');const privateId=(await shops.json()).items.find((s:any)=>s.name===productManifest.name).shop_id;
 expect((await page.request.get(`/api/v1/public-shops/${privateId}`)).status()).toBe(404);
 await privateShop.getByText('連線設定（交給 AI 協助）',{exact:true}).click();await privateShop.getByRole('button',{name:'產生／重建連線金鑰'}).click();const privateToken=await privateShop.getByLabel('一次性顯示的連線金鑰').inputValue();await privateShop.getByText('連線設定（交給 AI 協助）',{exact:true}).click();
 for(const width of [1920,1280,820,390,320]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);const main=await page.locator('.workspace-main').boundingBox(),panel=await page.locator('.agent-shops').boundingBox();expect(main).not.toBeNull();expect(panel).not.toBeNull();expect(panel!.x-main!.x).toBeGreaterThanOrEqual(12);expect(main!.x+main!.width-panel!.x-panel!.width).toBeGreaterThanOrEqual(12);const catalog=page.locator('.shop-catalog');if(await catalog.count()){const list=await catalog.boundingBox(),card=await catalog.locator('.shop-product').first().boundingBox();expect(Math.abs(list!.width-card!.width)).toBeLessThanOrEqual(1);}const buttons=await page.locator('.shop-card-actions > .btn').evaluateAll(els=>els.slice(0,3).map(el=>{const r=el.getBoundingClientRect();return {y:r.y,width:r.width,overflow:el.scrollWidth>el.clientWidth+1};}));expect(buttons).toHaveLength(3);expect(Math.max(...buttons.map(b=>b.y))-Math.min(...buttons.map(b=>b.y))).toBeLessThanOrEqual(1);expect(Math.max(...buttons.map(b=>b.width))-Math.min(...buttons.map(b=>b.width))).toBeLessThanOrEqual(1);expect(buttons.every(b=>!b.overflow)).toBe(true);await page.locator('.shop-card-actions').first().screenshot({path:`test-results/shop-buttons-${width}.png`});await page.screenshot({path:`test-results/agent-internal-${width}.png`,fullPage:true});}
 await signOut(page);await login(page,'client@local.test');await navigate(page,'我可以賣東西');
 await expect(page.getByRole('button',{name:'下載公開商店 MD',exact:true})).toBeDisabled();
 await page.getByRole('region',{name:'挑選這次想賣的商品',exact:true}).getByLabel('搜尋商品',{exact:true}).fill('AI 茶葉目錄');
 await page.getByLabel('選入「AI 茶葉目錄」',{exact:true}).check();
 const publicDownload=page.waitForEvent('download');await page.getByRole('button',{name:'下載公開商店 MD',exact:true}).click();const pd=await publicDownload,publicMd=await readFile((await pd.path())!,'utf8');expect(publicMd).toContain('AI 茶葉目錄');expect(publicMd).toContain('支付商品成本');expect(publicMd).not.toContain('https://private.example.com');
 const catalog=await page.request.get('/api/v1/commerce/catalog'),item=(await catalog.json()).items.find((i:any)=>i.title==='AI 茶葉目錄');
 const manifest={schema:'freedom-shop/v1',kind:'public',name:'AI 公開選物店',description:'合成測試商店',website_url:'https://public.example.com',contact:'合成客服',currency:'TWD',selections:[{item_id:item.item_id,retail_price_minor:50000,sale_terms:'含運售價'}]};
 await upload(page,manifest);await page.getByRole('button',{name:'取消',exact:true}).click();await expect(page.getByRole('heading',{name:'AI 公開選物店',exact:true})).toHaveCount(0);
 await upload(page,manifest);await page.getByRole('button',{name:'確認並歸檔',exact:true}).click();const publicShop=page.getByRole('region',{name:'我的公開商店',exact:true}).getByRole('article').filter({has:page.getByRole('heading',{name:manifest.name,exact:true})});await expect(publicShop).toBeVisible();await expect(publicShop.getByRole('link',{name:'開啟公開商店'})).toHaveAttribute('href',manifest.website_url);
 await publicShop.getByRole('button',{name:'查看訂單與付款'}).click();await expect(publicShop.getByText('目前沒有訂單。完成金流與商店連線後，交易會出現在這裡。',{exact:true})).toBeVisible();
 await publicShop.getByText('連線設定（交給 AI 協助）',{exact:true}).click();await publicShop.getByRole('button',{name:'產生／重建連線金鑰'}).click();await expect(publicShop.getByLabel('一次性顯示的連線金鑰')).toHaveValue(/^fw_shop_/);const publicToken=await publicShop.getByLabel('一次性顯示的連線金鑰').inputValue();
 await publicShop.getByText('連線設定（交給 AI 協助）',{exact:true}).click();await expect(publicShop.getByLabel('一次性顯示的連線金鑰')).toHaveCount(0);
 for(const width of [1920,1280,820,390,320]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);const main=await page.locator('.workspace-main').boundingBox(),panel=await page.locator('.agent-shops').boundingBox();expect(main).not.toBeNull();expect(panel).not.toBeNull();expect(panel!.x-main!.x).toBeGreaterThanOrEqual(12);expect(main!.x+main!.width-panel!.x-panel!.width).toBeGreaterThanOrEqual(12);const catalog=page.locator('.shop-catalog');if(await catalog.count()){const list=await catalog.boundingBox(),card=await catalog.locator('.shop-product').first().boundingBox();expect(Math.abs(list!.width-card!.width)).toBeLessThanOrEqual(1);}const buttons=await page.locator('.shop-card-actions > .btn').evaluateAll(els=>els.slice(0,3).map(el=>{const r=el.getBoundingClientRect();return {y:r.y,width:r.width,overflow:el.scrollWidth>el.clientWidth+1};}));expect(buttons).toHaveLength(3);expect(Math.max(...buttons.map(b=>b.y))-Math.min(...buttons.map(b=>b.y))).toBeLessThanOrEqual(1);expect(Math.max(...buttons.map(b=>b.width))-Math.min(...buttons.map(b=>b.width))).toBeLessThanOrEqual(1);expect(buttons.every(b=>!b.overflow)).toBe(true);await page.locator('.shop-card-actions').first().screenshot({path:`test-results/shop-buttons-${width}.png`});await page.screenshot({path:`test-results/agent-public-${width}.png`,fullPage:true});}
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

test('bad or wrong-role manifests never create a shop; form stays simple',async({page})=>{
 await login(page,'reviewer@local.test');await navigate(page,'我可以賣東西');
 await upload(page,productManifest);await expect(page.getByRole('alert')).toContainText('請到另一個開店入口匯入');await expect(page.getByRole('button',{name:'確認並歸檔'})).toHaveCount(0);
 await upload(page,{...productManifest,api_key:'must-not-import'});await expect(page.getByRole('alert')).toBeVisible();await expect(page.getByRole('button',{name:'確認並歸檔'})).toHaveCount(0);
 await page.getByText('我有成果檔網址',{exact:true}).click();await page.getByLabel('成果檔網址',{exact:true}).fill('https://127.0.0.1/secrets.json');await page.getByRole('button',{name:'讀取成果',exact:true}).click();await expect(page.getByRole('alert')).toContainText('原始 JSON');
});

test('both page guides teach the AI handoff, private setup and payment steps on phone',async({page})=>{
 await login(page);await page.setViewportSize({width:320,height:900});
 for(const title of ['我有東西要賣','我可以賣東西']){
  await navigate(page,title);await openPageTools(page); await page.getByRole('button',{name:'頁面說明',exact:true}).click();
  const guide=page.getByRole('dialog',{name:`${title}：頁面說明`,exact:true});
  await expect(guide).toBeVisible();await expect(guide.locator('.page-tools-help-steps li')).toHaveCount(6);
  await expect(guide).toContainText('freedom-shop.json');await expect(guide).toContainText('金鑰');await expect(guide).toContainText('AI');
  expect(await guide.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  await page.screenshot({path:`test-results/agent-guide-${title}.png`,fullPage:true});
  await page.keyboard.press('Escape');await expect(guide).toHaveCount(0);
 }
});
