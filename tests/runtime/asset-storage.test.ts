import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { normalizeImage } from '../../packages/shared/image-runtime.js';
import { FakeObjectStore } from '../../packages/asset-storage/fake-store.js';
import { AssetStorageError, AVATAR_PROFILE, PRIVATE_TEXT_MAX_BYTES, objectKey, prepareAvatar, preparePrivateText,
  readBounded, sha256, verifyObject, writeVerifiedObject,
  type AssetObjectKey, type ObjectMetadata, type ObjectStore, type PersistencePolicy } from '../../packages/asset-storage/index.js';

const policy: PersistencePolicy = Object.freeze({ revision: 'policy-1', platformPersistenceAllowed: true });
const identity = { scopeId: '11111111-1111-4111-8111-111111111111', assetId: '22222222-2222-4222-8222-222222222222', representationId: '33333333-3333-4333-8333-333333333333' };
const key = objectKey(identity);
const encode = (s: string) => new TextEncoder().encode(s);
function stream(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(c) { for (const bytes of chunks) c.enqueue(bytes); c.close(); } });
}
const text = (s = 'private draft') => preparePrivateText(stream(encode(s)), 'text/plain', policy);
const errorCode = (code: string) => (error: unknown) => error instanceof AssetStorageError && error.code === code && error.message === code;

test('ASSET-IO-01 opaque immutable key tuple rejects paths, URLs and user data', () => {
  assert.equal(key, `v1/${identity.scopeId}/${identity.assetId}/${identity.representationId}`);
  for (const field of ['scopeId', 'assetId', 'representationId']) {
    for (const bad of ['a@example.test', '../secret', 'https://example.test/a', '%2f', 'avatar.png', '', identity.scopeId + '\n', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA']) {
      assert.throws(() => objectKey({ ...identity, [field]: bad }), errorCode('invalid_identity'));
    }
  }
  for (const invalid of [undefined, null, {}]) assert.throws(() => objectKey(invalid as typeof identity), errorCode('invalid_identity'));
  assert.notEqual(objectKey({ ...identity, scopeId: '44444444-4444-4444-8444-444444444444' }), key);
  assert.notEqual(objectKey({ ...identity, representationId: '55555555-5555-4555-8555-555555555555' }), key);
});

test('ASSET-IO-02 persistence denial precedes source reading and storage I/O', async () => {
  let reads = 0;
  const body = new ReadableStream<Uint8Array>({ pull() { reads++; } }, { highWaterMark: 0 });
  for (const denied of [false, undefined, 'true']) {
    await assert.rejects(preparePrivateText(body, 'text/plain', { revision: '1', platformPersistenceAllowed: denied } as PersistencePolicy), errorCode('persistence_prohibited'));
  }
  assert.equal(reads, 0); assert.equal(body.locked, false);
  const store = new FakeObjectStore();
  await assert.rejects(writeVerifiedObject(store, key, await text(), { ...policy, platformPersistenceAllowed: false }), errorCode('persistence_prohibited'));
  assert.equal(await store.head(key), null);
  await body.cancel();
});

test('ASSET-IO-03 byte cap is enforced from chunked bytes, including exact UTF-8 boundary', async () => {
  const bytes = encode('文'.repeat(Math.floor(PRIVATE_TEXT_MAX_BYTES / 3)) + 'a');
  assert.equal(bytes.length, PRIVATE_TEXT_MAX_BYTES);
  const value = await preparePrivateText(stream(bytes.subarray(0, 2), bytes.subarray(2)), 'text/markdown', policy);
  assert.deepEqual(value.bytes, bytes);
  assert.equal(value.metadata.byteSize, PRIVATE_TEXT_MAX_BYTES);
  let cancelled = false;
  const overflow = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.enqueue(encode('x')); }, cancel() { cancelled = true; } });
  await assert.rejects(preparePrivateText(overflow, 'text/plain', policy), errorCode('too_large'));
  assert.equal(cancelled, true); assert.equal(overflow.locked, false);
});

test('ASSET-IO-04 malformed/split UTF-8, binary controls, empty and unsafe MIME rejected', async () => {
  for (const chunks of [[new Uint8Array()], [new Uint8Array([0xe2]), new Uint8Array([0x28, 0xa1])],
    [new Uint8Array([0xed, 0xa0, 0x80])], [new Uint8Array([0xc0, 0xaf])], [new Uint8Array([0xe2, 0x82])],
    [encode('a\u0000b')], [encode('PK\u0003\u0004')]]) {
    await assert.rejects(preparePrivateText(stream(...chunks), 'text/plain', policy), errorCode(chunks[0].length ? 'invalid_content' : 'empty_content'));
  }
  for (const mime of ['text/html', 'application/javascript', 'application/zip', 'text/plain; charset=iso-8859-1', 'Text/Plain']) {
    await assert.rejects(preparePrivateText(stream(encode('hello')), mime, policy), errorCode('unsupported_content_type'));
  }
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0a, 0x09]);
  assert.deepEqual((await preparePrivateText(stream(bom), 'text/plain', policy)).bytes, bom);
});

test('ASSET-IO-05 stream failures cancel/release and sanitize source diagnostics', async () => {
  const body = new ReadableStream<Uint8Array>({ pull() { throw new Error('secret original body'); } });
  await assert.rejects(readBounded(body, 100), errorCode('invalid_content'));
  assert.equal(body.locked, false);
  await assert.rejects(readBounded(stream(encode('a')), Infinity), errorCode('invalid_metadata'));
});

test('ASSET-IO-06 preparation snapshots policy before asynchronous source consumption', async () => {
  const mutablePolicy = { ...policy };
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const body = new ReadableStream<Uint8Array>({ async pull(c) { await barrier; c.enqueue(encode('a')); c.close(); } }, { highWaterMark: 0 });
  const pending = preparePrivateText(body, 'text/plain', mutablePolicy);
  mutablePolicy.revision = 'changed'; release();
  assert.equal((await pending).metadata.policyRevision, policy.revision);
});

test('ASSET-IO-07 immutable PUT, verified retry and replacement identity', async () => {
  const store = new FakeObjectStore(), value = await text();
  const first = await writeVerifiedObject(store, key, value, policy);
  assert.equal(first.metadata.sha256, await sha256(value.bytes));
  assert.notEqual(first.etag, first.metadata.sha256);
  assert.deepEqual(await writeVerifiedObject(store, key, value, policy), first);
  const different = await text('replacement');
  await assert.rejects(store.putImmutable(key, different), errorCode('object_conflict'));
  await assert.rejects(writeVerifiedObject(store, key, different, policy), errorCode('integrity_mismatch'));
  assert.deepEqual(await verifyObject(store, key, value.metadata), first);
  const replacementKey = objectKey({ ...identity, assetId: '66666666-6666-4666-8666-666666666666' });
  await writeVerifiedObject(store, replacementKey, different, policy);
});

test('ASSET-IO-08 uncertain PUT-after-success reconciles actual bytes, PUT-before remains unavailable and retries', async () => {
  const store = new FakeObjectStore(), value = await text();
  store.failNext('put-before');
  await assert.rejects(writeVerifiedObject(store, key, value, policy), errorCode('object_unavailable'));
  assert.equal(await store.head(key), null);
  store.failNext('put-after');
  assert.equal((await writeVerifiedObject(store, key, value, policy)).metadata.sha256, value.metadata.sha256);
  // A failed future DB finalize would leave this exact object for reconciliation.
  // No DB transaction or asset-ready transition is simulated here.
  assert.equal((await verifyObject(store, key, value.metadata)).metadata.sha256, value.metadata.sha256);
});

test('ASSET-IO-09 uncertain PUT plus failed verification never reports success; later retry recovers', async () => {
  const store = new FakeObjectStore(), value = await text();
  store.failNext('put-after'); store.failNext('get');
  await assert.rejects(writeVerifiedObject(store, key, value, policy), errorCode('object_unavailable'));
  assert.equal((await writeVerifiedObject(store, key, value, policy)).metadata.sha256, value.metadata.sha256);
});

test('ASSET-IO-10 actual digest/size required despite correct metadata and ETag', async () => {
  const store = new FakeObjectStore(), value = await text('original');
  await store.putImmutable(key, value);
  for (const corrupt of [encode('mutated!'), encode('short'), encode('too much data')]) {
    const port: ObjectStore = {
      putImmutable: store.putImmutable.bind(store), head: store.head.bind(store), delete: store.delete.bind(store),
      get: async () => ({ metadata: value.metadata, etag: value.metadata.sha256, body: stream(corrupt) }),
    };
    await assert.rejects(verifyObject(port, key, value.metadata), errorCode(corrupt.length > value.bytes.length ? 'too_large' : 'integrity_mismatch'));
  }
  await assert.rejects(verifyObject(store, key, { ...value.metadata, policyRevision: 'wrong' }), errorCode('integrity_mismatch'));
});

test('ASSET-IO-11 mutated prepared bytes and forged metadata cannot persist', async () => {
  const store = new FakeObjectStore(), value = await text();
  value.bytes[0] ^= 1;
  await assert.rejects(writeVerifiedObject(store, key, value, policy), errorCode('integrity_mismatch'));
  for (const metadata of [{ ...value.metadata, byteSize: -1 }, { ...value.metadata, sha256: 'etag' },
    { ...value.metadata, sha256: value.metadata.sha256 + '\n' }, { ...value.metadata, policyRevision: 'policy-1\n' },
    { ...value.metadata, contentType: 'text/html' }, { ...value.metadata, transformVersion: 'unknown' }]) {
    await assert.rejects(writeVerifiedObject(store, key, { ...value, metadata: metadata as ObjectMetadata }, policy), errorCode('invalid_metadata'));
  }
  await assert.rejects(writeVerifiedObject(store, key, await text(), { ...policy, revision: 'other-policy' }), errorCode('invalid_policy'));
  await assert.rejects(store.head('v1/../../secret' as AssetObjectKey), errorCode('invalid_identity'));
  assert.equal(await store.head(key), null);
  await assert.rejects(preparePrivateText(stream(encode('a')), 'text/plain', { ...policy, revision: 'policy-1\n' }), errorCode('invalid_policy'));
});

test('ASSET-IO-17 verification snapshots expected metadata before adapter await and sanitizes adapter errors', async () => {
  const store = new FakeObjectStore(), value = await text();
  await store.putImmutable(key, value);
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const port: ObjectStore = { putImmutable: store.putImmutable.bind(store), head: store.head.bind(store), delete: store.delete.bind(store),
    get: async key => { await barrier; return store.get(key); } };
  const mutable = { ...value.metadata };
  const pending = verifyObject(port, key, mutable);
  mutable.sha256 = '0'.repeat(64); mutable.policyRevision = 'changed'; release();
  assert.deepEqual((await pending).metadata, value.metadata);
  port.get = async () => { throw new Error('private cloud path and token'); };
  await assert.rejects(verifyObject(port, key, value.metadata), errorCode('object_unavailable'));
  port.get = async () => ({ metadata: value.metadata, body: { getReader() { throw new Error('private stream diagnostics'); } } as unknown as ReadableStream<Uint8Array> });
  await assert.rejects(verifyObject(port, key, value.metadata), errorCode('invalid_content'));
});

test('ASSET-IO-12 fake store snapshots caller bytes and read streams, including concurrent same-key writes', async () => {
  const store = new FakeObjectStore(), a = await text('first'), b = await text('other');
  const results = await Promise.allSettled([store.putImmutable(key, a), store.putImmutable(key, b)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const saved = (await store.head(key))!.metadata;
  a.bytes.fill(0); b.bytes.fill(0);
  const read = await store.get(key);
  (await readBounded(read!.body, saved.byteSize)).fill(0);
  await verifyObject(store, key, saved);
});

test('ASSET-IO-13 single validated byte ranges and delete timeout/retry/missing', async () => {
  const store = new FakeObjectStore(), value = await text('abcdef');
  await store.putImmutable(key, value);
  const part = await store.get(key, { offset: 1, length: 3 });
  assert.equal(new TextDecoder().decode(await readBounded(part!.body, 3)), 'bcd');
  assert.equal(part!.metadata.byteSize, 6); // full representation metadata, not an HTTP DTO
  for (const range of [{ offset: -1, length: 2 }, { offset: 6, length: 1 }, { offset: 0, length: 0 },
    { offset: 0, length: 7 }, { offset: 0.1, length: 1 }, { offset: 0, length: NaN }]) {
    await assert.rejects(store.get(key, range), errorCode('invalid_range'));
  }
  store.failNext('delete-before');
  await assert.rejects(store.delete(key), errorCode('object_unavailable'));
  assert.notEqual(await store.head(key), null);
  store.failNext('delete-after');
  await assert.rejects(store.delete(key), errorCode('object_unavailable'));
  assert.equal(await store.delete(key), 'missing');
  assert.equal(await store.get(key), null);
  await assert.rejects(verifyObject(store, key, value.metadata), errorCode('object_unavailable'));
});

const normalize = (bytes: Uint8Array, spec: Parameters<typeof normalizeImage>[1]) => normalizeImage(Buffer.from(bytes), spec);
test('ASSET-IO-14 avatar profile reuses real decoder, canonical size and metadata stripping', async () => {
  const image = sharp({ create: { width: 300, height: 280, channels: 3, background: '#8b4f2a' } });
  for (const [mime, bytes] of [['image/png', await image.clone().png().withMetadata().toBuffer()],
    ['image/jpeg', await image.clone().jpeg().withMetadata().toBuffer()], ['image/webp', await image.clone().webp().withMetadata().toBuffer()]] as const) {
    const value = await prepareAvatar(stream(bytes), mime, policy, normalize);
    assert.equal(value.metadata.contentType, 'image/webp');
    assert.equal(value.metadata.transformVersion, AVATAR_PROFILE.transformVersion);
    const metadata = await sharp(value.bytes).metadata();
    assert.equal(metadata.width, 256); assert.equal(metadata.height, 256);
    assert.equal(metadata.exif, undefined); assert.equal(metadata.icc, undefined);
    assert.ok(value.bytes.byteLength <= AVATAR_PROFILE.outputMaxBytes);
  }
});

test('ASSET-IO-15 invalid avatar input never reaches decoder; no URL fetch path exists', async () => {
  let calls = 0;
  const decoder = async () => { calls++; return new Uint8Array(); };
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer();
  for (const [mime, bytes] of [['image/svg+xml', encode('<svg/>')], ['image/png', encode('https://internal.test/private')],
    ['image/jpeg', png], ['image/png', png.subarray(0, png.length - 1)], ['image/png', new Uint8Array(AVATAR_PROFILE.inputMaxBytes + 1)]] as const) {
    await assert.rejects(prepareAvatar(stream(bytes), mime, policy, decoder), error => error instanceof AssetStorageError);
  }
  const huge = await sharp({ create: { width: 4097, height: 1, channels: 3, background: 'red' } }).png().toBuffer();
  await assert.rejects(prepareAvatar(stream(huge), 'image/png', policy, decoder), errorCode('invalid_content'));
  const animated = Buffer.concat([png.subarray(0, 33), Buffer.from([0, 0, 0, 0, 97, 99, 84, 76, 0, 0, 0, 0]), png.subarray(33)]);
  await assert.rejects(prepareAvatar(stream(animated), 'image/png', policy, decoder), errorCode('invalid_content'));
  assert.equal(calls, 0);
});

test('ASSET-IO-16 avatar rejects wrong-sized, oversized and metadata-bearing processor output', async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer();
  const wrongSize = await sharp(png).webp().toBuffer();
  const metadata = await sharp(png).resize(256, 256).webp().withMetadata().toBuffer();
  for (const output of [wrongSize, metadata, new Uint8Array(AVATAR_PROFILE.outputMaxBytes + 1)]) {
    await assert.rejects(prepareAvatar(stream(png), 'image/png', policy, async () => output), error => error instanceof AssetStorageError);
  }
  await assert.rejects(prepareAvatar(stream(png), 'image/png', policy, async () => { throw new Error('secret processor diagnostics'); }), errorCode('invalid_content'));
});

test('ASSET-IO-18 successful PUT with absent read-back is unavailable; other scope cannot find the object', async () => {
  const store = new FakeObjectStore(), value = await text();
  const absent: ObjectStore = { putImmutable: async () => 'created', get: store.get.bind(store), head: store.head.bind(store), delete: store.delete.bind(store) };
  await assert.rejects(writeVerifiedObject(absent, key, value, policy), errorCode('object_unavailable'));
  await writeVerifiedObject(store, key, value, policy);
  const otherScope = objectKey({ ...identity, scopeId: '44444444-4444-4444-8444-444444444444' });
  await assert.rejects(verifyObject(store, otherScope, value.metadata), errorCode('object_unavailable'));
});

test('ASSET-IO-19 concurrent equal PUTs and paused write expose only absent or complete objects', async () => {
  const store = new FakeObjectStore(), value = await text();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const delayed: ObjectStore = { putImmutable: async (key, value) => { await barrier; return store.putImmutable(key, value); },
    get: store.get.bind(store), head: store.head.bind(store), delete: store.delete.bind(store) };
  const pending = writeVerifiedObject(delayed, key, value, policy);
  assert.equal(await store.head(key), null); assert.equal(await store.get(key), null);
  release(); await pending;
  const statuses = await Promise.all([store.putImmutable(key, value), store.putImmutable(key, value)]);
  assert.deepEqual(statuses, ['exists', 'exists']);
  await verifyObject(store, key, value.metadata);
  await store.delete(key);
  // A late writer is permitted by this object-only fake. DB deletion fences and
  // orphan reconciliation must prevent attachment and clean this up later.
  assert.equal(await store.putImmutable(key, value), 'created');
});

test('ASSET-IO-20 exact emoji cap accepts split code points; ranges return raw bytes', async () => {
  const bytes = encode('😀'.repeat(PRIVATE_TEXT_MAX_BYTES / 4));
  const value = await preparePrivateText(stream(bytes.subarray(0, 1), bytes.subarray(1, 3), bytes.subarray(3)), 'text/plain', policy);
  assert.equal(value.metadata.byteSize, PRIVATE_TEXT_MAX_BYTES);
  await assert.rejects(preparePrivateText(stream(bytes, encode('x')), 'text/plain', policy), errorCode('too_large'));
  const store = new FakeObjectStore(); await store.putImmutable(key, value);
  const fragment = await store.get(key, { offset: 1, length: 2 });
  assert.deepEqual(await readBounded(fragment!.body, 2), bytes.subarray(1, 3));
});
