import { test,before,after,beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay,setImmediate } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import { createPool,LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal,DEMO_USERS,DEMO_PASSWORD,DEMO_COMMUNITY } from '../../packages/testing/seed.js';
import { login, tokenHash } from '../../modules/identity-membership/service.js';
import { approveClientPairing, pollClientPairing, readClientResource,pairingView } from '../../modules/client-connections/service.js';
import { Problem } from '../../packages/shared/problem.js';
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

test('bearer auth scheme casing and SP are flexible but opaque credential casing is not',async()=>{
 const member=await ready(),created=await product(member),issued=await connect(member,'supplier');
 // A deterministic mixed-case credential isolates token identity from scheme syntax.
 const token='fw_read_'+ 'Ab'.repeat(21)+'C',path='/client-api/v1/supplier/products';
 await pool.query('UPDATE member_client_connections SET token_hash=$2 WHERE connection_id=$1',[issued.connection_id,tokenHash(token)]);
 const authorized=await request(path,undefined,undefined,undefined,undefined,{Authorization:'bEaReR   '+token});
 assert.equal(authorized.status,200,JSON.stringify(authorized.data));
 assert.ok(authorized.data.items.some((item:{product_id:string})=>item.product_id===created.product_id));
 const folded=await request(path,undefined,undefined,undefined,undefined,{Authorization:'bEaReR   '+'fw_read_'+token.slice(8).toLowerCase()});
 assert.equal(folded.status,401);assert.equal(folded.data.code,'client_token_invalid');
 const tab=await request(path,undefined,undefined,undefined,undefined,{Authorization:'Bearer\t'+token});
 assert.equal(tab.status,401);assert.equal(tab.data.code,'client_token_invalid');
});

test('pairing review refreshes the member session after its pending-code query wait',async()=>{
 const member=await ready(),pairing=await start('supplier'),path=`/client-connections/${pairing.user_code}`;
 const expected=await api(path,member);assert.equal(expected.status,200);
 const facts=async()=>(await pool.query('SELECT (SELECT count(*)::int FROM member_client_connections) AS connections,(SELECT count(*)::int FROM command_receipts) AS receipts,(SELECT count(*)::int FROM transition_journal) AS journal')).rows[0];
 const before=await facts(),hash=tokenHash(member.cookie.split('=')[1]);
 for(const expired of [true,false]){
  const gate=await admin.connect();let pending:Promise<unknown>|undefined;
  try{
   await gate.query('BEGIN');await gate.query(`LOCK TABLE ${schema}.client_pairing_requests IN ACCESS EXCLUSIVE MODE`);
   await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+make_interval(secs=>$2) WHERE token_hash=$1",[hash,expired?3:3600]);
   const pid=(await gate.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   const response=api(path,member);pending=response.catch(()=>undefined);
   const deadline=Date.now()+2000;
   for(;;){
    if((await admin.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rowCount!>0)break;
    assert.ok(Date.now()<deadline,'pairing review reached its real source query');await setImmediate();
   }
   assert.equal((await pool.query('SELECT expires_at>clock_timestamp() AS live FROM sessions WHERE token_hash=$1',[hash])).rows[0].live,true);
   if(expired)await pool.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM expires_at-clock_timestamp()))+0.05) FROM sessions WHERE token_hash=$1',[hash]);
   await gate.query('ROLLBACK');const result=await response;
   assert.equal(result.status,expired?401:200,JSON.stringify(result.data));
   if(expired){
    assert.equal(result.data.code,'session_expired');
    for(const key of ['user_code','client_name','kind','scope'])assert.equal(key in result.data,false);
    assert.equal(result.response.headers.get('set-cookie'),null);
   }else assert.deepEqual(result.data,expected.data);
   assert.deepEqual(await facts(),before);
  }finally{
   await gate.query('ROLLBACK');gate.release();if(pending)await pending;
   await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '30 days' WHERE token_hash=$1",[hash]);
  }
 }
});

for(const invalid of ['expired','revoked','inactive'] as const)test(`pairing review refuses a cached actor whose current authority is ${invalid}`,async()=>{
 const {actor}=await login(pool,DEMO_USERS[0].email,DEMO_PASSWORD),pairing=await start('supplier');
 const expected=await pairingView(pool,actor,pairing.user_code);assert.equal(expected.client_name,'我的 Fork 客戶端');
 if(invalid==='expired')await pool.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[actor.session_hash]);
 else if(invalid==='revoked')await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[actor.session_hash]);
 else await pool.query('UPDATE users SET active=false WHERE user_id=$1',[actor.user_id]);
 await assert.rejects(pairingView(pool,actor,pairing.user_code),(error:unknown)=>error instanceof Problem&&error.status===401&&error.code==='session_expired');
});

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

test('store UUID and bearer scheme aliases compose without expanding scope or credential lifetime',async()=>{
 const seller=await ready(DEMO_USERS[1].email),supplier=await ready(),source=await product(supplier);
 const ids=['a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000002','c0000000-0000-4000-8000-000000000003'];
 for(const [index,id]of ids.entries())await pool.query(`INSERT INTO retail_stores(store_id,community_id,seller_ref,name,description,support_contact)
  VALUES($1,$2,$3,$4,'固定含字母 UUID 的合成商店','合成客服')`,[id,DEMO_COMMUNITY,index===2?supplier.user.user_id:seller.user.user_id,`合成 UUID 商店 ${index}`]);
 const own=await listing(seller,ids[0],source.current_offer.offer_version_id);
 await listing(seller,ids[1],source.current_offer.offer_version_id);await listing(supplier,ids[2],source.current_offer.offer_version_id);
 const connected=await connect(seller,'storefront',ids[0].toUpperCase()),token=connected.access_token;
 const storePage=await client(`/retail/stores/${ids[0].toUpperCase()}`,token);
 assert.equal(storePage.status,200,JSON.stringify(storePage.data));
 assert.deepEqual(storePage.data.items.map((row:{store_id:string})=>row.store_id),[ids[0]]);
 const listingPage=await client(`/retail/stores/${ids[0].toUpperCase()}/listings`,token);
 assert.equal(listingPage.status,200,JSON.stringify(listingPage.data));
 assert.deepEqual(listingPage.data.items.map((row:{listing_id:string})=>row.listing_id),[own.listing_id]);
 const aliased=(id:string,suffix='',body?:unknown)=>request(`/client-api/v1/retail/stores/${id.toUpperCase()}${suffix}`,undefined,body,undefined,undefined,{Authorization:'bEaReR   '+token});
 assert.deepEqual((await aliased(ids[0])).data,storePage.data);
 assert.deepEqual((await aliased(ids[0],'/listings')).data,listingPage.data);
 for(let index=1;index<ids.length;index++)for(const suffix of ['', '/listings']){
  for(const denied of [await client(`/retail/stores/${ids[index].toUpperCase()}${suffix}`,token),await aliased(ids[index],suffix)]){
   assert.equal(denied.status,404);assert.equal(denied.data.code,'store_not_found');
  }
 }
 assert.equal((await aliased(ids[0],'/listings',{})).status,405);
 await pool.query("UPDATE member_client_connections SET expires_at=clock_timestamp()-interval '1 second' WHERE connection_id=$1",[connected.connection_id]);
 for(const suffix of ['', '/listings'])assert.equal((await aliased(ids[0],suffix)).status,401);
 await pool.query("UPDATE member_client_connections SET expires_at=clock_timestamp()+interval '1 hour' WHERE connection_id=$1",[connected.connection_id]);
 assert.equal((await aliased(ids[0])).status,200);
 assert.equal((await api(`/me/client-connections/${connected.connection_id}/revoke`,seller,{},1)).status,200);
 for(const suffix of ['', '/listings'])assert.equal((await aliased(ids[0],suffix)).status,401);
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

async function deactivateWhileWaiting(userId:string,operation:()=>ReturnType<typeof request>){
 const q=await pool.connect();let pending:ReturnType<typeof request>|undefined;
 try{
   await q.query('BEGIN');await q.query("SET LOCAL lock_timeout='1000ms'");
   const pid=(await q.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   await q.query('UPDATE users SET active=false WHERE user_id=$1',[userId]);
   pending=operation();
   // Observe an actual PostgreSQL lock wait, rather than assuming a timer races.
   let waiting=false;
   for(let attempt=0;attempt<100;attempt++){
     waiting=(await pool.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting',[pid])).rows[0].waiting;
     if(waiting)break;
     await new Promise(resolve=>setTimeout(resolve,10));
   }
   assert.equal(waiting,true,'read or token exchange must wait for the member status transaction');
   // A connection-first reader would deadlock here: it holds c while waiting for u.
   await q.query('UPDATE member_client_connections SET revoked_at=now(),aggregate_version=aggregate_version+1 WHERE user_id=$1 AND revoked_at IS NULL',[userId]);
   await q.query('COMMIT');return await pending;
 }finally{await q.query('ROLLBACK');q.release();if(pending)await pending;}
}

test('the member connection list is denied when its projection wait outlives the owner session',async()=>{
 const member=await ready();await connect(member,'supplier');
 await pool.query('UPDATE sessions SET expires_at=clock_timestamp()+interval \'1 second\' WHERE user_id=$1',[member.user.user_id]);
 const blocker=await pool.connect();let pending:ReturnType<typeof api>|undefined;
 try{
  await blocker.query('BEGIN');
  const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await blocker.query('LOCK TABLE member_client_connections IN ACCESS EXCLUSIVE MODE');
  pending=api('/me/client-connections',member);
  let waiting=false;
  for(let attempt=0;attempt<200;attempt++){
   waiting=Boolean((await admin.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rowCount);
   if(waiting)break;
   await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.ok(waiting,'connection list must actually wait for the held projection lock');
  await blocker.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM expires_at-clock_timestamp()))+0.05) FROM sessions WHERE user_id=$1',[member.user.user_id]);
 }finally{await blocker.query('ROLLBACK');blocker.release();if(pending)await pending;}
 const response=await pending!;
 assert.equal(response.status,401);
 assert.equal(response.data.code,'session_expired');
});

test('administrative deactivation and an in-flight bearer read use the same member-first lock order',async()=>{
 const member=await ready(),connected=await connect(member,'supplier');
 const response=await deactivateWhileWaiting(member.user.user_id,()=>client('/supplier/products',connected.access_token));
 assert.equal(response.status,401);assert.equal(response.data.code,'client_token_invalid');
});

test('a pending approved token exchange waits for member deactivation and never mints a credential afterwards',async()=>{
 const member=await ready(),pairing=await start('supplier');
 assert.equal((await api(`/client-connections/${pairing.user_code}/approve`,member,{confirmed:true})).status,200);
 const response=await deactivateWhileWaiting(member.user.user_id,()=>api('/client-connections/poll',undefined,{device_secret:pairing.device_secret}));
 assert.equal(response.status,400);assert.equal(response.data.status,'invalid_grant');
 assert.equal((await pool.query('SELECT token_hash FROM member_client_connections WHERE user_id=$1',[member.user.user_id])).rows[0].token_hash,null);
});

async function rollbackAndSettle(blocker: PoolClient, operation?: Promise<unknown>) {
  try { await blocker.query('ROLLBACK'); }
  catch (error) {
    blocker.release(error instanceof Error ? error : true);
    await operation;
    throw error;
  }
  blocker.release();
  await operation;
}

async function waitForMemberLock(queryPrefix: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const locked = await admin.query('SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type=$1 AND query LIKE $2', ['Lock', queryPrefix + '%']);
    if (locked.rowCount) return;
    assert.ok(attempt < 199, 'operation must wait on the member lock');
    await delay(10);
  }
}

test('a poll waiting on the member lock cannot collect a token after pairing expiry', async () => {
  const member = await ready();
  const pairing = await start('supplier');
  assert.equal((await api(`/client-connections/${pairing.user_code}/approve`, member, { confirmed: true })).status, 200);
  await pool.query("UPDATE client_pairing_requests SET expires_at=clock_timestamp()+interval '2 seconds', last_polled_at=NULL");
  const blocker = await pool.connect();
  await blocker.query('BEGIN');
  await blocker.query('SELECT user_id FROM users WHERE user_id=$1 FOR UPDATE', [member.user.user_id]);
  const poll = api('/client-connections/poll', undefined, { device_secret: pairing.device_secret });
  try {
    await waitForMemberLock('SELECT 1 FROM users WHERE user_id=$1 AND community_id=$2');
    await pool.query("SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM expires_at-clock_timestamp()))+0.05) FROM client_pairing_requests");
    await blocker.query('COMMIT');
    const issued = await poll;
    assert.equal(issued.status, 400);
    assert.equal(issued.data.status, 'invalid_grant');
    assert.equal(issued.data.access_token, undefined);
    assert.equal((await pool.query('SELECT token_hash FROM member_client_connections WHERE user_id=$1', [member.user.user_id])).rows[0].token_hash, null);
  } finally {
    await rollbackAndSettle(blocker,poll);
  }
});

test('an approval waiting on the member lock cannot accept an expired pairing code', async () => {
  const member = await ready();
  const pairing = await start('supplier');
  await pool.query("UPDATE client_pairing_requests SET expires_at=clock_timestamp()+interval '2 seconds'");
  const blocker = await pool.connect();
  await blocker.query('BEGIN');
  await blocker.query('SELECT user_id FROM users WHERE user_id=$1 FOR UPDATE', [member.user.user_id]);
  const approval = api(`/client-connections/${pairing.user_code}/approve`, member, { confirmed: true });
  try {
    await waitForMemberLock('SELECT user_id FROM users WHERE user_id=$1 AND community_id=$2 AND active');
    await pool.query("SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM expires_at-clock_timestamp()))+0.05) FROM client_pairing_requests");
    await blocker.query('COMMIT');
    const result = await approval;
    assert.equal(result.status, 404);
    assert.equal(result.data.code, 'pairing_not_found');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM member_client_connections')).rows[0].n, 0);
  } finally {
    await rollbackAndSettle(blocker,approval);
  }
});

test('a bearer read waiting on the member lock cannot return data after connection expiry', async () => {
  const member = await ready();
  const connected = await connect(member, 'supplier');
  await pool.query("UPDATE member_client_connections SET expires_at=clock_timestamp()+interval '2 seconds' WHERE connection_id=$1", [connected.connection_id]);
  const blocker = await pool.connect();
  await blocker.query('BEGIN');
  await blocker.query('SELECT user_id FROM users WHERE user_id=$1 FOR UPDATE', [member.user.user_id]);
  const read = client('/supplier/products', connected.access_token);
  try {
    await waitForMemberLock('SELECT 1 FROM users WHERE user_id=$1 AND community_id=$2 AND active AND onboarding_completed_at IS NOT NULL FOR SHARE');
    await pool.query("SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM expires_at-clock_timestamp()))+0.05) FROM member_client_connections WHERE connection_id=$1", [connected.connection_id]);
    await blocker.query('COMMIT');
    const result = await read;
    assert.equal(result.status, 401);
    assert.equal(result.data.code, 'client_token_invalid');
  } finally {
    await rollbackAndSettle(blocker,read);
  }
});

async function waitForCredentialLock(blockerPid:number){
  for(let attempt=0;attempt<200;attempt++){
    const waiting=await admin.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[blockerPid]);
    if(waiting.rowCount)return;
    await delay(20);
  }
  assert.fail('credential request did not wait for the held lock');
}

for(const waitAt of ['member','connection','write'] as const)for(const expires of ['connection','pairing'] as const)test(`an approved pairing cannot mint after ${expires} expires during the ${waitAt} lock`,async()=>{
  const member=await ready();
  const connectionId=randomUUID();
  const deviceSecret=`fw_pair_${randomBytes(32).toString('base64url')}`;
  await pool.query(`INSERT INTO member_client_connections(connection_id,community_id,user_id,client_name,kind,scope,expires_at)
    VALUES($1,$2,$3,'合成客戶端','supplier','supplier:read',clock_timestamp()+$4::interval)`,[connectionId,DEMO_COMMUNITY,member.user.user_id,expires==='connection'?'1 second':'1 hour']);
  await pool.query(`INSERT INTO client_pairing_requests(pairing_id,device_secret_hash,user_code_hash,kind,client_name,state,connection_id,expires_at)
    VALUES($1,$2,$3,'supplier','合成客戶端','approved',$4,clock_timestamp()+$5::interval)`,[randomUUID(),tokenHash(deviceSecret),tokenHash(randomUUID()),connectionId,expires==='pairing'?'1 second':'1 hour']);
 const blocker=await pool.connect();
 let pending:ReturnType<typeof pollClientPairing>|undefined;
 try{
  await blocker.query('BEGIN');
  const blockerPid=Number((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  if(waitAt==='member')await blocker.query('SELECT user_id FROM users WHERE user_id=$1 FOR UPDATE',[member.user.user_id]);
  else if(waitAt==='connection')await blocker.query('SELECT connection_id FROM member_client_connections WHERE connection_id=$1 FOR UPDATE',[connectionId]);
  else await blocker.query('LOCK TABLE member_client_connections IN SHARE MODE');
  pending=pollClientPairing(pool,{device_secret:deviceSecret},'127.0.0.1');
  await waitForCredentialLock(blockerPid);
  await blocker.query(`SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM expires_at-clock_timestamp()))+0.05) FROM ${expires==='pairing'?'client_pairing_requests':'member_client_connections'} WHERE connection_id=$1`,[connectionId]);
 }finally{
  await rollbackAndSettle(blocker,pending);
 }
 const result=await pending!;
  assert.equal(result.status,'invalid_grant');
  assert.equal('access_token' in result,false);
  assert.equal((await pool.query('SELECT state,token_hash FROM client_pairing_requests p LEFT JOIN member_client_connections c USING(connection_id) WHERE p.connection_id=$1',[connectionId])).rows[0].state,'approved');
  assert.equal((await pool.query('SELECT token_hash FROM member_client_connections WHERE connection_id=$1',[connectionId])).rows[0].token_hash,null);
});

for(const waitAt of ['member','connection','products'] as const)test(`an expired client credential cannot read after the ${waitAt} lock wait`,async()=>{
  const member=await ready();
  const token=`fw_read_${randomBytes(32).toString('base64url')}`;
  const connectionId=randomUUID();
  await pool.query(`INSERT INTO member_client_connections(connection_id,community_id,user_id,client_name,kind,scope,token_hash,expires_at)
    VALUES($1,$2,$3,'合成客戶端','supplier','supplier:read',$4,clock_timestamp()+interval '1 second')`,[connectionId,DEMO_COMMUNITY,member.user.user_id,tokenHash(token)]);
 const blocker=await pool.connect();
 let pending:Promise<{value:unknown;error:Problem|null}>|undefined;
 try{
  await blocker.query('BEGIN');
  const blockerPid=Number((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  if(waitAt==='member')await blocker.query('SELECT user_id FROM users WHERE user_id=$1 FOR UPDATE',[member.user.user_id]);
  else if(waitAt==='connection')await blocker.query('SELECT connection_id FROM member_client_connections WHERE connection_id=$1 FOR UPDATE',[connectionId]);
  else await blocker.query('LOCK TABLE catalog_products IN ACCESS EXCLUSIVE MODE');
  pending=readClientResource(pool,`Bearer ${token}`,waitAt==='products'?'products':'connection').then(value=>({value,error:null as Problem|null}),error=>{assert.ok(error instanceof Problem);return {value:null,error};});
  await waitForCredentialLock(blockerPid);
  await blocker.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM expires_at-clock_timestamp()))+0.05) FROM member_client_connections WHERE connection_id=$1',[connectionId]);
 }finally{
  await rollbackAndSettle(blocker,pending);
 }
 const result=await pending!;
  assert.equal(result.value,null);
  assert.equal(result.error?.status,401);
  assert.equal(result.error?.code,'client_token_invalid');
});


for(const waitAt of ['pairing','connections','receipt'] as const)test(`an expired pairing code cannot be approved after the ${waitAt} lock wait`,async()=>{
 await ready();
 const actor=(await login(pool,DEMO_USERS[0].email,DEMO_PASSWORD)).actor;
 const code=randomBytes(10).toString('hex').toUpperCase();
 const pairingId=randomUUID();
 const key=randomUUID(),operation='client-pairing-approve';
 await pool.query(`INSERT INTO client_pairing_requests(pairing_id,device_secret_hash,user_code_hash,kind,client_name,expires_at)
  VALUES($1,$2,$3,'supplier','合成客戶端',clock_timestamp()+interval '1 second')`,[pairingId,tokenHash(randomUUID()),tokenHash(code)]);
 const blocker=await pool.connect();
 let pending:Promise<{error:Problem|null}>|undefined;
 try{
  await blocker.query('BEGIN');
  const blockerPid=Number((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  if(waitAt==='pairing')await blocker.query('SELECT pairing_id FROM client_pairing_requests WHERE pairing_id=$1 FOR UPDATE',[pairingId]);
  else if(waitAt==='connections')await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`client-connections/${actor.user_id}`]);
  else await blocker.query('LOCK TABLE command_receipts IN SHARE MODE');
  pending=approveClientPairing(pool,{actor,operation,key,body:{confirmed:true}},code).then(()=>({error:null}),error=>{assert.ok(error instanceof Problem);return {error};});
  for(let attempt=0;attempt<200;attempt++){
   const waiting=await admin.query(`SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))`,[blockerPid]);
   if(waiting.rowCount)break;
   await delay(20);
   if(attempt===199)assert.fail(`approval did not wait at ${waitAt}`);
  }
  await blocker.query(`SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM expires_at-clock_timestamp()))+0.05) FROM client_pairing_requests WHERE pairing_id=$1`,[pairingId]);
 }finally{
  await rollbackAndSettle(blocker,pending);
 }
 const result=await pending!;
 assert.equal(result.error?.status,404);
 assert.equal(result.error?.code,'pairing_not_found');
 assert.equal((await pool.query('SELECT state FROM client_pairing_requests WHERE pairing_id=$1',[pairingId])).rows[0].state,'pending');
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM member_client_connections WHERE user_id=$1',[actor.user_id])).rows[0].n,0);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM command_receipts WHERE user_id=$1 AND operation=$2 AND idempotency_key=$3',[actor.user_id,operation,key])).rows[0].n,0);
});

test('a committed pairing approval remains replayable after the code expires',async()=>{
 const member=await ready(),pairing=await start('supplier'),key=randomUUID();
 const path=`/client-connections/${pairing.user_code}/approve`;
 const approved=await api(path,member,{confirmed:true},undefined,key);
 assert.equal(approved.status,200);
 await pool.query("UPDATE client_pairing_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE connection_id=$1",[approved.data.connection_id]);
 const replay=await api(path,member,{confirmed:true},undefined,key);
 assert.equal(replay.status,200);
 assert.deepEqual(replay.data,approved.data);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM member_client_connections WHERE user_id=$1',[member.user.user_id])).rows[0].n,1);
});


async function waitForOwnedBlocker(blockerPid: number, queryPattern: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const waiting = await pool.query(
      `SELECT pid FROM pg_stat_activity
       WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE $2`,
      [blockerPid, queryPattern],
    );
    if (waiting.rowCount) return;
    assert.ok(attempt < 199, 'operation must wait on the owned blocking backend');
    await delay(10);
  }
}

async function sleepUntilRowExpiry(table: 'client_pairing_requests' | 'member_client_connections', id: string) {
  const column = table === 'client_pairing_requests' ? 'pairing_id' : 'connection_id';
  await pool.query(
    `SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM expires_at-clock_timestamp()))+0.05) FROM ${table} WHERE ${column}=$1`,
    [id],
  );
}

async function pairingRow(userCode: string) {
  return (await pool.query(
    'SELECT pairing_id, connection_id, state FROM client_pairing_requests WHERE user_code_hash=$1',
    [tokenHash(userCode.replace(/-/g, ''))],
  )).rows[0];
}

test('a poll waiting on the connection row cannot mint a token after pairing expiry', async () => {
  const member = await ready();
  const pairing = await start('supplier');
  assert.equal((await api(`/client-connections/${pairing.user_code}/approve`, member, { confirmed: true })).status, 200);
  const saved = await pairingRow(pairing.user_code);
  await pool.query("UPDATE client_pairing_requests SET expires_at=clock_timestamp()+interval '4 seconds', last_polled_at=NULL WHERE pairing_id=$1", [saved.pairing_id]);
  const blocker = await pool.connect();
  await blocker.query('BEGIN');
  const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  // Lock the credential row without updating it, so a stale expiry predicate is not rechecked.
  await blocker.query('SELECT connection_id FROM member_client_connections WHERE connection_id=$1 FOR UPDATE', [saved.connection_id]);
  const poll = api('/client-connections/poll', undefined, { device_secret: pairing.device_secret });
  try {
    await waitForOwnedBlocker(pid, '%member_client_connections%FOR UPDATE%');
    await sleepUntilRowExpiry('client_pairing_requests', saved.pairing_id);
    await blocker.query('COMMIT');
    const issued = await poll;
    assert.equal(issued.status, 400);
    assert.equal(issued.data.status, 'invalid_grant');
    assert.equal(Object.hasOwn(issued.data, 'access_token'), false);
    assert.equal((await pool.query('SELECT token_hash FROM member_client_connections WHERE connection_id=$1', [saved.connection_id])).rows[0].token_hash, null);
    assert.equal((await pool.query('SELECT state FROM client_pairing_requests WHERE pairing_id=$1', [saved.pairing_id])).rows[0].state, 'approved');
  } finally {
    await rollbackAndSettle(blocker,poll);
  }
});

test('a poll waiting on the connection row cannot mint a token after connection expiry', async () => {
  const member = await ready();
  const pairing = await start('supplier');
  assert.equal((await api(`/client-connections/${pairing.user_code}/approve`, member, { confirmed: true })).status, 200);
  const saved = await pairingRow(pairing.user_code);
  await pool.query("UPDATE member_client_connections SET expires_at=clock_timestamp()+interval '4 seconds' WHERE connection_id=$1", [saved.connection_id]);
  await pool.query('UPDATE client_pairing_requests SET last_polled_at=NULL WHERE pairing_id=$1', [saved.pairing_id]);
  const blocker = await pool.connect();
  await blocker.query('BEGIN');
  const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await blocker.query('SELECT connection_id FROM member_client_connections WHERE connection_id=$1 FOR UPDATE', [saved.connection_id]);
  const poll = api('/client-connections/poll', undefined, { device_secret: pairing.device_secret });
  try {
    await waitForOwnedBlocker(pid, '%member_client_connections%FOR UPDATE%');
    await sleepUntilRowExpiry('member_client_connections', saved.connection_id);
    await blocker.query('COMMIT');
    const issued = await poll;
    assert.equal(issued.status, 400);
    assert.equal(issued.data.status, 'invalid_grant');
    assert.equal(Object.hasOwn(issued.data, 'access_token'), false);
    assert.equal((await pool.query('SELECT token_hash FROM member_client_connections WHERE connection_id=$1', [saved.connection_id])).rows[0].token_hash, null);
    assert.equal((await pool.query('SELECT state FROM client_pairing_requests WHERE pairing_id=$1', [saved.pairing_id])).rows[0].state, 'approved');
  } finally {
    await rollbackAndSettle(blocker,poll);
  }
});

async function assertRejectedApproval(member: Session, pairingId: string, result: { status: number; data: any }) {
  assert.equal(result.status, 404);
  assert.equal(result.data.code, 'pairing_not_found');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM member_client_connections')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT state, connection_id FROM client_pairing_requests WHERE pairing_id=$1', [pairingId])).rows[0].state, 'pending');
  assert.equal((await pool.query('SELECT connection_id FROM client_pairing_requests WHERE pairing_id=$1', [pairingId])).rows[0].connection_id, null);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM command_receipts WHERE user_id=$1', [member.user.user_id])).rows[0].n, 0);
}

test('an approval waiting on the pairing row cannot accept an expired code', async () => {
  const member = await ready();
  const pairing = await start('supplier');
  const saved = await pairingRow(pairing.user_code);
  await pool.query("UPDATE client_pairing_requests SET expires_at=clock_timestamp()+interval '4 seconds' WHERE pairing_id=$1", [saved.pairing_id]);
  const blocker = await pool.connect();
  await blocker.query('BEGIN');
  const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await blocker.query('SELECT pairing_id FROM client_pairing_requests WHERE pairing_id=$1 FOR UPDATE', [saved.pairing_id]);
  const approval = api(`/client-connections/${pairing.user_code}/approve`, member, { confirmed: true });
  try {
    await waitForOwnedBlocker(pid, '%client_pairing_requests%FOR UPDATE%');
    await sleepUntilRowExpiry('client_pairing_requests', saved.pairing_id);
    await blocker.query('COMMIT');
    await assertRejectedApproval(member, saved.pairing_id, await approval);
  } finally {
    await rollbackAndSettle(blocker,approval);
  }
});

test('an approval waiting on the client-connections advisory lock cannot accept an expired code', async () => {
  const member = await ready();
  const pairing = await start('supplier');
  const saved = await pairingRow(pairing.user_code);
  await pool.query("UPDATE client_pairing_requests SET expires_at=clock_timestamp()+interval '4 seconds' WHERE pairing_id=$1", [saved.pairing_id]);
  const blocker = await pool.connect();
  await blocker.query('BEGIN');
  const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`client-connections/${member.user.user_id}`]);
  const approval = api(`/client-connections/${pairing.user_code}/approve`, member, { confirmed: true });
  try {
    await waitForOwnedBlocker(pid, '%pg_advisory_xact_lock%');
    await sleepUntilRowExpiry('client_pairing_requests', saved.pairing_id);
    await blocker.query('COMMIT');
    await assertRejectedApproval(member, saved.pairing_id, await approval);
  } finally {
    await rollbackAndSettle(blocker,approval);
  }
});

test('a credential-row wait that crosses expiry denies connection metadata', async () => {
  const member = await ready();
  const connected = await connect(member, 'supplier');
  await pool.query("UPDATE member_client_connections SET expires_at=clock_timestamp()+interval '4 seconds' WHERE connection_id=$1", [connected.connection_id]);
  const blocker = await pool.connect();
  await blocker.query('BEGIN');
  const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await blocker.query('SELECT connection_id FROM member_client_connections WHERE connection_id=$1 FOR UPDATE', [connected.connection_id]);
  const read = client('/connection', connected.access_token);
  try {
    await waitForOwnedBlocker(pid, '%token_hash%FOR SHARE%');
    await sleepUntilRowExpiry('member_client_connections', connected.connection_id);
    await blocker.query('COMMIT');
    const result = await read;
    assert.equal(result.status, 401);
    assert.equal(result.data.code, 'client_token_invalid');
    assert.equal(result.data.connection_id, undefined);
  } finally {
    await rollbackAndSettle(blocker,read);
  }
});

test('a credential-row wait that crosses expiry denies list data', async () => {
  const member = await ready();
  const connected = await connect(member, 'supplier');
  await pool.query("UPDATE member_client_connections SET expires_at=clock_timestamp()+interval '4 seconds' WHERE connection_id=$1", [connected.connection_id]);
  const blocker = await pool.connect();
  await blocker.query('BEGIN');
  const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await blocker.query('SELECT connection_id FROM member_client_connections WHERE connection_id=$1 FOR UPDATE', [connected.connection_id]);
  const read = client('/supplier/products', connected.access_token);
  try {
    await waitForOwnedBlocker(pid, '%token_hash%FOR SHARE%');
    await sleepUntilRowExpiry('member_client_connections', connected.connection_id);
    await blocker.query('COMMIT');
    const result = await read;
    assert.equal(result.status, 401);
    assert.equal(result.data.code, 'client_token_invalid');
    assert.equal(result.data.items, undefined);
  } finally {
    await rollbackAndSettle(blocker,read);
  }
});
