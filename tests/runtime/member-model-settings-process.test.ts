import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import type {Page} from '@playwright/test';
import {settingsFixture,httpsFetch} from './member-model-settings-helpers.js';
import {MemberModelSettingsOverviewSchema} from '../../contracts/execution/v2/member-model-settings.js';

async function createModel(page:Page,connectionId:string){
 const panel=page.getByRole('region',{name:'模型與憑證設定'});
 await panel.getByText('新增模型設定',{exact:true}).click();
 await panel.getByLabel('設定的執行連線').selectOption(connectionId);
 await panel.getByLabel('設定的供應商與模型').selectOption('0');
 await panel.getByRole('checkbox',{name:'我確認保存以上連線與模型選擇；這不代表模型已登入或可執行。',exact:true}).check();
 const response=page.waitForResponse(value=>value.url().endsWith('/api/v1/me/model-connections')&&value.request().method()==='POST');
 await panel.getByRole('button',{name:'建立模型設定',exact:true}).click();const metadata=await(await response).json();
 await panel.getByText('模型設定已建立，尚未驗證。請選取設定，再明確同意前往金鑰保管頁。',{exact:true}).waitFor();
 return metadata.modelConnectionId as string;
}
async function safeClientState(page:Page,secret:string,assertions:string[],logs:string[]){
 const state=await page.evaluate(()=>({html:document.documentElement.outerHTML,local:JSON.stringify({...localStorage}),session:JSON.stringify({...sessionStorage}),url:location.href}));
 for(const value of [secret,...assertions]){for(const text of [state.html,state.local,state.session,state.url,...logs])assert(!text.includes(value),'Sensitive value retained in browser-visible main state');}
}
async function captureEmpty(page:Page,prefix:string){
 await mkdir('.freedom/reports/member-model-settings/screenshots',{recursive:true});
 for(const width of [390,768,1440]){await page.setViewportSize({width,height:960});await page.screenshot({path:`.freedom/reports/member-model-settings/screenshots/${prefix}-${width}.png`,fullPage:true});}
}

// One exclusive form submission per call. Browser delivery is not custody truth;
// wait for the genuine fixture handler, then read this exact authorization once.
async function submitSetup(f:Awaited<ReturnType<typeof settingsFixture>>,member:Awaited<ReturnType<Awaited<ReturnType<typeof settingsFixture>>['member']>>,page:Page,ref:string){
 assert.match(ref,/^[0-9a-f-]{36}$/);
 const baseline=(await f.broker.request('snapshot',undefined,10000)).requests.length;
 await page.locator('#credential-key').fill(f.secret);await page.locator('#credential-consent').check();await page.locator('#credential-submit').click();
 const deadline=performance.now()+10000;
 await page.locator('#credential-status[data-error="true"]').or(page.locator('#credential-status').filter({hasText:'已收到設定服務回覆'})).waitFor({timeout:10000});
 assert(performance.now()<deadline);
 assert.equal(await page.locator('#credential-key').inputValue({timeout:Math.max(1,deadline-performance.now())}),'');
 assert(performance.now()<deadline);
 assert.equal(await page.locator('#credential-submit').isDisabled({timeout:Math.max(1,deadline-performance.now())}),true);
 let settled=false;
 while(performance.now()<deadline){
  const requests=(await f.broker.request('snapshot',undefined,Math.max(1,deadline-performance.now()))).requests.slice(baseline);
  const secret=requests.filter((r:any)=>r.path==='/credential-setup/secret'&&r.method==='POST'),prepare=requests.filter((r:any)=>r.path==='/credential-setup/prepare'&&r.method==='POST');
  assert(secret.length<=1);assert(prepare.length<=1);
  if(secret.length===1&&secret[0].settled===true||secret.length===0&&prepare.length===1&&prepare[0].settled===true&&prepare[0].status!==200){settled=true;break;}
  await delay(Math.min(10,Math.max(0,deadline-performance.now())));
 }
 assert(settled,'Fixture broker completion unavailable');
 const outcome=await f.get(member,'/api/v1/me/credential-ingests/'+ref);assert.equal(outcome.status,200);
 assert.equal((await outcome.json() as any).state,'committed');
}

for(const lateReply of [false,true])test('MODEL-SETTINGS-PROCESS '+(lateReply?'delayed secret ACK ':'')+'actual built parent portal creates model, sends broker-only key, reads owner history and rotates replacement',{timeout:120000},async()=>{
 const f=await settingsFixture();const deliveries:Promise<void>[]=[];try{
  const member=await f.member(),initial=await f.paired(member),context=await f.browserContext(member),page=await context.newPage();
  if(lateReply)await page.route(f.setupOrigin+'/credential-setup/secret',route=>{
   const delivery=(async()=>{const request=route.request();const response=await httpsFetch(request.url(),{method:'POST',headers:await request.allHeaders(),body:request.postDataBuffer()!});assert.equal(response.status,200);const body=await response.text();await delay(6000);await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body}).catch(()=>{});})();deliveries.push(delivery);return delivery;
  });
  const logs:string[]=[],assertions:string[]=[],refs:string[]=[];page.on('console',message=>logs.push(message.text()));page.on('pageerror',error=>logs.push(error.message));
  page.on('request',request=>{if(request.url()===f.setupOrigin+'/credential-setup'&&request.method()==='POST'){const fields=new URLSearchParams(request.postData()!);assert.deepEqual([...fields.keys()],['assertion']);const assertion=fields.get('assertion')!;assertions.push(assertion);refs.push(JSON.parse(Buffer.from(assertion.split('.')[1],'base64url').toString('utf8')).authorizationRef);}});
  const html=await page.goto(f.mainOrigin+'/#private-ai');assert.equal(html?.status(),200);assert.equal(html!.headers()['referrer-policy'],'strict-origin');const csp=html!.headers()['content-security-policy'];assert(csp.includes(`form-action 'self' ${f.setupOrigin}`));
  const panel=page.getByRole('region',{name:'模型與憑證設定'});await panel.getByRole('button',{name:'重新讀取模型設定',exact:true}).waitFor();
  assert.equal(await panel.locator('input[type=password]').count(),0);
  const originalModel=await createModel(page,initial.connectionId);await captureEmpty(page,'main-model-created');
  await panel.getByRole('checkbox',{name:'我同意為 openai / synthetic-model 前往獨立保管頁，另行輸入金鑰並確認加密保管。',exact:true}).check();
  const navigation=page.waitForURL(f.setupOrigin+'/credential-setup');await panel.getByRole('button',{name:'前往金鑰保管頁',exact:true}).click();await navigation;
  const key=page.locator('#credential-key');
  try{await key.waitFor({timeout:8000});}catch(error){const snapshot=await f.broker.request('snapshot');await mkdir('.freedom/reports/member-model-settings',{recursive:true});await writeFile('.freedom/reports/member-model-settings/handoff-first-red.json',JSON.stringify({mainReferrerPolicy:html!.headers()['referrer-policy'],brokerRequests:snapshot.requests,htmlStatus:html!.status()},null,2));throw error;}
  assert.equal(await key.inputValue(),'');await captureEmpty(page,'broker-create-empty');
  await submitSetup(f,member,page,refs[0]);if(lateReply)assert.equal(await page.locator('#credential-status').getAttribute('data-error'),'true');
  const stored=(await f.owner.query('SELECT credential_id,state FROM broker_model_credentials WHERE model_connection_id=$1',[originalModel])).rows;assert.equal(stored.length,1);assert.equal(stored[0].state,'active');
  const firstCredential=stored[0].credential_id;const foreign=await f.member();assert.equal((await f.get(foreign,'/api/v1/me/model-credentials/'+firstCredential)).status,404);assert.equal((await f.owner.query('SELECT count(*)::int n FROM broker_credential_vault')).rows[0].n,1);assert.equal(f.posts.length,0);
  const native=await f.broker.request('snapshot');const bootstrap=native.requests.find((request:any)=>request.path==='/credential-setup');assert.equal(bootstrap.origin,f.mainOrigin);assert.equal(bootstrap.status,200);assert(native.requests.every((request:any)=>!String(request.cookie).includes('freedom_local_session')));assert(native.reads.every((read:any)=>read.cleared));assert.equal(native.requests.filter((request:any)=>request.path==='/credential-setup/secret').length,1);
  const parent=await f.main.request('snapshot');for(const forbidden of ['secret','kekBytes','cipherUrl','providerOrigin'])assert(!parent.configKeys.includes(forbidden));assert(!f.main.logs().includes(f.secret));
  await page.goto(f.mainOrigin+'/#private-ai');await panel.getByRole('button',{name:'重新讀取模型設定',exact:true}).waitFor();await safeClientState(page,f.secret,assertions,logs);
  const replacement=await createModel(page,initial.connectionId);
  await panel.getByLabel('原憑證紀錄').selectOption(firstCredential);
  await panel.getByLabel('輪替後的模型設定').selectOption(replacement);
  await panel.getByRole('checkbox',{name:'我確認以選取的新模型設定輪替原憑證，並前往獨立保管頁另行確認。',exact:true}).check();
  const rotateNavigation=page.waitForURL(f.setupOrigin+'/credential-setup');await panel.getByRole('button',{name:'前往金鑰輪替頁',exact:true}).click();await rotateNavigation;await key.waitFor();
  await submitSetup(f,member,page,refs[1]);if(lateReply)assert.equal(await page.locator('#credential-status').getAttribute('data-error'),'true');
  const history=MemberModelSettingsOverviewSchema.parse(await(await f.get(member,'/api/v1/me/model-settings')).json());assert.equal(history.credentials.length,2);assert.equal(history.credentials.find(value=>value.credentialId===firstCredential)?.state,'rotated');assert.equal(history.models.find(value=>value.modelConnectionId===originalModel)?.state,'revoked');assert.equal(history.models.find(value=>value.modelConnectionId===replacement)?.state,'unverified');
  await f.withdrawProvider();f.recovery.unavailable=true;await f.owner.query('UPDATE private_work_persistence_policy SET persistence_allowed=false,revision=revision+1');
  const offline=await f.get(member,'/api/v1/me/model-settings');assert.equal(offline.status,200);assert.equal((await offline.json() as any).credentials.length,2);const ownerRead=await f.get(member,'/api/v1/me/model-credentials/'+firstCredential);assert.equal(ownerRead.status,200);assert.equal((await ownerRead.json() as any).state,'rotated');
  await page.goto(f.mainOrigin+'/#private-ai');await panel.getByRole('button',{name:'重新讀取模型設定',exact:true}).waitFor();await safeClientState(page,f.secret,assertions,logs);assert.equal(f.posts.length,0);
  assert.equal(refs.length,2);assert.notEqual(refs[0],refs[1]);const observed=(await f.main.request('snapshot')).requests;for(const ref of refs)assert.equal(observed.filter((r:any)=>r.method==='GET'&&r.path==='/api/v1/me/credential-ingests/'+ref).length,1);
  await delay(300);const finalNative=await f.broker.request('snapshot');assert.equal(finalNative.requests.filter((request:any)=>request.path==='/credential-setup/secret').length,2);assert(finalNative.reads.every((read:any)=>read.cleared));
 }finally{try{await Promise.all(deliveries);}finally{await f.cleanup();}}
});

test('MODEL-SETTINGS-PROCESS lost actual ingest ACK stays on portal, manual refresh never resends and confirmation preserves original command without navigation',{timeout:90000},async()=>{
 const f=await settingsFixture();try{const member=await f.configured(),context=await f.browserContext(member),page=await context.newPage();
  const sent:{key:string|null;version:string|null;body:string|null}[]=[];
  page.on('request',request=>{if(request.url()===f.mainOrigin+'/api/v1/me/credential-ingests'&&request.method()==='POST'){const headers=request.headers();sent.push({key:headers['idempotency-key']??null,version:headers['if-match']??null,body:request.postData()});}});
  await page.goto(f.mainOrigin+'/#private-ai');const panel=page.getByRole('region',{name:'模型與憑證設定'});await panel.getByRole('button',{name:'重新讀取模型設定',exact:true}).waitFor();await panel.getByLabel('管理的模型設定').selectOption(member.model.modelConnectionId);
  await panel.getByRole('checkbox',{name:'我同意為 openai / synthetic-model 前往獨立保管頁，另行輸入金鑰並確認加密保管。',exact:true}).check();await f.main.request('dropNext','/api/v1/me/credential-ingests');await panel.getByRole('button',{name:'前往金鑰保管頁',exact:true}).click();
  await panel.getByRole('button',{name:'確認原設定請求',exact:true}).waitFor();assert.equal(page.url(),f.mainOrigin+'/#private-ai');assert.equal(sent.length,1);assert.equal((await f.owner.query('SELECT count(*)::int n FROM credential_ingest_authorizations')).rows[0].n,1);
  await panel.getByRole('button',{name:'重新讀取模型設定',exact:true}).click();await panel.getByRole('button',{name:'確認原設定請求',exact:true}).waitFor();await delay(500);assert.equal(sent.length,1);assert.equal((await f.broker.request('snapshot')).requests.length,0);
  await panel.getByRole('button',{name:'確認原設定請求',exact:true}).click();await panel.getByRole('button',{name:'確認原設定請求',exact:true}).waitFor({state:'hidden'});
  assert.equal(sent.length,2);assert.deepEqual(sent[1],sent[0]);assert.equal(page.url(),f.mainOrigin+'/#private-ai');assert.equal((await f.owner.query('SELECT count(*)::int n FROM credential_ingest_authorizations')).rows[0].n,1);assert.equal((await f.broker.request('snapshot')).requests.length,0);assert.equal((await f.owner.query('SELECT count(*)::int n FROM broker_model_credentials')).rows[0].n,0);assert.equal(f.posts.length,0);
  const state=await page.evaluate(()=>({html:document.documentElement.outerHTML,local:JSON.stringify({...localStorage}),session:JSON.stringify({...sessionStorage})}));assert(!state.html.includes('freedom-credential-ingest'));assert(!state.local.includes('assertion'));assert(!state.session.includes('assertion'));
 }finally{await f.cleanup();}
});

for(const failure of ['prepare_denied','custody_rollback'] as const)test('MODEL-SETTINGS-PROCESS '+failure+' cannot reconcile as committed custody',{timeout:60000},async()=>{
 const f=await settingsFixture();try{
  const member=await f.configured(),context=await f.browserContext(member),page=await context.newPage();let ref='';
  page.on('request',request=>{if(request.url()===f.setupOrigin+'/credential-setup'&&request.method()==='POST'){const assertion=new URLSearchParams(request.postData()!).get('assertion')!;ref=JSON.parse(Buffer.from(assertion.split('.')[1],'base64url').toString('utf8')).authorizationRef;}});
  await page.goto(f.mainOrigin+'/#private-ai');const panel=page.getByRole('region',{name:'模型與憑證設定'});await panel.getByRole('button',{name:'重新讀取模型設定',exact:true}).waitFor();await panel.getByLabel('管理的模型設定').selectOption(member.model.modelConnectionId);
  await panel.getByRole('checkbox',{name:'我同意為 openai / synthetic-model 前往獨立保管頁，另行輸入金鑰並確認加密保管。',exact:true}).check();const navigation=page.waitForURL(f.setupOrigin+'/credential-setup');await panel.getByRole('button',{name:'前往金鑰保管頁',exact:true}).click();await navigation;await page.locator('#credential-key').waitFor();
  if(failure==='prepare_denied')await f.broker.request('captureReady',false);
  else await f.owner.query(`CREATE FUNCTION fixture_settings_rollback() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.operation='broker.credential.create' THEN RAISE EXCEPTION 'synthetic custody rollback'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fixture_settings_rollback BEFORE INSERT ON scoped_command_receipts FOR EACH ROW EXECUTE FUNCTION fixture_settings_rollback()`);
  await assert.rejects(submitSetup(f,member,page,ref),error=>(error as any).code==='ERR_ASSERTION'&&(error as any).expected==='committed');
  if(failure==='prepare_denied')assert.equal(await page.locator('#credential-status').getAttribute('data-error'),'true');assert.equal(await page.locator('#credential-key').inputValue(),'');assert.equal(await page.locator('#credential-submit').isDisabled(),true);
  for(const table of ['broker_model_credentials','broker_credential_vault'])assert.equal((await f.owner.query('SELECT count(*)::int n FROM '+table)).rows[0].n,0);
  assert.equal((await f.owner.query("SELECT count(*)::int n FROM scoped_command_receipts WHERE operation='broker.credential.create'")).rows[0].n,0);
  const snapshot=await f.broker.request('snapshot');assert.equal(snapshot.requests.filter((r:any)=>r.path==='/credential-setup/secret').length,failure==='prepare_denied'?0:1);assert(snapshot.reads.every((r:any)=>r.cleared));assert.equal(f.posts.length,0);
  assert.equal((await f.main.request('snapshot')).requests.filter((r:any)=>r.method==='GET'&&r.path==='/api/v1/me/credential-ingests/'+ref).length,1);
 }finally{await f.cleanup();}
});
