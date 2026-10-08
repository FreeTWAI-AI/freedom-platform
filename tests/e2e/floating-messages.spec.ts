import {test,expect,type Page} from './fixtures.js';

async function login(page:Page){
  await page.goto('/');await expect(page.locator('.floating-messages')).toHaveCount(0);
  await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');
  await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.getByRole('button',{name:'設定',exact:true})).toBeVisible();
}

test('chat launcher counts chat sources only, does not open history or mark anything read, and refreshes after confirmed inbox changes',async({page})=>{
  let unread=1,fail=false,history=0,writes=0;const counted=new Set<string>();
  page.on('request',request=>{const url=new URL(request.url());if(request.method()==='POST'&&/conversations|channels.*read/.test(url.pathname))writes++;if(/\/conversations\/[^/]+\/messages|\/channels\/[^/]+\/[^/]+\/messages/.test(url.pathname))history++;});
  await page.route(/\/api\/v1\/me\/conversations\?limit=1&offset=0$/,route=>{counted.add('direct');return route.fulfill({json:{items:[],unread_count:unread,next_offset:null}})});
  await page.route(/\/api\/v1\/me\/channels\?kind=(guild|squad|world)&limit=1&offset=0$/,route=>{const kind=new URL(route.request().url()).searchParams.get('kind')!;counted.add(kind);return fail&&kind==='world'?route.fulfill({status:503,json:{}}):route.fulfill({json:{items:[],unread_count:unread*({guild:2,squad:3,world:4}[kind as 'guild'|'squad'|'world']),next_offset:null}})});
  await page.route(/\/api\/v1\/me\/notifications\?/,route=>route.fulfill({json:{items:[],unread_count:99,next_offset:null}}));
  await login(page);const launcher=page.locator('.floating-messages');await expect(launcher).toHaveAccessibleName('開啟聊天室，10 則未讀');expect([...counted].sort()).toEqual(['direct','guild','squad','world']);expect(history).toBe(0);expect(writes).toBe(0);
  unread=0;await page.evaluate(()=>window.dispatchEvent(new Event('freedom-inbox-updated')));await expect(launcher).toHaveAccessibleName('開啟聊天室');await expect(launcher.locator('.floating-messages-badge')).toHaveCount(0);
  fail=true;await page.evaluate(()=>window.dispatchEvent(new Event('freedom-inbox-updated')));await expect(launcher).toHaveAccessibleName('開啟聊天室，未讀數尚未確認');await expect(launcher.locator('.floating-messages-badge')).toHaveText('?');expect(writes).toBe(0);expect(history).toBe(0);
  await launcher.click();await expect(page).toHaveURL(/#messages$/);await expect(page.locator('.messages-categories')).toBeVisible();await expect(launcher).toHaveCount(0);
});

test('phone and desktop launcher fit all three base themes, avoid the console and dialogs, open the real inbox and return with browser Back',async({page})=>{
  await page.setViewportSize({width:320,height:844});await login(page);const homeUrl=page.url();
  for(const [name,theme] of [['自由工坊－明亮','light'],['自由工坊－夜航','dark'],['自由工坊－敘生','versefolk']]){
    const settings=page.getByRole('button',{name:'設定',exact:true});await settings.click();await page.getByRole('menuitemradio',{name,exact:true}).click();await page.keyboard.press('Escape');await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
    for(const width of [320,390,1280]){
      await page.setViewportSize({width,height:844});const button=page.locator('.floating-messages');await expect(button).toBeVisible();await expect(button).toBeInViewport();
      const box=(await button.boundingBox())!,console=(await page.locator('.game-console-ticker').boundingBox())!;expect(box.width).toBeGreaterThanOrEqual(44);expect(box.height).toBeGreaterThanOrEqual(44);expect(box.y+box.height).toBeLessThanOrEqual(console.y);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      if(width===390)await page.screenshot({path:`test-results/floating-messages-${theme}-390.png`});
    }
  }
  await page.getByRole('button',{name:'建立貼文',exact:true}).click();await expect(page.getByRole('dialog',{name:'建立貼文',exact:true})).toBeVisible();await expect(page.locator('.floating-messages')).toBeHidden();await page.keyboard.press('Escape');await expect(page.locator('.floating-messages')).toBeVisible();
  await page.getByRole('button',{name:'展開訊息控制台',exact:true}).click();await expect(page.locator('.floating-messages')).toBeHidden();await page.getByRole('button',{name:'收合訊息控制台',exact:true}).click();await expect(page.locator('.floating-messages')).toBeVisible();
  await page.locator('.floating-messages').click();await expect(page).toHaveURL(/#messages$/);await expect(page.getByRole('tab',{name:/^私人訊息/})).toHaveAttribute('aria-selected','true');await expect(page.locator('.floating-messages')).toHaveCount(0);await page.goBack();await expect(page).toHaveURL(homeUrl);await expect(page.locator('.floating-messages')).toBeVisible();
});
