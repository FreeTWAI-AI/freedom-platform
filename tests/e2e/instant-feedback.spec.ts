import {openChat,closeChat} from './navigation.js';
import {test,expect,type Page} from './fixtures.js';
import {mkdirSync} from 'node:fs';

async function login(page:Page){
  await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');
  await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');
  await page.getByRole('button',{name:'登入',exact:true}).click();
  await expect(page.getByRole('heading',{name:'會員首頁',level:1})).toBeVisible();
  await expect(page.getByRole('button',{name:'建立貼文',exact:true})).toBeVisible();
}

test('real login ACK can wait while the member gets immediate foreground feedback',async({page},info)=>{
  await page.setViewportSize({width:320,height:800});await page.goto('/');
  await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');
  await expect(page.locator('.request-feedback')).toHaveCount(0);
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/v1/auth/login',async route=>{const response=await route.fetch();await gate;await route.fulfill({response});});
  await page.evaluate(()=>{
    const state=window as typeof window&{feedbackStart:number;feedbackLatency:number|null};state.feedbackLatency=null;
    document.addEventListener('click',()=>{state.feedbackStart=performance.now();},{once:true,capture:true});
    const observer=new MutationObserver(()=>{
      const feedback=document.querySelector('.request-feedback');
      if(state.feedbackStart&&feedback?.textContent?.includes('正在處理')){observer.disconnect();requestAnimationFrame(()=>{state.feedbackLatency=performance.now()-state.feedbackStart;});}
    });observer.observe(document.body,{childList:true,subtree:true,characterData:true});
  });
  try{
    await page.getByRole('button',{name:'登入',exact:true}).click();
    await expect(page.locator('.request-feedback')).toContainText('正在處理');
    await expect(page.getByRole('button',{name:'處理中…',exact:true})).toBeDisabled();
    await expect(page.getByRole('heading',{name:'會員首頁',level:1})).toHaveCount(0);
    await expect.poll(()=>page.evaluate(()=>(window as typeof window&{feedbackLatency:number|null}).feedbackLatency)).not.toBeNull();
    const latency=await page.evaluate(()=>(window as typeof window&{feedbackLatency:number}).feedbackLatency);
    expect(latency).toBeLessThan(100);await info.attach('click-to-feedback-frame-ms',{body:JSON.stringify({sample_count:1,ms:latency,scope:'local controlled login ACK, not production p95'}),contentType:'application/json'});
    mkdirSync('test-results/ux-speed',{recursive:true});await page.screenshot({path:'test-results/ux-speed/login-pending-320.png',fullPage:true});
  }finally{release();}
  await expect(page.getByRole('heading',{name:'會員首頁',level:1})).toBeVisible();
  await expect(page.locator('.request-feedback')).toHaveCount(0);
});

test('a delayed chat chunk keeps the navigation and shows a page-specific loading state',async({page})=>{
  await login(page);let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let requested=0;
  await page.route(/\/assets\/MemberMessages-[^/]+\.js$/,async route=>{requested++;await gate;await route.continue();});
  try{
    await openChat(page);
    await expect(page.locator('.page-loading')).toContainText('正在開啟我的訊息');
    await expect(page.getByRole('navigation',{name:'主要工作區'})).toBeVisible();
    await expect.poll(()=>requested).toBe(1);
    await page.getByRole('navigation',{name:'主要工作區'}).getByRole('button',{name:'社群分享',exact:true}).click();
    await expect(page.getByRole('button',{name:'建立貼文',exact:true})).toBeVisible();
  }finally{release();}
  await openChat(page);
  await expect(page.getByRole('tab',{name:/^私人訊息/})).toBeVisible();
});

test('a failed deferred page offers recovery while the shared member shell stays usable',async({page})=>{
  await login(page);await page.route(/\/assets\/MemberMessages-[^/]+\.js$/,route=>route.abort());
  await openChat(page);
  await expect(page.getByRole('alert')).toContainText('我的訊息暫時無法開啟');
  await expect(page.getByRole('button',{name:'重新載入頁面',exact:true})).toBeVisible();
  await closeChat(page);await page.getByRole('navigation',{name:'主要工作區'}).getByRole('button',{name:'會員首頁',exact:true}).click();
  await expect(page.getByRole('button',{name:'建立貼文',exact:true})).toBeVisible();
});

test('offline feedback follows all three themes at 320px and leaves local navigation available',async({page})=>{
  await page.setViewportSize({width:320,height:800});await page.emulateMedia({reducedMotion:'reduce'});await login(page);
  await page.context().setOffline(true);
  try{
    await expect(page.locator('.request-feedback')).toContainText('目前離線');
    for(const name of ['自由工坊－明亮','自由工坊－夜航','自由工坊－敘生']){
      await page.getByRole('button',{name:'設定',exact:true}).click();await page.getByRole('menuitemradio',{name,exact:true}).click();
      await page.getByRole('button',{name:'設定',exact:true}).click();
      const feedback=page.locator('.request-feedback');await expect(feedback).toBeVisible();
      const colors=await feedback.evaluate(element=>({color:getComputedStyle(element).color,background:getComputedStyle(element).backgroundColor}));
      expect(colors.background).not.toBe('rgba(0, 0, 0, 0)');
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    }
  }finally{await page.context().setOffline(false);}
  await expect(page.locator('.request-feedback')).toHaveCount(0);
});

test('deferred floating chat panes retain the world draft across channel switches',async({page})=>{
  await login(page);await openChat(page);
  const dock=page.locator('.floating-message-panel');
  await dock.getByRole('tab',{name:/^世界聊天/}).click();
  const input=dock.getByRole('textbox',{name:'世界聊天訊息',exact:true});
  await expect(input).toBeVisible();await input.fill('這份世界頻道草稿要保留');
  await dock.getByRole('tab',{name:/^私人訊息/}).click();
  await expect(input).toBeHidden();await dock.getByRole('tab',{name:/^世界聊天/}).click();
  await expect(input).toHaveValue('這份世界頻道草稿要保留');
});
