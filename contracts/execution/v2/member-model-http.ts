import { z } from 'zod';
import { OpaqueId } from '../../common/v1/identity.js';
import { MemberExecutionVersionSchema as Version, ModelConnectionMetadataSchema, ExecutionGrantMetadataSchema, ModelSelectionSchema } from '../v1/member-execution.js';
import { ModelStepApprovalMetadataSchema, ModelStepMetadataSchema, ModelStepLimits } from './model-step.js';

// Wire bodies contain exact secondary versions only. The primary CAS and
// idempotency key are accepted solely from If-Match and Idempotency-Key.
export const MemberModelHttpApprovalCreateSchema = z.object({ runId: OpaqueId, grantId: OpaqueId,
  expectedGrantVersion: Version, expectedWorkVersion: Version, consent: z.literal(true),
  maxOutputTokens: z.number().int().min(1).max(ModelStepLimits.outputTokens),
}).strict();
export const MemberModelHttpActivateSchema = z.object({ approvalId: OpaqueId, expectedRunVersion: Version }).strict();
export const MemberModelHttpEmptySchema = z.object({}).strict();
export const MemberModelHttpWorkMetadataSchema = z.object({ workId: OpaqueId, title: z.string().min(1).max(120),
  state: z.enum(['draft','archived']), aggregateVersion: Version }).strict();
export const MemberModelHttpRunMetadataSchema = z.object({ runId: OpaqueId, workId: OpaqueId, inputWorkVersion: Version,
  state: z.enum(['created','running','paused','cancelled','reconciling','succeeded']), aggregateVersion: Version }).strict();
export const MemberModelHttpConnectionMetadataSchema = z.object({ connectionId: OpaqueId, runtimeDeviceId: OpaqueId,
  state: z.enum(['active','revoked']), aggregateVersion: Version, expiresAt: z.iso.datetime({precision:3}) }).strict();
const list = <T extends z.ZodType>(schema: T) => z.array(schema).max(50);
export const MemberModelHttpOverviewSchema = z.object({
  works: list(MemberModelHttpWorkMetadataSchema), runs: list(MemberModelHttpRunMetadataSchema),
  connections: list(MemberModelHttpConnectionMetadataSchema), models: list(ModelConnectionMetadataSchema),
  grants: list(ExecutionGrantMetadataSchema), approvals: list(ModelStepApprovalMetadataSchema), steps: list(ModelStepMetadataSchema),
  allowedSelections: list(z.object({selection:ModelSelectionSchema,maxOutputTokens:z.number().int().min(1).max(ModelStepLimits.outputTokens)}).strict()),
  persistenceAvailable:z.boolean(), configuration:z.literal('configured'), limit: z.literal(50), operational_authority: z.literal(false),
}).strict().describe('Bounded current member-owned metadata discovery. Record states, labels and versions do not confer execution authority. No prompt, credentials, provider URLs, capabilities, observations or result text.');
export type MemberModelHttpApprovalCreate = z.infer<typeof MemberModelHttpApprovalCreateSchema>;
export type MemberModelHttpActivate = z.infer<typeof MemberModelHttpActivateSchema>;
export type MemberModelHttpOverview = z.infer<typeof MemberModelHttpOverviewSchema>;
