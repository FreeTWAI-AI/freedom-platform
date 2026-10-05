import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fixtureRoot, put, pretty } from './fixtures.mjs';
import { verificationEnvironment } from '../process-env.mjs';
import { sha256 } from '../io.mjs';
import { CONSUMER_LIBRARIES, LEGACY_LIBRARY_PROFILE, AGENT_KIT_DEVICE_LIBRARY_PROFILE, consumerLibraryProfile, LIBRARY_PREFIX } from '../consumer-libraries.mjs';
import { verifyNativeConsumerSource } from '../github-consumer-host.mjs';
import { verifyNativeConsumerRuntime } from '../github-consumer-runtime-host.mjs';
function git(root, args) { return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, env: verificationEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim(); }
function commit(root) { git(root, ['add', '.']); git(root, ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Synthetic']); return git(root, ['rev-parse', 'HEAD']); }
async function fixture(t, repository = 'FreeTWAI-AI/freedom-agent-kit', expectedLibraryProfile) {
  const candidateRoot = await fixtureRoot(t), sourceRoot = await fixtureRoot(t);
  for (const root of [candidateRoot, sourceRoot]) git(root, ['-c', 'init.templateDir=', 'init', '-q']);
  await put(candidateRoot, 'contracts.lock.json', '{"preview":"synthetic baseline"}');
  await put(candidateRoot, 'vendor/freedom-platform/bundle.json', '{"approved":"synthetic baseline"}');
  await put(candidateRoot, 'package.json', pretty({ type: 'module', scripts: { status: 'node src/cli.mjs' } }));
  await put(candidateRoot, 'src/cli.mjs', 'throw Error("CANDIDATE_MUST_NOT_EXECUTE");');
  await put(candidateRoot, '.github/workflows/verify.yml', 'run: echo success');
  const baseline = commit(candidateRoot);
  await put(sourceRoot, 'repositories.lock.json', pretty({ format: 'freedom.repository-set/v1', repositories: [{ repository, commit: baseline }] }));
  const files = [];
  const profile = consumerLibraryProfile(repository, expectedLibraryProfile);
  for (const source_path of profile.paths) {
    const bytes = Buffer.from('throw Error("LIBRARY_MUST_NOT_EXECUTE_IN_HOST");');
    await put(sourceRoot, source_path, bytes); await put(candidateRoot, LIBRARY_PREFIX + source_path, bytes);
    files.push({ source_path, path: LIBRARY_PREFIX + source_path, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const expectedSourceCommit = commit(sourceRoot);
  const lock = { format: profile.format, ...(profile.id === LEGACY_LIBRARY_PROFILE ? {} : { profile: profile.id }),
    source_repository: 'FreeTWAI-AI/freedom-platform', source_commit: expectedSourceCommit, repository, files };
  await put(candidateRoot, 'consumer-libraries.lock.json', pretty(lock));
  await put(candidateRoot, 'scripts/verify-consumer-libraries.mjs', 'throw Error("CANDIDATE_VERIFIER_EXECUTED")');
  await put(candidateRoot, '.github/workflows/verify.yml', 'run: echo success');
  const candidateCommit = commit(candidateRoot);
  return { input: { repository, candidateRoot, sourceRoot, expectedSourceCommit, expectedWorkflowCommit: expectedSourceCommit, candidateCommit,
    ...(expectedLibraryProfile === undefined ? {} : { expectedLibraryProfile }) }, lock, baseline };
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
  // An arbitrary synthetic source cannot replace the installed repository tuple.
  assert.equal((await verifyNativeConsumerSource(input)).status, 'passed');
  const unapproved = run(environment); assert.equal(unapproved.status, 1);
  assert.equal(JSON.parse(unapproved.stdout).code, 'consumer_supported_tuple_required');
  const wrong = run({ ...environment, GITHUB_EVENT_NAME: 'pull_request_target' }); assert.equal(wrong.status, 1); assert.equal(JSON.parse(wrong.stdout).code, 'unsupported_host_event');
});

test('source-valid new package entrances, aliases and lifecycle hooks cannot bypass the trusted baseline', async t => {
  for (const change of [
    p => { p.bin = { bypass: './src/bypass.mjs' }; },
    p => { p.main = './src/bypass.mjs'; },
    p => { p.module = './src/bypass.mjs'; },
    p => { p.browser = { './src/cli.mjs': './src/bypass.mjs' }; },
    p => { p.exports = { './unchecked': './src/bypass.mjs' }; },
    p => { p.imports = { '#client': './src/bypass.mjs' }; },
    p => { p.scripts.start = 'node src/bypass.mjs'; },
    p => { p.scripts.preinstall = 'node src/bypass.mjs'; },
    p => { p.scripts.poststatus = 'node src/bypass.mjs'; },
    p => { p.scripts.status = 'node src/bypass.mjs'; },
    p => { p.workspaces = ['unchecked']; },
    p => { p.futureRunner = './src/bypass.mjs'; },
  ]) {
    const { input } = await fixture(t);
    const pkg = { type: 'module', scripts: { status: 'node src/cli.mjs' } }; change(pkg);
    await put(input.candidateRoot, 'package.json', pretty(pkg));
    // Valid JS and intact canonical libraries/preview: this refusal is registration
    // policy, not a syntax error, missing library, or observed invocation claim.
    await put(input.candidateRoot, 'src/bypass.mjs', 'export const unchecked = () => fetch("https://platform.invalid/api/v1/member");');
    input.candidateCommit = commit(input.candidateRoot);
    await assert.rejects(verifyNativeConsumerSource(input), { code: 'consumer_entry_registration_changed' });
  }
});

test('new nested manifests, native hooks, implicit start and workflow launchers fail closed', async t => {
  for (const [path, bytes] of [
    ['nested/package.json', '{"main":"./bypass.mjs"}'],
    ['.husky/pre-commit', 'node src/cli.mjs'],
    ['.npmrc', 'script-shell=./unchecked-shell'],
    ['server.js', 'export const handler = () => {};'],
    ['binding.gyp', '{"targets":[]}'],
    ['wrangler.toml', 'main = "src/bypass.mjs"'],
    ['.github/workflows/unchecked.yml', 'name: unchecked\non: push\njobs: {}'],
  ]) {
    const { input } = await fixture(t); await put(input.candidateRoot, path, bytes); input.candidateCommit = commit(input.candidateRoot);
    await assert.rejects(verifyNativeConsumerSource(input), { code: 'consumer_entry_registry_set_changed' });
  }
});

test('ordinary source and descriptive package edits pass without claiming runtime coverage', async t => {
  const { input } = await fixture(t);
  await put(input.candidateRoot, 'src/cli.mjs', 'export const message = "reviewable ordinary product edit";');
  await put(input.candidateRoot, 'src/helper.mjs', 'export const helper = value => value + 1;');
  await put(input.candidateRoot, 'package.json', pretty({ type: 'module', scripts: { status: 'node src/cli.mjs' },
    version: '0.2.0', description: 'Edited description' }));
  input.candidateCommit = commit(input.candidateRoot);
  const result = await verifyNativeConsumerSource(input);
  assert.equal(result.status, 'passed'); assert.equal(result.entry_coverage.status, 'passed');
  assert.equal(result.entry_coverage.runtime_entry_discovery, 'not_checked');
  assert.equal(result.entry_coverage.library_invocation, 'not_checked');
  assert.equal(result.entry_coverage.candidate_code_executed, false);
});

test('host-selected new profile verifies immutable canonical artifacts without claiming invocation', async t => {
  const { input } = await fixture(t, 'FreeTWAI-AI/freedom-agent-kit', AGENT_KIT_DEVICE_LIBRARY_PROFILE);
  const result = await verifyNativeConsumerSource(input);
  assert.equal(result.status, 'passed');
  assert.equal(result.library_profile, AGENT_KIT_DEVICE_LIBRARY_PROFILE);
  assert.equal(result.library_usage, 'not_checked');
  assert.equal(result.entry_coverage.library_invocation, 'not_checked');
  assert.equal(result.entry_coverage.candidate_code_executed, false);
  assert.equal(result.evidence.length, 3);
  // Source selection is a prerequisite for runtime too; this mismatch must stop
  // before invoking a container and cannot be repaired by the candidate lock.
  const defaultHost = { ...input }; delete defaultHost.expectedLibraryProfile;
  await assert.rejects(verifyNativeConsumerSource(defaultHost), { code: 'consumer_library_file_set_mismatch' });
  await assert.rejects(verifyNativeConsumerRuntime(defaultHost), { code: 'consumer_library_file_set_mismatch' });
  const old = await fixture(t);
  await assert.rejects(verifyNativeConsumerSource({ ...old.input, expectedLibraryProfile: AGENT_KIT_DEVICE_LIBRARY_PROFILE }), { code: 'consumer_library_file_set_mismatch' });
  const other = await fixture(t, 'FreeTWAI-AI/freedom-storefront');
  await assert.rejects(verifyNativeConsumerSource({ ...other.input, expectedLibraryProfile: AGENT_KIT_DEVICE_LIBRARY_PROFILE }), { code: 'unsupported_library_profile' });
});

test('lock metadata, self-hashed new artifacts and alternate source cannot select host authority', async t => {
  const { input, lock } = await fixture(t, 'FreeTWAI-AI/freedom-agent-kit', AGENT_KIT_DEVICE_LIBRARY_PROFILE);
  await assert.rejects(verifyNativeConsumerSource({ ...input, expectedLibraryProfile: '../arbitrary-profile' }), { code: 'unsupported_library_profile' });
  await assert.rejects(verifyNativeConsumerSource({ ...input, arbitraryFiles: lock.files }), { code: 'consumer_host_input_invalid' });
  lock.profile = LEGACY_LIBRARY_PROFILE;
  await put(input.candidateRoot, 'consumer-libraries.lock.json', pretty(lock)); input.candidateCommit = commit(input.candidateRoot);
  await assert.rejects(verifyNativeConsumerSource(input), { code: 'library_profile_mismatch' });
  lock.profile = AGENT_KIT_DEVICE_LIBRARY_PROFILE;
  lock.source_commit = 'f'.repeat(40);
  await put(input.candidateRoot, 'consumer-libraries.lock.json', pretty(lock)); input.candidateCommit = commit(input.candidateRoot);
  await assert.rejects(verifyNativeConsumerSource(input), { code: 'library_source_mismatch' });
  lock.source_commit = input.expectedSourceCommit;
  const fake = Buffer.from('export const forgedDevice = true;');
  await put(input.candidateRoot, lock.files[1].path, fake);
  lock.files[1].sha256 = sha256(fake); lock.files[1].bytes = fake.length;
  await put(input.candidateRoot, 'consumer-libraries.lock.json', pretty(lock)); input.candidateCommit = commit(input.candidateRoot);
  await assert.rejects(verifyNativeConsumerSource(input), { code: 'library_source_bytes_mismatch' });
  const old = await fixture(t); old.lock.profile = AGENT_KIT_DEVICE_LIBRARY_PROFILE;
  await put(old.input.candidateRoot, 'consumer-libraries.lock.json', pretty(old.lock)); old.input.candidateCommit = commit(old.input.candidateRoot);
  await assert.rejects(verifyNativeConsumerSource(old.input), { code: 'library_profile_mismatch' });
});

test('native source CLI ignores arbitrary environment source/profile overrides and uses its installed repo tuple', async t => {
  const { input } = await fixture(t, 'FreeTWAI-AI/freedom-agent-kit', AGENT_KIT_DEVICE_LIBRARY_PROFILE);
  const script = fileURLToPath(new URL('../github-consumer-host.mjs', import.meta.url));
  const env = { ...verificationEnvironment(), GITHUB_ACTIONS:'true', GITHUB_EVENT_NAME:'pull_request', GITHUB_REPOSITORY:input.repository,
    GITHUB_SHA:input.candidateCommit, FREEDOM_WORKFLOW_SHA:input.expectedWorkflowCommit,
    FREEDOM_WORKFLOW_REPOSITORY:'FreeTWAI-AI/freedom-platform', FREEDOM_WORKFLOW_PATH:'.github/workflows/trusted-consumer-libraries.yml' };
  for(const extras of [{}, {FREEDOM_LIBRARY_SOURCE_SHA:input.expectedSourceCommit,FREEDOM_LIBRARY_PROFILE:AGENT_KIT_DEVICE_LIBRARY_PROFILE},
    {FREEDOM_LIBRARY_SOURCE_SHA:'f'.repeat(40),FREEDOM_LIBRARY_PROFILE:'candidate-choice'}]) {
    const result=spawnSync(process.execPath,[script,input.candidateRoot,input.sourceRoot],{env:{...env,...extras},encoding:'utf8'});
    assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).code,'consumer_supported_tuple_required');
  }
});
