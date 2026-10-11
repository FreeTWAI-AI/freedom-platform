import {z} from 'zod';
import {HOSTED_ORDER_PROFILE, QuoteSchema, OrderSchema, OrderPageQuerySchema} from './hosted-order.js';
import {OpaqueId, Version} from './primitives.js';

/** Explicit opt-in profile; the original own-stock schemas remain unchanged. */
export const HOSTED_SHARED_ORDER_PROFILE = 'freedom.hosted-shared-order-reservation/v1' as const;
const profile = z.literal(HOSTED_SHARED_ORDER_PROFILE);
export const SharedQuoteSchema = z.object({...QuoteSchema.shape, profile}).strict().superRefine((value, context) => {
  const result = QuoteSchema.safeParse({...value, profile: HOSTED_ORDER_PROFILE});
  if (!result.success) for (const issue of result.error.issues) context.addIssue({code:'custom', path:issue.path, message:issue.message});
});
// Reuse all original totals, lifetime and terminal-state invariants, including
// strict unknown-field rejection. Only the profile discriminator differs.
export const SharedOrderSchema = z.discriminatedUnion('state', [
  OrderSchema.options[0].extend({profile}), OrderSchema.options[1].extend({profile}), OrderSchema.options[2].extend({profile}),
])
  .superRefine((value, context) => {
    const result = OrderSchema.safeParse({...value, profile: HOSTED_ORDER_PROFILE});
    if (!result.success) for (const issue of result.error.issues) context.addIssue({code:'custom', path:issue.path, message:issue.message});
  });
export const ReservationQuoteSchema = z.union([QuoteSchema, SharedQuoteSchema]);
export const ReservationOrderSchema = z.union([OrderSchema, SharedOrderSchema]);
export const ReservationPageSchema = z.object({items: z.array(ReservationOrderSchema).max(50),
  next_cursor: OrderPageQuerySchema.shape.cursor.unwrap().nullable()}).strict();
export type ReservationQuote = z.infer<typeof ReservationQuoteSchema>;
export type ReservationOrder = z.infer<typeof ReservationOrderSchema>;

export const ReservationSettingInputSchema = z.object({reservation_enabled: z.boolean()}).strict();
export const ReservationSettingSchema = z.object({reservation_enabled: z.boolean(), admission_enabled: z.boolean(), version: Version}).strict();

const sourceLine = z.object({product_id:OpaqueId,offer_id:OpaqueId,acceptance_id:OpaqueId,
  sku:QuoteSchema.shape.items.element.shape.sku,title:QuoteSchema.shape.items.element.shape.title,
  quantity:QuoteSchema.shape.items.element.shape.quantity,
  unit_supply_price_minor:z.number().int().min(1).max(100000000),
  supply_total_minor:z.number().int().min(1).max(9900000000)}).strict();
export const SupplierReservationSchema = z.object({profile:z.literal('freedom.hosted-supplier-reservations/v1'),order_id:OpaqueId,version:Version,
  store:QuoteSchema.shape.store,currency:QuoteSchema.shape.currency,items:z.array(sourceLine).min(1).max(50),
  state:z.enum(['reserved','cancelled','expired']),created_at:OrderSchema.options[0].shape.created_at,
  reservation_expires_at:OrderSchema.options[0].shape.reservation_expires_at,
  closed_at:OrderSchema.options[1].shape.closed_at.nullable(),
  payment_enabled:z.literal(false),fulfilment_enabled:z.literal(false),money_movement_enabled:z.literal(false),
}).strict().refine(value => value.items.every(line => line.supply_total_minor === line.quantity*line.unit_supply_price_minor),'Invalid supplied-line total.');
export const SupplierReservationPageSchema = z.object({items:z.array(SupplierReservationSchema).max(50),
  next_cursor:OrderPageQuerySchema.shape.cursor.unwrap().nullable()}).strict();
export type SupplierReservationPage = z.infer<typeof SupplierReservationPageSchema>;
