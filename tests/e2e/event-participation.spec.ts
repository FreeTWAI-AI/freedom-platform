import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {test,expect} from './fixtures.js';
import {DEMO_COMMUNITY,DEMO_USERS} from '../../packages/testing/seed.js';

// Registered only in the explicit local feature pass, never the default suite.
if(process.env.FREEDOM_E2E_EVENT_PARTICIPATION==='1') test('member privately downloads ICS and opts into and cancels reminders',async({page,request,e2eAuthPool})=>{
  const id=randomUUID(),title=`私人行事曆 ${id}`;
  await e2eAuthPool.query(`INSERT INTO community_events(event_id,community_id,organizer_ref,title,description,starts_at,ends_at,mode,location,state,visibility,event_kind)
    VALUES($1,$2,$3,$4,'私人活動說明',now()+interval '2 days',now()+interval '2 days 1 hour','in_person','合成活動地點','published','workshop','other')`,[id,DEMO_COMMUNITY,DEMO_USERS[0].user_id,title]);
  await page.context().route(url=>!['127.0.0.1','localhost'].includes(url.hostname),route=>route.abort());
  expect((await request.get(`/api/v1/events/${id}/calendar`)).status()).toBe(401);
  await page.goto('/');
  await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');
  await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');
  await page.getByRole('button',{name:'登入',exact:true}).click();
  await expect(page.locator('.shell')).toBeVisible();
  await page.goto(`/#events/${id}`);
  const panel=page.getByRole('region',{name:'本人活動參與設定',exact:true});
  await expect(panel.getByText('你的報名：尚未報名。',{exact:false})).toBeVisible();
  await expect(panel.getByRole('checkbox')).not.toBeChecked();
  const downloadReady=page.waitForEvent('download');
  const downloadButton=panel.getByRole('button',{name:'下載行事曆 .ics',exact:true});
  await downloadButton.focus();await page.keyboard.press('Enter');
  const download=await downloadReady;
  expect(download.suggestedFilename()).toBe(`event-${id}.ics`);
  const calendar=await readFile((await download.path())!,'utf8');
  expect(calendar).toContain(`UID:${id}@freetwai.com\r\n`);
  expect(calendar).toMatch(/DTSTART:\d{8}T\d{6}Z\r\n/);
  expect(calendar).not.toMatch(/ATTENDEE|participation=|maker@local\.test/);
  await expect(panel.getByRole('checkbox')).not.toBeChecked();
  expect((await page.request.get(`/api/v1/events/${id}/participation`).then(r=>r.json())).rsvp_state).toBeNull();
  const card=page.locator('article').filter({has:page.getByRole('heading',{name:title,exact:true})});
  await card.getByRole('button',{name:'我要參加',exact:true}).click();
  await expect(panel).toContainText('你的報名：已報名');
  await panel.getByRole('checkbox').check();
  await panel.getByLabel('開始前幾分鐘',{exact:true}).fill('30');
  await panel.getByLabel('通知方式',{exact:true}).selectOption('in_app');
  await panel.getByRole('button',{name:'儲存提醒選擇',exact:true}).click();
  await expect(panel).toContainText('目前狀態：等待提醒時間');
  for(const theme of ['light','dark','versefolk']){
    await page.evaluate(value=>{localStorage.setItem('freedom-theme',value);document.documentElement.dataset.theme=value;},theme);
    for(const width of [1280,320,390]){
      await page.setViewportSize({width,height:900});
      await expect(downloadButton).toBeVisible();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    }
  }
  await panel.getByRole('checkbox').uncheck();
  await panel.getByRole('button',{name:'儲存提醒選擇',exact:true}).click();
  await expect(panel).toContainText('未寄出的提醒已取消');
  await panel.getByRole('checkbox').check();
  await panel.getByRole('button',{name:'儲存提醒選擇',exact:true}).click();
  await expect(panel).toContainText('目前狀態：等待提醒時間');
  await card.getByRole('button',{name:'取消報名',exact:true}).click();
  await expect(panel).toContainText('你的報名：已取消');
  const reminder=await page.request.get(`/api/v1/events/${id}/reminder`).then(r=>r.json());
  expect(reminder).toMatchObject({enabled:false,status:'cancelled'});
});
