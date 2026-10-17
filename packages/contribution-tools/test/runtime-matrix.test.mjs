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
test('each of four partitions has its own 1200-second bound inside one 1800-second run window',async()=>{
  for(const value of ['invalid','2026-10-03T00:00:00+00:00','2026-10-02T23:59:59.000Z']){
    const f=await fixtures();f[0].ended_at=value;assert.equal((await aggregateRuntimePartitions(root,f)).status,'failed');
  }
  const full=await fixtures();full[0].ended_at='2026-10-03T00:20:00.000Z';
  assert.equal((await aggregateRuntimePartitions(root,full)).status,'passed');
  const long=await fixtures();long[0].ended_at='2026-10-03T00:20:00.001Z';
  assert.equal((await aggregateRuntimePartitions(root,long)).reason,'runtime_partition_window_exceeded');
  // Four 1100-second fragments starting 200 seconds apart span 1700 seconds.
  const skewed=await fixtures();
  skewed.forEach((fragment,index)=>{const start=Date.parse('2026-10-03T00:00:00.000Z')+index*200_000;
    fragment.started_at=new Date(start).toISOString();fragment.ended_at=new Date(start+1_100_000).toISOString();});
  assert.equal((await aggregateRuntimePartitions(root,skewed)).status,'passed');
  const exactWindow=await fixtures();exactWindow[3].started_at='2026-10-03T00:20:00.000Z';exactWindow[3].ended_at='2026-10-03T00:30:00.000Z';
  assert.equal((await aggregateRuntimePartitions(root,exactWindow)).status,'passed');
  const wide=await fixtures();wide[3].started_at='2026-10-03T00:20:00.001Z';wide[3].ended_at='2026-10-03T00:30:00.001Z';
  assert.equal((await aggregateRuntimePartitions(root,wide)).reason,'runtime_full_window_exceeded');
});
test('valid runtime-full shapes reach the runner without database work',async t=>{
  const env={...process.env};delete env.TEST_DATABASE_URL;
  const dir=await mkdtemp(resolve(tmpdir(),'fp-runtime-full-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  // The URL is rejected before provisioning; with nothing provisioned, cleanup stays
  // unverified and the runner reports runtime_database_cleanup_failed. Bad argument shapes exit 2.
  for(const [count,index] of [['4','3'],['6','5']]){
    const run=spawnSync(process.execPath,['scripts/runtime-full.mjs','--partition-count',count,'--partition-index',index,'--output',resolve(dir,`p${index}.json`)],{cwd:root,env,encoding:'utf8'});
    assert.equal(run.status,1);
    assert.deepEqual(JSON.parse(run.stdout.trim().split('\n').at(-1)),{check_id:`runtime.partition.${index}`,status:'failed',
      reason:'runtime_database_cleanup_failed',partition_index:Number(index),database_cleanup_verified:false});
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
async function fixturesFor(count) {
  const source = await runtimeSourceManifest(root);
  return partitionRuntimeFiles(source.full_source_manifest.map(file=>file.path),count).map((selected,index)=>{
    const test_files=selected.map(path=>({path,counts:{tests:1,passed:1,failed:0,cancelled:0,skipped:0,todo:0},
      cases:[{case_sha256:sha256(Buffer.from(path)),status:'passed'}],suite_events:[]}));
    return {schema:'freedom.runtime-partition/v1',check_id:`runtime.partition.${index}`,partition_index:index,partition_count:count,
      ...source,started_at:'2026-10-03T00:00:00.000Z',ended_at:'2026-10-03T00:14:59.000Z',database_cleanup_verified:true,
      report:{check_id:`runtime.partition.${index}`,status:'passed',reason:'tests_executed',test_count:selected.length,
        evidence_sha256:sha256(Buffer.from(`synthetic-${count}-${index}`)),selected_files:selected,test_files,database_cleanup_verified:true}};
  });
}
const fixtures6 = () => fixturesFor(6);

test('six-partition cases', async t => {
  const fragments = await fixtures6();
  const result = await aggregateRuntimePartitions(root, fragments, { partitionCount: 6 });
  assert.equal(result.status, 'passed');
  assert.equal(result.partition_count, 6);
  assert.equal(result.partition_evidence_sha256.length, 6);

  assert.equal((await aggregateRuntimePartitions(root, fragments)).reason, 'runtime_partitions_missing');
  const fragments4 = await fixtures();
  assert.equal((await aggregateRuntimePartitions(root, fragments4, { partitionCount: 6 })).reason, 'runtime_partitions_missing');

  const fBadId = structuredClone(fragments);
  fBadId[0].partition_count = 4;
  assert.equal((await aggregateRuntimePartitions(root, fBadId, { partitionCount: 6 })).reason, 'runtime_partition_identity');

  const fBadIndex = structuredClone(fragments);
  fBadIndex[5].partition_index = 6;
  assert.equal((await aggregateRuntimePartitions(root, fBadIndex, { partitionCount: 6 })).reason, 'runtime_partition_identity');

  assert.equal((await aggregateRuntimePartitions(root, fragments, { foo: 1 })).reason, 'runtime_partition_options_invalid');
  assert.equal((await aggregateRuntimePartitions(root, fragments, { partitionCount: 5 })).reason, 'runtime_partition_options_invalid');

  // Six partitions permit 1500 seconds exactly, never an unbounded fragment.
  const full = structuredClone(fragments);
  full[0].ended_at = '2026-10-03T00:25:00.000Z';
  assert.equal((await aggregateRuntimePartitions(root, full, { partitionCount: 6 })).status, 'passed');
  const long = structuredClone(fragments);
  long[0].ended_at = '2026-10-03T00:25:00.001Z';
  assert.equal((await aggregateRuntimePartitions(root, long, { partitionCount: 6 })).reason, 'runtime_partition_window_exceeded');

  // Capacity contention may serialize all six bounded partitions.
  const sequential = structuredClone(fragments);
  sequential.forEach((fragment, index) => {
    const start = Date.parse('2026-10-03T00:00:00.000Z') + index * 1_500_000;
    fragment.started_at = new Date(start).toISOString();
    fragment.ended_at = new Date(start + 1_500_000).toISOString();
  });
  assert.equal((await aggregateRuntimePartitions(root, sequential, { partitionCount: 6 })).status, 'passed');

  // Six complete budgets plus 30 minutes of queue gaps is a finite 180m span.
  const exactWindow = structuredClone(fragments);
  exactWindow[5].started_at = '2026-10-03T02:35:00.000Z';
  exactWindow[5].ended_at = '2026-10-03T03:00:00.000Z';
  assert.equal((await aggregateRuntimePartitions(root, exactWindow, { partitionCount: 6 })).status, 'passed');
  const wide = structuredClone(exactWindow);
  wide[5].started_at = '2026-10-03T02:35:00.001Z';
  wide[5].ended_at = '2026-10-03T03:00:00.001Z';
  assert.equal((await aggregateRuntimePartitions(root, wide, { partitionCount: 6 })).reason, 'runtime_full_window_exceeded');

  // A queued partition may start beyond the former 40m span. CI separately
  // refuses cross-attempt artifact reuse; these local reports are diagnostic.
  const queued = structuredClone(fragments);
  queued[3].started_at = '2026-10-03T01:06:48.000Z';
  queued[3].ended_at = '2026-10-03T01:26:29.418Z';
  assert.equal((await aggregateRuntimePartitions(root, queued, { partitionCount: 6 })).status, 'passed');

  await assert.rejects(runRuntimePartition(root, { partitionCount: 6, partitionIndex: 6 }), /invalid_runtime_partition/);
  await assert.rejects(runRuntimePartition(root, { partitionCount: 5, partitionIndex: 0 }), /invalid_runtime_partition/);

  const dir = await mkdtemp(resolve(tmpdir(), 'fp-runtime-matrix-6-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = resolve(dir, 'aggregate.json');
  for(let index=0;index<6;index++) await writeFile(resolve(dir,`runtime-partition-${index}.json`),JSON.stringify(fragments[index]));

  const args6 = ['scripts/runtime-aggregate.mjs', '--partition-count', '6', '--input-dir', dir, '--output', output];
  assert.equal(spawnSync(process.execPath, args6, { cwd: root, encoding: 'utf8' }).status, 0);

  const args5 = ['scripts/runtime-aggregate.mjs', '--partition-count', '5', '--input-dir', dir, '--output', output];
  assert.equal(spawnSync(process.execPath, args5, { cwd: root, encoding: 'utf8' }).status, 2);

  assert.equal(spawnSync(process.execPath, ['scripts/runtime-full.mjs', '--partition-count', '6', '--partition-index', '6', '--output', output], { cwd: root }).status, 2);
  assert.equal(spawnSync(process.execPath, ['scripts/runtime-full.mjs', '--partition-count', '5', '--partition-index', '0', '--output', output], { cwd: root }).status, 2);
});

test('eight-partition cases', async t => {
  const fragments = await fixturesFor(8);
  const result = await aggregateRuntimePartitions(root, fragments, { partitionCount: 8 });
  assert.equal(result.status, 'passed');
  assert.equal(result.partition_count, 8);
  assert.equal(result.partition_evidence_sha256.length, 8);

  assert.equal((await aggregateRuntimePartitions(root, fragments, { partitionCount: 6 })).reason, 'runtime_partitions_missing');
  assert.equal((await aggregateRuntimePartitions(root, await fixtures6(), { partitionCount: 8 })).reason, 'runtime_partitions_missing');
  assert.equal((await aggregateRuntimePartitions(root, fragments, { partitionCount: 7 })).reason, 'runtime_partition_options_invalid');
  const fBadIndex = structuredClone(fragments);
  fBadIndex[7].partition_index = 8;
  assert.equal((await aggregateRuntimePartitions(root, fBadIndex, { partitionCount: 8 })).reason, 'runtime_partition_identity');

  // Eight partitions keep the 1,500-second budget per fragment.
  const full = structuredClone(fragments);
  full[0].ended_at = '2026-10-03T00:25:00.000Z';
  assert.equal((await aggregateRuntimePartitions(root, full, { partitionCount: 8 })).status, 'passed');
  const long = structuredClone(fragments);
  long[0].ended_at = '2026-10-03T00:25:00.001Z';
  assert.equal((await aggregateRuntimePartitions(root, long, { partitionCount: 8 })).reason, 'runtime_partition_window_exceeded');

  // Eight complete budgets plus 30 minutes of queue gaps is a finite 230m span.
  const sequential = structuredClone(fragments);
  sequential.forEach((fragment, index) => {
    const start = Date.parse('2026-10-03T00:00:00.000Z') + index * 1_500_000;
    fragment.started_at = new Date(start).toISOString();
    fragment.ended_at = new Date(start + 1_500_000).toISOString();
  });
  assert.equal((await aggregateRuntimePartitions(root, sequential, { partitionCount: 8 })).status, 'passed');
  const exactWindow = structuredClone(fragments);
  exactWindow[7].started_at = '2026-10-03T03:25:00.000Z';
  exactWindow[7].ended_at = '2026-10-03T03:50:00.000Z';
  assert.equal((await aggregateRuntimePartitions(root, exactWindow, { partitionCount: 8 })).status, 'passed');
  const wide = structuredClone(exactWindow);
  wide[7].started_at = '2026-10-03T03:25:00.001Z';
  wide[7].ended_at = '2026-10-03T03:50:00.001Z';
  assert.equal((await aggregateRuntimePartitions(root, wide, { partitionCount: 8 })).reason, 'runtime_full_window_exceeded');

  await assert.rejects(runRuntimePartition(root, { partitionCount: 8, partitionIndex: 8 }), /invalid_runtime_partition/);
  await assert.rejects(runRuntimePartition(root, { partitionCount: 7, partitionIndex: 0 }), /invalid_runtime_partition/);

  const dir = await mkdtemp(resolve(tmpdir(), 'fp-runtime-matrix-8-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = resolve(dir, 'aggregate.json');
  for(let index=0;index<8;index++) await writeFile(resolve(dir,`runtime-partition-${index}.json`),JSON.stringify(fragments[index]));
  assert.equal(spawnSync(process.execPath, ['scripts/runtime-aggregate.mjs', '--partition-count', '8', '--input-dir', dir, '--output', output], { cwd: root, encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync(process.execPath, ['scripts/runtime-aggregate.mjs', '--partition-count', '7', '--input-dir', dir, '--output', output], { cwd: root, encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, ['scripts/runtime-full.mjs', '--partition-count', '8', '--partition-index', '8', '--output', output], { cwd: root }).status, 2);
  assert.equal(spawnSync(process.execPath, ['scripts/runtime-full.mjs', '--partition-count', '7', '--partition-index', '0', '--output', output], { cwd: root }).status, 2);
});

test('runtime commit binding rejects untracked source and tracked edits but permits ignored artifacts',async t=>{
  const {mkdir}=await import('node:fs/promises');
  const {FULL_RUNTIME_BASELINE}=await import('../runtime-suites.mjs');
  const dir=await mkdtemp(resolve(tmpdir(),'fp-runtime-source-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  for(const path of [...FULL_RUNTIME_BASELINE,'apps/production.ts']){
    await mkdir(dirname(resolve(dir,path)),{recursive:true});await writeFile(resolve(dir,path),'// synthetic source\n');
  }
  // A tracked test may import a source module absent from the claimed commit.
  await writeFile(resolve(dir,FULL_RUNTIME_BASELINE[0]),'import "../../apps/untracked-helper.mjs";\n');
  await writeFile(resolve(dir,'.gitignore'),'build-output.txt\n.freedom/\n');
  const git=args=>spawnSync('git',args,{cwd:dir,encoding:'utf8'});
  for(const args of [['-c','init.templateDir=','init','--quiet'],['add','.'],['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','-c','commit.gpgsign=false','commit','--quiet','-m','synthetic']]){
    assert.equal(git(args).status,0);
  }
  const source=await runtimeSourceManifest(dir);
  await writeFile(resolve(dir,'build-output.txt'),'ignored synthetic');
  await mkdir(resolve(dir,'.freedom/context'),{recursive:true});
  await writeFile(resolve(dir,'.freedom/context/fixture.json'),'{}');
  assert.deepEqual(await runtimeSourceManifest(dir),source);
  // A user's display setting must not suppress the admission check.
  assert.equal(git(['config','status.showUntrackedFiles','no']).status,0);
  await writeFile(resolve(dir,'apps/untracked-helper.mjs'),'export const synthetic = true;\n');
  assert.equal(git(['diff','--quiet','HEAD','--']).status,0);
  await assert.rejects(runtimeSourceManifest(dir),/runtime_source_changed/);
  assert.equal(git(['add','apps/untracked-helper.mjs']).status,0);
  await assert.rejects(runtimeSourceManifest(dir),/runtime_source_changed/);
  assert.equal(git(['reset','--quiet','HEAD','--','apps/untracked-helper.mjs']).status,0);
  await rm(resolve(dir,'apps/untracked-helper.mjs'));
  await writeFile(resolve(dir,'apps/production.ts'),'// changed production\n');
  await assert.rejects(runtimeSourceManifest(dir),/runtime_source_changed/);
  assert.equal(git(['checkout','--','apps/production.ts']).status,0);
  assert.deepEqual(await runtimeSourceManifest(dir),source);
  await writeFile(resolve(dir,'.git/index'),'invalid synthetic index');
  await assert.rejects(runtimeSourceManifest(dir),/runtime_source_changed/);
});
