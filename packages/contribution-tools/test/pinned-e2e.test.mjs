import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2E_BASELINE, E2E_PLAN, evaluateE2ePasses } from '../pinned-e2e.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const rootDir = '/fixture/tests/e2e';
const expectedFiles = ['tests/e2e/other.spec.ts', 'tests/e2e/private-work-ai.spec.ts', 'tests/e2e/member-avatar-asset.spec.ts'];
const cliEnv = { ...process.env, TEST_DATABASE_URL: 'postgresql://freedom_local@127.0.0.1:55521/fp_foundation_ci', FREEDOM_E2E_PORT: '4391' };
const state = status => ({ timeout: 45000, annotations: [], expectedStatus: 'passed', projectId: 'chromium', projectName: 'chromium',
  results: [{ status: status === 'expected' ? 'passed' : status }], status });
const spec = (file, title, status) => ({ file, title, ok: true, tags: [], id: title, line: 1, column: 1, tests: [state(status)] });
const suite = (file, entries) => ({ file, title: file, line: 0, column: 0, specs: [], suites: [
  { file, title: 'outer', line: 1, column: 1, specs: [], suites: [
    { file, title: 'inner', line: 2, column: 1, specs: entries.map(([title, status]) => spec(file, title, status)) }
  ] }
] });
function report(suites) {
  const stats = { expected: 0, skipped: 0, unexpected: 0, flaky: 0 };
  const visit = s => { for (const spec of s.specs) for (const t of spec.tests) stats[t.status]++; for (const nested of s.suites ?? []) visit(nested); };
  suites.forEach(visit);
  return { config: { rootDir }, suites, errors: [], stats };
}
function cleanPasses() {
  const suites = [
    [suite('other.spec.ts', [['ordinary', 'expected']]), suite('private-work-ai.spec.ts', [['off', 'expected'], ['on', 'skipped']])],
    [suite('private-work-ai.spec.ts', [['off', 'skipped'], ['on', 'expected']])],
    [suite('member-avatar-asset.spec.ts', [['asset', 'expected']])]
  ];
  return E2E_PLAN.map((pass, index) => ({ id: pass.id, exit_code: 0, evidence_sha256: 'a'.repeat(64), report: report(suites[index]) }));
}
const evaluate = (passes, files = expectedFiles) => evaluateE2ePasses(files, passes, { rootDir });
const testIn = (passes, index, file, title) => passes[index].report.suites.find(s => s.file === file).suites[0].suites[0].specs.find(s => s.title === title).tests[0];
function reject(mutator, reason) {
  const passes = cleanPasses();
  mutator(passes);
  const result = evaluate(passes);
  assert.equal(result.status, 'failed');
  if (reason) assert.equal(result.reason, reason);
}

test('Real baselines are accurate', async () => {
  assert.equal(E2E_BASELINE.length, 87);
  assert.deepEqual(E2E_BASELINE, [...new Set(E2E_BASELINE)].sort());
  for (const file of E2E_BASELINE) {
    assert.ok(file.startsWith('tests/e2e/'));
    const name = file.slice('tests/e2e/'.length);
    assert.ok(!name.includes('/'));
    assert.match(name, /^[a-z0-9][a-z0-9-]*\.spec\.ts$/);
    assert.ok((await stat(join(repoRoot, file))).isFile());
  }
  const actual = (await readdir(join(repoRoot, 'tests/e2e'))).filter(name => /^[a-z0-9][a-z0-9-]*\.spec\.ts$/.test(name)).map(name => 'tests/e2e/' + name).sort();
  assert.ok(E2E_BASELINE.every(file => actual.includes(file)));
});

test('Three clean passes matching today shape', () => {
  const result = evaluate(cleanPasses());
  assert.equal(result.status, 'passed');
  assert.equal(result.test_count, 4);
  assert.deepEqual(result.test_files.find(f => f.path.endsWith('private-work-ai.spec.ts')).counts, { tests: 2, passed: 2 });
  assert.ok(!JSON.stringify(result).includes('ordinary'));
});

test('An expected file missing from every pass', () => {
  const result = evaluate(cleanPasses(), [...expectedFiles, 'tests/e2e/missing.spec.ts']);
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'missing_or_empty_file');
});

test('A file whose only test is skipped in every pass', () => {
  reject(passes => { testIn(passes, 0, 'other.spec.ts', 'ordinary').status = 'skipped'; testIn(passes, 0, 'other.spec.ts', 'ordinary').results = []; }, 'skipped_test_never_expected');
});

test('unexpected, flaky, and non-empty errors array', () => {
  reject(p => { p[0].report.stats.unexpected = 1; });
  reject(p => { p[0].report.stats.flaky = 1; });
  reject(p => { p[0].report.errors.push({ message: 'error' }); });
  reject(p => { testIn(p, 0, 'other.spec.ts', 'ordinary').status = 'unexpected'; }, 'test_not_passed');
  reject(p => { testIn(p, 0, 'other.spec.ts', 'ordinary').status = 'flaky'; }, 'test_not_passed');
});

test('Pass 2 containing a test from another file', () => {
  reject(p => p[1].report.suites.push(suite('other.spec.ts', [['ordinary', 'expected']])), 'unexpected_file_in_pass');
});

test('A test from a file outside the expected set', () => {
  reject(p => p[0].report.suites.push(suite('outside.spec.ts', [['unknown', 'expected']])), 'unexpected_file');
});

test('A non-zero exit code with an otherwise clean report', () => {
  reject(p => { p[0].exit_code = 1; }, 'test_process_failed');
});

test('Missing or malformed report fails without throwing', () => {
  for (const malformed of [null, undefined, 'report', [], {}, { suites: 'wrong' }]) {
    reject(p => { p[0].report = malformed; }, 'invalid_test_results');
  }
  reject(p => { delete p[0].report.stats; }, 'invalid_test_results');
  reject(p => { p[0].report.errors = {}; }, 'invalid_test_results');
  reject(p => { p[0].report.suites = {}; }, 'invalid_test_results');
  reject(p => { p[0].report.suites[0].specs = null; }, 'invalid_test_results');
  for (const files of [null, {}, [null]]) assert.equal(evaluateE2ePasses(files, null, null).status, 'failed');
});

test('Two tests in one file exchange skipped and expected across passes', () => {
  const p = cleanPasses();
  const result = evaluate(p);
  assert.equal(result.status, 'passed');
  assert.equal(result.test_count, 4);
});

test('One test skipped in both passes fails even when another in the file passes', () => {
  reject(p => { Object.assign(testIn(p, 1, 'private-work-ai.spec.ts', 'on'), state('skipped')); }, 'skipped_test_never_expected');
});

test('A different config.rootDir fails', () => {
  reject(p => { p[0].report.config.rootDir = '/different/tests/e2e'; }, 'invalid_test_results');
});

test('Suite and spec file fields containing slash or traversal fail', () => {
  for (const file of ['tests/e2e/other.spec.ts', '../other.spec.ts', 'other..spec.ts', '/other.spec.ts', 'nested/other.spec.ts']) {
    reject(p => { p[0].report.suites[0].file = file; }, 'invalid_test_results');
    reject(p => { p[0].report.suites[0].suites[0].suites[0].specs[0].file = file; }, 'invalid_test_results');
  }
  reject(p => { p[0].report.suites[0].suites[0].file = 'private-work-ai.spec.ts'; }, 'invalid_test_results');
});

test('A duplicate identity inside one pass fails', () => {
  reject(p => p[0].report.suites.push(structuredClone(p[0].report.suites[0])), 'duplicate_test_identity');
});

test('Missing pass 3 and incorrect pass ids fail', () => {
  reject(p => p.pop(), 'invalid_pass_plan');
  reject(p => { p[1].id = 'default'; }, 'invalid_pass_plan');
  reject(p => p.push(p[2]), 'invalid_pass_plan');
});

test('Expected failures, retried failures, empty passed results and interrupted tests fail', () => {
  reject(p => { testIn(p, 0, 'other.spec.ts', 'ordinary').expectedStatus = 'failed'; }, 'test_not_passed');
  reject(p => { testIn(p, 0, 'other.spec.ts', 'ordinary').results.unshift({ status: 'failed' }); }, 'test_not_passed');
  reject(p => { testIn(p, 0, 'other.spec.ts', 'ordinary').results = []; }, 'test_not_passed');
  reject(p => { testIn(p, 0, 'private-work-ai.spec.ts', 'on').results = [{ status: 'interrupted' }]; }, 'test_not_passed');
});

test('Describe titles and projectName are part of identity; file-suite title is excluded', () => {
  const p = cleanPasses();
  p[1].report.suites[0].title = 'different file-suite title';
  assert.equal(evaluate(p).status, 'passed');
  reject(p => { p[1].report.suites[0].suites[0].title = 'different describe'; }, 'skipped_test_never_expected');
  reject(p => { testIn(p, 1, 'private-work-ai.spec.ts', 'on').projectName = 'different project'; }, 'skipped_test_never_expected');
});

async function withFixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fp-pinned-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const cli = join(repoRoot, 'scripts/ci/run-pinned-e2e.mjs');
const invoke = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: cliEnv, timeout: 10000 });
async function baseline(root, omit) {
  await mkdir(join(root, 'tests/e2e'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{}');
  for (const file of E2E_BASELINE) if (file !== omit) await writeFile(join(root, file), '// baseline fixture\n');
}

test('CLI argument errors exit 2; missing Playwright writes not_run evidence', async () => {
  for (const args of [['--unknown'], [], ['--root', ''], ['--root', '/tmp', '--output'], ['--root', '/tmp', '--extra', '/tmp/result.json']]) {
    assert.equal(invoke(args).status, 2);
  }
  await withFixture(async root => {
    await baseline(root);
    const output = join(root, 'result.json');
    const child = invoke(['--root', root, '--output', output]);
    assert.equal(child.status, 1);
    const result = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(result.status, 'not_run');
    assert.equal(result.reason, 'e2e_runner_unavailable');
    const summary = JSON.parse(child.stdout.split('\n')[0]);
    assert.equal(summary.file_count, 87);
    assert.equal(summary.test_count, 0);
    assert.ok(!Object.hasOwn(summary, 'test_files'));
  });
});

test('CLI missing one baseline spec fails before spawning Playwright', async () => {
  await withFixture(async root => {
    await baseline(root, E2E_BASELINE[0]);
    // If resolution/spawn happens, this CLI leaves a marker. It must stay absent.
    await mkdir(join(root, 'node_modules/@playwright/test'), { recursive: true });
    await writeFile(join(root, 'node_modules/@playwright/test/package.json'), JSON.stringify({ exports: { './cli': './cli.cjs' } }));
    const marker = join(root, 'spawned');
    await writeFile(join(root, 'node_modules/@playwright/test/cli.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned');\n`);
    const output = join(root, 'result.json');
    const child = invoke(['--root', root, '--output', output]);
    assert.equal(child.status, 1);
    const result = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(result.status, 'not_run');
    assert.equal(result.reason, 'e2e_files_unavailable');
    await assert.rejects(stat(marker), { code: 'ENOENT' });
    assert.deepEqual(result.passes, []);
  });
});


test('CLI stops after a failing pass 1 and reports test_process_failed', async () => {
  await withFixture(async root => {
    await baseline(root);
    const runnerDir = join(root, 'node_modules/@playwright/test');
    await mkdir(runnerDir, { recursive: true });
    await writeFile(join(runnerDir, 'package.json'), JSON.stringify({ exports: { './cli': './cli.cjs' } }));
    await writeFile(join(runnerDir, 'cli.cjs'), `
      require('node:fs').writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, JSON.stringify({
        config: { rootDir: ${JSON.stringify(join(root, 'tests/e2e'))} }, suites: [], errors: [],
        stats: { expected: 0, skipped: 0, unexpected: 1, flaky: 0 }
      }));
      process.exit(1);
    `);
    const output = join(root, 'result.json');
    const child = invoke(['--root', root, '--output', output]);
    assert.equal(child.status, 1);
    const result = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'test_process_failed');
    assert.deepEqual(result.passes.map(({ id, exit_code }) => ({ id, exit_code })), [{ id: 'default', exit_code: 1 }]);
  });
});

test('CLI cancellation sends SIGTERM and retains test_cancelled with a zero child exit', async () => {
  await withFixture(async root => {
    await baseline(root);
    const runnerDir = join(root, 'node_modules/@playwright/test');
    await mkdir(runnerDir, { recursive: true });
    await writeFile(join(runnerDir, 'package.json'), JSON.stringify({ exports: { './cli': './cli.cjs' } }));
    const marker = join(root, 'terminated');
    await writeFile(join(runnerDir, 'cli.cjs'), `
      const fs = require('node:fs');
      process.on('SIGTERM', () => {
        fs.writeFileSync(${JSON.stringify(marker)}, 'SIGTERM');
        fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, JSON.stringify({
          config: { rootDir: ${JSON.stringify(join(root, 'tests/e2e'))} }, suites: [], errors: [],
          stats: { expected: 0, skipped: 0, unexpected: 0, flaky: 0 }
        }));
        process.exit(0);
      });
      console.log('fixture_runner_ready');
      setInterval(() => {}, 1000);
    `);
    const output = join(root, 'result.json');
    const child = spawn(process.execPath, [cli, '--root', root, '--output', output], { env: cliEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const exit = new Promise((done, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => done({ code, signal }));
      });
      const timer = setTimeout(() => child.kill('SIGTERM'), 5000);
      let stdout = '', signalled = false;
      child.stdout.on('data', bytes => {
        stdout += bytes;
        if (!signalled && stdout.includes('fixture_runner_ready')) { signalled = true; child.kill('SIGTERM'); }
      });
      const resultExit = await exit;
      clearTimeout(timer);
      assert.equal(resultExit.code, 1);
      assert.equal(resultExit.signal, null);
      assert.equal(await readFile(marker, 'utf8'), 'SIGTERM');
      const result = JSON.parse(await readFile(output, 'utf8'));
      assert.equal(result.status, 'failed');
      assert.equal(result.reason, 'test_cancelled');
      assert.equal(result.passes[0].exit_code, 0);
    } finally { child.kill('SIGTERM'); }
  });
});
