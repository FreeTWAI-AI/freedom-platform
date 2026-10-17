import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseProgressLog, deriveRuntimeWeights, renderRuntimeWeightsModule } from '../runtime-weights.mjs';

function buildSyntheticLog(segmentRecords, withIncomplete = true) {
  const lines = [];
  const add = (obj) => lines.push(`freedom.test-progress ${JSON.stringify(obj)}`);

  // Fixture
  add({schema: 'freedom.test-file-progress-summary/v1', selected_count: 5, started_count: 5, completed_count: 5, incomplete: false});
  if (withIncomplete) {
    add({schema: 'freedom.test-file-progress-summary/v1', selected_count: 5, started_count: 1, completed_count: 0, incomplete: true});
  }

  for (const rec of segmentRecords) add(rec);

  return lines.join('\n');
}

test('parseProgressLog uses final segment, ignores failed_case, returns durations', () => {
  const records = [
    {schema: 'freedom.test-file-progress/v1', event: 'started', path: 'tests/runtime/a.test.ts', elapsed_ms: 100},
    {schema: 'freedom.test-file-progress/v1', event: 'failed_case', path: 'tests/runtime/a.test.ts'},
    {schema: 'freedom.test-file-progress/v1', event: 'completed', path: 'tests/runtime/a.test.ts', elapsed_ms: 2500},
    {schema: 'freedom.test-file-progress/v1', event: 'started', path: 'tests/runtime/b.test.ts', elapsed_ms: 300},
    {schema: 'freedom.test-file-progress/v1', event: 'completed', path: 'tests/runtime/b.test.ts', elapsed_ms: 500},
    {schema: 'freedom.test-file-progress-summary/v1', selected_count: 2, started_count: 2, completed_count: 2, incomplete: false}
  ];
  const beforeFinal = [
    {schema: 'freedom.test-file-progress/v1', event: 'started', path: 'tests/runtime/a.test.ts', elapsed_ms: 10},
    {schema: 'freedom.test-file-progress/v1', event: 'completed', path: 'tests/runtime/a.test.ts', elapsed_ms: 9999}
  ];
  const lines = [];
  lines.push(`freedom.test-progress ${JSON.stringify(beforeFinal[0])}`);
  lines.push(`freedom.test-progress ${JSON.stringify(beforeFinal[1])}`);
  const text = lines.join('\n') + '\n' + buildSyntheticLog(records);
  const map = parseProgressLog(text);
  assert.deepEqual(Object.fromEntries(map), {
    'tests/runtime/a.test.ts': 2400,
    'tests/runtime/b.test.ts': 200
  });
});

test('parseProgressLog throws expected errors', () => {
  const ok = [
    {schema: 'freedom.test-file-progress/v1', event: 'started', path: 'tests/runtime/a.test.ts', elapsed_ms: 100},
    {schema: 'freedom.test-file-progress/v1', event: 'completed', path: 'tests/runtime/a.test.ts', elapsed_ms: 200},
    {schema: 'freedom.test-file-progress-summary/v1', selected_count: 1, started_count: 1, completed_count: 1, incomplete: false}
  ];

  assert.throws(() => parseProgressLog(buildSyntheticLog(ok.slice(0, 2).concat([{...ok[2], incomplete: true}]))), /incomplete_progress_log/);
  assert.throws(() => parseProgressLog(buildSyntheticLog(ok.slice(0, 2).concat([{...ok[2], selected_count: 2, started_count: 2, completed_count: 2}]))), /inconsistent_progress_log/);

  const dupStart = [ok[0], ok[0], ok[1], ok[2]];
  assert.throws(() => parseProgressLog(buildSyntheticLog(dupStart)), /inconsistent_progress_log/);

  const negDur = [ok[0], {...ok[1], elapsed_ms: 50}, ok[2]];
  assert.throws(() => parseProgressLog(buildSyntheticLog(negDur)), /inconsistent_progress_log/);

  const badPath = [{...ok[0], path: 'tests/runtime/A-B.test.ts'}, {...ok[1], path: 'tests/runtime/A-B.test.ts'}, ok[2]];
  assert.throws(() => parseProgressLog(buildSyntheticLog(badPath)), /invalid_progress_path/);

  const underscorePath = [{...ok[0], path: 'tests/runtime/freedom_env.test.ts'}, {...ok[1], path: 'tests/runtime/freedom_env.test.ts'}, ok[2]];
  assert.doesNotThrow(() => parseProgressLog(buildSyntheticLog(underscorePath)));

  const missingComplete = [ok[0], ok[2]];
  assert.throws(() => parseProgressLog(buildSyntheticLog(missingComplete)), /inconsistent_progress_log/);

  const badStartPath = [{...ok[0], path: 'tests/runtime/bad path'}, ok[1], ok[2]];
  assert.throws(() => parseProgressLog(buildSyntheticLog(badStartPath)), /invalid_progress_path/);
});

test('complete counts cannot admit saturated or invalid file timing as scheduling weights', () => {
  const records = (start, end) => [
    {schema:'freedom.test-file-progress/v1',event:'started',path:'tests/runtime/late.test.ts',elapsed_ms:start},
    {schema:'freedom.test-file-progress/v1',event:'completed',path:'tests/runtime/late.test.ts',elapsed_ms:end},
    {schema:'freedom.test-file-progress-summary/v1',selected_count:1,started_count:1,completed_count:1,incomplete:false},
  ];
  for (const [start,end] of [[1_190_000,1_200_000],[1_200_000,1_200_000],[1_490_000,1_500_000],[1_500_000,1_500_000]]) {
    assert.throws(()=>parseProgressLog(buildSyntheticLog(records(start,end))),/saturated_progress_timing/);
  }
  for (const partial of [false,true]) for (const value of [-1,1.5,'100',null,1_500_001]) {
    for (const [start,end] of [[value,200],[100,value]]) {
      assert.throws(()=>parseProgressLog(buildSyntheticLog(records(start,end)),{partial}),/inconsistent_progress_log/);
    }
  }
  assert.throws(()=>parseProgressLog(buildSyntheticLog(records(1_400_000,1_500_001))),/inconsistent_progress_log/);
  const timing=parseProgressLog(buildSyntheticLog(records(1_250_000,1_360_000)));
  assert.equal(timing.get('tests/runtime/late.test.ts'),110_000);
  assert.equal(deriveRuntimeWeights([timing]).weights['tests/runtime/late.test.ts'],110);
});

test('parseProgressLog measures completed files of a named timed-out segment only', () => {
  const file = (name, start, end) => [
    {schema: 'freedom.test-file-progress/v1', event: 'started', path: `tests/runtime/${name}.test.ts`, elapsed_ms: start},
    ...(end === undefined ? [] : [{schema: 'freedom.test-file-progress/v1', event: 'completed', path: `tests/runtime/${name}.test.ts`, elapsed_ms: end}])
  ];
  const timedOut = [...file('a', 0, 400), ...file('b', 400, 900), ...file('c', 900),
    {schema: 'freedom.test-file-progress-summary/v1', selected_count: 4, started_count: 3, completed_count: 2, incomplete: true}];
  assert.throws(() => parseProgressLog(buildSyntheticLog(timedOut)), /incomplete_progress_log/);
  assert.deepEqual(Object.fromEntries(parseProgressLog(buildSyntheticLog(timedOut), {partial: true})), {
    'tests/runtime/a.test.ts': 400,
    'tests/runtime/b.test.ts': 500
  });

  // At most the one in-flight file may lack a completion, and the counters must match the segment.
  const twoInFlight = [...file('a', 0, 400), ...file('b', 400), ...file('c', 500),
    {schema: 'freedom.test-file-progress-summary/v1', selected_count: 4, started_count: 3, completed_count: 1, incomplete: true}];
  assert.throws(() => parseProgressLog(buildSyntheticLog(twoInFlight), {partial: true}), /incomplete_progress_log/);
  const miscounted = [...file('a', 0, 400), ...file('b', 400),
    {schema: 'freedom.test-file-progress-summary/v1', selected_count: 4, started_count: 3, completed_count: 2, incomplete: true}];
  assert.throws(() => parseProgressLog(buildSyntheticLog(miscounted), {partial: true}), /inconsistent_progress_log/);
  const overSelected = [...file('a', 0, 400), ...file('b', 400),
    {schema: 'freedom.test-file-progress-summary/v1', selected_count: 1, started_count: 2, completed_count: 1, incomplete: true}];
  assert.throws(() => parseProgressLog(buildSyntheticLog(overSelected), {partial: true}), /incomplete_progress_log/);
});

test('only explicit partial input omits either generation of saturated endpoints', () => {
 for (const cap of [1_200_000,1_500_000]) {
  const records = [
    {schema: 'freedom.test-file-progress/v1', event: 'started', path: 'tests/runtime/a.test.ts', elapsed_ms: 1_000_000},
    {schema: 'freedom.test-file-progress/v1', event: 'completed', path: 'tests/runtime/a.test.ts', elapsed_ms: 1_199_999},
    {schema: 'freedom.test-file-progress/v1', event: 'started', path: 'tests/runtime/b.test.ts', elapsed_ms: 1_199_999},
    {schema: 'freedom.test-file-progress/v1', event: 'completed', path: 'tests/runtime/b.test.ts', elapsed_ms: cap},
    {schema: 'freedom.test-file-progress/v1', event: 'started', path: 'tests/runtime/c.test.ts', elapsed_ms: cap},
    {schema: 'freedom.test-file-progress/v1', event: 'completed', path: 'tests/runtime/c.test.ts', elapsed_ms: cap},
    {schema: 'freedom.test-file-progress-summary/v1', selected_count: 3, started_count: 3, completed_count: 3, incomplete: false}
  ];
  assert.throws(()=>parseProgressLog(buildSyntheticLog(records)),/saturated_progress_timing/);
  assert.deepEqual(Object.fromEntries(parseProgressLog(buildSyntheticLog(records),{partial:true})), {'tests/runtime/a.test.ts': 199_999});
 }
 const startOnly = [
  {schema:'freedom.test-file-progress/v1',event:'started',path:'tests/runtime/a.test.ts',elapsed_ms:1_200_000},
  {schema:'freedom.test-file-progress/v1',event:'completed',path:'tests/runtime/a.test.ts',elapsed_ms:1_200_010},
  {schema:'freedom.test-file-progress-summary/v1',selected_count:1,started_count:1,completed_count:1,incomplete:false}
 ];
 assert.equal(parseProgressLog(buildSyntheticLog(startOnly),{partial:true}).size,0);
 startOnly[1].elapsed_ms=1_199_999;
 assert.throws(()=>parseProgressLog(buildSyntheticLog(startOnly),{partial:true}),/inconsistent_progress_log/);

});

test('deriveRuntimeWeights logic', () => {
  const m1 = new Map([['a', 1500], ['b', 500]]);
  const m2 = new Map([['a', 1200], ['b', 1100], ['c', 100]]);
  const res = deriveRuntimeWeights([m1, m2]);

  assert.deepEqual(res.milliseconds, { a: 1200, b: 500, c: 100 });
  assert.deepEqual(res.weights, { a: 2, b: 1, c: 1 });
  assert.deepEqual(Object.keys(res.weights), ['a', 'b', 'c']);
});

test('renderRuntimeWeightsModule and invalid note', async (t) => {
  assert.throws(() => renderRuntimeWeightsModule({}, 'a\nb'), /invalid_weights_note/);
  assert.throws(() => renderRuntimeWeightsModule({}, 'a*/b'), /invalid_weights_note/);
  assert.throws(() => renderRuntimeWeightsModule({}, 'a`b'), /invalid_weights_note/);

  const code = renderRuntimeWeightsModule({'tests/runtime/b.test.ts': 3, 'tests/runtime/a.test.ts': 1}, 'Test note');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tempPath = path.join(dir, 'module.mjs');
  fs.writeFileSync(tempPath, code);
  const m = await import('file://' + tempPath);
  assert.equal(m.DEFAULT_RUNTIME_FILE_WEIGHT, 10);
  assert.deepEqual(m.RUNTIME_FILE_WEIGHTS, {'tests/runtime/a.test.ts': 1, 'tests/runtime/b.test.ts': 3});
  assert.ok(Object.isFrozen(m.RUNTIME_FILE_WEIGHTS));
});

test('CLI tests', (t) => {
  const cli = fileURLToPath(new URL('../../../scripts/ci/derive-runtime-weights.mjs', import.meta.url));
  const runCli = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

  let r = runCli(['--invalid']);
  assert.equal(r.status, 2);
  assert.equal(r.stderr, 'invalid_derive_runtime_weights_arguments\n');

  r = runCli(['--root', 'a', '--root', 'b']);
  assert.equal(r.status, 2);
  assert.equal(r.stderr, 'invalid_derive_runtime_weights_arguments\n');

  const ok = [
    {schema: 'freedom.test-file-progress/v1', event: 'started', path: 'tests/runtime/a.test.ts', elapsed_ms: 100},
    {schema: 'freedom.test-file-progress/v1', event: 'completed', path: 'tests/runtime/a.test.ts', elapsed_ms: 200},
    {schema: 'freedom.test-file-progress/v1', event: 'started', path: 'tests/runtime/missing.test.ts', elapsed_ms: 100},
    {schema: 'freedom.test-file-progress/v1', event: 'completed', path: 'tests/runtime/missing.test.ts', elapsed_ms: 200},
    {schema: 'freedom.test-file-progress-summary/v1', selected_count: 2, started_count: 2, completed_count: 2, incomplete: false}
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'tests/runtime'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'tests/runtime/a.test.ts'), '');

  fs.writeFileSync(path.join(dir, 'log1.log'), buildSyntheticLog(ok));
  fs.writeFileSync(path.join(dir, 'log2.log'), buildSyntheticLog(ok));

  r = runCli(['--root', dir, '--note', 'Test', '--output', path.join(dir, 'out.mjs'), '--costs-output', path.join(dir, 'out.json'), '--log', path.join(dir, 'log1.log'), '--log', path.join(dir, 'log2.log')]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /2 logs, 1 files, total weight 1, 1 dropped/);
  assert.match(r.stderr, /Dropped: tests\/runtime\/missing\.test\.ts/);

  const moduleStr = fs.readFileSync(path.join(dir, 'out.mjs'), 'utf8');
  assert.equal(moduleStr, renderRuntimeWeightsModule({'tests/runtime/a.test.ts': 1}, 'Test'));

  // A timed-out log: a.test.ts completed in 50ms, then missing.test.ts was in flight.
  fs.writeFileSync(path.join(dir, 'timed-out.log'), buildSyntheticLog([{...ok[0], elapsed_ms: 0}, {...ok[1], elapsed_ms: 50}, ok[2],
    {schema: 'freedom.test-file-progress-summary/v1', selected_count: 3, started_count: 2, completed_count: 1, incomplete: true}]));
  r = runCli(['--root', dir, '--note', 'Test', '--output', path.join(dir, 'partial.mjs'), '--costs-output', path.join(dir, 'partial.json'), '--log', path.join(dir, 'timed-out.log')]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Parse error in .*timed-out\.log: incomplete_progress_log/);
  r = runCli(['--root', dir, '--note', 'Test', '--output', path.join(dir, 'partial.mjs'), '--costs-output', path.join(dir, 'partial.json'), '--log', path.join(dir, 'log1.log'), '--partial-log', path.join(dir, 'timed-out.log')]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /2 logs, 1 files, total weight 1, 1 dropped/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'partial.json'), 'utf8')).milliseconds, { 'a.test.ts': 50 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'partial.json'), 'utf8')).input_completeness, 'partial_scheduling_estimates');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'partial.json'), 'utf8')).partial_logs, ['timed-out.log']);
  assert.match(r.stderr, /not a complete weight refresh/);
  assert.match(fs.readFileSync(path.join(dir, 'partial.mjs'), 'utf8'), /^\/\/ Partial scheduling estimates;/);

  const costsStr = fs.readFileSync(path.join(dir, 'out.json'), 'utf8');
  assert.ok(costsStr.endsWith('\n'));
  assert.deepEqual(JSON.parse(costsStr), {
    source: 'Test',
    measurement: 'per-file minimum of serial completed-file progress deltas across the listed hosted runs; includes file loading',
    milliseconds: { 'a.test.ts': 100 }
  });

  // A complete-looking legacy saturated log must fail before either output
  // can overwrite an existing reviewed weights module or cost fixture.
  for (const [value,flag,error] of [
    [1_200_000,'--log',/saturated_progress_timing/],
    [1_500_000,'--log',/saturated_progress_timing/],
    [-1,'--log',/inconsistent_progress_log/],
    ['100','--partial-log',/inconsistent_progress_log/],
    [1_500_001,'--partial-log',/inconsistent_progress_log/],
    [1_200_000,'--partial-log',/Empty final segment/],
    [1_500_000,'--partial-log',/Empty final segment/],
  ]) {
    const invalid = ok.map(record => record.event === 'started' || record.event === 'completed'
      ? {...record, elapsed_ms:value} : record);
    fs.writeFileSync(path.join(dir, 'saturated.log'), buildSyntheticLog(invalid));
    r = runCli(['--root', dir, '--note', 'Test', '--output', path.join(dir, 'out.mjs'),
      '--costs-output', path.join(dir, 'out.json'), '--log', path.join(dir, 'log1.log'), flag, path.join(dir, 'saturated.log')]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, error);
    assert.equal(fs.readFileSync(path.join(dir, 'out.mjs'), 'utf8'), moduleStr);
    assert.equal(fs.readFileSync(path.join(dir, 'out.json'), 'utf8'), costsStr);
  }
});

test('Committed module and fixture agree', async () => {
  const fixturePath = fileURLToPath(new URL('./fixtures/runtime-hosted-costs-20261016.json', import.meta.url));
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const m = await import('../runtime-file-weights.mjs');
  const generatedWeights = {};
  for (const [key, ms] of Object.entries(fixture.milliseconds)) {
    generatedWeights[`tests/runtime/${key}`] = Math.max(1, Math.ceil(ms / 1000));
  }
  assert.deepEqual(m.RUNTIME_FILE_WEIGHTS, generatedWeights);
  const keys1 = Object.keys(m.RUNTIME_FILE_WEIGHTS);
  const keys2 = Object.keys(generatedWeights);
  assert.deepEqual(keys1, keys2);
});
