import {z} from 'zod';
import type {Pool, PoolClient} from 'pg';
import {Problem} from '../../packages/shared/problem.js';
import {readGitHub, githubCoordinate, type GitHubRead} from '../opensource-marketing/github.js';
import {communityCatalog} from './catalog.js';
import {authorOf, cleanTitle, GITHUB_HISTORY_PAGE_CAP, GITHUB_REPOSITORY_NAME} from './github-history.js';
import repositorySet from '../../repositories.lock.json' with {type:'json'};

export const GITHUB_SYNC_REQUEST_BUDGET = 40;
const SUCCESS_MS = 10 * 60 * 1000;
const REPO_ERROR_MS = 15 * 60 * 1000;
const UNREADABLE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_RATE_MS = 15 * 60 * 1000;
const MAX_RATE_MS = 60 * 60 * 1000;
const MIN_RATE_MS = 1000;
const date = z.iso.datetime({offset: true});
const syncItemSchema = z.object({
  number: z.number().int().positive().max(1000000000),
  title: z.string().max(1000),
  state: z.enum(['open', 'closed']),
  state_reason: z.string().max(100).nullable().optional(),
  user: z.object({login: z.string()}).nullable().optional(),
  created_at: date,
  updated_at: date,
  closed_at: date.nullable().optional(),
  pull_request: z.object({merged_at: date.nullable().optional()}).nullable().optional(),
});
type SyncItem = z.infer<typeof syncItemSchema>;
type StoredItem = {
  number: number; kind: 'issue' | 'pr'; title: string; author_login: string | null; state: 'open' | 'closed';
  state_reason: string | null; merged_at: string | null; created_at: string; updated_at: string; closed_at: string | null;
};
type RepoRow = {
  repository_key: string; repository: string; since: Date | null; etag: string | null; etag_query: string | null;
  backfilled: boolean; access_status: string; next_sync_at: Date;
};
type Outcome = 'continue' | 'rate_limited' | 'budget';
type Run = {
  requests: number; items_upserted: number; not_modified: number; budget: number;
  token: string | undefined; warned: boolean; fetcher: typeof fetch; now: () => number;
};

export type GitHubSyncOptions = {fetcher?: typeof fetch; token?: string; now?: () => number; budget?: number};
export type GitHubSyncSummary = {
  requests: number; repositories: number; items_upserted: number; not_modified: number;
  stop_reason: 'completed' | 'budget' | 'rate_limited';
};

export async function trackedGitHubRepositories(pool: Pool): Promise<{key: string; name: string}[]> {
  const oss = await pool.query<{repository_full_name: string}>('SELECT repository_full_name FROM oss_projects');
  const byKey = new Map<string, string>();
  const add = (value: string) => {
    if (!GITHUB_REPOSITORY_NAME.test(value)) return;
    const key = value.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, value);
  };
  add('FreeTWAI-AI/freedom-platform');
  for (const entry of repositorySet.repositories) add(entry.repository);
  for (const book of communityCatalog.skill_books) {
    try { add(githubCoordinate(book.upstream_url || book.repository_url)); } catch { /* A catalog entry without a GitHub source is not synced. */ }
  }
  for (const row of oss.rows) add(row.repository_full_name);
  return [...byKey.entries()].map(([key, name]) => ({key, name}));
}

function issuesPath(repository: string, page: number, since: Date | null) {
  const [owner, name] = repository.split('/');
  const params = new URLSearchParams({state: 'all', sort: 'updated', direction: 'asc', per_page: '100', page: String(page)});
  if (since) params.set('since', since.toISOString());
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues?${params}`;
}
function retryAfterMs(header: string | null, now: number) {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return seconds > 86400 ? undefined : seconds * 1000;
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  const delta = parsed - now;
  return delta < 0 || delta > 86400 * 1000 ? undefined : delta;
}
function rateLimitMs(now: number, rateReset: string | null, retryAfter: string | null) {
  let chosen: number | undefined;
  if (rateReset && /^\d+$/.test(rateReset.trim())) chosen = Number(rateReset.trim()) * 1000 - now;
  if (chosen === undefined || !Number.isFinite(chosen)) chosen = retryAfterMs(retryAfter, now);
  if (chosen === undefined || chosen <= 0) return DEFAULT_RATE_MS;
  return Math.min(MAX_RATE_MS, Math.max(MIN_RATE_MS, Math.ceil(chosen)));
}
function isRateLimit(response: GitHubRead) {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  return response.rateRemaining === '0' || Boolean(response.retryAfter?.trim());
}
function bodySaysRejectedToken(body: unknown) {
  const text = typeof body === 'string' ? body.toLowerCase() : '';
  return text.includes('bad credentials') || text.includes('token') || text.includes('organization policy');
}
function isTokenRejection(response: GitHubRead) {
  if (isRateLimit(response)) return false;
  if (response.status === 401) return true;
  return response.status === 403 && bodySaysRejectedToken(response.body);
}
function errorCode(error: unknown) {
  if (error instanceof Problem && /^[a-z0-9_]{1,80}$/.test(error.code)) return error.code;
  return 'github_unavailable';
}
function toStored(item: SyncItem): StoredItem {
  const pull = item.pull_request != null;
  const kind = pull ? 'pr' : 'issue';
  return {
    number: item.number, kind, title: cleanTitle(item.title, `${kind === 'issue' ? 'Issue' : 'PR'} #${item.number}`),
    author_login: authorOf(item.user?.login ?? null), state: item.state,
    state_reason: !pull && item.state_reason ? item.state_reason : null,
    merged_at: pull ? item.pull_request?.merged_at ?? null : null,
    created_at: item.created_at, updated_at: item.updated_at, closed_at: item.closed_at ?? null,
  };
}

async function inTx<T>(client: PoolClient, run: () => Promise<T>) {
  await client.query('BEGIN');
  try { const value = await run(); await client.query('COMMIT'); return value; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
}
async function backoffActive(q: Pool | PoolClient, now: number) {
  const row = (await q.query<{until_at: Date}>("SELECT until_at FROM github_sync_backoff WHERE backoff_key='github'")).rows[0];
  return Boolean(row && new Date(row.until_at).getTime() > now);
}
async function storeBackoff(client: PoolClient, until: Date) {
  await inTx(client, () => client.query(`INSERT INTO github_sync_backoff(backoff_key, until_at) VALUES('github', $1)
    ON CONFLICT (backoff_key) DO UPDATE SET until_at=GREATEST(github_sync_backoff.until_at, EXCLUDED.until_at)`, [until]));
}
async function markError(client: PoolClient, key: string, at: Date, code: string) {
  await inTx(client, () => client.query('UPDATE github_sync_repositories SET next_sync_at=$2, last_error=$3 WHERE repository_key=$1', [key, at, code.slice(0, 80)]));
}
async function markUnreadable(client: PoolClient, key: string, at: Date) {
  await inTx(client, () => client.query(`UPDATE github_sync_repositories SET access_status='unreadable', next_sync_at=$2, last_error='github_unreadable' WHERE repository_key=$1`, [key, at]));
}
async function markSchedule(client: PoolClient, key: string, at: Date) {
  await inTx(client, () => client.query('UPDATE github_sync_repositories SET next_sync_at=$2 WHERE repository_key=$1', [key, at]));
}
async function touchSynced(client: PoolClient, key: string, syncedAt: Date, nextSyncAt: Date) {
  await inTx(client, () => client.query('UPDATE github_sync_repositories SET last_synced_at=$2, next_sync_at=$3 WHERE repository_key=$1', [key, syncedAt, nextSyncAt]));
}

async function storePage(client: PoolClient, key: string, items: StoredItem[], since: Date | null, etag: {value: string; query: string} | null, syncedAt: Date, done: {backfilled: boolean; nextSyncAt: Date} | null) {
  return inTx(client, async () => {
    let count = 0;
    if (items.length) {
      const written = await client.query(`INSERT INTO github_items(repository_key,number,kind,title,author_login,state,state_reason,merged_at,created_at,updated_at,closed_at,synced_at)
        SELECT $1, r.number, r.kind, r.title, r.author_login, r.state, r.state_reason, r.merged_at, r.created_at, r.updated_at, r.closed_at, $2
        FROM json_to_recordset($3::json) AS r(number int, kind text, title text, author_login text, state text, state_reason text, merged_at timestamptz, created_at timestamptz, updated_at timestamptz, closed_at timestamptz)
        ON CONFLICT (repository_key, number) DO UPDATE SET
          kind=EXCLUDED.kind, title=EXCLUDED.title, author_login=EXCLUDED.author_login, state=EXCLUDED.state,
          state_reason=EXCLUDED.state_reason, merged_at=EXCLUDED.merged_at, created_at=EXCLUDED.created_at,
          updated_at=EXCLUDED.updated_at, closed_at=EXCLUDED.closed_at, synced_at=EXCLUDED.synced_at`, [key, syncedAt, JSON.stringify(items)]);
      count = written.rowCount ?? items.length;
    }
    await client.query(`UPDATE github_sync_repositories SET
      since=CASE WHEN $2::timestamptz IS NULL THEN since WHEN since IS NULL OR $2>since THEN $2 ELSE since END,
      etag=CASE WHEN $3::text IS NULL THEN etag ELSE $3 END,
      etag_query=CASE WHEN $3::text IS NULL THEN etag_query ELSE $4 END,
      access_status='ok', last_error=NULL, last_synced_at=$5,
      backfilled=CASE WHEN $6::boolean IS NULL THEN backfilled ELSE $6 END,
      next_sync_at=CASE WHEN $7::timestamptz IS NULL THEN next_sync_at ELSE $7 END
      WHERE repository_key=$1`, [key, since, etag?.value ?? null, etag?.query ?? null, syncedAt, done ? done.backfilled : null, done?.nextSyncAt ?? null]);
    return count;
  });
}

async function callGitHub(run: Run, path: string, ifNoneMatch?: string) {
  if (run.requests >= run.budget) return null;
  run.requests += 1;
  return readGitHub(path, AbortSignal.timeout(10000), run.fetcher, 4194304, run.token, ifNoneMatch);
}

async function syncLocked(client: PoolClient, repo: RepoRow, run: Run): Promise<Outcome> {
  const key = repo.repository_key;
  let page = 1;
  let previous: string | null = null;
  const since = repo.since;
  while (page <= GITHUB_HISTORY_PAGE_CAP) {
    if (run.requests >= run.budget) return 'budget';
    if (await backoffActive(client, run.now())) return 'rate_limited';
    const path = issuesPath(repo.repository, page, since);
    const conditional = page === 1 && repo.etag && repo.etag_query === path ? repo.etag : undefined;
    let response: GitHubRead;
    try {
      const first = await callGitHub(run, path, conditional);
      if (!first) return 'budget';
      response = first;
      if (run.token && isTokenRejection(response)) {
        if (!run.warned) { console.warn('github_sync_token_rejected'); run.warned = true; }
        run.token = undefined;
        const second = await callGitHub(run, path, conditional);
        if (!second) return 'budget';
        response = second;
      }
    } catch (error) {
      await markError(client, key, new Date(run.now() + REPO_ERROR_MS), errorCode(error));
      return 'continue';
    }
    const now = new Date(run.now());
    if (response.status === 304) {
      run.not_modified += 1;
      await touchSynced(client, key, now, new Date(now.getTime() + SUCCESS_MS));
      return 'continue';
    }
    if (isRateLimit(response)) {
      await storeBackoff(client, new Date(now.getTime() + rateLimitMs(now.getTime(), response.rateReset, response.retryAfter)));
      return 'rate_limited';
    }
    if (response.status === 404 || response.status === 410 || response.status === 451 || response.status === 403) {
      await markUnreadable(client, key, new Date(now.getTime() + UNREADABLE_MS));
      return 'continue';
    }
    if (response.status !== 200) {
      await markError(client, key, new Date(now.getTime() + REPO_ERROR_MS), 'github_unavailable');
      return 'continue';
    }
    const parsed = z.array(syncItemSchema).max(100).safeParse(response.body);
    if (!parsed.success) {
      await markError(client, key, new Date(now.getTime() + REPO_ERROR_MS), 'github_invalid_response');
      return 'continue';
    }
    const signature = parsed.data.map(item => String(item.number)).join(',');
    // A repeated full page cannot advance `since` (it is inclusive) and must not be requested again.
    if (parsed.data.length === 100 && signature === previous) {
      await markSchedule(client, key, new Date(now.getTime() + SUCCESS_MS));
      return 'continue';
    }
    const stored = parsed.data.map(toStored);
    const newest = stored.length ? new Date(Math.max(...stored.map(item => Date.parse(item.updated_at)))) : null;
    const finished = stored.length < 100;
    const etag = page === 1 && response.etag ? {value: response.etag, query: path} : null;
    const count = await storePage(client, key, stored, newest, etag, now, finished ? {backfilled: true, nextSyncAt: new Date(now.getTime() + SUCCESS_MS)} : null);
    run.items_upserted += count;
    if (finished) return 'continue';
    previous = signature;
    page += 1;
  }
  await markSchedule(client, repo.repository_key, new Date(run.now() + SUCCESS_MS));
  return 'continue';
}

/** Upsert every tracked repository, then refresh due rows until the request budget or a shared rate limit. */
export async function syncGitHubRepositories(pool: Pool, options: GitHubSyncOptions = {}): Promise<GitHubSyncSummary> {
  const run: Run = {
    requests: 0, items_upserted: 0, not_modified: 0, budget: options.budget ?? GITHUB_SYNC_REQUEST_BUDGET,
    token: options.token, warned: false, fetcher: options.fetcher ?? globalThis.fetch, now: options.now ?? (() => Date.now()),
  };
  const summary: GitHubSyncSummary = {requests: 0, repositories: 0, items_upserted: 0, not_modified: 0, stop_reason: 'completed'};
  const tracked = await trackedGitHubRepositories(pool);
  if (tracked.length) {
    await pool.query(`INSERT INTO github_sync_repositories(repository_key, repository, next_sync_at)
      SELECT key, name, $1 FROM unnest($2::text[], $3::text[]) AS t(key, name)
      ON CONFLICT (repository_key) DO NOTHING`, [new Date(run.now()), tracked.map(item => item.key), tracked.map(item => item.name)]);
  }
  if (await backoffActive(pool, run.now())) {
    summary.stop_reason = 'rate_limited';
    return summary;
  }
  const due = await pool.query<RepoRow>(`SELECT repository_key, repository, since, etag, etag_query, backfilled, access_status, next_sync_at
    FROM github_sync_repositories WHERE next_sync_at <= $1 ORDER BY next_sync_at, repository_key`, [new Date(run.now())]);
  for (const repo of due.rows) {
    if (run.requests >= run.budget) { summary.stop_reason = 'budget'; break; }
    if (await backoffActive(pool, run.now())) { summary.stop_reason = 'rate_limited'; break; }
    const client = await pool.connect();
    let locked = false;
    try {
      const lockKey = `github-sync/${repo.repository_key}`;
      const acquired = (await client.query<{acquired: boolean}>('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', [lockKey])).rows[0]?.acquired;
      if (acquired !== true) continue;
      locked = true;
      const fresh = (await client.query<RepoRow>(`SELECT repository_key, repository, since, etag, etag_query, backfilled, access_status, next_sync_at
        FROM github_sync_repositories WHERE repository_key=$1`, [repo.repository_key])).rows[0];
      if (!fresh || new Date(fresh.next_sync_at).getTime() > run.now()) continue;
      summary.repositories += 1;
      const outcome = await syncLocked(client, fresh, run);
      if (outcome === 'rate_limited') { summary.stop_reason = 'rate_limited'; break; }
      if (outcome === 'budget') { summary.stop_reason = 'budget'; break; }
    } finally {
      if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`github-sync/${repo.repository_key}`]).catch(() => undefined);
      client.release();
    }
  }
  summary.requests = run.requests;
  summary.items_upserted = run.items_upserted;
  summary.not_modified = run.not_modified;
  return summary;
}
