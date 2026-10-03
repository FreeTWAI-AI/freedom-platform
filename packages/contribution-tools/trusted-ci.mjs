// Host-only boundary. Never import this module from the candidate checkout.
// The caller supplies authenticated observations, not candidate report artifacts.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { artifactPath, parseJson, readBounded, sha256, uniquePaths, MAX_TOTAL_BYTES } from './io.mjs';
import { validateDescriptor, selectImpact, isModuleDescriptorPath } from './context.mjs';
import { validateReleaseSet } from './contracts.mjs';
import { validateFormat } from './formats.mjs';
import { VerificationError, requireCondition as check } from './errors.mjs';
import { verificationEnvironment } from './process-env.mjs';

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,159}$/;
const unique = values => [...new Set(values)].sort();
function fields(value, names) {
  check(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name)), 'invalid_host_input');
}
function id(value) { check(typeof value === 'string' && ID.test(value) && !/[\r\n]/.test(value), 'invalid_host_identity'); }
function digest(value) { check(typeof value === 'string' && DIGEST.test(value), 'invalid_host_digest'); }
function commit(value) { check(typeof value === 'string' && SHA.test(value), 'invalid_host_commit'); }

// Complete static import closure, including imported schemas. This is an
// installation fingerprint, NOT a self-authenticating trust root: the host must
// approve the expected digest before loading these immutable bytes.
export const VERIFIER_INSTALLATION_FILES = Object.freeze([
  ...['trusted-ci', 'context', 'workspace', 'process-env', 'contracts', 'formats', 'schema', 'io', 'errors']
    .map(name => `packages/contribution-tools/${name}.mjs`),
  ...['release-set', 'contract-pin-v1', 'contract-pin-v2', 'release-proof', 'release-trust', 'module', 'coding-context', 'verifier-report']
    .map(name => `governance/schemas/${name}.schema.json`),
].sort());
export async function installedVerifierDigest() {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const records = [];
  for (const path of VERIFIER_INSTALLATION_FILES) records.push([path, sha256(await readBounded(root, path))]);
  return sha256(JSON.stringify(records));
}

async function objectReader(root) {
  check(typeof root === 'string' && isAbsolute(root), 'host_object_repository_required');
  for (const path of ['info/grafts', 'objects/info/alternates', 'objects/info/http-alternates']) {
    let exists = false;
    try { await lstat(join(root, path)); exists = true; }
    catch (error) { if (error.code !== 'ENOENT') throw new VerificationError('host_git_objects_unavailable', true); }
    check(!exists, 'host_git_graph_override');
  }
  // Host-owned bare repository only; never use a candidate worktree/config.
  // Ignore replacements, global configuration and ambient Git/Node injection.
  const env = { ...verificationEnvironment(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' };
  const git = args => {
    try {
      return execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
        '-c', 'protocol.allow=never', ...args], { cwd: root, env, maxBuffer: 4_000_000, timeout: 10_000,
        stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { throw new VerificationError('host_git_objects_unavailable', true); }
  };
  check(git(['rev-parse', '--is-bare-repository']).toString().trim() === 'true', 'host_bare_repository_required');
  check(git(['rev-parse', '--is-shallow-repository']).toString().trim() === 'false', 'complete_history_required');
  const tree = sha => {
    commit(sha);
    check(git(['cat-file', '-t', sha]).toString().trim() === 'commit', 'expected_commit_object');
    const oid = git(['rev-parse', '--verify', sha + '^{tree}']).toString().trim();
    commit(oid); return oid;
  };
  const files = sha => {
    const records = git(['ls-tree', '-rz', '--full-tree', sha]).toString('utf8').split('\0').filter(Boolean);
    check(records.length <= 8192, 'workspace_path_limit');
    const result = new Map();
    for (const record of records) {
      const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40})\t(.+)$/.exec(record);
      check(match, 'invalid_git_tree');
      const [, mode, type, oid, path] = match;
      artifactPath(path);
      check(type === 'blob' && ['100644', '100755'].includes(mode), 'candidate_nonregular_entry');
      result.set(path, mode + ':' + oid);
    }
    return result;
  };
  const read = (files, path) => {
    artifactPath(path); check(files.has(path), 'required_candidate_file_missing');
    const bytes = git(['cat-file', 'blob', files.get(path).split(':')[1]]);
    check(bytes.length <= 2_000_000, 'artifact_size_limit'); return bytes;
  };
  return { git, tree, files, read };
}

function readDescriptors(reader, files) {
  const paths = [...files.keys()].filter(isModuleDescriptorPath);
  check(paths.length > 0 && paths.length <= 256, 'governance_descriptors_required');
  let bytesRead = 0;
  const descriptors = paths.map(path => {
    const bytes = reader.read(files, path); bytesRead += bytes.length;
    check(bytesRead <= 2_000_000, 'descriptor_size_limit');
    const value = validateDescriptor(parseJson(bytes));
    for (const entry of [...value.instructions, ...value.public_exports, ...value.surfaces.map(surface => surface.entry)]) {
      check(files.has(entry), 'descriptor_reference_missing');
    }
    return { ...value, owned_paths: [...value.owned_paths, path] };
  });
  const byId = new Map(descriptors.map(value => [value.module_id, value]));
  check(byId.size === descriptors.length, 'duplicate_module');
  const active = new Set(), done = new Set();
  const visit = value => {
    check(!active.has(value.module_id), 'module_dependency_cycle');
    if (done.has(value.module_id)) return;
    active.add(value.module_id);
    for (const dependency of value.dependencies) {
      check(byId.has(dependency), 'module_dependency_missing'); visit(byId.get(dependency));
    }
    active.delete(value.module_id); done.add(value.module_id);
  };
  for (const value of descriptors) visit(value);
  return descriptors;
}

function readPolicy(bytes, expected) {
  fields(expected, ['revision', 'sha256']); id(expected.revision); digest(expected.sha256);
  check(sha256(bytes) === expected.sha256, 'host_policy_digest_mismatch');
  const policy = parseJson(bytes, { maxBytes: 128_000 });
  fields(policy, ['format', 'revision', 'repository', 'source', 'verifier', 'workflow', 'required_suites', 'fallback_suites', 'suites']);
  check(policy.format === 'freedom.trusted-ci-policy/v1' && policy.revision === expected.revision, 'host_policy_revision_mismatch');
  id(policy.repository);
  fields(policy.source, ['repository', 'commit', 'release_set_sha256']);
  id(policy.source.repository); commit(policy.source.commit); digest(policy.source.release_set_sha256);
  fields(policy.verifier, ['commit', 'sha256']); commit(policy.verifier.commit); digest(policy.verifier.sha256);
  fields(policy.workflow, ['identity', 'commit', 'publisher']);
  id(policy.workflow.identity); commit(policy.workflow.commit); id(policy.workflow.publisher);
  check(Array.isArray(policy.suites) && policy.suites.length > 0 && policy.suites.length <= 256, 'host_suites_required');
  for (const suite of policy.suites) {
    fields(suite, ['id', 'harness_sha256']); id(suite.id); digest(suite.harness_sha256);
  }
  const ids = policy.suites.map(suite => suite.id);
  check(unique(ids).length === ids.length, 'duplicate_host_suite');
  for (const list of [policy.required_suites, policy.fallback_suites]) {
    check(Array.isArray(list) && list.length > 0 && list.length <= 256 && unique(list).length === list.length, 'host_suites_required');
    for (const suite of list) check(ids.includes(suite), 'host_suite_unregistered');
  }
  return policy;
}

const BINDING_FIELDS = ['repository', 'pull_request', 'run_id', 'base_commit', 'head_commit', 'candidate_commit', 'candidate_tree'];
function validateBinding(value, mergeGroup = false) {
  fields(value, BINDING_FIELDS); id(value.repository); id(value.run_id);
  check(mergeGroup ? value.pull_request === null : Number.isSafeInteger(value.pull_request) && value.pull_request > 0, 'invalid_pull_request');
  check(value.base_commit !== value.candidate_commit, 'candidate_base_equals_candidate');
  if (mergeGroup) check(value.candidate_commit === value.head_commit, 'merge_group_candidate_mismatch');
  for (const key of ['base_commit', 'head_commit', 'candidate_commit', 'candidate_tree']) commit(value[key]);
}

// Structural validation only: exporting these helpers does NOT authenticate
// a host, transport, workflow, candidate checkout or serialized observation.
export function validateHostEvidenceBinding(value) {
  const additional = ['source_commit', 'release_set_sha256', 'policy_revision', 'policy_sha256', 'verifier_commit', 'verifier_sha256'];
  fields(value, [...BINDING_FIELDS, ...additional]);
  validateBinding(Object.fromEntries(BINDING_FIELDS.map(key => [key, value[key]])), value.pull_request === null);
  commit(value.source_commit); commit(value.verifier_commit); id(value.policy_revision);
  for (const key of ['release_set_sha256', 'policy_sha256', 'verifier_sha256']) digest(value[key]);
  return Object.freeze(Object.fromEntries([...BINDING_FIELDS, ...additional].map(key => [key, value[key]])));
}
export function validateHostWorkflow(value) {
  fields(value, ['identity', 'commit', 'publisher']); id(value.identity); commit(value.commit); id(value.publisher);
  return Object.freeze({ identity: value.identity, commit: value.commit, publisher: value.publisher });
}

/**
 * All arguments are host-owned. observations must come from an authenticated
 * isolated-runner adapter, NEVER a candidate JSON report. This function neither
 * runs candidate tests nor authenticates an external CI transport. A local pass
 * validates this boundary only, not complete source approval or merge eligibility.
 */
export async function verifyHostCandidate(input) { return verifyCandidate(input, false); }

// A merge queue candidate may combine multiple PRs. It has no fabricated PR id:
// use its authenticated base/head and require the candidate to be that exact head.
export async function verifyHostMergeGroupCandidate(input) { return verifyCandidate(input, true); }

async function verifyCandidate(input, mergeGroup) {
  fields(input, ['objectRepository', 'binding', 'policyBytes', 'expectedPolicy', 'observations']);
  validateBinding(input.binding, mergeGroup);
  const binding = structuredClone(input.binding), policy = readPolicy(input.policyBytes, input.expectedPolicy);
  check(binding.repository === policy.repository, 'host_repository_mismatch');
  check(await installedVerifierDigest() === policy.verifier.sha256, 'host_verifier_digest_mismatch');
  const reader = await objectReader(input.objectRepository);
  reader.tree(binding.base_commit); reader.tree(binding.head_commit);
  check(reader.tree(binding.candidate_commit) === binding.candidate_tree, 'host_candidate_tree_mismatch');
  const parents = reader.git(['show', '-s', '--format=%P', binding.candidate_commit]).toString().trim().split(' ').filter(Boolean);
  if (binding.candidate_commit === binding.head_commit) {
    check(reader.git(['merge-base', binding.base_commit, binding.head_commit]).toString().trim() === binding.base_commit, 'candidate_missing_base');
  } else {
    check(parents.length === 2 && parents[0] === binding.base_commit && parents[1] === binding.head_commit, 'candidate_parent_mismatch');
  }
  const baseFiles = reader.files(binding.base_commit), candidateFiles = reader.files(binding.candidate_commit);
  // Compare immutable object IDs directly: rename/delete both remain visible,
  // and no attributes, diff drivers, hooks or candidate executable is invoked.
  const changedPaths = unique([...baseFiles.keys(), ...candidateFiles.keys()])
    .filter(path => baseFiles.get(path) !== candidateFiles.get(path));
  const baseline = readDescriptors(reader, baseFiles), candidate = readDescriptors(reader, candidateFiles);
  // A new/expanded candidate descriptor is a proposal, not approved ownership.
  // It cannot classify previously unmapped code out of the host fallback.
  const baselineImpact = selectImpact({ baseline, candidate: [], changedPaths });
  const impact = selectImpact({ baseline, candidate, changedPaths, scopes: baselineImpact.module_ids });
  const lock = parseJson(reader.read(candidateFiles, 'contracts.lock.json'));
  validateFormat('lockV2', lock);
  check(lock.source_repository === policy.source.repository && lock.source_commit === policy.source.commit
    && lock.release_set.sha256 === policy.source.release_set_sha256, 'host_source_pin_mismatch');
  const manifestBytes = reader.read(candidateFiles, 'vendor/freedom-platform/' + artifactPath(lock.release_set.path));
  check(sha256(manifestBytes) === policy.source.release_set_sha256, 'host_release_digest_mismatch');
  const manifest = validateReleaseSet(parseJson(manifestBytes));
  check(manifest.source_commit === policy.source.commit && manifest.source_repository === policy.source.repository, 'host_release_source_mismatch');
  const records = artifacts => artifacts.map(({ path, bytes, sha256 }) => [path, bytes, sha256]).sort((a, b) => a[0].localeCompare(b[0], 'en'));
  check(JSON.stringify(records(lock.artifacts)) === JSON.stringify(records(manifest.artifacts)), 'host_artifact_pin_mismatch');
  const expectedFiles = [...manifest.artifacts.map(item => item.path), lock.release_set.path, lock.proof.path];
  uniquePaths(expectedFiles);
  const actualFiles = [...candidateFiles.keys()].filter(path => path.startsWith('vendor/freedom-platform/'))
    .map(path => path.slice('vendor/freedom-platform/'.length)).sort();
  check(JSON.stringify(actualFiles) === JSON.stringify(expectedFiles.sort()), 'host_artifact_set_mismatch');
  let totalBytes = manifestBytes.length;
  for (const artifact of manifest.artifacts) {
    const bytes = reader.read(candidateFiles, 'vendor/freedom-platform/' + artifact.path);
    totalBytes += bytes.length; check(totalBytes <= MAX_TOTAL_BYTES, 'artifact_total_size_limit');
    check(bytes.length === artifact.bytes && sha256(bytes) === artifact.sha256, 'host_artifact_integrity_mismatch');
  }
  const proofBytes = reader.read(candidateFiles, 'vendor/freedom-platform/' + lock.proof.path);
  check(totalBytes + proofBytes.length <= MAX_TOTAL_BYTES, 'artifact_total_size_limit');
  check(sha256(proofBytes) === lock.proof.sha256, 'host_proof_pin_mismatch');
  const unknownPaths = unique([...impact.unknown_paths, ...baselineImpact.unknown_paths]);
  const selected = unique([...policy.required_suites, ...impact.tests, ...(unknownPaths.length ? policy.fallback_suites : [])]);
  const suites = new Map(policy.suites.map(suite => [suite.id, suite]));
  check(selected.every(suite => suites.has(suite)), 'host_suite_unregistered');
  const evidenceBinding = { ...binding, source_commit: policy.source.commit, release_set_sha256: policy.source.release_set_sha256,
    policy_revision: policy.revision, policy_sha256: input.expectedPolicy.sha256,
    verifier_commit: policy.verifier.commit, verifier_sha256: policy.verifier.sha256 };
  check(Array.isArray(input.observations) && input.observations.length <= 256, 'invalid_host_observations');
  const observed = new Map();
  for (const observation of input.observations) {
    fields(observation, ['suite_id', 'binding', 'workflow', 'harness_sha256', 'conclusion', 'tests', 'failures', 'skipped', 'cancelled', 'evidence_sha256']);
    fields(observation.binding, Object.keys(evidenceBinding));
    check(Object.keys(evidenceBinding).every(key => observation.binding[key] === evidenceBinding[key]), 'host_evidence_binding_mismatch');
    check(selected.includes(observation.suite_id) && !observed.has(observation.suite_id), 'unexpected_or_duplicate_suite');
    fields(observation.workflow, ['identity', 'commit', 'publisher']);
    check(Object.keys(policy.workflow).every(key => observation.workflow[key] === policy.workflow[key]), 'host_workflow_identity_mismatch');
    check(observation.harness_sha256 === suites.get(observation.suite_id).harness_sha256, 'host_harness_mismatch');
    digest(observation.evidence_sha256);
    for (const key of ['tests', 'failures', 'skipped', 'cancelled']) check(Number.isSafeInteger(observation[key]) && observation[key] >= 0, 'invalid_suite_counts');
    check(observation.conclusion === 'success' && observation.tests > 0 && observation.failures === 0
      && observation.skipped === 0 && observation.cancelled === 0, 'host_suite_not_passed');
    observed.set(observation.suite_id, observation.evidence_sha256);
  }
  const missing = selected.filter(suite => !observed.has(suite));
  const surfaces = [...baseline, ...candidate].filter(value => impact.module_ids.includes(value.module_id)).flatMap(value => value.surfaces);
  return { format: 'freedom.host-verifier-report/v1', assurance_level: 'local', execution_authorized: false,
    merge_authorized: false, publisher_trust: 'unverified', binding: evidenceBinding,
    status: missing.length ? 'unavailable' : 'passed', changed_paths: changedPaths, unknown_paths: unknownPaths, module_ids: impact.module_ids,
    surface_ids: unique(surfaces.map(surface => surface.surface_id)), operation_ids: unique(surfaces.flatMap(surface => surface.operations)),
    selected_suites: selected, checks: selected.map(suite => ({ suite_id: suite,
      status: observed.has(suite) ? 'passed' : 'not_run', evidence_sha256: observed.get(suite) ?? null })),
    blockers: missing.length ? ['host_suite_evidence_missing'] : [] };
}
