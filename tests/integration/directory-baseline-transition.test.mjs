// Actual approved Git snapshots; source guard never executes their scripts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { verifyNativeConsumerSource } from '../../packages/contribution-tools/github-consumer-host.mjs';
import { verificationEnvironment } from '../../packages/contribution-tools/process-env.mjs';

const candidateRoot = process.env.FREEDOM_DIRECTORY_ROOT;
const sourceRoot = process.env.FREEDOM_CONSUMER_SOURCE_ROOT;
const expectedWorkflowCommit = process.env.FREEDOM_CONSUMER_WORKFLOW_SHA;
if (process.env.FREEDOM_RUN_DIRECTORY_TRANSITION !== '1' || !candidateRoot || !isAbsolute(candidateRoot)
  || !sourceRoot || !isAbsolute(sourceRoot) || !/^[a-f0-9]{40}$/.test(expectedWorkflowCommit ?? '')) {
  throw Error('Explicit directory/source clones and immutable promoted source SHA required.');
}
const oldBaseline = '90f790763f4f0507d123f325d194d2cf7b9bf73f';
const approved = '01b18397f9c5356a14e4cc66fa46f57216f11154';
const installed = '92a58db9948c4c56a9d81d1450b9a856fb94a944';
const git = (cwd, args) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
  cwd, env: { ...verificationEnvironment(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Synthetic', GIT_COMMITTER_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid',
    GIT_COMMITTER_EMAIL: 'synthetic@example.invalid' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
}).trim();
const input = (commit, root = candidateRoot, source = sourceRoot, workflow = expectedWorkflowCommit) => ({
  repository: 'FreeTWAI-AI/FreeTWAI-AI.github.io', candidateRoot: root, candidateCommit: commit,
  sourceRoot: source, expectedWorkflowCommit: workflow, expectedSourceCommit: '91b943ac61e132fbbce72ea066cb2301aa065600',
});
async function clone(t, root, label) {
  const directory = await mkdtemp(join(tmpdir(), 'fp-directory-' + label + '-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, 'checkout');
  git(directory, ['clone', '--quiet', '--local', '--no-checkout', root, target]);
  return target;
}
async function changed(t, path, value) {
  const root = await clone(t, candidateRoot, 'mutation');
  git(root, ['checkout', '--quiet', '--detach', approved]);
  await writeFile(join(root, path), value);
  git(root, ['add', '--', path]); git(root, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'Synthetic baseline transition probe']);
  return input(git(root, ['rev-parse', 'HEAD']), root);
}

test('promotion changes only the approved directory pin; old installed policy rejects the fix', async t => {
  const oldLock = JSON.parse(git(sourceRoot, ['show', installed + ':repositories.lock.json']));
  const promotedLock = JSON.parse(git(sourceRoot, ['show', expectedWorkflowCommit + ':repositories.lock.json']));
  const entries = oldLock.repositories.filter(x => x.repository === 'FreeTWAI-AI/FreeTWAI-AI.github.io');
  assert.equal(entries.length, 1); assert.equal(entries[0].commit, oldBaseline);
  entries[0].commit = approved;
  assert.deepEqual(promotedLock, oldLock);
  assert.equal(git(candidateRoot, ['show', '-s', '--format=%P', approved]), oldBaseline);
  const oldSource = await clone(t, sourceRoot, 'old-source');
  git(oldSource, ['checkout', '--quiet', '--detach', installed]);
  assert.equal((await verifyNativeConsumerSource(input(oldBaseline, candidateRoot, oldSource, installed))).status, 'passed');
  await assert.rejects(verifyNativeConsumerSource(input(approved, candidateRoot, oldSource, installed)), { code: 'consumer_verification_entry_changed' });
});
test('new source refuses the current old directory main rather than silently accepting a stale baseline', async () => {
  await assert.rejects(verifyNativeConsumerSource(input(oldBaseline)), { code: 'candidate_missing_approved_consumer_base' });
});
test('exact reviewed directory fix and its ordinary descendant pass with protected automation unchanged', async t => {
  for (const config of [input(approved), await changed(t, 'baseline-transition-probe.md', 'Synthetic documentation only.\n')]) {
    const result = await verifyNativeConsumerSource(config);
    assert.equal(result.status, 'passed'); assert.equal(result.baseline_commit, approved);
    assert.equal(result.candidate_commit, config.candidateCommit);
    assert.equal(result.profile_result.protected_automation.status, 'unchanged-from-approved-baseline');
    assert(result.profile_result.protected_automation.paths.includes('scripts/build.mjs'));
    assert(result.profile_result.protected_automation.paths.includes('.github/workflows/pages.yml'));
    assert.equal(result.library_usage, 'not_checked'); assert.equal(result.runtime_observation, 'not_checked');
    assert.equal(result.profile_result.candidate_code_executed, false); assert.equal(result.merge_authorized, false);
  }
});
for (const path of ['scripts/build.mjs', '.github/workflows/pages.yml']) test(`promotion does not exempt later ${path} changes`, async t => {
  const config = await changed(t, path, '# synthetic tamper\n');
  await assert.rejects(verifyNativeConsumerSource(config), { code: 'consumer_verification_entry_changed' });
});
test('same-tree squash without the approved commit ancestry cannot satisfy the promoted baseline', async t => {
  const root = await clone(t, candidateRoot, 'squash');
  const tree = git(root, ['rev-parse', approved + '^{tree}']);
  const squash = git(root, ['commit-tree', tree, '-p', oldBaseline, '-m', 'Synthetic squash excludes approved commit']);
  assert.notEqual(squash, approved); assert.equal(git(root, ['rev-parse', squash + '^{tree}']), tree);
  await assert.rejects(verifyNativeConsumerSource(input(squash, root)), { code: 'candidate_missing_approved_consumer_base' });
});
