import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import sharp from 'sharp';
import {createApp} from '../../../apps/platform-api/src/app.js';
import {ProductViewSchema,StoreViewSchema} from '../../../contracts/guild-launchpad/v1/storefront.js';
import {ProductMediaCommandSchema,PublicStoreMediaSchema} from '../../../contracts/guild-launchpad/v1/hosted-store-media.js';
import {createStorefrontProductPhotoLifecycle} from '../../../modules/assets/storefront-product-photo.js';
import {readVerifiedObject,type ObjectStore,type AssetObjectKey,type ObjectMetadata} from '../../../packages/asset-storage/index.js';
import {TENANT_CURSOR_TEST_KEY} from '../../runtime/tenant-cursor-fixture.js';
import {memberHeaders,origin,restoreMember,type RestoreMember} from './media-restore-fixtures.js';

/** Reuses the restore drill's canonical restricted role and native R2 ports.
 * No schema, role, fake store, provider or production policy is installed here. */
export function storefrontPhotoApp(runtime:Pool,store:ObjectStore,reader=true,uploads=false){
  return createApp(runtime,origin,'local',{guildLaunchpadEnabled:true,tenantCursorSigningKey:TENANT_CURSOR_TEST_KEY,
    ...(reader?{storePhotoAssetStore:store}:{}),
    ...(reader&&uploads?{storePhotoAssets:createStorefrontProductPhotoLifecycle(runtime,{store}),storePhotoUploadsEnabled:true}:{}),
    linkPreviewFetch:async()=>{throw Error('photo_restore_must_not_fetch_outbound');}});
}
type App=ReturnType<typeof storefrontPhotoApp>;
async function json(app:App,path:string,member:RestoreMember,body?:unknown,version?:string,status=200){
  const response=await app.request(origin+path,{method:body===undefined?'GET':'POST',headers:{...memberHeaders(member),
    ...(body===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':randomUUID()}),
    ...(version===undefined?{}:{'If-Match':`"${version}"`})},body:body===undefined?undefined:JSON.stringify(body)});
  assert.equal(response.status,status,await response.clone().text());return await response.json() as Record<string,any>;
}
export async function publishRestoredPhotos(app:App,root:string,member:RestoreMember){
  const view=StoreViewSchema.parse(await json(app,root,member));
  assert(view.version,'The fixture store must be set up before publishing.');
  await json(app,root+'/publish',member,{},view.version);
}
async function publicMedia(app:App,slug:string){
  const response=await app.request(origin+'/api/v1/public/stores/'+slug+'/media');
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  return PublicStoreMediaSchema.parse(await response.json());
}

/** Full retained rows, including the removed product's routing and old refs.
 * These queries run only on the drill's owner pool; application reads use HTTP. */
export async function storefrontPhotoSnapshot(pool:Pool,tenantId:string,instanceId:string){
  const profile='SELECT supply_shop_id,storefront_shop_id FROM commerce_storefront_profiles WHERE tenant_id=$1 AND instance_id=$2';
  const intents='SELECT asset_id FROM asset_upload_intents WHERE target_tenant_id=$1 AND target_instance_id=$2';
  const queries={
    profiles:'SELECT to_jsonb(t) value FROM commerce_storefront_profiles t WHERE tenant_id=$1 AND instance_id=$2',
    publications:'SELECT to_jsonb(t) value FROM commerce_storefront_publications t WHERE tenant_id=$1 AND instance_id=$2',
    refs:'SELECT to_jsonb(t) value FROM commerce_publication_photo_refs t WHERE tenant_id=$1 AND instance_id=$2',
    targets:'SELECT to_jsonb(t) value FROM commerce_product_photo_targets t WHERE tenant_id=$1 AND instance_id=$2',
    items:`SELECT to_jsonb(t) value FROM commerce_items t WHERE shop_id IN (SELECT supply_shop_id FROM (${profile}) p)`,
    selections:`SELECT to_jsonb(t) value FROM commerce_selections t WHERE shop_id IN (SELECT storefront_shop_id FROM (${profile}) p)`,
    shops:`SELECT to_jsonb(t) value FROM commerce_shops t WHERE shop_id IN (SELECT supply_shop_id FROM (${profile}) p UNION SELECT storefront_shop_id FROM (${profile}) p)`,
    mappings:'SELECT to_jsonb(t) value FROM commerce_resource_tenants t WHERE tenant_id=$1 AND instance_id=$2',
    assets:`SELECT to_jsonb(t) value FROM assets t WHERE asset_id IN (${intents})`,
    objects:`SELECT to_jsonb(t) value FROM asset_objects t WHERE asset_id IN (${intents})`,
    intents:'SELECT to_jsonb(t) value FROM asset_upload_intents t WHERE target_tenant_id=$1 AND target_instance_id=$2',
    effects:`SELECT to_jsonb(t) value FROM asset_object_write_effects t WHERE asset_id IN (${intents})`,
  };
  const result:Record<string,Record<string,any>[]>= {};
  for(const [name,sql] of Object.entries(queries))result[name]=(await pool.query(sql+' ORDER BY to_jsonb(t)::text',[tenantId,instanceId])).rows.map(r=>r.value);
  return result;
}
interface CapturedPhoto {assetId:string;key:AssetObjectKey;metadata:ObjectMetadata;bytes:Buffer;privatePath:string}

export async function storefrontPhotoFixtures(owner:Pool,runtime:Pool,store:ObjectStore){
  const community=randomUUID();await owner.query('INSERT INTO communities VALUES($1,$2)',[community,'Synthetic photo restore']);
  const member=await restoreMember(owner,community),other=await restoreMember(owner,community);
  await owner.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier)
    VALUES($1,$2,$3,'guild_commerce_sales','active','full')`,[randomUUID(),community,member.actor.user_id]);
  // Fixture-only operator setup; never relax the application's canonical grants.
  await owner.query(`INSERT INTO tenant_capacity_policies(policy_id,revision,tenant_id,plan_ref,max_active_instances,max_instances_per_module,
    max_concurrent_provisions,max_work_items,max_retained_bytes,max_concurrent_jobs,max_model_budget,status)
    SELECT $1,1,NULL,'synthetic-photo-restore',10,3,2,1000,104857600,4,NULL,'active'
    WHERE NOT EXISTS(SELECT 1 FROM tenant_capacity_policies WHERE tenant_id IS NULL AND status='active')`,[randomUUID()]);
  await owner.query(`INSERT INTO guild_application_offerings(offering_id,community_id,guild_key,application_key,release_ref,status,display_order,launch_policy_ref,version)
    VALUES($1,$2,'guild_commerce_sales','hosted-store','hosted-store@1.0.0','offered',10,'{"policy_key":"hosted-store.launch","version":"1"}',1)`,[randomUUID(),community]);
  await owner.query("UPDATE domain_media_storage_policy SET mode='r2_only',persistence_allowed=true,policy_revision='synthetic-photo-restore',retained_byte_limit=16777216 WHERE purpose='storefront.product-photo'");
  const app=storefrontPhotoApp(runtime,store,true,true);
  const made=await json(app,'/api/v1/tenants',member,{display_name:'Synthetic photo restore',workspace_name:'Photo restore'},undefined,201);
  const tenantId=made.tenant.tenant_id as string,workspaceId=made.workspace.workspace_id as string;
  const foreign=await json(app,'/api/v1/tenants',other,{display_name:'Other restore tenant'},undefined,201);
  assert.notEqual(foreign.tenant.tenant_id,tenantId);
  const planned=await json(app,`/api/v1/tenants/${tenantId}/application-launch-plans`,member,{
    guild_key:'guild_commerce_sales',workspace_id:workspaceId,application_key:'hosted-store',release_ref:'hosted-store@1.0.0',
    installation_choice:'create_new',dependencies:[],configuration:{}},undefined,201);
  const launch=await app.request(origin+`/api/v1/tenants/${tenantId}/application-installations`,{method:'POST',
    headers:{...memberHeaders(member),'Content-Type':'application/json','Idempotency-Key':randomUUID()},
    body:JSON.stringify({plan_id:planned.plan_id,expected_plan_version:planned.version,configuration_digest:planned.configuration_digest})});
  assert.ok([200,202].includes(launch.status),await launch.clone().text());assert.equal((await launch.json() as {state:string}).state,'succeeded');
  const instances=(await owner.query("SELECT instance_id FROM module_instances WHERE tenant_id=$1 AND module_key='storefront'",[tenantId])).rows;
  assert.equal(instances.length,1);const instanceId=instances[0].instance_id as string,root=`/api/v1/tenants/${tenantId}/storefronts/${instanceId}`,slug='restore-'+randomUUID().slice(0,8);
  await json(app,root+'/setup',member,{name:'Synthetic restore shop',slug,currency:'TWD'},undefined,201);
  const add=async(title:string)=>ProductViewSchema.parse(await json(app,root+'/products',member,{title,description:'Owned restore fixture',price_minor:1234,stock:5},undefined,201));
  const p1=await add('Retained replacement'),p2=await add('Removed live product');
  async function upload(productId:string,version:string,width:number,height:number,background:string):Promise<CapturedPhoto>{
    const png=await sharp({create:{width,height,channels:3,background}}).png().toBuffer();
    const response=await app.request(origin+root+'/products/'+productId+'/photo',{method:'POST',headers:{...memberHeaders(member),
      'Content-Type':'image/png','Idempotency-Key':randomUUID(),'If-Match':`"${version}"`},body:new Uint8Array(png)});
    assert.equal(response.status,200,await response.clone().text());const saved=ProductMediaCommandSchema.parse(await response.json());assert(saved.current.photo);
    assert.equal(saved.current.photo.width,width);assert.equal(saved.current.photo.height,height);
    const read=await app.request(origin+saved.current.photo.read_path,{headers:memberHeaders(member)});assert.equal(read.status,200);
    const bytes=Buffer.from(await read.arrayBuffer());
    const row=(await owner.query(`SELECT o.* FROM commerce_product_photo_targets t JOIN asset_objects o ON o.asset_id=t.asset_id
      WHERE t.tenant_id=$1 AND t.instance_id=$2 AND t.product_id=$3`,[tenantId,instanceId,productId])).rows[0];
    assert.equal(row.content_sha256,createHash('sha256').update(bytes).digest('hex'));
    assert.equal(row.pixel_width,width);assert.equal(row.pixel_height,height);assert.equal(row.profile_id,'storefront.product-photo');
    return {assetId:row.asset_id,key:row.object_key,bytes,privatePath:saved.current.photo.read_path,metadata:{contentType:row.content_type,
      byteSize:row.byte_size,sha256:row.content_sha256,transformVersion:row.transform_version,policyRevision:row.policy_revision,profileId:row.profile_id}};
  }
  const a=await upload(p1.product_id,'1',13,11,'red'),c=await upload(p2.product_id,'1',23,7,'green');
  await publishRestoredPhotos(app,root,member);const revision1=await publicMedia(app,slug);
  const b=await upload(p1.product_id,'2',17,19,'blue');
  await publishRestoredPhotos(app,root,member);const revision2=await publicMedia(app,slug);
  assert.equal(revision1.revision,'1');assert.equal(revision2.revision,'2');
  await json(app,root+'/products/'+p2.product_id+'/remove',member,{},'2');
  const snapshot=await storefrontPhotoSnapshot(owner,tenantId,instanceId);
  assert.equal(snapshot.assets.length,3);assert(snapshot.assets.every(row=>row.state==='ready'&&String(row.deletion_fence)==='0'));
  assert.equal(snapshot.objects.length,3);assert.equal(snapshot.intents.length,3);
  assert.equal(snapshot.items.length,1);assert.equal(snapshot.items[0].item_id,p1.product_id);assert.equal(snapshot.selections.length,1);
  assert.equal(snapshot.targets.length,2);assert.equal(snapshot.targets.find(row=>row.product_id===p1.product_id)?.asset_id,b.assetId);
  const removedTarget=snapshot.targets.find(row=>row.product_id===p2.product_id);assert(removedTarget);
  for(const field of ['asset_id','representation_id','policy_revision','linked_at_product_version'])assert.equal(removedTarget[field],null);
  assert.equal(snapshot.publications.length,2);assert.equal(snapshot.refs.length,4);
  assert.equal(snapshot.refs.filter(row=>row.asset_id===a.assetId).length,1);assert.equal(snapshot.refs.filter(row=>row.asset_id===b.assetId).length,1);
  assert.equal(snapshot.refs.filter(row=>row.asset_id===c.assetId).length,2);
  assert.equal(new Set([a.metadata.sha256,b.metadata.sha256,c.metadata.sha256]).size,3);
  return {member,other,tenantId,instanceId,root,slug,p1,p2,a,b,c,revision1,revision2,snapshot};
}
export type StorefrontPhotoFixture=Awaited<ReturnType<typeof storefrontPhotoFixtures>>;

/** Called only after the existing drill fences imported sessions and supplies fresh ones. */
export async function assertRestoredStorefrontPhotos(owner:Pool,runtime:Pool,store:ObjectStore,f:StorefrontPhotoFixture){
  const app=storefrontPhotoApp(runtime,store); // uploads OFF, compatible reads ON
  for(const photo of [f.a,f.b,f.c])assert.deepEqual(Buffer.from((await readVerifiedObject(store,photo.key,photo.metadata)).bytes),photo.bytes);
  async function read(path:string,bytes:Buffer,member?:RestoreMember){
    for(const method of ['GET','HEAD']){
      const response=await app.request(origin+path,{method,headers:member?memberHeaders(member):{}});
      assert.equal(response.status,200,await response.clone().text());assert.equal(response.headers.get('cache-control'),'no-store');
      assert.equal(response.headers.get('content-type'),'image/webp');assert.equal(response.headers.get('x-content-type-options'),'nosniff');
      assert.equal(response.headers.get('content-length'),String(bytes.length));
      assert.deepEqual(Buffer.from(await response.arrayBuffer()),method==='HEAD'?Buffer.alloc(0):bytes);
    }
  }
  await read(f.b.privatePath,f.b.bytes,f.member);
  const uploadOff=await app.request(origin+f.root+'/products/'+f.p1.product_id+'/photo',{method:'POST',
    headers:{...memberHeaders(f.member),'Content-Type':'image/webp','Idempotency-Key':randomUUID(),'If-Match':'"3"'},body:new Uint8Array(f.b.bytes)});
  assert.equal(uploadOff.status,503,'Uploads OFF must not prevent compatible reads or create a fourth object.');
  for(const path of [f.a.privatePath,f.c.privatePath])assert.equal((await app.request(origin+path,{headers:memberHeaders(f.member)})).status,404);
  assert.equal((await app.request(origin+f.b.privatePath,{headers:memberHeaders(f.other)})).status,404);
  assert.deepEqual(await publicMedia(app,f.slug),f.revision2);
  for(const photo of f.revision2.photos)await read(photo.photo.read_path,photo.sku===f.p1.sku?f.b.bytes:f.c.bytes);
  for(const photo of f.revision1.photos)assert.equal((await app.request(origin+photo.photo.read_path)).status,404);
  const disabled=storefrontPhotoApp(runtime,store,false);
  for(const path of [f.b.privatePath,...f.revision2.photos.map(p=>p.photo.read_path)])
    assert.equal((await disabled.request(origin+path,{headers:memberHeaders(f.member)})).status,404);
  await publishRestoredPhotos(app,f.root,f.member);
  const next=await publicMedia(app,f.slug);assert.equal(next.revision,'3');assert.deepEqual(next.photos.map(p=>p.sku),[f.p1.sku]);
  await read(next.photos[0].photo.read_path,f.b.bytes);
  for(const photo of f.revision2.photos)assert.equal((await app.request(origin+photo.photo.read_path)).status,404);
  const after=await storefrontPhotoSnapshot(owner,f.tenantId,f.instanceId);
  for(const row of f.snapshot.publications)assert.deepEqual(after.publications.find(p=>p.publication_id===row.publication_id),row);
  for(const row of f.snapshot.refs)assert.deepEqual(after.refs.find(p=>p.publication_id===row.publication_id&&p.sku===row.sku),row);
  assert.deepEqual(after.assets,f.snapshot.assets);assert.deepEqual(after.objects,f.snapshot.objects);
  assert.deepEqual(after.targets,f.snapshot.targets);assert.deepEqual(after.intents,f.snapshot.intents);assert.deepEqual(after.effects,f.snapshot.effects);
}
