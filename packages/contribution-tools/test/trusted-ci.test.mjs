import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { unlink, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyHostCandidate, verifyHostMergeGroupCandidate, validateHostEvidenceBinding, installedVerifierDigest } from '../trusted-ci.mjs';
import { sha256 } from '../io.mjs';
import { verificationEnvironment } from '../process-env.mjs';
import { releaseFixture, fixtureRoot, put, pretty, copy } from './fixtures.mjs';

const descriptor = (id = 'governance') => ({ format: 'freedom.module/v1', module_id: id,
  owner_role: 'foundation', owned_paths: ['packages/' + id + '/**'], public_exports: [], dependencies: [],
  contract_families: ['preview'], client_profiles: ['member'], instructions: ['AGENTS.md'], invariants: [],
  tests: [id + '.unit'], surfaces: [] });

async function fixture(t) {
  const f = await releaseFixture(t);
  for (const path of ['AGENTS.md', 'README.md', 'CONTRIBUTING.md']) await put(f.root, path, '# Synthetic only\n');
  await put(f.root, 'packages/governance/freedom.module.json', pretty(descriptor()));
  await put(f.root, 'packages/governance/value.mjs', 'throw Error("Candidate must never execute");\n');
  await put(f.root, '.github/workflows/verify.yml', 'name: verify\njobs: { fake: { steps: [{ run: "echo pass" }] } }\n');
  const gitAt = (root, args) => execFileSync('git', args, { cwd: root, env: verificationEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const git = args => gitAt(f.root, args);
  git(['-c', 'init.templateDir=', 'init', '--quiet']);
  const commit = async () => {
    git(['add', '.']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
      'commit', '--quiet', '--allow-empty', '-m', 'Synthetic boundary fixture']);
    return git(['rev-parse', 'HEAD']);
  };
  const base = await commit();
  await put(f.root, 'packages/governance/value.mjs', 'throw Error("Changed candidate must never execute");\n');
  const head = await commit(), bare = await fixtureRoot(t);
  git(['clone', '--quiet', '--bare', '--no-hardlinks', f.root, bare]);
  const suites = ['governance.unit', 'source.approval', 'runtime.full'];
  const policy = { format: 'freedom.trusted-ci-policy/v1', revision: 'policy-fixture-1', repository: 'FreeTWAI-AI/freedom-platform',
    source: { repository: f.manifest.source_repository, commit: f.manifest.source_commit, release_set_sha256: sha256(f.manifestBytes) },
    verifier: { commit: 'b'.repeat(40), sha256: await installedVerifierDigest() },
    workflow: { identity: 'central/verify', commit: 'c'.repeat(40), publisher: 'fixture-app' },
    required_suites: ['source.approval'], fallback_suites: ['runtime.full'],
    suites: suites.map(id => ({ id, harness_sha256: sha256(id) })) };
  const input = { objectRepository: bare, binding: { repository: policy.repository, pull_request: 42, run_id: 'fixture-run-1', run_attempt: 1,
    base_commit: base, head_commit: head, candidate_commit: head, candidate_tree: git(['rev-parse', head + '^{tree}']) },
    policyBytes: pretty(policy), expectedPolicy: { revision: policy.revision, sha256: sha256(pretty(policy)) }, observations: [] };
  const savePolicy = () => {
    input.policyBytes = pretty(policy); input.expectedPolicy = { revision: policy.revision, sha256: sha256(input.policyBytes) };
  };
  const refresh = async () => {
    input.binding.head_commit = await commit(); input.binding.candidate_commit = input.binding.head_commit;
    input.binding.candidate_tree = git(['rev-parse', 'HEAD^{tree}']);
    gitAt(bare, ['fetch', '--quiet', f.root, '+HEAD:refs/heads/candidate']); input.observations = [];
  };
  const observe = async () => {
    input.observations = [];
    const report = await verifyHostCandidate(input);
    input.observations = report.selected_suites.map(suite_id => ({ suite_id, binding: copy(report.binding), workflow: copy(policy.workflow),
      harness_sha256: policy.suites.find(suite => suite.id === suite_id).harness_sha256, conclusion: 'success',
      tests: 1, failures: 0, skipped: 0, cancelled: 0, evidence_sha256: sha256('independent fixture observation:' + suite_id) }));
    return input;
  };
  return { ...f, git, gitAt, bare, commit, base, head, policy, input, savePolicy, refresh, observe };
}

test('host recomputes immutable candidate impact and requires independent observations', async t => {
  const f = await fixture(t);
  const report = await verifyHostCandidate(f.input);
  assert.equal(report.status, 'unavailable');
  assert.deepEqual(report.changed_paths, ['packages/governance/value.mjs']);
  assert.deepEqual(report.selected_suites, ['governance.unit', 'source.approval']);
  assert.equal(report.binding.candidate_tree, f.input.binding.candidate_tree);
  const passed = await verifyHostCandidate(await f.observe());
  assert.equal(passed.status, 'passed'); assert.equal(passed.assurance_level, 'local');
  assert.equal(passed.merge_authorized, false); assert.equal(passed.execution_authorized, false);
  assert.equal(passed.publisher_trust, 'unverified');
});

test('candidate fake workflow, fake report, hook and modified verifier cannot make missing observations green', async t => {
  const f = await fixture(t);
  await put(f.root, '.github/workflows/verify.yml', 'name: verify\njobs: { fake: { steps: [{ run: "echo passed:true" }] } }\n');
  await put(f.root, 'packages/governance/report.json', pretty({ passed: true, selected_suites: [], status: 'success' }));
  await put(f.root, 'packages/contribution-tools/trusted-ci.mjs', 'process.exit(0);\n');
  await put(f.root, 'package.json', pretty({ scripts: { pretest: 'exit 0', test: 'echo passed:true' } }));
  await f.refresh();
  const report = await verifyHostCandidate(f.input);
  assert.equal(report.status, 'unavailable'); assert(report.selected_suites.includes('runtime.full'));
  assert(report.changed_paths.includes('.github/workflows/verify.yml'));
  await assert.rejects(verifyHostCandidate({ ...f.input, passed: true }), { code: 'invalid_host_input' });
});

test('shrinking owned paths and deleting baseline descriptor cannot subtract tests', async t => {
  const f = await fixture(t);
  await put(f.root, 'packages/work/freedom.module.json', pretty(descriptor('work')));
  await f.refresh(); f.input.binding.base_commit = f.input.binding.head_commit;
  await unlink(join(f.root, 'packages/work/freedom.module.json'));
  const next = descriptor(); next.owned_paths = ['packages/governance/unrelated/**'];
  await put(f.root, 'packages/governance/freedom.module.json', pretty(next));
  await f.refresh();
  f.policy.suites.push({ id: 'work.unit', harness_sha256: sha256('work') }); f.savePolicy();
  const report = await verifyHostCandidate(f.input);
  assert.deepEqual(report.module_ids, ['governance', 'work']);
  assert(report.selected_suites.includes('work.unit'));
});

test('mode-only changes participate in actual diff', async t => {
  const f = await fixture(t);
  f.git(['update-index', '--chmod=+x', 'packages/governance/value.mjs']);
  // Commit index directly because fixture refresh stages working files again.
  f.git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Mode']);
  f.input.binding.base_commit = f.head;
  f.input.binding.head_commit = f.git(['rev-parse', 'HEAD']); f.input.binding.candidate_commit = f.input.binding.head_commit;
  f.input.binding.candidate_tree = f.git(['rev-parse', 'HEAD^{tree}']);
  f.gitAt(f.bare, ['fetch', '--quiet', f.root, '+HEAD:refs/heads/candidate']);
  assert.deepEqual((await verifyHostCandidate(f.input)).changed_paths, ['packages/governance/value.mjs']);
});

test('new or expanded candidate descriptors cannot suppress baseline-unknown fallback', async t => {
  const f = await fixture(t);
  const expanded = descriptor(); expanded.owned_paths.push('new-execution/**');
  await put(f.root, 'packages/governance/freedom.module.json', pretty(expanded));
  await put(f.root, 'new-execution/run.mjs', 'throw Error("not executed");\n');
  await f.refresh();
  let report = await verifyHostCandidate(f.input);
  assert(report.unknown_paths.includes('new-execution/run.mjs'));
  assert(report.selected_suites.includes('runtime.full'));
  const added = descriptor('new-module'); added.owned_paths = ['new-execution/**']; added.tests = ['governance.unit'];
  await put(f.root, 'packages/governance/freedom.module.json', pretty(descriptor()));
  await put(f.root, 'packages/new-module/freedom.module.json', pretty(added));
  await f.refresh(); report = await verifyHostCandidate(f.input);
  assert(report.unknown_paths.includes('new-execution/run.mjs'));
  assert(report.selected_suites.includes('runtime.full'));
});

test('approved manifest cannot hide edited, extra, missing or repinned vendor artifact bytes', async t => {
  const f = await fixture(t), path = 'client/client.mjs';
  await put(f.vendor, path, 'export const tampered = true;\n'); await f.refresh();
  await assert.rejects(verifyHostCandidate(f.input), { code: 'host_artifact_integrity_mismatch' });
  await put(f.vendor, path, f.contents[path]);
  await put(f.vendor, 'client/extra.mjs', 'export const extra = true;\n'); await f.refresh();
  await assert.rejects(verifyHostCandidate(f.input), { code: 'host_artifact_set_mismatch' });
  await unlink(join(f.vendor, 'client/extra.mjs')); await unlink(join(f.vendor, path)); await f.refresh();
  await assert.rejects(verifyHostCandidate(f.input), { code: 'host_artifact_set_mismatch' });
  await put(f.vendor, path, f.contents[path]);
  f.lock.artifacts[0].sha256 = 'd'.repeat(64);
  await put(f.root, 'contracts.lock.json', pretty(f.lock)); await f.refresh();
  await assert.rejects(verifyHostCandidate(f.input), { code: 'host_artifact_pin_mismatch' });
});

test('base advancement, run replay, source and policy changes invalidate old observations', async t => {
  const f = await fixture(t); await f.observe();
  for (const [key, value] of [['run_attempt', 2], ['run_id', 'later-run'], ['base_commit', f.head], ['pull_request', 43]]) {
    const input = { ...f.input, binding: { ...f.input.binding, [key]: value } };
    await assert.rejects(verifyHostCandidate(input), { code: key === 'base_commit' ? 'candidate_base_equals_candidate' : 'host_evidence_binding_mismatch' });
  }
  f.policy.revision = 'policy-fixture-2'; f.savePolicy();
  await assert.rejects(verifyHostCandidate(f.input), { code: 'host_evidence_binding_mismatch' });
  f.policy.source.commit = 'd'.repeat(40); f.savePolicy();
  await assert.rejects(verifyHostCandidate(f.input), { code: 'host_source_pin_mismatch' });
});

test('tree, independently expected policy and installed verifier pins are checked', async t => {
  const f = await fixture(t);
  await assert.rejects(verifyHostCandidate({ ...f.input, binding: { ...f.input.binding, candidate_tree: 'd'.repeat(40) } }), { code: 'host_candidate_tree_mismatch' });
  await assert.rejects(verifyHostCandidate({ ...f.input, expectedPolicy: { ...f.input.expectedPolicy, sha256: '0'.repeat(64) } }), { code: 'host_policy_digest_mismatch' });
  f.policy.verifier.sha256 = '0'.repeat(64); f.savePolicy();
  await assert.rejects(verifyHostCandidate(f.input), { code: 'host_verifier_digest_mismatch' });
});

test('same-name workflow with wrong publisher or revision, altered harness and fake success are rejected', async t => {
  const f = await fixture(t); await f.observe();
  const changes = [
    [item => { item.workflow.publisher = 'candidate-app'; }, 'host_workflow_identity_mismatch'],
    [item => { item.workflow.commit = 'd'.repeat(40); }, 'host_workflow_identity_mismatch'],
    [item => { item.harness_sha256 = 'd'.repeat(64); }, 'host_harness_mismatch'],
    [item => { item.tests = 0; }, 'host_suite_not_passed'],
    [item => { item.skipped = 1; }, 'host_suite_not_passed'],
    [item => { item.cancelled = 1; }, 'host_suite_not_passed'],
    [item => { item.failures = 1; }, 'host_suite_not_passed'],
    [item => { item.conclusion = 'cancelled'; }, 'host_suite_not_passed'],
    [item => { item.passed = true; }, 'invalid_host_input'],
    [item => { item.workflow.command = 'echo pass'; }, 'invalid_host_input'],
  ];
  for (const [mutate, code] of changes) {
    const input = { ...f.input, observations: copy(f.input.observations) }; mutate(input.observations[0]);
    await assert.rejects(verifyHostCandidate(input), { code });
  }
  await assert.rejects(verifyHostCandidate({ ...f.input, observations: [...f.input.observations, f.input.observations[0]] }), { code: 'unexpected_or_duplicate_suite' });
});

test('empty host required/fallback sets and candidate-selected unknown suites fail closed', async t => {
  const f = await fixture(t);
  f.policy.required_suites = []; f.savePolicy();
  await assert.rejects(verifyHostCandidate(f.input), { code: 'host_suites_required' });
  f.policy.required_suites = ['source.approval']; f.savePolicy();
  const next = descriptor(); next.tests = ['candidate.echo'];
  await put(f.root, 'packages/governance/freedom.module.json', pretty(next)); await f.refresh();
  await assert.rejects(verifyHostCandidate(f.input), { code: 'host_suite_unregistered' });
});

test('replace refs are ignored and grafts/alternates are rejected', async t => {
  const f = await fixture(t);
  f.gitAt(f.bare, ['replace', f.head, f.base]);
  assert.equal((await verifyHostCandidate(f.input)).binding.candidate_tree, f.input.binding.candidate_tree);
  for (const path of ['info/grafts', 'objects/info/alternates', 'objects/info/http-alternates']) {
    await put(f.bare, path, '# Synthetic override\n');
    await assert.rejects(verifyHostCandidate(f.input), { code: 'host_git_graph_override' });
    await unlink(join(f.bare, path));
  }
  await assert.rejects(verifyHostCandidate({ ...f.input, objectRepository: f.root }), { code: 'host_bare_repository_required' });
});

test('candidate symlinks and malformed descriptor command fields are rejected as data', async t => {
  const f = await fixture(t);
  const next = descriptor(); next.command = 'echo pass';
  await put(f.root, 'packages/governance/freedom.module.json', pretty(next)); await f.refresh();
  await assert.rejects(verifyHostCandidate(f.input));
  await put(f.root, 'packages/governance/freedom.module.json', pretty(descriptor()));
  await symlink('value.mjs', join(f.root, 'packages/governance/link.mjs')); await f.refresh();
  await assert.rejects(verifyHostCandidate(f.input), { code: 'candidate_nonregular_entry' });
});

test('integration candidate must bind both exact base and head parents', async t => {
  const f = await fixture(t);
  const tree = f.input.binding.candidate_tree;
  const integration = f.git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit-tree', tree, '-p', f.base, '-p', f.head, '-m', 'Synthetic integration']);
  f.git(['update-ref', 'refs/heads/integration', integration]);
  f.gitAt(f.bare, ['fetch', '--quiet', f.root, 'refs/heads/integration:refs/heads/integration']);
  f.input.binding.candidate_commit = integration;
  assert.equal((await verifyHostCandidate(f.input)).status, 'unavailable');
  f.input.binding.base_commit = f.head;
  await assert.rejects(verifyHostCandidate(f.input), { code: 'candidate_parent_mismatch' });
});


test('local single-target evidence is structurally valid but cannot approve a self-baseline candidate', async t => {
  const f = await fixture(t);
  const binding = { ...f.input.binding, base_commit: f.head, source_commit: f.policy.source.commit,
    release_set_sha256: f.policy.source.release_set_sha256, policy_revision: f.policy.revision,
    policy_sha256: f.input.expectedPolicy.sha256, verifier_commit: f.policy.verifier.commit,
    verifier_sha256: f.policy.verifier.sha256 };
  assert.equal(validateHostEvidenceBinding(binding).base_commit, f.head);
  await assert.rejects(verifyHostCandidate({ ...f.input, binding: { ...f.input.binding, base_commit: f.head } }),
    { code: 'candidate_base_equals_candidate' });
  await assert.rejects(verifyHostMergeGroupCandidate({ ...f.input, binding: { ...f.input.binding, pull_request: null, base_commit: f.head } }),
    { code: 'candidate_base_equals_candidate' });
});
