#!/usr/bin/env node
// Install this bootstrap and its imports outside all candidate authority.
// Native required workflows may use its exit status; App publishing stays separate.
import { createPublicKey, sign } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { dirname, basename, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectHostCandidate, authenticateEnvelope, authenticateCandidateJob } from './github-trusted-adapter.mjs';
import { installedSupervisorIdentity, validateBehaviorDependencyCache, runIsolatedMemberBehavior } from './behavior-supervisor.mjs';
import { MEMBER_BEHAVIOR as manifest, MEMBER_BEHAVIOR_CASES } from './behavior-manifest.mjs';
import { readBounded, parseJson } from './io.mjs';
import { requireCondition as check, safeFailure } from './errors.mjs';

function exact(value, keys) {
  check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key)), 'invalid_behavior_host_configuration');
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function outside(path, roots) {
  check(typeof path === 'string' && isAbsolute(path), 'absolute_host_path_required');
  const actual = await realpath(path);
  for (const root of roots) {
    const rel = relative(await realpath(root), actual);
    check(rel !== '' && (rel.startsWith('../') || isAbsolute(rel)), 'candidate_authority_forbidden');
  }
  return actual;
}

/** A selection gate, not an assertion that this narrow harness covers the platform. */
export function requireInstalledBehaviorCoverage(report, harness) {
  check(same(report.selected_suites, [manifest.suite_id]), 'installed_behavior_suite_coverage_missing');
  check(report.unknown_paths.length === 0, 'installed_behavior_unknown_path_coverage_missing');
  check(report.operation_ids.every(id => manifest.routes.some(route => route.operation === id)), 'installed_behavior_operation_coverage_missing');
  check(harness === manifest.suite_id, 'installed_behavior_suite_coverage_missing');
}

/** No candidate-provided ports, reports, executable names, test lists or signers. */
export async function runInstalledBehaviorHost(rawConfig, rawJobEnvelope) {
  exact(rawConfig, ['adapter', 'dependency_root', 'installation']);
  const config = structuredClone(rawConfig), jobEnvelope = Buffer.from(rawJobEnvelope);
  exact(config.installation, ['supervisor_sha256', 'harness_sha256', 'node_runtime_sha256', 'dependency_sha256']);
  for (const digest of Object.values(config.installation)) check(typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest), 'installed_behavior_pin_required');
  check(config.adapter.trust, 'trusted_publisher_unavailable');
  const preflight = await inspectHostCandidate(config.adapter, jobEnvelope);
  requireInstalledBehaviorCoverage(preflight.report, manifest.suite_id);
  // The imported host must already be independently installed/approved. A hash
  // observed from a candidate checkout is never used as an expected pin.
  await outside(fileURLToPath(new URL('../../', import.meta.url)), config.adapter.candidate_roots);
  await outside(config.dependency_root, config.adapter.candidate_roots);
  const installation = await installedSupervisorIdentity().catch(error => {
    // A missing/unreadable pinned component cannot satisfy the installation.
    // In particular, setup-node hosts need not provide the member recipe's
    // /usr/bin/node. Refuse it without substituting another interpreter.
    if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(error?.code)) check(false, 'installed_behavior_pin_mismatch');
    throw error;
  });
  const dependency = await validateBehaviorDependencyCache(config.dependency_root);
  for (const key of ['supervisor_sha256', 'harness_sha256', 'node_runtime_sha256'])
    check(installation[key] === config.installation[key], 'installed_behavior_pin_mismatch');
  check(dependency.sha256 === config.installation.dependency_sha256, 'installed_behavior_pin_mismatch');
  const policy = parseJson(await readBounded(config.adapter.policy_root, 'trusted-ci-policy.json'));
  check(policy.suites.find(suite => suite.id === manifest.suite_id)?.harness_sha256 === installation.harness_sha256, 'installed_behavior_harness_unapproved');
  const result = await runIsolatedMemberBehavior({ candidateRepository: config.adapter.object_repository,
    candidateCommit: preflight.report.binding.candidate_commit, dependencyRoot: config.dependency_root,
    hostEvidence: { binding: preflight.report.binding, workflow: preflight.workflow, harness_sha256: installation.harness_sha256 } });
  check(result.cleanup_verified === true && result.check?.status === 'passed' && result.check.test_count === MEMBER_BEHAVIOR_CASES.length
    && result.observation !== null, 'installed_behavior_not_passed');
  for (const key of Object.keys(config.installation)) check(result.installation?.[key] === config.installation[key], 'installed_behavior_pin_mismatch');
  // Reauthenticate expiry, policy, immutable graph and complete evidence after
  // execution/cleanup. An expired job never gains a signature or successful exit.
  const verified = await inspectHostCandidate(config.adapter, jobEnvelope, [result.observation]);
  check(verified.report.status === 'passed' && verified.report.blockers.length === 0, 'installed_behavior_not_passed');
  return { format: 'freedom.installed-behavior-host/v1', status: 'passed', gate_enforced: false, merge_authorized: false,
    coverage: manifest.suite_id, report: verified.report, observation: result.observation };
}

/** Existing publisher port. Key is operator-loaded, never generated or read from a candidate. */
export function createInstalledBehaviorSupervisor(rawConfig, privateKey, kid, loadJob) {
  const config = structuredClone(rawConfig);
  check(privateKey?.type === 'private' && privateKey.asymmetricKeyType === 'ed25519' && typeof loadJob === 'function', 'installed_behavior_signer_required');
  const key = config.adapter?.trust?.keys.find(item => item.kid === kid && item.purpose === 'runner-observations');
  check(key && same(createPublicKey(privateKey).export({ format: 'jwk' }), key.public_jwk), 'installed_behavior_signer_untrusted');
  return async binding => {
    const jobEnvelope = Buffer.from(await loadJob(structuredClone(binding)));
    const job = authenticateEnvelope(jobEnvelope, config.adapter.trust, 'github-candidate');
    check(Object.keys(binding).length === 8 && ['repository', 'pull_request', 'run_id', 'run_attempt', 'base_commit', 'head_commit', 'candidate_commit', 'candidate_tree']
      .every(name => Object.hasOwn(binding, name) && binding[name] === job[name]), 'host_evidence_binding_mismatch');
    const result = await runInstalledBehaviorHost(config, jobEnvelope);
    const payload = Buffer.from(JSON.stringify({ format: 'freedom.github-runner-observations/v1', publisher: config.adapter.trust.publisher,
      repository: job.repository, run_id: job.run_id, run_attempt: job.run_attempt, observations: [result.observation] }));
    const observationsEnvelope = Buffer.from(JSON.stringify({ kid, payload: payload.toString('base64url'),
      signature: sign(null, Buffer.concat([Buffer.from('freedom.github-host/runner-observations/v1\0'), payload]), privateKey).toString('base64url') }));
    authenticateEnvelope(observationsEnvelope, config.adapter.trust, 'runner-observations');
    return { jobEnvelope, observationsEnvelope };
  };
}

async function cli() {
  const [mode, configPath, jobPath, ...extra] = process.argv.slice(2);
  check(['--verify', '--actions'].includes(mode) && extra.length === 0 && isAbsolute(configPath ?? '') && isAbsolute(jobPath ?? ''), 'behavior_host_cli_usage');
  const config = parseJson(await readBounded(dirname(configPath), basename(configPath)));
  check(Array.isArray(config.adapter?.candidate_roots) && config.adapter.candidate_roots.length > 0, 'candidate_roots_required');
  await outside(configPath, config.adapter.candidate_roots); await outside(jobPath, config.adapter.candidate_roots);
  const jobEnvelope = await readBounded(dirname(jobPath), basename(jobPath));
  if (mode === '--actions') {
    const job = authenticateCandidateJob(config.adapter, jobEnvelope);
    check(process.env.GITHUB_ACTIONS === 'true' && job.repository === process.env.GITHUB_REPOSITORY
      && job.run_id === process.env.GITHUB_RUN_ID && String(job.run_attempt) === process.env.GITHUB_RUN_ATTEMPT
      && job.candidate_commit === process.env.GITHUB_SHA && job.event === process.env.GITHUB_EVENT_NAME, 'host_actions_binding_mismatch');
    const preflight = await inspectHostCandidate(config.adapter, jobEnvelope);
    check(preflight.workflow.commit === process.env.GITHUB_WORKFLOW_SHA
      && preflight.workflow.identity === process.env.GITHUB_WORKFLOW_REF?.split('@')[0], 'host_workflow_identity_mismatch');
  }
  return runInstalledBehaviorHost(config, jobEnvelope);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await cli())); }
  catch (error) { console.log(JSON.stringify({ ...safeFailure(error), gate_enforced: false, merge_authorized: false })); process.exitCode = 1; }
}
