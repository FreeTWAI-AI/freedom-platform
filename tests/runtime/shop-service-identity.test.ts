import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {migrate} from '../../scripts/database.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {tokenHash} from '../../modules/identity-membership/service.js';
import {withMemberScope} from '../../packages/resource-scopes/index.js';
import {assertShopServiceClock,lockShopService,forgetShopService,shopServiceHost,type ShopContext} from '../../packages/resource-scopes/shop-service.js';
import {transaction} from '../../packages/db/index.js';
import {createPrivateAiProductTransport} from '../../apps/platform-api/src/private-ai-product.js';
import {createPrivateWorkCommands} from '../../modules/opportunity-project-work/private-commands.js';
import {createPrivateResultService} from '../../modules/autopilot-work/results.js';
import {resolvePrivateWorkPersistencePolicy} from '../../modules/autopilot-work/policy.js';
import {FakeObjectStore} from '../../packages/asset-storage/fake-store.js';
import {sha256,type AssetObjectKey,type PreparedRepresentation} from '../../packages/asset-storage/index.js';

const configured=process.env.TEST_DATABASE_URL;
assert(configured,'Explicit disposable TEST_DATABASE_URL required');
const url=new URL(configured);assert.match(url.pathname,/^\/fp_[a-z0-9_]+$/);assert(['localhost','127.0.0.1','[::1]'].includes(url.hostname));
const schema='fp_shop_service_'+randomUUID().replaceAll('-',''),cloneSchema='fp_shop_clone_'+randomUUID().replaceAll('-','');
const admin=new Pool({connectionString:url.href}),pool=new Pool({connectionString:url.href,options:`-c search_path=${schema} -c statement_timeout=10000`,max:10});
const clone=new Pool({connectionString:url.href,options:`-c search_path=${cloneSchema} -c statement_timeout=10000`,max:4});
const origin='http://127.0.0.1:4310',app=createApp(pool,origin,'local',{shopKeyPolicy:'purpose-bound-only'});
let created=false,cloneCreated=false;
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);created=true;await migrate(pool);await admin.query(`CREATE SCHEMA ${cloneSchema}`);cloneCreated=true;await migrate(clone);});
after(async()=>{await pool.end();await clone.end();if(created)await admin.query(`DROP SCHEMA ${schema} CASCADE`);if(cloneCreated)await admin.query(`DROP SCHEMA ${cloneSchema} CASCADE`);await admin.end();});
async function fixture(target=pool){
 const community=randomUUID(),owner=randomUUID(),shop=randomUUID(),internal=randomUUID(),item=randomUUID(),selection=randomUUID(),order=randomUUID(),transfer=randomUUID();
 const token='fw_shop_'+randomBytes(32).toString('base64url'),requestDigest='a'.repeat(64),session=randomBytes(32).toString('base64url');
 await target.query("INSERT INTO communities VALUES($1,'Synthetic expiry')",[community]);
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

test('explicit owner issuance binds one real service/site; raw key shown once and mappings distinct from person',async()=>{
 const f=await fixture(),key=randomUUID(),token=await issue(f,{key});
 assert.equal((await request(`/api/v1/commerce/shops/${f.shop}/key`,{session:f.session,body:{},key})).data.token,null);
 assert.equal((await connection(f.token)).status,401);assert.equal((await connection(token)).status,200);
 const row=(await pool.query(`SELECT p.principal_id,p.kind,p.user_ref,p.service_shop_ref,s.scope_id,s.kind scope_kind,s.owner_principal_id,s.site_shop_ref,s.service_principal_id
 FROM principals p JOIN resource_scopes s ON s.service_principal_id=p.principal_id WHERE p.service_shop_ref=$1`,[f.shop])).rows[0];
 assert.equal(row.kind,'service');assert.equal(row.user_ref,null);assert.equal(row.service_shop_ref,f.shop);assert.equal(row.scope_kind,'site');
 assert.equal(row.owner_principal_id,null);assert.equal(row.site_shop_ref,f.shop);assert.equal(row.service_principal_id,row.principal_id);assert.notEqual(row.principal_id,f.owner);
 const auth=(await pool.query('SELECT credential_profile,purpose,issuer,audience,environment FROM commerce_shop_keys WHERE shop_id=$1',[f.shop])).rows[0];
 assert.deepEqual(auth,{credential_profile:'freedom.shop-service-key/v1',purpose:'shop-api',issuer:origin,audience:origin+'/shop-api/v1',environment:'local'});
 const receipt=await pool.query('SELECT response FROM command_receipts WHERE user_id=$1',[f.owner]);assert(!JSON.stringify(receipt.rows).includes(token));
});

test('one candidate: explicit legacy upgrade preserves old key; unset/strict deny it, unconfigured cannot rotate it',async()=>{
 const f=await fixture(),compat=createApp(pool,origin,'local',{shopKeyPolicy:'legacy-compatible'}),missing=createApp(pool,origin);
 const before=(await pool.query('SELECT * FROM commerce_shop_keys WHERE shop_id=$1',[f.shop])).rows[0];
 assert.equal((await connection(f.token,{app:compat})).status,200);
 assert.equal((await connection(f.token)).status,401);
 assert.equal((await connection(f.token,{app:missing})).status,503);
 assert.equal((await request('/api/v1/commerce/shops',{app:missing,session:f.session})).status,200);
 assert.equal((await request(`/api/v1/commerce/shops/${f.shop}/key`,{app:missing,session:f.session,body:{}})).status,503);
 assert.deepEqual((await pool.query('SELECT * FROM commerce_shop_keys WHERE shop_id=$1',[f.shop])).rows[0],before);
 const token=await issue(f,{app:compat});assert.equal((await connection(token)).status,200);assert.equal((await connection(f.token,{app:compat})).status,401);
});

test('two installed environments reject cross-environment keys; cloned stamped backing does not rebind issuer',async()=>{
 const prodOrigin='https://shop-prod.example.invalid',stageOrigin='https://shop-stage.example.invalid';
 const prod=createApp(pool,prodOrigin,'public',{shopKeyPolicy:'purpose-bound-only'}),stage=createApp(clone,stageOrigin,'staging',{shopKeyPolicy:'purpose-bound-only'});
 const p=await fixture(),s=await fixture(clone),pt=await issue(p,{app:prod,origin:prodOrigin}),st=await issue(s,{app:stage,origin:stageOrigin});
 assert.equal((await connection(pt,{app:prod,origin:prodOrigin})).status,200);assert.equal((await connection(st,{app:stage,origin:stageOrigin})).status,200);
 assert.equal((await connection(pt,{app:stage,origin:stageOrigin})).status,401);assert.equal((await connection(st,{app:prod,origin:prodOrigin})).status,401);
 // Actual separate schema copies the stamped production key and its backing IDs;
 // this is an auth-record clone case, not a full backup/restore claim.
 for(const [table,column,value] of [['communities','community_id',p.community],['users','user_id',p.owner],['commerce_shops','shop_id',p.shop],['commerce_shop_keys','shop_id',p.shop]])
  await admin.query(`INSERT INTO ${cloneSchema}.${table} SELECT * FROM ${schema}.${table} WHERE ${column}=$1`,[value]);
 const denied=await connection(pt,{app:stage,origin:stageOrigin,headers:{Origin:prodOrigin,'X-Freedom-Env':'public'}});assert([401,403].includes(denied.status));
 assert.equal((await connection(pt,{app:stage,origin:stageOrigin})).status,401);
 assert.equal((await clone.query('SELECT count(*)::int n FROM principals WHERE service_shop_ref=$1',[p.shop])).rows[0].n,0);
});

for(const change of ['issuer','environment','profile'] as const)test('current '+change+' binding mismatch is denied without a service mapping',async()=>{
 const f=await fixture(),token=await issue(f);
 if(change==='issuer')await pool.query("UPDATE commerce_shop_keys SET issuer='https://other.example.invalid',audience='https://other.example.invalid/shop-api/v1' WHERE shop_id=$1",[f.shop]);
 else if(change==='environment')await pool.query("UPDATE commerce_shop_keys SET environment='staging' WHERE shop_id=$1",[f.shop]);
 else await pool.query("UPDATE commerce_shop_keys SET credential_profile='legacy-shop-key/v1',purpose=NULL,issuer=NULL,audience=NULL,environment=NULL WHERE shop_id=$1",[f.shop]);
 assert.equal((await connection(token)).status,401);assert.equal((await pool.query('SELECT count(*)::int n FROM principals WHERE service_shop_ref=$1',[f.shop])).rows[0].n,0);
});

for(const revoke of ['key','owner','principal','scope'] as const)test(revoke+' revocation blocks current service access and cannot be lazily re-enabled',async()=>{
 const f=await fixture(),token=await issue(f);assert.equal((await connection(token)).status,200);
 if(revoke==='key')await pool.query('UPDATE commerce_shop_keys SET revoked_at=clock_timestamp() WHERE shop_id=$1',[f.shop]);
 else if(revoke==='owner')await pool.query('UPDATE users SET active=false WHERE user_id=$1',[f.owner]);
 else if(revoke==='principal')await pool.query("UPDATE principals SET status='disabled' WHERE service_shop_ref=$1",[f.shop]);
 else await pool.query("UPDATE resource_scopes SET status='disabled' WHERE site_shop_ref=$1",[f.shop]);
 assert.equal((await connection(token)).status,401);assert.equal((await connection(token)).status,401);
});

test('site credential is neither member login nor owner private Work authority; forged current context rejected',async()=>{
 const f=await fixture(),token=await issue(f);assert.equal((await connection(token)).status,200);
 const actor={...(await pool.query('SELECT * FROM users WHERE user_id=$1',[f.owner])).rows[0],session_hash:tokenHash(f.session),csrf_token:'synthetic'};
 const personal=await withMemberScope(pool,{actor,scope:'personal'},async()=>{},async(_q,c)=>c),work=randomUUID();
 await pool.query(`INSERT INTO work_items(work_item_id,work_mode,scope_id,owner_principal_id,owner_ref,title,objective,state,participation_terms_revision)
 VALUES($1,'personal_execution',$2,$3,$4,'private synthetic title','private synthetic objective','draft',NULL)`,[work,personal.scope.scope_id,personal.subject_principal.principal_id,f.owner]);
 assert.equal((await request('/api/v1/me/private-work/'+work,{session:f.session})).status,200);
 for(const path of ['/api/v1/me/private-work','/api/v1/me/private-work/'+work,'/api/v1/me/private-work/'+work+'/results','/api/v1/me/private-work/'+work+'/export','/api/v1/me/avatar']){
  const result=await request(path,{token});assert.equal(result.status,401,result.text);assert(!result.text.includes('private synthetic'));
 }
 assert.equal((await request('/api/v1/me/private-work/'+work,{session:token})).status,401);
 assert.equal((await request('/shop-api/v1/connection',{session:f.session})).status,401);
 assert.equal((await request('/shop-api/v1/orders/'+f.order+'/cancel',{token,body:{principal_id:personal.subject_principal.principal_id,asset_id:randomUUID()}})).status,422);
 await assert.rejects(()=>transaction(pool,q=>assertShopServiceClock(q,{authn_kind:'legacy_shop_key',shop:{shop_id:f.shop,owner_id:f.owner,community_id:f.community}})),{code:'shop_key_invalid'});
 let old:ShopContext|undefined;
 await transaction(pool,async q=>{old=await lockShopService(q,'Bearer '+token,shopServiceHost('local',origin,'purpose-bound-only'));forgetShopService(old);});
 await assert.rejects(()=>transaction(pool,q=>assertShopServiceClock(q,old!)),{code:'shop_key_invalid'});
});

test('SQL backing shape rejects service impersonation, NULL binding bypass, cross-shop site and mapping transfer',async()=>{
 const f=await fixture(),other=await fixture(),token=await issue(f);assert.equal((await connection(token)).status,200);
 const principal=(await pool.query('SELECT principal_id FROM principals WHERE service_shop_ref=$1',[f.shop])).rows[0].principal_id;
 const code=(e:unknown)=>['23514','23503','23505'].includes((e as {code:string}).code);
 await assert.rejects(()=>pool.query("INSERT INTO principals(kind,user_ref,service_shop_ref) VALUES('service',$1,$2)",[other.owner,other.shop]),code);
 await assert.rejects(()=>pool.query("INSERT INTO principals(kind,service_shop_ref) VALUES('service',$1)",[randomUUID()]),code);
 await assert.rejects(()=>pool.query("INSERT INTO resource_scopes(kind,owner_principal_id) VALUES('personal',$1)",[principal]),code);
 await assert.rejects(()=>pool.query("INSERT INTO resource_scopes(kind,site_shop_ref,service_principal_id) VALUES('site',$1,$2)",[other.shop,principal]),code);
 await assert.rejects(()=>pool.query('UPDATE principals SET service_shop_ref=$1 WHERE principal_id=$2',[other.shop,principal]),code);
 await assert.rejects(()=>pool.query('DELETE FROM principals WHERE principal_id=$1',[principal]),code);
 for(const field of ['purpose','issuer','audience','environment'])await assert.rejects(()=>pool.query(`UPDATE commerce_shop_keys SET ${field}=NULL WHERE shop_id=$1`,[f.shop]),code);
});

test('valid site key cannot read or edit another actual member private Result/Asset through installed routes',async()=>{
 const website=await fixture(),victim=await fixture(),siteKey=await issue(website);assert.equal((await connection(siteKey)).status,200);
 const actor={...(await pool.query('SELECT * FROM users WHERE user_id=$1',[victim.owner])).rows[0],session_hash:tokenHash(victim.session),csrf_token:'synthetic'};
 const context=await withMemberScope(pool,{actor,scope:'personal'},async()=>{},async(_q,c)=>c);
 await pool.query(`INSERT INTO private_work_persistence_policy(scope_id,purpose,owner_principal_id,revision,persistence_allowed,retained_byte_limit)
  VALUES($1,'work.private-draft',$2,1,true,10485760)`,[context.scope.scope_id,context.subject_principal.principal_id]);
 class Store extends FakeObjectStore {gets=0;puts=0;
  override async get(key:AssetObjectKey){this.gets++;return super.get(key);}
  override async putImmutable(key:AssetObjectKey,representation:PreparedRepresentation){this.puts++;return super.putImmutable(key,representation);}
 }
 const store=new Store(),results=createPrivateResultService(pool,{store,resolvePolicy:resolvePrivateWorkPersistencePolicy});
 const work=await createPrivateWorkCommands(pool,{resolvePolicy:resolvePrivateWorkPersistencePolicy}).create(actor,{key:randomUUID(),title:'Another owner private work',objective:'Synthetic private objective'});
 const text='ANOTHER_OWNER_PRIVATE_ASSET_CONTENT',bytes=new TextEncoder().encode(text);
 const prepared=await results.prepare(actor,{key:randomUUID(),targetWorkId:work.workId,expectedVersion:'1',contentType:'text/plain',byteSize:bytes.length,sha256:await sha256(bytes)});
 const lease=await results.claim(actor,{key:randomUUID(),intentId:prepared.intentId}),binding={intentId:lease.intentId,fence:lease.fence,leaseToken:lease.leaseToken};
 await results.write(actor,{...binding,key:randomUUID()},new ReadableStream({start(c){c.enqueue(bytes);c.close();}}));
 const result=await results.finalize(actor,{...binding,key:randomUUID()});let providerCalls=0;
 const product=await createPrivateAiProductTransport(pool,{origin,environment:'local',clientId:'shop-service-acl-fixture',store,
  host:{async verify(){providerCalls++;throw Error('Unexpected model verification');},async dispatch(){providerCalls++;throw Error('Unexpected provider call');}}});
 const installed=createApp(pool,origin,'local',{shopKeyPolicy:'purpose-bound-only',privateAiProduct:product});
 const route=`/api/v1/me/private-work/${work.workId}/results/${result.resultId}`;
 const ownerRead=await request(route,{app:installed,session:victim.session});assert.equal(ownerRead.status,200,ownerRead.text);assert.equal(ownerRead.data.text,text);assert.equal(ownerRead.data.resultId,result.resultId);
 assert.equal((await pool.query('SELECT asset_id FROM private_work_result_catalog WHERE result_id=$1',[result.resultId])).rows[0].asset_id,result.assetId);
 const snapshot=async()=>{
  const values:Record<string,unknown>={};
  for(const table of ['work_items','assets','asset_objects','asset_upload_intents','private_work_results','private_work_result_targets','scoped_command_receipts','scoped_transition_journal','principals','resource_scopes','sessions'])
   values[table]=(await pool.query(`SELECT to_jsonb(t) value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  return values;
 };
 const before=await snapshot(),gets=store.gets,puts=store.puts;
 for(const path of [route,`/api/v1/me/private-work/${work.workId}/results/current`,route+'/edit']){
  const isEdit=path.endsWith('/edit'),denied=await request(path,{app:installed,token:siteKey,
   ...(isEdit?{body:{text:'unauthorized replacement'}}:{}),headers:{Origin:origin,'If-Match':'"2"','X-Freedom-Principal':context.subject_principal.principal_id}});
  assert.equal(denied.status,403,denied.text);assert.equal(denied.data.code,'credential_kind_rejected');assert(!denied.text.includes(text));
 }
 const loginForgery=await request(route,{app:installed,session:siteKey});assert.equal(loginForgery.status,401,loginForgery.text);
 assert.equal(store.gets,gets);assert.equal(store.puts,puts);assert.equal(providerCalls,0);assert.deepEqual(await snapshot(),before);
 // Both requested read and mutation routes really exist: the actual owner can
 // read those same stored bytes and create the next immutable human revision.
 const unchanged=await results.readResult(actor,{workId:work.workId,resultId:result.resultId});assert.equal(unchanged?.text,text);
 const validEdit=await request(route+'/edit',{app:installed,session:victim.session,body:{text:'Explicit owner edit'},headers:{'If-Match':'"2"'}});
 assert.equal(validEdit.status,200,validEdit.text);assert.equal(validEdit.data.revision,'2');assert.notEqual(validEdit.data.assetId,result.assetId);
 assert.equal((await results.readResult(actor,{workId:work.workId,resultId:result.resultId}))?.text,text);assert.equal(providerCalls,0);
});
