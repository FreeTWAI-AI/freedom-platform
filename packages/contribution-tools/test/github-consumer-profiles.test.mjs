import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureRoot, put, pretty } from './fixtures.mjs';
import { verificationEnvironment } from '../process-env.mjs';
import { sha256 } from '../io.mjs';
import { CONSUMER_SOURCE_PROFILES } from '../consumer-source-profiles.mjs';
import { verifyNativeConsumerSource } from '../github-consumer-host.mjs';

const canonical = fileURLToPath(new URL('../../../', import.meta.url));
function git(root, args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root, env: verificationEnvironment(), stdio: ['ignore', 'pipe', 'pipe'],
  }).toString().trim();
}
function commit(root) {
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Synthetic source profile']);
  return git(root, ['rev-parse', 'HEAD']);
}
async function fixture(t, repository = 'FreeTWAI-AI/freedom-project-page') {
  const candidateRoot = await fixtureRoot(t), sourceRoot = await fixtureRoot(t);
  for (const root of [candidateRoot, sourceRoot]) git(root, ['-c', 'init.templateDir=', 'init', '-q']);
  const profile = CONSUMER_SOURCE_PROFILES[repository];
  for (const path of profile.required_paths) await put(candidateRoot, path, 'throw Error("CANDIDATE_ENTRY_MUST_NOT_EXECUTE");');
  const manifest = JSON.parse(await readFile(join(canonical, 'freedom.project.yaml')));
  manifest.repository.full_name = repository; manifest.repository.html_url = 'https://github.com/' + repository;
  await put(candidateRoot, 'freedom.project.yaml', pretty(manifest));
  await put(candidateRoot, 'package.json', pretty({ scripts: Object.fromEntries(profile.script_names.map(name => [name, 'node scripts/never-execute.mjs'])) }));
  await put(candidateRoot, 'package-lock.json', '{"lockfileVersion":3}');
  await put(candidateRoot, '.tool-versions', 'nodejs 24\n');
  const bundleBytes = await readFile(join(canonical, 'contracts/preview/v1/bundle.json')), bundle = JSON.parse(bundleBytes);
  for (const path of ['bundle.json', ...Object.keys(bundle.files)]) {
    const bytes = await readFile(join(canonical, 'contracts/preview/v1', path));
    await put(candidateRoot, 'vendor/freedom-platform/' + path, bytes);
    await put(sourceRoot, 'contracts/preview/v1/' + path, bytes);
  }
  const validatorPath = 'scripts/repository-bootstrap/verify-project-manifest.py';
  await put(sourceRoot, validatorPath, await readFile(join(canonical, validatorPath)));
  await put(candidateRoot, 'contracts.lock.json', pretty({ format: 'freedom.contract-pin/v1',
    source_repository: 'FreeTWAI-AI/freedom-platform', source_commit: 'b'.repeat(40), bundle_path: 'contracts/preview/v1',
    protocol: bundle.protocol, protocol_sha256: bundle.protocol_sha256, bundle_sha256: sha256(bundleBytes) }));
  const baseline = commit(candidateRoot);
  await put(sourceRoot, 'repositories.lock.json', pretty({ format: 'freedom.repository-set/v1', repositories: [{ repository, commit: baseline }] }));
  const expectedSourceCommit = commit(sourceRoot);
  await put(candidateRoot, 'observation.json', '{"status":"passed","library_usage":"observed"}');
  const candidateCommit = commit(candidateRoot);
  return { input: { repository, candidateRoot, sourceRoot, candidateCommit, expectedSourceCommit,
    expectedWorkflowCommit: expectedSourceCommit }, baseline, profile };
}

test('six native source profiles use immutable blobs and fixed canonical validation without candidate execution', async t => {
  for (const repository of Object.keys(CONSUMER_SOURCE_PROFILES)) {
    const { input, baseline, profile } = await fixture(t, repository);
    // Working-tree lies and candidate-produced observations are not authority.
    await put(input.candidateRoot, 'freedom.project.yaml', '{"forged":true}');
    const report = await verifyNativeConsumerSource(input);
    assert.equal(report.status, 'passed'); assert.equal(report.baseline_commit, baseline);
    assert.equal(report.source_profile, profile.profile); assert.equal(report.verification, 'source_and_manifest_only');
    assert.equal(report.profile_result.entries, 'required-paths-present');
    assert.deepEqual(report.profile_result.protected_automation.paths, profile.baseline_equal_paths);
    assert.equal(report.profile_result.manifest_schema, 'validated');
    assert.equal(report.profile_result.candidate_code_executed, false);
    assert.equal(report.library_usage, 'not_checked'); assert.equal(report.runtime_observation, 'not_checked');
    assert.equal(report.gate_enforced, false); assert.equal(report.merge_authorized, false);
  }
});

test('native source profiles allow product edits but reject frozen build and verifier edits', async t => {
  const { input } = await fixture(t);
  await put(input.candidateRoot, 'src/index.mjs', 'throw Error("PRODUCT_EDIT_MUST_NOT_EXECUTE");');
  input.candidateCommit = commit(input.candidateRoot);
  assert.equal((await verifyNativeConsumerSource(input)).status, 'passed');
  for (const path of ['scripts/build.mjs', 'scripts/verify-project-manifest.py']) {
    const original = await readFile(join(input.candidateRoot, path));
    await put(input.candidateRoot, path, 'echo passed'); input.candidateCommit = commit(input.candidateRoot);
    await assert.rejects(verifyNativeConsumerSource(input), { code: 'consumer_verification_entry_changed' });
    await put(input.candidateRoot, path, original); input.candidateCommit = commit(input.candidateRoot);
  }
  await rm(join(input.candidateRoot, 'src/index.mjs')); input.candidateCommit = commit(input.candidateRoot);
  await assert.rejects(verifyNativeConsumerSource(input), { code: 'required_candidate_file_missing' });
});

test('candidate-selected baseline, manifest and canonical source cannot authorize their own changes', async t => {
  const { input } = await fixture(t);
  const manifest = JSON.parse(await readFile(join(input.candidateRoot, 'freedom.project.yaml')));
  manifest.ownership.accountable_party_ref = 'user:attacker';
  await put(input.candidateRoot, 'freedom.project.yaml', pretty(manifest));
  await put(input.candidateRoot, 'repositories.lock.json', pretty({ format: 'freedom.repository-set/v1',
    repositories: [{ repository: input.repository, commit: input.candidateCommit }] }));
  input.candidateCommit = commit(input.candidateRoot);
  await assert.rejects(verifyNativeConsumerSource(input), { code: 'consumer_manifest_authority_changed' });
  const other = await fixture(t);
  await put(other.input.sourceRoot, 'contracts/preview/v1/client.mjs', 'forged canonical source');
  other.input.expectedSourceCommit = commit(other.input.sourceRoot);
  other.input.expectedWorkflowCommit = other.input.expectedSourceCommit;
  await assert.rejects(verifyNativeConsumerSource(other.input), { code: 'consumer_preview_canonical_mismatch' });
});

test('schema validation rejects an invalid manifest even with candidate passing reports', async t => {
  const { input } = await fixture(t);
  const manifest = JSON.parse(await readFile(join(input.candidateRoot, 'freedom.project.yaml')));
  manifest.name = 42;
  await put(input.candidateRoot, 'freedom.project.yaml', pretty(manifest)); input.candidateCommit = commit(input.candidateRoot);
  await assert.rejects(verifyNativeConsumerSource(input), { code: 'consumer_manifest_invalid' });
});
