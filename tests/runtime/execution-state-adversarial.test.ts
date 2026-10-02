import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExecutionInput, ExecutionEvent, RunSnapshot } from '../../contracts/execution/v1/state.js';
import { evaluateExecution, decodeExecutionInput, executionActivationStatus } from '../../packages/execution-state/index.js';

// Independent synthetic facts. None of these identifiers/assertions is a real
// credential, provider selection, verified context, observed bill or DB row.
const id = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function input(): ExecutionInput {
  return {
    profile: 'freedom.execution.decision/v1', now: '2026-10-02T12:00:00.000Z', expected_version: '1',
    snapshot: {
      run_id: id(1), work_id: id(2), owner: { principal_id: id(3), kind: 'person' }, scope: { scope_id: id(9), kind: 'personal' },
      version: '1', work_version: '10', state: 'running', desired_control: 'run', current_attempt_id: id(4),
      attempts: [{ attempt_id: id(4), run_id: id(1), attempt_number: 1, runtime_id: id(5), connection_id: id(6),
        grant_id: id(7), grant_revision: '4', inference_binding_id: id(8), provider_ref: 'synthetic-provider', model_ref: 'synthetic-model',
        engine_location: 'runtime_local', processing_location: 'synthetic-remote', artifact_custody: 'runtime_local',
        credential_custody: 'official_cli', billing_source: 'user_cli_subscription', data_policy_revision: 'synthetic-policy',
        contract_version: 'synthetic-contract', adapter_version: 'synthetic-adapter' }],
      task_lease: { epoch: '3', expires_at: '2026-10-02T12:01:00.000Z' },
      control: { epoch: '5', acknowledged_epoch: '5' }, recovery_generation: '7', dispatches: [], evidence: [], result: null,
    },
    assertions: { actor_kind: 'runtime', principal_id: id(3), runtime_id: id(5), connection_id: id(6),
      owner_active: true, scope_active: true, work_active: true, work_version: '10', connection_active: true,
      runtime_online: true, model_ready: true, budget_available: true, policy_allowed: true, policy_revision: 'synthetic-policy',
      grant_id: id(7), grant_revision: '4', grant_active: true, grant_expires_at: '2026-10-02T12:10:00.000Z',
      recovery_generation: '7', task_epoch: '3', control_epoch: '5', evidence_expires_at: '2026-10-02T12:05:00.000Z' },
    event: { type: 'advance_model', dispatch_id: id(10), step_id: id(11), request_digest: 'a'.repeat(64) },
  };
}
function charge(state: RunSnapshot['dispatches'][number]['state'] = 'unknown', usage: 'known'|'unknown' = 'unknown') {
  return { dispatch_id: id(10), attempt_id: id(4), step_id: id(11), request_digest: 'a'.repeat(64),
    task_epoch: '3', control_epoch: '5', grant_revision: '4', policy_revision: 'synthetic-policy', recovery_generation: '7', state, usage };
}
function decide(value: unknown) {
  const result = evaluateExecution(value);
  assert.equal(result.assurance, 'hypothetical_decision_only');
  assert.equal(result.operational_authority, false);
  return result;
}
function denied(value: unknown) {
  const result = decide(value);
  assert.equal(result.admissible, false, JSON.stringify(result));
  assert.equal(result.next, undefined);
}
function apply(value: ExecutionInput, event: ExecutionEvent) {
  value.event = event;
  const result = decide(value);
  assert(result.admissible, result.reason);
  value.snapshot = structuredClone(result.next!);
  value.expected_version = value.snapshot.version;
  value.assertions.task_epoch = value.snapshot.task_lease.epoch;
  value.assertions.control_epoch = value.snapshot.control.epoch;
  return value.snapshot;
}

test('EXEC independent evaluator remains hypothetical even with all readiness facts asserted', () => {
  const value = input(), original = structuredClone(value), output = decide(value);
  assert(output.admissible);
  assert.deepEqual(value, original);
  assert(Object.isFrozen(output.next) && Object.isFrozen(output.next!.dispatches));
  assert.equal(executionActivationStatus().status, 'unavailable');
  assert.equal(executionActivationStatus().operational_authority, false);
});

for (const [name, alter] of [
  ['stale recovery generation', (v: ExecutionInput) => { v.assertions.recovery_generation = '6'; }],
  ['stale asserted control epoch', (v: ExecutionInput) => { v.assertions.control_epoch = '4'; }],
  ['stale acknowledged control epoch', (v: ExecutionInput) => { v.event = { type: 'control_ack', epoch: '4' }; }],
  ['revoked connection', (v: ExecutionInput) => { v.assertions.connection_active = false; }],
  ['wrong runtime', (v: ExecutionInput) => { v.assertions.runtime_id = id(99); }],
] as const) test(`EXEC control ACK rejects ${name}`, () => {
  const value = input(); value.snapshot.state = 'cancelling'; value.snapshot.desired_control = 'stop';
  value.snapshot.control.acknowledged_epoch = null; value.event = { type: 'control_ack', epoch: '5' };
  alter(value); denied(value);
});

test('EXEC valid stop ACK does not depend on a model, budget, or active Grant', () => {
  const value = input(); value.snapshot.state = 'cancelling'; value.snapshot.desired_control = 'stop';
  value.snapshot.control.acknowledged_epoch = null; value.event = { type: 'control_ack', epoch: '5' };
  value.assertions.model_ready = value.assertions.budget_available = value.assertions.grant_active = false;
  const result = decide(value); assert(result.admissible, result.reason); assert.equal(result.next!.state, 'cancelled');
});

test('EXEC fail then late matching control ACK must not rewrite failed as cancelled', () => {
  const value = input(); value.assertions.actor_kind = 'owner';
  apply(value, { type: 'fail' }); assert.equal(value.snapshot.state, 'failed');
  value.assertions.actor_kind = 'runtime'; value.event = { type: 'control_ack', epoch: value.snapshot.control.epoch };
  const result = decide(value);
  assert(!result.admissible || result.next!.state === 'failed', JSON.stringify(result));
});

test('EXEC fresh fence ACK after owner resume cannot silently undo preflight', () => {
  const value = input(); value.snapshot.state = 'paused'; value.snapshot.desired_control = 'pause';
  value.assertions.actor_kind = 'owner'; apply(value, { type: 'resume' });
  assert.equal(value.snapshot.state, 'preflighting');
  value.assertions.actor_kind = 'runtime';
  apply(value, { type: 'control_ack', epoch: value.snapshot.control.epoch });
  assert.equal(value.snapshot.state, 'preflighting');
});

for (const phase of ['record_dispatch', 'record_outcome'] as const)
  test(`EXEC ${phase} cannot reuse an original dispatch from an older recovery generation`, () => {
    const value = input();
    value.snapshot.dispatches = [phase === 'record_dispatch'
      ? { ...charge('proposed'), usage: 'not_dispatched' }
      : charge('in_flight')];
    // Recovery lives outside the restored DB. Neither a matching current
    // assertion nor unchanged task/control counters renews an old dispatch.
    value.snapshot.recovery_generation = value.assertions.recovery_generation = '8';
    value.event = phase === 'record_dispatch' ? { type: phase, dispatch_id: id(10) }
      : { type: phase, dispatch_id: id(10), outcome: 'succeeded', usage: 'known' };
    denied(value);
  });

for (const state of ['paused', 'cancelling', 'cancelled'] as const) test(`EXEC outcome cannot reopen a ${state} snapshot`, () => {
  const value = input(); value.snapshot.state = state; value.snapshot.desired_control = state === 'paused' ? 'pause' : 'stop';
  value.snapshot.dispatches = [charge('in_flight')];
  value.event = { type: 'record_outcome', dispatch_id: id(10), outcome: 'succeeded', usage: 'known' };
  denied(value);
});

for (const operation of ['stop', 'revoke', 'pause'] as const) test(`EXEC ${operation} remains available without model or provider readiness`, () => {
  const value = input(); value.assertions.actor_kind = 'owner';
  for (const key of ['model_ready', 'runtime_online', 'connection_active', 'policy_allowed', 'grant_active', 'budget_available'] as const) value.assertions[key] = false;
  value.event = { type: operation };
  const next = decide(value); assert(next.admissible, next.reason);
  assert.equal(next.next!.task_lease.expires_at, null);
  assert.equal(next.next!.control.acknowledged_epoch, null);
  assert.equal(next.next!.control.epoch, '6');
});

for (const [state, usage] of [['unknown', 'known'], ['succeeded', 'unknown'], ['manual_unknown', 'unknown']] as const)
  test(`EXEC unknown ${state}/${usage} survives stop, ACK, evidence and blocks handoff`, () => {
    const value = input(); value.snapshot.dispatches = [charge(state, usage)]; value.assertions.actor_kind = 'owner';
    const history = structuredClone(value.snapshot.dispatches), attempt = structuredClone(value.snapshot.attempts[0]);
    apply(value, { type: 'stop' }); assert.equal(value.snapshot.state, 'cancelling');
    value.assertions.actor_kind = 'runtime'; apply(value, { type: 'control_ack', epoch: value.snapshot.control.epoch });
    assert.equal(value.snapshot.state, 'cancelling'); assert.deepEqual(value.snapshot.dispatches, history);
    value.assertions.actor_kind = 'runtime_evidence'; value.assertions.model_ready = value.assertions.grant_active = false;
    apply(value, { type: 'late_evidence', evidence: { evidence_id: id(12), dispatch_id: id(10), attempt_id: id(4),
      evidence_digest: 'b'.repeat(64), observation: 'observed_success', usage_observation: 'unknown' } });
    assert.deepEqual(value.snapshot.dispatches, history); assert.deepEqual(value.snapshot.attempts[0], attempt);
    value.assertions.actor_kind = 'owner'; value.event = { type: 'handoff', binding: { ...attempt, attempt_id: id(14), attempt_number: 2 } };
    denied(value);
    value.event = { type: 'reconcile_dispatch', dispatch_id: id(10), evidence_id: id(12), outcome: 'succeeded', usage: 'known' };
    denied(value); // A successful observation is not evidence of known billing.
  });

test('EXEC revoked device cannot use late evidence as a permanent authentication exception', () => {
  const value = input(); value.snapshot.dispatches = [charge()]; value.snapshot.state = 'reconciling';
  value.assertions.actor_kind = 'runtime_evidence'; value.assertions.connection_active = false;
  value.event = { type: 'late_evidence', evidence: { evidence_id: id(12), dispatch_id: id(10), attempt_id: id(4),
    evidence_digest: 'b'.repeat(64), observation: 'observed_unknown', usage_observation: 'unknown' } };
  denied(value);
});

test('EXEC wire rejects fractional lexemes that round to a valid integer', () => {
  const raw = JSON.stringify(input());
  for (const number of ['1.0000000000000001', '0.99999999999999999', '1.0000000000000001e0']) {
    const changed = raw.replace('"attempt_number":1', `"attempt_number":${number}`);
    assert.notEqual(changed, raw); assert.throws(() => decodeExecutionInput(changed)); denied(changed);
  }
});

test('EXEC object decoder cannot erase non-index array properties into an empty attempt history', () => {
  const value = input(); value.snapshot.state = 'created'; value.snapshot.current_attempt_id = null;
  const sparse: any[] = new Array(2);
  Object.defineProperty(sparse, '4294967295', { value: value.snapshot.attempts[0], enumerable: true });
  Object.defineProperty(sparse, '4294967296', { value: value.snapshot.attempts[0], enumerable: true });
  value.event = { type: 'preflight', binding: structuredClone(value.snapshot.attempts[0]) };
  value.snapshot.attempts = sparse; value.assertions.actor_kind = 'owner'; denied(value);
});

test('EXEC nested escaped duplicate keys and prototype-like keys remain invalid', () => {
  const raw = JSON.stringify(input());
  for (const changed of [
    raw.replace('"epoch":"5"', '"epoch":"4","ep\\u006fch":"5"'),
    raw.replace('"owner_active":true', '"owner_active":false,"owner_\\u0061ctive":true'),
    raw.replace('"attempt_number":1', '"attempt_number":1,"__proto__":{}'),
  ]) { assert.notEqual(changed, raw); assert.throws(() => decodeExecutionInput(changed)); denied(changed); }
});

test('EXEC object decoder rejects accessors without executing them or serializing secret markers', () => {
  const value = input(); let calls = 0;
  Object.defineProperty(value.assertions, 'grant_active', { enumerable: true, get() { calls++; throw Error('PRIVATE_MARKER'); } });
  const result = decide(value); assert.equal(result.admissible, false); assert.equal(calls, 0);
  assert(!JSON.stringify(result).includes('PRIVATE_MARKER'));
});
