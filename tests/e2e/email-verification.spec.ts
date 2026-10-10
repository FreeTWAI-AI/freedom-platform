import { test,expect } from './fixtures.js';
import { tokenHash } from '../../modules/identity-membership/service.js';

test('account send error and one-use confirmation work on desktop and phone',async({page,e2eAuthPool})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'作者示範帳號 maker@local.test',exact:true}).click();
  await page.getByRole('button',{name:'登入',exact:true}).click();
  await expect(page.getByRole('button',{name:'設定',exact:true})).toBeVisible();
  const user=(await e2eAuthPool.query('SELECT user_id FROM users WHERE email=$1',['maker@local.test'])).rows[0];
  await e2eAuthPool.query('UPDATE users SET email_verified_at=NULL WHERE user_id=$1',[user.user_id]);
  await page.goto('/#account');
  await expect(page.getByRole('heading',{name:'登入信箱驗證'})).toBeVisible();
  await page.getByRole('button',{name:'寄送驗證信',exact:true}).click();
  await expect(page.getByText('驗證信郵件服務尚未設定完成。',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  // Synthetic mailbox proof; the UI talks to the actual confirmation endpoint.
  // Issuance/delivery and hashed-only storage are covered by the runtime suite.
  const token='V'.repeat(43);
  await e2eAuthPool.query("INSERT INTO email_verification_tokens(token_hash,user_id,email,expires_at) VALUES($1,$2,$3,now()+interval '30 minutes')",[tokenHash(token),user.user_id,'maker@local.test']);
  await page.setViewportSize({width:390,height:844});
  await page.goto(`/#verify-email/${token}`);
  await expect(page.getByRole('heading',{name:'驗證登入信箱',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByRole('button',{name:'確認驗證信箱'}).click();
  await expect(page.getByText('登入信箱已完成驗證。',{exact:true})).toBeVisible();
  await page.getByRole('link',{name:'返回帳號頁'}).click();
  await expect(page.getByText('maker@local.test · 已驗證',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'寄送驗證信',exact:true})).toHaveCount(0);
  await page.goto(`/#verify-email/${token}`);
  await page.getByRole('button',{name:'確認驗證信箱'}).click();
  await expect(page.getByText('驗證連結無效或已過期，請回帳號頁重新寄送。',{exact:true})).toBeVisible();
});
