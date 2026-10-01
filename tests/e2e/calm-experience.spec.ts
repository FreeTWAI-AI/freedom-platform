import {randomUUID} from 'node:crypto';
import {test,expect,type Page} from './fixtures.js';
import {DEMO_USERS,DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {navigate} from './navigation.js';

async function login(page:Page,email='maker@local.test'){
  await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill(email);await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.getByRole('heading',{name:'會員首頁',level:1})).toBeVisible();
}
test('anonymous visitors can preview a real free resource before creating an account',async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.goto('/');await page.getByText('先看免費資源，不用註冊',{exact:true}).click();
  await expect(page.locator('.entry-resource-list article')).toHaveCount(3);await page.locator('.entry-resource-list').getByRole('button',{name:'免費預覽',exact:true}).first().click();await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('synthetic entry budget: two required fields and one guild choice reach useful next steps in under 30 seconds',async({page})=>{
  await page.setViewportSize({width:320,height:720});await page.goto('/');const start=Date.now();await page.getByRole('button',{name:'建立帳號',exact:true}).click();
  await expect(page.locator('.login-card input[required]')).toHaveCount(2);await expect(page.getByLabel('社群顯示名稱',{exact:true})).not.toHaveAttribute('required','');
  const email=`ux-${randomUUID().slice(0,8)}@example.test`;
  await page.getByLabel('電子郵件',{exact:true}).pressSequentially(email,{delay:100});await page.getByLabel('密碼',{exact:true}).pressSequentially('freedom-entry-2026',{delay:100});
  await page.getByRole('button',{name:'建立帳號，先逛工坊',exact:true}).click();await expect(page.locator('.welcome-optional')).not.toHaveAttribute('open','');
  await page.getByLabel('找感興趣的公會').fill('AI 開發公會');await page.locator('.quick-start input[value="guild_ai_vibe"]').check();await page.getByRole('button',{name:'加入公會，開始參與',exact:true}).click();
  await expect(page.getByRole('heading',{name:'會員首頁',level:1})).toBeVisible();await expect(page.getByRole('button',{name:'閱讀第一本技能書',exact:true})).toBeVisible();
  const milliseconds=Date.now()-start;expect(milliseconds).toBeLessThan(30000);await test.info().attach('synthetic-entry-budget',{body:JSON.stringify({milliseconds,typing_delay_ms:100,email_length:email.length,password_length:'freedom-entry-2026'.length,scope:'local isolated schema; excludes human reading and thinking'}),contentType:'application/json'});
  await expect(page.locator('.home-member-name')).toContainText('新夥伴');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/calm-home-320.png',fullPage:true});
  await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'test-results/calm-home-1440.png',fullPage:true});await page.setViewportSize({width:320,height:720});
  await page.getByRole('button',{name:'進入AI 開發公會聊天室',exact:true}).click();await expect(page.getByRole('heading',{name:'AI 開發公會・公會閒聊',exact:true})).toBeVisible();await expect(page.getByRole('textbox',{name:'在 AI 開發公會 發言'})).toBeVisible();
});
test('feature search finds chat and selling functions, and all themes work at 320 pixels',async({page})=>{
  await login(page);const search=page.getByLabel('搜尋功能');await search.fill('聊天室');await page.getByRole('navigation',{name:'主要工作區'}).getByRole('button',{name:'我的訊息',exact:true}).click();await expect(page.getByRole('heading',{name:'我的訊息',level:1})).toBeVisible();
  await search.fill('電商');await page.getByRole('navigation',{name:'主要工作區'}).getByRole('button',{name:'我可以賣東西',exact:true}).click();await expect(page.getByRole('heading',{name:'我可以賣東西',level:1})).toBeVisible();
  await navigate(page,'會員首頁');await page.setViewportSize({width:320,height:720});
  for(const [label,theme] of [['自由工坊－明亮','light'],['自由工坊－夜航','dark'],['自由工坊－敘生','versefolk']]){
    const settings=page.getByRole('button',{name:'設定',exact:true});if(await settings.getAttribute('aria-expanded')!=='true')await settings.click();await page.getByRole('menuitemradio',{name:label,exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-theme',theme);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
});
test('console reads exactly the selected guild, keeps room drafts and receives new messages without refreshing',async({page,browser,e2eAuthPool})=>{
  for(const user of DEMO_USERS.slice(0,2))for(const key of ['guild_ai_vibe','guild_marketing'])await e2eAuthPool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state) VALUES($1,$2,$3,$4,'active') ON CONFLICT(community_id,user_id,guild_key) DO UPDATE SET state='active'`,[randomUUID(),DEMO_COMMUNITY,user.user_id,key]);
  const peerContext=await browser.newContext({baseURL:new URL(test.info().project.use.baseURL as string).origin}),peer=await peerContext.newPage();
  try{
    await login(peer,DEMO_USERS[1].email);const session=await (await peer.request.get('/api/v1/session')).json();
    const send=async(key:string,body:string)=>{const result=await peer.request.post(`/api/v1/me/channels/guild/${key}/messages`,{headers:{Origin:new URL(peer.url()).origin,'X-CSRF-Token':session.csrf_token,'Idempotency-Key':randomUUID()},data:{body}});expect(result.status()).toBe(201)};
    await send('guild_ai_vibe','只屬於 AI 公會的對話');await send('guild_marketing','只屬於行銷公會的對話');
    const reads:string[]=[];page.on('request',request=>{if(request.method()==='GET'&&/\/api\/v1\/me\/(channels\/[^/]+\/[^/]+|conversations\/[^/]+)\/messages/.test(request.url()))reads.push(request.url())});
    await login(page);await page.getByRole('button',{name:'展開訊息控制台'}).click();const dock=page.getByRole('complementary',{name:'訊息控制台',exact:true});await expect(dock.getByRole('log')).not.toContainText('只屬於');expect(reads).toEqual([]);
    await dock.getByRole('tab',{name:/^公會聊天/}).click();await expect(dock.getByRole('button',{name:'AI 開發公會',exact:true})).toBeVisible();expect(reads).toEqual([]);
    await dock.getByRole('button',{name:'AI 開發公會',exact:true}).click();await expect(dock.getByRole('log')).toContainText('只屬於 AI 公會的對話');await expect(dock.getByRole('log')).not.toContainText('行銷公會的對話');expect(reads.every(url=>url.includes('/guild/guild_ai_vibe/messages'))).toBe(true);
    await dock.getByRole('textbox',{name:'在 AI 開發公會 發言'}).fill('AI 公會草稿');await dock.getByRole('button',{name:'成長與行銷公會',exact:true}).click();await expect(dock.getByRole('log')).toContainText('只屬於行銷公會的對話');await expect(dock.getByRole('log')).not.toContainText('AI 公會的對話');
    await dock.getByRole('textbox',{name:'在 成長與行銷公會 發言'}).fill('行銷公會草稿');await dock.getByRole('button',{name:'AI 開發公會',exact:true}).click();const draft=dock.getByRole('textbox',{name:'在 AI 開發公會 發言'});await expect(draft).toHaveValue('AI 公會草稿');await draft.press('End');await draft.press('Shift+Enter');await draft.pressSequentially('第二行');await draft.press('Enter');await expect(dock.getByRole('log')).toContainText('AI 公會草稿\n第二行');await expect(draft).toHaveValue('');
    await send('guild_ai_vibe','在選定頻道自動出現的新訊息');await page.bringToFront();await expect(dock.getByRole('log')).toContainText('在選定頻道自動出現的新訊息',{timeout:15000});
    await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await dock.screenshot({path:'test-results/calm-chat-390.png'});
    await dock.getByRole('tab',{name:'總頻道',exact:true}).click();await expect(dock.getByRole('log')).not.toContainText('只屬於');await expect(dock.getByRole('log')).not.toContainText('AI 公會草稿');
  }finally{await peerContext.close()}
});
