import {createHash} from 'node:crypto';
export const EVIDENCE_BRANCH = 'issue-closure-evidence';
const API = 'https://api.github.com';
const CLOSING_KEYWORD = /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s+(?:([a-z0-9_.-]+\/[a-z0-9_.-]+))?#(\d+)\b/giu;

function requireInput(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing ${name}`);
  return value.trim();
}

function paginationLinks(value) {
  return [...(value ?? '').matchAll(/<([^>]+)>;\s*rel="([^"]+)"/gu)].map((match) => [match[2], match[1]]);
}

function markdownProse(text) {
  let fence = null;
  const lines = [];
  for (const line of text.replace(/<!--[\s\S]*?-->/gu, '').split('\n')) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
    if (marker) {
      if (!fence) fence = {character: marker[0], length: marker.length};
      else if (marker[0] === fence.character && marker.length >= fence.length) fence = null;
      continue;
    }
    if (!fence && !/^(?: {4}|\t)/u.test(line)) lines.push(line.replace(/(`+)[^`\n]*?\1/gu, ''));
  }
  return lines.join('\n');
}

function matchingIssueNumbers(text, repository) {
  const numbers = new Set();
  CLOSING_KEYWORD.lastIndex = 0;
  for (const match of markdownProse(text).matchAll(CLOSING_KEYWORD)) {
    const number = Number(match[2]);
    if (
      (!match[1] || match[1].toLowerCase() === repository.toLowerCase())
      && Number.isSafeInteger(number)
      && number > 0
    ) numbers.add(number);
  }
  return numbers;
}

export function captureMergeEvidence(event, repository, {runId, runAttempt} = {}) {
  const pull = event?.pull_request;
  const defaultBranch = event?.repository?.default_branch;
  if (
    event?.action !== 'closed'
    || !pull?.merged
    || event.repository?.full_name !== repository
    || pull.base?.repo?.full_name !== repository
    || pull.base?.ref !== defaultBranch
    || !Number.isSafeInteger(pull.number)
    || pull.number < 1
    || !/^[a-f0-9]{40}$/iu.test(pull.merge_commit_sha ?? '')
    || !Number.isFinite(Date.parse(pull.merged_at))
    || !Number.isSafeInteger(runId)
    || runId < 1
    || !Number.isSafeInteger(runAttempt)
    || runAttempt < 1
  ) return null;

  const title = pull.title ?? '';
  const body = pull.body ?? '';
  const text = `${title}\n${body}`;
  const issueNumbers = [...new Set([
    ...matchingIssueNumbers(title, repository),
    ...matchingIssueNumbers(body, repository),
  ])].sort((a, b) => a - b);
  if (issueNumbers.length === 0) return null;
  return {
    format: 'freedom.issue-closure-evidence/v1',
    repository,
    default_branch: defaultBranch,
    pull_request_number: pull.number,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha.toLowerCase(),
    issue_numbers: issueNumbers,
    source_text_sha256: createHash('sha256').update(text).digest('hex'),
    capture_run_id: runId,
    capture_run_attempt: runAttempt,
  };
}

function validateEvidenceRecord(record, repository, year) {
  if (
    record?.format !== 'freedom.issue-closure-evidence/v1'
    || record.repository !== repository
    || typeof record.default_branch !== 'string'
    || !record.default_branch
    || !Number.isSafeInteger(record.pull_request_number)
    || record.pull_request_number < 1
    || !Number.isFinite(Date.parse(record.merged_at))
    || new Date(record.merged_at).getUTCFullYear() !== year
    || !/^[a-f0-9]{40}$/iu.test(record.merge_commit_sha)
    || !/^[a-f0-9]{64}$/iu.test(record.source_text_sha256)
    || !Number.isSafeInteger(record.capture_run_id)
    || record.capture_run_id < 1
    || !Number.isSafeInteger(record.capture_run_attempt)
    || record.capture_run_attempt < 1
    || !Array.isArray(record.issue_numbers)
    || record.issue_numbers.length === 0
    || record.issue_numbers.some((number, index) =>
      !Number.isSafeInteger(number) || number < 1 || (index > 0 && number <= record.issue_numbers[index - 1]))
  ) throw new Error(`Invalid merge-time closure evidence for ${repository}`);
}
async function readMergeEvidence(request, repository) {
  const refUrl = `${API}/repos/${repository}/git/ref/heads/${EVIDENCE_BRANCH}`;
  const refResponse = await request(refUrl, undefined, {allowNotFound: true});
  if (refResponse.status === 404) return [];
  const ref = await refResponse.json();
  const commit = await (await request(`${API}/repos/${repository}/git/commits/${ref.object.sha}`)).json();
  const tree = await (await request(`${API}/repos/${repository}/git/trees/${commit.tree.sha}?recursive=1`)).json();
  if (tree.truncated || !Array.isArray(tree.tree)) throw new Error('GitHub returned an incomplete closure evidence tree');

  const records = [];
  const seenPulls = new Set();
  for (const entry of tree.tree) {
    const match = /^records\/(20\d{2})\.json$/u.exec(entry.path);
    if (!match) continue;
    const year = Number(match[1]);
    if (entry.type !== 'blob' || entry.size > 1_000_000) throw new Error(`Invalid closure evidence file: ${entry.path}`);
    const blob = await (await request(`${API}/repos/${repository}/git/blobs/${entry.sha}`)).json();
    if (blob.encoding !== 'base64' || typeof blob.content !== 'string') throw new Error(`Invalid closure evidence blob: ${entry.path}`);
    const file = JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8'));
    if (
      file?.format !== 'freedom.issue-closure-evidence-year/v1'
      || file.repository !== repository
      || file.year !== year
      || !Array.isArray(file.records)
    ) throw new Error(`Invalid closure evidence index: ${entry.path}`);
    for (const record of file.records) {
      validateEvidenceRecord(record, repository, year);
      if (seenPulls.has(record.pull_request_number)) throw new Error('Duplicate merge-time closure evidence');
      seenPulls.add(record.pull_request_number);
      records.push(record);
    }
  }
  return records;
}


export function closeableIssues(issues, pullRequests, evidenceRecords, repository, defaultBranch) {
  const evidenceByPull = new Map();
  for (const record of evidenceRecords) {
    if (evidenceByPull.has(record.pull_request_number)) throw new Error('Duplicate merge-time closure evidence');
    evidenceByPull.set(record.pull_request_number, record);
  }
  const mergedClosers = new Map();
  for (const pull of pullRequests) {
    const evidence = evidenceByPull.get(pull.number);
    if (
      !evidence
      || evidence.repository !== repository
      || evidence.default_branch !== defaultBranch
      || evidence.merge_commit_sha !== pull.merge_commit_sha?.toLowerCase()
      || evidence.merged_at !== pull.merged_at
      || pull.base?.ref !== defaultBranch
    ) continue;
    const mergedAt = Date.parse(evidence.merged_at);
    if (!Number.isFinite(mergedAt)) continue;
    for (const number of evidence.issue_numbers) {
      const current = mergedClosers.get(number);
      if (!current || mergedAt > current.mergedAt) mergedClosers.set(number, {mergedAt, pullNumber: pull.number});
    }
  }
  return issues.flatMap((issue) => {
    const closer = mergedClosers.get(issue.number);
    const updatedAt = Date.parse(issue.updated_at);
    if (issue.state !== 'open' || !closer || !Number.isFinite(updatedAt) || updatedAt >= closer.mergedAt) return [];
    return [{issueNumber: issue.number, pullNumber: closer.pullNumber}];
  });
}

export async function reconcileIssueClosures({fetcher = fetch, token, repository, dryRun = false}) {
  token = requireInput(token, 'GitHub token');
  repository = requireInput(repository, 'repository');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new Error('Invalid repository');

  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'Freedom-Platform-issue-reconciler',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const request = async (url, init, {allowNotFound = false} = {}) => {
    const response = await fetcher(url, { ...init, headers: {...headers, ...init?.headers} });
    if (allowNotFound && response.status === 404) return response;
    if (!response.ok) throw new Error(`GitHub issue reconciliation failed: ${response.status}`);
    return response;
  };
  const getAll = async (path) => {
    const items = [];
    let url = `${API}/repos/${repository}${path}`;
    while (url) {
      const response = await request(url);
      const page = await response.json();
      if (!Array.isArray(page)) throw new Error('GitHub returned an invalid list');
      items.push(...page);
      url = paginationLinks(response.headers.get('link')).find(([rel]) => rel === 'next')?.[1] ?? '';
    }
    return items;
  };

  const repoResponse = await request(`${API}/repos/${repository}`);
  const repo = await repoResponse.json();
  if (typeof repo.default_branch !== 'string' || !repo.default_branch) throw new Error('GitHub returned no default branch');

  const [allIssues, pullRequests, evidenceRecords] = await Promise.all([
    getAll('/issues?state=open&per_page=100'),
    getAll('/pulls?state=all&per_page=100'),
    readMergeEvidence(request, repository),
  ]);
  const issues = allIssues.filter((issue) => !issue.pull_request && issue.state === 'open');
  const candidates = closeableIssues(issues, pullRequests, evidenceRecords, repository, repo.default_branch);
  const closed = [];
  for (const candidate of candidates) {
    const latestResponse = await request(`${API}/repos/${repository}/issues/${candidate.issueNumber}`);
    const latestIssue = await latestResponse.json();
    const stillCloseable = !latestIssue.pull_request && closeableIssues(
      [latestIssue],
      pullRequests,
      evidenceRecords,
      repository,
      repo.default_branch,
    ).some((current) => current.issueNumber === candidate.issueNumber && current.pullNumber === candidate.pullNumber);
    if (!stillCloseable) continue;
    if (!dryRun) {
      await request(`${API}/repos/${repository}/issues/${candidate.issueNumber}`, {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({state: 'closed', state_reason: 'completed'}),
      });
    }
    closed.push(candidate);
  }
  return {scannedIssues: issues.length, scannedPullRequests: pullRequests.length, dryRun, closed};
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const result = await reconcileIssueClosures({
    token: process.env.GH_TOKEN,
    repository: process.env.GITHUB_REPOSITORY,
    dryRun: process.env.DRY_RUN === 'true',
  });
  console.log(JSON.stringify(result));
}
