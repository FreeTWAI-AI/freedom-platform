import type { R2Bucket, R2Object, R2ObjectBody } from '@cloudflare/workers-types';
import { assertObjectKey, AssetStorageError, PRIVATE_TEXT_MAX_BYTES, readBounded, sha256, snapshotBoundedBytes,
  validateMetadata, validateRange, type AssetObjectKey, type ObjectHead, type ObjectMetadata, type ObjectRange,
  type ObjectStore, type PreparedRepresentation, type StoredObject } from './index.js';

export type AssetR2Binding = Pick<R2Bucket, 'put' | 'get' | 'head' | 'delete'>;
const FORMAT = 'freedom.asset/v1';
const unavailable = () => new AssetStorageError('object_unavailable');
const mismatch = () => new AssetStorageError('integrity_mismatch');

function metadataOf(object: R2Object, key: AssetObjectKey): ObjectHead {
  try { return checkedMetadataOf(object, key); }
  catch { throw new AssetStorageError('invalid_metadata'); }
}
function checkedMetadataOf(object: R2Object, key: AssetObjectKey): ObjectHead {
  if (object.key !== key || object.customMetadata?.format !== FORMAT) throw mismatch();
  const metadata = Object.freeze({ contentType: object.httpMetadata?.contentType,
    byteSize: object.size, sha256: object.customMetadata.sha256,
    transformVersion: object.customMetadata.transform_version,
    policyRevision: object.customMetadata.policy_revision }) as ObjectMetadata;
  validateMetadata(metadata);
  // Never expose arbitrary upstream metadata, response headers or bucket names.
  if (typeof object.etag !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(object.etag)) throw mismatch();
  return Object.freeze({ metadata, etag: object.etag });
}

async function bytesOf(object: R2ObjectBody, size: number): Promise<Uint8Array> {
  // R2 and DOM stream declarations differ, so adapt through reader operations.
  // Small profiles are fully bounded before handing bytes to the caller.
  const reader = object.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try { const next = await reader.read(); if (next.done) controller.close(); else controller.enqueue(next.value); }
      catch { controller.error(unavailable()); }
    },
    async cancel() { try { await reader.cancel(); } catch { /* no upstream diagnostics */ } },
  }, { highWaterMark: 0 });
  try {
    const bytes = await readBounded(body, size);
    if (bytes.byteLength !== size) throw mismatch();
    return bytes;
  } finally { try { reader.releaseLock(); } catch { /* no diagnostics */ } }
}

/** Explicit native binding only: no credentials, environment lookup, bucket
 * creation, public URLs or deployment configuration. This port is NOT an ACL.
 * Caller must apply current domain policy and verify actual bytes before attach.
 * Delete is disabled on normal app ports; maintenance additionally needs a DB
 * deletion fence, backup pins and late-PUT reconciliation outside this adapter.
 */
export function createR2ObjectStore(binding: AssetR2Binding, options: { allowDelete?: boolean } = {}): ObjectStore {
  if (!binding || ['put', 'get', 'head', 'delete'].some(name => typeof binding[name as keyof AssetR2Binding] !== 'function')) throw unavailable();
  const put = binding.put.bind(binding), get = binding.get.bind(binding), head = binding.head.bind(binding), remove = binding.delete.bind(binding);
  const allowDelete = options.allowDelete === true;
  return Object.freeze({
    async putImmutable(key: AssetObjectKey, value: PreparedRepresentation): Promise<'created' | 'exists'> {
      assertObjectKey(key);
      const metadata = Object.freeze({ ...value.metadata }); validateMetadata(metadata);
      const bytes = snapshotBoundedBytes(value.bytes, metadata.byteSize);
      if (bytes.byteLength !== metadata.byteSize || await sha256(bytes) !== metadata.sha256) throw mismatch();
      let result: R2Object | null;
      try {
        result = await put(key, bytes, { onlyIf: { etagDoesNotMatch: '*' }, sha256: metadata.sha256,
          httpMetadata: { contentType: metadata.contentType }, customMetadata: { format: FORMAT,
            sha256: metadata.sha256, transform_version: metadata.transformVersion, policy_revision: metadata.policyRevision } });
      } catch { throw unavailable(); } // outcome may be unknown; never retry a PUT here
      // Exists does not assert equivalent content; writeVerifiedObject reconciles
      // with a full GET and actual digest, including uncertain PUT outcomes.
      if (result === null) return 'exists';
      const observed = metadataOf(result, key).metadata;
      if (observed.contentType !== metadata.contentType || observed.byteSize !== metadata.byteSize || observed.sha256 !== metadata.sha256
        || observed.transformVersion !== metadata.transformVersion || observed.policyRevision !== metadata.policyRevision) throw mismatch();
      return 'created';
    },
    async head(key: AssetObjectKey): Promise<ObjectHead | null> {
      assertObjectKey(key);
      let result: R2Object | null;
      try { result = await head(key); } catch { throw unavailable(); }
      return result ? metadataOf(result, key) : null;
    },
    async get(key: AssetObjectKey, range?: ObjectRange): Promise<StoredObject | null> {
      assertObjectKey(key);
      const requested = range === undefined ? undefined : Object.freeze({ offset: range.offset, length: range.length });
      if (requested && (!Number.isSafeInteger(requested.offset) || requested.offset < 0 || !Number.isSafeInteger(requested.length)
        || requested.length < 1 || requested.length > PRIVATE_TEXT_MAX_BYTES)) throw new AssetStorageError('invalid_range');
      let etag: string | undefined;
      if (requested) {
        let current: R2Object | null;
        try { current = await head(key); } catch { throw unavailable(); }
        if (!current) return null;
        const found = metadataOf(current, key); validateRange(requested, found.metadata.byteSize); etag = found.etag;
      }
      let result: R2ObjectBody | R2Object | null;
      try { result = await get(key, requested ? { range: requested, onlyIf: { etagMatches: etag } } : undefined); }
      catch { throw unavailable(); }
      if (!result) return null;
      if (!('body' in result)) throw unavailable();
      try {
        const found = metadataOf(result, key);
        if (requested) {
          validateRange(requested, found.metadata.byteSize);
          if (result.etag !== etag || !result.range || !('offset' in result.range) || result.range.offset !== requested.offset
            || !('length' in result.range) || result.range.length !== requested.length) throw mismatch();
        } else if (result.range && (!('offset' in result.range) || result.range.offset !== 0
          || !('length' in result.range) || result.range.length !== found.metadata.byteSize)) throw mismatch();
        const bytes = await bytesOf(result, requested?.length ?? found.metadata.byteSize);
        return Object.freeze({ ...found, body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }) });
      } catch (error) {
        try { await result.body.cancel(); } catch { /* cancel cannot mask failure */ }
        // All upstream failures, even errors with forged class/name/code, stay safe.
        if (error instanceof AssetStorageError && ['integrity_mismatch', 'invalid_metadata', 'invalid_range', 'too_large', 'invalid_content'].includes(error.code)) {
          throw new AssetStorageError(error.code);
        }
        throw unavailable();
      }
    },
    async delete(key: AssetObjectKey): Promise<'deleted' | 'missing'> {
      assertObjectKey(key);
      if (!allowDelete) throw unavailable();
      // These outcomes describe the observed pre-delete existence, not a durable
      // tombstone. No late-PUT or distributed-atomicity guarantee is made.
      try { const present = await head(key); await remove(key); return present ? 'deleted' : 'missing'; }
      catch { throw unavailable(); }
    },
  });
}
