import { z } from 'zod';
import { OpaqueId } from '../../common/v1/identity.js';
import { MemberExecutionVersionSchema, LegacyModelSelectionSchema, OpenRouterModelSelectionSchema } from '../v1/member-execution.js';
import { RuntimeEnvironmentSchema } from '../v1/runtime-registration.js';
import { BootstrapClientIdSchema } from '../v1/bootstrap.js';

const Version = MemberExecutionVersionSchema;
const Time = z.iso.datetime({ precision: 3 });
const Key = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$(?![\s\S])/);
const RecoveryLabel = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$(?![\s\S])/);
export const SignedCredentialRecoveryHeaderSchema = z.object({ alg: z.literal('EdDSA'),
  typ: z.literal('freedom-credential-recovery+jws'), kid: RecoveryLabel }).strict();
export const SignedCredentialRecoveryStateSchema = z.object({ profile: z.literal('credential-broker.recovery/v1'),
  purpose: z.literal('credential-broker.recovery'), authority: RecoveryLabel, environment: RuntimeEnvironmentSchema,
  generation: Version, issuedAt: Time, expiresAt: Time }).strict();
export const CredentialRecoveryFloorSchema = z.object({ generation: Version, expiresAt: Time }).strict();
// This batch supports isolated broker custody only. Selection remains metadata,
// never provider authentication or permission to export a Work.
export const BrokerModelSelectionSchema = z.union([LegacyModelSelectionSchema.options[2].extend({
  providerRef: z.enum(['openai', 'anthropic']),
  processingLocation: z.literal('provider_remote'), artifactCustody: z.literal('platform_asset'),
}).strict(), OpenRouterModelSelectionSchema.options[1].extend({ artifactCustody: z.literal('platform_asset') }).strict()]);
export const ModelCredentialBindingSchema = z.object({
  profile: z.literal('model-credential.binding/v1'), credentialId: OpaqueId, generation: Version,
  modelConnectionId: OpaqueId, modelVersion: Version,
  ownerUserId: OpaqueId, ownerPrincipalId: OpaqueId, scopeId: OpaqueId,
  environment: RuntimeEnvironmentSchema, clientId: BootstrapClientIdSchema,
  runtimeDeviceId: OpaqueId, connectionId: OpaqueId, familyId: OpaqueId,
  selection: BrokerModelSelectionSchema, recoveryGeneration: Version, issuedAt: Time, expiresAt: Time,
}).strict();
const Bytes = (min: number, max: number) => z.string().min(min).max(max).regex(/^[A-Za-z0-9_-]+$(?![\s\S])/);
export const BrokerCredentialEnvelopeSchema = z.object({
  profile: z.literal('broker-credential.envelope/v1'),
  keyId: z.string().min(1).max(96).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$(?![\s\S])/),
  nonce: Bytes(16, 16), wrapNonce: Bytes(16, 16),
  ciphertext: Bytes(23, 5483), wrappedDek: Bytes(64, 64),
}).strict().describe('Broker-internal authenticated ciphertext structure. Parsing does not mint sealed provenance, authorize decryption or authenticate a model.');
export const ModelCredentialMetadataSchema = z.object({
  credentialId: OpaqueId, modelConnectionId: OpaqueId, modelVersion: Version, generation: Version,
  aggregateVersion: Version, state: z.enum(['active', 'rotated', 'revoked']),
  selection: BrokerModelSelectionSchema, recoveryGeneration: Version,
  issuedAt: Time, expiresAt: Time, terminalAt: Time.nullable(), replacementCredentialId: OpaqueId.nullable(),
  operational_authority: z.literal(false),
}).strict();
export const ModelCredentialCreateSchema = z.object({ key: Key, modelConnectionId: OpaqueId,
  expectedModelVersion: Version, consent: z.literal(true),
}).strict();
export const ModelCredentialRotateSchema = z.object({ key: Key, credentialId: OpaqueId, expectedVersion: Version,
  replacementModelConnectionId: OpaqueId, expectedReplacementModelVersion: Version, consent: z.literal(true),
}).strict();
export const ModelCredentialReadSchema = z.object({ credentialId: OpaqueId }).strict();
export const ModelCredentialRevokeSchema = ModelCredentialReadSchema.extend({ key: Key, expectedVersion: Version }).strict();
export const ModelCredentialResolverPinSchema = z.object({ credentialId: OpaqueId, expectedGeneration: Version }).strict();
export type ModelCredentialBinding = z.infer<typeof ModelCredentialBindingSchema>;
export type BrokerCredentialEnvelope = z.infer<typeof BrokerCredentialEnvelopeSchema>;
export type ModelCredentialMetadata = z.infer<typeof ModelCredentialMetadataSchema>;
export type ModelCredentialCreate = z.infer<typeof ModelCredentialCreateSchema>;
export type ModelCredentialRotate = z.infer<typeof ModelCredentialRotateSchema>;
export type ModelCredentialRead = z.infer<typeof ModelCredentialReadSchema>;
export type ModelCredentialRevoke = z.infer<typeof ModelCredentialRevokeSchema>;
export type ModelCredentialResolverPin = z.infer<typeof ModelCredentialResolverPinSchema>;
export type CredentialRecoveryFloor = z.infer<typeof CredentialRecoveryFloorSchema>;
