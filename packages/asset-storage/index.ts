import { MEDIA_OBJECT_PROFILES, OBJECT_IO_MAX_BYTES, type MediaObjectProfileId, type MediaObjectTransform } from './profiles.js';
export { MEDIA_OBJECT_PROFILES, OBJECT_IO_MAX_BYTES } from './profiles.js';
export type { MediaObjectProfileId } from './profiles.js';
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
const contentTypes = ['text/plain', 'text/markdown', 'image/webp', 'image/png', 'image/jpeg', 'video/mp4', 'video/webm'] as const;
export interface ObjectMetadata {
  readonly contentType: typeof contentTypes[number];
  readonly byteSize: number;
  readonly sha256: string;
  readonly transformVersion: 'private-text.utf8.v1' | 'avatar.webp.v1' | MediaObjectTransform;
  readonly profileId?: MediaObjectProfileId;
  readonly policyRevision: string;
}
export interface PreparedRepresentation { readonly bytes: Uint8Array; readonly metadata: ObjectMetadata }
export function validateMetadata(metadata: ObjectMetadata): void {
  try { checkedMetadata(metadata); } catch { fail('invalid_metadata'); }
}
function checkedMetadata(metadata: ObjectMetadata): void {
  if (!metadata || Object.keys(metadata).some(key => !['contentType','byteSize','sha256','transformVersion','policyRevision','profileId'].includes(key))
    || !contentTypes.includes(metadata.contentType) || !Number.isSafeInteger(metadata.byteSize)
    || metadata.byteSize < 1 || metadata.byteSize > OBJECT_IO_MAX_BYTES || typeof metadata.sha256 !== 'string'
    || metadata.sha256.length !== 64 || !/^[0-9a-f]{64}$/.test(metadata.sha256) || !validPolicyRevision(metadata.policyRevision)) fail('invalid_metadata');
  if (metadata.profileId !== undefined) {
    if (typeof metadata.profileId !== 'string' || !Object.hasOwn(MEDIA_OBJECT_PROFILES, metadata.profileId)) fail('invalid_metadata');
    const profile = MEDIA_OBJECT_PROFILES[metadata.profileId];
    if (!(profile.contentTypes as readonly string[]).includes(metadata.contentType)
      || metadata.transformVersion !== profile.transformVersion || metadata.byteSize > profile.maxBytes) fail('invalid_metadata');
    return;
  }
  const avatar = metadata.contentType === 'image/webp';
  if ((!avatar && metadata.contentType !== 'text/plain' && metadata.contentType !== 'text/markdown')
    || metadata.transformVersion !== (avatar ? AVATAR_PROFILE.transformVersion : 'private-text.utf8.v1')
    || metadata.byteSize > (avatar ? AVATAR_PROFILE.outputMaxBytes : PRIVATE_TEXT_MAX_BYTES)) fail('invalid_metadata');
}

// Read the actual typed-array length, not an own property/subclass getter.
const typedArrayByteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')!.get!;
/** Validate before allocating a copy; numeric/array-like inputs are never bytes. */
export function snapshotBoundedBytes(value: unknown, maxBytes: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > OBJECT_IO_MAX_BYTES) fail('invalid_metadata');
  if (!(value instanceof Uint8Array) || !ArrayBuffer.isView(value)) fail('invalid_content');
  const size = typedArrayByteLength.call(value) as number;
  if (size > maxBytes) fail('too_large');
  try { return new Uint8Array(value); } catch { fail('invalid_content'); }
}

/** Bounded accumulation for small profiles. Content-Length is never trusted.
 * Cancels on overflow/error, releases its reader and never reports raw input. */
export async function readBounded(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > OBJECT_IO_MAX_BYTES) fail('invalid_metadata');
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const buffer = new Uint8Array(maxBytes);
  let size = 0;
  let failure: 'invalid_content' | 'too_large' = 'invalid_content';
  try {
    reader = body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || !ArrayBuffer.isView(value)) fail('invalid_content');
      const chunkSize = typedArrayByteLength.call(value) as number;
      if (chunkSize > maxBytes - size) { failure = 'too_large'; fail(failure); }
      buffer.set(value, size);
      size += chunkSize;
    }
    return buffer.slice(0, size);
  } catch {
    try { await reader?.cancel(); } catch { /* cancellation cannot mask validation */ }
    // Upstream errors may masquerade as this class with mutated message/code.
    // Only this function's own validation may select a non-default fixed code.
    throw new AssetStorageError(failure);
  } finally {
    try { reader?.releaseLock(); } catch { fail(failure); }
  }
}
export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', snapshotBoundedBytes(bytes, OBJECT_IO_MAX_BYTES));
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
  const snapshot = snapshotBoundedBytes(bytes, contentType === 'image/webp' ? AVATAR_PROFILE.outputMaxBytes : PRIVATE_TEXT_MAX_BYTES);
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
  let normalized: unknown;
  try { normalized = await normalize(snapshotBoundedBytes(bytes, AVATAR_PROFILE.inputMaxBytes), spec); }
  catch { fail('invalid_content'); }
  const output = snapshotBoundedBytes(normalized, AVATAR_PROFILE.outputMaxBytes);
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
export interface VerifiedObjectBytes extends VerifiedObject { readonly bytes: Uint8Array }
function sameMetadata(actual: ObjectMetadata, expected: ObjectMetadata): boolean {
  return actual.contentType === expected.contentType && actual.byteSize === expected.byteSize && actual.sha256 === expected.sha256
    && actual.transformVersion === expected.transformVersion && actual.policyRevision === expected.policyRevision && actual.profileId === expected.profileId;
}
/** One bounded GET: only these exact digest-verified bytes may be served. */
export async function readVerifiedObject(store: ObjectStore, key: AssetObjectKey, expected: ObjectMetadata): Promise<VerifiedObjectBytes> {
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
  return Object.freeze({ key, metadata: Object.freeze({ ...expected }), bytes: snapshotBoundedBytes(bytes, expected.byteSize), ...(object.etag ? { etag: object.etag } : {}) });
}
export async function verifyObject(store: ObjectStore, key: AssetObjectKey, expected: ObjectMetadata): Promise<VerifiedObject> {
  const { bytes: _bytes, ...evidence } = await readVerifiedObject(store, key, expected);
  return Object.freeze(evidence);
}
/** Returns storage evidence, NOT ready state, authority, a receipt or a pointer.
 * On ambiguous PUT, GET may establish presence; a missing object stays unknown. */
export async function writeVerifiedObject(store: ObjectStore, key: AssetObjectKey, value: PreparedRepresentation, policy: PersistencePolicy): Promise<VerifiedObject> {
  policy = persistenceSnapshot(policy); assertObjectKey(key);
  const metadata = Object.freeze({ ...value.metadata });
  validateMetadata(metadata);
  if (metadata.policyRevision !== policy.revision) fail('invalid_policy');
  const bytes = snapshotBoundedBytes(value.bytes, metadata.byteSize);
  if (bytes.byteLength !== metadata.byteSize || await sha256(bytes) !== metadata.sha256) fail('integrity_mismatch');
  if (metadata.profileId !== undefined) validateLegacyMediaBytes(bytes, metadata.contentType);
  else if (metadata.contentType === 'image/webp') {
    try { assertCanonicalWebp(bytes, 256, 256); } catch { fail('invalid_content'); }
  } else validateText(bytes);
  try { await store.putImmutable(key, { bytes, metadata }); }
  catch { /* Network failure can be after commit; reconcile actual bytes below. */ }
  return verifyObject(store, key, metadata);
}

function validateLegacyMediaBytes(bytes: Uint8Array, mime: string): void {
  if (!bytes.byteLength) fail('empty_content');
  if (mime === 'video/mp4') {
    if (bytes.length < 12 || String.fromCharCode(...bytes.subarray(4,8)) !== 'ftyp') fail('invalid_content');
  } else if (mime === 'video/webm') {
    if (bytes.length < 4 || ![0x1a,0x45,0xdf,0xa3].every((byte,index)=>bytes[index]===byte)) fail('invalid_content');
  } else {
    try { assertCompleteRaster(bytes, mime.slice(6) as 'png'|'jpeg'|'webp', 8192, 40_000_000); }
    catch { fail('invalid_content'); }
  }
}
/** Byte-preserving legacy representation preparation. Caller resolves domain
 * policy/variant first; this does not normalize uploads or approve exceptions. */
export async function prepareLegacyMediaRepresentation(body: ReadableStream<Uint8Array>, contentType: string,
  profileId: MediaObjectProfileId, policy: PersistencePolicy): Promise<PreparedRepresentation> {
  policy = persistenceSnapshot(policy);
  if (typeof profileId !== 'string' || !Object.hasOwn(MEDIA_OBJECT_PROFILES, profileId)) fail('invalid_metadata');
  const profile = MEDIA_OBJECT_PROFILES[profileId];
  if (!(profile.contentTypes as readonly string[]).includes(contentType)) fail('unsupported_content_type');
  const bytes = await readBounded(body, profile.maxBytes);
  validateLegacyMediaBytes(bytes, contentType);
  return Object.freeze({bytes,metadata:Object.freeze({profileId,contentType:contentType as ObjectMetadata['contentType'],
    byteSize:bytes.byteLength,sha256:await sha256(bytes),transformVersion:profile.transformVersion,policyRevision:policy.revision})});
}

/** Pull-based exact-length stream. No full-object allocation; malformed lengths
 * fail while consuming, cancellation propagates to the native reader. */
export function boundedObjectStream(body: ReadableStream<Uint8Array>, size: number): ReadableStream<Uint8Array> {
  if (!Number.isSafeInteger(size) || size < 1 || size > OBJECT_IO_MAX_BYTES) fail('invalid_metadata');
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = body.getReader(); } catch { fail('object_unavailable'); }
  let count=0,closed=false;
  function release() { if (!closed) { closed=true; try {reader.releaseLock();} catch {fail('object_unavailable');} } }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {next=await reader.read();} catch {try{await reader.cancel();}catch{}try{release();}catch{}controller.error(new AssetStorageError('object_unavailable'));return;}
      try {
        if(next.done){if(count!==size)fail('integrity_mismatch');release();controller.close();return;}
        const chunk=snapshotBoundedBytes(next.value,size-count || 1);
        if(chunk.length>size-count)fail('too_large');count+=chunk.length;controller.enqueue(chunk);
      } catch(error) {
        try{await reader.cancel();}catch{}try{release();}catch{}
        controller.error(new AssetStorageError(error instanceof AssetStorageError ? error.code : 'invalid_content'));
      }
    },
    async cancel() {try{await reader.cancel();}catch{}finally{release();}},
  },{highWaterMark:0});
}
export interface PinnedObjectRange extends ObjectHead {
  readonly key: AssetObjectKey; readonly body: ReadableStream<Uint8Array>; readonly range: ObjectRange;
  readonly integrity: 'immutable-etag-range'; readonly wholeDigestVerified: false;
}
/** Partial bytes are not SHA-256 evidence for the full object. The caller must
 * retain verified immutable-object metadata and its opaque version/ETag pin. */
export async function readPinnedObjectRange(store:ObjectStore,key:AssetObjectKey,expected:ObjectMetadata,
  range:ObjectRange,expectedEtag:string):Promise<PinnedObjectRange> {
  assertObjectKey(key);expected=Object.freeze({...expected});validateMetadata(expected);
  const requested=Object.freeze({offset:range.offset,length:range.length});validateRange(requested,expected.byteSize);
  if(typeof expectedEtag!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(expectedEtag))fail('invalid_metadata');
  let object:StoredObject|null;try{object=await store.get(key,requested);}catch{fail('object_unavailable');}
  if(!object)fail('object_unavailable');
  if(!sameMetadata(object.metadata,expected)||object.etag!==expectedEtag){try{await object.body.cancel();}catch{}fail('integrity_mismatch');}
  return Object.freeze({key,metadata:expected,etag:expectedEtag,range:requested,
    body:boundedObjectStream(object.body,requested.length),integrity:'immutable-etag-range',wholeDigestVerified:false});
}
