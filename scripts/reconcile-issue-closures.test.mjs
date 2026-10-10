import assert from 'node:assert/strict';
import {test} from 'node:test';
import {closeableIssues, reconcileIssueClosures} from './reconcile-issue-closures.mjs';

const repository = 'FreeTWAI-AI/freedom-platform';
const issues = [
  {number: 12, state: 'open', updated_at: '2026-10-01T00:00:00Z'},
  {number: 13, state: 'open', updated_at: '2026-10-03T00:00:00Z'},
  {number: 14, state: 'open', updated_at: '2026-10-01T00:00:00Z'},
  {number: 15, state: 'open', updated_at: '2026-10-01T00:00:00Z'},
  {number: 16, state: 'closed', updated_at: '2026-10-01T00:00:00Z'},
  {number: 17, state: 'open', updated_at: '2026-10-01T00:00:00Z'},
];

test('only closes open issues explicitly completed by a merged PR on the default branch', () => {
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
  assert.deepEqual(closeableIssues(issues, pulls, repository, 'main'), [
    {issueNumber: 12, pullNumber: 40},
    {issueNumber: 14, pullNumber: 40},
    {issueNumber: 15, pullNumber: 45},
  ]);
});

test('does not re-close an issue updated after the closing PR merged', () => {
  const candidate = closeableIssues(
    [{number: 12, state: 'open', updated_at: '2026-10-03T00:00:00Z'}],
    [{number: 40, body: 'Fixes #12', merged_at: '2026-10-02T00:00:00Z', base: {ref: 'main'}}],
    repository,
    'main',
  );
  assert.deepEqual(candidate, []);
});

test('dry-run scans issues and merged PRs without writing state', async () => {
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
  const result = await reconcileIssueClosures({fetcher, token: 'test-token', repository, dryRun: true});
  assert.deepEqual(result, {
    scannedIssues: 1,
    scannedPullRequests: 1,
    dryRun: true,
    closed: [{issueNumber: 12, pullNumber: 40}],
  });
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.method === 'GET'));
});

test('closes a completed issue with the merged PR evidence', async () => {
  const writes = [];
  const fetcher = async (url, init = {}) => {
    if (init.method === 'PATCH') writes.push({url: String(url), body: JSON.parse(init.body)});
    const data = String(url).endsWith(`/repos/${repository}`)
      ? {default_branch: 'main'}
      : String(url).includes('/issues?')
        ? [{number: 12, state: 'open', updated_at: '2026-10-01T00:00:00Z'}]
        : [{number: 40, title: 'Fixes #12', merged_at: '2026-10-02T00:00:00Z', base: {ref: 'main'}}];
    return new Response(JSON.stringify(data), {status: 200, headers: {'Content-Type': 'application/json'}});
  };
  const result = await reconcileIssueClosures({fetcher, token: 'test-token', repository});
  assert.deepEqual(result.closed, [{issueNumber: 12, pullNumber: 40}]);
  assert.deepEqual(writes, [{
    url: `https://api.github.com/repos/${repository}/issues/12`,
    body: {state: 'closed', state_reason: 'completed'},
  }]);
});
