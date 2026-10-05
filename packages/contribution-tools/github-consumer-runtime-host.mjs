#!/usr/bin/env node
// Fixed workflow source only. All required verdicts are computed by this host process.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyNativeConsumerSource } from './github-consumer-host.mjs';
import { runIsolatedConsumerBehavior, runIsolatedConsumerCliBehavior, runIsolatedAgentKitDeviceBehavior, runIsolatedDirectoryBuild } from './behavior-supervisor.mjs';
import { DIRECTORY_REPOSITORY, DIRECTORY_BUILD_CASES } from './directory-build-fixture.mjs';
import { CONSUMER_BEHAVIOR_PROFILES, CONSUMER_CLI_PROFILES } from './consumer-behavior-fixture.mjs';
import { consumerHostTuple } from './consumer-host-tuples.mjs';
import { CONSUMER_LIBRARIES } from './consumer-libraries.mjs';
import { DEVICE_PROFILE, DEVICE_ENTRY } from './agent-kit-device-profile.mjs';
import { DEVICE_CASES } from './agent-kit-device-fixture.mjs';
import { inspectConsumerRuntime } from './consumer-runtime-recipe.mjs';
import { requireCondition as check, safeFailure } from './errors.mjs';

export async function verifyNativeConsumerRuntime(input) {
  check(input && (Object.hasOwn(CONSUMER_BEHAVIOR_PROFILES, input.repository)
    || input.repository === DIRECTORY_REPOSITORY), 'unsupported_consumer_runtime_profile');
  const source = await verifyNativeConsumerSource(input);
  check(source.status === 'passed', 'consumer_source_not_passed');
  if (input.repository === DIRECTORY_REPOSITORY) {
    const runtime = await runIsolatedDirectoryBuild({ repository: input.repository,
      candidateRepository: input.candidateRoot, candidateCommit: input.candidateCommit });
    const passed = runtime?.check?.status === 'passed' && runtime.cleanup_verified === true
      && runtime.runtime_observation === 'host_observed_build_files' && runtime.entry === 'scripts/build.mjs'
      && runtime.check.test_count === DIRECTORY_BUILD_CASES.length && runtime.check.expected_test_count === DIRECTORY_BUILD_CASES.length
      && runtime.candidate?.commit === source.candidate_commit && runtime.candidate?.tree === source.candidate_tree;
    return { format: 'freedom.native-consumer-runtime/v1', status: passed ? 'passed' : 'failed',
      repository: input.repository, candidate_commit: source.candidate_commit, candidate_tree: source.candidate_tree,
      workflow_commit: input.expectedWorkflowCommit, source_commit: input.expectedSourceCommit,
      source, runtime, cli_required: false, cli_runtime: null,
      failure: passed ? null : { stage: 'build', kind: ['directory_behavior_mismatch', 'directory_data_invalid'].includes(runtime.reason)
        ? 'behavior_mismatch' : 'unavailable' },
      library_usage: 'not_checked', library_invocation: 'not_checked', server_authorization: 'not_checked',
      gate_enforced: false, merge_authorized: false, execution_authorized: false };
  }
  const runtime = await runIsolatedConsumerBehavior({ repository: input.repository,
    candidateRepository: input.candidateRoot, candidateCommit: input.candidateCommit });
  const observed = (value, entry, count) => value?.check?.status === 'passed' && value.cleanup_verified === true
    && value.runtime_observation === 'host_observed_http' && value.entry === entry
    && value.check.test_count === count && value.check.expected_test_count === count
    && value.candidate?.commit === source.candidate_commit && value.candidate?.tree === source.candidate_tree;
  const profile = CONSUMER_BEHAVIOR_PROFILES[input.repository];
  const workspacePassed = observed(runtime, 'src/index.mjs#' + profile.entry, profile.scenarios.length);
  const cliRequired = true;
  const cliProfile = CONSUMER_CLI_PROFILES[input.repository];
  // Preserve the source/workspace prerequisite. A failed or unavailable workspace
  // cannot gain a passing gate from a separate successful CLI run.
  const cliRuntime = workspacePassed
    ? await runIsolatedConsumerCliBehavior({ repository: input.repository,
      candidateRepository: input.candidateRoot, candidateCommit: input.candidateCommit }) : null;
  const legacyPassed = workspacePassed && observed(cliRuntime, cliProfile.entry, cliProfile.scenarios.length);
  const deviceRequired = input.expectedLibraryProfile === DEVICE_PROFILE;
  if (deviceRequired) check(input.expectedSourceCommit === consumerHostTuple(input.repository).source, 'device_runtime_source_tuple_mismatch');
  const deviceRuntime = deviceRequired && legacyPassed
    ? await runIsolatedAgentKitDeviceBehavior({ repository: input.repository, candidateRepository: input.candidateRoot, candidateCommit: input.candidateCommit }) : null;
  const devicePassed = !deviceRequired || observed(deviceRuntime, DEVICE_ENTRY, DEVICE_CASES.length)
    && deviceRuntime.library_invocation === 'closed_canonical_cli_observed' && source.launch_closure?.profile === DEVICE_PROFILE;
  const passed = legacyPassed && devicePassed;
  const failedStage = !workspacePassed ? 'workspace' : !legacyPassed ? 'cli' : !devicePassed ? 'device_cli' : null;
  const failedResult = failedStage === 'workspace' ? runtime : failedStage === 'device_cli' ? deviceRuntime : cliRuntime;
  const failure = passed ? null : { stage: failedStage,
    kind: failedResult?.reason === 'consumer_behavior_mismatch' ? 'behavior_mismatch' : 'unavailable' };
  return { format: 'freedom.native-consumer-runtime/v1', status: passed ? 'passed' : 'failed',
    repository: input.repository, candidate_commit: source.candidate_commit, candidate_tree: source.candidate_tree,
    workflow_commit: input.expectedWorkflowCommit, source_commit: input.expectedSourceCommit,
    source, runtime, cli_required: cliRequired, cli_runtime: cliRuntime, device_required: deviceRequired, device_runtime: deviceRuntime, failure,
    device_library_invocation: deviceRequired && passed ? 'closed_canonical_cli_observed' : 'not_checked', library_usage: 'not_checked', library_invocation: 'not_checked', server_authorization: 'not_checked',
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
  const tuple = consumerHostTuple(process.env.GITHUB_REPOSITORY);
  return verifyNativeConsumerRuntime({ repository: process.env.GITHUB_REPOSITORY, candidateRoot, sourceRoot,
    candidateCommit: process.env.GITHUB_SHA, expectedSourceCommit: tuple.source,
    expectedWorkflowCommit: process.env.FREEDOM_WORKFLOW_SHA,
    ...(Object.hasOwn(CONSUMER_LIBRARIES, process.env.GITHUB_REPOSITORY) ? { expectedLibraryProfile: tuple.library_profile } : {}) });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await cli(); console.log(JSON.stringify(result)); if (result.status !== 'passed') process.exitCode = 1; }
  catch (error) { console.log(JSON.stringify({ ...safeFailure(error), gate_enforced: false, merge_authorized: false })); process.exitCode = 1; }
}
