import { generateKeyPairSync, sign } from 'node:crypto';
import { readFile, readdir, chmod, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { fixtureRoot, releaseFixture, put, pretty } from './fixtures.mjs';
import { verificationEnvironment } from '../process-env.mjs';
import { sha256 } from '../io.mjs';
import { installedVerifierDigest, VERIFIER_INSTALLATION_FILES } from '../trusted-ci.mjs';
import { materializeBehaviorCandidate } from '../behavior-supervisor.mjs';
const suite = 'behavior.platform-member-routes';
const source = fileURLToPath(new URL('../../../', import.meta.url));
export async function installedHostFixture(t, actualCandidate = false) {
  const f = await releaseFixture(t), host = await mkdtemp(join(tmpdir(), 'fp-installed-host-')), distribution = await fixtureRoot(t), policyRoot = await fixtureRoot(t);
  if (actualCandidate) {
    const snapshot = await fixtureRoot(t);
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, env: verificationEnvironment() }).toString().trim();
    await materializeBehaviorCandidate(source, head, snapshot);
    async function copy(directory, prefix = '') {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        const path = prefix + item.name;
        if (['vendor', 'contracts.lock.json', '.git'].includes(path) || item.name === 'freedom.module.json') continue;
        if (item.isDirectory()) await copy(join(directory, item.name), path + '/');
        else await put(f.root, path, await readFile(join(directory, item.name)));
      }
    }
    await copy(snapshot);
  }
  const keys = [], privateKeys = new Map();
  for (const purpose of ['verifier-installation', 'github-candidate', 'runner-observations']) {
    const pair = generateKeyPairSync('ed25519'); privateKeys.set(purpose, pair.privateKey);
    keys.push({ kid: purpose, purpose, public_jwk: pair.publicKey.export({ format: 'jwk' }),
      not_before: new Date(Date.now() - 60000).toISOString(), not_after: new Date(Date.now() + 300000).toISOString() });
  }
  const trust = { publisher: 'synthetic-installed-host', keys };
  const envelope = (purpose, value) => { const payload = pretty(value); return pretty({ kid: purpose, payload: payload.toString('base64url'),
    signature: sign(null, Buffer.concat([Buffer.from(`freedom.github-host/${purpose}/v1\0`), payload]), privateKeys.get(purpose)).toString('base64url') }); };
  const files = [];
  for (const path of VERIFIER_INSTALLATION_FILES) { const bytes = await readFile(join(source, path)); await put(distribution, path, bytes); files.push({ path, sha256: sha256(bytes) }); }
  const verifier = { commit: 'b'.repeat(40), sha256: await installedVerifierDigest() };
  await put(distribution, 'installation.proof.json', envelope('verifier-installation', { format: 'freedom.github-verifier-installation/v1', publisher: trust.publisher, ...verifier, files }));
  await put(f.root, 'AGENTS.md', 'Synthetic');
  await put(f.root, 'packages/member/freedom.module.json', pretty({ format: 'freedom.module/v1', module_id: 'member', owner_role: 'foundation', owned_paths: ['packages/member/**'],
    public_exports: [], dependencies: [], contract_families: ['preview'], client_profiles: ['member'], instructions: ['AGENTS.md'], invariants: [], tests: [suite], surfaces: [] }));
  const git = (root, args) => execFileSync('git', args, { cwd: root, env: verificationEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  git(f.root, ['-c', 'init.templateDir=', 'init', '-q']);
  const commit = () => { git(f.root, ['add', '.']); git(f.root, ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Synthetic']); return git(f.root, ['rev-parse', 'HEAD']); };
  const base = commit();
  // Real candidate-controlled executable bytes. Neither preflight nor host runner
  // may execute or import them to obtain an accepted verdict.
  await put(f.root, 'packages/member/test.mjs', 'throw Error("CANDIDATE_TEST_EXECUTED");');
  await put(f.root, 'packages/member/package.json', '{"scripts":{"test":"echo success"}}');
  const head = commit(), objects = await fixtureRoot(t);
  git(f.root, ['clone', '--bare', '--no-hardlinks', '-q', f.root, objects]);
  const policy = { format: 'freedom.trusted-ci-policy/v1', revision: 'synthetic', repository: 'example/member',
    source: { repository: f.manifest.source_repository, commit: f.manifest.source_commit, release_set_sha256: sha256(f.manifestBytes) }, verifier,
    workflow: { identity: 'example/member/.github/workflows/trusted-member.yml', commit: 'c'.repeat(40), publisher: trust.publisher },
    required_suites: [suite], fallback_suites: ['runtime.full'], suites: [suite, 'runtime.full'].map(id => ({ id, harness_sha256: sha256(id) })) };
  await put(policyRoot, 'trusted-ci-policy.json', pretty(policy));
  const adapter = { repository: policy.repository, trust, host_root: host, distribution_root: distribution, candidate_roots: [f.root],
    verifier_commit: verifier.commit, verifier_sha256: verifier.sha256, object_repository: objects, policy_root: policyRoot,
    expected_policy: { revision: policy.revision, sha256: sha256(pretty(policy)) } };
  const job = { format: 'freedom.github-candidate/v1', publisher: trust.publisher, issued_at: new Date(Date.now() - 1000).toISOString(),
    expires_at: new Date(Date.now() + 180000).toISOString(), event: 'pull_request', repository: policy.repository, run_id: '44', run_attempt: 1,
    pull_request: 4, base_commit: base, head_commit: head, candidate_commit: head, candidate_tree: git(f.root, ['rev-parse', 'HEAD^{tree}']) };
  const config = { adapter, dependency_root: join(source, 'node_modules'), installation: Object.fromEntries(
    ['supervisor_sha256', 'harness_sha256', 'node_runtime_sha256', 'dependency_sha256'].map(key => [key, '0'.repeat(64)])) };
  t.after(async () => { async function unseal(path) { await chmod(path, 0o755); for (const item of await readdir(path, { withFileTypes: true })) if (item.isDirectory()) await unseal(join(path, item.name)); } await unseal(host); await rm(host, { recursive: true, force: true }); });
  return { config, job, envelope, privateKeys, host, policy, policyRoot };
}
