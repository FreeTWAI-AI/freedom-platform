// SC-09 / AT-25 / AT-26: restricted-role partner bytes, storefront/cooperation
// authority, HTTP ranges and revocation during I/O. Uploads use the real route.
import assert from 'node:assert/strict';
import {after,before,beforeEach,test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {createSupplyMaterialLifecycle} from '../../modules/assets/supply-material.js';
import {createHostedStorePhotoHarness,photoSourcePng,type HostedStorePhotoHarness} from '../helpers/hosted-store-photo.js';
import type {Session} from './module-registry-harness.js';
import {DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {objectKey} from '../../packages/asset-storage/index.js';
import {digest} from '../../packages/db/index.js';
import {withTenantRead} from '../../packages/resource-scopes/index.js';
import {storeCapabilities} from '../../modules/agent-commerce/hosted/capabilities.js';
import {authenticate} from '../../modules/identity-membership/service.js';
import {partnerVisibleMaterials} from '../../modules/agent-commerce/supplier-console/materials.js';
import {partnerMaterialPath} from '../../modules/agent-commerce/supplier-console/ui/partner/partner-materials.js';

type Store={owner:Session;tenantId:string;instanceId:string;root:string};
type Material={material_id:string;version_id:string;kind:'image'|'video'|'copy'};
let f:HostedStorePhotoHarness,assets:ReturnType<typeof createSupplyMaterialLifecycle>,app:ReturnType<HostedStorePhotoHarness['application']>;
const video=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(244)]);
const application=(extra:NonNullable<Parameters<HostedStorePhotoHarness['application']>[1]>={})=>f.application(true,
  {supplierConsoleEnabled:true,supplyMaterialAssetStore:f.store,supplyMaterialAssets:assets,supplyMaterialUploadsEnabled:true,...extra});
const call=(s:Store,path:string,session:Session|undefined=s.owner,target=app)=>f.h.call('GET',s.root+path,session,undefined,{},target);
const send=(s:Store,path:string,body:unknown={},version?:string,method='POST')=>f.h.call(method,s.root+path,s.owner,body,
  {'Idempotency-Key':randomUUID(),...(version?{'If-Match':`"${version}"`}:{})},app);
const row=async(m:Material)=>(await f.h.pool.query('SELECT * FROM supply_material_versions WHERE version_id=$1',[m.version_id])).rows[0];
const shop=async(s:Store)=>(await f.h.pool.query('SELECT storefront_shop_id FROM commerce_storefront_profiles WHERE instance_id=$1',[s.instanceId])).rows[0].storefront_shop_id as string;
const detail=async(s:Store,m:Material)=>f.ok(await call(s,`/supply-materials/${m.material_id}`)).material;
const path=(s:Store,m:Material)=>partnerMaterialPath(s.tenantId,s.instanceId,m.material_id,m.version_id);
const read=(s:Store,m:Material,options:{method?:string;headers?:Record<string,string>;session?:Session|null;target?:typeof app;query?:string}={})=>
  (options.target??app).request(f.h.origin+path(s,m)+(options.query??''),{method:options.method??'GET',headers:{
    ...(options.session===null?{}:{Cookie:(options.session??s.owner).cookie}),...options.headers}});
async function mutation(s:Store,m:Material,suffix:string,body:unknown={},method='POST') {
  return f.ok(await send(s,`/supply-materials/${m.material_id}${suffix}`,body,(await detail(s,m)).version,method));
}
const grant=async(s:Store,m:Material,b:Store)=>mutation(s,m,'/grants',{partner_ids:[await shop(b)]});
const revoke=async(s:Store,m:Material,b:Store)=>mutation(s,m,`/grants/${await shop(b)}/revoke`);
async function upload(s:Store,m:Material) {
  const expected=(await detail(s,m)).version;
  const response=await app.request(f.h.origin+'/api/v1'+s.root+`/supply-materials/${m.material_id}/content`,{method:'POST',headers:{
    Origin:f.h.origin,Cookie:s.owner.cookie,'X-CSRF-Token':s.owner.csrf,'Content-Type':m.kind==='video'?'video/mp4':'image/png',
    'Idempotency-Key':randomUUID(),'If-Match':`"${expected}"`},body:new Uint8Array(m.kind==='video'?video:photoSourcePng)});
  assert.equal(response.status,200,await response.text());
  m.version_id=(await f.h.pool.query('SELECT current_version_id FROM supply_materials WHERE material_id=$1',[m.material_id])).rows[0].current_version_id;
}
async function material(s:Store,kind:Material['kind']='image',product_id:string|null=null) {
  const made=f.ok(await send(s,'/supply-materials',{kind,product_id,title:'合成合作素材',description:'經授權的介紹',...(kind==='copy'?{body:'合成文案'}:{})}),201);
  const m:Material={material_id:made.material_id,version_id:'',kind};
  if(kind==='copy')m.version_id=(await detail(s,m)).current.version_id;else await upload(s,m);
  return m;
}
async function supplier():Promise<Store> {
  const owner=(await f.h.person('合成供應商')).session;await f.h.fullMember(owner.user.user_id,'guild_product_quality_supply');
  const {tenantId,workspaceId}=await f.h.createTenant(owner,'合成供應商');
  const plan=await f.h.plan(owner,tenantId,f.h.planBody('guild_product_quality_supply',workspaceId,'hosted-store','hosted-store@1.0.0'));f.ok(plan,201);
  const launched=await f.h.launch(owner,tenantId,plan);assert.ok([200,202].includes(launched.status));assert.equal(launched.data.state,'succeeded');
  const instanceId=(await f.h.pool.query("SELECT instance_id FROM module_instances WHERE tenant_id=$1 AND module_key='storefront'",[tenantId])).rows[0].instance_id as string;
  const s={owner,tenantId,instanceId,root:`/tenants/${tenantId}/storefronts/${instanceId}`};
  f.ok(await send(s,'/supply-profile',{name:'合成供應商',description:'合作素材測試',currency:'TWD'}),201);return s;
}
async function offer(s:Store) {
  const made=f.ok(await send(s,'/supply-products',{title:'合成商品',description:'素材合作',cost_minor:400,stock:100}),201);
  const item=f.ok(await call(s,'/supply-products')).items.find((p:any)=>p.product_id===made.product_id);
  const saved=f.ok(await send(s,`/products/${item.product_id}/supply-terms`,{cost_minor:400,shipping_minor:50,shipping_terms:'三天出貨',return_terms:'聯絡供應商'},item.version,'PATCH'));
  return {...f.ok(await send(s,`/products/${item.product_id}/supply-offer`,{},saved.version)),product_id:item.product_id};
}
const propose=async(b:Store,o:any)=>f.ok(await send(b,'/distribution-selections',{offer_id:o.offer_id,terms_sha256:o.terms_sha256,retail_price_minor:1200}),201);
const decide=async(a:Store,l:any,decision:string)=>f.ok(await send(a,`/supply-requests/${l.selection_id}/decision`,{decision,listing_sha256:l.listing_sha256},l.version));
async function journey(accepted=true) {
  const a=await supplier(),b=await f.openStore(),o=await offer(a);let l=await propose(b,o);
  if(accepted)l=await decide(a,l,'accepted');
  const m=await material(a);await grant(a,m,b);return {a,b,o,l,m};
}
async function join(s:Store,role:'viewer'|'operator'='viewer') {
  const person=(await f.h.person('合成素材協作者')).session,principal=await f.h.candidate(s.owner,person.user.user_id);
  const invitation=f.ok(await f.post(`/tenants/${s.tenantId}/invitations`,s.owner,{invitee_principal_id:principal,role,
    instance_capabilities:[{instance_id:s.instanceId,capabilities:['store:read']}],expires_at:new Date(Date.now()+86400000).toISOString()}),201);
  f.ok(await f.post(`/tenants/${s.tenantId}/invitations/${invitation.invitation_id}/accept`,person,{},invitation.version));return {person,principal};
}
async function lower(s:Store,principal:string) {
  const member=f.ok(await f.call('GET',`/tenants/${s.tenantId}/members`,s.owner)).items.find((r:any)=>r.principal_id===principal);
  f.ok(await f.post(`/tenants/${s.tenantId}/members/${principal}/change`,s.owner,{role:'operator',status:'active',instance_capabilities:[],reason:'合成撤權測試'},member.version));
}
function safeHeaders(response:Response,a:Store) {
  assert.equal(response.headers.get('Cache-Control'),'private, no-store');assert.equal(response.headers.get('Vary'),'Cookie');
  noLocators(response,a);
}
function noLocators(response:Response,a:Store) {
  assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');
  const headers=JSON.stringify([...response.headers]);
  assert(!headers.includes(a.tenantId));assert(!headers.includes(a.instanceId));
  assert.doesNotMatch(headers,/bucket|locator|object.key|storage.url|https?:\/\/|v1\/scopes\//i);
}
function byteHeaders(response:Response,a:Store,type:string,size:number) {
  safeHeaders(response,a);assert.equal(response.headers.get('Content-Type'),type);assert.equal(response.headers.get('Content-Length'),String(size));
  assert.equal(response.headers.get('Accept-Ranges'),'bytes');assert.equal(response.headers.get('Content-Disposition'),'inline');
  assert.match(response.headers.get('ETag')!,/^"[A-Za-z0-9_-]+"$/);assert.doesNotMatch(response.headers.get('Content-Type')!,/json/);
}
async function refused(response:Response,a:Store,expected?:unknown) {
  assert.equal(response.status,404);safeHeaders(response,a);assert.match(response.headers.get('Content-Type')!,/json/);
  const body=await response.json();assert.equal(body.code,'not_found');assert.equal(body.detail,'找不到這個素材。');
  if(expected)assert.deepEqual(body,expected);return body;
}
before(async()=>{f=await createHostedStorePhotoHarness();assets=createSupplyMaterialLifecycle(f.runtime,{store:f.store});});
after(async()=>{await f?.stop();});
beforeEach(async()=>{
  await f.reset();
  await f.h.pool.query("UPDATE tenant_capacity_policies SET max_retained_bytes=104857600 WHERE status='active'");
  await f.h.pool.query("UPDATE domain_media_storage_policy SET mode='r2_only',persistence_allowed=true,policy_revision='synthetic-partner-http',retained_byte_limit=104857600 WHERE purpose IN ('storefront.supply-material','storefront.supply-material-video')");
  await f.h.pool.query(`INSERT INTO guild_application_offerings(offering_id,community_id,guild_key,application_key,release_ref,status,display_order,launch_policy_ref,version)
    VALUES($1,$2,'guild_product_quality_supply','hosted-store','hosted-store@1.0.0','offered',10,'{"policy_key":"hosted-store.launch","version":"1"}',1)`,[randomUUID(),DEMO_COMMUNITY]);
  app=application();
});

test('SC-API-M1C-01 AT-25 image/video bytes match supplier; HEAD and video ranges preserve private headers',async()=>{
  const {a,b,m}=await journey(),v=await material(a,'video');await grant(a,v,b);
  for(const item of [m,v]) {
    const own=await app.request(f.h.origin+'/api/v1'+a.root+`/supply-materials/${item.material_id}/versions/${item.version_id}/content`,{headers:{Cookie:a.owner.cookie}});
    assert.equal(own.status,200);const bytes=new Uint8Array(await own.arrayBuffer()),r=await read(b,item);
    assert.equal(r.status,200);byteHeaders(r,a,item.kind==='image'?'image/webp':'video/mp4',bytes.length);
    assert.deepEqual(new Uint8Array(await r.arrayBuffer()),bytes);
    const gets=f.store.gets,head=await read(b,item,{method:'HEAD'});assert.equal(head.status,200);byteHeaders(head,a,own.headers.get('Content-Type')!,bytes.length);
    assert.deepEqual([...head.headers],[...r.headers]);assert.equal(await head.text(),'');assert.equal(f.store.gets,gets);
  }
  const range=await read(b,v,{headers:{Range:'bytes=0-99'}});assert.equal(range.status,206);byteHeaders(range,a,'video/mp4',100);
  assert.equal(range.headers.get('Content-Range'),`bytes 0-99/${video.length}`);assert.deepEqual(Buffer.from(await range.arrayBuffer()),video.subarray(0,100));
  const unsat=await read(b,v,{headers:{Range:'bytes=99999-'}});assert.equal(unsat.status,416);byteHeaders(unsat,a,'video/mp4',0);
  assert.equal(unsat.headers.get('Content-Range'),`bytes */${video.length}`);assert.equal(await unsat.text(),'');
  const full=await read(b,v,{headers:{Range:'bytes=0-99','If-Range':'"different"'}});assert.equal(full.status,200);byteHeaders(full,a,'video/mp4',video.length);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()),video);
});

for(const end of ['declined','revoked','offer withdrawn'] as const)test(`SC-API-M1C-02 ${end}: awaiting/sellable cooperation ends via the real route`,async()=>{
  const {a,b,o,l,m}=await journey(end!=='declined');const r=await read(b,m);assert.equal(r.status,200);await r.arrayBuffer();
  if(end==='offer withdrawn')f.ok(await send(a,`/supply-offers/${o.offer_id}/withdraw`,{},o.version));else await decide(a,l,end);
  await refused(await read(b,m),a);
});

test('SC-API-M1C-03 product materials require that product; brand materials use any current cooperation',async()=>{
  const {a,b,m}=await journey(),other=await offer(a),product=await material(a,'image',other.product_id);
  // Grant while eligible, then end only this product's cooperation.
  const l=await propose(b,other);await grant(a,product,b);assert.equal((await read(b,product)).status,200);
  await decide(a,l,'declined');const expected=await refused(await read(b,product),a);
  assert.equal((await read(b,m)).status,200);
  const c=await f.openStore();await propose(c,other);await grant(a,m,c);
  assert.equal((await read(c,m)).status,200);await refused(await read(c,product),a,expected);
});

test('SC-API-M1C-04 all material visibility refusals have identical 404 problems and no media bytes',async()=>{
  const {a,b,o,m}=await journey(),c=await f.openStore();await propose(c,o);
  const expected=await refused(await read(c,m),a);
  await refused(await read(b,{...m,material_id:randomUUID()}),a,expected);
  await refused(await read(b,{...m,version_id:randomUUID()}),a,expected);
  await refused(await read(a,m),a,expected);
  const other=await material(a);await grant(a,other,b);
  await refused(await read(b,{...m,version_id:other.version_id}),a,expected);
  const copy=await material(a,'copy');await grant(a,copy,b);await refused(await read(b,copy),a,expected);
  const previous={...m};await upload(a,m);await refused(await read(b,previous),a,expected);assert.equal((await read(b,m)).status,200);
  await revoke(a,m,b);await refused(await read(b,m),a,expected);
  await mutation(a,other,'/withdraw');await refused(await read(b,other),a,expected);
});

// The launch harness provides one live storefront per tenant. Clone a real
// archived storefront with confirmed mappings/cooperation to exercise the SQL pin.
async function secondShop(b:Store,l:any) {
  const ids={instance:randomUUID(),binding:randomUUID(),supply:randomUUID(),seller:randomUUID()},q=await f.h.pool.connect();
  try {
    await q.query('BEGIN');
    await q.query(`INSERT INTO module_instances(instance_id,tenant_id,module_key,application_release_ref,data_schema_version,contract_ref,status,binding_id,created_by_principal_id,origin_guild_key,module_release_ref)
      SELECT $1,tenant_id,module_key,application_release_ref,data_schema_version,contract_ref,'archived',$2,created_by_principal_id,origin_guild_key,module_release_ref FROM module_instances WHERE instance_id=$3`,[ids.instance,ids.binding,b.instanceId]);
    await q.query(`INSERT INTO deployment_bindings(binding_id,tenant_id,instance_id,mode,environment,contract_ref,state)
      SELECT $1,tenant_id,$2,'hosted',environment,contract_ref,'retired' FROM deployment_bindings WHERE instance_id=$3`,[ids.binding,ids.instance,b.instanceId]);
    await q.query(`INSERT INTO commerce_shops(shop_id,community_id,owner_id,kind,origin,mode,accepting_orders,name,description,website_url,contact,currency,manifest_sha256)
      SELECT ids.id,s.community_id,s.owner_id,ids.kind,'hosted','test',false,'同租戶第二店','合成測試','','',s.currency,replace(ids.id::text,'-','')||replace(ids.id::text,'-','')
      FROM (VALUES($1::uuid,'internal'),($2::uuid,'public')) ids(id,kind) CROSS JOIN commerce_shops s
      JOIN commerce_storefront_profiles p ON p.storefront_shop_id=s.shop_id WHERE p.instance_id=$3`,[ids.supply,ids.seller,b.instanceId]);
    await q.query(`INSERT INTO commerce_storefront_profiles(instance_id,tenant_id,supply_shop_id,storefront_shop_id,created_by_principal_id)
      SELECT $1,tenant_id,$2,$3,created_by_principal_id FROM commerce_storefront_profiles WHERE instance_id=$4`,[ids.instance,ids.supply,ids.seller,b.instanceId]);
    await q.query(`INSERT INTO commerce_resource_tenants(resource_kind,resource_id,tenant_id,instance_id,source_owner_id,mapping_state)
      SELECT 'shop',ids.id,p.tenant_id,$3,p.created_by_principal_id,'confirmed' FROM (VALUES($1::uuid),($2::uuid)) ids(id)
      CROSS JOIN commerce_storefront_profiles p WHERE p.instance_id=$4`,[ids.supply,ids.seller,ids.instance,b.instanceId]);
    const source=(await q.query('SELECT snapshot FROM commerce_selections WHERE selection_id=$1',[l.selection_id])).rows[0].snapshot;
    const snapshot={...source,seller_shop_id:ids.seller};
    await q.query(`INSERT INTO commerce_selections(selection_id,shop_id,item_id,retail_price_minor,sale_terms,snapshot,listing_sha256,hosted_offer_id,hosted_sku)
      SELECT $1,$2,item_id,retail_price_minor,sale_terms,$3,$4,hosted_offer_id,hosted_sku FROM commerce_selections WHERE selection_id=$5`,
    [randomUUID(),ids.seller,snapshot,digest(snapshot),l.selection_id]);
    await q.query('COMMIT');return ids.seller;
  } catch(error) {await q.query('ROLLBACK');throw error;} finally {q.release();}
}
test('SC-API-M1C-05 same-tenant storefront grant is pinned to the exact cooperating shop under RLS',async()=>{
  const {a,b,l,m}=await journey(),other=await secondShop(b,l),actor=await authenticate(f.runtime,b.owner.cookie.split('=')[1].split(';')[0]);
  await withTenantRead(f.runtime,{actor,tenantId:b.tenantId,capabilitiesForRole:storeCapabilities},async q=>{
    assert.equal((await q.query('SELECT 1 FROM supply_material_grants WHERE material_id=$1 AND revoked_at IS NULL',[m.material_id])).rowCount,1,'tenant RLS exposes the grant');
    const query=`WITH visible AS (${partnerVisibleMaterials}) SELECT * FROM visible WHERE material_id=$2 AND version_id=$3`;
    assert.equal((await q.query(query,[await shop(b),m.material_id,m.version_id])).rowCount,1);
    assert.equal((await q.query(query,[other,m.material_id,m.version_id])).rowCount,0,'other shop cooperates but lacks its own grant');
  });assert.equal((await read(b,m)).status,200);await revoke(a,m,b);
});

test('SC-API-M1C-06 viewer may read; outsiders match the list authority refusal; anonymous is 401 before lookup',async()=>{
  const {a,b,m}=await journey(),viewer=await join(b),outsider=(await f.h.person('合成非會員')).session;
  assert.equal((await read(b,m,{session:viewer.person})).status,200);
  for(const session of [outsider,a.owner]) {
    const list=await call(b,'/partner-materials',session),r=await read(b,m,{session});assert.equal(r.status,list.status);assert.equal(r.status,404);
    safeHeaders(r,a);const body=await r.json();assert.equal(body.code,'not_found');assert(!JSON.stringify(body).includes(m.material_id));
  }
  const anon=await read(b,m,{session:null});assert.equal(anon.status,401);safeHeaders(anon,a);
  const body=await anon.text();assert(!body.includes(m.material_id));assert(!body.includes(m.version_id));assert(!body.includes('合成合作素材'));
});

for(const mode of ['full','range'] as const)for(const change of ['revoke','withdraw','new version','role loss','cooperation end'] as const)
  test(`SC-API-M1C-07 AT-26 ${mode}: ${change} during object I/O refuses and cancels ranges`,async()=>{
    const {a,b,l,m}=await journey(),member=await join(b,'operator'),original=f.store.get.bind(f.store);let cancelled=false;
    f.store.get=async(...args)=>{
      const object=await original(...args);if(!object)return null;const reader=object.body.getReader();
      return {...object,body:new ReadableStream<Uint8Array>({async pull(c){const next=await reader.read();if(next.done)c.close();else c.enqueue(next.value);},
        async cancel(){cancelled=true;await reader.cancel();}},{highWaterMark:0})};
    };
    const old={...m};f.store.afterGet=async()=>{
      f.store.afterGet=undefined;
      if(change==='revoke')await revoke(a,m,b);
      else if(change==='withdraw')await mutation(a,m,'/withdraw');
      else if(change==='new version')await upload(a,m);
      else if(change==='role loss')await lower(b,member.principal);
      else await decide(a,l,'revoked');
    };
    try {
      await refused(await read(b,old,{session:member.person,headers:mode==='range'?{Range:'bytes=0-9'}:{}}),a);
      if(mode==='range')assert.equal(cancelled,true,'started range body was cancelled');
      if(change==='revoke')await refused(await read(b,old),a);
      if(change==='new version')assert.equal((await read(b,m)).status,200);
    } finally {f.store.get=original;f.store.afterGet=undefined;}
  });

test('SC-API-M1C-08 metadata labels changing during I/O do not alter the object identity pin',async()=>{
  const {a,b,m}=await journey(),other=await offer(a);f.store.afterGet=async()=>{
    f.store.afterGet=undefined;await mutation(a,m,'',{title:'更新顯示標題',description:'同一素材'},'PATCH');await propose(b,other);
  };
  const r=await read(b,m);assert.equal(r.status,200);assert((await r.arrayBuffer()).byteLength>0);
});

for(const fault of ['missing','content type','size','etag','get failure'] as const)test(`SC-API-M1C-09 ${fault} is unavailable, never empty success`,async()=>{
  const {a,b,m}=await journey(),v=await row(m),key=objectKey({scopeId:v.scope_id,assetId:v.asset_id,representationId:v.representation_id});
  const head=f.store.head.bind(f.store),get=f.store.get.bind(f.store);
  if(fault==='missing')await f.store.delete(key);
  if(fault==='content type'||fault==='size')f.store.head=async k=>{const h=await head(k);return h?{...h,metadata:{...h.metadata,...(fault==='size'?{byteSize:h.metadata.byteSize+1}:{contentType:'video/mp4'})}}:h;};
  if(fault==='etag')f.store.get=async(...args)=>{const object=await get(...args);return object?{...object,etag:'changed-etag'}:object;};
  if(fault==='get failure')f.store.failNext('get');
  try {const r=await read(b,m);assert.equal(r.status,503);safeHeaders(r,a);const body=await r.json();assert.equal(body.code,'material_content_unavailable');assert.equal(body.detail,'素材檔案暫時無法讀取。');}
  finally {f.store.head=head;f.store.get=get;}
});

test('SC-API-M1C-10 installation guards GET/HEAD; uploads OFF preserves reads; strict query and ids',async()=>{
  const {a,b,m}=await journey(),absent=application({supplyMaterialAssetStore:undefined,supplyMaterialAssets:undefined});
  const missing=await read(b,m,{target:absent});assert.equal(missing.status,404);safeHeaders(missing,a);assert.equal((await missing.json()).code,'not_found');
  const head=await read(b,m,{target:absent,method:'HEAD'});assert.equal(head.status,404);safeHeaders(head,a);assert.equal(await head.text(),'');
  const r=await read(b,m,{target:application({supplyMaterialUploadsEnabled:false})});assert.equal(r.status,200);assert((await r.arrayBuffer()).byteLength>0);
  for(const item of [{query:'?unknown=1'},{query:'?x=1&x=2'}]) {const response=await read(b,m,item);assert.equal(response.status,422);safeHeaders(response,a);assert.equal((await response.json()).code,'validation_failed');}
  const malformed=await read(b,{...m,material_id:'nope'});assert.equal(malformed.status,422);safeHeaders(malformed,a);
  await refused(await read(b,{...m,material_id:randomUUID()}),a);
});

test('SC-API-M1C-11 list round trip uses the UI path builder; revoked item disappears and its old path refuses',async()=>{
  const {a,b,m}=await journey(),v=await material(a,'video');await grant(a,v,b);
  const listed=f.ok(await call(b,'/partner-materials'));assert.equal(listed.items.length,2);
  for(const item of listed.items) {
    assert.ok(['image','video'].includes(item.current.content.kind));
    const response=await app.request(f.h.origin+partnerMaterialPath(b.tenantId,b.instanceId,item.material_id,item.current.version_id),{headers:{Cookie:b.owner.cookie}});
    assert.equal(response.status,200);safeHeaders(response,a);assert((await response.arrayBuffer()).byteLength>0);
  }
  await revoke(a,m,b);const after=f.ok(await call(b,'/partner-materials'));assert.deepEqual(after.items.map((item:any)=>item.material_id),[v.material_id]);
  await refused(await read(b,m),a);
});
