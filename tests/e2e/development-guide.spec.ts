import {openPageTools} from './navigation.js';
import { navigate } from './navigation.js';
import {test,expect} from './fixtures.js';

test('development tools follow the current page on desktop and phone without a duplicate footer',async({page})=>{
 await page.goto('/');
 await expect(page.locator('.development-context')).toHaveCount(0);
 await openPageTools(page); await page.locator('.login-page-tools').getByRole('button',{name:'參與編修'}).click();
 let guide=page.getByRole('dialog',{name:/參與編修/});
 await expect(guide.getByRole('link',{name:'給 Agent 的文字版 ↗'})).toHaveAttribute('href','/development/registration.md');
 await guide.getByRole('button',{name:'關閉'}).click();
 await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');
 await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');
 await page.getByRole('button',{name:'登入',exact:true}).click();
 await expect(page.getByRole('heading',{name:'會員首頁',level:1})).toBeVisible();
 await openPageTools(page); await page.locator('.topbar').getByRole('button',{name:'參與編修'}).click();
 guide=page.getByRole('dialog',{name:/參與編修/});
 await expect(guide.getByRole('link',{name:'給 Agent 的文字版 ↗'})).toHaveAttribute('href','/development/home.md');
 await guide.getByRole('button',{name:'關閉'}).click();
 await navigate(page, '職業公會');
 await page.setViewportSize({width:390,height:844});
 await openPageTools(page); await page.locator('.topbar').getByRole('button',{name:'參與編修'}).click();
 guide=page.getByRole('dialog',{name:/參與編修/});
 await expect(guide.getByRole('link',{name:'查看這一頁的開發指引 ↗'})).toHaveAttribute('href','/development/guilds');
 await expect(page.locator('.development-context')).toHaveCount(0);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('a visitor without JavaScript can follow real repo links and read a complete skill guide',async({browser,baseURL})=>{
 const context=await browser.newContext({baseURL,javaScriptEnabled:false,viewport:{width:390,height:844}});
 try{
  const page=await context.newPage();await page.goto('/');
  await page.getByRole('link',{name:'公開開發導覽',exact:true}).click();
  await page.getByRole('link',{name:'我有東西要賣',exact:true}).click();
  await expect(page.getByRole('heading',{name:'要 Fork 哪一個 Repo？'})).toBeVisible();
  await expect(page.getByRole('link',{name:'https://github.com/FreeTWAI-AI/freedom-supplier-client',exact:false}).first()).toBeVisible();
  await page.goto('/development/skills/security-scanner');
  await expect(page.locator('.public-skill-entry .public-skill-actions a').first()).toHaveAttribute('href','https://github.com/teddashh/ai-security-scanner');
  await expect(page.getByRole('link',{name:'前往作者網站 ↗',exact:true})).toHaveAttribute('href','https://teddashh.github.io/ai-security-scanner/');
  await expect(page.getByRole('link',{name:'閱讀技能書 ↗',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'一起開發',exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'從原作開始共創 ↗',exact:true})).toHaveAttribute('href','https://github.com/teddashh/ai-security-scanner/fork');
  await expect(page.locator('.collaboration-repository')).toHaveText('預設 PR → teddashh/ai-security-scanner:main');
  await expect(page.getByRole('link',{name:'查看原作 PR ↗',exact:true})).toHaveAttribute('href','https://github.com/teddashh/ai-security-scanner/pulls');
  await expect(page.getByText('工坊整合與任務來源',{exact:true})).toBeVisible();
  await page.getByText('工坊整合與任務來源',{exact:true}).click();
  await expect(page.getByRole('link',{name:'查看工坊整合版本',exact:true})).toHaveAttribute('href','https://github.com/FreeTWAI-AI/ai-security-scanner');
  await expect(page.getByRole('link',{name:'下載 Agent SKILL.md',exact:true}).first()).toBeVisible();
  await page.getByText('完整指南與來源',{exact:true}).click();
  await expect(page.getByRole('heading',{name:'第一個練習'})).toBeVisible();
  await expect(page.getByRole('link',{name:'https://github.com/FreeTWAI-AI/ai-security-scanner/fork',exact:true}).first()).toBeVisible();
  for(const width of [320,390]){
   await page.setViewportSize({width,height:844});
   const dimensions=await page.locator('body').evaluate(element=>({scroll:element.scrollWidth,viewport:window.innerWidth}));
   expect(dimensions.scroll,`guide body overflow at ${width}px`).toBeLessThanOrEqual(dimensions.viewport);
  }
  await page.screenshot({path:'test-results/development-guide-phone.png',fullPage:true});
 }finally{await context.close();}
});


test('public skill share previews and copies the chosen introduction with its persistent URL on a phone',async({page})=>{
 await page.addInitScript(()=>{
  Object.defineProperty(navigator,'share',{configurable:true,value:undefined});
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(value:string)=>{(window as any).__sharedSkillUrl=value;}}});
 });
 await page.setViewportSize({width:390,height:844});
 await page.goto('/development/skills/video-autopilot');
 await expect(page.getByRole('heading',{name:'一起開發',exact:true})).toBeVisible();
 await expect(page.getByRole('heading',{name:'建立可重現的剪輯測試素材',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'分享技能書',exact:true}).click();
 const preview=page.locator('[data-share-dialog]');
 await expect(preview).toBeVisible();
 expect(await page.evaluate(()=>(window as any).__sharedSkillUrl)).toBeUndefined();
 const first=await preview.locator('[data-share-text]').innerText();
 await preview.getByRole('button',{name:'換一句',exact:true}).click();
 await expect(preview.locator('[data-share-text]')).not.toHaveText(first);
 const introduction=await preview.locator('[data-share-text]').innerText(),url=await preview.locator('[data-share-url]').innerText();
 expect(url).toMatch(/^https:\/\/freetwai\.com\/development\/skills\/video-autopilot\?intro=([1-9][0-9]?|100)$/);
 await preview.getByRole('button',{name:'複製介紹與連結',exact:true}).click();
 await expect(preview.getByRole('status')).toHaveText('已複製介紹與連結');
 expect(await page.evaluate(()=>(window as any).__sharedSkillUrl)).toBe(introduction+'\n'+url);
 expect(await preview.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
 await preview.getByRole('button',{name:'關閉分享預覽',exact:true}).click();
 await expect(page.getByRole('button',{name:'分享技能書',exact:true})).toBeFocused();
 await expect(page.getByRole('link',{name:'下載 Agent SKILL.md',exact:true}).first()).toHaveAttribute('href','/development/skills/video-autopilot/SKILL.md');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:'test-results/skill-collaboration-share-phone.png',fullPage:true});
});
