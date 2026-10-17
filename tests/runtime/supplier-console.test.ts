import {retainedHostedOrder} from '../helpers/hosted-inventory-history.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {digest} from '../../packages/db/index.js';
import type {SupplyProductView} from '../../contracts/guild-launchpad/v1/hosted-supply-catalog.js';
import {DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {TENANT_CURSOR_TEST_KEY} from './tenant-cursor-fixture.js';
import {createRegistryHarness,type RegistryHarness,type Reply,type Session} from './module-registry-harness.js';
import { Pool } from 'pg';
import { createApp, nodeRuntime } from '../../apps/platform-api/src/app.js';
import { ReadinessError } from '../../apps/platform-api/src/readiness.js';
import { readWorkerConfig, workerRuntime, type WorkerConfig, type WorkerEnv } from '../../apps/platform-api/src/worker.js';

const origin = 'http://127.0.0.1:4310';
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
after(async () => { await pool.end(); });

function env(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return { HYPERDRIVE: { connectionString: 'postgres://synthetic@localhost/synthetic' }, ASSETS: { fetch: async () => new Response('fixture') }, FREEDOM_ENV: 'local', APP_ORIGIN: origin, ...overrides } as WorkerEnv;
}

test('SC-FLAG-01 Node supplier console defaults off and accepts only boolean true', () => {
  for (const option of [undefined, false, 'true', 1, true]) {
    assert.equal(nodeRuntime('local', origin, { supplierConsoleEnabled: option as boolean }).supplierConsoleEnabled, option === true);
  }
});

test('SC-FLAG-02 Worker supplier console accepts only the exact true string', () => {
  for (const flag of [undefined, 'false', 'TRUE', '1', ' true', 'true']) {
    const runtime = workerRuntime({ FREEDOM_SUPPLIER_CONSOLE_ENABLED: flag, FREEDOM_GUILD_LAUNCHPAD_ENABLED: 'true' } as WorkerEnv,
      { origin, release: '0'.repeat(40), trustConnectingIp: false } as WorkerConfig);
    assert.equal(runtime.supplierConsoleEnabled, flag === 'true');
    assert.equal(runtime.guildLaunchpadEnabled, true);
  }
});

test('SC-FLAG-03 Worker readiness rejects supplier console flag typos', () => {
  for (const flag of ['TRUE', '1', ' true']) {
    assert.throws(() => readWorkerConfig(env({ FREEDOM_SUPPLIER_CONSOLE_ENABLED: flag, FREEDOM_GUILD_LAUNCHPAD_ENABLED: 'true' })),
      new ReadinessError('Supplier console flag must be true or false.'));
  }
});

test('SC-FLAG-04 Worker readiness requires launchpad when supplier console is enabled', () => {
  for (const flag of [undefined, 'false', 'TRUE']) {
    assert.throws(() => readWorkerConfig(env({ FREEDOM_SUPPLIER_CONSOLE_ENABLED: 'true', FREEDOM_GUILD_LAUNCHPAD_ENABLED: flag })),
      new ReadinessError('Supplier console requires guild launchpad.'));
  }
});

test('SC-FLAG-05 Worker readiness accepts disabled, absent and complete enabled configurations', () => {
  for (const flag of [undefined, 'false']) {
    assert.doesNotThrow(() => readWorkerConfig(env({ FREEDOM_SUPPLIER_CONSOLE_ENABLED: flag })));
  }
  assert.doesNotThrow(() => readWorkerConfig(env({ FREEDOM_SUPPLIER_CONSOLE_ENABLED: 'true', FREEDOM_GUILD_LAUNCHPAD_ENABLED: 'true' })));
});

test('SC-FLAG-06 site supplier console flag requires both launchpad and console without database reads', async () => {
  for (const guildLaunchpadEnabled of [undefined, false, true]) {
    for (const supplierConsoleEnabled of [undefined, false, true]) {
      const app = createApp(pool, origin, 'local', { guildLaunchpadEnabled, supplierConsoleEnabled });
      const response = await app.request('/api/v1/site');
      assert.equal(response.status, 200);
      assert.equal((await response.json()).supplier_console_enabled, guildLaunchpadEnabled === true && supplierConsoleEnabled === true);
    }
  }
  assert.equal(pool.totalCount, 0);
});


describe('supplier console restricted runtime',()=>{
const statements:{text:string;values:any[]}[]=[];
let h: RegistryHarness, runtime: Pool, app: ReturnType<typeof createApp>, closed: ReturnType<typeof createApp>;
const role = `supplier_console_${process.pid}_${Date.now()}`;
const supplierGuild = 'guild_product_quality_supply', retailGuild = 'guild_commerce_sales';
type Store = {owner: Session; tenantId: string; instanceId: string; root: string};
const catalog = {name: '合成供貨目錄', description: '只提供供貨資料', currency: 'TWD'};
const product = {title: '供貨茶杯', description: '經授權的商品介紹', cost_minor: 400, stock: 10};
const terms = {cost_minor: 400, shipping_minor: 50, shipping_terms: '確認後三天出貨', return_terms: '瑕疵請聯絡供貨方'};
const ok = (reply: Reply, status = 200) => {
  assert.equal(reply.status, status, JSON.stringify(reply.data));
  return reply.data;
};
const get = (s: Store, path: string, session = s.owner, target = app) =>
  h.call('GET', s.root + path, session, undefined, {}, target);
const send = (s: Store, path: string, body: unknown = {}, version?: string, key = randomUUID(), method = 'POST', session = s.owner, target = app) =>
  h.call(method, s.root + path, session, body, {'Idempotency-Key': key, ...(version ? {'If-Match': `"${version}"`} : {})}, target);
const command = (path: string, session: Session, body: unknown, version?: string, key = randomUUID()) =>
  h.call('POST', path, session, body, {'Idempotency-Key': key, ...(version ? {'If-Match': `"${version}"`} : {})}, app);

async function open(name: string, guild = supplierGuild, owner?: Session): Promise<Store> {
  owner ??= (await h.person(name)).session;
  await h.fullMember(owner.user.user_id, guild);
  const {tenantId, workspaceId} = await h.createTenant(owner, name);
  const planned = await h.plan(owner, tenantId, h.planBody(guild, workspaceId, 'hosted-store', 'hosted-store@1.0.0'));
  ok(planned, 201);
  const launched = await h.launch(owner, tenantId, planned);
  assert.ok([200, 202].includes(launched.status), JSON.stringify(launched.data));
  assert.equal(launched.data.state, 'succeeded');
  const instanceId = (await h.pool.query("SELECT instance_id FROM module_instances WHERE tenant_id=$1 AND module_key='storefront'", [tenantId])).rows[0].instance_id;
  return {owner, tenantId, instanceId, root: `/tenants/${tenantId}/storefronts/${instanceId}`};
}
async function supplier(name = catalog.name) {
  const s = await open(name);
  ok(await send(s, '/supply-profile', {...catalog, name}), 201);
  return s;
}
async function retailer(name = '零售 B') {
  const s = await open(name, retailGuild);
  ok(await send(s, '/setup', {name, slug: `retail-${randomUUID().slice(0, 12)}`, currency: 'TWD'}), 201);
  return s;
}
async function storedReceipt(key: string, expected: Record<string, unknown>) {
  const rows = (await h.pool.query('SELECT response FROM scoped_command_receipts WHERE idempotency_key=$1', [key])).rows;
  assert.deepEqual(rows, [{response: expected}], 'the durable receipt stores only its exact stable acknowledgement');
}
async function readSupplyProduct(s: Store, productId: string): Promise<SupplyProductView> {
  const reply = await get(s, '/supply-products');
  const item = (ok(reply).items as SupplyProductView[]).find(row => row.product_id === productId);
  privateReply(reply); assert.ok(item, 'the authorized GET returns the newly saved product');
  return item;
}
async function createSupplyProduct(s: Store, input = product) {
  const key = randomUUID(), reply = await send(s, '/supply-products', input, undefined, key);
  const receipt = ok(reply, 201); privateReply(reply);
  assert.deepEqual(receipt, {product_id: receipt.product_id, version: '1'});
  await storedReceipt(key, receipt);
  const item = await readSupplyProduct(s, receipt.product_id);
  assert.equal(item.version, receipt.version);
  return item;
}
async function supplyProduct(s: Store) {
  const item = await createSupplyProduct(s);
  const saved = ok(await send(s, `/products/${item.product_id}/supply-terms`, terms, item.version, randomUUID(), 'PATCH'));
  return {...item, version: saved.version};
}
const offer = async (s: Store, item: {product_id: string; version: string}) =>
  ok(await send(s, `/products/${item.product_id}/supply-offer`, {}, item.version));
const propose = async (s: Store, offered: {offer_id: string; terms_sha256: string}, price = 1200) =>
  ok(await send(s, '/distribution-selections', {offer_id: offered.offer_id, terms_sha256: offered.terms_sha256, retail_price_minor: price}), 201);
const accept = async (s: Store, selection: {selection_id: string; listing_sha256: string; version: string}) =>
  ok(await send(s, `/supply-requests/${selection.selection_id}/decision`, {decision: 'accepted', listing_sha256: selection.listing_sha256}, selection.version));
const publish = async (s: Store) => ok(await send(s, '/publish', {}, ok(await get(s, '')).version));
const profileRow = async (s: Store) => (await h.pool.query('SELECT * FROM commerce_storefront_profiles WHERE instance_id=$1', [s.instanceId])).rows[0];
const ownRow = async (s: Store, productId: string) => (await h.pool.query(`SELECT l.selection_id,l.aggregate_version::text AS version,l.retail_price_minor,l.own_retail_enabled,
  i.item_id,i.stock,i.reserved,i.price_minor AS cost_minor
  FROM commerce_items i JOIN commerce_selections l USING(item_id)
  JOIN commerce_storefront_profiles p ON p.supply_shop_id=i.shop_id AND p.storefront_shop_id=l.shop_id
  WHERE p.instance_id=$1 AND i.item_id=$2`, [s.instanceId, productId])).rows[0];
async function invite(s: Store, person: Session, capabilities: string[], memberRole: 'operator' | 'admin' = 'operator') {
  const principal = await h.candidate(s.owner, person.user.user_id);
  const invitation = await h.post(`/tenants/${s.tenantId}/invitations`, s.owner, {
    invitee_principal_id: principal, role: memberRole,
    instance_capabilities: capabilities.length ? [{instance_id: s.instanceId, capabilities}] : [],
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  });
  ok(invitation, 201);
  await h.accept(person, s.tenantId, invitation);
  return principal;
}
async function admit(s: Store) {
  const setting = ok(await get(s, '/reservation-setting'));
  assert.equal(setting.reservation_enabled, false);
  return ok(await send(s, '/reservation-setting', {reservation_enabled: true}, setting.version, randomUUID(), 'PATCH'));
}
function privateReply(reply: Reply) {
  assert.equal(reply.response.headers.get('cache-control'), 'private, no-store');
  assert.match(reply.response.headers.get('vary') ?? '', /Cookie/);
}

before(async () => {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url && /^\/fp_[a-z0-9_]+$/.test(new URL(url).pathname), 'Explicit disposable TEST_DATABASE_URL is required');
  h = await createRegistryHarness('fp_supplier_console');
  await h.admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    GRANT USAGE ON SCHEMA ${h.schema} TO ${role};
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${h.schema} TO ${role};
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${h.schema} TO ${role};
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${h.schema} TO ${role}`);
  const runtimeUrl = new URL(url); runtimeUrl.username = role; runtimeUrl.password = '';
  runtime = new Pool({connectionString: runtimeUrl.toString(), options: `-c search_path=${h.schema} -c statement_timeout=20000`, max: 6});
  runtime.on('connect',client=>{
    const native=client.query;
    client.query=function(this:typeof client,...args:any[]) {
      const first=args[0],text=typeof first==='string'?first:first?.text;
      if(text?.includes('/* supplier-console:'))statements.push({text,values:args[1]??first?.values});
      return (native as Function).apply(this,args);
    } as typeof client.query;
  });
  app = createApp(runtime, h.origin, 'local', {guildLaunchpadEnabled: true, hostedReservationsEnabled: true, supplierConsoleEnabled:true, tenantCursorSigningKey: TENANT_CURSOR_TEST_KEY});
  closed = createApp(runtime, h.origin, 'local', {guildLaunchpadEnabled:true,hostedReservationsEnabled:true,tenantCursorSigningKey:TENANT_CURSOR_TEST_KEY});
});
after(async () => {
  await runtime?.end();
  if (h) {
    await h.stop();
    const admin = new Pool({connectionString: process.env.TEST_DATABASE_URL});
    try { await admin.query(`DROP ROLE ${role}`); } finally { await admin.end(); }
  }
});
beforeEach(async () => {
  await h.reset();
  for (const guild of [supplierGuild, retailGuild]) {
    await h.pool.query(`INSERT INTO guild_application_offerings(offering_id,community_id,guild_key,application_key,release_ref,status,display_order,launch_policy_ref,version)
      VALUES($1,$2,$3,'hosted-store','hosted-store@1.0.0','offered',10,'{"policy_key":"hosted-store.launch","version":"1"}',1)`, [randomUUID(), DEMO_COMMUNITY, guild]);
  }
});

const consoleGet=(s:Store,path:string,session=s.owner,target=app)=>get(s,'/supplier-console'+path,session,target);
const paths=(id:string=randomUUID(),partner:string=randomUUID())=>['/overview','/products',`/products/${id}`,'/partners',`/partners/${partner}`];
const metricCounts=(overview:any)=>Object.fromEntries(Object.entries(overview.metrics).map(([key,value])=>[key,(value as any).count]));
const buckets=(row:any)=>Object.values(row.cooperation).reduce((a:any,b:any)=>a+b,0);
async function expiredCopy(source:any) {
  // Synthetic historical fixture only: immutable production timestamps cannot
  // be edited. Create a past quote/order through the real database constraints.
  const quoteId=randomUUID(),orderId=randomUUID(),clientId=randomUUID();
  await h.pool.query(`INSERT INTO commerce_order_quotes(quote_id,tenant_id,instance_id,public_shop_id,buyer_principal_id,publication_id,
    terms,bindings,terms_sha256,quoted_at,expires_at,quote_profile)
    SELECT $2::uuid,tenant_id,instance_id,public_shop_id,buyer_principal_id,publication_id,
      terms||jsonb_build_object('quote_id',$2::text,'quoted_at',to_char(statement_timestamp()-interval '2 hours','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'expires_at',to_char(statement_timestamp()-interval '115 minutes','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      bindings,terms_sha256,date_trunc('milliseconds',statement_timestamp()-interval '2 hours'),
      date_trunc('milliseconds',statement_timestamp()-interval '115 minutes'),quote_profile
    FROM commerce_order_quotes WHERE quote_id=$1`,[source.quote_id,quoteId]);
  await retainedHostedOrder(h.pool,orderId,async history => {
    await history.query(`INSERT INTO commerce_orders(order_id,public_shop_id,external_id,request_sha256,currency,total_minor,created_at,expires_at,
      order_profile,quote_id,buyer_principal_id,client_order_id,reservation_state,reservation_version)
      SELECT $2::uuid,o.public_shop_id,'historical-'||$2::text,o.request_sha256,o.currency,o.total_minor,quote.quoted_at+interval '1 minute',quote.quoted_at+interval '31 minutes',
        o.order_profile,$3::uuid,o.buyer_principal_id,$4::uuid,'reserved',1 FROM commerce_orders o JOIN commerce_order_quotes quote ON quote.quote_id=$3 WHERE o.order_id=$1`,
    [source.order_id,orderId,quoteId,clientId]);
    await history.query(`INSERT INTO commerce_order_lines(order_id,selection_id,transfer_id,item_id,quantity,snapshot,acceptance_id,listing_sha256,order_profile,supplier_shop_id,hosted_offer_id)
      SELECT $2,selection_id,transfer_id,item_id,quantity,snapshot,acceptance_id,listing_sha256,order_profile,supplier_shop_id,hosted_offer_id
      FROM commerce_order_lines WHERE order_id=$1`,[source.order_id,orderId]);
    await history.query(`UPDATE commerce_items i SET reserved=reserved+line.quantity FROM commerce_order_lines line WHERE line.order_id=$1 AND line.item_id=i.item_id`,[orderId]);
  });
  return orderId;
}


async function journey() {
  const a=await supplier(),b=await retailer('同名合作店'),c=await retailer('同名合作店');
  const item=await supplyProduct(a);
  const second=await createSupplyProduct(a,{...product,title:'未公開商品 B'});
  // The journey's third product uses stock 0; SC-API-05 separately exercises a real full reservation.
  const third=await createSupplyProduct(a,{...product,title:'缺貨商品 C',stock:0});
  const offered=await offer(a,item),accepted=await accept(a,await propose(b,offered)),pending=await propose(c,offered);
  return {a,b,c,item,second,third,offered,accepted,pending};
}
async function checkSnapshot(s:Store,path:string) {
  statements.length=0;
  const reply=await consoleGet(s,path);ok(reply);privateReply(reply);
  assert.equal(statements.length,1,'exactly one domain snapshot statement');
  assert.match(reply.data.as_of,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  return reply.data;
}

test('SC-API-01 flag OFF hides all new routes while existing supply reads are identical (AT-44 API)',async()=>{
  const s=await supplier(),item=await supplyProduct(s);
  for(const path of paths(item.product_id)) {
    const reply=await consoleGet(s,path,s.owner,closed);ok(reply,404);
    assert.match(reply.response.headers.get('content-type')??'',/application\/json/);
    assert.deepEqual(reply.data,{type:'about:blank',title:'Not found',status:404,code:'not_found',detail:'此版本尚未提供這個 API。'});
  }
  const patch=await send(s,'/supply-profile',{name:'不應保存'},'1',randomUUID(),'PATCH',s.owner,closed);ok(patch,404);
  assert.equal(patch.data.detail,'此版本尚未提供這個 API。');
  for(const path of ['/supply-profile','/supply-products']) {
    const on=await get(s,path),off=await get(s,path,s.owner,closed);ok(on);ok(off);assert.deepEqual(on.data,off.data);
  }
});

test('SC-API-02 overview requires a configured profile',async()=>{
  const s=await open('尚未設定');const reply=await consoleGet(s,'/overview');ok(reply,409);assert.equal(reply.data.code,'storefront_not_set_up');
});

test('SC-API-03 empty catalog has exact ready zeros and empty todos (AT-39)',async()=>{
  const s=await supplier(),view=await checkSnapshot(s,'/overview');
  assert.deepEqual(metricCounts(view),{offered_products:0,pending_requests:0,active_reservation_lines:0,out_of_stock_products:0});
  for(const value of Object.values(view.metrics))assert.equal((value as any).state,'ready');
  assert.deepEqual(view.todos,{state:'ready',items:[],truncated:false});assert.equal(view.product_count,0);assert.equal(view.product_limit,200);
  assert.deepEqual((await checkSnapshot(s,'/products')).items,[]);
  assert.deepEqual((await checkSnapshot(s,'/partners')).items,[]);
});

test('SC-API-04 journey counts, current terms and same-name partners agree (AT-05,12,13,15,16,30,31)',async()=>{
  const {a,b,c,item,second,third,offered,accepted,pending}=await journey();
  const saved=ok(await send(a,`/products/${item.product_id}/supply-terms`,{...terms,shipping_minor:75},item.version,randomUUID(),'PATCH'));
  const products=await checkSnapshot(a,'/products'),detail=await checkSnapshot(a,`/products/${item.product_id}`),partners=await checkSnapshot(a,'/partners');
  assert.equal(products.items.length,3);assert.deepEqual(products.items.map((r:any)=>r.product_id),[item.product_id,second.product_id,third.product_id]);
  assert.deepEqual(detail.product,products.items[0]);assert.equal(detail.current_offer.offer_id,offered.offer_id);
  assert.equal(detail.current_offer.terms.shipping_minor,50);assert.equal(detail.shipping_terms,terms.shipping_terms);
  assert.equal(detail.product.offer.matches_current_terms,false);assert.equal(detail.product.version,saved.version);
  assert.equal(detail.product.supply_price_minor,400);assert.equal(detail.product.shipping_minor,75);
  assert.equal('cost_minor' in detail.product,false);assert.equal(detail.product.currency,'TWD');
  assert.deepEqual(detail.product.cooperation,{awaiting:1,sellable:1,changes_requested:0,inactive:0});
  assert.deepEqual(detail.selections.map((r:any)=>r.selection_id),[pending.selection_id,accepted.selection_id]);
  const old=ok(await get(a,'/supply-requests')).items;
  assert.deepEqual(detail.selections.map(({partner_id,...r}:any)=>r),[old.find((r:any)=>r.selection_id===pending.selection_id),old.find((r:any)=>r.selection_id===accepted.selection_id)]);
  // Same-name sellers keep their own shop IDs, matching the partners read.
  assert.deepEqual(detail.selections.map((r:any)=>r.partner_id),[(await profileRow(c)).storefront_shop_id,(await profileRow(b)).storefront_shop_id]);
  assert.equal(partners.items.length,2);assert.equal(new Set(partners.items.map((r:any)=>r.partner_id)).size,2);
  assert.deepEqual(partners.items.map((r:any)=>r.name),['同名合作店','同名合作店']);
  assert.equal(partners.items[0].cooperation.awaiting,1);
  for(const row of partners.items) {
    const partner=await checkSnapshot(a,`/partners/${row.partner_id}`);
    assert.deepEqual(partner.partner,row);assert.equal(row.products,1);assert.equal(buckets(row),partner.selections.length);assert.equal(partner.truncated,false);
  }
  const overview=await checkSnapshot(a,'/overview');
  assert.deepEqual(metricCounts(overview),{offered_products:products.items.filter((r:any)=>r.offer).length,
    pending_requests:products.items.reduce((n:number,r:any)=>n+r.cooperation.awaiting,0),active_reservation_lines:0,
    out_of_stock_products:products.items.filter((r:any)=>r.available===0).length});
  assert.equal(overview.product_count,products.items.length);
  assert.deepEqual(overview.todos.items.map((r:any)=>r.kind),['request_pending','offer_outdated','out_of_stock','not_offered','not_offered']);
  assert.deepEqual(overview.todos.items[0],{kind:'request_pending',selection_id:pending.selection_id,product_id:item.product_id,title:item.title,
    partner_id:(await profileRow(c)).storefront_shop_id,partner_name:'同名合作店'});
  for(const row of products.items)assert.equal(row.available,row.stock-row.reserved);
  assert.equal(buckets(detail.product),detail.selections.length);
  assert.equal(overview.todos.truncated,false);assert.equal(detail.truncated,false);assert.equal(partners.truncated,false);
  // Capture an actual overview plan on journey data, with tenant/principal RLS context from these synthetic rows.
  const snapshot=statements[0],principal=(await h.pool.query('SELECT principal_id FROM principals WHERE user_ref=$1',[a.owner.user.user_id])).rows[0].principal_id;
  const q=await runtime.connect();
  try {
    await q.query('BEGIN');
    await q.query("SELECT set_config('freedom.tenant_id',$1,true),set_config('freedom.principal_id',$2,true)",[a.tenantId,principal]);
    const plan=await q.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) '+snapshot.text,snapshot.values);
    await mkdir('test-results',{recursive:true});
    await writeFile('test-results/supplier-console-overview-explain.txt',plan.rows.map(r=>r['QUERY PLAN']).join('\n')+'\n');
    await q.query('ROLLBACK');
  } finally {q.release();}
  const next=await offer(a,{...item,version:saved.version});assert.notEqual(next.offer_id,offered.offer_id);
  assert.deepEqual(await offer(a,{...item,version:saved.version}),next);
  assert.equal(await h.count('commerce_hosted_supply_offers',"WHERE item_id=$1 AND state='offered'",[item.product_id]),1);
  const after=await checkSnapshot(a,`/products/${item.product_id}`);
  assert.equal(after.product.offer.matches_current_terms,true);assert.deepEqual(after.product.cooperation,{awaiting:0,sellable:0,changes_requested:0,inactive:2});
  assert.equal(after.selections.length,2);assert.equal(after.selections.every((r:any)=>r.offer.state==='withdrawn'),true);
  const refreshed=await checkSnapshot(a,'/overview');assert.equal(refreshed.metrics.pending_requests.count,0);
  assert.equal(refreshed.todos.items.some((r:any)=>r.kind==='offer_outdated'),false);
  // Seller's other selections and another supplier's offers never enter these projections.
  const other=await supplier('別家供應商'),foreign=await supplyProduct(other),foreignOffer=await offer(other,foreign);
  await propose(b,foreignOffer);
  assert.deepEqual((await consoleGet(a,'/partners')).data.items.map((r:any)=>[r.partner_id,r.cooperation.inactive]).sort(),partners.items.map((r:any)=>[r.partner_id,1]).sort());
});

test('SC-API-05 reservations are owner-only, unexpired supplier lines and reads never settle orders (AT-22)',async()=>{
  const a=await supplier(),b=await retailer(),item=await supplyProduct(a),offered=await offer(a,item);
  const selected=await accept(a,await propose(b,offered));await publish(b);await admit(a);await admit(b);
  const buyer=(await h.person('預留買家')).session,view=ok(await get(b,''));
  const quote=ok(await command(`/hosted-stores/${view.store.slug}/reservation-quotes`,buyer,
    {publication_revision:view.publication.current_revision,items:[{sku:selected.sku,quantity:10}]}),201);
  const order=ok(await command(`/hosted-stores/${view.store.slug}/reservation-orders`,buyer,
    {quote_id:quote.quote_id,terms_sha256:quote.terms_sha256,client_order_id:randomUUID()}),201);
  const before=(await h.pool.query('SELECT * FROM commerce_orders ORDER BY order_id')).rows;
  const overview=await checkSnapshot(a,'/overview');assert.equal(overview.metrics.active_reservation_lines.count,1);
  const other=await supplier('無關供應商');assert.equal(ok(await consoleGet(other,'/overview')).metrics.active_reservation_lines.count,0);
  assert.equal(overview.metrics.out_of_stock_products.count,1);
  const product=ok(await consoleGet(a,'/products')).items[0];assert.deepEqual([product.stock,product.reserved,product.available],[10,10,0]);
  assert.equal(ok(await get(a,'/supply-reservations')).items[0].items.length,1);
  assert.deepEqual((await h.pool.query('SELECT * FROM commerce_orders ORDER BY order_id')).rows,before);
  const admin=(await h.person('管理員')).session;await invite(a,admin,[],'admin');
  statements.length=0;const asAdmin=ok(await consoleGet(a,'/overview',admin));
  assert.deepEqual(asAdmin.metrics.active_reservation_lines,{state:'unavailable',reason:'owner_required'});
  assert.equal(statements.length,1);assert.doesNotMatch(statements[0].text,/commerce_order/);
  // Immutable deadlines stay enforced: cancel the live hold and insert retained expired history with real guards.
  ok(await command(`/me/reservations/${order.order_id}/cancel`,buyer,{},order.version));
  const expiredId=await expiredCopy({order_id:order.order_id,quote_id:quote.quote_id});
  const expiredBefore=(await h.pool.query('SELECT * FROM commerce_orders ORDER BY order_id')).rows;
  const expired=await checkSnapshot(a,'/overview');assert.equal(expired.metrics.active_reservation_lines.count,0);
  assert.ok(expiredBefore.find(r=>r.order_id===expiredId).expires_at<=new Date(expired.as_of));
  assert.deepEqual((await h.pool.query('SELECT * FROM commerce_orders ORDER BY order_id')).rows,expiredBefore);
  assert.equal(expiredBefore.find(r=>r.order_id===expiredId).reservation_state,'reserved');
  assert.equal((await ownRow(a,item.product_id)).reserved,10);
});

test('SC-API-06 read capabilities, tenant/session isolation and private headers (AT-04,37)',async()=>{
  const s=await supplier(),item=await supplyProduct(s),reader=(await h.person('只讀')).session;
  const principal=await invite(s,reader,['store:read']),other=await supplier('另一事業'),outsider=(await h.person('非成員')).session;
  statements.length=0;
  const reply=await consoleGet(s,'/overview',reader);const view=ok(reply);privateReply(reply);
  for(const value of Object.values(view.metrics))assert.deepEqual(value,{state:'unavailable',reason:'store_write_required'});
  assert.deepEqual(view.todos,{state:'unavailable',reason:'store_write_required'});assert.equal(view.product_count,1);
  assert.equal(statements.length,1);assert.doesNotMatch(statements[0].text,/commerce_items|commerce_orders|commerce_order_lines|commerce_hosted_supply_offers|price|terms/);
  for(const path of paths(item.product_id)) {
    if(path!=='/overview')ok(await consoleGet(s,path,reader),403);
    for(const person of [other.owner,outsider]) {
      const rejected=await consoleGet(s,path,person);assert.ok([403,404].includes(rejected.status));assert.equal('items' in rejected.data,false);
    }
    ok(await h.call('GET',s.root+'/supplier-console'+path,undefined,undefined,{},app),401);
  }
  for(const person of [other.owner,outsider])assert.ok([403,404].includes((await send(s,'/supply-profile',{name:'越權'},'1',randomUUID(),'PATCH',person)).status));
  ok(await h.call('PATCH',s.root+'/supply-profile',undefined,{name:'越權'},{'Idempotency-Key':randomUUID(),'If-Match':'"1"'},app),401);
  for(const query of ['unknown=1','x=1&x=2'])ok(await consoleGet(s,'/overview?'+query),422);
  await h.pool.query("UPDATE tenant_module_permissions SET status='revoked',revoked_at=clock_timestamp(),version=version+1 WHERE tenant_id=$1 AND principal_id=$2",[s.tenantId,principal]);
  ok(await consoleGet(s,'/overview',reader),404);
});

test('SC-API-07 details conceal foreign products and unrelated real shops',async()=>{
  const a=await supplier(),other=await supplier('別家'),foreign=await supplyProduct(other),seller=await retailer('無關商店');
  const missing=await consoleGet(a,`/products/${foreign.product_id}`);ok(missing,404);assert.equal(missing.data.detail,'找不到這項商品。');
  const random=await consoleGet(a,`/partners/${randomUUID()}`),real=await consoleGet(a,`/partners/${(await profileRow(seller)).storefront_shop_id}`);
  ok(random,404);ok(real,404);assert.deepEqual(real.data,random.data);
});

test('SC-API-08 supply profile update has CAS, exact receipts, manage permission and frozen offer names',async()=>{
  const s=await supplier(),item=await supplyProduct(s),offered=await offer(s,item),initial=ok(await get(s,'/supply-profile'));
  const key=randomUUID(),body={name:'新的供貨名稱',description:'新的介紹'};
  const reply=await send(s,'/supply-profile',body,initial.version,key,'PATCH'),receipt=ok(reply);privateReply(reply);
  assert.deepEqual(receipt,{instance_id:s.instanceId,version:String(BigInt(initial.version)+1n)});assert.equal(reply.response.headers.get('etag'),`"${receipt.version}"`);
  await storedReceipt(key,receipt);assert.deepEqual(ok(await send(s,'/supply-profile',body,initial.version,key,'PATCH')),receipt);
  const conflict=await send(s,'/supply-profile',{name:'其他'},initial.version,key,'PATCH');ok(conflict,409);assert.equal(conflict.data.code,'idempotency_conflict');
  ok(await send(s,'/supply-profile',body,undefined,randomUUID(),'PATCH'),428);
  ok(await send(s,'/supply-profile',body,initial.version,randomUUID(),'PATCH'),412);
  const shops=(await h.pool.query('SELECT name,description,currency FROM commerce_shops WHERE shop_id=ANY($1::uuid[])',
    [[(await profileRow(s)).supply_shop_id,(await profileRow(s)).storefront_shop_id]])).rows;
  assert.deepEqual(shops,[{...body,currency:'TWD'},{...body,currency:'TWD'}]);
  const detail=ok(await consoleGet(s,`/products/${item.product_id}`));assert.equal(detail.current_offer.supplier_name,offered.supplier_name);
  assert.equal(detail.product.offer.matches_current_terms,true);
  const editor=(await h.person('不可管理')).session;const principal=await invite(s,editor,['store:read','store:write']);
  ok(await send(s,'/supply-profile',{name:'不准改'},receipt.version,randomUUID(),'PATCH',editor),403);
  for(const invalid of [{},{currency:'USD'}]) {
    const rejected=await send(s,'/supply-profile',invalid,receipt.version,randomUUID(),'PATCH');ok(rejected,422);assert.equal(rejected.data.code,'validation_failed');
  }
  const retail=await retailer('原零售名稱'),retailProfile=await profileRow(retail);
  const rejected=await send(retail,'/supply-profile',{name:'不應覆寫'},retailProfile.version.toString(),randomUUID(),'PATCH');ok(rejected,409);assert.equal(rejected.data.code,'retail_profile_settings');
  assert.equal(ok(await get(retail,'/supply-profile')).catalog.name,'原零售名稱');
  assert.equal(await h.count('scoped_transition_journal',"WHERE aggregate_id=$1 AND operation='storefront.supply-profile.update'",[s.instanceId]),1);
  // Exact-key replay must still require the caller's current manage capability.
  await h.pool.query("UPDATE tenant_module_permissions SET capabilities=ARRAY['store:read','store:write','store:manage'] WHERE principal_id=$1 AND tenant_id=$2",[principal,s.tenantId]);
  const editorKey=randomUUID();ok(await send(s,'/supply-profile',{description:'由管理者保存'},receipt.version,editorKey,'PATCH',editor));
  await h.pool.query("UPDATE tenant_module_permissions SET capabilities=ARRAY['store:read'] WHERE principal_id=$1 AND tenant_id=$2",[principal,s.tenantId]);
  ok(await send(s,'/supply-profile',{description:'由管理者保存'},receipt.version,editorKey,'PATCH',editor),403);
});

test('SC-API-09 complete SKU-ordered products, bounded todos, partners and detail selections',async()=>{
  const a=await supplier(),b=await retailer('原合作店'),item=await supplyProduct(a),offered=await offer(a,item),selected=await propose(b,offered);
  for(let index=0;index<199;index++)await createSupplyProduct(a,{...product,title:`合成商品 ${index}`});
  const catalog=ok(await consoleGet(a,'/products'));
  assert.equal(catalog.items.length,200);assert.deepEqual(catalog.items.map((r:any)=>r.sku),Array.from({length:200},(_,n)=>`P${String(n+1).padStart(4,'0')}`));
  assert.deepEqual(catalog.items.map((r:any)=>r.product_id),ok(await get(a,'/supply-products')).items.map((r:any)=>r.product_id));
  const source=(await h.pool.query('SELECT snapshot FROM commerce_selections WHERE selection_id=$1',[selected.selection_id])).rows[0].snapshot;
  // Synthetic archived seller profiles/selections avoid 201 tenant launch HTTP flows.
  // They retain real FKs/triggers; all inserts use only this test's admin pool/schema.
  const fixtures=Array.from({length:201},(_,index)=>{
    const seller_id=randomUUID(),snapshot={...source,seller_shop_id:seller_id};
    return {instance_id:randomUUID(),binding_id:randomUUID(),supply_id:randomUUID(),seller_id,selection_id:randomUUID(),
      name:`合成店 ${String(index).padStart(3,'0')}`,snapshot,hash:digest(snapshot)};
  });
  const data=JSON.stringify(fixtures),shape=`jsonb_to_recordset($1) AS f(instance_id uuid,binding_id uuid,supply_id uuid,seller_id uuid,selection_id uuid,name text,snapshot jsonb,hash text)`;
  const q=await h.pool.connect();
  try {
    await q.query('BEGIN');
    await q.query(`INSERT INTO module_instances(instance_id,tenant_id,module_key,application_release_ref,data_schema_version,contract_ref,status,binding_id,
      created_by_principal_id,origin_guild_key,module_release_ref)
      SELECT f.instance_id,i.tenant_id,i.module_key,i.application_release_ref,i.data_schema_version,i.contract_ref,'archived',f.binding_id,
        i.created_by_principal_id,i.origin_guild_key,i.module_release_ref FROM ${shape} CROSS JOIN module_instances i WHERE i.instance_id=$2`,[data,b.instanceId]);
    await q.query(`INSERT INTO deployment_bindings(binding_id,tenant_id,instance_id,mode,environment,contract_ref,state)
      SELECT f.binding_id,d.tenant_id,f.instance_id,'hosted',d.environment,d.contract_ref,'retired'
      FROM ${shape} CROSS JOIN deployment_bindings d WHERE d.instance_id=$2`,[data,b.instanceId]);
    await q.query(`INSERT INTO commerce_shops(shop_id,community_id,owner_id,kind,origin,mode,accepting_orders,name,description,website_url,contact,currency,manifest_sha256)
      SELECT ids.id,s.community_id,s.owner_id,ids.kind,'hosted','test',false,f.name,'合成測試','','',s.currency,
        replace(ids.id::text,'-','')||replace(ids.id::text,'-','') FROM ${shape}
      CROSS JOIN LATERAL (VALUES(f.supply_id,'internal'),(f.seller_id,'public')) ids(id,kind)
      CROSS JOIN commerce_shops s WHERE s.shop_id=$2`,[data,(await profileRow(b)).storefront_shop_id]);
    await q.query(`INSERT INTO commerce_storefront_profiles(instance_id,tenant_id,supply_shop_id,storefront_shop_id,created_by_principal_id)
      SELECT f.instance_id,p.tenant_id,f.supply_id,f.seller_id,p.created_by_principal_id FROM ${shape}
      CROSS JOIN commerce_storefront_profiles p WHERE p.instance_id=$2`,[data,b.instanceId]);
    await q.query(`INSERT INTO commerce_selections(selection_id,shop_id,item_id,retail_price_minor,sale_terms,snapshot,listing_sha256,hosted_offer_id,hosted_sku)
      SELECT f.selection_id,f.seller_id,l.item_id,l.retail_price_minor,l.sale_terms,f.snapshot,f.hash,l.hosted_offer_id,l.hosted_sku
      FROM ${shape} CROSS JOIN commerce_selections l WHERE l.selection_id=$2`,[data,selected.selection_id]);
    await q.query('COMMIT');
  }catch(error){await q.query('ROLLBACK');throw error;}finally{q.release();}
  const partners=await checkSnapshot(a,'/partners');assert.equal(partners.items.length,200);assert.equal(partners.truncated,true);
  assert.equal(new Set(partners.items.map((r:any)=>r.partner_id)).size,200);
  assert.equal(partners.items.every((r:any)=>r.cooperation.awaiting===1&&r.products===1),true);
  const expected=(await h.pool.query(`SELECT l.shop_id,s.name FROM commerce_selections l JOIN commerce_shops s ON s.shop_id=l.shop_id
    WHERE l.hosted_offer_id=$1 ORDER BY s.name,l.shop_id LIMIT 200`,[offered.offer_id])).rows;
  assert.deepEqual(partners.items.map((r:any)=>r.partner_id),expected.map(r=>r.shop_id));
  const detail=await checkSnapshot(a,`/products/${item.product_id}`);assert.equal(detail.selections.length,200);assert.equal(detail.truncated,true);
  assert.equal(detail.product.cooperation.awaiting,202);
  assert.deepEqual(detail.selections.map((r:any)=>r.selection_id),[selected.selection_id,...fixtures.map(f=>f.selection_id)].sort().slice(0,200));
  const overview=await checkSnapshot(a,'/overview');assert.equal(overview.metrics.pending_requests.count,202);
  assert.equal(overview.product_count,200);assert.equal(overview.todos.items.length,20);assert.equal(overview.todos.truncated,true);
  assert.equal(overview.todos.items.every((r:any)=>r.kind==='request_pending'),true);
  // Deliberately exceed the invariant using admin SQL: the complete-list reader must fail, never truncate silently.
  const p=await profileRow(a),extraId=randomUUID();
  await h.pool.query(`INSERT INTO commerce_items(item_id,shop_id,sku,title,description,price_minor,shipping_minor,stock,shipping_terms,return_terms)
    VALUES($1,$2,'P0201','超量商品','合成測試',400,0,1,'未設定','未設定')`,[extraId,p.supply_shop_id]);
  await h.pool.query(`INSERT INTO commerce_selections(selection_id,shop_id,item_id,retail_price_minor,sale_terms,snapshot,listing_sha256)
    VALUES($1,$2,$3,400,'未設定','{}',$4)`,[randomUUID(),p.storefront_shop_id,extraId,'0'.repeat(64)]);
  const invalid=await consoleGet(a,'/products');ok(invalid,500);assert.equal(invalid.data.code,'supplier_product_limit');
});

test('SC-API-10 every cooperation state buckets once; retail capacity includes adopted products (AT-14,30)',async()=>{
  const a=await supplier(),item=await supplyProduct(a),offered=await offer(a,item);
  const sellers:Store[]=[],selected:any[]=[];
  for(const name of ['待確認','可售','需修改','不同意','撤回']) {
    const s=await retailer(name);sellers.push(s);selected.push(await propose(s,offered));
  }
  selected[1]=await accept(a,selected[1]);
  // changes_requested is retained legacy selection state; seed it through the real selection guards.
  await h.pool.query("UPDATE commerce_selections SET acceptance_state='changes_requested',aggregate_version=aggregate_version+1 WHERE selection_id=$1",[selected[2].selection_id]);
  ok(await send(a,`/supply-requests/${selected[3].selection_id}/decision`,{decision:'declined',listing_sha256:selected[3].listing_sha256},selected[3].version));
  selected[4]=await accept(a,selected[4]);
  ok(await send(a,`/supply-requests/${selected[4].selection_id}/decision`,{decision:'revoked',listing_sha256:selected[4].listing_sha256},selected[4].version));
  const detail=await checkSnapshot(a,`/products/${item.product_id}`);
  assert.deepEqual(detail.product.cooperation,{awaiting:1,sellable:1,changes_requested:1,inactive:2});
  assert.equal(buckets(detail.product),5);
  assert.deepEqual(detail.selections.map((r:any)=>r.state),['awaiting_supply_acceptance','sellable','changes_requested',
    ...detail.selections.slice(3).map((r:any)=>r.state)]);
  assert.deepEqual(detail.selections.slice(3).map((r:any)=>r.selection_id),[selected[3].selection_id,selected[4].selection_id].sort());
  const partners=ok(await consoleGet(a,'/partners'));
  assert.deepEqual(partners.items.reduce((counts:any,p:any)=>Object.fromEntries(Object.keys(counts).map(k=>[k,counts[k]+p.cooperation[k]])),
    {awaiting:0,sellable:0,changes_requested:0,inactive:0}),detail.product.cooperation);
  const own=await createSupplyProduct(sellers[0]);
  const products=ok(await consoleGet(sellers[0],'/products'));assert.deepEqual(products.items.map((r:any)=>r.product_id),[own.product_id]);
  assert.equal(ok(await consoleGet(sellers[0],'/overview')).product_count,2);
  const renamed=ok(await get(sellers[0],''));
  ok(await send(sellers[0],'',{name:'目前合作店名'},renamed.version,randomUUID(),'PATCH'));
  assert.equal(ok(await consoleGet(a,`/products/${item.product_id}`)).selections[0].seller_name,'目前合作店名');
  ok(await send(a,`/supply-offers/${offered.offer_id}/withdraw`,{},offered.version));
  const withdrawn=ok(await consoleGet(a,`/products/${item.product_id}`));
  assert.equal(withdrawn.current_offer,null);assert.equal(withdrawn.product.offer,null);
  assert.deepEqual(withdrawn.product.cooperation,{awaiting:0,sellable:0,changes_requested:0,inactive:5});
  const overview=ok(await consoleGet(a,'/overview'));
  assert.equal(overview.metrics.offered_products.count,0);assert.equal(overview.metrics.pending_requests.count,0);
  assert.deepEqual(overview.todos.items.map((r:any)=>r.kind),['not_offered']);
});

test('SC-API-11 request detail uses the current list projection and shared product offer projection (AT-12,15,30)',async()=>{
  const a=await supplier(),b=await retailer(),item=await supplyProduct(a),offered=await offer(a,item),selected=await propose(b,offered);
  const detail=await checkSnapshot(a,`/requests/${selected.selection_id}`),list=ok(await get(a,'/supply-requests'));
  const {partner_id,...request}=detail.request;
  assert.deepEqual(request,list.items.find((r:any)=>r.selection_id===selected.selection_id));
  assert.equal(partner_id,(await profileRow(b)).storefront_shop_id);
  assert.equal(detail.profile,'freedom.supplier-console.request/v1');
  assert.deepEqual(detail.product,{product_id:item.product_id,offer:ok(await consoleGet(a,'/products')).items[0].offer});
  assert.equal(detail.product.offer.matches_current_terms,true);
  const changed=ok(await send(a,`/products/${item.product_id}/supply-terms`,{...terms,shipping_minor:75},item.version,randomUUID(),'PATCH'));
  const outdated=await checkSnapshot(a,`/requests/${selected.selection_id}`);
  assert.deepEqual(outdated.product.offer,ok(await consoleGet(a,'/products')).items[0].offer);
  assert.equal(outdated.product.offer.matches_current_terms,false);
  const replacement=await offer(a,{...item,version:changed.version});
  const replaced=await checkSnapshot(a,`/requests/${selected.selection_id}`);
  assert.deepEqual(replaced.product.offer,ok(await consoleGet(a,'/products')).items[0].offer);
  assert.equal(replaced.product.offer.offer_id,replacement.offer_id);
  assert.equal(replaced.request.offer.state,'withdrawn');
  ok(await send(a,`/supply-offers/${replacement.offer_id}/withdraw`,{},replacement.version));
  assert.equal((await checkSnapshot(a,`/requests/${selected.selection_id}`)).product.offer,null);
});

test('SC-API-12 request detail reaches beyond the first 200 and supplies decision CAS (AT-12,30)',async()=>{
  const a=await supplier(),item=await supplyProduct(a),offered=await offer(a,item);
  const sellers=[await retailer('目標店'),await retailer('批次店 B'),await retailer('批次店 C')];
  const selected=await propose(sellers[0],offered),sources=[];
  for(const seller of sellers.slice(1))sources.push(await propose(seller,offered));
  const templates=(await h.pool.query('SELECT * FROM commerce_selections WHERE selection_id=ANY($1::uuid[])',[sources.map(s=>s.selection_id)])).rows;
  const items=Array.from({length:101},(_,n)=>({item_id:randomUUID(),offer_id:randomUUID(),own_id:randomUUID(),sku:`P${1001+n}`}));
  const selections=items.flatMap((item,n)=>templates.map((source,k)=>{
    const snapshot={...source.snapshot,item_id:item.item_id,offer_id:item.offer_id,sku:item.sku};
    return {...item,selection_id:`00000000-0000-4000-8000-${String(n*2+k+1).padStart(12,'0')}`,
      source_id:source.selection_id,snapshot,hash:digest(snapshot)};
  }));
  const data=JSON.stringify(items),shape=`jsonb_to_recordset($1) AS f(item_id uuid,offer_id uuid,own_id uuid,sku text)`;
  const q=await h.pool.connect();
  try {
    await q.query('BEGIN');
    await q.query(`INSERT INTO commerce_items(item_id,shop_id,sku,title,description,photo_url,price_minor,shipping_minor,stock,reserved,shipping_terms,return_terms)
      SELECT f.item_id,i.shop_id,f.sku,i.title,i.description,i.photo_url,i.price_minor,i.shipping_minor,i.stock,0,i.shipping_terms,i.return_terms
      FROM ${shape} CROSS JOIN commerce_items i WHERE i.item_id=$2`,[data,item.product_id]);
    await q.query(`INSERT INTO commerce_hosted_supply_offers(offer_id,tenant_id,instance_id,item_id,community_id,supplier_name,source_version,terms,terms_sha256,state,version)
      SELECT f.offer_id,o.tenant_id,o.instance_id,f.item_id,o.community_id,o.supplier_name,o.source_version,o.terms,o.terms_sha256,'withdrawn',o.version
      FROM ${shape} CROSS JOIN commerce_hosted_supply_offers o WHERE o.offer_id=$2`,[data,offered.offer_id]);
    await q.query(`INSERT INTO commerce_selections(selection_id,shop_id,item_id,retail_price_minor,sale_terms,snapshot,listing_sha256,own_retail_enabled)
      SELECT f.own_id,l.shop_id,f.item_id,l.retail_price_minor,l.sale_terms,l.snapshot,l.listing_sha256,l.own_retail_enabled
      FROM ${shape} CROSS JOIN commerce_selections l JOIN commerce_storefront_profiles p ON p.storefront_shop_id=l.shop_id
      WHERE l.item_id=$2 AND p.instance_id=$3`,[data,item.product_id,a.instanceId]);
    await q.query(`INSERT INTO commerce_selections(selection_id,shop_id,item_id,retail_price_minor,sale_terms,snapshot,listing_sha256,hosted_offer_id,hosted_sku,acceptance_state,current_acceptance_id)
      SELECT f.selection_id,l.shop_id,f.item_id,l.retail_price_minor,l.sale_terms,f.snapshot,f.hash,f.offer_id,f.sku,'awaiting_supply_acceptance',NULL
      FROM jsonb_to_recordset($1) AS f(selection_id uuid,source_id uuid,item_id uuid,offer_id uuid,sku text,snapshot jsonb,hash text)
      JOIN commerce_selections l ON l.selection_id=f.source_id`,[JSON.stringify(selections)]);
    await q.query('COMMIT');
  }catch(error){await q.query('ROLLBACK');throw error;}finally{q.release();}
  const list=ok(await get(a,'/supply-requests'));
  assert.equal(list.items.length,200);assert.equal(list.truncated,true);
  assert.equal(list.items.some((s:any)=>s.selection_id===selected.selection_id),false);
  assert.equal(ok(await consoleGet(a,'/products')).items.length,102);
  const detail=await checkSnapshot(a,`/requests/${selected.selection_id}`);
  assert.deepEqual(detail.request,{...selected,partner_id:(await profileRow(sellers[0])).storefront_shop_id});
  assert.equal((await accept(a,detail.request)).state,'sellable');
  const stale=await send(a,`/supply-requests/${selected.selection_id}/decision`,{decision:'accepted',listing_sha256:detail.request.listing_sha256},detail.request.version);
  ok(stale,412);
  assert.equal((await checkSnapshot(a,`/requests/${selected.selection_id}`)).request.state,'sellable');
});

test('SC-API-13 request detail enforces the partners capability and conceals foreign or missing IDs (AT-04,37)',async()=>{
  const a=await supplier(),b=await retailer(),item=await supplyProduct(a),offered=await offer(a,item),selected=await propose(b,offered);
  const reader=(await h.person('只讀成員')).session;await invite(a,reader,['store:read']);
  const refused=await consoleGet(a,`/requests/${selected.selection_id}`,reader),partners=await consoleGet(a,'/partners',reader);
  ok(refused,403);assert.deepEqual(refused.data,partners.data);privateReply(refused);
  const leader=(await h.person('只有公會職稱')).session;await h.fullMember(leader.user.user_id,supplierGuild);
  await h.pool.query(`INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) VALUES($1,$2,$3)
    ON CONFLICT(community_id,guild_key) DO UPDATE SET user_id=$3`,[DEMO_COMMUNITY,supplierGuild,leader.user.user_id]);
  const titleOnly=await consoleGet(a,`/requests/${selected.selection_id}`,leader);
  assert.equal(titleOnly.status,(await consoleGet(a,'/partners',leader)).status);assert.equal(titleOnly.status,404);
  const other=await supplier('另一供應方'),foreign=await propose(b,await offer(other,await supplyProduct(other)));
  for(const id of [foreign.selection_id,randomUUID()]) {
    const missing=await consoleGet(a,`/requests/${id}`);ok(missing,404);assert.equal(missing.data.code,'not_found');
    assert.equal(missing.data.detail,'找不到這筆申請。');privateReply(missing);
  }
  ok(await consoleGet(other,`/requests/${selected.selection_id}`),404);
  const unconfigured=await open('未設定供貨庫');ok(await consoleGet(unconfigured,`/requests/${selected.selection_id}`),409);
  ok(await consoleGet(a,`/requests/${selected.selection_id}`,a.owner,closed),404);
  ok(await h.call('GET',a.root+`/supplier-console/requests/${selected.selection_id}`,undefined,undefined,{},app),401);
  ok(await consoleGet(a,'/requests/not-an-id'),422);
  for(const query of ['unknown=1','x=1&x=2'])ok(await consoleGet(a,`/requests/${selected.selection_id}?${query}`),422);
});

test('SC-API-14 request detail rereads the seller new version and listing digest (AT-13)',async()=>{
  const a=await supplier(),b=await retailer(),item=await supplyProduct(a),offered=await offer(a,item),selected=await propose(b,offered);
  const initial=await checkSnapshot(a,`/requests/${selected.selection_id}`);
  const accepted=await accept(a,initial.request);
  const reproposed=ok(await send(b,`/distribution-selections/${selected.selection_id}`,
    {offer_id:offered.offer_id,terms_sha256:offered.terms_sha256,retail_price_minor:1500},accepted.version,randomUUID(),'PATCH'));
  const current=await checkSnapshot(a,`/requests/${selected.selection_id}`);
  assert.equal(current.request.version,reproposed.version);assert.equal(current.request.listing_sha256,reproposed.listing_sha256);
  assert.notEqual(current.request.version,initial.request.version);assert.notEqual(current.request.listing_sha256,initial.request.listing_sha256);
  assert.equal(current.request.state,'awaiting_supply_acceptance');assert.equal(current.request.retail_price_minor,1500);
  const {partner_id,...request}=current.request;assert.deepEqual(request,ok(await get(a,'/supply-requests')).items[0]);
});

});
