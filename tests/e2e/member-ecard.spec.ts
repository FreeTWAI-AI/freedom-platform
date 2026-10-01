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
  await expect(settings.getByRole('button',{name:'複製連結',exact:true})).toBeVisible();
  await expect(settings.getByRole('link',{name:'開啟名片',exact:true})).toBeVisible();
  const shareUrl=await settings.getByLabel('名片邀請連結').inputValue();
  await settings.getByRole('button',{name:'複製連結',exact:true}).click();
  await expect(settings.getByText('分享未完成，你可以選取下方連結手動複製。')).toBeVisible();
  await expect.poll(()=>settings.getByLabel('名片邀請連結').evaluate(element=>{const input=element as HTMLInputElement;return document.activeElement===input&&input.selectionStart===0&&input.selectionEnd===input.value.length;})).toBe(true);
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
      await expect(settings.getByLabel('名片邀請連結')).toHaveValue(shareUrl);
      for(const viewport of widths){
        await guest.setViewportSize(viewport);
        await guest.goto(shareUrl);
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
