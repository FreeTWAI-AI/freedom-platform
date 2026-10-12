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
  await form.getByLabel('參與範圍',{exact:true}).selectOption('open');
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
