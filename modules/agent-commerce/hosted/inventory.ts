import type { PoolClient } from 'pg';
import { requireCondition } from '../../../packages/shared/problem.js';
import type { DirectEffectContext } from './direct-authority.js';

export interface InventoryBalance {
  item_id: string;
  stock: number;
  reserved: number;
  available: number;
}

export interface InventoryReservation {
  reservation_id: string;
  order_id: string;
  item_id: string;
  supplier_shop_id: string;
  quantity: number;
  state: 'held' | 'released';
  created_at: Date;
  expires_at: Date;
  released_at: Date | null;
}

export interface InventoryAllocation {
  allocation_id:string; order_id:string; item_id:string; supplier_shop_id:string; quantity:number;
  shipped_quantity:number; released_quantity:number; source_reservation_id:string|null; payment_application_id:string;
}
/** Paid-inventory sibling port. The checkout adapter derives shop authority
 * from retained lines; callers supply item/event references, never a tenant. */
export interface CheckoutInventory {
  convert(itemId:string,applicationId:string):Promise<InventoryAllocation>;
  allocate(itemId:string,applicationId:string):Promise<InventoryAllocation>;
  releaseAllocation(itemId:string,quantity:number,commandRef:string):Promise<void>;
  ship(itemId:string,quantity:number,shipmentRef:string):Promise<void>;
  restock(itemId:string,quantity:number,returnRef:string):Promise<void>;
}

export interface InventoryPosition {stock:number; held:number; allocated:number; available:number}
/** Internal read; callers authorize item access. Never supplies tenant authority.
 * Available is the physical balance, including due holds until settlement. */
export async function inventoryPositions(q:PoolClient,itemIds:readonly string[]):Promise<ReadonlyMap<string,InventoryPosition>> {
  const rows=(await q.query<{item_id:string;stock:number;reserved:number;held:number;allocated:number}>(`SELECT i.item_id,i.stock,i.reserved,
    (SELECT coalesce(sum(h.quantity),0)::int FROM commerce_inventory_reservations h WHERE h.item_id=i.item_id AND h.state='held') AS held,
    (SELECT coalesce(sum(a.quantity-a.shipped_quantity-a.released_quantity),0)::int FROM commerce_inventory_allocations a WHERE a.item_id=i.item_id) AS allocated
    FROM commerce_items i WHERE i.item_id=ANY($1::uuid[]) ORDER BY i.item_id`,[[...new Set(itemIds)].sort()])).rows;
  for(const row of rows)requireCondition(row.reserved===row.held+row.allocated,409,'reservation_inconsistent','庫存紀錄不一致。');
  return new Map(rows.map(r=>[r.item_id,{stock:r.stock,held:r.held,allocated:r.allocated,available:r.stock-r.reserved}]));
}

/** Internal transaction port. Durable holds give retries a stable identity;
 * the caller still authorizes and locks the order before sorted item locks.
 * This is not a remote protocol: network effects require a separate durable
 * coordinator, unknown-result recovery and writer authority handoff. */
export interface ReservationInventory {
  status(itemId: string): Promise<InventoryBalance | null>;
  lock(itemIds: readonly string[]): Promise<ReadonlyMap<string, InventoryBalance>>;
  reservation(orderId: string, itemId: string): Promise<InventoryReservation | null>;
  reserve(orderId: string, itemId: string, quantity: number): Promise<InventoryReservation>;
  release(orderId: string, itemId: string, quantity: number): Promise<InventoryReservation>;
}

/** Construct only after the existing direct/seller command authorizes its
 * profile and takes the instance/community/profile locks. The supplied client
 * stays in that same scoped transaction; no pool or RLS rebinding. An order ID
 * is an already-authorized reference, never a new grant of buyer/order access. */
export function localReservationInventory(q: PoolClient, context: DirectEffectContext): ReservationInventory {
  return inventory(q, () => context.profile.supply_shop_id);
}

/** Sources are resolved by the closed quote adapter or immutable order lines.
 * Never construct this map from a request body. All writes still target the
 * original item/shop balance in the same transaction and community lock. */
export function boundReservationInventory(q: PoolClient, sources: ReadonlyMap<string, string>): ReservationInventory {
  return inventory(q, itemId => sources.get(itemId));
}
function inventory(q: PoolClient, source: (itemId: string) => string | undefined): ReservationInventory {
  const quantityValid = (quantity: number) => requireCondition(Number.isSafeInteger(quantity) && quantity > 0,
    400, 'invalid_reservation_items', '商品數量無效。');
  const reservation = async (orderId: string, itemId: string, lock = false) =>
    (await q.query<InventoryReservation>(`SELECT * FROM commerce_inventory_reservations
      WHERE order_id=$1 AND item_id=$2 AND supplier_shop_id=$3${lock ? ' FOR UPDATE' : ''}`,
    [orderId, itemId, source(itemId) ?? null])).rows[0] ?? null;
  return {
    reservation,
    async status(itemId) {
      return (await q.query<InventoryBalance>(`SELECT item_id,stock,reserved,stock-reserved AS available
        FROM commerce_items WHERE item_id=$1 AND shop_id=$2`, [itemId, source(itemId) ?? null])).rows[0] ?? null;
    },
    async lock(itemIds) {
      if (!itemIds.length) return new Map();
      const ids = [...new Set(itemIds)].sort();
      const rows = (await q.query<InventoryBalance>(`SELECT i.item_id,stock,reserved,stock-reserved AS available
        FROM commerce_items i JOIN unnest($1::uuid[],$2::uuid[]) AS bound(item_id,shop_id)
          ON i.item_id=bound.item_id AND i.shop_id=bound.shop_id ORDER BY i.item_id FOR UPDATE OF i`,
      [ids, ids.map(id => source(id) ?? null)])).rows;
      return new Map(rows.map(row => [row.item_id, row]));
    },
    async reserve(orderId, itemId, quantity) {
      quantityValid(quantity);
      const prior = await reservation(orderId, itemId, true);
      if (prior) {
        requireCondition(prior.quantity === quantity, 409, 'reservation_inconsistent', '庫存保留紀錄不一致。');
        requireCondition(prior.state === 'held', 409, 'reservation_closed', '這筆庫存保留已結束。');
        return prior;
      }
      // Immutable order lines, not caller-supplied supplier or quantity, bind
      // each hold. The deferred database guard checks complete order coverage.
      const held = (await q.query<InventoryReservation>(`INSERT INTO commerce_inventory_reservations
        (order_id,item_id,supplier_shop_id,quantity,state,created_at,expires_at)
        SELECT o.order_id,i.item_id,i.shop_id,sum(l.quantity)::integer,'held',o.created_at,o.expires_at
        FROM commerce_orders o JOIN commerce_order_lines l USING(order_id) JOIN commerce_items i USING(item_id)
        JOIN commerce_shops s ON s.shop_id=i.shop_id AND s.origin='hosted'
        WHERE o.order_id=$1 AND i.item_id=$2 AND i.shop_id=$3 AND o.reservation_state='reserved'
          AND o.order_profile IN ('hosted_direct_reservation','hosted_shared_reservation')
        GROUP BY o.order_id,i.item_id,i.shop_id HAVING sum(l.quantity)=$4
        RETURNING *`, [orderId, itemId, source(itemId) ?? null, quantity])).rows[0];
      requireCondition(held, 409, 'reservation_inconsistent', '庫存保留來源不一致。');
      const result = await q.query(`UPDATE commerce_items SET reserved=reserved+$2
        WHERE item_id=$1 AND shop_id=$3 AND stock-reserved >= $2`, [itemId, quantity, source(itemId) ?? null]);
      requireCondition(result.rowCount === 1, 409, 'stock_unavailable', '商品庫存不足。');
      return held;
    },
    async release(orderId, itemId, quantity) {
      quantityValid(quantity);
      const held = await reservation(orderId, itemId, true);
      requireCondition(held && held.quantity === quantity, 409, 'reservation_inconsistent', '庫存保留紀錄不一致。');
      if (held.state === 'released') return held;
      const result = await q.query(`UPDATE commerce_items SET reserved=reserved-$2
        WHERE item_id=$1 AND shop_id=$3 AND reserved >= $2`, [itemId, quantity, source(itemId) ?? null]);
      requireCondition(result.rowCount === 1, 409, 'reservation_inconsistent', '庫存保留紀錄不一致。');
      return (await q.query<InventoryReservation>(`UPDATE commerce_inventory_reservations
        SET state='released',released_at=clock_timestamp() WHERE reservation_id=$1 RETURNING *`, [held.reservation_id])).rows[0];
    },
  };
}
