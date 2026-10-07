import {randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {Pool} from 'pg';
import {test,expect,type Page,type Browser,type Locator,type BrowserContext} from './fixtures.js';
import {navigate} from './navigation.js';
import {LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {e2eSchema} from '../../packages/testing/e2e-auth-isolation.js';
import {DEMO_USERS,DEMO_COMMUNITY,DEMO_PASSWORD} from '../../packages/testing/seed.js';

// Real local API/DB and synthetic members. Only the lost-ACK case intercepts a
// response, after forwarding the request to the real server and committing it.
const guild='guild_ai_vibe';
type Account={id:string;email:string;name:string};
let db:Pool,accounts:Account[],opened:BrowserContext[];
test.beforeEach(async()=>{
  mkdirSync('test-results/social-chat',{recursive:true});
  db=new Pool({connectionString:process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL,options:`-c search_path=${e2eSchema(process.env.FREEDOM_E2E_SCHEMA)}`,max:4});
  accounts=[];opened=[];
  for(const role of ['甲','乙','丙']){
    const id=randomUUID(),account={id,email:`stickers-${id}@example.test`,name:`貼圖${role} ${id.slice(0,8)}`};accounts.push(account);
    await db.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,onboarding_required)
      SELECT $1,$2,$3,$4,password_hash,$5,false FROM users WHERE user_id=$6`,[id,DEMO_COMMUNITY,account.email,account.name,randomUUID(),DEMO_USERS[0].user_id]);
    await db.query("INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state) VALUES($1,$2,$3,$4,'active')",[randomUUID(),DEMO_COMMUNITY,id,guild]);
  }
});
test.afterEach(async()=>{
  for(const context of opened)await context.close();
  const ids=accounts.map(account=>account.id),q=await db.connect();
  try{
    await q.query('BEGIN');
    for(const table of ['member_channel_reads','positioning_profession_memberships','sessions','member_client_errors','command_receipts'])await q.query(`DELETE FROM ${table} WHERE user_id=ANY($1::uuid[])`,[ids]);
    await q.query('DELETE FROM member_channel_messages WHERE sender_ref=ANY($1::uuid[])',[ids]);
    await q.query('DELETE FROM member_direct_messages WHERE sender_ref=ANY($1::uuid[]) OR recipient_ref=ANY($1::uuid[])',[ids]);
    await q.query('DELETE FROM member_notifications WHERE recipient_ref=ANY($1::uuid[])',[ids]);
    await q.query('DELETE FROM outbox WHERE transition_id IN (SELECT transition_id FROM transition_journal WHERE actor_ref=ANY($1::uuid[]))',[ids]);
    await q.query('DELETE FROM transition_journal WHERE actor_ref=ANY($1::uuid[])',[ids]);
    await q.query('DELETE FROM users WHERE user_id=ANY($1::uuid[])',[ids]);await q.query('COMMIT');
  }catch(error){await q.query('ROLLBACK');throw error;}finally{q.release();await db.end();}
});
async function member(browser:Browser,baseURL:string,index:number,width=1280){
  const context=await browser.newContext({baseURL,viewport:{width,height:900}});opened.push(context);
  await context.route(url=>!['127.0.0.1','localhost'].includes(url.hostname),route=>route.abort());
  const page=await context.newPage(),account=accounts[index];await page.goto('/');
  await page.getByLabel('電子郵件',{exact:true}).fill(account.email);await page.getByLabel('密碼',{exact:true}).fill(DEMO_PASSWORD);
  await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.getByRole('button',{name:'設定',exact:true})).toBeVisible();
  await navigate(page,'我的訊息');return page;
}
async function group(page:Page,kind:'guild'|'world'='guild'){
  await returnToList(page);
  await page.getByRole('tab',{name:new RegExp(kind==='guild'?'^公會閒聊':'^世界聊天')}).click();
  const panel=page.locator(`#messages-panel-${kind}`);if(kind==='guild')await panel.locator(`[data-channel-key="${guild}"]`).click();
  else if(await panel.getByRole('button',{name:'世界聊天',exact:true}).isVisible())await panel.getByRole('button',{name:'世界聊天',exact:true}).click();
  await expect(panel.locator('.messages-compose')).toBeVisible();return panel;
}
async function returnToList(page:Page){const back=page.locator('.messages-hub>[role=tabpanel]:not([hidden]) .chat-back');if(await back.isVisible())await back.click();}
async function direct(page:Page,account:Account){
  await returnToList(page);
  await page.getByRole('tab',{name:/^私人訊息/}).click();const panel=page.locator('#messages-panel-direct');
  if(!await panel.getByLabel('搜尋會員',{exact:true}).isVisible())await panel.getByRole('button',{name:'← 返回對話列表',exact:true}).click();
  await panel.getByLabel('搜尋會員',{exact:true}).fill(account.name);await panel.getByRole('button',{name:'搜尋會員',exact:true}).click();
  await panel.getByRole('button',{name:`傳訊給 ${account.name}`,exact:true}).click();await expect(panel.locator('.messages-compose')).toBeVisible();return panel;
}
async function choose(panel:Locator,label:string){
  await panel.getByRole('button',{name:'選擇貼圖',exact:true}).click();await panel.getByRole('button',{name:`選用貼圖：${label}`,exact:true}).click();
  await expect(panel.getByLabel('待送出的貼圖')).toBeVisible();
}
async function post(page:Page,path:string,data:unknown){
  const session=await (await page.request.get('/api/v1/session')).json(),origin=new URL(page.url()).origin;
  const response=await page.request.post(`/api/v1${path}`,{data,headers:{Origin:origin,'X-CSRF-Token':session.csrf_token,'Idempotency-Key':randomUUID()}});
  expect(response.status()).toBe(201);return response.json();
}

for(const [outgoing,incoming] of [[25,0],[1,21]]){
  test(`private read receipts refresh older loaded history (${outgoing} outgoing, ${incoming} newer incoming)`,async({browser,baseURL})=>{
    await db.query(`INSERT INTO member_direct_messages(community_id,sender_ref,recipient_ref,body,created_at)
      SELECT $1,$2,$3,'合成舊訊息 '||i,now()-interval '1 hour'+i*interval '1 second' FROM generate_series(1,$4::int) AS i`,[DEMO_COMMUNITY,accounts[0].id,accounts[1].id,outgoing]);
    if(incoming)await db.query(`INSERT INTO member_direct_messages(community_id,sender_ref,recipient_ref,body,created_at)
      SELECT $1,$2,$3,'合成回覆 '||i,now()-interval '1 hour'+(100+i)*interval '1 second' FROM generate_series(1,$4::int) AS i`,[DEMO_COMMUNITY,accounts[1].id,accounts[0].id,incoming]);
    const sender=await member(browser,baseURL!,0),a=await direct(sender,accounts[1]);
    await a.getByRole('button',{name:'載入較早訊息',exact:true}).click();
    await expect(a.locator('.messages-bubbles > li')).toHaveCount(outgoing+incoming);
    const receipts=a.locator('.messages-bubbles > .is-mine .messages-meta');
    await expect(receipts).toHaveCount(outgoing);await expect(receipts).toHaveText(Array.from({length:outgoing},()=>/已送出/));
    const receiver=await member(browser,baseURL!,1),b=await direct(receiver,accounts[0]);
    await expect.poll(async()=>(await db.query('SELECT count(*)::int AS n FROM member_direct_messages WHERE sender_ref=$1 AND recipient_ref=$2 AND read_at IS NULL',[accounts[0].id,accounts[1].id])).rows[0].n).toBe(0);
    await expect(b.getByRole('button',{name:'標為已讀',exact:true})).toHaveCount(0);
    await sender.bringToFront();
    await expect(receipts).toHaveText(Array.from({length:outgoing},()=>/對方已讀/));
  });
}

test('mobile guild sticker replies are received and reload from the real database; picker is searchable and keyboard friendly',async({browser,baseURL})=>{
  const sender=await member(browser,baseURL!,0),receiver=await member(browser,baseURL!,1,390),a=await group(sender),b=await group(receiver);
  const parent=await post(sender,`/me/channels/guild/${guild}/messages`,{body:'一起完成第一個作品？'});
  const original=b.locator(`[data-message-id="${parent.message_id}"]`);await expect(original).toBeVisible();
  await original.getByRole('button',{name:`回覆${accounts[0].name}的訊息`,exact:true}).click();
  await b.getByRole('button',{name:'選擇貼圖',exact:true}).click();const search=b.getByLabel('搜尋貼圖',{exact:true});await expect(search).toBeFocused();
  await search.fill('合作');await search.press('Enter');await expect(b.getByRole('button',{name:'選用貼圖：一起共創'})).toBeVisible();
  expect((await db.query('SELECT count(*)::int AS n FROM member_channel_messages WHERE sender_ref=$1',[accounts[1].id])).rows[0].n).toBe(0);
  await search.press('Escape');await expect(b.getByRole('button',{name:'選擇貼圖',exact:true})).toBeFocused();
  await choose(b,'一起共創');await b.getByRole('button',{name:'送出',exact:true}).click();
  const received=a.locator('.messages-bubbles>li').filter({has:sender.locator('[data-sticker-id="workshop-v1-together"]')});await expect(received).toHaveCount(1);
  await expect(received.getByLabel('回覆的訊息')).toContainText('一起完成第一個作品？');
  await receiver.reload();await receiver.getByRole('tab',{name:/^公會閒聊/}).click();await b.locator(`[data-channel-key="${guild}"]`).click();
  await expect(b.locator('.messages-bubbles [data-sticker-id="workshop-v1-together"]')).toHaveCount(1);
  expect(await receiver.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  for(const button of [b.getByRole('button',{name:'選擇貼圖',exact:true}),b.getByRole('button',{name:'送出',exact:true})])expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  mkdirSync('test-results/social-chat',{recursive:true});await receiver.screenshot({path:'test-results/social-chat/guild-sticker-reply-390.png',fullPage:true});
});

test('mobile private chat uses one pane, preserves drafts and shows confirmed read receipts without sending on keyboard Enter',async({browser,baseURL})=>{
  const sender=await member(browser,baseURL!,0,390),receiver=await member(browser,baseURL!,1),a=await direct(sender,accounts[1]),b=await direct(receiver,accounts[0]);
  await receiver.getByRole('tab',{name:/^通知/}).click();
  await expect(a.locator('.messages-side')).toBeHidden();await expect(a.getByRole('heading',{name:`與 ${accounts[1].name} 的對話`})).toBeVisible();
  const box=a.getByLabel(`寫給 ${accounts[1].name} 的訊息`);await box.fill('一起討論作品');await box.press('Enter');await box.pressSequentially('明天見');
  expect((await db.query('SELECT count(*)::int AS n FROM member_direct_messages WHERE sender_ref=$1',[accounts[0].id])).rows[0].n).toBe(0);
  await a.getByRole('button',{name:'送出',exact:true}).click();
  const sent=a.locator('.messages-bubbles>li').filter({hasText:'明天見'});await expect(sent).toContainText('已送出');await expect(sent).not.toContainText('對方已讀');
  await receiver.getByRole('tab',{name:/^私人訊息/}).click();await expect(b.locator('.messages-bubbles')).toContainText('明天見');
  await expect(sent).toContainText('對方已讀');await expect(b.getByRole('button',{name:'標為已讀',exact:true})).toHaveCount(0);
  await box.fill('這份草稿留給乙');await a.getByRole('button',{name:'← 返回對話列表',exact:true}).click();
  await expect(a.locator('.messages-side')).toBeVisible();await expect(a.locator('.messages-thread')).toBeHidden();await expect(a.getByRole('heading',{name:'對話',exact:true})).toBeFocused();
  await direct(sender,accounts[2]);await expect(a.locator('textarea')).toHaveValue('');await a.locator('textarea').fill('這份留給丙');
  await direct(sender,accounts[1]);await expect(box).toHaveValue('這份草稿留給乙');await expect(a.locator('.messages-side')).toBeHidden();
  expect(await sender.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await sender.evaluate(()=>scrollTo(0,0));
  const [sendBox,inputBox]=[await a.getByRole('button',{name:'送出',exact:true}).boundingBox(),await box.boundingBox()];
  const viewport=sender.viewportSize()!,logBox=(await a.getByRole('log').boundingBox())!;
  expect(sendBox!.y+sendBox!.height).toBeLessThanOrEqual(viewport.height-12);expect(inputBox!.y+inputBox!.height).toBeLessThanOrEqual(viewport.height-12);
  expect(logBox.height).toBeGreaterThanOrEqual(viewport.height/2);expect(logBox.width).toBe(viewport.width);
  await expect(sender.locator('.messages-categories')).toBeHidden();await expect(sender.locator('.community-header')).toBeHidden();await expect(sender.locator('.game-console-ticker')).toBeHidden();await expect(sender.locator('.game-console-expanded')).toBeHidden();
  await expect(sender.locator('.demo-banner')).toBeVisible();expect((await a.locator('.chat-header').boundingBox())!.y).toBeLessThan(80);
  const avatarBox=(await a.locator('.chat-header>.member-avatar').boundingBox())!;expect(avatarBox.width).toBe(36);expect(avatarBox.height).toBe(36);
  await sender.screenshot({path:'test-results/social-chat/private-workspace-390.png',fullPage:true});
  await a.locator('.messages-thread').screenshot({path:'test-results/social-chat/private-workspace-chat-390.png'});
  // Chromium does not open a software keyboard in this fixture. Exercise its visual viewport resize separately.
  await sender.evaluate(()=>{Object.defineProperty(visualViewport!,'height',{configurable:true,get:()=>520});visualViewport!.dispatchEvent(new Event('resize'));});
  await expect.poll(async()=>{const bound=(await box.boundingBox())!;return bound.y+bound.height;}).toBeLessThanOrEqual(508);
  await expect(box).toHaveValue('這份草稿留給乙');await expect(a.getByRole('button',{name:'送出',exact:true})).toBeVisible();
  await sender.evaluate(()=>{Reflect.deleteProperty(visualViewport!,'height');visualViewport!.dispatchEvent(new Event('resize'));});
});

test('mobile return to channel list keeps rich drafts and desktop resizing restores both panes',async({browser,baseURL})=>{
  const page=await member(browser,baseURL!,0,320),panel=await group(page);
  await panel.locator('textarea').fill('公會專用的草稿');await choose(panel,'一起共創');
  await panel.getByRole('button',{name:'← 返回公會列表',exact:true}).click();await expect(panel.locator('.messages-thread')).toBeHidden();await expect(panel.locator('.messages-side')).toBeVisible();
  await expect(page.locator('.messages-categories')).toBeVisible();await expect(page.locator('.community-header')).toBeVisible();await expect(page.locator('.game-console-ticker')).toBeVisible();
  await panel.locator(`[data-channel-key="${guild}"]`).click();await expect(panel.getByLabel('待送出的貼圖')).toBeVisible();
  await panel.getByRole('button',{name:'改寫文字',exact:true}).click();await expect(panel.locator('textarea')).toHaveValue('公會專用的草稿');
  await page.setViewportSize({width:1280,height:900});await expect(panel.locator('.messages-side')).toBeVisible();await expect(panel.locator('.messages-thread')).toBeVisible();
  await page.setViewportSize({width:320,height:780});await expect(panel.locator('.messages-side')).toBeHidden();await expect(panel.locator('textarea')).toBeVisible();
  for(const button of [panel.getByRole('button',{name:'← 返回公會列表',exact:true}),panel.getByRole('button',{name:'送出',exact:true})])expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.evaluate(()=>scrollTo(0,0));
  await page.screenshot({path:'test-results/social-chat/guild-workspace-320.png',fullPage:true});
});

test('real private sticker replies stay in their conversation and rich drafts follow the selected partner',async({browser,baseURL})=>{
  const sender=await member(browser,baseURL!,0),receiver=await member(browser,baseURL!,1),a=await direct(sender,accounts[1]),b=await direct(receiver,accounts[0]);
  const first=await post(receiver,`/me/conversations/${accounts[0].id}/messages`,{body:'先對一下合作方向'});
  await expect(a.locator(`[data-message-id="${first.message_id}"]`)).toBeVisible();
  await a.locator(`[data-message-id="${first.message_id}"]`).getByRole('button',{name:`回覆${accounts[1].name}的訊息`,exact:true}).click();
  await choose(a,'謝謝');await direct(sender,accounts[2]);await expect(a.getByLabel('待送出的貼圖')).toHaveCount(0);await expect(a.locator('.chat-reply-draft')).toHaveCount(0);
  await direct(sender,accounts[1]);await expect(a.getByLabel('待送出的貼圖')).toBeVisible();await expect(a.locator('.chat-reply-draft')).toContainText('先對一下合作方向');
  await a.getByRole('button',{name:'送出',exact:true}).click();await expect(b.locator('.messages-bubbles [data-sticker-id="workshop-v1-thanks"]')).toHaveCount(1);
  await receiver.reload();await direct(receiver,accounts[0]);await expect(b.locator('.messages-bubbles .chat-quote')).toContainText('先對一下合作方向');
  expect((await db.query('SELECT count(*)::int AS n FROM member_direct_messages WHERE sender_ref=$1 AND recipient_ref=$2',[accounts[0].id,accounts[2].id])).rows[0].n).toBe(0);
  await receiver.screenshot({path:'test-results/social-chat/private-sticker-reply-1280.png',fullPage:true});
});

test('a sticker whose real server ACK is lost retries with the same payload and key, keeping the unfinished text draft',async({browser,baseURL})=>{
  const page=await member(browser,baseURL!,0),panel=await group(page),path=`/api/v1/me/channels/guild/${guild}/messages`;
  await panel.locator('textarea').fill('這段文字先留著');await choose(panel,'加油');
  const sends:{key:string;body:unknown}[]=[];
  await page.route(`**${path}`,async route=>{if(route.request().method()!=='POST')return route.continue();
    sends.push({key:route.request().headers()['idempotency-key'],body:route.request().postDataJSON()});
    const response=await route.fetch();expect(response.status()).toBe(201);if(sends.length===1)return route.abort();return route.fulfill({response});
  });
  await panel.getByRole('button',{name:'送出',exact:true}).click();await expect(panel.getByRole('alert')).toContainText('傳送結果未確認');
  await panel.getByRole('button',{name:'重試送出',exact:true}).click();await expect(panel.locator('.messages-bubbles [data-sticker-id="workshop-v1-cheer"]')).toHaveCount(1);
  expect(sends).toHaveLength(2);expect(sends[1]).toEqual(sends[0]);await expect(panel.locator('textarea')).toHaveValue('這段文字先留著');
  expect((await db.query('SELECT count(*)::int AS n FROM member_channel_messages WHERE sender_ref=$1 AND sticker_id IS NOT NULL',[accounts[0].id])).rows[0].n).toBe(1);
});

test('world and squad chat use the same real sticker flow, and the picker fits all themes at 320px',async({browser,baseURL})=>{
  const page=await member(browser,baseURL!,0,320),world=await group(page,'world');
  await choose(world,'你好');await world.getByRole('button',{name:'傳送',exact:true}).click();await expect(world.locator('.messages-bubbles [data-sticker-id="workshop-v1-hello"]')).toHaveCount(1);
  const squad=randomUUID();await db.query("INSERT INTO member_squads(squad_id,community_id,name,kind,purpose,owner_ref) VALUES($1,$2,'貼圖合成小隊','project','測試聊天',$3)",[squad,DEMO_COMMUNITY,accounts[0].id]);
  await db.query("INSERT INTO member_squad_memberships(squad_id,user_id,state) VALUES($1,$2,'active')",[squad,accounts[0].id]);
  try{
    await page.reload();await page.getByRole('tab',{name:/^小隊閒聊/}).click();const panel=page.locator('#messages-panel-squad');await panel.locator(`[data-channel-key="${squad}"]`).click();
    await choose(panel,'加油');await panel.getByRole('button',{name:'送出',exact:true}).click();await expect(panel.locator('.messages-bubbles [data-sticker-id="workshop-v1-cheer"]')).toHaveCount(1);
    for(const [theme,value] of [['自由工坊－明亮','light'],['自由工坊－夜航','dark'],['自由工坊－敘生','versefolk']]){
      await panel.getByRole('button',{name:'← 返回小隊列表',exact:true}).click();
      await page.getByRole('button',{name:'設定',exact:true}).click();await page.getByRole('menuitemradio',{name:theme,exact:true}).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme',value);if(await page.getByRole('button',{name:'設定',exact:true}).getAttribute('aria-expanded')==='true')await page.getByRole('button',{name:'設定',exact:true}).click();
      await panel.locator(`[data-channel-key="${squad}"]`).click();
      await panel.getByRole('button',{name:'選擇貼圖',exact:true}).click();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      const image=panel.locator('.chat-sticker-choice img').first();await expect.poll(()=>image.evaluate(element=>(element as HTMLImageElement).complete&&(element as HTMLImageElement).naturalWidth>0)).toBe(true);
      await page.screenshot({path:`test-results/social-chat/picker-${value}-320.png`,fullPage:true});await panel.getByRole('button',{name:'關閉貼圖',exact:true}).click();
    }
  }finally{
    await db.query("DELETE FROM member_channel_reads WHERE kind='squad' AND channel_key=$1",[squad]);await db.query("DELETE FROM member_channel_messages WHERE kind='squad' AND channel_key=$1",[squad]);
    await db.query("DELETE FROM member_chat_channels WHERE kind='squad' AND channel_key=$1",[squad]);await db.query('DELETE FROM member_squad_memberships WHERE squad_id=$1',[squad]);await db.query('DELETE FROM member_squads WHERE squad_id=$1',[squad]);
  }
});

test('phone public chat returns to the conversation list and keeps private and public drafts',async({browser,baseURL})=>{
  const page=await member(browser,baseURL!,0,390),privateChat=await direct(page,accounts[1]);
  await privateChat.locator('textarea').fill('私人草稿');
  const world=await group(page,'world');await world.locator('textarea').fill('公開草稿');
  await world.getByRole('button',{name:'← 返回對話列表',exact:true}).click();
  await expect(page.locator('.messages-categories')).toBeVisible();await expect(privateChat.locator('.messages-side')).toBeVisible();await expect(privateChat.locator('.messages-thread')).toBeHidden();
  await expect(privateChat.getByRole('heading',{name:'對話',exact:true})).toBeFocused();
  await direct(page,accounts[1]);await expect(privateChat.locator('textarea')).toHaveValue('私人草稿');
  await group(page,'world');await expect(world.locator('textarea')).toHaveValue('公開草稿');
  await world.getByRole('button',{name:'← 返回對話列表',exact:true}).click();
  // A console/deep-link intent opens the actual public conversation, rather than stopping at its phone list.
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('freedom-open-channel',{detail:{kind:'world',key:'world'}})));
  await expect(world.locator('.messages-compose')).toBeVisible();await expect(world.locator('textarea')).toHaveValue('公開草稿');await expect(page.locator('.messages-categories')).toBeHidden();
  expect((await db.query('SELECT count(*)::int AS n FROM member_direct_messages WHERE sender_ref=$1',[accounts[0].id])).rows[0].n).toBe(0);
});
