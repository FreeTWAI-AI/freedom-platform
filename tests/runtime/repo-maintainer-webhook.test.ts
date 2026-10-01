import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { createApp } from '../../apps/platform-api/src/app.js';

const origin = 'http://127.0.0.1:4310';
const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_mhook_${process.pid}_${Date.now()}`;
const database = createPool(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 });
const SECRET = 'maintainer-webhook-secret-0123456789';
const community = '10000000-0000-4000-8000-0000000000a1';
const repositoryId = '20000000-0000-4000-8000-0000000000a1';
const SHA = 'ab'.repeat(20);
const PATH = '/api/v1/maintainer/github/webhook';
const realFetch = globalThis.fetch;
let app = createApp(pool, origin, 'local', { maintainerWebhookSecret: SECRET });

before(async () => {
  globalThis.fetch = async () => { throw new Error('real fetch blocked'); };
  await database.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  await pool.query('INSERT INTO communities (community_id, name) VALUES ($1,$2)', [community, 'Webhook fixture']);
});
after(async () => {
  globalThis.fetch = realFetch;
  await pool.end();
  await database.query(`DROP SCHEMA ${schema} CASCADE`);
  await database.end();
});
beforeEach(async () => {
  await pool.query('TRUNCATE maintainer_webhook_deliveries, maintainer_jobs, maintainer_pull_requests, maintainer_repositories CASCADE');
  await pool.query(`INSERT INTO maintainer_repositories
    (repository_id, community_id, github_repository_id, installation_id, full_name, default_branch, installation_state, mode, next_sweep_at)
    VALUES ($1,$2,'9001','77','FreeTWAI-AI/freedom-platform','main','active','observe','2099-01-01T00:00:00Z')`, [repositoryId, community]);
  await pool.query(`UPDATE maintainer_worker_state SET next_installation_sync_at='2099-01-01T00:00:00Z', last_error=NULL WHERE singleton`);
  app = createApp(pool, origin, 'local', { maintainerWebhookSecret: SECRET });
});

function signature(body: string, secret = SECRET) {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}
function headers(body: string, over: Record<string, string> = {}) {
  return {
    'Content-Type': 'application/json',
    'X-GitHub-Event': 'pull_request',
    'X-GitHub-Delivery': randomUUID(),
    'X-Hub-Signature-256': signature(body),
    ...over,
  };
}
async function read(response: Response) {
  const text = await response.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: response.status, data };
}
async function post(path: string, body: string, headerOver: Record<string, string> = {}) {
  return read(await app.request(origin + path, { method: 'POST', headers: headers(body, headerOver), body }));
}
function payload(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    action: 'opened',
    installation: { id: 77 },
    repository: { id: 9001 },
    pull_request: { number: 12, head: { sha: SHA } },
    ...over,
  });
}

test('a signed delivery is stored and a duplicate does nothing else', async () => {
  const body = payload();
  const delivery = randomUUID();
  const first = await post(PATH, body, { 'X-GitHub-Delivery': delivery });
  assert.equal(first.status, 202, JSON.stringify(first.data));
  assert.deepEqual(first.data, { accepted: true, outcome: 'queued' });
  const row = (await pool.query('SELECT github_event, outcome, target_number, installation_id FROM maintainer_webhook_deliveries')).rows[0];
  assert.equal(row.github_event, 'pull_request');
  assert.equal(row.outcome, 'queued');
  assert.equal(row.target_number, 12);
  assert.equal(row.installation_id, '77');
  assert.equal((await pool.query('SELECT count(*) FROM maintainer_jobs')).rows[0].count, '1');
  const second = await post(PATH, body, { 'X-GitHub-Delivery': delivery });
  assert.equal(second.status, 202);
  assert.deepEqual(second.data, { duplicate: true });
  assert.equal((await pool.query('SELECT count(*) FROM maintainer_jobs')).rows[0].count, '1');
  assert.equal((await pool.query('SELECT count(*) FROM maintainer_webhook_deliveries')).rows[0].count, '1');
});

test('rejected and malformed deliveries never touch the database', async () => {
  const body = payload();
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    const wrong = await post(PATH, body, { 'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64) });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.data.code, 'webhook_signature_invalid');
    assert.deepEqual(logged, ['maintainer_webhook_rejected signature']);
  } finally { console.error = original; }
  const missing = await post(PATH, body, { 'X-GitHub-Delivery': '' });
  assert.equal(missing.status, 400);
  assert.equal(missing.data.code, 'webhook_malformed');
  const uppercase = await post(PATH, body, { 'X-GitHub-Event': 'Pull_request' });
  assert.equal(uppercase.status, 400, JSON.stringify(uppercase.data));
  const badHex = await post(PATH, body, { 'X-Hub-Signature-256': 'sha256=' + 'Z'.repeat(64) });
  assert.equal(badHex.status, 400);
  const typed = await post(PATH, body, { 'Content-Type': 'text/plain' });
  assert.equal(typed.status, 415);
  assert.equal(typed.data.code, 'json_required');
  const broken = await post(PATH, '{', { 'X-Hub-Signature-256': signature('{') });
  assert.equal(broken.status, 400);
  assert.equal(broken.data.code, 'invalid_json');
  assert.equal((await pool.query('SELECT count(*) FROM maintainer_webhook_deliveries')).rows[0].count, '0');
  assert.equal((await pool.query('SELECT count(*) FROM maintainer_jobs')).rows[0].count, '0');
});

test('oversized bodies are refused with and without Content-Length', async () => {
  const small = '{}';
  const declared = new Request(origin + PATH, {
    method: 'POST',
    headers: headers(small, { 'Content-Length': String(2 * 1024 * 1024 + 1), 'X-GitHub-Event': 'ping' }),
    body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(small)); controller.close(); } }),
    duplex: 'half',
  } as RequestInit);
  const withLength = await read(await app.request(declared));
  assert.equal(withLength.status, 413, JSON.stringify(withLength.data));
  assert.equal(withLength.data.code, 'body_too_large');
  const chunk = new Uint8Array(1024 * 1024);
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(chunk); controller.enqueue(chunk); controller.enqueue(new Uint8Array(1)); controller.close();
  } });
  const raw = '{}';
  const fat = new Request(origin + PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'ping', 'X-GitHub-Delivery': randomUUID(), 'X-Hub-Signature-256': signature(raw) },
    body: stream,
    duplex: 'half',
  } as RequestInit);
  const withoutLength = await read(await app.request(fat));
  assert.equal(withoutLength.status, 413, JSON.stringify(withoutLength.data));
  assert.equal((await pool.query('SELECT count(*) FROM maintainer_webhook_deliveries')).rows[0].count, '0');
});

test('unknown, inactive and off repositories are ignored; checks and installations are queued', async () => {
  const unknown = await post(PATH, payload({ repository: { id: 999 } }));
  assert.deepEqual(unknown.data, { accepted: true, outcome: 'ignored' });
  await pool.query(`UPDATE maintainer_repositories SET mode='off' WHERE repository_id=$1`, [repositoryId]);
  const off = await post(PATH, payload());
  assert.equal(off.data.outcome, 'ignored');
  await pool.query(`UPDATE maintainer_repositories SET mode='observe', installation_state='removed' WHERE repository_id=$1`, [repositoryId]);
  const removed = await post(PATH, payload());
  assert.equal(removed.data.outcome, 'ignored');
  await pool.query(`UPDATE maintainer_repositories SET installation_state='active', installation_id='88' WHERE repository_id=$1`, [repositoryId]);
  const mismatch = await post(PATH, payload());
  assert.equal(mismatch.data.outcome, 'ignored');
  assert.equal((await pool.query('SELECT count(*) FROM maintainer_jobs')).rows[0].count, '0');
  await pool.query(`UPDATE maintainer_repositories SET installation_id='77' WHERE repository_id=$1`, [repositoryId]);
  const ping = await post(PATH, JSON.stringify({ zen: 'ok' }), { 'X-GitHub-Event': 'ping', 'X-Hub-Signature-256': signature(JSON.stringify({ zen: 'ok' })) });
  assert.equal(ping.data.outcome, 'ignored');
  const parked = (await pool.query('SELECT next_installation_sync_at FROM maintainer_worker_state')).rows[0].next_installation_sync_at as Date;
  assert.ok(parked.getUTCFullYear() >= 2099);
  const installation = JSON.stringify({ action: 'created', installation: { id: 77 } });
  const scheduled = await post(PATH, installation, { 'X-GitHub-Event': 'installation', 'X-Hub-Signature-256': signature(installation) });
  assert.equal(scheduled.data.outcome, 'queued');
  const next = (await pool.query('SELECT next_installation_sync_at FROM maintainer_worker_state')).rows[0].next_installation_sync_at as Date;
  assert.ok(next.getTime() <= Date.now() + 5_000);
  await pool.query(`INSERT INTO maintainer_pull_requests (
    pull_id, repository_id, number, github_pull_id, title, html_url, state, is_draft, author_github_id, author_login, author_type,
    author_association, is_fork, head_sha, base_ref, base_sha, labels, additions, deletions, changed_files, github_created_at,
    github_updated_at, head_observed_at, risk_class, risk_reasons, queue_state, queue_reasons, policy_version, synced_at)
    VALUES ($1,$2,7,'700','Stored','https://github.com/FreeTWAI-AI/freedom-platform/pull/7','open',false,'42','octocat','User',
    'CONTRIBUTOR',false,$3,'main',$4,'{}',1,0,1,now(),now(),now(),'low','[]','awaiting_review','[]','2026-09-30.1',now())`,
  [randomUUID(), repositoryId, SHA, 'c'.repeat(40)]);
  const suite = JSON.stringify({
    installation: { id: 77 }, repository: { id: 9001 },
    check_suite: { head_sha: SHA, pull_requests: [{ number: 3, base: { repo: { id: 9001 } } }, { number: 4, base: { repo: { id: 1 } } }] },
  });
  const checks = await post(PATH, suite, { 'X-GitHub-Event': 'check_suite', 'X-Hub-Signature-256': signature(suite) });
  assert.equal(checks.data.outcome, 'queued');
  const numbers = (await pool.query('SELECT payload->>\'number\' AS number FROM maintainer_jobs ORDER BY 1')).rows.map(row => Number(row.number));
  assert.deepEqual(numbers, [3, 7]);
});

test('the webhook exemption is the exact POST path and a missing secret is 503', async () => {
  const padded = JSON.stringify({ zen: 'ok', pad: 'a'.repeat(40_000) });
  const wide = await post(PATH, padded, { 'X-GitHub-Event': 'ping', 'X-Hub-Signature-256': signature(padded) });
  assert.equal(wide.status, 202, JSON.stringify(wide.data));
  const evil = await post(PATH, payload(), { Origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  assert.equal(evil.data.code, 'origin_rejected');
  const slash = await app.request(origin + PATH + '/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(slash.status, 403);
  assert.equal((await slash.json() as any).code, 'origin_rejected');
  const longer = await app.request(origin + PATH + '/extra', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(longer.status, 403);
  const get = await app.request(origin + PATH, { method: 'GET' });
  assert.equal(get.status, 404);
  const previous = process.env.GITHUB_MAINTAINER_WEBHOOK_SECRET;
  process.env.GITHUB_MAINTAINER_WEBHOOK_SECRET = SECRET;
  try {
    const closed = createApp(pool, origin, 'local', { maintainerWebhookSecret: undefined });
    const response = await closed.request(origin + PATH, { method: 'POST', headers: headers('{}', { 'X-GitHub-Event': 'ping' }), body: '{}' });
    assert.equal(response.status, 503);
    assert.equal((await response.json() as any).code, 'maintainer_webhook_unavailable');
  } finally {
    if (previous === undefined) delete process.env.GITHUB_MAINTAINER_WEBHOOK_SECRET;
    else process.env.GITHUB_MAINTAINER_WEBHOOK_SECRET = previous;
  }
  assert.equal((await pool.query('SELECT count(*) FROM maintainer_webhook_deliveries WHERE github_event=\'ping\'')).rows[0].count, '1');
});
