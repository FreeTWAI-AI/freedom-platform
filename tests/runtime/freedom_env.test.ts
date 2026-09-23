import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveFreedomEnv,
  assertOriginAllowed,
  allowedBrowserOrigins,
  allowedRequestHosts,
} from '../../apps/platform-api/src/env.js';

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

test('staging browser origins are exact APP_ORIGIN', () => {
  const set = allowedBrowserOrigins('staging', 'https://staging.freetwai.com');
  assert.deepEqual([...set], ['https://staging.freetwai.com']);
});

test('staging request hosts include public + loopback for tunnel', () => {
  const set = allowedRequestHosts('staging', 'https://staging.freetwai.com');
  assert.ok(set.has('staging.freetwai.com'));
  assert.ok(set.has('127.0.0.1'));
});

test('public mode keeps a distinct exact HTTPS browser origin',()=>{
  assert.equal(resolveFreedomEnv('public'),'public');
  assertOriginAllowed('public','https://freetwai.com');
  assert.throws(()=>assertOriginAllowed('public','http://freetwai.com'));
  assert.throws(()=>assertOriginAllowed('public','https://localhost'));
  assert.throws(()=>assertOriginAllowed('public','https://freetwai.com/path'));
  assert.deepEqual([...allowedBrowserOrigins('public','https://freetwai.com')],['https://freetwai.com']);
  assert.ok(!allowedBrowserOrigins('public','https://freetwai.com').has('https://staging.freetwai.com'));
});

test('non-local configured origins reject loopback and unspecified address variants',()=>{
  for(const host of ['127.0.0.2','127.12.3.4','[::1]','[::]','0.0.0.0','[::ffff:127.0.0.1]']) {
    // URL canonicalization is required by assertOriginAllowed independently.
    const origin=new URL(`https://${host}`).origin;
    assert.throws(()=>assertOriginAllowed('public',origin));
    assert.throws(()=>assertOriginAllowed('staging',origin));
  }
});
