import {test,expect} from './fixtures.js';
import {navigate} from './navigation.js';
import {randomUUID} from 'node:crypto';

test('Game Console stays visible during required positioning without reading gated messages',async({page})=>{
  const feedReads:string[]=[];
  page.on('request',request=>{if(request.url().includes('/api/v1/me/guild-announcements'))feedReads.push(request.url());});
  await page.goto('/');
  await page.getByRole('button',{name:'建立帳號',exact:true}).click();
  await page.getByLabel('社群顯示名稱',{exact:true}).fill('控制台定位測試');
  await page.getByLabel('電子郵件',{exact:true}).fill(`console-${randomUUID()}@example.test`);
  await page.getByLabel('密碼',{exact:true}).fill('freedom-console-test-2026');
  await page.getByRole('button',{name:'註冊並開始定位',exact:true}).click();
  await expect(page.getByRole('heading',{name:'你喜歡怎麼做事？'})).toBeVisible();
  await expect(page.getByRole('button',{name:'展開 Game Console'})).toBeVisible();
  expect((await page.locator('.game-console').boundingBox())?.x).toBeLessThan(20);
  await page.getByRole('button',{name:'展開 Game Console'}).click();
  await expect(page.getByRole('heading',{name:'Game Console',level:2})).toBeVisible();
  expect(feedReads).toHaveLength(0);
  await page.getByRole('button',{name:'登出',exact:true}).click();
  await expect(page.getByRole('button',{name:'展開 Game Console'})).toHaveCount(0);
});

test('global Game Console persists across modules and synchronizes with its pop-out window',async({page})=>{
  test.setTimeout(90000);
  await page.goto('/?game-console=popout&scope=unauthorized-window-scope');
  await expect(page.getByText('登入已結束。')).toBeVisible();
  await expect(page.getByRole('heading',{name:'Game Console'})).toHaveCount(0);
  await page.goto('/');
  await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');
  await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');
  await page.getByRole('button',{name:'登入',exact:true}).click();
  await expect(page.getByRole('heading',{name:'會員首頁',level:1,exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'最新動態',level:2})).toBeVisible();
  await expect(page.getByRole('region',{name:'最新動態'}).getByRole('button',{name:/Game Console 已連線/})).toBeVisible();
  await page.screenshot({path:'test-results/game-console-home-desktop.png'});
  await page.getByRole('region',{name:'最新動態'}).getByRole('button',{name:/Social Chat/}).click();
  await expect(page.getByRole('tab',{name:/Social Chat/})).toBeFocused();
  await page.getByRole('button',{name:'收合 Game Console'}).click();

  await expect(page.getByRole('button',{name:'展開 Game Console'})).toBeVisible();
  await page.getByRole('button',{name:'展開 Game Console'}).click();
  const consolePanel=page.locator('.game-console-expanded');
  await expect(consolePanel).toBeVisible();
  await expect(consolePanel.getByRole('heading',{name:'Game Console',level:2})).toBeVisible();
  await expect(consolePanel.getByRole('tab',{name:/Social Chat/})).toHaveAttribute('aria-selected','true');
  await consolePanel.getByRole('tab',{name:/System \/ Guide/}).click();
  await expect(consolePanel.getByRole('log')).toContainText('Game Console 已連線');
  await consolePanel.getByRole('tab',{name:/Social Chat/}).click();
  await expect(consolePanel.getByRole('link',{name:'前往我的訊息'})).toBeVisible();
  await expect(consolePanel.getByLabel('輸入 Console 訊息')).toHaveCount(0);
  await consolePanel.screenshot({path:'test-results/game-console-expanded-desktop.png'});

  await consolePanel.getByRole('button',{name:'收合 Game Console'}).click();
  await navigate(page,'技能書架');
  await expect(page.getByRole('heading',{name:'技能書架',level:1,exact:true})).toBeVisible();
  await page.keyboard.press('Backquote');
  await expect(consolePanel).toBeVisible();
  await consolePanel.getByRole('tab',{name:/System \/ Guide/}).click();
  await expect(consolePanel.getByRole('log')).toContainText('已進入「技能書架」');

  const popupPromise=page.waitForEvent('popup');
  await consolePanel.getByRole('button',{name:'在獨立視窗開啟 Game Console'}).click();
  const popup=await popupPromise;
  await expect(popup.getByRole('heading',{name:'Game Console',level:1})).toBeVisible();
  await expect(popup.getByRole('log')).toContainText('已進入「技能書架」');
  await navigate(page,'職業公會');
  await expect(popup.getByRole('log')).toContainText('已進入「職業公會」');
  await popup.getByRole('tab',{name:/Social Chat/}).click();
  await expect(popup.getByRole('link',{name:'前往我的訊息'})).toHaveAttribute('target','_blank');

  await consolePanel.getByRole('button',{name:'收合 Game Console'}).click();
  await page.setViewportSize({width:390,height:844});
  await expect(page.getByRole('button',{name:'展開 Game Console'})).toBeVisible();
  await page.screenshot({path:'test-results/game-console-ticker-mobile.png'});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByRole('button',{name:'登出',exact:true}).click();
  await expect(popup.getByText('登入已結束')).toBeVisible();
  await popup.close();
});
