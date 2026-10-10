import {test,expect} from './fixtures.js';
import {navigate,signOut} from './navigation.js';
import {randomUUID} from 'node:crypto';
import type {Page} from '@playwright/test';

test('會員與獨立控制台各只讀一次 site，並保留私訊功能旗標',async({page,context})=>{
  const reads=new Map<Page,number>();
  context.on('request',request=>{if(new URL(request.url()).pathname==='/api/v1/site'){const owner=request.frame().page();reads.set(owner,(reads.get(owner)??0)+1);}});
  const images=process.env.FREEDOM_E2E_MESSAGE_IMAGE_FIXTURE==='1',blocking=process.env.FREEDOM_MEMBER_BLOCKING_ENABLED==='true';
  const checkDirect=async(owner:Page)=>{
    const dock=owner.locator('.game-console-expanded');
    await dock.getByRole('tab',{name:/私人聊天/}).click();
    await dock.getByLabel('搜尋會員').fill('示範需求者');await dock.getByRole('button',{name:'搜尋會員',exact:true}).click();
    await dock.getByRole('button',{name:'傳訊給 示範需求者',exact:true}).click();
    await expect(dock.getByRole('textbox',{name:'寫給 示範需求者 的訊息'})).toBeVisible();
    await expect(dock.getByRole('button',{name:'附加圖片',exact:true})).toHaveCount(images?1:0);
    await expect(dock.getByRole('button',{name:'封鎖設定',exact:true})).toHaveCount(blocking?1:0);
    expect(reads.get(owner)).toBe(1);
  };
  await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');await page.getByRole('button',{name:'登入',exact:true}).click();
  await expect(page.getByRole('heading',{name:'會員首頁',level:1})).toBeVisible();await page.getByRole('button',{name:'展開訊息控制台'}).click();await checkDirect(page);
  const promise=page.waitForEvent('popup');await page.getByRole('button',{name:'在獨立視窗開啟訊息控制台'}).click();const popup=await promise;
  await expect(popup.getByRole('heading',{name:'自由工坊 - 即時訊息控制台'})).toBeVisible();await page.close();await checkDirect(popup);await popup.close();
});

test('導覽訊息給出用途、下一步連結，並把時間放在內容後方',async({page})=>{
  await page.goto('/');
  await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');
  await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');
  await page.getByRole('button',{name:'登入',exact:true}).click();
  await expect(page.getByRole('heading',{name:'會員首頁',level:1})).toBeVisible();
  await page.getByRole('button',{name:'展開訊息控制台'}).click();
  const next=page.locator('.game-console-entry[data-next-step="true"]').last();
  await expect(next).toBeVisible();
  await expect(next.locator('.game-console-channel-tag')).toHaveText('網頁導覽');
  await expect(next.locator('strong')).toHaveText('下一步');
  const link=next.getByRole('link',{name:'帶我到下一步'});
  expect(await link.evaluate(element=>getComputedStyle(element).fontSize)).toBe(await next.locator('.game-console-content p').evaluate(element=>getComputedStyle(element).fontSize));
  await expect(link).toHaveCSS('display','inline');
  await expect(link).toHaveCSS('background-color','rgba(0, 0, 0, 0)');
  const href=await link.getAttribute('href');
  expect(['/#guilds','/#skills']).toContain(href);
  expect(await next.locator(':scope > :last-child').evaluate(element=>element.tagName)).toBe('TIME');
  await link.click();
  await expect(page.getByRole('heading',{name:href==='/#guilds'?'職業公會':'技能書架',level:1,exact:true})).toBeVisible();
  await navigate(page,'我的定位');
  const positioning=page.locator('.game-console-entry[data-channel="guide"]').filter({hasText:'已進入「我的定位」'}).last();
  await expect(positioning).toContainText('透過情境題整理你的能力與想走的方向');
  await expect(positioning.locator('.game-console-channel-tag')).toHaveText('網頁導覽');
  await expect(positioning.locator('strong')).toHaveCount(0);
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('訊息控制台 stays visible during required positioning without reading gated messages',async({page})=>{
  const feedReads:string[]=[];
  page.on('request',request=>{if(request.url().includes('/api/v1/me/guild-announcements'))feedReads.push(request.url());});
  await page.goto('/');
  await page.getByRole('button',{name:'建立帳號',exact:true}).click();
  await page.getByLabel('社群顯示名稱',{exact:true}).fill('控制台定位測試');
  await page.getByLabel('電子郵件',{exact:true}).fill(`console-${randomUUID()}@example.test`);
  await page.getByLabel('密碼',{exact:true}).fill('freedom-console-test-2026');
  await page.getByRole('button',{name:'建立帳號，先逛工坊',exact:true}).click();
  await page.locator('.welcome-optional > summary').click();
  await page.getByRole('button',{name:'開始／繼續定位 →',exact:true}).click();
  await expect(page.getByRole('heading',{name:'你喜歡怎麼做事？'})).toBeVisible();
  await expect(page.getByRole('button',{name:'展開訊息控制台'})).toBeVisible();
  expect((await page.locator('.game-console-ticker').boundingBox())?.x).toBeLessThan(20);
  await page.getByRole('button',{name:'展開訊息控制台'}).click();
  await expect(page.getByRole('heading',{name:'自由工坊 - 即時訊息控制台',level:2})).toBeVisible();
  expect(feedReads).toHaveLength(0);
  await page.locator('.preview-profile-menu > summary').click();
  await page.getByRole('button',{name:'登出',exact:true}).click();
  await expect(page.getByRole('button',{name:'展開訊息控制台'})).toHaveCount(0);
});

test('console preserves navigation and visibility sync while chat stays inside the selected channel',async({page})=>{
  test.setTimeout(90000);
  await page.goto('/?game-console=popout&scope=unauthorized-window-scope');await expect(page.getByText('登入已結束。')).toBeVisible();await expect(page.getByRole('heading',{name:'自由工坊 - 即時訊息控制台'})).toHaveCount(0);
  await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.getByRole('heading',{name:'會員首頁',level:1})).toBeVisible();
  await expect(page.getByRole('navigation',{name:'主要工作區'}).getByRole('button',{name:'我的訊息',exact:true})).toHaveCount(1);
  await page.getByRole('button',{name:'展開訊息控制台'}).click();const dock=page.locator('.game-console-expanded');
  expect(await dock.getByRole('tab').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-channel')))).toEqual(['all','world_chat','guild','squad','direct','guide','system','ai']);
  await expect(dock.getByRole('tab',{name:'總頻道'})).toHaveAttribute('aria-selected','true');await expect(dock.getByRole('textbox',{name:'世界聊天訊息'})).toHaveCount(0);
  await dock.getByRole('tab',{name:'系統公告'}).click();await expect(dock.getByRole('log')).toContainText('訊息控制台已連線');await expect(dock.getByRole('log')).not.toContainText('按下 ~');
  await dock.getByRole('tab',{name:'系統導覽'}).click();await expect(dock.getByRole('log')).toContainText('按下 ~');await expect(dock.getByRole('log')).toContainText('此處顯示 AI 工作指令');
  await dock.getByRole('tab',{name:'AI 指令'}).click();await expect(dock.getByRole('log')).not.toContainText('此處顯示 AI 工作指令');
  await dock.getByRole('tab',{name:/私人聊天/}).click();await expect(dock.getByLabel('搜尋會員')).toBeVisible();
  await dock.getByRole('tab',{name:/公會聊天/}).click();await expect(dock.getByRole('heading',{name:'公會頻道',exact:true})).toBeVisible();
  await dock.getByRole('tab',{name:/小隊聊天/}).click();await expect(dock.getByRole('heading',{name:'小隊頻道',exact:true})).toBeVisible();
  await dock.locator('.game-console-visibility summary').click();await dock.getByLabel('AI 指令',{exact:true}).uncheck();await dock.locator('.game-console-visibility summary').click();await expect(dock.getByRole('tab',{name:'AI 指令'})).toHaveCount(0);
  await dock.getByRole('tab',{name:'世界聊天'}).click();await dock.getByRole('textbox',{name:'世界聊天訊息'}).fill('世界聊天室測試');await dock.getByRole('button',{name:'傳送',exact:true}).click();await expect(dock.getByRole('log')).toContainText('世界聊天室測試');
  await dock.getByRole('tab',{name:'總頻道'}).click();await expect(dock.getByRole('log')).not.toContainText('世界聊天室測試');
  await dock.getByRole('button',{name:'收合訊息控制台'}).click();await navigate(page,'技能書架');await page.keyboard.press('Backquote');await dock.getByRole('tab',{name:'系統導覽'}).click();await expect(dock.getByRole('log')).toContainText('已進入「技能書架」');
  const popupPromise=page.waitForEvent('popup');await dock.getByRole('button',{name:'在獨立視窗開啟訊息控制台'}).click();const popup=await popupPromise;
  await expect(popup.getByRole('heading',{name:'自由工坊 - 即時訊息控制台',level:1})).toBeVisible();await popup.getByRole('tab',{name:'世界聊天'}).click();await popup.getByRole('textbox',{name:'世界聊天訊息'}).fill('彈出視窗世界訊息');await popup.getByRole('button',{name:'傳送',exact:true}).click();await expect(popup.getByRole('log')).toContainText('彈出視窗世界訊息');
  await page.bringToFront();await dock.getByRole('tab',{name:'世界聊天'}).click();await expect(dock.getByRole('log')).toContainText('彈出視窗世界訊息',{timeout:15000});await expect(popup.getByRole('tab',{name:'AI 指令'})).toHaveCount(0);
  await popup.locator('.game-console-visibility summary').click();await popup.getByLabel('AI 指令',{exact:true}).check();await expect(dock.getByRole('tab',{name:'AI 指令'})).toBeVisible();await popup.locator('.game-console-visibility summary').click();await popup.getByRole('tab',{name:'系統導覽'}).click();await navigate(page,'職業公會');await expect(popup.getByRole('log')).toContainText('已進入「職業公會」');
  await dock.getByRole('button',{name:'收合訊息控制台'}).click();await page.setViewportSize({width:320,height:720});await page.getByRole('button',{name:'展開訊息控制台'}).click();await dock.getByRole('tab',{name:'總頻道'}).click();expect((await dock.getByRole('heading',{name:'自由工坊 - 即時訊息控制台'}).boundingBox())?.height).toBeLessThan(24);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await dock.getByRole('tab',{name:'世界聊天'}).click();await expect(dock.getByRole('textbox',{name:'世界聊天訊息'})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await dock.screenshot({path:'test-results/game-console-mobile-expanded.png'});
  await dock.getByRole('button',{name:'收合訊息控制台'}).click();await signOut(page);await expect(popup.getByText('登入已結束')).toBeVisible();await popup.close();
});
test('pop-out reads the selected world conversation after the original page closes',async({page})=>{
  await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');await page.getByRole('button',{name:'登入',exact:true}).click();await page.getByRole('button',{name:'展開訊息控制台'}).click();
  const promise=page.waitForEvent('popup');await page.getByRole('button',{name:'在獨立視窗開啟訊息控制台'}).click();const popup=await promise;await expect(popup.getByRole('heading',{name:'自由工坊 - 即時訊息控制台'})).toBeVisible();await page.close();
  const sender=await popup.context().newPage();await sender.goto('/');await sender.getByRole('button',{name:'展開訊息控制台'}).click();await sender.getByRole('tab',{name:'世界聊天'}).click();const message=`獨立視窗繼續接收 ${randomUUID()}`;await sender.getByRole('textbox',{name:'世界聊天訊息'}).fill(message);await sender.getByRole('button',{name:'傳送',exact:true}).click();await expect(sender.getByRole('log')).toContainText(message);
  await popup.bringToFront();await popup.getByRole('tab',{name:'世界聊天'}).click();await expect(popup.getByRole('log')).toContainText(message,{timeout:15000});await sender.close();await popup.close();
});
test('private history survives signing in again and opens only after selecting its recipient',async({page})=>{
  const message=`重登入仍在的私訊 ${randomUUID()}`;
  const login=async()=>{await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.getByRole('heading',{name:'會員首頁',level:1})).toBeVisible();await page.getByRole('button',{name:'展開訊息控制台'}).click()};
  await login();const dock=page.locator('.game-console-expanded');await dock.getByRole('tab',{name:/私人聊天/}).click();await dock.getByLabel('搜尋會員').fill('示範需求者');await dock.getByRole('button',{name:'搜尋會員',exact:true}).click();await dock.getByRole('button',{name:'傳訊給 示範需求者',exact:true}).click();await dock.getByRole('textbox',{name:'寫給 示範需求者 的訊息'}).fill(message);await dock.getByRole('button',{name:'送出',exact:true}).click();await expect(dock.getByRole('log')).toContainText(message);
  await dock.getByRole('button',{name:'收合訊息控制台'}).click();await signOut(page);await login();await dock.getByRole('tab',{name:'總頻道'}).click();await expect(dock.getByRole('log')).not.toContainText(message);
  await dock.getByRole('tab',{name:/私人聊天/}).click();await expect(dock.getByRole('log')).toHaveCount(0);await dock.locator('[aria-label="對話列表"]').getByRole('button').filter({hasText:'示範需求者'}).click();await expect(dock.getByRole('log')).toContainText(message);
});
