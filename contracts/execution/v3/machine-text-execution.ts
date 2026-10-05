import { z } from 'zod';
import { OpaqueId } from '../../common/v1/identity.js';
import { RuntimeEnvironmentSchema, RuntimePublicJwkSchema } from '../v1/runtime-registration.js';
import { MemberExecutionVersionSchema } from '../v1/member-execution.js';

export const MachineTextLimits = Object.freeze({ compactBytes: 8192, nonceMs: 60000,
  accessSeconds: 90, evidenceSeconds: 300, proofPastSeconds: 60, proofFutureSeconds: 5,
  pendingChallenges: 8, lifetimeChallenges: 256, lifetimeProofs: 4096, inputBytes: 32768 });
const V = MemberExecutionVersionSchema, Jti = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$(?![\s\S])/);
const Hash = z.string().length(64).regex(/^[a-f0-9]+$(?![\s\S])/);
const Bytes32 = RuntimePublicJwkSchema.shape.x;
const Time = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Uri = z.string().min(1).max(512);
export const MachineTextDeviceBindingSchema = z.object({ ownerUserId: OpaqueId, principalId: OpaqueId,
  scopeId: OpaqueId, runtimeDeviceId: OpaqueId, runtimeVersion: V, connectionId: OpaqueId,
  connectionVersion: V, familyId: OpaqueId, keyThumbprint: Bytes32 }).strict();
export const MachineTextBindingSchema = MachineTextDeviceBindingSchema.extend({ authorizationId: OpaqueId,
  stepId: OpaqueId, attemptId: OpaqueId, runId: OpaqueId, grantId: OpaqueId, grantVersion: V,
  approvalId: OpaqueId, approvalVersion: V, bindingSha256: Hash, recoveryGeneration: V }).strict();
export const MachineTextTrustedKeySchema = z.object({ kid: Jti, purpose: z.literal('machine_text'),
  environment: RuntimeEnvironmentSchema, publicJwk: RuntimePublicJwkSchema,
  notBeforeMs: Time, notAfterMs: Time, revoked: z.boolean() }).strict();
export const MachineTextHostSchema = z.object({ profile: z.literal('freedom.machine-text.host/v1'),
  environment: RuntimeEnvironmentSchema, clientId: z.literal('agent-kit'), origin: Uri,
  issuer: Uri, audience: Uri, issuerKid: Jti, keys: z.array(MachineTextTrustedKeySchema).min(1).max(4) }).strict();
export const MachineTextProofHeaderSchema = z.object({ typ: z.literal('dpop+jwt'), alg: z.literal('ES256'),
  jwk: RuntimePublicJwkSchema }).strict();
const commonProof = z.object({ jti: Jti, iat: Time, htu: Uri, client_id: z.literal('agent-kit'),
  environment: RuntimeEnvironmentSchema, connection_id: OpaqueId, family_id: OpaqueId,
  request_sha256: Hash }).strict();
export const MachineTextDeviceProofSchema = z.discriminatedUnion('purpose', [
  commonProof.extend({ purpose: z.literal('machine_text.challenge'), htm: z.literal('POST') }).strict(),
  commonProof.extend({ purpose: z.literal('machine_text.activate'), htm: z.literal('POST'),
    nonce: Bytes32, challenge_id: OpaqueId }).strict(),
]);
export const MachineTextOperationSchema = z.enum(['execute', 'status', 'evidence']);
export const MachineTextAccessProofSchema = commonProof.extend({ purpose: z.literal('machine_text.request'),
  htm: z.enum(['GET', 'POST']), ath: Bytes32 }).strict();
export const MachineTextAccessHeaderSchema = z.object({ alg: z.literal('ES256'),
  typ: z.literal('freedom-execution-text+jwt'), kid: Jti }).strict();
export const MachineTextAccessClaimsSchema = z.object({ iss: Uri, aud: Uri, sub: OpaqueId,
  environment: RuntimeEnvironmentSchema, client_id: z.literal('agent-kit'),
  purpose: z.enum(['machine_text.execute', 'machine_text.evidence']),
  scope: z.enum(['model.private-draft', 'model.dispatch.evidence']),
  binding: MachineTextBindingSchema, cnf: z.object({ jkt: Bytes32 }).strict(),
  iat: Time, exp: Time, jti: Jti }).strict();
export type MachineTextHost = z.infer<typeof MachineTextHostSchema>;
export type MachineTextDeviceBinding = z.infer<typeof MachineTextDeviceBindingSchema>;
export type MachineTextBinding = z.infer<typeof MachineTextBindingSchema>;
export type MachineTextOperation = z.infer<typeof MachineTextOperationSchema>;
export type MachineTextClaims = z.infer<typeof MachineTextAccessClaimsSchema>;
