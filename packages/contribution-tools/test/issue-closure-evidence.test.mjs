import assert from 'node:assert/strict';
import {test} from 'node:test';
import {appendEvidence} from '../../../scripts/capture-issue-closure-evidence.mjs';
import {EVIDENCE_BRANCH} from '../../../scripts/reconcile-issue-closures.mjs';

const repository = 'FreeTWAI-AI/freedom-platform';
const record = (number, issueNumber = number) => ({
  format: 'freedom.issue-closure-evidence/v1',
  repository,
  default_branch: 'main',
  pull_request_number: number,
  merged_at: '2026-10-02T00:00:00Z',
  merge_commit_sha: number.toString(16).padStart(40, '0'),
  issue_numbers: [issueNumber],
  source_text_sha256: 'a'.repeat(64),
  capture_run_id: 100,
  capture_run_attempt: 1,
});
const json = (body, status = 200) => new Response(JSON.stringify(body), {status});
const annualIndex = (records) => ({
  format: 'freedom.issue-closure-evidence-year/v1',
  repository,
  year: 2026,
  records,
});

function existingBranchFetch(index, calls) {
  const content = `${JSON.stringify(index, null, 2)}\n`;
  return async (url, init = {}) => {
    const path = String(url).replace(`https://api.github.com/repos/${repository}`, '');
    calls.push({path, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined});
    if (path === `/git/ref/heads/${EVIDENCE_BRANCH}`) return json({object: {sha: 'parent-sha'}});
    if (path === '/git/commits/parent-sha') return json({tree: {sha: 'base-tree'}});
    if (path === '/git/trees/base-tree?recursive=1') {
      return json({truncated: false, tree: [{path: 'records/2026.json', type: 'blob', size: Buffer.byteLength(content), sha: 'index-blob'}]});
    }
    if (path === '/git/blobs/index-blob') {
      return json({encoding: 'base64', content: Buffer.from(content).toString('base64')});
    }
    if (path === '/git/blobs' && init.method === 'POST') return json({sha: 'new-blob'});
    if (path === '/git/trees' && init.method === 'POST') return json({sha: 'new-tree'});
    if (path === '/git/commits' && init.method === 'POST') return json({sha: 'new-commit'});
    if (path === `/git/refs/heads/${EVIDENCE_BRANCH}` && init.method === 'PATCH') return json({ref: `refs/heads/${EVIDENCE_BRANCH}`});
    throw new Error(`Unexpected request: ${path}`);
  };
}

test('creates an append-only evidence branch with a root commit', async () => {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const path = String(url).replace(`https://api.github.com/repos/${repository}`, '');
    calls.push({path, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined});
    if (path === `/git/ref/heads/${EVIDENCE_BRANCH}`) return json({}, 404);
    if (path === '/git/blobs') return json({sha: 'new-blob'});
    if (path === '/git/trees') return json({sha: 'new-tree'});
    if (path === '/git/commits') return json({sha: 'new-commit'});
    if (path === '/git/refs') return json({ref: `refs/heads/${EVIDENCE_BRANCH}`});
    throw new Error(`Unexpected request: ${path}`);
  };
  await appendEvidence(record(40, 12), {repository, token: 'test-token', fetcher});
  const commit = calls.find((call) => call.path === '/git/commits');
  assert.deepEqual(commit.body.parents, []);
  assert.deepEqual(calls.find((call) => call.path === '/git/refs').body, {
    ref: `refs/heads/${EVIDENCE_BRANCH}`,
    sha: 'new-commit',
  });
});

test('is idempotent for an existing identical record and refuses to replace it', async () => {
  const existing = record(40, 12);
  const calls = [];
  await appendEvidence(existing, {repository, token: 'test-token', fetcher: existingBranchFetch(annualIndex([existing]), calls)});
  assert.equal(calls.length, 4);
  await assert.rejects(
    appendEvidence(record(40, 13), {repository, token: 'test-token', fetcher: existingBranchFetch(annualIndex([existing]), [])}),
    /Refusing to replace existing evidence/u,
  );
});

test('retries a concurrent ref update and appends without replacing the first record', async () => {
  const first = record(40, 12);
  const second = record(41, 13);
  const calls = [];
  let firstCreate = true;
  const fetcher = async (url, init = {}) => {
    const path = String(url).replace(`https://api.github.com/repos/${repository}`, '');
    calls.push({path, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined});
    if (path === `/git/ref/heads/${EVIDENCE_BRANCH}`) {
      return firstCreate ? json({}, 404) : json({object: {sha: 'concurrent-parent'}});
    }
    if (path === '/git/blobs' && init.method === 'POST') return json({sha: 'new-blob'});
    if (path === '/git/trees' && init.method === 'POST') return json({sha: 'new-tree'});
    if (path === '/git/commits/concurrent-parent') return json({tree: {sha: 'concurrent-tree'}});
    if (path === '/git/trees/concurrent-tree?recursive=1') {
      return json({truncated: false, tree: [{path: 'records/2026.json', type: 'blob', size: 1000, sha: 'concurrent-index'}]});
    }
    if (path === '/git/blobs/concurrent-index') {
      return json({encoding: 'base64', content: Buffer.from(JSON.stringify(annualIndex([first]))).toString('base64')});
    }
    if (path === '/git/commits' && init.method === 'POST') return json({sha: 'new-commit'});
    if (path === '/git/refs' && init.method === 'POST' && firstCreate) {
      firstCreate = false;
      return json({message: 'Reference already exists'}, 422);
    }
    if (path === `/git/refs/heads/${EVIDENCE_BRANCH}` && init.method === 'PATCH') return json({ref: `refs/heads/${EVIDENCE_BRANCH}`});
    throw new Error(`Unexpected request: ${path}`);
  };
  await appendEvidence(second, {repository, token: 'test-token', fetcher});
  const commit = calls.filter((call) => call.path === '/git/commits' && call.method === 'POST').at(-1);
  assert.deepEqual(commit.body.parents, ['concurrent-parent']);
  const tree = calls.filter((call) => call.path === '/git/trees' && call.method === 'POST').at(-1);
  assert.equal(tree.body.base_tree, 'concurrent-tree');
  const update = calls.find((call) => call.method === 'PATCH');
  assert.deepEqual(update.body, {sha: 'new-commit', force: false});
});

test('refuses to append an index that would exceed the byte limit', async () => {
  const maximumBytes = 1_000_000;
  const first = record(1_000_000);
  const second = record(1_000_001);
  const emptySize = Buffer.byteLength(`${JSON.stringify(annualIndex([]), null, 2)}\n`);
  const oneSize = Buffer.byteLength(`${JSON.stringify(annualIndex([first]), null, 2)}\n`);
  const twoSize = Buffer.byteLength(`${JSON.stringify(annualIndex([first, second]), null, 2)}\n`);
  const perRecordBytes = twoSize - oneSize;
  const existingCount = Math.floor((maximumBytes - oneSize) / perRecordBytes) + 1;
  const existingRecords = Array.from({length: existingCount}, (_, index) => record(1_000_000 + index));
  const existingSize = Buffer.byteLength(`${JSON.stringify(annualIndex(existingRecords), null, 2)}\n`);
  const appendedSize = Buffer.byteLength(`${JSON.stringify(annualIndex([...existingRecords, record(2_000_000)]), null, 2)}\n`);
  assert.ok(emptySize < oneSize);
  assert.ok(existingSize <= maximumBytes);
  assert.ok(appendedSize > maximumBytes);

  const calls = [];
  await assert.rejects(
    appendEvidence(record(2_000_000), {
      repository,
      token: 'test-token',
      fetcher: existingBranchFetch(annualIndex(existingRecords), calls),
    }),
    /Evidence file exceeds the size limit/u,
  );
  assert.ok(calls.every((call) => call.method === 'GET'));
});
