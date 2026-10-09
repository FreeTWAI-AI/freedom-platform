import type {Pool, PoolClient} from 'pg';
import {SupplyTermsInputSchema, SupplyTermsSchema} from '../../../contracts/guild-launchpad/v1/hosted-supply-terms.js';
import {checkVersion} from '../../../packages/db/index.js';
import {requireCondition} from '../../../packages/shared/problem.js';
import type {Actor} from '../../identity-membership/service.js';
import {profile, ready, storeCommand, storeFact, storeRead, type Profile} from './store.js';

/** Both sides of this own-product selection must still have confirmed tenant mappings. */
async function terms(q: PoolClient, p: Profile, productId: string) {
  const row = (await q.query(`SELECT i.item_id AS product_id,i.price_minor AS cost_minor,i.shipping_minor,
    i.shipping_terms,i.return_terms,i.stock,i.reserved,i.stock-i.reserved AS available,
    s.currency,l.aggregate_version::text AS version
    FROM commerce_items i JOIN commerce_selections l ON l.item_id=i.item_id
    JOIN commerce_resource_tenants supply ON supply.resource_kind='shop' AND supply.resource_id=i.shop_id AND supply.mapping_state='confirmed'
    JOIN commerce_resource_tenants retail ON retail.resource_kind='shop' AND retail.resource_id=l.shop_id AND retail.mapping_state='confirmed'
      AND retail.tenant_id=supply.tenant_id AND retail.instance_id=supply.instance_id
    JOIN commerce_shops s ON s.shop_id=i.shop_id AND s.origin='hosted'
    JOIN commerce_shops shop ON shop.shop_id=l.shop_id AND shop.origin='hosted'
    WHERE supply.tenant_id=$1 AND supply.instance_id=$2 AND i.shop_id=$3 AND l.shop_id=$4 AND i.item_id=$5`,
  [p.tenant_id, p.instance_id, p.supply_shop_id, p.storefront_shop_id, productId])).rows[0];
  requireCondition(row, 404, 'not_found', '找不到這項商品。');
  return SupplyTermsSchema.parse({...row, cost_minor: Number(row.cost_minor), shipping_minor: Number(row.shipping_minor), transaction_state: 'not_enabled'});
}

export async function readSupplyTerms(pool: Pool, actor: Actor, tenantId: string, instanceId: string, productId: string) {
  return storeRead(pool, actor, tenantId, instanceId, 'store:write', async q => {
    const p = await profile(q, tenantId, instanceId); ready(p);
    return terms(q, p, productId);
  });
}

export async function updateSupplyTerms(pool: Pool, actor: Actor, tenantId: string, instanceId: string, productId: string, raw: unknown, key: string, expected: string) {
  const input = SupplyTermsInputSchema.parse(raw);
  return storeCommand(pool, actor, tenantId, instanceId, 'store:write', 'storefront.supply-terms.update', input, key, expected, async (q, context) => {
    const p = await profile(q, tenantId, instanceId, true); ready(p);
    const old = await terms(q, p, productId); checkVersion(old.version, expected);
    // This first slice prepares private terms. Foreign listings need versioned
    // offer/consent handling before their supplier can edit through this path.
    const foreign = await q.query('SELECT 1 FROM commerce_selections WHERE item_id=$1 AND shop_id<>$2 LIMIT 1', [productId, p.storefront_shop_id]);
    requireCondition(!foreign.rowCount, 409, 'supply_terms_in_use', '這項商品已有其他商店選用，請先處理既有供貨版本。');
    await q.query(`UPDATE commerce_items i SET price_minor=$4,shipping_minor=$5,shipping_terms=$6,return_terms=$7
      FROM commerce_resource_tenants m WHERE m.resource_kind='shop' AND m.resource_id=i.shop_id
      AND m.mapping_state='confirmed' AND m.tenant_id=$1 AND m.instance_id=$2 AND i.item_id=$3`,
    [tenantId, instanceId, productId, input.cost_minor, input.shipping_minor, input.shipping_terms, input.return_terms]);
    await q.query(`UPDATE commerce_selections SET aggregate_version=aggregate_version+1
      WHERE shop_id=$1 AND item_id=$2`, [p.storefront_shop_id, productId]);
    await storeFact(q, context, productId, String(BigInt(old.version) + 1n), 'storefront.supply-terms.update', 'storefront_product');
    return terms(q, p, productId);
  }, productId);
}
