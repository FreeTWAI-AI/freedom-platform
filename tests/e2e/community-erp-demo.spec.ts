import {test,expect} from './fixtures.js';
import {navigate} from './navigation.js';
test('community offers the personal ERP trial without passing member data to an external site',async({page})=>{
 await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.getByRole('heading',{name:'會員首頁',level:1,exact:true})).toBeVisible();await navigate(page,'自由工坊社群');
 const section=page.getByRole('region',{name:'ERP／CRM 產業範本試用',exact:true});await expect(section).toContainText('MIT 個人開源專案');await expect(section).toContainText('不轉送工坊會員資料');
 const trial=section.getByRole('link',{name:'建立我的模擬測試系統 ↗',exact:true});await expect(trial).toHaveAttribute('href','https://freedom-erp-crm-demo.digimkt.workers.dev/');await expect(trial).toHaveAttribute('rel','noopener noreferrer');await expect(trial).toHaveAttribute('referrerpolicy','no-referrer');await expect(trial).toHaveAttribute('target','_blank');
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:'test-results/community-erp-entry.png',fullPage:true});
});
