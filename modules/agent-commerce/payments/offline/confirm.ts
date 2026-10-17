import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {MeetupCompletionInputSchema,MeetupHandoverInputSchema,OfflinePaymentConfirmInputSchema} from '../../../../contracts/guild-launchpad/v1/hosted-seller-checkout.js';
import {checkVersion} from '../../../../packages/db/index.js';
import {requireCondition} from '../../../../packages/shared/problem.js';
import type {Actor} from '../../../identity-membership/service.js';
import {lockStore} from '../../checkout/authority.js';
import {openException} from '../../checkout/exceptions.js';
import {checkoutInventory} from '../../checkout/inventory.js';
import {hasConfirmedPayment} from '../../checkout/confirmed-payment.js';
import {lockCheckoutOrders,type CheckoutOrderRow} from '../../checkout/orders.js';
import {applyConfirmedPaymentHeld,recordHandover} from '../../checkout/payments.js';
import {quarantineGate} from '../../checkout/public-commands.js';
import {sellerCheckoutCommand,type SellerCheckoutContext} from '../../checkout/seller-command.js';
import {projectSellerCheckoutOrder,sellerCheckoutOrderRow,type SellerCheckoutReadOptions} from '../../checkout/seller-orders.js';
/** Seller commands already hold the store lock, so payment apply must not take
 * the machine lock expiry takes first. A meetup stock failure throws before
 * any exception row, and the receipt rolls back with the payment. These
 * commands write no journal, matching commerce.refund.record. */
const project=(options:SellerCheckoutReadOptions)=>(q:PoolClient,context:SellerCheckoutContext,id:string)=>projectSellerCheckoutOrder(q,context,id,options);

async function payable(q:PoolClient,order:CheckoutOrderRow,method:'bank_transfer'|'cash_on_meetup',amount:number,date:string) {
  requireCondition(order.payment_method===method,409,'payment_method_mismatch','訂單的付款方式不符。');
  requireCondition(order.lifecycle_state!=='cancelled',409,'order_cancelled','訂單已取消，不能確認收款。');
  requireCondition(order.lifecycle_state==='open',409,'checkout_order_closed','訂單已結束。');
  requireCondition(!await hasConfirmedPayment(q,order.order_id),409,'payment_already_applied','訂單已有付款紀錄。');
  requireCondition(amount===order.terms.total_minor,422,'offline_amount_mismatch','金額必須等於訂單總額。');
  const ok=(await q.query<{ok:boolean}>(`SELECT $2::date>=(o.created_at AT TIME ZONE 'Asia/Taipei')::date
    AND $2::date<=(clock_timestamp() AT TIME ZONE 'Asia/Taipei')::date AS ok FROM commerce_orders o WHERE o.order_id=$1`,[order.order_id,date])).rows[0]?.ok;
  requireCondition(ok===true,422,'offline_payment_date_invalid','日期必須在下單日到今天之間。');
}
async function insertPayment(q:PoolClient,context:SellerCheckoutContext,order:CheckoutOrderRow,paymentId:string,method:'bank_transfer'|'cash_on_meetup',amount:number,date:string,reference:string|null) {
  await q.query(`INSERT INTO commerce_offline_payments(payment_id,tenant_id,instance_id,order_id,method,amount_minor,currency,received_on,reference,confirmed_by_principal_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[paymentId,context.tenant.tenant_id,context.profile.instance_id,order.order_id,method,amount,order.terms.currency,date,reference,context.tenant.principal_id]);
}
function handoverLines(orderId:string,allocations:readonly {item_id:string;quantity:number;shipped_quantity:number;released_quantity:number}[]) {
  return allocations.map(a=>({orderId,itemId:a.item_id,quantity:a.quantity-a.shipped_quantity-a.released_quantity})).filter(line=>line.quantity>0);
}
async function insertHandover(q:PoolClient,context:SellerCheckoutContext,orderId:string,handoverId:string,paymentId:string|null,date:string) {
  await q.query(`INSERT INTO commerce_meetup_handovers(handover_id,tenant_id,instance_id,order_id,offline_payment_id,completed_on,recorded_by_principal_id)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,[handoverId,context.tenant.tenant_id,context.profile.instance_id,orderId,paymentId,date,context.tenant.principal_id]);
}

export async function confirmOfflinePayment(pool:Pool,actor:Actor,tenantId:string,instanceId:string,id:string,raw:unknown,key:string,expected:string,options:SellerCheckoutReadOptions={}) {
  quarantineGate(options);
  const parsed=OfflinePaymentConfirmInputSchema.safeParse(raw);
  if(!parsed.success)throw parsed.error;
  const body=parsed.data;
  return sellerCheckoutCommand(pool,actor,tenantId,instanceId,'store:orders:manage','commerce.checkout_order.confirm_offline_payment',{kind:'hosted_checkout_order',id},body,key,expected,async(q,context)=>{
    await sellerCheckoutOrderRow(q,context,id);
    const store={storefront_shop_id:context.profile.storefront_shop_id},paymentId=randomUUID();
    await lockStore(q,store,[],[id],false);
    const [order]=await lockCheckoutOrders(q,[id],store,paymentId);
    checkVersion(order.version,expected);
    await payable(q,order,'bank_transfer',body.amount_minor,body.received_on);
    await insertPayment(q,context,order,paymentId,'bank_transfer',body.amount_minor,body.received_on,body.reference??null);
    const application=await applyConfirmedPaymentHeld(q,{orderId:id,paymentRef:paymentId,amountMinor:body.amount_minor,currency:order.terms.currency,simulated:false},order);
    if(application.outcome==='unallocatable')await openException(q,{tenantId:context.tenant.tenant_id,instanceId:context.profile.instance_id,orderId:id,kind:'paid_unallocatable',subjectKind:'offline_payment',subjectId:paymentId,openedBy:{kind:'person',principalId:context.tenant.principal_id}});
    else requireCondition(application.outcome==='converted'||application.outcome==='allocated',409,'checkout_order_closed','訂單已結束。');
    return {id};
  },project(options));
}

export async function completeMeetup(pool:Pool,actor:Actor,tenantId:string,instanceId:string,id:string,raw:unknown,key:string,expected:string,options:SellerCheckoutReadOptions={}) {
  quarantineGate(options);
  const parsed=MeetupCompletionInputSchema.safeParse(raw);
  if(!parsed.success)throw parsed.error;
  const body=parsed.data;
  return sellerCheckoutCommand(pool,actor,tenantId,instanceId,['store:orders:manage','store:fulfil'],'commerce.checkout_order.complete_meetup',{kind:'hosted_checkout_order',id},body,key,expected,async(q,context)=>{
    await sellerCheckoutOrderRow(q,context,id);
    const store={storefront_shop_id:context.profile.storefront_shop_id},paymentId=randomUUID();
    await lockStore(q,store,[],[id],false);
    const [order]=await lockCheckoutOrders(q,[id],store,paymentId);
    checkVersion(order.version,expected);
    await payable(q,order,'cash_on_meetup',body.amount_minor,body.completed_on);
    await insertPayment(q,context,order,paymentId,'cash_on_meetup',body.amount_minor,body.completed_on,null);
    const application=await applyConfirmedPaymentHeld(q,{orderId:id,paymentRef:paymentId,amountMinor:body.amount_minor,currency:order.terms.currency,simulated:false},order);
    requireCondition(application.outcome!=='unallocatable',409,'meetup_stock_unavailable','庫存不足，不能完成面交。');
    requireCondition(application.outcome==='converted'||application.outcome==='allocated',409,'checkout_order_closed','訂單已結束。');
    const lines=handoverLines(id,(await checkoutInventory(q,id)).allocations);
    if(!lines.length)throw new Error('meetup_handover_lines_missing');
    const handoverId=randomUUID();
    await insertHandover(q,context,id,handoverId,paymentId,body.completed_on);
    await recordHandover(q,store,{shipmentRef:handoverId,lines});
    return {id};
  },project(options));
}

export async function recordMeetupHandover(pool:Pool,actor:Actor,tenantId:string,instanceId:string,id:string,raw:unknown,key:string,expected:string,options:SellerCheckoutReadOptions={}) {
  quarantineGate(options);
  const parsed=MeetupHandoverInputSchema.safeParse(raw);
  if(!parsed.success)throw parsed.error;
  const body=parsed.data;
  return sellerCheckoutCommand(pool,actor,tenantId,instanceId,'store:fulfil','commerce.checkout_order.record_meetup_handover',{kind:'hosted_checkout_order',id},body,key,expected,async(q,context)=>{
    await sellerCheckoutOrderRow(q,context,id);
    const store={storefront_shop_id:context.profile.storefront_shop_id};
    await lockStore(q,store,[],[id],false);
    const [order]=await lockCheckoutOrders(q,[id],store);
    checkVersion(order.version,expected);
    requireCondition(order.terms.shipping.groups.length>0&&order.terms.shipping.groups.every(group=>group.method_ref==='meetup'),409,'meetup_not_selected','這筆訂單不是面交。');
    requireCondition(order.lifecycle_state!=='cancelled',409,'order_cancelled','訂單已取消，不能確認收款。');
    requireCondition(order.lifecycle_state==='open',409,'checkout_order_closed','訂單已結束。');
    requireCondition(await hasConfirmedPayment(q,id),409,'payment_not_confirmed','訂單尚未確認付款。');
    requireCondition(!(await q.query('SELECT 1 FROM commerce_meetup_handovers WHERE order_id=$1',[id])).rowCount,409,'meetup_already_recorded','面交已經登記。');
    const inventory=await checkoutInventory(q,id),lines=handoverLines(id,inventory.allocations);
    const stillUnallocatable=inventory.allocations.length===0&&(await q.query("SELECT 1 FROM commerce_checkout_payment_applications WHERE order_id=$1 AND outcome='unallocatable'",[id])).rowCount;
    requireCondition(!stillUnallocatable,409,'meetup_stock_unavailable','庫存不足，不能登記面交。');
    requireCondition(lines.length>0,409,'nothing_to_hand_over','沒有可交付的商品。');
    const ok=(await q.query<{ok:boolean}>(`SELECT $2::date>=(o.created_at AT TIME ZONE 'Asia/Taipei')::date
      AND $2::date<=(clock_timestamp() AT TIME ZONE 'Asia/Taipei')::date AS ok FROM commerce_orders o WHERE o.order_id=$1`,[id,body.completed_on])).rows[0]?.ok;
    requireCondition(ok===true,422,'offline_payment_date_invalid','日期必須在下單日到今天之間。');
    const handoverId=randomUUID();
    await insertHandover(q,context,id,handoverId,null,body.completed_on);
    await recordHandover(q,store,{shipmentRef:handoverId,lines});
    return {id};
  },project(options));
}
