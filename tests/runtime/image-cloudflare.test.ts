import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { crc32 } from 'node:zlib';
import { Pool } from 'pg';
import sharp from 'sharp';
import { createPool, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_USERS, DEMO_PASSWORD } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { Problem } from '../../packages/shared/problem.js';
import { runWithImageProcessor } from '../../packages/shared/image-runtime.js';
import { createCloudflareImageProcessor, type ImagesBinding, type ImagesInfo, type ImagesOutputOptions, type ImagesTransform } from '../../packages/shared/image-cloudflare.js';
import { assertCompleteRaster } from '../../packages/shared/image-container.js';
import { inspectCanonicalWebp } from '../../packages/shared/image-webp.js';
import { normalizeCoverImage } from '../../modules/skill-submissions/payload.js';

// Synthetic binding fixtures only. `sharpRender` stands in for the Images
// service with real sharp (applying EXIF orientation as the docs describe);
// it proves the adapter contract and validators, not Cloudflare production transforms.
type Call = { kind: 'info' | 'input'; transform?: ImagesTransform; output?: ImagesOutputOptions };
const read = async (stream: ReadableStream<Uint8Array>) => Buffer.from(await new Response(stream).arrayBuffer());
const streamOf = (bytes: Uint8Array) => new Blob([new Uint8Array(bytes)]).stream();
interface Fake {
  info?: (bytes: Buffer) => Promise<ImagesInfo>;
  render?: (bytes: Buffer, transform: ImagesTransform, output: ImagesOutputOptions) => Promise<{ type?: string; stream: ReadableStream<Uint8Array> }>;
}
async function sharpInfo(bytes: Buffer): Promise<ImagesInfo> {
  const meta = await sharp(bytes).metadata();
  return { format: `image/${meta.format}`, fileSize: bytes.length, width: meta.width, height: meta.height };
}
async function sharpRender(bytes: Buffer, t: ImagesTransform, o: ImagesOutputOptions): Promise<{ type?: string; stream: ReadableStream<Uint8Array> }> {
  const image = sharp(bytes).autoOrient().resize(t.width, t.height, t.fit === 'cover' ? { fit: 'cover', position: 'centre' } : { fit: 'contain', background: t.background });
  return { stream: streamOf(await image.webp({ quality: o.quality }).toBuffer()) };
}
function binding(fake: Fake = {}) {
  const calls: Call[] = [];
  const images: ImagesBinding = {
    async info(stream) { calls.push({ kind: 'info' }); return (fake.info ?? sharpInfo)(await read(stream)); },
    input(stream) {
      const call: Call = { kind: 'input' }; calls.push(call);
      const transformer = {
        transform(transform: ImagesTransform) { call.transform = transform; return transformer; },
        async output(output: ImagesOutputOptions) {
          call.output = output;
          const { type = 'image/webp', stream: out } = await (fake.render ?? sharpRender)(await read(stream), call.transform!, output);
          return { contentType: () => type, image: () => out };
        },
      };
      return transformer;
    },
  };
  return { images, calls };
}
const b64 = (bytes: Buffer) => bytes.toString('base64');
async function rejects(promise: Promise<unknown>, status: number, code?: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof Problem && error.status === status && (!code || error.code === code));
}
const solid = (width: number, height: number, background: string) => sharp({ create: { width, height, channels: 3, background } });
function chunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]), out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}
const cover = (images: ImagesBinding, mime: string, bytes: Buffer, timeoutMs?: number) =>
  runWithImageProcessor(createCloudflareImageProcessor(images, { timeoutMs }), () => normalizeCoverImage(mime, b64(bytes)));
let png: Buffer, jpeg: Buffer, webp: Buffer;
before(async () => {
  png = await solid(64, 48, '#c86428').png().toBuffer(); jpeg = await solid(64, 48, '#c86428').jpeg().toBuffer(); webp = await solid(64, 48, '#c86428').webp().toBuffer();
});

test('binding receives the documented transform and output options for covers and avatars', async () => {
  const { images, calls } = binding();
  const { webp: out } = await cover(images, 'image/png', png);
  assert.deepEqual(inspectCanonicalWebp(out), { width: 1200, height: 630, chunks: ['VP8 '] });
  assert.deepEqual(calls, [{ kind: 'info' }, { kind: 'input', transform: { width: 1200, height: 630, fit: 'pad', background: '#101827' }, output: { format: 'image/webp', quality: 82, anim: false } }]);
  const avatar = await createCloudflareImageProcessor(images).normalize(jpeg, { purpose: 'avatar', format: 'jpeg', maxDimension: 4096, maxPixels: 4096 ** 2, maxOutputBytes: 131072, output: { width: 256, height: 256, fit: 'cover', quality: 82, effort: 3 } });
  assert.deepEqual(inspectCanonicalWebp(avatar), { width: 256, height: 256, chunks: ['VP8 '] });
  assert.deepEqual(calls[3].transform, { width: 256, height: 256, fit: 'cover', gravity: 'center' });
});

test('sharp-backed fixture: orientation, metadata removal, alpha and padding pass the Node validators', async () => {
  const red = await solid(32, 32, '#ff0000').png().toBuffer();
  const oriented = await solid(64, 32, '#0000ff').composite([{ input: red, left: 0, top: 0 }]).jpeg({ quality: 95 })
    .withExif({ IFD0: { Artist: 'synthetic-artist' } }).withIccProfile('p3').withMetadata({ orientation: 6 }).toBuffer();
  const { webp: out } = await cover(binding().images, 'image/jpeg', oriented), meta = await sharp(out).metadata();
  for (const key of ['exif', 'icc', 'xmp', 'orientation'] as const) assert.equal(meta[key], undefined, key);
  assert.equal(out.includes('synthetic-artist'), false);
  const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
  const px = (x: number, y: number) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
  assert.ok(px(600, 100)[0] > 200 && px(600, 530)[2] > 200, 'red on top, blue on bottom');
  assert.ok(px(40, 315).every((v, i) => Math.abs(v - [0x10, 0x18, 0x27][i]) < 12), 'pad uses the canonical background');
  const alpha = await sharp({ create: { width: 30, height: 30, channels: 4, background: { r: 0, g: 255, b: 0, alpha: 0.5 } } }).png().toBuffer();
  assert.deepEqual(inspectCanonicalWebp((await cover(binding().images, 'image/png', alpha)).webp).chunks, ['VP8X', 'ALPH', 'VP8 ']);
});

test('byte-identical canonical re-encodes are accepted; the output validator is the guarantee', async () => {
  const canonical = await solid(1200, 630, '#101827').webp({ quality: 82 }).toBuffer();
  const { images } = binding({ render: async bytes => ({ stream: streamOf(bytes) }) });
  assert.ok((await cover(images, 'image/webp', canonical)).webp.equals(canonical));
  // The same echo of a non-canonical input is refused by size and chunk checks.
  await rejects(cover(images, 'image/webp', webp), 422, 'invalid_cover_image');
});

test('structural prechecks refuse truncated, animated and oversized inputs before any binding call', async () => {
  const { images, calls } = binding();
  const apng = Buffer.concat([png.subarray(0, 33), chunk('acTL', Buffer.from([0, 0, 0, 2, 0, 0, 0, 0])), png.subarray(33)]);
  const riffFixed = (() => { const out = Buffer.from(webp.subarray(0, webp.length - 10)); out.writeUInt32LE(out.length - 8, 4); return out; })();
  const cases: [string, Buffer][] = [
    ['image/png', png.subarray(0, png.length - 12)], ['image/png', Buffer.concat([png, Buffer.alloc(4)])], ['image/png', apng],
    ['image/jpeg', jpeg.subarray(0, jpeg.length - 40)], ['image/jpeg', Buffer.concat([jpeg.subarray(0, 2), jpeg.subarray(-2)])],
    ['image/webp', riffFixed], ['image/webp', webp.subarray(0, webp.length - 4)],
    ['image/png', await solid(4097, 1, 'red').png().toBuffer()], ['image/jpeg', await solid(1, 4097, 'red').jpeg().toBuffer()],
  ];
  // Extended (VP8X) WebP whose canvas is forged to differ from the coded
  // VP8/VP8L frame: a small canvas must not hide an oversized bitstream.
  const forgeCanvas = (bytes: Buffer, width: number) => { const out = Buffer.from(bytes); assert.equal(out.toString('ascii', 12, 16), 'VP8X'); out.writeUIntLE(width - 1, 24, 3); return out; };
  for (const lossless of [false, true]) {
    const extended = (width: number, height: number) => solid(width, height, 'red').withExif({ IFD0: { Artist: 'a' } }).webp({ lossless }).toBuffer();
    cases.push(['image/webp', forgeCanvas(await extended(4097, 1), 9)], ['image/webp', forgeCanvas(await extended(9, 7), 8)]);
  }
  for (const [mime, bytes] of cases) await rejects(cover(images, mime, bytes), 422, 'invalid_cover_image');
  assert.deepEqual(calls, []);
  // Legitimate inputs with metadata chunks and lossless/alpha WebP still pass the precheck.
  for (const [bytes, format] of [[await solid(9, 7, 'red').withExif({ IFD0: { Artist: 'a' } }).webp().toBuffer(), 'webp'], [await solid(9, 7, 'red').webp({ lossless: true }).toBuffer(), 'webp'],
    [await solid(9, 7, 'red').jpeg({ progressive: true }).withIccProfile('p3').toBuffer(), 'jpeg'], [png, 'png']] as const) {
    assert.ok(assertCompleteRaster(bytes, format, 4096, 1 << 24).width >= 9);
  }
});

test('info must match the declared format and bounds before transforming', async () => {
  const infos: unknown[] = [
    { format: 'image/svg+xml' }, { format: 'image/jpeg', fileSize: 1, width: 64, height: 48 }, { format: 'image/png', width: 64.5, height: 48 },
    { format: 'image/png', width: 0, height: 48 }, { format: 'image/png', width: 4097, height: 1 }, { format: 'image/png', width: 4096, height: 4097 },
    { format: 'image/png', width: '64', height: 48 }, null,
  ];
  for (const info of infos) {
    const { images, calls } = binding({ info: async () => info as ImagesInfo });
    await rejects(cover(images, 'image/png', png), 422, 'invalid_cover_image');
    assert.deepEqual(calls.map(call => call.kind), ['info'], JSON.stringify(info));
  }
});

test('non-canonical service output is refused: wrong type, size, metadata, animation, oversize', async () => {
  const exif = await sharp(await solid(1200, 630, 'red').webp().toBuffer()).withExif({ IFD0: { Artist: 'x' } }).webp().toBuffer();
  const frames = await Promise.all(['red', 'blue'].map(c => solid(1200, 630, c).png().toBuffer()));
  const animated = await sharp(frames, { join: { animated: true } }).webp({ loop: 0 }).toBuffer();
  const outputs: [string | undefined, Buffer][] = [
    ['image/png', await solid(1200, 630, 'red').webp().toBuffer()], [undefined, await solid(1200, 630, 'red').png().toBuffer()], [undefined, png],
    [undefined, await solid(1199, 630, 'red').webp().toBuffer()], [undefined, exif], [undefined, animated], [undefined, Buffer.alloc(0)],
  ];
  for (const [type, bytes] of outputs) await rejects(cover(binding({ render: async () => ({ type, stream: streamOf(bytes) }) }).images, 'image/png', png), 422, 'invalid_cover_image');
});

function endless(chunk: Uint8Array | string, onCancel: () => void, stall = false) {
  return new ReadableStream<Uint8Array>({
    async pull(controller) { if (stall) return new Promise<void>(() => {}); controller.enqueue(chunk as Uint8Array); },
    cancel() { onCancel(); },
  }, { highWaterMark: 0 });
}

test('output stream is capped per purpose and cancelled; stalls and hangs time out as 503', async () => {
  let cancelled = 0;
  const big = new Uint8Array(64 * 1024);
  await rejects(cover(binding({ render: async () => ({ stream: endless(big, () => cancelled++) }) }).images, 'image/png', png), 422, 'invalid_cover_image');
  assert.equal(cancelled, 1);
  await rejects(cover(binding({ render: async () => ({ stream: endless('not bytes', () => cancelled++) }) }).images, 'image/png', png), 422, 'invalid_cover_image');
  assert.equal(cancelled, 2);
  const started = Date.now();
  await rejects(cover(binding({ render: async () => ({ stream: endless(big, () => cancelled++, true) }) }).images, 'image/png', png, 50), 503, 'image_processing_unavailable');
  assert.equal(cancelled, 3);
  await rejects(cover(binding({ info: () => new Promise(() => {}) }).images, 'image/png', png, 50), 503, 'image_processing_unavailable');
  await rejects(cover(binding({ render: () => new Promise(() => {}) }).images, 'image/png', png, 50), 503, 'image_processing_unavailable');
  assert.ok(Date.now() - started < 2000, 'timeouts are bounded');
});

test('errors: documented not-an-image is 422; other binding and runtime failures are 503; missing binding fails closed', async () => {
  const imagesError = (code: number) => Object.assign(new Error(`IMAGES_ERROR ${code}`), { code });
  await rejects(cover(binding({ info: async () => { throw imagesError(9412); } }).images, 'image/png', png), 422, 'invalid_cover_image');
  for (const error of [imagesError(9523), imagesError(9999), new TypeError('binding gone'), new Error('network')]) {
    await rejects(cover(binding({ info: async () => { throw error; } }).images, 'image/png', png), 503, 'image_processing_unavailable');
    await rejects(cover(binding({ render: async () => { throw error; } }).images, 'image/png', png), 503, 'image_processing_unavailable');
  }
  const syncThrow = { info: sharpInfoStream, input() { throw new Error('sync'); } } as unknown as ImagesBinding;
  await rejects(cover(syncThrow, 'image/png', png), 503, 'image_processing_unavailable');
  for (const missing of [undefined, {} as ImagesBinding]) await rejects(cover(missing as ImagesBinding, 'image/png', png), 503, 'image_processing_unavailable');
});
async function sharpInfoStream(stream: ReadableStream<Uint8Array>) { return sharpInfo(await read(stream)); }

test('interleaved requests keep their own binding', async () => {
  const fixtures = Array.from({ length: 6 }, (_, i) => binding({ render: async (bytes, t, o) => { await sleep((i * 5) % 7); return sharpRender(bytes, t, o); } }));
  const outputs = await Promise.all(fixtures.map(({ images }, i) => cover(images, 'image/png', i % 2 ? png : Buffer.from(png))));
  assert.ok(outputs.every(({ webp: out }) => inspectCanonicalWebp(out).width === 1200));
  fixtures.forEach(({ calls }) => assert.deepEqual(calls.map(call => call.kind), ['info', 'input']));
});

// Avatar route: real app, fresh isolated schema on the local test database.
const origin = 'http://127.0.0.1:4310', databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_image_cloudflare_test_${process.pid}_${Date.now()}`, admin = createPool(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 8 });
const app = createApp(pool, origin);
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(async () => { await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE'); await seedLocal(pool); });

test('avatar route stores binding output, and stores nothing on binding failure', async () => {
  const response = await app.request(origin + '/api/v1/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ email: DEMO_USERS[0].email, password: DEMO_PASSWORD }) });
  const data = await response.json() as any, cookie = response.headers.get('set-cookie')!.split(';')[0];
  const upload = (images: ImagesBinding, version: number) => runWithImageProcessor(createCloudflareImageProcessor(images), () => app.request(origin + '/api/v1/me/avatar', { method: 'POST',
    headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': data.csrf_token, 'Content-Type': 'image/png', 'Idempotency-Key': randomUUID(), 'If-Match': `"${version}"` }, body: new Uint8Array(png) }));
  const stored = async () => ((await pool.query('SELECT image_bytes FROM member_avatars WHERE user_id=$1', [data.user.user_id])).rows[0]?.image_bytes ?? null) as Buffer | null;
  const failed = await upload(binding({ info: async () => { throw new TypeError('binding gone'); } }).images, 1);
  assert.equal(failed.status, 503); assert.equal((await failed.json() as any).code, 'image_processing_unavailable');
  assert.equal(await stored(), null);
  const ok = await upload(binding().images, 1);
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.deepEqual(inspectCanonicalWebp((await stored())!), { width: 256, height: 256, chunks: ['VP8 '] });
});
