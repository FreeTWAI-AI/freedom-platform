import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {test,expect,type Page} from './fixtures.js';
import {navigate,signOut} from './navigation.js';
import {DEMO_COMMUNITY,DEMO_USERS} from '../../packages/testing/seed.js';

test.use({timezoneId:'America/New_York'});
async function login(page:Page,email='maker@local.test'){
  await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill(email);
  await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');
  await page.getByRole('button',{name:'登入',exact:true}).click();
  await expect(page.getByRole('button',{name:'設定',exact:true})).toBeVisible();
}
async function logout(page:Page){
  // Public event pages remain readable after logout; use the member shell to verify the login transition.
  await page.goto('/');
  const response=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/v1/auth/logout');
  await signOut(page);const result=await response;expect(result.status()).toBe(200);await result.finished();
}

test('member previews an event, an authorized officer approves it, and participants can return and cancel',async({page,context,browser,e2eAuthPool})=>{
  // Synthetic preassigned reviewer. Every event, publication, share and RSVP
  // transition below uses the member UI and the real domain API.
  await e2eAuthPool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state)
    VALUES($1,$2,$3,'guild_member_operations','active') ON CONFLICT(community_id,user_id,guild_key) DO UPDATE SET state='active'`,[randomUUID(),DEMO_COMMUNITY,DEMO_USERS[1].user_id]);
  await e2eAuthPool.query(`INSERT INTO positioning_guild_officers(community_id,guild_key,user_id)
    VALUES($1,'guild_member_operations',$2) ON CONFLICT DO NOTHING`,[DEMO_COMMUNITY,DEMO_USERS[1].user_id]);
  await context.grantPermissions(['clipboard-read','clipboard-write']);
  await page.setViewportSize({width:390,height:844});await login(page);await navigate(page,'社群活動');
  await page.getByRole('button',{name:'＋ 提交活動',exact:true}).click();
  const title='合成活動：共同整理開源工具',form=page.locator('form').filter({has:page.getByRole('heading',{name:'提交活動',exact:true})});
  let writes=0;page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname==='/api/v1/events')writes++;});
  await form.getByLabel('活動名稱',{exact:true}).fill(title);
  await form.getByLabel('活動說明',{exact:true}).fill('這是合成內容；一起用範例資料整理工具，沒有付款或真實招募。');
  await form.getByLabel('線上場地',{exact:true}).fill('合成線上工作室');
  await form.getByLabel('線上參與連結',{exact:true}).fill('https://example.com/synthetic-event');
  await form.getByRole('combobox',{name:/^參與範圍/}).selectOption('open');
  await expect(form).toContainText('America/New_York');
  const start=await form.getByLabel('開始時間',{exact:true}).inputValue();
  const expectedIso=await page.evaluate(value=>new Date(value).toISOString(),start);
  const photo=await sharp({create:{width:700,height:1050,channels:3,background:'#366177'}}).png().toBuffer();
  await form.getByLabel('活動海報（選填）').setInputFiles({name:'synthetic-event.png',mimeType:'image/png',buffer:photo});
  await expect(form.getByRole('button',{name:'送出審核',exact:true})).toBeEnabled();
  await form.getByText('送出前預覽活動',{exact:true}).click();
  const preview=form.getByRole('region',{name:'活動送審預覽',exact:true});
  await expect(preview).toContainText(title);await expect(preview).toContainText('活動頁公開，所有人可查看及報名');
  await expect(preview.getByRole('img',{name:'活動海報預覽',exact:true})).toBeVisible();
  expect(writes).toBe(0);
  for(const theme of ['light','dark','versefolk']){
    await page.evaluate(value=>{localStorage.setItem('freedom-theme',value);document.documentElement.dataset.theme=value;window.dispatchEvent(new Event('freedom-theme-changed'));},theme);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`test-results/event-member-journey/preview-${theme}-390.png`,fullPage:true});
  }
  const creating=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/v1/events');
  await form.getByRole('button',{name:'送出審核',exact:true}).click();
  const created=await creating;expect(created.status()).toBe(201);const event=await created.json();
  expect(event.starts_at).toBe(expectedIso);expect(event.state).toBe('pending');
  let card=page.locator('.experience-card').filter({has:page.getByRole('heading',{name:title,exact:true})});
  await expect(card).toContainText('待審核');await expect(card.locator('.experience-banner-image')).toBeVisible();
  await logout(page);await login(page,'reviewer@local.test');await navigate(page,'社群活動');
  card=page.locator('.experience-card').filter({has:page.getByRole('heading',{name:title,exact:true})});
  await card.getByRole('button',{name:'審核活動',exact:true}).click();
  await card.getByLabel('審核理由',{exact:true}).fill('合成驗收：介紹、時間及公開範圍已核對。');
  await card.getByRole('button',{name:'核准並公告',exact:true}).click();await expect(card).toContainText('開放報名');
  await card.getByRole('button',{name:'分享活動',exact:true}).click();
  await expect(page.getByText('活動專頁連結已複製，分享碼已包含在連結中。',{exact:true})).toBeVisible();
  const shared=await page.evaluate(()=>navigator.clipboard.readText());
  expect(new URL(shared).origin).toBe(new URL(page.url()).origin);
  const guest=await browser.newContext({timezoneId:'Asia/Taipei'});
  try{const publicPage=await guest.newPage();await publicPage.goto(shared);await expect(publicPage.getByRole('heading',{name:title,exact:true})).toBeVisible();}
  finally{await guest.close();}
  await logout(page);await login(page,'client@local.test');await page.goto(shared);
  await page.getByRole('button',{name:'我要參加',exact:true}).click();await expect(page.getByRole('button',{name:'取消報名',exact:true})).toBeVisible();
  await page.reload();await page.getByRole('button',{name:'取消報名',exact:true}).click();await expect(page.getByRole('button',{name:'我要參加',exact:true})).toBeVisible();
  await logout(page);await login(page);await navigate(page,'我的內容');
  const own=page.getByRole('article').filter({has:page.getByRole('heading',{name:title,exact:true})});
  await own.getByRole('link',{name:'查看',exact:true}).click();await expect(page.getByRole('region',{name:'活動專頁',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'報名名單',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();await page.getByRole('dialog').getByRole('button',{name:'關閉',exact:true}).click();
  await page.getByRole('button',{name:'取消活動',exact:true}).click();await expect(page.getByRole('region',{name:'活動專頁',exact:true})).toContainText('已取消');
});

for(const width of [1440,390])test(`unsaved event input survives rejected navigation and explicit discard at ${width}px`,async({page},info)=>{
  await page.setViewportSize({width,height:844});await login(page);await navigate(page,'社群活動');
  let discard=false;const prompts:string[]=[];let writes=0;
  page.on('dialog',async dialog=>{prompts.push(dialog.message());await(discard?dialog.accept():dialog.dismiss());});
  page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/v1/events')writes++;});
  await page.getByRole('button',{name:'＋ 提交活動',exact:true}).click();
  // An untouched form has no work to discard.
  await navigate(page,'我的內容');expect(prompts).toEqual([]);await navigate(page,'社群活動');
  await page.getByRole('button',{name:'＋ 提交活動',exact:true}).click();
  const form=page.locator('form').filter({has:page.getByRole('heading',{name:'提交活動',exact:true})});
  await form.getByLabel('活動名稱',{exact:true}).fill('尚未送出的活動草稿');
  await form.getByLabel('活動說明',{exact:true}).fill('切換頁面、返回與關閉編輯都不能默默丟掉這段文字。');
  await form.getByLabel('開始時間',{exact:true}).fill('2030-06-10T14:30');
  await navigate(page,'我的內容');await expect(page).toHaveURL(/#events$/);expect(prompts).toHaveLength(1);
  const closeMenu=page.getByRole('button',{name:'關閉選單',exact:true});if(await closeMenu.isVisible())await closeMenu.click();
  await expect(form.getByLabel('活動名稱',{exact:true})).toHaveValue('尚未送出的活動草稿');
  await page.goBack();await expect.poll(()=>prompts.length).toBe(2);await expect(page).toHaveURL(/#events$/);
  await page.evaluate(()=>{window.location.hash='events/00000000-0000-4000-8000-000000000001';});
  await expect.poll(()=>prompts.length).toBe(3);await expect(page).toHaveURL(/#events$/);
  await expect(form.getByLabel('開始時間',{exact:true})).toHaveValue('2030-06-10T14:30');
  await form.getByRole('button',{name:'返回',exact:true}).click();expect(prompts).toHaveLength(4);
  await expect(form.getByRole('textbox',{name:'活動說明',exact:true})).toHaveValue('切換頁面、返回與關閉編輯都不能默默丟掉這段文字。');
  expect(await page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;})).toBe(true);
  await page.screenshot({path:info.outputPath(`event-draft-retained-${width}.png`),fullPage:true});
  discard=true;await navigate(page,'我的內容');await expect(page).toHaveURL(/#my-content$/);
  await navigate(page,'社群活動');await page.getByRole('button',{name:'＋ 提交活動',exact:true}).click();
  await expect(form.getByLabel('活動名稱',{exact:true})).toHaveValue('');expect(writes).toBe(0);
});

test('event submission blocks departure while pending and saved edits require explicit discard',async({page})=>{
  await login(page);await navigate(page,'社群活動');await page.getByRole('button',{name:'＋ 提交活動',exact:true}).click();
  const title='離開保護 '+randomUUID().slice(0,8),form=page.locator('form').filter({has:page.getByRole('heading',{name:'提交活動',exact:true})});
  await form.getByLabel('活動名稱',{exact:true}).fill(title);await form.getByLabel('活動說明',{exact:true}).fill('隔離資料，驗證送出與返回編輯。');await form.getByLabel('線上場地',{exact:true}).fill('合成場地');
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});let reached=false,writes=0;
  const createdResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/v1/events');
  await page.route('**/api/v1/events',async route=>{if(route.request().method()!=='POST')return route.continue();reached=true;writes++;await held;await route.continue();});
  try{
    await form.getByRole('button',{name:'送出審核',exact:true}).click();await expect.poll(()=>reached).toBe(true);
    await navigate(page,'我的內容');await expect(page).toHaveURL(/#events$/);await expect(page.getByRole('status').filter({hasText:'正在處理活動'})).toBeVisible();
  }finally{release();}
  await expect(page.getByText('活動已送出審核，核准後開放報名。',{exact:true})).toBeVisible();expect(writes).toBe(1);
  const createdEvent=await(await createdResponse).json();
  await navigate(page,'我的內容');await expect(page).toHaveURL(/#my-content$/);await navigate(page,'社群活動');
  const card=page.locator('.experience-card').filter({has:page.getByRole('heading',{name:title,exact:true})});
  await card.getByRole('button',{name:'編輯草稿',exact:true}).click();
  let discard=false;let prompts=0;page.on('dialog',async dialog=>{prompts++;await(discard?dialog.accept():dialog.dismiss());});
  // Opening a saved draft alone does not make it dirty.
  await card.getByRole('button',{name:'返回',exact:true}).click();expect(prompts).toBe(0);
  await card.getByRole('button',{name:'編輯草稿',exact:true}).click();await card.getByLabel('活動名稱',{exact:true}).fill(title+' 修改中');
  await page.getByRole('button',{name:'＋ 提交活動',exact:true}).click();expect(prompts).toBe(1);await expect(card.getByLabel('活動名稱',{exact:true})).toHaveValue(title+' 修改中');
  await navigate(page,'我的內容');await expect(page).toHaveURL(/#events$/);expect(prompts).toBe(2);
  discard=true;await card.getByRole('button',{name:'返回',exact:true}).click();await expect(card.getByLabel('活動名稱',{exact:true})).toHaveCount(0);
  await card.getByRole('button',{name:'編輯草稿',exact:true}).click();await expect(card.getByLabel('活動名稱',{exact:true})).toHaveValue(title);expect(writes).toBe(1);
  await page.goto(`/events/${createdEvent.event_id}`);await card.getByRole('button',{name:'編輯草稿',exact:true}).click();
  await card.getByLabel('活動名稱',{exact:true}).fill(title+' 專頁修改');discard=false;
  await page.getByRole('button',{name:'返回活動列表與行事曆',exact:true}).click();
  await expect(page).toHaveURL(new RegExp(`/events/${createdEvent.event_id}$`));await expect(card.getByLabel('活動名稱',{exact:true})).toHaveValue(title+' 專頁修改');
  discard=true;await page.getByRole('button',{name:'返回活動列表與行事曆',exact:true}).click();await expect(page).toHaveURL(/\/#events$/);
});

test('an unknown event submission keeps its original retry key and cannot be abandoned',async({page,e2eAuthPool})=>{
  await login(page);await navigate(page,'社群活動');await page.getByRole('button',{name:'＋ 提交活動',exact:true}).click();
  const title='不明結果 '+randomUUID().slice(0,8),form=page.locator('form').filter({has:page.getByRole('heading',{name:'提交活動',exact:true})});
  await form.getByLabel('活動名稱',{exact:true}).fill(title);await form.getByLabel('活動說明',{exact:true}).fill('合成案例，原請求已完成但回應遺失。');await form.getByLabel('線上場地',{exact:true}).fill('合成場地');
  const attempts:{body:string|null;key:string|undefined}[]=[];
  await page.route('**/api/v1/events',async route=>{
    if(route.request().method()!=='POST')return route.continue();
    attempts.push({body:route.request().postData(),key:route.request().headers()['idempotency-key']});
    if(attempts.length===1){const response=await route.fetch();expect(response.status()).toBe(201);await route.abort('failed');}
    else await route.continue();
  });
  await form.getByRole('button',{name:'送出審核',exact:true}).click();await expect(page.getByRole('alert')).toBeVisible();
  let prompts=0;page.on('dialog',async dialog=>{prompts++;await dialog.accept();});
  await navigate(page,'我的內容');await expect(page).toHaveURL(/#events$/);expect(prompts).toBe(0);
  await expect(page.getByRole('status').filter({hasText:'尚未確認原操作的結果'})).toBeVisible();
  await form.getByRole('button',{name:'返回',exact:true}).click();await expect(form).toBeVisible();
  await form.getByRole('button',{name:'送出審核',exact:true}).click();await expect(page.getByText('活動已送出審核，核准後開放報名。',{exact:true})).toBeVisible();
  expect(attempts).toHaveLength(2);expect(attempts[0].key).toBeTruthy();expect(attempts[1]).toEqual(attempts[0]);
  expect(Number((await e2eAuthPool.query('SELECT count(*) FROM community_events WHERE title=$1',[title])).rows[0].count)).toBe(1);
  await navigate(page,'我的內容');await expect(page).toHaveURL(/#my-content$/);expect(prompts).toBe(0);
});
