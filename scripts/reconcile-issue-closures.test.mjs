import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {issueClosureCandidates, reportIssueClosureCandidates} from './reconcile-issue-closures.mjs';

const repository = 'FreeTWAI-AI/freedom-platform';
const issues = [
  {number: 12, state: 'open', updated_at: '2026-10-01T00:00:00Z'},
  {number: 13, state: 'open', updated_at: '2026-10-03T00:00:00Z'},
  {number: 14, state: 'open', updated_at: '2026-10-01T00:00:00Z'},
  {number: 15, state: 'open', updated_at: '2026-10-01T00:00:00Z'},
  {number: 16, state: 'closed', updated_at: '2026-10-01T00:00:00Z'},
  {number: 17, state: 'open', updated_at: '2026-10-01T00:00:00Z'},
];

test('reports only open issues referenced by merged default-branch PR closing keywords', () => {
  const pulls = [
    {number: 40, title: 'Fixes #12', body: 'Closes #14', merged_at: '2026-10-02T00:00:00Z', base: {ref: 'main'}},
    {number: 41, title: 'Work mentions #13', body: 'Resolves #13', merged_at: null, base: {ref: 'main'}},
    {number: 42, title: 'Closes #13', merged_at: '2026-10-04T00:00:00Z', base: {ref: 'release'}},
    {number: 43, title: 'Closes FreeTWAI-AI/other#15', merged_at: '2026-10-02T00:00:00Z', base: {ref: 'main'}},
    {number: 44, title: 'Refs #12', body: 'Not yet complete', merged_at: '2026-10-05T00:00:00Z', base: {ref: 'main'}},
    {number: 45, title: 'References #16', body: 'Resolves FreeTWAI-AI/freedom-platform#15', merged_at: '2026-10-02T00:00:00Z', base: {ref: 'main'}},
    {number: 46, title: 'Refs #17', body: '`Closes #17`', merged_at: '2026-10-02T00:00:00Z', base: {ref: 'main'}},
    {number: 47, title: 'Code example', body: '```text\nCloses #17\n```', merged_at: '2026-10-02T00:00:00Z', base: {ref: 'main'}},
    {number: 48, title: 'Indented code example', body: '    Closes #17', merged_at: '2026-10-02T00:00:00Z', base: {ref: 'main'}},
  ];
  assert.deepEqual(issueClosureCandidates(issues, pulls, repository, 'main'), [
    {issueNumber: 12, pullNumber: 40, requiresReview: true},
    {issueNumber: 14, pullNumber: 40, requiresReview: true},
    {issueNumber: 15, pullNumber: 45, requiresReview: true},
  ]);
});

test('does not list an issue updated after the matching PR merged', () => {
  const candidate = issueClosureCandidates(
    [{number: 12, state: 'open', updated_at: '2026-10-03T00:00:00Z'}],
    [{number: 40, body: 'Fixes #12', merged_at: '2026-10-02T00:00:00Z', base: {ref: 'main'}}],
    repository,
    'main',
  );
  assert.deepEqual(candidate, []);
});

test('default invocation reports candidates without writing state', async () => {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({url: String(url), method: init.method ?? 'GET'});
    const data = String(url).endsWith(`/repos/${repository}`)
      ? {default_branch: 'main'}
      : String(url).includes('/issues?')
        ? [{number: 12, state: 'open', updated_at: '2026-10-01T00:00:00Z'}]
        : [{number: 40, title: 'Fixes #12', merged_at: '2026-10-02T00:00:00Z', base: {ref: 'main'}}];
    return new Response(JSON.stringify(data), {status: 200, headers: {'Content-Type': 'application/json'}});
  };
  const result = await reportIssueClosureCandidates({fetcher, token: 'test-token', repository});
  assert.deepEqual(result, {
    scannedIssues: 1,
    scannedPullRequests: 1,
    mode: 'report-only',
    candidates: [{issueNumber: 12, pullNumber: 40, requiresReview: true}],
  });
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.method === 'GET'));
});

test('post-merge PR text edits remain unverified hints and cannot close an issue', async () => {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({url: String(url), method: init.method ?? 'GET'});
    const data = String(url).endsWith(`/repos/${repository}`)
      ? {default_branch: 'main'}
      : String(url).includes('/issues?')
        ? [{number: 12, state: 'open', updated_at: '2026-10-01T00:00:00Z'}]
        : [{number: 40, title: 'Unrelated implementation', body: 'Fixes #12',
            merged_at: '2026-10-02T00:00:00Z', updated_at: '2026-10-05T00:00:00Z', base: {ref: 'main'}}];
    return new Response(JSON.stringify(data), {status: 200});
  };
  // Even an old caller explicitly disabling dry-run cannot restore mutation.
  const result = await reportIssueClosureCandidates({fetcher, token: 'test-token', repository, dryRun: false});
  assert.equal(result.mode, 'report-only');
  assert.deepEqual(result.candidates, [{issueNumber: 12, pullNumber: 40, requiresReview: true}]);
  assert.equal(Object.hasOwn(result, 'closed'), false);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.method === 'GET'));
});

test('an issue reopened after the scan is never overwritten', async () => {
  const currentIssue = {number: 12, state: 'open', updated_at: '2026-10-01T00:00:00Z'};
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push(init.method ?? 'GET');
    if (String(url).endsWith(`/repos/${repository}`)) return Response.json({default_branch: 'main'});
    if (String(url).includes('/issues?')) {
      const response = Response.json([currentIssue]);
      // The fetched snapshot is now stale: a human reopened the issue.
      currentIssue.updated_at = '2026-10-05T00:00:00Z';
      return response;
    }
    return Response.json([{number: 40, body: 'Closes #12', merged_at: '2026-10-02T00:00:00Z', base: {ref: 'main'}}]);
  };
  const result = await reportIssueClosureCandidates({fetcher, token: 'test-token', repository});
  assert.deepEqual(result.candidates, [{issueNumber: 12, pullNumber: 40, requiresReview: true}]);
  assert.deepEqual(calls, ['GET', 'GET', 'GET']);
  assert.equal(currentIssue.state, 'open');
  assert.equal(currentIssue.updated_at, '2026-10-05T00:00:00Z');
});

test('scheduled and manual workflow credentials remain read-only', () => {
  const workflow = readFileSync(new URL('../.github/workflows/reconcile-issue-closures.yml', import.meta.url), 'utf8');
  assert.match(workflow, /issues: read/u);
  assert.match(workflow, /pull-requests: read/u);
  assert.doesNotMatch(workflow, /:\s*write\b|write-all|DRY_RUN|dry_run/u);
  assert.match(workflow, /persist-credentials: false/u);
});
