import type {PoolClient} from 'pg';
import {Problem} from '../../../packages/shared/problem.js';
import {bindStore} from './authority.js';
import {confirmedPaymentSQL} from './confirmed-payment.js';
import {hashKey} from './terms.js';

/** Shared by commands and boundary tests. Windows and expiry use the DB clock. */
export const COMMERCE_LIMITS={
  cartNetwork:{limit:60,seconds:60},cartStore:{limit:600,seconds:60},
  checkoutNetwork:{limit:30,seconds:600},checkoutStore:{limit:600,seconds:600},
  placementNetwork:{limit:10,seconds:600},placementStore:{limit:300,seconds:600},
  newOrderNetwork:{limit:3,seconds:1800},
  accessRequestNetwork:{limit:10,seconds:3600},accessRequestEmail:{limit:3,seconds:3600},accessRequestGlobal:{limit:300,seconds:3600},
  redemptionNetwork:{limit:30,seconds:600},openOrdersDevice:3,openOrdersEmail:3,
} as const;
export type CommerceBucket=Exclude<keyof typeof COMMERCE_LIMITS,'openOrdersDevice'|'openOrdersEmail'>;
export async function commerceRateLimitInTransaction(q:PoolClient,name:CommerceBucket,key:string) {
  const rule=COMMERCE_LIMITS[name],bucket=`commerce:${name}:${hashKey(key)}`;
  await q.query('INSERT INTO auth_rate_limits(bucket,window_start,attempts) VALUES($1,clock_timestamp(),0) ON CONFLICT DO NOTHING',[bucket]);
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
/** Cross-store limits acquire hashed device/email locks before lifecycle locks.
 * Counts remain SQL-derived from the canonical grants and customers under each
 * exact stored tenant context, without a definer or another PII copy. */
export async function lockOpenOrderBudgets(q:PoolClient,deviceId:string,email:string) {
  for(const key of [`device/${deviceId}`,`email/${hashKey(email)}`].sort())await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`commerce:open:${key}`]);
}
export async function enforceOpenOrderLimits(q:PoolClient,deviceId:string,email:string,returnTenant:string) {
  const tenants=(await q.query<{tenant_id:string}>(`SELECT DISTINCT co.tenant_id FROM commerce_checkout_orders co JOIN commerce_orders o USING(order_id)
    WHERE co.lifecycle_state='open' AND o.expires_at>clock_timestamp() AND NOT ${confirmedPaymentSQL('co.order_id')}`)).rows;
  let devices=0,emails=0;
  for(const tenant of tenants) {
    await bindStore(q,tenant.tenant_id);
    const row=(await q.query<{devices:number;emails:number}>(`SELECT
      count(*) FILTER(WHERE EXISTS(SELECT 1 FROM commerce_order_access_grants g JOIN commerce_access_devices d USING(device_id)
        WHERE g.device_id=$1 AND g.checkout_id=co.checkout_id AND (g.order_id IS NULL OR g.order_id=co.order_id)
          AND g.kind='device' AND g.revoked_at IS NULL AND d.revoked_at IS NULL AND d.expires_at>clock_timestamp()))::int AS devices,
      count(*) FILTER(WHERE c.email_normalized=$2 AND c.redacted_at IS NULL)::int AS emails
      FROM commerce_checkout_orders co JOIN commerce_orders o USING(order_id) JOIN commerce_customers c ON c.customer_id=co.customer_id
      WHERE co.tenant_id=$3 AND co.lifecycle_state='open' AND o.expires_at>clock_timestamp() AND NOT ${confirmedPaymentSQL('co.order_id')}`,[deviceId,email,tenant.tenant_id])).rows[0];
    devices+=row.devices;emails+=row.emails;
  }
  await bindStore(q,returnTenant);
  if(devices>COMMERCE_LIMITS.openOrdersDevice||emails>COMMERCE_LIMITS.openOrdersEmail)throw new Problem(429,'too_many_open_orders','尚有未完成的訂單。');
}
