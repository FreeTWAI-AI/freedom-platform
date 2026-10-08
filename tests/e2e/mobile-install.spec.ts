import {test,expect,type Page} from './fixtures.js';
import {navigate} from './navigation.js';

async function login(page:Page){
  await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');
  await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.getByRole('heading',{name:'會員首頁',level:1,exact:true})).toBeVisible();
}

test('real manifest and square brand icons have stable public launch URLs and no registered offline worker',async({page,context},info)=>{
  await page.goto('/#reset-password/'+ 'a'.repeat(43));
  const manifest=await page.request.get('/manifest.webmanifest');expect(manifest.status()).toBe(200);expect(manifest.headers()['content-type']).toContain('application/manifest+json');
  const data=await manifest.json();expect(data.id).toBe('/');expect(data.start_url).toBe('/');expect(data.scope).toBe('/');expect(data.display).toBe('standalone');
  expect(data.icons.map((icon:{sizes:string})=>icon.sizes)).toEqual(['192x192','512x512']);
  for(const icon of [...data.icons,{src:'/brand/app-icon-180.png',sizes:'180x180'}]){
    const image=await page.request.get(icon.src);expect(image.status()).toBe(200);expect(image.headers()['content-type']).toContain('image/png');
    const png=await image.body(),size=Number(icon.sizes.split('x')[0]);expect(png.subarray(1,4).toString()).toBe('PNG');expect(png.readUInt32BE(16)).toBe(size);expect(png.readUInt32BE(20)).toBe(size);
  }
  const cdp=await context.newCDPSession(page),native=await cdp.send('Page.getAppManifest'),installability=await cdp.send('Page.getInstallabilityErrors');
  expect(native.errors).toEqual([]);if(!native.data)throw Error('Chromium did not load the app manifest');expect(JSON.parse(native.data).start_url).toBe('/');
  await info.attach('chromium-installability',{body:JSON.stringify(installability),contentType:'application/json'});
  expect(installability.installabilityErrors).toEqual([]);
  expect(await page.evaluate(async()=>({workers:(await navigator.serviceWorker.getRegistrations()).length,caches:await caches.keys()}))).toEqual({workers:0,caches:[]});
});

test('five-language iPhone installation guidance fits 320px and preserves account inputs and keyboard focus',async({browser})=>{
  const context=await browser.newContext({viewport:{width:320,height:844},userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1'});
  try{
    const page=await context.newPage();await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill('pwa-draft@example.test');await page.getByLabel('密碼',{exact:true}).fill('pwa-password-draft');
    for(const [language,title] of [['zh-Hant','加入主畫面'],['en','Add to home screen'],['ja','ホーム画面に追加'],['ko','홈 화면에 추가'],['es','Añadir a la pantalla de inicio']]){
      await page.getByRole('combobox',{name:'Language',exact:true}).selectOption(language);
      const button=page.locator('.app-install-trigger');await expect(button).toContainText(title);expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await button.click();const dialog=page.getByRole('dialog',{name:title,exact:true});await expect(dialog).toBeVisible();await expect(dialog.locator('ol')).toContainText('Safari');
      expect(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.screenshot({path:`test-results/mobile-install-${language}-320.png`});await page.keyboard.press('Escape');await expect(dialog).toBeHidden();await expect(button).toBeFocused();
      await expect(page.locator('.login-card input[name=email]')).toHaveValue('pwa-draft@example.test');await expect(page.locator('.login-card input[name=password]')).toHaveValue('pwa-password-draft');
    }
  }finally{await context.close();}
});

test('simulated native prompt needs a click, consumes each event once and never treats browser acceptance as installed',async({page})=>{
  await page.goto('/');await expect(page.locator('.app-install-trigger')).toBeVisible();
  for(const outcome of ['accepted','dismissed','throw'] as const){
    await page.evaluate(outcome=>{
      const state=window as typeof window&{installPromptCalls?:number};state.installPromptCalls=0;
      const event=new Event('beforeinstallprompt',{cancelable:true});
      Object.assign(event,{prompt:async()=>{state.installPromptCalls!++;if(outcome==='throw')throw Error('synthetic browser refusal');},userChoice:Promise.resolve({outcome:outcome==='accepted'?'accepted':'dismissed'})});window.dispatchEvent(event);
    },outcome);
    expect(await page.evaluate(()=>(window as typeof window&{installPromptCalls:number}).installPromptCalls)).toBe(0);
    await page.locator('.app-install-trigger').click();const dialog=page.getByRole('dialog',{name:'加入主畫面',exact:true}),install=dialog.getByRole('button',{name:'安裝自由工坊',exact:true});
    await expect(install).toBeVisible();await install.click();await expect.poll(()=>page.evaluate(()=>(window as typeof window&{installPromptCalls:number}).installPromptCalls)).toBe(1);
    await expect(dialog.getByRole('status')).toContainText(outcome==='accepted'?'請依系統提示完成安裝':outcome==='dismissed'?'已取消安裝':'安裝視窗無法開啟');
    await expect(page.locator('.app-install-trigger')).toBeVisible();await page.keyboard.press('Escape');await page.locator('.app-install-trigger').click();await expect(install).toHaveCount(0);
    expect(await page.evaluate(()=>(window as typeof window&{installPromptCalls:number}).installPromptCalls)).toBe(1);await page.keyboard.press('Escape');
  }
  await page.evaluate(()=>window.dispatchEvent(new Event('appinstalled')));await expect(page.locator('.app-install-trigger')).toHaveCount(0);
});

test('simulated standalone launch keeps authenticated home, settings and native browser back usable without another install offer',async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844}});
  try{
    await context.addInitScript(()=>Object.defineProperty(navigator,'standalone',{value:true,configurable:true}));
    const page=await context.newPage();await login(page);await expect(page.locator('.app-install-trigger')).toHaveCount(0);
    const settings=page.getByRole('button',{name:'設定',exact:true});await settings.click();const menu=page.getByRole('menu');await expect(menu.getByRole('menuitem',{name:'加入主畫面',exact:true})).toHaveCount(0);
    await page.keyboard.press('End');await expect(menu.getByRole('menuitem',{name:'登出',exact:true})).toBeFocused();await page.keyboard.press('Escape');await expect(settings).toBeFocused();
    await navigate(page,'我的訊息');await expect(page.locator('.messages-categories')).toBeVisible();await page.goBack();await expect(page.getByRole('heading',{name:'會員首頁',level:1,exact:true})).toBeVisible();
  }finally{await context.close();}
});

test('real offline and reconnect preserve a post draft and reconnect never silently publishes it',async({page,context})=>{
  await page.setViewportSize({width:390,height:844});await login(page);await page.getByRole('button',{name:'建立貼文',exact:true}).click();
  const text=`PWA 留在此頁 ${Date.now()}`,box=page.getByLabel('貼文內容',{exact:true});await box.fill(text);
  let writes=0;page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/v1/social-posts/notes')writes++;});
  try{
    await context.setOffline(true);await expect(page.locator('.app-connection-status')).toBeVisible();await expect(box).toHaveValue(text);expect(writes).toBe(0);
    await context.setOffline(false);await expect(page.locator('.app-connection-status')).toHaveCount(0);await expect(box).toHaveValue(text);expect(writes).toBe(0);
    const saved=page.waitForResponse(response=>response.url().endsWith('/api/v1/social-posts/notes')&&response.request().method()==='POST');await page.getByRole('button',{name:'發布貼文',exact:true}).click();expect((await saved).status()).toBe(201);expect(writes).toBe(1);
    await expect(page.locator('.social-card').filter({hasText:text})).toHaveCount(1);
  }finally{await context.setOffline(false);}
});

test('member install entry returns focus and the real public chat fits simulated insets, a reduced viewport and offline status',async({page,context})=>{
  await page.setViewportSize({width:390,height:844});await login(page);const settings=page.getByRole('button',{name:'設定',exact:true});await settings.click();
  await page.getByRole('menuitem',{name:'加入主畫面',exact:true}).click();await expect(page.getByRole('dialog',{name:'加入主畫面',exact:true})).toBeVisible();await page.keyboard.press('Escape');await expect(settings).toBeFocused();
  await navigate(page,'我的訊息');await page.getByRole('tab',{name:/^世界聊天/}).click();const panel=page.locator('#messages-panel-world');await panel.getByRole('button',{name:'世界聊天',exact:true}).click();await expect(panel.locator('.messages-thread[data-chat-open=true]')).toBeVisible();
  await page.evaluate(()=>{const style=document.documentElement.style;style.setProperty('--app-safe-top','30px');style.setProperty('--app-safe-bottom','24px');style.setProperty('--app-safe-left','12px');style.setProperty('--app-safe-right','12px');});
  const box=panel.locator('textarea');await box.fill('PWA 聊天草稿');
  try{
    for(const height of [844,480]){
      await page.setViewportSize({width:390,height});
      await expect(box).toBeInViewport();await expect(panel.getByRole('button',{name:'傳送',exact:true})).toBeInViewport();
      expect((await panel.getByRole('button',{name:'搜尋訊息',exact:true}).boundingBox())!.y).toBeGreaterThanOrEqual(30);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    }
    await context.setOffline(true);await expect(page.locator('.app-connection-status')).toBeVisible();await expect(box).toHaveValue('PWA 聊天草稿');await expect(box).toBeInViewport();
    const banner=(await page.locator('.app-connection-status').boundingBox())!,header=(await panel.locator('.chat-header').boundingBox())!;expect(header.y).toBeGreaterThanOrEqual(banner.y+banner.height-1);
    await page.screenshot({path:'test-results/mobile-install-chat-offline-390x480.png'});
    await context.setOffline(false);await expect(page.locator('.app-connection-status')).toHaveCount(0);await expect(box).toHaveValue('PWA 聊天草稿');
  }finally{await context.setOffline(false);}
});
