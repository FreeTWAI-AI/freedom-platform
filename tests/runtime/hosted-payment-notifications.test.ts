import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {before,after,beforeEach,test} from 'node:test';
import type {PoolClient} from 'pg';
import {hostedPaymentHarness} from '../e2e/hosted-payment-fixture.js';
import {EcpayKeyPair,encodeForm,signFields,newTradeNumber} from '../../modules/agent-commerce/providers/ecpay/index.js';
import {sealCredential} from '../../modules/agent-commerce/payments/credentials.js';
import {bindStore} from '../../modules/agent-commerce/checkout/authority.js';
import {cancelUnpaidOrder} from '../../modules/agent-commerce/checkout/orders.js';
import {settleDueCheckoutHolds} from '../../modules/agent-commerce/checkout/settlement.js';
import {isCommerceProviderEntry} from '../../modules/agent-commerce/operations/provider-entry-paths.js';
import {COMMERCE_LIMITS} from '../../modules/agent-commerce/checkout/limits.js';
import {hashKey} from '../../modules/agent-commerce/checkout/terms.js';
let f:Awaited<ReturnType<typeof hostedPaymentHarness>>;
type Placed=Awaited<ReturnType<typeof f.placed>>;
before(async()=>{f=await hostedPaymentHarness('fp_payment_notifications');});beforeEach(async()=>f.reset());after(async()=>f?.stop());
async function body(p:Placed,overrides:Record<string,string>={},material=p.provider.material){
  const a=(await f.x.h.pool.query('SELECT merchant_trade_no FROM commerce_payment_attempts WHERE attempt_id=$1',[p.payment.attempt_ref])).rows[0];
  return encodeForm(signFields({MerchantID:'1234567',MerchantTradeNo:a.merchant_trade_no,TradeNo:'T'+randomBytes(8).toString('hex').toUpperCase(),RtnCode:'1',RtnMsg:'合成付款結果',TradeAmt:'5',SimulatePaid:'0',PaymentDate:'2026/10/15 10:20:30',PaymentType:'Credit_CreditCard',PaymentTypeChargeFee:'0.3',gwsr:'12345',card6no:String(randomBytes(3).readUIntBE(0,3)%1_000_000).padStart(6,'0'),card4no:String(randomBytes(2).readUInt16BE()%10_000).padStart(4,'0'),auth_code:randomBytes(3).toString('hex'),...overrides},EcpayKeyPair.of(material.hash_key,material.hash_iv),'sha256'));
}
const path=(p:Placed)=>'/api/v1/provider-callbacks/ecpay/'+p.provider.accountRef+'/payment';
async function post(url:string,value:string|ReadableStream<Uint8Array>,headers:Record<string,string>={},method='POST'){
  const request=new Request(f.origin+url,{method,headers:{'Content-Type':'application/x-www-form-urlencoded','CF-Connecting-IP':'192.0.2.1',...headers},...(method==='GET'||method==='HEAD'?{}:{body:value,...(typeof value==='string'?{}:{duplex:'half'})})} as RequestInit);
  Object.defineProperty(request,'cf',{value:{colo:'TEST'}});const response=await f.app.fetch(request);return {response,status:response.status,text:await response.text()};
}
async function facts(p:Placed){return {attempt:(await f.x.h.pool.query('SELECT * FROM commerce_payment_attempts WHERE attempt_id=$1',[p.payment.attempt_ref])).rows[0],events:(await f.x.h.pool.query('SELECT * FROM commerce_hosted_payment_events ORDER BY received_at,event_id')).rows,applications:(await f.x.h.pool.query('SELECT * FROM commerce_checkout_payment_applications ORDER BY created_at,application_id')).rows,cases:(await f.x.h.pool.query('SELECT * FROM commerce_exception_cases ORDER BY created_at,case_id')).rows};}
const count=async(table:string)=>(await f.x.h.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n;
async function ack(result:Awaited<ReturnType<typeof post>>){assert.equal(result.status,200,result.text);assert.equal(result.text,'1|OK');assert.match(result.response.headers.get('Content-Type')!,/^text\/plain/);assert.equal(result.response.headers.get('Set-Cookie'),null);}
for(const variant of ['member','buyer','foreign_origin','no_origin'] as const)test(`signed callback ignores ${variant} browser authority and returns identical acknowledgement`,async()=>{
  const p=await f.placed(),headers:Record<string,string>={};
  if(variant==='member')headers.Cookie=p.s.owner.cookie;
  if(variant==='buyer')headers.Cookie=p.cookie;
  if(variant==='foreign_origin')headers.Origin='https://foreign.test';
  await ack(await post(path(p),await body(p),headers));const actual=await facts(p);assert.equal(actual.attempt.state,'paid');assert.equal(actual.applications[0].outcome,'converted');assert(actual.events[0].applied_at);assert.equal(actual.events[0].credential_version,1);
  assert.equal(actual.attempt.trade_no,actual.events[0].trade_no);assert.equal(actual.attempt.charge_fee_minor,'30');assert.equal(actual.attempt.gwsr,'12345');
});
test('only exact signed POST paths bypass the browser gate; other provider methods and paths are 404',async()=>{
  const p=await f.placed();assert(isCommerceProviderEntry('POST',path(p)));assert(isCommerceProviderEntry('POST','/pay/ecpay/return/'+p.provider.accountRef));
  for(const method of ['GET','HEAD','PUT','DELETE','OPTIONS'])for(const url of [path(p),'/pay/ecpay/return/'+p.provider.accountRef]){assert(!isCommerceProviderEntry(method,url));assert.equal((await post(url,'',{},method)).status,404);}
  for(const url of [path(p)+'/',path(p)+'/extra',path(p).replace(p.provider.accountRef,p.provider.accountRef.toUpperCase()),'/api/v1/provider-callbacks/ecpay/invalid/payment','/pay/ecpay/return/invalid'])assert.equal((await post(url,'')).status,404);
  assert.equal(await count('commerce_hosted_payment_events'),0);
  const wrongHost=new Request('https://other.test'+path(p),{method:'POST',body:await body(p),headers:{'Content-Type':'application/x-www-form-urlencoded'}});assert.equal((await f.app.fetch(wrongHost)).status,403);
});
for(const format of ['json','duplicate','case_duplicate','invalid_name','invalid_utf8','empty','stream_oversize'] as const)test(`callback refuses ${format} with 400 and no inbox effect`,async()=>{
  const p=await f.placed();let data:string|ReadableStream<Uint8Array>=await body(p);const headers:Record<string,string>={};
  if(format==='json')headers['Content-Type']='application/json';
  if(format==='duplicate')data+='&MerchantID=1234567';
  if(format==='case_duplicate')data+='&merchantid=1234567';
  if(format==='invalid_name')data+='&bad-name=x';
  if(format==='empty')data='';
  if(format==='invalid_utf8')data=new ReadableStream({start(c){c.enqueue(new Uint8Array([255]));c.close();}});
  if(format==='stream_oversize'){let chunks=0;data=new ReadableStream({pull(c){c.enqueue(new Uint8Array(4096).fill(65));if(++chunks===5)c.close();}});headers['Content-Length']='1';}
  const r=await post(path(p),data,headers);assert.equal(r.status,400,r.text);assert.equal(r.text,'0|invalid');assert.equal(await count('commerce_hosted_payment_events'),0);assert.equal((await facts(p)).attempt.state,'issued');
});
test('a charset parameter is accepted without changing verification of the original bytes',async()=>{const p=await f.placed();await ack(await post(path(p),await body(p),{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8'}));});
test('unknown references are empty 404s, with only the unknown-network budget',async()=>{
  const p=await f.placed(),url='/api/v1/provider-callbacks/ecpay/'+'0'.repeat(26)+'/payment',value=await body(p);
  const first=await post(url,value);assert.equal(first.status,404);assert.equal(first.text,'');
  await f.x.h.pool.query('UPDATE auth_rate_limits SET attempts=$2 WHERE bucket=$1',['commerce:providerUnknownNetwork:'+hashKey('192.0.2.1'),COMMERCE_LIMITS.providerUnknownNetwork.limit]);
  const limited=await post(url,value);assert.equal(limited.status,429);assert.match(limited.text,/^0\|/);assert(Number(limited.response.headers.get('Retry-After'))>0);
  await ack(await post(path(p),value));assert.equal((await f.x.h.pool.query("SELECT count(*)::int n FROM auth_rate_limits WHERE bucket LIKE 'commerce:providerAccount:%'")).rows[0].n,1);
});
test('known-account budget is 600 per minute independent of network and returns text 429',async()=>{
  const p=await f.placed();await f.x.h.pool.query('INSERT INTO auth_rate_limits(bucket,window_start,attempts) VALUES($1,clock_timestamp(),$2)',['commerce:providerAccount:'+hashKey(p.provider.accountId),600]);
  const r=await post(path(p),await body(p),{'CF-Connecting-IP':'198.51.100.2'});assert.equal(r.status,429);assert(Number(r.response.headers.get('Retry-After'))>0);assert.equal(await count('commerce_hosted_payment_events'),0);
});
test('missing keyring asks the provider to retry with 503, without storing anything',async()=>{const p=await f.placed();f.install({commerceCredentialKeyring:null});const r=await post(path(p),await body(p));assert.equal(r.status,503);assert.equal(await count('commerce_hosted_payment_events'),0);});
for(const invalid of ['signature','merchant','platform','foreign_account'] as const)test(`callback rejects ${invalid} and logs only a fixed reason/account`,async()=>{
  const p=await f.placed();let url=path(p),value=await body(p),logs:string[]=[];
  if(invalid==='signature')value=value.replace(/CheckMacValue=[A-Fa-f0-9]+/,'CheckMacValue='+'0'.repeat(64));
  if(invalid==='merchant')value=await body(p,{MerchantID:'7654321'});
  if(invalid==='platform')value=await body(p,{PlatformID:'1234567'});
  if(invalid==='foreign_account'){const other=await f.x.store();const provider=await f.setup(other);url='/api/v1/provider-callbacks/ecpay/'+provider.accountRef+'/payment';}
  const warn=console.warn;console.warn=(...args)=>{logs.push(args.join(' '));};let r;try{r=await post(url,value);}finally{console.warn=warn;}
  assert.equal(r.status,400,r.text);assert.equal(r.text,'0|invalid');assert.equal(await count('commerce_hosted_payment_events'),0);assert.equal(logs.length,1);const log=JSON.parse(logs[0]);assert.equal(log.event,'provider_callback_invalid');assert.match(log.account,/^[0-9a-f-]{36}$/);assert.match(log.reason,/^[a-z0-9_]+$/);assert.deepEqual(Object.keys(log).sort(),['account','event','reason']);
});
for(const outcome of ['failed','pending_confirmation','simulated','amount_mismatch'] as const)test(`${outcome} keeps the prescribed attempt, application, exception and schedule`,async()=>{
  const p=await f.placed();const overrides:Record<string,string>=outcome==='failed'?{RtnCode:'0'}:outcome==='pending_confirmation'?{RtnCode:'10300066'}:outcome==='simulated'?{SimulatePaid:'1'}:{TradeAmt:'6'};
  await ack(await post(path(p),await body(p,overrides)));const r=await facts(p);assert.equal(r.events[0].outcome,outcome==='amount_mismatch'?'paid':outcome);assert(r.events[0].applied_at);
  assert.equal(r.attempt.state,outcome==='failed'?'failed':'issued');assert.equal(r.attempt.trade_no,null);
  assert.deepEqual(r.applications.map(a=>a.outcome),outcome==='simulated'?['simulated']:outcome==='amount_mismatch'?['amount_mismatch']:[]);
  assert.deepEqual(r.cases.map(c=>c.kind),outcome==='amount_mismatch'?['amount_mismatch']:[]);
  const due=(await f.x.h.pool.query("SELECT w.due_at<=clock_timestamp() AS immediate FROM commerce_due_work w WHERE kind='payment_query' AND target_id=$1",[p.payment.attempt_ref])).rows[0];assert.equal(due.immediate,outcome==='pending_confirmation');
  assert.equal((await f.x.h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1',[p.s.product.product_id])).rows[0].reserved,5);
});
test('notification dedupe is sequential, concurrent and insensitive to trade-number case',async()=>{
  const p=await f.placed(),value=await body(p);await Promise.all([post(path(p),value).then(ack),post(path(p),value).then(ack)]);await ack(await post(path(p),value));
  const lower=value.replace(/MerchantTradeNo=([^&]+)/,(_m,v)=>'MerchantTradeNo='+v.toLowerCase()).replace(/TradeNo=([^&]+)/,(_m,v)=>'TradeNo='+v.toLowerCase());await ack(await post(path(p),lower));
  const r=await facts(p);assert.equal(r.events.length,1);assert.equal(r.applications.length,1);assert.equal(r.attempt.state,'paid');assert.equal(r.attempt.version,'2');
});
test('failure followed by payment advances to paid; a later failure opens one contradicting case',async()=>{
  const p=await f.placed();await ack(await post(path(p),await body(p,{RtnCode:'0'})));assert.equal((await facts(p)).attempt.state,'failed');await ack(await post(path(p),await body(p)));const paid=(await facts(p)).attempt;
  await ack(await post(path(p),await body(p,{RtnCode:'0'})));const r=await facts(p);assert.equal(r.attempt.state,'paid');assert.deepEqual(r.attempt,paid);assert.equal(r.applications.length,1);assert.deepEqual(r.cases.map(c=>c.kind),['contradicting_event']);
});
test('an unmatched verified trade opens an event case and is acknowledged once',async()=>{
  const p=await f.placed(),value=await body(p,{MerchantTradeNo:newTradeNumber('F')});await ack(await post(path(p),value));await ack(await post(path(p),value));const r=await facts(p);assert.equal(r.events.length,1);assert.equal(r.events[0].attempt_id,null);assert(r.events[0].applied_at);assert.equal(r.cases[0].kind,'unmatched_payment');assert.equal(r.cases[0].subject_kind,'payment_event');assert.equal(r.cases[0].order_id,null);assert.equal(r.attempt.state,'issued');
});
test('quarantine acknowledges the verified event and leaves it unapplied',async()=>{const p=await f.placed();f.settings.quarantine=true;await ack(await post(path(p),await body(p)));const r=await facts(p);assert.equal(r.events[0].applied_at,null);assert.equal(r.attempt.state,'issued');assert.equal(r.applications.length,0);});
test('a forced commit failure returns 500 and rolls back the inbox, attempt and inventory',async()=>{
  const p=await f.placed(),connect=f.x.runtime.connect;let refused=false;
  f.x.runtime.connect=(async()=>{const q=await (connect as ()=>Promise<PoolClient>).call(f.x.runtime),query=q.query,release=q.release;let applying=false;
    q.query=(async(...args:unknown[])=>{if(String(args[0]).startsWith('INSERT INTO commerce_hosted_payment_events'))applying=true;if(applying&&args[0]==='COMMIT'){refused=true;throw Error('synthetic_commit_failure');}return (query as Function).apply(q,args);}) as typeof q.query;
    q.release=(error?:Error|boolean)=>{q.query=query;q.release=release;release.call(q,error);};return q;}) as typeof f.x.runtime.connect;
  let r;try{r=await post(path(p),await body(p));}finally{f.x.runtime.connect=connect;}
  assert(refused);assert.equal(r.status,500);assert.notEqual(r.text,'1|OK');const actual=await facts(p);assert.equal(actual.events.length,0);assert.equal(actual.attempt.state,'issued');assert.equal(actual.applications.length,0);assert.equal((await f.x.h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1',[p.s.product.product_id])).rows[0].reserved,5);
});
async function rotate(p:Placed){
  const material={hash_key:randomBytes(8).toString('hex'),hash_iv:randomBytes(8).toString('hex'),credit_check_code:String(randomBytes(4).readUInt32BE()%100000000).padStart(8,'0')};
  const sealed=sealCredential(f.ring,{account_id:p.provider.accountId,purpose:'payment',environment:'sandbox',credential_version:2},material);
  await f.x.tx(async q=>{await bindStore(q,p.s.tenantId);
    await q.query(`INSERT INTO commerce_provider_credentials(account_id,purpose,credential_version,tenant_id,instance_id,environment,key_id,sealed,created_by_principal_id)
      SELECT account_id,'payment',2,tenant_id,instance_id,environment,$2,$3,created_by_principal_id FROM commerce_provider_accounts WHERE account_id=$1`,[p.provider.accountId,sealed.key_id,sealed.sealed]);
    await q.query("UPDATE commerce_provider_account_services SET credential_version=2,version=version+1,updated_at=clock_timestamp() WHERE account_id=$1 AND purpose='payment'",[p.provider.accountId]);
  });return material;
}
async function anotherAttempt(p:Placed,credentialVersion=1,kind:'order'|'service_activation'='order'){
  const a=(await f.x.h.pool.query(`INSERT INTO commerce_payment_attempts(tenant_id,instance_id,kind,order_id,sequence,account_id,environment,merchant_id,credential_version,merchant_trade_no,amount_minor,currency)
    SELECT tenant_id,instance_id,$2,CASE WHEN $2='order' THEN order_id ELSE NULL END,2,account_id,environment,merchant_id,$3,$4,amount_minor,currency FROM commerce_payment_attempts WHERE attempt_id=$1 RETURNING attempt_id`,[p.payment.attempt_ref,kind,credentialVersion,newTradeNumber('F')])).rows[0];
  return {...p,payment:{...p.payment,attempt_ref:a.attempt_id}} as Placed;
}
test('old unretired keys still verify their attempt after rotation, and newer keys may verify it too',async()=>{
  const p=await f.placed(),material=await rotate(p);await ack(await post(path(p),await body(p)));assert.equal((await facts(p)).events[0].credential_version,1);
  await ack(await post(path(p),await body(p,{},material)));const r=await facts(p);assert.equal(r.events[1].credential_version,2);assert.equal(r.applications.length,1);
});
test('a credential older than the attempt and a retired credential are refused without an event',async()=>{
  const p=await f.placed();await rotate(p);const newer=await anotherAttempt(p,2);
  assert.equal((await post(path(p),await body(newer))).status,400);assert.equal(await count('commerce_hosted_payment_events'),0);
  await f.x.tx(async q=>{await bindStore(q,p.s.tenantId);await q.query("UPDATE commerce_provider_credentials SET retired_at=clock_timestamp() WHERE account_id=$1 AND purpose='payment' AND credential_version=1",[p.provider.accountId]);});
  assert.equal((await post(path(p),await body(p))).status,400);assert.equal(await count('commerce_hosted_payment_events'),0);
});
for(const state of ['superseded','expired_unpaid','failed','confirmed'] as const)test(`paid notification safely handles an attempt already ${state}`,async()=>{
  const p=await f.placed();
  if(state==='confirmed'){await ack(await post(path(p),await body(p)));await f.x.h.pool.query("UPDATE commerce_payment_attempts SET state='confirmed',confirmed_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1",[p.payment.attempt_ref]);}
  else await f.x.h.pool.query(`UPDATE commerce_payment_attempts SET state=$2,${state==='expired_unpaid'?'expired':state}_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1`,[p.payment.attempt_ref,state]);
  await ack(await post(path(p),await body(p)));const r=await facts(p);assert.equal(r.attempt.state,state==='confirmed'?'confirmed':'paid');assert.equal(r.applications.length,1);
  if(state==='confirmed'){await ack(await post(path(p),await body(p,{RtnCode:'0'})));assert.equal((await facts(p)).cases[0].kind,'contradicting_event');}
});
test('a second paid attempt is retained as overpaid without allocating twice',async()=>{
  const p=await f.placed(),second=await anotherAttempt(p);await ack(await post(path(p),await body(p)));await ack(await post(path(p),await body(second)));
  const r=await facts(p);assert.deepEqual(r.applications.map(a=>a.outcome),['converted','overpaid']);assert.equal(r.cases[0].kind,'overpaid');assert.equal(r.cases[0].subject_id,second.payment.attempt_ref);assert.equal((await f.x.h.pool.query('SELECT count(*)::int n FROM commerce_inventory_allocations')).rows[0].n,1);
});
test('activation receipt only marks the attempt paid and schedules confirmation',async()=>{
  const p=await f.placed(),activation=await anotherAttempt(p,1,'service_activation');await ack(await post(path(p),await body(activation)));
  assert.equal((await facts(activation)).attempt.state,'paid');assert.equal(await count('commerce_checkout_payment_applications'),0);assert.equal((await f.x.h.pool.query("SELECT due_at<=clock_timestamp() AS due FROM commerce_due_work WHERE kind='payment_query' AND target_id=$1",[activation.payment.attempt_ref])).rows[0].due,true);
});
test('provider facts outside the storage allowlist are discarded after signature verification',async()=>{
  const p=await f.placed();await ack(await post(path(p),await body(p,{PaymentType:'合成未知付款方式',RtnMsg:'合成不可留存訊息',auth_code:'SYNTHETIC_AUTH'})));const r=await facts(p);assert.equal(r.events[0].payment_type,null);assert.equal(r.attempt.payment_type,null);
  const text=JSON.stringify(r);assert(!text.includes('合成未知付款方式'));assert(!text.includes('合成不可留存訊息'));assert(!text.includes('SYNTHETIC_AUTH'));
});
for(const order of ['cancel_first','payment_first'] as const)test(`notification and cancellation serialize with ${order}`,async()=>{
  const p=await f.placed(),value=await body(p);
  if(order==='cancel_first'){
    let release!:()=>void,ready!:()=>void;const held=new Promise<void>(r=>release=r),started=new Promise<void>(r=>ready=r);
    const cancellation=f.x.tx(async q=>{await cancelUnpaidOrder(q,p.s,p.order.order_ref,'buyer','buyer_cancelled');ready();await held;});await started;
    const notification=post(path(p),value);release();await cancellation;await ack(await notification);
    const r=await facts(p);assert.equal(r.applications[0].outcome,'after_cancel');assert.equal(r.cases[0].kind,'paid_after_cancel');
  }else{
    await ack(await post(path(p),value));await assert.rejects(f.x.tx(q=>cancelUnpaidOrder(q,p.s,p.order.order_ref,'buyer','buyer_cancelled')),e=>(e as {code?:string}).code==='payment_already_applied');assert.equal((await facts(p)).cases.length,0);
  }
});
for(const order of ['expiry_first','payment_first'] as const)test(`notification and expired-hold settlement serialize with ${order}`,async()=>{
  const s=await f.x.store(100),provider=await f.setup(s),due=await f.x.due(s);
  await f.x.tx(q=>f.runtime.commercePorts!.payment!.createOrderAttempt(q,{store:s,orderId:due.order_id,amountMinor:500,currency:'TWD',environment:'sandbox'}));
  const attempt=(await f.x.h.pool.query('SELECT attempt_id FROM commerce_payment_attempts WHERE order_id=$1',[due.order_id])).rows[0];
  const p={s,provider,order:{order_ref:due.order_id},payment:{attempt_ref:attempt.attempt_id}} as Placed;
  if(order==='expiry_first')await f.x.tx(q=>settleDueCheckoutHolds(q,[s.product.product_id]));
  await ack(await post(path(p),await body(p)));
  if(order==='payment_first')await f.x.tx(q=>settleDueCheckoutHolds(q,[s.product.product_id]));
  const r=await facts(p);assert.equal(r.applications[0].outcome,order==='expiry_first'?'allocated':'converted');assert.equal(r.attempt.state,'paid');assert.equal(r.cases.length,0);
});
test('late payment with unavailable inventory opens paid_unallocatable without a partial allocation',async()=>{
  const p=await f.placed();await f.x.tx(async q=>{await q.query("UPDATE commerce_inventory_reservations SET state='released',released_at=clock_timestamp() WHERE order_id=$1",[p.order.order_ref]);await q.query('UPDATE commerce_items SET reserved=0,stock=0 WHERE item_id=$1',[p.s.product.product_id]);});
  await ack(await post(path(p),await body(p)));const r=await facts(p);assert.equal(r.attempt.state,'paid');assert.equal(r.applications[0].outcome,'unallocatable');assert.equal(r.cases[0].kind,'paid_unallocatable');assert.equal(await count('commerce_inventory_allocations'),0);
});
const signal=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};
for(const competitor of ['cancellation','expiry'] as const)test(`a notification holds its commit while concurrent ${competitor} waits on the same community lock`,async()=>{
  let p:Placed;
  if(competitor==='cancellation')p=await f.placed();
  else{
    const s=await f.x.store(100),provider=await f.setup(s),due=await f.x.due(s);await f.x.tx(q=>f.runtime.commercePorts!.payment!.createOrderAttempt(q,{store:s,orderId:due.order_id,amountMinor:500,currency:'TWD',environment:'sandbox'}));
    const a=(await f.x.h.pool.query('SELECT attempt_id FROM commerce_payment_attempts WHERE order_id=$1',[due.order_id])).rows[0];p={s,provider,order:{order_ref:due.order_id},payment:{attempt_ref:a.attempt_id}} as Placed;
  }
  const value=await body(p),atCommit=signal(),competing=signal(),releaseCommit=signal(),connect=f.x.runtime.connect;let paused=false;
  f.x.runtime.connect=(async()=>{const q=await (connect as ()=>Promise<PoolClient>).call(f.x.runtime),query=q.query,release=q.release;let receipt=false;
    q.query=(async(...args:unknown[])=>{
      if(String(args[0]).startsWith('INSERT INTO commerce_hosted_payment_events'))receipt=true;
      if(receipt&&args[0]==='COMMIT'){paused=true;atCommit.resolve();await releaseCommit.promise;}
      if(!receipt&&paused&&String(args[0]).startsWith('SELECT pg_advisory_xact_lock')&&String((args[1] as unknown[])?.[0]).startsWith('commerce-orders/'))competing.resolve();
      return (query as Function).apply(q,args);
    }) as typeof q.query;q.release=(error?:Error|boolean)=>{q.query=query;q.release=release;release.call(q,error);};return q;}) as typeof f.x.runtime.connect;
  try{
    const notification=post(path(p),value);await atCommit.promise;
    const other=f.x.tx(async q=>competitor==='cancellation'?cancelUnpaidOrder(q,p.s,p.order.order_ref,'buyer','buyer_cancelled'):settleDueCheckoutHolds(q,[p.s.product.product_id])).then(result=>({result,error:null}),error=>({result:null,error}));
    await competing.promise;releaseCommit.resolve();await ack(await notification);const completed=await other;
    if(competitor==='cancellation')assert.equal(completed.error?.code,'payment_already_applied');else{assert.equal(completed.error,null);assert.equal(completed.result,0);}
    assert.equal((await facts(p)).applications[0].outcome,'converted');
  }finally{releaseCommit.resolve();f.x.runtime.connect=connect;}
});
for(const competitor of ['cancellation','expiry'] as const)test(`a concurrent notification waits until ${competitor} commits first`,async()=>{
  let p:Placed;
  if(competitor==='cancellation')p=await f.placed();
  else{
    const s=await f.x.store(100),provider=await f.setup(s),due=await f.x.due(s);await f.x.tx(q=>f.runtime.commercePorts!.payment!.createOrderAttempt(q,{store:s,orderId:due.order_id,amountMinor:500,currency:'TWD',environment:'sandbox'}));
    const a=(await f.x.h.pool.query('SELECT attempt_id FROM commerce_payment_attempts WHERE order_id=$1',[due.order_id])).rows[0];p={s,provider,order:{order_ref:due.order_id},payment:{attempt_ref:a.attempt_id}} as Placed;
  }
  const value=await body(p),ready=signal(),releaseFirst=signal(),inserted=signal(),connect=f.x.runtime.connect;
  const first=f.x.tx(async q=>{if(competitor==='cancellation')await cancelUnpaidOrder(q,p.s,p.order.order_ref,'buyer','buyer_cancelled');else await settleDueCheckoutHolds(q,[p.s.product.product_id]);ready.resolve();await releaseFirst.promise;});await ready.promise;
  f.x.runtime.connect=(async()=>{const q=await (connect as ()=>Promise<PoolClient>).call(f.x.runtime),query=q.query,release=q.release;
    q.query=(async(...args:unknown[])=>{const result=await (query as Function).apply(q,args);if(String(args[0]).startsWith('INSERT INTO commerce_hosted_payment_events'))inserted.resolve();return result;}) as typeof q.query;
    q.release=(error?:Error|boolean)=>{q.query=query;q.release=release;release.call(q,error);};return q;}) as typeof f.x.runtime.connect;
  try{const notification=post(path(p),value);await inserted.promise;releaseFirst.resolve();await first;await ack(await notification);
    const r=await facts(p);assert.equal(r.applications[0].outcome,competitor==='cancellation'?'after_cancel':'allocated');assert.deepEqual(r.cases.map(c=>c.kind),competitor==='cancellation'?['paid_after_cancel']:[]);
  }finally{releaseFirst.resolve();f.x.runtime.connect=connect;}
});
const returnPath=(p:Placed)=>'/pay/ecpay/return/'+p.provider.accountRef;
for(const variant of ['member','buyer','foreign_origin','no_origin'] as const)test(`browser return ignores ${variant}, records a hint and redirects without changing payment or inventory`,async()=>{
  const p=await f.placed(),before=(await facts(p)).attempt,headers:Record<string,string>={};if(variant==='member')headers.Cookie=p.s.owner.cookie;if(variant==='buyer')headers.Cookie=p.cookie;if(variant==='foreign_origin')headers.Origin='https://foreign.test';
  const r=await post(returnPath(p),await body(p),headers);assert.equal(r.status,303,r.text);assert.equal(r.response.headers.get('Location'),`/shops/${p.s.slug}/payment-return/${p.payment.attempt_ref}`);assert.equal(r.response.headers.get('Set-Cookie'),null);assert.equal(r.response.headers.get('Cache-Control'),'no-store');assert.equal(r.response.headers.get('Referrer-Policy'),'no-referrer');
  const actual=await facts(p);assert.deepEqual(actual.attempt,before);assert.equal(actual.applications.length,0);assert.equal(actual.cases.length,0);assert.equal(actual.events[0].source,'browser_return');assert.equal(actual.events[0].outcome,'returned');assert(actual.events[0].applied_at);assert.equal(actual.events[0].dedupe_key,null);assert.match(actual.events[0].body_sha256,/^[a-f0-9]{64}$/);
  assert.equal((await f.x.h.pool.query("SELECT due_at<=clock_timestamp() AS immediate FROM commerce_due_work WHERE kind='payment_query' AND target_id=$1",[p.payment.attempt_ref])).rows[0].immediate,true);assert.equal((await f.x.h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1',[p.s.product.product_id])).rows[0].reserved,5);
});
test('return query budget permits one schedule per attempt per minute and still records later hints',async()=>{
  const p=await f.placed(),value=await body(p);assert.equal((await post(returnPath(p),value)).status,303);
  const first=(await f.x.h.pool.query("SELECT updated_at::text,due_at::text FROM commerce_due_work WHERE kind='payment_query' AND target_id=$1",[p.payment.attempt_ref])).rows[0];
  assert.equal((await post(returnPath(p),value)).status,303);assert.deepEqual((await f.x.h.pool.query("SELECT updated_at::text,due_at::text FROM commerce_due_work WHERE kind='payment_query' AND target_id=$1",[p.payment.attempt_ref])).rows[0],first);assert.equal(await count('commerce_hosted_payment_events'),2);
  await f.x.h.pool.query("UPDATE auth_rate_limits SET window_start=clock_timestamp()-interval '61 seconds' WHERE bucket=$1",['commerce:paymentReturnQuery:'+hashKey(p.payment.attempt_ref)]);
  assert.equal((await post(returnPath(p),value)).status,303);assert.notEqual((await f.x.h.pool.query("SELECT updated_at::text FROM commerce_due_work WHERE kind='payment_query' AND target_id=$1",[p.payment.attempt_ref])).rows[0].updated_at,first.updated_at);
});
for(const reason of ['unknown_account','unknown_trade','invalid_signature','wrong_merchant','platform'] as const)test(`browser return ${reason} redirects to the root with no data`,async()=>{
  const p=await f.placed();let url=returnPath(p),value=await body(p);
  if(reason==='unknown_account')url='/pay/ecpay/return/'+'0'.repeat(26);
  if(reason==='unknown_trade')value=await body(p,{MerchantTradeNo:newTradeNumber('F')});
  if(reason==='invalid_signature')value=value.replace(/CheckMacValue=[A-Fa-f0-9]+/,'CheckMacValue='+'0'.repeat(64));
  if(reason==='wrong_merchant')value=await body(p,{MerchantID:'7654321'});
  if(reason==='platform')value=await body(p,{PlatformID:'1234567'});
  const r=await post(url,value);assert.equal(r.status,303);assert.equal(r.response.headers.get('Location'),'/');assert.equal(await count('commerce_hosted_payment_events'),0);assert.equal(await count('commerce_checkout_payment_applications'),0);
});
test('over-budget browser returns still verify and redirect but write no event or query',async()=>{
  const p=await f.placed();await f.x.h.pool.query('INSERT INTO auth_rate_limits(bucket,window_start,attempts) VALUES($1,clock_timestamp(),60)',['commerce:paymentReturnNetwork:'+hashKey('192.0.2.1')]);
  const value=await body(p);let r=await post(returnPath(p),value);assert.equal(r.status,303);assert.equal(r.response.headers.get('Location'),`/shops/${p.s.slug}/payment-return/${p.payment.attempt_ref}`);
  r=await post(returnPath(p),value.replace(/CheckMacValue=[A-Fa-f0-9]+/,'CheckMacValue='+'0'.repeat(64)));assert.equal(r.status,303);assert.equal(r.response.headers.get('Location'),'/');assert.equal(await count('commerce_hosted_payment_events'),0);
  assert.equal((await f.x.h.pool.query("SELECT due_at>clock_timestamp() AS later FROM commerce_due_work WHERE kind='payment_query' AND target_id=$1",[p.payment.attempt_ref])).rows[0].later,true);assert.equal((await f.x.h.pool.query("SELECT count(*)::int n FROM auth_rate_limits WHERE bucket LIKE 'commerce:paymentReturnQuery:%'")).rows[0].n,0);
});
test('quarantine return verifies and redirects while leaving the inbox, order and due work untouched',async()=>{
  const p=await f.placed(),before=await facts(p),due=(await f.x.h.pool.query('SELECT * FROM commerce_due_work ORDER BY kind')).rows;f.settings.quarantine=true;const r=await post(returnPath(p),await body(p));assert.equal(r.status,303);assert.equal(r.response.headers.get('Location'),`/shops/${p.s.slug}/payment-return/${p.payment.attempt_ref}`);assert.deepEqual(await facts(p),before);assert.deepEqual((await f.x.h.pool.query('SELECT * FROM commerce_due_work ORDER BY kind')).rows,due);
});
test('return body rules share the streamed cap and parser; malformed forms remain 400',async()=>{
  const p=await f.placed(),value=await body(p);
  for(const invalid of [value+'&MerchantID=1234567',value+'&bad-name=x','x='+'a'.repeat(16384)]){const r=await post(returnPath(p),invalid);assert.equal(r.status,400);assert.equal(r.text,'0|invalid');}
  assert.equal((await post(returnPath(p),value,{'Content-Type':'application/json'})).status,400);assert.equal(await count('commerce_hosted_payment_events'),0);
});
test('activation return redirects to root and does not activate its service',async()=>{
  const p=await f.placed(),activation=await anotherAttempt(p,1,'service_activation'),r=await post(returnPath(p),await body(activation));assert.equal(r.status,303);assert.equal(r.response.headers.get('Location'),'/');assert.equal((await facts(activation)).attempt.state,'issued');assert.equal(await count('commerce_checkout_payment_applications'),0);
});
test('back links resolve only retained order attempts and have no payment side effects',async()=>{
  const p=await f.placed(),before=await facts(p),r=await post('/pay/ecpay/back/'+p.payment.attempt_ref,'',{},'GET');assert.equal(r.status,303);assert.equal(r.response.headers.get('Location'),`/shops/${p.s.slug}/orders/${p.order.order_ref}`);assert.deepEqual(await facts(p),before);
  const activation=await anotherAttempt(p,1,'service_activation');for(const id of [activation.payment.attempt_ref,randomUUID(),'invalid']){const missing=await post('/pay/ecpay/back/'+id,'',{},'GET');assert.equal(missing.status,404);assert.match(missing.response.headers.get('Content-Type')!,/text\/html/);}
});
