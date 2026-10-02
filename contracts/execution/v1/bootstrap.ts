import { z } from 'zod';
import { OpaqueId } from '../../common/v1/identity.js';
import { ExecutionVersion } from './state.js';
import { RuntimeEnvironmentSchema, RuntimePublicJwkSchema } from './runtime-registration.js';

// Closed crypto profile, never a machine credential acceptance decision.
export const BOOTSTRAP_TYP = 'freedom-bootstrap+jwt' as const;
export const BOOTSTRAP_LIMITS = Object.freeze({ compactBytes: 8192, headerBytes: 1024, payloadBytes: 4096,
  jsonDepth: 8, jsonNodes: 128, lifetimeSeconds: 600, proofPastSeconds: 60, proofFutureSeconds: 5 });
const Bytes32 = RuntimePublicJwkSchema.shape.x;
const Kid = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$(?![\s\S])/);
const Jti = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$(?![\s\S])/);
const Time = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Uri = z.string().min(1).max(512);
export const BootstrapClientIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$(?![\s\S])/);
export const BootstrapBindingSchema = z.object({
  ownerUserId: OpaqueId, principalId: OpaqueId, scopeId: OpaqueId, runtimeDeviceId: OpaqueId,
  connectionId: OpaqueId, connectionVersion: ExecutionVersion, keyThumbprint: Bytes32,
}).strict();
export const BootstrapAccessHeaderSchema = z.object({ alg: z.literal('ES256'), typ: z.literal(BOOTSTRAP_TYP), kid: Kid }).strict();
export const BootstrapAccessClaimsSchema = z.object({
  iss: Uri, aud: Uri, sub: OpaqueId, owner_user_id: OpaqueId, scope_id: OpaqueId,
  runtime_device_id: OpaqueId, connection_id: OpaqueId, connection_version: ExecutionVersion,
  client_id: BootstrapClientIdSchema, environment: RuntimeEnvironmentSchema,
  purpose: z.literal('bootstrap_access'), scope: z.literal('bootstrap.status.read'),
  cnf: z.object({ jkt: Bytes32 }).strict(), iat: Time, exp: Time, jti: Jti,
}).strict().describe('Bootstrap JWT shape only. Crypto verifier checks signatures, exact host binding, canonical URI, bounded version and all time intervals. Not current machine authority.');
export const BootstrapDpopHeaderSchema = z.object({ alg: z.literal('ES256'), typ: z.literal('dpop+jwt'), jwk: RuntimePublicJwkSchema }).strict();
export const BootstrapDpopClaimsSchema = z.object({ jti: Jti, htm: z.literal('GET'), htu: Uri,
  iat: Time, ath: Bytes32, nonce: Bytes32 }).strict();
export const BootstrapTrustedKeySchema = z.object({ kid: Kid, purpose: z.literal('bootstrap_access'),
  environment: RuntimeEnvironmentSchema, publicJwk: RuntimePublicJwkSchema,
  notBeforeMs: Time, notAfterMs: Time, revoked: z.boolean() }).strict();
export const BootstrapProofHostSchema = z.object({ environment: RuntimeEnvironmentSchema,
  clientId: BootstrapClientIdSchema, issuer: Uri, audience: Uri, bootstrapUri: Uri,
  keys: z.array(BootstrapTrustedKeySchema).min(1).max(4) }).strict();
export const BootstrapProofInputSchema = z.object({
  accessToken: z.string().min(1).max(BOOTSTRAP_LIMITS.compactBytes),
  proof: z.string().min(1).max(BOOTSTRAP_LIMITS.compactBytes), expectedNonce: Bytes32,
  nowMs: Time, expectedBinding: BootstrapBindingSchema,
}).strict();
export const BootstrapProofResultSchema = z.object({ binding: BootstrapBindingSchema,
  tokenId: Jti, proofId: Jti, issuedAt: Time, expiresAt: Time, nonce: Bytes32,
  assurance: z.literal('cryptographic_only'), operational_authority: z.literal(false),
}).strict().describe('Cryptographic evidence under caller-supplied host assumptions only; no DB authority, replay prevention, nonce consumption, execution permission or VerifiedContext.');
export type BootstrapBinding = z.infer<typeof BootstrapBindingSchema>;
export type BootstrapProofHost = z.infer<typeof BootstrapProofHostSchema>;
export type BootstrapProofInput = z.infer<typeof BootstrapProofInputSchema>;
export type BootstrapProofResult = z.infer<typeof BootstrapProofResultSchema>;
