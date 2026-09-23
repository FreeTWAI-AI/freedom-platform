import { test,expect,type Page } from './fixtures.js';
async function login(page:Page){await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.getByRole('button',{name:'登出',exact:true})).toBeVisible();}
async function expectSinglePositioningFlow(page:Page){
  await expect(page.getByRole('heading',{name:'我的定位結果',exact:true})).toBeVisible();
  await expect(page.locator('.positioning-panel form')).toHaveCount(0);
  await expect(page.getByText(/合作偏好|想探索的職業方向/)).toHaveCount(0);
  await expect(page.getByLabel('搜尋職業方向')).toHaveCount(0);
  await expect(page.getByLabel('我現在想完成的事')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'保存合作偏好',exact:true})).toHaveCount(0);
}

test('positioning has one assessment entry and guild membership remains independently editable',async({page})=>{
  await login(page);await page.getByRole('button',{name:'我的定位',exact:true}).click();
  await expectSinglePositioningFlow(page);
  const assessment=await (await page.request.get('/api/v1/me/onboarding')).json();
  const start=page.getByRole('button',{name:assessment.completed?'重新探索定位':'開始探索我的定位',exact:true});
  await expect(start).toHaveCount(1);await start.click();
  await expect(page.getByRole('heading',{name:'你喜歡怎麼做事？',exact:true})).toBeVisible();
  await expect(page.getByRole('list',{name:'定位進度',exact:true}).getByRole('listitem')).toHaveCount(5);
  await page.getByRole('button',{name:'返回我的定位',exact:true}).click();
  await expectSinglePositioningFlow(page);
  await page.getByRole('button',{name:'職業公會',exact:true}).click();
  const card=page.locator('.guild-card').filter({has:page.getByRole('button',{name:/^加入/})}).first();
  const guildName=await card.getByRole('heading').innerText();
  await card.getByRole('button',{name:`加入${guildName}`,exact:true}).click();
  await expect(page.getByRole('button',{name:`退出${guildName}`,exact:true})).toBeVisible();
  await page.reload();
  await page.getByRole('button',{name:`退出${guildName}`,exact:true}).click();
  await expect(page.getByRole('button',{name:`加入${guildName}`,exact:true})).toBeVisible();
  await page.screenshot({path:'test-results/guilds-desktop.png',fullPage:true});
});

test('result-only positioning fits a phone and retries its authoritative assessment',async({page})=>{
  await page.setViewportSize({width:390,height:844});await login(page);
  await page.route('**/api/v1/me/onboarding',route=>route.abort());
  await page.getByRole('button',{name:'我的定位',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('定位結果暫時無法載入');
  await expect(page.locator('.positioning-panel form')).toHaveCount(0);
  await page.unroute('**/api/v1/me/onboarding');
  await page.getByRole('button',{name:'重新載入定位結果',exact:true}).click();
  await expectSinglePositioningFlow(page);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/positioning-phone.png',fullPage:true});
  await page.route('**/api/v1/guilds/directory',route=>route.abort());
  await page.getByRole('button',{name:'職業公會',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('無法連線');
});
