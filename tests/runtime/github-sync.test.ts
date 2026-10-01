import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Pool} from 'pg';
import {createPool, LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {syncGitHubRepositories} from '../../modules/community/github-sync.js';
import {cleanTitle, authorOf} from '../../modules/community/github-history.js';
import {catalogMetricTargets} from '../../modules/github-social/service.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_github_sync_${process.pid}_${Date.now()}`;
const admin = createPool(databaseUrl);
const pool = new Pool({connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 8});
const originalFetch = globalThis.fetch;
const FAR = new Date('2099-01-01T00:00:00Z');
const T0 = Date.parse('2026-09-30T00:00:00Z');
const PLATFORM = 'freetwai-ai/freedom-platform';
const SECRET = 'synthetic-metrics-token';

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  const empty = body == null || status === 304;
  return new Response(empty ? null : JSON.stringify(body), {status, headers: {'content-type': 'application/json', ...headers}});
}
function item(number: number, updated: string, extra: Record<string, unknown> = {}) {
  return {number, title: `想法 ${number}`, state: 'open', state_reason: null, user: {login: 'maker'}, created_at: '2026-09-01T00:00:00.000Z', updated_at: updated, closed_at: null, ...extra};
}
function header(init: RequestInit | undefined, name: string) {
  return new Headers(init?.headers).get(name);
}
async function prime() {
  const summary = await syncGitHubRepositories(pool, {fetcher: async () => { throw new Error('budget zero must not fetch'); }, budget: 0, now: () => T0});
  assert.equal(summary.requests, 0);
  assert.equal(summary.stop_reason, 'budget');
}
async function only(keys: string[], nowMs: number) {
  await pool.query('UPDATE github_sync_repositories SET next_sync_at=$1', [FAR]);
  if (keys.length) await pool.query('UPDATE github_sync_repositories SET next_sync_at=$1 WHERE repository_key = ANY($2::text[])', [new Date(nowMs - 1000), keys]);
}
async function resetRepo(key: string) {
  await pool.query('DELETE FROM github_items WHERE repository_key=$1', [key]);
  await pool.query(`UPDATE github_sync_repositories
    SET since=NULL, etag=NULL, etag_query=NULL, access_status='pending', backfilled=false, last_synced_at=NULL, last_error=NULL
    WHERE repository_key=$1`, [key]);
}
async function repoRow(key: string) {
  const row = (await pool.query('SELECT since, etag, etag_query, access_status, backfilled, last_synced_at, next_sync_at, last_error FROM github_sync_repositories WHERE repository_key=$1', [key])).rows[0];
  assert.ok(row, key);
  return row;
}
function near(actual: Date | string, expected: number) {
  assert.ok(Math.abs(new Date(actual).getTime() - expected) < 2000, `${new Date(actual).toISOString()} vs ${new Date(expected).toISOString()}`);
}
function requestedRepository(input: RequestInfo | URL) {
  const parts = new URL(String(input)).pathname.split('/');
  return `${decodeURIComponent(parts[2] ?? '').toLowerCase()}/${decodeURIComponent(parts[3] ?? '').toLowerCase()}`;
}
async function dueAt(entries: [string, number][]) {
  await pool.query('UPDATE github_sync_repositories SET next_sync_at=$1', [FAR]);
  for (const [key, at] of entries) await pool.query('UPDATE github_sync_repositories SET next_sync_at=$1 WHERE repository_key=$2', [new Date(at), key]);
}
function distinctOwners() {
  const orgs = keys.filter(key => key.startsWith('freetwai-ai/'));
  const personal = keys.find(key => !key.startsWith('freetwai-ai/'));
  assert.ok(orgs.length >= 3);
  assert.ok(personal);
  return {org: orgs[0], otherOrg: orgs[1], laterOrg: orgs[2], personal};
}
function metricBody(stars = 9) {
  return {stargazers_count: stars, forks_count: 1, open_issues_count: 2, subscribers_count: 3, pushed_at: '2026-09-23T00:00:00Z', language: 'TypeScript', archived: false, private: false};
}
async function parkSideFeeds() {
  await pool.query(`INSERT INTO github_feed_state(feed_name, next_sync_at, checked_at, last_error)
    VALUES ('freedom_platform_events', $1, $1, NULL)
    ON CONFLICT (feed_name) DO UPDATE SET next_sync_at = EXCLUDED.next_sync_at, last_error = NULL`, [FAR]);
  const targets = catalogMetricTargets();
  if (!targets.length) return;
  await pool.query(`INSERT INTO github_repository_metrics(repository_key, retry_after)
    SELECT key, $2 FROM unnest($1::text[]) AS t(key)
    ON CONFLICT (repository_key) DO UPDATE SET retry_after = EXCLUDED.retry_after`, [targets.map(target => target.key), FAR]);
}
async function dueFeed(etag: string | null, at = T0) {
  await pool.query(`INSERT INTO github_feed_state(feed_name, etag, next_sync_at, last_error)
    VALUES ('freedom_platform_events', $2, $1, NULL)
    ON CONFLICT (feed_name) DO UPDATE SET etag = EXCLUDED.etag, next_sync_at = EXCLUDED.next_sync_at, last_error = NULL`, [new Date(at - 1000), etag]);
}
async function dueMetrics(targets: {key: string}[], at = T0) {
  await pool.query(`UPDATE github_repository_metrics SET snapshot = NULL, checked_at = NULL, last_error = NULL, retry_after = $2
    WHERE repository_key = ANY($1::text[])`, [targets.map(target => target.key), new Date(at - 1000)]);
}
async function quietSides() {
  await pool.query('DELETE FROM github_sync_backoff');
  await parkSideFeeds();
  await only([], T0);
}
function openedIssue(id: string, number = 1) {
  return {id, type: 'IssuesEvent', actor: {login: 'member-demo'}, created_at: '2026-09-27T12:00:00Z', payload: {action: 'opened', issue: {number, title: `任務 ${number}`, html_url: `https://github.com/FreeTWAI-AI/freedom-platform/issues/${number}`}}};
}

let keys: string[] = [];

before(async () => {
  globalThis.fetch = (() => { throw new Error('real network'); }) as typeof fetch;
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  await prime();
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM github_feed_state')).rows[0].n, 0);
  await parkSideFeeds();
  keys = (await pool.query<{repository_key: string}>('SELECT repository_key FROM github_sync_repositories ORDER BY repository_key')).rows.map(row => row.repository_key);
  assert.ok(keys.includes(PLATFORM));
  assert.ok(keys.includes('freetwai-ai/video-autopilot-kit'));
  assert.ok(keys.length >= 2);
});
after(async () => {
  globalThis.fetch = originalFetch;
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

test('titles and logins are sanitised before storage', () => {
  assert.equal(cleanTitle('想\u0000法  <img>', 'Issue #3'), '想法 <img>');
  assert.equal(cleanTitle('   ', 'Issue #4'), 'Issue #4');
  assert.equal(authorOf('not a login'), null);
  assert.equal(authorOf('dependabot[bot]'), 'dependabot[bot]');
});

test('the first backfill walks full pages and stores issues and pull requests', async () => {
  await resetRepo(PLATFORM);
  await only([PLATFORM], T0);
  const calls: URL[] = [];
  const summary = await syncGitHubRepositories(pool, {
    now: () => T0,
    fetcher: async (input, init) => {
      const url = new URL(String(input));
      calls.push(url);
      assert.equal(url.origin, 'https://api.github.com');
      assert.equal(init?.redirect, 'manual');
      assert.equal(header(init, 'user-agent'), 'Freedom-Platform-public-registry');
      assert.equal(header(init, 'authorization'), null);
      assert.equal(header(init, 'if-none-match'), null);
      const page = Number(url.searchParams.get('page'));
      assert.equal(url.searchParams.get('sort'), 'updated');
      assert.equal(url.searchParams.get('direction'), 'asc');
      assert.equal(url.searchParams.get('since'), null);
      if (page === 1) return json(Array.from({length: 100}, (_, index) => item(index + 1, new Date(Date.parse('2026-09-01T00:00:00.000Z') + index * 1000).toISOString())), 200, {etag: 'W/"page-1"'});
      if (page === 2) return json([
        item(101, '2026-09-02T00:00:00.000Z', {title: '想\u0000法  <img>', user: {login: 'not a login'}, state: 'closed', state_reason: 'not_planned'}),
        item(102, '2026-09-02T00:00:01.000Z', {pull_request: {merged_at: '2026-09-02T00:00:01.000Z'}, state: 'closed', user: {login: 'editor'}}),
        item(103, '2026-09-02T00:00:29.000Z', {pull_request: {merged_at: null}, state: 'closed', title: '未合併'}),
        ...Array.from({length: 27}, (_, index) => item(104 + index, new Date(Date.parse('2026-09-02T00:01:00.000Z') + index * 1000).toISOString())),
      ]);
      return json([]);
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(summary.requests, 2);
  assert.equal(summary.repositories, 1);
  assert.equal(summary.items_upserted, 130);
  assert.equal(summary.stop_reason, 'completed');
  const count = (await pool.query('SELECT count(*)::int AS n FROM github_items WHERE repository_key=$1', [PLATFORM])).rows[0].n;
  assert.equal(count, 130);
  const row = await repoRow(PLATFORM);
  assert.equal(row.backfilled, true);
  assert.equal(row.access_status, 'ok');
  assert.equal(new Date(row.since).toISOString(), '2026-09-02T00:01:26.000Z');
  assert.equal(row.etag, 'W/"page-1"');
  const kinds = await pool.query('SELECT number, kind, title, author_login, merged_at, state_reason FROM github_items WHERE repository_key=$1 AND number IN (101,102,103) ORDER BY number', [PLATFORM]);
  assert.equal(kinds.rows[0].kind, 'issue');
  assert.equal(kinds.rows[0].title, '想法 <img>');
  assert.equal(kinds.rows[0].author_login, null);
  assert.equal(kinds.rows[0].state_reason, 'not_planned');
  assert.equal(kinds.rows[1].kind, 'pr');
  assert.equal(new Date(kinds.rows[1].merged_at).toISOString(), '2026-09-02T00:00:01.000Z');
  assert.equal(kinds.rows[2].kind, 'pr');
  assert.equal(kinds.rows[2].merged_at, null);
  assert.equal(JSON.stringify(kinds.rows).includes('\u0000'), false);
  const again = await syncGitHubRepositories(pool, {now: () => T0 + 11 * 60 * 1000, fetcher: async () => json([])});
  assert.equal(again.requests, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM github_items WHERE repository_key=$1', [PLATFORM])).rows[0].n, 130);
});

test('the next run sends since and If-None-Match, and 304 only refreshes the schedule', async () => {
  await resetRepo(PLATFORM);
  await only([PLATFORM], T0);
  let phase = 1;
  const seen: {since: string | null; etag: string | null}[] = [];
  const clock = {ms: T0};
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    seen.push({since: url.searchParams.get('since'), etag: header(init, 'if-none-match')});
    if (phase === 1) return json([item(1, '2026-09-03T00:00:00.000Z')], 200, {etag: 'W/"v1"'});
    if (phase === 2) return json([], 200, {etag: 'W/"v2"'});
    return json(null, 304);
  };
  await syncGitHubRepositories(pool, {fetcher, now: () => clock.ms});
  assert.equal(seen[0].since, null);
  assert.equal(seen[0].etag, null);
  clock.ms += 11 * 60 * 1000;
  phase = 2;
  await syncGitHubRepositories(pool, {fetcher, now: () => clock.ms});
  assert.equal(seen[1].since, '2026-09-03T00:00:00.000Z');
  assert.equal(seen[1].etag, null);
  const before304 = await repoRow(PLATFORM);
  clock.ms += 11 * 60 * 1000;
  phase = 3;
  const summary = await syncGitHubRepositories(pool, {fetcher, now: () => clock.ms});
  assert.equal(seen[2].since, '2026-09-03T00:00:00.000Z');
  assert.equal(seen[2].etag, 'W/"v2"');
  assert.equal(summary.not_modified, 1);
  assert.equal(summary.requests, 1);
  assert.equal(summary.items_upserted, 0);
  const after = await repoRow(PLATFORM);
  assert.equal(new Date(after.since).toISOString(), new Date(before304.since).toISOString());
  assert.equal(after.etag, 'W/"v2"');
  assert.equal(after.backfilled, true);
  near(after.last_synced_at, clock.ms);
  near(after.next_sync_at, clock.ms + 10 * 60 * 1000);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM github_items WHERE repository_key=$1', [PLATFORM])).rows[0].n, 1);
});

test('404 marks the repository unreadable without deleting items, and a later sync recovers it', async () => {
  await resetRepo(PLATFORM);
  await pool.query('DELETE FROM github_sync_backoff');
  const clock = {ms: T0};
  let mode: 'ok' | 'missing' | 'back' = 'ok';
  const fetcher: typeof fetch = async () => mode === 'missing' ? json({message: 'missing'}, 404) : json([item(7, '2026-09-04T00:00:00.000Z')]);
  await only([PLATFORM], clock.ms);
  await syncGitHubRepositories(pool, {fetcher, now: () => clock.ms});
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM github_items WHERE repository_key=$1', [PLATFORM])).rows[0].n, 1);
  clock.ms += 11 * 60 * 1000;
  mode = 'missing';
  const denied = await syncGitHubRepositories(pool, {fetcher, now: () => clock.ms});
  assert.equal(denied.requests, 1);
  const blocked = await repoRow(PLATFORM);
  assert.equal(blocked.access_status, 'unreadable');
  assert.equal(blocked.last_error, 'github_unreadable');
  near(blocked.next_sync_at, clock.ms + 6 * 60 * 60 * 1000);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM github_items WHERE repository_key=$1', [PLATFORM])).rows[0].n, 1);
  const skipped = await syncGitHubRepositories(pool, {fetcher: async () => { throw new Error('should wait'); }, now: () => clock.ms + 1000});
  assert.equal(skipped.requests, 0);
  clock.ms = new Date(blocked.next_sync_at).getTime() + 1000;
  mode = 'back';
  await syncGitHubRepositories(pool, {fetcher, now: () => clock.ms});
  const recovered = await repoRow(PLATFORM);
  assert.equal(recovered.access_status, 'ok');
  assert.equal(recovered.backfilled, true);
  assert.equal(recovered.last_error, null);
});

test('a rate limit stores an anonymous backoff and stops the run when no token is set', async () => {
  await pool.query('DELETE FROM github_sync_backoff');
  const first = keys[0];
  const second = keys[1];
  const clock = {ms: T0};
  const urls: string[] = [];
  await only([first, second], clock.ms);
  const reset = Math.floor(clock.ms / 1000) + 30 * 60;
  const fetcher: typeof fetch = async input => {
    const url = String(input);
    urls.push(url);
    if (url.includes(`/${first.split('/')[1]}/`)) return json({message: 'slow'}, 429, {'x-ratelimit-reset': String(reset)});
    return json([]);
  };
  const stopped = await syncGitHubRepositories(pool, {fetcher, now: () => clock.ms});
  assert.equal(stopped.stop_reason, 'rate_limited');
  assert.equal(stopped.requests, 1);
  assert.equal(urls.length, 1);
  const until = (await pool.query('SELECT until_at FROM github_sync_backoff WHERE backoff_key=$1', ['anonymous'])).rows[0].until_at;
  near(until, clock.ms + 30 * 60 * 1000);
  const blocked = await syncGitHubRepositories(pool, {fetcher, now: () => clock.ms + 1000});
  assert.equal(blocked.requests, 0);
  assert.equal(blocked.stop_reason, 'rate_limited');
  assert.equal(urls.length, 1);
  clock.ms = new Date(until).getTime() + 1000;
  await only([first, second], clock.ms);
  const resumed = await syncGitHubRepositories(pool, {fetcher: async () => json([]), now: () => clock.ms});
  assert.equal(resumed.requests, 2);
  assert.equal(resumed.stop_reason, 'completed');
});

test('rate-limit delay uses retry headers, caps at one hour, and a drained 403 backs off that credential', async () => {
  await pool.query('DELETE FROM github_sync_backoff');
  const clock = {ms: T0};
  await only([PLATFORM], clock.ms);
  await syncGitHubRepositories(pool, {now: () => clock.ms, fetcher: async () => json('no', 429)});
  near((await pool.query('SELECT until_at FROM github_sync_backoff')).rows[0].until_at, clock.ms + 15 * 60 * 1000);
  await pool.query('DELETE FROM github_sync_backoff');
  const farReset = Math.floor(clock.ms / 1000) + 2 * 60 * 60;
  await syncGitHubRepositories(pool, {now: () => clock.ms, fetcher: async () => json('no', 429, {'x-ratelimit-reset': String(farReset)})});
  const capped = new Date((await pool.query('SELECT until_at FROM github_sync_backoff')).rows[0].until_at).getTime() - clock.ms;
  assert.ok(capped <= 60 * 60 * 1000 + 2000 && capped >= 59 * 60 * 1000);
  await pool.query('DELETE FROM github_sync_backoff');
  const urls: string[] = [];
  await only([keys[0], keys[1]], clock.ms);
  const stopped = await syncGitHubRepositories(pool, {
    now: () => clock.ms,
    fetcher: async input => {
      urls.push(String(input));
      return json('no', 403, {'x-ratelimit-remaining': '0', 'retry-after': '120'});
    },
  });
  assert.equal(stopped.stop_reason, 'rate_limited');
  assert.equal(urls.length, 1);
  const drained = (await pool.query('SELECT backoff_key, until_at FROM github_sync_backoff')).rows;
  assert.deepEqual(drained.map(row => row.backoff_key), ['anonymous']);
  near(drained[0].until_at, clock.ms + 120 * 1000);
});

test('a rejected token is retried once without the token and then left unused', async () => {
  await pool.query('DELETE FROM github_sync_backoff');
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  const first = keys[0];
  const second = keys[1];
  const clock = {ms: T0};
  await only([first, second], clock.ms);
  await resetRepo(first);
  const authorizations: (string | null)[] = [];
  try {
    const summary = await syncGitHubRepositories(pool, {
      token: SECRET,
      now: () => clock.ms,
      budget: 5,
      fetcher: async (input, init) => {
        const auth = header(init, 'authorization');
        authorizations.push(auth);
        const url = String(input);
        if (url.includes(`/${first.split('/')[1]}/`) && auth) return json({message: 'Bad credentials'}, 401);
        if (auth) return json({message: 'organization policy still applied'}, 403);
        return json([item(1, '2026-09-05T00:00:00.000Z')]);
      },
    });
    assert.equal(summary.requests, 3);
    assert.equal(authorizations[0], `Bearer ${SECRET}`);
    assert.equal(authorizations[1], null);
    assert.equal(authorizations[2], null);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].includes(SECRET), false);
    assert.match(warnings[0], /github_sync_token_rejected/);
    const stored = JSON.stringify((await pool.query('SELECT repository_key, last_error, access_status FROM github_sync_repositories')).rows);
    assert.equal(stored.includes(SECRET), false);
    const recovered = await repoRow(first);
    assert.equal(recovered.access_status, 'ok');
  } finally {
    console.warn = original;
  }
});

test('a 403 organization policy is treated as a rejected token', async () => {
  await pool.query('DELETE FROM github_sync_backoff');
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  await only([PLATFORM], T0);
  await resetRepo(PLATFORM);
  let calls = 0;
  try {
    await syncGitHubRepositories(pool, {
      token: SECRET,
      now: () => T0,
      budget: 4,
      fetcher: async (_input, init) => {
        calls += 1;
        if (header(init, 'authorization')) return new Response('blocked by organization policy', {status: 403});
        return json([]);
      },
    });
    assert.equal(calls, 2);
    assert.equal(warnings.length, 1);
    assert.equal(warnings.join(' ').includes(SECRET), false);
    assert.equal((await repoRow(PLATFORM)).access_status, 'ok');
  } finally {
    console.warn = original;
  }
});

test('the request budget stops a repository without pushing its next sync', async () => {
  await pool.query('DELETE FROM github_sync_backoff');
  await resetRepo(PLATFORM);
  await only([PLATFORM], T0);
  let calls = 0;
  const summary = await syncGitHubRepositories(pool, {
    budget: 2,
    now: () => T0,
    fetcher: async () => {
      calls += 1;
      if (calls > 2) return json({message: 'over'}, 500);
      return json(Array.from({length: 100}, (_, index) => item(calls * 1000 + index, new Date(Date.parse('2026-09-06T00:00:00.000Z') + calls * 1000 + index).toISOString())));
    },
  });
  assert.equal(calls, 2);
  assert.equal(summary.requests, 2);
  assert.equal(summary.stop_reason, 'budget');
  const row = await repoRow(PLATFORM);
  assert.equal(row.backfilled, false);
  assert.ok(new Date(row.next_sync_at).getTime() <= T0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM github_items WHERE repository_key=$1', [PLATFORM])).rows[0].n, 200);
});

test('a full page that repeats the same updated_at does not loop', async () => {
  await pool.query('DELETE FROM github_sync_backoff');
  await resetRepo(PLATFORM);
  await only([PLATFORM], T0);
  let calls = 0;
  const page = Array.from({length: 100}, (_, index) => item(index + 1, '2026-09-07T00:00:00.000Z'));
  const summary = await syncGitHubRepositories(pool, {
    budget: 40,
    now: () => T0,
    fetcher: async () => {
      calls += 1;
      if (calls > 3) return json({message: 'loop'}, 500);
      return json(page);
    },
  });
  assert.equal(calls, 2);
  assert.equal(summary.requests, 2);
  assert.equal(summary.stop_reason, 'completed');
  const row = await repoRow(PLATFORM);
  assert.equal(row.backfilled, false);
  near(row.next_sync_at, T0 + 10 * 60 * 1000);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM github_items WHERE repository_key=$1', [PLATFORM])).rows[0].n, 100);
});

test('a repository error backs off that repository and the run continues', async () => {
  await pool.query('DELETE FROM github_sync_backoff');
  const first = keys[0];
  const second = keys[1];
  await resetRepo(first);
  await resetRepo(second);
  await only([first, second], T0);
  const urls: string[] = [];
  const summary = await syncGitHubRepositories(pool, {
    now: () => T0,
    fetcher: async input => {
      const url = String(input);
      urls.push(url);
      if (url.includes(`/${first.split('/')[1]}/`)) return json({message: 'boom'}, 500);
      return json([]);
    },
  });
  assert.equal(summary.stop_reason, 'completed');
  assert.equal(summary.requests, 2);
  assert.equal(urls.length, 2);
  const failed = await repoRow(first);
  assert.equal(failed.last_error, 'github_unavailable');
  assert.equal(failed.access_status, 'pending');
  near(failed.next_sync_at, T0 + 15 * 60 * 1000);
  assert.equal((await repoRow(second)).backfilled, true);
});

test('overlapping runs do not process the same repository twice', async () => {
  await pool.query('DELETE FROM github_sync_backoff');
  const first = keys[0];
  const second = keys[1];
  await only([first, second], T0);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let opened!: () => void;
  const openedTwice = new Promise<void>(resolve => { opened = resolve; });
  const urls: string[] = [];
  const fetcher: typeof fetch = async input => {
    urls.push(String(input));
    if (urls.length >= 2) opened();
    if (urls.length === 1) await gate;
    return json([]);
  };
  const pending = Promise.all([
    syncGitHubRepositories(pool, {fetcher, budget: 1, now: () => T0}),
    syncGitHubRepositories(pool, {fetcher, budget: 1, now: () => T0}),
  ]);
  try {
    await Promise.race([openedTwice, new Promise((_, reject) => setTimeout(() => reject(new Error('overlap did not start')), 8000))]);
    const paths = urls.map(url => new URL(url).pathname);
    assert.equal(paths.length, 2);
    assert.equal(new Set(paths).size, 2);
  } finally {
    release();
  }
  const done = await pending;
  assert.equal(done[0].requests + done[1].requests, 2);
  assert.equal(done[0].repositories + done[1].repositories, 2);
});

test('a lease skips a concurrent claim and a crashed claim waits fifteen minutes', async () => {
  await pool.query('DELETE FROM github_sync_backoff');
  await resetRepo(PLATFORM);
  await only([PLATFORM], T0);
  let release = () => {};
  let first: Promise<unknown> = Promise.resolve();
  try {
    let started!: () => void;
    const startedOnce = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    first = syncGitHubRepositories(pool, {
      now: () => T0,
      fetcher: async () => {
        started();
        await gate;
        return json([item(1, '2026-09-08T00:00:00.000Z')]);
      },
    });
    await Promise.race([startedOnce, new Promise((_, reject) => setTimeout(() => reject(new Error('lease did not start')), 8000))]);
    assert.equal(new Date((await repoRow(PLATFORM)).next_sync_at).getTime(), T0 + 15 * 60 * 1000);
    const concurrent = await syncGitHubRepositories(pool, {
      now: () => T0 + 1000,
      fetcher: async () => { throw new Error('concurrent claim must skip'); },
    });
    assert.equal(concurrent.requests, 0);
    assert.equal(concurrent.repositories, 0);
    const tooEarly = await syncGitHubRepositories(pool, {
      now: () => T0 + 15 * 60 * 1000 - 1000,
      fetcher: async () => { throw new Error('lease must not expire early'); },
    });
    assert.equal(tooEarly.requests, 0);
    const expired = await syncGitHubRepositories(pool, {
      now: () => T0 + 15 * 60 * 1000,
      fetcher: async () => json([]),
    });
    assert.equal(expired.requests, 1);
    assert.equal(expired.repositories, 1);
    assert.equal(expired.stop_reason, 'completed');
  } finally {
    release();
    await first;
  }
});

test('a rejected organization token is not sent to that owner while another owner still uses it', async () => {
  await pool.query('DELETE FROM github_sync_backoff');
  const {org, otherOrg, personal} = distinctOwners();
  await resetRepo(org);
  await resetRepo(otherOrg);
  await resetRepo(personal);
  await dueAt([[org, T0 - 3000], [otherOrg, T0 - 2000], [personal, T0 - 1000]]);
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  const seen: {key: string; auth: string | null}[] = [];
  try {
    const summary = await syncGitHubRepositories(pool, {
      token: SECRET,
      now: () => T0,
      fetcher: async (input, init) => {
        const key = requestedRepository(input);
        const auth = header(init, 'authorization');
        seen.push({key, auth});
        if (key === org && auth) return json({message: 'blocked by organization policy'}, 403);
        if (key === org || key === otherOrg) {
          assert.equal(auth, null);
          return json([]);
        }
        assert.equal(key, personal);
        assert.equal(auth, `Bearer ${SECRET}`);
        return json([item(1, '2026-09-10T00:00:00.000Z')]);
      },
    });
    assert.equal(summary.requests, 4);
    assert.equal(summary.stop_reason, 'completed');
    assert.deepEqual(seen.map(call => call.key), [org, org, otherOrg, personal]);
    assert.equal(seen[0].auth, `Bearer ${SECRET}`);
    assert.equal(seen[2].auth, null);
    assert.equal(seen[3].auth, `Bearer ${SECRET}`);
    assert.equal(warnings.length, 1);
    assert.equal(warnings.join(' ').includes(SECRET), false);
    assert.match(warnings[0], /github_sync_token_rejected/);
    assert.match(warnings[0], /freetwai-ai/);
    assert.equal((await repoRow(org)).access_status, 'ok');
    assert.equal((await repoRow(personal)).access_status, 'ok');
  } finally {
    console.warn = original;
  }
});

test('a 401 disables the token for every owner in the run', async () => {
  await pool.query('DELETE FROM github_sync_backoff');
  const {org, otherOrg, personal} = distinctOwners();
  await dueAt([[org, T0 - 3000], [personal, T0 - 2000], [otherOrg, T0 - 1000]]);
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  const seen: {key: string; auth: string | null}[] = [];
  try {
    const summary = await syncGitHubRepositories(pool, {
      token: SECRET,
      now: () => T0,
      fetcher: async (input, init) => {
        const auth = header(init, 'authorization');
        seen.push({key: requestedRepository(input), auth});
        if (auth) return json({message: 'Bad credentials'}, 401);
        return json([]);
      },
    });
    assert.equal(summary.requests, 4);
    assert.deepEqual(seen.map(call => [call.key, call.auth]), [
      [org, `Bearer ${SECRET}`],
      [org, null],
      [personal, null],
      [otherOrg, null],
    ]);
    assert.equal(warnings.length, 1);
    assert.equal(warnings.join(' ').includes(SECRET), false);
    assert.match(warnings[0], /github_sync_token_rejected/);
  } finally {
    console.warn = original;
  }
});

test('an anonymous rate limit skips anonymous repositories while token repositories continue', async () => {
  await pool.query('DELETE FROM github_sync_backoff');
  const {org, otherOrg, laterOrg, personal} = distinctOwners();
  await resetRepo(org);
  await resetRepo(personal);
  await dueAt([[org, T0 - 4000], [otherOrg, T0 - 3000], [personal, T0 - 2000], [laterOrg, T0 - 1000]]);
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  const seen: {key: string; auth: string | null}[] = [];
  try {
    const summary = await syncGitHubRepositories(pool, {
      token: SECRET,
      now: () => T0,
      fetcher: async (input, init) => {
        const key = requestedRepository(input);
        const auth = header(init, 'authorization');
        seen.push({key, auth});
        if (key === org && auth) return json({message: 'blocked by organization policy'}, 403);
        if (key === org) return json({message: 'rate limit exceeded'}, 429);
        assert.equal(key, personal);
        assert.equal(auth, `Bearer ${SECRET}`);
        return json([]);
      },
    });
    assert.equal(summary.stop_reason, 'rate_limited');
    assert.equal(summary.requests, 3);
    assert.deepEqual(seen.map(call => call.key), [org, org, personal]);
    assert.equal(seen[2].auth, `Bearer ${SECRET}`);
    assert.equal(warnings.join(' ').includes(SECRET), false);
    const backoff = (await pool.query('SELECT backoff_key, until_at FROM github_sync_backoff ORDER BY backoff_key')).rows;
    assert.deepEqual(backoff.map(row => row.backoff_key), ['anonymous']);
    near(backoff[0].until_at, T0 + 15 * 60 * 1000);
    assert.equal(new Date((await repoRow(org)).next_sync_at).getTime(), T0);
    assert.equal((await repoRow(org)).access_status, 'pending');
    assert.equal(new Date((await repoRow(otherOrg)).next_sync_at).getTime(), T0);
    assert.equal(seen.some(call => call.key === otherOrg), false);
    near((await repoRow(personal)).next_sync_at, T0 + 10 * 60 * 1000);
    assert.equal(new Date((await repoRow(laterOrg)).next_sync_at).getTime(), T0 - 1000);
  } finally {
    console.warn = original;
  }
  await pool.query('DELETE FROM github_sync_backoff');
  const first = keys[0];
  const second = keys[1];
  await only([first, second], T0);
  const urls: string[] = [];
  const stopped = await syncGitHubRepositories(pool, {
    now: () => T0,
    fetcher: async input => {
      urls.push(String(input));
      return json({message: 'slow'}, 429);
    },
  });
  assert.equal(stopped.stop_reason, 'rate_limited');
  assert.equal(stopped.requests, 1);
  assert.equal(urls.length, 1);
  assert.ok(new Date((await repoRow(first)).next_sync_at).getTime() <= T0);
  const blocked = await syncGitHubRepositories(pool, {
    now: () => T0 + 1000,
    fetcher: async () => { urls.push('again'); return json([]); },
  });
  assert.equal(blocked.requests, 0);
  assert.equal(blocked.stop_reason, 'rate_limited');
  assert.equal(urls.length, 1);
});

test('a repository removed from the tracked set keeps its items and is not requested', async () => {
  await pool.query('DELETE FROM github_sync_backoff');
  const ghost = 'ghost-owner/ghost-repo';
  await pool.query('DELETE FROM github_items WHERE repository_key=$1', [ghost]);
  await pool.query('DELETE FROM github_sync_repositories WHERE repository_key=$1', [ghost]);
  await pool.query(`INSERT INTO github_sync_repositories(repository_key, repository, next_sync_at) VALUES ($1, $1, $2)`, [ghost, new Date(T0 - 5000)]);
  await pool.query(`INSERT INTO github_items(repository_key, number, kind, title, author_login, state, created_at, updated_at)
    VALUES ($1, 1, 'issue', 'kept', 'maker', 'open', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`, [ghost]);
  await only([PLATFORM], T0);
  await pool.query('UPDATE github_sync_repositories SET next_sync_at=$1 WHERE repository_key=$2', [new Date(T0 - 5000), ghost]);
  const urls: string[] = [];
  const summary = await syncGitHubRepositories(pool, {
    now: () => T0,
    fetcher: async input => {
      urls.push(String(input));
      return json([]);
    },
  });
  assert.equal(summary.requests, 1);
  assert.equal(urls.some(url => url.toLowerCase().includes('ghost-repo')), false);
  assert.equal(requestedRepository(urls[0]), PLATFORM);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM github_items WHERE repository_key=$1', [ghost])).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM github_sync_repositories WHERE repository_key=$1', [ghost])).rows[0].n, 1);
  await pool.query('DELETE FROM github_items WHERE repository_key=$1', [ghost]);
  await pool.query('DELETE FROM github_sync_repositories WHERE repository_key=$1', [ghost]);
});

test('a 301 records github_moved and retries after six hours without changing stored items', async () => {
  await pool.query('DELETE FROM github_sync_backoff');
  await resetRepo(PLATFORM);
  await only([PLATFORM], T0);
  await syncGitHubRepositories(pool, {
    now: () => T0,
    fetcher: async () => json([item(9, '2026-09-09T00:00:00.000Z')], 200, {etag: 'W/"stay"'}),
  });
  const before = await repoRow(PLATFORM);
  const movedAt = T0 + 11 * 60 * 1000;
  await only([PLATFORM], movedAt);
  let calls = 0;
  const summary = await syncGitHubRepositories(pool, {
    now: () => movedAt,
    fetcher: async () => {
      calls += 1;
      return new Response(null, {status: 301, headers: {location: 'https://api.github.com/repositories/1'}});
    },
  });
  assert.equal(calls, 1);
  assert.equal(summary.requests, 1);
  assert.equal(summary.stop_reason, 'completed');
  const after = await repoRow(PLATFORM);
  assert.equal(after.last_error, 'github_moved');
  assert.equal(after.access_status, 'ok');
  assert.equal(after.backfilled, true);
  assert.equal(new Date(after.since).toISOString(), new Date(before.since).toISOString());
  assert.equal(after.etag, 'W/"stay"');
  near(after.next_sync_at, movedAt + 6 * 60 * 60 * 1000);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM github_items WHERE repository_key=$1', [PLATFORM])).rows[0].n, 1);
  const skipped = await syncGitHubRepositories(pool, {
    now: () => movedAt + 60 * 60 * 1000,
    fetcher: async () => { throw new Error('moved repository must wait'); },
  });
  assert.equal(skipped.requests, 0);
});

test('a 403 whose body mentions a rate limit backs off without rate-limit headers', async () => {
  await pool.query('DELETE FROM github_sync_backoff');
  await resetRepo(PLATFORM);
  await only([PLATFORM], T0);
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  try {
    const summary = await syncGitHubRepositories(pool, {
      token: SECRET,
      now: () => T0,
      fetcher: async (_input, init) => {
        assert.equal(header(init, 'authorization'), `Bearer ${SECRET}`);
        return new Response('You have exceeded a secondary Rate Limit. Please wait.', {status: 403});
      },
    });
    assert.equal(summary.requests, 1);
    assert.equal(summary.stop_reason, 'rate_limited');
    assert.equal(warnings.length, 0);
    const rows = (await pool.query('SELECT backoff_key, until_at FROM github_sync_backoff ORDER BY backoff_key')).rows;
    assert.deepEqual(rows.map(row => row.backoff_key), ['token']);
    near(rows[0].until_at, T0 + 15 * 60 * 1000);
    const repo = await repoRow(PLATFORM);
    assert.equal(repo.access_status, 'pending');
    assert.equal(repo.last_error, null);
    assert.ok(new Date(repo.next_sync_at).getTime() <= T0);
  } finally {
    console.warn = original;
  }
});

test('issue sync stores labels, assignees, page ids and excerpts only for open issues', async () => {
  await quietSides();
  try {
    await resetRepo(PLATFORM);
    await only([PLATFORM], T0);
    const longBody = `${'甲'.repeat(12000)}乙乙乙乙乙`;
    const labels = [{name: '  page:home  '}, {name: '   '}, ...Array.from({length: 101}, (_, index) => ({name: `label-${index}-${'x'.repeat(120)}`}))];
    await syncGitHubRepositories(pool, {
      now: () => T0,
      fetcher: async () => json([
        item(7, '2026-09-07T00:00:00.000Z', {body: `<!-- freedom-page:guilds -->\n${longBody}`, labels, assignees: [{login: 'maker'}, {login: 'not a login'}, {login: 'maker'}, {login: 'editor'}]}),
        item(8, '2026-09-07T00:00:01.000Z', {state: 'closed', body: 'closed body', labels: [{name: 'page:home'}]}),
        item(9, '2026-09-07T00:00:02.000Z', {pull_request: {merged_at: null}, state: 'open', body: 'pr body', labels: [{name: 'page:home'}]}),
        item(11, '2026-09-07T00:00:03.000Z', {body: ''}),
      ]),
    });
    const rows = (await pool.query<{number: number; kind: string; state: string; labels: string[]; assignees: string[]; page_ids: string[]; body_excerpt: string | null}>('SELECT number, kind, state, labels, assignees, page_ids, body_excerpt FROM github_items WHERE repository_key=$1 ORDER BY number', [PLATFORM])).rows;
    const open = rows.find(row => row.number === 7);
    assert.ok(open);
    assert.equal(open.labels.length, 100);
    assert.equal(open.labels[0], 'page:home');
    assert.equal(open.labels[1], `label-0-${'x'.repeat(120)}`.slice(0, 100));
    assert.equal(open.labels.some(label => label.startsWith('label-99-')), false);
    assert.deepEqual(open.assignees, ['maker', 'editor']);
    assert.deepEqual(open.page_ids, ['home', 'guilds']);
    assert.equal(open.body_excerpt?.length, 12000);
    assert.equal(open.body_excerpt?.startsWith('<!-- freedom-page:guilds -->'), true);
    assert.equal(open.body_excerpt?.includes('乙'), false);
    const closed = rows.find(row => row.number === 8);
    assert.equal(closed?.body_excerpt, null);
    assert.deepEqual(closed?.page_ids, ['home']);
    assert.equal(rows.find(row => row.number === 9)?.kind, 'pr');
    assert.equal(rows.find(row => row.number === 9)?.body_excerpt, null);
    assert.equal(rows.find(row => row.number === 11)?.body_excerpt, null);
    const later = T0 + 11 * 60 * 1000;
    await only([PLATFORM], later);
    await syncGitHubRepositories(pool, {
      now: () => later,
      fetcher: async () => json([item(7, '2026-09-08T00:00:00.000Z', {state: 'closed', body: longBody, labels: [{name: 'page:home'}]})]),
    });
    const after = (await pool.query<{state: string; body_excerpt: string | null}>('SELECT state, body_excerpt FROM github_items WHERE repository_key=$1 AND number=7', [PLATFORM])).rows[0];
    assert.equal(after.state, 'closed');
    assert.equal(after.body_excerpt, null);
    await assert.rejects(() => pool.query(`UPDATE github_items SET body_excerpt='nope' WHERE repository_key=$1 AND number=9`, [PLATFORM]));
    assert.equal((await pool.query('SELECT body_excerpt FROM github_items WHERE repository_key=$1 AND number=9', [PLATFORM])).rows[0].body_excerpt, null);
  } finally {
    await quietSides();
  }
});

test('public events are stored, pruned to 300, and a 304 only refreshes the feed clock', async () => {
  await quietSides();
  try {
    await pool.query('DELETE FROM github_repository_events');
    await pool.query(`INSERT INTO github_repository_events(event_id, kind, number, title, url, actor, created_at)
      SELECT 'old-' || i, 'issue_opened', 1, '舊公告', 'https://github.com/FreeTWAI-AI/freedom-platform/issues/1', 'member',
        timestamptz '2020-01-01T00:00:00Z' + (i || ' seconds')::interval
      FROM generate_series(0, 299) AS g(i)`);
    await dueFeed(null);
    const urls: string[] = [];
    const stored = await syncGitHubRepositories(pool, {
      now: () => T0,
      fetcher: async (input, init) => {
        const url = String(input);
        urls.push(url);
        assert.equal(header(init, 'if-none-match'), null);
        assert.equal(header(init, 'authorization'), null);
        return json([
          {id: 'skip-me', type: 'IssuesEvent', actor: null, created_at: '2026-09-27T12:00:00Z', payload: {}},
          {id: 'forged', type: 'PullRequestEvent', actor: {login: 'member'}, created_at: '2026-09-27T12:00:00Z', payload: {action: 'opened', pull_request: {number: 10, title: '別的倉庫', html_url: 'https://github.com/other/repo/pull/10'}}},
          openedIssue('fresh-1'),
        ], 200, {etag: 'W/"events"', 'x-poll-interval': '90'});
      },
    });
    assert.equal(stored.requests, 1);
    assert.equal(stored.items_upserted, 0);
    assert.equal(urls.length, 1);
    assert.match(urls[0], /\/repos\/FreeTWAI-AI\/freedom-platform\/events\?per_page=100$/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM github_repository_events')).rows[0].n, 300);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM github_repository_events WHERE event_id IN ('old-0','skip-me','forged')")).rows[0].n, 0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM github_repository_events WHERE event_id='fresh-1'")).rows[0].n, 1);
    const feed = (await pool.query('SELECT etag, last_error, checked_at, next_sync_at FROM github_feed_state WHERE feed_name=$1', ['freedom_platform_events'])).rows[0];
    assert.equal(feed.etag, 'W/"events"');
    assert.equal(feed.last_error, null);
    near(feed.checked_at, T0);
    near(feed.next_sync_at, T0 + 90_000);
    await dueFeed('W/"keep"');
    await pool.query(`UPDATE github_feed_state SET last_error='github_unavailable', checked_at=$1 WHERE feed_name='freedom_platform_events'`, [new Date(T0 - 86_400_000)]);
    await pool.query(`INSERT INTO github_repository_events(event_id, kind, number, title, url, actor, created_at)
      VALUES ('kept-1','issue_opened',1,'保留','https://github.com/FreeTWAI-AI/freedom-platform/issues/1','member','2026-09-01T00:00:00Z')
      ON CONFLICT (event_id) DO NOTHING`);
    const before = (await pool.query('SELECT count(*)::int AS n FROM github_repository_events')).rows[0].n;
    const unchanged = await syncGitHubRepositories(pool, {
      now: () => T0,
      fetcher: async (_input, init) => {
        assert.equal(header(init, 'if-none-match'), 'W/"keep"');
        return json(null, 304, {etag: 'W/"replacement"', 'x-poll-interval': '90'});
      },
    });
    assert.equal(unchanged.requests, 1);
    assert.equal(unchanged.not_modified, 1);
    const after = (await pool.query<{etag: string; last_error: string | null; checked_at: Date; next_sync_at: Date}>('SELECT etag, last_error, checked_at, next_sync_at FROM github_feed_state WHERE feed_name=$1', ['freedom_platform_events'])).rows[0];
    assert.equal(after.etag, 'W/"keep"');
    assert.equal(after.last_error, null);
    near(after.checked_at, T0);
    near(after.next_sync_at, T0 + 90_000);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM github_repository_events')).rows[0].n, before);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM github_repository_events WHERE event_id='kept-1'")).rows[0].n, 1);
  } finally {
    await quietSides();
  }
});

test('a rejected events token retries once anonymously and a 429 skips repository reads', async () => {
  await quietSides();
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    await dueFeed(null);
    const authorizations: Array<string | null> = [];
    const rejected = await syncGitHubRepositories(pool, {
      token: SECRET,
      now: () => T0,
      fetcher: async (input, init) => {
        assert.match(String(input), /\/events\?/);
        const authorization = header(init, 'authorization');
        authorizations.push(authorization);
        return authorization ? json({message: 'Bad credentials'}, 401) : json([openedIssue('anon-1')]);
      },
    });
    assert.deepEqual(authorizations, [`Bearer ${SECRET}`, null]);
    assert.equal(rejected.requests, 2);
    assert.equal(rejected.stop_reason, 'completed');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM github_repository_events WHERE event_id='anon-1'")).rows[0].n, 1);
    assert.ok(warnings.some(args => args[0] === 'github_sync_token_rejected' && args[1] === 'freetwai-ai'));
    assert.equal(JSON.stringify(warnings).includes(SECRET), false);
    await quietSides();
    await dueFeed(null);
    await only([PLATFORM], T0);
    const limited = await syncGitHubRepositories(pool, {
      now: () => T0,
      fetcher: async input => {
        assert.match(String(input), /\/events\?/);
        return json({message: 'rate limit'}, 429);
      },
    });
    assert.equal(limited.requests, 1);
    assert.equal(limited.repositories, 0);
    assert.equal(limited.stop_reason, 'rate_limited');
    const backoff = (await pool.query("SELECT until_at FROM github_sync_backoff WHERE backoff_key='anonymous'")).rows[0];
    near(backoff.until_at, T0 + 15 * 60 * 1000);
    assert.equal((await pool.query("SELECT last_error FROM github_feed_state WHERE feed_name='freedom_platform_events'")).rows[0].last_error, 'github_rate_limited');
  } finally {
    console.warn = original;
    await quietSides();
  }
});

test('an events failure and a repository failure still let the other sync parts finish', async () => {
  await quietSides();
  try {
    const targets = catalogMetricTargets();
    assert.ok(targets.length >= 6);
    await dueFeed(null);
    await only([PLATFORM], T0);
    await resetRepo(PLATFORM);
    await only([PLATFORM], T0);
    await dueMetrics([targets[0]]);
    const urls: string[] = [];
    const summary = await syncGitHubRepositories(pool, {
      now: () => T0,
      fetcher: async input => {
        const url = String(input);
        urls.push(url);
        if (url.includes('/events')) throw new Error('events down');
        if (url.includes('/issues')) return new Response('unavailable', {status: 500});
        return json(metricBody());
      },
    });
    assert.equal(summary.requests, 3);
    assert.equal(summary.stop_reason, 'completed');
    assert.match(urls[0], /\/events\?/);
    assert.match(urls[1], /\/issues\?/);
    assert.equal(urls[2], `https://api.github.com/repos/${targets[0].repository}`);
    assert.equal((await pool.query("SELECT last_error FROM github_feed_state WHERE feed_name='freedom_platform_events'")).rows[0].last_error, 'github_unavailable');
    assert.equal((await repoRow(PLATFORM)).last_error, 'github_unavailable');
    assert.equal((await pool.query('SELECT snapshot->>\'stargazers_count\' AS stars FROM github_repository_metrics WHERE repository_key=$1', [targets[0].key])).rows[0].stars, '9');
  } finally {
    await quietSides();
  }
});

test('book metrics refresh at most five due repositories and share the request budget', async () => {
  await quietSides();
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    const targets = catalogMetricTargets();
    assert.ok(targets.length >= 6);
    const six = targets.slice(0, 6);
    await dueMetrics(six);
    const capped = await syncGitHubRepositories(pool, {
      now: () => T0,
      fetcher: async () => json(metricBody()),
    });
    assert.equal(capped.requests, 5);
    assert.equal(capped.stop_reason, 'completed');
    const refreshed = new Set((await pool.query<{repository_key: string}>('SELECT repository_key FROM github_repository_metrics WHERE repository_key = ANY($1::text[]) AND snapshot IS NOT NULL', [six.map(target => target.key)])).rows.map(row => row.repository_key));
    assert.deepEqual([...refreshed].sort(), six.slice(0, 5).map(target => target.key).sort());
    await quietSides();
    await dueFeed(null);
    await only([PLATFORM], T0);
    await resetRepo(PLATFORM);
    await only([PLATFORM], T0);
    await dueMetrics(six);
    const shared = await syncGitHubRepositories(pool, {
      now: () => T0,
      budget: 4,
      fetcher: async input => String(input).includes('/events') || String(input).includes('/issues') ? json([]) : json(metricBody(4)),
    });
    assert.equal(shared.requests, 4);
    assert.equal(shared.stop_reason, 'completed');
    const budgeted = new Set((await pool.query<{repository_key: string}>('SELECT repository_key FROM github_repository_metrics WHERE repository_key = ANY($1::text[]) AND snapshot IS NOT NULL', [six.map(target => target.key)])).rows.map(row => row.repository_key));
    assert.deepEqual([...budgeted].sort(), six.slice(0, 2).map(target => target.key).sort());
    await quietSides();
    await dueMetrics(six.slice(0, 2));
    const limited = await syncGitHubRepositories(pool, {
      now: () => T0,
      fetcher: async () => json({message: 'rate limit'}, 429),
    });
    assert.equal(limited.requests, 1);
    assert.equal(limited.stop_reason, 'completed');
    assert.equal((await pool.query('SELECT last_error FROM github_repository_metrics WHERE repository_key=$1', [six[0].key])).rows[0].last_error, 'github_rate_limited');
    assert.equal((await pool.query('SELECT snapshot FROM github_repository_metrics WHERE repository_key=$1', [six[1].key])).rows[0].snapshot, null);
    near((await pool.query("SELECT until_at FROM github_sync_backoff WHERE backoff_key='anonymous'")).rows[0].until_at, T0 + 15 * 60 * 1000);
    await quietSides();
    await dueMetrics([targets[0]]);
    const fallback = await syncGitHubRepositories(pool, {
      token: SECRET,
      now: () => T0,
      fetcher: async (_input, init) => header(init, 'authorization') ? json({message: 'Bad credentials'}, 401) : json(metricBody(43)),
    });
    assert.equal(fallback.requests, 2);
    assert.equal(fallback.stop_reason, 'completed');
    assert.equal((await pool.query('SELECT snapshot->>\'stargazers_count\' AS stars, last_error FROM github_repository_metrics WHERE repository_key=$1', [targets[0].key])).rows[0].stars, '43');
    assert.deepEqual(errors, [['github_metrics_token_rejected']]);
    assert.equal(JSON.stringify(errors).includes(SECRET), false);
  } finally {
    console.error = original;
    await quietSides();
  }
});

test('migration 057 clears issue cursors and the next run reads without since', async () => {
  await quietSides();
  try {
    const sql = readFileSync(new URL('../../migrations/057_github_sync_feeds.sql', import.meta.url), 'utf8');
    assert.match(sql, /UPDATE github_sync_repositories\s+SET since = NULL, etag = NULL, etag_query = NULL, backfilled = false, next_sync_at = now\(\)/);
    const synced = new Date('2026-09-20T00:00:00.000Z');
    await pool.query(`UPDATE github_sync_repositories
      SET since=$2, etag='W/"old"', etag_query='/old', access_status='ok', backfilled=true, last_synced_at=$3, last_error='github_unavailable', next_sync_at=$4
      WHERE repository_key=$1`, [PLATFORM, new Date('2026-09-01T00:00:00.000Z'), synced, FAR]);
    await pool.query('UPDATE github_sync_repositories SET since = NULL, etag = NULL, etag_query = NULL, backfilled = false, next_sync_at = now()');
    const reset = await repoRow(PLATFORM);
    assert.equal(reset.since, null);
    assert.equal(reset.etag, null);
    assert.equal(reset.etag_query, null);
    assert.equal(reset.backfilled, false);
    assert.equal(reset.access_status, 'ok');
    assert.equal(reset.last_error, 'github_unavailable');
    assert.equal(new Date(reset.last_synced_at).toISOString(), synced.toISOString());
    await only([PLATFORM], T0);
    let since: string | null = 'missing';
    const summary = await syncGitHubRepositories(pool, {
      now: () => T0,
      fetcher: async input => {
        const url = new URL(String(input));
        assert.match(url.pathname, /\/issues$/);
        since = url.searchParams.get('since');
        return json([]);
      },
    });
    assert.equal(summary.requests, 1);
    assert.equal(since, null);
  } finally {
    await quietSides();
  }
});
