import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { workerUnitHttp } from '../worker-unit-http.mjs';
import { createDispatchState } from '../worker-unit-dispatch.mjs';
import { createLedger, LEDGER_REF } from '../worker-unit-routing.mjs';
const sha = n => n.toString(16).padStart(40, '0');
const uuid = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const hash = (s, a = 'sha256') => createHash(a).update(s).digest('hex');
const base = 'https://api.github.com/repos/FreeTWAI/freedom-platform';
const config = { circleProjectSlug: `circleci/${uuid(1)}/${uuid(2)}`, circleDefinitionId: uuid(3), circleConfigSha: sha(3), circleConfigTag: 'reviewed-circle',
  githubWorkflowSha: sha(4), githubWorkflowTag: 'reviewed-github', runnerSha: sha(2), suiteDigest: 'a'.repeat(64), resourceClass: 'large' };
const binding = { repository: 'FreeTWAI/freedom-platform', sourceSha: sha(1), runnerSha: sha(2), suite: 'ci.worker-unit', suiteDigest: config.suiteDigest, attempt: 'attempt-1' };
const costContract = { configSha: sha(3), resourceClass: 'large', runnerSha: sha(2), suiteDigest: config.suiteDigest };
function fixture(options = {}) {
  const calls = [], tokens = [];
  const f = { calls, tokens, replies: [] };
  f.http = workerUnitHttp(config, { enabled: true, timeoutMs: 1000,
    credentials: { github: async () => { tokens.push('github'); return 'synthetic-github-token'; }, circleci: async () => { tokens.push('circleci'); return 'synthetic-circle-token'; } },
    fetchImpl: async (url, init) => {
      calls.push({ url, ...init }); assert.equal(init.redirect, 'error');
      assert(init.signal instanceof AbortSignal);
      const reply = f.replies.shift(); if (typeof reply === 'function') return reply(url, init);
      assert(reply, 'unexpected HTTP call');
      return new Response(reply.body === undefined ? JSON.stringify(reply.data) : reply.body, { status: reply.status || 200, headers: reply.headers });
    }, ...options });
  return f;
}
const tag = (name, commit) => ({ data: { ref: `refs/tags/${name}`, object: { type: 'commit', sha: commit } } });
const ref = head => ({ data: { ref: LEDGER_REF, object: { type: 'commit', sha: head } } });
function ledgerFixture() {
  const state = createDispatchState([createLedger({ cycle: 'fixture', startsAt: 0, endsAt: 1000000 })]);
  const bytes = JSON.stringify(state) + '\n';
  return { state, bytes, blob: hash(Buffer.concat([Buffer.from(`blob ${Buffer.byteLength(bytes)}\0`), Buffer.from(bytes)]), 'sha1') };
}
test('default disabled acquires no credentials and sends no HTTP', async () => {
  const f = fixture({ enabled: false });
  for (const method of ['read', 'commit', 'dispatch', 'observe']) await assert.rejects(f.http[method]({}), /worker_http_disabled/);
  assert.deepEqual(f.tokens, []); assert.deepEqual(f.calls, []);
});
test('fixed CircleCI trigger binds source, runner, suite, attempt, definition and reviewed config tag', async () => {
  const f = fixture(); f.replies.push(tag(config.circleConfigTag, sha(3)), { status: 201, data: { id: uuid(9) } });
  assert.deepEqual(await f.http.dispatch({ provider: 'circleci', binding, costContract }), { pipeline: uuid(9) });
  const r = f.calls[1]; assert.equal(r.url, `https://circleci.com/api/v2/project/${config.circleProjectSlug}/pipeline/run`);
  const b = JSON.parse(r.body); assert.equal(b.definition_id, uuid(3)); assert.deepEqual(b.config, { tag: config.circleConfigTag });
  assert.equal(b.parameters['candidate-sha'], binding.sourceSha); assert.equal(b.parameters['routing-attempt'], binding.attempt);
  assert.equal(r.headers['Circle-Token'], 'synthetic-circle-token'); assert.equal(r.headers.authorization, undefined);
  assert.equal(f.calls[0].headers['Circle-Token'], undefined);
});
test('GitHub fallback uses fixed workflow and exact inputs; legacy 204 stays unidentified', async () => {
  for (const status of [200, 204]) {
    const f = fixture(); f.replies.push(tag(config.githubWorkflowTag, sha(4)), { status, data: { workflow_run_id: 123 }, ...(status === 204 ? { body: null } : {}) });
    const r = await f.http.dispatch({ provider: 'github', binding, costContract: null });
    assert.deepEqual(r, status === 200 ? { pipeline: '123' } : {});
    assert.equal(f.calls[1].url, `${base}/actions/workflows/worker-unit-fallback.yml/dispatches`);
    const b = JSON.parse(f.calls[1].body); assert.equal(b.inputs.source_sha, sha(1)); assert.equal(b.inputs.attempt, 'attempt-1'); assert.equal(b.ref, config.githubWorkflowTag);
  }
});
test('unreviewed binding, tag drift and endpoint injection fail without POST', async () => {
  for (const changed of [{ runnerSha: sha(8) }, { sourceSha: '../bad' }, { suite: 'ci.runtime' }, { attempt: 'x\ny' }]) {
    const f = fixture(); await assert.rejects(f.http.dispatch({ provider: 'github', binding: { ...binding, ...changed }, costContract: null }));
    assert.equal(f.calls.length, 0); assert.equal(f.tokens.length, 0);
  }
  const f = fixture(); f.replies.push(tag(config.githubWorkflowTag, sha(9)));
  await assert.rejects(f.http.dispatch({ provider: 'github', binding, costContract: null })); assert.equal(f.calls.length, 1);
  assert.throws(() => workerUnitHttp({ ...config, circleProjectSlug: 'https://evil.invalid' }, { enabled: true }));
});
test('Git read is immutable-head/tree/blob bound and verifies exact blob bytes', async () => {
  const f = fixture(), l = ledgerFixture();
  f.replies.push(ref(sha(5)), { data: { sha: sha(5), tree: { sha: sha(6) } } },
    { data: { sha: sha(6), truncated: false, tree: [{ path: 'ledger.json', mode: '100644', type: 'blob', sha: l.blob }] } },
    { data: { sha: l.blob, encoding: 'base64', size: Buffer.byteLength(l.bytes), content: Buffer.from(l.bytes).toString('base64') } });
  assert.deepEqual(await f.http.read({ ref: LEDGER_REF }), { head: sha(5), state: l.state });
  assert.deepEqual(f.calls.map(c => c.method), ['GET', 'GET', 'GET', 'GET']);
});
test('Git commit uses sole observed parent and force:false; stale parent never writes', async () => {
  const l = ledgerFixture(); const p = { ref: LEDGER_REF, path: 'ledger.json', parents: [sha(5)], force: false, bytes: l.bytes, sha256: hash(l.bytes) };
  const f = fixture(); f.replies.push(ref(sha(5)), { status: 201, data: { sha: l.blob } }, { status: 201, data: { sha: sha(6) } },
    { status: 201, data: { sha: sha(7), tree: { sha: sha(6) }, parents: [{ sha: sha(5) }] } }, ref(sha(7)));
  assert.equal((await f.http.commit(p)).status, 'committed');
  assert.deepEqual(JSON.parse(f.calls[3].body).parents, [sha(5)]);
  assert.deepEqual(JSON.parse(f.calls[4].body), { sha: sha(7), force: false });
  assert.equal(f.calls[4].method, 'PATCH');
  const stale = fixture(); stale.replies.push(ref(sha(9))); assert.deepEqual(await stale.http.commit(p), { status: 'rejected' }); assert.equal(stale.calls.length, 1);
});
for (const [name, reply] of [
  ['redirect', () => ({ status: 302, redirected: true, url: 'https://evil.invalid' })],
  ['foreign origin', () => ({ status: 200, redirected: false, url: 'https://evil.invalid' })],
  ['oversized length', { data: {}, headers: { 'content-length': '4000001' } }],
  ['oversized body', { body: ' '.repeat(4000001) }],
  ['duplicate JSON keys', { body: '{"a":1,"a":2}' }],
  ['HTTP error', { status: 401, data: { secret: 'synthetic-github-token' } }],
  ['transport exception', () => { throw Error('synthetic-github-token'); }]
]) test(`rejects ${name} and redacts errors`, async () => {
  const f = fixture(); f.replies.push(reply);
  await assert.rejects(f.http.read({ ref: LEDGER_REF }), e => e.message === 'worker_http_unavailable' && !e.stack.includes('synthetic-github-token'));
  assert.equal(f.calls.length, 1);
});
test('credential, HTTP and streamed-body timeouts are bounded with no retries', async () => {
  const never = () => new Promise(() => {});
  for (const phase of ['credential', 'fetch', 'body']) {
    const f = fixture({ timeoutMs: 10, ...(phase === 'credential' ? { credentials: { github: never, circleci: never } } : {}) });
    if (phase === 'fetch') f.replies.push(never);
    if (phase === 'body') f.replies.push(() => new Response(new ReadableStream({ pull: never })));
    await assert.rejects(f.http.read({ ref: LEDGER_REF }), /worker_http_unavailable/);
    assert(f.calls.length <= 1);
  }
});
test('provider success alone stays unknown; stale exact execution identity is rejected', async () => {
  const f = fixture(); f.replies.push({ data: { id: 123, repository: { full_name: binding.repository }, event: 'workflow_dispatch',
    head_sha: sha(4), path: '.github/workflows/worker-unit-fallback.yml', run_attempt: 1, display_title: `ci.worker-unit ${sha(1)} attempt-1`, conclusion: 'success' } },
    { data: { total_count: 1, jobs: [{ id: 456, conclusion: 'success' }] } });
  assert.deepEqual(await f.http.observe({ provider: 'github', binding, pipeline: '123', job: null }), { state: 'unknown' });
  const g = fixture(); g.replies.push({ data: { id: 123, repository: { full_name: binding.repository }, event: 'workflow_dispatch', head_sha: sha(8) } });
  await assert.rejects(g.http.observe({ provider: 'github', binding, pipeline: '123', job: null }));
  const h = fixture(); assert.deepEqual(await h.http.observe({ provider: 'circleci', binding, pipeline: null }), { state: 'unknown' }); assert.equal(h.calls.length, 0);
});
test('CircleCI metadata is bounded to one workflow/job and cannot become test evidence by itself', async () => {
  const f = fixture(); f.replies.push({ data: { id: uuid(9), project_slug: config.circleProjectSlug, vcs: { revision: config.circleConfigSha } } },
    { data: { items: [{ id: uuid(8), pipeline_id: uuid(9) }], next_page_token: null } },
    { data: { items: [{ id: uuid(7), status: 'success' }], next_page_token: null } });
  assert.deepEqual(await f.http.observe({ provider: 'circleci', binding, pipeline: uuid(9), job: null }), { state: 'unknown' });
});
test('fallback template is outside workflows, hard disabled and has no controller credentials', () => {
  const text = readFileSync(new URL('../worker-unit-fallback.yml.disabled', import.meta.url), 'utf8');
  assert(text.includes('if: ${{ false }}')); assert(text.includes('permissions: {}'));
  assert(text.includes('run-pinned-suite.mjs --root . --suite ci.worker-unit'));
  assert(!text.includes('secrets.')); assert(!text.includes('actions/checkout'));
});

test('ambiguous pipeline response and failed ref PATCH never retry', async () => {
  const f = fixture(); f.replies.push(tag(config.circleConfigTag, sha(3)), { status: 200, data: { message: 'ignored' } });
  await assert.rejects(f.http.dispatch({ provider: 'circleci', binding, costContract })); assert.equal(f.calls.length, 2);
  const l = ledgerFixture(), g = fixture();
  g.replies.push(ref(sha(5)), { status: 201, data: { sha: l.blob } }, { status: 201, data: { sha: sha(6) } },
    { status: 201, data: { sha: sha(7), tree: { sha: sha(6) }, parents: [{ sha: sha(5) }] } }, () => { throw Error('lost PATCH'); });
  await assert.rejects(g.http.commit({ ref: LEDGER_REF, path: 'ledger.json', parents: [sha(5)], force: false, bytes: l.bytes, sha256: hash(l.bytes) }));
  assert.equal(g.calls.filter(c => c.method === 'PATCH').length, 1);
});
test('trusted evidence must match actual provider job, and provider failure cannot become success', async () => {
  for (const [job, conclusion, allowed] of [['456', 'success', true], ['999', 'success', false], ['456', 'failure', false]]) {
    const expected = { binding, pipeline: '123', job, state: 'passed', evidence: 'b'.repeat(64), complete: true, testCount: 109, failed: 0, skipped: 0, cancelled: 0 };
    const f = fixture({ verifyEvidence: async () => expected });
    f.replies.push({ data: { id: 123, repository: { full_name: binding.repository }, event: 'workflow_dispatch', head_sha: sha(4),
      path: '.github/workflows/worker-unit-fallback.yml', run_attempt: 1, display_title: `ci.worker-unit ${sha(1)} attempt-1`, conclusion } },
      { data: { total_count: 1, jobs: [{ id: 456, conclusion }] } });
    const call = f.http.observe({ provider: 'github', binding, pipeline: '123', job: null });
    if (allowed) assert.deepEqual(await call, expected); else await assert.rejects(call);
  }
});
test('unknown cancellation or pagination cannot authorize fallback', async () => {
  const f = fixture(); f.replies.push({ data: { id: uuid(9), project_slug: config.circleProjectSlug, vcs: { revision: config.circleConfigSha } } },
    { data: { items: [{ id: uuid(8), pipeline_id: uuid(9), status: 'canceled' }], next_page_token: 'more' } });
  assert.deepEqual(await f.http.observe({ provider: 'circleci', binding, pipeline: uuid(9) }), { state: 'unknown' });
  assert.equal(f.calls.length, 2);
});
