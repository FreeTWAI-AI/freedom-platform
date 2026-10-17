import type {Pool} from 'pg';
import {clearTenantContext,isolatedTransaction} from '../../../../packages/resource-scopes/tenant-transaction.js';
import {bindStore,lockMachineOrder} from '../../checkout/authority.js';
import {hasConfirmedPayment} from '../../checkout/confirmed-payment.js';
import {cancelUnpaidOrder} from '../../checkout/orders.js';

export const OFFLINE_CONFIRMATION_GRACE_MS=72*60*60*1000;
/** Order locks precede the due row. Placement inserts that row while it holds the order. */
export async function endOfflinePaymentWindow(pool:Pool,orderId:string,options:{now?:()=>Date;leaseToken?:string;tenantId?:string;signal?:AbortSignal}={}){
  return isolatedTransaction(pool,async q=>{
    const peek=(await q.query<{tenant_id:string}>('SELECT tenant_id FROM commerce_checkout_orders WHERE order_id=$1',[orderId])).rows[0];
    if(options.tenantId&&peek&&peek.tenant_id!==options.tenantId)throw Error('due_work_binding_invalid');
    const now=options.now?.()??new Date();
    const load=()=>q.query(`SELECT *,lease_until::text AS token FROM commerce_due_work WHERE kind='offline_payment_window_end' AND target_id=$1 FOR UPDATE`,[orderId]);
    if(!peek){
      const row=(await load()).rows[0];
      if(options.signal?.aborted||!row||row.due_at>now||(row.lease_until&&row.lease_until>now&&row.token!==options.leaseToken))return 'skipped' as const;
      if(options.tenantId&&row.tenant_id!==options.tenantId)throw Error('due_work_binding_invalid');
      await q.query('DELETE FROM commerce_due_work WHERE due_work_id=$1',[row.due_work_id]);
      return 'completed' as const;
    }
    await clearTenantContext(q);await bindStore(q,peek.tenant_id);await lockMachineOrder(q,orderId);
    const row=(await load()).rows[0];
    if(options.signal?.aborted||!row||row.due_at>now||(row.lease_until&&row.lease_until>now&&row.token!==options.leaseToken))return 'skipped' as const;
    if(row.tenant_id!==peek.tenant_id||(options.tenantId&&row.tenant_id!==options.tenantId))throw Error('due_work_binding_invalid');
    const order=(await q.query(`SELECT co.lifecycle_state,co.payment_method,p.storefront_shop_id,o.expires_at+interval '72 hours'<=clock_timestamp() AS grace_ended
      FROM commerce_checkout_orders co JOIN commerce_orders o USING(order_id)
      JOIN commerce_storefront_profiles p ON p.tenant_id=co.tenant_id AND p.instance_id=co.instance_id WHERE co.order_id=$1`,[orderId])).rows[0];
    const openUnpaid=order?.lifecycle_state==='open'&&order.payment_method!=='immediate_card'&&!await hasConfirmedPayment(q,orderId);
    if(openUnpaid&&order.grace_ended)await cancelUnpaidOrder(q,order,orderId,'system','payment_not_completed');
    if(openUnpaid&&!order.grace_ended)await q.query(`UPDATE commerce_due_work SET due_at=(SELECT expires_at+interval '72 hours' FROM commerce_orders WHERE order_id=$2),lease_until=NULL,updated_at=clock_timestamp() WHERE due_work_id=$1`,[row.due_work_id,orderId]);
    else await q.query('DELETE FROM commerce_due_work WHERE due_work_id=$1',[row.due_work_id]);
    return 'completed' as const;
  });
}
