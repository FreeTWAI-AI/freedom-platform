import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import type { Pool } from 'pg';
import { createPublicGuideAssets, GUIDE_CACHE_CONTROL, GUIDE_MAX_MANIFEST_BYTES, guideAssetPath, guideSha256,
  parseGuideManifest, webpDimensions, type GuideManifest, type GuideReadObject } from '../../packages/public-guide-assets/index.js';
import { createR2GuideReader } from '../../packages/public-guide-assets/r2.js';
import { createLocalGuideAssets } from '../../packages/public-guide-assets/node.js';
import { dragonManifestText } from '../../packages/public-guide-assets/dragon-manifest.generated.js';
import { DRAGON_GUIDE_RELEASE } from '../../packages/public-guide-assets/release.js';
import { installWorkerGuideAssets } from '../../packages/public-guide-assets/worker.js';
import { createApp, nodeRuntime } from '../../apps/platform-api/src/app.js';
import { mountAssets, readWorkerConfig } from '../../apps/platform-api/src/worker.js';
import { guidePublishPlan } from '../../scripts/guide-pack-publish-plan.js';
const origin = 'http://127.0.0.1:4310';
async function fixture() {
  const bytes = await sharp({ create: { width: 2, height: 3, channels: 4, background: '#223344' } }).webp().toBuffer();
  const digest = await guideSha256(bytes);
  const manifest: GuideManifest = { schema: 'freedom.guide-pack/v1', pack: 'dragon', version: 'dragon-v1-20261004', purpose: 'platform-public',
    source: { repository: 'https://github.com/example/fixture', commit: 'a'.repeat(40) },
    assets: [{ logicalId: 'home/portrait', sha256: digest, byteLength: bytes.length, mime: 'image/webp', width: 2, height: 3 }] };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest)), expectedSha256 = await guideSha256(manifestBytes);
  const object = (content: Uint8Array = bytes): GuideReadObject => ({ byteLength: bytes.length, mime: 'image/webp',
    body: new ReadableStream({ start(controller) { controller.enqueue(content); controller.close(); } }) });
  const service = (read = async () => object()) => createPublicGuideAssets({ manifestBytes, expectedSha256, reader: () => ({ readDigest: read }) });
  return { bytes, digest, manifest, manifestBytes, expectedSha256, object, service, path: guideAssetPath(manifest, manifest.assets[0]!) };
}
const pool = { query() { throw Error('guide route must not query member/private data'); } } as unknown as Pool;

test('guide exact manifest pin, schema, logical identity and declared bounds reject tampering', async () => {
  const f = await fixture(); assert.equal((await parseGuideManifest(f.manifestBytes, f.expectedSha256)).assets.length, 1);
  await assert.rejects(parseGuideManifest(new TextEncoder().encode(new TextDecoder().decode(f.manifestBytes) + '\n'), f.expectedSha256));
  for (const change of [
    (m: any) => { m.unexpected = 'data'; }, (m: any) => { m.source.token = 'secret'; },
    (m: any) => { m.purpose = 'member-private'; }, (m: any) => { m.assets[0].mime = 'image/svg+xml'; },
    (m: any) => { m.assets[0].logicalId = '../secrets'; }, (m: any) => { m.assets[0].url = 'https://evil.test'; },
    (m: any) => { m.assets[0].width = 5000; }, (m: any) => { m.assets[0].byteLength = 2 * 1024 * 1024 + 1; },
    (m: any) => { m.assets.push(m.assets[0]); }, (m: any) => { m.source.commit = 'main'; },
  ]) {
    const m = structuredClone(f.manifest); change(m); const bytes = new TextEncoder().encode(JSON.stringify(m));
    await assert.rejects(parseGuideManifest(bytes, await guideSha256(bytes)));
  }
  const huge = new Uint8Array(GUIDE_MAX_MANIFEST_BYTES + 1); await assert.rejects(parseGuideManifest(huge, await guideSha256(huge)));
});
test('same-byte logical aliases deduplicate paths only when immutable metadata agrees', async () => {
  const f = await fixture(); f.manifest.assets.push({ ...f.manifest.assets[0]!, logicalId: 'home/hero' });
  let bytes = new TextEncoder().encode(JSON.stringify(f.manifest));
  assert.equal((await parseGuideManifest(bytes, await guideSha256(bytes))).assets.length, 2);
  f.manifest.assets[1]!.width = 4; bytes = new TextEncoder().encode(JSON.stringify(f.manifest));
  await assert.rejects(parseGuideManifest(bytes, await guideSha256(bytes)));
});
test('successful exact GET and HEAD validate actual bytes then return explicit immutable public cache', async () => {
  const f = await fixture(); let reads = 0; const service = await f.service(async () => { reads++; return f.object(); });
  for (const method of ['GET', 'HEAD']) {
    const response = await service.fetch(new Request(origin + f.path, { method }));
    assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), GUIDE_CACHE_CONTROL);
    assert.equal(response.headers.get('Content-Type'), 'image/webp'); assert.equal(response.headers.get('Content-Length'), String(f.bytes.length));
    assert.equal(response.headers.get('Cross-Origin-Resource-Policy'), 'same-origin'); assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal((await response.arrayBuffer()).byteLength, method === 'HEAD' ? 0 : f.bytes.length);
  }
  assert.equal(reads, 2);
});
test('unknown versions/digests/extensions/query/ranges/methods refuse before touching storage', async () => {
  const f = await fixture(); const service = await f.service(async () => { throw Error('unexpected storage'); });
  for (const path of ['/public/guide-packs', '/public/guide-packs/', '/public/guide-packs/private/key', f.path.replace('dragon-v1', 'dragon-v2'),
    f.path.replace(f.digest, 'b'.repeat(64)), f.path.replace('.webp', '.svg'), f.path + '?url=https://evil.test', f.path + '/extra']) {
    const response = await service.fetch(new Request(origin + path)); assert.equal(response.status, 404); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) assert.equal((await service.fetch(new Request(origin + f.path, { method }))).status, 404);
  assert.equal((await service.fetch(new Request(origin + f.path, { headers: { Range: 'bytes=0-1' } }))).status, 404);
});
test('corrupt/truncated/oversized/wrong-MIME/wrong-dimensions streams never yield cacheable success, including HEAD', async () => {
  const f = await fixture(); const corrupt = Uint8Array.from(f.bytes); corrupt[corrupt.length - 1]! ^= 1;
  for (const read of [() => f.object(corrupt), () => f.object(f.bytes.subarray(0, -1)), () => f.object(new Uint8Array(f.bytes.length + 1)),
    () => ({ ...f.object(), mime: 'image/svg+xml' }), () => ({ ...f.object(), byteLength: 9 }),
    () => ({ ...f.object(), body: new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array()); } }) }),
    () => ({ ...f.object(), body: new ReadableStream<Uint8Array>({ start(c) { c.error(Error('SECRET')); } }) }),
  ]) {
    const service = await f.service(async () => read());
    for (const method of ['GET', 'HEAD']) {
      const response = await service.fetch(new Request(origin + f.path, { method }));
      assert.equal(response.status, 503); assert.equal(response.headers.get('Cache-Control'), 'no-store'); assert.equal(await response.text(), '');
    }
  }
  f.manifest.assets[0]!.width = 4; const manifestBytes = new TextEncoder().encode(JSON.stringify(f.manifest));
  const service = await createPublicGuideAssets({ manifestBytes, expectedSha256: await guideSha256(manifestBytes), reader: () => ({ readDigest: async () => f.object() }) });
  assert.equal((await service.fetch(new Request(origin + f.path))).status, 503);
  assert.throws(() => webpDimensions(new TextEncoder().encode('<svg onload="evil"/>')));
});
test('platform middleware preserves validated cache override and terminal failures never fall through to SPA', async () => {
  const f = await fixture(), assets = await f.service(); const app = createApp(pool, origin, 'local', { publicGuideAssets: assets });
  let fallback = 0; mountAssets(app, { async fetch() { fallback++; return new Response('<html>shell</html>'); } });
  const good = await app.request(origin + f.path); assert.equal(good.status, 200); assert.equal(good.headers.get('Cache-Control'), GUIDE_CACHE_CONTROL);
  for (const path of [f.path.replace('.webp', '.js'), '/public/guide-packs', '/public/guide-packs/dragon/private','/public/guide-packs%2fdragon/x.webp','/public%2fguide-packs/dragon/x.webp','/public/guide-packs%5cdragon/x.webp','/public/guide-packs%ZZ']) {
    for (const method of ['GET', 'HEAD', 'POST']) {
      const response = await app.request(origin + path, { method }); assert.equal(response.status, 404); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
  }
  const rejectedHost = await app.request('http://evil.test' + f.path); assert.equal(rejectedHost.status, 403); assert.equal(rejectedHost.headers.get('Cache-Control'), 'no-store');
  const release = await app.request(origin + '/api/v1/guide-packs/release'); assert.equal(release.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await release.json(), assets.release); assert.equal(fallback, 0);
});
test('production and default Node guide release stay OFF, independent of native bucket availability and flags', async () => {
  const app = createApp(pool, origin); assert.deepEqual(await (await app.request(origin + '/api/v1/guide-packs/release')).json(), { enabled: false });
  assert.equal((await app.request(origin + '/public/guide-packs/anything')).status, 404);
  assert.equal(DRAGON_GUIDE_RELEASE.enabled, false); assert.equal(DRAGON_GUIDE_RELEASE.publisherReceipt, null);
  assert.equal(await installWorkerGuideAssets({ FREEDOM_PUBLIC_GUIDE_ENABLED: 'true', GUIDE_STATIC: { get() { throw Error('must remain OFF'); } } as any }), undefined);
  const f = await fixture(), assets = await f.service();
  assert.throws(() => nodeRuntime('public', 'https://freetwai.com', { publicGuideAssets: assets }), /requires_local/);
  const env = { FREEDOM_ENV: 'local', APP_ORIGIN: origin, HYPERDRIVE: { connectionString: 'local-fixture' }, ASSETS: { fetch: async () => new Response() } };
  const shared = { get() {} } as any;
  assert.throws(() => readWorkerConfig({ ...env, MEDIA: shared, GUIDE_STATIC: shared }));
  assert.throws(() => readWorkerConfig({ ...env, FREEDOM_PUBLIC_GUIDE_ENABLED: 'true' }));
});
test('R2 read adapter only resolves release-listed digests and rejects forged key/metadata/ranges', async () => {
  const f = await fixture(); let key = '';
  const reader = createR2GuideReader({ get: async (value: string) => { key = value; return null; } } as any, f.manifest);
  assert.deepEqual(Object.keys(reader), ['readDigest']); await assert.rejects(reader.readDigest('arbitrary/key')); assert.equal(key, '');
  assert.equal(await reader.readDigest(f.digest), null); assert.equal(key, `guide-packs/dragon/${f.manifest.version}/${f.digest}.webp`);
  for (const overrides of [{ key: 'member/private' }, { size: 1 }, { range: { offset: 0, length: f.bytes.length - 1 } }, { httpMetadata: { contentType: 'text/html' } }]) {
    const object = { key, size: f.bytes.length, httpMetadata: { contentType: 'image/webp' }, body: f.object().body, ...overrides };
    await assert.rejects(createR2GuideReader({ get: async () => object } as any, f.manifest).readDigest(f.digest));
  }
});
test('local fixture path enforces local mode, exact bounded bytes and no symlink alias', async () => {
  const f = await fixture(), root = await mkdtemp(join(tmpdir(), 'fp-guide-test-'));
  try {
    await mkdir(join(root, 'home')); await writeFile(join(root, 'home/portrait.webp'), f.bytes);
    const options = { freedomEnv: 'local', fixtureDirectory: root, manifestBytes: f.manifestBytes, expectedSha256: f.expectedSha256 };
    await assert.rejects(createLocalGuideAssets({ ...options, freedomEnv: 'public' }));
    const service = await createLocalGuideAssets(options); assert.equal((await service.fetch(new Request(origin + f.path))).status, 200);
    await rm(join(root, 'home/portrait.webp')); await writeFile(join(root, 'other.webp'), f.bytes); await symlink(join(root, 'other.webp'), join(root, 'home/portrait.webp'));
    assert.equal((await service.fetch(new Request(origin + f.path))).status, 503);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('committed release bytes match detached pin and embedded Worker literal with no self-hash', async () => {
  const bytes = await readFile('contracts/guide-packs/dragon-v1-20261004.json');
  assert.equal(bytes.toString('utf8'), dragonManifestText); const manifest = await parseGuideManifest(bytes, DRAGON_GUIDE_RELEASE.manifestSha256);
  assert.equal(manifest.assets.length, 364); assert.equal(manifest.source.commit, '46a40342509a9278c3a7b8a940bce27b7f464227');
  assert(!Object.hasOwn(manifest, 'manifestSha256')); assert.equal(manifest.version, DRAGON_GUIDE_RELEASE.version);
});
test('plan publisher verifies every committed fixture actual digest, decode, MIME and dimensions without publication', async () => {
  const plan = await guidePublishPlan('assets/guide-packs/dragon-v1-20261004');
  assert.equal(plan.status, 'verified_local_plan'); assert.equal(plan.object_count, 364); assert.equal(plan.total_bytes, 41_016_186);
  assert.equal(plan.provider_mutations, 0); assert.equal(plan.production_enabled, false); assert.equal(plan.publisher_receipts, 'not_run');
  assert(plan.unique_object_count < plan.object_count); assert.equal(plan.binding, 'GUIDE_STATIC');
});
