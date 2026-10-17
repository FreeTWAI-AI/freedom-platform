import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {Pool,PoolClient} from 'pg';
import {OpaqueId,NonNegativeDecimal} from '../../contracts/guild-launchpad/v1/primitives.js';
import type {TenantScopeContext} from '../../packages/resource-scopes/index.js';
import {Problem,requireCondition} from '../../packages/shared/problem.js';
import {readBounded,snapshotBoundedBytes,prepareLegacyMediaRepresentation} from '../../packages/asset-storage/index.js';
import {lockDimension,retainedByteUsage} from '../opportunity-project-work/tenant-capacity.js';
import {lockStorefrontPhotoBoundary,type StorefrontPhotoActor} from '../agent-commerce/hosted/photo-authority.js';
import type {PhotoCompletion} from '../agent-commerce/hosted/photo-target.js';
import {profile,ready} from '../agent-commerce/hosted/store.js';
import {lockDistributionPhotoTarget,distributionSource,type DistributionSource} from '../agent-commerce/supplier-console/distribution-photo-target.js';
import {assetCommandKey,createAssetLifecycleWithAuthority,type LifecycleDependencies} from './engine.js';
import {createStorefrontLifecycleAuthority} from './storefront-lifecycle-authority.js';
import {lockProductPhotoPolicy,normalizeProductPhoto,PRODUCT_PHOTO_OUTPUT_BYTES} from './storefront-product-photo.js';
export const distributionPhotoUnavailable=()=>new Problem(503,'distribution_photo_unavailable','目前無法把素材用在公開店面。');
const input=z.object({key:assetCommandKey,targetProductId:OpaqueId,expectedVersion:NonNegativeDecimal,
 contentType:z.literal('image/webp'),byteSize:z.number().int().min(1).max(1048576),sha256:z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/),
 materialId:OpaqueId,versionId:OpaqueId}).strict();
type DistributionPhotoPrepare=z.infer<typeof input>;
async function photoPolicy(q:PoolClient,t:string) {
 try{return await lockProductPhotoPolicy(q,t);}catch(error){if(error instanceof Problem && error.code==='product_photo_unavailable')throw distributionPhotoUnavailable();throw error;}
}
interface ValidatedSource { readonly mime: string; readonly byteSize: number; readonly sha256: string; readonly webp: Buffer }
function lifecycle(pool: Pool, dependencies: LifecycleDependencies, source: ValidatedSource, pin: DistributionSource) {
  return createAssetLifecycleWithAuthority<DistributionPhotoPrepare, PhotoCompletion, StorefrontPhotoActor, TenantScopeContext>(pool, dependencies, {
    purpose: 'storefront.product-photo', targetKind: 'storefront.distribution-photo', variant: 'image',
    inputMaxBytes: PRODUCT_PHOTO_OUTPUT_BYTES, outputMaxBytes: PRODUCT_PHOTO_OUTPUT_BYTES, retireReplacedAsset: false,
    parsePrepare(raw) {
      const value = input.parse(raw);
      requireCondition(value.materialId===pin.materialId && value.versionId===pin.versionId,409,'asset_source_mismatch','上傳內容與準備紀錄不同。');
      requireCondition(value.contentType === source.mime && value.byteSize === source.byteSize && value.sha256 === source.sha256,
        409, 'asset_source_mismatch', '上傳內容與準備紀錄不同。');
      return value;
    },
    targetId: value => value.targetProductId,
    async lockTarget(q, context, actor, id, create) {
      // All phases acquire policy BEFORE item/selection/target, including reads,
      // leases and finalizeVia. The boundary remains the named domain authority.
      await lockStorefrontPhotoBoundary(q, context, actor);
      await photoPolicy(q, context.tenant_id);
      return lockDistributionPhotoTarget(q, context, actor, id, create);
    },
    resolvePolicy: async (q, context) => (await photoPolicy(q, context.tenant_id)).policy,
    async requireCapacity(q, context, _actor, _target, policy, reserve) {
      const { tenant } = await photoPolicy(q, context.tenant_id);
      await lockDimension(q, context.tenant_id, 'retained_bytes');
      const shared = await retainedByteUsage(q, context.scope.scope_id, context.tenant_id);
      requireCondition(shared + BigInt(reserve) <= BigInt(tenant.max_retained_bytes), 429, 'quota_exceeded', '已達到這個業務空間的容量上限。');
      const used = (await q.query<{ used: string }>(`SELECT COALESCE(sum(COALESCE(o.byte_size,i.reserved_bytes,1048576)::bigint),0)::text AS used
        FROM assets a LEFT JOIN asset_objects o USING(asset_id) LEFT JOIN asset_upload_intents i USING(asset_id)
        WHERE a.scope_id=$1 AND a.tenant_ref=$2 AND a.purpose='storefront.product-photo'`, [context.scope.scope_id, context.tenant_id])).rows[0];
      requireCondition(BigInt(used.used) + BigInt(reserve) <= BigInt(policy.retainedByteLimit), 409, 'asset_retained_quota', '照片儲存容量已達上限。');
    },
    async prepareRepresentation(body, mime, policy) {
      const bytes = await readBounded(body, PRODUCT_PHOTO_OUTPUT_BYTES);
      requireCondition(mime === source.mime && bytes.length === source.byteSize && createHash('sha256').update(bytes).digest('hex') === source.sha256,
        409, 'asset_source_mismatch', '上傳內容與準備紀錄不同。');
      return prepareLegacyMediaRepresentation(new ReadableStream({ start(c) { c.enqueue(Buffer.from(source.webp)); c.close(); } }),
        'image/webp', 'storefront.product-photo', policy);
    },
    async lockPublication(q,context,actor,_intent,target) {
      const p=await profile(q,context.tenant_id,actor.instance_id);ready(p);
      let current:DistributionSource;
      try { current=await distributionSource(q,p,target.targetId,pin.materialId,pin.versionId); }
      catch { throw new Problem(404,'not_found','找不到這個素材。'); }
      requireCondition(JSON.stringify(current)===JSON.stringify(pin),404,'not_found','找不到這個素材。');
      return undefined;
    },
    async publish(q,context,actor,intent,target) {
      requireCondition(intent.target_distribution_product_id===target.targetId && intent.target_instance_id===actor.instance_id
       && intent.target_tenant_id===context.tenant_id,409,'asset_source_mismatch','上傳內容與商品不同。');
      await q.query(`INSERT INTO commerce_distribution_photo_copies(asset_id,tenant_id,instance_id,product_id,scope_id,representation_id,policy_revision,
       source_material_id,source_version_id,source_content_sha256,source_version_no,source_title,copied_by_principal_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[intent.asset_id,context.tenant_id,actor.instance_id,target.targetId,
       context.scope.scope_id,intent.representation_id,intent.policy_revision,pin.materialId,pin.versionId,pin.metadata.sha256,pin.versionNo,pin.title,context.subject_principal.principal_id]);
      const next=(await q.query(`UPDATE commerce_distribution_photo_targets SET asset_id=$4,representation_id=$5,policy_revision=$6,aggregate_version=aggregate_version+1
       WHERE tenant_id=$1 AND instance_id=$2 AND product_id=$3 AND aggregate_version=$7 RETURNING aggregate_version::text AS version`,
       [context.tenant_id,actor.instance_id,target.targetId,intent.asset_id,intent.representation_id,intent.policy_revision,intent.expected_version])).rows[0];
      requireCondition(next,412,'version_conflict','商品版本已改變。');
      return {aggregateVersion:next.version,result:{productId:target.targetId,completedVersion:next.version,intentId:intent.intent_id},
       fact:{aggregateType:'storefront_product',id:target.targetId,data:{resource_id:target.targetId,version:next.version}}};
    },
  }, createStorefrontLifecycleAuthority());
}
export function createStorefrontDistributionPhotoLifecycle(pool:Pool,dependencies:LifecycleDependencies) {
 if(!dependencies?.store)throw distributionPhotoUnavailable();
 return Object.freeze({async forMaterial(bytes:Buffer,pin:DistributionSource) {
  const bounded=Buffer.from(snapshotBoundedBytes(bytes,PRODUCT_PHOTO_OUTPUT_BYTES));
  const sha256=createHash('sha256').update(bounded).digest('hex');
  requireCondition(sha256===pin.metadata.sha256 && bounded.length===pin.metadata.byteSize,503,'material_content_unavailable','素材檔案暫時無法讀取。');
  const webp=Buffer.from(await normalizeProductPhoto('image/webp',bounded));
  return lifecycle(pool,dependencies,Object.freeze({mime:'image/webp',byteSize:bounded.length,sha256,webp}),pin);
 }});
}
export type StorefrontDistributionPhotoLifecycle=ReturnType<typeof createStorefrontDistributionPhotoLifecycle>;
