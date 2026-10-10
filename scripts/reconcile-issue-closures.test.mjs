import assert from 'node:assert/strict';
import {test} from 'node:test';
import {captureMergeEvidence, closeableIssues, reconcileIssueClosures} from './reconcile-issue-closures.mjs';

const repository = 'FreeTWAI-AI/freedom-platform';
const mergedAt = '2026-10-02T00:00:00Z';
const sha = (number) => number.toString(16).padStart(40, '0');
const evidence = (pullNumber, issueNumbers, date = mergedAt) => ({
  format: 'freedom.issue-closure-evidence/v1',
  repository,
  default_branch: 'main',
  pull_request_number: pullNumber,
  merged_at: date,
  merge_commit_sha: sha(pullNumber),
  issue_numbers: issueNumbers,
  source_text_sha256: 'a'.repeat(64),
  capture_run_id: 1,
  capture_run_attempt: 1,
});
const pull = (number, date = mergedAt, ref = 'main', body = '') => ({
  number,
  title: 'Current editable PR title',
  body,
  merged_at: date,
  merge_commit_sha: sha(number),
  base: {ref},
});
const issue = (number, date = '2026-10-01T00:00:00Z') => ({number, state: 'open', updated_at: date});
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {'Content-Type': 'application/json'},
});

function evidenceApi(record) {
  const yearFile = {
    format: 'freedom.issue-closure-evidence-year/v1',
    repository,
    year: 2026,
    records: [record],
  };
  return async (url, init = {}) => {
    if (init.method === 'PATCH') return json({});
    if (String(url).endsWith(`/repos/${repository}`)) return json({default_branch: 'main'});
    if (String(url).includes('/issues?')) return json([issue(12)]);
    if (String(url).endsWith('/issues/12')) return json(issue(12));
    if (String(url).includes('/pulls?')) return json([pull(record.pull_request_number, record.merged_at, 'main', 'Edited after merge: Closes #12')]);
    if (String(url).endsWith('/git/ref/heads/issue-closure-evidence')) return json({object: {sha: 'commit-sha'}});
    if (String(url).endsWith('/git/commits/commit-sha')) return json({tree: {sha: 'tree-sha'}});
    if (String(url).endsWith('/git/trees/tree-sha?recursive=1')) {
      return json({truncated: false, tree: [{path: 'records/2026.json', type: 'blob', size: 100, sha: 'blob-sha'}]});
    }
    if (String(url).endsWith('/git/blobs/blob-sha')) {
      return json({encoding: 'base64', content: Buffer.from(JSON.stringify(yearFile)).toString('base64')});
    }
    throw new Error(`Unexpected request: ${url}`);
  };
}

test('captures only merge-time closure references from a merged default-branch PR event', () => {
  const event = {
    action: 'closed',
    repository: {full_name: repository, default_branch: 'main'},
    pull_request: {
      number: 40,
      merged: true,
      merged_at: mergedAt,
      merge_commit_sha: sha(40),
      title: 'Fixes #12',
      body: 'Closes #14 and FreeTWAI-AI/other#15; `Closes #16`',
      base: {ref: 'main', repo: {full_name: repository}},
    },
  };
  const record = captureMergeEvidence(event, repository, {runId: 100, runAttempt: 1});
  assert.deepEqual(record.issue_numbers, [12, 14]);
  assert.equal(record.pull_request_number, 40);
  assert.equal(record.merge_commit_sha, sha(40));
  assert.equal(captureMergeEvidence({...event, pull_request: {...event.pull_request, merged: false}}, repository, {runId: 100, runAttempt: 1}), null);
  assert.equal(captureMergeEvidence({...event, pull_request: {...event.pull_request, base: {ref: 'release', repo: {full_name: repository}}}}, repository, {runId: 100, runAttempt: 1}), null);
  const splitClosingReference = captureMergeEvidence({
    ...event,
    pull_request: {...event.pull_request, title: 'Maintenance fixes', body: '#13 unrelated reference'},
  }, repository, {runId: 100, runAttempt: 1});
  assert.equal(splitClosingReference, null);
  const invalidReferences = captureMergeEvidence({
    ...event,
    pull_request: {...event.pull_request, title: 'Closes #0', body: 'Fixes #9007199254740993'},
  }, repository, {runId: 100, runAttempt: 1});
  assert.equal(invalidReferences, null);
  const mixedReferences = captureMergeEvidence({
    ...event,
    pull_request: {...event.pull_request, title: '', body: 'Closes #14 and Closes #0'},
  }, repository, {runId: 100, runAttempt: 1});
  assert.deepEqual(mixedReferences.issue_numbers, [14]);
});

test('only closes issues recorded at merge for a PR merged to the default branch', () => {
  const pulls = [
    pull(40, mergedAt),
    pull(41, null),
    pull(42, '2026-10-04T00:00:00Z', 'release'),
    pull(43, mergedAt),
    pull(44, '2026-10-05T00:00:00Z'),
    pull(45, mergedAt),
    pull(46, mergedAt),
    pull(47, mergedAt),
    pull(48, mergedAt),
  ];
  const issues = [issue(12), issue(13, '2026-10-03T00:00:00Z'), issue(14), issue(15),
    {...issue(16), state: 'closed'}, issue(17)];
  assert.deepEqual(closeableIssues(issues, pulls, [evidence(40, [12, 14]), evidence(45, [15])], repository, 'main'), [
    {issueNumber: 12, pullNumber: 40},
    {issueNumber: 14, pullNumber: 40},
    {issueNumber: 15, pullNumber: 45},
  ]);
});

test('ignores a closing keyword added to the editable PR body after merge', () => {
  const result = closeableIssues(
    [issue(12), issue(13)],
    [pull(40, mergedAt, 'main', 'Edited after merge: Closes #12')],
    [evidence(40, [13])],
    repository,
    'main',
  );
  assert.deepEqual(result, [{issueNumber: 13, pullNumber: 40}]);
  assert.deepEqual(closeableIssues([issue(12)], [pull(40, mergedAt, 'main', 'Closes #12')], [], repository, 'main'), []);
});

test('does not re-close an issue updated after the merge-time evidence', () => {
  const candidate = closeableIssues(
    [issue(12, '2026-10-03T00:00:00Z')],
    [pull(40)],
    [evidence(40, [12])],
    repository,
    'main',
  );
  assert.deepEqual(candidate, []);
});

test('does not close an issue updated in the same timestamp second as merge', () => {
  const candidate = closeableIssues(
    [issue(12, mergedAt)],
    [pull(40)],
    [evidence(40, [12])],
    repository,
    'main',
  );
  assert.deepEqual(candidate, []);
});

test('dry-run reads merge-time evidence without writing issue state', async () => {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({url: String(url), method: init.method ?? 'GET'});
    return evidenceApi(evidence(40, [12]))(url, init);
  };
  const result = await reconcileIssueClosures({fetcher, token: 'test-token', repository, dryRun: true});
  assert.deepEqual(result, {
    scannedIssues: 1,
    scannedPullRequests: 1,
    dryRun: true,
    closed: [{issueNumber: 12, pullNumber: 40}],
  });
  assert.ok(calls.every((call) => call.method === 'GET'));
});

test('closes an issue only when merge-time evidence matches the merged PR', async () => {
  const writes = [];
  const fetcher = async (url, init = {}) => {
    if (init.method === 'PATCH') writes.push({url: String(url), body: JSON.parse(init.body)});
    return evidenceApi(evidence(40, [12]))(url, init);
  };
  const result = await reconcileIssueClosures({fetcher, token: 'test-token', repository});
  assert.deepEqual(result.closed, [{issueNumber: 12, pullNumber: 40}]);
  assert.deepEqual(writes, [{
    url: `https://api.github.com/repos/${repository}/issues/12`,
    body: {state: 'closed', state_reason: 'completed'},
  }]);
});

test('rechecks issue state immediately before mutation', async () => {
  const writes = [];
  const fetcher = async (url, init = {}) => {
    if (String(url).endsWith('/issues/12') && !init.method) return json(issue(12, '2026-10-03T00:00:00Z'));
    if (init.method === 'PATCH') writes.push(String(url));
    return evidenceApi(evidence(40, [12]))(url, init);
  };
  const result = await reconcileIssueClosures({fetcher, token: 'test-token', repository});
  assert.deepEqual(result.closed, []);
  assert.deepEqual(writes, []);
});
