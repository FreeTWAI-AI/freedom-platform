import { z } from 'zod';
import { GuildKey, Version } from './primitives.js';

export { GuildKey, Version };

export const Category = z.enum(['internal', 'external', 'professional_industry']);
export const CategoryReview = z.enum(['pending', 'approved']);
export const MigrationState = z.enum(['legacy', 'backfilled', 'switched']);
// Max is the raw length so generated maxLength matches what the server receives. Trim still applies inside that bound.
const plainTag = z.string().max(64).trim().min(1).refine(value => !/[\u0000-\u001f\u007f<>]/.test(value), '請使用純文字標籤。');

export const CapabilityTags = z.array(plainTag).max(20).refine(tags => new Set(tags).size === tags.length, '標籤不可重複。');

export const GuildClassification = z.object({
  guild_key: GuildKey,
  category: Category.nullable(),
  category_review: CategoryReview,
  capability_tags: z.array(z.string()),
  active: z.boolean(),
  /** Null only when the catalog guild has no classification row yet. A missing row is pending. */
  catalog_revision: Version.nullable(),
}).strict();

export const PreferencePrimary = z.object({
  category: Category,
  guild_key: GuildKey.nullable(),
}).strict();

export const PreferenceInvalidation = z.object({
  guild_key: GuildKey,
  category: Category,
  reason: z.string(),
}).strict();

/** Wire shape after response middleware. aggregate_version is a JSON number; every other version is a decimal string. */
export const PreferenceView = z.object({
  aggregate_version: z.number().int().positive(),
  primaries: z.array(PreferencePrimary).length(3),
  invalidated: z.array(PreferenceInvalidation),
  migration_state: MigrationState,
  legacy: z.object({
    primary_guild_key: GuildKey.nullable(),
    secondary_guild_keys: z.array(GuildKey),
  }).strict().nullable(),
  compatibility: z.literal('legacy_projection').optional(),
}).strict();

export const SetPreferenceInput = z.object({
  category: Category,
  guild_key: GuildKey.nullable(),
  catalog_revision: Version,
}).strict();

export const LeaveV2Input = z.object({
  clear_primary: z.boolean(),
}).strict();

export const ClassificationInput = z.object({
  category: Category,
  capability_tags: CapabilityTags,
  reason: z.string().max(1000).trim().min(3),
}).strict();

export const BackfillInput = z.object({
  dry_run: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).optional(),
}).strict();

export const BackfillReport = z.object({
  dry_run: z.boolean(),
  processed: z.number().int().nonnegative(),
  mapped: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  ambiguous: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  /** Blocked candidates still awaiting a reconciled projection. A missing set and a `legacy` set are both candidates; `backfilled` and `switched` are not. */
  remaining_blocked: z.number().int().nonnegative(),
  blocked_members: z.array(z.object({
    user_id: z.string().uuid(),
    reason: z.enum(['unknown_category', 'left_primary', 'inactive_guild', 'invalid_secondary']),
  }).strict()),
}).strict();

export const SwitchInput = z.object({
  accept_blocked: z.boolean(),
}).strict();

export const CATEGORY_LABELS = {
  internal: '社群架構開發',
  external: '社群業務推廣',
  professional_industry: '社群專業服務',
} as const;

export const SECTION_LABELS = {
  internal: '社群架構開發主力',
  external: '社群業務推廣主力',
  professional_industry: '社群專業服務主力',
} as const;

export const CATEGORY_ORDER = ['internal', 'external', 'professional_industry'] as const;
export const DISPLAY_PRECEDENCE = ['professional_industry', 'external', 'internal'] as const;
