import {randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {e2eOrigin} from '../../packages/testing/e2e-origin.js';
import {test,expect,type Locator,type Page} from './fixtures.js';
import {navigate} from './navigation.js';
import {quickJoin} from './quick-join.js';
const SHOTS=process.env.AUDIT_EVIDENCE_DIR??'test-results/member-ecard';
const LINK_SHOTS=process.env.AUDIT_EVIDENCE_DIR??'test-results/member-ecard-linktree';
mkdirSync(SHOTS,{recursive:true});
mkdirSync(LINK_SHOTS,{recursive:true});
const designs=[['清新','calm','rgb(255, 255, 255)','column'],['工坊','workshop','rgb(255, 253, 248)','column'],['夜空','night','rgb(20, 22, 27)','column'],['經典名片','classic','rgb(246, 248, 251)','row']] as const;
const widths=[{width:390,height:844},{width:820,height:900},{width:1280,height:900}] as const;

async function signup(page:Page,name:string){
  await page.goto('/');
  await page.getByRole('button',{name:'建立帳號',exact:true}).click();
  await page.getByLabel('社群顯示名稱',{exact:true}).fill(name);
  await page.getByLabel('電子郵件',{exact:true}).fill(`ecard-${randomUUID()}@example.test`);
  await page.getByLabel('密碼',{exact:true}).fill('freedom-connections-password');
  await page.getByRole('button',{name:'建立帳號，先逛工坊',exact:true}).click();
  await expect(page.getByRole('heading',{name:`${name}，歡迎來到自由工坊。`})).toBeVisible();
  await quickJoin(page);
  await expect(page.getByRole('heading',{name:'會員首頁',level:1})).toBeVisible();
}
async function contrast(page:Page,selector:string){
  return page.locator(selector).first().evaluate(element=>{
    const channel=(value:number)=>value<=0.03928?value/12.92:((value+0.055)/1.055)**2.4;
    const parts=(color:string)=>color.match(/[\d.]+/g)?.map(Number)??[0,0,0,0];
    const lum=(color:string)=>{const [r,g,b]=parts(color);return 0.2126*channel(r/255)+0.7152*channel(g/255)+0.0722*channel(b/255);};
    const paint=(node:Element|null):string=>{let current=node;while(current){const color=getComputedStyle(current).backgroundColor;const bits=parts(color);if(color!=='rgba(0, 0, 0, 0)'&&(bits[3]??1)>0.2)return color;current=current.parentElement;}return getComputedStyle(document.body).backgroundColor;};
    const foreground=lum(getComputedStyle(element).color),surface=lum(paint(element));
    return (Math.max(foreground,surface)+0.05)/(Math.min(foreground,surface)+0.05);
  });
}

test('member builds an e-card and visitors see each design',async({page,browser})=>{
  test.setTimeout(240000);
  await page.addInitScript(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('blocked');}}});});
  await page.setViewportSize({width:1280,height:900});
  await signup(page,'電子名片作者');
  await navigate(page,'我的名片');
  const settings=page.getByRole('region',{name:'分享我的工坊名片'});
  const preview=settings.getByRole('complementary',{name:'名片預覽'}).locator('.ecard');
  await expect(settings.getByRole('button',{name:'清新',exact:true})).toBeVisible();
  for(const [name,design,color,direction] of designs){
    await settings.getByRole('button',{name,exact:true}).click();
    await expect(preview).toHaveAttribute('data-design',design);
    await expect.poll(()=>preview.evaluate(element=>getComputedStyle(element).backgroundColor)).toBe(color);
    await expect.poll(()=>preview.locator('.ecard-identity').evaluate(element=>getComputedStyle(element).flexDirection)).toBe(direction);
    await page.screenshot({path:`${SHOTS}/preview-${design}-1280.png`,fullPage:true});
  }
  await settings.getByLabel('一句話介紹').fill('做開源的人');
  await settings.getByRole('button',{name:'清新',exact:true}).click();
  const draft=settings.locator('.ecard-link-draft');
  await draft.getByLabel('連結名稱').fill('作品甲');
  await draft.getByLabel('連結網址').fill('https://example.com/a');
  await draft.getByRole('button',{name:'加入連結',exact:true}).click();
  await draft.getByLabel('連結名稱').fill('作品乙');
  await draft.getByLabel('連結網址').fill('https://example.com/b');
  await draft.getByRole('button',{name:'加入連結',exact:true}).click();
  await settings.getByRole('button',{name:'上移第 2 個連結 作品乙',exact:true}).click();
  const rows=settings.locator('.ecard-link-list > li');
  await expect(rows.nth(0)).toContainText('作品乙');
  await expect(rows.nth(1)).toContainText('作品甲');
  await settings.getByRole('button',{name:'移除第 2 個連結 作品甲',exact:true}).click();
  await expect(settings.locator('.ecard-link-list')).not.toContainText('作品甲');
  await expect(preview.getByRole('link',{name:/作品乙/})).toBeVisible();
  const social=page.locator('.social-links-editor');
  await social.getByRole('button',{name:'＋ 新增連結',exact:true}).click();
  const socialForm=social.getByRole('form',{name:'新增社群連結'});
  await socialForm.getByRole('combobox',{name:'平台',exact:true}).selectOption('website');
  await socialForm.getByRole('textbox',{name:'連結名稱',exact:true}).fill('我的網站');
  await socialForm.getByRole('textbox',{name:'連結網址',exact:true}).fill('https://example.com/site');
  await socialForm.getByRole('button',{name:'保存連結',exact:true}).click();
  await expect(social.getByText('社群連結已新增。')).toBeVisible();
  await settings.getByRole('button',{name:'從我的社群連結加入',exact:true}).click();
  await expect(settings.locator('.ecard-link-list')).not.toContainText('我的網站');
  await settings.getByRole('button',{name:'把「我的網站」加入名片',exact:true}).click();
  await expect(settings.locator('.ecard-link-list')).toContainText('我的網站');
  await settings.getByRole('button',{name:'建立分享連結',exact:true}).click();
  const openCard=settings.getByRole('link',{name:'開啟名片',exact:true});
  await expect(openCard).toBeVisible({timeout:20000});
  const shareUrl=await openCard.getAttribute('href');
  expect(shareUrl).toMatch(/\/member-cards\/[A-Za-z0-9_-]{43}$/);
  const share=settings.getByRole('button',{name:'分享名片',exact:true});
  await expect(share).toBeEnabled();
  await share.click();
  const dialog=page.getByRole('dialog',{name:'分享「電子名片作者的工坊名片」',exact:true});
  await expect(dialog.locator('.skill-share-url')).toHaveText(/\/go\/[A-Za-z0-9_-]{10}$/);
  await dialog.getByRole('button',{name:'複製連結',exact:true}).click();
  await expect(dialog.getByText('無法自動複製，請選取並複製下方內容')).toBeVisible();
  await expect.poll(()=>dialog.getByLabel('手動複製分享內容').evaluate(element=>{const input=element as HTMLTextAreaElement;return document.activeElement===input&&input.selectionStart===0&&input.selectionEnd===input.value.length;})).toBe(true);
  await dialog.getByRole('button',{name:'關閉分享',exact:true}).click();
  await page.screenshot({path:`${SHOTS}/settings-1280.png`,fullPage:true});
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`${SHOTS}/settings-390.png`,fullPage:true});
  await page.setViewportSize({width:1280,height:900});
  const guestContext=await browser.newContext(),guest=await guestContext.newPage();
  try{
    for(const [name,design,,direction] of designs){
      const choice=settings.getByRole('button',{name,exact:true});
      if(await choice.getAttribute('aria-pressed')!=='true'){
        const saved=page.waitForResponse(response=>response.url().includes('/api/v1/me/member-card-share')&&response.request().method()==='POST');
        await choice.click();
        const body=await (await saved).json();
        expect(body.design).toBe(design);
        await expect(settings.locator('.ecard-save-status')).toContainText('已自動儲存，分享頁就是這個樣子。');
      }
      await expect(settings.getByRole('link',{name:'開啟名片',exact:true})).toHaveAttribute('href',shareUrl!);
      for(const viewport of widths){
        await guest.setViewportSize(viewport);
        await guest.goto(shareUrl!);
        await expect(guest.getByRole('heading',{name:'電子名片作者的工坊名片'})).toBeVisible();
        await expect(guest.getByText('做開源的人')).toBeVisible();
        await expect(guest.locator('.public-member-page')).toHaveAttribute('data-design',design);
        await expect(guest.locator('.ecard')).toHaveAttribute('data-design',design);
        await expect.poll(()=>guest.locator('.ecard-identity').evaluate(element=>getComputedStyle(element).flexDirection)).toBe(direction);
        const link=guest.getByRole('link',{name:/作品乙/});
        await expect(link).toHaveAttribute('rel','noopener noreferrer nofollow ugc');
        await expect(link).toHaveAttribute('target','_blank');
        await expect(link.locator('small')).toHaveText('example.com');
        await expect(guest.getByRole('button',{name:'加入自由工坊／登入'})).toBeVisible();
        expect(await guest.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
        for(const selector of ['.ecard-name','.ecard-guild','.ecard-link span','.ecard-link small','.ecard-kicker'])expect(await contrast(guest,selector),`${design} ${viewport.width} ${selector}`).toBeGreaterThanOrEqual(4.5);
        await guest.screenshot({path:`${SHOTS}/public-${design}-${viewport.width}.png`,fullPage:true});
      }
    }
  }finally{await guestContext.close();}
});

const GUEST_UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const themes=[['自由工坊－明亮','light'],['自由工坊－夜航','dark'],['自由工坊－敘生','versefolk']] as const;

async function applyTheme(page:Page,label:string,id:string){
  const menu=page.getByRole('button',{name:'設定',exact:true});
  if(await menu.getAttribute('aria-expanded')!=='true')await menu.click();
  await page.getByRole('menuitemradio',{name:label,exact:true}).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme',id);
  if(await menu.getAttribute('aria-expanded')==='true')await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded','false');
  await page.waitForTimeout(200);
}

test('sharing a member card from 我的名片 scores one guest click',async({page,browser})=>{
  test.setTimeout(240000);
  await page.setViewportSize({width:1280,height:900});
  await signup(page,'名片推廣作者');
  await navigate(page,'我的名片');
  const settings=page.getByRole('region',{name:'分享我的工坊名片'});
  await settings.getByRole('button',{name:'建立分享連結',exact:true}).click();
  const share=settings.getByRole('button',{name:'分享名片',exact:true});
  const openCard=settings.getByRole('link',{name:'開啟名片',exact:true});
  await expect(share).toBeEnabled();
  await expect(openCard).toHaveAttribute('href',/\/member-cards\/[A-Za-z0-9_-]{43}$/);
  let go='';
  for(const [label,id] of themes){
    await applyTheme(page,label,id);
    for(const width of [1280,820,390] as const){
      await page.setViewportSize({width,height:width===390?844:900});
      await page.waitForTimeout(200);
      const shareBox=await share.boundingBox();
      const openBox=await openCard.boundingBox();
      const section=await settings.boundingBox();
      expect(shareBox!.height).toBeGreaterThanOrEqual(44);
      expect(openBox!.height).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      if(width===390){
        expect(shareBox!.width).toBeGreaterThan(section!.width*0.8);
        expect(openBox!.width).toBeGreaterThan(section!.width*0.8);
      }else{
        expect(Math.abs(shareBox!.y-openBox!.y)).toBeLessThanOrEqual(4);
        expect(shareBox!.width).toBeLessThan(section!.width*0.6);
      }
      if(id!=='versefolk'&&(width===1280||width===390)){
        await settings.locator('.member-card-share-actions').screenshot({path:`${SHOTS}/member-card-share-area-${id}-${width}.png`});
      }
    }
    await page.setViewportSize({width:1280,height:900});
    await share.click();
    const dialog=page.getByRole('dialog',{name:'分享「名片推廣作者的工坊名片」',exact:true});
    const url=dialog.locator('.skill-share-url');
    await expect(url).toHaveText(/\/go\/[A-Za-z0-9_-]{10}$/);
    await expect(dialog).toContainText('一起加入自由工坊，找到夥伴、學習與創作。');
    if(!go)go=(await url.innerText()).trim();
    else await expect(url).toHaveText(go);
    for(const width of [1280,820,390] as const){
      await page.setViewportSize({width,height:width===390?844:900});
      await page.waitForTimeout(200);
      const box=await dialog.boundingBox();
      const titleBox=await dialog.getByRole('heading',{level:2}).boundingBox();
      const closeBox=await dialog.getByRole('button',{name:'關閉分享',exact:true}).boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.width).toBeLessThanOrEqual(width);
      expect(titleBox!.width).toBeGreaterThan(160);
      expect(titleBox!.height).toBeLessThan(96);
      expect(closeBox!.width).toBeLessThan(160);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      if(id!=='versefolk'&&(width===1280||width===390))await dialog.screenshot({path:`${SHOTS}/member-card-share-dialog-${id}-${width}.png`});
    }
    await dialog.getByRole('button',{name:'關閉分享',exact:true}).click();
    await expect(dialog).toBeHidden();
  }
  const context=await browser.newContext({userAgent:GUEST_UA,viewport:{width:1280,height:900}});
  const guest=await context.newPage();
  try{
    const clicked=guest.waitForResponse(response=>response.url().includes('/api/v1/promotion/clicks')&&response.request().method()==='POST');
    await guest.goto(go);
    expect((await clicked).ok()).toBe(true);
    await expect(guest).toHaveURL(/\/member-cards\/[A-Za-z0-9_-]{43}$/);
    await expect(guest.getByRole('heading',{name:'名片推廣作者的工坊名片'})).toBeVisible();
    await expect(guest.getByRole('button',{name:'加入自由工坊／登入'})).toBeVisible();
  }finally{await context.close();}
  await navigate(page,'推廣排行榜');
  await expect(page.getByRole('button',{name:'本週',exact:true})).toHaveAttribute('aria-pressed','true');
  const board=page.getByRole('article',{name:'名片點擊排行榜',exact:true});
  await expect(board).toContainText('在我的名片分享名片連結，每次點擊 +1。');
  await expect(board).toContainText('名片推廣作者');
  await expect(board).toContainText('我的名次：第 1 名・1 分');
});

const SAVED='已自動儲存，分享頁就是這個樣子。';
function shareRegion(page:Page){return page.getByRole('region',{name:'分享我的工坊名片'});}
async function waitSaved(settings:Locator){await expect(settings.locator('.ecard-save-status')).toContainText(SAVED,{timeout:20000});}
async function openHref(settings:Locator){
  const open=settings.locator('a[href*="/member-cards/"]');
  await expect(open).toHaveAttribute('href',/\/member-cards\/[A-Za-z0-9_-]{43}$/);
  return (await open.getAttribute('href'))!;
}
async function enableShare(settings:Locator){
  await settings.getByRole('button',{name:'建立分享連結',exact:true}).click();
  await expect(settings.getByRole('link',{name:'開啟名片',exact:true})).toBeVisible({timeout:20000});
  return openHref(settings);
}
async function addManual(settings:Locator,label:string,url:string){
  const draft=settings.locator('.ecard-link-draft');
  await draft.getByLabel('連結名稱').fill(label);
  await draft.getByLabel('連結網址').fill(url);
  await draft.getByRole('button',{name:'加入連結',exact:true}).click();
  await expect(settings.locator('.ecard-link-list')).toContainText(label);
  await waitSaved(settings);
}
async function addSocial(page:Page,platform:string,label:string,url:string,audience:'平台公開'|'平台好友'){
  const social=page.locator('.social-links-editor');
  await social.getByRole('button',{name:'＋ 新增連結',exact:true}).click();
  const form=social.getByRole('form',{name:'新增社群連結'});
  await form.getByRole('combobox',{name:'平台',exact:true}).selectOption(platform);
  await form.getByLabel('連結名稱',{exact:true}).fill(label);
  await form.getByLabel('連結網址',{exact:true}).fill(url);
  await form.getByRole('checkbox',{name:audience,exact:true}).check();
  await form.getByRole('button',{name:'保存連結',exact:true}).click();
  await expect(social.getByText('社群連結已新增。')).toBeVisible();
}
function cardText(value:string){return value.replace(/\s+/g,' ').trim();}

test('autosave makes the preview the shared card without a save button',async({page,browser})=>{
  test.setTimeout(240000);
  await page.setViewportSize({width:1280,height:900});
  await signup(page,'連結樹作者');
  await navigate(page,'我的名片');
  const settings=shareRegion(page);
  await expect(settings.getByText('朋友打開連結就能看到你選的樣式、一句話介紹、連結，以及你設為「平台公開」的聯絡方式和社群連結（可逐項隱藏），並從名片加入自由工坊。所有變更都會自動儲存。')).toBeVisible();
  await expect(page.getByRole('button',{name:'保存分享設定'})).toHaveCount(0);
  await expect(settings.getByText('預覽用的是你自己的名片資料，保存後才會更新分享頁。')).toHaveCount(0);
  await settings.getByRole('button',{name:'工坊',exact:true}).click();
  await expect(settings.locator('.ecard-save-status')).toContainText('已自動儲存。建立分享連結後，朋友看到的就是這個樣子。');
  const shareUrl=await enableShare(settings);
  await settings.getByRole('button',{name:'夜空',exact:true}).click();
  await waitSaved(settings);
  await expect(settings.locator('.ecard-preview .ecard')).toHaveAttribute('data-design','night');
  await expect(settings.getByRole('link',{name:'開啟名片',exact:true})).toHaveAttribute('href',shareUrl);
  const guestContext=await browser.newContext(),guest=await guestContext.newPage();
  try{
    await guest.setViewportSize({width:390,height:844});
    await guest.goto(shareUrl);
    await expect(guest.locator('.public-member-page')).toHaveAttribute('data-design','night');
    await expect(guest.locator('.ecard')).toHaveAttribute('data-design','night');
    const headline=settings.getByLabel('一句話介紹');
    await headline.fill('做開源的人');
    await waitSaved(settings);
    await expect(settings.getByRole('link',{name:'開啟名片',exact:true})).toHaveAttribute('href',shareUrl);
    await guest.reload();
    await expect(guest.getByText('做開源的人')).toBeVisible();
    await addManual(settings,'作品甲','https://example.com/a');
    await expect(settings.getByRole('link',{name:'開啟名片',exact:true})).toHaveAttribute('href',shareUrl);
    await guest.reload();
    await expect(guest.getByRole('link',{name:/作品甲/})).toBeVisible();
    await expect(settings.locator('.ecard-preview .ecard-name')).toHaveText('連結樹作者的工坊名片');
    await expect(settings.locator('.ecard-preview .ecard-guild')).toHaveText('AI 開發公會');
    await guest.locator('.ecard').waitFor();
    expect(cardText(await settings.locator('.ecard-preview .ecard').innerText())).toBe(cardText(await guest.locator('.ecard').innerText()));
    await page.reload();
    await navigate(page,'我的名片');
    const reloaded=shareRegion(page);
    await expect(reloaded.getByRole('button',{name:'夜空',exact:true})).toHaveAttribute('aria-pressed','true');
    await expect(reloaded.getByLabel('一句話介紹')).toHaveValue('做開源的人');
    await expect(reloaded.locator('.ecard-link-list')).toContainText('作品甲');
    await expect(reloaded.getByRole('link',{name:'開啟名片',exact:true})).toHaveAttribute('href',shareUrl);
    const tooLong=reloaded.getByLabel('一句話介紹');
    let posts=0;
    const count=(request:{method:()=>string;url:()=>string})=>{if(request.method()==='POST'&&request.url().includes('/api/v1/me/member-card-share'))posts++;};
    page.on('request',count);
    await tooLong.fill('字'.repeat(61));
    await expect(reloaded.getByRole('alert')).toContainText('一句話介紹最多 60 個字。');
    await expect(reloaded.locator('.ecard-save-status')).toContainText('有變更尚未儲存');
    await page.waitForTimeout(1200);
    expect(posts).toBe(0);
    page.off('request',count);
    const open=reloaded.locator('a[href*="/member-cards/"]');
    await expect(open).toHaveAttribute('aria-disabled','true');
    await expect(open).toHaveText('開啟名片');
    let popped=false;
    page.on('popup',()=>{popped=true;});
    await open.click({force:true});
    expect(popped).toBe(false);
    await expect(page).not.toHaveURL(/\/member-cards\//);
  }finally{await guestContext.close();}
});

test('a slow save keeps later headline keystrokes and leaves the field editable',async({page,browser})=>{
  test.setTimeout(240000);
  await page.setViewportSize({width:1280,height:900});
  await signup(page,'慢存作者');
  await navigate(page,'我的名片');
  const settings=shareRegion(page);
  const shareUrl=await enableShare(settings);
  let release=()=>{},held=false;
  const gate=new Promise<void>(resolve=>{release=()=>resolve();});
  await page.route('**/api/v1/me/member-card-share',async route=>{
    if(route.request().method()==='POST'&&!held){held=true;await gate;}
    await route.continue();
  });
  try{
    const headline=settings.getByLabel('一句話介紹');
    await headline.fill('你好');
    await headline.blur();
    const anchor=settings.locator('a[href*="/member-cards/"]');
    await expect(settings.locator('.ecard-save-status')).toContainText('儲存中…');
    await expect(anchor).toHaveText('儲存中…');
    await expect(anchor).toHaveAttribute('aria-disabled','true');
    await expect(anchor).toHaveAttribute('href',shareUrl);
    await headline.focus();
    await headline.evaluate(element=>{const input=element as HTMLInputElement;input.setSelectionRange(input.value.length,input.value.length);});
    await headline.pressSequentially('世界',{delay:40});
    await expect(headline).toBeEnabled();
    await expect(headline).toHaveValue('你好世界');
    await expect(anchor).toHaveAttribute('href',shareUrl);
    release();
    await waitSaved(settings);
    await expect(headline).toBeEnabled();
    await expect(headline).toHaveValue('你好世界');
    await expect(settings.getByRole('link',{name:'開啟名片',exact:true})).toHaveAttribute('href',shareUrl);
    const guestContext=await browser.newContext(),guest=await guestContext.newPage();
    try{await guest.goto(shareUrl);await expect(guest.getByText('你好世界')).toBeVisible();}
    finally{await guestContext.close();}
  }finally{release();await page.unrouteAll({behavior:'ignoreErrors'}).catch(()=>{});}
});

test('a version conflict reloads the card saved on another page',async({page})=>{
  test.setTimeout(240000);
  await page.setViewportSize({width:1280,height:900});
  await signup(page,'衝突作者');
  await navigate(page,'我的名片');
  const settings=shareRegion(page);
  const shareUrl=await enableShare(settings);
  const page2=await page.context().newPage();
  await page2.setViewportSize({width:1280,height:900});
  await page2.goto('/');
  await navigate(page2,'我的名片');
  const other=shareRegion(page2);
  await expect(other.getByRole('link',{name:'開啟名片',exact:true})).toHaveAttribute('href',shareUrl);
  await expect(other.getByRole('button',{name:'夜空',exact:true})).toHaveAttribute('aria-pressed','false');
  let release=()=>{},held=false;
  const gate=new Promise<void>(resolve=>{release=()=>resolve();});
  await page.route('**/api/v1/me/member-card-share',async route=>{
    if(route.request().method()==='POST'&&!held){held=true;await gate;}
    await route.continue();
  });
  try{
    const headline=settings.getByLabel('一句話介紹');
    await headline.fill('先寫這句');
    await headline.blur();
    await expect.poll(()=>held).toBe(true);
    await other.getByRole('button',{name:'夜空',exact:true}).click();
    await waitSaved(other);
    release();
    await expect(settings.locator('.ecard-save-status')).toContainText('名片設定在其他地方更新了，已重新載入最新版本。',{timeout:20000});
    await expect(settings.getByRole('button',{name:'夜空',exact:true})).toHaveAttribute('aria-pressed','true');
    await expect(settings.getByLabel('一句話介紹')).toHaveValue('');
    await expect(settings.getByRole('link',{name:'開啟名片',exact:true})).toHaveAttribute('href',shareUrl);
  }finally{release();await page2.close();await page.unrouteAll({behavior:'ignoreErrors'}).catch(()=>{});}
});

test('platform-public profile links render with brand icons and match the public card',async({page,browser})=>{
  test.setTimeout(240000);
  await page.setViewportSize({width:1280,height:900});
  await signup(page,'圖示名片作者');
  await navigate(page,'我的名片');
  const settings=shareRegion(page);
  const profile=settings.getByRole('region',{name:'社群與聯絡方式'});
  await expect(profile.getByRole('checkbox',{name:'自動放上我設為「平台公開」的聯絡方式和社群連結'})).toBeChecked();
  await expect(profile).toContainText('你還沒有設為「平台公開」的聯絡方式或社群連結。在這頁上方的聯絡方式或社群連結設定公開對象後，就會出現在這裡。');
  await expect(profile).toContainText('拿到名片連結的任何人（不必登入）都看得到這些項目。');
  const account=page.locator('form.account-settings');
  await account.getByLabel('LINE ID',{exact:true}).fill('lineuser');
  await account.getByRole('group',{name:'LINE ID可見範圍',exact:true}).getByRole('checkbox',{name:'平台公開',exact:true}).check();
  await account.getByLabel('GitHub 帳號',{exact:true}).fill('octocat');
  await account.getByRole('group',{name:'GitHub 帳號可見範圍',exact:true}).getByRole('checkbox',{name:'平台公開',exact:true}).check();
  await account.getByLabel('Discord 帳號',{exact:true}).fill('discorduser');
  await account.getByRole('group',{name:'Discord 帳號可見範圍',exact:true}).getByRole('checkbox',{name:'平台公開',exact:true}).check();
  await account.getByRole('button',{name:'保存個人資料與公開範圍',exact:true}).click();
  await expect(page.getByText('個人資料與每一項聯絡方式的可見範圍已保存。')).toBeVisible();
  await expect(profile.getByRole('checkbox',{name:'顯示 LINE 在名片上'})).toBeChecked({timeout:20000});
  await expect(profile.getByRole('checkbox',{name:'顯示 GitHub 在名片上'})).toBeChecked();
  await expect(profile.getByRole('checkbox',{name:'顯示 Discord 在名片上'})).toBeChecked();
  await addSocial(page,'instagram','我的 IG','https://www.instagram.com/workshopcard','平台公開');
  await addSocial(page,'facebook','好友粉專','https://www.facebook.com/friends-only-page','平台好友');
  await expect(profile.getByRole('checkbox',{name:'顯示 我的 IG 在名片上'})).toBeChecked({timeout:20000});
  await expect(profile).not.toContainText('好友粉專');
  const shareUrl=await enableShare(settings);
  const guestContext=await browser.newContext({permissions:['clipboard-read','clipboard-write']});
  const guest=await guestContext.newPage();
  try{
    await guest.setViewportSize({width:390,height:844});
    await guest.goto(shareUrl);
    await expect(guest.locator('.ecard')).toHaveAttribute('data-design','calm');
    await expect(guest.getByRole('link',{name:/LINE/})).toHaveAttribute('href','https://line.me/ti/p/~lineuser');
    await expect(guest.getByRole('link',{name:/GitHub/})).toHaveAttribute('href','https://github.com/octocat');
    await expect(guest.getByRole('button',{name:'複製 Discord 帳號',exact:true})).toBeVisible();
    await expect(guest.getByRole('link',{name:/我的 IG/})).toHaveAttribute('href','https://www.instagram.com/workshopcard');
    await expect(guest.locator('a[href*="facebook.com"]')).toHaveCount(0);
    await expect(guest.locator('a[href^="mailto:"]')).toHaveCount(0);
    await expect(guest.getByText('這是你的名片')).toHaveCount(0);
    await expect(guest.getByRole('button',{name:'加入自由工坊／登入'})).toBeVisible();
    for(const badge of ['line','github','discord','instagram'])await expect(guest.locator(`.ecard .brand-badge[data-platform="${badge}"]`)).toBeVisible();
    await account.getByRole('group',{name:'聯絡 E-mail可見範圍',exact:true}).getByRole('checkbox',{name:'平台公開',exact:true}).check();
    await account.getByRole('button',{name:'保存個人資料與公開範圍',exact:true}).click();
    await expect(profile.getByText('Email 是你的登入帳號，預設不放上名片。')).toBeVisible({timeout:20000});
    await expect(profile.getByRole('checkbox',{name:'顯示 Email 在名片上'})).not.toBeChecked();
    await profile.getByRole('checkbox',{name:'顯示 Email 在名片上'}).check();
    await waitSaved(settings);
    await addSocial(page,'other','其他連結','https://example.org/custom','平台公開');
    await expect(profile.getByRole('checkbox',{name:'顯示 其他連結 在名片上'})).toBeChecked({timeout:20000});
    for(const [label,url] of [['Facebook','https://www.facebook.com/workshop'],['LinkedIn','https://www.linkedin.com/in/workshop'],['YouTube','https://youtu.be/workshopclip'],['Threads','https://www.threads.net/@workshop'],['TikTok','https://www.tiktok.com/@workshop'],['X','https://x.com/workshop'],['個人網站','https://example.net/site']] as const)await addManual(settings,label,url);
    await expect(settings.getByRole('link',{name:'開啟名片',exact:true})).toHaveAttribute('href',shareUrl);
    await expect(settings.locator('.ecard-preview .ecard-name')).toHaveText('圖示名片作者的工坊名片');
    await expect(settings.locator('.ecard-preview .ecard-guild')).toHaveText('AI 開發公會');
    await guest.goto(shareUrl);
    await expect(guest.locator('a[href^="mailto:"]')).toBeVisible();
    await expect(guest.locator('.ecard .brand-badge[data-platform="email"]')).toBeVisible();
    expect(cardText(await settings.locator('.ecard-preview .ecard').innerText())).toBe(cardText(await guest.locator('.ecard').innerText()));
    const platforms=await guest.locator('.ecard-links .brand-badge').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-platform')));
    expect(platforms).toEqual(['line','github','discord','email','instagram','other','facebook','linkedin','youtube','threads','tiktok','x','website']);
    await guest.setViewportSize({width:320,height:700});
    expect(await guest.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect(await guest.locator('.ecard-link').evaluateAll(nodes=>nodes.some(node=>node.scrollWidth>node.clientWidth+1))).toBe(false);
    for(const [name,design] of designs){
      const choice=settings.getByRole('button',{name,exact:true});
      if(await choice.getAttribute('aria-pressed')!=='true'){await choice.click();await waitSaved(settings);}
      await expect(settings.getByRole('link',{name:'開啟名片',exact:true})).toHaveAttribute('href',shareUrl);
      for(const viewport of widths){
        await guest.setViewportSize(viewport);
        await guest.goto(shareUrl);
        await expect(guest.locator('.public-member-page')).toHaveAttribute('data-design',design);
        await expect(guest.locator('.ecard')).toHaveAttribute('data-design',design);
        expect(await guest.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
        if(viewport.width===390)for(const selector of ['.ecard-name','.ecard-guild','.ecard-link span','.ecard-link small','.ecard-kicker'])expect(await contrast(guest,selector),`${design} ${selector}`).toBeGreaterThanOrEqual(4.5);
        await guest.screenshot({path:`${LINK_SHOTS}/public-${design}-${viewport.width}.png`,fullPage:true});
      }
    }
    await guest.setViewportSize({width:1280,height:900});
    await guest.goto(shareUrl);
    await guest.locator('.ecard-links').screenshot({path:`${LINK_SHOTS}/icons-closeup.png`});
    await guest.getByRole('button',{name:'複製 Discord 帳號',exact:true}).click();
    const copyStatus=guest.locator('.ecard-copy-status'),copyFallback=guest.locator('.ecard-copy-fallback');
    await expect.poll(async()=>((await copyStatus.textContent())??'').includes('已複製')||await copyFallback.count()>0).toBe(true);
    if(((await copyStatus.textContent())??'').includes('已複製'))expect(await guest.evaluate(()=>navigator.clipboard.readText())).toBe('discorduser');
    else await expect(copyFallback).toHaveValue('discorduser');
    const owner=await page.context().newPage();
    try{
      await owner.setViewportSize({width:1280,height:900});
      await owner.goto(shareUrl);
      await expect(owner.getByText('這是你的名片，訪客看到的就是這個樣子。')).toBeVisible();
      await expect(owner.locator('.member-card')).toHaveCount(0);
      await expect(owner.locator('.ecard')).toHaveAttribute('data-design','classic');
      await owner.getByRole('button',{name:'編輯名片',exact:true}).click();
      await expect(owner.getByRole('region',{name:'分享我的工坊名片'})).toBeVisible();
      await expect(owner).toHaveURL(/#account/);
    }finally{await owner.close();}
    await page.setViewportSize({width:1280,height:900});
    const fields=await settings.locator('.member-share-fields').boundingBox();
    const preview=await settings.locator('.member-share-preview').boundingBox();
    expect(preview!.x).toBeGreaterThan(fields!.x+200);
    await settings.screenshot({path:`${LINK_SHOTS}/settings-1280.png`});
    await page.screenshot({path:`${LINK_SHOTS}/settings-page-1280.png`,fullPage:true});
    await page.setViewportSize({width:390,height:844});
    const fieldsPhone=await settings.locator('.member-share-fields').boundingBox();
    const previewPhone=await settings.locator('.member-share-preview').boundingBox();
    expect(previewPhone!.y).toBeGreaterThan(fieldsPhone!.y+40);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await settings.screenshot({path:`${LINK_SHOTS}/settings-390.png`});
    await page.screenshot({path:`${LINK_SHOTS}/settings-page-390.png`,fullPage:true});
    await profile.getByRole('checkbox',{name:'顯示 GitHub 在名片上'}).uncheck();
    await waitSaved(settings);
    await expect(settings.getByRole('link',{name:'開啟名片',exact:true})).toHaveAttribute('href',shareUrl);
    await guest.goto(shareUrl);
    await expect(guest.locator('a[href="https://github.com/octocat"]')).toHaveCount(0);
    await expect(guest.getByRole('link',{name:/LINE/})).toBeVisible();
    await settings.getByRole('checkbox',{name:'自動放上我設為「平台公開」的聯絡方式和社群連結'}).uncheck();
    await waitSaved(settings);
    await guest.reload();
    await expect(guest.getByRole('link',{name:/LINE/})).toHaveCount(0);
    await expect(guest.getByRole('button',{name:'複製 Discord 帳號'})).toHaveCount(0);
    await expect(guest.getByRole('link',{name:/我的 IG/})).toHaveCount(0);
    await expect(guest.getByRole('link',{name:/Facebook/})).toBeVisible();
    await expect(guest.locator('a[href*="facebook.com/friends-only"]')).toHaveCount(0);
  }finally{await guestContext.close();}
});

const DRAFT_SAVED='已自動儲存。建立分享連結後，朋友看到的就是這個樣子。';
function countSharePosts(page:Page){
  let posts=0;
  const onRequest=(request:{method:()=>string;url:()=>string})=>{if(request.method()==='POST'&&request.url().includes('/api/v1/me/member-card-share'))posts++;};
  page.on('request',onRequest);
  return {get count(){return posts;},stop(){page.off('request',onRequest);}};
}

test('a failed autosave stops until the member retries',async({page})=>{
  test.setTimeout(180000);
  await page.setViewportSize({width:1280,height:900});
  await signup(page,'失敗儲存作者');
  await navigate(page,'我的名片');
  const settings=shareRegion(page);
  const posts=countSharePosts(page);
  await page.route('**/api/v1/me/member-card-share',async route=>{
    if(route.request().method()!=='POST')return route.continue();
    await route.fulfill({status:500,contentType:'application/problem+json',body:JSON.stringify({type:'about:blank',title:'伺服器錯誤',status:500,detail:'名片設定暫時無法儲存。',code:'member_card_share_failed'})});
  });
  try{
    await settings.getByRole('button',{name:'夜空',exact:true}).click();
    await expect(settings.locator('.ecard-save-status')).toContainText('服務暫時無法回應（500）。尚未確認結果，請稍後重試。');
    await expect(settings.getByRole('button',{name:'重試',exact:true})).toBeVisible();
    await expect(settings.getByRole('button',{name:'建立分享連結',exact:true})).toBeEnabled();
    await page.waitForTimeout(3000);
    expect(posts.count).toBe(1);
    await settings.getByRole('button',{name:'重試',exact:true}).click();
    await expect.poll(()=>posts.count).toBe(2);
    await page.waitForTimeout(1000);
    expect(posts.count).toBe(2);
    await page.unroute('**/api/v1/me/member-card-share');
    await settings.getByRole('button',{name:'重試',exact:true}).click();
    await expect(settings.locator('.ecard-save-status')).toContainText(DRAFT_SAVED);
    await page.reload();
    await navigate(page,'我的名片');
    await expect(shareRegion(page).getByRole('button',{name:'夜空',exact:true})).toHaveAttribute('aria-pressed','true');
  }finally{posts.stop();await page.unroute('**/api/v1/me/member-card-share').catch(()=>{});}
});

test('a dropped save request is sent once per member action',async({page})=>{
  test.setTimeout(180000);
  await page.setViewportSize({width:390,height:844});
  await signup(page,'斷線儲存作者');
  await navigate(page,'我的名片');
  const settings=shareRegion(page);
  const posts=countSharePosts(page);
  await page.route('**/api/v1/me/member-card-share',async route=>{
    if(route.request().method()!=='POST')return route.continue();
    await route.abort('internetdisconnected');
  });
  try{
    await settings.getByRole('button',{name:'夜空',exact:true}).click();
    await expect(settings.locator('.ecard-save-status')).toContainText('無法連線到伺服器，尚未確認結果。請確認網路後重試。');
    await expect(settings.getByRole('button',{name:'重試',exact:true})).toBeVisible();
    await expect(settings.getByRole('button',{name:'建立分享連結',exact:true})).toBeEnabled();
    await page.waitForTimeout(3000);
    expect(posts.count).toBe(1);
    await settings.getByRole('button',{name:'重試',exact:true}).click();
    await expect.poll(()=>posts.count).toBe(2);
    await page.waitForTimeout(1000);
    expect(posts.count).toBe(2);
    await settings.getByRole('button',{name:'工坊',exact:true}).click();
    await expect.poll(()=>posts.count).toBe(3);
    await page.waitForTimeout(1000);
    expect(posts.count).toBe(3);
    await page.unroute('**/api/v1/me/member-card-share');
    await settings.getByRole('button',{name:'重試',exact:true}).click();
    await expect(settings.locator('.ecard-save-status')).toContainText(DRAFT_SAVED);
    await page.reload();
    await navigate(page,'我的名片');
    await expect(shareRegion(page).getByRole('button',{name:'工坊',exact:true})).toHaveAttribute('aria-pressed','true');
  }finally{posts.stop();await page.unroute('**/api/v1/me/member-card-share').catch(()=>{});}
});

test('a 428 from a card created elsewhere reloads and does not keep saving',async({page})=>{
  test.setTimeout(180000);
  await page.setViewportSize({width:820,height:900});
  await signup(page,'版本要求作者');
  await navigate(page,'我的名片');
  const settings=shareRegion(page);
  const headline=settings.getByLabel('一句話介紹');
  // Focus once, before any other tab creates the card. A later window focus would refresh the version and skip the 428.
  const focusRead=page.waitForResponse(response=>response.url().includes('/api/v1/me/member-card-share')&&response.request().method()==='GET',{timeout:1500}).catch(()=>null);
  await headline.click();
  await focusRead;
  const posts:string[]=[];
  page.on('request',request=>{if(request.method()==='POST'&&request.url().includes('/api/v1/me/member-card-share'))posts.push(request.headers()['if-match']??'');});
  const session=await (await page.request.get('/api/v1/session')).json() as {csrf_token:string};
  const created=await page.request.post('/api/v1/me/member-card-share',{headers:{Origin:e2eOrigin(),'X-CSRF-Token':session.csrf_token,'Idempotency-Key':randomUUID()},data:{enabled:true,include_avatar:false,rotate:false,design:'night',headline:'另一邊寫的',links:[],show_profile_links:true,profile_link_prefs:{}}});
  expect(created.status()).toBe(200);
  await headline.pressSequentially('這一邊寫的',{delay:20});
  await expect(settings.locator('.ecard-save-status')).toContainText('名片設定在其他地方更新了，已重新載入最新版本。',{timeout:20000});
  await expect(settings.getByLabel('一句話介紹')).toHaveValue('另一邊寫的');
  await expect(settings.getByRole('button',{name:'夜空',exact:true})).toHaveAttribute('aria-pressed','true');
  const open=settings.getByRole('link',{name:'開啟名片',exact:true});
  await expect(open).toBeVisible();
  const shareUrl=await open.getAttribute('href');
  expect(posts).toEqual(['']);
  await page.waitForTimeout(1500);
  expect(posts).toEqual(['']);
  await headline.fill('下一筆');
  await headline.blur();
  await expect(settings.locator('.ecard-save-status')).toContainText(SAVED);
  await expect.poll(()=>posts.length).toBe(2);
  expect(posts[1]).toMatch(/^"[1-9][0-9]*"$/);
  await expect(open).toHaveAttribute('href',shareUrl!);
  await page.reload();
  await navigate(page,'我的名片');
  const reloaded=shareRegion(page);
  await expect(reloaded.getByLabel('一句話介紹')).toHaveValue('下一筆');
  await expect(reloaded.getByRole('button',{name:'夜空',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(reloaded.getByRole('link',{name:'開啟名片',exact:true})).toHaveAttribute('href',shareUrl!);
});

test('an explicit share action is dropped when the headline becomes invalid',async({page})=>{
  test.setTimeout(180000);
  await page.setViewportSize({width:1280,height:900});
  await signup(page,'介紹失效作者');
  await navigate(page,'我的名片');
  const settings=shareRegion(page);
  let release=()=>{},held=false,posts=0;
  const gate=new Promise<void>(resolve=>{release=()=>resolve();});
  await page.route('**/api/v1/me/member-card-share',async route=>{
    if(route.request().method()!=='POST')return route.continue();
    posts++;
    if(!held){held=true;await gate;}
    await route.continue();
  });
  try{
    await settings.getByRole('button',{name:'工坊',exact:true}).click();
    await expect.poll(()=>held).toBe(true);
    await settings.getByRole('button',{name:'建立分享連結',exact:true}).click();
    await expect(settings.getByRole('button',{name:'建立分享連結',exact:true})).toBeDisabled();
    await settings.getByLabel('一句話介紹').fill('介'.repeat(61));
    release();
    await expect(settings.locator('.ecard-save-status')).toContainText('請先修正一句話介紹，再按一次。');
    await expect(settings.getByRole('alert')).toContainText('一句話介紹最多 60 個字。');
    await expect(settings.getByRole('button',{name:'建立分享連結',exact:true})).toBeEnabled();
    await page.waitForTimeout(1200);
    expect(posts).toBe(1);
    await expect(settings.getByRole('link',{name:'開啟名片',exact:true})).toHaveCount(0);
    const headline=settings.getByLabel('一句話介紹');
    await headline.fill('修好了');
    await headline.blur();
    await expect(settings.locator('.ecard-save-status')).toContainText(DRAFT_SAVED);
    expect(posts).toBe(2);
    await expect(settings.getByRole('link',{name:'開啟名片',exact:true})).toHaveCount(0);
  }finally{release();await page.unrouteAll({behavior:'ignoreErrors'}).catch(()=>{});}
});

test('the card renders only https and mailto addresses as links',async({page})=>{
  test.setTimeout(180000);
  await page.setViewportSize({width:390,height:844});
  await signup(page,'網址防守作者');
  await page.route('**/api/v1/me/member-card-share',async route=>{
    if(route.request().method()!=='GET')return route.continue();
    const response=await route.fetch();
    const json=await response.json();
    json.links=[...(json.links??[]),{label:'腳本連結',url:'javascript:alert(1)'},{label:'安全連結',url:'https://example.com/safe'}];
    json.profile_links=[
      ...(json.profile_links??[]),
      {source:'contact:github',platform:'github',label:'壞帳號',handle:'../evil',url:'javascript:alert(1)',shown:true},
      {source:'social:00000000-0000-4000-8000-000000000099',platform:'website',label:'明文網站',handle:'example.com',url:'http://example.com/plain',shown:true},
      {source:'social:00000000-0000-4000-8000-000000000098',platform:'website',label:'含帳密',handle:'example.com',url:'https://user:pass@example.com/secret',shown:true},
      {source:'contact:email',platform:'email',label:'Email',handle:'person@example.test',url:'mailto:person@example.test',shown:true},
    ];
    await route.fulfill({status:response.status(),contentType:'application/json',json});
  });
  try{
    await navigate(page,'我的名片');
    const card=shareRegion(page).locator('.ecard-preview .ecard');
    await expect(card.getByRole('link',{name:/安全連結/})).toHaveAttribute('href','https://example.com/safe');
    await expect(card.getByRole('link',{name:/安全連結/})).toHaveAttribute('rel','noopener noreferrer nofollow ugc');
    await expect(card.getByRole('link',{name:/Email/})).toHaveAttribute('href','mailto:person@example.test');
    await expect(card.locator('a[href^="mailto:"]')).not.toHaveAttribute('target','_blank');
    await expect(card.locator('a')).toHaveCount(2);
    for(const label of ['腳本連結','壞帳號','明文網站','含帳密']){
      await expect(card.getByText(label,{exact:true})).toBeVisible();
      await expect(card.getByRole('link',{name:new RegExp(label)})).toHaveCount(0);
    }
    await expect(card.locator('a[href^="javascript:"],a[href^="http:"],a[href*="user:pass"]')).toHaveCount(0);
  }finally{await page.unrouteAll({behavior:'ignoreErrors'}).catch(()=>{});}
});
