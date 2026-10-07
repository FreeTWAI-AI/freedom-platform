import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, symlink, mkdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fixtureRoot, put } from './fixtures.mjs';
import { runPinnedSuite, runPinnedSuiteDefinition } from '../suite-runner.mjs';
import { PINNED_SUITES } from '../pinned-suites.mjs';

const syntheticDbUrl = 'postgresql://postgres@localhost/fp_fixture?host=%2Ftmp%2Ffp-fixture';
const cli = fileURLToPath(new URL('../../../scripts/ci/run-pinned-suite.mjs', import.meta.url));

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

// Fills a fixture with the whole real baseline; only the first file gets firstBody.
async function putBaseline(root, suite, firstBody) {
  for (const [index, file] of suite.baseline.entries()) {
    await put(root, file, index === 0 ? firstBody : "import { test } from 'node:test';\ntest('x', () => {});");
  }
}

test('Directory suites do not shrink', async (t) => {
  const root = await fixtureRoot(t);
  const dir = 'packages/contribution-tools/test';
  await mkdir(join(root, dir), { recursive: true });
  await put(root, `${dir}/a.test.mjs`, "import { test } from 'node:test';\ntest('a', () => {});");
  await put(root, `${dir}/b.test.mjs`, "import { test } from 'node:test';\ntest('b', () => { throw new Error('fail'); });");

  const def = Object.freeze({
    directory: dir,
    pattern: /^[a-z][a-z0-9-]*\.test\.mjs$/,
    baseline: Object.freeze([`${dir}/a.test.mjs`, `${dir}/b.test.mjs`]),
    loader: 'node',
    database: false,
    timeoutMs: 10000,
    env: Object.freeze([])
  });

  const res1 = await runPinnedSuiteDefinition(root, 'ci.governance-unit', def);
  assert.equal(res1.status, 'failed');
  assert.equal(res1.test_count, 2);

  await rm(join(root, dir, 'b.test.mjs'));
  const res2 = await runPinnedSuiteDefinition(root, 'ci.governance-unit', def);
  assert.equal(res2.status, 'not_run');
  assert.equal(res2.reason, 'suite_files_unavailable');

  await put(root, `${dir}/b.test.mjs`, "import { test } from 'node:test';\ntest('b', () => {});");
  await put(root, `${dir}/c.test.mjs`, "import { test } from 'node:test';\ntest('c', () => {});");
  const res3 = await runPinnedSuiteDefinition(root, 'ci.governance-unit', def);
  assert.equal(res3.status, 'passed');
  assert.equal(res3.test_count, 3);
  assert.ok(res3.selected_files.includes(`${dir}/c.test.mjs`));

  await put(root, `${dir}/helper.mjs`, "export {}");
  const res4 = await runPinnedSuiteDefinition(root, 'ci.governance-unit', def);
  assert.equal(res4.status, 'passed');
  assert.ok(!res4.selected_files.includes(`${dir}/helper.mjs`));

  const resErr1 = await runPinnedSuiteDefinition(root, 'ci.governance-unit', { ...def }); // not frozen
  assert.equal(resErr1.status, 'not_run');
  assert.equal(resErr1.reason, 'suite_adapter_unavailable');

  const resErr2 = await runPinnedSuiteDefinition(root, 'ci.governance-unit', Object.freeze({ ...def, unknownKey: 1 }));
  assert.equal(resErr2.status, 'not_run');
  assert.equal(resErr2.reason, 'suite_adapter_unavailable');

  const resErr3 = await runPinnedSuiteDefinition(root, 'ci.governance-unit', Object.freeze({ ...def, files: Object.freeze([]) }));
  assert.equal(resErr3.status, 'not_run');
  assert.equal(resErr3.reason, 'suite_adapter_unavailable');

  const resErr4 = await runPinnedSuiteDefinition(root, 'ci.governance-unit', Object.freeze({ files: Object.freeze([`${dir}/a.test.mjs`]), directory: dir, loader: 'node', database: false, timeoutMs: 10000, env: Object.freeze([]) }));
  assert.equal(resErr4.status, 'not_run');
  assert.equal(resErr4.reason, 'suite_adapter_unavailable');

  const defNoBaseline = { ...def };
  delete defNoBaseline.baseline;
  const resErr5 = await runPinnedSuiteDefinition(root, 'ci.governance-unit', Object.freeze(defNoBaseline));
  assert.equal(resErr5.status, 'not_run');
  assert.equal(resErr5.reason, 'suite_adapter_unavailable');

  const resErr6 = await runPinnedSuiteDefinition(root, 'ci.governance-unit', Object.freeze({ ...def, baseline: `${dir}/a.test.mjs` }));
  assert.equal(resErr6.status, 'not_run');
  assert.equal(resErr6.reason, 'suite_adapter_unavailable');

  const resErr7 = await runPinnedSuiteDefinition(root, 'ci.governance-unit', def, { unknownOption: true });
  assert.equal(resErr7.status, 'not_run');
  assert.equal(resErr7.reason, 'invalid_pinned_suite_options');
});

test('Real baselines are accurate', async () => {
  for (const id of ['ci.governance-unit', 'ci.skill-client-unit', 'ci.worker-unit', 'ci.deploy-preflight']) {
    const suite = PINNED_SUITES[id];
    const seen = new Set();
    let prev = '';
    for (const file of suite.baseline) {
      assert.ok(file.startsWith(suite.directory + '/'));
      const name = file.slice(suite.directory.length + 1);
      assert.ok(suite.pattern.test(name));
      assert.ok(!seen.has(file));
      seen.add(file);
      assert.ok(file >= prev);
      prev = file;
      const st = await stat(join(repoRoot, file));
      assert.ok(st.isFile());
    }
  }
});

test('Deploy preflight fixture without full baseline fails', async (t) => {
  const root = await fixtureRoot(t);
  const suite = PINNED_SUITES['ci.deploy-preflight'];
  await mkdir(join(root, suite.directory), { recursive: true });
  for (let i = 0; i < suite.baseline.length - 1; i++) {
    await put(root, suite.baseline[i], '');
  }
  const result = await runPinnedSuite(root, 'ci.deploy-preflight');
  assert.equal(result.status, 'not_run');
  assert.equal(result.reason, 'suite_files_unavailable');
});

test('Probe E: package scripts cannot change the governance file set', async (t) => {
  const root = await fixtureRoot(t);
  await put(root, 'package.json', JSON.stringify({
    scripts: {
      'test:governance': 'node --test packages/contribution-tools/test/none-*.test.mjs',
      'pretest': 'node -e "require(\'node:fs\').writeFileSync(\'hook-ran\', \'\')"',
      'test': 'node -e "require(\'node:fs\').writeFileSync(\'hook-ran\', \'\')"',
      'posttest': 'node -e "require(\'node:fs\').writeFileSync(\'hook-ran\', \'\')"'
    }
  }));
  await put(root, 'packages/contribution-tools/test/alpha.test.mjs', "import { test } from 'node:test';\ntest('a', () => {});");
  await put(root, 'packages/contribution-tools/test/beta.test.mjs', "import { test } from 'node:test';\ntest('b', () => {});");

  const def = Object.freeze({
    ...PINNED_SUITES['ci.governance-unit'],
    baseline: Object.freeze([
      'packages/contribution-tools/test/alpha.test.mjs',
      'packages/contribution-tools/test/beta.test.mjs'
    ])
  });

  const result = await runPinnedSuiteDefinition(root, 'ci.governance-unit', def);
  assert.equal(result.status, 'passed');
  assert.equal(result.reason, 'tests_executed');
  assert.equal(result.test_count, 2);
  assert.deepEqual(result.selected_files.sort(), [
    'packages/contribution-tools/test/alpha.test.mjs',
    'packages/contribution-tools/test/beta.test.mjs'
  ]);

  let hookRan = true;
  try {
    await readFile(join(root, 'hook-ran'));
  } catch {
    hookRan = false;
  }
  assert.equal(hookRan, false);
});

test('Zero tests, skip, todo and describe.skip fail', async (t) => {
  const bodies = [
    '',
    "import { test } from 'node:test';\ntest.skip('s', () => {});",
    "import { test } from 'node:test';\ntest.todo('t');",
    "import { describe } from 'node:test';\ndescribe.skip('d', () => {});"
  ];
  for (const body of bodies) {
    const root = await fixtureRoot(t);
    await put(root, 'packages/contribution-tools/test/alpha.test.mjs', "import { test } from 'node:test';\ntest('a', () => {});");
    await put(root, 'packages/contribution-tools/test/beta.test.mjs', body);

    const def = Object.freeze({
      ...PINNED_SUITES['ci.governance-unit'],
      baseline: Object.freeze([
        'packages/contribution-tools/test/alpha.test.mjs',
        'packages/contribution-tools/test/beta.test.mjs'
      ])
    });

    const result = await runPinnedSuiteDefinition(root, 'ci.governance-unit', def);
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'incomplete_test_results');
  }
});

test('A fake success JSON fails', async (t) => {
  const root = await fixtureRoot(t);
  await put(root, 'packages/contribution-tools/test/alpha.test.mjs', "import { test } from 'node:test';\ntest('a', () => {});");
  await put(root, 'packages/contribution-tools/test/beta.test.mjs', "console.log(JSON.stringify({ success: true, files: [], cases: [], suites: [], counts: { tests: 0, passed: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0, suites: 0 } }));");

  const def = Object.freeze({
    ...PINNED_SUITES['ci.governance-unit'],
    baseline: Object.freeze([
      'packages/contribution-tools/test/alpha.test.mjs',
      'packages/contribution-tools/test/beta.test.mjs'
    ])
  });

  const result = await runPinnedSuiteDefinition(root, 'ci.governance-unit', def);
  assert.equal(result.status, 'failed');
});

test('File-set failures', async (t) => {
  const root1 = await fixtureRoot(t);
  await mkdir(join(root1, 'packages/contribution-tools/test'), { recursive: true });

  const def1 = Object.freeze({
    ...PINNED_SUITES['ci.governance-unit'],
    baseline: Object.freeze([])
  });
  const result1 = await runPinnedSuiteDefinition(root1, 'ci.governance-unit', def1);
  assert.equal(result1.status, 'failed');
  assert.equal(result1.reason, 'empty_test_set');
  assert.equal(result1.test_count, 0);

  const root2 = await fixtureRoot(t);
  const result2 = await runPinnedSuite(root2, 'ci.selector-unit');
  assert.equal(result2.status, 'not_run');
  assert.equal(result2.reason, 'suite_files_unavailable');

  const root3 = await fixtureRoot(t);
  await put(root3, 'real.test.mjs', "import { test } from 'node:test';\ntest('a', () => {});");
  await mkdir(join(root3, 'scripts/ci'), { recursive: true });
  await symlink('../../real.test.mjs', join(root3, 'scripts/ci/select-affected-jobs.test.mjs'));

  const content = await readFile(join(root3, 'scripts/ci/select-affected-jobs.test.mjs'), 'utf8');
  assert.match(content, /test\('a'/);

  const result3 = await runPinnedSuite(root3, 'ci.selector-unit');
  assert.equal(result3.status, 'not_run');
  assert.equal(result3.reason, 'suite_files_unavailable');
});

test('Database URL checks', async (t) => {
  const root = await fixtureRoot(t);
  await put(root, 'tests/worker/a.test.ts', "import { test } from 'node:test';\ntest('a', () => {});");

  const def = Object.freeze({
    ...PINNED_SUITES['ci.worker-unit'],
    baseline: Object.freeze(['tests/worker/a.test.ts'])
  });

  const result1 = await runPinnedSuiteDefinition(root, 'ci.worker-unit', def);
  assert.equal(result1.status, 'not_run');
  assert.equal(result1.reason, 'test_database_required');

  // Exact results: no field may echo any part of the rejected URL.
  const rejected = { check_id: 'ci.worker-unit', status: 'not_run', reason: 'test_database_rejected' };
  const result2 = await runPinnedSuiteDefinition(root, 'ci.worker-unit', def, { testDatabaseUrl: 'postgresql://postgres@db.example.com/fp_fixture' });
  assert.deepEqual(result2, rejected);

  const result3 = await runPinnedSuiteDefinition(root, 'ci.worker-unit', def, { testDatabaseUrl: 'postgresql://postgres:secret-pass@localhost/fp_fixture' });
  assert.deepEqual(result3, rejected);

  const result4 = await runPinnedSuiteDefinition(root, 'ci.worker-unit', def, { testDatabaseUrl: 'postgresql://postgres@localhost/fp_fixture?options=-c%20search_path%3Devil' });
  assert.deepEqual(result4, rejected);
});

test('A database: false suite gets a clean environment', async (t) => {
  const savedEnv = {
    TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    DATABASE_URL: process.env.DATABASE_URL,
    PGPASSWORD: process.env.PGPASSWORD
  };

  t.after(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  });

  process.env.TEST_DATABASE_URL = 'postgresql://foo';
  process.env.NODE_OPTIONS = '--no-warnings';
  process.env.GITHUB_TOKEN = 'secret';
  process.env.DATABASE_URL = 'postgresql://bar';
  process.env.PGPASSWORD = 'pass';

  const root = await fixtureRoot(t);
  await put(root, 'scripts/ci/select-affected-jobs.test.mjs', `
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('env', () => {
  assert.equal(process.env.TEST_DATABASE_URL, undefined);
  assert.equal(process.env.NODE_OPTIONS, undefined);
  assert.equal(process.env.GITHUB_TOKEN, undefined);
  assert.equal(process.env.DATABASE_URL, undefined);
  assert.equal(process.env.PGPASSWORD, undefined);
});
  `);

  const result = await runPinnedSuite(root, 'ci.selector-unit');
  assert.equal(result.status, 'passed');
});

test('Env pass-through', async (t) => {
  const root = await fixtureRoot(t);
  await put(root, 'tests/integration/repositories.test.ts', `
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('env', () => {
  assert.equal(process.env.FREEDOM_REPOSITORIES_ROOT, '/fixture-root');
  assert.equal(process.env.UNKNOWN_VAR, undefined);
});
  `);
  await put(root, 'tests/integration/consumer-libraries.test.ts', "import { test } from 'node:test';\ntest('pass', () => {});");

  const result = await runPinnedSuite(root, 'ci.consumer-repositories', {
    testDatabaseUrl: syntheticDbUrl,
    env: { FREEDOM_REPOSITORIES_ROOT: '/fixture-root', UNKNOWN_VAR: 'x' }
  });
  assert.equal(result.status, 'passed');
});

test('Option checks', async (t) => {
  const root = await fixtureRoot(t);
  await put(root, 'scripts/ci/select-affected-jobs.test.mjs', "import { test } from 'node:test';\ntest('a', () => {});");

  const result1 = await runPinnedSuite(root, 'ci.selector-unit', { timeoutMs: 99999999 });
  assert.equal(result1.status, 'not_run');
  assert.equal(result1.reason, 'invalid_suite_timeout');

  const result2 = await runPinnedSuite(root, 'ci.selector-unit', { timeoutMs: 0 });
  assert.equal(result2.status, 'not_run');
  assert.equal(result2.reason, 'invalid_suite_timeout');

  const result3 = await runPinnedSuite(root, 'ci.selector-unit', { unknownOption: true });
  assert.equal(result3.status, 'not_run');
  assert.equal(result3.reason, 'invalid_pinned_suite_options');

  const result4 = await runPinnedSuite(root, 'ci.unknown-id');
  assert.equal(result4.status, 'not_run');
  assert.equal(result4.reason, 'suite_adapter_unavailable');
});

test('CLI', async (t) => {
  const root = await fixtureRoot(t);
  const suite = PINNED_SUITES['ci.governance-unit'];
  await putBaseline(root, suite, "import { test } from 'node:test';\ntest('a', () => {});");

  const outFilePass = join(root, 'out-pass.json');
  const cpPass = spawnSync(process.execPath, [cli, '--root', root, '--suite', 'ci.governance-unit', '--output', outFilePass], { encoding: 'utf8' });
  assert.equal(cpPass.status, 0);

  const stdoutPassLines = cpPass.stdout.trim().split('\n').filter(Boolean);
  const summaryLinePass = stdoutPassLines.map(line => JSON.parse(line)).find(obj => obj.status);
  assert.equal(summaryLinePass.status, 'passed');
  assert.equal(JSON.parse(await readFile(outFilePass, 'utf8')).status, 'passed');

  // Change one test to fail
  await put(root, suite.baseline[0], "import { test } from 'node:test';\ntest('fail', () => { throw new Error('fail'); });");
  const outFileFail = join(root, 'out-fail.json');
  const cpFail = spawnSync(process.execPath, [cli, '--root', root, '--suite', 'ci.governance-unit', '--output', outFileFail], { encoding: 'utf8' });
  assert.equal(cpFail.status, 1);
  const stdoutFailLines = cpFail.stdout.trim().split('\n').filter(Boolean);
  const summaryLineFail = stdoutFailLines.map(line => JSON.parse(line)).find(obj => obj.status);
  assert.equal(summaryLineFail.status, 'failed');

  const cpUnknown = spawnSync(process.execPath, [cli, '--root', root, '--suite', 'ci.unknown-id'], { encoding: 'utf8' });
  assert.equal(cpUnknown.status, 2);

  const cpBadArgs = spawnSync(process.execPath, [cli, '--root', root], { encoding: 'utf8' });
  assert.equal(cpBadArgs.status, 2);
  assert.match(cpBadArgs.stderr, /invalid_pinned_suite_arguments/);
});

test('A candidate runner is never loaded', async (t) => {
  const root = await fixtureRoot(t);
  await put(root, 'packages/contribution-tools/suite-runner.mjs', `
export async function runPinnedSuite() {
  return { status: 'passed' };
}
  `);
  await put(root, 'scripts/ci/run-pinned-suite.mjs', `
console.log(JSON.stringify({ status: 'passed' }));
process.exit(0);
  `);

  const suite = PINNED_SUITES['ci.governance-unit'];
  await putBaseline(root, suite, "import { test } from 'node:test';\ntest('fail', () => { throw new Error('fail'); });");

  const cp = spawnSync(process.execPath, [cli, '--root', root, '--suite', 'ci.governance-unit'], { encoding: 'utf8' });
  assert.equal(cp.status, 1);
});

test('Duplicate evidence stays rejected', async (t) => {
  const root = await fixtureRoot(t);
  await put(root, 'packages/contribution-tools/test/a.test.mjs', `
import { test } from 'node:test';
test('a', () => {});
export const helper = () => 1;
  `);
  await put(root, 'packages/contribution-tools/test/b.test.mjs', `
import { test } from 'node:test';
import { helper } from './a.test.mjs';
test('b', () => {
  helper();
});
  `);

  const def = Object.freeze({
    ...PINNED_SUITES['ci.governance-unit'],
    baseline: Object.freeze([
      'packages/contribution-tools/test/a.test.mjs',
      'packages/contribution-tools/test/b.test.mjs'
    ])
  });

  const result = await runPinnedSuiteDefinition(root, 'ci.governance-unit', def);
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'incomplete_test_results');
});

test('The suite table is deep-frozen', () => {
  assert.ok(Object.isFrozen(PINNED_SUITES));
  for (const entry of Object.values(PINNED_SUITES)) {
    assert.ok(Object.isFrozen(entry));
    if (entry.files) {
      assert.ok(Object.isFrozen(entry.files));
    }
    if (entry.env) {
      assert.ok(Object.isFrozen(entry.env));
    }
    if (entry.baseline) {
      assert.ok(Object.isFrozen(entry.baseline));
    }
  }
});
