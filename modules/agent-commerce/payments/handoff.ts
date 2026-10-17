import {createHash} from 'node:crypto';
import {lockMachinePaymentAttempt} from './window.js';
import type { Pool } from 'pg';
import { isolatedTransaction } from '../../../packages/resource-scopes/tenant-transaction.js';
import { Problem } from '../../../packages/shared/problem.js';
import { bindStore, lockStore } from '../checkout/authority.js';
import { lockCheckoutOrders } from '../checkout/orders.js';
import { hashKey } from '../checkout/terms.js';
import { chargeCommerceBudgets } from '../checkout/limits.js';
import type { EffectJournalPort } from '../operations/journal/journal.js';
import { buildCreditCheckoutForm,formatTaipeiDateTime } from '../providers/ecpay/aio-credit/index.js';
import { inspectOrderHandoff, inspectOrderHandoffGate, type PaymentAttemptOptions } from './attempts.js';
import { handoffErrorPage, handoffFormPage } from './handoff-page.js';
/** First thirty SHA-256 bits in Crockford base32, with the Taipei creation day. */
export function activationDisplayNumber(attemptId:string,createdAt:Date):string{
  const alphabet='0123456789ABCDEFGHJKMNPQRSTVWXYZ',prefix=createHash('sha256').update(attemptId).digest().readUInt32BE(0);
  return formatTaipeiDateTime(createdAt.getTime()).slice(2,10).replaceAll('/','')+'-'+Array.from({length:6},(_,i)=>alphabet[(prefix>>>(27-i*5))&31]).join('');
}
export const HANDOFF_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const isPaymentHandoffPath = (path: string) => /^\/pay\/ecpay\/[A-Za-z0-9_-]{43}$/.test(path);
const invalidText = '付款連結已失效或不存在。';
type Page = {
  status: 200 | 404 | 409 | 410 | 429 | 503;
  html: string;
  retryAfterSeconds?: number;
};
const invalid = (status: 404 | 410, attemptId?: string): Page => ({ status, html: handoffErrorPage(invalidText, attemptId ? '/pay/ecpay/back/' + attemptId : undefined) });
export async function servePaymentHandoff(pool: Pool, token: string, network: string, options: PaymentAttemptOptions & {
  journal?: EffectJournalPort;
}): Promise<Page> {
  if (!HANDOFF_TOKEN.test(token))
    return invalid(404);
  try {
    await chargeCommerceBudgets(pool, network, { network: 'handoffPageNetwork' });
  }
  catch (error) {
    if (error instanceof Problem && error.status === 429)
      return { status: 429, html: handoffErrorPage('操作太頻繁，請稍後再試。'), retryAfterSeconds: error.retryAfterSeconds };
    throw error;
  }
  const route = (await pool.query(`SELECT *,expires_at<=clock_timestamp() AS expired FROM commerce_entry_routes WHERE route_kind='payment_handoff' AND route_key=$1`, [hashKey(token)])).rows[0];
  if (!route)
    return invalid(404);
  if (route.revoked_at || route.expired)
    return invalid(410, route.target_id);
  const prepared = await isolatedTransaction(pool, async (q) => {
    await bindStore(q, route.tenant_id);
    const target = (await q.query('SELECT tenant_id,instance_id FROM commerce_payment_attempts WHERE attempt_id=$1', [route.target_id])).rows[0];
    if (!target || target.tenant_id !== route.tenant_id || target.instance_id !== route.instance_id)
      return null;
    const context = await inspectOrderHandoff(q, route.target_id, options);
    if (context.failure)
      return { failure: context.failure } as const;
    try {
      const lines = (await q.query('SELECT quantity,snapshot FROM commerce_order_lines WHERE order_id=$1 ORDER BY item_id', [context.attempt.order_id])).rows;
      const form = buildCreditCheckoutForm({
        environment: context.attempt.environment, merchantId: context.attempt.merchant_id, merchantTradeNo: context.attempt.merchant_trade_no,
        createdAtEpochMs: context.attempt.created_at.getTime(), currency: context.attempt.currency, totalMinor: Number(context.attempt.amount_minor),
        lines: context.attempt.kind==='service_activation'?[{name:'收款服務驗證',quantity:1}]:lines.map(l => ({ name: l.snapshot.title, quantity: l.quantity })), storeName: context.store.name, displayNumber: context.order?.display_number??activationDisplayNumber(context.attempt.attempt_id,context.attempt.created_at), ...context.urls
      }, context.credentials.keys);
      return { context, form, failure: null } as const;
    }
    catch {
      return { failure: { status: 503 as const, code: 'payment_handoff_unavailable', message: '付款服務暫時無法使用。' } } as const;
    }
  });
  if (!prepared)
    return invalid(410, route.target_id);
  const back = '/pay/ecpay/back/' + route.target_id;
  if (prepared.failure)
    return { status: prepared.failure.status, html: handoffErrorPage(prepared.failure.message, back) };
  const { context, form } = prepared;
  if (!context.attempt.journaled_at) {
    try {
      if (!options.journal)
        throw Error();
      await options.journal.append({
        environment: options.journal.environment, kind: 'payment_handoff', id: context.attempt.attempt_id, occurred_at: context.attempt.created_at.toISOString(),
        tenant_id: route.tenant_id, instance_id: route.instance_id, detail: { account_ref: context.accountRef, merchant_trade_no: context.attempt.merchant_trade_no, amount_minor: Number(context.attempt.amount_minor), currency: context.attempt.currency, ...(context.attempt.order_id?{order_id:context.attempt.order_id}:{}) }
      });
      await isolatedTransaction(pool, q => q.query('UPDATE commerce_payment_attempts SET journaled_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1 AND journaled_at IS NULL', [route.target_id]));
    }
    catch {
      console.error('commerce_handoff_journal_failed');
      return { status: 503, html: handoffErrorPage('付款服務暫時無法使用，請稍後再試。', back) };
    }
  }
  const consumed = await isolatedTransaction(pool, async (q) => {
    await bindStore(q, route.tenant_id);
    if(context.attempt.kind==='service_activation')await lockMachinePaymentAttempt(q,context.attempt.attempt_id);
    else {await lockStore(q, context.store, [], [context.attempt.order_id], false);
      await lockCheckoutOrders(q, [context.attempt.order_id], context.store, context.attempt.attempt_id);}
    const attempt = (await q.query('SELECT * FROM commerce_payment_attempts WHERE attempt_id=$1 FOR UPDATE', [route.target_id])).rows[0];
    const current = (await q.query(`SELECT *,expires_at>clock_timestamp() AS live FROM commerce_entry_routes WHERE route_kind='payment_handoff' AND route_key=$1 FOR UPDATE`, [route.route_key])).rows[0];
    if (!current || current.revoked_at || !current.live || attempt.state !== 'issued' || attempt.handed_off_at || !attempt.journaled_at)
      return null;
    const gate = await inspectOrderHandoffGate(q, route.target_id, options);
    if (gate.failure)
      return { failure: gate.failure };
    await q.query(`UPDATE commerce_entry_routes SET revoked_at=clock_timestamp() WHERE route_kind='payment_handoff' AND route_key=$1`, [route.route_key]);
    await q.query('UPDATE commerce_payment_attempts SET handed_off_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1', [route.target_id]);
    return { failure: null };
  });
  if (!consumed)
    return invalid(410, route.target_id);
  if (consumed.failure)
    return { status: consumed.failure.status, html: handoffErrorPage(consumed.failure.message, back) };
  return { status: 200, html: handoffFormPage(form, context.gateway.checkoutAction, context.attempt.attempt_id) };
}
