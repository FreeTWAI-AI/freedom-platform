import type { Pool } from 'pg';
import { isolatedTransaction, bindTenantContext } from '../../../packages/resource-scopes/tenant-transaction.js';
import { publicProjection } from './publish.js';
import { StoreTemplateSchema } from '../../../contracts/guild-launchpad/v1/storefront-presentation.js';
import { SLUG_PATTERN } from './store.js';
import { publicationPhotos } from './photo-projection.js';
import { projectPublicStoreMedia } from './media.js';

/** The only unbound reader. It reads immutable projection bytes, then proves current RLS liveness. */
export async function readPublicStorePage(pool: Pool, rawSlug: string) {
  return isolatedTransaction(pool, async q => {
    await q.query('SET TRANSACTION READ ONLY');
    const slug = rawSlug.toLowerCase();
    if (!SLUG_PATTERN.test(slug)) return null;
    const row = (await q.query<{ tenant_id: string; instance_id: string; storefront_shop_id: string; supply_shop_id: string; publication_id: string; media_sha256:string; projection: unknown; template_id: unknown }>(`SELECT p.tenant_id,p.instance_id,p.storefront_shop_id,p.supply_shop_id,pub.publication_id,pub.media_sha256,pub.projection,pub.template_id
      FROM commerce_storefront_profiles p JOIN commerce_storefront_publications pub ON pub.publication_id=p.current_publication_id AND pub.instance_id=p.instance_id AND pub.tenant_id=p.tenant_id
      JOIN commerce_shops s ON s.shop_id=p.storefront_shop_id AND s.origin='hosted'
      WHERE p.slug=$1`, [slug])).rows[0];
    if (!row) return null;
    const scope = (await q.query<{ scope_id: string }>(`SELECT scope_id FROM resource_scopes WHERE kind='tenant' AND tenant_ref=$1 AND status='active'`, [row.tenant_id])).rows[0];
    if (!scope) return null;
    await bindTenantContext(q, { tenantId: row.tenant_id, tenantScopeId: scope.scope_id });
    const live = await q.query(`SELECT 1 FROM commerce_resource_tenants m
      JOIN module_instances i ON i.tenant_id=m.tenant_id AND i.instance_id=m.instance_id AND i.module_key='storefront' AND i.status='active'
      JOIN tenants t ON t.tenant_id=i.tenant_id AND t.status='active'
      JOIN deployment_bindings d ON d.tenant_id=i.tenant_id AND d.instance_id=i.instance_id AND d.binding_id=i.binding_id AND d.state='active'
      JOIN commerce_resource_tenants supply ON supply.resource_kind='shop' AND supply.resource_id=$4 AND supply.tenant_id=m.tenant_id AND supply.instance_id=m.instance_id AND supply.mapping_state='confirmed'
      JOIN commerce_shops supply_shop ON supply_shop.shop_id=supply.resource_id AND supply_shop.origin='hosted'
      WHERE EXISTS (SELECT 1 FROM tenant_memberships owner
        JOIN principals principal ON principal.principal_id=owner.principal_id AND principal.kind='person' AND principal.status='active'
        JOIN users u ON u.user_id=principal.user_ref AND u.active AND NOT is_verification_test_account(u.user_id)
        WHERE owner.tenant_id=t.tenant_id AND owner.role='owner' AND owner.status='active')
        AND m.tenant_id=$1 AND m.instance_id=$2 AND m.resource_kind='shop' AND m.resource_id=$3 AND m.mapping_state='confirmed'`, [row.tenant_id, row.instance_id, row.storefront_shop_id, row.supply_shop_id]);
    if (live.rowCount !== 1) return null;
    const projection = publicProjection(row.projection);
    const {photos,snapshot} = await publicationPhotos(q,row.publication_id,row.tenant_id,row.instance_id);
    const media = projectPublicStoreMedia(projection,snapshot.manifest,row.media_sha256);
    return { projection, template_id:StoreTemplateSchema.parse(row.template_id), media,
      publicationId:row.publication_id,tenantId:row.tenant_id,instanceId:row.instance_id,scopeId:scope.scope_id,
      mediaSha256:snapshot.sha256, photos };
  });
}

/** Existing public JSON stays exactly storefront/v1. */
export async function readPublicStore(pool: Pool, rawSlug: string) {
  return (await readPublicStorePage(pool, rawSlug))?.projection ?? null;
}
