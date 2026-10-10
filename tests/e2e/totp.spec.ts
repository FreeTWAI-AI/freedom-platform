import {test,expect,type Page} from './member-feature-fixture.js';
import {DEMO_USERS,DEMO_PASSWORD} from '../../packages/testing/seed.js';
import {totpCode} from '../../modules/identity-membership/totp.js';

const userId=DEMO_USERS[0].user_id,email=DEMO_USERS[0].email;
const resetLinks:string[]=[];
let originalHash='';
test.use({memberFeatures:{totpEncryptionKey:Buffer.alloc(32,0x74).toString('base64'),passwordEmailSender:async(_to,url)=>{resetLinks.push(url);}}});
test.beforeEach(async({e2eAuthPool})=>{
  originalHash=(await e2eAuthPool.query('SELECT password_hash FROM users WHERE user_id=$1',[userId])).rows[0].password_hash;
  resetLinks.length=0;
});
test.afterEach(async({e2eAuthPool})=>{
  await e2eAuthPool.query('DELETE FROM member_totp_backup_codes WHERE user_id=$1',[userId]);
  await e2eAuthPool.query('DELETE FROM member_totp WHERE user_id=$1',[userId]);
  await e2eAuthPool.query('DELETE FROM password_reset_tokens WHERE user_id=$1',[userId]);
  if(originalHash)await e2eAuthPool.query('UPDATE users SET password_hash=$2 WHERE user_id=$1',[userId,originalHash]);
});
async function passwordLogin(page:Page,password=DEMO_PASSWORD){
  await page.goto('/#account');
  await page.getByLabel('電子郵件',{exact:true}).fill(email);
  await page.getByLabel('密碼',{exact:true}).fill(password);
  await page.getByRole('button',{name:'登入',exact:true}).click();
}
async function logout(page:Page){
  await page.getByRole('button',{name:'設定',exact:true}).click();
  await page.getByRole('button',{name:'登出',exact:true}).click();
  await expect(page.getByLabel('電子郵件',{exact:true})).toBeVisible();
}

test('enrollment, authenticator login, one-use backup and MFA password reset finish in the browser',async({page,e2eAuthPool},testInfo)=>{
  await passwordLogin(page);
  const panel=page.locator('.totp-settings');
  await panel.getByRole('button',{name:'設定驗證器',exact:true}).click();
  const secret=await panel.getByLabel('驗證器金鑰',{exact:true}).inputValue();
  const counter=Number((await e2eAuthPool.query('SELECT floor(extract(epoch FROM clock_timestamp())/30)::bigint AS counter')).rows[0].counter);
  await panel.getByLabel('目前密碼',{exact:true}).fill(DEMO_PASSWORD);
  await panel.getByLabel('驗證器目前的六位數代碼',{exact:true}).fill(totpCode(secret,counter));
  for(const width of [1440,768,390]){
    await page.setViewportSize({width,height:900});
    await panel.scrollIntoViewIfNeeded();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:testInfo.outputPath(`totp-enrollment-${width}.png`)});
  }
  await panel.getByRole('button',{name:'確認啟用',exact:true}).click();
  const codes=(await panel.getByLabel('備用碼',{exact:true}).inputValue()).split('\n');
  expect(codes).toHaveLength(10);
  await panel.getByRole('button',{name:'已保存，隱藏備用碼',exact:true}).click();
  await logout(page);
  await passwordLogin(page);
  await expect(page.getByLabel('驗證器代碼或備用碼',{exact:true})).toBeVisible();
  expect((await page.request.get('/api/v1/session')).status()).toBe(401);
  await page.getByLabel('驗證器代碼或備用碼',{exact:true}).fill(totpCode(secret,counter+1));
  await page.getByRole('button',{name:'登入',exact:true}).click();
  await expect(panel.getByRole('button',{name:'停用雙因素驗證',exact:true})).toBeVisible();
  await logout(page);
  await passwordLogin(page);
  await page.getByLabel('驗證器代碼或備用碼',{exact:true}).fill(codes[0]);
  await page.getByRole('button',{name:'登入',exact:true}).click();
  await expect(panel).toContainText('剩餘 9 組備用碼');
  await logout(page);
  await passwordLogin(page);
  await page.getByLabel('驗證器代碼或備用碼',{exact:true}).fill(codes[0]);
  await page.getByRole('button',{name:'登入',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('備用碼只能使用一次');
  expect((await page.request.get('/api/v1/session')).status()).toBe(401);
  await page.getByRole('button',{name:'忘記密碼？',exact:true}).click();
  await page.getByLabel('電子郵件',{exact:true}).fill(email);
  await page.getByRole('button',{name:'寄送重設連結',exact:true}).click();
  await expect.poll(()=>resetLinks.length).toBe(1);
  await page.goto(resetLinks[0]);
  const rotated='mfa-browser-password-2026';
  await page.getByLabel('新密碼',{exact:true}).fill(rotated);
  await page.getByLabel('再次輸入新密碼',{exact:true}).fill(rotated);
  await page.getByRole('button',{name:'儲存新密碼',exact:true}).click();
  await expect(page.getByText('密碼已重設。請使用新密碼登入，並輸入驗證器代碼或備用碼。',{exact:true})).toBeVisible();
  expect((await page.request.get('/api/v1/session')).status()).toBe(401);
  await passwordLogin(page,rotated);
  await page.getByLabel('驗證器代碼或備用碼',{exact:true}).fill(codes[1]);
  await page.getByRole('button',{name:'登入',exact:true}).click();
  await expect(panel).toContainText('剩餘 8 組備用碼');
  await panel.getByLabel('目前密碼',{exact:true}).fill(rotated);
  await panel.getByLabel('驗證器代碼或備用碼',{exact:true}).fill(codes[2]);
  await panel.getByRole('button',{name:'停用雙因素驗證',exact:true}).click();
  await expect(panel.getByRole('button',{name:'設定驗證器',exact:true})).toBeVisible();
});

test('lost enable response reuses the receipt and recovers status without replaying backup codes',async({page,e2eAuthPool})=>{
  await passwordLogin(page);
  const panel=page.locator('.totp-settings');
  await panel.getByRole('button',{name:'設定驗證器',exact:true}).click();
  const secret=await panel.getByLabel('驗證器金鑰',{exact:true}).inputValue();
  const counter=Number((await e2eAuthPool.query('SELECT floor(extract(epoch FROM clock_timestamp())/30)::bigint AS counter')).rows[0].counter);
  await panel.getByLabel('目前密碼',{exact:true}).fill(DEMO_PASSWORD);
  await panel.getByLabel('驗證器目前的六位數代碼',{exact:true}).fill(totpCode(secret,counter));
  const keys:string[]=[];
  await page.route('**/api/v1/me/totp/enable',async route=>{
    keys.push(route.request().headers()['idempotency-key']);
    if(keys.length===1){const committed=await route.fetch();expect(committed.status()).toBe(200);await route.abort('failed');}
    else await route.continue();
  });
  await panel.getByRole('button',{name:'確認啟用',exact:true}).click();
  await expect(panel.getByRole('alert')).toContainText('尚未確認操作結果');
  await panel.getByRole('button',{name:'確認啟用',exact:true}).click();
  await expect(panel.getByRole('button',{name:'停用雙因素驗證',exact:true})).toBeVisible({timeout:3000});
  await expect(panel).toContainText('未取得備用碼');
  expect(keys).toHaveLength(2);expect(keys[1]).toBe(keys[0]);
  await expect(panel.getByLabel('備用碼',{exact:true})).toHaveCount(0);
  await expect(panel.getByLabel('驗證器金鑰',{exact:true})).toHaveCount(0);
  const state=(await e2eAuthPool.query('SELECT enabled,(SELECT count(*)::int FROM member_totp_backup_codes WHERE user_id=$1) AS codes FROM member_totp WHERE user_id=$1',[userId])).rows[0];
  expect(state).toEqual({enabled:true,codes:10});
});
