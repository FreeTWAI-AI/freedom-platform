import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';

const workflow = readFileSync(new URL('../../../.github/workflows/blacksmith-onboarding.yml', import.meta.url), 'utf8');
const source = '75309b0747a5220e9aa2a478a5012cc3c3c35ee6';
function script(name) {
  const section = workflow.split(`      - name: ${name}\n`)[1]?.split('\n      - name:')[0];
  assert.ok(section, `Missing step: ${name}`);
  return section.split('        run: |\n')[1].trimEnd().split('\n').map(line => line.slice(10)).join('\n');
}
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'fp-blacksmith-'));
  try { mkdirSync(join(root, '.freedom/reports'), { recursive: true }); fn(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
function shell(root, body, env = {}) {
  return spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', body], {
    cwd: root, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 10000,
  });
}

test('pilot stays manual, default off, fixed source and bounded without replacing required CI', () => {
  assert.match(workflow, /^on:\n  workflow_dispatch:\n\npermissions:\n  contents: read\n/m);
  assert.equal((workflow.match(/    runs-on:/g) ?? []).length, 1);
  assert.match(workflow, /runs-on: blacksmith-4vcpu-ubuntu-2404\n    timeout-minutes: 15\n/);
  assert.match(workflow, new RegExp(`SOURCE_SHA: ${source}`));
  assert.match(workflow, new RegExp(`ref: ${source}\n          persist-credentials: false`));
  assert.equal((workflow.match(/uses: actions\/checkout@/g) ?? []).length, 1);
  for (const line of workflow.matchAll(/uses: (.+)/g)) assert.match(line[1], /^actions\/[a-z-]+@[0-9a-f]{40} /);
  assert.doesNotMatch(workflow, /\b(?:inputs|secrets)\.|\b(?:strategy|services|cache):|\.freedom\/trusted|RUNNER_SHA|run-pinned-suite/);
  assert.match(script('Verify identities and record provenance'), /test "\$\(git rev-parse HEAD\)" = "\$SOURCE_SHA"/);
  assert.match(script('Run the complete fixed-source build and record duration'), /timeout --signal=TERM --kill-after=5s 300s npm run build/);
  assert.match(workflow, /retention-days: 1/);
});

test('actual gate permits only the admitted first run and rejects untrusted refs and reruns', () => {
  const expression = workflow.match(/    if: >-\n([\s\S]+?)\n    runs-on:/)[1].trim().slice(3, -2).trim();
  assert.match(expression, /^vars\.BLACKSMITH_PILOT_ADMISSION == 'first-run-approved' &&/);
  for (const admission of ['', 'off', 'true', 'first-run-approved']) for (const number of [1, 2, 10]) for (const event of ['workflow_dispatch', 'push', 'pull_request'])
    for (const repository of ['FreeTWAI/freedom-platform', 'attacker/fork'])
      for (const ref of ['refs/heads/main', 'refs/heads/topic', 'refs/tags/main', 'refs/pull/1/merge'])
        for (const trustedWorkflow of [false, true]) for (const attempt of [1, 2]) {
          const github = { event_name: event, repository, ref, run_attempt: attempt, run_number: number,
            workflow_ref: trustedWorkflow ? 'FreeTWAI/freedom-platform/.github/workflows/blacksmith-onboarding.yml@refs/heads/main' : 'attacker/fork/workflow.yml@refs/heads/main' };
          const actual = runInNewContext(expression, { github, vars: { BLACKSMITH_PILOT_ADMISSION: admission } });
          assert.equal(actual, admission === 'first-run-approved' && number === 1 && event === 'workflow_dispatch' && repository === 'FreeTWAI/freedom-platform'
            && ref === 'refs/heads/main' && trustedWorkflow && attempt === 1);
        }
});

test('install and full-build failures retain exit codes and timing without turning green', () => {
  for (const [step, report] of [
    ['Install locked dependencies and record duration', 'blacksmith-install.json'],
    ['Run the complete fixed-source build and record duration', 'blacksmith-build.json'],
  ]) fixture(root => {
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin/npm'), '#!/bin/sh\nexit 17\n', { mode: 0o755 });
    const result = shell(root, script(step), { PATH: `${join(root, 'bin')}:${process.env.PATH}` });
    assert.equal(result.status, 17, result.stderr);
    const evidence = JSON.parse(readFileSync(join(root, '.freedom/reports', report)));
    assert.equal(evidence.exit_code, 17);
    assert.ok(evidence.duration_seconds >= 0);
  });
});

test('total evidence preserves failed/skipped outcomes and missing timing is not fabricated', () => {
  for (const started of [String(Date.now() - 1000), '']) fixture(root => {
    const result = shell(root, script('Record total measured interval and outcomes'), {
      PILOT_STARTED_MS: started, JOB_STATUS: 'failure', INSTALL_OUTCOME: 'failure', BUILD_OUTCOME: 'skipped',
    });
    assert.equal(result.status, 0, result.stderr);
    const evidence = JSON.parse(readFileSync(join(root, '.freedom/reports/blacksmith-total.json')));
    assert.equal(evidence.job_status_before_upload, 'failure');
    assert.equal(evidence.install_outcome, 'failure');
    assert.equal(evidence.build_outcome, 'skipped');
    if (started) assert.ok(evidence.duration_seconds >= 1);
    else { assert.equal(evidence.started_ms, null); assert.equal(evidence.duration_seconds, null); }
    assert.match(evidence.scope, /excludes queue, provisioning and artifact upload; not provider billing time/);
  });
});

test('provenance records observed hardware and OS without inventing provider image identities', () => fixture(root => {
  const body = script('Verify identities and record provenance').split("<<'NODE'\n")[1].split('\nNODE')[0];
  const result = spawnSync(process.execPath, ['--input-type=module'], { cwd: root, input: body,
    env: { SOURCE_SHA: source, WORKFLOW_SHA: 'local-fixture' }, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(readFileSync(join(root, '.freedom/reports/blacksmith-source.json')));
  assert.equal(evidence.source_sha, source);
  assert.equal(evidence.command, 'npm run build');
  assert.equal(evidence.workload_timeout_seconds, 300);
  assert.ok(evidence.cpu_logical_count > 0 && evidence.cpu_available_parallelism > 0);
  assert.ok(evidence.cpu_models.length > 0);
  assert.match(evidence.os_release, /\bID=/);
  assert.ok(evidence.kernel_release);
  assert.equal(evidence.runner_image_os, null);
  assert.equal(evidence.runner_image_version, null);
}));
