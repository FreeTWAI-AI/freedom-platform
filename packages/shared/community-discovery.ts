import {z} from 'zod';

const card=z.object({id:z.string(),title:z.string(),summary:z.string(),author_name:z.string().nullable(),occurred_at:z.string().nullable(),path:z.string()}).strict();
const section=z.object({kind:z.enum(['resources','works','events','highlights','services']),state:z.enum(['ready','unavailable']),items:z.array(card).max(3)}).strict();
export const publicDiscoverySchema=z.object({sections:z.array(section).length(5)}).strict();
export type PublicDiscoveryCard=z.infer<typeof card>;
export type PublicDiscoverySection=z.infer<typeof section>;
export type PublicDiscovery=z.infer<typeof publicDiscoverySchema>;
