import {randomUUID} from 'node:crypto';
import {test,expect,type Page} from './fixtures.js';
import {DEMO_USERS,DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {navigate,openFeatureSearch} from './navigation.js';
import {quickJoin} from './quick-join.js';

async function login(page:Page,email='maker@local.test'){
  await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill(email);await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.getByRole('heading',{name:'會員首頁',level:1})).toBeVisible();
}

test('a resumed private conversation keeps older history and pages through every new-message gap in order',async({page})=>{
  const participant={user_id:DEMO_USERS[1].user_id,display_name:'私訊測試夥伴',is_online:false,last_seen_at:null};
  const item=(number:number)=>({message_id:`30000000-0000-4000-8000-${String(number).padStart(12,'0')}`,sender_ref:participant.user_id,recipient_ref:DEMO_USERS[0].user_id,body:`歷史訊息 ${String(number).padStart(3,'0')}`,created_at:new Date(Date.UTC(2026,9,1)+number*1000).toISOString(),read_at:null});
  let total=40;const offsets:number[]=[];
  await page.route(/\/api\/v1\/me\/conversations\?/,route=>route.fulfill({json:{items:[{participant,can_send:true,unread_count:0,last_message:item(total)}],unread_count:0,next_offset:null}}));
  await page.route(`**/api/v1/me/conversations/${participant.user_id}/activity`,route=>route.fulfill({json:{last_message_id:item(total).message_id,unread_count:0,can_send:true}}));
  await page.route(`**/api/v1/me/conversations/${participant.user_id}/messages?*`,route=>{
    const query=new URL(route.request().url()).searchParams,offset=Number(query.get('offset')??0),limit=Number(query.get('limit')??20);offsets.push(offset);
    return route.fulfill({json:{participant,can_send:true,items:Array.from({length:total},(_,index)=>item(total-index)).slice(offset,offset+limit),unread_count:0,next_offset:offset+limit<total?offset+limit:null}});
  });
  await login(page);await page.goto('/#messages');await page.getByRole('tab',{name:/^私人訊息/}).click();await page.locator('[aria-label="對話列表"]').getByRole('button').filter({hasText:participant.display_name}).click();
  const thread=page.locator('.member-messages .messages-thread').filter({has:page.getByRole('heading',{name:'與 私訊測試夥伴 的對話'})});
  await expect(thread.locator('.messages-body')).toHaveCount(20);total=70;await thread.getByRole('button',{name:'重新讀取訊息',exact:true}).click();await expect(thread.getByRole('log')).toContainText('歷史訊息 070');
  for(const count of [50,60,70]){await thread.getByRole('button',{name:'載入較早訊息',exact:true}).click();await expect(thread.locator('.messages-body')).toHaveCount(count)}
  expect(offsets).toEqual([0,0,20,40,60]);expect(await thread.locator('.messages-body').allTextContents()).toEqual(Array.from({length:70},(_,index)=>item(index+1).body));
});
test('anonymous visitors can preview a real free resource before creating an account',async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.goto('/');await page.getByText('先看免費資源，不用註冊',{exact:true}).click();
  await expect(page.locator('.entry-resource-list article')).toHaveCount(3);await page.locator('.entry-resource-list').getByRole('button',{name:'免費預覽',exact:true}).first().click();await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('synthetic entry budget: two required fields and one guild choice reach useful next steps in under 30 seconds',async({page})=>{
  await page.setViewportSize({width:320,height:720});await page.goto('/');const start=Date.now();await page.getByRole('button',{name:'建立帳號',exact:true}).click();
  await expect(page.locator('.login-card input[required]')).toHaveCount(2);await expect(page.getByLabel('社群顯示名稱',{exact:true})).not.toHaveAttribute('required','');
  const email=`ux-${randomUUID().slice(0,8)}@example.test`;
  await page.getByLabel('電子郵件',{exact:true}).pressSequentially(email,{delay:100});await page.getByLabel('密碼',{exact:true}).pressSequentially('freedom-entry-2026',{delay:100});
  await page.getByRole('button',{name:'建立帳號，先逛工坊',exact:true}).click();await expect(page.locator('.welcome-optional')).not.toHaveAttribute('open','');
  await page.getByLabel('找感興趣的公會').fill('AI 開發公會');await quickJoin(page);
  await expect(page.getByRole('heading',{name:'會員首頁',level:1})).toBeVisible();
  const next=page.getByRole('region',{name:'公會與技能書建議',exact:true});
  await expect(next).toHaveCount(1);await expect(page.locator('.guild-next-steps')).toHaveCount(0);
  await expect(next.getByText('到技能書架選一本技能書閱讀，開始練習。',{exact:true})).toBeVisible();
  await expect(next.getByRole('button',{name:'閱讀第一本技能書',exact:true})).toBeVisible();
  const milliseconds=Date.now()-start;expect(milliseconds).toBeLessThan(30000);await test.info().attach('synthetic-entry-budget',{body:JSON.stringify({milliseconds,typing_delay_ms:100,email_length:email.length,password_length:'freedom-entry-2026'.length,scope:'local isolated schema; excludes human reading and thinking'}),contentType:'application/json'});
  await expect(page.locator('.home-member-name')).toContainText('新夥伴');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await expect(next.getByRole('button',{name:'進入AI 開發公會聊天室',exact:true})).toBeVisible();
  await expect(next.getByRole('button',{name:/^(查看社群任務|分享作品與需求)$/})).toBeVisible();
  await page.screenshot({path:'test-results/calm-home-320.png',fullPage:true});
  await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'test-results/calm-home-1440.png',fullPage:true});await page.setViewportSize({width:320,height:720});
  await next.getByRole('button',{name:'進入AI 開發公會聊天室',exact:true}).click();await expect(page.getByRole('heading',{name:'AI 開發公會・公會閒聊',exact:true})).toBeVisible();await expect(page.getByRole('textbox',{name:'在 AI 開發公會 發言'})).toBeVisible();
});
test('feature search finds chat and selling functions, and all themes work at 320 pixels',async({page})=>{
  await login(page);await openFeatureSearch(page);const search=page.getByLabel('搜尋功能');await search.fill('聊天室');await page.locator('.nav-search-results').getByRole('button',{name:'我的訊息',exact:true}).click();await expect(page.getByRole('heading',{name:'我的訊息',level:1})).toBeVisible();
  await openFeatureSearch(page);await search.fill('電商');await page.getByRole('navigation',{name:'主要工作區'}).getByRole('button',{name:'我可以賣東西',exact:true}).click();await expect(page.getByRole('heading',{name:'我可以賣東西',level:1})).toBeVisible();
  await navigate(page,'會員首頁');await page.setViewportSize({width:320,height:720});
  for(const [label,theme] of [['自由工坊－明亮','light'],['自由工坊－夜航','dark'],['自由工坊－敘生','versefolk']]){
    const settings=page.getByRole('button',{name:'設定',exact:true});if(await settings.getAttribute('aria-expanded')!=='true')await settings.click();await page.getByRole('menuitemradio',{name:label,exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-theme',theme);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
});
test('console reads exactly the selected guild, keeps room drafts and receives new messages without refreshing',async({page,browser,e2eAuthPool})=>{
  for(const user of DEMO_USERS.slice(0,2))for(const key of ['guild_ai_vibe','guild_marketing'])await e2eAuthPool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state) VALUES($1,$2,$3,$4,'active') ON CONFLICT(community_id,user_id,guild_key) DO UPDATE SET state='active'`,[randomUUID(),DEMO_COMMUNITY,user.user_id,key]);
  const peerContext=await browser.newContext({baseURL:new URL(test.info().project.use.baseURL as string).origin}),peer=await peerContext.newPage();
  try{
    await login(peer,DEMO_USERS[1].email);const session=await (await peer.request.get('/api/v1/session')).json();
    const send=async(key:string,body:string)=>{const result=await peer.request.post(`/api/v1/me/channels/guild/${key}/messages`,{headers:{Origin:new URL(peer.url()).origin,'X-CSRF-Token':session.csrf_token,'Idempotency-Key':randomUUID()},data:{body}});expect(result.status()).toBe(201)};
    await send('guild_ai_vibe','只屬於 AI 公會的對話');await send('guild_marketing','只屬於行銷公會的對話');
    const reads:string[]=[],checks:string[]=[];page.on('request',request=>{if(request.method()==='GET'&&/\/api\/v1\/me\/(channels\/[^/]+\/[^/]+|conversations\/[^/]+)\/messages/.test(request.url()))reads.push(request.url());if(request.url().endsWith('/activity'))checks.push(request.url())});
    await login(page);await page.getByRole('button',{name:'展開訊息控制台'}).click();const dock=page.getByRole('complementary',{name:'訊息控制台',exact:true});await expect(dock.getByRole('log')).not.toContainText('只屬於');expect(reads).toEqual([]);
    await dock.getByRole('tab',{name:/^公會聊天/}).click();await expect(dock.getByRole('button',{name:'AI 開發公會',exact:true})).toBeVisible();expect(reads).toEqual([]);
    await dock.getByRole('button',{name:'AI 開發公會',exact:true}).click();await expect(dock.getByRole('log')).toContainText('只屬於 AI 公會的對話');await expect(dock.getByRole('log')).not.toContainText('行銷公會的對話');expect(reads.every(url=>url.includes('/guild/guild_ai_vibe/messages'))).toBe(true);
    await dock.getByRole('textbox',{name:'在 AI 開發公會 發言'}).fill('AI 公會草稿');await dock.getByRole('button',{name:'切換公會',exact:true}).click();await dock.getByRole('button',{name:'成長與行銷公會',exact:true}).click();await expect(dock.getByRole('log')).toContainText('只屬於行銷公會的對話');await expect(dock.getByRole('log')).not.toContainText('AI 公會的對話');
    await dock.getByRole('textbox',{name:'在 成長與行銷公會 發言'}).fill('行銷公會草稿');await dock.getByRole('button',{name:'切換公會',exact:true}).click();await dock.getByRole('button',{name:'AI 開發公會',exact:true}).click();const draft=dock.getByRole('textbox',{name:'在 AI 開發公會 發言'});await expect(draft).toHaveValue('AI 公會草稿');await draft.press('End');await draft.press('Shift+Enter');await draft.pressSequentially('第二行');await draft.press('Enter');await expect(dock.getByRole('log')).toContainText('AI 公會草稿\n第二行');await expect(draft).toHaveValue('');
    await page.bringToFront();const idleReads=reads.length,idleChecks=checks.length;await expect.poll(()=>checks.length).toBeGreaterThanOrEqual(idleChecks+3);expect(reads.length).toBe(idleReads);
    const arrivalStart=Date.now();await send('guild_ai_vibe','在選定頻道自動出現的新訊息');await expect(dock.getByRole('log')).toContainText('在選定頻道自動出現的新訊息',{timeout:2000});
    const arrivalMs=Date.now()-arrivalStart;expect(arrivalMs).toBeLessThan(2000);await test.info().attach('guild-arrival-latency',{body:JSON.stringify({milliseconds:arrivalMs,scope:'local isolated API; receiver visible before peer POST; no focus refresh',idle_history_reads:reads.length-idleReads-1}),contentType:'application/json'});
    await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await expect(draft).toBeInViewport();await expect(dock.getByRole('button',{name:'送出',exact:true})).toBeInViewport();await dock.screenshot({path:'test-results/calm-chat-390.png'});
    await dock.getByRole('tab',{name:/^總頻道/}).click();await expect(dock.getByRole('log')).not.toContainText('只屬於');await expect(dock.getByRole('log')).not.toContainText('AI 公會草稿');
  }finally{await peerContext.close()}
});

test('private chat checks cheaply while idle, receives within two seconds, and shows pending before server acknowledgement',async({page,browser})=>{
  const origin=new URL(test.info().project.use.baseURL as string).origin,peerContext=await browser.newContext({baseURL:origin});
  let release=()=>{};
  try{
    const signIn=await peerContext.request.post('/api/v1/auth/login',{headers:{Origin:origin},data:{email:DEMO_USERS[1].email,password:'freedom-local-demo'}});expect(signIn.status()).toBe(200);const session=await signIn.json();
    const sendPeer=async(body:string)=>{const response=await peerContext.request.post(`/api/v1/me/conversations/${DEMO_USERS[0].user_id}/messages`,{headers:{Origin:origin,'X-CSRF-Token':session.csrf_token,'Idempotency-Key':randomUUID()},data:{body}});expect(response.status()).toBe(201)};
    await sendPeer('私訊起點');let historyReads=0,checks=0;
    page.on('request',request=>{if(request.method()==='GET'&&request.url().includes(`/me/conversations/${session.user.user_id}/messages?`))historyReads++;if(request.url().endsWith(`/me/conversations/${session.user.user_id}/activity`))checks++});
    await login(page);await page.goto('/#messages');await page.getByRole('tab',{name:/^私人訊息/}).click();const panel=page.getByRole('tabpanel',{name:/^私人訊息/});
    // Settle the initial auto-read and its authoritative history reconciliation
    // before measuring additional full-history reads while the chat is idle.
    const initialReadConfirmed=page.waitForResponse(async response=>response.request().method()==='GET'&&response.url().includes(`/me/conversations/${session.user.user_id}/messages?`)&&response.ok()&&(await response.json()).unread_count===0);
    await panel.locator('[aria-label="對話列表"] button').first().click();const thread=panel.locator('.messages-thread');await expect(thread.getByRole('log')).toContainText('私訊起點');await initialReadConfirmed;
    const before=historyReads;await expect.poll(()=>checks).toBeGreaterThanOrEqual(3);expect(historyReads).toBe(before);
    await page.bringToFront();const start=Date.now();await sendPeer('每秒檢查收到的新私訊');await expect(thread.getByRole('log')).toContainText('每秒檢查收到的新私訊',{timeout:2000});const arrivalMs=Date.now()-start;expect(arrivalMs).toBeLessThan(2000);
    const gate=new Promise<void>(resolve=>{release=resolve;});
    await page.route(`**/api/v1/me/conversations/${session.user.user_id}/messages`,async route=>{if(route.request().method()!=='POST')return route.continue();const result=await route.fetch();await gate;await route.fulfill({response:result});});
    const draft=thread.getByRole('textbox');await draft.fill('送出立刻出現傳送狀態');const clickStart=Date.now();await draft.press('Enter');await expect(thread.getByRole('status',{name:'傳送狀態'})).toContainText('傳送中…');const feedbackMs=Date.now()-clickStart;expect(feedbackMs).toBeLessThan(500);await expect(thread.getByRole('button',{name:'正在送出…',exact:true})).toBeDisabled();
    release();await expect(thread.getByRole('status',{name:'傳送狀態'})).toHaveCount(0);await expect(draft).toHaveValue('');await expect(thread.locator('.messages-bubbles .messages-body').filter({hasText:'送出立刻出現傳送狀態'})).toHaveCount(1);
    await test.info().attach('private-arrival-latency',{body:JSON.stringify({arrival_ms:arrivalMs,pending_feedback_ms:feedbackMs,idle_history_reads:0,scope:'local isolated API; server acknowledgement held; no focus refresh after peer POST'}),contentType:'application/json'});
  }finally{release();await peerContext.close()}
});
