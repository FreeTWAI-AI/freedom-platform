import type {PoolClient} from 'pg';
import {PublicOrderSchema} from '../../../contracts/guild-launchpad/v1/hosted-checkout.js';
import {confirmedPaymentSQL} from './confirmed-payment.js';
import {orderAccessNotFound} from './access.js';
import type {CheckoutTerms,CheckoutPaymentPort} from './terms.js';

/** Explicit buyer allowlist. No raw transaction, binding or contact row leaves
 * this function. Reading does not settle holds, update sessions or record usage. */
export async function publicOrder(q:PoolClient,store:{instanceId:string;tenantId:string;projection:{slug:string;name:string}},orderId:string,payment?:CheckoutPaymentPort) {
  const row=(await q.query(`SELECT co.order_id,co.display_number,co.terms,co.lifecycle_state,co.cancel_reason,co.payment_method,o.created_at,o.expires_at,
    o.expires_at<=clock_timestamp() AS reservation_expired,CASE WHEN co.payment_method='immediate_card' THEN NULL ELSE o.expires_at+interval '72 hours' END AS payment_grace_until,
    ${confirmedPaymentSQL('co.order_id')} AS confirmed,s.document AS offline_document,
    c.contact_name,c.contact_email,c.contact_phone,c.delivery,c.invoice,c.redacted_at
    FROM commerce_checkout_orders co JOIN commerce_orders o USING(order_id)
    JOIN commerce_checkout_contacts c ON c.contact_id=co.contact_id AND c.checkout_id=co.checkout_id AND c.tenant_id=co.tenant_id AND c.instance_id=co.instance_id
    LEFT JOIN commerce_offline_payment_settings s ON s.tenant_id=co.tenant_id AND s.instance_id=co.instance_id AND s.version::text=co.terms->'offline_payment'->>'settings_version'
    WHERE co.order_id=$1 AND co.tenant_id=$2 AND co.instance_id=$3 AND o.order_profile='hosted_checkout'`,[orderId,store.tenantId,store.instanceId])).rows[0];
  if(!row)return orderAccessNotFound();
  const summary=(await payment?.summarize(q,[orderId]))?.get(orderId)??{payment_state:row.confirmed?'confirmed':'unpaid',latest_payment_attempt:null,can_resume_payment:false};
  const t=row.terms as CheckoutTerms,redacted=row.redacted_at!==null,bank=row.offline_document?.bank_transfer??null;
  const paid=['confirmed','simulated','overpaid','refunded'].includes(summary.payment_state);
  const offline_instructions=row.payment_method==='bank_transfer'&&row.lifecycle_state==='open'&&!paid&&bank?{bank_code:bank.bank_code,bank_name:bank.bank_name,branch_name:bank.branch_name,account_number:bank.account_number,account_name:bank.account_name,note:bank.note,amount_minor:t.total_minor,pay_by:row.expires_at.toISOString()}:null;
  return PublicOrderSchema.parse({order_ref:row.order_id,display_number:row.display_number,store:{slug:store.projection.slug,name:store.projection.name},
    created_at:row.created_at.toISOString(),pay_by:row.expires_at.toISOString(),reservation_expired:row.reservation_expired,lifecycle_state:row.lifecycle_state,cancel_reason:row.cancel_reason,currency:t.currency,
    lines:t.items.map(l=>({sku:l.sku,title:l.title,options:[],quantity:l.quantity,unit_price_minor:l.unit_price_minor,line_total_minor:l.line_total_minor})),
    merchandise_total_minor:t.merchandise_total_minor,discount_total_minor:t.discount_total_minor,shipping_total_minor:t.shipping_total_minor,total_minor:t.total_minor,
    payment_method:row.payment_method,payment_grace_until:row.payment_grace_until?.toISOString()??null,offline_instructions,
    meetup_notes:[...new Set(t.shipping.groups.flatMap(group=>group.meetup?[group.meetup.note]:[]))],
    ...summary,contact:redacted?null:{name:row.contact_name,email:row.contact_email,phone:row.contact_phone},
    delivery:redacted?null:row.delivery,invoice:redacted?null:row.invoice,redacted});
}
