import {z} from 'zod';
import {OpaqueId, Version, NonNegativeDecimal, NON_NEGATIVE_DECIMAL_PATTERN} from './primitives.js';
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

// S3 operations report (SC-10). One statement decides every number at as_of. Products and cooperation are their state
// at as_of; only the reservation part depends on the period: reservations created on the given Asia/Taipei calendar
// days (both included) that hold lines of this supplier, each in its state at as_of as the reservations read decides
// it. Supply amounts are what the supplier would be owed for the units; they are not revenue, an invoice, a payment or
// a commission. A report whose CSV would have more than SUPPLIER_REPORT_MAX_ROWS data rows is refused, never cut short.
export const SUPPLIER_REPORT_MAX_DAYS = 366;
export const SUPPLIER_REPORT_MAX_ROWS = 10000;
const reportDay = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/).refine(value => {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 2000 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}, 'Invalid calendar date.');
const dayNumber = (value: string) => Date.parse(`${value}T00:00:00Z`) / 86400000;
/** Taiwan has kept UTC+8 without daylight saving since 1979, so a Taipei calendar day starts at 00:00+08:00. */
const taipeiMidnight = (value: string) => Date.parse(`${value}T00:00:00+08:00`);
/** Both days are Asia/Taipei calendar days and both are included: at most SUPPLIER_REPORT_MAX_DAYS days. */
export const SupplierReportQuerySchema = z.object({from: reportDay, to: reportDay}).strict()
  .refine(value => dayNumber(value.from) <= dayNumber(value.to), {message: 'from must not be after to.', path: ['to']})
  .refine(value => dayNumber(value.to) - dayNumber(value.from) < SUPPLIER_REPORT_MAX_DAYS,
    {message: 'The period is at most 366 days.', path: ['to']});
const amount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** This supplier's lines in the period's reservations that are in one state at as_of. */
export const SupplierReportReservationsSchema = z.object({
  reservations: count, lines: count, quantity: amount,
  /** Sum of quantity × unit supply price (cost_minor of the reserved offer version), in the business currency. */
  supply_total_minor: amount,
}).strict();
export const SupplierReportSchema = z.object({
  profile: z.literal('freedom.supplier-console.report/v1'), tenant_id: OpaqueId, instance_id: OpaqueId, as_of: time,
  business: z.object({name: z.string(), currency: CurrencySchema}).strict(),
  period: z.object({from: reportDay, to: reportDay, time_zone: z.literal('Asia/Taipei'),
    /** The same period as instants, [start, end): Taipei midnight of from and of the day after to. */
    start: time, end: time}).strict(),
  /** At as_of, by the products list filters' definitions; one product can count in several. */
  products: z.object({total: count.max(200), offered: count, not_offered: count, outdated: count, out_of_stock: count}).strict(),
  /** At as_of: seller selections on this supplier's offers, in total and per seller shop. */
  cooperation: z.object({
    totals: SupplierCooperationCountsSchema, partner_count: count,
    /** Ordered like the partners read; the first 200 only. The CSV lists every shop. */
    partners: z.array(SupplierPartnerSchema).max(200),
  }).strict(),
  /** Owner only, like every reservation read. */
  reservations: z.discriminatedUnion('state', [
    z.object({state: z.literal('ready'), reserved: SupplierReportReservationsSchema,
      cancelled: SupplierReportReservationsSchema, expired: SupplierReportReservationsSchema}).strict(),
    z.object({state: z.literal('unavailable'), reason: z.literal('owner_required')}).strict(),
  ]),
  /** Data rows in this report's CSV: one per product, per seller shop and (owner only) per reservation line. */
  csv_rows: count.max(SUPPLIER_REPORT_MAX_ROWS),
}).strict()
  .refine(value => Date.parse(value.period.start) === taipeiMidnight(value.period.from)
    && Date.parse(value.period.end) === taipeiMidnight(value.period.to) + 86400000, 'The period instants must match its days.')
  .refine(value => value.products.offered + value.products.not_offered === value.products.total
    && value.products.outdated <= value.products.offered && value.products.out_of_stock <= value.products.total,
    'Product counts do not add up.')
  .refine(value => value.cooperation.partners.length === Math.min(value.cooperation.partner_count, 200),
    'The partner list must hold the first 200 shops.')
  .refine(value => value.csv_rows === value.products.total + value.cooperation.partner_count
    + (value.reservations.state === 'ready'
      ? value.reservations.reserved.lines + value.reservations.cancelled.lines + value.reservations.expired.lines : 0),
    'csv_rows must count every data row.');

// S3 cooperation materials (SC-09). A material is a record of this supplier business: an image, a video or a copy
// text about one own product or about the whole brand. Versions are immutable and only move forward. A partner (a
// seller shop) sees only the current version of an active material, and only while it holds an active grant and a
// current sellable or awaiting cooperation on that product (any of this supplier's products for a brand material).
// Image and video bytes are tenant Assets read through the API; no storage URL, object key or locator leaves the
// server. public_use is the supplier's permission for partners to show that version on their own public storefront;
// it never creates a readable file address.
export const SUPPLY_MATERIAL_ACTIVE_LIMIT = 200;
export const SUPPLY_MATERIAL_VERSION_LIMIT = 100;
export const SUPPLY_MATERIAL_GRANT_LIMIT = 200;
export const SUPPLY_MATERIAL_IMAGE_SOURCE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const SUPPLY_MATERIAL_IMAGE_SOURCE_MAX_BYTES = 2 * 1024 * 1024;
export const SUPPLY_MATERIAL_IMAGE_MAX_BYTES = 1024 * 1024;
export const SUPPLY_MATERIAL_IMAGE_MAX_EDGE = 1920;
export const SUPPLY_MATERIAL_VIDEO_TYPES = ['video/mp4', 'video/webm'] as const;
export const SUPPLY_MATERIAL_VIDEO_MAX_BYTES = 20 * 1024 * 1024;
/** Same rules as the storefront text fields: no control characters except newlines in multiline text; trimmed. */
const plainText = (max: number, min: number, multiline = false) => z.string()
  .regex(multiline ? /^[^\u0000-\u0009\u000b-\u001f\u007f]*$/ : /^[^\u0000-\u001f\u007f]*$/).trim().min(min).max(max);
const materialTitle = plainText(80, 1);
const materialDescription = plainText(500, 0, true);
const copyBody = plainText(2000, 1, true);
const bytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const SupplyMaterialKindSchema = z.enum(['image', 'video', 'copy']);
export const SupplyMaterialAccessSchema = z.enum(['partners', 'public_use']);
export const SupplyMaterialStateSchema = z.enum(['active', 'withdrawn']);
/** What one immutable version holds. Images are the processed WebP, videos the uploaded file as stored. */
export const SupplyMaterialContentSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('image'), content_type: z.literal('image/webp'),
    byte_size: z.number().int().min(1).max(SUPPLY_MATERIAL_IMAGE_MAX_BYTES),
    width: z.number().int().min(1).max(SUPPLY_MATERIAL_IMAGE_MAX_EDGE),
    height: z.number().int().min(1).max(SUPPLY_MATERIAL_IMAGE_MAX_EDGE)}).strict(),
  z.object({kind: z.literal('video'), content_type: z.enum(SUPPLY_MATERIAL_VIDEO_TYPES),
    byte_size: z.number().int().min(1).max(SUPPLY_MATERIAL_VIDEO_MAX_BYTES)}).strict(),
  z.object({kind: z.literal('copy'), body: copyBody}).strict(),
]);
export const SupplyMaterialVersionSchema = z.object({
  version_id: OpaqueId, version_no: z.number().int().min(1).max(SUPPLY_MATERIAL_VERSION_LIMIT), created_at: time,
  content: SupplyMaterialContentSchema,
}).strict();
export const SupplyMaterialSubjectSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('brand')}).strict(),
  /** One own product. sku and title are null once that product was removed; partners then lose access with it. */
  z.object({kind: z.literal('product'), product_id: OpaqueId,
    sku: ProductViewSchema.shape.sku.nullable(), title: ProductViewSchema.shape.title.nullable()}).strict()
    .refine(value => (value.sku === null) === (value.title === null), 'A removed product has neither SKU nor title.'),
]);
export const SupplyMaterialSchema = z.object({
  material_id: OpaqueId, kind: SupplyMaterialKindSchema, subject: SupplyMaterialSubjectSchema,
  title: materialTitle, description: materialDescription,
  access: SupplyMaterialAccessSchema, state: SupplyMaterialStateSchema,
  /** The material's aggregate version: the If-Match value of every command on it. */
  version: Version,
  created_at: time, updated_at: time, withdrawn_at: time.nullable(),
  /** The newest version, which partners see. Null until the first file or copy text. */
  current: SupplyMaterialVersionSchema.nullable(),
  version_count: z.number().int().min(0).max(SUPPLY_MATERIAL_VERSION_LIMIT),
  active_grants: z.number().int().min(0).max(SUPPLY_MATERIAL_GRANT_LIMIT),
}).strict()
  .refine(value => value.current === null || value.current.content.kind === value.kind, 'Content must match the material kind.')
  .refine(value => (value.state === 'withdrawn') === (value.withdrawn_at !== null), 'Only a withdrawn material has withdrawn_at.')
  .refine(value => value.current === null ? value.version_count === 0 : value.current.version_no === value.version_count,
    'The current version is the newest one.');
/** The business's shared retained space at as_of (every stored file of the business, not only materials). */
export const SupplyMaterialCapacitySchema = z.discriminatedUnion('state', [
  z.object({state: z.literal('ready'), limit_bytes: bytes, used_bytes: bytes, reserved_bytes: bytes, remaining_bytes: bytes}).strict()
    .refine(value => value.remaining_bytes === Math.max(0, value.limit_bytes - value.used_bytes - value.reserved_bytes),
      'remaining_bytes is the limit minus used and reserved bytes.'),
  z.object({state: z.literal('unavailable')}).strict(),
]);
export const SupplyMaterialsSchema = z.object({
  profile: z.literal('freedom.supplier-console.materials/v1'), tenant_id: OpaqueId, instance_id: OpaqueId, as_of: time,
  capacity: SupplyMaterialCapacitySchema,
  /** Active materials; at most SUPPLY_MATERIAL_ACTIVE_LIMIT. Withdrawn ones stay listed after them. */
  active: z.number().int().min(0).max(SUPPLY_MATERIAL_ACTIVE_LIMIT), total: count,
  /** Active first, then most recently updated; the first 200. */
  items: z.array(SupplyMaterialSchema).max(200), truncated: z.boolean(),
}).strict()
  .refine(value => value.items.length === Math.min(value.total, 200) && value.truncated === (value.total > 200)
    && value.active <= value.total, 'The list must hold the first 200 materials.');
export const SupplyMaterialGrantSchema = z.object({
  partner_id: OpaqueId, partner_name: z.string(), granted_at: time, revoked_at: time.nullable(),
}).strict();
/** A partner that may be granted now: a current sellable or awaiting cooperation on the material's product (on any
 * product of this supplier for a brand material). */
export const SupplyMaterialPartnerSchema = z.object({
  partner_id: OpaqueId, name: z.string(), cooperation: z.enum(['awaiting', 'sellable']), granted: z.boolean(),
}).strict();
export const SupplyMaterialDetailSchema = z.object({
  profile: z.literal('freedom.supplier-console.material/v1'), tenant_id: OpaqueId, instance_id: OpaqueId, as_of: time,
  material: SupplyMaterialSchema,
  /** Newest first; the newest 50. */
  versions: z.array(SupplyMaterialVersionSchema).max(50), versions_truncated: z.boolean(),
  /** Active grants first (by shop name), then revoked ones, newest first; the first 200. */
  grants: z.array(SupplyMaterialGrantSchema).max(200), grants_truncated: z.boolean(),
  partners: z.array(SupplyMaterialPartnerSchema).max(200), partners_truncated: z.boolean(),
}).strict()
  .refine(value => value.versions.length === Math.min(value.material.version_count, 50)
    && value.versions_truncated === (value.material.version_count > 50), 'The newest 50 versions must be listed.')
  .refine(value => value.material.current === null || value.versions[0]?.version_id === value.material.current.version_id,
    'The first listed version is the current one.')
  .refine(value => value.grants.filter(grant => grant.revoked_at === null).length === value.material.active_grants,
    'Every active grant is listed before revoked ones.');
const materialFields = {title: materialTitle, description: materialDescription};
/** Creates a material. A copy material starts with its first version; an image or video one gets its first file next. */
export const SupplyMaterialCreateInputSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('image'), product_id: OpaqueId.nullable(), ...materialFields}).strict(),
  z.object({kind: z.literal('video'), product_id: OpaqueId.nullable(), ...materialFields}).strict(),
  z.object({kind: z.literal('copy'), product_id: OpaqueId.nullable(), ...materialFields, body: copyBody}).strict(),
]);
export const SupplyMaterialUpdateInputSchema = z.object(materialFields).partial().strict()
  .refine(value => Object.keys(value).length > 0, 'At least one field is required.');
/** A new version of a copy material. */
export const SupplyMaterialCopyInputSchema = z.object({body: copyBody}).strict();
/** Allowing public use needs the explicit confirmation the supplier gave in the dialog. */
export const SupplyMaterialAccessInputSchema = z.discriminatedUnion('access', [
  z.object({access: z.literal('partners')}).strict(),
  z.object({access: z.literal('public_use'), confirm_public_use: z.literal(true)}).strict(),
]);
/** One grant row per shop, made now. Shops joining later get nothing automatically. */
export const SupplyMaterialGrantInputSchema = z.object({
  partner_ids: z.array(OpaqueId).min(1).max(SUPPLY_MATERIAL_GRANT_LIMIT),
}).strict().refine(value => new Set(value.partner_ids).size === value.partner_ids.length, 'Each shop at most once.');
/** Body of revoke and withdraw. */
export const SupplyMaterialEmptyInputSchema = z.object({}).strict();
/** Every material command answers with the material and its version after the original command. */
export const SupplyMaterialReceiptSchema = z.object({material_id: OpaqueId, version: Version}).strict();
/** A material as a partner sees it: always active, always with its current version. */
export const PartnerMaterialSchema = z.object({
  material_id: OpaqueId, kind: SupplyMaterialKindSchema,
  /** The supplier's name as its supply offers show it. */
  supplier_name: z.string(),
  subject: z.discriminatedUnion('kind', [
    z.object({kind: z.literal('brand')}).strict(),
    z.object({kind: z.literal('product'), product_id: OpaqueId, title: ProductViewSchema.shape.title}).strict(),
  ]),
  /** This shop's current cooperation products the material applies to: the product itself, or each of this supplier's
   * products the shop currently sells or awaits for a brand material. */
  applies_to: z.array(OpaqueId).min(1).max(200),
  title: materialTitle, description: materialDescription, access: SupplyMaterialAccessSchema,
  current: SupplyMaterialVersionSchema,
}).strict()
  .refine(value => value.current.content.kind === value.kind, 'Content must match the material kind.')
  .refine(value => value.subject.kind === 'brand' || (value.applies_to.length === 1 && value.applies_to[0] === value.subject.product_id),
    'A product material applies to its product only.');
export const PartnerMaterialsSchema = z.object({
  profile: z.literal('freedom.partner-materials/v1'), tenant_id: OpaqueId, instance_id: OpaqueId, as_of: time,
  /** By supplier name, brand materials before product ones, then title; the first 200. */
  items: z.array(PartnerMaterialSchema).max(200), truncated: z.boolean(),
}).strict();

// D-11 storefront use of partner materials
export const DistributionPhotoStateSchema=z.enum(['none','in_use','update_available','source_unavailable']);
const distributionPhotoPath=z.string().max(230).regex(/^\/api\/v1\/tenants\/[0-9a-f-]{36}\/storefronts\/[0-9a-f-]{36}\/distribution-photos\/[0-9a-f-]{36}\/photo\/[1-9][0-9]{0,18}$(?![\s\S])/);
export const DistributionPhotoItemSchema=z.object({
 product_id:OpaqueId,sku:ProductViewSchema.shape.sku,title:ProductViewSchema.shape.title,version:NonNegativeDecimal,
 state:DistributionPhotoStateSchema,
 photo:z.object({content_type:z.literal('image/webp'),byte_size:z.number().int().min(1).max(1048576),
  width:z.number().int().min(1).max(1920),height:z.number().int().min(1).max(1920),read_path:distributionPhotoPath}).strict().nullable(),
 source:z.object({material_id:OpaqueId,version_id:OpaqueId,version_no:z.number().int().min(1).max(100),title:materialTitle}).strict().nullable(),
 latest:z.object({version_id:OpaqueId,version_no:z.number().int().min(1).max(100)}).strict().nullable(),
}).strict();
export const DistributionPhotosSchema=z.object({items:z.array(DistributionPhotoItemSchema).max(200)}).strict();
export const DistributionPhotoUseInputSchema=z.object({material_id:OpaqueId,version_id:OpaqueId}).strict();
/** Field checks can fail while this refine still runs. Compare the canonical decimal; do not call BigInt on the raw text. */
function nonNegativeDecimalAtMost(completed: unknown, current: unknown): boolean {
  if (typeof completed !== 'string' || typeof current !== 'string') return false;
  if (!NON_NEGATIVE_DECIMAL_PATTERN.test(completed) || !NON_NEGATIVE_DECIMAL_PATTERN.test(current)) return false;
  if (completed === '0') return true;
  if (current === '0') return false;
  if (completed.length !== current.length) return completed.length < current.length;
  return completed <= current;
}
export const DistributionPhotoCommandSchema=z.object({product_id:OpaqueId,version:NonNegativeDecimal,changed:z.boolean(),current:DistributionPhotoItemSchema}).strict()
 .refine(v=>v.product_id===v.current.product_id && nonNegativeDecimalAtMost(v.version, v.current.version));
export type DistributionPhotoItem=z.infer<typeof DistributionPhotoItemSchema>;
export type DistributionPhotoCommand=z.infer<typeof DistributionPhotoCommandSchema>;

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
export type SupplierReportQuery = z.infer<typeof SupplierReportQuerySchema>;
export type SupplierReport = z.infer<typeof SupplierReportSchema>;
export type SupplyMaterialContent = z.infer<typeof SupplyMaterialContentSchema>;
export type SupplyMaterialVersion = z.infer<typeof SupplyMaterialVersionSchema>;
export type SupplyMaterial = z.infer<typeof SupplyMaterialSchema>;
export type SupplyMaterials = z.infer<typeof SupplyMaterialsSchema>;
export type SupplyMaterialDetail = z.infer<typeof SupplyMaterialDetailSchema>;
export type SupplyMaterialCreateInput = z.infer<typeof SupplyMaterialCreateInputSchema>;
export type SupplyMaterialReceipt = z.infer<typeof SupplyMaterialReceiptSchema>;
export type PartnerMaterial = z.infer<typeof PartnerMaterialSchema>;
export type PartnerMaterials = z.infer<typeof PartnerMaterialsSchema>;
