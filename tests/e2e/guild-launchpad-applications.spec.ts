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
async function begin(page: Page) {await cards(page).getByRole('button',{name:'啟動應用',exact:true}).click(); await expect(flow(page).getByRole('heading',{name:'啟動人工工作空間',exact:true})).toBeFocused();}
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

test('visitor sees application cards and public release details without launch controls', async ({page}) => {
  await page.route(url => !['127.0.0.1','localhost'].includes(url.hostname),route=>route.abort());
  await page.goto(`/#guilds/${GUILD}`); await expect(cards(page)).toContainText('可用');
  await cards(page).getByRole('button',{name:'版本資料',exact:true}).click();
  await expect(cards(page)).toContainText('來源提交：'); await expect(cards(page)).toContainText('成品摘要：');
  await expect(cards(page)).toContainText('人工工作：必要，允許共用既有實例');
  await expect(cards(page).getByRole('button',{name:'啟動應用',exact:true})).toHaveCount(0);
  await cards(page).getByRole('button',{name:'登入查看資格',exact:true}).click(); await expect(page.getByRole('heading',{name:'登入',exact:true})).toBeVisible();
});

test('intern keeps the card and the full-member reason with disabled launch', async ({page,e2eAuthPool}) => {
  await member(e2eAuthPool,page,'intern'); await open(page);
  await expect(cards(page)).toContainText('需要這個公會的正式會員身分');
  await expect(cards(page).getByRole('button',{name:'啟動應用',exact:true})).toBeDisabled();
  await cards(page).getByRole('button',{name:'版本資料',exact:true}).click(); await expect(cards(page)).toContainText('來源提交：');
});

test('catalog status mapping and pagination require the explicit load-more action', async ({page}) => {
  let reads=0;
  await page.route('**/api/v1/applications?*',async route=>{
    reads++; const url=new URL(route.request().url()); const next=url.searchParams.has('cursor'); url.searchParams.delete('cursor');
    const response=await route.fetch({url:url.toString()}); const body=await response.json(); const app=body.items[0];
    await route.fulfill({response,json:{...body,items:next?[{...app,application_key:'last-page',display_name:'最後一頁'}]:[
      app,{...app,application_key:'review-page',display_name:'審查版本',release_status:'reviewed'},
      {...app,application_key:'external-page',display_name:'外部版本',runtime_profiles:['external-supported']},
      {...app,application_key:'retired-page',display_name:'停用版本',release_status:'retired'},
    ],next_cursor:next?null:'synthetic-page'}});
  });
  await page.goto(`/#guilds/${GUILD}`); await expect(cards(page).locator('.application-card')).toHaveCount(4);
  for(const status of ['可用','審核中','外部／試用','停用／版本需更新']) await expect(cards(page).getByText(status,{exact:true})).toBeVisible();
  expect(reads).toBe(1); await cards(page).getByRole('button',{name:'載入更多',exact:true}).click();
  await expect(cards(page).locator('.application-card')).toHaveCount(5); expect(reads).toBe(2);
  await expect(cards(page).getByRole('button',{name:'載入更多',exact:true})).toHaveCount(0);
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
  await expect(flow(page).getByRole('radio',{name:'另建獨立空白的人工工作',exact:true})).toBeChecked();
  await flow(page).getByRole('radio',{name:/沿用這個安裝/}).check(); await review(page); await confirm(page);
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
  await review(page); await expect(flow(page)).toContainText('不增加實例容量'); await confirm(page);
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

test('quota rejection names the dimension and preserves existing work and choices', async ({page,e2eAuthPool}) => {
  await member(e2eAuthPool,page); const made=await post(page,'/tenants',{display_name:'容量測試空間',workspace_name:'既有區'});
  await launchApi(page,made.tenant.tenant_id,made.workspace.workspace_id);
  await post(page,`/tenants/${made.tenant.tenant_id}/workspaces`,{name:'額外區'});
  await e2eAuthPool.query(`INSERT INTO tenant_capacity_policies(policy_id,revision,tenant_id,plan_ref,max_active_instances,
    max_instances_per_module,max_concurrent_provisions,max_work_items,max_retained_bytes,max_concurrent_jobs,status)
    VALUES($1,1,$2,'synthetic-zero-instance-limit',0,0,2,1000,104857600,4,'active')`,[randomUUID(),made.tenant.tenant_id]);
  await open(page); await begin(page); await flow(page).getByRole('button',{name:'額外區',exact:true}).click();
  await flow(page).getByRole('radio',{name:'另建獨立空白的人工工作',exact:true}).check(); await review(page);
  await flow(page).getByRole('button',{name:'確認啟動',exact:true}).click();
  await expect(flow(page)).toContainText('容量維度：模組實例數'); await expect(flow(page)).toContainText('既有工作仍可使用');
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
    await page.evaluate(({userId,held,guild})=>sessionStorage.setItem(`freedom-application-launch:${userId}:${guild}`,JSON.stringify([held])),{userId,held,guild:GUILD});
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
  await member(e2eAuthPool,page); await post(page,'/tenants',{display_name:'鍵盤業務空間',workspace_name:'鍵盤區'}); await open(page);
  await page.emulateMedia({reducedMotion:'reduce'}); await page.setViewportSize({width:360,height:780});
  const launch=cards(page).getByRole('button',{name:'啟動應用',exact:true}); await launch.focus(); await page.keyboard.press('Enter');
  await expect(flow(page).getByRole('heading',{name:'啟動人工工作空間',exact:true})).toBeFocused();
  await page.keyboard.press('Escape'); await expect(launch).toBeFocused(); await page.keyboard.press('Enter');
  await page.keyboard.press('Tab'); await expect(flow(page).getByRole('button',{name:'取消',exact:true})).toBeFocused(); await page.keyboard.press('Enter'); await expect(launch).toBeFocused();
  await page.keyboard.press('Enter'); await expect(flow(page).getByRole('button',{name:'產生啟動方案',exact:true})).toBeEnabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const targets=await cards(page).locator('button,.application-choice').evaluateAll(elements=>elements.map(element=>element.getBoundingClientRect().height));
  for(const height of targets) expect(height).toBeGreaterThanOrEqual(44);
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

test('existing installation still requires a dependency decision when two instances are active', async ({page,e2eAuthPool}) => {
  await member(e2eAuthPool,page); const made=await post(page,'/tenants',{display_name:'明確沿用空間',workspace_name:'沿用目標區'});
  const other=await post(page,`/tenants/${made.tenant.tenant_id}/workspaces`,{name:'另一實例區'});
  await launchApi(page,made.tenant.tenant_id,made.workspace.workspace_id); await launchApi(page,made.tenant.tenant_id,other.workspace_id);
  await open(page); await begin(page); await flow(page).getByRole('button',{name:'沿用目標區',exact:true}).click();
  await expect(flow(page).getByRole('radio',{name:/將共用既有的人工工作/})).toHaveCount(2);
  await expect(flow(page).locator('input[name=dependency-work]:checked')).toHaveCount(0);
  await expect(flow(page).getByRole('button',{name:'產生啟動方案',exact:true})).toBeDisabled();
  const target=(await installations(page,made.tenant.tenant_id)).find(item=>item.workspace_id===made.workspace.workspace_id)!;
  await flow(page).getByRole('radio',{name:new RegExp(`將共用既有的人工工作.*${target.modules[0].instance_id.slice(-6)}`)}).check();
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
  await flow(page).getByRole('button',{name:'重新載入清單',exact:true}).click();
  await expect(flow(page).getByRole('button',{name:'產生啟動方案',exact:true})).toBeEnabled(); await review(page); await confirm(page);
});
