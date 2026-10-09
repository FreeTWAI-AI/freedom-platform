import { z } from 'zod';
import { Version } from './primitives.js';

/** Additive presentation contract; the pinned storefront/v1 projection stays unchanged. */
export const STOREFRONT_PRESENTATION_PROFILE = 'freedom.hosted-store-presentation/v1' as const;
export const StoreTemplateSchema = z.enum(['catalog-grid-v1', 'catalog-list-v1']);
export type StoreTemplate = z.infer<typeof StoreTemplateSchema>;
export const StoreAppearanceInputSchema = z.object({ template_id: StoreTemplateSchema }).strict();
export const StoreAppearanceSchema = z.object({
  profile: z.literal(STOREFRONT_PRESENTATION_PROFILE),
  template_id: StoreTemplateSchema,
  published_template_id: StoreTemplateSchema.nullable(),
  version: Version,
}).strict();
export type StoreAppearance = z.infer<typeof StoreAppearanceSchema>;
