import {test,expect,type Page,type Locator} from './fixtures.js';
import {navigate,openPageTools} from './navigation.js';

type CapabilityWindow=Window&{localCapabilities:{kind:'copy'|'share';value:string|ShareData;active:boolean;resolve:()=>void;reject:(error:Error)=>void}[]};
const languages=[['zh-Hant','繁體中文','複製中…'],['en','English','Copying…'],['ja','日本語','コピー中…'],['ko','한국어','복사 중…'],['es','Español','Copiando…']] as const;

// Controlled browser capabilities, not an OS clipboard or a real social post.
async function holdCapabilities(page:Page,nativeShare=false){
  await page.addInitScript(native=>{
    const w=window as unknown as CapabilityWindow;w.localCapabilities=[];
    function hold(kind:'copy'|'share',value:string|ShareData){return new Promise<void>((resolve,reject)=>w.localCapabilities.push({kind,value,active:navigator.userActivation.isActive,resolve,reject}));}
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:(value:string)=>hold('copy',value)}});
    Object.defineProperty(navigator,'share',{configurable:true,value:native?(value:ShareData)=>hold('share',value):undefined});
  },nativeShare);
}
async function finish(page:Page,index=0,error?:'denied'|'cancel'){
  await page.evaluate(({index,error})=>{const call=(window as unknown as CapabilityWindow).localCapabilities[index];if(error)call.reject(new DOMException(error,error==='cancel'?'AbortError':'NotAllowedError'));else call.resolve();},{index,error});
}
const calls=(page:Page)=>page.evaluate(()=>(window as unknown as CapabilityWindow).localCapabilities.map(({kind,value,active})=>({kind,value,active})));
async function login(page:Page){
  await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');
  await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.getByRole('heading',{name:'會員首頁',level:1,exact:true})).toBeVisible();
}
async function capture(page:Page,dialog:Locator,name:string){
  for(const theme of ['light','dark','versefolk']){
    await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);
    expect(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:test.info().outputPath(`${name}-${theme}.png`),animations:'disabled'});
    const paints=await dialog.locator('button[aria-busy="true"]').evaluateAll(buttons=>buttons.map(button=>{
      const channels=(value:string)=>{if(!/^rgba?\(/.test(value))throw new Error(`Unsupported measured colour: ${value}`);const parts=value.match(/[\d.]+/g)?.map(Number)??[];return [parts[0]??0,parts[1]??0,parts[2]??0,parts[3]??1];};
      const over=(front:number[],back:number[])=>front.slice(0,3).map((value,index)=>value*front[3]!+back[index]!*(1-front[3]!));
      const ancestors:Element[]=[];for(let node:Element|null=button;node;node=node.parentElement)ancestors.unshift(node);
      let background=[255,255,255];for(const node of ancestors)background=over(channels(getComputedStyle(node).backgroundColor),background);
      const style=getComputedStyle(button),foreground=over(channels(style.color),background);
      const luminance=(rgb:number[])=>rgb.map(value=>{const channel=value/255;return channel<=.04045?channel/12.92:((channel+.055)/1.055)**2.4;}).reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index]!,0);
      const front=luminance(foreground),back=luminance(background);
      return {text:button.textContent,color:style.color,background:style.backgroundColor,compositedBackground:background,opacity:Number(style.opacity),contrast:(Math.max(front,back)+.05)/(Math.min(front,back)+.05)};
    }));
    await test.info().attach(`${name}-${theme}-contrast`,{body:JSON.stringify(paints,null,2),contentType:'application/json'});
    expect(paints.length).toBeGreaterThan(0);
    for(const paint of paints){expect(paint.opacity).toBe(1);expect(paint.contrast).toBeGreaterThanOrEqual(4.5);}
  }
}
async function pageHelp(page:Page){await openPageTools(page);await page.getByRole('button',{name:'頁面說明',exact:true}).click();return page.getByRole('dialog',{name:'會員首頁：頁面說明',exact:true});}
async function optimization(page:Page){
  await page.getByRole('button',{name:'建立貼文',exact:true}).click();const dialog=page.getByRole('dialog',{name:'建立貼文',exact:true});
  await dialog.getByLabel('貼文內容',{exact:true}).fill('本週展示自己的作品，尋找一起做事的夥伴。');
  await dialog.getByRole('button',{name:'✦ Social Post 優化',exact:true}).click();await dialog.getByRole('button',{name:'到自己的 AI 工具',exact:true}).click();return dialog;
}
async function promotion(page:Page){
  await navigate(page,'推廣排行榜');await page.getByRole('button',{name:'分享自由工坊',exact:true}).click();const dialog=page.getByRole('dialog',{name:'分享「自由工坊」',exact:true});
  await expect(dialog.locator('.skill-share-url')).toHaveText(/\/go\/[A-Za-z0-9_-]{10}$/);return dialog;
}
async function skill(page:Page){
  await page.route('**/api/v1/skills/social-post/share-content',route=>route.fulfill({json:{introductions:['一起學會整理真實的社群貼文。','先寫好，再親自分享給朋友。'],illustration_url:'',illustration_alt:''}}));
  await navigate(page,'技能書架');await page.getByRole('button',{name:'未解鎖',exact:true}).click();const library=page.locator('.community-library');
  await library.getByLabel('搜尋技能書',{exact:true}).fill('社群貼文');await library.locator('article[data-book-id="social-post"]').getByRole('button',{name:'分享技能',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'分享「Hao 社群貼文技能書」',exact:true});await expect(dialog.locator('.skill-share-url')).toHaveText(/\/go\/[A-Za-z0-9_-]{10}\?intro=\d+$/);return dialog;
}

test('positive control: a real caller shows success only after the controlled clipboard ACK',async({page})=>{
  await holdCapabilities(page);await login(page);const dialog=await pageHelp(page);
  await dialog.getByRole('button',{name:'複製指令',exact:true}).click();await expect.poll(()=>calls(page)).toHaveLength(1);
  await expect(dialog.getByRole('button',{name:'已複製',exact:true})).toHaveCount(0);expect((await calls(page))[0].value).toContain('頁面標記 page:home');
  await finish(page);await expect(dialog.getByRole('button',{name:'已複製',exact:true})).toBeVisible();
});

test('page instructions immediately show copying, reject duplicates and recover from clipboard denial',async({page})=>{
  await page.setViewportSize({width:320,height:844});await holdCapabilities(page);await login(page);const dialog=await pageHelp(page);
  const copy=dialog.locator('.page-tools-agent button');await copy.click();await capture(page,dialog,'page-copy-pending');
  await expect(copy).toHaveText('複製中…');await expect(copy).toBeDisabled();await expect(copy).toHaveAttribute('aria-busy','true');
  await copy.dispatchEvent('click');expect(await calls(page)).toHaveLength(1);expect((await calls(page))[0].active).toBe(true);
  await finish(page,0,'denied');await expect(copy).toBeEnabled();await expect(dialog.getByRole('alert')).toContainText('手動複製');await expect(dialog.locator('.page-tools-agent pre')).toContainText('頁面標記 page:home');
  await copy.click();await finish(page,1);await expect(copy).toHaveText('已複製');await expect(dialog.locator('.page-tools-agent [role=alert]')).toHaveCount(0);
});

test('closing and reopening page tools ignores the old copy ACK and keeps one pending capability',async({page})=>{
  await holdCapabilities(page);await login(page);let dialog=await pageHelp(page);await dialog.locator('.page-tools-agent button').click();
  await dialog.getByRole('button',{name:'關閉',exact:true}).click();dialog=await pageHelp(page);
  await expect(dialog.locator('.page-tools-agent button')).toBeDisabled();expect(await calls(page)).toHaveLength(1);
  await finish(page);await expect(dialog.locator('.page-tools-agent button')).toBeEnabled();await expect(dialog.getByRole('button',{name:'已複製',exact:true})).toHaveCount(0);
  await dialog.locator('.page-tools-agent button').click();await finish(page,1);await expect(dialog.getByRole('button',{name:'已複製',exact:true})).toBeVisible();
});

for(const [id,name,pending] of languages)test(`${id}: Social Post handoff shows localized pending feedback and exports once`,async({page})=>{
  await page.setViewportSize({width:320,height:844});await holdCapabilities(page);await login(page);
  await page.locator('.settings-menu-button').click();await page.getByRole('menuitemradio',{name,exact:true}).click();await page.keyboard.press('Escape');await expect(page.locator('html')).toHaveAttribute('lang',id);
  const dialog=await optimization(page),button=dialog.locator('.social-post-optimizer > button').filter({hasText:'複製文案優化任務'});
  await button.click();await capture(page,dialog,`optimizer-${id}-pending`);const pendingButton=dialog.getByRole('button',{name:pending,exact:true});
  await expect(pendingButton).toBeDisabled();await expect(pendingButton).toHaveAttribute('aria-busy','true');await pendingButton.dispatchEvent('click');expect(await calls(page)).toHaveLength(1);
  expect((await calls(page))[0].value).toContain('本週展示自己的作品');await expect(dialog.getByRole('status').filter({hasText:'任務已複製'})).toHaveCount(0);
  await finish(page);await expect(dialog.getByRole('status').filter({hasText:'任務已複製'})).toBeVisible();await expect(dialog.getByRole('button',{name:'複製文案優化任務',exact:true})).toBeEnabled();
});

test('editing during a handoff copy retains the captured original but suppresses stale completion feedback',async({page})=>{
  await holdCapabilities(page);await login(page);const dialog=await optimization(page),source=dialog.getByLabel('貼文內容',{exact:true});
  await dialog.getByRole('button',{name:'複製文案優化任務',exact:true}).click();await source.fill('地點已更新，新的內容不能被舊結果覆蓋。');
  await finish(page);await expect(dialog.getByRole('button',{name:'複製文案優化任務',exact:true})).toBeEnabled();await expect(dialog.getByRole('status').filter({hasText:'任務已複製'})).toHaveCount(0);
  await dialog.getByLabel('貼回 AI 優化結果',{exact:true}).fill('這是依舊原稿寫成的版本。');await expect(dialog.getByRole('button',{name:'採用這版文案',exact:true})).toBeDisabled();
  await expect(source).toHaveValue('地點已更新，新的內容不能被舊結果覆蓋。');expect((await calls(page))[0].value).not.toContain('地點已更新');
});

test('promotion copy locks related share actions until ACK and selects exact manual content on denial',async({page})=>{
  await page.setViewportSize({width:320,height:844});await holdCapabilities(page);await login(page);const dialog=await promotion(page),url=await dialog.locator('.skill-share-url').innerText();
  await dialog.getByRole('button',{name:'複製連結',exact:true}).click();await capture(page,dialog,'promotion-copy-pending');
  const pending=dialog.getByRole('button',{name:'複製中…',exact:true});await expect(pending).toBeDisabled();await expect(dialog.getByRole('button',{name:'分享',exact:true})).toBeDisabled();
  await pending.dispatchEvent('click');expect(await calls(page)).toHaveLength(1);await finish(page,0,'denied');const manual=dialog.getByLabel('手動複製分享內容',{exact:true});
  await expect(manual).toBeFocused();expect(await manual.inputValue()).toBe((await calls(page))[0].value);expect(await manual.inputValue()).toContain(url);await expect(dialog).not.toContainText('已複製連結');
  await dialog.getByRole('button',{name:'複製連結',exact:true}).click();await finish(page,1);await expect(dialog.getByRole('status')).toHaveText('已複製連結');await expect(manual).toHaveCount(0);
});

test('promotion native share shows waiting, retains direct user activation and cancels without copying',async({page})=>{
  await holdCapabilities(page,true);await login(page);const dialog=await promotion(page);await dialog.getByRole('button',{name:'分享',exact:true}).click();
  const pending=dialog.getByRole('button',{name:'分享中…',exact:true});await expect(pending).toBeDisabled();await expect(dialog.getByRole('button',{name:'複製連結',exact:true})).toBeDisabled();
  expect((await calls(page))[0].active).toBe(true);await pending.dispatchEvent('click');expect(await calls(page)).toHaveLength(1);await finish(page,0,'cancel');
  await expect(dialog.getByRole('button',{name:'分享',exact:true})).toBeEnabled();await expect(dialog.getByRole('status')).toHaveCount(0);await expect(dialog.getByRole('textbox')).toHaveCount(0);expect(await calls(page)).toHaveLength(1);
});

for(const native of [false,true])test(`skill share ${native?'native':'copy'} waits visibly and does not leak old ACK into a reopened preview`,async({page})=>{
  await page.setViewportSize({width:320,height:844});await holdCapabilities(page,native);await login(page);let dialog=await skill(page);
  await dialog.getByRole('button',{name:native?'分享':'複製介紹與連結',exact:true}).click();await capture(page,dialog,`skill-${native?'share':'copy'}-pending`);
  const pending=dialog.getByRole('button',{name:native?'分享中…':'複製中…',exact:true});await expect(pending).toBeDisabled();await expect(dialog.getByRole('button',{name:'換一句',exact:true})).toBeDisabled();
  await pending.dispatchEvent('click');expect(await calls(page)).toHaveLength(1);await page.keyboard.press('Escape');await expect(dialog).toBeHidden();
  await page.locator('article[data-book-id="social-post"]').getByRole('button',{name:'分享技能',exact:true}).click();dialog=page.getByRole('dialog',{name:'分享「Hao 社群貼文技能書」',exact:true});await expect(dialog).toBeVisible();
  await finish(page,0,native?'cancel':undefined);await expect(dialog.getByRole('button',{name:native?'分享':'複製介紹與連結',exact:true})).toBeEnabled();await expect(dialog.getByRole('status')).toHaveCount(0);
  expect(await calls(page)).toHaveLength(1);
});

for(const denied of [false,true])test(`public card copy ${denied?'denial':'ACK'} keeps the contact readable while waiting`,async({page})=>{
  await page.setViewportSize({width:320,height:844});await holdCapabilities(page);
  const token='A'.repeat(43);await page.route(`**/api/v1/public/member-cards/${token}`,route=>route.fulfill({json:{nickname:'合成名片作者',design:'calm',headline:'一起做出作品',primary_guild:null,capabilities:[],avatar_url:null,links:[],profile_links:[{platform:'discord',label:'Discord',handle:'synthetic-maker',url:null}]}}));
  await page.goto(`/member-cards/${token}`);const copy=page.getByRole('button',{name:'複製 Discord 帳號',exact:true});await expect(copy).toBeVisible();const before=await copy.boundingBox();await copy.click();await capture(page,page.locator('.ecard'),'ecard-copy-pending');
  await expect(copy).toBeDisabled();await expect(copy).toHaveAttribute('aria-busy','true');await expect(page.locator('.ecard-copy-status')).toHaveText('複製中…');await expect(copy).toContainText('synthetic-maker');
  const visible=copy.locator('.ecard-copy-visible');await expect(visible).toBeVisible();await expect(visible).toHaveText('複製中…');await expect(copy).toHaveCSS('opacity','1');const waiting=await copy.boundingBox();expect(Math.abs(waiting!.width-before!.width)).toBeLessThanOrEqual(1);expect(Math.abs(waiting!.height-before!.height)).toBeLessThanOrEqual(1);expect(waiting!.height).toBeGreaterThanOrEqual(44);
  await copy.dispatchEvent('click');expect(await calls(page)).toHaveLength(1);await finish(page,0,denied?'denied':undefined);await expect(copy).toBeEnabled();
  if(denied){const field=page.getByRole('textbox',{name:'Discord 帳號',exact:true});await expect(field).toHaveValue('synthetic-maker');await expect(field).toBeFocused();await expect(page.locator('.ecard-copy-status')).toHaveText('');}
  else {await expect(page.locator('.ecard-copy-status')).toHaveText('已複製');await expect(visible).toBeVisible();await expect(visible).toHaveText('已複製');}
});
