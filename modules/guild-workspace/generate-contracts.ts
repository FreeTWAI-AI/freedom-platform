import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { configSchema } from '../../contracts/guild-launchpad/v1/config.js';
import {
  BackfillInput, BackfillReport, ClassificationInput, GuildClassification, LeaveV2Input, PreferenceView, SetPreferenceInput, SwitchInput,
} from '../../contracts/guild-launchpad/v1/guild-preferences.js';
import { Problem, ValidationFailedProblem } from '../../contracts/guild-launchpad/v1/primitives.js';
import {
  AcceptResultSchema, CreateResultSchema, EmptyObjectSchema, InvitationPageSchema, InvitationRevokeInputSchema, InvitationViewSchema,
  InviteCandidateSchema, InviteInputSchema, LeaveResultSchema, MemberChangeInputSchema, MemberPageSchema, MemberViewSchema,
  TenantCreateInputSchema, TenantEditInputSchema, TenantPageSchema, TenantViewSchema, WorkspaceCreateInputSchema, WorkspacePageSchema,
  WorkspaceViewSchema,
} from '../../contracts/guild-launchpad/v1/tenant.js';

const PREAMBLE = 'Structural shape only. The server decides identity, membership, capability, current version and quotas.';
const displayName = ['display_name_control_character'] as const;
const reason = ['reason_control_character'] as const;
const launchpad = [
  'guild_key_pattern_and_bounds', 'text_control_surrogate_and_utf8_bounds', 'block_id_stable_key',
  'block_kind_set_and_duplicates', 'block_order_range_and_uniqueness', 'mandatory_block_enabled',
  'application_refs_rejected', 'public_url_https',
] as const;

function description(rules: readonly string[]): string {
  return `${PREAMBLE} Server-only rules: ${rules.length ? rules.join(', ') : 'none'}.`;
}

const documents: ReadonlyArray<readonly [string, z.ZodType, 'input' | 'output', readonly string[]]> = [
  ['set-preference-input', SetPreferenceInput, 'input', []],
  ['leave-v2-input', LeaveV2Input, 'input', []],
  ['classification-input', ClassificationInput, 'input', [
    'capability_tag_trimmed_blank', 'capability_tag_control_or_markup', 'capability_tags_unique', 'classification_reason_trimmed_short',
  ]],
  ['preference-backfill-input', BackfillInput, 'input', []],
  ['preference-switch-input', SwitchInput, 'input', []],
  ['tenant-create-input', TenantCreateInputSchema, 'input', displayName],
  ['tenant-edit-input', TenantEditInputSchema, 'input', displayName],
  ['workspace-create-input', WorkspaceCreateInputSchema, 'input', displayName],
  ['tenant-invite-input', InviteInputSchema, 'input', []],
  ['invitation-revoke-input', InvitationRevokeInputSchema, 'input', reason],
  ['member-change-input', MemberChangeInputSchema, 'input', reason],
  ['empty-command-input', EmptyObjectSchema, 'input', []],
  ['launchpad-config', configSchema, 'input', launchpad],
  ['guild-classification', GuildClassification, 'output', []],
  ['preference-view', PreferenceView, 'output', []],
  ['preference-backfill-report', BackfillReport, 'output', []],
  ['tenant-view', TenantViewSchema, 'output', displayName],
  ['workspace-view', WorkspaceViewSchema, 'output', displayName],
  ['member-view', MemberViewSchema, 'output', []],
  ['invitation-view', InvitationViewSchema, 'output', displayName],
  ['tenant-page', TenantPageSchema, 'output', displayName],
  ['workspace-page', WorkspacePageSchema, 'output', displayName],
  ['member-page', MemberPageSchema, 'output', []],
  ['invitation-page', InvitationPageSchema, 'output', displayName],
  ['tenant-leave-result', LeaveResultSchema, 'output', []],
  ['invitation-accept-result', AcceptResultSchema, 'output', displayName],
  ['tenant-create-result', CreateResultSchema, 'output', displayName],
  ['invite-candidate', InviteCandidateSchema, 'output', []],
  ['problem', Problem, 'output', []],
  ['validation-failed-problem', ValidationFailedProblem, 'output', []],
];

if (process.argv.slice(2).some(value => value !== '--check')) throw new Error('Only --check is supported.');
for (const [name, schema, io, rules] of documents) {
  const input = z.toJSONSchema(schema, { io: 'input' });
  const output = z.toJSONSchema(schema, { io: 'output' });
  if (JSON.stringify(input) !== JSON.stringify(output)) throw new Error(`${name} input and output JSON Schemas differ.`);
  const path = new URL(`../../contracts/guild-launchpad/v1/${name}.schema.json`, import.meta.url);
  const bytes = JSON.stringify({ ...z.toJSONSchema(schema, { io }), $id: `https://freetwai.com/contracts/guild-launchpad/v1/${name}`, description: description(rules) }, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (await readFile(path, 'utf8') !== bytes) throw new Error(`Generated ${name} schema is stale.`);
  } else await writeFile(path, bytes);
}
console.log(`${documents.length} guild launchpad schemas checked/generated. Structural shapes only; no identity, membership, capability, version, or quota authority.`);
