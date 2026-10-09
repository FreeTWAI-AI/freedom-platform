import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { serve } from '@hono/node-server';
import { TENANT_CURSOR_TEST_KEY } from './tenant-cursor-fixture.js';
import { Pool } from 'pg';
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
    h.planBody('guild_commerce_sales', t.workspaceId, 'hosted-store', 'hosted-store@1.0.0')), 201);
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
  await h.pool.query(`INSERT INTO commerce_orders(order_id,public_shop_id,external_id,request_sha256,currency,total_minor,created_at,expires_at,
    order_profile,quote_id,buyer_principal_id,client_order_id,reservation_state,reservation_version)
    SELECT $2,o.public_shop_id,o.buyer_principal_id::text||':'||$4::text,$5,o.currency,o.total_minor,quote.quoted_at+interval '1 minute',quote.quoted_at+interval '31 minutes',
      'hosted_direct_reservation',$3,o.buyer_principal_id,$4::uuid,'reserved',1 FROM commerce_orders o JOIN commerce_order_quotes quote ON quote.quote_id=$3 WHERE order_id=$1`,
    [source.order_id,orderId,quoteId,intent,digest({quote_id:quoteId,terms_sha256:q.terms_sha256,client_order_id:intent})]);
  await h.pool.query(`INSERT INTO commerce_order_lines SELECT $2,selection_id,transfer_id,item_id,quantity,snapshot,acceptance_id,listing_sha256,order_profile FROM commerce_order_lines WHERE order_id=$1`,[source.order_id,orderId]);
  await h.pool.query('UPDATE commerce_items SET reserved=reserved+1 WHERE item_id=$1',[s.product.product_id]);
  const page=ok(await wire('GET',s.root+'/orders',s.owner));
  assert.equal(page.items.find((o:any)=>o.order_id===orderId).state,'expired');
  const result=ok(await wire('POST',s.root+'/orders/'+orderId+'/cancel',s.owner,{},randomUUID(),'2'));
  assert.equal(result.state,'expired');assert.equal(result.close_reason,'reservation_expired');assert.equal(result.version,'2');
  assert.equal((await h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1',[s.product.product_id])).rows[0].reserved,0);
  assert.equal((await h.pool.query('SELECT 1 FROM scoped_transition_journal WHERE aggregate_id=$1 AND aggregate_version=2',[orderId])).rowCount,1);
});
