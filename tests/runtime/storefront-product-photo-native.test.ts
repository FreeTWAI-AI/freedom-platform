import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { before, after, beforeEach, test } from 'node:test';
import sharp from 'sharp';
import { createHostedStorePhotoHarness, type HostedStorePhotoHarness } from '../helpers/hosted-store-photo.js';
import { assertProductPhotoSource } from '../../modules/assets/storefront-product-photo.js';
import { currentImageProcessor } from '../../packages/shared/image-runtime.js';
import { assertCanonicalWebpWithin, inspectCanonicalWebp } from '../../packages/shared/image-webp.js';
import { AssetStorageError } from '../../packages/asset-storage/index.js';
import { Problem } from '../../packages/shared/problem.js';

// Real Node sharp/libvips plus restricted PostgreSQL. No processor override,
// Worker binding, browser or network-socket evidence is asserted by this suite.
let f: HostedStorePhotoHarness;
before(async () => { f = await createHostedStorePhotoHarness(); });
after(async () => { await f?.stop(); });
beforeEach(async () => { await f.reset(); assert.equal(currentImageProcessor().name, 'node-sharp'); });
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const solid = (width: number, height: number, background: string) => sharp({ create: { width, height, channels: 3, background } });
function chunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]), out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length); body.copy(out, 4); out.writeUInt32BE(crc32(body), body.length + 4); return out;
}
function pngChunk(png: Buffer, type: string, data: Buffer) {
  return Buffer.concat([png.subarray(0, 33), chunk(type, data), png.subarray(33)]);
}
function jpegComment(jpeg: Buffer, text: string) {
  const body = Buffer.from(text), segment = Buffer.alloc(4 + body.length);
  segment[0] = 0xff; segment[1] = 0xfe; segment.writeUInt16BE(body.length + 2, 2); body.copy(segment, 4);
  return Buffer.concat([jpeg.subarray(0, 2), segment, jpeg.subarray(2)]);
}
// Keep the actual SOF/SOS and EOI, remove the entire compressed scan. Passing
// assertProductPhotoSource is checked below; no framing failure counts as decode.
function jpegWithoutScan(jpeg: Buffer) {
  let offset = 2;
  while (offset < jpeg.length - 2) {
    assert.equal(jpeg[offset++], 0xff); while (jpeg[offset] === 0xff) offset++;
    const marker = jpeg[offset++], length = jpeg.readUInt16BE(offset);
    assert(length >= 2 && offset + length <= jpeg.length);
    if (marker === 0xda) return Buffer.concat([jpeg.subarray(0, offset + length), Buffer.from([0xff, 0xd9])]);
    offset += length;
  }
  assert.fail('synthetic JPEG has no SOS');
}
async function enable() {
  await f.h.pool.query("UPDATE domain_media_storage_policy SET mode='r2_only',persistence_allowed=true,policy_revision='synthetic-photo-native-1',retained_byte_limit=16777216 WHERE purpose='storefront.product-photo'");
}
async function retainedRows() {
  return (await f.h.pool.query(`SELECT (SELECT count(*)::int FROM assets WHERE purpose='storefront.product-photo') assets,
    (SELECT count(*)::int FROM asset_upload_intents WHERE purpose='storefront.product-photo') intents,
    (SELECT count(*)::int FROM asset_objects WHERE purpose='storefront.product-photo') objects`)).rows[0];
}

test('PHOTO-NATIVE-01 real PNG JPEG and WebP factories persist bounded metadata-free pixels with orientation and no upscaling', async () => {
  const s = await f.openStore(); await enable();
  const red = await solid(32, 32, '#ff0000').png().toBuffer();
  const oriented = await solid(64, 32, '#0000ff').composite([{ input: red, left: 0, top: 0 }]).jpeg({ quality: 95 })
    .withExif({ IFD0: { Artist: 'synthetic-photo-artist' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '25/1 2/1 0/1' } })
    .withIccProfile('p3').withMetadata({ orientation: 6 }).toBuffer();
  const jpeg = jpegComment(oriented, 'synthetic-photo-comment'), inputMeta = await sharp(jpeg).metadata();
  assert.equal(inputMeta.orientation, 6);
  assert.ok(inputMeta.exif && inputMeta.icc, 'input actually carries EXIF and ICC');
  assert.ok(inputMeta.exif.includes('synthetic-photo-artist'));
  assert.ok(inputMeta.exif.includes(Buffer.from([0x88, 0x25])) || inputMeta.exif.includes(Buffer.from([0x25, 0x88])), 'input EXIF contains a GPS IFD pointer');
  assert.ok(jpeg.includes('synthetic-photo-comment'));
  const png = pngChunk(await solid(3000, 1500, '#336699').png().toBuffer(), 'tEXt', Buffer.from('Comment\0synthetic-photo-png-comment'));
  assert.ok(png.includes('synthetic-photo-png-comment'));
  const webp = await solid(17, 9, '#336699').webp({ lossless: true }).toBuffer();
  const cases = [
    { mime: 'image/png', bytes: png, width: 1920, height: 960 },
    { mime: 'image/jpeg', bytes: jpeg, width: 32, height: 64 },
    { mime: 'image/webp', bytes: webp, width: 17, height: 9 },
  ] as const;
  for (const [index, item] of cases.entries()) {
    const product = index === 0 ? { product_id: s.productId, version: s.version } : f.ok(await f.post(s.root + '/products', s.owner,
      { title: '原生解碼商品 ' + index, price_minor: 1234, stock: 1 }), 201);
    const original = Buffer.from(item.bytes), api = await f.assets.forProduct({ mime: item.mime, bytes: item.bytes });
    const actor = { ...s.actor, tenant_id: s.tenantId, instance_id: s.instanceId };
    const prepared = await api.prepare(actor, { key: randomUUID(), targetProductId: product.product_id, expectedVersion: product.version,
      contentType: item.mime, byteSize: original.length, sha256: hash(original) });
    const lease = await api.claim(actor, { key: randomUUID(), intentId: prepared.intentId });
    const binding = { intentId: prepared.intentId, fence: lease.fence, leaseToken: lease.leaseToken };
    await api.write(actor, { ...binding, key: randomUUID() }, new ReadableStream({ start(c) { c.enqueue(item.bytes); c.close(); } }));
    const completed = await api.finalize(actor, { ...binding, key: randomUUID() });
    assert.equal(completed.completedVersion, '2'); assert.deepEqual(item.bytes, original, 'factory leaves caller source bytes unchanged');
    const page = f.ok(await f.call('GET', s.root + '/product-media', s.owner));
    const view = page.items.find((row: any) => row.product_id === product.product_id); assert(view?.photo);
    const response = await f.app.request(f.h.origin + view.photo.read_path, { headers: { Cookie: s.owner.cookie } });
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/webp');
    const output = Buffer.from(await response.arrayBuffer()); assert(output.length > 0 && output.length <= 1048576);
    assertCanonicalWebpWithin(output, 1920, 1920);
    const shape = inspectCanonicalWebp(output), metadata = await sharp(output).metadata();
    assert.deepEqual([shape.width, shape.height], [item.width, item.height]);
    assert.deepEqual([metadata.format, metadata.width, metadata.height], ['webp', item.width, item.height]);
    for (const name of ['exif', 'icc', 'xmp', 'iptc', 'comments', 'orientation'] as const) assert.equal(metadata[name], undefined, name);
    for (const marker of ['EXIF', 'ICCP', 'XMP ', 'synthetic-photo-artist', 'synthetic-photo-comment', 'synthetic-photo-png-comment']) assert.equal(output.includes(marker), false, marker);
    // Full pixel decode, not metadata-only inspection, also validates rotation.
    const decoded = await sharp(output).raw().toBuffer({ resolveWithObject: true });
    assert.equal(decoded.data.length, item.width * item.height * decoded.info.channels);
    if (item.mime === 'image/jpeg') {
      const pixel = (x: number, y: number) => [...decoded.data.subarray((y * item.width + x) * decoded.info.channels, (y * item.width + x) * decoded.info.channels + 3)];
      assert.ok(pixel(16, 8).every((v, i) => Math.abs(v - [255, 0, 0][i]) < 40), 'orientation6 puts red above blue');
      assert.ok(pixel(16, 56).every((v, i) => Math.abs(v - [0, 0, 255][i]) < 40), 'orientation6 puts blue below red');
    }
    const object = (await f.h.pool.query(`SELECT o.*,a.state FROM asset_objects o JOIN assets a USING(asset_id) WHERE o.asset_id=$1`, [prepared.assetId])).rows[0];
    assert.equal(object.state, 'ready'); assert.equal(object.content_sha256, hash(output)); assert.equal(Number(object.byte_size), output.length);
    assert.deepEqual([object.pixel_width, object.pixel_height], [item.width, item.height]);
    assert.equal(object.purpose, 'storefront.product-photo'); assert.equal(object.profile_id, 'storefront.product-photo');
    assert.equal(object.transform_version, 'storefront.product-photo.webp.v1');
  }
  assert.deepEqual(await retainedRows(), { assets: 3, intents: 3, objects: 3 });
});

test('PHOTO-NATIVE-02 framing-valid corrupt compression reaches real decode; framing animation and size refusals retain nothing', async () => {
  await f.openStore(); await enable();
  const png = await solid(64, 48, '#c86428').png().toBuffer(), jpeg = await solid(64, 48, '#c86428').jpeg().toBuffer();
  const webp = await solid(64, 48, '#c86428').webp({ lossless: true }).toBuffer();
  const badPng = Buffer.from(png), idat = badPng.indexOf('IDAT'); assert(idat > 4);
  const idatLength = badPng.readUInt32BE(idat - 4); assert(idatLength >= 2);
  badPng[idat + 4] ^= 0xff; badPng[idat + 5] ^= 0xff;
  badPng.writeUInt32BE(crc32(badPng.subarray(idat, idat + 4 + idatLength)), idat + 4 + idatLength);
  const vp8l = webp.indexOf('VP8L'); assert(vp8l >= 12);
  const badWebp = Buffer.alloc(26); badWebp.write('RIFF'); badWebp.writeUInt32LE(18, 4); badWebp.write('WEBP', 8);
  badWebp.write('VP8L', 12); badWebp.writeUInt32LE(5, 16); webp.copy(badWebp, 20, vp8l + 8, vp8l + 13);
  const decoderCases = [
    { name: 'PNG invalid deflate with correct framing and CRC', mime: 'image/png', bytes: badPng, format: 'png' },
    { name: 'JPEG complete markers with missing entropy scan', mime: 'image/jpeg', bytes: jpegWithoutScan(jpeg), format: 'jpeg' },
    { name: 'WebP complete RIFF and VP8L dimensions with absent compressed pixels', mime: 'image/webp', bytes: badWebp, format: 'webp' },
  ] as const;
  const initial = await retainedRows(), puts = f.store.puts;
  for (const item of decoderCases) {
    assert.equal(assertProductPhotoSource(item.mime, item.bytes), item.format, item.name + ': must pass framing to count as decoder tier');
    const original = Buffer.from(item.bytes);
    await assert.rejects(f.assets.forProduct(item), (error: unknown) => error instanceof Problem && error.code === 'invalid_product_photo', item.name);
    assert.deepEqual(item.bytes, original); assert.deepEqual(await retainedRows(), initial); assert.equal(f.store.puts, puts);
  }
  const frames = await Promise.all(['red', 'blue'].map(c => solid(8, 8, c).png().toBuffer()));
  const animated = await sharp(frames, { join: { animated: true } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
  assert.equal((await sharp(animated).metadata()).pages, 2, 'animation fixture actually has two frames');
  const structuralCases = [
    { name: 'truncated PNG', mime: 'image/png', bytes: png.subarray(0, -1) },
    { name: 'truncated JPEG', mime: 'image/jpeg', bytes: jpeg.subarray(0, -1) },
    { name: 'truncated WebP', mime: 'image/webp', bytes: webp.subarray(0, -1) },
    { name: 'APNG acTL container marker', mime: 'image/png', bytes: pngChunk(png, 'acTL', Buffer.from([0, 0, 0, 2, 0, 0, 0, 0])) },
    { name: 'actual animated WebP', mime: 'image/webp', bytes: animated },
    { name: 'wrong declared MIME', mime: 'image/jpeg', bytes: png },
    { name: '4097px input exceeds profile', mime: 'image/png', bytes: await solid(4097, 1, '#c86428').png().toBuffer() },
  ];
  for (const item of structuralCases) {
    assert.throws(() => assertProductPhotoSource(item.mime, item.bytes), (error: unknown) => error instanceof Problem && error.code === 'invalid_product_photo', item.name + ': structural refusal');
    const original = Buffer.from(item.bytes);
    await assert.rejects(f.assets.forProduct(item), (error: unknown) => error instanceof Problem && error.code === 'invalid_product_photo', item.name);
    assert.deepEqual(item.bytes, original); assert.deepEqual(await retainedRows(), initial); assert.equal(f.store.puts, puts);
  }
  const oversized = Buffer.concat([png, Buffer.alloc(2097153 - png.length)]), before = hash(oversized);
  await assert.rejects(f.assets.forProduct({ mime: 'image/png', bytes: oversized }), (error: unknown) => error instanceof AssetStorageError && error.code === 'too_large');
  assert.equal(hash(oversized), before); assert.deepEqual(await retainedRows(), initial); assert.equal(f.store.puts, puts);
});
