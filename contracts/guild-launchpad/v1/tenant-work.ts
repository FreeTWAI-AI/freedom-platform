import { z } from 'zod';
import { OpaqueId } from '../../common/v1/identity.js';
import { PageSchema, VersionSchema } from './tenant.js';

// Zero is a real retained-byte or quota figure. VersionSchema stays positive.
export const DecimalSchema = z.string().regex(/^(0|[1-9][0-9]{0,18})$/);
export const ProgressSchema = z.enum(['todo', 'in_progress', 'done']);
export const GuildKeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,80}$/);
const control = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uD800-\uDFFF]/u;

export const WorkTitleSchema = z.string().min(1).max(120).refine(value => value.trim().length > 0
  && Buffer.byteLength(value) <= 480 && !control.test(value), '標題含有不允許的字元。');
export const WorkObjectiveSchema = z.string().min(1).refine(value => value.trim().length > 0
  && Buffer.byteLength(value) <= 16384 && !control.test(value), '目的含有不允許的字元。');
export const DisplayNameSchema = z.string().min(1).max(120).refine(value => Buffer.byteLength(value) <= 480
  && !/[\\/\u0000-\u001f\u007f\uD800-\uDFFF]/.test(value), '檔名含有不允許的字元。');
export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const ContentTypeSchema = z.enum(['text/plain', 'text/markdown']);

export const ResourceRefSchema = z.object({
  tenant_id: OpaqueId,
  instance_id: OpaqueId,
  resource_type: z.enum(['work.work', 'work.upload', 'work.result']),
  resource_id: OpaqueId,
}).strict();
export const OperationSchema = z.object({
  operation_id: OpaqueId,
  state: z.literal('succeeded'),
  version: VersionSchema,
  resource_ref: ResourceRefSchema,
}).strict();

export const WorkSchema = z.object({
  work_id: OpaqueId,
  tenant_id: OpaqueId,
  workspace_id: OpaqueId,
  instance_id: OpaqueId,
  title: WorkTitleSchema,
  objective: WorkObjectiveSchema,
  progress: ProgressSchema,
  state: z.enum(['draft', 'archived']),
  version: VersionSchema,
  current_result_id: OpaqueId.optional(),
  updated_at: z.string(),
}).strict();
export const WorkPageSchema = PageSchema(WorkSchema);

export const WorkWriteSchema = z.object({
  title: WorkTitleSchema,
  objective: WorkObjectiveSchema,
  progress: ProgressSchema,
}).strict();
export const EmptyObjectSchema = z.object({}).strict();

export const UploadPrepareSchema = z.object({
  content_type: ContentTypeSchema,
  byte_size: z.number().int().min(1).max(262144),
  sha256: Sha256Schema,
  display_name: DisplayNameSchema,
  expected_work_version: VersionSchema,
}).strict();
export const UploadSchema = z.object({
  upload_id: OpaqueId,
  work_id: OpaqueId,
  asset_id: OpaqueId,
  phase: z.enum(['prepared', 'processing', 'stored', 'finalized']),
  expires_at: z.string(),
  version: VersionSchema,
  byte_size: z.number().int().min(1).max(262144),
  sha256: Sha256Schema,
  content_type: ContentTypeSchema,
  display_name: DisplayNameSchema,
}).strict();
export const UploadVerifiedSchema = z.object({
  upload_id: OpaqueId,
  verified: z.literal(true),
  version: VersionSchema,
}).strict();
export const FinalizeSchema = z.object({ expected_work_version: VersionSchema }).strict();

export const ResultSchema = z.object({
  result_id: OpaqueId,
  work_id: OpaqueId,
  asset_id: OpaqueId,
  revision: VersionSchema,
  work_version: VersionSchema,
  provenance: z.literal('human'),
  content_type: ContentTypeSchema,
  byte_size: z.number().int().min(1).max(262144),
  sha256: Sha256Schema,
  created_at: z.string(),
  display_name: DisplayNameSchema,
}).strict();
export const ResultPageSchema = PageSchema(ResultSchema);

export const ModuleInstanceStatusSchema = z.enum(['provisioning', 'active', 'suspended', 'archived']);
export const ModuleInstanceViewSchema = z.object({
  instance_id: OpaqueId,
  tenant_id: OpaqueId,
  module_key: z.string(),
  application_release_ref: z.string(),
  data_schema_version: z.string(),
  status: ModuleInstanceStatusSchema,
  binding_id: OpaqueId,
  authority_epoch: VersionSchema,
  version: VersionSchema,
  configuration_revision: VersionSchema,
}).strict();
export const ModuleInstancePageSchema = PageSchema(ModuleInstanceViewSchema);

export const ReuseChoiceSchema = z.object({
  kind: z.literal('reuse'),
  instance_id: OpaqueId,
  expected_version: VersionSchema,
}).strict();
export const CreateChoiceSchema = z.object({ kind: z.literal('create_new') }).strict();
export const EnableManualWorkSchema = z.object({
  guild_key: GuildKeySchema,
  choice: z.discriminatedUnion('kind', [CreateChoiceSchema, ReuseChoiceSchema]).optional(),
}).strict();
export const ManualWorkBindingSchema = z.object({
  instance_id: OpaqueId,
  tenant_id: OpaqueId,
  workspace_id: OpaqueId,
  binding_id: OpaqueId,
  version: VersionSchema,
  entry_capability: z.literal('work:create'),
  reused: z.boolean(),
}).strict();

export const CapacitySummarySchema = z.object({
  policy_revision: VersionSchema.nullable(),
  used: DecimalSchema,
  reserved: DecimalSchema,
  limit: DecimalSchema.nullable(),
}).strict();
export const LaunchpadContextSchema = z.object({
  tenant_id: OpaqueId,
  workspace_id: OpaqueId,
  source_version: VersionSchema,
  instances: z.array(ModuleInstanceViewSchema).max(100),
  work_page: WorkPageSchema,
  capacity_summary: CapacitySummarySchema,
  connection_summary: z.array(z.object({
    instance_id: OpaqueId,
    status: z.literal('hosted_active'),
  }).strict()).max(20),
}).strict();

const limit50 = z.string().regex(/^(?:[1-9]|[1-4][0-9]|50)$/).transform(Number);
const limit100 = z.string().regex(/^(?:[1-9]|[1-9][0-9]|100)$/).transform(Number);
export const WorkListQuerySchema = z.object({
  q: z.string().min(1).max(120).optional(),
  limit: limit50.optional(),
  cursor: z.string().min(1).max(512).optional(),
}).strict();
export const ResultListQuerySchema = z.object({
  limit: limit50.optional(),
  cursor: z.string().min(1).max(512).optional(),
}).strict();
export const InstanceListQuerySchema = z.object({
  module_key: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).optional(),
  status: ModuleInstanceStatusSchema.optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: limit100.optional(),
}).strict();
export const LaunchpadQuerySchema = z.object({ guild_key: GuildKeySchema }).strict();

export const InstanceCandidateSchema = z.object({
  instance_id: OpaqueId,
  version: VersionSchema,
  created_at: z.string(),
  bound_workspace_count: z.number().int().min(0),
}).strict();

export type Operation = z.infer<typeof OperationSchema>;
export type WorkView = z.infer<typeof WorkSchema>;
export type UploadView = z.infer<typeof UploadSchema>;
export type ResultView = z.infer<typeof ResultSchema>;
export type ModuleInstanceView = z.infer<typeof ModuleInstanceViewSchema>;
export type ManualWorkBinding = z.infer<typeof ManualWorkBindingSchema>;
export type InstanceCandidate = z.infer<typeof InstanceCandidateSchema>;
