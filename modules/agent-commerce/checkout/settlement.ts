import type {Pool,PoolClient} from 'pg';
import {requireCondition} from '../../../packages/shared/problem.js';
import {isolatedTransaction} from '../../../packages/resource-scopes/tenant-transaction.js';
import {lockCommerceCommunity} from '../hosted/direct-authority.js';
import {lockCheckoutOrders} from './orders.js';
import {checkoutInventory} from './inventory.js';
// A verified payment retained during quarantine must convert its still-held units
// before any placement or scheduled expiry can release them. All selectors and
// the locked recheck use this same predicate (their base-order alias is o).
const noUnappliedPaidEvent = `NOT EXISTS (
  SELECT 1 FROM commerce_payment_attempts a JOIN commerce_hosted_payment_events e USING(attempt_id)
  WHERE a.order_id=o.order_id AND e.source IN ('notification','query') AND e.outcome='paid' AND e.applied_at IS NULL)`;
/** Bounded physical release; due checkout orders remain open for late payments. */
export async function settleDueCheckoutHolds(q:PoolClient,itemIds:readonly string[],bounds:{ordersPerItem?:number;limit?:number}={}) {
  const ids=[...new Set(itemIds)].sort(),per=bounds.ordersPerItem??99,limit=bounds.limit??4950;
  requireCondition(ids.length<=50 && Number.isInteger(per)&&per>0&&per<=99 && Number.isInteger(limit)&&limit>0&&limit<=4950,422,'invalid_settlement_bounds','結算範圍無效。');
  if(!ids.length)return 0;
  const communities=(await q.query<{community_id:string}>('SELECT DISTINCT s.community_id FROM commerce_items i JOIN commerce_shops s USING(shop_id) WHERE i.item_id=ANY($1::uuid[]) ORDER BY s.community_id',[ids])).rows;
  requireCondition(communities.length<=1,422,'invalid_settlement_community','結算商品必須屬於同一社群。');
  if(!communities.length)return 0;await lockCommerceCommunity(q,communities[0].community_id);
  const orders=new Set<string>();
  for(const id of ids){
    const rows=(await q.query<{order_id:string}>(`SELECT o.order_id FROM commerce_inventory_reservations h JOIN commerce_orders o USING(order_id)
      WHERE h.item_id=$1 AND h.state='held' AND o.order_profile='hosted_checkout' AND o.expires_at<=clock_timestamp() AND ${noUnappliedPaidEvent} ORDER BY o.order_id LIMIT $2`,[id,Math.min(per,limit-orders.size)])).rows;
    for(const r of rows)orders.add(r.order_id);if(orders.size>=limit)break;
  }
  if(!orders.size)return 0;
  // Profile locks precede checkout rows, without taking instance lifecycle locks.
  await q.query(`SELECT p.instance_id FROM commerce_storefront_profiles p WHERE EXISTS(SELECT 1 FROM commerce_checkout_orders co
    WHERE co.instance_id=p.instance_id AND co.order_id=ANY($1::uuid[])) ORDER BY p.instance_id FOR UPDATE`,[[...orders]]);
  await lockCheckoutOrders(q,[...orders]);let released=0;
  for(const id of [...orders].sort()){
    const due=(await q.query(`SELECT 1 FROM commerce_orders o WHERE o.order_id=$1 AND o.expires_at<=clock_timestamp() AND ${noUnappliedPaidEvent}`,[id])).rowCount;
    if(due){const inv=await checkoutInventory(q,id);released+=inv.holds.filter(h=>h.state==='held').length;await inv.releaseHolds();}
  }
  return released;
}
/** Scheduled-job adapter only; this job installs no cron. Each selected order's
 * community is handled in a separate transaction and no principal is fabricated. */
export async function sweepDueCheckoutHolds(pool:Pool,{limit=200}:{limit?:number}={}) {
  requireCondition(Number.isInteger(limit)&&limit>0&&limit<=200,422,'invalid_settlement_bounds','結算範圍無效。');
  const targets=await isolatedTransaction(pool,async q=>(await q.query<{order_id:string;item_id:string}>(`SELECT o.order_id,min(h.item_id::text)::uuid AS item_id FROM commerce_orders o
    JOIN commerce_inventory_reservations h USING(order_id) WHERE o.order_profile='hosted_checkout' AND h.state='held' AND o.expires_at<=clock_timestamp() AND ${noUnappliedPaidEvent}
    GROUP BY o.order_id ORDER BY o.order_id LIMIT $1`,[limit])).rows);
  let count=0;for(const t of targets)count+=await isolatedTransaction(pool,q=>settleDueCheckoutHolds(q,[t.item_id],{ordersPerItem:1,limit:1}));return count;
}
