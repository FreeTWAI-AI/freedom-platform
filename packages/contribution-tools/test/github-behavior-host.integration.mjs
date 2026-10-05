// Explicit Docker integration; never included in the ordinary *.test.mjs glob.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installedHostFixture } from './installed-host-fixture.mjs';
import { installedSupervisorIdentity, validateBehaviorDependencyCache } from '../behavior-supervisor.mjs';
import { createInstalledBehaviorSupervisor } from '../github-behavior-host.mjs';
import { authenticateEnvelope } from '../github-trusted-adapter.mjs';
import { put, pretty } from './fixtures.mjs';
import { sha256 } from '../io.mjs';
if (process.env.FREEDOM_RUN_ISOLATED_BEHAVIOR !== '1') throw Error('Explicit FREEDOM_RUN_ISOLATED_BEHAVIOR=1 required');
test('real installed runner ignores candidate test scripts, emits exact signed observation, and leaves no owned containers', async t => {
  const f = await installedHostFixture(t, true);
  const identity = await installedSupervisorIdentity(), dependency = await validateBehaviorDependencyCache(f.config.dependency_root);
  f.config.installation = Object.fromEntries(['supervisor_sha256', 'harness_sha256', 'node_runtime_sha256'].map(key => [key, identity[key]]));
  f.config.installation.dependency_sha256 = dependency.sha256;
  f.policy.suites.find(item => item.id === 'behavior.platform-member-routes').harness_sha256 = identity.harness_sha256;
  await put(f.policyRoot, 'trusted-ci-policy.json', pretty(f.policy)); f.config.adapter.expected_policy.sha256 = sha256(pretty(f.policy));
  const binding = Object.fromEntries(['repository', 'pull_request', 'run_id', 'run_attempt', 'base_commit', 'head_commit', 'candidate_commit', 'candidate_tree'].map(key => [key, f.job[key]]));
  const supervisor = createInstalledBehaviorSupervisor(f.config, f.privateKeys.get('runner-observations'), 'runner-observations', async () => f.envelope('github-candidate', f.job));
  const result = await supervisor(binding);
  const signed = authenticateEnvelope(result.observationsEnvelope, f.config.adapter.trust, 'runner-observations');
  assert.equal(signed.observations.length, 1); assert.equal(signed.observations[0].tests, 27);
  for (const [key, value] of Object.entries(binding)) assert.equal(signed.observations[0].binding[key], value);
  assert.equal(signed.observations[0].conclusion, 'success');
});
