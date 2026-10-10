import {test,expect} from './member-feature-fixture.js';
import {DEMO_USERS,DEMO_PASSWORD} from '../../packages/testing/seed.js';
import {tokenHash} from '../../modules/identity-membership/service.js';

const mailbox:{to:string;subject:string;body:string}[]=[];
test.use({memberFeatures:{eventEmailSender:async(to,subject,body)=>{mailbox.push({to,subject,body});}}});

test('a signed-out member confirms a real email-change link after the requesting session expires',async({page,e2eAuthPool},testInfo)=>{
  mailbox.length=0;
  const id=DEMO_USERS[0].user_id;
  const original=(await e2eAuthPool.query('SELECT email,email_verified_at FROM users WHERE user_id=$1',[id])).rows[0];
  const next='email-change-browser@example.test';
  try{
    await page.goto('/');
    await page.getByLabel('電子郵件',{exact:true}).fill(original.email);
    await page.getByLabel('密碼',{exact:true}).fill(DEMO_PASSWORD);
    await page.getByRole('button',{name:'登入',exact:true}).click();
    await expect(page.locator('.shell')).toBeVisible();
    await page.goto('/#account');
    const panel=page.locator('form').filter({has:page.getByRole('heading',{name:'變更登入 Email',exact:true})});
    await panel.getByLabel('新登入 Email',{exact:true}).fill(next);
    await panel.getByLabel('目前密碼',{exact:true}).fill(DEMO_PASSWORD);
    for(const width of [1440,768,390]){
      await page.setViewportSize({width,height:900});
      await panel.scrollIntoViewIfNeeded();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.screenshot({path:testInfo.outputPath(`email-change-form-${width}.png`)});
    }
    await panel.getByRole('button',{name:'寄送 Email 變更驗證信',exact:true}).click();
    await expect(panel.getByRole('status')).toContainText('驗證信已寄到新 Email');
    expect(mailbox).toHaveLength(1);
    expect(mailbox[0].to).toBe(next);
    const token=/#change-email\/([A-Za-z0-9_-]{43})/.exec(mailbox[0].body)?.[1];
    expect(token).toBeTruthy();
    const proof=(await e2eAuthPool.query('SELECT requesting_session_hash FROM login_email_change_tokens WHERE token_hash=$1',[tokenHash(token!)])).rows[0];
    await e2eAuthPool.query("UPDATE sessions SET created_at=clock_timestamp()-interval '1 day',expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[proof.requesting_session_hash]);
    await page.context().clearCookies();
    await page.goto(`/#change-email/${token}`);
    await expect(page.getByRole('heading',{name:'確認變更登入 Email',exact:true})).toBeVisible();
    expect((await page.request.get('/api/v1/session')).status()).toBe(401);
    for(const width of [1440,768,390]){
      await page.setViewportSize({width,height:900});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.screenshot({path:testInfo.outputPath(`email-change-confirm-${width}.png`)});
    }
    await page.getByRole('button',{name:'確認變更登入 Email',exact:true}).click();
    await expect(page.getByRole('status')).toContainText('登入 Email 已變更');
    expect((await e2eAuthPool.query('SELECT email FROM users WHERE user_id=$1',[id])).rows[0].email).toBe(next);
    expect((await e2eAuthPool.query('SELECT expires_at>clock_timestamp() AS active FROM sessions WHERE token_hash=$1',[proof.requesting_session_hash])).rows[0].active).toBe(false);
    expect((await page.request.get('/api/v1/session')).status()).toBe(401);
    expect(mailbox).toHaveLength(2);
    expect(mailbox[1].to).toBe(original.email);
    expect(mailbox[1].body).toContain('嘗試');
    // A different hash must mount a fresh confirmation, never reuse prior success.
    await page.goto(`/#change-email/${'Z'.repeat(43)}`);
    await expect(page.getByRole('button',{name:'確認變更登入 Email',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'確認變更登入 Email',exact:true}).click();
    await expect(page.getByRole('alert')).toContainText('變更連結無效或已過期');
    await page.goto(`/#change-email/${token}`);
    await page.getByRole('button',{name:'確認變更登入 Email',exact:true}).click();
    await expect(page.getByRole('alert')).toContainText('變更連結無效或已過期');
  }finally{
    await e2eAuthPool.query('UPDATE users SET email=$2,email_verified_at=$3 WHERE user_id=$1',[id,original.email,original.email_verified_at]);
    await e2eAuthPool.query('DELETE FROM login_email_change_tokens WHERE user_id=$1',[id]);
  }
});
