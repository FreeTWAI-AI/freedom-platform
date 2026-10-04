import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, unlink, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { runLocalSuite, runLocalSuites } from '../verify.mjs';
import { isDisposableDatabaseUrl } from '../suite-runner.mjs';
import { FULL_RUNTIME_BASELINE, RUNTIME_SUITES } from '../runtime-suites.mjs';
import { fixtureRoot, put } from './fixtures.mjs';

// No database connection: fixture tests assert the supplied environment only.
const database = 'postgresql://postgres@localhost/fp_fixture?host=%2Ftmp%2Ffp-fixture';
const simple = "import {test} from 'node:test'; test('synthetic', () => {});\n";
const runtimeOptions = { testDatabaseUrl: database, runtimeShards: 1 };
async function runtimeFixture(t, id = 'runtime.command-core', source = simple) {
  const root = await fixtureRoot(t);
  for (const path of RUNTIME_SUITES[id]) await put(root, path, source);
  return root;
}

test('runtime requires an explicitly supplied local fp database; unsafe URL controls are rejected', async t => {
  const root = await runtimeFixture(t);
  for (const url of [undefined, '', 'postgresql://postgres@remote.example/fp_fixture',
    'postgresql://postgres@localhost/production', 'postgresql://postgres@localhost/fp_fixture?options=-csearch_path=public',
    database + '&host=%2Fother', database + '&dbname=production', database + '#secret',
    'postgresql://postgres:secret@localhost/fp_fixture', 'postgresql://postgres@localhost/fp_fixture?host=remote.example',
    'postgresql://postgres@localhost/fp_fixture?host=%2Ftmp%2F..%2Fother',
    'postgresql://postgres@localhost/fp_fixture?host=%2Ftmp%00bad']) {
    assert.equal(isDisposableDatabaseUrl(url), false);
    const result = await runLocalSuite(root, 'runtime.command-core', { testDatabaseUrl: url });
    assert.equal(result.status, 'not_run'); assert(!('test_count' in result));
    assert(!JSON.stringify(result).includes('secret'));
  }
  for (const url of [database, 'postgres://postgres@127.0.0.1:5444/fp_fixture', 'postgresql://postgres@[::1]/fp_fixture']) assert(isDisposableDatabaseUrl(url));
});

test('reviewed consumer adapter runs all direct MJS cases without producer DB or package hooks', async t => {
  const root = await fixtureRoot(t);
  await put(root, 'tests/workspace.test.mjs', `import {test} from 'node:test'; import assert from 'node:assert/strict';
test('consumer env',()=>{for(const name of ['TEST_DATABASE_URL','NODE_OPTIONS','GITHUB_TOKEN','DATABASE_URL','PGPASSWORD'])assert.equal(process.env[name],undefined);});`);
  await put(root, 'tests/new-consumer.test.mjs', simple);
  await put(root, 'package.json', JSON.stringify({ scripts: { pretest: 'exit 99', test: 'exit 99' } }));
  const results = await runLocalSuites(root, ['consumer.agent-kit', 'consumer.agent-kit'], runtimeOptions);
  assert.equal(results.length, 1); assert.equal(results[0].status, 'passed'); assert.equal(results[0].test_count, 2);
  assert.deepEqual(results[0].selected_files, ['tests/new-consumer.test.mjs', 'tests/workspace.test.mjs']);
  assert(!JSON.stringify(results).includes(database));
});

test('consumer baseline deletion, symlink, empty and skipped cases never pass', async t => {
  const root = await fixtureRoot(t);
  await put(root, 'tests/extra.test.mjs', simple);
  assert.equal((await runLocalSuite(root, 'consumer.agent-kit')).reason, 'suite_files_unavailable');
  await put(root, 'tests/workspace.test.mjs', '');
  assert.equal((await runLocalSuite(root, 'consumer.agent-kit')).status, 'failed');
  await put(root, 'tests/workspace.test.mjs', "import {test,describe} from 'node:test'; test('okay',()=>{}); describe.skip('private-suite',()=>{});");
  assert.equal((await runLocalSuite(root, 'consumer.agent-kit')).status, 'failed');
  await unlink(join(root, 'tests/workspace.test.mjs'));
  await symlink(join(root, 'tests/extra.test.mjs'), join(root, 'tests/workspace.test.mjs'));
  assert.equal((await runLocalSuite(root, 'consumer.agent-kit')).reason, 'suite_files_unavailable');
  assert.equal((await runLocalSuite(root, 'consumer.exec-arbitrary')).reason, 'suite_adapter_unavailable');
});

test('runtime fixed argv executes TypeScript with clean environment and no package hooks', async t => {
  const root = await runtimeFixture(t, 'runtime.command-core', `
import {test} from 'node:test'; import assert from 'node:assert/strict';
const typed: number = 2;
test('synthetic-private-case-name', () => {
  assert.equal(typed, 2); assert.equal(process.env.TEST_DATABASE_URL, ${JSON.stringify(database)});
  for (const name of ['NODE_OPTIONS','GITHUB_TOKEN','DATABASE_URL','PGHOST','PGPASSWORD','NODE_EXTRA_CA_CERTS']) assert.equal(process.env[name], undefined);
});`);
  await put(root, 'package.json', JSON.stringify({ scripts: { test: 'exit 99', pretest: 'exit 99' } }));
  const names = ['NODE_OPTIONS', 'GITHUB_TOKEN', 'DATABASE_URL', 'PGHOST', 'PGPASSWORD', 'NODE_EXTRA_CA_CERTS'];
  const saved = names.map(name => process.env[name]);
  for (const name of names) process.env[name] = 'synthetic-private-environment';
  let result;
  try { result = await runLocalSuite(root, 'runtime.command-core', runtimeOptions); }
  finally { names.forEach((name, index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]; }); }
  assert.equal(result.status, 'passed'); assert.equal(result.test_count, 1);
  assert.equal(result.test_files[0].path, 'tests/runtime/command-core.test.ts');
  assert.equal(result.test_files[0].cases[0].status, 'passed');
  assert(!JSON.stringify(result).includes('synthetic-private')); assert(!JSON.stringify(result).includes(database));
});

test('storefront adapter requires all three real baseline files and discovers new direct tests', async t => {
  const root = await fixtureRoot(t), baseline = ['read-client', 'storefront', 'templates'];
  for (const name of baseline) await put(root, `tests/${name}.test.mjs`, simple);
  await put(root, 'tests/new-case.test.mjs', simple);
  await put(root, 'package.json', JSON.stringify({ scripts: { pretest: 'exit 99', test: 'exit 99' } }));
  const ran = await runLocalSuite(root, 'consumer.storefront', runtimeOptions);
  assert.equal(ran.status, 'passed'); assert.equal(ran.test_count, 4);
  assert.deepEqual(ran.selected_files, ['tests/new-case.test.mjs', 'tests/read-client.test.mjs', 'tests/storefront.test.mjs', 'tests/templates.test.mjs']);
  for (const name of baseline) {
    await unlink(join(root, `tests/${name}.test.mjs`));
    assert.equal((await runLocalSuite(root, 'consumer.storefront')).reason, 'suite_files_unavailable');
    await put(root, `tests/${name}.test.mjs`, simple);
  }
  await put(root, 'tests/templates.test.mjs', "import{test}from'node:test';test.skip('not_run',()=>{});");
  assert.equal((await runLocalSuite(root, 'consumer.storefront')).status, 'failed');
});

test('missing runtime DB still runs governance; unknown IDs cannot supply commands', async t => {
  const root = await fixtureRoot(t);
  await put(root, 'packages/contribution-tools/test/local.test.mjs', simple);
  const results = await runLocalSuites(root, ['governance.unit', 'runtime.full', 'runtime.evil']);
  assert.equal(results.find(r => r.check_id === 'governance.unit').status, 'passed');
  assert.equal(results.find(r => r.check_id === 'runtime.full').reason, 'test_database_required');
  assert.equal(results.find(r => r.check_id === 'runtime.evil').reason, 'suite_adapter_unavailable');
});

test('full and subset union executes each file once and includes new runtime files', async t => {
  const root = await fixtureRoot(t);
  for (const path of FULL_RUNTIME_BASELINE) await put(root, path, simple);
  await put(root, 'tests/runtime/new-scope-080.test.ts', simple);
  await put(root, 'tests/runtime/command-core.test.ts', `import {test} from 'node:test'; import {writeFileSync} from 'node:fs';
test('once', () => writeFileSync('executed-once', 'once', {flag:'wx'}));`);
  const results = await runLocalSuites(root, ['runtime.full', 'runtime.command-core', 'runtime.command-core'], runtimeOptions);
  assert.equal(results.length, 2);
  for (const item of results) assert.equal(item.status, 'passed', JSON.stringify(item));
  const full = results.find(r => r.check_id === 'runtime.full'), subset = results.find(r => r.check_id === 'runtime.command-core');
  assert.equal(full.test_count, FULL_RUNTIME_BASELINE.length + 1); assert.equal(subset.test_count, 1);
  assert.equal(full.evidence_sha256, subset.evidence_sha256);
  assert(full.test_files.some(file => file.path.endsWith('/new-scope-080.test.ts')));
  assert.equal(await readFile(join(root, 'executed-once'), 'utf8'), 'once');
});

test('missing baseline, missing subset and symlink files never pass', async t => {
  const root = await runtimeFixture(t);
  assert.equal((await runLocalSuite(root, 'runtime.full', runtimeOptions)).reason, 'suite_files_unavailable');
  await unlink(join(root, 'tests/runtime/command-core.test.ts'));
  assert.equal((await runLocalSuite(root, 'runtime.command-core', runtimeOptions)).reason, 'suite_files_unavailable');
  await put(root, 'outside.ts', simple);
  await symlink(join(root, 'outside.ts'), join(root, 'tests/runtime/command-core.test.ts'));
  assert.equal((await runLocalSuite(root, 'runtime.command-core', runtimeOptions)).reason, 'suite_files_unavailable');
});

test('skip, TODO and assertion failure retain per-case counts without test text', async t => {
  const root = await runtimeFixture(t, 'runtime.command-core', `import {test} from 'node:test';
test('okay', () => {}); test.skip('private-skip', () => {}); test.todo('private-todo');
test('private-failure', () => { throw Error('private-error'); });`);
  const result = await runLocalSuite(root, 'runtime.command-core', runtimeOptions);
  assert.equal(result.status, 'failed'); assert.equal(result.test_count, 4);
  assert.deepEqual(result.test_files[0].counts, { tests: 4, passed: 1, failed: 1, cancelled: 0, skipped: 1, todo: 1 });
  assert.equal(result.test_files[0].cases.length, 4); assert(!JSON.stringify(result).includes('private-'));
});

test('empty, stdout pretend-pass, malformed process and timeout are failures', async t => {
  const root = await runtimeFixture(t);
  for (const source of ['', "console.log('{\"success\":true}');", 'process.exit(1);']) {
    await put(root, 'tests/runtime/command-core.test.ts', source);
    assert.equal((await runLocalSuite(root, 'runtime.command-core', runtimeOptions)).status, 'failed');
  }
  await put(root, 'tests/runtime/command-core.test.ts', "import {test} from 'node:test'; test('hang', async () => { await new Promise(() => setInterval(() => {},1000)); });");
  const timed = await runLocalSuite(root, 'runtime.command-core', { ...runtimeOptions, timeoutMs: 200 });
  assert.equal(timed.status, 'failed'); assert.equal(timed.reason, 'test_timeout');
  assert.equal((await runLocalSuite(root, 'runtime.command-core', { ...runtimeOptions, timeoutMs: 900_001 })).reason, 'invalid_suite_timeout');
});

test('nested real cases reconcile with file totals, suites are not fabricated tests', async t => {
  const root = await runtimeFixture(t, 'runtime.command-core', `import {test,describe} from 'node:test';
describe('suite', () => { test('case', async t => { await t.test('nested', () => {}); }); });`);
  const result = await runLocalSuite(root, 'runtime.command-core', runtimeOptions);
  assert.equal(result.status, 'passed'); assert.equal(result.test_count, 2); assert.equal(result.test_files[0].cases.length, 2);
  assert.equal(result.test_files[0].suite_events.length, 1);
});

test('skipped and TODO suites fail even when Node test-only skip counts are zero', async t => {
  const root = await runtimeFixture(t);
  for (const kind of ['skip', 'todo']) {
    await put(root, 'tests/runtime/command-core.test.ts', `import {test,describe} from 'node:test';
test('okay',()=>{}); describe.${kind}('private-suite-label',()=>{});`);
    const result = await runLocalSuite(root, 'runtime.command-core', runtimeOptions);
    assert.equal(result.status, 'failed'); assert.equal(result.test_count, 1);
    assert.equal(result.test_files[0].counts.skipped, 0); assert.equal(result.test_files[0].counts.todo, 0);
    assert.equal(result.test_files[0].suite_events[0].status, kind === 'skip' ? 'skipped' : 'todo');
    assert(!JSON.stringify(result).includes('private-suite-label'));
  }
});

test('timed-out and parent-cancelled cases retain cancellation evidence', async t => {
  const root = await runtimeFixture(t, 'runtime.command-core', `import {test} from 'node:test';
test('timed',{timeout:20},async()=>{await new Promise(resolve=>setTimeout(resolve,100));});
test('parent',{timeout:20},async t=>{await t.test('pending',()=>new Promise(resolve=>setTimeout(resolve,100)));});`);
  const result = await runLocalSuite(root, 'runtime.command-core', { ...runtimeOptions, timeoutMs: 3000 });
  assert.equal(result.status, 'failed'); assert.equal(result.test_count, 3, JSON.stringify(result));
  assert.equal(result.test_files[0].counts.cancelled, 3);
  assert.equal(result.test_files[0].cases.filter(item => item.status === 'cancelled').length, 3);
});

test('inconsistent Node abort file/global counts fail closed instead of inventing totals', async t => {
  const root = await runtimeFixture(t, 'runtime.command-core', `import {test} from 'node:test';
test('aborted',{signal:AbortSignal.abort()},()=>{});`);
  const result = await runLocalSuite(root, 'runtime.command-core', { ...runtimeOptions, timeoutMs: 3000 });
  assert.equal(result.status, 'failed');
  // Node24 may classify the same abort as cancelled in the file summary but
  // failed in its parent runner. Either consistent failed evidence or explicit
  // incomplete evidence is acceptable, never a synthesized successful result.
  assert(['test_process_failed', 'incomplete_test_results'].includes(result.reason));
  assert.deepEqual(result.selected_files, ['tests/runtime/command-core.test.ts']);
});
