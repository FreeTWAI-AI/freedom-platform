#!/usr/bin/env node
// Source-integrity gate only. Load from the independently pinned workflow source.
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, realpath, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { consumerHostTuple, matchSupportedConsumerHostTuple } from './consumer-host-tuples.mjs';
import { DEVICE_PROFILE, verifyDeviceLaunchClosure } from './agent-kit-device-profile.mjs';
import { CONSUMER_LIBRARIES, consumerLibraryProfile, verifyConsumerLibraries, LIBRARY_LOCK, LIBRARY_PREFIX } from './consumer-libraries.mjs';
import { CONSUMER_SOURCE_PROFILES, verifyConsumerSourceProfile } from './consumer-source-profiles.mjs';
import { verifyConsumerEntryCoverage } from './consumer-entry-coverage.mjs';
import { artifactPath, parseJson, sha256 } from './io.mjs';
import { verificationEnvironment } from './process-env.mjs';
import { requireCondition as check, safeFailure } from './errors.mjs';
const CONSUMERS = Object.freeze(['FreeTWAI-AI/freedom-agent-kit', 'FreeTWAI-AI/freedom-storefront', 'FreeTWAI-AI/freedom-supplier-client']);
const commit = value => check(typeof value === 'string' && /^[a-f0-9]{40}$/.test(value), 'consumer_host_commit_required');
function git(root, args) {
  return execFileSync('/usr/bin/git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
    '-c', 'protocol.allow=never', ...args], { cwd: root, timeout: 10000, maxBuffer: 4_000_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...verificationEnvironment(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' } });
}
async function objectRoot(root) {
  check(typeof root === 'string' && isAbsolute(root), 'absolute_host_path_required');
  check((await lstat(root)).isDirectory() && !(await lstat(root)).isSymbolicLink(), 'consumer_host_repository_invalid');
  const path = await realpath(root);
  check((await lstat(join(path, '.git'))).isDirectory() && !(await lstat(join(path, '.git'))).isSymbolicLink(), 'consumer_host_repository_invalid');
  for (const part of ['info/grafts', 'objects/info/alternates', 'objects/info/http-alternates']) {
    let exists = false; try { await lstat(join(path, '.git', part)); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    check(!exists, 'host_git_graph_override');
  }
  check(git(path, ['rev-parse', '--is-shallow-repository']).toString().trim() === 'false', 'complete_history_required');
  return path;
}
function tree(root, sha) {
  commit(sha); check(git(root, ['cat-file', '-t', sha]).toString().trim() === 'commit', 'expected_commit_object');
  const entries = git(root, ['ls-tree', '-rz', '--full-tree', sha]).toString('utf8').split('\0').filter(Boolean);
  check(entries.length > 0 && entries.length <= 8192, 'workspace_path_limit');
  const files = new Map();
  for (const entry of entries) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
    check(match, 'candidate_nonregular_entry'); artifactPath(match[3]); files.set(match[3], { mode: match[1], oid: match[2] });
  }
  return files;
}
function read(root, files, path) {
  check(files.has(path), 'required_candidate_file_missing');
  const bytes = git(root, ['cat-file', 'blob', files.get(path).oid]);
  check(bytes.length <= 2_000_000, 'artifact_size_limit'); return bytes;
}
export async function verifyNativeConsumerSource(input) {
  const keys = ['repository', 'candidateRoot', 'candidateCommit', 'sourceRoot', 'expectedSourceCommit', 'expectedWorkflowCommit'];
  check(input && keys.every(key => Object.hasOwn(input, key))
    && Object.keys(input).every(key => keys.includes(key) || key === 'expectedLibraryProfile'), 'consumer_host_input_invalid');
  const config = structuredClone(input);
  const profile = CONSUMER_SOURCE_PROFILES[config.repository];
  check((CONSUMERS.includes(config.repository) && Object.hasOwn(CONSUMER_LIBRARIES, config.repository))
    || Object.hasOwn(CONSUMER_SOURCE_PROFILES, config.repository), 'unsupported_library_consumer');
  check(!profile || !Object.hasOwn(config, 'expectedLibraryProfile'), 'unsupported_library_profile');
  const libraryProfile = profile ? null : consumerLibraryProfile(config.repository, config.expectedLibraryProfile);
  for (const key of ['candidateCommit', 'expectedSourceCommit', 'expectedWorkflowCommit']) commit(config[key]);
  const candidate = await objectRoot(config.candidateRoot), source = await objectRoot(config.sourceRoot);
  const rel = relative(candidate, source);
  check(rel !== '' && (rel.startsWith('../') || isAbsolute(rel)), 'candidate_authority_forbidden');
  check(git(source, ['rev-parse', 'HEAD']).toString().trim() === config.expectedWorkflowCommit, 'host_workflow_identity_mismatch');
  const sourceFiles = tree(source, config.expectedWorkflowCommit), candidateFiles = tree(candidate, config.candidateCommit);
  const baselines = parseJson(read(source, sourceFiles, 'repositories.lock.json'));
  check(baselines.format === 'freedom.repository-set/v1' && Array.isArray(baselines.repositories), 'consumer_baseline_required');
  const matches = baselines.repositories.filter(item => item.repository === config.repository);
  check(matches.length === 1, 'consumer_baseline_required'); const baseline = matches[0].commit; commit(baseline);
  check(git(candidate, ['merge-base', baseline, config.candidateCommit]).toString().trim() === baseline, 'candidate_missing_approved_consumer_base');
  const baselineFiles = tree(candidate, baseline);
  const preview = path => path === 'contracts.lock.json' || path.startsWith('vendor/freedom-platform/');
  const paths = [...new Set([...baselineFiles.keys(), ...candidateFiles.keys()])].filter(preview).sort();
  check(paths.includes('contracts.lock.json') && paths.some(path => path.startsWith('vendor/freedom-platform/')), 'consumer_preview_baseline_missing');
  for (const path of paths) check(JSON.stringify(candidateFiles.get(path)) === JSON.stringify(baselineFiles.get(path)), 'consumer_preview_baseline_changed');
  let selectedPaths;
  if (profile) {
    selectedPaths = [...new Set([...profile.required_paths, ...paths])];
  } else {
    const fixedLibraries = libraryProfile.paths.map(path => LIBRARY_PREFIX + path);
    const actualLibraries = [...candidateFiles.keys()].filter(path => path.startsWith(LIBRARY_PREFIX)).sort();
    check(JSON.stringify(actualLibraries) === JSON.stringify([...fixedLibraries].sort()), 'consumer_library_file_set_mismatch');
    selectedPaths = [LIBRARY_LOCK, ...fixedLibraries, ...(libraryProfile.entrypoints ?? []).map(value => value.target)];
  }
  const snapshot = await mkdtemp(join(tmpdir(), 'fp-consumer-source-'));
  try {
    const evidence = [];
    for (const path of selectedPaths) {
      const bytes = read(candidate, candidateFiles, path); await mkdir(dirname(join(snapshot, path)), { recursive: true });
      await writeFile(join(snapshot, path), bytes, { flag: 'wx', mode: 0o444 }); evidence.push({ path, sha256: sha256(bytes) });
    }
    const canonicalFiles = profile ? tree(source, config.expectedSourceCommit) : null;
    const verified = profile
      ? await verifyConsumerSourceProfile({ repository: config.repository, repositoryRoot: snapshot,
        readBaseline: path => read(candidate, baselineFiles, path),
        readCanonical: path => read(source, canonicalFiles, path) })
      : await verifyConsumerLibraries(snapshot, { repository: config.repository, expectedSourceCommit: config.expectedSourceCommit,
        expectedLibraryProfile: libraryProfile.id, sourceRoot: source });
    check(!profile || verified.status === 'passed', 'consumer_profile_not_passed');
    const launchClosure = libraryProfile?.id === DEVICE_PROFILE
      ? await verifyDeviceLaunchClosure(path => read(candidate, candidateFiles, path),
        path => git(source, ['show', `${config.expectedSourceCommit}:${path}`])) : null;
    const entryCoverage = await verifyConsumerEntryCoverage({ candidateFiles, baselineFiles,
      readCandidate: path => read(candidate, candidateFiles, path),
      readBaseline: path => read(candidate, baselineFiles, path), entryProfile: libraryProfile?.id });
    return { format: 'freedom.native-consumer-source/v1', status: 'passed', gate_enforced: false, merge_authorized: false,
      repository: config.repository, candidate_commit: config.candidateCommit,
      candidate_tree: git(candidate, ['rev-parse', config.candidateCommit + '^{tree}']).toString().trim(),
      baseline_commit: baseline, workflow_commit: config.expectedWorkflowCommit, source_commit: config.expectedSourceCommit,
      verification: verified.verification, preview: verified.preview ?? 'unchanged-from-approved-baseline',
      entry_coverage: entryCoverage, launch_closure: launchClosure,
      source_profile: profile ? verified.profile : 'adopted-shared-libraries',
      ...(profile ? { profile_result: verified } : { library_profile: libraryProfile.id }),
      library_usage: 'not_checked', runtime_observation: 'not_checked', evidence };
  } finally { await rm(snapshot, { recursive: true, force: true }); }
}
// Native entrypoints accept identity inputs only. Read immutable Git data, never
// the working-tree lock or candidate environment overrides. Source bytes and all
// entry registrations are still verified by verifyNativeConsumerSource below.
export async function installedConsumerInput(identity) {
  const keys = ['repository', 'candidateRoot', 'candidateCommit', 'sourceRoot', 'expectedWorkflowCommit'];
  check(identity && keys.every(key => Object.hasOwn(identity, key))
    && Object.keys(identity).length === keys.length, 'consumer_host_input_invalid');
  let tuple = consumerHostTuple(identity.repository);
  const libraries = Object.hasOwn(CONSUMER_LIBRARIES, identity.repository);
  if (libraries) {
    const candidate = await objectRoot(identity.candidateRoot);
    tuple = matchSupportedConsumerHostTuple(identity.repository,
      parseJson(read(candidate, tree(candidate, identity.candidateCommit), LIBRARY_LOCK)));
  }
  return { ...identity, expectedSourceCommit: tuple.source,
    ...(libraries ? { expectedLibraryProfile: tuple.library_profile } : {}) };
}
async function cli() {
  const [candidateRoot, sourceRoot, ...extra] = process.argv.slice(2);
  check(extra.length === 0 && process.env.GITHUB_ACTIONS === 'true', 'consumer_host_cli_usage');
  check(['pull_request', 'merge_group'].includes(process.env.GITHUB_EVENT_NAME), 'unsupported_host_event');
  check(process.env.FREEDOM_WORKFLOW_REPOSITORY === 'FreeTWAI-AI/freedom-platform'
    && process.env.FREEDOM_WORKFLOW_PATH === '.github/workflows/trusted-consumer-libraries.yml', 'host_workflow_identity_mismatch');
  return verifyNativeConsumerSource(await installedConsumerInput({ repository: process.env.GITHUB_REPOSITORY, candidateRoot, sourceRoot,
    candidateCommit: process.env.GITHUB_SHA, expectedWorkflowCommit: process.env.FREEDOM_WORKFLOW_SHA }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await cli())); }
  catch (error) { console.log(JSON.stringify({ ...safeFailure(error), gate_enforced: false, merge_authorized: false })); process.exitCode = 1; }
}
