import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {resolve,dirname,basename,join} from 'node:path';
import {tmpdir} from 'node:os';
import {measurePortalBuild,comparePortalBuilds} from '../../scripts/benchmark-portal-build.mjs';

test('build evaluator includes shared static imports and HTML preloads, and rejects missing chunks',t=>{
  const root=mkdtempSync(join(tmpdir(),'fp-portal-bench-'));
  t.after(()=>{assert.equal(dirname(root),resolve(tmpdir()));assert(basename(root).startsWith('fp-portal-bench-'));rmSync(root,{recursive:true});});
  mkdirSync(join(root,'assets'));
  writeFileSync(join(root,'index.html'),'<script type="module" src="/assets/main.js"></script><link rel="modulepreload" href="/assets/preload.js">');
  writeFileSync(join(root,'assets/main.js'),'import "./shared.js"; import("./deferred.js");');
  writeFileSync(join(root,'assets/shared.js'),'export const shared="fixture";');
  writeFileSync(join(root,'assets/preload.js'),'import "./shared.js";');
  const measurement=measurePortalBuild(root);
  assert.deepEqual(measurement.files.map(file=>file.path),['assets/main.js','assets/preload.js','assets/shared.js']);
  assert.equal(measurement.bytes,measurement.files.reduce((n,file)=>n+file.bytes,0));
  writeFileSync(join(root,'assets/shared.js'),'import "./missing.js";');
  assert.throws(()=>measurePortalBuild(root),'a missing static dependency cannot make the result smaller');
});

test('same eager initial payload fails, a real reduction passes, and zero measurements cannot pass',()=>{
  const baseline={gzip_bytes:1000};
  assert.equal(comparePortalBuilds(baseline,baseline).payload_threshold_passed,false);
  assert.equal(comparePortalBuilds(baseline,{gzip_bytes:650}).payload_threshold_passed,true);
  assert.equal(comparePortalBuilds(baseline,{gzip_bytes:701}).payload_threshold_passed,false);
  assert.throws(()=>comparePortalBuilds(baseline,{gzip_bytes:0}));
});
