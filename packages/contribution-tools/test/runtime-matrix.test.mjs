import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { runtimeSourceManifest, partitionRuntimeFiles, aggregateRuntimePartitions, runRuntimePartition } from '../suite-runner.mjs';
import { sha256 } from '../io.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
async function fixtures(){
  const source=await runtimeSourceManifest(root);
  return partitionRuntimeFiles(source.full_source_manifest.map(file=>file.path),4).map((selected,index)=>{
    const test_files=selected.map(path=>({path,counts:{tests:1,passed:1,failed:0,cancelled:0,skipped:0,todo:0},
      cases:[{case_sha256:sha256(Buffer.from(path)),status:'passed'}],suite_events:[]}));
    return {schema:'freedom.runtime-partition/v1',check_id:`runtime.partition.${index}`,partition_index:index,partition_count:4,
      ...source,started_at:'2026-10-03T00:00:00.000Z',ended_at:'2026-10-03T00:14:59.000Z',database_cleanup_verified:true,
      report:{check_id:`runtime.partition.${index}`,status:'passed',reason:'tests_executed',test_count:selected.length,
        evidence_sha256:sha256(Buffer.from(`synthetic-${index}`)),selected_files:selected,test_files,database_cleanup_verified:true}};
  });
}
test('complete four-fragment aggregate recomputes source union and keeps diagnostic authority',async()=>{
  const fragments=await fixtures(),result=await aggregateRuntimePartitions(root,fragments.reverse());
  assert.equal(result.status,'passed');assert.equal(result.check_id,'runtime.full');
  assert.equal(result.test_count,result.full_source_manifest.length);
  assert.deepEqual(result.selected_files,result.full_source_manifest.map(file=>file.path));
  assert.equal(result.gate_enforced,false);assert.equal(result.merge_authorized,false);
  assert.match(result.evidence_sha256,/^[a-f0-9]{64}$/);assert.equal(result.partition_evidence_sha256.length,4);
  assert.ok(fragments.every(fragment=>fragment.report.check_id!=='runtime.full'));
});
test('missing, repeated, wrong candidate/source/index and full-suite impersonation fail closed',async()=>{
  const original=await fixtures();
  const mutations=[f=>f.pop(),f=>f[3]=f[0],f=>f[0].partition_index=4,f=>f[0].partition_count=2,
    f=>f[0].candidate_commit='a'.repeat(40),f=>f[0].manifest_sha256='a'.repeat(64),
    f=>f[0].full_source_manifest[0].source_sha256='a'.repeat(64),f=>f[0].full_source_manifest.pop(),
    f=>f[0].report.check_id='runtime.full',f=>f[0].check_id='runtime.full',f=>f[0].report.extra='forged'];
  for(const mutate of mutations){const fragments=structuredClone(original);mutate(fragments);assert.equal((await aggregateRuntimePartitions(root,fragments)).status,'failed');}
});
test('failed/cancelled/incomplete files, counters, duplicate cases and cleanup disagreement fail',async()=>{
  const original=await fixtures();
  const mutations=[f=>f[0].report.status='failed',f=>f[0].report.reason='test_cancelled',
    f=>f[0].database_cleanup_verified=false,f=>f[0].report.database_cleanup_verified=false,
    f=>f[0].report.selected_files.pop(),f=>f[0].report.test_files.pop(),f=>f[0].report.test_count=0,
    f=>f[0].report.test_files[0].counts.tests=0,f=>f[0].report.test_files[0].counts.skipped=1,
    f=>f[0].report.test_files[0].cases[0].status='cancelled',f=>f[0].report.test_files[0].counts.todo=1,
    f=>f[0].report.test_files[0].cases=[],
    f=>f[1].report.test_files[0].cases[0].case_sha256=f[0].report.test_files[0].cases[0].case_sha256,
    f=>f[0].report.test_files[0].path=f[1].report.test_files[0].path];
  for(const mutate of mutations){const fragments=structuredClone(original);mutate(fragments);assert.equal((await aggregateRuntimePartitions(root,fragments)).status,'failed');}
});
test('whole UTC window has one 900-second bound, not four separate allowances',async()=>{
  const fragments=await fixtures();fragments[3].started_at='2026-10-03T00:14:00.000Z';fragments[3].ended_at='2026-10-03T00:28:00.000Z';
  assert.equal((await aggregateRuntimePartitions(root,fragments)).reason,'runtime_full_window_exceeded');
  for(const value of ['invalid','2026-10-03T00:00:00+00:00','2026-10-02T23:59:59.000Z']){
    const f=await fixtures();f[0].ended_at=value;assert.equal((await aggregateRuntimePartitions(root,f)).status,'failed');
  }
});
test('partition admission forbids arbitrary selection/count/commands before DB',async()=>{
  for(const options of [{partitionCount:2,partitionIndex:0},{partitionCount:4,partitionIndex:4},{partitionCount:4,partitionIndex:0,files:['injected']},
    {partitionCount:4,partitionIndex:0,command:'injected'}])await assert.rejects(runRuntimePartition(root,options),/invalid_runtime_partition/);
  const fragment=await runRuntimePartition(root,{partitionCount:4,partitionIndex:0,testDatabaseUrl:'postgresql://secret:secret@remote/production'});
  assert.equal(fragment.report.status,'failed');assert.equal(fragment.check_id,'runtime.partition.0');assert.equal(fragment.database_cleanup_verified,false);
  assert.equal(JSON.stringify(fragment).includes('secret'),false);
});
test('CLI requires exact named artifacts, preserves failed inputs, rejects duplicate JSON keys',async t=>{
  const dir=await mkdtemp(resolve(tmpdir(),'fp-runtime-matrix-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const output=resolve(dir,'aggregate.json'),fragments=await fixtures();
  for(let index=0;index<4;index++)await writeFile(resolve(dir,`runtime-partition-${index}.json`),JSON.stringify(fragments[index]));
  const args=['scripts/runtime-aggregate.mjs','--input-dir',dir,'--output',output];
  assert.equal(spawnSync(process.execPath,args,{cwd:root,encoding:'utf8'}).status,0);
  await writeFile(resolve(dir,'runtime-partition-0.json'),'{"schema":"one","schema":"two"}');
  const run=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8'});assert.equal(run.status,1);
  assert.match(run.stdout,/runtime_partition_artifacts_unavailable/);
  assert.equal(spawnSync(process.execPath,['scripts/runtime-full.mjs','--partition-index','0'],{cwd:root}).status,2);
});

test('tracked production/source edits invalidate identity while untracked build output is harmless',async t=>{
  const {mkdir}=await import('node:fs/promises');
  const {FULL_RUNTIME_BASELINE}=await import('../runtime-suites.mjs');
  const dir=await mkdtemp(resolve(tmpdir(),'fp-runtime-source-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  for(const path of [...FULL_RUNTIME_BASELINE,'apps/production.ts']){
    await mkdir(dirname(resolve(dir,path)),{recursive:true});await writeFile(resolve(dir,path),'// synthetic source\n');
  }
  for(const args of [['init','--quiet'],['add','.'],['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','--quiet','-m','synthetic']]){
    assert.equal(spawnSync('git',args,{cwd:dir}).status,0);
  }
  assert.ok((await runtimeSourceManifest(dir)).candidate_commit);
  await writeFile(resolve(dir,'build-output.txt'),'untracked synthetic');
  assert.ok((await runtimeSourceManifest(dir)).candidate_commit);
  await writeFile(resolve(dir,'apps/production.ts'),'// changed production\n');
  await assert.rejects(runtimeSourceManifest(dir),/runtime_source_changed/);
});
