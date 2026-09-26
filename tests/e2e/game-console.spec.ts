import {test,expect} from './fixtures.js';
import {navigate} from './navigation.js';

test('global Game Console persists across modules and synchronizes with its pop-out window',async({page})=>{
  test.setTimeout(90000);
  await page.goto('/');
  await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');
  await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');
  await page.getByRole('button',{name:'登入',exact:true}).click();
  await expect(page.getByRole('heading',{name:'會員首頁',level:1,exact:true})).toBeVisible();

  await expect(page.getByRole('button',{name:'展開 Game Console'})).toBeVisible();
  await page.getByRole('button',{name:'展開 Game Console'}).click();
  const consolePanel=page.locator('.game-console-expanded');
  await expect(consolePanel).toBeVisible();
  await expect(consolePanel.getByRole('heading',{name:'Game Console',level:2})).toBeVisible();
  await consolePanel.getByRole('tab',{name:/Social Chat/}).click();
  await consolePanel.getByLabel('輸入 Console 訊息').fill('跨頁保留測試訊息');
  await consolePanel.getByRole('button',{name:'送入控制台'}).click();
  await expect(consolePanel.getByRole('log')).toContainText('跨頁保留測試訊息');
  await consolePanel.screenshot({path:'test-results/game-console-expanded-desktop.png'});

  await consolePanel.getByRole('button',{name:'收合 Game Console'}).click();
  await navigate(page,'技能書架');
  await expect(page.getByRole('heading',{name:'技能書架',level:1,exact:true})).toBeVisible();
  await page.keyboard.press('Backquote');
  await expect(consolePanel).toBeVisible();
  await consolePanel.getByRole('tab',{name:/Social Chat/}).click();
  await expect(consolePanel.getByRole('log')).toContainText('跨頁保留測試訊息');

  const popupPromise=page.waitForEvent('popup');
  await consolePanel.getByRole('button',{name:'在獨立視窗開啟 Game Console'}).click();
  const popup=await popupPromise;
  await expect(popup.getByRole('heading',{name:'Game Console',level:1})).toBeVisible();
  await popup.getByRole('tab',{name:/Social Chat/}).click();
  await expect(popup.getByRole('log')).toContainText('跨頁保留測試訊息');
  await popup.getByLabel('輸入 Console 訊息').fill('跨視窗回傳測試訊息');
  await popup.getByRole('button',{name:'送入控制台'}).click();
  await expect(consolePanel.getByRole('log')).toContainText('跨視窗回傳測試訊息');
  await popup.close();

  await consolePanel.getByRole('button',{name:'收合 Game Console'}).click();
  await page.setViewportSize({width:390,height:844});
  await expect(page.getByRole('button',{name:'展開 Game Console'})).toBeVisible();
  await page.screenshot({path:'test-results/game-console-ticker-mobile.png'});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
