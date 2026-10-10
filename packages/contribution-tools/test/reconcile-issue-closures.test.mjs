import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {PINNED_SUITES} from '../pinned-suites.mjs';
import {issueClosureCandidates, reportIssueClosureCandidates} from '../../../scripts/reconcile-issue-closures.mjs';

const repository = 'FreeTWAI-AI/freedom-platform';
const issues = [
  {number: 12, state: 'open', updated_at: '2026-10-01T00:00:00Z'},
  {number: 13, state: 'open', updated_at: '2026-10-03T00:00:00Z'},
  {number: 14, state: 'open', updated_at: '2026-10-01T00:00:00Z'},
  {number: 15, state: 'open', updated_at: '2026-10-01T00:00:00Z'},
  {number: 16, state: 'closed', updated_at: '2026-10-01T00:00:00Z'},
  {number: 17, state: 'open', updated_at: '2026-10-01T00:00:00Z'},
];

test('reports standalone references from default-branch merged PRs only', () => {
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
    {issueNumber: 12, pullNumber: 40},
    {issueNumber: 14, pullNumber: 40},
    {issueNumber: 15, pullNumber: 45},
  ]);
});

test('omits issues updated after the referenced PR merged', () => {
  const candidate = issueClosureCandidates(
    [{number: 12, state: 'open', updated_at: '2026-10-03T00:00:00Z'}],
    [{number: 40, body: 'Fixes #12', merged_at: '2026-10-02T00:00:00Z', base: {ref: 'main'}}],
    repository,
    'main',
  );
  assert.deepEqual(candidate, []);
});

test('default scan reports unverified candidates with GET only', async () => {
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
    criteriaVerified: false,
    candidates: [{issueNumber: 12, pullNumber: 40}],
  });
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.method === 'GET'));
});

test('post-merge text edits and repeated scans never close or comment, even with legacy dryRun false', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push(init.method);
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    const data = url.endsWith(`/repos/${repository}`) ? {default_branch: 'main'}
      : url.includes('/issues?') ? [{number: 12, state: 'open', updated_at: '2026-10-01T00:00:00Z'}]
      : [{number: 40, body: 'Closes #12', updated_at: '2026-10-05T00:00:00Z',
          merged_at: '2026-10-02T00:00:00Z', base: {ref: 'main'}}];
    return Response.json(data);
  };
  const input = {fetcher, token: 'test-token', repository, dryRun: false};
  const first = await reportIssueClosureCandidates(input);
  assert.equal(first.criteriaVerified, false);
  assert.equal(first.mode, 'report-only');
  assert.deepEqual(first.candidates, [{issueNumber: 12, pullNumber: 40}]);
  assert.deepEqual(await reportIssueClosureCandidates(input), first);
  assert.deepEqual(calls, Array(6).fill('GET'));
});

test('does not invent references across fields, lines, negation, quotations or code', () => {
  const texts = [
    ['Closes', '#12'], ['', 'Closes\n#12'], ['', 'Do not close #12'],
    ['', 'This does not fix #12'], ['', 'Closes #12 only after deployment'],
    ['', '> Closes #12'], ['', '"Closes #12"'], ['', "'Closes #12'"],
    ['', '`Closes #12`'], ['', '``Closes #12``'], ['', 'Closes `example` #12'],
    ['', '```text\nCloses #12\n```'], ['', '~~~\nCloses #12\n~~~'],
    ['', '    Closes #12'], ['', '\tCloses #12'], ['', '<!-- Closes #12 -->'],
    ['Closes', 'Fixes another thing #12'], ['', 'Closes other/repo#12'],
  ];
  for (const [title, body] of texts) {
    assert.deepEqual(issueClosureCandidates(issues, [{number: 40, title, body,
      merged_at: '2026-10-02T00:00:00Z', base: {ref: 'main'}}], repository, 'main'), [], JSON.stringify([title, body]));
  }
});

test('reports case-insensitive same-repo declarations without duplicate issue candidates', () => {
  const pulls = [{number: 40, title: 'Fixes #12', body: '- Resolves FREETWAI-AI/freedom-platform#12.\nCloses #12',
    merged_at: '2026-10-02T00:00:00Z', base: {ref: 'main'}}];
  assert.deepEqual(issueClosureCandidates(issues, pulls, repository, 'main'), [{issueNumber: 12, pullNumber: 40}]);
});

test('pagination is read-only, excludes PR issues, and rejects foreign token destinations', async () => {
  let calls = 0;
  const fetcher = async (url, init) => {
    calls++;
    assert.equal(init.method, 'GET');
    if (url.endsWith(`/repos/${repository}`)) return Response.json({default_branch: 'main'});
    if (url.includes('/pulls?')) return Response.json([]);
    if (url.includes('page=2')) return Response.json([{number: 9, state: 'open', pull_request: {}}]);
    return Response.json([], {headers: {link: `<https://api.github.com/repos/${repository}/issues?page=2>; rel="next"`}});
  };
  const result = await reportIssueClosureCandidates({fetcher, token: 'test-token', repository});
  assert.equal(result.scannedIssues, 0);
  assert.equal(calls, 4);
  const foreign = async url => url.endsWith(`/repos/${repository}`) ? Response.json({default_branch: 'main'})
    : Response.json([], {headers: {link: '<https://example.invalid/issues?page=2>; rel="next"'}});
  await assert.rejects(reportIssueClosureCandidates({fetcher: foreign, token: 'test-token', repository}), /Invalid GitHub pagination URL/);
});

test('workflow cannot opt into writes and existing governance discovery includes this file', async () => {
  const workflow = await readFile(new URL('../../../.github/workflows/reconcile-issue-closures.yml', import.meta.url), 'utf8');
  assert.match(workflow, /issues: read/);
  assert.match(workflow, /pull-requests: read/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /: write|dry_run|DRY_RUN|inputs:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /schedule:/);
  const suite = PINNED_SUITES['ci.governance-unit'];
  assert.equal(suite.directory, 'packages/contribution-tools/test');
  assert.equal(suite.pattern.test('reconcile-issue-closures.test.mjs'), true);
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
  assert.deepEqual(result.candidates, [{issueNumber: 12, pullNumber: 40}]);
  assert.deepEqual(calls, ['GET', 'GET', 'GET']);
  assert.equal(currentIssue.state, 'open');
  assert.equal(currentIssue.updated_at, '2026-10-05T00:00:00Z');
});

test('excludes multiline code spans while retaining actual prose after them', () => {
  const pulls = [{number: 40, body: '`example\nCloses #12\nend`\n``example `quoted`\nFixes #14``\nResolves #15',
    merged_at: '2026-10-02T00:00:00Z', base: {ref: 'main'}}];
  assert.deepEqual(issueClosureCandidates(issues, pulls, repository, 'main'), [
    {issueNumber: 15, pullNumber: 40},
  ]);
});
