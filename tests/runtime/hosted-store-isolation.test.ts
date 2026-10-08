import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { createApp } from '../../apps/platform-api/src/app.js';
import { DEMO_COMMUNITY } from '../../packages/testing/seed.js';
import { createRegistryHarness, type RegistryHarness, type Session, type Reply } from './module-registry-harness.js';

let h: RegistryHarness, app: ReturnType<typeof createApp>;
const ok = (r: Reply, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.data)); return r.data; };
const call = (method: string, path: string, session?: Session, body?: unknown, headers: Record<string,string> = {}) => h.call(method,path,session,body,headers,app);
const post = (path: string, session: Session, body: unknown, version?: string) => call('POST',path,session,body,{
  'Idempotency-Key':randomUUID(),...(version?{'If-Match':`"${version}"`}:{}),
});
const internal = {
  schema:'freedom-shop/v1',kind:'internal',access:'authenticated',name:'合成傳統供貨',description:'合成說明',website_url:'https://legacy.example.test',contact:'合成聯絡',currency:'TWD',
  products:[{sku:'LEGACY',title:'傳統商品',description:'原有商品',photo_url:null,price_minor:1000,shipping_minor:0,stock:5,shipping_terms:'合成運送',return_terms:'合成退貨'}],
};
const publicManifest = (itemId: string) => ({schema:'freedom-shop/v1',kind:'public',name:'合成傳統零售',description:'合成說明',website_url:'https://retail.example.test',contact:'合成聯絡',currency:'TWD',selections:[{item_id:itemId,retail_price_minor:2000,sale_terms:'合成售價'}]});
async function machine(path: string, token: string, body?: unknown) {
  const response=await app.request(h.origin+'/shop-api/v1'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json(),response};
}
before(async()=>{h=await createRegistryHarness('fp_hosted_isolation');app=createApp(h.pool,h.origin,'local',{guildLaunchpadEnabled:true,shopKeyPolicy:'legacy-compatible'});});
after(async()=>{if(h)await h.stop();});
beforeEach(async()=>{
  await h.reset();
  await h.pool.query(`INSERT INTO guild_application_offerings(offering_id,community_id,guild_key,application_key,release_ref,status,display_order,launch_policy_ref,version)
    VALUES($1,$2,'guild_commerce_sales','hosted-store','hosted-store@1.0.0','offered',10,'{"policy_key":"hosted-store.launch","version":"1"}',1)`,[randomUUID(),DEMO_COMMUNITY]);
});

test('T-020 legacy catalog, imports, kits, keys, orders, acceptances, public-shop and machine routes exclude hosted rows while imported commerce still works',async()=>{
  const owner=(await h.person('合成商店擁有者')).session;await h.fullMember(owner.user.user_id,'guild_commerce_sales');
  const made=ok(await post('/tenants',owner,{display_name:'隔離業務',workspace_name:'隔離櫃檯'}),201);
  const tenantId=made.tenant.tenant_id;
  const plan=ok(await post(`/tenants/${tenantId}/application-launch-plans`,owner,h.planBody('guild_commerce_sales',made.workspace.workspace_id,'hosted-store','hosted-store@1.0.0')),201);
  const launched=await post(`/tenants/${tenantId}/application-installations`,owner,{plan_id:plan.plan_id,expected_plan_version:plan.version,configuration_digest:plan.configuration_digest});
  assert.ok([200,202].includes(launched.status),JSON.stringify(launched.data));
  const instanceId=(await h.pool.query(`SELECT instance_id FROM module_instances WHERE tenant_id=$1 AND module_key='storefront'`,[tenantId])).rows[0].instance_id;
  const root=`/tenants/${tenantId}/storefronts/${instanceId}`;
  ok(await post(root+'/setup',owner,{name:'隔離商店',slug:'isolated-shop',currency:'TWD'}),201);
  const hosted=ok(await post(root+'/products',owner,{title:'托管商品',price_minor:1234,stock:5}),201);
  const profile=(await h.pool.query('SELECT * FROM commerce_storefront_profiles WHERE instance_id=$1',[instanceId])).rows[0];
  const selection=(await h.pool.query('SELECT * FROM commerce_selections WHERE item_id=$1',[hosted.product_id])).rows[0];
  const legacy=ok(await post('/commerce/import',owner,{manifest:internal,confirmed:true}),201);
  const catalog=ok(await call('GET','/commerce/catalog',owner)).items;
  assert.equal(catalog.length,1);assert.equal(catalog[0].sku,'LEGACY');assert.equal(catalog.some((i:any)=>i.item_id===hosted.product_id),false,'GET /commerce/catalog');
  const shops=ok(await call('GET','/commerce/shops',owner)).items;
  assert.deepEqual(shops.map((s:any)=>s.shop_id),[legacy.shop_id],'GET /commerce/shops');
  const forbidden=publicManifest(hosted.product_id);
  const preview=await post('/commerce/preview',owner,{content:JSON.stringify(forbidden)});ok(preview,422);assert.equal(preview.data.code,'item_unavailable','POST /commerce/preview');
  const imported=await post('/commerce/import',owner,{manifest:forbidden,confirmed:true});ok(imported,422);assert.equal(imported.data.code,'item_unavailable','POST /commerce/import');
  const kit=await post('/commerce/agent-kit',owner,{kind:'public',item_ids:[hosted.product_id]});ok(kit,422);assert.equal(kit.data.code,'selection_changed','POST /commerce/agent-kit');
  for(const shopId of [profile.supply_shop_id,profile.storefront_shop_id]){
    const accepting=await post(`/commerce/shops/${shopId}/accepting-orders`,owner,{accepting:true});ok(accepting,404);assert.equal(accepting.data.code,'shop_not_found','POST accepting-orders');
    const issue=await post(`/commerce/shops/${shopId}/key`,owner,{});ok(issue,404);assert.equal(issue.data.code,'shop_not_found','POST key');
    const revoke=await post(`/commerce/shops/${shopId}/revoke-key`,owner,{});ok(revoke,404);assert.equal(revoke.data.code,'shop_not_found','POST revoke-key');
    ok(await call('GET',`/commerce/shops/${shopId}/orders`,owner),404);
    ok(await call('GET',`/public-shops/${shopId}`),404);
  }
  assert.deepEqual(ok(await call('GET','/commerce/distribution-acceptances',owner)).items,[],'GET distribution-acceptances');
  const decision=await post(`/commerce/selections/${selection.selection_id}/distribution-acceptance`,owner,{decision:'accepted',listing_sha256:'0'.repeat(64),note:'合成接受'},'1');ok(decision,404);assert.equal(decision.data.code,'acceptance_not_found');
  assert.equal(await h.count('commerce_shop_keys','WHERE shop_id=ANY($1::uuid[])',[[profile.supply_shop_id,profile.storefront_shop_id]]),0);
  const absentToken='fw_shop_'+randomBytes(32).toString('base64url');
  assert.equal((await machine('/connection',absentToken)).status,401,'hosted shop has no usable key');
  // Even an injected stale legacy credential is rejected before a service principal can be created.
  await h.pool.query(`INSERT INTO commerce_shop_keys(shop_id,token_hash,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 day')`,[profile.storefront_shop_id,createHash('sha256').update(absentToken).digest('hex')]);
  assert.equal((await machine('/connection',absentToken)).status,401);
  assert.equal(await h.count('principals','WHERE service_shop_ref=$1',[profile.storefront_shop_id]),0);
  const importedItem=catalog[0].item_id;
  ok(await post('/commerce/preview',owner,{content:JSON.stringify(publicManifest(importedItem))}));
  const retail=ok(await post('/commerce/import',owner,{manifest:publicManifest(importedItem),confirmed:true}),201);
  const acceptances=ok(await call('GET','/commerce/distribution-acceptances',owner)).items;
  for(const row of acceptances)if(row.acceptance_state==='awaiting_supply_acceptance')ok(await post(`/commerce/selections/${row.selection_id}/distribution-acceptance`,owner,{decision:'accepted',listing_sha256:row.listing_sha256,note:'合成核准'},String(row.aggregate_version)));
  const token=ok(await post(`/commerce/shops/${retail.shop_id}/key`,owner,{})).token;
  const connection=await machine('/connection',token);assert.equal(connection.status,200);const connected=connection.data as any;assert.equal(connected.selections.length,1);assert.equal(connected.selections[0].item_id,importedItem);
  const ordered=await machine('/orders',token,{external_id:'synthetic-legacy-order',items:[{selection_id:connected.selections[0].selection_id,quantity:1,delivery_ref:'synthetic-delivery'}]});assert.equal(ordered.status,201,JSON.stringify(ordered.data));
  ok(await call('GET',`/public-shops/${retail.shop_id}`));
  assert.equal(ok(await call('GET',`/commerce/shops/${retail.shop_id}/orders`,owner)).items.length,1);
  ok(await post('/commerce/agent-kit',owner,{kind:'public',item_ids:[importedItem]}));
  ok(await post(`/commerce/shops/${legacy.shop_id}/accepting-orders`,owner,{accepting:false}));
  ok(await post(`/commerce/shops/${retail.shop_id}/revoke-key`,owner,{}));assert.equal((await machine('/connection',token)).status,401);
  assert.equal(await h.count('commerce_distribution_acceptances','WHERE selection_id=$1',[selection.selection_id]),0);
});
