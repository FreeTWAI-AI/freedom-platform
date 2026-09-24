import {randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import type {Pool} from 'pg';
import {test,expect,type Browser,type Page} from './fixtures.js';
import {DEMO_COMMUNITY,DEMO_PASSWORD} from '../../packages/testing/seed.js';
import {hashPassword} from '../../modules/identity-membership/service.js';

// Real API end to end: no inbox, member or friend routes are stubbed and nothing
// may leave the local server. Other suites change the demo members' friends and
// mail in the same schema, so this case uses two accounts that exist only for
// this run; they start at exactly zero unread.
const SHOTS='/tmp/freedom-member-settings-real-shots';
type Account={user_id:string;email:string;display_name:string};

async function syntheticAccounts(db:Pool):Promise<[Account,Account]>{
  const run=randomUUID().slice(0,8);
  const guild=(await db.query('SELECT guild_key FROM positioning_guild_catalog ORDER BY guild_key LIMIT 1')).rows[0].guild_key as string;
  const accounts=(['sender','receiver'] as const).map(role=>{const user_id=randomUUID();
    return {user_id,email:`inbox-${role}-${user_id}@example.invalid`,display_name:`合成${role==='sender'?'寄件':'收件'}人 ${run}`};});
  for(const account of accounts){
    // Test fixture only: a finished member (onboarding_required=false) with the documented local demo password.
    await db.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,onboarding_required)
      VALUES($1,$2,$3,$4,$5,$6,false)`,[account.user_id,DEMO_COMMUNITY,account.email,account.display_name,hashPassword(DEMO_PASSWORD),randomUUID()]);
    await db.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state) VALUES($1,$2,$3,$4,'active')`,[randomUUID(),DEMO_COMMUNITY,account.user_id,guild]);
    await db.query('INSERT INTO guild_member_preferences(community_id,user_id,primary_guild_key) VALUES($1,$2,$3)',[DEMO_COMMUNITY,account.user_id,guild]);
  }
  return accounts as [Account,Account];
}

async function member(browser:Browser,baseURL:string,user:Account,viewport:{width:number;height:number}){
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
  const unread=async(kind:'conversations'|'notifications')=>{const response=await page.request.get(`/api/v1/me/${kind}?limit=1&offset=0`);expect(response.status()).toBe(200);return (await response.json() as {unread_count:number}).unread_count;};
  return {context,page,id:session.user.user_id,post,unread};
}
const settings=(page:Page)=>page.getByRole('button',{name:'設定',exact:true});
const inboxItem=(page:Page)=>page.getByRole('menuitem',{name:'我的訊息',exact:true});
async function menuUnread(page:Page){
  await settings(page).click();const text=(await inboxItem(page).textContent())??'';
  await page.keyboard.press('Escape');return text;
}
async function expectZero(page:Page){
  await expect(settings(page).locator('.settings-dot')).toHaveCount(0);
  await expect.poll(()=>menuUnread(page)).toBe('我的訊息');
}
async function noOverflow(page:Page){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
// Full-page shots start at the top so the sticky header is drawn in place.
async function shot(page:Page,name:string){await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:`${SHOTS}/${name}.png`,fullPage:true});}

test('two synthetic members exchange a private message and a friend notification through the live API',async({browser,baseURL,e2eAuthPool:db})=>{
  mkdirSync(SHOTS,{recursive:true});
  const [sender,receiver]=await syntheticAccounts(db);
  const senderSide=await member(browser,baseURL!,sender,{width:1440,height:900});
  const receiverSide=await member(browser,baseURL!,receiver,{width:320,height:844});
  const s=senderSide.page,r=receiverSide.page;
  const githubWrites:string[]=[];r.on('request',request=>{if(request.method()!=='GET'&&request.url().includes('/api/v1/me/github'))githubWrites.push(request.url());});
  try{
    // Fresh accounts: exactly zero, on the API and on screen.
    expect(await receiverSide.unread('conversations')).toBe(0);expect(await receiverSide.unread('notifications')).toBe(0);
    expect(await senderSide.unread('conversations')).toBe(0);
    await expectZero(r);

    // The GitHub task shows whatever the local server really reports; it is never started from here.
    await settings(r).click();await r.getByRole('menuitem',{name:'待辦清單',exact:true}).click();await expect(r).toHaveURL(/#todos$/);
    const task=r.locator('[data-task="github"]');
    await expect(task.getByRole('status')).toHaveText(/^(尚未啟用|待完成|已完成)$/);
    await noOverflow(r);await shot(r,'tasks-320');

    // The sender finds the receiver through the real member search and writes plain text.
    await settings(s).click();await inboxItem(s).click();await expect(s).toHaveURL(/#messages$/);
    await s.getByRole('tab',{name:/私訊/}).click();
    const sPanel=s.getByRole('tabpanel',{name:/私訊/}),sThread=sPanel.locator('.messages-thread');
    await sPanel.getByLabel('搜尋會員').fill(receiver.display_name);await sPanel.getByRole('button',{name:'搜尋會員',exact:true}).click();
    await expect(sPanel.getByRole('list',{name:'會員搜尋結果'}).getByRole('button')).toHaveCount(1);
    await sPanel.getByRole('list',{name:'會員搜尋結果'}).getByRole('button',{name:`傳訊給 ${receiver.display_name}`}).click();
    await expect(sThread.getByRole('heading',{name:`與 ${receiver.display_name} 的對話`})).toBeFocused();
    const sBox=sThread.getByLabel(`寫給 ${receiver.display_name} 的訊息`);
    const first=`<b>真實私訊</b> & <img src=x> ${Date.now()}`;
    await sBox.fill(`  ${first}  `);
    const sent=s.waitForRequest(request=>request.method()==='POST'&&request.url().endsWith(`/api/v1/me/conversations/${receiverSide.id}/messages`));
    await sThread.getByRole('button',{name:'送出',exact:true}).click();
    const sendKey=(await sent).headers()['idempotency-key'];
    await expect(sThread.locator('.messages-bubbles .messages-body').last()).toHaveText(first);
    await expect(sThread.locator('.messages-bubbles b, .messages-bubbles img')).toHaveCount(0);await expect(sBox).toHaveValue('');
    const stored=(await db.query('SELECT message_id,read_at FROM member_direct_messages WHERE sender_ref=$1 AND recipient_ref=$2',[senderSide.id,receiverSide.id])).rows;
    expect(stored).toHaveLength(1);expect(stored[0].read_at).toBeNull();
    // Replaying the browser's key returns the same stored message instead of a duplicate.
    const replay=await senderSide.post(`/me/conversations/${receiverSide.id}/messages`,{body:first},sendKey);
    expect(replay.status()).toBe(201);expect((await replay.json()).message_id).toBe(stored[0].message_id);
    expect((await db.query('SELECT count(*)::int AS n FROM member_direct_messages WHERE sender_ref=$1',[senderSide.id])).rows[0].n).toBe(1);
    expect((await db.query('SELECT count(*)::int AS n FROM command_receipts WHERE user_id=$1 AND idempotency_key=$2',[senderSide.id,sendKey])).rows[0].n).toBe(1);

    // 0 → 1: the receiver's open page re-reads the real totals on window focus.
    await r.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await expect(settings(r).locator('.settings-dot')).toBeVisible();await expect(settings(r)).toHaveAccessibleName('設定');
    await settings(r).click();
    await expect(r.getByRole('menuitem')).toHaveText(['我的名片','待辦清單','我的訊息1 則未讀']);
    await noOverflow(r);await shot(r,'settings-320');
    await inboxItem(r).click();await expect(r).toHaveURL(/#messages$/);await expect(r.locator('#main-content')).toBeFocused();
    await expect(r.getByRole('tab',{name:/私訊/})).toContainText('1 則未讀');await expect(r.getByRole('tab',{name:/通知/})).toContainText('沒有未讀');
    await r.getByRole('tab',{name:/私訊/}).click();
    const rPanel=r.getByRole('tabpanel',{name:/私訊/}),rThread=rPanel.locator('.messages-thread'),rList=rPanel.getByRole('list',{name:'對話列表'});
    const fromSender=rList.getByRole('button',{name:new RegExp(sender.display_name)});
    await expect(rList.getByRole('button')).toHaveCount(1);await expect(fromSender).toContainText('1 則未讀');
    await fromSender.click();
    await expect(rThread.getByRole('heading',{name:`與 ${sender.display_name} 的對話`})).toBeFocused();
    await expect(rThread.getByText(first,{exact:true})).toBeVisible();await expect(rThread.locator('.messages-bubbles b, .messages-bubbles img')).toHaveCount(0);
    // Opening the thread did not mark it read, on the API or in PostgreSQL.
    expect(await receiverSide.unread('conversations')).toBe(1);
    expect((await db.query('SELECT read_at FROM member_direct_messages WHERE message_id=$1',[stored[0].message_id])).rows[0].read_at).toBeNull();
    // 1 → 0 by an explicit read.
    await rThread.getByRole('button',{name:'標為已讀',exact:true}).click();
    // The button is renamed while the read is out; the tab total changes only after the server confirms.
    await expect(r.getByRole('tab',{name:/私訊/})).toContainText('沒有未讀');await expect(rThread.getByRole('button',{name:/標為已讀|正在標記/})).toHaveCount(0);
    expect(await receiverSide.unread('conversations')).toBe(0);
    expect((await db.query('SELECT read_at FROM member_direct_messages WHERE message_id=$1',[stored[0].message_id])).rows[0].read_at).not.toBeNull();
    await expect(fromSender).not.toContainText('則未讀');
    await expectZero(r);

    // A second message while both pages stay open: the receiver re-reads by hand and keeps an unsent draft.
    const rBox=rThread.getByLabel(`寫給 ${sender.display_name} 的訊息`);await rBox.fill('還沒送出的草稿');
    const second=`第二則真實私訊 ${Date.now()}`;
    await sBox.fill(second);await sThread.getByRole('button',{name:'送出',exact:true}).click();
    await expect(sThread.locator('.messages-bubbles .messages-body').last()).toHaveText(second);
    await expect(rThread.getByText(second,{exact:true})).toHaveCount(0);
    const refreshList=rPanel.getByRole('button',{name:'重新整理對話',exact:true});await refreshList.click();
    await expect(fromSender).toContainText(second.slice(0,20));await expect(fromSender).toContainText('1 則未讀');await expect(refreshList).toBeFocused();
    await expect(r.getByRole('tab',{name:/私訊/})).toContainText('1 則未讀');
    const refreshThread=rThread.getByRole('button',{name:'重新讀取訊息',exact:true});await refreshThread.click();
    await expect(rThread.locator('.messages-bubbles .messages-body').last()).toHaveText(second);await expect(refreshThread).toBeFocused();
    await expect(rBox).toHaveValue('還沒送出的草稿');
    expect(await receiverSide.unread('conversations')).toBe(1);
    await rThread.getByRole('button',{name:'標為已讀',exact:true}).click();
    await expect(r.getByRole('tab',{name:/私訊/})).toContainText('沒有未讀');await expect(rThread.getByRole('button',{name:/標為已讀|正在標記/})).toHaveCount(0);
    expect(await receiverSide.unread('conversations')).toBe(0);

    // The receiver replies; the sender's list goes 0 → 1 on a manual re-read.
    const answer=`收件人回覆 <i>純文字</i> ${Date.now()}`;
    await rBox.fill(answer);await rThread.getByRole('button',{name:'送出',exact:true}).click();
    await expect(rThread.locator('.messages-bubbles .messages-body').last()).toHaveText(answer);await expect(rBox).toHaveValue('');
    expect(await senderSide.unread('conversations')).toBe(1);
    await sPanel.getByRole('button',{name:'重新整理對話',exact:true}).click();
    await expect(sPanel.getByRole('list',{name:'對話列表'}).getByRole('button',{name:new RegExp(receiver.display_name)})).toContainText('1 則未讀');
    await sThread.getByRole('button',{name:'重新讀取訊息',exact:true}).click();
    await expect(sThread.locator('.messages-bubbles .messages-body')).toHaveText([first,second,answer]);
    await expect(sThread.locator('.messages-bubbles li.is-mine')).toHaveCount(2);await expect(sThread.locator('.messages-bubbles b, .messages-bubbles i, .messages-bubbles img')).toHaveCount(0);
    // The unread badge stays inside its conversation button.
    const sPeer=sPanel.getByRole('list',{name:'對話列表'}).getByRole('button',{name:new RegExp(receiver.display_name)});
    const badge=sPeer.locator('.messages-count'),[peerBox,badgeBox]=[await sPeer.boundingBox(),await badge.boundingBox()];
    expect(await badge.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);expect(badgeBox!.x+badgeBox!.width).toBeLessThanOrEqual(peerBox!.x+peerBox!.width);
    await shot(s,'direct-desktop');
    await sThread.getByRole('button',{name:'標為已讀',exact:true}).click();
    await expect(s.getByRole('tab',{name:/私訊/})).toContainText('沒有未讀');await expect(sThread.getByRole('button',{name:/標為已讀|正在標記/})).toHaveCount(0);
    expect(await senderSide.unread('conversations')).toBe(0);
    await expect(rThread.locator('.messages-bubbles .messages-body')).toHaveText([first,second,answer]);
    await noOverflow(r);await shot(r,'direct-320');

    // A real friend request creates exactly one notification, also when the same key is replayed: 0 → 1.
    const friendKey=randomUUID();
    for(let i=0;i<2;i++)expect((await senderSide.post(`/friends/${receiverSide.id}/request`,{},friendKey)).status()).toBe(200);
    const notices=(await db.query("SELECT notification_id,read_at,action_tab,action_resource_id FROM member_notifications WHERE recipient_ref=$1",[receiverSide.id])).rows;
    expect(notices).toHaveLength(1);expect(notices[0]).toMatchObject({read_at:null,action_tab:'members',action_resource_id:senderSide.id});
    expect(await receiverSide.unread('notifications')).toBe(1);
    await r.getByRole('tab',{name:/通知/}).click();
    const nPanel=r.getByRole('tabpanel',{name:/通知/}),refreshNotices=nPanel.getByRole('button',{name:'重新整理通知',exact:true});
    await refreshNotices.click();
    const notice=nPanel.locator(`li[data-notification="${notices[0].notification_id}"]`);
    await expect(notice).toContainText(`${sender.display_name} 想加你為好友。`);await expect(notice).toContainText('未讀');
    await expect(refreshNotices).toBeFocused();
    await expect(r.getByRole('tab',{name:/通知/})).toContainText('1 則未讀');
    await r.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await expect(settings(r).locator('.settings-dot')).toBeVisible();await expect.poll(()=>menuUnread(r)).toBe('我的訊息1 則未讀');
    await noOverflow(r);await shot(r,'notifications-320');
    // 1 → 0: the action reads first, then opens the fixed members page with focus in main.
    await notice.getByRole('button',{name:'前往工坊夥伴',exact:true}).click();
    await expect(r).toHaveURL(/#members$/);await expect(r.locator('#main-content')).toBeFocused();
    expect(await receiverSide.unread('notifications')).toBe(0);expect(await receiverSide.unread('conversations')).toBe(0);
    expect((await db.query('SELECT read_at FROM member_notifications WHERE notification_id=$1',[notices[0].notification_id])).rows[0].read_at).not.toBeNull();
    await expectZero(r);
    expect(githubWrites).toEqual([]);
  }finally{
    await senderSide.context.close();await receiverSide.context.close();
    // The schema is dropped by the harness; until then the accounts stop appearing in later cases' directories.
    await db.query('UPDATE users SET active=false WHERE user_id=ANY($1::uuid[])',[[sender.user_id,receiver.user_id]]);
  }
});
