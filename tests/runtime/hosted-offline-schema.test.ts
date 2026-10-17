import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {after, before, test} from 'node:test';
import {bindStore} from '../../modules/agent-commerce/checkout/authority.js';
import {canonicalJSON} from '../../modules/agent-commerce/checkout/terms.js';
import {checkoutHarness, type CheckoutHarness} from './hosted-checkout-harness.js';

let x: CheckoutHarness;
let orderId: string;
let tenantId: string;
let instanceId: string;
let otherTenant: string;
let otherInstance: string;
let principalId: string;
let shopId: string;

before(async () => {
  x = await checkoutHarness('fp_offline_schema');
  await x.reset();
  const s = await x.store();
  const other = await x.store();
  orderId = (await x.place(s, await x.frozen(s, 1))).order_id;
  tenantId = s.tenantId;
  instanceId = s.instanceId;
  otherTenant = other.tenantId;
  otherInstance = other.instanceId;
  shopId = s.storefront_shop_id;
  principalId = (await x.h.pool.query<{principal_id: string}>('SELECT principal_id FROM principals WHERE user_ref=$1', [s.owner.user.user_id])).rows[0].principal_id;
});
after(async () => x?.stop());

const document = {schema: 'freedom.offline-payment-settings/v1', bank_transfer: null, cash_on_meetup: null};
const digest = createHash('sha256').update(canonicalJSON(document)).digest('hex');

async function rejects(sql: string, params: unknown[] = [], code = '23514') {
  const q = await x.h.pool.connect();
  try {
    await q.query('BEGIN');
    await assert.rejects(q.query(sql, params), (error: {code?: string}) => error.code === code);
  } finally {
    await q.query('ROLLBACK');
    q.release();
  }
}

test('offline settings are append-only, contiguous and hash-shaped', async () => {
  await x.h.pool.query(`INSERT INTO commerce_offline_payment_settings(tenant_id,instance_id,version,document,document_sha256,created_by_principal_id)
    VALUES($1,$2,1,$3,$4,$5)`, [tenantId, instanceId, document, digest, principalId]);
  await rejects('UPDATE commerce_offline_payment_settings SET document=$2 WHERE instance_id=$1 AND version=1', [instanceId, document]);
  await rejects('DELETE FROM commerce_offline_payment_settings WHERE instance_id=$1', [instanceId]);
  await rejects(`INSERT INTO commerce_offline_payment_settings(tenant_id,instance_id,version,document,document_sha256,created_by_principal_id)
    VALUES($1,$2,3,$3,$4,$5)`, [tenantId, instanceId, document, digest, principalId]);
  await rejects(`INSERT INTO commerce_offline_payment_settings(tenant_id,instance_id,version,document,document_sha256,created_by_principal_id)
    VALUES($1,$2,0,$3,$4,$5)`, [tenantId, instanceId, document, digest, principalId]);
  await rejects(`INSERT INTO commerce_offline_payment_settings(tenant_id,instance_id,version,document,document_sha256,created_by_principal_id)
    VALUES($1,$2,2,$3,'zz',$4)`, [tenantId, instanceId, document, principalId]);
  await x.h.pool.query(`INSERT INTO commerce_offline_payment_settings(tenant_id,instance_id,version,document,document_sha256,created_by_principal_id)
    VALUES($1,$2,2,$3,$4,$5)`, [tenantId, instanceId, document, digest, principalId]);
  assert.deepEqual((await x.h.pool.query('SELECT version FROM commerce_offline_payment_settings WHERE instance_id=$1 ORDER BY version', [instanceId])).rows, [{version: 1}, {version: 2}]);
});

test('the checkout payment method sidecar is immutable', async () => {
  await rejects(`UPDATE commerce_checkout_orders SET payment_method='bank_transfer', version=version+1 WHERE order_id=$1`, [orderId]);
  assert.equal((await x.h.pool.query('SELECT payment_method FROM commerce_checkout_orders WHERE order_id=$1', [orderId])).rows[0].payment_method, 'immediate_card');
});

const hostedOrder = `INSERT INTO commerce_orders(order_id,public_shop_id,external_id,request_sha256,currency,total_minor,created_at,expires_at,order_profile,client_order_id)
  SELECT $2::uuid,public_shop_id,'exp:'||($2::uuid)::text,request_sha256,currency,total_minor,t,t+$3::interval,'hosted_checkout',$4::uuid
  FROM commerce_orders CROSS JOIN (SELECT date_trunc('milliseconds',clock_timestamp()) t) n WHERE order_id=$1::uuid`;

test('hosted checkout expiry accepts 30 minutes and whole days 1 through 14', async () => {
  await withOwner(async q => {
    for (const interval of ['30 minutes', ...Array.from({length: 14}, (_, i) => `${24 * (i + 1)} hours`)]) {
      const id = randomUUID();
      await q.query(hostedOrder, [orderId, id, interval, randomUUID()]);
      await q.query(`INSERT INTO commerce_inventory_reservations(order_id,item_id,supplier_shop_id,quantity,state,created_at,expires_at)
        SELECT $2::uuid,r.item_id,r.supplier_shop_id,r.quantity,'held',o.created_at,o.expires_at
        FROM commerce_inventory_reservations r JOIN commerce_orders o ON o.order_id=$2::uuid WHERE r.order_id=$1::uuid`, [orderId, id]);
    }
  });
});

for (const [label, interval] of [['23 hours', '23 hours'], ['25 hours', '25 hours'], ['15 days', '15 days'], ['30 minutes plus 1 second', '30 minutes 1 second']] as const)
  test(`hosted checkout expiry rejects ${label}`, async () => {
    await rejects(hostedOrder, [orderId, randomUUID(), interval, randomUUID()]);
  });

test('a v1 reservation still accepts only 30 minutes', async () => {
  const base = (await x.h.pool.query('SELECT public_shop_id, request_sha256, currency, total_minor FROM commerce_orders WHERE order_id=$1', [orderId])).rows[0];
  const quote = randomUUID();
  await x.h.pool.query(`INSERT INTO commerce_order_quotes(quote_id,tenant_id,instance_id,public_shop_id,buyer_principal_id,publication_id,terms,bindings,terms_sha256,quoted_at,expires_at)
    SELECT $1::uuid,p.tenant_id,p.instance_id,p.storefront_shop_id,$2::uuid,pub.publication_id,'{"profile":"freedom.hosted-direct-order-reservation/v1"}'::jsonb,'[{"sku":"synthetic"}]'::jsonb,$3,t,t+interval '5 minutes'
    FROM commerce_storefront_profiles p
    JOIN commerce_storefront_publications pub ON pub.tenant_id=p.tenant_id AND pub.instance_id=p.instance_id
    CROSS JOIN (SELECT date_trunc('milliseconds',clock_timestamp()) t) n
    WHERE p.instance_id=$4::uuid LIMIT 1`, [quote, principalId, 'a'.repeat(64), instanceId]);
  const insert = `INSERT INTO commerce_orders(order_id,public_shop_id,external_id,request_sha256,currency,total_minor,created_at,expires_at,order_profile,quote_id,buyer_principal_id,client_order_id,reservation_state,reservation_version)
    SELECT $1::uuid,$2::uuid,'dir:'||($1::uuid)::text,$3,$4,$5,t,t+$6::interval,'hosted_direct_reservation',$7::uuid,$8::uuid,$9::uuid,'reserved',1
    FROM (SELECT date_trunc('milliseconds',clock_timestamp()) t) n`;
  await rejects(insert, [randomUUID(), base.public_shop_id, base.request_sha256, base.currency, base.total_minor, '24 hours', quote, principalId, randomUUID()]);
  const accepted = randomUUID();
  await withOwner(async q => {
    await q.query(insert, [accepted, base.public_shop_id, base.request_sha256, base.currency, base.total_minor, '30 minutes', quote, principalId, randomUUID()]);
    assert.equal((await q.query('SELECT order_profile FROM commerce_orders WHERE order_id=$1', [accepted])).rows[0].order_profile, 'hosted_direct_reservation');
  });
});

async function withOwner<T>(run: (q: import('pg').PoolClient) => Promise<T>) {
  const q = await x.h.pool.connect();
  try {
    await q.query('BEGIN');
    return await run(q);
  } finally {
    await q.query('ROLLBACK');
    q.release();
  }
}

async function cloneCheckout(q: import('pg').PoolClient, sourceOrder: string, id: string, client: string, expiry: string, method: string, terms: unknown) {
  const checkout = randomUUID(), contact = randomUUID();
  const source = (await q.query('SELECT checkout_id FROM commerce_checkout_orders WHERE order_id=$1', [sourceOrder])).rows[0].checkout_id;
  await q.query(`INSERT INTO commerce_checkouts(checkout_id,tenant_id,instance_id,customer_id,publication_revision,currency,terms_profile,terms,terms_sha256,current_contact_id,idempotency_key_sha256,request_sha256,created_at,expires_at)
    SELECT $2::uuid,tenant_id,instance_id,customer_id,publication_revision,currency,terms_profile,$4::jsonb,commerce_checkout_hash($4::jsonb),$3::uuid,encode(sha256($2::text::bytea),'hex'),request_sha256,t,t+interval '24 hours'
    FROM commerce_checkouts CROSS JOIN (SELECT date_trunc('milliseconds',clock_timestamp()) t) n WHERE checkout_id=$1::uuid`, [source, checkout, contact, JSON.stringify(terms)]);
  await q.query(`INSERT INTO commerce_checkout_contacts(contact_id,checkout_id,tenant_id,instance_id,contact_name,contact_email,contact_phone,delivery,invoice,contact_salt,contact_sha256)
    SELECT $3::uuid,$2::uuid,tenant_id,instance_id,contact_name,contact_email,contact_phone,delivery,invoice,contact_salt,contact_sha256
    FROM commerce_checkout_contacts WHERE checkout_id=$1::uuid`, [source, checkout, contact]);
  await q.query(`INSERT INTO commerce_orders(order_id,public_shop_id,external_id,request_sha256,currency,total_minor,created_at,expires_at,order_profile,client_order_id)
    SELECT $2::uuid,public_shop_id,'chk:'||$3::text||':'||($4::uuid)::text,request_sha256,currency,total_minor,t,t+$5::interval,'hosted_checkout',$4::uuid
    FROM commerce_orders CROSS JOIN (SELECT date_trunc('milliseconds',clock_timestamp()) t) n WHERE order_id=$1::uuid`, [sourceOrder, id, checkout, client, expiry]);
  await q.query(`INSERT INTO commerce_checkout_orders(order_id,tenant_id,instance_id,checkout_id,customer_id,contact_id,display_number,terms,terms_sha256,environment,payment_method)
    SELECT $1::uuid,c.tenant_id,c.instance_id,c.checkout_id,c.customer_id,c.current_contact_id,
      to_char(o.created_at AT TIME ZONE 'Asia/Taipei','YYMMDD')||'-'||upper(substr(replace(($1::uuid)::text,'-',''),1,6)),
      c.terms,c.terms_sha256,'sandbox',$3
    FROM commerce_checkouts c JOIN commerce_orders o ON o.order_id=$1::uuid WHERE c.checkout_id=$2::uuid`, [id, checkout, method]);
  return checkout;
}

test('the constraint trigger rejects a method missing from the frozen terms', async () => {
  await assert.rejects(withOwner(async q => {
    const id = randomUUID();
    const terms = (await q.query('SELECT terms FROM commerce_checkout_orders WHERE order_id=$1', [orderId])).rows[0].terms;
    await cloneCheckout(q, orderId, id, randomUUID(), '30 minutes', 'bank_transfer', terms);
    await q.query('SET CONSTRAINTS check_commerce_checkout_payment_method IMMEDIATE');
  }), (error: {code?: string; message?: string}) => error.code === '23514' && /frozen terms/.test(error.message ?? ''));
});

test('the constraint trigger rejects a deadline that does not match the terms', async () => {
  const terms = (await x.h.pool.query('SELECT terms FROM commerce_checkout_orders WHERE order_id=$1', [orderId])).rows[0].terms;
  const patched = {...terms, payment_methods: ['bank_transfer'], offline_payment: {settings_version: '1', bank_transfer_deadline_days: 3, meetup_deadline_days: null}};
  await assert.rejects(withOwner(async q => {
    await cloneCheckout(q, orderId, randomUUID(), randomUUID(), '30 minutes', 'bank_transfer', patched);
    await q.query('SET CONSTRAINTS check_commerce_checkout_payment_method IMMEDIATE');
  }), (error: {code?: string; message?: string}) => error.code === '23514' && /deadline/.test(error.message ?? ''));
});

test('offline payments and meetup handovers are append-only and must match the order', async () => {
  const payment = randomUUID();
  await rejects(`INSERT INTO commerce_offline_payments(payment_id,tenant_id,instance_id,order_id,method,amount_minor,currency,received_on,confirmed_by_principal_id)
    VALUES($1,$2,$3,$4,'bank_transfer',100,'TWD',CURRENT_DATE,$5)`, [payment, tenantId, instanceId, orderId, principalId]);
  const bankOrder = randomUUID();
  const terms = (await x.h.pool.query('SELECT terms FROM commerce_checkout_orders WHERE order_id=$1', [orderId])).rows[0].terms;
  const patched = {...terms, payment_methods: ['bank_transfer'], offline_payment: {settings_version: '1', bank_transfer_deadline_days: 3, meetup_deadline_days: null}};
  const q = await x.h.pool.connect();
  try {
    await q.query('BEGIN');
    await cloneCheckout(q, orderId, bankOrder, randomUUID(), '72 hours', 'bank_transfer', patched);
    await q.query(`INSERT INTO commerce_order_lines(order_id,selection_id,item_id,quantity,snapshot,order_profile,supplier_shop_id,hosted_offer_id,acceptance_id,listing_sha256)
      SELECT $2::uuid,selection_id,item_id,quantity,snapshot,order_profile,supplier_shop_id,hosted_offer_id,acceptance_id,listing_sha256 FROM commerce_order_lines WHERE order_id=$1::uuid`, [orderId, bankOrder]);
    await q.query(`INSERT INTO commerce_inventory_reservations(order_id,item_id,supplier_shop_id,quantity,state,created_at,expires_at)
      SELECT o.order_id,l.item_id,l.supplier_shop_id,l.quantity,'held',o.created_at,o.expires_at FROM commerce_orders o JOIN commerce_order_lines l USING(order_id) WHERE o.order_id=$1::uuid`, [bankOrder]);
    await q.query('UPDATE commerce_items SET reserved=reserved+l.quantity FROM commerce_order_lines l WHERE l.order_id=$1 AND commerce_items.item_id=l.item_id', [bankOrder]);
    await q.query('COMMIT');
  } catch (error) {
    await q.query('ROLLBACK');
    throw error;
  } finally { q.release(); }
  const paymentSQL = `INSERT INTO commerce_offline_payments(payment_id,tenant_id,instance_id,order_id,method,amount_minor,currency,received_on,reference,confirmed_by_principal_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,CURRENT_DATE,$8,$9)`;
  const validPayment = () => [randomUUID(), tenantId, instanceId, bankOrder, 'bank_transfer', 100, 'TWD', null, principalId];
  for (const [index, value] of [[1, otherTenant], [2, otherInstance], [4, 'cash_on_meetup'], [4, 'immediate_card'], [5, 0], [5, -1], [6, 'twd'], [6, 'TW'], [7, ''], [7, 'x'.repeat(41)]] as const) {
    const values = validPayment();
    values[index] = value;
    await rejects(paymentSQL, values);
  }
  for (const reference of [null, 'x', 'x'.repeat(40)]) {
    await withOwner(async client => {
      const values = validPayment();
      values[7] = reference;
      await client.query(paymentSQL, values);
      assert.equal((await client.query('SELECT reference FROM commerce_offline_payments WHERE payment_id=$1', [values[0]])).rows[0].reference, reference);
    });
  }
  const matched = randomUUID();
  await x.h.pool.query(`INSERT INTO commerce_offline_payments(payment_id,tenant_id,instance_id,order_id,method,amount_minor,currency,received_on,confirmed_by_principal_id)
    VALUES($1,$2,$3,$4,'bank_transfer',100,'TWD',CURRENT_DATE,$5)`, [matched, tenantId, instanceId, bankOrder, principalId]);
  await rejects('UPDATE commerce_offline_payments SET amount_minor=200 WHERE payment_id=$1', [matched]);
  await rejects('DELETE FROM commerce_offline_payments WHERE payment_id=$1', [matched]);
  await rejects(paymentSQL, validPayment(), '23505');
  const handover = randomUUID();
  await x.h.pool.query(`INSERT INTO commerce_meetup_handovers(handover_id,tenant_id,instance_id,order_id,offline_payment_id,completed_on,recorded_by_principal_id)
    VALUES($1,$2,$3,$4,$5,CURRENT_DATE,$6)`, [handover, tenantId, instanceId, bankOrder, matched, principalId]);
  await rejects('DELETE FROM commerce_meetup_handovers WHERE handover_id=$1', [handover]);
  await rejects('UPDATE commerce_meetup_handovers SET completed_on=completed_on WHERE handover_id=$1', [handover]);
  await rejects(`INSERT INTO commerce_meetup_handovers(tenant_id,instance_id,order_id,completed_on,recorded_by_principal_id)
    VALUES($1,$2,$3,CURRENT_DATE,$4)`, [tenantId, instanceId, bankOrder, principalId], '23505');
  await rejects(`INSERT INTO commerce_meetup_handovers(tenant_id,instance_id,order_id,offline_payment_id,completed_on,recorded_by_principal_id)
    VALUES($1,$2,$3,$4,CURRENT_DATE,$5)`, [tenantId, instanceId, orderId, matched, principalId]);
});

test('RLS hides another tenant rows in settings, payments and handovers', async () => {
  await x.h.pool.query(`INSERT INTO commerce_offline_payment_settings(tenant_id,instance_id,version,document,document_sha256,created_by_principal_id)
    VALUES($1,$2,1,$3,$4,$5)`, [otherTenant, otherInstance, document, digest, principalId]);
  const visible = async (tenant: string, table: string) => x.tx(async q => {
    await bindStore(q, tenant);
    return (await q.query<{n: number}>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
  });
  assert.equal(await visible(tenantId, 'commerce_offline_payment_settings'), 2);
  assert.equal(await visible(otherTenant, 'commerce_offline_payment_settings'), 1);
  assert.equal(await visible(otherTenant, 'commerce_offline_payments'), 0);
  assert.equal(await visible(tenantId, 'commerce_offline_payments') > 0, true);
  assert.equal(await visible(otherTenant, 'commerce_meetup_handovers'), 0);
  assert.equal(await visible(tenantId, 'commerce_meetup_handovers'), 1);
  assert.equal(shopId.length > 0, true);
});
