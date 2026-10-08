import type { Pool } from 'pg';
import { isolatedTransaction, bindTenantContext } from '../../../packages/resource-scopes/tenant-transaction.js';
import { publicProjection } from './publish.js';
import { SLUG_PATTERN } from './store.js';

/** The only unbound reader. It reads immutable projection bytes, then proves current RLS liveness. */
export async function readPublicStore(pool: Pool, rawSlug: string) {
  return isolatedTransaction(pool, async q => {
    await q.query('SET TRANSACTION READ ONLY');
    const slug = rawSlug.toLowerCase();
    if (!SLUG_PATTERN.test(slug)) return null;
    const row = (await q.query<{ tenant_id: string; instance_id: string; storefront_shop_id: string; projection: unknown }>(`SELECT p.tenant_id,p.instance_id,p.storefront_shop_id,pub.projection
      FROM commerce_storefront_profiles p JOIN commerce_storefront_publications pub ON pub.publication_id=p.current_publication_id AND pub.instance_id=p.instance_id AND pub.tenant_id=p.tenant_id
      JOIN commerce_shops s ON s.shop_id=p.storefront_shop_id AND s.origin='hosted'
      JOIN users u ON u.user_id=s.owner_id AND u.active AND NOT is_verification_test_account(u.user_id)
      WHERE p.slug=$1`, [slug])).rows[0];
    if (!row) return null;
    const scope = (await q.query<{ scope_id: string }>(`SELECT scope_id FROM resource_scopes WHERE kind='tenant' AND tenant_ref=$1 AND status='active'`, [row.tenant_id])).rows[0];
    if (!scope) return null;
    await bindTenantContext(q, { tenantId: row.tenant_id, tenantScopeId: scope.scope_id });
    const live = await q.query(`SELECT 1 FROM commerce_resource_tenants m
      JOIN module_instances i ON i.tenant_id=m.tenant_id AND i.instance_id=m.instance_id AND i.module_key='storefront' AND i.status='active'
      JOIN tenants t ON t.tenant_id=i.tenant_id AND t.status='active'
      WHERE m.tenant_id=$1 AND m.instance_id=$2 AND m.resource_kind='shop' AND m.resource_id=$3 AND m.mapping_state='confirmed'`, [row.tenant_id, row.instance_id, row.storefront_shop_id]);
    return live.rowCount === 1 ? publicProjection(row.projection) : null;
  });
}
