import { z } from 'zod';
import { OpaqueId } from '../../common/v1/identity.js';
import { MemberExecutionVersionSchema, ModelSelectionSchema, ExecutionGrantMetadataSchema } from '../v1/member-execution.js';
import { RuntimeEnvironmentSchema } from '../v1/runtime-registration.js';
import { BootstrapClientIdSchema } from '../v1/bootstrap.js';

const Key = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$(?![\s\S])/);
const Version = MemberExecutionVersionSchema;
export const ModelStepLimits = Object.freeze({ inputBytes: 16384, outputBytes: 16384, outputTokens: 4096, steps: 1, calls: 1 });
export const ApprovalCreateSchema = z.object({ key: Key, runId: OpaqueId, grantId: OpaqueId,
  expectedRunVersion: Version, expectedGrantVersion: Version, expectedWorkVersion: Version,
  consent: z.literal(true), maxOutputTokens: z.number().int().min(1).max(ModelStepLimits.outputTokens),
}).strict();
export const ActivateSchema = z.object({ key: Key, approvalId: OpaqueId,
  expectedApprovalVersion: Version, expectedRunVersion: Version }).strict();
export const BeginSchema = z.object({ key: Key, stepId: OpaqueId, expectedVersion: Version }).strict();
export const ReadSchema = z.object({ stepId: OpaqueId }).strict();
export const ControlSchema = z.object({ key: Key, stepId: OpaqueId, expectedVersion: Version,
  action: z.enum(['pause', 'stop']) }).strict();
export const ApprovalReadSchema = z.object({ approvalId: OpaqueId }).strict();
export const ApprovalRevokeSchema = ApprovalReadSchema.extend({ key: Key, expectedVersion: Version }).strict();

/** Exact, ordered context encoding is performed by the host module. This schema
 * describes data only; accepting it never approves an inference export. */
export const ModelStepContextSchema = z.object({ schema: z.literal('model-step.context/v1'),
  title: z.string().min(1).max(ModelStepLimits.inputBytes),
  objective: z.string().min(1).max(ModelStepLimits.inputBytes),
}).strict();
export const ModelStepEvidenceOriginSchema = z.enum(['provider_https', 'synthetic_local_fixture']);
export const ModelStepUsageSchema = z.object({ inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  outputTokens: z.number().int().min(1).max(ModelStepLimits.outputTokens),
  totalTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
const Digest = z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/);
const Time = z.iso.datetime({ precision: 3 });
const Policy = ExecutionGrantMetadataSchema.shape.policyRevision;
export const ModelStepBindingSchema = z.object({ profile: z.literal('model-step.binding/v1'),
  stepId: OpaqueId, attemptId: OpaqueId, intentId: OpaqueId, approvalId: OpaqueId, approvalVersion: Version,
  runId: OpaqueId, workId: OpaqueId, inputWorkVersion: Version, baseRunVersion: Version, runVersion: Version,
  baseTaskLeaseEpoch: Version, taskLeaseEpoch: Version, controlEpoch: Version,
  ownerUserId: OpaqueId, ownerPrincipalId: OpaqueId, scopeId: OpaqueId,
  environment: RuntimeEnvironmentSchema, clientId: BootstrapClientIdSchema,
  runtimeDeviceId: OpaqueId, runtimeVersion: Version, connectionId: OpaqueId, connectionVersion: Version,
  familyId: OpaqueId, modelConnectionId: OpaqueId, modelVersion: Version, selection: ModelSelectionSchema,
  grantId: OpaqueId, grantVersion: Version, persistencePolicyRevision: Policy,
  exportPolicyId: OpaqueId, exportPolicyRevision: Version, contextSha256: Digest,
  inputByteSize: z.number().int().min(1).max(ModelStepLimits.inputBytes),
  maxOutputTokens: z.number().int().min(1).max(ModelStepLimits.outputTokens),
}).strict();
export const ModelStepApprovalMetadataSchema = z.object({ approvalId: OpaqueId, runId: OpaqueId, workId: OpaqueId,
  grantId: OpaqueId, inputWorkVersion: Version, selection: ModelSelectionSchema, exportPolicyRevision: Version,
  maxOutputTokens: z.number().int().min(1).max(ModelStepLimits.outputTokens), contextSha256: Digest,
  inputByteSize: z.number().int().min(1).max(ModelStepLimits.inputBytes), aggregateVersion: Version,
  state: z.enum(['active', 'revoked']), issuedAt: Time, expiresAt: Time, operational_authority: z.literal(false),
}).strict();
export const ModelStepMetadataSchema = z.object({ stepId: OpaqueId, attemptId: OpaqueId,
  attemptNumber: z.number().int().min(1).max(16), runId: OpaqueId, workId: OpaqueId, inputWorkVersion: Version,
  approvalId: OpaqueId, state: z.enum(['reserved', 'dispatched', 'awaiting_result', 'outcome_unknown', 'cancelled', 'succeeded']),
  aggregateVersion: Version, activatedRunVersion: Version, taskLeaseEpoch: Version, controlEpoch: Version,
  selection: ModelSelectionSchema, evidenceOrigin: ModelStepEvidenceOriginSchema, expiresAt: Time,
  usageStatus: z.enum(['not_dispatched', 'unknown', 'known']), costStatus: z.literal('unknown'), operational_authority: z.literal(false),
}).strict();
// Selection remains an explicit member label. Only private host verification
// and current backing-record checks can associate it with a transport.
export { ModelSelectionSchema };
export type ModelStepApprovalCreateInput = z.infer<typeof ApprovalCreateSchema>;
export type ModelStepActivateInput = z.infer<typeof ActivateSchema>;
export type ModelStepBeginInput = z.infer<typeof BeginSchema>;
export type ModelStepReadInput = z.infer<typeof ReadSchema>;
export type ModelStepControlInput = z.infer<typeof ControlSchema>;
export type ModelStepApprovalReadInput = z.infer<typeof ApprovalReadSchema>;
export type ModelStepApprovalRevokeInput = z.infer<typeof ApprovalRevokeSchema>;
export type ModelStepBinding = z.infer<typeof ModelStepBindingSchema>;
export type ModelStepApprovalMetadata = z.infer<typeof ModelStepApprovalMetadataSchema>;
export type ModelStepMetadata = z.infer<typeof ModelStepMetadataSchema>;
export type ModelStepContext = z.infer<typeof ModelStepContextSchema>;
export type ModelStepEvidenceOrigin = z.infer<typeof ModelStepEvidenceOriginSchema>;
export type ModelStepUsage = z.infer<typeof ModelStepUsageSchema>;
