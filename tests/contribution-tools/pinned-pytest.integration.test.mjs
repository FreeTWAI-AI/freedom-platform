import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPinnedSuite } from '../../packages/contribution-tools/suite-runner.mjs';
import { PINNED_SUITES } from '../../packages/contribution-tools/pinned-suites.mjs';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function withFixture(fn) {
  const tmp = await mkdtemp(join(tmpdir(), 'fp-pinned-'));
  try {
    await fn(tmp);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

test('All expected files pass', async () => {
  await withFixture(async (root) => {
    await mkdir(join(root, 'docs/platform-plan/contracts/tests'), { recursive: true });
    await mkdir(join(root, 'docs/platform-plan/execution/tools/tests'), { recursive: true });

    // We only need one test file for the fixture, but the baseline expects 16 files.
    // Let's create an exact clone of the baseline.
    for (const f of PINNED_SUITES['ci.contracts-pytest'].baseline) {
      await writeFile(join(root, f), "def test_ok(): pass\n");
    }

    const result = await runPinnedSuite(root, 'ci.contracts-pytest');
    assert.equal(result.status, 'passed');
    assert.equal(result.reason, 'tests_executed');
    assert.equal(result.test_count, 16);
    assert.deepEqual(result.test_files.map(file => file.path), [...PINNED_SUITES['ci.contracts-pytest'].baseline]);
    assert.ok(result.test_files.every(file => file.counts.tests === 1 && file.counts.passed === 1
      && file.cases.length === 1 && /^[a-f0-9]{64}$/.test(file.cases[0].case_sha256)));
  });
});

test('A file with zero tests', async () => {
  await withFixture(async (root) => {
    await mkdir(join(root, 'docs/platform-plan/contracts/tests'), { recursive: true });
    await mkdir(join(root, 'docs/platform-plan/execution/tools/tests'), { recursive: true });
    for (const f of PINNED_SUITES['ci.contracts-pytest'].baseline) {
      await writeFile(join(root, f), "def test_ok(): pass\n");
    }
    // Make one file have zero tests
    await writeFile(join(root, PINNED_SUITES['ci.contracts-pytest'].baseline[0]), "# no tests\n");

    const result = await runPinnedSuite(root, 'ci.contracts-pytest');
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'incomplete_test_results');
  });
});

test('A skipped test', async () => {
  await withFixture(async (root) => {
    await mkdir(join(root, 'docs/platform-plan/contracts/tests'), { recursive: true });
    await mkdir(join(root, 'docs/platform-plan/execution/tools/tests'), { recursive: true });
    for (const f of PINNED_SUITES['ci.contracts-pytest'].baseline) {
      await writeFile(join(root, f), "def test_ok(): pass\n");
    }
    await writeFile(join(root, PINNED_SUITES['ci.contracts-pytest'].baseline[0]), `
import pytest
def test_ok(): pass
@pytest.mark.skip
def test_skip(): pass
`);

    const result = await runPinnedSuite(root, 'ci.contracts-pytest');
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'incomplete_test_results');
    assert.equal(result.evidence_reason, 'testcase_not_passed');
  });
});

test('A failing test', async () => {
  await withFixture(async (root) => {
    await mkdir(join(root, 'docs/platform-plan/contracts/tests'), { recursive: true });
    await mkdir(join(root, 'docs/platform-plan/execution/tools/tests'), { recursive: true });
    for (const f of PINNED_SUITES['ci.contracts-pytest'].baseline) {
      await writeFile(join(root, f), "def test_ok(): pass\n");
    }
    await writeFile(join(root, PINNED_SUITES['ci.contracts-pytest'].baseline[0]), `
def test_fail():
    assert False
`);

    const result = await runPinnedSuite(root, 'ci.contracts-pytest');
    assert.equal(result.status, 'failed');
    // pytest exits with 1 -> test_process_failed
    assert.equal(result.reason, 'test_process_failed');
  });
});

test('A collection error', async () => {
  await withFixture(async (root) => {
    await mkdir(join(root, 'docs/platform-plan/contracts/tests'), { recursive: true });
    await mkdir(join(root, 'docs/platform-plan/execution/tools/tests'), { recursive: true });
    for (const f of PINNED_SUITES['ci.contracts-pytest'].baseline) {
      await writeFile(join(root, f), "def test_ok(): pass\n");
    }
    await writeFile(join(root, PINNED_SUITES['ci.contracts-pytest'].baseline[0]), `
def test_syntax(
`); // Syntax error

    const result = await runPinnedSuite(root, 'ci.contracts-pytest');
    assert.equal(result.status, 'failed');
    // pytest exits with 2 (collection error) -> test_process_failed
    assert.equal(result.reason, 'test_process_failed');
  });
});

test('A fixture conftest.py that deselects every test', async () => {
  await withFixture(async (root) => {
    await mkdir(join(root, 'docs/platform-plan/contracts/tests'), { recursive: true });
    await mkdir(join(root, 'docs/platform-plan/execution/tools/tests'), { recursive: true });
    for (const f of PINNED_SUITES['ci.contracts-pytest'].baseline) {
      await writeFile(join(root, f), "def test_ok(): pass\n");
    }
    await writeFile(join(root, 'docs/platform-plan/contracts/tests/conftest.py'), `
def pytest_collection_modifyitems(config, items):
    items.clear()
`);

    const result = await runPinnedSuite(root, 'ci.contracts-pytest');
    assert.equal(result.status, 'failed');
    // pytest exits with 5 (no tests collected) -> test_process_failed
    assert.equal(result.reason, 'test_process_failed');
  });
});
