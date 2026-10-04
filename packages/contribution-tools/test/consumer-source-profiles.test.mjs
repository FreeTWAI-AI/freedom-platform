import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONSUMER_SOURCE_PROFILES, verifyConsumerSourceProfile } from '../consumer-source-profiles.mjs';
import { sha256 } from '../io.mjs';
import { fixtureRoot, put } from './fixtures.mjs';

const source = fileURLToPath(new URL('../../../', import.meta.url));
async function fixture(t, repository = 'FreeTWAI-AI/freedom-project-page') {
  const root = await fixtureRoot(t), baseline = new Map(), profile = CONSUMER_SOURCE_PROFILES[repository];
  for (const path of profile.required_paths) await put(root, path, 'throw new Error("candidate code must not execute");\n');
  const manifest = JSON.parse(await readFile(join(source, 'freedom.project.yaml')));
  manifest.repository.full_name = repository; manifest.repository.html_url = 'https://github.com/' + repository;
  await put(root, 'freedom.project.yaml', JSON.stringify(manifest));
  await put(root, 'package.json', JSON.stringify({ scripts: Object.fromEntries(profile.script_names.map(name => [name, 'node scripts/never-execute.mjs'])) }));
  await put(root, 'package-lock.json', '{"lockfileVersion":3}');
  await put(root, '.tool-versions', 'nodejs 24\n');
  const bundleBytes = await readFile(join(source, 'contracts/preview/v1/bundle.json')), bundle = JSON.parse(bundleBytes);
  await put(root, 'contracts.lock.json', JSON.stringify({ format: 'freedom.contract-pin/v1', source_repository: 'FreeTWAI-AI/freedom-platform',
    source_commit: 'b'.repeat(40), bundle_path: 'contracts/preview/v1', protocol: bundle.protocol,
    protocol_sha256: bundle.protocol_sha256, bundle_sha256: sha256(bundleBytes) }));
  const preview = ['bundle.json', ...Object.keys(bundle.files)].map(path => 'vendor/freedom-platform/' + path);
  for (const path of preview) await put(root, path, await readFile(join(source, path.replace('vendor/freedom-platform', 'contracts/preview/v1'))));
  for (const path of [...profile.required_paths, ...preview]) baseline.set(path, await readFile(join(root, path)));
  return { repository, repositoryRoot: root, readBaseline: async path => baseline.get(path),
    readCanonical: async path => readFile(join(source, path)), baseline, root };
}

test('all six actual source profiles preserve preview pins, validate full manifest schema and never execute candidate entries', async t => {
  for (const repository of Object.keys(CONSUMER_SOURCE_PROFILES)) {
    const state = await fixture(t, repository);
    const result = await verifyConsumerSourceProfile(state);
    assert.equal(result.status, 'passed'); assert.equal(result.preview_source_commit, 'b'.repeat(40));
    assert.equal(result.manifest_schema, 'validated'); assert.equal(result.candidate_code_executed, false);
    assert.equal(result.library_usage, 'not_checked'); assert.equal(result.runtime_observation, 'not_checked');
    assert.equal(result.gate_enforced, false); assert.equal(result.execution_authorized, false);
  }
});

test('real product source edits remain possible but missing build and verification entry changes fail', async t => {
  const state = await fixture(t);
  await put(state.root, 'src/index.mjs', 'throw new Error("new product source is still data");\n');
  assert.equal((await verifyConsumerSourceProfile(state)).entries, 'required-paths-present');
  await put(state.root, 'scripts/build.mjs', 'process.exit(0);');
  await assert.rejects(verifyConsumerSourceProfile(state), { code: 'consumer_verification_entry_changed' });
  await rm(join(state.root, 'scripts/build.mjs'));
  await assert.rejects(verifyConsumerSourceProfile(state), { code: 'artifact_missing' });
  await put(state.root, 'scripts/build.mjs', state.baseline.get('scripts/build.mjs'));
  await put(state.root, 'scripts/verify-contracts.mjs', 'process.exit(0);');
  await assert.rejects(verifyConsumerSourceProfile(state), { code: 'consumer_verification_entry_changed' });
});

test('command bypasses, schema-invalid manifests, identity and authority changes are rejected', async t => {
  const state = await fixture(t);
  const change = async (path, mutate, code) => {
    const original = state.baseline.get(path), data = JSON.parse(original); mutate(data);
    await put(state.root, path, JSON.stringify(data));
    await assert.rejects(verifyConsumerSourceProfile(state), { code });
    await put(state.root, path, original);
  };
  await change('package.json', data => { data.scripts.build = 'echo passed'; }, 'consumer_entry_command_changed');
  await change('package.json', data => { data.scripts.prebuild = 'echo injected'; }, 'consumer_entry_command_changed');
  await change('package.json', data => { data.exports = './unregistered.mjs'; }, 'consumer_exports_changed');
  await change('freedom.project.yaml', data => { data.name = 42; }, 'consumer_manifest_invalid');
  await change('freedom.project.yaml', data => { data.repository.full_name = 'attacker/project'; }, 'consumer_manifest_repository_mismatch');
  await change('freedom.project.yaml', data => { data.ownership.accountable_party_ref = 'user:other'; }, 'consumer_manifest_authority_changed');
  await change('freedom.project.yaml', data => { data.page.requested_trust_label = 'official'; }, 'consumer_manifest_authority_changed');
  await change('freedom.project.yaml', data => { data.toolchain.lockfile = '../other'; }, 'consumer_manifest_authority_changed');
});

test('canonical comparison rejects stale or forged source even when the baseline reader agrees', async t => {
  const state = await fixture(t);
  await assert.rejects(verifyConsumerSourceProfile({ ...state, readCanonical: async path => path.endsWith('/client.mjs')
    ? Buffer.from('forged SDK') : state.readCanonical(path) }), { code: 'consumer_preview_canonical_mismatch' });
  const original = state.baseline.get('contracts.lock.json'), lock = JSON.parse(original);
  lock.source_commit = 'c'.repeat(40);
  await put(state.root, 'contracts.lock.json', JSON.stringify(lock));
  await assert.rejects(verifyConsumerSourceProfile(state), { code: 'consumer_preview_baseline_changed' });
});

test('candidate Python shadow modules are ignored and symlinked profile files fail closed', async t => {
  const state = await fixture(t);
  await put(state.root, 'jsonschema.py', 'raise RuntimeError("candidate module executed")\n');
  assert.equal((await verifyConsumerSourceProfile(state)).manifest_schema, 'validated');
  await rm(join(state.root, '.tool-versions'));
  await symlink('/dev/null', join(state.root, '.tool-versions'));
  await assert.rejects(verifyConsumerSourceProfile(state), { code: 'artifact_symlink' });
});
