import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import sharp from 'sharp';
import { guideSha256, GUIDE_CACHE_CONTROL, type GuideManifest } from '../../packages/public-guide-assets/index.js';

// Actual local workerd + its native private R2; no cloud credentials, publisher
// receipts, live bindings or production release override. The harness injects a
// synthetic manifest and uses exactly the production read/validation path.
for(const pack of ['dragon','ai-sister'] as const)test(`native workerd GUIDE_STATIC verifies ${pack} bytes for GET/HEAD and isolates private MEDIA`, async () => {
  const bytes = await sharp({ create: { width: 3, height: 2, channels: 4, background: '#336699' } }).webp().toBuffer();
  const digest = await guideSha256(bytes), version = `${pack}-v1-20261004`;
  const manifest: GuideManifest = { schema: 'freedom.guide-pack/v1', pack, version, purpose: 'platform-public',
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
    const key = `guide-packs/${pack}/${version}/${digest}.webp`, url = `https://guide.test/public/${key}`;
    await media.put(key, bytes, { httpMetadata: { contentType: 'image/webp' } });
    assert.equal((await mf.dispatchFetch(url)).status, 404, 'MEDIA never supplies guide bytes');
    await guide.put(key, bytes, { httpMetadata: { contentType: 'image/webp' } });
    for (const method of ['GET', 'HEAD']) {
      const response = await mf.dispatchFetch(url, { method }); assert.equal(response.status, 200);
      assert.equal(response.headers.get('Cache-Control'), GUIDE_CACHE_CONTROL); assert.equal(response.headers.get('Content-Type'), 'image/webp');
      assert.equal((await response.arrayBuffer()).byteLength, method === 'HEAD' ? 0 : bytes.length);
    }
    for (const bad of [url.replace(digest, 'b'.repeat(64)), url.replace(`/${pack}/`,`/${pack==='dragon'?'ai-sister':'dragon'}/`), url.replace('.webp', '.svg'), url + '?url=https://evil.test', 'https://guide.test/public/guide-packs/private/key']) {
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

test('native Worker activates both receipt-backed catalog packs while retaining host and binding gates', async () => {
  const bundle = await build({ stdin: { contents: `
    import {installWorkerGuideAssets} from './packages/public-guide-assets/worker.ts';
    export default {async fetch(request,env){
      const url=new URL(request.url);
      const service=await installWorkerGuideAssets({
        GUIDE_STATIC:url.pathname==='/missing-binding'?undefined:env.GUIDE_STATIC,
        FREEDOM_PUBLIC_GUIDE_ENABLED:url.pathname==='/disabled'?'false':'true'});
      if(url.pathname.startsWith('/public/'))return service.fetch(request);
      return Response.json(service?.releases??{enabled:false});
    }};`, resolveDir: resolve('.'), sourcefile: 'activated-guide-harness.ts', loader: 'ts' },
    write: false, bundle: true, format: 'esm', platform: 'neutral', conditions: ['workerd', 'worker', 'browser'] });
  let mf: Miniflare | undefined;
  try {
    mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'fp-activated-guides-test', modules: true, script: bundle.outputFiles[0]!.text,
      compatibilityDate: '2026-09-21', r2Buckets: ['GUIDE_STATIC', 'MEDIA'] }] }));
    await mf.ready;
    const guide=await mf.getR2Bucket('GUIDE_STATIC'),media=await mf.getR2Bucket('MEDIA');
    const releases=await (await mf.dispatchFetch('https://guide.test/releases')).json() as Record<string,{enabled:boolean;manifestSha256:string}>;
    assert.deepEqual(Object.keys(releases).sort(),['ai-sister','dragon']);
    for(const version of ['dragon-v1-20261004','ai-sister-v1-20261005']){
      const manifestBytes=await readFile(`contracts/guide-packs/${version}.json`),manifest=JSON.parse(manifestBytes.toString()) as GuideManifest;
      assert.equal(releases[manifest.pack]!.enabled,true);assert.equal(releases[manifest.pack]!.manifestSha256,await guideSha256(manifestBytes));
      const asset=manifest.assets[0]!,bytes=await readFile(`assets/guide-packs/${version}/${asset.logicalId}.webp`);
      const key=`guide-packs/${manifest.pack}/${version}/${asset.sha256}.webp`,url='https://guide.test/public/'+key;
      await media.put(key,bytes,{httpMetadata:{contentType:'image/webp'}});
      assert.equal((await mf.dispatchFetch(url)).status,404,'an enabled pack still cannot fall back to MEDIA');
      await guide.put(key,bytes,{httpMetadata:{contentType:'image/webp'}});
      for(const method of ['GET','HEAD','GET']){
        const response=await mf.dispatchFetch(url,{method});assert.equal(response.status,200);
        const actual=new Uint8Array(await response.arrayBuffer());assert.equal(actual.length,method==='HEAD'?0:asset.byteLength);
        if(method==='GET')assert.equal(await guideSha256(actual),asset.sha256);
      }
    }
    for(const path of ['/disabled','/missing-binding'])assert.deepEqual(await (await mf.dispatchFetch('https://guide.test'+path)).json(),{enabled:false});
  } finally { await mf?.dispose(); }
});
