import {randomBytes,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {Problem,requireCondition} from '../../../packages/shared/problem.js';
import {bindStore,lockStore,lockMachineOrder,type CheckoutStore} from './authority.js';
import {checkoutInventory} from './inventory.js';
import {confirmedPaymentSQL,hasConfirmedPayment} from './confirmed-payment.js';
import {checkoutTerms,defaultAdmission,linkCustomerMember,validateCheckoutStrings,hashJSON,parseCheckoutInput,type CheckoutPorts,type CheckoutTerms,type PaymentMethod} from './terms.js';
import {settleDueCheckoutHolds} from './settlement.js';
export class CheckoutStockUnavailable extends Problem {
  constructor(public items:readonly {sku:string;available:number}[]){super(409,'stock_unavailable','商品庫存不足。');}
}
export class UnresolvedCheckoutOrder extends Problem {
  constructor(public order_ref:string){super(409,'unresolved_order','前一筆付款結果確認中。');}
}
export interface CheckoutOrderRow {order_id:string;checkout_id:string;customer_id:string;contact_id:string;tenant_id:string;instance_id:string;
  terms:CheckoutTerms;terms_sha256:string;environment:'sandbox'|'live';lifecycle_state:'open'|'cancelled'|'closed';cancel_reason:string|null;version:string;display_number:string;
  payment_method:PaymentMethod}
export async function lockCheckoutOrders(q:PoolClient,ids:readonly string[],store?:CheckoutStore,paymentRef?:string) {
  const sorted=[...new Set(ids)].sort();
  const targets=(await q.query(`SELECT co.order_id,co.checkout_id FROM commerce_checkout_orders co JOIN commerce_orders o USING(order_id)
    WHERE co.order_id=ANY($1::uuid[]) AND ($2::uuid IS NULL OR o.public_shop_id=$2) ORDER BY co.order_id`,[sorted,store?.storefront_shop_id??null])).rows;
  requireCondition(targets.length===sorted.length,404,'checkout_order_not_found','找不到訂單。');
  await q.query('SELECT checkout_id FROM commerce_checkouts WHERE checkout_id=ANY($1::uuid[]) ORDER BY checkout_id FOR UPDATE',[targets.map(t=>t.checkout_id)]);
  const rows=(await q.query<CheckoutOrderRow>('SELECT *,version::text FROM commerce_checkout_orders WHERE order_id=ANY($1::uuid[]) ORDER BY order_id FOR UPDATE',[sorted])).rows;
  await q.query('SELECT order_id FROM commerce_orders WHERE order_id=ANY($1::uuid[]) ORDER BY order_id FOR UPDATE',[sorted]);
  if(paymentRef){
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`checkout-payment/${paymentRef}`]);
  }
  // Attempt rows belong immediately after base orders / payment-reference locks,
  // before applications and inventory. Handoff, callback and expiry share this order.
  await q.query('SELECT attempt_id FROM commerce_payment_attempts WHERE order_id=ANY($1::uuid[]) ORDER BY order_id,attempt_id FOR UPDATE',[sorted]);
  if(paymentRef&&(await q.query('SELECT 1 FROM commerce_checkout_payment_applications WHERE payment_ref=$1',[paymentRef])).rowCount)return rows;
  await q.query('SELECT application_id FROM commerce_checkout_payment_applications WHERE order_id=ANY($1::uuid[]) ORDER BY application_id FOR UPDATE',[sorted]);
  await q.query('SELECT reservation_id FROM commerce_inventory_reservations WHERE order_id=ANY($1::uuid[]) ORDER BY item_id,order_id FOR UPDATE',[sorted]);
  await q.query('SELECT allocation_id FROM commerce_inventory_allocations WHERE order_id=ANY($1::uuid[]) ORDER BY item_id,order_id FOR UPDATE',[sorted]);
  await q.query(`SELECT i.item_id FROM commerce_items i WHERE EXISTS(SELECT 1 FROM commerce_order_lines l WHERE l.order_id=ANY($1::uuid[]) AND l.item_id=i.item_id) ORDER BY i.item_id FOR UPDATE`,[sorted]);
  return rows;
}
const unresolved={async find(q:PoolClient,checkoutId:string){return (await q.query<{order_id:string}>(`SELECT co.order_id FROM commerce_checkout_orders co WHERE co.checkout_id=$1 AND co.lifecycle_state='open'
  AND NOT ${confirmedPaymentSQL('co.order_id')} ORDER BY co.order_id LIMIT 1`,[checkoutId])).rows[0]??null;}};
export async function placeCheckoutOrder(q:PoolClient,store:CheckoutStore,input:{checkoutId:string;termsSha256:string;clientOrderId:string;buyerPrincipalId:string|null;environment:'sandbox'|'live';paymentMethod?:PaymentMethod},ports:CheckoutPorts={}) {
  validateCheckoutStrings(input);
  const paymentMethod=input.paymentMethod??'immediate_card';
  const peek=(await q.query(`SELECT c.terms FROM commerce_checkouts c JOIN commerce_storefront_profiles p ON p.instance_id=c.instance_id AND p.tenant_id=c.tenant_id
    WHERE c.checkout_id=$1 AND p.storefront_shop_id=$2`,[input.checkoutId,store.storefront_shop_id])).rows[0];
  requireCondition(peek,404,'checkout_not_found','找不到結帳。');
  if(paymentMethod!=='immediate_card'&&ports.paymentMethods?.offlinePaymentRequiresMember!==false&&!input.buyerPrincipalId)throw new Problem(403,'offline_payment_requires_member','登入會員後才能選擇匯款或面交。');
  const context=await lockStore(q,store,(peek.terms as CheckoutTerms).items.map(l=>l.sku)),p=context.profile;
  requireCondition(await (ports.admission??defaultAdmission).allowed(q,p),409,'checkout_not_enabled','尚未開放線上付款。');
  await settleDueCheckoutHolds(q,(peek.terms as CheckoutTerms).bindings.map(b=>b.item_id),{ordersPerItem:99});
  const c=(await q.query(`SELECT * FROM commerce_checkouts WHERE checkout_id=$1 AND tenant_id=$2 AND instance_id=$3 FOR UPDATE`,[input.checkoutId,p.tenant_id,p.instance_id])).rows[0];
  const hash=hashJSON({checkoutId:input.checkoutId,termsSha256:input.termsSha256,clientOrderId:input.clientOrderId,environment:input.environment,...(paymentMethod==='immediate_card'?{}:{paymentMethod})});
  const prior=(await q.query(`SELECT co.*,co.version::text,o.request_sha256 FROM commerce_checkout_orders co JOIN commerce_orders o USING(order_id)
    WHERE co.checkout_id=$1 AND o.client_order_id=$2 FOR UPDATE OF co,o`,[c.checkout_id,input.clientOrderId])).rows[0];
  if(prior){
    requireCondition(prior.request_sha256===hash,409,'order_intent_conflict','訂單識別碼已用於其他內容。');
    const {request_sha256:requestHash,...saved}=prior;
    return saved as CheckoutOrderRow;
  }
  requireCondition((await q.query('SELECT 1 WHERE $1::timestamptz>clock_timestamp()',[c.expires_at])).rowCount===1,409,'checkout_expired','結帳已到期。');
  requireCondition(c.terms_sha256===input.termsSha256,409,'terms_changed','結帳內容已更新。');
  await linkCustomerMember(q,c.customer_id,input.buyerPrincipalId??undefined);
  const contact=(await q.query('SELECT * FROM commerce_checkout_contacts WHERE contact_id=$1 AND checkout_id=$2',[c.current_contact_id,c.checkout_id])).rows[0];
  requireCondition(contact && !contact.redacted_at,409,'checkout_contact_unavailable','結帳聯絡資料無法使用。');
  const saved=c.terms as CheckoutTerms;
  const raw=parseCheckoutInput({publication_revision:saved.publication_revision,lines:saved.items.map(l=>({sku:l.sku,quantity:l.quantity})),
    contact:{name:contact.contact_name,email:contact.contact_email,phone:contact.contact_phone},delivery:contact.delivery,invoice:contact.invoice,consents:saved.consents});
  try {
    const fresh=await checkoutTerms(q,context,raw,ports,contact.contact_salt);
    requireCondition(fresh.terms_sha256===input.termsSha256,409,'terms_changed','售價或供貨已更新。');
  } catch(error) {
    if(error instanceof Problem && ['publication_changed','supply_unavailable','terms_changed','consents_mismatch'].includes(error.code))throw new Problem(409,'terms_changed','售價、公開版本或供貨同意已更新。');
    throw error;
  }
  requireCondition(saved.shipping?.destination_state==='complete',409,'delivery_store_required','請先選擇取貨門市。');
  requireCondition((saved.payment_methods as readonly string[]).includes(paymentMethod),409,'payment_method_unavailable','這個付款方式目前無法使用。');
  const deadline=paymentMethod==='bank_transfer'?saved.offline_payment?.bank_transfer_deadline_days:paymentMethod==='cash_on_meetup'?saved.offline_payment?.meetup_deadline_days:null;
  if(paymentMethod!=='immediate_card'&&deadline==null)throw new Error('offline_payment_methods_missing');
  const existing=await (ports.unresolved??unresolved).find(q,c.checkout_id);
  if(existing)throw new UnresolvedCheckoutOrder(existing.order_id);
  const items=(await q.query<{item_id:string;available:number}>('SELECT item_id,stock-reserved AS available FROM commerce_items WHERE item_id=ANY($1::uuid[]) ORDER BY item_id FOR UPDATE',[saved.bindings.map(b=>b.item_id)])).rows;
  const availability=saved.bindings.map(b=>({sku:b.sku,available:items.find(i=>i.item_id===b.item_id)?.available??0}));
  if(!saved.bindings.every(b=>(items.find(i=>i.item_id===b.item_id)?.available??-1)>=b.quantity))throw new CheckoutStockUnavailable(availability);
  const id=randomUUID();
  const base=(await q.query<{created_at:Date;expires_at:Date;display_date:string}>(`INSERT INTO commerce_orders(order_id,public_shop_id,external_id,request_sha256,currency,total_minor,created_at,expires_at,order_profile,buyer_principal_id,client_order_id)
    SELECT $1,$2,$3,$4,$5,$6,t,CASE WHEN $9::text='immediate_card' THEN t+interval '30 minutes' ELSE t+make_interval(hours => 24 * $10::int) END,'hosted_checkout',$7,$8 FROM (SELECT date_trunc('milliseconds',clock_timestamp()) t) n
    RETURNING created_at,expires_at,to_char(created_at AT TIME ZONE 'Asia/Taipei','YYMMDD') AS display_date`,
  [id,p.storefront_shop_id,`chk:${c.checkout_id}:${input.clientOrderId}`,hash,c.currency,saved.total_minor,input.buyerPrincipalId,input.clientOrderId,paymentMethod,deadline??0])).rows[0];
  const alphabet='0123456789ABCDEFGHJKMNPQRSTVWXYZ';let display='';
  for(let attempt=0;attempt<32;attempt++){
    const suffix=[...randomBytes(6)].map(b=>alphabet[b&31]).join('');display=`${base.display_date}-${suffix}`;
    if(!(await q.query('SELECT 1 FROM commerce_checkout_orders WHERE instance_id=$1 AND display_number=$2',[p.instance_id,display])).rowCount)break;
    requireCondition(attempt<31,503,'display_number_unavailable','無法產生訂單編號。');
  }
  await q.query(`INSERT INTO commerce_checkout_orders(order_id,tenant_id,instance_id,checkout_id,customer_id,contact_id,display_number,terms,terms_sha256,environment,payment_method)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[id,p.tenant_id,p.instance_id,c.checkout_id,c.customer_id,c.current_contact_id,display,saved,c.terms_sha256,input.environment,paymentMethod]);
  for(const b of [...saved.bindings].sort((a,b)=>a.item_id.localeCompare(b.item_id)))await q.query(`INSERT INTO commerce_order_lines(order_id,selection_id,item_id,quantity,snapshot,order_profile,supplier_shop_id,hosted_offer_id,acceptance_id,listing_sha256)
    VALUES($1,$2,$3,$4,$5,'hosted_checkout',$6,$7,$8,$9)`,[id,b.selection_id,b.item_id,b.quantity,saved.items.find(l=>l.sku===b.sku),b.supplier_shop_id,b.offer_id,b.acceptance_id,b.listing_sha256]);
  await (await checkoutInventory(q,id)).hold();
  await bindStore(q,p.tenant_id);
  if(paymentMethod==='immediate_card')await ports.payment?.createOrderAttempt(q,{store:p,orderId:id,amountMinor:saved.total_minor,currency:c.currency,environment:input.environment});
  else {
    if(!ports.paymentMethods)throw new Error('offline_payment_methods_missing');
    await ports.paymentMethods.onOfflineOrderPlaced(q,{tenantId:p.tenant_id,instanceId:p.instance_id,orderId:id,expiresAt:base.expires_at});
  }
  return (await q.query<CheckoutOrderRow>('SELECT *,version::text FROM commerce_checkout_orders WHERE order_id=$1',[id])).rows[0];
}
export async function cancelUnpaidOrder(q:PoolClient,store:CheckoutStore,orderId:string,actor:'buyer'|'seller'|'system',reason:'buyer_cancelled'|'seller_cancelled'|'payment_not_completed',ports:{payment?:Pick<NonNullable<CheckoutPorts['payment']>,'onOrdersCancelled'>}={}) {
  requireCondition(reason===({buyer:'buyer_cancelled',seller:'seller_cancelled',system:'payment_not_completed'} as const)[actor],422,'invalid_cancel_reason','取消原因無效。');
  if(actor==='system')await lockMachineOrder(q,orderId);
  else await lockStore(q,store,[],[orderId],false);
  const [row]=await lockCheckoutOrders(q,[orderId],store);
  if(row.lifecycle_state==='cancelled')return row;
  requireCondition(row.lifecycle_state==='open',409,'checkout_order_closed','訂單已結束。');
  requireCondition(!await hasConfirmedPayment(q,orderId),409,'payment_already_applied','訂單已有付款紀錄。');
  await (await checkoutInventory(q,orderId)).releaseHolds();
  await ports.payment?.onOrdersCancelled(q,[orderId]);
  return (await q.query<CheckoutOrderRow>(`UPDATE commerce_checkout_orders SET lifecycle_state='cancelled',cancel_reason=$2,cancelled_at=clock_timestamp(),version=version+1 WHERE order_id=$1 RETURNING *,version::text`,[orderId,reason])).rows[0];
}
