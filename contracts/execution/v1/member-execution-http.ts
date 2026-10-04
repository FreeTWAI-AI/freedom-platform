import { z } from 'zod';
import { OpaqueId } from '../../common/v1/identity.js';
import { MemberExecutionVersionSchema, ModelSelectionSchema } from './member-execution.js';
import { RunState } from './state.js';

// Member HTTP wire bodies only. Authentication, CSRF/Origin, idempotency and
// primary CAS belong to the transport; they are never accepted from body JSON.
// These operations manage unexecuted records and grant no model/effect authority.
export const MemberExecutionHttpRunCreateSchema = z.object({ workId: OpaqueId }).strict();
export const MemberExecutionHttpEmptySchema = z.object({}).strict();
export const MemberExecutionHttpModelCreateSchema = z.object({
  connectionId: OpaqueId, selection: ModelSelectionSchema,
}).strict();
export const MemberExecutionHttpGrantCreateSchema = z.object({
  expectedWorkVersion: MemberExecutionVersionSchema,
  connectionId: OpaqueId, expectedConnectionVersion: MemberExecutionVersionSchema,
  modelConnectionId: OpaqueId, expectedModelVersion: MemberExecutionVersionSchema,
  consent: z.literal(true),
}).strict();
export const MemberExecutionHttpAttemptCreateSchema = z.object({
  grantId: OpaqueId, expectedGrantVersion: MemberExecutionVersionSchema,
}).strict();

// Exact existing closed Run DTO; no service signature or general RunSnapshot
// replacement. Non-secret epochs remain metadata, never execution credentials.
export const MemberExecutionHttpRunMetadataSchema = z.object({
  runId: OpaqueId, workId: OpaqueId, inputWorkVersion: MemberExecutionVersionSchema,
  aggregateVersion: MemberExecutionVersionSchema, state: RunState.extract(['created', 'paused', 'cancelled']),
  taskLeaseEpoch: MemberExecutionVersionSchema, controlEpoch: MemberExecutionVersionSchema,
  operational_authority: z.literal(false),
}).strict().describe('Existing closed member Run metadata only. Epochs and versions do not authorize runtime operations. No Attempt, lease, model/effect authority or general execution snapshot.');

export type MemberExecutionHttpRunCreate = z.infer<typeof MemberExecutionHttpRunCreateSchema>;
export type MemberExecutionHttpEmpty = z.infer<typeof MemberExecutionHttpEmptySchema>;
export type MemberExecutionHttpModelCreate = z.infer<typeof MemberExecutionHttpModelCreateSchema>;
export type MemberExecutionHttpGrantCreate = z.infer<typeof MemberExecutionHttpGrantCreateSchema>;
export type MemberExecutionHttpAttemptCreate = z.infer<typeof MemberExecutionHttpAttemptCreateSchema>;
export type MemberExecutionHttpRunMetadata = z.infer<typeof MemberExecutionHttpRunMetadataSchema>;
