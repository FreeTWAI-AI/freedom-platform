import type { PoolClient } from 'pg';
import { requireCondition } from '../../../packages/shared/problem.js';
import type { DirectEffectContext } from './direct-authority.js';

export interface InventoryBalance {
  item_id: string;
  stock: number;
  reserved: number;
  available: number;
}

/** Internal transaction port. Order receipts and the locked order state own
 * idempotency; these methods must not be retried outside that transaction.
 * A remote implementation requires durable reservation IDs and reconciliation,
 * not a network call substituted inside the current PostgreSQL transaction. */
export interface ReservationInventory {
  status(itemId: string): Promise<InventoryBalance | null>;
  lock(itemIds: readonly string[]): Promise<ReadonlyMap<string, InventoryBalance>>;
  reserve(itemId: string, quantity: number): Promise<void>;
  release(itemId: string, quantity: number): Promise<void>;
}

/** Construct only after the existing direct/seller command authorizes its
 * profile and takes the instance/community/profile locks. The supplied client
 * stays in that same scoped transaction; no pool, RLS rebinding or new ledger. */
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
  return {
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
    async reserve(itemId, quantity) {
      quantityValid(quantity);
      const result = await q.query(`UPDATE commerce_items SET reserved=reserved+$2
        WHERE item_id=$1 AND shop_id=$3 AND stock-reserved >= $2`, [itemId, quantity, source(itemId) ?? null]);
      requireCondition(result.rowCount === 1, 409, 'stock_unavailable', '商品庫存不足。');
    },
    async release(itemId, quantity) {
      quantityValid(quantity);
      const result = await q.query(`UPDATE commerce_items SET reserved=reserved-$2
        WHERE item_id=$1 AND shop_id=$3 AND reserved >= $2`, [itemId, quantity, source(itemId) ?? null]);
      requireCondition(result.rowCount === 1, 409, 'reservation_inconsistent', '庫存保留紀錄不一致。');
    },
  };
}
