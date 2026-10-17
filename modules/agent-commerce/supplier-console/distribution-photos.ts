import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {OpaqueId,NonNegativeDecimal} from '../../../contracts/guild-launchpad/v1/primitives.js';
import {DistributionPhotosSchema,DistributionPhotoCommandSchema,DistributionPhotoUseInputSchema,type DistributionPhotoItem,type DistributionPhotoCommand} from '../../../contracts/guild-launchpad/v1/supplier-console.js';
import {checkVersion,digest} from '../../../packages/db/index.js';
import {assertCurrentSessionClock} from '../../../packages/db/member-session.js';
import {isolatedTransaction} from '../../../packages/resource-scopes/tenant-transaction.js';
import type {TenantScopeContext} from '../../../packages/resource-scopes/index.js';
import {scopedTenantCommand} from '../../../packages/scoped-commands/index.js';
import {objectKey,readVerifiedObject,AssetStorageError,type ObjectStore} from '../../../packages/asset-storage/index.js';
import {Problem,requireCondition} from '../../../packages/shared/problem.js';
import type {Actor} from '../../identity-membership/service.js';
import {distributionPhotoUnavailable,type StorefrontDistributionPhotoLifecycle} from '../../assets/storefront-distribution-photo.js';
import {storeCapabilities} from '../hosted/capabilities.js';
import {lockStorefrontPhotoBoundary,type StorefrontPhotoActor} from '../hosted/photo-authority.js';
import {photoMetadata} from '../hosted/photo-projection.js';
import {profile,ready,storeRead,storeFact,type Profile} from '../hosted/store.js';
import {distributionPhotoRows,distributionStoredPhoto,distributionSource,distributionPhotoMissing,lockDistributionPhotoTarget} from './distribution-photo-target.js';

export interface DistributionPhotoAssets {lifecycle:StorefrontDistributionPhotoLifecycle;sourceStore:ObjectStore}
function itemView(p:Profile,row:Record<string,any>):DistributionPhotoItem {
 const photo=distributionStoredPhoto(row),version=row.photo_version??'0';
 return {product_id:row.item_id,sku:row.hosted_sku,title:row.snapshot.title,version,
  state:!row.asset_id?'none':!row.usable?'source_unavailable':row.source_version_id===row.latest_id?'in_use':'update_available',
  photo:photo?{...photoMetadata(photo.ref),read_path:`/api/v1/tenants/${p.tenant_id}/storefronts/${p.instance_id}/distribution-photos/${row.item_id}/photo/${version}`}:null,
  source:row.asset_id?{material_id:row.source_material_id,version_id:row.source_version_id,version_no:row.source_version_no,title:row.source_title}:null,
  latest:row.usable?{version_id:row.latest_id,version_no:row.latest_no}:null};
}
async function items(q:PoolClient,p:Profile,receiptProduct?:string) {
 const rows=await distributionPhotoRows(q,p,true);
 requireCondition(rows.length<=200,500,'internal_error','店面照片資料目前無法讀取。');
 return DistributionPhotosSchema.parse({items:rows.filter(row=>row.sellable||row.asset_id||row.item_id===receiptProduct).map(row=>itemView(p,row))});
}
export async function listDistributionPhotos(pool:Pool,actor:Actor,t:string,i:string) {
 return storeRead(pool,actor,t,i,'store:read',async q=>{const p=await profile(q,t,i);ready(p);return items(q,p);});
}
interface Receipt {productId:string;completedVersion:string;changed:boolean}
interface Command {actor:StorefrontPhotoActor;productId:string;key:string;expected:string;operation:string;body:unknown}
function input(actor:Actor,t:string,i:string,id:string,key:string,expected:string,operation:string,body:unknown):Command {
 requireCondition(expected!==undefined,428,'version_required','請提供 If-Match 版本。');
 return {actor:Object.freeze({...actor,tenant_id:OpaqueId.parse(t),instance_id:OpaqueId.parse(i)}),productId:OpaqueId.parse(id),key,
  expected:NonNegativeDecimal.parse(expected),operation,body};
}
async function command(pool:Pool,c:Command,run:(q:PoolClient,context:TenantScopeContext)=>Promise<Receipt>) {
 let p!:Profile,context!:TenantScopeContext,ack!:DistributionPhotoCommand;
 const authorize=async(q:PoolClient,ctx:TenantScopeContext)=>{
  context=ctx;p=await lockStorefrontPhotoBoundary(q,ctx,c.actor);
  const selection=(await q.query(`SELECT l.item_id FROM commerce_selections l WHERE l.shop_id=$1 AND l.item_id=$2 AND l.hosted_offer_id IS NOT NULL`,[p.storefront_shop_id,c.productId])).rows[0];
  if(!selection)distributionPhotoMissing();
 };
 const reference=await scopedTenantCommand(pool,{actor:c.actor,tenantId:c.actor.tenant_id,tenantLock:'share',operation:c.operation,
  // The shared core admits positive versions. Zero remains bound in the body,
  // and the domain checks the actual nonnegative pointer CAS inside the run.
  body:{input:c.body,expected_version:c.expected},key:c.key,expected:c.expected==='0'?undefined:c.expected,
  target:{kind:'storefront_product',id:c.productId},capabilitiesForRole:storeCapabilities},authorize,run,authorize,undefined,
  (source,execute)=>isolatedTransaction(source,async q=>{
   const receipt=await execute(q) as Receipt;
   const current=(await items(q,p,c.productId)).items.find(row=>row.product_id===c.productId);
   requireCondition(current,404,'not_found','找不到這個素材。');
   ack=DistributionPhotoCommandSchema.parse({product_id:c.productId,version:receipt.completedVersion,changed:receipt.changed,current});
   await authorize(q,context);await assertCurrentSessionClock(q,c.actor);
   return receipt as Awaited<ReturnType<typeof execute>>;
  }));
 return {reference,ack};
}
export async function detachDistributionPhoto(pool:Pool,actor:Actor,t:string,i:string,id:string,key:string,expected:string) {
 const c=input(actor,t,i,id,key,expected,'storefront.distribution-photo.detach',{});
 return (await command(pool,c,async(q,ctx)=>{
  const target=await lockDistributionPhotoTarget(q,ctx,c.actor,c.productId,false);checkVersion(target.aggregateVersion,c.expected);
  if(!target.assetId)return {productId:id,completedVersion:target.aggregateVersion,changed:false};
  const row=(await q.query(`UPDATE commerce_distribution_photo_targets SET asset_id=NULL,representation_id=NULL,policy_revision=NULL,aggregate_version=aggregate_version+1
   WHERE tenant_id=$1 AND instance_id=$2 AND product_id=$3 RETURNING aggregate_version::text AS version`,[t,i,id])).rows[0];
  await storeFact(q,ctx,id,row.version,c.operation,'storefront_product');
  return {productId:id,completedVersion:row.version,changed:true};
 })).ack;
}
export async function useDistributionPhoto(pool:Pool,actor:Actor,t:string,i:string,id:string,raw:unknown,key:string,expected:string,
 assets:DistributionPhotoAssets|undefined,enabled:boolean) {
 const body=DistributionPhotoUseInputSchema.parse(raw),c=input(actor,t,i,id,key,expected,'storefront.distribution-photo.use',body);
 const probe=async()=>{const miss=new Error('distribution_photo_receipt_miss');try{return (await command(pool,c,async()=>{throw miss;})).ack;}catch(error){if(error!==miss)throw error;return undefined;}};
 const replay=await probe();if(replay)return replay;
 if(!assets||!enabled)throw distributionPhotoUnavailable();
 const snapshot=()=>storeRead(pool,actor,t,i,'store:write',async q=>{const p=await profile(q,t,i);ready(p);return distributionSource(q,p,id,body.material_id,body.version_id);});
 try {
  const before=await snapshot();let bytes:Buffer;
  try{bytes=Buffer.from((await readVerifiedObject(assets.sourceStore,objectKey({scopeId:before.scopeId,assetId:before.assetId,representationId:before.representationId}),before.metadata)).bytes);}
  catch{throw new Problem(503,'material_content_unavailable','素材檔案暫時無法讀取。');}
  let after:typeof before;
  try{after=await snapshot();}catch{throw new Problem(404,'not_found','找不到這個素材。');}
  requireCondition(JSON.stringify(before)===JSON.stringify(after),404,'not_found','找不到這個素材。');
  const api=await assets.lifecycle.forMaterial(bytes,before),phaseKey=digest({operation:c.operation,key});
  const sha256=createHash('sha256').update(bytes).digest('hex');
  const prepared=await api.prepare(c.actor,{key:phaseKey,targetProductId:id,expectedVersion:c.expected,contentType:'image/webp',byteSize:bytes.length,sha256,
   materialId:body.material_id,versionId:body.version_id});
  const lease=await api.resumeUpload(c.actor,{key:phaseKey,intentId:prepared.intentId});
  const binding={intentId:lease.intentId,fence:lease.fence,leaseToken:lease.leaseToken};
  if(lease.state==='prepared'||lease.state==='processing')await api.write(c.actor,{...binding,key:digest({key:phaseKey,phase:'write',fence:lease.fence})},
   new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}}));
  let ack!:DistributionPhotoCommand;
  await api.finalizeVia<Receipt>(c.actor,{...binding,key:digest({key:phaseKey,phase:'finalize'})},{operation:c.operation,
   execute:async run=>{const completed=await command(pool,c,run);ack=completed.ack;return completed.reference;},
   validateIntent:row=>requireCondition(row.target_distribution_product_id===id && row.target_instance_id===i && row.target_tenant_id===t
    && row.source_sha256===sha256 && row.expected_version===c.expected,409,'asset_source_mismatch','上傳內容與準備紀錄不同。'),
   result:value=>({productId:value.productId,completedVersion:value.completedVersion,changed:true})});
  return ack;
 }catch(error){const committed=await probe().catch(()=>undefined);if(committed)return committed;
  if(error instanceof AssetStorageError)throw distributionPhotoUnavailable();throw error;}
}
export async function readDistributionPhoto(pool:Pool,store:ObjectStore,actor:Actor,t:string,i:string,id:string,rawVersion:string) {
 const productId=OpaqueId.parse(id),version=NonNegativeDecimal.parse(rawVersion);
 const snapshot=()=>storeRead(pool,actor,t,i,'store:read',async q=>{const p=await profile(q,t,i);ready(p);
  const row=(await distributionPhotoRows(q,p,true)).find(row=>row.item_id===productId);
  requireCondition(row?.asset_id && row.photo_version===version,404,'not_found','找不到這個素材。');
  return distributionStoredPhoto(row)!;});
 const before=await snapshot();let bytes:Uint8Array;
 try{bytes=(await readVerifiedObject(store,objectKey({scopeId:before.scopeId,assetId:before.ref.asset_id,representationId:before.ref.representation_id}),{
  contentType:before.ref.content_type,byteSize:before.ref.byte_size,sha256:before.ref.sha256,transformVersion:before.ref.transform_version,
  policyRevision:before.policyRevision,profileId:'storefront.product-photo'})).bytes;}catch{throw distributionPhotoUnavailable();}
 const after=await snapshot();requireCondition(JSON.stringify(before)===JSON.stringify(after),404,'not_found','找不到這個素材。');return bytes;
}
