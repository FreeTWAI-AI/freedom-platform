import type { AttemptBinding, ExecutionInput, RunSnapshot } from '../../contracts/execution/v1/state.js';
import { EXECUTION_LIMITS, ExecutionInputError, freezeTree, parseExecutionInput } from './decode.js';
export { decodeExecutionInput, EXECUTION_LIMITS, ExecutionInputError } from './decode.js';

export interface ExecutionDecision {
  readonly assurance: 'hypothetical_decision_only'; readonly operational_authority: false;
  readonly admissible: boolean; readonly reason: string; readonly next?: RunSnapshot;
  readonly publication_requires_authenticated_atomic_adapter?: true;
}
const disclaimer = { assurance: 'hypothetical_decision_only' as const, operational_authority: false as const };
export function executionActivationStatus() {
  return Object.freeze({ ...disclaimer, status: 'unavailable' as const, reason: 'authenticated_execution_adapter_not_implemented' as const });
}
class Denied extends Error { constructor(readonly reason: string) { super(reason); } }
const requireFact = (condition: unknown, reason: string): void => { if (!condition) throw new Denied(reason); };
const maxVersion = 9223372036854775807n;
const increment = (value: string) => { requireFact(BigInt(value) < maxVersion, 'version_exhausted'); return String(BigInt(value) + 1n); };
const terminal = new Set(['completed', 'cancelled', 'failed']);
const unresolved = (s: RunSnapshot) => s.dispatches.some(d => ['in_flight', 'unknown', 'manual_unknown'].includes(d.state) || d.usage === 'unknown');
const unsettled = (s: RunSnapshot) => unresolved(s) || s.dispatches.some(d => d.state === 'proposed');

function consistent(input: ExecutionInput): void {
  const s = input.snapshot;
  const versionKeys = new Set(['version', 'work_version', 'expected_version', 'expected_work_version', 'epoch', 'acknowledged_epoch', 'task_epoch', 'control_epoch', 'grant_revision', 'recovery_generation']);
  function versions(value: unknown) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (versionKeys.has(key) && child !== null) requireFact(typeof child === 'string' && BigInt(child) <= maxVersion, 'invalid_version');
      versions(child);
    }
  }
  versions(input);
  requireFact(new Set(s.attempts.map(a => a.attempt_id)).size === s.attempts.length, 'invalid_attempt_history');
  s.attempts.forEach((a, i) => requireFact(a.run_id === s.run_id && a.attempt_number === i + 1, 'invalid_attempt_history'));
  requireFact(s.current_attempt_id === null ? ['created', 'paused', 'blocked', 'cancelled', 'failed'].includes(s.state) && s.attempts.length === 0
    : s.attempts.at(-1)?.attempt_id === s.current_attempt_id, 'invalid_current_attempt');
  requireFact(new Set(s.dispatches.map(d => d.dispatch_id)).size === s.dispatches.length
    && new Set(s.dispatches.map(d => d.step_id)).size === s.dispatches.length, 'duplicate_dispatch');
  for (const d of s.dispatches) {
    const attempt = s.attempts.find(a => a.attempt_id === d.attempt_id);
    requireFact(attempt && attempt.grant_revision === d.grant_revision && attempt.data_policy_revision === d.policy_revision, 'invalid_dispatch_binding');
    requireFact(BigInt(d.task_epoch) <= BigInt(s.task_lease.epoch) && BigInt(d.control_epoch) <= BigInt(s.control.epoch), 'invalid_dispatch_epoch');
    requireFact(['proposed', 'cancelled_before_dispatch'].includes(d.state) ? d.usage === 'not_dispatched' : d.usage !== 'not_dispatched', 'invalid_usage');
  }
  requireFact(new Set(s.evidence.map(e => e.evidence_id)).size === s.evidence.length, 'duplicate_evidence');
  for (const evidence of s.evidence) requireFact(s.dispatches.some(d => d.dispatch_id === evidence.dispatch_id && d.attempt_id === evidence.attempt_id
    && !['proposed', 'cancelled_before_dispatch'].includes(d.state)), 'evidence_without_dispatch');
  if (s.result) requireFact(s.attempts.some(a => a.attempt_id === s.result!.attempt_id), 'invalid_result_binding');
  if (terminal.has(s.state)) requireFact(!unsettled(s), 'unresolved_terminal_state');
  if (s.state === 'completed') requireFact(s.result !== null, 'result_required');
}

/** Evaluates declared facts ONLY. No authentication, durability, lock, clock
 * source, signing, model health observation or external effect is performed.
 * Never use admissible/next as an authorization object or execution permit. */
export function evaluateExecution(raw: unknown): ExecutionDecision {
  try {
    const input = parseExecutionInput(raw); consistent(input);
    const s = input.snapshot, a = input.assertions, event = input.event, now = Date.parse(input.now);
    requireFact(input.expected_version === s.version, 'version_conflict');
    requireFact(a.principal_id === s.owner.principal_id && a.owner_active && a.scope_active, 'owner_scope_unavailable');
    const current = () => {
      const attempt = s.attempts.find(v => v.attempt_id === s.current_attempt_id);
      requireFact(attempt, 'attempt_required'); return attempt!;
    };
    const owner = () => requireFact(a.actor_kind === 'owner', 'owner_required');
    const runtime = (attempt = current(), evidence = false) => requireFact(a.actor_kind === (evidence ? 'runtime_evidence' : 'runtime')
      && a.runtime_id === attempt.runtime_id && a.connection_id === attempt.connection_id && a.connection_active, 'runtime_binding_unavailable');
    const fresh = (lease = true, model = false) => {
      const attempt = current(); runtime(attempt);
      requireFact(a.work_active, 'work_unavailable');
      requireFact(a.runtime_online, 'runtime_offline');
      requireFact(a.grant_active && a.grant_id === attempt.grant_id && a.grant_revision === attempt.grant_revision
        && Date.parse(a.grant_expires_at) > now, 'grant_unavailable');
      requireFact(a.policy_allowed && a.policy_revision === attempt.data_policy_revision, 'policy_unavailable');
      requireFact(a.recovery_generation === s.recovery_generation, 'recovery_generation_mismatch');
      requireFact(a.task_epoch === s.task_lease.epoch && a.control_epoch === s.control.epoch, 'stale_epoch');
      if (lease) requireFact(s.task_lease.expires_at !== null && Date.parse(s.task_lease.expires_at) > now, 'lease_expired');
      if (model) { requireFact(a.model_ready, 'model_unavailable'); requireFact(a.budget_available, 'budget_unavailable'); }
      return attempt;
    };
    const nonterminal = () => requireFact(!terminal.has(s.state), 'terminal_state');
    const fence = () => {
      s.task_lease = { epoch: increment(s.task_lease.epoch), expires_at: null };
      s.control = { epoch: increment(s.control.epoch), acknowledged_epoch: null };
      for (const d of s.dispatches) if (d.state === 'proposed') d.state = 'cancelled_before_dispatch';
    };
    const bind = (binding: AttemptBinding) => {
      requireFact(binding.run_id === s.run_id, 'attempt_run_mismatch');
      const prior = s.attempts.find(v => v.attempt_id === binding.attempt_id);
      if (prior) { requireFact(JSON.stringify(prior) === JSON.stringify(binding) && prior.attempt_id === s.current_attempt_id, 'immutable_attempt_binding'); return; }
      requireFact(s.attempts.length < EXECUTION_LIMITS.attempts, 'prototype_history_limit');
      requireFact(binding.attempt_number === s.attempts.length + 1, 'attempt_number_conflict');
      s.attempts.push(binding); s.current_attempt_id = binding.attempt_id;
    };
    const dispatch = (id: string) => { const d = s.dispatches.find(v => v.dispatch_id === id); requireFact(d, 'dispatch_not_found'); return d!; };
    const settleControl = () => {
      if (s.current_attempt_id === null) s.control.acknowledged_epoch = s.control.epoch;
      if (s.desired_control === 'stop') s.state = !unsettled(s) && s.control.acknowledged_epoch === s.control.epoch ? 'cancelled' : 'cancelling';
      else if (s.desired_control === 'pause') s.state = unresolved(s) ? 'reconciling' : 'paused';
    };
    let publication = false;
    switch (event.type) {
      case 'preflight':
        owner(); requireFact(['created', 'blocked', 'preflighting'].includes(s.state), 'invalid_transition');
        requireFact(!unsettled(s), 'reconciliation_required');
        requireFact(s.current_attempt_id === null || event.binding.attempt_id === s.current_attempt_id, 'handoff_required');
        bind(event.binding); s.desired_control = 'run'; s.state = 'preflighting'; break;
      case 'activate':
        requireFact(s.state === 'preflighting', 'invalid_transition'); fresh(false, true);
        requireFact(!unsettled(s), 'reconciliation_required'); requireFact(Date.parse(event.expires_at) > now
          && Date.parse(event.expires_at) <= Date.parse(a.grant_expires_at), 'invalid_lease_deadline');
        s.task_lease = { epoch: increment(s.task_lease.epoch), expires_at: event.expires_at };
        s.control = { epoch: increment(s.control.epoch), acknowledged_epoch: null }; s.desired_control = 'run'; s.state = 'ready'; break;
      case 'advance_model': {
        requireFact(['ready', 'running'].includes(s.state) && s.desired_control === 'run', 'invalid_transition'); const attempt = fresh(true, true);
        requireFact(!unsettled(s), 'reconciliation_required');
        requireFact(s.dispatches.length < EXECUTION_LIMITS.dispatches, 'prototype_history_limit');
        requireFact(!s.dispatches.some(d => d.dispatch_id === event.dispatch_id || d.step_id === event.step_id), 'duplicate_dispatch');
        s.dispatches.push({ dispatch_id: event.dispatch_id, attempt_id: attempt.attempt_id, step_id: event.step_id, request_digest: event.request_digest,
          task_epoch: s.task_lease.epoch, control_epoch: s.control.epoch, grant_revision: attempt.grant_revision, policy_revision: attempt.data_policy_revision,
          recovery_generation: s.recovery_generation, state: 'proposed', usage: 'not_dispatched' }); s.state = 'running'; break;
      }
      case 'record_dispatch': {
        requireFact(s.state === 'running' && s.desired_control === 'run', 'invalid_transition'); fresh(true, true); const d = dispatch(event.dispatch_id);
        requireFact(d.attempt_id === s.current_attempt_id && d.state === 'proposed' && d.task_epoch === s.task_lease.epoch
          && d.control_epoch === s.control.epoch && d.recovery_generation === s.recovery_generation
          && s.control.acknowledged_epoch === s.control.epoch, 'dispatch_fenced');
        d.state = 'in_flight'; d.usage = 'unknown'; break;
      }
      case 'record_outcome': {
        requireFact(s.state === 'running' && s.desired_control === 'run', 'invalid_transition');
        fresh(); const d = dispatch(event.dispatch_id);
        requireFact(d.attempt_id === s.current_attempt_id && d.state === 'in_flight' && d.task_epoch === s.task_lease.epoch
          && d.control_epoch === s.control.epoch && d.recovery_generation === s.recovery_generation, 'dispatch_fenced');
        d.state = event.outcome; d.usage = event.usage; s.state = unresolved(s) ? 'reconciling' : 'running'; break;
      }
      case 'wait': fresh(); requireFact(['ready', 'running'].includes(s.state), 'invalid_transition');
        s.state = unresolved(s) ? 'reconciling' : event.reason === 'human' ? 'waiting_human' : 'waiting_engine'; break;
      case 'block':
        if (a.actor_kind === 'owner') owner(); else runtime(); nonterminal(); fence();
        s.desired_control = 'pause'; s.state = unresolved(s) ? 'reconciling' : 'blocked'; break;
      case 'pause': owner(); nonterminal(); fence(); s.desired_control = 'pause'; settleControl(); break;
      case 'stop': case 'revoke': owner(); nonterminal(); fence(); s.desired_control = 'stop'; settleControl(); break;
      case 'resume':
        owner(); requireFact(['paused', 'waiting_human', 'waiting_engine', 'blocked'].includes(s.state), 'invalid_transition');
        requireFact(!unsettled(s), 'reconciliation_required'); fence(); s.desired_control = 'run'; s.state = s.current_attempt_id ? 'preflighting' : 'created'; break;
      case 'control_ack':
        nonterminal();
        runtime(); requireFact(event.epoch === s.control.epoch && a.runtime_online, 'stale_control_ack');
        requireFact(a.recovery_generation === s.recovery_generation, 'recovery_generation_mismatch');
        requireFact(a.control_epoch === s.control.epoch && a.task_epoch === s.task_lease.epoch, 'stale_epoch');
        s.control.acknowledged_epoch = event.epoch; settleControl(); break;
      case 'late_evidence': {
        const d = dispatch(event.evidence.dispatch_id), attempt = s.attempts.find(v => v.attempt_id === d.attempt_id)!;
        if (a.actor_kind === 'owner') owner(); else { runtime(attempt, true); requireFact(a.evidence_expires_at !== null && Date.parse(a.evidence_expires_at) > now, 'evidence_window_expired'); }
        requireFact(event.evidence.attempt_id === d.attempt_id && !['proposed', 'cancelled_before_dispatch'].includes(d.state), 'evidence_without_dispatch');
        const old = s.evidence.find(v => v.evidence_id === event.evidence.evidence_id);
        if (old) requireFact(JSON.stringify(old) === JSON.stringify(event.evidence), 'evidence_conflict');
        else { requireFact(s.evidence.length < EXECUTION_LIMITS.evidence, 'prototype_history_limit'); s.evidence.push(event.evidence); }
        break; // Observations NEVER resolve a dispatch, change control or attach Result.
      }
      case 'reconcile_dispatch': {
        owner(); nonterminal(); const d = dispatch(event.dispatch_id);
        requireFact(['in_flight', 'unknown', 'manual_unknown'].includes(d.state) || d.usage === 'unknown', 'reconciliation_not_required');
        const evidence = s.evidence.find(v => v.evidence_id === event.evidence_id && v.dispatch_id === d.dispatch_id);
        const observed = event.outcome === 'succeeded' ? 'observed_success' : event.outcome === 'failed_known' ? 'observed_failure' : 'observed_unknown';
        requireFact(evidence?.observation === observed, 'reconciliation_evidence_required');
        requireFact(event.usage === 'unknown' || evidence?.usage_observation === 'known', 'usage_evidence_required');
        d.state = event.outcome; d.usage = event.usage;
        s.state = unresolved(s) ? event.outcome === 'manual_unknown' ? 'manual_unknown' : 'reconciling' : 'paused';
        if (!unresolved(s)) { s.desired_control = s.desired_control === 'stop' ? 'stop' : 'pause'; settleControl(); } break;
      }
      case 'handoff':
        owner(); nonterminal(); requireFact(!unsettled(s), 'reconciliation_required');
        requireFact(event.binding.attempt_id !== s.current_attempt_id, 'new_attempt_required'); fence(); bind(event.binding); s.desired_control = 'run'; s.state = 'preflighting'; break;
      case 'publication_decision':
        requireFact(s.state === 'running' && s.desired_control === 'run', 'invalid_transition'); fresh();
        requireFact(event.attempt_id === s.current_attempt_id && !unsettled(s), 'reconciliation_required');
        requireFact(a.work_version === event.expected_work_version && s.work_version === event.expected_work_version, 'work_version_conflict');
        requireFact(s.dispatches.some(d => d.attempt_id === event.attempt_id && d.state === 'succeeded'), 'successful_step_required');
        publication = true; break; // Does NOT persist/attach a Result or assert its provenance.
      case 'complete':
        fresh(); requireFact(s.state === 'running' && s.desired_control === 'run', 'invalid_transition');
        requireFact(!unsettled(s), 'reconciliation_required'); requireFact(s.result?.attempt_id === s.current_attempt_id
          && s.result.work_version === a.work_version, 'durable_result_assertion_required');
        requireFact(s.dispatches.some(d => d.attempt_id === s.current_attempt_id && d.state === 'succeeded'), 'successful_step_required');
        s.state = 'completed'; break;
      case 'fail':
        if (a.actor_kind === 'owner') owner(); else fresh(); nonterminal(); fence(); s.desired_control = 'stop';
        s.state = unresolved(s) ? 'reconciling' : 'failed'; break;
    }
    if (!publication) s.version = increment(s.version);
    consistent(input);
    return freezeTree({ ...disclaimer, admissible: true, reason: publication ? 'hypothetical_publication_only' : 'hypothetical_transition_only', next: s,
      ...(publication ? { publication_requires_authenticated_atomic_adapter: true as const } : {}) });
  } catch (error) {
    const reason = error instanceof Denied ? error.reason : error instanceof ExecutionInputError ? error.code : 'invalid_input';
    return Object.freeze({ ...disclaimer, admissible: false, reason });
  }
}
