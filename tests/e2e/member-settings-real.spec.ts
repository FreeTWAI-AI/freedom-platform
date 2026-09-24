import {test,expect,type Browser,type Page} from './fixtures.js';
import {DEMO_PASSWORD,DEMO_USERS} from '../../packages/testing/seed.js';

// Real API end to end: no inbox, member or friend routes are stubbed. Both
// accounts are the synthetic local seed inside this run's isolated schema, and
// nothing may leave the local server.
const [maker,reviewer]=DEMO_USERS;

async function member(browser:Browser,baseURL:string,user:typeof maker,viewport:{width:number;height:number}){
  const context=await browser.newContext({baseURL,viewport});
  await context.route(url=>!['127.0.0.1','localhost'].includes(url.hostname),route=>route.abort());
  const page=await context.newPage();
  await page.goto('/');
  await page.getByLabel('電子郵件',{exact:true}).fill(user.email);await page.getByLabel('密碼',{exact:true}).fill(DEMO_PASSWORD);
  await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.getByRole('button',{name:'登出',exact:true})).toBeVisible();
  // The real session identifies the account; the CSRF token stays in memory only.
  const session=await (await page.request.get('/api/v1/session')).json() as {user:{user_id:string};csrf_token:string};
  expect(session.user.user_id).toBe(user.user_id);
  const post=(path:string,data:unknown,key:string)=>page.request.post(`/api/v1${path}`,{data,headers:{'X-CSRF-Token':session.csrf_token,'Idempotency-Key':key,Origin:new URL(baseURL).origin}});
  const get=async<T,>(path:string)=>{const response=await page.request.get(`/api/v1${path}`);expect(response.status()).toBe(200);return await response.json() as T;};
  return {context,page,id:session.user.user_id,post,get};
}
const settings=(page:Page)=>page.getByRole('button',{name:'設定',exact:true});
async function menuUnread(page:Page){
  await settings(page).click();
  const text=(await page.getByRole('menuitem',{name:'我的訊息',exact:true}).textContent())??'';
  await page.keyboard.press('Escape');return text;
}
type Unread={unread_count:number};

test('two members exchange a private message and a friend notification through the live API',async({browser,baseURL,e2eAuthPool:db})=>{
  const makerSide=await member(browser,baseURL!,maker,{width:1440,height:900});
  const reviewerSide=await member(browser,baseURL!,reviewer,{width:320,height:844});
  const m=makerSide.page,r=reviewerSide.page;
  try{
    const before=await makerSide.get<Unread>('/me/conversations?limit=1&offset=0');
    const noticesBefore=await makerSide.get<Unread>('/me/notifications?limit=1&offset=0');

    // Reviewer finds the maker through the real member search and writes plain text.
    await settings(r).click();await r.getByRole('menuitem',{name:'我的訊息',exact:true}).click();await expect(r).toHaveURL(/#messages$/);
    await r.getByRole('tab',{name:/私訊/}).click();
    const rPanel=r.getByRole('tabpanel',{name:/私訊/}),rThread=rPanel.locator('.messages-thread');
    await rPanel.getByLabel('搜尋會員').fill(maker.display_name);await rPanel.getByRole('button',{name:'搜尋會員',exact:true}).click();
    await rPanel.getByRole('list',{name:'會員搜尋結果'}).getByRole('button',{name:`傳訊給 ${maker.display_name}`}).click();
    await expect(rThread.getByRole('heading',{name:`與 ${maker.display_name} 的對話`})).toBeFocused();
    const first=`<b>真實私訊</b> & <img src=x> ${Date.now()}`;
    await rThread.getByLabel(`寫給 ${maker.display_name} 的訊息`).fill(`  ${first}  `);
    const sent=r.waitForRequest(request=>request.method()==='POST'&&request.url().endsWith(`/api/v1/me/conversations/${makerSide.id}/messages`));
    await rThread.getByRole('button',{name:'送出',exact:true}).click();
    const sendKey=(await sent).headers()['idempotency-key'];
    await expect(rThread.locator('.messages-bubbles .messages-body').last()).toHaveText(first);
    await expect(rThread.locator('.messages-bubbles b, .messages-bubbles img')).toHaveCount(0);
    await expect(rThread.getByLabel(`寫給 ${maker.display_name} 的訊息`)).toHaveValue('');
    const stored=(await db.query('SELECT message_id,body,read_at FROM member_direct_messages WHERE sender_ref=$1 AND recipient_ref=$2 AND body=$3',[reviewerSide.id,makerSide.id,first])).rows;
    expect(stored).toHaveLength(1);expect(stored[0].read_at).toBeNull();
    // Replaying the browser's key returns the same stored message instead of a duplicate.
    const replay=await reviewerSide.post(`/me/conversations/${makerSide.id}/messages`,{body:first},sendKey);
    expect(replay.status()).toBe(201);expect((await replay.json()).message_id).toBe(stored[0].message_id);
    expect((await db.query('SELECT count(*)::int AS n FROM member_direct_messages WHERE sender_ref=$1 AND body=$2',[reviewerSide.id,first])).rows[0].n).toBe(1);
    expect((await db.query('SELECT count(*)::int AS n FROM command_receipts WHERE user_id=$1 AND idempotency_key=$2',[reviewerSide.id,sendKey])).rows[0].n).toBe(1);
    await r.screenshot({path:'/tmp/freedom-member-settings-real-phone.png',fullPage:true});

    // The maker's page was already open: a window focus re-reads the real totals.
    await m.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await expect(settings(m).locator('.settings-dot')).toBeVisible();await expect(settings(m)).toHaveAccessibleName('設定');
    expect(await menuUnread(m)).toContain(`${before.unread_count+noticesBefore.unread_count+1} 則未讀`);
    await settings(m).click();await m.getByRole('menuitem',{name:'我的訊息',exact:true}).click();
    await expect(m).toHaveURL(/#messages$/);await expect(m.locator('#main-content')).toBeFocused();
    await m.getByRole('tab',{name:/私訊/}).click();
    const mPanel=m.getByRole('tabpanel',{name:/私訊/}),mThread=mPanel.locator('.messages-thread'),mList=mPanel.getByRole('list',{name:'對話列表'});
    await expect(mList.getByRole('button',{name:new RegExp(reviewer.display_name)})).toContainText('1 則未讀');
    await mList.getByRole('button',{name:new RegExp(reviewer.display_name)}).click();
    await expect(mThread.getByRole('heading',{name:`與 ${reviewer.display_name} 的對話`})).toBeFocused();
    await expect(mThread.getByText(first,{exact:true})).toBeVisible();await expect(mThread.locator('.messages-bubbles b, .messages-bubbles img')).toHaveCount(0);
    // Reading the thread did not mark it read, on the API or in PostgreSQL.
    expect((await makerSide.get<Unread>('/me/conversations?limit=1&offset=0')).unread_count).toBe(before.unread_count+1);
    expect((await db.query('SELECT read_at FROM member_direct_messages WHERE message_id=$1',[stored[0].message_id])).rows[0].read_at).toBeNull();
    await mThread.getByRole('button',{name:'標為已讀',exact:true}).click();
    await expect(mThread.getByRole('button',{name:'標為已讀',exact:true})).toHaveCount(0);
    expect((await makerSide.get<Unread>('/me/conversations?limit=1&offset=0')).unread_count).toBe(before.unread_count);
    expect((await db.query('SELECT read_at FROM member_direct_messages WHERE message_id=$1',[stored[0].message_id])).rows[0].read_at).not.toBeNull();
    if(before.unread_count+noticesBefore.unread_count===0){
      await expect(m.getByRole('tab',{name:/私訊/})).toContainText('沒有未讀');
      await expect(settings(m).locator('.settings-dot')).toHaveCount(0);expect(await menuUnread(m)).not.toContain('則未讀');
    }

    // A reply while both pages stay open: the maker re-reads by hand and keeps an unsent draft.
    const mBox=mThread.getByLabel(`寫給 ${reviewer.display_name} 的訊息`);await mBox.fill('還沒送出的草稿');
    const reply=`第二則真實私訊 ${Date.now()}`;
    await rThread.getByLabel(`寫給 ${maker.display_name} 的訊息`).fill(reply);await rThread.getByRole('button',{name:'送出',exact:true}).click();
    await expect(rThread.locator('.messages-bubbles .messages-body').last()).toHaveText(reply);
    await expect(mThread.getByText(reply,{exact:true})).toHaveCount(0);
    const refreshList=mPanel.getByRole('button',{name:'重新整理對話',exact:true});await refreshList.click();
    await expect(mList.getByRole('button',{name:new RegExp(reviewer.display_name)})).toContainText(reply.slice(0,20));
    await expect(mList.getByRole('button',{name:new RegExp(reviewer.display_name)})).toContainText('1 則未讀');await expect(refreshList).toBeFocused();
    const refreshThread=mThread.getByRole('button',{name:'重新讀取訊息',exact:true});await refreshThread.click();
    await expect(mThread.locator('.messages-bubbles .messages-body').last()).toHaveText(reply);await expect(refreshThread).toBeFocused();
    await expect(mBox).toHaveValue('還沒送出的草稿');
    expect((await db.query('SELECT read_at FROM member_direct_messages WHERE sender_ref=$1 AND body=$2',[reviewerSide.id,reply])).rows[0].read_at).toBeNull();
    await mThread.getByRole('button',{name:'標為已讀',exact:true}).click();await expect(mThread.getByRole('button',{name:'標為已讀',exact:true})).toHaveCount(0);
    await m.screenshot({path:'/tmp/freedom-member-settings-real-desktop.png',fullPage:true});

    // A real friend request creates exactly one notification, also when the same key is replayed.
    const friendKey=crypto.randomUUID();
    for(let i=0;i<2;i++)expect((await reviewerSide.post(`/friends/${makerSide.id}/request`,{},friendKey)).status()).toBe(200);
    const notices=(await db.query("SELECT notification_id,title,read_at,action_tab,action_resource_id FROM member_notifications WHERE recipient_ref=$1 AND kind='friend_request' AND action_resource_id=$2",[makerSide.id,reviewerSide.id])).rows;
    expect(notices).toHaveLength(1);expect(notices[0]).toMatchObject({read_at:null,action_tab:'members'});
    await m.getByRole('tab',{name:/通知/}).click();
    const nPanel=m.getByRole('tabpanel',{name:/通知/});
    await nPanel.getByRole('button',{name:'重新整理通知',exact:true}).click();
    const notice=nPanel.locator(`li[data-notification="${notices[0].notification_id}"]`);
    await expect(notice).toContainText(`${reviewer.display_name} 想加你為好友。`);
    const noticeUnread=(await makerSide.get<Unread>('/me/notifications?limit=1&offset=0')).unread_count;
    expect(noticeUnread).toBe(noticesBefore.unread_count+1);
    await expect(m.getByRole('tab',{name:/通知/})).toContainText(`${noticeUnread} 則未讀`);
    await m.evaluate(()=>window.dispatchEvent(new Event('focus')));
    expect(await menuUnread(m)).toContain(`${before.unread_count+noticeUnread} 則未讀`);
    // The action reads first, then opens the fixed members page with focus in main.
    await notice.getByRole('button',{name:'前往工坊夥伴',exact:true}).click();
    await expect(m).toHaveURL(/#members$/);await expect(m.locator('#main-content')).toBeFocused();
    expect((await makerSide.get<Unread>('/me/notifications?limit=1&offset=0')).unread_count).toBe(noticeUnread-1);
    expect((await db.query('SELECT read_at FROM member_notifications WHERE notification_id=$1',[notices[0].notification_id])).rows[0].read_at).not.toBeNull();
    const after=before.unread_count+noticeUnread-1;
    if(after)await expect.poll(()=>menuUnread(m)).toContain(`${after} 則未讀`);
    else{await expect.poll(()=>menuUnread(m)).not.toContain('則未讀');await expect(settings(m).locator('.settings-dot')).toHaveCount(0);}
  }finally{
    await makerSide.context.close();await reviewerSide.context.close();
  }
});
