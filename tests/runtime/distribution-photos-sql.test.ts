// D-11 SQL invariants over the same S3 material journey and restricted photo role.
import assert from 'node:assert/strict';
import {after,before,beforeEach,test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {createSupplyMaterialLifecycle} from '../../modules/assets/supply-material.js';
import {createHostedStorePhotoHarness,photoSourcePng,type HostedStorePhotoHarness} from '../helpers/hosted-store-photo.js';
import type {Session} from './module-registry-harness.js';
import {DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {partnerMaterialPath} from '../../modules/agent-commerce/supplier-console/ui/partner/partner-materials.js';
import type {PoolClient} from 'pg';
import {createAssetMaintenance} from '../../modules/assets/maintenance.js';
import {withMemberScope,withTenantRead} from '../../packages/resource-scopes/index.js';
import {storeCapabilities} from '../../modules/agent-commerce/hosted/capabilities.js';
import {authenticate} from '../../modules/identity-membership/service.js';
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
async function upload(s:Store,m:Material,image=photoSourcePng) {
  const expected=(await detail(s,m)).version;
  const response=await app.request(f.h.origin+'/api/v1'+s.root+`/supply-materials/${m.material_id}/content`,{method:'POST',headers:{
    Origin:f.h.origin,Cookie:s.owner.cookie,'X-CSRF-Token':s.owner.csrf,'Content-Type':m.kind==='video'?'video/mp4':'image/png',
    'Idempotency-Key':randomUUID(),'If-Match':`"${expected}"`},body:new Uint8Array(m.kind==='video'?video:image)});
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
  const m=await material(a);await grant(a,m,b);await mutation(a,m,'/access',{access:'public_use',confirm_public_use:true});return {a,b,o,l,m};
}

const list=async(b:Store)=>f.ok(await call(b,'/distribution-photos')).items as any[];
const photo=async(b:Store,id:string)=>(await list(b)).find(p=>p.product_id===id);
const use=(b:Store,o:any,m:Material,version='0',key=randomUUID(),target=app,session=b.owner)=>f.h.call('POST',b.root+`/distribution-photos/${o.product_id}/use`,session,{material_id:m.material_id,version_id:m.version_id},{'Idempotency-Key':key,'If-Match':`"${version}"`},target);
const detach=(b:Store,o:any,version:string)=>send(b,`/distribution-photos/${o.product_id}/detach`,{},version);
async function publish(b:Store){const view=f.ok(await call(b,''));f.ok(await send(b,'/publish',{},view.version));return (await f.h.pool.query('SELECT * FROM commerce_storefront_publications WHERE instance_id=$1 ORDER BY revision DESC LIMIT 1',[b.instanceId])).rows[0];}
async function publicPhoto(b:Store,o:any,revision:string){const s=(await f.h.pool.query('SELECT slug FROM commerce_storefront_profiles WHERE instance_id=$1',[b.instanceId])).rows[0];const selection=(await f.h.pool.query('SELECT hosted_sku FROM commerce_selections WHERE shop_id=$1 AND item_id=$2',[await shop(b),o.product_id])).rows[0];return app.request(f.h.origin+`/shops/${s.slug}/media/${revision}/${selection.hosted_sku}`);}
const usage=async(s:Store)=>(await f.h.pool.query('SELECT COALESCE(sum(o.byte_size),0)::text AS used FROM assets a JOIN asset_objects o USING(asset_id) WHERE a.tenant_ref=$1',[s.tenantId])).rows[0].used;
before(async()=>{f=await createHostedStorePhotoHarness();assets=createSupplyMaterialLifecycle(f.runtime,{store:f.store});});
after(async()=>{await f?.stop();});
beforeEach(async()=>{
 await f.reset();
 await f.h.pool.query("UPDATE tenant_capacity_policies SET max_retained_bytes=104857600 WHERE status='active'");
 await f.h.pool.query("UPDATE domain_media_storage_policy SET mode='r2_only',persistence_allowed=true,policy_revision='synthetic-dp',retained_byte_limit=104857600 WHERE purpose IN ('storefront.product-photo','storefront.supply-material','storefront.supply-material-video')");
 await f.h.pool.query(`INSERT INTO guild_application_offerings(offering_id,community_id,guild_key,application_key,release_ref,status,display_order,launch_policy_ref,version) VALUES($1,$2,'guild_product_quality_supply','hosted-store','hosted-store@1.0.0','offered',10,'{"policy_key":"hosted-store.launch","version":"1"}',1)`,[randomUUID(),DEMO_COMMUNITY]);
 app=application({distributionPhotosEnabled:true});
});


const sql=(...codes:string[])=>(e:unknown)=>codes.includes((e as {code:string}).code);
async function rolled(run:(q:PoolClient)=>Promise<unknown>){const q=await f.h.pool.connect();try{await q.query('BEGIN');return await run(q);}finally{await q.query('ROLLBACK');q.release();}}
async function used(){const j=await journey();f.ok(await use(j.b,j.o,j.m));const copy=(await f.h.pool.query('SELECT * FROM commerce_distribution_photo_copies')).rows[0];return {...j,copy};}

test('DP-SQL-01 target identity, pointer version, no delete, append-only provenance',async()=>{
 const {b,o,copy}=await used();
 for(const query of [
  'DELETE FROM commerce_distribution_photo_targets',
  "UPDATE commerce_distribution_photo_targets SET instance_id='00000000-0000-4000-8000-000000000001'",
  "UPDATE commerce_distribution_photo_targets SET created_at=created_at+interval '1 second'",
  'UPDATE commerce_distribution_photo_targets SET aggregate_version=aggregate_version+1',
  'UPDATE commerce_distribution_photo_targets SET asset_id=NULL,representation_id=NULL,policy_revision=NULL',
  'UPDATE commerce_distribution_photo_targets SET asset_id=NULL,representation_id=NULL,policy_revision=NULL,aggregate_version=aggregate_version+2',
  'DELETE FROM commerce_distribution_photo_copies',
  "UPDATE commerce_distribution_photo_copies SET source_title='changed'",
 ])await assert.rejects(rolled(q=>q.query(query)),sql('23514'));
 await rolled(async q=>{await q.query('UPDATE commerce_distribution_photo_targets SET asset_id=NULL,representation_id=NULL,policy_revision=NULL,aggregate_version=aggregate_version+1');assert.equal((await q.query('SELECT aggregate_version::text v FROM commerce_distribution_photo_targets')).rows[0].v,'2');});
 assert.equal((await photo(b,o.product_id)).version,'1');assert(copy.asset_id);
});

test('DP-SQL-02 ready-Asset/object FKs and provenance cannot dangle or cross tenant/product',async()=>{
 const {a,b,o,copy}=await used(),other=await offer(a);let selection=await propose(b,other);await decide(a,selection,'accepted');
 await f.h.pool.query('INSERT INTO commerce_distribution_photo_targets(tenant_id,instance_id,product_id,scope_id) VALUES($1,$2,$3,$4)',[b.tenantId,b.instanceId,other.product_id,copy.scope_id]);
 await assert.rejects(rolled(q=>q.query('UPDATE commerce_distribution_photo_targets SET asset_id=$1,representation_id=$2,policy_revision=$3,aggregate_version=1 WHERE product_id=$4',[copy.asset_id,copy.representation_id,copy.policy_revision,other.product_id])),sql('23503'));
 for(const query of ["UPDATE assets SET state='retired',retired_at=clock_timestamp() WHERE asset_id=$1",'DELETE FROM asset_objects WHERE asset_id=$1'])await assert.rejects(rolled(q=>q.query(query,[copy.asset_id])),sql('23503','23514'));
 await assert.rejects(rolled(q=>q.query('DELETE FROM supply_material_versions WHERE version_id=$1',[copy.source_version_id])),sql('23503','23514'));
 await assert.rejects(rolled(q=>q.query('UPDATE commerce_distribution_photo_targets SET representation_id=$1,aggregate_version=aggregate_version+1 WHERE product_id=$2',[randomUUID(),o.product_id])),sql('23503'));
});

test('DP-SQL-03 new intent shape is closed and zero CAS applies only to distribution',async()=>{
 const {b,o,m,copy}=await used();const intent=(await f.h.pool.query("SELECT * FROM asset_upload_intents WHERE target_kind='storefront.distribution-photo'")).rows[0];assert.equal(intent.expected_version,'0');assert.equal(intent.source_content_type,'image/webp');assert.equal(intent.reserved_bytes,1048576);assert.equal(intent.target_material_id,null);assert.equal(intent.target_product_id,null);
 f.store.failNext('put-before');assert.equal((await use(b,o,m,'1')).status,503);
 const pending=(await f.h.pool.query("SELECT intent_id FROM asset_upload_intents WHERE target_kind='storefront.distribution-photo' AND state<>'finalized'")).rows[0];assert(pending);
 await assert.rejects(rolled(q=>q.query('UPDATE asset_upload_intents SET target_distribution_product_id=$1 WHERE intent_id=$2',[randomUUID(),pending.intent_id])),sql('23514'));
 const constraints=(await f.h.pool.query("SELECT conname,pg_get_expr(conbin,conrelid) expr FROM pg_constraint WHERE conrelid='asset_upload_intents'::regclass AND conname IN ('upload_profile_shape','tenant_upload_identity','asset_upload_intents_expected_version_check')")).rows;
 for(const {conname,expr} of constraints){
  const valid=async(row:Record<string,unknown>)=>(await f.h.pool.query(`SELECT (${expr}) AS valid FROM jsonb_populate_record(NULL::asset_upload_intents,$1::jsonb)`,[JSON.stringify(row)])).rows[0].valid;
  assert.equal(await valid(intent),true,conname);
  if(conname==='upload_profile_shape')for(const patch of [{target_distribution_product_id:null},{target_product_id:copy.product_id},{target_material_id:copy.source_material_id},{display_name:'x'},{source_content_type:'image/png'},{source_byte_size:'1048577'},{reserved_bytes:'1'},{purpose:'storefront.supply-material'}])assert.equal(await valid({...intent,...patch}),false,JSON.stringify(patch));
  const source=(await f.h.pool.query("SELECT * FROM asset_upload_intents WHERE target_kind='storefront.supply-material' LIMIT 1")).rows[0];assert.equal(await valid(source),true);
  if(conname!=='asset_upload_intents_expected_version_check')assert.equal(await valid({...source,target_distribution_product_id:copy.product_id}),false);
  if(conname==='asset_upload_intents_expected_version_check')assert.equal(await valid({...source,expected_version:'0'}),false);
 }
 assert.equal(intent.target_tenant_id,b.tenantId);
});

test('DP-SQL-04 tenant RLS hides seller rows from supplier and another seller, including writes',async()=>{
 const {a,b,copy}=await used(),c=await f.openStore();
 for(const store of [a,c]){const actor=await authenticate(f.runtime,store.owner.cookie.split('=')[1]);await withTenantRead(f.runtime,{actor,tenantId:store.tenantId,capabilitiesForRole:storeCapabilities},async(q)=>{
  for(const table of ['commerce_distribution_photo_copies','commerce_distribution_photo_targets']){
   assert.equal((await q.query(`SELECT * FROM ${table} WHERE tenant_id=$1`,[b.tenantId])).rowCount,0);
   assert.equal((await q.query(`UPDATE ${table} SET tenant_id=tenant_id WHERE tenant_id=$1`,[b.tenantId])).rowCount,0);
   assert.equal((await q.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[b.tenantId])).rowCount,0);
  }
 });}
 const actor=await authenticate(f.runtime,b.owner.cookie.split('=')[1]);await withTenantRead(f.runtime,{actor,tenantId:b.tenantId,capabilitiesForRole:storeCapabilities},async q=>{assert.equal((await q.query('SELECT * FROM commerce_distribution_photo_copies WHERE asset_id=$1',[copy.asset_id])).rowCount,1);});
});

test('DP-SQL-05 fenced references are refused and both new tables install the fence guard',async()=>{
 const {b,copy}=await used();await assert.rejects(rolled(q=>q.query('UPDATE assets SET deletion_fence=1 WHERE asset_id=$1',[copy.asset_id])),sql('23514'));
 const guards=(await f.h.pool.query("SELECT tgrelid::regclass::text AS name FROM pg_trigger WHERE tgname='reject_fenced_asset_reference' AND tgrelid IN ('commerce_distribution_photo_targets'::regclass,'commerce_distribution_photo_copies'::regclass) ORDER BY name")).rows;
 assert.deepEqual(guards.map(r=>r.name),['commerce_distribution_photo_copies','commerce_distribution_photo_targets']);
 const actor=await authenticate(f.runtime,b.owner.cookie.split('=')[1]);const context=await withMemberScope(f.runtime,{actor,scope:'personal'},async()=>{},async(_q,context)=>context);
 const fenced=randomUUID(),representation=randomUUID();await f.h.pool.query(`INSERT INTO assets(asset_id,scope_id,owner_principal_id,owner_user_id,policy_revision,representation_id,created_at) VALUES($1,$2,$3,$4,'synthetic-fence',$5,clock_timestamp()-interval '1 hour')`,[fenced,context.scope.scope_id,context.subject_principal.principal_id,actor.user_id,representation]);
 await f.h.pool.query(`UPDATE asset_maintenance_policy SET enabled=true,revision='synthetic-fence',orphan_retention_seconds=1,retired_retention_seconds=1,delete_lease_seconds=30,capture_seconds=30,pin_seconds=30,max_capture_objects=100`);
 await createAssetMaintenance(f.h.pool,{store:f.store,enabled:true}).claimDelete(fenced);
 const refused=(e:unknown)=>(e as {code:string}).code==='23514'&&/permanently fenced/.test((e as Error).message);
 await assert.rejects(rolled(q=>q.query(`UPDATE commerce_distribution_photo_targets SET asset_id=$1,representation_id=$2,policy_revision='synthetic-fence',aggregate_version=aggregate_version+1 WHERE product_id=$3`,[fenced,representation,copy.product_id])),refused);
 await assert.rejects(rolled(q=>q.query(`INSERT INTO commerce_distribution_photo_copies(asset_id,tenant_id,instance_id,product_id,scope_id,representation_id,policy_revision,source_material_id,source_version_id,source_content_sha256,source_version_no,source_title,copied_by_principal_id) VALUES($1,$2,$3,$4,$5,$6,'synthetic-fence',$7,$8,$9,1,'Synthetic',$10)`,[fenced,copy.tenant_id,copy.instance_id,copy.product_id,copy.scope_id,representation,copy.source_material_id,copy.source_version_id,copy.source_content_sha256,copy.copied_by_principal_id])),refused);

});
