// Fixed source-integrity profiles for consumers that already use preview v1.
// Caller supplies immutable snapshots/readers from its trusted repository lock.
// Candidate code, workflows, package scripts and manifest validators are never executed.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { verifyPackageEntryRegistrations } from './consumer-entry-coverage.mjs';
import { verifyContractPin } from './contracts.mjs';
import { readBounded, parseJson, sha256 } from './io.mjs';
import { requireCondition as check, VerificationError } from './errors.mjs';
import { verificationEnvironment } from './process-env.mjs';

const run = promisify(execFile);
const verificationPaths = ['scripts/verify-contracts.mjs', 'scripts/verify-project-manifest.py', '.github/workflows/verify.yml'];
const commonPaths = ['contracts.lock.json', 'freedom.project.yaml', 'package.json', 'package-lock.json', '.tool-versions', ...verificationPaths];
function profile(id, entries, scripts, extraProtected = []) {
  const buildAutomation = entries.filter(path => /^(?:scripts|examples)\/[^/]+\.mjs$/.test(path));
  return Object.freeze({ profile: id, entry_paths: Object.freeze(entries), script_names: Object.freeze(scripts),
    required_paths: Object.freeze([...new Set([...commonPaths, ...entries, ...extraProtected])]),
    baseline_equal_paths: Object.freeze([...verificationPaths, ...buildAutomation, ...extraProtected]) });
}
export const CONSUMER_SOURCE_PROFILES = Object.freeze({
  'FreeTWAI-AI/.github': profile('community-automation', [], ['test', 'build'], ['.github/workflows/verify-template.yml']),
  'FreeTWAI-AI/FreeTWAI-AI.github.io': profile('source-directory',
    ['scripts/build.mjs', 'src/index.mjs', 'src/privacy.mjs', 'data/directory.json', 'data/privacy-discord-bot.json',
      'test/directory.test.mjs', 'test/privacy.test.mjs'], ['test', 'build'], ['.github/workflows/pages.yml']),
  'FreeTWAI-AI/freedom-growth-automation': profile('campaign-preview',
    ['src/index.mjs', 'services/campaign-worker/index.mjs', 'services/publication-worker/index.mjs',
      'packages/channel-adapters/index.mjs', 'examples/preview-campaign.mjs', 'tests/growth.test.mjs'], ['test', 'preview']),
  'FreeTWAI-AI/freedom-project-page': profile('project-page',
    ['scripts/build.mjs', 'src/index.mjs', 'test/render.test.mjs'], ['test', 'build']),
  'FreeTWAI-AI/freedom-project-template': profile('project-template',
    ['scripts/build.mjs', 'src/server.mjs', 'test/preview.test.mjs'], ['test', 'build', 'dev']),
  'FreeTWAI-AI/freedom-skill-registry': profile('skill-registry',
    ['scripts/check-registry.mjs', 'src/index.mjs', 'registry/packages.yaml', 'test/registry.test.mjs'], ['test', 'build']),
});

async function canonicalManifestValidation(repositoryRoot, readCanonical) {
  // Reuse the existing full Draft202012 validator, not a partial JavaScript schema clone.
  const script = await readCanonical('scripts/repository-bootstrap/verify-project-manifest.py');
  check(Buffer.isBuffer(script) && script.length > 0 && script.length <= 2_000_000, 'canonical_validator_missing');
  const directory = await mkdtemp(join(tmpdir(), 'fp-canonical-manifest-'));
  try {
    const path = join(directory, 'verify-project-manifest.py');
    await writeFile(path, script, { flag: 'wx', mode: 0o400 });
    // -I removes candidate cwd/PYTHONPATH from imports. No --github or network request.
    // The schema was already verified byte-for-byte against canonical source below.
    try {
      await run('python3', ['-I', path], { cwd: repositoryRoot, timeout: 20_000, maxBuffer: 256_000,
        env: verificationEnvironment(), windowsHide: true });
    } catch (error) {
      if (error.code === 'ENOENT' || /No module named ['"]jsonschema['"]/.test(String(error.stderr ?? ''))) {
        throw new VerificationError('manifest_validator_unavailable', true);
      }
      // Never echo candidate-controlled manifest values in the trusted report.
      throw new VerificationError('consumer_manifest_invalid');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Readers are host-owned Git blob readers, selected independently of candidate input. */
export async function verifyConsumerSourceProfile({ repository, repositoryRoot, readBaseline, readCanonical } = {}) {
  check(Object.hasOwn(CONSUMER_SOURCE_PROFILES, repository), 'unsupported_consumer_source_profile');
  check(typeof readBaseline === 'function' && typeof readCanonical === 'function', 'trusted_source_readers_required');
  const selected = CONSUMER_SOURCE_PROFILES[repository], evidence = [];
  for (const path of selected.required_paths) {
    const bytes = await readBounded(repositoryRoot, path);
    check(bytes.length > 0, 'consumer_entry_empty');
    evidence.push({ path, sha256: sha256(bytes) });
    if (selected.baseline_equal_paths.includes(path)) {
      check(bytes.equals(await readBaseline(path)), 'consumer_verification_entry_changed');
    }
  }
  const lockBytes = await readBounded(repositoryRoot, 'contracts.lock.json');
  check(lockBytes.equals(await readBaseline('contracts.lock.json')), 'consumer_preview_baseline_changed');
  const lock = parseJson(lockBytes);
  check(lock.format === 'freedom.contract-pin/v1' && lock.bundle_path === 'contracts/preview/v1', 'consumer_preview_profile_required');
  const preview = await verifyContractPin({ repositoryRoot });
  const bundle = parseJson(await readBounded(repositoryRoot, 'vendor/freedom-platform/bundle.json'));
  for (const path of ['bundle.json', ...Object.keys(bundle.files)]) {
    const bytes = await readBounded(repositoryRoot, 'vendor/freedom-platform/' + path);
    check(bytes.equals(await readBaseline('vendor/freedom-platform/' + path)), 'consumer_preview_baseline_changed');
    check(bytes.equals(await readCanonical('contracts/preview/v1/' + path)), 'consumer_preview_canonical_mismatch');
  }
  const candidatePackage = parseJson(await readBounded(repositoryRoot, 'package.json'));
  const baselinePackage = parseJson(await readBaseline('package.json'));
  for (const name of selected.script_names) {
    check(typeof baselinePackage.scripts?.[name] === 'string'
      && candidatePackage.scripts?.[name] === baselinePackage.scripts[name], 'consumer_entry_command_changed');
    for (const hook of ['pre' + name, 'post' + name]) {
      check(candidatePackage.scripts?.[hook] === baselinePackage.scripts?.[hook], 'consumer_entry_command_changed');
    }
  }
  check(isDeepStrictEqual(candidatePackage.exports, baselinePackage.exports), 'consumer_exports_changed');
  verifyPackageEntryRegistrations(candidatePackage, baselinePackage);
  const manifest = parseJson(await readBounded(repositoryRoot, 'freedom.project.yaml'));
  const baselineManifest = parseJson(await readBaseline('freedom.project.yaml'));
  check(manifest.repository?.full_name === repository, 'consumer_manifest_repository_mismatch');
  for (const key of ['project_id', 'repository', 'ownership', 'data_boundary', 'release', 'toolchain']) {
    check(isDeepStrictEqual(manifest[key], baselineManifest[key]), 'consumer_manifest_authority_changed');
  }
  for (const key of ['publication', 'requested_trust_label', 'source', 'canonical_platform_url']) {
    check(isDeepStrictEqual(manifest.page?.[key], baselineManifest.page?.[key]), 'consumer_manifest_authority_changed');
  }
  check(manifest.toolchain?.runtime_version_file === '.tool-versions'
    && manifest.toolchain?.lockfile === 'package-lock.json', 'consumer_toolchain_profile_changed');
  await canonicalManifestValidation(repositoryRoot, readCanonical);
  return { format: 'freedom.consumer-source-profile/v1', repository, profile: selected.profile, status: 'passed',
    verification: 'source_and_manifest_only', preview: 'canonical-bytes-and-unchanged-baseline-pin',
    preview_source_commit: preview.source_commit, manifest_schema: 'validated',
    protected_automation: { status: 'unchanged-from-approved-baseline', paths: selected.baseline_equal_paths },
    entries: 'required-paths-present', entry_commands: 'unchanged-from-approved-baseline', evidence,
    candidate_code_executed: false, library_usage: 'not_checked', runtime_observation: 'not_checked',
    publisher_trust: 'unverified', gate_enforced: false, merge_authorized: false, execution_authorized: false };
}
