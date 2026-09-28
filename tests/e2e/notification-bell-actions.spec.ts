import { test,expect,type Page } from './fixtures.js';

async function login(page:Page,email:string){
  await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill(email);
  await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');
  await page.getByRole('button',{name:'登入',exact:true}).click();
  await expect(page.getByRole('heading',{name:'會員首頁',exact:true})).toBeVisible();
}
async function inviteMaker(page:Page){
  const status=await page.evaluate(async()=>{
    const session=await (await fetch('/api/v1/session')).json();
    const response=await fetch('/api/v1/friends/20000000-0000-4000-8000-000000000001/request',{
      method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf_token,'Idempotency-Key':crypto.randomUUID()},body:'{}',
    });return response.status;
  });expect(status).toBe(200);
}
async function logout(page:Page){await page.getByRole('button',{name:'登出',exact:true}).click();await expect(page.getByRole('heading',{name:'登入',exact:true})).toBeVisible();}

test('clicking one notification opens its friend response and keeps the bell open',async({page})=>{
  await login(page,'reviewer@local.test');await inviteMaker(page);await logout(page);
  await login(page,'client@local.test');await inviteMaker(page);await logout(page);
  await login(page,'maker@local.test');
  await page.getByRole('button',{name:/^通知/}).click();
  const popover=page.getByRole('region',{name:'最近通知'});
  await expect(popover).toBeVisible();
  const unreadBefore=await popover.locator('.notification-bell-item.is-unread').count();
  expect(unreadBefore).toBeGreaterThanOrEqual(2);
  const requestNotice=popover.locator('.notification-bell-item.is-unread').filter({hasText:'示範需求者'}).first();
  await expect(requestNotice).toBeVisible();
  await requestNotice.click();
  await expect(page).toHaveURL(/#members$/);
  await expect(popover).toBeVisible();
  await expect(popover.locator('.notification-bell-item.is-unread')).toHaveCount(unreadBefore-1);
  const request=page.locator('#friend-request-20000000-0000-4000-8000-000000000002');
  await expect(request.getByRole('button',{name:'接受邀請'})).toBeFocused();
  await page.screenshot({path:'test-results/notification-action-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/notification-action-phone.png'});
});
