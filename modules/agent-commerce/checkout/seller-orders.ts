import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {OpaqueId} from '../../../contracts/guild-launchpad/v1/primitives.js';
import {checkVersion} from '../../../packages/db/index.js';
import {assertCurrentSessionClock,lockMemberSession} from '../../../packages/db/member-session.js';
import {mapPersonPrincipal,lockTenantScope} from '../../../packages/resource-scopes/index.js';
import {isolatedTransaction} from '../../../packages/resource-scopes/tenant-transaction.js';
import {Problem,requireCondition} from '../../../packages/shared/problem.js';
import {type TenantListCursorCodec,type TenantListCursorBinding,unavailableTenantListCursor} from '../../../packages/shared/tenant-list-cursor.js';
import type {Actor} from '../../identity-membership/service.js';
import {effectiveStoreCapabilities,requireStoreInstance,storeCapabilities} from '../hosted/capabilities.js';
import {instance,profile,ready,storeRead} from '../hosted/store.js';
import type {CommerceSettings} from '../operations/runtime-settings.js';
import {confirmedPaymentSQL} from './confirmed-payment.js';
import {PAYMENT_EXCEPTION_POLICIES,type PaymentExceptionKind} from './exceptions.js';
import {commerceRateLimitInTransaction,chargePaymentQueryOrderBudgets} from './limits.js';
import {sellerCheckoutCommand,type SellerCheckoutContext} from './seller-command.js';
import {quarantineGate} from './public-commands.js';
import {lockStore} from './authority.js';
import {cancelUnpaidOrder,lockCheckoutOrders} from './orders.js';
import {canonicalJSON,type CheckoutPaymentActions,type CheckoutPaymentPort,type CheckoutPaymentSummary,type CheckoutTerms} from './terms.js';

export interface SellerCheckoutReadOptions {settings?:CommerceSettings;payment?:CheckoutPaymentPort;paymentActions?:CheckoutPaymentActions;cursors?:TenantListCursorCodec}
const limit=z.string().regex(/^[0-9]+$(?![\s\S])/).transform(Number).pipe(z.number().int().min(1).max(50));
export const SellerCheckoutOrderQuerySchema=z.object({lifecycle:z.enum(['open','cancelled','closed']).optional(),needs_action:z.literal('true').optional(),
  display_number:z.string().regex(/^[0-9]{6}-[0-9A-HJKMNP-TV-Z]{6}$(?![\s\S])/).optional(),payment_method:z.enum(['immediate_card','bank_transfer','cash_on_meetup']).optional(),
  awaiting_offline_payment:z.literal('true').optional(),cursor:z.string().max(512).optional(),limit:limit.optional()}).strict();

export function sellerCheckoutRead<T>(pool:Pool,actor:Actor,tenantId:string,instanceId:string,capability:string,
  run:(q:PoolClient,context:SellerCheckoutContext)=>Promise<T>) {
  return storeRead(pool,actor,tenantId,instanceId,capability,async(q,tenant)=>{
    const p=await profile(q,tenantId,instanceId);ready(p);return run(q,{tenant,profile:p});
  });
}
export async function sellerCheckoutOrderRow(q:PoolClient,context:SellerCheckoutContext,id:string) {
  const row=(await q.query(`SELECT co.*,co.version::text,o.created_at,o.expires_at,o.expires_at<=clock_timestamp() AS hold_expired,
    CASE WHEN co.payment_method='immediate_card' THEN NULL ELSE o.expires_at+interval '72 hours' END AS payment_grace_until,
    ${confirmedPaymentSQL('co.order_id')} AS confirmed,
    EXISTS(SELECT 1 FROM commerce_checkout_payment_applications a WHERE a.order_id=co.order_id AND a.outcome='unallocatable') AS unallocatable,
    c.contact_name,c.redacted_at,h.handover_id,to_char(h.completed_on,'YYYY-MM-DD') AS handover_completed_on,h.recorded_at AS handover_recorded_at,
    (SELECT count(*)::int FROM commerce_exception_cases e WHERE e.order_id=co.order_id AND e.tenant_id=co.tenant_id AND e.instance_id=co.instance_id AND e.status='open') AS open_exception_count
    FROM commerce_checkout_orders co JOIN commerce_orders o USING(order_id)
    JOIN commerce_checkout_contacts c ON c.contact_id=co.contact_id AND c.checkout_id=co.checkout_id AND c.tenant_id=co.tenant_id AND c.instance_id=co.instance_id
    LEFT JOIN commerce_meetup_handovers h ON h.order_id=co.order_id AND h.tenant_id=co.tenant_id AND h.instance_id=co.instance_id
    WHERE co.order_id=$1 AND co.tenant_id=$2 AND co.instance_id=$3 AND o.public_shop_id=$4 AND o.order_profile='hosted_checkout'`,
  [id,context.tenant.tenant_id,context.profile.instance_id,context.profile.storefront_shop_id])).rows[0];
  requireCondition(row,404,'checkout_order_not_found','找不到訂單。');return row;
}
async function inventory(q:PoolClient,id:string,unallocatable:boolean,expired:boolean) {
  const rows=(await q.query(`SELECT l.snapshot->>'sku' AS sku,r.state AS hold_state,r.quantity AS hold_quantity,
    a.allocation_id,a.quantity,a.shipped_quantity,a.released_quantity
    FROM commerce_order_lines l LEFT JOIN commerce_inventory_reservations r ON r.order_id=l.order_id AND r.item_id=l.item_id
    LEFT JOIN commerce_inventory_allocations a ON a.order_id=l.order_id AND a.item_id=l.item_id WHERE l.order_id=$1`,[id])).rows;
  const allocated=rows.filter(r=>r.allocation_id),remaining=allocated.reduce((n,r)=>n+Number(r.quantity)-Number(r.shipped_quantity)-Number(r.released_quantity),0),shipped=allocated.reduce((n,r)=>n+Number(r.shipped_quantity),0);
  const state=unallocatable&&!allocated.length?'unallocated':allocated.length?(shipped===0&&remaining===0?'released':shipped>0&&remaining===0?'shipped':shipped>0&&remaining>0?'partially_shipped':'allocated'):
    rows.some(r=>r.hold_state==='held')?(expired?'hold_expired':'held'):'released';
  return {state,lines:new Map(rows.map(r=>[r.sku,{held:r.hold_state==='held'?Number(r.hold_quantity):0,
    allocated:r.allocation_id?Number(r.quantity)-Number(r.shipped_quantity)-Number(r.released_quantity):0,shipped:Number(r.shipped_quantity??0),released:Number(r.released_quantity??0)}]))};
}
export function sellerCursorPosition(codec:TenantListCursorCodec,raw:string|undefined,binding:TenantListCursorBinding) {
  const position=codec.decode(raw,binding);
  requireCondition(!position||Object.keys(position).sort().join(',')==='at,id'&&typeof position.at==='string'
    &&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(position.at)&&Number.isFinite(Date.parse(position.at))&&OpaqueId.safeParse(position.id).success,
  422,'invalid_cursor','分頁游標無效。');
  return position as {at:string;id:string}|null;
}
export function sellerCustomer(name:string|null,redacted:boolean) {
  return {name_masked:redacted?null:(Array.from((name??'').trim())[0]??'')+'○○',contact_redacted:redacted};
}
async function summary(q:PoolClient,row:Awaited<ReturnType<typeof sellerCheckoutOrderRow>>,payment?:CheckoutPaymentSummary) {
  const t=row.terms as CheckoutTerms,stock=await inventory(q,row.order_id,row.unallocatable,row.hold_expired),redacted=row.redacted_at!==null;
  return {value:{order_ref:row.order_id,display_number:row.display_number,environment:row.environment,created_at:row.created_at.toISOString(),pay_by:row.expires_at.toISOString(),
    lifecycle_state:row.lifecycle_state,cancel_reason:row.cancel_reason,currency:t.currency,total_minor:t.total_minor,quantity_total:t.items.reduce((n,l)=>n+l.quantity,0),
    customer:sellerCustomer(row.contact_name,redacted),payment_method:row.payment_method,
    payment_state:payment?.payment_state??(row.confirmed?'confirmed':'unpaid'),inventory_state:stock.state,open_exception_count:row.open_exception_count,version:row.version},stock};
}
export async function listSellerCheckoutOrders(pool:Pool,actor:Actor,tenantId:string,instanceId:string,raw:unknown,options:SellerCheckoutReadOptions={}) {
  const query=SellerCheckoutOrderQuerySchema.parse(raw);
  return sellerCheckoutRead(pool,actor,tenantId,instanceId,'store:orders:read',async(q,context)=>{
    const codec=options.cursors??unavailableTenantListCursor,binding={purpose:'seller-checkout-orders' as const,tenantId,principalId:context.tenant.principal_id,scopeId:context.tenant.scope.scope_id,resourceId:instanceId,
      filter:canonicalJSON({lifecycle:query.lifecycle??null,needs_action:query.needs_action==='true',display_number:query.display_number??null,payment_method:query.payment_method??null,awaiting_offline_payment:query.awaiting_offline_payment==='true'})};
    const after=sellerCursorPosition(codec,query.cursor,binding),size=query.limit??20;
    const rows=(await q.query(`SELECT co.order_id,to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
      FROM commerce_checkout_orders co JOIN commerce_orders o USING(order_id)
      WHERE co.tenant_id=$1 AND co.instance_id=$2 AND o.public_shop_id=$3 AND o.order_profile='hosted_checkout'
      AND ($4::text IS NULL OR co.lifecycle_state=$4) AND ($5::text IS NULL OR co.display_number=$5)
      AND (NOT $6::boolean OR EXISTS(SELECT 1 FROM commerce_exception_cases e WHERE e.order_id=co.order_id AND e.tenant_id=co.tenant_id AND e.instance_id=co.instance_id AND e.status='open'))
      AND ($7::text IS NULL OR co.payment_method=$7)
      AND ($8::boolean IS NOT TRUE OR (co.lifecycle_state='open' AND co.payment_method<>'immediate_card' AND NOT ${confirmedPaymentSQL('co.order_id')}))
      AND ($9::timestamptz IS NULL OR (o.created_at,o.order_id)<($9::timestamptz,$10::uuid)) ORDER BY o.created_at DESC,o.order_id DESC LIMIT $11`,
    [tenantId,instanceId,context.profile.storefront_shop_id,query.lifecycle??null,query.display_number??null,query.needs_action==='true',query.payment_method??null,query.awaiting_offline_payment==='true',after?.at??null,after?.id??null,size+1])).rows;
    const page=rows.slice(0,size),payments=await options.payment?.summarize(q,page.map(r=>r.order_id)),items=[];
    for(const ref of page)items.push((await summary(q,await sellerCheckoutOrderRow(q,context,ref.order_id),payments?.get(ref.order_id))).value);
    return {items,next_cursor:rows.length>size?codec.encode({at:page[page.length-1].at,id:page[page.length-1].order_id},binding):null};
  });
}
/** Explicit finance allowlists are also used by refund and case endpoints. No
 * credentials, raw provider bodies or contact fields enter these projections. */
export async function sellerRefunds(q:PoolClient,context:SellerCheckoutContext,orderId:string) {
  const rows=(await q.query(`SELECT refund_id,application_id,attempt_id,amount_minor,currency,to_char(refunded_on,'YYYY-MM-DD') AS refunded_on,provider_reference,
    basis,mode,state,recorded_by_principal_id,created_at FROM commerce_refunds WHERE order_id=$1 AND tenant_id=$2 AND instance_id=$3 ORDER BY created_at,refund_id LIMIT 100`,
  [orderId,context.tenant.tenant_id,context.profile.instance_id])).rows;
  return rows.map(r=>({refund_ref:r.refund_id,application_ref:r.application_id,attempt_ref:r.attempt_id,amount_minor:Number(r.amount_minor),currency:r.currency,refunded_on:r.refunded_on,
    provider_reference:r.provider_reference,basis:r.basis,mode:r.mode,state:r.state,recorded_without_provider:r.mode==='manual_record',recorded_by:r.recorded_by_principal_id,created_at:r.created_at.toISOString()}));
}
export const CASE_RESOLUTION_CODES:Readonly<Record<PaymentExceptionKind,readonly ('refunded'|'confirmed'|'checked_with_provider')[]>>={
  amount_mismatch:['refunded'],paid_after_cancel:['refunded'],overpaid:['refunded'],paid_unallocatable:[],payment_unconfirmed:['confirmed','checked_with_provider'],unmatched_payment:['checked_with_provider'],contradicting_event:['checked_with_provider'],
};
export async function sellerExceptionRows(q:PoolClient,context:SellerCheckoutContext,where:string,values:unknown[]=[]) {
  return (await q.query(`SELECT e.*,e.version::text,o.display_number,
    to_char(e.due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_due_at,
    to_char(e.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_updated_at FROM commerce_exception_cases e
    LEFT JOIN commerce_checkout_orders o ON o.order_id=e.order_id AND o.tenant_id=e.tenant_id AND o.instance_id=e.instance_id
    WHERE e.tenant_id=$1 AND e.instance_id=$2 AND ${where}`,[context.tenant.tenant_id,context.profile.instance_id,...values])).rows;
}
export async function sellerExceptionView(q:PoolClient,context:SellerCheckoutContext,row:Awaited<ReturnType<typeof sellerExceptionRows>>[number],keys:readonly string[]) {
  const kind=row.kind as PaymentExceptionKind,codes=CASE_RESOLUTION_CODES[kind],actions:('resolve_with_evidence'|'retry_allocation')[]=row.status==='open'&&keys.includes('store:orders:manage')?(kind==='paid_unallocatable'?['retry_allocation']:['resolve_with_evidence']):[];
  let facts=null;
  if(keys.includes('store:finance:read')) {
    if(row.subject_kind==='offline_payment') {
      const payment=(await q.query(`SELECT p.amount_minor,p.currency,(p.received_on::timestamp AT TIME ZONE 'Asia/Taipei') AS payment_date,(co.terms->>'total_minor')::bigint AS expected
        FROM commerce_offline_payments p JOIN commerce_checkout_orders co ON co.order_id=p.order_id AND co.tenant_id=p.tenant_id AND co.instance_id=p.instance_id
        WHERE p.payment_id=$1 AND p.tenant_id=$2 AND p.instance_id=$3`,[row.subject_id,context.tenant.tenant_id,context.profile.instance_id])).rows[0];
      if(payment)facts={merchant_trade_no:null,trade_no:null,expected_amount_minor:Number(payment.expected),paid_amount_minor:Number(payment.amount_minor),currency:payment.currency,payment_date:payment.payment_date.toISOString(),payment_type:'bank_transfer'};
    } else {
      const attempt=row.subject_kind==='payment_attempt'?(await q.query(`SELECT a.merchant_trade_no,coalesce(a.trade_no,e.trade_no) AS trade_no,a.amount_minor AS expected,
        coalesce(p.amount_minor,e.trade_amt_minor) AS paid,a.currency,coalesce(a.payment_date,e.payment_date) AS payment_date,coalesce(a.payment_type,e.payment_type) AS payment_type
        FROM commerce_payment_attempts a LEFT JOIN commerce_checkout_payment_applications p ON p.payment_ref=a.attempt_id
        LEFT JOIN LATERAL (SELECT trade_no,trade_amt_minor,payment_date,payment_type FROM commerce_hosted_payment_events WHERE attempt_id=a.attempt_id AND source IN ('notification','query') AND outcome IN ('paid','amount_mismatch') ORDER BY received_at DESC,event_id DESC LIMIT 1) e ON true
        WHERE a.attempt_id=$1 AND a.tenant_id=$2 AND a.instance_id=$3`,[row.subject_id,context.tenant.tenant_id,context.profile.instance_id])).rows[0]:
        (await q.query(`SELECT merchant_trade_no,trade_no,NULL::bigint AS expected,trade_amt_minor AS paid,'TWD' AS currency,payment_date,payment_type
        FROM commerce_hosted_payment_events WHERE event_id=$1 AND tenant_id=$2 AND instance_id=$3`,[row.subject_id,context.tenant.tenant_id,context.profile.instance_id])).rows[0];
      if(attempt)facts={merchant_trade_no:attempt.merchant_trade_no,trade_no:attempt.trade_no,expected_amount_minor:attempt.expected===null?null:Number(attempt.expected),paid_amount_minor:attempt.paid===null?null:Number(attempt.paid),
        currency:attempt.currency,payment_date:attempt.payment_date?.toISOString()??null,payment_type:attempt.payment_type};
    }
  }
  return {case_ref:row.case_id,kind,status:row.status,responsible_party:row.responsible_party,order:row.order_id?{order_ref:row.order_id,display_number:row.display_number}:null,
    subject:{kind:row.subject_kind,ref:row.subject_id},next_action:PAYMENT_EXCEPTION_POLICIES[kind].next_action,due_at:row.due_at.toISOString(),opened_at:row.created_at.toISOString(),updated_at:row.updated_at.toISOString(),
    resolution:row.status==='open'?null:{code:row.resolution_code,note:row.resolution_note,resolved_by:row.resolved_by_principal_id},payment_facts:facts,allowed_actions:actions,resolution_codes:actions.includes('resolve_with_evidence')?[...codes]:[],version:row.version};
}
export async function projectSellerCheckoutOrder(q:PoolClient,context:SellerCheckoutContext,id:string,options:SellerCheckoutReadOptions={}) {
  const row=await sellerCheckoutOrderRow(q,context,id),keys=await effectiveStoreCapabilities(q,context.tenant,context.profile.instance_id),payment=(await options.payment?.summarize(q,[id]))?.get(id),base=await summary(q,row,payment),t=row.terms as CheckoutTerms;
  const applications=(await q.query(`SELECT a.application_id,a.payment_ref,a.amount_minor,a.currency,a.outcome,a.created_at,coalesce(r.refunded,0) AS refunded,p.payment_id AS offline_payment_id
    FROM commerce_checkout_payment_applications a LEFT JOIN LATERAL (SELECT sum(amount_minor) AS refunded FROM commerce_refunds WHERE application_id=a.application_id AND state IN ('recorded','confirmed')) r ON true
    LEFT JOIN commerce_offline_payments p ON p.payment_id=a.payment_ref AND p.order_id=a.order_id WHERE a.order_id=$1 ORDER BY a.created_at,a.application_id`,[id])).rows.map(r=>{
      const unapplied=['overpaid','after_cancel','amount_mismatch'].includes(r.outcome),amount=Number(r.amount_minor),refunded=Number(r.refunded),offline=r.offline_payment_id!==null;
      return {application_ref:r.application_id,attempt_ref:offline||r.outcome==='simulated'?null:r.payment_ref,offline_payment_ref:offline?r.offline_payment_id:null,amount_minor:amount,currency:r.currency,outcome:r.outcome,created_at:r.created_at.toISOString(),refunded_minor:refunded,refundable_minor:unapplied?amount-refunded:0};
    });
  let payment_detail=null;
  if(keys.includes('store:finance:read')) {
    const attempts=(await q.query(`SELECT attempt_id,sequence,state,amount_minor,currency,merchant_trade_no,trade_no,payment_type,payment_date,charge_fee_minor,
      created_at,handed_off_at,paid_at,confirmed_at,failed_at,superseded_at,expired_at FROM commerce_payment_attempts WHERE order_id=$1 ORDER BY sequence`,[id])).rows.map(r=>({attempt_ref:r.attempt_id,sequence:r.sequence,state:r.state,amount_minor:Number(r.amount_minor),currency:r.currency,merchant_trade_no:r.merchant_trade_no,trade_no:r.trade_no,payment_type:r.payment_type,payment_date:r.payment_date?.toISOString()??null,
      charge_fee_minor:r.charge_fee_minor===null?null:Number(r.charge_fee_minor),created_at:r.created_at.toISOString(),handed_off_at:r.handed_off_at?.toISOString()??null,paid_at:r.paid_at?.toISOString()??null,confirmed_at:r.confirmed_at?.toISOString()??null,failed_at:r.failed_at?.toISOString()??null,superseded_at:r.superseded_at?.toISOString()??null,expired_at:r.expired_at?.toISOString()??null}));
    const offline_payments=(await q.query(`SELECT payment_id,method,amount_minor,currency,to_char(received_on,'YYYY-MM-DD') AS received_on,reference,confirmed_by_principal_id,confirmed_at
      FROM commerce_offline_payments WHERE order_id=$1 AND tenant_id=$2 AND instance_id=$3 ORDER BY confirmed_at,payment_id`,[id,context.tenant.tenant_id,context.profile.instance_id])).rows.map(p=>({
      offline_payment_ref:p.payment_id,method:p.method,amount_minor:Number(p.amount_minor),currency:p.currency,received_on:p.received_on,reference:p.reference,confirmed_by:p.confirmed_by_principal_id,confirmed_at:p.confirmed_at.toISOString()}));
    payment_detail={attempts,applications,offline_payments,refunds:await sellerRefunds(q,context,id)};
  }
  const cases=await sellerExceptionRows(q,context,`e.order_id=$3 ORDER BY (e.status='open') DESC,CASE WHEN e.status='open' THEN e.due_at END,CASE WHEN e.status='open' THEN e.case_id END,CASE WHEN e.status<>'open' THEN e.updated_at END DESC,e.case_id DESC`,[id]),exceptions=[];
  for(const c of cases)exceptions.push(await sellerExceptionView(q,context,c,keys));
  const writable=context.tenant.tenant_status==='active'&&!options.settings?.quarantine,open=row.lifecycle_state==='open',manage=keys.includes('store:orders:manage'),fulfil=keys.includes('store:fulfil');
  const remaining=[...base.stock.lines.values()].reduce((n,line)=>n+line.allocated,0),meetupDelivery=t.shipping.groups.length>0&&t.shipping.groups.every(group=>group.method_ref==='meetup');
  return {...base.value,payment_grace_until:row.payment_grace_until?.toISOString()??null,meetup_handover:row.handover_id?{handover_ref:row.handover_id,completed_on:row.handover_completed_on,recorded_at:row.handover_recorded_at.toISOString()}:null,
    lines:t.items.map(l=>({sku:l.sku,title:l.title,quantity:l.quantity,unit_price_minor:l.unit_price_minor,line_total_minor:l.line_total_minor,inventory:base.stock.lines.get(l.sku)!})),
    merchandise_total_minor:t.merchandise_total_minor,discount_total_minor:t.discount_total_minor,shipping_total_minor:t.shipping_total_minor,latest_payment_attempt:payment?.latest_payment_attempt??null,payment_detail,exceptions,
    actions:{cancel:manage&&open&&!row.confirmed&&writable,
      query_payment:(keys.includes('store:orders:read')||keys.includes('store:finance:read'))&&!options.settings?.quarantine&&(await options.payment?.queryable?.(q,id)??false),
      record_refund:keys.includes('store:refund')&&applications.some(a=>a.refundable_minor>0)&&writable,view_contact:keys.includes('store:customers:read'),view_finance:keys.includes('store:finance:read'),
      confirm_offline_payment:manage&&open&&row.payment_method==='bank_transfer'&&!row.confirmed&&writable,
      complete_meetup:manage&&fulfil&&open&&row.payment_method==='cash_on_meetup'&&!row.confirmed&&writable,
      record_meetup_handover:fulfil&&writable&&open&&row.confirmed&&meetupDelivery&&row.handover_id==null&&remaining>0}};
}
export function readSellerCheckoutOrder(pool:Pool,actor:Actor,tenantId:string,instanceId:string,id:string,options:SellerCheckoutReadOptions={}) {
  return sellerCheckoutRead(pool,actor,tenantId,instanceId,'store:orders:read',(q,context)=>projectSellerCheckoutOrder(q,context,id,options));
}
export async function readSellerOrderContact(pool:Pool,actor:Actor,tenantId:string,instanceId:string,id:string) {
  // Count the caller's attempts independently, including capability denials.
  await isolatedTransaction(pool,async q=>{await lockMemberSession(q,actor);const principal=await mapPersonPrincipal(q,actor.user_id);
    await commerceRateLimitInTransaction(q,'customerDataPrincipal',principal.principal_id);await assertCurrentSessionClock(q,actor);});
  return sellerCheckoutRead(pool,actor,tenantId,instanceId,'store:customers:read',async(q,context)=>{
    const order=await sellerCheckoutOrderRow(q,context,id),r=(await q.query(`SELECT contact_name,contact_email,contact_phone,delivery,invoice,redacted_at FROM commerce_checkout_contacts
      WHERE contact_id=$1 AND checkout_id=$2 AND tenant_id=$3 AND instance_id=$4`,[order.contact_id,order.checkout_id,tenantId,instanceId])).rows[0],redacted=r.redacted_at!==null;
    return {order_ref:id,contact_redacted:redacted,contact:redacted?null:{name:r.contact_name,email:r.contact_email,phone:r.contact_phone},delivery:redacted?null:r.delivery,invoice:redacted?null:r.invoice};
  });
}

export async function cancelSellerCheckoutOrder(pool:Pool,actor:Actor,tenantId:string,instanceId:string,id:string,key:string,expected:string,options:SellerCheckoutReadOptions={}) {
  quarantineGate(options);
  return sellerCheckoutCommand(pool,actor,tenantId,instanceId,'store:orders:manage','commerce.checkout_order.cancel',{kind:'hosted_checkout_order',id},{},key,expected,
    async(q,context)=>{
      await sellerCheckoutOrderRow(q,context,id);
      const store={storefront_shop_id:context.profile.storefront_shop_id};
      // Check the version under the same domain locks as cancellation. Its
      // repeated locks are reentrant; a pre-lock version read would race payment.
      await lockStore(q,store,[],[id],false);const [order]=await lockCheckoutOrders(q,[id],store);checkVersion(order.version,expected);
      await cancelUnpaidOrder(q,store,id,'seller','seller_cancelled',{payment:options.payment});return {id};
    },(q,context,ref)=>projectSellerCheckoutOrder(q,context,ref,options));
}

/** Authorize and charge in separate short transactions. The shared payment
 * action owns attempt selection and releases its lease client before transport. */
export async function querySellerPayment(pool:Pool,actor:Actor,tenantId:string,instanceId:string,orderId:string,network:string,options:SellerCheckoutReadOptions={}) {
  quarantineGate(options);
  const permitted=async(q:PoolClient,context:SellerCheckoutContext)=>{
    const keys=await effectiveStoreCapabilities(q,context.tenant,instanceId);
    requireCondition(keys.includes('store:orders:read')||keys.includes('store:finance:read'),403,'capability_denied','目前沒有這個操作的權限。');
    await sellerCheckoutOrderRow(q,context,orderId);return context;
  };
  const context=await sellerCheckoutRead(pool,actor,tenantId,instanceId,'store:read',permitted);
  await chargePaymentQueryOrderBudgets(pool,orderId);
  const authorize=async(q:PoolClient)=>{
    const tenant=await lockTenantScope(q,{actor,tenantId,capabilitiesForRole:storeCapabilities});
    await instance(q,tenantId,instanceId,false);await requireStoreInstance(q,tenant,instanceId,'store:read');
    const p=await profile(q,tenantId,instanceId);ready(p);await permitted(q,{tenant,profile:p});
    await assertCurrentSessionClock(q,actor);
  };
  const result=await options.paymentActions?.query?.(pool,{store:{storefront_shop_id:context.profile.storefront_shop_id},orderId,network,authorize,trigger:'seller'});
  if(result==='query_in_progress')throw new Problem(409,'payment_result_pending','付款結果確認中，請稍後再查詢。');
  return sellerCheckoutRead(pool,actor,tenantId,instanceId,'store:read',async(q,current)=>{await permitted(q,current);return projectSellerCheckoutOrder(q,current,orderId,options);});
}
