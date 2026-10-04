import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fixtureRoot, put, pretty } from './fixtures.mjs';
import { verificationEnvironment } from '../process-env.mjs';
import { sha256 } from '../io.mjs';
import { CONSUMER_LIBRARIES, LIBRARY_PREFIX } from '../consumer-libraries.mjs';
import { verifyNativeConsumerSource } from '../github-consumer-host.mjs';
function git(root, args) { return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, env: verificationEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim(); }
function commit(root) { git(root, ['add', '.']); git(root, ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Synthetic']); return git(root, ['rev-parse', 'HEAD']); }
async function fixture(t, repository = 'FreeTWAI-AI/freedom-agent-kit') {
  const candidateRoot = await fixtureRoot(t), sourceRoot = await fixtureRoot(t);
  for (const root of [candidateRoot, sourceRoot]) git(root, ['-c', 'init.templateDir=', 'init', '-q']);
  await put(candidateRoot, 'contracts.lock.json', '{"preview":"synthetic baseline"}');
  await put(candidateRoot, 'vendor/freedom-platform/bundle.json', '{"approved":"synthetic baseline"}');
  const baseline = commit(candidateRoot);
  await put(sourceRoot, 'repositories.lock.json', pretty({ format: 'freedom.repository-set/v1', repositories: [{ repository, commit: baseline }] }));
  const files = [];
  for (const source_path of CONSUMER_LIBRARIES[repository]) {
    const bytes = Buffer.from('throw Error("LIBRARY_MUST_NOT_EXECUTE_IN_HOST");');
    await put(sourceRoot, source_path, bytes); await put(candidateRoot, LIBRARY_PREFIX + source_path, bytes);
    files.push({ source_path, path: LIBRARY_PREFIX + source_path, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const expectedSourceCommit = commit(sourceRoot);
  const lock = { format: 'freedom.consumer-libraries/v1', source_repository: 'FreeTWAI-AI/freedom-platform', source_commit: expectedSourceCommit, repository, files };
  await put(candidateRoot, 'consumer-libraries.lock.json', pretty(lock));
  await put(candidateRoot, 'scripts/verify-consumer-libraries.mjs', 'throw Error("CANDIDATE_VERIFIER_EXECUTED")');
  await put(candidateRoot, '.github/workflows/verify.yml', 'run: echo success');
  const candidateCommit = commit(candidateRoot);
  return { input: { repository, candidateRoot, sourceRoot, expectedSourceCommit, expectedWorkflowCommit: expectedSourceCommit, candidateCommit }, lock, baseline };
}
for (const repository of Object.keys(CONSUMER_LIBRARIES)) test(`native source gate verifies committed ${repository} bytes without executing candidate`, async t => {
  const { input, baseline } = await fixture(t, repository);
  await put(input.candidateRoot, LIBRARY_PREFIX + CONSUMER_LIBRARIES[repository][0], 'dirty uncommitted content');
  const report = await verifyNativeConsumerSource(input);
  assert.equal(report.status, 'passed'); assert.equal(report.baseline_commit, baseline);
  assert.equal(report.library_usage, 'not_checked'); assert.equal(report.runtime_observation, 'not_checked'); assert.equal(report.gate_enforced, false);
  assert.equal(report.candidate_commit, input.candidateCommit);
});
test('rewritten candidate library plus lock and invented passing artifact cannot replace approved source', async t => {
  const { input, lock } = await fixture(t); const fake = Buffer.from('export const forged = true;');
  await put(input.candidateRoot, lock.files[0].path, fake);
  lock.files[0].sha256 = sha256(fake); lock.files[0].bytes = fake.length;
  await put(input.candidateRoot, 'consumer-libraries.lock.json', pretty(lock)); await put(input.candidateRoot, 'observation.json', '{"status":"passed"}');
  input.candidateCommit = commit(input.candidateRoot);
  await assert.rejects(verifyNativeConsumerSource(input), { code: 'library_source_bytes_mismatch' });
});
test('preview changes, extra library file, graph override, wrong trusted revision and missing source pin fail closed', async t => {
  const f = await fixture(t), { input } = f;
  await assert.rejects(verifyNativeConsumerSource({ ...input, expectedSourceCommit: 'operator-pin-missing' }), { code: 'consumer_host_commit_required' });
  await assert.rejects(verifyNativeConsumerSource({ ...input, expectedWorkflowCommit: 'f'.repeat(40) }), { code: 'host_workflow_identity_mismatch' });
  await put(input.candidateRoot, 'vendor/freedom-platform/bundle.json', 'changed'); input.candidateCommit = commit(input.candidateRoot);
  await assert.rejects(verifyNativeConsumerSource(input), { code: 'consumer_preview_baseline_changed' });
  const extra = await fixture(t); await put(extra.input.candidateRoot, LIBRARY_PREFIX + 'extra.mjs', 'hidden'); extra.input.candidateCommit = commit(extra.input.candidateRoot);
  await assert.rejects(verifyNativeConsumerSource(extra.input), { code: 'consumer_library_file_set_mismatch' });
  const graft = await fixture(t); await put(graft.input.candidateRoot, '.git/info/grafts', '');
  await assert.rejects(verifyNativeConsumerSource(graft.input), { code: 'host_git_graph_override' });
});
test('candidate symlinks are rejected as Git objects before filesystem materialization', async t => {
  const { input } = await fixture(t); await symlink('/etc/passwd', join(input.candidateRoot, 'escape')); input.candidateCommit = commit(input.candidateRoot);
  await assert.rejects(verifyNativeConsumerSource(input), { code: 'candidate_nonregular_entry' });
});
test('native Actions executable binds source/candidate identity and rejects unsupported event', async t => {
  const { input } = await fixture(t), script = fileURLToPath(new URL('../github-consumer-host.mjs', import.meta.url));
  const environment = { ...verificationEnvironment(), GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: input.repository,
    GITHUB_SHA: input.candidateCommit, FREEDOM_LIBRARY_SOURCE_SHA: input.expectedSourceCommit, FREEDOM_WORKFLOW_SHA: input.expectedWorkflowCommit,
    FREEDOM_WORKFLOW_REPOSITORY: 'FreeTWAI-AI/freedom-platform', FREEDOM_WORKFLOW_PATH: '.github/workflows/trusted-consumer-libraries.yml' };
  const run = env => spawnSync(process.execPath, [script, input.candidateRoot, input.sourceRoot], { env, encoding: 'utf8' });
  const good = run(environment); assert.equal(good.status, 0, good.stdout + good.stderr); assert.equal(JSON.parse(good.stdout).library_usage, 'not_checked');
  const wrong = run({ ...environment, GITHUB_EVENT_NAME: 'pull_request_target' }); assert.equal(wrong.status, 1); assert.equal(JSON.parse(wrong.stdout).code, 'unsupported_host_event');
});
