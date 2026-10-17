import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createLedger, proposeRoute, reconcile, ledgerCommitProposal, LIMITS, LEDGER_REF } from '../worker-unit-routing.mjs';

const h = n => n.toString(16).padStart(40, '0');
const d = 'a'.repeat(64);
const binding = { repository: 'FreeTWAI/freedom-platform', sourceSha: h(1), runnerSha: h(2), suite: 'ci.worker-unit', suiteDigest: d, attempt: 'attempt-1' };
const policy = { runnerSha: h(2), suiteDigest: d, configSha: h(3), resourceClass: 'large', maxJobCredits: 1000, maxJobSeconds: 1200, costProof: d };
function input() {
  return { ledger: createLedger({ cycle: 'fixture-cycle', startsAt: 0, endsAt: 10000000 }),
    request: { binding: { ...binding }, event: 'pull_request', fork: false }, now: 1000,
    enabled: true, policy: { ...policy }, providerHealthy: true,
    quota: { cycle: 'fixture-cycle', remainingLowerBound: 400000, validUntil: 10000000, evidence: d } };
}
function observation(state, extra = {}) {
  return { binding: { ...binding }, pipeline: 'pipeline-1', job: 'job-1', state, evidence: d, complete: true,
    testCount: 109, failed: 0, skipped: 0, cancelled: 0, ...extra };
}

test('default disabled selects GitHub and never authorizes execution', () => {
  const i = input(); delete i.enabled;
  const r = proposeRoute(i);
  assert.equal(r.action, 'github_proposal'); assert.equal(r.reason, 'disabled');
  assert.equal(r.executionAuthorized, false); assert.equal(r.ledger.entries[0].reservedCredits, 0);
  assert.equal(i.ledger.entries.length, 0);
});
test('eligible proposal reserves whole-job maximum and unknown state before any POST', () => {
  const r = proposeRoute(input());
  assert.equal(r.action, 'reserve_proposal'); assert.equal(r.executionAuthorized, false);
  assert.equal(r.ledger.entries[0].state, 'dispatch_unknown');
  assert.deepEqual(r.ledger.entries[0].costContract, policy);
  assert.equal(r.ledger.entries[0].reservedCredits, 1000);
});
for (const [name, mutate, reason] of [
  ['unknown quota', i => { i.quota = null; }, 'quota_unknown_or_expired'],
  ['expired quota', i => { i.quota.validUntil = i.now; }, 'quota_unknown_or_expired'],
  ['wrong cycle', i => { i.quota.cycle = 'old-cycle'; }, 'quota_unknown_or_expired'],
  ['cycle boundary', i => { i.now = i.ledger.endsAt - 100; }, 'quota_unknown_or_expired'],
  ['exhausted quota', i => { i.quota.remainingLowerBound = 100999; }, 'budget_exhausted'],
  ['outage', i => { i.providerHealthy = false; }, 'provider_outage'],
  ['fork', i => { i.request.fork = true; }, 'unsupported_event_or_fork'],
  ['merge group', i => { i.request.event = 'merge_group'; }, 'unsupported_event_or_fork'],
  ['wrong runner', i => { i.request.binding.runnerSha = h(3); }, 'unreviewed_binding'],
  ['wrong suite digest', i => { i.request.binding.suiteDigest = 'b'.repeat(64); }, 'unreviewed_binding'],
]) test(name + ' stays on GitHub before dispatch', () => {
  const i = input(); mutate(i); const r = proposeRoute(i);
  assert.equal(r.action, 'github_proposal'); assert.equal(r.reason, reason);
});
test('300k cap, 100k headroom and outstanding reservations are additive', () => {
  const i = input(); i.policy.maxJobCredits = 150000;
  i.ledger = proposeRoute(i).ledger;
  i.request.binding = { ...binding, sourceSha: h(3), attempt: 'attempt-2' };
  i.ledger = proposeRoute(i).ledger;
  assert.equal(i.ledger.entries.length, 2);
  i.request.binding = { ...binding, sourceSha: h(4), attempt: 'attempt-3' };
  assert.equal(proposeRoute(i).reason, 'budget_exhausted');
  assert.equal(LIMITS.headroomCredits, 100000);
});
test('unknown acknowledgement survives disabled flag, outage, expiry, changed attempt and new cycle claim', () => {
  const i = input(); i.ledger = proposeRoute(i).ledger;
  i.enabled = false; i.providerHealthy = false; i.quota = null; i.now = 20000000;
  assert.equal(proposeRoute(i).action, 'hold');
  i.request.binding.attempt = 'retry';
  assert.equal(proposeRoute(i).reason, 'binding_already_reserved');
  assert.equal(i.ledger.entries[0].reservedCredits, 1000);
});
test('GitHub selection cannot switch provider on replay', () => {
  const i = input(); i.ledger = proposeRoute({ ...i, enabled: false }).ledger;
  assert.equal(proposeRoute(i).reason, 'github_already_selected');
});
test('running acknowledgement is bound to pipeline, source, runner, suite and attempt', () => {
  const l = proposeRoute(input()).ledger;
  for (const change of [{ sourceSha: h(5) }, { runnerSha: h(5) }, { suiteDigest: 'b'.repeat(64) }, { attempt: 'stale' }]) {
    assert.throws(() => reconcile(l, observation('passed', { binding: { ...binding, ...change } })));
  }
  const running = reconcile(l, observation('running'));
  assert.throws(() => reconcile(running, observation('passed', { pipeline: 'stale-pipeline' })));
  assert.throws(() => reconcile(running, observation('passed', { job: 'stale-job' })));
  assert.equal(proposeRoute({ ...input(), ledger: running }).action, 'hold');
});
for (const [state, extra] of [
  ['test_failure', {}], ['suite_timeout', {}], ['incomplete', {}],
  ['passed', { complete: false }], ['passed', { testCount: 0 }],
  ['passed', { skipped: 1 }], ['passed', { cancelled: 1 }],
  ['infra_failure', { failed: 1 }], ['infra_failure', { skipped: 1 }], ['infra_failure', { complete: false }], ['cancelled', { failed: 1 }]
]) test(`failure remains failed: ${state} ${JSON.stringify(extra)}`, () => {
  const l = reconcile(proposeRoute(input()).ledger, observation(state, extra));
  assert.equal(l.entries[0].state, 'failed');
  assert.equal(proposeRoute({ ...input(), ledger: l }).reason, 'failed');
  assert.equal(l.entries[0].reservedCredits, 1000);
  assert.throws(() => reconcile(l, observation('passed')));
});
test('cancellation request is not a terminal observation; confirmed cancellation never auto-falls back', () => {
  const l = proposeRoute(input()).ledger;
  assert.throws(() => reconcile(l, observation('cancel_requested')));
  const done = reconcile(l, observation('cancelled'));
  assert.equal(proposeRoute({ ...input(), ledger: done }).reason, 'cancelled');
  assert.equal(done.entries[0].reservedCredits, 1000);
});
test('only reconciled infrastructure/non-dispatch yields a fallback proposal, never execution authority', () => {
  for (const state of ['infra_failure', 'not_dispatched']) {
    const l = reconcile(proposeRoute(input()).ledger, observation(state, { pipeline: state === 'not_dispatched' ? null : 'pipeline-1', job: state === 'not_dispatched' ? null : 'job-1', testCount: state === 'not_dispatched' ? 0 : 109, complete: state !== 'not_dispatched' }));
    const r = proposeRoute({ ...input(), ledger: l });
    assert.equal(r.action, 'fallback_proposal'); assert.equal(r.executionAuthorized, false);
    assert.equal(l.entries[0].reservedCredits, 1000);
  }
});
test('complete success is exact-bound and final; it cannot release reserved credits', () => {
  const l = reconcile(proposeRoute(input()).ledger, observation('passed'));
  assert.equal(proposeRoute({ ...input(), ledger: l }).reason, 'passed');
  assert.equal(l.entries[0].reservedCredits, 1000);
  assert.throws(() => reconcile(l, observation('test_failure')));
});
test('malformed, unsupported suite and overfull ledgers fail closed', () => {
  const i = input(); i.request.binding.suite = 'ci.runtime'; assert.throws(() => proposeRoute(i));
  i.request.binding.suite = 'ci.worker-unit'; i.policy.maxJobCredits = NaN; assert.throws(() => proposeRoute(i));
  const l = input().ledger; l.entries = Array(1001).fill({}); assert.throws(() => ledgerCommitProposal(h(1), l));
});
test('real local Git rejects competing sibling fast-forward updates; loser recalculates budget', () => {
  const root = mkdtempSync(join(tmpdir(), 'worker-ledger-'));
  try {
    const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_CONFIG_NOSYSTEM: '1' };
    const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    git('init', '--bare', 'remote'); git('init', 'local');
    const g = (...args) => git('-C', 'local', ...args);
    const tree = g('mktree');
    const base = g('commit-tree', tree, '-m', 'initial ledger');
    g('push', '../remote', `${base}:${LEDGER_REF}`);
    const i = input(); i.policy.maxJobCredits = 200000;
    const winningLedger = proposeRoute(i).ledger;
    const proposal = ledgerCommitProposal(base, winningLedger);
    assert.deepEqual(proposal.parents, [base]); assert.equal(proposal.force, false);
    const a = g('commit-tree', tree, '-p', proposal.parents[0], '-m', 'reservation A');
    const b = g('commit-tree', tree, '-p', proposal.parents[0], '-m', 'reservation B');
    g('push', '../remote', `${a}:${LEDGER_REF}`);
    const rejected = spawnSync('git', ['-C', 'local', 'push', '../remote', `${b}:${LEDGER_REF}`], { cwd: root, env, encoding: 'utf8' });
    assert.notEqual(rejected.status, 0);
    assert.equal(git('--git-dir=remote', 'rev-parse', LEDGER_REF), a);
    i.ledger = winningLedger; i.request.binding = { ...binding, sourceSha: h(9), attempt: 'loser' };
    assert.equal(proposeRoute(i).reason, 'budget_exhausted');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('IDs are strings, terminal evidence is mandatory, and ledger capacity is bounded', () => {
  const i = input(); i.request.binding.attempt = 42; assert.throws(() => proposeRoute(i));
  const l = proposeRoute(input()).ledger; l.entries[0].state = 'passed';
  assert.throws(() => ledgerCommitProposal(h(1), l));
  const empty = input().ledger;
  const entry = proposeRoute({ ...input(), enabled: false }).ledger.entries[0];
  empty.entries = Array.from({ length: LIMITS.entries }, (_, n) => ({ ...entry,
    binding: { ...binding, sourceSha: h(n + 10), attempt: `fixture-${n}` } }));
  assert.equal(proposeRoute({ ...input(), ledger: empty }).reason, 'ledger_full');
});
