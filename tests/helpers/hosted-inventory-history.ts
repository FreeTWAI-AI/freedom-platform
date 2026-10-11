import type {Pool, PoolClient} from 'pg';

/** Isolated retained-history fixture. Keep real immutable/FK/deferred guards;
 * insert the selected historical order and its holds in one transaction. */
export async function retainedHostedOrder(pool: Pool, orderId: string, write: (q: PoolClient) => Promise<void>) {
  const q = await pool.connect();
  try {
    await q.query('BEGIN');
    await write(q);
    await q.query(`INSERT INTO commerce_inventory_reservations
      (order_id,item_id,supplier_shop_id,quantity,state,created_at,expires_at,released_at)
      SELECT o.order_id,l.item_id,i.shop_id,sum(l.quantity)::integer,
        CASE WHEN o.reservation_state='reserved' THEN 'held' ELSE 'released' END,o.created_at,o.expires_at,o.closed_at
      FROM commerce_orders o JOIN commerce_order_lines l USING(order_id) JOIN commerce_items i USING(item_id)
      WHERE o.order_id=$1 AND o.order_profile IN ('hosted_direct_reservation','hosted_shared_reservation')
      GROUP BY o.order_id,l.item_id,i.shop_id`, [orderId]);
    await q.query('COMMIT');
  } catch (error) {
    await q.query('ROLLBACK');
    throw error;
  } finally { q.release(); }
}
