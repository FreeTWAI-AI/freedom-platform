import {isolatedTransaction} from '../../../packages/resource-scopes/tenant-transaction.js';
import {queryAttempt,type PaymentQueryDependencies} from './queries.js';
import {hasDefinitePaymentMismatch,lockMachinePaymentAttempt} from './window.js';
import {chargePaymentQueryOrderBudgets} from '../checkout/limits.js';
import type {CheckoutPaymentActions} from '../checkout/terms.js';
import { randomBytes } from 'node:crypto';
import type { Pool,PoolClient } from 'pg';
import {Problem, requireCondition } from '../../../packages/shared/problem.js';
import { bindStore, lockStore, type CheckoutStore } from '../checkout/authority.js';
import { lockCheckoutOrders } from '../checkout/orders.js';
import { confirmedPaymentSQL } from '../checkout/confirmed-payment.js';
import { hashKey, type CheckoutAdmissionPort, type CheckoutPaymentPort, type CheckoutPaymentSummary, type UnresolvedOrderPort } from '../checkout/terms.js';
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
/** Cancellation retains provider responsibility but revokes every bearer link.
 * Mismatch facts are definite even though their attempt state is unchanged. */
export async function onPaymentOrdersCancelled(q: PoolClient, orderIds: readonly string[]) {
  const attempts = (await q.query(`SELECT a.*,clock_timestamp()::text AS query_due FROM commerce_payment_attempts a
    WHERE a.order_id=ANY($1::uuid[]) ORDER BY a.order_id,a.attempt_id FOR UPDATE`, [orderIds])).rows;
  await q.query(`UPDATE commerce_entry_routes SET revoked_at=clock_timestamp() WHERE route_kind='payment_handoff'
    AND target_id=ANY($1::uuid[]) AND revoked_at IS NULL`, [attempts.map(a => a.attempt_id)]);
  for (const a of attempts) {
    const mismatch = (await q.query(`SELECT 1 FROM commerce_hosted_payment_events e WHERE attempt_id=$1
      AND ((source='query' AND (outcome IN ('amount_mismatch','trade_no_mismatch')
          OR (outcome='paid' AND trade_no<>$3)))
        OR (source='notification' AND outcome='paid' AND trade_amt_minor<>$2)) LIMIT 1`, [a.attempt_id, a.amount_minor, a.trade_no])).rowCount;
    if (a.handed_off_at && ['issued','superseded'].includes(a.state) && !mismatch)
      await scheduleDueWork(q, { tenantId:a.tenant_id, instanceId:a.instance_id, kind:'payment_query', targetId:a.attempt_id, dueAt:a.query_due });
  }
}
const gate = (status: HandoffGate['status'], code: string, message: string) => ({ status, code, message });
/** Read-only gates never load credentials or provider entry routes. */
export async function inspectOrderHandoffGate(q: PoolClient, attemptId: string, options: PaymentAttemptOptions,repay=false) {
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
  if (attempt.kind==='order' && !options.settings.checkoutEnabled)
    return { failure: gate(503, 'checkout_not_enabled', '商店目前暫停接單。') } as const;
  if (!options.gateway || options.gateway.environment !== attempt.environment || !options.profiles.includes(attempt.profile))
    return { failure: gate(503, 'payment_handoff_unavailable', '付款服務暫時無法使用。') } as const;
  if (!store || store.tenant_status !== 'active' || store.instance_status !== 'active')
    return { failure: gate(409, 'payment_handoff_unavailable', '商店目前無法接受付款。') } as const;
  const service = (await q.query(`SELECT 1 FROM commerce_provider_account_services WHERE account_id=$1 AND purpose='payment' AND state=$6
    AND tenant_id=$2 AND instance_id=$3 AND environment=$4 AND profile=$5`, [attempt.account_id, attempt.tenant_id, attempt.instance_id, attempt.environment, attempt.profile,attempt.kind==='service_activation'?'draft':'active'])).rowCount;
  if (service !== 1)
    return { failure: gate(409, 'payment_handoff_unavailable', '商店目前無法接受付款。') } as const;
  if(attempt.kind==='service_activation'){
    if(attempt.state!=='issued'||attempt.handed_off_at)return {failure:gate(410,'payment_handoff_unavailable','已前往付款頁。要重新付款，請回到訂單頁。')} as const;
    if(!options.keyring)return {failure:gate(503,'payment_handoff_unavailable','付款服務暫時無法使用。')} as const;
    return {attempt,order:null,store,gateway:options.gateway,keyring:options.keyring,failure:null} as const;
  }
  if (!await options.admission.allowed(q, store))
    return { failure: gate(409, 'checkout_not_enabled', '商店目前無法接受付款。') } as const;
  const order = (await q.query(`SELECT co.*,o.currency,o.total_minor FROM commerce_checkout_orders co JOIN commerce_orders o USING(order_id)
    WHERE co.order_id=$1 AND co.tenant_id=$2 AND co.instance_id=$3`, [attempt.order_id, attempt.tenant_id, attempt.instance_id])).rows[0];
  if (!order || order.lifecycle_state !== 'open')
    return { failure: gate(409, repay?'checkout_order_closed':'payment_handoff_unavailable', '訂單目前無法付款。') } as const;
  const holds = (await q.query(`SELECT count(*)::int AS total,bool_and(state='held' AND expires_at>clock_timestamp()) AS live
    FROM commerce_inventory_reservations WHERE order_id=$1`, [attempt.order_id])).rows[0];
  if (!holds.total || !holds.live)
    return { failure: gate(409, repay?'checkout_hold_expired':'payment_handoff_unavailable', repay?'保留時間已結束，請回到購物車重新下單。':'付款期限已過，保留的商品已釋出。') } as const;
  if (!repay && (attempt.state !== 'issued' || attempt.handed_off_at))
    return { failure: gate(410, 'payment_handoff_unavailable', '已前往付款頁。要重新付款，請回到訂單頁。') } as const;
  if (!options.keyring)
    return { failure: gate(503, 'payment_handoff_unavailable', '付款服務暫時無法使用。') } as const;
  return { attempt, order, store, gateway: options.gateway, keyring: options.keyring, failure: null } as const;
}
/** Only token issuance and the handoff page need credential material and URLs. */
export async function inspectOrderHandoff(q: PoolClient, attemptId: string, options: PaymentAttemptOptions) {
  const context = await inspectOrderHandoffGate(q, attemptId, options);
  if (context.failure)
    return context;
  const { attempt, gateway, keyring } = context;
  try {
    const credentials = await loadServiceCredentials(q, keyring, { accountId: attempt.account_id, purpose: 'payment', credentialVersion: attempt.credential_version });
    const route = (await q.query(`SELECT route_key FROM commerce_entry_routes WHERE route_kind='provider_account' AND target_id=$1 AND revoked_at IS NULL`, [attempt.account_id])).rows[0];
    if (!route)
      throw Error();
    const urls = paymentGatewayUrls(gateway, { accountRef: route.route_key, attemptId });
    return { ...context, credentials, accountRef: route.route_key as string, urls } as const;
  }
  catch {
    return { failure: gate(503, 'payment_handoff_unavailable', '付款服務暫時無法使用。') } as const;
  }
}
export async function createOrderPaymentAttempt(q:PoolClient,input:{store:CheckoutStore;orderId:string;amountMinor:number;currency:string;environment:'sandbox'|'live';sequence?:number},options:PaymentAttemptOptions){
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
          VALUES($1,$2,'order',$3,$12,$4,'payment',$5,$6,$7,'ecpay',$8,$9,$10,$11)
          ON CONFLICT(provider,environment,merchant_id,merchant_trade_no) DO NOTHING
          RETURNING attempt_id,(created_at+interval '10 minutes')::text AS query_due,(created_at+interval '60 minutes')::text AS window_due`, [store.tenant_id, store.instance_id, input.orderId, account.account_id, input.environment, account.merchant_id, account.credential_version, account.profile, newTradeNumber('F'), input.amountMinor, input.currency, input.sequence??1])).rows[0];
        if (!inserted)
          continue;
        for (const [kind, dueAt] of [['payment_query', inserted.query_due], ['payment_window_end', inserted.window_due]] as const)
          await scheduleDueWork(q, { tenantId: store.tenant_id, instanceId: store.instance_id, kind, targetId: inserted.attempt_id, dueAt });
        return;
      }
      throw Error('payment_trade_number_unavailable');
}
const unresolvedPendingConfirmationSQL=(attemptIdSQL:string)=>`EXISTS(SELECT 1 FROM commerce_hosted_payment_events e
  WHERE e.attempt_id=${attemptIdSQL} AND e.outcome='pending_confirmation'
    AND NOT EXISTS(SELECT 1 FROM commerce_hosted_payment_events later WHERE later.attempt_id=e.attempt_id
      AND later.outcome IN ('paid','failed') AND (later.received_at,later.event_id)>(e.received_at,e.event_id)))`;
/** Retain the gate's failure for resume; the placement port exposes only null. */
async function issueOrderHandoff(q:PoolClient,input:{store:CheckoutStore;orderId:string},options:PaymentAttemptOptions){
  await lockStore(q,input.store,[],[input.orderId],false);
  await lockCheckoutOrders(q,[input.orderId],input.store);
  const attempt=(await q.query('SELECT attempt_id FROM commerce_payment_attempts WHERE order_id=$1 ORDER BY sequence DESC LIMIT 1',[input.orderId])).rows[0];
  if(!attempt)return {handoff:null,failure:gate(410,'payment_handoff_unavailable','付款連結已失效。')} as const;
  const context=await inspectOrderHandoff(q,attempt.attempt_id,options);
  if(context.failure)return {handoff:null,failure:context.failure} as const;
  return {handoff:await mintAttemptHandoff(q,context.attempt),failure:null} as const;
}
/** On-demand queries and seller actions share the same newest eligible handoff. */
async function queryableOrderAttempt(q: PoolClient, orderId: string) {
  const candidates = (await q.query("SELECT * FROM commerce_payment_attempts WHERE order_id=$1 AND handed_off_at IS NOT NULL AND state IN ('issued','superseded','paid') ORDER BY sequence DESC", [orderId])).rows;
  for (const attempt of candidates) if (!await hasDefinitePaymentMismatch(q, attempt)) return attempt;
  return null;
}
export function createCheckoutPaymentPort(options: PaymentAttemptOptions): CheckoutPaymentPort {
  return {
    assertTermsAvailable: assertCreditPaymentAvailable,
    createOrderAttempt:(q,input)=>createOrderPaymentAttempt(q,input,options),
    async issueHandoff(q, input) {
      return (await issueOrderHandoff(q,input,options)).handoff;
    },
    onOrdersCancelled: onPaymentOrdersCancelled,
    queryable: async (q, orderId) => Boolean(await queryableOrderAttempt(q, orderId)),
    async summarize(q, orderIds) {
      const rows = (await q.query(`SELECT co.order_id,co.tenant_id,co.instance_id,${confirmedPaymentSQL('co.order_id')} AS confirmed,
        EXISTS(SELECT 1 FROM commerce_checkout_payment_applications p WHERE p.order_id=co.order_id AND p.outcome='simulated') AS simulated,
        EXISTS(SELECT 1 FROM commerce_checkout_payment_applications p WHERE p.order_id=co.order_id AND p.outcome IN ('overpaid','after_cancel','amount_mismatch')) AS has_unapplied,
        EXISTS(SELECT 1 FROM commerce_checkout_payment_applications p WHERE p.order_id=co.order_id AND p.outcome IN ('overpaid','after_cancel','amount_mismatch')
          AND coalesce((SELECT sum(r.amount_minor) FROM commerce_refunds r WHERE r.application_id=p.application_id AND r.state IN ('recorded','confirmed')),0)<p.amount_minor) AS overpaid,
        EXISTS(SELECT 1 FROM commerce_hosted_payment_events e JOIN commerce_payment_attempts a USING(attempt_id) WHERE a.order_id=co.order_id AND e.source IN ('notification','query') AND e.outcome='paid' AND e.applied_at IS NULL) AS unapplied_paid,
        a.attempt_id,a.state,a.created_at,a.handed_off_at,
        ${unresolvedPendingConfirmationSQL('a.attempt_id')} AS pending_confirmation,
        (a.state='issued' AND a.created_at+interval '60 minutes'>clock_timestamp() AND EXISTS(SELECT 1 FROM commerce_hosted_payment_events e WHERE e.attempt_id=a.attempt_id AND e.source='browser_return')) AS returned
        FROM commerce_checkout_orders co LEFT JOIN LATERAL (SELECT * FROM commerce_payment_attempts WHERE order_id=co.order_id ORDER BY sequence DESC LIMIT 1) a ON true
        WHERE co.order_id=ANY($1::uuid[]) ORDER BY co.order_id`, [orderIds])).rows;
      if (rows.some(row => row.tenant_id !== rows[0].tenant_id || row.instance_id !== rows[0].instance_id))
        throw Error('payment_summary_scope_invalid');
      const summaries = new Map<string, CheckoutPaymentSummary>();
      for (const row of rows) {
        await bindStore(q, row.tenant_id);
        // Money that does not match the order outranks every state; the store must refund it.
        const payment_state = row.overpaid ? 'overpaid' : row.confirmed ? 'confirmed' : row.has_unapplied ? 'refunded' : row.unapplied_paid || row.pending_confirmation || row.returned ? 'pending' : row.simulated ? 'simulated' : 'unpaid';
        const state = row.state === 'issued' ? (row.handed_off_at ? 'awaiting_result' : 'ready') : ['paid', 'confirmed'].includes(row.state) ? 'paid' : row.state === 'failed' ? 'failed' : 'expired';
        const canResume = Boolean(row.attempt_id && !row.has_unapplied && (!(await inspectOrderHandoffGate(q,row.attempt_id,options)).failure || !(await inspectRepay(q,row.order_id,options)).failure));
        summaries.set(row.order_id, { payment_state, latest_payment_attempt: row.attempt_id ? { attempt_ref: row.attempt_id, state, created_at: row.created_at.toISOString() } : null, can_resume_payment: canResume });
      }
      return summaries;
    },
  };
}

const pendingPayment=(retryAfter?:number)=>new Problem(409,'payment_result_pending','付款結果確認中，請稍後再查詢。',retryAfter);
/** Read-only re-pay eligibility is also the buyer summary's exact gate. It
 * reads neither credential ciphertext nor routing tokens and charges no budget. */
export async function inspectRepay(q:PoolClient,orderId:string,options:PaymentAttemptOptions){
  const attempt=(await q.query('SELECT * FROM commerce_payment_attempts WHERE order_id=$1 ORDER BY sequence DESC LIMIT 1',[orderId])).rows[0];
  if(!attempt)return {failure:gate(409,'payment_handoff_unavailable','目前無法繼續付款，請查看訂單狀態。'),attempt:null};
  const context=await inspectOrderHandoffGate(q,attempt.attempt_id,options,true);
  if(context.failure)return {failure:context.failure,attempt};
  const facts=(await q.query(`SELECT ${confirmedPaymentSQL('$1')} AS confirmed,
    EXISTS(SELECT 1 FROM commerce_payment_attempts WHERE order_id=$1 AND state IN ('paid','confirmed')) AS paid,
    EXISTS(SELECT 1 FROM commerce_checkout_payment_applications WHERE order_id=$1 AND outcome IN ('overpaid','after_cancel','amount_mismatch')) AS overpaid,
    (SELECT count(*)::int FROM commerce_payment_attempts WHERE order_id=$1) AS attempts,
    ($2::timestamptz IS NOT NULL AND $2::timestamptz+interval '60 seconds'<=clock_timestamp()) AS old_enough,
    greatest(1,ceil(extract(epoch FROM $2::timestamptz+interval '60 seconds'-clock_timestamp())))::int AS retry_after,
    (EXISTS(SELECT 1 FROM commerce_hosted_payment_events WHERE attempt_id=$3
      AND source IN ('notification','query') AND outcome='paid' AND applied_at IS NULL)
      OR ${unresolvedPendingConfirmationSQL('$3')}) AS pending`,[orderId,attempt.handed_off_at,attempt.attempt_id])).rows[0];
  let failure:HandoffGate|null=null;
  if(facts.paid||facts.confirmed||facts.overpaid)failure=gate(409,'payment_already_applied','訂單已有付款紀錄。');
  else if(facts.attempts>=5)failure=gate(409,'payment_attempts_exhausted','付款次數已達上限，請聯絡店家。');
  else if(attempt.state!=='failed'&&!facts.old_enough)failure={...gate(409,'payment_result_pending','付款結果確認中，請稍後再查詢。'),retryAfter:facts.retry_after??60} as HandoffGate;
  else if(facts.pending)failure=gate(409,'payment_result_pending','付款結果確認中，請稍後再查詢。');
  return {failure,attempt,context};
}
function assertRepay(result:Awaited<ReturnType<typeof inspectRepay>>,handoffFailure:HandoffGate|null=null){
  // Earlier table rows keep precedence. An unhanded attempt cannot wait for a
  // provider result, so its handoff failure replaces only the delay-row answer.
  const failure=result.failure?.code==='payment_result_pending'&&result.attempt?.state==='issued'&&!result.attempt.handed_off_at&&handoffFailure
    ? handoffFailure:result.failure;
  if(failure)throw new Problem(failure.status,failure.code,failure.message,(failure as HandoffGate&{retryAfter?:number}).retryAfter);
  return result.attempt!;
}
export function createCheckoutPaymentActions(options:PaymentAttemptOptions,queries?:PaymentQueryDependencies):CheckoutPaymentActions{
  return {
    async resume(pool,input){
      const initial=await isolatedTransaction(pool,async q=>{
        await input.authorize(q);await lockStore(q,input.store,[],[input.orderId],false);await lockCheckoutOrders(q,[input.orderId],input.store);
        const latest=(await q.query('SELECT * FROM commerce_payment_attempts WHERE order_id=$1 ORDER BY sequence DESC LIMIT 1',[input.orderId])).rows[0];
        let handoffFailure:HandoffGate|null=null;
        if(latest?.state==='issued'&&!latest.handed_off_at){
          const result=await issueOrderHandoff(q,input,options);if(result.handoff){await input.authorize(q);return {handoff:result.handoff};}
          handoffFailure=result.failure;
        }
        const attempt=assertRepay(await inspectRepay(q,input.orderId,options),handoffFailure);await input.authorize(q);return {attempt};
      });
      if(initial.handoff)return initial.handoff;
      const attempt=initial.attempt!;
      if(attempt.state!=='failed'){
        await chargePaymentQueryOrderBudgets(pool,input.orderId);
        if(!queries)throw pendingPayment();
        const result=await queryAttempt(pool,attempt.attempt_id,queries,'repay');
        if(result.status==='paid'||result.status==='amount_mismatch')throw new Problem(409,'payment_already_applied','訂單已有付款紀錄。');
        if(!['unpaid','failed'].includes(result.status))throw pendingPayment();
      }
      return isolatedTransaction(pool,async q=>{
        await input.authorize(q);await lockStore(q,input.store,[],[input.orderId],false);await lockCheckoutOrders(q,[input.orderId],input.store);
        const latest=(await q.query('SELECT * FROM commerce_payment_attempts WHERE order_id=$1 ORDER BY sequence DESC LIMIT 1',[input.orderId])).rows[0];
        if(latest?.attempt_id!==attempt.attempt_id){
          if(latest?.state==='issued'&&!latest.handed_off_at){
            const result=await issueOrderHandoff(q,input,options);if(result.handoff){await input.authorize(q);return result.handoff;}
            assertRepay(await inspectRepay(q,input.orderId,options),result.failure);
          }
          throw pendingPayment();
        }
        const checked=assertRepay(await inspectRepay(q,input.orderId,options));
        if(checked.state==='issued')await q.query("UPDATE commerce_payment_attempts SET state='superseded',superseded_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1",[checked.attempt_id]);
        const order=(await q.query('SELECT currency,total_minor FROM commerce_orders WHERE order_id=$1',[input.orderId])).rows[0];
        await createOrderPaymentAttempt(q,{store:input.store,orderId:input.orderId,amountMinor:Number(order.total_minor),currency:order.currency,environment:options.environment,sequence:checked.sequence+1},options);
        const result=await issueOrderHandoff(q,input,options);
        if(result.failure)throw new Problem(result.failure.status,result.failure.code,result.failure.message);
        await input.authorize(q);return result.handoff;
      });
    },
    async query(pool,input){
      const attempt=await isolatedTransaction(pool,async q=>{
        await input.authorize(q);
        return queryableOrderAttempt(q, input.orderId);
      });
      if(!attempt||!queries)return 'complete';
      return (await queryAttempt(pool,attempt.attempt_id,queries,input.trigger??'buyer')).status==='query_in_progress'?'query_in_progress':'complete';
    },

  };
}

/** Payments narrows M1's fallback to orders that can still receive money.
 * Placement already holds the checkout lock and the caller's tenant binding. */
export const paymentUnresolvedOrders:UnresolvedOrderPort={async find(q,checkoutId){
  return (await q.query<{order_id:string}>(`SELECT co.order_id FROM commerce_checkout_orders co
    WHERE co.checkout_id=$1 AND co.lifecycle_state='open' AND NOT ${confirmedPaymentSQL('co.order_id')}
    AND (EXISTS(SELECT 1 FROM commerce_payment_attempts a WHERE a.order_id=co.order_id
      AND (a.state='paid' OR (a.state IN ('issued','superseded') AND a.handed_off_at IS NOT NULL)
        OR (a.state='issued' AND a.handed_off_at IS NULL
          AND EXISTS(SELECT 1 FROM commerce_inventory_reservations r WHERE r.order_id=co.order_id)
          AND NOT EXISTS(SELECT 1 FROM commerce_inventory_reservations r WHERE r.order_id=co.order_id
            AND (r.state<>'held' OR r.expires_at<=clock_timestamp())))))
      OR (co.payment_method IN ('bank_transfer','cash_on_meetup') AND EXISTS(SELECT 1 FROM commerce_orders o WHERE o.order_id=co.order_id AND o.expires_at>clock_timestamp())))
    ORDER BY co.order_id LIMIT 1`,[checkoutId])).rows[0]??null;
}};
export function createCheckoutPaymentPorts(options:PaymentAttemptOptions,queries?:PaymentQueryDependencies){
  return {payment:createCheckoutPaymentPort(options),paymentActions:createCheckoutPaymentActions(options,queries),unresolved:paymentUnresolvedOrders};
}

/** Call only after the attempt gate and its domain locks. Raw bearer material
 * is returned to the caller and only its hash enters the routing table. */
export async function mintAttemptHandoff(q:PoolClient,attempt:{attempt_id:string;tenant_id:string;instance_id:string}){
      await q.query(`UPDATE commerce_entry_routes SET revoked_at=clock_timestamp() WHERE route_kind='payment_handoff' AND target_id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp()`, [attempt.attempt_id]);
      for (let i = 0;i < 16;i++) {
        const token = randomBytes(32).toString('base64url');
        const route = (await q.query(`INSERT INTO commerce_entry_routes(route_kind,route_key,tenant_id,instance_id,target_id,created_at,expires_at)
          SELECT 'payment_handoff',$1,$2,$3,$4,t,t+interval '15 minutes' FROM (SELECT clock_timestamp() t) n
          ON CONFLICT(route_kind,route_key) DO NOTHING RETURNING expires_at`, [hashKey(token), attempt.tenant_id, attempt.instance_id, attempt.attempt_id])).rows[0];
        if (route)
          return { handoff_url: '/pay/ecpay/' + token, attempt_ref: attempt.attempt_id, expires_at: route.expires_at.toISOString() };
      }
      throw Error('payment_handoff_token_unavailable');
}
export function issueActivationHandoff(pool:Pool,attemptId:string,options:PaymentAttemptOptions){
  return isolatedTransaction(pool,async q=>{
    const a=await lockMachinePaymentAttempt(q,attemptId);
    requireCondition(a?.kind==='service_activation'&&a.state==='issued'&&!a.handed_off_at,409,'provider_activation_pending','收款服務驗證結果確認中，請稍後再試。');
    const context=await inspectOrderHandoff(q,attemptId,options);
    if(context.failure)throw new Problem(context.failure.status,context.failure.code==='commerce_quarantined'?'commerce_quarantined':context.failure.status===503?'commerce_credentials_unavailable':'provider_service_state',context.failure.message);
    return mintAttemptHandoff(q,a);
  });
}
