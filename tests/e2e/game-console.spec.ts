import {test,expect,type Page} from './fixtures.js';
import {openChat,closeChat,signOut} from './navigation.js';
import {randomUUID} from 'node:crypto';

async function login(page:Page){
  await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.getByRole('heading',{name:'會員首頁',level:1})).toBeVisible();
}
test('legacy console is retired; the unified inbox keeps site-controlled features and reloads private history only after selection',async({page})=>{
  let siteReads=0;page.on('request',request=>{if(new URL(request.url()).pathname==='/api/v1/site')siteReads++;});
  await login(page);await openChat(page);const panel=page.locator('.floating-message-panel');
  await panel.getByLabel('搜尋會員').fill('示範需求者');await panel.getByRole('button',{name:'搜尋會員',exact:true}).click();await panel.getByRole('button',{name:'傳訊給 示範需求者',exact:true}).click();
  await expect(panel.getByRole('button',{name:'附加圖片',exact:true})).toHaveCount(process.env.FREEDOM_E2E_MESSAGE_IMAGE_FIXTURE==='1'?1:0);
  const message=`保留歷史 ${randomUUID()}`;await panel.getByRole('textbox',{name:'寫給 示範需求者 的訊息'}).fill(message);await panel.getByRole('button',{name:'送出',exact:true}).click();await expect(panel.getByRole('log')).toContainText(message);
  expect(siteReads).toBe(1);await expect(page.locator('.game-console')).toHaveCount(0);await closeChat(page);await signOut(page);
  await login(page);await openChat(page);await expect(panel.getByRole('log')).toHaveCount(0);
  await panel.locator('[aria-label="對話列表"]').getByRole('button').filter({hasText:'示範需求者'}).click();await expect(panel.getByRole('log')).toContainText(message);
});
test('members still completing entry do not load gated chat history or a legacy console',async({page})=>{
  const reads:string[]=[];page.on('request',request=>{if(/\/me\/(conversations|channels|guild-announcements)/.test(request.url()))reads.push(request.url());});
  await page.goto('/');await page.getByRole('button',{name:'建立帳號',exact:true}).click();await page.getByLabel('社群顯示名稱',{exact:true}).fill('整合訊息測試');await page.getByLabel('電子郵件',{exact:true}).fill(`inbox-${randomUUID()}@example.test`);await page.getByLabel('密碼',{exact:true}).fill('freedom-console-test-2026');await page.getByRole('button',{name:'建立帳號，先逛工坊',exact:true}).click();
  await expect(page.getByRole('heading',{name:'整合訊息測試，歡迎來到自由工坊。'})).toBeVisible();await expect(page.locator('.game-console')).toHaveCount(0);await expect(page.locator('.floating-messages')).toHaveCount(0);expect(reads).toEqual([]);
});
