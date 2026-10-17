// Migration 171 invariants exercised under the restricted runtime role.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {before,after,beforeEach,test} from 'node:test';
import type {PoolClient} from 'pg';
import {createHostedStorePhotoHarness,type HostedStorePhotoHarness} from '../helpers/hosted-store-photo.js';

let f:HostedStorePhotoHarness;
before(async()=>{f=await createHostedStorePhotoHarness();});
after(async()=>{await f?.stop();});
beforeEach(async()=>{await f.reset();});
type Store=Awaited<ReturnType<HostedStorePhotoHarness['openStore']>>;
const sql=(code:string)=>(e:unknown)=>{assert.equal((e as {code?:string}).code,code,String(e));return true;};
async function as<T>(tenantId:string,fn:(q:PoolClient)=>Promise<T>):Promise<T>{
 const q=await f.runtime.connect();
 try{await q.query('BEGIN');await q.query("SELECT set_config('freedom.tenant_id',$1,true)",[tenantId]);const r=await fn(q);await q.query('COMMIT');return r;}
 catch(e){await q.query('ROLLBACK').catch(()=>{});throw e;}finally{q.release();}
}
async function ids(s:Store){
 const p=(await f.h.pool.query('SELECT supply_shop_id,storefront_shop_id FROM commerce_storefront_profiles WHERE tenant_id=$1 AND instance_id=$2',[s.tenantId,s.instanceId])).rows[0];
 const scope=(await f.h.pool.query("SELECT scope_id FROM resource_scopes WHERE kind='tenant' AND tenant_ref=$1",[s.tenantId])).rows[0].scope_id as string;
 return {...p,scope} as {supply_shop_id:string;storefront_shop_id:string;scope:string};
}
async function material(s:Store,scope:string,kind='copy',productId:string|null=s.productId){
 const id=randomUUID();
 await as(s.tenantId,q=>q.query(`INSERT INTO supply_materials(material_id,tenant_id,instance_id,scope_id,kind,product_id,title,created_by_principal_id)
  VALUES($1,$2,$3,$4,$5,$6,'合成素材',$7)`,[id,s.tenantId,s.instanceId,scope,kind,productId,randomUUID()]));
 return id;
}
async function copyVersion(s:Store,scope:string,materialId:string,no:number,body:string,sha?:string){
 const id=randomUUID();
 await as(s.tenantId,q=>q.query(`INSERT INTO supply_material_versions(version_id,material_id,tenant_id,instance_id,scope_id,kind,version_no,body,content_sha256,created_by_principal_id)
  VALUES($1,$2,$3,$4,$5,'copy',$6,$7,$8,$9)`,[id,materialId,s.tenantId,s.instanceId,scope,no,body,sha??null,randomUUID()]));
 return id;
}
const point=(s:Store,materialId:string,versionId:string,next:number)=>as(s.tenantId,q=>q.query(
 'UPDATE supply_materials SET current_version_id=$2,aggregate_version=$3 WHERE material_id=$1',[materialId,versionId,next]));

test('copy material: own product, ordered versions, digest, forward pointer, retained rows',async()=>{
 const a=await f.openStore(),b=await f.openStore(),ia=await ids(a);
 const m=await material(a,ia.scope);
 await assert.rejects(material(a,ia.scope,'copy',b.productId),sql('23514'));
 await assert.rejects(material(a,ia.scope,'copy',randomUUID()),sql('23514'));
 assert.ok(await material(a,ia.scope,'image',null),'brand material');
 const v1=await copyVersion(a,ia.scope,m,1,'第一版文案\n第二行');
 const row=(await f.h.pool.query('SELECT content_sha256 FROM supply_material_versions WHERE version_id=$1',[v1])).rows[0];
 assert.equal(row.content_sha256,createHash('sha256').update('第一版文案\n第二行','utf8').digest('hex'));
 await assert.rejects(copyVersion(a,ia.scope,m,3,'跳號'),sql('23514'));
 await assert.rejects(copyVersion(a,ia.scope,m,2,'錯的摘要','0'.repeat(64)),sql('23514'));
 await assert.rejects(copyVersion(a,ia.scope,m,2,'控制字元\u0007'),sql('23514'));
 await point(a,m,v1,2);
 await assert.rejects(point(a,m,v1,2),sql('23514'),'same aggregate version');
 const v2=await copyVersion(a,ia.scope,m,2,'第二版');
 await point(a,m,v2,3);
 await assert.rejects(point(a,m,v1,4),sql('23514'),'pointer cannot move back');
 await assert.rejects(as(a.tenantId,q=>q.query("UPDATE supply_materials SET kind='video',aggregate_version=4 WHERE material_id=$1",[m])),sql('23514'));
 await assert.rejects(as(a.tenantId,q=>q.query("UPDATE supply_material_versions SET body='改' WHERE version_id=$1",[v1])),sql('23514'));
 await assert.rejects(as(a.tenantId,q=>q.query('DELETE FROM supply_material_versions WHERE version_id=$1',[v1])),sql('23514'));
 await assert.rejects(as(a.tenantId,q=>q.query('DELETE FROM supply_materials WHERE material_id=$1',[m])),sql('23514'));
 await assert.rejects(as(a.tenantId,q=>q.query(`INSERT INTO supply_materials(material_id,tenant_id,instance_id,scope_id,kind,title,state,withdrawn_at,created_by_principal_id)
  VALUES($1,$2,$3,$4,'copy','x','withdrawn',now(),$5)`,[randomUUID(),a.tenantId,a.instanceId,ia.scope,randomUUID()])),sql('23514'));
 await assert.rejects(as(a.tenantId,q=>q.query(`INSERT INTO supply_material_versions(version_id,material_id,tenant_id,instance_id,scope_id,kind,version_no,body,asset_id,created_by_principal_id)
  VALUES($1,$2,$3,$4,$5,'copy',3,'x',$6,$7)`,[randomUUID(),m,a.tenantId,a.instanceId,ia.scope,randomUUID(),randomUUID()])),sql('P0002'),'the fenced-asset trigger refuses an unknown asset first');
 // Another tenant cannot write into this business.
 await assert.rejects(as(b.tenantId,q=>q.query(`INSERT INTO supply_materials(material_id,tenant_id,instance_id,scope_id,kind,title,created_by_principal_id)
  VALUES($1,$2,$3,$4,'copy','x',$5)`,[randomUUID(),a.tenantId,a.instanceId,ia.scope,randomUUID()])),sql('42501'));
 assert.equal((await as(b.tenantId,q=>q.query("UPDATE supply_materials SET title='偷改',aggregate_version=aggregate_version+1 WHERE material_id=$1",[m]))).rowCount,0);
});

test('grants: other hosted storefront only, one active row, revoke once; partner sees current version only',async()=>{
 const a=await f.openStore(),b=await f.openStore(),c=await f.openStore(),ia=await ids(a),ib=await ids(b);
 const m=await material(a,ia.scope),v1=await copyVersion(a,ia.scope,m,1,'v1');await point(a,m,v1,2);
 const grant=(shop:string)=>as(a.tenantId,q=>q.query(`INSERT INTO supply_material_grants(grant_id,material_id,tenant_id,instance_id,partner_shop_id,granted_by_principal_id)
  VALUES($1,$2,$3,$4,$5,$6)`,[randomUUID(),m,a.tenantId,a.instanceId,shop,randomUUID()]));
 for(const shop of [ia.storefront_shop_id,ia.supply_shop_id,ib.supply_shop_id,randomUUID()])await assert.rejects(grant(shop),sql('23514'));
 await grant(ib.storefront_shop_id);
 await assert.rejects(grant(ib.storefront_shop_id),sql('23505'));
 const seen=(t:string)=>as(t,async q=>({
  materials:(await q.query('SELECT material_id FROM supply_materials')).rows.map(r=>r.material_id),
  versions:(await q.query('SELECT version_id FROM supply_material_versions')).rows.map(r=>r.version_id),
  grants:(await q.query('SELECT partner_shop_id FROM supply_material_grants')).rows.map(r=>r.partner_shop_id)}));
 assert.deepEqual(await seen(b.tenantId),{materials:[m],versions:[v1],grants:[ib.storefront_shop_id]});
 assert.deepEqual(await seen(c.tenantId),{materials:[],versions:[],grants:[]});
 const v2=await copyVersion(a,ia.scope,m,2,'v2');
 assert.deepEqual((await seen(b.tenantId)).versions,[v1],'a new version is not visible before it is current');
 await point(a,m,v2,3);
 assert.deepEqual((await seen(b.tenantId)).versions,[v2],'only the current version');
 assert.equal((await as(b.tenantId,q=>q.query("UPDATE supply_material_grants SET revoked_at=now(),revoked_by_principal_id=$1",[randomUUID()]))).rowCount,0,'partner cannot revoke');
 const revoke=()=>as(a.tenantId,q=>q.query("UPDATE supply_material_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=$2 WHERE material_id=$1 AND revoked_at IS NULL",[m,randomUUID()]));
 assert.equal((await revoke()).rowCount,1);
 assert.deepEqual(await seen(b.tenantId),{materials:[],versions:[],grants:[]});
 await assert.rejects(as(a.tenantId,q=>q.query("UPDATE supply_material_grants SET revoked_at=clock_timestamp() WHERE material_id=$1",[m])),sql('23514'));
 await assert.rejects(as(a.tenantId,q=>q.query('DELETE FROM supply_material_grants WHERE material_id=$1',[m])),sql('23514'));
 await grant(ib.storefront_shop_id);
 assert.deepEqual((await seen(b.tenantId)).materials,[m],'a new grant after revoke');
 await as(a.tenantId,q=>q.query("UPDATE supply_materials SET state='withdrawn',withdrawn_at=clock_timestamp(),aggregate_version=4 WHERE material_id=$1",[m]));
 assert.deepEqual((await seen(b.tenantId)).materials,[],'withdrawn is hidden even with an active grant');
 assert.deepEqual((await seen(b.tenantId)).versions,[]);
 await assert.rejects(as(a.tenantId,q=>q.query("UPDATE supply_materials SET title='復活',aggregate_version=5 WHERE material_id=$1",[m])),sql('23514'));
 await assert.rejects(copyVersion(a,ia.scope,m,3,'v3'),sql('23514'));
 await assert.rejects(grant(ib.storefront_shop_id),sql('23514'));
});

test('purposes start off and intents only name a material for the two new purposes',async()=>{
 const rows=(await f.h.pool.query("SELECT purpose,mode,persistence_allowed,policy_revision,retained_byte_limit FROM domain_media_storage_policy WHERE purpose LIKE 'storefront.supply-material%' ORDER BY purpose")).rows;
 assert.deepEqual(rows,[{purpose:'storefront.supply-material',mode:'legacy',persistence_allowed:false,policy_revision:null,retained_byte_limit:null},
  {purpose:'storefront.supply-material-video',mode:'legacy',persistence_allowed:false,policy_revision:null,retained_byte_limit:null}]);
 const defs=(await f.h.pool.query("SELECT conname,pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname IN ('upload_profile_shape','tenant_upload_identity','asset_object_profile_shape','asset_object_photo_dimensions','asset_scope_purpose','assets_purpose_check','asset_object_profile_id_shape','domain_media_storage_policy_purpose_check') AND connamespace=(SELECT oid FROM pg_namespace WHERE nspname=current_schema())")).rows;
 assert.equal(defs.length,8);
 for(const d of defs)assert.match(d.def,/storefront\.supply-material/,d.conname);
 const fns=(await f.h.pool.query("SELECT proname,prosrc FROM pg_proc WHERE proname IN ('preserve_domain_media_floor','preserve_asset_object_write_effect') AND pronamespace=(SELECT oid FROM pg_namespace WHERE nspname=current_schema())")).rows;
 assert.equal(fns.length,2);
 for(const fn of fns)assert.match(fn.prosrc,/'member\.ar-target','storefront\.supply-material','storefront\.supply-material-video'/,fn.proname);
});

async function mediaFixture(s:Store,kind:'image'|'video',materialId:string) {
 const p=await ids(s),asset=randomUUID(),representation=randomUUID(),intent=randomUUID(),purpose=kind==='image'?'storefront.supply-material':'storefront.supply-material-video';
 const principal=(await f.h.pool.query('SELECT principal_id FROM principals WHERE user_ref=$1',[s.owner.user.user_id])).rows[0].principal_id;
 const q=await f.h.pool.connect();try {
  await q.query('BEGIN');
  await q.query(`INSERT INTO assets(asset_id,scope_id,scope_kind,tenant_ref,owner_principal_id,owner_user_id,policy_revision,representation_id,purpose)
   VALUES($1,$2,'tenant',$3,$4,$5,'synthetic.material.1',$6,$7)`,[asset,p.scope,s.tenantId,principal,s.owner.user.user_id,representation,purpose]);
  await q.query(`INSERT INTO asset_upload_intents(intent_id,asset_id,representation_id,scope_id,owner_principal_id,target_user_id,policy_revision,prepare_key,request_digest,
   source_content_type,source_byte_size,source_sha256,expected_version,expires_at,purpose,reserved_bytes,target_kind,target_material_id,target_tenant_id,target_instance_id)
   VALUES($1,$2,$3,$4,$5,$6,'synthetic.material.1',$1::uuid::text,$7,$8,321,$7,1,clock_timestamp()+interval '1 hour',$9,$10,$9,$11,$12,$13)`,
   [intent,asset,representation,p.scope,principal,s.owner.user.user_id,'a'.repeat(64),kind==='image'?'image/png':'video/webm',purpose,kind==='image'?1048576:20971520,materialId,s.tenantId,s.instanceId]);
  await q.query(`UPDATE asset_upload_intents SET state='processing',fence=1,lease_token=$2,lease_expires_at=expires_at WHERE intent_id=$1`,[intent,randomUUID()]);
  await q.query(`INSERT INTO asset_objects(asset_id,scope_id,representation_id,content_type,byte_size,content_sha256,transform_version,policy_revision,purpose,variant,profile_id,pixel_width,pixel_height)
   VALUES($1,$2,$3,$4,321,$5,$6,'synthetic.material.1',$7,$8,$7,$9,$10)`,
   [asset,p.scope,representation,kind==='image'?'image/webp':'video/webm','a'.repeat(64),kind==='image'?'storefront.supply-material.webp.v1':'storefront.supply-material-video.original.v1',purpose,kind==='image'?'image':'video',kind==='image'?37:null,kind==='image'?29:null]);
  await q.query(`UPDATE assets SET state='ready',ready_at=clock_timestamp() WHERE asset_id=$1`,[asset]);
  await q.query(`UPDATE asset_upload_intents SET state='stored' WHERE intent_id=$1`,[intent]);
  await q.query('COMMIT');
 }catch(e){await q.query('ROLLBACK');throw e;}finally{q.release();}
 const version=randomUUID();
 await as(s.tenantId,q=>q.query(`INSERT INTO supply_material_versions(version_id,material_id,tenant_id,instance_id,scope_id,kind,version_no,asset_id,representation_id,policy_revision,purpose,created_by_principal_id)
  VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,'synthetic.material.1',$9,$10)`,[version,materialId,s.tenantId,s.instanceId,p.scope,kind,asset,representation,purpose,principal]));
 await point(s,materialId,version,2);
 return {asset,representation,intent,version,purpose};
}

test('media projections use the complete ready Asset/object tuple; intent material identity cannot change',async()=>{
 const a=await f.openStore(),p=await ids(a),image=await material(a,p.scope,'image'),video=await material(a,p.scope,'video');
 const im=await mediaFixture(a,'image',image),vid=await mediaFixture(a,'video',video);
 const app=f.application(true,{supplierConsoleEnabled:true});
 const b=await f.openStore(),bp=await ids(b);
 const terms=f.ok(await f.h.call('PATCH',a.root+`/products/${a.productId}/supply-terms`,a.owner,{cost_minor:400,shipping_minor:0,shipping_terms:'合成出貨',return_terms:'合成退貨'},{'Idempotency-Key':randomUUID(),'If-Match':`\"${a.version}\"`},app));
 const offered=f.ok(await f.h.call('POST',a.root+`/products/${a.productId}/supply-offer`,a.owner,{}, {'Idempotency-Key':randomUUID(),'If-Match':`\"${terms.version}\"`},app));
 f.ok(await f.h.call('POST',b.root+'/distribution-selections',b.owner,{offer_id:offered.offer_id,terms_sha256:offered.terms_sha256,retail_price_minor:900},{'Idempotency-Key':randomUUID()},app),201);
 await as(a.tenantId,q=>q.query(`INSERT INTO supply_material_grants(grant_id,material_id,tenant_id,instance_id,partner_shop_id,granted_by_principal_id)
  SELECT gen_random_uuid(),material_id,tenant_id,instance_id,$2,created_by_principal_id FROM supply_materials WHERE material_id=ANY($1::uuid[])`,[[image,video],bp.storefront_shop_id]));
 const {PartnerMaterialsSchema}=await import('../../contracts/guild-launchpad/v1/supplier-console.js');
 const partner=PartnerMaterialsSchema.parse(f.ok(await f.h.call('GET',b.root+'/partner-materials',b.owner,undefined,{},app)));assert.equal(partner.items.length,2);
 const list=f.ok(await f.h.call('GET',a.root+'/supply-materials',a.owner,undefined,{},app));
 const {SupplyMaterialsSchema,SupplyMaterialDetailSchema}=await import('../../contracts/guild-launchpad/v1/supplier-console.js');
 SupplyMaterialsSchema.parse(list);
 for(const [id,media,expected] of [[image,im,{kind:'image',content_type:'image/webp',byte_size:321,width:37,height:29}],
   [video,vid,{kind:'video',content_type:'video/webm',byte_size:321}]] as const) {
  const detail=SupplyMaterialDetailSchema.parse(f.ok(await f.h.call('GET',a.root+`/supply-materials/${id}`,a.owner,undefined,{},app)));
  assert.deepEqual(partner.items.find(m=>m.material_id===id)!.current.content,expected);
  assert.deepEqual(detail.material.current!.content,expected);assert.deepEqual(detail.versions[0].content,expected);
  assert.deepEqual(list.items.find((m:any)=>m.material_id===id).current,detail.material.current);
  const other=await material(a,p.scope,expected.kind);
  await assert.rejects(as(a.tenantId,q=>q.query('UPDATE asset_upload_intents SET target_material_id=$2 WHERE intent_id=$1',[media.intent,other])),sql('23514'));
  assert.equal((await f.h.pool.query('SELECT target_material_id FROM asset_upload_intents WHERE intent_id=$1',[media.intent])).rows[0].target_material_id,id);
  await assert.rejects(as(a.tenantId,q=>q.query('UPDATE supply_material_versions SET representation_id=$2 WHERE version_id=$1',[media.version,randomUUID()])),sql('23514'));
 }
});

test('every material identity field and grant identity remains immutable under the restricted role',async()=>{
 const a=await f.openStore(),b=await f.openStore(),p=await ids(a),bp=await ids(b),m=await material(a,p.scope);
 const changes=["material_id=gen_random_uuid()","tenant_id=gen_random_uuid()","instance_id=gen_random_uuid()","scope_id=gen_random_uuid()",
  "kind='image'","product_id=NULL","created_by_principal_id=gen_random_uuid()","created_at=created_at+interval '1 second'"];
 for(const change of changes)await assert.rejects(as(a.tenantId,q=>q.query(`UPDATE supply_materials SET ${change},aggregate_version=aggregate_version+1 WHERE material_id=$1`,[m])),sql('23514'));
 await as(a.tenantId,q=>q.query(`INSERT INTO supply_material_grants(grant_id,material_id,tenant_id,instance_id,partner_shop_id,granted_by_principal_id)
  VALUES($1,$2,$3,$4,$5,$6)`,[randomUUID(),m,a.tenantId,a.instanceId,bp.storefront_shop_id,randomUUID()]));
 await assert.rejects(as(a.tenantId,q=>q.query('UPDATE supply_material_grants SET partner_shop_id=$2,revoked_at=clock_timestamp(),revoked_by_principal_id=$3 WHERE material_id=$1',[m,randomUUID(),randomUUID()])),sql('23514'));
 const role=(await f.runtime.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];assert.deepEqual(role,{rolsuper:false,rolbypassrls:false});
});
