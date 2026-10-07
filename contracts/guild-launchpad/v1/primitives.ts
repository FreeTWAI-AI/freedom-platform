import { z } from 'zod';

export { OpaqueId } from '../../common/v1/identity.js';

/** Inclusive PostgreSQL signed-bigint maximum, encoded as a decimal string. */
export const MAX_STORED_VERSION = '9223372036854775807';

/**
 * Inclusive upper bound as a `^...$(?![\\s\\S])` pattern.
 * The lookahead closes the Python `$`-before-newline hole. Shorter digit
 * lengths are a separate branch so values below the maximum stay accepted.
 */
export function signedDecimalPattern(max: string): string {
  if (!/^[1-9][0-9]*$/.test(max)) throw new Error('signedDecimalPattern requires a positive decimal string');
  const branches: string[] = [];
  if (max.length > 1) branches.push(`[1-9][0-9]{0,${max.length - 2}}`);
  for (let index = 0; index < max.length; index += 1) {
    const lower = index === 0 ? 1 : 0;
    const upper = Number(max[index]) - 1;
    if (upper < lower) continue;
    const choice = upper === lower ? String(lower) : `[${lower}-${upper}]`;
    const remaining = max.length - index - 1;
    branches.push(max.slice(0, index) + choice + (remaining ? `[0-9]{${remaining}}` : ''));
  }
  branches.push(max);
  return `^(?:${branches.join('|')})$(?![\\s\\S])`;
}

export const VERSION_PATTERN = new RegExp(signedDecimalPattern(MAX_STORED_VERSION));
/** Positive decimal version. A JSON field literally named aggregate_version is a number, not this string. */
export const Version = z.string().max(19).regex(VERSION_PATTERN);

/**
 * Decimal zero, or the positive range from {@link signedDecimalPattern}.
 * The zero alternative is outside that helper so the digit bound is not written twice.
 */
export function nonNegativeDecimalPattern(max: string): string {
  const signed = signedDecimalPattern(max);
  const inner = signed.match(/^\^\(\?:(.+)\)\$\(\?!\[\\s\\S\]\)$/);
  if (!inner) throw new Error('signedDecimalPattern shape is not a single non-capturing group');
  return `^(?:0|${inner[1]})$(?![\\s\\S])`;
}

export const NON_NEGATIVE_DECIMAL_PATTERN = new RegExp(nonNegativeDecimalPattern(MAX_STORED_VERSION));
/** Zero or a positive decimal inside the signed bigint range. */
export const NonNegativeDecimal = z.string().max(19).regex(NON_NEGATIVE_DECIMAL_PATTERN);

export const STABLE_KEY_PATTERN = /^[a-z][a-z0-9_.-]{0,159}$(?![\s\S])/;
export const StableKey = z.string().max(160).regex(STABLE_KEY_PATTERN);

/** Catalog keys (`guild_…`) and custom keys (`guild_custom_` + 32 hex). Existing catalog keys match unchanged. */
export const GUILD_KEY_PATTERN = /^(?:guild_[a-z0-9_]+|guild_custom_[0-9A-Fa-f]{32})$(?![\s\S])/;
export const GuildKey = z.string().min(1).max(100).regex(GUILD_KEY_PATTERN);

export function page<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    next_cursor: z.string().nullable(),
    source_version: Version,
  }).strict();
}

export const Problem = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string(),
}).strict();

/** Launchpad field-error body. The global Zod handler omits `errors`. */
export const ValidationFailedProblem = z.object({
  type: z.string(),
  title: z.string(),
  status: z.literal(422),
  code: z.literal('validation_failed'),
  detail: z.string(),
  errors: z.array(z.object({
    code: z.string(),
    path: z.string(),
  }).strict()),
}).strict();
