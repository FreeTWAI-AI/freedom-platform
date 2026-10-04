import { z } from 'zod';
import { OpaqueId, PrincipalRefSchema, ResourceScopeRefSchema } from '../../common/v1/identity.js';

// Local, closed decision contract. References/assertions are NEVER credentials.
// No digest computation or JCS/signature profile is implemented by this schema.
export const ExecutionVersion = z.string().regex(/^[1-9][0-9]{0,18}$(?![\s\S])/).max(19);
export const DigestRef = z.string().length(64).regex(/^[0-9a-f]{64}$/);
const Label = z.string().min(1).max(96).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$(?![\s\S])/);
const Time = z.iso.datetime({ precision: 3 });
export const RunState = z.enum(['created', 'preflighting', 'ready', 'running', 'waiting_human', 'waiting_engine',
  'paused', 'blocked', 'reconciling', 'cancelling', 'cancelled', 'completed', 'failed', 'manual_unknown']);
export const AttemptBindingSchema = z.object({
  attempt_id: OpaqueId, run_id: OpaqueId, attempt_number: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  runtime_id: OpaqueId, connection_id: OpaqueId, grant_id: OpaqueId, grant_revision: ExecutionVersion,
  inference_binding_id: OpaqueId, provider_ref: Label, model_ref: Label,
  engine_location: z.enum(['runtime_local', 'platform']), processing_location: Label,
  artifact_custody: z.enum(['runtime_local', 'platform_asset']), credential_custody: z.enum(['official_cli', 'local_keychain', 'platform_vault']),
  billing_source: z.enum(['user_cli_subscription', 'user_api', 'platform_system']),
  data_policy_revision: Label, contract_version: Label, adapter_version: Label,
}).strict();
export const DispatchSchema = z.object({
  dispatch_id: OpaqueId, attempt_id: OpaqueId, step_id: OpaqueId, request_digest: DigestRef,
  task_epoch: ExecutionVersion, control_epoch: ExecutionVersion, grant_revision: ExecutionVersion,
  policy_revision: Label, recovery_generation: ExecutionVersion,
  state: z.enum(['proposed', 'in_flight', 'succeeded', 'failed_known', 'unknown', 'manual_unknown', 'cancelled_before_dispatch']),
  usage: z.enum(['not_dispatched', 'known', 'unknown']),
}).strict();
export const EvidenceSchema = z.object({
  evidence_id: OpaqueId, dispatch_id: OpaqueId, attempt_id: OpaqueId, evidence_digest: DigestRef,
  observation: z.enum(['observed_success', 'observed_failure', 'observed_unknown']),
  usage_observation: z.enum(['known', 'unknown']),
}).strict();
export const RunSnapshotSchema = z.object({
  run_id: OpaqueId, work_id: OpaqueId,
  owner: PrincipalRefSchema.extend({ kind: z.literal('person') }),
  scope: ResourceScopeRefSchema.extend({ kind: z.literal('personal') }),
  version: ExecutionVersion, work_version: ExecutionVersion, state: RunState,
  desired_control: z.enum(['run', 'pause', 'stop']),
  current_attempt_id: OpaqueId.nullable(), attempts: z.array(AttemptBindingSchema).max(16),
  task_lease: z.object({ epoch: ExecutionVersion, expires_at: Time.nullable() }).strict(),
  control: z.object({ epoch: ExecutionVersion, acknowledged_epoch: ExecutionVersion.nullable() }).strict(),
  recovery_generation: ExecutionVersion,
  dispatches: z.array(DispatchSchema).max(128), evidence: z.array(EvidenceSchema).max(128),
  result: z.object({ result_id: OpaqueId, attempt_id: OpaqueId, work_version: ExecutionVersion, provenance: z.literal('model_draft') }).strict().nullable(),
}).strict();

// Caller-asserted facts for a hypothetical decision, NOT a VerifiedContext.
export const AssertionsSchema = z.object({
  actor_kind: z.enum(['owner', 'runtime', 'runtime_evidence']), principal_id: OpaqueId,
  runtime_id: OpaqueId.nullable(), connection_id: OpaqueId.nullable(),
  owner_active: z.boolean(), scope_active: z.boolean(), work_active: z.boolean(), work_version: ExecutionVersion,
  connection_active: z.boolean(), runtime_online: z.boolean(), model_ready: z.boolean(), budget_available: z.boolean(),
  policy_allowed: z.boolean(), policy_revision: Label,
  grant_id: OpaqueId.nullable(), grant_revision: ExecutionVersion, grant_active: z.boolean(), grant_expires_at: Time,
  recovery_generation: ExecutionVersion, task_epoch: ExecutionVersion, control_epoch: ExecutionVersion,
  evidence_expires_at: Time.nullable(),
}).strict();
const event = <T extends string>(type: T) => z.object({ type: z.literal(type) }).strict();
export const ExecutionEventSchema = z.discriminatedUnion('type', [
  event('preflight').extend({ binding: AttemptBindingSchema }),
  event('activate').extend({ expires_at: Time }),
  event('advance_model').extend({ dispatch_id: OpaqueId, step_id: OpaqueId, request_digest: DigestRef }),
  event('record_dispatch').extend({ dispatch_id: OpaqueId }),
  event('record_outcome').extend({ dispatch_id: OpaqueId, outcome: z.enum(['succeeded', 'failed_known', 'unknown']), usage: z.enum(['known', 'unknown']) }),
  event('wait').extend({ reason: z.enum(['human', 'engine']) }), event('pause'), event('resume'), event('stop'), event('revoke'),
  event('block').extend({ reason: z.enum(['runtime_offline', 'model_unavailable', 'policy_unavailable', 'grant_unavailable', 'budget_unavailable', 'recovery_generation_mismatch']) }),
  event('control_ack').extend({ epoch: ExecutionVersion }),
  event('late_evidence').extend({ evidence: EvidenceSchema }),
  event('reconcile_dispatch').extend({ dispatch_id: OpaqueId, evidence_id: OpaqueId, outcome: z.enum(['succeeded', 'failed_known', 'manual_unknown']), usage: z.enum(['known', 'unknown']) }),
  event('handoff').extend({ binding: AttemptBindingSchema }),
  event('publication_decision').extend({ result_id: OpaqueId, attempt_id: OpaqueId, expected_work_version: ExecutionVersion, provenance: z.literal('model_draft') }),
  event('complete'), event('fail'),
]);
export const ExecutionInputSchema = z.object({
  profile: z.literal('freedom.execution.decision/v1'), now: Time, expected_version: ExecutionVersion,
  snapshot: RunSnapshotSchema, assertions: AssertionsSchema, event: ExecutionEventSchema,
}).strict();
export type AttemptBinding = z.infer<typeof AttemptBindingSchema>;
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;
export type ExecutionInput = z.infer<typeof ExecutionInputSchema>;
export type ExecutionEvent = z.infer<typeof ExecutionEventSchema>;
