import {z} from 'zod';
import {OpaqueId,Version} from './primitives.js';
import {CurrencySchema,StoreSlugSchema} from './storefront.js';
// One shared text refinement: PostgreSQL cannot store NUL or lone surrogates.
export const checkoutTextPattern=/^[^\u0000\uD800-\uDFFF]*$(?![\s\S])/u;
export const isCheckoutText=(value:string)=>checkoutTextPattern.test(value);
const text=z.string().regex(checkoutTextPattern,'Invalid checkout text.');
const money=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sha=z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/);
const time=z.string().regex(new RegExp(z.regexes.datetime({precision:3}).source.replace(/\\d/g,'[0-9]')+'(?![\\s\\S])'));
const sku=text.min(1).max(32);
const quantity=z.number().int().min(1).max(99);
const object=z.record(text,z.unknown()).refine(value=>{
  const pending:unknown[]=[value];
  while(pending.length) {
    const next=pending.pop();
    if(typeof next==='string'&&!isCheckoutText(next))return false;
    if(next!==null&&typeof next==='object')for(const [key,child] of Object.entries(next)) {
      if(!isCheckoutText(key))return false;
      pending.push(child);
    }
  }
  return true;
},'Invalid checkout text.');
const contact=z.object({name:text.min(1).max(120),email:text.min(1).max(254),phone:text.min(1).max(40)}).strict();
const consent=z.object({policy_kind:z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$(?![\s\S])/),policy_version_id:OpaqueId}).strict();
const requestedLine=z.object({sku,quantity,
  // Untrusted display prices are accepted only as inert cart hints. The binding
  // resolver always prices the current publication and never reads these values.
  unit_price_minor:money.optional(),line_total_minor:money.optional(),price_minor:money.optional(),
}).strict();
const unique=(v:{lines:{sku:string}[]})=>new Set(v.lines.map(l=>l.sku)).size===v.lines.length;
export const CartQuoteInputSchema=z.object({publication_revision:Version,lines:z.array(requestedLine).min(1).max(50),delivery:object.optional()}).strict().refine(unique,'Duplicate SKU.');
export const CheckoutInputSchema=z.object({publication_revision:Version,lines:z.array(requestedLine).min(1).max(50),contact,delivery:object,invoice:object.nullable().optional(),consents:z.array(consent).max(20).optional()}).strict().refine(unique,'Duplicate SKU.');
const line=z.object({sku,title:z.string().min(1).max(120),quantity,unit_price_minor:money,line_total_minor:money}).strict();
const binding=z.object({selection_id:OpaqueId,item_id:OpaqueId,version:Version,sku,quantity,supplier_shop_id:OpaqueId,supplier_instance_id:OpaqueId,
  offer_id:OpaqueId.nullable(),offer_sha256:sha.nullable(),acceptance_id:OpaqueId.nullable(),listing_sha256:sha.nullable(),unit_price_minor:money}).strict();
const shippingGroup=z.object({group_ref:z.string().min(1).max(80),supplier_shop_id:OpaqueId,method_ref:z.string().min(1).max(80),amount_minor:money}).strict();
export const CheckoutTermsSchema=z.object({profile:z.literal('freedom.checkout-terms/v1'),publication_revision:Version,publication_id:OpaqueId,currency:CurrencySchema,
  bindings:z.array(binding).min(1).max(50),items:z.array(line.extend({offer_sha256:sha.nullable()})).min(1).max(50),merchandise_total_minor:money,discount_total_minor:z.literal(0),discounts:z.array(z.never()).max(0),
  shipping:z.object({groups:z.array(shippingGroup).min(1).max(50)}).strict(),shipping_total_minor:money,tax_state:z.literal('not_assessed'),total_minor:money,
  consents:z.array(consent).max(20),payment_methods:z.array(z.literal('immediate_card')).length(1),contact_sha256:sha}).strict();
export const PublicCheckoutTermsSchema=z.object({publication_revision:Version,currency:CurrencySchema,
  items:z.array(line).min(1).max(50),merchandise_total_minor:money,discount_total_minor:z.literal(0),discounts:z.array(z.never()).max(0),
  shipping:z.object({groups:z.array(z.object({group_ref:text.min(1).max(80),amount_minor:money}).strict()).min(1).max(50)}).strict(),
  shipping_total_minor:money,tax_state:z.literal('not_assessed'),total_minor:money,consents:z.array(consent).max(20),payment_methods:z.array(z.literal('immediate_card')).length(1),
}).strict();
export const CheckoutResponseSchema=z.object({checkout_ref:OpaqueId,terms:PublicCheckoutTermsSchema,terms_sha256:sha,expires_at:time}).strict();
const options=z.array(z.object({name:z.string(),value:z.string()}).strict());
const cartLine=z.object({sku,title:z.string().nullable(),options,unit_price_minor:money.nullable(),quantity,line_total_minor:money.nullable(),
  state:z.enum(['ok','insufficient','unavailable','revision_changed']),available:z.number().int().nonnegative().optional()}).strict();
const publicGroup=z.object({group_ref:z.string(),amount_minor:money}).strict();
export const CartQuoteResponseSchema=z.object({publication_revision:Version,currency:CurrencySchema,lines:z.array(cartLine).min(1).max(50),
  merchandise_total_minor:money,discounts:z.array(z.never()).max(0),shipping:z.discriminatedUnion('state',[
    z.object({state:z.literal('quoted'),groups:z.array(publicGroup),total_minor:money}).strict(),
    z.object({state:z.enum(['needs_delivery_data','not_configured']),groups:z.array(z.never()).max(0),total_minor:z.null()}).strict(),
  ]),total_minor:money.nullable()}).strict();
export const PlaceOrderInputSchema=z.object({terms_sha256:sha,client_order_id:OpaqueId}).strict();
export const PublicOrderSchema=z.object({order_ref:OpaqueId,display_number:z.string().regex(/^[0-9]{6}-[0-9A-HJKMNP-TV-Z]{6}$(?![\s\S])/),
  store:z.object({slug:StoreSlugSchema,name:z.string().min(1).max(80)}).strict(),created_at:time,pay_by:time,reservation_expired:z.boolean(),
  lifecycle_state:z.enum(['open','cancelled','closed']),cancel_reason:z.enum(['buyer_cancelled','seller_cancelled','payment_not_completed','paid_cancelled']).nullable(),currency:CurrencySchema,
  lines:z.array(line.extend({options})).min(1).max(50),merchandise_total_minor:money,discount_total_minor:money,shipping_total_minor:money,total_minor:money,
  payment_state:z.enum(['unpaid','confirmed']),contact:contact.nullable(),delivery:object.nullable(),invoice:object.nullable(),redacted:z.boolean(),
}).strict().refine(v=>v.redacted? v.contact===null&&v.delivery===null&&v.invoice===null:v.contact!==null&&v.delivery!==null,'Invalid redaction projection.');
export const PlaceOrderResponseSchema=z.object({order:PublicOrderSchema,payment:z.null()}).strict();
export const RedeemAccessInputSchema=z.object({token:text.max(256)}).strict();
export const AccessRequestInputSchema=z.object({email:text.min(1).max(512),display_number:text.max(80)}).strict();
export const ForgetAccessInputSchema=z.object({}).strict();
// 202/204 intentionally have no JSON representation.
export const EmptyResponseSchema=z.undefined();
export const CheckoutErrorCodeSchema=z.enum(['commerce_quarantined','checkout_not_enabled','checkout_store_not_found','checkout_not_found','checkout_order_not_found',
  'invalid_idempotency_key','checkout_idempotency_conflict','order_intent_conflict','consents_mismatch','terms_changed','stock_unavailable','unresolved_order','checkout_expired',
  'too_many_open_orders','commerce_rate_limited','order_access_email_unavailable','validation_failed','invalid_checkout_json','checkout_contact_too_large','checkout_contact_unavailable',
  'shipping_not_configured','shipping_unavailable','checkout_total_invalid','storefront_unavailable','storefront_not_set_up','supply_unavailable','publication_changed','display_number_unavailable','credential_kind_rejected',
  'internal_error','invalid_json','origin_rejected','host_rejected','json_required','body_too_large']);
export const CheckoutErrorSchema=z.object({type:z.string(),title:z.string(),status:z.number().int(),code:CheckoutErrorCodeSchema,detail:z.string(),
  items:z.array(z.object({sku,available:z.number().int().nonnegative()}).strict()).optional(),order_ref:OpaqueId.optional()}).strict();
export type PublicOrder=z.infer<typeof PublicOrderSchema>;
export type CartQuoteInput=z.infer<typeof CartQuoteInputSchema>;
