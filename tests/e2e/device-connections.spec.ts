// Frontend behavior only: mocked owner DTOs do not establish backend/TLS/SQL authority.
import {test,expect,type Page} from './fixtures.js';
import {startDevicePortal,installDeviceApi,deviceCode,deviceIds,deviceReview,deviceConnection,type DeviceWire} from './device-connections-visual.js';
let portal:Awaited<ReturnType<typeof startDevicePortal>>,harness:Awaited<ReturnType<typeof startDevicePortal>>;
test.beforeAll(async()=>{portal=await startDevicePortal();harness=await startDevicePortal(true);});
test.afterAll(async()=>{await portal?.close();await harness?.close();});
const code=(page:Page)=>page.getByRole('textbox',{name:'裝置配對代碼'});
const approve=(page:Page)=>page.getByRole('button',{name:'核准裝置',exact:true});
const consent=(page:Page)=>page.getByRole('checkbox',{name:'我確認這是我正在配對的裝置，並核准讀取 bootstrap 狀態。'});
const decisions=(calls:DeviceWire[])=>calls.filter(call=>call.path.endsWith('/decide'));
const revokes=(calls:DeviceWire[])=>calls.filter(call=>call.path.endsWith(':revoke'));
async function inspect(page:Page){await code(page).fill(deviceCode);await page.getByRole('button',{name:'讀取配對請求',exact:true}).click();await expect(page.getByText('Synthetic owner device',{exact:true})).toBeVisible();}
async function privateState(page:Page){expect(new URL(page.url()).search).toBe('');const stored=await page.evaluate(()=>JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage)]));expect(stored).not.toContain(deviceCode);expect(stored).not.toContain(deviceIds.authorization);}

test('frontend only: inspect never approves; exact review consent binds decision and code edits clear review',async({page})=>{
  const calls=await installDeviceApi(page,async()=>false);await page.goto(portal.origin+'/device');await inspect(page);
  expect(decisions(calls)).toHaveLength(0);await expect(approve(page)).toBeDisabled();await consent(page).check();await expect(approve(page)).toBeEnabled();
  await code(page).fill('ABCDE-FGHJK');await expect(page.getByText('Synthetic owner device',{exact:true})).toHaveCount(0);await expect(consent(page)).toHaveCount(0);expect(decisions(calls)).toHaveLength(0);
  await inspect(page);await expect(consent(page)).not.toBeChecked();await consent(page).check();await approve(page).click();await expect.poll(()=>decisions(calls).length).toBe(1);
  const wire=decisions(calls)[0];expect(JSON.parse(wire.body!)).toEqual({userCode:deviceCode,authorizationId:deviceIds.authorization,requestDigest:'A'.repeat(43),decision:'approve'});expect(wire.key).toMatch(/^[a-zA-Z0-9_-]{8,128}$/);expect(wire.cas).toBeUndefined();expect(wire.csrf).toBe('fixture-csrf');await privateState(page);
});

test('frontend only: uncertain approve locks code; refresh reads only; explicit confirmation preserves original wire',async({page})=>{
  let count=0;const calls=await installDeviceApi(page,async(route,_request,wire)=>{if(wire.path.endsWith('/decide')&&++count===1){await route.fulfill({status:503,json:{detail:'RAW_PRIVATE_UNTRUSTED_ERROR',code:'fixture_unavailable'}});return true;}return false;});
  await page.goto(portal.origin+'/device');await inspect(page);await consent(page).check();await approve(page).click();await expect(page.getByRole('button',{name:'確認原裝置操作',exact:true})).toBeEnabled();await expect(code(page)).toBeDisabled();
  await page.getByRole('button',{name:'重新讀取裝置與連線',exact:true}).click();await expect.poll(()=>calls.filter(c=>c.path.endsWith('/inspect')).length).toBe(2);expect(decisions(calls)).toHaveLength(1);await expect(code(page)).toBeDisabled();await expect(page.getByText('RAW_PRIVATE_UNTRUSTED_ERROR')).toHaveCount(0);
  await page.getByRole('button',{name:'確認原裝置操作',exact:true}).click();await expect.poll(()=>decisions(calls).length).toBe(2);expect(decisions(calls)[1]).toEqual(decisions(calls)[0]);await privateState(page);
});

test('frontend only: uncertain revoke preserves original CAS/key across a newer owner read',async({page})=>{
  let version='7',writes=0;const calls=await installDeviceApi(page,async(route,_request,wire)=>{
    if(wire.path.endsWith(':revoke')){writes++;if(writes===1){version='8';await route.fulfill({status:503,json:{code:'fixture_unavailable'}});}else await route.fulfill({json:deviceConnection('9','revoked')});return true;}
    if(wire.path.endsWith('/'+deviceIds.connection)){await route.fulfill({json:deviceConnection(version)});return true;}return false;});
  await page.goto(portal.origin+'/device');await page.getByRole('combobox',{name:'管理的裝置連線'}).selectOption(deviceIds.connection);await page.getByRole('checkbox',{name:'我確認撤銷目前選取的裝置連線。'}).check();await page.getByRole('button',{name:'撤銷裝置連線',exact:true}).click();await expect(page.getByRole('button',{name:'確認原撤銷操作',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'重新讀取裝置與連線',exact:true}).click();await expect.poll(()=>calls.filter(c=>c.path.endsWith('/'+deviceIds.connection)).length).toBe(2);expect(revokes(calls)).toHaveLength(1);
  await page.getByRole('button',{name:'確認原撤銷操作',exact:true}).click();await expect.poll(()=>revokes(calls).length).toBe(2);expect(revokes(calls)[0].cas).toBe('"7"');expect(revokes(calls)[0].body).toBe('{}');expect(revokes(calls)[1]).toEqual(revokes(calls)[0]);
});

test('frontend only: replacing client unlocks old inflight operation and fences its late result and parent callback',async({page})=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);let held=false;
  const calls=await installDeviceApi(page,async(route,request,wire)=>{if(wire.path.endsWith('/decide')&&wire.csrf==='first-client-fixture'){held=true;await gate;const body=request.postDataJSON();await route.fulfill({json:{authorizationId:body.authorizationId,requestDigest:body.requestDigest,state:'approved',operational_authority:false}});return true;}return false;});
  await page.goto(harness.origin);await inspect(page);await consent(page).check();await approve(page).click();await expect.poll(()=>held).toBe(true);await expect(code(page)).toBeDisabled();
  await page.getByRole('button',{name:'Replace client fixture'}).click();await expect(code(page)).toBeEnabled();await expect(code(page)).toHaveValue('');const oldResponse=page.waitForResponse(response=>response.url().endsWith('/decide'));release();await oldResponse;await expect(page.getByLabel('Parent change count')).toHaveText('0');await expect(page.getByText('已核准此裝置讀取 bootstrap 狀態。',{exact:false})).toHaveCount(0);
  await inspect(page);await consent(page).check();await approve(page).click();await expect(page.getByLabel('Parent change count')).toHaveText('1');expect(decisions(calls)).toHaveLength(2);expect(decisions(calls)[1].csrf).toBe('second-client-fixture');
});

test('frontend only: replacing client clears old unresolved command, review, consent and code',async({page})=>{
  const calls=await installDeviceApi(page,async(route,_request,wire)=>{if(wire.path.endsWith('/decide')){await route.fulfill({status:503,json:{code:'fixture_unavailable'}});return true;}return false;});
  await page.goto(harness.origin);await inspect(page);await consent(page).check();await approve(page).click();await expect(page.getByRole('button',{name:'確認原裝置操作'})).toBeVisible();
  await page.getByRole('button',{name:'Replace client fixture'}).click();await expect(code(page)).toHaveValue('');await expect(code(page)).toBeEnabled();await expect(page.getByRole('button',{name:'確認原裝置操作'})).toHaveCount(0);await expect(consent(page)).toHaveCount(0);await expect(page.getByText('Synthetic owner device',{exact:true})).toHaveCount(0);expect(decisions(calls)).toHaveLength(1);await privateState(page);
});

test('frontend only: expired valid review and invalid purpose/open DTO never enable approval',async({page})=>{
  let payload:any={...deviceReview(),expiresAt:'2000-01-01T00:00:00.000Z'};
  const calls=await installDeviceApi(page,async(route,_request,wire)=>{if(wire.path.endsWith('/inspect')){await route.fulfill({json:payload});return true;}return false;});
  await page.goto(portal.origin+'/device');await inspect(page);await expect(page.getByText('這次配對請求已到期。請在裝置上重新開始配對。')).toBeVisible();await expect(approve(page)).toHaveCount(0);
  for(const invalid of [{...deviceReview(),scope:'execution.run'},{...deviceReview(),extra:'RAW_PRIVATE_UNTRUSTED_ERROR'}]){payload=invalid;const inspected=page.waitForResponse(response=>response.url().endsWith('/inspect'));await page.getByRole('button',{name:'讀取配對請求',exact:true}).click();await inspected;await expect(page.getByRole('button',{name:'讀取配對請求',exact:true})).toBeEnabled();await expect(page.getByText('Synthetic owner device',{exact:true})).toHaveCount(0);await expect(approve(page)).toHaveCount(0);await expect(page.getByText('RAW_PRIVATE_UNTRUSTED_ERROR')).toHaveCount(0);}
  expect(decisions(calls)).toHaveLength(0);
});
