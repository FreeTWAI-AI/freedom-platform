import {retainedHostedOrder} from '../helpers/hosted-inventory-history.js';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { serve } from '@hono/node-server';
import { TENANT_CURSOR_TEST_KEY } from './tenant-cursor-fixture.js';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { createApp } from '../../apps/platform-api/src/app.js';
import { authenticate, type Actor } from '../../modules/identity-membership/service.js';
import { createDirectQuote } from '../../modules/agent-commerce/hosted/direct-quotes.js';
import { submitDirectOrder, readDirectOrder, readDirectOrderByIntent, cancelDirectOrder } from '../../modules/agent-commerce/hosted/direct-orders.js';
import { createRegistryHarness, type RegistryHarness, type Session, type Reply } from './module-registry-harness.js';

let h: RegistryHarness, runtime: Pool, app: ReturnType<typeof createApp>, wireApp: ReturnType<typeof createApp>;
let server: ReturnType<typeof serve>, origin: string;
const installWire = (flags = true, key: string | null = TENANT_CURSOR_TEST_KEY) => { wireApp = createApp(runtime, origin, 'local', { guildLaunchpadEnabled: flags, hostedReservationsEnabled: flags, tenantCursorSigningKey: key ?? undefined }); };
async function wire(method: string, path: string, session: Session, body?: unknown, key = randomUUID(), version?: string): Promise<Reply> {
 const response = await fetch(origin + '/api/v1' + path, { method, headers: { Origin: origin, Cookie: session.cookie, 'X-CSRF-Token': session.csrf, 'Idempotency-Key': key, ...(body === undefined ? {} : {'Content-Type':'application/json'}), ...(version ? {'If-Match': `"${version}"`} : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
 return { status: response.status, data: await response.json(), response };
}
const role = `ho_seller_${process.pid}_${Date.now()}`;
const ok = (r: Reply, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.data)); return r.data; };
async function actor(session: Session): Promise<Actor> { return authenticate(runtime, session.cookie.split('=')[1].split(';')[0]); }
const post = (path: string, session: Session, body: unknown, version?: string) => h.call('POST', path, session, body,
  { 'Idempotency-Key': randomUUID(), ...(version ? { 'If-Match': `"${version}"` } : {}) }, app);
async function fixture(stock = 3) {
  const owner = (await h.person('合成賣家')).session;
  await h.fullMember(owner.user.user_id, 'guild_commerce_sales');
  const t = await h.createTenant(owner, '合成直售商店');
  const plan = ok(await post(`/tenants/${t.tenantId}/application-launch-plans`, owner,
    h.planBody('guild_commerce_sales', t.workspaceId, 'hosted-store', 'hosted-store@1.1.0')), 201);
  const launched = await post(`/tenants/${t.tenantId}/application-installations`, owner,
    { plan_id: plan.plan_id, expected_plan_version: plan.version, configuration_digest: plan.configuration_digest });
  assert.ok([200, 202].includes(launched.status), JSON.stringify(launched.data));
  const instanceId = (await h.pool.query("SELECT instance_id FROM module_instances WHERE tenant_id=$1 AND module_key='storefront'", [t.tenantId])).rows[0].instance_id;
  const root = `/tenants/${t.tenantId}/storefronts/${instanceId}`, slug = `s-${randomUUID()}`;
  ok(await post(root + '/setup', owner, { slug, name: '合成直售商品', currency: 'TWD' }), 201);
  const product = ok(await post(root + '/products', owner, { title: '合成商品', price_minor: 100, stock }), 201);
  const current = ok(await h.call('GET', root, owner, undefined, {}, app));
  ok(await post(root + '/publish', owner, {}, current.version));
  // Explicit local fixture activation only. No production setting API/release exists.
  await h.pool.query('UPDATE commerce_storefront_profiles SET reservation_enabled=true WHERE instance_id=$1', [instanceId]);
  const b = await h.person('合成買家'), c = await h.person('另一合成買家');
  const buyerCommunity = randomUUID();
  await h.pool.query("INSERT INTO communities(community_id,name) VALUES($1,'合成買家社群')", [buyerCommunity]);
  await h.pool.query('UPDATE users SET community_id=$1 WHERE user_id=$2', [buyerCommunity, b.id]);
  return { ...t, instanceId, root, slug, owner, product, b, c, buyer: await actor(b.session), other: await actor(c.session) };
}
async function quote(s: Awaited<ReturnType<typeof fixture>>, buyer = s.buyer, quantity = 1, key = randomUUID()) {
  return createDirectQuote(runtime, buyer, s.slug, { publication_revision: '1', items: [{ sku: s.product.sku, quantity }] }, key);
}
const body = (q: Awaited<ReturnType<typeof quote>>, intent = randomUUID()) => ({ quote_id: q.quote_id, terms_sha256: q.terms_sha256, client_order_id: intent });
const code = (expected: string) => (e: unknown) => (e as { code?: string }).code === expected;
before(async () => {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url && ['127.0.0.1','localhost'].includes(new URL(url).hostname) && /^\/fp_[a-z0-9_]+$/.test(new URL(url).pathname), 'Explicit disposable loopback TEST_DATABASE_URL required');
  h = await createRegistryHarness('fp_seller_orders');
  await h.admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    GRANT USAGE ON SCHEMA ${h.schema} TO ${role}; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${h.schema} TO ${role};
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${h.schema} TO ${role}; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${h.schema} TO ${role};
    REVOKE INSERT,UPDATE,DELETE ON ${h.schema}.module_definitions,${h.schema}.application_definitions,${h.schema}.guild_application_offerings FROM ${role}`);
  const runtimeUrl = new URL(url); runtimeUrl.username = role; runtimeUrl.password = '';
  runtime = new Pool({ connectionString: runtimeUrl.toString(), options: `-c search_path=${h.schema} -c statement_timeout=20000`, max: 12 });
  app = createApp(runtime, h.origin, 'local', { guildLaunchpadEnabled: true, shopKeyPolicy: 'legacy-compatible', tenantCursorSigningKey: TENANT_CURSOR_TEST_KEY });
  await new Promise<void>(resolve => { server = serve({ fetch: request => wireApp.fetch(request), hostname: '127.0.0.1', port: 0 }, info => { origin = `http://127.0.0.1:${info.port}`; resolve(); }); }); installWire();
});
beforeEach(async () => { await h.reset(); installWire(); });
after(async () => {
  if (server) { if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  await runtime?.end();
  if (h) { await h.stop(); const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL }); try { await admin.query(`DROP ROLE ${role}`); } finally { await admin.end(); } }
});

async function reserved(s: Awaited<ReturnType<typeof fixture>>) { return submitDirectOrder(runtime, s.buyer, s.slug, body(await quote(s)), randomUUID()); }
async function invited(s: Awaited<ReturnType<typeof fixture>>, role: 'admin' | 'operator' | 'viewer') {
  const person = await h.person('合成非owner'), principal = await h.candidate(s.owner, person.id);
  const invitation = await h.post(`/tenants/${s.tenantId}/invitations`, s.owner, { invitee_principal_id: principal, role,
    expires_at: new Date(Date.now()+3600000).toISOString(), instance_capabilities: role === 'admin' ? [] : [{instance_id:s.instanceId,capabilities:role === 'viewer' ? ['store:read'] : ['store:read','store:manage','store:write','store:publish']}] });
  assert.equal(invitation.status,201,JSON.stringify(invitation.data)); await h.accept(person.session,s.tenantId,invitation); return { ...person, principal };
}
test('only genuine current owner can read/list/cancel; real admin and ordinary grants do not imply order access', async () => {
  const s = await fixture(), order = await reserved(s), root = s.root + '/orders';
  const admin = await invited(s,'admin'), operator = await invited(s,'operator'), viewer = await invited(s,'viewer');
  assert.equal(ok(await wire('GET',root,s.owner)).items[0].order_id,order.order_id);
  for(const person of [admin,operator,viewer]) {
    for(const path of [root,root+'/'+order.order_id]) assert.equal((await wire('GET',path,person.session)).status,403);
    assert.equal((await wire('POST',root+'/'+order.order_id+'/cancel',person.session,{},randomUUID(),'1')).status,403);
  }
  assert.equal((await wire('GET',root,s.c.session)).status,404);
  const foreign = await fixture();
  assert.equal((await wire('GET',foreign.root+'/orders/'+order.order_id,foreign.owner)).status,404);
  const got = await wire('GET',root+'/'+order.order_id,s.owner);
  assert.equal(got.response.headers.get('cache-control'),'private, no-store');
  for(const field of ['buyer_principal_id','owner_id','email','contact','phone','address']) assert.equal(field in got.data,false);
  assert.equal((await readDirectOrder(runtime,s.buyer,order.order_id)).state,'reserved');
});

test('same reference lists current signed pages without cursor/key digest conflict or receipt growth', async () => {
  const s = await fixture(8), orders = [];
  for(let n=0;n<4;n++) orders.push(await reserved(s));
  const root=s.root+'/orders', first=ok(await wire('GET',root+'?limit=1',s.owner));
  const second=ok(await wire('GET',root+'?limit=2&cursor='+encodeURIComponent(first.next_cursor),s.owner));
  assert.equal(second.items.length,2); assert.ok(!second.items.some((o:any)=>o.order_id===first.items[0].order_id));
  for(let n=0;n<10;n++) ok(await wire('GET',root+'?limit=3',s.owner));
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM scoped_command_receipts WHERE operation='storefront.seller.orders.list' AND target_id=$1",[s.instanceId])).rows[0].n,1);
  const receipt=(await h.pool.query("SELECT response FROM scoped_command_receipts WHERE operation='storefront.seller.orders.list' AND target_id=$1",[s.instanceId])).rows[0].response;
  assert.deepEqual(receipt,{id:s.instanceId});
  assert.equal((await wire('GET',root+'?cursor='+encodeURIComponent(first.next_cursor+'x'),s.owner)).status,422);
  assert.equal((await wire('GET',root+'?limit=1&limit=2',s.owner)).status,422);
  const other=await fixture();
  assert.equal((await wire('GET',other.root+'/orders?cursor='+encodeURIComponent(first.next_cursor),other.owner)).status,422);
  installWire(true,null);
  assert.equal((await wire('GET',root,s.owner)).status,503);
  assert.equal((await wire('GET',root+'?cursor=bad',s.c.session)).status,404);
  assert.equal((await wire('GET',root+'/'+orders[0].order_id,s.owner)).status,200);
});

test('seller page batches hydration with identical single-order DTOs and constant live-reservation queries', async () => {
  const s=await fixture(8);
  for(let n=0;n<4;n++)await reserved(s);
  const root=s.root+'/orders';
  // Warm the existing ID-only receipt before comparing equal replay paths.
  ok(await wire('GET',root+'?limit=1',s.owner));
  let count=0;
  const clients=new Map<PoolClient,PoolClient['query']>();
  const onConnect=(q:PoolClient)=>{
    if(clients.has(q))return;
    const original=q.query;clients.set(q,original);
    q.query=((...args:unknown[])=>{count++;return Reflect.apply(original,q,args);}) as typeof q.query;
  };
  runtime.on('acquire',onConnect);
  try {
    count=0;const one=ok(await wire('GET',root+'?limit=1',s.owner)),oneCount=count;
    count=0;const many=ok(await wire('GET',root+'?limit=4',s.owner)),manyCount=count;
    assert.equal(one.items.length,1);assert.equal(many.items.length,4);
    const singles=[];
    for(const order of many.items)singles.push(ok(await wire('GET',root+'/'+order.order_id,s.owner)));
    assert.deepEqual(many.items,singles);
    console.log(`hosted live reservations: N=1 ${oneCount} queries; N=4 ${manyCount} queries`);
    assert.equal(manyCount,oneCount);
  } finally {
    runtime.off('acquire',onConnect);
    for(const [q,original] of clients)q.query=original;
  }
});

test('OFF and archived instance retain current owner cancellation; buyer and seller race release once and replay current state', async () => {
  const s=await fixture(), order=await reserved(s), root=s.root+'/orders/'+order.order_id;
  await h.pool.query("UPDATE module_instances SET status='archived' WHERE instance_id=$1",[s.instanceId]);
  await h.pool.query("UPDATE deployment_bindings SET state='retired' WHERE instance_id=$1",[s.instanceId]); installWire(false);
  const key=randomUUID(), cancelled=ok(await wire('POST',root+'/cancel',s.owner,{},key,'1'));
  assert.equal(cancelled.close_reason,'seller_cancelled');
  assert.deepEqual(ok(await wire('POST',root+'/cancel',s.owner,{},key,'1')),cancelled);
  assert.equal((await wire('POST',root+'/cancel',s.owner,{},randomUUID(),'1')).status,412);
  assert.deepEqual(await readDirectOrder(runtime,s.buyer,order.order_id),cancelled);
  assert.equal((await h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1',[s.product.product_id])).rows[0].reserved,0);
  const fact=(await h.pool.query('SELECT scope_kind,principal_id FROM scoped_transition_journal WHERE aggregate_id=$1 AND aggregate_version=2',[order.order_id])).rows;
  assert.equal(fact.length,1);assert.equal(fact[0].scope_kind,'tenant');
  const current=await fixture(), racing=await reserved(current);
  const results=await Promise.allSettled([wire('POST',current.root+'/orders/'+racing.order_id+'/cancel',current.owner,{},randomUUID(),'1'),cancelDirectOrder(runtime,current.buyer,racing.order_id,randomUUID(),'1')]);
  const sellerResult=results[0], buyerResult=results[1];
  assert.equal(sellerResult.status,'fulfilled');
  if(sellerResult.status==='fulfilled') assert.ok([200,412].includes((sellerResult.value as Reply).status));
  if(buyerResult.status==='rejected') assert.equal(buyerResult.reason.status,412);
  assert.equal((await readDirectOrder(runtime,current.buyer,racing.order_id)).version,'2');
  assert.equal((await h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1',[current.product.product_id])).rows[0].reserved,0);
  assert.equal((await h.pool.query('SELECT 1 FROM scoped_transition_journal WHERE aggregate_id=$1 AND aggregate_version=2',[racing.order_id])).rowCount,1);
});

test('authoritative owner transfer refuses old owner receipt replay; new owner can recover retained order', async () => {
  const s=await fixture(), order=await reserved(s), next=await invited(s,'operator'), root=s.root+'/orders/'+order.order_id;
  ok(await wire('GET',root,s.owner));
  // Synthetic authoritative membership transition; no fake actor/context or claim of executing the ownership workflow.
  const q=await h.pool.connect();try{await q.query('BEGIN');
    await q.query("UPDATE tenant_memberships SET role='admin',version=version+1 WHERE tenant_id=$1 AND role='owner'",[s.tenantId]);
    await q.query("UPDATE tenant_memberships SET role='owner',version=version+1 WHERE tenant_id=$1 AND principal_id=$2",[s.tenantId,next.principal]);
    await q.query('COMMIT');}catch(e){await q.query('ROLLBACK');throw e;}finally{q.release();}
  assert.equal((await wire('GET',root,s.owner)).status,403);
  assert.equal(ok(await wire('GET',root,next.session)).order_id,order.order_id);
  await h.pool.query("UPDATE resource_scopes SET status='disabled' WHERE tenant_ref=$1",[s.tenantId]);
  assert.equal((await wire('POST',root+'/cancel',next.session,{},randomUUID(),'1')).status,403);
  assert.equal((await h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1',[s.product.product_id])).rows[0].reserved,1);
});

test('seller receipt wait final session check rolls back physical release, reference and tenant fact', async () => {
  const s=await fixture(), order=await reserved(s), key=randomUUID();
  await h.pool.query(`CREATE FUNCTION seller_test_expire_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.operation='storefront.seller.order.cancel' THEN UPDATE sessions SET expires_at=clock_timestamp()-interval '1 millisecond'
      WHERE user_id=(SELECT user_ref FROM principals WHERE principal_id=NEW.principal_id); END IF; RETURN NEW; END $$;
    CREATE TRIGGER seller_test_expire_session BEFORE INSERT ON scoped_command_receipts FOR EACH ROW EXECUTE FUNCTION seller_test_expire_session()`);
  try {
    assert.equal((await wire('POST',s.root+'/orders/'+order.order_id+'/cancel',s.owner,{},key,'1')).status,401);
    assert.equal((await h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1',[s.product.product_id])).rows[0].reserved,1);
    assert.equal((await h.pool.query('SELECT reservation_version FROM commerce_orders WHERE order_id=$1',[order.order_id])).rows[0].reservation_version,'1');
    assert.equal((await h.pool.query('SELECT 1 FROM scoped_command_receipts WHERE idempotency_key=$1',[key])).rowCount,0);
    assert.equal((await h.pool.query('SELECT 1 FROM scoped_transition_journal WHERE aggregate_id=$1 AND aggregate_version=2',[order.order_id])).rowCount,0);
  } finally { await h.pool.query('DROP TRIGGER seller_test_expire_session ON scoped_command_receipts; DROP FUNCTION seller_test_expire_session()'); }
});

test('seller page physically expires retained history and exact cancel keeps expiry reason with one terminal fact', async () => {
  const s=await fixture(), q=await quote(s), source=await submitDirectOrder(runtime,s.buyer,s.slug,body(q),randomUUID());
  await cancelDirectOrder(runtime,s.buyer,source.order_id,randomUUID(),'1');
  const quoteId=randomUUID(), orderId=randomUUID(), intent=randomUUID(), now=(await h.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
  const quoted=new Date(now.getTime()-40*60000), expires=new Date(quoted.getTime()+300000);
  const { digest }=await import('../../packages/db/index.js');
  // Historical fixture INSERTs retain all actual immutable/FK guards.
  await h.pool.query(`INSERT INTO commerce_order_quotes SELECT $2::uuid,tenant_id,instance_id,public_shop_id,buyer_principal_id,publication_id,
    terms || jsonb_build_object('quote_id',$2::text,'quoted_at',$3::text,'expires_at',$4::text),bindings,terms_sha256,$3::timestamptz,$4::timestamptz
    FROM commerce_order_quotes WHERE quote_id=$1`,[q.quote_id,quoteId,quoted.toISOString(),expires.toISOString()]);
  await retainedHostedOrder(h.pool,orderId,async history => {
    await history.query(`INSERT INTO commerce_orders(order_id,public_shop_id,external_id,request_sha256,currency,total_minor,created_at,expires_at,
      order_profile,quote_id,buyer_principal_id,client_order_id,reservation_state,reservation_version)
      SELECT $2,o.public_shop_id,o.buyer_principal_id::text||':'||$4::text,$5,o.currency,o.total_minor,quote.quoted_at+interval '1 minute',quote.quoted_at+interval '31 minutes',
        'hosted_direct_reservation',$3,o.buyer_principal_id,$4::uuid,'reserved',1 FROM commerce_orders o JOIN commerce_order_quotes quote ON quote.quote_id=$3 WHERE order_id=$1`,
      [source.order_id,orderId,quoteId,intent,digest({quote_id:quoteId,terms_sha256:q.terms_sha256,client_order_id:intent})]);
    await history.query(`INSERT INTO commerce_order_lines SELECT $2,selection_id,transfer_id,item_id,quantity,snapshot,acceptance_id,listing_sha256,order_profile FROM commerce_order_lines WHERE order_id=$1`,[source.order_id,orderId]);
    await history.query('UPDATE commerce_items SET reserved=reserved+1 WHERE item_id=$1',[s.product.product_id]);
  });
  const page=ok(await wire('GET',s.root+'/orders',s.owner));
  assert.equal(page.items.find((o:any)=>o.order_id===orderId).state,'expired');
  const result=ok(await wire('POST',s.root+'/orders/'+orderId+'/cancel',s.owner,{},randomUUID(),'2'));
  assert.equal(result.state,'expired');assert.equal(result.close_reason,'reservation_expired');assert.equal(result.version,'2');
  assert.equal((await h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1',[s.product.product_id])).rows[0].reserved,0);
  assert.equal((await h.pool.query('SELECT 1 FROM scoped_transition_journal WHERE aggregate_id=$1 AND aggregate_version=2',[orderId])).rowCount,1);
});

// Checkout seller commands have a separate profile and receipt namespace from
// the direct-reservation seller tests above.
import {describe} from 'node:test';
import {hostedPaymentHarness} from '../e2e/hosted-payment-fixture.js';
import {createTenantListCursorCodec} from '../../packages/shared/tenant-list-cursor.js';
import {sellerCheckoutCommand} from '../../modules/agent-commerce/checkout/seller-command.js';
import {cancelSellerCheckoutOrder,sellerCustomer,readSellerCheckoutOrder,listSellerCheckoutOrders,readSellerOrderContact} from '../../modules/agent-commerce/checkout/seller-orders.js';
import {bindStore} from '../../modules/agent-commerce/checkout/authority.js';
import {openException} from '../../modules/agent-commerce/checkout/exceptions.js';
import {COMMERCE_LIMITS} from '../../modules/agent-commerce/checkout/limits.js';
import {hashKey} from '../../modules/agent-commerce/checkout/terms.js';
import {cancelUnpaidOrder} from '../../modules/agent-commerce/checkout/orders.js';
import {applyConfirmedPayment,recordHandover,releaseAllocation} from '../../modules/agent-commerce/checkout/payments.js';
import {settleDueCheckoutHolds} from '../../modules/agent-commerce/checkout/settlement.js';
import {EcpayKeyPair,encodeForm,signFields} from '../../modules/agent-commerce/providers/ecpay/index.js';
describe('hosted checkout seller commands',()=>{
  let f:Awaited<ReturnType<typeof hostedPaymentHarness>>;
  before(async()=>{f=await hostedPaymentHarness('fp_checkout_seller');});
  beforeEach(async()=>{await f.reset();f.settings.consoleEnabled=true;f.install({tenantListCursors:createTenantListCursorCodec(randomBytes(32).toString('base64url'),{environment:'local',origin:f.origin})});});
  after(async()=>f?.stop());
  test('store binding preserves the scoped principal, tenant and scope through cancellation and receipt replay',async()=>{
    const p=await f.placed(),a=await authenticate(f.x.runtime,p.s.owner.cookie.split('=')[1].split(';')[0]),key=randomUUID();
    const bound=async(q:PoolClient)=>(await q.query(`SELECT current_setting('freedom.principal_id') principal,current_setting('freedom.tenant_id') tenant,current_setting('freedom.tenant_scope_id') scope`)).rows[0];
    let runs=0,projections=0;
    const command=()=>sellerCheckoutCommand(f.x.runtime,a,p.s.tenantId,p.s.instanceId,'store:orders:manage','commerce.checkout_order.cancel',
      {kind:'hosted_checkout_order',id:p.order.order_ref},{},key,'1',async(q,context)=>{
        runs++;const before=await bound(q);
        assert.deepEqual(before,{principal:context.tenant.principal_id,tenant:context.tenant.tenant_id,scope:context.tenant.scope.scope_id});
        await cancelUnpaidOrder(q,{storefront_shop_id:context.profile.storefront_shop_id},p.order.order_ref,'seller','seller_cancelled',f.runtime.commercePorts);
        assert.deepEqual(await bound(q),before);return {id:p.order.order_ref};
      },async(q,context,id)=>{
        projections++;assert.deepEqual(await bound(q),{principal:context.tenant.principal_id,tenant:context.tenant.tenant_id,scope:context.tenant.scope.scope_id});
        return (await q.query('SELECT order_id,lifecycle_state,version::text FROM commerce_checkout_orders WHERE order_id=$1',[id])).rows[0];
      });
    assert.equal((await command()).lifecycle_state,'cancelled');assert.equal((await command()).version,'2');
    assert.equal(runs,1);assert.equal(projections,2);
    assert.deepEqual((await f.x.h.pool.query("SELECT response FROM scoped_command_receipts WHERE operation='commerce.checkout_order.cancel'")).rows.map(r=>r.response),[{id:p.order.order_ref}]);
  });
  test('checkout projections mask Unicode names, isolate contact and finance, and preserve expired holds',async()=>{
    const s=await f.x.store(100);await f.setup(s);
    const due=await f.x.due(s),a=await authenticate(f.x.runtime,s.owner.cookie.split('=')[1].split(';')[0]);
    const before=async()=>{const snapshot:Record<string,unknown>={};for(const r of (await f.x.h.pool.query("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename LIKE 'commerce_%' ORDER BY tablename")).rows)snapshot[r.tablename]=(await f.x.h.pool.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS rows FROM ${r.tablename} t`)).rows[0].rows;return snapshot;};
    const saved=await before();
    const read=()=>readSellerCheckoutOrder(f.x.runtime,a,s.tenantId,s.instanceId,due.order_id,{payment:f.runtime.commercePorts?.payment,settings:f.settings});
    const result=await read();assert.equal(result.inventory_state,'hold_expired');assert.equal(result.customer.name_masked,'合○○');assert.equal(result.lines[0].inventory.held,5);
    assert.deepEqual(await before(),saved);
    const contact=await readSellerOrderContact(f.x.runtime,a,s.tenantId,s.instanceId,due.order_id);
    assert.equal(contact.contact?.name,'合成買家');assert.deepEqual(await before(),saved);
    const json=JSON.stringify(result);for(const value of ['合成買家','synthetic-buyer@example.test','0000000000','合成測試地址'])assert.equal(json.includes(value),false,value);
    for(const [name,masked] of [[' Alice ','A○○'],[' 王小明 ','王○○'],[' 😀 buyer ','😀○○'],['   ','○○']])assert.deepEqual(sellerCustomer(name,false),{name_masked:masked,contact_redacted:false});
    const removed=await f.x.h.pool.query(`UPDATE commerce_checkout_contacts SET contact_name=NULL,contact_email=NULL,contact_phone=NULL,delivery=NULL,invoice=NULL,contact_salt=NULL,redacted_at=clock_timestamp() WHERE contact_id=(SELECT contact_id FROM commerce_checkout_orders WHERE order_id=$1)`,[due.order_id]);assert.equal(removed.rowCount,1);
    assert.deepEqual((await read()).customer,{name_masked:null,contact_redacted:true});
    const redacted=await readSellerOrderContact(f.x.runtime,a,s.tenantId,s.instanceId,due.order_id);assert.equal(redacted.contact_redacted,true);assert.equal(redacted.contact,null);assert.equal(redacted.delivery,null);assert.equal(redacted.invoice,null);
  });
  test('checkout list uses exact filters and signed instance/principal/filter-bound cursors',async()=>{
    const s=await f.x.store(100);await f.setup(s);const a=await authenticate(f.x.runtime,s.owner.cookie.split('=')[1].split(';')[0]),options={cursors:f.runtime.tenantListCursors};
    const ids:string[]=[];for(let i=0;i<3;i++){const c=await f.x.frozen(s,1,{contact:{name:'合成'+randomUUID(),email:randomUUID()+'@example.test',phone:randomUUID().slice(0,8)}});ids.push((await f.x.place(s,c)).order_id);}
    const list=(query:unknown)=>listSellerCheckoutOrders(f.x.runtime,a,s.tenantId,s.instanceId,query,options);
    const first=await list({limit:'2'}),second=await list({limit:'2',cursor:first.next_cursor});
    assert.deepEqual([...first.items,...second.items].map(r=>r.order_ref),ids.reverse());assert.equal(second.next_cursor,null);
    assert.equal((await list({display_number:first.items[0].display_number})).items.length,1);
    assert.equal((await list({needs_action:'true'})).items.length,0);
    for(const query of [{limit:'0'},{limit:'51'},{unknown:'x'},{needs_action:'false'},{display_number:'x'},{lifecycle:'bad'}])await assert.rejects(list(query));
    await assert.rejects(list({lifecycle:'open',cursor:first.next_cursor}),code('invalid_cursor'));
    const attention=await f.x.tx(async q=>{await bindStore(q,s.tenantId);return openException(q,{tenantId:s.tenantId,instanceId:s.instanceId,orderId:ids[0],kind:'unmatched_payment',subjectKind:'payment_event',subjectId:randomUUID()});});assert(attention.case_id);assert.deepEqual((await list({needs_action:'true'})).items.map(v=>v.order_ref),[ids[0]]);
    await cancelSellerCheckoutOrder(f.x.runtime,a,s.tenantId,s.instanceId,ids[1],randomUUID(),'1');
    await f.x.h.pool.query("UPDATE commerce_checkout_orders SET lifecycle_state='closed',closed_at=clock_timestamp(),version=version+1 WHERE order_id=$1",[ids[2]]);
    assert.deepEqual((await list({lifecycle:'cancelled'})).items.map(v=>v.order_ref),[ids[1]]);assert.deepEqual((await list({lifecycle:'closed'})).items.map(v=>v.order_ref),[ids[2]]);assert.deepEqual((await list({lifecycle:'open'})).items.map(v=>v.order_ref),[ids[0]]);
    await assert.rejects(cancelSellerCheckoutOrder(f.x.runtime,a,s.tenantId,s.instanceId,ids[2],randomUUID(),'2'),code('checkout_order_closed'));
  });

  test('seller unpaid cancel checks the locked version, projects replays and schedules handed-off attempts',async()=>{
    const p=await f.placed(),a=await authenticate(f.x.runtime,p.s.owner.cookie.split('=')[1].split(';')[0]),options={settings:f.settings,payment:f.runtime.commercePorts?.payment},key=randomUUID();
    await f.x.h.pool.query('UPDATE commerce_payment_attempts SET journaled_at=clock_timestamp(),handed_off_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1',[p.payment.attempt_ref]);
    const cancel=(version:string,k=key)=>cancelSellerCheckoutOrder(f.x.runtime,a,p.s.tenantId,p.s.instanceId,p.order.order_ref,k,version,options);
    await assert.rejects(cancel('2'),code('version_conflict'));
    const result=await cancel('1');assert.equal(result.version,'2');assert.equal(result.lifecycle_state,'cancelled');assert.equal(result.cancel_reason,'seller_cancelled');
    await f.x.h.pool.query(`UPDATE commerce_checkout_contacts SET contact_name=NULL,contact_email=NULL,contact_phone=NULL,delivery=NULL,invoice=NULL,contact_salt=NULL,redacted_at=clock_timestamp() WHERE contact_id=(SELECT contact_id FROM commerce_checkout_orders WHERE order_id=$1)`,[p.order.order_ref]);
    const replay=await cancel('1');assert.equal(replay.version,'2');assert.deepEqual(replay.customer,{name_masked:null,contact_redacted:true});assert.equal((await cancel('2',randomUUID())).version,'2');
    const due=(await f.x.h.pool.query("SELECT due_at<=clock_timestamp() AS ready FROM commerce_due_work WHERE kind='payment_query' AND target_id=$1",[p.payment.attempt_ref])).rows[0];assert.equal(due.ready,true);
    f.settings.quarantine=true;await assert.rejects(cancel('2',randomUUID()),code('commerce_quarantined'));
    assert.equal((await readSellerCheckoutOrder(f.x.runtime,a,p.s.tenantId,p.s.instanceId,p.order.order_ref,options)).actions.cancel,false);
    const receipts=(await f.x.h.pool.query("SELECT response FROM scoped_command_receipts WHERE operation='commerce.checkout_order.cancel'")).rows;assert.equal(receipts.length,2);for(const r of receipts)assert.deepEqual(r.response,{id:p.order.order_ref});
  });

  async function member(s:Awaited<ReturnType<typeof f.x.store>>,role:'admin'|'viewer'|'operator',caps:string[]=[]){
    const m=await f.x.h.person('合成成員'+randomUUID()),principal=await f.x.h.candidate(s.owner,m.id);await f.x.h.accept(m.session,s.tenantId,await f.x.h.invite(s.owner,s.tenantId,principal,role));
    if(caps.length)await f.x.h.pool.query(`INSERT INTO tenant_module_permissions(tenant_id,principal_id,instance_id,capabilities,status,granted_by_principal_id) SELECT $1,$2,$3,$4,'active',principal_id FROM principals WHERE user_ref=$5`,[s.tenantId,principal,s.instanceId,['store:read',...caps],s.owner.user.user_id]);return {...m,principal};
  }
  const request=(s:{root:string;owner:Session},method:string,path:string,session=s.owner,body?:unknown,headers:Record<string,string>={})=>f.x.h.call(method,s.root+path,session,body,headers,f.app);
  test('seller HTTP capabilities are independent; owner/admin and explicit grants use the installed release',async()=>{
    const p=await f.placed(),application=await f.x.tx(q=>applyConfirmedPayment(q,{orderId:p.order.order_ref,paymentRef:p.payment.attempt_ref,amountMinor:600,currency:'TWD',simulated:false}));
    for(const [role,caps] of [['owner',[]],['admin',[]],['viewer',['store:orders:read']],['viewer',['store:finance:read']],['viewer',['store:customers:read']],['operator',['store:orders:manage']],['operator',['store:refund']]] as const){
      const session=role==='owner'?p.s.owner:(await member(p.s,role,[...caps])).session,all=role==='owner'||role==='admin',orders=all||(caps as readonly string[]).includes('store:orders:read'),customers=all||(caps as readonly string[]).includes('store:customers:read'),manage=all||(caps as readonly string[]).includes('store:orders:manage');
      const c=await f.x.tx(async q=>{await bindStore(q,p.s.tenantId);return openException(q,{tenantId:p.s.tenantId,instanceId:p.s.instanceId,kind:'unmatched_payment',subjectKind:'payment_event',subjectId:randomUUID()});});
      for(const path of ['/checkout-orders','/checkout-orders/'+p.order.order_ref,'/exception-cases?view=retailer','/exception-cases/'+c.case_id]){
        const r=await request(p.s,'GET',path,session);assert.equal(r.status,orders?200:403,role+' '+caps+' '+path+' '+JSON.stringify(r.data));assert.equal(r.response.headers.get('Cache-Control'),'private, no-store');
        if(!orders)assert.equal(r.data.code,'capability_denied');
        if(orders&&path==='/checkout-orders/'+p.order.order_ref){assert.equal(r.data.payment_detail!==null,all);assert.equal(r.response.headers.get('ETag'),`"${r.data.version}"`);}
        if(orders&&path==='/exception-cases/'+c.case_id&&!manage){assert.deepEqual(r.data.allowed_actions,[]);assert.equal(r.data.payment_facts,null);}
      }
      const contact=await request(p.s,'GET','/checkout-orders/'+p.order.order_ref+'/contact',session);assert.equal(contact.status,customers?200:403);assert.equal(contact.response.headers.get('ETag'),null);
      const version=(await f.x.h.pool.query('SELECT version::text FROM commerce_checkout_orders WHERE order_id=$1',[p.order.order_ref])).rows[0].version;
      const cancelled=await request(p.s,'POST','/checkout-orders/'+p.order.order_ref+'/cancel',session,{}, {'Idempotency-Key':randomUUID(),'If-Match':`"${version}"`});assert.equal(cancelled.status,manage?200:403,JSON.stringify(cancelled.data));
      const finance=all||(caps as readonly string[]).includes('store:finance:read'),refund=all||(caps as readonly string[]).includes('store:refund');
      assert.equal((await request(p.s,'GET','/checkout-orders/'+p.order.order_ref+'/refunds',session)).status,finance?200:403);
      await f.x.h.pool.query("DELETE FROM auth_rate_limits WHERE bucket LIKE 'commerce:paymentQueryOrder%'");
      assert.equal((await request(p.s,'POST','/checkout-orders/'+p.order.order_ref+'/payment-queries',session,{})).status,orders||finance?200:403);
      const today=(await f.x.h.pool.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Taipei','YYYY-MM-DD') today")).rows[0].today;
      const recorded=await request(p.s,'POST','/checkout-orders/'+p.order.order_ref+'/refunds',session,{application_ref:application.application_id,amount_minor:100,refunded_on:today},{'Idempotency-Key':randomUUID()});assert.equal(recorded.status,refund?201:403,JSON.stringify(recorded.data));
      const resolved=await request(p.s,'POST','/exception-cases/'+c.case_id+'/actions/resolve_with_evidence',session,{code:'checked_with_provider',provider_date:today,provider_reference:'F1'}, {'Idempotency-Key':randomUUID(),'If-Match':'"1"'});assert.equal(resolved.status,manage?200:403,JSON.stringify(resolved.data));
    }
    const receipts=(await f.x.h.pool.query("SELECT response FROM scoped_command_receipts WHERE operation IN ('commerce.checkout_order.cancel','commerce.exception_case.resolve_with_evidence','commerce.exception_case.retry_allocation','commerce.refund.record')")).rows;for(const r of receipts)assert.deepEqual(Object.keys(r.response),['id']);
    const old=await f.x.store();assert.equal((await request(old,'GET','/checkout-orders')).status,403);
    const granted=await member(p.s,'viewer',['store:orders:read']);assert.equal((await request(p.s,'GET','/checkout-orders',granted.session)).status,200);
    await f.x.h.pool.query("UPDATE tenant_module_permissions SET capabilities=ARRAY['store:read'],updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=$1 AND principal_id=$2",[p.s.tenantId,granted.principal]);assert.equal((await request(p.s,'GET','/checkout-orders',granted.session)).status,403);
    await f.x.h.pool.query("UPDATE tenant_module_permissions SET status='revoked',revoked_at=clock_timestamp(),updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=$1 AND principal_id=$2",[p.s.tenantId,granted.principal]);assert.equal((await request(p.s,'GET','/checkout-orders',granted.session)).status,404);
  });
  test('seller HTTP validates strict queries, version headers and console mounting without exposing foreign orders',async()=>{
    const p=await f.placed(),order='/checkout-orders/'+p.order.order_ref;
    for(const path of ['/checkout-orders?unknown=x','/checkout-orders?limit=1&limit=2',order+'?x=1',order+'/contact?x=1'])assert.equal((await request(p.s,'GET',path)).status,422);
    const missing=await request(p.s,'POST',order+'/cancel',p.s.owner,{}, {'Idempotency-Key':randomUUID()});assert.equal(missing.status,428);assert.equal(missing.data.code,'version_required');
    assert.equal((await request(p.s,'POST',order+'/cancel',p.s.owner,{reason:'free text'},{'Idempotency-Key':randomUUID(),'If-Match':'"1"'})).status,422);
    const foreign=await f.x.store();await f.setup(foreign);assert.equal((await request(foreign,'GET',order)).status,404);
    const another=await f.x.store();await f.setup(another);const viewer=await member(another,'admin');assert.equal((await request(p.s,'GET',order,viewer.session)).status,404);
    f.settings.checkoutEnabled=false;assert.equal((await request(p.s,'GET',order)).status,200);
    f.settings.consoleEnabled=false;f.install();
    for(const [method,path,body] of [['GET','/checkout-orders',undefined],['GET',order,undefined],['GET',order+'/contact',undefined],['POST',order+'/cancel',{}],['GET',order+'/refunds',undefined],['POST',order+'/refunds',{}],['POST',order+'/payment-queries',{}],['GET','/exception-cases?view=retailer',undefined],['GET','/exception-cases/'+randomUUID(),undefined],['POST','/exception-cases/'+randomUUID()+'/actions/resolve_with_evidence',{}]] as const)assert.equal((await request(p.s,method,path,p.s.owner,body)).status,404);
    f.settings.consoleEnabled=true;
  });
  test('contact budget counts denied reads, refuses at the principal limit and leaves other principals available',async()=>{
    const p=await f.placed(),denied=await member(p.s,'viewer',['store:orders:read']),path='/checkout-orders/'+p.order.order_ref+'/contact',bucket='commerce:customerDataPrincipal:'+hashKey(denied.principal);
    assert.equal((await request(p.s,'GET',path,denied.session)).status,403);
    assert.equal((await f.x.h.pool.query('SELECT attempts FROM auth_rate_limits WHERE bucket=$1',[bucket])).rows[0].attempts,1);
    await f.x.h.pool.query('UPDATE auth_rate_limits SET attempts=$2 WHERE bucket=$1',[bucket,COMMERCE_LIMITS.customerDataPrincipal.limit]);
    const limited=await request(p.s,'GET',path,denied.session);assert.equal(limited.status,429);assert.equal(limited.data.code,'commerce_rate_limited');assert.ok(Number(limited.response.headers.get('Retry-After'))>0);
    assert.equal((await request(p.s,'GET',path)).status,200);
  });

  test('all inventory axes and line counters derive from retained holds and allocations without read effects',async()=>{
    const p=await f.placed(),a=await authenticate(f.x.runtime,p.s.owner.cookie.split('=')[1].split(';')[0]),options={settings:f.settings,payment:f.runtime.commercePorts?.payment};
    const read=()=>readSellerCheckoutOrder(f.x.runtime,a,p.s.tenantId,p.s.instanceId,p.order.order_ref,options);
    assert.equal((await read()).inventory_state,'held');assert.equal((await read()).payment_state,'unpaid');
    await f.x.tx(q=>applyConfirmedPayment(q,{orderId:p.order.order_ref,paymentRef:p.payment.attempt_ref,amountMinor:500,currency:'TWD',simulated:false}));
    let view=await read();assert.equal(view.inventory_state,'allocated');assert.equal(view.payment_state,'confirmed');assert.equal(view.actions.cancel,false);assert.deepEqual(view.lines[0].inventory,{held:0,allocated:5,shipped:0,released:0});
    await f.x.tx(q=>recordHandover(q,p.s,{shipmentRef:randomUUID(),lines:[{orderId:p.order.order_ref,itemId:p.s.product.product_id,quantity:2}]}));
    view=await read();assert.equal(view.inventory_state,'partially_shipped');assert.deepEqual(view.lines[0].inventory,{held:0,allocated:3,shipped:2,released:0});
    await f.x.tx(q=>recordHandover(q,p.s,{shipmentRef:randomUUID(),lines:[{orderId:p.order.order_ref,itemId:p.s.product.product_id,quantity:3}]}));assert.equal((await read()).inventory_state,'shipped');
    const other=await f.placed(),actor=await authenticate(f.x.runtime,other.s.owner.cookie.split('=')[1].split(';')[0]);
    await f.x.tx(q=>applyConfirmedPayment(q,{orderId:other.order.order_ref,paymentRef:other.payment.attempt_ref,amountMinor:500,currency:'TWD',simulated:false}));
    await f.x.tx(q=>releaseAllocation(q,other.s,{orderId:other.order.order_ref,commandRef:randomUUID()}));
    view=await readSellerCheckoutOrder(f.x.runtime,actor,other.s.tenantId,other.s.instanceId,other.order.order_ref,options);assert.equal(view.inventory_state,'released');assert.equal(view.lines[0].inventory.released,5);
    const due=await f.x.due(other.s);await f.x.tx(q=>settleDueCheckoutHolds(q,[other.s.product.product_id]));await f.x.h.pool.query('UPDATE commerce_items SET stock=0 WHERE item_id=$1',[other.s.product.product_id]);
    await f.x.tx(q=>applyConfirmedPayment(q,{orderId:due.order_id,paymentRef:randomUUID(),amountMinor:500,currency:'TWD',simulated:false}));
    assert.equal((await readSellerCheckoutOrder(f.x.runtime,actor,other.s.tenantId,other.s.instanceId,due.order_id,options)).inventory_state,'unallocated');
  });
  test('historical orders stay private across same-tenant store replacement and cursors reject another principal or store',async()=>{
    const p=await f.placed();for(let i=0;i<2;i++){const c=await f.x.frozen(p.s,1,{contact:{name:'合成'+randomUUID(),email:randomUUID()+'@example.test',phone:randomUUID().slice(0,8)}});await f.x.place(p.s,c);}
    const first=await request(p.s,'GET','/checkout-orders?limit=1');assert.equal(first.status,200);assert(first.data.next_cursor);
    const viewer=await member(p.s,'viewer',['store:orders:read']);assert.equal((await request(p.s,'GET','/checkout-orders?cursor='+encodeURIComponent(first.data.next_cursor),viewer.session)).status,422);
    await f.x.h.pool.query("UPDATE module_instances SET status='archived',version=version+1 WHERE instance_id=$1",[p.s.instanceId]);
    const workspace=await f.x.h.workspace(p.s.owner,p.s.tenantId,'合成新櫃檯'),plan=await f.x.h.plan(p.s.owner,p.s.tenantId,f.x.h.planBody('guild_commerce_sales',workspace,'hosted-store','hosted-store@1.0.0'));assert.equal(plan.status,201,JSON.stringify(plan.data));assert.equal((await f.x.h.launch(p.s.owner,p.s.tenantId,plan)).data.state,'succeeded');
    const id=(await f.x.h.pool.query("SELECT instance_id FROM module_instances WHERE tenant_id=$1 AND status='active'",[p.s.tenantId])).rows[0].instance_id,root=`/tenants/${p.s.tenantId}/storefronts/${id}`;
    assert.equal((await f.x.h.call('POST',root+'/setup',p.s.owner,{name:'合成新商店',slug:'r-'+randomUUID().slice(0,12),currency:'TWD'},{'Idempotency-Key':randomUUID()},f.app)).status,201);
    const next={...p.s,instanceId:id,root};await f.setup(next);
    assert.equal((await request(next,'GET','/checkout-orders/'+p.order.order_ref)).status,404);
    assert.equal((await request(next,'GET','/checkout-orders?cursor='+encodeURIComponent(first.data.next_cursor))).status,422);
  });
  test('suspended selling instances can cancel obligations, while inactive tenants cannot write',async()=>{
    const p=await f.placed(),order='/checkout-orders/'+p.order.order_ref;
    await f.x.h.pool.query("UPDATE module_instances SET status='suspended',version=version+1 WHERE instance_id=$1",[p.s.instanceId]);
    f.settings.checkoutEnabled=false;assert.equal((await request(p.s,'GET',order)).status,200);const r=await request(p.s,'POST',order+'/cancel',p.s.owner,{}, {'Idempotency-Key':randomUUID(),'If-Match':'"1"'});assert.equal(r.status,200,JSON.stringify(r.data));
    await f.x.h.pool.query("UPDATE tenants SET status='suspended',version=version+1 WHERE tenant_id=$1",[p.s.tenantId]);
    const view=await request(p.s,'GET',order);assert.equal(view.status,200);assert.equal(view.data.actions.cancel,false);assert.equal(view.data.actions.record_refund,false);
    assert.equal((await request(p.s,'POST',order+'/cancel',p.s.owner,{}, {'Idempotency-Key':randomUUID(),'If-Match':'"2"'})).status,403);
  });

  for(const first of ['cancel','notification'] as const)test(`seller cancel and signed notification serialize with ${first} committing first`,async()=>{
    const p=await f.placed(),a=await authenticate(f.x.runtime,p.s.owner.cookie.split('=')[1].split(';')[0]),trade=(await f.x.h.pool.query('SELECT merchant_trade_no FROM commerce_payment_attempts WHERE attempt_id=$1',[p.payment.attempt_ref])).rows[0].merchant_trade_no;
    const signed=encodeForm(signFields({MerchantID:'1234567',MerchantTradeNo:trade,TradeNo:'T'+randomBytes(8).toString('hex').toUpperCase(),RtnCode:'1',RtnMsg:'合成付款',TradeAmt:'5',SimulatePaid:'0',PaymentDate:'2026/10/15 10:20:30',PaymentType:'Credit_CreditCard'},EcpayKeyPair.of(p.provider.material.hash_key,p.provider.material.hash_iv),'sha256'));
    const notification=async()=>{const r=await f.app.fetch(new Request(f.origin+'/api/v1/provider-callbacks/ecpay/'+p.provider.accountRef+'/payment',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:signed}));assert.equal(r.status,200);assert.equal(await r.text(),'1|OK');};
    const cancel=()=>cancelSellerCheckoutOrder(f.x.runtime,a,p.s.tenantId,p.s.instanceId,p.order.order_ref,randomUUID(),'1',{settings:f.settings,payment:f.runtime.commercePorts?.payment}).then(data=>({status:200,data}),error=>({status:error.status,data:{code:error.code}}));
    const signal=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};},atCommit=signal(),competitor=signal(),releaseCommit=signal(),connect=f.x.runtime.connect;let paused=false;
    f.x.runtime.connect=(async()=>{
      const q=await (connect as ()=>Promise<PoolClient>).call(f.x.runtime),query=q.query,release=q.release;let target=false;
      q.query=(async(...args:unknown[])=>{
        const sql=String(args[0]);if(sql.startsWith(first==='cancel'?'INSERT INTO scoped_command_receipts':'INSERT INTO commerce_hosted_payment_events'))target=true;
        if(target&&args[0]==='COMMIT'){paused=true;atCommit.resolve();await releaseCommit.promise;}
        if(!target&&paused&&sql.startsWith('SELECT pg_advisory_xact_lock')&&String((args[1] as unknown[])?.[0]).startsWith('commerce-orders/'))competitor.resolve();
        return (query as Function).apply(q,args);
      }) as typeof q.query;
      q.release=(error?:Error|boolean)=>{q.query=query;q.release=release;release.call(q,error);};return q;
    }) as typeof f.x.runtime.connect;
    try{
      const leading=first==='cancel'?cancel():notification();await Promise.race([atCommit.promise,leading.then(()=>{throw Error('first command did not reach the commit barrier');})]);const following=first==='cancel'?notification():cancel();await Promise.race([competitor.promise,following.then(()=>{throw Error('competing command did not wait for the lock');})]);releaseCommit.resolve();
      const [lead,follow]=await Promise.all([leading,following]),cancelled=first==='cancel'?lead:follow;
      assert(cancelled);assert.equal(cancelled.status,first==='cancel'?200:409);if(first==='notification'){assert('code' in cancelled.data);assert.equal(cancelled.data.code,'payment_already_applied');}
      const applications=(await f.x.h.pool.query('SELECT outcome FROM commerce_checkout_payment_applications WHERE order_id=$1',[p.order.order_ref])).rows;assert.deepEqual(applications.map(r=>r.outcome),[first==='cancel'?'after_cancel':'converted']);
      const receipts=(await f.x.h.pool.query("SELECT response FROM scoped_command_receipts WHERE operation='commerce.checkout_order.cancel'")).rows;assert.equal(receipts.length,first==='cancel'?1:0);for(const r of receipts)assert.deepEqual(r.response,{id:p.order.order_ref});
    }finally{releaseCommit.resolve();f.x.runtime.connect=connect;}
  });

  test('seller payment summaries include simulated and pending without exposing contact data',async()=>{
    for(const state of ['simulated','pending'] as const){
      const p=await f.placed();
      if(state==='simulated')await f.x.tx(q=>applyConfirmedPayment(q,{orderId:p.order.order_ref,paymentRef:p.payment.attempt_ref,amountMinor:500,currency:'TWD',simulated:true}));
      else await f.x.h.pool.query(`INSERT INTO commerce_hosted_payment_events(tenant_id,instance_id,account_id,attempt_id,source,outcome) SELECT tenant_id,instance_id,account_id,attempt_id,'browser_return','returned' FROM commerce_payment_attempts WHERE attempt_id=$1`,[p.payment.attempt_ref]);
      const result=await request(p.s,'GET','/checkout-orders/'+p.order.order_ref);assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.payment_state,state);
      assert(!JSON.stringify(result.data).includes('synthetic-buyer@example.test'));if(state==='simulated')assert.equal(result.data.payment_detail.applications[0].attempt_ref,null);
    }
  });

});
