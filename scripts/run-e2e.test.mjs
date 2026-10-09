import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AVATAR_ASSET_SPEC, explicitFileArgs, MESSAGE_IMAGE_SPEC, planE2e, PRIVATE_AI_SPEC, runE2e } from './run-e2e.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const runner = new URL('./run-e2e.mjs', import.meta.url).href;

test('flag values are not file filters and path filters are', () => {
  assert.deepEqual(explicitFileArgs([]), []);
  assert.deepEqual(explicitFileArgs(['--headed', '--workers', '1', '--grep', 'member']), []);
  assert.deepEqual(explicitFileArgs(['--project', 'chromium']), []);
  assert.deepEqual(explicitFileArgs(['--grep=member', '--project=chromium', '--debug', 'cli']), []);
  assert.deepEqual(explicitFileArgs(['--only-changed', 'main', '-u', 'changed']), []);
  assert.deepEqual(explicitFileArgs(['tests/e2e/private-work-ai.spec.ts']), ['tests/e2e/private-work-ai.spec.ts']);
  assert.deepEqual(
    explicitFileArgs(['--project', 'chromium', 'tests/e2e/private-work-ai.spec.ts', '--headed']),
    ['tests/e2e/private-work-ai.spec.ts'],
  );
  assert.deepEqual(explicitFileArgs(['--', 'tests/e2e/foo.spec.ts']), ['tests/e2e/foo.spec.ts']);
  assert.deepEqual(explicitFileArgs(['private-work-ai']), ['private-work-ai']);
});

test('default plan runs the baseline, private fixture, avatar asset fixture, then message image fixture', () => {
  const env = { FREEDOM_E2E_PORT: '4311' };
  const steps = planE2e(['--headed', '--workers', '1'], env);
  assert.equal(steps.length, 5);
  assert.deepEqual(steps[0].args, ['--headed', '--workers', '1']);
  assert.equal(steps[0].env, env);
  assert.equal(steps[0].env.FREEDOM_E2E_PRIVATE_AI_FIXTURE, undefined);
  assert.equal(steps[0].env.FREEDOM_E2E_AVATAR_ASSET_FIXTURE, undefined);
  assert.deepEqual(steps[1].args, ['--headed', '--workers', '1', PRIVATE_AI_SPEC]);
  assert.notEqual(steps[1].env, env);
  assert.equal(steps[1].env.FREEDOM_E2E_PRIVATE_AI_FIXTURE, '1');
  assert.equal(steps[1].env.FREEDOM_E2E_AVATAR_ASSET_FIXTURE, undefined);
  assert.equal(steps[1].env.FREEDOM_E2E_PORT, '4311');
  assert.deepEqual(steps[2].args, ['--headed', '--workers', '1', AVATAR_ASSET_SPEC]);
  assert.notEqual(steps[2].env, env);
  assert.notEqual(steps[2].env, steps[1].env);
  assert.equal(steps[2].env.FREEDOM_E2E_AVATAR_ASSET_FIXTURE, '1');
  assert.equal(steps[2].env.FREEDOM_E2E_PRIVATE_AI_FIXTURE, undefined);
  assert.equal(steps[2].env.FREEDOM_E2E_PORT, '4311');
  assert.deepEqual(steps[3].args, ['--headed', '--workers', '1', MESSAGE_IMAGE_SPEC]);
  assert.equal(steps[3].env.FREEDOM_E2E_MESSAGE_IMAGE_FIXTURE, '1');
  assert.equal(steps[3].env.FREEDOM_E2E_PRIVATE_AI_FIXTURE, undefined);
  assert.equal(steps[3].env.FREEDOM_E2E_AVATAR_ASSET_FIXTURE, undefined);
  assert.equal(steps[0].env.FREEDOM_E2E_MESSAGE_IMAGE_FIXTURE, undefined);
  assert.equal(steps[3].env.FREEDOM_E2E_PORT, '4311');
  assert.deepEqual(steps[4].args, ['--headed', '--workers', '1', 'tests/e2e/first-participation.spec.ts']);
  assert.equal(steps[4].env.FREEDOM_E2E_FIRST_PARTICIPATION, '1');
  assert.equal(env.FREEDOM_E2E_PRIVATE_AI_FIXTURE, undefined);
  assert.equal(env.FREEDOM_E2E_AVATAR_ASSET_FIXTURE, undefined);
});

test('help and version stay one invocation', () => {
  assert.equal(planE2e(['--help'], {}).length, 1);
  assert.equal(planE2e(['--version'], {}).length, 1);
});

test('file arguments and an explicit fixture stay one invocation', () => {
  const file = planE2e(['tests/e2e/newcomer-guides.spec.ts', '--headed'], {});
  assert.equal(file.length, 1);
  assert.deepEqual(file[0].args, ['tests/e2e/newcomer-guides.spec.ts', '--headed']);
  assert.equal(file[0].env.FREEDOM_E2E_PRIVATE_AI_FIXTURE, undefined);
  assert.equal(file[0].env.FREEDOM_E2E_AVATAR_ASSET_FIXTURE, undefined);
  const fixture = planE2e(['--headed'], { FREEDOM_E2E_PRIVATE_AI_FIXTURE: '1' });
  assert.equal(fixture.length, 1);
  assert.deepEqual(fixture[0].args, ['--headed']);
  assert.equal(fixture[0].env.FREEDOM_E2E_PRIVATE_AI_FIXTURE, '1');
  assert.equal(fixture[0].env.FREEDOM_E2E_AVATAR_ASSET_FIXTURE, undefined);
  const avatar = { FREEDOM_E2E_AVATAR_ASSET_FIXTURE: '1', FREEDOM_E2E_PORT: '4311' };
  const avatarPlan = planE2e(['--headed'], avatar);
  assert.equal(avatarPlan.length, 1);
  assert.equal(avatarPlan[0].env, avatar);
  assert.equal(avatarPlan[0].env.FREEDOM_E2E_PRIVATE_AI_FIXTURE, undefined);
  assert.equal(avatar.FREEDOM_E2E_AVATAR_ASSET_FIXTURE, '1');
});

test('a baseline failure does not start the private fixture', async () => {
  const calls = [];
  const result = await runE2e(['--headed'], {}, async (args, env) => {
    calls.push({ args, fixture: env.FREEDOM_E2E_PRIVATE_AI_FIXTURE ?? null });
    return { code: 7, signal: null };
  });
  assert.equal(result.code, 7);
  assert.equal(result.signal, null);
  assert.deepEqual(calls, [{ args: ['--headed'], fixture: null }]);
});

test('a baseline signal does not start the private fixture', async () => {
  const calls = [];
  const result = await runE2e([], {}, async () => {
    calls.push('baseline');
    return { code: null, signal: 'SIGINT' };
  });
  assert.equal(result.signal, 'SIGINT');
  assert.deepEqual(calls, ['baseline']);
});

test('the private fixture failure is returned after a passing baseline', async () => {
  const calls = [];
  const result = await runE2e([], { OTHER: 'kept' }, async (args, env) => {
    calls.push({ args, fixture: env.FREEDOM_E2E_PRIVATE_AI_FIXTURE ?? null, other: env.OTHER });
    return calls.length === 1 ? { code: 0, signal: null } : { code: 2, signal: null };
  });
  assert.equal(result.code, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].fixture, null);
  assert.equal(calls[1].fixture, '1');
  assert.deepEqual(calls[1].args, [PRIVATE_AI_SPEC]);
  assert.equal(calls[1].other, 'kept');
});

test('all five passes run when the earlier passes succeed', async () => {
  const calls = [];
  const result = await runE2e([], { OTHER: 'kept' }, async (args, env) => {
    calls.push({ args, privateAi: env.FREEDOM_E2E_PRIVATE_AI_FIXTURE ?? null, avatar: env.FREEDOM_E2E_AVATAR_ASSET_FIXTURE ?? null, messageImage: env.FREEDOM_E2E_MESSAGE_IMAGE_FIXTURE ?? null, other: env.OTHER });
    return { code: 0, signal: null };
  });
  assert.equal(result.code, 0);
  assert.equal(calls.length, 5);
  assert.equal(calls[0].privateAi, null);
  assert.equal(calls[0].avatar, null);
  assert.equal(calls[1].privateAi, '1');
  assert.equal(calls[1].avatar, null);
  assert.deepEqual(calls[1].args, [PRIVATE_AI_SPEC]);
  assert.equal(calls[2].avatar, '1');
  assert.equal(calls[2].privateAi, null);
  assert.deepEqual(calls[2].args, [AVATAR_ASSET_SPEC]);
  assert.equal(calls[2].other, 'kept');
  assert.deepEqual(calls[3].args, [MESSAGE_IMAGE_SPEC]);
  assert.equal(calls[3].messageImage, '1');
  assert.equal(calls[3].privateAi, null);
  assert.equal(calls[3].avatar, null);
  assert.equal(calls[3].other, 'kept');
  assert.equal(calls[0].messageImage, null);
  assert.deepEqual(calls[4].args, ['tests/e2e/first-participation.spec.ts']);
});

test('the avatar fixture failure is returned after the earlier passes', async () => {
  const calls = [];
  const result = await runE2e([], {}, async (_args, env) => {
    calls.push(env.FREEDOM_E2E_AVATAR_ASSET_FIXTURE ?? null);
    return calls.length < 3 ? { code: 0, signal: null } : { code: 4, signal: null };
  });
  assert.equal(result.code, 4);
  assert.equal(result.signal, null);
  assert.deepEqual(calls, [null, null, '1']);
});

test('package test:e2e delegates to this runner', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['test:e2e'], 'node scripts/run-e2e.mjs');
});

function runSeam(source) {
  return new Promise(done => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      done({ code, signal, stdout, stderr });
    });
  });
}

test('a child process keeps an early non-zero Playwright status', async () => {
  const result = await runSeam(`
    import { runE2e, applyNativeExit } from ${JSON.stringify(runner)};
    let calls = 0;
    const result = await runE2e(['--headed'], {}, async () => {
      calls += 1;
      return { code: 9, signal: null };
    });
    if (calls !== 1) process.exit(50);
    await applyNativeExit(result);
  `);
  assert.equal(result.signal, null);
  assert.equal(result.code, 9, result.stderr);
});

test('a child process re-raises the Playwright termination signal', async () => {
  const result = await runSeam(`
    import { runE2e, applyNativeExit } from ${JSON.stringify(runner)};
    let calls = 0;
    const result = await runE2e([], {}, async () => {
      calls += 1;
      return { code: null, signal: 'SIGTERM' };
    });
    if (calls !== 1) process.exit(50);
    await applyNativeExit(result);
  `);
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.code, null);
});
