import {storeArea} from './hosted-store-fixture.js';
import {LIVE_PUBLIC_ORIGIN} from '../../apps/platform-api/src/routes/published-skills.js';
import {createHash,randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {test,expect,type Page,type Request} from './fixtures.js';
import {person,login,open,post,launchStore} from './hosted-store-fixture.js';
import {signOut} from './navigation.js';
import {DEMO_PASSWORD} from '../../packages/testing/seed.js';
import {ProductViewSchema} from '../../contracts/guild-launchpad/v1/storefront.js';
import {ProductMediaCommandSchema,PublicStoreMediaSchema} from '../../contracts/guild-launchpad/v1/hosted-store-media.js';

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
