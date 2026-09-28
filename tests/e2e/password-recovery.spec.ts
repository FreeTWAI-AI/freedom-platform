import { test,expect } from './fixtures.js';

test('member can request and use a password reset link on desktop and phone',async({page})=>{
  const token='A'.repeat(43);
  await page.route('**/api/v1/site',async route=>{
    const response=await route.fetch();
    await route.fulfill({response,json:{...await response.json(),password_recovery_enabled:true}});
  });
  let sentTo='';
  await page.route('**/api/v1/auth/reset/request',async route=>{
    const body=route.request().postDataJSON();sentTo=body.email;
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({requested:true})});
  });
  await page.route('**/api/v1/auth/reset/confirm',async route=>{
    const body=route.request().postDataJSON();
    expect(body.token).toBe(token);expect(body.password).toBe('a-new-strong-password-2026');
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({reset:true})});
  });
  await page.goto('/');
  await page.getByRole('button',{name:'忘記密碼？'}).click();
  await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');
  await page.screenshot({path:'test-results/password-recovery-desktop.png'});
  await page.getByRole('button',{name:'寄送重設連結'}).click();
  await expect(page.getByText('若此信箱有可用帳號，且寄送服務正常，請在 30 分鐘內查看重設連結。')).toBeVisible();
  expect(sentTo).toBe('maker@local.test');
  await page.setViewportSize({width:390,height:844});
  await page.goto(`/#reset-password/${token}`);
  await expect(page.getByRole('heading',{name:'設定新密碼'})).toBeVisible();
  await page.getByLabel('新密碼',{exact:true}).fill('a-new-strong-password-2026');
  await page.getByLabel('再次輸入新密碼').fill('a-new-strong-password-2026');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/password-recovery-phone.png'});
  await page.getByRole('button',{name:'儲存新密碼'}).click();
  await expect(page.getByText('密碼已重設，請用新密碼登入。')).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});
