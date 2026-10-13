import {openPageTools} from './navigation.js';
import {test,expect,type Page} from './fixtures.js';
import {randomUUID} from 'node:crypto';
import {navigate} from './navigation.js';
async function login(page:Page,email='maker@local.test'){await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill(email);await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.getByRole('button',{name:'設定',exact:true})).toBeVisible();}
async function platform(page:Page){await navigate(page,'一起開發');await openPageTools(page); await page.locator('.topbar').getByRole('button',{name:'參與編修'}).click();await page.getByRole('dialog',{name:/一起開發：參與編修/}).getByRole('button',{name:'啟用這一頁的開發',exact:true}).click();return page.getByRole('dialog',{name:'開發啟用任務',exact:true});}

test('platform onboarding joins the actual required guild, preserves primary guild, stores versioned consent and leaves GitHub verification pending',async({page,e2eAuthPool})=>{
  const id=randomUUID(),email=`development-${id}@local.test`;
  await e2eAuthPool.query("INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) SELECT $1,community_id,$2,'Development browser fixture',password_hash,$3 FROM users WHERE email='maker@local.test'",[id,email,randomUUID()]);
  await login(page,email);const before=await (await page.request.get('/api/v1/me/guild-preferences')).json();
  const modal=await platform(page);
  await modal.getByRole('button',{name:'加入平台工程公會',exact:true}).click();
  await expect(modal.getByText('實習成員可以閱讀公會內容、在公會聊天室聊天；請會長把你設為正式成員後再發布或編輯。',{exact:true})).toBeVisible();
  await modal.getByRole('checkbox').check();await modal.getByRole('button',{name:'同意並保存',exact:true}).click();
  await expect(modal.getByRole('button',{name:'撤回開發同意',exact:true})).toBeVisible();
  await expect(modal.getByRole('button',{name:'驗證 Repo 並啟用開發',exact:true})).toBeDisabled();
  const current=await (await page.request.get('/api/v1/me/development/platform/cocreation')).json();expect(current.eligible).toBe(false);expect(current.intern_blocked).toBe(true);expect(current.consent).toBe(true);expect(current.enabled).toBe(false);
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
 const book=page.getByRole('dialog').filter({has:page.getByRole('button',{name:'加入共同開發',exact:true})});
 await book.getByRole('button',{name:'加入共同開發',exact:true}).click();const modal=page.getByRole('dialog',{name:'開發啟用任務',exact:true});
 await expect(modal.getByText('加入 AI 開發公會或 AI 導入與驗證公會其中一個，即可接續設定。保留你目前的主力公會。',{exact:true})).toBeVisible();
 await expect(modal.getByRole('button',{name:/^加入AI/})).toHaveCount(2);
 await page.keyboard.press('Escape');await expect(modal).not.toBeVisible();await expect(book).toBeVisible();await expect(book.getByRole('button',{name:'加入共同開發',exact:true})).toBeFocused();
});

const keyId='d0000000-0000-4000-8000-000000000001',secret='fpd_'+'a'.repeat(43);
function readyView(){return {capability:'platform',target:{key:'cocreation',title:'一起開發',repository:'FreeTWAI/freedom-platform',guide_url:'/development/cocreation/SKILL.md'},eligible:true,
 guilds:[{guild_key:'guild_platform_engineering',name:'平台工程公會',state:'active',aggregate_version:1}],github:{id:'42',login:'contributor'},app:{configured:true,installation_url:'https://github.com/apps/synthetic-app/installations/new'},policy_version:'development-proposal-v1',consent:true,enabled:true,
 grant:{grant_id:keyId,working_repository:'contributor/freedom-platform',expires_at:new Date(Date.now()+3600000).toISOString(),revoked_at:null},keys:[],proposals:[]};}

test('private Agent instruction clears before dialog close, does not enter browser storage and cannot return from a late issuance',async({page,context})=>{
 await context.grantPermissions(['clipboard-read','clipboard-write']);
 await page.route('**/api/v1/me/development/platform/cocreation',route=>route.fulfill({json:readyView()}));
 let delayed=false,release:(()=>void)|undefined;
 await page.route('**/api/v1/me/development/platform/cocreation/keys',async route=>{if(delayed)await new Promise<void>(resolve=>{release=resolve;});await route.fulfill({json:{key_id:keyId,token:secret,expires_at:new Date(Date.now()+3600000).toISOString(),working_repository:'contributor/freedom-platform',target_repository:'FreeTWAI/freedom-platform'}});});
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

for(const refusal of [
 {status:403,code:'development_binding_changed',detail:'GitHub 連動已變更，請重新啟用。'},
 {status:409,code:'github_connect_required',detail:'請先連結 GitHub。'},
 {status:502,code:'github_repository_unavailable',detail:'GitHub 暫時無法回應，請稍後再試。'},
]){
 test(`a refused development key refreshes revoked authority and its activation prerequisites (${refusal.status})`,async({page})=>{
  let enabled=true,keyWrites=0,activations=0;
  await page.route('**/api/v1/me/development/platform/cocreation',route=>route.fulfill({json:{...readyView(),enabled,github:!enabled&&refusal.status===409?null:readyView().github,grant:{...readyView().grant,revoked_at:enabled?null:new Date().toISOString()}}}));
  await page.route('**/api/v1/me/development/platform/cocreation/keys',route=>{
   keyWrites++;
   if(keyWrites===1){enabled=false;return route.fulfill({status:refusal.status,json:refusal});}
   return route.fulfill({json:{key_id:keyId,token:secret,expires_at:new Date(Date.now()+3600000).toISOString(),working_repository:'contributor/freedom-platform',target_repository:'FreeTWAI/freedom-platform'}});
  });
  await page.route('**/api/v1/me/development/platform/cocreation/activate',route=>{
   activations++;expect(route.request().postDataJSON()).toEqual({working_repository_url:'https://github.com/contributor/freedom-platform'});
   enabled=true;return route.fulfill({json:{grant_id:keyId}});
  });
  await login(page);const modal=await platform(page);
  await expect(modal.getByRole('button',{name:'產生私人 Agent 指令',exact:true})).toBeEnabled();
  if(refusal.status===403)for(const width of [1440,768,390]){
   await page.setViewportSize({width,height:900});
   await page.screenshot({path:`test-results/development-recovery-before-${width}.png`,fullPage:true});
  }
  await modal.getByRole('button',{name:'產生私人 Agent 指令',exact:true}).click();
  await expect(modal.getByRole('alert')).toHaveText(refusal.detail);
  await expect(modal.getByRole('button',{name:'產生私人 Agent 指令',exact:true})).toHaveCount(0);
  await expect(modal.getByText('已啟用此目標的開發提案。',{exact:false})).toHaveCount(0);
  expect(keyWrites).toBe(1);expect(activations).toBe(0);
  if(refusal.status===409){
   await expect(modal.getByRole('button',{name:'連結 GitHub',exact:true})).toBeEnabled();
   await expect(modal.getByRole('button',{name:'驗證 Repo 並啟用開發',exact:true})).toBeDisabled();
   return;
  }
  await expect(modal.getByRole('button',{name:'驗證 Repo 並啟用開發',exact:true})).toBeEnabled();
  if(refusal.status===403)for(const width of [1440,768,390]){
   await page.setViewportSize({width,height:900});
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   await page.screenshot({path:`test-results/development-recovery-after-${width}.png`,fullPage:true});
  }
  await modal.getByRole('button',{name:'驗證 Repo 並啟用開發',exact:true}).click();
  await expect(modal.getByRole('button',{name:'產生私人 Agent 指令',exact:true})).toBeEnabled();
  await expect(modal.getByRole('alert')).toHaveCount(0);
  await modal.getByRole('button',{name:'產生私人 Agent 指令',exact:true}).click();
  await expect(modal.getByLabel('私人開發指令',{exact:true})).toHaveValue(/FreeTWAI\/freedom-platform/);
  expect(keyWrites).toBe(2);expect(activations).toBe(1);
 });
}

for(const status of [502,503])test(`a provider ${status} outage preserves development authority and only an explicit retry repeats the same key request`,async({page})=>{
 let reads=0;const writes:string[]=[];
 await page.route('**/api/v1/me/development/platform/cocreation',route=>{reads++;return route.fulfill({json:readyView()});});
 await page.route('**/api/v1/me/development/platform/cocreation/keys',route=>{
  writes.push(route.request().headers()['idempotency-key']);
  if(writes.length===1)return route.fulfill({status,json:{code:'github_unavailable',detail:'GitHub 暫時無法回覆，請稍後重新嘗試。'}});
  return route.fulfill({json:{key_id:keyId,token:secret,expires_at:new Date(Date.now()+3600000).toISOString(),working_repository:'contributor/freedom-platform',target_repository:'FreeTWAI/freedom-platform'}});
 });
 await login(page);const modal=await platform(page);
 const issue=modal.getByRole('button',{name:'產生私人 Agent 指令',exact:true});await expect(issue).toBeEnabled();const before=reads;
 await issue.click();await expect(modal.getByRole('alert')).toHaveText('GitHub 暫時無法回覆，請稍後重新嘗試。');
 await expect(issue).toBeEnabled();await expect(modal.getByLabel('私人開發指令',{exact:true})).toHaveCount(0);
 expect(writes).toHaveLength(1);expect(reads).toBe(before);
 await issue.click();await expect(modal.getByLabel('私人開發指令',{exact:true})).toHaveValue(new RegExp(secret));
 expect(writes).toHaveLength(2);expect(writes[0]).toBeTruthy();expect(writes[1]).toBe(writes[0]);
});

test('a failed authority refresh removes the stale enabled claim and offers a read-only recovery',async({page})=>{
 let revoked=false,recoveryUnavailable=true,keyWrites=0;
 await page.route('**/api/v1/me/development/platform/cocreation',route=>{
  if(revoked&&recoveryUnavailable)return route.fulfill({status:503,json:{code:'github_unavailable'}});
  return route.fulfill({json:{...readyView(),enabled:!revoked,grant:{...readyView().grant,revoked_at:revoked?new Date().toISOString():null}}});
 });
 await page.route('**/api/v1/me/development/platform/cocreation/keys',route=>{
  keyWrites++;revoked=true;return route.fulfill({status:403,json:{code:'development_binding_changed',detail:'GitHub 連動已變更，請重新啟用。'}});
 });
 await login(page);const modal=await platform(page);await modal.getByRole('button',{name:'產生私人 Agent 指令',exact:true}).click();
 await expect(modal.getByRole('alert')).toHaveText('GitHub 連動已變更，請重新啟用。');
 await expect(modal.getByRole('button',{name:'產生私人 Agent 指令',exact:true})).toHaveCount(0);
 const reload=modal.getByRole('button',{name:'重新讀取設定',exact:true});await expect(reload).toBeEnabled();
 recoveryUnavailable=false;await reload.click();
 await expect(modal.getByRole('button',{name:'驗證 Repo 並啟用開發',exact:true})).toBeEnabled();
 await expect(modal.getByRole('alert')).toHaveCount(0);expect(keyWrites).toBe(1);
});

test('closing a dialog before a denied key response prevents late authority reads or private state from returning',async({page})=>{
 let reads=0,revoked=false,release:(()=>void)|undefined;
 await page.route('**/api/v1/me/development/platform/cocreation',route=>{reads++;return route.fulfill({json:{...readyView(),enabled:!revoked}});});
 await page.route('**/api/v1/me/development/platform/cocreation/keys',async route=>{
  await new Promise<void>(resolve=>{release=resolve;});revoked=true;
  await route.fulfill({status:403,json:{code:'development_binding_changed',detail:'GitHub 連動已變更，請重新啟用。'}});
 });
 await login(page);const modal=await platform(page);await modal.getByRole('button',{name:'產生私人 Agent 指令',exact:true}).click();
 await expect.poll(()=>Boolean(release)).toBe(true);const before=reads;
 await page.keyboard.press('Escape');const returned=page.waitForResponse(response=>response.url().endsWith('/development/platform/cocreation/keys'));
 release!();await returned;await expect(modal).not.toBeVisible();expect(reads).toBe(before);
 await page.getByRole('button',{name:'啟用這一頁的開發',exact:true}).click();
 await expect(modal.getByRole('button',{name:'驗證 Repo 並啟用開發',exact:true})).toBeEnabled();
 await expect(modal.getByRole('alert')).toHaveCount(0);await expect(modal.getByLabel('私人開發指令',{exact:true})).toHaveCount(0);
});

test('development activation text stays readable and controls remain reachable across themes and viewports',async({page})=>{
 await page.route('**/api/v1/me/development/platform/cocreation',route=>route.fulfill({json:readyView()}));
 await login(page);const modal=await platform(page);
 await expect(modal.getByRole('button',{name:'產生私人 Agent 指令',exact:true})).toBeEnabled();
 for(const theme of ['light','dark','versefolk'])for(const width of [320,390,768,1440]){
  await page.evaluate(value=>{document.documentElement.dataset.theme=value;},theme);
  await page.setViewportSize({width,height:900});
  const ratios=await modal.evaluate(node=>{
   const context=document.createElement('canvas').getContext('2d')!;
   const luminance=(color:string)=>{
    context.fillStyle=color;context.fillRect(0,0,1,1);
    const channels=Array.from(context.getImageData(0,0,1,1).data).slice(0,3).map(value=>{
     const normalized=value/255;return normalized<=.04045?normalized/12.92:((normalized+.055)/1.055)**2.4;
    });
    return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722;
   };
   const background=luminance(getComputedStyle(node).backgroundColor);
   return [node.querySelector('p')!,node.querySelector('.field-hint')!].map(text=>{
    const foreground=luminance(getComputedStyle(text).color);
    return (Math.max(background,foreground)+.05)/(Math.min(background,foreground)+.05);
   });
  });
  for(const ratio of ratios)expect(ratio,`${theme} ${width}px text contrast`).toBeGreaterThanOrEqual(4.5);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const close=modal.getByRole('button',{name:'關閉開發任務',exact:true});await close.focus();await expect(close).toBeInViewport();
  if([390,768,1440].includes(width))await page.screenshot({path:`test-results/development-theme-${theme}-${width}.png`,fullPage:true});
 }
});
