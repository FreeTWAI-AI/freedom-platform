import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {before, after, beforeEach, test} from 'node:test';
import {Pool} from 'pg';
import {createApp} from '../../apps/platform-api/src/app.js';
import {TENANT_CURSOR_TEST_KEY} from './tenant-cursor-fixture.js';
import {DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {createRegistryHarness, type RegistryHarness, type Session, type Reply} from './module-registry-harness.js';

let h: RegistryHarness, runtime: Pool, app: ReturnType<typeof createApp>;
const role = `hs_runtime_${process.pid}_${Date.now()}`, guild = 'guild_commerce_sales';
type Store = {owner: Session; tenantId: string; instanceId: string; root: string};
const ok = (r: Reply, status=200) => {assert.equal(r.status,status,JSON.stringify(r.data)); return r.data;};
const get = (s: Store, path: string, session=s.owner) => h.call('GET',s.root+path,session,undefined,{},app);
const send = (s: Store,path: string,body: unknown={},version?: string,key=randomUUID(),method='POST',session=s.owner) =>
  h.call(method,s.root+path,session,body,{'Idempotency-Key':key,...(version?{'If-Match':`"${version}"`}:{})},app);
async function store(name: string): Promise<Store> {
  const owner = (await h.person(name)).session; await h.fullMember(owner.user.user_id,guild);
  const {tenantId,workspaceId} = await h.createTenant(owner,name);
  const plan = await h.plan(owner,tenantId,h.planBody(guild,workspaceId,'hosted-store','hosted-store@1.0.0')); ok(plan,201);
  assert.equal((await h.launch(owner,tenantId,plan)).data.state,'succeeded');
  const instanceId = (await h.pool.query("SELECT instance_id FROM module_instances WHERE tenant_id=$1 AND module_key='storefront'",[tenantId])).rows[0].instance_id;
  const s = {owner,tenantId,instanceId,root:`/tenants/${tenantId}/storefronts/${instanceId}`};
  ok(await send(s,'/setup',{name,slug:`s-${randomUUID().slice(0,12)}`,currency:'TWD'}),201); return s;
}
async function product(s: Store) {
  const item = ok(await send(s,'/products',{title:'供貨茶杯',description:'供貨方授權的介紹',price_minor:1000,stock:10}),201);
  const terms = ok(await send(s,`/products/${item.product_id}/supply-terms`,{cost_minor:400,shipping_minor:50,shipping_terms:'確認後三天出貨',return_terms:'瑕疵請聯絡供貨方'},item.version,randomUUID(),'PATCH'));
  return {...item,version:terms.version};
}
const offer = async (s: Store,p: any) => ok(await send(s,`/products/${p.product_id}/supply-offer`,{},p.version));
const propose = async (s: Store,o: any,price: number) => ok(await send(s,'/distribution-selections',{offer_id:o.offer_id,terms_sha256:o.terms_sha256,retail_price_minor:price}),201);
const decide = async (s: Store,l: any,decision='accepted') => ok(await send(s,`/supply-requests/${l.selection_id}/decision`,{decision,listing_sha256:l.listing_sha256},l.version));
const publish = async (s: Store) => ok(await send(s,'/publish',{},ok(await get(s,'')).version));
before(async () => {
  assert.match(process.env.TEST_DATABASE_URL??'', /\/fp_[a-z0-9_]+$/);
  h = await createRegistryHarness('fp_shared_orders');
  await h.admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    GRANT USAGE ON SCHEMA ${h.schema} TO ${role}; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${h.schema} TO ${role};
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${h.schema} TO ${role}; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${h.schema} TO ${role}`);
  const url = new URL(process.env.TEST_DATABASE_URL!); url.username=role; url.password='';
  runtime = new Pool({connectionString:url.toString(),options:`-c search_path=${h.schema} -c statement_timeout=15000`,max:6});
  app = createApp(runtime,h.origin,'local',{guildLaunchpadEnabled:true,hostedReservationsEnabled:true,tenantCursorSigningKey:TENANT_CURSOR_TEST_KEY});
});
after(async () => {
  await runtime?.end();
  if(h) {await h.stop(); const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL}); try{await admin.query(`DROP ROLE ${role}`);}finally{await admin.end();}}
});
beforeEach(async () => {
  await h.reset();
  await h.pool.query(`INSERT INTO guild_application_offerings(offering_id,community_id,guild_key,application_key,release_ref,status,display_order,launch_policy_ref,version)
    VALUES($1,$2,$3,'hosted-store','hosted-store@1.0.0','offered',10,'{"policy_key":"hosted-store.launch","version":"1"}',1)`,[randomUUID(),DEMO_COMMUNITY,guild]);
});


const command = (path:string,session:Session,body:unknown,key=randomUUID(),version?:string) => h.call('POST',path,session,body,
  {'Idempotency-Key':key,...(version?{'If-Match':`"${version}"`}:{})},app);
async function admit(s:Store, enabled=true) {
  const current=ok(await get(s,'/reservation-setting'));
  return ok(await send(s,'/reservation-setting',{reservation_enabled:enabled},current.version,randomUUID(),'PATCH'));
}
async function quote(s:Store,buyer:Session,quantity:number,sku='P0001') {
  const view=ok(await get(s,''));
  return ok(await command(`/hosted-stores/${view.store.slug}/reservation-quotes`,buyer,
    {publication_revision:view.publication.current_revision,items:[{sku,quantity}]}),201);
}
const intent = (q:any) => ({quote_id:q.quote_id,terms_sha256:q.terms_sha256,client_order_id:randomUUID()});
const submit = (q:any,buyer:Session,body=intent(q),key=randomUUID()) => command(`/hosted-stores/${q.store.slug}/reservation-orders`,buyer,body,key);
async function fixture() {
  const a=await store('供貨 A'),b=await store('店主 B'),c=await store('店主 C'),p=await product(a),o=await offer(a,p);
  const lb=await decide(a,await propose(b,o,1100)),lc=await decide(a,await propose(c,o,1300));
  await publish(b);await publish(c);for(const s of [a,b,c]) await admit(s);
  const buyerB=(await h.person('B 買家')).session,buyerC=(await h.person('C 買家')).session;
  const otherCommunity=randomUUID(); await h.pool.query("INSERT INTO communities(community_id,name) VALUES($1,'另一買家社群')",[otherCommunity]);
  await h.pool.query('UPDATE users SET community_id=$1 WHERE user_id=$2',[otherCommunity,buyerB.user.user_id]);
  return {a,b,c,p,o,lb,lc,buyerB,buyerC};
}
const balance = async (id:string) => (await h.pool.query('SELECT stock,reserved FROM commerce_items WHERE item_id=$1',[id])).rows[0];

test('two storefronts request 6 + 5 from one stock of 10; current buyer recovery and cancellation release only once',async () => {
  const s=await fixture(),qb=await quote(s.b,s.buyerB,6),qc=await quote(s.c,s.buyerC,5);
  assert.equal(qb.profile,'freedom.hosted-shared-order-reservation/v1');assert.equal(qb.items[0].unit_price_minor,1100);
  assert.equal(qc.items[0].unit_price_minor,1300);assert.deepEqual(await balance(s.p.product_id),{stock:10,reserved:0});
  const ib=intent(qb),ic=intent(qc),keyB=randomUUID(),keyC=randomUUID();
  const results=await Promise.all([submit(qb,s.buyerB,ib,keyB),submit(qc,s.buyerC,ic,keyC)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[201,409],JSON.stringify(results.map(r=>r.data)));
  const win=results.findIndex(r=>r.status===201),order=results[win].data,buyer=win===0?s.buyerB:s.buyerC,loser=win===0?s.buyerC:s.buyerB;
  assert.equal(results[1-win].data.code,'stock_unavailable');
  const q=win===0?qb:qc,body=win===0?ib:ic,key=win===0?keyB:keyC,shop=win===0?s.b:s.c;
  assert.deepEqual(await balance(s.p.product_id),{stock:10,reserved:win===0?6:5});
  assert.equal(ok(await submit(q,buyer,body,key)).order_id,order.order_id);
  assert.equal(ok(await submit(q,buyer,body)).order_id,order.order_id);
  assert.equal(ok(await h.call('GET',`/me/reservations/by-intent/${body.client_order_id}?store_slug=${q.store.slug}`,buyer,undefined,{},app)).order_id,order.order_id);
  ok(await h.call('GET',`/me/reservations/${order.order_id}`,loser,undefined,{},app),404);
  assert.equal(ok(await get(shop,'/reservations')).items.length,1);
  assert.equal(ok(await get(win===0?s.c:s.b,'/reservations')).items.length,0);
  ok(await get(s.a,`/reservations/${order.order_id}`),404);
  const cancelKey=randomUUID();const cancelled=ok(await command(`/me/reservations/${order.order_id}/cancel`,buyer,{},cancelKey,'1'));
  assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.version,'2');
  assert.deepEqual(ok(await command(`/me/reservations/${order.order_id}/cancel`,buyer,{},cancelKey,'1')),cancelled);
  assert.deepEqual(await balance(s.p.product_id),{stock:10,reserved:0});
  for(const table of ['commerce_transfers','commerce_payment_events','commerce_supplier_payables']) assert.equal(await h.count(table),0);
  assert.equal(await h.count('commerce_items'),1);
});

test('withdrawal rejects a previously quoted submission and new quotes; committed history and release survive withdrawal and admission OFF',async () => {
  const s=await fixture(),q=await quote(s.b,s.buyerB,4),pending=await quote(s.c,s.buyerC,3);
  const order=ok(await submit(q,s.buyerB),201);
  await send(s.a,`/supply-offers/${s.o.offer_id}/withdraw`,{},s.o.version).then(r=>ok(r));
  const refused=await submit(pending,s.buyerC);ok(refused,409);assert.equal(refused.data.code,'supply_unavailable');
  const view=ok(await get(s.c,''));const fresh=await command(`/hosted-stores/${view.store.slug}/reservation-quotes`,s.buyerC,{publication_revision:'1',items:[{sku:'P0001',quantity:1}]});
  ok(fresh,409);assert.equal(fresh.data.code,'supply_unavailable');
  await admit(s.a,false);await admit(s.b,false);
  const retained=ok(await h.call('GET',`/me/reservations/${order.order_id}`,s.buyerB,undefined,{},app));
  assert.deepEqual(retained.items,order.items);
  assert.equal(ok(await command(s.b.root+`/reservations/${order.order_id}/cancel`,s.b.owner,{},randomUUID(),'1')).state,'cancelled');
  assert.deepEqual(await balance(s.p.product_id),{stock:10,reserved:0});
  assert.equal(await h.count('commerce_orders'),1);
});

test('seller-local SKUs separate different suppliers with the same original SKU; all lines reserve atomically',async () => {
  const a=await store('A'),d=await store('D'),b=await store('B'),pa=await product(a),pd=await product(d);
  assert.equal(pa.sku,pd.sku);
  const oa=await offer(a,pa),od=await offer(d,pd);
  const la=await decide(a,await propose(b,oa,1100)),ld=await decide(d,await propose(b,od,1500));
  assert.notEqual(la.sku,ld.sku);await publish(b);for(const s of [a,d,b])await admit(s);
  const buyer=(await h.person('多來源買家')).session,view=ok(await get(b,''));
  const q=ok(await command(`/hosted-stores/${view.store.slug}/reservation-quotes`,buyer,{publication_revision:'1',items:[{sku:la.sku,quantity:3},{sku:ld.sku,quantity:4}]}),201);
  const order=ok(await submit(q,buyer),201);
  assert.deepEqual(order.items.map((i:any)=>[i.sku,i.quantity,i.unit_price_minor]),[[la.sku,3,1100],[ld.sku,4,1500]]);
  const supplierA=ok(await get(a,'/supply-reservations')),supplierD=ok(await get(d,'/supply-reservations'));
  assert.deepEqual(supplierA.items[0].items.map((line:any)=>line.product_id),[pa.product_id]);
  assert.deepEqual(supplierD.items[0].items.map((line:any)=>line.product_id),[pd.product_id]);
  assert.equal(supplierA.items[0].items[0].supply_total_minor,1200);
  for(const data of [supplierA,supplierD]) {
    assert.ok(!JSON.stringify(data).includes(buyer.user.user_id));
    for(const field of ['buyer_principal_id','client_order_id','terms_sha256','merchandise_total_minor','quote_id']) assert.ok(!JSON.stringify(data).includes(field));
  }
  assert.deepEqual(ok(await get(b,'/supply-reservations')).items,[]);
  ok(await get(a,'/supply-reservations',b.owner),404);
  assert.deepEqual(await balance(pa.product_id),{stock:10,reserved:3});assert.deepEqual(await balance(pd.product_id),{stock:10,reserved:4});
  await assert.rejects(h.pool.query(`INSERT INTO commerce_transfers(transfer_id,order_id,internal_shop_id,total_minor,delivery_ref) VALUES($1,$2,$3,1,'forbidden')`,
    [randomUUID(),order.order_id,(await h.pool.query('SELECT shop_id FROM commerce_items WHERE item_id=$1',[pa.product_id])).rows[0].shop_id]),/foreign key/);
  await assert.rejects(h.pool.query('UPDATE commerce_order_lines SET quantity=1 WHERE order_id=$1',[order.order_id]),(e:unknown)=>(e as {code?:string}).code==='23514');
  await command(`/me/reservations/${order.order_id}/cancel`,buyer,{},randomUUID(),'1').then(r=>ok(r));
  assert.deepEqual(await balance(pa.product_id),{stock:10,reserved:0});assert.deepEqual(await balance(pd.product_id),{stock:10,reserved:0});
});

async function expiredCopy(source:any) {
  // Synthetic historical fixture only: immutable production timestamps cannot
  // be edited. Create a past quote/order through the real database constraints.
  const quoteId=randomUUID(),orderId=randomUUID(),clientId=randomUUID();
  await h.pool.query(`INSERT INTO commerce_order_quotes(quote_id,tenant_id,instance_id,public_shop_id,buyer_principal_id,publication_id,
    terms,bindings,terms_sha256,quoted_at,expires_at,quote_profile)
    SELECT $2::uuid,tenant_id,instance_id,public_shop_id,buyer_principal_id,publication_id,
      terms||jsonb_build_object('quote_id',$2::text,'quoted_at',to_char(statement_timestamp()-interval '2 hours','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'expires_at',to_char(statement_timestamp()-interval '115 minutes','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      bindings,terms_sha256,date_trunc('milliseconds',statement_timestamp()-interval '2 hours'),
      date_trunc('milliseconds',statement_timestamp()-interval '115 minutes'),quote_profile
    FROM commerce_order_quotes WHERE quote_id=$1`,[source.quote_id,quoteId]);
  await h.pool.query(`INSERT INTO commerce_orders(order_id,public_shop_id,external_id,request_sha256,currency,total_minor,created_at,expires_at,
    order_profile,quote_id,buyer_principal_id,client_order_id,reservation_state,reservation_version)
    SELECT $2::uuid,o.public_shop_id,'historical-'||$2::text,o.request_sha256,o.currency,o.total_minor,quote.quoted_at+interval '1 minute',quote.quoted_at+interval '31 minutes',
      o.order_profile,$3::uuid,o.buyer_principal_id,$4::uuid,'reserved',1 FROM commerce_orders o JOIN commerce_order_quotes quote ON quote.quote_id=$3 WHERE o.order_id=$1`,
  [source.order_id,orderId,quoteId,clientId]);
  await h.pool.query(`INSERT INTO commerce_order_lines(order_id,selection_id,transfer_id,item_id,quantity,snapshot,acceptance_id,listing_sha256,order_profile,supplier_shop_id,hosted_offer_id)
    SELECT $2,selection_id,transfer_id,item_id,quantity,snapshot,acceptance_id,listing_sha256,order_profile,supplier_shop_id,hosted_offer_id
    FROM commerce_order_lines WHERE order_id=$1`,[source.order_id,orderId]);
  await h.pool.query(`UPDATE commerce_items i SET reserved=reserved+line.quantity FROM commerce_order_lines line WHERE line.order_id=$1 AND line.item_id=i.item_id`,[orderId]);
  return orderId;
}

test('C reclaims physically expired stock held by B; repeated buyer/supplier reads release once without access to the other order',async()=>{
  const s=await fixture(),q=await quote(s.b,s.buyerB,8),original=ok(await submit(q,s.buyerB),201);
  ok(await command(`/me/reservations/${original.order_id}/cancel`,s.buyerB,{},randomUUID(),'1'));
  const expired=await expiredCopy(original);assert.deepEqual(await balance(s.p.product_id),{stock:10,reserved:8});
  const qc=await quote(s.c,s.buyerC,5);assert.deepEqual(await balance(s.p.product_id),{stock:10,reserved:0});
  const order=ok(await submit(qc,s.buyerC),201);assert.deepEqual(await balance(s.p.product_id),{stock:10,reserved:5});
  ok(await h.call('GET',`/me/reservations/${expired}`,s.buyerC,undefined,{},app),404);
  for(let i=0;i<3;i++) {
    assert.equal(ok(await h.call('GET',`/me/reservations/${expired}`,s.buyerB,undefined,{},app)).state,'expired');
    assert.equal(ok(await get(s.a,'/supply-reservations')).items.find((o:any)=>o.order_id===expired).state,'expired');
  }
  assert.deepEqual(await balance(s.p.product_id),{stock:10,reserved:5});
  assert.equal((await h.pool.query('SELECT count(*)::int n FROM scoped_transition_journal WHERE aggregate_id=$1 AND aggregate_version=2',[expired])).rows[0].n,1);
  ok(await command(`/me/reservations/${order.order_id}/cancel`,s.buyerC,{},randomUUID(),'1'));
});

test('repricing and current supplier lifecycle invalidate an old quote without rewriting accepted order history',async()=>{
  const s=await fixture(),old=await quote(s.b,s.buyerB,2),retained=ok(await submit(old,s.buyerB),201),pending=await quote(s.b,s.buyerB,1);
  ok(await send(s.b,`/distribution-selections/${s.lb.selection_id}`,{offer_id:s.o.offer_id,terms_sha256:s.o.terms_sha256,retail_price_minor:1700},s.lb.version,randomUUID(),'PATCH'));
  ok(await submit(pending,s.buyerB),409);assert.deepEqual(await balance(s.p.product_id),{stock:10,reserved:2});
  const saved=ok(await h.call('GET',`/me/reservations/${retained.order_id}`,s.buyerB,undefined,{},app));assert.equal(saved.items[0].unit_price_minor,1100);
  const cQuote=await quote(s.c,s.buyerC,1);
  await h.pool.query("UPDATE module_instances SET status='suspended' WHERE instance_id=$1",[s.a.instanceId]);
  const unavailable=await submit(cQuote,s.buyerC);ok(unavailable,409);assert.equal(unavailable.data.code,'supply_unavailable');
  assert.equal(ok(await command(`/me/reservations/${retained.order_id}/cancel`,s.buyerB,{},randomUUID(),'1')).state,'cancelled');
  assert.deepEqual(await balance(s.p.product_id),{stock:10,reserved:0});
});

test('owner admission uses host gate and versioned receipts; admin cannot configure or read supplier orders and revoked owner cannot replay',async()=>{
  const a=await store('有界設定'),before=ok(await get(a,'/reservation-setting'));assert.equal(before.reservation_enabled,false);
  const key=randomUUID();const enabled=ok(await send(a,'/reservation-setting',{reservation_enabled:true},before.version,key,'PATCH'));
  assert.equal(enabled.reservation_enabled,true);assert.equal(enabled.version,String(BigInt(before.version)+1n));
  assert.deepEqual(ok(await send(a,'/reservation-setting',{reservation_enabled:true},before.version,key,'PATCH')),enabled);
  ok(await send(a,'/reservation-setting',{reservation_enabled:false},before.version,randomUUID(),'PATCH'),412);
  const off=createApp(runtime,h.origin,'local',{guildLaunchpadEnabled:false,tenantCursorSigningKey:TENANT_CURSOR_TEST_KEY});
  const rejected=await h.call('PATCH',a.root+'/reservation-setting',a.owner,{reservation_enabled:true},{'Idempotency-Key':randomUUID(),'If-Match':`"${enabled.version}"`},off);
  ok(rejected,409);assert.equal(rejected.data.code,'reservation_not_enabled');
  const stopped=ok(await h.call('PATCH',a.root+'/reservation-setting',a.owner,{reservation_enabled:false},{'Idempotency-Key':randomUUID(),'If-Match':`"${enabled.version}"`},off));assert.equal(stopped.admission_enabled,false);
  const admin=(await h.person('管理員不是擁有者')).session,principal=await h.candidate(a.owner,admin.user.user_id);
  const invitation=await h.invite(a.owner,a.tenantId,principal,'admin');ok(invitation,201);await h.accept(admin,a.tenantId,invitation);
  ok(await get(a,'/reservation-setting',admin),403);ok(await get(a,'/supply-reservations',admin),403);
  ok(await send(a,'/reservation-setting',{reservation_enabled:true},stopped.version,randomUUID(),'PATCH',admin),403);
  // Synthetic authoritative ownership transition, not a claim of exercising
  // the separate ownership transfer UI. The current-owner replay fence is real.
  const q=await h.pool.connect();try{await q.query('BEGIN');
    await q.query("UPDATE tenant_memberships SET role='admin',version=version+1 WHERE tenant_id=$1 AND role='owner'",[a.tenantId]);
    await q.query("UPDATE tenant_memberships SET role='owner',version=version+1 WHERE tenant_id=$1 AND principal_id=$2",[a.tenantId,principal]);
    await q.query('COMMIT');}catch(error){await q.query('ROLLBACK');throw error;}finally{q.release();}
  ok(await send(a,'/reservation-setting',{reservation_enabled:true},before.version,key,'PATCH'),403);
});

test('original direct endpoints reject shared quotes; HTTP bodies and supplier cursors do not grant another party access',async()=>{
  const s=await fixture(),q=await quote(s.b,s.buyerB,1),body=intent(q);
  const wrong=await command(`/hosted-stores/${q.store.slug}/orders`,s.buyerB,body);ok(wrong,409);assert.equal(wrong.data.code,'quote_profile_changed');
  ok(await command(`/hosted-stores/${q.store.slug}/reservation-orders`,s.buyerB,{...body,tenant_id:s.a.tenantId}),422);
  ok(await submit(q,s.buyerB,body),201);
  ok(await submit(await quote(s.c,s.buyerC,1),s.buyerC),201);
  const first=ok(await get(s.a,'/supply-reservations?limit=1'));assert.ok(first.next_cursor);
  const next=ok(await get(s.a,'/supply-reservations?limit=1&cursor='+encodeURIComponent(first.next_cursor)));assert.equal(next.items.length,1);
  assert.notEqual(first.items[0].order_id,next.items[0].order_id);
  ok(await get(s.b,'/supply-reservations?cursor='+encodeURIComponent(first.next_cursor)),422);
  assert.equal(ok(await get(s.a,'/supply-reservations?limit=1')).next_cursor,first.next_cursor);
  assert.equal((await runtime.query('SELECT count(*)::int n FROM commerce_hosted_supply_offers')).rows[0].n,0,'pooled transaction must not retain a supplier binding');
});

test('session expiry at shared-order receipt storage rolls back all inventory, order lines and facts',async()=>{
  const s=await fixture(),q=await quote(s.b,s.buyerB,3),key=randomUUID();
  await h.pool.query(`CREATE FUNCTION hs_expire_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.operation='storefront.order.submit' THEN UPDATE sessions SET expires_at=clock_timestamp()-interval '1 millisecond'
      WHERE user_id=(SELECT user_ref FROM principals WHERE principal_id=NEW.principal_id); END IF; RETURN NEW; END $$;
    CREATE TRIGGER hs_expire_session BEFORE INSERT ON scoped_command_receipts FOR EACH ROW EXECUTE FUNCTION hs_expire_session()`);
  try {
    const refused=await submit(q,s.buyerB,intent(q),key);ok(refused,401);assert.equal(refused.data.code,'session_expired');
    assert.equal(await h.count('commerce_orders'),0);assert.equal(await h.count('commerce_order_lines'),0);
    assert.deepEqual(await balance(s.p.product_id),{stock:10,reserved:0});
    assert.equal((await h.pool.query('SELECT 1 FROM scoped_command_receipts WHERE idempotency_key=$1',[key])).rowCount,0);
  }finally{await h.pool.query('DROP TRIGGER hs_expire_session ON scoped_command_receipts; DROP FUNCTION hs_expire_session()');}
});

test('supplier mapping, installed capability and admission remain current for quotes and replays',async()=>{
  const s=await fixture(),q=await quote(s.b,s.buyerB,2),body=intent(q),key=randomUUID();
  await h.pool.query("UPDATE commerce_resource_tenants SET mapping_state='ambiguous' WHERE tenant_id=$1",[s.a.tenantId]);
  ok(await submit(q,s.buyerB,body,key),409);
  assert.deepEqual(await balance(s.p.product_id),{stock:10,reserved:0});
  await h.pool.query("UPDATE commerce_resource_tenants SET mapping_state='confirmed' WHERE tenant_id=$1",[s.a.tenantId]);
  await admit(s.a,false);ok(await submit(q,s.buyerB,body,key),409);await admit(s.a);
  // Registry releases are immutable: removing the installed capability cannot
  // be disguised as an in-place edit while an existing quote is held.
  await assert.rejects(h.pool.query("UPDATE module_definitions SET capabilities=capabilities-'store:manage' WHERE module_key='storefront'"),
    (e:unknown)=>(e as {code?:string}).code==='23514');
  const order=ok(await submit(q,s.buyerB,body,key),201);
  await admit(s.a,false);ok(await submit(q,s.buyerB,body,key),409);
  assert.equal(ok(await h.call('GET',`/me/reservations/${order.order_id}`,s.buyerB,undefined,{},app)).state,'reserved');
  ok(await command(`/me/reservations/${order.order_id}/cancel`,s.buyerB,{},randomUUID(),'1'));
  assert.deepEqual(await balance(s.p.product_id),{stock:10,reserved:0});
});

test('database rejects forged shared line quantities, prices, consent and foreign stock provenance',async()=>{
  const s=await fixture(),q=await quote(s.b,s.buyerB,2),order=ok(await submit(q,s.buyerB),201);
  const ownSupply=(await h.pool.query('SELECT supply_shop_id FROM commerce_storefront_profiles WHERE instance_id=$1',[s.b.instanceId])).rows[0].supply_shop_id;
  for(const [quantity,snapshot,supplier,acceptance] of [
    [1,order.items[0],null,null],
    [2,{...order.items[0],unit_price_minor:1,line_total_minor:2},null,null],
    [2,order.items[0],ownSupply,null],
    [2,order.items[0],null,randomUUID()],
  ]) {
    await assert.rejects(h.pool.query(`INSERT INTO commerce_order_lines(order_id,selection_id,item_id,quantity,snapshot,order_profile,supplier_shop_id,hosted_offer_id,acceptance_id,listing_sha256)
      SELECT order_id,selection_id,item_id,$2,$3,order_profile,COALESCE($4::uuid,supplier_shop_id),hosted_offer_id,COALESCE($5::uuid,acceptance_id),listing_sha256
      FROM commerce_order_lines WHERE order_id=$1`,[order.order_id,quantity,snapshot,supplier,acceptance]),
    (e:unknown)=>(e as {code?:string}).code==='23514');
  }
  assert.equal(await h.count('commerce_order_lines'),1);assert.deepEqual(await balance(s.p.product_id),{stock:10,reserved:2});
});
