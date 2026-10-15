import {z} from 'zod';
import {OpaqueId, Version} from './primitives.js';
import {CurrencySchema, ProductViewSchema} from './storefront.js';
import {SupplyCatalogSetupInputSchema} from './hosted-supply-catalog.js';
import {SupplyTermsInputSchema, SupplyTermsSchema} from './hosted-supply-terms.js';
import {DistributionSchema, SupplyOfferSchema} from './hosted-distribution.js';

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
