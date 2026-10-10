import {randomUUID} from 'node:crypto';
import {test,expect,type Page} from './fixtures.js';
import {navigate} from './navigation.js';
const password='synthetic-deactivation-password-2026';
async function register(page:Page){
  await page.goto('/');await page.getByRole('button',{name:'建立帳號',exact:true}).click();
  const form=page.locator('.login-card form');
  const email=`deactivate-${randomUUID()}@example.test`;
  await form.locator('[name=email]').fill(email);
  await form.locator('[name=password]').fill(password);await form.locator('[name=nickname]').fill('Deactivation member');
  await form.getByRole('button',{name:'建立帳號，先逛工坊',exact:true}).click();
  await expect(page.locator('.welcome-preview')).toBeVisible();return email;
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

test('committed deactivation with a lost response exits the member shell on retry401',async({page},info)=>{
  await register(page);await page.locator('.quick-guild-options').getByRole('radio').first().check();
  await page.locator('.quick-join-actions .btn-primary').click();
  const questions=page.locator('.quick-start .guild-question');await expect(questions.first()).toBeVisible();
  for(const question of await questions.all())await question.getByRole('radio').first().check();
  await page.getByRole('button',{name:'加入公會，開始參與',exact:true}).click();
  await expect(page.getByRole('heading',{name:'會員首頁',exact:true,level:1})).toBeVisible();await navigate(page,'我的名片');
  const form=page.getByRole('form',{name:'停用帳號',exact:true});let attempts=0;
  const passwordForm=page.getByRole('form',{name:'修改密碼',exact:true});
  await expect(passwordForm).toBeVisible();
  for(const width of [1440,768,390]){
    await page.setViewportSize({width,height:900});await form.scrollIntoViewIfNeeded();
    await expect(form.getByLabel('目前密碼',{exact:true})).toBeVisible();
    await expect(form.getByRole('button',{name:'確認停用帳號並登出所有裝置',exact:true})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:info.outputPath(`account-deactivation-${width}.png`)});
  }
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

for(const [operation,conflict] of [['password',false],['sessions',false],['password',true]] as const)test(`same-page ${operation} change ${conflict?'retains concurrent-profile conflict':'refreshes deactivation version without clearing profile edits'}`,async({page,browser,baseURL,e2eAuthPool})=>{
  const email=await register(page);
  await page.locator('.quick-guild-options').getByRole('radio').first().check();
  await page.locator('.quick-join-actions .btn-primary').click();
  const questions=page.locator('.quick-start .guild-question');await expect(questions.first()).toBeVisible();
  for(const question of await questions.all())await question.getByRole('radio').first().check();
  await page.getByRole('button',{name:'加入公會，開始參與',exact:true}).click();
  await expect(page.getByRole('heading',{name:'會員首頁',exact:true,level:1})).toBeVisible();await navigate(page,'我的名片');
  const nickname=page.getByLabel('社群顯示名稱',{exact:true});await nickname.fill('Unsaved profile draft');
  if(conflict){
    await e2eAuthPool.query('UPDATE users SET display_name=$1 WHERE email=$2',['Another device profile',email]);
    await e2eAuthPool.query('UPDATE member_accounts SET aggregate_version=aggregate_version+1 WHERE user_id=(SELECT user_id FROM users WHERE email=$1)',[email]);
  }
  const security=page.locator('.account-security');
  let currentPassword=password;
  const refreshed=page.waitForResponse(response=>response.url().endsWith('/me/account')&&response.request().method()==='GET');
  if(operation==='password'){
    currentPassword='synthetic-rotated-deactivation-2026';
    const form=page.getByRole('form',{name:'修改密碼',exact:true});
    await form.getByLabel('目前密碼',{exact:true}).fill(password);
    await form.getByLabel('新密碼',{exact:true}).fill(currentPassword);
    await form.getByLabel('再次輸入新密碼',{exact:true}).fill(currentPassword);
    await form.getByRole('button',{name:'更新密碼',exact:true}).click();
  }else{
    const other=await browser.newContext({baseURL});
    try{
      const login=await other.request.post('/api/v1/auth/login',{headers:{Origin:new URL(baseURL!).origin},data:{email,password}});expect(login.status()).toBe(200);
      await security.getByRole('button',{name:'重新讀取',exact:true}).click();
      await expect(security.getByRole('button',{name:'登出其他裝置',exact:true})).toBeEnabled();
      await security.getByRole('button',{name:'登出其他裝置',exact:true}).click();
    }finally{await other.close();}
  }
  expect((await refreshed).status()).toBe(200);
  await expect(nickname).toHaveValue('Unsaved profile draft');
  const form=page.getByRole('form',{name:'停用帳號',exact:true});
  await form.getByLabel('目前密碼',{exact:true}).fill(currentPassword);
  const result=page.waitForResponse(response=>response.url().endsWith('/me/account/deactivate'));
  await form.getByRole('button',{name:'確認停用帳號並登出所有裝置',exact:true}).click();
  expect((await result).status()).toBe(conflict?409:200);
  if(conflict){
    await expect(page.getByRole('alert').filter({hasText:'帳號資料已在其他操作中變更'})).toBeVisible();
    await expect(nickname).toHaveValue('Unsaved profile draft');
    expect((await e2eAuthPool.query('SELECT display_name FROM users WHERE email=$1',[email])).rows[0].display_name).toBe('Another device profile');
  }else await expect(page.locator('.login-card')).toBeVisible();
});
