import type { PoolClient } from 'pg';
import { OpaqueId } from '../../../contracts/common/v1/identity.js';
import { checkVersion } from '../../../packages/db/index.js';
import type { TenantScopeContext } from '../../../packages/resource-scopes/index.js';
import { requireCondition } from '../../../packages/shared/problem.js';
import type { LifecycleIntent, LifecyclePublication, LifecycleTarget } from '../../assets/engine.js';
import type { StorefrontPhotoActor } from './photo-authority.js';
import { profile, ready } from './store.js';

export interface PhotoCompletion { productId: string; completedVersion: string; intentId: string }

/** Core holds the named commerce boundary AND capacity/media policy locks first.
 * Exact item and selection remain the product and version authorities. */
export async function lockCurrentPhotoProduct(q: PoolClient, context: TenantScopeContext, actor: StorefrontPhotoActor,
  rawProductId: string, create: boolean): Promise<LifecycleTarget> {
  const productId = OpaqueId.parse(rawProductId);
  requireCondition(context.tenant_id === actor.tenant_id, 404, 'not_found', '找不到這項商品。');
  const p = await profile(q, context.tenant_id, actor.instance_id); ready(p);
  const item = await q.query(`SELECT item_id FROM commerce_items WHERE item_id=$1 AND shop_id=$2 ORDER BY item_id FOR UPDATE`, [productId, p.supply_shop_id]);
  requireCondition(item.rowCount === 1, 404, 'not_found', '找不到這項商品。');
  const selection = (await q.query<{ version: string }>(`SELECT aggregate_version::text AS version FROM commerce_selections
    WHERE item_id=$1 AND shop_id=$2 ORDER BY selection_id FOR UPDATE`, [productId, p.storefront_shop_id])).rows[0];
  requireCondition(selection, 404, 'not_found', '找不到這項商品。');
  if (create) await q.query(`INSERT INTO commerce_product_photo_targets(product_id,tenant_id,instance_id,scope_id)
    VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [productId, context.tenant_id, actor.instance_id, context.scope.scope_id]);
  const pointer = (await q.query<{ asset_id: string | null }>(`SELECT asset_id FROM commerce_product_photo_targets
    WHERE product_id=$1 AND tenant_id=$2 AND instance_id=$3 AND scope_id=$4 FOR UPDATE`,
  [productId, context.tenant_id, actor.instance_id, context.scope.scope_id])).rows[0];
  return { targetId: productId, aggregateVersion: selection.version, assetId: pointer?.asset_id ?? null };
}

/** Engine has already acquired all locks, checked CAS and marked the exact Asset
 * ready. No policy/target lock acquisition or external I/O is allowed here. */
export async function publishPhotoPointer(q: PoolClient, context: TenantScopeContext, actor: StorefrontPhotoActor,
  intent: LifecycleIntent, target: LifecycleTarget): Promise<LifecyclePublication<PhotoCompletion>> {
  const bound = intent as LifecycleIntent & { target_product_id?: string; target_instance_id?: string; target_tenant_id?: string };
  requireCondition(bound.target_product_id === target.targetId && bound.target_instance_id === actor.instance_id
    && bound.target_tenant_id === context.tenant_id && intent.scope_id === context.scope.scope_id
    && intent.purpose === 'storefront.product-photo' && intent.state === 'stored',
  409, 'asset_source_mismatch', '上傳內容與商品不同。');
  checkVersion(target.aggregateVersion, intent.expected_version);
  const p = await profile(q, context.tenant_id, actor.instance_id); ready(p);
  const next = (await q.query<{ version: string }>(`UPDATE commerce_selections SET aggregate_version=aggregate_version+1
    WHERE item_id=$1 AND shop_id=$2 AND aggregate_version=$3 RETURNING aggregate_version::text AS version`,
  [target.targetId, p.storefront_shop_id, intent.expected_version])).rows[0];
  requireCondition(next, 412, 'version_conflict', '商品版本已改變。');
  const linked = await q.query(`UPDATE commerce_product_photo_targets SET asset_id=$5,representation_id=$6,policy_revision=$7,linked_at_product_version=$8
    WHERE product_id=$1 AND tenant_id=$2 AND instance_id=$3 AND scope_id=$4`,
  [target.targetId, context.tenant_id, actor.instance_id, context.scope.scope_id, intent.asset_id, intent.representation_id, intent.policy_revision, next.version]);
  requireCondition(linked.rowCount === 1, 404, 'not_found', '找不到這項商品。');
  return { aggregateVersion: next.version,
    result: { productId: target.targetId, completedVersion: next.version, intentId: intent.intent_id },
    fact: { aggregateType: 'storefront_product', id: target.targetId, data: { resource_id: target.targetId, version: next.version } } };
}
