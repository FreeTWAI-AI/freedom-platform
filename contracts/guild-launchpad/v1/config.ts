import {z} from 'zod';
import {GUILD_KEY_PATTERN, STABLE_KEY_PATTERN, VERSION_PATTERN, Version} from './primitives.js';

export {GUILD_KEY_PATTERN, STABLE_KEY_PATTERN, VERSION_PATTERN};
export const BLOCK_KINDS = ['mission','announcements','skill_books','applications','community_tasks','my_work','support'] as const;
export type BlockKind = typeof BLOCK_KINDS[number];
export const OPTIONAL_BLOCK_KINDS = ['announcements','community_tasks','applications'] as const;
export const CONFIG_SCHEMA_VERSION = 'guild-launchpad.config/v1' as const;
const CONTROL = /[\u0000-\u001F\u007F\u0080-\u009F]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** True only for an unpaired UTF-16 surrogate. A well-formed astral character is allowed. */
export function hasLoneSurrogate(value: string): boolean {
  return LONE_SURROGATE.test(value);
}
const MAX_CONFIG_BYTES = 32768;

/** Sorted-key JSON. This is the exact text digest() hashes. */
function canonicalJson(value: unknown): string {
  const stable = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(stable);
    if (current && typeof current === 'object') {
      const record = current as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map(key => [key, stable(record[key])]));
    }
    return current;
  };
  return JSON.stringify(stable(value));
}

export type FieldError = {code: string; path: string};
export class ConfigValidationError extends Error {
  readonly errors: FieldError[];
  constructor(errors: FieldError[]) {
    super('config_invalid');
    this.name = 'ConfigValidationError';
    this.errors = errors;
  }
}

export function assertStoredVersion(value: unknown, path: 'revision' | 'to_revision'): void {
  if (!Version.safeParse(value).success) throw new ConfigValidationError([{code: 'version_invalid', path}]);
}

export type LaunchpadBlock = {
  id: string;
  kind: BlockKind;
  order: number;
  enabled: boolean;
  title: string | null;
};
export type ApplicationRef = {application_key: string; release_ref: string; order: number};

/** Match release pairs in recommendation order without mutating either input. */
export function recommendedApplications<T extends {application_key: string; release_ref: string}>(
  refs: readonly ApplicationRef[], applications: readonly T[],
): T[] {
  const recommended: T[] = [];
  const seen = new Set<string>();
  for (const ref of [...refs].sort((a, b) => a.order - b.order)) {
    const key = JSON.stringify([ref.application_key, ref.release_ref]);
    if (seen.has(key)) continue;
    seen.add(key);
    const app = applications.find(item => item.application_key === ref.application_key && item.release_ref === ref.release_ref);
    if (app) recommended.push(app);
  }
  return recommended;
}
export type Config = {
  schema_version: typeof CONFIG_SCHEMA_VERSION;
  guild_key: string;
  mission_override: string | null;
  blocks: LaunchpadBlock[];
  application_refs: ApplicationRef[];
  starter: {title_label: string; objective_hint: string; note_hint: string};
  support: {kind: 'platform_help' | 'guild_public_contact'; public_url: string | null};
  extensions: Record<string, never>;
};
export type ConfigView = {
  config_id: string | null;
  revision: string;
  pointer_version: string;
  source: 'platform_default' | 'guild_editor';
  status: 'draft' | 'published' | 'superseded';
  body: Config;
  body_sha256: string;
  updated_at: string | null;
};
export type PublicSafeConfig = Omit<Config, 'extensions'>;

const blockSchema = z.object({
  id: z.string(),
  kind: z.enum(BLOCK_KINDS),
  order: z.number(),
  enabled: z.boolean(),
  title: z.string().nullable(),
}).strict();
const applicationSchema = z.object({
  application_key: z.string(),
  release_ref: z.string(),
  order: z.number(),
}).strict();
export const configSchema = z.object({
  schema_version: z.literal(CONFIG_SCHEMA_VERSION),
  guild_key: z.string(),
  mission_override: z.string().nullable(),
  blocks: z.array(blockSchema).max(7),
  application_refs: z.array(applicationSchema).max(30),
  starter: z.object({
    title_label: z.string(),
    objective_hint: z.string(),
    note_hint: z.string(),
  }).strict(),
  support: z.object({
    kind: z.enum(['platform_help','guild_public_contact']),
    public_url: z.string().nullable(),
  }).strict(),
  extensions: z.object({}).strict(),
}).strict().superRefine((value, ctx) => {
  textIssue(ctx, value.guild_key, ['guild_key'], {maxBytes: 80, minChars: 1, maxChars: 80});
  if (!GUILD_KEY_PATTERN.test(value.guild_key)) ctx.addIssue({code: 'custom', message: 'guild_key_mismatch', path: ['guild_key']});
  if (value.mission_override !== null) textIssue(ctx, value.mission_override, ['mission_override'], {maxBytes: 1200, minChars: 0, maxChars: 1200});
  const kinds = new Map<string, number>();
  const orders = new Set<number>();
  value.blocks.forEach((block, index) => {
    const path = ['blocks', index];
    if (!STABLE_KEY_PATTERN.test(block.id)) ctx.addIssue({code: 'custom', message: 'stable_key_invalid', path: [...path, 'id']});
    if (!(BLOCK_KINDS as readonly string[]).includes(block.kind)) ctx.addIssue({code: 'custom', message: 'block_kind_invalid', path: [...path, 'kind']});
    else if (kinds.has(block.kind)) ctx.addIssue({code: 'custom', message: 'block_kind_duplicate', path: [...path, 'kind']});
    else kinds.set(block.kind, index);
    if (!Number.isInteger(block.order) || block.order < 0 || block.order > 1000 || orders.has(block.order)) ctx.addIssue({code: 'custom', message: 'invalid_order', path: [...path, 'order']});
    else orders.add(block.order);
    if (!block.enabled && !(OPTIONAL_BLOCK_KINDS as readonly string[]).includes(block.kind)) ctx.addIssue({code: 'custom', message: 'enabled_locked', path: [...path, 'enabled']});
    if (block.title !== null) textIssue(ctx, block.title, [...path, 'title'], {maxBytes: 480, minChars: 1, maxChars: 120});
  });
  if (value.blocks.length !== BLOCK_KINDS.length || kinds.size !== BLOCK_KINDS.length) {
    ctx.addIssue({code: 'custom', message: 'block_set_invalid', path: ['blocks']});
    for (const kind of BLOCK_KINDS) if (!kinds.has(kind)) ctx.addIssue({code: 'custom', message: 'block_kind_missing', path: ['blocks']});
  }
  const applicationOrders = new Set<number>();
  const applicationKeys = new Set<string>();
  value.application_refs.forEach((ref, index) => {
    const path = ['application_refs', index];
    if (!STABLE_KEY_PATTERN.test(ref.application_key)) ctx.addIssue({code: 'custom', message: 'stable_key_invalid', path: [...path, 'application_key']});
    else if (applicationKeys.has(ref.application_key)) ctx.addIssue({code: 'custom', message: 'application_duplicate', path: [...path, 'application_key']});
    else applicationKeys.add(ref.application_key);
    textIssue(ctx, ref.release_ref, [...path, 'release_ref'], {maxBytes: 200, minChars: 1, maxChars: 200});
    if (!Number.isInteger(ref.order) || ref.order < 0 || ref.order > 1000 || applicationOrders.has(ref.order)) ctx.addIssue({code: 'custom', message: 'invalid_order', path: [...path, 'order']});
    else applicationOrders.add(ref.order);
  });
  textIssue(ctx, value.starter.title_label, ['starter', 'title_label'], {maxBytes: 480, minChars: 0, maxChars: 480});
  textIssue(ctx, value.starter.objective_hint, ['starter', 'objective_hint'], {maxBytes: 480, minChars: 0, maxChars: 480});
  textIssue(ctx, value.starter.note_hint, ['starter', 'note_hint'], {maxBytes: 480, minChars: 0, maxChars: 480});
  if (value.support.public_url !== null && !httpsUrl(value.support.public_url)) ctx.addIssue({code: 'custom', message: 'unsupported_url', path: ['support', 'public_url']});
});

function textIssue(ctx: {addIssue: (issue: {code: 'custom'; message: string; path: (string | number)[]}) => void}, value: string, path: (string | number)[], limits: {maxBytes: number; minChars: number; maxChars: number}) {
  if (CONTROL.test(value)) { ctx.addIssue({code: 'custom', message: 'control_character', path}); return; }
  if (hasLoneSurrogate(value)) { ctx.addIssue({code: 'custom', message: 'lone_surrogate', path}); return; }
  const chars = [...value].length;
  if (chars < limits.minChars) { ctx.addIssue({code: 'custom', message: 'too_short', path}); return; }
  if (chars > limits.maxChars || new TextEncoder().encode(value).length > limits.maxBytes) ctx.addIssue({code: 'custom', message: 'too_long', path});
}

function httpsUrl(value: string): boolean {
  if (value.length > 2048 || CONTROL.test(value) || hasLoneSurrogate(value)) return false;
  if (!value.startsWith('https://')) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.length > 0 && url.username === '' && url.password === '';
  } catch { return false; }
}

const KNOWN = new Set(['unknown_field','control_character','lone_surrogate','too_short','too_long','invalid_order','schema_version_invalid','config_too_large','block_set_invalid','block_kind_invalid','block_kind_duplicate','block_kind_missing','enabled_locked','application_release_unknown','application_duplicate','unsupported_url','stable_key_invalid','guild_key_mismatch','capability_duplicate','capabilities_invalid','version_invalid']);

function mapIssues(issues: {code: string; message: string; path: PropertyKey[]; keys?: string[]}[]): FieldError[] {
  const errors: FieldError[] = [];
  for (const issue of issues) {
    const base = issue.path.map(String).join('.');
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys ?? []) errors.push({code: 'unknown_field', path: base ? `${base}.${key}` : key});
      continue;
    }
    if (KNOWN.has(issue.message)) { errors.push({code: issue.message, path: base}); continue; }
    if (base === 'schema_version' || base.endsWith('.schema_version')) { errors.push({code: 'schema_version_invalid', path: base}); continue; }
    if (base.endsWith('kind') && base.includes('blocks')) { errors.push({code: 'block_kind_invalid', path: base}); continue; }
    if (issue.code === 'too_big' || issue.code === 'too_small') { errors.push({code: 'too_long', path: base}); continue; }
    errors.push({code: 'unknown_field', path: base});
  }
  return errors;
}

/** Strict config parse. `guildKey` is the URL key the server already resolved. */
export function parseConfig(input: unknown, guildKey: string): Config {
  if (input && typeof input === 'object') {
    const size = new TextEncoder().encode(canonicalJson(input)).length;
    if (size > MAX_CONFIG_BYTES) throw new ConfigValidationError([{code: 'config_too_large', path: ''}]);
  }
  const parsed = configSchema.safeParse(input);
  const errors = parsed.success ? [] : mapIssues(parsed.error.issues);
  const claimed = input && typeof input === 'object' && !Array.isArray(input) ? (input as {guild_key?: unknown}).guild_key : undefined;
  if (typeof claimed === 'string' && claimed !== guildKey && !errors.some(error => error.code === 'guild_key_mismatch')) errors.push({code: 'guild_key_mismatch', path: 'guild_key'});
  if (!parsed.success || errors.length) throw new ConfigValidationError(errors.length ? errors : [{code: 'unknown_field', path: ''}]);
  return parsed.data;
}

export function publicSafeConfig(config: Config, allowedReleaseRefs: ReadonlySet<string> = new Set()): PublicSafeConfig {
  return {
    schema_version: config.schema_version,
    guild_key: config.guild_key,
    mission_override: config.mission_override,
    blocks: config.blocks.map(block => ({...block})),
    application_refs: config.application_refs.filter(ref => allowedReleaseRefs.has(ref.release_ref)).map(ref => ({...ref})),
    starter: {...config.starter},
    support: {...config.support},
  };
}

export function parseFieldErrors(error: z.ZodError, prefix = ''): FieldError[] {
  return mapIssues(error.issues).map(item => ({...item, path: prefix && item.path ? `${prefix}.${item.path}` : prefix || item.path}));
}
