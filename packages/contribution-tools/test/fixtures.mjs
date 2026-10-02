import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../io.mjs';
import { releaseSigningBytes } from '../contracts.mjs';

export const NOW = Date.parse('2026-10-02T12:00:00.000Z');
export const pretty = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
export const copy = value => JSON.parse(JSON.stringify(value));
export async function fixtureRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'fp-governance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
export async function put(root, path, bytes) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), bytes);
}

export async function releaseFixture(t) {
  const root = await fixtureRoot(t), vendor = join(root, 'vendor/freedom-platform');
  const contents = { 'contracts/example.json': pretty({ format: 'fixture/v1' }),
    'client/client.mjs': Buffer.from('export const fixture = true;\n'),
    'policy/rules.json': pretty({ fixture_only: true }),
    'generator/version.json': pretty({ version: '1.0.0' }),
    'fixtures/vectors.json': pretty([{ accepted: false }]) };
  const manifest = {
    format: 'freedom.release-set/v1', digest_profile: 'sha256-exact-bytes/v1', release_set_id: 'fixture-20261002',
    source_repository: 'FreeTWAI-AI/freedom-platform', source_commit: 'a'.repeat(40), trust_profile_version: '1',
    artifacts: Object.entries(contents).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) })),
    contracts: [{ family: 'preview', version: '1', artifacts: ['contracts/example.json'] }],
    libraries: [{ library_id: 'member-client', version: '1.0.0', runtime_profiles: ['member'], artifacts: ['client/client.mjs'] }],
    policy: { revision: '1', artifacts: ['policy/rules.json'] },
    generator: { version: '1.0.0', artifacts: ['generator/version.json'] },
    fixtures: { version: '1.0.0', artifacts: ['fixtures/vectors.json'] }, profiles: ['member'],
  };
  // Only ephemeral synthetic test keys. Never serialize the private key.
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const trustProfile = {
    format: 'freedom.release-trust/v1', version: '1', environment: 'fixture',
    issued_at: '2026-10-02T00:00:00.000Z', expires_at: '2026-10-03T00:00:00.000Z',
    keys: [{ kid: 'fixture-key', publisher_id: 'fixture-publisher', source_repository: manifest.source_repository,
      purpose: 'freedom.release-set', public_jwk: publicKey.export({ format: 'jwk' }),
      not_before: '2026-10-01T00:00:00.000Z', not_after: '2026-10-04T00:00:00.000Z' }], releases: [],
  };
  const state = { root, vendor, contents, manifest, trustProfile,
    options: { repositoryRoot: root, trustProfile, environment: 'fixture', now: NOW } };
  state.save = async ({ approve = true } = {}) => {
    state.manifestBytes = pretty(state.manifest);
    state.proof = { format: 'freedom.release-proof/v1', algorithm: 'Ed25519', purpose: 'freedom.release-set',
      publisher_id: 'fixture-publisher', kid: 'fixture-key', manifest_sha256: sha256(state.manifestBytes),
      signature: sign(null, releaseSigningBytes(state.manifestBytes), privateKey).toString('base64url') };
    state.proofBytes = pretty(state.proof);
    state.lock = { format: 'freedom.contract-pin/v2', source_repository: state.manifest.source_repository,
      source_commit: state.manifest.source_commit,
      release_set: { path: 'release-set.json', sha256: sha256(state.manifestBytes) },
      proof: { path: 'release-set.proof.json', sha256: sha256(state.proofBytes) },
      profiles: ['member'], artifacts: copy(state.manifest.artifacts) };
    if (approve) trustProfile.releases = [{ manifest_sha256: sha256(state.manifestBytes), policy_revision: state.manifest.policy.revision, state: 'supported' }];
    await put(vendor, 'release-set.json', state.manifestBytes);
    await put(vendor, 'release-set.proof.json', state.proofBytes);
    await put(root, 'contracts.lock.json', pretty(state.lock));
  };
  for (const [path, bytes] of Object.entries(contents)) await put(vendor, path, bytes);
  await state.save();
  return state;
}

export async function legacyFixture(t) {
  const root = await fixtureRoot(t), vendor = join(root, 'vendor/freedom-platform');
  const source = fileURLToPath(new URL('../../../contracts/preview/v1/', import.meta.url));
  const manifestBytes = await readFile(join(source, 'bundle.json'));
  const manifest = JSON.parse(manifestBytes);
  for (const path of ['bundle.json', ...Object.keys(manifest.files)]) await put(vendor, path, await readFile(join(source, path)));
  const lock = { format: 'freedom.contract-pin/v1', source_repository: 'FreeTWAI-AI/freedom-platform',
    source_commit: '3de70ccbd24362a7925508fb42d36aaa256a0806', bundle_path: 'contracts/preview/v1',
    protocol: manifest.protocol, protocol_sha256: manifest.protocol_sha256, bundle_sha256: sha256(manifestBytes) };
  await put(root, 'contracts.lock.json', pretty(lock));
  return { root, vendor, source, lock, manifest };
}
