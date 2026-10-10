import {randomUUID} from 'node:crypto';
import {test,expect,type Page} from './fixtures.js';
import {navigate} from './navigation.js';
const password='synthetic-deactivation-password-2026';
async function register(page:Page){
  await page.goto('/');await page.getByRole('button',{name:'建立帳號',exact:true}).click();
  const form=page.locator('.login-card form');
  await form.locator('[name=email]').fill(`deactivate-${randomUUID()}@example.test`);
  await form.locator('[name=password]').fill(password);await form.locator('[name=nickname]').fill('Deactivation member');
  await form.getByRole('button',{name:'建立帳號，先逛工坊',exact:true}).click();
  await expect(page.locator('.welcome-preview')).toBeVisible();
}
async function openNewcomerForm(page:Page){
  const menu=page.locator('.preview-profile-menu');await menu.locator(':scope > summary').click();
  await menu.getByRole('button',{name:'停用帳號',exact:true}).click();
  const form=menu.getByRole('form',{name:'停用帳號',exact:true});
  await expect(form.getByRole('button',{name:'確認停用帳號並登出所有裝置',exact:true})).toBeEnabled();return form;
}
for(const surface of ['preview','onboarding'] as const)test(`newcomer can deactivate from ${surface} before joining a guild`,async({page})=>{
  await page.setViewportSize({width:320,height:844});await register(page);
  if(surface==='onboarding'){
    await page.locator('.welcome-optional > summary').click();
    await page.locator('.welcome-optional .experience-actions button').first().click();
    await expect(page.locator('.onboarding-layout')).toBeVisible();
  }
  const form=await openNewcomerForm(page);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await form.getByLabel('目前密碼',{exact:true}).fill(password);
  const result=page.waitForResponse(response=>response.url().endsWith('/me/account/deactivate'));
  await form.getByRole('button',{name:'確認停用帳號並登出所有裝置',exact:true}).click();expect((await result).status()).toBe(200);
  await expect(page.locator('.login-card')).toBeVisible();expect((await page.request.get('/api/v1/session')).status()).toBe(401);
});

test('committed deactivation with a lost response exits the member shell on retry401',async({page})=>{
  await register(page);await page.locator('.quick-guild-options').getByRole('radio').first().check();
  await page.locator('.quick-join-actions .btn-primary').click();
  const questions=page.locator('.quick-start .guild-question');await expect(questions.first()).toBeVisible();
  for(const question of await questions.all())await question.getByRole('radio').first().check();
  await page.getByRole('button',{name:'加入公會，開始參與',exact:true}).click();
  await expect(page.getByRole('heading',{name:'會員首頁',exact:true,level:1})).toBeVisible();await navigate(page,'我的名片');
  const form=page.getByRole('form',{name:'停用帳號',exact:true});let attempts=0;
  await page.route('**/api/v1/me/account/deactivate',async route=>{
    if(++attempts!==1)return route.continue();
    const response=await route.fetch();expect(response.status()).toBe(200);await route.abort('failed');
  });
  await form.getByLabel('目前密碼',{exact:true}).fill(password);await form.getByRole('button',{name:'確認停用帳號並登出所有裝置',exact:true}).click();
  await expect(form.getByRole('alert')).toBeVisible();await form.getByLabel('目前密碼',{exact:true}).fill(password);
  const retry=page.waitForResponse(response=>response.url().endsWith('/me/account/deactivate'));
  await form.getByRole('button',{name:'確認停用帳號並登出所有裝置',exact:true}).click();expect((await retry).status()).toBe(401);
  await expect(page.locator('.login-card')).toBeVisible();await expect(page.locator('.account-panel')).toHaveCount(0);expect(attempts).toBe(2);
});
