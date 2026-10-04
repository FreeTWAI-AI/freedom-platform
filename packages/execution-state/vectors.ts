import type { AttemptBinding, ExecutionInput, ExecutionEvent, RunSnapshot } from '../../contracts/execution/v1/state.js';

// Synthetic declarations ONLY. No actual provider/model/custody selection,
// current authentication, approved Grant or observed readiness is asserted.
export const fixtureId = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const binding: AttemptBinding = {
  attempt_id: fixtureId(4), run_id: fixtureId(1), attempt_number: 1, runtime_id: fixtureId(5), connection_id: fixtureId(6),
  grant_id: fixtureId(7), grant_revision: '3', inference_binding_id: fixtureId(8), provider_ref: 'fixture-provider', model_ref: 'fixture-model',
  engine_location: 'runtime_local', processing_location: 'fixture-remote-provider', artifact_custody: 'platform_asset',
  credential_custody: 'official_cli', billing_source: 'user_cli_subscription', data_policy_revision: 'fixture-policy-v1',
  contract_version: 'fixture-contract-v1', adapter_version: 'fixture-adapter-v1',
};
export const base: ExecutionInput = {
  profile: 'freedom.execution.decision/v1', now: '2026-10-02T12:00:00.000Z', expected_version: '1',
  snapshot: { run_id: fixtureId(1), work_id: fixtureId(2), owner: { principal_id: fixtureId(3), kind: 'person' },
    scope: { scope_id: fixtureId(9), kind: 'personal' }, version: '1', work_version: '7', state: 'ready', desired_control: 'run',
    current_attempt_id: fixtureId(4), attempts: [binding], task_lease: { epoch: '2', expires_at: '2026-10-02T12:01:00.000Z' },
    control: { epoch: '2', acknowledged_epoch: '2' }, recovery_generation: '4', dispatches: [], evidence: [], result: null },
  assertions: { actor_kind: 'runtime', principal_id: fixtureId(3), runtime_id: fixtureId(5), connection_id: fixtureId(6),
    owner_active: true, scope_active: true, work_active: true, work_version: '7', connection_active: true, runtime_online: true,
    model_ready: true, budget_available: true, policy_allowed: true, policy_revision: 'fixture-policy-v1', grant_id: fixtureId(7),
    grant_revision: '3', grant_active: true, grant_expires_at: '2026-10-02T12:10:00.000Z', recovery_generation: '4',
    task_epoch: '2', control_epoch: '2', evidence_expires_at: '2026-10-02T12:05:00.000Z' },
  event: { type: 'advance_model', dispatch_id: fixtureId(10), step_id: fixtureId(11), request_digest: 'a'.repeat(64) },
};
export const dispatch = (state: RunSnapshot['dispatches'][number]['state'] = 'in_flight', usage: RunSnapshot['dispatches'][number]['usage'] = 'unknown'): RunSnapshot['dispatches'][number] => ({
  dispatch_id: fixtureId(10), attempt_id: binding.attempt_id, step_id: fixtureId(11), request_digest: 'a'.repeat(64),
  task_epoch: '2', control_epoch: '2', grant_revision: '3', policy_revision: 'fixture-policy-v1', recovery_generation: '4', state, usage,
});
export const evidence = { evidence_id: fixtureId(12), dispatch_id: fixtureId(10), attempt_id: binding.attempt_id,
  evidence_digest: 'b'.repeat(64), observation: 'observed_success' as const, usage_observation: 'known' as const };
export interface ExecutionVector {
  id: string; event: ExecutionEvent; snapshot?: Partial<RunSnapshot>; assertions?: Partial<ExecutionInput['assertions']>;
  admissible: boolean; state?: RunSnapshot['state']; reason?: string;
}
export const executionVectors: readonly ExecutionVector[] = [
  { id: 'EXEC-01 preflight installs an explicit first binding', event: { type: 'preflight', binding }, snapshot: { state: 'created', current_attempt_id: null, attempts: [] }, assertions: { actor_kind: 'owner' }, admissible: true, state: 'preflighting' },
  { id: 'EXEC-02 hypothetical activation renews independent clocks', event: { type: 'activate', expires_at: '2026-10-02T12:01:00.000Z' }, snapshot: { state: 'preflighting' }, admissible: true, state: 'ready' },
  { id: 'EXEC-03 new model step proposes one dispatch', event: base.event, admissible: true, state: 'running' },
  { id: 'EXEC-04 record dispatch consumes the proposed slot', event: { type: 'record_dispatch', dispatch_id: fixtureId(10) }, snapshot: { state: 'running', dispatches: [dispatch('proposed', 'not_dispatched')] }, admissible: true, state: 'running' },
  { id: 'EXEC-05 known outcome does not need a healthy model', event: { type: 'record_outcome', dispatch_id: fixtureId(10), outcome: 'succeeded', usage: 'known' }, snapshot: { state: 'running', dispatches: [dispatch()] }, assertions: { model_ready: false }, admissible: true, state: 'running' },
  { id: 'EXEC-06 ambiguous outcome preserves unknown', event: { type: 'record_outcome', dispatch_id: fixtureId(10), outcome: 'unknown', usage: 'unknown' }, snapshot: { state: 'running', dispatches: [dispatch()] }, admissible: true, state: 'reconciling' },
  { id: 'EXEC-07 wait for human', event: { type: 'wait', reason: 'human' }, admissible: true, state: 'waiting_human' },
  { id: 'EXEC-08 wait for engine does not require model health', event: { type: 'wait', reason: 'engine' }, assertions: { model_ready: false }, admissible: true, state: 'waiting_engine' },
  { id: 'EXEC-09 pause is independent of provider health', event: { type: 'pause' }, assertions: { actor_kind: 'owner', model_ready: false, grant_active: false }, admissible: true, state: 'paused' },
  { id: 'EXEC-10 resume goes through preflight', event: { type: 'resume' }, snapshot: { state: 'paused', desired_control: 'pause' }, assertions: { actor_kind: 'owner', model_ready: false }, admissible: true, state: 'preflighting' },
  { id: 'EXEC-11 offline Stop remains unacknowledged', event: { type: 'stop' }, assertions: { actor_kind: 'owner', model_ready: false, runtime_online: false, grant_active: false }, admissible: true, state: 'cancelling' },
  { id: 'EXEC-12 revoke fences without provider health', event: { type: 'revoke' }, assertions: { actor_kind: 'owner', model_ready: false }, admissible: true, state: 'cancelling' },
  { id: 'EXEC-13 current control ACK may settle a known Stop', event: { type: 'control_ack', epoch: '2' }, snapshot: { state: 'cancelling', desired_control: 'stop', control: { epoch: '2', acknowledged_epoch: null } }, assertions: { model_ready: false }, admissible: true, state: 'cancelled' },
  { id: 'EXEC-14 late evidence cannot resolve unknown or require model', event: { type: 'late_evidence', evidence }, snapshot: { state: 'reconciling', dispatches: [dispatch('unknown')] }, assertions: { actor_kind: 'runtime_evidence', model_ready: false, grant_active: false, task_epoch: '1' }, admissible: true, state: 'reconciling' },
  { id: 'EXEC-15 owner reconciliation requires linked evidence', event: { type: 'reconcile_dispatch', dispatch_id: fixtureId(10), evidence_id: evidence.evidence_id, outcome: 'succeeded', usage: 'known' }, snapshot: { state: 'reconciling', dispatches: [dispatch('unknown')], evidence: [evidence] }, assertions: { actor_kind: 'owner' }, admissible: true, state: 'paused' },
  { id: 'EXEC-16 handoff appends instead of rewriting a binding', event: { type: 'handoff', binding: { ...binding, attempt_id: fixtureId(14), attempt_number: 2, runtime_id: fixtureId(15), model_ref: 'fixture-other-model' } }, assertions: { actor_kind: 'owner' }, admissible: true, state: 'preflighting' },
  { id: 'EXEC-17 publication remains a decision not a Result', event: { type: 'publication_decision', result_id: fixtureId(13), attempt_id: binding.attempt_id, expected_work_version: '7', provenance: 'model_draft' }, snapshot: { state: 'running', dispatches: [dispatch('succeeded', 'known')] }, admissible: true, state: 'running' },
  { id: 'EXEC-18 completion requires a separately asserted durable Result', event: { type: 'complete' }, snapshot: { state: 'running', dispatches: [dispatch('succeeded', 'known')], result: { result_id: fixtureId(13), attempt_id: binding.attempt_id, work_version: '8', provenance: 'model_draft' } }, assertions: { work_version: '8', model_ready: false }, admissible: true, state: 'completed' },
  { id: 'EXEC-19 known failure without effects can settle', event: { type: 'fail' }, assertions: { actor_kind: 'owner' }, admissible: true, state: 'failed' },
  { id: 'EXEC-20 generic failure retains unresolved effects', event: { type: 'fail' }, snapshot: { state: 'running', dispatches: [dispatch('unknown')] }, assertions: { actor_kind: 'owner' }, admissible: true, state: 'reconciling' },
  { id: 'EXEC-21 blocked runtime preserves resume preflight', event: { type: 'block', reason: 'runtime_offline' }, assertions: { actor_kind: 'owner', runtime_online: false }, admissible: true, state: 'blocked' },
  { id: 'EXEC-22 manual unknown is explicitly unresolved', event: { type: 'reconcile_dispatch', dispatch_id: fixtureId(10), evidence_id: evidence.evidence_id, outcome: 'manual_unknown', usage: 'unknown' }, snapshot: { state: 'reconciling', dispatches: [dispatch('unknown')], evidence: [{ ...evidence, observation: 'observed_unknown', usage_observation: 'unknown' }] }, assertions: { actor_kind: 'owner' }, admissible: true, state: 'manual_unknown' },
];
export function vectorInput(vector: ExecutionVector): ExecutionInput {
  return structuredClone({ ...base, event: vector.event, snapshot: { ...base.snapshot, ...vector.snapshot }, assertions: { ...base.assertions, ...vector.assertions } });
}
