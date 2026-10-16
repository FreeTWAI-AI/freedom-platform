// Fixed worker-unit protocol adapter. Disabled by default; no HTTP client or
// credential discovery. Ports belong to an installed trusted controller, never
// to the candidate. This module is not wired into any workflow or CLI.
import { createHash } from 'node:crypto';
import { createLedger, ledgerCommitProposal, proposeRoute, reconcile, LEDGER_REF } from './worker-unit-routing.mjs';

const hex = /^[a-f0-9]{40}$/;
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const fallbackCycle = 'github-fallback-ownership';
const hash = value => createHash('sha256').update(value).digest('hex');
const key = b => `${b.repository}:${b.sourceSha}:${b.suite}`;
const equal = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => a[k] === b[k]);
function check(value) { if (!value) throw new Error('invalid_worker_dispatch_input'); }
const validId = value => typeof value === 'string' && identifier.test(value);
const validSha = value => typeof value === 'string' && hex.test(value);
const clone = value => structuredClone(value);

// Every retained cycle is read under the same ref/atomic update. No archive
// loading or pruning is permitted: at these limits stop and review retention.
export function validateDispatchState(state) {
  check(state && state.version === 1 && Object.keys(state).sort().join() === 'cycles,fallback,version');
  check(Array.isArray(state.cycles) && state.cycles.length > 0 && state.cycles.length <= 12);
  const owners = new Map(); const attempts = new Set(); const cycles = new Set();
  let end = -1;
  for (const l of state.cycles) {
    ledgerCommitProposal('0'.repeat(40), l);
    check(!cycles.has(l.cycle) && l.startsAt >= end); cycles.add(l.cycle); end = l.endsAt;
    for (const e of l.entries) {
      check(!owners.has(key(e.binding)) && !attempts.has(e.binding.attempt));
      owners.set(key(e.binding), e); attempts.add(e.binding.attempt);
    }
  }
  ledgerCommitProposal('0'.repeat(40), state.fallback);
  check(state.fallback.cycle === fallbackCycle && state.fallback.startsAt === 0 && state.fallback.endsAt === Number.MAX_SAFE_INTEGER);
  for (const f of state.fallback.entries) {
    const primary = owners.get(key(f.binding));
    check(primary?.provider === 'circleci' && ['infra_failure', 'not_dispatched'].includes(primary.state) && f.provider === 'github');
    check(equal({ ...primary.binding, attempt: f.binding.attempt }, f.binding) && f.binding.attempt === fallbackAttempt(primary.binding));
    check(!attempts.has(f.binding.attempt)); attempts.add(f.binding.attempt);
  }
  check(attempts.size <= 1000);
}
function fallbackAttempt(b) { return `github-fallback-${hash(JSON.stringify([b.repository, b.sourceSha, b.suite, b.attempt])).slice(0, 40)}`; }
export function createDispatchState(cycles) {
  const state = { version: 1, cycles: clone(cycles), fallback: createLedger({ cycle: fallbackCycle, startsAt: 0, endsAt: Number.MAX_SAFE_INTEGER }) };
  validateDispatchState(state); return state;
}
function locate(state, binding) {
  for (const ledger of [...state.cycles, state.fallback]) {
    const entry = ledger.entries.find(e => equal(e.binding, binding));
    if (entry) return { ledger, entry };
  }
  return null;
}
const outcome = (status, reason) => ({ status, reason, assurance: 'transport-fixture-unverified', mergeAuthorized: false });

export function workerUnitAdapter(ports, { enabled = false, timeoutMs = 5000 } = {}) {
  check(typeof enabled === 'boolean' && Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 30000);
  // One bounded call, no retry. Aborted writes/POSTs may still complete remotely.
  async function call(name, payload, signal) {
    signal?.throwIfAborted();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    const bounded = AbortSignal.any([deadline.signal, ...(signal ? [signal] : [])]);
    let abort;
    try {
      return await Promise.race([
        Promise.resolve().then(() => { bounded.throwIfAborted(); return ports[name](clone(payload), bounded); }),
        new Promise((_, reject) => { abort = () => reject(new Error('worker_transport_unknown')); bounded.addEventListener('abort', abort, { once: true }); })
      ]);
    } finally { clearTimeout(timer); bounded.removeEventListener('abort', abort); }
  }
  async function read(signal) {
    const snapshot = await call('read', { ref: LEDGER_REF }, signal);
    check(validSha(snapshot.head)); validateDispatchState(snapshot.state);
    check(Buffer.byteLength(JSON.stringify(snapshot.state)) <= 2000000);
    return clone(snapshot);
  }
  async function commit(snapshot, state, signal) {
    validateDispatchState(state);
    const bytes = JSON.stringify(state) + '\n';
    const proposal = { ref: LEDGER_REF, path: 'ledger.json', parents: [snapshot.head], force: false, bytes, sha256: hash(bytes) };
    const ack = await call('commit', proposal, signal);
    // The trusted port must confirm THIS immutable commit's ref update. Unknown
    // or rejected writes never confer dispatch ownership, even if later visible.
    return ack?.status === 'committed' && ack.sha256 === proposal.sha256 && validSha(ack.head);
  }
  async function send(entry, signal) {
    let ack;
    try {
      ack = await call('dispatch', { provider: entry.provider, binding: entry.binding, costContract: entry.costContract }, signal);
    } catch { return outcome('hold', 'dispatch_acknowledgement_unknown'); }
    if (!validId(ack?.pipeline)) return outcome('hold', 'dispatch_acknowledgement_unknown');
    // Persist a known pipeline when possible. Losing this second CAS never
    // permits POST retry; observe must resolve by attempt if pipeline is absent.
    try {
      const current = await read(signal);
      const found = locate(current.state, entry.binding);
      if (!found || found.entry.state !== 'dispatch_unknown' || found.entry.pipeline !== null) return outcome('hold', 'reconcile_existing_observation');
      found.entry.pipeline = ack.pipeline;
      return outcome('hold', await commit(current, current.state, signal) ? 'await_terminal_evidence' : 'pipeline_persistence_unknown');
    } catch { return outcome('hold', 'pipeline_persistence_unknown'); }
  }
  return Object.freeze({
    async dispatch(input, signal) {
      if (!enabled) return outcome('disabled', 'no_transport_calls');
      if (input?.request?.fork !== false || input?.request?.event !== 'pull_request') return outcome('github_native', 'unsupported_event_or_fork');
      try {
        const snapshot = await read(signal);
        // All cycles share ownership; a caller's new attempt/cycle cannot evade it.
        if (snapshot.state.cycles.some(l => l.entries.some(e => key(e.binding) === key(input.request.binding)))) return outcome('hold', 'already_owned');
        const ledger = snapshot.state.cycles.find(l => l.cycle === input.cycle);
        if (!ledger) return outcome('hold', 'cycle_unavailable');
        if (snapshot.state.cycles.some(l => l.endsAt <= ledger.startsAt && l.entries.some(e => e.provider === 'circleci' && ['dispatch_unknown', 'running'].includes(e.state)))) return outcome('hold', 'previous_cycle_unreconciled');
        const proposal = proposeRoute({ ...input, ledger });
        if (!['reserve_proposal', 'github_proposal'].includes(proposal.action)) return outcome('hold', proposal.reason);
        const index = snapshot.state.cycles.indexOf(ledger);
        snapshot.state.cycles[index] = proposal.ledger;
        if (!await commit(snapshot, snapshot.state, signal)) return outcome('hold', 'reservation_not_acknowledged');
        return await send(proposal.ledger.entries.at(-1), signal);
      } catch { return outcome('hold', 'reservation_or_transport_unavailable'); }
    },
    async reconcile(binding, signal) {
      if (!enabled) return outcome('disabled', 'no_transport_calls');
      try {
        const snapshot = await read(signal);
        const found = locate(snapshot.state, binding);
        if (!found) return outcome('hold', 'binding_not_owned');
        if (!['dispatch_unknown', 'running'].includes(found.entry.state)) return outcome('existing', found.entry.state);
        // observe is an authenticated controller port, never candidate JSON.
        const observation = await call('observe', { provider: found.entry.provider, binding, costContract: found.entry.costContract, pipeline: found.entry.pipeline, job: found.entry.job }, signal);
        if (observation?.state === 'unknown') return outcome('hold', 'remote_outcome_unknown');
        check(equal(observation.binding, binding));
        const updated = reconcile(found.ledger, observation);
        if (found.ledger === snapshot.state.fallback) snapshot.state.fallback = updated;
        else snapshot.state.cycles[snapshot.state.cycles.indexOf(found.ledger)] = updated;
        if (!await commit(snapshot, snapshot.state, signal)) return outcome('hold', 'reconciliation_not_acknowledged');
        return outcome('reconciled', updated.entries.find(e => equal(e.binding, binding)).state);
      } catch { return outcome('hold', 'evidence_or_transport_unavailable'); }
    },
    async fallback(binding, signal) {
      if (!enabled) return outcome('disabled', 'no_transport_calls');
      try {
        const snapshot = await read(signal);
        const found = locate(snapshot.state, binding);
        if (!found || found.ledger === snapshot.state.fallback || found.entry.provider !== 'circleci' ||
            !['infra_failure', 'not_dispatched'].includes(found.entry.state)) return outcome('hold', 'fallback_not_eligible');
        if (snapshot.state.fallback.entries.some(e => key(e.binding) === key(binding))) return outcome('hold', 'fallback_already_owned');
        const request = { binding: { ...binding, attempt: fallbackAttempt(binding) }, event: 'pull_request', fork: false };
        const proposal = proposeRoute({ ledger: snapshot.state.fallback, request, now: 0 });
        if (proposal.action !== 'github_proposal') return outcome('hold', 'fallback_not_eligible');
        snapshot.state.fallback = proposal.ledger;
        if (!await commit(snapshot, snapshot.state, signal)) return outcome('hold', 'fallback_reservation_not_acknowledged');
        return await send(proposal.ledger.entries.at(-1), signal);
      } catch { return outcome('hold', 'fallback_or_transport_unavailable'); }
    }
  });
}
