import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { PublicStoreProjectionSchema, StorePreviewSchema, type PublicStoreProjection } from '../../../contracts/guild-launchpad/v1/storefront.js';
import { checkVersion, digest } from '../../../packages/db/index.js';
import { requireCondition } from '../../../packages/shared/problem.js';
import type { Actor } from '../../identity-membership/service.js';
import { profile, ready, storeCommand, storeRead, storeView, storeFact, type Profile } from './store.js';
import { products } from './products.js';

/** The same strict allowlist validates live preview, saved publication, and public reads. */
export function publicProjection(raw: unknown): PublicStoreProjection { return PublicStoreProjectionSchema.parse(raw); }
export function projectionDigest(projection: PublicStoreProjection): string {
  const { revision: _revision, published_at: _publishedAt, ...content } = projection;
  return digest(content);
}
async function nextRevision(q: PoolClient, p: Profile) {
  return (await q.query<{ revision: string }>(`SELECT (COALESCE(max(pub.revision),0)+1)::text AS revision FROM commerce_storefront_publications pub
    JOIN commerce_resource_tenants m ON m.instance_id=pub.instance_id AND m.tenant_id=pub.tenant_id
    WHERE m.tenant_id=$1 AND m.instance_id=$2 AND m.resource_id=$3`, [p.tenant_id, p.instance_id, p.storefront_shop_id])).rows[0].revision;
}
async function buildProjection(q: PoolClient, p: Profile) {
  const now = (await q.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now;
  return publicProjection({ slug: p.slug, name: p.name, brand: p.brand, description: p.description, currency: p.currency,
    products: (await products(q, p)).map(({ sku, title, description, price_minor }) => ({ sku, title, description, price_minor })),
    revision: await nextRevision(q, p), published_at: now.toISOString(), transaction_state: 'not_enabled' });
}
export async function previewStore(pool: Pool, actor: Actor, tenantId: string, instanceId: string) {
  return storeRead(pool, actor, tenantId, instanceId, 'store:read', async q => {
    const p = await profile(q, tenantId, instanceId); ready(p);
    let projection = await buildProjection(q, p);
    const dirty = projectionDigest(projection) !== p.projection_sha256;
    if (!dirty && p.projection) projection = publicProjection(p.projection);
    return StorePreviewSchema.parse({ projection, dirty, current_revision: p.revision });
  });
}
export async function publishStore(pool: Pool, actor: Actor, tenantId: string, instanceId: string, key: string, expected: string, unpublish = false) {
  const operation = unpublish ? 'storefront.unpublish' : 'storefront.publish';
  return storeCommand(pool, actor, tenantId, instanceId, 'store:publish', operation, {}, key, expected, async (q, context, inst) => {
    const p = await profile(q, tenantId, instanceId, true); ready(p); checkVersion(p.version, expected);
    if (unpublish) {
      if (!p.current_publication_id) return storeView(q, context, inst);
      await q.query(`UPDATE commerce_storefront_profiles p SET current_publication_id=NULL,version=p.version+1,updated_at=clock_timestamp()
        FROM commerce_resource_tenants m WHERE m.resource_id=p.storefront_shop_id AND m.tenant_id=$1 AND m.instance_id=$2 AND p.instance_id=m.instance_id`, [tenantId, instanceId]);
    } else {
      const projection = await buildProjection(q, p);
      requireCondition(projection.products.length > 0, 409, 'storefront_has_no_products', '請先新增至少一項商品再公開。');
      const hash = projectionDigest(projection);
      if (p.current_publication_id && p.projection_sha256 === hash) return storeView(q, context, inst);
      const id = randomUUID();
      await q.query(`INSERT INTO commerce_storefront_publications(publication_id,instance_id,tenant_id,revision,slug,projection,projection_sha256,published_by_principal_id,published_at)
        SELECT $1,m.instance_id,m.tenant_id,$4,$5,$6,$7,$8,$9 FROM commerce_resource_tenants m
        WHERE m.tenant_id=$2 AND m.instance_id=$3 AND m.resource_id=$10 AND m.mapping_state='confirmed'`,
      [id, tenantId, instanceId, projection.revision, p.slug, projection, hash, context.principal_id, projection.published_at, p.storefront_shop_id]);
      await q.query(`UPDATE commerce_storefront_profiles p SET current_publication_id=$3,first_published_at=COALESCE(p.first_published_at,$4),version=p.version+1,updated_at=clock_timestamp()
        FROM commerce_resource_tenants m WHERE m.resource_id=p.storefront_shop_id AND m.tenant_id=$1 AND m.instance_id=$2 AND p.instance_id=m.instance_id`, [tenantId, instanceId, id, projection.published_at]);
    }
    await storeFact(q, context, instanceId, String(BigInt(p.version) + 1n), operation);
    return storeView(q, context, inst);
  });
}
