import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
// @ts-expect-error Existing host-only clean environment helper is an ESM JavaScript module.
import { verificationEnvironment } from '../../packages/contribution-tools/process-env.mjs';
import { OpaqueId as CommonOpaqueId } from '../../contracts/common/v1/identity.js';
import { configSchema } from '../../contracts/guild-launchpad/v1/config.js';
import {
  BackfillInput, BackfillReport, ClassificationInput, GuildClassification, GuildKey, LeaveV2Input, PreferenceView,
  SetPreferenceInput, SwitchInput,
} from '../../contracts/guild-launchpad/v1/guild-preferences.js';
import {
  GuildKey as PrimitiveGuildKey, MAX_STORED_VERSION, NON_NEGATIVE_DECIMAL_PATTERN, NonNegativeDecimal, OpaqueId, Problem, StableKey,
  VERSION_PATTERN, ValidationFailedProblem, nonNegativeDecimalPattern, signedDecimalPattern,
} from '../../contracts/guild-launchpad/v1/primitives.js';
import {
  AcceptResultSchema, CreateResultSchema, EmptyObjectSchema, InvitationPageSchema, InvitationRevokeInputSchema,
  InvitationViewSchema, InviteCandidateSchema, InviteInputSchema, LeaveResultSchema, MemberChangeInputSchema,
  MemberPageSchema, MemberViewSchema, TenantCreateInputSchema, TenantEditInputSchema, TenantPageSchema, TenantViewSchema,
  WorkspaceCreateInputSchema, WorkspacePageSchema, WorkspaceViewSchema,
} from '../../contracts/guild-launchpad/v1/tenant.js';
import {
  DisplayNameSchema, EnableManualWorkSchema, EmptyObjectSchema as WorkArchiveInputSchema, FinalizeSchema, InstanceCandidateSchema,
  LaunchpadContextSchema, ManualWorkBindingSchema, ModuleInstancePageSchema, ModuleInstanceViewSchema, OperationSchema,
  ResultPageSchema, ResultSchema, UploadPrepareSchema, UploadSchema, UploadVerifiedSchema, WorkObjectiveSchema, WorkPageSchema,
  WorkSchema, WorkWriteSchema,
} from '../../contracts/guild-launchpad/v1/tenant-work.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const id = '12345678-1234-4234-8234-123456789abc';
const id2 = '12345678-1234-4234-8234-123456789abd';
const MAX_INT = 9007199254740991;
const MAX_VERSION = '9223372036854775807';
const CATALOG_KEYS = [
  'guild_talent_direction', 'guild_product_quality_supply', 'guild_commerce_sales', 'guild_marketing', 'guild_media_automation',
  'guild_member_operations', 'guild_opportunity_partnership', 'guild_platform_engineering', 'guild_commerce_settlement',
  'guild_ai_vibe', 'guild_ai_field', 'guild_ai_project', 'guild_security', 'guild_music_mv', 'guild_commercial_production',
  'guild_event_space', 'guild_projection_mapping', 'guild_human_design',
];
const guildKey = `guild_${'a'.repeat(94)}`;
const reasonText = `🚀𠮷${'a'.repeat(998)}`;
const display = `🚀𠮷${'名'.repeat(118)}`;
const person = `🚀𠮷${'名'.repeat(238)}`;
const slug = `a${'b'.repeat(62)}c`;
const capKey = `a${'b'.repeat(159)}`;
const isoMin = '2026-10-06T00:00:00Z';
const isoMax = '2026-10-06T00:00:00.000000000Z';
const cursor = '🚀𠮷cursor';
const KINDS = ['mission', 'announcements', 'skill_books', 'applications', 'community_tasks', 'my_work', 'support'] as const;
const BAD_VERSIONS: unknown[] = ['0', '01', '1.0', ' 1', '1\n', 1, '9223372036854775808'];
const GOOD_VERSIONS = ['1', '9', '10', '9'.repeat(18), '1000000000000000000', '9223372036854775806', MAX_VERSION];

interface Case { name: string; value: unknown; valid: boolean }
interface Profile { name: string; schema: z.ZodType; minimal: Record<string, unknown>; maximal: Record<string, unknown> }
interface Hit { path: string[]; kind: 'maxLength' | 'maxItems' | 'maximum' | 'version' | 'nonNegative' | 'newline' | 'iso' | 'missing'; limit?: number; maxLength?: number }
type Json = Record<string, unknown>;

function blocks(title: string | null): { id: string; kind: typeof KINDS[number]; order: number; enabled: boolean; title: string | null }[] {
  return KINDS.map((kind, order) => ({ id: kind, kind, order, enabled: true, title }));
}
function config(max: boolean) {
  const prose = `🚀𠮷${'a'.repeat(472)}`;
  const urlPrefix = 'https://example.test/';
  return {
    schema_version: 'guild-launchpad.config/v1',
    guild_key: max ? `guild_${'a'.repeat(74)}` : 'guild_talent_direction',
    mission_override: max ? `🚀𠮷${'a'.repeat(1192)}` : null,
    blocks: blocks(max ? `🚀𠮷${'a'.repeat(118)}` : null),
    application_refs: [],
    starter: max
      ? { title_label: prose, objective_hint: prose, note_hint: prose }
      : { title_label: 't', objective_hint: 'o', note_hint: 'n' },
    support: max ? { kind: 'guild_public_contact', public_url: urlPrefix + 'a'.repeat(2048 - urlPrefix.length) } : { kind: 'platform_help', public_url: null },
    extensions: {},
  };
}
function preference(max: boolean) {
  const slot = (category: string) => ({ category, guild_key: max ? guildKey : null });
  return {
    aggregate_version: max ? MAX_INT : 1,
    primaries: [slot('internal'), slot('external'), slot('professional_industry')],
    invalidated: max ? [{ guild_key: 'guild_a', category: 'internal', reason: '🚀𠮷原因' }] : [],
    migration_state: max ? 'switched' : 'legacy',
    legacy: max ? { primary_guild_key: guildKey, secondary_guild_keys: ['guild_a'] } : null,
    ...(max ? { compatibility: 'legacy_projection' } : {}),
  };
}
function tenant(max: boolean) {
  return {
    tenant_id: id, community_id: id, display_name: max ? display : 'a', public_slug: max ? slug : null,
    status: max ? 'archived' : 'active', version: max ? MAX_VERSION : '1', authorization_revision: max ? MAX_VERSION : '1',
    my_membership: { principal_id: id, role: max ? 'owner' : 'viewer', version: max ? MAX_VERSION : '1' },
    capabilities: max ? [{ instance_id: id, keys: [capKey] }] : [],
    default_workspace_id: id,
  };
}
function workspace(max: boolean) {
  return { workspace_id: id, tenant_id: id, name: max ? display : 'a', status: max ? 'archived' : 'active', version: max ? MAX_VERSION : '1' };
}
function member(max: boolean) {
  return {
    principal_id: id, display_name: max ? person : 'a', role: max ? 'owner' : 'viewer', status: max ? 'revoked' : 'active',
    instance_capabilities: max ? [{ instance_id: id, capabilities: [capKey] }] : [], version: max ? MAX_VERSION : '1',
  };
}
function invitation(max: boolean) {
  return {
    invitation_id: id, tenant_id: id, tenant_display_name: max ? display : 'a', invitee_principal_id: id,
    role: max ? 'admin' : 'viewer', instance_capabilities: max ? [{ instance_id: id, capabilities: [capKey] }] : [],
    state: max ? 'expired' : 'pending', expires_at: max ? isoMax : isoMin, version: max ? MAX_VERSION : '1',
  };
}
function paged(item: unknown, max: boolean) {
  return { items: max ? [item] : [], next_cursor: max ? cursor : null, source_version: max ? MAX_VERSION : '1' };
}
function counts(max: boolean) {
  const n = max ? MAX_INT : 0;
  return { dry_run: max, processed: n, mapped: n, blocked: n, ambiguous: n, remaining: n, remaining_blocked: n, blocked_members: max ? [
    { user_id: id, reason: 'unknown_category' }, { user_id: id2, reason: 'left_primary' },
    { user_id: id, reason: 'inactive_guild' }, { user_id: id2, reason: 'invalid_secondary' },
  ] : [] };
}

const profiles: Profile[] = [
  { name: 'set-preference-input', schema: SetPreferenceInput, minimal: { category: 'internal', guild_key: null, catalog_revision: '1' }, maximal: { category: 'professional_industry', guild_key: guildKey, catalog_revision: MAX_VERSION } },
  { name: 'leave-v2-input', schema: LeaveV2Input, minimal: { clear_primary: false }, maximal: { clear_primary: true } },
  { name: 'classification-input', schema: ClassificationInput, minimal: { category: 'internal', capability_tags: [], reason: 'abc' }, maximal: { category: 'external', capability_tags: Array.from({ length: 20 }, (_, index) => `🚀𠮷${String(index).padStart(2, '0')}${'a'.repeat(60)}`), reason: reasonText } },
  { name: 'preference-backfill-input', schema: BackfillInput, minimal: {}, maximal: { dry_run: true, limit: 500 } },
  { name: 'preference-switch-input', schema: SwitchInput, minimal: { accept_blocked: false }, maximal: { accept_blocked: true } },
  { name: 'tenant-create-input', schema: TenantCreateInputSchema, minimal: { display_name: 'a' }, maximal: { display_name: display, workspace_name: display } },
  { name: 'tenant-edit-input', schema: TenantEditInputSchema, minimal: { display_name: 'a', public_slug: null }, maximal: { display_name: display, public_slug: slug } },
  { name: 'workspace-create-input', schema: WorkspaceCreateInputSchema, minimal: { name: 'a' }, maximal: { name: display } },
  { name: 'tenant-invite-input', schema: InviteInputSchema, minimal: { invitee_principal_id: id, role: 'viewer', instance_capabilities: [], expires_at: isoMin }, maximal: { invitee_principal_id: id, role: 'admin', instance_capabilities: [], expires_at: isoMax } },
  { name: 'invitation-revoke-input', schema: InvitationRevokeInputSchema, minimal: { reason: 'abc' }, maximal: { reason: reasonText } },
  { name: 'member-change-input', schema: MemberChangeInputSchema, minimal: { role: 'viewer', status: 'active', instance_capabilities: [], reason: 'abc' }, maximal: { role: 'admin', status: 'revoked', instance_capabilities: [], reason: reasonText } },
  { name: 'empty-command-input', schema: EmptyObjectSchema, minimal: {}, maximal: {} },
  { name: 'launchpad-config', schema: configSchema, minimal: config(false), maximal: config(true) },
  { name: 'guild-classification', schema: GuildClassification, minimal: { guild_key: 'guild_a', category: null, category_review: 'pending', capability_tags: [], active: true, catalog_revision: null }, maximal: { guild_key: guildKey, category: 'professional_industry', category_review: 'approved', capability_tags: ['🚀𠮷標籤'], active: false, catalog_revision: MAX_VERSION } },
  { name: 'preference-view', schema: PreferenceView, minimal: preference(false), maximal: preference(true) },
  { name: 'preference-backfill-report', schema: BackfillReport, minimal: counts(false), maximal: counts(true) },
  { name: 'tenant-view', schema: TenantViewSchema, minimal: tenant(false), maximal: tenant(true) },
  { name: 'workspace-view', schema: WorkspaceViewSchema, minimal: workspace(false), maximal: workspace(true) },
  { name: 'member-view', schema: MemberViewSchema, minimal: member(false), maximal: member(true) },
  { name: 'invitation-view', schema: InvitationViewSchema, minimal: invitation(false), maximal: invitation(true) },
  { name: 'tenant-page', schema: TenantPageSchema, minimal: paged(tenant(false), false), maximal: paged(tenant(true), true) },
  { name: 'workspace-page', schema: WorkspacePageSchema, minimal: paged(workspace(false), false), maximal: paged(workspace(true), true) },
  { name: 'member-page', schema: MemberPageSchema, minimal: paged(member(false), false), maximal: paged(member(true), true) },
  { name: 'invitation-page', schema: InvitationPageSchema, minimal: paged(invitation(false), false), maximal: paged(invitation(true), true) },
  { name: 'tenant-leave-result', schema: LeaveResultSchema, minimal: { status: 'revoked', version: '1' }, maximal: { status: 'revoked', version: MAX_VERSION } },
  { name: 'invitation-accept-result', schema: AcceptResultSchema, minimal: { invitation: invitation(false), membership: member(false) }, maximal: { invitation: invitation(true), membership: member(true) } },
  { name: 'tenant-create-result', schema: CreateResultSchema, minimal: { tenant: tenant(false), workspace: workspace(false) }, maximal: { tenant: tenant(true), workspace: workspace(true) } },
  { name: 'invite-candidate', schema: InviteCandidateSchema, minimal: { principal_id: id, display_name: 'a' }, maximal: { principal_id: id, display_name: person } },
  { name: 'problem', schema: Problem, minimal: { type: 'about:blank', title: 'Validation failed', status: 422, code: 'validation_failed', detail: '內容不符合。' }, maximal: { type: 'about:blank', title: '標題🚀𠮷', status: MAX_INT, code: 'validation_failed', detail: '內容🚀𠮷' } },
  { name: 'validation-failed-problem', schema: ValidationFailedProblem, minimal: { type: 'about:blank', title: 'Validation failed', status: 422, code: 'validation_failed', detail: '內容不符合啟動台配置規則。', errors: [{ code: 'too_long', path: 'guild_key' }] }, maximal: { type: 'about:blank', title: '驗證🚀𠮷', status: 422, code: 'validation_failed', detail: '內容🚀𠮷', errors: [{ code: 'too_long', path: 'mission_override' }, { code: 'unknown_field', path: '' }] } },
];

function patch(root: unknown, path: string[], next: unknown) {
  const copy = structuredClone(root) as Record<string, unknown>;
  let cursor = copy as Record<string, unknown>;
  for (let index = 0; index < path.length - 1; index += 1) cursor = cursor[path[index]!] as Record<string, unknown>;
  cursor[path[path.length - 1]!] = next as never;
  return copy;
}
function drop(root: unknown, path: string[]) {
  const copy = structuredClone(root) as Record<string, unknown>;
  let cursor = copy as Record<string, unknown>;
  for (let index = 0; index < path.length - 1; index += 1) cursor = cursor[path[index]!] as Record<string, unknown>;
  delete cursor[path[path.length - 1]!];
  return copy;
}
function visit(schema: Json, value: unknown, path: string[], hits: Hit[]) {
  const branches = (schema.anyOf ?? schema.oneOf) as Json[] | undefined;
  if (branches) {
    for (const branch of branches) visit(branch, value, path, hits);
    return;
  }
  const types = Array.isArray(schema.type) ? schema.type as string[] : schema.type ? [String(schema.type)] : [];
  if (types.includes('object') && schema.properties && value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (Object.prototype.hasOwnProperty.call(record, key)) hits.push({ path: [...path, key], kind: 'missing' });
    }
    for (const [key, child] of Object.entries(schema.properties as Record<string, Json>)) {
      if (Object.prototype.hasOwnProperty.call(record, key)) visit(child, record[key], [...path, key], hits);
    }
    return;
  }
  if (types.includes('array') && Array.isArray(value)) {
    if (typeof schema.maxItems === 'number' && value.length === schema.maxItems) hits.push({ path, kind: 'maxItems' });
    if (schema.items && !Array.isArray(schema.items)) value.forEach((item, index) => visit(schema.items as Json, item, [...path, String(index)], hits));
    return;
  }
  if (types.includes('string') && typeof value === 'string') {
    const maxLength = typeof schema.maxLength === 'number' ? schema.maxLength : undefined;
    if (maxLength !== undefined) hits.push({ path, kind: 'maxLength', limit: maxLength });
    const pattern = typeof schema.pattern === 'string' ? schema.pattern : '';
    if (pattern.includes('9223372036854775807')) hits.push({ path, kind: pattern.includes('(?:0|') ? 'nonNegative' : 'version' });
    if (pattern.includes('[0-9]{4}-[0-9]{2}-[0-9]{2}T')) hits.push({ path, kind: 'iso' });
    if (pattern) hits.push({ path, kind: 'newline', maxLength });
    return;
  }
  if ((types.includes('integer') || types.includes('number')) && typeof value === 'number' && typeof schema.maximum === 'number' && Object.is(value, schema.maximum)) {
    hits.push({ path, kind: 'maximum', limit: schema.maximum });
  }
}
function newlineProbe(value: string, maxLength?: number) {
  const appended = `${value}\n`;
  if (maxLength === undefined || [...appended].length <= maxLength) return appended;
  return `${value.slice(0, -1)}\n`;
}
function at(root: unknown, path: string[]) {
  return path.reduce<unknown>((cursor, key) => (cursor as Record<string, unknown>)[key], root);
}
function has(root: unknown, path: string[]) {
  let cursor = root as Record<string, unknown> | undefined;
  for (let index = 0; index < path.length - 1; index += 1) {
    const next = cursor?.[path[index]!];
    if (!next || typeof next !== 'object') return false;
    cursor = next as Record<string, unknown>;
  }
  return !!cursor && Object.prototype.hasOwnProperty.call(cursor, path[path.length - 1]!);
}
function casesFor(profile: Profile, document: Json): Case[] {
  const hits: Hit[] = [];
  visit(document, profile.maximal, [], hits);
  visit(document, profile.minimal, [], hits);
  const cases: Case[] = [
    { name: 'valid minimal', value: profile.minimal, valid: true },
    { name: 'valid maximal', value: profile.maximal, valid: true },
  ];
  for (const value of [null, [], '', true, 1]) cases.push({ name: `non-object ${JSON.stringify(value)}`, value, valid: false });
  cases.push({ name: 'unknown top-level field', value: { ...profile.minimal, unknown_field: 'x' }, valid: false });
  for (const key of ['__proto__', 'constructor']) {
    const raw = JSON.stringify(profile.minimal);
    const body = raw.slice(1, -1);
    cases.push({ name: `own ${key}`, value: JSON.parse(body ? `{${body},"${key}":1}` : `{"${key}":1}`), valid: false });
  }
  const seen = new Set<string>();
  for (const hit of hits) {
    const id = `${hit.kind}:${hit.path.join('.')}:${hit.limit ?? ''}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const label = hit.path.join('.') || '(root)';
    if (hit.kind === 'missing') cases.push({ name: `missing ${label}`, value: drop(has(profile.minimal, hit.path) ? profile.minimal : profile.maximal, hit.path), valid: false });
    if (hit.kind === 'maxLength') cases.push({ name: `one code point over ${label}`, value: patch(profile.maximal, hit.path, `${'a'.repeat(hit.limit!)}名`), valid: false });
    if (hit.kind === 'maxItems') {
      const items = at(profile.maximal, hit.path);
      cases.push({ name: `one item over ${label}`, value: patch(profile.maximal, hit.path, [...(items as unknown[]), Array.isArray(items) && items.length ? structuredClone(items[0]) : null]), valid: false });
    }
    if (hit.kind === 'maximum') cases.push({ name: `one over maximum ${label}`, value: patch(profile.maximal, hit.path, hit.limit! + 1), valid: false });
    if (hit.kind === 'version') {
      for (const value of GOOD_VERSIONS) cases.push({ name: `valid version ${label} ${value}`, value: patch(profile.maximal, hit.path, value), valid: true });
      for (const value of BAD_VERSIONS) cases.push({ name: `invalid version ${label} ${JSON.stringify(value)}`, value: patch(profile.maximal, hit.path, value), valid: false });
    }
    if (hit.kind === 'nonNegative') {
      for (const value of ['0', ...GOOD_VERSIONS]) cases.push({ name: `valid non-negative ${label} ${value}`, value: patch(profile.maximal, hit.path, value), valid: true });
      for (const value of ['00', '-0', '-1', '0\n', '01', '1.0', ' 1', '1\n', 1, '9223372036854775808']) {
        cases.push({ name: `invalid non-negative ${label} ${JSON.stringify(value)}`, value: patch(profile.maximal, hit.path, value), valid: false });
      }
    }
    if (hit.kind === 'iso') {
      cases.push({ name: `fraction over ${label}`, value: patch(profile.maximal, hit.path, '2026-10-06T00:00:00.0000000000Z'), valid: false });
      cases.push({ name: `Arabic-Indic digits ${label}`, value: patch(profile.maximal, hit.path, '٢٠٢٦-١٠-٠٦T٠٠:٠٠:٠٠Z'), valid: false });
      cases.push({ name: `full-width digits ${label}`, value: patch(profile.maximal, hit.path, '２０２６-１０-０６T００:００:００Z'), valid: false });
    }
    if (hit.kind === 'newline') {
      const current = at(profile.maximal, hit.path);
      const source = typeof current === 'string' ? current : String(at(profile.minimal, hit.path) ?? '');
      if (source) cases.push({ name: `trailing newline ${label}`, value: patch(profile.maximal, hit.path, newlineProbe(source, hit.maxLength)), valid: false });
    }
  }
  return cases;
}
function jsonSchema(name: string) {
  return JSON.parse(readFileSync(new URL(`../../contracts/guild-launchpad/v1/${name}.schema.json`, import.meta.url), 'utf8')) as Json & { description?: string };
}
function agree(profile: Profile, cases: Case[], schema: Json = jsonSchema(profile.name), timeout = 60000) {
  for (const item of cases) assert.equal(profile.schema.safeParse(item.value).success, item.valid, `${profile.name}: ${item.name}`);
  const script = `import json,sys
from jsonschema import Draft202012Validator, FormatChecker
payload=json.load(sys.stdin)
Draft202012Validator.check_schema(payload['schema'])
validator=Draft202012Validator(payload['schema'], format_checker=FormatChecker())
for case in payload['cases']:
    assert validator.is_valid(case['value']) == case['valid'], case['name']
print('conformant')`;
  const result = spawnSync('python3', ['-c', script], {
    cwd: root, env: verificationEnvironment(), encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024,
    input: JSON.stringify({ schema, cases }),
  });
  assert.equal(result.status, 0, `${profile.name}\n${result.stdout}${result.stderr}`);
  assert.equal(result.stdout.trim(), 'conformant');
}

const SERVER_ONLY: { schema: string; rule: string; value: unknown }[] = [
  { schema: 'classification-input', rule: 'capability_tag_trimmed_blank', value: { category: 'internal', capability_tags: ['   '], reason: 'abc' } },
  { schema: 'classification-input', rule: 'capability_tag_control_or_markup', value: { category: 'internal', capability_tags: ['a<b>'], reason: 'abc' } },
  { schema: 'classification-input', rule: 'capability_tags_unique', value: { category: 'internal', capability_tags: ['same', 'same'], reason: 'abc' } },
  { schema: 'classification-input', rule: 'classification_reason_trimmed_short', value: { category: 'internal', capability_tags: [], reason: '  a' } },
  { schema: 'invitation-revoke-input', rule: 'reason_control_character', value: { reason: 'ab\u0001' } },
  { schema: 'member-change-input', rule: 'reason_control_character', value: { role: 'viewer', status: 'active', instance_capabilities: [], reason: 'ab\u0001' } },
  { schema: 'tenant-create-input', rule: 'display_name_control_character', value: { display_name: 'a\u0001' } },
  { schema: 'tenant-edit-input', rule: 'display_name_control_character', value: { display_name: 'a\u0001', public_slug: null } },
  { schema: 'workspace-create-input', rule: 'display_name_control_character', value: { name: 'a\u0001' } },
  { schema: 'tenant-view', rule: 'display_name_control_character', value: { ...tenant(false), display_name: 'a\u0001' } },
  { schema: 'workspace-view', rule: 'display_name_control_character', value: { ...workspace(false), name: 'a\u0001' } },
  { schema: 'invitation-view', rule: 'display_name_control_character', value: { ...invitation(false), tenant_display_name: 'a\u0001' } },
  { schema: 'tenant-page', rule: 'display_name_control_character', value: paged({ ...tenant(false), display_name: 'a\u0001' }, true) },
  { schema: 'workspace-page', rule: 'display_name_control_character', value: paged({ ...workspace(false), name: 'a\u0001' }, true) },
  { schema: 'invitation-page', rule: 'display_name_control_character', value: paged({ ...invitation(false), tenant_display_name: 'a\u0001' }, true) },
  { schema: 'invitation-accept-result', rule: 'display_name_control_character', value: { invitation: { ...invitation(false), tenant_display_name: 'a\u0001' }, membership: member(false) } },
  { schema: 'tenant-create-result', rule: 'display_name_control_character', value: { tenant: { ...tenant(false), display_name: 'a\u0001' }, workspace: workspace(false) } },
];

for (const name of ['tenant-invite-input', 'member-change-input']) {
  const base = profiles.find(profile => profile.name === name)!.minimal;
  const entry = { instance_id: id, capabilities: ['work:read'] };
  SERVER_ONLY.push(
    { schema: name, rule: 'instance_ids_unique', value: { ...base, instance_capabilities: [entry, entry] } },
    { schema: name, rule: 'instance_capability_keys_unique', value: { ...base, instance_capabilities: [{ ...entry, capabilities: ['work:read', 'work:read'] }] } },
  );
}

test('instance grant inputs accept explicit scopes and reject grammar, empty, duplicate and over-limit lists', () => {
  for (const name of ['tenant-invite-input', 'member-change-input']) {
    const profile = profiles.find(profile => profile.name === name)!;
    const entry = { instance_id: id, capabilities: ['work:read', 'work:write'] };
    assert.equal(profile.schema.safeParse({ ...profile.minimal, instance_capabilities: [entry] }).success, true);
    const twenty = Array.from({ length: 20 }, (_, index) => ({ ...entry, instance_id: `12345678-1234-4234-8234-${String(index).padStart(12, '0')}` }));
    const hundred = Array.from({ length: 100 }, (_, index) => `a:${index}`);
    assert.equal(profile.schema.safeParse({ ...profile.minimal, instance_capabilities: twenty }).success, true);
    assert.equal(profile.schema.safeParse({ ...profile.minimal, instance_capabilities: [{ ...entry, capabilities: hundred }] }).success, true);
    const invalid = [
      [...twenty, { ...entry, instance_id: id2 }], [entry, entry],
      [{ ...entry, capabilities: [] }], [{ ...entry, capabilities: [...hundred, 'a:100'] }],
      [{ ...entry, capabilities: ['work:read', 'work:read'] }], [{ ...entry, actor: id }],
      ...['*', 'Bad', 'bad,key', 'work:read\n', `a${'b'.repeat(160)}`].map(key => [{ ...entry, capabilities: [key] }]),
    ];
    for (const entries of invalid) assert.equal(profile.schema.safeParse({ ...profile.minimal, instance_capabilities: entries }).success, false, JSON.stringify(entries));
    agree(profile, [
      { name: 'explicit instance', value: { ...profile.minimal, instance_capabilities: [entry] }, valid: true },
      { name: 'twenty instances', value: { ...profile.minimal, instance_capabilities: twenty }, valid: true },
      { name: 'empty capabilities', value: { ...profile.minimal, instance_capabilities: [{ ...entry, capabilities: [] }] }, valid: false },
      { name: 'twenty-one instances', value: { ...profile.minimal, instance_capabilities: [...twenty, { ...entry, instance_id: id2 }] }, valid: false },
    ]);
  }
});

function launchpadOnly(): { schema: string; rule: string; value: unknown }[] {
  const base = config(false);
  const dup = blocks(null);
  dup[1] = { ...dup[1]!, kind: 'mission' };
  const order = blocks(null);
  order[0] = { ...order[0]!, order: 1.5 };
  const disabled = blocks(null);
  disabled[0] = { ...disabled[0]!, enabled: false };
  const badId = blocks(null);
  badId[0] = { ...badId[0]!, id: 'Bad' };
  return [
    { schema: 'launchpad-config', rule: 'guild_key_pattern_and_bounds', value: { ...base, guild_key: 'nope' } },
    { schema: 'launchpad-config', rule: 'text_control_surrogate_and_utf8_bounds', value: { ...base, mission_override: 'a'.repeat(1201) } },
    { schema: 'launchpad-config', rule: 'block_id_stable_key', value: { ...base, blocks: badId } },
    { schema: 'launchpad-config', rule: 'block_kind_set_and_duplicates', value: { ...base, blocks: dup } },
    { schema: 'launchpad-config', rule: 'block_order_range_and_uniqueness', value: { ...base, blocks: order } },
    { schema: 'launchpad-config', rule: 'mandatory_block_enabled', value: { ...base, blocks: disabled } },
    { schema: 'launchpad-config', rule: 'application_duplicate', value: { ...base, application_refs: [{ application_key: 'app_key', release_ref: 'rel', order: 1 }, { application_key: 'app_key', release_ref: 'rel-b', order: 2 }] } },
    { schema: 'launchpad-config', rule: 'public_url_https', value: { ...base, support: { kind: 'platform_help', public_url: 'http://example.test' } } },
  ];
}

test('signed decimal pattern matches the signed bigint bound', () => {
  assert.equal(OpaqueId, CommonOpaqueId);
  assert.equal(GuildKey, PrimitiveGuildKey);
  const max = 9223372036854775807n;
  for (const value of GOOD_VERSIONS) {
    assert.equal(VERSION_PATTERN.test(value), true, value);
    assert.equal(BigInt(value) <= max, true, value);
  }
  for (const value of ['0', '01', '9223372036854775808', '9223372036854775809', '9223372036854775810', '9300000000000000000', '9'.repeat(19), '10000000000000000000', '1\n', ' 1', '1.0']) {
    assert.equal(VERSION_PATTERN.test(value), false, value);
  }
  assert.equal(signedDecimalPattern(MAX_STORED_VERSION), VERSION_PATTERN.source);
  let seed = 0xC0FFEE;
  const next = () => {
    seed = (seed + 0x6D2B79F5) >>> 0;
    let mixed = seed;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
  for (let index = 0; index < 10000; index += 1) {
    let value = String(1 + Math.floor(next() * 9));
    for (let digit = 1; digit < 19; digit += 1) value += String(Math.floor(next() * 10));
    assert.equal(VERSION_PATTERN.test(value), BigInt(value) <= max, value);
    assert.equal(NON_NEGATIVE_DECIMAL_PATTERN.test(value), BigInt(value) <= max, value);
  }
  assert.equal(nonNegativeDecimalPattern(MAX_STORED_VERSION), NON_NEGATIVE_DECIMAL_PATTERN.source);
  const signedInner = VERSION_PATTERN.source.match(/^\^\(\?:(.+)\)\$\(\?!\[\\s\\S\]\)$/);
  assert.ok(signedInner);
  assert.equal(NON_NEGATIVE_DECIMAL_PATTERN.source, `^(?:0|${signedInner[1]})$(?![\\s\\S])`);
  for (const value of ['0', ...GOOD_VERSIONS]) assert.equal(NonNegativeDecimal.safeParse(value).success, true, value);
  for (const value of ['00', '-0', '-1', '0\n', '01', '1.0', ' 1', '1\n', '9223372036854775808', '9223372036854775809', '9223372036854775810', '9300000000000000000', '9'.repeat(19), '10000000000000000000', 1]) {
    assert.equal(NonNegativeDecimal.safeParse(value).success, false, JSON.stringify(value));
  }
  for (const key of CATALOG_KEYS) assert.equal(GuildKey.safeParse(key).success, true, key);
  assert.equal(GuildKey.safeParse(`guild_custom_${'ab'.repeat(16)}`).success, true);
  assert.equal(GuildKey.safeParse(`guild_custom_${'AB'.repeat(16)}`).success, true);
  assert.equal(GuildKey.safeParse('guild_a\n').success, false);
  assert.equal(StableKey.safeParse(`a${'b'.repeat(159)}`).success, true);
  assert.equal(StableKey.safeParse(`a${'b'.repeat(160)}`).success, false);
});

test('guild launchpad contracts regenerate deterministically and match generated bytes', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'modules/guild-workspace/generate-contracts.ts', '--check'], {
    cwd: root, env: verificationEnvironment(), encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /30 guild launchpad schemas and 1 bundle checked\/generated\./);
});

test('generated guild launchpad schemas agree with Zod except listed server-only rules', () => {
  const serverOnly = [...SERVER_ONLY, ...launchpadOnly()];
  for (const profile of profiles) {
    const parsedMin = profile.schema.safeParse(profile.minimal);
    const parsedMax = profile.schema.safeParse(profile.maximal);
    assert.equal(parsedMin.success, true, `${profile.name} minimal ${parsedMin.success ? '' : JSON.stringify(parsedMin.error?.issues)}`);
    assert.equal(parsedMax.success, true, `${profile.name} maximal ${parsedMax.success ? '' : JSON.stringify(parsedMax.error?.issues)}`);
    const schema = jsonSchema(profile.name);
    assert.equal(schema.$id, `https://freetwai.com/contracts/guild-launchpad/v1/${profile.name}`);
    agree(profile, casesFor(profile, schema));
    const rows = serverOnly.filter(row => row.schema === profile.name);
    if (!rows.length) assert.match(String(schema.description), /Server-only rules: none\./);
    for (const row of rows) {
      assert.equal(profile.schema.safeParse(row.value).success, false, row.rule);
      assert.match(String(schema.description), new RegExp(row.rule));
      const script = `import json,sys
from jsonschema import Draft202012Validator, FormatChecker
payload=json.load(sys.stdin)
validator=Draft202012Validator(payload['schema'], format_checker=FormatChecker())
assert validator.is_valid(payload['value']), payload['rule']
print('looser')`;
      const result = spawnSync('python3', ['-c', script], {
        cwd: root, env: verificationEnvironment(), encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024,
        input: JSON.stringify({ schema, value: row.value, rule: row.rule }),
      });
      assert.equal(result.status, 0, `${profile.name} ${row.rule}\n${result.stdout}${result.stderr}`);
    }
  }
});

test('generated patterns use ASCII-only character classes', () => {
  const dir = `${root}contracts/guild-launchpad/v1`;
  const files = readdirSync(dir).filter(name => name.endsWith('.schema.json')).sort();
  assert.ok(files.length > 0, 'no schema files found');

  function collectPatterns(node: unknown, patterns: string[] = []): string[] {
    if (!node || typeof node !== 'object') return patterns;
    if (Array.isArray(node)) {
      for (const item of node) collectPatterns(item, patterns);
      return patterns;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'pattern' && typeof value === 'string') {
        patterns.push(value);
      }
      collectPatterns(value, patterns);
    }
    return patterns;
  }

  for (const file of files) {
    const raw = readFileSync(`${dir}/${file}`, 'utf8');
    const schema = JSON.parse(raw) as unknown;
    const patterns = collectPatterns(schema);
    for (const pattern of patterns) {
      const forbidden = ['\\d', '\\D', '\\w', '\\W', '\\b', '\\B'].filter(token => pattern.includes(token));
      assert.equal(forbidden.length, 0, `${file} pattern ${pattern} contains forbidden character class (${forbidden.join(', ')})`);
      const stripped = pattern.replaceAll('[\\s\\S]', '');
      const whitespace = ['\\s', '\\S'].filter(token => stripped.includes(token));
      assert.equal(whitespace.length, 0, `${file} pattern ${pattern} contains whitespace character class (${whitespace.join(', ')})`);
    }
  }
});

const titleMax = `🚀𠮷${'名'.repeat(118)}`;
const objectiveMax = `🚀𠮷${'a'.repeat(16376)}`;
const objectiveBytes = '中'.repeat(5462);
const fileNameMax = '名'.repeat(120);
const sha256 = 'ab'.repeat(32);
const moduleText = `🚀𠮷${'k'.repeat(40)}`;

function workDocument(max: boolean) {
  return {
    work_id: id, tenant_id: id, workspace_id: id, instance_id: id,
    title: max ? titleMax : 'a', objective: max ? objectiveMax : 'a', progress: max ? 'done' : 'todo',
    state: max ? 'archived' : 'draft', version: max ? MAX_VERSION : '1',
    ...(max ? { current_result_id: id2 } : {}), updated_at: max ? isoMax : isoMin,
  };
}
function workWrite(max: boolean) {
  return { title: max ? titleMax : 'a', objective: max ? objectiveMax : 'a', progress: max ? 'done' : 'todo' };
}
function uploadDocument(max: boolean) {
  return {
    upload_id: id, work_id: id, asset_id: id, phase: max ? 'finalized' : 'prepared', expires_at: max ? isoMax : isoMin,
    version: max ? MAX_VERSION : '1', byte_size: max ? 262144 : 1, sha256, content_type: max ? 'text/markdown' : 'text/plain',
    display_name: max ? fileNameMax : 'a',
  };
}
function prepareDocument(max: boolean) {
  return {
    content_type: max ? 'text/markdown' : 'text/plain', byte_size: max ? 262144 : 1, sha256,
    display_name: max ? fileNameMax : 'a', expected_work_version: max ? MAX_VERSION : '1',
  };
}
function resultDocument(max: boolean) {
  return {
    result_id: id, work_id: id, asset_id: id, revision: max ? MAX_VERSION : '1', work_version: max ? MAX_VERSION : '1',
    provenance: 'human', content_type: max ? 'text/markdown' : 'text/plain', byte_size: max ? 262144 : 1, sha256,
    created_at: max ? isoMax : isoMin, display_name: max ? fileNameMax : 'a',
  };
}
function instanceDocument(max: boolean) {
  return {
    instance_id: id, tenant_id: id, module_key: max ? moduleText : 'work',
    application_release_ref: max ? `🚀𠮷${'r'.repeat(40)}` : 'manual-workspace@1.0.0',
    data_schema_version: max ? '🚀𠮷1' : '1', status: max ? 'archived' : 'provisioning', binding_id: id,
    authority_epoch: max ? MAX_VERSION : '1', version: max ? MAX_VERSION : '1', configuration_revision: max ? MAX_VERSION : '1',
  };
}
function operationDocument(max: boolean) {
  return {
    operation_id: id, state: 'succeeded', version: max ? MAX_VERSION : '1',
    resource_ref: { tenant_id: id, instance_id: id, resource_type: max ? 'work.result' : 'work.work', resource_id: id },
  };
}
function bindingDocument(max: boolean) {
  return {
    instance_id: id, tenant_id: id, workspace_id: id, binding_id: id, version: max ? MAX_VERSION : '1',
    entry_capability: 'work:create', reused: max,
  };
}
function enableDocument(max: boolean) {
  return max
    ? { guild_key: guildKey, choice: { kind: 'reuse', instance_id: id, expected_version: MAX_VERSION } }
    : { guild_key: 'guild_a' };
}
function candidateDocument(max: boolean) {
  return { instance_id: id, version: max ? MAX_VERSION : '1', created_at: max ? isoMax : isoMin, bound_workspace_count: max ? MAX_INT : 0 };
}
function capacityDocument(max: boolean) {
  return {
    policy_revision: max ? MAX_VERSION : null, used: max ? MAX_VERSION : '0', reserved: max ? MAX_VERSION : '0', limit: max ? MAX_VERSION : null,
  };
}
function launchpadDocument(max: boolean) {
  return {
    tenant_id: id, workspace_id: id, source_version: max ? MAX_VERSION : '1',
    instances: max ? [instanceDocument(true)] : [], work_page: paged(workDocument(max), max),
    capacity_summary: capacityDocument(max), connection_summary: max ? [{ instance_id: id, status: 'hosted_active' }] : [],
  };
}

const tenantProfiles: Profile[] = [
  { name: 'work-write-input', schema: WorkWriteSchema, minimal: workWrite(false), maximal: workWrite(true) },
  { name: 'work-archive-input', schema: WorkArchiveInputSchema, minimal: {}, maximal: {} },
  { name: 'upload-prepare-input', schema: UploadPrepareSchema, minimal: prepareDocument(false), maximal: prepareDocument(true) },
  { name: 'result-finalize-input', schema: FinalizeSchema, minimal: { expected_work_version: '1' }, maximal: { expected_work_version: MAX_VERSION } },
  { name: 'enable-manual-work-input', schema: EnableManualWorkSchema, minimal: enableDocument(false), maximal: enableDocument(true) },
  { name: 'work-operation', schema: OperationSchema, minimal: operationDocument(false), maximal: operationDocument(true) },
  { name: 'work-view', schema: WorkSchema, minimal: workDocument(false), maximal: workDocument(true) },
  { name: 'work-page', schema: WorkPageSchema, minimal: paged(workDocument(false), false), maximal: paged(workDocument(true), true) },
  { name: 'upload-view', schema: UploadSchema, minimal: uploadDocument(false), maximal: uploadDocument(true) },
  { name: 'upload-verified', schema: UploadVerifiedSchema, minimal: { upload_id: id, verified: true, version: '1' }, maximal: { upload_id: id, verified: true, version: MAX_VERSION } },
  { name: 'result-view', schema: ResultSchema, minimal: resultDocument(false), maximal: resultDocument(true) },
  { name: 'result-page', schema: ResultPageSchema, minimal: paged(resultDocument(false), false), maximal: paged(resultDocument(true), true) },
  { name: 'module-instance-view', schema: ModuleInstanceViewSchema, minimal: instanceDocument(false), maximal: instanceDocument(true) },
  { name: 'module-instance-page', schema: ModuleInstancePageSchema, minimal: paged(instanceDocument(false), false), maximal: paged(instanceDocument(true), true) },
  { name: 'manual-work-binding', schema: ManualWorkBindingSchema, minimal: bindingDocument(false), maximal: bindingDocument(true) },
  { name: 'launchpad-context', schema: LaunchpadContextSchema, minimal: launchpadDocument(false), maximal: launchpadDocument(true) },
  { name: 'instance-candidate', schema: InstanceCandidateSchema, minimal: candidateDocument(false), maximal: candidateDocument(true) },
];

function workCarrier(name: string, field: 'title' | 'objective', value: string) {
  if (name === 'work-write-input') return { ...workWrite(false), [field]: value };
  if (name === 'work-view') return { ...workDocument(false), [field]: value };
  if (name === 'work-page') return paged({ ...workDocument(false), [field]: value }, true);
  return { ...launchpadDocument(false), work_page: paged({ ...workDocument(false), [field]: value }, true) };
}
function fileCarrier(name: string, value: string) {
  if (name === 'upload-prepare-input') return { ...prepareDocument(false), display_name: value };
  if (name === 'upload-view') return { ...uploadDocument(false), display_name: value };
  if (name === 'result-view') return { ...resultDocument(false), display_name: value };
  return paged({ ...resultDocument(false), display_name: value }, true);
}
const tenantServerOnly: { schema: string; rule: string; value: unknown }[] = [];
for (const name of ['work-write-input', 'work-view', 'work-page', 'launchpad-context']) {
  tenantServerOnly.push(
    { schema: name, rule: 'work_title_trimmed_blank', value: workCarrier(name, 'title', '   ') },
    { schema: name, rule: 'work_title_control_character', value: workCarrier(name, 'title', 'a\r') },
    { schema: name, rule: 'work_title_lone_surrogate', value: workCarrier(name, 'title', 'a\uD800') },
    { schema: name, rule: 'work_objective_trimmed_blank', value: workCarrier(name, 'objective', '   ') },
    { schema: name, rule: 'work_objective_control_character', value: workCarrier(name, 'objective', 'a\r') },
    { schema: name, rule: 'work_objective_lone_surrogate', value: workCarrier(name, 'objective', 'a\uD800') },
    { schema: name, rule: 'work_objective_utf8_bytes', value: workCarrier(name, 'objective', objectiveBytes) },
  );
}
for (const name of ['upload-prepare-input', 'upload-view', 'result-view', 'result-page']) {
  tenantServerOnly.push(
    { schema: name, rule: 'file_display_name_slash', value: fileCarrier(name, 'a/b') },
    { schema: name, rule: 'file_display_name_backslash', value: fileCarrier(name, 'a\\b') },
    { schema: name, rule: 'file_display_name_control_character', value: fileCarrier(name, 'a\u0001') },
    { schema: name, rule: 'file_display_name_lone_surrogate', value: fileCarrier(name, 'a\uD800') },
    { schema: name, rule: 'file_display_name_non_bmp', value: fileCarrier(name, '🚀') },
  );
}

function extraItemCases(profile: Profile, document: Json): Case[] {
  const found: { path: string[]; maxItems: number }[] = [];
  const walk = (schema: Json, value: unknown, path: string[]) => {
    const branches = (schema.anyOf ?? schema.oneOf) as Json[] | undefined;
    if (branches) {
      for (const branch of branches) walk(branch, value, path);
      return;
    }
    const types = Array.isArray(schema.type) ? schema.type as string[] : schema.type ? [String(schema.type)] : [];
    if (types.includes('object') && schema.properties && value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      for (const [key, child] of Object.entries(schema.properties as Record<string, Json>)) {
        if (Object.prototype.hasOwnProperty.call(record, key)) walk(child, record[key], [...path, key]);
      }
      return;
    }
    if (types.includes('array') && Array.isArray(value) && typeof schema.maxItems === 'number') {
      if (value.length > 0 && value.length < schema.maxItems) found.push({ path: [...path], maxItems: schema.maxItems });
      if (schema.items && !Array.isArray(schema.items)) value.forEach((item, index) => walk(schema.items as Json, item, [...path, String(index)]));
    }
  };
  walk(document, profile.maximal, []);
  return found.map(hit => ({
    name: `one item over ${hit.path.join('.')}`,
    value: patch(profile.maximal, hit.path, Array.from({ length: hit.maxItems + 1 }, () => structuredClone((at(profile.maximal, hit.path) as unknown[])[0]))),
    valid: false,
  }));
}
function bundleRef(bundle: Json, name: string): Json {
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', $defs: bundle.$defs, $ref: `#/$defs/${name}` };
}

const DOCUMENT_DIGESTS: Record<string, string> = {
  'classification-input': '82b03f526ea88808441aa8cf88fd2bffcaa68c9c8411165d67a9ba747290598f',
  'empty-command-input': 'e4ba27de71418e758118b40338fce02571eca44db58b5296f959222e714a9d39',
  'guild-classification': '0cfcb336dae6dd2b2a1f4236081bcb653bda9eceffddfbd480c551f28e76a3a0',
  'invitation-accept-result': '953c43775b8d6dfc2199051d2ebbb2dbe8e74bf416a3ccf77fc7cab869bc6663',
  'invitation-page': '9e916b2ec93a56e1c79254ae217c9d17f6a83d1730ef424d6e51cb78dccc5932',
  'invitation-revoke-input': '492ffe4d46ee56300115a7ff92652a9dc664904bf6cd6ffd06a3d367075f4856',
  'invitation-view': 'f179c403dab8c53354f370fd831790b14fdfbf90cc767a7325efade5d430036e',
  'invite-candidate': 'a54b8d678b4f31999582ec5cf1e4f808e652ee0b05fdcf586c5f3c2280903e96',
  'launchpad-config': '45909fdda6925281f05a29833b4551d27b2f9c74cd92bfe914ae78ebd00d0b34',
  'leave-v2-input': 'dd06bd31728a3c77eb59377bef99b2a06b080b5da6b6f02f30c1b217f76db3b4',
  'member-change-input': '51cab0bc6239c1d44b937cbc9d5cc1e0ef51c4f03665593e48478e9f1cb5de75',
  'member-page': '0d7168c4999742153bbecb2834c3fb2066ae78e5b90c41fbfd659156257223f6',
  'member-view': 'a5ea33166f3f69ef1383fee7e7d63c6643f87b576bcf5f09992e2d14d53d1f3f',
  'preference-backfill-input': '39ba40ec3e83deed58b0cad55c2fc6ef2ef91f752faaa7aca1759d5c31c4ea5b',
  'preference-backfill-report': '0f3a927e68b72e0115c2929378491f0ff4c7a27bdfcb4c08b8cfa13030910fcb',
  'preference-switch-input': 'ae9b181322a23dedb01ccbc2f9fd08979518356a34528d8c5dbde2c49a31307c',
  'preference-view': 'bbfda70d9c45e6f98d339acd6433bdafa428d5c3b05c87b3f2fddb5aa1c458fb',
  'problem': '684f2f7cc162059282b35c5b5904cd68c1b52b1c3e35ef357838b9af15fbf146',
  'set-preference-input': '190495cb5e0f6a1cd07d1d8436eb1f02e763c03b5932668528b2b69bedc11c12',
  'tenant-create-input': '028f0835187fd51a9d3f54025d7508b95a6e0dfd6ead3c778f10f7c2483a28ff',
  'tenant-create-result': '35692cb8c8c820ecbc7c835c2c855c85ed3e893579df12cc21533108f40345ca',
  'tenant-edit-input': '4a88cab4610d12bbfc4b66f69c36bddb650cc42a9301885593c1f9208b93cb15',
  'tenant-invite-input': 'c3f694c756900a4a63a4ba998bb7f2e892acb96b28f89af7ea82adfbd2dd6f1c',
  'tenant-leave-result': '27fa1306198e796fb12579333d8307df539eacdd5cf575b46b9adb2ece3fdd43',
  'tenant-page': 'e8a3d5c70c907af2e65274515c279f53e40fb6a198dfed20606e0b2afc381be5',
  'tenant-view': '3644d3103d2edd3a68b2e4d33f770741ee9be35d4eae027b2ca243401a589e2c',
  'validation-failed-problem': 'd1564faa27e82cab8fc391f65bc1e3f644c2ce63390bf1f314d0a6ab13e60650',
  'workspace-create-input': '1e46cb1ad4b1c31e30e5c25f84c8da3a79beee3913bafa5c83ca922edd742c02',
  'workspace-page': 'd9cd94501d7e5c43d754cf7e202f89d223999eb6a77bd3803107905b8506fef8',
  'workspace-view': 'cf9e20cad7be7c50f59b34bb512dfbbea9a04c4f4f2d926200e48111536101ff',
};

test('tenant work bundle agrees with Zod except listed server-only rules', () => {
  assert.equal([...titleMax].length, 120);
  assert.equal(Buffer.byteLength(titleMax) <= 480, true);
  assert.equal(Buffer.byteLength(objectiveMax), 16384);
  assert.equal([...objectiveBytes].length, 5462);
  assert.equal(Buffer.byteLength(objectiveBytes), 16386);
  assert.equal(WorkObjectiveSchema.safeParse(objectiveMax).success, true);
  assert.equal(WorkObjectiveSchema.safeParse(objectiveBytes).success, false);
  assert.equal(DisplayNameSchema.safeParse(fileNameMax).success, true);
  assert.equal(DisplayNameSchema.safeParse('🚀').success, false);
  const bundle = jsonSchema('tenant-work');
  assert.deepEqual(Object.keys(bundle), ['$schema', '$id', 'description', '$defs']);
  assert.equal(bundle.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(bundle.$id, 'https://freetwai.com/contracts/guild-launchpad/v1/tenant-work');
  assert.equal(bundle.description, 'Tenant manual Work, human Results, module instances, and workspace launchpad context. Structural shapes only; the server decides identity, membership, capability, current version and quotas.');
  const defs = bundle.$defs as Record<string, Json & { description?: string }>;
  assert.deepEqual(Object.keys(defs), tenantProfiles.map(profile => profile.name));
  assert.equal(Object.keys(DOCUMENT_DIGESTS).length, 30);
  for (const [name, digest] of Object.entries(DOCUMENT_DIGESTS)) {
    const bytes = readFileSync(new URL(`../../contracts/guild-launchpad/v1/${name}.schema.json`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), digest, name);
  }
  const instanceProperties = (defs['module-instance-view'].properties ?? {}) as Record<string, Json>;
  for (const key of ['module_key', 'application_release_ref', 'data_schema_version']) {
    assert.equal(instanceProperties[key]?.maxLength, undefined, key);
    assert.equal(instanceProperties[key]?.pattern, undefined, key);
  }
  for (const profile of tenantProfiles) {
    const def = defs[profile.name];
    assert.ok(def, profile.name);
    assert.equal(Object.hasOwn(def, '$schema'), false, profile.name);
    assert.equal(Object.hasOwn(def, '$id'), false, profile.name);
    const text = JSON.stringify(def);
    assert.equal(text.includes('"$ref"'), false, profile.name);
    assert.equal(text.includes('"$defs"'), false, profile.name);
    const parsedMin = profile.schema.safeParse(profile.minimal);
    const parsedMax = profile.schema.safeParse(profile.maximal);
    assert.equal(parsedMin.success, true, `${profile.name} minimal ${parsedMin.success ? '' : JSON.stringify(parsedMin.error?.issues)}`);
    assert.equal(parsedMax.success, true, `${profile.name} maximal ${parsedMax.success ? '' : JSON.stringify(parsedMax.error?.issues)}`);
    const wrapped = bundleRef(bundle, profile.name);
    agree(profile, [...casesFor(profile, def), ...extraItemCases(profile, def)], wrapped, 180000);
    const rows = tenantServerOnly.filter(row => row.schema === profile.name);
    if (!rows.length) assert.match(String(def.description), /Server-only rules: none\./);
    const named = String(def.description).match(/Server-only rules: ([^.]+)\./)?.[1] ?? '';
    if (named !== 'none') {
      for (const rule of named.split(', ')) assert.equal(rows.some(row => row.rule === rule), true, `${profile.name} ${rule}`);
    }
    for (const row of rows) {
      assert.equal(profile.schema.safeParse(row.value).success, false, `${profile.name} ${row.rule}`);
      assert.match(String(def.description), new RegExp(row.rule));
      const script = `import json,sys
from jsonschema import Draft202012Validator, FormatChecker
payload=json.load(sys.stdin)
validator=Draft202012Validator(payload['schema'], format_checker=FormatChecker())
assert validator.is_valid(payload['value']), payload['rule']
print('looser')`;
      const result = spawnSync('python3', ['-c', script], {
        cwd: root, env: verificationEnvironment(), encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024,
        input: JSON.stringify({ schema: wrapped, value: row.value, rule: row.rule }),
      });
      assert.equal(result.status, 0, `${profile.name} ${row.rule}\n${result.stdout}${result.stderr}`);
    }
  }
});
