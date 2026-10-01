import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createLocalJWKSet, exportJWK, generateKeyPair, SignJWT} from 'jose';
import {createPool, LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal, DEMO_COMMUNITY, DEMO_USERS} from '../../packages/testing/seed.js';
import {syncGitHubRepositories} from '../../modules/community/github-sync.js';
import {catalogMetricTargets} from '../../modules/github-social/service.js';
import {FREEDOM_PLATFORM_EVENTS_FEED} from '../../modules/development/page-github.js';
import {classifyCredential, parseGitHubTokenExpiration} from '../../modules/platform-admin/credentials.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {createAdminAccessVerifier} from '../../modules/platform-admin/access.js';

const origin = 'http://127.0.0.1:4310';
const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_credentials_${process.pid}_${Date.now()}`;
const database = createPool(databaseUrl);
const pool = new Pool({connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 8});
const issuer = 'https://test-team.cloudflareaccess.com';
const audience = 'credential-panel-tests';
const adminEmail = DEMO_USERS[0].email;
const adminId = randomUUID();
const pair = await generateKeyPair('RS256');
const jwk = await exportJWK(pair.publicKey);
const verifier = createAdminAccessVerifier({issuer, audience, csrfSecret: 'test-fixture-admin-csrf-secret-123456789', keySet: createLocalJWKSet({keys: [{...jwk, kid: 'credential-test', alg: 'RS256'}]})});
const originalFetch = globalThis.fetch;
const FAR = new Date('2099-01-01T00:00:00Z');
const T0 = Date.parse('2026-09-30T00:00:00Z');
const PLATFORM = 'freetwai-ai/freedom-platform';
const SECRET = 'synthetic-metrics-token';
const HEADER = 'github-authentication-token-expiration';
const EVENTS_EXPIRY = '2027-09-30 04:00:00 UTC';
const ISSUES_EXPIRY = '2028-01-15 00:00:00 UTC';
const DAY = 86_400_000;
const CLAIM = `UPDATE platform_credential_renewal_requests SET state='processing' WHERE state='pending' AND credential_key='cloudflare_deploy_token' RETURNING request_id`;
const COMPLETE = `UPDATE platform_credential_renewal_requests SET state=$2, processed_at=now(), result_expires_at=$3, error_code=$4 WHERE request_id=$1`;
const UPSERT = `INSERT INTO platform_credential_status(credential_key,status,expires_at,checked_at,source,note) VALUES('cloudflare_deploy_token',$1,$2,now(),'local_executor',$3) ON CONFLICT (credential_key) DO UPDATE SET status=EXCLUDED.status, expires_at=EXCLUDED.expires_at, checked_at=EXCLUDED.checked_at, source=EXCLUDED.source, note=EXCLUDED.note`;

let app = createApp(pool, origin, 'local', {adminVerifier: verifier});
let jwt = '';
let csrf = '';

before(async () => {
  globalThis.fetch = (() => { throw new Error('real network'); }) as typeof fetch;
  await database.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  await seedLocal(pool);
  await syncGitHubRepositories(pool, {budget: 0, now: () => T0, fetcher: async () => { throw new Error('budget zero must not fetch'); }});
});
after(async () => {
  globalThis.fetch = originalFetch;
  await pool.end();
  await database.query(`DROP SCHEMA ${schema} CASCADE`);
  await database.end();
});

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(body == null || status === 304 ? null : JSON.stringify(body), {status, headers: {'content-type': 'application/json', ...headers}});
}
function item(number: number) {
  return {number, title: `想法 ${number}`, state: 'open', state_reason: null, user: {login: 'maker'}, created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-02T00:00:00.000Z', closed_at: null};
}
function openedIssue(id: string) {
  return {id, type: 'IssuesEvent', actor: {login: 'member-demo'}, created_at: '2026-09-27T12:00:00Z', payload: {action: 'opened', issue: {number: 7, title: '任務 7', html_url: 'https://github.com/FreeTWAI-AI/freedom-platform/issues/7'}}};
}
function metricBody() {
  return {stargazers_count: 9, forks_count: 1, open_issues_count: 2, subscribers_count: 3, pushed_at: '2026-09-23T00:00:00Z', language: 'TypeScript', archived: false, private: false};
}
async function parkAll() {
  await pool.query('DELETE FROM github_sync_backoff');
  await pool.query('DELETE FROM platform_credential_renewal_requests');
  await pool.query('DELETE FROM platform_credential_status');
  await pool.query(`INSERT INTO github_feed_state(feed_name, next_sync_at) VALUES ($1, $2)
    ON CONFLICT (feed_name) DO UPDATE SET next_sync_at=EXCLUDED.next_sync_at, etag=NULL, last_error=NULL`, [FREEDOM_PLATFORM_EVENTS_FEED, FAR]);
  await pool.query('UPDATE github_sync_repositories SET next_sync_at=$1', [FAR]);
  const targets = catalogMetricTargets();
  if (targets.length) {
    await pool.query(`INSERT INTO github_repository_metrics(repository_key, retry_after)
      SELECT key, $2 FROM unnest($1::text[]) AS t(key)
      ON CONFLICT (repository_key) DO UPDATE SET retry_after=EXCLUDED.retry_after`, [targets.map(target => target.key), FAR]);
  }
}
async function dueFeed() {
  await pool.query('UPDATE github_feed_state SET next_sync_at=$2, etag=NULL, last_error=NULL WHERE feed_name=$1', [FREEDOM_PLATFORM_EVENTS_FEED, new Date(T0 - 1000)]);
}
async function dueRepo() {
  await pool.query(`UPDATE github_sync_repositories
    SET next_sync_at=$2, since=NULL, etag=NULL, etag_query=NULL, backfilled=false, access_status='pending', last_error=NULL
    WHERE repository_key=$1`, [PLATFORM, new Date(T0 - 1000)]);
}
async function githubRow() {
  const rows = await pool.query<{status: string; expires_at: Date | null; source: string; note: string | null}>('SELECT status, expires_at, source, note FROM platform_credential_status WHERE credential_key=$1', ['github_metrics_token']);
  assert.equal(rows.rowCount, 1);
  return rows.rows[0];
}
async function sign(email: string) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({type: 'app', email, sub: 'verified-human-fixture', iss: issuer, aud: audience, iat: now, nbf: now, exp: now + 600}).setProtectedHeader({alg: 'RS256', kid: 'credential-test'}).sign(pair.privateKey);
}
async function resetAdmin() {
  await pool.query('TRUNCATE communities, login_attempts, auth_rate_limits CASCADE');
  await pool.query('DELETE FROM platform_credential_status');
  await seedLocal(pool);
  await pool.query('INSERT INTO platform_admins(admin_id, community_id, email, display_name) VALUES($1,$2,$3,$4)', [adminId, DEMO_COMMUNITY, adminEmail, 'Verified Admin']);
  app = createApp(pool, origin, 'local', {adminVerifier: verifier});
  jwt = await sign(adminEmail);
  csrf = (await verifier(new Request(origin, {headers: {'Cf-Access-Jwt-Assertion': jwt}}))).csrfToken;
}
async function request(path: string, body?: unknown, key?: string, headers: Record<string, string> = {}) {
  const defaults: Record<string, string> = {Origin: origin, 'Cf-Access-Jwt-Assertion': jwt, 'X-Admin-CSRF': csrf, ...headers};
  if (body !== undefined) {
    defaults['Content-Type'] = 'application/json';
    if (key !== '') defaults['Idempotency-Key'] = key || randomUUID();
  }
  const response = await app.request(origin + '/admin/api' + path, {method: body === undefined ? 'GET' : 'POST', headers: defaults, body: body === undefined ? undefined : JSON.stringify(body)});
  return {status: response.status, data: await response.json() as any, response};
}
async function rejectsCode(query: Promise<unknown>, code: string) {
  await assert.rejects(query, (error: {code?: string}) => error.code === code);
}

test('migration accepts the executor statements and rejects a second open renewal', async () => {
  assert.equal((await pool.query(`SELECT to_regclass('platform_credential_status') IS NOT NULL AS ok`)).rows[0].ok, true);
  assert.equal((await pool.query(`SELECT to_regclass('platform_credential_renewal_requests') IS NOT NULL AS ok`)).rows[0].ok, true);
  assert.match((await pool.query(`SELECT indexdef FROM pg_indexes WHERE indexname='platform_credential_renewal_one_open'`)).rows[0].indexdef, /pending.*processing/);
  await pool.query('DELETE FROM platform_credential_renewal_requests');
  await pool.query('DELETE FROM platform_credential_status');
  const member = DEMO_USERS[0].user_id;
  const pending = randomUUID();
  await pool.query('INSERT INTO platform_credential_renewal_requests(request_id, credential_key, requested_by) VALUES($1,$2,$3)', [pending, 'cloudflare_deploy_token', member]);
  await rejectsCode(pool.query('INSERT INTO platform_credential_renewal_requests(request_id, credential_key, requested_by) VALUES($1,$2,$3)', [randomUUID(), 'cloudflare_deploy_token', member]), '23505');
  const claimed = await pool.query<{request_id: string}>(CLAIM);
  assert.deepEqual(claimed.rows.map(row => row.request_id), [pending]);
  const expiry = new Date('2027-10-01T00:00:00.000Z');
  const completed = await pool.query(COMPLETE, [pending, 'done', expiry, null]);
  assert.equal(completed.rowCount, 1);
  await pool.query(UPSERT, ['ok', expiry, null]);
  await pool.query(UPSERT, ['ok', new Date('2028-01-01T00:00:00.000Z'), '延長完成']);
  const status = (await pool.query('SELECT status, expires_at, source, note FROM platform_credential_status WHERE credential_key=$1', ['cloudflare_deploy_token'])).rows[0];
  assert.equal(status.status, 'ok');
  assert.equal(new Date(status.expires_at).toISOString(), '2028-01-01T00:00:00.000Z');
  assert.equal(status.source, 'local_executor');
  assert.equal(status.note, '延長完成');
  const again = randomUUID();
  await pool.query('INSERT INTO platform_credential_renewal_requests(request_id, credential_key, requested_by) VALUES($1,$2,$3)', [again, 'cloudflare_deploy_token', member]);
  const failed = await pool.query<{request_id: string}>(CLAIM);
  assert.deepEqual(failed.rows.map(row => row.request_id), [again]);
  await pool.query(COMPLETE, [again, 'failed', null, 'renew_failed']);
  await rejectsCode(pool.query(`INSERT INTO platform_credential_status(credential_key, status, checked_at, source) VALUES('other', 'ok', now(), 'github_response')`), '23514');
  await rejectsCode(pool.query(`INSERT INTO platform_credential_status(credential_key, status, checked_at, source) VALUES('github_metrics_token', 'missing', now(), 'github_response')`), '23514');
  await rejectsCode(pool.query(`INSERT INTO platform_credential_status(credential_key, status, checked_at, source, note) VALUES('github_metrics_token', 'ok', now(), 'github_response', $1)`, ['x'.repeat(201)]), '23514');
  await rejectsCode(pool.query('INSERT INTO platform_credential_renewal_requests(request_id, credential_key, requested_by) VALUES($1,$2,$3)', [randomUUID(), 'github_metrics_token', member]), '23514');
  await rejectsCode(pool.query(`UPDATE platform_credential_renewal_requests SET error_code='' WHERE request_id=$1`, [again]), '23514');
  await pool.query('DELETE FROM platform_credential_renewal_requests');
  await pool.query('DELETE FROM platform_credential_status');
});

test('level uses whole UTC days and the GitHub expiry header is UTC', () => {
  const now = new Date('2026-10-01T00:00:00.000Z');
  const at = (days: number) => new Date(now.getTime() + days * DAY);
  assert.deepEqual(classifyCredential('ok', at(31), now), {level: 'ok', days_left: 31});
  assert.deepEqual(classifyCredential('ok', at(30), now), {level: 'warning', days_left: 30});
  assert.deepEqual(classifyCredential('ok', at(8), now), {level: 'warning', days_left: 8});
  assert.deepEqual(classifyCredential('ok', at(7), now), {level: 'danger', days_left: 7});
  assert.deepEqual(classifyCredential('ok', at(-1), now), {level: 'expired', days_left: -1});
  assert.deepEqual(classifyCredential('ok', now, now), {level: 'expired', days_left: 0});
  assert.deepEqual(classifyCredential('rejected', at(31), now), {level: 'danger', days_left: 31});
  assert.deepEqual(classifyCredential('rejected', at(-1), now), {level: 'expired', days_left: -1});
  assert.deepEqual(classifyCredential('rejected', null, now), {level: 'danger', days_left: null});
  assert.deepEqual(classifyCredential('ok', null, now), {level: 'ok', days_left: null});
  assert.deepEqual(classifyCredential('unknown', at(10), now), {level: 'unknown', days_left: null});
  assert.deepEqual(classifyCredential(null, null, now), {level: 'unknown', days_left: null});
  assert.equal(parseGitHubTokenExpiration('2027-09-30 04:00:00 UTC')?.toISOString(), '2027-09-30T04:00:00.000Z');
  assert.equal(parseGitHubTokenExpiration('  2027-09-30 04:00:00 UTC  ')?.toISOString(), '2027-09-30T04:00:00.000Z');
  for (const header of [null, undefined, '', '2027-09-30T04:00:00Z', '2027-09-30 04:00:00 utc', '2027-02-31 00:00:00 UTC']) assert.equal(parseGitHubTokenExpiration(header), null);
});

test('a sync records the first token expiry once and does not add a GitHub request', async () => {
  await parkAll();
  await dueFeed();
  await dueRepo();
  const calls: string[] = [];
  const summary = await syncGitHubRepositories(pool, {
    token: SECRET, now: () => T0,
    fetcher: async input => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/events')) return json([openedIssue('once-events')], 200, {[HEADER]: EVENTS_EXPIRY});
      if (url.includes('/issues')) return json([item(1)], 200, {[HEADER]: ISSUES_EXPIRY});
      throw new Error(`unexpected ${url}`);
    },
  });
  assert.equal(summary.requests, 2);
  assert.equal(calls.length, summary.requests);
  const row = await githubRow();
  assert.equal(row.status, 'ok');
  assert.equal(new Date(row.expires_at!).toISOString(), '2027-09-30T04:00:00.000Z');
  assert.equal(row.source, 'github_response');
  assert.equal(row.note, null);
  assert.equal(JSON.stringify(row).includes(SECRET), false);
});

test('a token response without the expiry header records null and ignores a later header', async () => {
  await parkAll();
  await dueFeed();
  await dueRepo();
  const calls: string[] = [];
  const summary = await syncGitHubRepositories(pool, {
    token: SECRET, now: () => T0,
    fetcher: async input => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/events')) return json([openedIssue('missing-header')]);
      if (url.includes('/issues')) return json([item(2)], 200, {[HEADER]: ISSUES_EXPIRY});
      throw new Error(`unexpected ${url}`);
    },
  });
  assert.equal(summary.requests, calls.length);
  assert.equal(calls.length, 2);
  const row = await githubRow();
  assert.equal(row.status, 'ok');
  assert.equal(row.expires_at, null);
});

test('401 records rejected and a later anonymous success does not replace it', async () => {
  await parkAll();
  await dueRepo();
  const calls: string[] = [];
  const summary = await syncGitHubRepositories(pool, {
    token: SECRET, now: () => T0,
    fetcher: async (input, init) => {
      calls.push(String(input));
      const authorized = new Headers(init?.headers).has('authorization');
      if (authorized) return json({message: 'Bad credentials'}, 401, {[HEADER]: EVENTS_EXPIRY});
      return json([item(3)], 200, {[HEADER]: ISSUES_EXPIRY});
    },
  });
  assert.equal(summary.requests, 2);
  assert.equal(calls.length, summary.requests);
  const row = await githubRow();
  assert.equal(row.status, 'rejected');
  assert.equal(new Date(row.expires_at!).toISOString(), '2027-09-30T04:00:00.000Z');
});

test('a later 401 replaces an earlier ok expiry', async () => {
  await parkAll();
  await dueFeed();
  await dueRepo();
  const calls: string[] = [];
  const summary = await syncGitHubRepositories(pool, {
    token: SECRET, now: () => T0,
    fetcher: async (input, init) => {
      const url = String(input);
      calls.push(url);
      const authorized = new Headers(init?.headers).has('authorization');
      if (url.includes('/events')) return json([openedIssue('before-401')], 200, {[HEADER]: EVENTS_EXPIRY});
      if (!authorized) return json([item(4)]);
      return json({message: 'Bad credentials'}, 401, {[HEADER]: ISSUES_EXPIRY});
    },
  });
  assert.equal(summary.requests, 3);
  assert.equal(calls.length, summary.requests);
  const row = await githubRow();
  assert.equal(row.status, 'rejected');
  assert.equal(new Date(row.expires_at!).toISOString(), '2028-01-15T00:00:00.000Z');
});

test('a 403 organization rejection does not mark the token rejected', async () => {
  await parkAll();
  await dueFeed();
  const calls: string[] = [];
  const summary = await syncGitHubRepositories(pool, {
    token: SECRET, now: () => T0,
    fetcher: async (input, init) => {
      calls.push(String(input));
      if (new Headers(init?.headers).has('authorization')) return json({message: 'organization policy'}, 403, {[HEADER]: EVENTS_EXPIRY});
      return json([openedIssue('anonymous-events')], 200, {[HEADER]: ISSUES_EXPIRY});
    },
  });
  assert.equal(summary.requests, 2);
  assert.equal(calls.length, summary.requests);
  const row = await githubRow();
  assert.equal(row.status, 'ok');
  assert.equal(new Date(row.expires_at!).toISOString(), '2027-09-30T04:00:00.000Z');
});

test('no token records unknown once, including budget zero and an anonymous backoff', async () => {
  await parkAll();
  await dueRepo();
  const blocked: string[] = [];
  const quiet = await syncGitHubRepositories(pool, {budget: 0, now: () => T0, fetcher: async () => { blocked.push('fetch'); throw new Error('must not fetch'); }});
  assert.equal(quiet.requests, 0);
  assert.equal(blocked.length, 0);
  assert.equal(quiet.stop_reason, 'budget');
  let row = await githubRow();
  assert.equal(row.status, 'unknown');
  assert.equal(row.expires_at, null);
  assert.equal(row.source, 'github_response');
  await pool.query('DELETE FROM platform_credential_status');
  await pool.query(`INSERT INTO github_sync_backoff(backoff_key, until_at) VALUES('anonymous', $1)`, [FAR]);
  const stopped = await syncGitHubRepositories(pool, {now: () => T0, fetcher: async () => { blocked.push('fetch'); throw new Error('must not fetch'); }});
  assert.equal(stopped.requests, 0);
  assert.equal(stopped.stop_reason, 'rate_limited');
  assert.equal(blocked.length, 0);
  row = await githubRow();
  assert.equal(row.status, 'unknown');
  await pool.query('DELETE FROM platform_credential_status');
  await pool.query('DELETE FROM github_sync_backoff');
  const held = await syncGitHubRepositories(pool, {token: SECRET, budget: 0, now: () => T0, fetcher: async () => { throw new Error('must not fetch'); }});
  assert.equal(held.requests, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM platform_credential_status')).rows[0].n, 0);
});

test('book metrics record the token header without a second request', async () => {
  await parkAll();
  const target = catalogMetricTargets()[0];
  assert.ok(target);
  await pool.query('UPDATE github_repository_metrics SET retry_after=$2, snapshot=NULL, last_error=NULL WHERE repository_key=$1', [target.key, new Date(T0 - 1000)]);
  const calls: string[] = [];
  const summary = await syncGitHubRepositories(pool, {
    token: SECRET, now: () => T0,
    fetcher: async (input, init) => {
      calls.push(String(input));
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${SECRET}`);
      return json(metricBody(), 200, {[HEADER]: EVENTS_EXPIRY});
    },
  });
  assert.equal(summary.requests, 1);
  assert.equal(calls.length, 1);
  const row = await githubRow();
  assert.equal(row.status, 'ok');
  assert.equal(new Date(row.expires_at!).toISOString(), '2027-09-30T04:00:00.000Z');
  assert.equal(JSON.stringify(row).includes(SECRET), false);
});

test('a credential write failure is logged by code and does not fail the sync or retry', async () => {
  await parkAll();
  await dueFeed();
  await dueRepo();
  await pool.query(`CREATE FUNCTION fp_block_credential_status() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'blocked' USING ERRCODE = '23514'; END $$`);
  await pool.query('CREATE TRIGGER fp_block_credential_status BEFORE INSERT OR UPDATE ON platform_credential_status FOR EACH ROW EXECUTE FUNCTION fp_block_credential_status()');
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const calls: string[] = [];
    const summary = await syncGitHubRepositories(pool, {
      token: SECRET, now: () => T0,
      fetcher: async input => {
        const url = String(input);
        calls.push(url);
        if (url.includes('/events')) return json([openedIssue('db-down')]);
        if (url.includes('/issues')) return json([item(8)]);
        throw new Error(`unexpected ${url}`);
      },
    });
    assert.equal(summary.requests, 2);
    assert.equal(calls.length, 2);
    assert.equal(summary.stop_reason, 'completed');
    assert.deepEqual(warnings, [['github_credential_status_failed', '23514']]);
    assert.equal(JSON.stringify(warnings).includes(SECRET), false);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM platform_credential_status')).rows[0].n, 0);
  } finally {
    console.warn = original;
    await pool.query('DROP TRIGGER IF EXISTS fp_block_credential_status ON platform_credential_status');
    await pool.query('DROP FUNCTION IF EXISTS fp_block_credential_status()');
  }
});

test('credentials are platform-admin only and missing rows stay unknown', async () => {
  await resetAdmin();
  assert.equal((await request('/credentials', undefined, undefined, {'Cf-Access-Jwt-Assertion': ''})).status, 401);
  assert.equal((await request('/credentials', undefined, undefined, {'Cf-Access-Jwt-Assertion': await sign('not-nominated@example.invalid')})).status, 403);
  const listed = await request('/credentials');
  assert.equal(listed.status, 200);
  assert.equal(listed.response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(listed.data.items.map((item: {credential_key: string}) => item.credential_key), ['github_metrics_token', 'cloudflare_deploy_token']);
  assert.equal(listed.data.items[0].label, 'GitHub 讀取權杖');
  assert.equal(listed.data.items[1].label, 'Cloudflare 部署權杖');
  assert.equal(listed.data.items[0].renewable, false);
  assert.equal(listed.data.items[1].renewable, true);
  assert.equal(listed.data.items[0].level, 'unknown');
  assert.equal(listed.data.items[0].days_left, null);
  assert.equal(listed.data.items[0].status, 'unknown');
  assert.equal(listed.data.items[1].open_request, null);
  assert.equal(listed.data.items[1].last_request, null);
  assert.match(listed.data.items[0].renew_hint, /GitHub/);
  assert.match(listed.data.items[1].renew_hint, /維護者的電腦/);
});

test('days_left boundaries are 31, 30, 7 and -1', async () => {
  await resetAdmin();
  const cases = [
    [`now() + interval '31 days' + interval '1 hour'`, 'ok', 'ok', 31],
    [`now() + interval '30 days' + interval '1 hour'`, 'ok', 'warning', 30],
    [`now() + interval '7 days' + interval '1 hour'`, 'ok', 'danger', 7],
    [`now() - interval '12 hours'`, 'ok', 'expired', -1],
    [`now() + interval '40 days' + interval '1 hour'`, 'rejected', 'danger', 40],
  ] as const;
  for (const [expires, status, level, days] of cases) {
    await pool.query(`INSERT INTO platform_credential_status(credential_key, status, expires_at, checked_at, source)
      VALUES('github_metrics_token', $1, ${expires}, now(), 'github_response')
      ON CONFLICT (credential_key) DO UPDATE SET status=EXCLUDED.status, expires_at=EXCLUDED.expires_at, checked_at=EXCLUDED.checked_at, source=EXCLUDED.source`, [status]);
    const item = (await request('/credentials')).data.items[0];
    assert.equal(item.level, level, expires);
    assert.equal(item.days_left, days, expires);
    assert.equal(item.status, status);
  }
  await pool.query(`INSERT INTO platform_credential_status(credential_key, status, expires_at, checked_at, source)
    VALUES('github_metrics_token', 'unknown', now() + interval '10 days', now(), 'github_response')
    ON CONFLICT (credential_key) DO UPDATE SET status=EXCLUDED.status, expires_at=EXCLUDED.expires_at, checked_at=EXCLUDED.checked_at, source=EXCLUDED.source`);
  const unknown = (await request('/credentials')).data.items[0];
  assert.equal(unknown.level, 'unknown');
  assert.equal(unknown.days_left, null);
});

test('a Cloudflare renewal is idempotent, audited, and completed by the executor statements', async () => {
  await resetAdmin();
  const path = '/credentials/cloudflare_deploy_token/renewals';
  assert.equal((await request(path, {}, randomUUID(), {'X-Admin-CSRF': 'wrong'})).status, 403);
  assert.equal((await request(path, {}, '')).data.code, 'idempotency_required');
  assert.equal((await request(path, {extra: true})).status, 422);
  const key = randomUUID();
  const created = await request(path, {}, key);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.state, 'pending');
  assert.equal(created.data.error_code, null);
  const replay = await request(path, {}, key);
  assert.equal(replay.status, 201);
  assert.deepEqual(replay.data, created.data);
  const same = await Promise.all([request(path, {}, randomUUID()), request(path, {}, randomUUID())]);
  assert.deepEqual(same.map(item => item.status).sort(), [200, 200]);
  assert.equal(same[0].data.request_id, created.data.request_id);
  assert.equal(same[1].data.request_id, created.data.request_id);
  const audit = await pool.query(`SELECT action, target_type, target_ref, reason, before_state, after_state FROM platform_admin_audit`);
  assert.equal(audit.rowCount, 1);
  assert.equal(audit.rows[0].action, 'credential_renewal_request');
  assert.equal(audit.rows[0].target_type, 'platform_credential');
  assert.equal(audit.rows[0].target_ref, 'cloudflare_deploy_token');
  assert.equal(audit.rows[0].reason, '送出 Cloudflare 部署權杖續期請求。');
  assert.equal(audit.rows[0].before_state, null);
  assert.equal(audit.rows[0].after_state.request_id, created.data.request_id);
  const open = (await request('/credentials')).data.items[1];
  assert.equal(open.open_request.request_id, created.data.request_id);
  assert.equal(open.open_request.state, 'pending');
  assert.equal(open.last_request, null);
  const claimed = await pool.query<{request_id: string}>(CLAIM);
  assert.equal(claimed.rows[0].request_id, created.data.request_id);
  assert.equal((await request('/credentials')).data.items[1].open_request.state, 'processing');
  const extended = new Date(Date.now() + 40 * DAY);
  await pool.query(COMPLETE, [created.data.request_id, 'done', extended, null]);
  await pool.query(UPSERT, ['ok', extended, null]);
  const done = (await request('/credentials')).data.items[1];
  assert.equal(done.open_request, null);
  assert.equal(done.last_request.state, 'done');
  assert.equal(done.last_request.result_expires_at, extended.toISOString());
  assert.equal(done.last_request.error_code, null);
  assert.equal(done.status, 'ok');
  assert.equal(done.level, 'ok');
  const follow = await request(path, {});
  assert.equal(follow.status, 201);
  await pool.query(CLAIM);
  await pool.query(COMPLETE, [follow.data.request_id, 'failed', null, 'renew_failed']);
  const failed = (await request('/credentials')).data.items[1];
  assert.equal(failed.open_request, null);
  assert.equal(failed.last_request.state, 'failed');
  assert.equal(failed.last_request.error_code, 'renew_failed');
  assert.equal(failed.last_request.request_id, follow.data.request_id);
  await pool.query('UPDATE users SET active=false WHERE user_id=$1', [DEMO_USERS[0].user_id]);
  const inactive = await request(path, {});
  assert.equal(inactive.status, 422);
  assert.equal(inactive.data.code, 'member_account_required');
  await pool.query('UPDATE platform_admins SET email=$2 WHERE admin_id=$1', [adminId, 'nobody@example.invalid']);
  jwt = await sign('nobody@example.invalid');
  csrf = (await verifier(new Request(origin, {headers: {'Cf-Access-Jwt-Assertion': jwt}}))).csrfToken;
  const missing = await request(path, {});
  assert.equal(missing.status, 422);
  assert.equal(missing.data.code, 'member_account_required');
});

test('an unknown credential key is not a renewal', async () => {
  await resetAdmin();
  for (const key of ['github_metrics_token', 'GITHUB', 'cloudflare_deploy_token_extra']) {
    const response = await request(`/credentials/${key}/renewals`, {extra: true}, 'short');
    assert.equal(response.status, 404, key);
    assert.equal(response.data.code, 'not_found');
  }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM platform_credential_renewal_requests')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM platform_admin_audit')).rows[0].n, 0);
});
