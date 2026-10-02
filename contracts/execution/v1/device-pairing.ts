import { z } from 'zod';
import { OpaqueId } from '../../common/v1/identity.js';
import { BOOTSTRAP_LIMITS, BootstrapBindingSchema, BootstrapClientIdSchema, BootstrapProofHostSchema } from './bootstrap.js';
import { BootstrapNonceSchema } from './bootstrap-status.js';
import { BootstrapRefreshSchema } from './bootstrap-session.js';
import { RuntimeEnvironmentSchema, RuntimePublicJwkSchema, RuntimeRegistrationChallengeSchema, RUNTIME_ENROLLMENT_LIMITS } from './runtime-registration.js';

export const DEVICE_PAIRING_TYP = 'freedom-device-pairing+jwt' as const;
export const DEVICE_PAIRING_LIMITS = Object.freeze({ ttlSeconds: 300, pollSeconds: 5, slowdownSeconds: 5,
  environmentPending: 1000, environmentLifetime: 10000, keyPending: 4, keyLifetime: 32,
  pollProofs: 64, reviewWindowSeconds: 60, reviewLookups: 10 });
export const DeviceRuntimeKindSchema = z.enum(['agent-kit', 'extension', 'neo']);
const Bytes32 = RuntimePublicJwkSchema.shape.x;
const Time = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const IsoTime = z.iso.datetime({ precision: 3 });
const Jti = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$(?![\s\S])/);
const Key = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$(?![\s\S])/);
const Uri = z.string().min(1).max(512);
const Proof = z.string().min(1).max(BOOTSTRAP_LIMITS.compactBytes);
const PollInterval = z.number().int().min(5).max(325).describe('Seconds; initial 5 plus at most 64 accepted proof slowdowns of 5 seconds.');
export const DeviceUserCodeSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$(?![\s\S])/);
export const DeviceCodeSchema = Bytes32;
export const DeviceAuthorizationHostSchema = BootstrapProofHostSchema.extend({
  issuerKid: BootstrapProofHostSchema.shape.keys.element.shape.kid,
  beginUri: Uri, pollUri: Uri, verificationUri: Uri,
  clientDisplayName: z.string().min(1).max(128).regex(/^[^\x00-\x1f\x7f]+$(?![\s\S])/),
}).strict();
export const DevicePairingHeaderSchema = z.object({ alg: z.literal('ES256'), typ: z.literal(DEVICE_PAIRING_TYP), jwk: RuntimePublicJwkSchema }).strict();
export const DevicePairingBeginClaimsSchema = z.object({ purpose: z.literal('device_pairing_begin'),
  client_id: BootstrapClientIdSchema, environment: RuntimeEnvironmentSchema, runtime_kind: DeviceRuntimeKindSchema,
  scope: z.literal('bootstrap.status.read'), jti: Jti, iat: Time, htm: z.literal('POST'), htu: Uri,
}).strict();
export const DevicePairingPollClaimsSchema = DevicePairingBeginClaimsSchema.extend({
  purpose: z.literal('device_pairing_poll'), authorization_id: OpaqueId, nonce: Bytes32,
  device_code_hash: Bytes32, request_digest: Bytes32,
}).strict();
export const DevicePairingBeginProofInputSchema = z.object({ proof: Proof, publicJwk: RuntimePublicJwkSchema,
  runtimeKind: DeviceRuntimeKindSchema, nowMs: Time }).strict();
export const DevicePairingPollProofInputSchema = DevicePairingBeginProofInputSchema.extend({
  authorizationId: OpaqueId, nonce: Bytes32, deviceCodeHash: Bytes32, requestDigest: Bytes32,
}).strict();
export const DevicePairingProofResultSchema = z.object({ keyThumbprint: Bytes32, proofId: Jti, issuedAt: Time,
  validFromMs: Time, validUntilMs: Time, assurance: z.literal('cryptographic_only'), operational_authority: z.literal(false),
}).strict().describe('Signature and exact supplied binding evidence only; host clock/binding are not authenticated, no replay prevention or current DB authority.');
export const BootstrapTokenIssueInputSchema = z.object({ binding: BootstrapBindingSchema, nowMs: Time, notAfterMs: Time }).strict();
export const BootstrapTokenIssueResultSchema = z.object({ accessToken: Proof, tokenId: Jti, issuedAt: Time,
  expiresAt: Time, validFromMs: Time, validUntilMs: Time, operational_authority: z.literal(false),
}).strict().describe('Sensitive bootstrap-only signing output, not DB authorization; never persist in receipts, facts or logs. Time fields are integer seconds except explicitly named milliseconds.');

export const DeviceAuthorizationBeginInputSchema = z.object({ publicJwk: RuntimePublicJwkSchema,
  runtimeKind: DeviceRuntimeKindSchema, proof: Proof }).strict();
export const DeviceAuthorizationInspectInputSchema = z.object({ userCode: DeviceUserCodeSchema }).strict();
export const DeviceAuthorizationDecisionInputSchema = DeviceAuthorizationInspectInputSchema.extend({ key: Key,
  authorizationId: OpaqueId, requestDigest: Bytes32, decision: z.enum(['approve', 'deny']) }).strict();
export const DeviceAuthorizationPollInputSchema = z.object({ authorizationId: OpaqueId, deviceCode: DeviceCodeSchema,
  proof: Proof, enrollmentProof: z.string().min(1).max(RUNTIME_ENROLLMENT_LIMITS.proofBytes).optional() }).strict();
export const DeviceAuthorizationBeginResultSchema = z.object({ authorizationId: OpaqueId, deviceCode: DeviceCodeSchema,
  userCode: DeviceUserCodeSchema, nonce: Bytes32, requestDigest: Bytes32, verificationUri: Uri,
  issuedAt: IsoTime, expiresAt: IsoTime, expiresIn: z.literal(300), interval: z.literal(5), operational_authority: z.literal(false),
}).strict().describe('One-time sensitive begin response; shape is not authentication, never persist raw codes in generic receipts or facts.');
export const DeviceAuthorizationReviewSchema = z.object({ authorizationId: OpaqueId, requestDigest: Bytes32,
  clientId: BootstrapClientIdSchema, clientDisplayName: DeviceAuthorizationHostSchema.shape.clientDisplayName,
  environment: RuntimeEnvironmentSchema, runtimeKind: DeviceRuntimeKindSchema, keyThumbprint: Bytes32,
  scope: z.literal('bootstrap.status.read'), expiresAt: IsoTime, state: z.enum(['pending', 'approved', 'denied', 'consumed']),
  operational_authority: z.literal(false),
}).strict().describe('Exact member review metadata, not proof of current membership or runtime capability.');
export const DeviceAuthorizationDecisionResultSchema = z.object({ authorizationId: OpaqueId, requestDigest: Bytes32,
  state: z.enum(['approved', 'denied']), operational_authority: z.literal(false) }).strict();
export const DeviceAuthorizationPollResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('authorization_pending'), interval: PollInterval, operational_authority: z.literal(false) }).strict(),
  z.object({ status: z.literal('slow_down'), interval: PollInterval, operational_authority: z.literal(false) }).strict(),
  z.object({ status: z.literal('proof_required'), challenge: RuntimeRegistrationChallengeSchema,
    interval: PollInterval, operational_authority: z.literal(false) }).strict(),
  z.object({ status: z.literal('access_denied'), operational_authority: z.literal(false) }).strict(),
  z.object({ status: z.literal('expired_token'), operational_authority: z.literal(false) }).strict(),
  z.object({ status: z.literal('issued'), accessToken: Proof, tokenType: z.literal('DPoP'), expiresAt: IsoTime,
    connectionId: OpaqueId, runtimeDeviceId: OpaqueId, nonce: BootstrapNonceSchema,
    refreshSupported: z.literal(true), refresh: BootstrapRefreshSchema, operational_authority: z.literal(false) }).strict(),
]).describe('Closed device-flow protocol variants, not full OAuth transport compatibility or execution authority.');

export type DeviceRuntimeKind = z.infer<typeof DeviceRuntimeKindSchema>;
export type DeviceAuthorizationHost = z.infer<typeof DeviceAuthorizationHostSchema>;
export type DevicePairingProofResult = z.infer<typeof DevicePairingProofResultSchema>;
export type BootstrapTokenIssueResult = z.infer<typeof BootstrapTokenIssueResultSchema>;
export type DeviceAuthorizationBeginInput = z.infer<typeof DeviceAuthorizationBeginInputSchema>;
export type DeviceAuthorizationInspectInput = z.infer<typeof DeviceAuthorizationInspectInputSchema>;
export type DeviceAuthorizationDecisionInput = z.infer<typeof DeviceAuthorizationDecisionInputSchema>;
export type DeviceAuthorizationPollInput = z.infer<typeof DeviceAuthorizationPollInputSchema>;
export type DeviceAuthorizationBeginResult = z.infer<typeof DeviceAuthorizationBeginResultSchema>;
export type DeviceAuthorizationReview = z.infer<typeof DeviceAuthorizationReviewSchema>;
export type DeviceAuthorizationDecisionResult = z.infer<typeof DeviceAuthorizationDecisionResultSchema>;
export type DeviceAuthorizationPollResult = z.infer<typeof DeviceAuthorizationPollResultSchema>;
