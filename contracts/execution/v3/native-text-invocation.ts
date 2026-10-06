import { z } from 'zod';
import { OpaqueId } from '../../common/v1/identity.js';
import { MemberExecutionVersionSchema } from '../v1/member-execution.js';
import { RuntimeEnvironmentSchema } from '../v1/runtime-registration.js';

/** Structural data only. D2b must derive this binding from current server SQL;
 * parsing it does not authenticate a device, claim an Attempt or permit spawn. */
export const NativeTextLimits = Object.freeze({ inputBytes: 16384, outputBytes: 16384,
  stdoutBytes: 65536, stderrBytes: 8192, chunks: 256, wallMs: 60000, leaseMs: 90000, startMs: 5000 });
const Digest = z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/);
const Time = z.iso.datetime({ precision: 3 });
const Version = MemberExecutionVersionSchema;
export const NativeTextBindingSchema = z.object({
  profile: z.literal('freedom.native-text.binding/v1'),
  adapterProfile: z.literal('grok-1.0.46-text/v1'),
  dispatchId: OpaqueId, attemptId: OpaqueId, runId: OpaqueId, workId: OpaqueId,
  ownerPrincipalId: OpaqueId, scopeId: OpaqueId, environment: RuntimeEnvironmentSchema,
  clientId: z.literal('agent-kit'), runtimeDeviceId: OpaqueId, connectionId: OpaqueId, familyId: OpaqueId,
  deviceKeyThumbprint: z.string().length(43).regex(/^[A-Za-z0-9_-]+$(?![\s\S])/),
  grantId: OpaqueId, grantVersion: Version, modelConnectionId: OpaqueId, modelVersion: Version,
  approvalId: OpaqueId, approvalVersion: Version, inputWorkVersion: Version, runVersion: Version,
  runtimeVersion: Version, connectionVersion: Version, taskLeaseEpoch: Version, controlEpoch: Version,
  exportPolicyId: OpaqueId, exportPolicyRevision: Version, persistencePolicyRevision: z.string().min(1).max(64),
  recoveryGeneration: Version,
  requestedModelRef: z.literal('grok-4.7'), expectedReportedModelRef: z.literal('grok-4.7-build'),
  engineLocation: z.literal('runtime_local'), processingLocation: z.literal('provider_remote'),
  credentialCustody: z.literal('runtime_cli'), billingSource: z.literal('owner_cli'),
  artifactCustody: z.literal('platform_asset'), capability: z.literal('assisted_local'),
  contextSha256: Digest, inputByteSize: z.number().int().min(1).max(NativeTextLimits.inputBytes),
  activatedAt: Time, leaseExpiresAt: Time, wallTimeoutMs: z.number().int().min(1).max(NativeTextLimits.wallMs),
  maxLocalDispatches: z.literal(1), providerCallLimit: z.literal('unknown'), monetaryLimit: z.literal('unknown'),
}).strict();
export const NativeTextContextSchema = z.object({ schema: z.literal('native-text.context/v1'),
  title: z.string().min(1).max(NativeTextLimits.inputBytes), objective: z.string().min(1).max(NativeTextLimits.inputBytes),
}).strict();
const receipt = z.object({ profile: z.literal('freedom.native-text.receipt/v1'),
  dispatchId: OpaqueId, attemptId: OpaqueId, runId: OpaqueId, bindingSha256: Digest, contextSha256: Digest,
  adapterProfile: z.literal('grok-1.0.46-text/v1'), executableSha256: Digest,
  requestedModelRef: z.literal('grok-4.7'),
  evidenceOrigin: z.enum(['native_cli_local_observed', 'synthetic_local_fixture']),
  assurance: z.literal('local_observed'), capability: z.literal('assisted_local'),
  localDispatches: z.literal(1), providerCalls: z.literal('unknown'), usageStatus: z.literal('unknown'),
  costStatus: z.literal('unknown'), operational_authority: z.literal(false),
});
export const NativeTextReceiptSchema = z.discriminatedUnion('outcome', [
  receipt.extend({ outcome: z.literal('observed_success'), reportedModelRef: z.literal('grok-4.7-build'),
    outputSha256: Digest, outputByteSize: z.number().int().min(1).max(NativeTextLimits.outputBytes) }).strict(),
  receipt.extend({ outcome: z.literal('observed_unknown'), reportedModelRef: z.null(),
    outputSha256: z.null(), outputByteSize: z.null() }).strict(),
]);
export type NativeTextBinding = z.infer<typeof NativeTextBindingSchema>;
export type NativeTextContext = z.infer<typeof NativeTextContextSchema>;
export type NativeTextReceipt = z.infer<typeof NativeTextReceiptSchema>;
