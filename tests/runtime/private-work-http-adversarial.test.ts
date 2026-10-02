import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import { createPool } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import { tokenHash, type Actor } from '../../modules/identity-membership/service.js';
import { createPrivateWorkCommands } from '../../modules/opportunity-project-work/private-commands.js';
import { createPrivateResultService } from '../../modules/autopilot-work/results.js';
import { resolvePrivateWorkPersistencePolicy as resolvePolicy } from '../../modules/autopilot-work/policy.js';
import { FakeObjectStore } from '../../packages/asset-storage/fake-store.js';
import { sha256, type AssetObjectKey } from '../../packages/asset-storage/index.js';
import { createPrivateWorkTransport } from '../../apps/platform-api/src/routes/private-work-transport.js';
import { createApp } from '../../apps/platform-api/src/app.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw Error('Independent private HTTP tests require explicit isolated TEST_DATABASE_URL');
const schema = `fp_private_http_adversarial_${process.pid}_${Date.now()}`;
const admin = createPool(connectionString);
const pool = new Pool({ connectionString, options: `-c search_path=${schema} -c statement_timeout=10000`, max: 12 });
const origin = 'http://127.0.0.1:4310', community = randomUUID();
const commands = createPrivateWorkCommands(pool, { resolvePolicy });
let created = false;
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); created = true; await migrate(pool); });
after(async () => { await pool.end(); if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(async () => { await pool.query('TRUNCATE communities CASCADE'); await pool.query("INSERT INTO communities VALUES($1,'Synthetic HTTP review')", [community]); });
type Member = Actor & { cookie: string; scope: string; principal: string };
function latch() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
class Store extends FakeObjectStore {
  gets = 0; onGet?: () => Promise<void>;
  override async get(key: AssetObjectKey) { this.gets++; await this.onGet?.(); return super.get(key); }
}
async function member(allowed = true): Promise<Member> {
  const id = randomUUID(), token = randomBytes(32).toString('base64url'), hash = tokenHash(token);
  const row = (await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic','not-a-login',$4) RETURNING *`, [id, community, id + '@example.invalid', randomUUID()])).rows[0];
  await pool.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1hour')", [hash, id]);
  const actor: Actor = { ...row, session_hash: hash, csrf_token: 'synthetic' };
  const context = await withMemberScope(pool, { actor, scope: 'personal' }, async () => {}, async (_q, value) => value);
  const scope = context.scope.scope_id, principal = context.subject_principal.principal_id;
  await pool.query(`INSERT INTO private_work_persistence_policy(scope_id,purpose,owner_principal_id,revision,persistence_allowed,retained_byte_limit)
    VALUES($1,'work.private-draft',$2,1,$3,10485760)`, [scope, principal, allowed]);
  return { ...actor, cookie: 'freedom_local_session=' + token, scope, principal };
}
const body = { title: 'PRIVATE_HTTP_TITLE', objective: 'PRIVATE_HTTP_OBJECTIVE' };
const path = '/me/private-work';
type App = ReturnType<typeof createPrivateWorkTransport>;
async function request(app: App, route: string, actor?: Member, options: {
  method?: string; body?: unknown; raw?: string | Uint8Array; headers?: Record<string, string | undefined>;
} = {}) {
  const method = options.method ?? (options.body !== undefined || options.raw !== undefined ? 'POST' : 'GET');
  const headers = new Headers({ Origin: origin, ...(actor ? { Cookie: actor.cookie, 'X-CSRF-Token': actor.csrf_token } : {}),
    ...(!['GET', 'HEAD'].includes(method) ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}) });
  for (const [key, value] of Object.entries(options.headers ?? {})) value === undefined ? headers.delete(key) : headers.set(key, value);
  const response = await app.request(origin + route, { method, headers,
    body: (options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body))) as BodyInit | undefined });
  const text = await response.text();
  assert.match(response.headers.get('Cache-Control') ?? '', /no-store/, `${method} ${route}: ${response.status}`);
  return { response, status: response.status, text, data: text && response.headers.get('Content-Type')?.includes('application/json') ? JSON.parse(text) : null };
}
async function fixture(withResult = false) {
  const actor = await member(), store = new Store(), app = createPrivateWorkTransport(pool, { origin, freedomEnv: 'local', store });
  const work = await commands.create(actor, { key: randomUUID(), ...body });
  const service = createPrivateResultService(pool, { store, resolvePolicy });
  let resultId = '';
  if (withResult) {
    const bytes = new TextEncoder().encode('PRIVATE_HTTP_RESULT <script>not executed</script>');
    const prepared = await service.prepare(actor, { key: randomUUID(), targetWorkId: work.workId, expectedVersion: '1', contentType: 'text/markdown', byteSize: bytes.length, sha256: await sha256(bytes) });
    const lease = await service.claim(actor, { key: randomUUID(), intentId: prepared.intentId });
    const token = { intentId: lease.intentId, fence: lease.fence, leaseToken: lease.leaseToken };
    await service.write(actor, { ...token, key: randomUUID() }, new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }));
    resultId = (await service.finalize(actor, { ...token, key: randomUUID() })).resultId;
  }
  return { actor, store, app, work, service, resultId };
}
async function blockedBy(q: PoolClient) {
  const pid = (await q.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  for (let i = 0; i < 250; i++) {
    if ((await admin.query('SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid])).rows[0].n) return;
    await delay(10);
  }
  assert.fail('Actual PostgreSQL wait barrier was not observed');
}
async function expired(actor: Actor) {
  for (let i = 0; i < 250; i++) {
    if ((await pool.query('SELECT expires_at<=clock_timestamp() expired FROM sessions WHERE token_hash=$1', [actor.session_hash])).rows[0].expired) return;
    await delay(10);
  }
  assert.fail('Synthetic session did not expire within bounded wait');
}

test('HTTP independent create/edit/archive preserve CAS and metadata-only receipts', async () => {
  const actor = await member(), app = createPrivateWorkTransport(pool, { origin, freedomEnv: 'local' });
  const create = await request(app, path, actor, { body }); assert.equal(create.status, 201);
  assert.equal(create.data.aggregateVersion, '1');
  const target = path + '/' + create.data.workId;
  const edit = await request(app, target + '/edit', actor, { body, headers: { 'If-Match': '"1"' } });
  assert.equal(edit.status, 200); assert.equal(edit.data.aggregateVersion, '2');
  assert.equal((await request(app, target + '/edit', actor, { body, headers: { 'If-Match': '"1"' } })).status, 412);
  const archived = await request(app, target + '/archive', actor, { body: {}, headers: { 'If-Match': '"2"' } });
  assert.equal(archived.status, 200); assert.equal(archived.data.state, 'archived');
  assert.equal((await request(app, target, actor)).status, 404);
  for (const table of ['scoped_command_receipts', 'scoped_transition_journal', 'scoped_outbox'])
    assert(!JSON.stringify((await pool.query(`SELECT * FROM ${table}`)).rows).includes('PRIVATE_HTTP_'));
});

test('HTTP independent factory stays unmounted in the existing application', async () => {
  const f = await fixture(true), legacy = createApp(pool, origin);
  assert.equal((await request(legacy, '/api/v1' + path, f.actor, { body })).status, 404);
  assert.equal((await request(legacy, '/api/v1' + path + '/' + f.work.workId + '/edit', f.actor, { body, headers: { 'If-Match': '"2"' } })).status, 404);
  assert.equal((await request(legacy, '/api/v1' + path + '/' + f.work.workId + '/results/current', f.actor)).status, 404);
  assert.equal((await request(legacy, '/api/v1' + path + '/' + f.work.workId, f.actor)).status, 200);
});

test('HTTP independent cookie/CSRF/Origin and onboarding cannot be replaced by bearer labels', async () => {
  const f = await fixture();
  for (const headers of [{ Origin: undefined }, { Origin: 'https://attacker.invalid' }, { 'X-CSRF-Token': undefined }, { 'X-CSRF-Token': 'wrong' }])
    assert.equal((await request(f.app, path, f.actor, { body, headers })).status, 403);
  assert.equal((await request(f.app, path, undefined, { body, headers: { Authorization: 'Bearer fake-site-key' } })).status, 401);
  assert.equal((await request(f.app, path, undefined, { method: 'HEAD' })).status, 401);
  await pool.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1', [f.actor.user_id]);
  assert.equal((await request(f.app, path, f.actor, { body })).status, 403);
  assert.equal((await pool.query('SELECT count(*)::int n FROM work_items')).rows[0].n, 1);
});

test('HTTP independent caller owner/scope/policy/AI fields and duplicate JSON keys are rejected', async () => {
  const f = await fixture();
  for (const extra of ['owner_ref', 'scope_id', 'policy', 'store', 'provenance', 'run_id', 'expectedVersion', 'key'])
    assert.equal((await request(f.app, path, f.actor, { body: { ...body, [extra]: 'CALLER_CANNOT_AUTHORIZE' } })).status, 422);
  for (const raw of ['{"title":"first","title":"second","objective":"x"}', '{"title":"x","objective":"first","object\\u0069ve":"second"}'])
    assert.equal((await request(f.app, path, f.actor, { raw })).status, 400);
  assert.equal((await pool.query('SELECT count(*)::int n FROM work_items')).rows[0].n, 1);
});

test('HTTP independent actual UTF-8 bytes are bounded independently of advertised length', async () => {
  const f = await fixture();
  const huge = JSON.stringify({ title: 'a', objective: '界'.repeat(12000) });
  assert.equal((await request(f.app, path, f.actor, { raw: huge, headers: { 'Content-Length': '1' } })).status, 413);
  const invalid = new Uint8Array([123, 34, 116, 105, 116, 108, 101, 34, 58, 34, 0xff, 34, 125]);
  assert.equal((await request(f.app, path, f.actor, { raw: invalid })).status, 400);
  assert.equal((await pool.query('SELECT count(*)::int n FROM work_items')).rows[0].n, 1);
});

test('HTTP independent weak/list/unsafe versions and invalid idempotency keys cannot mutate', async () => {
  const f = await fixture(), target = path + '/' + f.work.workId;
  for (const value of [undefined, '1', 'W/"1"', '"0"', '"01"', '"1", "2"', '"9223372036854775808"'])
    assert.equal((await request(f.app, target + '/edit', f.actor, { body, headers: { 'If-Match': value } })).status, value === undefined ? 428 : 400);
  for (const value of [undefined, 'short', 'key,duplicate', 'x'.repeat(129)])
    assert.equal((await request(f.app, path, f.actor, { body, headers: { 'Idempotency-Key': value } })).status, 400);
  assert.equal((await request(f.app, path, f.actor, { body, headers: { 'If-Match': '"1"' } })).status, 400);
  assert.equal((await pool.query('SELECT aggregate_version FROM work_items WHERE work_item_id=$1', [f.work.workId])).rows[0].aggregate_version, '1');
});

test('HTTP independent strict query and canonical identifiers reject caller scope or duplicate paging', async () => {
  const f = await fixture(true);
  for (const route of [path + '?owner_ref=' + f.actor.user_id, path + '?limit=1&limit=2', path + '/' + f.work.workId + '?scope=personal',
    path + '/' + f.work.workId + '/results?limit=1&limit=2', path + '/' + f.work.workId + '/results/current?policy=allow',
    path + '/' + f.work.workId.toUpperCase() + '/results/current'])
    assert.equal((await request(f.app, route, f.actor)).status, 422, route);
});

test('HTTP independent peer HEAD/Range/conditional result reads match missing and never touch store', async () => {
  const f = await fixture(true), peer = await member(); f.store.gets = 0;
  for (const suffix of ['', '/results', '/results/current', '/results/' + f.resultId]) for (const method of ['GET', 'HEAD']) {
    const headers = { Range: 'bytes=0-1', 'If-None-Match': '*', 'If-Modified-Since': 'Wed, 01 Jan 2099 00:00:00 GMT' };
    const denied = await request(f.app, path + '/' + f.work.workId + suffix, peer, { method, headers });
    const missing = await request(f.app, path + '/' + randomUUID() + suffix, peer, { method, headers });
    assert.equal(denied.status, 404); assert.equal(denied.status, missing.status); assert.equal(denied.text, missing.text);
  }
  assert.equal(f.store.gets, 0);
});

test('HTTP independent owner Result remains JSON text, no-store, no 206/304 or raw storage keys', async () => {
  const f = await fixture(true);
  for (const suffix of ['/results/current', '/results/' + f.resultId]) {
    const got = await request(f.app, path + '/' + f.work.workId + suffix, f.actor, { headers: { Range: 'bytes=0-1', 'If-None-Match': '*' } });
    assert.equal(got.status, 200); assert.match(got.response.headers.get('Content-Type') ?? '', /application\/json/);
    assert.match(got.data.text, /PRIVATE_HTTP_RESULT/); assert(!/object_key|leaseToken|presigned|bucket/.test(got.text));
    const head = await request(f.app, path + '/' + f.work.workId + suffix, f.actor, { method: 'HEAD', headers: { 'If-None-Match': '*' } });
    assert.equal(head.status, 200); assert.equal(head.text, '');
  }
});

test('HTTP independent missing storage preserves owner/domain checks and metadata availability', async () => {
  const f = await fixture(true), peer = await member(), app = createPrivateWorkTransport(pool, { origin, freedomEnv: 'local' });
  const target = path + '/' + f.work.workId;
  assert.equal((await request(app, target + '/results', f.actor)).status, 200);
  assert.equal((await request(app, target + '/results/current', f.actor)).status, 503);
  assert.equal((await request(app, target + '/results/' + f.resultId, f.actor)).status, 503);
  assert.equal((await request(app, target + '/results/' + randomUUID(), f.actor)).status, 404);
  assert.equal((await request(app, target + '/results/current', peer)).status, 404);
  assert.equal((await request(app, path + '/' + randomUUID() + '/results/current', f.actor)).status, 404);
  await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1', [f.actor.session_hash]);
  assert.equal((await request(app, target + '/results/current', f.actor)).status, 401);
});

test('HTTP independent peer mutations cannot claim known target or another member receipt', async () => {
  const f = await fixture(), peer = await member(), key = randomUUID(), target = path + '/' + f.work.workId;
  const own = await request(f.app, target + '/edit', f.actor, { body, headers: { 'If-Match': '"1"', 'Idempotency-Key': key } });
  assert.equal(own.status, 200);
  for (const suffix of ['/edit', '/archive']) {
    const options = { body: suffix === '/edit' ? body : {}, headers: { 'If-Match': '"2"', 'Idempotency-Key': key } };
    const denied = await request(f.app, target + suffix, peer, options);
    const missing = await request(f.app, path + '/' + randomUUID() + suffix, peer, options);
    assert.equal(denied.status, 404); assert.deepEqual(denied.data, missing.data);
  }
  assert.equal((await pool.query('SELECT aggregate_version FROM work_items WHERE work_item_id=$1', [f.work.workId])).rows[0].aggregate_version, '2');
});

test('HTTP independent current policy revokes successful create replay but cannot prevent archive', async () => {
  const actor = await member(), app = createPrivateWorkTransport(pool, { origin, freedomEnv: 'local' }), key = randomUUID();
  const first = await request(app, path, actor, { body, headers: { 'Idempotency-Key': key } }); assert.equal(first.status, 201);
  assert.deepEqual((await request(app, path, actor, { body, headers: { 'Idempotency-Key': key } })).data, first.data);
  await pool.query('UPDATE private_work_persistence_policy SET revision=revision+1,persistence_allowed=false WHERE scope_id=$1', [actor.scope]);
  assert.equal((await request(app, path, actor, { body, headers: { 'Idempotency-Key': key } })).status, 503);
  assert.equal((await request(app, path + '/' + first.data.workId + '/archive', actor, { body: {}, headers: { 'If-Match': '"1"' } })).status, 200);
});

for (const change of ['session', 'scope', 'archive', 'version', 'policy', 'expiry'] as const)
  test(`HTTP independent ${change} during unlocked object GET rejects private text`, async () => {
    const f = await fixture(true), started = latch(), release = latch();
    f.store.onGet = async () => { started.release(); await release.promise; };
    const reading = request(f.app, path + '/' + f.work.workId + '/results/current', f.actor, { headers: { Range: 'bytes=0-', 'If-None-Match': '*' } });
    try {
      await started.promise;
      if (change === 'session') await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1', [f.actor.session_hash]);
      if (change === 'scope') await pool.query("UPDATE resource_scopes SET status='disabled' WHERE scope_id=$1", [f.actor.scope]);
      if (change === 'archive') await commands.archive(f.actor, { key: randomUUID(), workId: f.work.workId, expectedVersion: '2' });
      if (change === 'version') await commands.update(f.actor, { key: randomUUID(), workId: f.work.workId, expectedVersion: '2', ...body });
      if (change === 'policy') await pool.query('UPDATE private_work_persistence_policy SET revision=revision+1,persistence_allowed=false WHERE scope_id=$1', [f.actor.scope]);
      if (change === 'expiry') await pool.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1second' WHERE token_hash=$1", [f.actor.session_hash]);
    } finally { release.release(); }
    const response = await reading;
    assert.equal(response.status, { session: 401, scope: 403, archive: 404, version: 412, policy: 503, expiry: 401 }[change]);
    assert(!response.text.includes('PRIVATE_HTTP_'));
  });

test('HTTP independent simultaneous same-key create has one row and competing version edits have one winner', async () => {
  const actor = await member(), app = createPrivateWorkTransport(pool, { origin, freedomEnv: 'local' }), key = randomUUID();
  const created = await Promise.all([1, 2].map(() => request(app, path, actor, { body, headers: { 'Idempotency-Key': key } })));
  assert.equal(created[0].status, 201); assert.deepEqual(created[0].data, created[1].data);
  assert.equal((await pool.query('SELECT count(*)::int n FROM work_items')).rows[0].n, 1);
  const target = path + '/' + created[0].data.workId;
  const edited = await Promise.all(['first', 'second'].map(title => request(app, target + '/edit', actor, { body: { ...body, title }, headers: { 'If-Match': '"1"' } })));
  assert.deepEqual(edited.map(r => r.status).sort(), [200, 412]);
  assert.equal((await pool.query('SELECT aggregate_version FROM work_items')).rows[0].aggregate_version, '2');
  assert.equal((await pool.query('SELECT count(*)::int n FROM scoped_command_receipts')).rows[0].n, 2);
});

test('HTTP independent revoked owner HEAD must not become a cached success on any private read route', async () => {
  const f = await fixture(true); f.store.gets = 0;
  await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1', [f.actor.session_hash]);
  for (const suffix of ['', '/' + f.work.workId, '/' + f.work.workId + '/results', '/' + f.work.workId + '/results/current', '/' + f.work.workId + '/results/' + f.resultId]) {
    const response = await request(f.app, path + suffix, f.actor, { method: 'HEAD', headers: { Range: 'bytes=0-', 'If-None-Match': '*' } });
    assert.equal(response.status, 401); assert.equal(response.text, '');
  }
  assert.equal(f.store.gets, 0);
});

test('HTTP independent new private write does not alter legacy community projections or fact tables', async () => {
  const actor = await member(), peer = await member(), legacy = createApp(pool, origin);
  const app = createPrivateWorkTransport(pool, { origin, freedomEnv: 'local' });
  const paths = ['/work-items', '/dashboard', '/task-board/preview', '/me/contribution-records', '/community/accepted-work'];
  const before = await Promise.all(paths.map(p => request(legacy, '/api/v1' + p, peer)));
  assert(before.every(r => r.status === 200));
  const saved = await request(app, path, actor, { body }); assert.equal(saved.status, 201);
  for (const [index, p] of paths.entries()) {
    const after = await request(legacy, '/api/v1' + p, peer, { headers: { Range: 'bytes=0-1', 'If-None-Match': '*' } });
    assert.equal(after.status, 200); assert.deepEqual(after.data, before[index].data); assert(!after.text.includes('PRIVATE_HTTP_'));
  }
  for (const table of ['work_claims', 'contributions', 'work_benefit_observations'])
    assert.equal((await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0);
});

test('HTTP independent edit rejects session expiry after an actual Work row wait', async () => {
  const f = await fixture(), q = await pool.connect();
  await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '1second' WHERE token_hash=$1", [f.actor.session_hash]);
  try {
    await q.query('BEGIN'); await q.query('SELECT work_item_id FROM work_items WHERE work_item_id=$1 FOR UPDATE', [f.work.workId]);
    const writing = request(f.app, path + '/' + f.work.workId + '/edit', f.actor, { body, headers: { 'If-Match': '"1"' } });
    await blockedBy(q); await expired(f.actor); await q.query('COMMIT');
    assert.equal((await writing).status, 401);
    assert.equal((await pool.query('SELECT aggregate_version FROM work_items')).rows[0].aggregate_version, '1');
  } finally { await q.query('ROLLBACK'); q.release(); }
});

for (const method of ['create', 'read', 'head'] as const)
  test(`HTTP independent ${method} rechecks session clock after real policy row-lock wait`, async () => {
    const f = await fixture(method !== 'create'), q = await pool.connect();
    await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '1second' WHERE token_hash=$1", [f.actor.session_hash]);
    try {
      await q.query('BEGIN'); await q.query('UPDATE private_work_persistence_policy SET revision=revision+1 WHERE scope_id=$1', [f.actor.scope]);
      const running = method === 'create' ? request(f.app, path, f.actor, { body })
        : request(f.app, path + '/' + f.work.workId + '/results/current', f.actor, { method: method === 'head' ? 'HEAD' : 'GET' });
      await blockedBy(q); await expired(f.actor); await q.query('COMMIT');
      const response = await running; assert.equal(response.status, 401); assert(!response.text.includes('PRIVATE_HTTP_'));
      assert.equal((await pool.query('SELECT count(*)::int n FROM work_items')).rows[0].n, 1);
    } finally { await q.query('ROLLBACK'); q.release(); }
  });
