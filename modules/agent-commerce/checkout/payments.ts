import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {requireCondition} from '../../../packages/shared/problem.js';
import {lockMachineOrder,lockStore,type CheckoutStore} from './authority.js';
import {lockCheckoutOrders} from './orders.js';
import {checkoutInventory} from './inventory.js';
import {hasConfirmedPayment} from './confirmed-payment.js';
export type PaymentOutcome='converted'|'allocated'|'unallocatable'|'after_cancel'|'overpaid'|'amount_mismatch'|'simulated';
export interface PaymentApplication {application_id:string;order_id:string;payment_ref:string;amount_minor:string;currency:string;outcome:PaymentOutcome}
export async function applyConfirmedPayment(q:PoolClient,input:{orderId:string;paymentRef:string;amountMinor:number;currency:string;simulated:boolean}):Promise<PaymentApplication> {
  requireCondition(Number.isSafeInteger(input.amountMinor)&&input.amountMinor>=0 && /^[A-Z]{3}$/.test(input.currency),422,'invalid_payment_fact','付款事實無效。');
  await lockMachineOrder(q,input.orderId);
  const [order]=await lockCheckoutOrders(q,[input.orderId],undefined,input.paymentRef);
  const prior=(await q.query<PaymentApplication>('SELECT * FROM commerce_checkout_payment_applications WHERE payment_ref=$1',[input.paymentRef])).rows[0];
  if(prior){requireCondition(prior.order_id===input.orderId,409,'payment_ref_conflict','付款事實已用於其他訂單。');return prior;}
  const inv=await checkoutInventory(q,input.orderId);
  const already=await hasConfirmedPayment(q,input.orderId);
  let outcome:PaymentOutcome;
  if(input.simulated)outcome='simulated';
  else if(input.amountMinor!==order.terms.total_minor||input.currency!==order.terms.currency)outcome='amount_mismatch';
  else if(order.lifecycle_state==='cancelled')outcome='after_cancel';
  else if(already)outcome='overpaid';
  else {
    requireCondition(order.lifecycle_state==='open',409,'checkout_order_closed','訂單已結束。');
    if(inv.holds.length===inv.lines.length && inv.holds.every(h=>h.state==='held'))outcome='converted';
    else {
      // Mixed retained holds are released before an all-or-nothing allocation;
      // community serialization keeps those units private until this commits.
      await inv.releaseHolds();
      const balances=(await q.query<{item_id:string;available:number}>('SELECT item_id,stock-reserved AS available FROM commerce_items WHERE item_id=ANY($1::uuid[])',[inv.lines.map(l=>l.item_id)])).rows;
      outcome=inv.lines.every(l=>(balances.find(b=>b.item_id===l.item_id)?.available??-1)>=l.quantity)?'allocated':'unallocatable';
    }
  }
  const app=(await q.query<PaymentApplication>(`INSERT INTO commerce_checkout_payment_applications(application_id,order_id,payment_ref,amount_minor,currency,outcome)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[randomUUID(),input.orderId,input.paymentRef,input.amountMinor,input.currency,outcome])).rows[0];
  if(outcome==='converted'||outcome==='allocated')for(const l of inv.lines)await inv.port[outcome==='converted'?'convert':'allocate'](l.item_id,app.application_id);
  return app;
}
export async function retryAllocation(q:PoolClient,store:CheckoutStore,orderId:string) {
  await lockStore(q,store,[],[orderId],false);const [order]=await lockCheckoutOrders(q,[orderId],store);
  requireCondition(order.lifecycle_state==='open',409,'checkout_order_closed','訂單已結束。');
  const app=(await q.query<PaymentApplication>("SELECT * FROM commerce_checkout_payment_applications WHERE order_id=$1 AND outcome='unallocatable' ORDER BY created_at,application_id LIMIT 1",[orderId])).rows[0];
  requireCondition(app,409,'allocation_retry_unavailable','訂單不需要重新配貨。');
  const inv=await checkoutInventory(q,orderId);if(inv.allocations.length===inv.lines.length)return {outcome:'allocated' as const};
  requireCondition(!inv.allocations.length && inv.holds.every(h=>h.state==='released'),409,'reservation_inconsistent','庫存紀錄不一致。');
  requireCondition(inv.lines.every(l=>(inv.balances.find(b=>b.item_id===l.item_id)?.available??-1)>=l.quantity),409,'stock_unavailable','商品庫存不足。');
  for(const l of inv.lines)await inv.port.allocate(l.item_id,app.application_id);return {outcome:'allocated' as const};
}
export async function releaseAllocation(q:PoolClient,store:CheckoutStore,input:{orderId:string;commandRef:string;lines?:readonly {itemId:string;quantity:number}[]}) {
  await lockStore(q,store,[],[input.orderId],false);const [order]=await lockCheckoutOrders(q,[input.orderId],store);
  if((await q.query("SELECT 1 FROM commerce_inventory_movements WHERE order_id=$1 AND kind='allocation_release' AND source_ref=$2",[input.orderId,input.commandRef])).rowCount)return order;
  requireCondition(order.lifecycle_state==='open',409,'checkout_order_closed','訂單已結束。');
  const inv=await checkoutInventory(q,input.orderId);
  const lines=input.lines??inv.allocations.map(a=>({itemId:a.item_id,quantity:a.quantity-a.shipped_quantity-a.released_quantity})).filter(l=>l.quantity>0);
  requireCondition(new Set(lines.map(l=>l.itemId)).size===lines.length,422,'duplicate_allocation_line','商品重複。');
  for(const l of lines){const a=inv.allocations.find(a=>a.item_id===l.itemId);requireCondition(a&&Number.isSafeInteger(l.quantity)&&l.quantity>0&&l.quantity<=a.quantity-a.shipped_quantity-a.released_quantity,409,'allocation_exceeded','超過可釋放數量。');}
  requireCondition(inv.allocations.length>0,409,'allocation_release_unavailable','訂單沒有已付款配置。');
  for(const l of lines)await inv.port.releaseAllocation(l.itemId,l.quantity,input.commandRef);
  const {remaining,shipped}=(await q.query('SELECT coalesce(sum(quantity-shipped_quantity-released_quantity),0)::int AS remaining,coalesce(sum(shipped_quantity),0)::int AS shipped FROM commerce_inventory_allocations WHERE order_id=$1',[input.orderId])).rows[0];
  if(remaining===0 && shipped===0 && lines.length) return (await q.query(`UPDATE commerce_checkout_orders SET lifecycle_state='cancelled',cancel_reason='paid_cancelled',cancelled_at=clock_timestamp(),version=version+1 WHERE order_id=$1 RETURNING *,version::text`,[input.orderId])).rows[0] as typeof order;
  return order;
}
export async function recordHandover(q:PoolClient,store:CheckoutStore,input:{shipmentRef:string;lines:readonly {orderId:string;itemId:string;quantity:number}[]}) {
  requireCondition(input.lines.length>0&&input.lines.length<=10000 && new Set(input.lines.map(l=>`${l.orderId}/${l.itemId}`)).size===input.lines.length,422,'invalid_handover_lines','交寄行項無效。');
  const ids=[...new Set(input.lines.map(l=>l.orderId))].sort();await lockStore(q,store,[],ids,false);
  const orders=await lockCheckoutOrders(q,ids,store);
  if((await q.query("SELECT 1 FROM commerce_inventory_movements WHERE kind='ship' AND source_ref=$1 LIMIT 1",[input.shipmentRef])).rowCount)return;
  requireCondition(orders.every(o=>o.lifecycle_state==='open'),409,'checkout_order_closed','訂單已結束。');
  const inventories=new Map<string,Awaited<ReturnType<typeof checkoutInventory>>>();
  for(const id of ids)inventories.set(id,await checkoutInventory(q,id));
  for(const l of input.lines){const a=inventories.get(l.orderId)!.allocations.find(a=>a.item_id===l.itemId);requireCondition(a&&Number.isSafeInteger(l.quantity)&&l.quantity>0&&l.quantity<=a.quantity-a.shipped_quantity-a.released_quantity,409,'allocation_exceeded','超過可交寄數量。');}
  for(const l of [...input.lines].sort((a,b)=>a.itemId.localeCompare(b.itemId)||a.orderId.localeCompare(b.orderId)))await inventories.get(l.orderId)!.port.ship(l.itemId,l.quantity,input.shipmentRef);
}
export async function restockReturn(q:PoolClient,store:CheckoutStore,input:{returnRef:string;orderId:string;itemId:string;quantity:number}) {
  await lockStore(q,store,[],[input.orderId],false);await lockCheckoutOrders(q,[input.orderId],store);
  await (await checkoutInventory(q,input.orderId)).port.restock(input.itemId,input.quantity,input.returnRef);
}
