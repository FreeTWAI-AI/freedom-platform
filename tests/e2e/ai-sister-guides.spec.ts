import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {test,expect,type Page,type Locator} from './fixtures.js';
import {navigate,signOut} from './navigation.js';
import {quickJoin} from './quick-join.js';
const manifest=JSON.parse(readFileSync(new URL('../../contracts/guide-packs/ai-sister-v1-20261005.json',import.meta.url),'utf8')) as {version:string;assets:{logicalId:string;sha256:string}[]};
import {AI_SISTER_RELEASE_PIN} from '../../apps/portal-web/src/modules/newcomer-guides/ai-sister-release-pin.js';
const widget=(page:Page)=>page.locator('.page-spirit-widget');
const panel=(page:Page)=>page.locator('.page-spirit-panel');
const asset=(logicalId:string)=>`/public/guide-packs/ai-sister/${manifest.version}/${manifest.assets.find(asset=>asset.logicalId===logicalId)!.sha256}.webp`;

async function registerJoined(page:Page,profile='guide-ai-sister'){
  await page.addInitScript(profile=>{if(localStorage.getItem('freedom-theme')===null)localStorage.setItem('freedom-theme',profile)},profile);
  await page.context().route(url=>!['127.0.0.1','localhost'].includes(url.hostname),route=>route.abort());
  await page.goto('/');await page.getByRole('button',{name:'建立帳號',exact:true}).click();
  await page.getByLabel('社群顯示名稱',{exact:true}).fill('AI Sister 導覽驗證');
  await page.getByLabel('電子郵件',{exact:true}).fill(`ai-sister-${randomUUID()}@example.test`);
  await page.getByLabel('密碼',{exact:true}).fill(`Fixture-A1!-${randomUUID()}`);
  await page.getByRole('button',{name:'建立帳號，先逛工坊',exact:true}).click();
  await expect(widget(page)).toHaveCount(0);
  await page.getByLabel('找感興趣的公會').fill('AI 開發公會');await quickJoin(page);
  await expect(page.getByRole('heading',{name:'會員首頁',level:1,exact:true})).toBeVisible();
  if(profile==='guide-ai-sister')await expect(widget(page)).toHaveAttribute('data-character-id','claude');
}
async function openGuide(page:Page){
  await widget(page).getByRole('button',{name:'問本頁',exact:true}).click();
  await expect(widget(page)).toHaveAttribute('data-load-state','ready');
  const skip=panel(page).getByRole('button',{name:'顯示全文',exact:true});if(await skip.isVisible())await skip.click();
}
async function selectTheme(page:Page,label:string){
  const settings=page.getByRole('button',{name:'設定',exact:true});
  if(await settings.getAttribute('aria-expanded')!=='true')await settings.click();
  await page.getByRole('menuitemradio',{name:label,exact:true}).click();await page.keyboard.press('Escape');
}
async function imageReady(image:Locator){
  await expect(image).toBeVisible();
  await expect.poll(()=>image.evaluate(element=>(element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
}
async function fits(page:Page,target:Locator,flow=false){
  const rect=await target.boundingBox(),viewport=page.viewportSize()!;expect(rect).not.toBeNull();
  expect(rect!.x).toBeGreaterThanOrEqual(0);
  expect(rect!.x+rect!.width).toBeLessThanOrEqual(viewport.width+1);
  if(!flow){expect(rect!.y).toBeGreaterThanOrEqual(0);expect(rect!.y+rect!.height).toBeLessThanOrEqual(viewport.height+1)}
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
}

test('member selects one character; it persists across reload and changes outfits with pages without fetching the library',async({page})=>{
  await page.emulateMedia({reducedMotion:'reduce'});
  const art:string[]=[],dragon:string[]=[];
  page.on('request',request=>{const path=new URL(request.url()).pathname;if(path.startsWith('/public/guide-packs/ai-sister/'))art.push(path);if(path.startsWith('/public/guide-packs/dragon/'))dragon.push(path)});
  await registerJoined(page);await imageReady(page.locator('.page-spirit-launcher img'));
  expect(new Set(art)).toEqual(new Set([asset('claude/education-outfit')]));
  await expect(widget(page)).toHaveAttribute('data-inline','true');await expect(panel(page)).toHaveCount(0);
  await expect(widget(page).getByRole('combobox',{name:'導覽角色'})).toHaveCount(0);
  await widget(page).getByRole('button',{name:'換角色',exact:true}).click();
  await expect(widget(page).getByRole('combobox',{name:'導覽角色'}).locator('option')).toHaveCount(17);
  await widget(page).getByRole('combobox',{name:'導覽角色'}).selectOption('kimi');
  await expect(widget(page)).toHaveAttribute('data-character-id','kimi');await expect(widget(page)).toHaveAttribute('data-open','false');
  await expect(widget(page).getByRole('combobox',{name:'導覽角色'})).toHaveCount(0);
  await expect(widget(page).getByRole('button',{name:'換角色',exact:true})).toBeFocused();
  await expect(widget(page)).toHaveAttribute('data-load-state','idle');
  await expect(widget(page)).toHaveAttribute('data-outfit-id','education');
  await expect(widget(page).locator('.page-spirit-art')).toHaveAttribute('src',asset('kimi/education-outfit'));
  await openGuide(page);
  await expect(panel(page).locator('.page-spirit-line')).toContainText('我是 Kimi。');
  await panel(page).getByRole('button',{name:'結束交談',exact:true}).click();
  await navigate(page,'我的工作');await expect(widget(page)).toHaveAttribute('data-character-id','kimi');
  await expect(widget(page)).toHaveAttribute('data-outfit-id','workplace');await openGuide(page);
  await expect(widget(page).locator('.page-spirit-art')).toHaveAttribute('src',asset('kimi/workplace-outfit'));
  await panel(page).getByRole('button',{name:'結束交談',exact:true}).click();await navigate(page,'會員首頁');
  await expect(widget(page)).toHaveAttribute('data-character-id','kimi');await expect(widget(page)).toHaveAttribute('data-open','false');
  await page.reload();await expect(widget(page)).toHaveAttribute('data-character-id','kimi');
  expect(await page.evaluate(()=>localStorage.getItem('freedom-ai-sister-character'))).toBe('kimi');
  expect(new Set(art)).toEqual(new Set([asset('claude/education-outfit'),asset('kimi/education-outfit'),asset('kimi/workplace-outfit')]));
  expect(dragon).toEqual([]);
});

test('wardrobe gallery offers all characters, 20 outfits and real poses; only selected images load and Escape restores focus',async({page})=>{
  await page.emulateMedia({reducedMotion:'reduce'});await registerJoined(page);await openGuide(page);
  const images:string[]=[];page.on('request',request=>{if(request.url().includes('/public/guide-packs/ai-sister/'))images.push(new URL(request.url()).pathname)});
  await panel(page).getByRole('button',{name:'角色圖鑑',exact:true}).click();
  const gallery=page.getByRole('dialog',{name:'AI Sister角色圖鑑',exact:true});await expect(gallery).toBeVisible();
  await expect(gallery.getByRole('combobox',{name:'角色',exact:true}).locator('option')).toHaveCount(17);
  await expect(gallery.getByRole('combobox',{name:'服裝',exact:true}).locator('option')).toHaveCount(20);
  await expect(gallery.getByRole('combobox',{name:'服裝',exact:true})).toHaveValue('education');
  await gallery.getByRole('combobox',{name:'角色',exact:true}).selectOption('venice');
  await gallery.getByRole('combobox',{name:'服裝',exact:true}).selectOption('festival');
  await imageReady(gallery.locator('img'));await expect(gallery.locator('img')).toHaveAttribute('src',asset('venice/festival-outfit'));
  for(const [label,pose] of [['鼓勵','supported'],['思考','challenged'],['開心','victory']] as const){
    await gallery.getByRole('button',{name:label,exact:true}).click();await imageReady(gallery.locator('img'));await expect(gallery.locator('img')).toHaveAttribute('src',asset(`venice/festival-${pose}`));
  }
  expect(new Set(images).size).toBeLessThanOrEqual(6);expect(await gallery.textContent()).not.toContain('mars-tw');
  await expect(gallery.getByRole('link',{name:'AI-Sister.com'})).toHaveAttribute('href','https://ai-sister.com');
  await page.keyboard.press('Escape');await expect(gallery).toHaveCount(0);
  await expect(panel(page).getByRole('button',{name:'角色圖鑑',exact:true})).toBeFocused();
  await expect(widget(page)).toHaveAttribute('data-character-id','claude');
});

test('current outfit uses real dialogue reactions and cleans guide focus when changing profile or losing member access',async({page})=>{
  await registerJoined(page);await openGuide(page);
  await expect(widget(page).locator('.page-spirit-art')).toHaveAttribute('src',asset('claude/education-supported'));
  await panel(page).getByRole('textbox',{name:'問本頁問題'}).fill('謝謝');await panel(page).getByRole('button',{name:'送出',exact:true}).click();
  await expect(widget(page).locator('.page-spirit-art')).toHaveAttribute('src',asset('claude/education-victory'));
  await panel(page).locator('.page-spirit-faq > summary').click();
  await panel(page).getByRole('button',{name:'首頁摘要',exact:true}).click();
  await panel(page).getByRole('button',{name:'找到會員摘要',exact:true}).click();
  await expect(page.locator('[data-page-spirit-guide-target="true"]')).toHaveCount(1);
  await selectTheme(page,'新手導覽－龍娘');await expect(widget(page)).toHaveAttribute('data-character-id','home');
  await expect(page.locator('[data-page-spirit-guide-target="true"]')).toHaveCount(0);
  await selectTheme(page,'新手導覽－AI Sister');await expect(widget(page)).toHaveAttribute('data-character-id','claude');
  await navigate(page,'私人工作與 AI');await expect(widget(page)).toHaveCount(0);
  await navigate(page,'會員首頁');await expect(widget(page)).toHaveCount(1);
  await signOut(page);await expect(widget(page)).toHaveCount(0);await expect(page.locator('.guide-gallery')).toHaveCount(0);
});

test('OFF or mismatched AI release cannot load art, and late AI release cannot replace a selected Dragon guide',async({page})=>{
  await registerJoined(page,'light');const art:string[]=[];
  page.on('request',request=>{if(request.url().includes('/public/guide-packs/ai-sister/'))art.push(request.url())});
  await page.route('**/api/v1/guide-packs/release/ai-sister',route=>route.fulfill({json:{...AI_SISTER_RELEASE_PIN,enabled:false}}));
  await selectTheme(page,'新手導覽－AI Sister');await expect(widget(page)).toHaveCount(0);await expect(page.locator('.workspace-companion')).toHaveCount(0);expect(art).toEqual([]);
  await selectTheme(page,'自由工坊－明亮');await page.unroute('**/api/v1/guide-packs/release/ai-sister');
  await page.route('**/api/v1/guide-packs/release/ai-sister',route=>route.fulfill({json:{...AI_SISTER_RELEASE_PIN,enabled:true,manifestSha256:'0'.repeat(64)}}));
  await selectTheme(page,'新手導覽－AI Sister');await expect(widget(page)).toHaveCount(0);expect(art).toEqual([]);
  await selectTheme(page,'自由工坊－明亮');await page.unroute('**/api/v1/guide-packs/release/ai-sister');
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve});
  await page.route('**/api/v1/guide-packs/release/ai-sister',async route=>{await held;await route.fulfill({json:{...AI_SISTER_RELEASE_PIN,enabled:true}}).catch(()=>{})});
  const pending=page.waitForRequest('**/api/v1/guide-packs/release/ai-sister');await selectTheme(page,'新手導覽－AI Sister');await pending;
  await selectTheme(page,'新手導覽－龍娘');release();await expect(widget(page)).toHaveAttribute('data-character-id','home');expect(art).toEqual([]);
});

test('bright AI Sister panel and wardrobe remain readable within desktop, tablet and mobile viewports',async({page},testInfo)=>{
  await page.emulateMedia({reducedMotion:'reduce'});await registerJoined(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme','light');
  expect(await widget(page).evaluate(element=>getComputedStyle(element).backgroundColor)).toBe('rgb(255, 255, 255)');
  expect(await widget(page).evaluate(element=>getComputedStyle(element).color)).toBe('rgb(28, 38, 54)');
  const directory=process.env.FREEDOM_GUIDE_SCREENSHOT_DIR??testInfo.outputPath('screenshots');await mkdir(directory,{recursive:true});
  for(const width of [1440,1280,1279,1024,768,390,320]){
    await page.setViewportSize({width,height:width<=390?844:900});await page.evaluate(()=>{window.scrollTo(0,0);document.querySelector('.workspace-companion')?.scrollTo(0,0)});await imageReady(widget(page).locator('.page-spirit-art'));await fits(page,widget(page),true);
    const companion=(await page.locator('.workspace-companion').boundingBox())!,main=(await page.locator('#main-content').boundingBox())!;
    if(width>=1280)expect(main.x+main.width).toBeLessThanOrEqual(companion.x);
    else expect(companion.y+companion.height).toBeLessThanOrEqual(main.y);
    await page.screenshot({path:`${directory}/ai-sister-presence-${width}.png`});
    for(const action of await widget(page).locator('.page-spirit-entry-actions button').all())expect((await action.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await widget(page).getByRole('button',{name:'換角色',exact:true}).click();await fits(page,widget(page),true);
    await page.screenshot({path:`${directory}/ai-sister-characters-${width}.png`});await page.keyboard.press('Escape');
    await openGuide(page);await panel(page).evaluate(element=>element.scrollTo(0,0));await fits(page,panel(page),true);
    await page.screenshot({path:`${directory}/ai-sister-panel-${width}.png`});
    await panel(page).getByRole('button',{name:'角色圖鑑',exact:true}).click();
    const gallery=page.getByRole('dialog',{name:'AI Sister角色圖鑑',exact:true});await imageReady(gallery.locator('img'));await fits(page,gallery);
    await page.screenshot({path:`${directory}/ai-sister-gallery-${width}.png`});await page.keyboard.press('Escape');
    await panel(page).getByRole('button',{name:'結束交談',exact:true}).click();
  }
});

test('selecting another companion preserves the page input and cancels its old guide',async({page})=>{
  await page.emulateMedia({reducedMotion:'reduce'});await registerJoined(page);await navigate(page,'工坊夥伴');
  const title=page.getByLabel('搜尋夥伴',{exact:true});await expect(title).toBeVisible();
  await title.fill('保留這個搜尋字詞');
  const original=await title.elementHandle();
  await widget(page).getByRole('button',{name:'帶我看',exact:true}).click();
  await expect(widget(page).getByLabel('本頁指引目錄')).toBeVisible();
  await widget(page).getByLabel('本頁指引目錄').getByRole('button').first().click();
  await expect(page.locator('[data-page-spirit-guide-target="true"]')).toHaveCount(1);
  await widget(page).getByRole('button',{name:'換角色',exact:true}).click();
  await expect(page.locator('[data-page-spirit-guide-target="true"]')).toHaveCount(0);
  await widget(page).getByRole('combobox',{name:'導覽角色'}).selectOption('gemini');
  await expect(widget(page)).toHaveAttribute('data-character-id','gemini');
  await expect(widget(page)).toHaveAttribute('data-outfit-id','culture');
  await expect(page.locator('[data-page-spirit-guide-target="true"]')).toHaveCount(0);
  expect(await original!.evaluate(element=>element.isConnected)).toBe(true);
  await expect(title).toHaveValue('保留這個搜尋字詞');
});

test('character selector is only disclosed by its action, restores keyboard focus and closes on outside help',async({page})=>{
  await page.emulateMedia({reducedMotion:'reduce'});await registerJoined(page);
  const change=widget(page).getByRole('button',{name:'換角色',exact:true}),select=widget(page).getByRole('combobox',{name:'導覽角色'});
  await expect(widget(page).locator('.page-spirit-entry-actions button')).toHaveText(['問本頁','帶我看','換角色']);
  await expect(change).toHaveAttribute('aria-expanded','false');await expect(select).toHaveCount(0);
  await change.focus();await page.keyboard.press('Enter');await expect(select).toBeFocused();
  await expect(change).toHaveAttribute('aria-expanded','true');await expect(widget(page)).toHaveAttribute('data-load-state','idle');
  await page.keyboard.press('Escape');await expect(select).toHaveCount(0);await expect(change).toBeFocused();
  await change.click();await change.click();await expect(select).toHaveCount(0);await expect(change).toBeFocused();
  await change.click();await select.selectOption('claude');await expect(select).toHaveCount(0);await expect(change).toBeFocused();
  await change.click();await openGuide(page);await expect(select).toHaveCount(0);await expect(panel(page)).toBeVisible();
  await change.click();await expect(panel(page)).toHaveCount(0);await expect(select).toBeVisible();
  const help=page.locator('.topbar').getByRole('button',{name:'頁面說明',exact:true});await help.click();
  const dialog=page.getByRole('dialog',{name:'會員首頁：頁面說明',exact:true});await expect(dialog).toBeVisible();await expect(select).toHaveCount(0);await expect(change).toBeDisabled();
  await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(help).toBeFocused();await expect(select).toHaveCount(0);
});
