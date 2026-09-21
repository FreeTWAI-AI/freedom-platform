import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFreedomEnv, assertOriginAllowed } from '../../apps/platform-api/src/env.ts';

test('resolveFreedomEnv defaults to local', () => {
  assert.equal(resolveFreedomEnv(undefined), 'local');
  assert.equal(resolveFreedomEnv('local'), 'local');
});

test('resolveFreedomEnv accepts staging and rejects production', () => {
  assert.equal(resolveFreedomEnv('staging'), 'staging');
  assert.throws(() => resolveFreedomEnv('production'));
});

test('local origin lock', () => {
  assertOriginAllowed('local', 'http://127.0.0.1:4310');
  assert.throws(() => assertOriginAllowed('local', 'https://staging.freetwai.com'));
});

test('staging requires https non-loopback', () => {
  assertOriginAllowed('staging', 'https://staging.freetwai.com');
  assert.throws(() => assertOriginAllowed('staging', 'http://staging.freetwai.com'));
  assert.throws(() => assertOriginAllowed('staging', 'https://127.0.0.1:4310'));
});
