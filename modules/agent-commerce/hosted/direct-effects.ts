import type { PoolClient } from 'pg';
import { OrderSchema, QuoteSchema, type HostedOrder } from '../../../contracts/guild-launchpad/v1/hosted-order.js';
import { requireCondition } from '../../../packages/shared/problem.js';
import { directFact, type DirectContext, type DirectEffectContext } from './direct-authority.js';

export interface DirectOrderRow {
  order_id: string; public_shop_id: string; buyer_principal_id: string; client_order_id: string; quote_id: string;
  request_sha256: string; reservation_state: 'reserved' | 'cancelled' | 'expired'; reservation_version: string;
  created_at: Date; expires_at: Date; closed_at: Date | null; close_reason: string | null;
}
export async function lockDirectOrder(q: PoolClient, context: DirectEffectContext, id: string, buyerOnly = true): Promise<DirectOrderRow> {
  requireCondition(!buyerOnly || 'member' in context, 403, 'buyer_context_required', '需要本人訂單權限。');
  const row = (await q.query<DirectOrderRow>(`SELECT o.*,reservation_version::text AS reservation_version FROM commerce_orders o
    WHERE order_id=$1 AND public_shop_id=$2 AND order_profile='hosted_direct_reservation'
    AND ($3::uuid IS NULL OR buyer_principal_id=$3) FOR UPDATE`,
  [id, context.profile.storefront_shop_id, buyerOnly && 'member' in context ? context.member.subject_principal.principal_id : null])).rows[0];
  requireCondition(row, 404, 'hosted_order_not_found', '找不到這份訂單。');
  return row;
}

/** Same commerce_items balance and community writer lock as imported commerce.
 * Caller has instance -> community -> profile -> order locks. This direct-only
 * effect does not weaken imported expiry, payment, acceptance or transfer rules. */
export async function closeDirectOrder(q: PoolClient, context: DirectEffectContext, row: DirectOrderRow, cancel: false | 'buyer_cancelled' | 'seller_cancelled' = false): Promise<DirectOrderRow> {
  if (row.reservation_state !== 'reserved') return row;
  let now = (await q.query<{ now: Date }>("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0].now;
  if (now.getTime() < row.expires_at.getTime() && !cancel) return row;
  const items = (await q.query<{ item_id: string; quantity: number }>(`SELECT item_id,sum(quantity)::int AS quantity
    FROM commerce_order_lines WHERE order_id=$1 AND order_profile='hosted_direct_reservation' GROUP BY item_id ORDER BY item_id`, [row.order_id])).rows;
  for (const item of items) {
    const stock = (await q.query<{ reserved: number }>(`SELECT reserved FROM commerce_items WHERE item_id=$1 AND shop_id=$2 FOR UPDATE`, [item.item_id, context.profile.supply_shop_id])).rows[0];
    requireCondition(stock && stock.reserved >= item.quantity, 409, 'reservation_inconsistent', '庫存保留紀錄不一致。');
  }
  // A row-lock wait can cross expiry: decide terminal reason only after every
  // affected item lock, then fence cancellation across receipt storage too.
  now = (await q.query<{ now: Date }>("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0].now;
  const expired = now.getTime() >= row.expires_at.getTime();
  if (!expired) context.reservationDeadline = row.expires_at;
  for (const item of items) await q.query('UPDATE commerce_items SET reserved=reserved-$2 WHERE item_id=$1', [item.item_id, item.quantity]);
  const next = (await q.query<DirectOrderRow>(`UPDATE commerce_orders SET reservation_state=$2,reservation_version=reservation_version+1,closed_at=$3,close_reason=$4
    WHERE order_id=$1 AND reservation_state='reserved' AND reservation_version=$5
    RETURNING *,reservation_version::text AS reservation_version`,
  [row.order_id, expired ? 'expired' : 'cancelled', now, expired ? 'reservation_expired' : cancel, row.reservation_version])).rows[0];
  requireCondition(next, 409, 'reservation_conflict', '訂單狀態已變更。');
  await directFact(q, context, next.order_id, next.reservation_version, next.reservation_state);
  return next;
}
export async function expireDirectForItems(q: PoolClient, context: DirectContext, requested: readonly { item_id: string; quantity: number }[]) {
  const ids = new Set<string>();
  // A failed quote rolls back expiry too. A global first-100 batch can starve
  // item 101 forever, so select only the physically needed requested stock.
  // Each order line holds >=1 unit: at most shortage<=99 orders per requested
  // item suffice. With <=50 requested items this is bounded by 4950 orders.
  requireCondition(requested.length <= 50 && requested.every(r => Number.isInteger(r.quantity) && r.quantity > 0 && r.quantity <= 99),
    400, 'invalid_reservation_items', '商品數量無效。');
  for (const item of [...requested].sort((a, b) => a.item_id.localeCompare(b.item_id))) {
    const stock = (await q.query<{ stock: number; reserved: number }>('SELECT stock,reserved FROM commerce_items WHERE item_id=$1 AND shop_id=$2',
      [item.item_id, context.profile.supply_shop_id])).rows[0];
    requireCondition(stock, 409, 'quote_terms_changed', '商品已更新，請重新確認。');
    const shortage = Math.max(0, item.quantity - (stock.stock - stock.reserved));
    if (!shortage) continue;
    const rows = (await q.query<{ order_id: string }>(`SELECT o.order_id FROM commerce_orders o JOIN commerce_order_lines line USING(order_id)
      WHERE o.public_shop_id=$1 AND o.order_profile='hosted_direct_reservation' AND o.reservation_state='reserved'
      AND o.expires_at<=clock_timestamp() AND line.item_id=$2 ORDER BY o.order_id LIMIT $3`,
    [context.profile.storefront_shop_id, item.item_id, shortage])).rows;
    for (const row of rows) ids.add(row.order_id);
  }
  if (!ids.size) return;
  const ordered = [...ids].sort();
  await q.query('SELECT order_id FROM commerce_orders WHERE order_id=ANY($1::uuid[]) ORDER BY order_id FOR UPDATE', [ordered]);
  // Lock ALL affected items in one sorted pass before the first whole-order
  // release. Other lines of selected orders are released once as well.
  await q.query(`SELECT i.item_id FROM commerce_items i WHERE i.shop_id=$2 AND EXISTS
    (SELECT 1 FROM commerce_order_lines line WHERE line.order_id=ANY($1::uuid[]) AND line.item_id=i.item_id)
    ORDER BY i.item_id FOR UPDATE`, [ordered, context.profile.supply_shop_id]);
  for (const id of ordered) await closeDirectOrder(q, context, await lockDirectOrder(q, context, id, false));
  // No virtual availability; caller rereads the actual reserved balance.
}
export async function directOrderView(q: PoolClient, context: DirectContext, id: string): Promise<HostedOrder> {
  // A addressed order is expired independently of the bounded batch cutoff.
  const row = await closeDirectOrder(q, context, await lockDirectOrder(q, context, id));
  if (row.reservation_state === 'reserved') context.reservationDeadline = row.expires_at;
  return directOrderProjection(q, context, row);
}
/** Caller has already locked/authorized this exact direct row. Both actor paths
 * share the same allowlist; private buyer bindings never enter the DTO. */
export async function directOrderProjection(q: PoolClient, context: DirectEffectContext, row: DirectOrderRow): Promise<HostedOrder> {
  const saved = (await q.query(`SELECT terms FROM commerce_order_quotes WHERE quote_id=$1 AND public_shop_id=$2 AND buyer_principal_id=$3
    AND tenant_id=$4 AND instance_id=$5`,
    [row.quote_id, context.profile.storefront_shop_id, row.buyer_principal_id, context.profile.tenant_id, context.profile.instance_id])).rows[0];
  requireCondition(saved, 404, 'hosted_order_not_found', '找不到這份訂單。');
  const { quote_id, quoted_at: _quoted, expires_at: _expires, reserves_stock: _reserves, ...terms } = QuoteSchema.parse(saved.terms);
  return OrderSchema.parse({ ...terms, quote_id, order_id: row.order_id, client_order_id: row.client_order_id, version: row.reservation_version,
    state: row.reservation_state, created_at: row.created_at.toISOString(), reservation_expires_at: row.expires_at.toISOString(),
    closed_at: row.closed_at?.toISOString() ?? null, close_reason: row.close_reason });
}
