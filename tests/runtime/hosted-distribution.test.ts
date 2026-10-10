import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {before, after, beforeEach, test} from 'node:test';
import {Pool} from 'pg';
import {createApp} from '../../apps/platform-api/src/app.js';
import {authenticate} from '../../modules/identity-membership/service.js';
import {createDirectQuote} from '../../modules/agent-commerce/hosted/direct-quotes.js';
import {listProductMedia} from '../../modules/agent-commerce/hosted/photo-read.js';
import {removeProductPhoto} from '../../modules/agent-commerce/hosted/photo-commands.js';
import {DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {createRegistryHarness, type RegistryHarness, type Session, type Reply} from './module-registry-harness.js';

let h: RegistryHarness, runtime: Pool, app: ReturnType<typeof createApp>;
const role = `hd_runtime_${process.pid}_${Date.now()}`, guild = 'guild_commerce_sales';
type Store = {owner: Session; tenantId: string; instanceId: string; root: string};
const ok = (r: Reply, status=200) => {assert.equal(r.status,status,JSON.stringify(r.data)); return r.data;};
const get = (s: Store, path: string, session=s.owner) => h.call('GET',s.root+path,session,undefined,{},app);
const send = (s: Store,path: string,body: unknown={},version?: string,key=randomUUID(),method='POST',session=s.owner) =>
  h.call(method,s.root+path,session,body,{'Idempotency-Key':key,...(version?{'If-Match':`"${version}"`}:{})},app);
async function store(name: string): Promise<Store> {
  const owner = (await h.person(name)).session; await h.fullMember(owner.user.user_id,guild);
  const {tenantId,workspaceId} = await h.createTenant(owner,name);
  const plan = await h.plan(owner,tenantId,h.planBody(guild,workspaceId,'hosted-store','hosted-store@1.0.0')); ok(plan,201);
  assert.equal((await h.launch(owner,tenantId,plan)).data.state,'succeeded');
  const instanceId = (await h.pool.query("SELECT instance_id FROM module_instances WHERE tenant_id=$1 AND module_key='storefront'",[tenantId])).rows[0].instance_id;
  const s = {owner,tenantId,instanceId,root:`/tenants/${tenantId}/storefronts/${instanceId}`};
  ok(await send(s,'/setup',{name,slug:`s-${randomUUID().slice(0,12)}`,currency:'TWD'}),201); return s;
}
async function product(s: Store) {
  const item = ok(await send(s,'/products',{title:'供貨茶杯',description:'供貨方授權的介紹',price_minor:1000,stock:10}),201);
  const terms = ok(await send(s,`/products/${item.product_id}/supply-terms`,{cost_minor:400,shipping_minor:50,shipping_terms:'確認後三天出貨',return_terms:'瑕疵請聯絡供貨方'},item.version,randomUUID(),'PATCH'));
  return {...item,version:terms.version};
}
const offer = async (s: Store,p: any) => ok(await send(s,`/products/${p.product_id}/supply-offer`,{},p.version));
const propose = async (s: Store,o: any,price: number) => ok(await send(s,'/distribution-selections',{offer_id:o.offer_id,terms_sha256:o.terms_sha256,retail_price_minor:price}),201);
const decide = async (s: Store,l: any,decision='accepted') => ok(await send(s,`/supply-requests/${l.selection_id}/decision`,{decision,listing_sha256:l.listing_sha256},l.version));
const publish = async (s: Store) => ok(await send(s,'/publish',{},ok(await get(s,'')).version));
before(async () => {
  assert.match(process.env.TEST_DATABASE_URL??'', /\/fp_[a-z0-9_]+$/);
  h = await createRegistryHarness('fp_distribution');
  await h.admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    GRANT USAGE ON SCHEMA ${h.schema} TO ${role}; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${h.schema} TO ${role};
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${h.schema} TO ${role}; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${h.schema} TO ${role}`);
  const url = new URL(process.env.TEST_DATABASE_URL!); url.username=role; url.password='';
  runtime = new Pool({connectionString:url.toString(),options:`-c search_path=${h.schema} -c statement_timeout=15000`,max:6});
  app = createApp(runtime,h.origin,'local',{guildLaunchpadEnabled:true});
});
after(async () => {
  await runtime?.end();
  if(h) {await h.stop(); const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL}); try{await admin.query(`DROP ROLE ${role}`);}finally{await admin.end();}}
});
beforeEach(async () => {
  await h.reset();
  await h.pool.query(`INSERT INTO guild_application_offerings(offering_id,community_id,guild_key,application_key,release_ref,status,display_order,launch_policy_ref,version)
    VALUES($1,$2,$3,'hosted-store','hosted-store@1.0.0','offered',10,'{"policy_key":"hosted-store.launch","version":"1"}',1)`,[randomUUID(),DEMO_COMMUNITY,guild]);
});

test('A explicitly offers one item; independent B/C prices require exact consent and publish without copying stock or private terms',async () => {
  const a=await store('供貨 A'), b=await store('零售 B'), c=await store('零售 C'), p=await product(a);
  assert.deepEqual(ok(await get(b,'/supply-catalog')).items,[]);
  const o=await offer(a,p), lb=await propose(b,o,1100), lc=await propose(c,o,1300);
  assert.deepEqual(ok(await get(b,'/preview')).projection.products,[]);
  ok(await send(b,`/supply-requests/${lb.selection_id}/decision`,{decision:'accepted',listing_sha256:lb.listing_sha256},lb.version),404);
  ok(await send(a,`/supply-requests/${lb.selection_id}/decision`,{decision:'accepted',listing_sha256:'0'.repeat(64)},lb.version),409);
  await decide(a,lb); await decide(a,lc);
  await publish(b); await publish(c);
  for(const [s,price] of [[b,1100],[c,1300]] as const) {
    const view=ok(await get(s,''));
    const publicResponse=await app.request(h.origin+`/api/v1/public/stores/${view.store.slug}`);
    const dto=await publicResponse.json() as any;
    assert.equal(publicResponse.status,200,JSON.stringify(dto));
    assert.deepEqual(dto.products,[{sku:'P0001',title:p.title,description:p.description,price_minor:price}]);
    assert.ok(!JSON.stringify(dto).includes('cost_minor')); assert.ok(!JSON.stringify(dto).includes('return_terms'));
    ok(await get(a,`/products/${p.product_id}/supply-terms`,s.owner),404);
    const actor=await authenticate(runtime,s.owner.cookie.split('=')[1].split(';')[0]);
    assert.deepEqual((await listProductMedia(runtime,actor,s.tenantId,s.instanceId)).items,[]);
    await assert.rejects(removeProductPhoto(runtime,actor,s.tenantId,s.instanceId,p.product_id,randomUUID(),'2'),
      (e:unknown)=>(e as {status?:number}).status===404);
  }
  assert.equal(await h.count('commerce_items'),1);
  const item=(await h.pool.query('SELECT stock,reserved,price_minor FROM commerce_items WHERE item_id=$1',[p.product_id])).rows[0];
  assert.deepEqual(item,{stock:10,reserved:0,price_minor:'400'});
  assert.equal(await h.count('commerce_distribution_acceptances'),2);
  assert.equal(await h.count('commerce_orders'),0);
});

test('retail revision clears consent; supplier withdrawal blocks new publication without rewriting old public snapshots or acceptances',async () => {
  const a=await store('供貨 A'),b=await store('零售 B'),p=await product(a),o=await offer(a,p);
  const initial=await propose(b,o,1200), accepted=await decide(a,initial); await publish(b);
  const oldPublication=(await h.pool.query('SELECT projection FROM commerce_storefront_publications WHERE instance_id=$1',[b.instanceId])).rows[0].projection;
  const revised=ok(await send(b,`/distribution-selections/${initial.selection_id}`,{offer_id:o.offer_id,terms_sha256:o.terms_sha256,retail_price_minor:1500},accepted.version,randomUUID(),'PATCH'));
  assert.equal(revised.state,'awaiting_supply_acceptance');
  assert.deepEqual(ok(await get(b,'/preview')).projection.products,[]);
  ok(await send(a,`/supply-requests/${initial.selection_id}/decision`,{decision:'accepted',listing_sha256:initial.listing_sha256},initial.version),412);
  await decide(a,revised);
  const key=randomUUID(); const withdrawn=ok(await send(a,`/supply-offers/${o.offer_id}/withdraw`,{},o.version,key));
  assert.deepEqual(ok(await send(a,`/supply-offers/${o.offer_id}/withdraw`,{},o.version,key)),withdrawn);
  assert.deepEqual(ok(await get(b,'/supply-catalog')).items,[]);
  assert.deepEqual(ok(await get(b,'/preview')).projection.products,[]);
  ok(await send(b,'/publish',{},ok(await get(b,'')).version),409);
  assert.deepEqual((await h.pool.query('SELECT projection FROM commerce_storefront_publications WHERE instance_id=$1',[b.instanceId])).rows[0].projection,oldPublication);
  assert.equal(await h.count('commerce_distribution_acceptances'),2);
});

test('private edits preserve offered terms; publishing a replacement retires only that prior offer',async () => {
  const a=await store('供貨 A'),b=await store('零售 B'),p=await product(a),o=await offer(a,p);
  await decide(a,await propose(b,o,1200));
  const changed=ok(await send(a,`/products/${p.product_id}/supply-terms`,{cost_minor:700,shipping_minor:80,shipping_terms:'五天出貨',return_terms:'保留原退貨條件'},p.version,randomUUID(),'PATCH'));
  assert.equal(ok(await get(b,'/supply-catalog')).items[0].terms.cost_minor,400);
  const replacement=await offer(a,{...p,version:changed.version});
  assert.notEqual(replacement.offer_id,o.offer_id); assert.equal(replacement.terms.cost_minor,700);
  assert.equal(ok(await get(b,'/distribution-selections')).items[0].offer.state,'withdrawn');
  await assert.rejects(h.pool.query("UPDATE commerce_hosted_supply_offers SET terms='{}' WHERE offer_id=$1",[replacement.offer_id]), /withdrawal only/);
  ok(await send(a,`/products/${p.product_id}/remove`,{},changed.version),409);
});

test('concurrent duplicate selections create one relation; another seller cannot read or revise it',async () => {
  const a=await store('供貨 A'),b=await store('零售 B'),c=await store('零售 C'),p=await product(a),o=await offer(a,p);
  const body={offer_id:o.offer_id,terms_sha256:o.terms_sha256,retail_price_minor:1200};
  const results=await Promise.all([send(b,'/distribution-selections',body),send(b,'/distribution-selections',body)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
  const l=results.find(r=>r.status===201)!.data;
  ok(await send(c,`/distribution-selections/${l.selection_id}`,body,l.version,randomUUID(),'PATCH'),404);
  assert.deepEqual(ok(await get(c,'/distribution-selections')).items,[]);
  assert.deepEqual(ok(await get(c,'/supply-requests')).items,[]);
  ok(await get(b,'/distribution-selections',c.owner),404);
  const quiet=(await runtime.query('SELECT count(*)::int AS n FROM commerce_hosted_supply_offers')).rows[0]; assert.equal(quiet.n,0);
});

test('seller can stop adoption; supplier cannot resurrect it without a new seller proposal; replay after tenant revocation fails',async () => {
  const a=await store('供貨 A'),b=await store('零售 B'),p=await product(a),o=await offer(a,p);
  const l=await decide(a,await propose(b,o,1200)),key=randomUUID();
  const operator=(await h.person('選品操作員')).session,principal=await h.candidate(b.owner,operator.user.user_id);
  const invitation=await h.post(`/tenants/${b.tenantId}/invitations`,b.owner,{invitee_principal_id:principal,role:'operator',
    instance_capabilities:[{instance_id:b.instanceId,capabilities:['store:read','store:write']}],expires_at:new Date(Date.now()+86400000).toISOString()});
  ok(invitation,201); await h.accept(operator,b.tenantId,invitation);
  const stopped=ok(await send(b,`/distribution-selections/${l.selection_id}/withdraw`,{},l.version,key,'POST',operator));
  assert.equal(stopped.state,'revoked'); assert.equal(await h.count('commerce_distribution_acceptances'),1);
  ok(await send(a,`/supply-requests/${l.selection_id}/decision`,{decision:'accepted',listing_sha256:l.listing_sha256},stopped.version),409);
  assert.deepEqual(ok(await send(b,`/distribution-selections/${l.selection_id}/withdraw`,{},l.version,key,'POST',operator)),stopped);
  await h.pool.query("UPDATE tenant_memberships SET status='revoked',revoked_at=clock_timestamp(),version=version+1 WHERE tenant_id=$1 AND principal_id=$2",[b.tenantId,principal]);
  ok(await send(b,`/distribution-selections/${l.selection_id}/withdraw`,{},l.version,key,'POST',operator),404);
});

test('shared display selection cannot enter the existing own-stock reservation profile',async () => {
  const a=await store('供貨 A'),b=await store('零售 B'),p=await product(a),o=await offer(a,p);
  const l=await decide(a,await propose(b,o,1200)); await publish(b);
  await h.pool.query('UPDATE commerce_storefront_profiles SET reservation_enabled=true WHERE instance_id=$1',[b.instanceId]);
  const buyer=(await h.person('獨立買家')).session;
  const actor=await authenticate(runtime,buyer.cookie.split('=')[1].split(';')[0]);
  await assert.rejects(createDirectQuote(runtime,actor,ok(await get(b,'')).store.slug,{publication_revision:'1',items:[{sku:l.sku,quantity:6}]},randomUUID()),
    (e:unknown)=>(e as {code?:string}).code==='publication_changed');
  assert.equal(await h.count('commerce_orders'),0); assert.equal(await h.count('commerce_order_quotes'),0);
  assert.equal((await h.pool.query('SELECT reserved FROM commerce_items WHERE item_id=$1',[p.product_id])).rows[0].reserved,0);
});

test('private writers cannot publish costs; removing publish permission fences an existing receipt',async () => {
  const a=await store('供貨 A'),p=await product(a),operator=(await h.person('私人商品編輯者')).session;
  const principal=await h.candidate(a.owner,operator.user.user_id);
  const invitation=await h.post(`/tenants/${a.tenantId}/invitations`,a.owner,{invitee_principal_id:principal,role:'operator',
    instance_capabilities:[{instance_id:a.instanceId,capabilities:['store:read','store:write']}],expires_at:new Date(Date.now()+86400000).toISOString()});
  ok(invitation,201);await h.accept(operator,a.tenantId,invitation);
  const path=`/products/${p.product_id}/supply-offer`,key=randomUUID();
  ok(await send(a,path,{},p.version,key,'POST',operator),403);
  assert.equal(await h.count('commerce_hosted_supply_offers'),0);
  await h.pool.query(`UPDATE tenant_module_permissions SET capabilities=ARRAY['store:read','store:write','store:publish'] WHERE tenant_id=$1 AND principal_id=$2`,[a.tenantId,principal]);
  const o=ok(await send(a,path,{},p.version,key,'POST',operator));
  assert.equal(o.state,'offered');
  await h.pool.query(`UPDATE tenant_module_permissions SET capabilities=ARRAY['store:read','store:write'] WHERE tenant_id=$1 AND principal_id=$2`,[a.tenantId,principal]);
  ok(await send(a,path,{},p.version,key,'POST',operator),403);
  assert.equal(await h.count('commerce_hosted_supply_offers'),1);
});
