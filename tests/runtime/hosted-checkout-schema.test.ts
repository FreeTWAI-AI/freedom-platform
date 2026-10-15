import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {after,before,beforeEach,test} from 'node:test';
import {Pool} from 'pg';
import {readMigrationSources} from '../../packages/db/migration-files.mjs';
import {legacyMigrationProfile} from '../../packages/db/migration-plan.mjs';
import {runMigrationPlan} from '../../packages/db/migration-runner.mjs';
import {seedLocal,DEMO_COMMUNITY,DEMO_USERS} from '../../packages/testing/seed.js';
import {applyConfirmedPayment,recordHandover,cancelUnpaidOrder} from '../../modules/agent-commerce/checkout/index.js';
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
    const all=readMigrationSources(new URL('../../migrations',import.meta.url).pathname),sources=all.filter(s=>Number(s.name.slice(0,3))<=167);
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
  const {cancelPaidOrder}=await import('../../modules/agent-commerce/checkout/index.js');
  await x.tx(q=>cancelPaidOrder(q,s,{orderId:o.order_id,commandRef:randomUUID()}));
  await reject('UPDATE commerce_checkout_allocation_commands SET command_ref=command_ref WHERE order_id=$1',[o.order_id]);
  await reject('DELETE FROM commerce_checkout_allocation_commands WHERE order_id=$1',[o.order_id]);
});
