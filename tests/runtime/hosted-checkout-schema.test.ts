import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {after,before,beforeEach,test} from 'node:test';
import {Pool} from 'pg';
import {readMigrationSources} from '../../packages/db/migration-files.mjs';
import {legacyMigrationProfile} from '../../packages/db/migration-plan.mjs';
import {runMigrationPlan} from '../../packages/db/migration-runner.mjs';
import {seedLocal,DEMO_COMMUNITY,DEMO_USERS} from '../../packages/testing/seed.js';
import {applyConfirmedPayment,recordHandover,cancelPaidOrder,cancelUnpaidOrder} from '../../modules/agent-commerce/checkout/index.js';
import {lockStore} from '../../modules/agent-commerce/checkout/authority.js';
import {checkoutHarness,code,type CheckoutHarness} from './hosted-checkout-harness.js';
let x:CheckoutHarness;
before(async()=>{x=await checkoutHarness('fp_checkout_schema');});beforeEach(async()=>x.reset());after(async()=>x?.stop());
const reject=(sql:string,params:unknown[]=[],expected='23514')=>assert.rejects(x.tx(q=>q.query(sql,params)),code(expected));
async function allocated(){const s=await x.store(),o=await x.place(s,await x.frozen(s));await x.tx(q=>applyConfirmedPayment(q,{orderId:o.order_id,paymentRef:randomUUID(),amountMinor:500,currency:'TWD',simulated:false}));return {s,o};}

test('old writer changing reserved alone fails at COMMIT and rolls back its entire transaction',async()=>{
  const s=await x.store();const q=await x.runtime.connect();
  try{
    await q.query('BEGIN');await q.query('UPDATE commerce_items SET reserved=1,title=$2 WHERE item_id=$1',[s.product.product_id,'不應留下的合成修改']);
    await assert.rejects(q.query('COMMIT'),code('23514'));
  }finally{await q.query('ROLLBACK');q.release();}
  const row=(await x.h.pool.query('SELECT reserved,title FROM commerce_items WHERE item_id=$1',[s.product.product_id])).rows[0];assert.deepEqual(row,{reserved:0,title:'合成商品'});
});
test('allocation identity cannot be rewritten/deleted, counters cannot decrease or exceed quantity, and counters require events',async()=>{
  const {s,o}=await allocated();
  for(const sql of ['DELETE FROM commerce_inventory_allocations WHERE order_id=$1','UPDATE commerce_inventory_allocations SET quantity=6 WHERE order_id=$1',
    'UPDATE commerce_inventory_allocations SET shipped_quantity=6 WHERE order_id=$1','UPDATE commerce_inventory_allocations SET shipped_quantity=1 WHERE order_id=$1'])await reject(sql,[o.order_id]);
  await x.tx(q=>recordHandover(q,s,{shipmentRef:randomUUID(),lines:[{orderId:o.order_id,itemId:s.product.product_id,quantity:2}]}));
  await reject('UPDATE commerce_inventory_allocations SET shipped_quantity=1 WHERE order_id=$1',[o.order_id]);
  assert.equal((await x.h.pool.query('SELECT shipped_quantity FROM commerce_inventory_allocations WHERE order_id=$1',[o.order_id])).rows[0].shipped_quantity,2);
});
test('a held reservation and an allocation cannot coexist even with a balanced reserved value and movement',async()=>{
  const s=await x.store(),o=await x.place(s,await x.frozen(s));
  await assert.rejects(x.tx(async q=>{
    const app=(await q.query(`INSERT INTO commerce_checkout_payment_applications(order_id,payment_ref,amount_minor,currency,outcome) VALUES($1,$2,500,'TWD','allocated') RETURNING application_id`,[o.order_id,randomUUID()])).rows[0];
    const a=(await q.query(`INSERT INTO commerce_inventory_allocations(order_id,item_id,supplier_shop_id,quantity,payment_application_id) VALUES($1,$2,$3,5,$4) RETURNING allocation_id`,[o.order_id,s.product.product_id,s.supply_shop_id,app.application_id])).rows[0];
    await q.query(`INSERT INTO commerce_inventory_movements(kind,item_id,order_id,allocation_id,source_ref,quantity,delta_stock,delta_reserved) VALUES('allocate',$1,$2,$3,$4,5,0,5)`,[s.product.product_id,o.order_id,a.allocation_id,app.application_id]);
    await q.query('UPDATE commerce_items SET reserved=10 WHERE item_id=$1',[s.product.product_id]);
  }),code('23514'));
  assert.equal((await x.h.pool.query('SELECT count(*)::int n FROM commerce_inventory_allocations')).rows[0].n,0);
});
test('line bindings are enforced at COMMIT, beyond balanced holds and allocation rules',async()=>{
  const s=await x.store(),original=await x.place(s,await x.frozen(s));
  await assert.rejects(x.tx(async q=>{
    const id=randomUUID(),client=randomUUID();
    await q.query(`INSERT INTO commerce_orders(order_id,public_shop_id,external_id,request_sha256,currency,total_minor,created_at,expires_at,order_profile,client_order_id)
      SELECT $2,public_shop_id,'chk:'||co.checkout_id::text||':'||$3::text,request_sha256,currency,total_minor,t,t+interval '30 minutes','hosted_checkout',$3::uuid
      FROM commerce_orders o JOIN commerce_checkout_orders co USING(order_id) CROSS JOIN (SELECT clock_timestamp() t) n WHERE o.order_id=$1`,[original.order_id,id,client]);
    await q.query(`INSERT INTO commerce_checkout_orders(order_id,tenant_id,instance_id,checkout_id,customer_id,contact_id,display_number,terms,terms_sha256,environment)
      SELECT $2,co.tenant_id,co.instance_id,co.checkout_id,co.customer_id,co.contact_id,to_char(o.created_at AT TIME ZONE 'Asia/Taipei','YYMMDD')||'-ABCDEF',co.terms,co.terms_sha256,co.environment
      FROM commerce_checkout_orders co JOIN commerce_orders o ON o.order_id=$2 WHERE co.order_id=$1`,[original.order_id,id]);
    await q.query(`INSERT INTO commerce_order_lines(order_id,selection_id,item_id,quantity,snapshot,order_profile,supplier_shop_id)
      SELECT $2,selection_id,item_id,2,snapshot,order_profile,supplier_shop_id FROM commerce_order_lines WHERE order_id=$1`,[original.order_id,id]);
    await q.query(`INSERT INTO commerce_inventory_reservations(order_id,item_id,supplier_shop_id,quantity,state,created_at,expires_at)
      SELECT o.order_id,l.item_id,l.supplier_shop_id,l.quantity,'held',o.created_at,o.expires_at FROM commerce_orders o JOIN commerce_order_lines l USING(order_id) WHERE o.order_id=$1`,[id]);
    await q.query('UPDATE commerce_items SET reserved=reserved+2 WHERE item_id=$1',[s.product.product_id]);
  }),code('23514'));
  assert.equal((await x.h.pool.query('SELECT count(*)::int n FROM commerce_orders')).rows[0].n,1);
});
test('checkout orders and lines are immutable and lifecycle has exactly one terminal transition',async()=>{
  const s=await x.store(),o=await x.place(s,await x.frozen(s));
  await reject('UPDATE commerce_orders SET total_minor=total_minor WHERE order_id=$1',[o.order_id]);
  await reject('DELETE FROM commerce_orders WHERE order_id=$1',[o.order_id]);
  await reject('UPDATE commerce_order_lines SET quantity=quantity WHERE order_id=$1',[o.order_id]);
  await reject('DELETE FROM commerce_order_lines WHERE order_id=$1',[o.order_id]);
  await reject('UPDATE commerce_checkout_orders SET terms_sha256=terms_sha256 WHERE order_id=$1',[o.order_id]);
  await x.tx(q=>cancelUnpaidOrder(q,s,o.order_id,'buyer','buyer_cancelled'));
  await reject(`UPDATE commerce_checkout_orders SET lifecycle_state='closed',cancel_reason=NULL,cancelled_at=NULL,closed_at=clock_timestamp(),version=version+1 WHERE order_id=$1`,[o.order_id]);
});
test('PII is tenant isolated; contacts allow only one complete redaction and retain their digest',async()=>{
  const s=await x.store(),c=await x.frozen(s);
  assert.equal((await x.tx(q=>q.query('SELECT * FROM commerce_checkout_contacts'))).rowCount,0);
  assert.equal((await x.tx(q=>q.query('SELECT * FROM commerce_customers'))).rowCount,0);
  await assert.rejects(x.tx(async q=>{await lockStore(q,s);await q.query('UPDATE commerce_checkout_contacts SET contact_name=$2 WHERE checkout_id=$1',[c.checkout_id,'另一位合成買家']);}),code('23514'));
  const before=(await x.h.pool.query('SELECT contact_sha256 FROM commerce_checkout_contacts WHERE checkout_id=$1',[c.checkout_id])).rows[0];
  await x.tx(async q=>{await lockStore(q,s);await q.query(`UPDATE commerce_checkout_contacts SET contact_name=NULL,contact_email=NULL,contact_phone=NULL,delivery=NULL,invoice=NULL,contact_salt=NULL,redacted_at=clock_timestamp() WHERE checkout_id=$1`,[c.checkout_id]);});
  const contact=(await x.h.pool.query('SELECT * FROM commerce_checkout_contacts WHERE checkout_id=$1',[c.checkout_id])).rows[0];assert.equal(contact.contact_sha256,before.contact_sha256);assert.equal(contact.delivery,null);assert.equal(contact.contact_salt,null);assert.ok(contact.redacted_at);
  await assert.rejects(x.tx(async q=>{await lockStore(q,s);await q.query('UPDATE commerce_checkout_contacts SET redacted_at=clock_timestamp() WHERE checkout_id=$1',[c.checkout_id]);}),code('23514'));
  await assert.rejects(x.tx(async q=>{await lockStore(q,s);await q.query('DELETE FROM commerce_checkout_contacts WHERE checkout_id=$1',[c.checkout_id]);}),code('23514'));
});
test('movement history is append-only and event identities reject SQL replay including nullable allocations',async()=>{
  const {o}=await allocated();
  await reject('UPDATE commerce_inventory_movements SET quantity=quantity WHERE order_id=$1',[o.order_id]);await reject('DELETE FROM commerce_inventory_movements WHERE order_id=$1',[o.order_id]);
  await reject(`INSERT INTO commerce_inventory_movements(kind,item_id,order_id,allocation_id,source_ref,quantity,delta_stock,delta_reserved)
    SELECT kind,item_id,order_id,allocation_id,source_ref,quantity,delta_stock,delta_reserved FROM commerce_inventory_movements WHERE order_id=$1`,[o.order_id],'23505');
  await reject(`WITH m AS (SELECT * FROM commerce_inventory_movements WHERE order_id=$1 LIMIT 1)
    INSERT INTO commerce_inventory_movements(kind,item_id,order_id,allocation_id,source_ref,quantity,delta_stock,delta_reserved)
    SELECT kind,item_id,order_id,NULL,source_ref,quantity,delta_stock,delta_reserved FROM m CROSS JOIN generate_series(1,2)`,[o.order_id],'23505');
});
test('migration 168 audits existing hosted balances and atomically aborts corrupt schema-167 data',async()=>{
  const schema=`fp_checkout_upgrade_${process.pid}_${Date.now()}`,url=process.env.TEST_DATABASE_URL;
  await x.h.admin.query(`CREATE SCHEMA ${schema}`);const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`});
  try{
    // This fixture audits the 167 -> 168 boundary independently of later foundations.
    const all=readMigrationSources(new URL('../../migrations',import.meta.url).pathname).filter(s=>Number(s.name.slice(0,3))<=168),sources=all.filter(s=>Number(s.name.slice(0,3))<=167);
    await runMigrationPlan(pool,{sources,profile:legacyMigrationProfile({first:1,last:167,known_gaps:[22]})});await seedLocal(pool);
    const shop=randomUUID(),item=randomUUID();
    await pool.query(`INSERT INTO commerce_shops(shop_id,community_id,owner_id,kind,mode,accepting_orders,name,description,website_url,contact,currency,manifest_sha256,origin)
      VALUES($1,$2,$3,'internal','test',false,'合成升級商店','','','','TWD','synthetic-upgrade','hosted')`,[shop,DEMO_COMMUNITY,DEMO_USERS[0].user_id]);
    await pool.query(`INSERT INTO commerce_items(item_id,shop_id,sku,title,description,price_minor,shipping_minor,stock,shipping_terms,return_terms)
      VALUES($1,$2,'SYNTHETIC','合成商品','',100,0,10,'','')`,[item,shop]);
    // Only the migration-owner fixture may manufacture pre-existing corruption.
    await pool.query(`ALTER TABLE commerce_items DISABLE TRIGGER check_commerce_inventory_balance;UPDATE commerce_items SET reserved=1 WHERE item_id='${item}';ALTER TABLE commerce_items ENABLE TRIGGER check_commerce_inventory_balance`);
    await assert.rejects(runMigrationPlan(pool,{sources:all,profile:legacyMigrationProfile({first:1,last:168,known_gaps:[22]})}),code('23514'));
    assert.equal((await pool.query("SELECT to_regclass('commerce_inventory_allocations') name")).rows[0].name,null);
    assert.equal((await pool.query("SELECT count(*)::int n FROM schema_migrations WHERE name LIKE '168_%'")).rows[0].n,0);
    await pool.query(`ALTER TABLE commerce_items DISABLE TRIGGER check_commerce_inventory_balance;UPDATE commerce_items SET reserved=0 WHERE item_id='${item}';ALTER TABLE commerce_items ENABLE TRIGGER check_commerce_inventory_balance`);
    await runMigrationPlan(pool,{sources:all,profile:legacyMigrationProfile({first:1,last:168,known_gaps:[22]})});
    assert.equal((await pool.query('SELECT count(*)::int n FROM commerce_inventory_allocations')).rows[0].n,0);
  }finally{await pool.end();await x.h.admin.query(`DROP SCHEMA ${schema} CASCADE`);}
});

test('allocation command identities are append-only under the runtime role',async()=>{
  const {s,o}=await allocated();
  await x.tx(q=>cancelPaidOrder(q,s,{orderId:o.order_id,commandRef:randomUUID()}));
  await reject('UPDATE commerce_checkout_allocation_commands SET command_ref=command_ref WHERE order_id=$1',[o.order_id]);
  await reject('DELETE FROM commerce_checkout_allocation_commands WHERE order_id=$1',[o.order_id]);
});

test('customer identity, link and email verification are guarded; redaction is accepted exactly once',async()=>{
  const s=await x.store(),c=await x.frozen(s),before=(await x.h.pool.query('SELECT * FROM commerce_customers')).rows[0];
  const update=(sql:string,params:unknown[]=[])=>x.tx(async q=>{await lockStore(q,s);return q.query(sql,[before.customer_id,...params]);});
  for(const sql of ["UPDATE commerce_customers SET email_normalized='changed@example.test' WHERE customer_id=$1",
    'UPDATE commerce_customers SET customer_id=gen_random_uuid() WHERE customer_id=$1',
    'UPDATE commerce_customers SET tenant_id=gen_random_uuid() WHERE customer_id=$1',
    'UPDATE commerce_customers SET instance_id=gen_random_uuid() WHERE customer_id=$1',
    "UPDATE commerce_customers SET created_at=created_at-interval '1 second' WHERE customer_id=$1"])
    await assert.rejects(update(sql),code('23514'));
  const {mapPersonPrincipal}=await import('../../packages/resource-scopes/index.js'),a=await x.h.person('合成買家甲'),b=await x.h.person('合成買家乙');
  const pa=await x.tx(q=>mapPersonPrincipal(q,a.id)),pb=await x.tx(q=>mapPersonPrincipal(q,b.id));
  await update('UPDATE commerce_customers SET member_principal_id=$2,email_verified_at=clock_timestamp() WHERE customer_id=$1',[pa.principal_id]);
  for(const value of [pb.principal_id,null])await assert.rejects(update('UPDATE commerce_customers SET member_principal_id=$2 WHERE customer_id=$1',[value]),code('23514'));
  await assert.rejects(update('UPDATE commerce_customers SET email_verified_at=NULL WHERE customer_id=$1'),code('23514'));
  await assert.rejects(update("UPDATE commerce_customers SET email_verified_at=email_verified_at+interval '1 second' WHERE customer_id=$1"),code('23514'));
  await assert.rejects(update('UPDATE commerce_customers SET redacted_at=clock_timestamp() WHERE customer_id=$1'),code('23514'));
  await update("UPDATE commerce_customers SET email_normalized='redacted:'||customer_id::text,email_verified_at=NULL,redacted_at=clock_timestamp() WHERE customer_id=$1");
  const redacted=(await x.h.pool.query('SELECT * FROM commerce_customers WHERE customer_id=$1',[before.customer_id])).rows[0];
  assert.equal(redacted.email_normalized,`redacted:${before.customer_id}`);assert.equal(redacted.email_verified_at,null);assert.equal(redacted.member_principal_id,pa.principal_id);assert.ok(redacted.redacted_at>=redacted.created_at);
  for(const sql of ['UPDATE commerce_customers SET redacted_at=clock_timestamp() WHERE customer_id=$1','UPDATE commerce_customers SET redacted_at=redacted_at WHERE customer_id=$1','UPDATE commerce_customers SET redacted_at=NULL WHERE customer_id=$1'])await assert.rejects(update(sql),code('23514'));
  const next=await x.frozen(s),current=(await x.h.pool.query('SELECT customer_id FROM commerce_checkouts WHERE checkout_id=$1',[next.checkout_id])).rows[0];
  assert.notEqual(current.customer_id,before.customer_id);assert.deepEqual((await x.h.pool.query('SELECT * FROM commerce_customers WHERE customer_id=$1',[before.customer_id])).rows[0],redacted);
  assert.equal((await x.h.pool.query('SELECT customer_id FROM commerce_checkouts WHERE checkout_id=$1',[c.checkout_id])).rows[0].customer_id,before.customer_id);
});

test('access credentials enforce absolute lifetimes, immutable identity, one-way revocation/redemption and store/checkout FKs',async()=>{
  const {ensureDevice,grantDevice,createAccessLink}=await import('../../modules/agent-commerce/checkout/access.js');
  const s=await x.store(),c=await x.frozen(s),o=await x.place(s,c),other=await x.frozen(s);
  const device=await x.tx(async q=>{await lockStore(q,s);const d=await ensureDevice(q,undefined,x.h.origin);await grantDevice(q,d.device.device_id,{tenant_id:s.tenantId,instance_id:s.instanceId,checkout_id:c.checkout_id});return d.device;});
  for(const sql of ["UPDATE commerce_access_devices SET expires_at=expires_at+interval '1 day' WHERE device_id=$1","UPDATE commerce_access_devices SET created_at=created_at-interval '1 day',expires_at=expires_at-interval '1 day' WHERE device_id=$1",'UPDATE commerce_access_devices SET token_sha256=repeat(\'a\',64) WHERE device_id=$1','DELETE FROM commerce_access_devices WHERE device_id=$1'])await reject(sql,[device.device_id]);
  await x.tx(q=>q.query('UPDATE commerce_access_devices SET revoked_at=clock_timestamp() WHERE device_id=$1',[device.device_id]));
  for(const sql of ['UPDATE commerce_access_devices SET revoked_at=NULL WHERE device_id=$1',"UPDATE commerce_access_devices SET revoked_at=revoked_at+interval '1 second' WHERE device_id=$1"])await reject(sql,[device.device_id]);
  const tx=<T>(run:(q:import('pg').PoolClient)=>Promise<T>)=>x.tx(async q=>{await lockStore(q,s);return run(q);});
  await assert.rejects(tx(q=>q.query(`INSERT INTO commerce_order_access_grants(tenant_id,instance_id,checkout_id,order_id,kind,device_id) VALUES($1,$2,$3,$4,'device',$5)`,[s.tenantId,s.instanceId,other.checkout_id,o.order_id,device.device_id])),code('23503'));
  await assert.rejects(tx(q=>q.query(`INSERT INTO commerce_order_access_grants(tenant_id,instance_id,checkout_id,kind,device_id,expires_at) VALUES($1,$2,$3,'device',$4,clock_timestamp())`,[s.tenantId,s.instanceId,c.checkout_id,device.device_id])),code('23514'));
  await assert.rejects(tx(q=>q.query(`INSERT INTO commerce_order_access_grants(tenant_id,instance_id,checkout_id,kind,device_id) VALUES($1,$2,$3,'device',$4)`,[s.tenantId,s.instanceId,c.checkout_id,device.device_id])),code('23505'));
  await tx(q=>createAccessLink(q,{tenant_id:s.tenantId,instance_id:s.instanceId,checkout_id:c.checkout_id,order_id:o.order_id}));
  const grant=(await x.h.pool.query("SELECT * FROM commerce_order_access_grants WHERE kind='link'")).rows[0];
  for(const sql of ['DELETE FROM commerce_order_access_grants WHERE grant_id=$1','UPDATE commerce_order_access_grants SET checkout_id=$2 WHERE grant_id=$1',"UPDATE commerce_order_access_grants SET expires_at=expires_at+interval '1 second' WHERE grant_id=$1"])
    await assert.rejects(tx(q=>q.query(sql,sql.includes('$2')?[grant.grant_id,other.checkout_id]:[grant.grant_id])),code('23514'));
  await tx(q=>q.query('UPDATE commerce_order_access_grants SET redeemed_at=clock_timestamp(),revoked_at=clock_timestamp() WHERE grant_id=$1',[grant.grant_id]));
  for(const column of ['redeemed_at','revoked_at'])for(const value of ['NULL',`${column}+interval '1 second'`])await assert.rejects(tx(q=>q.query(`UPDATE commerce_order_access_grants SET ${column}=${value} WHERE grant_id=$1`,[grant.grant_id])),code('23514'));
});

test('insert-time access CHECKs enforce absolute hours and grant kinds across a DST boundary',async()=>{
  const s=await x.store(),c=await x.frozen(s),o=await x.place(s,c);
  const insertDevice=(hours:number)=>x.tx(async q=>{
    await q.query("SET LOCAL TimeZone='America/New_York'");
    return q.query(`INSERT INTO commerce_access_devices(token_sha256,created_at,expires_at) SELECT $1,t,t+make_interval(hours=>$2) FROM (SELECT '2026-10-15 12:00:00-04'::timestamptz t)n RETURNING device_id`,[randomUUID().replaceAll('-','').repeat(2),hours]);
  });
  await assert.rejects(insertDevice(4319),code('23514'));const d=(await insertDevice(4320)).rows[0];
  const grant=(kind:string,withOrder:boolean,token:boolean,hours:number)=>x.tx(async q=>{
    await lockStore(q,s);await q.query("SET LOCAL TimeZone='America/New_York'");
    return q.query(`INSERT INTO commerce_order_access_grants(tenant_id,instance_id,checkout_id,order_id,kind,device_id,link_token_sha256,created_at,expires_at)
      SELECT $1,$2,$3,$4,$5,$6,$7,t,CASE WHEN $8::int IS NULL THEN NULL ELSE t+make_interval(hours=>$8) END
      FROM (SELECT '2026-10-30 12:00:00-04'::timestamptz t)n RETURNING kind`,[s.tenantId,s.instanceId,c.checkout_id,withOrder?o.order_id:null,kind,kind==='device'?d.device_id:null,token?randomUUID().replaceAll('-','').repeat(2):null,kind==='device'?null:hours]);
  });
  await assert.rejects(grant('link',true,true,167),code('23514'));
  await assert.rejects(grant('device',false,true,0),code('23514'));
  await assert.rejects(grant('link',false,true,168),code('23514'));
  assert.deepEqual((await grant('device',false,false,0)).rows,[{kind:'device'}]);assert.deepEqual((await grant('link',true,true,168)).rows,[{kind:'link'}]);
});
