import {z} from 'zod';
import {
  BLOCK_KINDS, ConfigValidationError, STABLE_KEY_PATTERN, hasLoneSurrogate,
  configSchema as v1Schema, parseConfig as parseV1, parseFieldErrors, type Config as V1Config, type ConfigView as V1View,
} from '../v1/config';

export const CONFIG_SCHEMA_VERSION = 'guild-launchpad.config/v2' as const;
export type ExtensionBlock = {
  id: string; kind: 'extension'; extension_id: string; order: number; enabled: boolean;
  title: string | null; settings: Record<string, never>;
};
export type ConfigV2 = Omit<V1Config, 'schema_version' | 'blocks'> & {
  schema_version: typeof CONFIG_SCHEMA_VERSION;
  blocks: (V1Config['blocks'][number] | ExtensionBlock)[];
};
export type Config = V1Config | ConfigV2;
export type ConfigView = Omit<V1View, 'body'> & {body: Config};
export type PublicSafeConfig = Omit<V1Config, 'extensions'> | Omit<ConfigV2, 'extensions'>;
const baseBlock = {
  id: z.string().regex(STABLE_KEY_PATTERN), order: z.number().int().min(0).max(1000), enabled: z.boolean(),
  title: z.string().min(1).max(120).refine(value => !/[\u0000-\u001f\u007f-\u009f]/.test(value) && !hasLoneSurrogate(value) && new TextEncoder().encode(value).length <= 480).nullable(),
};
const blockSchema = z.discriminatedUnion('kind', [
  z.object({...baseBlock, kind: z.enum(BLOCK_KINDS)}).strict(),
  z.object({...baseBlock, kind: z.literal('extension'), extension_id: z.string().regex(/^guild-block\.[a-z][a-z0-9-]*\.v[1-9][0-9]*$/), settings: z.object({}).strict()}).strict(),
]);
/** Wire shape; cross-field/content rules and reviewed IDs remain server checks. */
export const configSchema = z.object({...v1Schema.shape, schema_version: z.literal(CONFIG_SCHEMA_VERSION), blocks: z.array(blockSchema).min(1).max(24)}).strict();

/** v1 stays strict and unchanged; v2 reuses its content/URL/application rules. */
export function parseConfig(input: unknown, guildKey: string): Config {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !('schema_version' in input) || input.schema_version !== CONFIG_SCHEMA_VERSION) return parseV1(input, guildKey);
  if (new TextEncoder().encode(JSON.stringify(input)).length > 32768) throw new ConfigValidationError([{code: 'config_too_large', path: ''}]);
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) throw new ConfigValidationError(parseFieldErrors(parsed.error));
  const blocks = parsed.data.blocks;
  const ids = new Set<string>(), orders = new Set<number>(), kinds = new Set<string>();
  const errors: {code: string; path: string}[] = [];
  blocks.forEach((block, index) => {
    if (ids.has(block.id)) errors.push({code: 'stable_key_invalid', path: `blocks.${index}.id`});
    if (orders.has(block.order)) errors.push({code: 'invalid_order', path: `blocks.${index}.order`});
    if (block.kind !== 'extension' && kinds.has(block.kind)) errors.push({code: 'block_kind_duplicate', path: `blocks.${index}.kind`});
    ids.add(block.id); orders.add(block.order); kinds.add(block.kind);
  });
  if (errors.length) throw new ConfigValidationError(errors);
  const normalized = BLOCK_KINDS.map((kind, order) => ({
    ...(blocks.find(block => block.kind === kind) ?? {id: kind, kind, title: null}), order, enabled: true,
  }));
  const base = parseV1({...parsed.data, schema_version: 'guild-launchpad.config/v1', blocks: normalized}, guildKey);
  return {...base, schema_version: CONFIG_SCHEMA_VERSION, blocks};
}

/** Conversion creates a draft value; it never rewrites a stored revision/digest. */
export function convertV1(config: V1Config): ConfigV2 {
  const valid = parseV1(config, config.guild_key);
  return {...structuredClone(valid), schema_version: CONFIG_SCHEMA_VERSION};
}

export function assertAvailableBlocks(config: Config, available: ReadonlySet<string>) {
  const errors = config.blocks.flatMap((block, index) => block.kind === 'extension' && !available.has(block.extension_id)
    ? [{code: 'block_version_unavailable', path: `blocks.${index}.extension_id`}] : []);
  if (errors.length) throw new ConfigValidationError(errors);
}

export function publicSafeConfig(config: Config, allowedReleaseRefs: ReadonlySet<string> = new Set()): PublicSafeConfig {
  const {extensions: _, ...publicConfig} = structuredClone(config);
  return {...publicConfig, application_refs: publicConfig.application_refs.filter(ref => allowedReleaseRefs.has(ref.release_ref))};
}
