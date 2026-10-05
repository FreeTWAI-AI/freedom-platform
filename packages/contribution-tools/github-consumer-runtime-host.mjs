#!/usr/bin/env node
// Fixed workflow source only. All required verdicts are computed by this host process.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyNativeConsumerSource } from './github-consumer-host.mjs';
import { runIsolatedConsumerBehavior, runIsolatedAgentKitCliBehavior } from './behavior-supervisor.mjs';
import { CONSUMER_BEHAVIOR_PROFILES } from './consumer-behavior-fixture.mjs';
import { inspectConsumerRuntime } from './consumer-runtime-recipe.mjs';
import { requireCondition as check, safeFailure } from './errors.mjs';

export async function verifyNativeConsumerRuntime(input) {
  check(input && Object.hasOwn(CONSUMER_BEHAVIOR_PROFILES, input.repository), 'unsupported_consumer_runtime_profile');
  const source = await verifyNativeConsumerSource(input);
  check(source.status === 'passed', 'consumer_source_not_passed');
  const runtime = await runIsolatedConsumerBehavior({ repository: input.repository,
    candidateRepository: input.candidateRoot, candidateCommit: input.candidateCommit });
  const observed = (value, entry, count) => value?.check?.status === 'passed' && value.cleanup_verified === true
    && value.runtime_observation === 'host_observed_http' && value.entry === entry
    && value.check.test_count === count && value.check.expected_test_count === count
    && value.candidate?.commit === source.candidate_commit && value.candidate?.tree === source.candidate_tree;
  const profile = CONSUMER_BEHAVIOR_PROFILES[input.repository];
  const workspacePassed = observed(runtime, 'src/index.mjs#' + profile.entry, profile.scenarios.length);
  const cliRequired = input.repository === 'FreeTWAI-AI/freedom-agent-kit';
  // Preserve the source/workspace prerequisite. A failed or unavailable workspace
  // cannot gain a passing gate from a separate successful CLI run.
  const cliRuntime = workspacePassed && cliRequired
    ? await runIsolatedAgentKitCliBehavior({ repository: input.repository,
      candidateRepository: input.candidateRoot, candidateCommit: input.candidateCommit }) : null;
  const passed = workspacePassed && (!cliRequired || observed(cliRuntime, 'src/cli.mjs#maker', 1));
  const failedStage = !workspacePassed ? 'workspace' : !passed ? 'cli' : null;
  const failedResult = failedStage === 'workspace' ? runtime : cliRuntime;
  const failure = passed ? null : { stage: failedStage,
    kind: failedResult?.reason === 'consumer_behavior_mismatch' ? 'behavior_mismatch' : 'unavailable' };
  return { format: 'freedom.native-consumer-runtime/v1', status: passed ? 'passed' : 'failed',
    repository: input.repository, candidate_commit: source.candidate_commit, candidate_tree: source.candidate_tree,
    workflow_commit: input.expectedWorkflowCommit, source_commit: input.expectedSourceCommit,
    source, runtime, cli_required: cliRequired, cli_runtime: cliRuntime, failure, library_usage: 'not_checked', library_invocation: 'not_checked', server_authorization: 'not_checked',
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
