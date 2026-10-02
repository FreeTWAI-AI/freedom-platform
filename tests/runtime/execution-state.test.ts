import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
// @ts-expect-error Existing environment helper is intentionally an ESM JavaScript module.
import { verificationEnvironment } from '../../packages/contribution-tools/process-env.mjs';
import { z } from 'zod';
import { ExecutionInputSchema } from '../../contracts/execution/v1/state.js';
import { evaluateExecution, decodeExecutionInput, executionActivationStatus, EXECUTION_LIMITS } from '../../packages/execution-state/index.js';
import { base, binding, dispatch, evidence, executionVectors, fixtureId, vectorInput } from '../../packages/execution-state/vectors.js';

for (const vector of executionVectors) test(vector.id, () => {
  const input = vectorInput(vector), before = structuredClone(input), decision = evaluateExecution(input);
  assert.equal(decision.admissible, vector.admissible, decision.reason);
  if (vector.state) assert.equal(decision.next?.state, vector.state);
  assert.equal(decision.operational_authority, false); assert.equal(decision.assurance, 'hypothetical_decision_only');
  assert.deepEqual(input, before, 'Caller objects remain unchanged');
  assert.deepEqual(evaluateExecution(JSON.stringify(input)), decision, 'Bounded wire and object inputs agree');
});
const clone = () => structuredClone(base);
const deny = (input: unknown, reason: string) => { const decision = evaluateExecution(input); assert.equal(decision.admissible, false); assert.equal(decision.reason, reason); assert.equal(decision.next, undefined); };

test('activation remains unavailable even when every hypothetical readiness assertion is true', () => {
  const result = evaluateExecution(vectorInput(executionVectors[1])); assert(result.admissible);
  assert.deepEqual(executionActivationStatus(), { assurance: 'hypothetical_decision_only', operational_authority: false, status: 'unavailable', reason: 'authenticated_execution_adapter_not_implemented' });
  assert(Object.isFrozen(result.next) && Object.isFrozen(result.next!.attempts[0]));
  assert.throws(() => { result.next!.attempts[0].model_ref = 'changed'; });
});
test('generated schema matches the sole authoring schema exactly', async () => {
  const expected = { ...z.toJSONSchema(ExecutionInputSchema), $id: 'https://freetwai.com/contracts/execution/v1/decision-input',
    description: 'Hypothetical decision inputs only; no authentication, runtime authority, dispatch or durable state.' };
  assert.equal(await readFile('contracts/execution/v1/decision-input.schema.json', 'utf8'), JSON.stringify(expected, null, 2) + '\n');
});
for (const [field, value, reason] of [
  ['owner_active', false, 'owner_scope_unavailable'], ['scope_active', false, 'owner_scope_unavailable'],
  ['principal_id', fixtureId(90), 'owner_scope_unavailable'], ['connection_active', false, 'runtime_binding_unavailable'],
  ['runtime_id', fixtureId(90), 'runtime_binding_unavailable'], ['connection_id', fixtureId(90), 'runtime_binding_unavailable'],
  ['work_active', false, 'work_unavailable'], ['runtime_online', false, 'runtime_offline'],
  ['grant_active', false, 'grant_unavailable'], ['grant_revision', '4', 'grant_unavailable'], ['grant_id', fixtureId(90), 'grant_unavailable'],
  ['grant_expires_at', base.now, 'grant_unavailable'], ['policy_allowed', false, 'policy_unavailable'], ['policy_revision', 'changed', 'policy_unavailable'],
  ['recovery_generation', '5', 'recovery_generation_mismatch'], ['task_epoch', '3', 'stale_epoch'], ['control_epoch', '3', 'stale_epoch'],
  ['model_ready', false, 'model_unavailable'], ['budget_available', false, 'budget_unavailable'],
] as const) test(`fresh model decision rejects independent ${field}`, () => {
  const input = clone(); (input.assertions as any)[field] = value; deny(input, reason);
});
test('lease uses its own expires_at and the explicitly supplied decision clock', () => {
  const input = clone(); input.snapshot.task_lease.expires_at = input.now; deny(input, 'lease_expired');
  (input.snapshot.task_lease as any).lease_expires_at = base.snapshot.task_lease.expires_at; deny(input, 'invalid_input');
});
test('exact version and bigint exhaustion fail without lossy coercion', () => {
  const input = clone(); input.expected_version = '2'; deny(input, 'version_conflict');
  input.expected_version = input.snapshot.version = '9223372036854775807'; deny(input, 'version_exhausted');
  input.expected_version = input.snapshot.version = '9223372036854775808'; deny(input, 'invalid_version');
});
test('same attempt identity cannot rewrite any immutable binding', () => {
  for (const key of Object.keys(binding) as (keyof typeof binding)[]) {
    if (key === 'attempt_id') continue;
    const input = vectorInput(executionVectors[0]); input.snapshot = { ...structuredClone(base.snapshot), state: 'preflighting' };
    const changed: any = { ...binding };
    if (key === 'attempt_number') changed[key] = 2;
    else if (key === 'engine_location') changed[key] = 'platform';
    else if (key === 'artifact_custody') changed[key] = 'runtime_local';
    else if (key === 'credential_custody') changed[key] = 'platform_vault';
    else if (key === 'billing_source') changed[key] = 'user_api';
    else if (key.endsWith('_id')) changed[key] = fixtureId(99);
    else if (key === 'grant_revision') changed[key] = '4'; else changed[key] = 'changed';
    input.event = { type: 'preflight', binding: changed };
    deny(input, key === 'run_id' ? 'attempt_run_mismatch' : 'immutable_attempt_binding');
  }
});
test('handoff preserves old binding and all settled evidence', () => {
  const input = vectorInput(executionVectors[15]); input.snapshot.dispatches = [dispatch('succeeded', 'known')]; input.snapshot.evidence = [evidence];
  const next = evaluateExecution(input).next!; assert.deepEqual(next.attempts[0], binding); assert.deepEqual(next.dispatches, input.snapshot.dispatches); assert.deepEqual(next.evidence, input.snapshot.evidence);
  assert.equal(next.attempts.length, 2); assert.equal(next.task_lease.epoch, '3'); assert.equal(next.control.epoch, '3');
  assert.equal(next.attempts[1].grant_revision, '3', 'Grant revision is not a task/control epoch');
});
for (const [state, usage] of [['in_flight', 'unknown'], ['unknown', 'known'], ['manual_unknown', 'unknown'], ['succeeded', 'unknown']] as const) {
  test(`handoff cannot discard ${state}/${usage}`, () => {
    const input = vectorInput(executionVectors[15]); input.snapshot.dispatches = [dispatch(state, usage)]; deny(input, 'reconciliation_required');
    input.event = { type: 'fail' }; const result = evaluateExecution(input); assert(result.admissible); assert.equal(result.next!.state, 'reconciling'); assert.deepEqual(result.next!.dispatches, input.snapshot.dispatches);
  });
}
test('Stop fences only undispatched work; in-flight unknown and unknown billing survive ACK', () => {
  const input = clone(); input.event = { type: 'stop' }; input.assertions.actor_kind = 'owner'; input.snapshot.state = 'running';
  input.snapshot.dispatches = [dispatch(), { ...dispatch('proposed', 'not_dispatched'), dispatch_id: fixtureId(20), step_id: fixtureId(21) }];
  const stopped = evaluateExecution(input).next!;
  assert.equal(stopped.dispatches[0].state, 'in_flight'); assert.equal(stopped.dispatches[1].state, 'cancelled_before_dispatch');
  assert.equal(stopped.task_lease.expires_at, null); assert.equal(stopped.control.acknowledged_epoch, null);
  input.snapshot = structuredClone(stopped); input.expected_version = stopped.version; input.assertions.actor_kind = 'runtime'; input.event = { type: 'control_ack', epoch: stopped.control.epoch };
  input.assertions.task_epoch = stopped.task_lease.epoch; input.assertions.control_epoch = stopped.control.epoch;
  assert.equal(evaluateExecution(input).next?.state, 'cancelling');
  input.event = { type: 'record_dispatch', dispatch_id: fixtureId(20) }; deny(input, 'invalid_transition');
});
test('late evidence is append-only observation and cannot revive or publish', () => {
  const input = vectorInput(executionVectors[13]), next = evaluateExecution(input).next!;
  assert.deepEqual(next.dispatches, input.snapshot.dispatches); assert.equal(next.result, null); assert.equal(next.current_attempt_id, input.snapshot.current_attempt_id);
  input.event = { type: 'complete' }; deny(input, 'runtime_binding_unavailable');
  input.event = { type: 'publication_decision', result_id: fixtureId(13), attempt_id: binding.attempt_id, expected_work_version: '7', provenance: 'model_draft' }; deny(input, 'invalid_transition');
});
for (const [field, value, reason] of [['connection_active', false, 'runtime_binding_unavailable'], ['runtime_id', fixtureId(90), 'runtime_binding_unavailable'], ['evidence_expires_at', base.now, 'evidence_window_expired']] as const) {
  test(`late evidence refuses ${field} override`, () => { const input = vectorInput(executionVectors[13]); (input.assertions as any)[field] = value; deny(input, reason); });
}
test('evidence must name its original dispatch and exact repeat identity', () => {
  const input = vectorInput(executionVectors[13]); if (input.event.type !== 'late_evidence') throw Error();
  input.event.evidence.dispatch_id = fixtureId(99); deny(input, 'dispatch_not_found');
  input.event.evidence = { ...evidence }; input.snapshot.evidence = [{ ...evidence, evidence_digest: 'c'.repeat(64) }]; deny(input, 'evidence_conflict');
  input.snapshot.dispatches = [dispatch('proposed', 'not_dispatched')]; input.snapshot.evidence = []; deny(input, 'evidence_without_dispatch');
});
test('unknown charge cannot become known without the same evidence recording known usage', () => {
  const input = vectorInput(executionVectors[14]); input.snapshot.evidence[0].usage_observation = 'unknown'; deny(input, 'usage_evidence_required');
  input.snapshot.evidence = []; deny(input, 'reconciliation_evidence_required');
});
test('publication denies an edited Work and never attaches a human-labelled model Result', () => {
  const input = vectorInput(executionVectors[16]); input.assertions.work_version = '8'; deny(input, 'work_version_conflict');
  input.assertions.work_version = '7'; (input.event as any).provenance = 'human'; deny(input, 'invalid_input');
  (input.event as any).provenance = 'model_draft'; const output = evaluateExecution(input);
  assert.equal(output.next!.result, null); assert.equal(output.next!.version, input.snapshot.version); assert.equal(output.publication_requires_authenticated_atomic_adapter, true);
});
test('a claimed terminal state cannot hide unresolved outcomes or billing', () => {
  for (const state of ['completed', 'cancelled', 'failed'] as const) {
    const input = clone(); input.snapshot.state = state; input.snapshot.dispatches = [dispatch('succeeded', 'unknown')]; deny(input, 'unresolved_terminal_state');
  }
});
test('Stop and pause before any attempt do not invent runtime/model bindings', () => {
  const input = vectorInput(executionVectors[0]); input.event = { type: 'stop' };
  const output = evaluateExecution(input); assert.equal(output.next!.state, 'cancelled'); assert.equal(output.next!.attempts.length, 0);
  input.event = { type: 'pause' }; const paused = evaluateExecution(input).next!; assert.equal(paused.state, 'paused');
  input.snapshot = structuredClone(paused); input.expected_version = paused.version; input.event = { type: 'resume' }; assert.equal(evaluateExecution(input).next!.state, 'created');
});
test('prototype history bounds refuse rather than evict old attempts or unknowns', () => {
  const input = vectorInput(executionVectors[15]);
  input.snapshot.attempts = Array.from({ length: 16 }, (_, i) => ({ ...binding, attempt_id: fixtureId(100 + i), attempt_number: i + 1 }));
  input.snapshot.current_attempt_id = fixtureId(115); input.event = { type: 'handoff', binding: { ...binding, attempt_id: fixtureId(120), attempt_number: 17 } };
  deny(input, 'prototype_history_limit'); assert.equal(input.snapshot.attempts.length, 16);
  input.snapshot.dispatches = Array.from({ length: 129 }, (_, i) => ({ ...dispatch(), dispatch_id: fixtureId(200 + i), step_id: fixtureId(400 + i) }));
  assert.equal(evaluateExecution(input).admissible, false); assert.equal(input.snapshot.dispatches.length, 129);
});
test('decoder rejects duplicate decoded keys at root and nested levels', () => {
  const raw = JSON.stringify(base);
  for (const changed of [raw.replace('"profile":', '"profile":"duplicate","pro\\u0066ile":'), raw.replace('"owner_active":true', '"owner_active":false,"owner_active":true')]) {
    assert.throws(() => decodeExecutionInput(changed)); deny(changed, 'invalid_input');
  }
});
test('decoder rejects depth/bytes/unsafe numbers/surrogates and unknown executable payloads', () => {
  deny(' '.repeat(EXECUTION_LIMITS.inputBytes + 1), 'input_limit');
  deny('['.repeat(26) + '0' + ']'.repeat(26), 'input_limit');
  for (const value of ['9007199254740993', '1e309', '-0', '1.2', 'NaN', '{"a":"\\ud800"}', '{"__proto__":{}}']) deny(value, 'invalid_input');
  for (const field of ['token', 'session_hash', 'command', 'prompt', 'tool_args', 'provider_key']) deny({ ...base, [field]: 'must-not-be-accepted' }, 'invalid_input');
  const input = clone(); input.snapshot.version = '1\n'; deny(input, 'invalid_input');
});
test('object convenience API rejects getters, cycles, sparse arrays and non-JSON values without calling them', () => {
  let calls = 0; const getter = Object.defineProperty({}, 'profile', { enumerable: true, get() { calls++; return base.profile; } });
  deny(getter, 'invalid_input'); assert.equal(calls, 0);
  const cycle: any = {}; cycle.self = cycle;
  for (const invalid of [cycle, new Date(), { value: undefined }, { value: 1n }, { value: NaN }, { value: Symbol() }, new Array(2)]) deny(invalid, 'invalid_input');
});
test('control ACK fences recovery and both epochs without requiring model, policy, Grant or live task lease', () => {
  const input = vectorInput(executionVectors[12]);
  Object.assign(input.assertions, { model_ready: false, grant_active: false, policy_allowed: false }); input.snapshot.task_lease.expires_at = null;
  assert.equal(evaluateExecution(input).next?.state, 'cancelled');
  for (const [key, reason] of [['recovery_generation', 'recovery_generation_mismatch'], ['control_epoch', 'stale_epoch'], ['task_epoch', 'stale_epoch']] as const) {
    const stale = structuredClone(input); stale.assertions[key] = '1'; deny(stale, reason);
  }
});
test('control ACK cannot rewrite terminal states', () => {
  for (const state of ['completed', 'cancelled', 'failed'] as const) {
    const input = vectorInput(executionVectors[17]); input.snapshot.state = state; input.snapshot.desired_control = 'stop'; input.event = { type: 'control_ack', epoch: '2' };
    deny(input, 'terminal_state');
  }
});
test('resume then fresh ACK retains preflight instead of reinstating the old pause request', () => {
  const input = vectorInput(executionVectors[9]), resumed = evaluateExecution(input).next!;
  assert.equal(resumed.desired_control, 'run');
  input.snapshot = structuredClone(resumed); input.expected_version = resumed.version;
  Object.assign(input.assertions, { actor_kind: 'runtime', task_epoch: resumed.task_lease.epoch, control_epoch: resumed.control.epoch });
  input.event = { type: 'control_ack', epoch: resumed.control.epoch };
  assert.equal(evaluateExecution(input).next?.state, 'preflighting');
});
test('ordinary outcome cannot undo pause, Stop or non-running state even with apparently current epochs', () => {
  for (const state of ['paused', 'cancelling', 'reconciling', 'manual_unknown', 'waiting_human'] as const) {
    const input = vectorInput(executionVectors[4]); input.snapshot.state = state; deny(input, 'invalid_transition');
  }
  for (const control of ['pause', 'stop'] as const) { const input = vectorInput(executionVectors[4]); input.snapshot.desired_control = control; deny(input, 'invalid_transition'); }
});
test('wire integers reject fractional/exponent tokens before Number rounding', () => {
  for (const token of ['1.0000000000000001', '0.99999999999999999', '1e0', '1.0', '10000000000000001e-16']) {
    deny(JSON.stringify(base).replace('"attempt_number":1', `"attempt_number":${token}`), 'invalid_input');
  }
});
test('object bounds reject huge strings/arrays and numeric-looking non-index sparse keys before serialization', () => {
  deny({ ...base, profile: 'x'.repeat(EXECUTION_LIMITS.inputBytes + 1) }, 'input_limit');
  deny(new Array(EXECUTION_LIMITS.nodes + 1), 'input_limit');
  const input = vectorInput(executionVectors[0]), array: any = new Array(2);
  array['4294967295'] = binding; array['4294967296'] = binding; input.snapshot.attempts = array;
  deny(input, 'invalid_input');
});
test('generated JSON Schema and authoring validator agree on positive/negative shape vectors', async () => {
  const cases: { value: unknown; valid: boolean }[] = executionVectors.map(v => ({ value: vectorInput(v), valid: true }));
  for (const change of [
    (v: any) => { v.event.prompt = 'forbidden'; }, (v: any) => { v.snapshot.owner.kind = 'machine'; },
    (v: any) => { v.snapshot.attempts[0].attempt_number = 1.2; }, (v: any) => { v.snapshot.run_id = '../invalid'; },
    (v: any) => { v.snapshot.version = '1\n'; }, (v: any) => { v.now = 'not-time'; },
    (v: any) => { v.snapshot.result = { result_id: fixtureId(13), attempt_id: binding.attempt_id, work_version: '8', provenance: 'human' }; },
  ]) { const value = clone(); change(value); cases.push({ value, valid: false }); }
  // Shape decoding deliberately precedes semantic signed-bigint bounds.
  const tooBig = clone(); tooBig.snapshot.version = tooBig.expected_version = '9223372036854775808'; cases.push({ value: tooBig, valid: true });
  deny(tooBig, 'invalid_version');
  for (const c of cases) assert.equal(ExecutionInputSchema.safeParse(c.value).success, c.valid);
  const schema = JSON.parse(await readFile('contracts/execution/v1/decision-input.schema.json', 'utf8'));
  const script = "import json,sys; from jsonschema import Draft202012Validator,FormatChecker; p=json.load(sys.stdin); Draft202012Validator.check_schema(p['schema']); v=Draft202012Validator(p['schema'],format_checker=FormatChecker()); assert all(v.is_valid(c['value']) == c['valid'] for c in p['cases']); print('conformant')";
  const result = spawnSync('python3', ['-c', script], { input: JSON.stringify({ schema, cases }), encoding: 'utf8', env: verificationEnvironment(), timeout: 10000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'conformant');
});
