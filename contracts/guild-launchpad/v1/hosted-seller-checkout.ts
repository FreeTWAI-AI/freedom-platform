import {z} from 'zod';
import {OpaqueId,Version} from './primitives.js';
import {CurrencySchema} from './storefront.js';
import {PublicOrderSchema,CheckoutMoneySchema,CheckoutTimeSchema,checkoutTextPattern} from './hosted-checkout.js';
const money=CheckoutMoneySchema,time=CheckoutTimeSchema,integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),text=z.string().regex(checkoutTextPattern);
const display=PublicOrderSchema.shape.display_number,cursor=z.string().max(512).nullable();
export const SellerPaymentStateSchema=z.enum(['unpaid','pending','simulated','confirmed','overpaid','refunded']);
export const SellerInventoryStateSchema=z.enum(['held','hold_expired','allocated','partially_shipped','shipped','released','unallocated']);
export const SellerCustomerSchema=z.object({name_masked:text.min(1).max(8).nullable(),contact_redacted:z.boolean()}).strict()
  .refine(v=>(v.name_masked===null)===v.contact_redacted,'Invalid redaction projection.');
export const SellerCheckoutOrderSummarySchema=z.object({order_ref:OpaqueId,display_number:display,environment:z.enum(['sandbox','live']),created_at:time,pay_by:time,
  lifecycle_state:PublicOrderSchema.shape.lifecycle_state,cancel_reason:PublicOrderSchema.shape.cancel_reason,currency:CurrencySchema,total_minor:money,quantity_total:integer.min(1),
  customer:SellerCustomerSchema,payment_state:SellerPaymentStateSchema,inventory_state:SellerInventoryStateSchema,open_exception_count:integer,version:Version}).strict();
export const SellerCheckoutOrderPageSchema=z.object({items:z.array(SellerCheckoutOrderSummarySchema).max(50),next_cursor:cursor}).strict();
export const SellerOrderLineSchema=z.object({sku:text.min(1).max(32),title:text.min(1).max(120),quantity:integer.min(1),unit_price_minor:money,line_total_minor:money,
  inventory:z.object({held:integer,allocated:integer,shipped:integer,released:integer}).strict()}).strict();
export const SellerPaymentAttemptSchema=z.object({attempt_ref:OpaqueId,sequence:integer.min(1),state:z.enum(['issued','paid','confirmed','failed','superseded','expired_unpaid']),
  amount_minor:money,currency:CurrencySchema,merchant_trade_no:text.min(1).max(20),trade_no:text.min(1).max(20).nullable(),payment_type:text.min(1).max(40).nullable(),payment_date:time.nullable(),charge_fee_minor:money.nullable(),
  created_at:time,handed_off_at:time.nullable(),paid_at:time.nullable(),confirmed_at:time.nullable(),failed_at:time.nullable(),superseded_at:time.nullable(),expired_at:time.nullable()}).strict();
export const SellerPaymentApplicationSchema=z.object({application_ref:OpaqueId,attempt_ref:OpaqueId.nullable(),amount_minor:money,currency:CurrencySchema,
  outcome:z.enum(['converted','allocated','unallocatable','after_cancel','overpaid','amount_mismatch','simulated']),created_at:time,refunded_minor:money,refundable_minor:money}).strict();
export function isSellerCalendarDate(value:string) {
  return /^[0-9]{4}-[0-9]{2}-[0-9]{2}$(?![\s\S])/.test(value)&&value.slice(0,4)!=='0000'&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
}
export const SellerDateSchema=z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$(?![\s\S])/).refine(isSellerCalendarDate,'Invalid calendar date.');
export const SellerProviderReferenceSchema=z.string().regex(/^[A-Za-z0-9_-]{1,64}$(?![\s\S])/);
export const SellerRefundSchema=z.object({refund_ref:OpaqueId,application_ref:OpaqueId,attempt_ref:OpaqueId,amount_minor:money.positive(),currency:CurrencySchema,refunded_on:SellerDateSchema,
  provider_reference:SellerProviderReferenceSchema.nullable(),basis:z.literal('unapplied_payment'),mode:z.literal('manual_record'),state:z.literal('recorded'),recorded_without_provider:z.boolean(),recorded_by:OpaqueId,created_at:time}).strict();
export const ExceptionCaseViewSchema=z.object({case_ref:OpaqueId,kind:z.enum(['amount_mismatch','paid_after_cancel','overpaid','paid_unallocatable','payment_unconfirmed','unmatched_payment','contradicting_event']),
  status:z.enum(['open','resolved','dismissed']),responsible_party:z.literal('retailer'),order:z.object({order_ref:OpaqueId,display_number:display}).strict().nullable(),
  subject:z.object({kind:z.enum(['payment_attempt','payment_event']),ref:OpaqueId}).strict(),next_action:z.enum(['refund_payment','allocate_or_refund','check_with_provider','contact_provider']),due_at:time,opened_at:time,updated_at:time,
  resolution:z.object({code:z.enum(['refunded','allocated','confirmed','checked_with_provider']),note:text.min(1).max(1000),resolved_by:OpaqueId}).strict().nullable(),
  payment_facts:z.object({merchant_trade_no:text.nullable(),trade_no:text.nullable(),expected_amount_minor:money.nullable(),paid_amount_minor:money.nullable(),currency:CurrencySchema,payment_date:time.nullable(),payment_type:text.nullable()}).strict().nullable(),
  allowed_actions:z.array(z.enum(['resolve_with_evidence','retry_allocation'])).max(2),resolution_codes:z.array(z.enum(['refunded','confirmed','checked_with_provider'])).max(3),version:Version}).strict();
export const ExceptionCasePageSchema=z.object({items:z.array(ExceptionCaseViewSchema).max(50),next_cursor:cursor}).strict();
export const SellerCheckoutOrderSchema=SellerCheckoutOrderSummarySchema.extend({lines:z.array(SellerOrderLineSchema).min(1).max(50),merchandise_total_minor:money,discount_total_minor:money,shipping_total_minor:money,
  latest_payment_attempt:PublicOrderSchema.shape.latest_payment_attempt,payment_detail:z.object({attempts:z.array(SellerPaymentAttemptSchema),applications:z.array(SellerPaymentApplicationSchema),refunds:z.array(SellerRefundSchema)}).strict().nullable(),
  exceptions:z.array(ExceptionCaseViewSchema),actions:z.object({cancel:z.boolean(),query_payment:z.boolean(),record_refund:z.boolean(),view_contact:z.boolean(),view_finance:z.boolean()}).strict()}).strict();
export const SellerOrderContactSchema=z.object({order_ref:OpaqueId,contact_redacted:z.boolean(),contact:PublicOrderSchema.shape.contact,delivery:PublicOrderSchema.shape.delivery,invoice:PublicOrderSchema.shape.invoice}).strict()
  .refine(v=>v.contact_redacted?v.contact===null&&v.delivery===null&&v.invoice===null:v.contact!==null&&v.delivery!==null,'Invalid redaction projection.');
export const SellerCheckoutEmptyInputSchema=z.object({}).strict();
export const ResolveWithEvidenceInputSchema=z.discriminatedUnion('code',[
  z.object({code:z.literal('confirmed')}).strict(),
  z.object({code:z.literal('refunded'),provider_date:SellerDateSchema,provider_reference:SellerProviderReferenceSchema}).strict(),
  z.object({code:z.literal('checked_with_provider'),provider_date:SellerDateSchema,provider_reference:SellerProviderReferenceSchema}).strict(),
]);
export const RetryAllocationInputSchema=SellerCheckoutEmptyInputSchema;
export const ManualRefundInputSchema=z.object({application_ref:OpaqueId,amount_minor:integer.refine(v=>!Object.is(v,-0)),refunded_on:SellerDateSchema,provider_reference:SellerProviderReferenceSchema.optional()}).strict();
export const SellerRefundListSchema=z.object({items:z.array(SellerRefundSchema).max(100)}).strict();
// Documented codes are an aid to consumers, never a closed runtime error gate.
export const SellerCheckoutErrorCodeSchema=z.enum(['not_found','capability_denied','tenant_not_found','tenant_capability_denied','principal_disabled','session_expired','resource_scope_unavailable',
  'checkout_order_not_found','exception_case_not_found','commerce_quarantined','commerce_rate_limited','storefront_not_set_up','storefront_unavailable','validation_failed','invalid_json','invalid_cursor','tenant_cursor_unavailable',
  'version_required','version_conflict','invalid_version','idempotency_required','idempotency_conflict','invalid_idempotency_key','invalid_expected_version','receipt_reference_invalid',
  'payment_already_applied','checkout_order_closed','payment_result_pending','resolution_code_invalid','exception_action_unavailable','payment_not_confirmed','stock_unavailable','allocation_retry_unavailable','reservation_inconsistent',
  'refund_not_available','refund_exceeds_payment','refund_date_invalid','invalid_scoped_command','invalid_operation','invalid_target','origin_rejected','host_rejected','json_required','body_too_large','credential_kind_rejected','internal_error']);
export type SellerCheckoutOrder=z.infer<typeof SellerCheckoutOrderSchema>;
export type SellerCheckoutOrderSummary=z.infer<typeof SellerCheckoutOrderSummarySchema>;
export type ExceptionCaseView=z.infer<typeof ExceptionCaseViewSchema>;
export type SellerRefund=z.infer<typeof SellerRefundSchema>;
