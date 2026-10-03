import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

// Unlike runtime/asset-media-profiles.test.ts, shared preparation/hashing/writing
// here execute inside the actual Worker isolate, using its native WebCrypto/R2.
// Full readback still buffers up to20MiB; real cloud CPU/memory budgets, multipart,
// backfill and a playable media/player remain separate acceptance requirements.
test('native Worker shared20MiB media preparation and verifiedI/O plus lazy conditionalrange cancellation',async()=>{
  let mf:Miniflare|undefined;
  try{
    const bundle=await build({entryPoints:[resolve('tests/worker/media-object-fixtures/io.ts')],write:false,bundle:true,format:'esm',platform:'neutral',conditions:['workerd','worker','browser']});
    const source=bundle.outputFiles[0].text;assert(!/from ["']node:/.test(source));
    mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'fp-worker-media-io',modules:true,script:source,compatibilityDate:'2026-09-21',compatibilityFlags:['nodejs_compat'],r2Buckets:['MEDIA']}]}));await mf.ready;
    const response=await mf.dispatchFetch('https://media-io.test/');assert.equal(response.status,200);
    const report=await response.json() as Record<string,unknown>;
    assert.equal(report.profile,'synthetic.worker-media-io/v1');assert.equal(report.preparedBytes,20*1024*1024);assert.equal(report.verifiedBytes,20*1024*1024);assert.equal(report.digestMatches,true);assert.match(report.sha256 as string,/^[0-9a-f]{64}$/);
    assert.equal(report.pullsBeforeRead,0,'range is not buffered before caller reads');assert.equal(report.nativePulls,1);assert.equal(report.nativeCancels,1);assert.equal(report.nativeReleased,true);
    assert.equal(report.nativeRequestedRange,true);assert.equal(report.nativeConditional,true);assert.equal(report.rangeLength,1024*1024);
    assert(Number(report.firstSize)>0&&Number(report.firstSize)<=1024*1024);assert.equal(report.firstMatches,true);
    assert.equal(report.integrity,'immutable-etag-range');assert.equal(report.wholeDigestVerified,false);
    for(const flag of ['cloudDeployment','playerVerification','productionQuotaVerification'])assert.equal(report[flag],false);
    const json=JSON.stringify(report);assert(!json.includes('v1/'));assert(!json.includes('scopeId'));assert(!json.includes('representationId'));assert(!json.includes('video/mp4'));assert(!json.includes('bytes":['));
  }finally{await mf?.dispose();}
});
