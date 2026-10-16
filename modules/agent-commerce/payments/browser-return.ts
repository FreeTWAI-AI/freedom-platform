import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { isolatedTransaction, clearTenantContext } from '../../../packages/resource-scopes/tenant-transaction.js';
import {hasDefinitePaymentMismatch} from './window.js';
import { bindStore } from '../checkout/authority.js';
import { scheduleDueWork } from '../operations/due-work.js';
import type { PaymentAccount } from './provider-input.js';
export function resolveReturnedAttempt(pool: Pool, account: PaymentAccount, tradeNumber: string, credentialVersion: number) {
  return isolatedTransaction(pool, async (q) => {
    await clearTenantContext(q);
    await bindStore(q, account.tenant_id);
    return (await q.query(`SELECT a.attempt_id,a.kind,a.order_id,p.slug FROM commerce_payment_attempts a
      JOIN commerce_storefront_profiles p ON p.tenant_id=a.tenant_id AND p.instance_id=a.instance_id
      JOIN commerce_provider_credentials c ON c.account_id=a.account_id AND c.purpose='payment' AND c.credential_version=$3 AND c.retired_at IS NULL
      WHERE a.account_id=$1 AND a.merchant_trade_no=$2 AND a.credential_version<=$3`, [account.account_id, tradeNumber, credentialVersion])).rows[0] ?? null;
  });
}
/** Browser returns are hints. Neither order nor attempt state is mutated. */
export function recordPaymentBrowserReturn(pool: Pool, input: {
  account: PaymentAccount;
  attemptId: string;
  merchantTradeNo: string;
  credentialVersion: number;
  body: Uint8Array;
  scheduleQuery: boolean;
}) {
  return isolatedTransaction(pool, async (q) => {
    const a = input.account;
    await clearTenantContext(q);
    await bindStore(q, a.tenant_id);
    // Take the attempt before due work, as the notification path does. The
    // deferred inbox FK must not acquire this lock for the first time at commit.
    const attempt=(await q.query('SELECT * FROM commerce_payment_attempts WHERE attempt_id=$1 FOR KEY SHARE', [input.attemptId])).rows[0];
    const recorded=await q.query(`INSERT INTO commerce_hosted_payment_events(tenant_id,instance_id,account_id,attempt_id,source,outcome,merchant_trade_no,credential_version,body_sha256,received_at,applied_at)
      SELECT $1,$2,$3,$4,'browser_return','returned',$5,$6,$7,t,t FROM (SELECT clock_timestamp() t) n
      ON CONFLICT(attempt_id) WHERE source='browser_return' DO NOTHING`, [a.tenant_id, a.instance_id, a.account_id, input.attemptId, input.merchantTradeNo, input.credentialVersion, createHash('sha256').update(input.body).digest('hex')]);
    const schedule=input.scheduleQuery && !await hasDefinitePaymentMismatch(q,attempt);
    if (schedule)
      await scheduleDueWork(q, { tenantId: a.tenant_id, instanceId: a.instance_id, kind: 'payment_query', targetId: input.attemptId, dueAt: (await q.query('SELECT clock_timestamp()::text AS t')).rows[0].t });
    return recorded.rowCount===1 && schedule;
  });
}
/** The order and current store slug of a retained order attempt. Reads only. */
function orderAttemptStore(pool: Pool, attemptId: string): Promise<{ slug: string; orderId: string } | null> {
  return isolatedTransaction(pool, async (q) => {
    const a = (await q.query("SELECT tenant_id,instance_id,order_id FROM commerce_payment_attempts WHERE attempt_id=$1 AND kind='order'", [attemptId])).rows[0];
    if (!a)
      return null;
    await clearTenantContext(q);
    await bindStore(q, a.tenant_id);
    const store = (await q.query('SELECT slug FROM commerce_storefront_profiles WHERE tenant_id=$1 AND instance_id=$2', [a.tenant_id, a.instance_id])).rows[0];
    return store?.slug ? { slug: store.slug, orderId: a.order_id } : null;
  });
}
export async function paymentBackLocation(pool: Pool, attemptId: string): Promise<string | null> {
  if((await pool.query("SELECT 1 FROM commerce_payment_attempts WHERE attempt_id=$1 AND kind='service_activation'",[attemptId])).rowCount)return '/';
  const found = await orderAttemptStore(pool, attemptId);
  return found ? `/shops/${found.slug}/orders/${found.orderId}` : null;
}
/** The B06 page resolves only an order attempt of the store with this slug; any
 * other attempt reads as missing. Binds no buyer or member identity. */
export async function resolvePaymentReturn(pool: Pool, slug: string, attemptId: string): Promise<{ order_ref: string } | null> {
  const found = await orderAttemptStore(pool, attemptId);
  return found?.slug === slug ? { order_ref: found.orderId } : null;
}
