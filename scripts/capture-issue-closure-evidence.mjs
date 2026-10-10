import {readFile} from 'node:fs/promises';
import {captureMergeEvidence, EVIDENCE_BRANCH} from './reconcile-issue-closures.mjs';

const API = 'https://api.github.com';
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
const runId = Number(process.env.GITHUB_RUN_ID);
const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing ${name}`);
  return value.trim();
}

export async function appendEvidence(record, {repository, token, fetcher = fetch}) {
  const repo = required(repository, 'repository');
  const auth = required(token, 'GitHub token');
  const year = new Date(record.merged_at).getUTCFullYear();
  const recordPath = `records/${year}.json`;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${auth}`,
    'User-Agent': 'Freedom-Platform-issue-evidence-writer',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const api = async (path, {method = 'GET', body, allowNotFound = false, retryConflict = false} = {}) => {
    const response = await fetcher(`${API}/repos/${repo}${path}`, {
      method,
      headers: {...headers, ...(body ? {'Content-Type': 'application/json'} : {})},
      ...(body ? {body: JSON.stringify(body)} : {}),
    });
    if (allowNotFound && response.status === 404) return null;
    if (retryConflict && (response.status === 409 || response.status === 422)) return {conflict: true};
    if (!response.ok) throw new Error(`GitHub evidence write failed: ${method} ${path} (${response.status})`);
    return response.status === 204 ? {} : response.json();
  };

  const sameEvidence = (left, right) => [
    'format', 'repository', 'default_branch', 'pull_request_number', 'merged_at',
    'merge_commit_sha', 'issue_numbers', 'source_text_sha256',
  ].every((key) => JSON.stringify(left[key]) === JSON.stringify(right[key]));

  let previouslyExisted = false;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const ref = await api(`/git/ref/heads/${EVIDENCE_BRANCH}`, {allowNotFound: true});
    if (ref) previouslyExisted = true;
    if (!ref && previouslyExisted) throw new Error('Evidence branch disappeared during append; refusing to recreate it');

    let parentSha;
    let baseTreeSha;
    let index = {format: 'freedom.issue-closure-evidence-year/v1', repository: repo, year, records: []};
    if (ref) {
      parentSha = ref.object.sha;
      const commit = await api(`/git/commits/${parentSha}`);
      baseTreeSha = commit.tree.sha;
      const tree = await api(`/git/trees/${baseTreeSha}?recursive=1`);
      if (tree.truncated || !Array.isArray(tree.tree)) throw new Error('GitHub returned an incomplete evidence branch tree');
      const file = tree.tree.find((entry) => entry.path === recordPath);
      if (file) {
        if (file.type !== 'blob' || file.size > 1_000_000) throw new Error(`Invalid evidence file: ${recordPath}`);
        const blob = await api(`/git/blobs/${file.sha}`);
        if (blob.encoding !== 'base64' || typeof blob.content !== 'string') throw new Error(`Invalid evidence blob: ${recordPath}`);
        index = JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8'));
        if (
          index?.format !== 'freedom.issue-closure-evidence-year/v1'
          || index.repository !== repo
          || index.year !== year
          || !Array.isArray(index.records)
        ) throw new Error(`Invalid evidence index: ${recordPath}`);
      }
    }

    const existing = index.records.find((item) => item.pull_request_number === record.pull_request_number);
    if (existing) {
      if (sameEvidence(existing, record)) return;
      throw new Error(`Refusing to replace existing evidence for PR #${record.pull_request_number}`);
    }
    if (index.records.some((item) => !Number.isSafeInteger(item.pull_request_number) || item.pull_request_number < 1)
      || new Set(index.records.map((item) => item.pull_request_number)).size !== index.records.length) {
      throw new Error(`Invalid or duplicate records in ${recordPath}`);
    }

    index.records.push(record);
    index.records.sort((left, right) => left.pull_request_number - right.pull_request_number);
    const content = `${JSON.stringify(index, null, 2)}\n`;
    const blob = await api('/git/blobs', {method: 'POST', body: {content, encoding: 'utf-8'}});
    const tree = await api('/git/trees', {
      method: 'POST',
      body: {
        ...(baseTreeSha ? {base_tree: baseTreeSha} : {}),
        tree: [{path: recordPath, mode: '100644', type: 'blob', sha: blob.sha}],
      },
    });
    const commit = await api('/git/commits', {
      method: 'POST',
      body: {
        message: `Record merge-time issue-closure evidence for PR #${record.pull_request_number}`,
        tree: tree.sha,
        parents: parentSha ? [parentSha] : [],
      },
    });
    const updated = ref
      ? await api(`/git/refs/heads/${EVIDENCE_BRANCH}`, {
        method: 'PATCH', body: {sha: commit.sha, force: false}, retryConflict: true,
      })
      : await api('/git/refs', {
        method: 'POST', body: {ref: `refs/heads/${EVIDENCE_BRANCH}`, sha: commit.sha}, retryConflict: true,
      });
    if (!updated?.conflict) return;
    await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
  }
  throw new Error('Could not append evidence after concurrent branch updates');
}

async function main() {
  const repo = required(repository, 'repository');
  const auth = required(token, 'GitHub token');
  const eventPath = required(process.env.GITHUB_EVENT_PATH, 'GitHub event path');
  const event = JSON.parse(await readFile(eventPath, 'utf8'));
  const record = captureMergeEvidence(event, repo, {runId, runAttempt});
  if (!record) {
    console.log('No merge-time issue-closure references to record.');
    return;
  }
  await appendEvidence(record, {repository: repo, token: auth});
  console.log(`Recorded merge-time issue-closure evidence for PR #${record.pull_request_number}.`);
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
