import {test,expect,type Page,type Route} from '@playwright/test';

const csrf='synthetic-admin-setup-csrf',state='s'.repeat(43),code='synthetic_manifest_code_2026';
const app={configured:true,app_id:'4242',app_slug:'synthetic-freedom-star',html_url:'https://github.com/apps/synthetic-freedom-star'};
const manifest={name:'synthetic-freedom-star',description:'Synthetic browser setup fixture',url:'http://127.0.0.1:4311',redirect_url:'http://127.0.0.1:4311/admin/github/callback',callback_urls:['http://127.0.0.1:4311/github/callback'],public:true,hook_attributes:{url:'http://127.0.0.1:4311/github/events',active:false},default_permissions:{starring:'write'}};
const target=`https://github.com/organizations/FreeTWAI-AI/settings/apps/new?state=${state}`;
type Call={path:string;method:string;body:unknown;headers:Record<string,string>};
async function adminFixtures(page:Page,options:{status?:()=>unknown;start?:(route:Route)=>Promise<void>;complete?:(route:Route)=>Promise<void>}={}){
  const calls:Call[]=[];
  // The only outbound navigation allowed by an individual test is fulfilled
  // locally below. No real GitHub app, grant, or Star can be created.
  await page.route('https://**',route=>route.abort());
  await page.route('**/admin/api/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname.replace('/admin/api','');
    calls.push({path,method:request.method(),body:request.method()==='POST'?request.postDataJSON():null,headers:request.headers()});
    if(path==='/bootstrap')return route.fulfill({json:{admin:{admin_id:'synthetic-admin',display_name:'測試管理員',email:'admin@example.test',role:'super_admin',community_id:'synthetic-community'},csrf_token:csrf,summary:{members:0,active_members:0,pending_guild_applications:0,guilds:0,admins:1},available_skill_books:[],pending_guild_appointments:[]}});
    if(path==='/members')return route.fulfill({json:{items:[],next_offset:null}});
    if(path==='/github-app')return route.fulfill({json:options.status?.()??{configured:false,setup_available:true}});
    if(path==='/github-app/start'&&options.start)return options.start(route);
    if(path==='/github-app/complete'&&options.complete)return options.complete(route);
    return route.fulfill({status:404,json:{detail:'Unexpected synthetic admin request.'}});
  });
  return calls;
}
async function openSetup(page:Page){await page.goto('/admin');await page.getByRole('button',{name:'GitHub 連結',exact:true}).click();await expect(page.getByRole('heading',{name:'啟用站內 Star',exact:true})).toBeVisible();}
function expectAdminCommand(call:Call){expect(call.method).toBe('POST');expect(call.headers['x-admin-csrf']).toBe(csrf);expect(call.headers['idempotency-key']).toBeTruthy();}

test('admin setup submits the manifest through native GitHub POST with only starring permission',async({page})=>{
  const calls=await adminFixtures(page,{start:route=>route.fulfill({json:{target,manifest:JSON.stringify(manifest)}})});
  const submissions:{method:string;navigation:boolean;contentType:string;fields:[string,string][]}[]=[];
  await page.route('https://github.com/organizations/FreeTWAI-AI/settings/apps/new?*',async route=>{
    const request=route.request();submissions.push({method:request.method(),navigation:request.isNavigationRequest(),contentType:request.headers()['content-type'],fields:[...new URLSearchParams(request.postData()??'').entries()]});
    await route.fulfill({contentType:'text/html',body:'<h1>Synthetic GitHub manifest review</h1>'});
  });
  await openSetup(page);await page.getByRole('button',{name:'建立 GitHub App',exact:true}).click();
  await expect(page).toHaveURL(target);await expect(page.getByRole('heading',{name:'Synthetic GitHub manifest review'})).toBeVisible();
  expect(submissions).toHaveLength(1);expect(submissions[0].method).toBe('POST');expect(submissions[0].navigation).toBe(true);expect(submissions[0].contentType).toContain('application/x-www-form-urlencoded');
  expect(submissions[0].fields.map(([name])=>name)).toEqual(['manifest']);
  const sent=JSON.parse(submissions[0].fields[0][1]);expect(sent).toEqual(manifest);expect(sent.default_permissions).toEqual({starring:'write'});expect(sent.default_events??[]).toEqual([]);expect(sent.hook_attributes.active).toBe(false);
  const commands=calls.filter(call=>call.method==='POST');expect(commands).toHaveLength(1);expect(commands[0].path).toBe('/github-app/start');expectAdminCommand(commands[0]);expect(commands[0].body).toEqual({});
});

test('admin callback clears sensitive query parameters and completes once across rerenders and tab visits',async({page})=>{
  let configured=false;
  const calls=await adminFixtures(page,{status:()=>configured?{...app,setup_available:true}:{configured:false,setup_available:true},complete:async route=>{
    expect(new URL(page.url()).pathname).toBe('/admin');expect(new URL(page.url()).search).toBe('');configured=true;await route.fulfill({json:app});
  }});
  await page.goto(`/admin/github/callback?code=${code}&state=${state}`);
  await expect(page).toHaveURL(/\/admin$/);await expect(page.getByRole('heading',{name:'站內 Star 已啟用',exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'synthetic-freedom-star ↗',exact:true})).toHaveAttribute('href',app.html_url);
  await expect(page.getByRole('button',{name:'建立 GitHub App',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'重新確認管理身分',exact:true}).click();await expect(page.getByRole('heading',{name:'站內 Star 已啟用',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'會員管理',exact:true}).click();await expect(page.getByRole('heading',{name:'會員管理',exact:true})).toBeVisible();await page.getByRole('button',{name:'GitHub 連結',exact:true}).click();await expect(page.getByRole('heading',{name:'站內 Star 已啟用',exact:true})).toBeVisible();
  const complete=calls.filter(call=>call.path==='/github-app/complete');expect(complete).toHaveLength(1);expectAdminCommand(complete[0]);expect(complete[0].body).toEqual({code,state});
  expect(calls.filter(call=>call.path==='/github-app/start')).toHaveLength(0);
  await expect(page.locator('body')).not.toContainText(code);await expect(page.locator('body')).not.toContainText(state);
});

test('setup start failure remains unconfigured and an explicit retry can submit the same safe manifest',async({page})=>{
  let starts=0;
  const calls=await adminFixtures(page,{start:route=>++starts===1?route.fulfill({status:503,json:{detail:'GitHub 設定服務暫時無法使用。'}}):route.fulfill({json:{target,manifest}})});
  await page.route('https://github.com/organizations/FreeTWAI-AI/settings/apps/new?*',route=>route.fulfill({contentType:'text/html',body:'<h1>Synthetic setup retry</h1>'}));
  await openSetup(page);await page.getByRole('button',{name:'建立 GitHub App',exact:true}).click();
  await expect(page.getByRole('alert')).toHaveText('GitHub 設定服務暫時無法使用。');await expect(page.getByRole('heading',{name:'站內 Star 已啟用',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'建立 GitHub App',exact:true})).toBeEnabled();expect(starts).toBe(1);
  await page.getByRole('button',{name:'建立 GitHub App',exact:true}).click();await expect(page).toHaveURL(target);expect(starts).toBe(2);
  const commands=calls.filter(call=>call.method==='POST');expect(commands).toHaveLength(2);commands.forEach(expectAdminCommand);expect(commands[0].headers['idempotency-key']).not.toBe(commands[1].headers['idempotency-key']);
});

test('failed callback stays unconfigured and returns to fresh setup without resubmitting the conversion code',async({page})=>{
  const calls=await adminFixtures(page,{complete:route=>route.fulfill({status:502,json:{detail:'GitHub App 尚未完成連線設定，請重新開始。'}})});
  await page.goto(`/admin/github/callback?code=${code}&state=${state}`);
  await expect(page).toHaveURL(/\/admin$/);await expect(page.getByRole('alert')).toHaveText('GitHub App 尚未完成連線設定，請重新開始。');
  await expect(page.getByRole('heading',{name:'站內 Star 已啟用',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'建立 GitHub App',exact:true})).toBeDisabled();
  await page.getByRole('link',{name:'返回後台',exact:true}).click();await page.getByRole('button',{name:'GitHub 連結',exact:true}).click();
  await expect(page.getByRole('button',{name:'建立 GitHub App',exact:true})).toBeEnabled();await expect(page.getByRole('alert')).toHaveCount(0);
  const completions=calls.filter(call=>call.path==='/github-app/complete');expect(completions).toHaveLength(1);expectAdminCommand(completions[0]);
  await page.goto(`/admin/github/callback?state=${state}`);await expect(page).toHaveURL(/\/admin$/);await expect(page.getByRole('alert')).toHaveText('GitHub App 建立未完成，請重新開始。');
  expect(calls.filter(call=>call.path==='/github-app/complete')).toHaveLength(1);await expect(page.getByRole('heading',{name:'站內 Star 已啟用',exact:true})).toHaveCount(0);
});

test('setup blocks an unexpected external form target and never presents it as successful',async({page})=>{
  await adminFixtures(page,{start:route=>route.fulfill({json:{target:'https://github.com.evil.invalid/organizations/FreeTWAI-AI/settings/apps/new',manifest}})});
  const outbound:string[]=[];page.on('request',request=>{if(new URL(request.url()).protocol==='https:')outbound.push(request.url());});
  await openSetup(page);await page.getByRole('button',{name:'建立 GitHub App',exact:true}).click();
  await expect(page.getByRole('alert')).toHaveText('GitHub 設定網址不正確。');await expect(page).toHaveURL(/\/admin$/);expect(outbound).toEqual([]);await expect(page.getByRole('button',{name:'建立 GitHub App',exact:true})).toBeEnabled();
});
