import type { PoolClient } from 'pg';
import { ProductViewSchema, type ProductView } from '../../../contracts/guild-launchpad/v1/storefront.js';
import { HOSTED_STORE_MEDIA_PROFILE } from '../../../contracts/guild-launchpad/v1/hosted-store-media.js';
import { requireCondition } from '../../../packages/shared/problem.js';
import { PublicationPhotoRefSchema, publicationMediaSnapshot, projectPrivateProductMedia, type PublicationPhotoRef } from './media.js';
import type { Profile } from './store.js';

export interface StoredProductPhoto { ref: PublicationPhotoRef; scopeId: string; policyRevision: string }
export interface PhotoProduct { product: Omit<ProductView, 'stock'>; photo: StoredProductPhoto | null }
export function photoMetadata(ref: PublicationPhotoRef) {
  return { content_type: ref.content_type, byte_size: ref.byte_size, width: ref.width, height: ref.height };
}
function storedPhoto(row: Record<string, unknown>): StoredProductPhoto {
  requireCondition(typeof row.scope_id === 'string' && typeof row.policy_revision === 'string', 500, 'storefront_photo_invalid', '商品照片資料不完整。');
  return { scopeId: row.scope_id, policyRevision: row.policy_revision, ref: PublicationPhotoRefSchema.parse({
    sku: row.sku, asset_id: row.asset_id, representation_id: row.representation_id, sha256: row.content_sha256,
    purpose: row.purpose, transform_version: row.transform_version, content_type: row.content_type,
    byte_size: Number(row.byte_size), width: row.width, height: row.height,
  }) };
}
/** One statement keeps actual commerce fields, selection version and draft pointer coherent. */
export async function photoProducts(q: PoolClient, p: Profile): Promise<PhotoProduct[]> {
  const rows = (await q.query(`SELECT i.item_id AS product_id,i.sku,i.title,i.description,l.retail_price_minor AS price_minor,i.stock,s.currency,l.aggregate_version::text AS version,
    t.asset_id,t.scope_id,t.representation_id,t.policy_revision,o.content_type,o.byte_size,o.content_sha256,o.transform_version,o.purpose,o.pixel_width AS width,o.pixel_height AS height
    FROM commerce_items i JOIN commerce_selections l ON l.item_id=i.item_id
    JOIN commerce_resource_tenants m ON m.resource_kind='shop' AND m.resource_id=i.shop_id AND m.mapping_state='confirmed'
    JOIN commerce_resource_tenants retail ON retail.resource_kind='shop' AND retail.resource_id=l.shop_id AND retail.mapping_state='confirmed' AND retail.tenant_id=m.tenant_id AND retail.instance_id=m.instance_id
    JOIN commerce_shops s ON s.shop_id=l.shop_id AND s.origin='hosted'
    JOIN commerce_shops supply ON supply.shop_id=i.shop_id AND supply.origin='hosted'
    LEFT JOIN commerce_product_photo_targets t ON t.product_id=i.item_id AND t.tenant_id=m.tenant_id AND t.instance_id=m.instance_id
    LEFT JOIN assets a ON a.asset_id=t.asset_id AND a.scope_id=t.scope_id AND a.tenant_ref=t.tenant_id AND a.scope_kind='tenant' AND a.purpose='storefront.product-photo' AND a.state='ready' AND a.deletion_fence=0 AND a.representation_id=t.representation_id
    LEFT JOIN asset_objects o ON o.asset_id=a.asset_id AND o.scope_id=a.scope_id AND o.representation_id=a.representation_id AND o.policy_revision=t.policy_revision AND o.purpose=a.purpose AND o.profile_id='storefront.product-photo'
    WHERE m.tenant_id=$1 AND m.instance_id=$2 AND i.shop_id=$3 AND l.shop_id=$4 ORDER BY i.sku LIMIT 201`,
  [p.tenant_id,p.instance_id,p.supply_shop_id,p.storefront_shop_id])).rows;
  requireCondition(rows.length <= 200, 500, 'storefront_photo_invalid', '商品資料超出上限。');
  return rows.map(row => ({ product: ProductViewSchema.parse({ product_id: row.product_id, sku: row.sku, title: row.title,
    description: row.description, price_minor: Number(row.price_minor), stock: row.stock, currency: row.currency, version: row.version }),
    photo: row.asset_id === null ? null : storedPhoto(row) }));
}
export function privatePhotoView(p: Pick<Profile,'tenant_id'|'instance_id'>, item: PhotoProduct) {
  return projectPrivateProductMedia({ tenant_id:p.tenant_id,instance_id:p.instance_id,product_id:item.product.product_id,version:item.product.version },
    item.photo ? photoMetadata(item.photo.ref) : null);
}
export function draftMediaSnapshot(items: readonly PhotoProduct[]) {
  return publicationMediaSnapshot({ profile: HOSTED_STORE_MEDIA_PROFILE, photos: items.flatMap(item => item.photo ? [item.photo.ref] : []) });
}
/** Called after tenant context binding. Immutable publication refs never consult draft pointers. */
export async function publicationPhotos(q: PoolClient, publicationId: string, tenantId: string, instanceId: string) {
  const rows = (await q.query(`SELECT r.sku,r.asset_id,r.scope_id,r.representation_id,r.policy_revision,r.content_type,r.byte_size,r.content_sha256,r.transform_version,r.purpose,r.width,r.height,
      o.content_sha256 AS object_sha256,o.pixel_width AS object_width,o.pixel_height AS object_height
    FROM commerce_publication_photo_refs r
    JOIN assets a ON a.asset_id=r.asset_id AND a.scope_id=r.scope_id AND a.tenant_ref=r.tenant_id AND a.scope_kind='tenant' AND a.purpose=r.purpose AND a.state='ready' AND a.deletion_fence=0 AND a.representation_id=r.representation_id
    JOIN asset_objects o ON o.asset_id=a.asset_id AND o.scope_id=a.scope_id AND o.representation_id=a.representation_id AND o.policy_revision=r.policy_revision AND o.purpose=r.purpose AND o.profile_id='storefront.product-photo'
    WHERE r.publication_id=$1 AND r.tenant_id=$2 AND r.instance_id=$3 ORDER BY r.sku`, [publicationId,tenantId,instanceId])).rows;
  for (const row of rows) requireCondition(row.content_sha256===row.object_sha256 && row.width===row.object_width && row.height===row.object_height,500,'storefront_photo_invalid','商品照片資料不完整。');
  const photos = rows.map(storedPhoto);
  return { photos, snapshot: publicationMediaSnapshot({ profile:HOSTED_STORE_MEDIA_PROFILE,photos:photos.map(photo=>photo.ref) }) };
}
export async function insertPublicationPhotos(q: PoolClient, publicationId: string, p: Profile, items: readonly PhotoProduct[]) {
  for (const item of items) {
    if (!item.photo) continue;
    const {ref,scopeId,policyRevision}=item.photo;
    await q.query(`INSERT INTO commerce_publication_photo_refs(publication_id,sku,tenant_id,instance_id,scope_id,asset_id,representation_id,policy_revision,content_type,byte_size,content_sha256,transform_version,width,height)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [publicationId,ref.sku,p.tenant_id,p.instance_id,scopeId,ref.asset_id,ref.representation_id,policyRevision,ref.content_type,ref.byte_size,ref.sha256,ref.transform_version,ref.width,ref.height]);
  }
}
