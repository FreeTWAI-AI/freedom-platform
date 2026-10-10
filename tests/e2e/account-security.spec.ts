import {test,expect,type Page} from './fixtures.js';

// Synthetic demo account only; the password is restored at the end so later specs keep signing in.
const EMAIL='client@local.test',ORIGINAL='freedom-local-demo',ROTATED='rotated-demo-password-2026';
let originalHash:string;

test.beforeEach(async({page,e2eAuthPool})=>{
  originalHash=(await e2eAuthPool.query('SELECT password_hash FROM users WHERE email=$1',[EMAIL])).rows[0].password_hash;
  await page.route(url=>!['127.0.0.1','localhost'].includes(url.hostname),route=>route.abort());
});
test.afterEach(async({e2eAuthPool})=>{
  // A failed assertion after rotation must not poison later cases in this schema.
  if(originalHash)await e2eAuthPool.query('UPDATE users SET password_hash=$1 WHERE email=$2',[originalHash,EMAIL]);
});

async function login(page:Page,password:string){
  await page.goto('/#account');
  await page.getByLabel('電子郵件',{exact:true}).fill(EMAIL);await page.getByLabel('密碼',{exact:true}).fill(password);
  await page.getByRole('button',{name:'登入',exact:true}).click();
  await expect(page.getByRole('heading',{name:'登入與安全'})).toBeVisible();
}
async function changePassword(page:Page,current:string,next:string){
  const form=page.getByRole('form',{name:'修改密碼'});
  await form.getByLabel('目前密碼',{exact:true}).fill(current);
  await form.getByLabel('新密碼',{exact:true}).fill(next);
  await form.getByLabel('再次輸入新密碼',{exact:true}).fill(next);
  await form.getByRole('button',{name:'更新密碼'}).click();
}

test('a member rotates the password, sees other devices signed out, and can end other sessions',async({page,browser,baseURL})=>{
  await login(page,ORIGINAL);
  const security=page.locator('.account-security');
  await expect(security.locator('.session-row strong',{hasText:'這個裝置'})).toBeVisible();
  await expect(security.getByRole('button',{name:'登出其他裝置'})).toBeDisabled();

  // A second browser signs in: the list now shows another device.
  const other=await browser.newContext({baseURL:baseURL??undefined});
  try{
  const otherPage=await other.newPage();
  await otherPage.route(url=>!['127.0.0.1','localhost'].includes(url.hostname),route=>route.abort());
  await login(otherPage,ORIGINAL);
  await security.getByRole('button',{name:'重新讀取'}).click();
  await expect(security.locator('.session-row strong',{hasText:'其他裝置'})).toBeVisible();
  await expect(security.getByRole('button',{name:'登出其他裝置'})).toBeEnabled();

  // Wrong current password changes nothing and keeps the form.
  await changePassword(page,'definitely-wrong-password',ROTATED);
  await expect(security.getByRole('alert')).toContainText('目前密碼不正確');
  const form=page.getByRole('form',{name:'修改密碼'});
  await form.getByLabel('目前密碼',{exact:true}).fill(ORIGINAL);
  await form.getByLabel('新密碼',{exact:true}).fill(ROTATED);
  await form.getByLabel('再次輸入新密碼',{exact:true}).fill(ROTATED+'x');
  await form.getByRole('button',{name:'更新密碼'}).click();
  await expect(security.getByRole('alert')).toContainText('兩次輸入的新密碼不一致。');

  await changePassword(page,ORIGINAL,ROTATED);
  await expect(security.getByRole('status').filter({hasText:'密碼已更新'})).toContainText('其他 1 個裝置已登出');
  await expect(security.locator('.session-row strong',{hasText:'其他裝置'})).toHaveCount(0);
  await page.screenshot({path:'test-results/account-security-desktop.png',fullPage:true});

  // The other device lost its session; the new password works and the old one does not.
  await otherPage.reload();
  await expect(otherPage.getByLabel('電子郵件',{exact:true})).toBeVisible();
  await otherPage.getByLabel('電子郵件',{exact:true}).fill(EMAIL);await otherPage.getByLabel('密碼',{exact:true}).fill(ORIGINAL);
  await otherPage.getByRole('button',{name:'登入',exact:true}).click();
  await expect(otherPage.getByRole('alert')).toContainText('帳號或密碼不正確');
  await otherPage.getByLabel('密碼',{exact:true}).fill(ROTATED);
  await otherPage.getByRole('button',{name:'登入',exact:true}).click();
  await expect(otherPage.getByRole('heading',{name:'登入與安全'})).toBeVisible();

  // Ending other sessions from the first device signs the second one out again.
  await security.getByRole('button',{name:'重新讀取'}).click();
  await expect(security.getByRole('button',{name:'登出其他裝置'})).toBeEnabled();
  await security.getByRole('button',{name:'登出其他裝置'}).click();
  await expect(security.getByRole('status').filter({hasText:'已登出其他'})).toContainText('1 個裝置');
  await otherPage.reload();
  await expect(otherPage.getByLabel('電子郵件',{exact:true})).toBeVisible();

  // Restore the demo password for the rest of the suite.
  await changePassword(page,ROTATED,ORIGINAL);
  await expect(security.getByRole('status').filter({hasText:'密碼已更新'})).toBeVisible();
  }finally{await other.close();}
});

test('the security panel fits a 390px phone',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await login(page,ORIGINAL);
  const security=page.locator('.account-security');
  await security.scrollIntoViewIfNeeded();
  const box=await security.boundingBox();
  expect(box?.width).toBeLessThanOrEqual(390);
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth',390);
  await page.screenshot({path:'test-results/account-security-390.png'});
});

for(const lateStatus of [200,503])test(`a late ${lateStatus} session reload cannot replace the post-revocation list`,async({page,browser,baseURL})=>{
  await login(page,ORIGINAL);
  const other=await browser.newContext({baseURL});
  let release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});
  let started=()=>{};const held=new Promise<void>(resolve=>{started=resolve;});
  try{
    const otherPage=await other.newPage();await login(otherPage,ORIGINAL);
    const security=page.locator('.account-security');
    await security.getByRole('button',{name:'重新讀取',exact:true}).click();
    await expect(security.getByRole('button',{name:'登出其他裝置',exact:true})).toBeEnabled();
    let requests=0;
    await page.route('**/api/v1/me/sessions',async route=>{
      if(++requests!==1)return route.continue();
      const response=await route.fetch();started();await gate;
      if(lateStatus===200)await route.fulfill({response});
      else await route.fulfill({status:503,json:{detail:'Synthetic stale session load failure'}});
    });
    await security.getByRole('button',{name:'重新讀取',exact:true}).click();await held;
    await security.getByRole('button',{name:'登出其他裝置',exact:true}).click();
    await expect(security.locator('.session-row')).toHaveCount(1);
    await expect(security.getByRole('button',{name:'登出其他裝置',exact:true})).toBeDisabled();
    const late=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/v1/me/sessions');
    release();await late;
    // A subsequent UI action flushes the delivered response before asserting.
    await security.getByRole('heading',{name:'登入中的裝置',exact:true}).click();
    await expect(security.locator('.session-row')).toHaveCount(1);
    await expect(security.getByRole('alert')).toHaveCount(0);
    await expect(security.getByRole('button',{name:'登出其他裝置',exact:true})).toBeDisabled();
  }finally{release();await other.close();}
});
