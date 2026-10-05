import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { put, pretty } from './fixtures.mjs';
import { verificationEnvironment } from '../process-env.mjs';
import { inspectHostCandidate } from '../github-trusted-adapter.mjs';
import { runInstalledBehaviorHost, requireInstalledBehaviorCoverage, createInstalledBehaviorSupervisor } from '../github-behavior-host.mjs';
import { installedHostFixture as fixture } from './installed-host-fixture.mjs';
const suite = 'behavior.platform-member-routes';
const source = fileURLToPath(new URL('../../../', import.meta.url));
test('installed coverage refuses extra suites, unknown changes, and unimplemented operations', () => {
  const report = { selected_suites: [suite], unknown_paths: [], operation_ids: ['member.avatar.read'] };
  requireInstalledBehaviorCoverage(report, suite);
  for (const changed of [{ selected_suites: [] }, { selected_suites: [suite, 'runtime.full'] }, { unknown_paths: ['evil.mjs'] }, { operation_ids: ['private.admin.export'] }])
    assert.throws(() => requireInstalledBehaviorCoverage({ ...report, ...changed }, suite), /coverage_missing/);
});
test('real signed preflight never trusts candidate test replacement; missing installed pins cannot execute it', async t => {
  const f = await fixture(t), job = f.envelope('github-candidate', f.job);
  const preflight = await inspectHostCandidate(f.config.adapter, job);
  assert.equal(preflight.report.status, 'unavailable');
  assert.deepEqual(preflight.report.selected_suites, [suite]);
  assert(preflight.report.changed_paths.includes('packages/member/test.mjs'));
  await assert.rejects(runInstalledBehaviorHost(f.config, job), { code: 'installed_behavior_pin_mismatch' });
  await assert.rejects(runInstalledBehaviorHost({ ...f.config, observation: { conclusion: 'success' } }, job), { code: 'invalid_behavior_host_configuration' });
  await assert.rejects(runInstalledBehaviorHost({ ...f.config, adapter: { ...f.config.adapter, trust: null } }, job), { code: 'trusted_publisher_unavailable' });
  await assert.rejects(runInstalledBehaviorHost(f.config, f.envelope('github-candidate', { ...f.job, expires_at: new Date(0).toISOString() })), { code: 'host_event_stale' });
  await assert.rejects(runInstalledBehaviorHost(f.config, f.envelope('runner-observations', { passed: true })), { code: 'host_key_purpose_mismatch' });
  const forged = JSON.parse(job); forged.payload = Buffer.from(JSON.stringify({ ...f.job, candidate_tree: 'd'.repeat(40) })).toString('base64url');
  await assert.rejects(runInstalledBehaviorHost(f.config, pretty(forged)), { code: 'invalid_host_signature' });
});
test('publisher port refuses uninstalled keys and mismatched requested candidate before execution/signing', async t => {
  const f = await fixture(t), wrong = generateKeyPairSync('ed25519').privateKey;
  assert.throws(() => createInstalledBehaviorSupervisor(f.config, wrong, 'runner-observations', async () => ''), { code: 'installed_behavior_signer_untrusted' });
  const port = createInstalledBehaviorSupervisor(f.config, f.privateKeys.get('runner-observations'), 'runner-observations', async () => f.envelope('github-candidate', f.job));
  const binding = Object.fromEntries(['repository', 'pull_request', 'run_id', 'run_attempt', 'base_commit', 'head_commit', 'candidate_commit', 'candidate_tree'].map(k => [k, f.job[k]]));
  await assert.rejects(port({ ...binding, run_attempt: 2 }), { code: 'host_evidence_binding_mismatch' });
  await assert.rejects(port({ ...binding, report: { status: 'passed' } }), { code: 'host_evidence_binding_mismatch' });
  await assert.rejects(port(binding), { code: 'installed_behavior_pin_mismatch' });
});
test('native Actions CLI refuses replay into another run and missing installed config with nonzero exit', async t => {
  const f = await fixture(t); await put(f.host, 'config.json', pretty(f.config)); await put(f.host, 'job.json', f.envelope('github-candidate', f.job));
  const cli = join(source, 'packages/contribution-tools/github-behavior-host.mjs');
  const run = (args, environment = {}) => spawnSync(process.execPath, [cli, ...args], { env: { ...verificationEnvironment(), GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '45', ...environment }, encoding: 'utf8' });
  const replay = run(['--actions', join(f.host, 'config.json'), join(f.host, 'job.json')]);
  assert.equal(replay.status, 1); assert.equal(JSON.parse(replay.stdout).code, 'host_actions_binding_mismatch');
  const wrongWorkflow = run(['--actions', join(f.host, 'config.json'), join(f.host, 'job.json')], {
    GITHUB_REPOSITORY: f.job.repository, GITHUB_RUN_ID: f.job.run_id, GITHUB_RUN_ATTEMPT: String(f.job.run_attempt),
    GITHUB_SHA: f.job.candidate_commit, GITHUB_EVENT_NAME: f.job.event, GITHUB_WORKFLOW_SHA: 'f'.repeat(40),
    GITHUB_WORKFLOW_REF: f.policy.workflow.identity + '@refs/heads/main',
  });
  assert.equal(wrongWorkflow.status, 1); assert.equal(JSON.parse(wrongWorkflow.stdout).code, 'host_workflow_identity_mismatch');
  const missing = run(['--verify', join(f.host, 'absent.json'), join(f.host, 'job.json')]);
  assert.equal(missing.status, 1); assert.notEqual(JSON.parse(missing.stdout).status, 'passed');
});
