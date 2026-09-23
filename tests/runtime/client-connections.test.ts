import { test,before,after,beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool,LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal,DEMO_USERS,DEMO_PASSWORD } from '../../packages/testing/seed.js';
import { tokenHash } from '../../modules/identity-membership/service.js';
import { createApp } from '../../apps/platform-api/src/app.js';

const origin='http://127.0.0.1:4310',databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_client_connection_test_${process.pid}_${Date.now()}`,admin=createPool(databaseUrl);
const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:12});
const app=createApp(pool,origin);
type Session={cookie:string;csrf:string;user:any};
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits,client_pairing_requests CASCADE');await seedLocal(pool);});
async function request(path:string,session?:Session,body?:unknown,version?:number|string,key:string=randomUUID(),extra:Record<string,string>={}) {
 const headers:Record<string,string>={Origin:origin,...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{}),...extra};
 if(body!==undefined){headers['Content-Type']='application/json';headers['Idempotency-Key']=key;if(version)headers['If-Match']=`"${version}"`;}
 const response=await app.request(origin+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
 return {status:response.status,data:await response.json() as any,response};
}
const api=(path:string,session?:Session,body?:unknown,version?:number|string,key?:string)=>request('/api/v1'+path,session,body,version,key);
async function signIn(email=DEMO_USERS[0].email):Promise<Session>{const r=await api('/auth/login',undefined,{email,password:DEMO_PASSWORD});assert.equal(r.status,200,JSON.stringify(r.data));return {cookie:r.response.headers.get('set-cookie')!.split(';')[0],csrf:r.data.csrf_token,user:r.data.user};}
async function ready(email=DEMO_USERS[0].email){const member=await signIn(email);await pool.query('UPDATE users SET onboarding_completed_at=now() WHERE user_id=$1',[member.user.user_id]);return member;}
async function start(kind='storefront'){const r=await api('/client-connections/start',undefined,{kind,client_name:'我的 Fork 客戶端'});assert.equal(r.status,201,JSON.stringify(r.data));return r.data;}
async function store(member:Session,name='第一家店'){const r=await api('/retail/stores',member,{name,description:'測試選品商店',support_contact:'店內客服'});assert.equal(r.status,201,JSON.stringify(r.data));return r.data;}
const productBody={title:'茶葉',photo_url:null,specifications:'100g',net_price_minor:12000,currency:'TWD',availability:'finite',stock:20,shipping_terms:'確認後出貨',return_terms:'依商家協議'};
async function product(member:Session){const r=await api('/supplier/products',member,productBody);assert.equal(r.status,201,JSON.stringify(r.data));return r.data;}
async function listing(member:Session,storeId:string,offerId:string){const r=await api('/retail/listings',member,{store_id:storeId,offer_version_id:offerId,retail_price_minor:16000,sale_terms:'先確認供貨'});assert.equal(r.status,201,JSON.stringify(r.data));return r.data;}
async function connect(member:Session,kind:'storefront'|'supplier',storeId?:string){const pairing=await start(kind);const approved=await api(`/client-connections/${pairing.user_code}/approve`,member,{confirmed:true,...(storeId?{store_id:storeId}:{})});assert.equal(approved.status,200,JSON.stringify(approved.data));const issued=await api('/client-connections/poll',undefined,{device_secret:pairing.device_secret});assert.equal(issued.status,200,JSON.stringify(issued.data));assert.equal(issued.data.status,'authorized');return {...issued.data,pairing};}
const client=(path:string,token:string,body?:unknown)=>request('/client-api/v1'+path,undefined,body,undefined,undefined,{Authorization:'Bearer '+token});

test('pairing stores only hashes, requires explicit approval after onboarding, throttles polls and issues token once',async()=>{
 const member=await signIn(),ownStore=await store(member),pairing=await start();
 assert.equal(pairing.expires_in,300);assert.match(pairing.user_code,/^[A-F0-9]{5}(-[A-F0-9]{5}){3}$/);assert.equal(pairing.scope,'storefront:read');
 const saved=(await pool.query('SELECT * FROM client_pairing_requests')).rows[0];assert.equal(saved.device_secret_hash,tokenHash(pairing.device_secret));assert.equal(JSON.stringify(saved).includes(pairing.device_secret),false);assert.equal(JSON.stringify(saved).includes(pairing.user_code),false);
 assert.equal((await api(`/client-connections/${pairing.user_code}/approve`,undefined,{confirmed:true,store_id:ownStore.store_id})).status,401);
 assert.equal((await api(`/client-connections/${pairing.user_code}/approve`,member,{confirmed:true,store_id:ownStore.store_id})).status,403);
 const waiting=await api('/client-connections/poll',undefined,{device_secret:pairing.device_secret});assert.equal(waiting.data.status,'authorization_pending');
 assert.equal((await api('/client-connections/poll',undefined,{device_secret:pairing.device_secret})).status,429);
 await pool.query('UPDATE users SET onboarding_completed_at=now() WHERE user_id=$1',[member.user.user_id]);
 const preview=await api(`/client-connections/${pairing.user_code}`,member);assert.equal(preview.data.client_name,'我的 Fork 客戶端');assert.equal(preview.data.read_only,true);assert.equal('device_secret' in preview.data,false);
 const key=randomUUID(),approval={confirmed:true,store_id:ownStore.store_id};
 const approved=await api(`/client-connections/${pairing.user_code}/approve`,member,approval,undefined,key);assert.equal(approved.status,200,JSON.stringify(approved.data));
 assert.deepEqual((await api(`/client-connections/${pairing.user_code}/approve`,member,approval,undefined,key)).data,approved.data);
 await pool.query('UPDATE client_pairing_requests SET last_polled_at=NULL');
 const issued=await api('/client-connections/poll',undefined,{device_secret:pairing.device_secret});assert.equal(issued.data.status,'authorized');assert.match(issued.data.access_token,/^fw_read_[A-Za-z0-9_-]{43}$/);
 const connection=(await pool.query('SELECT * FROM member_client_connections')).rows[0];assert.equal(connection.token_hash,tokenHash(issued.data.access_token));assert.equal(JSON.stringify(connection).includes(issued.data.access_token),false);
 assert.equal((await api('/client-connections/poll',undefined,{device_secret:pairing.device_secret})).data.status,'invalid_grant');
 const list=(await api('/me/client-connections',member)).data.items;assert.equal(list.length,1);assert.equal('token_hash' in list[0],false);assert.equal('access_token' in list[0],false);
});

test('storefront bearer sees catalog and only approved store/listings; cannot write, reach private members or authenticate browser',async()=>{
 const seller=await ready(DEMO_USERS[1].email),supplier=await ready(),ownStore=await store(seller),otherStore=await store(seller,'第二家店'),source=await product(supplier);
 const ownListing=await listing(seller,ownStore.store_id,source.current_offer.offer_version_id);await listing(seller,otherStore.store_id,source.current_offer.offer_version_id);
 const connected=await connect(seller,'storefront',ownStore.store_id),token=connected.access_token;
 assert.equal((await client('/retail/catalog',token)).data.items.length,1);
 assert.deepEqual((await client('/retail/stores',token)).data.items.map((s:any)=>s.store_id),[ownStore.store_id]);
 assert.deepEqual((await client('/retail/listings',token)).data.items.map((l:any)=>l.listing_id),[ownListing.listing_id]);
 assert.equal((await client('/retail/stores/'+otherStore.store_id,token)).status,404);
 assert.equal((await client('/retail/listings?store_id='+otherStore.store_id,token)).status,422);
 assert.equal((await client('/supplier/products',token)).status,403);assert.equal((await client('/supplier/requests',token)).status,403);
 assert.equal((await client('/members',token)).status,404);assert.equal((await client('/work-items',token)).status,404);
 assert.equal((await client('/retail/listings',token,{})).status,405);
 assert.equal((await request('/api/v1/session',undefined,undefined,undefined,undefined,{Authorization:'Bearer '+token})).status,401);
 assert.equal((await request('/api/v1/session',undefined,undefined,undefined,undefined,{Cookie:'freedom_local_session='+token})).status,401);
 assert.equal((await request('/client-api/v1/retail/stores',seller)).status,401);
});

test('supplier bearer is restricted to own products and requests, not other suppliers or retailer data',async()=>{
 const supplier=await ready(),other=await ready(DEMO_USERS[1].email),buyer=await ready(DEMO_USERS[2].email);
 const a=await product(supplier),b=await product(other),retail=await store(buyer);
 const one=await listing(buyer,retail.store_id,a.current_offer.offer_version_id),two=await listing(buyer,retail.store_id,b.current_offer.offer_version_id);
 for(const item of [one,two])assert.equal((await api(`/retail/listings/${item.listing_id}:request-supply`,buyer,{snapshot_sha256:item.snapshot_sha256},item.aggregate_version)).status,200);
 const connected=await connect(supplier,'supplier');
 assert.deepEqual((await client('/supplier/products',connected.access_token)).data.items.map((p:any)=>p.product_id),[a.product_id]);
 assert.deepEqual((await client('/supplier/requests',connected.access_token)).data.items.map((r:any)=>r.listing_id),[one.listing_id]);
 assert.equal((await client('/retail/catalog',connected.access_token)).status,403);assert.equal((await client('/retail/stores',connected.access_token)).status,403);
 const pending=await start('supplier');assert.equal((await api(`/client-connections/${pending.user_code}/approve`,supplier,{confirmed:true,store_id:retail.store_id})).status,422);
});

test('approval binds to current owner and revocation immediately denies reads and pending token issuance',async()=>{
 const owner=await ready(),outsider=await ready(DEMO_USERS[1].email),mine=await store(owner),theirs=await store(outsider),pending=await start();
 assert.equal((await api(`/client-connections/${pending.user_code}/approve`,owner,{confirmed:true,store_id:theirs.store_id})).status,404);
 const connected=await connect(owner,'storefront',mine.store_id),own=(await api('/me/client-connections',owner)).data.items[0];
 assert.equal((await api('/me/client-connections',outsider)).data.items.length,0);
 assert.equal((await api(`/me/client-connections/${connected.connection_id}/revoke`,outsider,{},own.aggregate_version)).status,404);
 assert.equal((await api(`/me/client-connections/${connected.connection_id}/revoke`,owner,{})).status,428);
 assert.equal((await api(`/me/client-connections/${connected.connection_id}/revoke`,owner,{},own.aggregate_version)).status,200);
 assert.equal((await client('/connection',connected.access_token)).status,401);
 const approved=await api(`/client-connections/${pending.user_code}/approve`,owner,{confirmed:true,store_id:mine.store_id});assert.equal(approved.status,200);
 assert.equal((await api(`/me/client-connections/${approved.data.connection_id}/revoke`,owner,{},1)).status,200);
 assert.equal((await api('/client-connections/poll',undefined,{device_secret:pending.device_secret})).data.status,'invalid_grant');
});

test('expired device requests/tokens, inactive members and incomplete onboarding invalidate connections',async()=>{
 const member=await ready(),pending=await start('supplier');await pool.query("UPDATE client_pairing_requests SET expires_at=now()-interval '1 second'");
 assert.equal((await api(`/client-connections/${pending.user_code}`,member)).status,404);assert.equal((await api('/client-connections/poll',undefined,{device_secret:pending.device_secret})).data.status,'invalid_grant');
 const connected=await connect(member,'supplier');await pool.query("UPDATE member_client_connections SET expires_at=now()-interval '1 second' WHERE connection_id=$1",[connected.connection_id]);
 assert.equal((await client('/supplier/products',connected.access_token)).status,401);
 const active=await connect(member,'supplier');await pool.query('UPDATE users SET active=false WHERE user_id=$1',[member.user.user_id]);assert.equal((await client('/supplier/products',active.access_token)).status,401);
 await pool.query('UPDATE users SET active=true,onboarding_completed_at=NULL WHERE user_id=$1',[member.user.user_id]);assert.equal((await client('/supplier/products',active.access_token)).status,401);
});

test('start uses durable rate budgets and concurrent secret exchange returns exactly one credential',async()=>{
 const member=await ready(),pending=await start('supplier');await api(`/client-connections/${pending.user_code}/approve`,member,{confirmed:true});
 const results=await Promise.all([api('/client-connections/poll',undefined,{device_secret:pending.device_secret}),api('/client-connections/poll',undefined,{device_secret:pending.device_secret})]);
 assert.equal(results.filter(r=>r.data.status==='authorized').length,1);assert.equal(results.filter(r=>r.data.status==='invalid_grant').length,1);
 for(let i=0;i<9;i++)assert.equal((await api('/client-connections/start',undefined,{kind:'supplier',client_name:'測試節流'})).status,201);
 assert.equal((await api('/client-connections/start',undefined,{kind:'supplier',client_name:'第十一個要求'})).status,429);
});

test('forked Node read helper completes a real HTTP pairing and reads scoped PostgreSQL rows without browser credentials',async()=>{
 const {serve}=await import('@hono/node-server'),{once}=await import('node:events');
 const helperPath='../../packages/client-connections/read-client.mjs';
 const {startPairing,pollPairing,ScopedReadClient}=await import(helperPath);
 const member=await ready(),ownStore=await store(member),source=await product(member);await listing(member,ownStore.store_id,source.current_offer.offer_version_id);
 let liveApp:ReturnType<typeof createApp>;
 const server=serve({fetch:request=>liveApp.fetch(request),hostname:'127.0.0.1',port:0});
 try{
   if(!server.listening)await once(server,'listening');const address=server.address();assert(address&&typeof address!=='string');const liveOrigin=`http://127.0.0.1:${address.port}`;liveApp=createApp(pool,liveOrigin);
   const seen:string[]=[];
   const fetcher:typeof fetch=async(input,init)=>{
     assert.equal(init?.redirect,'error');const headers=new Headers(init?.headers);assert.equal(headers.has('Cookie'),false);
     seen.push(new URL(String(input)).pathname);return fetch(input,init);
   };
   const pairing=await startPairing({origin:liveOrigin,kind:'storefront',clientName:'真正 HTTP Fork 客戶端',fetcher});
   assert.equal(pairing.verification_uri,liveOrigin+'/#account');
   const approval=await fetch(liveOrigin+'/api/v1/client-connections/'+pairing.user_code+'/approve',{method:'POST',headers:{Origin:liveOrigin,'Content-Type':'application/json',Cookie:member.cookie,'X-CSRF-Token':member.csrf,'Idempotency-Key':randomUUID()},body:JSON.stringify({confirmed:true,store_id:ownStore.store_id})});
   assert.equal(approval.status,200);
   const issued=await pollPairing({origin:liveOrigin,deviceSecret:pairing.device_secret,fetcher});assert.equal(issued.status,'authorized');
   const client=new ScopedReadClient({origin:liveOrigin,token:issued.access_token,fetcher});
   assert.deepEqual((await client.read('stores')).items.map((row:any)=>row.store_id),[ownStore.store_id]);
   assert.equal((await client.read('listings')).items.length,1);assert.equal((await client.read('catalog')).items[0].product_id,source.product_id);
   await assert.rejects(client.read('products'),{status:403});
   await assert.rejects(client.read('constructor'),/Unsupported read resource/);
   assert.ok(seen.includes('/api/v1/client-connections/start'));assert.ok(seen.includes('/client-api/v1/retail/listings'));
   const revoke=await fetch(liveOrigin+'/api/v1/me/client-connections/'+issued.connection_id+'/revoke',{method:'POST',headers:{Origin:liveOrigin,'Content-Type':'application/json',Cookie:member.cookie,'X-CSRF-Token':member.csrf,'Idempotency-Key':randomUUID(),'If-Match':'"1"'},body:'{}'});
   assert.equal(revoke.status,200);await assert.rejects(client.read('stores'),{status:401});
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
