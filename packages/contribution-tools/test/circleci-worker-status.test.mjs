import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { REPOSITORY, CONTEXT, workerStatusDecision, newestWorkerStatus, githubReader } from '../circleci-worker-status.mjs';
const head = 'a'.repeat(40), integration = 'b'.repeat(40), tree = 'c'.repeat(40);
const now = Date.parse('2026-10-16T02:00:00Z');
const status = (state = 'success', id = 2) => ({ id, context: CONTEXT, state, created_at: '2026-10-16T01:44:16Z', url: `https://api.github.com/repos/${REPOSITORY}/statuses/${head}`, target_url: `https://circleci.com/gh/${REPOSITORY}/3`, creator: { login: 'teddashh', id: 233386770, type: 'User' } });
const event = () => ({ pull_request: { base: { repo: { full_name: REPOSITORY } }, head: { sha: head, repo: { full_name: REPOSITORY, fork: false } } } });
function fixture(rows = [status()], different = false) {
  const calls = [];
  const args = { eventName: 'pull_request', repository: REPOSITORY, integrationSha: integration, event: event(), now: () => now, waitMs: 0, get: async path => {
    calls.push(path);
    if (path.startsWith('/git/commits/')) return { sha: path.split('/').at(-1), tree: { sha: different && path.endsWith(integration) ? 'd'.repeat(40) : tree } };
    return rows;
  } };
  return { args, calls };
}
test('equal same-repository trees use current head CircleCI success', async () => {
  const { args, calls } = fixture(); const result = await workerStatusDecision(args);
  assert.equal(result.runGithub, false); assert.equal(result.headSha, head); assert.equal(result.treeSha, tree);
  assert.match(calls[2], new RegExp(`/commits/${head}/statuses`));
});
for (const mode of ['push', 'merge_group', 'fork', 'different-tree']) test(`${mode} retains GitHub suite without querying statuses`, async () => {
  const { args, calls } = fixture([], mode === 'different-tree');
  if (mode === 'fork') args.event.pull_request.head.repo = { full_name: 'other/repo', fork: true }; else if (mode !== 'different-tree') args.eventName = mode;
  assert.equal((await workerStatusDecision(args)).runGithub, true); assert.ok(!calls.some(p => p.includes('/statuses')));
});
for (const state of ['failure', 'error', 'pending']) test(`newer ${state} supersedes older success`, async () => {
  const { args } = fixture([status('success', 1), status(state, 2)]);
  await assert.rejects(workerStatusDecision(args), /circleci_worker/);
});
test('later timestamp takes precedence over array ordering', () => {
  assert.equal(newestWorkerStatus([{ ...status('failure', 1), created_at: '2026-10-16T01:59:00Z' }, status('success', 2)], head, now), 'failure');
});
for (const [name, update] of [
  ['creator', { creator: { id: 7, login: 'teddashh', type: 'User' } }],
  ['login', { creator: { id: 233386770, login: 'other', type: 'User' } }],
  ['stale SHA', { url: `https://api.github.com/repos/${REPOSITORY}/statuses/${integration}` }],
  ['foreign URL', { target_url: 'https://evil.invalid/3' }],
  ['wrong repo URL', { target_url: 'https://circleci.com/gh/other/repo/3' }],
  ['URL suffix', { target_url: `https://circleci.com/gh/${REPOSITORY}/3?pass=true` }],
  ['future timestamp', { created_at: '2027-01-01T00:00:00Z' }],
  ['malformed timestamp', { created_at: 'invalid' }],
  ['unknown state', { state: 'cancelled' }]
]) test(`${name} cannot reuse older success`, async () => {
  const { args } = fixture([status('success', 1), { ...status('success', 2), ...update }]);
  await assert.rejects(workerStatusDecision(args), /unavailable/);
});
test('absent/wrong-context result times out rather than skipping or falling back', async () => {
  for (const rows of [[], [{ ...status(), context: 'ci/circleci: other' }]]) await assert.rejects(workerStatusDecision(fixture(rows).args), /pending_timeout/);
});
test('bounded pending poll eventually succeeds', async () => {
  const { args } = fixture(); const original = args.get; let tick = now, tries = 0;
  args.now = () => tick; args.waitMs = 30000; args.sleep = async ms => { tick += ms; };
  args.get = async path => path.includes('/statuses') ? [status(++tries === 1 ? 'pending' : 'success')] : original(path);
  assert.equal((await workerStatusDecision(args)).runGithub, false); assert.equal(tries, 2);
});
test('pagination is bounded and can locate status beyond first page', async () => {
  const { args } = fixture(); const original = args.get; let pages = 0;
  args.get = async path => path.includes('/statuses') ? (++pages === 1 ? Array.from({ length: 100 }, () => ({ context: 'other' })) : [status()]) : original(path);
  assert.equal((await workerStatusDecision(args)).runGithub, false); assert.equal(pages, 2);
  args.get = async path => path.includes('/statuses') ? Array.from({ length: 100 }, () => ({ context: 'other' })) : original(path);
  await assert.rejects(workerStatusDecision(args), /unavailable/);
});
test('API outage and mismatched commit identity fail closed', async () => {
  const { args } = fixture(); args.get = async () => { throw Error('outage'); }; await assert.rejects(workerStatusDecision(args));
  args.get = async () => ({ sha: integration, tree: { sha: tree } }); await assert.rejects(workerStatusDecision(args), /unavailable/);
});
test('HTTP reader uses fixed GET with token, rejects redirects/errors without reflecting credentials', async () => {
  let calls = 0;
  const get = githubReader('synthetic-token', async (url, options) => { calls++; assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Bearer synthetic-token'); return new Response(JSON.stringify([])); });
  assert.deepEqual(await get(`/commits/${head}/statuses?per_page=100&page=1`), []);
  await assert.rejects(get('https://evil.invalid'), /unavailable/); assert.equal(calls, 1);
  const bad = githubReader('synthetic-token', async () => { throw Error('synthetic-token'); });
  await assert.rejects(bad(`/git/commits/${head}`), e => e.message === 'worker_status_unavailable');
});


test('all static-worker checkouts disable persistence and only guard receives status token', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/verify.yml', import.meta.url), 'utf8');
  const job = workflow.match(/^  static-worker:\n([\s\S]*?)(?=^  [a-z][a-z-]*:)/m)?.[1];
  assert.ok(job, 'static-worker job must exist');
  const [preamble, ...steps] = job.split(/^      - /m);
  assert.ok(!preamble.includes('GH_STATUS_TOKEN'));
  const checkouts = steps.filter(s => /^uses: actions\/checkout@/m.test(s) || /^        uses: actions\/checkout@/m.test(s));
  assert.equal(checkouts.length, 3);
  for (const step of checkouts) assert.match(step, /^          persist-credentials: false$/m);
  const tokenSteps = steps.filter(s => s.includes('GH_STATUS_TOKEN'));
  assert.equal(tokenSteps.length, 1);
  assert.match(tokenSteps[0], /^        id: worker-provider$/m);
  assert.match(tokenSteps[0], /^          GH_STATUS_TOKEN: \$\{\{ github.token \}\}$/m);
  assert.equal((workflow.match(/GH_STATUS_TOKEN:/g) || []).length, 1);
});
