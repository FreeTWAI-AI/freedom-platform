import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createR2ObjectStore, type AssetR2Binding } from '../../packages/asset-storage/r2.js';
import { AssetStorageError, objectKey, preparePrivateText, readBounded, verifyObject, writeVerifiedObject,
  type AssetObjectKey } from '../../packages/asset-storage/index.js';

let mf: Miniflare, bucket: AssetR2Binding;
const policy = { revision: 'test-policy-1', platformPersistenceAllowed: true };
const key = () => objectKey({ scopeId: randomUUID(), assetId: randomUUID(), representationId: randomUUID() });
const stream = (bytes: Uint8Array) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
const prepared = (s = '私人草稿') => preparePrivateText(stream(new TextEncoder().encode(s)), 'text/plain', policy);
const code = (wanted: string) => (e: unknown) => e instanceof AssetStorageError && e.code === wanted && e.message === wanted;
before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'fp-asset-r2-test', modules: true,
    script: 'export default { fetch() { return new Response("test only"); } }',
    compatibilityDate: '2026-09-21', r2Buckets: ['MEDIA'] }] }));
  await mf.ready;
  bucket = await mf.getR2Bucket('MEDIA') as unknown as AssetR2Binding;
});
after(async () => { await mf?.dispose(); });
function port(overrides: Partial<AssetR2Binding>): AssetR2Binding {
  return { put: bucket.put.bind(bucket), get: bucket.get.bind(bucket), head: bucket.head.bind(bucket), delete: bucket.delete.bind(bucket), ...overrides };
}

test('R2-01 native conditional PUT creates once and preserves actual existing bytes', async () => {
  const store = createR2ObjectStore(bucket), id = key(), value = await prepared();
  assert.equal(await store.putImmutable(id, value), 'created');
  assert.equal(await store.putImmutable(id, value), 'exists');
  assert.equal(await store.putImmutable(id, await prepared('replacement')), 'exists');
  const verified = await verifyObject(store, id, value.metadata);
  assert.equal(verified.metadata.sha256, value.metadata.sha256);
  assert.notEqual(verified.etag, value.metadata.sha256);
  await assert.rejects(writeVerifiedObject(store, id, await prepared('different'), policy), code('integrity_mismatch'));
});
test('R2-02 concurrent distinct payloads never overwrite a winning immutable key', async () => {
  const id = key(), store = createR2ObjectStore(bucket), a = await prepared('aaaa'), b = await prepared('bbbb');
  const results = await Promise.all([store.putImmutable(id, a), store.putImmutable(id, b)]);
  assert.deepEqual(results.sort(), ['created', 'exists']);
  const found = await store.head(id); assert.ok(found);
  const winning = found.metadata.sha256 === a.metadata.sha256 ? a : b;
  await verifyObject(store, id, winning.metadata);
});
test('R2-03 metadata projects only allowed fields and supports exact bounded ranges', async () => {
  const id = key(), store = createR2ObjectStore(bucket), value = await prepared('abcdef');
  await store.putImmutable(id, value);
  assert.deepEqual(Object.keys((await store.head(id))!).sort(), ['etag', 'metadata']);
  const ranged = await store.get(id, { offset: 1, length: 3 }); assert.ok(ranged);
  assert.equal(new TextDecoder().decode(await readBounded(ranged.body, 3)), 'bcd');
  assert.deepEqual(ranged.metadata, value.metadata);
  for (const range of [{ offset: -1, length: 1 }, { offset: 1, length: 6 }, { offset: 6, length: 1 }, { offset: 1, length: 0 },
    { offset: 1, length: 0.5 }, { offset: NaN, length: 1 }, { offset: 0, length: Infinity }, { offset: undefined as unknown as number, length: 1 }]) {
    await assert.rejects(store.get(id, range), code('invalid_range'));
  }
  assert.equal(await store.get(key()), null); assert.equal(await store.head(key()), null);
});
test('R2-04 malformed custom or HTTP metadata fails closed without original details', async () => {
  const id = key(), value = await prepared();
  await bucket.put(id, value.bytes, { httpMetadata: { contentType: 'text/plain' }, customMetadata: { private_detail: 'secret' } });
  const store = createR2ObjectStore(bucket);
  await assert.rejects(store.head(id), code('invalid_metadata'));
  await assert.rejects(store.get(id), code('invalid_metadata'));
});
test('R2-05 actual byte digest, not native ETag or custom metadata, proves content', async () => {
  const id = key(), value = await prepared('original'), store = createR2ObjectStore(bucket);
  await store.putImmutable(id, value);
  const original = await bucket.head(id); assert.ok(original);
  await bucket.put(id, new TextEncoder().encode('mutated!'), { httpMetadata: original.httpMetadata, customMetadata: original.customMetadata });
  await assert.rejects(verifyObject(store, id, value.metadata), code('integrity_mismatch'));
});
test('R2-06 unknown PUT outcome reconciles by read-back without another PUT', async () => {
  const id = key(), value = await prepared(); let calls = 0;
  const store = createR2ObjectStore(port({ put: async (...args: Parameters<AssetR2Binding['put']>) => {
    calls++; await bucket.put(...args); throw new Error('private upstream diagnostics');
  } }));
  assert.equal((await writeVerifiedObject(store, id, value, policy)).metadata.sha256, value.metadata.sha256);
  assert.equal(calls, 1);
});
test('R2-07 failed PUT before write remains unavailable with no false storage evidence', async () => {
  const id = key(), value = await prepared();
  const store = createR2ObjectStore(port({ put: async () => { throw new Error('secret'); } }));
  await assert.rejects(writeVerifiedObject(store, id, value, policy), code('object_unavailable'));
  assert.equal(await bucket.head(id), null);
});
test('R2-08 snapshots input bytes/metadata before hashing yields control', async () => {
  const id = key(), value = await prepared('first'), metadata = { ...value.metadata }, bytes = value.bytes.slice();
  const store = createR2ObjectStore(bucket), pending = store.putImmutable(id, { bytes, metadata });
  bytes.fill(0); metadata.policyRevision = 'changed'; metadata.sha256 = '0'.repeat(64);
  await pending; await verifyObject(store, id, value.metadata);
});
test('R2-09 rejects unsafe bytes/metadata/key before native I/O', async () => {
  let calls = 0; const store = createR2ObjectStore(port({ put: async () => { calls++; throw new Error('unexpected native I/O'); } }));
  const value = await prepared(), id = key();
  await assert.rejects(store.putImmutable(id, { bytes: 100 as unknown as Uint8Array, metadata: value.metadata }), code('invalid_content'));
  await assert.rejects(store.putImmutable(id, { bytes: value.bytes, metadata: { ...value.metadata, byteSize: Number.MAX_SAFE_INTEGER } }), code('invalid_metadata'));
  await assert.rejects(store.putImmutable('../private' as AssetObjectKey, value), code('invalid_identity'));
  await assert.rejects(store.putImmutable(id, { ...value, bytes: new Uint8Array(value.bytes.length) }), code('integrity_mismatch'));
  assert.equal(calls, 0);
});
test('R2-10 delete is closed by default and maintenance outcome is only an observation', async () => {
  const id = key(), value = await prepared(), store = createR2ObjectStore(bucket);
  await store.putImmutable(id, value);
  await assert.rejects(store.delete(id), code('object_unavailable'));
  const options = { allowDelete: true }, maintenance = createR2ObjectStore(bucket, options); options.allowDelete = false;
  assert.equal(await maintenance.delete(id), 'deleted'); assert.equal(await maintenance.delete(id), 'missing');
  assert.equal(await store.head(id), null);
});
test('R2-11 native errors and metadata getter errors cannot disclose original details', async () => {
  const id = key();
  const store = createR2ObjectStore(port({ head: async () => { throw new Error('bucket-secret'); }, get: async () => { throw new Error('key-secret'); } }));
  await assert.rejects(store.head(id), code('object_unavailable')); await assert.rejects(store.get(id), code('object_unavailable'));
  const malicious = createR2ObjectStore(port({ head: async () => ({ get key() { throw new Error('secret'); } }) as never }));
  await assert.rejects(malicious.head(id), code('invalid_metadata'));
});
test('R2-12 range metadata is snapshotted and stale conditional GET without body fails', async () => {
  const id = key(), value = await prepared('abcdef'); await createR2ObjectStore(bucket).putImmutable(id, value);
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  const store = createR2ObjectStore(port({ head: async key => { await barrier; return bucket.head(key); } }));
  const range = { offset: 1, length: 2 }, pending = store.get(id, range); range.offset = 5; range.length = 1; release();
  assert.equal(new TextDecoder().decode(await readBounded((await pending)!.body, 2)), 'bc');
  const stale = createR2ObjectStore(port({ get: (async (key: string) => (await bucket.head(key))!) as AssetR2Binding['get'] }));
  await assert.rejects(stale.get(id, { offset: 1, length: 2 }), code('object_unavailable'));
});
test('R2-13 oversized/truncated native streams are bounded and never returned', async () => {
  const id = key(), value = await prepared('abc'); await createR2ObjectStore(bucket).putImmutable(id, value);
  const object = (await bucket.head(id))!;
  for (const text of ['abcd', 'a']) {
    let cancelled = false;
    const store = createR2ObjectStore(port({ get: async () => ({ ...object,
      body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); if (text === 'a') c.close(); }, cancel() { cancelled = true; } }),
    }) as never }));
    await assert.rejects(store.get(id), code(text === 'abcd' ? 'too_large' : 'integrity_mismatch'));
    if (text === 'abcd') assert.equal(cancelled, true);
  }
});
test('R2-14 no ambient binding or caller credentials are accepted', () => {
  assert.throws(() => createR2ObjectStore(undefined as unknown as AssetR2Binding), code('object_unavailable'));
  assert.throws(() => createR2ObjectStore({} as AssetR2Binding), code('object_unavailable'));
});

test('R2-15 transport read errors remain unavailable, including forged upstream error classes', async () => {
  const id = key(), value = await prepared(); await createR2ObjectStore(bucket).putImmutable(id, value);
  const object = (await bucket.head(id))!;
  for (const error of [new Error('secret diagnostics'), new AssetStorageError('invalid_content')]) {
    error.message = 'private upstream details';
    const store = createR2ObjectStore(port({ get: async () => ({ ...object,
      body: new ReadableStream({ pull() { throw error; } }, { highWaterMark: 0 }),
    }) as never }));
    await assert.rejects(store.get(id), code('object_unavailable'));
  }
});
test('R2-16 native reader release failure fails closed without raw diagnostics', async () => {
  const id = key(), value = await prepared(); await createR2ObjectStore(bucket).putImmutable(id, value);
  const object = (await bucket.head(id))!; let done = false;
  const store = createR2ObjectStore(port({ get: async () => ({ ...object, body: {
    getReader() { return {
      async read() { if (done) return { done: true }; done = true; return { done: false, value: value.bytes }; },
      async cancel() {}, releaseLock() { throw new Error('secret release details'); },
    }; }, async cancel() {},
  } }) as never }));
  await assert.rejects(store.get(id), code('object_unavailable'));
});
