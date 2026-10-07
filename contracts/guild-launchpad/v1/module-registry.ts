import { z } from 'zod';
import { OpaqueId } from '../../common/v1/identity.js';
import { CapabilityKey, GuildKey, StableKey, Version, page } from './primitives.js';
import { IsoTimeSchema, ReasonSchema } from './tenant.js';

export { CapabilityKey } from './primitives.js';
export const ReleaseRef = z.string().min(1).max(160);
export const ContractRefSchema = z.object({
  family: z.string().min(1).max(160),
  version: Version,
  source_commit: z.string().regex(/^[0-9a-f]{40}$/),
  artifact_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  behavior_profile: z.string().min(1).max(160),
}).strict();
export const DigestSchema = z.object({
  algorithm: z.literal('sha256'),
  value: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export const PolicyRefSchema = z.object({
  policy_key: StableKey,
  version: Version,
}).strict();

export const RequirementSchema = z.object({
  requirement_key: StableKey,
  module_key: StableKey,
  capabilities: z.array(CapabilityKey).max(50),
  required: z.boolean(),
  compatible_contracts: z.array(ContractRefSchema).max(20),
  cardinality: z.literal('one'),
  allow_reuse: z.boolean(),
}).strict();

export const ReuseDependencySchema = z.object({
  requirement_key: StableKey,
  choice: z.literal('reuse'),
  instance_id: OpaqueId,
  expected_version: Version,
}).strict();
export const CreateDependencySchema = z.object({
  requirement_key: StableKey,
  choice: z.literal('create'),
  configuration: z.unknown(),
}).strict();
export const DependencyChoiceSchema = z.discriminatedUnion('choice', [ReuseDependencySchema, CreateDependencySchema]);

export const EligibilitySchema = z.object({
  can_launch: z.boolean(),
  reason_codes: z.array(z.enum([
    'guild_full_member_required', 'tenant_manage_required', 'policy_unconfigured', 'application_not_available',
  ])).max(8),
  required_guild_tier: z.literal('full'),
  tenant_action: z.enum(['select', 'create', 'continue', 'denied']),
  policy_revision: Version,
}).strict();

export const ApplicationViewSchema = z.object({
  application_key: StableKey,
  release_ref: ReleaseRef,
  display_name: z.string(),
  module_requirements: z.array(RequirementSchema).max(20),
  runtime_profiles: z.array(z.enum(['hosted-reviewed', 'external-supported'])).max(8),
  launch_policy_ref: PolicyRefSchema,
  license_state: z.enum(['unresolved', 'reviewed', 'blocked']),
  release_status: z.enum(['draft', 'reviewed', 'available', 'retired']),
  version: Version,
  eligibility: EligibilitySchema.optional(),
}).strict();

export const ApplicationReleaseViewSchema = ApplicationViewSchema.omit({ eligibility: true }).extend({
  source_commit: z.string().regex(/^[0-9a-f]{40}$/),
  artifact_digest: DigestSchema,
  skill_book_refs: z.array(z.string()).max(50),
  license_review_ref: z.string().nullable(),
}).strict();

export const InstanceStatusSchema = z.enum(['requested', 'provisioning', 'active', 'failed', 'suspended', 'archived']);
export const InstanceViewSchema = z.object({
  instance_id: OpaqueId,
  tenant_id: OpaqueId,
  module_key: StableKey,
  application_release_ref: ReleaseRef,
  data_schema_version: Version,
  contract_ref: ContractRefSchema,
  status: InstanceStatusSchema,
  binding_id: OpaqueId,
  authority_epoch: Version,
  version: Version,
  configuration_revision: Version,
}).strict();
export const InstanceDependencySchema = z.object({
  requirement_key: StableKey,
  provider_instance_id: OpaqueId,
  version: Version,
}).strict();
export const InstanceImpactSchema = z.object({
  consumer_count: z.number().int().nonnegative(),
  consumers: z.array(z.object({
    caller_instance_id: OpaqueId,
    requirement_key: StableKey,
    module_key: StableKey,
    status: InstanceStatusSchema,
  }).strict()).max(50),
  workspace_count: z.number().int().nonnegative(),
  workspace_ids: z.array(OpaqueId).max(50),
}).strict();
export const InstanceSuspensionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('member'), operation_id: OpaqueId, suspended_at: IsoTimeSchema, reason: ReasonSchema,
  }).strict(),
  z.object({
    kind: z.literal('platform'), operation_id: z.null(), suspended_at: z.null(), reason: z.null(),
  }).strict(),
]);
export const InstanceArchiveSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('member'), operation_id: OpaqueId, archived_at: IsoTimeSchema, reason: ReasonSchema,
  }).strict(),
  z.object({
    kind: z.literal('platform'), operation_id: z.null(), archived_at: z.null(), reason: z.null(),
  }).strict(),
]);
export const InstanceDetailSchema = InstanceViewSchema.extend({
  dependencies: z.array(InstanceDependencySchema).max(50),
  impact: InstanceImpactSchema,
  suspension: InstanceSuspensionSchema.nullable(),
  archive: InstanceArchiveSchema.nullable(),
}).strict().refine(value => (value.status === 'suspended') === (value.suspension !== null),
  '暫停資訊須與模組實例狀態一致。').refine(value => (value.status === 'archived') === (value.archive !== null),
  '封存資訊須與模組實例狀態一致。');

export const InstallationViewSchema = z.object({
  installation_id: OpaqueId,
  tenant_id: OpaqueId,
  workspace_id: OpaqueId,
  application_key: StableKey,
  release_ref: ReleaseRef,
  status: InstanceStatusSchema,
  version: Version,
  modules: z.array(z.object({
    requirement_key: StableKey,
    instance_id: OpaqueId,
  }).strict()).max(20),
}).strict();

export const LaunchPlanSchema = z.object({
  plan_id: OpaqueId,
  version: Version,
  tenant_id: OpaqueId,
  workspace_id: OpaqueId,
  application_key: StableKey,
  release_ref: ReleaseRef,
  expires_at: IsoTimeSchema,
  policy_revision: Version,
  choices: z.array(DependencyChoiceSchema).max(20),
  capacity_delta: z.array(z.object({
    dimension: StableKey,
    units: Version,
  }).strict()).max(40),
  warnings: z.array(z.object({
    code: z.string(),
    requirement_key: StableKey.optional(),
  }).strict()).max(40),
  configuration_digest: DigestSchema,
}).strict();

export const PlanInputSchema = z.object({
  guild_key: GuildKey,
  workspace_id: OpaqueId,
  application_key: StableKey,
  release_ref: ReleaseRef,
  installation_choice: z.enum(['reuse_existing', 'create_new']),
  existing_installation_id: OpaqueId.optional(),
  dependencies: z.array(DependencyChoiceSchema).max(20),
  configuration: z.unknown(),
}).strict();

export const LaunchInputSchema = z.object({
  plan_id: OpaqueId,
  expected_plan_version: Version,
  configuration_digest: DigestSchema,
}).strict();

export const RegistryOperationSchema = z.object({
  operation_id: OpaqueId,
  state: z.enum(['requested', 'running', 'succeeded', 'failed', 'needs_reconciliation', 'cancelled']),
  version: Version,
  retry_after_seconds: z.number().int().min(0).max(86400).optional(),
  problem: z.object({ code: z.string(), detail: z.string() }).strict().optional(),
}).strict();

export const ArchiveInputSchema = z.object({ reason: ReasonSchema }).strict();
export const SuspendInputSchema = z.object({ reason: ReasonSchema }).strict();
export const ResumeInputSchema = z.object({}).strict();

export const CancelInputSchema = z.object({ reason: z.literal('member_cancelled') }).strict();
export const ReconcileInputSchema = z.object({}).strict();

const limit100 = z.string().regex(/^(?:[1-9]|[1-9][0-9]|100)$/).transform(Number);
export const CatalogQuerySchema = z.object({
  guild_key: GuildKey.optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: limit100.optional(),
}).strict();
export const InstanceQuerySchema = z.object({
  module_key: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).optional(),
  status: InstanceStatusSchema.optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: limit100.optional(),
}).strict();
export const InstallationQuerySchema = z.object({
  application_key: StableKey.optional(),
  workspace_id: OpaqueId.optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: limit100.optional(),
}).strict();

export const ApplicationPageSchema = page(ApplicationViewSchema);
export const InstancePageSchema = page(InstanceViewSchema);
export const InstallationPageSchema = page(InstallationViewSchema);

export type ApplicationView = z.infer<typeof ApplicationViewSchema>;
export type InstanceView = z.infer<typeof InstanceViewSchema>;
export type InstallationView = z.infer<typeof InstallationViewSchema>;
export type LaunchPlan = z.infer<typeof LaunchPlanSchema>;
export type RegistryOperation = z.infer<typeof RegistryOperationSchema>;
export type Eligibility = z.infer<typeof EligibilitySchema>;
