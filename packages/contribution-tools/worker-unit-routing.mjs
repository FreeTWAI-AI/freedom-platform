// Offline proposal model only. No credentials, network, dispatch or check publisher.
// Inputs must eventually come from an independently installed trusted controller.
import { createHash } from 'node:crypto';

export const LIMITS = Object.freeze({ admissionCredits: 300000, headroomCredits: 100000, entries: 1000 });
export const LEDGER_REF = 'refs/heads/ci-worker-unit-ledger';
const sha = /^[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;
const id = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const states = ['dispatch_unknown', 'running', 'passed', 'failed', 'infra_failure', 'cancelled', 'not_dispatched'];
function matches(pattern, value) { return typeof value === 'string' && pattern.test(value); }
function requireValue(ok) { if (!ok) throw new Error('invalid_worker_routing_input'); }
function integer(n, min = 0) { return Number.isSafeInteger(n) && n >= min; }
function exact(o, keys) {
  requireValue(o && Object.getPrototypeOf(o) === Object.prototype &&
    Object.keys(o).sort().join() === [...keys].sort().join());
}
function binding(b) {
  exact(b, ['repository', 'sourceSha', 'runnerSha', 'suite', 'suiteDigest', 'attempt']);
  requireValue(b.repository === 'FreeTWAI/freedom-platform' && b.suite === 'ci.worker-unit' &&
    matches(sha, b.sourceSha) && matches(sha, b.runnerSha) && matches(digest, b.suiteDigest) && matches(id, b.attempt));
}
function key(b) { return `${b.repository}:${b.sourceSha}:${b.suite}`; }
function same(a, b) { return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => a[k] === b[k]); }
function validatePolicy(policy) {
  exact(policy, ['runnerSha', 'suiteDigest', 'configSha', 'resourceClass', 'maxJobCredits', 'maxJobSeconds', 'costProof']);
  requireValue(matches(sha, policy.configSha) && matches(sha, policy.runnerSha) && matches(digest, policy.suiteDigest) && matches(id, policy.resourceClass) &&
    integer(policy.maxJobCredits, 1) && policy.maxJobCredits <= LIMITS.admissionCredits &&
    integer(policy.maxJobSeconds, 1) && matches(digest, policy.costProof));
}
function validateLedger(l) {
  exact(l, ['version', 'cycle', 'startsAt', 'endsAt', 'entries']);
  requireValue(l.version === 1 && matches(id, l.cycle) && integer(l.startsAt) && integer(l.endsAt) && l.startsAt < l.endsAt &&
    Array.isArray(l.entries) && l.entries.length <= LIMITS.entries);
  const keys = new Set(); const attempts = new Set();
  for (const e of l.entries) {
    exact(e, ['binding', 'provider', 'reservedCredits', 'state', 'pipeline', 'job', 'evidence', 'costContract', 'quotaEvidence']);
    binding(e.binding);
    requireValue(!keys.has(key(e.binding)) && !attempts.has(e.binding.attempt));
    keys.add(key(e.binding)); attempts.add(e.binding.attempt);
    requireValue(['github', 'circleci'].includes(e.provider) && integer(e.reservedCredits) && states.includes(e.state) &&
      (e.pipeline === null || matches(id, e.pipeline)) && (e.job === null || matches(id, e.job)) && (e.evidence === null || matches(digest, e.evidence)));
    if (e.provider === 'circleci') {
      validatePolicy(e.costContract);
      requireValue(e.costContract.maxJobCredits === e.reservedCredits && matches(digest, e.quotaEvidence) &&
        e.costContract.runnerSha === e.binding.runnerSha && e.costContract.suiteDigest === e.binding.suiteDigest);

    } else requireValue(e.reservedCredits === 0 && e.costContract === null && e.quotaEvidence === null);
    if (e.state === 'dispatch_unknown') requireValue(e.job === null && e.evidence === null);
    else requireValue(matches(digest, e.evidence) && (e.state === 'not_dispatched' ? e.pipeline === null && e.job === null : matches(id, e.pipeline) && matches(id, e.job)));
  }
  requireValue(l.entries.reduce((n, e) => n + e.reservedCredits, 0) <= LIMITS.admissionCredits);
}
export function createLedger({ cycle, startsAt, endsAt }) {
  const l = { version: 1, cycle, startsAt, endsAt, entries: [] };
  validateLedger(l); return l;
}
function result(action, reason, ledger) {
  return { action, reason, ledger, assurance: 'offline-proposal', executionAuthorized: false };
}

// enabled defaults false. Even true only calculates a proposal; it never sends it.
// quota is a controller-owned conservative remaining-credit lower bound BEFORE
// all entries in this ledger. It must not come from delayed Insights/Usage totals.
export function proposeRoute({ ledger, request, now, enabled = false, policy = null, quota = null, providerHealthy = false }) {
  validateLedger(ledger); binding(request.binding);
  exact(request, ['binding', 'event', 'fork']);
  requireValue(integer(now) && typeof enabled === 'boolean' && typeof request.fork === 'boolean');
  const old = ledger.entries.find(e => key(e.binding) === key(request.binding));
  if (old) {
    // Disabling, a cycle change or a new attempt never frees an uncertain dispatch.
    if (!same(old.binding, request.binding)) return result('hold', 'binding_already_reserved', ledger);
    if (old.provider === 'github') return result('existing', 'github_already_selected', ledger);
    if (['dispatch_unknown', 'running'].includes(old.state)) return result('hold', 'reconcile_before_any_execution', ledger);
    if (['infra_failure', 'not_dispatched'].includes(old.state)) return result('fallback_proposal', 'reconciled_infrastructure', ledger);
    return result('existing', old.state, ledger);
  }
  if (ledger.entries.some(e => e.binding.attempt === request.binding.attempt)) return result('hold', 'attempt_reused', ledger);
  if (ledger.entries.length === LIMITS.entries) return result('hold', 'ledger_full', ledger);
  let reason = 'disabled';
  if (enabled && request.event === 'pull_request' && !request.fork) {
    reason = 'policy_unavailable';
    if (policy) {
      validatePolicy(policy);
      reason = 'unreviewed_binding';
      if (policy.runnerSha === request.binding.runnerSha && policy.suiteDigest === request.binding.suiteDigest) {
        reason = 'provider_outage';
        if (providerHealthy === true) {
          reason = 'quota_unknown_or_expired';
          if (quota) {
            exact(quota, ['cycle', 'remainingLowerBound', 'validUntil', 'evidence']);
            requireValue(matches(id, quota.cycle) && integer(quota.remainingLowerBound) && integer(quota.validUntil) && matches(digest, quota.evidence));
            if (quota.cycle === ledger.cycle && now >= ledger.startsAt && now < ledger.endsAt && now < quota.validUntil &&
                now + policy.maxJobSeconds * 1000 < ledger.endsAt) {
              const reserved = ledger.entries.reduce((n, e) => n + e.reservedCredits, 0);
              reason = 'budget_exhausted';
              if (reserved + policy.maxJobCredits <= LIMITS.admissionCredits &&
                  reserved + policy.maxJobCredits + LIMITS.headroomCredits <= quota.remainingLowerBound) {
                const next = structuredClone(ledger);
                next.entries.push({ binding: { ...request.binding }, provider: 'circleci', reservedCredits: policy.maxJobCredits,
                  state: 'dispatch_unknown', pipeline: null, job: null, evidence: null, costContract: { ...policy }, quotaEvidence: quota.evidence });
                return result('reserve_proposal', 'persist_before_dispatch', next);
              }
            }
          }
        }
      }
    }
  } else if (enabled) reason = 'unsupported_event_or_fork';
  const next = structuredClone(ledger);
  next.entries.push({ binding: { ...request.binding }, provider: 'github', reservedCredits: 0,
    state: 'dispatch_unknown', pipeline: null, job: null, evidence: null, costContract: null, quotaEvidence: null });
  return result('github_proposal', reason, next);
}

// Authenticated observation adapter is deliberately NOT implemented. A matching
// JSON object/digest is not authentication. Never pass candidate artifacts here.
export function reconcile(ledger, observation) {
  validateLedger(ledger);
  exact(observation, ['binding', 'pipeline', 'job', 'state', 'evidence', 'complete', 'testCount', 'failed', 'skipped', 'cancelled']);
  binding(observation.binding);
  requireValue((observation.job === null || matches(id, observation.job)) && (observation.pipeline === null || matches(id, observation.pipeline)) && matches(digest, observation.evidence) &&
    ['running', 'passed', 'test_failure', 'suite_timeout', 'incomplete', 'infra_failure', 'cancelled', 'not_dispatched'].includes(observation.state) &&
    typeof observation.complete === 'boolean' && ['testCount', 'failed', 'skipped', 'cancelled'].every(k => integer(observation[k])));
  const next = structuredClone(ledger);
  const e = next.entries.find(e => same(e.binding, observation.binding));
  requireValue(e && ['dispatch_unknown', 'running'].includes(e.state));
  requireValue(e.pipeline === null || e.pipeline === observation.pipeline);
  requireValue(e.job === null || e.job === observation.job);
  requireValue(observation.state === 'not_dispatched' ? e.pipeline === null && observation.pipeline === null && observation.job === null : observation.pipeline !== null && observation.job !== null);
  if (observation.state === 'not_dispatched') requireValue(!observation.complete && observation.testCount === 0 && observation.failed === 0 && observation.skipped === 0 && observation.cancelled === 0);
  // Actual assertion failures override every purported infrastructure outcome.
  let state = observation.state;
  if (observation.failed > 0 || observation.skipped > 0 || observation.cancelled > 0 ||
      (state === 'infra_failure' && observation.testCount > 0 && !observation.complete) || ['test_failure', 'suite_timeout', 'incomplete'].includes(state) ||
      (state === 'passed' && (!observation.complete || observation.testCount === 0 || observation.skipped > 0 || observation.cancelled > 0))) state = 'failed';
  e.state = state; e.pipeline = observation.pipeline; e.job = observation.job; e.evidence = observation.evidence;
  // Keep the full reservation even after terminal outcomes. No billing settlement,
  // timer expiry, cancellation or process restart recovers credits in this model.
  validateLedger(next);
  return next;
}

// Data-only plan for the future dedicated operational-ref adapter. Sole parent
// plus force:false makes competing sibling commits mutually exclusive. A lost
// PATCH acknowledgement is unknown, NOT a failed CAS and NOT dispatch authority.
export function ledgerCommitProposal(observedHead, ledger) {
  requireValue(matches(sha, observedHead)); validateLedger(ledger);
  const bytes = JSON.stringify(ledger) + '\n';
  return { ref: LEDGER_REF, path: 'ledger.json', bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    parents: [observedHead], force: false, executionAuthorized: false };
}
