import type {Pool,PoolClient} from 'pg';
import {ManualRefundInputSchema} from '../../../contracts/guild-launchpad/v1/hosted-seller-checkout.js';
import {Problem,requireCondition} from '../../../packages/shared/problem.js';
import type {Actor} from '../../identity-membership/service.js';
import {lockStore} from '../checkout/authority.js';
import {lockCheckoutOrders} from '../checkout/orders.js';
import {quarantineGate} from '../checkout/public-commands.js';
import {sellerCheckoutCommand,type SellerCheckoutContext} from '../checkout/seller-command.js';
import {sellerCheckoutRead,sellerCheckoutOrderRow,sellerRefunds,type SellerCheckoutReadOptions} from '../checkout/seller-orders.js';
import {sellerToday,validateSellerDate} from '../checkout/seller-exceptions.js';
import {checkUnappliedRefund} from './rules/unapplied.js';
import {RefundRuleError} from './rules/errors.js';
import {SETTLEMENT_UNITS} from './rules/types.js';

async function projectRefund(q:PoolClient,context:SellerCheckoutContext,id:string) {
  const r=(await q.query(`SELECT refund_id,application_id,attempt_id,amount_minor,currency,to_char(refunded_on,'YYYY-MM-DD') AS refunded_on,provider_reference,basis,mode,state,recorded_by_principal_id,created_at
    FROM commerce_refunds WHERE refund_id=$1 AND tenant_id=$2 AND instance_id=$3`,[id,context.tenant.tenant_id,context.profile.instance_id])).rows[0];
  requireCondition(r,409,'receipt_reference_invalid','退款紀錄無效。');
  return {refund_ref:r.refund_id,application_ref:r.application_id,attempt_ref:r.attempt_id,amount_minor:Number(r.amount_minor),currency:r.currency,refunded_on:r.refunded_on,provider_reference:r.provider_reference,
    basis:r.basis,mode:r.mode,state:r.state,recorded_without_provider:r.mode==='manual_record',recorded_by:r.recorded_by_principal_id,created_at:r.created_at.toISOString()};
}
export function listSellerRefunds(pool:Pool,actor:Actor,tenantId:string,instanceId:string,orderId:string) {
  return sellerCheckoutRead(pool,actor,tenantId,instanceId,'store:finance:read',async(q,context)=>{
    await sellerCheckoutOrderRow(q,context,orderId);return {items:await sellerRefunds(q,context,orderId)};
  });
}
/** A ledger entry records the merchant's own refund; it performs no provider
 * operation. Order/attempt/application locks precede all case closure locks. */
export async function recordSellerRefund(pool:Pool,actor:Actor,tenantId:string,instanceId:string,orderId:string,raw:unknown,key:string,options:SellerCheckoutReadOptions={}) {
  quarantineGate(options);
  const parsed=ManualRefundInputSchema.safeParse(raw);
  if(!parsed.success){if(parsed.error.issues.some(issue=>issue.path[0]==='refunded_on'))throw new Problem(422,'refund_date_invalid','退款日期無效。');throw parsed.error;}
  const body=parsed.data;
  return sellerCheckoutCommand(pool,actor,tenantId,instanceId,'store:refund','commerce.refund.record',{kind:'hosted_checkout_order',id:orderId},body,key,undefined,async(q,context)=>{
    await sellerCheckoutOrderRow(q,context,orderId);
    const store={storefront_shop_id:context.profile.storefront_shop_id};
    await lockStore(q,store,[],[orderId],false);await lockCheckoutOrders(q,[orderId],store);
    // No paymentRef shortcut: every application and inventory row must already
    // be locked before the append trigger or any matching case is touched.
    const application=(await q.query('SELECT * FROM commerce_checkout_payment_applications WHERE application_id=$1 AND order_id=$2',[body.application_ref,orderId])).rows[0];
    requireCondition(application&&['overpaid','after_cancel','amount_mismatch'].includes(application.outcome),409,'refund_not_available','這筆付款目前無法登記退款。');
    const attempt=(await q.query('SELECT attempt_id,currency FROM commerce_payment_attempts WHERE attempt_id=$1 AND order_id=$2 AND tenant_id=$3 AND instance_id=$4',[application.payment_ref,orderId,tenantId,instanceId])).rows[0];
    if(!attempt||attempt.currency!==application.currency)throw new RefundRuleError();
    const unit=application.currency==='TWD'?SETTLEMENT_UNITS[1]:application.currency==='USD'?SETTLEMENT_UNITS[0]:undefined;
    if(unit===undefined)throw new RefundRuleError();
    const refunded=Number((await q.query("SELECT coalesce(sum(amount_minor),0) AS amount FROM commerce_refunds WHERE application_id=$1 AND state<>'failed'",[application.application_id])).rows[0].amount);
    const result=checkUnappliedRefund({settlement_unit_minor:unit,unapplied_minor:Number(application.amount_minor),refunded_minor:refunded,amount_minor:body.amount_minor});
    if(!result.ok){if(result.errors.some(e=>e.code==='above_cap'))throw new Problem(409,'refund_exceeds_payment','退款超過已收款金額。');throw new Problem(422,'validation_failed','退款金額必須大於零並符合幣別單位。');}
    const paidOn=(await q.query(`SELECT to_char(coalesce(a.payment_date,(SELECT min(e.payment_date) FROM commerce_hosted_payment_events e WHERE e.attempt_id=a.attempt_id AND e.outcome IN ('paid','amount_mismatch')),$2::timestamptz) AT TIME ZONE 'Asia/Taipei','YYYY-MM-DD') AS paid_on
      FROM commerce_payment_attempts a WHERE a.attempt_id=$1`,[attempt.attempt_id,application.created_at])).rows[0].paid_on;
    validateSellerDate(body.refunded_on,await sellerToday(q),'refund_date_invalid',paidOn);
    const refund=(await q.query(`INSERT INTO commerce_refunds(tenant_id,instance_id,order_id,application_id,attempt_id,basis,mode,state,amount_minor,currency,refunded_on,provider_reference,recorded_by_principal_id)
      VALUES($1,$2,$3,$4,$5,'unapplied_payment','manual_record','recorded',$6,$7,$8,$9,$10) RETURNING refund_id`,
    [tenantId,instanceId,orderId,application.application_id,attempt.attempt_id,body.amount_minor,application.currency,body.refunded_on,body.provider_reference??null,context.tenant.principal_id])).rows[0];
    await q.query("INSERT INTO commerce_refund_lines(refund_id,line_no,kind,amount_minor) VALUES($1,1,'unapplied',$2)",[refund.refund_id,body.amount_minor]);
    if(refunded+body.amount_minor===Number(application.amount_minor)){
      const kind=application.outcome==='after_cancel'?'paid_after_cancel':application.outcome;
      await q.query(`UPDATE commerce_exception_cases SET status='resolved',resolution_code='refunded',resolution_note='店家已登記全額退款。',resolved_by_principal_id=$5,updated_at=clock_timestamp(),version=version+1
        WHERE tenant_id=$1 AND instance_id=$2 AND kind=$3 AND subject_kind='payment_attempt' AND subject_id=$4 AND status='open'`,
      [tenantId,instanceId,kind,attempt.attempt_id,context.tenant.principal_id]);
    }
    return {id:refund.refund_id};
  },projectRefund);
}
