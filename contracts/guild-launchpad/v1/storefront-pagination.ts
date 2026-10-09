import {z} from 'zod';
import {MyStoresSchema} from './storefront.js';

// Separate from the immutable storefront@1.0.0 registry contract pin.
export const MyStoresQuerySchema = z.object({cursor: z.string().min(1).max(2048).optional()}).strict();
export const MyStoresPageSchema = z.object({items: MyStoresSchema.shape.items, next_cursor: z.string().min(1).max(2048).nullable()}).strict();
