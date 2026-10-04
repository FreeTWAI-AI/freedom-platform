import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runMemberRouteBehavior, behaviorFixtureIdentity, installedBehaviorHarnessDigest } from '../behavior-harness.mjs';
import { MEMBER_BEHAVIOR as manifest, MEMBER_BEHAVIOR_CASES as cases } from '../behavior-manifest.mjs';
import { VerificationError } from '../errors.mjs';
import { validateFormat } from '../formats.mjs';

// These are independent synthetic transport vectors, not authenticated host
// provisioning or proof that a real deployment serves any of the responses.
async function fixture() {
  const input = {
    binding: { repository: 'FreeTWAI-AI/freedom-platform', pull_request: 77, run_id: 'independent-synthetic-run',
      base_commit: '1'.repeat(40), head_commit: '2'.repeat(40), candidate_commit: '3'.repeat(40), candidate_tree: '4'.repeat(40),
      source_commit: '5'.repeat(40), release_set_sha256: '6'.repeat(64), policy_revision: 'synthetic-policy-1', policy_sha256: '7'.repeat(64),
      verifier_commit: '8'.repeat(40), verifier_sha256: '9'.repeat(64) },
    workflow: { identity: 'independent/fixed-workflow', commit: 'a'.repeat(40), publisher: 'synthetic-only' },
    expectedHarnessSha256: await installedBehaviorHarnessDigest(),
    fixture: { instance_id: randomUUID(), work_id: randomUUID(),
      owner: { id: randomUUID(), cookie: 'freedom_local_session=OWNER_COOKIE_DO_NOT_RECORD_123456789', csrf: 'OWNER_CSRF_DO_NOT_RECORD' },
      outsider: { id: randomUUID(), cookie: 'freedom_local_session=OUTSIDER_COOKIE_DO_NOT_RECORD_123456789', csrf: 'OUTSIDER_CSRF_DO_NOT_RECORD' },
      revoked: { cookie: 'freedom_local_session=REVOKED_COOKIE_DO_NOT_RECORD_123456789', csrf: 'REVOKED_CSRF_DO_NOT_RECORD' } },
  };
  const observed = () => ({ binding: structuredClone(input.binding), workflow: structuredClone(input.workflow),
    harness_sha256: input.expectedHarnessSha256, fixture: behaviorFixtureIdentity(input.fixture) });
  let count = 0;
  const requests = [];
  const response = item => {
    const headers = { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json' };
    const work = { work_item_id: input.fixture.work_id, title: manifest.title, objective: manifest.objective,
      state: 'draft', aggregate_version: 1, created_at: '2026-10-02T00:00:00.000Z' };
    if (item.shape === 'head') return new Response(null, { status: item.status, headers });
    if (item.shape === 'avatar') return new Response('RIFF1234WEBPsynthetic', { status: item.status, headers: { ...headers, 'Content-Type': 'image/webp' } });
    const value = item.shape === 'problem' ? { type: 'about:blank', code: 'synthetic_denial', status: item.status }
      : item.shape === 'metadata' ? { aggregate_version: 1, avatar_url: `/api/v1/members/${input.fixture.owner.id}/avatar?v=1` }
      : item.shape === 'empty-list' ? { total: 0, items: [], limit: 20, offset: 0 }
      : item.shape === 'list' ? { total: 1, items: [work], limit: 20, offset: 0 } : work;
    return new Response(JSON.stringify(value), { status: item.status, headers });
  };
  const ports = { observeTarget: async () => observed(), request: async request => { requests.push(request); return response(cases[count++]); } };
  return { input, observed, response, ports, requests };
}
function noAuthority(report) {
  assert.notEqual(report.status, 'passed'); assert.equal(report.assurance_level, 'local');
  assert.equal(report.merge_authorized, false); assert.equal(report.execution_authorized, false); assert.equal(report.publisher_trust, 'unverified');
  assert(report.blockers.includes('registration_behavior_audit_required'));
}
function failed(report) { noAuthority(report); assert.equal(report.status, 'failed'); assert.equal(report.observation, null); }

test('BEHAVIOR independent fixed synthetic control observes all cases but never proves host trust', async () => {
  const f = await fixture(), report = await runMemberRouteBehavior(f.input, f.ports);
  noAuthority(report); assert.equal(report.status, 'unavailable'); assert.equal(report.check.status, 'passed');
  assert.equal(report.outcomes.length, 27); assert.equal(report.observation.tests, 27); assert.equal(f.requests.length, 27);
  assert.equal(new Set(report.outcomes.map(row => row.case_sha256)).size, 27);
  assert(report.outcomes.every(row => row.status === 'passed'));
  const text = JSON.stringify(report);
  for (const actor of Object.values(f.input.fixture).filter(value => typeof value === 'object')) {
    assert(!text.includes(actor.cookie)); assert(!text.includes(actor.csrf));
  }
  assert(!text.includes(manifest.title)); assert(!text.includes(manifest.objective));
  validateFormat('verifierReport', { format: 'freedom.verifier-report/v1', assurance_level: 'local', repository: f.input.binding.repository,
    base_commit: f.input.binding.base_commit, head_commit: f.input.binding.head_commit, workspace_sha256: 'b'.repeat(64),
    status: report.status, scope: [], checks: [report.check], blockers: report.blockers });
});

test('BEHAVIOR independent candidate pass flags, empty registries and alternate request hooks are not inputs', async () => {
  const f = await fixture();
  for (const extra of [{ passed: true }, { cases: [] }, { report: { tests: 1, passed: true } }, { registry: [] }])
    await assert.rejects(runMemberRouteBehavior({ ...f.input, ...extra }, f.ports));
  await assert.rejects(runMemberRouteBehavior(f.input, { ...f.ports, registry: [] }));
  const absent = await runMemberRouteBehavior(f.input); noAuthority(absent); assert.equal(absent.check.status, 'not_run');
  assert.equal(absent.outcomes.length, 0); assert.equal(absent.observation, null);
  const unapproved = await runMemberRouteBehavior({ ...f.input, expectedHarnessSha256: '0'.repeat(64) }, f.ports);
  assert.equal(unapproved.check.status, 'not_run'); assert.equal(f.requests.length, 0);
  assert(Object.isFrozen(cases)); assert(Object.isFrozen(cases[0])); assert.throws(() => cases.splice(0));
});

test('BEHAVIOR independent every emitted avatar remove retains an invalid mutation precondition', async () => {
  const f = await fixture(); await runMemberRouteBehavior(f.input, f.ports);
  const removes = f.requests.filter(request => new URL(request.url).pathname.endsWith('/avatar/remove'));
  assert.equal(removes.length, 5);
  for (const request of removes) {
    assert.equal(request.method, 'POST'); assert.equal(request.redirect, 'error');
    assert(!request.headers.has('If-Match') || !request.headers.has('X-CSRF-Token') || !request.headers.has('Idempotency-Key'),
      'An auth-negative remove must not become a valid delete when the auth check under test regresses');
  }
});

for (const phase of ['before', 'after']) for (const field of ['candidate_tree', 'base_commit', 'policy_sha256', 'workflow', 'harness', 'fixture'])
  test(`BEHAVIOR independent ${phase} ${field} rebinding invalidates the whole observation`, async () => {
    const f = await fixture(); let calls = 0;
    f.ports.observeTarget = async () => {
      const value = f.observed();
      if ((++calls === 1) === (phase === 'before')) {
        if (field === 'workflow') value.workflow.publisher = 'wrong-publisher';
        else if (field === 'harness') value.harness_sha256 = '0'.repeat(64);
        else if (field === 'fixture') value.fixture = { ...value.fixture, instance_id: randomUUID() };
        else value.binding[field] = (field === 'policy_sha256' ? '0'.repeat(64) : '0'.repeat(40));
      }
      return value;
    };
    const report = await runMemberRouteBehavior(f.input, f.ports); failed(report);
    assert.equal(report.check.reason, 'behavior_target_binding_mismatch');
    assert.equal(f.requests.length, phase === 'before' ? 0 : 27);
  });

for (const source of ['request', 'observeTarget']) for (const kind of ['ordinary', 'VerificationError'])
  test(`BEHAVIOR independent ${source} ${kind} exceptions never echo private credential text`, async () => {
    const f = await fixture(), secret = 'PRIVATE_TRANSPORT_COOKIE_DO_NOT_RECORD';
    f.ports[source] = async () => { throw kind === 'VerificationError' ? new VerificationError(secret) : new Error(secret); };
    const report = await runMemberRouteBehavior(f.input, f.ports); failed(report);
    assert(!JSON.stringify(report).includes(secret));
  });

for (const vector of ['redirect', 'cached', 'fake-report', 'private-body', 'oversize', 'throwing-stream', 'duplicate-json'])
  test(`BEHAVIOR independent ${vector} response cannot create successful evidence`, async () => {
    const f = await fixture(); let count = 0;
    f.ports.request = async () => {
      const item = cases[count++]; if (count !== 1) return f.response(item);
      if (vector === 'redirect') return Response.redirect('https://not-requested.invalid/', 302);
      if (vector === 'cached') return new Response('{"code":"denied"}', { status: 401, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public,max-age=60' } });
      if (vector === 'fake-report') return { passed: true, status: 401, tests: 999 };
      if (vector === 'throwing-stream') return new Response(new ReadableStream({ pull(c) { c.error(new Error('PRIVATE_STREAM_SECRET')); } }), { status: 401 });
      const body = vector === 'private-body' ? JSON.stringify({ code: 'denied', private: manifest.title })
        : vector === 'duplicate-json' ? '{"code":"first","code":"second"}' : 'x'.repeat(manifest.limits.response_bytes + 1);
      return new Response(body, { status: 401, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    };
    const report = await runMemberRouteBehavior(f.input, f.ports); failed(report);
    assert.equal(report.outcomes[0].status, 'failed'); assert(!JSON.stringify(report).includes('PRIVATE_STREAM_SECRET'));
  });

test('BEHAVIOR independent one wrong owner-private body fails even if all other cases pass', async () => {
  const f = await fixture(); let count = 0;
  f.ports.request = async () => {
    const item = cases[count++];
    if (item.id === 'owner.work.list') return new Response(JSON.stringify({ total: 0, items: [], limit: 20, offset: 0 }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    return f.response(item);
  };
  const report = await runMemberRouteBehavior(f.input, f.ports); failed(report);
  assert.equal(report.outcomes.filter(row => row.status === 'failed').length, 1);
});

for (const leaked of ['objective', 'work_id']) test(`BEHAVIOR independent outsider empty list cannot hide leaked ${leaked} in extra fields`, async () => {
  const f = await fixture(); let count = 0;
  f.ports.request = async () => {
    const item = cases[count++];
    if (item.shape === 'empty-list') return new Response(JSON.stringify({ total: 0, items: [], limit: 20, offset: 0,
      accidental_private_field: leaked === 'objective' ? manifest.objective : f.input.fixture.work_id }), {
      status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    return f.response(item);
  };
  const report = await runMemberRouteBehavior(f.input, f.ports); failed(report);
  assert.equal(report.outcomes.filter(row => row.status === 'failed').length, 1);
});

test('BEHAVIOR independent JSON-escaped private problem detail is still a leak', async () => {
  const f = await fixture(); let count = 0;
  f.ports.request = async () => {
    const item = cases[count++];
    if (count === 1) {
      const escaped = Array.from(manifest.objective, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
      return new Response('{"code":"denied","detail":"' + escaped + '"}', {
        status: 401, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
    return f.response(item);
  };
  const report = await runMemberRouteBehavior(f.input, f.ports); failed(report);
  assert.equal(report.outcomes[0].status, 'failed');
});

for (const leak of ['head-private-header', 'credential-header', 'credential-body'])
  test(`BEHAVIOR independent ${leak} must fail even with correct denial status`, async () => {
    const f = await fixture(); let count = 0;
    f.ports.request = async () => {
      const item = cases[count++], response = f.response(item);
      if (leak === 'head-private-header' && item.id === 'outsider.work.head.conditional')
        response.headers.set('X-Private-Objective', manifest.objective);
      if (count === 1 && leak === 'credential-header') response.headers.set('X-Diagnostic', f.input.fixture.owner.cookie);
      if (count === 1 && leak === 'credential-body') return new Response(JSON.stringify({ code: 'denied', detail: f.input.fixture.owner.csrf }), {
        status: 401, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      return response;
    };
    const report = await runMemberRouteBehavior(f.input, f.ports); failed(report);
    assert.equal(report.outcomes.filter(row => row.status === 'failed').length, 1);
    for (const marker of [manifest.objective, f.input.fixture.owner.cookie, f.input.fixture.owner.csrf]) assert(!JSON.stringify(report).includes(marker));
  });

test('BEHAVIOR independent ignored abort and unresolved stream are bounded, never observed as success', async () => {
  const f = await fixture(); let count = 0;
  f.ports.request = async () => {
    count++;
    return new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }), {
      status: 401, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' } });
  };
  const started = Date.now(), report = await runMemberRouteBehavior(f.input, f.ports); failed(report);
  assert(Date.now() - started < 6000); assert.equal(count, 1);
  assert(report.outcomes.some(row => row.reason === 'behavior_transport_timeout'));
});

test('BEHAVIOR independent cumulative bounded responses cannot bypass the total byte budget', async () => {
  const f = await fixture(); let count = 0;
  f.ports.request = async () => {
    const response = f.response(cases[count++]);
    if (!response.headers.get('Content-Type')?.includes('application/json') || !response.body) return response;
    const text = await response.text();
    return new Response(text + ' '.repeat(manifest.limits.response_bytes - Buffer.byteLength(text)), { status: response.status, headers: response.headers });
  };
  const report = await runMemberRouteBehavior(f.input, f.ports); failed(report);
  assert(report.outcomes.some(row => row.reason === 'behavior_response_limit'));
});
