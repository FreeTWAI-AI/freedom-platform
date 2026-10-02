import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, unlink, rename, symlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { buildContext, selectImpact, validateDescriptor } from '../context.mjs';
import { inspectWorkspace, resolveCommit } from '../workspace.mjs';
import { verifyWorkspace, runLocalSuite } from '../verify.mjs';
import { writeLocalArtifact } from '../local-artifacts.mjs';
import { verificationEnvironment } from '../process-env.mjs';
import { legacyFixture, fixtureRoot, put, copy, pretty } from './fixtures.mjs';

const descriptor = (id = 'governance', paths = ['packages/contribution-tools/**']) => ({
  format: 'freedom.module/v1', module_id: id, owner_role: 'foundation', owned_paths: paths,
  public_exports: [], dependencies: [], contract_families: ['preview'], client_profiles: ['member'],
  instructions: ['docs/rules.md'], invariants: ['no-secrets'], tests: ['governance.unit'], surfaces: [],
});
async function fixture(t) {
  const { root } = await legacyFixture(t);
  for (const path of ['AGENTS.md', 'README.md', 'CONTRIBUTING.md', 'docs/rules.md']) await put(root, path, '# Fixture\n\nOriginal mandatory rule.\n');
  await put(root, 'package.json', pretty({ name: 'freedom-platform' }));
  await put(root, '.gitignore', '.freedom/\n.env\n');
  await put(root, 'packages/contribution-tools/freedom.module.json', pretty(descriptor()));
  await put(root, 'packages/contribution-tools/value.mjs', 'export const value = 1;\n');
  await put(root, 'packages/contribution-tools/test/sample.test.mjs', "import {test} from 'node:test'; test('synthetic', () => {});\n");
  const git = args => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  git(['-c', 'init.templateDir=', 'init', '--quiet']);
  const commit = () => {
    git(['add', '.']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Synthetic baseline']);
    return git(['rev-parse', 'HEAD']);
  };
  const base = commit();
  git(['update-ref', 'refs/heads/baseline', base]);
  return { root, git, base, commit, options: { repositoryRoot: root, baseRef: 'baseline' } };
}

test('scope includes baseline glob, candidate rename and reverse dependencies', () => {
  const old = descriptor('assets', ['modules/assets/**']);
  const next = descriptor('assets', ['modules/renamed/**']);
  const page = descriptor('member-card', ['pages/card.tsx']); page.dependencies = ['assets']; page.tests = ['runtime.card'];
  const impact = selectImpact({ baseline: [old, page], candidate: [next, page], changedPaths: ['modules/assets/deleted.ts', 'modules/renamed/new.ts'] });
  assert.deepEqual(impact.module_ids, ['assets', 'member-card']);
  assert.deepEqual(impact.tests, ['governance.unit', 'runtime.card']);
  assert.deepEqual(impact.unknown_paths, []);
});
test('unknown code, queue and dynamic surfaces conservatively select all modules', () => {
  const modules = [descriptor('assets', ['modules/assets/**']), descriptor('work', ['modules/work/**'])];
  const impact = selectImpact({ baseline: modules, candidate: modules, changedPaths: ['new-queue/handler.ts'] });
  assert.deepEqual(impact.module_ids, ['assets', 'work']); assert.deepEqual(impact.unknown_paths, ['new-queue/handler.ts']);
  assert.throws(() => selectImpact({ baseline: modules, candidate: modules, changedPaths: [], scopes: ['unknown'] }), { code: 'unknown_module_scope' });
});

test('context includes deep-module rules, base and candidate text, without claiming comprehension', async t => {
  const f = await fixture(t);
  await put(f.root, 'docs/rules.md', '# Fixture\n\nCandidate rule changes.\n');
  const { context } = await buildContext({ ...f.options, requestedPaths: ['packages/contribution-tools/new/deep.mjs'] });
  const rules = context.documents.filter(doc => doc.path === 'docs/rules.md');
  assert.equal(rules.length, 2); assert.deepEqual(rules.map(doc => doc.revision), ['base', 'candidate']);
  assert(rules[0].content.includes('Original mandatory')); assert(rules[1].content.includes('Candidate rule'));
  assert.notEqual(rules[0].sha256, rules[1].sha256);
  assert.equal(context.assurance_level, 'local'); assert.equal(context.base_commit, f.base);
  assert(!('read_by_agent' in context)); assert.deepEqual(context.module_ids, ['governance']);
});

test('existing scoped Agent Kit package resolves local identity without granting trust', async t => {
  const f = await fixture(t);
  await put(f.root, 'package.json', pretty({ name: '@freetwai/agent-kit' }));
  const { context } = await buildContext(f.options);
  assert.equal(context.repository, 'FreeTWAI-AI/freedom-agent-kit');
  assert.equal(context.assurance_level, 'local');
  await put(f.root, 'package.json', pretty({ name: '@unreviewed/agent-kit' }));
  await assert.rejects(buildContext(f.options), { code: 'repository_identity_required' });
});

test('single-module consumer root descriptor participates in candidate and baseline context', async t => {
  const f = await fixture(t);
  await rename(join(f.root, 'packages/contribution-tools/freedom.module.json'), join(f.root, 'freedom.module.json'));
  const renamed = await buildContext({ ...f.options, scopes: ['governance'] });
  assert.deepEqual(renamed.context.module_ids, ['governance']);
  assert(!renamed.context.blockers.includes('candidate_governance_unavailable'));
  f.git(['update-ref', 'refs/heads/baseline', f.commit()]);
  const baseline = await buildContext({ ...f.options, scopes: ['governance'] });
  assert(!baseline.context.blockers.includes('baseline_governance_unavailable'));
  assert.deepEqual(baseline.context.tests, ['governance.unit']);
});

test('unchanged mandatory content is deduplicated; generated context is not source state', async t => {
  const f = await fixture(t);
  const one = (await buildContext({ ...f.options, scopes: ['governance'] })).context;
  assert.equal(one.documents.filter(doc => doc.path === 'AGENTS.md').length, 1);
  await writeLocalArtifact(f.root, `.freedom/context/${one.task_id}/bundle.json`, one);
  const two = (await buildContext({ ...f.options, scopes: ['governance'] })).context;
  assert.deepEqual(two, one);
  assert.equal(f.git(['status', '--porcelain']), '');
});

test('nested instructions and public version inputs are recorded; dependency contents are not copied', async t => {
  const f = await fixture(t);
  await put(f.root, 'packages/contribution-tools/AGENTS.md', '# Deep rule\n');
  await put(f.root, 'package-lock.json', '{"synthetic_registry_credential":"private-fixture"}');
  const { context } = await buildContext({ ...f.options, requestedPaths: ['packages/contribution-tools/deep/value.mjs'] });
  assert(context.documents.some(item => item.path.endsWith('/AGENTS.md') && item.content.includes('Deep rule')));
  assert.equal(context.version_inputs.filter(item => item.path === 'contracts.lock.json').length, 2);
  assert(context.version_inputs.find(item => item.path === 'package-lock.json').sha256);
  assert(!JSON.stringify(context).includes('private-fixture'));
  const currentTask = context.task_id;
  f.git(['switch', '--quiet', '-c', 'second-context']);
  const next = (await buildContext({ ...f.options, requestedPaths: ['packages/contribution-tools/deep/value.mjs'] })).context;
  assert.notEqual(next.task_id, currentTask); assert.equal(next.branch, 'second-context');
  assert.equal(next.workspace_id, context.workspace_id);
});

test('separate workspaces with identical commits receive different context identities', async t => {
  const f = await fixture(t), second = await fixtureRoot(t);
  f.git(['clone', '--quiet', '--no-hardlinks', f.root, second]);
  const one = await inspectWorkspace(f.root, 'HEAD'), two = await inspectWorkspace(second, 'HEAD');
  assert.equal(one.head_commit, two.head_commit);
  assert.notEqual(one.workspace_id, two.workspace_id);
  assert.notEqual(one.workspace_sha256, two.workspace_sha256);
});

test('verification subprocess environment excludes credentials, hooks and parent test context', () => {
  const env = verificationEnvironment({ PATH: '/tools', TMPDIR: '/tmp', LANG: 'C',
    DATABASE_URL: 'private-fixture', GITHUB_TOKEN: 'private-fixture', NODE_OPTIONS: '--require injected',
    NODE_TEST_CONTEXT: 'child-v8', GIT_DIR: '/other', GIT_CONFIG_COUNT: '1' });
  assert.deepEqual(env, { PATH: '/tools', TMPDIR: '/tmp', LANG: 'C' });
});

test('deleting AGENTS or shrinking/deleting descriptor cannot remove old scope or requirements', async t => {
  const f = await fixture(t), narrow = descriptor('governance', ['other/**']);
  await put(f.root, 'packages/contribution-tools/freedom.module.json', pretty(narrow));
  await put(f.root, 'packages/contribution-tools/value.mjs', 'export const value = 2;\n');
  let built = await buildContext(f.options);
  assert(built.context.tests.includes('governance.unit'));
  await unlink(join(f.root, 'AGENTS.md'));
  await unlink(join(f.root, 'packages/contribution-tools/freedom.module.json'));
  built = await buildContext(f.options);
  assert(built.context.module_ids.includes('governance'));
  assert(built.context.blockers.includes('instruction_missing'));
  assert(built.context.blockers.includes('candidate_governance_unavailable'));
  assert(built.context.documents.some(doc => doc.path === 'AGENTS.md' && doc.revision === 'base'));
});

test('renames, staged-only changes and untracked source change the workspace digest', async t => {
  const f = await fixture(t), first = await inspectWorkspace(f.root, 'baseline');
  await rename(join(f.root, 'packages/contribution-tools/value.mjs'), join(f.root, 'packages/contribution-tools/renamed.mjs'));
  let state = await inspectWorkspace(f.root, 'baseline');
  assert(state.changed_paths.includes('packages/contribution-tools/value.mjs'));
  assert(state.changed_paths.includes('packages/contribution-tools/renamed.mjs'));
  assert.notEqual(state.workspace_sha256, first.workspace_sha256);
  f.git(['add', '.']);
  state = await inspectWorkspace(f.root, 'baseline');
  await put(f.root, 'packages/contribution-tools/renamed.mjs', 'worktree differs from staged\n');
  assert.notEqual((await inspectWorkspace(f.root, 'baseline')).workspace_sha256, state.workspace_sha256);
});

test('hidden index flags, ref injection and private instruction paths fail closed', async t => {
  const f = await fixture(t);
  assert.throws(() => resolveCommit(f.root, '--help'), { code: 'invalid_base_ref' });
  f.git(['update-index', '--assume-unchanged', 'README.md']);
  await assert.rejects(inspectWorkspace(f.root, 'baseline'), { code: 'unsupported_index_flags' });
  f.git(['update-index', '--no-assume-unchanged', 'README.md']);
  const bad = descriptor(); bad.instructions = ['.env'];
  await put(f.root, 'packages/contribution-tools/freedom.module.json', pretty(bad));
  await put(f.root, '.env', 'fixture-private-value');
  await assert.rejects(buildContext(f.options), { code: 'instruction_path_denied' });
});

test('descriptor patterns, duplicate module IDs and cycles cannot create exemptions', async t => {
  assert.throws(() => validateDescriptor({ ...descriptor(), owned_paths: ['**'] }), { code: 'invalid_artifact_path' });
  assert.throws(() => validateDescriptor({ ...descriptor(), owned_paths: ['modules/**/nested'] }), { code: 'invalid_artifact_path' });
  const f = await fixture(t);
  await put(f.root, 'modules/duplicate/freedom.module.json', pretty(descriptor()));
  await assert.rejects(buildContext(f.options), { code: 'duplicate_module' });
  const first = descriptor(), second = descriptor('dependent', ['modules/duplicate/**']);
  first.dependencies = ['dependent']; second.dependencies = ['governance'];
  await put(f.root, 'packages/contribution-tools/freedom.module.json', pretty(first));
  await put(f.root, 'modules/duplicate/freedom.module.json', pretty(second));
  await assert.rejects(buildContext(f.options), { code: 'module_dependency_cycle' });
});

test('reports are limited to ignored directories and refuse symlink escape/unsafe targets', async t => {
  const root = await fixtureRoot(t), outside = await fixtureRoot(t);
  await assert.rejects(writeLocalArtifact(root, 'package.json', {}), { code: 'report_path_denied' });
  await symlink(outside, join(root, '.freedom'));
  await assert.rejects(writeLocalArtifact(root, '.freedom/reports/current.json', {}), { code: 'unsafe_report_directory' });
  assert.deepEqual(await readdir(outside), []);
  const { root: safe } = await fixture(t);
  await writeLocalArtifact(safe, '.freedom/reports/current.json', { result: 1 });
  await writeLocalArtifact(safe, '.freedom/reports/current.json', { result: 2 });
  assert.equal(JSON.parse(await readFile(join(safe, '.freedom/reports/current.json'))).result, 2);
  await symlink(join(safe, '.freedom/reports/current.json'), join(safe, '.freedom/reports/linked.json'));
  await assert.rejects(writeLocalArtifact(safe, '.freedom/reports/linked.json', {}), { code: 'unsafe_report_target' });
  await put(safe, '.gitignore', '.env\n');
  await assert.rejects(writeLocalArtifact(safe, '.freedom/reports/new.json', {}));
});

test('local verify executes the known suite and does not run package.json hooks', async t => {
  const f = await fixture(t);
  await put(f.root, 'package.json', pretty({ name: 'freedom-platform', scripts: { 'test:governance': 'echo pretend' } }));
  const d = descriptor(); d.owned_paths.push('package.json');
  await put(f.root, 'packages/contribution-tools/freedom.module.json', pretty(d));
  const report = await verifyWorkspace(f.options);
  assert.equal(report.status, 'passed');
  const suite = report.checks.find(check => check.check_id === 'governance.unit');
  assert.equal(suite.status, 'passed'); assert.equal(suite.test_count, 1);
  assert.equal(report.assurance_level, 'local');
});

test('empty, skipped and failed tests never produce a passed suite', async t => {
  const f = await fixture(t), path = 'packages/contribution-tools/test/sample.test.mjs';
  for (const body of ['', "import 'node:test';", "import {describe} from 'node:test'; describe('empty suite', () => {});",
    "console.log('# tests 1\\n# pass 1\\n# fail 0\\n# cancelled 0\\n# skipped 0\\n# todo 0');",
    "import {test} from 'node:test'; test.skip('skip', () => {});", "import {test} from 'node:test'; test('fail', () => {throw Error('fixture-private-value');});"]) {
    await put(f.root, path, body);
    const result = await runLocalSuite(f.root, 'governance.unit');
    assert.equal(result.status, 'failed'); assert(!JSON.stringify(result).includes('fixture-private-value'));
  }
  assert.equal((await runLocalSuite(f.root, 'echo-passed')).status, 'not_run');
});

test('unknown runtime source requires full fallback and real surface behavior evidence', async t => {
  const f = await fixture(t);
  await put(f.root, 'new-runtime/background-handler.ts', 'export const run = () => {};\n');
  const report = await verifyWorkspace(f.options);
  assert.equal(report.status, 'unavailable');
  assert(report.checks.some(check => check.check_id === 'runtime.full' && check.status === 'not_run'));
  assert(report.blockers.includes('registration_behavior_audit_required'));
});

test('verification rejects candidate edits or moving base while a suite is running', async t => {
  const f = await fixture(t);
  await put(f.root, 'packages/contribution-tools/value.mjs', 'export const value = 2;\n');
  let report = await verifyWorkspace(f.options, { suiteRunner: async () => {
    await put(f.root, 'packages/contribution-tools/value.mjs', 'export const value = 3;\n');
    return { check_id: 'governance.unit', status: 'passed', reason: 'fixture_only' };
  } });
  assert.equal(report.status, 'failed'); assert(report.blockers.includes('workspace_changed_during_verification'));
  const head = f.commit();
  report = await verifyWorkspace(f.options, { suiteRunner: async () => {
    f.git(['update-ref', 'refs/heads/baseline', head]);
    return { check_id: 'governance.unit', status: 'passed', reason: 'fixture_only' };
  } });
  assert.equal(report.status, 'failed'); assert(report.blockers.includes('base_changed_during_verification'));
});

test('CLI prepare/context/verify share the library, write only requested artifacts, and fail safely', async t => {
  const f = await fixture(t), moduleUrl = new URL('../cli.mjs', import.meta.url).href;
  const run = args => spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {runFreedomCli} from ${JSON.stringify(moduleUrl)}; process.exitCode = await runFreedomCli(process.argv.slice(1));`, '--', ...args], { cwd: f.root, encoding: 'utf8' });
  let result = run(['prepare', '--base-ref', 'baseline', '--scope', 'governance']);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert(summary.context_path.startsWith('.freedom/context/')); assert(!('documents' in summary));
  result = run(['context', '--base-ref', 'baseline', '--paths', 'packages/contribution-tools/deep/file.mjs']);
  assert.equal(result.status, 0, result.stderr); assert(JSON.parse(result.stdout).documents.length >= 4);
  result = run(['verify', '--base-ref', 'baseline', '--scope', 'governance', '--report', '.freedom/reports/current.json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(await readFile(join(f.root, '.freedom/reports/current.json'))).status, 'passed');
  for (const args of [['verify', '--trust', 'untrusted'], ['context', '--paths', '../secret'], ['prepare', '--scope'],
    ['verify', '--report', 'package.json'], ['context', '--base-ref', 'baseline', '--base-ref', 'HEAD']]) {
    result = run(args); assert.equal(result.status, 1, result.stderr); assert.equal(result.stderr, '');
  }
});
