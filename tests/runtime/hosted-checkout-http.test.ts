import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {Problem} from '../../packages/shared/problem.js';
import * as wire from '../../contracts/guild-launchpad/v1/hosted-checkout.js';
import {COMMERCE_LIMITS} from '../../modules/agent-commerce/checkout/limits.js';
import {createHmac,randomBytes,randomUUID} from 'node:crypto';
import {before,beforeEach,after,test} from 'node:test';
import {createHostedCheckoutRoutes} from '../../apps/platform-api/src/routes/hosted-checkout.js';
import {createPlatformApp} from '../../apps/platform-api/src/platform-app.js';
import {nodeRuntime} from '../../apps/platform-api/src/app.js';
import {cloudflareRateLimitNetwork} from '../../apps/platform-api/src/worker.js';
import {FixtureEmailSender} from '../../modules/agent-commerce/operations/notifications/email-port.js';
import {runDueCommerceWork} from '../../modules/agent-commerce/operations/due-work.js';
import {MemoryEffectJournal} from '../../modules/agent-commerce/operations/journal/memory.js';
import {canonicalJSON,parseCheckoutInput,hashKey} from '../../modules/agent-commerce/checkout/terms.js';
import {redeemAccessLink,shopCookieName} from '../../modules/agent-commerce/checkout/access.js';
import {resolvePublicStorePage} from '../../modules/agent-commerce/hosted/public.js';
import {checkoutHarness,ports,ok,type CheckoutHarness} from './hosted-checkout-harness.js';
import type {CommerceSettings} from '../../modules/agent-commerce/operations/runtime-settings.js';
import type {CheckoutPorts} from '../../modules/agent-commerce/checkout/terms.js';
let x:CheckoutHarness,app:ReturnType<typeof createPlatformApp>,email:FixtureEmailSender,journal:MemoryEffectJournal,origin:string,policies:{policy_kind:string;policy_version_id:string}[];
function install(settings:CommerceSettings={checkoutEnabled:true,consoleEnabled:true,quarantine:false,providerProfiles:[],emailEnabled:true},extra:CheckoutPorts={}) {
  const mode=origin.startsWith('https:')?'public':'local';
  const runtime=nodeRuntime(mode,origin,{guildLaunchpadEnabled:true,commerceSettings:settings,commercePorts:{...ports,policies:{required:async()=>policies},...extra}});
  runtime.rateLimitNetwork=cloudflareRateLimitNetwork(true);app=createPlatformApp(x.runtime,origin,mode,runtime);
}
async function http(method:string,path:string,body?:unknown,cookie?:string,headers:Record<string,string>={}) {
  const request=new Request(origin+'/api/v1'+path,{method,headers:{Origin:origin,'CF-Connecting-IP':'192.0.2.1',...(body===undefined?{}:{'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
  Object.defineProperty(request,'cf',{value:{colo:'TEST'}});
  const response=await app.fetch(request),text=await response.text();return {response,status:response.status,data:text?JSON.parse(text):null};
}
const root=(s:{slug:string})=>`/public/stores/${s.slug}`;
const cookie=(r:Awaited<ReturnType<typeof http>>)=>r.response.headers.get('Set-Cookie')!.split(';')[0];
const expect=(r:Awaited<ReturnType<typeof http>>,status=200,code?:string)=>{assert.equal(r.status,status,JSON.stringify(r.data));if(code)assert.equal(r.data.code,code);return r.data;};
const same404=(r:Awaited<ReturnType<typeof http>>)=>{
  expect(r,404,'checkout_order_not_found');
  assert.deepEqual(r.data,{type:'about:blank',title:'checkout_order_not_found',status:404,code:'checkout_order_not_found',detail:'找不到訂單。'});
  assert.equal(r.response.headers.get('Set-Cookie'),null);
};
async function until(check:()=>Promise<boolean>,label:string) {
  for(let i=0;i<500;i++){if(await check())return;await delay(10);}assert.fail(label);
}
/** Pause after a real query, inside the transaction with its locks still held. */
async function queryBarrier(match:RegExp) {
  const connect=x.runtime.connect;
  let used=false,release!:()=>void,entered!:(pid:number)=>void;
  const held=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<number>(resolve=>{entered=resolve;});
  x.runtime.connect=(async()=>{
    const q=await (connect as ()=>Promise<import('pg').PoolClient>).call(x.runtime),query=q.query,originalRelease=q.release;
    q.query=(async(...args:unknown[])=>{
      const result=await (query as Function).apply(q,args);
      if(!used&&match.test(String(args[0]))){used=true;const pid=(await (query as Function).call(q,'SELECT pg_backend_pid() pid')).rows[0].pid;entered(pid);await held;}
      return result;
    }) as typeof q.query;
    q.release=(error?:Error|boolean)=>{q.query=query;q.release=originalRelease;originalRelease.call(q,error);};
    return q;
  }) as typeof x.runtime.connect;
  return {ready,release,restore:()=>{release();x.runtime.connect=connect;}};
}
async function lockedRace(match:RegExp,first:()=>ReturnType<typeof http>,second:()=>ReturnType<typeof http>) {
  const barrier=await queryBarrier(match);let a:ReturnType<typeof http>|undefined,b:ReturnType<typeof http>|undefined;
  try {
    a=first();const pid=await barrier.ready;b=second();
    await until(async()=>(await x.h.pool.query('SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rows[0].n>0,'second request must wait on the first transaction');
    barrier.release();return await Promise.all([a,b]);
  } finally {barrier.restore();await Promise.allSettled([a,b]);}
}
async function cookieAttributes(r:Awaited<ReturnType<typeof http>>) {
  const header=r.response.headers.get('Set-Cookie')!,parts=header.split('; '),pair=parts.shift()!;
  assert.equal(pair.split('=')[0],new URL(origin).protocol==='https:'?'__Host-freedom_shop':'freedom_local_shop');
  const maxAge=parts.find(v=>v.startsWith('Max-Age='))!;
  assert.deepEqual(parts.filter(v=>v!==maxAge).sort(),['Path=/','HttpOnly','SameSite=Lax',...(origin.startsWith('https:')?['Secure']:[])].sort());
  const remaining=(await x.h.pool.query('SELECT floor(extract(epoch FROM expires_at-clock_timestamp()))::int seconds FROM commerce_access_devices WHERE token_sha256=$1',[hashKey(pair.split('=')[1])])).rows[0].seconds;
  assert(Math.abs(Number(maxAge.split('=')[1])-remaining)<=2);
}
async function checkout(s:Awaited<ReturnType<CheckoutHarness['store']>>,extra:Record<string,unknown>={},browser?:string,key=randomUUID()) {
  const r=await http('POST',root(s)+'/checkouts',{...x.input(s.product.sku,1),contact:{name:'測試買家甲',email:'buyer@example.test',phone:'0900000000'},...extra},browser,{'Idempotency-Key':key});expect(r,201);return {r,c:r.data,browser:cookie(r),key};
}
async function placed(extra:Record<string,unknown>={},browser?:string) {
  const s=await x.store(50),f=await checkout(s,extra,browser),intent={terms_sha256:f.c.terms_sha256,client_order_id:randomUUID()};
  const r=await http('POST',root(s)+`/checkouts/${f.c.checkout_ref}/orders`,intent,f.browser);expect(r,201);return {s,...f,intent,order:r.data.order};
}
async function requestLink(f:Awaited<ReturnType<typeof placed>>,address='buyer@example.test') {
  const before=(await x.h.pool.query("SELECT count(*)::int n FROM commerce_outbound_emails WHERE order_id=$1 AND template='order_access' AND state='queued'",[f.order.order_ref])).rows[0].n;
  const r=await http('POST',root(f.s)+'/order-access-requests',{email:address,display_number:f.order.display_number});expect(r,202);assert.equal(r.data,null);
  assert.equal((await x.h.pool.query("SELECT count(*)::int n FROM commerce_outbound_emails WHERE order_id=$1 AND template='order_access' AND state='queued'",[f.order.order_ref])).rows[0].n,before+1);
  assert.equal((await runDueCommerceWork(x.runtime,{freedomEnv:origin.startsWith('https:')?'public':'local',origin,emailEnabled:true,emailSender:email,journal})).completed,1);
  const url=email.messages.at(-1)!.text.match(/https?:\/\/[^\s]+/)![0];
  return new URL(url).hash.slice('#access='.length);
}
async function accessState() {
  return {
    devices:(await x.h.pool.query('SELECT * FROM commerce_access_devices ORDER BY device_id')).rows,
    grants:(await x.h.pool.query('SELECT * FROM commerce_order_access_grants ORDER BY grant_id')).rows,
  };
}
/** Historical credential fixture: keep the immutable 168-hour lifetime and all
 * real order FKs. Never alter an issued link, its trigger or the database clock. */
async function expiringLink(f:Awaited<ReturnType<typeof placed>>) {
  const token=randomBytes(32).toString('base64url');
  await x.h.pool.query(`INSERT INTO commerce_order_access_grants(tenant_id,instance_id,checkout_id,order_id,kind,link_token_sha256,created_at,expires_at)
    SELECT tenant_id,instance_id,checkout_id,order_id,'link',$2,t,t+interval '168 hours'
    FROM commerce_checkout_orders CROSS JOIN (SELECT clock_timestamp()-interval '168 hours'+interval '3 seconds' t)n WHERE order_id=$1`,[f.order.order_ref,hashKey(token)]);
  return token;
}
async function linkClock(token:string) {
  return (await x.h.pool.query(`SELECT clock_timestamp() AS observed_at,expires_at,expires_at<=clock_timestamp() AS expired,
    expires_at-created_at=interval '168 hours' AS fixed_lifetime FROM commerce_order_access_grants WHERE link_token_sha256=$1`,[hashKey(token)])).rows[0];
}
async function waitOnTransaction(pid:number,token:string,statement:string|null=null) {
  await until(async()=>(await x.h.pool.query(`SELECT 1 FROM pg_stat_activity a,commerce_order_access_grants g
    WHERE $1=ANY(pg_blocking_pids(a.pid)) AND g.link_token_sha256=$2 AND a.query_start<g.expires_at
      AND ($3::text IS NULL OR a.query LIKE $3)`,[pid,hashKey(token),statement])).rowCount!>0,'HTTP redemption must begin before expiry and wait on the real transaction');
  assert.equal((await linkClock(token)).expired,false,'observe the lock wait while the link is still live');
}
before(async()=>{x=await checkoutHarness('fc_http',{publicSchema:true});origin=x.h.origin;});
beforeEach(async()=>{await x.reset();origin=x.h.origin;email=new FixtureEmailSender();journal=new MemoryEffectJournal('local');policies=[];install();});
after(async()=>{await x?.stop();});

test('cart quotes use current publication prices, classify every line and never settle or hold',async()=>{
  const s=await x.store(2),path=root(s)+'/cart-quotes';
  const input={publication_revision:'1',lines:[{sku:s.product.sku,quantity:1,unit_price_minor:1,line_total_minor:1}]};
  let r=await http('POST',path,input);expect(r);assert.equal(r.data.lines[0].unit_price_minor,100);assert.equal(r.data.shipping.state,'needs_delivery_data');assert.equal(r.data.total_minor,null);
  r=await http('POST',path,{...input,publication_revision:'2',delivery:{method:'synthetic'}});expect(r);assert.equal(r.data.lines[0].state,'revision_changed');assert.equal(r.data.total_minor,100);
  r=await http('POST',path,{...input,lines:[{sku:s.product.sku,quantity:3},{sku:'P9999',quantity:1}]});expect(r);assert.equal(r.data.lines[0].state,'insufficient');assert.equal(r.data.lines[0].available,2);assert.equal(r.data.lines[1].state,'unavailable');assert.equal(r.data.merchandise_total_minor,0);assert.equal(r.data.total_minor,null);
  expect(await http('POST',path,{...input,promotion_code:'X'}),422,'validation_failed');
  assert.equal((await x.h.pool.query('SELECT count(*)::int n FROM commerce_inventory_reservations')).rows[0].n,0);
  await x.due(s,1);r=await http('POST',path,input);expect(r);assert.equal(r.data.lines[0].state,'ok');
  assert.equal((await x.h.pool.query("SELECT count(*)::int n FROM commerce_inventory_reservations WHERE state='held'")).rows[0].n,1,'quote does not settle expired holds');
  assert.equal(r.response.headers.get('Cache-Control'),'no-store');
});
test('checkout create/replay/conflict preserves expiry and re-ensures browser grants',async()=>{
  const s=await x.store(),f=await checkout(s);const body={...x.input(s.product.sku,1),contact:{name:'測試買家甲',email:'buyer@example.test',phone:'0900000000'}};
  const r=await http('POST',root(s)+'/checkouts',body,undefined,{'Idempotency-Key':f.key});expect(r,200);assert.deepEqual(r.data,f.c);assert.notEqual(cookie(r),f.browser);
  expect(await http('POST',root(s)+'/checkouts',{...body,delivery:{different:true}},f.browser,{'Idempotency-Key':f.key}),409,'checkout_idempotency_conflict');
  assert.equal((await x.h.pool.query("SELECT count(*)::int n FROM commerce_order_access_grants WHERE kind='device'")).rows[0].n,2);
  const header=f.r.response.headers.get('Set-Cookie')!;assert(header.startsWith('freedom_local_shop='));for(const value of ['HttpOnly','SameSite=Lax','Path=/','Max-Age='])assert(header.includes(value));assert(!header.includes('Domain='));assert(!header.includes('Secure'));
  await cookieAttributes(f.r);
  assert(!JSON.stringify((await x.h.pool.query('SELECT * FROM commerce_access_devices')).rows).includes(f.browser.split('=')[1]));
});
test('HTTPS cookies use the Host prefix and Secure, preserve absolute device expiry and reject duplicate cookies',async()=>{
  const s=await x.store();origin='https://checkout.example.test';install();const first=await checkout(s),value=first.r.response.headers.get('Set-Cookie')!;
  assert(value.startsWith('__Host-freedom_shop='));assert(value.includes('; Secure'));assert(!value.includes('Domain='));
  await cookieAttributes(first.r);
  const before=(await x.h.pool.query('SELECT device_id,created_at,expires_at FROM commerce_access_devices')).rows;
  const second=await checkout(s,{delivery:{method:'synthetic',extra:true}},first.browser);assert.equal(second.browser,first.browser);assert.deepEqual((await x.h.pool.query('SELECT device_id,created_at,expires_at FROM commerce_access_devices')).rows,before);
  expect(await http('GET',root(s)+'/orders/'+randomUUID(),undefined,first.browser+'; '+first.browser),403,'credential_kind_rejected');
});
test('exact policy set is enforced at freeze and placement; structural delivery bounds reject deep JSON',async()=>{
  const s=await x.store();policies=[{policy_kind:'terms',policy_version_id:randomUUID()}];
  const body=x.input(s.product.sku,1);expect(await http('POST',root(s)+'/checkouts',body,undefined,{'Idempotency-Key':randomUUID()}),422,'consents_mismatch');
  const f=await checkout(s,{consents:policies});policies=[{policy_kind:'terms',policy_version_id:randomUUID()}];
  expect(await http('POST',root(s)+`/checkouts/${f.c.checkout_ref}/orders`,{terms_sha256:f.c.terms_sha256,client_order_id:randomUUID()},f.browser),409,'terms_changed');
  let deep:unknown={};for(let i=0;i<10;i++)deep={child:deep};expect(await http('POST',root(s)+'/checkouts',{...body,delivery:deep},undefined,{'Idempotency-Key':randomUUID()}),422,'invalid_checkout_json');
  assert.equal((await x.h.pool.query('SELECT count(*)::int n FROM commerce_orders')).rows[0].n,0);
});
test('placement new/replay retains the projection; changed terms, shortage and unresolved orders have no extra effects',async()=>{
  const f=await placed(),path=root(f.s)+`/checkouts/${f.c.checkout_ref}/orders`;
  const replay=await http('POST',path,f.intent,f.browser);expect(replay,200);assert.deepEqual(replay.data,{order:f.order,payment:null});
  expect(await http('POST',path,{...f.intent,terms_sha256:'f'.repeat(64)},f.browser),409,'order_intent_conflict');
  const unresolved=await http('POST',path,{...f.intent,client_order_id:randomUUID()},f.browser);expect(unresolved,409,'unresolved_order');assert.equal(unresolved.data.order_ref,f.order.order_ref);
  const c=await checkout(f.s);expect(await http('POST',root(f.s)+`/checkouts/${c.c.checkout_ref}/orders`,{terms_sha256:'f'.repeat(64),client_order_id:randomUUID()},c.browser),409,'terms_changed');
  const short=await checkout(f.s,{lines:[{sku:f.s.product.sku,quantity:99}]});const r=await http('POST',root(f.s)+`/checkouts/${short.c.checkout_ref}/orders`,{terms_sha256:short.c.terms_sha256,client_order_id:randomUUID()},short.browser);expect(r,409,'stock_unavailable');assert.deepEqual(r.data.items,[{sku:f.s.product.sku,available:49}]);
  assert.equal((await x.h.pool.query('SELECT count(*)::int n FROM commerce_orders')).rows[0].n,1);
});
test('order access is non-disclosing across browsers, stores, display numbers and guessed refs; reads write nothing',async()=>{
  const f=await placed(),path=root(f.s)+'/orders/'+f.order.order_ref;
  const before=(await x.h.pool.query('SELECT * FROM commerce_order_access_grants ORDER BY grant_id')).rows;
  const r=await http('GET',path,undefined,f.browser);expect(r);assert.deepEqual(r.data,f.order);assert.equal(r.response.headers.get('Referrer-Policy'),'no-referrer');assert.equal(r.response.headers.get('Cache-Control'),'no-store');
  assert.deepEqual((await x.h.pool.query('SELECT * FROM commerce_order_access_grants ORDER BY grant_id')).rows,before);
  same404(await http('GET',root(f.s)+'/orders/'+f.order.order_ref));
  for(const ref of [f.order.display_number,randomUUID()])same404(await http('GET',root(f.s)+'/orders/'+ref,undefined,f.browser));
  const other=await x.store();same404(await http('GET',root(other)+'/orders/'+f.order.order_ref,undefined,f.browser));
  const browser=(await checkout(other)).browser;same404(await http('GET',path,undefined,browser));
  for(const key of ['supplier','cost','salt','sha256','principal_id','tenant_id','instance_id','item_id'])assert(!JSON.stringify(r.data).includes(key),key);
});
test('a member buyer can read without the device; a session alone cannot place a checkout',async()=>{
  const person=await x.h.person('測試買家甲'),f=await placed({},person.session.cookie),path=root(f.s)+'/orders/'+f.order.order_ref;
  const sessionCookie=person.session.cookie;
  // Checkout's response cookie is a separate credential; send both on placement.
  // placed() supplied only the shop cookie, so this order remains a guest order.
  expect(await http('GET',path,undefined,sessionCookie),404,'checkout_order_not_found');
  const c=await checkout(f.s,{contact:{name:'測試買家甲',email:person.email,phone:'0900000001'}},sessionCookie);
  const input={terms_sha256:c.c.terms_sha256,client_order_id:randomUUID()},placement=root(f.s)+`/checkouts/${c.c.checkout_ref}/orders`;
  expect(await http('POST',placement,input,sessionCookie),404,'checkout_order_not_found');
  const r=await http('POST',placement,input,c.browser+'; '+sessionCookie);expect(r,201);
  const before=(await x.h.pool.query('SELECT last_seen_at FROM sessions WHERE token_hash=$1',[hashKey(sessionCookie.split('=')[1])])).rows;
  expect(await http('GET',root(f.s)+'/orders/'+r.data.order.order_ref,undefined,sessionCookie));
  assert.deepEqual((await x.h.pool.query('SELECT last_seen_at FROM sessions WHERE token_hash=$1',[hashKey(sessionCookie.split('=')[1])])).rows,before);
  const other=await x.h.person('測試買家乙');expect(await http('GET',root(f.s)+'/orders/'+r.data.order.order_ref,undefined,other.session.cookie),404,'checkout_order_not_found');
});
test('link redemption is one-time, grants only its order and resolves a concurrent race exactly once',async()=>{
  const f=await placed(),token=await requestLink(f),path=root(f.s)+'/orders/'+f.order.order_ref;
  const results=await lockedRace(/UPDATE commerce_order_access_grants SET redeemed_at/,()=>http('POST',path+'/access',{token}),()=>http('POST',path+'/access',{token}));assert.deepEqual(results.map(r=>r.status).sort(),[200,404]);
  const winner=results.find(r=>r.status===200)!;expect(await http('GET',path,undefined,cookie(winner)));
  expect(await http('POST',path+'/access',{token}),404,'checkout_order_not_found');
  expect(await http('POST',root(f.s)+`/checkouts/${f.c.checkout_ref}/orders`,f.intent,cookie(winner)),404,'checkout_order_not_found');
  expect(await http('POST',path+'/access',{token:'guessed'}),404,'checkout_order_not_found');
});
for(const expires of [true,false])test(`link redemption after a real redemption rolls back ${expires?'after':'before'} expiry`,async t=>{
  const f=await placed(),token=expires?await expiringLink(f):await requestLink(f),path=root(f.s)+'/orders/'+f.order.order_ref,before=await accessState();
  const q=await x.runtime.connect();let pending:ReturnType<typeof http>|undefined;
  try {
    await q.query('BEGIN');assert(await resolvePublicStorePage(q,f.s.slug));
    const redeemed=await redeemAccessLink(q,{tenant_id:f.s.tenantId,instance_id:f.s.instanceId,order_id:f.order.order_ref},token);
    assert.equal(redeemed.checkout_id,f.c.checkout_ref);
    assert.equal((await q.query('SELECT redeemed_at IS NOT NULL AS redeemed FROM commerce_order_access_grants WHERE link_token_sha256=$1',[hashKey(token)])).rows[0].redeemed,true);
    const pid=(await q.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    pending=http('POST',path+'/access',{token});await waitOnTransaction(pid,token);
    t.diagnostic(JSON.stringify({event:'redemption_blocked_before_expiry',...(await linkClock(token))}));
    if(expires)await until(async()=>(await linkClock(token)).expired,'database clock must cross the immutable link expiry while HTTP is blocked');
    const atRelease=await linkClock(token);assert.equal(atRelease.expired,expires);assert.equal(atRelease.fixed_lifetime,true);
    t.diagnostic(JSON.stringify({event:'blocker_rollback',...atRelease}));await q.query('ROLLBACK');
    const result=await pending;
    if(expires) {
      same404(result);assert.deepEqual(await accessState(),before,'failed redemption rolls back every credential effect');
      same404(await http('POST',path+'/access',{token}));same404(await http('GET',path));
      assert.deepEqual(await accessState(),before);
      // A fresh B10 email remains a recovery path after the stale link failed.
      const fresh=await requestLink(f);assert.notEqual(fresh,token);
      const recovered=await http('POST',path+'/access',{token:fresh});expect(recovered);assert.deepEqual(recovered.data,f.order);
      assert.deepEqual(expect(await http('GET',path,undefined,cookie(recovered))),f.order);
      const old=(await x.h.pool.query('SELECT * FROM commerce_order_access_grants WHERE link_token_sha256=$1',[hashKey(token)])).rows[0];
      assert.deepEqual(old,before.grants.find(g=>g.link_token_sha256===hashKey(token)));
    } else {
      expect(result);assert.deepEqual(result.data,f.order);assert.deepEqual(expect(await http('GET',path,undefined,cookie(result))),f.order);
      const after=await accessState(),link=after.grants.find(g=>g.link_token_sha256===hashKey(token))!;
      assert(link.redeemed_at>=atRelease.observed_at,'redemption timestamp is sampled after the rollback released its lock');
      assert.deepEqual({...link,redeemed_at:null},before.grants.find(g=>g.grant_id===link.grant_id));
      assert.equal(after.devices.length,before.devices.length+1);assert.equal(after.grants.length,before.grants.length+1);
      same404(await http('POST',path+'/access',{token}));assert.deepEqual(await accessState(),after);
    }
  } finally {await q.query('ROLLBACK');q.release();await Promise.allSettled([pending]);}
});
for(const locked of ['device','order'] as const)test(`link expiry while redemption waits on its ${locked} rolls back every credential write`,async t=>{
  const f=await placed(),token=await expiringLink(f),path=root(f.s)+'/orders/'+f.order.order_ref,before=await accessState();
  const q=await x.h.pool.connect();let pending:ReturnType<typeof http>|undefined;
  try {
    await q.query('BEGIN');
    if(locked==='device')await q.query('SELECT device_id FROM commerce_access_devices WHERE token_sha256=$1 FOR UPDATE',[hashKey(f.browser.split('=')[1])]);
    else await q.query('SELECT order_id FROM commerce_checkout_orders WHERE order_id=$1 FOR UPDATE',[f.order.order_ref]);
    const pid=(await q.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    pending=http('POST',path+'/access',{token},locked==='device'?f.browser:undefined);
    // With no browser credential, grantDevice's FK wait occurs after the real
    // new device INSERT. The failed redemption must roll that device back too.
    await waitOnTransaction(pid,token,locked==='order'?'INSERT INTO commerce_order_access_grants%':null);
    await until(async()=>(await linkClock(token)).expired,'database clock must cross link expiry during the downstream lock wait');
    t.diagnostic(JSON.stringify({event:locked+'_blocker_rollback',...(await linkClock(token))}));await q.query('ROLLBACK');
    same404(await pending);assert.deepEqual(await accessState(),before);same404(await http('GET',path));
    same404(await http('POST',path+'/access',{token},f.browser));assert.deepEqual(await accessState(),before);
  } finally {await q.query('ROLLBACK');q.release();await Promise.allSettled([pending]);}
});
test('after forgetting a placed checkout, original keys cannot restore access but a fresh B10 link restores only its order',async()=>{
  const f=await placed(),path=root(f.s)+'/orders/'+f.order.order_ref;
  expect(await http('POST','/public/order-access/forget',{},f.browser),204);const before=await accessState();
  const retry=()=>http('POST',root(f.s)+'/checkouts',{...x.input(f.s.product.sku,1),contact:{name:'測試買家甲',email:'buyer@example.test',phone:'0900000000'}},undefined,{'Idempotency-Key':f.key});
  const stale=await retry();expect(stale,409,'checkout_expired');assert.equal(stale.response.headers.get('Set-Cookie'),null);
  same404(await http('POST',root(f.s)+`/checkouts/${f.c.checkout_ref}/orders`,f.intent,f.browser));same404(await http('GET',path,undefined,f.browser));
  assert.deepEqual(await accessState(),before);
  const token=await requestLink(f);assert.equal((await linkClock(token)).fixed_lifetime,true);
  const recovered=await http('POST',path+'/access',{token});expect(recovered);assert.deepEqual(recovered.data,f.order);
  const browser=cookie(recovered),after=await accessState();assert.notEqual(browser,f.browser);
  assert.deepEqual(expect(await http('GET',path,undefined,browser)),f.order);
  const device=after.devices.find(d=>d.token_sha256===hashKey(browser.split('=')[1]))!;
  assert.deepEqual(after.grants.filter(g=>g.device_id===device.device_id).map(g=>({checkout_id:g.checkout_id,order_id:g.order_id})),[{checkout_id:f.c.checkout_ref,order_id:f.order.order_ref}]);
  same404(await http('POST',root(f.s)+`/checkouts/${f.c.checkout_ref}/orders`,f.intent,browser));
  same404(await http('POST',path+'/access',{token}));expect(await retry(),409,'checkout_expired');assert.deepEqual(await accessState(),after);
});
test('revoked and expired device credentials cannot read; forget clears and revokes the whole browser',async()=>{
  const f=await placed(),path=root(f.s)+'/orders/'+f.order.order_ref;
  const r=await http('POST','/public/order-access/forget',{},f.browser);expect(r,204);assert(r.response.headers.get('Set-Cookie')!.includes('Max-Age=0'));
  expect(await http('GET',path,undefined,f.browser),404,'checkout_order_not_found');
  const token=randomBytes(32).toString('base64url'),id=randomUUID();
  await x.h.pool.query(`INSERT INTO commerce_access_devices(device_id,token_sha256,created_at,expires_at) SELECT $1,$2,t,t+interval '4320 hours' FROM (SELECT clock_timestamp()-interval '181 days' t)n`,[id,hashKey(token)]);
  await x.h.pool.query(`INSERT INTO commerce_order_access_grants(tenant_id,instance_id,checkout_id,kind,device_id) VALUES($1,$2,$3,'device',$4)`,[f.s.tenantId,f.s.instanceId,f.c.checkout_ref,id]);
  expect(await http('GET',path,undefined,shopCookieName(origin)+'='+token),404,'checkout_order_not_found');
});
test('B10 normalizes email, sends only fixture mail for matches and adds no plaintext persistence anywhere in public',async()=>{
  const f=await placed();const counts=async()=>(await x.h.pool.query('SELECT (SELECT count(*) FROM commerce_customers)::int customers,(SELECT count(*) FROM commerce_checkout_contacts)::int contacts')).rows[0];
  const before=await counts();
  const scan=async(address:string)=>{
    const columns=(await x.h.pool.query<{table_name:string;column_name:string}>(`SELECT c.table_name,c.column_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name
      WHERE c.table_schema='public' AND t.table_type='BASE TABLE' AND c.data_type IN ('text','character varying','jsonb') ORDER BY c.table_name,c.ordinal_position`)).rows;
    assert(columns.length>0);const found:string[]=[];const identifier=(s:string)=>'"'+s.replaceAll('"','""')+'"';
    for(const c of columns)if((await x.h.pool.query(`SELECT 1 FROM public.${identifier(c.table_name)} WHERE position($1 in lower(${identifier(c.column_name)}::text))>0 LIMIT 1`,[address])).rowCount)found.push(c.table_name+'.'+c.column_name);
    return found.sort();
  };
  expect(await http('POST',root(f.s)+'/order-access-requests',{email:'  NoSuchBuyer@Example.Test  ',display_number:f.order.display_number}),202);assert.equal(email.messages.length,0);assert.deepEqual(await scan('nosuchbuyer@example.test'),[]);
  await requestLink(f,'  BuYeR@Example.Test  ');assert.equal(email.messages.length,1);assert.equal(email.messages[0].to,'buyer@example.test');
  assert.deepEqual(await scan('buyer@example.test'),['commerce_checkout_contacts.contact_email','commerce_customers.email_normalized']);assert.deepEqual(await counts(),before);
  const buckets=(await x.h.pool.query("SELECT bucket FROM auth_rate_limits WHERE bucket LIKE 'commerce:accessRequestEmail:%'")).rows;
  assert(buckets.some(r=>r.bucket.endsWith(hashKey('buyer@example.test'))));assert(!JSON.stringify(buckets).includes('buyer@example.test'));
});
test('B10 remains empty 202 on unmatched/redacted and no port refuses before SQL access',async()=>{
  const f=await placed();expect(await http('POST',root(f.s)+'/order-access-requests',{email:'buyer@example.test',display_number:'unknown'}),202);assert.equal(email.messages.length,0);
  await x.h.pool.query(`UPDATE commerce_checkout_contacts SET contact_name=NULL,contact_email=NULL,contact_phone=NULL,delivery=NULL,invoice=NULL,contact_salt=NULL,redacted_at=clock_timestamp() WHERE checkout_id=$1`,[f.c.checkout_ref]);
  expect(await http('GET',root(f.s)+'/orders/'+f.order.order_ref,undefined,f.browser));
  const r=await http('GET',root(f.s)+'/orders/'+f.order.order_ref,undefined,f.browser);assert.equal(r.data.redacted,true);assert.equal(r.data.contact,null);
  expect(await http('POST',root(f.s)+'/order-access-requests',{email:'buyer@example.test',display_number:f.order.display_number}),202);assert.equal(email.messages.length,0);
  assert.equal((await x.h.pool.query('SELECT count(*)::int n FROM commerce_outbound_emails')).rows[0].n,0);
  install({checkoutEnabled:true,consoleEnabled:true,quarantine:false,providerProfiles:[],emailEnabled:false});const original=x.runtime.connect;x.runtime.connect=(()=>{throw Error('B10 must not access SQL without an email port');}) as typeof x.runtime.connect;
  try{expect(await http('POST',root(f.s)+'/order-access-requests',{email:'buyer@example.test',display_number:f.order.display_number}),409,'order_access_email_unavailable');}finally{x.runtime.connect=original;}
});
test('host gates keep order recovery readable and forget clears its cookie in quarantine',async()=>{
  const f=await placed(),body=x.input(f.s.product.sku,1);
  for(const [settings,extra,status,code] of [
    [{checkoutEnabled:true,consoleEnabled:true,quarantine:true,providerProfiles:[]},{},503,'commerce_quarantined'],[{checkoutEnabled:false,quarantine:false,providerProfiles:[]},{},409,'checkout_not_enabled'],
    [{checkoutEnabled:true,consoleEnabled:true,quarantine:false,providerProfiles:[]},{admission:{allowed:()=>false}},409,'checkout_not_enabled'],
  ] as const) {
    install(settings,extra);for(const [path,input] of [[root(f.s)+'/cart-quotes',{publication_revision:'1',lines:body.lines}],[root(f.s)+'/checkouts',body],[root(f.s)+`/checkouts/${f.c.checkout_ref}/orders`,f.intent]] as const)expect(await http('POST',path,input,f.browser,{'Idempotency-Key':randomUUID()}),status,code);
    expect(await http('GET',root(f.s)+'/orders/'+f.order.order_ref,undefined,f.browser));
  }
  install({checkoutEnabled:false,quarantine:true,providerProfiles:[]});const r=await http('POST','/public/order-access/forget',{},f.browser);expect(r,503,'commerce_quarantined');assert(r.response.headers.get('Set-Cookie')!.includes('Max-Age=0'));
});

test('expired, revoked and wrong-store links all return the same 404 without a device or redemption effect',async()=>{
  const f=await placed(),token=await requestLink(f),other=await x.store(),path=root(f.s)+'/orders/'+f.order.order_ref;
  expect(await http('POST',root(other)+'/orders/'+f.order.order_ref+'/access',{token}),404,'checkout_order_not_found');
  const expired=randomBytes(32).toString('base64url');
  await x.h.pool.query(`INSERT INTO commerce_order_access_grants(tenant_id,instance_id,checkout_id,order_id,kind,link_token_sha256,created_at,expires_at)
    SELECT tenant_id,instance_id,checkout_id,order_id,'link',$1,t,t+interval '168 hours' FROM commerce_order_access_grants CROSS JOIN (SELECT clock_timestamp()-interval '8 days' t)n WHERE link_token_sha256=$2`,[hashKey(expired),hashKey(token)]);
  expect(await http('POST',path+'/access',{token:expired}),404,'checkout_order_not_found');
  await x.h.pool.query('UPDATE commerce_order_access_grants SET revoked_at=clock_timestamp() WHERE link_token_sha256=$1',[hashKey(token)]);
  expect(await http('POST',path+'/access',{token}),404,'checkout_order_not_found');assert.equal((await x.h.pool.query('SELECT count(*)::int n FROM commerce_order_access_grants WHERE redeemed_at IS NOT NULL')).rows[0].n,0);
});
test('an expired checkout rejects placement and leaves no order or hold',async()=>{
  const s=await x.store(),f=await checkout(s),id=randomUUID(),contactId=randomUUID(),expiredKey=randomUUID();
  const replayBody={...x.input(s.product.sku,1),contact:{name:'測試買家甲',email:'buyer@example.test',phone:'0900000000'}};
  const requestHash=createHmac('sha256',expiredKey).update(canonicalJSON({input:parseCheckoutInput(replayBody),checkout_id:null})).digest('hex');
  await x.tx(async q=>{
    const {lockStore}=await import('../../modules/agent-commerce/checkout/authority.js');await lockStore(q,s);
    await q.query(`INSERT INTO commerce_checkout_contacts(contact_id,checkout_id,tenant_id,instance_id,contact_name,contact_email,contact_phone,delivery,invoice,contact_sha256,contact_salt)
      SELECT $2,$3,tenant_id,instance_id,contact_name,contact_email,contact_phone,delivery,invoice,contact_sha256,contact_salt FROM commerce_checkout_contacts WHERE checkout_id=$1`,[f.c.checkout_ref,contactId,id]);
    await q.query(`INSERT INTO commerce_checkouts(checkout_id,tenant_id,instance_id,customer_id,publication_revision,currency,terms,terms_sha256,current_contact_id,idempotency_key_sha256,request_sha256,created_at,expires_at)
      SELECT $2,tenant_id,instance_id,customer_id,publication_revision,currency,terms,terms_sha256,$3,$4,$5,t,t+interval '24 hours'
      FROM commerce_checkouts CROSS JOIN (SELECT date_trunc('milliseconds',clock_timestamp())-interval '25 hours' t)n WHERE checkout_id=$1`,[f.c.checkout_ref,id,contactId,hashKey(expiredKey),requestHash]);
    await q.query(`INSERT INTO commerce_checkout_idempotency_keys(checkout_id,tenant_id,instance_id,idempotency_key_sha256,request_sha256,response)
      SELECT checkout_id,tenant_id,instance_id,idempotency_key_sha256,request_sha256,
        jsonb_build_object('checkout_id',checkout_id,'terms',terms,'terms_sha256',terms_sha256,'expires_at',expires_at,'version',version::text)
      FROM commerce_checkouts WHERE checkout_id=$1`,[id]);
    const device=(await q.query('SELECT device_id FROM commerce_access_devices WHERE token_sha256=$1',[hashKey(f.browser.split('=')[1])])).rows[0];
    await q.query(`INSERT INTO commerce_order_access_grants(tenant_id,instance_id,checkout_id,kind,device_id) VALUES($1,$2,$3,'device',$4)`,[s.tenantId,s.instanceId,id,device.device_id]);
  });
  expect(await http('POST',root(s)+`/checkouts/${id}/orders`,{terms_sha256:f.c.terms_sha256,client_order_id:randomUUID()},f.browser),409,'checkout_expired');
  assert.equal((await x.h.pool.query('SELECT count(*)::int n FROM commerce_orders')).rows[0].n,0);
  const before=(await x.h.pool.query('SELECT (SELECT count(*) FROM commerce_access_devices)::int devices,(SELECT count(*) FROM commerce_order_access_grants)::int grants')).rows;
  const replay=await http('POST',root(s)+'/checkouts',replayBody,undefined,{'Idempotency-Key':expiredKey});expect(replay,409,'checkout_expired');assert.equal(replay.response.headers.get('Set-Cookie'),null);
  assert.deepEqual((await x.h.pool.query('SELECT (SELECT count(*) FROM commerce_access_devices)::int devices,(SELECT count(*) FROM commerce_order_access_grants)::int grants')).rows,before);
});
test('confirmed payment outcomes and reservation expiry are projected without enabling a payment attempt',async()=>{
  const f=await placed();const {applyConfirmedPayment}=await import('../../modules/agent-commerce/checkout/index.js');
  await x.tx(q=>applyConfirmedPayment(q,{orderId:f.order.order_ref,paymentRef:randomUUID(),amountMinor:100,currency:'TWD',simulated:false}));
  const r=await http('GET',root(f.s)+'/orders/'+f.order.order_ref,undefined,f.browser);expect(r);assert.equal(r.data.payment_state,'confirmed');assert.equal(r.data.reservation_expired,false);
});

test('concurrent checkout and placement retries create one effect and one new response',async()=>{
  const s=await x.store(50),key=randomUUID(),body=x.input(s.product.sku,1);
  const created=await lockedRace(/INSERT INTO commerce_checkout_idempotency_keys/,()=>http('POST',root(s)+'/checkouts',body,undefined,{'Idempotency-Key':key}),()=>http('POST',root(s)+'/checkouts',body,undefined,{'Idempotency-Key':key}));
  assert.deepEqual(created.map(r=>r.status).sort(),[200,201]);assert.deepEqual(created[0].data,created[1].data);
  const input={terms_sha256:created[0].data.terms_sha256,client_order_id:randomUUID()},path=root(s)+`/checkouts/${created[0].data.checkout_ref}/orders`;
  const placed=await lockedRace(/INSERT INTO commerce_checkout_orders/,()=>http('POST',path,input,cookie(created[0])),()=>http('POST',path,input,cookie(created[1])));
  assert.deepEqual(placed.map(r=>r.status).sort(),[200,201]);assert.deepEqual(placed[0].data,placed[1].data);
  assert.equal((await x.h.pool.query('SELECT count(*)::int n FROM commerce_inventory_reservations')).rows[0].n,1);
});
test('checkout replay respects exhausted creation budgets and failed creation leaves no rows or credential',async()=>{
  const s=await x.store(),f=await checkout(s),before=(await x.h.pool.query('SELECT count(*)::int n FROM commerce_access_devices')).rows[0].n;
  await x.h.pool.query("UPDATE auth_rate_limits SET attempts=10000 WHERE bucket LIKE 'commerce:checkout%'");
  const body={...x.input(s.product.sku,1),contact:{name:'測試買家甲',email:'buyer@example.test',phone:'0900000000'}};
  const replay=await http('POST',root(s)+'/checkouts',body,f.browser,{'Idempotency-Key':f.key});expect(replay,429,'commerce_rate_limited');assert.match(replay.response.headers.get('Retry-After')!,/^[1-9][0-9]*$/);assert.equal(replay.response.headers.get('Set-Cookie'),null);
  const r=await http('POST',root(s)+'/checkouts',body,undefined,{'Idempotency-Key':randomUUID()});expect(r,429,'commerce_rate_limited');assert(Number(r.response.headers.get('Retry-After'))>0);
  assert.equal((await x.h.pool.query('SELECT count(*)::int n FROM commerce_checkouts')).rows[0].n,1);assert.equal((await x.h.pool.query('SELECT count(*)::int n FROM commerce_access_devices')).rows[0].n,before);
});
test('B10 exhaustion of each budget stays empty 202 and creates no mail or link',async()=>{
  const f=await placed();
  const {COMMERCE_LIMITS}=await import('../../modules/agent-commerce/checkout/limits.js');
  for(const [name,key] of [['accessRequestNetwork','192.0.2.1'],['accessRequestEmail','buyer@example.test'],['accessRequestGlobal','global']] as const) {
    await x.h.pool.query('TRUNCATE auth_rate_limits');await x.h.pool.query('INSERT INTO auth_rate_limits(bucket,window_start,attempts) VALUES($1,clock_timestamp(),$2)',[`commerce:${name}:${hashKey(key)}`,COMMERCE_LIMITS[name].limit]);
    const r=await http('POST',root(f.s)+'/order-access-requests',{email:' BuYeR@Example.Test ',display_number:f.order.display_number});expect(r,202);assert.equal(r.data,null);assert.equal(email.messages.length,0);
  }
  assert.equal((await x.h.pool.query("SELECT count(*)::int n FROM commerce_order_access_grants WHERE kind='link'")).rows[0].n,0);
  assert.equal((await x.h.pool.query('SELECT count(*)::int n FROM commerce_outbound_emails')).rows[0].n,0);
});
test('email failure happens after commit, returns 202 and logs only a fixed marker and error name',async()=>{
  const f=await placed(),logs:string[]=[],previous=console.error;
  const failing=new FixtureEmailSender();failing.send=async()=>{assert.equal((await x.h.pool.query("SELECT count(*)::int n FROM commerce_order_access_grants WHERE kind='link'")).rows[0].n,1);throw new TypeError('buyer@example.test synthetic-secret');};
  console.error=(...args)=>logs.push(args.join(' '));
  try{
    expect(await http('POST',root(f.s)+'/order-access-requests',{email:'buyer@example.test',display_number:f.order.display_number}),202);
    assert.equal((await x.h.pool.query("SELECT count(*)::int n FROM commerce_order_access_grants WHERE kind='link'")).rows[0].n,0);
    await runDueCommerceWork(x.runtime,{freedomEnv:'local',origin,emailEnabled:true,emailSender:failing,journal});
  }finally{console.error=previous;}
  assert.deepEqual(logs,[JSON.stringify({event:'commerce_email_failed',template:'order_access',code:'send_failed'})]);
});

for(const [name,route,keyKind] of [
  ['cartNetwork','quote','network'],['cartStore','quote','store'],
  ['checkoutNetwork','checkout','network'],['checkoutStore','checkout','store'],
  ['placementNetwork','placement','network'],['placementStore','placement','store'],['newOrderNetwork','placement','network'],
  ['redemptionNetwork','redemption','network'],
] as const)test(`HTTP wires exactly the ${name} budget and returns numeric Retry-After`,async()=>{
  const f=await placed(),key=keyKind==='store'?f.s.instanceId:'192.0.2.1';
  const c=route==='placement'?await checkout(f.s):f;
  await x.h.pool.query('TRUNCATE auth_rate_limits');
  await x.h.pool.query('INSERT INTO auth_rate_limits(bucket,window_start,attempts) VALUES($1,clock_timestamp(),$2)',[`commerce:${name}:${hashKey(key)}`,COMMERCE_LIMITS[name].limit]);
  const before=(await x.h.pool.query('SELECT count(*)::int n FROM commerce_orders')).rows;
  const r=route==='quote'?await http('POST',root(f.s)+'/cart-quotes',{publication_revision:'1',lines:[{sku:f.s.product.sku,quantity:1}]}):
    route==='checkout'?await http('POST',root(f.s)+'/checkouts',x.input(f.s.product.sku,1),undefined,{'Idempotency-Key':randomUUID()}):
    route==='placement'?await http('POST',root(f.s)+`/checkouts/${c.c.checkout_ref}/orders`,{terms_sha256:c.c.terms_sha256,client_order_id:randomUUID()},c.browser):
    await http('POST',root(f.s)+`/orders/${f.order.order_ref}/access`,{token:'wrong'});
  expect(r,429,'commerce_rate_limited');assert.match(r.response.headers.get('Retry-After')!,/^[1-9][0-9]*$/);
  assert.deepEqual((await x.h.pool.query('SELECT count(*)::int n FROM commerce_orders')).rows,before);assert.equal(r.response.headers.get('Set-Cookie'),null);
});
test('attempt budgets count checkout/placement replay and failed redemption, but failed placement has no new-order charge',async()=>{
  const f=await placed(),body={...x.input(f.s.product.sku,1),contact:{name:'測試買家甲',email:'buyer@example.test',phone:'0900000000'}};
  const c=await checkout(f.s),counts=async()=>(await x.h.pool.query('SELECT bucket,attempts FROM auth_rate_limits ORDER BY bucket')).rows;
  const before=await counts();
  expect(await http('POST',root(f.s)+'/checkouts',body,c.browser,{'Idempotency-Key':c.key}),200);
  expect(await http('POST',root(f.s)+`/checkouts/${f.c.checkout_ref}/orders`,f.intent,f.browser),200);
  same404(await http('POST',root(f.s)+`/orders/${f.order.order_ref}/access`,{token:'wrong'}));
  expect(await http('POST',root(f.s)+`/checkouts/${c.c.checkout_ref}/orders`,{terms_sha256:'f'.repeat(64),client_order_id:randomUUID()},c.browser),409,'terms_changed');
  const after=await counts();
  assert.deepEqual(after,before.map(row=>({...row,attempts:row.attempts+(row.bucket.startsWith('commerce:checkout')?1:row.bucket.startsWith('commerce:placement')?2:0)})).concat([{bucket:`commerce:redemptionNetwork:${hashKey('192.0.2.1')}`,attempts:1}]).sort((a,b)=>a.bucket.localeCompare(b.bucket)));
});
test('unknown slug charges only the route network bucket',async()=>{
  for(const [suffix,body,name] of [
    ['/cart-quotes',{publication_revision:'1',lines:[{sku:'P0001',quantity:1}]},'cartNetwork'],
    ['/checkouts',x.input('P0001',1),'checkoutNetwork'],
    [`/checkouts/${randomUUID()}/orders`,{terms_sha256:'a'.repeat(64),client_order_id:randomUUID()},'placementNetwork'],
    [`/orders/${randomUUID()}/access`,{token:'wrong'},'redemptionNetwork'],
  ] as const) {
    await x.h.pool.query('TRUNCATE auth_rate_limits');
    expect(await http('POST','/public/stores/unknown-shop'+suffix,body,undefined,{'Idempotency-Key':randomUUID()}),404);
    assert.deepEqual((await x.h.pool.query('SELECT bucket,attempts FROM auth_rate_limits')).rows,[{bucket:`commerce:${name}:${hashKey('192.0.2.1')}`,attempts:1}]);
  }
});
test('quote snapshot does not hold its already committed bucket rows',async()=>{
  const s=await x.store(),barrier=await queryBarrier(/SET TRANSACTION READ ONLY/);let pending:ReturnType<typeof http>|undefined;
  try {
    pending=http('POST',root(s)+'/cart-quotes',{publication_revision:'1',lines:[{sku:s.product.sku,quantity:1}]});await barrier.ready;
    const q=await x.h.pool.connect();try {
      await q.query('BEGIN');await q.query("SET LOCAL lock_timeout='250ms'");
      const r=await q.query("UPDATE auth_rate_limits SET attempts=attempts+1 WHERE bucket=$1 RETURNING attempts",[`commerce:cartNetwork:${hashKey('192.0.2.1')}`]);
      assert.deepEqual(r.rows,[{attempts:2}]);await q.query('COMMIT');
    } finally {await q.query('ROLLBACK');q.release();}
    barrier.release();expect(await pending);
  } finally {barrier.restore();await pending;}
});
test('checkout public terms are an exact allowlist, replay identically and retain the full stored hash for placement',async()=>{
  const s=await x.store(),f=await checkout(s),terms=f.c.terms;
  assert.deepEqual(Object.keys(terms).sort(),['publication_revision','currency','items','merchandise_total_minor','discount_total_minor','discounts','shipping','shipping_total_minor','tax_state','total_minor','consents','payment_methods','offline_payment'].sort());
  assert.equal(terms.offline_payment,null,'the card-only fixture has no offline payment terms');
  assert.deepEqual(Object.keys(terms.items[0]).sort(),['sku','title','quantity','unit_price_minor','line_total_minor'].sort());
  assert.deepEqual(Object.keys(terms.shipping).sort(),['destination_state','groups']);
  assert.deepEqual(Object.keys(terms.shipping.groups[0]).sort(),['amount_minor','fee_per_parcel_minor','group_ref','handling_days','items','meetup_note','method','outlying_surcharge_per_parcel_minor','parcel_count']);
  for(const key of ['supplier','selection','item_id','offer','acceptance','listing','publication_id','contact_sha256','agreement','service_key','ship_from','profile_version','logistics'])assert(!JSON.stringify(terms).includes(key),key);
  const stored=(await x.h.pool.query('SELECT terms,terms_sha256 FROM commerce_checkouts WHERE checkout_id=$1',[f.c.checkout_ref])).rows[0];
  assert.equal(f.c.terms_sha256,stored.terms_sha256);assert(stored.terms.bindings.length===1);
  const body={...x.input(s.product.sku,1),contact:{name:'測試買家甲',email:'buyer@example.test',phone:'0900000000'}};
  const replay=await http('POST',root(s)+'/checkouts',body,f.browser,{'Idempotency-Key':f.key});expect(replay);assert.deepEqual(replay.data,f.c);
  expect(await http('POST',root(s)+`/checkouts/${f.c.checkout_ref}/orders`,{terms_sha256:f.c.terms_sha256,client_order_id:randomUUID()},f.browser),201);
});
for(const transition of ['guest-member','member-guest','member-other'] as const)test(`checkout replay ${transition} keeps the first customer link`,async()=>{
  const s=await x.store(),a=await x.h.person('測試買家甲'),b=await x.h.person('測試買家乙');
  await x.h.pool.query('UPDATE users SET email_verified_at=clock_timestamp() WHERE user_id=ANY($1::uuid[])',[[a.id,b.id]]);
  const body={...x.input(s.product.sku,1),contact:{name:'測試買家甲',email:a.email,phone:'0900000000'}},key=randomUUID();
  const first=await http('POST',root(s)+'/checkouts',body,transition==='guest-member'?undefined:a.session.cookie,{'Idempotency-Key':key});expect(first,201);
  const before=(await x.h.pool.query('SELECT member_principal_id FROM commerce_customers')).rows;
  const second=await http('POST',root(s)+'/checkouts',body,transition==='member-guest'?undefined:b.session.cookie,{'Idempotency-Key':key});expect(second,200);assert.deepEqual(second.data,first.data);
  assert.deepEqual((await x.h.pool.query('SELECT member_principal_id FROM commerce_customers')).rows,before);
  if(transition==='guest-member')assert.deepEqual(before,[{member_principal_id:null}]);else assert(before[0].member_principal_id);
});
test('checkout replay after an order exists cannot restore browser access',async()=>{
  const f=await placed(),before=(await x.h.pool.query('SELECT (SELECT count(*) FROM commerce_access_devices)::int devices,(SELECT count(*) FROM commerce_order_access_grants)::int grants')).rows;
  const r=await http('POST',root(f.s)+'/checkouts',{...x.input(f.s.product.sku,1),contact:{name:'測試買家甲',email:'buyer@example.test',phone:'0900000000'}},undefined,{'Idempotency-Key':f.key});
  expect(r,409,'checkout_expired');assert.equal(r.response.headers.get('Set-Cookie'),null);
  assert.deepEqual((await x.h.pool.query('SELECT (SELECT count(*) FROM commerce_access_devices)::int devices,(SELECT count(*) FROM commerce_order_access_grants)::int grants')).rows,before);
});
for(const bad of ['\u0000','\ud800'])test(`invalid Unicode ${JSON.stringify(bad)} is rejected before persistence`,async()=>{
  const s=await x.store(),body=x.input(s.product.sku,1);
  const before=(await x.h.pool.query('SELECT (SELECT count(*) FROM commerce_checkouts)::int checkouts,(SELECT count(*) FROM commerce_checkout_contacts)::int contacts,(SELECT count(*) FROM commerce_order_access_grants)::int grants')).rows;
  const cases:[string,unknown][]=[
    ['/checkouts',{...body,lines:[{sku:'P'+bad,quantity:1}]}],['/checkouts',{...body,contact:{...body.contact,name:'測試'+bad}}],
    ['/checkouts',{...body,contact:{...body.contact,email:'buyer'+bad+'@example.test'}}],['/checkouts',{...body,contact:{...body.contact,phone:'0900000000'+bad}}],
    ['/checkouts',{...body,delivery:{nested:['測試'+bad]}}],['/checkouts',{...body,invoice:{nested:{value:bad}}}],
    ['/cart-quotes',{publication_revision:'1',lines:body.lines,delivery:{nested:{value:bad}}}],
    ['/order-access-requests',{email:'buyer'+bad+'@example.test',display_number:'unknown'}],['/order-access-requests',{email:'buyer@example.test',display_number:'unknown'+bad}],
    [`/orders/${randomUUID()}/access`,{token:bad}],
  ];
  for(const [path,input] of cases)expect(await http('POST',root(s)+path,input,undefined,{'Idempotency-Key':randomUUID()}),422,'validation_failed');
  assert.deepEqual((await x.h.pool.query('SELECT (SELECT count(*) FROM commerce_checkouts)::int checkouts,(SELECT count(*) FROM commerce_checkout_contacts)::int contacts,(SELECT count(*) FROM commerce_order_access_grants)::int grants')).rows,before);assert.deepEqual(email.messages,[]);
});
test('checkout and quote reject nested aggregate_version and share the delivery depth/size walker',async()=>{
  const s=await x.store(),body=x.input(s.product.sku,1),before=(await x.h.pool.query('SELECT count(*)::int n FROM commerce_checkouts')).rows;
  let deep:unknown={};for(let i=0;i<10;i++)deep={child:deep};
  for(const delivery of [{nested:{aggregate_version:'9007199254740992'}},deep,{text:'x'.repeat(8193)}])for(const path of ['/cart-quotes','/checkouts']) {
    const r=await http('POST',root(s)+path,path==='/checkouts'?{...body,delivery}:{publication_revision:'1',lines:body.lines,delivery},undefined,{'Idempotency-Key':randomUUID()});
    expect(r,422,'text' in (delivery as object)?'checkout_contact_too_large':'invalid_checkout_json');
  }
  expect(await http('POST',root(s)+'/checkouts',{...body,invoice:{nested:[{aggregate_version:'1'}]}},undefined,{'Idempotency-Key':randomUUID()}),422,'invalid_checkout_json');
  assert.deepEqual((await x.h.pool.query('SELECT count(*)::int n FROM commerce_checkouts')).rows,before);
});
test('unknown Problems, unsafe codes and response ZodErrors map to fixed internal_error with one code-only log',async()=>{
  const s=await x.store(),logs:unknown[][]=[],previous=console.error;
  for(const [error,name] of [[new Problem(409,'reservation_inconsistent','buyer@example.test secret'),'reservation_inconsistent'],[new Problem(500,'not a code','private'),'unknown'],[new Error('private'),'unknown']] as const) {
    install(undefined,{admission:{allowed:()=>{throw error;}}});console.error=(...args)=>logs.push(args);
    try {
      const r=await http('POST',root(s)+'/cart-quotes',{publication_revision:'1',lines:[{sku:s.product.sku,quantity:1}]});expect(r,500,'internal_error');
      assert.deepEqual(wire.CheckoutErrorSchema.parse(r.data),{type:'about:blank',title:'internal_error',status:500,code:'internal_error',detail:'結帳服務暫時無法使用。'});
    } finally {console.error=previous;}
    assert.deepEqual(logs.splice(0),[['checkout_internal_error',name]]);
  }
  // Inject malformed response data at the public parser without corrupting retained rows.
  install();const f=await placed(),parse=wire.PublicOrderSchema.parse;
  wire.PublicOrderSchema.parse=((value:unknown)=>parse({...value as object,contact:{name:'',email:'buyer@example.test',phone:'0900000000'}})) as typeof parse;
  console.error=(...args)=>logs.push(args);
  try {expect(await http('GET',root(f.s)+'/orders/'+f.order.order_ref,undefined,f.browser),500,'internal_error');}finally{console.error=previous;wire.PublicOrderSchema.parse=parse;}
  assert.deepEqual(logs,[['checkout_internal_error','unknown']]);
  expect(await http('POST',root(s)+'/checkouts',{}),422,'validation_failed');
});

test('disabled person principal remains a guest on checkout and placement despite an active session',async()=>{
  const {mapPersonPrincipal}=await import('../../packages/resource-scopes/index.js'),s=await x.store(),a=await x.h.person('測試買家甲');
  const p=await x.tx(q=>mapPersonPrincipal(q,a.id));
  await x.h.pool.query("UPDATE principals SET status='disabled' WHERE principal_id=$1",[p.principal_id]);
  await x.h.pool.query('UPDATE users SET email_verified_at=clock_timestamp() WHERE user_id=$1',[a.id]);
  const f=await checkout(s,{contact:{name:'測試買家甲',email:a.email,phone:'0900000000'}},a.session.cookie);
  const r=await http('POST',root(s)+`/checkouts/${f.c.checkout_ref}/orders`,{terms_sha256:f.c.terms_sha256,client_order_id:randomUUID()},f.browser+'; '+a.session.cookie);expect(r,201);
  assert.deepEqual((await x.h.pool.query('SELECT member_principal_id FROM commerce_customers')).rows,[{member_principal_id:null}]);
  assert.deepEqual((await x.h.pool.query('SELECT buyer_principal_id FROM commerce_orders')).rows,[{buyer_principal_id:null}]);
});
test('member order read holds no session row lock while its transaction is paused',async()=>{
  const s=await x.store(),a=await x.h.person('測試買家甲'),f=await checkout(s,{},a.session.cookie);
  const r=await http('POST',root(s)+`/checkouts/${f.c.checkout_ref}/orders`,{terms_sha256:f.c.terms_sha256,client_order_id:randomUUID()},f.browser+'; '+a.session.cookie);expect(r,201);
  const barrier=await queryBarrier(/SELECT co.checkout_id,o.buyer_principal_id/);let pending:ReturnType<typeof http>|undefined;
  try {
    pending=http('GET',root(s)+'/orders/'+r.data.order.order_ref,undefined,a.session.cookie);await barrier.ready;
    const q=await x.h.pool.connect();try {
      await q.query('BEGIN');await q.query("SET LOCAL lock_timeout='250ms'");
      assert.equal((await q.query('UPDATE sessions SET last_seen_at=clock_timestamp() WHERE token_hash=$1',[hashKey(a.session.cookie.split('=')[1])])).rowCount,1);
      await q.query('COMMIT');
    } finally {await q.query('ROLLBACK');q.release();}
    barrier.release();expect(await pending);
  } finally {barrier.restore();await pending;}
});
test('paid cancellation through core commands reads the public paid_cancelled reason',async()=>{
  const f=await placed(),{applyConfirmedPayment,cancelPaidOrder}=await import('../../modules/agent-commerce/checkout/index.js');
  await x.tx(q=>applyConfirmedPayment(q,{orderId:f.order.order_ref,paymentRef:randomUUID(),amountMinor:100,currency:'TWD',simulated:false}));
  await x.tx(q=>cancelPaidOrder(q,f.s,{orderId:f.order.order_ref,commandRef:randomUUID()}));
  const r=await http('GET',root(f.s)+'/orders/'+f.order.order_ref,undefined,f.browser);expect(r);assert.equal(r.data.cancel_reason,'paid_cancelled');assert.equal(r.data.lifecycle_state,'cancelled');
});
test('quarantine rejects redemption and B10 before database access but forget still clears its cookie',async()=>{
  const f=await placed();install({checkoutEnabled:true,consoleEnabled:true,quarantine:true,providerProfiles:[]});
  const before=(await x.h.pool.query('SELECT bucket,attempts FROM auth_rate_limits ORDER BY bucket')).rows;
  for(const [path,body] of [[root(f.s)+`/orders/${f.order.order_ref}/access`,{token:'wrong'}],[root(f.s)+'/order-access-requests',{email:'buyer@example.test',display_number:f.order.display_number}]] as const)expect(await http('POST',path,body),503,'commerce_quarantined');
  assert.deepEqual((await x.h.pool.query('SELECT bucket,attempts FROM auth_rate_limits ORDER BY bucket')).rows,before);
  const r=await http('POST','/public/order-access/forget',{},f.browser);expect(r,503,'commerce_quarantined');assert(r.response.headers.get('Set-Cookie')!.includes('Max-Age=0'));
});
test('request gate rejects absent/foreign Origin for every new POST without writes',async()=>{
  const f=await placed(),before=(await x.h.pool.query('SELECT (SELECT count(*) FROM commerce_checkouts)::int checkouts,(SELECT count(*) FROM commerce_orders)::int orders,(SELECT count(*) FROM commerce_order_access_grants)::int grants')).rows;
  const buckets=(await x.h.pool.query('SELECT * FROM auth_rate_limits ORDER BY bucket')).rows;
  for(const path of [root(f.s)+'/cart-quotes',root(f.s)+'/checkouts',root(f.s)+`/checkouts/${f.c.checkout_ref}/orders`,root(f.s)+`/orders/${f.order.order_ref}/access`,root(f.s)+'/order-access-requests','/public/order-access/forget'])for(const requestOrigin of [undefined,'https://foreign.example.test']) {
    const response=await app.fetch(new Request(origin+'/api/v1'+path,{method:'POST',headers:{'Content-Type':'application/json',Cookie:f.browser,...(requestOrigin?{Origin:requestOrigin}:{})},body:'{}'}));
    assert.equal(response.status,403);assert.equal((await response.json()).code,'origin_rejected');assert.equal(response.headers.get('Set-Cookie'),null);
  }
  assert.deepEqual((await x.h.pool.query('SELECT (SELECT count(*) FROM commerce_checkouts)::int checkouts,(SELECT count(*) FROM commerce_orders)::int orders,(SELECT count(*) FROM commerce_order_access_grants)::int grants')).rows,before);
  assert.deepEqual((await x.h.pool.query('SELECT * FROM auth_rate_limits ORDER BY bucket')).rows,buckets);assert.deepEqual(email.messages,[]);
});
test('checkout header middleware does not affect unrelated later platform routes',async()=>{
  const routes=createHostedCheckoutRoutes(x.runtime,origin,nodeRuntime('local',origin), 'local');
  routes.get('/later-test',c=>c.json({ok:true}));
  const r=await routes.fetch(new Request(origin+'/later-test'));assert.equal(r.status,200);
  assert.equal(r.headers.get('Referrer-Policy'),null);assert.equal(r.headers.get('Cache-Control'),null);
});

for(const suspended of ['tenant','deployment'] as const)test(`quote isolates a ${suspended}-suspended supplier but checkout keeps its strict lock path`,async()=>{
  const a=await x.store(),b=await x.store(),seller=await x.store(50,false);
  for(const supplier of [a,b]) {
    const offer=ok(await x.send(supplier,`/products/${supplier.product.product_id}/supply-offer`,{},supplier.product.version));
    const selection=ok(await x.send(seller,'/distribution-selections',{offer_id:offer.offer_id,terms_sha256:offer.terms_sha256,retail_price_minor:100}),201);
    ok(await x.send(supplier,`/supply-requests/${selection.selection_id}/decision`,{decision:'accepted',listing_sha256:selection.listing_sha256},selection.version));
  }
  await x.publish(seller);
  const projection=(await x.h.pool.query('SELECT pub.projection FROM commerce_storefront_profiles p JOIN commerce_storefront_publications pub ON pub.publication_id=p.current_publication_id WHERE p.instance_id=$1',[seller.instanceId])).rows[0].projection;
  const lines=projection.products.map((p:{sku:string})=>({sku:p.sku,quantity:1}));assert.equal(lines.length,2);
  const suspend=async(s:typeof a)=>suspended==='tenant'?x.h.pool.query("UPDATE tenants SET status='suspended' WHERE tenant_id=$1",[s.tenantId]):x.h.pool.query("UPDATE deployment_bindings SET state='suspended' WHERE tenant_id=$1 AND instance_id=$2",[s.tenantId,s.instanceId]);
  await suspend(b);
  const r=await http('POST',root(seller)+'/cart-quotes',{publication_revision:projection.revision,lines,delivery:{method:'synthetic'}});expect(r);
  assert.deepEqual(r.data.lines.map((l:{state:string})=>l.state).sort(),['ok','unavailable']);assert.equal(r.data.merchandise_total_minor,100);assert.equal(r.data.total_minor,null);
  expect(await http('POST',root(seller)+'/checkouts',{...x.input(lines[0].sku,1),publication_revision:projection.revision,lines},undefined,{'Idempotency-Key':randomUUID()}),409,'storefront_unavailable');
  await suspend(seller);expect(await http('POST',root(seller)+'/cart-quotes',{publication_revision:projection.revision,lines}),404,'checkout_store_not_found');
});
