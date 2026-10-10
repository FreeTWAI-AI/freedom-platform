import {z} from 'zod';
import {OpaqueId, Version} from './primitives.js';
import {CurrencySchema, ProductInputSchema} from './storefront.js';
import {SupplyTermsInputSchema} from './hosted-supply-terms.js';

export const SupplyOfferTermsSchema = SupplyTermsInputSchema.extend({
  title: ProductInputSchema.shape.title, description: z.string().max(4000), currency: CurrencySchema,
}).strict();
export const SupplyOfferSchema = z.object({
  offer_id: OpaqueId, product_id: OpaqueId, supplier_name: z.string(), source_version: Version,
  terms: SupplyOfferTermsSchema, terms_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(['offered', 'withdrawn']), version: Version,
}).strict();
export const SupplyOffersSchema = z.object({items: z.array(SupplyOfferSchema).max(100), truncated: z.boolean()}).strict();
export const DistributionInputSchema = z.object({
  offer_id: OpaqueId, terms_sha256: SupplyOfferSchema.shape.terms_sha256,
  retail_price_minor: ProductInputSchema.shape.price_minor,
}).strict();
export const DistributionDecisionSchema = z.object({
  decision: z.enum(['accepted', 'declined', 'revoked']), listing_sha256: SupplyOfferSchema.shape.terms_sha256,
}).strict();
export const DistributionSchema = z.object({
  selection_id: OpaqueId, offer: SupplyOfferSchema, sku: z.string(), seller_name: z.string(),
  retail_price_minor: ProductInputSchema.shape.price_minor,
  state: z.enum(['awaiting_supply_acceptance', 'sellable', 'declined', 'changes_requested', 'revoked']),
  listing_sha256: SupplyOfferSchema.shape.terms_sha256, version: Version,
}).strict();
export const DistributionsSchema = z.object({items: z.array(DistributionSchema).max(200), truncated: z.boolean()}).strict();
export type SupplyOffer = z.infer<typeof SupplyOfferSchema>;
export type Distribution = z.infer<typeof DistributionSchema>;
