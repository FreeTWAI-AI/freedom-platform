import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool,type PoolClient} from 'pg';
import {migrate} from '../../scripts/database.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {tokenHash} from '../../modules/identity-membership/service.js';

// Explicit isolated fixture only. This test never discovers an application DB.
const configured=process.env.TEST_DATABASE_URL;
assert(configured,'Explicit disposable TEST_DATABASE_URL required');
const url=new URL(configured);assert.match(url.pathname,/^\/fp_[a-z0-9_]+$/);assert(['localhost','127.0.0.1','[::1]'].includes(url.hostname));
const schema='fp_shop_key_'+randomUUID().replaceAll('-','');
const admin=new Pool({connectionString:url.href}),pool=new Pool({connectionString:url.href,options:`-c search_path=${schema} -c statement_timeout=10000`,max:6});
const origin='http://127.0.0.1:4310',app=createApp(pool,origin);let created=false;
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);created=true;await migrate(pool);});
after(async()=>{await pool.end();if(created)await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
async function fixture(){
 const community=randomUUID(),owner=randomUUID(),shop=randomUUID(),internal=randomUUID(),item=randomUUID(),selection=randomUUID(),order=randomUUID(),transfer=randomUUID();
 const token='fw_shop_'+randomBytes(32).toString('base64url'),requestDigest='a'.repeat(64);
 await pool.query("INSERT INTO communities VALUES($1,'Synthetic expiry')",[community]);
 await pool.query("INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) VALUES($1,$2,$3,'Synthetic owner','not-a-login-hash',$4)",[owner,community,owner+'@example.invalid',randomUUID()]);
 for(const [id,kind] of [[shop,'public'],[internal,'internal']])await pool.query(`INSERT INTO commerce_shops(shop_id,community_id,owner_id,kind,name,description,website_url,contact,currency,manifest_sha256)
  VALUES($1,$2,$3,$4,'Synthetic','Synthetic','https://synthetic.example.com','Synthetic','TWD',$5)`,[id,community,owner,kind,id]);
 await pool.query("INSERT INTO commerce_shop_keys(shop_id,token_hash,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[shop,tokenHash(token)]);
 await pool.query("INSERT INTO commerce_items(item_id,shop_id,sku,title,description,price_minor,shipping_minor,stock,reserved,shipping_terms,return_terms) VALUES($1,$2,'synthetic','Synthetic','Synthetic',100,0,5,1,'Synthetic','Synthetic')",[item,internal]);
 await pool.query("INSERT INTO commerce_selections(selection_id,shop_id,item_id,retail_price_minor,sale_terms,snapshot) VALUES($1,$2,$3,100,'Synthetic','{}')",[selection,shop,item]);
 await pool.query("INSERT INTO commerce_orders(order_id,public_shop_id,external_id,request_sha256,currency,total_minor) VALUES($1,$2,$3,$4,'TWD',100)",[order,shop,randomUUID(),requestDigest]);
 await pool.query("INSERT INTO commerce_transfers(transfer_id,order_id,internal_shop_id,total_minor,delivery_ref) VALUES($1,$2,$3,100,'synthetic_reference')",[transfer,order,internal]);
 await pool.query("INSERT INTO commerce_order_lines(order_id,selection_id,transfer_id,item_id,quantity,snapshot) VALUES($1,$2,$3,$4,1,'{}')",[order,selection,transfer,item]);
 return {community,owner,shop,item,order,token,requestDigest};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function request(f:Fixture,read=false){
 const path=read?'/shop-api/v1/connection':`/shop-api/v1/orders/${f.order}/cancel`;
 const response=await app.request(origin+path,{method:read?'GET':'POST',headers:{Authorization:'Bearer '+f.token,...(read?{}:{'Content-Type':'application/json'})},...(read?{}:{body:'{}'})});
 return {status:response.status,data:await response.json() as {code?:string;cancelled?:boolean;shop_id?:string}};
}
async function state(f:Fixture){return (await pool.query(`SELECT o.buyer_payment,o.request_sha256,i.reserved,
 (SELECT count(*)::int FROM commerce_payment_events WHERE shop_id=$3) events
 FROM commerce_orders o,commerce_items i WHERE o.order_id=$1 AND i.item_id=$2`,[f.order,f.item,f.shop])).rows[0];}
async function until(test:()=>Promise<boolean>,message:string){
 for(let n=0;n<400;n++){if(await test())return;await delay(10);}assert.fail(message);
}
async function waitBlocked(blocker:PoolClient){const pid=(await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
 await until(async()=>Boolean((await admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) waiting',[pid])).rows[0].waiting),'expected actual database lock wait');}
async function expired(f:Fixture){await until(async()=>Boolean((await pool.query('SELECT expires_at<=clock_timestamp() expired FROM commerce_shop_keys WHERE shop_id=$1',[f.shop])).rows[0].expired),'database deadline did not pass');}
function unchanged(f:Fixture,value:Awaited<ReturnType<typeof state>>){assert.deepEqual(value,{buyer_payment:'pending',request_sha256:f.requestDigest,reserved:1,events:0});}

for(const barrier of ['owner-row','key-row','community-advisory','domain-write'] as const){
 for(const shouldExpire of [false,true])test(`${barrier}: ${shouldExpire?'expired key denies and rolls back':'live key still completes and replays'}`,async()=>{
  const f=await fixture(),blocker=await pool.connect();let pending:ReturnType<typeof request>|undefined;
  if(shouldExpire)await pool.query("UPDATE commerce_shop_keys SET expires_at=clock_timestamp()+interval '1 second' WHERE shop_id=$1",[f.shop]);
  try{
   await blocker.query('BEGIN');
   if(barrier==='owner-row')await blocker.query('SELECT user_id FROM users WHERE user_id=$1 FOR UPDATE',[f.owner]);
   else if(barrier==='key-row')await blocker.query('SELECT shop_id FROM commerce_shop_keys WHERE shop_id=$1 FOR UPDATE',[f.shop]);
   else if(barrier==='community-advisory')await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`commerce-orders/${f.community}`]);
   else await blocker.query('LOCK TABLE commerce_orders IN SHARE MODE');
   pending=request(f);await waitBlocked(blocker);
   // domain-write permits the real reservation release, then blocks the final
   // order UPDATE. This proves rollback after an actual domain mutation wait.
   if(barrier==='domain-write')assert.equal((await blocker.query(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE relation=$1::regclass AND mode='RowExclusiveLock' AND granted AND pid<>pg_backend_pid()) held`,[schema+'.commerce_items'])).rows[0].held,true);
   if(shouldExpire)await expired(f);else await delay(30);
   await blocker.query('COMMIT');const result=await pending;
   if(shouldExpire){assert.equal(result.status,401);assert.equal(result.data.code,'shop_key_invalid');unchanged(f,await state(f));}
   else{assert.equal(result.status,200);assert.deepEqual(result.data,{cancelled:true});assert.deepEqual((await request(f)).data,{cancelled:true});
    assert.deepEqual(await state(f),{buyer_payment:'cancelled',request_sha256:f.requestDigest,reserved:0,events:0});}
  }finally{await blocker.query('ROLLBACK');blocker.release();await pending;}
 });
}
for(const replay of [false,true])test(`community wait rejects expired ${replay?'successful domain replay':'connection read'} without reviving or changing effects`,async()=>{
 const f=await fixture();if(replay)assert.equal((await request(f)).status,200);
 const before=await state(f);await pool.query("UPDATE commerce_shop_keys SET expires_at=clock_timestamp()+interval '1 second' WHERE shop_id=$1",[f.shop]);
 const blocker=await pool.connect();let pending:ReturnType<typeof request>|undefined;
 try{await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`commerce-orders/${f.community}`]);
  pending=request(f,!replay);await waitBlocked(blocker);await expired(f);await blocker.query('COMMIT');
  const result=await pending;assert.equal(result.status,401);assert.equal(result.data.code,'shop_key_invalid');assert.deepEqual(await state(f),before);
 }finally{await blocker.query('ROLLBACK');blocker.release();await pending;}
});
