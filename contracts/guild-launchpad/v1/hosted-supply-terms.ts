import {z} from 'zod';
import {OpaqueId, Version} from './primitives.js';
import {CurrencySchema} from './storefront.js';

const money = z.number().int().min(0).max(100000000);
const terms = z.string().regex(/^[^\u0000-\u0009\u000b-\u001f\u007f]*$/).trim().min(1).max(2000);
/** Private preparation of existing stock and supply terms, not an offer or acceptance. */
export const SupplyTermsInputSchema = z.object({
  cost_minor: money.min(1), shipping_minor: money, shipping_terms: terms, return_terms: terms,
}).strict();
export const SupplyTermsSchema = SupplyTermsInputSchema.extend({
  product_id: OpaqueId, currency: CurrencySchema,
  stock: z.number().int().min(0).max(1000000),
  reserved: z.number().int().min(0).max(1000000),
  available: z.number().int().min(0).max(1000000),
  version: Version, transaction_state: z.literal('not_enabled'),
}).strict();
export type SupplyTerms = z.infer<typeof SupplyTermsSchema>;
export type SupplyTermsInput = z.infer<typeof SupplyTermsInputSchema>;
