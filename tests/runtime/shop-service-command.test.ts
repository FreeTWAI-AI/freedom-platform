import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool,type PoolClient} from 'pg';
import {scopedJournal} from '../../packages/scoped-commands/index.js';
import {migrate} from '../../scripts/database.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {tokenHash} from '../../modules/identity-membership/service.js';
import {withMemberScope} from '../../packages/resource-scopes/index.js';
import {assertShopServiceClock,lockShopService,forgetShopService,shopServiceHost,type ShopContext} from '../../packages/resource-scopes/shop-service.js';
import {transaction} from '../../packages/db/index.js';

const configured=process.env.TEST_DATABASE_URL;
assert(configured,'Explicit disposable TEST_DATABASE_URL required');
const url=new URL(configured);assert.match(url.pathname,/^\/fp_[a-z0-9_]+$/);assert(['localhost','127.0.0.1','[::1]'].includes(url.hostname));
const schema='fp_shop_command_'+randomUUID().replaceAll('-',''),role='fp_shop_dml_'+randomUUID().replaceAll('-','');
const admin=new Pool({connectionString:url.href}),pool=new Pool({connectionString:url.href,options:`-c search_path=${schema} -c statement_timeout=10000`,max:10});
const dmlUrl=new URL(url.href);dmlUrl.username=role;
const dml=new Pool({connectionString:dmlUrl.href,options:`-c search_path=${schema} -c statement_timeout=10000`,max:6});
const origin='http://127.0.0.1:4310',app=createApp(pool,origin,'local',{shopKeyPolicy:'purpose-bound-only'});
let created=false,roleCreated=false;
before(async()=>{
 await admin.query(`CREATE SCHEMA ${schema}`);created=true;await migrate(pool);
 await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT`);roleCreated=true;
 await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
 for(const table of ['users','commerce_shops','commerce_shop_keys','commerce_orders','commerce_order_lines','commerce_items','principals','resource_scopes','scoped_command_receipts','scoped_transition_journal'])
  await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${schema}.${table} TO ${role}`);
});
after(async()=>{await dml.end();await pool.end();if(created)await admin.query(`DROP SCHEMA ${schema} CASCADE`);if(roleCreated)await admin.query(`DROP ROLE ${role}`);await admin.end();});
async function fixture(target=pool,community=randomUUID()){
 const owner=randomUUID(),shop=randomUUID(),internal=randomUUID(),item=randomUUID(),selection=randomUUID(),order=randomUUID(),transfer=randomUUID();
 const token='fw_shop_'+randomBytes(32).toString('base64url'),requestDigest='a'.repeat(64),session=randomBytes(32).toString('base64url');
 await target.query("INSERT INTO communities VALUES($1,'Synthetic expiry') ON CONFLICT DO NOTHING",[community]);
 await target.query("INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) VALUES($1,$2,$3,'Synthetic owner','not-a-login-hash',$4)",[owner,community,owner+'@example.invalid',randomUUID()]);
 for(const [id,kind] of [[shop,'public'],[internal,'internal']])await target.query(`INSERT INTO commerce_shops(shop_id,community_id,owner_id,kind,name,description,website_url,contact,currency,manifest_sha256)
  VALUES($1,$2,$3,$4,'Synthetic','Synthetic','https://synthetic.example.com','Synthetic','TWD',$5)`,[id,community,owner,kind,id]);
 await target.query("INSERT INTO commerce_shop_keys(shop_id,token_hash,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[shop,tokenHash(token)]);
 await target.query("INSERT INTO commerce_items(item_id,shop_id,sku,title,description,price_minor,shipping_minor,stock,reserved,shipping_terms,return_terms) VALUES($1,$2,'synthetic','Synthetic','Synthetic',100,0,5,1,'Synthetic','Synthetic')",[item,internal]);
 await target.query("INSERT INTO commerce_selections(selection_id,shop_id,item_id,retail_price_minor,sale_terms,snapshot) VALUES($1,$2,$3,100,'Synthetic','{}')",[selection,shop,item]);
 await target.query("INSERT INTO commerce_orders(order_id,public_shop_id,external_id,request_sha256,currency,total_minor) VALUES($1,$2,$3,$4,'TWD',100)",[order,shop,randomUUID(),requestDigest]);
 await target.query("INSERT INTO commerce_transfers(transfer_id,order_id,internal_shop_id,total_minor,delivery_ref) VALUES($1,$2,$3,100,'synthetic_reference')",[transfer,order,internal]);
 await target.query("INSERT INTO commerce_order_lines(order_id,selection_id,transfer_id,item_id,quantity,snapshot) VALUES($1,$2,$3,$4,1,'{}')",[order,selection,transfer,item]);
 await target.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')",[tokenHash(session),owner]);
 return {community,owner,shop,item,order,token,requestDigest,session};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;

async function request(path:string,opts:{app?:ReturnType<typeof createApp>;origin?:string;token?:string;session?:string;body?:unknown;key?:string;headers?:Record<string,string>}={}){
 const at=opts.origin??origin,response=await (opts.app??app).request(at+path,{method:opts.body===undefined?'GET':'POST',headers:{
  ...(opts.token?{Authorization:'Bearer '+opts.token}:{}),...(opts.session?{Cookie:'freedom_local_session='+opts.session,'X-CSRF-Token':'synthetic',Origin:at}:{}),
  ...(opts.body===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':opts.key??randomUUID()}),...opts.headers},
  ...(opts.body===undefined?{}:{body:JSON.stringify(opts.body)})});
 const text=await response.text();return {status:response.status,data:JSON.parse(text),text};
}
async function issue(f:Fixture,opts:Parameters<typeof request>[1]={}){
 const result=await request(`/api/v1/commerce/shops/${f.shop}/key`,{session:f.session,body:{},...opts});
 assert.equal(result.status,200,result.text);assert.match(result.data.token,/^fw_shop_v2_[A-Za-z0-9_-]{43}$/);return result.data.token as string;
}
const connection=(token:string,opts:Parameters<typeof request>[1]={})=>request('/shop-api/v1/connection',{token,...opts});

const cancel=(f:Fixture,token:string,opts:Parameters<typeof request>[1]={})=>request(`/shop-api/v1/orders/${f.order}/cancel`,{token,body:{},...opts});
async function state(f:Fixture){return (await pool.query(`SELECT o.buyer_payment,o.request_sha256,i.reserved,
 (SELECT count(*)::int FROM scoped_command_receipts WHERE target_id=$1) receipts,
 (SELECT count(*)::int FROM scoped_transition_journal WHERE aggregate_id=$1) journals,
 (SELECT count(*)::int FROM commerce_payment_events WHERE shop_id=$3) payments
 FROM commerce_orders o,commerce_items i WHERE o.order_id=$1 AND i.item_id=$2`,[f.order,f.item,f.shop])).rows[0];}
async function until(check:()=>Promise<boolean>,message:string){for(let n=0;n<500;n++){if(await check())return;await delay(10);}assert.fail(message);}
async function waitBlocked(blocker:PoolClient,query?:string){const pid=(await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
 await until(async()=>Boolean((await admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND ($2::text IS NULL OR query LIKE $2)) waiting',[pid,query??null])).rows[0].waiting),'expected actual database lock wait: '+query);}
async function expire(f:Fixture){await until(async()=>Boolean((await pool.query('SELECT expires_at<=clock_timestamp() expired FROM commerce_shop_keys WHERE shop_id=$1',[f.shop])).rows[0].expired),'database deadline did not pass');}
async function mapping(f:Fixture){return (await pool.query(`SELECT p.principal_id,s.scope_id FROM principals p JOIN resource_scopes s ON s.service_principal_id=p.principal_id WHERE p.service_shop_ref=$1`,[f.shop])).rows[0];}

test('DML role: real service cancellation atomically releases inventory, receipts and journals exactly once; rotation preserves subject',async()=>{
 const f=await fixture(),token=await issue(f),runtime=createApp(dml,origin,'local',{shopKeyPolicy:'purpose-bound-only'});
 const result=await cancel(f,token,{app:runtime});assert.equal(result.status,200,result.text);assert.deepEqual(result.data,{cancelled:true});
 const after=await state(f);assert.deepEqual(after,{buyer_payment:'cancelled',request_sha256:f.requestDigest,reserved:0,receipts:1,journals:1,payments:0});
 const identity=await mapping(f);
 assert.deepEqual((await cancel(f,token,{app:runtime})).data,result.data);assert.deepEqual(await state(f),after);
 const next=await issue(f);assert.equal((await cancel(f,token,{app:runtime})).status,401);assert.equal((await cancel(f,next,{app:runtime})).status,200);
 assert.deepEqual(await mapping(f),identity);assert.deepEqual(await state(f),after);
 const receipt=(await pool.query('SELECT * FROM scoped_command_receipts WHERE target_id=$1',[f.order])).rows[0];
 assert.equal(receipt.principal_kind,'service');assert.equal(receipt.authn_kind,'shop_service_key');assert.equal(receipt.scope_kind,'site');assert.equal(receipt.principal_id,identity.principal_id);
 assert.equal(receipt.execution_authorization_id,null);assert.equal(receipt.personal_owner_principal_id,null);
 const facts=await pool.query('SELECT * FROM scoped_transition_journal WHERE aggregate_id=$1',[f.order]);
 assert.equal(facts.rows[0].aggregate_type,'commerce_order_cancellation');assert.equal(facts.rows[0].aggregate_version,'1');assert.equal(facts.rows[0].operation,'shop.order.cancel');
 assert(!JSON.stringify([receipt,...facts.rows]).includes(token));assert(!JSON.stringify([receipt,...facts.rows]).includes(tokenHash(token)));
 assert.equal((await dml.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0].current_user,role);
 await assert.rejects(()=>dml.query('ALTER TABLE principals DISABLE TRIGGER ALL'),{code:'42501'});
 await assert.rejects(()=>dml.query('DELETE FROM scoped_command_receipts WHERE target_id=$1',[f.order]),{code:'23514'});
});

test('concurrent first use and cancel share one backed identity and terminal fact',async()=>{
 const f=await fixture(),token=await issue(f),results=await Promise.all([cancel(f,token),cancel(f,token)]);
 for(const r of results)assert.equal(r.status,200,r.text);
 assert.equal((await pool.query('SELECT count(*)::int n FROM principals WHERE service_shop_ref=$1',[f.shop])).rows[0].n,1);
 assert.deepEqual(await state(f),{buyer_payment:'cancelled',request_sha256:f.requestDigest,reserved:0,receipts:1,journals:1,payments:0});
});

test('explicit legacy cancellation gains no fake service facts; later bound replay does not invent a transition',async()=>{
 const f=await fixture(),compat=createApp(pool,origin,'local',{shopKeyPolicy:'legacy-compatible'});
 assert.equal((await cancel(f,f.token,{app:compat})).status,200);assert.equal((await state(f)).journals,0);assert.equal((await state(f)).receipts,0);
 const token=await issue(f);assert.equal((await cancel(f,token)).status,200);assert.equal((await state(f)).journals,0);assert.equal((await state(f)).receipts,1);
});

for(const sameCommunity of [false,true])test(`current own target ACL precedes receipt; ${sameCommunity?'same':'different'} community shop cannot cancel or disclose one`,async()=>{
 const f=await fixture(),other=await fixture(pool,sameCommunity?f.community:undefined),token=await issue(f),otherToken=await issue(other),before=await state(f);
 assert.equal((await cancel(f,otherToken)).status,404);assert.deepEqual(await state(f),before);
 assert.equal((await cancel(f,token)).status,200);assert.equal((await cancel(f,otherToken)).status,404);
 const p=(await pool.query('SELECT * FROM principals WHERE service_shop_ref=$1',[f.shop])).rows[0];
 const m=await mapping(f);
 await assert.rejects(()=>transaction(pool,q=>scopedJournal(q,{subject_principal:{principal_id:p.principal_id,kind:'service'},scope:{scope_id:m.scope_id,kind:'site'},authn_kind:'shop_service_key'},
  {aggregate_type:'commerce_order_cancellation',id:f.order,version:2,operation:'shop.order.cancel'})),{code:'scoped_context_required'});
});

for(const barrier of ['principal-row','scope-row','target-row','receipt-select','receipt-insert','journal-insert'] as const){
 for(const deadline of [false,true])test(`${barrier}: ${deadline?'expired service denies with atomic rollback':'valid service completes and replay remains safe'}`,async()=>{
  const f=await fixture(),token=await issue(f);assert.equal((await connection(token)).status,200);const identity=await mapping(f),before=await state(f);
  const blocker=await pool.connect(),suffix=randomUUID().replaceAll('-',''),trigger='fp_wait_'+suffix,fn='fp_wait_fn_'+suffix,lock='shop-test/'+suffix;
  let pending:ReturnType<typeof cancel>|undefined,triggerTable:string|undefined;
  if(deadline)await pool.query("UPDATE commerce_shop_keys SET expires_at=clock_timestamp()+interval '1 second' WHERE shop_id=$1",[f.shop]);
  try{
   if(barrier==='receipt-insert'||barrier==='journal-insert'){
    triggerTable=barrier==='receipt-insert'?'scoped_command_receipts':'scoped_transition_journal';
    const column=barrier==='receipt-insert'?'target_id':'aggregate_id';
    await pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.${column}='${f.order}'::uuid THEN PERFORM pg_advisory_xact_lock(hashtextextended('${lock}',0)); END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON ${triggerTable} FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
   }
   await blocker.query('BEGIN');
   if(barrier==='principal-row')await blocker.query('SELECT principal_id FROM principals WHERE principal_id=$1 FOR UPDATE',[identity.principal_id]);
   else if(barrier==='scope-row')await blocker.query('SELECT scope_id FROM resource_scopes WHERE scope_id=$1 FOR UPDATE',[identity.scope_id]);
   else if(barrier==='target-row')await blocker.query('SELECT order_id FROM commerce_orders WHERE order_id=$1 FOR UPDATE',[f.order]);
   else if(barrier==='receipt-select')await blocker.query('LOCK TABLE scoped_command_receipts IN ACCESS EXCLUSIVE MODE');
   else await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[lock]);
   pending=cancel(f,token);await waitBlocked(blocker,barrier==='receipt-select'?'SELECT request_sha256,response FROM scoped_command_receipts%':barrier==='receipt-insert'?'INSERT INTO scoped_command_receipts%':barrier==='journal-insert'?'INSERT INTO scoped_transition_journal%':undefined);
   if(triggerTable)assert.equal((await blocker.query(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE relation=$1::regclass AND mode='RowExclusiveLock' AND granted AND pid<>pg_backend_pid()) held`,[schema+'.commerce_items'])).rows[0].held,true);
   if(deadline)await expire(f);else await delay(20);
   await blocker.query('COMMIT');const result=await pending;
   if(deadline){assert.equal(result.status,401,result.text);assert.equal(result.data.code,'shop_key_invalid');assert.deepEqual(await state(f),before);}
   else{assert.equal(result.status,200,result.text);assert.equal((await cancel(f,token)).status,200);assert.equal((await state(f)).journals,1);assert.equal((await state(f)).receipts,1);assert.equal((await state(f)).reserved,0);}
  }finally{await blocker.query('ROLLBACK');blocker.release();await pending;if(triggerTable){await pool.query(`DROP TRIGGER ${trigger} ON ${triggerTable}`);await pool.query(`DROP FUNCTION ${fn}()`);}}
 });
}

test('successful receipt cannot disclose after its actual SELECT wait crosses key expiry',async()=>{
 const f=await fixture(),token=await issue(f);assert.equal((await cancel(f,token)).status,200);const before=await state(f);
 await pool.query("UPDATE commerce_shop_keys SET expires_at=clock_timestamp()+interval '1 second' WHERE shop_id=$1",[f.shop]);
 const blocker=await pool.connect();let pending:ReturnType<typeof cancel>|undefined;
 try{await blocker.query('BEGIN');await blocker.query('LOCK TABLE scoped_command_receipts IN ACCESS EXCLUSIVE MODE');pending=cancel(f,token);
  await waitBlocked(blocker,'SELECT request_sha256,response FROM scoped_command_receipts%');await expire(f);await blocker.query('COMMIT');
  const result=await pending;assert.equal(result.status,401,result.text);assert.deepEqual(await state(f),before);
 }finally{await blocker.query('ROLLBACK');blocker.release();await pending;}
});

for(const change of ['key','principal','scope'] as const)test(`${change} revoke obtains row lock first: waiting service observes denial`,async()=>{
 const f=await fixture(),token=await issue(f);assert.equal((await connection(token)).status,200);const before=await state(f),m=await mapping(f),blocker=await pool.connect();
 let pending:ReturnType<typeof cancel>|undefined;
 try{await blocker.query('BEGIN');
  if(change==='key')await blocker.query('UPDATE commerce_shop_keys SET revoked_at=clock_timestamp() WHERE shop_id=$1',[f.shop]);
  if(change==='principal')await blocker.query("UPDATE principals SET status='disabled' WHERE principal_id=$1",[m.principal_id]);
  if(change==='scope')await blocker.query("UPDATE resource_scopes SET status='disabled' WHERE scope_id=$1",[m.scope_id]);
  pending=cancel(f,token);await waitBlocked(blocker);await blocker.query('COMMIT');assert.equal((await pending).status,401);assert.deepEqual(await state(f),before);
 }finally{await blocker.query('ROLLBACK');blocker.release();await pending;}
});

test('authorization that already holds the key share lock commits before queued revoke; later replay denies',async()=>{
 const f=await fixture(),token=await issue(f);assert.equal((await connection(token)).status,200);
 const blocker=await pool.connect(),revoker=await pool.connect();let pending:ReturnType<typeof cancel>|undefined,revocation:Promise<unknown>|undefined;
 try{await blocker.query('BEGIN');await blocker.query('SELECT order_id FROM commerce_orders WHERE order_id=$1 FOR UPDATE',[f.order]);
  pending=cancel(f,token);await waitBlocked(blocker);await revoker.query('BEGIN');
  revocation=revoker.query('UPDATE commerce_shop_keys SET revoked_at=clock_timestamp() WHERE shop_id=$1',[f.shop]);
  await until(async()=>Boolean((await admin.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE query LIKE 'UPDATE commerce_shop_keys SET revoked_at=clock_timestamp()%' AND wait_event_type='Lock') waiting")).rows[0].waiting),'revoke should wait behind the authorized key share lock');
  await blocker.query('COMMIT');assert.equal((await pending).status,200);await revocation;await revoker.query('COMMIT');
  assert.equal((await cancel(f,token)).status,401);assert.equal((await state(f)).journals,1);
 }finally{await blocker.query('ROLLBACK');blocker.release();await pending;await revocation;await revoker.query('ROLLBACK');revoker.release();}
});

test('DML cannot rebind a service fact to another site, member identity or execution token',async()=>{
 const f=await fixture(),g=await fixture(),token=await issue(f),other=await issue(g);assert.equal((await connection(token)).status,200);assert.equal((await connection(other)).status,200);
 const own=await mapping(f),wrong=await mapping(g),actor={...(await pool.query('SELECT * FROM users WHERE user_id=$1',[f.owner])).rows[0],session_hash:tokenHash(f.session),csrf_token:'synthetic'};
 const member=await withMemberScope(pool,{actor,scope:'personal'},async()=>{},async(_q,c)=>c);
 const insert=(principal:string,kind:string,scope:string,scopeKind:string,authn:string,execution:string|null=null)=>dml.query(`INSERT INTO scoped_command_receipts(principal_id,principal_kind,scope_id,scope_kind,authn_kind,operation,idempotency_key,target_kind,target_id,request_sha256,response,execution_authorization_id)
 VALUES($1,$2,$3,$4,$5,'shop.order.cancel',$6,'commerce_order',$7,$8,'{"cancelled":true}',$9)`,[principal,kind,scope,scopeKind,authn,randomUUID(),f.order,'a'.repeat(64),execution]);
 const denied=(e:unknown)=>['23514','23503'].includes((e as {code:string}).code);
 await assert.rejects(()=>insert(own.principal_id,'service',wrong.scope_id,'site','shop_service_key'),denied);
 await assert.rejects(()=>insert(own.principal_id,'service',member.scope.scope_id,'personal','shop_service_key'),denied);
 await assert.rejects(()=>insert(member.subject_principal.principal_id,'person',own.scope_id,'site','member_session'),denied);
 await assert.rejects(()=>insert(own.principal_id,'service',own.scope_id,'site','member_session'),denied);
 await assert.rejects(()=>insert(own.principal_id,'service',own.scope_id,'site','execution_token'),denied);
 await assert.rejects(()=>insert(own.principal_id,'service',own.scope_id,'site','shop_service_key',randomUUID()),denied);
 await assert.rejects(()=>insert(member.subject_principal.principal_id,'person',member.scope.scope_id,'personal','execution_token'),denied);
});
