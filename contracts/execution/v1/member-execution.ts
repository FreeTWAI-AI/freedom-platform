import { z } from 'zod';
import { OpaqueId } from '../../common/v1/identity.js';
import { BootstrapClientIdSchema } from './bootstrap.js';
import { RuntimeEnvironmentSchema } from './runtime-registration.js';

// These are closed member consent/selection records, never credentials,
// model authentication, operational preflight success or verified contexts.
// Use an exportable lexical pattern: refinements alone would leave generated
// JSON Schemas accepting versions beyond PostgreSQL's signed bigint maximum.
const maximum = '9223372036854775807';
const fullWidth = [...maximum].flatMap((digit, index) => {
  const lower = index === 0 ? 1 : 0, upper = Number(digit) - 1;
  if (upper < lower) return [];
  const choice = upper === lower ? String(lower) : `[${lower}-${upper}]`;
  const remaining = maximum.length - index - 1;
  return [maximum.slice(0, index) + choice + (remaining ? `[0-9]{${remaining}}` : '')];
});
const versionDigits = `(?:[1-9][0-9]{0,17}|${fullWidth.join('|')}|${maximum})`;
export const MemberExecutionVersionSchema = z.string().max(19).regex(
  new RegExp(`^${versionDigits}$(?![\\s\\S])`));
const Key = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$(?![\s\S])/);
const Label = z.string().min(1).max(96).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$(?![\s\S])/);
const Time = z.iso.datetime({ precision: 3 });
const PolicyRevision = z.string().max(33).regex(new RegExp(`^private-work\\.v${versionDigits}$(?![\\s\\S])`));
export const OpenRouterModelRefSchema = z.string().min(3).max(96).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$(?![\s\S])/);
const selectionFields = {
  providerRef: Label, modelRef: Label, processingLocation: Label,
  artifactCustody: z.enum(['runtime_local', 'platform_asset']),
};
export const LegacyModelSelectionSchema = z.discriminatedUnion('credentialCustody', [
  z.object({ ...selectionFields, credentialCustody: z.literal('official_cli'),
    engineLocation: z.literal('runtime_local'), billingSource: z.literal('user_cli') }).strict(),
  z.object({ ...selectionFields, credentialCustody: z.literal('local_keychain'),
    engineLocation: z.literal('runtime_local'), billingSource: z.literal('user_byok') }).strict(),
  z.object({ ...selectionFields, credentialCustody: z.literal('platform_vault'),
    engineLocation: z.literal('platform'), billingSource: z.literal('user_byok') }).strict(),
]).describe('Explicit member selection metadata only. Provider, model, processing/custody and billing labels are not authentication, verified availability, or operational support. No automatic fallback.');

// Namespaced identifiers are specific to OpenRouter, never endpoint/URL inputs.
const openRouterFields = { ...selectionFields, providerRef: z.literal('openrouter'), modelRef: OpenRouterModelRefSchema,
  processingLocation: z.literal('provider_remote') };
export const OpenRouterModelSelectionSchema = z.discriminatedUnion('credentialCustody', [
  z.object({ ...openRouterFields, credentialCustody: z.literal('local_keychain'), engineLocation: z.literal('runtime_local'), billingSource: z.literal('user_byok') }).strict(),
  z.object({ ...openRouterFields, credentialCustody: z.literal('platform_vault'), engineLocation: z.literal('platform'), billingSource: z.literal('user_byok') }).strict(),
]);
export const ModelSelectionSchema = z.union([...LegacyModelSelectionSchema.options, ...OpenRouterModelSelectionSchema.options])
  .describe('Explicit owner selection metadata only; OpenRouter requires an exact namespaced model and BYOK custody. No automatic fallback or authentication authority.');

// Missing expected versions reach the existing server checkVersion/428 path.
// The public TypeScript command types below still require expected versions.
export const CreateModelConnectionInputSchema = z.object({ key: Key, connectionId: OpaqueId,
  expectedConnectionVersion: MemberExecutionVersionSchema.optional(), selection: ModelSelectionSchema }).strict();
export const ReadModelConnectionInputSchema = z.object({ modelConnectionId: OpaqueId }).strict();
export const RevokeModelConnectionInputSchema = ReadModelConnectionInputSchema.extend({
  key: Key, expectedVersion: MemberExecutionVersionSchema.optional() }).strict();
export const ModelConnectionMetadataSchema = z.object({
  modelConnectionId: OpaqueId, connectionId: OpaqueId, runtimeDeviceId: OpaqueId, familyId: OpaqueId,
  environment: RuntimeEnvironmentSchema, clientId: BootstrapClientIdSchema, selection: ModelSelectionSchema,
  state: z.enum(['unverified', 'revoked']), aggregateVersion: MemberExecutionVersionSchema,
  createdAt: Time, operational_authority: z.literal(false),
}).strict().describe('Closed member-selected model connection metadata. Unverified records do not contain provider credentials or model authorization. Parsing does not verify current database authority.');

export const CreateExecutionGrantInputSchema = z.object({ key: Key, runId: OpaqueId,
  expectedRunVersion: MemberExecutionVersionSchema.optional(), expectedWorkVersion: MemberExecutionVersionSchema.optional(),
  connectionId: OpaqueId, expectedConnectionVersion: MemberExecutionVersionSchema.optional(),
  modelConnectionId: OpaqueId, expectedModelVersion: MemberExecutionVersionSchema.optional(), consent: z.literal(true),
}).strict();
export const ReadExecutionGrantInputSchema = z.object({ grantId: OpaqueId }).strict();
export const RevokeExecutionGrantInputSchema = ReadExecutionGrantInputSchema.extend({
  key: Key, expectedVersion: MemberExecutionVersionSchema.optional() }).strict();
export const ExecutionGrantMetadataSchema = z.object({
  grantId: OpaqueId, runId: OpaqueId, workId: OpaqueId, inputWorkVersion: MemberExecutionVersionSchema,
  runVersion: MemberExecutionVersionSchema, taskLeaseEpoch: MemberExecutionVersionSchema, controlEpoch: MemberExecutionVersionSchema,
  connectionId: OpaqueId, connectionVersion: MemberExecutionVersionSchema, runtimeDeviceId: OpaqueId, familyId: OpaqueId,
  modelConnectionId: OpaqueId, modelVersion: MemberExecutionVersionSchema, selection: ModelSelectionSchema,
  policyRevision: PolicyRevision, state: z.enum(['active', 'revoked']), aggregateVersion: MemberExecutionVersionSchema,
  issuedAt: Time, expiresAt: Time, purpose: z.literal('model.private-draft'), operational_authority: z.literal(false),
}).strict().describe('Exact bounded member consent metadata for model.private-draft. Active means consent record state only; it does not authenticate a model or authorize execution. Current backing records, expiry and policy must be checked by the server.');

export const CreateExecutionAttemptInputSchema = z.object({ key: Key, runId: OpaqueId, grantId: OpaqueId,
  expectedRunVersion: MemberExecutionVersionSchema.optional(), expectedGrantVersion: MemberExecutionVersionSchema.optional(),
}).strict();
export const ReadExecutionAttemptInputSchema = z.object({ attemptId: OpaqueId }).strict();
export const ExecutionAttemptMetadataSchema = z.object({
  attemptId: OpaqueId, attemptNumber: z.number().int().min(1).max(16), grant: ExecutionGrantMetadataSchema,
  createdAt: Time, state: z.literal('preflight_blocked'),
  blockers: z.tuple([z.literal('model_authentication_unavailable'), z.literal('model_adapter_unavailable')]),
  operational_authority: z.literal(false),
}).strict().describe('Immutable blocked Attempt binding with its original consent snapshot. Nested grant state/version/selection are historical and do not report current authority. No model execution, lease, activation or result authority exists.');

export type ModelSelection = z.infer<typeof ModelSelectionSchema>;
export type CreateModelConnectionInput = z.infer<typeof CreateModelConnectionInputSchema> & { expectedConnectionVersion: string };
export type ReadModelConnectionInput = z.infer<typeof ReadModelConnectionInputSchema>;
export type RevokeModelConnectionInput = z.infer<typeof RevokeModelConnectionInputSchema> & { expectedVersion: string };
export type ModelConnectionMetadata = z.infer<typeof ModelConnectionMetadataSchema>;
export type CreateExecutionGrantInput = z.infer<typeof CreateExecutionGrantInputSchema> & {
  expectedRunVersion: string; expectedWorkVersion: string; expectedConnectionVersion: string; expectedModelVersion: string;
};
export type ReadExecutionGrantInput = z.infer<typeof ReadExecutionGrantInputSchema>;
export type RevokeExecutionGrantInput = z.infer<typeof RevokeExecutionGrantInputSchema> & { expectedVersion: string };
export type ExecutionGrantMetadata = z.infer<typeof ExecutionGrantMetadataSchema>;
export type CreateExecutionAttemptInput = z.infer<typeof CreateExecutionAttemptInputSchema> & {
  expectedRunVersion: string; expectedGrantVersion: string;
};
export type ReadExecutionAttemptInput = z.infer<typeof ReadExecutionAttemptInputSchema>;
export type ExecutionAttemptMetadata = z.infer<typeof ExecutionAttemptMetadataSchema>;
