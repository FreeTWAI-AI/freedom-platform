import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { requireCondition } from '../../../packages/shared/problem.js';
import { bindStore, lockStore, type CheckoutStore } from '../checkout/authority.js';
import { lockCheckoutOrders } from '../checkout/orders.js';
import { confirmedPaymentSQL } from '../checkout/confirmed-payment.js';
import { hashKey, type CheckoutAdmissionPort, type CheckoutPaymentPort, type CheckoutPaymentSummary } from '../checkout/terms.js';
import { scheduleDueWork } from '../operations/due-work.js';
import type { CommerceSettings } from '../operations/runtime-settings.js';
import { newTradeNumber } from '../providers/ecpay/index.js';
import { loadServiceCredentials } from './accounts.js';
import type { CommerceCredentialKeyring } from './credentials.js';
import { paymentGatewayUrls, type EcpayPaymentGateway } from './gateway.js';
import { assertCreditPaymentAvailable } from './availability.js';
export interface PaymentAttemptOptions {
  settings: CommerceSettings;
  profiles: readonly string[];
  environment: 'sandbox' | 'live';
  admission: CheckoutAdmissionPort;
  gateway?: EcpayPaymentGateway;
  keyring: CommerceCredentialKeyring | null;
}
export interface HandoffGate {
  status: 409 | 410 | 503;
  code: string;
  message: string;
}
const gate = (status: HandoffGate['status'], code: string, message: string) => ({ status, code, message });
/** Read-only eligibility is shared by token issuance, the handoff page and the buyer summary. */
export async function inspectOrderHandoff(q: PoolClient, attemptId: string, options: PaymentAttemptOptions) {
  const attempt = (await q.query('SELECT * FROM commerce_payment_attempts WHERE attempt_id=$1', [attemptId])).rows[0];
  if (!attempt)
    return { failure: gate(410, 'payment_handoff_unavailable', '付款連結已失效。') } as const;
  await bindStore(q, attempt.tenant_id);
  const store = (await q.query(`SELECT p.*,shop.name,shop.currency,t.status AS tenant_status,i.status AS instance_status FROM commerce_storefront_profiles p
    JOIN commerce_shops shop ON shop.shop_id=p.storefront_shop_id
    JOIN tenants t USING(tenant_id) JOIN module_instances i ON i.tenant_id=p.tenant_id AND i.instance_id=p.instance_id
    WHERE p.tenant_id=$1 AND p.instance_id=$2`, [attempt.tenant_id, attempt.instance_id])).rows[0];
  if (options.settings.quarantine)
    return { failure: gate(503, 'commerce_quarantined', '商店系統維護中，訂單資料核對中。') } as const;
  if (!options.settings.checkoutEnabled)
    return { failure: gate(503, 'checkout_not_enabled', '商店目前暫停接單。') } as const;
  if (!options.gateway || options.gateway.environment !== attempt.environment || !options.profiles.includes(attempt.profile))
    return { failure: gate(503, 'payment_handoff_unavailable', '付款服務暫時無法使用。') } as const;
  if (!store || store.tenant_status !== 'active' || store.instance_status !== 'active')
    return { failure: gate(409, 'payment_handoff_unavailable', '商店目前無法接受付款。') } as const;
  const service = (await q.query(`SELECT 1 FROM commerce_provider_account_services WHERE account_id=$1 AND purpose='payment' AND state='active'
    AND tenant_id=$2 AND instance_id=$3 AND environment=$4 AND profile=$5`, [attempt.account_id, attempt.tenant_id, attempt.instance_id, attempt.environment, attempt.profile])).rowCount;
  if (service !== 1)
    return { failure: gate(409, 'payment_handoff_unavailable', '商店目前無法接受付款。') } as const;
  if (!await options.admission.allowed(q, store))
    return { failure: gate(409, 'checkout_not_enabled', '商店目前無法接受付款。') } as const;
  const order = (await q.query(`SELECT co.*,o.currency,o.total_minor FROM commerce_checkout_orders co JOIN commerce_orders o USING(order_id)
    WHERE co.order_id=$1 AND co.tenant_id=$2 AND co.instance_id=$3`, [attempt.order_id, attempt.tenant_id, attempt.instance_id])).rows[0];
  if (!order || order.lifecycle_state !== 'open')
    return { failure: gate(409, 'payment_handoff_unavailable', '訂單目前無法付款。') } as const;
  const holds = (await q.query(`SELECT count(*)::int AS total,bool_and(state='held' AND expires_at>clock_timestamp()) AS live
    FROM commerce_inventory_reservations WHERE order_id=$1`, [attempt.order_id])).rows[0];
  if (!holds.total || !holds.live)
    return { failure: gate(409, 'payment_handoff_unavailable', '保留時間已結束') } as const;
  if (attempt.state !== 'issued' || attempt.handed_off_at)
    return { failure: gate(410, 'payment_handoff_unavailable', '已前往付款頁。要重新付款，請回到訂單頁。') } as const;
  if (!options.keyring)
    return { failure: gate(503, 'payment_handoff_unavailable', '付款服務暫時無法使用。') } as const;
  try {
    const credentials = await loadServiceCredentials(q, options.keyring, { accountId: attempt.account_id, purpose: 'payment', credentialVersion: attempt.credential_version });
    const route = (await q.query(`SELECT route_key FROM commerce_entry_routes WHERE route_kind='provider_account' AND target_id=$1 AND revoked_at IS NULL`, [attempt.account_id])).rows[0];
    if (!route)
      throw Error();
    const urls = paymentGatewayUrls(options.gateway, { accountRef: route.route_key, attemptId });
    return { attempt, order, store, credentials, accountRef: route.route_key as string, urls, gateway: options.gateway, failure: null } as const;
  }
  catch {
    return { failure: gate(503, 'payment_handoff_unavailable', '付款服務暫時無法使用。') } as const;
  }
}
export function createCheckoutPaymentPort(options: PaymentAttemptOptions): CheckoutPaymentPort {
  return {
    assertTermsAvailable: assertCreditPaymentAvailable,
    async createOrderAttempt(q, input) {
      const store = (await q.query('SELECT tenant_id,instance_id FROM commerce_storefront_profiles WHERE storefront_shop_id=$1', [input.store.storefront_shop_id])).rows[0];
      requireCondition(store, 409, 'payment_handoff_unavailable', '付款服務暫時無法使用。');
      await bindStore(q, store.tenant_id);
      const account = (await q.query(`SELECT a.account_id,a.merchant_id,s.credential_version,s.profile FROM commerce_provider_accounts a
        JOIN commerce_provider_account_services s USING(account_id) JOIN commerce_provider_credentials c ON c.account_id=s.account_id AND c.purpose=s.purpose AND c.credential_version=s.credential_version
        WHERE a.tenant_id=$1 AND a.instance_id=$2 AND a.environment=$3 AND s.purpose='payment' AND s.state='active' AND s.profile=ANY($4::text[]) AND c.retired_at IS NULL
        ORDER BY a.account_id LIMIT 1 FOR SHARE OF a,s,c`, [store.tenant_id, store.instance_id, input.environment, options.profiles])).rows[0];
      requireCondition(account, 409, 'payment_handoff_unavailable', '付款服務暫時無法使用。');
      for (let i = 0;i < 5;i++) {
        const inserted = (await q.query(`INSERT INTO commerce_payment_attempts(tenant_id,instance_id,kind,order_id,sequence,account_id,purpose,environment,merchant_id,credential_version,provider,profile,merchant_trade_no,amount_minor,currency)
          VALUES($1,$2,'order',$3,1,$4,'payment',$5,$6,$7,'ecpay',$8,$9,$10,$11)
          ON CONFLICT(provider,environment,merchant_id,merchant_trade_no) DO NOTHING
          RETURNING attempt_id,(created_at+interval '10 minutes')::text AS query_due,(created_at+interval '60 minutes')::text AS window_due`, [store.tenant_id, store.instance_id, input.orderId, account.account_id, input.environment, account.merchant_id, account.credential_version, account.profile, newTradeNumber('F'), input.amountMinor, input.currency])).rows[0];
        if (!inserted)
          continue;
        for (const [kind, dueAt] of [['payment_query', inserted.query_due], ['payment_window_end', inserted.window_due]] as const)
          await scheduleDueWork(q, { tenantId: store.tenant_id, instanceId: store.instance_id, kind, targetId: inserted.attempt_id, dueAt });
        return;
      }
      throw Error('payment_trade_number_unavailable');
    },
    async issueHandoff(q, input) {
      await lockStore(q, input.store, [], [input.orderId], false);
      await lockCheckoutOrders(q, [input.orderId], input.store);
      const attempt = (await q.query('SELECT attempt_id FROM commerce_payment_attempts WHERE order_id=$1 ORDER BY sequence DESC LIMIT 1', [input.orderId])).rows[0];
      if (!attempt)
        return null;
      const context = await inspectOrderHandoff(q, attempt.attempt_id, options);
      if (context.failure)
        return null;
      await q.query(`UPDATE commerce_entry_routes SET revoked_at=clock_timestamp() WHERE route_kind='payment_handoff' AND target_id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp()`, [attempt.attempt_id]);
      for (let i = 0;i < 16;i++) {
        const token = randomBytes(32).toString('base64url');
        const route = (await q.query(`INSERT INTO commerce_entry_routes(route_kind,route_key,tenant_id,instance_id,target_id,created_at,expires_at)
          SELECT 'payment_handoff',$1,$2,$3,$4,t,t+interval '15 minutes' FROM (SELECT clock_timestamp() t) n
          ON CONFLICT(route_kind,route_key) DO NOTHING RETURNING expires_at`, [hashKey(token), context.attempt.tenant_id, context.attempt.instance_id, attempt.attempt_id])).rows[0];
        if (route)
          return { handoff_url: '/pay/ecpay/' + token, attempt_ref: attempt.attempt_id, expires_at: route.expires_at.toISOString() };
      }
      throw Error('payment_handoff_token_unavailable');
    },
    async onOrdersCancelled(q, orderIds) {
      const attempts = (await q.query(`SELECT *,clock_timestamp()::text AS query_due FROM commerce_payment_attempts WHERE order_id=ANY($1::uuid[]) ORDER BY order_id,attempt_id FOR UPDATE`, [orderIds])).rows;
      await q.query(`UPDATE commerce_entry_routes SET revoked_at=clock_timestamp() WHERE route_kind='payment_handoff' AND target_id=ANY($1::uuid[]) AND revoked_at IS NULL`, [attempts.map(a => a.attempt_id)]);
      for (const a of attempts)
        if (a.handed_off_at && ['issued', 'superseded'].includes(a.state))
          await scheduleDueWork(q, { tenantId: a.tenant_id, instanceId: a.instance_id, kind: 'payment_query', targetId: a.attempt_id, dueAt: a.query_due });
    },
    async summarize(q, orderIds) {
      const rows = (await q.query(`SELECT co.order_id,${confirmedPaymentSQL('co.order_id')} AS confirmed,
        EXISTS(SELECT 1 FROM commerce_checkout_payment_applications p WHERE p.order_id=co.order_id AND p.outcome='simulated') AS simulated,
        EXISTS(SELECT 1 FROM commerce_hosted_payment_events e JOIN commerce_payment_attempts a USING(attempt_id) WHERE a.order_id=co.order_id AND e.source='notification' AND e.outcome='paid' AND e.applied_at IS NULL) AS unapplied_paid,
        a.attempt_id,a.state,a.created_at,a.handed_off_at,
        EXISTS(SELECT 1 FROM commerce_hosted_payment_events e WHERE e.attempt_id=a.attempt_id AND e.outcome='pending_confirmation'
          AND NOT EXISTS(SELECT 1 FROM commerce_hosted_payment_events later WHERE later.attempt_id=a.attempt_id AND later.outcome IN ('paid','failed') AND (later.received_at,later.event_id)>(e.received_at,e.event_id))) AS pending_confirmation,
        (a.state='issued' AND a.created_at+interval '60 minutes'>clock_timestamp() AND EXISTS(SELECT 1 FROM commerce_hosted_payment_events e WHERE e.attempt_id=a.attempt_id AND e.source='browser_return')) AS returned
        FROM commerce_checkout_orders co LEFT JOIN LATERAL (SELECT * FROM commerce_payment_attempts WHERE order_id=co.order_id ORDER BY sequence DESC LIMIT 1) a ON true
        WHERE co.order_id=ANY($1::uuid[]) ORDER BY co.order_id`, [orderIds])).rows;
      const summaries = new Map<string, CheckoutPaymentSummary>();
      for (const row of rows) {
        const payment_state = row.confirmed ? 'confirmed' : row.unapplied_paid || row.pending_confirmation || row.returned ? 'pending' : row.simulated ? 'simulated' : 'unpaid';
        const state = row.state === 'issued' ? (row.handed_off_at ? 'awaiting_result' : 'ready') : ['paid', 'confirmed'].includes(row.state) ? 'paid' : row.state === 'failed' ? 'failed' : 'expired';
        const canResume = Boolean(row.attempt_id && !(await inspectOrderHandoff(q, row.attempt_id, options)).failure);
        summaries.set(row.order_id, { payment_state, latest_payment_attempt: row.attempt_id ? { attempt_ref: row.attempt_id, state, created_at: row.created_at.toISOString() } : null, can_resume_payment: canResume });
      }
      return summaries;
    },
  };
}
