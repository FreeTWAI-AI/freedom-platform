import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {test, expect, type Page, type Locator, type Route} from './fixtures.js';
import {navigate} from './navigation.js';
import {quickJoin} from './quick-join.js';
import {SPIRIT_CHARACTERS} from '../../apps/portal-web/src/modules/page-spirit/catalog.js';
import {TAB_TITLES} from '../../apps/portal-web/src/Navigation.js';
import type {TabId} from '../../apps/portal-web/src/types.js';
import type {SpiritPack} from '../../apps/portal-web/src/modules/page-spirit/core.js';

const home = JSON.parse(readFileSync(new URL('../../apps/portal-web/src/modules/page-spirit/packs/home.json',import.meta.url),'utf8')) as SpiritPack;
const skills = JSON.parse(readFileSync(new URL('../../apps/portal-web/src/modules/page-spirit/packs/skills.json',import.meta.url),'utf8')) as SpiritPack;

const password = 'freedom-npc-synthetic-member-2026';
const widget = (page: Page) => page.locator('.page-spirit-widget');
const panel = (page: Page) => page.locator('.page-spirit-panel');
const line = (page: Page) => panel(page).locator('.page-spirit-line p');
const actor = (page: Page) => panel(page).locator('.page-spirit-portrait');

async function registerJoined(page: Page) {
  await page.context().route(url => !['127.0.0.1','localhost'].includes(url.hostname), route => route.abort());
  const nickname = `龍娘測試${randomUUID().slice(0,8)}`;
  const email = `page-spirit-${randomUUID()}@example.test`;
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
  await expect(widget(page)).toHaveAttribute('data-page-id','home');
  await expect(widget(page).locator('.page-spirit-launcher')).toBeVisible();
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
}

async function ask(page: Page, question: string) {
  await panel(page).getByRole('textbox',{name:'問本頁問題',exact:true}).fill(question);
  await panel(page).getByRole('button',{name:'送出',exact:true}).click();
  await finishLine(page);
}

async function closeSpirit(page: Page) {
  await panel(page).getByRole('button',{name:'結束交談',exact:true}).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(widget(page).locator('.page-spirit-launcher')).toBeFocused();
}

function collectArtRequests(page: Page) {
  const requests: {pageId:string; part:string}[] = [];
  page.on('request',request => {
    const match = new URL(request.url()).pathname.match(/\/art\/page-spirit\/v2-20261002\/([^/]+)\/([^/]+)\.webp$/);
    if (match) requests.push({pageId:match[1],part:match[2]});
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

test('joined member loads only the current portrait before opening and each permitted tab owns its character', async ({page}) => {
  test.setTimeout(120_000);
  const requests = collectArtRequests(page);
  await registerJoined(page);
  await expect(widget(page).locator('.page-spirit-launcher img')).toHaveJSProperty('complete',true);
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every(request=>request.pageId==='home' && request.part==='portrait')).toBe(true);
  const businessWrites: string[] = [];
  page.on('request',request=>{if(!['GET','HEAD','OPTIONS'].includes(request.method()) && new URL(request.url()).pathname.startsWith('/api/v1/'))businessWrites.push(new URL(request.url()).pathname);});
  await openSpirit(page);
  await expect(line(page)).toHaveText(home.entryLine);
  await expect(panel(page)).toHaveAttribute('aria-modal','false');
  await expect(panel(page).locator('.page-spirit-nameplate strong')).toHaveText(home.characterName);
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
    await expect(launcher.locator('img')).toHaveAttribute('src',character.portrait);
    await expect(launcher.locator('img')).toHaveJSProperty('complete',true);
    expect(await launcher.locator('img').evaluate(image=>(image as HTMLImageElement).naturalWidth>0)).toBe(true);
    observedNames.add(character.name);
  }
  expect(observedNames.size).toBe(25);
  expect(requests.filter(request=>request.part!=='portrait').every(request=>request.pageId==='home')).toBe(true);
});

test('page-only FAQ and raw-input privacy survive a delayed old-page pack and cross-page reset', async ({page}) => {
  test.setTimeout(90_000);
  await registerJoined(page);
  let release!: () => void;
  const hold = new Promise<void>(resolve=>{release=resolve;});
  let settled!: () => void, intercepted = false;
  const routeFinished = new Promise<void>(resolve=>{settled=resolve;});
  const routeErrors: unknown[] = [];
  const skillPack = (url: URL) => /\/assets\/skills-[^/]+\.js$/.test(url.pathname) || url.pathname.endsWith('/packs/skills.json');
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
    await expect(panel(page).locator('.page-spirit-nameplate strong')).toHaveText(skills.characterName);
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
    await expect(panel(page).locator('.page-spirit-sr[role=status]').filter({hasText:home.entryLine})).toHaveCount(1);
  } finally {
    release();
    if (intercepted) await routeFinished;
    if (!page.isClosed()) await page.unroute(skillPack,delayedPack);
  }
});

test('console drafts, the existing page dialog and outside form focus suppress the NPC without stealing data', async ({page}) => {
  test.setTimeout(90_000);
  await registerJoined(page);
  const help = page.locator('.topbar').getByRole('button',{name:'頁面說明',exact:true});
  const original = page.getByRole('dialog',{name:'會員首頁：頁面說明',exact:true});
  const focused = () => page.evaluate(() => {
    const element = document.activeElement;
    return {tag:element?.tagName,id:element?.id,label:element?.getAttribute('aria-label')};
  });
  // Existing PageTools removes its native dialog on X rather than invoking
  // close() first. Compare its actual baseline; NPC must not take that focus.
  await help.click(); await expect(original).toBeVisible();
  await original.getByRole('button',{name:'關閉',exact:true}).click();
  await expect(original).toHaveCount(0);
  await expect(widget(page).locator('.page-spirit-launcher')).toBeVisible();
  const originalCloseFocus = await focused();
  await openSpirit(page);
  await page.getByRole('button',{name:'展開訊息控制台',exact:true}).click();
  const dock = page.getByRole('complementary',{name:'訊息控制台',exact:true});
  await expect(dock).toBeVisible(); await expect(widget(page)).toHaveCount(0);
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
  await expect(original).toBeVisible(); await expect(widget(page)).toHaveCount(0);
  await original.getByRole('button',{name:'關閉',exact:true}).click(); await expect(original).toHaveCount(0);
  await expect(widget(page).locator('.page-spirit-launcher')).toBeVisible();
  expect(await focused()).toEqual(originalCloseFocus);
  await expect(widget(page).locator('.page-spirit-launcher')).not.toBeFocused();
  await navigate(page,'工坊夥伴'); await openSpirit(page);
  const search = page.getByLabel('搜尋夥伴',{exact:true}), privateSearch = `unsent-profile-${randomUUID()}`;
  await search.fill(privateSearch); await expect(widget(page)).toHaveCount(0); await expect(search).toHaveValue(privateSearch);
  await page.getByRole('heading',{name:'工坊夥伴',level:1,exact:true}).click();
  await expect(widget(page).locator('.page-spirit-launcher')).toBeVisible(); await openSpirit(page);
  await expect(line(page)).not.toContainText(privateSearch); await expect(search).toHaveValue(privateSearch);
});

test('real six-frame playback finishes, cancels under motion controls and keeps phone controls above the console', async ({page}, testInfo) => {
  test.setTimeout(90_000);
  await registerJoined(page); await openSpirit(page);
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
  await openSpirit(page); await panel(page).getByRole('checkbox',{name:'靜態省電',exact:true}).check(); await ask(page,'你好');
  await expect(actor(page)).toHaveAttribute('data-animating','false'); await expect(actor(page).locator('img')).toHaveAttribute('src',SPIRIT_CHARACTERS.home.hero);
  await panel(page).getByRole('checkbox',{name:'靜態省電',exact:true}).uncheck();
  await page.emulateMedia({reducedMotion:'reduce'}); await ask(page,'你好');
  await expect(actor(page)).toHaveAttribute('data-animating','false'); await expect(panel(page).locator('.page-spirit-line')).toHaveAttribute('data-typing','false');
  await page.emulateMedia({reducedMotion:'no-preference'});
  for (const width of [1440,390,320]) {
    await page.setViewportSize({width,height:900});
    await withinViewport(page,panel(page));
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const submit=panel(page).getByRole('button',{name:'送出',exact:true}); await withinViewport(page,submit);
    const rectangle=await submit.boundingBox(); expect(rectangle!.height).toBeGreaterThanOrEqual(44);
    const consoleRect=await page.locator('.game-console').first().boundingBox(), spiritRect=await panel(page).boundingBox();
    expect(consoleRect).not.toBeNull(); expect(spiritRect!.y+spiritRect!.height).toBeLessThanOrEqual(consoleRect!.y-8);
    await page.screenshot({path:testInfo.outputPath(`page-spirit-${width}.png`),fullPage:false});
    await closeSpirit(page);
    await withinViewport(page,page.getByRole('button',{name:'展開訊息控制台',exact:true}));
    await openSpirit(page);
  }
});

test('NPC input and gallery link keep readable contrast under all three real theme settings', async ({page}) => {
  test.setTimeout(90_000);
  await registerJoined(page);
  for (const [label, theme] of [['自由工坊－明亮','light'],['自由工坊－夜航','dark'],['自由工坊－敘生','versefolk']] as const) {
    const settings = page.getByRole('button',{name:'設定',exact:true});
    if (await settings.getAttribute('aria-expanded')!=='true') await settings.click();
    await page.getByRole('menuitemradio',{name:label,exact:true}).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
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
      const input=element.querySelector<HTMLInputElement>('.page-spirit-form input'),link=element.querySelector<HTMLAnchorElement>('.page-spirit-tools a');
      if(!input||!link)throw new Error('NPC contrast targets missing');
      return {input:measure(input),link:measure(link)};
    });
    expect(metrics.input.contrast,`${theme} input: ${JSON.stringify(metrics.input)}`).toBeGreaterThanOrEqual(4.5);
    expect(metrics.link.contrast,`${theme} gallery link: ${JSON.stringify(metrics.link)}`).toBeGreaterThanOrEqual(4.5);
    expect(metrics.input.colorScheme).toContain('dark');
    await closeSpirit(page);
  }
});
