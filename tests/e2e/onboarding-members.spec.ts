import { test, expect, type Page } from '@playwright/test';
const password='freedom-workshop-member-2026';
async function register(page:Page, nickname:string){
  const email=`member-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`;
  await page.goto('/');await page.getByRole('button',{name:'建立帳號',exact:true}).click();
  await page.getByLabel('喜歡的暱稱',{exact:true}).fill(nickname);
  await page.getByLabel('電子郵件',{exact:true}).fill(email);await page.getByLabel('密碼',{exact:true}).fill(password);
  await expect(page.locator('input[type=email]')).toHaveCount(1);
  await expect(page.getByLabel('聯絡 E-mail',{exact:true})).toHaveCount(0);
  const registrationRequest=page.waitForRequest(request=>request.url().endsWith('/api/v1/auth/register')&&request.method()==='POST');
  await page.getByRole('button',{name:'註冊並開始定位',exact:true}).click();
  expect((await registrationRequest).postDataJSON()).toEqual({email,password,nickname});
  await expect(page.getByRole('heading',{name:'你喜歡怎麼做事？'})).toBeVisible();return email;
}
async function answerQuestions(page:Page){
  await expect(page.getByRole('heading',{name:'你喜歡怎麼做事？'})).toBeVisible();
  for(const field of await page.locator('.quiz-question').all())await field.getByRole('radio').first().check();
  await page.getByRole('button',{name:'保存，繼續下一步 →',exact:true}).click();
  await expect(page.getByRole('heading',{name:'遇到這些情境，你會怎麼做？'})).toBeVisible();
  for(const field of await page.locator('.quiz-question').all())await field.getByRole('radio').first().check();
  await page.getByRole('button',{name:'保存，繼續下一步 →',exact:true}).click();
  await expect(page.getByRole('heading',{name:'你從哪裡來，帶著哪些能力？'})).toBeVisible();
}
async function finishGuild(page:Page){
  const card=page.locator('.recommendation-card').first();await expect(card).toBeVisible();
  await card.getByRole('checkbox').check();await card.getByRole('radio').check();
  await page.getByRole('button',{name:'確認加入公會，領取技能書',exact:true}).click();
  await expect(page.getByRole('heading',{name:'你的第一段旅程，現在開始。'})).toBeVisible();
  await expect(page.getByRole('button',{name:'查看技能書介紹',exact:true}).first()).toBeVisible();
  await page.getByRole('button',{name:'進入自由工坊 →',exact:true}).click();
  await expect(page.getByRole('navigation',{name:'主要工作區'})).toBeVisible();
}
async function completeOrientation(page:Page){
  await answerQuestions(page);
  await page.getByLabel('你的職業／目前身分').fill('自由工作者');
  // A beginner can finish without claiming a skill or a paid subscription.
  await page.getByRole('button',{name:'保存，繼續下一步 →',exact:true}).click();
  await expect(page.getByRole('heading',{name:'你的裝備庫'})).toBeVisible();
  await page.getByRole('button',{name:'看看適合我的公會',exact:true}).click();
  await finishGuild(page);
}
test('new member completes required positioning, chooses primary guild and gets a persistent member card',async({page})=>{
  const email=await register(page,'工坊新夥伴');
  await expect(page.getByRole('navigation',{name:'主要工作區'})).toHaveCount(0);
  const blocked=await page.request.get('/api/v1/retail/catalog');expect(blocked.status()).toBe(403);
  await page.goto('/#retail');await expect(page.getByRole('heading',{name:'你喜歡怎麼做事？'})).toBeVisible();
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
  await expect(page.getByLabel('聯絡 E-mail',{exact:true})).toHaveValue(email);
  await expect(page.getByLabel('聯絡 E-mail',{exact:true})).toHaveJSProperty('readOnly',true);
  await page.getByLabel('Discord 帳號',{exact:true}).fill('new.member');
  const audiences=page.getByRole('group',{name:'Discord 帳號可見範圍',exact:true});
  await expect(audiences.getByRole('checkbox',{name:'不公開',exact:true})).toBeChecked();
  await audiences.getByRole('checkbox',{name:'平台好友',exact:true}).check();
  await audiences.getByRole('checkbox',{name:'公會夥伴',exact:true}).check();
  await expect(audiences.getByRole('checkbox',{name:'不公開',exact:true})).not.toBeChecked();
  const profileRequest=page.waitForRequest(request=>request.url().endsWith('/api/v1/me/account')&&request.method()==='POST');
  await page.getByRole('button',{name:'保存個人資料與公開範圍',exact:true}).click();
  const profileBody=(await profileRequest).postDataJSON();
  expect(profileBody.contacts.email).toEqual({audiences:[]});
  expect(profileBody.contacts.discord).toEqual({value:'new.member',audiences:['friends','guild']});
  await expect(page.getByText('個人資料與每一項聯絡方式的可見範圍已保存。')).toBeVisible();
  await page.getByRole('button',{name:'職業公會',exact:true}).click();await expect(page.locator('.primary-guild')).toHaveCount(1);
  await expect(page.locator('.primary-guild')).toContainText('公會長：待任命');
  await expect(page.locator('.guild-card').first()).toHaveClass(/primary-guild/);
  const secondary=page.locator('.guild-card').filter({has:page.getByRole('button',{name:/^加入/})}).first();
  const secondaryName=await secondary.getByRole('heading').innerText();
  await secondary.getByRole('button',{name:/^加入/}).click();
  await expect(page.locator('.guild-card').nth(1).getByRole('heading')).toHaveText(secondaryName);
  await expect(page.locator('.guild-card').first()).toHaveClass(/primary-guild/);
  const firstLibrary=page.locator('.guild-card').first().locator('.guild-book-list');
  await expect(firstLibrary).toContainText('公會藏經閣');
  const bookButton=firstLibrary.getByRole('button').first(),bookTitle=await bookButton.innerText();
  await bookButton.click();const intro=page.getByRole('dialog');await expect(intro).toBeVisible();
  await expect(intro.getByRole('heading',{name:bookTitle,exact:true})).toBeVisible();
  await expect(intro.getByRole('link',{name:'閱讀技能書 ↗',exact:true})).toHaveAttribute('href',/^https:\/\/github\.com\//);
  await intro.getByRole('button',{name:'關閉技能書介紹',exact:true}).click();await expect(intro).not.toBeVisible();
  // Only display metadata is augmented here; real membership records and guild commands remain untouched.
  await page.route('**/api/v1/guilds/directory',async route=>{
    const response=await route.fetch(),value=await response.json();
    value.items=value.items.map((guild:any)=>({...guild,guild_master:guild.is_primary?null:{display_name:'測試正式會長'},guild_master_nominee:{display_name:'測試預定會長',state:'pending'}}));
    await route.fulfill({response,json:value});
  });
  await page.reload();await expect(page.locator('.primary-guild .guild-master')).toHaveText('公會長：測試預定會長（待連結會員帳號）');
  await expect(page.locator('.guild-card:not(.primary-guild) .guild-master').first()).toHaveText('公會長：測試正式會長');
  await page.unroute('**/api/v1/guilds/directory');


  await page.getByRole('button',{name:'工坊夥伴',exact:true}).click();await expect(page.getByRole('heading',{name:/工坊新夥伴/})).toBeVisible();
  await page.getByRole('button',{name:'登出',exact:true}).click();await page.getByLabel('電子郵件',{exact:true}).fill(email);await page.getByLabel('密碼',{exact:true}).fill(password);await page.getByRole('button',{name:'登入',exact:true}).click();
  await expect(page.getByRole('navigation',{name:'主要工作區'})).toBeVisible();await page.getByRole('button',{name:'我的名片',exact:true}).click();await expect(page.getByLabel('Discord 帳號',{exact:true})).toHaveValue('new.member');
  const restoredAudiences=page.getByRole('group',{name:'Discord 帳號可見範圍',exact:true});
  await expect(restoredAudiences.getByRole('checkbox',{name:'平台好友',exact:true})).toBeChecked();
  await expect(restoredAudiences.getByRole('checkbox',{name:'公會夥伴',exact:true})).toBeChecked();
  // Platform-public includes every group; changing back to private must clear all grants.
  await restoredAudiences.getByRole('checkbox',{name:'平台公開',exact:true}).check();
  await expect(restoredAudiences.getByRole('checkbox',{name:'平台好友',exact:true})).toBeDisabled();
  await restoredAudiences.getByRole('checkbox',{name:'不公開',exact:true}).check();
  await expect(restoredAudiences.getByRole('checkbox',{name:'平台公開',exact:true})).not.toBeChecked();
  await expect(restoredAudiences.getByRole('checkbox',{name:'公會夥伴',exact:true})).not.toBeChecked();
  await page.getByRole('button',{name:'保存個人資料與公開範圍',exact:true}).click();
  await expect(page.getByText('個人資料與每一項聯絡方式的可見範圍已保存。')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('group',{name:'Discord 帳號可見範圍',exact:true}).getByRole('checkbox',{name:'不公開',exact:true})).toBeChecked();
  await expect(page.getByLabel('聯絡 E-mail',{exact:true})).toHaveValue(email);
  await page.screenshot({path:'test-results/member-onboarding-desktop.png',fullPage:true});
});
test('mobile registration and mandatory orientation remain usable without horizontal overflow',async({page})=>{
  await page.setViewportSize({width:390,height:844});await register(page,'手機新夥伴');
  await expect(page.getByRole('heading',{name:'你喜歡怎麼做事？'})).toBeVisible();
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

test('skill trees preserve choices across screen sizes and show only three featured skills on the member card',async({page})=>{
  await register(page,'多元能力夥伴');
  const firstQuestion=page.locator('.quiz-question').first();
  await firstQuestion.getByText('補充自己的想法（選填）',{exact:true}).click();
  await firstQuestion.getByLabel('這一題的補充',{exact:true}).fill('這是我的私人補充，不公開在名片。');
  await answerQuestions(page);
  const definition=await (await page.request.get('/api/v1/assessment-definition')).json();
  const choices=definition.capability_categories.slice(0,4).map((category:any)=>({category:category.label,group:category.subcategories[0].label,...category.subcategories[0].options[0]}));
  for(const choice of choices)await page.getByLabel(choice.label,{exact:true}).check();
  await page.getByLabel('自訂能力',{exact:true}).fill('手工皮革製作');await page.getByRole('button',{name:'加入能力',exact:true}).click();
  await page.getByLabel(`精選能力：${choices[0].label}`,{exact:true}).check();
  await page.getByLabel(`精選能力：${choices[1].label}`,{exact:true}).check();
  await page.getByLabel('精選能力：手工皮革製作',{exact:true}).check();
  await expect(page.getByLabel(`精選能力：${choices[2].label}`,{exact:true})).toBeDisabled();
  await page.setViewportSize({width:390,height:844});
  await expect(page.getByLabel(choices[0].label,{exact:true})).toBeHidden();
  const category=page.locator('.category-group').filter({has:page.locator('.tree-toggle strong',{hasText:choices[0].category})}).first();
  await category.locator(':scope > .tree-toggle').click();
  const group=category.locator('.tree-subcategory').filter({has:page.getByRole('button',{name:new RegExp(choices[0].group)})}).first();
  await group.locator('.tree-subtoggle').click();
  await expect(page.getByLabel(choices[0].label,{exact:true})).toBeChecked();
  await page.getByLabel('搜尋能力',{exact:true}).fill(choices[2].label);
  await expect(page.getByLabel(choices[2].label,{exact:true})).toBeChecked();
  await page.getByLabel('搜尋能力',{exact:true}).fill('');
  await page.setViewportSize({width:1280,height:900});
  await expect(page.getByLabel(choices[3].label,{exact:true})).toBeChecked();
  await page.getByRole('button',{name:'保存，繼續下一步 →',exact:true}).click();
  await expect(page.getByRole('heading',{name:'你的裝備庫'})).toBeVisible();
  await page.getByLabel('自訂裝備',{exact:true}).fill('我的錄音設備');await page.getByRole('button',{name:'加入裝備',exact:true}).click();
  await page.getByRole('button',{name:'上一步',exact:true}).click();
  for(const choice of choices)await expect(page.getByLabel(choice.label,{exact:true})).toBeChecked();
  await expect(page.getByLabel('精選能力：手工皮革製作',{exact:true})).toBeChecked();
  await page.getByRole('button',{name:'保存，繼續下一步 →',exact:true}).click();
  await expect(page.getByRole('button',{name:'移除裝備：我的錄音設備',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'看看適合我的公會',exact:true}).click();await finishGuild(page);
  await expect(page.locator('.member-featured .pill')).toHaveCount(3);
  await expect(page.locator('.member-featured')).toContainText('手工皮革製作');
  await expect(page.locator('.member-card')).not.toContainText('這是我的私人補充');
  const details=page.locator('.member-full-profile');await expect(details).not.toHaveAttribute('open');
  await details.locator('summary').click();for(const choice of choices)await expect(details).toContainText(choice.label);
  await expect(details).toContainText('我的錄音設備');
  await page.reload();await expect(page.locator('.member-featured .pill')).toHaveCount(3);
  const draft=(await (await page.request.get('/api/v1/me/onboarding')).json()).draft;
  expect(draft.featured_capabilities).toEqual([choices[0].id,choices[1].id,'custom:手工皮革製作']);
  expect(Object.values(draft.question_notes)).toContain('這是我的私人補充，不公開在名片。');
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
