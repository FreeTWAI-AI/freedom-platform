import type { PoolClient } from 'pg';
import type { TenantScopeContext } from '../../../packages/resource-scopes/index.js';
import { requireCondition } from '../../../packages/shared/problem.js';
import type { LifecycleTarget } from '../../assets/engine.js';
import type { StorefrontPhotoActor } from '../hosted/photo-authority.js';
import { PublicationPhotoRefSchema } from '../hosted/media.js';
import { profile, ready, type Profile } from '../hosted/store.js';

export const distributionPhotoMissing = () => requireCondition(false,404,'not_found','找不到這個素材。');
/** One sellability predicate for copying, draft reads and publication. */
export const sellableDistributionSql = `o.state='offered' AND l.acceptance_state='sellable' AND a.decision='accepted'
 AND a.listing_sha256=l.listing_sha256 AND l.snapshot->>'offer_sha256'=o.terms_sha256`;
/** Exact storefront grant and exact supplier/product applicability. A newer version
 * stays usable: provenance chooses the stored version until an explicit recopy. */
export const usableDistributionSourceSql = `(${sellableDistributionSql}) AND EXISTS(
 SELECT 1 FROM supply_materials m JOIN supply_material_grants g ON g.material_id=m.material_id
 WHERE m.material_id=c.source_material_id AND m.state='active' AND m.kind='image' AND m.access='public_use'
 AND m.current_version_id IS NOT NULL AND g.partner_shop_id=l.shop_id AND g.revoked_at IS NULL
 AND m.tenant_id=o.tenant_id AND m.instance_id=o.instance_id AND (m.product_id IS NULL OR m.product_id=l.item_id))`;
export async function distributionPhotoRows(q:PoolClient,p:Profile,includeUnavailable=false) {
 return (await q.query(`SELECT l.item_id,l.hosted_sku,l.snapshot,l.retail_price_minor,l.aggregate_version::text AS selection_version,
 t.aggregate_version::text AS photo_version,t.asset_id,t.scope_id,t.representation_id,t.policy_revision,
 c.source_material_id,c.source_version_id,c.source_version_no,c.source_title,
 (${sellableDistributionSql}) AS sellable,(${usableDistributionSourceSql}) AS usable,
 (SELECT m.current_version_id FROM supply_materials m WHERE m.material_id=c.source_material_id) AS latest_id,
 (SELECT v.version_no FROM supply_materials m JOIN supply_material_versions v ON v.version_id=m.current_version_id
  WHERE m.material_id=c.source_material_id) AS latest_no,
 obj.content_type,obj.byte_size,obj.content_sha256,obj.transform_version,obj.purpose,obj.pixel_width AS width,obj.pixel_height AS height
 FROM commerce_selections l JOIN commerce_hosted_supply_offers o ON o.offer_id=l.hosted_offer_id AND o.item_id=l.item_id
 LEFT JOIN commerce_distribution_acceptances a ON a.acceptance_id=l.current_acceptance_id AND a.selection_id=l.selection_id
 LEFT JOIN commerce_distribution_photo_targets t ON t.tenant_id=$2 AND t.instance_id=$3 AND t.product_id=l.item_id
 LEFT JOIN commerce_distribution_photo_copies c ON c.asset_id=t.asset_id AND c.tenant_id=t.tenant_id AND c.instance_id=t.instance_id AND c.product_id=t.product_id
 LEFT JOIN assets asset ON asset.asset_id=t.asset_id AND asset.scope_id=t.scope_id AND asset.tenant_ref=t.tenant_id
  AND asset.scope_kind='tenant' AND asset.purpose='storefront.product-photo' AND asset.state='ready' AND asset.deletion_fence=0 AND asset.representation_id=t.representation_id
 LEFT JOIN asset_objects obj ON obj.asset_id=asset.asset_id AND obj.scope_id=asset.scope_id AND obj.representation_id=asset.representation_id
  AND obj.policy_revision=t.policy_revision AND obj.purpose=asset.purpose AND obj.profile_id='storefront.product-photo'
 WHERE l.shop_id=$1 AND ((${sellableDistributionSql}) OR ($4::boolean AND t.product_id IS NOT NULL))
 ORDER BY l.hosted_sku LIMIT 201`,[p.storefront_shop_id,p.tenant_id,p.instance_id,includeUnavailable])).rows;
}
export function distributionStoredPhoto(row:Record<string,any>) {
 if(!row.asset_id)return null;
 requireCondition(row.purpose==='storefront.product-photo',503,'distribution_photo_unavailable','目前無法把素材用在公開店面。');
 return {scopeId:row.scope_id as string,policyRevision:row.policy_revision as string,ref:PublicationPhotoRefSchema.parse({
  sku:row.hosted_sku,asset_id:row.asset_id,representation_id:row.representation_id,sha256:row.content_sha256,
  purpose:row.purpose,transform_version:row.transform_version,content_type:row.content_type,byte_size:Number(row.byte_size),width:row.width,height:row.height})};
}
export async function lockDistributionPhotoTarget(q:PoolClient,c:TenantScopeContext,actor:StorefrontPhotoActor,id:string,create:boolean):Promise<LifecycleTarget> {
 const p=await profile(q,c.tenant_id,actor.instance_id);ready(p);
 const selection=(await q.query(`SELECT l.selection_id FROM commerce_selections l JOIN commerce_hosted_supply_offers o
  ON o.offer_id=l.hosted_offer_id AND o.item_id=l.item_id WHERE l.shop_id=$1 AND l.item_id=$2 FOR SHARE OF l`,[p.storefront_shop_id,id])).rows[0];
 if(!selection)distributionPhotoMissing();
 if(create)await q.query(`INSERT INTO commerce_distribution_photo_targets(tenant_id,instance_id,product_id,scope_id)
  VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[c.tenant_id,actor.instance_id,id,c.scope.scope_id]);
 const pointer=(await q.query(`SELECT asset_id,aggregate_version::text AS version FROM commerce_distribution_photo_targets
  WHERE tenant_id=$1 AND instance_id=$2 AND product_id=$3 AND scope_id=$4 FOR UPDATE`,[c.tenant_id,actor.instance_id,id,c.scope.scope_id])).rows[0];
 return {targetId:id,aggregateVersion:pointer?.version??'0',assetId:pointer?.asset_id??null};
}

/** Server-only source pin. readPartnerMaterial remains the sole visibility rule;
 * the first query only locates the current visible version for precise conflicts. */
export async function distributionSource(q:PoolClient,p:Profile,productId:string,materialId:string,versionId:string) {
 const {readPartnerMaterial,partnerVisibleMaterials}=await import('./materials.js');
 const product=(await distributionPhotoRows(q,p)).find(row=>row.item_id===productId);
 if(!product)distributionPhotoMissing();
 const current=(await q.query(`WITH visible AS (${partnerVisibleMaterials}) SELECT version_id FROM visible WHERE material_id=$2`,[p.storefront_shop_id,materialId])).rows[0];
 if(!current)distributionPhotoMissing();
 const material=await readPartnerMaterial(q,p.storefront_shop_id,materialId,current.version_id);
 if(!material || !material.applies_to.includes(productId))distributionPhotoMissing();
 requireCondition(material.access==='public_use',409,'material_not_public','供應商尚未同意把這個素材用在公開店面。');
 requireCondition(material.kind==='image',409,'material_not_image','只有圖片素材可以用在公開店面。');
 requireCondition(current.version_id===versionId,409,'material_version_changed','供應商已更新這個素材。');
 const exact=await readPartnerMaterial(q,p.storefront_shop_id,materialId,versionId);
 if(!exact)distributionPhotoMissing();
 const object=(await q.query(`SELECT v.scope_id,v.asset_id,v.representation_id,o.content_type,o.byte_size,o.content_sha256,
  o.transform_version,o.policy_revision,o.profile_id FROM supply_material_versions v
  JOIN assets a ON a.asset_id=v.asset_id AND a.scope_id=v.scope_id AND a.tenant_ref=v.tenant_id AND a.scope_kind='tenant'
   AND a.purpose=v.purpose AND a.representation_id=v.representation_id AND a.state='ready' AND a.deletion_fence=0
  JOIN asset_objects o ON o.asset_id=a.asset_id AND o.scope_id=v.scope_id AND o.representation_id=v.representation_id
   AND o.policy_revision=v.policy_revision AND o.purpose=v.purpose AND o.profile_id=v.purpose AND o.content_sha256=v.content_sha256
  WHERE v.version_id=$1 AND v.material_id=$2`,[versionId,materialId])).rows[0];
 requireCondition(object,503,'material_content_unavailable','素材檔案暫時無法讀取。');
 return {materialId,versionId,versionNo:exact.current.version_no as number,title:exact.title as string,
  materialVersion:exact.aggregate_version as string,selectionVersion:product.selection_version as string,
  scopeId:object.scope_id as string,assetId:object.asset_id as string,representationId:object.representation_id as string,
  metadata:{contentType:object.content_type as 'image/webp',byteSize:Number(object.byte_size),sha256:object.content_sha256 as string,
   transformVersion:object.transform_version as 'storefront.supply-material.webp.v1',policyRevision:object.policy_revision as string,profileId:object.profile_id as 'storefront.supply-material'}};
}
export type DistributionSource=Awaited<ReturnType<typeof distributionSource>>;
