import assert from 'node:assert/strict';
import {after,before,beforeEach,test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {digest} from '../../packages/db/index.js';
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
let fault:((row:any)=>void)|undefined;
const allStatements:string[]=[];
const statements:{text:string;values:any[]}[]=[],role=`supplier_report_${process.pid}_${Date.now()}`;
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
  h=await createRegistryHarness('fp_supplier_report');
  // Retain the fresh-install statistics state for the bulk-history regression.
  // These two tables belong only to this disposable harness schema.
  await h.pool.query('ALTER TABLE commerce_orders SET (autovacuum_enabled=false); ALTER TABLE commerce_order_lines SET (autovacuum_enabled=false)');
  await h.admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    GRANT USAGE ON SCHEMA ${h.schema} TO ${role}; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${h.schema} TO ${role};
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${h.schema} TO ${role}; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${h.schema} TO ${role}`);
  const runtimeUrl=new URL(url);runtimeUrl.username=role;runtimeUrl.password='';
  runtime=new Pool({connectionString:runtimeUrl.toString(),options:`-c search_path=${h.schema} -c statement_timeout=20000`,max:6});
  runtime.on('connect',client=>{
    const native=client.query;
    client.query=function(this:typeof client,...args:any[]) {
      const first=args[0],text=typeof first==='string'?first:first?.text;
      if(text)allStatements.push(text);
      if(text?.includes('/* supplier-console:'))statements.push({text,values:args[1]??first?.values});
      const result=(native as Function).apply(this,args);
      if(text?.includes('/* supplier-console:report')&&fault)return result.then((result:any)=>{fault!(result.rows[0]);return result;});
      return result;
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
  fault=undefined;await h.reset();statements.length=0;allStatements.length=0;
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

const day=(at=Date.now())=>new Date(at+8*3600000).toISOString().slice(0,10);
const period=()=>({from:day(Date.now()-86400000),to:day()});
const reportPath=(csv=false,query=period())=>`/report${csv?'.csv':''}?`+new URLSearchParams(query);
async function report(s:Store,csv=false,session=s.owner) {
  statements.length=0;const reply=await consoleGet(s,reportPath(csv),session);ok(reply);privateReply(reply);
  assert.equal(statements.length,1);assert.ok(statements[0].text.startsWith(`/* supplier-console:${csv?'report-csv':'report'} */`));
  return reply;
}
async function csvBody(reply:Reply) {
  const bytes=Buffer.from(await reply.response.arrayBuffer());assert.deepEqual([...bytes.subarray(0,3)],[239,187,191]);
  return bytes.toString('utf8');
}
// Parse quoted RFC 4180 cells, including embedded CR/LF. Also assert that every
// nonempty row is fully quoted and that every record uses CRLF, including EOF.
function parseCsv(text:string) {
  assert.equal(text[0],'\uFEFF');const rows:string[][]=[];let i=1;
  while(i<text.length) {
    const row:string[]=[];
    if(text.slice(i,i+2)==='\r\n'){rows.push(row);i+=2;continue;}
    for(;;) {
      assert.equal(text[i++],'"');let value='';
      for(;;) {
        assert.ok(i<text.length);
        if(text[i]==='"') {
          i++;if(text[i]==='"'){value+='"';i++;continue;}break;
        }
        value+=text[i++];
      }
      row.push(value);
      if(text[i]===','){i++;continue;}
      assert.equal(text.slice(i,i+2),'\r\n');i+=2;rows.push(row);break;
    }
  }
  return rows;
}
function section(rows:string[][],name:string) {
  const start=rows.findIndex(r=>r.length===1&&r[0]===name);if(start===-1)return [];
  const end=rows.findIndex((r,i)=>i>start&&r.length===0);return rows.slice(start+2,end===-1?undefined:end);
}
function assertSummary(rows:string[][],r:any) {
  const expected:Record<string,number>={'商品總數':r.products.total,'公開中':r.products.offered,'尚未公開':r.products.not_offered,
    '需更新版本':r.products.outdated,'缺貨':r.products.out_of_stock,'合作店家':r.cooperation.partner_count,
    '選品待確認':r.cooperation.totals.awaiting,'選品可售':r.cooperation.totals.sellable,'選品需修改':r.cooperation.totals.changes_requested,'選品停用':r.cooperation.totals.inactive};
  assert.deepEqual(Object.fromEntries(section(rows,'摘要').map(([k,v])=>[k,Number(v)])),expected);
  if(r.reservations.state==='ready') {
    const start=rows.findIndex(row=>row[0]==='預留狀態');assert.ok(start>0);
    for(const [i,state] of ['reserved','cancelled','expired'].entries()) {
      const totals=r.reservations[state];assert.deepEqual(rows[start+i+1].slice(1).map(Number),
        [totals.reservations,totals.lines,totals.quantity,totals.supply_total_minor]);
    }
  }
}

test('SC-API-25 report validates strict Taipei days on JSON and CSV (AT-29,30)',async()=>{
  const a=await supplier();
  const invalid=['','from=2026-01-01','to=2026-01-01','from=2026-02-29&to=2026-03-01',
    'from=2026-01-01&to=2026-02-29','from=2026-1-01&to=2026-01-02','from=1999-12-31&to=2000-01-01','from=2026-01-02&to=2026-01-01',
    'from=2026-01-01&to=2027-01-02','from=2026-01-01&to=2026-01-01&unknown=1',
    'from=2026-01-01&from=2026-01-02&to=2026-01-02','from=2026-01-01&to=2026-01-01&to=2026-01-02'];
  for(const csv of [false,true]) {
    for(const query of invalid) {
      statements.length=0;const reply=await consoleGet(a,`/report${csv?'.csv':''}?${query}`);ok(reply,422);privateReply(reply);
      assert.equal(reply.data.code,'validation_failed');assert.match(reply.response.headers.get('content-type')!,/application\/json/);assert.equal(statements.length,0);
    }
    for(const query of [{from:'2026-01-01',to:'2027-01-01'},{from:'2026-01-01',to:'2026-01-01'}])ok(await consoleGet(a,reportPath(csv,query)));
  }
});

test('SC-API-26 report shares products, partners and reservation definitions (AT-30)',async()=>{
  const {a,b,item,offered,selected}=await reservationJourney();
  const other=await supplyProduct(a,{...product,title:'第二件供貨商品',cost_minor:733}),otherOffer=await offer(a,other);
  const otherSelected=await accept(a,await propose(b,otherOffer));await publish(b);
  await reserve(b,[{sku:selected.sku,quantity:3},{sku:otherSelected.sku,quantity:4}]);
  const cancelled=await reserve(b,[{sku:selected.sku,quantity:2}]);await cancel(cancelled);await expiredCopy(cancelled);
  const pending=await retailer('待確認店');await propose(pending,offered);
  const changes=await retailer('需修改店'),changed=await propose(changes,offered);
  // Retained legacy state, through the existing selection guards.
  await h.pool.query("UPDATE commerce_selections SET acceptance_state='changes_requested',aggregate_version=aggregate_version+1 WHERE selection_id=$1",[changed.selection_id]);
  const inactive=await retailer('停用店'),declined=await propose(inactive,otherOffer);
  ok(await send(a,`/supply-requests/${declined.selection_id}/decision`,{decision:'declined',listing_sha256:declined.listing_sha256},declined.version));
  await supplyProduct(a,{...product,title:'未公開缺貨',stock:0});
  ok(await send(a,`/products/${item.product_id}/supply-terms`,{...terms,cost_minor:601},item.version,'PATCH'));
  const r=(await report(a)).data,rows=parseCsv(await csvBody(await report(a,true)));assertSummary(rows,r);
  const products=ok(await consoleGet(a,'/products')).items;
  assert.deepEqual(r.products,{total:products.length,offered:products.filter((p:any)=>p.offer!==null).length,
    not_offered:products.filter((p:any)=>p.offer===null).length,outdated:products.filter((p:any)=>p.offer&&!p.offer.matches_current_terms).length,
    out_of_stock:products.filter((p:any)=>p.available===0).length});
  assert.deepEqual(r.products,{total:3,offered:2,not_offered:1,outdated:1,out_of_stock:1});
  const partners=ok(await consoleGet(a,'/partners'));assert.deepEqual(r.cooperation.partners,partners.items);
  assert.equal(r.cooperation.partner_count,partners.items.length);
  const totals={awaiting:0,sellable:0,changes_requested:0,inactive:0};
  for(const p of partners.items)for(const k of Object.keys(totals) as (keyof typeof totals)[])totals[k]+=p.cooperation[k];
  assert.deepEqual(r.cooperation.totals,totals);assert.deepEqual(totals,{awaiting:1,sellable:2,changes_requested:1,inactive:1});
  assert.equal(section(rows,'商品').length+section(rows,'合作店家').length+section(rows,'預留行項').length,r.csv_rows);
  // Read S2 lists last: their expiry settlement changes physical availability.
  for(const state of ['reserved','cancelled','expired']) {
    const list=ok(await consoleGet(a,'/reservations?'+new URLSearchParams({state,from:r.period.start,to:r.period.end})));
    const s=r.reservations[state];assert.deepEqual({reservations:s.reservations,lines:s.lines},list.totals);
    const lines=list.items.flatMap((o:any)=>o.items);
    assert.equal(s.quantity,lines.reduce((n:number,l:any)=>n+l.quantity,0));
    assert.equal(s.supply_total_minor,lines.reduce((n:number,l:any)=>n+l.quantity*l.unit_supply_price_minor,0));
  }
  assert.equal(r.reservations.reserved.supply_total_minor,3*400+4*733);
});

test('SC-API-27 report uses half-open Taipei boundaries regardless of process TZ (AT-30)',async()=>{
  const {a,b,selected}=await reservationJourney(),source=await reserve(b,[{sku:selected.sku,quantity:2}]);
  await historicalCopies(source,['2026-01-01T15:59:59.999Z','2026-01-01T16:00:00.000Z','2026-01-02T15:59:59.999Z','2026-01-02T16:00:00.000Z']);
  const old=process.env.TZ;let expected:any;
  try {
    for(const tz of ['UTC','America/Los_Angeles','Asia/Taipei']) {
      process.env.TZ=tz;
      const r=ok(await consoleGet(a,reportPath(false,{from:'2026-01-02',to:'2026-01-02'})));
      assert.deepEqual(r.period,{from:'2026-01-02',to:'2026-01-02',time_zone:'Asia/Taipei',start:'2026-01-01T16:00:00.000Z',end:'2026-01-02T16:00:00.000Z'});
      assert.equal(r.reservations.expired.reservations,2);assert.equal(r.reservations.expired.quantity,4);
      if(expected)assert.deepEqual(r.reservations,expected);expected=r.reservations;
      const rows=parseCsv(await csvBody(await consoleGet(a,reportPath(true,{from:'2026-01-02',to:'2026-01-02'}))));
      assert.deepEqual(section(rows,'預留行項').map(r=>r[1]),['2026-01-02 00:00:00','2026-01-02 23:59:59']);
    }
  }finally{if(old===undefined)delete process.env.TZ;else process.env.TZ=old;}
});

test('SC-API-28 due reservations are classified without settlement, locks or receipts (AT-30)',async()=>{
  const {a,b,item,selected}=await reservationJourney(),source=await reserve(b,[{sku:selected.sku,quantity:3}]);
  const due=await expiredCopy(source);
  const snapshot=async()=>({order:(await h.pool.query('SELECT reservation_state,reservation_version,closed_at FROM commerce_orders WHERE order_id=$1',[due])).rows[0],
    item:(await h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1',[item.product_id])).rows[0],
    receipts:await h.count('scoped_command_receipts'),journal:await h.count('scoped_transition_journal'),
    holds:(await h.pool.query('SELECT * FROM commerce_inventory_reservations WHERE order_id=$1',[due])).rows});
  const before=await snapshot();assert.equal(before.order.reservation_state,'reserved');assert.equal(before.item.reserved,6);
  for(const csv of [false,true]) {
    allStatements.length=0;const reply=await report(a,csv);
    if(csv)assert.equal(section(parseCsv(await csvBody(reply)),'預留行項').filter(r=>r[2]==='已到期').length,1);
    else assert.deepEqual(reply.data.reservations.expired,{reservations:1,lines:1,quantity:3,supply_total_minor:1200});
    assert.deepEqual(await snapshot(),before);
    assert.doesNotMatch(statements[0].text,/FOR\s+(?:UPDATE|SHARE)|pg_advisory|INSERT|UPDATE\s+commerce/i);
    const eligibility=allStatements.find(s=>s.includes('NOT is_verification_test_account'));assert.ok(eligibility);
    assert.doesNotMatch(eligibility,/FOR\s+(?:NO KEY UPDATE|UPDATE|SHARE)|pg_advisory/i);
    assert.equal(allStatements.some(s=>s.includes('commerce-orders/')||s.includes('scoped_command_receipts')),false);
  }
});

test('SC-API-29 mixed supplier report and CSV expose only the addressed supplier (AT-04,30)',async()=>{
  const {a,b,item,selected}=await reservationJourney(),c=await supplier('供應 C');
  const cProduct=await supplyProduct(c,{...product,title:'C 私人供貨商品',cost_minor:913}),cOffer=await offer(c,cProduct);
  const cSelection=await accept(c,await propose(b,cOffer));await publish(b);await admit(c);
  const order=await reserve(b,[{sku:selected.sku,quantity:2},{sku:cSelection.sku,quantity:3}]);
  ok(await send(a,`/supply-products/${item.product_id}`,{title:'A 更新後的商品名稱'},item.version,'PATCH'));
  for(const [s,wanted,hidden,quantity,cost] of [[a,product.title,cProduct.title,2,400],[c,cProduct.title,product.title,3,913]] as const) {
    const r=(await report(s)).data,body=await csvBody(await report(s,true)),rows=parseCsv(body),lines=section(rows,'預留行項');
    assert.deepEqual(r.reservations.reserved,{reservations:1,lines:1,quantity,supply_total_minor:quantity*cost});
    assert.equal(lines.length,1);assert.equal(lines[0][0],order.order_id);assert.equal(lines[0][9],wanted);assert.equal(lines[0][8],s===a?selected.sku:cSelection.sku);assert.equal(lines[0][13],String(quantity*cost));
    assert.ok(body.includes(wanted));assert.equal(body.includes(hidden),false);
    for(const secret of [order.buyer.user.email,order.buyer.user.display_name,order.quote_id])assert.equal(body.includes(secret),false);
    assert.doesNotMatch(body,/buyer|client_order|quote|retail_price|listing_sha256|acceptance_id/);
    assert.equal(r.csv_rows,section(rows,'商品').length+section(rows,'合作店家').length+lines.length);
  }
});

test('SC-API-30 report gates owner data, write capability, membership, authentication and flags (AT-04,29)',async()=>{
  const {a,b,selected}=await reservationJourney();await reserve(b,[{sku:selected.sku,quantity:1}]);
  const admin=(await h.person('報表管理員')).session,operator=(await h.person('報表操作員')).session,viewer=(await h.person('報表唯讀者')).session;
  await invite(a,admin,[],'admin');await invite(a,operator,['store:read','store:write','store:manage']);await invite(a,viewer,['store:read'],'viewer');
  assert.equal((await report(a)).data.reservations.state,'ready');
  for(const who of [admin,operator]) {
    const r=(await report(a,false,who)).data;assert.deepEqual(r.reservations,{state:'unavailable',reason:'owner_required'});
    assert.equal(r.csv_rows,r.products.total+r.cooperation.partner_count);assert.doesNotMatch(statements[0].text,/commerce_order/);
    const body=await csvBody(await report(a,true,who));assert.doesNotMatch(statements[0].text,/commerce_order/);
    assert.ok(body.includes('只有業務空間擁有者可以查看預留，本檔不含預留資料。'));assert.equal(body.includes('預留行項'),false);
  }
  const foreign=await supplier('別的事業擁有者'),outsider=(await h.person('非成員')).session;
  for(const csv of [false,true]) {
    const refused=await consoleGet(a,reportPath(csv),viewer);ok(refused,403);assert.equal(refused.data.code,'capability_denied');privateReply(refused);
    for(const who of [foreign.owner,outsider]){const r=await consoleGet(a,reportPath(csv),who);ok(r,404);assert.equal(r.data.code,'not_found');}
    ok(await consoleGet(a,reportPath(csv),a.owner,closed),404);
    const anonymous=await h.call('GET',a.root+'/supplier-console'+reportPath(csv),undefined,undefined,{},app);ok(anonymous,401);
  }
});

test('SC-API-31 report reservation eligibility matches every read-only owner predicate (AT-04)',async()=>{
  const {a,b,selected}=await reservationJourney();await reserve(b,[{sku:selected.sku,quantity:1}]);
  const unavailable=async()=>{
    for(const csv of [false,true]) {
      const r=await report(a,csv);assert.doesNotMatch(statements[0].text,/commerce_order/);
      if(csv){const text=await csvBody(r);assert.ok(text.includes('本檔不含預留資料'));assert.equal(text.includes('預留行項'),false);}
      else{assert.equal(r.data.reservations.state,'unavailable');assert.equal(r.data.csv_rows,r.data.products.total+r.data.cooperation.partner_count);}
    }
  };
  await h.pool.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1',[a.owner.user.user_id]);
  for(const csv of [false,true]) {
    statements.length=0;const reply=await consoleGet(a,reportPath(csv));ok(reply,403);assert.equal(reply.data.code,'onboarding_required');assert.equal(statements.length,0);
  }
  await h.pool.query('UPDATE users SET onboarding_required=false WHERE user_id=$1',[a.owner.user.user_id]);
  await h.pool.query('UPDATE users SET email=$2 WHERE user_id=$1',[a.owner.user.user_id,`test-${randomUUID()}@example.invalid`]);await unavailable();
  await h.pool.query('UPDATE users SET email=$2 WHERE user_id=$1',[a.owner.user.user_id,a.owner.user.email]);
  const eligibility=allStatements.find(s=>s.startsWith('SELECT 1 FROM users u'));assert.ok(eligibility);
  assert.match(eligibility,/u.active.*u.onboarding_required/s);assert.match(eligibility,/d.capabilities \? 'store:manage'/);
  assert.match(eligibility,/b.binding_id=i.binding_id/);
  // The FK guarantees physical presence. Make the exact binding unreadable to
  // the NOBYPASSRLS role to exercise the missing-row branch without broken FKs.
  await h.pool.query(`CREATE POLICY report_binding_visibility ON deployment_bindings AS RESTRICTIVE FOR SELECT TO ${role}
    USING(instance_id<>'${a.instanceId}'::uuid)`);
  try{await unavailable();}finally{await h.pool.query('DROP POLICY report_binding_visibility ON deployment_bindings');}
  assert.equal((await report(a)).data.reservations.state,'ready');
});

test('SC-API-32 CSV layout, formula defenses, numeric cells and route headers (AT-30,32)',async()=>{
  const {a,b,selected}=await reservationJourney();const order=await reserve(b,[{sku:selected.sku,quantity:2}]);
  const formula='=HYPERLINK("http://example.test","x")',textValues=[formula,'+plus','-minus','@at','\tTab','\rCR'];
  const injections=[];
  for(const [i,title] of textValues.entries())injections.push({title,p:await supplyProduct(a,{...product,title:`測試商品 ${i}`})});
  for(const {title,p} of injections)await h.pool.query('UPDATE commerce_items SET title=$2,sku=$3 WHERE item_id=$1',[p.product_id,title,title]);
  await h.pool.query('UPDATE commerce_shops SET name=$2 WHERE shop_id=$1',[(await profileRow(a)).storefront_shop_id,'@供應 "事業"']);
  await h.pool.query('UPDATE commerce_shops SET name=$2 WHERE shop_id=$1',[(await profileRow(b)).storefront_shop_id,'+合作 "店家"']);
  const r=(await report(a)).data,reply=await report(a,true),body=await csvBody(reply),rows=parseCsv(body);
  const csvAsOf=rows.find(r=>r[0]==='產生時間（UTC）')![1];
  assert.equal(rows.find(r=>r[0]==='產生時間（台灣時間）')![1],new Date(Date.parse(csvAsOf)+8*3600000).toISOString().slice(0,19).replace('T',' '));
  assert.equal(reply.response.headers.get('content-type'),'text/csv; charset=utf-8');
  assert.equal(reply.response.headers.get('content-disposition'),`attachment; filename="supplier-report-${r.period.from}_${r.period.to}.csv"`);
  assert.equal(reply.response.headers.get('cache-control'),'private, no-store');assert.equal(body.endsWith('\r\n'),true);
  assert.equal(rows.find(r=>r[0]==='事業名稱')![1],'\'@供應 "事業"');assert.ok(body.includes('"\'=HYPERLINK(""http://example.test"",""x"")"'));
  for(const value of textValues) {
    const row=section(rows,'商品').find(r=>r[2]==="'"+value);assert.ok(row);assert.equal(row[1],"'"+value);
  }
  assert.equal(section(rows,'合作店家')[0][1],'\'+合作 "店家"');assert.equal(section(rows,'預留行項')[0][6],'\'+合作 "店家"');
  assertSummary(rows,r);
  for(const row of section(rows,'商品'))for(const n of row.slice(6))assert.match(n,/^(0|[1-9][0-9]*)$/);
  for(const row of section(rows,'合作店家'))for(const n of row.slice(2))assert.match(n,/^(0|[1-9][0-9]*)$/);
  for(const row of section(rows,'預留行項'))for(const n of row.slice(11))assert.match(n,/^(0|[1-9][0-9]*)$/);
  assert.equal(r.csv_rows,section(rows,'商品').length+section(rows,'合作店家').length+section(rows,'預留行項').length);
  assert.equal(body.includes(order.buyer.user.email),false);assert.equal(body.includes(order.buyer.user.display_name),false);
  assert.equal(section(rows,'預留行項')[0].length,14);assert.equal(rows.some(row=>row.includes('1200')),false);
  // Exact tags and media types prove Hono does not route report.csv to report.
  const json=await report(a);assert.match(json.response.headers.get('content-type')!,/application\/json/);assert.equal(json.data.profile,'freedom.supplier-console.report/v1');
});

// The same retained-history pattern as expiredCopy, expanded with set-based IDs
// for the volume test. All quote/line/hold constraints and deferred checks run.
async function historicalCopies(source:any,createdAt:string[],terminal=false) {
  const q=await h.pool.connect(),seed=randomUUID();
  const ids=`WITH ids AS (SELECT md5($2::text||n::text||'/order')::uuid AS order_id,
    md5($2::text||n::text||'/quote')::uuid AS quote_id,md5($2::text||n::text||'/client')::uuid AS client_id,
    ($4::timestamptz[])[n] AS created_at FROM generate_series(1,$3::int) n)`;
  const args=[source.order_id,seed,createdAt.length,createdAt];
  try {
    await q.query('BEGIN');
    await q.query(`${ids} INSERT INTO commerce_order_quotes(quote_id,tenant_id,instance_id,public_shop_id,buyer_principal_id,publication_id,
        terms,bindings,terms_sha256,quoted_at,expires_at,quote_profile)
      SELECT ids.quote_id,old.tenant_id,old.instance_id,old.public_shop_id,old.buyer_principal_id,old.publication_id,
        old.terms||jsonb_build_object('quote_id',ids.quote_id::text,
          'quoted_at',to_char(ids.created_at-interval '1 minute','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'expires_at',to_char(ids.created_at+interval '4 minutes','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
        old.bindings,old.terms_sha256,ids.created_at-interval '1 minute',ids.created_at+interval '4 minutes',old.quote_profile
      FROM ids CROSS JOIN commerce_orders o JOIN commerce_order_quotes old ON old.quote_id=o.quote_id WHERE o.order_id=$1`,args);
    await q.query(`${ids} INSERT INTO commerce_orders(order_id,public_shop_id,external_id,request_sha256,currency,total_minor,created_at,expires_at,
        order_profile,quote_id,buyer_principal_id,client_order_id,reservation_state,reservation_version)
      SELECT ids.order_id,o.public_shop_id,'historical-'||ids.order_id::text,o.request_sha256,o.currency,o.total_minor,ids.created_at,
        ids.created_at+interval '30 minutes',o.order_profile,ids.quote_id,o.buyer_principal_id,ids.client_id,'reserved',1
      FROM ids CROSS JOIN commerce_orders o WHERE o.order_id=$1`,args);
    await q.query(`${ids} INSERT INTO commerce_order_lines(order_id,selection_id,transfer_id,item_id,quantity,snapshot,acceptance_id,listing_sha256,order_profile,supplier_shop_id,hosted_offer_id)
      SELECT ids.order_id,l.selection_id,l.transfer_id,l.item_id,l.quantity,l.snapshot,l.acceptance_id,l.listing_sha256,l.order_profile,l.supplier_shop_id,l.hosted_offer_id
      FROM ids CROSS JOIN commerce_order_lines l WHERE l.order_id=$1`,args);
    if(terminal)await q.query(`${ids} UPDATE commerce_orders o SET reservation_state='cancelled',reservation_version=2,
      closed_at=o.created_at+interval '1 minute',close_reason='buyer_cancelled' FROM ids WHERE o.order_id=ids.order_id AND $1::uuid IS NOT NULL`,args);
    await q.query(`${ids} INSERT INTO commerce_inventory_reservations(order_id,item_id,supplier_shop_id,quantity,state,created_at,expires_at,released_at)
      SELECT o.order_id,l.item_id,i.shop_id,sum(l.quantity)::integer,
        CASE WHEN o.reservation_state='reserved' THEN 'held' ELSE 'released' END,o.created_at,o.expires_at,o.closed_at
      FROM ids JOIN commerce_orders o ON o.order_id=ids.order_id JOIN commerce_order_lines l ON l.order_id=o.order_id JOIN commerce_items i ON i.item_id=l.item_id
      WHERE $1::uuid IS NOT NULL GROUP BY o.order_id,l.item_id,i.shop_id`,args);
    if(!terminal)await q.query(`${ids} UPDATE commerce_items i SET reserved=reserved+x.quantity FROM (
      SELECT l.item_id,sum(l.quantity)::int AS quantity FROM ids JOIN commerce_order_lines l ON l.order_id=ids.order_id
      WHERE $1::uuid IS NOT NULL GROUP BY l.item_id) x WHERE i.item_id=x.item_id`,args);
    await q.query('COMMIT');
  }catch(error){await q.query('ROLLBACK');throw error;}finally{q.release();}
}

test('SC-API-33 exactly 10000 CSV data rows succeed and 10001 fail as JSON problems (AT-29,30)',async t=>{
  const started=performance.now(),{a,b,selected}=await reservationJourney(),source=await reserve(b,[{sku:selected.sku,quantity:1}]);
  // One product + one partner + one original line + 9997 copied lines.
  const fixtureStart=performance.now();await historicalCopies(source,Array(9997).fill(source.created_at),true);
  t.diagnostic(`Set-based 9997-row fixture: ${Math.round(performance.now()-fixtureStart)} ms`);
  const r=(await report(a)).data;assert.equal(r.csv_rows,10000);assert.equal(r.reservations.cancelled.lines,9997);
  // Bound database work rather than elapsed time: a bad join can scan all
  // supplier lines once per order and still pass on a fast/quiet machine.
  const snapshot=statements[0],principal=(await h.pool.query('SELECT principal_id FROM principals WHERE user_ref=$1',[a.owner.user.user_id])).rows[0].principal_id;
  const q=await runtime.connect();
  try {
    await q.query('BEGIN');
    await q.query("SELECT set_config('freedom.tenant_id',$1,true),set_config('freedom.principal_id',$2,true)",[a.tenantId,principal]);
    const explained=await q.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+snapshot.text,snapshot.values);
    const plan=explained.rows[0]['QUERY PLAN'][0].Plan,blocks=plan['Shared Hit Blocks']+plan['Shared Read Blocks'];
    t.diagnostic(`10000-row report plan shared buffer accesses: ${blocks}`);
    assert.ok(blocks<1_000_000,`report must avoid quadratic scans: ${blocks} shared buffer accesses`);
  } finally {try{await q.query('ROLLBACK');}finally{q.release();}}
  const rows=parseCsv(await csvBody(await report(a,true)));
  assert.equal(section(rows,'商品').length+section(rows,'合作店家').length+section(rows,'預留行項').length,10000);assertSummary(rows,r);
  await historicalCopies(source,[source.created_at],true);
  for(const csv of [false,true]) {
    statements.length=0;const reply=await consoleGet(a,reportPath(csv));ok(reply,409);privateReply(reply);
    assert.equal(statements.length,1);assert.equal(reply.data.code,'report_too_large');
    assert.equal(reply.data.detail,'這段期間的報表超過 10,000 列，請縮短期間。');
    assert.match(reply.response.headers.get('content-type')!,/application\/json/);assert.equal(reply.response.headers.get('content-disposition'),null);
    assert.equal('products' in reply.data,false);
  }
  t.diagnostic(`10000/10001 boundary case total: ${Math.round(performance.now()-started)} ms`);
});

test('SC-API-34 failed or inconsistent reports never become zero or partial CSV (AT-29)',async()=>{
  const {a,b,selected}=await reservationJourney();await reserve(b,[{sku:selected.sku,quantity:1}]);
  // Database guards prevent corrupt live fixtures. Inject projection failures at
  // the captured statement boundary to exercise fail-closed response handling.
  for(const [corrupt,code] of [
    [()=>{throw new Error('synthetic report query failure');},'internal_error'],
    [(r:any)=>{r.currency_mismatch='1';},'supplier_report_inconsistent'],
    [(r:any)=>{r.reservation_totals[0].quantity='9007199254740992';},'supplier_report_inconsistent'],
    [(r:any)=>{r.reservation_totals[0].supply_total_minor='9007199254740992';},'supplier_report_inconsistent'],
    [(r:any)=>{r.products=Array(201).fill(r.products[0]);},'supplier_product_limit'],
  ] as const) {
    for(const csv of [false,true]) {
      fault=corrupt;const reply=await consoleGet(a,reportPath(csv));ok(reply,500);privateReply(reply);
      assert.match(reply.response.headers.get('content-type')!,/application\/json/);assert.equal(reply.response.headers.get('content-disposition'),null);
      assert.equal('products' in reply.data,false);
      assert.equal(reply.data.code,code);
      fault=undefined;
    }
  }
  for(const corrupt of [(r:any)=>{r.partner_rows=[];},(r:any)=>{r.line_rows=[];}]) {
    fault=corrupt;const reply=await consoleGet(a,reportPath(true));ok(reply,500);assert.equal(reply.data.code,'supplier_report_inconsistent');fault=undefined;
  }
  assert.equal((await report(a)).data.reservations.reserved.lines,1);
});

test('SC-API-35 not-set-up reports preserve the existing refusal on both routes (AT-29)',async()=>{
  const a=await open('尚未設定');
  for(const csv of [false,true]) {
    statements.length=0;const reply=await consoleGet(a,reportPath(csv));ok(reply,409);privateReply(reply);
    assert.equal(reply.data.code,'storefront_not_set_up');assert.equal(statements.length,0);
    assert.match(reply.response.headers.get('content-type')!,/application\/json/);
  }
});

test('SC-API-36 JSON previews 200 partners and CSV includes every partner in read order (AT-30)',async()=>{
  const a=await supplier(),b=await retailer('原合作店'),item=await supplyProduct(a),offered=await offer(a,item),selected=await propose(b,offered);
  const source=(await h.pool.query('SELECT snapshot FROM commerce_selections WHERE selection_id=$1',[selected.selection_id])).rows[0].snapshot;
  // Synthetic archived seller profiles/selections avoid 201 tenant launch HTTP flows.
  // They retain real FKs/triggers; all inserts use only this test's admin pool/schema.
  const fixtures=Array.from({length:201},(_,index)=>{
    const seller_id=randomUUID(),snapshot={...source,seller_shop_id:seller_id};
    return {instance_id:randomUUID(),binding_id:randomUUID(),supply_id:randomUUID(),seller_id,selection_id:randomUUID(),
      name:`合成店 ${String(index).padStart(3,'0')}`,snapshot,hash:digest(snapshot)};
  });
  const data=JSON.stringify(fixtures),shape=`jsonb_to_recordset($1) AS f(instance_id uuid,binding_id uuid,supply_id uuid,seller_id uuid,selection_id uuid,name text,snapshot jsonb,hash text)`;
  const q=await h.pool.connect();
  try {
    await q.query('BEGIN');
    await q.query(`INSERT INTO module_instances(instance_id,tenant_id,module_key,application_release_ref,data_schema_version,contract_ref,status,binding_id,
      created_by_principal_id,origin_guild_key,module_release_ref)
      SELECT f.instance_id,i.tenant_id,i.module_key,i.application_release_ref,i.data_schema_version,i.contract_ref,'archived',f.binding_id,
        i.created_by_principal_id,i.origin_guild_key,i.module_release_ref FROM ${shape} CROSS JOIN module_instances i WHERE i.instance_id=$2`,[data,b.instanceId]);
    await q.query(`INSERT INTO deployment_bindings(binding_id,tenant_id,instance_id,mode,environment,contract_ref,state)
      SELECT f.binding_id,d.tenant_id,f.instance_id,'hosted',d.environment,d.contract_ref,'retired'
      FROM ${shape} CROSS JOIN deployment_bindings d WHERE d.instance_id=$2`,[data,b.instanceId]);
    await q.query(`INSERT INTO commerce_shops(shop_id,community_id,owner_id,kind,origin,mode,accepting_orders,name,description,website_url,contact,currency,manifest_sha256)
      SELECT ids.id,s.community_id,s.owner_id,ids.kind,'hosted','test',false,f.name,'合成測試','','',s.currency,
        replace(ids.id::text,'-','')||replace(ids.id::text,'-','') FROM ${shape}
      CROSS JOIN LATERAL (VALUES(f.supply_id,'internal'),(f.seller_id,'public')) ids(id,kind)
      CROSS JOIN commerce_shops s WHERE s.shop_id=$2`,[data,(await profileRow(b)).storefront_shop_id]);
    await q.query(`INSERT INTO commerce_storefront_profiles(instance_id,tenant_id,supply_shop_id,storefront_shop_id,created_by_principal_id)
      SELECT f.instance_id,p.tenant_id,f.supply_id,f.seller_id,p.created_by_principal_id FROM ${shape}
      CROSS JOIN commerce_storefront_profiles p WHERE p.instance_id=$2`,[data,b.instanceId]);
    await q.query(`INSERT INTO commerce_selections(selection_id,shop_id,item_id,retail_price_minor,sale_terms,snapshot,listing_sha256,hosted_offer_id,hosted_sku)
      SELECT f.selection_id,f.seller_id,l.item_id,l.retail_price_minor,l.sale_terms,f.snapshot,f.hash,l.hosted_offer_id,l.hosted_sku
      FROM ${shape} CROSS JOIN commerce_selections l WHERE l.selection_id=$2`,[data,selected.selection_id]);
    await q.query('COMMIT');
  }catch(error){await q.query('ROLLBACK');throw error;}finally{q.release();}
  const r=(await report(a)).data,list=ok(await consoleGet(a,'/partners'));
  assert.equal(r.cooperation.partner_count,202);assert.equal(r.cooperation.partners.length,200);assert.deepEqual(r.cooperation.partners,list.items);
  const rows=parseCsv(await csvBody(await report(a,true))),all=section(rows,'合作店家');assert.equal(all.length,202);assertSummary(rows,r);
  const expected=(await h.pool.query(`SELECT l.shop_id,s.name FROM commerce_selections l JOIN commerce_shops s ON s.shop_id=l.shop_id
    WHERE l.hosted_offer_id=$1 ORDER BY s.name,l.shop_id`,[offered.offer_id])).rows;
  assert.deepEqual(all.map(row=>row[0]),expected.map(row=>row.shop_id));
  assert.equal(r.csv_rows,section(rows,'商品').length+all.length);assert.deepEqual(section(rows,'預留行項'),[]);
});
