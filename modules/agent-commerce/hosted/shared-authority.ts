import type {PoolClient} from 'pg';
import {bindTenantContext, bindPrincipalContext, clearTenantContext} from '../../../packages/resource-scopes/tenant-transaction.js';
import {requireCondition} from '../../../packages/shared/problem.js';
import {profile, ready, type Profile} from './store.js';

export interface SharedAuthority {
  /** Closed, parsed buyer selectors. Never tenant/shop IDs supplied by a buyer. */
  skus?: readonly string[];
  quoteId?: string;
  principalId?: string;
  parties?: ReadonlyMap<string, {tenant_id: string; instance_id: string; scope_id: string}>;
}
async function bindParty(q: PoolClient, principalId: string, tenantId: string, scopeId: string) {
  // Explicitly end the prior RLS binding, as the existing managed-store listing
  // does. The generic single-tenant binder retains its refusal to switch tenants.
  await clearTenantContext(q); await bindPrincipalContext(q, principalId);
  await bindTenantContext(q, {tenantId,tenantScopeId:scopeId});
}

/** Acquire ALL participating tenant/instance lifecycle locks before the existing
 * commerce lock. Existing single-store writers use instance -> community. Taking
 * another instance after community would deadlock with supplier edits/revocation.
 * Rebinding only selects RLS for this closed command; it creates no membership. */
export async function lockSharedParties(q: PoolClient, buyer: string, seller: {tenant_id: string; instance_id: string}, shared: SharedAuthority) {
  shared.principalId = buyer;
  const target = (await q.query(`SELECT p.*,s.community_id FROM commerce_storefront_profiles p
    JOIN commerce_shops s ON s.shop_id=p.storefront_shop_id WHERE p.tenant_id=$1 AND p.instance_id=$2`, [seller.tenant_id, seller.instance_id])).rows[0];
  requireCondition(target, 404, 'hosted_order_not_found', '找不到這間商店或訂單。');
  // For submit the immutable quote, exact buyer and store are the only source.
  const selected = shared.quoteId
    ? (await q.query(`SELECT supplier.tenant_id,supplier.instance_id,s.community_id FROM commerce_order_quotes quote
        CROSS JOIN LATERAL jsonb_array_elements(quote.bindings) b
        JOIN commerce_items i ON i.item_id=(b->>'item_id')::uuid
        JOIN commerce_storefront_profiles supplier ON supplier.supply_shop_id=i.shop_id
        JOIN commerce_shops s ON s.shop_id=i.shop_id
        WHERE quote.quote_id=$1 AND quote.buyer_principal_id=$2 AND quote.public_shop_id=$3`, [shared.quoteId, buyer, target.storefront_shop_id])).rows
    : (await q.query(`SELECT supplier.tenant_id,supplier.instance_id,s.community_id FROM commerce_selections l
        JOIN commerce_items i USING(item_id) JOIN commerce_storefront_profiles supplier ON supplier.supply_shop_id=i.shop_id
        JOIN commerce_shops s ON s.shop_id=i.shop_id
        WHERE l.shop_id=$1 AND COALESCE(l.hosted_sku,i.sku)=ANY($2::text[])`, [target.storefront_shop_id, shared.skus ?? []])).rows;
  requireCondition(selected.every(row => row.community_id === target.community_id), 409, 'supply_unavailable', '供貨狀態已更新，請重新確認。');
  const targets = new Map<string, {tenant_id: string; instance_id: string}>([target, ...selected].map(row => [row.instance_id, row]));
  if (shared.parties) requireCondition(targets.size === shared.parties.size && [...targets.keys()].every(id => shared.parties!.has(id)),
    409, 'supply_unavailable', '供貨來源已更新，請重新確認。');
  const parties = new Map<string, {tenant_id: string; instance_id: string; scope_id: string}>();
  // One storefront per selected immutable profile; sort independently of input.
  for (const row of [...targets.values()].sort((a,b) => a.tenant_id.localeCompare(b.tenant_id) || a.instance_id.localeCompare(b.instance_id))) {
    const scope = (await q.query(`SELECT scope_id,status FROM resource_scopes WHERE kind='tenant' AND tenant_ref=$1 FOR SHARE`, [row.tenant_id])).rows[0];
    requireCondition(scope?.status === 'active', 409, 'supply_unavailable', '供貨空間目前無法接受新預留。');
    await bindParty(q, buyer, row.tenant_id, scope.scope_id);
    const tenant = (await q.query(`SELECT status FROM tenants WHERE tenant_id=$1 FOR SHARE`, [row.tenant_id])).rows[0];
    const instance = (await q.query(`SELECT i.status,i.binding_id FROM module_instances i
      JOIN module_definitions d ON d.module_key=i.module_key AND d.release_ref=i.module_release_ref
      WHERE i.tenant_id=$1 AND i.instance_id=$2 AND i.module_key='storefront'
      AND d.capabilities ? 'store:manage' FOR NO KEY UPDATE OF i`, [row.tenant_id, row.instance_id])).rows[0];
    const deployment = instance && (await q.query(`SELECT state FROM deployment_bindings WHERE tenant_id=$1 AND instance_id=$2
      AND binding_id=$3 FOR SHARE`, [row.tenant_id, row.instance_id, instance.binding_id])).rows[0];
    const owner = await q.query(`SELECT 1 FROM tenant_memberships m JOIN principals p ON p.principal_id=m.principal_id
      JOIN users u ON u.user_id=p.user_ref WHERE m.tenant_id=$1 AND m.role='owner' AND m.status='active'
      AND p.kind='person' AND p.status='active' AND u.active AND NOT is_verification_test_account(u.user_id) LIMIT 1`, [row.tenant_id]);
    requireCondition(tenant?.status === 'active' && instance?.status === 'active' && deployment?.state === 'active' && owner.rowCount === 1,
      409, 'supply_unavailable', '供貨商或商店目前無法接受新預留。');
    parties.set(row.instance_id, {...row, scope_id: scope.scope_id});
  }
  shared.parties = parties;
  const own = parties.get(seller.instance_id)!;
  await bindParty(q, buyer, seller.tenant_id, own.scope_id);
}

/** Called after the community lock. Both confirmed mappings, explicit supplier
 * admission and current currency are checked under that supplier's exact RLS.
 * The seller binding is restored even on failure; no private DTO leaves here. */
export async function sharedSupplier(q: PoolClient, seller: Profile, shared: SharedAuthority, instanceId: string): Promise<Profile> {
  const party = shared.parties?.get(instanceId), own = shared.parties?.get(seller.instance_id);
  requireCondition(party && own && shared.principalId, 409, 'supply_unavailable', '供貨來源已更新，請重新確認。');
  try {
    await bindParty(q, shared.principalId, party.tenant_id, party.scope_id);
    const supplier = await profile(q, party.tenant_id, party.instance_id); ready(supplier);
    requireCondition(supplier.reservation_enabled && supplier.currency === seller.currency,
      409, 'supply_unavailable', '供貨商尚未開放預留或幣別不符。');
    return supplier;
  } finally { await bindParty(q, shared.principalId, own.tenant_id, own.scope_id); }
}
