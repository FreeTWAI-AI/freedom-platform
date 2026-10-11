import { performance } from 'node:perf_hooks';
import type { Pool, PoolClient } from 'pg';
import { OpaqueId, Version } from '../../../contracts/guild-launchpad/v1/primitives.js';
import {ReservationPageSchema, ReservationSettingInputSchema, ReservationSettingSchema} from '../../../contracts/guild-launchpad/v1/hosted-shared-order.js';
import type {SharedAuthority} from './shared-authority.js';
import { OrderPageQuerySchema, OrderPageSchema } from '../../../contracts/guild-launchpad/v1/hosted-order.js';
import { checkVersion } from '../../../packages/db/index.js';
import { assertCurrentSessionClock } from '../../../packages/db/member-session.js';
import type { TenantScopeContext } from '../../../packages/resource-scopes/index.js';
import { isolatedTransaction } from '../../../packages/resource-scopes/tenant-transaction.js';
import { scopedTenantCommand } from '../../../packages/scoped-commands/index.js';
import { requireCondition } from '../../../packages/shared/problem.js';
import { type TenantListCursorCodec, unavailableTenantListCursor } from '../../../packages/shared/tenant-list-cursor.js';
import type { Actor } from '../../identity-membership/service.js';
import { requireStoreInstance, storeCapabilities } from './capabilities.js';
import { profile, ready, storeFact, type Profile } from './store.js';
import { lockCommerceCommunity } from './direct-authority.js';
import { closeDirectOrder, directOrderProjection, directOrderProjections, lockDirectOrder, type DirectOrderRow } from './direct-effects.js';

type Operation = 'storefront.supplier.orders.list' | 'storefront.reservations.read' | 'storefront.reservations.configure' | 'storefront.seller.order.read' | 'storefront.seller.orders.list' | 'storefront.seller.order.cancel';
export interface SellerContext {
  tenant: TenantScopeContext; profile: Profile; operation: Operation;
  reservationDeadline?: Date; monotonicDeadline?: number; shared?: SharedAuthority;
}

/** Current real owner only. Existing installed manage capability is necessary;
 * neither an admin template nor an ordinary grant supplies the owner predicate. */
async function authorize(q: PoolClient, actor: Actor, tenant: TenantScopeContext, instanceId: string, requireLive = false): Promise<Profile> {
  requireCondition(tenant.role === 'owner', 403, 'seller_owner_required', '僅目前業務空間擁有者可管理預留訂單。');
  const eligible = await q.query(`SELECT 1 FROM users WHERE user_id=$1 AND active
    AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL) AND NOT is_verification_test_account(user_id)`, [actor.user_id]);
  requireCondition(eligible.rowCount === 1, 403, 'member_unavailable', '目前無法使用會員訂單。');
  const instance = (await q.query(`SELECT i.instance_id,i.binding_id,i.status FROM module_instances i
    JOIN module_definitions d ON d.module_key=i.module_key AND d.release_ref=i.module_release_ref
    WHERE i.tenant_id=$1 AND i.instance_id=$2 AND i.module_key='storefront'
      AND d.capabilities ? 'store:manage' FOR NO KEY UPDATE OF i`, [tenant.tenant_id, instanceId])).rows[0];
  requireCondition(instance, 404, 'hosted_order_not_found', '找不到這間商店或訂單。');
  await requireStoreInstance(q, tenant, instanceId, 'store:manage', false);
  const deployment = await q.query(`SELECT state FROM deployment_bindings WHERE tenant_id=$1 AND instance_id=$2 AND binding_id=$3 FOR SHARE`,
    [tenant.tenant_id, instanceId, instance.binding_id]);
  requireCondition(deployment.rowCount === 1, 404, 'hosted_order_not_found', '找不到這間商店或訂單。');
  if (requireLive) requireCondition(tenant.tenant_status === 'active' && instance.status === 'active' && deployment.rows[0].state === 'active',
    409, 'storefront_unavailable', '商店目前無法開放新預留。');
  // Retained read/release does not require a published/active instance or host
  // admission. Actual scope/member/owner and both shop mappings still apply.
  await lockCommerceCommunity(q, tenant.community_id);
  const p = await profile(q, tenant.tenant_id, instanceId, true); ready(p); return p;
}
async function decisionClock(q: PoolClient, context: SellerContext) {
  if (!context.reservationDeadline) return;
  const before = performance.now(), now = (await q.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now;
  const remaining = context.reservationDeadline.getTime() - now.getTime();
  requireCondition(remaining > 0, 409, 'reservation_clock_changed', '庫存保留狀態已更新，請重新讀取。');
  context.monotonicDeadline = before + remaining;
}

/** Receipt is a reference; query/cursor and current projection never become a
 * cached receipt DTO. This runner is module-owned, absent from request inputs. */
export async function sellerCommand<T>(pool: Pool, actor: Actor, tenantId: string, instanceId: string, operation: Operation,
  targetId: string, key: string, expected: string | undefined,
  run: (q: PoolClient, context: SellerContext) => Promise<{ id: string }>,
  project: (q: PoolClient, context: SellerContext, id: string) => Promise<T>, options: {includeShared?: boolean; body?: unknown; requireLive?: boolean} = {}): Promise<T> {
  OpaqueId.parse(tenantId); OpaqueId.parse(instanceId); OpaqueId.parse(targetId);
  let context!: SellerContext, output!: T;
  const clock = () => requireCondition(context.monotonicDeadline === undefined || performance.now() < context.monotonicDeadline,
    409, 'reservation_clock_changed', '庫存保留狀態已更新，請重新讀取。');
  const revalidate = async (q: PoolClient, tenant: TenantScopeContext) => {
    context.profile = await authorize(q, actor, tenant, instanceId, options.requireLive); await decisionClock(q, context);
  };
  await scopedTenantCommand(pool, { actor, tenantId, tenantLock: 'share', operation, body: options.body ?? { instance_id: instanceId }, key, expected,
    target: { kind: operation === 'storefront.seller.orders.list' ? 'storefront' : 'hosted_order', id: targetId }, capabilitiesForRole: storeCapabilities },
  async (q, tenant) => { context = { tenant, profile: await authorize(q, actor, tenant, instanceId, options.requireLive), operation, shared: options.includeShared ? {} : undefined }; },
  q => run(q, context), revalidate, clock, (source, command) => isolatedTransaction(source, async q => {
    const reference = await command(q);
    output = await project(q, context, (reference as { id: string }).id);
    await revalidate(q, context.tenant); await assertCurrentSessionClock(q, actor); clock();
    return reference;
  }));
  return output;
}
async function orderView(q: PoolClient, context: SellerContext, id: string) {
  const row = await closeDirectOrder(q, context, await lockDirectOrder(q, context, id, false));
  if (row.reservation_state === 'reserved' && (!context.reservationDeadline || row.expires_at < context.reservationDeadline)) context.reservationDeadline = row.expires_at;
  return directOrderProjection(q, context, row);
}
export async function readSellerOrder(pool: Pool, actor: Actor, tenantId: string, instanceId: string, orderId: string, includeShared = false) {
  return sellerCommand(pool, actor, tenantId, instanceId, 'storefront.seller.order.read', orderId, `seller-read-${orderId}`, undefined,
    async () => ({ id: orderId }), orderView, {includeShared});
}
export async function cancelSellerOrder(pool: Pool, actor: Actor, tenantId: string, instanceId: string, orderId: string, key: string, expected: string, includeShared = false) {
  Version.parse(expected);
  return sellerCommand(pool, actor, tenantId, instanceId, 'storefront.seller.order.cancel', orderId, key, expected,
    async (q, context) => {
      const row = await lockDirectOrder(q, context, orderId, false); checkVersion(row.reservation_version, expected);
      await closeDirectOrder(q, context, row, 'seller_cancelled'); return { id: orderId };
    }, orderView, {includeShared});
}
export async function listSellerOrders(pool: Pool, actor: Actor, tenantId: string, instanceId: string, rawQuery: unknown,
  cursors: TenantListCursorCodec = unavailableTenantListCursor, includeShared = false) {
  const query = OrderPageQuerySchema.parse(rawQuery);
  return sellerCommand(pool, actor, tenantId, instanceId, 'storefront.seller.orders.list', instanceId, `seller-list-${instanceId}`, undefined,
    async () => ({ id: instanceId }), async (q, context, id) => {
      requireCondition(id === instanceId, 409, 'receipt_reference_invalid', '訂單讀取狀態無效。');
      // Query is intentionally not the fixed read-reference digest. Every page,
      // including receipt hits, is parsed/verified after current owner authority.
      const current = OrderPageQuerySchema.parse(query), limit = current.limit ?? 20;
      const binding = { purpose: 'seller-orders' as const, principalId: context.tenant.principal_id,
        tenantId, scopeId: context.tenant.scope.scope_id, resourceId: instanceId, filter: includeShared ? '{"shared":true}' : '{}' };
      const after = cursors.decode(current.cursor, binding);
      requireCondition(!after || Object.keys(after).sort().join(',') === 'at,id'
        && typeof after.at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(after.at)
        && Number.isFinite(Date.parse(after.at)) && OpaqueId.safeParse(after.id).success,
      422, 'invalid_cursor', '分頁游標無效。');
      const rows = (await q.query<{ order_id: string; cursor_at: string }>(`SELECT o.order_id,
        to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
        FROM commerce_orders o JOIN commerce_order_quotes quote ON quote.quote_id=o.quote_id
          AND quote.public_shop_id=o.public_shop_id AND quote.buyer_principal_id=o.buyer_principal_id
        WHERE o.public_shop_id=$1 AND (o.order_profile='hosted_direct_reservation' OR $7::boolean AND o.order_profile='hosted_shared_reservation') AND quote.tenant_id=$2 AND quote.instance_id=$3
          AND ($4::timestamptz IS NULL OR (o.created_at,o.order_id)<($4::timestamptz,$5::uuid))
        ORDER BY o.created_at DESC,o.order_id DESC LIMIT $6`,
      [context.profile.storefront_shop_id, tenantId, instanceId, after?.at ?? null, after?.id ?? null, limit + 1, includeShared])).rows;
      const page = rows.slice(0, limit), ids = page.map(row => row.order_id).sort();
      if (ids.length) {
        await q.query('SELECT order_id FROM commerce_orders WHERE order_id=ANY($1::uuid[]) ORDER BY order_id FOR UPDATE', [ids]);
        await q.query(`SELECT item_id FROM commerce_items WHERE shop_id=$2 AND item_id IN
          (SELECT item_id FROM commerce_order_lines WHERE order_id=ANY($1::uuid[])) ORDER BY item_id FOR UPDATE`, [ids, context.profile.supply_shop_id]);
      }
      const loaded = ids.length ? (await q.query<DirectOrderRow>(`SELECT o.*,reservation_version::text AS reservation_version FROM commerce_orders o
        WHERE order_id=ANY($1::uuid[]) AND public_shop_id=$2 AND (order_profile='hosted_direct_reservation' OR $3::boolean AND order_profile='hosted_shared_reservation')`,
      [ids, context.profile.storefront_shop_id, includeShared])).rows : [];
      const byId = new Map(loaded.map(row => [row.order_id, row]));
      const decisionTime = loaded.some(row => row.reservation_state === 'reserved')
        ? (await q.query<{ now: Date }>("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0].now : undefined;
      const hydrated = [];
      for (const reference of page) {
        const saved = byId.get(reference.order_id);
        requireCondition(saved, 404, 'hosted_order_not_found', '找不到這份訂單。');
        const row = await closeDirectOrder(q, context, saved, false, decisionTime);
        if (row.reservation_state === 'reserved' && (!context.reservationDeadline || row.expires_at < context.reservationDeadline)) context.reservationDeadline = row.expires_at;
        hydrated.push(row);
      }
      const items = await directOrderProjections(q, context, hydrated);
      return (includeShared ? ReservationPageSchema : OrderPageSchema).parse({ items, next_cursor: rows.length > limit
        ? cursors.encode({ at: page[page.length - 1].cursor_at, id: page[page.length - 1].order_id }, binding) : null });
    }, {includeShared});
}

export async function readReservationSetting(pool: Pool, actor: Actor, tenantId: string, instanceId: string, admissionEnabled: boolean) {
  return sellerCommand(pool, actor, tenantId, instanceId, 'storefront.reservations.read', instanceId, `reservation-setting-${instanceId}`, undefined,
    async () => ({id:instanceId}), async (_q,context) => ReservationSettingSchema.parse({reservation_enabled:context.profile.reservation_enabled,
      admission_enabled:admissionEnabled === true, version:context.profile.version}));
}
export async function configureReservations(pool: Pool, actor: Actor, tenantId: string, instanceId: string, raw: unknown, key: string, expected: string, admissionEnabled: boolean) {
  const input = ReservationSettingInputSchema.parse(raw); Version.parse(expected);
  requireCondition(!input.reservation_enabled || admissionEnabled === true,409,'reservation_not_enabled','平台目前尚未開放新的預留。');
  return sellerCommand(pool,actor,tenantId,instanceId,'storefront.reservations.configure',instanceId,key,expected,
    async (q,context) => {
      checkVersion(context.profile.version,expected);
      if (context.profile.reservation_enabled !== input.reservation_enabled) {
        await q.query('UPDATE commerce_storefront_profiles SET reservation_enabled=$2,version=version+1 WHERE instance_id=$1',[instanceId,input.reservation_enabled]);
        await storeFact(q,context.tenant,instanceId,String(BigInt(expected)+1n),'storefront.reservations.configure');
      }
      return {id:instanceId};
    },async (q,context) => {
      const current = await profile(q,tenantId,instanceId); ready(current);
      return ReservationSettingSchema.parse({reservation_enabled:current.reservation_enabled,admission_enabled:admissionEnabled === true,version:current.version});
    },{body:{instance_id:instanceId,...input},requireLive:input.reservation_enabled});
}
