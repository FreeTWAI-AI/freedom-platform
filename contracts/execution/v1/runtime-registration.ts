import { z } from 'zod';
import { OpaqueId } from '../../common/v1/identity.js';

// Closed enrollment evidence only. These objects are not authentication tokens,
// runtime capability attestations, execution Grants, or verified contexts.
export const RUNTIME_ENROLLMENT_PROFILE = 'freedom.runtime-enrollment/v1' as const;
export const RUNTIME_ENROLLMENT_TYP = 'freedom-runtime-enrollment+jws' as const;
export const RUNTIME_ENROLLMENT_TTL_MS = 300_000;
export const RUNTIME_ENROLLMENT_PROTECTED_HEADER = '{"alg":"ES256","typ":"freedom-runtime-enrollment+jws"}';
export const RUNTIME_ENROLLMENT_LIMITS = Object.freeze({ proofBytes: 4096, payloadBytes: 2048 });

// The final character has only four significant bits for a 32-byte value.
const Bytes32 = z.string().length(43).regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$(?![\s\S])/);
const Time = z.iso.datetime({ precision: 3 });
export const RuntimeEnvironmentSchema = z.enum(['local', 'staging-next', 'next']);
export const RuntimePublicJwkSchema = z.object({
  kty: z.literal('EC'), crv: z.literal('P-256'), x: Bytes32, y: Bytes32,
}).strict();
// Generated schemas describe shape only. Canonical timestamps, exact 300000 ms
// TTL, curve membership and challenge bytes are checked by runtime-proof.ts;
// freshness and single consumption require the authoritative member service.
export const RuntimeRegistrationChallengeBindingSchema = z.object({
  challenge_id: OpaqueId,
  owner_member_id: OpaqueId,
  owner_principal_id: OpaqueId,
  scope_id: OpaqueId,
  runtime_device_id: OpaqueId,
  environment: RuntimeEnvironmentSchema,
  key_thumbprint: Bytes32,
  nonce: Bytes32,
  issued_at: Time,
  expires_at: Time,
}).strict().describe('Runtime enrollment binding shape only; runtime validates canonical times and exact 300000ms TTL. Trusted service validates freshness and atomic consumption.');
export const RuntimeRegistrationChallengeSchema = RuntimeRegistrationChallengeBindingSchema.extend({
  profile: z.literal(RUNTIME_ENROLLMENT_PROFILE),
  purpose: z.literal('runtime_enrollment'),
  operational_authority: z.literal(false),
  payload: z.string().min(1).max(RUNTIME_ENROLLMENT_LIMITS.payloadBytes),
}).strict();
export type RuntimePublicJwk = z.infer<typeof RuntimePublicJwkSchema>;
export type RuntimeEnvironment = z.infer<typeof RuntimeEnvironmentSchema>;
export type RuntimeRegistrationChallengeBinding = z.infer<typeof RuntimeRegistrationChallengeBindingSchema>;
export type RuntimeRegistrationChallenge = z.infer<typeof RuntimeRegistrationChallengeSchema>;
