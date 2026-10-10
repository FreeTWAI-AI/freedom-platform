import { z } from 'zod';
import { OpaqueId, Version } from './primitives.js';
import { CurrencySchema, StoreSlugSchema } from './storefront.js';

/** HO-0 candidate only: parsing does not enable a route, release, grant or transaction. */
export const HOSTED_ORDER_PROFILE = 'freedom.hosted-direct-order-reservation/v1' as const;
const profile = z.literal(HOSTED_ORDER_PROFILE);
// Keep ISO calendar validation while matching the repository's ASCII wire grammar.
const time = z.string().regex(new RegExp(z.regexes.datetime({ precision: 3 }).source.replace(/\\d/g, '[0-9]') + '(?![\\s\\S])'));
const digest = z.string().length(64).regex(/^[a-f0-9]{64}$/);
const sku = z.string().max(32).regex(/^P[0-9]{4,}$(?![\s\S])/);
const quantity = z.number().int().min(1).max(99);
const money = z.number().int().min(1).max(100000000000);
const disabledEffects = {
  payment_enabled: z.literal(false), refund_enabled: z.literal(false),
  fulfilment_enabled: z.literal(false), money_movement_enabled: z.literal(false),
};
export const ReadinessSchema = z.discriminatedUnion('reservation_enabled', [
  z.object({ profile, reservation_enabled: z.literal(false), reason: z.enum([
    'not_implemented', 'not_configured', 'store_unavailable', 'publication_required',
  ]), ...disabledEffects }).strict(),
  z.object({ profile, reservation_enabled: z.literal(true), reason: z.null(), ...disabledEffects }).strict(),
]);
const requestedLine = z.object({ sku, quantity }).strict();
export const QuoteInputSchema = z.object({
  publication_revision: Version, items: z.array(requestedLine).min(1).max(50),
}).strict().refine(v => new Set(v.items.map(i => i.sku)).size === v.items.length, 'Duplicate SKU.');
const line = z.object({
  sku, title: z.string().min(1).max(120), quantity,
  unit_price_minor: z.number().int().min(1).max(100000000), line_total_minor: money,
}).strict();
const terms = {
  profile, store: z.object({ slug: StoreSlugSchema, name: z.string().min(1).max(80) }).strict(),
  publication_revision: Version, currency: CurrencySchema,
  items: z.array(line).min(1).max(50), merchandise_total_minor: money,
  // This amount is merchandise only, never a payable total including invented delivery/tax.
  amount_due_minor: z.null(), shipping_state: z.literal('not_configured'),
  tax_state: z.literal('not_assessed'), payment_state: z.literal('not_enabled'),
  terms_sha256: digest, ...disabledEffects,
};
function validTotals(v: { items: { sku: string; quantity: number; unit_price_minor: number; line_total_minor: number }[]; merchandise_total_minor: number }) {
  return new Set(v.items.map(i => i.sku)).size === v.items.length
    && v.items.every(i => i.line_total_minor === i.unit_price_minor * i.quantity)
    && v.merchandise_total_minor === v.items.reduce((n, i) => n + i.line_total_minor, 0);
}
export const QuoteSchema = z.object({
  ...terms, quote_id: OpaqueId, quoted_at: time, expires_at: time,
  reserves_stock: z.literal(false),
}).strict().refine(validTotals, 'Invalid quote totals or duplicate SKU.')
  .refine(v => Date.parse(v.expires_at) - Date.parse(v.quoted_at) === 300000, 'Quote lifetime must be five minutes.');
export const SubmitInputSchema = z.object({
  quote_id: OpaqueId, terms_sha256: digest,
  // Stable per-buyer intent ID; server derives namespaced commerce_orders.external_id.
  client_order_id: OpaqueId,
}).strict();
export const CancelInputSchema = z.object({}).strict();
export const IntentLookupQuerySchema = z.object({ store_slug: StoreSlugSchema }).strict();
const order = {
  ...terms, order_id: OpaqueId, client_order_id: OpaqueId, quote_id: OpaqueId,
  version: Version, created_at: time, reservation_expires_at: time,
};
export const OrderSchema = z.discriminatedUnion('state', [
  z.object({ ...order, state: z.literal('reserved'), closed_at: z.null(), close_reason: z.null() }).strict(),
  z.object({ ...order, state: z.literal('cancelled'), closed_at: time, close_reason: z.enum(['buyer_cancelled', 'seller_cancelled']) }).strict(),
  z.object({ ...order, state: z.literal('expired'), closed_at: time, close_reason: z.literal('reservation_expired') }).strict(),
]).refine(validTotals, 'Invalid order totals or duplicate SKU.')
  .refine(v => Date.parse(v.reservation_expires_at) - Date.parse(v.created_at) === 1800000, 'Reservation lifetime must be thirty minutes.')
  .refine(v => v.closed_at === null || Date.parse(v.closed_at) >= Date.parse(v.created_at), 'Closure cannot precede creation.')
  .refine(v => v.state !== 'expired' || Date.parse(v.closed_at) >= Date.parse(v.reservation_expires_at), 'Cannot expire early.')
  .refine(v => v.state !== 'cancelled' || Date.parse(v.closed_at) < Date.parse(v.reservation_expires_at), 'After deadline, expiry wins.');
const cursor = z.string().min(1).max(2048).regex(/^[A-Za-z0-9_.-]+$(?![\s\S])/);
export const OrderPageQuerySchema = z.object({ cursor: cursor.optional(), limit: z.number().int().min(1).max(50).optional() }).strict();
export const OrderPageSchema = z.object({ items: z.array(OrderSchema).max(50), next_cursor: cursor.nullable() }).strict();
export type HostedOrderQuote = z.infer<typeof QuoteSchema>;
export type HostedOrder = z.infer<typeof OrderSchema>;
export type HostedOrderPage = z.infer<typeof OrderPageSchema>;
