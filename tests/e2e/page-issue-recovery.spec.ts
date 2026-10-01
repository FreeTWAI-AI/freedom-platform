import {test,expect} from './fixtures.js';

async function login(page:import('@playwright/test').Page){
  await page.goto('/');
  await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');
  await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');
  await page.getByRole('button',{name:'登入',exact:true}).click();
  await expect(page.getByRole('heading',{name:'會員首頁',level:1})).toBeVisible();
}

test('confirmed Issue remains visible after a lost publish response and modal reopen',async({page})=>{
  await login(page);
  let operationKey='';
  await page.route('**/api/v1/me/github/pages/home/issues',route=>{
    if(route.request().method()==='POST'){
      operationKey=route.request().headers()['idempotency-key']??'';
      return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({code:'unavailable'})});
    }
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({items:[
      {operation_key:'previous',state:'confirmed',issue_number:15,title:'之前的首頁提案',issue_url:'https://github.com/FreeTWAI-AI/freedom-platform/issues/15',created_at:'2026-09-27T08:13:16Z'},
      ...(operationKey?[{operation_key:operationKey,state:'confirmed',issue_number:17,title:'改善首頁',issue_url:'https://github.com/FreeTWAI-AI/freedom-platform/issues/17',created_at:'2026-09-27T08:18:00Z'}]:[]),
    ]})});
  });
  await page.route('**/api/v1/pages/github-activity?*',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({items:[{number:16,title:'另一位會員的首頁提案',url:'https://github.com/FreeTWAI-AI/freedom-platform/issues/16',author:'other-member',created_at:'2026-09-27T08:16:00Z',state:'open',kind:'issue',pages:['home']}],checked_at:'2026-09-27T08:19:00Z',truncated:false})}));
  await page.route('**/api/v1/me/github',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({configured:true,connected:true,github_user:{id:'901',login:'maker'}})}));
  await page.getByRole('button',{name:'提出想法'}).click();
  const idea=page.getByRole('dialog',{name:'會員首頁：提出想法'});
  await expect(idea.getByRole('link',{name:/#15/})).toBeVisible();
  await expect(idea.getByRole('link',{name:/#16/})).toBeVisible();
  await idea.getByRole('textbox',{name:'標題'}).fill('改善首頁');
  await idea.getByRole('textbox',{name:'想法與期待'}).fill('希望首頁提供更容易找到的入口。');
  await idea.getByRole('button',{name:'用我的 GitHub 發布'}).click();
  await expect(idea.getByRole('status').filter({hasText:'已由你的 GitHub 帳號發布'})).toBeVisible();
  await expect(idea.getByRole('link',{name:'#17 改善首頁 ↗'})).toBeVisible();
  await expect(idea.getByText('發布結果尚未確認')).toHaveCount(0);
  await idea.getByRole('button',{name:'關閉'}).click();
  await page.getByRole('button',{name:'提出想法'}).click();
  await expect(idea.getByRole('link',{name:/#15/})).toBeVisible();
  await expect(idea.getByRole('link',{name:/#16/})).toBeVisible();
  await expect(idea.getByRole('link',{name:'#17 改善首頁 ↗'})).toBeVisible();
  expect(operationKey).not.toBe('');
  await page.screenshot({path:'test-results/page-issue-recovery-desktop.png'});
});

test('member can send a design claim comment from the Issue row',async({page})=>{
  await login(page);
  let posted='';
  await page.route('**/api/v1/me/github',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({configured:true,connected:true,github_user:{id:'901',login:'maker'}})}));
  // Page activity now comes from the synced open issue #14 (page:home). #12 stays closed for history.
  await page.route('**/api/v1/me/github/pages/home/design-claims',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({items:posted?[{operation_key:'claim-e2e',state:'confirmed',issue_number:14,comment_url:'https://github.com/FreeTWAI-AI/freedom-platform/issues/14#issuecomment-91',created_at:new Date().toISOString()}]:[]})}));
  await page.route('**/api/v1/me/github/pages/home/issues/14/design-claim',async route=>{posted=route.request().postData()??'';await route.fulfill({status:201,contentType:'application/json',body:JSON.stringify({confirmed:true,issue_number:14,comment_url:'https://github.com/FreeTWAI-AI/freedom-platform/issues/14#issuecomment-91'})})});
  await page.getByRole('button',{name:'提出想法'}).click();
  const idea=page.getByRole('dialog',{name:'會員首頁：提出想法'});
  await idea.getByRole('button',{name:'回覆這則 Issue'}).click();
  await page.screenshot({path:'test-results/page-design-claim-editor-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/page-design-claim-editor-mobile.png'});
  await idea.getByRole('button',{name:'送出認領留言'}).click();
  await expect(idea.getByRole('link',{name:'已送出認領留言 ↗'})).toBeVisible();
  expect(JSON.parse(posted)).toMatchObject({confirmed:true,message:'我願意接手這個 Issue 的設計。請維護者確認範圍與完成條件；確認後我會開始處理。'});
  await page.screenshot({path:'test-results/page-design-claim-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/page-design-claim-mobile.png'});
});

test('console detail control follows message text on the same content row',async({page})=>{
  await login(page);
  await page.route('**/api/v1/me/github',route=>route.fulfill({status:503,contentType:'application/json',body:'{}'}));
  await page.getByRole('button',{name:'提出想法'}).click();
  await page.getByRole('dialog',{name:'會員首頁：提出想法'}).getByRole('button',{name:'關閉'}).click();
  await page.getByRole('button',{name:'展開訊息控制台'}).click();
  const entry=page.locator('.game-console-entry').filter({hasText:'服務暫時無法回應（503）'}).first();
  await expect(entry).toBeVisible();
  await entry.scrollIntoViewIfNeeded();
  const message=await entry.locator('.game-console-content p').boundingBox();
  const summary=await entry.locator('.game-console-detail summary').boundingBox();
  expect(message&&summary&&Math.abs(message.y-summary.y)<20).toBeTruthy();
  await page.screenshot({path:'test-results/console-inline-detail-desktop.png'});
  await entry.locator('.game-console-detail summary').click();
  await expect(entry.locator('.game-console-detail pre')).toContainText('GET /me/github');
  await page.setViewportSize({width:390,height:844});
  await expect(entry.locator('.game-console-detail summary')).toBeVisible();
  await entry.scrollIntoViewIfNeeded();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/console-inline-detail-mobile.png'});
});
