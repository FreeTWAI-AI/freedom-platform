import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { exportPKCS8, exportSPKI, generateKeyPair, importSPKI, jwtVerify } from 'jose';
import { createPool, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { claimMaintainerJob, runMaintainerTick, type MaintainerTickConfig } from '../../modules/repo-maintainer/tick.js';
import { enqueueReconcilePull } from '../../modules/repo-maintainer/queue.js';
import { changeRepositorySettings } from '../../modules/repo-maintainer/service.js';
import { READ_PERMISSIONS } from '../../modules/repo-maintainer/github.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_msync_${process.pid}_${Date.now()}`;
const database = createPool(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 });
const community = randomUUID();
const APP_ID = '12345';
const ORG = 'FreeTWAI-AI';
const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const TOKEN = 'ghs_synthetic_token_value';
const pair = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
const privateKey = await exportPKCS8(pair.privateKey);
const publicKey = await exportSPKI(pair.publicKey);
const realFetch = globalThis.fetch;
let clock = new Date('2026-09-30T12:00:00.000Z');
const now = () => new Date(clock.getTime());
const config: MaintainerTickConfig = { appId: APP_ID, organization: ORG, privateKey };

type Call = { method: string; host: string; path: string; search: string; authorization: string; body: unknown };
let calls: Call[] = [];
let respond: (call: Call) => Response = () => new Response('missing', { status: 404 });

before(async () => {
  globalThis.fetch = async () => { throw new Error('real fetch blocked'); };
  await database.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  await pool.query('INSERT INTO communities (community_id, name) VALUES ($1,$2)', [community, 'Sync fixture']);
});
after(async () => {
  globalThis.fetch = realFetch;
  await pool.end();
  await database.query(`DROP SCHEMA ${schema} CASCADE`);
  await database.end();
});
beforeEach(async () => {
  clock = new Date('2026-09-30T12:00:00.000Z');
  calls = [];
  respond = () => new Response('missing', { status: 404 });
  await pool.query('TRUNCATE maintainer_webhook_deliveries, maintainer_jobs, maintainer_pull_requests, maintainer_repositories, maintainer_reviewers CASCADE');
  await pool.query(`UPDATE maintainer_worker_state SET next_installation_sync_at='2099-01-01T00:00:00Z', last_installation_sync_at=NULL, last_error=NULL WHERE singleton`);
});

const fetcher: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const headers = new Headers(init?.headers);
  const call: Call = {
    method: init?.method ?? 'GET', host: url.hostname, path: url.pathname, search: url.search,
    authorization: headers.get('authorization') ?? '', body: init?.body ? JSON.parse(String(init.body)) : null,
  };
  calls.push(call);
  if (url.hostname !== 'api.github.com') return new Response('wrong host', { status: 500 });
  return respond(call);
};
function tick(budget?: number) {
  return runMaintainerTick(pool, config, { fetcher, now, budget });
}
async function verifyAppJwt(authorization: string) {
  const token = authorization.replace(/^Bearer /, '');
  const { payload, protectedHeader } = await jwtVerify(token, await importSPKI(publicKey, 'RS256'), { currentDate: clock });
  assert.equal(protectedHeader.alg, 'RS256');
  assert.equal(payload.iss, APP_ID);
  assert.equal(Number(payload.exp) - Number(payload.iat), 600);
  assert.equal(payload.iat, Math.floor(clock.getTime() / 1000) - 60);
}
async function insertRepo(id = randomUUID(), githubId = '9001', installation = '77', full = 'FreeTWAI-AI/freedom-platform', sweep = '2099-01-01T00:00:00Z') {
  await pool.query(`INSERT INTO maintainer_repositories
    (repository_id, community_id, github_repository_id, installation_id, full_name, default_branch, installation_state, mode, next_sweep_at)
    VALUES ($1,$2,$3,$4,$5,'main','active','observe',$6)`, [id, community, githubId, installation, full, sweep]);
  return id;
}
async function insertPull(repository: string, number: number, head = SHA, updated = '2026-09-01T00:00:00.000Z', title = 'Stored', options: { synced?: string; queue?: string; mergeable?: boolean | null } = {}) {
  const synced = options.synced ?? clock.toISOString();
  const queue = options.queue ?? 'awaiting_review';
  const mergeable = options.mergeable === undefined ? true : options.mergeable;
  await pool.query(`INSERT INTO maintainer_pull_requests (
    pull_id, repository_id, number, github_pull_id, title, html_url, state, is_draft, author_github_id, author_login, author_type,
    author_association, is_fork, head_sha, base_ref, base_sha, mergeable, labels, additions, deletions, changed_files, github_created_at,
    github_updated_at, head_observed_at, risk_class, risk_reasons, queue_state, queue_reasons, policy_version, synced_at)
    VALUES ($1,$2,$3,$4,$5,$6,'open',false,'42','octocat','User','CONTRIBUTOR',false,$7,'main',$8,$9,'{}',1,0,1,$10,$10,$10,'low','[]',$11,'[]','2026-09-30.1',$12)`,
  [randomUUID(), repository, number, String(700 + number), title, `https://github.com/FreeTWAI-AI/freedom-platform/pull/${number}`, head, BASE, mergeable, updated, queue, synced]);
}
async function insertJob(repository: string, number: number, state = 'queued', attempts = 0, runAfter: Date = clock, lease: Date | null = null) {
  const id = randomUUID();
  await pool.query(`INSERT INTO maintainer_jobs (job_id, repository_id, kind, dedupe_key, payload, state, attempts, max_attempts, run_after, lease_until)
    VALUES ($1,$2,'reconcile_pull',$3,$4::jsonb,$5,$6,5,$7,$8)`,
  [id, repository, `reconcile_pull:${repository}:${number}`, JSON.stringify({ number }), state, attempts, runAfter, lease]);
  return id;
}
function pullBody(over: Record<string, unknown> = {}) {
  return {
    id: 555, number: 8, title: 'Observe me', html_url: 'https://github.com/FreeTWAI-AI/freedom-platform/pull/8',
    state: 'open', merged_at: null, closed_at: null, draft: false, user: { id: 42, login: 'octocat', type: 'User' },
    author_association: 'CONTRIBUTOR', head: { sha: SHA, repo: { id: 9001, fork: false } },
    base: { ref: 'main', sha: BASE, repo: { id: 9001 } }, mergeable: true, mergeable_state: 'clean', labels: [],
    additions: 3, deletions: 1, changed_files: 1, created_at: '2026-09-29T00:00:00.000Z', updated_at: '2026-09-30T00:00:00.000Z', ...over,
  };
}
function installRoutes(pulls: unknown[], extras: (call: Call) => Response | null = () => null) {
  respond = call => {
    const special = extras(call);
    if (special) return special;
    if (call.method === 'POST' && call.path.endsWith('/access_tokens')) {
      return Response.json({ token: TOKEN, permissions: (call.body as { permissions: Record<string, string> }).permissions }, { status: 201 });
    }
    if (call.path.endsWith('/pulls')) return Response.json(pulls);
    if (/\/pulls\/\d+$/.test(call.path)) return Response.json(pullBody({ number: Number(call.path.split('/').pop()) }));
    if (call.path.endsWith('/files')) return Response.json([{ filename: 'apps/portal-web/src/App.tsx', status: 'modified', additions: 3, deletions: 1 }]);
    if (call.path.endsWith('/reviews')) return Response.json([]);
    if (/\/app\/installations\/\d+\/repositories$/.test(call.path)) return new Response('missing', { status: 404 });
    if (call.path.endsWith('/check-runs')) return Response.json({ check_runs: [{ id: 1, name: 'verify', status: 'completed', conclusion: 'success', app: { id: 15368, slug: 'github-actions' } }] });
    if (call.path.endsWith('/status')) return Response.json({ statuses: [] });
    return new Response('missing ' + call.path, { status: 404 });
  };
}
function assertHosts() {
  assert.deepEqual([...new Set(calls.map(call => call.host))], calls.length ? ['api.github.com'] : []);
}

test('installation sync keeps the organization and lists its repositories with one metadata token', async () => {
  const kept = await insertRepo(randomUUID(), '9001');
  const gone = await insertRepo(randomUUID(), '9002', '77', 'FreeTWAI-AI/old-name');
  await pool.query(`UPDATE maintainer_worker_state SET next_installation_sync_at=$1 WHERE singleton`, [clock]);
  respond = call => {
    if (/\/app\/installations\/\d+\/repositories$/.test(call.path)) return new Response('missing', { status: 404 });
    if (call.path === '/app/installations') return Response.json([
      { id: 77, account: { login: 'FreeTWAI-AI', type: 'Organization' }, suspended_at: null },
      { id: 78, account: { login: 'FreeTWAI-AI', type: 'User' }, suspended_at: null },
      { id: 79, account: { login: 'OtherOrg', type: 'Organization' }, suspended_at: null },
    ]);
    if (call.method === 'POST' && call.path === '/app/installations/77/access_tokens') {
      return Response.json({ token: TOKEN, permissions: (call.body as { permissions: Record<string, string> }).permissions }, { status: 201 });
    }
    if (call.path === '/installation/repositories') {
      if (call.authorization !== `Bearer ${TOKEN}`) return new Response('missing', { status: 404 });
      return Response.json({ total_count: 1, repository_selection: 'selected', repositories: [{ id: 9001, full_name: 'FreeTWAI-AI/freedom-platform', default_branch: 'main' }] });
    }
    return new Response('unexpected', { status: 500 });
  };
  const logged: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  let summary;
  try { summary = await tick(); } finally { console.log = original; }
  assert.equal(summary.ignored_accounts, 2);
  assert.equal(summary.suspended_installations, 0);
  assert.equal(summary.repositories_upserted, 1);
  assert.equal(summary.repositories_removed, 1);
  assert.equal(summary.stopped, null);
  const mints = calls.filter(call => call.method === 'POST');
  assert.equal(mints.length, 1);
  assert.equal(mints[0].path, '/app/installations/77/access_tokens');
  const minted = mints[0].body as Record<string, unknown>;
  assert.deepEqual(minted.permissions, { metadata: 'read' });
  assert.equal(Object.hasOwn(minted, 'repository_ids'), false);
  assert.equal(Object.hasOwn(minted, 'repositories'), false);
  await verifyAppJwt(mints[0].authorization);
  const listed = calls.find(call => call.path === '/installation/repositories');
  assert.ok(listed);
  assert.equal(listed.authorization, `Bearer ${TOKEN}`);
  assert.notEqual(listed.authorization, mints[0].authorization);
  assert.equal(calls.some(call => /\/app\/installations\/\d+\/repositories$/.test(call.path)), false);
  assert.equal(calls.some(call => call.path.includes('/installations/78/') || call.path.includes('/installations/79/')), false);
  await verifyAppJwt(calls[0].authorization);
  const keptRow = (await pool.query('SELECT next_sweep_at, installation_state FROM maintainer_repositories WHERE repository_id=$1', [kept])).rows[0];
  assert.equal(new Date(keptRow.next_sweep_at).getUTCFullYear(), 2099);
  assert.equal(keptRow.installation_state, 'active');
  assert.equal((await pool.query('SELECT installation_state FROM maintainer_repositories WHERE repository_id=$1', [gone])).rows[0].installation_state, 'removed');
  assert.equal(logged.join('\n').includes(TOKEN), false);
  assert.equal(logged.join('\n').includes(privateKey.slice(40, 80)), false);
  assertHosts();
});

test('a truncated installation repository list does not mark a missing repository removed', async () => {
  await insertRepo(randomUUID(), '9002');
  for (let index = 0; index < 100; index += 1) await insertRepo(randomUUID(), String(3000 + index), '77', `FreeTWAI-AI/repo${index}`);
  await pool.query(`UPDATE maintainer_worker_state SET next_installation_sync_at=$1 WHERE singleton`, [clock]);
  respond = call => {
    if (/\/app\/installations\/\d+\/repositories$/.test(call.path)) return new Response('missing', { status: 404 });
    if (call.path === '/app/installations') return Response.json([{ id: 77, account: { login: 'freetwai-ai', type: 'Organization' }, suspended_at: null }]);
    if (call.method === 'POST' && call.path === '/app/installations/77/access_tokens') {
      return Response.json({ token: TOKEN, permissions: (call.body as { permissions: Record<string, string> }).permissions }, { status: 201 });
    }
    if (call.path === '/installation/repositories') {
      if (call.authorization !== `Bearer ${TOKEN}`) return new Response('missing', { status: 404 });
      const repos = Array.from({ length: 100 }, (_, index) => ({ id: 3000 + index, full_name: `FreeTWAI-AI/repo${index}`, default_branch: 'main' }));
      return Response.json({ total_count: repos.length, repository_selection: 'all', repositories: repos });
    }
    return new Response('unexpected', { status: 500 });
  };
  const summary = await tick();
  assert.equal(summary.repositories_removed, 0);
  assert.equal(summary.ignored_accounts, 0);
  assert.equal((await pool.query(`SELECT installation_state FROM maintainer_repositories WHERE github_repository_id='9002'`)).rows[0].installation_state, 'active');
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(calls.some(call => /\/app\/installations\/\d+\/repositories$/.test(call.path)), false);
  assertHosts();
});

test('a sweep enqueues new, changed and missing pulls, and leaves an unchanged pull alone', async () => {
  const repository = await insertRepo(randomUUID(), '9001', '77', 'FreeTWAI-AI/freedom-platform', clock.toISOString());
  await insertPull(repository, 1, SHA, '2026-09-01T00:00:00.000Z');
  await insertPull(repository, 2, SHA, '2026-09-01T00:00:00.000Z');
  await insertPull(repository, 3, SHA, '2026-09-01T00:00:00.000Z');
  installRoutes([
    { number: 1, updated_at: '2026-09-01T00:00:00.000Z', head: { sha: SHA } },
    { number: 2, updated_at: '2026-09-01T00:00:00.000Z', head: { sha: SHA2 } },
    { number: 4, updated_at: '2026-09-02T00:00:00.000Z', head: { sha: SHA } },
  ], call => /\/pulls\/\d+$/.test(call.path) ? new Response('gone', { status: 404 }) : null);
  const summary = await tick();
  assert.equal(summary.sweeps, 1);
  const tokenCall = calls.find(call => call.path.endsWith('/access_tokens'));
  assert.ok(tokenCall);
  assert.deepEqual((tokenCall.body as { repository_ids: number[]; permissions: unknown }).repository_ids, [9001]);
  assert.deepEqual((tokenCall.body as { permissions: Record<string, string> }).permissions, { ...READ_PERMISSIONS });
  await verifyAppJwt(tokenCall.authorization);
  const numbers = (await pool.query(`SELECT (payload->>'number')::int AS number FROM maintainer_jobs ORDER BY 1`)).rows.map(row => row.number);
  assert.deepEqual(numbers, [2, 3, 4]);
  const swept = (await pool.query('SELECT last_swept_at FROM maintainer_repositories WHERE repository_id=$1', [repository])).rows[0];
  assert.equal(new Date(swept.last_swept_at).toISOString(), clock.toISOString());
  assertHosts();
});

test('reconcile stores the mirror and an out-of-order run does not overwrite it', async () => {
  const repository = await insertRepo();
  await insertJob(repository, 8);
  installRoutes([]);
  const logged: string[] = [];
  const originals = [console.log, console.error, console.warn];
  const record = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  console.log = record; console.error = record; console.warn = record;
  let summary;
  try { summary = await tick(); } finally { console.log = originals[0]; console.error = originals[1]; console.warn = originals[2]; }
  assert.equal(summary.jobs_done, 1);
  const row = (await pool.query('SELECT title, queue_state, risk_class, policy_version, aggregate_version FROM maintainer_pull_requests')).rows[0];
  assert.equal(row.title, 'Observe me');
  assert.equal(row.queue_state, 'awaiting_review');
  assert.equal(row.risk_class, 'medium');
  assert.equal(row.policy_version, '2026-09-30.1');
  assert.equal((await pool.query(`SELECT app_slug, conclusion FROM maintainer_checks`)).rows[0].app_slug, 'github-actions');
  assert.equal(logged.join('\n').includes(TOKEN), false);
  assert.equal(logged.join('\n').includes(privateKey.slice(40, 80)), false);
  await pool.query(`UPDATE maintainer_pull_requests SET title='kept title', github_updated_at='2026-09-30T08:00:00.000Z'`);
  await pool.query('TRUNCATE maintainer_jobs');
  await insertJob(repository, 8);
  installRoutes([], call => /\/pulls\/8$/.test(call.path) ? Response.json(pullBody({ updated_at: '2026-09-30T00:00:00.000Z', title: 'newer title ignored' })) : null);
  const second = await tick();
  assert.equal(second.jobs_done, 1);
  assert.equal((await pool.query('SELECT title, aggregate_version FROM maintainer_pull_requests')).rows[0].title, 'kept title');
  assertHosts();
});

test('a changed base repository fails the job and asks for an installation sync', async () => {
  const repository = await insertRepo();
  await insertPull(repository, 8, SHA, '2026-09-01T00:00:00.000Z', 'untouched');
  await insertJob(repository, 8);
  installRoutes([], call => /\/pulls\/8$/.test(call.path) ? Response.json(pullBody({ base: { ref: 'main', sha: BASE, repo: { id: 111 } } })) : null);
  const summary = await tick();
  assert.equal(summary.jobs_failed, 1);
  const job = (await pool.query('SELECT state, last_error FROM maintainer_jobs')).rows[0];
  assert.equal(job.state, 'failed');
  assert.equal(job.last_error, 'repository_identity_changed');
  assert.equal((await pool.query('SELECT title FROM maintainer_pull_requests')).rows[0].title, 'untouched');
  const next = (await pool.query('SELECT next_installation_sync_at FROM maintainer_worker_state')).rows[0].next_installation_sync_at as Date;
  assert.equal(next.toISOString(), clock.toISOString());
  assertHosts();
});

test('a request budget and a rate limit release the job without counting an attempt', async () => {
  const repository = await insertRepo();
  const other = await insertRepo(randomUUID(), '9002', '77', 'FreeTWAI-AI/other');
  const outsider = await insertRepo(randomUUID(), '9003', '88', 'FreeTWAI-AI/elsewhere');
  await insertJob(repository, 8);
  installRoutes([]);
  const budget = await tick(1);
  assert.equal(budget.stopped, 'budget');
  assert.equal(budget.github_requests, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  let job = (await pool.query('SELECT state, attempts, lease_until, last_error FROM maintainer_jobs')).rows[0];
  assert.equal(job.state, 'queued');
  assert.equal(job.attempts, 0);
  assert.equal(job.lease_until, null);
  assert.equal(job.last_error, 'github_budget');
  assert.equal((await pool.query('SELECT aggregate_version FROM maintainer_repositories WHERE repository_id=$1', [repository])).rows[0].aggregate_version, '1');

  calls = [];
  const reset = Math.floor((clock.getTime() + 10 * 60_000) / 1000);
  respond = call => new Response(JSON.stringify({ message: 'slow down' }), {
    status: 403,
    headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
  });
  const limited = await tick();
  assert.equal(limited.stopped, 'rate_limit');
  job = (await pool.query('SELECT state, attempts FROM maintainer_jobs')).rows[0];
  assert.equal(job.state, 'queued');
  assert.equal(job.attempts, 0);
  const limitedUntil = (await pool.query('SELECT rate_limited_until, aggregate_version FROM maintainer_repositories WHERE repository_id=$1', [repository])).rows[0];
  assert.ok(Math.abs(new Date(limitedUntil.rate_limited_until).getTime() - reset * 1000) < 2000);
  assert.equal(limitedUntil.aggregate_version, '1');
  const sibling = (await pool.query('SELECT rate_limited_until FROM maintainer_repositories WHERE repository_id=$1', [other])).rows[0].rate_limited_until;
  assert.ok(sibling);
  assert.equal((await pool.query('SELECT rate_limited_until FROM maintainer_repositories WHERE repository_id=$1', [outsider])).rows[0].rate_limited_until, null);
  assertHosts();
});

test('two claimers take different jobs and an expired lease is reclaimed', async () => {
  const repository = await insertRepo();
  const first = await insertJob(repository, 1);
  const second = await insertJob(repository, 2);
  const claimed = await Promise.all([claimMaintainerJob(pool, clock), claimMaintainerJob(pool, clock)]);
  const ids = claimed.map(job => job?.job_id).sort();
  assert.deepEqual(ids, [first, second].sort());
  assert.equal(await claimMaintainerJob(pool, clock), null);
  const expired = await insertJob(repository, 3, 'running', 1, new Date(clock.getTime() - 60_000), new Date(clock.getTime() - 1000));
  const reclaimed = await claimMaintainerJob(pool, clock);
  assert.equal(reclaimed?.job_id, expired);
  assert.equal(reclaimed?.attempts, 2);
});

test('failures back off and the fifth attempt fails; a missing migrations directory is empty', async () => {
  const repository = await insertRepo();
  await insertJob(repository, 8);
  respond = call => {
    if (call.method === 'POST') return Response.json({ token: TOKEN, permissions: { ...READ_PERMISSIONS } }, { status: 201 });
    if (/\/pulls\/8$/.test(call.path)) return new Response('boom', { status: 500 });
    return new Response('missing', { status: 404 });
  };
  const delays = [1, 5, 15, 60];
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const summary = await tick();
    assert.equal(summary.jobs_released, 1, String(attempt));
    const job = (await pool.query('SELECT state, attempts, run_after, last_error FROM maintainer_jobs')).rows[0];
    assert.equal(job.state, 'queued');
    assert.equal(job.attempts, attempt);
    assert.equal(job.last_error, 'github_http_500');
    assert.equal(new Date(job.run_after).getTime(), clock.getTime() + delays[attempt - 1] * 60_000);
    clock = new Date(job.run_after);
    calls = [];
  }
  const failed = await tick();
  assert.equal(failed.jobs_failed, 1);
  const job = (await pool.query('SELECT state, attempts, last_error FROM maintainer_jobs')).rows[0];
  assert.equal(job.state, 'failed');
  assert.equal(job.attempts, 5);
  assert.equal(job.last_error, 'github_http_500');

  await pool.query('TRUNCATE maintainer_jobs, maintainer_pull_requests CASCADE');
  await pool.query(`UPDATE maintainer_repositories SET rate_limited_until=NULL, next_sweep_at='2099-01-01T00:00:00Z'`);
  await insertJob(repository, 8);
  installRoutes([], call => {
    if (call.path.endsWith('/files')) return Response.json([{ filename: 'migrations/060_new.sql', status: 'added', additions: 4, deletions: 0 }]);
    if (call.path.includes('/contents/migrations')) return new Response('absent', { status: 404 });
    if (/\/pulls\/8$/.test(call.path)) return Response.json(pullBody({ changed_files: 1, additions: 4, deletions: 0 }));
    return null;
  });
  const summary = await tick();
  assert.equal(summary.jobs_done, 1, JSON.stringify(summary));
  const stored = (await pool.query('SELECT queue_state, risk_class FROM maintainer_pull_requests')).rows[0];
  assert.equal(stored.risk_class, 'high');
  assert.equal(stored.queue_state, 'needs_owner');
  assert.equal((await pool.query('SELECT last_error FROM maintainer_jobs')).rows[0].last_error, null);
  assertHosts();
});

test('a suspended installation mints nothing, and unsuspend brings its repositories back', async () => {
  const repository = await insertRepo();
  await pool.query(`UPDATE maintainer_worker_state SET next_installation_sync_at=$1 WHERE singleton`, [clock]);
  const page = (suspended: string | null) => {
    respond = call => {
      if (/\/app\/installations\/\d+\/repositories$/.test(call.path)) return new Response('missing', { status: 404 });
      if (call.path === '/app/installations') return Response.json([{ id: 77, account: { login: 'FreeTWAI-AI', type: 'Organization' }, suspended_at: suspended }]);
      if (call.method === 'POST' && call.path.endsWith('/access_tokens')) {
        return Response.json({ token: TOKEN, permissions: (call.body as { permissions: Record<string, string> }).permissions }, { status: 201 });
      }
      if (call.path === '/installation/repositories') {
        if (call.authorization !== `Bearer ${TOKEN}`) return new Response('missing', { status: 404 });
        return Response.json({ total_count: 1, repository_selection: 'selected', repositories: [{ id: 9001, full_name: 'FreeTWAI-AI/freedom-platform', default_branch: 'main' }] });
      }
      return new Response('unexpected', { status: 500 });
    };
  };
  page(null);
  const active = await tick();
  assert.equal(active.suspended_installations, 0);
  assert.equal(active.repositories_upserted, 1);
  assert.equal((await pool.query('SELECT installation_state FROM maintainer_repositories WHERE repository_id=$1', [repository])).rows[0].installation_state, 'active');

  await pool.query(`UPDATE maintainer_worker_state SET next_installation_sync_at=$1 WHERE singleton`, [clock]);
  calls = [];
  page('2026-09-30T01:00:00Z');
  const suspended = await tick();
  assert.equal(suspended.suspended_installations, 1);
  assert.equal(suspended.repositories_upserted, 0);
  assert.equal(suspended.repositories_removed, 1);
  assert.equal(calls.some(call => call.method === 'POST'), false);
  assert.equal(calls.some(call => call.path === '/installation/repositories'), false);
  assert.equal((await pool.query('SELECT installation_state FROM maintainer_repositories WHERE repository_id=$1', [repository])).rows[0].installation_state, 'removed');

  await pool.query(`UPDATE maintainer_worker_state SET next_installation_sync_at=$1 WHERE singleton`, [clock]);
  calls = [];
  page(null);
  const restored = await tick();
  assert.equal(restored.suspended_installations, 0);
  assert.equal(restored.repositories_upserted, 1);
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  assert.equal((await pool.query('SELECT installation_state FROM maintainer_repositories WHERE repository_id=$1', [repository])).rows[0].installation_state, 'active');
  assertHosts();
});

test('migration reasons survive turning the repository off and back to observe', async () => {
  const repository = await insertRepo();
  await insertJob(repository, 8);
  const base = Array.from({ length: 56 }, (_, index) => ({ name: `${String(index + 1).padStart(3, '0')}_base.sql`, type: 'file' }));
  installRoutes([], call => {
    if (call.path.endsWith('/files')) return Response.json([{ filename: 'migrations/048_agent_shops.sql', status: 'added', additions: 4, deletions: 0 }]);
    if (call.path.includes('/contents/migrations')) return Response.json(base);
    if (/\/pulls\/8$/.test(call.path)) return Response.json(pullBody({ changed_files: 1, additions: 4, deletions: 0 }));
    return null;
  });
  const reconciled = await tick();
  assert.equal(reconciled.jobs_done, 1, JSON.stringify(reconciled));
  let row = (await pool.query('SELECT queue_state, migration_reasons FROM maintainer_pull_requests')).rows[0];
  assert.equal(row.queue_state, 'needs_author');
  assert.ok(row.migration_reasons.some((reason: { code: string }) => reason.code === 'migration_number_collision'));
  const adminId = randomUUID();
  await pool.query('INSERT INTO platform_admins (admin_id, community_id, email, display_name) VALUES ($1,$2,$3,$4)', [adminId, community, 'maintainer-admin@example.invalid', 'Maintainer Admin']);
  const admin = { admin_id: adminId, community_id: community, email: 'maintainer-admin@example.invalid', display_name: 'Maintainer Admin', role: 'super_admin' as const, subject: 'fixture-subject' };
  await changeRepositorySettings(pool, { admin, operation: 'POST /admin/api/review-center/repositories/settings', key: randomUUID(), body: { mode: 'off', settings: {}, reason: '先關閉觀察。' }, expected: '1' }, repository);
  const due = (await pool.query('SELECT recheck_at FROM maintainer_pull_requests')).rows[0].recheck_at as Date;
  // now() has microseconds; a Date round-trip can land just before the stored instant.
  clock = new Date(Math.max(clock.getTime(), new Date(due).getTime()) + 1000);
  calls = [];
  await tick();
  assert.equal(calls.length, 0);
  row = (await pool.query('SELECT queue_state, queue_reasons, migration_reasons FROM maintainer_pull_requests')).rows[0];
  assert.equal(row.queue_state, 'paused');
  assert.ok(row.queue_reasons.some((reason: { code: string }) => reason.code === 'repository_off'));
  assert.equal(row.queue_reasons.some((reason: { code: string }) => reason.code === 'migration_number_collision'), false);
  assert.ok(row.migration_reasons.some((reason: { code: string }) => reason.code === 'migration_number_collision'));
  await changeRepositorySettings(pool, { admin, operation: 'POST /admin/api/review-center/repositories/settings', key: randomUUID(), body: { mode: 'observe', settings: {}, reason: '恢復觀察。' }, expected: '2' }, repository);
  const dueAgain = (await pool.query('SELECT recheck_at FROM maintainer_pull_requests')).rows[0].recheck_at as Date;
  clock = new Date(Math.max(clock.getTime(), new Date(dueAgain).getTime()) + 1000);
  calls = [];
  await tick();
  assert.equal(calls.length, 0);
  row = (await pool.query('SELECT queue_state, queue_reasons FROM maintainer_pull_requests')).rows[0];
  assert.equal(row.queue_state, 'needs_author');
  assert.ok(row.queue_reasons.some((reason: { code: string }) => reason.code === 'migration_number_collision'));
});

test('a file list that fills the page cap is mirrored and marked high', async () => {
  const repository = await insertRepo();
  await insertJob(repository, 8);
  installRoutes([], call => {
    if (call.path.endsWith('/files')) {
      const page = Number(new URLSearchParams(call.search).get('page'));
      const batch = Array.from({ length: 100 }, (_, index) => ({ filename: `apps/extra/file-${page}-${index}.ts`, status: 'modified', additions: 1, deletions: 0 }));
      return Response.json(batch);
    }
    if (/\/pulls\/8$/.test(call.path)) return Response.json(pullBody({ changed_files: 1000, additions: 1000, deletions: 0 }));
    return null;
  });
  const summary = await tick();
  assert.equal(summary.jobs_done, 1, JSON.stringify(summary));
  const stored = (await pool.query('SELECT risk_class, risk_reasons, queue_state FROM maintainer_pull_requests')).rows[0];
  assert.equal(stored.risk_class, 'high');
  assert.ok(stored.risk_reasons.some((reason: { code: string }) => reason.code === 'changed_files_truncated'));
  assert.equal((await pool.query('SELECT count(*) FROM maintainer_pull_files')).rows[0].count, '1000');
  assert.equal((await pool.query('SELECT state, last_error FROM maintainer_jobs')).rows[0].state, 'done');
});

test('over-long check names, status contexts and labels are clipped and stored', async () => {
  const repository = await insertRepo();
  await insertJob(repository, 8);
  const longCheck = 'n'.repeat(250);
  const longContext = 'c'.repeat(250);
  const longLabel = 'l'.repeat(250);
  installRoutes([], call => {
    if (call.path.endsWith('/check-runs')) return Response.json({ check_runs: [
      { id: 9, name: longCheck, status: 'completed', conclusion: 'success', app: { id: 1, slug: 'custom' } },
      { id: 3, name: 'verify', status: 'completed', conclusion: 'success', app: { id: 15368, slug: 'github-actions' } },
    ] });
    if (call.path.endsWith('/status')) return Response.json({ statuses: [{ context: longContext, state: 'success' }] });
    if (/\/pulls\/8$/.test(call.path)) return Response.json(pullBody({ labels: [{ name: longLabel }] }));
    return null;
  });
  const summary = await tick();
  assert.equal(summary.jobs_done, 1, JSON.stringify(summary));
  const checks = (await pool.query(`SELECT source, char_length(name)::int AS length FROM maintainer_checks ORDER BY source, name`)).rows;
  assert.deepEqual(checks.map(row => [row.source, row.length]), [['check_run', 200], ['check_run', 6], ['status', 200]]);
  assert.equal((await pool.query('SELECT char_length(labels[1])::int AS length FROM maintainer_pull_requests')).rows[0].length, 100);
});

test('same-named check runs keep the newest id even when the older failure is listed last', async () => {
  const repository = await insertRepo();
  await insertJob(repository, 8);
  installRoutes([], call => {
    if (call.path.endsWith('/check-runs')) return Response.json({ check_runs: [
      { id: 20, name: 'verify', status: 'completed', conclusion: 'success', app: { id: 15368, slug: 'github-actions' } },
      { id: 10, name: 'verify', status: 'completed', conclusion: 'failure', app: { id: 15368, slug: 'github-actions' } },
    ] });
    return null;
  });
  const summary = await tick();
  assert.equal(summary.jobs_done, 1, JSON.stringify(summary));
  const stored = (await pool.query('SELECT conclusion FROM maintainer_checks')).rows;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].conclusion, 'success');
  assert.equal((await pool.query('SELECT queue_state FROM maintainer_pull_requests')).rows[0].queue_state, 'awaiting_review');
  const statusCall = calls.find(call => call.path.endsWith('/status'));
  assert.match(statusCall?.search ?? '', /per_page=100/);
});

test('fork follows head repository identity, not the fork flag', async () => {
  const repository = await insertRepo();
  await insertJob(repository, 8);
  await insertJob(repository, 9);
  await insertJob(repository, 10);
  installRoutes([], call => {
    if (call.path.endsWith('/files')) return Response.json([{ filename: 'docs/guide.md', status: 'modified', additions: 1, deletions: 0 }]);
    if (/\/pulls\/8$/.test(call.path)) return Response.json(pullBody({ id: 801, number: 8, additions: 1, deletions: 0, changed_files: 1, head: { sha: SHA, repo: { id: 9001, fork: true } } }));
    if (/\/pulls\/9$/.test(call.path)) return Response.json(pullBody({ id: 802, number: 9, additions: 1, deletions: 0, changed_files: 1, head: { sha: SHA, repo: null } }));
    if (/\/pulls\/10$/.test(call.path)) return Response.json(pullBody({ id: 803, number: 10, additions: 1, deletions: 0, changed_files: 1, head: { sha: SHA, repo: { id: 800, fork: false } } }));
    return null;
  });
  const summary = await tick();
  assert.equal(summary.jobs_done, 3, JSON.stringify(summary));
  const rows = (await pool.query('SELECT number, is_fork, risk_class, risk_reasons FROM maintainer_pull_requests ORDER BY number')).rows;
  assert.equal(rows[0].is_fork, false);
  assert.equal(rows[0].risk_class, 'low');
  assert.equal(rows[0].risk_reasons.some((reason: { code: string }) => reason.code === 'fork_head'), false);
  assert.equal(rows[1].is_fork, true);
  assert.equal(rows[1].risk_class, 'medium');
  assert.ok(rows[1].risk_reasons.some((reason: { code: string }) => reason.code === 'fork_head'));
  assert.equal(rows[2].is_fork, true);
  assert.equal(rows[2].risk_class, 'medium');
  assert.ok(rows[2].risk_reasons.some((reason: { code: string }) => reason.code === 'fork_head'));
});

test('a sweep refreshes stale open pulls and caps those refreshes', async () => {
  const repository = await insertRepo(randomUUID(), '9001', '77', 'FreeTWAI-AI/freedom-platform', clock.toISOString());
  await insertPull(repository, 1, SHA, '2026-09-01T00:00:00.000Z', 'ci', { synced: new Date(clock.getTime() - 11 * 60_000).toISOString(), queue: 'waiting_ci' });
  await insertPull(repository, 2, SHA, '2026-09-01T00:00:00.000Z', 'fresh', { synced: new Date(clock.getTime() - 60 * 60_000).toISOString(), queue: 'awaiting_review' });
  await insertPull(repository, 3, SHA, '2026-09-01T00:00:00.000Z', 'old', { synced: new Date(clock.getTime() - 7 * 60 * 60_000).toISOString(), queue: 'awaiting_review' });
  installRoutes([
    { number: 1, updated_at: '2026-09-01T00:00:00.000Z', head: { sha: SHA } },
    { number: 2, updated_at: '2026-09-01T00:00:00.000Z', head: { sha: SHA } },
    { number: 3, updated_at: '2026-09-01T00:00:00.000Z', head: { sha: SHA } },
  ]);
  await tick();
  const numbers = (await pool.query(`SELECT (payload->>'number')::int AS number FROM maintainer_jobs ORDER BY 1`)).rows.map(row => row.number);
  assert.deepEqual(numbers, [1, 3]);

  await pool.query('TRUNCATE maintainer_jobs, maintainer_pull_requests CASCADE');
  await pool.query(`UPDATE maintainer_repositories SET next_sweep_at=$2, rate_limited_until=NULL WHERE repository_id=$1`, [repository, clock]);
  const listed = [];
  for (let number = 1; number <= 21; number += 1) {
    const synced = new Date(clock.getTime() - 7 * 60 * 60_000 - (22 - number) * 60_000).toISOString();
    await insertPull(repository, number, SHA, '2026-09-01T00:00:00.000Z', `stale ${number}`, { synced, queue: 'awaiting_review' });
    listed.push({ number, updated_at: '2026-09-01T00:00:00.000Z', head: { sha: SHA } });
  }
  installRoutes(listed);
  await tick();
  const capped = (await pool.query(`SELECT (payload->>'number')::int AS number FROM maintainer_jobs ORDER BY 1`)).rows.map(row => row.number);
  assert.deepEqual(capped, Array.from({ length: 20 }, (_, index) => index + 1));
});

test('enqueue pulls a backed-off job forward and a second call does not', async () => {
  const repository = await insertRepo();
  const later = new Date(clock.getTime() + 15 * 60_000);
  await insertJob(repository, 8, 'queued', 2, later);
  assert.equal(await enqueueReconcilePull(pool, repository, 8, clock), true);
  let job = (await pool.query('SELECT attempts, run_after FROM maintainer_jobs')).rows[0];
  assert.equal(job.attempts, 2);
  assert.equal(new Date(job.run_after).toISOString(), clock.toISOString());
  assert.equal(await enqueueReconcilePull(pool, repository, 8, clock), false);
  job = (await pool.query('SELECT attempts, run_after FROM maintainer_jobs')).rows[0];
  assert.equal(job.attempts, 2);
  assert.equal(new Date(job.run_after).toISOString(), clock.toISOString());
});
