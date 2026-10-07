import { mkdir, lstat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBounded, parseJson, sha256, artifactPath, uniquePaths } from './io.mjs';
import { validateFormat } from './formats.mjs';
import { requireCondition as check } from './errors.mjs';
import { verificationEnvironment } from './process-env.mjs';
import { CONSUMER_LIBRARIES, LEGACY_LIBRARY_PROFILE, consumerLibraryProfile, LIBRARY_LOCK, LIBRARY_PREFIX, sourceGit, verifyConsumerLibraries } from './consumer-libraries.mjs';

export const PORTABLE_TOOL_FILES = [
  ...['errors', 'io', 'schema', 'formats', 'contracts', 'pin-cli', 'workspace', 'context', 'verify', 'cli',
    'local-artifacts', 'process-env', 'consumer-libraries', 'test-reporter', 'test-failure-diagnostic', 'suite-runner', 'runtime-file-weights', 'pinned-suites', 'runtime-suites', 'runtime-databases'].map(name => `packages/contribution-tools/${name}.mjs`),
  'governance/README.md',
  ...['release-set', 'contract-pin-v1', 'contract-pin-v2', 'release-proof', 'release-trust', 'module', 'coding-context', 'verifier-report']
    .map(name => `governance/schemas/${name}.schema.json`),
];

async function checkDestination(root, path) {
  let current = resolve(root);
  const stat = await lstat(current);
  check(stat.isDirectory() && !stat.isSymbolicLink(), 'unsafe_export_destination');
  const parts = artifactPath(path).split('/');
  for (let index = 0; index < parts.length; index++) {
    current = resolve(current, parts[index]);
    let next;
    try { next = await lstat(current); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    check(!next.isSymbolicLink(), 'unsafe_export_destination');
    check(index === parts.length - 1 ? next.isFile() && next.nlink === 1 : next.isDirectory(), 'unsafe_export_destination');
  }
}

export const LIBRARY_TOOL_FILES = ['errors', 'io', 'process-env', 'consumer-libraries']
  .map(name => `packages/contribution-tools/${name}.mjs`);
const libraryToolMappings = [
  ...LIBRARY_TOOL_FILES.map(source => ({ source, target: `vendor/freedom-tooling/${source}` })),
  { source: 'scripts/repository-bootstrap/verify-consumer-libraries.mjs', target: 'scripts/verify-consumer-libraries.mjs' },
];

/** Opt-in library update for exact repositories.lock bases; leaves preview v1 untouched. */
export async function exportConsumerLibraries(destinations, {
  sourceRoot = fileURLToPath(new URL('../../', import.meta.url)),
  expectedSourceCommit,
} = {}) {
  check(Array.isArray(destinations) && destinations.length > 0 && destinations.length <= 9, 'export_destinations_required');
  check(/^[a-f0-9]{40}$/.test(expectedSourceCommit ?? ''), 'expected_library_source_required');
  const root = resolve(sourceRoot), commit = sourceGit(root, ['rev-parse', 'HEAD']).toString().trim();
  check(commit === expectedSourceCommit, 'library_source_mismatch');
  const committed = async path => {
    const bytes = await readBounded(root, path);
    check(sourceGit(root, ['show', `${commit}:${path}`]).equals(bytes), 'commit_before_export');
    return bytes;
  };
  const repositories = parseJson(await committed('repositories.lock.json')).repositories;
  const prepared = [], roots = [root], names = new Set();
  for (const destination of destinations) {
    const target = resolve(destination.root), repository = destination.repository;
    check(Object.hasOwn(CONSUMER_LIBRARIES, repository) && !names.has(repository), 'unsupported_library_consumer');
    const profile = consumerLibraryProfile(repository, destination.expectedLibraryProfile);
    names.add(repository);
    for (const previous of roots) for (const [parent, child] of [[previous, target], [target, previous]]) {
      const rel = relative(parent, child);
      check(rel && (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)), 'overlapping_export_destination');
    }
    roots.push(target);
    const pinned = repositories.find(entry => entry.repository === repository);
    const upgrade = destination.upgradeFrom;
    if (upgrade !== undefined) check(upgrade && /^[a-f0-9]{40}$/.test(upgrade.consumerCommit ?? '')
      && /^[a-f0-9]{40}$/.test(upgrade.sourceCommit ?? ''), 'expected_library_upgrade_required');
    const consumerCommit = upgrade?.consumerCommit ?? pinned?.commit;
    check(pinned && sourceGit(target, ['rev-parse', 'HEAD']).toString().trim() === consumerCommit, 'consumer_base_mismatch');
    check(sourceGit(target, ['status', '--porcelain', '--untracked-files=all']).length === 0, 'consumer_worktree_dirty');
    if (upgrade) {
      // The caller selects the previous profile and both pins. Never use the lock as authority.
      const previousProfile = consumerLibraryProfile(repository, upgrade.expectedLibraryProfile);
      await verifyConsumerLibraries(target, { repository, expectedSourceCommit: upgrade.sourceCommit,
        expectedLibraryProfile: previousProfile.id, sourceRoot: root });
      // This exporter adds/updates exact artifacts; it does not silently leave retired files.
      check(previousProfile.paths.every(path => profile.paths.includes(path)), 'library_profile_removal_unsupported');
      // Refuse to overwrite locally maintained changes to previously exported tooling too.
      for (const { source, target: path } of libraryToolMappings) {
        check((await readBounded(target, path)).equals(sourceGit(root, ['show', `${upgrade.sourceCommit}:${source}`])),
          'library_previous_tooling_mismatch');
      }
    } else {
      let previous;
      try { previous = await readBounded(target, LIBRARY_LOCK); }
      catch (error) { if (error.code !== 'artifact_missing') throw error; }
      check(!previous, 'explicit_library_upgrade_required');
    }
    const files = [], output = [];
    for (const source_path of profile.paths) {
      const bytes = await committed(source_path), path = LIBRARY_PREFIX + source_path;
      files.push({ source_path, path, sha256: sha256(bytes), bytes: bytes.length });
      output.push({ path, bytes });
    }
    for (const { source, target: path } of profile.entrypoints ?? []) output.push({ path, bytes: await committed(source) });
    for (const { source, target: path } of libraryToolMappings) output.push({ path, bytes: await committed(source) });
    output.push({ path: LIBRARY_LOCK, bytes: Buffer.from(JSON.stringify({
      format: profile.format, ...(profile.id === LEGACY_LIBRARY_PROFILE ? {} : { profile: profile.id }),
      repository, consumer_base_commit: consumerCommit,
      source_repository: 'FreeTWAI-AI/freedom-platform', source_commit: commit, files,
    }, null, 2) + '\n') });
    prepared.push({ target, repository, profile, consumerCommit, output });
  }
  // Preflight the entire batch before the first write. Locks are always written last.
  for (const { target, output } of prepared) for (const file of output) await checkDestination(target, file.path);
  // A changed checkout invalidates the preparation, including an upgrade's reviewed base.
  for (const { target, consumerCommit } of prepared) {
    check(sourceGit(target, ['rev-parse', 'HEAD']).toString().trim() === consumerCommit, 'consumer_base_mismatch');
    check(sourceGit(target, ['status', '--porcelain', '--untracked-files=all']).length === 0, 'consumer_worktree_dirty');
  }
  for (const { target, output } of prepared) for (const file of output) {
    await mkdir(dirname(resolve(target, file.path)), { recursive: true });
    await checkDestination(target, file.path);
    await writeFile(resolve(target, file.path), file.bytes);
  }
  return { source_commit: commit, consumers: prepared.map(({ repository, profile, output }) => ({
    repository, library_profile: profile.id, files_exported: output.length })),
    verification: 'export_only', library_usage: 'not_checked', publisher_trust: 'unverified' };
}

export async function exportPreviewBundle(destinations, {
  sourceRoot = fileURLToPath(new URL('../../', import.meta.url)),
} = {}) {
  check(Array.isArray(destinations) && destinations.length > 0 && destinations.length <= 32, 'export_destinations_required');
  const root = resolve(sourceRoot), targets = destinations.map(path => resolve(path));
  check(new Set(targets).size === targets.length, 'duplicate_export_destination');
  for (const target of targets) {
    for (const [parent, child] of [[root, target], [target, root]]) {
      const rel = relative(parent, child);
      check(rel && (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)), 'overlapping_export_destination');
    }
  }
  const git = args => execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], {
    cwd: root, env: verificationEnvironment(), encoding: 'buffer', maxBuffer: 4_000_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const commit = git(['rev-parse', 'HEAD']).toString().trim();
  const bundleBytes = await readBounded(root, 'contracts/preview/v1/bundle.json'), bundle = parseJson(bundleBytes);
  const lock = { format: 'freedom.contract-pin/v1', source_repository: 'FreeTWAI-AI/freedom-platform', source_commit: commit,
    bundle_path: 'contracts/preview/v1', protocol: bundle.protocol, protocol_sha256: bundle.protocol_sha256, bundle_sha256: sha256(bundleBytes) };
  validateFormat('lockV1', lock);
  const artifactNames = ['bundle.json', ...Object.keys(bundle.files)];
  uniquePaths(artifactNames);
  const output = [];
  const add = async (source, target, declaration) => {
    const bytes = await readBounded(root, source);
    check(git(['show', `${commit}:${source}`]).equals(bytes), 'commit_before_export');
    if (declaration) check(bytes.length === declaration.bytes && sha256(bytes) === declaration.sha256, 'artifact_integrity_mismatch');
    output.push({ path: target, bytes });
  };
  for (const name of artifactNames) await add(`contracts/preview/v1/${name}`, `vendor/freedom-platform/${name}`, bundle.files[name]);
  for (const name of PORTABLE_TOOL_FILES) await add(name, `vendor/freedom-tooling/${name}`);
  for (const name of ['verify-contracts.mjs', 'verify-project-manifest.py', 'freedom.mjs']) {
    await add(`scripts/repository-bootstrap/${name}`, `scripts/${name}`);
  }
  // The lock is written last. No sync, GitHub call, commit, deletion or push.
  output.push({ path: 'contracts.lock.json', bytes: Buffer.from(JSON.stringify(lock, null, 2) + '\n') });
  for (const target of targets) for (const file of output) await checkDestination(target, file.path);
  for (const target of targets) for (const file of output) {
    await mkdir(dirname(resolve(target, file.path)), { recursive: true });
    await checkDestination(target, file.path);
    await writeFile(resolve(target, file.path), file.bytes);
  }
  return { source_commit: commit, consumer_count: targets.length, files_per_consumer: output.length };
}
