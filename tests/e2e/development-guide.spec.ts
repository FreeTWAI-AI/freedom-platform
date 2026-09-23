import {test,expect} from '@playwright/test';

test('development hints stay collapsed and follow the current page on desktop and phone',async({page})=>{
 await page.goto('/');
 const entry=page.getByRole('complementary',{name:'這一頁的開發入口'});
 await expect(entry).toHaveAttribute('data-development-guide','/development/registration');
 await expect(entry.locator('details')).not.toHaveAttribute('open');
 await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');
 await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');
 await page.getByRole('button',{name:'登入',exact:true}).click();
 await expect(entry).toHaveAttribute('data-development-guide','/development/home');
 await entry.locator('summary').click();
 await expect(entry.getByRole('link',{name:'給 Agent 的文字版 ↗'})).toHaveAttribute('href','/development/home.md');
 await page.getByRole('button',{name:'職業公會',exact:true}).click();
 await expect(entry).toHaveAttribute('data-development-guide','/development/guilds');
 await expect(entry.locator('details')).not.toHaveAttribute('open');
 await page.setViewportSize({width:390,height:844});await entry.locator('summary').click();
 await expect(entry.getByRole('link',{name:'查看這一頁的開發指引 ↗'})).toHaveAttribute('href','/development/guilds');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('a visitor without JavaScript can follow real repo links and read a complete skill guide',async({browser,baseURL})=>{
 const context=await browser.newContext({baseURL,javaScriptEnabled:false,viewport:{width:390,height:844}});
 try{
  const page=await context.newPage();await page.goto('/');
  await page.getByRole('link',{name:'公開開發導覽',exact:true}).click();
  await page.getByRole('link',{name:'供貨中心',exact:true}).click();
  await expect(page.getByRole('heading',{name:'要 Fork 哪一個 Repo？'})).toBeVisible();
  await expect(page.getByRole('link',{name:'https://github.com/FreeTWAI-AI/freedom-supplier-client',exact:false}).first()).toBeVisible();
  await page.goto('/development/skills/security-scanner');
  await expect(page.getByRole('heading',{name:'第一個練習'})).toBeVisible();
  await expect(page.getByRole('link',{name:'https://github.com/FreeTWAI-AI/ai-security-scanner/fork',exact:true})).toBeVisible();
  expect(await page.locator('body').evaluate(element=>element.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/development-guide-phone.png',fullPage:true});
 }finally{await context.close();}
});
