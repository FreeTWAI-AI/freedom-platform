import assert from 'node:assert/strict';
import test from 'node:test';
import { createSupervisorContainerLifecycle } from '../behavior-supervisor.mjs';
const id = 'a'.repeat(64);

test('delayed daemon create after CLI timeout cannot be certified by an empty label scan', async () => {
  const lifecycle = createSupervisorContainerLifecycle();
  const containers = new Set();
  let finishCreate;
  const daemonRequest = new Promise(resolve => { finishCreate = () => { containers.add(id); resolve(); }; });
  assert.throws(() => lifecycle.dispatch('candidate', 'create', () => {
    throw Object.assign(new Error('CLI deadline'), { code: 'ETIMEDOUT' });
  }), { code: 'ETIMEDOUT' });
  // This was the production failure: the CLI exits, both cleanup scans are empty,
  // then the independent daemon finishes creating the owned container later.
  for (let scan = 0; scan < 2; scan++) {
    assert.equal(containers.size, 0);
    const state = lifecycle.cleanupState(containers.size === 0);
    assert.equal(state.cleanup_verified, false);
    assert.equal(state.status, 'create_pending');
    assert.deepEqual(state.pending_creates, [{ kind: 'candidate', operation: 'create', state: 'create_pending' }]);
  }
  finishCreate(); await daemonRequest;
  assert.equal(containers.size, 1);
  assert.equal(lifecycle.cleanupState(false).cleanup_verified, false);
  containers.delete(id); // Best-effort removal does not acknowledge the original request.
  assert.equal(lifecycle.cleanupState(true).status, 'create_pending');
});

test('invalid, empty, missing and throwing acknowledgements remain unknown for create and run', () => {
  for (const [kind, operation] of [['candidate', 'create'], ['database', 'run']]) {
    for (const output of ['', 'not-an-id', id + '\n' + id, null]) {
      const lifecycle = createSupervisorContainerLifecycle();
      assert.throws(() => lifecycle.dispatch(kind, operation, () => output));
      assert.equal(lifecycle.cleanupState(true).cleanup_verified, false);
    }
    const lifecycle = createSupervisorContainerLifecycle();
    assert.throws(() => lifecycle.dispatch(kind, operation, () => { throw Error('host command failed'); }));
    assert.equal(lifecycle.cleanupState(true).status, 'create_pending');
  }
});

test('only acknowledged operations plus an empty successful scan verify cleanup', () => {
  const lifecycle = createSupervisorContainerLifecycle();
  assert.equal(lifecycle.cleanupState(true).cleanup_verified, true, 'nothing dispatched');
  assert.equal(lifecycle.dispatch('database', 'run', () => Buffer.from(id + '\n')), id);
  assert.equal(lifecycle.dispatch('candidate', 'create', () => Buffer.from('b'.repeat(64))), 'b'.repeat(64));
  assert.equal(lifecycle.cleanupState(false).cleanup_verified, false);
  assert.equal(lifecycle.cleanupState(undefined).cleanup_verified, false);
  assert.deepEqual(lifecycle.cleanupState(true), { status: 'verified', cleanup_verified: true, pending_creates: [] });
  assert.throws(() => lifecycle.dispatch('candidate', 'create', () => { throw Error('unknown second create'); }));
  assert.equal(lifecycle.cleanupState(true).cleanup_verified, false, 'earlier acknowledged resources do not settle another request');
});

test('pending dispatch records cannot be cleared by mutating a diagnostic result', () => {
  const lifecycle = createSupervisorContainerLifecycle();
  assert.throws(() => lifecycle.dispatch('database', 'run', () => { throw Error('lost ACK'); }));
  const diagnostic = lifecycle.cleanupState(true); diagnostic.pending_creates.length = 0; diagnostic.cleanup_verified = true;
  assert.equal(lifecycle.cleanupState(true).cleanup_verified, false);
});
