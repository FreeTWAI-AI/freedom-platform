import assert from 'node:assert/strict';
import {after,before,beforeEach,test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createApp} from '../../apps/platform-api/src/app.js';
import {DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {retainedHostedOrder} from '../helpers/hosted-inventory-history.js';
import {createTenantListCursorCodec} from '../../packages/shared/tenant-list-cursor.js';
import {TENANT_CURSOR_TEST_KEY} from './tenant-cursor-fixture.js';
import {createRegistryHarness,type RegistryHarness,type Reply,type Session} from './module-registry-harness.js';

const supplierGuild='guild_product_quality_supply',retailGuild='guild_commerce_sales';
const catalog={name:'合成供貨目錄',description:'只提供供貨資料',currency:'TWD'};
const product={title:'供貨茶杯',description:'經授權的商品介紹',cost_minor:400,stock:100};
const terms={cost_minor:400,shipping_minor:50,shipping_terms:'確認後三天出貨',return_terms:'瑕疵請聯絡供貨方'};
type Store={owner:Session;tenantId:string;instanceId:string;root:string};
let h:RegistryHarness,runtime:Pool,app:ReturnType<typeof createApp>,closed:ReturnType<typeof createApp>;
const statements:{text:string;values:any[]}[]=[],role=`supplier_queries_${process.pid}_${Date.now()}`;
const ok=(reply:Reply,status=200)=>{assert.equal(reply.status,status,JSON.stringify(reply.data));return reply.data;};
const get=(s:Store,path:string,session=s.owner,target=app)=>h.call('GET',s.root+path,session,undefined,{},target);
const send=(s:Store,path:string,body:unknown={},version?:string,method='POST',session=s.owner)=>
  h.call(method,s.root+path,session,body,{'Idempotency-Key':randomUUID(),...(version?{'If-Match':`"${version}"`}:{})},app);
const command=(path:string,session:Session,body:unknown,version?:string)=>
  h.call('POST',path,session,body,{'Idempotency-Key':randomUUID(),...(version?{'If-Match':`"${version}"`}:{})},app);
const consoleGet=(s:Store,path:string,session=s.owner,target=app)=>get(s,'/supplier-console'+path,session,target);
const profileRow=async(s:Store)=>(await h.pool.query('SELECT * FROM commerce_storefront_profiles WHERE instance_id=$1',[s.instanceId])).rows[0];
async function open(name:string,guild=supplierGuild,owner?:Session):Promise<Store> {
  owner??=(await h.person(name)).session;await h.fullMember(owner.user.user_id,guild);
  const {tenantId,workspaceId}=await h.createTenant(owner,name);
  const planned=await h.plan(owner,tenantId,h.planBody(guild,workspaceId,'hosted-store','hosted-store@1.0.0'));ok(planned,201);
  const launched=await h.launch(owner,tenantId,planned);assert.ok([200,202].includes(launched.status),JSON.stringify(launched.data));
  assert.equal(launched.data.state,'succeeded');
  const instanceId=(await h.pool.query("SELECT instance_id FROM module_instances WHERE tenant_id=$1 AND module_key='storefront'",[tenantId])).rows[0].instance_id;
  return {owner,tenantId,instanceId,root:`/tenants/${tenantId}/storefronts/${instanceId}`};
}
async function supplier(name=catalog.name,owner?:Session) {
  const s=await open(name,supplierGuild,owner);ok(await send(s,'/supply-profile',{...catalog,name}),201);return s;
}
async function retailer(name='零售 B') {
  const s=await open(name,retailGuild);ok(await send(s,'/setup',{name,slug:`retail-${randomUUID().slice(0,12)}`,currency:'TWD'}),201);return s;
}
async function supplyProduct(s:Store,input=product) {
  const made=ok(await send(s,'/supply-products',input),201);
  const item=ok(await get(s,'/supply-products')).items.find((r:any)=>r.product_id===made.product_id);
  const saved=ok(await send(s,`/products/${item.product_id}/supply-terms`,{...terms,cost_minor:input.cost_minor},item.version,'PATCH'));
  return {...item,version:saved.version};
}
const offer=async(s:Store,item:any)=>ok(await send(s,`/products/${item.product_id}/supply-offer`,{},item.version));
const propose=async(s:Store,o:any)=>ok(await send(s,'/distribution-selections',{offer_id:o.offer_id,terms_sha256:o.terms_sha256,retail_price_minor:1200}),201);
const accept=async(s:Store,l:any)=>ok(await send(s,`/supply-requests/${l.selection_id}/decision`,{decision:'accepted',listing_sha256:l.listing_sha256},l.version));
const publish=async(s:Store)=>ok(await send(s,'/publish',{},ok(await get(s,'')).version));
async function admit(s:Store) {
  const setting=ok(await get(s,'/reservation-setting'));
  ok(await send(s,'/reservation-setting',{reservation_enabled:true},setting.version,'PATCH'));
}
async function invite(s:Store,person:Session,capabilities:string[],memberRole:'operator'|'admin'|'viewer'='operator') {
  const principal=await h.candidate(s.owner,person.user.user_id);
  const invitation=await h.post(`/tenants/${s.tenantId}/invitations`,s.owner,{invitee_principal_id:principal,role:memberRole,
    instance_capabilities:capabilities.length?[{instance_id:s.instanceId,capabilities}]:[],expires_at:new Date(Date.now()+86400000).toISOString()});
  ok(invitation,201);await h.accept(person,s.tenantId,invitation);return principal;
}
function privateReply(reply:Reply) {
  assert.equal(reply.response.headers.get('cache-control'),'private, no-store');assert.match(reply.response.headers.get('vary')??'',/Cookie/);
}
async function checkSnapshot(s:Store,path:string,session=s.owner) {
  statements.length=0;const reply=await consoleGet(s,path,session);ok(reply);privateReply(reply);
  assert.equal(statements.length,1);assert.match(reply.data.as_of,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);return reply.data;
}
async function reserve(s:Store,lines:{sku:string;quantity:number}[],buyer?:Session) {
  buyer??=(await h.person('預留買家')).session;
  const view=ok(await get(s,''));
  const quote=ok(await command(`/hosted-stores/${view.store.slug}/reservation-quotes`,buyer,
    {publication_revision:view.publication.current_revision,items:lines}),201);
  const order=ok(await command(`/hosted-stores/${view.store.slug}/reservation-orders`,buyer,
    {quote_id:quote.quote_id,terms_sha256:quote.terms_sha256,client_order_id:randomUUID()}),201);
  return {...order,quote_id:quote.quote_id,buyer};
}
async function cancel(order:any) {return ok(await command(`/me/reservations/${order.order_id}/cancel`,order.buyer,{},order.version));}
async function reservationJourney() {
  const a=await supplier(),b=await retailer(),item=await supplyProduct(a),offered=await offer(a,item);
  const selected=await accept(a,await propose(b,offered));await publish(b);await admit(a);await admit(b);
  return {a,b,item,offered,selected};
}

before(async()=>{
  const url=process.env.TEST_DATABASE_URL;
  assert.ok(url&&['127.0.0.1','localhost'].includes(new URL(url).hostname)&&new URL(url).pathname.startsWith('/fp_'));
  h=await createRegistryHarness('fp_supplier_queries');
  await h.admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    GRANT USAGE ON SCHEMA ${h.schema} TO ${role}; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${h.schema} TO ${role};
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${h.schema} TO ${role}; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${h.schema} TO ${role}`);
  const runtimeUrl=new URL(url);runtimeUrl.username=role;runtimeUrl.password='';
  runtime=new Pool({connectionString:runtimeUrl.toString(),options:`-c search_path=${h.schema} -c statement_timeout=20000`,max:6});
  runtime.on('connect',client=>{
    const native=client.query;
    client.query=function(this:typeof client,...args:any[]) {
      const first=args[0],text=typeof first==='string'?first:first?.text;
      if(text?.includes('/* supplier-console:'))statements.push({text,values:args[1]??first?.values});
      return (native as Function).apply(this,args);
    } as typeof client.query;
  });
  app=createApp(runtime,h.origin,'local',{guildLaunchpadEnabled:true,hostedReservationsEnabled:true,supplierConsoleEnabled:true,tenantCursorSigningKey:TENANT_CURSOR_TEST_KEY});
  closed=createApp(runtime,h.origin,'local',{guildLaunchpadEnabled:true,hostedReservationsEnabled:true,tenantCursorSigningKey:TENANT_CURSOR_TEST_KEY});
});
after(async()=>{
  await runtime?.end();if(h){await h.stop();const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
    try{await admin.query(`DROP ROLE ${role}`);}finally{await admin.end();}}
});
beforeEach(async()=>{
  await h.reset();statements.length=0;
  for(const guild of [supplierGuild,retailGuild])await h.pool.query(`INSERT INTO guild_application_offerings
    (offering_id,community_id,guild_key,application_key,release_ref,status,display_order,launch_policy_ref,version)
    VALUES($1,$2,$3,'hosted-store','hosted-store@1.0.0','offered',10,'{"policy_key":"hosted-store.launch","version":"1"}',1)`,[randomUUID(),DEMO_COMMUNITY,guild]);
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
  await retainedHostedOrder(h.pool,orderId,async history => {
    await history.query(`INSERT INTO commerce_orders(order_id,public_shop_id,external_id,request_sha256,currency,total_minor,created_at,expires_at,
      order_profile,quote_id,buyer_principal_id,client_order_id,reservation_state,reservation_version)
      SELECT $2::uuid,o.public_shop_id,'historical-'||$2::text,o.request_sha256,o.currency,o.total_minor,quote.quoted_at+interval '1 minute',quote.quoted_at+interval '31 minutes',
        o.order_profile,$3::uuid,o.buyer_principal_id,$4::uuid,'reserved',1 FROM commerce_orders o JOIN commerce_order_quotes quote ON quote.quote_id=$3 WHERE o.order_id=$1`,
    [source.order_id,orderId,quoteId,clientId]);
    await history.query(`INSERT INTO commerce_order_lines(order_id,selection_id,transfer_id,item_id,quantity,snapshot,acceptance_id,listing_sha256,order_profile,supplier_shop_id,hosted_offer_id)
      SELECT $2,selection_id,transfer_id,item_id,quantity,snapshot,acceptance_id,listing_sha256,order_profile,supplier_shop_id,hosted_offer_id
      FROM commerce_order_lines WHERE order_id=$1`,[source.order_id,orderId]);
    await history.query(`UPDATE commerce_items i SET reserved=reserved+line.quantity FROM commerce_order_lines line WHERE line.order_id=$1 AND line.item_id=i.item_id`,[orderId]);
  });
  return orderId;
}

test('SC-API-15 reservation filters, whole-set totals and cursor pages agree (AT-22,30,31)',async()=>{
  const {a,b,item,offered,selected}=await reservationJourney();
  const second=await supplyProduct(a,{...product,title:'供貨盤',cost_minor:733}),secondOffer=await offer(a,second);
  const secondSelected=await accept(a,await propose(b,secondOffer));await publish(b);
  const c=await retailer('零售 C'),cSelected=await accept(a,await propose(c,offered));await publish(c);await admit(c);
  const first=await reserve(b,[{sku:selected.sku,quantity:2}]);
  const both=await reserve(b,[{sku:selected.sku,quantity:3},{sku:secondSelected.sku,quantity:4}]);
  const last=await reserve(c,[{sku:cSelected.sku,quantity:1}]);
  const overview=await checkSnapshot(a,'/overview'),all=await checkSnapshot(a,'/reservations');
  assert.deepEqual(all.filter,{state:null,partner_id:null,product_id:null,from:null,to:null});
  assert.deepEqual(all.totals,{reservations:3,lines:4});
  assert.deepEqual(all.items.map((r:any)=>r.order_id),[last.order_id,both.order_id,first.order_id]);
  const reserved=ok(await consoleGet(a,'/reservations?state=reserved'));
  assert.equal(reserved.totals.lines,overview.metrics.active_reservation_lines.count);
  assert.deepEqual(reserved.items,all.items);
  const topKeys=['order_id','version','partner_id','store','currency','items','state','created_at','reservation_expires_at','closed_at',
    'payment_enabled','fulfilment_enabled','money_movement_enabled'].sort();
  const lineKeys=['product_id','offer_id','acceptance_id','sku','title','quantity','unit_supply_price_minor','supply_total_minor'].sort();
  for(const order of all.items) {
    assert.deepEqual(Object.keys(order).sort(),topKeys);assert.deepEqual(Object.keys(order.store).sort(),['name','slug']);
    for(const line of order.items) {
      assert.deepEqual(Object.keys(line).sort(),lineKeys);
      assert.equal(line.supply_total_minor,line.quantity*line.unit_supply_price_minor);
      assert.equal(line.unit_supply_price_minor,line.offer_id===offered.offer_id?offered.terms.cost_minor:secondOffer.terms.cost_minor);
    }
  }
  const byProduct=ok(await consoleGet(a,`/reservations?product_id=${second.product_id}`));
  assert.deepEqual(byProduct.totals,{reservations:1,lines:2});assert.equal(byProduct.items[0].order_id,both.order_id);
  assert.equal(ok(await consoleGet(a,`/reservations?product_id=${randomUUID()}`)).totals.reservations,0);
  const partner=(await profileRow(b)).storefront_shop_id;
  assert.deepEqual(ok(await consoleGet(a,`/reservations?partner_id=${partner}`)).totals,{reservations:2,lines:3});
  assert.deepEqual(ok(await consoleGet(a,`/reservations?from=${first.created_at}&to=${both.created_at}`)).items.map((r:any)=>r.order_id),[first.order_id]);
  assert.equal(ok(await consoleGet(a,`/reservations?to=${first.created_at}`)).items.length,0);
  let cursor:string|null=null;const walked:string[]=[];
  do {
    const page=ok(await consoleGet(a,'/reservations?limit=1'+(cursor?'&cursor='+encodeURIComponent(cursor):'')));
    assert.deepEqual(page.totals,all.totals);assert.equal(page.items.length,1);walked.push(page.items[0].order_id);cursor=page.next_cursor;
  }while(cursor);
  assert.deepEqual(walked,all.items.map((r:any)=>r.order_id));
  const token=ok(await consoleGet(a,'/reservations?limit=1')).next_cursor;
  for(const filter of ['state=reserved',`partner_id=${partner}`,`product_id=${item.product_id}`,`from=${first.created_at}`,`to=${last.created_at}`]) {
    const reply=await consoleGet(a,`/reservations?${filter}&cursor=${encodeURIComponent(token)}`);ok(reply,422);assert.equal(reply.data.code,'invalid_cursor');
  }
  const sameOwner=await supplier('另一個事業',a.owner),otherOwner=await supplier('另一位擁有者');
  for(const s of [sameOwner,otherOwner]) {
    const reply=await consoleGet(s,'/reservations?cursor='+encodeURIComponent(token));ok(reply,422);assert.equal(reply.data.code,'invalid_cursor');
  }
  // A receipt retains only its reference, never these filters or the projected page.
  const receipts=(await h.pool.query('SELECT response FROM scoped_command_receipts WHERE idempotency_key=$1',
    [`supplier-console-reservations-${a.instanceId}`])).rows;
  assert.deepEqual(receipts,[{response:{id:a.instanceId}}]);
});

test('SC-API-16 states classify due holds as expired and list/detail settle once (AT-19,20,22,30)',async()=>{
  const {a,b,selected,item}=await reservationJourney();
  const live=await reserve(b,[{sku:selected.sku,quantity:3}]),cancelled=await reserve(b,[{sku:selected.sku,quantity:2}]);await cancel(cancelled);
  const expired=await expiredCopy(cancelled);
  const before=(await h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1',[item.product_id])).rows[0].reserved;
  assert.equal(before,5);
  const summary=await checkSnapshot(a,'/summary'),overview=await checkSnapshot(a,'/overview');
  assert.equal(overview.metrics.active_reservation_lines.count,1);assert.equal(JSON.stringify(summary).includes('reservation'),false);
  assert.equal((await h.pool.query('SELECT reservation_state FROM commerce_orders WHERE order_id=$1',[expired])).rows[0].reservation_state,'reserved');
  const page=await checkSnapshot(a,'/reservations?state=expired');
  assert.deepEqual(page.totals,{reservations:1,lines:1});assert.equal(page.items[0].order_id,expired);assert.equal(page.items[0].state,'expired');
  assert.ok(page.items[0].closed_at);assert.equal(page.items[0].version,'2');
  assert.equal((await h.pool.query('SELECT reservation_state FROM commerce_orders WHERE order_id=$1',[expired])).rows[0].reservation_state,'expired');
  assert.equal((await h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1',[item.product_id])).rows[0].reserved,3);
  assert.deepEqual(ok(await consoleGet(a,'/reservations?state=reserved')).items.map((r:any)=>r.order_id),[live.order_id]);
  assert.deepEqual(ok(await consoleGet(a,'/reservations?state=cancelled')).items.map((r:any)=>r.order_id),[cancelled.order_id]);
  assert.deepEqual(ok(await consoleGet(a,'/reservations?state=reserved')).totals,{reservations:1,lines:1});
  const dueDetail=await expiredCopy(cancelled),detail=ok(await consoleGet(a,`/reservations/${dueDetail}`));
  assert.equal(detail.reservation.state,'expired');assert.equal(detail.reservation.version,'2');
  assert.equal((await h.pool.query('SELECT reservation_state FROM commerce_orders WHERE order_id=$1',[dueDetail])).rows[0].reservation_state,'expired');
  assert.equal((await h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1',[item.product_id])).rows[0].reserved,3);
  assert.deepEqual(ok(await consoleGet(a,`/reservations/${dueDetail}`)).reservation,detail.reservation);
});

test('SC-API-17 mixed-supplier list/detail restrict lines, amounts and offers; missing detail has one body (AT-22,30,31)',async()=>{
  const {a,b,selected,offered}=await reservationJourney(),c=await supplier('供應 C');
  const cProduct=await supplyProduct(c,{...product,title:'C 私人供貨商品',cost_minor:913}),cOffer=await offer(c,cProduct);
  const cSelection=await accept(c,await propose(b,cOffer));await publish(b);await admit(c);
  const order=await reserve(b,[{sku:selected.sku,quantity:2},{sku:cSelection.sku,quantity:3}]);
  for(const [s,wanted,hidden,expectedOffer,quantity] of [[a,'供貨茶杯','C 私人供貨商品',offered,2],[c,'C 私人供貨商品','供貨茶杯',cOffer,3]] as const) {
    const page=ok(await consoleGet(s,'/reservations')),reply=await consoleGet(s,`/reservations/${order.order_id}`),detail=ok(reply);privateReply(reply);
    assert.deepEqual(page.totals,{reservations:1,lines:1});assert.deepEqual(detail.reservation,page.items[0]);
    assert.deepEqual(detail.offers,[{offer_id:expectedOffer.offer_id,product_id:expectedOffer.product_id,terms_sha256:expectedOffer.terms_sha256,state:'offered'}]);
    assert.equal(detail.reservation.items.length,1);assert.equal(detail.reservation.items[0].title,wanted);
    assert.equal(detail.reservation.items[0].supply_total_minor,quantity*expectedOffer.terms.cost_minor);
    assert.equal(JSON.stringify(detail).includes(hidden),false);
    assert.doesNotMatch(JSON.stringify(detail),/buyer|quote|client_order|retail_price|"total_minor":/);
  }
  const onlyC=await reserve(b,[{sku:cSelection.sku,quantity:1}]),unrelated=await supplier('無關供應商');
  const random=await consoleGet(a,`/reservations/${randomUUID()}`);ok(random,404);assert.equal(random.data.code,'hosted_order_not_found');
  for(const [s,id] of [[a,onlyC.order_id],[unrelated,order.order_id]] as const) {
    const reply=await consoleGet(s,`/reservations/${id}`);ok(reply,404);assert.deepEqual(reply.data,random.data);
  }
});

test('SC-API-18 strict queries, authentication, owner-only access and flag OFF (AT-04,22,44)',async()=>{
  const {a,b,selected}=await reservationJourney(),order=await reserve(b,[{sku:selected.sku,quantity:1}]);
  const paths=['/reservations',`/reservations/${order.order_id}`,'/changes','/summary'];
  for(const path of paths) {
    const off=await consoleGet(a,path,a.owner,closed);ok(off,404);assert.equal(off.data.code,'not_found');
    const unauthenticated=await h.call('GET',a.root+'/supplier-console'+path,undefined,undefined,{},app);ok(unauthenticated,401);
    const success=await consoleGet(a,path);ok(success);privateReply(success);
  }
  for(const query of ['limit=0','limit=51','limit=100','limit=x','limit=01','limit=1&limit=2','unknown=1','state=reserved&state=expired',
    'state=paid','from=2026-01-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z','from=2026-02-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z']) {
    const reply=await consoleGet(a,'/reservations?'+query);ok(reply,422);assert.equal(reply.data.code,'validation_failed');
  }
  for(const path of [`/reservations/${order.order_id}?unknown=1`,'/changes?unknown=1','/changes?product_id=x','/changes?product_id='+randomUUID()+'&product_id='+randomUUID(),'/summary?unknown=1'])ok(await consoleGet(a,path),422);
  const admin=(await h.person('管理員')).session,operator=(await h.person('操作員')).session,viewer=(await h.person('唯讀者')).session;
  await invite(a,admin,[],'admin');await invite(a,operator,['store:read','store:write','store:manage']);await invite(a,viewer,['store:read'],'viewer');
  for(const who of [admin,operator,viewer]) {
    const existing=await get(a,'/supply-reservations',who);ok(existing,403);assert.equal(existing.data.code,'seller_owner_required');
    for(const path of paths.slice(0,2)) {
      const reply=await consoleGet(a,path,who);ok(reply,existing.status);assert.equal(reply.data.code,existing.data.code);
    }
  }
  const outsider=(await h.person('非成員')).session,foreign=await supplier('外事業');
  for(const who of [outsider,foreign.owner]) {
    const existing=await get(a,'/supply-reservations',who);ok(existing,404);assert.equal(existing.data.code,'tenant_not_found');
    for(const path of paths.slice(0,2)) {const reply=await consoleGet(a,path,who);ok(reply,404);assert.equal(reply.data.code,existing.data.code);}
    for(const path of paths.slice(2)) {const reply=await consoleGet(a,path,who);ok(reply,404);assert.equal(reply.data.code,'not_found');}
  }
});

test('SC-API-19 a current new owner cannot reuse the former owner cursor (AT-04,22,37)',async()=>{
  const {a,b,selected}=await reservationJourney();await reserve(b,[{sku:selected.sku,quantity:1}]);await reserve(b,[{sku:selected.sku,quantity:1}]);
  const first=ok(await consoleGet(a,'/reservations?limit=1')),next=(await h.person('下一位擁有者')).session;
  const principal=await invite(a,next,[],'admin');
  // Synthetic authoritative membership transition, as in the seller-order suite.
  const q=await h.pool.connect();try {
    await q.query('BEGIN');await q.query("UPDATE tenant_memberships SET role='admin',version=version+1 WHERE tenant_id=$1 AND role='owner'",[a.tenantId]);
    await q.query("UPDATE tenant_memberships SET role='owner',version=version+1 WHERE tenant_id=$1 AND principal_id=$2",[a.tenantId,principal]);await q.query('COMMIT');
  }catch(e){await q.query('ROLLBACK');throw e;}finally{q.release();}
  const old=await consoleGet(a,'/reservations');ok(old,403);assert.equal(old.data.code,'seller_owner_required');
  const transferred=await consoleGet(a,'/reservations?cursor='+encodeURIComponent(first.next_cursor),next);ok(transferred,422);assert.equal(transferred.data.code,'invalid_cursor');
  assert.equal(ok(await consoleGet(a,'/reservations',next)).items.length,2);
});

test('SC-API-20 recent changes resolve current subjects and offer replacement versions (AT-04,15,30)',async()=>{
  const a=await supplier(),b=await retailer(),one=await supplyProduct(a),two=await supplyProduct(a,{...product,title:'第二件商品'});
  const first=await offer(a,one);
  const edited=ok(await send(a,`/supply-products/${one.product_id}`,{title:'目前的茶杯名稱',stock:95},one.version,'PATCH'));
  const updated=ok(await send(a,`/products/${one.product_id}/supply-terms`,{...terms,cost_minor:650},edited.version,'PATCH'));
  const replacement=await offer(a,{...one,version:updated.version}),pending=await propose(b,replacement),accepted=await accept(a,pending);
  ok(await send(a,`/supply-offers/${replacement.offer_id}/withdraw`,{},replacement.version));
  const p=ok(await get(a,'/supply-profile'));
  ok(await send(a,'/supply-profile',{name:'改名後的供貨目錄'},p.version,'PATCH'));await admit(a);
  const changes=await checkSnapshot(a,'/changes');assert.equal(changes.truncated,false);assert.equal(changes.product_id,null);
  assert.ok(changes.items.length>=14);
  const ordered=(await h.pool.query('SELECT transition_id FROM scoped_transition_journal WHERE transition_id=ANY($1::uuid[]) ORDER BY created_at DESC,transition_id DESC',
    [changes.items.map((r:any)=>r.change_id)])).rows.map(r=>r.transition_id);
  assert.deepEqual(changes.items.map((r:any)=>r.change_id),ordered);
  const operation=(name:string)=>changes.items.filter((r:any)=>r.operation===name);
  for(const name of ['storefront.supply-catalog.setup','storefront.supply-profile.update','storefront.reservations.configure']) {
    assert.equal(operation(name).length,1);assert.deepEqual(operation(name)[0].subject,{kind:'business'});
  }
  assert.equal(operation('storefront.supply-product.create').length,2);assert.equal(operation('storefront.supply-product.update').length,1);
  assert.equal(operation('storefront.supply-terms.update').length,3);
  const publishes=operation('storefront.supply-offer.publish');
  assert.deepEqual(publishes.filter((r:any)=>r.subject.offer_id===first.offer_id).map((r:any)=>r.version).sort(),['1','2']);
  assert.deepEqual(publishes.filter((r:any)=>r.subject.offer_id===replacement.offer_id).map((r:any)=>r.version),['1']);
  assert.deepEqual(operation('storefront.supply-offer.withdraw')[0].subject,
    {kind:'offer',offer_id:replacement.offer_id,product_id:one.product_id,title:'目前的茶杯名稱'});
  assert.deepEqual(operation('storefront.distribution.decide')[0].subject,{kind:'request',selection_id:accepted.selection_id,
    product_id:one.product_id,title:'目前的茶杯名稱',partner_id:(await profileRow(b)).storefront_shop_id,partner_name:'零售 B'});
  for(const item of changes.items) {
    assert.deepEqual(Object.keys(item).sort(),['at','change_id','operation','subject','version']);
    if(item.subject.product_id===one.product_id)assert.equal(item.subject.title,'目前的茶杯名稱');
  }
  const filtered=await checkSnapshot(a,`/changes?product_id=${one.product_id}`);
  assert.equal(filtered.product_id,one.product_id);assert.ok(filtered.items.length>0);
  assert.deepEqual(filtered.items,changes.items.filter((r:any)=>r.subject.product_id===one.product_id));
  assert.equal(filtered.items.some((r:any)=>r.subject.kind==='business'),false);
  assert.deepEqual(ok(await consoleGet(a,`/changes?product_id=${randomUUID()}`)).items,[]);
  assert.deepEqual(ok(await consoleGet(b,`/changes?product_id=${one.product_id}`)).items,[]);
  assert.deepEqual(ok(await consoleGet(b,'/changes')).items,[]);
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM scoped_transition_journal WHERE scope_id=(SELECT scope_id FROM resource_scopes WHERE tenant_ref=$1) AND operation='storefront.distribution.propose'",[b.tenantId])).rows[0].n,1);
  const encoded=JSON.stringify(changes);
  assert.doesNotMatch(encoded,/principal|execution|decision|accepted|listing_sha256/);
  const principals=(await h.pool.query('SELECT DISTINCT principal_id FROM scoped_transition_journal WHERE transition_id=ANY($1::uuid[])',
    [changes.items.map((r:any)=>r.change_id)])).rows;
  for(const row of principals)assert.equal(encoded.includes(row.principal_id),false);
  assert.doesNotMatch(statements[0].text,/j\.(?:principal_id|data|execution)/);
  assert.ok(changes.items.some((r:any)=>r.subject.product_id===two.product_id));
});

test('SC-API-21 changes include retail-owned products, skip removed subjects and retailer proposals (AT-04,37)',async()=>{
  const a=await retailer('同時供貨與零售'),foreign=await supplier('別家供貨商');
  const made=ok(await send(a,'/products',{title:'自有零售商品',description:'自有庫存',price_minor:900,stock:10}),201);
  const edited=ok(await send(a,`/products/${made.product_id}`,{title:'更新的零售商品',stock:9},made.version,'PATCH'));
  const item=await supplyProduct(foreign),offered=await offer(foreign,item);await propose(a,offered);
  const removed=await supplyProduct(a,{...product,title:'即將移除'});
  const beforeRemoval=await checkSnapshot(a,'/changes');
  assert.ok(beforeRemoval.items.some((r:any)=>r.subject.product_id===removed.product_id));
  ok(await send(a,`/products/${removed.product_id}/remove`,{},removed.version));
  ok(await send(a,'',{name:'更新零售店設定'},ok(await get(a,'')).version,'PATCH'));
  const changes=await checkSnapshot(a,'/changes');
  assert.deepEqual(changes.items.map((r:any)=>r.operation),['storefront.product.update','storefront.product.create']);
  for(const row of changes.items)assert.deepEqual(row.subject,{kind:'product',product_id:made.product_id,title:edited.title});
  assert.deepEqual(ok(await consoleGet(a,`/changes?product_id=${removed.product_id}`)).items,[]);
  assert.deepEqual(ok(await consoleGet(a,`/changes?product_id=${item.product_id}`)).items,[]);
  assert.equal(changes.items.some((r:any)=>r.operation==='storefront.distribution.propose'),false);
  const viewer=(await h.person('變更唯讀者')).session;await invite(a,viewer,['store:read'],'viewer');
  const refused=await consoleGet(a,'/changes',viewer);ok(refused,403);assert.equal(refused.data.code,'capability_denied');
});

test('SC-API-22 changes resolve subjects before bounding to twenty rows (AT-30)',async()=>{
  const a=await supplier();let item=await supplyProduct(a);
  for(let i=0;i<23;i++)item=ok(await send(a,`/supply-products/${item.product_id}`,{title:`現行標題 ${i}`},item.version,'PATCH'));
  let removed=await supplyProduct(a,{...product,title:'稍後刪除的商品'});
  for(let i=0;i<23;i++)removed=ok(await send(a,`/supply-products/${removed.product_id}`,{stock:100+i},removed.version,'PATCH'));
  ok(await send(a,`/products/${removed.product_id}/remove`,{},removed.version));
  const changes=await checkSnapshot(a,'/changes');
  assert.equal(changes.items.length,20);assert.equal(changes.truncated,true);
  assert.equal(changes.items.every((r:any)=>r.operation==='storefront.supply-product.update'&&r.subject.title==='現行標題 22'),true);
  const filtered=await checkSnapshot(a,`/changes?product_id=${item.product_id}`);
  assert.equal(filtered.truncated,true);assert.deepEqual(filtered.items,changes.items);
});

test('SC-API-23 summary uses overview definitions, write capability and no reservation data (AT-04,30,39)',async()=>{
  const {a,b,item,selected,offered}=await reservationJourney();await reserve(b,[{sku:selected.sku,quantity:1}]);
  const c=await retailer('待決合作');await propose(c,offered);
  await supplyProduct(a,{...product,title:'零庫存商品',stock:0});
  ok(await send(a,`/products/${item.product_id}/supply-terms`,{...terms,cost_minor:601},item.version,'PATCH'));
  const overview=await checkSnapshot(a,'/overview'),summary=await checkSnapshot(a,'/summary');
  assert.deepEqual(summary.todos,{state:'ready',pending_requests:1,outdated_offers:1,out_of_stock_products:1});
  assert.equal(summary.todos.pending_requests,overview.metrics.pending_requests.count);
  assert.equal(summary.todos.out_of_stock_products,overview.metrics.out_of_stock_products.count);
  assert.equal(summary.todos.outdated_offers,overview.todos.items.filter((r:any)=>r.kind==='offer_outdated').length);
  assert.match(statements[0].text,/\/\* supplier-console:summary \*\//);
  assert.doesNotMatch(statements[0].text,/commerce_(?:orders|order_lines|order_quotes)/);
  assert.deepEqual(Object.keys(summary).sort(),['as_of','instance_id','profile','tenant_id','todos']);
  assert.doesNotMatch(JSON.stringify(summary),/reservation|buyer|quote|supply_total/);
  const operator=(await h.person('摘要操作員')).session,viewer=(await h.person('摘要唯讀者')).session;
  await invite(a,operator,['store:read','store:write']);await invite(a,viewer,['store:read'],'viewer');
  assert.deepEqual((await checkSnapshot(a,'/summary',operator)).todos,summary.todos);
  const reader=await checkSnapshot(a,'/summary',viewer);
  assert.deepEqual(reader.todos,{state:'unavailable',reason:'store_write_required'});
  assert.match(statements[0].text,/\/\* supplier-console:summary-reader \*\//);assert.doesNotMatch(statements[0].text,/commerce_/);
  const notReady=await open('尚未設定');
  const refused=await consoleGet(notReady,'/summary');ok(refused,409);assert.equal(refused.data.code,'storefront_not_set_up');
  const empty=await supplier('空的供貨目錄');
  assert.deepEqual((await checkSnapshot(empty,'/summary')).todos,{state:'ready',pending_requests:0,outdated_offers:0,out_of_stock_products:0});
});

test('SC-API-24 signed cursor positions must use exact keys, microseconds and UUIDs (AT-04,22)',async()=>{
  const {a,b,selected}=await reservationJourney();await reserve(b,[{sku:selected.sku,quantity:1}]);await reserve(b,[{sku:selected.sku,quantity:2}]);
  const page=ok(await consoleGet(a,'/reservations?limit=1'));
  const owner=(await h.pool.query(`SELECT m.principal_id,s.scope_id FROM tenant_memberships m
    JOIN resource_scopes s ON s.tenant_ref=m.tenant_id WHERE m.tenant_id=$1 AND m.role='owner'`,[a.tenantId])).rows[0];
  const binding={purpose:'supplier-orders' as const,principalId:owner.principal_id,tenantId:a.tenantId,scopeId:owner.scope_id,
    resourceId:a.instanceId,filter:JSON.stringify(['freedom.supplier-console.reservations/v1',null,null,null,null,null])};
  const codec=createTenantListCursorCodec(TENANT_CURSOR_TEST_KEY,{environment:'local',origin:h.origin});
  const position=codec.decode(page.next_cursor,binding) as Record<string,string>;
  assert.match(position.at,/\.\d{6}Z$/);
  const invalid:Record<string,string>[]=[{...position,at:position.at.replace(/\d{3}Z$/,'Z')},{...position,at:'invalid'},
    {...position,id:'invalid'},{...position,extra:'no'},{at:position.at}];
  const legacy=ok(await get(a,'/supply-reservations?limit=1')).next_cursor;
  for(const cursor of [...invalid.map(p=>codec.encode(p,binding)),legacy,'invalid',page.next_cursor.slice(1)]) {
    const reply=await consoleGet(a,'/reservations?cursor='+encodeURIComponent(cursor));ok(reply,422);assert.equal(reply.data.code,'invalid_cursor');
  }
});
