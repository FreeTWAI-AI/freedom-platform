import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {OpaqueId} from '../../../contracts/guild-launchpad/v1/primitives.js';
import * as wire from '../../../contracts/guild-launchpad/v1/hosted-checkout.js';
import {isolatedTransaction} from '../../../packages/resource-scopes/tenant-transaction.js';
import {mapPersonPrincipal} from '../../../packages/resource-scopes/index.js';
import {Problem,requireCondition} from '../../../packages/shared/problem.js';
import {resolvePublicStorePage} from '../hosted/public.js';
import {lockStore} from './authority.js';
import {freezeCheckout,hashKey,publicCheckoutTerms,validateBuyerJSON,defaultAdmission,type CheckoutPorts,type CheckoutInput} from './terms.js';
import {cancelUnpaidOrder,placeCheckoutOrder} from './orders.js';
import {cartQuote} from './cart-quote.js';
import {publicOrder} from './public-order.js';
import {liveDevice,ensureDevice,grantDevice,hasDeviceGrant,assertDeviceLive,assertAccessLinkLive,redeemAccessLink,forgetDevice,shopCookie,orderAccessNotFound} from './access.js';
import {chargePaymentQueryOrderBudgets,chargeCommerceBudgets,commerceRateLimitInTransaction,lockOpenOrderBudgets,enforceOpenOrderLimits} from './limits.js';
import type {CommerceSettings} from '../operations/runtime-settings.js';
import type {CommerceEmailOutbox} from '../operations/notifications/email-port.js';
export interface HostedCheckoutOptions extends CheckoutPorts {settings?:CommerceSettings;email?:CommerceEmailOutbox;origin:string;environment?:'sandbox'|'live'}
export interface BrowserAccess {deviceToken?:string;sessionToken?:string;network:string}
const defaults:CommerceSettings={checkoutEnabled:false,quarantine:false,providerProfiles:[]};
export function quarantineGate(options:Pick<HostedCheckoutOptions,'settings'>) {requireCondition(!(options.settings??defaults).quarantine,503,'commerce_quarantined','商務服務暫停中。');}
export function checkoutGate(options:HostedCheckoutOptions) {quarantineGate(options);requireCondition((options.settings??defaults).checkoutEnabled,409,'checkout_not_enabled','尚未開放結帳。');}
async function resolve(q:PoolClient,slug:string,options:HostedCheckoutOptions,admit=false,order=false) {
  const store=await resolvePublicStorePage(q,slug);
  if(!store){if(order)orderAccessNotFound();requireCondition(false,404,'checkout_store_not_found','找不到商店。');}
  // Public projections intentionally contain no internal shop selector.
  const row=(await q.query<{storefront_shop_id:string}>('SELECT storefront_shop_id FROM commerce_storefront_profiles WHERE tenant_id=$1 AND instance_id=$2',[store.tenantId,store.instanceId])).rows[0];
  if(admit)requireCondition(await (options.admission??defaultAdmission).allowed(q,row),409,'checkout_not_enabled','尚未開放結帳。');
  return {...store,...row};
}
/** Optional member identity, without authenticate()'s session activity write.
 * Locks serialize deactivation/revocation and a final decision-clock check
 * closes expiry during domain lock waits. Unknown sessions remain guests. */
async function member(q:PoolClient,token:string|undefined,create=false) {
  if(!token)return null;
  const sessionHash=hashKey(token);
  const row=(await q.query<{user_id:string;principal_id:string|null;principal_exists:boolean}>(`SELECT u.user_id,p.principal_id,
    EXISTS(SELECT 1 FROM principals existing WHERE existing.user_ref=u.user_id AND existing.kind='person') AS principal_exists
    FROM sessions s JOIN users u USING(user_id)
    LEFT JOIN principals p ON p.user_ref=u.user_id AND p.kind='person' AND p.status='active'
    WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND u.active ${create?'FOR SHARE OF u,s':''}`,[sessionHash])).rows[0];
  if(!row)return null;
  const mapped=!row.principal_id&&create?await mapPersonPrincipal(q,row.user_id):null;
  const principalId=row.principal_id??(mapped?.status==='active'&&mapped.kind==='person'?mapped.principal_id:null);
  // A first-time buyer has a valid member session before foundation mapping.
  // Quotes stay read-only; checkout creates that mapping under its write locks.
  // A disabled existing principal must not be treated as a new member.
  return {principalId,sessionHash,userId:row.user_id,offlineEligible:principalId!==null||!row.principal_exists};
}
async function currentMember(q:PoolClient,identity:Awaited<ReturnType<typeof member>>) {
  if(identity&&(await q.query('SELECT 1 FROM sessions WHERE token_hash=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()',[identity.sessionHash,identity.userId])).rowCount!==1)orderAccessNotFound();
}
export async function quotePublicCart(pool:Pool,slug:string,input:wire.CartQuoteInput,access:BrowserAccess,options:HostedCheckoutOptions) {
  checkoutGate(options);
  if(input.delivery!==undefined)validateBuyerJSON(input.delivery,8192);
  await chargeCommerceBudgets(pool,access.network,{network:'cartNetwork',store:'cartStore',slug});
  return isolatedTransaction(pool,async q=>{
    await q.query('SET TRANSACTION READ ONLY');
    const store=await resolve(q,slug,options,true);
    const identity=await member(q,access.sessionToken,false);
    return cartQuote(q,store,input,options,Boolean(identity?.offlineEligible));
  });
}
export type PublicPurchaseState={open:false}|{open:true;product?:'available'|'sold_out'};
/** What B01/B03 may offer: the cart quote's own gates and, for a product page, the
 * quote's availability for one unit. Read only and without rate budgets; pages only. */
export async function publicPurchaseState(pool:Pool,slug:string,options:HostedCheckoutOptions,sku?:string):Promise<PublicPurchaseState> {
  const settings=options.settings??defaults;
  if(settings.quarantine||!settings.checkoutEnabled)return {open:false};
  return isolatedTransaction(pool,async q=>{
    await q.query('SET TRANSACTION READ ONLY');
    let store;
    try {store=await resolve(q,slug,options,true);}
    catch(error) {if(error instanceof Problem&&['checkout_store_not_found','checkout_not_enabled'].includes(error.code))return {open:false} as const;throw error;}
    if(sku===undefined)return {open:true} as const;
    const line=(await cartQuote(q,store,{publication_revision:store.projection.revision,lines:[{sku,quantity:1}]},options)).lines[0];
    return {open:true,product:line.state==='insufficient'||line.state==='unavailable'?'sold_out':'available'} as const;
  });
}

export async function createPublicCheckout(pool:Pool,slug:string,input:CheckoutInput,key:string,access:BrowserAccess,options:HostedCheckoutOptions) {
  checkoutGate(options);
  await chargeCommerceBudgets(pool,access.network,{network:'checkoutNetwork',store:'checkoutStore',slug});
  return isolatedTransaction(pool,async q=>{
    const identity=await member(q,access.sessionToken,true),store=await resolve(q,slug,options,true);
    // Serialize the replay lookup with the core's existing lifecycle/community
    // lock order, so concurrent requests return exactly one 201.
    await lockStore(q,store,input.lines.map(l=>l.sku));
    // Admission may be revoked while waiting for lifecycle locks. Re-read it
    // under those locks before any new checkout or receipt is written.
    requireCondition(await (options.admission??defaultAdmission).allowed(q,store),409,'checkout_not_enabled','尚未開放結帳。');
    const replay=(await q.query('SELECT 1 FROM commerce_checkout_idempotency_keys WHERE instance_id=$1 AND idempotency_key_sha256=$2',[store.instanceId,hashKey(key)])).rowCount===1;
    const saved=await freezeCheckout(q,store,{...input,idempotencyKey:key,...(identity?.principalId?{memberPrincipalId:identity.principalId}:{})},options);
    if(replay)requireCondition((await q.query(`SELECT 1 FROM commerce_checkouts ch WHERE ch.checkout_id=$1 AND ch.expires_at>clock_timestamp()
      AND NOT EXISTS(SELECT 1 FROM commerce_checkout_orders co WHERE co.checkout_id=ch.checkout_id)`,[saved.checkout_id])).rowCount===1,409,'checkout_expired','結帳已到期。');
    const ensured=await ensureDevice(q,access.deviceToken,options.origin);
    await grantDevice(q,ensured.device.device_id,{tenant_id:store.tenantId,instance_id:store.instanceId,checkout_id:saved.checkout_id});
    await assertDeviceLive(q,ensured.device.device_id);await currentMember(q,identity);
    return {created:!replay,cookie:ensured.cookie,value:wire.CheckoutResponseSchema.parse({checkout_ref:saved.checkout_id,terms:publicCheckoutTerms(saved.terms),terms_sha256:saved.terms_sha256,expires_at:saved.expires_at.toISOString()})};
  });
}
export async function placePublicOrder(pool:Pool,slug:string,checkoutRef:string,input:{terms_sha256:string;client_order_id:string;payment_method?:'immediate_card'|'bank_transfer'|'cash_on_meetup'},access:BrowserAccess,options:HostedCheckoutOptions) {
  checkoutGate(options);
  await chargeCommerceBudgets(pool,access.network,{network:'placementNetwork',store:'placementStore',slug});
  return isolatedTransaction(pool,async q=>{
    const identity=await member(q,access.sessionToken,true),store=await resolve(q,slug,options,true,true);
    if(!OpaqueId.safeParse(checkoutRef).success)orderAccessNotFound();
    const device=await liveDevice(q,access.deviceToken,true);
    if(!device||!await hasDeviceGrant(q,device.device_id,checkoutRef))orderAccessNotFound();
    const customer=(await q.query<{email_normalized:string}>(`SELECT c.email_normalized FROM commerce_checkouts ch JOIN commerce_customers c USING(customer_id)
      WHERE ch.checkout_id=$1 AND ch.tenant_id=$2 AND ch.instance_id=$3 AND c.redacted_at IS NULL`,[checkoutRef,store.tenantId,store.instanceId])).rows[0];
    if(!customer)orderAccessNotFound();
    const paymentMethod=input.payment_method??'immediate_card';
    if(paymentMethod!=='immediate_card'&&options.paymentMethods?.offlinePaymentRequiresMember!==false&&!identity?.principalId)throw new Problem(403,'offline_payment_requires_member','登入會員後才能選擇匯款或面交。');
    await lockOpenOrderBudgets(q,device!.device_id,customer.email_normalized,store.instanceId,paymentMethod==='immediate_card'?undefined:{principalId:identity?.principalId??null});
    const frozen=(await q.query('SELECT terms FROM commerce_checkouts WHERE checkout_id=$1 AND tenant_id=$2 AND instance_id=$3',[checkoutRef,store.tenantId,store.instanceId])).rows[0];
    if(!frozen)orderAccessNotFound();
    await lockStore(q,store,frozen.terms.items.map((l:{sku:string})=>l.sku));
    const replay=(await q.query(`SELECT 1 FROM commerce_checkout_orders co JOIN commerce_orders o USING(order_id)
      WHERE co.checkout_id=$1 AND o.client_order_id=$2`,[checkoutRef,input.client_order_id])).rowCount===1;
    const saved=await placeCheckoutOrder(q,store,{checkoutId:checkoutRef,termsSha256:input.terms_sha256,clientOrderId:input.client_order_id,
      buyerPrincipalId:identity?.principalId??null,environment:options.environment??'sandbox',paymentMethod},options);
    if(!replay){
      await enforceOpenOrderLimits(q,device!.device_id,customer.email_normalized,store,saved.order_id,paymentMethod==='immediate_card'?undefined:{principalId:identity?.principalId??null});
      await commerceRateLimitInTransaction(q,'newOrderNetwork',access.network);
    }
    const payment=paymentMethod==='immediate_card'?await options.payment?.issueHandoff(q,{store,orderId:saved.order_id})??null:null;
    // Access may expire while waiting on inventory, policy or issuance locks.
    if(!await hasDeviceGrant(q,device!.device_id,checkoutRef))orderAccessNotFound();
    await currentMember(q,identity);
    return {created:!replay,value:wire.PlaceOrderResponseSchema.parse({order:await publicOrder(q,store,saved.order_id,options.payment),payment})};
  });
}
export async function cancelPublicOrder(pool:Pool,slug:string,orderRef:string,access:BrowserAccess,options:HostedCheckoutOptions){
  quarantineGate(options);
  await chargeCommerceBudgets(pool,access.network,{network:'handoffNetwork'});
  return isolatedTransaction(pool,async q=>{
    const authorized=await authorizePublicOrder(q,slug,orderRef,access,options);
    await cancelUnpaidOrder(q,authorized.store,orderRef,'buyer','buyer_cancelled',{payment:options.payment});
    const value=await publicOrder(q,authorized.store,orderRef,options.payment);await authorized.recheck();return value;
  });
}
export async function readPublicOrder(pool:Pool,slug:string,orderRef:string,access:BrowserAccess,options:HostedCheckoutOptions) {
  return isolatedTransaction(pool,async q=>{
    const authorized=await authorizePublicOrder(q,slug,orderRef,access,options);
    const value=await publicOrder(q,authorized.store,orderRef,options.payment);await authorized.recheck();return value;
  });
}
/** Reads and handoff resumption use one buyer-access proof and decision-clock recheck. */
async function authorizePublicOrder(q:PoolClient,slug:string,orderRef:string,access:BrowserAccess,options:HostedCheckoutOptions){
  const identity=await member(q,access.sessionToken),store=await resolve(q,slug,options,false,true);
  if(!OpaqueId.safeParse(orderRef).success)orderAccessNotFound();
  const row=(await q.query<{checkout_id:string;buyer_principal_id:string|null}>(`SELECT co.checkout_id,o.buyer_principal_id FROM commerce_checkout_orders co JOIN commerce_orders o USING(order_id)
    WHERE co.order_id=$1 AND co.tenant_id=$2 AND co.instance_id=$3`,[orderRef,store.tenantId,store.instanceId])).rows[0];
  if(!row)orderAccessNotFound();
  const device=await liveDevice(q,access.deviceToken);
  const byMember=identity?.principalId!==null&&identity?.principalId!==undefined&&identity.principalId===row.buyer_principal_id;
  if(!byMember&&!(device&&await hasDeviceGrant(q,device.device_id,row.checkout_id,orderRef)))orderAccessNotFound();
  return {store,recheck:async()=>{
    if(byMember)await currentMember(q,identity);
    else if(!await hasDeviceGrant(q,device!.device_id,row.checkout_id,orderRef))orderAccessNotFound();
  }};
}
export async function resumePublicPayment(pool:Pool,slug:string,orderRef:string,access:BrowserAccess,options:HostedCheckoutOptions){
  checkoutGate(options);await chargeCommerceBudgets(pool,access.network,{network:'handoffNetwork'});
  if(options.paymentActions){
    const authorize=async(q:PoolClient)=>{const proof=await authorizePublicOrder(q,slug,orderRef,access,options);await proof.recheck();};
    const store=await isolatedTransaction(pool,async q=>{const proof=await authorizePublicOrder(q,slug,orderRef,access,options);await proof.recheck();return proof.store;});
    return wire.PaymentHandoffResponseSchema.parse(await options.paymentActions.resume(pool,{store,orderId:orderRef,network:access.network,authorize}));
  }
  return isolatedTransaction(pool,async q=>{
    const authorized=await authorizePublicOrder(q,slug,orderRef,access,options);
    const handoff=await options.payment?.issueHandoff(q,{store:authorized.store,orderId:orderRef})??null;
    await authorized.recheck();requireCondition(handoff,409,'payment_handoff_unavailable','目前無法繼續付款，請查看訂單狀態。');
    return wire.PaymentHandoffResponseSchema.parse(handoff);
  });
}
/** Access is proved before the order budget and again after applying provider
 * facts. Provider I/O belongs to the injected orchestrator, outside this client. */
export async function queryPublicPayment(pool:Pool,slug:string,orderRef:string,access:BrowserAccess,options:HostedCheckoutOptions){
  checkoutGate(options);await chargeCommerceBudgets(pool,access.network,{network:'paymentQueryNetwork'});
  const store=await isolatedTransaction(pool,async q=>{const proof=await authorizePublicOrder(q,slug,orderRef,access,options);await proof.recheck();return proof.store;});
  await chargePaymentQueryOrderBudgets(pool,orderRef);
  const authorize=async(q:PoolClient)=>{const proof=await authorizePublicOrder(q,slug,orderRef,access,options);await proof.recheck();};
  const result=await options.paymentActions?.query?.(pool,{store,orderId:orderRef,network:access.network,authorize});
  if(result==='query_in_progress')throw new Problem(409,'payment_result_pending','付款結果確認中，請稍後再查詢。');
  return readPublicOrder(pool,slug,orderRef,access,options);
}
export async function redeemPublicOrder(pool:Pool,slug:string,orderRef:string,token:string,access:BrowserAccess,options:HostedCheckoutOptions) {
  quarantineGate(options);
  await chargeCommerceBudgets(pool,access.network,{network:'redemptionNetwork'});
  return isolatedTransaction(pool,async q=>{
    const store=await resolve(q,slug,options,false,true);
    if(!OpaqueId.safeParse(orderRef).success)orderAccessNotFound();
    const redeemed=await redeemAccessLink(q,{tenant_id:store.tenantId,instance_id:store.instanceId,order_id:orderRef},token);
    const ensured=await ensureDevice(q,access.deviceToken,options.origin);
    await grantDevice(q,ensured.device.device_id,{tenant_id:store.tenantId,instance_id:store.instanceId,checkout_id:redeemed.checkout_id},orderRef);
    const value=await publicOrder(q,store,orderRef,options.payment);await assertDeviceLive(q,ensured.device.device_id);
    await assertAccessLinkLive(q,redeemed.grant_id);
    return {cookie:ensured.cookie,value};
  });
}
export async function requestPublicOrderAccess(pool:Pool,slug:string,input:{email:string;display_number:string},access:BrowserAccess,options:HostedCheckoutOptions):Promise<{emailId:string}|null> {
  quarantineGate(options);
  requireCondition(options.email,409,'order_access_email_unavailable','尚未提供訂單存取郵件。');
  const outbox=options.email,email=input.email.trim().toLowerCase();
  try {
    return await isolatedTransaction(pool,async q=>{
      await commerceRateLimitInTransaction(q,'accessRequestNetwork',access.network);
      await commerceRateLimitInTransaction(q,'accessRequestEmail',email);
      await commerceRateLimitInTransaction(q,'accessRequestGlobal','global');
      const store=await resolvePublicStorePage(q,slug);if(!store)return null;
      const target=(await q.query<{tenant_id:string;instance_id:string;checkout_id:string;order_id:string}>(`SELECT co.tenant_id,co.instance_id,co.checkout_id,co.order_id
        FROM commerce_checkout_orders co JOIN commerce_orders o USING(order_id) JOIN commerce_customers c USING(customer_id)
        JOIN commerce_checkout_contacts contact ON contact.contact_id=co.contact_id AND contact.checkout_id=co.checkout_id
        WHERE co.tenant_id=$1 AND co.instance_id=$2 AND co.display_number=$3 AND o.order_profile='hosted_checkout'
          AND c.email_normalized=$4 AND c.redacted_at IS NULL AND contact.redacted_at IS NULL`,[store.tenantId,store.instanceId,input.display_number,email])).rows[0];
      if(!target)return null;
      return outbox.queue(q,{template:'order_access',tenantId:target.tenant_id,instanceId:target.instance_id,orderId:target.order_id,accessRequestId:randomUUID()});
    });
  } catch(error) {if(error instanceof Problem&&error.code==='commerce_rate_limited')return null;throw error;}
}
export async function forgetPublicBrowser(pool:Pool,access:BrowserAccess,options:HostedCheckoutOptions) {
  quarantineGate(options);
  await isolatedTransaction(pool,q=>forgetDevice(q,access.deviceToken));
}
export const clearShopCookie=(options:HostedCheckoutOptions)=>shopCookie(options.origin,'',0);
