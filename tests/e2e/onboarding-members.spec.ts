import { test, expect, type Page } from '@playwright/test';
const password='freedom-workshop-member-2026';
async function register(page:Page, nickname:string){
  const email=`member-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`;
  await page.goto('/');await page.getByRole('button',{name:'建立帳號',exact:true}).click();
  await page.getByLabel('喜歡的暱稱',{exact:true}).fill(nickname);
  await page.getByLabel('電子郵件',{exact:true}).fill(email);await page.getByLabel('密碼',{exact:true}).fill(password);
  await page.getByRole('button',{name:'註冊並開始定位',exact:true}).click();
  await expect(page.getByRole('heading',{name:'你從哪裡來，帶著哪些能力？'})).toBeVisible();return email;
}
async function completeOrientation(page:Page){
  await page.getByLabel('你的職業／目前身分').fill('自由工作者');
  await page.getByLabel('剛開始探索，想從基礎學起',{exact:true}).check();
  await page.getByRole('button',{name:'保存，繼續下一步 →',exact:true}).click();
  await expect(page.getByRole('heading',{name:'你的裝備庫'})).toBeVisible();
  await page.getByRole('button',{name:'保存，繼續下一步 →',exact:true}).click();
  await expect(page.getByRole('heading',{name:'你喜歡怎麼做事？'})).toBeVisible();
  for(const field of await page.locator('.quiz-question').all())await field.getByRole('radio').first().check();
  await page.getByRole('button',{name:'保存，繼續下一步 →',exact:true}).click();
  await expect(page.getByRole('heading',{name:'遇到這些情境，你會怎麼做？'})).toBeVisible();
  for(const field of await page.locator('.quiz-question').all())await field.getByRole('radio').first().check();
  await page.getByRole('button',{name:'看看適合我的公會',exact:true}).click();
  const card=page.locator('.recommendation-card').first();await expect(card).toBeVisible();
  await card.getByRole('checkbox').check();await card.getByRole('radio').check();
  await page.getByRole('button',{name:'確認加入公會，領取技能書',exact:true}).click();
  await expect(page.getByRole('heading',{name:'你的第一段旅程，現在開始。'})).toBeVisible();
  await expect(page.getByRole('link',{name:'閱讀技能書 ↗'}).first()).toBeVisible();
  await page.getByRole('button',{name:'進入自由工坊 →',exact:true}).click();
  await expect(page.getByRole('navigation',{name:'主要工作區'})).toBeVisible();
}
test('new member completes required positioning, chooses primary guild and gets a persistent member card',async({page})=>{
  const email=await register(page,'工坊新夥伴');
  await expect(page.getByRole('navigation',{name:'主要工作區'})).toHaveCount(0);
  const blocked=await page.request.get('/api/v1/retail/catalog');expect(blocked.status()).toBe(403);
  await page.goto('/#retail');await expect(page.getByRole('heading',{name:'你從哪裡來，帶著哪些能力？'})).toBeVisible();
  await completeOrientation(page);
  // An attempted deep link while gated must not steal the first completed member landing.
  await expect(page).toHaveURL(/#home$/);
  await expect(page.getByRole('heading',{name:'會員首頁',exact:true})).toBeVisible();
  await expect(page.locator('.member-card')).toContainText('工坊新夥伴');
  await expect(page.locator('.member-card')).toContainText('主要公會');
  await expect(page.locator('.member-card .positioning-title')).not.toHaveText('探索自己的方向');
  // Once onboarding is complete, ordinary deep links still open their requested module.
  await page.goto('/#retail');
  await expect(page.getByRole('heading',{name:'開店與銷售',exact:true}).first()).toBeVisible();
  await expect(page).toHaveURL(/#retail$/);
  await page.getByRole('button',{name:'我的名片',exact:true}).click();
  await expect(page.getByRole('heading',{name:'我的會員名片',exact:true})).toBeVisible();
  await page.getByLabel('Discord 帳號',{exact:true}).fill('new.member');await page.getByLabel('Discord 帳號可見範圍',{exact:true}).selectOption('guild');
  await page.getByRole('button',{name:'保存個人資料與公開範圍',exact:true}).click();
  await expect(page.getByText('個人資料與每一項聯絡方式的可見範圍已保存。')).toBeVisible();
  await page.getByRole('button',{name:'職業公會',exact:true}).click();await expect(page.locator('.primary-guild')).toHaveCount(1);
  await expect(page.locator('.primary-guild')).toContainText('公會長：待任命');
  await page.getByRole('button',{name:'工坊夥伴',exact:true}).click();await expect(page.getByRole('heading',{name:/工坊新夥伴/})).toBeVisible();
  await page.getByRole('button',{name:'登出',exact:true}).click();await page.getByLabel('電子郵件',{exact:true}).fill(email);await page.getByLabel('密碼',{exact:true}).fill(password);await page.getByRole('button',{name:'登入',exact:true}).click();
  await expect(page.getByRole('navigation',{name:'主要工作區'})).toBeVisible();await page.getByRole('button',{name:'我的名片',exact:true}).click();await expect(page.getByLabel('Discord 帳號',{exact:true})).toHaveValue('new.member');
  await expect(page.getByLabel('Discord 帳號可見範圍',{exact:true})).toHaveValue('guild');
  await page.screenshot({path:'test-results/member-onboarding-desktop.png',fullPage:true});
});
test('mobile registration and mandatory orientation remain usable without horizontal overflow',async({page})=>{
  await page.setViewportSize({width:390,height:844});await register(page,'手機新夥伴');
  await expect(page.getByRole('heading',{name:'你從哪裡來，帶著哪些能力？'})).toBeVisible();
  let dimensions=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
  await page.screenshot({path:'test-results/member-onboarding-phone.png',fullPage:true});
  await completeOrientation(page);
  await page.getByRole('button',{name:'我的名片',exact:true}).click();await expect(page.getByRole('heading',{name:'我的會員名片'})).toBeVisible();
  dimensions=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
});
test('member explicitly approves then revokes a scoped supplier client read connection',async({page})=>{
  await register(page,'客戶端連線夥伴');await completeOrientation(page);
  const start=await page.request.post('/api/v1/client-connections/start',{headers:{Origin:'http://127.0.0.1:4311'},data:{kind:'supplier',client_name:'我的供應端測試客戶端'}});expect(start.status()).toBe(201);
  const pending=await start.json();
  await page.getByRole('button',{name:'我的名片',exact:true}).click();await page.getByLabel('客戶端一次性代碼',{exact:true}).fill(pending.user_code);
  await page.getByRole('button',{name:'查看連線請求',exact:true}).click();await expect(page.getByText('你自己的商品與供貨條件',{exact:false})).toBeVisible();
  await page.getByRole('button',{name:'確認並允許這次讀取連線',exact:true}).click();await expect(page.getByText('讀取連線已核准，請回到你的客戶端繼續。')).toBeVisible();
  const poll=await page.request.post('/api/v1/client-connections/poll',{headers:{Origin:'http://127.0.0.1:4311'},data:{device_secret:pending.device_secret}});expect(poll.status()).toBe(200);
  const authorized=await poll.json();expect(authorized.status).toBe('authorized');
  const read=await page.request.get('/client-api/v1/supplier/products',{headers:{Authorization:`Bearer ${authorized.access_token}`}});expect(read.status()).toBe(200);expect((await read.json()).read_only).toBe(true);
  await page.getByRole('button',{name:'撤銷連線',exact:true}).click();await expect(page.getByText('讀取連線已撤銷。')).toBeVisible();
  const rejected=await page.request.get('/client-api/v1/supplier/products',{headers:{Authorization:`Bearer ${authorized.access_token}`}});expect(rejected.status()).toBe(401);
});
