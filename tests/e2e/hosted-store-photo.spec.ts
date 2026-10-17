import {storeArea} from './hosted-store-fixture.js';
import {LIVE_PUBLIC_ORIGIN} from '../../apps/platform-api/src/routes/published-skills.js';
import {createHash,randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import sharp from 'sharp';
import {test,expect,type Page,type Request} from './fixtures.js';
import {person,login,open,post,launchStore} from './hosted-store-fixture.js';
import {navigate,signOut} from './navigation.js';
import {DEMO_PASSWORD} from '../../packages/testing/seed.js';
import {ProductViewSchema} from '../../contracts/guild-launchpad/v1/storefront.js';
import {ProductMediaCommandSchema,PublicStoreMediaSchema} from '../../contracts/guild-launchpad/v1/hosted-store-media.js';
import {DistributionPhotosSchema,PartnerMaterialsSchema} from '../../contracts/guild-launchpad/v1/supplier-console.js';

// Dedicated local schema + restricted runtime + real Sharp; FakeObjectStore is the only synthetic media provider.
test.setTimeout(90_000);
test.skip(process.env.FREEDOM_E2E_STORE_PHOTO_FIXTURE!=='1','Requires the separately scheduled local photo fixture pass.');
const photo=(page:Page)=>page.locator('.hosted-store-photo');
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
async function source(name:string,color:string){return {name,mimeType:'image/png',buffer:await sharp({create:{width:120,height:80,channels:3,background:color}}).png().toBuffer()};}
async function ready(page:Page,db:Parameters<typeof person>[0]){
  const member=await person(db);await login(page,member.email);const store=await launchStore(page,'照片驗收工作室');
  const slug='photos-'+randomUUID().slice(0,8);await post(page,store.root+'/setup',{name:'照片驗收商店',slug,currency:'TWD'},201);
  const product=ProductViewSchema.parse(await post(page,store.root+'/products',{title:'手作茶杯',price_minor:35000,stock:2},201));
  await open(page,store.hash);await expect(photo(page).getByLabel('商品照片',{exact:true})).toBeVisible();
  return {...store,member,slug,product,path:'/api/v1'+store.root+'/products/'+product.product_id+'/photo'};
}
async function save(page:Page,file:Awaited<ReturnType<typeof source>>,replace=false){
  await storeArea(page,'商品');
  await photo(page).getByLabel('商品照片',{exact:true}).setInputFiles(file);
  await photo(page).getByRole('button',{name:replace?'儲存替換照片':'儲存照片',exact:true}).click();
  await expect(photo(page).getByRole('status')).toContainText('已儲存照片變更');
  await expect(photo(page).locator(':scope > img')).toBeVisible();
}
function signature(request:Request){return {key:request.headers()['idempotency-key'],version:request.headers()['if-match'],mime:request.headers()['content-type'],sha256:digest(request.postDataBuffer()!),bytes:request.postDataBuffer()!.length};}
async function loginHere(page:Page,email:string){
  // Intentionally no goto/reload: browser RAM must survive the actual auth-driven StorePage unmount.
  await page.getByLabel('電子郵件',{exact:true}).fill(email);await page.getByLabel('密碼',{exact:true}).fill(DEMO_PASSWORD);
  await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.getByRole('button',{name:'設定',exact:true})).toBeVisible();
}

test.beforeAll(async({e2eAuthPool})=>{
  const role=process.env.FREEDOM_E2E_SCHEMA+'_app';
  expect((await e2eAuthPool.query('SELECT rolsuper,rolbypassrls,rolcreaterole FROM pg_roles WHERE rolname=$1',[role])).rows).toEqual([{rolsuper:false,rolbypassrls:false,rolcreaterole:false}]);
  expect((await e2eAuthPool.query("SELECT has_table_privilege($1,'domain_media_storage_policy','INSERT,UPDATE,DELETE') AS can_grant,has_column_privilege($1,'domain_media_storage_policy','policy_lock','UPDATE') AS can_lock",[role])).rows).toEqual([{can_grant:false,can_lock:true}]);
});

test.beforeEach(async({e2eAuthPool})=>{
  // Test-admin setup only; keep the nonlegacy floor and the same revision across cases.
  await e2eAuthPool.query("UPDATE domain_media_storage_policy SET persistence_allowed=true WHERE purpose='storefront.product-photo'");
});

test('large phone photo is prepared locally, previewed without cropping, and uploaded only after explicit save',async({page,e2eAuthPool})=>{
  await page.setViewportSize({width:390,height:900});const s=await ready(page,e2eAuthPool);
  const pixels=Buffer.alloc(1600*2400*3);for(let i=0;i<pixels.length;i++)pixels[i]=(i*31+(i>>7)*17)%256;
  const buffer=await sharp(pixels,{raw:{width:1600,height:2400,channels:3}}).png({compressionLevel:0}).toBuffer();expect(buffer.length).toBeGreaterThan(2*1024*1024);
  const uploads:Request[]=[];page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname===s.path)uploads.push(request);});
  await photo(page).getByLabel('商品照片',{exact:true}).setInputFiles({name:'synthetic-phone-photo.png',mimeType:'image/png',buffer});
  const preview=page.getByRole('img',{name:'待儲存的完整商品照片',exact:true});await expect(preview).toBeVisible();expect(uploads).toHaveLength(0);
  const shape=await preview.evaluate(node=>{const image=node as HTMLImageElement;return {width:image.naturalWidth,height:image.naturalHeight,fit:getComputedStyle(image).objectFit};});
  expect(shape.width/shape.height).toBeCloseTo(2/3,2);expect(shape.fit).toBe('contain');
  await photo(page).getByRole('button',{name:'儲存照片',exact:true}).click();await expect(photo(page).getByRole('status')).toContainText('已儲存照片變更');
  expect(uploads).toHaveLength(1);expect(uploads[0].postDataBuffer()!.length).toBeLessThanOrEqual(2*1024*1024);await expect(photo(page).locator(':scope > img')).toBeVisible();
  await page.screenshot({path:'.rd/commerce/photo-mobile.png',fullPage:true});
});

for(const width of [390,1280])test(`member photo draft, preview, immutable publication and removal at ${width}px`,async({page,browser,baseURL,e2eAuthPool},info)=>{
  await page.setViewportSize({width,height:900});const s=await ready(page,e2eAuthPool),a=await source('tea-a.png','#e8a45c'),b=await source('tea-b.png','#387362');
  await save(page,a);const privateA=await photo(page).locator(':scope > img').getAttribute('src');expect(privateA).toContain(s.product.product_id+'/photo/2');
  await storeArea(page,'店面與發布');
  const previewEvent=page.waitForEvent('popup');await page.getByRole('link',{name:'預覽已儲存的展示頁',exact:true}).click();const preview=await previewEvent;
  const anonymous=await browser.newContext({baseURL,viewport:{width,height:900}});
  try{
    await expect(preview.locator('article img')).toHaveAttribute('src',privateA!);
    expect((await anonymous.request.get(privateA!)).status()).toBe(401);
    await storeArea(page,'店面與發布');
    await page.getByRole('button',{name:'發布展示頁',exact:true}).click();await expect(page.locator('.hosted-store')).toContainText('已發布・第 1 版');
    const pub=await anonymous.newPage();await pub.goto('/shops/'+s.slug);
    const media=async()=>PublicStoreMediaSchema.parse(await(await anonymous.request.get('/api/v1/public/stores/'+s.slug+'/media')).json());
    const first=await media(),publicA=first.photos[0].photo.read_path;await expect(pub.locator('article img')).toHaveAttribute('src',publicA);
    await expect(preview.locator('meta[property^="og:"]')).toHaveCount(0);
    await expect(pub.locator('meta[property="og:image"]')).toHaveAttribute('content',LIVE_PUBLIC_ORIGIN+publicA);
    const detail=await anonymous.newPage();
    await detail.goto('/shops/'+s.slug+'/products/'+s.product.sku);
    await expect(detail.getByRole('heading',{level:1})).toHaveText('手作茶杯');
    await expect(detail.locator('article img')).toHaveAttribute('src',publicA);
    await expect(detail.locator('meta[property="og:image"]')).toHaveAttribute('content',LIVE_PUBLIC_ORIGIN+publicA);
    await expect.poll(()=>detail.locator('article img').evaluate(el=>(el as HTMLImageElement).naturalWidth)).toBe(120);
    await detail.screenshot({path:info.outputPath(`synthetic-photo-product-${width}.png`),fullPage:true});
    await detail.close();
    const bytesA=await(await anonymous.request.get(publicA)).body();expect(bytesA.subarray(0,4).toString()).toBe('RIFF');expect(digest(await(await page.request.get(privateA!)).body())).toBe(digest(bytesA));
    await save(page,b,true);await preview.reload();await expect(preview.locator('article img')).toHaveAttribute('src',new RegExp('/photo/3$'));
    await pub.reload();expect(await media()).toEqual(first);expect(digest(await(await anonymous.request.get(publicA)).body())).toBe(digest(bytesA));
    await storeArea(page,'店面與發布');
    await page.getByRole('button',{name:'發布更新',exact:true}).click();await expect(page.locator('.hosted-store')).toContainText('已發布・第 2 版');
    const second=await media(),publicB=second.photos[0].photo.read_path;expect(second.revision).toBe('2');expect(publicB).not.toBe(publicA);
    expect(digest(await(await anonymous.request.get(publicB)).body())).not.toBe(digest(bytesA));expect((await anonymous.request.get(publicA)).status()).toBe(404);
    await pub.reload();await expect(pub.locator('article img')).toHaveAttribute('src',publicB);
    const immutable=(await e2eAuthPool.query('SELECT projection_sha256,media_sha256 FROM commerce_storefront_publications WHERE instance_id=$1 ORDER BY revision',[s.hash.split('/')[2]])).rows;expect(immutable).toHaveLength(2);expect(immutable[1].projection_sha256).toBe(immutable[0].projection_sha256);expect(immutable[1].media_sha256).not.toBe(immutable[0].media_sha256);
    for(const target of [page,preview,pub]){
      expect(await target.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await expect.poll(()=>(target===page?photo(page).locator(':scope > img'):target.locator('article img')).first().evaluate(el=>(el as HTMLImageElement).naturalWidth)).toBe(120);
    }
    await storeArea(page,'商品');
    const controls=await photo(page).getByRole('button').evaluateAll(nodes=>nodes.map(el=>({text:el.textContent,width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height})));
    for(const box of controls){expect(box.height).toBeGreaterThanOrEqual(44);expect(box.width).toBeLessThanOrEqual(width);}
    await info.attach('photo-control-geometry',{body:JSON.stringify({width,controls,interaction:'real Playwright click; viewport emulation, not physical touch'}),contentType:'application/json'});
    await page.screenshot({path:info.outputPath(`photo-member-${width}.png`),fullPage:true});await pub.screenshot({path:info.outputPath(`photo-public-${width}.png`),fullPage:true});
    page.once('dialog',dialog=>dialog.accept());await photo(page).getByRole('button',{name:'移除照片',exact:true}).click();
    await expect(photo(page).locator(':scope > img')).toHaveCount(0);expect((await media()).photos[0].photo.read_path).toBe(publicB);
    await storeArea(page,'店面與發布');
    await page.getByRole('button',{name:'發布更新',exact:true}).click();await expect(page.locator('.hosted-store')).toContainText('已發布・第 3 版');expect((await media()).photos).toEqual([]);
    await signOut(page);await loginHere(page,s.member.email);await open(page,s.hash);await expect(photo(page)).toContainText('尚未加入商品照片');
    const rows=await e2eAuthPool.query('SELECT product_id,asset_id FROM commerce_product_photo_targets WHERE product_id=$1',[s.product.product_id]);expect(rows.rows).toEqual([{product_id:s.product.product_id,asset_id:null}]);
    expect((await e2eAuthPool.query('SELECT count(*)::int n FROM commerce_publication_photo_refs WHERE instance_id=$1',[s.hash.split('/')[2]])).rows[0].n).toBe(2);
    const other=await person(e2eAuthPool),stranger=await browser.newContext({baseURL});try{const strangerPage=await stranger.newPage();await login(strangerPage,other.email);await open(strangerPage,s.hash);await expect(strangerPage.locator('.hosted-store')).toContainText('找不到這間商店');expect((await stranger.request.get(privateA!)).status()).toBe(404);}finally{await stranger.close();}
  }finally{await preview.close();await anonymous.close();}
});

test('committed HTTP loss survives actual 401 unmount, other member and same-member manual replay with policy OFF',async({page,e2eAuthPool},info)=>{
  const s=await ready(page,e2eAuthPool),file=await source('original-unknown.png','#793b52');const requests:ReturnType<typeof signature>[]=[],statuses:number[]=[],acks:unknown[]=[];
  await page.route('**'+s.path,async route=>{
    if(route.request().method()!=='POST')return route.continue();requests.push(signature(route.request()));
    const response=await route.fetch();statuses.push(response.status());if(response.ok())acks.push(await response.json());
    if(requests.length===1){expect(response.status()).toBe(200);await route.abort('failed');}else await route.fulfill({response});
  });
  await photo(page).getByLabel('商品照片',{exact:true}).setInputFiles(file);await photo(page).getByRole('button',{name:'儲存照片',exact:true}).click();
  const retry=photo(page).getByRole('button',{name:'重試原照片操作',exact:true});await expect(retry).toBeVisible();expect(statuses).toEqual([200]);
  await page.evaluate(()=>{location.hash='home';});await expect(page).toHaveURL(new RegExp('#'+s.hash+'$'));await expect(photo(page)).toContainText(file.name);
  const expired=await e2eAuthPool.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1 AND expires_at>now()",[s.member.id]);expect(expired.rowCount).toBe(1);
  await retry.click();await expect(page.getByRole('heading',{name:'登入',exact:true})).toBeVisible();await expect(photo(page)).toHaveCount(0);expect(statuses).toEqual([200,401]);
  await e2eAuthPool.query("UPDATE domain_media_storage_policy SET persistence_allowed=false WHERE purpose='storefront.product-photo'");
  const other=await person(e2eAuthPool);await loginHere(page,other.email);await open(page,s.hash);await expect(page.locator('.hosted-store')).toContainText('找不到這間商店');await expect(page.getByText(file.name,{exact:false})).toHaveCount(0);expect(requests).toHaveLength(2);
  await signOut(page);await loginHere(page,s.member.email);await open(page,s.hash);await expect(retry).toBeVisible();await expect(photo(page)).toContainText(file.name);
  // Current reads can reveal version 2, but they must not acknowledge or auto-resubmit the original unknown command.
  await expect(photo(page).locator(':scope > img')).toHaveAttribute('src',new RegExp('/photo/2$'));expect(requests).toHaveLength(2);
  await page.screenshot({path:info.outputPath('photo-unknown-after-relogin.png'),fullPage:true});await retry.click();await expect(photo(page).getByRole('status')).toContainText('已儲存照片變更');
  expect((await e2eAuthPool.query('SELECT count(*)::int n FROM sessions WHERE user_id=$1',[s.member.id])).rows[0].n).toBe(2);
  expect(statuses).toEqual([200,401,200]);expect(requests).toHaveLength(3);expect(requests[1]).toEqual(requests[0]);expect(requests[2]).toEqual(requests[0]);expect(requests[0].sha256).toBe(digest(file.buffer));
  const first=ProductMediaCommandSchema.parse(acks[0]),replay=ProductMediaCommandSchema.parse(acks[1]);expect(replay).toEqual(first);expect(replay.completed_version).toBe('2');
  const id=s.product.product_id,key=requests[0].key;
  expect((await e2eAuthPool.query("SELECT count(*)::int n FROM scoped_command_receipts WHERE target_id=$1 AND operation='storefront.product.photo.upload' AND idempotency_key=$2",[id,key])).rows[0].n).toBe(1);
  expect((await e2eAuthPool.query("SELECT count(*)::int n FROM scoped_transition_journal WHERE aggregate_id=$1 AND operation='storefront.product.photo.upload'",[id])).rows[0].n).toBe(1);
  expect((await e2eAuthPool.query("SELECT count(*)::int n FROM asset_upload_intents WHERE target_product_id=$1 AND state='finalized'",[id])).rows[0].n).toBe(1);
  expect((await e2eAuthPool.query('SELECT count(*)::int n FROM asset_object_write_effects e JOIN asset_upload_intents i USING(asset_id) WHERE i.target_product_id=$1',[id])).rows[0].n).toBe(1);
  // Evidence contains the public command tuple and byte digest, never session/CSRF tokens.
  await info.attach('photo-original-retry',{body:JSON.stringify({requests,statuses,completed_version:replay.completed_version,current_version:replay.current.version,receipt_count:1}),contentType:'application/json'});
});

test('photo CAS conflict keeps the file and creates a new key only after explicit member review',async({page,e2eAuthPool})=>{
  const s=await ready(page,e2eAuthPool),file=await source('cas-review.png','#297482'),requests:ReturnType<typeof signature>[]=[],statuses:number[]=[];
  await photo(page).getByLabel('商品照片',{exact:true}).setInputFiles(file);
  const session=await(await page.request.get('/api/v1/session')).json();const update=await page.request.patch('/api/v1'+s.root+'/products/'+s.product.product_id,{data:{title:'另一視窗改名',description:'',price_minor:35000,stock:2},headers:{Origin:new URL(page.url()).origin,'X-CSRF-Token':session.csrf_token,'Idempotency-Key':randomUUID(),'If-Match':'"1"'}});expect(update.status()).toBe(200);
  await page.route('**'+s.path,async route=>{if(route.request().method()!=='POST')return route.continue();requests.push(signature(route.request()));const response=await route.fetch();statuses.push(response.status());await route.fulfill({response});});
  await photo(page).getByRole('button',{name:'儲存照片',exact:true}).click();const review=photo(page).getByRole('button',{name:'確認以最新商品套用照片變更',exact:true});await expect(review).toBeVisible();await expect(page.locator('.hosted-store-product')).toContainText('另一視窗改名');await expect(photo(page)).toContainText(file.name);expect(statuses).toEqual([412]);expect(requests[0].version).toBe('"1"');
  await review.click();await expect(photo(page).getByRole('status')).toContainText('已儲存照片變更');expect(statuses).toEqual([412,200]);expect(requests[1]).toMatchObject({version:'"2"',sha256:requests[0].sha256,bytes:requests[0].bytes,mime:requests[0].mime});expect(requests[1].key).not.toBe(requests[0].key);
  expect((await e2eAuthPool.query("SELECT count(*)::int n FROM scoped_command_receipts WHERE target_id=$1 AND operation='storefront.product.photo.upload'",[s.product.product_id])).rows[0].n).toBe(1);
});

test('supply-only product photo through the console stays private (AT-11, S1 step 4)',async({page,browser,baseURL,e2eAuthPool},info)=>{
  const suffix=randomUUID().slice(0,6),member=await person(e2eAuthPool),title='合成純供貨照片 '+suffix;
  await login(page,member.email);const store=await launchStore(page,'合成純供貨照片空間 '+suffix);
  await post(page,store.root+'/supply-profile',{name:'合成私人照片商品庫 '+suffix,currency:'TWD'},201);
  const product=await post(page,store.root+'/supply-products',{title,description:'合成尚未公開供貨照片',cost_minor:400,stock:10},201);
  expect((await(await page.request.get('/api/v1'+store.root+'/supply-profile')).json()).retail_enabled).toBe(false);
  await page.evaluate(hash=>{location.hash=hash;},store.hash+'/supply/products/'+product.product_id);await expect(page.locator('.supplier-console')).toBeVisible();
  const file=await source('synthetic-supply-only-'+suffix+'.png','#486b74');await photo(page).getByLabel('商品照片',{exact:true}).setInputFiles(file);
  await expect(photo(page).getByRole('img',{name:'待儲存的完整商品照片',exact:true})).toBeVisible();
  await photo(page).getByRole('button',{name:'儲存照片',exact:true}).click();await expect(photo(page).getByRole('status')).toContainText('已儲存照片變更');
  const image=photo(page).locator(':scope > img');await expect(image).toBeVisible();const privatePath=await image.getAttribute('src');expect(privatePath).toContain(product.product_id+'/photo/2');
  await page.reload();await expect(image).toHaveAttribute('src',privatePath!);await expect.poll(()=>image.evaluate(el=>(el as HTMLImageElement).naturalWidth)).toBe(120);
  const anonymous=await browser.newContext({baseURL}),retail=await browser.newContext({baseURL});
  try{
    expect((await anonymous.request.get(privatePath!)).status()).toBe(401);
    const other=await person(e2eAuthPool),seller=await retail.newPage();await login(seller,other.email);const shop=await launchStore(seller,'合成照片零售空間 '+suffix);
    await post(seller,shop.root+'/setup',{name:'合成照片零售店 '+suffix,slug:'supply-photo-'+suffix,currency:'TWD'},201);
    const response=await seller.request.get('/api/v1'+shop.root+'/supply-catalog');expect(response.status()).toBe(200);const catalog=await response.json();
    expect(JSON.stringify(catalog)).not.toContain(product.product_id);expect(JSON.stringify(catalog)).not.toContain(title);expect(JSON.stringify(catalog)).not.toContain(privatePath!);
    expect((await(await page.request.get('/api/v1'+store.root+'/supply-offers')).json()).items).toEqual([]);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:info.outputPath('supply-only-private-photo.png'),fullPage:true});
  }finally{await anonymous.close();await retail.close();}
});

const materialConsole = (page: Page) => page.locator('.supplier-console');
const materialActive = (page: Page) => page.locator('.sc-content > [data-sc-active="true"]');
const sellerPartnerMaterials = (page: Page) => page.locator('.partner-materials');

async function setupMaterialSupplier(page: Page, db: Parameters<typeof person>[0], suffix: string) {
  const member = await person(db);
  await login(page, member.email);
  const store = await launchStore(page, `合成素材空間 ${suffix}`);
  await post(page, `${store.root}/supply-profile`, {name: `合成素材商品庫 ${suffix}`, currency: 'TWD'}, 201);
  return {member, store};
}

async function createFileMaterialInConsole(
  page: Page,
  store: {hash: string},
  kind: 'image' | 'video',
  title: string,
  productId = '',
) {
  await page.evaluate(hash => {
    location.hash = hash;
  }, `${store.hash}/supply/materials/new`);
  await expect(materialConsole(page)).toBeVisible({timeout: 15_000});
  await expect(materialActive(page).getByRole('heading', {level: 2, name: '新增素材', exact: true})).toBeVisible({
    timeout: 15_000,
  });
  const form = materialActive(page).getByRole('form', {name: '新增素材', exact: true});
  await form.getByLabel('種類').selectOption(kind);
  await form.getByLabel('素材對象').selectOption(productId);
  await form.getByLabel('標題').fill(title);
  await form.getByLabel('說明').fill(`合成${kind === 'image' ? '圖片' : '影片'}素材說明`);
  await form.getByRole('button', {name: '建立素材', exact: true}).click();
  await expect(
    materialActive(page).getByRole('heading', {level: 2, name: `素材詳情：${title}`, exact: true}),
  ).toBeVisible({timeout: 15_000});
  const match = new URL(page.url()).hash.match(/\/supply\/materials\/([0-9a-f-]{36})$/);
  expect(match).not.toBeNull();
  return match![1];
}

async function setupSupplierWithOfferForPartnerMedia(page: Page, db: Parameters<typeof person>[0], suffix: string) {
  const member = await person(db);
  await login(page, member.email);
  const store = await launchStore(page, `合作素材供應空間 ${suffix}`);
  const supplierName = `合作素材供應商 ${suffix}`;
  await post(page, `${store.root}/supply-profile`, {name: supplierName, currency: 'TWD'}, 201);
  const product = await post(
    page,
    `${store.root}/supply-products`,
    {
      title: `合作茶具 ${suffix}`,
      description: '附授權圖影素材的供貨商品',
      cost_minor: 450,
      stock: 15,
    },
    201,
  );
  const session = await (await page.request.get('/api/v1/session')).json();
  const termsResp = await page.request.patch(`/api/v1${store.root}/products/${product.product_id}/supply-terms`, {
    data: {
      cost_minor: 450,
      shipping_minor: 60,
      shipping_terms: '三日內宅配出貨',
      return_terms: '七日內瑕疵包退',
    },
    headers: {
      Origin: new URL(page.url()).origin,
      'X-CSRF-Token': session.csrf_token,
      'Idempotency-Key': randomUUID(),
      'If-Match': `"${product.version}"`,
    },
  });
  expect(termsResp.status()).toBe(200);
  const terms = await termsResp.json();
  const offer = await post(page, `${store.root}/products/${product.product_id}/supply-offer`, {}, 200, terms.version);
  return {member, store, supplierName, product, offer};
}

async function openPartnerStore(
  browser: {newContext: (opts: {baseURL?: string}) => Promise<{newPage: () => Promise<Page>; close: () => Promise<void>}>},
  baseURL: string | undefined,
  db: Parameters<typeof person>[0],
  label: string,
  slug: string,
) {
  const ctx = await browser.newContext({baseURL});
  const member = await person(db);
  const page = await ctx.newPage();
  await login(page, member.email);
  const store = await launchStore(page, `${label}空間`);
  await post(page, `${store.root}/setup`, {name: label, slug, currency: 'TWD'}, 201);
  return {ctx, member, page, store, name: label};
}

async function grantMaterialToAllSellableInConsole(page: Page) {
  const grantSection = materialActive(page)
    .locator('.sc-section')
    .filter({has: page.getByRole('heading', {level: 3, name: '店家授權', exact: true})});
  await grantSection.getByRole('button', {name: '授權給目前所有可售的合作店家（1 間）', exact: true}).click();
  await grantSection.getByRole('button', {name: '授權選取的店家', exact: true}).click();
  await expect(materialConsole(page).locator('.sc-announcement')).toHaveText('已保存：授權選取的店家。', {
    timeout: 15_000,
  });
}

async function withdrawPartnerOffers(db: Parameters<typeof person>[0], supplierUserIds: string[]) {
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

test('SC-E2E-66 image material upload, versions and the supplier\'s own read (AT-23)', async ({
  page,
  browser,
  baseURL,
  e2eAuthPool,
}) => {
  const suffix = randomUUID().slice(0, 6);
  const {store} = await setupMaterialSupplier(page, e2eAuthPool, suffix);
  const title = `品牌主視覺 ${suffix}`;
  const materialId = await createFileMaterialInConsole(page, store, 'image', title);

  const uploadSection = materialActive(page)
    .locator('.sc-section')
    .filter({has: page.getByRole('heading', {level: 3, name: '新版本', exact: true})});
  const contentSection = materialActive(page)
    .locator('.sc-section')
    .filter({has: page.getByRole('heading', {level: 3, name: '內容', exact: true})});
  const historySection = materialActive(page)
    .locator('.sc-section')
    .filter({has: page.getByRole('heading', {level: 3, name: '版本紀錄', exact: true})});

  // Device validation: wrong type or corrupt/oversize image refused on device with 0 requests sent
  const uploadPath = `/api/v1${store.root}/supply-materials/${materialId}/content`;
  const sentUploads: Request[] = [];
  page.on('request', req => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === uploadPath) {
      sentUploads.push(req);
    }
  });

  await uploadSection.getByLabel('選擇圖片').setInputFiles({
    name: 'wrong-format.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('plain text is not an image'),
  });
  await expect(uploadSection.locator('p.field-hint[role="status"]')).toHaveText('請選擇 JPEG、PNG 或 WebP 圖片。');
  expect(sentUploads).toHaveLength(0);

  await uploadSection.getByLabel('選擇圖片').setInputFiles({
    name: 'renamed-text-over-2mb.png',
    mimeType: 'image/png',
    buffer: Buffer.alloc(2 * 1024 * 1024 + 128, 0x41),
  });
  await expect(uploadSection.locator('p.field-hint[role="status"]')).toHaveText('圖片無法讀取，請選擇完整的靜態 JPEG、PNG 或 WebP 圖片。');
  expect(sentUploads).toHaveLength(0);

  await uploadSection.getByLabel('選擇圖片').setInputFiles({
    name: 'oversize-21mb.png',
    mimeType: 'image/png',
    buffer: Buffer.alloc(21 * 1024 * 1024),
  });
  await expect(uploadSection.locator('p.field-hint[role="status"]')).toHaveText('這張圖片超過 20 MB，請選擇較小的原始照片。');
  expect(sentUploads).toHaveLength(0);

  // Version 1 upload
  const file1 = await source(`brand-v1-${suffix}.png`, '#2b5f75');
  await uploadSection.getByLabel('選擇圖片').setInputFiles(file1);
  await expect(uploadSection).toContainText(`已選擇：${file1.name}・image/png・`);
  await expect(uploadSection.getByRole('img', {name: '待上傳圖片的裝置預覽', exact: true})).toBeVisible();

  const contentReadV1 = page.waitForResponse(
    res =>
      res.request().method() === 'GET' &&
      res.url().includes(`${store.root}/supply-materials/${materialId}/versions/`) &&
      res.url().endsWith('/content'),
  );
  await uploadSection.getByRole('button', {name: '上傳新版本', exact: true}).click();
  await expect(uploadSection.locator('p.field-hint[role="status"]')).toHaveText('已上傳新版本。');
  expect(sentUploads).toHaveLength(1);

  const imgV1Resp = await contentReadV1;
  expect(imgV1Resp.status()).toBe(200);
  expect(imgV1Resp.headers()['cache-control']).toBe('private, no-store');
  expect(imgV1Resp.headers()['content-type']).toBe('image/webp');

  const contentImg = contentSection.locator('img.sc-material-media');
  await expect(contentImg).toBeVisible();
  const srcV1 = await contentImg.getAttribute('src');
  expect(srcV1).toMatch(
    new RegExp(`^/api/v1${store.root}/supply-materials/${materialId}/versions/[0-9a-f-]{36}/content$`),
  );
  await expect.poll(() => contentImg.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

  const v1Row = historySection.locator('li.sc-row').filter({hasText: '第 1 版'});
  await expect(v1Row.locator('.badge')).toHaveText('目前版本');
  const openV1Link = v1Row.getByRole('link', {name: /開啟檔案/});
  await expect(openV1Link).toHaveAttribute('href', srcV1!);

  // Version 2 upload
  const file2 = await source(`brand-v2-${suffix}.png`, '#7a4b2a');
  await uploadSection.getByLabel('選擇圖片').setInputFiles(file2);
  await expect(uploadSection).toContainText(`已選擇：${file2.name}・image/png・`);
  await uploadSection.getByRole('button', {name: '上傳新版本', exact: true}).click();
  await expect(uploadSection.locator('p.field-hint[role="status"]')).toHaveText('已上傳新版本。');
  expect(sentUploads).toHaveLength(2);

  const v2Row = historySection.locator('li.sc-row').filter({hasText: '第 2 版'});
  await expect(v2Row.locator('.badge')).toHaveText('目前版本');
  await expect(v1Row.locator('.badge')).toHaveCount(0);
  const srcV2 = await contentImg.getAttribute('src');
  expect(srcV2).not.toBe(srcV1);
  await expect.poll(() => contentImg.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

  // First version still opens for the supplier
  await expect(openV1Link).toHaveAttribute('href', srcV1!);
  const supplierV1Check = await page.request.get(srcV1!);
  expect(supplierV1Check.status()).toBe(200);
  expect(supplierV1Check.headers()['cache-control']).toBe('private, no-store');
  expect(supplierV1Check.headers()['content-type']).toBe('image/webp');
  expect((await supplierV1Check.body()).length).toBeGreaterThan(0);

  // Anonymous browser context gets no image bytes
  const anonymous = await browser.newContext({baseURL});
  try {
    for (const url of [srcV1!, srcV2!]) {
      const anonResp = await anonymous.request.get(url);
      expect(anonResp.status()).toBe(401);
      expect(anonResp.headers()['content-type']).not.toContain('image/');
      const anonBody = await anonResp.text();
      expect(anonBody).toContain('login_required');
    }
  } finally {
    await anonymous.close();
  }
});

test('SC-E2E-67 video material upload plays from the supplier read (AT-23, D-14)', async ({
  page,
  e2eAuthPool,
}) => {
  const {readFile} = await import('node:fs/promises');
  const suffix = randomUUID().slice(0, 6);
  const {store} = await setupMaterialSupplier(page, e2eAuthPool, suffix);
  const title = `開箱短片 ${suffix}`;
  const materialId = await createFileMaterialInConsole(page, store, 'video', title);

  const uploadSection = materialActive(page)
    .locator('.sc-section')
    .filter({has: page.getByRole('heading', {level: 3, name: '新版本', exact: true})});
  const contentSection = materialActive(page)
    .locator('.sc-section')
    .filter({has: page.getByRole('heading', {level: 3, name: '內容', exact: true})});
  const historySection = materialActive(page)
    .locator('.sc-section')
    .filter({has: page.getByRole('heading', {level: 3, name: '版本紀錄', exact: true})});

  const uploadPath = `/api/v1${store.root}/supply-materials/${materialId}/content`;
  const sentUploads: Request[] = [];
  page.on('request', req => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === uploadPath) {
      sentUploads.push(req);
    }
  });

  // Device refusal for 21 MB video buffer with D-14 message and 0 requests
  await uploadSection.getByLabel('選擇影片').setInputFiles({
    name: 'oversize-21mb.mp4',
    mimeType: 'video/mp4',
    buffer: Buffer.alloc(21 * 1024 * 1024),
  });
  await expect(uploadSection.locator('p.field-hint[role="status"]')).toHaveText(
    '影片需為 MP4 或 WebM，最多 20 MB。請先壓縮（建議 H.264／AAC、720p、60 秒內）再上傳。',
  );
  expect(sentUploads).toHaveLength(0);

  // Real MP4 upload
  const videoBytes = await readFile('tests/media-fixtures/event-video-160x90.mp4');
  const contentResponses: Array<{status: number; headers: Record<string, string>}> = [];
  page.on('response', res => {
    if (
      res.request().method() === 'GET' &&
      res.url().includes(`${store.root}/supply-materials/${materialId}/versions/`) &&
      res.url().endsWith('/content')
    ) {
      contentResponses.push({status: res.status(), headers: res.headers()});
    }
  });

  await uploadSection.getByLabel('選擇影片').setInputFiles({
    name: 'event-video-160x90.mp4',
    mimeType: 'video/mp4',
    buffer: videoBytes,
  });
  await expect(uploadSection).toContainText('已選擇：event-video-160x90.mp4・video/mp4・');
  await uploadSection.getByRole('button', {name: '上傳新版本', exact: true}).click();
  await expect(uploadSection.locator('p.field-hint[role="status"]')).toHaveText('已上傳新版本。');
  expect(sentUploads).toHaveLength(1);

  const videoEl = contentSection.locator('video.sc-material-media');
  await expect(videoEl).toBeVisible();
  const videoSrc = await videoEl.getAttribute('src');
  expect(videoSrc).toMatch(
    new RegExp(`^/api/v1${store.root}/supply-materials/${materialId}/versions/[0-9a-f-]{36}/content$`),
  );

  await expect.poll(() => videoEl.evaluate(el => (el as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1);

  const partialResponses = contentResponses.filter(r => r.status === 206);
  expect(partialResponses.length).toBeGreaterThanOrEqual(1);
  expect(partialResponses[0].headers['cache-control']).toBe('private, no-store');
  expect(partialResponses[0].headers['content-type']).toBe('video/mp4');
  expect(partialResponses[0].headers['content-range']).toMatch(new RegExp(`^bytes \\d+-\\d+/${videoBytes.length}$`));

  // Also verify full GET content-length and byte identity (no transcoding)
  const fullGet = await page.request.get(videoSrc!);
  expect(fullGet.status()).toBe(200);
  expect(Number(fullGet.headers()['content-length'])).toBe(videoBytes.length);
  expect(Buffer.from(await fullGet.body()).equals(videoBytes)).toBe(true);

  const expectedSizeText = `${(videoBytes.length / 1048576).toFixed(1)} MB`;
  const v1Row = historySection.locator('li.sc-row').filter({hasText: '第 1 版'});
  await expect(v1Row.locator('.badge')).toHaveText('目前版本');
  await expect(v1Row).toContainText(`video/mp4・${expectedSizeText}`);
});

test('SC-E2E-68 upload with an unknown result is retried as the same operation (AT-24)', async ({
  page,
  e2eAuthPool,
}) => {
  const suffix = randomUUID().slice(0, 6);
  const {member, store} = await setupMaterialSupplier(page, e2eAuthPool, suffix);
  const title = `未知上傳素材 ${suffix}`;
  const materialId = await createFileMaterialInConsole(page, store, 'image', title);

  const uploadSection = materialActive(page)
    .locator('.sc-section')
    .filter({has: page.getByRole('heading', {level: 3, name: '新版本', exact: true})});

  const file = await source(`unknown-upload-${suffix}.png`, '#446879');
  const uploadPath = `/api/v1${store.root}/supply-materials/${materialId}/content`;
  const requests: ReturnType<typeof signature>[] = [];
  const statuses: number[] = [];

  await page.route(`**${uploadPath}`, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    requests.push(signature(route.request()));
    const response = await route.fetch();
    statuses.push(response.status());
    if (requests.length === 1) {
      expect(response.status()).toBe(200);
      await route.abort('failed');
    } else {
      await route.fulfill({response});
    }
  });

  await uploadSection.getByLabel('選擇圖片').setInputFiles(file);
  await uploadSection.getByRole('button', {name: '上傳新版本', exact: true}).click();

  const unknownText = '尚未確認上傳結果。檔案仍保留，請按重試原操作確認後再離開。';
  const retryBtn = uploadSection.getByRole('button', {name: '重試原操作', exact: true});
  await expect(retryBtn).toBeVisible();
  await expect(uploadSection.locator('p.field-hint[role="status"]')).toHaveText(unknownText);
  await expect(materialConsole(page)).toContainText(unknownText);
  expect(statuses).toEqual([200]);

  // Leave guard blocks leaving while outcome is unknown
  const detailHash = `${store.hash}/supply/materials/${materialId}`;
  await page.evaluate(() => {
    location.hash = 'home';
  });
  await expect(page).toHaveURL(new RegExp(`#${detailHash}$`));
  await expect(materialConsole(page).locator('.sc-announcement')).toHaveText(
    '尚未確認原操作的結果，請按「重試」確認後再離開。',
  );

  // Expire session so retry hits 401 and unmounts console, then sign back in and restore held upload
  const expired = await e2eAuthPool.query(
    "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1 AND expires_at>now()",
    [member.id],
  );
  expect(expired.rowCount).toBe(1);
  await retryBtn.click();
  await expect(page.getByRole('heading', {name: '登入', exact: true})).toBeVisible();
  expect(statuses).toEqual([200, 401]);

  await loginHere(page, member.email);
  await page.evaluate(hash => {
    location.hash = hash;
  }, detailHash);
  await expect(materialConsole(page)).toBeVisible();
  await expect(retryBtn).toBeVisible();
  await expect(uploadSection.locator('p.field-hint[role="status"]')).toHaveText(unknownText);
  await expect(uploadSection).toContainText(file.name);
  expect(requests).toHaveLength(2);

  await retryBtn.click();
  await expect(uploadSection.locator('p.field-hint[role="status"]')).toHaveText('已上傳新版本。');

  expect(statuses).toEqual([200, 401, 200]);
  expect(requests).toHaveLength(3);
  expect(requests[0].key).toBeTruthy();
  expect(requests[0].version).toBe('"1"');
  expect(requests[0].sha256).toBe(digest(file.buffer));
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[2]).toEqual(requests[0]);

  const key = requests[0].key;
  expect(
    (
      await e2eAuthPool.query<{n: number}>(
        'SELECT count(*)::int AS n FROM supply_material_versions WHERE material_id=$1',
        [materialId],
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    (
      await e2eAuthPool.query<{n: number}>(
        "SELECT count(*)::int AS n FROM scoped_command_receipts WHERE target_id=$1 AND operation='storefront.supply-material.upload' AND idempotency_key=$2",
        [materialId, key],
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    (
      await e2eAuthPool.query<{n: number}>(
        "SELECT count(*)::int AS n FROM scoped_transition_journal WHERE aggregate_id=$1 AND operation='storefront.supply-material.upload'",
        [materialId],
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    (
      await e2eAuthPool.query<{n: number}>(
        "SELECT count(*)::int AS n FROM asset_upload_intents WHERE target_material_id=$1 AND state='finalized'",
        [materialId],
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    (
      await e2eAuthPool.query<{n: number}>(
        `SELECT count(*)::int AS n
         FROM assets a
         JOIN asset_upload_intents i USING(asset_id)
         WHERE i.target_material_id=$1 AND a.state='ready'
           AND NOT EXISTS (SELECT 1 FROM supply_material_versions v WHERE v.asset_id=a.asset_id)`,
        [materialId],
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (
      await e2eAuthPool.query<{n: number}>(
        'SELECT count(*)::int AS n FROM asset_object_write_effects e JOIN asset_upload_intents i USING(asset_id) WHERE i.target_material_id=$1',
        [materialId],
      )
    ).rows[0].n,
  ).toBe(1);
});

test('SC-E2E-69 the granted seller sees and downloads the current image and video (AT-25)', async ({
  page,
  browser,
  baseURL,
  e2eAuthPool,
}) => {
  const {readFile} = await import('node:fs/promises');
  const suffix = randomUUID().slice(0, 6);
  const extraContexts: Array<{close: () => Promise<void>}> = [];
  const supplierIds: string[] = [];

  try {
    const sup = await setupSupplierWithOfferForPartnerMedia(page, e2eAuthPool, suffix);
    supplierIds.push(sup.member.id);

    const sellerB = await openPartnerStore(browser, baseURL, e2eAuthPool, `授權賣家 B ${suffix}`, `partner-media-b-${suffix}`);
    extraContexts.push(sellerB.ctx);
    const propB = await post(
      sellerB.page,
      `${sellerB.store.root}/distribution-selections`,
      {offer_id: sup.offer.offer_id, terms_sha256: sup.offer.terms_sha256, retail_price_minor: 1200},
      201,
    );
    await post(
      page,
      `${sup.store.root}/supply-requests/${propB.selection_id}/decision`,
      {decision: 'accepted', listing_sha256: propB.listing_sha256},
      200,
      propB.version,
    );

    const sellerC = await openPartnerStore(browser, baseURL, e2eAuthPool, `無合作賣家 C ${suffix}`, `partner-media-c-${suffix}`);
    extraContexts.push(sellerC.ctx);

    // 1. Image material (brand) with one uploaded version + grant B
    const imgTitle = `品牌形象圖 ${suffix}`;
    const imgMaterialId = await createFileMaterialInConsole(page, sup.store, 'image', imgTitle, '');
    const imgUploadSection = materialActive(page)
      .locator('.sc-section')
      .filter({has: page.getByRole('heading', {level: 3, name: '新版本', exact: true})});
    const imgFile = await source(`partner-brand-${suffix}.png`, '#2e6b5e');
    await imgUploadSection.getByLabel('選擇圖片').setInputFiles(imgFile);
    await imgUploadSection.getByRole('button', {name: '上傳新版本', exact: true}).click();
    await expect(imgUploadSection.locator('p.field-hint[role="status"]')).toHaveText('已上傳新版本。');
    await grantMaterialToAllSellableInConsole(page);

    // 2. Video material (for the product) with event-video-160x90.mp4 + grant B
    const vidTitle = `商品展示短片 ${suffix}`;
    const vidMaterialId = await createFileMaterialInConsole(page, sup.store, 'video', vidTitle, sup.product.product_id);
    const vidUploadSection = materialActive(page)
      .locator('.sc-section')
      .filter({has: page.getByRole('heading', {level: 3, name: '新版本', exact: true})});
    const videoBytes = await readFile('tests/media-fixtures/event-video-160x90.mp4');
    await vidUploadSection.getByLabel('選擇影片').setInputFiles({
      name: 'event-video-160x90.mp4',
      mimeType: 'video/mp4',
      buffer: videoBytes,
    });
    await vidUploadSection.getByRole('button', {name: '上傳新版本', exact: true}).click();
    await expect(vidUploadSection.locator('p.field-hint[role="status"]')).toHaveText('已上傳新版本。');
    await grantMaterialToAllSellableInConsole(page);

    const versionRows = (
      await e2eAuthPool.query<{material_id: string; current_version_id: string}>(
        'SELECT material_id, current_version_id FROM supply_materials WHERE material_id = ANY($1::uuid[])',
        [[imgMaterialId, vidMaterialId]],
      )
    ).rows;
    const imgVersionId = versionRows.find(r => r.material_id === imgMaterialId)!.current_version_id;
    const vidVersionId = versionRows.find(r => r.material_id === vidMaterialId)!.current_version_id;
    const expectedImgPath = `/api/v1${sellerB.store.root}/partner-materials/${imgMaterialId}/versions/${imgVersionId}/content`;
    const expectedVidPath = `/api/v1${sellerB.store.root}/partner-materials/${vidMaterialId}/versions/${vidVersionId}/content`;

    // Track partner media responses in seller B's browser page
    const bMediaResponses: Array<{url: string; status: number; headers: Record<string, string>}> = [];
    sellerB.page.on('response', res => {
      if (res.request().method() === 'GET' && res.url().includes('/partner-materials/')) {
        bMediaResponses.push({url: new URL(res.url()).pathname, status: res.status(), headers: res.headers()});
      }
    });

    await open(sellerB.page, sellerB.store.hash);
    await storeArea(sellerB.page, '供貨合作');
    const panelB = sellerPartnerMaterials(sellerB.page);
    await expect(panelB.getByRole('heading', {level: 3, name: '合作素材', exact: true})).toBeVisible();

    const imgCard = panelB.locator('article.card').filter({hasText: imgTitle});
    const vidCard = panelB.locator('article.card').filter({hasText: vidTitle});
    await expect(imgCard).toBeVisible();
    await expect(vidCard).toBeVisible();

    const imgEl = imgCard.locator('img');
    await imgEl.scrollIntoViewIfNeeded();
    await expect(imgEl).toHaveAttribute('src', expectedImgPath);
    await expect.poll(() => imgEl.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

    const imgDirectResp = await sellerB.page.request.get(expectedImgPath);
    expect(imgDirectResp.status()).toBe(200);
    expect(imgDirectResp.headers()['cache-control']).toContain('no-store');
    expect(imgDirectResp.headers()['content-type']).toBe('image/webp');
    const imgBrowserResp = bMediaResponses.find(r => r.url === expectedImgPath);
    expect(imgBrowserResp).toBeTruthy();
    expect(imgBrowserResp!.status).toBe(200);
    expect(imgBrowserResp!.headers['cache-control']).toContain('no-store');
    expect(imgBrowserResp!.headers['content-type']).toBe('image/webp');

    const vidEl = vidCard.locator('video');
    await vidEl.scrollIntoViewIfNeeded();
    await expect(vidEl).toHaveAttribute('src', expectedVidPath);
    await expect.poll(() => vidEl.evaluate(el => (el as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1);
    const vidPartialResps = bMediaResponses.filter(r => r.url === expectedVidPath && r.status === 206);
    expect(vidPartialResps.length).toBeGreaterThanOrEqual(1);
    expect(vidPartialResps[0].headers['cache-control']).toContain('no-store');
    expect(vidPartialResps[0].headers['content-type']).toBe('video/mp4');
    expect(vidPartialResps[0].headers['content-range']).toMatch(new RegExp(`^bytes \\d+-\\d+/${videoBytes.length}$`));

    const imgDownloadLink = imgCard.getByRole('link', {name: '下載', exact: true});
    await expect(imgDownloadLink).toHaveAttribute('download', '');
    await expect(imgDownloadLink).toHaveAttribute('href', expectedImgPath);

    const vidDownloadLink = vidCard.getByRole('link', {name: '下載', exact: true});
    await expect(vidDownloadLink).toHaveAttribute('download', '');
    await expect(vidDownloadLink).toHaveAttribute('href', expectedVidPath);

    // Seller C (signed in, no cooperation) gets 404 on B's paths and on C's own tenant/instance paths
    for (const targetPath of [
      expectedImgPath,
      expectedVidPath,
      `/api/v1${sellerC.store.root}/partner-materials/${imgMaterialId}/versions/${imgVersionId}/content`,
      `/api/v1${sellerC.store.root}/partner-materials/${vidMaterialId}/versions/${vidVersionId}/content`,
    ]) {
      const cResp = await sellerC.page.request.get(targetPath);
      expect(cResp.status()).toBe(404);
      expect(cResp.headers()['content-type']).not.toContain('image/');
      expect(cResp.headers()['content-type']).not.toContain('video/');
    }

    // Anonymous context gets 401 and no media bytes
    const anonCtx = await browser.newContext({baseURL});
    extraContexts.push(anonCtx);
    for (const targetPath of [expectedImgPath, expectedVidPath]) {
      const anonResp = await anonCtx.request.get(targetPath);
      expect(anonResp.status()).toBe(401);
      expect(anonResp.headers()['content-type']).not.toContain('image/');
      expect(anonResp.headers()['content-type']).not.toContain('video/');
      expect(await anonResp.text()).toContain('login_required');
    }
  } finally {
    await withdrawPartnerOffers(e2eAuthPool, supplierIds);
    await Promise.all(extraContexts.map(c => c.close()));
  }
});

test('SC-E2E-70 a new version, a revoke and a withdrawal close the old paths (AT-26)', async ({
  page,
  browser,
  baseURL,
  e2eAuthPool,
}) => {
  const suffix = randomUUID().slice(0, 6);
  const extraContexts: Array<{close: () => Promise<void>}> = [];
  const supplierIds: string[] = [];

  try {
    const sup = await setupSupplierWithOfferForPartnerMedia(page, e2eAuthPool, suffix);
    supplierIds.push(sup.member.id);

    const sellerB = await openPartnerStore(browser, baseURL, e2eAuthPool, `版本切換賣家 B ${suffix}`, `partner-ver-b-${suffix}`);
    extraContexts.push(sellerB.ctx);
    const propB = await post(
      sellerB.page,
      `${sellerB.store.root}/distribution-selections`,
      {offer_id: sup.offer.offer_id, terms_sha256: sup.offer.terms_sha256, retail_price_minor: 1200},
      201,
    );
    await post(
      page,
      `${sup.store.root}/supply-requests/${propB.selection_id}/decision`,
      {decision: 'accepted', listing_sha256: propB.listing_sha256},
      200,
      propB.version,
    );

    // Create image material (brand), upload version 1, and grant to B
    const title = `季節海報 ${suffix}`;
    const materialId = await createFileMaterialInConsole(page, sup.store, 'image', title, '');
    const uploadSection = materialActive(page)
      .locator('.sc-section')
      .filter({has: page.getByRole('heading', {level: 3, name: '新版本', exact: true})});
    const historySection = materialActive(page)
      .locator('.sc-section')
      .filter({has: page.getByRole('heading', {level: 3, name: '版本紀錄', exact: true})});
    const grantSection = materialActive(page)
      .locator('.sc-section')
      .filter({has: page.getByRole('heading', {level: 3, name: '店家授權', exact: true})});

    const fileV1 = await source(`poster-v1-${suffix}.png`, '#365b77');
    await uploadSection.getByLabel('選擇圖片').setInputFiles(fileV1);
    await uploadSection.getByRole('button', {name: '上傳新版本', exact: true}).click();
    await expect(uploadSection.locator('p.field-hint[role="status"]')).toHaveText('已上傳新版本。');
    await grantMaterialToAllSellableInConsole(page);

    // B opens 供貨合作 → 合作素材 and loads version 1
    await open(sellerB.page, sellerB.store.hash);
    await storeArea(sellerB.page, '供貨合作');
    const panelB = sellerPartnerMaterials(sellerB.page);
    const cardB = panelB.locator('article.card').filter({hasText: title});
    await expect(cardB).toBeVisible();
    const imgB = cardB.locator('img');
    await imgB.scrollIntoViewIfNeeded();
    await expect.poll(() => imgB.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    const pathV1 = (await imgB.getAttribute('src'))!;
    expect(pathV1).toMatch(
      new RegExp(`^/api/v1${sellerB.store.root}/partner-materials/${materialId}/versions/[0-9a-f-]{36}/content$`),
    );

    // Supplier uploads version 2 in the console
    const fileV2 = await source(`poster-v2-${suffix}.png`, '#8a4f2d');
    await uploadSection.getByLabel('選擇圖片').setInputFiles(fileV2);
    await uploadSection.getByRole('button', {name: '上傳新版本', exact: true}).click();
    await expect(uploadSection.locator('p.field-hint[role="status"]')).toHaveText('已上傳新版本。');

    // B presses 重新整理: <img> uses version-2 path and loads; version-1 path returns 404 for B
    await panelB.getByRole('button', {name: '重新整理', exact: true}).click();
    await expect(imgB).not.toHaveAttribute('src', pathV1);
    const pathV2 = (await imgB.getAttribute('src'))!;
    expect(pathV2).toMatch(
      new RegExp(`^/api/v1${sellerB.store.root}/partner-materials/${materialId}/versions/[0-9a-f-]{36}/content$`),
    );
    await imgB.scrollIntoViewIfNeeded();
    await expect.poll(() => imgB.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect((await sellerB.page.request.get(pathV1)).status()).toBe(404);

    // Supplier 撤銷 B (dialog) → B presses 重新整理: material gone from panel; version-2 path returns 404
    const grantRowB = grantSection.locator('ul.sc-list li.sc-row').filter({hasText: sellerB.name});
    await grantRowB.getByRole('button', {name: '撤銷', exact: true}).click();
    const revokeDialog = page.getByRole('dialog', {name: '撤銷店家授權', exact: true});
    await expect(revokeDialog).toBeVisible();
    await revokeDialog.getByRole('button', {name: '確認撤銷', exact: true}).click();
    await expect(materialConsole(page).locator('.sc-announcement')).toHaveText('已保存：撤銷授權。');

    await panelB.getByRole('button', {name: '重新整理', exact: true}).click();
    await expect(panelB).toContainText('目前沒有供應商授權給這間店的素材。');
    await expect(panelB).not.toContainText(title);
    expect((await sellerB.page.request.get(pathV2)).status()).toBe(404);

    // Grant B again, then 撤回素材 (dialog): after 重新整理 material is gone and path returns 404 again
    await grantMaterialToAllSellableInConsole(page);
    await panelB.getByRole('button', {name: '重新整理', exact: true}).click();
    await expect(panelB.locator('article.card').filter({hasText: title})).toBeVisible();
    // The re-grant opens the current path again, so the 404 after the withdrawal comes from the withdrawal.
    expect((await sellerB.page.request.get(pathV2)).status()).toBe(200);

    const withdrawSection = materialActive(page)
      .locator('.sc-section')
      .filter({has: page.getByRole('heading', {level: 3, name: '撤回素材', exact: true})});
    await withdrawSection.getByRole('button', {name: '撤回素材', exact: true}).click();
    const withdrawDialog = page.getByRole('dialog', {name: '永久撤回這個素材', exact: true});
    await expect(withdrawDialog).toBeVisible();
    await withdrawDialog.getByRole('button', {name: '確認撤回素材', exact: true}).click();
    await expect(materialConsole(page).locator('.sc-announcement')).toHaveText('已保存：撤回素材。');

    await panelB.getByRole('button', {name: '重新整理', exact: true}).click();
    await expect(panelB).toContainText('目前沒有供應商授權給這間店的素材。');
    await expect(panelB).not.toContainText(title);
    expect((await sellerB.page.request.get(pathV2)).status()).toBe(404);
    expect((await sellerB.page.request.get(pathV1)).status()).toBe(404);

    // Supplier can still open version 1 and version 2 from 版本紀錄 after withdrawal
    await expect(materialActive(page).locator('.detail-list')).toContainText('已撤回');
    const v1Row = historySection.locator('li.sc-row').filter({hasText: '第 1 版'});
    const v2Row = historySection.locator('li.sc-row').filter({hasText: '第 2 版'});
    const supplierHrefV1 = await v1Row.getByRole('link', {name: /開啟檔案/}).getAttribute('href');
    const supplierHrefV2 = await v2Row.getByRole('link', {name: /開啟檔案/}).getAttribute('href');
    expect(supplierHrefV1).toBeTruthy();
    expect(supplierHrefV2).toBeTruthy();
    expect(supplierHrefV1).not.toBe(supplierHrefV2);

    for (const href of [supplierHrefV1!, supplierHrefV2!]) {
      const supResp = await page.request.get(href);
      expect(supResp.status()).toBe(200);
      expect(supResp.headers()['cache-control']).toBe('private, no-store');
      expect(supResp.headers()['content-type']).toBe('image/webp');
      expect((await supResp.body()).length).toBeGreaterThan(0);
    }
  } finally {
    await withdrawPartnerOffers(e2eAuthPool, supplierIds);
    await Promise.all(extraContexts.map(c => c.close()));
  }
});

async function setMaterialAccessInConsole(page: Page, access: 'partners' | 'public_use') {
  const accessSection = materialActive(page)
    .locator('.sc-section')
    .filter({has: page.getByRole('heading', {level: 3, name: '授權範圍', exact: true})});
  await accessSection.getByLabel('使用範圍').selectOption(access);
  if (access === 'public_use') {
    const accessDialog = page.getByRole('dialog', {name: '可用於合作店家的公開店面', exact: true});
    await expect(accessDialog).toBeVisible();
    await accessDialog.getByRole('button', {name: '確認開放', exact: true}).click();
  }
  await expect(materialConsole(page).locator('.sc-announcement')).toHaveText('已保存：變更素材授權範圍。');
}

async function uploadImageVersionInConsole(page: Page, filename: string, color: string) {
  const uploadSection = materialActive(page)
    .locator('.sc-section')
    .filter({has: page.getByRole('heading', {level: 3, name: '新版本', exact: true})});
  const file = await source(filename, color);
  await uploadSection.getByLabel('選擇圖片').setInputFiles(file);
  await uploadSection.getByRole('button', {name: '上傳新版本', exact: true}).click();
  await expect(uploadSection.locator('p.field-hint[role="status"]')).toHaveText('已上傳新版本。');
}

test('SC-E2E-72 a partner image becomes the seller\'s storefront photo only after use and publish (AT-27)', async ({
  page,
  browser,
  baseURL,
  playwright,
  e2eAuthPool,
}) => {
  const suffix = randomUUID().slice(0, 6);
  const extraContexts: Array<{close: () => Promise<void>}> = [];
  const supplierIds: string[] = [];

  try {
    const sup = await setupSupplierWithOfferForPartnerMedia(page, e2eAuthPool, suffix);
    supplierIds.push(sup.member.id);

    const sellerBSlug = `partner-photo-b-${suffix}`;
    const sellerB = await openPartnerStore(browser, baseURL, e2eAuthPool, `店面照片賣家 B ${suffix}`, sellerBSlug);
    extraContexts.push(sellerB.ctx);
    const propB = await post(
      sellerB.page,
      `${sellerB.store.root}/distribution-selections`,
      {offer_id: sup.offer.offer_id, terms_sha256: sup.offer.terms_sha256, retail_price_minor: 1200},
      201,
    );
    await post(
      page,
      `${sup.store.root}/supply-requests/${propB.selection_id}/decision`,
      {decision: 'accepted', listing_sha256: propB.listing_sha256},
      200,
      propB.version,
    );

    const productTitle = sup.offer.terms.title;
    const matTitle = `商品主圖 ${suffix}`;
    const materialId = await createFileMaterialInConsole(page, sup.store, 'image', matTitle, sup.product.product_id);
    await uploadImageVersionInConsole(page, `dist-photo-v1-${suffix}.png`, '#2e6b9e');
    await setMaterialAccessInConsole(page, 'public_use');
    await grantMaterialToAllSellableInConsole(page);

    // Seller B publishes the store once before using the image and records the public media JSON
    await open(sellerB.page, sellerB.store.hash);
    await storeArea(sellerB.page, '店面與發布');
    await expect(sellerB.page.getByRole('button', {name: '發布展示頁', exact: true})).toBeEnabled();
    await sellerB.page.getByRole('button', {name: '發布展示頁', exact: true}).click();
    await expect(sellerB.page.locator('.hosted-store > [role="status"]')).toContainText('已發布・第 1 版');

    const mediaBeforeResp = await sellerB.page.request.get(`/api/v1/public/stores/${sellerBSlug}/media`);
    expect(mediaBeforeResp.status()).toBe(200);
    const mediaBefore = PublicStoreMediaSchema.parse(await mediaBeforeResp.json());
    expect(mediaBefore.photos).toEqual([]);

    // B opens 供貨合作 → 合作素材
    let useRequests = 0;
    sellerB.page.on('request', req => {
      if (req.method() === 'POST' && req.url().includes('/distribution-photos/') && req.url().endsWith('/use')) {
        useRequests += 1;
      }
    });

    await storeArea(sellerB.page, '供貨合作');
    const panelB = sellerPartnerMaterials(sellerB.page);
    const cardB = panelB.locator('article.card').filter({hasText: matTitle});
    await expect(cardB).toBeVisible();
    const distBlock = cardB.locator('div.stack > div.stack').filter({hasText: productTitle});
    await expect(distBlock.locator('strong')).toHaveText(productTitle);
    const useBtn = distBlock.getByRole('button', {name: '用於公開店面', exact: true});
    await expect(useBtn).toBeVisible();

    // Open dialog, verify heading, 第 1 版, product title, focus on 取消; 取消 closes and returns focus without /use request
    await useBtn.click();
    const useDialog = sellerB.page.getByRole('dialog', {name: '把這張素材用在公開店面？', exact: true});
    await expect(useDialog).toBeVisible();
    await expect(useDialog.getByRole('heading', {level: 3, name: '把這張素材用在公開店面？', exact: true})).toBeVisible();
    await expect(useDialog).toContainText('第 1 版');
    await expect(useDialog).toContainText(`「${productTitle}」`);
    const cancelBtn = useDialog.getByRole('button', {name: '取消', exact: true});
    await expect(cancelBtn).toBeFocused();
    await cancelBtn.click();
    await expect(useDialog).toBeHidden();
    await expect(useBtn).toBeFocused();
    expect(useRequests).toBe(0);

    // Open again → 複製並使用
    await useBtn.click();
    await expect(useDialog).toBeVisible();
    await useDialog.getByRole('button', {name: '複製並使用', exact: true}).click();
    await expect(sellerB.page.locator('.hosted-store > [role="status"]')).toContainText(
      '已更新店面草稿，發布店面後才會生效。',
    );
    expect(useRequests).toBe(1);

    await expect(distBlock.locator('.badge')).toHaveText('店面使用中（第 1 版）');
    await expect(distBlock.getByRole('button', {name: '停止使用', exact: true})).toBeVisible();
    const expectedPrivateV1 = `/api/v1${sellerB.store.root}/distribution-photos/${sup.product.product_id}/photo/1`;
    const thumbV1 = distBlock.locator('img.distribution-photo-thumb');
    await expect(thumbV1).toHaveAttribute('alt', `${productTitle}的店面草稿照片`);
    await expect(thumbV1).toHaveAttribute('src', expectedPrivateV1);
    await thumbV1.scrollIntoViewIfNeeded();
    await expect.poll(() => thumbV1.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

    const privateV1Resp = await sellerB.page.request.get(expectedPrivateV1);
    expect(privateV1Resp.status()).toBe(200);
    expect(privateV1Resp.headers()['content-type']).toBe('image/webp');
    expect(privateV1Resp.headers()['cache-control']).toContain('no-store');
    const privateV1Bytes = await privateV1Resp.body();
    expect(privateV1Bytes.length).toBeGreaterThan(0);

    // Anonymous gets 401; supplier's signed-in page.request gets 404 refusal with no image bytes
    const anonApi = await playwright.request.newContext({baseURL, storageState: {cookies: [], origins: []}});
    try {
      const anonPrivateResp = await anonApi.get(expectedPrivateV1);
      expect(anonPrivateResp.status()).toBe(401);
      expect(anonPrivateResp.headers()['cache-control']).toContain('no-store');

      const supPrivateResp = await page.request.get(expectedPrivateV1);
      expect(supPrivateResp.status()).toBe(404);
      expect(supPrivateResp.headers()['content-type']).not.toContain('image/');
      expect(supPrivateResp.headers()['cache-control']).toContain('no-store');
    } finally {
      await anonApi.dispose();
    }

    // Database check: one copy row for B and the product whose source is material v1 and asset belongs to B's tenant
    const [sellerTenantId, sellerInstanceId] = sellerB.store.hash.split('/').slice(1);
    const copiesV1 = await e2eAuthPool.query(
      `SELECT c.source_material_id, c.source_version_no, c.asset_id, a.tenant_ref::text AS asset_tenant_id
         FROM commerce_distribution_photo_copies c
         JOIN assets a ON a.asset_id = c.asset_id
        WHERE c.tenant_id = $1 AND c.instance_id = $2 AND c.product_id = $3`,
      [sellerTenantId, sellerInstanceId, sup.product.product_id],
    );
    expect(copiesV1.rowCount).toBe(1);
    expect(copiesV1.rows[0]).toMatchObject({
      source_material_id: materialId,
      source_version_no: 1,
      asset_tenant_id: sellerTenantId,
    });

    // Before B publishes again, public media JSON equals the one recorded before the use
    const mediaStillBefore = PublicStoreMediaSchema.parse(
      await (await sellerB.page.request.get(`/api/v1/public/stores/${sellerBSlug}/media`)).json(),
    );
    expect(mediaStillBefore).toEqual(mediaBefore);

    // B 發布更新 → 已發布・第 2 版
    await storeArea(sellerB.page, '店面與發布');
    await sellerB.page.getByRole('button', {name: '發布更新', exact: true}).click();
    await expect(sellerB.page.locator('.hosted-store > [role="status"]')).toContainText('已發布・第 2 版');

    const mediaPubV1 = PublicStoreMediaSchema.parse(
      await (await sellerB.page.request.get(`/api/v1/public/stores/${sellerBSlug}/media`)).json(),
    );
    const pubPhotoV1 = mediaPubV1.photos.find(p => p.sku === propB.sku)?.photo ?? null;
    expect(pubPhotoV1).not.toBeNull();
    const publicPathV1 = pubPhotoV1!.read_path;

    const anonCheckV1 = await playwright.request.newContext({baseURL, storageState: {cookies: [], origins: []}});
    let pubBytesV1: Buffer;
    try {
      const pubRespV1 = await anonCheckV1.get(publicPathV1);
      expect(pubRespV1.status()).toBe(200);
      expect(pubRespV1.headers()['content-type']).toBe('image/webp');
      pubBytesV1 = await pubRespV1.body();
      expect(digest(pubBytesV1)).toBe(digest(privateV1Bytes));
    } finally {
      await anonCheckV1.dispose();
    }

    const publicPage = await sellerB.ctx.newPage();
    await publicPage.goto(`/shops/${sellerBSlug}`);
    const pubImg = publicPage.locator('article img');
    await expect(pubImg).toHaveAttribute('src', publicPathV1);
    await expect.poll(() => pubImg.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

    // Supplier uploads version 2 in the console
    await uploadImageVersionInConsole(page, `dist-photo-v2-${suffix}.png`, '#b5542c');

    // B presses 重新整理 in 合作素材: 供應商已更新為第 2 版，店面仍用第 1 版 and 改用新版本
    await storeArea(sellerB.page, '供貨合作');
    await panelB.getByRole('button', {name: '重新整理', exact: true}).click();
    await expect(distBlock).toContainText('供應商已更新為第 2 版，店面仍用第 1 版');
    const updateBtn = distBlock.getByRole('button', {name: '改用新版本', exact: true});
    await expect(updateBtn).toBeVisible();
    await expect(distBlock.getByRole('button', {name: '停止使用', exact: true})).toBeVisible();

    const stillV1BeforeUse = await (await sellerB.page.request.get(publicPathV1)).body();
    expect(digest(stillV1BeforeUse)).toBe(digest(pubBytesV1!));

    // B 改用新版本 → dialog says 第 2 版 → 複製並使用 → 店面使用中（第 2 版）
    await updateBtn.click();
    await expect(useDialog).toBeVisible();
    await expect(useDialog).toContainText('第 2 版');
    await expect(useDialog).toContainText(`「${productTitle}」`);
    await useDialog.getByRole('button', {name: '複製並使用', exact: true}).click();
    await expect(sellerB.page.locator('.hosted-store > [role="status"]')).toContainText(
      '已更新店面草稿，發布店面後才會生效。',
    );
    await expect(distBlock.locator('.badge')).toHaveText('店面使用中（第 2 版）');

    const expectedPrivateV2 = `/api/v1${sellerB.store.root}/distribution-photos/${sup.product.product_id}/photo/2`;
    await expect(distBlock.locator('img.distribution-photo-thumb')).toHaveAttribute('src', expectedPrivateV2);
    const privateV2Bytes = await (await sellerB.page.request.get(expectedPrivateV2)).body();
    expect(digest(privateV2Bytes)).not.toBe(digest(privateV1Bytes));

    // Public bytes are still the version-1 copy until B publishes
    const mediaStillV1AfterUse = PublicStoreMediaSchema.parse(
      await (await sellerB.page.request.get(`/api/v1/public/stores/${sellerBSlug}/media`)).json(),
    );
    expect(mediaStillV1AfterUse.photos.find(p => p.sku === propB.sku)?.photo?.read_path).toBe(
      publicPathV1,
    );
    const stillV1AfterUse = await (await sellerB.page.request.get(publicPathV1)).body();
    expect(digest(stillV1AfterUse)).toBe(digest(pubBytesV1!));

    // After 發布更新 they differ from version 1 and equal B's new private copy; old public path returns 404
    await storeArea(sellerB.page, '店面與發布');
    await sellerB.page.getByRole('button', {name: '發布更新', exact: true}).click();
    await expect(sellerB.page.locator('.hosted-store > [role="status"]')).toContainText('已發布・第 3 版');

    const mediaPubV2 = PublicStoreMediaSchema.parse(
      await (await sellerB.page.request.get(`/api/v1/public/stores/${sellerBSlug}/media`)).json(),
    );
    const pubPhotoV2 = mediaPubV2.photos.find(p => p.sku === propB.sku)?.photo ?? null;
    expect(pubPhotoV2).not.toBeNull();
    const publicPathV2 = pubPhotoV2!.read_path;
    expect(publicPathV2).not.toBe(publicPathV1);

    const anonCheckV2 = await playwright.request.newContext({baseURL, storageState: {cookies: [], origins: []}});
    try {
      const pubRespV2 = await anonCheckV2.get(publicPathV2);
      expect(pubRespV2.status()).toBe(200);
      expect(pubRespV2.headers()['content-type']).toBe('image/webp');
      const pubBytesV2 = await pubRespV2.body();
      expect(digest(pubBytesV2)).toBe(digest(privateV2Bytes));
      expect(digest(pubBytesV2)).not.toBe(digest(pubBytesV1!));

      const oldPubResp = await anonCheckV2.get(publicPathV1);
      expect(oldPubResp.status()).toBe(404);
    } finally {
      await anonCheckV2.dispose();
    }

    // Two copy rows exist for the product
    const copiesV2 = await e2eAuthPool.query(
      `SELECT source_version_no
         FROM commerce_distribution_photo_copies
        WHERE tenant_id = $1 AND instance_id = $2 AND product_id = $3
        ORDER BY source_version_no ASC`,
      [sellerTenantId, sellerInstanceId, sup.product.product_id],
    );
    expect(copiesV2.rows.map(r => r.source_version_no)).toEqual([1, 2]);
  } finally {
    await withdrawPartnerOffers(e2eAuthPool, supplierIds);
    await Promise.all(extraContexts.map(c => c.close()));
  }
});

test('SC-E2E-73 a withdrawn or closed source keeps the published photo until the next publish (AT-27, SC-R29)', async ({
  page,
  browser,
  baseURL,
  e2eAuthPool,
}) => {
  const suffix = randomUUID().slice(0, 6);
  const extraContexts: Array<{close: () => Promise<void>}> = [];
  const supplierIds: string[] = [];

  try {
    const sup = await setupSupplierWithOfferForPartnerMedia(page, e2eAuthPool, suffix);
    supplierIds.push(sup.member.id);
    const productTitle = sup.offer.terms.title;

    const sellerBSlug = `partner-withdraw-b-${suffix}`;
    const sellerB = await openPartnerStore(browser, baseURL, e2eAuthPool, `撤回來源賣家 B ${suffix}`, sellerBSlug);
    extraContexts.push(sellerB.ctx);
    const propB = await post(
      sellerB.page,
      `${sellerB.store.root}/distribution-selections`,
      {offer_id: sup.offer.offer_id, terms_sha256: sup.offer.terms_sha256, retail_price_minor: 1200},
      201,
    );
    await post(
      page,
      `${sup.store.root}/supply-requests/${propB.selection_id}/decision`,
      {decision: 'accepted', listing_sha256: propB.listing_sha256},
      200,
      propB.version,
    );

    // Case 1: Supplier creates material 1, uploads v1, opens public_use, grants B; B uses v1 and publishes
    const matTitle1 = `撤回測試主圖 ${suffix}`;
    await createFileMaterialInConsole(page, sup.store, 'image', matTitle1, sup.product.product_id);
    await uploadImageVersionInConsole(page, `dist-withdraw-v1-${suffix}.png`, '#2b6f5e');
    await setMaterialAccessInConsole(page, 'public_use');
    await grantMaterialToAllSellableInConsole(page);

    await open(sellerB.page, sellerB.store.hash);
    await storeArea(sellerB.page, '供貨合作');
    const panelB = sellerPartnerMaterials(sellerB.page);
    const card1 = panelB.locator('article.card').filter({hasText: matTitle1});
    await expect(card1).toBeVisible();
    await card1
      .locator('div.stack > div.stack')
      .filter({hasText: productTitle})
      .getByRole('button', {name: '用於公開店面', exact: true})
      .click();
    const useDialog = sellerB.page.getByRole('dialog', {name: '把這張素材用在公開店面？', exact: true});
    await expect(useDialog).toBeVisible();
    await useDialog.getByRole('button', {name: '複製並使用', exact: true}).click();
    await expect(sellerB.page.locator('.hosted-store > [role="status"]')).toContainText(
      '已更新店面草稿，發布店面後才會生效。',
    );

    await storeArea(sellerB.page, '店面與發布');
    await sellerB.page.getByRole('button', {name: '發布展示頁', exact: true}).click();
    await expect(sellerB.page.locator('.hosted-store > [role="status"]')).toContainText('已發布・第 1 版');

    const mediaPub1 = PublicStoreMediaSchema.parse(
      await (await sellerB.page.request.get(`/api/v1/public/stores/${sellerBSlug}/media`)).json(),
    );
    const publicPath1 = mediaPub1.photos.find(p => p.sku === propB.sku)!.photo.read_path;
    const pubBytes1 = await (await sellerB.page.request.get(publicPath1)).body();
    expect(pubBytes1.length).toBeGreaterThan(0);

    // Supplier 撤回素材 (dialog)
    const withdrawSection = materialActive(page)
      .locator('.sc-section')
      .filter({has: page.getByRole('heading', {level: 3, name: '撤回素材', exact: true})});
    await withdrawSection.getByRole('button', {name: '撤回素材', exact: true}).click();
    const withdrawDialog = page.getByRole('dialog', {name: '永久撤回這個素材', exact: true});
    await expect(withdrawDialog).toBeVisible();
    await withdrawDialog.getByRole('button', {name: '確認撤回素材', exact: true}).click();
    await expect(materialConsole(page).locator('.sc-announcement')).toHaveText('已保存：撤回素材。');

    // B presses 重新整理: material is gone and warning shows with 停止使用 and thumbnail; public bytes unchanged
    await storeArea(sellerB.page, '供貨合作');
    await panelB.getByRole('button', {name: '重新整理', exact: true}).click();
    await expect(panelB).not.toContainText(matTitle1);
    const unavailableWarning = panelB
      .locator(':scope > div.stack')
      .filter({hasText: `「${productTitle}」的店面照片來源已撤回或不再開放公開使用，下次發布時不會顯示。`});
    await expect(unavailableWarning).toBeVisible();
    await expect(unavailableWarning.getByRole('button', {name: '停止使用', exact: true})).toBeVisible();
    const warnThumb1 = unavailableWarning.locator('img.distribution-photo-thumb');
    await expect(warnThumb1).toBeVisible();
    await expect.poll(() => warnThumb1.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

    const stillPubBytes1 = await (await sellerB.page.request.get(publicPath1)).body();
    expect(digest(stillPubBytes1)).toBe(digest(pubBytes1));

    // Refresh store preview state via 更新供貨狀態 and publish update: public media has no photo for that product
    await sellerB.page.getByRole('button', {name: '更新供貨狀態', exact: true}).click();
    await storeArea(sellerB.page, '店面與發布');
    await sellerB.page.getByRole('button', {name: '發布更新', exact: true}).click();
    await expect(sellerB.page.locator('.hosted-store > [role="status"]')).toContainText('已發布・第 2 版');

    const mediaAfterWithdrawPub = PublicStoreMediaSchema.parse(
      await (await sellerB.page.request.get(`/api/v1/public/stores/${sellerBSlug}/media`)).json(),
    );
    expect(mediaAfterWithdrawPub.photos.find(p => p.sku === propB.sku)?.photo ?? null).toBeNull();

    // B 停止使用: warning disappears after list reloads; pointer row has no asset and copy row is still there
    await storeArea(sellerB.page, '供貨合作');
    await unavailableWarning.getByRole('button', {name: '停止使用', exact: true}).click();
    await expect(sellerB.page.locator('.hosted-store > [role="status"]')).toContainText(
      '已更新店面草稿，發布店面後才會生效。',
    );
    await expect(unavailableWarning).toHaveCount(0);

    const [sellerTenantId, sellerInstanceId] = sellerB.store.hash.split('/').slice(1);
    const targetAfterDetach = await e2eAuthPool.query(
      `SELECT asset_id, aggregate_version::text AS version
         FROM commerce_distribution_photo_targets
        WHERE tenant_id = $1 AND instance_id = $2 AND product_id = $3`,
      [sellerTenantId, sellerInstanceId, sup.product.product_id],
    );
    expect(targetAfterDetach.rows).toEqual([{asset_id: null, version: '2'}]);

    const copiesAfterDetach = await e2eAuthPool.query(
      `SELECT count(*)::int AS cnt
         FROM commerce_distribution_photo_copies
        WHERE tenant_id = $1 AND instance_id = $2 AND product_id = $3`,
      [sellerTenantId, sellerInstanceId, sup.product.product_id],
    );
    expect(copiesAfterDetach.rows[0].cnt).toBe(1);

    // Case 2: New material where supplier changes 使用範圍 back to 僅授權的合作店家 instead of withdrawing
    const matTitle2 = `縮回授權主圖 ${suffix}`;
    await createFileMaterialInConsole(page, sup.store, 'image', matTitle2, sup.product.product_id);
    await uploadImageVersionInConsole(page, `dist-close-v1-${suffix}.png`, '#7c3f6e');
    await setMaterialAccessInConsole(page, 'public_use');
    await grantMaterialToAllSellableInConsole(page);

    await panelB.getByRole('button', {name: '重新整理', exact: true}).click();
    const card2 = panelB.locator('article.card').filter({hasText: matTitle2});
    await expect(card2).toBeVisible();
    await card2
      .locator('div.stack > div.stack')
      .filter({hasText: productTitle})
      .getByRole('button', {name: '用於公開店面', exact: true})
      .click();
    await expect(useDialog).toBeVisible();
    await useDialog.getByRole('button', {name: '複製並使用', exact: true}).click();
    await expect(sellerB.page.locator('.hosted-store > [role="status"]')).toContainText(
      '已更新店面草稿，發布店面後才會生效。',
    );

    await storeArea(sellerB.page, '店面與發布');
    await sellerB.page.getByRole('button', {name: '發布更新', exact: true}).click();
    await expect(sellerB.page.locator('.hosted-store > [role="status"]')).toContainText('已發布・第 3 版');

    const mediaPub2 = PublicStoreMediaSchema.parse(
      await (await sellerB.page.request.get(`/api/v1/public/stores/${sellerBSlug}/media`)).json(),
    );
    const publicPath2 = mediaPub2.photos.find(p => p.sku === propB.sku)!.photo.read_path;
    const pubBytes2 = await (await sellerB.page.request.get(publicPath2)).body();
    expect(pubBytes2.length).toBeGreaterThan(0);

    // Supplier changes 使用範圍 back to 僅授權的合作店家
    await setMaterialAccessInConsole(page, 'partners');

    // B presses 重新整理: sees the same warning, material stays visible without 用於公開店面, next publish drops photo
    await storeArea(sellerB.page, '供貨合作');
    await panelB.getByRole('button', {name: '重新整理', exact: true}).click();
    await expect(unavailableWarning).toBeVisible();
    await expect(card2).toBeVisible();
    await expect(card2).toContainText('僅供合作參考，供應商未同意放上公開店面。');
    await expect(card2.getByRole('button', {name: '用於公開店面'})).toHaveCount(0);

    const stillPubBytes2 = await (await sellerB.page.request.get(publicPath2)).body();
    expect(digest(stillPubBytes2)).toBe(digest(pubBytes2));

    await sellerB.page.getByRole('button', {name: '更新供貨狀態', exact: true}).click();
    await storeArea(sellerB.page, '店面與發布');
    await sellerB.page.getByRole('button', {name: '發布更新', exact: true}).click();
    await expect(sellerB.page.locator('.hosted-store > [role="status"]')).toContainText('已發布・第 4 版');

    const mediaAfterClosePub = PublicStoreMediaSchema.parse(
      await (await sellerB.page.request.get(`/api/v1/public/stores/${sellerBSlug}/media`)).json(),
    );
    expect(mediaAfterClosePub.photos.find(p => p.sku === propB.sku)?.photo ?? null).toBeNull();
  } finally {
    await withdrawPartnerOffers(e2eAuthPool, supplierIds);
    await Promise.all(extraContexts.map(c => c.close()));
  }
});

test('SC-E2E-74 a use with an unknown result is retried with the same key and makes one copy (AT-27; AT-24 pattern)', async ({
  page,
  browser,
  baseURL,
  e2eAuthPool,
}) => {
  const suffix = randomUUID().slice(0, 6);
  const extraContexts: Array<{close: () => Promise<void>}> = [];
  const supplierIds: string[] = [];

  try {
    const sup = await setupSupplierWithOfferForPartnerMedia(page, e2eAuthPool, suffix);
    supplierIds.push(sup.member.id);
    const productTitle = sup.offer.terms.title;

    const sellerBSlug = `partner-retry-b-${suffix}`;
    const sellerB = await openPartnerStore(browser, baseURL, e2eAuthPool, `重試賣家 B ${suffix}`, sellerBSlug);
    extraContexts.push(sellerB.ctx);
    const propB = await post(
      sellerB.page,
      `${sellerB.store.root}/distribution-selections`,
      {offer_id: sup.offer.offer_id, terms_sha256: sup.offer.terms_sha256, retail_price_minor: 1200},
      201,
    );
    await post(
      page,
      `${sup.store.root}/supply-requests/${propB.selection_id}/decision`,
      {decision: 'accepted', listing_sha256: propB.listing_sha256},
      200,
      propB.version,
    );

    const matTitle = `重試素材 ${suffix}`;
    await createFileMaterialInConsole(page, sup.store, 'image', matTitle, sup.product.product_id);
    await uploadImageVersionInConsole(page, `dist-retry-v1-${suffix}.png`, '#3b5998');
    await setMaterialAccessInConsole(page, 'public_use');
    await grantMaterialToAllSellableInConsole(page);

    await open(sellerB.page, sellerB.store.hash);
    await storeArea(sellerB.page, '供貨合作');
    const panelB = sellerPartnerMaterials(sellerB.page);
    const cardB = panelB.locator('article.card').filter({hasText: matTitle});
    await expect(cardB).toBeVisible();
    const distBlock = cardB.locator('div.stack > div.stack').filter({hasText: productTitle});
    const useBtn = distBlock.getByRole('button', {name: '用於公開店面', exact: true});
    await expect(useBtn).toBeEnabled();

    let abortedOnce = false;
    const capturedUseRequests: Array<{key: string; ifMatch: string; body: string}> = [];
    await sellerB.page.route('**/api/v1/tenants/*/storefronts/*/distribution-photos/*/use', async route => {
      const req = route.request();
      if (req.method() !== 'POST') return route.continue();
      capturedUseRequests.push({
        key: req.headers()['idempotency-key'] ?? '',
        ifMatch: req.headers()['if-match'] ?? '',
        body: req.postData() ?? '',
      });
      if (!abortedOnce) {
        abortedOnce = true;
        await route.fetch();
        await route.abort('failed');
        return;
      }
      await route.continue();
    });

    await useBtn.click();
    const useDialog = sellerB.page.getByRole('dialog', {name: '把這張素材用在公開店面？', exact: true});
    await expect(useDialog).toBeVisible();
    await useDialog.getByRole('button', {name: '複製並使用', exact: true}).click();

    await expect(sellerB.page.locator('.hosted-store > [role="alert"]')).toHaveText(
      '尚未確認原操作的結果，請按「重試」確認。',
    );
    const storeRetryBtn = sellerB.page.locator('.hosted-store > .actions').getByRole('button', {name: '重試', exact: true});
    await expect(storeRetryBtn).toBeVisible();

    // 合作素材 buttons are disabled while the store holds an unknown result
    await expect(useBtn).toBeDisabled();

    await storeRetryBtn.click();
    await expect(sellerB.page.locator('.hosted-store > [role="status"]')).toContainText(
      '已更新店面草稿，發布店面後才會生效。',
    );
    await expect(distBlock.locator('.badge')).toHaveText('店面使用中（第 1 版）');

    expect(capturedUseRequests).toHaveLength(2);
    expect(capturedUseRequests[0].key).toBeTruthy();
    expect(capturedUseRequests[0].ifMatch).toBe('"0"');
    expect(capturedUseRequests[1]).toEqual(capturedUseRequests[0]);

    const [sellerTenantId, sellerInstanceId] = sellerB.store.hash.split('/').slice(1);
    const copiesCount = await e2eAuthPool.query(
      `SELECT count(*)::int AS cnt
         FROM commerce_distribution_photo_copies
        WHERE tenant_id = $1 AND instance_id = $2 AND product_id = $3`,
      [sellerTenantId, sellerInstanceId, sup.product.product_id],
    );
    expect(copiesCount.rows[0].cnt).toBe(1);

    const targetRow = await e2eAuthPool.query(
      `SELECT asset_id, aggregate_version::text AS version
         FROM commerce_distribution_photo_targets
        WHERE tenant_id = $1 AND instance_id = $2 AND product_id = $3`,
      [sellerTenantId, sellerInstanceId, sup.product.product_id],
    );
    expect(targetRow.rowCount).toBe(1);
    expect(targetRow.rows[0].asset_id).toBeTruthy();
    expect(targetRow.rows[0].version).toBe('1');

    await sellerB.page.unroute('**/api/v1/tenants/*/storefronts/*/distribution-photos/*/use');

    // Sign out and back in: the same state shows
    await signOut(sellerB.page);
    await login(sellerB.page, sellerB.member.email);
    await open(sellerB.page, sellerB.store.hash);
    await storeArea(sellerB.page, '供貨合作');
    await expect(
      sellerPartnerMaterials(sellerB.page)
        .locator('article.card')
        .filter({hasText: matTitle})
        .locator('div.stack > div.stack')
        .filter({hasText: productTitle})
        .locator('.badge'),
    ).toHaveText('店面使用中（第 1 版）');
  } finally {
    await withdrawPartnerOffers(e2eAuthPool, supplierIds);
    await Promise.all(extraContexts.map(c => c.close()));
  }
});

test('SC-E2E-75 viewers, the flag off and the layout', async ({
  page,
  browser,
  baseURL,
  e2eAuthPool,
}, info) => {
  const suffix = randomUUID().slice(0, 6);
  const extraContexts: Array<{close: () => Promise<void>}> = [];
  const supplierIds: string[] = [];

  try {
    const sup = await setupSupplierWithOfferForPartnerMedia(page, e2eAuthPool, suffix);
    supplierIds.push(sup.member.id);
    const productTitle = sup.offer.terms.title;

    const sellerBSlug = `partner-layout-b-${suffix}`;
    const sellerB = await openPartnerStore(browser, baseURL, e2eAuthPool, `版面與權限賣家 B ${suffix}`, sellerBSlug);
    extraContexts.push(sellerB.ctx);
    const propB = await post(
      sellerB.page,
      `${sellerB.store.root}/distribution-selections`,
      {offer_id: sup.offer.offer_id, terms_sha256: sup.offer.terms_sha256, retail_price_minor: 1200},
      201,
    );
    await post(
      page,
      `${sup.store.root}/supply-requests/${propB.selection_id}/decision`,
      {decision: 'accepted', listing_sha256: propB.listing_sha256},
      200,
      propB.version,
    );

    const matTitle = `版面測試主圖 ${suffix}`;
    await createFileMaterialInConsole(page, sup.store, 'image', matTitle, sup.product.product_id);
    await uploadImageVersionInConsole(page, `dist-layout-v1-${suffix}.png`, '#2e7d32');
    await setMaterialAccessInConsole(page, 'public_use');
    await grantMaterialToAllSellableInConsole(page);

    // 1. Flag off, UI check only (the server side is covered by DP-10):
    // Route GET /api/v1/site to the real response with distribution_photos_enabled: false
    const flagOffPage = await sellerB.ctx.newPage();
    let flagOffDistPhotoReqs = 0;
    flagOffPage.on('request', req => {
      if (req.url().includes('/distribution-photos')) {
        flagOffDistPhotoReqs += 1;
      }
    });
    await flagOffPage.route('**/api/v1/site', async route => {
      if (route.request().method() !== 'GET') return route.continue();
      const realResp = await route.fetch();
      const siteJson = await realResp.json();
      await route.fulfill({
        response: realResp,
        json: {...siteJson, distribution_photos_enabled: false},
      });
    });
    await flagOffPage.goto(`/#${sellerB.store.hash}`);
    await expect(flagOffPage.locator('.hosted-store')).toBeVisible();
    await storeArea(flagOffPage, '供貨合作');
    const flagOffPanel = sellerPartnerMaterials(flagOffPage);
    const flagOffCard = flagOffPanel.locator('article.card').filter({hasText: matTitle});
    await expect(flagOffCard).toBeVisible();
    await expect(flagOffCard).toContainText('這個環境尚未開放把素材用在公開店面。');
    await expect(flagOffCard.getByRole('button', {name: '用於公開店面'})).toHaveCount(0);
    expect(flagOffDistPhotoReqs).toBe(0);
    await flagOffPage.close();

    // 2. Layout at 390x844 and 1440x900 with and without the dialog open
    await open(sellerB.page, sellerB.store.hash);
    await storeArea(sellerB.page, '供貨合作');
    const panelB = sellerPartnerMaterials(sellerB.page);
    const cardB = panelB.locator('article.card').filter({hasText: matTitle});
    await expect(cardB).toBeVisible();
    const distBlock = cardB.locator('div.stack > div.stack').filter({hasText: productTitle});
    const useBtn = distBlock.getByRole('button', {name: '用於公開店面', exact: true});
    const useDialog = sellerB.page.getByRole('dialog', {name: '把這張素材用在公開店面？', exact: true});

    const measureDesktopSmallButtons = () =>
      sellerB.page.locator('.partner-materials .btn-small').evaluateAll(elements =>
        elements
          .filter(el => (el as HTMLElement).offsetParent !== null)
          .flatMap(el => {
            const btnRect = el.getBoundingClientRect();
            const row = el.closest('.sc-row, .sc-section, .card, .partner-materials') ?? el.parentElement!;
            const rowRect = row.getBoundingClientRect();
            return btnRect.width > rowRect.width || btnRect.width >= rowRect.width * 0.9
              ? [{text: el.textContent, btnWidth: btnRect.width, rowWidth: rowRect.width}]
              : [];
          }),
      );

    for (const [width, height] of [
      [390, 844],
      [1440, 900],
    ] as const) {
      await sellerB.page.setViewportSize({width, height});
      await expect(useBtn).toBeVisible();
      expect(await sellerB.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (width === 1440) {
        expect(await measureDesktopSmallButtons()).toEqual([]);
      }
      await panelB.screenshot({path: info.outputPath(`distribution-photos-panel-${width}x${height}.png`)});

      await useBtn.click();
      await expect(useDialog).toBeVisible();
      expect(await sellerB.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const box = await useDialog.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      expect(box!.y + box!.height).toBeLessThanOrEqual(height);
      if (width === 1440) {
        expect(await measureDesktopSmallButtons()).toEqual([]);
      }
      await sellerB.page.screenshot({path: info.outputPath(`distribution-photos-dialog-${width}x${height}.png`)});
      await useDialog.getByRole('button', {name: '取消', exact: true}).click();
      await expect(useDialog).toBeHidden();
    }

    // 3. B uses version 1, then a store:read viewer of B's business sees the badge and thumbnail but no action buttons
    await useBtn.click();
    await expect(useDialog).toBeVisible();
    await useDialog.getByRole('button', {name: '複製並使用', exact: true}).click();
    await expect(sellerB.page.locator('.hosted-store > [role="status"]')).toContainText(
      '已更新店面草稿，發布店面後才會生效。',
    );
    await expect(distBlock.locator('.badge')).toHaveText('店面使用中（第 1 版）');

    const viewer = await person(e2eAuthPool);
    const viewerCtx = await browser.newContext({baseURL});
    extraContexts.push(viewerCtx);
    const viewerPage = await viewerCtx.newPage();
    await login(viewerPage, viewer.email);

    const candResp = await sellerB.page.request.get(`/api/v1/tenants/invite-candidates?user_id=${viewer.id}`);
    expect(candResp.status()).toBe(200);
    const {principal_id} = await candResp.json();
    const [sellerTenantId, sellerInstanceId] = sellerB.store.hash.split('/').slice(1);
    const inv = await post(
      sellerB.page,
      `/tenants/${sellerTenantId}/invitations`,
      {
        invitee_principal_id: principal_id,
        role: 'viewer',
        instance_capabilities: [{instance_id: sellerInstanceId, capabilities: ['store:read']}],
        expires_at: new Date(Date.now() + 86400_000).toISOString(),
      },
      201,
    );
    await post(viewerPage, `/tenants/${sellerTenantId}/invitations/${inv.invitation_id}/accept`, {}, 200, inv.version);

    await open(viewerPage, sellerB.store.hash);
    await storeArea(viewerPage, '供貨合作');
    const viewerPanel = sellerPartnerMaterials(viewerPage);
    const viewerCard = viewerPanel.locator('article.card').filter({hasText: matTitle});
    await expect(viewerCard).toBeVisible();
    const viewerDistBlock = viewerCard.locator('div.stack > div.stack').filter({hasText: productTitle});
    await expect(viewerDistBlock.locator('.badge')).toHaveText('店面使用中（第 1 版）');
    const viewerThumb = viewerDistBlock.locator('img.distribution-photo-thumb');
    await expect(viewerThumb).toBeVisible();
    await viewerThumb.scrollIntoViewIfNeeded();
    await expect.poll(() => viewerThumb.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

    for (const btnName of ['用於公開店面', '改用新版本', '改用這個素材', '停止使用']) {
      await expect(viewerPanel.getByRole('button', {name: btnName, exact: true})).toHaveCount(0);
    }
  } finally {
    await withdrawPartnerOffers(e2eAuthPool, supplierIds);
    await Promise.all(extraContexts.map(c => c.close()));
  }
});

// Initial bookmarks enter existing lists; every subsequent member operation uses their links and controls.
async function photoStoreFromList(page:Page,store:{hash:string},initial=false){
 if(initial)await page.goto('/#stores');
 else await page.getByRole('link',{name:'返回我的商店',exact:true}).click();
 await page.locator(`a[href="#${store.hash}"]`).click();
 await expect(page.locator('.hosted-store')).toBeVisible();
}
async function photoMaterialFromList(page:Page,title:string,productId:string){
 await page.goto('/#stores/supply');
 await page.getByRole('link',{name:'查看商品與供貨',exact:true}).click();
 await materialConsole(page).getByRole('link',{name:'行銷素材',exact:true}).click();
 await materialActive(page).getByRole('link',{name:'新增素材',exact:true}).click();
 const form=materialActive(page).getByRole('form',{name:'新增素材',exact:true});
 await form.getByLabel('種類').selectOption('image');await form.getByLabel('素材對象').selectOption(productId);
 await form.getByLabel('標題').fill(title);await form.getByLabel('說明').fill('連續照片流程的合成授權圖片');
 await form.getByRole('button',{name:'建立素材',exact:true}).click();
 await expect(materialActive(page).getByRole('heading',{name:`素材詳情：${title}`,exact:true})).toBeVisible();
 return new URL(page.url()).hash.match(/\/materials\/([0-9a-f-]{36})$/)![1];
}
async function photoGrantAll(page:Page,count:number){
 const section=materialActive(page).locator('.sc-section').filter({has:page.getByRole('heading',{name:'店家授權',exact:true})});
 await section.getByRole('button',{name:`授權給目前所有可售的合作店家（${count} 間）`,exact:true}).click();
 await section.getByRole('button',{name:'授權選取的店家',exact:true}).click();
 await expect(materialConsole(page).locator('.sc-announcement')).toHaveText('已保存：授權選取的店家。');
}
async function photoStoreNavigation(page:Page){
 const nav=page.locator('#workspace-navigation');await nav.locator(':scope > details > summary').click();
 await nav.getByRole('searchbox').fill('我的商店');await nav.getByRole('button',{name:'我的商店',exact:true}).click();
}
const partnerPhotoBlock=(page:Page,title:string,product:string)=>sellerPartnerMaterials(page).locator('article.card').filter({hasText:title}).locator('div.stack > div.stack').filter({hasText:product});
async function photoChoose(page:Page,title:string,product:string,update=false){
 await partnerPhotoBlock(page,title,product).getByRole('button',{name:update?'改用新版本':'用於公開店面',exact:true}).click();
 await page.getByRole('dialog',{name:'把這張素材用在公開店面？',exact:true}).getByRole('button',{name:'複製並使用',exact:true}).click();
}
async function photoPublish(page:Page,revision:number){
 await storeArea(page,'店面與發布');
 await page.getByRole('button',{name:revision===1?'發布展示頁':'發布更新',exact:true}).click();
 await expect(page.locator('.hosted-store > [role="status"]')).toContainText(`已發布・第 ${revision} 版`);
}
const photoTenant=(store:{hash:string})=>store.hash.split('/')[1];
async function photoCapacity(db:Parameters<typeof person>[0],tenant:string){
 const result=await db.query(`SELECT COALESCE(sum(COALESCE(o.byte_size,i.reserved_bytes,CASE a.purpose
  WHEN 'storefront.product-photo' THEN 1048576 WHEN 'storefront.supply-material' THEN 1048576
  WHEN 'storefront.supply-material-video' THEN 20971520 ELSE 262144 END)::bigint),0)::text AS used
  FROM assets a LEFT JOIN asset_objects o USING(asset_id) LEFT JOIN asset_upload_intents i USING(asset_id)
  WHERE a.tenant_ref=$1 AND a.scope_id=(SELECT scope_id FROM resource_scopes WHERE kind='tenant' AND tenant_ref=$1) AND a.purpose IN ('work.tenant-result','storefront.product-photo','storefront.supply-material','storefront.supply-material-video')`,[tenant]);
 return BigInt(result.rows[0].used);
}
async function photoFacts(db:Parameters<typeof person>[0],store:{hash:string},productId:string){
 const [tenant,instance]=store.hash.split('/').slice(1);
 const copies=await db.query(`SELECT c.asset_id,c.source_version_no,a.tenant_ref,a.state,o.byte_size::text FROM commerce_distribution_photo_copies c
 JOIN assets a USING(asset_id) JOIN asset_objects o USING(asset_id) WHERE c.tenant_id=$1 AND c.instance_id=$2 AND c.product_id=$3 ORDER BY c.source_version_no`,[tenant,instance,productId]);
 const pointers=await db.query('SELECT asset_id,aggregate_version::text AS version FROM commerce_distribution_photo_targets WHERE tenant_id=$1 AND instance_id=$2 AND product_id=$3',[tenant,instance,productId]);
 const assets=await db.query("SELECT asset_id FROM assets WHERE tenant_ref=$1 AND purpose='storefront.product-photo' ORDER BY asset_id",[tenant]);
 return {copies:copies.rows,pointers:pointers.rows,assets:assets.rows,capacity:(await photoCapacity(db,tenant)).toString()};
}
async function photoAccept(page:Page,supplierPage:Page,root:string,supplierRoot:string,offer:any){
 const selection=await post(page,`${root}/distribution-selections`,{offer_id:offer.offer_id,terms_sha256:offer.terms_sha256,retail_price_minor:1200},201);
 await post(supplierPage,`${supplierRoot}/supply-requests/${selection.selection_id}/decision`,{decision:'accepted',listing_sha256:selection.listing_sha256},200,selection.version);
 return selection;
}

test('SC-E2E-76 one partner-photo flow: grant, use, draft preview, publish, new version, revoke, next publish (AT-27, SC-R29)',async({page,browser,baseURL,e2eAuthPool},info)=>{
 const suffix=randomUUID().slice(0,6),contexts:Array<{close:()=>Promise<void>}>=[],suppliers:string[]=[];
 const evidence:Record<string,unknown>={};
 try{
  const sup=await setupSupplierWithOfferForPartnerMedia(page,e2eAuthPool,suffix);suppliers.push(sup.member.id);
  const slug=`whole-photo-${suffix}`,b=await openPartnerStore(browser,baseURL,e2eAuthPool,`連續照片賣家 ${suffix}`,slug);contexts.push(b.ctx);
  const selection=await photoAccept(b.page,page,b.store.root,sup.store.root,sup.offer),title=`連續主圖 ${suffix}`,product=sup.offer.terms.title;
  await photoMaterialFromList(page,title,sup.product.product_id);await uploadImageVersionInConsole(page,`whole-v1-${suffix}.png`,'#286a96');
  await setMaterialAccessInConsole(page,'public_use');await photoGrantAll(page,1);
  const supplierUsed1=await photoCapacity(e2eAuthPool,photoTenant(sup.store)),sellerBefore=await photoCapacity(e2eAuthPool,photoTenant(b.store));
  await photoStoreFromList(b.page,b.store,true);await photoPublish(b.page,1);
  const anonymous=await browser.newContext({baseURL});contexts.push(anonymous);const publicPage=await anonymous.newPage();
  const media=async()=>PublicStoreMediaSchema.parse(await(await publicPage.request.get(`/api/v1/public/stores/${slug}/media`)).json());
  const before=await media();expect(before.photos).toEqual([]);
  await storeArea(b.page,'供貨合作');await photoChoose(b.page,title,product);
  const block=partnerPhotoBlock(b.page,title,product);
  await expect(block).toContainText('店面使用中（第 1 版）');
  const private1=await block.locator('img.distribution-photo-thumb').getAttribute('src');expect(private1).toBeTruthy();
  const copy1=await b.page.request.get(private1!);expect(copy1.status()).toBe(200);const hash1=digest(await copy1.body());
  await storeArea(b.page,'店面與發布');
  const popup=b.page.waitForEvent('popup');await b.page.getByRole('link',{name:'預覽已儲存的展示頁',exact:true}).click();
  const preview=await popup;await expect(preview.locator('article img')).toHaveAttribute('src',private1!);
  await expect(preview.locator('article img')).toBeVisible();
  await expect.poll(()=>preview.locator('article img').evaluate(el=>(el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  expect(digest(await(await preview.request.get(private1!)).body())).toBe(hash1);await preview.close();
  expect(await media()).toEqual(before);
  await photoPublish(b.page,2);const first=(await media()).photos.find(p=>p.sku===selection.sku)!.photo.read_path;
  const bytes1=await publicPage.request.get(first);expect(bytes1.status()).toBe(200);expect(digest(await bytes1.body())).toBe(hash1);
  expect(await photoCapacity(e2eAuthPool,photoTenant(sup.store))).toBe(supplierUsed1);
  await uploadImageVersionInConsole(page,`whole-v2-${suffix}.png`,'#b35429');
  const supplierUsed2=await photoCapacity(e2eAuthPool,photoTenant(sup.store));
  await storeArea(b.page,'供貨合作');await sellerPartnerMaterials(b.page).getByRole('button',{name:'重新整理',exact:true}).click();
  await expect(block).toContainText('供應商已更新為第 2 版，店面仍用第 1 版');await photoChoose(b.page,title,product,true);
  await expect(block).toContainText('店面使用中（第 2 版）');
  const private2=await block.locator('img.distribution-photo-thumb').getAttribute('src');
  const copy2=await b.page.request.get(private2!);expect(copy2.status()).toBe(200);const hash2=digest(await copy2.body());expect(hash2).not.toBe(hash1);
  expect(digest(await(await publicPage.request.get(first)).body())).toBe(hash1);
  await photoPublish(b.page,3);const second=(await media()).photos.find(p=>p.sku===selection.sku)!.photo.read_path;
  const bytes2=await publicPage.request.get(second);expect(bytes2.status()).toBe(200);expect(digest(await bytes2.body())).toBe(hash2);
  const oldFirst=(await publicPage.request.get(first)).status();expect(oldFirst).toBe(404);evidence.snapshot1AfterSnapshot2={status:oldFirst};
  const grants=materialActive(page).locator('.sc-section').filter({has:page.getByRole('heading',{name:'店家授權',exact:true})});
  await grants.locator('ul.sc-list li.sc-row').filter({hasText:b.name}).getByRole('button',{name:'撤銷',exact:true}).click();
  await page.getByRole('dialog',{name:'撤銷店家授權',exact:true}).getByRole('button',{name:'確認撤銷',exact:true}).click();
  await expect(materialConsole(page).locator('.sc-announcement')).toHaveText('已保存：撤銷授權。');
  await storeArea(b.page,'供貨合作');await sellerPartnerMaterials(b.page).getByRole('button',{name:'重新整理',exact:true}).click();
  const warning=sellerPartnerMaterials(b.page).locator(':scope > div.stack').filter({hasText:`「${product}」的店面照片來源已撤回或不再開放公開使用，下次發布時不會顯示。`});
  await expect(warning).toBeVisible();await expect(warning.getByRole('button',{name:'停止使用',exact:true})).toBeVisible();
  await expect(warning.locator('img.distribution-photo-thumb')).toBeVisible();
  const retained=await publicPage.request.get(second);expect(retained.status()).toBe(200);expect(digest(await retained.body())).toBe(hash2);
  await publicPage.goto(`/shops/${slug}`);await expect(publicPage.locator('article img')).toHaveAttribute('src',second);
  await expect.poll(()=>publicPage.locator('article img').evaluate(el=>(el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  expect(await b.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await b.page.screenshot({path:info.outputPath('revoke-keeps-published-photo.png'),fullPage:true});
  await b.page.getByRole('button',{name:'更新供貨狀態',exact:true}).click();await photoPublish(b.page,4);
  expect((await media()).photos.find(p=>p.sku===selection.sku)?.photo??null).toBeNull();
  const oldSecond=(await publicPage.request.get(second)).status();expect(oldSecond).toBe(404);evidence.snapshot2AfterSnapshot3={status:oldSecond};
  const facts=await photoFacts(e2eAuthPool,b.store,sup.product.product_id);expect(facts.copies.map(c=>c.source_version_no)).toEqual([1,2]);
  expect(facts.assets).toHaveLength(2);for(const copy of facts.copies)expect(copy).toMatchObject({tenant_ref:photoTenant(b.store),state:'ready'});
  expect(BigInt(facts.capacity)-sellerBefore).toBe(facts.copies.reduce((sum,c)=>sum+BigInt(c.byte_size),0n));
  expect(facts.pointers).toEqual([{asset_id:facts.copies[1].asset_id,version:'2'}]);
  expect(await photoCapacity(e2eAuthPool,photoTenant(sup.store))).toBe(supplierUsed2);
  const state=await(await b.page.request.get(`/api/v1${b.store.root}/distribution-photos`)).json();
  expect(state.items.find((p:any)=>p.product_id===sup.product.product_id).state).toBe('source_unavailable');
  evidence.final={...facts,state:'source_unavailable',hash1,hash2};
  expect(await b.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await b.page.screenshot({path:info.outputPath('next-publish-without-invalid-photo.png'),fullPage:true});
 }finally{
  const evidencePath=info.outputPath('continuous-flow-evidence.json');
  await (await import('node:fs/promises')).writeFile(evidencePath,JSON.stringify(evidence,null,2));
  await info.attach('continuous-flow-evidence',{path:evidencePath,contentType:'application/json'});
  await withdrawPartnerOffers(e2eAuthPool,suppliers);await Promise.all(contexts.map(c=>c.close()));
 }
});

test('SC-E2E-77 a use answered after a business-space or account switch changes nothing there; the original key replays to one copy (AT-35)',async({page,browser,baseURL,e2eAuthPool},info)=>{
 const suffix=randomUUID().slice(0,6),contexts:Array<{close:()=>Promise<void>}>=[],suppliers:string[]=[];
 const evidence:Record<string,unknown>={},dialogs:string[]=[],requests:Request[]=[],delivery=new Map<string,string>();
 const pending:Array<()=>Promise<void>>=[];
 try{
  const sup=await setupSupplierWithOfferForPartnerMedia(page,e2eAuthPool,suffix);suppliers.push(sup.member.id);
  const b=await openPartnerStore(browser,baseURL,e2eAuthPool,`切換 B1 ${suffix}`,`switch-b1-${suffix}`);contexts.push(b.ctx);
  const b2=await launchStore(b.page,`切換 B2 空間 ${suffix}`);await post(b.page,`${b2.root}/setup`,{name:`切換 B2 ${suffix}`,slug:`switch-b2-${suffix}`,currency:'TWD'},201);
  const c=await openPartnerStore(browser,baseURL,e2eAuthPool,`切換 C1 ${suffix}`,`switch-c1-${suffix}`);contexts.push(c.ctx);
  for(const [seller,store] of [[b,b.store],[b,b2],[c,c.store]] as const)await photoAccept(seller.page,page,store.root,sup.store.root,sup.offer);
  const title=`切換主圖 ${suffix}`,product=sup.offer.terms.title,productId=sup.product.product_id;
  const materialId=await photoMaterialFromList(page,title,productId);await uploadImageVersionInConsole(page,`switch-v1-${suffix}.png`,'#356a91');
  await setMaterialAccessInConsole(page,'public_use');await photoGrantAll(page,3);
  const none=async(target:Page,store:{root:string})=>{
   const panel=sellerPartnerMaterials(target);await expect(partnerPhotoBlock(target,title,product).getByRole('button',{name:'用於公開店面',exact:true})).toBeVisible();
   await expect(panel.locator('img.distribution-photo-thumb')).toHaveCount(0);await expect(panel).not.toContainText('店面使用中');
   await expect(target.locator('.hosted-store > [role="status"]')).not.toContainText('已更新店面草稿');
   const state=await(await target.request.get(`/api/v1${store.root}/distribution-photos`)).json();
   expect(state.items.find((item:any)=>item.product_id===productId).state).toBe('none');
  };
  const screenshot=async(name:string)=>{
   expect(await b.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   await b.page.screenshot({path:info.outputPath(name),fullPage:true});
  };
  await photoStoreFromList(b.page,b2,true);await storeArea(b.page,'供貨合作');await none(b.page,b2);
  const b2Before=await photoFacts(e2eAuthPool,b2,productId);expect(b2Before).toEqual({copies:[],pointers:[],assets:[],capacity:'0'});
  await storeArea(b.page,'店面與發布');const b2Publication=await b.page.locator('#store-publish-panel').innerText();
  await photoStoreFromList(c.page,c.store,true);await storeArea(c.page,'供貨合作');await none(c.page,c.store);
  const cBefore=await photoFacts(e2eAuthPool,c.store,productId);expect(cBefore).toEqual({copies:[],pointers:[],assets:[],capacity:'0'});
  await photoStoreFromList(b.page,b.store);await storeArea(b.page,'供貨合作');await none(b.page,b.store);
  const bBefore=await photoFacts(e2eAuthPool,b.store,productId),exactPath=`/api/v1${b.store.root}/distribution-photos/${productId}/use`;
  const key=(request:Request)=>request.headers()['idempotency-key'];
  b.page.on('dialog',async dialog=>{dialogs.push(dialog.message());await dialog.accept();});
  b.page.on('request',request=>requests.push(request));
  b.page.on('response',response=>{if(key(response.request()))delivery.set(key(response.request()),`response ${response.status()}`);});
  b.page.on('requestfailed',request=>{if(key(request))delivery.set(key(request),`failed: ${request.failure()?.errorText}`);});
  const hold=async()=>{
   let release!:()=>void,ready!:(answer:{request:Request;response:import('@playwright/test').APIResponse})=>void,done!:()=>void;
   const gate=new Promise<void>(resolve=>{release=resolve;}),committed=new Promise<{request:Request;response:import('@playwright/test').APIResponse}>(resolve=>{ready=resolve;}),delivered=new Promise<void>(resolve=>{done=resolve;});
   const failures:string[]=[];
   const handler=async(route:import('@playwright/test').Route)=>{
    const response=await route.fetch();ready({request:route.request(),response});await gate;
    try{await route.fulfill({response});}catch(error){failures.push(String(error));}finally{done();}
   };
   await b.page.route(`**${exactPath}`,handler);
   let deliveryPromise:Promise<void>|undefined;
   const deliver=()=>deliveryPromise??=(async()=>{release();await delivered;if(!b.page.isClosed())await b.page.unroute(`**${exactPath}`,handler);})();pending.push(deliver);
   return {committed,deliver,failures};
  };
  const capture=async(answer:{request:Request;response:import('@playwright/test').APIResponse},version:number)=>{
   const headers=answer.request.headers(),sig={key:key(answer.request),ifMatch:headers['if-match'],mime:headers['content-type'],body:answer.request.postData()!};
   expect(answer.response.status()).toBe(200);expect(sig.key).toBeTruthy();expect(sig.ifMatch).toBe(`"${version-1}"`);
   expect(sig.mime).toBe('application/json');expect(JSON.parse(sig.body)).toEqual({material_id:materialId,version_id:expect.any(String)});
   evidence[`signature${version}`]=sig;return {...sig,status:answer.response.status(),answer:await answer.response.text()};
  };
  const refusal='正在確認原操作，請等候完成後再離開。';
  const one=await hold();await photoChoose(b.page,title,product);const original1=await capture(await one.committed,1);
  const b1URL=b.page.url(),heading=await b.page.locator('.hosted-store').getByRole('heading',{name:b.name,exact:true}).innerText(),requestMark=requests.length;
  await b.page.getByRole('link',{name:'返回我的商店',exact:true}).click();
  await expect(b.page.locator('.hosted-store > [role="status"]')).toHaveText(`${refusal} 尚未發布`);
  await expect(b.page).toHaveURL(b1URL);await expect(b.page.locator('.hosted-store').getByRole('heading',{name:b.name,exact:true})).toHaveText(heading);expect(dialogs).toEqual([]);
  expect(requests.slice(requestMark).filter(r=>new URL(r.url()).pathname.startsWith(`/api/v1${b2.root}`))).toHaveLength(0);
  evidence.businessRefusal=refusal;await screenshot('business-space-navigation-refused.png');
  await one.deliver();await expect(partnerPhotoBlock(b.page,title,product)).toContainText('店面使用中（第 1 版）');
  const after1=await photoFacts(e2eAuthPool,b.store,productId);expect(after1.copies).toHaveLength(1);expect(after1.assets).toHaveLength(1);
  await photoStoreFromList(b.page,b2);await storeArea(b.page,'供貨合作');await none(b.page,b2);
  expect(await photoFacts(e2eAuthPool,b2,productId)).toEqual(b2Before);
  await storeArea(b.page,'店面與發布');expect(await b.page.locator('#store-publish-panel').innerText()).toBe(b2Publication);
  await screenshot('business-space-b2-unaffected.png');
  await photoStoreFromList(b.page,b.store);await storeArea(b.page,'供貨合作');
  await uploadImageVersionInConsole(page,`switch-v2-${suffix}.png`,'#b35e37');
  await sellerPartnerMaterials(b.page).getByRole('button',{name:'重新整理',exact:true}).click();
  await expect(partnerPhotoBlock(b.page,title,product)).toContainText('供應商已更新為第 2 版，店面仍用第 1 版');
  const two=await hold();await photoChoose(b.page,title,product,true);const original2=await capture(await two.committed,2);expect(original2.key).not.toBe(original1.key);
  await b.page.getByRole('button',{name:'設定',exact:true}).click();
  await b.page.getByRole('menu',{name:'個人檔案',exact:true}).getByRole('menuitem',{name:'登出',exact:true}).click();
  const loginHeading=b.page.getByRole('heading',{name:'登入',exact:true});
  if(!await loginHeading.isVisible()){
   await expect(b.page.locator('.hosted-store > [role="status"]')).toHaveText(`${refusal} 尚未發布`);await expect(b.page).toHaveURL(b1URL);expect(dialogs).toEqual([]);
   evidence.signOut={possibleWhileSending:false,refusal};await screenshot('account-signout-refused.png');
   const expired=await e2eAuthPool.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now()",[b.member.id]);expect(expired.rowCount).toBe(1);
   const unauthorized=b.page.waitForResponse(r=>r.status()===401&&new URL(r.url()).pathname===`/api/v1${b.store.root}/partner-materials`);
   await sellerPartnerMaterials(b.page).getByRole('button',{name:'重新整理',exact:true}).click();expect((await unauthorized).status()).toBe(401);
  }else evidence.signOut={possibleWhileSending:true};
  await expect(loginHeading).toBeVisible();await expect(b.page.locator('.hosted-store')).toHaveCount(0);
  await loginHere(b.page,c.member.email);await photoStoreNavigation(b.page);await b.page.locator(`a[href="#${c.store.hash}"]`).click();await storeArea(b.page,'供貨合作');await none(b.page,c.store);
  const cURL=b.page.url(),lateFinished=delivery.has(original2.key)?Promise.resolve(delivery.get(original2.key)):Promise.race([
   b.page.waitForResponse(r=>key(r.request())===original2.key).then(r=>`response ${r.status()}`),
   b.page.waitForEvent('requestfailed',{predicate:r=>key(r)===original2.key}).then(r=>`failed: ${r.failure()?.errorText}`),
  ]);
  await two.deliver();evidence.lateAnswer={network:two.failures.length?'fulfill failed':await lateFinished,failures:two.failures};
  await expect(b.page).toHaveURL(cURL);await none(b.page,c.store);expect(await photoFacts(e2eAuthPool,c.store,productId)).toEqual(cBefore);
  expect(requests.filter(r=>r.method()==='POST'&&new URL(r.url()).pathname===`/api/v1${c.store.root}/distribution-photos/${productId}/use`)).toHaveLength(0);
  expect(await photoFacts(e2eAuthPool,b2,productId)).toEqual(b2Before);await screenshot('account-c1-after-late-answer.png');
  await signOut(b.page);await loginHere(b.page,b.member.email);await photoStoreNavigation(b.page);
  await b.page.locator(`a[href="#${b.store.hash}"]`).click();await storeArea(b.page,'供貨合作');
  const block=partnerPhotoBlock(b.page,title,product),retry=b.page.getByRole('button',{name:'重試',exact:true});
  await expect.poll(async()=>await retry.isVisible()?'retry':await block.innerText()).toMatch(/retry|店面使用中（第 2 版）/);
  const replayHeaders=async()=>{
   const session=await(await b.page.request.get('/api/v1/session')).json();
   return {'Idempotency-Key':original2.key,'If-Match':original2.ifMatch,'Content-Type':original2.mime,Origin:new URL(b.page.url()).origin,'X-CSRF-Token':session.csrf_token};
  };
  if(await retry.isVisible()){
   evidence.recovery='重試';const answer=b.page.waitForResponse(r=>key(r.request())===original2.key);await retry.click();const replay=await answer;
   expect(replay.request().headers()['idempotency-key']).toBe(original2.key);expect(replay.request().headers()['if-match']).toBe(original2.ifMatch);expect(replay.request().postData()).toBe(original2.body);
   expect(replay.status()).toBe(original2.status);expect(await replay.text()).toBe(original2.answer);
  }else{
   evidence.recovery='captured replay';await expect(block).toContainText('店面使用中（第 2 版）');
   const replay=await b.page.request.post(exactPath,{data:original2.body,headers:await replayHeaders()});expect(replay.status()).toBe(original2.status);expect(await replay.text()).toBe(original2.answer);
  }
  await expect(block).toContainText('店面使用中（第 2 版）');const after2=await photoFacts(e2eAuthPool,b.store,productId);
  expect(after2.copies.map(copy=>copy.source_version_no)).toEqual([1,2]);expect(after2.copies.filter(copy=>!after1.copies.some(old=>old.asset_id===copy.asset_id))).toHaveLength(1);
  expect(after2.assets).toHaveLength(2);expect(after2.assets.filter(asset=>!after1.assets.some(old=>old.asset_id===asset.asset_id))).toHaveLength(1);
  expect(BigInt(after2.capacity)-BigInt(after1.capacity)).toBe(BigInt(after2.copies[1].byte_size));
  expect(BigInt(after2.capacity)-BigInt(bBefore.capacity)).toBe(after2.copies.reduce((sum,copy)=>sum+BigInt(copy.byte_size),0n));
  for(const copy of after2.copies)expect(copy).toMatchObject({tenant_ref:photoTenant(b.store),state:'ready'});
  expect(after2.pointers).toEqual([{asset_id:after2.copies[1].asset_id,version:'2'}]);
  const stale=await b.page.request.post(exactPath,{data:original2.body,headers:{...await replayHeaders(),'Idempotency-Key':randomUUID()}}),staleBody=await stale.json();
  expect(stale.status()).toBe(412);expect(staleBody.code).toBe('version_conflict');
  const conflict=await b.page.request.post(exactPath,{data:JSON.stringify({...JSON.parse(original2.body),version_id:randomUUID()}),headers:await replayHeaders()}),conflictBody=await conflict.json();
  expect(conflict.status()).toBe(409);expect(conflictBody.code).toBe('idempotency_conflict');
  expect(await photoFacts(e2eAuthPool,b.store,productId)).toEqual(after2);expect(await photoFacts(e2eAuthPool,b2,productId)).toEqual(b2Before);expect(await photoFacts(e2eAuthPool,c.store,productId)).toEqual(cBefore);
  evidence.counterexamples=[{status:stale.status(),code:staleBody.code},{status:conflict.status(),code:conflictBody.code}];
  evidence.facts={bBefore,after1,after2,b2Before,cBefore};evidence.dialogs=dialogs;await screenshot('original-use-recovered-once.png');
 }finally{
  await Promise.allSettled(pending.map(deliver=>deliver()));
  evidence.requests=requests.filter(r=>r.method()==='POST'&&new URL(r.url()).pathname.endsWith('/use')).map(r=>({path:new URL(r.url()).pathname,key:r.headers()['idempotency-key'],ifMatch:r.headers()['if-match'],body:r.postData()}));
  const evidencePath=info.outputPath('scope-switch-evidence.json');
  await (await import('node:fs/promises')).writeFile(evidencePath,JSON.stringify(evidence,null,2));
  await info.attach('scope-switch-evidence',{path:evidencePath,contentType:'application/json'});
  await withdrawPartnerOffers(e2eAuthPool,suppliers);await Promise.all(contexts.map(context=>context.close()));
 }
});

test('SC-E2E-78 a material upload answered after a business or account switch changes nothing there; the original attempt recovers to one version (AT-35)', async ({page, e2eAuthPool}, info) => {
  const suffix = randomUUID().slice(0, 6);
  const a = await setupMaterialSupplier(page, e2eAuthPool, `A1-${suffix}`);
  const a2Store = await launchStore(page, `合成素材空間 A2-${suffix}`);
  await post(page, `${a2Store.root}/supply-profile`, {name: `合成素材商品庫 A2-${suffix}`, currency: 'TWD'}, 201);
  const initial = await source(`initial-${suffix}.png`, '#325747');
  const first = await source(`business-original-${suffix}.png`, '#856342');
  const second = await source(`account-original-${suffix}.png`, '#764b85');
  const different = await source(`different-${suffix}.png`, '#457a96');
  type Store = {root: string; hash: string};
  async function seedMaterial(store: Store, title: string) {
    // Only the pre-existing materials are setup; both attempts below use the member controls.
    const material = await post(page, `${store.root}/supply-materials`, {kind: 'image', product_id: null, title, description: ''}, 201);
    const session = await (await page.request.get('/api/v1/session')).json();
    const response = await page.request.post(`/api/v1${store.root}/supply-materials/${material.material_id}/content`, {
      data: initial.buffer, headers: {Origin: new URL(page.url()).origin, 'X-CSRF-Token': session.csrf_token,
        'Content-Type': initial.mimeType, 'Idempotency-Key': randomUUID(), 'If-Match': `"${material.version}"`},
    });
    expect(response.status()).toBe(200);
    return {store, title, id: material.material_id as string, version: (await response.json()).version as string};
  }
  const m1 = await seedMaterial(a.store, `A1 素材 ${suffix}`);
  const m2 = await seedMaterial(a2Store, `A2 素材 ${suffix}`);
  await signOut(page);
  const z = await setupMaterialSupplier(page, e2eAuthPool, `Z1-${suffix}`);
  const mz = await seedMaterial(z.store, `Z1 素材 ${suffix}`);
  const section = (name: string) => materialActive(page).locator('.sc-section').filter({has: page.getByRole('heading', {level: 3, name, exact: true})});
  const upload = () => section('新版本');
  const uploadStatus = () => upload().locator('p.field-hint[role="status"]');
  const path = (m: typeof m1) => `/api/v1${m.store.root}/supply-materials/${m.id}/content`;
  async function enter(m: typeof m1, switchBusiness = false) {
    if (switchBusiness) await materialConsole(page).getByRole('link', {name: '切換事業', exact: true}).click();
    else await navigate(page, '我的供貨商品庫');
    await page.locator('.hosted-store article').filter({has: page.getByRole('heading', {level: 3, name: `合成素材商品庫 ${m === m1 ? 'A1' : m === m2 ? 'A2' : 'Z1'}-${suffix}`, exact: true})})
      .getByRole('link', {name: '查看商品與供貨', exact: true}).click();
    await materialConsole(page).getByRole('navigation', {name: '營運中心', exact: true}).getByRole('link', {name: '行銷素材', exact: true}).click();
    await materialActive(page).getByRole('link', {name: m.title, exact: true}).click();
    await expect(materialActive(page).getByRole('heading', {name: `素材詳情：${m.title}`, exact: true})).toBeVisible();
  }
  async function facts(m: typeof m1) {
    const tenant = m.store.hash.split('/')[1];
    const material = (await e2eAuthPool.query('SELECT aggregate_version::text AS version,current_version_id FROM supply_materials WHERE material_id=$1', [m.id])).rows[0];
    const versions = (await e2eAuthPool.query('SELECT version_id,version_no,asset_id FROM supply_material_versions WHERE material_id=$1 ORDER BY version_no', [m.id])).rows;
    const receipts = (await e2eAuthPool.query("SELECT idempotency_key,response FROM scoped_command_receipts WHERE target_id=$1 AND operation='storefront.supply-material.upload' ORDER BY idempotency_key", [m.id])).rows;
    const intents = (await e2eAuthPool.query('SELECT intent_id,asset_id,state,source_sha256,expected_version::text AS expected FROM asset_upload_intents WHERE target_material_id=$1 ORDER BY intent_id', [m.id])).rows;
    const assets = (await e2eAuthPool.query('SELECT a.asset_id,a.state,o.byte_size FROM assets a JOIN asset_upload_intents i USING(asset_id) LEFT JOIN asset_objects o USING(asset_id) WHERE i.target_material_id=$1 ORDER BY a.asset_id', [m.id])).rows;
    const effects = (await e2eAuthPool.query('SELECT e.effect_id,e.asset_id FROM asset_object_write_effects e JOIN asset_upload_intents i USING(asset_id) WHERE i.target_material_id=$1 ORDER BY e.effect_id', [m.id])).rows;
    // Same accounting as tenant capacity: old versions remain charged, unfinished images reserve 1 MiB.
    const capacity = (await e2eAuthPool.query(`SELECT COALESCE(sum(o.byte_size),0)::text AS used,
      COALESCE(sum(CASE WHEN o.asset_id IS NULL THEN COALESCE(i.reserved_bytes,CASE a.purpose
        WHEN 'storefront.product-photo' THEN 1048576 WHEN 'storefront.supply-material' THEN 1048576
        WHEN 'storefront.supply-material-video' THEN 20971520 ELSE 262144 END) ELSE 0 END),0)::text AS reserved
      FROM assets a LEFT JOIN asset_objects o USING(asset_id) LEFT JOIN asset_upload_intents i USING(asset_id)
      WHERE a.tenant_ref=$1 AND a.purpose IN ('work.tenant-result','storefront.product-photo','storefront.supply-material','storefront.supply-material-video')`, [tenant])).rows[0];
    const orphan = (await e2eAuthPool.query(`SELECT count(*)::int AS n FROM assets a JOIN asset_upload_intents i USING(asset_id)
      WHERE i.target_material_id=$1 AND a.state='ready' AND NOT EXISTS (SELECT 1 FROM supply_material_versions v WHERE v.asset_id=a.asset_id)`, [m.id])).rows[0].n;
    return {material, versions, receipts, intents, assets, effects, capacity, orphan};
  }
  const before = {a1: await facts(m1), a2: await facts(m2), z1: await facts(mz)};
  for (const [m, f] of [[m1, before.a1], [m2, before.a2], [mz, before.z1]] as const) {
    expect(f.material.version).toBe(m.version); expect(f.versions).toHaveLength(1);
  }
  const requests: Request[] = [];
  const failures: string[] = [];
  const delivery = new Map<string, string>();
  const requestKey = (request: Request) => request.headers()['idempotency-key'];
  page.on('response', response => delivery.set(requestKey(response.request()), `response ${response.status()}`));
  page.on('requestfailed', request => delivery.set(requestKey(request), `failed: ${request.failure()?.errorText}`));
  const observed: Record<string, unknown> = {initialVersions: [m1.version, m2.version, mz.version]};
  page.on('request', request => requests.push(request));
  async function hold() {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    let ready!: (value: {request: Request; response: import('@playwright/test').APIResponse}) => void;
    const committed = new Promise<{request: Request; response: import('@playwright/test').APIResponse}>(resolve => {ready = resolve;});
    let done!: () => void;
    const delivered = new Promise<void>(resolve => {done = resolve;});
    const handler = async (route: import('@playwright/test').Route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch();
      ready({request: route.request(), response});
      await gate;
      try {await route.fulfill({response});} catch (error) {failures.push(String(error));} finally {done();}
    };
    await page.route(`**${path(m1)}`, handler);
    return {committed, async deliver() {release(); await delivered; await page.unroute(`**${path(m1)}`, handler);}};
  }
  async function cleanScope(m: typeof m1) {
    await expect(materialActive(page).locator('.detail-list')).toContainText('第 1 版');
    await expect(section('版本紀錄').getByRole('listitem')).toHaveCount(1);
    await expect(uploadStatus()).toHaveCount(0);
    await expect(materialConsole(page).getByRole('button', {name: '重試原操作', exact: true})).toHaveCount(0);
    for (const file of [first, second]) await expect(materialConsole(page)).not.toContainText(file.name);
    await expect(materialConsole(page)).not.toContainText('已上傳新版本。');
    await expect(materialConsole(page)).not.toContainText('尚未確認上傳結果');
    await expect(materialConsole(page).locator('.sc-business-bar strong')).toHaveText(`合成素材商品庫 ${m === m2 ? 'A2' : 'Z1'}-${suffix}`);
  }
  async function screenshot(name: string) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({path: info.outputPath(name), fullPage: true});
  }
  const refusal = '尚未確認原操作的結果，請按「重試」確認後再離開。';
  await signOut(page); await loginHere(page, a.member.email); await enter(m1);
  const one = await hold();
  await upload().getByLabel('選擇圖片', {exact: true}).setInputFiles(first);
  await upload().getByRole('button', {name: '上傳新版本', exact: true}).click();
  const answer1 = await one.committed;
  const sig1 = signature(answer1.request);
  expect(answer1.response.status()).toBe(200); expect(sig1.version).toBe(`"${m1.version}"`);
  expect(sig1.key).toBeTruthy(); expect(sig1.mime).toBe(first.mimeType); expect(sig1.sha256).toBe(digest(first.buffer));
  await expect(uploadStatus()).toHaveText('正在上傳新版本…');
  const urlA1 = page.url(), requestMark = requests.length;
  await materialConsole(page).getByRole('link', {name: '切換事業', exact: true}).click();
  // Material uploads currently use the material-blocking notice even in their sending phase.
  await expect(materialConsole(page).locator('.sc-announcement')).toHaveText(refusal);
  await expect(page).toHaveURL(urlA1);
  await expect(materialConsole(page).locator('.sc-business-bar strong')).toHaveText(`合成素材商品庫 A1-${suffix}`);
  expect(requests.slice(requestMark).filter(r => new URL(r.url()).pathname.startsWith(`/api/v1${a2Store.root}`))).toHaveLength(0);
  observed.businessRefusal = await materialConsole(page).locator('.sc-announcement').innerText();
  await screenshot('material-business-switch-refused.png');
  await one.deliver();
  await expect(uploadStatus()).toHaveText('已上傳新版本。');
  await expect(section('版本紀錄').getByRole('listitem')).toHaveCount(2);
  await expect(materialActive(page).locator('.detail-list')).toContainText('第 2 版');
  const after1 = await facts(m1);
  await enter(m2, true); await cleanScope(m2); expect(await facts(m2)).toEqual(before.a2);
  await screenshot('material-a2-unaffected.png');

  await enter(m1, true);
  const staleVersion = (await facts(m1)).material.version;
  const two = await hold();
  await upload().getByLabel('選擇圖片', {exact: true}).setInputFiles(second);
  await upload().getByRole('button', {name: '上傳新版本', exact: true}).click();
  const answer2 = await two.committed;
  const sig2 = signature(answer2.request), body2 = answer2.request.postDataBuffer()!;
  expect(answer2.response.status()).toBe(200); expect(sig2.version).toBe(`"${staleVersion}"`);
  expect(sig2.key).toBeTruthy(); expect(sig2.key).not.toBe(sig1.key);
  expect(sig2.mime).toBe(second.mimeType); expect(sig2.sha256).toBe(digest(second.buffer));
  await expect(uploadStatus()).toHaveText('正在上傳新版本…');
  const dialogs: string[] = [];
  const accept = async (dialog: import('@playwright/test').Dialog) => {dialogs.push(dialog.message()); await dialog.accept();};
  page.on('dialog', accept);
  const settings = page.getByRole('button', {name: '設定', exact: true});
  await settings.click();
  await page.getByRole('menu', {name: '個人檔案', exact: true}).getByRole('menuitem', {name: '登出', exact: true}).click();
  const loginHeading = page.getByRole('heading', {name: '登入', exact: true});
  if (!await loginHeading.isVisible()) {
    await expect(materialConsole(page).locator('.sc-announcement')).toHaveText(refusal);
    await expect(page).toHaveURL(urlA1);
    observed.signOut = {possibleWhileSending: false, refusal: await materialConsole(page).locator('.sc-announcement').innerText(), dialogs};
    await screenshot('material-signout-refused.png');
    const expired = await e2eAuthPool.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now()", [a.member.id]);
    expect(expired.rowCount).toBe(1);
    const unauthorized = page.waitForResponse(r => r.status() === 401 && new URL(r.url()).pathname === path(m1).replace(/\/content$/, ''));
    await materialActive(page).locator('.sc-read-status').first().getByRole('button', {name: '更新資料', exact: true}).click();
    expect((await unauthorized).status()).toBe(401);
  } else observed.signOut = {possibleWhileSending: true, dialogs};
  page.off('dialog', accept);
  await expect(loginHeading).toBeVisible(); await expect(materialConsole(page)).toHaveCount(0);
  await loginHere(page, z.member.email); await enter(mz);
  await cleanScope(mz);
  const zURL = page.url();
  // Response delivery is correlated with the captured original operation, including an earlier browser failure.
  const lateFinished = delivery.has(sig2.key) ? Promise.resolve(delivery.get(sig2.key)) : Promise.race([
    page.waitForResponse(r => requestKey(r.request()) === sig2.key).then(r => `response ${r.status()}`),
    page.waitForEvent('requestfailed', {predicate: r => requestKey(r) === sig2.key}).then(r => `failed: ${r.failure()?.errorText}`),
  ]);
  await two.deliver();
  observed.lateAnswer = {network: failures.length ? 'fulfill threw; late answer could not reach the page' : await lateFinished, fulfillErrors: failures};
  await expect(page).toHaveURL(zURL); await cleanScope(mz);
  expect(requests.filter(r => r.method() === 'POST' && new URL(r.url()).pathname === path(mz))).toHaveLength(0);
  expect(await facts(mz)).toEqual(before.z1); expect(await facts(m2)).toEqual(before.a2);
  await screenshot('material-z1-after-late-answer.png');

  await signOut(page); await loginHere(page, a.member.email); await enter(m1);
  const retry = upload().getByRole('button', {name: '重試原操作', exact: true});
  const receipt2 = await answer2.response.json();
  if (await retry.isVisible()) {
    observed.recovery = '重試原操作';
    await expect(upload()).toContainText(second.name);
    const replayRequest = page.waitForRequest(r => r.method() === 'POST' && new URL(r.url()).pathname === path(m1));
    const replayAnswer = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === path(m1));
    await retry.click();
    expect(signature(await replayRequest)).toEqual(sig2);
    const response = await replayAnswer;
    expect(response.status()).toBe(answer2.response.status()); expect(await response.json()).toEqual(receipt2);
    await expect(uploadStatus()).toHaveText('已上傳新版本。');
  } else {
    observed.recovery = 'captured replay';
    await expect(section('版本紀錄').getByRole('listitem')).toHaveCount(3);
    const session = await (await page.request.get('/api/v1/session')).json();
    const replay = await page.request.post(path(m1), {data: body2, headers: {Origin: new URL(page.url()).origin,
      'X-CSRF-Token': session.csrf_token, 'Content-Type': sig2.mime, 'Idempotency-Key': sig2.key, 'If-Match': sig2.version}});
    expect(replay.status()).toBe(answer2.response.status()); expect(await replay.json()).toEqual(receipt2);
  }
  await expect(section('版本紀錄').getByRole('listitem')).toHaveCount(3);
  await expect(materialActive(page).locator('.detail-list')).toContainText('第 3 版');
  await screenshot('material-original-attempt-recovered.png');
  const after2 = await facts(m1);
  for (const [prior, current, sig, receipt] of [
    [before.a1, after1, sig1, await answer1.response.json()], [after1, after2, sig2, receipt2],
  ] as const) {
    expect(current.versions).toHaveLength(prior.versions.length + 1);
    const added = current.versions.filter(v => !prior.versions.some(p => p.version_id === v.version_id));
    expect(added).toHaveLength(1);
    const asset = added[0].asset_id;
    expect(current.receipts.filter(r => r.idempotency_key === sig.key)).toEqual([{idempotency_key: sig.key, response: receipt}]);
    expect(current.receipts).toHaveLength(prior.receipts.length + 1);
    expect(current.intents).toHaveLength(prior.intents.length + 1);
    expect(current.intents.filter(i => i.asset_id === asset)).toEqual([expect.objectContaining({state: 'finalized', source_sha256: sig.sha256, expected: sig.version.replaceAll('"', '')})]);
    expect(current.effects).toHaveLength(prior.effects.length + 1);
    expect(current.effects.filter(e => e.asset_id === asset)).toHaveLength(1);
    expect(current.assets).toHaveLength(prior.assets.length + 1); expect(current.orphan).toBe(0);
    const addedAsset = current.assets.find(a => a.asset_id === asset)!;
    expect(addedAsset.state).toBe('ready');
    expect(BigInt(current.capacity.used) - BigInt(prior.capacity.used)).toBe(BigInt(addedAsset.byte_size));
    expect(current.capacity.reserved).toBe('0');
  }
  const session = await (await page.request.get('/api/v1/session')).json();
  const headers = {Origin: new URL(page.url()).origin, 'X-CSRF-Token': session.csrf_token,
    'Content-Type': sig2.mime, 'If-Match': sig2.version};
  const stale = await page.request.post(path(m1), {data: body2, headers: {...headers, 'Idempotency-Key': randomUUID()}});
  const staleProblem = await stale.json();
  expect(stale.status()).toBe(412); expect(staleProblem.code).toBe('version_conflict');
  const changed = await page.request.post(path(m1), {data: different.buffer, headers: {...headers, 'Idempotency-Key': sig2.key}});
  const changedProblem = await changed.json();
  expect(changed.status()).toBe(409); expect(changedProblem.code).toBe('idempotency_conflict');
  expect(await facts(m1)).toEqual(after2); expect(await facts(m2)).toEqual(before.a2); expect(await facts(mz)).toEqual(before.z1);
  expect(requests.filter(r => r.method() === 'POST' && new URL(r.url()).pathname === path(m2))).toHaveLength(0);
  observed.counterexamples = [{status: stale.status(), code: staleProblem.code}, {status: changed.status(), code: changedProblem.code}];
  const evidence = info.outputPath('material-switch-evidence.json');
  await writeFile(evidence, JSON.stringify({observed, signatures: [sig1, sig2], before, after1, after2}, null, 2));
  await info.attach('material-switch-evidence', {path: evidence, contentType: 'application/json'});
});

async function draftWebp() {
  return sharp({create:{width:12,height:8,channels:3,background:'#234863'}}).webp().toBuffer();
}

function isExpectedBrowserAbort(error:unknown, request:Request): boolean {
  const failure = request.failure()?.errorText ?? '';
  if (failure === 'net::ERR_ABORTED') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /net::ERR_ABORTED|Request aborted/.test(message);
}

function privateProjection(store:{hash:string;root:string}, productId:string, sku:string, title:string, bytes:Buffer) {
  const [tenant, instance] = store.hash.split('/').slice(1);
  const readPath = `/api/v1/tenants/${tenant}/storefronts/${instance}/distribution-photos/${productId}/photo/1`;
  const list = DistributionPhotosSchema.parse({items:[{
    product_id:productId, sku, title, version:'1', state:'source_unavailable',
    photo:{content_type:'image/webp', byte_size:bytes.length, width:12, height:8, read_path:readPath},
    source:null, latest:null,
  }]});
  const materials = PartnerMaterialsSchema.parse({
    profile:'freedom.partner-materials/v1', tenant_id:tenant, instance_id:instance, as_of:'2026-10-16T12:00:00.000Z',
    items:[{
      material_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', kind:'image', supplier_name:'合成供應商',
      subject:{kind:'brand'}, applies_to:[productId], title:'合成公開素材', description:'', access:'public_use',
      current:{
        version_id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc', version_no:1, created_at:'2026-10-16T12:00:00.000Z',
        content:{kind:'image', content_type:'image/webp', byte_size:bytes.length, width:12, height:8},
      },
    }],
    truncated:false,
  });
  return {list, materials, readPath, listPath:`/api/v1${store.root}/distribution-photos`, materialsPath:`/api/v1${store.root}/partner-materials`};
}

test('SC-E2E-82 a denied distribution-photo read clears the private projection; an authorized unavailable source stays', async ({page, e2eAuthPool}) => {
  const suffix = randomUUID().slice(0, 6);
  const s = await ready(page, e2eAuthPool);
  const title = `私有草稿 ${suffix}`;
  const bytes = await draftWebp();
  const projection = privateProjection(s, s.product.product_id, s.product.sku, title, bytes);
  const posts: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.includes('/distribution-photos')) posts.push(new URL(request.url()).pathname);
  });
  let listStatus: 200 | 403 | 404 = 200;
  await page.route(url => {
    const path = new URL(url).pathname;
    return path === projection.listPath || path === projection.materialsPath || path === projection.readPath;
  }, async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') return route.continue();
    if (path === projection.readPath) return route.fulfill({status:200, contentType:'image/webp', body:bytes});
    if (path === projection.materialsPath) return route.fulfill({status:200, contentType:'application/json', body:JSON.stringify(projection.materials)});
    if (listStatus === 200) return route.fulfill({status:200, contentType:'application/json', body:JSON.stringify(projection.list)});
    return route.fulfill({status:listStatus, contentType:'application/json', body:JSON.stringify({type:'about:blank', title:'denied', status:listStatus, code:'forbidden', detail:'合成讀取被拒'})});
  });
  await storeArea(page, '供貨合作');
  const panel = sellerPartnerMaterials(page);
  await expect(panel.getByText(title, {exact:true})).toBeVisible();
  await expect(panel.getByText('合成公開素材')).toBeVisible();
  await expect(panel.locator('img.distribution-photo-thumb')).toHaveCount(2);
  await expect.poll(() => panel.locator('img.distribution-photo-thumb').first().evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(12);
  await expect(panel.getByRole('button', {name:'停止使用', exact:true}).first()).toBeEnabled();
  await panel.getByRole('button', {name:'改用這個素材', exact:true}).click();
  const dialog = page.getByRole('dialog', {name:'把這張素材用在公開店面？', exact:true});
  await expect(dialog).toContainText(title);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', {name:'取消', exact:true}).click();
  await expect(dialog).toBeHidden();
  const cleared = async () => {
    await expect(panel.getByText(title)).toHaveCount(0);
    await expect(panel.locator('img.distribution-photo-thumb')).toHaveCount(0);
    await expect(panel.getByRole('button', {name:'停止使用', exact:true})).toHaveCount(0);
    await expect(panel.getByRole('button', {name:'改用這個素材', exact:true})).toHaveCount(0);
    await expect(dialog).toBeHidden();
    await expect(panel.getByRole('alert')).toContainText('目前無法讀取店面照片');
    await expect(panel.getByText('合成公開素材')).toBeVisible();
  };
  listStatus = 403;
  await panel.getByRole('button', {name:'重新整理', exact:true}).click();
  await cleared();
  listStatus = 200;
  await panel.getByRole('button', {name:'重試', exact:true}).click();
  await expect(panel.getByText(title, {exact:true})).toBeVisible();
  await expect.poll(() => panel.locator('img.distribution-photo-thumb').first().evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(12);
  listStatus = 404;
  await panel.getByRole('button', {name:'重新整理', exact:true}).click();
  await cleared();
  expect(posts).toEqual([]);
});

test('SC-E2E-83 a transient distribution-photo failure keeps the draft, and a late read cannot restore it in another scope', async ({page, e2eAuthPool}) => {
  const suffix = randomUUID().slice(0, 6);
  const s = await ready(page, e2eAuthPool);
  const other = await launchStore(page, `另一空間 ${suffix}`);
  await post(page, `${other.root}/setup`, {name:`另一商店 ${suffix}`, slug:`other-${suffix}`, currency:'TWD'}, 201);
  const title = `私有草稿 ${suffix}`;
  const bytes = await draftWebp();
  const projection = privateProjection(s, s.product.product_id, s.product.sku, title, bytes);
  // Synthetic HTTP projection/media on a real shop; this checks the client lifetime, not server revocation.
  type Settlement = {kind:'response'; status:number} | {kind:'aborted'; error:string};
  const held: Array<{url:string; settlement:Promise<Settlement>}> = [];
  let listMode: 'ok' | '503' | 'hold' = 'ok';
  let waitHold = Promise.resolve();
  let releaseHold: (() => void) | undefined;
  const release = () => { const done = releaseHold; releaseHold = undefined; done?.(); };
  const armHold = () => {
    listMode = 'hold';
    held.length = 0;
    waitHold = new Promise(resolve => { releaseHold = resolve; });
  };
  try {
    await page.route(url => {
      const path = new URL(url).pathname;
      return path === projection.listPath || path === projection.materialsPath || path === projection.readPath;
    }, async route => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() !== 'GET') return route.continue();
      if (path === projection.readPath) return route.fulfill({status:200, contentType:'image/webp', body:bytes});
      if (path === projection.materialsPath) return route.fulfill({status:200, contentType:'application/json', body:JSON.stringify(projection.materials)});
      if (listMode === 'hold') {
        const request = route.request();
        const gate = waitHold;
        const settlement = new Promise<Settlement>(resolve => {
          const clean = () => { page.off('requestfinished', finished); page.off('requestfailed', failed); };
          const finished = async (seen:Request) => {
            if (seen !== request) return;
            clean(); resolve({kind:'response', status:(await request.response())!.status()});
          };
          const failed = (seen:Request) => {
            if (seen !== request) return;
            clean(); resolve({kind:'aborted', error:request.failure()!.errorText});
          };
          page.on('requestfinished', finished); page.on('requestfailed', failed);
        });
        held.push({url:request.url(), settlement});
        try {
          await gate;
          await route.fulfill({status:200, contentType:'application/json', body:JSON.stringify(projection.list)});
        } catch (error) {
          if (isExpectedBrowserAbort(error, request)) {
            return;
          }
          throw error;
        }
        return;
      }
      if (listMode === '503') return route.fulfill({status:503, contentType:'application/json', body:JSON.stringify({type:'about:blank', title:'unavailable', status:503, code:'unavailable', detail:'合成暫時失敗'})});
      return route.fulfill({status:200, contentType:'application/json', body:JSON.stringify(projection.list)});
    });
    await storeArea(page, '供貨合作');
    const panel = sellerPartnerMaterials(page);
    const thumb = () => panel.locator('img.distribution-photo-thumb').first();
    await expect(panel.getByText(title, {exact:true})).toBeVisible();
    await expect.poll(() => thumb().evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(12);
    listMode = '503';
    await panel.getByRole('button', {name:'重新整理', exact:true}).click();
    await expect(panel.getByRole('alert')).toContainText('目前無法讀取店面照片');
    await expect(panel.getByText(title, {exact:true})).toBeVisible();
    await expect.poll(() => thumb().evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(12);
    listMode = 'ok';
    await panel.getByRole('button', {name:'重試', exact:true}).click();
    await expect(panel.getByRole('alert')).toHaveCount(0);
    await expect(panel.getByText(title, {exact:true})).toBeVisible();
    armHold();
    await panel.getByRole('button', {name:'重新整理', exact:true}).click();
    await expect.poll(() => held.length).toBeGreaterThan(0);
    await page.getByRole('link', {name:'返回我的商店', exact:true}).click();
    await page.locator(`a[href="#${other.hash}"]`).click();
    await expect(page.locator('.hosted-store')).toBeVisible();
    await storeArea(page, '供貨合作');
    await expect(page.getByText(title)).toHaveCount(0);
    listMode = 'ok';
    const businessHeld = held.slice();
    release();
    const businessOutcome = await Promise.all(businessHeld.map(item => item.settlement));
    console.log(`SC83-business ${JSON.stringify(businessOutcome)}`);
    await expect(page.getByText(title)).toHaveCount(0);
    await expect(page.locator('img.distribution-photo-thumb')).toHaveCount(0);
    await expect(sellerPartnerMaterials(page)).toContainText('目前沒有供應商授權給這間店的素材');
    await photoStoreFromList(page, s);
    await storeArea(page, '供貨合作');
    await expect(sellerPartnerMaterials(page).getByText(title, {exact:true})).toBeVisible();
    armHold();
    await sellerPartnerMaterials(page).getByRole('button', {name:'重新整理', exact:true}).click();
    await expect.poll(() => held.length).toBeGreaterThan(0);
    await signOut(page);
    await expect(page.getByRole('heading', {name:'登入', exact:true})).toBeVisible();
    await expect(page.getByText(title)).toHaveCount(0);
    listMode = 'ok';
    const sessionHeld = held.slice();
    release();
    const sessionOutcome = await Promise.all(sessionHeld.map(item => item.settlement));
    console.log(`SC83-session ${JSON.stringify(sessionOutcome)}`);
    await expect(page.getByText(title)).toHaveCount(0);
    const stranger = await person(e2eAuthPool);
    await loginHere(page, stranger.email);
    await expect(page.getByText(title)).toHaveCount(0);
    await expect(page.locator('img.distribution-photo-thumb')).toHaveCount(0);
  } finally {
    release();
    await page.unrouteAll({behavior:'wait'});
  }
});

test('SC-E2E-84 a malformed committed use or detach ack keeps the original attempt and one copy', async ({page, browser, baseURL, e2eAuthPool}) => {
  const suffix = randomUUID().slice(0, 6);
  const extra: Array<{close: () => Promise<void>}> = [];
  const suppliers: string[] = [];
  try {
    const sup = await setupSupplierWithOfferForPartnerMedia(page, e2eAuthPool, suffix);
    suppliers.push(sup.member.id);
    const productTitle = sup.offer.terms.title;
    const seller = await openPartnerStore(browser, baseURL, e2eAuthPool, `畸形回條賣家 ${suffix}`, `ack-${suffix}`);
    extra.push(seller.ctx);
    await photoAccept(seller.page, page, seller.store.root, sup.store.root, sup.offer);
    const matTitle = `回條素材 ${suffix}`;
    await createFileMaterialInConsole(page, sup.store, 'image', matTitle, sup.product.product_id);
    await uploadImageVersionInConsole(page, `ack-v1-${suffix}.png`, '#3b5998');
    await setMaterialAccessInConsole(page, 'public_use');
    await grantMaterialToAllSellableInConsole(page);
    await open(seller.page, seller.store.hash);
    await storeArea(seller.page, '供貨合作');
    const block = partnerPhotoBlock(seller.page, matTitle, productTitle);
    await expect(block.getByRole('button', {name:'用於公開店面', exact:true})).toBeEnabled();
    const productId = sup.product.product_id;
    const baseline = await photoFacts(e2eAuthPool, seller.store, productId);
    expect(baseline.copies).toEqual([]);
    expect(baseline.pointers).toEqual([]);
    const usePath = `/api/v1${seller.store.root}/distribution-photos/${productId}/use`;
    const detachPath = `/api/v1${seller.store.root}/distribution-photos/${productId}/detach`;
    const captured: Array<{key:string; ifMatch:string; body:string}> = [];
    let originalUse = '';
    let mangleUse = true;
    await seller.page.route(`**${usePath}`, async route => {
      const req = route.request();
      if (req.method() !== 'POST') return route.continue();
      captured.push({key:req.headers()['idempotency-key'] ?? '', ifMatch:req.headers()['if-match'] ?? '', body:req.postData() ?? ''});
      if (!mangleUse) return route.continue();
      mangleUse = false;
      const response = await route.fetch();
      originalUse = await response.text();
      expect(response.status()).toBe(200);
      const json = JSON.parse(originalUse) as {version:string};
      json.version = 'abc';
      await route.fulfill({status:200, contentType:'application/json', body:JSON.stringify(json)});
    });
    await block.getByRole('button', {name:'用於公開店面', exact:true}).click();
    await seller.page.getByRole('dialog', {name:'把這張素材用在公開店面？', exact:true}).getByRole('button', {name:'複製並使用', exact:true}).click();
    await expect(seller.page.locator('.hosted-store > [role="alert"]')).toHaveText('尚未確認原操作的結果，請按「重試」確認。');
    const retry = seller.page.locator('.hosted-store > .actions').getByRole('button', {name:'重試', exact:true});
    await expect(retry).toBeVisible();
    await expect(block.getByRole('button', {name:'用於公開店面', exact:true})).toBeDisabled();
    const stayed = seller.page.url();
    await seller.page.getByRole('link', {name:'返回我的商店', exact:true}).click();
    await expect(seller.page.locator('.hosted-store > [role="status"]')).toContainText('尚未確認原操作的結果，請按「重試」確認後再離開。');
    await expect(seller.page).toHaveURL(stayed);
    expect(captured).toHaveLength(1);
    expect(captured[0].key).toBeTruthy();
    expect(captured[0].ifMatch).toBe('"0"');
    const beforeRetry = await photoFacts(e2eAuthPool, seller.store, productId);
    expect(beforeRetry.copies).toHaveLength(1);
    expect(beforeRetry.pointers).toEqual([{asset_id:beforeRetry.copies[0].asset_id, version:'1'}]);
    expect(beforeRetry.assets).toHaveLength(baseline.assets.length + 1);
    expect(beforeRetry.assets.map(row => row.asset_id)).toContain(beforeRetry.copies[0].asset_id);
    expect(BigInt(beforeRetry.capacity) - BigInt(baseline.capacity)).toBe(BigInt(beforeRetry.copies[0].byte_size));
    const replay = seller.page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === usePath);
    await retry.click();
    const replayed = await replay;
    expect(replayed.request().headers()['idempotency-key']).toBe(captured[0].key);
    expect(replayed.request().headers()['if-match']).toBe(captured[0].ifMatch);
    expect(replayed.request().postData()).toBe(captured[0].body);
    expect(replayed.status()).toBe(200);
    expect(await replayed.text()).toBe(originalUse);
    await expect(block.locator('.badge')).toHaveText('店面使用中（第 1 版）');
    const afterUse = await photoFacts(e2eAuthPool, seller.store, productId);
    expect(afterUse).toEqual(beforeRetry);
    let originalDetach = '';
    let mangleDetach = true;
    const detachCaptured: Array<{key:string; ifMatch:string; body:string}> = [];
    await seller.page.route(`**${detachPath}`, async route => {
      const req = route.request();
      if (req.method() !== 'POST') return route.continue();
      detachCaptured.push({key:req.headers()['idempotency-key'] ?? '', ifMatch:req.headers()['if-match'] ?? '', body:req.postData() ?? ''});
      if (!mangleDetach) return route.continue();
      mangleDetach = false;
      const response = await route.fetch();
      originalDetach = await response.text();
      expect(response.status()).toBe(200);
      const json = JSON.parse(originalDetach) as {current:{version:string}};
      json.current.version = '1.2';
      await route.fulfill({status:200, contentType:'application/json', body:JSON.stringify(json)});
    });
    await block.getByRole('button', {name:'停止使用', exact:true}).click();
    await expect(seller.page.locator('.hosted-store > [role="alert"]')).toHaveText('尚未確認原操作的結果，請按「重試」確認。');
    await expect(block.getByRole('button', {name:'停止使用', exact:true})).toBeDisabled();
    expect(detachCaptured).toHaveLength(1);
    expect(detachCaptured[0].ifMatch).toBe('"1"');
    expect(detachCaptured[0].body).toBe('{}');
    const beforeDetachRetry = await photoFacts(e2eAuthPool, seller.store, productId);
    expect(beforeDetachRetry.copies).toEqual(afterUse.copies);
    expect(beforeDetachRetry.assets).toEqual(afterUse.assets);
    expect(beforeDetachRetry.capacity).toBe(afterUse.capacity);
    expect(beforeDetachRetry.pointers).toEqual([{asset_id:null, version:'2'}]);
    const detachReplay = seller.page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === detachPath);
    await seller.page.locator('.hosted-store > .actions').getByRole('button', {name:'重試', exact:true}).click();
    const detached = await detachReplay;
    expect(detached.request().headers()['idempotency-key']).toBe(detachCaptured[0].key);
    expect(detached.request().headers()['if-match']).toBe('"1"');
    expect(detached.request().postData()).toBe('{}');
    expect(await detached.text()).toBe(originalDetach);
    const afterDetach = await photoFacts(e2eAuthPool, seller.store, productId);
    expect(afterDetach).toEqual(beforeDetachRetry);
    expect(captured.filter(item => item.key === captured[0].key)).toHaveLength(2);
    expect(detachCaptured).toHaveLength(2);
  } finally {
    await withdrawPartnerOffers(e2eAuthPool, suppliers);
    await Promise.all(extra.map(ctx => ctx.close()));
  }
});
