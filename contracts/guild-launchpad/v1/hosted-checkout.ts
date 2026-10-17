import {z} from 'zod';
import {OpaqueId,Version} from './primitives.js';
import {CurrencySchema,StoreSlugSchema} from './storefront.js';
// One shared text refinement: PostgreSQL cannot store NUL or lone surrogates.
export const checkoutTextPattern=/^[^\u0000\uD800-\uDFFF]*$(?![\s\S])/u;
export const isCheckoutText=(value:string)=>checkoutTextPattern.test(value);
const text=z.string().regex(checkoutTextPattern,'Invalid checkout text.');
export const CheckoutMoneySchema=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const money=CheckoutMoneySchema;
const sha=z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/);
export const CheckoutTimeSchema=z.string().regex(new RegExp(z.regexes.datetime({precision:3}).source.replace(/\\d/g,'[0-9]')+'(?![\\s\\S])'));
const time=CheckoutTimeSchema;
const sku=text.min(1).max(32);
const quantity=z.number().int().min(1).max(99);
export const ShippingMethodRefSchema=z.enum(['home','cvs:UNIMARTC2C','cvs:FAMIC2C','cvs:HILIFEC2C','meetup']);
export const DeliveryFieldErrorCodeSchema=z.enum(['required','format','too_short','too_long','unknown_postal_code','blocked_term']);
export const ShippingUnavailableReasonSchema=z.enum(['fulfilment_not_agreed','shipping_attributes_missing','method_unsupported','temperature_unsupported','too_large','cvs_value_limit','outlying_unsupported']);
/** Seller meetup note: trimmed, 1–200 code points, controls forbidden except LF. */
export const MeetupNoteSchema=z.string().trim().regex(/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF]){1,200}$(?![\s\S])/).regex(/^[^\u0000-\u0009\u000B-\u001F\u007F-\u009F]*$(?![\s\S])/);
const groupRef=z.string().regex(/^g(?:[1-9]|[1-4][0-9]|50)$(?![\s\S])/);
const logisticsServiceKey=z.enum(['ecpay.logistics.home.tcat','ecpay.logistics.home.post','ecpay.logistics.cvs.unimartc2c','ecpay.logistics.cvs.famic2c','ecpay.logistics.cvs.hilifec2c']);
const frozenLogistics=z.object({service_key:logisticsServiceKey,logistics_sub_type:z.enum(['TCAT','POST','UNIMARTC2C','FAMIC2C','HILIFEC2C']),ship_from_location_id:OpaqueId,temperature:z.literal('ambient'),handling_days:z.number().int().min(1).max(14),cutoff_time:z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$(?![\s\S])/),working_days:z.array(z.number().int().min(1).max(7)).min(1).max(7)}).strict();
const frozenParcel=z.object({parcel_ref:z.string().regex(/^g(?:[1-9]|[1-4][0-9]|50)-p[1-9][0-9]{0,3}$(?![\s\S])/),lines:z.array(z.object({sku,quantity}).strict()).min(1).max(50),weight_g:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),declared_value_minor:money}).strict();
const frozenGroup=z.object({group_ref:groupRef,supplier_shop_id:OpaqueId,method_ref:ShippingMethodRefSchema,fulfilment_mode:z.enum(['self','drop_ship']),agreement:z.object({agreement_id:OpaqueId,version:Version}).strict().nullable(),profile_version:Version,logistics:frozenLogistics.nullable(),meetup:z.object({note:MeetupNoteSchema}).strict().nullable(),parcels:z.array(frozenParcel).min(1).max(4950),attribute_versions:z.array(z.object({sku,version:Version}).strict()).max(50),fee_per_parcel_minor:money,outlying_surcharge_per_parcel_minor:money,amount_minor:money}).strict();
/** Frozen delivery terms. Invariants that relate groups to the quoted lines live in validateShippingQuote. */
export const CheckoutShippingSchema=z.object({delivery_profile_version:Version,destination_state:z.enum(['complete','store_required']),groups:z.array(frozenGroup).min(1).max(50)}).strict();
const publicGroup=z.object({group_ref:groupRef,method:ShippingMethodRefSchema,amount_minor:money,fee_per_parcel_minor:money,outlying_surcharge_per_parcel_minor:money,parcel_count:z.number().int().min(1).max(4950),handling_days:z.number().int().min(1).max(14).nullable(),items:z.array(z.object({sku,quantity}).strict()).min(1).max(50),meetup_note:MeetupNoteSchema.nullable()}).strict();
const publicShipping=z.object({destination_state:z.enum(['complete','store_required']),groups:z.array(publicGroup).min(1).max(50)}).strict();
const cartOutlying=z.discriminatedUnion('kind',[z.object({kind:z.literal('excluded')}).strict(),z.object({kind:z.literal('surcharge'),surcharge_per_parcel_minor:money}).strict()]);
/** available ⇔ no unavailable lines ⇔ both totals are present. */
export const CartDeliveryOptionSchema=z.object({method:ShippingMethodRefSchema,available:z.boolean(),shipping_total_minor:money.nullable(),parcel_count:z.number().int().nonnegative().max(4950).nullable(),free_over_minor:money.nullable(),outlying:cartOutlying.nullable(),note:MeetupNoteSchema.nullable(),lines:z.array(z.object({sku,reason:ShippingUnavailableReasonSchema}).strict()).max(50)}).strict().superRefine((value,ctx)=>{
  const both=value.shipping_total_minor!==null&&value.parcel_count!==null;
  const neither=value.shipping_total_minor===null&&value.parcel_count===null;
  if(!both&&!neither||value.available!==(value.lines.length===0)||(value.lines.length===0)!==both)ctx.addIssue({code:'custom',message:'Cart delivery option availability does not match its lines and totals.'});
});
const deliveryErrorPath=z.string().max(80).regex(/^delivery(?:\.(?:method|[A-Za-z_][A-Za-z0-9_]*))?$(?![\s\S])/);
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
/** Canonical order everywhere (EC-SPEC-11 §1). */
export const PAYMENT_METHODS=['immediate_card','bank_transfer','cash_on_meetup'] as const;
export const PaymentMethodSchema=z.enum(PAYMENT_METHODS);
const canonicalMethods=(methods:readonly string[])=>methods.every((m,i)=>i===0||PAYMENT_METHODS.indexOf(m as typeof PAYMENT_METHODS[number])>PAYMENT_METHODS.indexOf(methods[i-1] as typeof PAYMENT_METHODS[number]));
const paymentMethods=z.array(PaymentMethodSchema).min(1).max(3).refine(canonicalMethods,'Payment methods must be unique and in canonical order.');
export const OfflinePaymentTermsSchema=z.object({settings_version:Version,bank_transfer_deadline_days:z.number().int().min(1).max(7).nullable(),
  meetup_deadline_days:z.number().int().min(1).max(14).nullable()}).strict().refine(v=>v.bank_transfer_deadline_days!==null||v.meetup_deadline_days!==null,'An offline deadline is required.');
/** Each offline deadline is present exactly when its method is listed. */
const offlineTerms=(v:{payment_methods:readonly string[];offline_payment:{bank_transfer_deadline_days:number|null;meetup_deadline_days:number|null}|null})=>
  (v.offline_payment===null?!v.payment_methods.some(m=>m!=='immediate_card'):
    (v.offline_payment.bank_transfer_deadline_days!==null)===v.payment_methods.includes('bank_transfer')
    &&(v.offline_payment.meetup_deadline_days!==null)===v.payment_methods.includes('cash_on_meetup'));
export const CheckoutTermsSchema=z.object({profile:z.literal('freedom.checkout-terms/v1'),publication_revision:Version,publication_id:OpaqueId,currency:CurrencySchema,
  bindings:z.array(binding).min(1).max(50),items:z.array(line.extend({offer_sha256:sha.nullable()})).min(1).max(50),merchandise_total_minor:money,discount_total_minor:z.literal(0),discounts:z.array(z.never()).max(0),
  shipping:CheckoutShippingSchema,shipping_total_minor:money,tax_state:z.literal('not_assessed'),total_minor:money,
  consents:z.array(consent).max(20),payment_methods:paymentMethods,offline_payment:OfflinePaymentTermsSchema.nullable(),contact_sha256:sha}).strict().refine(offlineTerms,'Offline terms must match the listed methods.');
export const PublicCheckoutTermsSchema=z.object({publication_revision:Version,currency:CurrencySchema,
  items:z.array(line).min(1).max(50),merchandise_total_minor:money,discount_total_minor:z.literal(0),discounts:z.array(z.never()).max(0),
  shipping:publicShipping,
  shipping_total_minor:money,tax_state:z.literal('not_assessed'),total_minor:money,consents:z.array(consent).max(20),payment_methods:paymentMethods,
  offline_payment:OfflinePaymentTermsSchema.nullable(),
}).strict().refine(offlineTerms,'Offline terms must match the listed methods.');
export const CheckoutResponseSchema=z.object({checkout_ref:OpaqueId,terms:PublicCheckoutTermsSchema,terms_sha256:sha,expires_at:time}).strict();
const options=z.array(z.object({name:z.string(),value:z.string()}).strict());
const cartLine=z.object({sku,title:z.string().nullable(),options,unit_price_minor:money.nullable(),quantity,line_total_minor:money.nullable(),
  state:z.enum(['ok','insufficient','unavailable','revision_changed']),available:z.number().int().nonnegative().optional()}).strict();
const cartGroup=z.object({group_ref:groupRef,amount_minor:money}).strict();
export const CartQuoteResponseSchema=z.object({publication_revision:Version,currency:CurrencySchema,lines:z.array(cartLine).min(1).max(50),
  merchandise_total_minor:money,discounts:z.array(z.never()).max(0),delivery_options:z.array(CartDeliveryOptionSchema).max(5),shipping:z.discriminatedUnion('state',[
    z.object({state:z.literal('quoted'),method:ShippingMethodRefSchema,groups:z.array(cartGroup).min(1).max(50),total_minor:money}).strict(),
    z.object({state:z.literal('unavailable'),method:ShippingMethodRefSchema,groups:z.array(z.never()).max(0),total_minor:z.null(),lines:z.array(z.object({sku,reason:ShippingUnavailableReasonSchema}).strict()).min(1).max(50)}).strict(),
    z.object({state:z.enum(['needs_delivery_data','not_configured']),groups:z.array(z.never()).max(0),total_minor:z.null()}).strict(),
  ]),total_minor:money.nullable(),payment_options:z.array(z.object({method:PaymentMethodSchema,available:z.boolean(),
    reason:z.enum(['payment_profile_unavailable','meetup_required','member_required']).nullable()}).strict()
    .refine(v=>(v.reason===null)===v.available,'Unavailable options carry a reason.')).max(3)
    .refine(options=>canonicalMethods(options.map(o=>o.method)),'Payment options must be unique and in canonical order.')}).strict();
export const PaymentOptionSchema=CartQuoteResponseSchema.shape.payment_options.element;
export const PlaceOrderInputSchema=z.object({terms_sha256:sha,client_order_id:OpaqueId,payment_method:PaymentMethodSchema.optional()}).strict();
export const OfflineInstructionsSchema=z.object({bank_code:z.string().regex(/^[0-9]{3}$(?![\s\S])/),bank_name:text.min(1).max(20),branch_name:text.min(1).max(20).nullable(),
  account_number:z.string().regex(/^[0-9]{6,16}$(?![\s\S])/),account_name:text.min(1).max(40),note:text.min(1).max(200).nullable(),amount_minor:money,pay_by:time}).strict();
export const PublicOrderSchema=z.object({order_ref:OpaqueId,display_number:z.string().regex(/^[0-9]{6}-[0-9A-HJKMNP-TV-Z]{6}$(?![\s\S])/),
  store:z.object({slug:StoreSlugSchema,name:z.string().min(1).max(80)}).strict(),created_at:time,pay_by:time,reservation_expired:z.boolean(),
  lifecycle_state:z.enum(['open','cancelled','closed']),cancel_reason:z.enum(['buyer_cancelled','seller_cancelled','payment_not_completed','paid_cancelled']).nullable(),currency:CurrencySchema,
  lines:z.array(line.extend({options})).min(1).max(50),merchandise_total_minor:money,discount_total_minor:money,shipping_total_minor:money,total_minor:money,
  payment_state:z.enum(['unpaid','pending','simulated','confirmed','overpaid','refunded']),
  payment_method:PaymentMethodSchema,payment_grace_until:time.nullable(),offline_instructions:OfflineInstructionsSchema.nullable(),
  /** Frozen public meetup notes; optional for older order response producers. */
  meetup_notes:z.array(MeetupNoteSchema).max(50).optional(),
  latest_payment_attempt:z.object({attempt_ref:OpaqueId,state:z.enum(['ready','awaiting_result','paid','failed','expired']),created_at:time}).strict().nullable(),can_resume_payment:z.boolean(),contact:contact.nullable(),delivery:object.nullable(),invoice:object.nullable(),redacted:z.boolean(),
}).strict().refine(v=>v.redacted? v.contact===null&&v.delivery===null&&v.invoice===null:v.contact!==null&&v.delivery!==null,'Invalid redaction projection.')
  .refine(v=>(v.payment_grace_until!==null)===(v.payment_method!=='immediate_card'),'Grace follows the payment method.')
  .refine(v=>{
    const paid=['confirmed','simulated','overpaid','refunded'].includes(v.payment_state);
    return (v.offline_instructions!==null)===(v.payment_method==='bank_transfer'&&v.lifecycle_state==='open'&&!paid);
  },'Instructions follow an open unpaid bank transfer.');
export const PaymentHandoffResponseSchema=z.object({handoff_url:z.string().regex(/^\/pay\/ecpay\/[A-Za-z0-9_-]{43}$(?![\s\S])/),attempt_ref:OpaqueId,expires_at:time}).strict();
export const PaymentHandoffInputSchema=z.object({}).strict();
export const PaymentQueryInputSchema=z.object({}).strict();
export const PaymentQueryResponseSchema=PublicOrderSchema;
export const PlaceOrderResponseSchema=z.object({order:PublicOrderSchema,payment:PaymentHandoffResponseSchema.nullable()}).strict();
export const RedeemAccessInputSchema=z.object({token:text.max(256)}).strict();
export const AccessRequestInputSchema=z.object({email:text.min(1).max(512),display_number:text.max(80)}).strict();
export const ForgetAccessInputSchema=z.object({}).strict();
// 202/204 intentionally have no JSON representation.
export const EmptyResponseSchema=z.undefined();
export const CheckoutErrorCodeSchema=z.enum(['commerce_quarantined','checkout_not_enabled','checkout_store_not_found','checkout_not_found','checkout_order_not_found',
  'invalid_idempotency_key','checkout_idempotency_conflict','order_intent_conflict','consents_mismatch','terms_changed','stock_unavailable','unresolved_order','checkout_expired',
  'too_many_open_orders','commerce_rate_limited','order_access_email_unavailable','validation_failed','invalid_checkout_json','checkout_contact_too_large','checkout_contact_unavailable',
  'shipping_not_configured','shipping_unavailable','delivery_invalid','delivery_store_required','checkout_total_invalid','storefront_unavailable','storefront_not_set_up','supply_unavailable','publication_changed','display_number_unavailable','credential_kind_rejected',
  'payment_profile_unavailable','payment_method_unavailable','offline_payment_requires_member','offline_order_limit','payment_handoff_unavailable','checkout_order_closed','checkout_hold_expired','payment_already_applied','payment_attempts_exhausted',
  'payment_result_pending','internal_error','invalid_json','origin_rejected','host_rejected','json_required','body_too_large']);
// payment_result_pending includes Retry-After when the 60-second handoff delay
// determines a next allowed time. Rate-limit responses also carry Retry-After.
export const CheckoutErrorSchema=z.object({type:z.string(),title:z.string(),status:z.number().int(),code:CheckoutErrorCodeSchema,detail:z.string(),
  items:z.array(z.object({sku,available:z.number().int().nonnegative()}).strict()).optional(),order_ref:OpaqueId.optional(),
  fields:z.array(z.object({path:deliveryErrorPath,code:DeliveryFieldErrorCodeSchema}).strict()).min(1).max(20).optional(),
  lines:z.array(z.object({sku,reason:ShippingUnavailableReasonSchema}).strict()).min(1).max(50).optional()}).strict();
export type PublicOrder=z.infer<typeof PublicOrderSchema>;
export type CartQuoteInput=z.infer<typeof CartQuoteInputSchema>;
export type CheckoutShipping=z.infer<typeof CheckoutShippingSchema>;
export type ShippingMethodRef=z.infer<typeof ShippingMethodRefSchema>;
export type DeliveryFieldErrorCode=z.infer<typeof DeliveryFieldErrorCodeSchema>;
export type ShippingUnavailableReason=z.infer<typeof ShippingUnavailableReasonSchema>;
