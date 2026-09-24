import { e2eOrigin } from '../../packages/testing/e2e-origin.js';
import { navigate } from './navigation.js';
import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from './fixtures.js';
const password='freedom-workshop-member-2026';
async function register(page:Page, nickname:string){
  const email=`member-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`;
  await page.goto('/');await page.getByRole('button',{name:'建立帳號',exact:true}).click();
  await page.getByLabel('社群顯示名稱',{exact:true}).fill(nickname);
  await page.getByLabel('電子郵件',{exact:true}).fill(email);await page.getByLabel('密碼',{exact:true}).fill(password);
  await expect(page.locator('input[type=email]')).toHaveCount(1);
  await expect(page.getByLabel('聯絡 E-mail',{exact:true})).toHaveCount(0);
  const registrationRequest=page.waitForRequest(request=>request.url().endsWith('/api/v1/auth/register')&&request.method()==='POST');
  await page.getByRole('button',{name:'註冊並開始定位',exact:true}).click();
  expect((await registrationRequest).postDataJSON()).toEqual({email,password,nickname});
  await expect(page.getByRole('heading',{name:'你喜歡怎麼做事？'})).toBeVisible();return email;
}
async function answerQuestions(page:Page,lastPreference=false){
  await expect(page.getByRole('heading',{name:'你喜歡怎麼做事？'})).toBeVisible();
  for(const field of await page.locator('.quiz-question').all())await (lastPreference?field.getByRole('radio').last():field.getByRole('radio').first()).check();
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
  await expect(page.getByRole('button',{name:'閱讀技能書',exact:true}).first()).toBeVisible();
  await page.getByRole('button',{name:'進入自由工坊 →',exact:true}).click();
  await expect(page.locator('.shell')).toBeVisible();
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
test('member changes community name and optional identity, sees persisted cards and can hide the label on mobile',async({page})=>{
  const email=await register(page,'名片選項測試');await completeOrientation(page);
  await navigate(page, '我的名片');
  const name=page.getByLabel('社群顯示名稱',{exact:true}),identity=page.getByRole('combobox',{name:'我是（選填）',exact:true});
  await expect(identity).toHaveValue('');await expect(identity.locator('option')).toHaveText(['不顯示','男','女','外星人','AI']);
  await expect(page.getByText('建議使用你在社群最常用的名字，方便夥伴認出你。',{exact:true})).toBeVisible();
  await name.fill('社群常用的測試名字');await identity.selectOption('alien');
  await page.getByRole('button',{name:'保存個人資料與公開範圍',exact:true}).click();
  await expect(page.locator('.account-panel .member-card')).toContainText('社群常用的測試名字');
  await expect(page.locator('.account-panel .member-card').getByLabel('自我介紹：外星人',{exact:true})).toBeVisible();
  await page.reload();await expect(name).toHaveValue('社群常用的測試名字');await expect(identity).toHaveValue('alien');
  await navigate(page,'工坊夥伴');await page.getByRole('searchbox',{name:'搜尋夥伴',exact:true}).fill('社群常用的測試名字');
  const row=page.getByRole('article',{name:'社群常用的測試名字',exact:true});await expect(row.getByLabel('自我介紹：外星人',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'登出',exact:true}).click();
  await page.getByLabel('電子郵件',{exact:true}).fill(email);await page.getByLabel('密碼',{exact:true}).fill(password);await page.getByRole('button',{name:'登入',exact:true}).click();
  await navigate(page, '我的名片');await expect(identity).toHaveValue('alien');await expect(name).toHaveValue('社群常用的測試名字');
  await page.setViewportSize({width:320,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/member-identity-phone.png',fullPage:true});
  await identity.selectOption('');await page.getByRole('button',{name:'保存個人資料與公開範圍',exact:true}).click();
  await expect(page.getByText('個人資料與每一項聯絡方式的可見範圍已保存。',{exact:true})).toBeVisible();
  await expect(page.locator('.member-card').getByLabel('自我介紹：外星人',{exact:true})).toHaveCount(0);
  await page.reload();await expect(identity).toHaveValue('');await expect(name).toHaveValue('社群常用的測試名字');
});
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
  await navigate(page, '我的名片');
  await expect(page.getByRole('heading',{name:'我的名片',level:1,exact:true})).toBeVisible();
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
  await navigate(page, '職業公會');await expect(page.locator('.primary-guild')).toHaveCount(1);
  await expect(page.locator('.primary-guild .guild-master .guild-leadership-name')).toHaveText('待任命');
  await expect(page.locator('.guild-card').first()).toHaveClass(/primary-guild/);
  const secondary=page.locator('.guild-card').filter({has:page.getByRole('button',{name:/^加入/})}).first();
  const secondaryName=await secondary.getByRole('heading').innerText();
  await secondary.getByRole('button',{name:/^加入/}).click();
  await expect(page.locator('.guild-card').nth(1).getByRole('heading')).toHaveText(secondaryName);
  await expect(page.locator('.guild-card').first()).toHaveClass(/primary-guild/);
  const firstLibrary=page.locator('.guild-card').first().locator('.guild-book-list');
  await expect(firstLibrary).toContainText('入門技能');
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
  await page.reload();await expect(page.locator('.primary-guild .guild-master .guild-leadership-name')).toHaveText('測試預定會長（待連結會員帳號）');
  await expect(page.locator('.guild-card:not(.primary-guild) .guild-master .guild-leadership-name').first()).toHaveText('測試正式會長');
  await page.unroute('**/api/v1/guilds/directory');


  await navigate(page, '工坊夥伴');await expect(page.getByRole('heading',{name:/工坊新夥伴/})).toBeVisible();
  await page.getByRole('button',{name:'登出',exact:true}).click();await page.getByLabel('電子郵件',{exact:true}).fill(email);await page.getByLabel('密碼',{exact:true}).fill(password);await page.getByRole('button',{name:'登入',exact:true}).click();
  await expect(page.locator('.shell')).toBeVisible();await navigate(page, '我的名片');await expect(page.getByLabel('Discord 帳號',{exact:true})).toHaveValue('new.member');
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
  await navigate(page, '我的名片');await expect(page.getByRole('heading',{name:'我的名片',level:1,exact:true})).toBeVisible();
  dimensions=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
});
test('member explicitly approves then revokes a scoped supplier client read connection',async({page})=>{
  await register(page,'客戶端連線夥伴');await completeOrientation(page);
  const start=await page.request.post('/api/v1/client-connections/start',{headers:{Origin:e2eOrigin()},data:{kind:'supplier',client_name:'我的供應端測試客戶端'}});expect(start.status()).toBe(201);
  const pending=await start.json();
  await navigate(page, '我的名片');await page.getByLabel('客戶端一次性代碼',{exact:true}).fill(pending.user_code);
  await page.getByRole('button',{name:'查看連線請求',exact:true}).click();await expect(page.getByText('你自己的商品與供貨條件',{exact:false})).toBeVisible();
  await page.getByRole('button',{name:'確認並允許這次讀取連線',exact:true}).click();await expect(page.getByText('讀取連線已核准，請回到你的客戶端繼續。')).toBeVisible();
  const poll=await page.request.post('/api/v1/client-connections/poll',{headers:{Origin:e2eOrigin()},data:{device_secret:pending.device_secret}});expect(poll.status()).toBe(200);
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
  const search=page.getByLabel('搜尋能力',{exact:true});
  const categoryOf=(choice:any)=>page.locator('.category-group').filter({has:page.locator('.tree-toggle strong',{hasText:choice.category})}).first();
  const groupOf=(choice:any)=>categoryOf(choice).locator('.tree-subcategory').filter({has:page.getByRole('button',{name:new RegExp(choice.group)})}).first();
  // Desktop starts with the same collapsed category list as phones instead of every chip.
  await page.setViewportSize({width:1440,height:900});
  await expect(page.locator('.capability-tree .category-group > .tree-toggle')).toHaveCount(definition.capability_categories.length);
  await expect(page.locator('.capability-tree .tree-toggle[aria-expanded=true]')).toHaveCount(0);
  await expect(page.getByLabel(choices[0].label,{exact:true})).toBeHidden();
  expect(await page.evaluate(()=>document.documentElement.scrollHeight)).toBeLessThan(4500);
  // Pointer expansion.
  await categoryOf(choices[0]).locator(':scope > .tree-toggle').click();await groupOf(choices[0]).locator('.tree-subtoggle').click();
  await page.getByLabel(choices[0].label,{exact:true}).check();
  // Keyboard expansion.
  const keyboardCategory=categoryOf(choices[1]).locator(':scope > .tree-toggle');
  await keyboardCategory.focus();await page.keyboard.press('Enter');await expect(keyboardCategory).toHaveAttribute('aria-expanded','true');
  const keyboardGroup=groupOf(choices[1]).locator('.tree-subtoggle');await keyboardGroup.focus();await page.keyboard.press('Space');await expect(keyboardGroup).toHaveAttribute('aria-expanded','true');
  await page.getByLabel(choices[1].label,{exact:true}).check();
  await expect(categoryOf(choices[1]).locator(':scope > .tree-toggle')).toContainText('1 /');
  // Search reveals matches in collapsed categories; clearing it restores exactly what the member opened.
  for(const choice of choices.slice(2)){await search.fill(choice.label);await page.getByLabel(choice.label,{exact:true}).check();}
  await search.fill('');
  await expect(page.getByLabel(choices[0].label,{exact:true})).toBeVisible();await expect(page.getByLabel(choices[1].label,{exact:true})).toBeVisible();
  for(const choice of choices.slice(2)){await expect(page.getByLabel(choice.label,{exact:true})).toBeHidden();await expect(page.getByLabel(choice.label,{exact:true})).toBeChecked();await expect(categoryOf(choice).locator(':scope > .tree-toggle')).toHaveAttribute('aria-expanded','false');}
  await expect(page.getByRole('status').filter({hasText:'已勾選 4 項能力'})).toBeVisible();
  await page.getByLabel('自訂能力',{exact:true}).fill('手工皮革製作');await page.getByRole('button',{name:'加入能力',exact:true}).click();
  await page.getByLabel(`精選能力：${choices[0].label}`,{exact:true}).check();
  await page.getByLabel(`精選能力：${choices[1].label}`,{exact:true}).check();
  await page.getByLabel('精選能力：手工皮革製作',{exact:true}).check();
  await expect(page.getByLabel(`精選能力：${choices[2].label}`,{exact:true})).toBeDisabled();
  // Resizing keeps choices, featured picks and the sections the member opened.
  await page.setViewportSize({width:390,height:844});
  await expect(page.getByLabel(choices[0].label,{exact:true})).toBeVisible();await expect(page.getByLabel(choices[0].label,{exact:true})).toBeChecked();
  await expect(page.getByLabel(choices[2].label,{exact:true})).toBeHidden();
  await search.fill(choices[2].label);
  await expect(page.getByLabel(choices[2].label,{exact:true})).toBeChecked();
  await search.fill('');
  await page.setViewportSize({width:1280,height:900});
  await expect(page.getByLabel(choices[1].label,{exact:true})).toBeVisible();
  for(const choice of choices)await expect(page.getByLabel(choice.label,{exact:true})).toBeChecked();
  for(const label of [choices[0].label,choices[1].label,'手工皮革製作'])await expect(page.getByLabel(`精選能力：${label}`,{exact:true})).toBeChecked();
  await page.getByRole('button',{name:'保存，繼續下一步 →',exact:true}).click();
  await expect(page.getByRole('heading',{name:'你的裝備庫'})).toBeVisible();
  await page.getByLabel('自訂裝備',{exact:true}).fill('我的錄音設備');await page.getByRole('button',{name:'加入裝備',exact:true}).click();
  await page.getByRole('button',{name:'上一步',exact:true}).click();
  for(const choice of choices)await expect(page.getByLabel(choice.label,{exact:true})).toBeChecked();
  for(const label of [choices[0].label,choices[1].label,'手工皮革製作'])await expect(page.getByLabel(`精選能力：${label}`,{exact:true})).toBeChecked();
  await page.getByRole('button',{name:'保存，繼續下一步 →',exact:true}).click();
  await expect(page.getByRole('button',{name:'移除裝備：我的錄音設備',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'看看適合我的公會',exact:true}).click();await finishGuild(page);
  await expect(page.locator('.member-featured .pill')).toHaveCount(3);
  await expect(page.locator('.member-featured')).toContainText('手工皮革製作');
  await expect(page.locator('.member-card')).not.toContainText('這是我的私人補充');
  await navigate(page, '我的名片');
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


test('completed positioning shows only the published result and never creates a second profile',async({page})=>{
  await register(page,'連貫定位夥伴');
  await completeOrientation(page);
  expect((await (await page.request.get('/api/v1/me/positioning')).json()).profile).toBeNull();
  const legacyRequests:string[]=[];
  page.on('request',request=>{if(new URL(request.url()).pathname==='/api/v1/me/positioning')legacyRequests.push(request.method());});
  await navigate(page, '我的定位');
  await expect(page.getByRole('heading',{name:'我的定位結果',exact:true})).toBeVisible();
  const result=page.locator('.positioning-result');
  await expect(result).toContainText('主要公會');
  await expect(page.getByRole('button',{name:'重新探索定位',exact:true})).toHaveCount(1);
  await expect(page.locator('.positioning-panel form')).toHaveCount(0);
  await expect(page.getByText(/合作偏好|想探索的職業方向|還沒有方向卡/)).toHaveCount(0);
  await expect(page.getByLabel('我現在想完成的事')).toHaveCount(0);
  await expect(page.getByLabel('搜尋職業方向')).toHaveCount(0);
  const resultBefore=await result.innerText();
  await page.reload();
  await expect(result).toHaveText(resultBefore,{useInnerText:true});
  await expect(page.locator('.positioning-panel form')).toHaveCount(0);
  expect(legacyRequests).toEqual([]);
  expect((await (await page.request.get('/api/v1/me/positioning')).json()).profile).toBeNull();
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/positioning-completed-phone.png',fullPage:true});
});

function publicPosition(member:any){
  return {positioning_title:member.positioning_title,primary_guild:member.primary_guild,secondary_guilds:member.secondary_guilds,joined_guilds:member.joined_guilds,
    capabilities:member.capabilities,custom_capabilities:member.custom_capabilities,featured_capabilities:member.featured_capabilities,
    equipment:member.equipment,custom_equipment:member.custom_equipment};
}

test('re-exploration preserves the confirmed profile until completion and keeps prior guilds and books',async({page})=>{
  test.setTimeout(120000);
  await register(page,'重新定位夥伴');
  await answerQuestions(page);
  await page.getByLabel('你的職業／目前身分',{exact:true}).fill('原本的私人職業');
  await page.getByLabel('自訂能力',{exact:true}).fill('原本的教學整理');
  await page.getByRole('button',{name:'加入能力',exact:true}).click();
  await page.getByLabel('精選能力：原本的教學整理',{exact:true}).check();
  await page.getByRole('button',{name:'保存，繼續下一步 →',exact:true}).click();
  await page.getByLabel('自訂裝備',{exact:true}).fill('原本的筆記本');
  await page.getByRole('button',{name:'加入裝備',exact:true}).click();
  await page.getByRole('button',{name:'看看適合我的公會',exact:true}).click();
  await finishGuild(page);
  const session=await (await page.request.get('/api/v1/session')).json();
  const memberPath=`/api/v1/members/${session.user.user_id}`;
  const initialDirectory=(await (await page.request.get('/api/v1/guilds/directory')).json()).items;
  const secondary=initialDirectory.find((guild:any)=>guild.membership?.state!=='active');
  const joined=await page.request.post(`/api/v1/guilds/${secondary.guild_key}/join`,{headers:{Origin:e2eOrigin(),'X-CSRF-Token':session.csrf_token,'Idempotency-Key':randomUUID()},data:{}});
  expect(joined.ok()).toBe(true);
  const before=await (await page.request.get(memberPath)).json();
  const beforeBooks=(await (await page.request.get('/api/v1/me/skill-books')).json()).items;
  const beforePreferences=await (await page.request.get('/api/v1/me/guild-preferences')).json();
  expect(beforePreferences.secondary_guild_keys).toEqual([]);
  expect(before.joined_guilds.map((guild:any)=>guild.guild_key)).toContain(secondary.guild_key);
  expect(before.primary_guild).not.toBeNull();
  expect(before.featured_capabilities).toEqual(['custom:原本的教學整理']);
  // Existing saved preferences remain server data; the removed form must never rewrite them.
  const legacy=await page.request.post('/api/v1/me/positioning',{headers:{Origin:e2eOrigin(),'X-CSRF-Token':session.csrf_token,'Idempotency-Key':randomUUID()},data:{real_world_occupations:['舊職業'],background:'保留舊資料',strengths:['舊專長'],goals:'保留舊合作目標',weekly_minutes:45,desired_roles:[],selected_tracks:[],confirmed:true}});
  expect(legacy.ok()).toBe(true);
  const legacyBefore=(await (await page.request.get('/api/v1/me/positioning')).json()).profile;
  await navigate(page, '我的定位');
  const result=page.locator('.positioning-result');
  await expect(result).toContainText('原本的教學整理');
  await expect(result).not.toContainText('保留舊合作目標');
  await expect(page.getByText(/合作偏好|想探索的職業方向/)).toHaveCount(0);
  await page.getByRole('button',{name:'重新探索定位',exact:true}).click();
  await expect(page.getByRole('main')).toHaveCount(1);await expect(page.getByRole('heading',{level:1})).toHaveCount(1);
  await expect(page.getByRole('heading',{name:'你喜歡怎麼做事？',exact:true})).toBeVisible();
  const definition=await (await page.request.get('/api/v1/assessment-definition')).json();
  await expect(page.locator('.quiz-question')).toHaveCount(definition.questions.filter((question:any)=>question.kind==='preference').length);
  await answerQuestions(page,true);
  await page.getByRole('button',{name:'移除能力：原本的教學整理',exact:true}).click();
  await page.getByLabel('自訂能力',{exact:true}).fill('新的研究整理');
  await page.getByRole('button',{name:'加入能力',exact:true}).click();
  await page.getByLabel('精選能力：新的研究整理',{exact:true}).check();
  await page.getByLabel('你的職業／目前身分',{exact:true}).fill('草稿裡的私人職業');
  await page.getByRole('button',{name:'保存，繼續下一步 →',exact:true}).click();
  await expect(page.getByRole('heading',{name:'你的裝備庫',exact:true})).toBeVisible();
  const draft=await (await page.request.get('/api/v1/me/onboarding')).json();
  expect(draft.state).toBe('draft');expect(draft.completed).toBe(true);expect(draft.required).toBe(false);
  expect(draft.draft.featured_capabilities).toEqual(['custom:新的研究整理']);
  expect(publicPosition(await (await page.request.get(memberPath)).json())).toEqual(publicPosition(before));
  await page.getByRole('button',{name:'返回我的定位',exact:true}).click();
  await expect(result).toContainText('原本的教學整理');
  await expect(result).not.toContainText('新的研究整理');
  await expect(result).toContainText(before.primary_guild.name);
  await page.reload();
  await expect(result).toContainText('原本的教學整理');
  await expect(result).not.toContainText('新的研究整理');
  expect(publicPosition(await (await page.request.get(memberPath)).json())).toEqual(publicPosition(before));
  expect((await (await page.request.get('/api/v1/me/skill-books')).json()).items).toEqual(beforeBooks);
  await navigate(page, '我的名片');
  await expect(page.locator('.member-featured')).toContainText('原本的教學整理');
  await expect(page.locator('.member-card')).not.toContainText('草稿裡的私人職業');
  await navigate(page, '我的定位');
  await page.getByRole('button',{name:'重新探索定位',exact:true}).click();
  await expect(page.getByRole('main')).toHaveCount(1);await expect(page.getByRole('heading',{level:1})).toHaveCount(1);
  await answerQuestions(page,true);
  await expect(page.getByLabel('精選能力：新的研究整理',{exact:true})).toBeChecked();
  await expect(page.getByLabel('你的職業／目前身分',{exact:true})).toHaveValue('草稿裡的私人職業');
  await page.getByRole('button',{name:'保存，繼續下一步 →',exact:true}).click();
  await page.getByRole('button',{name:'移除裝備：原本的筆記本',exact:true}).click();
  await page.getByLabel('自訂裝備',{exact:true}).fill('新的錄音設備');
  await page.getByRole('button',{name:'加入裝備',exact:true}).click();
  await page.getByRole('button',{name:'看看適合我的公會',exact:true}).click();
  await expect(page.locator('.recommendation-card').first()).toBeVisible();
  const evaluated=await (await page.request.get('/api/v1/me/onboarding')).json();
  const previousGuilds=[before.primary_guild,...before.secondary_guilds,...before.joined_guilds];
  await page.locator('.other-guild-choices > summary').click();
  for(const guild of previousGuilds){
    const recommended=evaluated.result.recommendations.some((candidate:any)=>candidate.guild_key===guild.guild_key);
    const checkbox=recommended?page.locator('.recommendation-card').filter({has:page.getByRole('heading',{name:guild.name,exact:true})}).getByRole('checkbox'):page.locator('.other-guild-choices').getByRole('checkbox',{name:guild.name,exact:true});
    await expect(checkbox).toBeChecked();
  }
  const originalMain=evaluated.result.recommendations.some((guild:any)=>guild.guild_key===before.primary_guild.guild_key)
    ?page.locator('.recommendation-card').filter({has:page.getByRole('heading',{name:before.primary_guild.name,exact:true})}).getByRole('radio')
    :page.getByRole('radio',{name:`以${before.primary_guild.name}作為主要公會`,exact:true});
  await expect(originalMain).toBeChecked();
  const chosen=evaluated.result.recommendations.find((guild:any)=>!previousGuilds.some(previous=>previous.guild_key===guild.guild_key));
  expect(chosen).toBeTruthy();
  expect(publicPosition(await (await page.request.get(memberPath)).json())).toEqual(publicPosition(before));
  const recommendation=page.locator('.recommendation-card').filter({has:page.getByRole('heading',{name:chosen.name,exact:true})});
  await recommendation.getByRole('checkbox').check();
  await recommendation.getByRole('radio').check();
  await page.getByRole('button',{name:'確認加入公會，領取技能書',exact:true}).click();
  await expect(page.getByRole('heading',{name:'你的第一段旅程，現在開始。',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'進入自由工坊 →',exact:true}).click();
  await expect(page.getByRole('heading',{name:'我的定位結果',exact:true})).toBeVisible();
  await expect(result).toContainText('新的研究整理');
  await expect(result).not.toContainText('原本的教學整理');
  await expect(result).toContainText(chosen.name);
  const after=await (await page.request.get(memberPath)).json();
  expect(after.positioning_title).toBe(chosen.title);
  expect(after.primary_guild.guild_key).toBe(chosen.guild_key);
  const afterPreferences=await (await page.request.get('/api/v1/me/guild-preferences')).json();
  expect(after.secondary_guilds.length).toBeLessThanOrEqual(2);
  expect(after.secondary_guilds.map((guild:any)=>guild.guild_key)).toEqual(afterPreferences.secondary_guild_keys);
  // Re-exploration preserves an explicit empty secondary selection; changing
  // primary guild does not silently promote prior memberships into that list.
  expect(afterPreferences.secondary_guild_keys).toEqual(beforePreferences.secondary_guild_keys);
  expect(after.joined_guilds.map((guild:any)=>guild.guild_key)).toContain(before.primary_guild.guild_key);
  expect([...after.secondary_guilds,...after.joined_guilds].map((guild:any)=>guild.guild_key).sort()).toEqual(previousGuilds.map(guild=>guild.guild_key).sort());
  expect(after.custom_capabilities).toEqual(['新的研究整理']);
  expect(after.featured_capabilities).toEqual(['custom:新的研究整理']);
  expect(after.custom_equipment).toEqual(['新的錄音設備']);
  const directory=(await (await page.request.get('/api/v1/guilds/directory')).json()).items;
  for(const previous of previousGuilds)expect(directory.find((guild:any)=>guild.guild_key===previous.guild_key).membership.state).toBe('active');
  expect(directory.find((guild:any)=>guild.guild_key===chosen.guild_key).membership.state).toBe('active');
  const afterBooks=(await (await page.request.get('/api/v1/me/skill-books')).json()).items;
  expect(afterBooks.map((book:any)=>book.book_id)).toEqual(expect.arrayContaining(beforeBooks.map((book:any)=>book.book_id)));
  expect(afterBooks.some((book:any)=>book.guild_keys.includes(chosen.guild_key))).toBe(true);
  expect((await (await page.request.get('/api/v1/me/positioning')).json()).profile).toEqual(legacyBefore);
  await page.reload();
  await expect(result).toContainText('新的研究整理');
  expect(publicPosition(await (await page.request.get(memberPath)).json())).toEqual(publicPosition(after));
});

for(const width of [1280,320])test(`missing primary guild has an actionable hint and can be selected beside confirmation at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});
  await register(page,'主要公會提示測試');await answerQuestions(page);
  await page.getByRole('button',{name:'保存，繼續下一步 →',exact:true}).click();
  await page.getByRole('button',{name:'看看適合我的公會',exact:true}).click();
  await expect(page.locator('.recommendation-card').first()).toBeVisible();
  // Members returning to an evaluated draft must see the same way out of the gate.
  await page.reload();await expect(page.locator('.recommendation-card').first()).toBeVisible();
  const view=await (await page.request.get('/api/v1/me/onboarding')).json(),[first,second]=view.result.recommendations;
  const card=(name:string)=>page.locator('.recommendation-card').filter({has:page.getByRole('heading',{name,exact:true})});
  const confirmation=page.locator('.onboarding-confirmation'),hint=confirmation.getByRole('status'),finish=confirmation.getByRole('button',{name:'確認加入公會，領取技能書',exact:true}),primary=confirmation.getByRole('combobox',{name:'主要公會（必選）',exact:true});
  const completionWrites:any[]=[];page.on('request',request=>{if(request.url().endsWith('/api/v1/me/onboarding/complete')&&request.method()==='POST')completionWrites.push(request.postDataJSON());});
  await expect(hint).toHaveText('請先勾選至少一個想加入的公會，再選擇主要公會。');await expect(finish).toBeDisabled();
  await confirmation.getByRole('button',{name:'前往選擇公會',exact:true}).click();await expect(card(first.name).getByRole('checkbox')).toBeFocused();
  await card(first.name).getByRole('checkbox').check();
  await expect(hint).toHaveText('還差一步：請選擇主要公會，才能完成定位。');await expect(primary).toHaveValue('');await expect(finish).toBeDisabled();
  await expect(primary).toHaveAccessibleDescription('還差一步：請選擇主要公會，才能完成定位。');
  await card(second.name).getByRole('checkbox').check();
  await card(first.name).getByRole('radio').check();await expect(primary).toHaveValue(first.guild_key);
  await card(first.name).getByRole('checkbox').uncheck();await expect(primary).toHaveValue('');await expect(hint).toContainText('還差一步');await expect(finish).toBeDisabled();
  await expect(primary.locator('option')).toHaveCount(2);expect(completionWrites).toHaveLength(0);
  let chosen=second;
  if(width===320){
    const directory=(await (await page.request.get('/api/v1/guilds/directory')).json()).items;
    chosen=directory.find((guild:any)=>!view.result.recommendations.some((candidate:any)=>candidate.guild_key===guild.guild_key));
    await page.locator('.other-guild-choices > summary').click();await page.locator('.other-guild-choices').getByRole('checkbox',{name:chosen.name,exact:true}).check();
    await page.locator('.other-guild-choices > summary').click();
    await expect(primary.locator('option')).toHaveCount(3);
  }
  await primary.scrollIntoViewIfNeeded();await page.screenshot({path:`test-results/primary-guild-hint-${width}.png`});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(await primary.evaluate(element=>parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
  expect((await primary.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await primary.selectOption(chosen.guild_key);await expect(primary).toHaveValue(chosen.guild_key);await expect(hint).toBeHidden();await expect(finish).toBeEnabled();
  if(width===1280)await expect(card(second.name).getByRole('radio')).toBeChecked();
  await finish.click();await expect(page.getByRole('heading',{name:'你的第一段旅程，現在開始。',exact:true})).toBeVisible();
  expect(completionWrites).toHaveLength(1);expect(completionWrites[0].primary_guild_key).toBe(chosen.guild_key);expect(completionWrites[0].guild_keys).not.toContain(first.guild_key);
  const saved=await (await page.request.get('/api/v1/me/onboarding')).json();expect(saved.completed).toBe(true);expect(saved.primary_guild_key).toBe(chosen.guild_key);
  await page.getByRole('button',{name:'進入自由工坊 →',exact:true}).click();await expect(page.getByRole('heading',{name:'會員首頁',exact:true})).toBeVisible();
});
