import {test,expect,type Page} from './fixtures.js';
import {randomUUID} from 'node:crypto';
import {navigate} from './navigation.js';
async function login(page:Page,email='maker@local.test'){await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill(email);await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.getByRole('button',{name:'登出',exact:true})).toBeVisible();}
async function platform(page:Page){await navigate(page,'一起開發');const entry=page.getByRole('complementary',{name:'這一頁的開發入口'});await entry.getByText('參與這一頁的開發',{exact:true}).click();await entry.getByRole('button',{name:'啟用這一頁的開發',exact:true}).click();return page.getByRole('dialog',{name:'開發啟用任務',exact:true});}

test('platform onboarding joins the actual required guild, preserves primary guild, stores versioned consent and leaves GitHub verification pending',async({page,e2eAuthPool})=>{
  const id=randomUUID(),email=`development-${id}@local.test`;
  await e2eAuthPool.query("INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) SELECT $1,community_id,$2,'Development browser fixture',password_hash,$3 FROM users WHERE email='maker@local.test'",[id,email,randomUUID()]);
  await login(page,email);const before=await (await page.request.get('/api/v1/me/guild-preferences')).json();
  const modal=await platform(page);
  await modal.getByRole('button',{name:'加入平台工程公會',exact:true}).click();
  await expect(modal.getByText('已有開發資格。離開最後一個適用公會時，相關授權與憑證會撤銷。',{exact:true})).toBeVisible();
  await modal.getByRole('checkbox').check();await modal.getByRole('button',{name:'同意並保存',exact:true}).click();
  await expect(modal.getByRole('button',{name:'撤回開發同意',exact:true})).toBeVisible();
  await expect(modal.getByRole('button',{name:'驗證 Repo 並啟用開發',exact:true})).toBeDisabled();
  const current=await (await page.request.get('/api/v1/me/development/platform/cocreation')).json();expect(current.eligible).toBe(true);expect(current.consent).toBe(true);expect(current.enabled).toBe(false);
  const preferences=await (await page.request.get('/api/v1/me/guild-preferences')).json();
  expect(preferences.primary_guild_key).toBe(before.primary_guild_key);expect(preferences.aggregate_version).toBe(before.aggregate_version);
  await page.setViewportSize({width:320,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/development-access-mobile.png',fullPage:true});
  await page.keyboard.press('Escape');await expect(modal).not.toBeVisible();await expect(page.getByRole('button',{name:'啟用這一頁的開發',exact:true})).toBeFocused();
  await e2eAuthPool.query('UPDATE users SET active=false WHERE user_id=$1',[id]);
});

test('skill development offers either AI guild and nested Escape returns to the original book',async({page})=>{
 await page.route('**/api/v1/me/development/skill/video-autopilot',route=>route.fulfill({json:{...readyView(),capability:'skill',eligible:false,enabled:false,guilds:[{guild_key:'guild_ai_vibe',name:'AI 開發公會',state:null},{guild_key:'guild_ai_field',name:'AI 導入與驗證公會',state:null}]}}));
 await login(page);await navigate(page,'技能書架');await page.getByRole('button',{name:'未解鎖',exact:true}).click();
 const library=page.locator('.community-library');await library.getByLabel('搜尋技能書',{exact:true}).fill('剪輯');
 const card=library.locator('article[data-book-id="video-autopilot"]');await card.getByRole('button',{name:'預覽技能書',exact:true}).click();
 const book=page.getByRole('dialog').filter({has:page.getByRole('button',{name:'開發這本技能書',exact:true})});
 await book.getByRole('button',{name:'開發這本技能書',exact:true}).click();const modal=page.getByRole('dialog',{name:'開發啟用任務',exact:true});
 await expect(modal.getByText('加入 AI 開發公會或 AI 導入與驗證公會其中一個，即可接續設定。保留你目前的主力公會。',{exact:true})).toBeVisible();
 await expect(modal.getByRole('button',{name:/^加入AI/})).toHaveCount(2);
 await page.keyboard.press('Escape');await expect(modal).not.toBeVisible();await expect(book).toBeVisible();await expect(book.getByRole('button',{name:'開發這本技能書',exact:true})).toBeFocused();
});

const keyId='d0000000-0000-4000-8000-000000000001',secret='fpd_'+'a'.repeat(43);
function readyView(){return {capability:'platform',target:{key:'cocreation',title:'一起開發',repository:'FreeTWAI-AI/freedom-platform',guide_url:'/development/cocreation/SKILL.md'},eligible:true,
 guilds:[{guild_key:'guild_platform_engineering',name:'平台工程公會',state:'active',aggregate_version:1}],github:{id:'42',login:'contributor'},app:{configured:true,installation_url:'https://github.com/apps/synthetic-app/installations/new'},policy_version:'development-proposal-v1',consent:true,enabled:true,
 grant:{grant_id:keyId,working_repository:'contributor/freedom-platform',expires_at:new Date(Date.now()+3600000).toISOString(),revoked_at:null},keys:[],proposals:[]};}

test('private Agent instruction clears before dialog close, does not enter browser storage and cannot return from a late issuance',async({page,context})=>{
 await context.grantPermissions(['clipboard-read','clipboard-write']);
 await page.route('**/api/v1/me/development/platform/cocreation',route=>route.fulfill({json:readyView()}));
 let delayed=false,release:(()=>void)|undefined;
 await page.route('**/api/v1/me/development/platform/cocreation/keys',async route=>{if(delayed)await new Promise<void>(resolve=>{release=resolve;});await route.fulfill({json:{key_id:keyId,token:secret,expires_at:new Date(Date.now()+3600000).toISOString(),working_repository:'contributor/freedom-platform',target_repository:'FreeTWAI-AI/freedom-platform'}});});
 await login(page);const modal=await platform(page);await modal.getByRole('button',{name:'產生私人 Agent 指令',exact:true}).click();
 await expect(modal.getByLabel('私人開發指令',{exact:true})).toHaveValue(new RegExp(secret));
 await modal.getByRole('button',{name:'複製私人開發指令',exact:true}).click();expect(await page.evaluate(()=>navigator.clipboard.readText())).toContain(secret);
 expect(await page.evaluate(()=>JSON.stringify({...sessionStorage,...localStorage}))).not.toContain(secret);
 await page.keyboard.press('Escape');expect(await page.content()).not.toContain(secret);
 await page.getByRole('button',{name:'啟用這一頁的開發',exact:true}).click();await expect(modal.getByLabel('私人開發指令',{exact:true})).toHaveCount(0);
 delayed=true;await modal.getByRole('button',{name:'產生私人 Agent 指令',exact:true}).click();await expect.poll(()=>Boolean(release)).toBe(true);
 await page.keyboard.press('Escape');release!();await page.getByRole('button',{name:'啟用這一頁的開發',exact:true}).click();await expect(modal.getByRole('button',{name:'產生私人 Agent 指令',exact:true})).toBeEnabled();expect(await page.content()).not.toContain(secret);
});

test('a safe saved target resumes after reload without saving credentials or widening permissions',async({page})=>{
 await page.route('**/api/v1/me/development/platform/cocreation',route=>route.fulfill({json:readyView()}));
 await login(page);await platform(page);await page.reload();
 const modal=page.getByRole('dialog',{name:'開發啟用任務',exact:true});await expect(modal).toBeVisible();await expect(modal.getByText('一起開發',{exact:true})).toBeVisible();
 await expect(modal.getByLabel('私人開發指令',{exact:true})).toHaveCount(0);await modal.getByRole('button',{name:'關閉開發任務',exact:true}).click();
 await page.reload();await expect(modal).not.toBeVisible();
});
