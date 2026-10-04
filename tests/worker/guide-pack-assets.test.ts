import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import sharp from 'sharp';
import { guideSha256, GUIDE_CACHE_CONTROL, type GuideManifest } from '../../packages/public-guide-assets/index.js';

// Actual local workerd + its native private R2; no cloud credentials, publisher
// receipts, live bindings or production release override. The harness injects a
// synthetic manifest and uses exactly the production read/validation path.
test('native workerd GUIDE_STATIC verifies bytes for GET/HEAD and isolates private MEDIA', async () => {
  const bytes = await sharp({ create: { width: 3, height: 2, channels: 4, background: '#336699' } }).webp().toBuffer();
  const digest = await guideSha256(bytes), version = 'dragon-v1-20261004';
  const manifest: GuideManifest = { schema: 'freedom.guide-pack/v1', pack: 'dragon', version, purpose: 'platform-public',
    source: { repository: 'https://github.com/example/fixture', commit: 'a'.repeat(40) },
    assets: [{ logicalId: 'home/portrait', sha256: digest, byteLength: bytes.length, mime: 'image/webp', width: 3, height: 2 }] };
  const text = JSON.stringify(manifest), pin = await guideSha256(new TextEncoder().encode(text));
  const contents = `
    import {createPublicGuideAssets} from './packages/public-guide-assets/index.ts';
    import {createR2GuideReader} from './packages/public-guide-assets/r2.ts';
    export default {async fetch(request,env){
      const service=await createPublicGuideAssets({manifestBytes:new TextEncoder().encode(${JSON.stringify(text)}),expectedSha256:${JSON.stringify(pin)},
        reader:manifest=>createR2GuideReader(env.GUIDE_STATIC,manifest)});
      return service.fetch(request);
    }};`;
  const bundle = await build({ stdin: { contents, resolveDir: resolve('.'), sourcefile: 'local-guide-harness.ts', loader: 'ts' },
    write: false, bundle: true, format: 'esm', platform: 'neutral', conditions: ['workerd', 'worker', 'browser'] });
  const script = bundle.outputFiles[0]!.text; assert(!/from ["']node:/.test(script));
  let mf: Miniflare | undefined;
  try {
    mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'fp-guide-assets-test', modules: true, script,
      compatibilityDate: '2026-09-21', r2Buckets: ['GUIDE_STATIC', 'MEDIA'] }] }));
    await mf.ready;
    const guide = await mf.getR2Bucket('GUIDE_STATIC'), media = await mf.getR2Bucket('MEDIA');
    const key = `guide-packs/dragon/${version}/${digest}.webp`, url = `https://guide.test/public/${key}`;
    await media.put(key, bytes, { httpMetadata: { contentType: 'image/webp' } });
    assert.equal((await mf.dispatchFetch(url)).status, 404, 'MEDIA never supplies guide bytes');
    await guide.put(key, bytes, { httpMetadata: { contentType: 'image/webp' } });
    for (const method of ['GET', 'HEAD']) {
      const response = await mf.dispatchFetch(url, { method }); assert.equal(response.status, 200);
      assert.equal(response.headers.get('Cache-Control'), GUIDE_CACHE_CONTROL); assert.equal(response.headers.get('Content-Type'), 'image/webp');
      assert.equal((await response.arrayBuffer()).byteLength, method === 'HEAD' ? 0 : bytes.length);
    }
    for (const bad of [url.replace(digest, 'b'.repeat(64)), url.replace('.webp', '.svg'), url + '?url=https://evil.test', 'https://guide.test/public/guide-packs/private/key']) {
      const response = await mf.dispatchFetch(bad); assert.equal(response.status, 404); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
    const range = await mf.dispatchFetch(url, { headers: { Range: 'bytes=0-1' } }); assert.equal(range.status, 404);
    assert.equal((await mf.dispatchFetch(url, { method: 'POST' })).status, 404);
    const corrupt = Buffer.from(bytes); corrupt[corrupt.length - 1]! ^= 1;
    await guide.put(key, corrupt, { httpMetadata: { contentType: 'image/webp' }, customMetadata: { sha256: digest } });
    for (const method of ['GET', 'HEAD']) { const response = await mf.dispatchFetch(url, { method }); assert.equal(response.status, 503); assert.equal(response.headers.get('Cache-Control'), 'no-store'); }
    await guide.put(key, bytes, { httpMetadata: { contentType: 'text/html' } });
    assert.equal((await mf.dispatchFetch(url)).status, 503);
    await guide.delete(key); assert.equal((await mf.dispatchFetch(url)).status, 404);
    assert.deepEqual(Buffer.from(await (await media.get(key))!.arrayBuffer()), bytes, 'private media object is untouched');
  } finally { await mf?.dispose(); }
});
