import type {PoolClient} from 'pg';
import {bindTenantContext, clearTenantContext, bindPrincipalContext} from '../../../packages/resource-scopes/tenant-transaction.js';
import {Problem,requireCondition} from '../../../packages/shared/problem.js';
import {lockCommerceCommunity} from '../hosted/direct-authority.js';
import {profile, ready, type Profile} from '../hosted/store.js';

/** A store selector is never tenant authority. Resolve the stored profile first. */
export type CheckoutStore = Pick<Profile,'storefront_shop_id'>;
export interface StoreContext {profile: Profile; communityId: string; parties: Map<string,Profile>}
export async function bindStore(q: PoolClient, tenantId: string) {
  const principal = (await q.query("SELECT nullif(current_setting('freedom.principal_id',true),'') AS id")).rows[0].id as string | null;
  const scope = (await q.query("SELECT scope_id FROM resource_scopes WHERE kind='tenant' AND tenant_ref=$1",[tenantId])).rows[0];
  requireCondition(scope,404,'checkout_store_not_found','找不到商店。');
  await clearTenantContext(q);
  if (principal) await bindPrincipalContext(q,principal);
  await bindTenantContext(q,{tenantId,tenantScopeId:scope.scope_id});
}
/** All lifecycle locks precede community; item provenance is discovered from
 * server selections or retained order lines, never a supplied supplier map. */
export async function lockStore(q: PoolClient, store: CheckoutStore, skus: readonly string[] = [], orderIds: readonly string[] = [], live = true): Promise<StoreContext> {
  return resolveCheckoutStore(q,store,skus,orderIds,live,true);
}
/** The cart snapshot uses the same provenance/liveness resolver without locks or writes. */
export async function readCheckoutStore(q:PoolClient,store:CheckoutStore,skus:readonly string[]) {
  return resolveCheckoutStore(q,store,skus,[],true,false);
}
async function resolveCheckoutStore(q:PoolClient,store:CheckoutStore,skus:readonly string[],orderIds:readonly string[],live:boolean,lock:boolean):Promise<StoreContext> {
  const seller = (await q.query(`SELECT p.*,s.community_id FROM commerce_storefront_profiles p JOIN commerce_shops s ON s.shop_id=p.storefront_shop_id
    WHERE p.storefront_shop_id=$1 AND s.origin='hosted'`,[store.storefront_shop_id])).rows[0];
  requireCondition(seller,404,'checkout_store_not_found','找不到商店。');
  const sources = (await q.query(`SELECT DISTINCT source.tenant_id,source.instance_id,s.community_id FROM commerce_items i
    JOIN commerce_storefront_profiles source ON source.supply_shop_id=i.shop_id JOIN commerce_shops s ON s.shop_id=i.shop_id AND s.origin='hosted'
    WHERE EXISTS(SELECT 1 FROM commerce_selections l WHERE l.item_id=i.item_id AND l.shop_id=$1 AND COALESCE(l.hosted_sku,i.sku)=ANY($2::text[]))
      OR EXISTS(SELECT 1 FROM commerce_order_lines l JOIN commerce_checkout_orders co USING(order_id)
        WHERE l.item_id=i.item_id AND l.order_id=ANY($3::uuid[]) AND co.instance_id=$4)`,
  [seller.storefront_shop_id,skus,orderIds,seller.instance_id])).rows;
  if(lock)requireCondition(sources.every(s => s.community_id===seller.community_id),409,'supply_unavailable','供貨來源無法使用。');
  const parties = new Map<string,Profile>();
  const discovered = new Map([seller,...sources].map(s => [s.instance_id,s]));
  for (const row of [...discovered.values()].sort((a,b) => a.tenant_id.localeCompare(b.tenant_id)||a.instance_id.localeCompare(b.instance_id))) {
    const optionalSupplier=!lock&&row.instance_id!==seller.instance_id;
    if(optionalSupplier&&row.community_id!==seller.community_id)continue;
    try {
      await bindStore(q,row.tenant_id);
      const scope=(await q.query(`SELECT status FROM resource_scopes WHERE kind='tenant' AND tenant_ref=$1 ${lock?'FOR SHARE':''}`,[row.tenant_id])).rows[0];
      const tenant=(await q.query(`SELECT status FROM tenants WHERE tenant_id=$1 ${lock?'FOR SHARE':''}`,[row.tenant_id])).rows[0];
      const inst=(await q.query(`SELECT status,binding_id FROM module_instances WHERE tenant_id=$1 AND instance_id=$2 AND module_key='storefront' ${lock?'FOR NO KEY UPDATE':''}`,[row.tenant_id,row.instance_id])).rows[0];
      requireCondition(inst,404,'checkout_store_not_found','找不到商店。');
      const deployment=(await q.query(`SELECT state FROM deployment_bindings WHERE tenant_id=$1 AND instance_id=$2 AND binding_id=$3 ${lock?'FOR SHARE':''}`,[row.tenant_id,row.instance_id,inst.binding_id])).rows[0];
      if (live) {
        const owner=await q.query(`SELECT 1 FROM tenant_memberships m JOIN principals p USING(principal_id) JOIN users u ON u.user_id=p.user_ref
          WHERE m.tenant_id=$1 AND m.role='owner' AND m.status='active' AND p.status='active' AND p.kind='person'
            AND u.active AND NOT is_verification_test_account(u.user_id) LIMIT 1`,[row.tenant_id]);
        requireCondition(scope?.status==='active' && tenant?.status==='active' && inst.status==='active' && deployment?.state==='active' && owner.rowCount===1,
          409,'storefront_unavailable','商店目前無法接受新訂單。');
      }
      const p=await profile(q,row.tenant_id,row.instance_id);ready(p);parties.set(p.instance_id,p);
    } catch(error) {
      if(!optionalSupplier||!(error instanceof Problem&&['checkout_store_not_found','storefront_unavailable','storefront_not_set_up'].includes(error.code)))throw error;
    }
  }
  await bindStore(q,seller.tenant_id);
  if(lock)await lockCommerceCommunity(q,seller.community_id);
  const current=await profile(q,seller.tenant_id,seller.instance_id,lock);ready(current);
  parties.set(current.instance_id,current);
  return {profile:current,communityId:seller.community_id,parties};
}
/** Existing-order machine path deliberately takes no lifecycle/instance locks. */
export async function lockMachineOrder(q: PoolClient, orderId: string) {
  const target=(await q.query(`SELECT p.instance_id,p.tenant_id,s.community_id FROM commerce_checkout_orders co
    JOIN commerce_orders o USING(order_id) JOIN commerce_storefront_profiles p ON p.instance_id=co.instance_id AND p.tenant_id=co.tenant_id
    JOIN commerce_shops s ON s.shop_id=o.public_shop_id AND s.shop_id=p.storefront_shop_id WHERE co.order_id=$1`,[orderId])).rows[0];
  requireCondition(target,404,'checkout_order_not_found','找不到訂單。');
  await lockCommerceCommunity(q,target.community_id);
  await q.query('SELECT 1 FROM commerce_storefront_profiles WHERE instance_id=$1 AND tenant_id=$2 FOR UPDATE',[target.instance_id,target.tenant_id]);
  return target;
}
