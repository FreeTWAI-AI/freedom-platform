import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {createPool, LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {syncGitHubRepositories} from '../../modules/community/github-sync.js';
import {cleanTitle, authorOf} from '../../modules/community/github-history.js';

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

let keys: string[] = [];

before(async () => {
  globalThis.fetch = (() => { throw new Error('real network'); }) as typeof fetch;
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  await prime();
  keys = (await pool.query<{repository_key: string}>('SELECT repository_key FROM github_sync_repositories ORDER BY repository_key')).rows.map(row => row.repository_key);
  assert.ok(keys.includes(PLATFORM));
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

test('a rate limit stores one global backoff and stops the run', async () => {
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
  const until = (await pool.query('SELECT until_at FROM github_sync_backoff WHERE backoff_key=$1', ['github'])).rows[0].until_at;
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

test('rate-limit delay uses retry headers, caps at one hour, and treats a drained 403 as global', async () => {
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
  near((await pool.query('SELECT until_at FROM github_sync_backoff')).rows[0].until_at, clock.ms + 120 * 1000);
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
