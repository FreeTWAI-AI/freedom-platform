import assert from 'node:assert/strict';
import { test, before, after, beforeEach } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createPool } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { tokenHash, type Actor } from '../../modules/identity-membership/service.js';
import { createPrivateWorkCommands } from '../../modules/opportunity-project-work/private-commands.js';
import { listPrivateWork, readPrivateWork } from '../../modules/opportunity-project-work/private-work.js';
import { createApp } from '../../apps/platform-api/src/app.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('Private Work command tests require explicit isolated TEST_DATABASE_URL.');
const schema = `fp_private_commands_${process.pid}_${Date.now()}`;
const admin = createPool(connectionString), pool = new Pool({ connectionString, options: `-c search_path=${schema} -c statement_timeout=10000`, max: 12 });
const community = randomUUID(), otherCommunity = randomUUID(), origin = 'http://127.0.0.1:4310';
const app = createApp(pool, origin);
let created = false;
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); created = true; await migrate(pool); });
after(async () => { await pool.end(); if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(async () => {
  await pool.query('TRUNCATE communities CASCADE');
  await pool.query("INSERT INTO communities VALUES($1,'Synthetic owner community'),($2,'Synthetic other community')", [community, otherCommunity]);
});
type Member = Actor & { cookie: string };
async function member(communityId = community): Promise<Member> {
  const id = randomUUID(), token = randomBytes(32).toString('base64url'), session = tokenHash(token);
  const user = (await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic work owner','not-a-login-hash',$4) RETURNING *`, [id, communityId, id + '@example.invalid', randomUUID()])).rows[0];
  await pool.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')", [session, id]);
  return { ...user, session_hash: session, csrf_token: 'synthetic', cookie: 'freedom_local_session=' + token };
}
function service() {
  const policy = { revision: 'private-work-test-policy', platformPersistenceAllowed: true };
  return { policy, api: createPrivateWorkCommands(pool, { resolvePolicy: async () => ({ ...policy }) }) };
}
const input = () => ({ key: randomUUID(), title: 'Private sentinel title', objective: 'Private sentinel objective\nHuman purpose, not an AI Result.' });
const status = (expected: number) => (error: unknown) => (error as { status?: number })?.status === expected;
const sqlCode = (expected: string) => (error: unknown) => (error as { code?: string })?.code === expected;
async function request(path: string, actor: Member, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  const response = await app.request(origin + '/api/v1' + path, { method, headers: {
    Cookie: actor.cookie, Origin: origin, 'X-CSRF-Token': actor.csrf_token,
    ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }), ...headers,
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { response, text, data: text && response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null };
}
async function facts() {
  return (await pool.query(`SELECT
    (SELECT count(*)::int FROM scoped_command_receipts) receipts,
    (SELECT count(*)::int FROM scoped_transition_journal) journal,
    (SELECT count(*)::int FROM scoped_outbox) outbox`)).rows[0];
}
async function blockedBy(pid: number, count = 1) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if ((await admin.query('SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid])).rows[0].n >= count) return;
    await delay(10);
  }
  assert.fail('Expected a demonstrated PostgreSQL lock wait.');
}
async function simultaneous<T>(owner: Actor, run: () => Promise<T>) {
  const lock = await pool.connect(); let pending: Promise<T[]> | undefined;
  try {
    await lock.query('BEGIN'); await lock.query('SELECT 1 FROM users WHERE user_id=$1 FOR UPDATE', [owner.user_id]);
    const pid = (await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    pending = Promise.all([run(), run()]); void pending.catch(() => {});
    await blockedBy(pid, 2); await lock.query('COMMIT'); return await pending;
  } finally { await lock.query('ROLLBACK'); lock.release(); await pending?.catch(() => {}); }
}

test('WORK-B-01 real human create/update/archive use one aggregate and metadata-only receipts', async () => {
  const owner = await member(), { api } = service(), body = input();
  const first = await api.create(owner, body);
  assert.deepEqual(Object.keys(first).sort(), ['aggregateVersion', 'state', 'workId']);
  assert.equal(first.aggregateVersion, '1');
  assert.equal((await readPrivateWork(pool, owner, first.workId)).objective, body.objective);
  const update = { ...input(), workId: first.workId, expectedVersion: '1', objective: 'Human revised objective' };
  assert.equal((await api.update(owner, update)).aggregateVersion, '2');
  assert.equal((await readPrivateWork(pool, owner, first.workId)).objective, update.objective);
  const archive = { key: randomUUID(), workId: first.workId, expectedVersion: '2' };
  const archived = await api.archive(owner, archive);
  assert.deepEqual(archived, { workId: first.workId, state: 'archived', aggregateVersion: '3' });
  assert.deepEqual(await api.archive(owner, archive), archived);
  assert.equal((await listPrivateWork(pool, owner, {})).total, 0);
  await assert.rejects(readPrivateWork(pool, owner, first.workId), status(404));
  await assert.rejects(api.update(owner, { ...update, key: randomUUID(), expectedVersion: '3' }), status(409));
  await assert.rejects(api.update(owner, update), status(409));
  assert.deepEqual(await api.create(owner, body), first); // Historical metadata, never historical text.
  assert.deepEqual(await facts(), { receipts: 3, journal: 3, outbox: 3 });
});

test('WORK-B-23 private commands consume central canonical Work identities before policy or SQL work', async () => {
  const owner = await member(), { api } = service(), first = await api.create(owner, input());
  let policyCalls = 0;
  const guarded = createPrivateWorkCommands(pool, { resolvePolicy: async () => {
    policyCalls++; return { revision: 'synthetic-v1', platformPersistenceAllowed: true };
  } });
  const initialFacts = await facts();
  for (const workId of ['ABCDEFAB-1234-4234-8234-ABCDEFABCDEF', '00000000-0000-0000-0000-000000000000',
    'abcdefab-1234-9234-8234-abcdefabcdef', first.workId + '\n']) {
    const change = { ...input(), workId, expectedVersion: '1' };
    await assert.rejects(guarded.update(owner, change), error => (error as Error).name === 'ZodError');
    await assert.rejects(guarded.archive(owner, { key: randomUUID(), workId, expectedVersion: '1' }), error => (error as Error).name === 'ZodError');
  }
  assert.equal(policyCalls, 0);
  assert.deepEqual(await facts(), initialFacts);
  assert.equal((await pool.query('SELECT aggregate_version FROM work_items WHERE work_item_id=$1', [first.workId])).rows[0].aggregate_version, '1');
});

test('WORK-B-02 simultaneous create replay has stable server ID and changed input conflicts', async () => {
  const owner = await member(), { api } = service(), body = input();
  const [a, b] = await simultaneous(owner, () => api.create(owner, body));
  assert.deepEqual(a, b);
  await assert.rejects(api.create(owner, { ...body, objective: 'Different plaintext' }), status(409));
  assert.equal((await pool.query('SELECT count(*)::int n FROM work_items')).rows[0].n, 1);
  assert.deepEqual(await facts(), { receipts: 1, journal: 1, outbox: 1 });
});

test('WORK-B-03 expected version is required; competing edits have one winner and one 412', async () => {
  const owner = await member(), { api } = service(), first = await api.create(owner, input());
  await assert.rejects(api.update(owner, { ...input(), workId: first.workId }), status(428));
  await assert.rejects(api.archive(owner, { key: randomUUID(), workId: first.workId }), status(428));
  let index = 0;
  const results = await simultaneous(owner, async () => {
    try { return { value: await api.update(owner, { ...input(), workId: first.workId, expectedVersion: '1', objective: 'Racing human ' + index++ }) }; }
    catch (error) { return { error }; }
  });
  assert.equal(results.filter(value => value.value).length, 1);
  assert.equal((results.find(value => value.error)!.error as { status: number }).status, 412);
  assert.equal((await readPrivateWork(pool, owner, first.workId)).aggregate_version, '2');
  assert.deepEqual(await facts(), { receipts: 2, journal: 2, outbox: 2 });
});

test('WORK-B-04 same-key update concurrency creates one new version; replay never overwrites later edits', async () => {
  const owner = await member(), { api } = service(), first = await api.create(owner, input());
  const change = { ...input(), workId: first.workId, expectedVersion: '1' };
  const [a, b] = await simultaneous(owner, () => api.update(owner, change)); assert.deepEqual(a, b);
  await api.update(owner, { ...change, key: randomUUID(), expectedVersion: '2', objective: 'Later human draft' });
  assert.deepEqual(await api.update(owner, change), a);
  assert.equal((await readPrivateWork(pool, owner, first.workId)).objective, 'Later human draft');
  assert.equal((await readPrivateWork(pool, owner, first.workId)).aggregate_version, '3');
});

test('WORK-B-05 peer, other community, platform admin and guild officer cannot mutate or replay owner Work', async () => {
  const owner = await member(), peer = await member(), outside = await member(otherCommunity), { api } = service();
  await pool.query("INSERT INTO platform_admins(admin_id,community_id,email,display_name,role) VALUES($1,$2,$3,'Synthetic admin','super_admin')", [randomUUID(), community, peer.email]);
  await pool.query('INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) SELECT $1,guild_key,$2 FROM positioning_guild_catalog ORDER BY guild_key LIMIT 1', [community, peer.user_id]);
  assert.equal((await pool.query('SELECT count(*)::int n FROM positioning_guild_officers WHERE user_id=$1', [peer.user_id])).rows[0].n, 1);
  const first = await api.create(owner, input()), change = { ...input(), workId: first.workId, expectedVersion: '1' };
  await api.update(owner, change);
  for (const actor of [peer, outside, { ...peer, platform_admin: true, role: 'admin', guild_role: 'officer' }]) {
    await assert.rejects(api.update(actor, change), status(404));
    await assert.rejects(api.archive(actor, { key: randomUUID(), workId: first.workId, expectedVersion: '2' }), status(404));
    await assert.rejects(readPrivateWork(pool, actor, first.workId), status(404));
    assert.equal((await listPrivateWork(pool, actor, {})).total, 0);
  }
  assert.deepEqual(await facts(), { receipts: 2, journal: 2, outbox: 2 });
});

test('WORK-B-06 private writes never create legacy facts or expose title/objective in scoped facts', async () => {
  const owner = await member(), { api } = service(), body = input(), first = await api.create(owner, body);
  await api.update(owner, { ...body, key: randomUUID(), workId: first.workId, expectedVersion: '1' });
  await api.archive(owner, { key: randomUUID(), workId: first.workId, expectedVersion: '2' });
  for (const table of ['scoped_command_receipts', 'scoped_transition_journal', 'scoped_outbox']) {
    const text = JSON.stringify((await pool.query(`SELECT * FROM ${table}`)).rows);
    for (const secret of [body.title, body.objective, owner.email, owner.session_hash]) assert(!text.includes(secret), table);
  }
  for (const table of ['command_receipts', 'transition_journal', 'outbox', 'work_claims', 'contributions', 'work_review_routes', 'work_benefit_observations']) {
    assert.equal((await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0, table);
  }
});

test('WORK-B-07 persistence policy gates new plaintext and replay, but denied/broken policy cannot block archive', async () => {
  const owner = await member(), { api, policy } = service(), body = input(), first = await api.create(owner, body);
  policy.platformPersistenceAllowed = false;
  await assert.rejects(api.create(owner, input()), status(403));
  await assert.rejects(api.create(owner, body), status(403));
  await assert.rejects(api.update(owner, { ...input(), workId: first.workId, expectedVersion: '1' }), status(403));
  // Existing owner reads are ACL-only, not a new policy gate or plaintext erasure.
  assert.equal((await readPrivateWork(pool, owner, first.workId)).objective, body.objective);
  const broken = createPrivateWorkCommands(pool, { resolvePolicy: async () => { throw new Error('Synthetic policy unavailable'); } });
  const archive = { key: randomUUID(), workId: first.workId, expectedVersion: '1' };
  assert.equal((await broken.archive(owner, archive)).state, 'archived');
  assert.equal((await broken.archive(owner, archive)).state, 'archived');
  await assert.rejects(readPrivateWork(pool, owner, first.workId), status(404));
});

test('WORK-B-08 strict bounded plaintext commands reject scope/owner/state/Grant and invalid bigint overrides', async () => {
  const owner = await member(), { api } = service();
  for (const extra of [{ owner_ref: owner.user_id }, { scope_id: randomUUID() }, { state: 'open' }, { grant: {} }, { result: {} }, { workId: randomUUID() }, { policy: { platformPersistenceAllowed: true } }]) {
    await assert.rejects(api.create(owner, { ...input(), ...extra }));
  }
  for (const objective of ['', '  ', 'x'.repeat(16385), '\u0000', '\uD800']) await assert.rejects(api.create(owner, { ...input(), objective }));
  const first = await api.create(owner, { ...input(), objective: '可保存的人類目標\n\t🙂' });
  for (const expectedVersion of ['0', '01', '-1', '1\n', '9223372036854775808']) {
    await assert.rejects(api.update(owner, { ...input(), workId: first.workId, expectedVersion }));
  }
  assert.deepEqual(await facts(), { receipts: 1, journal: 1, outbox: 1 });
});

for (const [index, table] of ['scoped_transition_journal', 'scoped_outbox', 'scoped_command_receipts'].entries()) {
  test(`WORK-B-${String(9 + index).padStart(2, '0')} ${table} failure rolls back plaintext/version and same-key retry commits once`, async () => {
    const owner = await member(), { api } = service(), first = await api.create(owner, input()), prior = await facts();
    const change = { ...input(), workId: first.workId, expectedVersion: '1', objective: 'Rollback candidate plaintext' };
    await pool.query(`CREATE FUNCTION reject_private_fact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic fact fault' USING ERRCODE='P0001'; END; $$`);
    await pool.query(`CREATE TRIGGER reject_private_fact BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_private_fact()`);
    try {
      await assert.rejects(api.update(owner, change), sqlCode('P0001'));
      const row = await readPrivateWork(pool, owner, first.workId);
      assert.equal(row.aggregate_version, '1'); assert.notEqual(row.objective, change.objective); assert.deepEqual(await facts(), prior);
    } finally { await pool.query(`DROP TRIGGER reject_private_fact ON ${table}`); await pool.query('DROP FUNCTION reject_private_fact()'); }
    assert.equal((await api.update(owner, change)).aggregateVersion, '2');
    assert.equal((await api.update(owner, change)).aggregateVersion, '2');
    assert.deepEqual(await facts(), { receipts: 2, journal: 2, outbox: 2 });
  });
}

test('WORK-B-12 current session/principal/scope/onboarding checks deny mutation, read and historical replay', async () => {
  for (const reason of ['session', 'principal', 'scope', 'onboarding']) {
    const owner = await member(), { api } = service(), body = input(), first = await api.create(owner, body);
    if (reason === 'session') await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1', [owner.session_hash]);
    if (reason === 'principal') await pool.query("UPDATE principals SET status='disabled' WHERE user_ref=$1", [owner.user_id]);
    if (reason === 'scope') await pool.query("UPDATE resource_scopes SET status='disabled' WHERE owner_principal_id=(SELECT principal_id FROM principals WHERE user_ref=$1)", [owner.user_id]);
    if (reason === 'onboarding') await pool.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1', [owner.user_id]);
    const denied = status(reason === 'session' ? 401 : 403);
    await assert.rejects(api.create(owner, body), denied);
    await assert.rejects(api.update(owner, { ...input(), workId: first.workId, expectedVersion: '1' }), denied);
    await assert.rejects(api.archive(owner, { key: randomUUID(), workId: first.workId, expectedVersion: '1' }), denied);
    await assert.rejects(readPrivateWork(pool, owner, first.workId), denied);
    await assert.rejects(listPrivateWork(pool, owner, {}), denied);
  }
});

test('WORK-B-13 archive is terminal in SQL and cannot become a community fact or be rebound', async () => {
  const owner = await member(), { api } = service(), first = await api.create(owner, input());
  await api.archive(owner, { key: randomUUID(), workId: first.workId, expectedVersion: '1' });
  await assert.rejects(pool.query("UPDATE work_items SET state='draft' WHERE work_item_id=$1", [first.workId]), sqlCode('23514'));
  await assert.rejects(pool.query("UPDATE work_items SET objective='replacement' WHERE work_item_id=$1", [first.workId]), sqlCode('23514'));
  await assert.rejects(pool.query('DELETE FROM work_items WHERE work_item_id=$1', [first.workId]), sqlCode('23514'));
  await assert.rejects(pool.query("UPDATE work_items SET work_mode='community_collaboration',community_id=$2 WHERE work_item_id=$1", [first.workId, community]), sqlCode('23514'));
  await assert.rejects(pool.query(`INSERT INTO work_review_routes(work_item_id,reviewer_ref,valid_until) VALUES($1,$2,clock_timestamp()+interval '1 hour')`, [first.workId, owner.user_id]), sqlCode('23503'));
});

test('WORK-B-14 server-created private sentinel stays absent from legacy/privileged reads; HTTP mutations remain unregistered', async () => {
  const owner = await member(), peer = await member(), { api } = service(), first = await api.create(owner, input());
  for (const actor of [owner, peer]) for (const path of ['/work-items', '/dashboard', '/task-board/preview', '/me/contribution-records', '/community/accepted-work']) {
    for (const headers of [{}, { Range: 'bytes=0-5', 'If-None-Match': '*' }] as Record<string, string>[]) {
      const result = await request(path, actor, 'GET', undefined, headers);
      assert.equal(result.response.status, 200, path);
      assert(!result.text.includes('Private sentinel')); assert(!result.text.includes(first.workId));
    }
  }
  for (const path of ['/me/private-work', '/me/private-work/' + first.workId, '/me/private-work/' + first.workId + '/archive']) {
    assert.equal((await request(path, owner, 'POST', input())).response.status, 404);
  }
  const detail = await request('/me/private-work/' + first.workId, owner, 'GET', undefined, { Range: 'bytes=0-5', 'If-None-Match': '*' });
  assert.equal(detail.response.status, 200); assert.equal(detail.response.headers.get('cache-control'), 'private, no-store');
  assert.equal((await request('/me/private-work/' + first.workId, peer, 'HEAD')).response.status, 404);
  await api.archive(owner, { key: randomUUID(), workId: first.workId, expectedVersion: '1' });
  assert.equal((await request('/me/private-work/' + first.workId, owner, 'HEAD')).response.status, 404);
  const listed = await request('/me/private-work?q=sentinel', owner);
  assert.equal(listed.data.total, 0); assert(!listed.text.includes('Private sentinel'));
});

test('WORK-B-15 mutable Actor cannot switch owner during a demonstrated blocked read or create', async () => {
  const owner = await member(), peer = await member(), { api } = service(), first = await api.create(owner, input());
  for (const kind of ['list', 'read', 'create']) {
    const actor = { ...owner }, lock = await pool.connect(); let pending: Promise<any> | undefined;
    try {
      await lock.query('BEGIN'); await lock.query('SELECT 1 FROM users WHERE user_id=$1 FOR UPDATE', [owner.user_id]);
      const pid = (await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      pending = kind === 'list' ? listPrivateWork(pool, actor, {}) : kind === 'read' ? readPrivateWork(pool, actor, first.workId) : api.create(actor, input());
      void pending.catch(() => {}); await blockedBy(pid); Object.assign(actor, peer); await lock.query('COMMIT');
      const result = await pending;
      if (kind === 'list') assert(result.items.some((row: any) => row.work_item_id === first.workId));
      else if (kind === 'read') assert.equal(result.work_item_id, first.workId);
      else assert.equal((await pool.query('SELECT owner_ref FROM work_items WHERE work_item_id=$1', [result.workId])).rows[0].owner_ref, owner.user_id);
    } finally { await lock.query('ROLLBACK'); lock.release(); await pending?.catch(() => {}); }
  }
});

test('WORK-B-16 session expiry after actual Work lock wait denies list, detail and update with no facts', async () => {
  for (const kind of ['list', 'read', 'update']) {
    const owner = await member(), { api } = service(), first = await api.create(owner, input()), prior = await facts();
    await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE token_hash=$1", [owner.session_hash]);
    const lock = await pool.connect(); let pending: Promise<unknown> | undefined;
    try {
      await lock.query('BEGIN');
      if (kind === 'list') await lock.query('LOCK TABLE work_items IN ACCESS EXCLUSIVE MODE');
      else await lock.query('SELECT 1 FROM work_items WHERE work_item_id=$1 FOR UPDATE', [first.workId]);
      const pid = (await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      pending = kind === 'list' ? listPrivateWork(pool, owner, {}) : kind === 'read' ? readPrivateWork(pool, owner, first.workId) : api.update(owner, { ...input(), workId: first.workId, expectedVersion: '1' });
      void pending.catch(() => {}); await blockedBy(pid);
      let expired = false;
      for (let attempt = 0; attempt < 250; attempt++) {
        expired = (await pool.query('SELECT expires_at<=clock_timestamp() expired FROM sessions WHERE token_hash=$1', [owner.session_hash])).rows[0].expired;
        if (expired) break; await delay(20);
      }
      assert(expired); await lock.query('COMMIT'); await assert.rejects(pending, status(401));
      assert.deepEqual(await facts(), prior);
    } finally { await lock.query('ROLLBACK'); lock.release(); await pending?.catch(() => {}); }
  }
});

test('WORK-B-20 simultaneous same-key archive creates one terminal version and one scoped event', async () => {
  const owner = await member(), { api } = service(), first = await api.create(owner, input());
  const change = { key: randomUUID(), workId: first.workId, expectedVersion: '1' };
  const [a, b] = await simultaneous(owner, () => api.archive(owner, change));
  assert.deepEqual(a, b); assert.equal(a.aggregateVersion, '2');
  assert.deepEqual(await facts(), { receipts: 2, journal: 2, outbox: 2 });
  assert.equal((await listPrivateWork(pool, owner, {})).total, 0);
});

test('WORK-B-21 concurrent archive and edit cannot resurrect or overwrite the winning version', async () => {
  const owner = await member(), { api } = service(), first = await api.create(owner, input()); let attempt = 0;
  const results = await simultaneous(owner, async () => {
    try {
      return { value: attempt++ === 0 ? await api.archive(owner, { key: randomUUID(), workId: first.workId, expectedVersion: '1' })
        : await api.update(owner, { ...input(), workId: first.workId, expectedVersion: '1', objective: 'Concurrent human edit' }) };
    } catch (error) { return { error }; }
  });
  assert.equal(results.filter(result => result.value).length, 1);
  assert([409, 412].includes((results.find(result => result.error)!.error as { status: number }).status));
  assert.equal((await pool.query('SELECT aggregate_version FROM work_items WHERE work_item_id=$1', [first.workId])).rows[0].aggregate_version, '2');
  assert.deepEqual(await facts(), { receipts: 2, journal: 2, outbox: 2 });
});

test('WORK-B-17 committed archive wins against blocked private detail and later list/count', async () => {
  const owner = await member(), { api } = service(), first = await api.create(owner, input()), lock = await pool.connect();
  let pending: Promise<unknown> | undefined;
  try {
    await lock.query('BEGIN'); await lock.query("UPDATE work_items SET state='archived',aggregate_version=aggregate_version+1 WHERE work_item_id=$1", [first.workId]);
    const pid = (await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    pending = readPrivateWork(pool, owner, first.workId); void pending.catch(() => {});
    await blockedBy(pid); await lock.query('COMMIT'); await assert.rejects(pending, status(404));
    assert.equal((await listPrivateWork(pool, owner, {})).total, 0);
  } finally { await lock.query('ROLLBACK'); lock.release(); await pending?.catch(() => {}); }
});

test('WORK-B-18 committed scope revoke wins a blocked mutation and its historical replay', async () => {
  const owner = await member(), { api } = service(), body = input(), first = await api.create(owner, body), lock = await pool.connect();
  let pending: Promise<unknown> | undefined;
  try {
    await lock.query('BEGIN'); await lock.query("UPDATE resource_scopes SET status='disabled' WHERE owner_principal_id=(SELECT principal_id FROM principals WHERE user_ref=$1)", [owner.user_id]);
    const pid = (await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    pending = api.update(owner, { ...input(), workId: first.workId, expectedVersion: '1' }); void pending.catch(() => {});
    await blockedBy(pid); await lock.query('COMMIT'); await assert.rejects(pending, status(403));
    await assert.rejects(api.create(owner, body), status(403));
    assert.deepEqual(await facts(), { receipts: 1, journal: 1, outbox: 1 });
  } finally { await lock.query('ROLLBACK'); lock.release(); await pending?.catch(() => {}); }
});

test('WORK-B-19 075 community facts survive additive migrations through private archive shape unchanged', async () => {
  const upgradeSchema = schema + '_075', upgrade = new Pool({ connectionString, options: `-c search_path=${upgradeSchema}` });
  await admin.query(`CREATE SCHEMA ${upgradeSchema}`);
  try {
    const files = (await readdir(new URL('../../migrations/', import.meta.url))).filter(name => name.endsWith('.sql')).sort();
    for (const file of files.filter(name => Number(name.slice(0, 3)) <= 75)) await upgrade.query(await readFile(new URL('../../migrations/' + file, import.meta.url), 'utf8'));
    const userId = randomUUID(), workId = randomUUID();
    await upgrade.query("INSERT INTO communities VALUES($1,'Synthetic 075 community')", [community]);
    await upgrade.query("INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) VALUES($1,$2,'075@example.invalid','Old member','synthetic',$3)", [userId, community, randomUUID()]);
    await upgrade.query(`INSERT INTO work_items(work_item_id,community_id,owner_ref,title,objective,acceptance_criteria,gain,state,participation_terms,participation_terms_sha256,claim_window_expires_at,due_at)
      VALUES($1,$2,$3,'Old shared title','Old objective','Old acceptance','Old gain','open','{}','old-hash',clock_timestamp()+interval '1 day',clock_timestamp()+interval '2 days')`, [workId, community, userId]);
    const prior = (await upgrade.query('SELECT to_jsonb(w) row FROM work_items w')).rows[0].row;
    for (const file of files.filter(name => Number(name.slice(0, 3)) > 75)) await upgrade.query(await readFile(new URL('../../migrations/' + file, import.meta.url), 'utf8'));
    const current = (await upgrade.query('SELECT to_jsonb(w) row FROM work_items w')).rows[0].row;
    assert.deepEqual(Object.fromEntries(Object.keys(prior).map(key => [key, current[key]])), prior);
    await upgrade.query("UPDATE work_items SET state='claiming_closed',aggregate_version=aggregate_version+1 WHERE work_item_id=$1", [workId]);
    await assert.rejects(upgrade.query("UPDATE work_items SET state='archived' WHERE work_item_id=$1", [workId]), sqlCode('23514'));
    const oldDDL = await readFile(new URL('../../migrations/077_work_scope_privacy.sql', import.meta.url), 'utf8');
    const newDDL = await readFile(new URL('../../migrations/081_private_work_commands.sql', import.meta.url), 'utf8');
    const communityBranch = (sql: string) => sql.slice(sql.indexOf("(work_mode='community_collaboration'"), sql.indexOf("OR (work_mode='personal_execution'"));
    assert.equal(communityBranch(newDDL), communityBranch(oldDDL));
  } finally { await upgrade.end(); await admin.query(`DROP SCHEMA ${upgradeSchema} CASCADE`); }
});

test('WORK-B-22 create/archive receipt failure leaves no orphan Work or false archived state', async () => {
  const owner = await member(), { api } = service(), body = input();
  for (const operation of ['create', 'archive']) {
    const first = operation === 'archive' ? await api.create(owner, input()) : null;
    const archive = { key: randomUUID(), workId: first?.workId ?? randomUUID(), expectedVersion: '1' };
    const prior = await facts(), before = (await pool.query('SELECT count(*)::int n FROM work_items')).rows[0].n;
    await pool.query(`CREATE FUNCTION reject_private_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic receipt fault' USING ERRCODE='P0001'; END; $$`);
    await pool.query('CREATE TRIGGER reject_private_receipt BEFORE INSERT ON scoped_command_receipts FOR EACH ROW EXECUTE FUNCTION reject_private_receipt()');
    try {
      await assert.rejects(operation === 'create' ? api.create(owner, body) : api.archive(owner, archive), sqlCode('P0001'));
      assert.deepEqual(await facts(), prior);
      assert.equal((await pool.query('SELECT count(*)::int n FROM work_items')).rows[0].n, before);
      if (first) assert.equal((await readPrivateWork(pool, owner, first.workId)).state, 'draft');
    } finally { await pool.query('DROP TRIGGER reject_private_receipt ON scoped_command_receipts'); await pool.query('DROP FUNCTION reject_private_receipt()'); }
    const result = operation === 'create' ? await api.create(owner, body) : await api.archive(owner, archive);
    assert.equal(result.aggregateVersion, operation === 'create' ? '1' : '2');
  }
});
