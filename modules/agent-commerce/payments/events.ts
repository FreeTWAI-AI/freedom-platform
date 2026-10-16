import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { isolatedTransaction, clearTenantContext } from '../../../packages/resource-scopes/tenant-transaction.js';
import { bindStore, lockMachineOrder } from '../checkout/authority.js';
import { lockCheckoutOrders } from '../checkout/orders.js';
import { applyConfirmedPayment } from '../checkout/payments.js';
import { openException, type PaymentExceptionKind } from '../checkout/exceptions.js';
import { applyQueryResult } from './queries.js';
import { hasDefinitePaymentMismatch,settleOrderPayments,PAYMENT_WINDOW_MS } from './window.js';
import { scheduleDueWork } from '../operations/due-work.js';
import { queuePaymentOutcomeEmail, type CommerceEmailOutbox } from '../operations/notifications/outbox.js';
import type { PaymentNotification } from '../providers/ecpay/aio-credit/index.js';
import type { PaymentAccount } from './provider-input.js';
export class InvalidPaymentCredential extends Error {
  constructor() { super('credential_version_mismatch'); }
}
const safePaymentType = (value: string | null) => value !== null && /^[A-Za-z0-9_]{1,40}$/.test(value) ? value : null;
export function notificationDedupe(accountId: string, message: PaymentNotification): string {
  const d = message.dedupe;
  return createHash('sha256').update(JSON.stringify([accountId, d.merchantTradeNo, d.tradeNo, d.rtnCode, d.simulatePaid, d.paymentDate])).digest('hex');
}
/** The inbox insert precedes lifecycle/order/attempt locks. Its attempt FK is
 * deferred so insertion does not invert the checkout lock order. */
export function receivePaymentNotification(pool: Pool, input: {
  account: PaymentAccount;
  message: PaymentNotification;
  credentialVersion: number;
  quarantine: boolean;
  email?: CommerceEmailOutbox;
}) {
  return isolatedTransaction(pool, async (q) => {
    const { account: a, message: m } = input;
    await clearTenantContext(q);
    await bindStore(q, a.tenant_id);
    const attempt = (await q.query('SELECT attempt_id,credential_version,order_id FROM commerce_payment_attempts WHERE account_id=$1 AND merchant_trade_no=$2', [a.account_id, m.merchantTradeNo])).rows[0];
    // Account before credential matches retirement and precedes the inbox account FK.
    await q.query('SELECT 1 FROM commerce_provider_accounts WHERE account_id=$1 FOR KEY SHARE', [a.account_id]);
    const credential = await q.query("SELECT 1 FROM commerce_provider_credentials WHERE account_id=$1 AND purpose='payment' AND credential_version=$2 AND retired_at IS NULL FOR SHARE", [a.account_id, input.credentialVersion]);
    if (!credential.rowCount || (attempt && input.credentialVersion < attempt.credential_version))
      throw new InvalidPaymentCredential();
    const event = (await q.query(`INSERT INTO commerce_hosted_payment_events(tenant_id,instance_id,account_id,attempt_id,source,outcome,merchant_trade_no,trade_no,rtn_code,simulate_paid,payment_date,payment_type,trade_amt_minor,charge_fee_minor,gwsr,credential_version,body_sha256,dedupe_key)
      VALUES($1,$2,$3,$4,'notification',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT(account_id,dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING event_id`, [a.tenant_id, a.instance_id, a.account_id, attempt?.attempt_id ?? null, m.outcome, m.merchantTradeNo, m.tradeNo, m.rtnCode, m.dedupe.simulatePaid === '1',
    m.paymentDateEpochMs === null ? null : new Date(m.paymentDateEpochMs), safePaymentType(m.paymentType), m.tradeAmtMinor, m.chargeFeeMinor, m.gwsr, input.credentialVersion, m.bodySha256, notificationDedupe(a.account_id, m)])).rows[0];
    if (!event)
      return null;
    if (!attempt || !input.quarantine)
      await applyPaymentEvent(q, event.event_id, { email: input.email });
    if (!attempt || input.quarantine)
      return null;
    const queryDue = Boolean((await q.query("SELECT 1 FROM commerce_due_work WHERE kind='payment_query' AND target_id=$1 AND due_at<=clock_timestamp()", [attempt.attempt_id])).rowCount);
    const attemptId = queryDue ? (attempt.attempt_id as string) : null;
    const orderId = (attempt.order_id ?? null) as string | null;
    return attemptId || orderId ? { attemptId, orderId } : null;
  });
}
/** Shared by synchronous receipt and deferred replay. Machine account provenance
 * binds the tenant; no member principal participates. */
export async function applyPaymentEvent(q: PoolClient, eventId: string, options: { email?: CommerceEmailOutbox } = {}): Promise<boolean> {
  let event = (await q.query("SELECT * FROM commerce_hosted_payment_events WHERE event_id=$1 AND source='notification'", [eventId])).rows[0];
  if (!event || event.applied_at)
    return false;
  await clearTenantContext(q);
  await bindStore(q, event.tenant_id);
  let attempt = event.attempt_id ? (await q.query('SELECT * FROM commerce_payment_attempts WHERE attempt_id=$1', [event.attempt_id])).rows[0] : null;
  const paymentRef = event.outcome === 'simulated' ? event.event_id : event.attempt_id;
  if (attempt?.order_id) {
    await lockMachineOrder(q, attempt.order_id);
    await lockCheckoutOrders(q, [attempt.order_id], undefined, paymentRef);
  }
  else if (attempt) {
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`checkout-payment/${paymentRef}`]);
    await q.query('SELECT attempt_id FROM commerce_payment_attempts WHERE attempt_id=$1 FOR UPDATE', [attempt.attempt_id]);
  }
  event = (await q.query('SELECT *,received_at::text AS received_at_order FROM commerce_hosted_payment_events WHERE event_id=$1 FOR UPDATE', [eventId])).rows[0];
  if (event.applied_at)
    return false;
  // The order/attempt locks serialize application; browser hints never block
  // verified notifications, and unmatched events are independent.
  if (attempt && (await q.query(`SELECT 1 FROM commerce_hosted_payment_events
    WHERE attempt_id=$1 AND source IN ('notification','query') AND applied_at IS NULL
    AND (received_at,event_id)<($2::timestamptz,$3::uuid) LIMIT 1`,
    [attempt.attempt_id, event.received_at_order, event.event_id])).rowCount)
    return false;
  if (attempt)
    attempt = (await q.query('SELECT * FROM commerce_payment_attempts WHERE attempt_id=$1', [attempt.attempt_id])).rows[0];
  const exception = (kind: PaymentExceptionKind, subjectKind: 'payment_attempt' | 'payment_event' = 'payment_attempt') => openException(q, {
    tenantId: event.tenant_id, instanceId: event.instance_id, orderId: attempt?.order_id ?? null, kind, subjectKind, subjectId: subjectKind === 'payment_event' ? eventId : attempt!.attempt_id
  });
  const schedule = async () => {
    if (!['confirmed','failed','expired_unpaid'].includes(attempt!.state) && !await hasDefinitePaymentMismatch(q,attempt))
      await scheduleDueWork(q, { tenantId: event.tenant_id, instanceId: event.instance_id, kind: 'payment_query', targetId: attempt!.attempt_id, dueAt: (await q.query('SELECT clock_timestamp()::text AS t')).rows[0].t });
  };
  const apply = async (simulated: boolean) => {
    if (!attempt!.order_id) return null;
    const application = await applyConfirmedPayment(q, { orderId: attempt!.order_id, paymentRef, amountMinor: Number(event.trade_amt_minor), currency: attempt!.currency, simulated });
    await queuePaymentOutcomeEmail(q, options.email, { tenantId: event.tenant_id, instanceId: event.instance_id, application });
    return application;
  };
  if (!attempt)
    await exception('unmatched_payment', 'payment_event');
  else if (event.outcome === 'simulated')
    await apply(true);
  else if (event.outcome === 'paid') {
    if (Number(event.trade_amt_minor) !== Number(attempt.amount_minor)) {
      await apply(false);
      await exception('amount_mismatch');
      await q.query("DELETE FROM commerce_due_work WHERE kind='payment_query' AND target_id=$1",[attempt.attempt_id]);
    }
    else {
      if (attempt.state !== 'paid' && attempt.state !== 'confirmed')
        await q.query(`UPDATE commerce_payment_attempts SET state='paid',paid_at=clock_timestamp(),
        trade_no=coalesce(trade_no,$2),payment_date=coalesce(payment_date,$3),payment_type=coalesce(payment_type,$4),charge_fee_minor=coalesce(charge_fee_minor,$5),gwsr=coalesce(gwsr,$6),version=version+1 WHERE attempt_id=$1`, [attempt.attempt_id, event.trade_no, event.payment_date, event.payment_type, event.charge_fee_minor, event.gwsr]);
      const application = await apply(false);
      const cases = { unallocatable: 'paid_unallocatable', after_cancel: 'paid_after_cancel', overpaid: 'overpaid' } as const;
      if (application && application.outcome in cases)
        await exception(cases[application.outcome as keyof typeof cases]);
      await schedule();
    }
  }
  else if (event.outcome === 'failed') {
    if (['issued', 'superseded'].includes(attempt.state))
      await q.query("UPDATE commerce_payment_attempts SET state='failed',failed_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1", [attempt.attempt_id]);
    else if (['paid', 'confirmed'].includes(attempt.state))
      await exception('contradicting_event');
  }
  else if (event.outcome === 'pending_confirmation')
    await schedule();
  await q.query('UPDATE commerce_hosted_payment_events SET applied_at=clock_timestamp() WHERE event_id=$1 AND applied_at IS NULL', [eventId]);
  if(attempt?.order_id && Date.now()>=attempt.created_at.getTime()+PAYMENT_WINDOW_MS)await settleOrderPayments(q,attempt.order_id);
  return true;
}
/** Each verified event commits separately, in receipt order. The host skips this
 * worker while commerce is quarantined; no provider query is executed here. */
export async function applyDeferredPaymentEvents(pool: Pool, { limit = 200, email }: {
  limit?: number;
  email?: CommerceEmailOutbox;
} = {}): Promise<{ applied: number; failed: number; skipped: number }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw Error('payment_deferred_limit_invalid');
  const events = (await pool.query("SELECT event_id,attempt_id,source FROM commerce_hosted_payment_events WHERE source IN ('notification','query') AND applied_at IS NULL ORDER BY received_at,event_id LIMIT $1", [limit])).rows;
  const counts = { applied: 0, failed: 0, skipped: 0 }, failedAttempts = new Set<string>();
  for (const event of events) {
    if (event.attempt_id && failedAttempts.has(event.attempt_id)) {
      counts.skipped++;
      continue;
    }
    try {
      if (await isolatedTransaction(pool, q => event.source==='query'?applyQueryResult(q,event.event_id,{updateDueWork:true,email}):applyPaymentEvent(q, event.event_id, {email})))
        counts.applied++;
      else
        counts.skipped++;
    }
    catch {
      console.error('commerce_payment_event_apply_failed', event.event_id);
      counts.failed++;
      if (event.attempt_id)
        failedAttempts.add(event.attempt_id);
    }
  }
  return counts;
}
