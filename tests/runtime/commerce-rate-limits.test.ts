import {test,before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {COMMERCE_LIMITS,commerceRateLimitInTransaction,tryChargeCommerceBudget,chargeCommerceBudgets,chargePaymentQueryOrderBudgets,type CommerceBucket} from '../../modules/agent-commerce/checkout/limits.js';
import {createPublicCheckout,placePublicOrder,type HostedCheckoutOptions} from '../../modules/agent-commerce/checkout/public-commands.js';
import {hashKey} from '../../modules/agent-commerce/checkout/terms.js';
import {checkoutHarness,ports,code,type CheckoutHarness} from './hosted-checkout-harness.js';
import {createPlatformApp} from '../../apps/platform-api/src/platform-app.js';
import {nodeRuntime} from '../../apps/platform-api/src/app.js';
import {cloudflareRateLimitNetwork} from '../../apps/platform-api/src/worker.js';
let x:CheckoutHarness;
before(async()=>{x=await checkoutHarness('fc_limits');});beforeEach(async()=>{await x.reset();});after(async()=>{await x?.stop();});
for(const [name,rule] of Object.entries(COMMERCE_LIMITS)) {
  if(typeof rule==='number')continue;
  test(`${name}: within, exact limit, limit+1, and DB-clock window reset`,async()=>{
    const key=name==='accessRequestEmail'?'buyer@example.test':'synthetic-budget',bucket=`commerce:${name}:${hashKey(key)}`;
    await x.tx(async q=>{
      const remaining=await commerceRateLimitInTransaction(q,name as CommerceBucket,key);
      assert(remaining>0&&remaining<=rule.seconds);
      await q.query('UPDATE auth_rate_limits SET attempts=$2 WHERE bucket=$1',[bucket,rule.limit-1]);
      assert((await commerceRateLimitInTransaction(q,name as CommerceBucket,key))>0);
      await assert.rejects(commerceRateLimitInTransaction(q,name as CommerceBucket,key),(e:unknown)=>code('commerce_rate_limited')(e)&&(e as {retryAfterSeconds:number}).retryAfterSeconds>0);
      assert.equal((await q.query('SELECT attempts FROM auth_rate_limits WHERE bucket=$1',[bucket])).rows[0].attempts,rule.limit);
      await q.query('UPDATE auth_rate_limits SET window_start=clock_timestamp()-make_interval(secs=>$2) WHERE bucket=$1',[bucket,rule.seconds+1]);
      assert.equal(await commerceRateLimitInTransaction(q,name as CommerceBucket,key),rule.seconds);
      assert.equal((await q.query('SELECT attempts FROM auth_rate_limits WHERE bucket=$1',[bucket])).rows[0].attempts,1);
    });
  });
}
test('a failed command rolls every bucket back',async()=>{
  await assert.rejects(x.tx(async q=>{await commerceRateLimitInTransaction(q,'checkoutNetwork','rollback');await commerceRateLimitInTransaction(q,'checkoutStore','rollback');throw Error('rollback');}));
  assert.equal((await x.h.pool.query('SELECT count(*)::int n FROM auth_rate_limits')).rows[0].n,0);
});
for(const budget of ['device','email','network'] as const)test(`fourth open/new order per ${budget} leaves no order or hold; replay counts only attempt budgets`,async()=>{
  const s=await x.store(50),options:HostedCheckoutOptions={origin:x.h.origin,settings:{checkoutEnabled:true,consoleEnabled:true,quarantine:false,providerProfiles:[]},...ports};let browser:string|undefined;
  let first:{checkout:string;input:{terms_sha256:string;client_order_id:string};access:{deviceToken?:string;network:string};order:string}|undefined;
  for(let i=0;i<4;i++) {
    const access={network:budget==='network'?'same-network':`network-${i}`,deviceToken:budget==='device'?browser:undefined};
    const f=await createPublicCheckout(x.runtime,s.slug,{...x.input(s.product.sku,1),contact:{name:'測試買家甲',email:budget==='email'?'same@example.test':`buyer${i}@example.test`,phone:'0900000000'}},randomUUID(),access,options);
    browser=f.cookie.split(';')[0].split('=')[1];access.deviceToken=browser;
    const input={terms_sha256:f.value.terms_sha256,client_order_id:randomUUID()};
    if(i<3){const placed=await placePublicOrder(x.runtime,s.slug,f.value.checkout_ref,input,access,options);assert(placed.created);first??={checkout:f.value.checkout_ref,input,access,order:placed.value.order.order_ref};}
    else {
      const before=(await x.h.pool.query("SELECT ceil(extract(epoch FROM min(o.expires_at)-clock_timestamp()))::int seconds FROM commerce_orders o WHERE o.order_profile='hosted_checkout'")).rows[0];
      await assert.rejects(placePublicOrder(x.runtime,s.slug,f.value.checkout_ref,input,access,options),(e:unknown)=>{
        assert(code(budget==='network'?'commerce_rate_limited':'too_many_open_orders')(e));
        const retry=(e as {retryAfterSeconds:number}).retryAfterSeconds;assert(Number.isInteger(retry)&&retry>=1);
        if(budget!=='network')assert(Math.abs(retry-before.seconds)<=2);return true;
      });
    }
  }
  assert.equal((await x.h.pool.query('SELECT count(*)::int n FROM commerce_checkout_orders')).rows[0].n,3);
  assert.equal((await x.h.pool.query('SELECT count(*)::int n FROM commerce_inventory_reservations')).rows[0].n,3);
  assert.equal((await x.h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1',[s.product.product_id])).rows[0].reserved,3);
  const before=(await x.h.pool.query("SELECT * FROM auth_rate_limits WHERE bucket LIKE 'commerce:%' ORDER BY bucket")).rows;
  const replay=await placePublicOrder(x.runtime,s.slug,first!.checkout,first!.input,first!.access,options);assert.equal(replay.created,false);assert.equal(replay.value.order.order_ref,first!.order);
  assert.deepEqual((await x.h.pool.query("SELECT * FROM auth_rate_limits WHERE bucket LIKE 'commerce:%' ORDER BY bucket")).rows,before.map(row=>({...row,attempts:row.attempts+(['placementNetwork','placementStore'].some(name=>row.bucket===`commerce:${name}:${hashKey(name==='placementNetwork'?first!.access.network:s.instanceId)}`)?1:0)})));
});
test('trusted-edge HTTP sets Retry-After on exhausted quote budgets; local and untrusted requests share a key',async()=>{
  const s=await x.store(),origin=x.h.origin;
  const runtime=nodeRuntime('local',origin,{commerceSettings:{checkoutEnabled:true,consoleEnabled:true,quarantine:false,providerProfiles:[]},commercePorts:ports});runtime.rateLimitNetwork=cloudflareRateLimitNetwork(true);
  const app=createPlatformApp(x.runtime,origin,'local',runtime),key='192.0.2.10';
  await x.h.pool.query('INSERT INTO auth_rate_limits(bucket,window_start,attempts) VALUES($1,clock_timestamp(),$2)',[`commerce:cartNetwork:${hashKey(key)}`,COMMERCE_LIMITS.cartNetwork.limit]);
  const call=async(trusted:boolean,address=key)=>{
    const request=new Request(origin+`/api/v1/public/stores/${s.slug}/cart-quotes`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','CF-Connecting-IP':address},body:JSON.stringify({publication_revision:'1',lines:[{sku:s.product.sku,quantity:1}]})});
    if(trusted)Object.defineProperty(request,'cf',{value:{colo:'TEST'}});return app.fetch(request);
  };
  const response=await call(true);assert.equal(response.status,429);assert(Number(response.headers.get('Retry-After'))>0);assert.equal((await response.json()).code,'commerce_rate_limited');
  assert.equal((await call(false)).status,200);assert.equal((await call(false,'192.0.2.20')).status,200);
  const shared=(await x.h.pool.query('SELECT attempts FROM auth_rate_limits WHERE bucket=$1',[`commerce:cartNetwork:${hashKey('shared-server')}`])).rows[0];assert.equal(shared.attempts,2);
});

for(const cap of ['email','device'] as const)test(`three open orders per ${cap} at store A do not consume store B slots`,async()=>{
  const a=await x.store(50),b=await x.store(50),options:HostedCheckoutOptions={origin:x.h.origin,settings:{checkoutEnabled:true,consoleEnabled:true,quarantine:false,providerProfiles:[]},...ports};let deviceToken:string|undefined;
  for(let i=0;i<4;i++) {
    const s=i<3?a:b,access={network:`network-${i}`,deviceToken:cap==='device'?deviceToken:undefined};
    const c=await createPublicCheckout(x.runtime,s.slug,{...x.input(s.product.sku,1),contact:{name:'測試買家甲',email:cap==='email'?'same@example.test':`buyer${i}@example.test`,phone:'0900000000'}},randomUUID(),access,options);
    deviceToken=c.cookie.split(';')[0].split('=')[1];access.deviceToken=deviceToken;
    const r=await placePublicOrder(x.runtime,s.slug,c.value.checkout_ref,{terms_sha256:c.value.terms_sha256,client_order_id:randomUUID()},access,options);assert.equal(r.created,true);
  }
  assert.deepEqual((await x.h.pool.query('SELECT instance_id,count(*)::int n FROM commerce_checkout_orders GROUP BY instance_id ORDER BY instance_id')).rows,[{instance_id:a.instanceId,n:3},{instance_id:b.instanceId,n:1}].sort((a,b)=>a.instance_id.localeCompare(b.instance_id)));
});

test('payment budget values are closed and match their transport rules',()=>{
  assert.deepEqual(Object.fromEntries(['providerAccount','providerUnknownNetwork','paymentReturnNetwork','paymentReturnQuery','handoffNetwork','handoffPageNetwork','paymentQueryNetwork','paymentQueryOrder','paymentQueryOrderHour','activationAccount'].map(name=>[name,COMMERCE_LIMITS[name as CommerceBucket]])),{
    providerAccount:{limit:600,seconds:60},providerUnknownNetwork:{limit:120,seconds:60},paymentReturnNetwork:{limit:60,seconds:60},paymentReturnQuery:{limit:1,seconds:60},handoffNetwork:{limit:30,seconds:600},handoffPageNetwork:{limit:60,seconds:600},
    paymentQueryNetwork:{limit:30,seconds:600},paymentQueryOrder:{limit:1,seconds:60},paymentQueryOrderHour:{limit:10,seconds:3600},activationAccount:{limit:10,seconds:3600},
  });
});
test('redirect budgets return false only for exhaustion and persist before a failed command',async()=>{
  const results=await Promise.all([1,2,3].map(()=>tryChargeCommerceBudget(x.runtime,'paymentReturnQuery','synthetic-attempt')));assert.deepEqual(results.sort(),[false,false,true]);
  assert.equal((await x.h.pool.query('SELECT attempts FROM auth_rate_limits WHERE bucket=$1',['commerce:paymentReturnQuery:'+hashKey('synthetic-attempt')])).rows[0].attempts,1);
  await chargeCommerceBudgets(x.runtime,'synthetic-account',{network:'providerAccount'});await assert.rejects(x.tx(async()=>{throw Error('synthetic_command_failure');}));
  assert.equal((await x.h.pool.query('SELECT attempts FROM auth_rate_limits WHERE bucket=$1',['commerce:providerAccount:'+hashKey('synthetic-account')])).rows[0].attempts,1);
  await assert.rejects(tryChargeCommerceBudget({connect:async()=>{throw Error('synthetic_database_failure');}} as never,'paymentReturnNetwork','synthetic-network'),{message:'synthetic_database_failure'});
});

test('order query budgets serialize buyers and re-pay, retain the hourly ceiling and commit before commands',async()=>{
  const order=randomUUID(),other=randomUUID(),minute='commerce:paymentQueryOrder:'+hashKey(order),hour='commerce:paymentQueryOrderHour:'+hashKey(order);
  const results=await Promise.allSettled([chargePaymentQueryOrderBudgets(x.runtime,order),chargePaymentQueryOrderBudgets(x.runtime,order)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const rejected=results.find(r=>r.status==='rejected') as PromiseRejectedResult;assert(code('commerce_rate_limited')(rejected.reason));assert(rejected.reason.retryAfterSeconds>0);
  await assert.rejects(x.tx(async()=>{throw Error('command_failed_after_budget');}));
  assert.deepEqual((await x.h.pool.query('SELECT attempts FROM auth_rate_limits WHERE bucket=ANY($1::text[]) ORDER BY bucket',[[minute,hour]])).rows,[{attempts:1},{attempts:1}]);
  await x.h.pool.query("UPDATE auth_rate_limits SET window_start=clock_timestamp()-interval '61 seconds' WHERE bucket=$1",[minute]);
  await x.h.pool.query('UPDATE auth_rate_limits SET attempts=9 WHERE bucket=$1',[hour]);
  await chargePaymentQueryOrderBudgets(x.runtime,order);
  assert.equal((await x.h.pool.query('SELECT attempts FROM auth_rate_limits WHERE bucket=$1',[hour])).rows[0].attempts,10);
  await x.h.pool.query("UPDATE auth_rate_limits SET window_start=clock_timestamp()-interval '61 seconds' WHERE bucket=$1",[minute]);
  const before=(await x.h.pool.query('SELECT * FROM auth_rate_limits WHERE bucket=ANY($1::text[]) ORDER BY bucket',[[minute,hour]])).rows;
  await assert.rejects(chargePaymentQueryOrderBudgets(x.runtime,order),(e:unknown)=>code('commerce_rate_limited')(e)&&(e as {retryAfterSeconds:number}).retryAfterSeconds>60);
  assert.deepEqual((await x.h.pool.query('SELECT * FROM auth_rate_limits WHERE bucket=ANY($1::text[]) ORDER BY bucket',[[minute,hour]])).rows,before,'an hourly refusal rolls back the minute reset');
  await chargePaymentQueryOrderBudgets(x.runtime,other);
  await x.h.pool.query("UPDATE auth_rate_limits SET window_start=clock_timestamp()-interval '3601 seconds' WHERE bucket=$1",[hour]);
  await chargePaymentQueryOrderBudgets(x.runtime,order);
  assert.equal((await x.h.pool.query('SELECT attempts FROM auth_rate_limits WHERE bucket=$1',[hour])).rows[0].attempts,1);
});
