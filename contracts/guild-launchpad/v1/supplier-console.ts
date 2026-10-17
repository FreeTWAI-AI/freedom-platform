import {z} from 'zod';
import {OpaqueId, Version} from './primitives.js';
import {CurrencySchema, ProductViewSchema} from './storefront.js';
import {SupplyCatalogSetupInputSchema} from './hosted-supply-catalog.js';
import {SupplyTermsInputSchema, SupplyTermsSchema} from './hosted-supply-terms.js';
import {DistributionSchema, SupplyOfferSchema} from './hosted-distribution.js';
import {OrderPageQuerySchema} from './hosted-order.js';
import {SupplierReservationSchema} from './hosted-shared-order.js';

// Supplier console (R1) read profiles. Each response is one server read after the
// current tenant/instance authority. They project the existing commerce rows
// (items, own selections, hosted offers, seller selections, order lines); none is
// a second source of products, consent, stock or orders. Commands stay on the
// existing hosted routes, keys and versions.
const time = z.string().regex(new RegExp(z.regexes.datetime({precision: 3}).source.replace(/\\d/g, '[0-9]') + '(?![\\s\\S])'));
const count = z.number().int().min(0).max(1000000);
const digest = SupplyOfferSchema.shape.terms_sha256;

/** A metric is either an exact count from this read or explicitly unavailable to this caller. Never a guessed zero. */
export const SupplierMetricSchema = z.discriminatedUnion('state', [
  z.object({state: z.literal('ready'), count}).strict(),
  z.object({state: z.literal('unavailable'), reason: z.enum(['owner_required', 'store_write_required'])}).strict(),
]);
const todoProduct = {product_id: OpaqueId, title: ProductViewSchema.shape.title};
/** One actionable item. Request items name the seller shop by its stable ID, never by display name alone. */
export const SupplierTodoSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('request_pending'), selection_id: OpaqueId, ...todoProduct,
    partner_id: OpaqueId, partner_name: z.string()}).strict(),
  z.object({kind: z.literal('offer_outdated'), offer_id: OpaqueId, ...todoProduct}).strict(),
  z.object({kind: z.literal('out_of_stock'), ...todoProduct}).strict(),
  z.object({kind: z.literal('not_offered'), ...todoProduct}).strict(),
]);
export const SupplierTodosSchema = z.discriminatedUnion('state', [
  z.object({state: z.literal('ready'), items: z.array(SupplierTodoSchema).max(20), truncated: z.boolean()}).strict(),
  z.object({state: z.literal('unavailable'), reason: z.literal('store_write_required')}).strict(),
]);
export const SupplierOverviewSchema = z.object({
  profile: z.literal('freedom.supplier-console.overview/v1'),
  tenant_id: OpaqueId, instance_id: OpaqueId, as_of: time,
  metrics: z.object({
    /** Products whose current hosted offer is `offered`. */
    offered_products: SupplierMetricSchema,
    /** Seller proposals waiting for this supplier on a still-offered version. */
    pending_requests: SupplierMetricSchema,
    /** This supplier's lines in shared reservations still `reserved` and unexpired at `as_of`. Owner only. */
    active_reservation_lines: SupplierMetricSchema,
    /** Products with stock - reserved = 0. */
    out_of_stock_products: SupplierMetricSchema,
  }).strict(),
  /** Ordered: requests, outdated offers, out of stock, not offered. */
  todos: SupplierTodosSchema,
  product_count: count.max(200), product_limit: z.literal(200),
}).strict();

export const SupplierProductOfferSchema = z.object({
  offer_id: OpaqueId, version: Version, terms_sha256: digest,
  /** False when the product text or supply terms changed after this version was published. */
  matches_current_terms: z.boolean(),
}).strict();
/** Seller selections on this product's hosted offers, bucketed once. */
export const SupplierCooperationCountsSchema = z.object({
  awaiting: count, sellable: count, changes_requested: count, inactive: count,
}).strict();
export const SupplierProductSchema = z.object({
  product_id: OpaqueId, sku: ProductViewSchema.shape.sku, title: ProductViewSchema.shape.title,
  description: ProductViewSchema.shape.description, currency: CurrencySchema,
  /** Unit supply price; the legacy wire calls it cost_minor. It is not a manufacturing cost. */
  supply_price_minor: SupplyTermsInputSchema.shape.cost_minor,
  shipping_minor: SupplyTermsInputSchema.shape.shipping_minor,
  stock: SupplyTermsSchema.shape.stock, reserved: SupplyTermsSchema.shape.reserved, available: SupplyTermsSchema.shape.available,
  /** Product version used as If-Match by the existing supply-product, supply-terms and supply-offer commands. */
  version: Version,
  offer: SupplierProductOfferSchema.nullable(),
  cooperation: SupplierCooperationCountsSchema,
}).strict().refine(row => row.available === row.stock - row.reserved, 'available must equal stock minus reserved');
export const SupplierProductsSchema = z.object({
  profile: z.literal('freedom.supplier-console.products/v1'), as_of: time,
  /** The complete owned set; the hosted product limit keeps it at most 200. */
  items: z.array(SupplierProductSchema).max(200), limit: z.literal(200),
}).strict();

/** A seller selection on one of this product's offers, with the seller shop that made it. */
export const SupplierProductSelectionSchema = DistributionSchema.extend({
  /** Same stable seller shop ID as the partners read; same-name shops stay distinct. */
  partner_id: OpaqueId,
}).strict();
/** One product with its private terms, current offer and the seller selections on this product's offers. */
export const SupplierProductDetailSchema = z.object({
  profile: z.literal('freedom.supplier-console.product/v1'), as_of: time,
  product: SupplierProductSchema,
  shipping_terms: SupplyTermsInputSchema.shape.shipping_terms, return_terms: SupplyTermsInputSchema.shape.return_terms,
  /** The currently offered version with its frozen terms, or null when nothing is offered. */
  current_offer: SupplyOfferSchema.nullable(),
  selections: z.array(SupplierProductSelectionSchema).max(200), truncated: z.boolean(),
}).strict();

/** One seller request on this supplier's offers, read by its ID; no list cap applies. Version and listing digest
 * are the current row's, so a decision made from this read is checked against what the supplier saw. */
export const SupplierRequestDetailSchema = z.object({
  profile: z.literal('freedom.supplier-console.request/v1'), as_of: time,
  request: SupplierProductSelectionSchema,
  /** The product's current offer at as_of, to flag terms changed after this request's version was published. */
  product: z.object({product_id: OpaqueId, offer: SupplierProductOfferSchema.nullable()}).strict(),
}).strict();
export type SupplierRequestDetail = z.infer<typeof SupplierRequestDetailSchema>;

export const SupplierPartnerSchema = z.object({
  /** The seller's hosted retail shop. Stable; never derived from or grouped by its display name. */
  partner_id: OpaqueId, name: z.string(),
  cooperation: SupplierCooperationCountsSchema,
  products: count,
}).strict();
export const SupplierPartnersSchema = z.object({
  profile: z.literal('freedom.supplier-console.partners/v1'), as_of: time,
  items: z.array(SupplierPartnerSchema).max(200), truncated: z.boolean(),
}).strict();
export const SupplierPartnerDetailSchema = z.object({
  profile: z.literal('freedom.supplier-console.partner/v1'), as_of: time,
  partner: SupplierPartnerSchema,
  selections: z.array(DistributionSchema).max(200), truncated: z.boolean(),
}).strict();

/** Bounded supplier business details. Currency stays fixed once products and offers exist. */
export const SupplyProfileUpdateInputSchema = SupplyCatalogSetupInputSchema.pick({name: true, description: true}).partial().strict()
  .refine(value => Object.keys(value).length > 0, 'At least one field is required.');
export const SupplyProfileReceiptSchema = z.object({instance_id: OpaqueId, version: Version}).strict();

// S2 reservation reads: owner only, like the existing supplier list. Each read decides a reservation's state at
// its as_of, so one past its deadline is expired even before a later write settles it. Supply amounts are what the
// supplier would be owed for the units; they are not revenue, a payment or a commission.
const reservation = SupplierReservationSchema.shape;
const reservationState = reservation.state;
/** One shared reservation as this supplier sees it: only this supplier's lines, plus the seller shop's stable ID. */
export const SupplierConsoleReservationSchema = z.object({
  order_id: reservation.order_id, version: reservation.version,
  /** Same stable seller shop ID as the partners read; the store name and slug are for display only. */
  partner_id: OpaqueId, store: reservation.store, currency: reservation.currency, items: reservation.items,
  state: reservationState, created_at: reservation.created_at, reservation_expires_at: reservation.reservation_expires_at,
  closed_at: reservation.closed_at,
  payment_enabled: reservation.payment_enabled, fulfilment_enabled: reservation.fulfilment_enabled,
  money_movement_enabled: reservation.money_movement_enabled,
}).strict()
  .refine(value => value.items.every(line => line.supply_total_minor === line.quantity * line.unit_supply_price_minor), 'Invalid supplied-line total.')
  .refine(value => (value.state === 'reserved') === (value.closed_at === null), 'Only a reserved reservation is open.');
/** Optional filters. `from` and `to` bound created_at as [from, to). The cursor is bound to the exact filter. */
export const SupplierReservationQuerySchema = z.object({
  state: reservationState.optional(), partner_id: OpaqueId.optional(), product_id: OpaqueId.optional(),
  from: time.optional(), to: time.optional(),
  cursor: OrderPageQuerySchema.shape.cursor, limit: OrderPageQuerySchema.shape.limit,
}).strict().refine(value => value.from === undefined || value.to === undefined || Date.parse(value.from) < Date.parse(value.to),
  {message: 'from must be before to.', path: ['to']});
/** The filter a page answers, with every field present; null means not filtered. */
export const SupplierReservationFilterSchema = z.object({
  state: reservationState.nullable(), partner_id: OpaqueId.nullable(), product_id: OpaqueId.nullable(),
  from: time.nullable(), to: time.nullable(),
}).strict();
export const SupplierReservationsSchema = z.object({
  profile: z.literal('freedom.supplier-console.reservations/v1'), as_of: time,
  filter: SupplierReservationFilterSchema,
  /** Every matching reservation and this supplier's lines in them at as_of, across all pages, so a summary number can be
   * checked against the list. A product filter selects reservations; their other lines from this supplier still count. */
  totals: z.object({reservations: count, lines: count}).strict(),
  /** Newest first by created_at, then order ID. */
  items: z.array(SupplierConsoleReservationSchema).max(50),
  next_cursor: OrderPageQuerySchema.shape.cursor.unwrap().nullable(),
}).strict().refine(value => value.items.length <= value.totals.reservations, 'A page cannot exceed its totals.');
/** The published supply version a line was reserved against, as it stands at as_of. */
export const SupplierReservationOfferSchema = z.object({
  offer_id: OpaqueId, product_id: OpaqueId, terms_sha256: digest, state: SupplyOfferSchema.shape.state,
}).strict();
export const SupplierReservationDetailSchema = z.object({
  profile: z.literal('freedom.supplier-console.reservation/v1'), as_of: time,
  reservation: SupplierConsoleReservationSchema,
  offers: z.array(SupplierReservationOfferSchema).min(1).max(50),
}).strict().refine(value => {
  const ids = new Set(value.offers.map(offer => offer.offer_id));
  return ids.size === value.offers.length && value.reservation.items.every(line => ids.has(line.offer_id));
}, 'Each line needs its offer exactly once.');

// S2 recent changes: a bounded projection of this business's own transition journal. The journal keeps IDs and
// versions only, so titles and shop names are current ones, and a change shows neither who made it nor a decision's
// outcome. Retail store settings, seller-side commands and removed products are not part of this read. Retail product
// edits are, because they change the same item's text and stock. A publish at version 1 is the new supply version; a
// publish at a higher version is the earlier version being replaced by it.
const changeKinds = {
  'storefront.supply-catalog.setup': 'business', 'storefront.supply-profile.update': 'business',
  'storefront.reservations.configure': 'business',
  'storefront.supply-product.create': 'product', 'storefront.supply-product.update': 'product',
  'storefront.product.create': 'product', 'storefront.product.update': 'product',
  'storefront.supply-terms.update': 'product', 'storefront.product.photo.upload': 'product',
  'storefront.product.photo.remove': 'product',
  'storefront.supply-offer.publish': 'offer', 'storefront.supply-offer.withdraw': 'offer',
  'storefront.distribution.decide': 'request',
} as const;
export const SupplierChangeOperationSchema = z.enum(Object.keys(changeKinds) as [keyof typeof changeKinds, ...(keyof typeof changeKinds)[]]);
const changeProduct = {product_id: OpaqueId, title: ProductViewSchema.shape.title};
export const SupplierChangeSubjectSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('business')}).strict(),
  z.object({kind: z.literal('product'), ...changeProduct}).strict(),
  z.object({kind: z.literal('offer'), offer_id: OpaqueId, ...changeProduct}).strict(),
  z.object({kind: z.literal('request'), selection_id: OpaqueId, ...changeProduct, partner_id: OpaqueId, partner_name: z.string()}).strict(),
]);
export const SupplierChangeSchema = z.object({
  /** The journal transition ID. */
  change_id: OpaqueId, at: time, operation: SupplierChangeOperationSchema,
  /** The changed record's version after this change. */
  version: Version,
  subject: SupplierChangeSubjectSchema,
}).strict().refine(value => changeKinds[value.operation] === value.subject.kind, 'Operation and subject do not match.');
export const SupplierChangesQuerySchema = z.object({product_id: OpaqueId.optional()}).strict();
export const SupplierChangesSchema = z.object({
  profile: z.literal('freedom.supplier-console.changes/v1'), as_of: time,
  /** Set when the read is limited to one product: its own changes, its offers and requests on them. */
  product_id: OpaqueId.nullable(),
  /** Newest first. */
  items: z.array(SupplierChangeSchema).max(20), truncated: z.boolean(),
}).strict();

/** One supply catalog's to-dos for the guild block, by the overview's definitions at as_of. Read per catalog and never
 * summed across businesses; a caller without store:write gets unavailable, never zeros. */
export const SupplierSummarySchema = z.object({
  profile: z.literal('freedom.supplier-console.summary/v1'), tenant_id: OpaqueId, instance_id: OpaqueId, as_of: time,
  todos: z.discriminatedUnion('state', [
    z.object({state: z.literal('ready'), pending_requests: count, outdated_offers: count, out_of_stock_products: count}).strict(),
    z.object({state: z.literal('unavailable'), reason: z.literal('store_write_required')}).strict(),
  ]),
}).strict();

export type SupplierMetric = z.infer<typeof SupplierMetricSchema>;
export type SupplierOverview = z.infer<typeof SupplierOverviewSchema>;
export type SupplierProduct = z.infer<typeof SupplierProductSchema>;
export type SupplierProducts = z.infer<typeof SupplierProductsSchema>;
export type SupplierTodo = z.infer<typeof SupplierTodoSchema>;
export type SupplierProductSelection = z.infer<typeof SupplierProductSelectionSchema>;
export type SupplierProductDetail = z.infer<typeof SupplierProductDetailSchema>;
export type SupplierPartner = z.infer<typeof SupplierPartnerSchema>;
export type SupplierPartners = z.infer<typeof SupplierPartnersSchema>;
export type SupplierPartnerDetail = z.infer<typeof SupplierPartnerDetailSchema>;
export type SupplierConsoleReservation = z.infer<typeof SupplierConsoleReservationSchema>;
export type SupplierReservationQuery = z.infer<typeof SupplierReservationQuerySchema>;
export type SupplierReservationFilter = z.infer<typeof SupplierReservationFilterSchema>;
export type SupplierReservations = z.infer<typeof SupplierReservationsSchema>;
export type SupplierReservationDetail = z.infer<typeof SupplierReservationDetailSchema>;
export type SupplierChange = z.infer<typeof SupplierChangeSchema>;
export type SupplierChanges = z.infer<typeof SupplierChangesSchema>;
export type SupplierSummary = z.infer<typeof SupplierSummarySchema>;
