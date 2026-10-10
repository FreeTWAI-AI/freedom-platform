import {randomUUID} from 'node:crypto';
import {test,expect} from './fixtures.js';
import {navigate} from './navigation.js';

// #401: synthetic event and registrations in this run's schema; removed afterwards.
test('the organizer opens the registration list in a dialog; guests show only their time and other members see no button',async({page,e2eAuthPool})=>{
  const id=randomUUID(),title=`名單活動 ${id.slice(0,8)}`;
  const starts=new Date(Date.now()+3*24*60*60*1000),ends=new Date(starts.getTime()+2*60*60*1000);
  await e2eAuthPool.query(`INSERT INTO community_events(event_id,community_id,organizer_ref,title,description,starts_at,ends_at,mode,location,state,visibility,event_kind,capacity)
    SELECT $1,community_id,user_id,$2,'合成活動說明',$3,$4,'online','線上教室','published','open','other',20 FROM users WHERE email='maker@local.test'`,[id,title,starts.toISOString(),ends.toISOString()]);
  await e2eAuthPool.query(`INSERT INTO community_event_rsvps(rsvp_id,event_id,user_id,state,updated_at) SELECT $1,$2,user_id,'going',now()-interval '2 hours' FROM users WHERE email='reviewer@local.test'`,[randomUUID(),id]);
  await e2eAuthPool.query(`INSERT INTO community_event_guest_rsvps(event_id,email,name,email_sent_at,created_at) VALUES($1,'secret-guest@example.org','不該出現的訪客名',now(),now()-interval '1 hour')`,[id]);
  try{
    await page.goto('/');
    await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');
    await page.getByRole('button',{name:'登入',exact:true}).click();
    await navigate(page,'社群活動');
    const card=page.locator('.experience-card',{has:page.getByRole('heading',{name:title})});
    const trigger=card.getByRole('button',{name:'報名名單',exact:true});
    await trigger.click();
    const dialog=page.getByRole('dialog',{name:'報名名單'});
    await expect(dialog).toContainText('目前 2 人報名');
    const rows=dialog.locator('.event-attendee-list li');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('示範需求者');
    await expect(rows.nth(1)).toContainText('公開報名訪客');
    await expect(dialog).not.toContainText('secret-guest@example.org');await expect(dialog).not.toContainText('不該出現的訪客名');
    await page.screenshot({path:'test-results/event-attendees.png'});
    await page.keyboard.press('Escape');await expect(dialog).toBeHidden();await expect(trigger).toBeFocused();
    await page.setViewportSize({width:390,height:844});
    await trigger.click();await expect(rows).toHaveCount(2);
    expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:'test-results/event-attendees-390.png'});
    await dialog.getByRole('button',{name:'關閉',exact:true}).click();await expect(dialog).toBeHidden();

    // Another member sees the event but not the organizer-only list.
    await page.setViewportSize({width:1280,height:900});
    await page.getByRole('button',{name:'設定',exact:true}).click();await page.getByRole('menuitem',{name:'登出',exact:true}).click();
    await page.getByLabel('電子郵件',{exact:true}).fill('client@local.test');await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');
    await page.getByRole('button',{name:'登入',exact:true}).click();
    await navigate(page,'社群活動');
    await expect(card).toBeVisible();
    await expect(card.getByRole('button',{name:'報名名單',exact:true})).toHaveCount(0);
  }finally{
    await e2eAuthPool.query('DELETE FROM community_event_guest_rsvps WHERE event_id=$1',[id]);
    await e2eAuthPool.query('DELETE FROM community_event_rsvps WHERE event_id=$1',[id]);
    await e2eAuthPool.query('DELETE FROM community_events WHERE event_id=$1',[id]);
  }
});
