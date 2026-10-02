import { mkdir, lstat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBounded, parseJson, sha256, artifactPath, uniquePaths } from './io.mjs';
import { validateFormat } from './formats.mjs';
import { requireCondition as check } from './errors.mjs';
import { verificationEnvironment } from './process-env.mjs';

export const PORTABLE_TOOL_FILES = [
  ...['errors', 'io', 'schema', 'formats', 'contracts', 'pin-cli', 'workspace', 'context', 'verify', 'cli',
    'local-artifacts', 'process-env', 'test-reporter'].map(name => `packages/contribution-tools/${name}.mjs`),
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
