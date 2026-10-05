#!/usr/bin/env node
// Fixed workflow source only. Both verdicts are computed by this host process.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyNativeConsumerSource } from './github-consumer-host.mjs';
import { runIsolatedConsumerBehavior } from './behavior-supervisor.mjs';
import { CONSUMER_BEHAVIOR_PROFILES } from './consumer-behavior-fixture.mjs';
import { inspectConsumerRuntime } from './consumer-runtime-recipe.mjs';
import { requireCondition as check, safeFailure } from './errors.mjs';

export async function verifyNativeConsumerRuntime(input) {
  check(input && Object.hasOwn(CONSUMER_BEHAVIOR_PROFILES, input.repository), 'unsupported_consumer_runtime_profile');
  const source = await verifyNativeConsumerSource(input);
  check(source.status === 'passed', 'consumer_source_not_passed');
  const runtime = await runIsolatedConsumerBehavior({ repository: input.repository,
    candidateRepository: input.candidateRoot, candidateCommit: input.candidateCommit });
  const passed = runtime.check?.status === 'passed' && runtime.cleanup_verified === true
    && runtime.runtime_observation === 'host_observed_http'
    && runtime.candidate?.commit === source.candidate_commit && runtime.candidate?.tree === source.candidate_tree;
  return { format: 'freedom.native-consumer-runtime/v1', status: passed ? 'passed' : 'failed',
    repository: input.repository, candidate_commit: source.candidate_commit, candidate_tree: source.candidate_tree,
    workflow_commit: input.expectedWorkflowCommit, source_commit: input.expectedSourceCommit,
    source, runtime, library_usage: 'not_checked', library_invocation: 'not_checked', server_authorization: 'not_checked',
    gate_enforced: false, merge_authorized: false, execution_authorized: false };
}

async function cli() {
  const [candidateRoot, sourceRoot, ...extra] = process.argv.slice(2);
  check(extra.length === 0 && process.env.GITHUB_ACTIONS === 'true', 'consumer_runtime_cli_usage');
  check(['pull_request', 'merge_group'].includes(process.env.GITHUB_EVENT_NAME), 'unsupported_host_event');
  check(process.env.FREEDOM_WORKFLOW_REPOSITORY === 'FreeTWAI-AI/freedom-platform'
    && process.env.FREEDOM_WORKFLOW_PATH === '.github/workflows/trusted-consumer-runtime.yml', 'host_workflow_identity_mismatch');
  // Recipe readback is derived here; no candidate or uploaded report is accepted.
  await inspectConsumerRuntime({ hosted: true });
  return verifyNativeConsumerRuntime({ repository: process.env.GITHUB_REPOSITORY, candidateRoot, sourceRoot,
    candidateCommit: process.env.GITHUB_SHA, expectedSourceCommit: process.env.FREEDOM_LIBRARY_SOURCE_SHA,
    expectedWorkflowCommit: process.env.FREEDOM_WORKFLOW_SHA });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await cli(); console.log(JSON.stringify(result)); if (result.status !== 'passed') process.exitCode = 1; }
  catch (error) { console.log(JSON.stringify({ ...safeFailure(error), gate_enforced: false, merge_authorized: false })); process.exitCode = 1; }
}
