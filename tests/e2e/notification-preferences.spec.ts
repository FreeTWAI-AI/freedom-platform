import {test,expect,type Page} from './fixtures.js';
import {DEMO_PASSWORD,DEMO_COMMUNITY,DEMO_USERS} from '../../packages/testing/seed.js';
import {signOut} from './navigation.js';

async function login(page:Page,email='maker@local.test'){
  await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill(email);await page.getByLabel('密碼',{exact:true}).fill(DEMO_PASSWORD);
  await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.getByRole('heading',{name:'會員首頁',level:1})).toBeVisible();
  await page.goto('/#account');
}
if(process.env.FREEDOM_E2E_NOTIFICATION_PREFERENCES!=='1'){
  test('default OFF hides preferences and rejects routes before authentication',async({page,request})=>{
    expect((await request.get('/api/v1/me/notification-preferences')).status()).toBe(404);
    expect((await request.get('/api/v1/me/notification-preferences/summary')).status()).toBe(404);
    await login(page);await expect(page.getByRole('heading',{name:'通知偏好',exact:true})).toHaveCount(0);
    expect(await page.evaluate(async()=>(await (await fetch('/api/v1/site')).json()).notification_preferences_enabled)).toBe(false);
  });
}else{
  test('real preferences persist, mute accessible channels and preview without email or read changes across themes and sizes',async({page,e2eAuthPool},info)=>{
    test.setTimeout(120000);await login(page);
    const panel=page.locator('.notification-preferences');await expect(panel.getByLabel('好友邀請與結果')).toBeVisible();
    await panel.getByLabel('好友邀請與結果').selectOption('summary');await panel.getByLabel('小隊邀請').selectOption('off');
    await panel.getByLabel('啟用安靜時段').focus();await page.keyboard.press('Space');await expect(panel.getByLabel('啟用安靜時段')).toBeChecked();
    await page.keyboard.press('Tab');await expect(panel.getByLabel('時區（IANA）')).toBeFocused();
    await panel.getByLabel('時區（IANA）').fill('Asia/Taipei');await panel.getByLabel('開始時間').fill('22:00');await panel.getByLabel('結束時間').fill('07:00');
    await panel.getByLabel('頻道類型').selectOption('world');const channels=panel.locator('.notification-preferences-channels input');await expect(channels.first()).toBeVisible();await channels.first().check();
    await expect(panel.getByLabel('未啟用／預設未訂閱')).toBeDisabled();
    await panel.getByRole('button',{name:'儲存通知偏好',exact:true}).focus();await page.keyboard.press('Enter');await expect(panel.getByText('通知偏好已儲存。',{exact:true})).toBeVisible();
    await page.reload();await expect(panel.getByLabel('好友邀請與結果')).toHaveValue('summary');await expect(panel.getByLabel('小隊邀請')).toHaveValue('off');await expect(panel.getByLabel('啟用安靜時段')).toBeChecked();
    await panel.getByLabel('頻道類型').selectOption('world');await expect(channels.first()).toBeChecked();
    const before=(await e2eAuthPool.query('SELECT notification_id,read_at FROM member_notifications ORDER BY notification_id')).rows;
    await panel.getByRole('button',{name:'預覽目前摘要',exact:true}).click();await expect(panel.getByText(/產生時間：/)).toBeVisible();
    expect((await e2eAuthPool.query('SELECT notification_id,read_at FROM member_notifications ORDER BY notification_id')).rows).toEqual(before);
    for(const theme of ['light','dark','versefolk'])for(const width of [1280,320,390]){
      await page.evaluate(value=>{document.documentElement.dataset.theme=value;},theme);await page.setViewportSize({width,height:900});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${theme}/${width}`).toBe(true);
      await panel.getByRole('button',{name:'預覽目前摘要',exact:true}).scrollIntoViewIfNeeded();await expect(panel.getByRole('button',{name:'預覽目前摘要',exact:true})).toBeInViewport();
      await panel.screenshot({path:info.outputPath(`preferences-${theme}-${width}.png`)});
    }
    await signOut(page);await login(page,'reviewer@local.test');await expect(panel.getByLabel('好友邀請與結果')).toHaveValue('instant');await expect(panel.getByLabel('啟用安靜時段')).not.toBeChecked();
  });

  test('full notification history preserves the preference-filtered bell count after opening and reading',async({page,e2eAuthPool})=>{
    const recipient=DEMO_USERS[2];
    await e2eAuthPool.query(`INSERT INTO member_notifications(notification_id,community_id,recipient_ref,kind,source_key,title,body)
      VALUES(gen_random_uuid(),$1,$2,'friend_request','preferences-history-friend','已關閉提醒的好友邀請','仍保留在完整歷史'),
        (gen_random_uuid(),$1,$2,'guild_expert_revoked','preferences-history-essential','必要通知仍會提醒','不受好友偏好影響')`,[DEMO_COMMUNITY,recipient.user_id]);
    await login(page,recipient.email);
    const preferences=page.locator('.notification-preferences');
    await preferences.getByLabel('好友邀請與結果').selectOption('off');
    await preferences.getByRole('button',{name:'儲存通知偏好',exact:true}).click();
    await expect(preferences.getByText('通知偏好已儲存。',{exact:true})).toBeVisible();
    const bell=page.locator('.notification-bell-trigger');
    await expect(bell).toHaveAccessibleName('通知，1 則未讀');
    await bell.click();const history=page.getByRole('region',{name:'最近通知'});
    await history.getByRole('button',{name:'查看所有通知',exact:true}).click();
    await expect(history.getByRole('heading',{name:'最新通知',exact:true})).toBeVisible();
    await expect(history.getByText('已關閉提醒的好友邀請',{exact:true})).toBeVisible();
    await expect(bell).toHaveAccessibleName('通知，1 則未讀');
    const counts=await page.evaluate(async()=>({
      history:(await (await fetch('/api/v1/me/notifications')).json()).unread_count,
      reminders:(await (await fetch('/api/v1/me/notification-preferences/reminders')).json()).unread_count,
    }));
    expect(counts).toEqual({history:2,reminders:1});
    await history.locator('li').filter({hasText:'必要通知仍會提醒'}).getByRole('button',{name:'標為已讀',exact:true}).click();
    await expect(bell).toHaveAccessibleName('通知');
    await history.getByRole('button',{name:'重新整理通知',exact:true}).click();
    await expect(history.getByText('已關閉提醒的好友邀請',{exact:true})).toBeVisible();
    await expect(bell).toHaveAccessibleName('通知');
    expect((await e2eAuthPool.query(`SELECT read_at FROM member_notifications WHERE recipient_ref=$1 AND source_key='preferences-history-friend'`,[recipient.user_id])).rows[0].read_at).toBeNull();
  });
}
