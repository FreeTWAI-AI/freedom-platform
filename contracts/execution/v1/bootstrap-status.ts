import { z } from 'zod';
import { OpaqueId } from '../../common/v1/identity.js';
import { ExecutionVersion } from './state.js';
import { RuntimeEnvironmentSchema, RuntimePublicJwkSchema } from './runtime-registration.js';
import { BOOTSTRAP_LIMITS, BootstrapClientIdSchema } from './bootstrap.js';

// Closed engineering bounds, not an approved retention or refresh policy.
export const BOOTSTRAP_NONCE_LIMITS = Object.freeze({ ttlMs: 60_000, pending: 8, lifetime: 4096 });
const Key = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$(?![\s\S])/);
const Time = z.iso.datetime({ precision: 3 });
export const BootstrapChallengeInputSchema = z.object({ key: Key, connectionId: OpaqueId }).strict();
export const BootstrapStatusReadInputSchema = z.object({ connectionId: OpaqueId, nonceId: OpaqueId,
  accessToken: z.string().min(1).max(BOOTSTRAP_LIMITS.compactBytes),
  proof: z.string().min(1).max(BOOTSTRAP_LIMITS.compactBytes),
}).strict();
export const BootstrapNonceSchema = z.object({ nonceId: OpaqueId,
  nonce: RuntimePublicJwkSchema.shape.x, connectionId: OpaqueId,
  issuedAt: Time, expiresAt: Time, operational_authority: z.literal(false),
}).strict().describe('Public one-use bootstrap challenge metadata. Shape is not member approval or machine authentication. Server checks current owner/runtime/connection, bounded lifetime and atomic nonce consumption.');
export const BootstrapStatusSchema = z.object({ connectionId: OpaqueId, runtimeDeviceId: OpaqueId,
  clientId: BootstrapClientIdSchema, environment: RuntimeEnvironmentSchema,
  connectionVersion: ExecutionVersion, expiresAt: Time, state: z.literal('active'),
  operation: z.literal('bootstrap.status.read'), operational_authority: z.literal(false),
}).strict().describe('Minimal connection status at a server DB authorization decision. No private Work, execution Grant, provider access or reusable VerifiedContext. Shape alone is not authorization.');
export type BootstrapChallengeInput = z.infer<typeof BootstrapChallengeInputSchema>;
export type BootstrapStatusReadInput = z.infer<typeof BootstrapStatusReadInputSchema>;
export type BootstrapNonce = z.infer<typeof BootstrapNonceSchema>;
export type BootstrapStatus = z.infer<typeof BootstrapStatusSchema>;
