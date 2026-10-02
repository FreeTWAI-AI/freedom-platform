import { z } from 'zod';
import { OpaqueId } from '../../common/v1/identity.js';
import { BOOTSTRAP_LIMITS, BootstrapBindingSchema, BootstrapClientIdSchema, BootstrapProofHostSchema } from './bootstrap.js';
import { RuntimeEnvironmentSchema, RuntimePublicJwkSchema } from './runtime-registration.js';
import { ExecutionVersion } from './state.js';

export const BOOTSTRAP_REFRESH_TYP = 'freedom-bootstrap-refresh+jwt' as const;
export const BOOTSTRAP_NONCE_TYP = 'freedom-bootstrap-nonce+jwt' as const;
export const BOOTSTRAP_SESSION_LIMITS = Object.freeze({ familySeconds: 2592000, generations: 4096, connectionProofs: 8192 });
const Bytes32 = RuntimePublicJwkSchema.shape.x;
const Time = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Jti = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$(?![\s\S])/);
const Uri = z.string().min(1).max(512);
const Compact = z.string().min(1).max(BOOTSTRAP_LIMITS.compactBytes);
export const BootstrapSessionHostSchema = BootstrapProofHostSchema.extend({
  issuerKid: BootstrapProofHostSchema.shape.keys.element.shape.kid, refreshUri: Uri, nonceUri: Uri,
}).strict();
export const BootstrapRefreshHeaderSchema = z.object({ alg: z.literal('ES256'), typ: z.literal(BOOTSTRAP_REFRESH_TYP), jwk: RuntimePublicJwkSchema }).strict();
export const BootstrapNonceHeaderSchema = BootstrapRefreshHeaderSchema.extend({ typ: z.literal(BOOTSTRAP_NONCE_TYP) }).strict();
export const BootstrapRefreshClaimsSchema = z.object({ purpose: z.literal('bootstrap_refresh'),
  client_id: BootstrapClientIdSchema, environment: RuntimeEnvironmentSchema, connection_id: OpaqueId,
  family_id: OpaqueId, generation: ExecutionVersion, refresh_handle_hash: Bytes32,
  jti: Jti, iat: Time, htm: z.literal('POST'), htu: Uri,
}).strict();
export const BootstrapNonceClaimsSchema = z.object({ purpose: z.literal('bootstrap_nonce'),
  client_id: BootstrapClientIdSchema, environment: RuntimeEnvironmentSchema, connection_id: OpaqueId,
  jti: Jti, iat: Time, htm: z.literal('POST'), htu: Uri, ath: Bytes32,
}).strict();
export const BootstrapRefreshProofInputSchema = z.object({ proof: Compact, publicJwk: RuntimePublicJwkSchema,
  familyId: OpaqueId, generation: ExecutionVersion, connectionId: OpaqueId, refreshHandleHash: Bytes32, nowMs: Time,
}).strict();
export const BootstrapNonceProofInputSchema = z.object({ accessToken: Compact, proof: Compact,
  expectedBinding: BootstrapBindingSchema, nowMs: Time }).strict();
export const BootstrapRefreshProofResultSchema = z.object({ proofId: Jti, validFromMs: Time, validUntilMs: Time,
  assurance: z.literal('cryptographic_only'), operational_authority: z.literal(false),
}).strict().describe('Signatures and supplied binding only; no current DB authority or replay prevention. Interval is inclusive/exclusive milliseconds.');
export const BootstrapNonceProofResultSchema = BootstrapRefreshProofResultSchema.extend({ tokenId: Jti }).strict();
export const BootstrapRefreshSchema = z.object({ familyId: OpaqueId, generation: ExecutionVersion,
  handle: Bytes32, expiresAt: z.iso.datetime({ precision: 3 }),
}).strict().describe('One-time sensitive refresh output; never persist raw handle in receipts, facts or logs.');
export const BootstrapRefreshInputSchema = z.object({ familyId: OpaqueId, refreshHandle: Bytes32, proof: Compact }).strict();
export const BootstrapSessionNonceInputSchema = z.object({ connectionId: OpaqueId, accessToken: Compact, proof: Compact }).strict();
export const BootstrapRefreshResultSchema = z.object({ accessToken: Compact, tokenType: z.literal('DPoP'),
  expiresAt: z.iso.datetime({ precision: 3 }), connectionId: OpaqueId, runtimeDeviceId: OpaqueId,
  refresh: BootstrapRefreshSchema, operational_authority: z.literal(false),
}).strict().describe('Sensitive bootstrap-only response; not execution authority or durable receipt content.');
export type BootstrapSessionHost = z.infer<typeof BootstrapSessionHostSchema>;
export type BootstrapRefreshProofInput = z.infer<typeof BootstrapRefreshProofInputSchema>;
export type BootstrapNonceProofInput = z.infer<typeof BootstrapNonceProofInputSchema>;
export type BootstrapRefreshProofResult = z.infer<typeof BootstrapRefreshProofResultSchema>;
export type BootstrapNonceProofResult = z.infer<typeof BootstrapNonceProofResultSchema>;
export type BootstrapRefresh = z.infer<typeof BootstrapRefreshSchema>;
export type BootstrapRefreshInput = z.infer<typeof BootstrapRefreshInputSchema>;
export type BootstrapSessionNonceInput = z.infer<typeof BootstrapSessionNonceInputSchema>;
export type BootstrapRefreshResult = z.infer<typeof BootstrapRefreshResultSchema>;
