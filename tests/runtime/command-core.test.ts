import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import { command, digest, journal, createPool, LOCAL_DATABASE_URL, type Command } from '../../packages/db/index.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import type { Actor } from '../../modules/identity-membership/service.js';
import { migrate } from '../../scripts/database.js';

// Every test runs exclusively in a fresh fp_* schema. No public fallback in search_path.
const schema = `fp_command_core_${process.pid}_${Date.now()}`;
const connectionString = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const admin = createPool(connectionString);
const pool = new Pool({ connectionString, options: `-c search_path=${schema} -c statement_timeout=10000`, max: 8 });
const community = '10000000-0000-4000-8000-000000000001';
const user = '20000000-0000-4000-8000-000000000001';
const effect = '30000000-0000-4000-8000-000000000001';
const operation = 'POST /api/v1/fp-synthetic-command';
let created = false;
before(async () => {
  assert.match(schema, /^fp_command_core_[0-9]+_[0-9]+$/);
  await admin.query(`CREATE SCHEMA ${schema}`); created = true;
  await migrate(pool);
  await pool.query('CREATE TABLE fp_command_effects (id integer PRIMARY KEY, value integer NOT NULL, allowed boolean NOT NULL)');
});
after(async () => { await pool.end(); if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(async () => {
  await pool.query('TRUNCATE communities CASCADE');
  await pool.query('TRUNCATE fp_command_effects');
  await pool.query('INSERT INTO communities VALUES ($1,$2)', [community, 'Synthetic foundation']);
  await pool.query('INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) VALUES($1,$2,$3,$4,$5,$6)',
    [user, community, 'foundation@example.invalid', 'Synthetic member', 'not-a-login-hash', randomUUID()]);
  await pool.query('INSERT INTO fp_command_effects VALUES(1,0,true)');
});

async function actor(): Promise<Actor> {
  const row = (await pool.query('SELECT * FROM users WHERE user_id=$1', [user])).rows[0];
  const token = randomUUID();
  await pool.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [token, user, 'synthetic-csrf']);
  return { ...row, session_hash: token, csrf_token: 'synthetic-csrf' };
}
const input = (actor: Actor, overrides: Partial<Command> = {}): Command => ({ actor, operation, key: 'synthetic-key-001', body: { z: 2, a: { x: 1 } }, ...overrides });
async function authorize(q: PoolClient) {
  const row = (await q.query('SELECT allowed FROM fp_command_effects WHERE id=1 FOR UPDATE')).rows[0];
  requireCondition(row.allowed, 403, 'synthetic_access_revoked', 'Synthetic access revoked.');
}
async function mutate(q: PoolClient, owner: Actor) {
  const value = (await q.query('UPDATE fp_command_effects SET value=value+1 WHERE id=1 RETURNING value')).rows[0].value;
  await journal(q, owner, 'fp_command_effect', effect, value, operation, { synthetic: true }, 'fp.synthetic.changed');
  return { value, nested: { stable: true } };
}
const invoke = (owner: Actor, overrides: Partial<Command> = {}) => command(pool, input(owner, overrides), authorize, q => mutate(q, owner));
async function counts() {
  return (await pool.query(`SELECT (SELECT value FROM fp_command_effects WHERE id=1) AS effects,
    (SELECT count(*)::int FROM command_receipts) AS receipts,
    (SELECT count(*)::int FROM transition_journal) AS journals,
    (SELECT count(*)::int FROM outbox) AS events`)).rows[0];
}
function hasProblem(status: number, code: string) { return (error: unknown) => error instanceof Problem && error.status === status && error.code === code; }
function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function untilBlockedBy(pid: number) {
  for (let count = 0; count < 100; count++) {
    const result = await admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked', [pid]);
    if (result.rows[0].blocked) return;
    await delay(10);
  }
  assert.fail('Expected PostgreSQL lock wait was not observed.');
}

test('historical digest, receipt namespace and response stay byte/shape compatible', async () => {
  const owner = await actor(), request = input(owner);
  assert.equal(digest({ body: request.body, expected: null }), '04c06edf28718aabf63edc58b6c7f870b6a011ffc64bcad6cf2117281ff7d41b');
  const first = await invoke(owner), replay = await invoke(owner, { body: { a: { x: 1 }, z: 2 } });
  assert.deepEqual(first, { value: 1, nested: { stable: true } }); assert.deepEqual(replay, first);
  const receipt = (await pool.query('SELECT * FROM command_receipts')).rows[0];
  assert.equal(receipt.user_id, owner.user_id); assert.equal(receipt.operation, operation);
  assert.equal(receipt.idempotency_key, request.key); assert.equal(receipt.request_sha256, digest({ body: request.body, expected: null }));
  assert.deepEqual(await counts(), { effects: 1, receipts: 1, journals: 1, events: 1 });
});

test('invalid key is rejected before authorization or mutation', async () => {
  const owner = await actor(); let called = false;
  await assert.rejects(command(pool, input(owner, { key: 'bad' }), async () => { called = true; }, async () => { called = true; }), hasProblem(400, 'idempotency_required'));
  assert.equal(called, false); assert.deepEqual(await counts(), { effects: 0, receipts: 0, journals: 0, events: 0 });
});

for (const scenario of ['revoked-session', 'expired-session', 'inactive-user', 'wrong-community', 'revoked-domain'] as const) {
  test(`successful receipt cannot bypass current ${scenario}`, async () => {
    const owner = await actor(); await invoke(owner);
    if (scenario === 'revoked-session') await pool.query('UPDATE sessions SET revoked_at=now()');
    if (scenario === 'expired-session') await pool.query("UPDATE sessions SET expires_at=now()-interval '1 second'");
    if (scenario === 'inactive-user') await pool.query('UPDATE users SET active=false');
    if (scenario === 'wrong-community') owner.community_id = randomUUID();
    if (scenario === 'revoked-domain') await pool.query('UPDATE fp_command_effects SET allowed=false');
    await assert.rejects(invoke(owner), hasProblem(scenario === 'revoked-domain' ? 403 : 401, scenario === 'revoked-domain' ? 'synthetic_access_revoked' : 'session_expired'));
    assert.deepEqual(await counts(), { effects: 1, receipts: 1, journals: 1, events: 1 });
  });
}

test('same key with different payload or expected version conflicts without changing prior receipt', async () => {
  const owner = await actor(); await invoke(owner);
  for (const overrides of [{ body: { changed: true } }, { expected: '2' }]) await assert.rejects(invoke(owner, overrides), hasProblem(409, 'idempotency_conflict'));
  assert.deepEqual(await counts(), { effects: 1, receipts: 1, journals: 1, events: 1 });
});

test('two sessions with the same key serialize to one effect and the same response', async () => {
  const first = await actor(), second = await actor(), entered = barrier(), finish = barrier(); let pid = 0;
  const a = command(pool, input(first), authorize, async q => {
    pid = (await q.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; entered.release(); await finish.promise; return mutate(q, first);
  });
  await entered.promise;
  const b = invoke(second);
  try { await untilBlockedBy(pid); } finally { finish.release(); }
  assert.deepEqual(await a, await b);
  assert.deepEqual(await counts(), { effects: 1, receipts: 1, journals: 1, events: 1 });
});

test('two sessions with conflicting bodies cannot commit a second effect', async () => {
  const a = await actor(), b = await actor();
  const outcomes = await Promise.allSettled([invoke(a), invoke(b, { body: { changed: true } })]);
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  const rejected = outcomes.find(item => item.status === 'rejected'); assert(rejected?.status === 'rejected');
  assert(hasProblem(409, 'idempotency_conflict')(rejected.reason));
  assert.deepEqual(await counts(), { effects: 1, receipts: 1, journals: 1, events: 1 });
});

test('a revocation holding the user lock wins before an incoming member command', async () => {
  const owner = await actor(), revoker = await pool.connect();
  try {
    await revoker.query('BEGIN');
    const pid = (await revoker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await revoker.query('SELECT user_id FROM users WHERE user_id=$1 FOR UPDATE', [owner.user_id]);
    const pending = invoke(owner);
    const denied = assert.rejects(pending, hasProblem(401, 'session_expired'));
    try {
      await untilBlockedBy(pid);
      await revoker.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [owner.user_id]);
      await revoker.query('COMMIT');
    } finally { await revoker.query('ROLLBACK'); }
    await denied;
    assert.deepEqual(await counts(), { effects: 0, receipts: 0, journals: 0, events: 0 });
  } finally { revoker.release(); }
});

test('user-updating commands acquire the strong user lock before the session lock', async () => {
  const owner = await actor(), entered = barrier(), finish = barrier(); let pid = 0;
  const running = command(pool, input(owner, { lockUser: true }), authorize, async q => {
    pid = (await q.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; entered.release(); await finish.promise;
    await q.query('UPDATE users SET display_name=$1 WHERE user_id=$2', ['Still synthetic', owner.user_id]); return mutate(q, owner);
  });
  await entered.promise;
  const revoke = (async () => {
    const q = await pool.connect();
    try { await q.query('BEGIN'); await q.query('SELECT user_id FROM users WHERE user_id=$1 FOR UPDATE', [owner.user_id]);
      await q.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [owner.user_id]); await q.query('COMMIT');
    } catch (error) { await q.query('ROLLBACK'); throw error; } finally { q.release(); }
  })();
  try { await untilBlockedBy(pid); } finally { finish.release(); }
  await running; await revoke;
  await assert.rejects(invoke(owner), hasProblem(401, 'session_expired'));
  assert.deepEqual(await counts(), { effects: 1, receipts: 1, journals: 1, events: 1 });
});

test('domain failure rolls back effects, journal, outbox and receipt', async () => {
  const owner = await actor();
  await assert.rejects(command(pool, input(owner), authorize, async q => { await mutate(q, owner); throw new Error('synthetic failure'); }), /synthetic failure/);
  assert.deepEqual(await counts(), { effects: 0, receipts: 0, journals: 0, events: 0 });
});

for (const table of ['command_receipts', 'transition_journal', 'outbox']) test(`${table} insert failure rolls back all domain facts`, async () => {
  const owner = await actor();
  await pool.query(`CREATE FUNCTION fp_reject_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic insert failure'; END $$`);
  await pool.query(`CREATE TRIGGER fp_reject_insert BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fp_reject_insert()`);
  try {
    await assert.rejects(invoke(owner), /synthetic insert failure/);
    assert.deepEqual(await counts(), { effects: 0, receipts: 0, journals: 0, events: 0 });
  } finally {
    await pool.query(`DROP TRIGGER fp_reject_insert ON ${table}`); await pool.query('DROP FUNCTION fp_reject_insert()');
  }
});
