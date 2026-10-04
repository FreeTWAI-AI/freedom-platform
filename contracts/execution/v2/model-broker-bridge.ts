import { z } from 'zod';
import { OpaqueId } from '../../common/v1/identity.js';
import { MemberExecutionVersionSchema } from '../v1/member-execution.js';
import { RuntimeEnvironmentSchema } from '../v1/runtime-registration.js';
import { BootstrapClientIdSchema } from '../v1/bootstrap.js';
import { ActivateSchema, BeginSchema, ModelStepMetadataSchema } from './model-step.js';

/** Shape alone grants no delegated member authority. The pinned signer and SQL
 * original-session authorization must both be current at every effect sink. */
export const ModelBrokerLimits = Object.freeze({ authorizationMs: 60_000, responseMs: 10_000,
  compactBytes: 8192, headerBytes: 512, payloadBytes: 6144, jsonDepth: 12, jsonNodes: 256 });
const Label = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$(?![\s\S])/);
const Kid = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$(?![\s\S])/);
const Nonce = z.string().length(43).regex(/^[A-Za-z0-9_-]+$(?![\s\S])/);
const Digest = z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/);
const Time = z.iso.datetime({ precision: 3 });
const Compact = z.string().min(1).max(ModelBrokerLimits.compactBytes).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$(?![\s\S])/);
export const ModelBrokerProtectedHeaderSchema = z.object({ alg: z.literal('EdDSA'),
  typ: z.literal('freedom-model-broker-assertion+jws'), kid: Kid }).strict();
export const ModelBrokerResponseProtectedHeaderSchema = z.object({ alg: z.literal('EdDSA'),
  typ: z.literal('freedom-model-broker-response+jws'), kid: Kid }).strict();
export const ModelBrokerCommandSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('activate'), input: ActivateSchema }).strict(),
  z.object({ operation: z.literal('execute'), input: BeginSchema }).strict(),
]);
const Assertion = z.object({ profile: z.literal('model-broker.assertion/v1'), issuer: Label, audience: Label,
  environment: RuntimeEnvironmentSchema, clientId: BootstrapClientIdSchema,
  authorizationRef: OpaqueId, nonce: Nonce, commandDigest: Digest,
  recoveryGeneration: MemberExecutionVersionSchema, issuedAt: Time, expiresAt: Time });
export const ModelBrokerAssertionPayloadSchema = z.discriminatedUnion('operation', [
  Assertion.extend({ operation: z.literal('activate'), purpose: z.literal('model-broker.activate') }).strict(),
  Assertion.extend({ operation: z.literal('execute'), purpose: z.literal('model-broker.execute') }).strict(),
]);
export const ModelBrokerRequestSchema = z.object({ authorizationRef: OpaqueId, nonce: Nonce, assertion: Compact }).strict();
export const ModelBrokerProblemCodeSchema = z.enum(['model_broker_unavailable','model_broker_authorization_invalid',
  'model_broker_registry_unavailable','model_step_binding_stale','model_step_outcome_unknown','model_step_result_unavailable']);
export const ModelBrokerResponsePayloadSchema = z.object({ profile: z.literal('model-broker.response/v1'),
  issuer: Label, audience: Label, purpose: z.literal('model-broker.response'),
  environment: RuntimeEnvironmentSchema, clientId: BootstrapClientIdSchema,
  authorizationRef: OpaqueId, nonce: Nonce, commandDigest: Digest,
  recoveryGeneration: MemberExecutionVersionSchema, issuedAt: Time, expiresAt: Time,
  outcome: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('metadata'), step: ModelStepMetadataSchema }).strict(),
    z.object({ kind: z.literal('problem'), code: ModelBrokerProblemCodeSchema }).strict(),
  ]), operational_authority: z.literal(false),
}).strict();
export const ModelBrokerResponseEnvelopeSchema = z.object({ response: Compact }).strict();
export type ModelBrokerCommand = z.infer<typeof ModelBrokerCommandSchema>;
export type ModelBrokerAssertionPayload = z.infer<typeof ModelBrokerAssertionPayloadSchema>;
export type ModelBrokerProtectedHeader = z.infer<typeof ModelBrokerProtectedHeaderSchema>;
export type ModelBrokerRequest = z.infer<typeof ModelBrokerRequestSchema>;
export type ModelBrokerResponsePayload = z.infer<typeof ModelBrokerResponsePayloadSchema>;
export type ModelBrokerResponseEnvelope = z.infer<typeof ModelBrokerResponseEnvelopeSchema>;
