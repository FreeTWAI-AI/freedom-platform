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
import { nodeImageProcessor } from '../../packages/shared/image-node.js';
import unavailableSharp from '../../packages/shared/sharp-unavailable.js';
import { createUnavailableImageProcessor, currentImageProcessor, runWithImageProcessor, type ImageNormalizeSpec, type ImageProcessor } from '../../packages/shared/image-runtime.js';
import { normalizeCoverImage, normalizeSubmission } from '../../modules/skill-submissions/payload.js';

// Synthetic fixtures only. Node evidence uses real sharp/libvips; fake
// processors prove the shared guards, not Cloudflare production transforms.
const solid = (width: number, height: number, background: string) => sharp({ create: { width, height, channels: 3, background } });
function chunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]), out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}
// Inserts a chunk right after IHDR (8-byte signature + 25-byte IHDR chunk).
const withPngChunk = (png: Buffer, type: string, data: Buffer) => Buffer.concat([png.subarray(0, 33), chunk(type, data), png.subarray(33)]);
const b64 = (bytes: Buffer) => bytes.toString('base64');
async function rejects(promise: Promise<unknown>, status: number, code?: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof Problem && error.status === status && (!code || error.code === code));
}
function recording(inner: ImageProcessor = nodeImageProcessor, delay = 0) {
  const calls: { spec: ImageNormalizeSpec; bytes: Buffer }[] = [];
  const processor: ImageProcessor = { name: 'recording', async normalize(bytes, spec) { calls.push({ spec, bytes }); if (delay) await sleep(delay); return inner.normalize(bytes, spec); } };
  return { processor, calls };
}
const fixed = (output: unknown): ImageProcessor => ({ name: 'fixed', normalize: async () => output as Buffer });
const riff = (size: number) => { const out = Buffer.alloc(size); out.write('RIFF', 0, 'ascii'); out.writeUInt32LE(size - 8, 4); out.write('WEBP', 8, 'ascii'); return out; };
let png: Buffer, jpeg: Buffer;
before(async () => { png = await solid(64, 48, '#c86428').png().toBuffer(); jpeg = await solid(64, 48, '#c86428').jpeg().toBuffer(); });

test('Node sharp processor rejects truncated and corrupt inputs after the signature checks pass', async () => {
  await rejects(normalizeCoverImage('image/jpeg', b64(jpeg.subarray(0, Math.floor(jpeg.length * 0.6)))), 422, 'invalid_cover_image');
  const idat = png.indexOf('IDAT'), corrupt = Buffer.from(png), length = corrupt.readUInt32BE(idat - 4);
  corrupt[idat + 4] ^= 0xff; corrupt[idat + 5] ^= 0xff; // Break the zlib header, then fix the CRC so only decoding fails.
  corrupt.writeUInt32BE(crc32(corrupt.subarray(idat, idat + 4 + length)), idat + 4 + length);
  await rejects(normalizeCoverImage('image/png', b64(corrupt)), 422, 'invalid_cover_image');
  const webp = await solid(64, 48, '#c86428').webp().toBuffer();
  await rejects(normalizeCoverImage('image/webp', b64(webp.subarray(0, webp.length - 20))), 422, 'invalid_cover_image');
  assert.equal((await normalizeCoverImage('image/png', b64(png))).webp.subarray(8, 12).toString('ascii'), 'WEBP');
});

test('Node sharp processor applies EXIF orientation and strips EXIF, GPS, comments and ICC', async () => {
  const red = await solid(32, 32, '#ff0000').png().toBuffer();
  // Stored landscape (red left, blue right); orientation 6 displays portrait with red on top.
  const oriented = await solid(64, 32, '#0000ff').composite([{ input: red, left: 0, top: 0 }]).jpeg({ quality: 95 })
    .withExif({ IFD0: { Artist: 'synthetic-artist' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '25/1 2/1 0/1' } }).withIccProfile('p3').withMetadata({ orientation: 6 }).toBuffer();
  const input = await sharp(oriented).metadata(), gpsPointer = (exif: Buffer) => exif.includes(Buffer.from([0x88, 0x25])) || exif.includes(Buffer.from([0x25, 0x88]));
  assert.equal(input.orientation, 6); assert.ok(input.exif && input.icc && gpsPointer(input.exif), 'fixture carries EXIF with a GPS IFD and ICC');
  const withComment = Buffer.concat([oriented.subarray(0, 2), Buffer.from([0xff, 0xfe, 0, 19]), Buffer.from('synthetic-comment'), oriented.subarray(2)]);
  const { webp } = await normalizeCoverImage('image/jpeg', b64(withComment)), meta = await sharp(webp).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ['webp', 1200, 630]);
  for (const key of ['exif', 'icc', 'xmp', 'iptc', 'comments', 'orientation'] as const) assert.equal(meta[key], undefined, key);
  // No EXIF/XMP/ICCP chunk at all means the GPS IFD cannot survive either.
  for (const secret of ['synthetic-artist', 'synthetic-comment', 'EXIF', 'XMP ', 'ICCP']) assert.equal(webp.includes(secret), false, secret);
  const { data, info } = await sharp(webp).raw().toBuffer({ resolveWithObject: true });
  const pixel = (x: number, y: number) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
  const near = (actual: number[], expected: number[]) => actual.every((value, i) => Math.abs(value - expected[i]) < 40);
  assert.ok(near(pixel(600, 100), [255, 0, 0]), `top should be red: ${pixel(600, 100)}`);
  assert.ok(near(pixel(600, 530), [0, 0, 255]), `bottom should be blue: ${pixel(600, 530)}`);
  assert.ok(near(pixel(60, 315), [0x10, 0x18, 0x27]), 'contain pads with the canonical background');
  const pngComment = withPngChunk(png, 'tEXt', Buffer.from('Comment\0synthetic-png-comment'));
  assert.equal((await normalizeCoverImage('image/png', b64(pngComment))).webp.includes('synthetic-png-comment'), false);
});

test('shared checks reject APNG, animated WebP, mislabels and oversize before any processor runs', async () => {
  const { processor, calls } = recording(createUnavailableImageProcessor());
  const frames = await Promise.all(['red', 'blue'].map(background => solid(8, 8, background).png().toBuffer()));
  const animated = await sharp(frames, { join: { animated: true } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
  const apng = withPngChunk(png, 'acTL', Buffer.from([0, 0, 0, 2, 0, 0, 0, 0]));
  await runWithImageProcessor(processor, async () => {
    await rejects(normalizeCoverImage('image/png', b64(apng)), 422, 'invalid_cover_image');
    await rejects(normalizeCoverImage('image/webp', b64(animated)), 422, 'invalid_cover_image');
    await rejects(normalizeCoverImage('image/jpeg', b64(png)), 422, 'invalid_cover_image');
    await rejects(normalizeCoverImage('image/png', b64(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))), 422, 'invalid_cover_image');
    await rejects(normalizeCoverImage('image/png', b64(Buffer.concat([png, Buffer.alloc(512 * 1024)]))), 413, 'cover_image_too_large');
  });
  assert.equal(calls.length, 0);
});

test('Node processor enforces dimension and pixel limits from the frozen spec', async () => {
  await rejects(normalizeCoverImage('image/png', b64(await solid(4097, 1, 'red').png().toBuffer())), 422, 'invalid_cover_image');
  const spec: ImageNormalizeSpec = { purpose: 'skill_cover', format: 'png', maxDimension: 4096, maxPixels: 64 * 48 - 1, output: { width: 16, height: 16, fit: 'cover', quality: 82, effort: 3 } };
  await assert.rejects(nodeImageProcessor.normalize(png, spec));
  await assert.rejects(nodeImageProcessor.normalize(png, { ...spec, maxPixels: 1 << 20, maxDimension: 63 }));
  await assert.rejects(nodeImageProcessor.normalize(png, { ...spec, maxPixels: 1 << 20, format: 'jpeg' }));
  assert.equal((await sharp(await nodeImageProcessor.normalize(png, { ...spec, maxPixels: 64 * 48 })).metadata()).width, 16);
});

test('processor output is re-checked: originals, non-WebP, oversize and thrown errors never pass', async () => {
  const webp = await solid(64, 48, '#c86428').webp().toBuffer();
  const cases: [ImageProcessor, string, Buffer, number][] = [
    [fixed(png), 'image/png', png, 422], // raw original of another format
    [fixed(webp), 'image/webp', webp, 422], // raw original WebP echoed back
    [fixed(Buffer.from(webp)), 'image/webp', webp, 422],
    [fixed(riff(600 * 1024)), 'image/png', png, 422], // over the cover output limit
    [fixed(Buffer.concat([riff(64), Buffer.alloc(4)])), 'image/png', png, 422], // RIFF size mismatch
    [fixed(new Uint8Array(riff(64))), 'image/png', png, 422], // not a Buffer
    [fixed(Buffer.alloc(0)), 'image/png', png, 422],
    [{ name: 'throws', normalize: async () => { throw new Error('decoder crashed'); } }, 'image/png', png, 422],
    [createUnavailableImageProcessor(), 'image/png', png, 503],
  ];
  for (const [processor, mime, bytes, status] of cases) await runWithImageProcessor(processor, () => rejects(normalizeCoverImage(mime, b64(bytes)), status));
  const accepted = await runWithImageProcessor(fixed(riff(64)), () => normalizeCoverImage('image/png', b64(png)));
  assert.equal(accepted.webp.length, 64); assert.ok(accepted.original.equals(png));
  await assert.rejects(Promise.resolve().then(() => runWithImageProcessor({} as ImageProcessor, () => 1)), TypeError);
  assert.throws(() => unavailableSharp(), (error: unknown) => error instanceof Problem && error.status === 503);
});

test('processors get a frozen spec and a private copy of the input bytes', async () => {
  let seen: ImageNormalizeSpec | undefined;
  const tamper: ImageProcessor = { name: 'tamper', async normalize(bytes, spec) {
    seen = spec; bytes.fill(0);
    assert.throws(() => { (spec as any).maxPixels = 1e12; }, TypeError);
    assert.throws(() => { (spec.output as any).width = 1; }, TypeError);
    return nodeImageProcessor.normalize(Buffer.from(png), spec);
  } };
  const tampered = await runWithImageProcessor(tamper, () => normalizeCoverImage('image/png', b64(png)));
  assert.ok(tampered.original.equals(png));
  assert.deepEqual(seen, { purpose: 'skill_cover', format: 'png', maxDimension: 4096, maxPixels: 16_777_216, output: { width: 1200, height: 630, fit: 'contain', background: '#101827', quality: 82, effort: 4 } });
});

test('processor scope is request-local across interleaved async work and restores the Node default', async () => {
  assert.equal(currentImageProcessor(), nodeImageProcessor);
  const scopes = Array.from({ length: 12 }, (_, i) => ({ name: `p${i}`, normalize: nodeImageProcessor.normalize }) as ImageProcessor);
  const observed = await Promise.all(scopes.map((processor, i) => runWithImageProcessor(processor, async () => {
    const seen: ImageProcessor[] = [];
    for (let step = 0; step < 4; step++) { await sleep((i * 7 + step * 3) % 5); seen.push(currentImageProcessor()); await Promise.resolve(); }
    await new Promise<void>(resolve => setImmediate(() => { seen.push(currentImageProcessor()); resolve(); }));
    const nested = await runWithImageProcessor(scopes[(i + 1) % scopes.length], async () => { await sleep(1); return currentImageProcessor(); });
    seen.push(currentImageProcessor());
    return { seen, nested };
  })));
  observed.forEach(({ seen, nested }, i) => { assert.ok(seen.every(value => value === scopes[i]), `scope ${i}`); assert.equal(nested, scopes[(i + 1) % scopes.length]); });
  assert.equal(currentImageProcessor(), nodeImageProcessor);
});

test('fail-closed processor keeps submissions without a cover working and refuses covers', async () => {
  const payload = (extra: Record<string, unknown> = {}) => ({ repository_url: 'https://github.com/example/project', title: '共同筆記技能', description: '把會議紀錄整理成可重用的筆記。', use_notes: '先閱讀 README，再在自己的 fork 試用。', demo_url: null, relationship: 'author', share_introductions: Array.from({ length: 100 }, (_, i) => `第 ${i + 1} 則介紹：這個技能幫助團隊整理共同筆記`), ...extra });
  await runWithImageProcessor(createUnavailableImageProcessor(), async () => {
    const plain = await normalizeSubmission(payload());
    assert.equal(plain.image, null);
    await rejects(normalizeSubmission(payload({ cover_image: { mime_type: 'image/png', data_base64: b64(png) } })), 503, 'image_processing_unavailable');
    await rejects(normalizeSubmission(payload({ cover_image: { mime_type: 'image/jpeg', data_base64: b64(png) } })), 422, 'invalid_cover_image');
  });
  assert.ok((await normalizeSubmission(payload({ cover_image: { mime_type: 'image/png', data_base64: b64(png) } }))).image);
});

// Avatar route: real app, fresh isolated schema on the local test database.
const origin = 'http://127.0.0.1:4310', databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_image_runtime_test_${process.pid}_${Date.now()}`, admin = createPool(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 12 });
const app = createApp(pool, origin);
type Session = { cookie: string; csrf: string; userId: string };
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(async () => { await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE'); await seedLocal(pool); });
async function login(email: string): Promise<Session> {
  const response = await app.request(origin + '/api/v1/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ email, password: DEMO_PASSWORD }) });
  const data = await response.json() as any; assert.equal(response.status, 200);
  return { cookie: response.headers.get('set-cookie')!.split(';')[0], csrf: data.csrf_token, userId: data.user.user_id };
}
async function upload(session: Session, bytes: Buffer, mime = 'image/png') {
  const response = await app.request(origin + '/api/v1/me/avatar', { method: 'POST', headers: { Origin: origin, Cookie: session.cookie, 'X-CSRF-Token': session.csrf, 'Content-Type': mime, 'Idempotency-Key': randomUUID(), 'If-Match': '"1"' }, body: new Uint8Array(bytes) });
  return { status: response.status, data: await response.json() as any };
}
// A refused upload rolls back, so there is no row or a NULL image.
const stored = async (userId: string) => ((await pool.query('SELECT image_bytes FROM member_avatars WHERE user_id=$1', [userId])).rows[0]?.image_bytes ?? null) as Buffer | null;

test('concurrent avatar requests each use only their own processor; fail-closed stores nothing', async () => {
  const [nodeUser, closedUser, recordedUser] = await Promise.all(DEMO_USERS.slice(0, 3).map(user => login(user.email)));
  const red = await solid(32, 32, '#ff0000').png().toBuffer();
  const oriented = await solid(64, 32, '#0000ff').composite([{ input: red, left: 0, top: 0 }]).jpeg().withExif({ IFD0: { Artist: 'synthetic-artist' } }).withMetadata({ orientation: 6 }).toBuffer();
  const { processor, calls } = recording(nodeImageProcessor, 30);
  const [viaNode, viaClosed, viaRecorded] = await Promise.all([
    upload(nodeUser, png),
    runWithImageProcessor(createUnavailableImageProcessor(), () => upload(closedUser, png)),
    runWithImageProcessor(processor, () => upload(recordedUser, oriented, 'image/jpeg')),
  ]);
  assert.equal(viaNode.status, 200, JSON.stringify(viaNode.data)); assert.equal(viaRecorded.status, 200, JSON.stringify(viaRecorded.data));
  assert.equal(viaClosed.status, 503); assert.equal(viaClosed.data.code, 'image_processing_unavailable');
  assert.equal(calls.length, 1); assert.equal(calls[0].spec.purpose, 'avatar'); assert.ok(calls[0].bytes.equals(oriented));
  assert.equal(await stored(closedUser.userId), null);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM transition_journal WHERE aggregate_type='member_avatar' AND aggregate_id=$1", [closedUser.userId])).rows[0].n, 0);
  const avatar = (await stored(recordedUser.userId))!, meta = await sharp(avatar).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height, meta.exif], ['webp', 256, 256, undefined]); assert.equal(avatar.includes('synthetic-artist'), false);
  const { data, info } = await sharp(avatar).raw().toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number) => data[(y * info.width + x) * info.channels + 0] > 200 && data[(y * info.width + x) * info.channels + 2] < 60;
  assert.ok(at(128, 40) && !at(128, 215), 'orientation 6 puts red on top of the avatar');
  // Invalid bytes keep their Node status in the fail-closed scope.
  const closed = createUnavailableImageProcessor(), animated = await sharp(await Promise.all(['red', 'blue'].map(c => solid(8, 8, c).png().toBuffer())), { join: { animated: true } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
  assert.equal((await runWithImageProcessor(closed, () => upload(closedUser, animated, 'image/webp'))).status, 422);
  assert.equal((await runWithImageProcessor(closed, () => upload(closedUser, png, 'image/jpeg'))).status, 422);
  assert.equal((await runWithImageProcessor(closed, () => upload(closedUser, Buffer.alloc(2 * 1024 * 1024 + 1)))).status, 413);
  assert.equal((await runWithImageProcessor(fixed(png), () => upload(closedUser, png))).status, 422);
  assert.equal((await runWithImageProcessor(fixed(riff(131073)), () => upload(closedUser, png))).status, 422);
  assert.equal(await stored(closedUser.userId), null);
});
