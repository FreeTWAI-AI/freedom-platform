import type {PoolClient} from 'pg';
import {requireCondition} from '../../../packages/shared/problem.js';
import type {InventoryAllocation as Allocation,CheckoutInventory} from '../hosted/inventory.js';
export type {CheckoutInventory} from '../hosted/inventory.js';
const consistent=(value:unknown)=>requireCondition(value,409,'reservation_inconsistent','庫存紀錄不一致。');
/** Caller holds the community, checkout/sidecar/order and payment locks. Sources
 * and quantities come only from retained hosted_checkout lines. No shop or tenant
 * authority can be supplied to this adapter. Locks cover all holds/allocations
 * before items in UUID order; every mutation checks SQL balances and journals it. */
export async function checkoutInventory(q:PoolClient,orderId:string) {
  const lines=(await q.query<{item_id:string;supplier_shop_id:string;quantity:number;sku:string}>(`SELECT l.item_id,l.supplier_shop_id,l.quantity,l.snapshot->>'sku' AS sku
    FROM commerce_order_lines l JOIN commerce_checkout_orders co USING(order_id) JOIN commerce_orders o USING(order_id)
    JOIN commerce_items i ON i.item_id=l.item_id AND i.shop_id=l.supplier_shop_id
    JOIN commerce_shops supply ON supply.shop_id=i.shop_id AND supply.origin='hosted'
    JOIN commerce_shops retail ON retail.shop_id=o.public_shop_id AND retail.origin='hosted' AND retail.community_id=supply.community_id
    WHERE l.order_id=$1 AND l.order_profile='hosted_checkout' ORDER BY l.item_id`,[orderId])).rows;
  consistent(lines.length>0 && lines.length<=50);
  const holds=(await q.query<{reservation_id:string;item_id:string;quantity:number;state:'held'|'released'}>(`SELECT reservation_id,item_id,quantity,state FROM commerce_inventory_reservations WHERE order_id=$1 ORDER BY item_id FOR UPDATE`,[orderId])).rows;
  const allocations=(await q.query<Allocation>('SELECT * FROM commerce_inventory_allocations WHERE order_id=$1 ORDER BY item_id FOR UPDATE',[orderId])).rows;
  const balances=(await q.query<{item_id:string;stock:number;reserved:number;available:number}>(`SELECT item_id,stock,reserved,stock-reserved AS available
    FROM commerce_items WHERE item_id=ANY($1::uuid[]) ORDER BY item_id FOR UPDATE`,[lines.map(l=>l.item_id)])).rows;
  consistent(balances.length===lines.length);
  const allocation=async(itemId:string)=>{
    const a=(await q.query<Allocation>('SELECT * FROM commerce_inventory_allocations WHERE order_id=$1 AND item_id=$2',[orderId,itemId])).rows[0];
    consistent(a);return a;
  };
  const line=(itemId:string)=>{const l=lines.find(l=>l.item_id===itemId);consistent(l);return l!;};
  const valid=(quantity:number)=>requireCondition(Number.isSafeInteger(quantity)&&quantity>0,422,'invalid_inventory_quantity','數量無效。');
  const seen=async(kind:string,ref:string,id:string)=>(await q.query(`SELECT 1 FROM commerce_inventory_movements WHERE kind=$1 AND source_ref=$2 AND allocation_id=$3`,[kind,ref,id])).rowCount===1;
  const movement=async(kind:string,ref:string,a:Allocation,quantity:number,stock:number,reserved:number)=>{
    await q.query(`INSERT INTO commerce_inventory_movements(kind,item_id,order_id,allocation_id,source_ref,quantity,delta_stock,delta_reserved)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[kind,a.item_id,orderId,a.allocation_id,ref,quantity,stock,reserved]);
  };
  const create=async(itemId:string,applicationId:string,convert:boolean)=>{
    const l=line(itemId),h=holds.find(h=>h.item_id===itemId);consistent(h&&h.quantity===l.quantity);
    const prior=allocations.find(a=>a.item_id===itemId);
    if(prior){consistent(prior.payment_application_id===applicationId);return prior;}
    if(convert) {
      consistent(h!.state==='held');
      const result=await q.query("UPDATE commerce_inventory_reservations SET state='released',released_at=clock_timestamp() WHERE reservation_id=$1 AND state='held'",[h!.reservation_id]);
      consistent(result.rowCount===1);h!.state='released';
    } else {
      consistent(h!.state==='released');
      const result=await q.query('UPDATE commerce_items SET reserved=reserved+$2 WHERE item_id=$1 AND stock-reserved>=$2',[itemId,l.quantity]);
      requireCondition(result.rowCount===1,409,'stock_unavailable','商品庫存不足。');
    }
    const a=(await q.query<Allocation>(`INSERT INTO commerce_inventory_allocations(order_id,item_id,supplier_shop_id,quantity,source_reservation_id,payment_application_id)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[orderId,itemId,l.supplier_shop_id,l.quantity,convert?h!.reservation_id:null,applicationId])).rows[0];
    allocations.push(a);await movement(convert?'convert':'allocate',convert?h!.reservation_id:applicationId,a,l.quantity,0,convert?0:l.quantity);return a;
  };
  const port:CheckoutInventory={
    convert:(id,app)=>create(id,app,true),allocate:(id,app)=>create(id,app,false),
    async releaseAllocation(itemId,quantity,commandRef) {
      valid(quantity);const a=await allocation(itemId);if(await seen('allocation_release',commandRef,a.allocation_id))return;
      const change=await q.query(`UPDATE commerce_inventory_allocations SET released_quantity=released_quantity+$2
        WHERE allocation_id=$1 AND quantity-shipped_quantity-released_quantity>=$2`,[a.allocation_id,quantity]);
      requireCondition(change.rowCount===1,409,'allocation_exceeded','超過可釋放數量。');
      consistent((await q.query('UPDATE commerce_items SET reserved=reserved-$2 WHERE item_id=$1 AND reserved>=$2',[itemId,quantity])).rowCount===1);
      await movement('allocation_release',commandRef,a,quantity,0,-quantity);
    },
    async ship(itemId,quantity,shipmentRef) {
      valid(quantity);const a=await allocation(itemId);if(await seen('ship',shipmentRef,a.allocation_id))return;
      const change=await q.query(`UPDATE commerce_inventory_allocations SET shipped_quantity=shipped_quantity+$2
        WHERE allocation_id=$1 AND quantity-shipped_quantity-released_quantity>=$2`,[a.allocation_id,quantity]);
      requireCondition(change.rowCount===1,409,'allocation_exceeded','超過可交寄數量。');
      consistent((await q.query('UPDATE commerce_items SET stock=stock-$2,reserved=reserved-$2 WHERE item_id=$1 AND stock>=$2 AND reserved>=$2',[itemId,quantity])).rowCount===1);
      await movement('ship',shipmentRef,a,quantity,-quantity,-quantity);
    },
    async restock(itemId,quantity,returnRef) {
      valid(quantity);const a=await allocation(itemId);if(await seen('restock',returnRef,a.allocation_id))return;
      const change=await q.query(`UPDATE commerce_items SET stock=stock+$2 WHERE item_id=$1 AND $2<=(SELECT a.shipped_quantity-coalesce(sum(m.quantity),0)
        FROM commerce_inventory_allocations a LEFT JOIN commerce_inventory_movements m ON m.allocation_id=a.allocation_id AND m.kind='restock'
        WHERE a.allocation_id=$3 GROUP BY a.shipped_quantity) AND stock::bigint+$2<=2147483647`,[itemId,quantity,a.allocation_id]);
      requireCondition(change.rowCount===1,409,'return_exceeded','超過可回補數量。');await movement('restock',returnRef,a,quantity,quantity,0);
    },
  };
  const releaseHolds=async()=>{
    for(const h of holds)if(h.state==='held'){
      consistent((await q.query('UPDATE commerce_items SET reserved=reserved-$2 WHERE item_id=$1 AND reserved>=$2',[h.item_id,h.quantity])).rowCount===1);
      await q.query("UPDATE commerce_inventory_reservations SET state='released',released_at=clock_timestamp() WHERE reservation_id=$1",[h.reservation_id]);h.state='released';
    }
  };
  const hold=async()=>{
    for(const l of lines){
      consistent(!holds.some(h=>h.item_id===l.item_id));
      await q.query(`INSERT INTO commerce_inventory_reservations(order_id,item_id,supplier_shop_id,quantity,state,created_at,expires_at)
        SELECT order_id,$2,$3,$4,'held',created_at,expires_at FROM commerce_orders WHERE order_id=$1 AND order_profile='hosted_checkout'`,[orderId,l.item_id,l.supplier_shop_id,l.quantity]);
      requireCondition((await q.query('UPDATE commerce_items SET reserved=reserved+$2 WHERE item_id=$1 AND stock-reserved>=$2',[l.item_id,l.quantity])).rowCount===1,409,'stock_unavailable','商品庫存不足。');
    }
  };
  return {port,lines,holds,allocations,balances,releaseHolds,hold};
}
