import {z} from 'zod';
import {OpaqueId,Version} from './primitives.js';
import {CurrencySchema,ProductInputSchema,ProductViewSchema} from './storefront.js';

// Additive private supplier DTOs. The pinned retail storefront/v1 stays unchanged.
const name=z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]*$/);
const description=ProductInputSchema.shape.description;
export const SupplyCatalogSetupInputSchema=z.object({name,currency:CurrencySchema,description}).strict();
export const SupplyCatalogViewSchema=z.object({
  tenant_id:OpaqueId,instance_id:OpaqueId,setup_state:z.enum(['setup_required','ready']),
  catalog:z.object({name,currency:CurrencySchema,description:z.string()}).strict().nullable(),
  retail_enabled:z.boolean(),product_count:z.number().int().min(0).max(200),product_limit:z.literal(200),
  writable:z.boolean(),capabilities:z.array(z.string()),version:Version.nullable(),
}).strict();
// Stable command results contain no private text/cost. Clients fetch current
// projections separately; retries retain the original receipt and never repeat effects.
export const SupplyCatalogReceiptSchema=z.object({instance_id:OpaqueId,version:Version,created:z.boolean()}).strict();
export const SupplyProductReceiptSchema=z.object({product_id:OpaqueId,version:Version}).strict();
export const SupplyProductInputSchema=ProductInputSchema.omit({price_minor:true}).extend({cost_minor:ProductInputSchema.shape.price_minor});
export const SupplyProductUpdateInputSchema=SupplyProductInputSchema.partial().refine(value=>Object.keys(value).length>0);
export const SupplyProductViewSchema=ProductViewSchema.omit({price_minor:true}).extend({cost_minor:ProductInputSchema.shape.price_minor});
export const SupplyProductPageSchema=z.object({items:z.array(SupplyProductViewSchema).max(200),limit:z.literal(200)}).strict();
export type SupplyCatalogView=z.infer<typeof SupplyCatalogViewSchema>;
export type SupplyProductView=z.infer<typeof SupplyProductViewSchema>;
