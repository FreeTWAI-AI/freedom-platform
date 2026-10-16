// Native OAuth status substitution only; no provider credentials or dispatch.
import { readFile, appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
export const REPOSITORY = 'FreeTWAI/freedom-platform';
export const CONTEXT = 'ci/circleci: worker-unit';
const sha = /^[0-9a-f]{40}$/;
function requireValue(ok) { if (!ok) throw Error('worker_status_unavailable'); }
export function eligibleCandidate({ eventName, repository, integrationSha, event }) {
  requireValue(repository === REPOSITORY && sha.test(integrationSha));
  if (eventName !== 'pull_request') return null;
  const pr = event?.pull_request;
  requireValue(pr && pr.base?.repo?.full_name === REPOSITORY && sha.test(pr.head?.sha));
  if (pr.head.repo?.full_name !== REPOSITORY || pr.head.repo?.fork !== false) return null;
  return pr.head.sha;
}
export function newestWorkerStatus(statuses, headSha, now = Date.now()) {
  requireValue(sha.test(headSha) && Array.isArray(statuses));
  const matches = statuses.filter(s => s.context === CONTEXT);
  if (!matches.length) return 'pending';
  // Select newest context FIRST: never fall back to an older trusted success.
  for (const s of matches) requireValue(Number.isSafeInteger(s.id) && s.id > 0 && Number.isFinite(Date.parse(s.created_at)));
  matches.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  const s = matches[0];
  requireValue(s.creator?.id === 233386770 && s.creator?.login === 'teddashh' && s.creator?.type === 'User' &&
    s.url === `https://api.github.com/repos/${REPOSITORY}/statuses/${headSha}` &&
    /^https:\/\/circleci\.com\/gh\/FreeTWAI\/freedom-platform\/[1-9][0-9]*$/.test(s.target_url) &&
    Date.parse(s.created_at) <= now + 300000 && ['pending', 'success', 'failure', 'error'].includes(s.state));
  requireValue(new Set(matches.map(s => s.id)).size === matches.length);
  return s.state;
}
export async function workerStatusDecision({ eventName, repository, integrationSha, event, get, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, waitMs = 900000 }) {
  requireValue(Number.isSafeInteger(waitMs) && waitMs >= 0 && waitMs <= 900000);
  const head = eligibleCandidate({ eventName, repository, integrationSha, event });
  if (!head) return { runGithub: true, reason: 'non_pr_or_fork' };
  const commits = await Promise.all([get(`/git/commits/${head}`), get(`/git/commits/${integrationSha}`)]);
  for (let i = 0; i < 2; i++) requireValue(commits[i]?.sha === [head, integrationSha][i] && sha.test(commits[i]?.tree?.sha));
  if (commits[0].tree.sha !== commits[1].tree.sha) return { runGithub: true, reason: 'different_integration_tree' };
  const deadline = now() + waitMs;
  for (;;) {
    // GitHub returns reverse chronological statuses, including earlier attempts.
    // Bounded pagination: a missing status never becomes success.
    let rows = [], complete = false;
    for (let page = 1; page <= 5; page++) {
      const batch = await get(`/commits/${head}/statuses?per_page=100&page=${page}`);
      requireValue(Array.isArray(batch) && batch.length <= 100);
      rows.push(...batch);
      if (batch.some(s => s.context === CONTEXT) || batch.length < 100) { complete = true; break; }
    }
    requireValue(complete);
    const state = newestWorkerStatus(rows, head, now());
    if (state === 'success') return { runGithub: false, reason: 'circleci_success_equal_tree', headSha: head, integrationSha, treeSha: commits[0].tree.sha };
    if (state !== 'pending') throw Error('circleci_worker_failed');
    if (now() >= deadline) throw Error('circleci_worker_pending_timeout');
    await sleep(Math.min(15000, deadline - now()));
  }
}
export function githubReader(token, fetchImpl = fetch) {
  requireValue(typeof token === 'string' && token.length > 0);
  return async path => {
    requireValue(/^\/(git\/commits\/[0-9a-f]{40}|commits\/[0-9a-f]{40}\/statuses\?per_page=100&page=[1-5])$/.test(path));
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const url = `https://api.github.com/repos/${REPOSITORY}${path}`;
      const r = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, redirect: 'error', signal: controller.signal });
      requireValue(r.status === 200 && !r.redirected && (!r.url || r.url === url));
      let bytes = 0; const chunks = [];
      for await (const chunk of r.body) { bytes += chunk.length; requireValue(bytes <= 2000000); chunks.push(chunk); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw Error('worker_status_unavailable'); } finally { clearTimeout(timer); }
  };
}
async function main() {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const result = await workerStatusDecision({ eventName: process.env.GITHUB_EVENT_NAME, repository: process.env.GITHUB_REPOSITORY,
    integrationSha: process.env.GITHUB_SHA, event, get: githubReader(process.env.GH_STATUS_TOKEN) });
  await appendFile(process.env.GITHUB_OUTPUT, `run_github=${result.runGithub}\n`);
  process.stdout.write(JSON.stringify(result) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { process.stderr.write('worker_status_gate_failed\n'); process.exitCode = 1; });
