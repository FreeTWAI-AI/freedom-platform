import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir, symlink, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { GUILD_PRESENTATION_PROFILE } from '../guild-presentation-profile.mjs';
import { cleanupE2ePass } from '../../../scripts/ci/run-pinned-e2e.mjs';
import { E2E_BASELINE, E2E_PLAN, E2E_DEFAULT_SHARDS, E2E_PASS_TIMEOUT_MS, evaluateE2ePasses, evaluateE2ePassProgress, GUIDE_DEFAULT_FILES, GUIDE_COMPOSITION_PROFILE, planE2eSelection } from '../pinned-e2e.mjs';

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
function report(suites, shard = null) {
  const stats = { expected: 0, skipped: 0, unexpected: 0, flaky: 0 };
  const visit = s => { for (const spec of s.specs) for (const t of spec.tests) stats[t.status]++; for (const nested of s.suites ?? []) visit(nested); };
  suites.forEach(visit);
  return { config: { rootDir, configFile, forbidOnly: true, shard, projects: [{ name: 'chromium', testDir: rootDir }] }, suites, errors: [], stats };
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
  return E2E_PLAN.map((pass, index) => index === 0 ? {
    id: pass.id, exit_code: 0, listing: structuredClone(report(suites[0])), listing_exit_code: 0, listing_evidence_sha256: 'a'.repeat(64),
    partitions: E2E_DEFAULT_SHARDS.map(({ current, total }, part) => ({ current, total, exit_code: 0, evidence_sha256: 'b'.repeat(64),
      report: report(part === 0 ? suites[0].slice(0, 2) : suites[0].slice(2), { current, total }) })),
  } : { id: pass.id, exit_code: 0, evidence_sha256: 'a'.repeat(64), report: report(suites[index]) });
}
const evaluate = (passes, files = expectedFiles) => evaluateE2ePasses(files, passes, { rootDir, configFile });
const testIn = (passes, index, file, title) => (index === 0 ? passes[0].partitions.flatMap(part => part.report.suites) : passes[index].report.suites).find(s => s.file === file).suites[0].suites[0].specs.find(s => s.title === title).tests[0];
function reject(mutator, reason) {
  const passes = cleanPasses();
  mutator(passes);
  const result = evaluate(passes);
  assert.equal(result.status, 'failed');
  if (reason) assert.equal(result.reason, reason);
}


test('Six clean passes including photo and preference fixtures', () => {
  const result = evaluate(cleanPasses());
  assert.equal(result.status, 'passed');
  assert.equal(result.test_count, 7);
  assert.deepEqual(result.test_files.find(f => f.path.endsWith('private-work-ai.spec.ts')).counts, { tests: 2, passed: 2 });
  assert.ok(!JSON.stringify(result).includes('ordinary'));
});

test('progress validates only a nonempty ordered prefix without granting complete-plan admission', () => {
  const passes = cleanPasses();
  const progress = value => evaluateE2ePassProgress(expectedFiles, value, { rootDir, configFile });
  assert.equal(progress(passes.slice(0, 1)).status, 'passed');
  assert.equal(evaluate(passes.slice(0, 1)).reason, 'invalid_pass_plan');
  assert.equal(progress([]).reason, 'invalid_pass_plan');
  assert.equal(progress(passes.slice(1, 2)).reason, 'invalid_pass_plan');
  assert.equal(progress([...passes, passes[0]]).reason, 'invalid_pass_plan');
  const incomplete = passes.slice(0, 1);
  incomplete[0].partitions[0].report.suites[0].suites[0].suites[0].specs[0].title = 'conditional inventory';
  assert.equal(progress(incomplete).reason, 'case_listing_mismatch');
  const skipped = cleanPasses();
  Object.assign(testIn(skipped, 4, 'hosted-store-photo.spec.ts', 'photo'), state('skipped'));
  assert.equal(progress(skipped).reason, 'skipped_test_never_expected');
});

test('full default evidence requires both distinct host-bound fragments, not a successful subset', () => {
  for (const mutate of [
    pass=>pass.partitions.pop(),
    pass=>pass.partitions.push(structuredClone(pass.partitions[0])),
    pass=>{pass.partitions[1]=structuredClone(pass.partitions[0]);},
    pass=>pass.partitions.reverse(),
    pass=>{pass.partitions[1].total=3;},
    pass=>{pass.partitions[1].report.config.shard=null;},
    pass=>{delete pass.partitions[0].evidence_sha256;},
    pass=>{pass.partitions[1].exit_code=1;},
    pass=>{pass.report=pass.partitions[0].report;delete pass.partitions;},
  ]) {
    const passes=cleanPasses();mutate(passes[0]);
    assert.equal(evaluate(passes).status,'failed');
  }
});

test('full default fragment union must match unsharded discovery even when another mode passes the omitted case', () => {
  reject(passes=>{
    const first=passes[0].partitions[0].report;
    first.suites.find(item=>item.file==='private-work-ai.spec.ts').suites[0].suites[0].specs.pop();
    first.stats.skipped--;
  },'case_listing_mismatch');
  reject(passes=>{
    const second=passes[0].partitions[1].report;
    second.suites.push(structuredClone(passes[0].partitions[0].report.suites[0]));
    second.stats.expected++;
  },'duplicate_test_identity');
  reject(passes=>{
    const first=passes[0].partitions[0].report;
    first.suites[0].suites[0].suites[0].specs.push(spec('other.spec.ts','invented','expected'));
    first.stats.expected++;
  },'case_listing_mismatch');
  reject(passes=>{passes[0].listing.config.shard={current:1,total:2};},'invalid_case_listing');
});

test('An expected file missing from every pass', () => {
  const result = evaluate(cleanPasses(), [...expectedFiles, 'tests/e2e/missing.spec.ts']);
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'missing_or_empty_file');
});

test('A file whose only test is skipped in every pass', () => {
  reject(passes => {
    testIn(passes, 0, 'other.spec.ts', 'ordinary').status = 'skipped'; testIn(passes, 0, 'other.spec.ts', 'ordinary').results = [];
    passes[0].partitions[0].report.stats.expected--; passes[0].partitions[0].report.stats.skipped++;
  }, 'skipped_test_never_expected');
});

test('unexpected, flaky, and non-empty errors array', () => {
  reject(p => { p[0].partitions[0].report.stats.unexpected = 1; });
  reject(p => { p[0].partitions[0].report.stats.flaky = 1; });
  reject(p => { p[0].partitions[0].report.errors.push({ message: 'error' }); });
  reject(p => { testIn(p, 0, 'other.spec.ts', 'ordinary').status = 'unexpected'; }, 'test_not_passed');
  reject(p => { testIn(p, 0, 'other.spec.ts', 'ordinary').status = 'flaky'; }, 'test_not_passed');
});

test('Pass 2 containing a test from another file', () => {
  reject(p => p[1].report.suites.push(suite('other.spec.ts', [['ordinary', 'expected']])), 'unexpected_file_in_pass');
});

test('A test from a file outside the expected set', () => {
  reject(p => p[0].partitions[0].report.suites.push(suite('outside.spec.ts', [['unknown', 'expected']])), 'unexpected_file');
});

test('A non-zero exit code with an otherwise clean report', () => {
  reject(p => { p[0].exit_code = 1; }, 'test_process_failed');
});

test('Missing or malformed report fails without throwing', () => {
  for (const malformed of [null, undefined, 'report', [], {}, { suites: 'wrong' }]) {
    reject(p => { p[0].partitions[0].report = malformed; }, 'invalid_test_results');
  }
  reject(p => { delete p[0].partitions[0].report.stats; }, 'invalid_test_results');
  reject(p => { p[0].partitions[0].report.errors = {}; }, 'invalid_test_results');
  reject(p => { p[0].partitions[0].report.suites = {}; }, 'invalid_test_results');
  reject(p => { p[0].partitions[0].report.suites[0].specs = null; }, 'invalid_test_results');
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
  reject(p => { p[0].partitions[0].report.config.rootDir = '/different/tests/e2e'; }, 'invalid_test_results');
});

test('A different configFile fails', () => {
  reject(p => { p[0].partitions[0].report.config.configFile = '/candidate/playwright.config.ts'; }, 'invalid_test_results');
});

test('A report without forbidOnly fails', () => {
  reject(p => { p[0].partitions[0].report.config.forbidOnly = false; }, 'invalid_test_results');
});

test('A report with two projects fails', () => {
  reject(p => { p[0].partitions[0].report.config.projects.push({ name: 'extra', testDir: rootDir }); }, 'invalid_test_results');
});

test('A different project testDir fails', () => {
  reject(p => { p[0].partitions[0].report.config.projects[0].testDir = '/different/tests/e2e'; }, 'invalid_test_results');
});

test('Suite and spec file fields containing slash or traversal fail', () => {
  for (const file of ['tests/e2e/other.spec.ts', '../other.spec.ts', 'other..spec.ts', '/other.spec.ts', 'nested/other.spec.ts']) {
    reject(p => { p[0].partitions[0].report.suites[0].file = file; }, 'invalid_test_results');
    reject(p => { p[0].partitions[0].report.suites[0].suites[0].suites[0].specs[0].file = file; }, 'invalid_test_results');
  }
  reject(p => { p[0].partitions[0].report.suites[0].suites[0].file = 'private-work-ai.spec.ts'; }, 'invalid_test_results');
});

test('A duplicate identity inside one pass fails', () => {
  reject(p => p[0].partitions[0].report.suites.push(structuredClone(p[0].partitions[0].report.suites[0])), 'duplicate_test_identity');
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

// Lifecycle-only synthetic child discovery; never evidence of platform/browser behavior.
function lifecycleListing(root) {
  const value = report([suite(E2E_BASELINE[0].slice('tests/e2e/'.length), [['lifecycle', 'expected']])]);
  value.config.rootDir = join(root, 'tests/e2e'); value.config.configFile = join(repoRoot, 'scripts/ci/pinned-playwright.config.mjs');
  value.config.projects[0].testDir = value.config.rootDir;
  return `if(process.argv.includes('--list')){require('node:fs').writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE,${JSON.stringify(JSON.stringify(value))});process.exit(0);}`;
}
test('Failure diagnostics survive scratch cleanup, are bounded and never follow symlinks', async () => {
  await withFixture(async root => {
    const temp = join(root, 'scratch'), output = join(root, 'result.json');
    await mkdir(join(temp, 'artifacts', 'failed-case'), { recursive: true });
    await writeFile(join(temp, 'report.json'), '{"errors":["synthetic failure"]}');
    await writeFile(join(temp, 'artifacts', 'failed-case', 'trace.zip'), 'synthetic trace');
    await writeFile(join(temp, 'artifacts', 'failed-case', 'screenshot.png'), 'synthetic screenshot');
    await writeFile(join(temp, 'listing.json'), '{"suites":["synthetic inventory"]}');
    await mkdir(join(temp, 'shard-2', 'artifacts'), {recursive:true});
    await writeFile(join(temp, 'shard-2', 'report.json'), '{"errors":["synthetic second shard failure"]}');
    await symlink(join(root, 'private.txt'), join(temp, 'shard-2', 'artifacts', 'private-link'));
    await writeFile(join(root, 'private.txt'), 'must not be copied');
    await symlink(join(root, 'private.txt'), join(temp, 'artifacts', 'linked.txt'));
    await symlink(root, join(temp, 'artifacts', 'linked-directory'));
    await writeFile(join(temp, 'artifacts', 'oversize.zip'), '');
    await truncate(join(temp, 'artifacts', 'oversize.zip'), 64 * 1024 * 1024 + 1);
    await cleanupE2ePass(temp, output, 'default', true);
    await assert.rejects(stat(temp), { code: 'ENOENT' });
    const [run] = await readdir(output + '.failure-artifacts');
    const saved = join(output + '.failure-artifacts', run);
    assert.equal(await readFile(join(saved, 'artifacts', 'failed-case', 'trace.zip'), 'utf8'), 'synthetic trace');
    assert.equal(await readFile(join(saved, 'artifacts', 'failed-case', 'screenshot.png'), 'utf8'), 'synthetic screenshot');
    assert.deepEqual(await readdir(join(saved, 'artifacts')), ['failed-case']);
    assert.equal(JSON.parse(await readFile(join(saved, 'report.json'), 'utf8')).errors[0], 'synthetic failure');
    assert.deepEqual(JSON.parse(await readFile(join(saved, 'listing.json'), 'utf8')).suites, ['synthetic inventory']);
    assert.equal(JSON.parse(await readFile(join(saved, 'shard-2', 'report.json'), 'utf8')).errors[0], 'synthetic second shard failure');
    await assert.rejects(stat(join(saved, 'shard-2', 'artifacts', 'private-link')), {code:'ENOENT'});
    const receipt = JSON.parse(await readFile(join(saved, 'diagnostics.json'), 'utf8'));
    assert.equal(receipt.admission_evidence, false);
    await mkdir(temp);
    await cleanupE2ePass(temp, join(root, 'success.json'), 'default', false);
    await assert.rejects(stat(temp), { code: 'ENOENT' });
    await assert.rejects(stat(join(root, 'success.json.failure-artifacts')), { code: 'ENOENT' });
  });
});

test('diagnostic saturation preserves listing and both reports before bounded optional artifacts', async () => {
  await withFixture(async root => {
    const temp = join(root, 'scratch'), output = join(root, 'result.json');
    await mkdir(join(temp, 'artifacts'), { recursive: true });
    for (const path of ['listing.json', 'shard-1/report.json', 'shard-2/report.json']) {
      await mkdir(join(temp, path, '..'), { recursive: true });
      await writeFile(join(temp, path), JSON.stringify({ path }));
    }
    for (let index = 0; index < 3; index++) {
      const path = join(temp, 'artifacts', `large-${index}.zip`);
      await writeFile(path, '');
      await truncate(path, 50 * 1024 * 1024);
    }
    for (let index = 0; index < 600; index++) await writeFile(join(temp, 'artifacts', `entry-${index}`), '');
    await cleanupE2ePass(temp, output, 'default', true);
    const [run] = await readdir(output + '.failure-artifacts');
    const saved = join(output + '.failure-artifacts', run);
    for (const path of ['listing.json', 'shard-1/report.json', 'shard-2/report.json']) {
      assert.deepEqual(JSON.parse(await readFile(join(saved, path), 'utf8')), { path });
    }
    const receipt = JSON.parse(await readFile(join(saved, 'diagnostics.json'), 'utf8'));
    assert.ok(receipt.bytes <= 128 * 1024 * 1024);
    assert.ok(receipt.copied <= 512);
    assert.ok(receipt.omitted > 0);
    // The oversized optional directory is omitted without scanning its tail.
    await assert.rejects(stat(join(saved, 'artifacts')), { code: 'ENOENT' });
    await assert.rejects(stat(temp), { code: 'ENOENT' });
  });
});

function failureReport(results) {
  return JSON.stringify({ suites: [{ specs: [{ tests: [{ results }] }] }] });
}
function failureResult(status, paths) {
  return { status, attachments: paths.map(path => ({ name: 'trace', path })) };
}
async function diagnosticRun(root) {
  const temp = join(root, 'scratch'), output = join(root, 'result.json');
  await cleanupE2ePass(temp, output, 'default', true);
  await assert.rejects(stat(temp), { code: 'ENOENT' });
  const [run] = await readdir(output + '.failure-artifacts');
  const saved = join(output + '.failure-artifacts', run);
  const receipt = JSON.parse(await readFile(join(saved, 'diagnostics.json'), 'utf8'));
  return { saved, receipt };
}

test('absolute failure traces survive 520 earlier screenshots that a lexical walk would keep first', async () => {
  await withFixture(async root => {
    const temp = join(root, 'scratch');
    const shots = join(temp, 'shard-1', 'artifacts');
    const traces = join(temp, 'shard-2', 'artifacts');
    await mkdir(shots, { recursive: true });
    await mkdir(traces, { recursive: true });
    for (let index = 0; index < 520; index++) await writeFile(join(shots, `aaa-${String(index).padStart(4, '0')}.png`), 'p');
    const passedShot = join(shots, 'zzz-passed.png');
    const failedTrace = join(traces, 'zzz-failed-trace.zip');
    const timedTrace = join(traces, 'zzz-timedout-trace.zip');
    const interruptedTrace = join(shots, 'zzz-interrupted-trace.zip');
    await writeFile(passedShot, 'passed-only');
    await writeFile(failedTrace, 'failed-trace');
    await writeFile(timedTrace, 'timedout-trace');
    await writeFile(interruptedTrace, 'interrupted-trace');
    await writeFile(join(traces, 'after-budget.png'), 'ordinary later-shard screenshot');
    await writeFile(join(root, 'private.txt'), 'must-not-leak');
    await symlink(join(root, 'private.txt'), join(traces, 'zzz-linked-trace.zip'));
    const outside = join(root, 'outside-trace.zip');
    await writeFile(outside, 'outside');
    await writeFile(join(temp, 'shard-2', 'report.json'), failureReport([
      failureResult('failed', [
        failedTrace,
        join(traces, 'zzz-linked-trace.zip'),
        outside,
        `${temp}/shard-2/artifacts/../../private.txt`,
        `${temp}/shard-2//artifacts/zzz-failed-trace.zip`,
      ]),
      failureResult('passed', [passedShot]),
    ]));
    await writeFile(join(temp, 'shard-1', 'report.json'), failureReport([
      failureResult('timedOut', [timedTrace]),
      failureResult('interrupted', [interruptedTrace]),
    ]));
    const { saved, receipt } = await diagnosticRun(root);
    assert.equal(await readFile(join(saved, 'shard-2', 'artifacts', 'zzz-failed-trace.zip'), 'utf8'), 'failed-trace');
    assert.equal(await readFile(join(saved, 'shard-2', 'artifacts', 'zzz-timedout-trace.zip'), 'utf8'), 'timedout-trace');
    assert.equal(await readFile(join(saved, 'shard-1', 'artifacts', 'zzz-interrupted-trace.zip'), 'utf8'), 'interrupted-trace');
    assert.equal(JSON.parse(await readFile(join(saved, 'shard-2', 'report.json'), 'utf8')).suites[0].specs[0].tests[0].results[0].status, 'failed');
    const keptShots = (await readdir(join(saved, 'shard-1', 'artifacts'))).filter(name => name.startsWith('aaa-'));
    assert.deepEqual(keptShots, []);
    await assert.rejects(stat(join(saved, 'shard-1', 'artifacts', 'zzz-passed.png')), { code: 'ENOENT' });
    await assert.rejects(stat(join(saved, 'shard-2', 'artifacts', 'zzz-linked-trace.zip')), { code: 'ENOENT' });
    await assert.rejects(stat(join(saved, 'shard-2', 'artifacts', 'after-budget.png')), { code: 'ENOENT' });
    await assert.rejects(stat(join(saved, 'outside-trace.zip')), { code: 'ENOENT' });
    await assert.rejects(stat(join(saved, 'private.txt')), { code: 'ENOENT' });
    assert.ok(receipt.copied <= 512);
    assert.ok(receipt.bytes <= 128 * 1024 * 1024);
    assert.ok(receipt.omitted > 0);
    assert.equal(receipt.admission_evidence, false);
  });
});

test('non-sharded report.json failures stay ahead of later screenshots', async () => {
  await withFixture(async root => {
    const temp = join(root, 'scratch');
    const shots = join(temp, 'artifacts');
    await mkdir(shots, { recursive: true });
    for (let index = 0; index < 520; index++) await writeFile(join(shots, `aaa-${String(index).padStart(4, '0')}.png`), 'p');
    const trace = join(shots, 'zzz-root-trace.zip');
    await writeFile(trace, 'root-failed-trace');
    await writeFile(join(temp, 'report.json'), failureReport([failureResult('failed', [trace])]));
    const { saved, receipt } = await diagnosticRun(root);
    assert.equal(await readFile(join(saved, 'artifacts', 'zzz-root-trace.zip'), 'utf8'), 'root-failed-trace');
    assert.deepEqual((await readdir(join(saved, 'artifacts'))).filter(name => name.startsWith('aaa-')), []);
    assert.equal(JSON.parse(await readFile(join(saved, 'report.json'), 'utf8')).suites[0].specs[0].tests[0].results[0].status, 'failed');
    assert.ok(receipt.copied <= 512);
    assert.ok(receipt.bytes <= 128 * 1024 * 1024);
    assert.ok(receipt.omitted > 0);
    assert.equal(receipt.admission_evidence, false);
  });
});

test('over-deep attachments and symlink ancestors stay out of diagnostics', async () => {
  await withFixture(async root => {
    const temp = join(root, 'scratch');
    const shots = join(temp, 'artifacts');
    const deep = join(shots, 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8');
    await mkdir(deep, { recursive: true });
    await writeFile(join(shots, 'ok-trace.zip'), 'visible-trace');
    await writeFile(join(deep, 'too-deep.zip'), 'too-deep');
    await mkdir(join(root, 'outside'));
    await writeFile(join(root, 'outside', 'trace.zip'), 'leaked-bytes');
    await symlink(join(root, 'outside'), join(shots, 'link-parent'));
    await writeFile(join(temp, 'report.json'), failureReport([failureResult('failed', [
      join(shots, 'ok-trace.zip'),
      join(deep, 'too-deep.zip'),
      join(shots, 'link-parent', 'trace.zip'),
    ])]));
    const { saved } = await diagnosticRun(root);
    assert.equal(await readFile(join(saved, 'artifacts', 'ok-trace.zip'), 'utf8'), 'visible-trace');
    await assert.rejects(stat(join(saved, 'artifacts', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'too-deep.zip')), { code: 'ENOENT' });
    await assert.rejects(stat(join(saved, 'artifacts', 'link-parent', 'trace.zip')), { code: 'ENOENT' });
  });
});
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

test('CLI ignores candidate filters, includes new specs and isolates concurrent default state', async () => {
  await withFixture(async root => {
    await playwrightFixture(root, `
    const origin='http://127.0.0.1:'+process.env.FREEDOM_E2E_PORT;
    const fixture=['PRIVATE_AI','AVATAR_ASSET','MESSAGE_IMAGE','STORE_PHOTO','NOTIFICATION_PREFERENCES'].some(name=>process.env['FREEDOM_E2E_'+name+(name==='NOTIFICATION_PREFERENCES'?'':'_FIXTURE')]==='1');
    export default {
      testDir: './empty', testMatch: /never-matches/, testIgnore: ['**/admin*.spec.ts'],
      grep: /smoke/, grepInvert: /required/, shard: { total: 4, current: 1 }, retries: 2, forbidOnly: false,
      captureGitInfo: { commit: true, diff: true },
      use:{baseURL:origin},
      ...(!fixture?{webServer:{command:'node fixture-http.mjs',url:origin+'/health',reuseExistingServer:false,gracefulShutdown:{signal:'SIGTERM',timeout:5000}}}:{}),
      projects: [{ name: 'chromium', grep: /smoke/, testDir: './empty', testIgnore: '**/*.spec.ts' },
        { name: 'extra', testMatch: /nothing/ }]
    };`);
    await writeFile(join(root,'fixture-http.mjs'),`
      import {createServer} from 'node:http';
      let value;
      createServer(async(req,res)=>{
        if(req.method==='POST'){let body='';for await(const part of req)body+=part;value=JSON.parse(body).value;}
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify({value}));
      }).listen(Number(process.env.FREEDOM_E2E_PORT),'127.0.0.1');
    `);
    const isolatedFiles=['aa-state-isolation.spec.ts','zz-state-isolation.spec.ts'];
    for(const [index,file] of isolatedFiles.entries())await writeFile(join(root,'tests/e2e',file),`
      import {test,expect} from '@playwright/test';
      import {existsSync,writeFileSync} from 'node:fs';
      test('same member state stays isolated across simultaneous default shards',async({request})=>{
        const mine=${JSON.stringify(String(index))};
        await request.post('/state',{data:{value:mine}});
        writeFileSync(${JSON.stringify(join(root,`arrived-${index}`))},'ready');
        await expect.poll(()=>existsSync(${JSON.stringify(join(root,`arrived-${1-index}`))}),{timeout:10000}).toBe(true);
        expect((await (await request.get('/state')).json()).value).toBe(mine);
      });
    `);
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
    assert.equal(result.test_count, 2 * (E2E_BASELINE.length + 1) + 2);
    assert.equal(result.test_files.length, E2E_BASELINE.length + 3);
    assert.ok(result.test_files.every(file => file.counts.tests === (isolatedFiles.some(name=>file.path.endsWith('/'+name))?1:2) && file.counts.passed === file.counts.tests));
    assert.deepEqual(result.passes.map(pass => pass.exit_code), [0, 0, 0, 0, 0, 0]);
  });
});

test('zero-exit real shards with conditional inventory stop immediately and retain their actual evidence', async () => {
  await withFixture(async root => {
    await playwrightFixture(root, "export default { projects: [{ name: 'chromium' }] };");
    const starts = join(root, 'executed.jsonl');
    for (const file of E2E_BASELINE) await writeFile(join(root, file), `
      import { test } from '@playwright/test';
      import { appendFileSync, writeFileSync, symlinkSync, existsSync, mkdirSync } from 'node:fs';
      import { dirname, join } from 'node:path';
      test('conditional inventory '+(process.env.FREEDOM_E2E_PORT??'listing'), () => {
        const mode=['PRIVATE_AI_FIXTURE','AVATAR_ASSET_FIXTURE','MESSAGE_IMAGE_FIXTURE','STORE_PHOTO_FIXTURE','NOTIFICATION_PREFERENCES']
          .find(name=>process.env['FREEDOM_E2E_'+name]==='1')??'default';
        appendFileSync(${JSON.stringify(starts)},JSON.stringify({mode,scratch:dirname(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE)})+'\\n');
        const directory=dirname(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE);
        mkdirSync(join(directory,'artifacts'),{recursive:true});
        const link=join(directory,'artifacts','private-link');
        if(!existsSync(link))symlinkSync(${JSON.stringify(join(root, 'private.txt'))},link);
        writeFileSync(join(directory,'last-run.json'),'{"status":"passed"}');
      });
    `);
    await writeFile(join(root, 'private.txt'), 'must not be retained');
    const output = join(root, 'result.json'), child = invoke(['--root', root, '--output', output]);
    assert.equal(child.status, 1, child.stdout + child.stderr);
    const result = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'case_listing_mismatch');
    assert.deepEqual(result.passes.map(pass => pass.id), ['default']);
    assert.deepEqual(result.passes[0].partitions.map(part => part.exit_code), [0, 0]);
    const executions = (await readFile(starts, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual([...new Set(executions.map(item => item.mode))], ['default']);
    for (const scratch of new Set(executions.map(item => item.scratch))) await assert.rejects(stat(scratch), { code: 'ENOENT' });
    const [run] = await readdir(output + '.failure-artifacts'), saved = join(output + '.failure-artifacts', run);
    const listing = await readFile(join(saved, 'listing.json'));
    assert.equal(createHash('sha256').update(listing).digest('hex'), result.passes[0].listing_evidence_sha256);
    assert.equal(JSON.parse(listing).config.shard, null);
    for (const part of result.passes[0].partitions) {
      const bytes = await readFile(join(saved, `shard-${part.current}/report.json`));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), part.evidence_sha256);
      assert.deepEqual(JSON.parse(bytes).config.shard, { current: part.current, total: part.total });
      await assert.rejects(stat(join(saved, `shard-${part.current}/artifacts/private-link`)), { code: 'ENOENT' });
    }
    const receipt = JSON.parse(await readFile(join(saved, 'diagnostics.json'), 'utf8'));
    assert.equal(receipt.admission_evidence, false);
    assert.ok(receipt.omitted > 0);
    assert.ok(receipt.bytes <= 128 * 1024 * 1024);
    assert.ok(receipt.copied <= 512);
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

test('a failed default shard cancels its live peer and never starts a fixture pass', async()=>{
  await withFixture(async root=>{
    await baseline(root);
    const runnerDir=join(root,'node_modules/@playwright/test');
    await mkdir(runnerDir,{recursive:true});
    await writeFile(join(runnerDir,'package.json'),JSON.stringify({exports:{'./cli':'./cli.cjs'}}));
    const ready=join(root,'peer-ready'),stopped=join(root,'peer-stopped'),starts=join(root,'starts');
    await writeFile(join(runnerDir,'cli.cjs'),`
      ${lifecycleListing(root)}
      const fs=require('node:fs'),part=process.argv[process.argv.indexOf('--shard')+1];
      fs.appendFileSync(${JSON.stringify(starts)},part+'\\n');
      const result=()=>fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE,JSON.stringify({}));
      if(part==='1/2'){
        const timer=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(ready)}))return;clearInterval(timer);result();process.exit(1);},10);
      }else{
        process.on('SIGINT',()=>{fs.writeFileSync(${JSON.stringify(stopped)},'terminated');result();process.exit(0);});
        fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);
      }
    `);
    const output=join(root,'result.json'),child=invoke(['--root',root,'--output',output]);
    assert.equal(child.status,1,child.stdout+child.stderr);
    assert.equal(await readFile(stopped,'utf8'),'terminated');
    assert.deepEqual((await readFile(starts,'utf8')).trim().split('\n').sort(),['1/2','2/2']);
    const result=JSON.parse(await readFile(output,'utf8'));
    assert.equal(result.status,'failed');assert.equal(result.reason,'test_process_failed');
    assert.deepEqual(result.passes.map(pass=>pass.id),['default']);
    assert.deepEqual(result.passes[0].partitions.map(part=>part.exit_code),[1,0]);
  });
});

test('CLI cancellation interrupts Playwright and retains test_cancelled with a zero child exit', async () => {
  await withFixture(async root => {
    await baseline(root);
    const runnerDir = join(root, 'node_modules/@playwright/test');
    await mkdir(runnerDir, { recursive: true });
    await writeFile(join(runnerDir, 'package.json'), JSON.stringify({ exports: { './cli': './cli.cjs' } }));
    const marker = join(root, 'terminated');
    await writeFile(join(runnerDir, 'cli.cjs'), `
      ${lifecycleListing(root)}
      const fs = require('node:fs');
      process.on('SIGINT', () => {
        fs.appendFileSync(${JSON.stringify(marker)},process.pid+'\\n');
        fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, JSON.stringify({
          config: { rootDir: ${JSON.stringify(join(root, 'tests/e2e'))} }, suites: [], errors: [],
          stats: { expected: 0, skipped: 0, unexpected: 0, flaky: 0 }
        }));
        process.exit(0);
      });
      console.log('fixture_runner_ready '+process.pid);
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
        if (!signalled && (stdout.match(/fixture_runner_ready \d+/g)??[]).length===2) { signalled = true; child.kill('SIGTERM'); }
      });
      const resultExit = await exit;
      clearTimeout(timer);
      assert.equal(resultExit.code, 1);
      assert.equal(resultExit.signal, null);
      assert.equal(new Set((await readFile(marker,'utf8')).trim().split('\n')).size,2);
      const result = JSON.parse(await readFile(output, 'utf8'));
      assert.equal(result.status, 'failed');
      assert.equal(result.reason, 'test_cancelled');
      assert.equal(result.passes[0].exit_code, 0);
    } finally { child.kill('SIGTERM'); }
  });
});

test('CLI cancellation tears down both real Playwright web servers before returning', async () => {
  await withFixture(async root => {
    await playwrightFixture(root, `
      const origin='http://127.0.0.1:'+process.env.FREEDOM_E2E_PORT;
      export default {timeout:45000,use:{baseURL:origin},
        webServer:{command:'node fixture-http.mjs',url:origin+'/health',reuseExistingServer:false,
          gracefulShutdown:{signal:'SIGTERM',timeout:5000}},projects:[{name:'chromium'}]};
    `);
    await writeFile(join(root,'fixture-http.mjs'),`
      import {createServer} from 'node:http';
      import {writeFileSync} from 'node:fs';
      const port=process.env.FREEDOM_E2E_PORT;
      const server=createServer((req,res)=>res.end('ok'));
      server.listen(Number(port),'127.0.0.1',()=>writeFileSync('server-'+port,String(process.pid)));
      process.on('SIGTERM',()=>{writeFileSync('stopped-'+port,'SIGTERM');server.close(()=>process.exit(0));});
    `);
    for(const file of E2E_BASELINE)await writeFile(join(root,file),`
      import {test} from '@playwright/test';
      test('pending operation',async()=>{
        console.log('native_cancel_ready '+process.env.FREEDOM_E2E_PORT);
        await new Promise(()=>{});
      });
    `);
    const output=join(root,'result.json');
    const child=spawn(process.execPath,[cli,'--root',root,'--output',output],{
      env:cliEnv,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'
    });
    let timer,stdout='',stderr='',signalled=false;
    try{
      const exit=new Promise((done,reject)=>{
        child.once('error',reject);child.once('close',(code,signal)=>done({code,signal}));
        timer=setTimeout(()=>reject(Error('real Playwright cancellation did not finish')),30000);
      });
      child.stderr.on('data',bytes=>{stderr+=bytes;});
      child.stdout.on('data',bytes=>{
        stdout+=bytes;
        if(!signalled&&E2E_DEFAULT_SHARDS.every(({port})=>stdout.includes('native_cancel_ready '+port))){
          signalled=true;child.kill('SIGTERM');
        }
      });
      const resultExit=await exit;
      assert.equal(signalled,true,stdout+stderr);
      assert.deepEqual(resultExit,{code:1,signal:null});
      const result=JSON.parse(await readFile(output,'utf8'));
      assert.equal(result.status,'failed');assert.equal(result.reason,'test_cancelled');
      assert.deepEqual(result.passes.map(pass=>pass.id),['default']);
      for(const {port} of E2E_DEFAULT_SHARDS){
        assert.equal(await readFile(join(root,'stopped-'+port),'utf8'),'SIGTERM');
        const pid=Number(await readFile(join(root,'server-'+port),'utf8'));
        assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
      }
    }finally{
      clearTimeout(timer);
      try{process.kill(process.platform==='win32'?child.pid:-child.pid,'SIGKILL');}catch{}
      // A failing cleanup regression must not leave its own HTTP fixture behind.
      for(const {port} of E2E_DEFAULT_SHARDS){
        try{process.kill(Number(await readFile(join(root,'server-'+port),'utf8')),'SIGTERM');}catch{}
      }
    }
  });
});

test('host pass budgets are finite and only the default capacity increases', async () => {
  assert.deepEqual(E2E_PASS_TIMEOUT_MS, {
    default: 60 * 60 * 1000,
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
  assert.match(ui, /timeout-minutes: 75\b/);
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
      ${lifecycleListing(root)}
      const fs = require('node:fs');
      fs.appendFileSync(${JSON.stringify(starts)}, process.pid+'\\n');
      process.on('SIGINT', () => {
        fs.appendFileSync(${JSON.stringify(marker)}, process.pid+'\\n');
        fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, JSON.stringify({
          config: { rootDir: ${JSON.stringify(join(root, 'tests/e2e'))} }, suites: [], errors: [],
          stats: { expected: 0, skipped: 0, unexpected: 0, flaky: 0 }
        }));
        process.exit(0);
      });
      fs.appendFileSync(${JSON.stringify(ready)}, process.pid+'\\n');
      setInterval(() => {}, 1000);
    `);
    // Test-only clock acceleration. Production has no argument/environment budget override.
    // Return a native timer handle, so the runner's clearTimeout still cancels it.
    // The real 20-second SIGKILL escalation timer is deliberately not intercepted.
    await writeFile(preload, `
      import { existsSync, readFileSync, appendFileSync } from 'node:fs';
      import { setTimeout as realTimeout, setInterval, clearInterval } from 'node:timers';
      globalThis.setTimeout = (callback, delay, ...args) => {
        if (delay <= 60000 || delay > ${E2E_PASS_TIMEOUT_MS.default}) return realTimeout(callback, delay, ...args);
        appendFileSync(${JSON.stringify(observed)}, delay+'\\n');
        const timer = setInterval(() => {
          if (!existsSync(${JSON.stringify(ready)}) || readFileSync(${JSON.stringify(ready)},'utf8').trim().split('\\n').length !== 2) return;
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
    const budgets=(await readFile(observed,'utf8')).trim().split('\n').map(Number);
    assert.equal(budgets.length,2);assert.ok(budgets.every(delay=>delay>60000&&delay<E2E_PASS_TIMEOUT_MS.default));
    const started=(await readFile(starts,'utf8')).trim().split('\n').sort();
    const stopped=(await readFile(marker,'utf8')).trim().split('\n').sort();
    assert.equal(new Set(started).size,2);assert.deepEqual(stopped,started);
    const result = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'test_timeout');
    assert.deepEqual(result.passes.map(({ id, exit_code }) => ({ id, exit_code })), [{ id: 'default', exit_code: 0 }]);
  });
});




function guidePasses() {
  return E2E_PLAN.map((pass,index) => {
    const files=index===0?GUIDE_DEFAULT_FILES:pass.files;
    const result=report(files.map(file=>suite(file.slice('tests/e2e/'.length),[['one','expected'],['two','expected']])));
    return {id:pass.id,exit_code:0,report:result,listing:structuredClone(result),listing_exit_code:0,listing_evidence_sha256:'a'.repeat(64)};
  });
}
const evaluateGuide = passes => evaluateE2ePasses(GUIDE_DEFAULT_FILES,passes,{rootDir,configFile,profile:'newcomer-guides'});

test('guide selection owns exact files and retains every dedicated fixture and default OFF coverage', () => {
  const selected=planE2eSelection('newcomer-guides',[...E2E_BASELINE,...GUIDE_DEFAULT_FILES]);
  assert.equal(selected.profile,'newcomer-guides');
  assert.deepEqual(selected.expectedFiles,GUIDE_DEFAULT_FILES);
  assert.deepEqual(selected.plan[0].files,GUIDE_DEFAULT_FILES);
  assert.deepEqual(selected.plan.slice(1),E2E_PLAN.slice(1));
  for (const file of ['newcomer-guides','ai-sister-guides','navigation-audit','audit-shell','member-session-lifecycle',
    'session-recovery','journeys','onboarding-members','member-experience','page-tools','page-tools-notification'])
    assert.ok(GUIDE_DEFAULT_FILES.includes('tests/e2e/'+file+'.spec.ts'));
  for (const pass of E2E_PLAN.slice(1)) for (const file of pass.files) assert.ok(selected.plan[0].files.includes(file));
  for (const profile of [undefined,'','unknown','full']) assert.deepEqual(planE2eSelection(profile,E2E_BASELINE).plan,E2E_PLAN);
  assert.equal(planE2eSelection('newcomer-guides',[]).profile,'full');
  assert.equal(evaluateGuide(guidePasses()).status,'passed');
});

test('guide per-pass enumeration rejects missing/additional cases, wrong counts and absent evidence', () => {
  for (const mutate of [
    passes=>passes[0].report.suites[0].suites[0].suites[0].specs.pop(),
    passes=>{passes[0].report.suites[0].suites[0].suites[0].specs.pop();passes[0].report.stats.expected--;},
    passes=>passes[0].report.stats.expected++,
    passes=>passes[0].report.suites[0].suites[0].suites[0].specs.push(spec(GUIDE_DEFAULT_FILES[0].slice(10),'extra','expected')),
    passes=>delete passes[0].listing,
    passes=>passes[0].listing_exit_code=1,
    passes=>passes[0].listing_evidence_sha256='',
    passes=>passes[1].listing.suites=[],
    passes=>passes[0].report.suites.pop(),
    passes=>passes[1].report.suites.push(suite('newcomer-guides.spec.ts',[])),
  ]) { const passes=guidePasses();mutate(passes);assert.equal(evaluateGuide(passes).status,'failed'); }
  const omitted=GUIDE_DEFAULT_FILES.slice(1);
  assert.equal(evaluateE2ePasses(omitted,guidePasses(),{rootDir,configFile,profile:'newcomer-guides'}).reason,'invalid_expected_files');
});

test('CLI derives guide selection from clean host-bound integration and lists every executed case', async () => {
  await withFixture(async root => {
    await playwrightFixture(root, "export default {grep:/never/,testIgnore:['**/*'],projects:[{name:'chromium'}]};");
    for (const file of GUIDE_DEFAULT_FILES) await writeFile(join(root,file),ordinaryTests);
    const metadata = (id,paths,dependencies,tests) => ({format:'freedom.module/v1',module_id:id,owner_role:'foundation',
      owned_paths:paths,dependencies,tests,public_exports:[],contract_families:['preview'],client_profiles:['member'],
      instructions:['governance/README.md'],invariants:['local-only'],surfaces:[]});
    const leaf='apps/portal-web/src/modules/newcomer-guides/GuideHost.tsx';
    const paths=['GuideHost.tsx','engine/GuideEngine.tsx','engine/GuideGallery.tsx','engine/page-spirit.css']
      .map(path=>'apps/portal-web/src/modules/newcomer-guides/'+path);
    const descriptors = [metadata('newcomer-guides',[...paths,'tests/e2e/newcomer-guides.spec.ts','tests/e2e/ai-sister-guides.spec.ts'],['public-guide-assets'],['runtime.full']),
      metadata('public-guide-assets',['packages/public-guide-assets/**'],[],['runtime.full']),
      metadata(GUIDE_COMPOSITION_PROFILE.module,[...GUIDE_COMPOSITION_PROFILE.files,'tests/runtime/game-console-routing.test.ts'],[...GUIDE_COMPOSITION_PROFILE.dependencies],['runtime.full'])];
    for (const id of GUIDE_COMPOSITION_PROFILE.dependencies) if (!descriptors.some(x=>x.module_id===id))
      descriptors.push(metadata(id,[`modules/${id}/**`],[],['runtime.full']));
    for (const descriptor of descriptors) {
      const dir=join(root,'modules',descriptor.module_id);await mkdir(dir,{recursive:true});
      await writeFile(join(dir,'freedom.module.json'),JSON.stringify(descriptor));
    }
    await mkdir(join(root,'apps/portal-web/src/modules/newcomer-guides'),{recursive:true});
    await writeFile(join(root,leaf),'before');await writeFile(join(root,'.gitignore'),'node_modules\nresult.json\n');
    const git=(args,input)=>execFileSync('/usr/bin/git',['-C',root,'-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null',...args],{
      input,encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',
        GIT_AUTHOR_NAME:'Guide Test',GIT_AUTHOR_EMAIL:'guide@example.invalid',GIT_COMMITTER_NAME:'Guide Test',GIT_COMMITTER_EMAIL:'guide@example.invalid'},
    }).trim();
    git(['init','-q','-b','main']);git(['add','.']);git(['commit','-qm','base']);const base=git(['rev-parse','HEAD']);
    await writeFile(join(root,leaf),'after');git(['add','.']);git(['commit','-qm','guide']);const head=git(['rev-parse','HEAD']);
    const candidate=git(['commit-tree',git(['rev-parse','HEAD^{tree}']),'-p',base,'-p',head],'integration\n');git(['checkout','-q',candidate]);
    const output=join(root,'result.json');
    const child=invoke(['--root',root,'--output',output,'--event','pull_request','--base',base,'--head',head,'--candidate',candidate],
      {FREEDOM_E2E_PROFILE:'full',FREEDOM_E2E_PRIVATE_AI_FIXTURE:'1',FREEDOM_E2E_MESSAGE_IMAGE_FIXTURE:'1'});
    assert.equal(child.status,0,child.stdout+child.stderr);
    const result=JSON.parse(await readFile(output,'utf8'));
    assert.equal(result.selection.profile,'newcomer-guides',JSON.stringify(result.selection));
    assert.deepEqual(result.selected_files,GUIDE_DEFAULT_FILES);
    assert.equal(result.test_count,GUIDE_DEFAULT_FILES.length*2);
    assert.equal(result.passes.length,E2E_PLAN.length);
    assert.ok(result.passes.every(pass=>/^[a-f0-9]{64}$/.test(pass.listing_evidence_sha256)));
    assert.ok(result.passes.every(pass=>pass.listed_case_count===pass.cases.length
      && pass.cases.every(item=>/^[a-f0-9]{64}$/.test(item.case_sha256)&&item.status==='passed')));
    assert.ok(!JSON.stringify(result).includes('smoke'));
    assert.equal(invoke(['--root',root,'--profile','newcomer-guides']).status,2);
  });
});


test('Guild integration plan covers exactly the reviewed composition, contract and permission journeys', () => {
  const files = [...GUILD_PRESENTATION_PROFILE.integrationFiles].sort();
  const plan = planE2eSelection('guild-presentation', [...files, ...expectedFiles]);
  assert.equal(plan.profile, 'guild-presentation');
  assert.deepEqual(plan.expectedFiles, files);
  assert.equal(plan.plan.length, 1);
  assert.equal(planE2eSelection('guild-presentation', files.slice(1)).profile, 'full');
  const results = report(files.map(path => suite(path.slice('tests/e2e/'.length), [['required scenario', 'expected']])));
  const clean = () => [{id: 'default', exit_code: 0, evidence_sha256: 'a'.repeat(64), report: structuredClone(results),
    listing: structuredClone(results), listing_exit_code: 0, listing_evidence_sha256: 'b'.repeat(64)}];
  const check = passes => evaluateE2ePasses(files, passes, {rootDir, configFile, profile: 'guild-presentation'});
  assert.equal(check(clean()).status, 'passed');
  for (const mutate of [
    passes => passes.pop(),
    passes => passes.push(structuredClone(passes[0])),
    passes => { passes[0].report.suites.pop(); passes[0].report.stats.expected--; },
    passes => { passes[0].listing.suites.pop(); },
    passes => { passes[0].listing_exit_code = 1; },
    passes => { passes[0].exit_code = 1; },
    passes => { const test=passes[0].report.suites[0].suites[0].suites[0].specs[0].tests[0]; Object.assign(test,state('skipped')); passes[0].report.stats.expected--; passes[0].report.stats.skipped++; },
  ]) { const passes=clean();mutate(passes);assert.equal(check(passes).status,'failed'); }
  assert.equal(evaluateE2ePasses(files.slice(1),clean(),{rootDir,configFile,profile:'guild-presentation'}).status,'failed');
});


test('Guild preview requires every listed case from all three reviewed module files', () => {
  const files=[...GUILD_PRESENTATION_PROFILE.previewFiles].sort();
  const events='modules/guild-events/EventsBlock.spec.ts';
  assert.ok(files.includes(events));
  const results=report(files.map(path=>suite(path.slice('modules/'.length), [['preview scenario','expected']])));
  const clean=()=>[{id:'default',exit_code:0,evidence_sha256:'a'.repeat(64),report:structuredClone(results),
    listing:structuredClone(results),listing_exit_code:0,listing_evidence_sha256:'b'.repeat(64)}];
  const check=passes=>evaluateE2ePasses(files,passes,{rootDir,configFile,profile:'guild-preview'});
  assert.equal(check(clean()).status,'passed');
  for(const mutate of [
    passes=>{passes[0].report.suites[0].file='../guild-supply/CatalogBlock.spec.ts';},
    passes=>{passes[0].report.suites.pop();passes[0].report.stats.expected--;},
    passes=>{passes[0].listing.suites.pop();},
    passes=>{passes[0].report.config.forbidOnly=false;},
    passes=>{passes[0].report.config.projects[0].testDir='/wrong';},
  ]) {const passes=clean();mutate(passes);assert.equal(check(passes).status,'failed');}
  assert.equal(evaluateE2ePasses(files.filter(file=>file!==events),clean(),{rootDir,configFile,profile:'guild-preview'}).status,'failed');
  const withoutEvents=clean();withoutEvents[0].report.suites=withoutEvents[0].report.suites.filter(suite=>suite.file!=='guild-events/EventsBlock.spec.ts');
  withoutEvents[0].report.stats.expected--;assert.equal(check(withoutEvents).status,'failed');
  assert.equal(evaluateE2ePasses([...files,'modules/other/WorksBlock.spec.ts'],clean(),{rootDir,configFile,profile:'guild-preview'}).status,'failed');
});
