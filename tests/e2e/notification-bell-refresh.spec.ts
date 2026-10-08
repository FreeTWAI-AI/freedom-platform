import {test,expect,type Page,type Route} from './fixtures.js';
import {navigate,signOut} from './navigation.js';

const preview='**/api/v1/me/notifications?limit=6&offset=0';
const notice={notification_id:'synthetic-notice',title:'測試通知',body:'只有目前登入會員可見的合成提醒',created_at:'2026-01-01T00:00:00Z',read_at:null as string|null,action:null};
const payload=(read=false)=>({items:[{...notice,read_at:read?'2026-01-02T00:00:00Z':null}],unread_count:read?0:1});
async function login(page:Page,email='maker@local.test',navigate=true){
  if(navigate)await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill(email);
  await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');
  await page.getByRole('button',{name:'登入',exact:true}).click();
  await expect(page.getByRole('heading',{name:'會員首頁',exact:true})).toBeVisible();
}
const frameBarrier=(page:Page)=>page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));

test('bell overlap uses one transport and collapse makes no additional request',async({page},info)=>{
  let requests=0,completed=0,hold=false;
  const waiting:Route[]=[];
  await page.route(preview,async route=>{requests++;if(hold){waiting.push(route);return;}await route.fulfill({json:payload()});completed++;});
  await login(page);const bell=page.locator('.notification-bell-trigger');
  await expect(bell).toHaveAccessibleName('通知，1 則未讀');
  const initial=requests;hold=true;
  const updated=page.waitForResponse(value=>value.url().endsWith('/me/notifications?limit=6&offset=0'));
  try{
    await bell.click();await expect(page.getByRole('region',{name:'最近通知'})).toBeVisible();
    await expect.poll(()=>waiting.length).toBeGreaterThanOrEqual(1);
    await bell.click();await expect(page.getByRole('region',{name:'最近通知'})).toBeHidden();
    await page.evaluate(()=>{window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('freedom-inbox-updated'));});
    await frameBarrier(page);
    const measured={initial,overlap_requests:requests-initial,collapsed:true,completed_before_release:completed};
    await info.attach('notification-overlap-count',{body:JSON.stringify(measured),contentType:'application/json'});
    expect(measured.overlap_requests).toBe(1);
  }finally{hold=false;for(const route of waiting)await route.fulfill({json:payload()});await (await updated).finished();await frameBarrier(page);}
  // A settled response is never a freshness cache: the next opening re-reads.
  const settled=requests;await bell.click();await expect.poll(()=>requests).toBe(settled+1);
  await expect(page.locator('.notification-bell-item')).toContainText(notice.body);
  await page.getByRole('heading',{name:'會員首頁',exact:true}).click();
  await expect(page.getByRole('region',{name:'最近通知'})).toBeHidden();
});

test('confirmed single read refreshes once without automatically resending the write',async({page},info)=>{
  let reads=0,writes=0,read=false;
  await page.route(preview,async route=>{reads++;await route.fulfill({json:payload(read)});});
  await page.route('**/api/v1/me/notifications/synthetic-notice/read',async route=>{writes++;read=true;await route.fulfill({json:{read_at:'2026-01-02T00:00:00Z'}});});
  await login(page);await page.locator('.notification-bell-trigger').click();
  await expect(page.locator('.notification-bell-item.is-unread')).toHaveCount(1);
  const before=reads;const response=page.waitForResponse(value=>value.url().endsWith('/me/notifications?limit=6&offset=0'));
  await page.locator('.notification-bell-item').click();await response;await frameBarrier(page);
  await expect(page.locator('.notification-bell-item.is-unread')).toHaveCount(0);
  await info.attach('notification-read-count',{body:JSON.stringify({refreshes:reads-before,writes,controlled_ack:true}),contentType:'application/json'});
  expect(reads-before).toBe(1);expect(writes).toBe(1);
});

test('a slow preview shows immediate local feedback, closes by Escape and recovers after failure',async({page},info)=>{
  await page.setViewportSize({width:320,height:800});await page.emulateMedia({reducedMotion:'reduce'});
  let next='ok',held:Route|undefined;
  await page.route(preview,async route=>{if(next==='hold'){held=route;return;}await route.fulfill(next==='fail'?{status:503,json:{code:'upstream_unavailable'}}:{json:payload()});});
  await login(page);const bell=page.locator('.notification-bell-trigger');
  await expect(bell).toHaveAccessibleName('通知，1 則未讀');next='hold';
  await page.evaluate(()=>{
    const state=window as typeof window&{noticeStart:number;noticeLatency:number|null};state.noticeLatency=null;
    document.querySelector('.notification-bell-trigger')!.addEventListener('click',()=>{state.noticeStart=performance.now();},{once:true,capture:true});
    const observer=new MutationObserver(()=>{if(document.querySelector('.notification-bell-popover [role="status"]')){observer.disconnect();requestAnimationFrame(()=>{state.noticeLatency=performance.now()-state.noticeStart;});}});
    observer.observe(document.body,{subtree:true,childList:true,characterData:true});
  });
  try{
    await bell.click();const panel=page.getByRole('region',{name:'最近通知'});
    await expect(panel.getByRole('status')).toHaveText('正在更新通知…');await expect.poll(()=>held!==undefined).toBe(true);
    await expect.poll(()=>page.evaluate(()=>(window as typeof window&{noticeLatency:number|null}).noticeLatency)).not.toBeNull();
    const latency=await page.evaluate(()=>(window as typeof window&{noticeLatency:number}).noticeLatency);
    await info.attach('notice-click-to-feedback-frame-ms',{body:JSON.stringify({sample_count:1,ms:latency,scope:'controlled local preview, not production p95'}),contentType:'application/json'});
    expect(latency).toBeLessThan(100);await expect(page.locator('.request-feedback')).toHaveCount(0);
    await page.screenshot({path:'test-results/notification-loading-320.png'});
    await page.keyboard.press('Escape');await expect(panel).toBeHidden();await expect(bell).toBeFocused();
  }finally{if(held)await held.fulfill({json:payload()});}
  next='fail';await bell.click();const panel=page.getByRole('region',{name:'最近通知'});
  await expect(panel.getByRole('alert')).toContainText('通知暫時無法載入');await expect(bell).toHaveAccessibleName('通知，未讀數未確認');
  const retry=panel.getByRole('button',{name:'再試一次',exact:true});await expect(retry).toBeVisible();
  const box=await retry.boundingBox();expect(box!.width).toBeGreaterThanOrEqual(44);expect(box!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({path:'test-results/notification-error-320.png'});next='ok';await retry.click();
  await expect(panel.getByRole('alert')).toHaveCount(0);await expect(bell).toHaveAccessibleName('通知，1 則未讀');
  await expect(panel.locator('.notification-bell-item')).toContainText(notice.body);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('a same-login bulk-read acknowledgement refreshes the bell after leaving Messages',async({page})=>{
  let held:Route|undefined,read=false,previewReads=0;
  await page.route(preview,async route=>{previewReads++;await route.fulfill({json:payload(read)});});
  await page.route('**/api/v1/me/inbox/read-all',route=>{held=route;});
  await login(page);
  const bell=page.locator('.notification-bell-trigger');
  await expect(bell).toHaveAccessibleName('通知，1 則未讀');
  await navigate(page,'我的訊息');
  const messages=page.locator('.member-messages');
  await messages.getByRole('tab',{name:/^通知/}).click();
  await messages.getByRole('button',{name:'全部標為已讀',exact:true}).click();
  await expect.poll(()=>held!==undefined).toBe(true);
  await navigate(page,'會員首頁');await expect(messages).toHaveCount(0);
  await page.evaluate(()=>{
    const state=window as typeof window&{noticeEvents:number;allReadEvents:number};
    state.noticeEvents=0;state.allReadEvents=0;
    window.addEventListener('freedom-inbox-updated',()=>state.noticeEvents++);
    window.addEventListener('freedom-inbox-all-read',()=>state.allReadEvents++);
  });
  const before=previewReads,currentUrl=page.url();
  const acknowledgement=page.waitForResponse(response=>response.url().endsWith('/me/inbox/read-all'));
  try{
    read=true;await held!.fulfill({json:{read_at:'2026-01-02T00:00:00Z'}});
    await (await acknowledgement).finished();await frameBarrier(page);
    await expect(bell).toHaveAccessibleName('通知');
    expect(previewReads-before).toBe(1);
    expect(await page.evaluate(()=>{
      const state=window as typeof window&{noticeEvents:number;allReadEvents:number};
      return {updated:state.noticeEvents,allRead:state.allReadEvents};
    })).toEqual({updated:1,allRead:1});
    await expect(page).toHaveURL(currentUrl);
  }finally{if(held)await held.fulfill({json:{read_at:'2026-01-02T00:00:00Z'}}).catch(()=>{});}
});

for(const mode of ['single','all'] as const)test(`an old account ${mode} read acknowledgement cannot navigate or refresh the new login`,async({page})=>{
  let readRequest:Route|undefined,inboxEvents=0,previewReads=0;
  const readPath=mode==='single'?'/me/notifications/synthetic-notice/read':'/me/inbox/read-all';
  await page.route(preview,async route=>{previewReads++;await route.fulfill({json:payload()});});
  await page.route('**/api/v1'+readPath,route=>{readRequest=route;});
  await login(page);await page.locator('.notification-bell-trigger').click();
  if(mode==='single')await page.locator('.notification-bell-item').click();else await page.getByRole('button',{name:'全部標為已讀',exact:true}).click();
  await expect.poll(()=>readRequest!==undefined).toBe(true);
  await signOut(page);await expect(page.getByRole('heading',{name:'登入',exact:true})).toBeVisible();
  await login(page,'reviewer@local.test',false);await expect(page.locator('.notification-bell-trigger')).toHaveAccessibleName('通知，1 則未讀');
  await page.evaluate(()=>{(window as typeof window&{noticeEvents:number}).noticeEvents=0;window.addEventListener('freedom-inbox-updated',()=>{(window as typeof window&{noticeEvents:number}).noticeEvents++;});});
  const before=previewReads,currentUrl=page.url();
  const acknowledgement=page.waitForResponse(response=>response.url().endsWith(readPath));
  try{await readRequest!.fulfill({json:{read_at:'2026-01-02T00:00:00Z'}});await (await acknowledgement).finished();await frameBarrier(page);
    inboxEvents=await page.evaluate(()=>(window as typeof window&{noticeEvents:number}).noticeEvents);
    expect(inboxEvents).toBe(0);expect(previewReads).toBe(before);
    await expect(page).toHaveURL(currentUrl);await expect(page.getByRole('heading',{name:'會員首頁',exact:true})).toBeVisible();
  }finally{if(readRequest)await readRequest.fulfill({json:{read_at:'2026-01-02T00:00:00Z'}}).catch(()=>{});}
});

for(const [id,recent,title,loading] of [['zh-Hant','最近通知','通知','正在更新通知…'],['en','Recent notifications','Notifications','Updating notifications…'],['ja','最近の通知','通知','通知を更新中…'],['ko','최근 알림','알림','알림 업데이트 중…'],['es','Notificaciones recientes','Notificaciones','Actualizando notificaciones…']] as const){
  test(`notification chrome follows ${id} without translating member content or refetching for language only`,async({page})=>{
    let reads=0,hold=false;const waiting:Route[]=[];
    await page.route(preview,async route=>{reads++;if(hold){waiting.push(route);return;}await route.fulfill({json:payload()});});
    await login(page);await expect(page.locator('.notification-bell-trigger')).toHaveAccessibleName('通知，1 則未讀');
    const before=reads;await page.evaluate(value=>{localStorage.setItem('freedom-interface-language-v1',value);window.dispatchEvent(new StorageEvent('storage',{key:'freedom-interface-language-v1',newValue:value}));},id);
    await expect(page.locator('html')).toHaveAttribute('lang',id);await frameBarrier(page);expect(reads).toBe(before);
    hold=true;
    try{await page.locator('.notification-bell-trigger').click();const panel=page.getByRole('region',{name:recent});await expect(panel.locator('.notification-bell-head strong')).toHaveText(title);await expect(panel.getByRole('status')).toHaveText(loading);await expect(panel.locator('.notification-bell-item')).toContainText(notice.body);await expect.poll(()=>waiting.length).toBe(1);
      for(const width of [320,390,820,1280]){await page.setViewportSize({width,height:width<500?800:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);const box=await panel.boundingBox();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(width);}
      await page.setViewportSize({width:320,height:800});await page.screenshot({path:`test-results/notification-${id}-320.png`});
    }
    finally{hold=false;for(const route of waiting)await route.fulfill({json:payload()});}
  });
}
