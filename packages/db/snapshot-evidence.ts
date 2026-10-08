/** Initial implementation authored by Grok 4.7 CLI; reviewed and hardened by GPT-6.1 Sol.
 * Caller owns an explicit read-only repeatable-read/serializable transaction.
 * Sequence state is not MVCC: fence source writes/nextval before migration evidence.
 * Results contain hashes and metadata, never row contents or connection diagnostics.
 */
import { createHash, type Hash } from 'node:crypto';
import type { PoolClient } from 'pg';

export interface SnapshotColumn {
  name: string;
  type: string;
}

export interface SnapshotSequenceState {
  schema: string;
  name: string;
  lastValue: string;
  isCalled: boolean;
}

export interface SnapshotTableEvidence {
  schema: string;
  table: string;
  columns: SnapshotColumn[];
  count: string;
  fingerprint: string;
  sequences: SnapshotSequenceState[];
}

export interface SnapshotEvidence {
  tables: SnapshotTableEvidence[];
}

const MAX_TABLES = 512;
const MAX_ROWS = 250000;
const MAX_ROWS_TEXT = '250000';
const FAILURE = 'snapshot_evidence_unavailable';

function fail(): never {
  throw new Error(FAILURE);
}

function quoteIdent(identifier: string): string {
  if (identifier.length === 0 || identifier.includes('\0')) fail();
  return `"${identifier.replace(/"/g, '""')}"`;
}

function qualifiedName(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') fail();
  return value;
}

function bool(row: Record<string, unknown>, key: string): boolean {
  const value = row[key];
  if (typeof value !== 'boolean') fail();
  return value;
}

function isCanonicalCount(value: string): boolean {
  return /^(0|[1-9][0-9]{0,18})$/.test(value);
}

function isCanonicalInteger(value: string): boolean {
  return /^(0|-?[1-9][0-9]{0,18})$/.test(value);
}

function countExceeds(count: string, limit: string): boolean {
  if (count.length !== limit.length) return count.length > limit.length;
  return count > limit;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function writePrefixed(hash: Hash, value: string): void {
  const byteLength = new TextEncoder().encode(value).byteLength;
  hash.update(String(byteLength), 'utf8');
  hash.update(':', 'utf8');
  hash.update(value, 'utf8');
  hash.update('\n', 'utf8');
}

function digestSortedRowHashes(sortedHashes: readonly string[]): string {
  const hash = createHash('sha256');
  for (const rowHash of sortedHashes) {
    hash.update(rowHash, 'utf8');
    hash.update('\n', 'utf8');
  }
  return hash.digest('hex');
}

function tableFingerprint(
  columns: readonly SnapshotColumn[],
  count: string,
  sortedHashes: readonly string[],
): string {
  const hash = createHash('sha256');
  hash.update('snapshot-evidence-v1\n', 'utf8');
  writePrefixed(hash, count);
  for (const column of columns) {
    writePrefixed(hash, column.name);
    writePrefixed(hash, column.type);
  }
  writePrefixed(hash, digestSortedRowHashes(sortedHashes));
  return hash.digest('hex');
}

async function query(
  client: PoolClient,
  sql: string,
  params: readonly string[] = [],
): Promise<Record<string, unknown>[]> {
  const result = await client.query(sql, params as string[]);
  if (!Array.isArray(result.rows)) fail();
  return result.rows as Record<string, unknown>[];
}

function validateTables(tables: readonly { schema: string; table: string }[]): void {
  if (!Array.isArray(tables) || tables.length > MAX_TABLES) fail();
  const seen = new Set<string>();
  for (const entry of tables) {
    if (entry === null || typeof entry !== 'object') fail();
    const schema = entry.schema;
    const table = entry.table;
    if (typeof schema !== 'string' || typeof table !== 'string') fail();
    quoteIdent(schema);
    quoteIdent(table);
    const key = `${schema}\0${table}`;
    if (seen.has(key)) fail();
    seen.add(key);
  }
}

async function assertSnapshotTransaction(client: PoolClient): Promise<void> {
  // SAVEPOINT rejects autocommit even if session defaults mimic a snapshot transaction.
  await query(client, 'SAVEPOINT freedom_snapshot_evidence_guard');
  await query(client, 'RELEASE SAVEPOINT freedom_snapshot_evidence_guard');
  const rows = await query(
    client,
    `SELECT pg_catalog.current_setting('transaction_read_only') AS read_only,
            pg_catalog.current_setting('transaction_isolation') AS isolation`,
  );
  if (rows.length !== 1) fail();
  if (text(rows[0], 'read_only') !== 'on') fail();
  const isolation = text(rows[0], 'isolation');
  if (isolation !== 'repeatable read' && isolation !== 'serializable') fail();
}

async function setSnapshotFormats(client: PoolClient): Promise<void> {
  await query(client, `SET LOCAL search_path = pg_catalog`);
  await query(client, `SET LOCAL TimeZone = 'UTC'`);
  await query(client, `SET LOCAL DateStyle = 'ISO, YMD'`);
  await query(client, `SET LOCAL extra_float_digits = 3`);
  await query(client, `SET LOCAL bytea_output = 'hex'`);
  // Fail closed. A non-owner subject to row security errors instead of
  // returning a silently filtered snapshot. Table owners are unchanged.
  await query(client, `SET LOCAL row_security = off`);
  const rows = await query(
    client,
    `SELECT pg_catalog.current_setting('TimeZone') AS time_zone,
            pg_catalog.current_setting('DateStyle') AS date_style,
            pg_catalog.current_setting('extra_float_digits') AS extra_float_digits,
            pg_catalog.current_setting('bytea_output') AS bytea_output,
            pg_catalog.current_setting('row_security') AS row_security`,
  );
  if (rows.length !== 1) fail();
  if (text(rows[0], 'time_zone') !== 'UTC') fail();
  if (text(rows[0], 'date_style') !== 'ISO, YMD') fail();
  if (text(rows[0], 'extra_float_digits') !== '3') fail();
  if (text(rows[0], 'bytea_output') !== 'hex') fail();
  if (text(rows[0], 'row_security') !== 'off') fail();
}

function quotedSha256Call(schema: string): string {
  const call = `${quoteIdent(schema)}.sha256`;
  if (!/^"(?:[^"]|"")*"\.sha256$/.test(call)) fail();
  return call;
}

async function resolveSha256(client: PoolClient): Promise<string> {
  const rows = await query(
    client,
    `SELECT n.nspname AS schema
       FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       LEFT JOIN pg_catalog.pg_depend d
         ON d.classid = 'pg_catalog.pg_proc'::regclass
        AND d.objid = p.oid
        AND d.refclassid = 'pg_catalog.pg_extension'::regclass
        AND d.deptype = 'e'
       LEFT JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
      WHERE p.proname = 'sha256'
        AND p.prokind = 'f'
        AND pg_catalog.pg_get_function_identity_arguments(p.oid) = 'bytea'
        AND (n.nspname = 'pg_catalog' OR e.extname = 'pgcrypto')
      ORDER BY CASE WHEN n.nspname = 'pg_catalog' THEN 0 ELSE 1 END, n.nspname
      LIMIT 1`,
  );
  if (rows.length !== 1) fail();
  return quotedSha256Call(text(rows[0], 'schema'));
}

async function loadColumns(
  client: PoolClient,
  schema: string,
  table: string,
): Promise<SnapshotColumn[]> {
  const relations = await query(
    client,
    `SELECT 1 AS present
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relname = $2
        AND c.relkind IN ('r', 'p')`,
    [schema, table],
  );
  if (relations.length !== 1) fail();
  const rows = await query(
    client,
    `SELECT a.attname AS name,
            pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relname = $2
        AND c.relkind IN ('r', 'p')
        AND a.attnum > 0
        AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [schema, table],
  );
  const columns: SnapshotColumn[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const name = text(row, 'name');
    const type = text(row, 'data_type');
    if (name.length === 0 || type.length === 0 || name.includes('\0') || type.includes('\0')) fail();
    if (seen.has(name)) fail();
    seen.add(name);
    columns.push({ name, type });
  }
  return columns;
}

async function loadCount(client: PoolClient, schema: string, table: string): Promise<string> {
  const rows = await query(
    client,
    `SELECT pg_catalog.count(*)::text AS count FROM ${qualifiedName(schema, table)}`,
  );
  if (rows.length !== 1) fail();
  const count = text(rows[0], 'count');
  if (!isCanonicalCount(count) || countExceeds(count, MAX_ROWS_TEXT)) fail();
  return count;
}

async function loadRowHashes(
  client: PoolClient,
  schema: string,
  table: string,
  sha256Call: string,
  count: string,
): Promise<string[]> {
  const rows = await query(
    client,
    `SELECT pg_catalog.encode(${sha256Call}(pg_catalog.convert_to(pg_catalog.to_jsonb(t.*)::text, 'UTF8')), 'hex') AS hash
       FROM ${qualifiedName(schema, table)} AS t`,
  );
  if (rows.length > MAX_ROWS || count !== String(rows.length)) fail();
  const hashes: string[] = [];
  for (const row of rows) {
    const rowHash = text(row, 'hash');
    if (!/^[0-9a-f]{64}$/.test(rowHash)) fail();
    hashes.push(rowHash);
  }
  hashes.sort(compareText);
  return hashes;
}

async function loadSequences(
  client: PoolClient,
  schema: string,
  table: string,
): Promise<SnapshotSequenceState[]> {
  const rows = await query(
    client,
    `SELECT nseq.nspname AS schema, seq.relname AS name
       FROM pg_catalog.pg_depend d
       JOIN pg_catalog.pg_class seq ON seq.oid = d.objid
       JOIN pg_catalog.pg_namespace nseq ON nseq.oid = seq.relnamespace
       JOIN pg_catalog.pg_class tbl ON tbl.oid = d.refobjid
       JOIN pg_catalog.pg_namespace ntbl ON ntbl.oid = tbl.relnamespace
      WHERE d.classid = 'pg_catalog.pg_class'::regclass
        AND d.refclassid = 'pg_catalog.pg_class'::regclass
        AND d.deptype IN ('a', 'i')
        AND seq.relkind = 'S'
        AND ntbl.nspname = $1
        AND tbl.relname = $2
      GROUP BY nseq.nspname, seq.relname`,
    [schema, table],
  );
  const sequences: SnapshotSequenceState[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const sequenceSchema = text(row, 'schema');
    const sequenceName = text(row, 'name');
    const key = `${sequenceSchema}\0${sequenceName}`;
    if (seen.has(key)) fail();
    seen.add(key);
    const state = await query(
      client,
      `SELECT last_value::text AS last_value, is_called
         FROM ${qualifiedName(sequenceSchema, sequenceName)}`,
    );
    if (state.length !== 1) fail();
    const lastValue = text(state[0], 'last_value');
    if (!isCanonicalInteger(lastValue)) fail();
    sequences.push({
      schema: sequenceSchema,
      name: sequenceName,
      lastValue,
      isCalled: bool(state[0], 'is_called'),
    });
  }
  sequences.sort(
    (left, right) => compareText(left.schema, right.schema) || compareText(left.name, right.name),
  );
  return sequences;
}

async function evidenceForTable(
  client: PoolClient,
  schema: string,
  table: string,
  sha256Call: string,
): Promise<SnapshotTableEvidence> {
  const columns = await loadColumns(client, schema, table);
  const count = await loadCount(client, schema, table);
  const rowHashes = await loadRowHashes(client, schema, table, sha256Call, count);
  const sequences = await loadSequences(client, schema, table);
  return {
    schema,
    table,
    columns,
    count,
    fingerprint: tableFingerprint(columns, count, rowHashes),
    sequences,
  };
}

async function collect(
  client: PoolClient,
  tables: readonly { schema: string; table: string }[],
): Promise<SnapshotEvidence> {
  validateTables(tables);
  await assertSnapshotTransaction(client);
  await setSnapshotFormats(client);
  const sha256Call = tables.length === 0 ? '' : await resolveSha256(client);
  const evidence: SnapshotTableEvidence[] = [];
  for (const entry of [...tables].sort((a, b) => compareText(a.schema, b.schema) || compareText(a.table, b.table))) {
    evidence.push(await evidenceForTable(client, entry.schema, entry.table, sha256Call));
  }
  return { tables: evidence };
}

export async function collectSnapshotEvidence(
  client: PoolClient,
  tables: readonly { schema: string; table: string }[],
): Promise<SnapshotEvidence> {
  try {
    return await collect(client, tables);
  } catch {
    throw new Error(FAILURE);
  }
}
