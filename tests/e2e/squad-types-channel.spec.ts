import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {navigate} from './navigation.js';
import {test,expect,type Page} from './fixtures.js';

async function member(pool:Pool,label:string){
  const id=randomUUID(),email=`squad-channel-${id}@local.test`;
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,onboarding_required)
    SELECT $1,community_id,$2,$3,password_hash,$4,false FROM users WHERE email='maker@local.test'`,[id,email,label,randomUUID()]);
  return email;
}
async function login(page:Page,email:string){
  await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill(email);
  await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');
  await page.getByRole('button',{name:'登入',exact:true}).click();
  await expect(page.getByRole('button',{name:'登出',exact:true})).toBeVisible();
}

test('a coaching squad shows its public channel and owner can rename it on desktop and phone',async({page,e2eAuthPool})=>{
  const owner=await member(e2eAuthPool,'陪跑隊主'),viewer=await member(e2eAuthPool,'路過會員'),name=`陪跑練習 ${randomUUID().slice(0,8)}`;
  await page.setViewportSize({width:1440,height:900});
  await login(page,owner);await navigate(page,'小隊集合');
  const form=page.locator('form').filter({has:page.getByRole('heading',{name:'成立一支小隊'})});
  await form.getByLabel('小隊名稱').fill(name);
  await form.getByLabel('小隊類型').selectOption('coaching');
  await form.getByLabel('我們想一起完成什麼').fill('每週互相陪伴練習。');
  await form.getByLabel('小隊溝通頻道名稱（選填）').fill('LINE 陪跑交流');
  await form.getByRole('button',{name:'成立小隊'}).click();
  const detail=page.getByRole('region',{name:'小隊詳情'});
  await expect(detail.getByText('溝通頻道：LINE 陪跑交流')).toBeVisible();
  await page.screenshot({path:'test-results/squad-channel-desktop.png'});
  await detail.getByLabel('小隊溝通頻道名稱',{exact:true}).fill('LINE 新頻道');
  await detail.getByRole('button',{name:'儲存頻道名稱'}).click();
  await expect(detail.getByText('溝通頻道：LINE 新頻道')).toBeVisible();
  await page.getByRole('button',{name:'登出',exact:true}).click();
  await login(page,viewer);await navigate(page,'小隊集合');
  await page.getByLabel('搜尋小隊',{exact:true}).fill(name);
  await page.getByLabel('篩選小隊類型').selectOption('coaching');
  const card=page.locator('.expedition-squad').filter({hasText:name});
  await expect(card.getByText('陪跑小隊')).toBeVisible();
  await expect(card.getByText('溝通頻道：LINE 新頻道')).toBeVisible();
  await card.getByRole('button',{name:`查看小隊：${name}`}).click();
  await expect(detail.getByText('溝通頻道：LINE 新頻道')).toBeVisible();
  await expect(detail.getByRole('button',{name:'儲存頻道名稱'})).toHaveCount(0);
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/squad-channel-phone.png',fullPage:true});
});
