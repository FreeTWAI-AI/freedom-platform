import assert from 'node:assert/strict';
import {after,before,beforeEach,test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {createSupplyMaterialLifecycle} from '../../modules/assets/supply-material.js';
import {createHostedStorePhotoHarness,photoSourcePng,type HostedStorePhotoHarness} from '../helpers/hosted-store-photo.js';
import type {Session} from './module-registry-harness.js';
import {DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {partnerMaterialPath} from '../../modules/agent-commerce/supplier-console/ui/partner/partner-materials.js';
import sharp from 'sharp';
import {privatePhotoView} from '../../modules/agent-commerce/hosted/photo-projection.js';
import {projectPrivateProductMedia} from '../../modules/agent-commerce/hosted/media.js';
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
async function publish(b:Store,target=app){const view=f.ok(await call(b,'',b.owner,target));f.ok(await f.h.call('POST',b.root+'/publish',b.owner,{}, {'Idempotency-Key':randomUUID(),'If-Match':`"${view.version}"`},target));return (await f.h.pool.query('SELECT * FROM commerce_storefront_publications WHERE instance_id=$1 ORDER BY revision DESC LIMIT 1',[b.instanceId])).rows[0];}
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

test('DP-01 seller-owned ready Asset, append-only provenance, capacity and private bytes',async()=>{
 const {a,b,o,m}=await journey(),aUsed=await usage(a),bUsed=await usage(b);const ack=f.ok(await use(b,o,m));assert.equal(ack.version,'1');assert.equal(ack.current.state,'in_use');assert.equal((await use(b,o,m,'0')).status,412);
 const copy=(await f.h.pool.query('SELECT c.*,a.tenant_ref,a.state,a.purpose,o.profile_id,o.transform_version FROM commerce_distribution_photo_copies c JOIN assets a USING(asset_id) JOIN asset_objects o USING(asset_id)')).rows[0];
 assert.equal(copy.tenant_id,b.tenantId);assert.equal(copy.instance_id,b.instanceId);assert.equal(copy.tenant_ref,b.tenantId);assert.equal(copy.state,'ready');assert.equal(copy.purpose,'storefront.product-photo');assert.equal(copy.profile_id,'storefront.product-photo');assert.equal(copy.transform_version,'storefront.product-photo.webp.v1');assert.equal(copy.source_version_id,m.version_id);assert.notEqual(copy.scope_id,(await row(m)).scope_id);assert.equal(copy.source_content_sha256,(await row(m)).content_sha256);
 assert.equal(await usage(a),aUsed);assert(BigInt(await usage(b))>BigInt(bUsed));
 const r=await app.request(f.h.origin+ack.current.photo.read_path,{headers:{Cookie:b.owner.cookie}});assert.equal(r.status,200);assert.equal(r.headers.get('Cache-Control'),'private, no-store');assert.equal(r.headers.get('Vary'),'Cookie');assert.equal(r.headers.get('Content-Disposition'),'inline');assert.match(r.headers.get('ETag')!,/^"[A-Za-z0-9_-]+"$/);assert((await r.arrayBuffer()).byteLength>0);
 const head=await app.request(f.h.origin+ack.current.photo.read_path,{method:'HEAD',headers:{Cookie:b.owner.cookie}});assert.equal(head.status,200);assert.deepEqual([...head.headers],[...r.headers]);assert.equal(await head.text(),'');
 const json=JSON.stringify(ack);assert(!json.includes(a.tenantId));assert(!json.includes(a.instanceId));assert(!json.includes(copy.asset_id));
});

test('DP-02 AT-27 publication references and public route serve the seller copy',async()=>{
 const {b,o,m}=await journey();f.ok(await use(b,o,m));const pub=await publish(b),ref=(await f.h.pool.query('SELECT * FROM commerce_publication_photo_refs WHERE publication_id=$1',[pub.publication_id])).rows[0];
 const copy=(await f.h.pool.query('SELECT * FROM commerce_distribution_photo_copies')).rows[0];assert.equal(ref.asset_id,copy.asset_id);assert.equal(ref.tenant_id,b.tenantId);const r=await publicPhoto(b,o,pub.revision);assert.equal(r.status,200);assert((await r.arrayBuffer()).byteLength>0);
});

test('DP-03 AT-27 SC-R29 supplier update preserves snapshot until explicit recopy and publish',async()=>{
 const {a,b,o,m}=await journey();const first=f.ok(await use(b,o,m)),pub=await publish(b);const bytes=Buffer.from(await (await publicPhoto(b,o,pub.revision)).arrayBuffer());const v1=m.version_id;await upload(a,m,await sharp({create:{width:2,height:2,channels:3,background:'#ab2233'}}).png().toBuffer());
 assert.equal((await photo(b,o.product_id)).state,'update_available');assert.deepEqual(Buffer.from(await (await publicPhoto(b,o,pub.revision)).arrayBuffer()),bytes);
 const again=await publish(b);assert.deepEqual(Buffer.from(await (await publicPhoto(b,o,again.revision)).arrayBuffer()),bytes);
 const second=f.ok(await use(b,o,m,first.version));assert.equal(second.version,'2');assert.equal(second.current.state,'in_use');assert.deepEqual(Buffer.from(await (await publicPhoto(b,o,again.revision)).arrayBuffer()),bytes);const latest=await publish(b);const updated=await publicPhoto(b,o,latest.revision);assert.equal(updated.status,200);assert.notDeepEqual(Buffer.from(await updated.arrayBuffer()),bytes);
 assert.deepEqual((await f.h.pool.query('SELECT source_version_id FROM commerce_distribution_photo_copies ORDER BY copied_at')).rows.map(r=>r.source_version_id),[v1,m.version_id]);
});

for(const reason of ['withdraw','revoke','partners','cooperation'] as const)test(`DP-04 ${reason}: current snapshot remains, next publish removes photo`,async()=>{
 const {a,b,o,l,m}=await journey();f.ok(await use(b,o,m));const pub=await publish(b),bytes=Buffer.from(await (await publicPhoto(b,o,pub.revision)).arrayBuffer());
 if(reason==='withdraw')await mutation(a,m,'/withdraw');else if(reason==='revoke')await revoke(a,m,b);else if(reason==='partners')await mutation(a,m,'/access',{access:'partners'});else await decide(a,l,'revoked');
 assert.equal((await photo(b,o.product_id)).state,'source_unavailable');assert.deepEqual(Buffer.from(await (await publicPhoto(b,o,pub.revision)).arrayBuffer()),bytes);
 const refused=await use(b,o,m,'1');assert.equal(refused.status,reason==='partners'?409:404);const next=await publish(b);assert.equal((await publicPhoto(b,o,next.revision)).status,404);const stopped=f.ok(await detach(b,o,'1'));assert.equal(stopped.current.state,'none');assert.equal(stopped.version,'2');
});

test('DP-05 exact conflicts, invisible ids, permissions and anonymous private cache',async()=>{
 const {a,b,o,m}=await journey();
 for(const kind of ['video','copy'] as const){const other=await material(a,kind);await grant(a,other,b);await mutation(a,other,'/access',{access:'public_use',confirm_public_use:true});const r=await use(b,o,other);assert.equal(r.status,409);assert.equal(r.data.code,'material_not_image');assert.equal(r.data.detail,'只有圖片素材可以用在公開店面。');}
 await mutation(a,m,'/access',{access:'partners'});const privateUse=await use(b,o,m);assert.equal(privateUse.status,409);assert.equal(privateUse.data.code,'material_not_public');assert.equal(privateUse.data.detail,'供應商尚未同意把這個素材用在公開店面。');
 await mutation(a,m,'/access',{access:'public_use',confirm_public_use:true});const old={...m};await upload(a,m);const changed=await use(b,o,old);assert.equal(changed.status,409);assert.equal(changed.data.code,'material_version_changed');
 const otherOffer=await offer(a),other=await material(a,'image',otherOffer.product_id);await propose(b,otherOffer);await grant(a,other,b);await mutation(a,other,'/access',{access:'public_use',confirm_public_use:true});assert.equal((await use(b,o,other)).status,404);
 const c=await f.openStore();let selection=await propose(c,o);await decide(a,selection,'accepted');const hidden=await use(c,o,m),random=await use(c,o,{...m,material_id:randomUUID()});assert.equal(hidden.status,404);assert.deepEqual(hidden.data,random.data);
 const person=(await f.h.person('合成照片檢視者')).session,principal=await f.h.candidate(b.owner,person.user.user_id);
 const invitation=f.ok(await f.post(`/tenants/${b.tenantId}/invitations`,b.owner,{invitee_principal_id:principal,role:'viewer',instance_capabilities:[{instance_id:b.instanceId,capabilities:['store:read']}],expires_at:new Date(Date.now()+86400000).toISOString()}),201);f.ok(await f.post(`/tenants/${b.tenantId}/invitations/${invitation.invitation_id}/accept`,person,{},invitation.version));assert.equal((await use(b,o,m,'0',randomUUID(),app,person)).status,403);
 const anonymous=await app.request(f.h.origin+'/api/v1'+b.root+`/distribution-photos/${o.product_id}/photo/1`);assert.equal(anonymous.status,401);assert.equal(anonymous.headers.get('Cache-Control'),'private, no-store');assert.equal(anonymous.headers.get('Vary'),'Cookie');
 const noHeader=await f.h.call('POST',b.root+`/distribution-photos/${o.product_id}/use`,b.owner,{material_id:m.material_id,version_id:m.version_id},{'Idempotency-Key':randomUUID()},app);assert.equal(noHeader.status,428);
});

test('DP-06 committed receipt and stored-intent resume preserve one Asset and original key/body',async()=>{
 const {a,b,o,m}=await journey(),key=randomUUID();let fail=true;const put=f.store.putImmutable.bind(f.store);
 f.store.putImmutable=async(...args)=>{const result=await put(...args);if(fail){fail=false;await f.h.pool.query("UPDATE domain_media_storage_policy SET persistence_allowed=false WHERE purpose='storefront.product-photo'");}return result;};
 const interrupted=await use(b,o,m,'0',key);assert.equal(interrupted.status,503);
 assert.equal((await f.h.pool.query("SELECT count(*)::int n FROM assets WHERE tenant_ref=$1 AND purpose='storefront.product-photo'",[b.tenantId])).rows[0].n,1);
 await f.h.pool.query("UPDATE domain_media_storage_policy SET persistence_allowed=true WHERE purpose='storefront.product-photo'");
 const first=f.ok(await use(b,o,m,'0',key));assert.deepEqual(f.ok(await use(b,o,m,'0',key,application({distributionPhotosEnabled:true,storePhotoUploadsEnabled:false}))),first);const other=await material(a);await grant(a,other,b);await mutation(a,other,'/access',{access:'public_use',confirm_public_use:true});assert.equal((await use(b,o,other,'0',key)).status,409);
 assert.equal((await f.h.pool.query('SELECT count(*)::int n FROM commerce_distribution_photo_copies')).rows[0].n,1);
 assert.equal((await f.h.pool.query("SELECT count(*)::int n FROM assets WHERE tenant_ref=$1 AND purpose='storefront.product-photo'",[b.tenantId])).rows[0].n,1);f.store.putImmutable=put;
});

test('DP-07 seller capacity refusal leaves pointer and supplier usage unchanged',async()=>{
 const {a,b,o,m}=await journey(),used=await usage(a);await f.h.pool.query("UPDATE tenant_capacity_policies SET max_retained_bytes=1 WHERE status='active'");const r=await use(b,o,m);assert.equal(r.status,429);assert.equal(r.data.code,'quota_exceeded');assert.equal((await photo(b,o.product_id)).state,'none');assert.equal(await usage(a),used);
 await f.h.pool.query("UPDATE tenant_capacity_policies SET max_retained_bytes=104857600 WHERE status='active'");f.ok(await use(b,o,m));
 await f.h.pool.query("UPDATE domain_media_storage_policy SET retained_byte_limit=1048576 WHERE purpose='storefront.product-photo'");const retained=await use(b,o,m,'1');assert.equal(retained.status,409);assert.equal(retained.data.code,'asset_retained_quota');assert.equal((await photo(b,o.product_id)).version,'1');assert.equal(await usage(a),used);
});

test('DP-08 source grant revoked during object read refuses before creating a seller copy',async()=>{
 const {a,b,o,m}=await journey();f.store.afterGet=async()=>{f.store.afterGet=undefined;await revoke(a,m,b);};assert.equal((await use(b,o,m)).status,404);assert.equal((await photo(b,o.product_id)).state,'none');assert.equal((await f.h.pool.query('SELECT count(*)::int n FROM commerce_distribution_photo_copies')).rows[0].n,0);
});

test('DP-09 detach increments only pointer and retains counted copy',async()=>{
 const {b,o,m}=await journey();f.ok(await use(b,o,m));const used=await usage(b),ack=f.ok(await detach(b,o,'1'));assert.equal(ack.version,'2');assert.equal(ack.current.photo,null);assert.equal(await usage(b),used);const pub=await publish(b);assert.equal((await publicPhoto(b,o,pub.revision)).status,404);assert.equal((await f.h.pool.query('SELECT count(*)::int n FROM commerce_distribution_photo_copies')).rows[0].n,1);
});

test('DP-10 flag off hides commands while existing usable pointers still publish',async()=>{
 const {b,o,m}=await journey();f.ok(await use(b,o,m));const off=application({distributionPhotosEnabled:false});assert.equal((await call(b,'/distribution-photos',b.owner,off)).status,404);const site=f.ok(await f.h.call('GET','/site',undefined,undefined,{},off));assert.equal(site.distribution_photos_enabled,false);const pub=await publish(b,off);assert.equal((await publicPhoto(b,o,pub.revision)).status,200);
});

test('DP-11 use/detach never bump supplier consent CAS',async()=>{
 const {a,b,o,l,m}=await journey();const before=(await f.h.pool.query('SELECT aggregate_version::text v FROM commerce_selections WHERE selection_id=$1',[l.selection_id])).rows[0].v;f.ok(await use(b,o,m));f.ok(await detach(b,o,'1'));assert.equal((await f.h.pool.query('SELECT aggregate_version::text v FROM commerce_selections WHERE selection_id=$1',[l.selection_id])).rows[0].v,before);await decide(a,l,'revoked');
});

test('DP-12 own product media JSON, preview and publish remain unchanged',async()=>{
 const b=await f.openStore();
 const upload=await app.request(f.h.origin+'/api/v1'+b.root+`/products/${b.productId}/photo`,{method:'POST',headers:{Origin:f.h.origin,Cookie:b.owner.cookie,'X-CSRF-Token':b.owner.csrf,'Content-Type':'image/png','Idempotency-Key':randomUUID(),'If-Match':'"1"'},body:new Uint8Array(photoSourcePng)});assert.equal(upload.status,200);
 const before=JSON.stringify(f.ok(await call(b,'/product-media')));const preview=JSON.stringify(f.ok(await call(b,'/preview')).projection.products);await list(b);assert.equal(JSON.stringify(f.ok(await call(b,'/product-media'))),before);assert.equal(JSON.stringify(f.ok(await call(b,'/preview')).projection.products),preview);
 const meta=JSON.parse(before).items[0],ref=(await f.h.pool.query('SELECT o.* FROM commerce_product_photo_targets t JOIN asset_objects o USING(asset_id) WHERE t.product_id=$1',[b.productId])).rows[0];
 const product=f.ok(await call(b,'/products')).items[0];const photoRef={sku:product.sku,asset_id:ref.asset_id,representation_id:ref.representation_id,sha256:ref.content_sha256,purpose:'storefront.product-photo' as const,transform_version:'storefront.product-photo.webp.v1' as const,content_type:'image/webp' as const,byte_size:Number(ref.byte_size),width:ref.pixel_width,height:ref.pixel_height};
 const own=privatePhotoView({tenant_id:b.tenantId,instance_id:b.instanceId},{product,photo:{ref:photoRef,scopeId:ref.scope_id,policyRevision:ref.policy_revision}});
 assert.equal(JSON.stringify(own),JSON.stringify(projectPrivateProductMedia({tenant_id:b.tenantId,instance_id:b.instanceId,product_id:b.productId,version:product.version},{content_type:'image/webp',byte_size:Number(ref.byte_size),width:ref.pixel_width,height:ref.pixel_height})));assert.equal(JSON.stringify(own),JSON.stringify(meta));
 const html=await call(b,'/preview-page');assert.equal(html.status,200);assert((await html.response.text()).includes(meta.photo.read_path));await publish(b);
});

test('DP-08 finalize rechecks a grant revoked after seller object write',async()=>{
 const {a,b,o,m}=await journey();const put=f.store.putImmutable.bind(f.store);let once=true;
 f.store.putImmutable=async(...args)=>{const result=await put(...args);if(once){once=false;await revoke(a,m,b);}return result;};
 try{assert.equal((await use(b,o,m)).status,404);assert.equal((await photo(b,o.product_id)).state,'none');assert.equal((await f.h.pool.query('SELECT count(*)::int n FROM commerce_distribution_photo_copies')).rows[0].n,0);}finally{f.store.putImmutable=put;}
});

test('DP-05 upload admission, lifecycle, policy and source content fail with exact reasons',async()=>{
 const {b,o,m}=await journey();
 for(const target of [application({distributionPhotosEnabled:true,storePhotoUploadsEnabled:false}),application({distributionPhotosEnabled:true,storePhotoAssets:undefined})]){
  const r=await use(b,o,m,'0',randomUUID(),target);assert.equal(r.status,503);assert.equal(r.data.code,'distribution_photo_unavailable');assert.equal(r.data.detail,'目前無法把素材用在公開店面。');
 }
 f.store.failNext('get');const unreadable=await use(b,o,m);assert.equal(unreadable.status,503);assert.equal(unreadable.data.code,'material_content_unavailable');assert.equal(unreadable.data.detail,'素材檔案暫時無法讀取。');
 const get=f.store.get.bind(f.store);f.store.get=async(...args)=>{const value=await get(...args);return value?{...value,metadata:{...value.metadata,byteSize:value.metadata.byteSize+1}}:value;};
 try{const mismatch=await use(b,o,m);assert.equal(mismatch.status,503);assert.equal(mismatch.data.code,'material_content_unavailable');}finally{f.store.get=get;}
 await f.h.pool.query("UPDATE domain_media_storage_policy SET persistence_allowed=false WHERE purpose='storefront.product-photo'");const disabled=await use(b,o,m);assert.equal(disabled.status,503);assert.equal(disabled.data.code,'distribution_photo_unavailable');assert.equal(disabled.data.detail,'目前無法把素材用在公開店面。');
 assert.equal((await photo(b,o.product_id)).state,'none');
});

test('DP-13 flag off keeps published snapshots and drops an invalid source at the next publish',async()=>{
 const {a,b,o,m}=await journey();
 const validOffer=await offer(a),selection=await propose(b,validOffer);await decide(a,selection,'accepted');
 const validMaterial=await material(a,'image',validOffer.product_id);await grant(a,validMaterial,b);
 await mutation(a,validMaterial,'/access',{access:'public_use',confirm_public_use:true});
 f.ok(await use(b,o,m));f.ok(await use(b,validOffer,validMaterial));
 const first=await publish(b),initial=await publicPhoto(b,o,first.revision);
 assert.equal(initial.status,200);const bytes=Buffer.from(await initial.arrayBuffer());
 const validInitial=await publicPhoto(b,validOffer,first.revision);assert.equal(validInitial.status,200);
 const validBytes=Buffer.from(await validInitial.arrayBuffer());
 const copies=(await f.h.pool.query('SELECT asset_id FROM commerce_distribution_photo_copies WHERE tenant_id=$1 ORDER BY asset_id',[b.tenantId])).rows;
 assert.equal(copies.length,2);const used=await usage(b);
 const off=application({distributionPhotosEnabled:false});
 const offPhoto=async(product:any,revision:string)=>{
  const slug=(await f.h.pool.query('SELECT slug FROM commerce_storefront_profiles WHERE instance_id=$1',[b.instanceId])).rows[0].slug;
  const sku=(await f.h.pool.query('SELECT hosted_sku FROM commerce_selections WHERE shop_id=$1 AND item_id=$2',[await shop(b),product.product_id])).rows[0].hosted_sku;
  return off.request(f.h.origin+`/shops/${slug}/media/${revision}/${sku}`);
 };
 const retained=await offPhoto(o,first.revision);assert.equal(retained.status,200);assert.deepEqual(Buffer.from(await retained.arrayBuffer()),bytes);
 await revoke(a,m,b);
 const afterRevoke=await offPhoto(o,first.revision);assert.equal(afterRevoke.status,200);assert.deepEqual(Buffer.from(await afterRevoke.arrayBuffer()),bytes);
 const next=await publish(b,off);assert.notEqual(next.publication_id,first.publication_id);
 assert.equal((await offPhoto(o,next.revision)).status,404);
 const carried=await offPhoto(validOffer,next.revision);assert.equal(carried.status,200);assert.deepEqual(Buffer.from(await carried.arrayBuffer()),validBytes);
 const refs=(await f.h.pool.query('SELECT asset_id FROM commerce_publication_photo_refs WHERE publication_id=$1',[next.publication_id])).rows;
 const validCopy=(await f.h.pool.query('SELECT asset_id FROM commerce_distribution_photo_copies WHERE tenant_id=$1 AND product_id=$2',[b.tenantId,validOffer.product_id])).rows;
 assert.deepEqual(refs,validCopy);
 assert.deepEqual((await f.h.pool.query('SELECT asset_id FROM commerce_distribution_photo_copies WHERE tenant_id=$1 ORDER BY asset_id',[b.tenantId])).rows,copies);
 assert.equal(await usage(b),used);
});

test('DP-14 the saved-draft preview shows a partner photo to the owner',async()=>{
 const {a,b,o,m}=await journey();
 const upload=await app.request(f.h.origin+'/api/v1'+b.root+`/products/${b.productId}/photo`,{method:'POST',headers:{Origin:f.h.origin,Cookie:b.owner.cookie,'X-CSRF-Token':b.owner.csrf,'Content-Type':'image/png','Idempotency-Key':randomUUID(),'If-Match':'"1"'},body:new Uint8Array(photoSourcePng)});
 assert.equal(upload.status,200);
 const own=f.ok(await call(b,'/product-media')).items.find((item:any)=>item.product_id===b.productId).photo.read_path;
 assert.match(own,new RegExp(`/products/${b.productId}/photo/`));
 const ack=f.ok(await use(b,o,m)),partner=ack.current.photo.read_path;
 assert.equal(partner,`/api/v1${b.root}/distribution-photos/${o.product_id}/photo/${ack.version}`);
 const preview=await call(b,'/preview-page');assert.equal(preview.status,200);assert.match(preview.response.headers.get('Content-Type')!,/^text\/html/);
 const html=await preview.response.text();assert(html.includes(`src="${partner}"`));assert(html.includes(`src="${own}"`));
 const {storeHtml}=await import('../../modules/agent-commerce/hosted/page.js'),draft=f.ok(await call(b,'/preview')).projection;
 const sku=(await f.h.pool.query('SELECT hosted_sku FROM commerce_selections WHERE shop_id=$1 AND item_id=$2',[await shop(b),o.product_id])).rows[0].hosted_sku;
 assert.throws(()=>storeHtml(draft,'catalog-grid-v1',[{sku,photo:ack.current.photo}],{publicOrigin:f.h.origin}),/storefront_public_photo_required/);
 const copy=(await f.h.pool.query('SELECT o.content_sha256,o.byte_size FROM commerce_distribution_photo_copies c JOIN asset_objects o USING(asset_id) WHERE c.tenant_id=$1 AND c.product_id=$2',[b.tenantId,o.product_id])).rows[0];
 const read=await app.request(f.h.origin+partner,{headers:{Cookie:b.owner.cookie}});assert.equal(read.status,200);
 const bytes=Buffer.from(await read.arrayBuffer()),{createHash}=await import('node:crypto');
 assert.equal(bytes.byteLength,Number(copy.byte_size));assert.equal(createHash('sha256').update(bytes).digest('hex'),copy.content_sha256);
 assert.equal((await app.request(f.h.origin+partner)).status,401);
 assert.equal((await app.request(f.h.origin+partner,{headers:{Cookie:a.owner.cookie}})).status,404);
 assert.equal((await app.request(f.h.origin+own,{headers:{Cookie:b.owner.cookie}})).status,200);
 const off=application({distributionPhotosEnabled:false}),offPreview=await call(b,'/preview-page',b.owner,off);
 assert.equal(offPreview.status,200);assert.match(offPreview.response.headers.get('Content-Type')!,/^text\/html/);
 const offHtml=await offPreview.response.text();assert(offHtml.includes(`src="${partner}"`));assert(offHtml.includes(`src="${own}"`));
 assert.equal((await off.request(f.h.origin+partner,{headers:{Cookie:b.owner.cookie}})).status,404);
 assert.equal((await off.request(f.h.origin+own,{headers:{Cookie:b.owner.cookie}})).status,200);
});
