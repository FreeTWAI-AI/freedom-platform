import type {Pool, PoolClient} from 'pg';
import {clearTenantContext, isolatedTransaction} from '../../../packages/resource-scopes/tenant-transaction.js';
import {bindStore, lockMachineOrder} from '../checkout/authority.js';
import {lockCheckoutOrders, cancelUnpaidOrder} from '../checkout/orders.js';
import {hasConfirmedPayment} from '../checkout/confirmed-payment.js';
import {openException} from '../checkout/exceptions.js';
import {scheduleDueWork} from '../operations/due-work.js';
import {lockMachineAccount} from './accounts.js';
import {onPaymentOrdersCancelled} from './attempts.js';

export interface MachinePaymentAttempt {
  attempt_id:string; tenant_id:string; instance_id:string; account_id:string; order_id:string|null;
  kind:'order'|'service_activation'; state:'issued'|'superseded'|'paid'|'confirmed'|'failed'|'expired_unpaid';
  environment:'sandbox'|'live'; merchant_id:string; merchant_trade_no:string; amount_minor:string; currency:'TWD';
  created_at:Date; handed_off_at:Date|null; paid_at:Date|null; trade_no:string|null;
}
export const PAYMENT_WINDOW_MS = 60 * 60_000;
const DAY = 24 * 60 * 60_000;
/** The stored event is the durable stop marker, including after case closure. */
export async function hasDefinitePaymentMismatch(q:PoolClient, attempt:Pick<MachinePaymentAttempt,'attempt_id'|'amount_minor'>) {
  return Boolean((await q.query(`SELECT 1 FROM commerce_hosted_payment_events e JOIN commerce_payment_attempts a USING(attempt_id) WHERE e.attempt_id=$1
    AND ((e.source='query' AND (e.outcome IN ('amount_mismatch','trade_no_mismatch')
        OR (e.outcome='paid' AND a.trade_no IS NOT NULL AND e.trade_no<>a.trade_no)))
      OR (e.source='notification' AND e.outcome='paid' AND e.trade_amt_minor<>$2)) LIMIT 1`, [attempt.attempt_id,attempt.amount_minor])).rowCount);
}
/** Resolve the exempt identity first; every machine writer then uses the same
 * order -> payment advisory -> attempts -> events -> due-work lock order. */
export async function lockMachinePaymentAttempt(q:PoolClient, id:string,expectedTenantId?:string):Promise<MachinePaymentAttempt|null> {
  const peek = (await q.query<MachinePaymentAttempt>('SELECT * FROM commerce_payment_attempts WHERE attempt_id=$1',[id])).rows[0];
  if (!peek) return null;
  if(expectedTenantId && peek.tenant_id!==expectedTenantId)throw Error('due_work_binding_invalid');
  await clearTenantContext(q); await bindStore(q,peek.tenant_id);
  if (peek.order_id) {
    await lockMachineOrder(q,peek.order_id);
    await lockCheckoutOrders(q,[peek.order_id],undefined,id);
  } else {
    await lockMachineAccount(q,peek.account_id);
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`checkout-payment/${id}`]);
    await q.query('SELECT attempt_id FROM commerce_payment_attempts WHERE attempt_id=$1 FOR UPDATE',[id]);
  }
  return (await q.query<MachinePaymentAttempt>('SELECT * FROM commerce_payment_attempts WHERE attempt_id=$1',[id])).rows[0];
}
/** Caller already owns the machine order/attempt locks. No unapplied payment
 * event may be overtaken by cancellation, including a definite failed event. */
export async function settleOrderPayments(q:PoolClient, orderId:string) {
  const order = (await q.query(`SELECT co.lifecycle_state,co.payment_method,p.storefront_shop_id FROM commerce_checkout_orders co
    JOIN commerce_storefront_profiles p ON p.tenant_id=co.tenant_id AND p.instance_id=co.instance_id WHERE co.order_id=$1`,[orderId])).rows[0];
  if (!order || order.lifecycle_state!=='open' || order.payment_method!=='immediate_card' || await hasConfirmedPayment(q,orderId)) return false;
  const pending = (await q.query(`SELECT 1 FROM commerce_payment_attempts a WHERE a.order_id=$1 AND
    (a.state NOT IN ('failed','expired_unpaid') OR EXISTS(SELECT 1 FROM commerce_hosted_payment_events e
      WHERE e.attempt_id=a.attempt_id AND e.source IN ('notification','query') AND e.applied_at IS NULL)) LIMIT 1`,[orderId])).rowCount;
  if (pending) return false;
  await cancelUnpaidOrder(q,order,orderId,'system','payment_not_completed',{payment:{onOrdersCancelled:onPaymentOrdersCancelled}});
  return true;
}
export async function paymentQueryDueAt(q:PoolClient, a:MachinePaymentAttempt, now:Date, failureCount:number, verifiedUnknown=false):Promise<Date|null> {
  if (['confirmed','failed','expired_unpaid'].includes(a.state) || await hasDefinitePaymentMismatch(q,a)) return null;
  const t=now.getTime(), window=a.created_at.getTime()+PAYMENT_WINDOW_MS;
  const exception=()=>openException(q,{tenantId:a.tenant_id,instanceId:a.instance_id,orderId:a.order_id,
    kind:'payment_unconfirmed',subjectKind:'payment_attempt',subjectId:a.attempt_id});
  const retry=[1,2,5,10][Math.min(Math.max(failureCount,1)-1,3)]*60_000;
  if (a.state==='paid') {
    const paid=a.paid_at!.getTime();
    if (t>=paid+PAYMENT_WINDOW_MS) await exception();
    if (t>=paid+DAY) return null;
    return new Date(Math.min(t+retry,paid+DAY,...(t<paid+PAYMENT_WINDOW_MS?[paid+PAYMENT_WINDOW_MS]:[])));
  }
  if (t<window) {
    const slot=[10,20,40,60].map(min=>a.created_at.getTime()+min*60_000).find(time=>time>t)!;
    return new Date(failureCount>0?Math.min(slot,t+retry):slot);
  }
  if (!a.handed_off_at) return null; // The separate window row expires it.
  if (t>=window+DAY) { await exception(); return null; }
  return new Date(Math.min(t+(verifiedUnknown?10*60_000:retry),window+DAY));
}
export async function endPaymentWindow(pool:Pool, attemptId:string, options:{now?:()=>Date;leaseToken?:string;tenantId?:string;signal?:AbortSignal}={}) {
  return isolatedTransaction(pool,async q=>{
    const a=await lockMachinePaymentAttempt(q,attemptId,options.tenantId); if(!a)return 'skipped' as const;
    const now=options.now?.()??new Date();
    const row=(await q.query(`SELECT *,lease_until::text AS token FROM commerce_due_work
      WHERE kind='payment_window_end' AND target_id=$1 FOR UPDATE`,[attemptId])).rows[0];
    if(options.signal?.aborted || !row || row.due_at>now || (row.lease_until && row.lease_until>now && row.token!==options.leaseToken))return 'skipped' as const;
    if (['issued','superseded'].includes(a.state) && !await hasDefinitePaymentMismatch(q,a)) {
      if (!a.handed_off_at) {
        await q.query(`UPDATE commerce_payment_attempts SET state='expired_unpaid',expired_at=GREATEST(clock_timestamp(),created_at),version=version+1 WHERE attempt_id=$1`,[attemptId]);
        await q.query("DELETE FROM commerce_due_work WHERE kind='payment_query' AND target_id=$1",[attemptId]);
        if(a.order_id)await settleOrderPayments(q,a.order_id);
      } else await scheduleDueWork(q,{tenantId:a.tenant_id,instanceId:a.instance_id,kind:'payment_query',targetId:attemptId,dueAt:now});
    }
    await q.query('DELETE FROM commerce_due_work WHERE due_work_id=$1',[row.due_work_id]);
    return 'completed' as const;
  });
}
