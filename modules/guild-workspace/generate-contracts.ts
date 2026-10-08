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
import {
  EmptyObjectSchema as WorkArchiveInputSchema, EnableManualWorkSchema, FinalizeSchema, InstanceCandidateSchema, LaunchpadContextSchema,
  ManualWorkBindingSchema, ModuleInstancePageSchema, ModuleInstanceViewSchema, OperationSchema, ResultPageSchema, ResultSchema,
  UploadPrepareSchema, UploadSchema, UploadVerifiedSchema, WorkPageSchema, WorkSchema, WorkWriteSchema,
} from '../../contracts/guild-launchpad/v1/tenant-work.js';

import * as storefront from '../../contracts/guild-launchpad/v1/storefront.js';

const PREAMBLE = 'Structural shape only. The server decides identity, membership, capability, current version and quotas.';
const displayName = ['display_name_control_character'] as const;
const reason = ['reason_control_character'] as const;
const instanceGrants = ['instance_ids_unique', 'instance_capability_keys_unique'] as const;
const launchpad = [
  'guild_key_pattern_and_bounds', 'text_control_surrogate_and_utf8_bounds', 'block_id_stable_key',
  'block_kind_set_and_duplicates', 'block_order_range_and_uniqueness', 'mandatory_block_enabled',
  'application_duplicate', 'public_url_https',
] as const;

function description(rules: readonly string[]): string {
  return `${PREAMBLE} Server-only rules: ${rules.length ? rules.join(', ') : 'none'}.`;
}

const workText = [
  'work_title_trimmed_blank', 'work_title_control_character', 'work_title_lone_surrogate',
  'work_objective_trimmed_blank', 'work_objective_control_character', 'work_objective_lone_surrogate', 'work_objective_utf8_bytes',
] as const;
const fileName = [
  'file_display_name_slash', 'file_display_name_backslash', 'file_display_name_control_character',
  'file_display_name_lone_surrogate', 'file_display_name_non_bmp',
] as const;
const TENANT_WORK_DESCRIPTION = 'Tenant manual Work, human Results, module instances, and workspace launchpad context. Structural shapes only; the server decides identity, membership, capability, current version and quotas.';

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
  ['tenant-invite-input', InviteInputSchema, 'input', instanceGrants],
  ['invitation-revoke-input', InvitationRevokeInputSchema, 'input', reason],
  ['member-change-input', MemberChangeInputSchema, 'input', [...reason, ...instanceGrants]],
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

const tenantWorkDocuments: ReadonlyArray<readonly [string, z.ZodType, 'input' | 'output', readonly string[]]> = [
  ['work-write-input', WorkWriteSchema, 'input', workText],
  ['work-archive-input', WorkArchiveInputSchema, 'input', []],
  ['upload-prepare-input', UploadPrepareSchema, 'input', fileName],
  ['result-finalize-input', FinalizeSchema, 'input', []],
  ['enable-manual-work-input', EnableManualWorkSchema, 'input', []],
  ['work-operation', OperationSchema, 'output', []],
  ['work-view', WorkSchema, 'output', workText],
  ['work-page', WorkPageSchema, 'output', workText],
  ['upload-view', UploadSchema, 'output', fileName],
  ['upload-verified', UploadVerifiedSchema, 'output', []],
  ['result-view', ResultSchema, 'output', fileName],
  ['result-page', ResultPageSchema, 'output', fileName],
  ['module-instance-view', ModuleInstanceViewSchema, 'output', []],
  ['module-instance-page', ModuleInstancePageSchema, 'output', []],
  ['manual-work-binding', ManualWorkBindingSchema, 'output', []],
  ['launchpad-context', LaunchpadContextSchema, 'output', workText],
  ['instance-candidate', InstanceCandidateSchema, 'output', []],
];

const bundles: ReadonlyArray<readonly [string, string, ReadonlyArray<readonly [string, z.ZodType, 'input' | 'output', readonly string[]]>]> = [
  ['tenant-work', TENANT_WORK_DESCRIPTION, tenantWorkDocuments],
  ['storefront', 'Hosted store inputs, private views and allowlisted public projection. Ordering is not enabled.', [
    ['store-setup-input', storefront.StoreSetupInputSchema, 'input', ['text_trim_and_control_characters', 'slug_lowercase_reserved_unique']],
    ['store-update-input', storefront.StoreUpdateInputSchema, 'input', ['at_least_one_field', 'text_trim_and_control_characters']],
    ['product-input', storefront.ProductInputSchema, 'input', ['text_trim_and_control_characters']],
    ['product-update-input', storefront.ProductUpdateInputSchema, 'input', ['at_least_one_field', 'text_trim_and_control_characters']],
    ['empty-input', storefront.EmptyStoreInputSchema, 'input', []],
    ['slug-query', storefront.SlugQuerySchema, 'input', []],
    ['slug-availability', storefront.SlugAvailabilitySchema, 'output', []],
    ['store-view', storefront.StoreViewSchema, 'output', []],
    ['product-view', storefront.ProductViewSchema, 'output', []],
    ['product-page', storefront.ProductPageSchema, 'output', []],
    ['product-removed', storefront.ProductRemovedSchema, 'output', []],
    ['my-stores', storefront.MyStoresSchema, 'output', []],
    ['public-store-projection', storefront.PublicStoreProjectionSchema, 'output', []],
    ['store-preview', storefront.StorePreviewSchema, 'output', []],
  ]],
];

function inlineDef(name: string, schema: z.ZodType, io: 'input' | 'output', rules: readonly string[]) {
  const input = z.toJSONSchema(schema, { io: 'input' });
  const output = z.toJSONSchema(schema, { io: 'output' });
  if (JSON.stringify(input) !== JSON.stringify(output)) throw new Error(`${name} input and output JSON Schemas differ.`);
  const generated = { ...z.toJSONSchema(schema, { io }) } as Record<string, unknown>;
  if (JSON.stringify(generated).includes('"$ref"') || JSON.stringify(generated).includes('"$defs"')) {
    throw new Error(`${name} JSON Schema contains $ref or $defs; refusing to rewrite references.`);
  }
  delete generated.$schema;
  if (Object.prototype.hasOwnProperty.call(generated, '$id')) throw new Error(`${name} def carries $id`);
  generated.description = description(rules);
  return generated;
}

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
for (const [bundleName, bundleDescription, defs] of bundles) {
  const seen = new Set<string>();
  const $defs: Record<string, unknown> = {};
  for (const [name, schema, io, rules] of defs) {
    if (seen.has(name)) throw new Error(`duplicate ${bundleName} def ${name}`);
    seen.add(name);
    $defs[name] = inlineDef(name, schema, io, rules);
  }
  const path = new URL(`../../contracts/guild-launchpad/v1/${bundleName}.schema.json`, import.meta.url);
  const bytes = JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://freetwai.com/contracts/guild-launchpad/v1/${bundleName}`,
    description: bundleDescription,
    $defs,
  }, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (await readFile(path, 'utf8') !== bytes) throw new Error(`Generated ${bundleName} bundle is stale.`);
  } else await writeFile(path, bytes);
}
console.log(`${documents.length} guild launchpad schemas and ${bundles.length} bundle checked/generated. Structural shapes only; no identity, membership, capability, version, or quota authority.`);
