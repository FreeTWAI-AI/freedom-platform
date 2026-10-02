import { assertCompleteRaster } from '../shared/image-container.js';
import { assertCanonicalWebp } from '../shared/image-webp.js';
import type { ImageNormalizeSpec } from '../shared/image-runtime.js';
import { OpaqueId } from '../../contracts/common/v1/identity.js';

export type AssetStorageErrorCode = 'invalid_identity' | 'persistence_prohibited' | 'invalid_policy'
  | 'unsupported_content_type' | 'too_large' | 'empty_content' | 'invalid_content' | 'invalid_metadata'
  | 'integrity_mismatch' | 'object_conflict' | 'object_unavailable' | 'invalid_range';
export class AssetStorageError extends Error {
  constructor(readonly code: AssetStorageErrorCode) { super(code); this.name = 'AssetStorageError'; }
}
function fail(code: AssetStorageErrorCode): never { throw new AssetStorageError(code); }
declare const keyBrand: unique symbol;
export type AssetObjectKey = string & { readonly [keyBrand]: true };
export interface ObjectIdentity { readonly scopeId: string; readonly assetId: string; readonly representationId: string }
export function objectKey(identity: ObjectIdentity): AssetObjectKey {
  if (!identity) fail('invalid_identity');
  const parts = [identity.scopeId, identity.assetId, identity.representationId];
  if (!parts.every(part => OpaqueId.safeParse(part).success)) fail('invalid_identity');
  return `v1/${parts.join('/')}` as AssetObjectKey;
}
export function assertObjectKey(key: AssetObjectKey): void {
  if (typeof key !== 'string') fail('invalid_identity');
  const parts = key.split('/');
  if (parts.length !== 4 || parts[0] !== 'v1') fail('invalid_identity');
  objectKey({ scopeId: parts[1], assetId: parts[2], representationId: parts[3] });
}

// This is only the persistence projection of an authoritative, already resolved
// policy. It does not grant capture, inference, viewer or publication permission.
export interface PersistencePolicy { readonly revision: string; readonly platformPersistenceAllowed: boolean }
const validPolicyRevision = (value: unknown): value is string => typeof value === 'string'
  && value.trim() === value && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
export function requirePersistence(policy: PersistencePolicy): void {
  if (!policy || policy.platformPersistenceAllowed !== true) fail('persistence_prohibited');
  if (!validPolicyRevision(policy.revision)) fail('invalid_policy');
}
function persistenceSnapshot(policy: PersistencePolicy): PersistencePolicy {
  const snapshot = Object.freeze({ revision: policy?.revision, platformPersistenceAllowed: policy?.platformPersistenceAllowed });
  requirePersistence(snapshot);
  return snapshot;
}
export const PRIVATE_TEXT_MAX_BYTES = 256 * 1024;
export const AVATAR_PROFILE = Object.freeze({ inputMaxBytes: 2 * 1024 * 1024, maxDimension: 4096,
  outputMaxBytes: 128 * 1024, width: 256, height: 256, transformVersion: 'avatar.webp.v1' });
const contentTypes = ['text/plain', 'text/markdown', 'image/webp'] as const;
export interface ObjectMetadata {
  readonly contentType: typeof contentTypes[number];
  readonly byteSize: number;
  readonly sha256: string;
  readonly transformVersion: 'private-text.utf8.v1' | 'avatar.webp.v1';
  readonly policyRevision: string;
}
export interface PreparedRepresentation { readonly bytes: Uint8Array; readonly metadata: ObjectMetadata }
export function validateMetadata(metadata: ObjectMetadata): void {
  if (!metadata || !contentTypes.includes(metadata.contentType) || !Number.isSafeInteger(metadata.byteSize)
    || metadata.byteSize < 1 || typeof metadata.sha256 !== 'string' || metadata.sha256.length !== 64 || !/^[0-9a-f]{64}$/.test(metadata.sha256)
    || !validPolicyRevision(metadata.policyRevision)) fail('invalid_metadata');
  const avatar = metadata.contentType === 'image/webp';
  if (metadata.transformVersion !== (avatar ? AVATAR_PROFILE.transformVersion : 'private-text.utf8.v1')
    || metadata.byteSize > (avatar ? AVATAR_PROFILE.outputMaxBytes : PRIVATE_TEXT_MAX_BYTES)) fail('invalid_metadata');
}

/** Bounded accumulation for small profiles. Content-Length is never trusted.
 * Cancels on overflow/error, releases its reader and never reports raw input. */
export async function readBounded(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > AVATAR_PROFILE.inputMaxBytes) fail('invalid_metadata');
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const buffer = new Uint8Array(maxBytes);
  let size = 0;
  try {
    reader = body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) fail('invalid_content');
      if (value.byteLength > maxBytes - size) fail('too_large');
      buffer.set(value, size);
      size += value.byteLength;
    }
    return buffer.slice(0, size);
  } catch (error) {
    try { await reader?.cancel(); } catch { /* cancellation cannot mask validation */ }
    if (error instanceof AssetStorageError) throw error;
    throw new AssetStorageError('invalid_content');
  } finally { reader?.releaseLock(); }
}
export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
function validateText(bytes: Uint8Array): void {
  if (!bytes.byteLength) fail('empty_content');
  try {
    // Decode for validation only; preserve original UTF-8 bytes (including BOM).
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) fail('invalid_content');
  } catch { fail('invalid_content'); }
}
async function prepared(bytes: Uint8Array, contentType: ObjectMetadata['contentType'], transformVersion: ObjectMetadata['transformVersion'], policy: PersistencePolicy): Promise<PreparedRepresentation> {
  const snapshot = new Uint8Array(bytes);
  return Object.freeze({ bytes: snapshot, metadata: Object.freeze({ contentType, byteSize: snapshot.byteLength,
    sha256: await sha256(snapshot), transformVersion, policyRevision: policy.revision }) });
}
export async function preparePrivateText(body: ReadableStream<Uint8Array>, contentType: string, policy: PersistencePolicy): Promise<PreparedRepresentation> {
  policy = persistenceSnapshot(policy);
  if (contentType !== 'text/plain' && contentType !== 'text/markdown') fail('unsupported_content_type');
  const bytes = await readBounded(body, PRIVATE_TEXT_MAX_BYTES);
  validateText(bytes);
  return prepared(bytes, contentType, 'private-text.utf8.v1', policy);
}
export type AvatarNormalizer = (bytes: Uint8Array, spec: ImageNormalizeSpec) => Promise<Uint8Array>;
export async function prepareAvatar(body: ReadableStream<Uint8Array>, contentType: string, policy: PersistencePolicy, normalize: AvatarNormalizer): Promise<PreparedRepresentation> {
  policy = persistenceSnapshot(policy);
  if (contentType !== 'image/png' && contentType !== 'image/jpeg' && contentType !== 'image/webp') fail('unsupported_content_type');
  const bytes = await readBounded(body, AVATAR_PROFILE.inputMaxBytes);
  if (!bytes.byteLength) fail('empty_content');
  const format = contentType.slice(6) as 'png' | 'jpeg' | 'webp';
  try { assertCompleteRaster(bytes, format, AVATAR_PROFILE.maxDimension, AVATAR_PROFILE.maxDimension ** 2); }
  catch { fail('invalid_content'); }
  // Trusted runtime adapter must fully decode, orient, resize and strip metadata.
  // Shared framing validators alone are not a decoder.
  const spec: ImageNormalizeSpec = Object.freeze({ purpose: 'avatar', format, maxDimension: AVATAR_PROFILE.maxDimension,
    maxPixels: AVATAR_PROFILE.maxDimension ** 2, maxOutputBytes: AVATAR_PROFILE.outputMaxBytes,
    output: Object.freeze({ width: 256, height: 256, fit: 'cover', quality: 82, effort: 3 }) });
  let output: Uint8Array;
  try { output = new Uint8Array(await normalize(new Uint8Array(bytes), spec)); }
  catch { fail('invalid_content'); }
  if (output.byteLength > AVATAR_PROFILE.outputMaxBytes) fail('too_large');
  try { assertCanonicalWebp(output, 256, 256); } catch { fail('invalid_content'); }
  return prepared(output, 'image/webp', AVATAR_PROFILE.transformVersion, policy);
}

export interface ObjectHead { readonly metadata: ObjectMetadata; readonly etag?: string }
export interface ObjectRange { readonly offset: number; readonly length: number }
export interface StoredObject extends ObjectHead { readonly body: ReadableStream<Uint8Array> }
export function validateRange(range: ObjectRange, size: number): void {
  if (!Number.isSafeInteger(range.offset) || !Number.isSafeInteger(range.length) || range.offset < 0 || range.length < 1
    || range.offset >= size || range.length > size - range.offset) fail('invalid_range');
}
/** Adapter must atomically create-if-absent, never overwrite, even on retry.
 * Unknown effects must throw; caller reconciles by GET and actual digest.
 * All methods are effect-phase I/O, never allowed under domain row locks. */
export interface ObjectStore {
  putImmutable(key: AssetObjectKey, value: PreparedRepresentation): Promise<'created' | 'exists'>;
  get(key: AssetObjectKey, range?: ObjectRange): Promise<StoredObject | null>;
  head(key: AssetObjectKey): Promise<ObjectHead | null>;
  delete(key: AssetObjectKey): Promise<'deleted' | 'missing'>;
}
export interface VerifiedObject { readonly key: AssetObjectKey; readonly metadata: ObjectMetadata; readonly etag?: string }
function sameMetadata(actual: ObjectMetadata, expected: ObjectMetadata): boolean {
  return actual.contentType === expected.contentType && actual.byteSize === expected.byteSize && actual.sha256 === expected.sha256
    && actual.transformVersion === expected.transformVersion && actual.policyRevision === expected.policyRevision;
}
export async function verifyObject(store: ObjectStore, key: AssetObjectKey, expected: ObjectMetadata): Promise<VerifiedObject> {
  expected = Object.freeze({ ...expected });
  assertObjectKey(key); validateMetadata(expected);
  let object: StoredObject | null;
  try { object = await store.get(key); } catch { fail('object_unavailable'); }
  if (!object) fail('object_unavailable');
  if (!object.metadata || !sameMetadata(object.metadata, expected)) {
    try { await object.body.cancel(); } catch { /* no raw diagnostic */ }
    fail('integrity_mismatch');
  }
  const bytes = await readBounded(object.body, expected.byteSize);
  if (bytes.byteLength !== expected.byteSize || await sha256(bytes) !== expected.sha256) fail('integrity_mismatch');
  return Object.freeze({ key, metadata: Object.freeze({ ...expected }), ...(object.etag ? { etag: object.etag } : {}) });
}
/** Returns storage evidence, NOT ready state, authority, a receipt or a pointer.
 * On ambiguous PUT, GET may establish presence; a missing object stays unknown. */
export async function writeVerifiedObject(store: ObjectStore, key: AssetObjectKey, value: PreparedRepresentation, policy: PersistencePolicy): Promise<VerifiedObject> {
  policy = persistenceSnapshot(policy); assertObjectKey(key);
  const metadata = Object.freeze({ ...value.metadata });
  validateMetadata(metadata);
  if (metadata.policyRevision !== policy.revision) fail('invalid_policy');
  const bytes = new Uint8Array(value.bytes);
  if (bytes.byteLength !== metadata.byteSize || await sha256(bytes) !== metadata.sha256) fail('integrity_mismatch');
  if (metadata.contentType === 'image/webp') {
    try { assertCanonicalWebp(bytes, 256, 256); } catch { fail('invalid_content'); }
  } else validateText(bytes);
  try { await store.putImmutable(key, { bytes, metadata }); }
  catch { /* Network failure can be after commit; reconcile actual bytes below. */ }
  return verifyObject(store, key, metadata);
}
