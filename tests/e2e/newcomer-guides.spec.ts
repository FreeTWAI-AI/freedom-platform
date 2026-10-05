// Browser regressions adapted from mars-tw PR #106 (46a4034) and inline follow-up 99b9045, plus opt-in/release isolation.
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {test, expect, type Page, type Locator, type Route} from './fixtures.js';
import {navigate, signOut} from './navigation.js';
import {quickJoin} from './quick-join.js';
import {DRAGON_RELEASE_PIN} from '../../apps/portal-web/src/modules/newcomer-guides/release-pin.js';
import type {GuideCharacter} from '../../apps/portal-web/src/modules/newcomer-guides/contracts.js';
const manifest=JSON.parse(readFileSync(new URL('../../contracts/guide-packs/dragon-v1-20261004.json',import.meta.url),'utf8')) as {pack:string;version:string;assets:{logicalId:string;sha256:string}[]};
const sourceCharacters=JSON.parse(readFileSync(new URL('../../apps/portal-web/src/modules/newcomer-guides/packs/dragon/characters.json',import.meta.url),'utf8')) as Record<string,GuideCharacter>;
const publicArt=(id:string)=>`/public/guide-packs/${manifest.pack}/${manifest.version}/${manifest.assets.find(asset=>asset.logicalId===id)!.sha256}.webp`;
const SPIRIT_CHARACTERS=Object.fromEntries(Object.entries(sourceCharacters).map(([id,character])=>[id,{...character,portrait:publicArt(character.portrait),hero:publicArt(character.hero),frames:character.frames.map(publicArt),views:character.views.map(publicArt)}]));
import {TAB_TITLES} from '../../apps/portal-web/src/Navigation.js';
import type {TabId} from '../../apps/portal-web/src/types.js';
import type {SpiritPack} from '../../apps/portal-web/src/modules/newcomer-guides/engine/core.js';
import {SPIRIT_PREFERENCES_KEY} from '../../apps/portal-web/src/modules/newcomer-guides/engine/preferences.js';
import {DRAGON_GUIDES} from '../../apps/portal-web/src/modules/newcomer-guides/packs/dragon/guide-data.js';
const getSpiritGuide=(pageId:string,topicId:string|null)=>topicId?.startsWith(`${pageId}:`)?DRAGON_GUIDES[pageId]?.[topicId]??null:null;

const home = JSON.parse(readFileSync(new URL('../../apps/portal-web/src/modules/newcomer-guides/packs/dragon/content/home.json',import.meta.url),'utf8')) as SpiritPack;
const skills = JSON.parse(readFileSync(new URL('../../apps/portal-web/src/modules/newcomer-guides/packs/dragon/content/skills.json',import.meta.url),'utf8')) as SpiritPack;
const events = JSON.parse(readFileSync(new URL('../../apps/portal-web/src/modules/newcomer-guides/packs/dragon/content/events.json',import.meta.url),'utf8')) as SpiritPack;

const widget = (page: Page) => page.locator('.page-spirit-widget');
const panel = (page: Page) => page.locator('.page-spirit-panel');
const line = (page: Page) => panel(page).locator('.page-spirit-line p');
const actor = (page: Page) => widget(page).locator('.page-spirit-portrait');
const guide = (page: Page) => widget(page).locator('.page-spirit-guide');
const VIEWPORTS = [{width:1440,height:900},{width:1280,height:900},{width:1024,height:900},{width:768,height:900},{width:390,height:844},{width:320,height:420},{width:320,height:360}];

async function registerJoined(page: Page, profile='guide-dragon') {
  await page.addInitScript(profile=>{if(localStorage.getItem('freedom-theme')===null)localStorage.setItem('freedom-theme',profile)},profile);
  await page.context().route(url => !['127.0.0.1','localhost'].includes(url.hostname), route => route.abort());
  const nickname = `龍娘測試${randomUUID().slice(0,8)}`;
  const email = `page-spirit-${randomUUID()}@example.test`;
  // Fresh input for this newly created, isolated synthetic account; never a saved credential.
  const password = `Fixture-A1!-${randomUUID()}`;
  await page.goto('/');
  await page.getByRole('button',{name:'建立帳號',exact:true}).click();
  await page.getByLabel('社群顯示名稱',{exact:true}).fill(nickname);
  await page.getByLabel('電子郵件',{exact:true}).fill(email);
  await page.getByLabel('密碼',{exact:true}).fill(password);
  await page.getByRole('button',{name:'建立帳號，先逛工坊',exact:true}).click();
  await expect(page.getByRole('heading',{name:`${nickname}，歡迎來到自由工坊。`,exact:true})).toBeVisible();
  await expect(widget(page)).toHaveCount(0);
  await page.getByLabel('找感興趣的公會').fill('AI 開發公會');
  await quickJoin(page);
  await expect(page.getByRole('heading',{name:'會員首頁',level:1,exact:true})).toBeVisible();
  if(profile==='guide-dragon'){await expect(widget(page)).toHaveAttribute('data-page-id','home');await expect(widget(page).locator('.page-spirit-launcher')).toBeVisible();}
  else await expect(widget(page)).toHaveCount(0);
  return {email,password};
}

async function finishLine(page: Page) {
  const skip = panel(page).getByRole('button',{name:'顯示全文',exact:true});
  if (await skip.isVisible()) await skip.click();
  await expect(panel(page).locator('.page-spirit-line')).toHaveAttribute('data-typing','false',{timeout:4000});
}

async function openSpirit(page: Page) {
  await widget(page).locator('.page-spirit-launcher').click();
  await expect(widget(page)).toHaveAttribute('data-open','true');
  await expect(widget(page)).toHaveAttribute('data-load-state','ready',{timeout:15_000});
  await expect(panel(page).getByRole('textbox',{name:'問本頁問題',exact:true})).toBeEnabled();
  await finishLine(page);
  const faq=panel(page).locator('.page-spirit-faq');
  if(await faq.getAttribute('open')===null)await faq.locator('summary').click();
}

async function ask(page: Page, question: string) {
  await panel(page).getByRole('textbox',{name:'問本頁問題',exact:true}).fill(question);
  await panel(page).getByRole('button',{name:'送出',exact:true}).click();
  await finishLine(page);
}

async function openPreferences(page: Page) {
  const preferences=panel(page).locator('.page-spirit-preferences');
  if(await preferences.getAttribute('open')===null)await preferences.locator('summary').click();
}

async function openHistory(page: Page) {
  const history=panel(page).locator('.page-spirit-history');
  if(await history.getAttribute('open')===null)await history.locator('summary').click();
}

async function expectQuietCompanion(page: Page, blocked = false) {
  await expect(widget(page)).toHaveCount(1);
  await expect(widget(page)).toHaveAttribute('data-quiet','true');
  await expect(widget(page)).toHaveAttribute('data-mode','closed');
  await expect(widget(page)).toHaveAttribute('data-open','false');
  await expect(panel(page)).toHaveCount(0);
  await expect(actor(page)).toBeVisible();
  if(blocked) {
    const controls=widget(page).locator('.page-spirit-launcher,.page-spirit-entry-actions button');
    await expect(controls).toHaveCount(3);
    for(const button of await controls.all()) {
      await expect(button).toBeDisabled();
      await button.evaluate(element=>(element as HTMLButtonElement).click());
    }
    await expect(widget(page)).toHaveAttribute('data-mode','closed');
    await expect(panel(page)).toHaveCount(0);
  }
}

async function useInstantText(page: Page) {
  await openPreferences(page);
  await panel(page).getByRole('checkbox',{name:'直接顯示全文',exact:true}).check();
}

async function closeSpirit(page: Page) {
  await panel(page).getByRole('button',{name:'結束交談',exact:true}).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(widget(page).locator('.page-spirit-launcher')).toBeFocused();
}

function collectArtRequests(page: Page) {
  const requests: {pageId:string; part:string}[] = [];
  page.on('request',request => {
    const match = new URL(request.url()).pathname.match(/\/public\/guide-packs\/dragon\/[^/]+\/([0-9a-f]{64})\.webp$/);
    if (match) for(const asset of manifest.assets.filter(asset=>asset.sha256===match[1])) {
      const [pageId,part]=asset.logicalId.split('/');requests.push({pageId,part});
    }
  });
  return requests;
}

async function withinViewport(page: Page, target: Locator) {
  const rect = await target.boundingBox();
  expect(rect).not.toBeNull();
  const size = page.viewportSize()!;
  expect(rect!.x).toBeGreaterThanOrEqual(0); expect(rect!.x+rect!.width).toBeLessThanOrEqual(size.width+1);
  expect(rect!.y).toBeGreaterThanOrEqual(0); expect(rect!.y+rect!.height).toBeLessThanOrEqual(size.height+1);
}

async function expectReservedCompanionSpace(page: Page) {
  await expect(actor(page)).toBeVisible();
  await expect(panel(page).locator('.page-spirit-portrait')).toHaveCount(0);
  await expect(actor(page).locator('img')).toHaveCSS('object-fit','contain');
  await expect.poll(async()=>page.evaluate(()=>{
    const main=document.getElementById('main-content'),spirit=document.querySelector<HTMLElement>('.page-spirit-widget'),host=document.querySelector<HTMLElement>('.workspace-companion');
    if(!main||!spirit||!host||main.contains(spirit)||!host.contains(spirit)||host.parentElement!==main.parentElement)return false;
    if(['fixed','absolute'].includes(getComputedStyle(spirit).position))return false;
    const content=main.getBoundingClientRect(),companion=spirit.getBoundingClientRect();
    if(content.width<=0||content.height<=0||companion.width<=0||companion.height<=0)return false;
    const intersects=(other:{left:number;right:number;top:number;bottom:number})=>Math.min(content.right,other.right)-Math.max(content.left,other.left)>1
      &&Math.min(content.bottom,other.bottom)-Math.max(content.top,other.top)>1;
    if(intersects(companion)||intersects(host.getBoundingClientRect())||document.documentElement.scrollWidth>innerWidth+1)return false;
    const surfaces=spirit.querySelectorAll<HTMLElement>('.page-spirit-presence,.page-spirit-portrait,.page-spirit-guide,.page-spirit-panel,.page-spirit-disclosure,button,input,summary');
    if(Array.from(surfaces).some(element=>{
      const bounds=element.getBoundingClientRect(),style=getComputedStyle(element);
      const rect={left:bounds.left,right:bounds.right,top:bounds.top,bottom:bounds.bottom};
      for(let parent=element.parentElement;parent&&host.contains(parent);parent=parent.parentElement){
        const clip=parent.getBoundingClientRect(),parentStyle=getComputedStyle(parent);
        if(/hidden|clip|auto|scroll/.test(parentStyle.overflowX)){rect.left=Math.max(rect.left,clip.left);rect.right=Math.min(rect.right,clip.right);}
        if(/hidden|clip|auto|scroll/.test(parentStyle.overflowY)){rect.top=Math.max(rect.top,clip.top);rect.bottom=Math.min(rect.bottom,clip.bottom);}
      }
      return rect.right>rect.left&&rect.bottom>rect.top&&style.display!=='none'&&style.visibility!=='hidden'
        &&(intersects(rect)||rect.left< -1||rect.right>innerWidth+1);
    }))return false;
    if(innerWidth>=1280)return companion.left>=content.right-1 && Math.abs(host.getBoundingClientRect().width-264)<=1;
    return !['fixed','absolute','sticky'].includes(getComputedStyle(host).position)
      &&!['fixed','absolute','sticky'].includes(getComputedStyle(spirit).position)&&companion.bottom<=content.top+1;
  }),{timeout:5000,message:'the companion must occupy a separate page region without covering the main content'}).toBe(true);
}

async function receivesPointer(page: Page, target: Locator) {
  await target.evaluate(element=>element.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'}));
  await expect.poll(async()=>target.evaluate(element=>{
    const rect=element.getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2;
    if(x<0||y<0||x>=innerWidth||y>=innerHeight)return false;
    const hit=document.elementFromPoint(x,y);
    return hit===element||Boolean(hit&&element.contains(hit));
  }),{timeout:5000,message:'the actual control center must receive pointer input'}).toBe(true);
  await withinViewport(page,target);
}

test('joined member loads only the current hero before interaction and each permitted tab owns its character', async ({page}) => {
  test.setTimeout(120_000);
  const requests = collectArtRequests(page);
  const packRequests:string[]=[];
  const packChunk=new RegExp(`/assets/(${Object.keys(SPIRIT_CHARACTERS).join('|')})-[^/]+\\.js$`);
  page.on('request',request=>{const path=new URL(request.url()).pathname;if(packChunk.test(path)||/\/content\/[^/]+\.json$/.test(path))packRequests.push(path);});
  await registerJoined(page);
  await expect(widget(page).locator('.page-spirit-launcher img')).toHaveJSProperty('complete',true);
  expect(requests.length).toBeGreaterThan(0);
  // The pinned pack deliberately aliases hero and frame-0 to one physical digest.
  expect(requests.every(request=>request.pageId==='home' && ['hero','frame-0'].includes(request.part))).toBe(true);
  expect(packRequests).toEqual([]);
  await expect(widget(page).locator('.page-spirit-launcher img')).toHaveAttribute('src',SPIRIT_CHARACTERS.home.hero);
  const businessWrites: string[] = [];
  page.on('request',request=>{if(!['GET','HEAD','OPTIONS'].includes(request.method()) && new URL(request.url()).pathname.startsWith('/api/v1/'))businessWrites.push(new URL(request.url()).pathname);});
  await openSpirit(page);
  await expect(line(page)).toHaveText(home.entryLine);
  await expect(widget(page)).toHaveAttribute('role','region');
  await expect(widget(page)).toHaveAccessibleName(`${home.characterName} ${home.title}`);
  await expect(page.getByRole('region',{name:`${home.characterName}的本頁說明`,exact:true})).toBeVisible();
  await expect(widget(page).locator('.page-spirit-nameplate strong')).toHaveText(home.characterName);
  expect(requests.every(request=>request.pageId==='home')).toBe(true);
  expect(new Set(requests.filter(request=>request.part.startsWith('frame-')).map(request=>request.part)).size).toBe(6);
  await panel(page).getByRole('button',{name:home.topics[0].label,exact:true}).click(); await finishLine(page);
  await expect(line(page)).toHaveText(home.topics[0].answer);
  await closeSpirit(page); await openSpirit(page);
  await expect(line(page)).toHaveText(home.topics[0].answer);
  await closeSpirit(page);
  expect(businessWrites).toEqual([]);
  const observedNames = new Set<string>();
  // A newly joined ordinary member has no guild-management role. Use actual
  // navigation for every permitted tab, including the account/notification menus.
  for (const id of (Object.keys(SPIRIT_CHARACTERS) as TabId[]).filter(id=>id!=='guild-workspace')) {
    await navigate(page,TAB_TITLES[id]);
    await expect(widget(page)).toHaveAttribute('data-page-id',id);
    const character = SPIRIT_CHARACTERS[id], launcher = widget(page).locator('.page-spirit-launcher');
    await expect(launcher).toHaveAccessibleName(`${character.name}・${character.title}的當頁龍娘`);
    await expect(launcher.locator('img')).toHaveAttribute('src',character.hero);
    await expect(launcher.locator('img')).toHaveJSProperty('complete',true);
    expect(await launcher.locator('img').evaluate(image=>(image as HTMLImageElement).naturalWidth>0)).toBe(true);
    observedNames.add(character.name);
  }
  expect(observedNames.size).toBe(25);
  expect(requests.filter(request=>!['portrait','hero','frame-0'].includes(request.part)).every(request=>request.pageId==='home')).toBe(true);
  expect(packRequests.every(path=>/\/home-[^/]+\.js$/.test(path)||path.endsWith('/content/home.json'))).toBe(true);
});

test('page-only FAQ and raw-input privacy survive a delayed old-page pack and cross-page reset', async ({page}) => {
  test.setTimeout(90_000);
  await registerJoined(page);
  let release!: () => void;
  const hold = new Promise<void>(resolve=>{release=resolve;});
  let settled!: () => void, intercepted = false;
  const routeFinished = new Promise<void>(resolve=>{settled=resolve;});
  const routeErrors: unknown[] = [];
  const skillPack = (url: URL) => /\/assets\/skills-[^/]+\.js$/.test(url.pathname) || url.pathname.endsWith('/content/skills.json');
  const delayedPack = async (route: Route) => {
    intercepted = true;
    try { const response=await route.fetch(); await hold; await route.fulfill({response}); }
    catch (error) { routeErrors.push(error); }
    finally { settled(); }
  };
  await page.route(skillPack,delayedPack);
  try {
    await navigate(page,'技能書架');
    const requested = page.waitForRequest(request=>skillPack(new URL(request.url())),{timeout:15_000});
    await widget(page).locator('.page-spirit-launcher').click(); await requested;
    await expect(widget(page)).toHaveAttribute('data-load-state','loading');
    await navigate(page,'會員首頁');
    release(); await routeFinished;
    expect(routeErrors).toEqual([]);
    await page.unroute(skillPack,delayedPack);
    await expect(widget(page)).toHaveAttribute('data-page-id','home');
    await expect(panel(page)).toHaveCount(0);
    await openSpirit(page); await expect(line(page)).toHaveText(home.entryLine);
    await expect(panel(page).getByRole('button',{name:'免費預覽',exact:true})).toHaveCount(0);
    await closeSpirit(page); await navigate(page,'技能書架'); await openSpirit(page);
    await expect(widget(page).locator('.page-spirit-nameplate strong')).toHaveText(skills.characterName);
    await panel(page).getByRole('button',{name:'免費預覽',exact:true}).click(); await finishLine(page);
    await expect(line(page)).toHaveText(skills.topics.find(topic=>topic.label==='免費預覽')!.answer);
    for (const input of ['職業公會怎麼加入？','免費預覽，以及其他頁的付款','secret-e2e-only@example.test','<img src=x onerror=alert(1)>']) {
      await ask(page,input); await expect(line(page)).toHaveText(skills.unknownLine);
      await expect(panel(page).getByRole('textbox',{name:'問本頁問題',exact:true})).toHaveValue('');
      await expect(panel(page).locator('.page-spirit-line')).not.toContainText(input);
      await expect(panel(page).locator('.page-spirit-line img,.page-spirit-line .user')).toHaveCount(0);
      await expect(panel(page).locator('.page-spirit-line p')).toHaveCount(1);
    }
    await ask(page,'幫我付款'); await expect(line(page)).toContainText('原本的按鈕');
    await closeSpirit(page); await navigate(page,'會員首頁'); await openSpirit(page);
    await expect(line(page)).toHaveText(home.entryLine);
    await expect(widget(page).locator('.page-spirit-sr[role=status]').filter({hasText:home.entryLine})).toHaveCount(1);
  } finally {
    release();
    if (intercepted) await routeFinished;
    if (!page.isClosed()) await page.unroute(skillPack,delayedPack);
  }
});

test('console drafts, the existing page dialog and outside form focus keep the companion quiet without stealing data', async ({page}) => {
  test.setTimeout(90_000);
  await registerJoined(page);
  const help = page.locator('.topbar').getByRole('button',{name:'頁面說明',exact:true});
  const original = page.getByRole('dialog',{name:'會員首頁：頁面說明',exact:true});
  // The native dialog must return focus before React unmounts it, both with
  // the helper closed and when opening the modal suppresses an active helper.
  await help.click(); await expect(original).toBeVisible(); await expectQuietCompanion(page,true);
  await original.getByRole('button',{name:'關閉',exact:true}).click();
  await expect(original).toHaveCount(0);
  await expect(widget(page).locator('.page-spirit-launcher')).toBeVisible();
  await expect(help).toBeFocused();
  await openSpirit(page);
  await page.getByRole('button',{name:'展開訊息控制台',exact:true}).click();
  const dock = page.getByRole('complementary',{name:'訊息控制台',exact:true});
  await expect(dock).toBeVisible(); await expectQuietCompanion(page,true);
  await dock.getByRole('tab',{name:/^公會聊天/}).click();
  await dock.getByRole('button',{name:'AI 開發公會',exact:true}).click();
  const draft = `private-unsent-npc-draft-${randomUUID()}`;
  await dock.getByRole('textbox',{name:'在 AI 開發公會 發言',exact:true}).fill(draft);
  await page.getByRole('button',{name:'收合訊息控制台',exact:true}).click();
  await expect(widget(page).locator('.page-spirit-launcher')).toBeVisible();
  await openSpirit(page); await ask(page,'你是誰');
  await expect(line(page)).not.toContainText(draft); await closeSpirit(page);
  await page.getByRole('button',{name:'展開訊息控制台',exact:true}).click();
  await dock.getByRole('tab',{name:/^公會聊天/}).click();
  const room = dock.getByRole('button',{name:'AI 開發公會',exact:true}); if (await room.isVisible()) await room.click();
  await expect(dock.getByRole('textbox',{name:'在 AI 開發公會 發言',exact:true})).toHaveValue(draft);
  await page.getByRole('button',{name:'收合訊息控制台',exact:true}).click();
  await openSpirit(page);
  await help.click();
  await expect(original).toBeVisible(); await expectQuietCompanion(page,true);
  await original.getByRole('button',{name:'關閉',exact:true}).click(); await expect(original).toHaveCount(0);
  await expect(widget(page).locator('.page-spirit-launcher')).toBeVisible();
  await expect(help).toBeFocused();
  await expect(widget(page).locator('.page-spirit-launcher')).not.toBeFocused();
  await openSpirit(page); await help.click(); await expect(original).toBeVisible(); await expectQuietCompanion(page,true);
  await page.keyboard.press('Escape'); await expect(original).toHaveCount(0); await expect(help).toBeFocused();
  await expect(widget(page).locator('.page-spirit-launcher')).toBeVisible();
  await navigate(page,'工坊夥伴'); await openSpirit(page);
  const search = page.getByLabel('搜尋夥伴',{exact:true}), privateSearch = `unsent-profile-${randomUUID()}`;
  await search.fill(privateSearch); await expectQuietCompanion(page); await expect(search).toBeFocused(); await expect(search).toHaveValue(privateSearch);
  await page.getByRole('heading',{name:'工坊夥伴',level:1,exact:true}).click();
  await expect(widget(page).locator('.page-spirit-launcher')).toBeVisible(); await openSpirit(page);
  await expect(line(page)).not.toContainText(privateSearch); await expect(search).toHaveValue(privateSearch);
});

test('real six-frame playback finishes, cancels under motion controls and keeps flow controls operable beside the main page', async ({page}, testInfo) => {
  test.setTimeout(90_000);
  await registerJoined(page); await openSpirit(page);
  await expect(actor(page)).toBeVisible();
  await ask(page,'你好');
  await expect(actor(page)).toHaveAttribute('data-animating','true');
  const observed = await actor(page).evaluate(async element=>{
    const frames = new Set<string>(), sources = new Set<string>(), sizes = new Set<string>();
    const start=performance.now();
    while(performance.now()-start<2000 && (element as HTMLElement).dataset.animating==='true') {
      const image=element.querySelector('img')!;
      frames.add((element as HTMLElement).dataset.frameIndex!); sources.add(image.getAttribute('src')!);
      if(image.complete && image.naturalWidth) sizes.add(`${image.naturalWidth}x${image.naturalHeight}`);
      await new Promise(resolve=>setTimeout(resolve,35));
    }
    return {frames:[...frames],sources:[...sources],sizes:[...sizes],playing:(element as HTMLElement).dataset.animating,index:(element as HTMLElement).dataset.frameIndex};
  });
  expect(new Set(observed.frames)).toEqual(new Set(['0','1','2','3','4','5']));
  expect(observed.sources.length).toBe(6); expect(observed.sizes).toEqual(['384x576']);
  expect(observed.playing).toBe('false'); expect(observed.index).toBe('hero');
  expect(observed.sources.every(source=>SPIRIT_CHARACTERS.home.frames.includes(source))).toBe(true);
  await expect(actor(page).locator('img')).toHaveAttribute('src',SPIRIT_CHARACTERS.home.hero);
  expect(await actor(page).locator('img').evaluate(image=>getComputedStyle(image).animationName)).toBe('none');
  await ask(page,'你好'); await expect(actor(page)).toHaveAttribute('data-animating','true');
  await page.keyboard.press('Escape'); await expect(panel(page)).toHaveCount(0); await expect(widget(page).locator('.page-spirit-launcher')).toBeFocused();
  await openSpirit(page); await openPreferences(page); await panel(page).getByRole('checkbox',{name:'靜態省電',exact:true}).check(); await ask(page,'你好');
  await expect(actor(page)).toHaveAttribute('data-animating','false'); await expect(actor(page).locator('img')).toHaveAttribute('src',SPIRIT_CHARACTERS.home.hero);
  await panel(page).getByRole('checkbox',{name:'靜態省電',exact:true}).uncheck();
  await page.emulateMedia({reducedMotion:'reduce'}); await ask(page,'你好');
  await expect(actor(page)).toHaveAttribute('data-animating','false'); await expect(panel(page).locator('.page-spirit-line')).toHaveAttribute('data-typing','false');
  await page.emulateMedia({reducedMotion:'no-preference'});
  for (const width of [1440,390,320]) {
    await page.setViewportSize({width,height:900});
    await expectReservedCompanionSpace(page);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const submit=panel(page).getByRole('button',{name:'送出',exact:true}); await receivesPointer(page,submit);
    const rectangle=await submit.boundingBox(); expect(rectangle!.height).toBeGreaterThanOrEqual(44);
    await expectReservedCompanionSpace(page);
    await page.screenshot({path:testInfo.outputPath(`page-spirit-${width}.png`),fullPage:false});
    await closeSpirit(page);
    await receivesPointer(page,page.getByRole('button',{name:'展開訊息控制台',exact:true}));
    await openSpirit(page);
  }
});

test('opt-in NPC input and gallery button keep readable contrast', async ({page}) => {
  test.setTimeout(90_000);
  await registerJoined(page);
  for (const [label, theme] of [['新手導覽－龍娘','dark']] as const) {
    const settings = page.getByRole('button',{name:'設定',exact:true});
    if (await settings.getAttribute('aria-expanded')!=='true') await settings.click();
    await page.getByRole('menuitemradio',{name:label,exact:true}).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
    await page.keyboard.press('Escape');
    await openSpirit(page);
    await panel(page).getByRole('textbox',{name:'問本頁問題',exact:true}).fill('本頁文字對比測試');
    const metrics = await panel(page).evaluate(element => {
      const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
      const context=canvas.getContext('2d');if(!context)throw new Error('Canvas colour decoder unavailable');
      const rgba=(color:string) => {
        context.clearRect(0,0,1,1);context.fillStyle=color;context.fillRect(0,0,1,1);
        return [...context.getImageData(0,0,1,1).data];
      };
      const composite=(foreground:number[],background:number[]) => foreground.slice(0,3).map((channel,index)=>channel*foreground[3]/255+background[index]*(1-foreground[3]/255));
      const measure=(node:HTMLElement) => {
        const backgrounds:number[][]=[];
        for(let parent:HTMLElement|null=node;parent;parent=parent.parentElement)backgrounds.push(rgba(getComputedStyle(parent).backgroundColor));
        let background=[255,255,255];for(const layer of backgrounds.reverse())background=composite(layer,background);
        const style=getComputedStyle(node),foreground=composite(rgba(style.color),background);
        const luminance=(color:number[])=>color.map(channel=>{const value=channel/255;return value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4;})
          .reduce((sum,value,index)=>sum+value*[0.2126,0.7152,0.0722][index],0);
        const first=luminance(foreground),second=luminance(background);
        return {color:style.color,background,contrast:(Math.max(first,second)+0.05)/(Math.min(first,second)+0.05),colorScheme:style.colorScheme};
      };
      const input=element.querySelector<HTMLInputElement>('.page-spirit-form input'),link=element.querySelector<HTMLButtonElement>('.page-spirit-art-link');
      if(!input||!link)throw new Error('NPC contrast targets missing');
      return {input:measure(input),link:measure(link)};
    });
    expect(metrics.input.contrast,`${theme} input: ${JSON.stringify(metrics.input)}`).toBeGreaterThanOrEqual(4.5);
    expect(metrics.link.contrast,`${theme} gallery link: ${JSON.stringify(metrics.link)}`).toBeGreaterThanOrEqual(4.5);
    expect(metrics.input.colorScheme).toContain('dark');
    await closeSpirit(page);
  }
});

test('natural same-page dialogue, previous-response context, restart and IME keep the bounded conversation intact', async ({page}) => {
  test.setTimeout(90_000);
  await registerJoined(page); await navigate(page,'技能書架'); await openSpirit(page); await useInstantText(page);
  const preview=skills.topics.find(topic=>topic.label==='免費預覽')!,posting=skills.topics.find(topic=>topic.label==='投稿入口')!;
  await ask(page,'請問未解鎖能看嗎？'); await expect(line(page)).toHaveText(preview.answer);
  await ask(page,'我想了解投稿入口'); await expect(line(page)).toHaveText(posting.answer);
  const before=await widget(page).getAttribute('data-canonical-count');
  await openHistory(page);
  await panel(page).getByRole('button',{name:'上一句',exact:true}).click(); await expect(line(page)).toHaveText(preview.answer);
  await expect(widget(page)).toHaveAttribute('data-canonical-count',before!);
  await panel(page).getByRole('button',{name:'回到最新',exact:true}).click(); await expect(line(page)).toHaveText(posting.answer);
  await expect(widget(page)).toHaveAttribute('data-canonical-count',before!);
  await panel(page).getByRole('button',{name:'上一句',exact:true}).click();
  await ask(page,'下一步呢'); await expect(line(page)).toHaveText(preview.nextStep||preview.answer);
  const input=panel(page).getByRole('textbox',{name:'問本頁問題',exact:true}),beforeIme=await line(page).textContent();
  await input.fill('免費預覽'); await input.dispatchEvent('compositionstart');
  await input.dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true,bubbles:true,cancelable:true});
  await expect(input).toHaveValue('免費預覽'); await expect(line(page)).toHaveText(beforeIme!);
  await input.dispatchEvent('keydown',{key:'Escape',code:'Escape',isComposing:true,bubbles:true,cancelable:true});
  await expect(panel(page)).toBeVisible(); await expect(input).toHaveValue('免費預覽'); await expect(line(page)).toHaveText(beforeIme!);
  await input.dispatchEvent('compositionend'); await input.press('Enter'); await finishLine(page);
  await expect(input).toHaveValue(''); await expect(line(page)).toHaveText(preview.answer);
  for(let index=0;index<8;index++)await ask(page,index%2?'免費預覽':'投稿入口');
  await expect(widget(page)).toHaveAttribute('data-canonical-count','6');
  await expect(panel(page).locator('.page-spirit-line p')).toHaveCount(1);
  await expect(panel(page).locator('.user')).toHaveCount(0);
  await input.fill('private-unsent-minimize@example.test');
  await panel(page).getByRole('button',{name:'收合交談',exact:true}).click();
  await expect(widget(page)).toHaveAttribute('data-mode','compact'); await expect(panel(page)).toHaveCount(0);
  await expect(widget(page)).not.toContainText('private-unsent-minimize@example.test');
  await expect(widget(page).getByRole('button',{name:'繼續交談',exact:true})).toBeFocused();
  await widget(page).getByRole('button',{name:'繼續交談',exact:true}).click(); await finishLine(page);
  await expect(input).toHaveValue('private-unsent-minimize@example.test');
  await closeSpirit(page); await openSpirit(page); await expect(input).toHaveValue('');
  await openHistory(page);
  await panel(page).getByRole('button',{name:'重新開始',exact:true}).click(); await finishLine(page);
  await expect(line(page)).toHaveText(skills.entryLine); await expect(input).toHaveValue('');
  expect(Number(await widget(page).getAttribute('data-canonical-count'))).toBeLessThanOrEqual(1);
  await expect(panel(page).getByRole('button',{name:'上一句',exact:true})).toHaveAttribute('aria-disabled','true');
  await expect(panel(page).locator('.page-spirit-guide-button')).toHaveCount(0);
  await ask(page,'下一步'); await expect(line(page)).toHaveText(skills.entryLine);
  await navigate(page,'會員首頁'); await openSpirit(page); await expect(line(page)).toHaveText(home.entryLine);
  await expect(panel(page).getByRole('textbox',{name:'問本頁問題',exact:true})).toHaveValue('');
});

test('only boolean companion preferences survive reload, while raw drafts and current-member context do not', async ({page}, testInfo) => {
  test.setTimeout(90_000);
  await registerJoined(page); await openSpirit(page); await openPreferences(page);
  const user=(await (await page.request.get('/api/v1/session')).json() as {user:{user_id:string}}).user;
  await panel(page).getByRole('checkbox',{name:'靜態省電',exact:true}).check();
  await panel(page).getByRole('checkbox',{name:'直接顯示全文',exact:true}).check();
  const raw='private-preference-draft@example.test'; await panel(page).getByRole('textbox',{name:'問本頁問題',exact:true}).fill(raw);
  const saved=await page.evaluate(key=>localStorage.getItem(key),SPIRIT_PREFERENCES_KEY);
  expect(JSON.parse(saved!)).toEqual({energy:true,instantText:true});
  expect(saved).not.toContain(raw); expect(saved).not.toContain(user.user_id);
  await page.reload(); await expect(widget(page)).toHaveAttribute('data-page-id','home'); await openSpirit(page); await openPreferences(page);
  await expect(panel(page).getByRole('checkbox',{name:'靜態省電',exact:true})).toBeChecked();
  await expect(panel(page).getByRole('checkbox',{name:'直接顯示全文',exact:true})).toBeChecked();
  await expect(panel(page).getByRole('textbox',{name:'問本頁問題',exact:true})).toHaveValue('');
  await expect(line(page)).toHaveText(home.entryLine); await expect(actor(page)).toHaveAttribute('data-animating','false');
  await panel(page).locator('.page-spirit-preferences > summary').click();
  for(const viewport of [{width:390,height:844},{width:320,height:420},{width:320,height:360}]) {
    await page.setViewportSize(viewport);
    await panel(page).getByRole('button',{name:'收合交談',exact:true}).click();
    const actions=widget(page).locator('.page-spirit-entry-actions'); await expectReservedCompanionSpace(page);
    await expect(actor(page)).toBeVisible();
    for(const button of await actions.getByRole('button').all()){await receivesPointer(page,button);const box=await button.boundingBox();expect(box!.height).toBeGreaterThanOrEqual(44);}
    await actions.getByRole('button',{name:'繼續交談',exact:true}).click(); await finishLine(page);
    await expectReservedCompanionSpace(page); await receivesPointer(page,panel(page).getByRole('button',{name:'送出',exact:true}));
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:testInfo.outputPath(`page-spirit-ux-${viewport.width}x${viewport.height}.png`),fullPage:false});
  }
});

test('explicit current-topic guide focuses and highlights the real control without clicking or obscuring it', async ({page}, testInfo) => {
  test.setTimeout(90_000);
  await registerJoined(page); await navigate(page,'技能書架'); await openSpirit(page); await useInstantText(page);
  const preview=skills.topics.find(topic=>topic.label==='免費預覽')!,definition=getSpiritGuide('skills',preview.id)!;
  expect(definition).not.toBeNull(); expect(definition.steps.length).toBeGreaterThan(0);
  const target=page.locator(definition.steps[0].selector);
  await expect(target).toHaveCount(1);
  const clickedBefore=await target.getAttribute('aria-pressed'),urlBefore=page.url();
  const booksBefore=await page.locator('.community-library [data-book-id]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-book-id')));
  await target.evaluate(element=>{const state=window as typeof window&{__pageSpiritGuideClicks:number};state.__pageSpiritGuideClicks=0;element.addEventListener('click',()=>{state.__pageSpiritGuideClicks++;});});
  const writes:string[]=[];page.on('request',request=>{if(['POST','PUT','PATCH','DELETE'].includes(request.method())&&new URL(request.url()).pathname.startsWith('/api/v1/'))writes.push(new URL(request.url()).pathname);});
  for(const size of [{width:1440,height:900},{width:320,height:420},{width:320,height:360}]) {
    await page.setViewportSize(size); await ask(page,'請問免費預覽呢？');
    await panel(page).getByRole('button',{name:definition.label,exact:true}).click();
    const guideRegion=guide(page);
    await expect(widget(page)).toHaveAttribute('data-mode','guide');
    await expectReservedCompanionSpace(page);
    await expect(guideRegion).toHaveAttribute('data-guide-found','true');
    await expect(target).toBeFocused(); await expect(target).toHaveAttribute('data-page-spirit-guide-target','true');
    await expect.poll(async()=>{
      const control=await target.boundingBox(),helper=await guideRegion.boundingBox(),consoleBox=await page.locator('.game-console-ticker').boundingBox();
      if(!control||!helper||!consoleBox)return false;
      const overlap=(a:typeof control,b:typeof helper)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
      const receivesPointer=await target.evaluate(element=>{
        const rect=element.getBoundingClientRect(),hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);
        return hit===element||Boolean(hit&&element.contains(hit));
      });
      return control.x>=0&&control.y>=0&&control.x+control.width<=size.width+1&&control.y+control.height<=size.height+1&&!overlap(control,helper)&&!overlap(control,consoleBox)&&receivesPointer;
    },{timeout:5000,message:`guide target must remain operable at ${size.width}x${size.height}`}).toBe(true);
    for(const button of await guideRegion.getByRole('button').all()){const box=await button.boundingBox();expect(box!.height).toBeGreaterThanOrEqual(44);}
    expect(await target.getAttribute('aria-pressed')).toBe(clickedBefore);expect(page.url()).toBe(urlBefore);
    expect(await page.evaluate(()=>(window as typeof window&{__pageSpiritGuideClicks:number}).__pageSpiritGuideClicks)).toBe(0);
    expect(await page.locator('.community-library [data-book-id]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-book-id')))).toEqual(booksBefore);
    await page.screenshot({path:testInfo.outputPath(`page-spirit-guide-${size.width}x${size.height}.png`),fullPage:false});
    await page.keyboard.press('Escape');
    await expect(target).not.toHaveAttribute('data-page-spirit-guide-target','true');
    await expect(target).toBeFocused(); await expect(widget(page)).toHaveAttribute('data-mode','closed');
    await openSpirit(page);
  }
  await ask(page,'免費預覽'); await panel(page).getByRole('button',{name:definition.label,exact:true}).click();
  const original=await target.elementHandle(); await navigate(page,'會員首頁');
  await expect(page.locator('[data-page-spirit-guide-target="true"]')).toHaveCount(0);
  expect(await original!.getAttribute('data-page-spirit-guide-target')).toBeNull();
  await expect(widget(page)).toHaveAttribute('data-page-id','home'); await expect(widget(page)).toHaveAttribute('data-mode','closed');
  expect(writes).toEqual([]);
});

test('a missing original control yields an honest guide notice and never chooses a different or private target', async ({page}) => {
  test.setTimeout(90_000);
  await registerJoined(page); await navigate(page,'工坊夥伴');
  await page.getByLabel('搜尋夥伴',{exact:true}).fill(`no-guide-match-${randomUUID()}`);
  await page.locator('.directory-filters').getByRole('button',{name:'搜尋',exact:true}).click();
  await expect(page.locator('.directory-member')).toHaveCount(0);
  await openSpirit(page); await useInstantText(page); await ask(page,'好友邀請');
  const definition=getSpiritGuide('members','members:topic-2')!; expect(definition).not.toBeNull();
  await panel(page).getByRole('button',{name:definition.label,exact:true}).click();
  await expect(widget(page)).toHaveAttribute('data-mode','guide');
  await expect(guide(page)).toHaveAttribute('data-guide-found','false');
  await expect(guide(page).locator('.page-spirit-note')).toContainText('入口目前無法使用');
  await expect(page.locator('[data-page-spirit-guide-target="true"]')).toHaveCount(0);
  await widget(page).getByRole('button',{name:'結束指引',exact:true}).click();
  await expect(widget(page)).toHaveAttribute('data-mode','closed'); await expect(widget(page).locator('.page-spirit-launcher')).toBeFocused();
});

test('guide target invalidation restores original attributes and never resumes without an explicit retry', async ({page}) => {
  test.setTimeout(90_000);
  await registerJoined(page); await navigate(page,'技能書架'); await openSpirit(page); await useInstantText(page);
  const preview=skills.topics.find(topic=>topic.label==='免費預覽')!,definition=getSpiritGuide('skills',preview.id)!,target=page.locator(definition.steps[0].selector);
  const tabIndex=await target.getAttribute('tabindex');
  for(const [attribute,value] of [['hidden',''],['disabled',''],['aria-disabled','true'],['aria-busy','true'],['inert','']] as const) {
    await ask(page,'免費預覽'); await panel(page).getByRole('button',{name:definition.label,exact:true}).click();
    await expect(target).toHaveAttribute('data-page-spirit-guide-target','true');
    const previous=await target.getAttribute(attribute);
    await target.evaluate((element,{attribute,value})=>element.setAttribute(attribute,value),{attribute,value});
    const guideRegion=guide(page);
    await expect(guideRegion).toHaveAttribute('data-guide-found','false');
    await expect(target).not.toHaveAttribute('data-page-spirit-guide-target','true');
    expect(await target.getAttribute('tabindex')).toBe(tabIndex);
    await target.evaluate((element,{attribute,previous})=>{if(previous===null)element.removeAttribute(attribute);else element.setAttribute(attribute,previous);},{attribute,previous});
    await expect(guideRegion).toHaveAttribute('data-guide-found','false');
    await guideRegion.getByRole('button',{name:'重找入口',exact:true}).click();
    await expect(guideRegion).toHaveAttribute('data-guide-found','true'); await expect(target).toBeFocused();
    await guideRegion.getByRole('button',{name:'結束指引',exact:true}).click();
    await expect(target).not.toHaveAttribute('data-page-spirit-guide-target','true'); await openSpirit(page);
  }
  await ask(page,'免費預覽'); await panel(page).getByRole('button',{name:definition.label,exact:true}).click();
  const help=page.locator('.topbar').getByRole('button',{name:'頁面說明',exact:true});await help.click();
  const original=page.getByRole('dialog',{name:'技能書架：頁面說明',exact:true});await expect(original).toBeVisible();
  await expect(page.locator('[data-page-spirit-guide-target="true"]')).toHaveCount(0);
  await page.keyboard.press('Escape');await expect(original).toHaveCount(0);await expect(help).toBeFocused();
  await openSpirit(page);await ask(page,'免費預覽');await panel(page).getByRole('button',{name:definition.label,exact:true}).click();
  const removed=await target.elementHandle();await target.evaluate(element=>element.remove());
  await expect(guide(page)).toHaveAttribute('data-guide-found','false');
  expect(await removed!.getAttribute('data-page-spirit-guide-target')).toBeNull();
  await expect(page.locator('[data-page-spirit-guide-target="true"]')).toHaveCount(0);
});


test('a tall real calendar guide shows its beginning and stops scrolling when dismissed', async ({page}, testInfo) => {
  test.setTimeout(90_000);
  await registerJoined(page); await navigate(page,'社群活動');
  await openSpirit(page); await useInstantText(page); await page.setViewportSize({width:320,height:420});
  const topic=events.topics.find(item=>item.id==='events:topic-2')!,definition=getSpiritGuide('events',topic.id)!;
  await ask(page,topic.label); await panel(page).getByRole('button',{name:definition.label,exact:true}).click();
  const target=page.locator(definition.steps[0].selector),guideRegion=guide(page);
  await expect(guideRegion).toHaveAttribute('data-guide-found','true'); await expect(target).toBeFocused();
  await expectReservedCompanionSpace(page);
  expect((await target.boundingBox())!.height).toBeGreaterThan(210);
  await expect.poll(async()=>target.evaluate(element=>{
    const rect=element.getBoundingClientRect();
    const hit=document.elementFromPoint(rect.left+Math.min(20,rect.width/2),rect.top+Math.min(20,rect.height/2));
    return rect.top>=0&&rect.top<innerHeight/2&&Boolean(hit&&(hit===element||element.contains(hit)));
  }),{timeout:5000,message:'the calendar heading must be visible above the guide, not its middle'}).toBe(true);
  await page.screenshot({path:testInfo.outputPath('page-spirit-calendar-guide-320.png'),fullPage:false});
  await guideRegion.getByRole('button',{name:'結束指引',exact:true}).click();
  await expect(target).not.toHaveAttribute('data-page-spirit-guide-target','true');
  await expect(widget(page).locator('.page-spirit-launcher')).toBeFocused();
  const positions=await page.evaluate(async()=>{
    const samples:number[]=[];const start=performance.now();
    while(performance.now()-start<650){samples.push(scrollY);await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));}
    return samples;
  });
  expect(Math.max(...positions)-Math.min(...positions)).toBeLessThanOrEqual(1);
});

test('every companion mode reserves its own region and leaves real main-page controls operable across desktop and phone layouts', async ({page}, testInfo) => {
  test.setTimeout(120_000);
  await registerJoined(page); await navigate(page,'技能書架');
  await page.setViewportSize({width:1440,height:900}); await openSpirit(page); await useInstantText(page);
  await panel(page).getByRole('checkbox',{name:'靜態省電',exact:true}).check();
  await panel(page).locator('.page-spirit-preferences > summary').click(); await closeSpirit(page);
  const preview=skills.topics.find(topic=>topic.label==='免費預覽')!,definition=getSpiritGuide('skills',preview.id)!;
  const target=page.locator(definition.steps[0].selector);
  await widget(page).getByRole('button',{name:'帶我看',exact:true}).click();
  await expect(widget(page).locator('.page-spirit-guide-directory')).toBeVisible();
  await expect(page.locator('[data-page-spirit-guide-target="true"]')).toHaveCount(0);
  await expect(target).not.toBeFocused();
  await widget(page).locator('.page-spirit-guide-directory').getByRole('button',{name:definition.label,exact:true}).click();
  await expect(widget(page)).toHaveAttribute('data-mode','guide');
  await expect(target).toHaveAttribute('data-page-spirit-guide-target','true'); await expect(target).toBeFocused();
  await widget(page).getByRole('button',{name:'結束指引',exact:true}).click();
  for(const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await expect(widget(page)).toHaveAttribute('data-mode','closed');
    await expectReservedCompanionSpace(page); await receivesPointer(page,target);
    const actions=widget(page).locator('.page-spirit-entry-actions');
    for(const button of await actions.getByRole('button').all()) {
      await receivesPointer(page,button); expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await actions.getByRole('button',{name:'帶我看',exact:true}).click();
    await expect(widget(page)).toHaveAttribute('data-load-state','ready');
    const directory=widget(page).locator('.page-spirit-guide-directory');
    await expect(directory).toBeVisible();
    await expect(page.locator('[data-page-spirit-guide-target="true"]')).toHaveCount(0);
    await expect(target).not.toBeFocused();
    await expectReservedCompanionSpace(page); await receivesPointer(page,target);
    for(const button of await directory.getByRole('button').all()) {
      await receivesPointer(page,button); expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await directory.locator('summary').click();
    await expect(widget(page)).toHaveAttribute('data-mode','closed');
    await openSpirit(page);
    await expect(widget(page)).toHaveAttribute('data-mode','expanded');
    await expectReservedCompanionSpace(page); await receivesPointer(page,target);
    await receivesPointer(page,panel(page).getByRole('button',{name:'送出',exact:true}));
    await expect(actor(page)).toBeVisible();
    await expect(actor(page).locator('img')).toHaveAttribute('src',SPIRIT_CHARACTERS.skills.hero);
    await panel(page).getByRole('button',{name:'收合交談',exact:true}).click();
    await expect(widget(page)).toHaveAttribute('data-mode','compact');
    await expectReservedCompanionSpace(page); await receivesPointer(page,target);
    const resume=widget(page).getByRole('button',{name:'繼續交談',exact:true});
    await receivesPointer(page,resume); expect((await resume.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await resume.click(); await finishLine(page); await ask(page,preview.label);
    await panel(page).getByRole('button',{name:definition.label,exact:true}).click();
    await expect(widget(page)).toHaveAttribute('data-mode','guide');
    await expectReservedCompanionSpace(page); await expect(target).toBeFocused(); await receivesPointer(page,target);
    const end=widget(page).getByRole('button',{name:'結束指引',exact:true});
    await receivesPointer(page,end); expect((await end.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expectReservedCompanionSpace(page);
    await page.screenshot({path:testInfo.outputPath(`page-spirit-reserved-guide-${viewport.width}x${viewport.height}.png`),fullPage:false});
    await end.click(); await expect(widget(page)).toHaveAttribute('data-mode','closed');
    await expect(target).not.toHaveAttribute('data-page-spirit-guide-target','true');
    await expectReservedCompanionSpace(page);
  }
});

for(const [profile,label] of [['light','自由工坊－明亮'],['dark','自由工坊－夜航'],['versefolk','自由工坊－敘生']] as const)test(`${label} starts with zero guide code, content, status and art requests`,async({page})=>{
  const guideRequests:string[]=[];
  const contentChunk=new RegExp(`/assets/(${Object.keys(SPIRIT_CHARACTERS).join('|')})-[^/]+\\.js$`);
  page.on('request',request=>{if(/guide-packs|GuideEngine|GuideGallery|newcomer-guides|ai-sister-|page-guides-|dragon-|\/content\/[^/]+\.json/.test(request.url())||contentChunk.test(new URL(request.url()).pathname))guideRequests.push(request.url())});
  await registerJoined(page,profile);
  await navigate(page,'技能書架');await navigate(page,'會員首頁');
  await page.locator('.topbar').getByRole('button',{name:'頁面說明',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'會員首頁：頁面說明',exact:true})).toBeVisible();
  await page.keyboard.press('Escape');await expect(widget(page)).toHaveCount(0);
  await expect(page.locator('.workspace-companion')).toHaveCount(0);
  for(const viewport of [{width:1440,height:900},{width:390,height:844}]) {
    await page.setViewportSize(viewport);
    const geometry=await page.locator('.workspace-main').evaluate(element=>{
      const bounds=element.getBoundingClientRect(),style=getComputedStyle(element),main=element.querySelector('#main-content')!.getBoundingClientRect();
      const contentWidth=bounds.width-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)-parseFloat(style.borderLeftWidth)-parseFloat(style.borderRightWidth);
      return {contentWidth,mainWidth:main.width};
    });
    expect(geometry.mainWidth).toBeGreaterThan(0);
    expect(Math.abs(geometry.contentWidth-geometry.mainWidth)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  }
  expect(guideRequests).toEqual([]);
});

test('selecting the fourth profile persists one choice; switching back cancels guide, tabindex, gallery and late release',async({page})=>{
  await registerJoined(page,'light');
  await page.getByRole('button',{name:'設定',exact:true}).click();
  await page.getByRole('menuitemradio',{name:'新手導覽－龍娘',exact:true}).click();
  await page.keyboard.press('Escape');
  await expect(widget(page)).toHaveAttribute('data-page-id','home');
  await expect(page.locator('html')).toHaveAttribute('data-guide-skin','dragon');
  await page.reload();await expect(widget(page)).toHaveAttribute('data-page-id','home');
  expect(await page.evaluate(()=>localStorage.getItem('freedom-theme'))).toBe('guide-dragon');
  const originalHomeTabIndex=await page.locator('[data-guide-anchor="home:member-summary"]').getAttribute('tabindex');
  await openSpirit(page);await useInstantText(page);await ask(page,home.topics[0].label);
  await panel(page).getByRole('button',{name:getSpiritGuide('home',home.topics[0].id)!.label,exact:true}).click();
  const highlighted=page.locator('[data-page-spirit-guide-target="true"]');await expect(highlighted).toHaveCount(1);
  await page.getByRole('button',{name:'設定',exact:true}).click();await page.getByRole('menuitemradio',{name:'自由工坊－明亮',exact:true}).click();
  await expect(widget(page)).toHaveCount(0);await expect(highlighted).toHaveCount(0);
  expect(await page.locator('[data-guide-anchor="home:member-summary"]').getAttribute('tabindex')).toBe(originalHomeTabIndex);
  await expect(page.locator('html')).not.toHaveAttribute('data-guide-skin','dragon');
  await page.keyboard.press('Escape');await navigate(page,'工坊夥伴');
  const search=page.getByLabel('搜尋夥伴',{exact:true}),raw=`private-profile-switch-${randomUUID()}`;
  await search.fill(raw);const originalSearch=await search.elementHandle();
  for(const label of ['新手導覽－龍娘','自由工坊－夜航','新手導覽－龍娘']) {
    await page.getByRole('button',{name:'設定',exact:true}).click();
    await page.getByRole('menuitemradio',{name:label,exact:true}).click();await page.keyboard.press('Escape');
    if(label==='新手導覽－龍娘')await expect(widget(page)).toHaveAttribute('data-page-id','members');
    else await expect(widget(page)).toHaveCount(0);
    expect(await originalSearch!.evaluate(element=>element.isConnected)).toBe(true);
    await expect(search).toHaveValue(raw);
  }
});

test('gallery loads one selected view and closes cleanly with Escape without cross-page character fallback',async({page})=>{
  const requests=collectArtRequests(page);await registerJoined(page);await openSpirit(page);
  expect(requests.filter(request=>request.part.startsWith('view-'))).toEqual([]);
  await panel(page).getByRole('button',{name:'角色六視圖',exact:true}).click();
  const gallery=page.getByRole('dialog',{name:'龍娘角色六視圖',exact:true});await expect(gallery).toBeVisible();
  await expect(gallery.locator('img')).toHaveJSProperty('complete',true);
  expect(new Set(requests.filter(request=>request.part.startsWith('view-')).map(request=>`${request.pageId}/${request.part}`))).toEqual(new Set(['home/view-0']));
  await gallery.getByRole('combobox',{name:'角色',exact:true}).selectOption('skills');await expect(gallery.locator('img')).toHaveAttribute('src',SPIRIT_CHARACTERS.skills.views[0]);
  await page.keyboard.press('Escape');await expect(gallery).toHaveCount(0);
  await expect(panel(page).getByRole('button',{name:'角色六視圖',exact:true})).toBeFocused();
  await closeSpirit(page);await navigate(page,'私人工作與 AI');await expect(widget(page)).toHaveCount(0);
});

test('default-off or mismatched release never imports the engine or requests art; late responses cannot remount after theme change',async({page})=>{
  let releaseReply:unknown={enabled:false};
  await page.route('**/api/v1/guide-packs/release',route=>route.fulfill({json:releaseReply}));
  await registerJoined(page,'light');
  const requests=collectArtRequests(page);
  const engineRequests:string[]=[];
  page.on('request',request=>{if(/GuideEngine|GuideGallery|\/content\/[^/]+\.json/.test(request.url()))engineRequests.push(request.url())});
  await page.getByRole('button',{name:'設定',exact:true}).click();
  for(const reply of [{enabled:false},{...DRAGON_RELEASE_PIN,enabled:true,version:'synthetic-mismatched-version'}]) {
    releaseReply=reply;
    const checked=page.waitForResponse('**/api/v1/guide-packs/release');
    await page.getByRole('menuitemradio',{name:'新手導覽－龍娘',exact:true}).click();await checked;
    await expect(widget(page)).toHaveCount(0);expect(requests).toEqual([]);expect(engineRequests).toEqual([]);
    await page.getByRole('menuitemradio',{name:'自由工坊－明亮',exact:true}).click();
  }
  await page.unroute('**/api/v1/guide-packs/release');
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve});
  let finished!:()=>void;const settled=new Promise<void>(resolve=>{finished=resolve});
  await page.route('**/api/v1/guide-packs/release',async route=>{try{await held;await route.fulfill({json:{...DRAGON_RELEASE_PIN,enabled:true}}).catch(()=>{})}finally{finished()}});
  const pending=page.waitForRequest('**/api/v1/guide-packs/release');
  await page.getByRole('menuitemradio',{name:'新手導覽－龍娘',exact:true}).click();await pending;
  await page.getByRole('menuitemradio',{name:'自由工坊－明亮',exact:true}).click();release();await settled;
  await expect(widget(page)).toHaveCount(0);expect(requests).toEqual([]);expect(engineRequests).toEqual([]);
});

test('a duplicate current anchor added mid-guide clears the old highlight and temporary tabindex until explicit retry',async({page})=>{
  await registerJoined(page);await openSpirit(page);await useInstantText(page);await ask(page,home.topics[0].label);
  const definition=getSpiritGuide('home',home.topics[0].id)!;
  const originalTabIndex=await page.locator(definition.steps[0].selector).getAttribute('tabindex');
  await panel(page).getByRole('button',{name:definition.label,exact:true}).click();
  const target=page.locator(definition.steps[0].selector);
  await expect(target).toHaveAttribute('data-page-spirit-guide-target','true');
  await target.evaluate(element=>{const duplicate=element.cloneNode(true) as HTMLElement;duplicate.removeAttribute('data-page-spirit-guide-target');duplicate.removeAttribute('tabindex');duplicate.id='synthetic-duplicate-guide-target';element.after(duplicate)});
  await expect(guide(page)).toHaveAttribute('data-guide-found','false');
  await expect(page.locator('[data-page-spirit-guide-target="true"]')).toHaveCount(0);
  expect(await target.first().getAttribute('tabindex')).toBe(originalTabIndex);
  await page.locator('#synthetic-duplicate-guide-target').evaluate(element=>element.remove());
  await expect(guide(page)).toHaveAttribute('data-guide-found','false');
  await widget(page).getByRole('button',{name:'重找入口',exact:true}).click();
  await expect(target).toHaveAttribute('data-page-spirit-guide-target','true');
});

test('gallery modal owns its shortcut keys and interruption never reopens a stale modal',async({page})=>{
  await registerJoined(page);await openSpirit(page);
  await panel(page).getByRole('button',{name:'角色六視圖',exact:true}).click();
  const gallery=page.getByRole('dialog',{name:'龍娘角色六視圖',exact:true});await expect(gallery).toBeVisible();
  // The existing Console preserves drafts in a mounted, hidden aside.
  const consoleDock=page.locator('.game-console-expanded');
  await expect(consoleDock).toHaveCount(1);await expect(consoleDock).toBeHidden();
  for(const key of ['~','`','Backquote']){await page.keyboard.press(key);await expect(gallery).toBeVisible();await expect(consoleDock).toBeHidden();}
  // External UI can change while a modal is open (e.g. a restored console state).
  await consoleDock.evaluate(element=>{(element as HTMLElement).hidden=false});
  await expect(consoleDock).toBeVisible();
  await expect(page.locator('.guide-gallery')).toHaveCount(0);
  await consoleDock.evaluate(element=>{(element as HTMLElement).hidden=true});
  await expect(consoleDock).toBeHidden();
  await expect(widget(page).locator('.page-spirit-launcher')).toBeVisible();
  await expect(page.locator('.guide-gallery')).toHaveCount(0);await expect(panel(page)).toHaveCount(0);
});

test('entry actions expose only the requested help and repeated inline collapse returns focus without duplicating a session',async({page})=>{
  test.setTimeout(90_000);
  await registerJoined(page);await page.emulateMedia({reducedMotion:'reduce'});
  const questions=widget(page).getByRole('button',{name:'問本頁',exact:true});
  const directory=widget(page).locator('.page-spirit-guide-directory');
  for(let cycle=0;cycle<3;cycle++) {
    await questions.click();await expect(widget(page)).toHaveAttribute('data-load-state','ready');await finishLine(page);
    await expect(panel(page)).toHaveCount(1);await expect(directory).toHaveCount(0);
    await expect(questions).toHaveAttribute('aria-expanded','true');
    for(const selector of ['.page-spirit-faq','.page-spirit-history','.page-spirit-preferences']) {
      const disclosure=panel(page).locator(selector);
      await expect(disclosure).not.toHaveAttribute('open','');
      await disclosure.locator('summary').click();await expect(disclosure).toHaveAttribute('open','');
      await disclosure.locator('summary').click();await expect(disclosure).not.toHaveAttribute('open','');
    }
    await questions.click();await questions.click();
    await expect(panel(page)).toHaveCount(1);await expect(widget(page)).toHaveAttribute('data-canonical-count','1');
    await panel(page).locator('.page-spirit-form input').fill(`discarded-inline-draft-${cycle}`);
    await panel(page).getByRole('button',{name:'收合交談',exact:true}).click();
    const resume=widget(page).getByRole('button',{name:'繼續交談',exact:true});
    await expect(resume).toBeFocused();await expect(widget(page)).toHaveAttribute('data-mode','compact');
    await page.keyboard.press('Escape');await expect(widget(page)).toHaveAttribute('data-mode','closed');
    await expect(widget(page).locator('.page-spirit-launcher')).toBeFocused();
    await questions.click();await finishLine(page);
    await expect(panel(page).getByRole('textbox',{name:'問本頁問題',exact:true})).toHaveValue('');
    await widget(page).getByRole('button',{name:'帶我看',exact:true}).click();
    await expect(directory).toHaveCount(1);await expect(panel(page)).toHaveCount(0);
    await widget(page).getByRole('button',{name:'帶我看',exact:true}).click();
    await expect(directory).toHaveCount(1);await expect(page.locator('[data-page-spirit-guide-target="true"]')).toHaveCount(0);
    await directory.locator('summary').click();
    await expect(widget(page)).toHaveAttribute('data-mode','closed');await expect(widget(page).locator('.page-spirit-launcher')).toBeFocused();
  }
});

test('logout and another synthetic member never inherit a draft, conversation, guide or gallery',async({page})=>{
  test.setTimeout(120_000);
  const first=await registerJoined(page);
  const firstUser=(await (await page.request.get('/api/v1/session')).json() as {user:{user_id:string}}).user.user_id;
  await openSpirit(page);await useInstantText(page);await ask(page,home.topics[0].label);
  const raw=`private-member-draft-${randomUUID()}@example.test`;
  await panel(page).getByRole('textbox',{name:'問本頁問題',exact:true}).fill(raw);
  await panel(page).getByRole('button',{name:'收合交談',exact:true}).click();
  await signOut(page);await expect(widget(page)).toHaveCount(0);await expect(page.locator('.workspace-companion')).toHaveCount(0);
  await registerJoined(page);
  const secondUser=(await (await page.request.get('/api/v1/session')).json() as {user:{user_id:string}}).user.user_id;
  expect(secondUser).not.toBe(firstUser);
  await openSpirit(page);await expect(line(page)).toHaveText(home.entryLine);
  await expect(panel(page).getByRole('textbox',{name:'問本頁問題',exact:true})).toHaveValue('');
  await expect(widget(page)).not.toContainText(raw);await expect(widget(page)).toHaveAttribute('data-canonical-count','1');
  await ask(page,home.topics[0].label);
  const definition=getSpiritGuide('home',home.topics[0].id)!,target=page.locator(definition.steps[0].selector);
  const original=await target.elementHandle(),tabindex=await target.getAttribute('tabindex');
  await panel(page).getByRole('button',{name:definition.label,exact:true}).click();
  await expect(target).toHaveAttribute('data-page-spirit-guide-target','true');
  await signOut(page);await expect(widget(page)).toHaveCount(0);
  expect(await original!.getAttribute('data-page-spirit-guide-target')).toBeNull();
  expect(await original!.getAttribute('tabindex')).toBe(tabindex);
  await page.getByLabel('電子郵件',{exact:true}).fill(first.email);
  await page.getByLabel('密碼',{exact:true}).fill(first.password);
  await page.getByRole('button',{name:'登入',exact:true}).click();
  await expect(widget(page)).toHaveAttribute('data-page-id','home');await openSpirit(page);
  await expect(line(page)).toHaveText(home.entryLine);await expect(widget(page)).toHaveAttribute('data-canonical-count','1');
  await expect(panel(page).getByRole('textbox',{name:'問本頁問題',exact:true})).toHaveValue('');
  await expect(page.locator('[data-page-spirit-guide-target="true"]')).toHaveCount(0);
  await expect(page.locator('.guide-gallery')).toHaveCount(0);
  await panel(page).getByRole('button',{name:'角色六視圖',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'龍娘角色六視圖',exact:true})).toBeVisible();
  // The existing app session-end event also tears down an active modal immediately.
  await page.evaluate(()=>window.dispatchEvent(new Event('freedom-game-console-session-end')));
  await expect(page.locator('.guide-gallery')).toHaveCount(0);await expect(panel(page)).toHaveCount(0);
  await openSpirit(page);await expect(line(page)).toHaveText(home.entryLine);
});

test('Escape interrupts native guide scrolling and prevents late focus after inline collapse',async({page})=>{
  test.setTimeout(90_000);
  await registerJoined(page);await navigate(page,'社群活動');
  await page.setViewportSize({width:320,height:360});await page.emulateMedia({reducedMotion:'no-preference'});
  await openSpirit(page);await useInstantText(page);await closeSpirit(page);
  const definition=getSpiritGuide('events','events:topic-2')!;
  await widget(page).getByRole('button',{name:'帶我看',exact:true}).click();
  const cancelled=await widget(page).locator('.page-spirit-guide-directory').getByRole('button',{name:definition.label,exact:true}).evaluate(async(element,selector)=>{
    const target=document.querySelector<HTMLElement>(selector)!,before=document.activeElement;
    let focuses=0;const focused=()=>{focuses++};target.addEventListener('focus',focused);
    // Interrupt in the same task, before the queued post-collapse focus can run.
    (element as HTMLButtonElement).click();
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
    await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
    target.removeEventListener('focus',focused);
    return {focuses,sameFocus:document.activeElement===before,marked:target.hasAttribute('data-page-spirit-guide-target')};
  },definition.steps[0].selector);
  expect(cancelled).toEqual({focuses:0,sameFocus:true,marked:false});
  await expect(widget(page)).toHaveAttribute('data-mode','closed');await expect(guide(page)).toHaveCount(0);
  for(let cycle=0;cycle<3;cycle++) {
    await widget(page).getByRole('button',{name:'帶我看',exact:true}).click();
    await expect(widget(page)).toHaveAttribute('data-load-state','ready');
    const start=widget(page).locator('.page-spirit-guide-directory').getByRole('button',{name:definition.label,exact:true});
    await page.evaluate(async()=>{window.scrollTo({top:0,behavior:'instant'});await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));});
    const movement=await start.evaluate(async element=>{
      const positions:number[]=[];
      await new Promise<void>((resolve,reject)=>{
        const timeout=setTimeout(()=>{window.removeEventListener('scroll',interrupted);reject(Error('The native guide never began scrolling'));},5000);
        function interrupted() {
          if(!document.querySelector('[data-page-spirit-guide-target="true"]')||scrollY<=0)return;
          window.removeEventListener('scroll',interrupted);clearTimeout(timeout);
          document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
          resolve();
        }
        window.addEventListener('scroll',interrupted);(element as HTMLButtonElement).click();
      });
      const initial=scrollY;
      // Let the inline collapse commit and native scroll anchoring settle first.
      await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
      const start=performance.now();
      while(performance.now()-start<650){positions.push(scrollY);await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));}
      return {initial,positions};
    });
    expect(movement.initial).toBeGreaterThan(0);
    expect(Math.max(...movement.positions)-Math.min(...movement.positions)).toBeLessThanOrEqual(1);
    await expect(widget(page)).toHaveAttribute('data-mode','closed');
    await expect(page.locator('[data-page-spirit-guide-target="true"]')).toHaveCount(0);
    await expect(panel(page)).toHaveCount(0);await expect(actor(page)).toHaveAttribute('data-animating','false');
  }
});
