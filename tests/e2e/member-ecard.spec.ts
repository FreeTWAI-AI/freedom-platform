import {randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {test,expect,type Page} from './fixtures.js';
import {navigate} from './navigation.js';
import {quickJoin} from './quick-join.js';
const SHOTS=process.env.AUDIT_EVIDENCE_DIR??'test-results/member-ecard';
mkdirSync(SHOTS,{recursive:true});
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
  await expect(openCard).toBeVisible();
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
      await settings.getByRole('button',{name,exact:true}).click();
      const saved=page.waitForResponse(response=>response.url().includes('/api/v1/me/member-card-share')&&response.request().method()==='POST');
      await settings.getByRole('button',{name:'保存分享設定',exact:true}).click();
      const body=await (await saved).json();
      expect(body.design).toBe(design);
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
