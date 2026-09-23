import { test,before,after,beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool,LOCAL_DATABASE_URL,transaction } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal,DEMO_USERS,DEMO_PASSWORD } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { hashPassword,authenticate } from '../../modules/identity-membership/service.js';
import { getMarketingProductSource } from '../../modules/catalog-commerce/service.js';

const origin='http://127.0.0.1:4310',databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_commerce_test_${process.pid}_${Date.now()}`,admin=createPool(databaseUrl);
const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:12});
const app=createApp(pool,origin);
type Session={cookie:string;csrf:string;user:any};
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{await pool.query('TRUNCATE communities,login_attempts CASCADE');await seedLocal(pool);});
async function request(path:string,s?:Session,body?:unknown,version?:string|number,key=randomUUID(),extra:Record<string,string>={}){
  const headers:Record<string,string>={Origin:origin,...(s?{Cookie:s.cookie,'X-CSRF-Token':s.csrf}:{}),...extra};
  if(body!==undefined){headers['Content-Type']='application/json';headers['Idempotency-Key']=key;if(version)headers['If-Match']=`"${version}"`;}
  const response=await app.request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json() as any,response};
}
async function login(email=DEMO_USERS[0].email):Promise<Session>{const r=await request('/auth/login',undefined,{email,password:DEMO_PASSWORD});assert.equal(r.status,200,JSON.stringify(r.data));return {cookie:r.response.headers.get('set-cookie')!.split(';')[0],csrf:r.data.csrf_token,user:r.data.user};}
const productBody={title:'合成茶葉 150g',photo_url:'https://example.com/tea.jpg',specifications:'供測試的茶葉；非真實供貨',net_price_minor:30000,currency:'TWD',availability:'finite',stock:25,shipping_terms:'確認後三天宅配；運費另議',return_terms:'瑕疵請聯絡供貨者'};
const storeBody={name:'合成選物店',description:'社群選品演練',support_contact:'客服請聯絡店主'};
async function product(s:Session){const r=await request('/supplier/products',s,productBody);assert.equal(r.status,201,JSON.stringify(r.data));return r.data;}
async function store(s:Session){const r=await request('/retail/stores',s,storeBody);assert.equal(r.status,201,JSON.stringify(r.data));return r.data;}
async function listing(seller:Session,p:any,st:any){const r=await request('/retail/listings',seller,{store_id:st.store_id,offer_version_id:p.current_offer.offer_version_id,retail_price_minor:45000,sale_terms:'茶葉宅配；客服由本店負責'});assert.equal(r.status,201,JSON.stringify(r.data));return r.data;}
async function pending(supplier:Session,seller:Session){const p=await product(supplier),st=await store(seller),l=await listing(seller,p,st);const r=await request(`/retail/listings/${l.listing_id}:request-supply`,seller,{snapshot_sha256:l.snapshot_sha256},l.aggregate_version);assert.equal(r.status,200,JSON.stringify(r.data));return {p,st,l:r.data,acceptance:(await request('/supplier/requests',supplier)).data.items[0]};}
const decision=(a:any)=>({snapshot_sha256:a.snapshot_sha256,decision:'accepted',note:'已核對售價，演練確認。',acknowledge_internal_preview:true});

test('physical supply → independent store → immutable listing → supplier decision survives application restart',async()=>{
  const supplier=await login(),seller=await login(DEMO_USERS[2].email),{p,st,l,acceptance:a}=await pending(supplier,seller);
  assert.equal(p.qc_status,'unreviewed');assert.equal(p.official,false);assert.equal(st.seller_ref,seller.user.user_id);
  const result=await request(`/supplier/requests/${a.acceptance_id}:decide`,supplier,decision(a),a.aggregate_version);
  assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.state,'accepted');assert.equal(result.data.confirmation_kind,'internal_preview');assert.equal(result.data.official,false);assert.equal(result.data.checkout_enabled,false);assert.equal(result.data.money_movement_enabled,false);
  const fresh=createApp(pool,origin),response=await fresh.request(origin+'/api/v1/retail/listings',{headers:{Cookie:seller.cookie}});
  const persisted:any=await response.json();assert.equal(persisted.items[0].state,'accepted');assert.equal(persisted.items[0].snapshot_sha256,l.snapshot_sha256);
  assert.equal(persisted.items[0].snapshot.supply.net_price_minor,30000);assert.equal(persisted.items[0].snapshot.retail_price_minor,45000);
  assert.equal((await request('/supplier/products',seller)).data.items.length,0);assert.equal((await request('/retail/stores',supplier)).data.items.length,0);
  assert.equal((await request('/orders',seller,{})).status,404);
});

test('product and supply snapshot commit once under concurrent idempotent retries; changed payload conflicts',async()=>{
  const supplier=await login(),key=randomUUID();
  const results=await Promise.all([request('/supplier/products',supplier,productBody,undefined,key),request('/supplier/products',supplier,productBody,undefined,key)]);
  assert.equal(results[0].status,201);assert.deepEqual(results[0].data,results[1].data);
  assert.equal((await pool.query('SELECT count(*) FROM catalog_products')).rows[0].count,'1');
  assert.equal((await pool.query('SELECT count(*) FROM supplier_offer_versions')).rows[0].count,'1');
  assert.equal((await request('/supplier/products',supplier,{...productBody,title:'不同商品'},undefined,key)).data.code,'idempotency_conflict');
});

test('requests use optimistic version and exact digest; races cannot create two acceptances',async()=>{
  const supplier=await login(),seller=await login(DEMO_USERS[2].email),p=await product(supplier),st=await store(seller),l=await listing(seller,p,st),path=`/retail/listings/${l.listing_id}:request-supply`;
  assert.equal((await request(path,seller,{snapshot_sha256:l.snapshot_sha256})).status,428);
  assert.equal((await request(path,seller,{snapshot_sha256:'a'.repeat(64)},l.aggregate_version)).data.code,'snapshot_changed');
  const outcomes=await Promise.all([request(path,seller,{snapshot_sha256:l.snapshot_sha256},l.aggregate_version),request(path,seller,{snapshot_sha256:l.snapshot_sha256},l.aggregate_version)]);
  assert.deepEqual(outcomes.map(r=>r.status).sort(),[200,412]);assert.equal((await pool.query('SELECT count(*) FROM distribution_acceptances')).rows[0].count,'1');
});

test('supplier decisions bind exact snapshot, reject seller or third party, and replay only once',async()=>{
  const supplier=await login(),seller=await login(DEMO_USERS[2].email),other=await login(DEMO_USERS[1].email),{acceptance:a}=await pending(supplier,seller),path=`/supplier/requests/${a.acceptance_id}:decide`;
  for(const unauthorized of [seller,other])assert.equal((await request(path,unauthorized,decision(a),a.aggregate_version)).status,404);
  assert.equal((await request(path,supplier,{...decision(a),snapshot_sha256:'b'.repeat(64)},a.aggregate_version)).data.code,'snapshot_changed');
  assert.equal((await request(path,supplier,{...decision(a),acknowledge_internal_preview:false},a.aggregate_version)).status,422);
  const key=randomUUID(),accepted=await request(path,supplier,decision(a),a.aggregate_version,key);
  assert.equal(accepted.status,200);assert.deepEqual((await request(path,supplier,decision(a),a.aggregate_version,key)).data,accepted.data);
  assert.equal((await request(path,supplier,decision(a),a.aggregate_version)).status,412);
  assert.equal((await pool.query("SELECT count(*) FROM transition_journal WHERE aggregate_type='distribution_acceptance'")).rows[0].count,'1');
});

test('revised supply terms cannot overwrite a pinned listing or immutable database snapshots',async()=>{
  const supplier=await login(),seller=await login(DEMO_USERS[2].email),{p,l}=await pending(supplier,seller);
  const offerBody={net_price_minor:35000,currency:'TWD',availability:'manual_confirmation',stock:null,shipping_terms:'接單後確認出貨日',return_terms:'請聯絡供貨者'};
  assert.equal((await request(`/supplier/products/${p.product_id}/offer-versions`,seller,offerBody,p.aggregate_version)).status,404);
  const result=await request(`/supplier/products/${p.product_id}/offer-versions`,supplier,offerBody,p.aggregate_version);assert.equal(result.status,201,JSON.stringify(result.data));assert.equal(result.data.current_offer.revision,2);
  const persisted=(await request('/retail/listings',seller)).data.items[0];assert.equal(persisted.snapshot.supply.net_price_minor,30000);assert.equal(persisted.snapshot_sha256,l.snapshot_sha256);
  assert.equal(Number((await request('/retail/catalog',seller)).data.items[0].current_offer.net_price_minor),35000);
  await assert.rejects(pool.query('UPDATE supplier_offer_versions SET net_price_minor=1 WHERE offer_version_id=$1',[p.current_offer.offer_version_id]),/immutable/);
  await assert.rejects(pool.query('UPDATE retail_listing_revisions SET retail_price_minor=1 WHERE listing_id=$1',[l.listing_id]),/immutable/);
});

test('cross-community reads, stores, supplier offers and mutation references are isolated',async()=>{
  const supplier=await login(),p=await product(supplier),st=await store(supplier),l=await listing(supplier,p,st);
  const community=randomUUID(),user=randomUUID();await pool.query('INSERT INTO communities VALUES($1,$2)',[community,'其他社群']);
  await pool.query('INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) VALUES($1,$2,$3,$4,$5,$6)',[user,community,'outsider@local.test','其他社群會員',hashPassword(DEMO_PASSWORD),randomUUID()]);
  const outsider=await login('outsider@local.test'),outsideStore=await store(outsider);
  assert.deepEqual((await request('/retail/catalog',outsider)).data.items,[]);assert.deepEqual((await request('/retail/listings',outsider)).data.items,[]);
  assert.equal((await request('/retail/listings',outsider,{store_id:outsideStore.store_id,offer_version_id:p.current_offer.offer_version_id,retail_price_minor:50000,sale_terms:'不可讀取他人社群'})).status,404);
  assert.equal((await request(`/retail/listings/${l.listing_id}:request-supply`,outsider,{snapshot_sha256:l.snapshot_sha256},l.aggregate_version)).status,404);
});

test('untrusted amounts, authority fields and unsafe photo URLs are rejected without partial data',async()=>{
  const supplier=await login();
  for(const delta of [{net_price_minor:1.2},{net_price_minor:100000000001},{stock:-1},{availability:'manual_confirmation',stock:1},{official:true},{photo_url:'javascript:alert(1)'},{photo_url:'https://user:password@example.com/a'},{photo_url:'https://127.0.0.1/a'},{photo_url:'https://localhost/a'}]){
    const r=await request('/supplier/products',supplier,{...productBody,...delta});assert.equal(r.status,422,JSON.stringify(delta));
  }
  assert.equal((await pool.query('SELECT count(*) FROM catalog_products')).rows[0].count,'0');
  assert.equal((await request('/supplier/products',supplier,productBody,undefined,randomUUID(),{'X-CSRF-Token':'forged'})).status,403);
});

test('failure during journal write rolls back product, offer and idempotency receipt atomically',async()=>{
  const supplier=await login();
  await pool.query("CREATE FUNCTION reject_commerce_journal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.aggregate_type='catalog_product' THEN RAISE EXCEPTION 'test journal unavailable'; END IF; RETURN NEW; END; $$");
  await pool.query('CREATE TRIGGER reject_commerce_journal BEFORE INSERT ON transition_journal FOR EACH ROW EXECUTE FUNCTION reject_commerce_journal()');
  try{assert.equal((await request('/supplier/products',supplier,productBody)).status,500);assert.equal((await pool.query('SELECT count(*) FROM catalog_products')).rows[0].count,'0');assert.equal((await pool.query('SELECT count(*) FROM supplier_offer_versions')).rows[0].count,'0');assert.equal((await pool.query('SELECT count(*) FROM command_receipts')).rows[0].count,'0');}
  finally{await pool.query('DROP TRIGGER reject_commerce_journal ON transition_journal');await pool.query('DROP FUNCTION reject_commerce_journal()');}
});

test('marketing application port only returns owner-scoped declared product facts',async()=>{
  const supplier=await login(),seller=await login(DEMO_USERS[2].email),p=await product(supplier);
  const actor=await authenticate(pool,supplier.cookie.split('=')[1]),other=await authenticate(pool,seller.cookie.split('=')[1]);
  const source=await transaction(pool,q=>getMarketingProductSource(q,actor,p.product_id));assert.equal(source.source_id,p.product_id);assert.equal(source.source_sha256,p.current_offer.snapshot_sha256);assert.equal(source.qc_status,'unreviewed');assert.equal(source.checkout_enabled,false);
  await assert.rejects(transaction(pool,q=>getMarketingProductSource(q,other,p.product_id)),/找不到/);
});
