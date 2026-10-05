import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { ObjectStore } from '../asset-storage/index.js';
import type { ConsistentBackup } from './backup-coordinator.js';
import { MediaBackupError, transferRestore, verifyStoredBackup, type BackupManifest, type RestoreAuthorization,
  type RestoreResult, type TransferOptions } from './backup-transfer.js';
import { BackupEvidenceError, collectSchemaEvidence, compareEvidence, decodeEvidence, encodeEvidence, evidenceSha256,
  EVIDENCE_MAX_BYTES, type EvidenceComparison, type SchemaEvidence } from './backup-evidence.js';

/* Recovery-set archive: one sealed, read-back-verified unit binding a
 * same-exported-snapshot pg_dump, its optional per-table evidence and the
 * pinned object manifest produced by createConsistentAssetBackup.
 *
 * Not a scheduler, PITR, signature or attestation. The archive store is an
 * explicit operator port (no credentials or discovery here). Nothing in this
 * module deletes or overwrites archive/R2 data: every write is create-only and
 * a differing existing object is a conflict, never a repair. */

export type RecoveryArchiveErrorCode =
  | 'invalid_input' | 'archive_unavailable' | 'archive_missing' | 'archive_conflict' | 'archive_corrupt' | 'source_unavailable'
  | 'dump_mismatch' | 'evidence_unavailable' | 'evidence_mismatch' | 'objects_unverified'
  | 'restore_target_mismatch' | 'restore_target_not_empty' | 'restore_failed' | 'objects_restore_failed';

export class RecoveryArchiveError extends Error {
  /** Fixed enumerated sub-code only (e.g. MediaBackupError code); never upstream text. */
  readonly detail?: string;
  constructor(readonly code: RecoveryArchiveErrorCode, detail?: string) {
    super(code); this.name = 'RecoveryArchiveError';
    if (detail !== undefined) this.detail = detail;
  }
}
function fail(code: RecoveryArchiveErrorCode, detail?: string): never { throw new RecoveryArchiveError(code, detail); }

/** Operator-supplied archive port. Implementations must make putIfAbsent
 * atomic create-only (never overwrite) and must not expose credentials,
 * locations or upstream diagnostics through thrown errors. */
export interface ArchiveStore {
  putIfAbsent(key: string, body: ReadableStream<Uint8Array>): Promise<'created' | 'exists'>;
  get(key: string): Promise<ReadableStream<Uint8Array> | null>;
  /** All object keys below prefix. Must throw rather than truncate above limit. */
  list(prefix: string, limit: number): Promise<readonly string[]>;
}
/** Trusted port that streams the dump persisted by DatabaseSnapshotWriter. */
export interface DumpSource { open(): Promise<ReadableStream<Uint8Array>> }
/** Trusted port: pg_restore --single-transaction --exit-on-error into the
 * verified empty target. It must fully consume `archive` and must abort (kill
 * pg_restore so the single transaction rolls back) if the stream errors: the
 * digest is re-verified while streaming and a mismatch errors the stream
 * instead of ending it. */
export interface DatabaseRestoreWriter {
  restore(input: Readonly<{ database: string; schema: string; archive: ReadableStream<Uint8Array> }>): Promise<void>;
}

export const RECOVERY_SET_PREFIX = 'recovery-sets/';
export const RECOVERY_SET_FORMAT = 'freedom.recovery-set/v1';
export const READBACK_FORMAT = 'freedom.recovery-set-readback/v1';
const MIB = 1024 * 1024;
export const DUMP_MAX_BYTES = 1024 * MIB;
const MANIFEST_MAX_BYTES = 16 * MIB;
const RECEIPT_MAX_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const recoverySetKeys = (setId: string) => {
  if (typeof setId !== 'string' || !UUID.test(setId)) fail('invalid_input');
  const base = `${RECOVERY_SET_PREFIX}${setId}/`;
  return Object.freeze({ base, dump: `${base}database.dump`, evidence: `${base}snapshot-evidence.json`,
    manifest: `${base}recovery-set.json`, readbackPrefix: `${base}readback/`,
    receipt: (receiptId: string) => {
      if (typeof receiptId !== 'string' || !UUID.test(receiptId)) fail('invalid_input');
      return `${base}readback/${receiptId}.json`;
    } });
};

export function parseInstant(value: unknown): number {
  if (typeof value !== 'string' || !INSTANT.test(value)) fail('invalid_input');
  const ms = Date.parse(value as string);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) fail('invalid_input');
  return ms;
}

// ---- canonical manifest ----------------------------------------------------
const reference = z.object({ asset_id: z.string(), scope_id: z.string(), representation_id: z.string(),
  policy_revision: z.string(), byte_size: z.number(), content_sha256: z.string() }).strict();
const metadata = z.object({ contentType: z.string(), byteSize: z.number(), sha256: z.string(), transformVersion: z.string(),
  policyRevision: z.string(), profileId: z.string().optional() }).strict();
const objectsManifest = z.object({ version: z.literal(1),
  capture: z.object({ captureId: z.string().regex(UUID), referenceSnapshot: z.string().max(8192), sourceRelease: z.string().regex(/^[0-9a-f]{40}$/),
    sourceSchema: z.string().regex(IDENT), references: z.array(reference).max(10_000) }).strict(),
  objects: z.array(z.object({ key: z.string().max(256), metadata }).strict()).max(10_000),
  status: z.literal('objects_verified') }).strict();
const body = z.object({
  setId: z.string().regex(UUID),
  environment: z.enum(['production', 'staging', 'local']),
  database: z.string().regex(IDENT), schema: z.string().regex(IDENT), sourceRelease: z.string().regex(/^[0-9a-f]{40}$/),
  createdAt: z.string().regex(INSTANT),
  consistency: z.object({ mode: z.literal('same_exported_snapshot'), captureId: z.string().regex(UUID),
    referenceSnapshot: z.string().max(8192), sourcePins: z.literal('held_until_retention_release') }).strict(),
  dump: z.object({ key: z.string(), format: z.literal('pg_dump_custom'), sha256: z.string().regex(HEX64),
    byteSize: z.number().int().positive().max(DUMP_MAX_BYTES) }).strict(),
  evidence: z.discriminatedUnion('status', [
    z.object({ status: z.literal('captured'), key: z.string(), sha256: z.string().regex(HEX64),
      byteSize: z.number().int().positive().max(EVIDENCE_MAX_BYTES), tables: z.number().int().nonnegative().max(512) }).strict(),
    z.object({ status: z.literal('unavailable') }).strict(),
  ]),
  objects: objectsManifest,
  objectCount: z.number().int().nonnegative().max(10_000),
  objectBytes: z.number().int().nonnegative(),
}).strict();
export type RecoverySetBody = z.infer<typeof body>;

function canonicalObjects(m: z.infer<typeof objectsManifest>) {
  return { version: m.version, capture: { captureId: m.capture.captureId, referenceSnapshot: m.capture.referenceSnapshot,
    sourceRelease: m.capture.sourceRelease, sourceSchema: m.capture.sourceSchema,
    references: m.capture.references.map(r => ({ asset_id: r.asset_id, scope_id: r.scope_id, representation_id: r.representation_id,
      policy_revision: r.policy_revision, byte_size: r.byte_size, content_sha256: r.content_sha256 })) },
  objects: m.objects.map(o => ({ key: o.key, metadata: { contentType: o.metadata.contentType, byteSize: o.metadata.byteSize,
    sha256: o.metadata.sha256, transformVersion: o.metadata.transformVersion, policyRevision: o.metadata.policyRevision,
    ...(o.metadata.profileId === undefined ? {} : { profileId: o.metadata.profileId }) } })),
  status: m.status };
}
function canonicalBody(b: RecoverySetBody) {
  return { setId: b.setId, environment: b.environment, database: b.database, schema: b.schema, sourceRelease: b.sourceRelease,
    createdAt: b.createdAt,
    consistency: { mode: b.consistency.mode, captureId: b.consistency.captureId, referenceSnapshot: b.consistency.referenceSnapshot,
      sourcePins: b.consistency.sourcePins },
    dump: { key: b.dump.key, format: b.dump.format, sha256: b.dump.sha256, byteSize: b.dump.byteSize },
    evidence: b.evidence.status === 'captured' ? { status: b.evidence.status, key: b.evidence.key, sha256: b.evidence.sha256,
      byteSize: b.evidence.byteSize, tables: b.evidence.tables } : { status: b.evidence.status },
    objects: canonicalObjects(b.objects), objectCount: b.objectCount, objectBytes: b.objectBytes };
}
/** Cross-field invariants beyond shape. */
function checkBody(b: RecoverySetBody): RecoverySetBody {
  const keys = recoverySetKeys(b.setId);
  if (b.dump.key !== keys.dump || (b.evidence.status === 'captured' && b.evidence.key !== keys.evidence)
    || b.objects.capture.captureId !== b.consistency.captureId || b.objects.capture.referenceSnapshot !== b.consistency.referenceSnapshot
    || b.objects.capture.sourceSchema !== b.schema || b.objects.capture.sourceRelease !== b.sourceRelease
    || b.objects.objects.length !== b.objectCount || b.objects.capture.references.length !== b.objectCount
    || b.objects.objects.reduce((n, o) => n + o.metadata.byteSize, 0) !== b.objectBytes) fail('archive_corrupt');
  parseInstant(b.createdAt);
  return b;
}
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

export function encodeRecoverySet(value: RecoverySetBody): Uint8Array {
  const parsed = body.safeParse(value);
  if (!parsed.success) fail('invalid_input');
  const canonical = JSON.stringify(canonicalBody(checkBody(parsed.data!)));
  const bytes = new TextEncoder().encode(`{"format":"${RECOVERY_SET_FORMAT}","bodySha256":"${sha(canonical)}","body":${canonical}}`);
  if (bytes.byteLength > MANIFEST_MAX_BYTES) fail('invalid_input');
  return bytes;
}
/** Accepts only the exact canonical encoding with a matching body digest.
 * Detects corruption/ambiguity; it is not a signature against a writer. */
export function decodeRecoverySet(bytes: Uint8Array): { body: RecoverySetBody; manifestSha256: string } {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MANIFEST_MAX_BYTES) fail('archive_corrupt');
  let envelope: unknown;
  try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('archive_corrupt'); }
  const outer = z.object({ format: z.literal(RECOVERY_SET_FORMAT), bodySha256: z.string().regex(HEX64), body: z.unknown() }).strict()
    .safeParse(envelope);
  if (!outer.success) fail('archive_corrupt');
  const inner = body.safeParse(outer.data!.body);
  if (!inner.success) fail('archive_corrupt');
  let again: Uint8Array;
  try { again = encodeRecoverySet(inner.data!); } catch { fail('archive_corrupt'); }
  if (!Buffer.from(again!).equals(Buffer.from(bytes))) fail('archive_corrupt');
  return { body: inner.data!, manifestSha256: sha(bytes) };
}

// ---- stream helpers ---------------------------------------------------------
interface Measured {
  readonly stream: ReadableStream<Uint8Array>;
  result(): { sha256: string; byteSize: number } | undefined;
  /** Set only when this pass-through itself rejected the bytes. */
  failure(): RecoveryArchiveErrorCode | undefined;
}
/** Pass-through hash/count. With `expected`, overflow errors immediately and a
 * final size/digest mismatch errors the stream INSTEAD of a clean end. */
function measured(source: ReadableStream<Uint8Array>, maxBytes: number, expected?: { sha256: string; byteSize: number },
  mismatch: RecoveryArchiveErrorCode = 'dump_mismatch'): Measured {
  const hash = createHash('sha256'); let size = 0; let final: { sha256: string; byteSize: number } | undefined;
  let failed: RecoveryArchiveErrorCode | undefined;
  const reject = (code: RecoveryArchiveErrorCode) => { failed = code; return new RecoveryArchiveError(code); };
  const stream = source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (!(chunk instanceof Uint8Array)) throw reject('archive_corrupt');
      size += chunk.byteLength;
      if (size > maxBytes || (expected && size > expected.byteSize)) throw reject(mismatch);
      hash.update(chunk); controller.enqueue(chunk);
    },
    flush() {
      const digest = hash.digest('hex');
      if (expected && (size !== expected.byteSize || digest !== expected.sha256)) throw reject(mismatch);
      final = { sha256: digest, byteSize: size };
    },
  }));
  return { stream, result: () => final, failure: () => failed };
}
async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  try { for (;;) { const { done } = await reader.read(); if (done) return; } } finally { reader.releaseLock(); }
}
const once = (bytes: Uint8Array) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
const own = (e: unknown): e is RecoveryArchiveError => e instanceof RecoveryArchiveError && Object.getPrototypeOf(e) === RecoveryArchiveError.prototype;

/** Store exceptions never select a code or leak text. */
async function storeCall<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch { return fail('archive_unavailable'); }
}
async function getBytes(archive: ArchiveStore, key: string, max: number): Promise<Uint8Array | null> {
  const stream = await storeCall(() => archive.get(key));
  if (stream === null) return null;
  const chunks: Uint8Array[] = []; let size = 0; let corrupt = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || (size += value.byteLength) > max) {
        corrupt = true; try { await reader.cancel(); } catch { /* bounded */ } break;
      }
      chunks.push(value);
    }
  } catch { fail('archive_unavailable'); } finally { try { reader?.releaseLock(); } catch { /* released */ } }
  if (corrupt) fail('archive_corrupt');
  return new Uint8Array(Buffer.concat(chunks, size));
}
/** Hash an archived blob fully against expected size/digest. */
async function verifyBlob(archive: ArchiveStore, key: string, expected: { sha256: string; byteSize: number }, max: number,
  mismatch: RecoveryArchiveErrorCode): Promise<void> {
  const stream = await storeCall(() => archive.get(key));
  if (stream === null) fail('archive_missing');
  const m = measured(stream!, max, expected, mismatch);
  try { await drain(m.stream); } catch { fail(m.failure() ?? 'archive_unavailable'); }
  if (!m.result()) fail(mismatch);
}
/** Create-only put of a measured stream. `exists` is accepted only when the
 * stored bytes verify identically (immutable resume); otherwise conflict. */
async function putVerified(archive: ArchiveStore, key: string, open: () => Promise<ReadableStream<Uint8Array>>,
  expected: { sha256: string; byteSize: number }, max: number, mismatch: RecoveryArchiveErrorCode): Promise<void> {
  let source: ReadableStream<Uint8Array>;
  try { source = await open(); } catch { fail('source_unavailable'); }
  const m = measured(source!, max, expected, mismatch);
  let outcome: 'created' | 'exists';
  // Only this pass-through's own observation selects a mismatch code; a store
  // error object (possibly forged) never does.
  try { outcome = await archive.putIfAbsent(key, m.stream); } catch { fail(m.failure() ?? 'archive_unavailable'); }
  if (outcome! === 'exists') {
    try { await m.stream.cancel(); } catch { /* source no longer needed */ }
    try { await verifyBlob(archive, key, expected, max, 'archive_conflict'); }
    catch (e) { if (own(e) && e.code === 'archive_unavailable') throw e; fail('archive_conflict'); }
    return;
  }
  if (m.failure()) fail(m.failure()!);
  if (outcome! !== 'created' || !m.result()) fail('archive_unavailable');
}

// ---- seal / readback --------------------------------------------------------
export interface RecoverySetVerification {
  readonly status: 'recovery_set_verified';
  readonly setId: string;
  readonly manifestSha256: string;
  readonly environment: RecoverySetBody['environment'];
  readonly database: string;
  readonly schema: string;
  readonly sourceRelease: string;
  readonly createdAt: string;
  readonly verifiedAt: string;
  readonly captureId: string;
  readonly dump: Readonly<{ sha256: string; byteSize: number }>;
  readonly evidence: Readonly<{ status: 'captured'; sha256: string; tables: number } | { status: 'unavailable' }>;
  readonly objects: Readonly<{ count: number; bytes: number }>;
  readonly receiptKey?: string;
}

function objectsError(e: unknown, code: RecoveryArchiveErrorCode): never {
  if (e instanceof MediaBackupError && Object.getPrototypeOf(e) === MediaBackupError.prototype) fail(code, e.code);
  fail(code);
}

/** Seal a completed coordinator result: upload dump (+evidence), confirm the
 * backup ObjectStore copy, write the manifest last as the commit marker, then
 * run an independent full readback and record a create-only receipt. A crash
 * before the manifest leaves an incomplete (never "verified") set. */
export async function sealRecoverySet(input: {
  backup: ConsistentBackup; setId: string; environment: RecoverySetBody['environment']; createdAt: string;
  dump: DumpSource; archive: ArchiveStore; backupObjects: ObjectStore; objectOptions?: TransferOptions;
}): Promise<RecoverySetVerification> {
  const { backup, archive, dump } = input ?? ({} as never);
  if (!backup || backup.version !== 1 || backup.status !== 'database_snapshot_and_objects_verified'
    || typeof dump?.open !== 'function' || typeof archive?.putIfAbsent !== 'function') fail('invalid_input');
  const keys = recoverySetKeys(input.setId);
  parseInstant(input.createdAt);
  let encodedEvidence: Uint8Array | undefined;
  if (backup.evidence !== undefined) {
    try { encodedEvidence = encodeEvidence(backup.evidence); } catch { fail('invalid_input'); }
    if (backup.evidence.schema !== backup.objects.capture.sourceSchema) fail('invalid_input');
  }
  const objects = backup.objects as BackupManifest;
  const draft = {
    setId: input.setId, environment: input.environment, database: backup.database, schema: objects.capture?.sourceSchema,
    sourceRelease: objects.capture?.sourceRelease, createdAt: input.createdAt,
    consistency: { mode: 'same_exported_snapshot', captureId: objects.capture?.captureId,
      referenceSnapshot: objects.capture?.referenceSnapshot, sourcePins: 'held_until_retention_release' },
    dump: { key: keys.dump, format: 'pg_dump_custom', sha256: backup.dump?.sha256, byteSize: backup.dump?.byteSize },
    evidence: encodedEvidence ? { status: 'captured', key: keys.evidence, sha256: evidenceSha256(encodedEvidence),
      byteSize: encodedEvidence.byteLength, tables: backup.evidence!.tables.length } : { status: 'unavailable' },
    objects, objectCount: objects.objects?.length, objectBytes: objects.objects?.reduce((n, o) => n + o.metadata.byteSize, 0),
  };
  let manifest: Uint8Array;
  try { manifest = encodeRecoverySet(draft as unknown as RecoverySetBody); } catch { fail('invalid_input'); }
  // Objects first (read-only): never write a dump for an unverified object copy.
  try { await verifyStoredBackup(objects, input.backupObjects, input.objectOptions); } catch (e) { objectsError(e, 'objects_unverified'); }
  await putVerified(archive, keys.dump, () => dump.open(), { sha256: draft.dump.sha256, byteSize: draft.dump.byteSize },
    DUMP_MAX_BYTES, 'dump_mismatch');
  if (encodedEvidence) await putVerified(archive, keys.evidence, async () => once(encodedEvidence!),
    { sha256: evidenceSha256(encodedEvidence), byteSize: encodedEvidence.byteLength }, EVIDENCE_MAX_BYTES, 'evidence_mismatch');
  await putVerified(archive, keys.manifest, async () => once(manifest!), { sha256: sha(manifest!), byteSize: manifest!.byteLength },
    MANIFEST_MAX_BYTES, 'archive_conflict');
  return readbackRecoverySet({ archive, setId: input.setId, backupObjects: input.backupObjects, verifiedAt: input.createdAt,
    writeReceipt: true, objectOptions: input.objectOptions });
}

interface Loaded { body: RecoverySetBody; manifestSha256: string; evidence?: SchemaEvidence }
async function loadVerified(archive: ArchiveStore, setId: string, backupObjects: ObjectStore, options?: TransferOptions): Promise<Loaded> {
  const keys = recoverySetKeys(setId);
  const bytes = await getBytes(archive, keys.manifest, MANIFEST_MAX_BYTES);
  if (bytes === null) fail('archive_missing');
  const { body: b, manifestSha256 } = decodeRecoverySet(bytes!);
  if (b.setId !== setId) fail('archive_corrupt');
  await verifyBlob(archive, keys.dump, b.dump, DUMP_MAX_BYTES, 'dump_mismatch');
  let evidence: SchemaEvidence | undefined;
  if (b.evidence.status === 'captured') {
    const raw = await getBytes(archive, keys.evidence, EVIDENCE_MAX_BYTES);
    if (raw === null) fail('archive_missing');
    if (raw!.byteLength !== b.evidence.byteSize || evidenceSha256(raw!) !== b.evidence.sha256) fail('evidence_mismatch');
    try { evidence = decodeEvidence(raw!); } catch { fail('evidence_mismatch'); }
    if (evidence!.schema !== b.schema || evidence!.tables.length !== b.evidence.tables) fail('evidence_mismatch');
  }
  try { await verifyStoredBackup(b.objects as unknown as BackupManifest, backupObjects, options); } catch (e) { objectsError(e, 'objects_unverified'); }
  return { body: b, manifestSha256, ...(evidence ? { evidence } : {}) };
}

/** Full independent readback: canonical manifest, complete dump digest,
 * evidence digest/encoding and every backup object's bytes. Optionally records
 * a create-only receipt that retention may count as "verified". */
export async function readbackRecoverySet(input: {
  archive: ArchiveStore; setId: string; backupObjects: ObjectStore; verifiedAt: string; writeReceipt?: boolean; objectOptions?: TransferOptions;
}): Promise<RecoverySetVerification> {
  const verifiedMs = parseInstant(input?.verifiedAt);
  const loaded = await loadVerified(input.archive, input.setId, input.backupObjects, input.objectOptions);
  const b = loaded.body;
  if (verifiedMs < parseInstant(b.createdAt)) fail('invalid_input');
  const result = {
    status: 'recovery_set_verified' as const, setId: b.setId, manifestSha256: loaded.manifestSha256, environment: b.environment,
    database: b.database, schema: b.schema, sourceRelease: b.sourceRelease, createdAt: b.createdAt, verifiedAt: input.verifiedAt,
    captureId: b.consistency.captureId, dump: Object.freeze({ sha256: b.dump.sha256, byteSize: b.dump.byteSize }),
    evidence: Object.freeze(b.evidence.status === 'captured' ? { status: 'captured' as const, sha256: b.evidence.sha256, tables: b.evidence.tables }
      : { status: 'unavailable' as const }),
    objects: Object.freeze({ count: b.objectCount, bytes: b.objectBytes }),
  };
  if (input.writeReceipt !== true) return Object.freeze(result);
  const receiptKey = recoverySetKeys(b.setId).receipt(randomUUID());
  const receipt = encodeReceipt(result);
  const outcome = await storeCall(() => input.archive.putIfAbsent(receiptKey, once(receipt)));
  if (outcome !== 'created') fail('archive_conflict');
  return Object.freeze({ ...result, receiptKey });
}

// ---- readback receipts -------------------------------------------------------
const receiptSchema = z.object({ format: z.literal(READBACK_FORMAT), setId: z.string().regex(UUID), manifestSha256: z.string().regex(HEX64),
  verifiedAt: z.string().regex(INSTANT), dumpSha256: z.string().regex(HEX64), objectCount: z.number().int().nonnegative(),
  objectBytes: z.number().int().nonnegative() }).strict();
export type ReadbackReceipt = z.infer<typeof receiptSchema>;
function encodeReceipt(v: Omit<RecoverySetVerification, 'receiptKey'>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ format: READBACK_FORMAT, setId: v.setId, manifestSha256: v.manifestSha256,
    verifiedAt: v.verifiedAt, dumpSha256: v.dump.sha256, objectCount: v.objects.count, objectBytes: v.objects.bytes }));
}
/** Strict receipt decode. Receipts are operator-host claims bound to one exact
 * manifest digest; they are coordination data, not an attestation. */
export function decodeReceipt(bytes: Uint8Array): ReadbackReceipt {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > RECEIPT_MAX_BYTES) fail('archive_corrupt');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('archive_corrupt'); }
  const parsed = receiptSchema.safeParse(value);
  if (!parsed.success) fail('archive_corrupt');
  parseInstant(parsed.data!.verifiedAt);
  const again = JSON.stringify({ format: READBACK_FORMAT, setId: parsed.data!.setId, manifestSha256: parsed.data!.manifestSha256,
    verifiedAt: parsed.data!.verifiedAt, dumpSha256: parsed.data!.dumpSha256, objectCount: parsed.data!.objectCount, objectBytes: parsed.data!.objectBytes });
  if (!Buffer.from(again).equals(Buffer.from(bytes))) fail('archive_corrupt');
  return parsed.data!;
}
export const RECOVERY_RECEIPT_MAX_BYTES = RECEIPT_MAX_BYTES;
export const RECOVERY_MANIFEST_MAX_BYTES = MANIFEST_MAX_BYTES;
/** Shared bounded readers for retention planning; same fixed failure codes. */
export const archiveRead = Object.freeze({ getBytes });

// ---- restore -------------------------------------------------------------------
export interface RecoverySetRestore {
  readonly status: 'database_and_objects_restored';
  readonly setId: string;
  readonly manifestSha256: string;
  readonly database: string;
  readonly schema: string;
  readonly dump: Readonly<{ sha256: string; byteSize: number }>;
  readonly evidence: Readonly<({ status: 'matched' } & EvidenceComparison) | { status: 'unavailable' }>;
  readonly objects: RestoreResult;
  /** Snapshot references alone never prove CURRENT deletion/revocation state. */
  readonly exposure: RestoreExposure;
  /** Not performed here; the restored target must stay unexposed until done. */
  readonly remainingOperatorSteps: readonly string[];
}
const REMAINING = Object.freeze(['apply_pending_migrations', 'restore_acl_lockdown', 'runtime_and_backup_grants',
  'fence_restored_sessions_and_external_authority', 'role_login_checks', 'drain_writers_before_cutover']);

async function assertEmptyTarget(pool: Pool, database: string, schema: string): Promise<void> {
  let row: { database?: unknown; relations?: unknown } | undefined;
  try {
    row = (await pool.query(`SELECT current_database() AS database,
      (SELECT count(*)::int FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1) AS relations`,
    [schema])).rows[0];
  } catch { fail('restore_target_mismatch'); }
  if (row?.database !== database) fail('restore_target_mismatch');
  if (row?.relations !== 0) fail('restore_target_not_empty');
}
async function restoredEvidence(pool: Pool, schema: string): Promise<SchemaEvidence> {
  const client = await pool.connect();
  let destroy = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try { return await collectSchemaEvidence(client, schema); }
    finally { try { await client.query('ROLLBACK'); } catch { destroy = true; } }
  } finally { client.release(destroy); }
}

/** Restore one sealed set into a verified empty logical DB and an object
 * destination. Order: full readback → empty-target check → digest-streamed
 * single-transaction DB restore → same-snapshot evidence comparison → current
 * authorization-gated object restore. Never deletes partial effects; a failed
 * attempt leaves a target that must be discarded, not exposed. */
export async function restoreRecoverySet(input: {
  archive: ArchiveStore; setId: string; backupObjects: ObjectStore; destinationObjects: ObjectStore;
  restoredPool: Pool; restoredDatabase: string; database: DatabaseRestoreWriter;
  /** Usually restoredReferenceAuthorization(...). Its exposure is reported verbatim. */
  objectAuthority: RestoreObjectAuthority;
  /** Required to proceed when a set predates evidence capture; result says unavailable. */
  allowUnavailableEvidence?: boolean; objectOptions?: TransferOptions;
}): Promise<RecoverySetRestore> {
  // Capture both the assertion and its reported provenance before any await.
  // A caller may mutate its options while archive/database I/O is in flight.
  const authority=input?.objectAuthority, selected=authority?.authorization, exposure=authority?.exposure;
  const assertAllowed=selected?.assertAllowed;
  if (!input || typeof input.database?.restore !== 'function' || typeof assertAllowed !== 'function'
    || !['current_authority_applied', 'quarantine_not_approved_for_exposure'].includes(exposure)
    || typeof input.restoredDatabase !== 'string' || !IDENT.test(input.restoredDatabase)) fail('invalid_input');
  const authorization:RestoreAuthorization=Object.freeze({assertAllowed:assertAllowed.bind(selected)});
  const loaded = await loadVerified(input.archive, input.setId, input.backupObjects, input.objectOptions);
  const b = loaded.body;
  if (!loaded.evidence && input.allowUnavailableEvidence !== true) fail('evidence_unavailable');
  await assertEmptyTarget(input.restoredPool, input.restoredDatabase, b.schema);
  const stream = await storeCall(() => input.archive.get(recoverySetKeys(b.setId).dump));
  if (stream === null) fail('archive_missing');
  const m = measured(stream!, DUMP_MAX_BYTES, b.dump, 'dump_mismatch');
  try { await input.database.restore(Object.freeze({ database: input.restoredDatabase, schema: b.schema, archive: m.stream })); }
  catch { fail(m.failure() ?? 'restore_failed'); }
  // A writer that returned without consuming the verified stream, or that
  // swallowed its error, proves nothing; the target must be discarded.
  if (!m.result()) fail(m.failure() ?? 'restore_failed');
  let evidence: RecoverySetRestore['evidence'];
  if (loaded.evidence) {
    let restored: SchemaEvidence;
    try { restored = await restoredEvidence(input.restoredPool, b.schema); } catch { fail('evidence_unavailable'); }
    try { evidence = Object.freeze({ status: 'matched' as const, ...compareEvidence(loaded.evidence, restored!) }); }
    catch (e) { fail(e instanceof BackupEvidenceError && e.code === 'evidence_mismatch' ? 'evidence_mismatch' : 'evidence_unavailable'); }
  } else evidence = Object.freeze({ status: 'unavailable' as const });
  let objects: RestoreResult;
  try { objects = await transferRestore(b.objects as unknown as BackupManifest, input.backupObjects, input.destinationObjects, authorization, input.objectOptions); }
  catch (e) { objectsError(e, 'objects_restore_failed'); }
  return Object.freeze({ status: 'database_and_objects_restored', setId: b.setId, manifestSha256: loaded.manifestSha256,
    database: input.restoredDatabase, schema: b.schema, dump: Object.freeze({ sha256: b.dump.sha256, byteSize: b.dump.byteSize }),
    evidence: evidence!, objects: objects!, exposure, remainingOperatorSteps: REMAINING });
}

export type RestoreExposure = 'current_authority_applied' | 'quarantine_not_approved_for_exposure';
export interface RestoreObjectAuthority { readonly authorization: RestoreAuthorization; readonly exposure: RestoreExposure }
type AuthorityEntry = Parameters<RestoreAuthorization['assertAllowed']>[0];

/** Object authorization bound to the expected restored database and schema:
 * the exact object row must exist there, be unfenced and match digest, size
 * and policy. A snapshot reference cannot prove CURRENT permission, so the
 * caller must either supply its current deletion/revocation authority
 * (checked first, on every call) or explicitly choose quarantine, which marks
 * the restore as NOT approved for exposure. Assertions keep Promise<void>
 * semantics: any throw denies. */
export function restoredReferenceAuthorization(restoredPool: Pool, options: {
  database: string; schema: string;
  current: { mode: 'current_authority'; assertCurrent(entry: AuthorityEntry): Promise<void> } | { mode: 'quarantine' };
}): RestoreObjectAuthority {
  const { database, schema, current } = options ?? ({} as never);
  if (typeof database !== 'string' || !IDENT.test(database) || typeof schema !== 'string' || !IDENT.test(schema)) fail('invalid_input');
  const mode=current?.mode;
  const check=mode==='current_authority'?current.assertCurrent:undefined;
  if (mode === 'current_authority') { if (typeof check !== 'function') fail('invalid_input'); }
  else if (mode !== 'quarantine') fail('invalid_input');
  const assertCurrent=check?.bind(current);
  const assets = `"${schema}".assets`, objects = `"${schema}".asset_objects`;
  const authorization: RestoreAuthorization = Object.freeze({ async assertAllowed(entry: AuthorityEntry): Promise<void> {
    if (assertCurrent) await assertCurrent(entry);
    const found = await restoredPool.query(`SELECT current_database() AS database, EXISTS(SELECT 1 FROM ${objects} o JOIN ${assets} a USING(asset_id)
      WHERE o.object_key=$1 AND a.deletion_fence=0 AND o.content_sha256=$2 AND o.byte_size=$3 AND o.policy_revision=$4) AS found`,
    [entry.key, entry.metadata.sha256, entry.metadata.byteSize, entry.metadata.policyRevision]);
    if (found.rows[0]?.database !== database) throw new Error('restore_target_mismatch');
    if (found.rows[0]?.found !== true) throw new Error('not_referenced');
  } });
  return Object.freeze({ authorization, exposure: mode === 'current_authority' ? 'current_authority_applied' : 'quarantine_not_approved_for_exposure' });
}
