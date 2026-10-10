import {test,expect} from './member-feature-fixture.js';
import {sampleGuildAnswers} from '../../modules/positioning/guild-questions.js';
import {closeChat,openHomeGuide,signOut} from './navigation.js';

const password='freedom-workshop-member-2026';
test.describe('enabled first participation',()=>{
  test.use({memberFeatures:{personalContentEnabled:true,firstParticipationEnabled:true}});
test('optional guidance persists suppression, unfinished choice and actual completion across exit and relogin',async({page})=>{
  const pageErrors:string[]=[];
  page.on('pageerror',error=>pageErrors.push(error.message));
  const email=`first-${crypto.randomUUID()}@example.test`,guild='guild_event_space';
  await page.goto('/');
  const registered=await page.request.post('/api/v1/auth/register',{headers:{Origin:new URL(page.url()).origin},data:{email,password,nickname:'合成新手'}});
  expect(registered.status()).toBe(201);
  const auth=await registered.json();
  const headers={Origin:new URL(page.url()).origin,'X-CSRF-Token':auth.csrf_token,'Idempotency-Key':crypto.randomUUID()};
  const joined=await page.request.post('/api/v1/me/onboarding/quick-start',{headers,data:{guild_keys:[guild],primary_guild_key:guild,guild_answers:sampleGuildAnswers(guild),confirmed:true}});
  expect(joined.status()).toBe(200);
  await page.goto('/#home');await page.reload();await openHomeGuide(page);
  expect(pageErrors,'The built application must mount without runtime errors.').toEqual([]);
  const guide=page.locator('.first-participation');
  await expect(guide.getByText('第一次參與 · 選填',{exact:true})).toBeVisible();
  await guide.getByRole('button',{name:'略過',exact:true}).focus();
  await page.keyboard.press('Enter');
  await expect(guide).toContainText('已略過第一次參與。');
  await page.reload();await openHomeGuide(page);await expect(guide).toContainText('已略過第一次參與。');
  await guide.getByRole('button',{name:'重新啟用參與引導',exact:true}).click();
  await guide.getByRole('button',{name:/選擇在.*介紹自己/}).click();
  await expect(page.getByRole('region',{name:'我的訊息',exact:true})).toBeVisible();
  await expect(page).toHaveURL(/#home/);
  await closeChat(page);
  await expect(page.getByRole('region',{name:'我的訊息',exact:true})).toBeHidden();
  await expect(guide).toContainText('尚未確認實際發布');
  await signOut(page);
  await page.getByLabel('電子郵件',{exact:true}).fill(email);await page.getByLabel('密碼',{exact:true}).fill(password);
  await page.getByRole('button',{name:'登入',exact:true}).click();
  await openHomeGuide(page);
  await expect(guide).toContainText('尚未確認實際發布');
  const session=await (await page.request.get('/api/v1/session')).json();
  const sent=await page.request.post(`/api/v1/me/channels/guild/${guild}/messages`,{headers:{Origin:new URL(page.url()).origin,'X-CSRF-Token':session.csrf_token,'Idempotency-Key':crypto.randomUUID()},data:{body:'合成本人實際介紹'}});
  expect(sent.status()).toBe(201);
  await guide.getByRole('button',{name:'重新讀取進度',exact:true}).click();
  await expect(guide).toContainText('已確認實際公會訊息送出');
  await guide.getByRole('button',{name:'不再提示',exact:true}).click();
  await page.reload();await openHomeGuide(page);await expect(guide).toContainText('已停止提示。');
  for(const width of [320,390]){
    await page.setViewportSize({width,height:844});
    await openHomeGuide(page);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await expect(guide.getByRole('button',{name:'重新啟用參與引導',exact:true})).toBeVisible();
  }
  expect(pageErrors).toEqual([]);
});

});
test.describe('default-off first participation',()=>{
  test.use({memberFeatures:{}});
test('default-off guidance stays absent and its API fails closed before authentication',async({page})=>{
  await page.goto('/');
  const site=await (await page.request.get('/api/v1/site')).json();
  expect(site.first_participation_enabled).toBe(false);
  expect((await page.request.get('/api/v1/me/first-participation')).status()).toBe(404);
  await expect(page.locator('.first-participation')).toHaveCount(0);
});

});
