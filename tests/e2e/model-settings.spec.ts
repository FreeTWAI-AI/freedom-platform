import { test, expect, type Page } from './fixtures.js';
import { installVisualApi, startVisualPortal, visualCredential, visualHandoff, visualIds, visualModel, visualOverview } from './model-settings-visual.js';

// These are UI behavior and presentation tests with mocked owner DTOs. The
// separate authenticated HTTPS/SQL broker suite covers actual authority.
let portal:Awaited<ReturnType<typeof startVisualPortal>>,clientPortal:Awaited<ReturnType<typeof startVisualPortal>>;
test.beforeAll(async()=>{portal=await startVisualPortal();clientPortal=await startVisualPortal(true);});
test.afterAll(async()=>{await portal?.close();await clientPortal?.close();});
test.use({ignoreHTTPSErrors:true});
async function open(page:Page,overview=visualOverview()) {
  await installVisualApi(page,()=>overview);await page.goto(portal.origin+'/#private-ai');
  await expect(page.getByRole('heading',{name:'模型與憑證設定',exact:true})).toBeVisible();
  await expect(page.getByRole('combobox',{name:'管理的模型設定',exact:true})).toBeVisible();
  return page.getByRole('region',{name:'模型與憑證設定',exact:true});
}
async function captureConsent(page:Page) {
  await page.getByRole('combobox',{name:'管理的模型設定',exact:true}).selectOption(visualIds.model);
  await page.getByRole('checkbox',{name:/我同意為 openai/}).check();
}
test('owner settings remain separate from unavailable work and retain the brand at three widths',async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const overview=visualOverview();overview.credentials=[visualCredential()];const region=await open(page,overview);
  await region.getByText('新增模型設定',{exact:true}).click();
  await region.getByRole('combobox',{name:'設定的執行連線',exact:true}).selectOption(visualIds.connection);
  await region.getByRole('combobox',{name:'設定的供應商與模型',exact:true}).selectOption('0');
  await region.getByRole('combobox',{name:'管理的模型設定',exact:true}).selectOption(visualIds.model);
  await region.getByRole('combobox',{name:'原憑證紀錄',exact:true}).selectOption(visualIds.credential);
  await expect(region).toContainText('已保管 · 尚未驗證');
  await expect(region.locator('input[type=password],input[type=file],textarea')).toHaveCount(0);
  await expect(page.getByText('模型執行服務目前無法使用。尚未確認供應商登入、模型可用性或費用。',{exact:true})).toBeVisible();
  for(const [width,height] of [[390,844],[768,1024],[1440,900]]){
    await page.setViewportSize({width,height});await page.evaluate(()=>scrollTo(0,0));
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await expect(page.locator('.sidebar-brand-art')).toBeVisible();
    await page.screenshot({path:info.outputPath(`model-settings-after-${width}.png`),fullPage:true});
    await page.screenshot({path:info.outputPath(`model-settings-after-viewport-${width}.png`)});
  }
  expect(errors).toEqual([]);
});
test('handoff is one same-tab top-level form POST with one assertion field and no storage or DOM retention',async({page})=>{
  const region=await open(page),issued:unknown[]=[];let brokerPosts=0;
  await page.route('**/api/v1/me/credential-ingests',async route=>{issued.push(route.request().postDataJSON());await route.fulfill({json:visualHandoff()});});
  await page.route('https://broker.example.test/credential-setup',async route=>{
    brokerPosts++;const request=route.request();expect(request.isNavigationRequest()).toBe(true);expect(request.method()).toBe('POST');
    expect(request.headers()['content-type']).toContain('application/x-www-form-urlencoded');
    expect([...new URLSearchParams(request.postData()!).entries()]).toEqual([['assertion',visualHandoff().assertion]]);
    expect(request.headers()['origin']).toBe(portal.origin);
    expect(request.headers()['referer']).toBe(portal.origin+'/');
    await route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Mocked broker navigation only</title><p>UI fixture</p>'});
  });
  await captureConsent(page);await region.getByRole('button',{name:'前往金鑰保管頁',exact:true}).click();
  await expect(page).toHaveURL('https://broker.example.test/credential-setup');expect(brokerPosts).toBe(1);
  expect(issued).toEqual([{operation:'create',modelConnectionId:visualIds.model,consent:true}]);
  await page.goBack();
  expect(await page.locator('input[name=assertion]').count()).toBe(0);
  const stored=await page.evaluate(()=>JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage)]));expect(stored).not.toContain(visualHandoff().assertion);
  expect(issued).toHaveLength(1);
});
test('expired, foreign and open handoffs never navigate or retain the assertion',async({page})=>{
  let brokerPosts=0;await page.route('https://broker.example.test/**',async route=>{brokerPosts++;await route.abort();});
  for(const change of [{expiresAt:new Date(Date.now()-1000).toISOString()},{setupOrigin:'https://foreign.example.test'},
    {setupOrigin:'https://broker.example.test/?handoff=bad'},{unexpected:true},{expiresAt:new Date(Date.now()+120_000).toISOString()}]){
    await page.goto('about:blank');await page.unroute('**/api/v1/**');const region=await open(page);
    await page.route('**/api/v1/me/credential-ingests',async route=>route.fulfill({json:{...visualHandoff(),...change}}));
    await captureConsent(page);await region.getByRole('button',{name:'前往金鑰保管頁',exact:true}).click();
    await expect(region.getByRole('alert')).toContainText('結果尚未確認');
    await expect(region.getByRole('button',{name:'前往金鑰保管頁',exact:true})).toBeDisabled();
    expect(new URL(page.url()).hostname).toBe('127.0.0.1');expect(await page.locator('input[name=assertion]').count()).toBe(0);
  }
  expect(brokerPosts).toBe(0);
});
test('unknown issue keeps the original command and CAS for manual confirmation without a second automatic handoff',async({page})=>{
  const region=await open(page),requests:{body:string|null;key:string;version:string}[]=[];let navigations=0;
  await page.route('https://broker.example.test/**',async route=>{navigations++;await route.abort();});
  await page.route('**/api/v1/me/credential-ingests',async route=>{
    const request=route.request();requests.push({body:request.postData(),key:request.headers()['idempotency-key'],version:request.headers()['if-match']});
    await route.fulfill(requests.length===1?{status:503,json:{code:'fixture_lost_response'}}:{json:visualHandoff()});
  });
  await captureConsent(page);await region.getByRole('button',{name:'前往金鑰保管頁',exact:true}).click();
  await expect(region.getByRole('button',{name:'確認原設定請求',exact:true})).toBeVisible();expect(requests).toHaveLength(1);
  await region.getByRole('button',{name:'重新讀取模型設定',exact:true}).click();expect(requests).toHaveLength(1);
  await region.getByRole('button',{name:'確認原設定請求',exact:true}).click();
  await expect(region.getByRole('button',{name:'確認原設定請求',exact:true})).toHaveCount(0);
  expect(requests).toHaveLength(2);expect(requests[1]).toEqual(requests[0]);expect(navigations).toBe(0);
  expect(await page.evaluate(()=>JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage)]))).not.toContain(requests[0].key);
});
test('manual confirmation of an expired cached issue clears pending and reads owner outcome without navigation',async({page})=>{
  const region=await open(page);let issues=0,reads=0,posts=0;
  await page.route('**/api/v1/me/credential-ingests',async route=>{issues++;await route.fulfill(issues===1?{status:503,json:{code:'fixture_lost_response'}}
    :{json:{...visualHandoff(),expiresAt:new Date(Date.now()-1000).toISOString()}});});
  await page.route('**/api/v1/me/credential-ingests/*',async route=>{reads++;await route.fulfill({json:{authorizationRef:visualIds.authorization,operation:'create',state:'issued',credential:null,operational_authority:false}});});
  await page.route('https://broker.example.test/**',async route=>{posts++;await route.abort();});
  await captureConsent(page);await region.getByRole('button',{name:'前往金鑰保管頁',exact:true}).click();
  await region.getByRole('button',{name:'確認原設定請求',exact:true}).click();
  await expect(region.getByRole('button',{name:'確認原設定請求',exact:true})).toHaveCount(0);
  expect(issues).toBe(2);expect(reads).toBe(1);expect(posts).toBe(0);
});
test('replacing the client clears the original pending command and cannot send it under the new client',async({page})=>{
  await installVisualApi(page,visualOverview);await page.goto(clientPortal.origin);
  const region=page.getByRole('region',{name:'模型與憑證設定',exact:true});
  await page.route('**/api/v1/me/credential-ingests',async route=>route.fulfill({status:503,json:{code:'fixture_lost_response'}}));
  await captureConsent(page);await region.getByRole('button',{name:'前往金鑰保管頁',exact:true}).click();
  await expect(region.getByRole('button',{name:'確認原設定請求',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Replace client fixture',exact:true}).click();
  await expect(region.getByRole('button',{name:'確認原設定請求',exact:true})).toHaveCount(0);
  await expect(region.getByRole('combobox',{name:'管理的模型設定',exact:true})).toBeEnabled();
});
test('replacing the client during an old request releases the UI lock and discards its late handoff',async({page})=>{
  await installVisualApi(page,visualOverview);await page.goto(clientPortal.origin);
  const region=page.getByRole('region',{name:'模型與憑證設定',exact:true});
  let release:()=>void=()=>{},entered:()=>void=()=>{},posts=0;
  const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  await page.route('**/api/v1/me/credential-ingests',async route=>{entered();await gate;await route.fulfill({json:visualHandoff()});});
  await page.route('https://broker.example.test/**',async route=>{posts++;await route.abort();});
  await captureConsent(page);await region.getByRole('button',{name:'前往金鑰保管頁',exact:true}).click();await started;
  await page.getByRole('button',{name:'Replace client fixture',exact:true}).click();
  try {await expect(region.getByRole('combobox',{name:'管理的模型設定',exact:true})).toBeEnabled({timeout:1000});}
  finally {const response=page.waitForResponse('**/api/v1/me/credential-ingests');release();await response;}
  expect(posts).toBe(0);await expect(region.getByRole('button',{name:'確認原設定請求',exact:true})).toHaveCount(0);
});
test('model creation and revocation require separate consent and an unknown creation keeps its original key and version',async({page})=>{
  const overview=visualOverview();overview.models=[];const region=await open(page,overview);
  const creates:{body:unknown;key:string;version:string}[]=[],revokes:{body:unknown;version:string}[]=[];
  await page.route('**/api/v1/me/model-connections',async route=>{
    const request=route.request();creates.push({body:request.postDataJSON(),key:request.headers()['idempotency-key'],version:request.headers()['if-match']});
    if(creates.length===1)await route.fulfill({status:503,json:{code:'fixture_lost_response'}});
    else {overview.models=[visualModel()];await route.fulfill({json:overview.models[0]});}
  });
  await page.route('**/api/v1/me/model-connections/*:revoke',async route=>{
    revokes.push({body:route.request().postDataJSON(),version:route.request().headers()['if-match']});
    overview.models=[{...visualModel(),state:'revoked',aggregateVersion:'2'}];overview.credentials=[visualCredential()];
    await route.fulfill({json:overview.models[0]});
  });
  await region.getByText('新增模型設定',{exact:true}).click();
  await region.getByRole('combobox',{name:'設定的執行連線',exact:true}).selectOption(visualIds.connection);
  await region.getByRole('combobox',{name:'設定的供應商與模型',exact:true}).selectOption('0');
  await expect(region.getByRole('button',{name:'建立模型設定',exact:true})).toBeDisabled();
  await region.getByRole('checkbox',{name:'我確認保存以上連線與模型選擇；這不代表模型已登入或可執行。',exact:true}).check();
  await region.getByRole('button',{name:'建立模型設定',exact:true}).click();
  await expect(region.getByRole('button',{name:'確認原設定請求',exact:true})).toBeVisible();expect(creates).toHaveLength(1);
  await region.getByRole('button',{name:'重新讀取模型設定',exact:true}).click();expect(creates).toHaveLength(1);
  await region.getByRole('button',{name:'確認原設定請求',exact:true}).click();
  await expect(region.getByRole('combobox',{name:'管理的模型設定',exact:true})).toHaveValue(visualIds.model);
  expect(creates).toHaveLength(2);expect(creates[1]).toEqual(creates[0]);expect(creates[0].version).toBe('"3"');
  await region.getByText('撤銷這個模型設定',{exact:true}).click();
  await expect(region.getByRole('button',{name:'撤銷模型設定',exact:true})).toBeDisabled();
  await region.getByRole('checkbox',{name:'我確認撤銷目前選取的模型設定。',exact:true}).check();
  await region.getByRole('button',{name:'撤銷模型設定',exact:true}).click();
  await expect(region).toContainText('模型已撤銷，金鑰仍保管。');expect(revokes).toEqual([{body:{},version:'"1"'}]);
});
test('a late issue response after leaving the component never initiates broker navigation',async({page})=>{
  const region=await open(page);let release:()=>void=()=>{},entered:()=>void=()=>{},brokerPosts=0;
  const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  await page.route('**/api/v1/me/credential-ingests',async route=>{entered();await gate;await route.fulfill({json:visualHandoff()});});
  await page.route('https://broker.example.test/**',async route=>{brokerPosts++;await route.abort();});
  await captureConsent(page);await region.getByRole('button',{name:'前往金鑰保管頁',exact:true}).click();await started;
  await page.evaluate(()=>{location.hash='home';});await expect(region).toHaveCount(0);release();
  await page.waitForResponse('**/api/v1/me/credential-ingests');expect(brokerPosts).toBe(0);expect(await page.locator('input[name=assertion]').count()).toBe(0);
});
test('rotation sends both original credential and replacement model versions with explicit consent',async({page})=>{
  const overview=visualOverview();overview.models.push(visualModel(visualIds.replacement,'9'));overview.credentials=[visualCredential()];
  const region=await open(page,overview);let command:any,primaryVersion:string|undefined;
  await page.route('**/api/v1/me/credential-ingests',async route=>{command=route.request().postDataJSON();primaryVersion=route.request().headers()['if-match'];await route.fulfill({json:visualHandoff()});});
  await page.route('https://broker.example.test/credential-setup',async route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Rotation UI fixture</title>'}));
  await region.getByRole('combobox',{name:'原憑證紀錄',exact:true}).selectOption(visualIds.credential);
  await region.getByRole('combobox',{name:'輪替後的模型設定',exact:true}).selectOption(visualIds.replacement);
  await expect(region.getByRole('button',{name:'前往金鑰輪替頁',exact:true})).toBeDisabled();
  await region.getByRole('checkbox',{name:'我確認以選取的新模型設定輪替原憑證，並前往獨立保管頁另行確認。',exact:true}).check();
  await region.getByRole('button',{name:'前往金鑰輪替頁',exact:true}).click();await expect(page).toHaveURL('https://broker.example.test/credential-setup');
  expect(primaryVersion).toBe('"7"');expect(command).toEqual({operation:'rotate',credentialId:visualIds.credential,
    replacementModelConnectionId:visualIds.replacement,expectedReplacementModelVersion:'9',consent:true});
});
test('withdrawn setup and expired credentials keep truthful history without exposing fake termination or key controls',async({page})=>{
  const overview=visualOverview();overview.setup={state:'unavailable'};overview.selectionOptions=[];
  overview.credentials=[{...visualCredential(),expiresAt:new Date(Date.now()-1000).toISOString()}];overview.models[0]={...overview.models[0],state:'revoked'};
  const region=await open(page,overview);await region.getByRole('combobox',{name:'管理的模型設定',exact:true}).selectOption(visualIds.model);
  await expect(region).toContainText('模型已撤銷，金鑰仍保管。');await expect(region).toContainText('已到期');
  await expect(region.getByRole('button',{name:/前往金鑰/})).toHaveCount(0);
  await expect(region.getByRole('button',{name:/撤銷憑證|刪除金鑰/})).toHaveCount(0);
  await expect(region.locator('input[type=password],input[type=file],textarea')).toHaveCount(0);
});
test('maximum-length catalog and history labels fit all three widths without runtime or token console leakage',async({page})=>{
  const overview=visualOverview(),selection={...overview.selectionOptions[0],modelRef:'synthetic-'+ 'm'.repeat(86)};
  overview.selectionOptions=[selection];overview.models=[{...visualModel(),selection}];overview.credentials=[{...visualCredential(),selection}];
  const errors:string[]=[],consoleMessages:string[]=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>consoleMessages.push(message.text()));
  const region=await open(page,overview);await region.getByText('新增模型設定',{exact:true}).click();
  await region.getByRole('combobox',{name:'設定的供應商與模型',exact:true}).selectOption('0');
  await region.getByRole('combobox',{name:'管理的模型設定',exact:true}).selectOption(visualIds.model);
  await region.getByRole('combobox',{name:'原憑證紀錄',exact:true}).selectOption(visualIds.credential);
  for(const [width,height]of [[390,844],[768,1024],[1440,900]]){
    await page.setViewportSize({width,height});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect(await region.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  }
  expect(errors).toEqual([]);expect(consoleMessages.join('\n')).not.toContain(visualHandoff().assertion);
  expect(consoleMessages.join('\n')).not.toContain(visualIds.authorization);
});
