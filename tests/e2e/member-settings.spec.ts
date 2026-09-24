import {test,expect,type Page,type Route} from './fixtures.js';

// Synthetic data only. Messages/notifications follow the root-confirmed DTO in
// the coordinator contract; they are route fixtures until the backend API lands.
const me='20000000-0000-4000-8000-000000000001',peerA='20000000-0000-4000-8000-000000000002',peerB='20000000-0000-4000-8000-000000000003';
const settingsItems=['我的名片','待辦清單','我的訊息'];

test.beforeEach(async({page})=>{
  // Nothing in these cases may leave the isolated local server.
  await page.route(url=>!['127.0.0.1','localhost'].includes(url.hostname),route=>route.abort());
  await page.route('**/api/v1/me/skill-books',route=>route.fulfill({json:{items:[]}}));
});

async function login(page:Page,hash=''){
  await page.goto('/'+hash);
  await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');
  await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.getByRole('button',{name:'登出',exact:true})).toBeVisible();
}
const settings=(page:Page)=>page.getByRole('button',{name:'設定',exact:true});
async function openPage(page:Page,name:string){
  await settings(page).click();await page.getByRole('menuitem',{name,exact:true}).click();
}
async function inbox(page:Page,notices:number|'fail',direct:number){
  await page.route(/\/api\/v1\/me\/notifications\?limit=1&offset=0$/,route=>notices==='fail'?route.fulfill({status:503,json:{}}):route.fulfill({json:{items:[],unread_count:notices,next_offset:null}}));
  await page.route(/\/api\/v1\/me\/conversations\?limit=1&offset=0$/,route=>route.fulfill({json:{items:[],unread_count:direct,next_offset:null}}));
}
async function expectExactItems(page:Page){
  await expect(page.getByRole('menuitem')).toHaveCount(3);
  for(const name of settingsItems)await expect(page.getByRole('menuitem',{name,exact:true})).toHaveCount(1);
}
async function github(page:Page,value:{configured:boolean;connected:boolean;login?:string}|'fail'){
  await page.unroute('**/api/v1/me/github');
  await page.route('**/api/v1/me/github',route=>value==='fail'?route.fulfill({status:503,json:{title:'unavailable'}}):route.fulfill({json:{configured:value.configured,connected:value.connected,github_user:value.connected?{id:'synthetic-id',login:value.login??'synthetic-login'}:null}}));
}

test('settings menu replaces the card button with an accessible keyboard menu',async({page})=>{
  // A real uploaded photo must not leak its alt text into the toggle name.
  await page.route(`**/api/v1/members/${me}`,async route=>{const response=await route.fetch();return route.fulfill({response,json:{...await response.json(),avatar_url:`/api/v1/members/${me}/avatar?v=1`}});});
  await page.route(`**/api/v1/members/${me}/avatar?v=1`,route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>'}));
  await inbox(page,2,1);
  await login(page);
  const toggle=settings(page);
  await expect(toggle).toHaveAttribute('aria-haspopup','menu');await expect(toggle).toHaveAttribute('aria-expanded','false');
  await expect(toggle.locator('img')).toBeVisible();
  await expect(page.getByRole('button',{name:'我的名片',exact:true})).toHaveCount(0);
  // Personal pages are not side-navigation entries.
  const nav=page.getByRole('navigation',{name:'主要工作區',includeHidden:true});
  for(const name of ['待辦清單','我的訊息','我的名片'])await expect(nav.getByRole('button',{name,exact:true,includeHidden:true})).toHaveCount(0);
  // The real unread total is a hidden-from-name dot; the toggle name stays exactly 設定.
  await expect(toggle).toHaveText('設定');await expect(toggle.locator('.settings-dot')).toBeVisible();

  await toggle.click();
  const menu=page.getByRole('menu',{name:'設定'});
  await expectExactItems(page);
  await expect(menu.getByRole('menuitem',{name:'我的訊息',exact:true})).toContainText('3 則未讀');
  await expect(menu.getByRole('menuitem',{name:'我的名片',exact:true})).toBeFocused();
  await page.keyboard.press('ArrowDown');await expect(menu.getByRole('menuitem',{name:'待辦清單',exact:true})).toBeFocused();
  await page.keyboard.press('End');await expect(menu.getByRole('menuitem',{name:'我的訊息',exact:true})).toBeFocused();
  await page.keyboard.press('ArrowDown');await expect(menu.getByRole('menuitem',{name:'我的名片',exact:true})).toBeFocused();
  await page.keyboard.press('ArrowUp');await expect(menu.getByRole('menuitem',{name:'我的訊息',exact:true})).toBeFocused();
  await page.keyboard.press('Home');await expect(menu.getByRole('menuitem',{name:'我的名片',exact:true})).toBeFocused();
  await page.keyboard.press('Escape');await expect(menu).toHaveCount(0);await expect(toggle).toBeFocused();await expect(toggle).toHaveAttribute('aria-expanded','false');

  // Keyboard opening from the toggle, then selecting a page moves focus into main.
  await page.keyboard.press('ArrowUp');await expect(menu.getByRole('menuitem',{name:'我的訊息',exact:true})).toBeFocused();
  await page.keyboard.press('ArrowUp');await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#todos$/);await expect(page.getByRole('heading',{level:1})).toHaveText('待辦清單');
  await expect(page.locator('#main-content')).toBeFocused();await expect(menu).toHaveCount(0);

  // Tab leaves the menu normally and closes it.
  await toggle.click();await expect(menu).toBeVisible();await page.keyboard.press('Tab');
  await expect(page.getByRole('button',{name:'登出',exact:true})).toBeFocused();await expect(menu).toHaveCount(0);

  // Outside click on blank space closes and returns focus instead of stranding it on <body>.
  await toggle.click();await page.mouse.click(5,page.viewportSize()!.height-5);
  await expect(menu).toHaveCount(0);await expect(toggle).toBeFocused();
  // Outside click on another control keeps that control's focus.
  await toggle.click();const logout=page.getByRole('button',{name:'登出',exact:true});
  await logout.dispatchEvent('pointerdown');await logout.focus();await expect(menu).toHaveCount(0);await expect(logout).toBeFocused();

  // On the card page the item names stay exact and the current page is marked.
  await openPage(page,'我的名片');await expect(page).toHaveURL(/#account$/);await expect(page.locator('#main-content')).toBeFocused();
  await toggle.click();await expectExactItems(page);
  await expect(menu.getByRole('menuitem',{name:'我的名片',exact:true})).toHaveAttribute('aria-current','page');
  await menu.getByRole('menuitem',{name:'我的訊息',exact:true}).click();
  await expect(page).toHaveURL(/#messages$/);await expect(page.getByRole('heading',{level:1})).toHaveText('我的訊息');await expect(page.locator('#main-content')).toBeFocused();
  // Browser Back while the menu is open closes it.
  await toggle.click();await expect(menu).toBeVisible();await page.goBack();await expect(page).toHaveURL(/#account$/);await expect(menu).toHaveCount(0);
});

test('an unread total that cannot be read is shown as unconfirmed, not zero',async({page})=>{
  await inbox(page,'fail',4);
  await login(page);
  const toggle=settings(page);await expect(toggle.locator('.settings-dot')).toHaveCount(0);
  await toggle.click();await expectExactItems(page);
  await expect(page.getByRole('menuitem',{name:'我的訊息',exact:true})).toContainText('未讀數未確認');
});

for(const width of [320,390])test(`settings menu and personal pages fit a ${width}px phone with 44px targets`,async({page})=>{
  await page.setViewportSize({width,height:780});
  await github(page,{configured:true,connected:false});
  await page.route(/\/api\/v1\/me\/notifications(\?.*)?$/,route=>route.fulfill({json:{items:[notice(1,{tab:'guilds',resource_id:null},{body:'很長的合成通知內容'.repeat(12)})],unread_count:1,next_offset:null}}));
  await page.route(/\/api\/v1\/me\/conversations(\?.*)?$/,route=>route.fulfill({json:{items:[],unread_count:0,next_offset:null}}));
  await login(page);
  const toggle=settings(page);
  expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await toggle.click();
  for(const item of await page.getByRole('menuitem').all()){
    const box=(await item.boundingBox())!;expect(box.height).toBeGreaterThanOrEqual(44);expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(width);
  }
  await page.getByRole('menuitem',{name:'待辦清單',exact:true}).click();
  await expect(page.getByRole('button',{name:'連結 GitHub',exact:true})).toBeVisible();
  expect((await page.getByRole('button',{name:'連結 GitHub',exact:true}).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await openPage(page,'我的訊息');await expect(page.getByRole('tab',{name:/通知/})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  for(const selector of ['.messages-meta','.messages-count','.messages-body'])expect(await page.locator(selector).first().evaluate(node=>parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(14);
  await page.screenshot({path:`/tmp/freedom-member-settings-${width}.png`,fullPage:true});
});

test('GitHub todo follows the real connection state and never completes by hand',async({page})=>{
  let reads=0,fail=true,starWrites=0;const connects:unknown[]=[];
  let state={configured:true,connected:false};
  let release:()=>void=()=>{};const held=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/v1/me/github',async route=>{reads++;if(reads===1)await held;
    return fail?route.fulfill({status:503,json:{title:'unavailable'}}):route.fulfill({json:{...state,github_user:state.connected?{id:'synthetic-id',login:'synthetic-owner'}:null}});});
  await page.route('**/api/v1/me/github/books/*/star',route=>{if(route.request().method()==='POST')starWrites++;return route.abort();});
  await page.route('**/api/v1/me/github/connect',route=>{connects.push(route.request().postDataJSON());expect(route.request().headers()['x-csrf-token']).toBeTruthy();
    return route.fulfill({json:{authorization_url:'https://github.com/login/oauth/authorize?client_id=synthetic&state=synthetic'}});});
  await page.route('https://github.com/login/oauth/authorize?*',route=>route.fulfill({contentType:'text/html',body:'<p>Synthetic authorization</p>'}));
  await page.route('**/api/v1/me/github/complete',route=>{state={configured:true,connected:true};return route.fulfill({json:{configured:true,connected:true,github_user:{id:'synthetic-id',login:'synthetic-owner'},return_to:'#todos'}});});
  await login(page,'#todos');
  const task=page.locator('[data-task="github"]');
  await expect(task.getByRole('heading',{name:'連結 GitHub'})).toBeVisible();
  await expect(task.getByRole('status')).toHaveText('讀取中');release();
  // A failed read is an error, not "not linked" and not an empty list.
  await expect(task.getByRole('status')).toHaveText('狀態讀取失敗');await expect(task.getByRole('alert')).toBeVisible();
  await expect(task.getByRole('button',{name:'連結 GitHub',exact:true})).toHaveCount(0);
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  fail=false;state={configured:false,connected:false};
  await task.getByRole('button',{name:'重新讀取 GitHub 連結',exact:true}).click();
  await expect(task.getByRole('status')).toHaveText('尚未啟用');await expect(task).toContainText('尚未啟用');
  await expect(task.getByRole('button',{name:'連結 GitHub',exact:true})).toHaveCount(0);
  state={configured:true,connected:false};
  await task.getByRole('button',{name:'重新讀取 GitHub 連結',exact:true}).click();
  await expect(task.getByRole('status')).toHaveText('待完成');
  // Visiting the page never starts OAuth by itself.
  expect(connects).toEqual([]);
  await task.getByRole('button',{name:'連結 GitHub',exact:true}).click();
  await expect(page).toHaveURL(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);expect(connects).toEqual([{return_to:'#todos'}]);
  await page.goto('/github/callback?code=synthetic&state=synthetic');await expect(page).toHaveURL(/\/#todos$/);
  await expect(page.getByRole('heading',{level:1})).toHaveText('待辦清單');
  await expect(task.getByRole('status')).toHaveText('已完成');await expect(task).toContainText('@synthetic-owner');
  expect(starWrites).toBe(0);
  await task.getByRole('button',{name:'到我的名片管理 GitHub 連結',exact:true}).click();await expect(page).toHaveURL(/#account$/);
});

type Notice={notification_id:string;kind:string;title:string;body:string;created_at:string;read_at:string|null;action:{tab:string;resource_id:string|null}|null};
function notice(n:number,action:Notice['action'],extra:Partial<Notice>={}):Notice{
  return {notification_id:`00000000-0000-4000-8000-0000000000${String(n).padStart(2,'0')}`,kind:'synthetic',title:`合成通知 ${n}`,body:`合成內容 ${n}`,created_at:`2026-09-24T0${9-n}:00:00Z`,read_at:null,action,...extra};
}

test('notifications show errors, page without dropping items, and confirm reads before navigating',async({page})=>{
  const items=[
    notice(1,{tab:'guilds',resource_id:null}),
    notice(2,{tab:'https://evil.example',resource_id:null},{body:'<img src=x onerror="window.pwned=1">純文字'}),
    notice(3,{tab:'members',resource_id:peerA},{read_at:'2026-09-24T08:00:00Z'}),
  ];
  let listFailures=1,pageTwoFailures=1,readFailures=1,listReads=0;const readKeys:string[]=[];
  await page.route(/\/api\/v1\/me\/notifications(\?.*)?$/,route=>{
    listReads++;
    const url=new URL(route.request().url()),offset=Number(url.searchParams.get('offset')),limit=Number(url.searchParams.get('limit'));
    if(offset===0&&limit>1&&listFailures-->0)return route.fulfill({status:500,json:{title:'boom'}});
    if(offset===2&&pageTwoFailures-->0)return route.abort();
    const slice=offset===0?items.slice(0,Math.min(2,limit)):items.slice(2);
    return route.fulfill({json:{items:slice,unread_count:items.filter(item=>!item.read_at).length,next_offset:offset===0&&limit>1?2:null}});
  });
  await page.route(/\/api\/v1\/me\/notifications\/[^/]+\/read$/,route=>{
    expect(route.request().method()).toBe('POST');expect(route.request().headers()['x-csrf-token']).toBeTruthy();
    readKeys.push(route.request().headers()['idempotency-key']);
    if(readFailures-->0)return route.abort();
    const id=route.request().url().split('/').at(-2)!,item=items.find(value=>value.notification_id===id)!;item.read_at='2026-09-24T10:00:00Z';
    return route.fulfill({json:{notification_id:id,read_at:item.read_at}});
  });
  await page.route(/\/api\/v1\/me\/conversations(\?.*)?$/,route=>route.fulfill({json:{items:[],unread_count:0,next_offset:null}}));
  await login(page,'#messages');
  const panel=page.getByRole('tabpanel',{name:/通知/});
  await expect(panel.getByRole('alert')).toContainText('通知讀取失敗');await expect(panel.getByText('目前沒有通知。')).toHaveCount(0);
  await panel.getByRole('button',{name:'重新讀取通知',exact:true}).click();
  await expect(panel.getByRole('heading',{level:3})).toHaveText(['合成通知 1','合成通知 2']);
  await expect(page.getByRole('tab',{name:/通知/})).toContainText('2 則未讀');
  // Reading the list is not reading the items.
  expect(readKeys).toEqual([]);
  // Unknown action tabs never become links; HTML in the body stays text.
  const second=panel.locator('li',{hasText:'合成通知 2'});
  await expect(second.getByRole('link')).toHaveCount(0);await expect(second.getByRole('button',{name:/前往|開啟/})).toHaveCount(0);
  await expect(second.locator('.messages-body')).toHaveText('<img src=x onerror="window.pwned=1">純文字');await expect(second.locator('img')).toHaveCount(0);
  // Load more: a failure keeps the loaded items and offers retry.
  await panel.getByRole('button',{name:'載入更多通知',exact:true}).click();
  await expect(panel.getByRole('alert')).toContainText('更多通知讀取失敗');await expect(panel.getByRole('heading',{level:3})).toHaveCount(2);
  await panel.getByRole('button',{name:'重試載入更多通知',exact:true}).click();
  await expect(panel.getByRole('heading',{level:3})).toHaveText(['合成通知 1','合成通知 2','合成通知 3']);
  await expect(panel.getByRole('button',{name:/載入更多通知/})).toHaveCount(0);
  // Mark read: an unconfirmed failure retries with the same key; the state changes only after the server confirms.
  const second2=panel.locator('li',{hasText:'合成通知 2'});
  await second2.getByRole('button',{name:'標為已讀',exact:true}).click();
  await expect(second2.getByRole('alert')).toContainText('標為已讀未完成');await expect(second2).toContainText('未讀');
  await second2.getByRole('button',{name:'重試標為已讀',exact:true}).click();
  await expect(second2.locator('.messages-meta')).toContainText('已讀');await expect(second2.getByRole('button',{name:'標為已讀',exact:true})).toHaveCount(0);
  expect(readKeys.length).toBe(2);expect(readKeys[0]).toBe(readKeys[1]);
  await expect(page.getByRole('tab',{name:/通知/})).toContainText('1 則未讀');
  // The settings menu re-reads the confirmed total after the read.
  await settings(page).click();await expect(page.getByRole('menuitem',{name:'我的訊息',exact:true})).toContainText('1 則未讀');await page.keyboard.press('Escape');
  // An action button reads first, then goes to the fixed in-app page.
  const readsBefore=listReads;
  await panel.locator('li',{hasText:'合成通知 1'}).getByRole('button',{name:'前往職業公會',exact:true}).click();
  await expect(page).toHaveURL(/#guilds$/);expect(readKeys.length).toBe(3);expect(listReads).toBeGreaterThan(readsBefore);
  expect(await page.evaluate(()=>(window as unknown as {pwned?:number}).pwned)).toBeUndefined();
});

test('a failed read before navigating can be retried or skipped explicitly',async({page})=>{
  const items=[notice(1,{tab:'squads',resource_id:'00000000-0000-4000-8000-00000000aaaa'})];
  await page.route(/\/api\/v1\/me\/notifications(\?.*)?$/,route=>route.fulfill({json:{items,unread_count:1,next_offset:null}}));
  await page.route(/\/api\/v1\/me\/notifications\/[^/]+\/read$/,route=>route.fulfill({status:422,json:{title:'無法標記',detail:'合成錯誤'}}));
  await page.route(/\/api\/v1\/me\/conversations(\?.*)?$/,route=>route.fulfill({json:{items:[],unread_count:0,next_offset:null}}));
  await login(page,'#messages');
  const item=page.locator('li',{hasText:'合成通知 1'});
  await item.getByRole('button',{name:'前往小隊集合',exact:true}).click();
  await expect(item.getByRole('alert')).toContainText('合成錯誤');await expect(page).toHaveURL(/#messages$/);
  await item.getByRole('button',{name:'不標已讀，直接前往小隊集合',exact:true}).click();await expect(page).toHaveURL(/#squads$/);
});

test('a late read after leaving the page never navigates, and a failed count refresh is unconfirmed',async({page})=>{
  const items=[notice(1,{tab:'squads',resource_id:null}),notice(2,{tab:'members',resource_id:peerA})];
  let release:()=>void=()=>{};const held=new Promise<void>(resolve=>{release=resolve;});let countFails=false;
  await page.route(/\/api\/v1\/me\/notifications(\?.*)?$/,route=>{
    if(countFails&&route.request().url().includes('limit=1&'))return route.fulfill({status:503,json:{}});
    return route.fulfill({json:{items,unread_count:items.filter(item=>!item.read_at).length,next_offset:null}});
  });
  await page.route(/\/api\/v1\/me\/notifications\/[^/]+\/read$/,async route=>{
    const id=route.request().url().split('/').at(-2)!;if(id===items[0].notification_id)await held;
    const item=items.find(value=>value.notification_id===id)!;item.read_at='2026-09-24T10:00:00Z';return route.fulfill({json:{notification_id:id,read_at:item.read_at}});
  });
  await page.route(/\/api\/v1\/me\/conversations(\?.*)?$/,route=>route.fulfill({json:{items:[],unread_count:0,next_offset:null}}));
  await login(page,'#messages');
  await page.locator('li',{hasText:'合成通知 1'}).getByRole('button',{name:'前往小隊集合',exact:true}).click();
  await openPage(page,'待辦清單');await expect(page).toHaveURL(/#todos$/);
  release();await page.waitForTimeout(300);
  await expect(page).toHaveURL(/#todos$/);await expect(page.getByRole('heading',{level:1})).toHaveText('待辦清單');
  await openPage(page,'我的訊息');
  countFails=true;
  const second=page.locator('li',{hasText:'合成通知 2'});await second.getByRole('button',{name:'標為已讀',exact:true}).click();
  await expect(second.getByRole('button',{name:'標為已讀',exact:true})).toHaveCount(0);
  await expect(page.getByRole('tab',{name:/通知/})).toContainText('未讀數未確認');
});

type Message={message_id:string;sender_ref:string;recipient_ref:string;body:string;created_at:string;read_at:string|null};
const participants:Record<string,{user_id:string;display_name:string;avatar_url:null}>={
  [peerA]:{user_id:peerA,display_name:'合成夥伴甲',avatar_url:null},[peerB]:{user_id:peerB,display_name:'合成夥伴乙',avatar_url:null},
};
function thread(peer:string,count:number):Message[]{
  // Newest first, as the backend returns it.
  return Array.from({length:count},(_,i)=>{const n=count-i;const theirs=n%2===1;
    return {message_id:`${peer.slice(-4)}-m${n}`,sender_ref:theirs?peer:me,recipient_ref:theirs?me:peer,body:`${participants[peer].display_name} 訊息 ${n}`,created_at:`2026-09-24T0${Math.min(n,9)}:00:00Z`,read_at:theirs&&n>=count-3?null:'2026-09-24T09:30:00Z'};});
}

async function direct(page:Page,options:{delayA?:Promise<void>;outcomes?:('abort'|'500'|'ok')[]}={}){
  const store:Record<string,Message[]>={[peerA]:thread(peerA,25),[peerB]:[]};
  const sends:{peer:string;key:string;body:string}[]=[],reads:string[]=[],outcomes=[...options.outcomes??[]];
  const unread=(peer:string)=>store[peer].filter(item=>item.sender_ref===peer&&!item.read_at).length;
  await page.route(/\/api\/v1\/me\/notifications(\?.*)?$/,route=>route.fulfill({json:{items:[],unread_count:0,next_offset:null}}));
  await page.route(/\/api\/v1\/me\/conversations(\/.*)?(\?.*)?$/,async(route:Route)=>{
    const request=route.request(),url=new URL(request.url()),parts=url.pathname.split('/').slice(4);// ['conversations',peer?,sub?]
    const limit=Number(url.searchParams.get('limit')??20),offset=Number(url.searchParams.get('offset')??0);
    if(parts.length===1){
      const items=Object.keys(store).filter(peer=>store[peer].length).map(peer=>({participant:participants[peer],can_send:true,last_message:store[peer][0],unread_count:unread(peer)}));
      return route.fulfill({json:{items,unread_count:Object.keys(store).reduce((sum,peer)=>sum+unread(peer),0),next_offset:null}});
    }
    const peer=parts[1];
    if(parts[2]==='messages'&&request.method()==='GET'){
      if(peer===peerA&&options.delayA)await options.delayA;
      const items=store[peer].slice(offset,offset+limit);
      return route.fulfill({json:{participant:participants[peer],can_send:true,items,next_offset:offset+limit<store[peer].length?offset+limit:null,unread_count:unread(peer)}});
    }
    if(parts[2]==='messages'&&request.method()==='POST'){
      const body=request.postDataJSON().body as string;sends.push({peer,key:request.headers()['idempotency-key'],body});
      const outcome=outcomes.shift()??'ok';
      if(outcome==='abort')return route.abort();
      const existing=store[peer].find(item=>item.message_id===`sent-${request.headers()['idempotency-key']}`);
      const message=existing??{message_id:`sent-${request.headers()['idempotency-key']}`,sender_ref:me,recipient_ref:peer,body,created_at:'2026-09-24T10:00:00Z',read_at:null};
      if(!existing)store[peer].unshift(message);
      // '500' commits the message but loses the response, like a proxy failure after the write.
      if(outcome==='500')return route.fulfill({status:500,json:{}});
      return route.fulfill({status:201,json:message});
    }
    if(parts[2]==='read'){
      reads.push(request.headers()['idempotency-key']);let updated=0;
      for(const item of store[peer])if(item.sender_ref===peer&&!item.read_at){item.read_at='2026-09-24T10:05:00Z';updated++;}
      return route.fulfill({json:{user_id:peer,read_at:'2026-09-24T10:05:00Z',updated_count:updated}});
    }
    return route.fulfill({status:404,json:{}});
  });
  return {store,sends,reads};
}

test('direct messages page, send with an unknown result once, and mark read only on request',async({page})=>{
  const {sends,reads}=await direct(page,{outcomes:['abort','ok','500','ok']});
  await login(page,'#messages');
  await page.getByRole('tab',{name:/私訊/}).click();
  await expect(page.getByRole('tab',{name:/私訊/})).toContainText('2 則未讀');
  const panel=page.getByRole('tabpanel',{name:/私訊/});
  await panel.getByRole('button',{name:/合成夥伴甲/}).click();
  const threadRegion=panel.locator('.messages-thread');
  await expect(threadRegion.getByRole('heading',{name:'與 合成夥伴甲 的對話'})).toBeFocused();
  // Oldest of the loaded page first; the backend's newest-first page is reversed only for display.
  const bubbles=threadRegion.locator('.messages-bubbles .messages-body');
  await expect(bubbles).toHaveCount(20);await expect(bubbles.first()).toHaveText('合成夥伴甲 訊息 6');await expect(bubbles.last()).toHaveText('合成夥伴甲 訊息 25');
  await threadRegion.getByRole('button',{name:'載入較早訊息',exact:true}).click();
  await expect(bubbles).toHaveCount(25);await expect(bubbles.first()).toHaveText('合成夥伴甲 訊息 1');
  await expect(threadRegion.getByRole('button',{name:'載入較早訊息',exact:true})).toHaveCount(0);
  // Opening the conversation did not mark anything read.
  expect(reads).toEqual([]);
  await threadRegion.getByRole('button',{name:'標為已讀',exact:true}).click();
  await expect(threadRegion.getByRole('button',{name:'標為已讀',exact:true})).toHaveCount(0);
  await expect(page.getByRole('tab',{name:/私訊/})).toContainText('沒有未讀');expect(reads.length).toBe(1);

  const box=threadRegion.getByLabel('寫給 合成夥伴甲 的訊息');
  await box.fill('  <b>純文字</b> 你好  ');
  await threadRegion.getByRole('button',{name:'送出',exact:true}).click();
  await expect(threadRegion.getByRole('alert')).toContainText('傳送結果未確認');
  await expect(box).toHaveValue('  <b>純文字</b> 你好  ');
  // Re-reading the conversation keeps the unconfirmed attempt, so the retry still deduplicates.
  await threadRegion.getByRole('button',{name:'重新讀取對話',exact:true}).click();
  await expect(box).toHaveValue('  <b>純文字</b> 你好  ');
  await threadRegion.getByRole('button',{name:'重試送出',exact:true}).click();
  await expect(bubbles.last()).toHaveText('<b>純文字</b> 你好');await expect(threadRegion.locator('.messages-bubbles b')).toHaveCount(0);
  await expect(box).toHaveValue('');
  expect(sends.length).toBe(2);expect(sends[1]).toEqual(sends[0]);expect(sends[0].body).toBe('<b>純文字</b> 你好');
  await expect(threadRegion.getByText('<b>純文字</b> 你好',{exact:true})).toHaveCount(1);
  // A committed write with a lost (500) response: same text retries once; nothing is duplicated.
  await box.fill('第二則');await threadRegion.getByRole('button',{name:'送出',exact:true}).click();
  await expect(threadRegion.getByRole('alert')).toContainText('傳送結果未確認');
  await threadRegion.getByRole('button',{name:'重試送出',exact:true}).click();await expect(box).toHaveValue('');
  expect(sends[3].key).toBe(sends[2].key);await expect(threadRegion.getByText('第二則',{exact:true})).toHaveCount(1);
});

test('changing an unconfirmed message makes it a new message with a new key',async({page})=>{
  const {sends}=await direct(page,{outcomes:['abort','ok']});
  await login(page,'#messages');await page.getByRole('tab',{name:/私訊/}).click();
  const panel=page.getByRole('tabpanel',{name:/私訊/}),threadRegion=panel.locator('.messages-thread');
  await panel.getByRole('button',{name:/合成夥伴甲/}).click();
  const box=threadRegion.getByLabel('寫給 合成夥伴甲 的訊息');await box.fill('原稿');
  await threadRegion.getByRole('button',{name:'送出',exact:true}).click();await expect(threadRegion.getByRole('alert')).toContainText('傳送結果未確認');
  await box.fill('改稿');await threadRegion.getByRole('button',{name:'送出',exact:true}).click();await expect(box).toHaveValue('');
  expect(sends.map(item=>item.body)).toEqual(['原稿','改稿']);expect(sends[1].key).not.toBe(sends[0].key);
});

test('switching conversations ignores late responses and keeps a draft per recipient',async({page})=>{
  let release:()=>void=()=>{};const delayA=new Promise<void>(resolve=>{release=resolve;});
  const {sends}=await direct(page,{delayA});
  await login(page,'#messages');
  await page.getByRole('tab',{name:/私訊/}).click();
  const panel=page.getByRole('tabpanel',{name:/私訊/}),threadRegion=panel.locator('.messages-thread');
  await panel.getByRole('button',{name:/合成夥伴甲/}).click();
  await expect(threadRegion.getByRole('status')).toHaveText('正在讀取訊息…');
  // Start a new conversation from the real member directory while A is still loading.
  await panel.getByLabel('搜尋會員').fill('示範');await panel.getByRole('button',{name:'搜尋會員',exact:true}).click();
  const results=panel.getByRole('list',{name:'會員搜尋結果'});
  await expect(results.getByRole('button',{name:/示範合作方/})).toBeVisible();
  await expect(results.getByRole('button',{name:/示範創作者/})).toHaveCount(0);
  await results.getByRole('button',{name:/示範合作方/}).click();
  // B has no history yet; the backend still returns its participant and an empty page.
  await expect(threadRegion.getByRole('heading',{level:2})).toHaveText('與 合成夥伴乙 的對話');
  release();
  await page.waitForTimeout(300);
  await expect(threadRegion.getByRole('heading',{level:2})).toHaveText('與 合成夥伴乙 的對話');
  await expect(threadRegion.getByText(/合成夥伴甲 訊息/)).toHaveCount(0);await expect(threadRegion.getByText('還沒有訊息。')).toBeVisible();
  await threadRegion.getByLabel('寫給 合成夥伴乙 的訊息').fill('給乙的草稿');
  await panel.getByRole('button',{name:/合成夥伴甲/}).click();
  const boxA=threadRegion.getByLabel('寫給 合成夥伴甲 的訊息');await expect(boxA).toHaveValue('');await boxA.fill('給甲的草稿');
  // Drafts also survive a trip to the notifications tab.
  await page.getByRole('tab',{name:/通知/}).click();await page.getByRole('tab',{name:/私訊/}).click();await expect(boxA).toHaveValue('給甲的草稿');
  await results.getByRole('button',{name:/示範合作方/}).click();
  await expect(threadRegion.getByLabel('寫給 合成夥伴乙 的訊息')).toHaveValue('給乙的草稿');
  expect(sends).toEqual([]);
});
