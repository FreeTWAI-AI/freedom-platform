import { z } from 'zod';
import { OpaqueId } from '../../common/v1/identity.js';
import { MemberExecutionVersionSchema } from '../v1/member-execution.js';
import { RuntimeEnvironmentSchema } from '../v1/runtime-registration.js';
import { BootstrapClientIdSchema } from '../v1/bootstrap.js';
import { BeginSchema, ModelStepMetadataSchema } from '../v2/model-step.js';

/** Shape alone grants no machine authority. The pinned signer and current SQL
 * device, Grant, approval, Step and credential must all hold at every effect. */
export const MachineModelBrokerLimits = Object.freeze({ authorizationMs: 60_000, responseMs: 10_000,
  compactBytes: 8192, headerBytes: 512, payloadBytes: 6144, jsonDepth: 12, jsonNodes: 256 });
const Label = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$(?![\s\S])/);
const Kid = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$(?![\s\S])/);
const Nonce = z.string().length(43).regex(/^[A-Za-z0-9_-]+$(?![\s\S])/);
const Digest = z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/);
const Time = z.iso.datetime({ precision: 3 });
const Compact = z.string().min(1).max(MachineModelBrokerLimits.compactBytes).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$(?![\s\S])/);
export const MachineModelBrokerProtectedHeaderSchema = z.object({ alg: z.literal('EdDSA'),
  typ: z.literal('freedom-machine-model-broker-assertion+jws'), kid: Kid }).strict();
export const MachineModelBrokerResponseProtectedHeaderSchema = z.object({ alg: z.literal('EdDSA'),
  typ: z.literal('freedom-machine-model-broker-response+jws'), kid: Kid }).strict();
export const MachineModelBrokerCommandSchema = z.object({ operation: z.literal('execute'), input: BeginSchema }).strict();
export const MachineModelBrokerAssertionPayloadSchema = z.object({
  profile: z.literal('machine-model-broker.assertion/v1'), issuer: Label, audience: Label,
  operation: z.literal('execute'), purpose: z.literal('machine-model-broker.execute'),
  environment: RuntimeEnvironmentSchema, clientId: BootstrapClientIdSchema,
  authorizationRef: OpaqueId, nonce: Nonce, commandDigest: Digest,
  recoveryGeneration: MemberExecutionVersionSchema, issuedAt: Time, expiresAt: Time,
}).strict();
export const MachineModelBrokerRequestSchema = z.object({ authorizationRef: OpaqueId, nonce: Nonce, assertion: Compact }).strict();
export const MachineModelBrokerProblemCodeSchema = z.enum(['machine_broker_unavailable','machine_broker_authorization_invalid',
  'machine_broker_authorization_consumed','model_step_binding_stale','model_step_outcome_unknown','model_step_result_unavailable']);
export const MachineModelBrokerResponsePayloadSchema = z.object({
  profile: z.literal('machine-model-broker.response/v1'), issuer: Label, audience: Label,
  purpose: z.literal('machine-model-broker.response'), environment: RuntimeEnvironmentSchema, clientId: BootstrapClientIdSchema,
  authorizationRef: OpaqueId, nonce: Nonce, commandDigest: Digest, recoveryGeneration: MemberExecutionVersionSchema,
  issuedAt: Time, expiresAt: Time, outcome: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('metadata'), step: ModelStepMetadataSchema }).strict(),
    z.object({ kind: z.literal('problem'), code: MachineModelBrokerProblemCodeSchema }).strict(),
  ]), operational_authority: z.literal(false),
}).strict();
export const MachineModelBrokerResponseEnvelopeSchema = z.object({ response: Compact }).strict();
export type MachineModelBrokerCommand = z.infer<typeof MachineModelBrokerCommandSchema>;
export type MachineModelBrokerAssertionPayload = z.infer<typeof MachineModelBrokerAssertionPayloadSchema>;
export type MachineModelBrokerRequest = z.infer<typeof MachineModelBrokerRequestSchema>;
export type MachineModelBrokerResponsePayload = z.infer<typeof MachineModelBrokerResponsePayloadSchema>;
export type MachineModelBrokerResponseEnvelope = z.infer<typeof MachineModelBrokerResponseEnvelopeSchema>;
