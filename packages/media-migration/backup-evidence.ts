import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { collectSnapshotEvidence, type SnapshotEvidence } from '../db/snapshot-evidence.js';

/** Per-schema evidence bound to one backup snapshot, in two explicitly
 * different parts:
 *  - tables: columns/counts/full-row fingerprints read in the caller's
 *    REPEATABLE READ READ ONLY transaction (the exported dump snapshot, MVCC);
 *  - sequences: EVERY sequence in the schema, including standalone ones with no
 *    OWNED BY (e.g. migration 011's positioning_guild_officer_revision). Their
 *    state is NOT MVCC: it is read after the snapshot and pg_dump reads it later
 *    again, so the recorded value is only a lower bound for the dump. Lower-bound
 *    comparison is sound only for ascending NO CYCLE sequences; anything else
 *    is rejected rather than compared under a false assumption.
 * Hash/metadata only: no row contents, connection details or diagnostics. */
export class BackupEvidenceError extends Error {
  constructor(readonly code: 'evidence_unavailable' | 'evidence_invalid' | 'evidence_mismatch' | 'evidence_unsupported_sequence') {
    super(code); this.name = 'BackupEvidenceError';
  }
}
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const INTEGER = /^(0|-?[1-9][0-9]{0,18})$/;
const COUNT = /^(0|[1-9][0-9]{0,18})$/;
const MAX_TABLES = 512;
const MAX_SEQUENCES = 1024;
export const EVIDENCE_MAX_BYTES = 4 * 1024 * 1024;

const ownedSequence = z.object({ schema: z.string().min(1).max(128), name: z.string().min(1).max(128),
  lastValue: z.string().regex(INTEGER), isCalled: z.boolean() }).strict();
const tableSchema = z.object({ schema: z.string().regex(IDENT), table: z.string().min(1).max(128),
  columns: z.array(z.object({ name: z.string().min(1).max(128), type: z.string().min(1).max(256) }).strict()).max(1600),
  count: z.string().regex(COUNT), fingerprint: z.string().regex(HEX64), sequences: z.array(ownedSequence).max(64) }).strict();
const sequenceSchema = z.object({ name: z.string().min(1).max(128), dataType: z.enum(['smallint', 'integer', 'bigint']),
  start: z.string().regex(INTEGER), increment: z.string().regex(INTEGER), min: z.string().regex(INTEGER), max: z.string().regex(INTEGER),
  cycle: z.literal(false), lastValue: z.string().regex(INTEGER), isCalled: z.boolean() }).strict();
const evidenceSchema = z.object({ format: z.literal('freedom.snapshot-evidence/v2'), schema: z.string().regex(IDENT),
  tableSnapshot: z.literal('exported_snapshot_mvcc'), sequenceState: z.literal('read_after_snapshot_lower_bound'),
  tables: z.array(tableSchema).max(MAX_TABLES), sequences: z.array(sequenceSchema).max(MAX_SEQUENCES) }).strict();
export type SchemaEvidence = z.infer<typeof evidenceSchema>;
type SequenceEvidence = z.infer<typeof sequenceSchema>;

async function collectSequences(client: PoolClient, schema: string): Promise<SequenceEvidence[]> {
  const rows = (await client.query(`SELECT c.relname AS name, pg_catalog.format_type(s.seqtypid, NULL) AS data_type,
      s.seqstart::text AS start, s.seqincrement::text AS increment, s.seqmin::text AS min, s.seqmax::text AS max, s.seqcycle AS cycle
     FROM pg_catalog.pg_sequence s JOIN pg_catalog.pg_class c ON c.oid=s.seqrelid
     JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relkind='S' ORDER BY c.relname`, [schema])).rows as Record<string, unknown>[];
  if (rows.length > MAX_SEQUENCES) throw new BackupEvidenceError('evidence_unavailable');
  const out: SequenceEvidence[] = [];
  for (const row of rows) {
    if (typeof row.name !== 'string') throw new BackupEvidenceError('evidence_unavailable');
    // Lower-bound comparison is only meaningful for ascending, non-cycling sequences.
    if (row.cycle !== false || typeof row.increment !== 'string' || !/^[1-9][0-9]{0,18}$/.test(row.increment))
      throw new BackupEvidenceError('evidence_unsupported_sequence');
    const quoted = `"${schema}"."${row.name.replace(/"/g, '""')}"`;
    const state = (await client.query(`SELECT last_value::text AS last_value, is_called FROM ${quoted}`)).rows[0] as Record<string, unknown> | undefined;
    const parsed = sequenceSchema.safeParse({ name: row.name, dataType: row.data_type, start: row.start, increment: row.increment,
      min: row.min, max: row.max, cycle: row.cycle, lastValue: state?.last_value, isCalled: state?.is_called });
    if (!parsed.success) throw new BackupEvidenceError('evidence_unavailable');
    out.push(parsed.data);
  }
  return out;
}

/** Enumerates every ordinary/partitioned root table and every sequence in one
 * schema inside the caller's snapshot transaction. */
export async function collectSchemaEvidence(client: PoolClient, schema: string): Promise<SchemaEvidence> {
  if (typeof schema !== 'string' || !IDENT.test(schema)) throw new BackupEvidenceError('evidence_invalid');
  let evidence: SnapshotEvidence, sequences: SequenceEvidence[];
  try {
    const rows = (await client.query(`SELECT c.relname AS table
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=$1 AND c.relkind IN ('r','p') AND NOT c.relispartition
       ORDER BY c.relname`, [schema])).rows as { table: unknown }[];
    if (rows.length > MAX_TABLES || rows.some(r => typeof r.table !== 'string')) throw new Error();
    // Sequences first: the table collector switches search_path for the rest of the transaction.
    sequences = await collectSequences(client, schema);
    evidence = await collectSnapshotEvidence(client, rows.map(r => ({ schema, table: r.table as string })));
  } catch (e) {
    if (e instanceof BackupEvidenceError && e.code === 'evidence_unsupported_sequence') throw new BackupEvidenceError(e.code);
    throw new BackupEvidenceError('evidence_unavailable');
  }
  return parseEvidenceValue({ format: 'freedom.snapshot-evidence/v2', schema, tableSnapshot: 'exported_snapshot_mvcc',
    sequenceState: 'read_after_snapshot_lower_bound', tables: evidence.tables, sequences });
}

function parseEvidenceValue(value: unknown): SchemaEvidence {
  const parsed = evidenceSchema.safeParse(value);
  if (!parsed.success) throw new BackupEvidenceError('evidence_invalid');
  const seen = new Set<string>();
  for (const t of parsed.data.tables) {
    if (t.schema !== parsed.data.schema || seen.has(t.table)) throw new BackupEvidenceError('evidence_invalid');
    seen.add(t.table);
  }
  const names = new Set<string>();
  for (const s of parsed.data.sequences) {
    if (names.has(s.name) || BigInt(s.increment) <= 0n) throw new BackupEvidenceError('evidence_invalid');
    names.add(s.name);
  }
  return parsed.data;
}
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Deterministic encoding with fixed key order and sorted members. */
export function encodeEvidence(evidence: SchemaEvidence): Uint8Array {
  const value = parseEvidenceValue(evidence);
  const tables = [...value.tables].sort((a, b) => byText(a.table, b.table)).map(t => ({
    schema: t.schema, table: t.table, columns: t.columns.map(c => ({ name: c.name, type: c.type })), count: t.count,
    fingerprint: t.fingerprint, sequences: t.sequences.map(s => ({ schema: s.schema, name: s.name, lastValue: s.lastValue, isCalled: s.isCalled })) }));
  const sequences = [...value.sequences].sort((a, b) => byText(a.name, b.name)).map(s => ({ name: s.name, dataType: s.dataType,
    start: s.start, increment: s.increment, min: s.min, max: s.max, cycle: s.cycle, lastValue: s.lastValue, isCalled: s.isCalled }));
  const bytes = new TextEncoder().encode(JSON.stringify({ format: value.format, schema: value.schema, tableSnapshot: value.tableSnapshot,
    sequenceState: value.sequenceState, tables, sequences }));
  if (bytes.byteLength > EVIDENCE_MAX_BYTES) throw new BackupEvidenceError('evidence_invalid');
  return bytes;
}

/** Strict decode: only the exact canonical encoding is accepted. */
export function decodeEvidence(bytes: Uint8Array): SchemaEvidence {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > EVIDENCE_MAX_BYTES) throw new BackupEvidenceError('evidence_invalid');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new BackupEvidenceError('evidence_invalid'); }
  const evidence = parseEvidenceValue(value);
  if (!Buffer.from(encodeEvidence(evidence)).equals(Buffer.from(bytes))) throw new BackupEvidenceError('evidence_invalid');
  return evidence;
}

export function evidenceSha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

export interface EvidenceComparison {
  /** MVCC part: exact equality at the dump snapshot. */
  readonly tables: number;
  readonly rows: string;
  /** Non-MVCC part: every schema sequence present with identical definition and lastValue >= recorded. */
  readonly sequences: number;
  readonly sequencesAdvanced: number;
}

function notBehind(before: { lastValue: string; isCalled: boolean }, after: { lastValue: string; isCalled: boolean }): 'same' | 'advanced' {
  const b = BigInt(before.lastValue), a = BigInt(after.lastValue);
  if (a < b || (a === b && before.isCalled && !after.isCalled)) throw new BackupEvidenceError('evidence_mismatch');
  return a === b && before.isCalled === after.isCalled ? 'same' : 'advanced';
}

/** Restored schema must contain exactly the recorded tables with identical
 * columns, counts and full-row fingerprints, and exactly the recorded
 * sequences with identical definitions. A missing, extra, redefined or reset
 * (lower) sequence is a mismatch; a higher value is reported, not hidden. */
export function compareEvidence(recorded: SchemaEvidence, restored: SchemaEvidence): EvidenceComparison {
  const a = parseEvidenceValue(recorded), b = parseEvidenceValue(restored);
  const mismatch = (): never => { throw new BackupEvidenceError('evidence_mismatch'); };
  if (a.schema !== b.schema || a.tables.length !== b.tables.length || a.sequences.length !== b.sequences.length) mismatch();
  const restoredByName = new Map(b.tables.map(t => [t.table, t]));
  let rows = 0n, sequencesAdvanced = 0;
  for (const t of a.tables) {
    const r = restoredByName.get(t.table);
    if (!r || r.count !== t.count || r.fingerprint !== t.fingerprint || JSON.stringify(r.columns) !== JSON.stringify(t.columns)) mismatch();
    const owned = new Map(r!.sequences.map(s => [`${s.schema}\0${s.name}`, s]));
    if (owned.size !== t.sequences.length) mismatch();
    for (const s of t.sequences) {
      const q = owned.get(`${s.schema}\0${s.name}`);
      if (!q) mismatch();
      notBehind(s, q!);
    }
    rows += BigInt(t.count);
  }
  const restoredSequences = new Map(b.sequences.map(s => [s.name, s]));
  for (const s of a.sequences) {
    const q = restoredSequences.get(s.name);
    if (!q || q.dataType !== s.dataType || q.start !== s.start || q.increment !== s.increment || q.min !== s.min
      || q.max !== s.max || q.cycle !== s.cycle) mismatch();
    if (notBehind(s, q!) === 'advanced') sequencesAdvanced++;
  }
  return Object.freeze({ tables: a.tables.length, rows: rows.toString(), sequences: a.sequences.length, sequencesAdvanced });
}
