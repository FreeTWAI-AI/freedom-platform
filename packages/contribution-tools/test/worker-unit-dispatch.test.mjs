import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createLedger } from '../worker-unit-routing.mjs';
import { createDispatchState, workerUnitAdapter } from '../worker-unit-dispatch.mjs';
const sha = n => n.toString(16).padStart(40, '0');
const digest = 'a'.repeat(64);
const binding = { repository: 'FreeTWAI/freedom-platform', sourceSha: sha(1), runnerSha: sha(2), suite: 'ci.worker-unit', suiteDigest: digest, attempt: 'first' };
const policy = { runnerSha: sha(2), suiteDigest: digest, configSha: sha(3), resourceClass: 'large', maxJobCredits: 1000, maxJobSeconds: 100, costProof: digest };
function input() {
  return { cycle: 'one', request: { binding: { ...binding }, event: 'pull_request', fork: false }, now: 1000,
    enabled: true, policy, providerHealthy: true,
    quota: { cycle: 'one', remainingLowerBound: 400000, validUntil: 1000000, evidence: digest } };
}
function observation(b = binding, state = 'passed', fields = {}) {
  return { binding: { ...b }, pipeline: 'pipeline-1', job: 'job-1', state, evidence: digest,
    complete: true, testCount: 109, failed: 0, skipped: 0, cancelled: 0, ...fields };
}
function fixture() {
  let revision = 10;
  const f = { state: createDispatchState([
    createLedger({ cycle: 'one', startsAt: 0, endsAt: 1000000 }),
    createLedger({ cycle: 'two', startsAt: 1000000, endsAt: 2000000 })
  ]), head: sha(revision), calls: [], sends: [], observed: observation(), commitMode: null, sendMode: null };
  f.ports = {
    async read() { f.calls.push('read'); return structuredClone({ head: f.head, state: f.state }); },
    async commit(p) {
      f.calls.push('commit'); assert.equal(p.force, false); assert.equal(p.parents.length, 1);
      assert.equal(p.sha256, createHash('sha256').update(p.bytes).digest('hex'));
      if (f.commitMode === 'reject' || p.parents[0] !== f.head) return { status: 'rejected' };
      f.state = JSON.parse(p.bytes); f.head = sha(++revision);
      if (f.afterCommit) f.afterCommit();
      if (f.commitMode === 'lost') throw Error('lost CAS acknowledgement');
      return { status: 'committed', head: f.head, sha256: p.sha256 };
    },
    async dispatch(p) {
      f.calls.push('dispatch'); f.sends.push(p);
      // Persistence MUST precede the remote call, for primary AND fallback.
      const entries = [...f.state.cycles.flatMap(l => l.entries), ...f.state.fallback.entries];
      assert(entries.some(e => e.binding.attempt === p.binding.attempt && e.state === 'dispatch_unknown'));
      if (f.sendMode === 'lost') throw Error('remote accepted but acknowledgement lost');
      if (f.sendMode === 'hang') return new Promise(() => {});
      return { pipeline: p.provider === 'circleci' ? 'pipeline-1' : 'github-run-1' };
    },
    async observe(p) { f.calls.push('observe'); f.lastObserved = p; return structuredClone(f.observed); }
  };
  f.adapter = workerUnitAdapter(f.ports, { enabled: true, timeoutMs: 1000 });
  return f;
}

test('disabled adapter invokes no port for dispatch, reconcile or fallback', async () => {
  const f = fixture(); const a = workerUnitAdapter(f.ports);
  assert.equal((await a.dispatch(input())).status, 'disabled');
  assert.equal((await a.reconcile(binding)).status, 'disabled');
  assert.equal((await a.fallback(binding)).status, 'disabled'); assert.deepEqual(f.calls, []);
});
test('winning reservation precedes one dispatch and stores acknowledgement; restart never redispatches', async () => {
  const f = fixture(); await f.adapter.dispatch(input());
  assert.equal(f.sends.length, 1); assert.equal(f.state.cycles[0].entries[0].pipeline, 'pipeline-1');
  const restarted = workerUnitAdapter(f.ports, { enabled: true });
  assert.equal((await restarted.dispatch(input())).reason, 'already_owned');
  assert.equal((await restarted.reconcile(binding)).reason, 'passed');
  assert.equal((await restarted.fallback(binding)).reason, 'fallback_not_eligible');
  assert.equal(f.sends.length, 1);
});
test('concurrent invocations dispatch exactly one primary', async () => {
  const f = fixture(); await Promise.all([f.adapter.dispatch(input()), f.adapter.dispatch(input()), f.adapter.dispatch(input())]);
  assert.equal(f.sends.length, 1); assert.equal(f.state.cycles[0].entries.length, 1);
});
test('rejected CAS never dispatches; lost successful CAS also never dispatches', async () => {
  for (const mode of ['reject', 'lost']) {
    const f = fixture(); f.commitMode = mode; await f.adapter.dispatch(input());
    assert.equal(f.sends.length, 0);
    if (mode === 'lost') {
      f.commitMode = null; await f.adapter.dispatch(input()); assert.equal(f.sends.length, 0);
      assert.equal(f.state.cycles[0].entries[0].reservedCredits, 1000);
    }
  }
});
test('unknown dispatch acknowledgement remains reserved and blocks fallback, even after timeout', async () => {
  for (const mode of ['lost', 'hang']) {
    const f = fixture(); f.sendMode = mode;
    const a = workerUnitAdapter(f.ports, { enabled: true, timeoutMs: 10 });
    assert.equal((await a.dispatch(input())).reason, 'dispatch_acknowledgement_unknown');
    assert.equal(f.state.cycles[0].entries[0].pipeline, null);
    f.observed = { state: 'unknown' }; await a.reconcile(binding); await a.fallback(binding); await a.dispatch(input());
    assert.equal(f.sends.length, 1); assert.equal(f.state.cycles[0].entries[0].reservedCredits, 1000);
  }
});
test('lost pipeline persistence cannot repeat a POST; observation can reconcile by exact attempt', async () => {
  const f = fixture();
  const send = f.ports.dispatch;
  f.ports.dispatch = async p => { const result = await send(p); f.commitMode = 'reject'; return result; };
  assert.equal((await f.adapter.dispatch(input())).reason, 'pipeline_persistence_unknown');
  f.commitMode = null; await f.adapter.dispatch(input()); await f.adapter.reconcile(binding);
  assert.equal(f.lastObserved.pipeline, null); assert.deepEqual(f.lastObserved.binding, binding);
  assert.equal(f.sends.length, 1); assert.equal(f.state.cycles[0].entries[0].state, 'passed');
});
test('abort after reservation before POST strands ownership safely', async () => {
  const f = fixture(); const ac = new AbortController(); f.afterCommit = () => ac.abort();
  await f.adapter.dispatch(input(), ac.signal);
  assert.equal(f.sends.length, 0); assert.equal(f.state.cycles[0].entries[0].state, 'dispatch_unknown');
  await f.adapter.dispatch(input()); assert.equal(f.sends.length, 0);
});
test('confirmed cancellation does not free quota or trigger fallback', async () => {
  const f = fixture(); await f.adapter.dispatch(input()); f.observed = observation(binding, 'cancelled');
  await f.adapter.reconcile(binding); await f.adapter.fallback(binding);
  assert.equal(f.sends.length, 1); assert.equal(f.state.cycles[0].entries[0].reservedCredits, 1000);
});
for (const [state, fields] of [
  ['test_failure', {}], ['suite_timeout', {}], ['incomplete', {}],
  ['infra_failure', { failed: 1 }], ['passed', { skipped: 1 }], ['passed', { complete: false }]
]) test(`real failure never admits fallback: ${state}/${JSON.stringify(fields)}`, async () => {
  const f = fixture(); await f.adapter.dispatch(input()); f.observed = observation(binding, state, fields);
  assert.equal((await f.adapter.reconcile(binding)).reason, 'failed');
  await f.adapter.fallback(binding); assert.equal(f.sends.length, 1);
  f.observed = observation(); await f.adapter.reconcile(binding);
  assert.equal(f.state.cycles[0].entries[0].state, 'failed');
});
test('stale source/attempt/pipeline/job cannot settle another reservation', async () => {
  for (const fields of [{ binding: { ...binding, sourceSha: sha(9) } }, { binding: { ...binding, attempt: 'stale' } }, { pipeline: 'wrong' }]) {
    const f = fixture(); await f.adapter.dispatch(input()); f.observed = observation(binding, 'passed', fields);
    assert.equal((await f.adapter.reconcile(binding)).status, 'hold');
    assert.equal(f.state.cycles[0].entries[0].state, 'dispatch_unknown');
  }
  const f = fixture(); await f.adapter.dispatch(input()); f.observed = observation(binding, 'running'); await f.adapter.reconcile(binding);
  f.observed = observation(binding, 'passed', { job: 'wrong-job' }); await f.adapter.reconcile(binding);
  assert.equal(f.state.cycles[0].entries[0].state, 'running');
});
async function readyFallback(f) {
  await f.adapter.dispatch(input()); f.observed = observation(binding, 'infra_failure', { complete: false, testCount: 0 });
  assert.equal((await f.adapter.reconcile(binding)).reason, 'infra_failure');
}
test('concurrent fallbacks have one atomic GitHub owner and complete exact-bound reconciliation', async () => {
  const f = fixture(); await readyFallback(f);
  await Promise.all([f.adapter.fallback(binding), f.adapter.fallback(binding)]);
  assert.equal(f.sends.length, 2); assert.equal(f.sends[1].provider, 'github');
  const b = f.state.fallback.entries[0].binding;
  assert.notEqual(b.attempt, binding.attempt); assert.equal(b.sourceSha, binding.sourceSha);
  f.observed = observation(b, 'passed', { pipeline: 'github-run-1' });
  assert.equal((await f.adapter.reconcile(b)).reason, 'passed');
  await f.adapter.fallback(binding); assert.equal(f.sends.length, 2);
});
test('lost fallback CAS and lost fallback POST never repeat fallback', async () => {
  for (const phase of ['commit', 'dispatch']) {
    const f = fixture(); await readyFallback(f);
    if (phase === 'commit') f.commitMode = 'lost'; else f.sendMode = 'lost';
    await f.adapter.fallback(binding); const sends = f.sends.length;
    f.commitMode = null; f.sendMode = null; await f.adapter.fallback(binding);
    assert.equal(f.sends.length, sends); assert.equal(f.state.fallback.entries[0].state, 'dispatch_unknown');
  }
});
test('fallback test failure is final, never converted to fallback success', async () => {
  const f = fixture(); await readyFallback(f); await f.adapter.fallback(binding);
  const b = f.state.fallback.entries[0].binding;
  f.observed = observation(b, 'test_failure', { pipeline: 'github-run-1' }); await f.adapter.reconcile(b);
  f.observed = observation(b, 'passed', { pipeline: 'github-run-1' }); await f.adapter.reconcile(b);
  assert.equal(f.state.fallback.entries[0].state, 'failed'); await f.adapter.fallback(binding); assert.equal(f.sends.length, 2);
});
test('ownership survives cycles; unresolved previous-cycle cost blocks new CircleCI admissions', async () => {
  const f = fixture(); await f.adapter.dispatch(input());
  const second = input(); second.cycle = 'two'; second.now = 1001000; second.quota = { ...second.quota, cycle: 'two', validUntil: 2000000 };
  second.request.binding.attempt = 'new-cycle';
  assert.equal((await f.adapter.dispatch(second)).reason, 'already_owned');
  second.request.binding.sourceSha = sha(5);
  assert.equal((await f.adapter.dispatch(second)).reason, 'previous_cycle_unreconciled');
  await f.adapter.reconcile(binding); await f.adapter.dispatch(second);
  assert.equal(f.sends.length, 2); assert.equal(f.state.cycles[0].entries[0].reservedCredits, 1000);
});
test('unknown quota chooses GitHub once, while forks and merge groups stay with native GitHub', async () => {
  const f = fixture(); const i = input(); i.quota = null;
  await f.adapter.dispatch(i); await f.adapter.dispatch(i); assert.equal(f.sends.length, 1); assert.equal(f.sends[0].provider, 'github');
  for (const request of [{ ...i.request, fork: true }, { ...i.request, event: 'merge_group' }]) {
    const g = fixture(); assert.equal((await g.adapter.dispatch({ ...i, request })).status, 'github_native'); assert.deepEqual(g.calls, []);
  }
});
test('malformed/overlapping cycles and duplicate cross-cycle ownership are rejected', async () => {
  const l = createLedger({ cycle: 'one', startsAt: 0, endsAt: 1000 });
  assert.throws(() => createDispatchState([l, l]));
  assert.throws(() => createDispatchState(Array(13).fill(l)));
  const f = fixture(); await f.adapter.dispatch(input());
  f.state.cycles[1].entries.push(structuredClone(f.state.cycles[0].entries[0]));
  assert.throws(() => createDispatchState(f.state.cycles));
});

test('confirmed non-dispatch permits one fallback but contradictory execution evidence does not', async () => {
  const f = fixture(); f.sendMode = 'lost'; await f.adapter.dispatch(input());
  f.observed = observation(binding, 'not_dispatched', { pipeline: null, job: null });
  assert.equal((await f.adapter.reconcile(binding)).status, 'hold');
  f.observed = observation(binding, 'not_dispatched', { pipeline: null, job: null, testCount: 0, complete: false });
  assert.equal((await f.adapter.reconcile(binding)).reason, 'not_dispatched');
  f.sendMode = null; await f.adapter.fallback(binding); await f.adapter.fallback(binding);
  assert.equal(f.sends.length, 2); assert.equal(f.sends[1].provider, 'github');
});
test('caller abort during POST preserves unknown ownership after restart', async () => {
  const f = fixture(); const ac = new AbortController();
  f.ports.dispatch = async p => { f.sends.push(p); ac.abort(); return new Promise(() => {}); };
  await f.adapter.dispatch(input(), ac.signal);
  await workerUnitAdapter(f.ports, { enabled: true }).dispatch(input());
  assert.equal(f.sends.length, 1); assert.equal(f.state.cycles[0].entries[0].state, 'dispatch_unknown');
});
