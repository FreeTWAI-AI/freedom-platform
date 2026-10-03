import { z } from 'zod';
import { ModelConnectionMetadataSchema } from '../v1/member-execution.js';
import { MemberModelHttpConnectionMetadataSchema } from './member-model-http.js';
import { BrokerModelSelectionSchema, ModelCredentialMetadataSchema } from './model-credential.js';

export const MemberModelSettingsLimits = Object.freeze({ records: 50 });
export const MemberModelSettingsSetupSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unavailable') }).strict(),
  z.object({ state: z.literal('installed'), setupOrigin: z.string().min(1).max(256).url() }).strict(),
]).describe('Installed main-to-broker handoff configuration only. It does not attest protected capture, provider authentication, model availability or execution permission. The installed opaque client pins the canonical HTTPS origin.');
export const MemberModelSettingsOverviewSchema = z.object({
  profile: z.literal('member-model-settings/v1'),
  connections: z.array(MemberModelHttpConnectionMetadataSchema).max(MemberModelSettingsLimits.records),
  models: z.array(ModelConnectionMetadataSchema).max(MemberModelSettingsLimits.records),
  credentials: z.array(ModelCredentialMetadataSchema).max(MemberModelSettingsLimits.records),
  selectionOptions: z.array(BrokerModelSelectionSchema).max(MemberModelSettingsLimits.records),
  setup: MemberModelSettingsSetupSchema,
  limit: z.literal(50), operational_authority: z.literal(false),
}).strict().describe('Current owner-only model and credential metadata. History remains readable without provider, vault, recovery or work persistence. No key bytes, ciphertext, binding, session, claims, prompt, work title or operational authority.');
export type MemberModelSettingsOverview = z.infer<typeof MemberModelSettingsOverviewSchema>;
export type MemberModelSettingsSetup = z.infer<typeof MemberModelSettingsSetupSchema>;
