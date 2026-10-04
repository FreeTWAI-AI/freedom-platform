import type { Pool, PoolClient } from 'pg';

/**
 * Read-only, aggregate-only inventory of the seven database-resident media sources.
 * Never returns identifiers, bytes, URLs or per-row data. Does not move, verify,
 * digest, back up or restore media; those are explicitly reported as not run.
 */

export type InventoryEnvironment = 'local' | 'staging' | 'public';

export interface InventoryTarget {
  readonly environment: InventoryEnvironment;
  readonly database: string;
  readonly schema: string;
  readonly role: string;
  readonly releaseSha: string;
}

export type MediaInventoryErrorCode = 'invalid_target' | 'inventory_unavailable';

export class MediaInventoryError extends Error {
  readonly code: MediaInventoryErrorCode;
  constructor(code: MediaInventoryErrorCode) {
    super(code === 'invalid_target' ? 'media inventory target is invalid' : 'media inventory is unavailable');
    this.name = 'MediaInventoryError';
    this.code = code;
  }
}

export type MediaProfileId =
  | 'member.avatar'
  | 'skill.submission-image'
  | 'community.event-banner'
  | 'community.event-video'
  | 'community.event-highlight'
  | 'community.social-thumbnail'
  | 'member.service-cover';

export type HighlightVariant = 'image' | 'thumb';

export type MimeProvenance =
  | { readonly provenance: 'stored_webp_by_known_writer'; readonly storedType: 'image/webp' }
  | { readonly provenance: 'mime_column'; readonly column: string; readonly allowed: readonly string[] };

export interface MediaVariantSpec {
  readonly name: HighlightVariant;
  readonly sqlMaxBytes: number;
  readonly writerMaxBytes: number;
}

export interface MediaParentSpec {
  readonly table: string;
  /** Join column present on both parent and byte tables. */
  readonly keyColumn: string;
  readonly kindColumn: string;
  readonly stateColumn: string;
  readonly kinds: readonly string[];
  readonly pairedKinds: readonly string[];
  readonly activeState: string;
  readonly removedState: string;
}

export interface MediaSourceSpec {
  readonly profileId: MediaProfileId;
  readonly table: string;
  readonly keyColumns: readonly string[];
  readonly byteColumn: string;
  readonly maxBytes: number;
  readonly nullableBytes: boolean;
  readonly mime: MimeProvenance;
  readonly variantColumn: string | null;
  readonly variants: readonly MediaVariantSpec[];
  readonly parent: MediaParentSpec | null;
  readonly schemaSources: readonly string[];
}

/** Counts of byte records as canonical non-negative decimal strings (never JS numbers). */
export interface MediaAggregate {
  readonly rowCount: string;
  readonly nullCount: string;
  readonly emptyCount: string;
  readonly presentCount: string;
  readonly totalBytes: string;
  readonly maxBytes: string;
  readonly oversizeCount: string;
}

export interface VariantAggregate {
  readonly variant: HighlightVariant;
  readonly sqlMaxBytes: number;
  readonly writerMaxBytes: number;
  /** oversizeCount is classified against writerMaxBytes only; data is never corrected. */
  readonly counts: MediaAggregate;
}

export interface HighlightDetails {
  readonly image: VariantAggregate;
  readonly thumb: VariantAggregate;
  readonly unknownVariantCount: string;
  readonly orphanCount: string;
  readonly removedParentCount: string;
  readonly incompleteActivePairCount: string;
}

export type MimeEvidence = 'legacy_writer_fixed_not_content_verified' | 'mime_column_aggregated_not_content_verified';

export interface MediaProfileResult {
  readonly profileId: MediaProfileId;
  readonly table: string;
  readonly status: 'inventoried' | 'source_unavailable';
  readonly reason: 'required_source_shape_unavailable' | null;
  readonly counts: MediaAggregate | null;
  readonly unknownMimeCount: string | null;
  readonly mimeEvidence: MimeEvidence;
  readonly highlightDetails: HighlightDetails | null;
}

export interface MediaInventoryReport {
  readonly format: 'freedom.media-inventory/v1';
  readonly target: InventoryTarget;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly completeness: 'aggregate_inventory_complete' | 'incomplete';
  readonly migrationReadiness: 'not_evaluated';
  readonly releaseBinding: 'operator_declared_not_runtime_verified';
  readonly contentDigests: 'not_run';
  readonly dataMoved: false;
  readonly restore: 'not_run';
  readonly profiles: readonly MediaProfileResult[];
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

const WEBP: MimeProvenance = { provenance: 'stored_webp_by_known_writer', storedType: 'image/webp' };
const MIG = 'migrations/';

function imageSource(
  profileId: MediaProfileId,
  table: string,
  keyColumn: string,
  maxBytes: number,
  nullableBytes: boolean,
  schemaSources: readonly string[],
): MediaSourceSpec {
  return { profileId, table, keyColumns: [keyColumn], byteColumn: 'image_bytes', maxBytes, nullableBytes, mime: WEBP, variantColumn: null, variants: [], parent: null, schemaSources };
}

export const MEDIA_SOURCES: readonly MediaSourceSpec[] = deepFreeze<MediaSourceSpec[]>([
  imageSource('member.avatar', 'member_avatars', 'user_id', 131072, true, [`${MIG}016_member_avatars.sql`, `${MIG}080_avatar_asset_bridge.sql`]),
  imageSource('skill.submission-image', 'skill_submissions', 'submission_id', 524288, true, [`${MIG}028_skill_submissions.sql`]),
  imageSource('community.event-banner', 'community_event_banners', 'event_id', 524288, false, [`${MIG}045_community_event_banners.sql`]),
  {
    profileId: 'community.event-video',
    table: 'community_event_videos',
    keyColumns: ['event_id'],
    byteColumn: 'media_bytes',
    maxBytes: 20971520,
    nullableBytes: false,
    mime: { provenance: 'mime_column', column: 'mime_type', allowed: ['video/mp4', 'video/webm'] },
    variantColumn: null,
    variants: [],
    parent: null,
    schemaSources: [`${MIG}050_event_media.sql`],
  },
  {
    profileId: 'community.event-highlight',
    table: 'community_event_highlight_images',
    keyColumns: ['media_id', 'variant'],
    byteColumn: 'bytes',
    maxBytes: 1048576,
    nullableBytes: false,
    mime: WEBP,
    variantColumn: 'variant',
    variants: [
      { name: 'image', sqlMaxBytes: 1048576, writerMaxBytes: 1048576 },
      { name: 'thumb', sqlMaxBytes: 1048576, writerMaxBytes: 204800 },
    ],
    parent: {
      table: 'community_event_highlights',
      keyColumn: 'media_id',
      kindColumn: 'kind',
      stateColumn: 'state',
      kinds: ['photo', 'poster', 'link'],
      pairedKinds: ['photo', 'poster'],
      activeState: 'active',
      removedState: 'removed',
    },
    schemaSources: [`${MIG}065_event_highlights.sql`],
  },
  imageSource('community.social-thumbnail', 'community_social_post_thumbnails', 'post_id', 524288, false, [`${MIG}066_share_promotion.sql`]),
  imageSource('member.service-cover', 'member_service_covers', 'service_id', 524288, false, [`${MIG}067_member_services.sql`]),
]);

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const SHA = /^[0-9a-f]{40}$/;
const COUNT = /^(0|[1-9][0-9]*)$/;
const TARGET_KEYS: readonly string[] = ['environment', 'database', 'schema', 'role', 'releaseSha'];

const invalid = (): MediaInventoryError => new MediaInventoryError('invalid_target');
const unavailable = (): MediaInventoryError => new MediaInventoryError('inventory_unavailable');

export function validateInventoryTarget(input: unknown): InventoryTarget {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw invalid();
  const proto: unknown = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) throw invalid();
  const keys = Reflect.ownKeys(input);
  if (keys.length !== TARGET_KEYS.length) throw invalid();
  const values: Record<string, string> = {};
  for (const key of keys) {
    if (typeof key !== 'string' || !TARGET_KEYS.includes(key)) throw invalid();
    const d = Object.getOwnPropertyDescriptor(input, key);
    if (d === undefined || !('value' in d) || typeof d.value !== 'string') throw invalid();
    values[key] = d.value;
  }
  const environment = values['environment'];
  const database = values['database'];
  const schema = values['schema'];
  const role = values['role'];
  const releaseSha = values['releaseSha'];
  if (environment !== 'local' && environment !== 'staging' && environment !== 'public') throw invalid();
  if (database === undefined || schema === undefined || role === undefined || releaseSha === undefined) throw invalid();
  if (!IDENT.test(database) || !IDENT.test(schema) || !IDENT.test(role)) throw invalid();
  if (schema.startsWith('pg_') || schema === 'information_schema') throw invalid();
  if (!SHA.test(releaseSha)) throw invalid();
  if (environment === 'local' && !(database.startsWith('fp_') && schema.startsWith('fp_'))) throw invalid();
  return Object.freeze({ environment, database, schema, role, releaseSha });
}

function q(identifier: string): string {
  if (!IDENT.test(identifier)) throw unavailable();
  return `"${identifier}"`;
}

type Row = Record<string, unknown>;

async function one(client: PoolClient, sql: string, params: unknown[] = []): Promise<Row> {
  const result = await client.query<Row>(sql, params);
  const row = result.rows[0];
  if (result.rows.length !== 1 || row === undefined) throw unavailable();
  return row;
}

function count(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || !COUNT.test(value)) throw unavailable();
  return value;
}

function aggregate(row: Row): MediaAggregate {
  return {
    rowCount: count(row, 'row_count'),
    nullCount: count(row, 'null_count'),
    emptyCount: count(row, 'empty_count'),
    presentCount: count(row, 'present_count'),
    totalBytes: count(row, 'total_bytes'),
    maxBytes: count(row, 'max_bytes'),
    oversizeCount: count(row, 'oversize_count'),
  };
}

/** $1 is always the integer cap used for oversize classification. */
function aggregateSql(bytes: string, from: string, extra = ''): string {
  return `SELECT count(*)::text AS row_count,
  count(*) FILTER (WHERE ${bytes} IS NULL)::text AS null_count,
  count(*) FILTER (WHERE octet_length(${bytes}) = 0)::text AS empty_count,
  count(*) FILTER (WHERE octet_length(${bytes}) > 0)::text AS present_count,
  COALESCE(sum(octet_length(${bytes})::bigint), 0)::text AS total_bytes,
  COALESCE(max(octet_length(${bytes})), 0)::text AS max_bytes,
  count(*) FILTER (WHERE octet_length(${bytes}) > $1::integer)::text AS oversize_count${extra}
FROM ${from}`;
}

async function hasColumns(client: PoolClient, schema: string, table: string, columns: readonly string[]): Promise<boolean> {
  const result = await client.query<Row>(
    `SELECT a.attname::text AS column_name FROM pg_catalog.pg_attribute a
     JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p')
       AND NOT c.relrowsecurity AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attname = ANY($3::text[])`,
    [schema, table, [...columns]],
  );
  const found = new Set(result.rows.map((r) => r['column_name']));
  return columns.every((c) => found.has(c));
}

async function inventoryHighlight(
  client: PoolClient,
  schema: string,
  s: MediaSourceSpec,
  p: MediaParentSpec,
  variantColumn: string,
): Promise<HighlightDetails> {
  const images = `${q(schema)}.${q(s.table)} i`;
  const parents = `${q(schema)}.${q(p.table)} p`;
  const bytes = `i.${q(s.byteColumn)}`;
  const v = `i.${q(variantColumn)}::text`;
  const pk = `p.${q(p.keyColumn)}`;
  const join = `${pk} = i.${q(p.keyColumn)}`;
  const groups = new Map<HighlightVariant, VariantAggregate>();
  for (const spec of s.variants) {
    const row = await one(client, aggregateSql(bytes, `${images} WHERE ${v} = $2`), [spec.writerMaxBytes, spec.name]);
    groups.set(spec.name, { variant: spec.name, sqlMaxBytes: spec.sqlMaxBytes, writerMaxBytes: spec.writerMaxBytes, counts: aggregate(row) });
  }
  const image = groups.get('image');
  const thumb = groups.get('thumb');
  if (image === undefined || thumb === undefined) throw unavailable();
  // Asset pairs retain both original variant rows with NULL legacy bytes.
  // Count their structural pair here; verifyMedia separately checks typed ready
  // pointers and actual objects before reporting content verification.
  const assetParent = await hasColumns(client, schema, p.table, ['storage_source']);
  const exactlyOne = (param: string): string =>
    `count(*) FILTER (WHERE ${v} = ${param}) = 1 AND count(*) FILTER (WHERE ${v} = ${param} AND (octet_length(${bytes}) > 0${assetParent ? " OR p.storage_source='asset'" : ''})) = 1`;
  const row = await one(
    client,
    `SELECT
  (SELECT count(*) FROM ${images} WHERE ${v} IS NULL OR NOT (${v} = ANY($1::text[])))::text AS unknown_variant_count,
  (SELECT count(*) FROM ${images} LEFT JOIN ${parents} ON ${join} WHERE ${pk} IS NULL)::text AS orphan_count,
  (SELECT count(*) FROM ${images} JOIN ${parents} ON ${join} WHERE p.${q(p.stateColumn)}::text = $2)::text AS removed_parent_count,
  (SELECT count(*) FROM (
    SELECT ${pk} FROM ${parents} LEFT JOIN ${images} ON ${join}
    WHERE p.${q(p.stateColumn)}::text = $3 AND p.${q(p.kindColumn)}::text = ANY($4::text[])
    GROUP BY ${pk}
    HAVING NOT (${exactlyOne('$5')} AND ${exactlyOne('$6')})
  ) s)::text AS incomplete_active_pair_count`,
    [s.variants.map((x) => x.name), p.removedState, p.activeState, [...p.pairedKinds], 'image', 'thumb'],
  );
  return {
    image,
    thumb,
    unknownVariantCount: count(row, 'unknown_variant_count'),
    orphanCount: count(row, 'orphan_count'),
    removedParentCount: count(row, 'removed_parent_count'),
    incompleteActivePairCount: count(row, 'incomplete_active_pair_count'),
  };
}

async function inventorySource(client: PoolClient, schema: string, s: MediaSourceSpec): Promise<MediaProfileResult> {
  const mimeColumn = s.mime.provenance === 'mime_column' ? s.mime.column : null;
  const mimeEvidence: MimeEvidence =
    mimeColumn === null ? 'legacy_writer_fixed_not_content_verified' : 'mime_column_aggregated_not_content_verified';
  const required = [
    ...new Set([...s.keyColumns, s.byteColumn, ...(s.variantColumn === null ? [] : [s.variantColumn]), ...(mimeColumn === null ? [] : [mimeColumn])]),
  ];
  const p = s.parent;
  const available =
    (await hasColumns(client, schema, s.table, required)) &&
    (p === null || (await hasColumns(client, schema, p.table, [p.keyColumn, p.kindColumn, p.stateColumn])));
  const base = { profileId: s.profileId, table: s.table, mimeEvidence };
  if (!available) {
    return { ...base, status: 'source_unavailable', reason: 'required_source_shape_unavailable', counts: null, unknownMimeCount: null, highlightDetails: null };
  }
  const bytes = `t.${q(s.byteColumn)}`;
  const params: unknown[] = [s.maxBytes];
  let extra = '';
  if (s.mime.provenance === 'mime_column') {
    const m = `t.${q(s.mime.column)}::text`;
    extra = `, count(*) FILTER (WHERE octet_length(${bytes}) > 0 AND (${m} IS NULL OR NOT (${m} = ANY($2::text[]))))::text AS unknown_mime_count`;
    params.push([...s.mime.allowed]);
  }
  const row = await one(client, aggregateSql(bytes, `${q(schema)}.${q(s.table)} t`, extra), params);
  return {
    ...base,
    status: 'inventoried',
    reason: null,
    counts: aggregate(row),
    unknownMimeCount: mimeColumn === null ? null : count(row, 'unknown_mime_count'),
    highlightDetails: p !== null && s.variantColumn !== null ? await inventoryHighlight(client, schema, s, p, s.variantColumn) : null,
  };
}

export async function inventoryMedia(pool: Pool, target: InventoryTarget): Promise<MediaInventoryReport> {
  const snapshot = validateInventoryTarget(target);
  const startedAt = new Date().toISOString();
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch {
    throw unavailable();
  }
  let destroy = false;
  try {
    await client.query(`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    await client.query(`SET LOCAL statement_timeout = '30000'`);
    await client.query(`SET LOCAL lock_timeout = '3000'`);
    const id = await one(
      client,
      `SELECT current_database()::text AS database, current_user::text AS role, r.rolsuper AS rolsuper,
        r.rolbypassrls AS rolbypassrls, current_setting('transaction_read_only') AS read_only
       FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`,
    );
    if (id['read_only'] !== 'on') throw unavailable();
    if (id['database'] !== snapshot.database || id['role'] !== snapshot.role) throw invalid();
    if (id['rolsuper'] !== false || id['rolbypassrls'] !== false) throw invalid();
    const ns = await client.query<Row>(`SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1`, [snapshot.schema]);
    if (ns.rows.length !== 1) throw invalid();
    const profiles: MediaProfileResult[] = [];
    for (const source of MEDIA_SOURCES) profiles.push(await inventorySource(client, snapshot.schema, source));
    await client.query(`COMMIT`);
    return deepFreeze<MediaInventoryReport>({
      format: 'freedom.media-inventory/v1',
      target: snapshot,
      startedAt,
      finishedAt: new Date().toISOString(),
      completeness: profiles.every((r) => r.status === 'inventoried') ? 'aggregate_inventory_complete' : 'incomplete',
      migrationReadiness: 'not_evaluated',
      releaseBinding: 'operator_declared_not_runtime_verified',
      contentDigests: 'not_run',
      dataMoved: false,
      restore: 'not_run',
      profiles,
    });
  } catch (error) {
    try {
      await client.query(`ROLLBACK`);
    } catch {
      destroy = true;
    }
    throw new MediaInventoryError(error instanceof MediaInventoryError ? error.code : 'inventory_unavailable');
  } finally {
    client.release(destroy);
  }
}
