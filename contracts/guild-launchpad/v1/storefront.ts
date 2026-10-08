import { z } from 'zod';
import { OpaqueId, Version } from './primitives.js';
import { IsoTimeSchema } from './tenant.js';

const text = (max: number, min = 0, multiline = false) => z.string().trim().min(min).max(max)
  .regex(multiline ? /^[^\u0000-\u0009\u000b-\u001f\u007f]*$/ : /^[^\u0000-\u001f\u007f]*$/);
export const StoreSlugSchema = z.string().trim().regex(/^[a-zA-Z][a-zA-Z0-9-]{1,38}[a-zA-Z0-9]$/);
export const CurrencySchema = z.enum(['TWD', 'USD']);
const settings = { name: text(80, 1), brand: text(80, 1).nullable().optional(), description: text(2000, 0, true).optional(), slug: StoreSlugSchema };
export const StoreSetupInputSchema = z.object({ ...settings, currency: CurrencySchema }).strict();
export const StoreUpdateInputSchema = z.object(settings).partial().strict().refine(v => Object.keys(v).length > 0);
const product = { title: text(120, 1), description: text(2000, 0, true).optional(), price_minor: z.number().int().min(1).max(100000000), stock: z.number().int().min(0).max(1000000).optional() };
export const ProductInputSchema = z.object(product).strict();
export const ProductUpdateInputSchema = z.object(product).partial().strict().refine(v => Object.keys(v).length > 0);
export const EmptyStoreInputSchema = z.object({}).strict();
export const SlugQuerySchema = z.object({ slug: z.string().max(256) }).strict();
export const SlugAvailabilitySchema = z.object({ slug: z.string(), available: z.boolean(), reason: z.enum(['taken','reserved','invalid']).nullable() }).strict();
export const ProductViewSchema = z.object({ product_id: OpaqueId, sku: z.string().regex(/^P[0-9]{4,}$/), title: text(120, 1), description: text(2000, 0, true), price_minor: product.price_minor, currency: CurrencySchema, stock: z.number().int().min(0).max(1000000), version: Version }).strict();
export const ProductPageSchema = z.object({ items: z.array(ProductViewSchema).max(200), limit: z.literal(200) }).strict();
export const ProductRemovedSchema = z.object({ product_id: OpaqueId, removed: z.literal(true) }).strict();
export const PublicationStateSchema = z.enum(['never_published','published','unpublished']);
export const StoreViewSchema = z.object({
  tenant_id: OpaqueId, instance_id: OpaqueId, instance_status: z.enum(['requested','provisioning','active','suspended','failed','archived']),
  setup_state: z.enum(['setup_required','ready']),
  store: z.object({ slug: StoreSlugSchema, name: text(80, 1), brand: text(80, 1).nullable(), description: text(2000, 0, true), currency: CurrencySchema, slug_locked: z.boolean() }).strict().nullable(),
  publication: z.object({ state: PublicationStateSchema, current_revision: Version.nullable(), published_at: IsoTimeSchema.nullable(), public_path: z.string().nullable() }).strict(),
  product_count: z.number().int().min(0).max(200), product_limit: z.literal(200), transaction_state: z.literal('not_enabled'), writable: z.boolean(), capabilities: z.array(z.string()), version: Version.nullable(),
}).strict();
export const MyStoresSchema = z.object({ items: z.array(z.object({ tenant_id: OpaqueId, tenant_display_name: z.string(), instance_id: OpaqueId, setup_state: z.enum(['setup_required','ready']), name: z.string().nullable(), slug: z.string().nullable(), publication_state: PublicationStateSchema, public_path: z.string().nullable(), version: Version.nullable() }).strict()).max(100), truncated: z.boolean() }).strict();
export const PublicStoreProjectionSchema = z.object({
  slug: StoreSlugSchema, name: text(80, 1), brand: text(80, 1).nullable(), description: text(2000, 0, true), currency: CurrencySchema,
  products: z.array(z.object({ sku: z.string(), title: text(120, 1), description: text(2000, 0, true), price_minor: product.price_minor }).strict()).max(200),
  revision: Version, published_at: IsoTimeSchema, transaction_state: z.literal('not_enabled'),
}).strict();
export const StorePreviewSchema = z.object({ projection: PublicStoreProjectionSchema, dirty: z.boolean(), current_revision: Version.nullable() }).strict();
export type StoreSetupInput = z.infer<typeof StoreSetupInputSchema>;
export type StoreUpdateInput = z.infer<typeof StoreUpdateInputSchema>;
export type ProductInput = z.infer<typeof ProductInputSchema>;
export type ProductUpdateInput = z.infer<typeof ProductUpdateInputSchema>;
export type ProductView = z.infer<typeof ProductViewSchema>;
export type StoreView = z.infer<typeof StoreViewSchema>;
export type PublicStoreProjection = z.infer<typeof PublicStoreProjectionSchema>;
