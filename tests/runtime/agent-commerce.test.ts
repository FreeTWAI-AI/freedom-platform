import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createPool,LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal,DEMO_USERS,DEMO_PASSWORD} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {fetchManifest} from '../../modules/agent-commerce/imports.js';
import {parseManifestFile} from '../../modules/agent-commerce/schema.js';

const origin='http://127.0.0.1:4310',url=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_agent_commerce_${process.pid}_${Date.now()}`,admin=createPool(url),pool=new Pool({connectionString:url,options:`-c search_path=${schema}`});
const app=createApp(pool,origin);
type Session={cookie:string;csrf:string};
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{await pool.query('TRUNCATE communities,login_attempts CASCADE');await seedLocal(pool);});
async function req(path:string,body?:unknown,s?:Session,token?:string,key=randomUUID(),extra:Record<string,string>={}){
 const headers:Record<string,string>={...(s?{Cookie:s.cookie,'X-CSRF-Token':s.csrf,Origin:origin}:{}),...(token?{Authorization:`Bearer ${token}`}:{})};
 if(body!==undefined){headers['Content-Type']='application/json';headers['Idempotency-Key']=key;}
 Object.assign(headers,extra);
 const response=await app.request(origin+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
 return {status:response.status,data:await response.json() as any,response};
}
async function login(index=0):Promise<Session>{const r=await req('/api/v1/auth/login',{email:DEMO_USERS[index].email,password:DEMO_PASSWORD},undefined,undefined,randomUUID(),{Origin:origin});assert.equal(r.status,200);return {cookie:r.response.headers.get('set-cookie')!.split(';')[0],csrf:r.data.csrf_token};}
const internal=()=>({schema:'freedom-shop/v1',kind:'internal',access:'authenticated',name:'合成內部商店',description:'僅用於測試',website_url:'https://private.example.com',contact:'synthetic contact',currency:'TWD',products:[{sku:'TEA',title:'合成茶葉',description:'150g',photo_url:null,price_minor:30000,shipping_minor:6000,stock:5,shipping_terms:'每件運費 60 元',return_terms:'測試退貨條件'}]});
async function importOne(s:Session,manifest:any){const r=await req('/api/v1/commerce/import',{manifest,confirmed:true},s);assert.equal(r.status,201,JSON.stringify(r.data));return r.data.shop_id;}
async function keyFor(s:Session,id:string){const r=await req(`/api/v1/commerce/shops/${id}/key`,{},s);assert.equal(r.status,200,JSON.stringify(r.data));return r.data.token;}
async function setup(){
 const supplier=await login(),seller=await login(2),other=await login(1),internalId=await importOne(supplier,internal()),internalKey=await keyFor(supplier,internalId);
 const items=(await req('/api/v1/commerce/catalog',undefined,seller)).data.items;
 const manifest={schema:'freedom-shop/v1',kind:'public',name:'合成公開店',description:'測試',website_url:'https://public.example.com',contact:'合成客服',currency:'TWD',selections:items.map((i:any)=>({item_id:i.item_id,retail_price_minor:50000,sale_terms:'含運費售價'}))};
 const publicId=await importOne(seller,manifest),publicKey=await keyFor(seller,publicId),connection=await req('/shop-api/v1/connection',undefined,undefined,publicKey);assert.equal(connection.status,200,JSON.stringify(connection.data));const selection=connection.data.selections[0];
 return {supplier,seller,other,internalId,internalKey,publicId,publicKey,selection,items,manifest};
}
const paid=(amount=50000,overrides:any={})=>({event_id:randomUUID(),type:'paid',provider:'synthetic',transaction_ref:randomUUID(),amount_minor:amount,currency:'TWD',mode:'test',verification:'provider_verified_by_merchant',...overrides});
async function order(f:Awaited<ReturnType<typeof setup>>,quantity=1){const body={external_id:randomUUID(),items:[{selection_id:f.selection.selection_id,quantity,delivery_ref:'synthetic_delivery_ref'}]};const r=await req('/shop-api/v1/orders',body,undefined,f.publicKey);assert.equal(r.status,201,JSON.stringify(r.data));return {o:r.data,body};}

test('manifest preview, atomic import, duplicate import and private/public separation',async()=>{
 const s=await login(),m=internal();const preview=await req('/api/v1/commerce/preview',{content:JSON.stringify(m)},s);assert.equal(preview.status,200);assert.equal(preview.data.count,1);
 assert.equal((await pool.query('SELECT count(*) FROM commerce_shops')).rows[0].count,'0');
 assert.equal((await req('/api/v1/commerce/import',{manifest:m,confirmed:false},s)).status,422);
 const id=await importOne(s,m);assert.equal(await importOne(s,m),id);
 assert.equal((await req(`/api/v1/public-shops/${id}`)).status,404);
 assert.equal((await req('/api/v1/commerce/catalog')).status,401);
 const catalog=(await req('/api/v1/commerce/catalog',undefined,s)).data.items;assert.equal(catalog.length,1);assert.equal(catalog[0].website_url,undefined);
 assert.equal((await req('/api/v1/commerce/preview',{content:JSON.stringify({...m,secret:'forbidden'})},s)).status,422);
});

test('downloaded kits include exact data, payment application, private access, protocol and no secrets',async()=>{
 const f=await setup();
 for(const kind of ['internal','public']){
  const r=await req('/api/v1/commerce/agent-kit',{kind,item_ids:kind==='public'?[f.items[0].item_id]:[]},f.seller);
  assert.equal(r.status,200);for(const word of ['金流','身分','銀行','環境變數','provider_verified_by_merchant','delivery_ref','不追蹤','freedom-shop/v1'])assert.ok(r.data.markdown.includes(word),word);
  assert.ok(!r.data.markdown.includes(f.internalKey));assert.ok(!r.data.markdown.includes(f.publicKey));
  if(kind==='public')assert.ok(r.data.markdown.includes(f.items[0].item_id));
 }
 assert.equal((await req('/api/v1/commerce/agent-kit',{kind:'public',item_ids:[randomUUID()]},f.seller)).status,422);
});

test('two merchant payments relay once, scoped payment link and human shipment survive readback',async()=>{
 const f=await setup(),{o,body}=await order(f),id=o.order_id,t=o.transfers[0],receipt=paid();
 assert.equal(o.total_minor,'50000');assert.equal(t.total_minor,'36000');
 assert.equal((await req('/shop-api/v1/orders',undefined,undefined,f.internalKey)).data.items.length,0);
 assert.equal((await req(`/shop-api/v1/orders/${id}/transfers/${t.transfer_id}/payment`,paid(36000),undefined,f.internalKey)).status,409);
 const result=await req(`/shop-api/v1/orders/${id}/payment`,receipt,undefined,f.publicKey);assert.equal(result.status,200,JSON.stringify(result.data));
 assert.equal((await req('/shop-api/v1/orders',body,undefined,f.publicKey)).data.order_id,id);
 assert.equal((await req(`/shop-api/v1/orders/${id}/payment`,receipt,undefined,f.publicKey)).status,200);
 assert.equal((await req(`/shop-api/v1/orders/${id}/payment`,{...receipt,amount_minor:49999},undefined,f.publicKey)).status,422);
 const inbox=(await req('/shop-api/v1/orders',undefined,undefined,f.internalKey)).data.items;assert.equal(inbox.length,1);assert.equal(inbox[0].total_minor,undefined);assert.equal(inbox[0].public_shop_id,f.publicId);assert.equal(inbox[0].public_website_url,'https://public.example.com');assert.equal(inbox[0].transfers[0].lines[0].snapshot.sku,'TEA');assert.equal(inbox[0].transfers[0].lines[0].snapshot.retail_price_minor,undefined);
 assert.equal((await req(`/shop-api/v1/transfers/${t.transfer_id}/payment-link`,{url:'https://evil.example.com/pay'},undefined,f.internalKey)).status,422);
 assert.equal((await req(`/shop-api/v1/transfers/${t.transfer_id}/payment-link`,{url:'https://private.example.com/pay/order1'},undefined,f.internalKey)).status,200);
 const shipment={method:'carrier',carrier:'合成物流',tracking_number:'SYNTHETIC-1',shipped_at:new Date(Date.now()-60000).toISOString()};
 assert.equal((await req(`/api/v1/commerce/transfers/${t.transfer_id}/shipment`,shipment,f.supplier)).status,409);
 assert.equal((await req(`/shop-api/v1/orders/${id}/transfers/${t.transfer_id}/payment`,paid(36000),undefined,f.internalKey)).status,200);
 assert.equal((await req(`/api/v1/commerce/transfers/${t.transfer_id}/shipment`,shipment,f.seller)).status,404);
 assert.equal((await req(`/api/v1/commerce/transfers/${t.transfer_id}/shipment`,shipment,f.supplier)).status,200);
 const read=(await req(`/shop-api/v1/orders/${id}`,undefined,undefined,f.publicKey)).data;
 assert.equal(read.transfers[0].shipment.source,'shipper_entered');assert.equal(read.platform_bank_verified,false);
 assert.equal((await pool.query('SELECT count(*) FROM commerce_payment_events')).rows[0].count,'2');
});

test('stock reservation is serialized; cancelled and expired unpaid orders release stock',async()=>{
 const f=await setup();const create=()=>req('/shop-api/v1/orders',{external_id:randomUUID(),items:[{selection_id:f.selection.selection_id,quantity:4,delivery_ref:'synthetic_delivery_ref'}]},undefined,f.publicKey);
 const results=await Promise.all([create(),create()]);assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);const id=results.find(r=>r.status===201)!.data.order_id;
 assert.equal((await req(`/shop-api/v1/orders/${id}/cancel`,{},undefined,f.publicKey)).status,200);
 assert.equal((await req(`/shop-api/v1/orders/${id}/cancel`,{},undefined,f.publicKey)).status,200);
 const next=await order(f,5);await pool.query("UPDATE commerce_orders SET expires_at=now()-interval '1 second' WHERE order_id=$1",[next.o.order_id]);
 assert.equal((await req(`/shop-api/v1/orders/${next.o.order_id}/payment`,paid(250000),undefined,f.publicKey)).status,409);
 assert.equal((await create()).status,201);
});

test('wrong merchant, amount, origin, key revocation and replay cannot claim someone else payment',async()=>{
 const f=await setup(),{o}=await order(f),id=o.order_id;
 assert.equal((await req(`/api/v1/commerce/shops/${f.publicId}/key`,{},f.other)).status,404);
 assert.equal((await req(`/shop-api/v1/orders/${id}/payment`,paid(),undefined,f.internalKey)).status,404);
 assert.equal((await req(`/shop-api/v1/orders/${id}/payment`,paid(1),undefined,f.publicKey)).status,422);
 assert.equal((await req(`/shop-api/v1/orders/${id}/payment`,paid(),undefined,f.publicKey,randomUUID(),{Origin:'https://evil.example.com'})).status,403);
 assert.equal((await req(`/shop-api/v1/orders/${id}/payment`,paid(),f.seller)).status,401);
 assert.equal((await req(`/api/v1/commerce/shops/${f.publicId}/revoke-key`,{},f.seller)).status,200);
 assert.equal((await req('/shop-api/v1/orders',undefined,undefined,f.publicKey)).status,401);
 const receipts=JSON.stringify((await pool.query('SELECT response FROM command_receipts')).rows);assert.ok(!receipts.includes(f.publicKey));
});

test('refund records are distinct, cannot revive payment or falsely enable shipment',async()=>{
 const f=await setup(),{o}=await order(f),r=paid(),cost=paid(36000),path=`/shop-api/v1/orders/${o.order_id}`,t=o.transfers[0];
 await req(path+'/payment',r,undefined,f.publicKey);
 await req(`${path}/transfers/${t.transfer_id}/payment`,cost,undefined,f.internalKey);
 assert.equal((await req(path+'/payment',{...r,event_id:randomUUID(),type:'refunded'},undefined,f.publicKey)).status,200);
 let read=(await req(path,undefined,undefined,f.publicKey)).data;assert.equal(read.transfers[0].payment_state,'reported_paid');
 assert.equal((await req(path+'/payment',paid(),undefined,f.publicKey)).status,409);
 assert.equal((await req(`/api/v1/commerce/transfers/${t.transfer_id}/shipment`,{method:'pickup',carrier:'',tracking_number:'',shipped_at:new Date().toISOString()},f.supplier)).status,409);
 assert.equal((await req(`${path}/transfers/${t.transfer_id}/payment`,{...cost,event_id:randomUUID(),type:'refunded'},undefined,f.internalKey)).status,200);
 read=(await req(path,undefined,undefined,f.publicKey)).data;assert.equal(read.transfers[0].payment_state,'reported_refunded');
});

test('two internal shops get only their own transfer; source customer data is an opaque reference',async()=>{
 const f=await setup(),m={...internal(),name:'第二家',website_url:'https://second.example.com'},second=await importOne(f.other,m),secondKey=await keyFor(f.other,second);
 const items=(await req('/api/v1/commerce/catalog',undefined,f.seller)).data.items;
 const sid=await importOne(f.seller,{...f.manifest,name:'多店商城',selections:items.map((i:any)=>({item_id:i.item_id,retail_price_minor:50000,sale_terms:'合成'}))}),key=await keyFor(f.seller,sid);
 const selections=(await req('/shop-api/v1/connection',undefined,undefined,key)).data.selections;
 const order=(await req('/shop-api/v1/orders',{external_id:'multi-order',items:selections.map((s:any)=>({selection_id:s.selection_id,quantity:1,delivery_ref:'recipient_reference_'+s.item_id.replaceAll('-','')}))},undefined,key)).data;
 assert.equal(order.transfers.length,2);await req(`/shop-api/v1/orders/${order.order_id}/payment`,paid(100000),undefined,key);
 const inbox=(await req('/shop-api/v1/orders',undefined,undefined,secondKey)).data.items[0];assert.equal(inbox.transfers.length,1);assert.equal(inbox.transfers[0].internal_shop_id,second);
 const foreign=order.transfers.find((t:any)=>t.internal_shop_id!==second);
 assert.equal((await req(`/shop-api/v1/orders/${order.order_id}/transfers/${foreign.transfer_id}/payment`,paid(36000),undefined,secondKey)).status,404);
});

test('manifest URL reader rejects unsafe hosts and oversize data without following redirects',async()=>{
 let calls=0;const mock:typeof fetch=async(_u,init)=>{calls++;assert.equal(init?.redirect,'manual');return new Response(JSON.stringify(internal()));};
 for(const url of ['http://raw.githubusercontent.com/a/b/main/shop.json','https://127.0.0.1/shop.json','https://raw.githubusercontent.com.evil.example/a/b/main/shop.json','https://raw.githubusercontent.com/a/b/main/shop.json?token=secret'])await assert.rejects(fetchManifest(url,mock));
 assert.equal(calls,0);
 assert.equal((await fetchManifest('https://raw.githubusercontent.com/a/b/main/shop.json',mock)).kind,'internal');
 await assert.rejects(fetchManifest('https://raw.githubusercontent.com/a/b/main/shop.json',async()=>new Response('x'.repeat(24001))));
 await assert.rejects(fetchManifest('https://raw.githubusercontent.com/a/b/main/shop.json',async()=>new Response(null,{status:302,headers:{Location:'http://127.0.0.1/private'}})));
 assert.equal(parseManifestFile('目錄\n```json\n'+JSON.stringify(internal())+'\n```').kind,'internal');
 assert.throws(()=>parseManifestFile('```json\n{}\n```\n```json\n{}\n```'));
});

test('test/live reports cannot mix; paused shops stop new orders but can finish paid ones',async()=>{
 const f=await setup(),{o}=await order(f);
 assert.equal((await req(`/shop-api/v1/orders/${o.order_id}/payment`,paid(50000,{mode:'live'}),undefined,f.publicKey)).status,422);
 assert.equal((await req(`/api/v1/commerce/shops/${f.internalId}/accepting-orders`,{accepting:false},f.supplier)).status,200);
 assert.equal((await req('/api/v1/commerce/catalog',undefined,f.seller)).data.items.length,0);
 const newOrder=await req('/shop-api/v1/orders',{external_id:randomUUID(),items:[{selection_id:f.selection.selection_id,quantity:1,delivery_ref:'synthetic_delivery_ref'}]},undefined,f.publicKey);assert.equal(newOrder.status,404);
 assert.equal((await req(`/shop-api/v1/orders/${o.order_id}/payment`,paid(),undefined,f.publicKey)).status,200);
 assert.equal((await req(`/shop-api/v1/orders/${o.order_id}/transfers/${o.transfers[0].transfer_id}/payment`,paid(36000),undefined,f.internalKey)).status,200);
});

test('new import cannot reference a foreign community or partially insert invalid selections',async()=>{
 const f=await setup();const baseline=(await pool.query('SELECT count(*) FROM commerce_shops')).rows[0].count;
 assert.equal((await req('/api/v1/commerce/import',{manifest:{...f.manifest,name:'bad',selections:[...f.manifest.selections,{item_id:randomUUID(),retail_price_minor:20000,sale_terms:'invalid'}]},confirmed:true},f.seller)).status,422);
 assert.equal((await pool.query('SELECT count(*) FROM commerce_shops')).rows[0].count,baseline);
 const foreign=randomUUID();await pool.query('INSERT INTO communities VALUES($1,$2)',[foreign,'合成他社群']);await pool.query('UPDATE commerce_shops SET community_id=$2 WHERE shop_id=$1',[f.internalId,foreign]);
 assert.equal((await req('/api/v1/commerce/preview',{content:JSON.stringify({...f.manifest,name:'cross'})},f.seller)).status,422);
});

test('raw key is shown once, rotated keys and disabled owners are rejected',async()=>{
 const f=await setup(),key=randomUUID(),path=`/api/v1/commerce/shops/${f.publicId}/key`;
 const issued=await req(path,{},f.seller,undefined,key),replay=await req(path,{},f.seller,undefined,key);
 assert.match(issued.data.token,/^fw_shop_/);assert.equal(replay.data.token,null);
 assert.equal((await req('/shop-api/v1/connection',undefined,undefined,f.publicKey)).status,401);
 assert.equal((await req('/shop-api/v1/connection',undefined,undefined,issued.data.token)).status,200);
 await pool.query('UPDATE users SET active=false WHERE user_id=(SELECT owner_id FROM commerce_shops WHERE shop_id=$1)',[f.publicId]);
 assert.equal((await req('/shop-api/v1/connection',undefined,undefined,issued.data.token)).status,401);
});

test('an order queued behind a pause observes the committed accepting-orders state',async()=>{
 const f=await setup(),blocker=await pool.connect();
 const community=(await pool.query('SELECT community_id FROM commerce_shops WHERE shop_id=$1',[f.publicId])).rows[0].community_id;
 let pending:ReturnType<typeof req>|undefined;
 try{
  await blocker.query('BEGIN');
  await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`commerce-orders/${community}`]);
  pending=req('/shop-api/v1/orders',{external_id:randomUUID(),items:[{selection_id:f.selection.selection_id,quantity:1,delivery_ref:'synthetic_delivery_ref'}]},undefined,f.publicKey);
  let waiting=false;
  for(let n=0;n<100;n++){
   const r=await blocker.query("SELECT 1 FROM pg_locks w JOIN pg_locks h ON w.locktype=h.locktype AND w.database IS NOT DISTINCT FROM h.database AND w.classid=h.classid AND w.objid=h.objid AND w.objsubid=h.objsubid WHERE h.pid=pg_backend_pid() AND h.granted AND NOT w.granted AND w.locktype='advisory'");
   if(r.rowCount){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(waiting,true,'order must have authenticated and be queued behind this community lock');
  await blocker.query('UPDATE commerce_shops SET accepting_orders=false WHERE shop_id=$1',[f.publicId]);
  await blocker.query('COMMIT');
  assert.equal((await pending).status,409);
  assert.equal((await pool.query('SELECT count(*) FROM commerce_orders')).rows[0].count,'0');
 }finally{await blocker.query('ROLLBACK');blocker.release();await pending;}
});
