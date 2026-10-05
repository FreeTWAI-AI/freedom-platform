import {
  objectKey,
  assertObjectKey,
  validateMetadata,
  readVerifiedObject,
  writeVerifiedObject,
  OBJECT_IO_MAX_BYTES,
  type AssetObjectKey,
  type ObjectMetadata,
  type ObjectStore,
} from '../asset-storage/index.js';

// Object-transfer only: copies pinned, verified media objects. Not a database restore or recovery authority.

export interface BackupReference {
  readonly asset_id: string;
  readonly scope_id: string;
  readonly representation_id: string;
  readonly policy_revision: string;
  readonly byte_size: number;
  readonly content_sha256: string;
}
export interface BackupCapture {
  readonly captureId: string;
  readonly referenceSnapshot: string;
  readonly sourceRelease: string;
  readonly sourceSchema: string;
  readonly references: readonly BackupReference[];
}
export interface BackupManifestEntry { readonly key: AssetObjectKey; readonly metadata: ObjectMetadata }
export interface BackupManifest {
  readonly version: 1;
  readonly capture: BackupCapture;
  readonly objects: readonly BackupManifestEntry[];
  readonly status: 'objects_verified';
}
export interface TransferOptions { readonly maxObjects?: number; readonly maxBytes?: number }
export interface BackupProtection { renew(): Promise<void>; assertCurrent(): Promise<BackupCapture> }
export interface RestoreAuthorization { assertAllowed(entry: BackupManifestEntry): Promise<void> }
export interface RestoreResult { readonly status: 'objects_verified'; readonly objectCount: number; readonly byteCount: number }

export type MediaBackupErrorCode =
  | 'invalid_capture' | 'invalid_options' | 'budget_exceeded' | 'protection_lost' | 'capture_changed'
  | 'object_missing' | 'object_mismatch' | 'transfer_failed' | 'invalid_manifest' | 'restore_unauthorized';

const MESSAGES: Readonly<Record<MediaBackupErrorCode, string>> = Object.freeze({
  invalid_capture: 'Backup capture is invalid.',
  invalid_options: 'Transfer options are invalid.',
  budget_exceeded: 'Transfer budget exceeded.',
  protection_lost: 'Backup protection could not be renewed or confirmed.',
  capture_changed: 'Backup capture no longer matches the protected capture.',
  object_missing: 'A pinned media object is missing.',
  object_mismatch: 'A media object does not match its pinned reference.',
  transfer_failed: 'Media object transfer failed.',
  invalid_manifest: 'Backup manifest is invalid.',
  restore_unauthorized: 'Restore is not authorized.',
});

export class MediaBackupError extends Error {
  readonly code: MediaBackupErrorCode;
  constructor(code: MediaBackupErrorCode) {
    super(MESSAGES[code]);
    this.name = 'MediaBackupError';
    this.code = code;
  }
}

const MIB = 1024 * 1024;
const MAX_REFS = 10_000;
const MAX_OBJECT_BYTES = Math.min(OBJECT_IO_MAX_BYTES, 20 * MIB);
const MAX_SNAPSHOT_CHARS = 8192;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const POLICY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SCHEMA = /^[A-Za-z_][A-Za-z0-9_]{0,79}$/;
const SNAPSHOT = /^([0-9]{1,20}):([0-9]{1,20}):([0-9]{1,20}(?:,[0-9]{1,20})*)?$/;
const META_FIELDS = ['contentType', 'byteSize', 'sha256', 'transformVersion', 'policyRevision', 'profileId'] as const;

function fail(code: MediaBackupErrorCode): never {
  throw new MediaBackupError(code);
}
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function guarded<T>(code: MediaBackupErrorCode, fn: () => T): T {
  try { return fn(); } catch { throw new MediaBackupError(code); }
}
function str(v: unknown, re: RegExp): string {
  if (typeof v !== 'string' || !re.test(v)) fail('invalid_capture');
  return v;
}
function byteSize(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1 || v > MAX_OBJECT_BYTES) fail('invalid_capture');
  return v;
}
function list(v: unknown, max: number): unknown[] {
  if (!Array.isArray(v) || v.length > max) fail('invalid_capture');
  const items: unknown[] = Array.prototype.slice.call(v);
  if (items.length > max) fail('invalid_capture');
  return items;
}
function snapshot(v: unknown): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_SNAPSHOT_CHARS) fail('invalid_capture');
  const m = SNAPSHOT.exec(v);
  if (!m || BigInt(m[1] as string) > BigInt(m[2] as string)) fail('invalid_capture');
  return v;
}

interface Pin { readonly key: AssetObjectKey; readonly ref: BackupReference }
interface Normalized { readonly capture: BackupCapture; readonly pins: readonly Pin[]; readonly fingerprint: string; readonly totalBytes: number }
const byKey = (a: { key: string }, b: { key: string }): number => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

function normalizeCapture(input: unknown, code: MediaBackupErrorCode): Normalized {
  return guarded(code, () => {
    if (!isObj(input)) fail('invalid_capture');
    const captureId = str(input.captureId, UUID);
    const referenceSnapshot = snapshot(input.referenceSnapshot);
    const sourceRelease = str(input.sourceRelease, HEX40);
    const sourceSchema = str(input.sourceSchema, SCHEMA);
    const seen = new Set<string>();
    let totalBytes = 0;
    const pins: Pin[] = list(input.references, MAX_REFS).map((r) => {
      if (!isObj(r)) fail('invalid_capture');
      const ref: BackupReference = Object.freeze({
        asset_id: str(r.asset_id, UUID),
        scope_id: str(r.scope_id, UUID),
        representation_id: str(r.representation_id, UUID),
        policy_revision: str(r.policy_revision, POLICY),
        byte_size: byteSize(r.byte_size),
        content_sha256: str(r.content_sha256, HEX64),
      });
      const key = objectKey({ scopeId: ref.scope_id, assetId: ref.asset_id, representationId: ref.representation_id });
      if (seen.has(key)) fail('invalid_capture');
      seen.add(key);
      totalBytes += ref.byte_size;
      return Object.freeze({ key, ref });
    });
    pins.sort(byKey);
    const references = Object.freeze(pins.map((p) => p.ref));
    const capture: BackupCapture = Object.freeze({ captureId, referenceSnapshot, sourceRelease, sourceSchema, references });
    const fingerprint = JSON.stringify([captureId, referenceSnapshot, sourceRelease, sourceSchema, references]);
    return Object.freeze({ capture, pins: Object.freeze(pins), fingerprint, totalBytes });
  });
}

function limit(v: unknown, fallback: number, hard: number): number {
  if (v === undefined) return fallback;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1 || v > hard) fail('invalid_options');
  return v;
}
function checkBudget(options: unknown, n: Normalized): void {
  const [maxObjects, maxBytes] = guarded('invalid_options', () => {
    if (options !== undefined && !isObj(options)) fail('invalid_options');
    const o = (options ?? {}) as Record<string, unknown>;
    return [limit(o.maxObjects, MAX_REFS, MAX_REFS), limit(o.maxBytes, 256 * MIB, 1024 * MIB)] as const;
  });
  if (n.pins.length > maxObjects || n.totalBytes > maxBytes) fail('budget_exceeded');
}

function snapMeta(v: unknown): ObjectMetadata {
  if (!isObj(v)) fail('object_mismatch');
  const { contentType, byteSize: size, sha256, transformVersion, policyRevision, profileId } = v;
  const md = { contentType, byteSize: size, sha256, transformVersion, policyRevision, ...(profileId === undefined ? {} : { profileId }) } as unknown as ObjectMetadata;
  validateMetadata(md);
  if (!Number.isSafeInteger(md.byteSize) || md.byteSize < 1 || md.byteSize > MAX_OBJECT_BYTES) fail('object_mismatch');
  return Object.freeze(md);
}
const sameMeta = (a: ObjectMetadata, b: ObjectMetadata): boolean => META_FIELDS.every((f) => a[f] === b[f]);
const matchesPin = (m: ObjectMetadata, r: BackupReference): boolean =>
  m.byteSize === r.byte_size && m.sha256 === r.content_sha256 && m.policyRevision === r.policy_revision;

async function copyObject(source: ObjectStore, destination: ObjectStore, pin: Pin, expected?: ObjectMetadata): Promise<ObjectMetadata> {
    // Upstream may throw an instance of our exported error with a forged raw
    // message. Never use instanceof to pass any store exception through.
    async function io<T>(run: () => Promise<T>): Promise<T> {
      try { return await run(); } catch { fail('transfer_failed'); }
    }
    const head = await io(() => source.head(pin.key));
    if (!head) fail('object_missing');
    const rawSource = head.metadata;
    const md = guarded('object_mismatch', () => snapMeta(rawSource));
    if (!matchesPin(md, pin.ref) || (expected !== undefined && !sameMeta(md, expected))) fail('object_mismatch');
    const src = await io(() => readVerifiedObject(source, pin.key, md));
    if (src.bytes.byteLength !== md.byteSize) fail('object_mismatch');
    const existing = await io(() => destination.head(pin.key));
    if (existing) {
      const rawDest = existing.metadata;
      if (!sameMeta(guarded('object_mismatch', () => snapMeta(rawDest)), md)) fail('object_mismatch');
    } else {
      await io(() => writeVerifiedObject(destination, pin.key, { bytes: src.bytes, metadata: md }, { revision: md.policyRevision, platformPersistenceAllowed: true }));
    }
    const dst = await io(() => readVerifiedObject(destination, pin.key, md));
    if (dst.bytes.byteLength !== md.byteSize) fail('object_mismatch');
    return md;
}

async function renew(protection: BackupProtection): Promise<void> {
  try { await protection.renew(); } catch { fail('protection_lost'); }
}
async function checkCurrent(protection: BackupProtection, n: Normalized): Promise<void> {
  let current: unknown;
  try { current = await protection.assertCurrent(); } catch { fail('protection_lost'); }
  if (normalizeCapture(current, 'capture_changed').fingerprint !== n.fingerprint) fail('capture_changed');
}
async function authorize(auth: RestoreAuthorization, entry: BackupManifestEntry): Promise<void> {
  let result: unknown;
  try { result = await auth.assertAllowed(entry); } catch { fail('restore_unauthorized'); }
  if (result === false) fail('restore_unauthorized');
}

export async function transferBackup(
  capture: BackupCapture,
  source: ObjectStore,
  destination: ObjectStore,
  protection: BackupProtection,
  options?: TransferOptions,
): Promise<BackupManifest> {
  const n = normalizeCapture(capture, 'invalid_capture');
  checkBudget(options, n);
  if (typeof protection?.renew !== 'function' || typeof protection?.assertCurrent !== 'function') fail('invalid_options');
  const objects: BackupManifestEntry[] = [];
  for (const pin of n.pins) {
    await renew(protection);
    await checkCurrent(protection, n);
    const metadata = await copyObject(source, destination, pin);
    await checkCurrent(protection, n);
    objects.push(Object.freeze({ key: pin.key, metadata }));
  }
  await checkCurrent(protection, n);
  return Object.freeze({ version: 1, capture: n.capture, objects: Object.freeze(objects), status: 'objects_verified' });
}

interface RestoreEntry { readonly pin: Pin; readonly metadata: ObjectMetadata; readonly entry: BackupManifestEntry }

function normalizeManifest(input: unknown): { n: Normalized; entries: readonly RestoreEntry[] } {
  return guarded('invalid_manifest', () => {
    if (!isObj(input) || input.version !== 1 || input.status !== 'objects_verified') fail('invalid_manifest');
    const n = normalizeCapture(input.capture, 'invalid_manifest');
    const pins = new Map<string, Pin>(n.pins.map((p) => [p.key, p]));
    const used = new Set<string>();
    const items = list(input.objects, MAX_REFS);
    if (items.length !== n.pins.length) fail('invalid_manifest');
    const entries = items.map((item): RestoreEntry => {
      if (!isObj(item)) fail('invalid_manifest');
      const key = item.key;
      if (typeof key !== 'string') fail('invalid_manifest');
      assertObjectKey(key as AssetObjectKey);
      const pin = pins.get(key);
      if (pin === undefined || used.has(key)) fail('invalid_manifest');
      used.add(key);
      const metadata = snapMeta(item.metadata);
      if (!matchesPin(metadata, pin.ref)) fail('invalid_manifest');
      return Object.freeze({ pin, metadata, entry: Object.freeze({ key: pin.key, metadata }) });
    });
    entries.sort((a, b) => byKey(a.pin, b.pin));
    return { n, entries: Object.freeze(entries) };
  });
}

export async function transferRestore(
  manifest: BackupManifest,
  source: ObjectStore,
  destination: ObjectStore,
  authorization: RestoreAuthorization,
  options?: TransferOptions,
): Promise<RestoreResult> {
  const { n, entries } = normalizeManifest(manifest);
  checkBudget(options, n);
  if (typeof authorization?.assertAllowed !== 'function') fail('invalid_options');
  let byteCount = 0;
  for (const e of entries) {
    await authorize(authorization, e.entry);
    await copyObject(source, destination, e.pin, e.metadata);
    await authorize(authorization, e.entry);
    byteCount += e.metadata.byteSize;
  }
  for (const e of entries) await authorize(authorization, e.entry);
  return Object.freeze({ status: 'objects_verified', objectCount: entries.length, byteCount });
}

/** Read-only readback of an existing backup copy. Applies the same manifest/pin
 * bijection as restore, then fully reads and hashes every object. It never
 * writes, deletes or repairs; a missing/mismatched copy fails with a fixed code. */
export async function verifyStoredBackup(
  manifest: BackupManifest,
  store: ObjectStore,
  options?: TransferOptions,
): Promise<RestoreResult> {
  const { n, entries } = normalizeManifest(manifest);
  checkBudget(options, n);
  let byteCount = 0;
  for (const e of entries) {
    let head;
    try { head = await store.head(e.pin.key); } catch { fail('transfer_failed'); }
    if (!head) fail('object_missing');
    const rawStored = head.metadata;
    if (!sameMeta(guarded('object_mismatch', () => snapMeta(rawStored)), e.metadata)) fail('object_mismatch');
    let read;
    try { read = await readVerifiedObject(store, e.pin.key, e.metadata); } catch { fail('transfer_failed'); }
    if (read.bytes.byteLength !== e.metadata.byteSize) fail('object_mismatch');
    byteCount += e.metadata.byteSize;
  }
  return Object.freeze({ status: 'objects_verified', objectCount: entries.length, byteCount });
}
