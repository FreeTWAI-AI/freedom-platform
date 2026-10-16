import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {test,before,beforeEach,after} from 'node:test';
import {hostedPaymentHarness} from '../e2e/hosted-payment-fixture.js';
import {activationDisplayNumber} from '../../modules/agent-commerce/payments/handoff.js';
import {activateProviderService,SERVICE_ACTIVATION_AMOUNT_MINOR} from '../../modules/agent-commerce/payments/accounts.js';
import {bindStore} from '../../modules/agent-commerce/checkout/authority.js';
import {queryAttempt} from '../../modules/agent-commerce/payments/queries.js';
import {endPaymentWindow} from '../../modules/agent-commerce/payments/window.js';
import {createFixtureQueryTransport} from '../../modules/agent-commerce/payments/query-transport.js';
import {EcpayKeyPair,encodeForm,signFields} from '../../modules/agent-commerce/providers/ecpay/index.js';
import {DEMO_PASSWORD} from '../../packages/testing/seed.js';
import {hashKey} from '../../modules/agent-commerce/checkout/terms.js';
let f:Awaited<ReturnType<typeof hostedPaymentHarness>>;
before(async()=>{f=await hostedPaymentHarness('fp_payment_activation');});beforeEach(async()=>f.reset());after(async()=>f?.stop());
const ok=(r:{status:number;data:any},status=200)=>{assert.equal(r.status,status,JSON.stringify(r.data));return r.data;};
async function draft(existing?:Awaited<ReturnType<typeof f.x.store>>,merchantId='1234567'){
  const s=existing??await f.x.store(10),call=(method:string,path:string,body?:unknown,version?:string,key=randomUUID())=>f.x.h.call(method,path,s.owner,body,{'Idempotency-Key':key,...(version?{'If-Match':`"${version}"`}:{})},f.app);
  if(!existing){const version=(await f.x.h.pool.query('SELECT version::text FROM module_instances WHERE instance_id=$1',[s.instanceId])).rows[0].version;ok(await call('POST',s.root+'/upgrade',{},version));}
  const fresh=async()=>ok(await call('POST','/me/high-risk-verifications',{tenant_id:s.tenantId,purpose:'commerce.provider_account.write',password:DEMO_PASSWORD}),201).verification_id as string;
  let account=ok(await call('POST',s.root+'/provider-accounts',{provider:'ecpay',environment:'sandbox',merchant_id:merchantId,fresh_auth_verification_id:await fresh()}),201);
  const material={hash_key:randomBytes(8).toString('hex'),hash_iv:randomBytes(8).toString('hex')};
  account=ok(await call('PUT',s.root+`/provider-accounts/${account.account_id}/services/payment`,{profile:'ecpay.aio.credit.v1',...material,fresh_auth_verification_id:await fresh()},account.version));
  const path=s.root+`/provider-accounts/${account.account_id}/services/payment/activation-payments`;
  const version=async()=>(await f.x.h.pool.query('SELECT version::text FROM commerce_provider_accounts WHERE account_id=$1',[account.account_id])).rows[0].version as string;
  const start=async()=>{const body={fresh_auth_verification_id:await fresh()},key=randomUUID(),expected=await version();return {result:await call('POST',path,body,expected,key),body,key,expected};};
  return {s,call,fresh,account,material,path,version,start};
}
type Draft=Awaited<ReturnType<typeof draft>>;
const attempt=async(id:string)=>(await f.x.h.pool.query('SELECT * FROM commerce_payment_attempts WHERE attempt_id=$1',[id])).rows[0];
const service=async(d:Draft)=>(await f.x.h.pool.query("SELECT * FROM commerce_provider_account_services WHERE account_id=$1 AND purpose='payment'",[d.account.account_id])).rows[0];
async function handoff(url:string){const r=await f.app.fetch(new Request(f.origin+url));return {status:r.status,text:await r.text(),response:r};}
async function signed(d:Draft,id:string,overrides:Record<string,string>={}){
  const a=await attempt(id);return encodeForm(signFields({MerchantID:d.account.merchant_id,MerchantTradeNo:a.merchant_trade_no,TradeNo:'T1234567',TradeAmt:'10',TradeStatus:'1',PaymentDate:'2026/10/15 10:20:30',RtnCode:'1',SimulatePaid:'0',...overrides},EcpayKeyPair.of(d.material.hash_key,d.material.hash_iv),'sha256'));
}
async function notify(d:Draft,id:string){
  const ref=(await f.x.h.pool.query("SELECT route_key FROM commerce_entry_routes WHERE route_kind='provider_account' AND target_id=$1",[d.account.account_id])).rows[0].route_key;
  const r=await f.app.fetch(new Request(f.origin+'/api/v1/provider-callbacks/ecpay/'+ref+'/payment',{method:'POST',body:await signed(d,id),headers:{'Content-Type':'application/x-www-form-urlencoded'}}));assert.equal(r.status,200);assert.equal(await r.text(),'1|OK');
}
async function query(d:Draft,id:string,overrides:Record<string,string>={},during?:()=>Promise<void>){
  const body=await signed(d,id,overrides);return queryAttempt(f.x.runtime,id,{transport:createFixtureQueryTransport(async()=>{await during?.();return {kind:'response',status:200,body};},'local'),keyring:f.ring,freedomEnv:'local'},'activation');
}
test('activation display number is stable Crockford base32 with the Taipei day',()=>{
  const id='00000000-0000-4000-8000-000000000001',time=new Date('2026-12-31T16:00:00Z');
  const value=activationDisplayNumber(id,time);assert.match(value,/^270101-[0-9A-HJKMNP-TV-Z]{6}$/);assert.equal(activationDisplayNumber(id,time),value);assert.notEqual(activationDisplayNumber('00000000-0000-4000-8000-000000000002',time),value);
});
test('activation command receipt has only the attempt ref; replay remints a token without another attempt',async()=>{
  const d=await draft(),logs:unknown[][]=[],original=console.error;console.error=(...args)=>{logs.push(args);};
  try{
    const first=await d.start(),handoff1=ok(first.result,201),replayed=ok(await d.call('POST',d.path,first.body,first.expected,first.key),201);
    assert.equal(handoff1.attempt_ref,replayed.attempt_ref);assert.notEqual(handoff1.handoff_url,replayed.handoff_url);
    const a=await attempt(handoff1.attempt_ref);assert.equal(a.kind,'service_activation');assert.equal(a.order_id,null);assert.equal(Number(a.amount_minor),SERVICE_ACTIVATION_AMOUNT_MINOR);assert.equal(a.sequence,1);assert.equal((await service(d)).state,'draft');
    const receipts=(await f.x.h.pool.query("SELECT response FROM scoped_command_receipts WHERE operation='commerce.provider_service.activation_payment.payment'")).rows;
    assert.deepEqual(receipts,[{response:{attempt_ref:a.attempt_id}}]);
    const tokens=[handoff1.handoff_url.split('/').at(-1)!,replayed.handoff_url.split('/').at(-1)!];
    const rows=(await f.x.h.pool.query('SELECT * FROM commerce_entry_routes WHERE target_id=$1',[a.attempt_id])).rows;
    assert.equal(rows.filter(r=>r.revoked_at).length,1);assert(rows.some(r=>r.route_key===hashKey(tokens[1])));
    const serialized=JSON.stringify({receipts,events:(await f.x.h.pool.query('SELECT * FROM commerce_hosted_payment_events')).rows,controls:(await f.x.h.pool.query('SELECT * FROM commerce_control_events')).rows,journal:(await f.x.h.pool.query('SELECT * FROM scoped_transition_journal')).rows,objects:[...f.journal.objects.values()],logs,routes:rows});
    for(const token of tokens)assert(!serialized.includes(token));
    assert.equal((await handoff(handoff1.handoff_url)).status,410);assert.equal((await handoff(replayed.handoff_url)).status,200);
    const after=await d.call('POST',d.path,first.body,first.expected,first.key);assert.equal(after.status,409);assert.equal(after.data.code,'provider_activation_pending');
  }finally{console.error=original;}
});
test('the real activation handoff works with checkout off and needs no admission, order or holds',async()=>{
  const d=await draft();f.settings.checkoutEnabled=false;const value=ok((await d.start()).result,201),page=await handoff(value.handoff_url);
  assert.equal(page.status,200,page.text);assert.match(page.text,/收款服務驗證/);assert.match(page.text,/TotalAmount[^>]*value="10"/);assert.match(page.text,/ItemName[^>]*收款服務驗證/);
  const a=await attempt(value.attempt_ref);assert(a.handed_off_at);assert.equal((await f.x.h.pool.query('SELECT count(*)::int n FROM commerce_checkout_orders')).rows[0].n,0);
  assert([...f.journal.objects.values()].some(body=>JSON.parse(body).kind==='payment_handoff'));assert.equal((await handoff(value.handoff_url)).status,410);
  const back=await f.app.fetch(new Request(f.origin+'/pay/ecpay/back/'+a.attempt_id));assert.equal(back.status,303);assert.equal(back.headers.get('Location'),'/');
});
test('notification alone leaves the service draft; the query confirms and activates atomically with a control event',async()=>{
  const d=await draft(),value=ok((await d.start()).result,201);assert.equal((await handoff(value.handoff_url)).status,200);await notify(d,value.attempt_ref);
  assert.equal((await attempt(value.attempt_ref)).state,'paid');assert.equal((await service(d)).state,'draft');
  assert.equal((await query(d,value.attempt_ref)).status,'paid');assert.equal((await attempt(value.attempt_ref)).state,'confirmed');assert.equal((await service(d)).state,'active');assert.equal((await service(d)).activation_ref,value.attempt_ref);
  const controls=(await f.x.h.pool.query("SELECT * FROM commerce_control_events WHERE subject_id=$1 AND kind='provider_service.state_changed'",[d.account.account_id])).rows;assert.equal(controls.length,1);assert.equal(controls[0].journaled_at,null);assert.deepEqual(controls[0].detail,{purpose:'payment',from_state:'draft',to_state:'active'});
  assert.equal((await f.x.h.pool.query('SELECT count(*)::int n FROM commerce_checkout_payment_applications')).rows[0].n,0);
  const view=ok(await d.call('GET',d.s.root+'/provider-accounts')).items[0];assert.equal(view.payment_activation.state,'confirmed');assert.equal(view.payment_activation.attempt_ref,value.attempt_ref);
});
for(const competing of ['active_before_start','active_before_confirmation','retired_before_confirmation'] as const)test(`activation conflict policy: ${competing}`,async()=>{
  const d=await draft(),other=competing==='retired_before_confirmation'?null:await draft(d.s,'1234568');
  if(competing==='active_before_start'){
    await f.x.tx(async q=>{await bindStore(q,d.s.tenantId);await activateProviderService(q,{accountId:other!.account.account_id,purpose:'payment',activationRef:randomUUID()});});
    const r=(await d.start()).result;assert.equal(r.status,409);assert.equal(r.data.code,'provider_service_conflict');assert.equal(r.data.detail,'商店已有相同設定檔的啟用服務。');assert.equal((await f.x.h.pool.query('SELECT count(*)::int n FROM commerce_payment_attempts')).rows[0].n,0);return;
  }
  const value=ok((await d.start()).result,201);assert.equal((await handoff(value.handoff_url)).status,200);await notify(d,value.attempt_ref);
  await query(d,value.attempt_ref,{},async()=>{
    if(other)await f.x.tx(async q=>{await bindStore(q,d.s.tenantId);await activateProviderService(q,{accountId:other.account.account_id,purpose:'payment',activationRef:randomUUID()});});
    else ok(await d.call('POST',d.s.root+`/provider-accounts/${d.account.account_id}/services/payment/retire`,{fresh_auth_verification_id:await d.fresh()},await d.version()));
  });
  assert.equal((await attempt(value.attempt_ref)).state,'confirmed');assert.equal((await service(d)).state,other?'draft':'retired');
  if(other)assert.equal((await service(other)).state,'active');
  assert.equal((await f.x.h.pool.query("SELECT count(*)::int n FROM commerce_control_events WHERE subject_id=$1 AND detail->>'to_state'='active'",[d.account.account_id])).rows[0].n,0);
  assert.equal((await f.x.h.pool.query("SELECT count(*)::int n FROM commerce_hosted_payment_events WHERE attempt_id=$1 AND source='query' AND applied_at IS NOT NULL",[value.attempt_ref])).rows[0].n,1);
});
for(const outcome of ['failed','expired'] as const)test(`${outcome} activation permits a new attempt and appears in the view`,async()=>{
  const d=await draft(),first=ok((await d.start()).result,201);
  if(outcome==='failed'){await handoff(first.handoff_url);await query(d,first.attempt_ref,{TradeStatus:'10200095'});}
  else {const a=await attempt(first.attempt_ref);await endPaymentWindow(f.x.runtime,a.attempt_id,{now:()=>new Date(a.created_at.getTime()+3600_000)});}
  const v=ok(await d.call('GET',d.s.root+'/provider-accounts')).items[0];assert.equal(v.payment_activation.state,outcome);
  const second=ok((await d.start()).result,201);assert.notEqual(second.attempt_ref,first.attempt_ref);assert.equal((await attempt(second.attempt_ref)).sequence,2);assert.equal((await service(d)).state,'draft');
});
test('an activation already handed off inside its window, or paid, blocks another start',async()=>{
  const d=await draft(),first=ok((await d.start()).result,201);await handoff(first.handoff_url);
  let r=(await d.start()).result;assert.equal(r.status,409);assert.equal(r.data.code,'provider_activation_pending');
  await notify(d,first.attempt_ref);r=(await d.start()).result;assert.equal(r.status,409);assert.equal(r.data.code,'provider_activation_pending');
});
for(const gate of ['quarantine','profile','gateway','service'] as const)test(`activation start checks ${gate} without changing a service`,async()=>{
  const d=await draft();
  if(gate==='quarantine')f.settings.quarantine=true;
  if(gate==='profile'){f.settings.providerProfiles=[];f.install();}
  if(gate==='gateway')f.install({commercePayments:{journal:f.journal,profiles:f.settings.providerProfiles}});
  if(gate==='service')await f.x.tx(async q=>{await bindStore(q,d.s.tenantId);await activateProviderService(q,{accountId:d.account.account_id,purpose:'payment',activationRef:randomUUID()});});
  const r=(await d.start()).result;assert.equal(r.status,gate==='quarantine'?503:409,JSON.stringify(r.data));assert.equal(r.data.code,gate==='quarantine'?'commerce_quarantined':'provider_service_state');
  assert.equal((await f.x.h.pool.query('SELECT count(*)::int n FROM commerce_payment_attempts')).rows[0].n,0);assert.equal((await service(d)).state,gate==='service'?'active':'draft');
});
for(const gate of ['tenant','instance','quarantine','profile','gateway','keyring','service','attempt'] as const)test(`activation handoff checks ${gate} and preserves its token`,async()=>{
  const d=await draft(),value=ok((await d.start()).result,201);
  if(gate==='tenant')await f.x.h.pool.query("UPDATE tenants SET status='suspended' WHERE tenant_id=$1",[d.s.tenantId]);
  if(gate==='instance')await f.x.h.pool.query("UPDATE module_instances SET status='suspended' WHERE instance_id=$1",[d.s.instanceId]);
  if(gate==='quarantine')f.settings.quarantine=true;
  if(gate==='profile'){f.settings.providerProfiles=[];f.install();}
  if(gate==='gateway')f.install({commercePayments:{journal:f.journal,profiles:f.settings.providerProfiles}});
  if(gate==='keyring')f.install({commerceCredentialKeyring:null});
  if(gate==='service')await f.x.tx(async q=>{await bindStore(q,d.s.tenantId);await activateProviderService(q,{accountId:d.account.account_id,purpose:'payment',activationRef:randomUUID()});});
  if(gate==='attempt')await f.x.h.pool.query("UPDATE commerce_payment_attempts SET state='failed',failed_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1",[value.attempt_ref]);
  const page=await handoff(value.handoff_url);assert.equal(page.status,['tenant','instance','service'].includes(gate)?409:gate==='attempt'?410:503,page.text);
  if(gate==='tenant'||gate==='instance')assert.match(page.text,/商店目前無法接受付款。/);
  assert.equal((await attempt(value.attempt_ref)).handed_off_at,null);assert.equal((await f.x.h.pool.query('SELECT revoked_at FROM commerce_entry_routes WHERE route_key=$1',[hashKey(value.handoff_url.split('/').at(-1)!)])).rows[0].revoked_at,null);
});
for(const inactive of ['tenant','instance'] as const)test(`activation command reuses ${inactive} liveness authorization`,async()=>{
  const d=await draft(),verification=await d.fresh(),version=await d.version();
  if(inactive==='tenant')await f.x.h.pool.query("UPDATE tenants SET status='suspended' WHERE tenant_id=$1",[d.s.tenantId]);
  else await f.x.h.pool.query("UPDATE module_instances SET status='suspended' WHERE instance_id=$1",[d.s.instanceId]);
  const r=await d.call('POST',d.path,{fresh_auth_verification_id:verification},version);assert.equal(r.status,inactive==='tenant'?403:409,JSON.stringify(r.data));assert.equal(r.data.code,inactive==='tenant'?'capability_denied':'storefront_unavailable');
});
test('activation route requires headers and fresh authentication, including on receipt replay',async()=>{
  const d=await draft(),body={fresh_auth_verification_id:await d.fresh()},expected=await d.version();
  const noKey=await f.x.h.call('POST',d.path,d.s.owner,body,{'If-Match':`"${expected}"`},f.app);assert.equal(noKey.status,400);assert.equal(noKey.data.code,'idempotency_required');
  const noVersion=await f.x.h.call('POST',d.path,d.s.owner,body,{'Idempotency-Key':randomUUID()},f.app);assert.equal(noVersion.status,428);assert.equal(noVersion.data.code,'version_required');
  const missing=await d.call('POST',d.path,{},expected);assert.equal(missing.status,403);assert.equal(missing.data.code,'fresh_auth_required');
  const wrong=await d.call('POST',d.path,{fresh_auth_verification_id:randomUUID()},expected);assert.equal(wrong.status,403);assert.equal(wrong.data.code,'fresh_auth_required');
  const stale=await d.call('POST',d.path,body,'999');assert.equal(stale.status,412);assert.equal(stale.data.code,'version_conflict');
  const result=await d.call('POST',d.path,body,expected);ok(result,201);
});
for(const role of ['admin','operator','viewer'] as const)test(`activation authority is ${role==='admin'?'granted':'denied'} to ${role}`,async()=>{
  const d=await draft(),member=(await f.x.h.person('合成設定成員')).session,principal=await f.x.h.candidate(d.s.owner,member.user.user_id);
  const invite=await f.x.h.invite(d.s.owner,d.s.tenantId,principal,role);ok(invite,201);await f.x.h.accept(member,d.s.tenantId,invite);
  if(role!=='admin')await f.x.h.pool.query(`INSERT INTO tenant_module_permissions(tenant_id,principal_id,instance_id,capabilities,status,granted_by_principal_id)
    SELECT $1,$2,$3,ARRAY['store:read','store:manage','store:finance:read'],'active',principal_id FROM principals WHERE user_ref=$4`,[d.s.tenantId,principal,d.s.instanceId,d.s.owner.user.user_id]);
  const fresh=role==='admin'?ok(await f.x.h.call('POST','/me/high-risk-verifications',member,{tenant_id:d.s.tenantId,purpose:'commerce.provider_account.write',password:DEMO_PASSWORD},{'Idempotency-Key':randomUUID()},f.app),201).verification_id:randomUUID();
  const r=await f.x.h.call('POST',d.path,member,{fresh_auth_verification_id:fresh},{'Idempotency-Key':randomUUID(),'If-Match':`"${await d.version()}"`},f.app);
  assert.equal(r.status,role==='admin'?201:403,JSON.stringify(r.data));if(role!=='admin')assert.equal(r.data.code,'capability_denied');
});
test('activation account budget is ten per hour, including receipt replays',async()=>{
  const d=await draft(),first=await d.start();ok(first.result,201);
  for(let i=1;i<10;i++)ok(await d.call('POST',d.path,first.body,first.expected,first.key),201);
  const limited=await d.call('POST',d.path,first.body,first.expected,first.key);assert.equal(limited.status,429);assert.equal(limited.data.code,'commerce_rate_limited');assert(Number(limited.response.headers.get('Retry-After'))>0);
  assert.equal((await f.x.h.pool.query('SELECT count(*)::int n FROM commerce_payment_attempts')).rows[0].n,1);
});
test('denied callers do not spend the activation account budget',async()=>{
  const d=await draft(),member=(await f.x.h.person('合成設定成員')).session,principal=await f.x.h.candidate(d.s.owner,member.user.user_id),stranger=(await f.x.h.person('合成非成員')).session;
  const invite=await f.x.h.invite(d.s.owner,d.s.tenantId,principal,'operator');ok(invite,201);await f.x.h.accept(member,d.s.tenantId,invite);
  await f.x.h.pool.query(`INSERT INTO tenant_module_permissions(tenant_id,principal_id,instance_id,capabilities,status,granted_by_principal_id)
    SELECT $1,$2,$3,ARRAY['store:read','store:manage','store:finance:read'],'active',principal_id FROM principals WHERE user_ref=$4`,[d.s.tenantId,principal,d.s.instanceId,d.s.owner.user.user_id]);
  for(let i=0;i<10;i++){
    const headers={'Idempotency-Key':randomUUID(),'If-Match':`"${await d.version()}"`},body={fresh_auth_verification_id:randomUUID()};
    const denied=await f.x.h.call('POST',d.path,member,body,headers,f.app);assert.equal(denied.status,403,JSON.stringify(denied.data));assert.equal(denied.data.code,'capability_denied');
    const hidden=await f.x.h.call('POST',d.path,stranger,body,headers,f.app);assert.equal(hidden.status,404,JSON.stringify(hidden.data));
  }
  ok((await d.start()).result,201);
});
for(const mismatch of ['amount','trade'] as const)test(`activation ${mismatch} mismatch records an exception without activation or an order application`,async()=>{
  const d=await draft(),value=ok((await d.start()).result,201);await handoff(value.handoff_url);if(mismatch==='trade')await notify(d,value.attempt_ref);
  const result=await query(d,value.attempt_ref,mismatch==='amount'?{TradeAmt:'11'}:{TradeNo:'TOTHER'});assert.equal(result.status,mismatch==='amount'?'amount_mismatch':'trade_no_mismatch');
  assert.equal((await service(d)).state,'draft');assert.equal((await f.x.h.pool.query('SELECT count(*)::int n FROM commerce_checkout_payment_applications')).rows[0].n,0);
  assert.equal((await f.x.h.pool.query("SELECT count(*)::int n FROM commerce_due_work WHERE kind='payment_query' AND target_id=$1",[value.attempt_ref])).rows[0].n,0);
  assert.equal((await f.x.h.pool.query('SELECT kind FROM commerce_exception_cases WHERE subject_id=$1',[value.attempt_ref])).rows[0].kind,mismatch==='amount'?'amount_mismatch':'contradicting_event');
});
