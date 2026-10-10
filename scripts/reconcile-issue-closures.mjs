const API = 'https://api.github.com';
// Deliberately conservative: a standalone declaration, never general prose.
const CLOSING_KEYWORD = /^ {0,3}(?:[-*+] )?(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)[ \t]+(?:([a-z0-9_.-]+\/[a-z0-9_.-]+))?#([1-9]\d*)[.!]?[ \t]*$/iu;

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
  for (const line of text.replace(/<!--[\s\S]*?-->/gu, comment => '\n'.repeat(comment.split('\n').length - 1)).split('\n')) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
    if (marker) {
      if (!fence) fence = {character: marker[0], length: marker.length};
      else if (marker[0] === fence.character && marker.length >= fence.length) fence = null;
      continue;
    }
    if (!fence && !/^(?: {4}|\t| {0,3}>)/u.test(line)) lines.push(line);
  }
  return lines.join('\n').replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/gu, span =>
    '``' + '\n'.repeat(span.split('\n').length - 1) + '``');
}

function matchingIssueNumbers(text, repository) {
  const numbers = new Set();
  for (const line of markdownProse(text).split('\n')) {
    const match = line.match(CLOSING_KEYWORD);
    if (match && (!match[1] || match[1].toLowerCase() === repository.toLowerCase())
      && Number.isSafeInteger(Number(match[2]))) numbers.add(Number(match[2]));
  }
  return numbers;
}

export function issueClosureCandidates(issues, pullRequests, repository, defaultBranch) {
  const mergedClosers = new Map();
  for (const pull of pullRequests) {
    if (!pull.merged_at || pull.base?.ref !== defaultBranch) continue;
    // Never synthesize a declaration across the title/body boundary.
    const numbers = new Set([pull.title ?? '', pull.body ?? ''].flatMap(text => [...matchingIssueNumbers(text, repository)]));
    for (const number of numbers) {
      const mergedAt = Date.parse(pull.merged_at);
      if (!Number.isFinite(mergedAt)) continue;
      const current = mergedClosers.get(number);
      if (!current || mergedAt > current.mergedAt) mergedClosers.set(number, {mergedAt, pullNumber: pull.number});
    }
  }
  return issues.flatMap((issue) => {
    const closer = mergedClosers.get(issue.number);
    const updatedAt = Date.parse(issue.updated_at);
    if (issue.state !== 'open' || !closer || !Number.isFinite(updatedAt) || updatedAt > closer.mergedAt) return [];
    return [{issueNumber: issue.number, pullNumber: closer.pullNumber}];
  });
}

export async function reportIssueClosureCandidates({fetcher = fetch, token, repository}) {
  token = requireInput(token, 'GitHub token');
  repository = requireInput(repository, 'repository');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new Error('Invalid repository');

  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'Freedom-Platform-issue-reconciler',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const request = async (url) => {
    // Pagination cannot send the read token outside this repository.
    const target = new URL(url);
    if (target.origin !== API || (!target.pathname.startsWith(`/repos/${repository}/`)
      && target.pathname !== `/repos/${repository}`) || target.username || target.password) throw new Error('Invalid GitHub pagination URL');
    const response = await fetcher(url, {method: 'GET', headers, redirect: 'error'});
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

  const [allIssues, pullRequests] = await Promise.all([
    getAll('/issues?state=open&per_page=100'),
    getAll('/pulls?state=all&per_page=100'),
  ]);
  const issues = allIssues.filter((issue) => !issue.pull_request && issue.state === 'open');
  const candidates = issueClosureCandidates(issues, pullRequests, repository, repo.default_branch);
  // Mutable PR wording and timestamps are discovery hints, never completion proof.
  return {scannedIssues: issues.length, scannedPullRequests: pullRequests.length,
    mode: 'report-only', criteriaVerified: false, candidates};
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const result = await reportIssueClosureCandidates({
    token: process.env.GH_TOKEN,
    repository: process.env.GITHUB_REPOSITORY,
  });
  console.log(JSON.stringify(result));
}
