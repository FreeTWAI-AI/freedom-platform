import { test,expect,type Page } from './fixtures.js';
import { signOut } from './navigation.js';

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
async function logout(page:Page){await signOut(page);await expect(page.getByRole('heading',{name:'登入',exact:true})).toBeVisible();}

test('clicking one notification opens its friend response and closes the bell',async({page})=>{
  await login(page,'reviewer@local.test');await inviteMaker(page);await logout(page);
  await login(page,'client@local.test');await inviteMaker(page);await logout(page);
  await login(page,'maker@local.test');
  await page.getByRole('button',{name:/^通知/}).click();
  const popover=page.getByRole('region',{name:'最近通知'});
  await expect(popover).toBeVisible();
  await expect.poll(()=>popover.locator('.notification-bell-item.is-unread').count()).toBeGreaterThanOrEqual(2);
  // The preview contains at most six notices; its item count is not the unread total.
  const beforeResponse=await page.request.get('/api/v1/me/notifications?limit=6&offset=0');
  expect(beforeResponse.status()).toBe(200);
  const before=await beforeResponse.json() as {unread_count:number;items:{notification_id:string;title:string;body:string;read_at:string|null}[]};
  const unreadBefore=before.unread_count;
  expect(unreadBefore).toBeGreaterThanOrEqual(2);
  await expect(page.locator('.notification-bell-trigger')).toHaveAccessibleName(`通知，${unreadBefore} 則未讀`);
  const target=before.items.find(item=>!item.read_at&&`${item.title} ${item.body}`.includes('示範需求者'));
  expect(target).toBeDefined();
  const requestNotice=popover.locator('.notification-bell-item.is-unread').filter({hasText:'示範需求者'}).first();
  await expect(requestNotice).toBeVisible();
  const readResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===`/api/v1/me/notifications/${target!.notification_id}/read`);
  await requestNotice.click();
  const read=await readResponse;
  expect(read.status()).toBe(200);
  expect((await read.json()).read_at).toEqual(expect.any(String));
  await expect(page).toHaveURL(/#members$/);
  await expect(popover).toBeHidden();
  await expect(page.locator('.notification-bell-trigger')).toHaveAccessibleName(`通知，${unreadBefore-1} 則未讀`);
  const afterResponse=await page.request.get('/api/v1/me/notifications?limit=6&offset=0');
  expect(afterResponse.status()).toBe(200);
  const after=await afterResponse.json() as typeof before;
  expect(after.unread_count).toBe(unreadBefore-1);
  expect(after.items.find(item=>item.notification_id===target!.notification_id)?.read_at).toEqual(expect.any(String));
  const request=page.locator('#friend-request-20000000-0000-4000-8000-000000000002');
  await expect(request.getByRole('button',{name:'接受邀請'})).toBeFocused();
  await page.screenshot({path:'test-results/notification-action-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/notification-action-phone.png'});
});
