import { test,expect,type Page } from '@playwright/test';
async function login(page:Page){await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.getByRole('button',{name:'登出',exact:true})).toBeVisible();}
test('member optionally saves collaboration preferences, returns after reload and freely joins a vertical Guild',async({page})=>{
  await login(page);await page.getByRole('button',{name:'我的定位',exact:true}).click();
  await page.getByText('合作偏好（選填）',{exact:true}).click();
  await page.getByLabel('現實職業／目前身分').fill('茶農、店面經營者');await page.getByLabel('背景與手上的資源').fill('自家茶葉與包裝設備');await page.getByLabel('我擅長的事').fill('攝影、商品介紹');
  await page.getByLabel('我現在想完成的事').fill('找到願意一起販售茶葉的夥伴');await page.getByLabel('每週可投入時間（分鐘）').fill('90');
  await page.getByLabel('供貨商',{exact:true}).check();await page.getByLabel('搜尋職業方向').fill('食品供貨者');await page.getByRole('checkbox',{name:/食品供貨者/}).check();
  await page.getByLabel('這些是我目前的想法，我確認保存').check();await page.getByRole('button',{name:'保存合作偏好',exact:true}).click();
  await expect(page.getByText('合作偏好已保存。你可以隨時調整。')).toBeVisible();
  await page.reload();await page.getByRole('button',{name:'我的定位',exact:true}).click();await page.getByText('合作偏好（選填）',{exact:true}).click();await expect(page.getByLabel('我現在想完成的事')).toHaveValue('找到願意一起販售茶葉的夥伴');
  await page.getByRole('button',{name:'職業公會',exact:true}).click();const join=page.getByRole('button',{name:'加入商品品質與供應公會',exact:true});await join.click();
  await expect(page.getByRole('button',{name:'退出商品品質與供應公會',exact:true})).toBeVisible();await page.reload();await page.getByRole('button',{name:'職業公會',exact:true}).click();
  await page.getByRole('button',{name:'退出商品品質與供應公會',exact:true}).click();await expect(page.getByRole('button',{name:'加入商品品質與供應公會',exact:true})).toBeVisible();
  await page.screenshot({path:'test-results/guilds-desktop.png',fullPage:true});
});
test('positioning remains usable at phone width and reports unavailable API honestly',async({page})=>{
  await page.setViewportSize({width:390,height:844});await login(page);await page.getByRole('button',{name:'我的定位',exact:true}).click();
  await expect(page.getByText('合作偏好（選填）',{exact:true})).toBeVisible();
  await expect(page.getByLabel('我現在想完成的事')).not.toBeVisible();
  const dimensions=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
  await page.screenshot({path:'test-results/positioning-phone.png',fullPage:true});
  await page.route('**/api/v1/guilds/directory',r=>r.abort());await page.getByRole('button',{name:'職業公會',exact:true}).click();await expect(page.getByRole('alert')).toContainText('無法連線');
});
