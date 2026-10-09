import {z} from 'zod';
import {MyStoresSchema} from './storefront.js';

// Separate from the immutable storefront@1.0.0 registry contract pin.
export const MyStoresQuerySchema = z.object({
  pagination: z.literal('cursor').optional(),
  cursor: z.string().min(1).max(2048).optional(),
}).strict().refine(query => query.cursor === undefined || query.pagination === 'cursor', {
  message: 'Cursor pagination requires an explicit opt-in.', path: ['pagination'],
});
export const MyStoresPageSchema = z.object({items: MyStoresSchema.shape.items, next_cursor: z.string().min(1).max(2048).nullable()}).strict();
export const MyStoresLegacyProjectionSchema = MyStoresPageSchema.transform(page =>
  MyStoresSchema.parse({items: page.items, truncated: page.next_cursor !== null}));
