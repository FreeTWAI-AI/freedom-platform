import {randomUUID} from 'node:crypto';
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
  await launcher.click();await expect(page.locator('.messages-categories')).toBeVisible();await expect(launcher).toBeVisible();await expect(launcher).toHaveAttribute('aria-expanded','true');await expect(page.locator('.game-console')).toHaveCount(0);
});

test('one bubble toggles the persistent inbox across pages and themes at phone, tablet and desktop widths',async({page})=>{
  await login(page);const homeUrl=page.url(),bubble=page.locator('.floating-messages'),panel=page.locator('.floating-message-panel');
  for(const [name,theme] of [['自由工坊－明亮','light'],['自由工坊－夜航','dark'],['自由工坊－敘生','versefolk']]){
    await page.getByRole('button',{name:'設定',exact:true}).click();await page.getByRole('menuitemradio',{name,exact:true}).click();await page.keyboard.press('Escape');
    for(const width of [320,390,768,1440]){
      await page.setViewportSize({width,height:900});await expect(bubble).toBeVisible();await expect(bubble).toBeInViewport();await bubble.click();await expect(panel).toBeVisible();await expect(bubble).toHaveAttribute('aria-expanded','true');
      const box=(await bubble.boundingBox())!,inbox=(await panel.boundingBox())!;expect(box.width).toBeGreaterThanOrEqual(44);expect(box.height).toBeGreaterThanOrEqual(44);expect(inbox.y+inbox.height).toBeLessThanOrEqual(box.y);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await expect(panel.getByRole('tab')).toHaveCount(4);await expect(panel.getByRole('tab',{name:/^通知/})).toHaveCount(0);await expect(page.locator('.nav-primary').getByRole('button',{name:'我的訊息'})).toHaveCount(0);
      if([390,768,1440].includes(width))await page.screenshot({path:`test-results/unified-messages-${theme}-${width}.png`});
      await page.keyboard.press('Escape');await expect(panel).toBeHidden();await expect(bubble).toBeFocused();await expect(page).toHaveURL(homeUrl);
    }
  }
  await page.setViewportSize({width:1440,height:900});await bubble.click();
  await panel.getByLabel('搜尋會員',{exact:true}).fill('示範需求者');await panel.getByRole('button',{name:'搜尋會員',exact:true}).click();await panel.getByRole('button',{name:'傳訊給 示範需求者',exact:true}).click();
  const draft=panel.getByRole('textbox',{name:'寫給 示範需求者 的訊息'});await draft.fill('跨頁與收合後保留的草稿');await bubble.click();await expect(panel).toBeHidden();
  await page.getByRole('button',{name:'技能書架',exact:true}).click();await bubble.click();await expect(draft).toHaveValue('跨頁與收合後保留的草稿');
  await page.setViewportSize({width:390,height:844});await expect(bubble).toBeVisible();await expect(draft).toBeVisible();await page.screenshot({path:'test-results/unified-messages-draft-phone.png'});
  await bubble.click();await expect(panel).toBeHidden();await expect(page.locator('.community-header')).toBeVisible();
});

test('closed history stays idle and legacy inbox/popout links open the same panel',async({page,request,baseURL})=>{
  const sender=await request.post('/api/v1/auth/login',{data:{email:'reviewer@local.test',password:'freedom-local-demo'},headers:{Origin:baseURL!}});
  expect(sender.status()).toBe(200);const {csrf_token}=await sender.json();
  const body=`收合前可見的未讀訊息 ${randomUUID()}`;
  const sent=await request.post('/api/v1/me/channels/world/world/messages',{data:{body},headers:{Origin:baseURL!,'X-CSRF-Token':csrf_token,'Idempotency-Key':randomUUID()}});
  expect(sent.status()).toBe(201);
  const message=await sent.json();
  let history=0,reads=0;
  page.on('request',request=>{const url=new URL(request.url());if(/channels\/world\/world\/messages$/.test(url.pathname))history++;if(request.method()==='POST'&&url.pathname.endsWith('/read'))reads++;});
  await login(page);const bubble=page.locator('.floating-messages'),panel=page.locator('.floating-message-panel');
  // The visible initial read and its count refresh must finish before measuring
  // closed-panel idleness; the textbox can render before history/read settles.
  const initialRead=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith('/channels/world/world/read'));
  await bubble.click();await panel.getByRole('tab',{name:/世界聊天/}).click();
  await expect(panel.getByRole('log')).toContainText(body);
  const acknowledged=await initialRead;expect(acknowledged.status()).toBe(200);
  expect(acknowledged.request().postDataJSON()).toEqual({through_message_id:message.message_id});
  await expect(panel.getByText('正在同步已讀…',{exact:true})).toBeHidden();
  await bubble.click();await expect(panel).toBeHidden();const before={history,reads};
  await page.evaluate(()=>{window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('online'));document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForTimeout(1300);expect({history,reads}).toEqual(before);
  await page.goto('/#messages');await expect(panel).toBeVisible();await expect(bubble).toBeVisible();await expect(page.locator('.member-messages')).toHaveCount(1);
  await page.goto('/?game-console=popout&scope=legacy-fixture');await expect(panel).toBeVisible();await expect(page).toHaveURL(/\/#messages$/);await expect(page.locator('.game-console')).toHaveCount(0);
});
