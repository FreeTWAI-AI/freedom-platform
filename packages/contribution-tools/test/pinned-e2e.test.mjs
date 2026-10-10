import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2E_BASELINE, E2E_PLAN, E2E_PASS_TIMEOUT_MS, evaluateE2ePasses } from '../pinned-e2e.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const rootDir = '/fixture/tests/e2e';
const configFile = '/trusted/scripts/ci/pinned-playwright.config.mjs';
const expectedFiles = ['tests/e2e/other.spec.ts', 'tests/e2e/private-work-ai.spec.ts', 'tests/e2e/member-avatar-asset.spec.ts', 'tests/e2e/message-images.spec.ts', 'tests/e2e/hosted-store-photo.spec.ts', 'tests/e2e/notification-preferences.spec.ts'];
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
  return { config: { rootDir, configFile, forbidOnly: true, projects: [{ name: 'chromium', testDir: rootDir }] }, suites, errors: [], stats };
}
function cleanPasses() {
  const suites = [
    [suite('other.spec.ts', [['ordinary', 'expected']]), suite('private-work-ai.spec.ts', [['off', 'expected'], ['on', 'skipped']]), suite('hosted-store-photo.spec.ts', [['photo', 'skipped']])],
    [suite('private-work-ai.spec.ts', [['off', 'skipped'], ['on', 'expected']])],
    [suite('member-avatar-asset.spec.ts', [['asset', 'expected']])],
    [suite('message-images.spec.ts', [['image', 'expected']])],
    [suite('hosted-store-photo.spec.ts', [['photo', 'expected']])],
    [suite('notification-preferences.spec.ts', [['preferences', 'expected']])]
  ];
  return E2E_PLAN.map((pass, index) => ({ id: pass.id, exit_code: 0, evidence_sha256: 'a'.repeat(64), report: report(suites[index]) }));
}
const evaluate = (passes, files = expectedFiles) => evaluateE2ePasses(files, passes, { rootDir, configFile });
const testIn = (passes, index, file, title) => passes[index].report.suites.find(s => s.file === file).suites[0].suites[0].specs.find(s => s.title === title).tests[0];
function reject(mutator, reason) {
  const passes = cleanPasses();
  mutator(passes);
  const result = evaluate(passes);
  assert.equal(result.status, 'failed');
  if (reason) assert.equal(result.reason, reason);
}

test('Real baselines are accurate', async () => {
  assert.equal(E2E_BASELINE.length, 92);
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

test('Six clean passes including photo and preference fixtures', () => {
  const result = evaluate(cleanPasses());
  assert.equal(result.status, 'passed');
  assert.equal(result.test_count, 7);
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
  assert.equal(result.test_count, 7);
});

test('One test skipped in both passes fails even when another in the file passes', () => {
  reject(p => { Object.assign(testIn(p, 1, 'private-work-ai.spec.ts', 'on'), state('skipped')); }, 'skipped_test_never_expected');
});

test('Photo skipped in default must pass in its dedicated fixture', () => {
  reject(p => { Object.assign(testIn(p, 4, 'hosted-store-photo.spec.ts', 'photo'), state('skipped')); }, 'skipped_test_never_expected');
});

test('A different config.rootDir fails', () => {
  reject(p => { p[0].report.config.rootDir = '/different/tests/e2e'; }, 'invalid_test_results');
});

test('A different configFile fails', () => {
  reject(p => { p[0].report.config.configFile = '/candidate/playwright.config.ts'; }, 'invalid_test_results');
});

test('A report without forbidOnly fails', () => {
  reject(p => { p[0].report.config.forbidOnly = false; }, 'invalid_test_results');
});

test('A report with two projects fails', () => {
  reject(p => { p[0].report.config.projects.push({ name: 'extra', testDir: rootDir }); }, 'invalid_test_results');
});

test('A different project testDir fails', () => {
  reject(p => { p[0].report.config.projects[0].testDir = '/different/tests/e2e'; }, 'invalid_test_results');
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

test('Missing photo pass and incorrect pass ids fail', () => {
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
const invoke = (args, env = {}) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...cliEnv, ...env }, timeout: 60000 });
async function baseline(root, omit) {
  await mkdir(join(root, 'tests/e2e'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{}');
  for (const file of E2E_BASELINE) if (file !== omit) await writeFile(join(root, file), '// baseline fixture\n');
}

const ordinaryTests = "import { test } from '@playwright/test';\ntest('smoke', () => { if(['FREEDOM_E2E_PRIVATE_AI_FIXTURE','FREEDOM_E2E_AVATAR_ASSET_FIXTURE','FREEDOM_E2E_MESSAGE_IMAGE_FIXTURE','FREEDOM_E2E_STORE_PHOTO_FIXTURE','FREEDOM_E2E_NOTIFICATION_PREFERENCES'].filter(k=>process.env[k]==='1').length>1)throw Error('fixture contamination'); });\ntest('required', () => {});\n";
async function playwrightFixture(root, config) {
  await baseline(root);
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await symlink(join(repoRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
  await writeFile(join(root, 'playwright.config.ts'), config);
  for (const file of E2E_BASELINE) await writeFile(join(root, file), ordinaryTests);
}

test('CLI trusted selection ignores candidate filters and includes a new spec', async () => {
  await withFixture(async root => {
    await playwrightFixture(root, `export default {
      testDir: './empty', testMatch: /never-matches/, testIgnore: ['**/admin*.spec.ts'],
      grep: /smoke/, grepInvert: /required/, shard: { total: 4, current: 1 }, retries: 2, forbidOnly: false,
      captureGitInfo: { commit: true, diff: true },
      projects: [{ name: 'chromium', grep: /smoke/, testDir: './empty', testIgnore: '**/*.spec.ts' },
        { name: 'extra', testMatch: /nothing/ }]
    };`);
    await writeFile(join(root, 'tests/e2e/zz-new-normal.spec.ts'), ordinaryTests);
    // These identities are skipped by default and must actually execute in the
    // host-owned photo pass, even when inherited fixture flags are all enabled.
    await writeFile(join(root, 'tests/e2e/hosted-store-photo.spec.ts'), ordinaryTests.replace(
      "test('smoke'", "test.skip(process.env.FREEDOM_E2E_STORE_PHOTO_FIXTURE !== '1');\ntest('smoke'"));
    await writeFile(join(root, 'tests/e2e/notification-preferences.spec.ts'), ordinaryTests.replace(
      "test('smoke'", "test.skip(process.env.FREEDOM_E2E_NOTIFICATION_PREFERENCES !== '1');\ntest('smoke'"));
    // A pull_request event whose base commit is not local: Playwright's git info would try to fetch it.
    await writeFile(join(root, 'event.json'), JSON.stringify({ pull_request: { title: 't', number: 1, base: { sha: '0'.repeat(40) } } }));
    const output = join(root, 'result.json');
    const child = invoke(['--root', root, '--output', output], { GITHUB_ACTIONS: 'true', GITHUB_EVENT_PATH: join(root, 'event.json'), DEBUG_GIT_COMMIT_INFO: '1', FREEDOM_E2E_PRIVATE_AI_FIXTURE:'1', FREEDOM_E2E_AVATAR_ASSET_FIXTURE:'1', FREEDOM_E2E_MESSAGE_IMAGE_FIXTURE:'1', FREEDOM_E2E_STORE_PHOTO_FIXTURE:'1',FREEDOM_E2E_NOTIFICATION_PREFERENCES:'1' });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.doesNotMatch(child.stdout + child.stderr, /GitCommitInfo: running "git /);
    const result = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(result.status, 'passed');
    assert.equal(result.test_count, 2 * (E2E_BASELINE.length + 1));
    assert.equal(result.test_files.length, E2E_BASELINE.length + 1);
    assert.ok(result.test_files.every(file => file.counts.tests === 2 && file.counts.passed === 2));
    assert.deepEqual(result.passes.map(pass => pass.exit_code), [0, 0, 0, 0, 0, 0]);
  });
});

test('CLI trusted selection forbids test.only and stops after the default pass', async () => {
  await withFixture(async root => {
    await playwrightFixture(root, "export default { testDir: './tests/e2e', projects: [{ name: 'chromium' }] };");
    await writeFile(join(root, E2E_BASELINE[0]), ordinaryTests.replace("test('smoke'", "test.only('smoke'"));
    const output = join(root, 'result.json');
    const child = invoke(['--root', root, '--output', output]);
    assert.equal(child.status, 1, child.stdout + child.stderr);
    const result = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'test_process_failed');
    assert.equal(result.passes.length, 1);
    assert.equal(result.passes[0].id, 'default');
    assert.notEqual(result.passes[0].exit_code, 0);
  });
});

test('CLI trusted selection requires the chromium project', async () => {
  await withFixture(async root => {
    await playwrightFixture(root, "export default { projects: [{ name: 'other' }] };");
    const output = join(root, 'result.json');
    const child = invoke(['--root', root, '--output', output]);
    assert.equal(child.status, 1, child.stdout + child.stderr);
    const result = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'test_process_failed');
  });
});

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
    assert.equal(summary.file_count, E2E_BASELINE.length);
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

test('CLI refuses a candidate that deletes the reviewed photo baseline', async () => {
  await withFixture(async root => {
    await baseline(root, 'tests/e2e/hosted-store-photo.spec.ts');
    const output = join(root, 'result.json');
    const child = invoke(['--root', root, '--output', output]);
    assert.equal(child.status, 1);
    const result = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(result.reason, 'e2e_files_unavailable');
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

test('host pass budgets are finite and only the default capacity increases', async () => {
  assert.deepEqual(E2E_PASS_TIMEOUT_MS, {
    default: 40 * 60 * 1000,
    'private-ai': 30 * 60 * 1000,
    'avatar-asset': 30 * 60 * 1000,
    'message-image': 30 * 60 * 1000,
    'store-photo': 30 * 60 * 1000,
    'notification-preferences': 30 * 60 * 1000,
  });
  assert.ok(Object.isFrozen(E2E_PASS_TIMEOUT_MS));
  assert.deepEqual(Object.keys(E2E_PASS_TIMEOUT_MS), E2E_PLAN.map(pass => pass.id));
  assert.ok(Object.values(E2E_PASS_TIMEOUT_MS).every(value => Number.isSafeInteger(value) && value > 0));
  const workflow = await readFile(join(repoRoot, '.github/workflows/verify.yml'), 'utf8');
  const ui = workflow.slice(workflow.indexOf('  ui-e2e:'), workflow.indexOf('  static-worker:'));
  assert.match(ui, /timeout-minutes: 50\b/);
});

test('CLI default deadline remains failure after graceful zero exit and stops later passes', async () => {
  await withFixture(async root => {
    await baseline(root);
    const runnerDir = join(root, 'node_modules/@playwright/test');
    await mkdir(runnerDir, { recursive: true });
    await writeFile(join(runnerDir, 'package.json'), JSON.stringify({ exports: { './cli': './cli.cjs' } }));
    const ready = join(root, 'ready'), marker = join(root, 'terminated'), starts = join(root, 'starts');
    const observed = join(root, 'scheduled-budget.json'), preload = join(root, 'accelerate-fixture.mjs');
    await writeFile(join(runnerDir, 'cli.cjs'), `
      const fs = require('node:fs');
      fs.appendFileSync(${JSON.stringify(starts)}, 'started\\n');
      process.on('SIGTERM', () => {
        fs.writeFileSync(${JSON.stringify(marker)}, 'SIGTERM');
        fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, JSON.stringify({
          config: { rootDir: ${JSON.stringify(join(root, 'tests/e2e'))} }, suites: [], errors: [],
          stats: { expected: 0, skipped: 0, unexpected: 0, flaky: 0 }
        }));
        process.exit(0);
      });
      fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
      setInterval(() => {}, 1000);
    `);
    // Test-only clock acceleration. Production has no argument/environment budget override.
    // Return a native timer handle, so the runner's clearTimeout still cancels it.
    // The real 20-second SIGKILL escalation timer is deliberately not intercepted.
    await writeFile(preload, `
      import { existsSync, writeFileSync } from 'node:fs';
      import { setTimeout as realTimeout, setInterval, clearInterval } from 'node:timers';
      globalThis.setTimeout = (callback, delay, ...args) => {
        if (delay !== ${E2E_PASS_TIMEOUT_MS.default}) return realTimeout(callback, delay, ...args);
        writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ delay }));
        const timer = setInterval(() => {
          if (!existsSync(${JSON.stringify(ready)})) return;
          clearInterval(timer); callback(...args);
        }, 10);
        return timer;
      };
    `);
    const output = join(root, 'result.json');
    const child = spawnSync(process.execPath, ['--import', preload, cli, '--root', root, '--output', output], {
      encoding: 'utf8', env: cliEnv, timeout: 10000,
    });
    assert.equal(child.status, 1, child.stdout + child.stderr);
    assert.equal(child.signal, null);
    assert.deepEqual(JSON.parse(await readFile(observed, 'utf8')), { delay: 40 * 60 * 1000 });
    assert.equal(await readFile(marker, 'utf8'), 'SIGTERM');
    assert.equal(await readFile(starts, 'utf8'), 'started\n');
    const result = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'test_timeout');
    assert.deepEqual(result.passes.map(({ id, exit_code }) => ({ id, exit_code })), [{ id: 'default', exit_code: 0 }]);
  });
});


test('trusted webServer forwards the host fixture and preserves candidate search wiring',async()=>{
  await withFixture(async root=>{
    const source=`import config from ${JSON.stringify(join(repoRoot,'scripts/ci/pinned-playwright.config.mjs'))}; console.log(JSON.stringify(config.webServer[0].env));`;
    for (const firstParticipation of ['0', '1']) {
      const candidateFirstParticipation = firstParticipation === '0' ? '1' : '0';
      await writeFile(join(root,'playwright.config.ts'),`export default {projects:[{name:'chromium'}],webServer:{command:'unused',env:{FREEDOM_E2E_COMMUNITY_SEARCH:'1',FREEDOM_E2E_PRIVATE_AI_FIXTURE:'1',FREEDOM_E2E_MESSAGE_IMAGE_FIXTURE:'0',FREEDOM_E2E_STORE_PHOTO_FIXTURE:'1',FREEDOM_E2E_FIRST_PARTICIPATION:'${candidateFirstParticipation}'}}}`);
      const child=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',env:{...process.env,FREEDOM_PINNED_E2E_ROOT:root,FREEDOM_E2E_PRIVATE_AI_FIXTURE:'0',FREEDOM_E2E_AVATAR_ASSET_FIXTURE:'0',FREEDOM_E2E_MESSAGE_IMAGE_FIXTURE:'1',FREEDOM_E2E_STORE_PHOTO_FIXTURE:'0',FREEDOM_E2E_NOTIFICATION_PREFERENCES:'0',FREEDOM_E2E_FIRST_PARTICIPATION:firstParticipation}});
      assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),{FREEDOM_E2E_COMMUNITY_SEARCH:'1',FREEDOM_E2E_PRIVATE_AI_FIXTURE:'0',FREEDOM_E2E_MESSAGE_IMAGE_FIXTURE:'1',FREEDOM_E2E_AVATAR_ASSET_FIXTURE:'0',FREEDOM_E2E_STORE_PHOTO_FIXTURE:'0',FREEDOM_E2E_NOTIFICATION_PREFERENCES:'0',FREEDOM_E2E_FIRST_PARTICIPATION:firstParticipation});
    }
  });
});
