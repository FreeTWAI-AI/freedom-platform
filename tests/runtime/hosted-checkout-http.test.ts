import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {before,beforeEach,after,test} from 'node:test';
import {createPlatformApp} from '../../apps/platform-api/src/platform-app.js';
import {nodeRuntime} from '../../apps/platform-api/src/app.js';
import {cloudflareRateLimitNetwork} from '../../apps/platform-api/src/worker.js';
import {FixtureEmailSender} from '../../modules/agent-commerce/operations/notifications/email-port.js';
import {hashKey} from '../../modules/agent-commerce/checkout/terms.js';
import {shopCookieName} from '../../modules/agent-commerce/checkout/access.js';
import {checkoutHarness,ports,type CheckoutHarness} from './hosted-checkout-harness.js';
import type {CommerceSettings} from '../../modules/agent-commerce/operations/runtime-settings.js';
import type {CheckoutPorts} from '../../modules/agent-commerce/checkout/terms.js';
let x:CheckoutHarness,app:ReturnType<typeof createPlatformApp>,email:FixtureEmailSender,origin:string,policies:{policy_kind:string;policy_version_id:string}[];
function install(settings:CommerceSettings={checkoutEnabled:true,quarantine:false},extra:CheckoutPorts & {email?:FixtureEmailSender}={}) {
  const mode=origin.startsWith('https:')?'public':'local';
  const runtime=nodeRuntime(mode,origin,{guildLaunchpadEnabled:true,commerceSettings:settings,commercePorts:{...ports,policies:{required:async()=>policies},email,...extra}});
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
async function checkout(s:Awaited<ReturnType<CheckoutHarness['store']>>,extra:Record<string,unknown>={},browser?:string,key=randomUUID()) {
  const r=await http('POST',root(s)+'/checkouts',{...x.input(s.product.sku,1),contact:{name:'測試買家甲',email:'buyer@example.test',phone:'0900000000'},...extra},browser,{'Idempotency-Key':key});expect(r,201);return {r,c:r.data,browser:cookie(r),key};
}
async function placed(extra:Record<string,unknown>={},browser?:string) {
  const s=await x.store(50),f=await checkout(s,extra,browser),intent={terms_sha256:f.c.terms_sha256,client_order_id:randomUUID()};
  const r=await http('POST',root(s)+`/checkouts/${f.c.checkout_ref}/orders`,intent,f.browser);expect(r,201);return {s,...f,intent,order:r.data.order};
}
async function requestLink(f:Awaited<ReturnType<typeof placed>>,address='buyer@example.test') {
  const r=await http('POST',root(f.s)+'/order-access-requests',{email:address,display_number:f.order.display_number});expect(r,202);assert.equal(r.data,null);return new URL(email.messages.at(-1)!.accessUrl).hash.slice('#access='.length);
}
before(async()=>{x=await checkoutHarness('fc_http',{publicSchema:true});origin=x.h.origin;});
beforeEach(async()=>{await x.reset();origin=x.h.origin;email=new FixtureEmailSender();policies=[];install();});
after(async()=>{await x?.stop();});

test('cart quotes use current publication prices, classify every line and never settle or hold',async()=>{
  const s=await x.store(2),path=root(s)+'/cart-quotes';
  const input={publication_revision:'1',lines:[{sku:s.product.sku,quantity:1,unit_price_minor:1,line_total_minor:1}]};
  let r=await http('POST',path,input);expect(r);assert.equal(r.data.lines[0].unit_price_minor,100);assert.equal(r.data.shipping.state,'needs_delivery_data');assert.equal(r.data.total_minor,null);
  r=await http('POST',path,{...input,publication_revision:'2',delivery:{method:'synthetic'}});expect(r);assert.equal(r.data.lines[0].state,'revision_changed');assert.equal(r.data.total_minor,100);
  r=await http('POST',path,{...input,lines:[{sku:s.product.sku,quantity:3},{sku:'P9999',quantity:1}]});expect(r);assert.equal(r.data.lines[0].state,'insufficient');assert.equal(r.data.lines[0].available,2);assert.equal(r.data.lines[1].state,'unavailable');
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
  assert(!JSON.stringify((await x.h.pool.query('SELECT * FROM commerce_access_devices')).rows).includes(f.browser.split('=')[1]));
});
test('HTTPS cookies use the Host prefix and Secure, preserve absolute device expiry and reject duplicate cookies',async()=>{
  const s=await x.store();origin='https://checkout.example.test';install();const first=await checkout(s),value=first.r.response.headers.get('Set-Cookie')!;
  assert(value.startsWith('__Host-freedom_shop='));assert(value.includes('; Secure'));assert(!value.includes('Domain='));
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
  for(const ref of [f.order.order_ref,f.order.display_number,randomUUID()])expect(await http('GET',root(f.s)+'/orders/'+ref),404,'checkout_order_not_found');
  const other=await x.store();expect(await http('GET',root(other)+'/orders/'+f.order.order_ref,undefined,f.browser),404,'checkout_order_not_found');
  const browser=(await checkout(other)).browser;expect(await http('GET',path,undefined,browser),404,'checkout_order_not_found');
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
  const results=await Promise.all([http('POST',path+'/access',{token}),http('POST',path+'/access',{token})]);assert.deepEqual(results.map(r=>r.status).sort(),[200,404]);
  const winner=results.find(r=>r.status===200)!;expect(await http('GET',path,undefined,cookie(winner)));
  expect(await http('POST',path+'/access',{token}),404,'checkout_order_not_found');
  expect(await http('POST',root(f.s)+`/checkouts/${f.c.checkout_ref}/orders`,f.intent,cookie(winner)),404,'checkout_order_not_found');
  expect(await http('POST',path+'/access',{token:'guessed'}),404,'checkout_order_not_found');
});
test('revoked and expired device credentials cannot read; forget clears and revokes the whole browser',async()=>{
  const f=await placed(),path=root(f.s)+'/orders/'+f.order.order_ref;
  const r=await http('POST','/public/order-access/forget',{},f.browser);expect(r,204);assert(r.response.headers.get('Set-Cookie')!.includes('Max-Age=0'));
  expect(await http('GET',path,undefined,f.browser),404,'checkout_order_not_found');
  const token=randomBytes(32).toString('base64url'),id=randomUUID();
  await x.h.pool.query(`INSERT INTO commerce_access_devices(device_id,token_sha256,created_at,expires_at) SELECT $1,$2,t,t+interval '180 days' FROM (SELECT clock_timestamp()-interval '181 days' t)n`,[id,hashKey(token)]);
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
  install(undefined,{email:undefined});const original=x.runtime.connect;x.runtime.connect=(()=>{throw Error('B10 must not access SQL without an email port');}) as typeof x.runtime.connect;
  try{expect(await http('POST',root(f.s)+'/order-access-requests',{email:'buyer@example.test',display_number:f.order.display_number}),409,'order_access_email_unavailable');}finally{x.runtime.connect=original;}
});
test('host gates keep order recovery readable and forget clears its cookie in quarantine',async()=>{
  const f=await placed(),body=x.input(f.s.product.sku,1);
  for(const [settings,extra,status,code] of [
    [{checkoutEnabled:true,quarantine:true},{},503,'commerce_quarantined'],[{checkoutEnabled:false,quarantine:false},{},409,'checkout_not_enabled'],
    [{checkoutEnabled:true,quarantine:false},{admission:{allowed:()=>false}},409,'checkout_not_enabled'],
  ] as const) {
    install(settings,extra);for(const [path,input] of [[root(f.s)+'/cart-quotes',{publication_revision:'1',lines:body.lines}],[root(f.s)+'/checkouts',body],[root(f.s)+`/checkouts/${f.c.checkout_ref}/orders`,f.intent]] as const)expect(await http('POST',path,input,f.browser,{'Idempotency-Key':randomUUID()}),status,code);
    expect(await http('GET',root(f.s)+'/orders/'+f.order.order_ref,undefined,f.browser));
  }
  install({checkoutEnabled:false,quarantine:true});const r=await http('POST','/public/order-access/forget',{},f.browser);expect(r,503,'commerce_quarantined');assert(r.response.headers.get('Set-Cookie')!.includes('Max-Age=0'));
});

test('expired, revoked and wrong-store links all return the same 404 without a device or redemption effect',async()=>{
  const f=await placed(),token=await requestLink(f),other=await x.store(),path=root(f.s)+'/orders/'+f.order.order_ref;
  expect(await http('POST',root(other)+'/orders/'+f.order.order_ref+'/access',{token}),404,'checkout_order_not_found');
  const expired=randomBytes(32).toString('base64url');
  await x.h.pool.query(`INSERT INTO commerce_order_access_grants(tenant_id,instance_id,checkout_id,order_id,kind,link_token_sha256,created_at,expires_at)
    SELECT tenant_id,instance_id,checkout_id,order_id,'link',$1,t,t+interval '7 days' FROM commerce_order_access_grants CROSS JOIN (SELECT clock_timestamp()-interval '8 days' t)n WHERE link_token_sha256=$2`,[hashKey(expired),hashKey(token)]);
  expect(await http('POST',path+'/access',{token:expired}),404,'checkout_order_not_found');
  await x.h.pool.query('UPDATE commerce_order_access_grants SET revoked_at=clock_timestamp() WHERE link_token_sha256=$1',[hashKey(token)]);
  expect(await http('POST',path+'/access',{token}),404,'checkout_order_not_found');assert.equal((await x.h.pool.query('SELECT count(*)::int n FROM commerce_order_access_grants WHERE redeemed_at IS NOT NULL')).rows[0].n,0);
});
test('an expired checkout rejects placement and leaves no order or hold',async()=>{
  const s=await x.store(),f=await checkout(s),id=randomUUID(),contactId=randomUUID();
  await x.tx(async q=>{
    const {lockStore}=await import('../../modules/agent-commerce/checkout/authority.js');await lockStore(q,s);
    await q.query(`INSERT INTO commerce_checkout_contacts(contact_id,checkout_id,tenant_id,instance_id,contact_name,contact_email,contact_phone,delivery,invoice,contact_sha256,contact_salt)
      SELECT $2,$3,tenant_id,instance_id,contact_name,contact_email,contact_phone,delivery,invoice,contact_sha256,contact_salt FROM commerce_checkout_contacts WHERE checkout_id=$1`,[f.c.checkout_ref,contactId,id]);
    await q.query(`INSERT INTO commerce_checkouts(checkout_id,tenant_id,instance_id,customer_id,publication_revision,currency,terms,terms_sha256,current_contact_id,idempotency_key_sha256,request_sha256,created_at,expires_at)
      SELECT $2,tenant_id,instance_id,customer_id,publication_revision,currency,terms,terms_sha256,$3,$4,request_sha256,t,t+interval '24 hours'
      FROM commerce_checkouts CROSS JOIN (SELECT date_trunc('milliseconds',clock_timestamp())-interval '25 hours' t)n WHERE checkout_id=$1`,[f.c.checkout_ref,id,contactId,hashKey(randomUUID())]);
    const device=(await q.query('SELECT device_id FROM commerce_access_devices WHERE token_sha256=$1',[hashKey(f.browser.split('=')[1])])).rows[0];
    await q.query(`INSERT INTO commerce_order_access_grants(tenant_id,instance_id,checkout_id,kind,device_id) VALUES($1,$2,$3,'device',$4)`,[s.tenantId,s.instanceId,id,device.device_id]);
  });
  expect(await http('POST',root(s)+`/checkouts/${id}/orders`,{terms_sha256:f.c.terms_sha256,client_order_id:randomUUID()},f.browser),409,'checkout_expired');
  assert.equal((await x.h.pool.query('SELECT count(*)::int n FROM commerce_orders')).rows[0].n,0);
});
test('confirmed payment outcomes and reservation expiry are projected without enabling a payment attempt',async()=>{
  const f=await placed();const {applyConfirmedPayment}=await import('../../modules/agent-commerce/checkout/index.js');
  await x.tx(q=>applyConfirmedPayment(q,{orderId:f.order.order_ref,paymentRef:randomUUID(),amountMinor:100,currency:'TWD',simulated:false}));
  const r=await http('GET',root(f.s)+'/orders/'+f.order.order_ref,undefined,f.browser);expect(r);assert.equal(r.data.payment_state,'confirmed');assert.equal(r.data.reservation_expired,false);
});

test('concurrent checkout and placement retries create one effect and one new response',async()=>{
  const s=await x.store(50),key=randomUUID(),body=x.input(s.product.sku,1);
  const created=await Promise.all([http('POST',root(s)+'/checkouts',body,undefined,{'Idempotency-Key':key}),http('POST',root(s)+'/checkouts',body,undefined,{'Idempotency-Key':key})]);
  assert.deepEqual(created.map(r=>r.status).sort(),[200,201]);assert.deepEqual(created[0].data,created[1].data);
  const input={terms_sha256:created[0].data.terms_sha256,client_order_id:randomUUID()},path=root(s)+`/checkouts/${created[0].data.checkout_ref}/orders`;
  const placed=await Promise.all([http('POST',path,input,cookie(created[0])),http('POST',path,input,cookie(created[1]))]);
  assert.deepEqual(placed.map(r=>r.status).sort(),[200,201]);assert.deepEqual(placed[0].data,placed[1].data);
  assert.equal((await x.h.pool.query('SELECT count(*)::int n FROM commerce_inventory_reservations')).rows[0].n,1);
});
test('checkout replay bypasses exhausted creation budgets and failed creation leaves no rows or credential',async()=>{
  const s=await x.store(),f=await checkout(s),before=(await x.h.pool.query('SELECT count(*)::int n FROM commerce_access_devices')).rows[0].n;
  await x.h.pool.query("UPDATE auth_rate_limits SET attempts=10000 WHERE bucket LIKE 'commerce:checkout%'");
  const body={...x.input(s.product.sku,1),contact:{name:'測試買家甲',email:'buyer@example.test',phone:'0900000000'}};
  expect(await http('POST',root(s)+'/checkouts',body,f.browser,{'Idempotency-Key':f.key}),200);
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
});
test('email failure happens after commit, returns 202 and logs only a fixed marker and error name',async()=>{
  const f=await placed(),logs:string[]=[],previous=console.error;
  const failing=new FixtureEmailSender();failing.sendOrderAccess=async()=>{assert.equal((await x.h.pool.query("SELECT count(*)::int n FROM commerce_order_access_grants WHERE kind='link'")).rows[0].n,1);throw new TypeError('buyer@example.test synthetic-secret');};install(undefined,{email:failing});
  console.error=(...args)=>logs.push(args.join(' '));
  try{expect(await http('POST',root(f.s)+'/order-access-requests',{email:'buyer@example.test',display_number:f.order.display_number}),202);}finally{console.error=previous;}
  assert.deepEqual(logs,['commerce_email_failed TypeError']);
});
