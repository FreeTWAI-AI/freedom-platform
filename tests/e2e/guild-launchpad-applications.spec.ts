import {writeFile} from 'node:fs/promises';
import type {TestInfo} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {test, expect, type Page} from './fixtures.js';
import {DEMO_COMMUNITY, DEMO_PASSWORD} from '../../packages/testing/seed.js';
import {hashPassword} from '../../modules/identity-membership/service.js';
import type {InstallationView, RegistryOperation, LaunchPlan} from '../../contracts/guild-launchpad/v1/module-registry.js';

const GUILD = 'guild_ai_field';
const RELEASE = 'manual-workspace@1.0.0';
const flow = (page: Page) => page.getByRole('region', {name: '啟動應用', exact: true});
const cards = (page: Page) => page.locator('.launchpad-applications');
// The platform now offers both stores and manual work; these launch-flow cases target manual work.
const manualCard = (page: Page) => cards(page).locator('.application-card').filter({has: page.getByRole('heading', {name: '人工工作空間', exact: true})});
async function post(page: Page, path: string, data: unknown, status = 201) {
  const session = await page.request.get('/api/v1/session');
  const csrf = (await session.json()).csrf_token as string;
  const response = await page.request.post(`/api/v1${path}`, {data, headers: {Origin: new URL(page.url()).origin, 'X-CSRF-Token': csrf, 'Idempotency-Key': randomUUID()}});
  const body = await response.json(); expect(response.status(), JSON.stringify(body)).toBe(status); return body;
}
async function member(db: Pool, page: Page, tier: 'full' | 'intern' = 'full') {
  const id = randomUUID(); const email = `launch-${id}@example.test`;
  await db.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,onboarding_required)
    VALUES($1,$2,$3,$4,$5,$6,false)`, [id,DEMO_COMMUNITY,email,'啟動測試成員',hashPassword(DEMO_PASSWORD),randomUUID()]);
  await db.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier)
    VALUES($1,$2,$3,$4,'active',$5)`,[randomUUID(),DEMO_COMMUNITY,id,GUILD,tier]);
  await db.query('INSERT INTO guild_member_preferences(community_id,user_id,primary_guild_key) VALUES($1,$2,$3)',[DEMO_COMMUNITY,id,GUILD]);
  await page.route(url => !['127.0.0.1','localhost'].includes(url.hostname), route => route.abort());
  await page.goto('/'); await page.getByLabel('電子郵件',{exact:true}).fill(email); await page.getByLabel('密碼',{exact:true}).fill(DEMO_PASSWORD);
  await page.getByRole('button',{name:'登入',exact:true}).click(); await expect(page.getByRole('button',{name:'設定',exact:true})).toBeVisible();
  return id;
}
async function open(page: Page) {
  await page.evaluate(key => {window.location.hash=`guilds/${key}`;},GUILD);
  await expect(cards(page).getByRole('heading',{name:'人工工作空間',exact:true})).toBeVisible();
}
async function begin(page: Page) {await manualCard(page).getByRole('button',{name:'啟動應用',exact:true}).click(); await expect(flow(page).getByRole('heading',{name:'啟動人工工作空間',exact:true})).toBeFocused();}
async function review(page: Page) {await flow(page).getByRole('button',{name:'產生啟動方案',exact:true}).click(); await expect(flow(page).getByRole('heading',{name:'確認啟動方案',exact:true})).toBeVisible();}
async function confirm(page: Page) {await flow(page).getByRole('button',{name:'確認啟動',exact:true}).click(); await expect(flow(page).getByRole('region',{name:'啟動進度'})).toContainText('已啟用');}
async function installations(page: Page, tenantId: string) {
  const response = await page.request.get(`/api/v1/tenants/${tenantId}/application-installations?limit=100`); expect(response.ok()).toBe(true);
  return (await response.json()).items as InstallationView[];
}
async function launchApi(page: Page, tenantId: string, workspaceId: string) {
  const key = randomUUID();
  const plan = await post(page,`/tenants/${tenantId}/application-launch-plans`,{guild_key:GUILD,workspace_id:workspaceId,application_key:'manual-workspace',release_ref:RELEASE,installation_choice:'create_new',dependencies:[{requirement_key:'work',choice:'create',configuration:{}}],configuration:{}}) as LaunchPlan;
  const input = {plan_id:plan.plan_id,expected_plan_version:plan.version,configuration_digest:plan.configuration_digest};
  const session = await page.request.get('/api/v1/session');
  const response = await page.request.post(`/api/v1/tenants/${tenantId}/application-installations`,{data:input,headers:{Origin:new URL(page.url()).origin,'X-CSRF-Token':(await session.json()).csrf_token,'Idempotency-Key':key}});
  expect(response.status()).toBe(200); const operation = await response.json() as RegistryOperation;
  return {tenant_id:tenantId,workspace_id:workspaceId,application_key:'manual-workspace',release_ref:RELEASE,key,input,operation};
}

async function capture(page: Page, testInfo: TestInfo, state: string) {
  await page.emulateMedia({reducedMotion:'reduce'});
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => {localStorage.setItem('freedom-theme',value); document.documentElement.dataset.theme=value; document.documentElement.dataset.experienceProfile=value; window.dispatchEvent(new Event('freedom-theme-changed'));}, theme);
    await expect.poll(() => page.evaluate(() => document.getAnimations().filter(animation => animation.effect instanceof KeyframeEffect && animation.effect.getTiming().iterations !== Infinity && animation.playState === 'running').length), {timeout:3000}).toBe(0);
    for (const width of [1280,360]) {
      await page.setViewportSize({width,height:900});
      await page.evaluate(()=>window.scrollTo({left:0,top:0,behavior:'instant'}));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const buttons = await page.locator('.btn').evaluateAll(elements => elements.filter(element => element.getBoundingClientRect().height > 0).map(element => {
        const box = element.getBoundingClientRect();
        return {text:element.textContent?.trim(),width:box.width,height:box.height,primary:element.classList.contains('btn-primary'),inApplications:Boolean(element.closest('.launchpad-applications'))};
      }));
      for (const button of buttons.filter(button => button.inApplications)) {expect(button.height).toBeGreaterThanOrEqual(44); expect(button.width).toBeLessThanOrEqual(width);}
      await writeFile(testInfo.outputPath(`${state}-${theme}-${width}-buttons.json`), JSON.stringify(buttons,null,2));
      await page.screenshot({path:testInfo.outputPath(`${state}-${theme}-${width}.png`),fullPage:true});
    }
  }
}

test('visitor sees application cards and public release details without launch controls', async ({page}) => {
  await page.route(url => !['127.0.0.1','localhost'].includes(url.hostname),route=>route.abort());
  await page.goto(`/#guilds/${GUILD}`); await expect(cards(page)).toContainText('可用');
  await manualCard(page).getByRole('button',{name:'版本資料',exact:true}).click();
  await expect(cards(page)).toContainText('來源提交：'); await expect(cards(page)).toContainText('成品摘要：');
  await expect(cards(page)).toContainText('人工工作：必要，允許共用既有實例');
  await expect(cards(page).getByRole('button',{name:'啟動應用',exact:true})).toHaveCount(0);
  await cards(page).getByRole('button',{name:'登入查看資格',exact:true}).click(); await expect(page.getByRole('heading',{name:'登入',exact:true})).toBeVisible();
});

test('intern keeps the card and the full-member reason with disabled launch', async ({page,e2eAuthPool}) => {
  await member(e2eAuthPool,page,'intern'); await open(page);
  await expect(cards(page)).toContainText('需要這個公會的正式會員身分');
  await expect(manualCard(page).getByRole('button',{name:'啟動應用',exact:true})).toBeDisabled();
  await expect(cards(page).locator('.application-card').filter({has: page.getByRole('heading',{name:'線上商店',exact:true})}).getByRole('button',{name:'啟動應用',exact:true})).toBeDisabled();
  await manualCard(page).getByRole('button',{name:'版本資料',exact:true}).click(); await expect(cards(page)).toContainText('來源提交：');
});

test('catalog status mapping and pagination require the explicit load-more action', async ({page}) => {
  let reads=0; let failedMore=false;
  await page.route('**/api/v1/applications?*',async route=>{
    reads++; const url=new URL(route.request().url()); const next=url.searchParams.has('cursor'); url.searchParams.delete('cursor');
    const response=await route.fetch({url:url.toString()}); const body=await response.json(); const app=body.items[0];
    if(next && !failedMore) {failedMore=true; await route.fulfill({response,status:503,json:{code:'dependency_unavailable',detail:'目錄暫時無法讀取。'}}); return;}
    await route.fulfill({response,json:{...body,items:next?[{...app,application_key:'last-page',display_name:'最後一頁'}]:[
      app,{...app,application_key:'review-page',display_name:'審查版本',release_status:'reviewed'},
      {...app,application_key:'external-page',display_name:'外部版本',runtime_profiles:['external-supported']},
      {...app,application_key:'retired-page',display_name:'停用版本',release_status:'retired'},
    ],next_cursor:next?null:'synthetic-page'}});
  });
  await page.goto(`/#guilds/${GUILD}`); await expect(cards(page).locator('.application-card')).toHaveCount(4);
  for(const status of ['可用','審核中','外部／試用','停用／版本需更新']) await expect(cards(page).getByText(status,{exact:true})).toBeVisible();
  expect(reads).toBe(1); await cards(page).getByRole('button',{name:'載入更多',exact:true}).click();
  await expect(cards(page).getByRole('button',{name:'重試',exact:true})).toBeVisible();
  await expect(cards(page).locator('.application-card')).toHaveCount(4);
  await cards(page).getByRole('button',{name:'重試',exact:true}).click();
  await expect(cards(page).locator('.application-card')).toHaveCount(5); expect(reads).toBe(3);
  await expect(cards(page).getByRole('heading',{name:'人工工作空間',exact:true})).toBeVisible();
  await expect(cards(page).getByRole('button',{name:'載入更多',exact:true})).toHaveCount(0);
});

test('repeated catalog rows render one card and one release detail', async ({page}) => {
  let displayName = '';
  await page.route(url => !['127.0.0.1','localhost'].includes(url.hostname),route=>route.abort());
  await page.route('**/api/v1/applications?*',async route=>{
    const url=new URL(route.request().url()); const next=url.searchParams.has('cursor'); url.searchParams.delete('cursor');
    const response=await route.fetch({url:url.toString()}); const body=await response.json(); const app=body.items[0];
    displayName=app.display_name;
    await route.fulfill({response,json:{...body,items:next?[app,{...app,application_key:'second-page',display_name:'第二頁'}]:[app,app],next_cursor:next?null:'synthetic-page'}});
  });
  await page.goto(`/#guilds/${GUILD}`);
  await expect(cards(page).locator('.application-card')).toHaveCount(1);
  await expect(cards(page).getByRole('heading',{name:'第二頁',exact:true})).toHaveCount(0);
  await cards(page).getByRole('button',{name:'載入更多',exact:true}).click();
  await expect(cards(page).locator('.application-card')).toHaveCount(2);
  await expect(cards(page).getByRole('heading',{name:'第二頁',exact:true})).toBeVisible();
  await cards(page).locator('.application-card').first().getByRole('button',{name:'版本資料',exact:true}).click();
  await expect(cards(page).getByRole('region',{name:`${displayName}版本資料`,exact:true})).toHaveCount(1);
  await expect(cards(page).getByRole('button',{name:'版本資料',exact:true,expanded:true})).toHaveCount(1);
});

test('lost plan response retries the original key and unchanged choices', async ({page,e2eAuthPool}) => {
  await member(e2eAuthPool,page); const made=await post(page,'/tenants',{display_name:'方案回復空間',workspace_name:'方案區'});
  await open(page); await begin(page);
  let dropped=false; const attempts:{key:string;body:string|null}[]=[];
  await page.route(url=>url.pathname===`/api/v1/tenants/${made.tenant.tenant_id}/application-launch-plans`,async route=>{
    attempts.push({key:route.request().headers()['idempotency-key'],body:route.request().postData()});
    if(dropped) return route.fallback(); dropped=true; await route.fetch(); await route.abort();
  });
  await flow(page).getByRole('button',{name:'產生啟動方案',exact:true}).click();
  await expect(flow(page).getByRole('button',{name:'重試',exact:true})).toBeVisible();
  await expect(flow(page).getByRole('radio',{name:'另建獨立空白的人工工作',exact:true})).toBeChecked();
  await expect(flow(page).getByRole('button',{name:'產生啟動方案',exact:true})).toBeDisabled();
  await flow(page).getByRole('button',{name:'重試',exact:true}).click();
  await expect(flow(page).getByRole('heading',{name:'確認啟動方案',exact:true})).toBeVisible();
  expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]); await confirm(page);
  expect(await installations(page,made.tenant.tenant_id)).toHaveLength(1);
});

test('stale plan preserves the draft and reloads the new installation before reuse', async ({page,e2eAuthPool}) => {
  await member(e2eAuthPool,page); const made=await post(page,'/tenants',{display_name:'過期方案空間',workspace_name:'保留選擇區'});
  await open(page); await begin(page); await review(page);
  await launchApi(page,made.tenant.tenant_id,made.workspace.workspace_id);
  await flow(page).getByRole('button',{name:'確認啟動',exact:true}).click();
  await expect(flow(page)).toContainText('方案已過期，請重新產生');
  await expect(flow(page).getByRole('radio',{name:/沿用這個安裝/})).toBeChecked();
  await expect(flow(page).getByRole('radio',{name:'另建獨立空白的人工工作',exact:true})).toBeDisabled();
  await expect(flow(page)).toContainText('這個工作區已經有這個應用的安裝，已改為沿用它。');
  await expect(flow(page).getByRole('radio',{name:/將共用既有的人工工作/})).toBeChecked();
  await review(page); await confirm(page);
  expect(await installations(page,made.tenant.tenant_id)).toHaveLength(1);
});

test('owner creates blank work, reviews capacity, confirms and refreshes MyWork in the bound workspace', async ({page,e2eAuthPool}) => {
  await member(e2eAuthPool,page); const made = await post(page,'/tenants',{display_name:'新業務空間',workspace_name:'預設區'});
  const workspace = await post(page,`/tenants/${made.tenant.tenant_id}/workspaces`,{name:'啟動區'});
  await open(page); await begin(page); await flow(page).getByRole('button',{name:'啟動區',exact:true}).click();
  await expect(flow(page).getByRole('radio',{name:'另建獨立空白的人工工作',exact:true})).toBeChecked();
  await review(page); await expect(flow(page)).toContainText('模組實例數：+1'); await expect(flow(page)).toContainText('有效期限：');
  const planReview=flow(page).getByRole('region',{name:'確認啟動方案',exact:true});
  await expect(planReview).toContainText('另建獨立空白的人工工作');
  await expect(planReview).not.toContainText(/(^|[^A-Za-z0-9_-])work(?=$|[^A-Za-z0-9_-])/);
  await confirm(page); await flow(page).getByRole('button',{name:'前往我的工作',exact:true}).click();
  await expect(page.locator('.my-work')).toContainText('新業務空間／啟動區'); await expect(page.locator('.my-work')).toContainText('繼續工作');
  const list = await installations(page,made.tenant.tenant_id); expect(list).toHaveLength(1); expect(list[0].workspace_id).toBe(workspace.workspace_id);
});

test('second launch explicitly reuses the installation without duplicating instances', async ({page,e2eAuthPool}) => {
  await member(e2eAuthPool,page); const made = await post(page,'/tenants',{display_name:'沿用業務空間',workspace_name:'沿用區'});
  await open(page); await begin(page); await review(page); await confirm(page);
  const before = await installations(page,made.tenant.tenant_id); expect(before).toHaveLength(1);
  await flow(page).getByRole('button',{name:'取消',exact:true}).click(); await begin(page);
  await expect(flow(page).getByRole('radio',{name:/沿用這個安裝/})).toBeChecked();
  await expect(flow(page).getByRole('button',{name:'另建新的安裝',exact:true})).toBeDisabled();
  await review(page); await expect(flow(page)).toContainText('不增加實例容量'); await expect(flow(page).getByRole('region',{name:'確認啟動方案',exact:true})).toContainText(`沿用安裝（${RELEASE}，ID 尾碼`); await confirm(page);
  const after = await installations(page,made.tenant.tenant_id); expect(after.map(item=>item.installation_id)).toEqual(before.map(item=>item.installation_id)); expect(after[0].modules).toEqual(before[0].modules);
});

test('two active work instances require an explicit dependency choice', async ({page,e2eAuthPool}) => {
  await member(e2eAuthPool,page); const made = await post(page,'/tenants',{display_name:'多實例空間',workspace_name:'第一區'});
  const second = await post(page,`/tenants/${made.tenant.tenant_id}/workspaces`,{name:'第二區'});
  const third = await post(page,`/tenants/${made.tenant.tenant_id}/workspaces`,{name:'待選區'});
  await post(page,`/tenants/${made.tenant.tenant_id}/workspaces/${made.workspace.workspace_id}/manual-work`,{guild_key:GUILD},200);
  await post(page,`/tenants/${made.tenant.tenant_id}/workspaces/${second.workspace_id}/manual-work`,{guild_key:GUILD,choice:{kind:'create_new'}},200);
  await open(page); await begin(page); await flow(page).getByRole('button',{name:'待選區',exact:true}).click();
  await expect(flow(page).getByRole('radio',{name:/將共用既有的人工工作/})).toHaveCount(2);
  await expect(flow(page).locator('input[type=radio]:checked')).toHaveCount(0);
  await expect(flow(page).getByRole('button',{name:'產生啟動方案',exact:true})).toBeDisabled();
  await flow(page).getByRole('radio',{name:/將共用既有的人工工作/}).first().check(); await review(page); await confirm(page);
  expect((await installations(page,made.tenant.tenant_id)).find(item=>item.workspace_id===third.workspace_id)).toBeTruthy();
});

test('lost launch response, Back, Forward and reload reopen one original request', async ({page,e2eAuthPool}) => {
  await member(e2eAuthPool,page); const made = await post(page,'/tenants',{display_name:'回應遺失空間',workspace_name:'回復區'});
  await open(page); await begin(page); await review(page);
  let dropped = false; const keys: string[] = [];
  await page.route(url=>url.pathname===`/api/v1/tenants/${made.tenant.tenant_id}/application-installations`,async route=>{
    if(route.request().method()!=='POST') return route.fallback();
    keys.push(route.request().headers()['idempotency-key']);
    if(dropped) return route.fallback(); dropped=true; await route.fetch(); await route.abort();
  });
  await flow(page).getByRole('button',{name:'確認啟動',exact:true}).click(); await expect(flow(page).getByRole('region',{name:'啟動進度'})).toContainText('結果未確認');
  await page.evaluate(()=>{window.location.hash='guilds';}); await expect(flow(page)).toHaveCount(0);
  await page.goBack(); await expect(flow(page)).toBeVisible();
  await page.goForward(); await expect(flow(page)).toHaveCount(0);
  await page.goBack(); await expect(flow(page)).toBeVisible();
  await page.reload(); await expect(flow(page)).toBeVisible(); await expect(flow(page).getByRole('button',{name:'確認啟動',exact:true})).toHaveCount(0);
  await flow(page).getByRole('button',{name:'查看進度',exact:true}).click(); await expect(flow(page).getByRole('region',{name:'啟動進度'})).toContainText('已啟用');
  expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]); expect(await installations(page,made.tenant.tenant_id)).toHaveLength(1);
  await flow(page).getByRole('button',{name:'取消',exact:true}).click(); await page.reload(); await expect(flow(page)).toHaveCount(0);
});

test('quota rejection names the dimension and preserves existing work and choices', async ({page,e2eAuthPool},testInfo) => {
  await member(e2eAuthPool,page); const made=await post(page,'/tenants',{display_name:'容量測試空間',workspace_name:'既有區'});
  await launchApi(page,made.tenant.tenant_id,made.workspace.workspace_id);
  await post(page,`/tenants/${made.tenant.tenant_id}/workspaces`,{name:'額外區'});
  await e2eAuthPool.query(`INSERT INTO tenant_capacity_policies(policy_id,revision,tenant_id,plan_ref,max_active_instances,
    max_instances_per_module,max_concurrent_provisions,max_work_items,max_retained_bytes,max_concurrent_jobs,status)
    VALUES($1,1,$2,'synthetic-zero-instance-limit',0,0,2,1000,104857600,4,'active')`,[randomUUID(),made.tenant.tenant_id]);
  await open(page); await begin(page); await flow(page).getByRole('button',{name:'額外區',exact:true}).click();
  await flow(page).getByRole('radio',{name:'另建獨立空白的人工工作',exact:true}).check(); await review(page);
  await flow(page).getByRole('button',{name:'確認啟動',exact:true}).click();
  await expect(flow(page)).toContainText('容量維度：模組實例數。既有工作仍可使用');
  await expect(flow(page).getByRole('alert')).not.toContainText('module_instances');
  await expect(flow(page).getByRole('alert')).not.toContainText(/。 /);
  await capture(page,testInfo,'quota');
  await expect(flow(page).getByRole('radio',{name:'另建獨立空白的人工工作',exact:true})).toBeChecked();
  expect(await installations(page,made.tenant.tenant_id)).toHaveLength(1);
  const context=await page.request.get(`/api/v1/tenants/${made.tenant.tenant_id}/workspaces/${made.workspace.workspace_id}/launchpad-context?guild_key=${GUILD}`);
  expect(context.ok()).toBe(true); const body=await context.json();
  expect(body.workspace_id).toBe(made.workspace.workspace_id); expect(body.connection_summary).toHaveLength(1); expect(body.work_page.items).toEqual([]);
});

for (const action of ['核對原操作','查看進度','停止後續步驟'] as const) {
  test(`unknown operation shows three actions and ${action} uses the real operation`, async ({page,e2eAuthPool}) => {
    const userId=await member(e2eAuthPool,page); const made=await post(page,'/tenants',{display_name:'核對業務空間',workspace_name:'核對區'});
    const held=await launchApi(page,made.tenant.tenant_id,made.workspace.workspace_id);
    await page.evaluate(({userId,held,guild})=>sessionStorage.setItem(`freedom-application-launch:${userId}:${guild}`,JSON.stringify([{...held,unknown_key:true},held])),{userId,held,guild:GUILD});
    let mocked=false; let command=false;
    page.on('request',request=>{if(request.method()==='POST' && /\/(reconcile|cancel)$/.test(new URL(request.url()).pathname)) command=true;});
    await page.route(url=>url.pathname===`/api/v1/tenants/${held.tenant_id}/operations/${held.operation.operation_id}`,async route=>{
      if(mocked) return route.fallback(); mocked=true; const reply=await route.fetch(); const json=await reply.json();
      await route.fulfill({response:reply,json:{...json,state:'needs_reconciliation'}});
    });
    await open(page); await expect(flow(page).getByRole('region',{name:'啟動進度'})).toContainText('結果未確認');
    for(const label of ['核對原操作','查看進度','停止後續步驟']) await expect(flow(page).getByRole('button',{name:label,exact:true})).toBeEnabled();
    await flow(page).getByRole('button',{name:action,exact:true}).click();
    if(action==='停止後續步驟') {await expect(flow(page)).toContainText('這個操作已經結束，不能取消'); await flow(page).getByRole('button',{name:'查看進度',exact:true}).click();}
    await expect(flow(page).getByRole('region',{name:'啟動進度'})).toContainText('已啟用');
    expect(command).toBe(action!=='查看進度'); expect(await installations(page,held.tenant_id)).toHaveLength(1);
  });
}

test('stale operation CAS reloads its current real state', async ({page,e2eAuthPool}) => {
  const userId=await member(e2eAuthPool,page); const made=await post(page,'/tenants',{display_name:'版本核對空間',workspace_name:'版本區'});
  const held=await launchApi(page,made.tenant.tenant_id,made.workspace.workspace_id);
  await page.evaluate(({userId,held,guild})=>sessionStorage.setItem(`freedom-application-launch:${userId}:${guild}`,JSON.stringify([held])),{userId,held,guild:GUILD});
  let mocked=false;
  await page.route(url=>url.pathname===`/api/v1/tenants/${held.tenant_id}/operations/${held.operation.operation_id}`,async route=>{
    if(mocked) return route.fallback(); mocked=true; const reply=await route.fetch(); const json=await reply.json();
    await route.fulfill({response:reply,json:{...json,state:'needs_reconciliation',version:'999'}});
  });
  await open(page); await expect(flow(page)).toContainText('結果未確認'); await flow(page).getByRole('button',{name:'核對原操作',exact:true}).click();
  await expect(flow(page).getByRole('region',{name:'啟動進度'})).toContainText('已啟用');
  await expect(flow(page)).toContainText('操作狀態已更新，已重新載入。');
  await expect(flow(page).getByRole('region',{name:'啟動進度'}).locator('ul')).not.toContainText('最新版本');
  await expect(flow(page)).not.toContainText('選擇已保留，請核對最新候選與版本');
});

test('tenant switch clears the plan and drops a late private response', async ({page,e2eAuthPool}) => {
  await member(e2eAuthPool,page); const a=await post(page,'/tenants',{display_name:'甲業務空間',workspace_name:'甲區'});
  await post(page,'/tenants',{display_name:'乙業務空間',workspace_name:'乙區'}); await open(page); await begin(page);
  await flow(page).getByRole('button',{name:'甲業務空間・擁有者',exact:true}).click();
  await expect(flow(page).getByRole('button',{name:'產生啟動方案',exact:true})).toBeEnabled();
  let release:()=>void=()=>undefined; const gate=new Promise<void>(resolve=>{release=resolve;}); let waiting=false;
  await page.route(url=>url.pathname===`/api/v1/tenants/${a.tenant.tenant_id}/application-launch-plans`,async route=>{
    const response=await route.fetch(); waiting=true; await gate; try{await route.fulfill({response});}catch{/* The tenant switch aborts this request. */}
  });
  await flow(page).getByRole('button',{name:'產生啟動方案',exact:true}).click(); await expect.poll(()=>waiting).toBe(true);
  await flow(page).getByRole('button',{name:'乙業務空間・擁有者',exact:true}).click(); release();
  await expect(flow(page)).toContainText('目前業務空間：乙業務空間'); await expect(flow(page)).not.toContainText('甲業務空間／甲區');
  await expect(flow(page).getByRole('heading',{name:'確認啟動方案',exact:true})).toHaveCount(0);
});

test('360px keyboard launch, cancel focus and light/RPG screenshots', async ({page,e2eAuthPool},testInfo) => {
  await member(e2eAuthPool,page); const made=await post(page,'/tenants',{display_name:'鍵盤業務空間',workspace_name:'鍵盤區'}); await post(page,`/tenants/${made.tenant.tenant_id}/workspaces`,{name:'另一鍵盤區'}); await open(page);
  await page.emulateMedia({reducedMotion:'reduce'}); await page.setViewportSize({width:360,height:780});
  const launch=manualCard(page).getByRole('button',{name:'啟動應用',exact:true}); await launch.focus(); await page.keyboard.press('Enter');
  await expect(flow(page).getByRole('heading',{name:'啟動人工工作空間',exact:true})).toBeFocused();
  await page.keyboard.press('Escape'); await expect(launch).toBeFocused(); await page.keyboard.press('Enter');
  await page.keyboard.press('Tab'); await expect(flow(page).getByRole('button',{name:'取消',exact:true})).toBeFocused(); await page.keyboard.press('Enter'); await expect(launch).toBeFocused();
  await page.keyboard.press('Enter'); await expect(flow(page).getByRole('button',{name:'產生啟動方案',exact:true})).toBeEnabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const targets=await cards(page).locator('button,.application-choice').evaluateAll(elements=>elements.map(element=>element.getBoundingClientRect().height));
  for(const height of targets) expect(height).toBeGreaterThanOrEqual(44);
  for(const theme of ['light','dark']) {
    await page.evaluate(value=>{document.documentElement.dataset.theme=value;document.documentElement.dataset.experienceProfile=value;window.dispatchEvent(new Event('freedom-theme-changed'));},theme);
    await flow(page).getByRole('button',{name:'另一鍵盤區',exact:true}).click();
    const selected=flow(page).getByRole('group',{name:'工作區',exact:true}).locator('[aria-current="true"]');
    const other=flow(page).getByRole('button',{name:'鍵盤區',exact:true});
    await expect.poll(async()=>{const a=await selected.evaluate(el=>({bg:getComputedStyle(el).backgroundColor,border:getComputedStyle(el).borderColor})); const b=await other.evaluate(el=>({bg:getComputedStyle(el).backgroundColor,border:getComputedStyle(el).borderColor})); return a.bg!==b.bg && a.border!==b.border;},{timeout:3000}).toBe(true);
  }
  await expect(flow(page).getByText('新實例不複製既有資料，會使用額外容量。',{exact:true})).toBeVisible();
  await capture(page,testInfo,'pickers');
  await flow(page).getByRole('heading',{name:'啟動人工工作空間',exact:true}).focus();
  // Follow the actual tab order from the heading to the plan action.
  for(let count=0;count<12;count++) {
    if(await flow(page).getByRole('button',{name:'產生啟動方案',exact:true}).evaluate(element=>element===document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  await expect(flow(page).getByRole('button',{name:'產生啟動方案',exact:true})).toBeFocused(); await page.keyboard.press('Enter');
  await expect(flow(page).getByRole('heading',{name:'確認啟動方案',exact:true})).toBeVisible();
  for(const theme of ['light','dark']) {
    await page.evaluate(value=>{localStorage.setItem('freedom-theme',value);document.documentElement.dataset.theme=value;document.documentElement.dataset.experienceProfile=value;window.dispatchEvent(new Event('freedom-theme-changed'));},theme);
    for(const width of [1440,768,390,360]) {
      await page.setViewportSize({width,height:900}); expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      const heights=await cards(page).locator('button,input,select').evaluateAll(elements=>elements.filter(element=>getComputedStyle(element).display!=='none').map(element=>element.getBoundingClientRect().height));
      for(const height of heights) expect(height).toBeGreaterThanOrEqual(44);
      await page.screenshot({path:testInfo.outputPath(`applications-${theme}-${width}.png`),fullPage:true});
    }
  }
  await page.setViewportSize({width:360,height:780});
  await expect(flow(page).getByRole('heading',{name:'確認啟動方案',exact:true})).toBeFocused();
  for(let count=0;count<12;count++) {
    if(await flow(page).getByRole('button',{name:'確認啟動',exact:true}).evaluate(element=>element===document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  await expect(flow(page).getByRole('button',{name:'確認啟動',exact:true})).toBeFocused(); await page.keyboard.press('Enter');
  await expect(flow(page)).toContainText('已啟用'); await expect(flow(page).getByRole('button',{name:'前往我的工作',exact:true})).toBeVisible();
});

test('post-commit authorization error and delisted catalog recover the original launch key', async ({page,e2eAuthPool}) => {
  await member(e2eAuthPool,page); const made=await post(page,'/tenants',{display_name:'提交後核對空間',workspace_name:'原操作區'});
  await open(page); await begin(page); await review(page);
  let rejected=false; const keys:string[]=[];
  await page.route(url=>url.pathname===`/api/v1/tenants/${made.tenant.tenant_id}/application-installations`,async route=>{
    if(route.request().method()!=='POST') return route.fallback();
    keys.push(route.request().headers()['idempotency-key']);
    if(rejected) return route.fallback(); rejected=true; const result=await route.fetch(); expect(result.status()).toBe(200);
    await route.fulfill({status:403,contentType:'application/problem+json',json:{code:'capability_denied',detail:'目前沒有這個操作的權限。'}});
  });
  await flow(page).getByRole('button',{name:'確認啟動',exact:true}).click();
  await expect(flow(page).getByRole('alert')).toContainText('目前沒有這個操作的權限。'); await expect(flow(page)).toContainText('結果未確認');
  await page.route('**/api/v1/applications?*',async route=>{
    const response=await route.fetch(); const body=await response.json(); await route.fulfill({response,json:{...body,items:[],next_cursor:null}});
  });
  await page.reload(); await expect(flow(page)).toBeVisible(); await expect(flow(page).getByRole('button',{name:'確認啟動',exact:true})).toHaveCount(0);
  await flow(page).getByRole('button',{name:'查看進度',exact:true}).click(); await expect(flow(page)).toContainText('已啟用');
  expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]); expect(await installations(page,made.tenant.tenant_id)).toHaveLength(1);
});

test('existing installation locks the dependency to its linked instance when two instances are active', async ({page,e2eAuthPool},testInfo) => {
  await member(e2eAuthPool,page); const made=await post(page,'/tenants',{display_name:'明確沿用空間',workspace_name:'沿用目標區'});
  const other=await post(page,`/tenants/${made.tenant.tenant_id}/workspaces`,{name:'另一實例區'});
  await launchApi(page,made.tenant.tenant_id,made.workspace.workspace_id); await launchApi(page,made.tenant.tenant_id,other.workspace_id);
  await open(page); await begin(page); await flow(page).getByRole('button',{name:'沿用目標區',exact:true}).click();
  await expect(flow(page).getByRole('radio',{name:/將共用既有的人工工作/})).toHaveCount(2);
  await expect(flow(page).locator('input[name=dependency-work]:checked')).toHaveCount(1);
  await expect(flow(page).getByRole('button',{name:'產生啟動方案',exact:true})).toBeEnabled();
  const target=(await installations(page,made.tenant.tenant_id)).find(item=>item.workspace_id===made.workspace.workspace_id)!;
  const linked=flow(page).getByRole('radio',{name:new RegExp(`將共用既有的人工工作.*${target.modules[0].instance_id.slice(-6)}`)});
  await expect(linked).toBeChecked(); await expect(linked).toBeEnabled();
  await expect(flow(page).locator('input[name=dependency-work]:not(:checked)')).toHaveCount(2);
  for(const radio of await flow(page).locator('input[name=dependency-work]:not(:checked)').all()) await expect(radio).toBeDisabled();
  await expect(flow(page)).toContainText(`沿用這個安裝時，會繼續共用它連結的人工工作（ID 尾碼 ${target.modules[0].instance_id.slice(-6)}）。`);
  await expect(flow(page).getByText('新實例不複製既有資料，會使用額外容量。',{exact:true})).toHaveCount(0);
  await capture(page,testInfo,'locked-reuse');
  await expect(flow(page).getByRole('button',{name:'產生啟動方案',exact:true})).toBeEnabled(); await review(page); await confirm(page);
  expect(await installations(page,made.tenant.tenant_id)).toHaveLength(2);
});

test('a lost tenant-list read retries the list and can continue the original flow', async ({page,e2eAuthPool}) => {
  await member(e2eAuthPool,page); await post(page,'/tenants',{display_name:'清單回復空間',workspace_name:'清單區'}); await open(page);
  await expect(page.locator('.my-work')).toContainText('清單回復空間');
  let dropped=false;
  await page.route('**/api/v1/tenants?*',async route=>{
    if(dropped) return route.fallback(); dropped=true; await route.abort();
  });
  await begin(page); await expect(flow(page).getByRole('button',{name:'重新載入清單',exact:true})).toBeVisible();
  await expect(flow(page)).not.toContainText('你還沒有業務空間。');
  await flow(page).getByRole('button',{name:'重新載入清單',exact:true}).click();
  await expect(flow(page).getByRole('button',{name:'產生啟動方案',exact:true})).toBeEnabled(); await review(page); await confirm(page);
});

test('stored operator acting context selects the owned tenant without registry reads for the operator tenant', async ({page,e2eAuthPool}) => {
  const userId=await member(e2eAuthPool,page);
  const p=await post(page,'/tenants',{display_name:'本人空間',workspace_name:'本人區'});
  const t=await post(page,'/tenants',{display_name:'團隊空間',workspace_name:'團隊區'});
  const principal=(await e2eAuthPool.query('SELECT principal_id FROM principals WHERE user_ref=$1',[userId])).rows[0].principal_id;
  const other=randomUUID();
  await e2eAuthPool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,onboarding_required) VALUES($1,$2,$3,'另一擁有者',$4,$5,false)`,[other,DEMO_COMMUNITY,`owner-${other}@example.test`,hashPassword(DEMO_PASSWORD),randomUUID()]);
  // Reuse the existing person mapping helper through the invite-candidate API.
  const candidate=await page.request.get(`/api/v1/tenants/invite-candidates?user_id=${other}`); expect(candidate.ok()).toBe(true);
  const otherPrincipal=(await candidate.json()).principal_id;
  await e2eAuthPool.query(`INSERT INTO tenant_memberships(tenant_id,principal_id,role,status,accepted_at) VALUES($1,$2,'owner','active',clock_timestamp())`,[t.tenant.tenant_id,otherPrincipal]);
  await e2eAuthPool.query(`UPDATE tenant_memberships SET role='operator',version=version+1 WHERE tenant_id=$1 AND principal_id=$2`,[t.tenant.tenant_id,principal]);
  await page.evaluate(({userId,p})=>sessionStorage.setItem(`freedom-acting-tenant:${userId}`,JSON.stringify({tenant_id:p.tenant.tenant_id,workspace_id:p.workspace.workspace_id})),{userId,p});
  await open(page); await expect(page.locator('.my-work')).toContainText('本人空間／本人區');
  await page.evaluate(({userId,t})=>sessionStorage.setItem(`freedom-acting-tenant:${userId}`,JSON.stringify({tenant_id:t.tenant.tenant_id,workspace_id:t.workspace.workspace_id})),{userId,t});
  const requests:string[]=[]; page.on('request',request=>requests.push(new URL(request.url()).pathname));
  await begin(page); await expect(flow(page)).toContainText('目前業務空間：本人空間 · 擁有者／本人區');
  await expect(flow(page).getByRole('button',{name:'團隊空間・操作者',exact:true})).toHaveCount(0);
  await expect(flow(page)).toContainText('只列出你擁有或管理、目前可使用的業務空間。');
  await expect(flow(page).getByRole('alert')).toHaveCount(0); await review(page);
  expect(requests.filter(path=>path.startsWith(`/api/v1/tenants/${t.tenant.tenant_id}/`) && /\/(application-installations|module-instances|application-launch-plans)$/.test(path))).toEqual([]);
  expect(JSON.parse(await page.evaluate(userId=>sessionStorage.getItem(`freedom-acting-tenant:${userId}`)!,userId)).tenant_id).toBe(t.tenant.tenant_id);
  await flow(page).getByRole('button',{name:'取消',exact:true}).click();
  await e2eAuthPool.query(`INSERT INTO tenant_memberships(tenant_id,principal_id,role,status,accepted_at) VALUES($1,$2,'owner','active',clock_timestamp())`,[p.tenant.tenant_id,otherPrincipal]);
  await e2eAuthPool.query(`UPDATE tenant_memberships SET role='operator',version=version+1 WHERE tenant_id=$1 AND principal_id=$2`,[p.tenant.tenant_id,principal]);
  await page.reload(); await expect(manualCard(page).getByRole('button',{name:'啟動應用',exact:true})).toBeEnabled();
  await expect(cards(page)).toContainText('你目前沒有可管理的業務空間');
  await begin(page); await expect(flow(page).getByLabel('業務空間名稱',{exact:true})).toHaveValue('');
  expect(requests.filter(path=>path.startsWith(`/api/v1/tenants/${t.tenant.tenant_id}/`) && /\/(application-installations|module-instances|application-launch-plans)$/.test(path))).toEqual([]);
});

test('go to My Work preserves dirty content on decline and switches context only on acceptance', async ({page,e2eAuthPool}) => {
  const userId=await member(e2eAuthPool,page); const made=await post(page,'/tenants',{display_name:'離開確認空間',workspace_name:'原工作區'});
  await launchApi(page,made.tenant.tenant_id,made.workspace.workspace_id);
  await post(page,`/tenants/${made.tenant.tenant_id}/workspaces`,{name:'新啟動區'});
  await open(page); const myWork=page.locator('.my-work'); await expect(myWork.locator('#my-work-title')).toBeVisible();
  await myWork.locator('#my-work-title').fill('尚未儲存的工作');
  const acting=await page.evaluate(userId=>sessionStorage.getItem(`freedom-acting-tenant:${userId}`),userId);
  await begin(page); await flow(page).getByRole('button',{name:'新啟動區',exact:true}).click(); await review(page); await confirm(page);
  page.once('dialog',dialog=>{expect(dialog.message()).toBe('有尚未儲存的內容，確定要離開嗎？'); void dialog.dismiss();});
  await flow(page).getByRole('button',{name:'前往我的工作',exact:true}).click();
  await expect(flow(page)).toBeVisible(); await expect(myWork.locator('#my-work-title')).toHaveValue('尚未儲存的工作');
  expect(await page.evaluate(userId=>sessionStorage.getItem(`freedom-acting-tenant:${userId}`),userId)).toBe(acting);
  page.once('dialog',dialog=>void dialog.accept()); await flow(page).getByRole('button',{name:'前往我的工作',exact:true}).click();
  await expect(flow(page)).toHaveCount(0); await expect(myWork).toContainText('離開確認空間／新啟動區');
});

test('archived saved workspace shows a removable notice without opening or focusing the panel', async ({page,e2eAuthPool},testInfo) => {
  const userId=await member(e2eAuthPool,page); const made=await post(page,'/tenants',{display_name:'無法還原空間',workspace_name:'仍可用區'});
  const workspace=await post(page,`/tenants/${made.tenant.tenant_id}/workspaces`,{name:'將封存區'});
  await open(page); await begin(page); await flow(page).getByRole('button',{name:'將封存區',exact:true}).click(); await review(page);
  let dropped=false; let committed=false;
  await page.route(url=>url.pathname===`/api/v1/tenants/${made.tenant.tenant_id}/application-installations`,async route=>{
    if(route.request().method()!=='POST' || dropped) return route.fallback(); dropped=true; const response=await route.fetch(); expect(response.status()).toBe(200); await route.abort(); committed=true;
  });
  await flow(page).getByRole('button',{name:'確認啟動',exact:true}).click(); await expect(flow(page)).toContainText('結果未確認');
  await expect.poll(()=>committed,{timeout:5000}).toBe(true);
  await e2eAuthPool.query(`UPDATE workspaces SET status='archived',version=version+1 WHERE workspace_id=$1`,[workspace.workspace_id]);
  await page.reload(); const notice=cards(page).getByRole('status').filter({hasText:'上次的啟動結果目前無法在這裡查看'});
  await expect(notice).toContainText('人工工作空間'); await expect(notice).toContainText('尚未取得操作識別碼');
  await expect(flow(page)).toHaveCount(0); expect(await cards(page).evaluate(el=>el.contains(document.activeElement))).toBe(false);
  await expect(notice.locator(':scope > p')).toHaveCount(1);
  await expect(notice.locator(':scope > .application-actions').getByRole('button',{name:'不再追蹤',exact:true})).toBeVisible();
  await capture(page,testInfo,'restore-notice');
  await notice.getByRole('button',{name:'不再追蹤',exact:true}).click(); await expect(notice).toHaveCount(0);
  await page.reload(); await expect(cards(page).getByRole('heading',{name:'人工工作空間',exact:true})).toBeVisible(); await expect(flow(page)).toHaveCount(0);
  await expect(cards(page)).not.toContainText('上次的啟動結果目前無法在這裡查看');
});

test('forbidden progress stops polling and forgetting removes the original pending launch', async ({page,e2eAuthPool}) => {
  const userId=await member(e2eAuthPool,page); const made=await post(page,'/tenants',{display_name:'停止追蹤空間',workspace_name:'追蹤區'});
  const held=await launchApi(page,made.tenant.tenant_id,made.workspace.workspace_id); held.operation={...held.operation,state:'running'};
  await page.evaluate(({userId,held,guild})=>sessionStorage.setItem(`freedom-application-launch:${userId}:${guild}`,JSON.stringify([held])),{userId,held,guild:GUILD});
  await page.clock.install(); let reads=0;
  await page.route(url=>url.pathname===`/api/v1/tenants/${held.tenant_id}/operations/${held.operation.operation_id}`,async route=>{
    reads++; const response=await route.fetch(); expect(response.status()).toBe(200);
    await route.fulfill({response,status:403,json:{code:'capability_denied',detail:'目前沒有這個操作的權限。'}});
  });
  await open(page); await expect(flow(page).getByRole('alert')).toContainText('目前沒有這個操作的權限。');
  await expect(flow(page)).toContainText(held.operation.operation_id); await expect(flow(page)).toContainText('不再追蹤只會讓這個分頁不再自動開啟這個操作；操作本身不會停止，請保留操作識別碼。');
  expect(reads).toBe(1); await page.clock.runFor(30000); expect(reads).toBe(1);
  await flow(page).getByRole('button',{name:'不再追蹤',exact:true}).click(); await expect(flow(page)).toHaveCount(0);
  expect(JSON.parse(await page.evaluate(({userId,guild})=>sessionStorage.getItem(`freedom-application-launch:${userId}:${guild}`)!,{userId,guild:GUILD}))).toEqual([]);
});

test('stale cancel reloads a running operation and keeps automatic polling active', async ({page,e2eAuthPool}) => {
  const userId=await member(e2eAuthPool,page); const made=await post(page,'/tenants',{display_name:'持續核對空間',workspace_name:'核對區'});
  const held=await launchApi(page,made.tenant.tenant_id,made.workspace.workspace_id); held.operation={...held.operation,state:'running',version:'999'};
  await page.evaluate(({userId,held,guild})=>sessionStorage.setItem(`freedom-application-launch:${userId}:${guild}`,JSON.stringify([held])),{userId,held,guild:GUILD});
  await page.clock.install(); await page.clock.pauseAt(new Date(Date.now()+1000));
  let reads=0; let cancels=0;
  const operationPath=`/api/v1/tenants/${held.tenant_id}/operations/${held.operation.operation_id}`;
  await page.route(url=>url.pathname===operationPath,async route=>{
    reads++; const response=await route.fetch(); expect(response.status()).toBe(200); const body=await response.json();
    await route.fulfill({response,json:reads<=2?{...body,state:'running',...(reads===1?{version:'999'}:{})}:body});
  });
  await page.route(url=>url.pathname===`${operationPath}/cancel`,async route=>{
    cancels++; expect(route.request().headers()['if-match']).toBe('"999"');
    const response=await route.fetch(); expect(response.status()).toBe(412); expect((await response.json()).code).toBe('version_conflict');
    await route.fulfill({response});
  });
  await open(page); await expect(flow(page).getByRole('region',{name:'啟動進度',exact:true})).toContainText('配置中'); expect(reads).toBe(1);
  await flow(page).getByRole('button',{name:'停止後續步驟',exact:true}).click();
  await expect(flow(page)).toContainText('操作狀態已更新，已重新載入。');
  await expect(flow(page).getByRole('region',{name:'啟動進度',exact:true})).toContainText('版本 1');
  await expect(flow(page).getByRole('region',{name:'啟動進度',exact:true})).toContainText('配置中'); expect(reads).toBe(2); expect(cancels).toBe(1);
  await expect(flow(page).getByRole('button',{name:'不再追蹤',exact:true})).toHaveCount(0);
  await page.clock.runFor(3000); await expect.poll(()=>reads,{timeout:5000}).toBe(3);
  await expect(flow(page).getByRole('region',{name:'啟動進度',exact:true})).toContainText('已啟用');
  await page.clock.runFor(30000); expect(reads).toBe(3);
});

test('successful manual progress after a refusal hides forgetting and restarts automatic polling', async ({page,e2eAuthPool}) => {
  const userId=await member(e2eAuthPool,page); const made=await post(page,'/tenants',{display_name:'重新追蹤空間',workspace_name:'追蹤區'});
  const held=await launchApi(page,made.tenant.tenant_id,made.workspace.workspace_id); held.operation={...held.operation,state:'running'};
  await page.evaluate(({userId,held,guild})=>sessionStorage.setItem(`freedom-application-launch:${userId}:${guild}`,JSON.stringify([held])),{userId,held,guild:GUILD});
  await page.clock.install(); await page.clock.pauseAt(new Date(Date.now()+1000)); let reads=0;
  await page.route(url=>url.pathname===`/api/v1/tenants/${held.tenant_id}/operations/${held.operation.operation_id}`,async route=>{
    reads++; const response=await route.fetch(); expect(response.status()).toBe(200); const body=await response.json();
    if(reads===1) {await route.fulfill({response,status:403,json:{code:'capability_denied',detail:'目前沒有這個操作的權限。'}}); return;}
    await route.fulfill({response,json:{...body,state:'running'}});
  });
  await open(page); await expect(flow(page).getByRole('button',{name:'不再追蹤',exact:true})).toBeVisible();
  await page.clock.runFor(30000); expect(reads).toBe(1);
  await flow(page).getByRole('button',{name:'查看進度',exact:true}).click();
  await expect(flow(page).getByRole('alert')).toHaveCount(0);
  await expect(flow(page).getByRole('button',{name:'不再追蹤',exact:true})).toHaveCount(0);
  await expect(flow(page).getByRole('region',{name:'啟動進度',exact:true})).toContainText('配置中'); expect(reads).toBe(2);
  await page.clock.runFor(3000); await expect.poll(()=>reads,{timeout:5000}).toBe(3);
  await expect(flow(page).getByRole('button',{name:'不再追蹤',exact:true})).toHaveCount(0);
});

test('signed-in non-member receives the join-guild next step and no enabled launch', async ({page,e2eAuthPool}) => {
  const userId=await member(e2eAuthPool,page); await e2eAuthPool.query(`UPDATE positioning_profession_memberships SET state='left' WHERE user_id=$1 AND guild_key=$2`,[userId,GUILD]);
  await open(page); await expect(cards(page)).toContainText('先加入這個公會，才能啟動應用。');
  await expect(manualCard(page).getByRole('button',{name:'啟動應用',exact:true})).toBeDisabled();
  await expect(cards(page).locator('.application-card').filter({has: page.getByRole('heading',{name:'線上商店',exact:true})}).getByRole('button',{name:'啟動應用',exact:true})).toBeDisabled();
});

test('rejected reuse candidates stay disabled for the panel session', async ({page,e2eAuthPool}) => {
  await member(e2eAuthPool,page); const made=await post(page,'/tenants',{display_name:'無法共用空間',workspace_name:'既有區'});
  await launchApi(page,made.tenant.tenant_id,made.workspace.workspace_id); await post(page,`/tenants/${made.tenant.tenant_id}/workspaces`,{name:'新方案區'});
  await open(page); await begin(page); await flow(page).getByRole('button',{name:'新方案區',exact:true}).click();
  await expect(flow(page).getByRole('radio',{name:/將共用既有的人工工作/})).toBeChecked();
  await page.route(url=>url.pathname===`/api/v1/tenants/${made.tenant.tenant_id}/application-launch-plans`,async route=>{
    const response=await route.fetch(); expect(response.status()).toBe(201); await route.fulfill({response,status:404,json:{code:'not_found',detail:'找不到這個模組實例。'}});
  });
  await flow(page).getByRole('button',{name:'產生啟動方案',exact:true}).click();
  await expect(flow(page).getByRole('radio',{name:/目前無法共用/})).toBeDisabled(); await expect(flow(page).getByRole('radio',{name:/目前無法共用/})).not.toBeChecked();
  await expect(flow(page)).toContainText('請選擇另一個可用實例，或建立獨立空白實例。');
  await expect(flow(page).getByRole('button',{name:'產生啟動方案',exact:true})).toBeDisabled();
  await flow(page).getByRole('radio',{name:'另建獨立空白的人工工作',exact:true}).check(); await expect(flow(page).getByRole('button',{name:'產生啟動方案',exact:true})).toBeEnabled();
});

test('My Work workspace selection leaves the independent launch panel and focus in place', async ({page,e2eAuthPool}) => {
  const userId=await member(e2eAuthPool,page); const made=await post(page,'/tenants',{display_name:'獨立選擇空間',workspace_name:'原選擇區'});
  await post(page,`/tenants/${made.tenant.tenant_id}/workspaces`,{name:'另一選擇區'});
  await open(page); await expect(page.locator('.my-work').getByRole('button',{name:'另一選擇區',exact:true})).toBeVisible();
  const acting=await page.evaluate(userId=>sessionStorage.getItem(`freedom-acting-tenant:${userId}`),userId);
  await begin(page); await flow(page).getByRole('button',{name:'另一選擇區',exact:true}).click();
  await expect(flow(page)).toContainText('目前業務空間：獨立選擇空間 · 擁有者／另一選擇區');
  expect(await page.evaluate(userId=>sessionStorage.getItem(`freedom-acting-tenant:${userId}`),userId)).toBe(acting);
  const switcher=page.locator('.my-work').getByRole('button',{name:'另一選擇區',exact:true}); await switcher.click();
  await expect(switcher).toBeFocused(); await expect(flow(page)).toBeVisible();
  await flow(page).getByRole('button',{name:'取消',exact:true}).click(); await expect(manualCard(page).getByRole('button',{name:'啟動應用',exact:true})).toBeFocused();
});

test('release detail retry repeats its failed action and retains catalog pages', async ({page}) => {
  let releases=0; let catalogs=0;
  await page.route('**/api/v1/applications?*',async route=>{catalogs++; await route.fallback();});
  await page.route('**/api/v1/applications/manual-workspace/releases/*',async route=>{
    releases++; const response=await route.fetch();
    if(releases===1) {await route.fulfill({response,status:503,contentType:'application/problem+json',json:{code:'dependency_unavailable',detail:'版本暫時無法讀取。'}}); return;}
    await route.fulfill({response});
  });
  await page.goto(`/#guilds/${GUILD}`); await manualCard(page).getByRole('button',{name:'版本資料',exact:true}).click();
  await expect(cards(page).getByRole('alert')).toContainText('服務暫時無法回應（503）。請稍後重試。'); await cards(page).getByRole('button',{name:'重試',exact:true}).click();
  await expect(cards(page)).toContainText('來源提交：'); expect(releases).toBe(2); expect(catalogs).toBe(1);
});

test('restore opens the newest readable row and removes only unavailable terminal outcomes', async ({page,e2eAuthPool}) => {
  const userId=await member(e2eAuthPool,page); const made=await post(page,'/tenants',{display_name:'逐筆還原空間',workspace_name:'第一還原區'});
  const second=await post(page,`/tenants/${made.tenant.tenant_id}/workspaces`,{name:'最新還原區'});
  const old=await launchApi(page,made.tenant.tenant_id,made.workspace.workspace_id);
  const newest=await launchApi(page,made.tenant.tenant_id,second.workspace_id);
  const removed={...old,key:randomUUID(),workspace_id:randomUUID()};
  await page.evaluate(({userId,rows,guild})=>sessionStorage.setItem(`freedom-application-launch:${userId}:${guild}`,JSON.stringify(rows)),{userId,rows:[old,newest,removed],guild:GUILD});
  await open(page); await expect(flow(page).getByRole('region',{name:'啟動進度',exact:true})).toContainText(newest.operation.operation_id);
  await expect(flow(page)).toContainText('逐筆還原空間 · 擁有者／最新還原區');
  const rows=JSON.parse(await page.evaluate(({userId,guild})=>sessionStorage.getItem(`freedom-application-launch:${userId}:${guild}`)!,{userId,guild:GUILD}));
  expect(rows).toHaveLength(2); expect(rows[0]).toEqual(old);
});

test('archived-only tenant shows an empty workspace sentence without registry requests', async ({page,e2eAuthPool},testInfo) => {
  await member(e2eAuthPool,page); const made=await post(page,'/tenants',{display_name:'等待工作區空間',workspace_name:'已封存區'});
  await e2eAuthPool.query("UPDATE workspaces SET status='archived',version=version+1 WHERE workspace_id=$1",[made.workspace.workspace_id]);
  const registry:string[]=[];
  page.on('request',request=>{const path=new URL(request.url()).pathname; if(path.startsWith(`/api/v1/tenants/${made.tenant.tenant_id}/`) && /\/(application-installations|module-instances|application-launch-plans)(\/|$)/.test(path)) registry.push(path);});
  await open(page); await begin(page);
  const sentence=flow(page).getByText('這個業務空間還沒有可用的工作區，請先到業務空間頁建立。',{exact:true});
  await expect(sentence).toBeVisible(); await expect(sentence).toHaveJSProperty('tagName','P');
  await expect(sentence.locator('..').locator(':scope > .application-actions').getByRole('link',{name:'前往業務空間',exact:true})).toHaveAttribute('href','#business');
  await expect(flow(page).getByRole('group',{name:'工作區',exact:true})).toHaveCount(0);
  await expect(flow(page).getByText('正在載入工作區…',{exact:true})).toHaveCount(0);
  await expect(flow(page).getByRole('button',{name:'產生啟動方案',exact:true})).toHaveCount(0);
  await capture(page,testInfo,'empty-workspace');
  expect(registry).toEqual([]);
});

test('business link from an empty workspace preserves unsaved My Work when leaving is declined', async ({page,e2eAuthPool}) => {
  const userId=await member(e2eAuthPool,page);
  const b=await post(page,'/tenants',{display_name:'保留草稿空間',workspace_name:'草稿區'});
  const a=await post(page,'/tenants',{display_name:'尚無工作區空間',workspace_name:'已封存區'});
  await launchApi(page,b.tenant.tenant_id,b.workspace.workspace_id);
  await e2eAuthPool.query("UPDATE workspaces SET status='archived',version=version+1 WHERE workspace_id=$1",[a.workspace.workspace_id]);
  await page.evaluate(({userId,b})=>sessionStorage.setItem(`freedom-acting-tenant:${userId}`,JSON.stringify({tenant_id:b.tenant.tenant_id,workspace_id:b.workspace.workspace_id})),{userId,b});
  await open(page); const title=page.locator('.my-work').locator('#my-work-title');
  await expect(title).toBeVisible(); await title.fill('離開前仍需保留的工作');
  await begin(page); await flow(page).getByRole('button',{name:'尚無工作區空間・擁有者',exact:true}).click();
  const link=flow(page).getByRole('link',{name:'前往業務空間',exact:true}); await expect(link).toBeVisible();
  page.once('dialog',dialog=>{expect(dialog.message()).toBe('有尚未儲存的內容，確定要離開嗎？'); void dialog.dismiss();});
  await link.click(); await expect(page).toHaveURL(new RegExp(`#guilds/${GUILD}$`));
  await expect(flow(page)).toBeVisible(); await expect(title).toHaveValue('離開前仍需保留的工作');
  page.once('dialog',dialog=>void dialog.accept()); await link.click(); await expect(page).toHaveURL(/#business$/);
});
