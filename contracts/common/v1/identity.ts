import { z } from 'zod';

// Author once here; JSON Schemas are generated, TS types inferred. These are
// references, never credentials or proof of runtime support/authorization.
export const OpaqueId = z.string().length(36).regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const PrincipalRefSchema = z.object({ principal_id: OpaqueId, kind: z.enum(['person','service']) }).strict();
export const ResourceScopeRefSchema = z.object({ scope_id: OpaqueId, kind: z.enum(['community','personal','site']) }).strict();
export type PrincipalRef = z.infer<typeof PrincipalRefSchema>;
export type ResourceScopeRef = z.infer<typeof ResourceScopeRefSchema>;
