import { assertObjectKey, AssetStorageError, sha256, validateMetadata, validateRange,
  type AssetObjectKey, type ObjectHead, type ObjectRange, type ObjectStore, type PreparedRepresentation, type StoredObject } from './index.js';

export type FakeStoreFault = 'put-before' | 'put-after' | 'get' | 'delete-before' | 'delete-after';
/** Test-only store. No ACL, database lifecycle, GC eligibility or cloud claims. */
export class FakeObjectStore implements ObjectStore {
  private readonly objects = new Map<AssetObjectKey, PreparedRepresentation>();
  private readonly faults: FakeStoreFault[] = [];
  failNext(fault: FakeStoreFault): void { this.faults.push(fault); }
  private fault(fault: FakeStoreFault): void {
    if (this.faults[0] === fault) { this.faults.shift(); throw new AssetStorageError('object_unavailable'); }
  }
  async putImmutable(key: AssetObjectKey, value: PreparedRepresentation): Promise<'created' | 'exists'> {
    assertObjectKey(key); validateMetadata(value.metadata); this.fault('put-before');
    const bytes = new Uint8Array(value.bytes), metadata = Object.freeze({ ...value.metadata });
    if (bytes.byteLength !== metadata.byteSize || await sha256(bytes) !== metadata.sha256) throw new AssetStorageError('integrity_mismatch');
    // No await between existence check and insertion: atomic for this in-process fake.
    const current = this.objects.get(key);
    if (current) {
      if (current.metadata.sha256 !== metadata.sha256 || current.metadata.byteSize !== metadata.byteSize
        || current.metadata.contentType !== metadata.contentType || current.metadata.transformVersion !== metadata.transformVersion
        || current.metadata.policyRevision !== metadata.policyRevision) throw new AssetStorageError('object_conflict');
      return 'exists';
    }
    this.objects.set(key, { bytes, metadata });
    this.fault('put-after');
    return 'created';
  }
  async head(key: AssetObjectKey): Promise<ObjectHead | null> {
    assertObjectKey(key);
    const value = this.objects.get(key);
    return value ? { metadata: Object.freeze({ ...value.metadata }), etag: 'fake-etag-not-a-digest' } : null;
  }
  async get(key: AssetObjectKey, range?: ObjectRange): Promise<StoredObject | null> {
    assertObjectKey(key); this.fault('get');
    const value = this.objects.get(key);
    if (!value) return null;
    if (range) validateRange(range, value.bytes.byteLength);
    const bytes = range ? value.bytes.slice(range.offset, range.offset + range.length) : value.bytes.slice();
    return { metadata: Object.freeze({ ...value.metadata }), etag: 'fake-etag-not-a-digest',
      body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
  }
  async delete(key: AssetObjectKey): Promise<'deleted' | 'missing'> {
    assertObjectKey(key); this.fault('delete-before');
    const deleted = this.objects.delete(key);
    this.fault('delete-after');
    return deleted ? 'deleted' : 'missing';
  }
}
