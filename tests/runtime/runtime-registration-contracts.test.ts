import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// @ts-expect-error Existing host-only clean environment helper is an ESM JavaScript module.
import { verificationEnvironment } from '../../packages/contribution-tools/process-env.mjs';

test('runtime enrollment generated structural contracts match central schemas exactly', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'modules/agent-control/generate.ts', '--check'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), env: verificationEnvironment(),
    encoding: 'utf8', timeout: 30000, maxBuffer: 128 * 1024,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
