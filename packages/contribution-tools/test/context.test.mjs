import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, unlink, rename, symlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { buildContext, buildContextDelivery, CONTEXT_LIMITS, readContextDelivery, writeContextDelivery, selectImpact, validateDescriptor } from '../context.mjs';
import { inspectWorkspace, resolveCommit } from '../workspace.mjs';
import { verifyWorkspace, runLocalSuite } from '../verify.mjs';
import { writeLocalArtifact } from '../local-artifacts.mjs';
import { sha256 } from '../io.mjs';
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

test('selected module can include root DESIGN while arbitrary root instructions remain denied', async t => {
  const f = await fixture(t), module = descriptor('portal', ['apps/portal-web/**']);
  module.instructions = ['DESIGN.md'];
  await put(f.root, 'apps/portal-web/freedom.module.json', pretty(module));
  await put(f.root, 'DESIGN.md', '# Approved design rules\n');
  f.git(['update-ref', 'refs/heads/baseline', f.commit()]);
  await put(f.root, 'DESIGN.md', '# Updated design rules\n');
  const { context } = await buildContext({ ...f.options, requestedPaths: ['apps/portal-web/deep/page.tsx'] });
  assert.deepEqual(context.documents.filter(doc => doc.path === 'DESIGN.md').map(doc => doc.revision), ['base', 'candidate']);
  assert.equal(context.publisher_trust, 'unverified');
  module.instructions = ['private-notes.md'];
  await put(f.root, 'apps/portal-web/freedom.module.json', pretty(module));
  await put(f.root, 'private-notes.md', 'must not enter the bundle');
  await assert.rejects(buildContext({ ...f.options, scopes: ['portal'] }), { code: 'instruction_path_denied' });
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

test('existing scoped Storefront package resolves only the reviewed local identity', async t => {
  const f = await fixture(t);
  await put(f.root, 'package.json', pretty({ name: '@freetwai/freedom-storefront' }));
  const { context } = await buildContext(f.options);
  assert.equal(context.repository, 'FreeTWAI-AI/freedom-storefront');
  assert.equal(context.assurance_level, 'local');
  assert.equal(context.publisher_trust, 'unverified');
  for (const name of ['@unreviewed/freedom-storefront', '@freetwai/storefront', '@freetwai/freedom-storefront-extra']) {
    await put(f.root, 'package.json', pretty({ name }));
    await assert.rejects(buildContext(f.options), { code: 'repository_identity_required' });
  }
});

test('real consumer suite evidence validates in a complete local report without hiding surface blockers', async t => {
  const f = await fixture(t), consumer = descriptor('agent-kit', ['src/**']);
  consumer.tests = ['consumer.agent-kit'];
  await put(f.root, 'src/freedom.module.json', pretty(consumer));
  await put(f.root, 'src/index.mjs', 'export const version=1;');
  await put(f.root, 'tests/workspace.test.mjs', "import {test} from 'node:test'; test('consumer',()=>{});");
  f.git(['update-ref', 'refs/heads/baseline', f.commit()]);
  await put(f.root, 'src/index.mjs', 'export const version=2;');
  const report = await verifyWorkspace(f.options);
  assert.equal(report.status, 'unavailable');
  const suite = report.checks.find(check => check.check_id === 'consumer.agent-kit');
  assert.equal(suite.status, 'passed'); assert.equal(suite.test_count, 1);
  assert.equal(suite.test_files[0].path, 'tests/workspace.test.mjs');
  assert.deepEqual(report.blockers, ['registration_behavior_audit_required']);
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

test('descriptor ownership accepts 128 bounded paths but rejects overflow, duplicates and invalid patterns', () => {
  const paths = Array.from({length: 128}, (_, index) => `modules/example/file-${index}.ts`);
  assert.deepEqual(validateDescriptor(descriptor('example', paths)).owned_paths, paths);
  assert.throws(() => validateDescriptor(descriptor('example', [...paths, 'modules/example/overflow.ts'])), {code: 'schema_violation'});
  assert.throws(() => validateDescriptor(descriptor('example', [...paths.slice(0, 127), paths[0]])), {code: 'schema_violation'});
  assert.throws(() => validateDescriptor(descriptor('example', [...paths.slice(0, 127), 'modules/example/Component.*'])), {code: 'invalid_artifact_path'});
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

async function largeContextFixture(t) {
  const f = await fixture(t);
  f.options.scopes = ['governance'];
  // A single instruction exceeds the v1 aggregate cap; UTF-8 boundaries and BOM
  // must survive both baseline and candidate delivery without replacement.
  f.rule = '\ufeff' + '界🙂\n'.repeat(70_000);
  await put(f.root, 'docs/rules.md', f.rule);
  f.base = f.commit(); f.git(['update-ref', 'refs/heads/baseline', f.base]);
  return f;
}
const contextCliUrl = new URL('../cli.mjs', import.meta.url).href;
function contextCli(root, args) {
  return spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {runFreedomCli} from ${JSON.stringify(contextCliUrl)}; process.exitCode = await runFreedomCli(process.argv.slice(1));`, '--', ...args],
  { cwd: root, encoding: 'utf8', maxBuffer: 1_000_000 });
}

test('large context delivers complete UTF-8 baseline/candidate rules and public version content in bounded chunks', async t => {
  const f = await largeContextFixture(t);
  await put(f.root, 'docs/rules.md', f.rule + 'Candidate amendment.\n');
  await assert.rejects(buildContext(f.options), { code: 'context_size_limit' });
  const delivery = await writeContextDelivery(f.options);
  assert.equal(delivery.manifest.binding.publisher_trust, 'unverified');
  assert.equal(delivery.manifest.binding.library_usage, 'not_checked');
  assert.equal(delivery.manifest.delta.find(item => item.path === 'docs/rules.md').status, 'changed');
  for (const source of delivery.manifest.sources) {
    const parts = delivery.chunks.slice(source.first_chunk, source.first_chunk + source.chunk_count);
    const bytes = Buffer.concat(parts.map(chunk => Buffer.from(chunk.value.content)));
    assert.equal(bytes.length, source.content_bytes);
    assert.equal(sha256(bytes), source.content_sha256);
    if (source.kind === 'instruction') assert.equal(sha256(bytes), source.sha256);
    assert(parts.every(chunk => chunk.bytes <= CONTEXT_LIMITS.artifact_bytes && chunk.value.bytes <= CONTEXT_LIMITS.chunk_content_bytes));
    if (source.path === 'docs/rules.md') assert.equal(bytes.toString(), f.rule + (source.revision === 'candidate' ? 'Candidate amendment.\n' : ''));
  }
  const result = await readContextDelivery(f.root, delivery.manifestPath, { complete: true });
  assert.equal(result.value.complete, true);
  assert.equal(result.value.chunks, delivery.chunks.length);
});

test('context chunk reads reject missing, corrupt, reordered and linked fragments before returning even the first chunk', async t => {
  const f = await largeContextFixture(t), d = await writeContextDelivery(f.options);
  const a = d.chunks.at(-1), b = d.chunks.at(-2), original = await readFile(join(f.root, a.path));
  await unlink(join(f.root, a.path));
  await assert.rejects(readContextDelivery(f.root, d.manifestPath, { chunkIndex: 0 }), { code: 'artifact_missing' });
  await put(f.root, a.path, await readFile(join(f.root, b.path)));
  await assert.rejects(readContextDelivery(f.root, d.manifestPath, { complete: true }), { code: 'context_chunk_mismatch' });
  await put(f.root, a.path, Buffer.from(original.toString().replace('"content":', '"changed":')));
  await assert.rejects(readContextDelivery(f.root, d.manifestPath, { chunkIndex: 0 }), { code: 'context_chunk_mismatch' });
  await unlink(join(f.root, a.path)); await symlink(join(f.root, b.path), join(f.root, a.path));
  await assert.rejects(readContextDelivery(f.root, d.manifestPath, { complete: true }), { code: 'artifact_symlink' });
  await unlink(join(f.root, a.path)); await put(f.root, a.path, original);
  const forged = structuredClone(d.manifest); forged.chunks.pop();
  await put(f.root, d.manifestPath, pretty(forged));
  await assert.rejects(readContextDelivery(f.root, d.manifestPath, { complete: true }), { code: 'stale_or_modified_context_manifest' });
  for (const path of ['../manifest.json', 'package.json', '.freedom/reports/manifest.json']) {
    await assert.rejects(readContextDelivery(f.root, path, { complete: true }), { code: 'context_manifest_path_denied' });
  }
});

test('saved context rejects candidate edits, scope replacement, branch changes and a moving baseline', async t => {
  const f = await largeContextFixture(t), d = await writeContextDelivery(f.options);
  await put(f.root, 'docs/rules.md', f.rule + 'later');
  await assert.rejects(readContextDelivery(f.root, d.manifestPath, { complete: true }), { code: 'stale_or_modified_context_manifest' });
  await put(f.root, 'docs/rules.md', f.rule);
  const changedScope = structuredClone(d.manifest); changedScope.request.scopes = [];
  await put(f.root, d.manifestPath, pretty(changedScope));
  await assert.rejects(readContextDelivery(f.root, d.manifestPath, { complete: true }), { code: 'stale_or_modified_context_manifest' });
  await put(f.root, d.manifestPath, pretty(d.manifest));
  f.git(['checkout', '-q', '-b', 'different-task']);
  await assert.rejects(readContextDelivery(f.root, d.manifestPath, { complete: true }), { code: 'stale_or_modified_context_manifest' });
  const newer = await writeContextDelivery(f.options);
  await put(f.root, 'packages/contribution-tools/value.mjs', 'export const changed = true;\n');
  const nextHead = f.commit(); f.git(['update-ref', 'refs/heads/baseline', nextHead]);
  await assert.rejects(readContextDelivery(f.root, newer.manifestPath, { complete: true }), { code: 'stale_or_modified_context_manifest' });
});

test('actual CLI preserves the small bundle and reads every large-context fragment from a fresh linked worktree', async t => {
  const f = await largeContextFixture(t), worktree = await fixtureRoot(t);
  f.git(['worktree', 'add', '--detach', worktree, f.base]);
  const args = ['prepare', '--base-ref', f.base, '--paths', 'packages/contribution-tools/deep/value.mjs'];
  const prepared = contextCli(worktree, args);
  assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
  const summary = JSON.parse(prepared.stdout);
  assert.equal(summary.format, 'freedom.coding-context-manifest/v1');
  const manifest = JSON.parse(await readFile(join(worktree, summary.context_path)));
  const collected = [];
  for (const chunk of manifest.chunks) {
    const read = contextCli(worktree, ['context', '--manifest', summary.context_path, '--chunk', String(chunk.index)]);
    assert.equal(read.status, 0, read.stdout + read.stderr);
    assert(Buffer.byteLength(read.stdout) <= CONTEXT_LIMITS.artifact_bytes);
    collected.push(JSON.parse(read.stdout));
  }
  for (const source of manifest.sources.filter(item => item.kind === 'instruction')) {
    const bytes = Buffer.from(collected.slice(source.first_chunk, source.first_chunk + source.chunk_count).map(chunk => chunk.content).join(''));
    const original = source.revision === 'base'
      ? execFileSync('git', ['show', `${f.base}:${source.path}`], { cwd: worktree }) : await readFile(join(worktree, source.path));
    assert.equal(sha256(bytes), source.sha256);
    assert.deepEqual(bytes, original);
  }
  const done = contextCli(worktree, ['context', '--manifest', summary.context_path, '--check', 'complete']);
  assert.equal(done.status, 0, done.stdout); assert.equal(JSON.parse(done.stdout).complete, true);
  for (const chunk of manifest.chunks) await put(f.root, chunk.path, await readFile(join(worktree, chunk.path)));
  await put(f.root, summary.context_path, await readFile(join(worktree, summary.context_path)));
  const mixed = contextCli(f.root, ['context', '--manifest', summary.context_path, '--chunk', '0']);
  assert.equal(mixed.status, 1); assert.equal(JSON.parse(mixed.stdout).code, 'stale_or_modified_context_manifest');
  for (const extra of [['--chunk', '-1'], ['--chunk', '0', '--check', 'complete'], ['--chunk', '0', '--base-ref', f.base]]) {
    const rejected = contextCli(worktree, ['context', '--manifest', summary.context_path, ...extra]);
    assert.equal(rejected.status, 1);
  }
});

test('metadata verify reads large full-scope rules and preserves missing instruction blockers', async t => {
  const f = await largeContextFixture(t), selected = [];
  const suiteRunner = async (_root, id) => { selected.push(id); return { check_id: id, status: 'passed', reason: 'synthetic_selection_only' }; };
  let report = await verifyWorkspace({ ...f.options, requestedPaths: ['AGENTS.md'] }, { suiteRunner });
  assert.equal(report.status, 'passed'); assert.deepEqual(report.scope, ['governance']);
  assert.deepEqual(selected, ['governance.unit']);
  await unlink(join(f.root, 'docs/rules.md'));
  report = await verifyWorkspace(f.options, { suiteRunner });
  assert.equal(report.status, 'unavailable'); assert(report.blockers.includes('instruction_missing'));
  // The baseline descriptor still references this absent rule. Candidate-only
  // text must not silently replace the missing baseline obligation.
  f.commit(); f.git(['update-ref', 'refs/heads/baseline', 'HEAD']);
  await put(f.root, 'docs/rules.md', f.rule);
  report = await verifyWorkspace(f.options, { suiteRunner });
  assert.equal(report.status, 'unavailable'); assert(report.blockers.includes('baseline_instruction_missing'));
});

test('delivery rejects oversized instructions, invalid UTF-8 and excessive total content without publishing a manifest', async t => {
  const f = await fixture(t);
  f.options.scopes = ['governance'];
  await put(f.root, 'docs/rules.md', Buffer.alloc(2_000_001, 65));
  await assert.rejects(writeContextDelivery(f.options), { code: 'artifact_size_limit' });
  await put(f.root, 'docs/rules.md', Buffer.from([0xc0, 0xaf]));
  await assert.rejects(writeContextDelivery(f.options), { code: 'invalid_instruction_encoding' });
  const d = descriptor(); d.instructions = [];
  for (let index = 0; index < 9; index++) {
    const path = `docs/large-${index}.md`; d.instructions.push(path); await put(f.root, path, 'x'.repeat(1_800_000));
  }
  await put(f.root, 'docs/rules.md', '# valid\n');
  await put(f.root, 'packages/contribution-tools/freedom.module.json', pretty(d));
  f.commit(); f.git(['update-ref', 'refs/heads/baseline', 'HEAD']);
  await assert.rejects(writeContextDelivery({ ...f.options, scopes: ['governance'] }), { code: 'context_total_size_limit' });
  await assert.rejects(readdir(join(f.root, '.freedom/context')), { code: 'ENOENT' });
});

test('interrupted chunk publication leaves no manifest and never follows a planted output link', async t => {
  const f = await largeContextFixture(t), d = await buildContextDelivery(f.options);
  const outside = await fixtureRoot(t);
  await put(outside, 'unchanged.json', 'outside original bytes');
  await put(f.root, d.chunks.at(-1).path, 'placeholder');
  await unlink(join(f.root, d.chunks.at(-1).path));
  await symlink(join(outside, 'unchanged.json'), join(f.root, d.chunks.at(-1).path));
  await assert.rejects(writeContextDelivery(f.options), { code: 'unsafe_report_target' });
  await assert.rejects(readFile(join(f.root, d.manifestPath)), { code: 'ENOENT' });
  assert.equal(await readFile(join(outside, 'unchanged.json'), 'utf8'), 'outside original bytes');
});

test('unknown entry retains all baseline/candidate dependency rules while dependency bodies remain private', async t => {
  const f = await fixture(t), dependent = descriptor('portal', ['apps/portal/**']);
  dependent.dependencies = ['governance']; dependent.instructions = ['docs/portal.md'];
  await put(f.root, 'apps/portal/freedom.module.json', pretty(dependent));
  await put(f.root, 'docs/portal.md', '# Portal baseline rules\n');
  await put(f.root, 'apps/portal/AGENTS.md', '# Nested portal rules\n');
  await put(f.root, 'package-lock.json', pretty({ private_registry_value: 'fixture-sensitive-registry-marker' }));
  f.commit(); f.git(['update-ref', 'refs/heads/baseline', 'HEAD']);
  await put(f.root, 'docs/portal.md', '# Portal candidate rules\n');
  const d = await writeContextDelivery({ ...f.options, requestedPaths: ['new-queue/handler.mjs'] });
  assert.deepEqual(d.manifest.binding.module_ids, ['governance', 'portal']);
  assert.deepEqual(d.manifest.selection.unknown_paths, ['new-queue/handler.mjs']);
  for (const revision of ['baseline_modules', 'candidate_modules']) {
    assert.deepEqual(d.manifest.selection[revision].find(item => item.module_id === 'portal').dependencies, ['governance']);
  }
  for (const path of ['docs/rules.md', 'docs/portal.md', 'apps/portal/AGENTS.md']) {
    assert.deepEqual(d.manifest.sources.filter(source => source.path === path).map(source => source.revision), ['base', 'candidate']);
  }
  const serialized = JSON.stringify([d.manifest, ...d.chunks.map(chunk => chunk.value)]);
  assert(!serialized.includes('fixture-sensitive-registry-marker'));
  assert(d.manifest.binding.version_inputs.some(input => input.path === 'package-lock.json' && input.sha256 && !('content' in input)));
  const complete = await readContextDelivery(f.root, d.manifestPath, { complete: true });
  assert.equal(complete.value.complete, false); assert.deepEqual(complete.blockers, ['surface_unmapped']);
});
