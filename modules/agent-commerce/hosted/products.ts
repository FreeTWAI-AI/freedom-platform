import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ProductInputSchema, ProductUpdateInputSchema, ProductViewSchema, ProductPageSchema, ProductRemovedSchema, type ProductView } from '../../../contracts/guild-launchpad/v1/storefront.js';
import { checkVersion } from '../../../packages/db/index.js';
import { requireCondition } from '../../../packages/shared/problem.js';
import type { Actor } from '../../identity-membership/service.js';
import { profile, ready, productCount, storeCommand, storeRead, storeFact, type Profile } from './store.js';

const SHIPPING = '交易尚未啟用；運送方式尚未設定。';
const RETURNS = '交易尚未啟用；退換貨規則尚未設定。';
export function productSnapshot(p: Pick<ProductView, 'sku' | 'title' | 'description' | 'price_minor' | 'currency'>) {
  return { sku: p.sku, title: p.title, description: p.description, price_minor: p.price_minor, currency: p.currency,
    shipping_minor: 0, shipping_terms: SHIPPING, return_terms: RETURNS };
}
/** Product identity is the existing item; its concurrency version is the selection's. */
export async function products(q: PoolClient, p: Profile): Promise<ProductView[]> {
  const rows = (await q.query(`SELECT i.item_id AS product_id,i.sku,i.title,i.description,l.retail_price_minor AS price_minor,i.stock,s.currency,l.aggregate_version::text AS version
    FROM commerce_items i JOIN commerce_selections l ON l.item_id=i.item_id
    JOIN commerce_resource_tenants m ON m.resource_kind='shop' AND m.resource_id=i.shop_id AND m.mapping_state='confirmed'
    JOIN commerce_resource_tenants retail ON retail.resource_kind='shop' AND retail.resource_id=l.shop_id AND retail.mapping_state='confirmed' AND retail.tenant_id=m.tenant_id AND retail.instance_id=m.instance_id
    JOIN commerce_shops s ON s.shop_id=l.shop_id AND s.origin='hosted'
    JOIN commerce_shops supply ON supply.shop_id=i.shop_id AND supply.origin='hosted'
    WHERE m.tenant_id=$1 AND m.instance_id=$2 AND i.shop_id=$3 AND l.shop_id=$4 ORDER BY i.sku LIMIT 201`,
  [p.tenant_id, p.instance_id, p.supply_shop_id, p.storefront_shop_id])).rows;
  return rows.map(row => ProductViewSchema.parse({ ...row, price_minor: Number(row.price_minor) }));
}
export async function listProducts(pool: Pool, actor: Actor, tenantId: string, instanceId: string) {
  return storeRead(pool, actor, tenantId, instanceId, 'store:read', async q => {
    const p = await profile(q, tenantId, instanceId); ready(p);
    return ProductPageSchema.parse({ items: await products(q, p), limit: 200 });
  });
}
export async function addProduct(pool: Pool, actor: Actor, tenantId: string, instanceId: string, raw: unknown, key: string) {
  const parsed = ProductInputSchema.parse(raw);
  const input = { ...parsed, description: parsed.description ?? '', stock: parsed.stock ?? 0 };
  return storeCommand(pool, actor, tenantId, instanceId, 'store:write', 'storefront.product.create', input, key, undefined, async (q, context) => {
    const p = await profile(q, tenantId, instanceId, true); ready(p);
    requireCondition(await productCount(q, p) < 200, 409, 'storefront_product_limit', '每間商店最多 200 項商品。');
    const sku = 'P' + String(p.product_seq + 1).padStart(4, '0'), productId = randomUUID();
    await q.query(`UPDATE commerce_storefront_profiles p SET product_seq=p.product_seq+1
      FROM commerce_resource_tenants m WHERE m.resource_id=p.supply_shop_id AND m.tenant_id=$1 AND m.instance_id=$2 AND p.instance_id=m.instance_id`, [tenantId, instanceId]);
    await q.query(`INSERT INTO commerce_items(item_id,shop_id,sku,title,description,price_minor,stock,photo_url,reserved,shipping_minor,shipping_terms,return_terms)
      SELECT $1,m.resource_id,$4,$5,$6,$7,$8,NULL,0,0,$9,$10 FROM commerce_resource_tenants m
      WHERE m.tenant_id=$2 AND m.instance_id=$3 AND m.resource_id=$11 AND m.resource_kind='shop' AND m.mapping_state='confirmed'`,
    [productId, tenantId, instanceId, sku, input.title, input.description, input.price_minor, input.stock, SHIPPING, RETURNS, p.supply_shop_id]);
    const result = ProductViewSchema.parse({ product_id: productId, sku, ...input, currency: p.currency, version: '1' });
    await q.query(`INSERT INTO commerce_selections(selection_id,shop_id,item_id,retail_price_minor,sale_terms,snapshot)
      SELECT $1,m.resource_id,$4,$5,'交易尚未啟用。',$6 FROM commerce_resource_tenants m
      WHERE m.tenant_id=$2 AND m.instance_id=$3 AND m.resource_id=$7 AND m.resource_kind='shop' AND m.mapping_state='confirmed'`,
    [randomUUID(), tenantId, instanceId, productId, input.price_minor, productSnapshot(result), p.storefront_shop_id]);
    await storeFact(q, context, productId, '1', 'storefront.product.create', 'storefront_product');
    return result;
  });
}
export async function updateProduct(pool: Pool, actor: Actor, tenantId: string, instanceId: string, productId: string, raw: unknown, key: string, expected: string) {
  const input = ProductUpdateInputSchema.parse(raw);
  return storeCommand(pool, actor, tenantId, instanceId, 'store:write', 'storefront.product.update', input, key, expected, async (q, context) => {
    const p = await profile(q, tenantId, instanceId, true); ready(p);
    const old = (await products(q, p)).find(item => item.product_id === productId);
    requireCondition(old, 404, 'not_found', '找不到這項商品。'); checkVersion(old.version, expected);
    const next = ProductViewSchema.parse({ ...old, ...input, version: String(BigInt(old.version) + 1n) });
    const stock = (await q.query<{ reserved: number }>('SELECT reserved FROM commerce_items WHERE item_id=$1 FOR UPDATE', [productId])).rows[0];
    requireCondition(stock && next.stock >= stock.reserved, 409, 'stock_below_reserved', '庫存不能低於已保留的數量。');
    // Retail pricing belongs to the selection. Editing it must not overwrite
    // the supplier's cost on the single inventory item.
    await q.query(`UPDATE commerce_items i SET title=$4,description=$5,stock=$6
      FROM commerce_resource_tenants m WHERE m.resource_id=i.shop_id AND m.tenant_id=$1 AND m.instance_id=$2 AND i.item_id=$3`,
    [tenantId, instanceId, productId, next.title, next.description, next.stock]);
    await q.query(`UPDATE commerce_selections l SET retail_price_minor=$4,snapshot=$5,aggregate_version=l.aggregate_version+1
      FROM commerce_resource_tenants m WHERE m.resource_id=l.shop_id AND m.tenant_id=$1 AND m.instance_id=$2 AND l.item_id=$3`,
    [tenantId, instanceId, productId, next.price_minor, productSnapshot(next)]);
    await storeFact(q, context, productId, next.version, 'storefront.product.update', 'storefront_product');
    return next;
  }, productId);
}
export async function removeProduct(pool: Pool, actor: Actor, tenantId: string, instanceId: string, productId: string, key: string, expected: string) {
  return storeCommand(pool, actor, tenantId, instanceId, 'store:write', 'storefront.product.remove', {}, key, expected, async (q, context) => {
    const p = await profile(q, tenantId, instanceId, true); ready(p);
    const old = (await products(q, p)).find(item => item.product_id === productId);
    requireCondition(old, 404, 'not_found', '找不到這項商品。'); checkVersion(old.version, expected);
    const refs = await q.query(`SELECT 1 FROM commerce_order_lines WHERE item_id=$1 UNION ALL
      SELECT 1 FROM commerce_distribution_acceptances a JOIN commerce_selections l USING(selection_id) WHERE l.item_id=$1`, [productId]);
    requireCondition(!refs.rowCount, 409, 'storefront_product_in_use', '這項商品已有交易或供貨紀錄，不能移除。');
    await q.query(`DELETE FROM commerce_selections l USING commerce_resource_tenants m WHERE m.resource_id=l.shop_id AND m.tenant_id=$1 AND m.instance_id=$2 AND l.item_id=$3`, [tenantId, instanceId, productId]);
    await q.query(`DELETE FROM commerce_items i USING commerce_resource_tenants m WHERE m.resource_id=i.shop_id AND m.tenant_id=$1 AND m.instance_id=$2 AND i.item_id=$3`, [tenantId, instanceId, productId]);
    await storeFact(q, context, productId, String(BigInt(old.version) + 1n), 'storefront.product.remove', 'storefront_product');
    return ProductRemovedSchema.parse({ product_id: productId, removed: true });
  }, productId);
}
