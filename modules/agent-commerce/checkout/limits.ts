import type {Pool,PoolClient} from 'pg';
import {Problem} from '../../../packages/shared/problem.js';
import {isolatedTransaction} from '../../../packages/resource-scopes/tenant-transaction.js';
import {resolvePublicStorePage} from '../hosted/public.js';
import {bindStore} from './authority.js';
import {confirmedPaymentSQL} from './confirmed-payment.js';
import {hashKey} from './terms.js';

/** Shared by commands and boundary tests. Windows and expiry use the DB clock. */
export const COMMERCE_LIMITS={
  cartNetwork:{limit:60,seconds:60},cartStore:{limit:600,seconds:60},
  checkoutNetwork:{limit:30,seconds:600},checkoutStore:{limit:600,seconds:600},
  placementNetwork:{limit:10,seconds:600},placementStore:{limit:300,seconds:600},
  paymentReturnNetwork:{limit:60,seconds:60},paymentReturnQuery:{limit:1,seconds:60},
  providerAccount:{limit:600,seconds:60},providerUnknownNetwork:{limit:120,seconds:60},
  paymentQueryNetwork:{limit:30,seconds:600},paymentQueryOrder:{limit:1,seconds:60},paymentQueryOrderHour:{limit:10,seconds:3600},
  customerDataPrincipal:{limit:300,seconds:3600},
  activationAccount:{limit:10,seconds:3600},
  handoffNetwork:{limit:30,seconds:600},
  handoffPageNetwork:{limit:60,seconds:600},
  newOrderNetwork:{limit:3,seconds:1800},
  accessRequestNetwork:{limit:10,seconds:3600},accessRequestEmail:{limit:3,seconds:3600},accessRequestGlobal:{limit:300,seconds:3600},
  redemptionNetwork:{limit:30,seconds:600},openOrdersDevice:3,openOrdersEmail:3,openOfflineOrdersMember:3,openOfflineOrdersStore:50,
} as const;
export type CommerceBucket=Exclude<keyof typeof COMMERCE_LIMITS,'openOrdersDevice'|'openOrdersEmail'|'openOfflineOrdersMember'|'openOfflineOrdersStore'>;
export async function commerceRateLimitInTransaction(q:PoolClient,name:CommerceBucket,key:string) {
  const rule=COMMERCE_LIMITS[name],bucket=`commerce:${name}:${hashKey(key)}`;
  // DO UPDATE locks an existing row, so the scheduled prune cannot delete it before the SELECT below.
  await q.query('INSERT INTO auth_rate_limits(bucket,window_start,attempts) VALUES($1,clock_timestamp(),0) ON CONFLICT(bucket) DO UPDATE SET bucket=excluded.bucket',[bucket]);
  await q.query('SELECT bucket FROM auth_rate_limits WHERE bucket=$1 FOR UPDATE',[bucket]);
  const row=(await q.query<{allowed:boolean;remaining:number}>(`WITH decision AS MATERIALIZED (
    SELECT bucket,window_start+make_interval(secs=>$2)<=clock_timestamp() AS expired,
      greatest(1,ceil(extract(epoch FROM window_start+make_interval(secs=>$2)-clock_timestamp())))::int AS remaining
    FROM auth_rate_limits WHERE bucket=$1
  ), counted AS (
    UPDATE auth_rate_limits r SET attempts=CASE WHEN d.expired THEN 1 ELSE r.attempts+1 END,
      window_start=CASE WHEN d.expired THEN clock_timestamp() ELSE r.window_start END
    FROM decision d WHERE r.bucket=d.bucket AND (d.expired OR r.attempts<$3) RETURNING r.bucket
  ) SELECT EXISTS(SELECT 1 FROM counted) AS allowed,CASE WHEN expired THEN $2 ELSE remaining END AS remaining FROM decision`,[bucket,rule.seconds,rule.limit])).rows[0];
  if(!row.allowed)throw new Problem(429,'commerce_rate_limited','請稍後再試。',row.remaining);
  return row.remaining;
}
/** Commit attempt budgets before starting the command; rejected budgets roll back together.
 * Store resolution is a plain public read, without admission or lifecycle locks. */
export async function chargeCommerceBudgets(pool:Pool,network:string,charges:{network:CommerceBucket;store?:CommerceBucket;slug?:string}) {
  await isolatedTransaction(pool,async q=>{
    await commerceRateLimitInTransaction(q,charges.network,network);
    if(charges.store&&charges.slug!==undefined) {
      const store=await resolvePublicStorePage(q,charges.slug);
      if(store)await commerceRateLimitInTransaction(q,charges.store,store.instanceId);
    }
  });
}
/** Store-local device/email locks precede lifecycle locks. */
export async function lockOpenOrderBudgets(q:PoolClient,deviceId:string,email:string,instanceId:string,offline?:{principalId:string|null}) {
  const keys=[`device/${deviceId}`,`email/${hashKey(email)}`];
  if(offline){keys.push(`offline/${instanceId}`);if(offline.principalId)keys.push(`member/${offline.principalId}`);}
  for(const key of keys.sort())await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`commerce:open:${instanceId}:${key}`]);
}
export async function enforceOpenOrderLimits(q:PoolClient,deviceId:string,email:string,store:{tenantId:string;instanceId:string},placedOrderId:string,offline?:{principalId:string|null}) {
  await bindStore(q,store.tenantId);
  const row=(await q.query<{devices:number;emails:number;retry_after:number}>(`WITH decision AS MATERIALIZED (SELECT clock_timestamp() AS t), counted AS MATERIALIZED (
    SELECT o.order_id,o.expires_at,
      EXISTS(SELECT 1 FROM commerce_order_access_grants g JOIN commerce_access_devices d USING(device_id)
        WHERE g.device_id=$1 AND g.checkout_id=co.checkout_id AND (g.order_id IS NULL OR g.order_id=co.order_id)
          AND g.kind='device' AND g.revoked_at IS NULL AND d.revoked_at IS NULL AND d.expires_at>decision.t) AS device,
      c.email_normalized=$2 AND c.redacted_at IS NULL AS email
    FROM commerce_checkout_orders co JOIN commerce_orders o USING(order_id) JOIN commerce_customers c ON c.customer_id=co.customer_id CROSS JOIN decision
    WHERE co.tenant_id=$3 AND co.instance_id=$4 AND o.order_profile='hosted_checkout' AND co.lifecycle_state='open'
      AND o.expires_at>decision.t AND NOT ${confirmedPaymentSQL('co.order_id')}
  ) SELECT count(*) FILTER(WHERE device)::int AS devices,count(*) FILTER(WHERE email)::int AS emails,
    greatest(1,ceil(extract(epoch FROM min(expires_at) FILTER(WHERE order_id<>$5 AND (device OR email))-(SELECT t FROM decision))))::int AS retry_after
    FROM counted`,[deviceId,email,store.tenantId,store.instanceId,placedOrderId])).rows[0];
  if(row.devices>COMMERCE_LIMITS.openOrdersDevice||row.emails>COMMERCE_LIMITS.openOrdersEmail)throw new Problem(429,'too_many_open_orders','尚有未完成的訂單。',row.retry_after);
  if(!offline)return;
  const offlineRow=(await q.query<{members:number;stores:number;retry_after:number}>(`WITH decision AS MATERIALIZED (SELECT clock_timestamp() AS t), counted AS MATERIALIZED (
    SELECT o.order_id,o.expires_at,o.buyer_principal_id FROM commerce_checkout_orders co JOIN commerce_orders o USING(order_id) CROSS JOIN decision
    WHERE co.tenant_id=$1 AND co.instance_id=$2 AND o.order_profile='hosted_checkout' AND co.lifecycle_state='open'
      AND co.payment_method IN ('bank_transfer','cash_on_meetup') AND o.expires_at>decision.t AND NOT ${confirmedPaymentSQL('co.order_id')}
  ) SELECT count(*) FILTER(WHERE buyer_principal_id=$3)::int AS members,count(*)::int AS stores,
    greatest(1,ceil(extract(epoch FROM min(expires_at) FILTER(WHERE order_id<>$4 AND buyer_principal_id=$3)-(SELECT t FROM decision))))::int AS retry_after
    FROM counted`,[store.tenantId,store.instanceId,offline.principalId,placedOrderId])).rows[0];
  if(offline.principalId&&offlineRow.members>COMMERCE_LIMITS.openOfflineOrdersMember)throw new Problem(429,'too_many_open_orders','尚有未完成的訂單。',offlineRow.retry_after);
  if(offlineRow.stores>COMMERCE_LIMITS.openOfflineOrdersStore)throw new Problem(409,'offline_order_limit','這間店目前待付款的訂單較多，請稍後再試或選擇其他付款方式。');
}

/** Redirect hints still verify over budget. Only a rate rejection becomes false;
 * infrastructure failures retain their normal retry behavior. */
export async function tryChargeCommerceBudget(pool:Pool,name:CommerceBucket,key:string):Promise<boolean>{
  try{await chargeCommerceBudgets(pool,key,{network:name});return true;}
  catch(error){if(error instanceof Problem&&error.status===429&&error.code==='commerce_rate_limited')return false;throw error;}
}

/** Shared by buyer, re-pay and future seller query entry points. Both buckets
 * commit atomically before any command or provider call; failed commands do not
 * return the allowance. The network allowance is charged at the buyer boundary. */
export async function chargePaymentQueryOrderBudgets(pool:Pool,orderId:string){
  await isolatedTransaction(pool,async q=>{
    await commerceRateLimitInTransaction(q,'paymentQueryOrder',orderId);
    await commerceRateLimitInTransaction(q,'paymentQueryOrderHour',orderId);
  });
}
