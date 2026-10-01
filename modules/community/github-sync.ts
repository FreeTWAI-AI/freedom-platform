import {z} from 'zod';
import type {Pool, PoolClient} from 'pg';
import {Problem} from '../../packages/shared/problem.js';
import {readGitHub, githubCoordinate, type GitHubRead} from '../opensource-marketing/github.js';
import {communityCatalog} from './catalog.js';
import {authorOf, cleanTitle, postgresText, GITHUB_HISTORY_PAGE_CAP, GITHUB_REPOSITORY_NAME} from './github-history.js';
import {pilotProject} from '../co-creation/service.js';
import {pageIdsForIssue, publicEvent, FREEDOM_PLATFORM_EVENTS_FEED} from '../development/page-github.js';
import {catalogMetricTargets, failRepositoryMetrics, saveRepositoryMetrics} from '../github-social/service.js';
import {GitHubProviderError, GitHubSocialProvider} from '../github-social/provider.js';
import repositorySet from '../../repositories.lock.json' with {type:'json'};

export const GITHUB_SYNC_REQUEST_BUDGET = 40;
const SUCCESS_MS = 10 * 60 * 1000;
const LEASE_MS = 15 * 60 * 1000;
const REPO_ERROR_MS = LEASE_MS;
const UNREADABLE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_RATE_MS = 15 * 60 * 1000;
const MAX_RATE_MS = 60 * 60 * 1000;
const MIN_RATE_MS = 1000;
const METRICS_PER_RUN = 5;
const EVENTS_KEEP = 300;
const EVENTS_PATH = '/repos/FreeTWAI-AI/freedom-platform/events?per_page=100';
const MOVED_STATUSES = new Set([301, 302, 307, 308]);
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
  labels: z.unknown().optional(),
  assignees: z.unknown().optional(),
  body: z.unknown().optional(),
});
type SyncItem = z.infer<typeof syncItemSchema>;
type StoredItem = {
  number: number; kind: 'issue' | 'pr'; title: string; author_login: string | null; state: 'open' | 'closed';
  state_reason: string | null; merged_at: string | null; created_at: string; updated_at: string; closed_at: string | null;
  labels: string[]; assignees: string[]; page_ids: string[]; body_excerpt: string | null;
};
type RepoRow = {
  repository_key: string; repository: string; since: Date | null; etag: string | null; etag_query: string | null;
  backfilled: boolean; access_status: string; next_sync_at: Date;
};
type Outcome = 'continue' | 'rate_limited' | 'budget';
type Credential = 'anonymous' | 'token';
type Run = {
  requests: number; items_upserted: number; not_modified: number; budget: number;
  token: string | undefined; warned: boolean; rejectedOwners: Set<string>;
  backoffUntil: Record<Credential, number>;
  fetcher: typeof fetch; now: () => number;
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
  add(pilotProject.repository_full_name);
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
function bodyText(body: unknown) {
  return typeof body === 'string' ? body.toLowerCase() : '';
}
function isRateLimit(response: GitHubRead) {
  if (response.status !== 429 && response.status !== 403) return false;
  if (response.status === 429 || bodyText(response.body).includes('rate limit')) return true;
  return response.rateRemaining === '0' || Boolean(response.retryAfter?.trim());
}
function bodySaysRejectedToken(body: unknown) {
  const text = bodyText(body);
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
function ownerOf(repository: string) {
  return repository.split('/')[0]?.toLowerCase() ?? '';
}
function credentialFor(run: Run, repository: string): Credential {
  if (!run.token || run.rejectedOwners.has(ownerOf(repository))) return 'anonymous';
  return 'token';
}
function backedOff(run: Run, repository: string) {
  return run.backoffUntil[credentialFor(run, repository)] > run.now();
}
function noteRejection(run: Run, response: GitHubRead, repository: string) {
  const owner = ownerOf(repository);
  if (!run.warned) {
    console.warn('github_sync_token_rejected', owner);
    run.warned = true;
  }
  if (response.status === 401) run.token = undefined;
  else run.rejectedOwners.add(owner);
}
function labelList(value: unknown) {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    const raw = typeof entry === 'string' ? entry : entry && typeof entry === 'object' && typeof (entry as {name?: unknown}).name === 'string' ? (entry as {name: string}).name : '';
    const name = postgresText(raw.trim(), 100);
    if (!name) continue;
    names.push(name);
    if (names.length === 100) break;
  }
  return names;
}
function assigneeList(value: unknown) {
  if (!Array.isArray(value)) return [];
  const logins: string[] = [];
  for (const entry of value) {
    const raw = entry && typeof entry === 'object' && typeof (entry as {login?: unknown}).login === 'string' ? (entry as {login: string}).login : null;
    const login = authorOf(raw);
    if (!login || logins.includes(login)) continue;
    logins.push(login);
    if (logins.length === 100) break;
  }
  return logins;
}
function bodyExcerpt(kind: 'issue' | 'pr', state: 'open' | 'closed', body: unknown) {
  if (kind !== 'issue' || state !== 'open' || typeof body !== 'string') return null;
  const text = postgresText(body, 12000);
  return text.length ? text : null;
}
function toStored(item: SyncItem): StoredItem {
  const pull = item.pull_request != null;
  const kind = pull ? 'pr' : 'issue';
  const labels = labelList(item.labels);
  const body = typeof item.body === 'string' ? item.body : null;
  return {
    number: item.number, kind, title: cleanTitle(item.title, `${kind === 'issue' ? 'Issue' : 'PR'} #${item.number}`),
    author_login: authorOf(item.user?.login ?? null), state: item.state,
    state_reason: !pull && item.state_reason ? item.state_reason : null,
    merged_at: pull ? item.pull_request?.merged_at ?? null : null,
    created_at: item.created_at, updated_at: item.updated_at, closed_at: item.closed_at ?? null,
    labels, assignees: assigneeList(item.assignees), page_ids: pageIdsForIssue(body, labels).slice(0, 100),
    body_excerpt: bodyExcerpt(kind, item.state, item.body),
  };
}

async function inTx<T>(client: PoolClient, run: () => Promise<T>) {
  await client.query('BEGIN');
  try { const value = await run(); await client.query('COMMIT'); return value; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
}
async function refreshBackoff(q: Pool | PoolClient, run: Run) {
  const rows = await q.query<{backoff_key: string; until_at: Date}>("SELECT backoff_key, until_at FROM github_sync_backoff WHERE backoff_key IN ('anonymous', 'token')");
  run.backoffUntil = {anonymous: 0, token: 0};
  for (const row of rows.rows) {
    if (row.backoff_key === 'anonymous' || row.backoff_key === 'token') run.backoffUntil[row.backoff_key] = new Date(row.until_at).getTime();
  }
}
async function storeBackoff(client: PoolClient, key: Credential, until: Date, run: Run) {
  await inTx(client, () => client.query(`INSERT INTO github_sync_backoff(backoff_key, until_at) VALUES($1, $2)
    ON CONFLICT (backoff_key) DO UPDATE SET until_at=GREATEST(github_sync_backoff.until_at, EXCLUDED.until_at)`, [key, until]));
  run.backoffUntil[key] = Math.max(run.backoffUntil[key], until.getTime());
}
async function markError(client: PoolClient, key: string, at: Date, code: string) {
  await inTx(client, () => client.query('UPDATE github_sync_repositories SET next_sync_at=$2, last_error=$3 WHERE repository_key=$1', [key, at, code.slice(0, 80)]));
}
async function markUnreadable(client: PoolClient, key: string, at: Date) {
  await inTx(client, () => client.query(`UPDATE github_sync_repositories SET access_status='unreadable', next_sync_at=$2, last_error='github_unreadable' WHERE repository_key=$1`, [key, at]));
}
async function markMoved(client: PoolClient, key: string, at: Date) {
  await inTx(client, () => client.query(`UPDATE github_sync_repositories SET next_sync_at=$2, last_error='github_moved' WHERE repository_key=$1`, [key, at]));
}
async function releaseClaim(client: PoolClient, key: string, nowMs: number) {
  await inTx(client, () => client.query('UPDATE github_sync_repositories SET next_sync_at=$2 WHERE repository_key=$1', [key, new Date(nowMs)]));
}
async function claimRepository(client: PoolClient, key: string, nowMs: number) {
  const claimed = await client.query<RepoRow>(`UPDATE github_sync_repositories SET next_sync_at=$2
    WHERE repository_key=$1 AND next_sync_at<=$3
    RETURNING repository_key, repository, since, etag, etag_query, backfilled, access_status, next_sync_at`,
  [key, new Date(nowMs + LEASE_MS), new Date(nowMs)]);
  return claimed.rows[0] ?? null;
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
      const written = await client.query(`INSERT INTO github_items(repository_key,number,kind,title,author_login,state,state_reason,merged_at,created_at,updated_at,closed_at,synced_at,labels,assignees,page_ids,body_excerpt)
        SELECT $1, r.number, r.kind, r.title, r.author_login, r.state, r.state_reason, r.merged_at, r.created_at, r.updated_at, r.closed_at, $2,
          ARRAY(SELECT value FROM jsonb_array_elements_text(COALESCE(r.labels, '[]'::jsonb)) AS value),
          ARRAY(SELECT value FROM jsonb_array_elements_text(COALESCE(r.assignees, '[]'::jsonb)) AS value),
          ARRAY(SELECT value FROM jsonb_array_elements_text(COALESCE(r.page_ids, '[]'::jsonb)) AS value),
          r.body_excerpt
        FROM json_to_recordset($3::json) AS r(number int, kind text, title text, author_login text, state text, state_reason text, merged_at timestamptz, created_at timestamptz, updated_at timestamptz, closed_at timestamptz, labels jsonb, assignees jsonb, page_ids jsonb, body_excerpt text)
        ON CONFLICT (repository_key, number) DO UPDATE SET
          kind=EXCLUDED.kind, title=EXCLUDED.title, author_login=EXCLUDED.author_login, state=EXCLUDED.state,
          state_reason=EXCLUDED.state_reason, merged_at=EXCLUDED.merged_at, created_at=EXCLUDED.created_at,
          updated_at=EXCLUDED.updated_at, closed_at=EXCLUDED.closed_at, synced_at=EXCLUDED.synced_at,
          labels=EXCLUDED.labels, assignees=EXCLUDED.assignees, page_ids=EXCLUDED.page_ids, body_excerpt=EXCLUDED.body_excerpt`, [key, syncedAt, JSON.stringify(items)]);
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

async function callGitHub(run: Run, path: string, ifNoneMatch: string | undefined, sendToken: boolean) {
  if (run.requests >= run.budget) return null;
  run.requests += 1;
  return readGitHub(path, AbortSignal.timeout(10000), run.fetcher, 4194304, sendToken ? run.token : undefined, ifNoneMatch);
}

async function syncClaimed(client: PoolClient, repo: RepoRow, run: Run): Promise<Outcome> {
  const key = repo.repository_key;
  const stop = async (outcome: 'budget' | 'rate_limited') => {
    await releaseClaim(client, key, run.now());
    return outcome;
  };
  let page = 1;
  let previous: string | null = null;
  const since = repo.since;
  while (page <= GITHUB_HISTORY_PAGE_CAP) {
    if (run.requests >= run.budget) return stop('budget');
    await refreshBackoff(client, run);
    if (backedOff(run, repo.repository)) return stop('rate_limited');
    const path = issuesPath(repo.repository, page, since);
    const conditional = page === 1 && repo.etag && repo.etag_query === path ? repo.etag : undefined;
    const sendToken = credentialFor(run, repo.repository) === 'token';
    let usedToken = sendToken;
    let response: GitHubRead;
    try {
      const first = await callGitHub(run, path, conditional, sendToken);
      if (!first) return stop('budget');
      response = first;
      if (sendToken && isTokenRejection(response)) {
        noteRejection(run, response, repo.repository);
        if (run.requests >= run.budget) return stop('budget');
        await refreshBackoff(client, run);
        if (run.backoffUntil.anonymous > run.now()) return stop('rate_limited');
        const second = await callGitHub(run, path, conditional, false);
        if (!second) return stop('budget');
        response = second;
        usedToken = false;
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
      await storeBackoff(client, usedToken ? 'token' : 'anonymous', new Date(now.getTime() + rateLimitMs(now.getTime(), response.rateReset, response.retryAfter)), run);
      return stop('rate_limited');
    }
    if (MOVED_STATUSES.has(response.status)) {
      await markMoved(client, key, new Date(now.getTime() + UNREADABLE_MS));
      return 'continue';
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

function pollDelay(header: string | null, nowMs: number) {
  if (header && /^\d+$/.test(header.trim())) {
    const seconds = Number(header.trim());
    if (seconds > 0 && seconds <= 86400) return seconds * 1000;
  }
  return SUCCESS_MS;
}
function eventRow(raw: unknown) {
  const event = publicEvent(raw);
  if (!event) return null;
  if (event.id.length < 1 || event.id.length > 100) return null;
  if (event.actor.length < 1 || event.actor.length > 100) return null;
  if (event.title.length < 1 || postgresText(event.title, 300) !== event.title) return null;
  if (event.url.length < 1 || event.url.length > 1000) return null;
  if (event.number != null && (!Number.isInteger(event.number) || event.number <= 0 || event.number > 1000000000)) return null;
  return event;
}
async function markFeed(client: PoolClient, at: Date, next: Date, code: string | null) {
  await inTx(client, () => client.query(`UPDATE github_feed_state SET checked_at=$2, next_sync_at=$3, last_error=$4 WHERE feed_name=$1`,
    [FREEDOM_PLATFORM_EVENTS_FEED, at, next, code]));
}
async function syncPublicEvents(pool: Pool, run: Run) {
  if (run.requests >= run.budget) return;
  await pool.query(`INSERT INTO github_feed_state(feed_name, next_sync_at) VALUES ($1, $2) ON CONFLICT (feed_name) DO NOTHING`,
    [FREEDOM_PLATFORM_EVENTS_FEED, new Date(run.now())]);
  const client = await pool.connect();
  try {
    const claimed = await client.query<{etag: string | null}>(`UPDATE github_feed_state SET next_sync_at=$2
      WHERE feed_name=$1 AND next_sync_at<=$3 RETURNING etag`,
    [FREEDOM_PLATFORM_EVENTS_FEED, new Date(run.now() + LEASE_MS), new Date(run.now())]);
    const feed = claimed.rows[0];
    if (!feed) return;
    const repository = 'FreeTWAI-AI/freedom-platform';
    const release = (at: number) => inTx(client, () => client.query('UPDATE github_feed_state SET next_sync_at=$2 WHERE feed_name=$1', [FREEDOM_PLATFORM_EVENTS_FEED, new Date(at)]));
    try {
      await refreshBackoff(client, run);
      if (backedOff(run, repository)) {
        await release(run.backoffUntil[credentialFor(run, repository)]);
        return;
      }
      if (run.requests >= run.budget) { await release(run.now()); return; }
      const sendToken = credentialFor(run, repository) === 'token';
      let usedToken = sendToken;
      let response = await callGitHub(run, EVENTS_PATH, feed.etag ?? undefined, sendToken);
      if (!response) { await release(run.now()); return; }
      if (sendToken && isTokenRejection(response)) {
        noteRejection(run, response, repository);
        if (run.requests >= run.budget) { await release(run.now()); return; }
        await refreshBackoff(client, run);
        if (run.backoffUntil.anonymous > run.now()) { await release(run.backoffUntil.anonymous); return; }
        const second = await callGitHub(run, EVENTS_PATH, feed.etag ?? undefined, false);
        if (!second) { await release(run.now()); return; }
        response = second;
        usedToken = false;
      }
      const now = new Date(run.now());
      const next = new Date(now.getTime() + pollDelay(response.pollInterval, now.getTime()));
      if (response.status === 304) {
        run.not_modified += 1;
        await markFeed(client, now, next, null);
        return;
      }
      if (isRateLimit(response)) {
        const until = new Date(now.getTime() + rateLimitMs(now.getTime(), response.rateReset, response.retryAfter));
        await storeBackoff(client, usedToken ? 'token' : 'anonymous', until, run);
        await markFeed(client, now, until, 'github_rate_limited');
        return;
      }
      if (response.status !== 200 || !Array.isArray(response.body) || response.body.length > 100) {
        await markFeed(client, now, new Date(now.getTime() + REPO_ERROR_MS), response.status === 200 ? 'github_invalid_response' : 'github_unavailable');
        return;
      }
      const events = response.body.map(eventRow).filter((event): event is NonNullable<ReturnType<typeof eventRow>> => event !== null);
      await inTx(client, async () => {
        if (events.length) {
          await client.query(`INSERT INTO github_repository_events(event_id, kind, number, title, url, actor, created_at)
            SELECT r.event_id, r.kind, r.number, r.title, r.url, r.actor, r.created_at
            FROM json_to_recordset($1::json) AS r(event_id text, kind text, number int, title text, url text, actor text, created_at timestamptz)
            ON CONFLICT (event_id) DO UPDATE SET kind=EXCLUDED.kind, number=EXCLUDED.number, title=EXCLUDED.title, url=EXCLUDED.url, actor=EXCLUDED.actor, created_at=EXCLUDED.created_at`,
          [JSON.stringify(events.map(event => ({event_id: event.id, kind: event.kind, number: event.number, title: event.title, url: event.url, actor: event.actor, created_at: event.created_at})))]);
        }
        await client.query(`DELETE FROM github_repository_events WHERE event_id IN (
          SELECT event_id FROM github_repository_events ORDER BY created_at DESC, event_id DESC OFFSET $1)`, [EVENTS_KEEP]);
        const etag = response.etag && response.etag.length >= 1 && response.etag.length <= 200 ? response.etag : null;
        await client.query(`UPDATE github_feed_state SET etag=$2, checked_at=$3, next_sync_at=$4, last_error=NULL WHERE feed_name=$1`,
          [FREEDOM_PLATFORM_EVENTS_FEED, etag, now, next]);
      });
    } catch (error) {
      await markFeed(client, new Date(run.now()), new Date(run.now() + REPO_ERROR_MS), errorCode(error));
    }
  } finally {
    client.release();
  }
}
function metricsFetcher(run: Run): typeof fetch {
  return (input, init) => {
    if (run.requests >= run.budget) throw new Error('github_sync_budget');
    run.requests += 1;
    // Unbound: workerd throws "Illegal invocation" when global fetch's receiver is not the global scope.
    const fetcher = run.fetcher;
    return fetcher(input, init);
  };
}
async function syncDueMetrics(pool: Pool, run: Run) {
  const targets = catalogMetricTargets();
  if (!targets.length || run.requests >= run.budget) return;
  const due = await pool.query<{repository_key: string}>(`SELECT listed.key AS repository_key
    FROM unnest($1::text[]) WITH ORDINALITY AS listed(key, ord)
    LEFT JOIN github_repository_metrics metrics ON metrics.repository_key=listed.key
    WHERE metrics.retry_after IS NULL OR metrics.retry_after<=$2
    ORDER BY metrics.retry_after NULLS FIRST, listed.ord
    LIMIT $3`, [targets.map(target => target.key), new Date(run.now()), METRICS_PER_RUN]);
  if (!due.rows.length) return;
  const names = new Map(targets.map(target => [target.key, target.repository]));
  const provider = new GitHubSocialProvider(metricsFetcher(run));
  let token = run.token;
  let rejected = false;
  for (const row of due.rows) {
    if (run.requests >= run.budget) return;
    await refreshBackoff(pool, run);
    const credential: Credential = token && !rejected ? 'token' : 'anonymous';
    if (run.backoffUntil[credential] > run.now()) return;
    const repository = names.get(row.repository_key);
    if (!repository) continue;
    try {
      let snapshot;
      try {
        snapshot = await provider.metrics(repository, token && !rejected ? token : undefined);
      } catch (error) {
        if (token && !rejected && error instanceof GitHubProviderError && error.code === 'github_reconnect_required') {
          if (!rejected) console.error('github_metrics_token_rejected');
          rejected = true;
          token = undefined;
          run.token = undefined;
          if (run.requests >= run.budget) return;
          await refreshBackoff(pool, run);
          if (run.backoffUntil.anonymous > run.now()) return;
          snapshot = await provider.metrics(repository);
        } else throw error;
      }
      await saveRepositoryMetrics(pool, row.repository_key, snapshot);
    } catch (error) {
      const code = error instanceof GitHubProviderError ? error.code : 'github_unavailable';
      try { await failRepositoryMetrics(pool, row.repository_key, code); } catch (saveError) {
        console.warn('github_metrics_sync_failed', errorCode(saveError));
      }
      if (code === 'github_rate_limited') {
        const client = await pool.connect();
        try {
          await storeBackoff(client, token && !rejected ? 'token' : 'anonymous', new Date(run.now() + DEFAULT_RATE_MS), run);
        } finally { client.release(); }
        return;
      }
    }
  }
}

/** Upsert tracked repositories, then refresh the events feed, due repositories and due book metrics. */
export async function syncGitHubRepositories(pool: Pool, options: GitHubSyncOptions = {}): Promise<GitHubSyncSummary> {
  const run: Run = {
    requests: 0, items_upserted: 0, not_modified: 0, budget: options.budget ?? GITHUB_SYNC_REQUEST_BUDGET,
    token: options.token, warned: false, rejectedOwners: new Set(), backoffUntil: {anonymous: 0, token: 0},
    fetcher: options.fetcher ?? globalThis.fetch, now: options.now ?? (() => Date.now()),
  };
  const summary: GitHubSyncSummary = {requests: 0, repositories: 0, items_upserted: 0, not_modified: 0, stop_reason: 'completed'};
  const tracked = await trackedGitHubRepositories(pool);
  if (tracked.length) {
    await pool.query(`INSERT INTO github_sync_repositories(repository_key, repository, next_sync_at)
      SELECT key, name, $1 FROM unnest($2::text[], $3::text[]) AS t(key, name)
      ON CONFLICT (repository_key) DO NOTHING`, [new Date(run.now()), tracked.map(item => item.key), tracked.map(item => item.name)]);
  }
  await refreshBackoff(pool, run);
  // No token means one credential, so an active anonymous backoff stops the run the way the old single row did.
  if (!run.token && run.backoffUntil.anonymous > run.now()) {
    summary.stop_reason = 'rate_limited';
    return summary;
  }
  if (run.budget > 0) {
    try { await syncPublicEvents(pool, run); }
    catch (error) { console.warn('github_events_sync_failed', errorCode(error)); }
  }
  const due = tracked.length
    ? await pool.query<RepoRow>(`SELECT repository_key, repository, since, etag, etag_query, backfilled, access_status, next_sync_at
      FROM github_sync_repositories WHERE next_sync_at<=$1 AND repository_key=ANY($2::text[])
      ORDER BY next_sync_at, repository_key`, [new Date(run.now()), tracked.map(item => item.key)])
    : {rows: [] as RepoRow[]};
  for (let index = 0; index < due.rows.length; index += 1) {
    if (run.requests >= run.budget) { summary.stop_reason = 'budget'; break; }
    await refreshBackoff(pool, run);
    const remaining = due.rows.slice(index);
    if (remaining.every(repo => backedOff(run, repo.repository_key))) { summary.stop_reason = 'rate_limited'; break; }
    const listed = due.rows[index];
    const client = await pool.connect();
    try {
      // One UPDATE is the claim. A session advisory lock would leak under Hyperdrive transaction-mode pooling.
      const claimed = await claimRepository(client, listed.repository_key, run.now());
      if (!claimed) continue;
      if (backedOff(run, claimed.repository_key)) {
        await releaseClaim(client, claimed.repository_key, run.now());
        continue;
      }
      summary.repositories += 1;
      const outcome = await syncClaimed(client, claimed, run);
      if (outcome === 'budget') { summary.stop_reason = 'budget'; break; }
      if (outcome === 'rate_limited') {
        await refreshBackoff(pool, run);
        const later = due.rows.slice(index + 1);
        if (later.every(repo => backedOff(run, repo.repository_key))) { summary.stop_reason = 'rate_limited'; break; }
      }
    } finally {
      client.release();
    }
  }
  try { await syncDueMetrics(pool, run); }
  catch (error) { console.warn('github_metrics_sync_failed', errorCode(error)); }
  summary.requests = run.requests;
  summary.items_upserted = run.items_upserted;
  summary.not_modified = run.not_modified;
  return summary;
}
