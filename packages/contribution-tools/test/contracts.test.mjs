import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, sign } from 'node:crypto';
import { sha256 } from '../io.mjs';
import { validateFormat } from '../formats.mjs';
import { verifyContractPin, verifyReleaseProof, validateReleaseSet, releaseSigningBytes,
  verifyLibraryResolution, buildReleaseSet } from '../contracts.mjs';
import { releaseFixture, legacyFixture, copy, pretty, put, NOW } from './fixtures.mjs';

const options = state => ({ trustProfile: state.trustProfile, environment: 'fixture', now: NOW });

test('a signed synthetic ReleaseSet is explicitly fixture/local, never execution authority', async t => {
  const f = await releaseFixture(t);
  const result = await verifyContractPin(f.options);
  assert.equal(result.status, 'passed');
  assert.equal(result.publisher_trust, 'fixture');
  assert.equal(result.assurance_level, 'local');
  assert.equal(result.execution_authorized, false);
  assert.equal(result.library_usage, 'not_checked');
  assert.equal(result.artifact_count, 7);
});

test('missing operator trust is unavailable, not pass and not a self-signed fallback', async t => {
  const f = await releaseFixture(t);
  await put(f.root, 'governance/self-approved.json', pretty(f.trustProfile));
  await assert.rejects(verifyContractPin({ repositoryRoot: f.root }), { code: 'release_trust_unavailable', unavailable: true });
});

test('vendor edit is detected even when the lock alone is edited', async t => {
  const f = await releaseFixture(t);
  const path = 'client/client.mjs', bytes = Buffer.from('export const tampered = true;\n');
  await put(f.vendor, path, bytes);
  await assert.rejects(verifyContractPin(f.options), { code: 'artifact_integrity_mismatch' });
  Object.assign(f.lock.artifacts.find(item => item.path === path), { bytes: bytes.length, sha256: sha256(bytes) });
  await put(f.root, 'contracts.lock.json', pretty(f.lock));
  await assert.rejects(verifyContractPin(f.options), { code: 'artifact_pin_mismatch' });
});

test('editing artifact, manifest, lock and a new self-signature still fails the independent approval', async t => {
  const f = await releaseFixture(t);
  const path = 'client/client.mjs', bytes = Buffer.from('export const tampered = true;\n');
  await put(f.vendor, path, bytes);
  Object.assign(f.manifest.artifacts.find(item => item.path === path), { bytes: bytes.length, sha256: sha256(bytes) });
  await f.save({ approve: false });
  // Even the original key is insufficient to add an unapproved subject.
  await assert.rejects(verifyContractPin(f.options), { code: 'release_not_approved' });
});

test('candidate public key cannot impersonate the approved publisher', async t => {
  const f = await releaseFixture(t), attacker = generateKeyPairSync('ed25519');
  f.proof.signature = sign(null, releaseSigningBytes(f.manifestBytes), attacker.privateKey).toString('base64url');
  assert.throws(() => verifyReleaseProof(f.manifestBytes, pretty(f.proof), options(f)), { code: 'invalid_signature' });
  f.proof.public_jwk = attacker.publicKey.export({ format: 'jwk' });
  assert.throws(() => verifyReleaseProof(f.manifestBytes, pretty(f.proof), options(f)), { code: 'schema_violation' });
});

test('signature covers exact bytes and has release-specific domain separation', async t => {
  const f = await releaseFixture(t);
  assert.throws(() => verifyReleaseProof(Buffer.from(JSON.stringify(f.manifest)), f.proofBytes, options(f)), { code: 'proof_subject_mismatch' });
  f.proof.signature = 'A'.repeat(86);
  assert.throws(() => verifyReleaseProof(f.manifestBytes, pretty(f.proof), options(f)), { code: 'invalid_signature' });
  assert(releaseSigningBytes(f.manifestBytes).subarray(0, 32).toString().startsWith('freedom.release-set-signature/'));
});

for (const [name, mutate, code] of [
  ['wrong purpose', f => { f.proof.purpose = 'freedom.login'; }, 'schema_violation'],
  ['wrong algorithm', f => { f.proof.algorithm = 'HS256'; }, 'schema_violation'],
  ['unknown kid', f => { f.proof.kid = 'unknown'; }, 'publisher_not_approved'],
  ['wrong publisher', f => { f.proof.publisher_id = 'unknown'; }, 'publisher_not_approved'],
  ['jku injection', f => { f.proof.jku = 'https://attacker.invalid/key'; }, 'schema_violation'],
  ['private JWK injection', f => { f.trustProfile.keys[0].public_jwk.d = 'never-allow-private-material'; }, 'schema_violation'],
  ['withdrawn release', f => { f.trustProfile.releases[0].state = 'withdrawn'; }, 'release_withdrawn'],
  ['policy revision mismatch', f => { f.trustProfile.releases[0].policy_revision = 'other'; }, 'policy_revision_mismatch'],
  ['duplicate approval', f => { f.trustProfile.releases.push(copy(f.trustProfile.releases[0])); }, 'duplicate_release_status'],
  ['duplicate kid', f => { f.trustProfile.keys.push(copy(f.trustProfile.keys[0])); }, 'duplicate_trust_key'],
  ['expired signer', f => { f.trustProfile.keys[0].not_after = '2026-10-02T11:00:00.000Z'; }, 'signing_key_inactive'],
  ['future signer', f => { f.trustProfile.keys[0].not_before = '2026-10-02T13:00:00.000Z'; }, 'signing_key_inactive'],
  ['invalid date', f => { f.trustProfile.issued_at = '2026-02-31T00:00:00.000Z'; }, 'invalid_trust_time'],
  ['overlong freshness', f => { f.trustProfile.expires_at = '2026-10-05T00:00:00.000Z'; }, 'invalid_trust_window'],
]) {
  test(`reject ${name}`, async t => {
    const f = await releaseFixture(t); mutate(f);
    assert.throws(() => verifyReleaseProof(f.manifestBytes, pretty(f.proof), options(f)), { code });
  });
}
test('trust environment, expiry and version cannot be downgraded', async t => {
  const f = await releaseFixture(t);
  assert.throws(() => verifyReleaseProof(f.manifestBytes, f.proofBytes, { ...options(f), environment: 'production' }), { code: 'trust_environment_mismatch' });
  assert.throws(() => verifyReleaseProof(f.manifestBytes, f.proofBytes, { ...options(f), now: Date.parse(f.trustProfile.expires_at) }), { code: 'release_trust_stale', unavailable: true });
  assert.throws(() => verifyReleaseProof(f.manifestBytes, f.proofBytes, { ...options(f), now: Date.parse(f.trustProfile.issued_at) - 1 }), { code: 'release_trust_stale' });
  f.trustProfile.version = '2';
  assert.throws(() => verifyReleaseProof(f.manifestBytes, f.proofBytes, options(f)), { code: 'trust_version_mismatch' });
});

for (const [name, mutate, code] of [
  ['unclassified artifact', m => { m.artifacts.push({ path: 'extra', sha256: 'a'.repeat(64), bytes: 1 }); }, 'unclassified_release_artifact'],
  ['missing reference', m => { m.policy.artifacts = ['not-present']; }, 'missing_release_artifact'],
  ['duplicate family', m => { m.contracts.push(copy(m.contracts[0])); }, 'duplicate_contract_family'],
  ['duplicate library', m => { m.libraries.push(copy(m.libraries[0])); }, 'duplicate_library'],
  ['unknown runtime', m => { m.libraries[0].runtime_profiles = ['unknown']; }, 'unknown_runtime_profile'],
  ['self-reference', m => { m.artifacts[0].path = 'release-set.json'; }, 'self_referential_release'],
  ['case collision', m => { m.artifacts.push({ ...m.artifacts[0], path: 'Contracts/another.json' }); }, 'case_collision'],
  ['path traversal', m => { m.artifacts[0].path = '../secret'; }, 'invalid_artifact_path'],
  ['floating SHA', m => { m.source_commit = 'main'; }, 'schema_violation'],
  ['newline SHA', m => { m.source_commit += '\n'; }, 'schema_violation'],
  ['wrong repository', m => { m.source_repository = 'example/freedom-platform'; }, 'schema_violation'],
]) {
  test(`manifest rejects ${name}`, async t => {
    const f = await releaseFixture(t); mutate(f.manifest);
    assert.throws(() => validateReleaseSet(f.manifest), { code });
  });
}

test('exact file set rejects extras, missing files and symlinked vendor parents', async t => {
  const f = await releaseFixture(t);
  await put(f.vendor, 'extra.mjs', 'do not execute');
  await assert.rejects(verifyContractPin(f.options), { code: 'artifact_set_mismatch' });
  await unlink(join(f.vendor, 'extra.mjs'));
  await unlink(join(f.vendor, 'client/client.mjs'));
  await assert.rejects(verifyContractPin(f.options), { code: 'artifact_set_mismatch' });
  await symlink(join(f.vendor, 'policy/rules.json'), join(f.vendor, 'client/client.mjs'));
  await assert.rejects(verifyContractPin(f.options), { code: 'artifact_symlink' });
  const other = await releaseFixture(t);
  await symlink(other.vendor, join(other.root, 'linked-vendor'));
  await assert.rejects(verifyContractPin({ ...other.options, vendorPath: 'linked-vendor' }), { code: 'artifact_symlink' });
});

test('source commit, runtime profile, proof pin and lock version are checked', async t => {
  const f = await releaseFixture(t), original = copy(f.lock);
  for (const [mutate, code] of [
    [lock => { lock.source_commit = 'b'.repeat(40); }, 'source_commit_mismatch'],
    [lock => { lock.profiles = ['other']; }, 'unknown_runtime_profile'],
    [lock => { lock.proof.sha256 = 'b'.repeat(64); }, 'release_pin_mismatch'],
    [lock => { lock.artifacts.push(copy(lock.artifacts[0])); }, 'duplicate_artifact_path'],
    [lock => { lock.format = 'freedom.contract-pin/v3'; }, 'schema_violation'],
  ]) {
    const lock = copy(original); mutate(lock); await put(f.root, 'contracts.lock.json', pretty(lock));
    await assert.rejects(verifyContractPin(f.options), { code });
  }
});

test('resolution checks actual library records, not installation alone', async t => {
  const f = await releaseFixture(t);
  const item = f.manifest.artifacts.find(artifact => artifact.path === 'client/client.mjs');
  const record = { library_id: 'member-client', version: '1.0.0', artifact_path: item.path, sha256: item.sha256 };
  assert.equal(verifyLibraryResolution(f.manifest, 'member', [record]).status, 'passed');
  assert.throws(() => verifyLibraryResolution(f.manifest, 'member', []), { code: 'resolution_unavailable' });
  assert.throws(() => verifyLibraryResolution(f.manifest, 'member', [record, { ...record, version: '2.0.0' }]), { code: 'incompatible_library_resolution' });
  assert.throws(() => verifyLibraryResolution(f.manifest, 'member', [{ ...record, sha256: 'b'.repeat(64) }]), { code: 'library_integrity_mismatch' });
  assert.throws(() => verifyLibraryResolution(f.manifest, 'other', [record]), { code: 'unknown_runtime_profile' });
});

test('authoring is deterministic, computes bytes, and neither signs nor publishes', async t => {
  const f = await releaseFixture(t), metadata = copy(f.manifest);
  delete metadata.artifacts;
  const paths = Object.keys(f.contents);
  const first = await buildReleaseSet({ artifactRoot: f.vendor, artifactPaths: paths, metadata });
  const second = await buildReleaseSet({ artifactRoot: f.vendor, artifactPaths: paths.reverse(), metadata });
  assert(first.equals(second));
  assert(!JSON.parse(first).signature);
  await assert.rejects(buildReleaseSet({ artifactRoot: f.vendor, artifactPaths: paths, metadata: f.manifest }), { code: 'authoring_artifacts_are_derived' });
});

test('existing preview bundle passes unchanged and gains no publisher/execution authority', async t => {
  const f = await legacyFixture(t);
  const result = await verifyContractPin({ repositoryRoot: f.root });
  assert.equal(result.status, 'passed');
  assert.equal(result.profile, 'legacy_preview');
  assert.equal(result.publisher_trust, 'unverified');
  assert.equal(result.execution_authorized, false);
  assert.equal(result.artifact_count, 10);
  const requested = [];
  const remote = await verifyContractPin({ repositoryRoot: f.root, remote: true, fetcher: async (url, config) => {
    requested.push(url); assert.equal(config.redirect, 'error');
    const prefix = `https://raw.githubusercontent.com/FreeTWAI-AI/freedom-platform/${f.lock.source_commit}/contracts/preview/v1/`;
    assert(url.startsWith(prefix));
    return new Response(await readFile(join(f.source, url.slice(prefix.length))));
  } });
  assert.equal(remote.remote_source_checked, true); assert.equal(requested.length, 10);
});
test('legacy byte/hash edits fail pinned source and unknown files remain rejected', async t => {
  const f = await legacyFixture(t);
  await put(f.vendor, 'unexpected', 'x');
  await assert.rejects(verifyContractPin({ repositoryRoot: f.root }), { code: 'artifact_set_mismatch' });
  await unlink(join(f.vendor, 'unexpected'));
  await assert.rejects(verifyContractPin({ repositoryRoot: f.root, remote: true, fetcher: async () => new Response('wrong') }), { code: 'pinned_source_mismatch' });
  await writeFile(join(f.vendor, 'client.mjs'), 'tampered');
  await assert.rejects(verifyContractPin({ repositoryRoot: f.root }), { code: 'artifact_integrity_mismatch' });
});

test('module/context/report schemas require scope and disallow candidate commands', () => {
  const module = { format: 'freedom.module/v1', module_id: 'assets', owner_role: 'foundation',
    owned_paths: ['modules/assets/**'], public_exports: [], dependencies: [], contract_families: ['assets'],
    client_profiles: ['member'], instructions: ['AGENTS.md'], invariants: ['privacy'], tests: ['assets'], surfaces: [] };
  validateFormat('moduleDescriptor', module);
  assert.throws(() => validateFormat('moduleDescriptor', { ...module, command: 'echo passed' }), { code: 'schema_violation' });
  assert.throws(() => validateFormat('moduleDescriptor', { ...module, tests: [] }), { code: 'schema_violation' });
  assert.throws(() => validateFormat('codingContext', {}), { code: 'schema_violation' });
  assert.throws(() => validateFormat('verifierReport', { assurance_level: 'trusted_ci' }), { code: 'schema_violation' });
});

test('bootstrap CLI has safe machine output and exit 0/1/2; candidate trust is not an option', async t => {
  const entry = fileURLToPath(new URL('../pin-cli.mjs', import.meta.url));
  const run = (root, args = []) => spawnSync(process.execPath,
    ['--input-type=module', '-e', `import { runPinCli } from ${JSON.stringify(new URL('../pin-cli.mjs', import.meta.url).href)}; process.exitCode = await runPinCli(process.argv.slice(1));`, '--', ...args],
    { cwd: root, encoding: 'utf8' });
  assert(entry.endsWith('pin-cli.mjs'));
  const legacy = await legacyFixture(t), release = await releaseFixture(t);
  const passed = run(legacy.root);
  assert.equal(passed.status, 0, passed.stderr); assert.equal(JSON.parse(passed.stdout).status, 'passed');
  const missingTrust = run(release.root);
  assert.equal(missingTrust.status, 2, missingTrust.stderr); assert.equal(JSON.parse(missingTrust.stdout).code, 'release_trust_unavailable');
  const rejected = run(release.root, ['--trust', 'self-approved']);
  assert.equal(rejected.status, 1, rejected.stderr); assert.equal(JSON.parse(rejected.stdout).code, 'invalid_arguments');
  await put(legacy.root, 'contracts.lock.json', '{"do_not_print_private_value":');
  const bad = run(legacy.root);
  assert.equal(bad.status, 1); assert(!bad.stdout.includes('do_not_print_private_value')); assert.equal(bad.stderr, '');
});
