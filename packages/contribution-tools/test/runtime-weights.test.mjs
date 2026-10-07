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

  const costsStr = fs.readFileSync(path.join(dir, 'out.json'), 'utf8');
  assert.ok(costsStr.endsWith('\n'));
  assert.deepEqual(JSON.parse(costsStr), {
    source: 'Test',
    measurement: 'per-file minimum of serial completed-file progress deltas across the listed hosted runs; includes file loading',
    milliseconds: { 'a.test.ts': 100 }
  });
});

test('Committed module and fixture agree', async () => {
  const fixturePath = fileURLToPath(new URL('./fixtures/runtime-hosted-costs-20261007.json', import.meta.url));
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
