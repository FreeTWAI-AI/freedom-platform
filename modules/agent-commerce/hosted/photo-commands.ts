import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { HOSTED_STORE_MEDIA_PROFILE, ProductMediaCommandSchema, type ProductMediaCommand } from '../../../contracts/guild-launchpad/v1/hosted-store-media.js';
import { OpaqueId, Version } from '../../../contracts/guild-launchpad/v1/primitives.js';
import { checkVersion, digest } from '../../../packages/db/index.js';
import { assertCurrentSessionClock } from '../../../packages/db/member-session.js';
import { AssetStorageError, snapshotBoundedBytes } from '../../../packages/asset-storage/index.js';
import { isolatedTransaction } from '../../../packages/resource-scopes/tenant-transaction.js';
import type { TenantScopeContext } from '../../../packages/resource-scopes/index.js';
import { scopedTenantCommand } from '../../../packages/scoped-commands/index.js';
import { Problem, requireCondition } from '../../../packages/shared/problem.js';
import type { Actor } from '../../identity-membership/service.js';
import type { createStorefrontProductPhotoLifecycle } from '../../assets/storefront-product-photo.js';
import { storeCapabilities } from './capabilities.js';
import { lockStorefrontPhotoBoundary, type StorefrontPhotoActor } from './photo-authority.js';
import { lockCurrentPhotoProduct } from './photo-target.js';
import { photoProducts, privatePhotoView } from './photo-projection.js';
import { storeFact, type Profile } from './store.js';
import { PRODUCT_PHOTO_POLICY } from './media.js';

export type StorePhotoAssets = ReturnType<typeof createStorefrontProductPhotoLifecycle>;
interface PhotoReceipt { productId:string; completedVersion:string; changed:boolean }
interface PhotoCommand { actor:StorefrontPhotoActor;productId:string;expected:string;key:string;operation:string;body:unknown }
/** Only completion identity/version are receipted; current media is reprojected under current authority. */
async function photoCommand(pool:Pool,input:PhotoCommand,run:(q:PoolClient,c:TenantScopeContext)=>Promise<PhotoReceipt>) {
  let p!:Profile, context!:TenantScopeContext, ack!:ProductMediaCommand;
  const authorize=async(q:PoolClient,c:TenantScopeContext)=>{
    context=c;p=await lockStorefrontPhotoBoundary(q,c,input.actor);
    // No item lock here: engine policy locks must precede its item/target locks.
    requireCondition((await photoProducts(q,p)).some(item=>item.product.product_id===input.productId),404,'not_found','找不到這項商品。');
  };
  const reference=await scopedTenantCommand(pool,{actor:input.actor,tenantId:input.actor.tenant_id,tenantLock:'share',operation:input.operation,
    body:input.body,key:input.key,expected:input.expected,target:{kind:'storefront_product',id:input.productId},capabilitiesForRole:storeCapabilities},
  authorize,run,authorize,undefined,(source,command)=>isolatedTransaction(source,async q=>{
    const receipt=await command(q) as PhotoReceipt;
    requireCondition(receipt.productId===input.productId,500,'storefront_photo_invalid','商品照片回覆無效。');
    const item=(await photoProducts(q,p)).find(row=>row.product.product_id===input.productId);
    requireCondition(item,404,'not_found','找不到這項商品。');
    ack=ProductMediaCommandSchema.parse({profile:HOSTED_STORE_MEDIA_PROFILE,product_id:receipt.productId,
      completed_version:receipt.completedVersion,changed:receipt.changed,current:privatePhotoView(p,item)});
    await authorize(q,context);await assertCurrentSessionClock(q,input.actor);
    return receipt as Awaited<ReturnType<typeof command>>;
  }));
  return {reference,ack};
}
function commandInput(actor:Actor,tenantId:string,instanceId:string,productId:string,key:string,expected:string,operation:string,body:unknown):PhotoCommand {
  return {actor:Object.freeze({...actor,tenant_id:OpaqueId.parse(tenantId),instance_id:OpaqueId.parse(instanceId)}),productId:OpaqueId.parse(productId),expected:Version.parse(expected),key,operation,body};
}
export async function removeProductPhoto(pool:Pool,actor:Actor,tenantId:string,instanceId:string,productId:string,key:string,expected:string) {
  const input=commandInput(actor,tenantId,instanceId,productId,key,expected,'storefront.product.photo.remove',{});
  return (await photoCommand(pool,input,async(q,context)=>{
    const target=await lockCurrentPhotoProduct(q,context,input.actor,input.productId,false);
    checkVersion(target.aggregateVersion,input.expected);
    if(!target.assetId)return {productId:input.productId,completedVersion:target.aggregateVersion,changed:false};
    await q.query(`UPDATE commerce_product_photo_targets SET asset_id=NULL,representation_id=NULL,policy_revision=NULL,linked_at_product_version=NULL
      WHERE product_id=$1 AND tenant_id=$2 AND instance_id=$3`,[input.productId,tenantId,instanceId]);
    const next=(await q.query<{version:string}>(`UPDATE commerce_selections l SET aggregate_version=l.aggregate_version+1
      FROM commerce_storefront_profiles p WHERE p.tenant_id=$1 AND p.instance_id=$2 AND l.shop_id=p.storefront_shop_id AND l.item_id=$3 AND l.aggregate_version=$4 RETURNING l.aggregate_version::text AS version`,
    [tenantId,instanceId,input.productId,input.expected])).rows[0];
    requireCondition(next,412,'version_conflict','商品已更新，請重新讀取。');
    await storeFact(q,context,input.productId,next.version,input.operation,'storefront_product');
    return {productId:input.productId,completedVersion:next.version,changed:true};
  })).ack;
}
export async function uploadProductPhoto(pool:Pool,actor:Actor,tenantId:string,instanceId:string,productId:string,key:string,expected:string,
  file:{bytes:Buffer;mime:string},assets:StorePhotoAssets|undefined,newUploadsAllowed:boolean) {
  const bytes=Buffer.from(snapshotBoundedBytes(file.bytes,PRODUCT_PHOTO_POLICY.input_max_bytes)),mime=file.mime;
  requireCondition((PRODUCT_PHOTO_POLICY.input_content_types as readonly string[]).includes(mime),422,'invalid_image','請選擇 PNG、JPEG 或 WebP 圖片。');
  const sha256=createHash('sha256').update(bytes).digest('hex');
  const input=commandInput(actor,tenantId,instanceId,productId,key,expected,'storefront.product.photo.upload',{mime,byte_size:bytes.length,sha256});
  const probe=async()=>{const miss=new Error('storefront_photo_receipt_miss');try{return (await photoCommand(pool,input,async()=>{throw miss;})).ack;}catch(error){if(error!==miss)throw error;return undefined;}};
  const replay=await probe();if(replay)return replay;
  requireCondition(assets && newUploadsAllowed,503,'media_upload_unavailable','商品照片上傳目前無法使用。');
  const phaseKey=digest({operation:input.operation,key});
  try {
    const api=await assets.forProduct({bytes,mime});
    const prepared=await api.prepare(input.actor,{key:phaseKey,targetProductId:input.productId,expectedVersion:input.expected,contentType:mime as 'image/png'|'image/jpeg'|'image/webp',byteSize:bytes.length,sha256});
    const lease=await api.resumeUpload(input.actor,{key:phaseKey,intentId:prepared.intentId});
    const binding={intentId:lease.intentId,fence:lease.fence,leaseToken:lease.leaseToken};
    if(lease.state==='prepared'||lease.state==='processing')await api.write(input.actor,{...binding,key:digest({key:phaseKey,phase:'write',fence:lease.fence})},new ReadableStream({start(c){c.enqueue(bytes);c.close();}}));
    let ack!:ProductMediaCommand;
    await api.finalizeVia<PhotoReceipt>(input.actor,{...binding,key:digest({key:phaseKey,phase:'finalize'})},{operation:input.operation,
      execute:async run=>{const completed=await photoCommand(pool,input,run);ack=completed.ack;return completed.reference;},
      validateIntent:row=>requireCondition(row.target_product_id===input.productId && row.target_instance_id===instanceId && row.source_sha256===sha256
        && row.source_content_type===mime && row.source_byte_size===bytes.length && row.expected_version===input.expected,409,'asset_source_mismatch','上傳內容與準備紀錄不同。'),
      result:value=>({productId:value.productId,completedVersion:value.completedVersion,changed:true}),
    });
    return ack;
  }catch(error){
    const committed=await probe().catch(()=>undefined);if(committed)return committed;
    if(error instanceof AssetStorageError)throw new Problem(503,'media_upload_unavailable','商品照片上傳目前無法使用。');
    throw error;
  }
}
