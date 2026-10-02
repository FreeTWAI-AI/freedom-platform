import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import { createPool } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import { createPrivateWorkCommands } from '../../modules/opportunity-project-work/private-commands.js';
import { createPrivateResultService } from '../../modules/autopilot-work/results.js';
import { resolvePrivateWorkPersistencePolicy as resolvePolicy } from '../../modules/autopilot-work/policy.js';
import type { Actor } from '../../modules/identity-membership/service.js';
import { FakeObjectStore } from '../../packages/asset-storage/fake-store.js';
import { sha256, type AssetObjectKey } from '../../packages/asset-storage/index.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw Error('Independent policy tests require explicit isolated TEST_DATABASE_URL');
const schema = `fp_policy_adversarial_${process.pid}_${Date.now()}`;
const admin = createPool(connectionString), pool = new Pool({ connectionString, options: `-c search_path=${schema} -c statement_timeout=10000`, max: 12 });
let created = false;
const community = randomUUID(), commands = createPrivateWorkCommands(pool, { resolvePolicy });
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); created = true; await migrate(pool); });
after(async () => { await pool.end(); if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(async () => { await pool.query('TRUNCATE communities CASCADE'); await pool.query("INSERT INTO communities VALUES($1,'Synthetic policy review')", [community]); });
const status = (n: number) => (error: any) => error?.status === n;
const code = (name: string) => (error: any) => error?.code === name;
function latch() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
class Store extends FakeObjectStore {
  gets = 0; onGet?: () => Promise<void>;
  override async get(key: AssetObjectKey) { this.gets++; await this.onGet?.(); return super.get(key); }
}
async function member() {
  const user = randomUUID(), session = randomUUID();
  const row = (await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic','not-a-login',$4) RETURNING *`, [user, community, user + '@example.invalid', randomUUID()])).rows[0];
  await pool.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1hour')", [session, user]);
  const actor: Actor = { ...row, session_hash: session, csrf_token: 'synthetic' };
  const context = await withMemberScope(pool, { actor, scope: 'personal' }, async () => {}, async (_q, value) => value);
  return { actor, context, scope: context.scope.scope_id, principal: context.subject_principal.principal_id };
}
async function enable(f: Awaited<ReturnType<typeof member>>, allowed = true) {
  await pool.query(`INSERT INTO private_work_persistence_policy(scope_id,purpose,owner_principal_id,revision,persistence_allowed,retained_byte_limit)
    VALUES($1,'work.private-draft',$2,1,$3,10485760)`, [f.scope, f.principal, allowed]);
}
async function fixture() {
  const f = await member(); await enable(f);
  const input = { key: randomUUID(), title: 'PRIVATE_POLICY_TITLE', objective: 'PRIVATE_POLICY_OBJECTIVE' };
  const work = await commands.create(f.actor, input);
  const store = new Store(), service = createPrivateResultService(pool, { store, resolvePolicy });
  return { ...f, work, input, store, service };
}
async function completed(f: Awaited<ReturnType<typeof fixture>>) {
  const bytes = new TextEncoder().encode('PRIVATE_POLICY_RESULT');
  const prepared = await f.service.prepare(f.actor, { key: randomUUID(), targetWorkId: f.work.workId, expectedVersion: '1',
    contentType: 'text/plain', byteSize: bytes.length, sha256: await sha256(bytes) });
  const lease = await f.service.claim(f.actor, { key: randomUUID(), intentId: prepared.intentId });
  const token = { intentId: lease.intentId, fence: lease.fence, leaseToken: lease.leaseToken };
  await f.service.write(f.actor, { ...token, key: randomUUID() }, new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }));
  const finalize = { ...token, key: randomUUID() }, result = await f.service.finalize(f.actor, finalize);
  return { finalize, result };
}
async function change(scope: string, allowed: boolean) {
  await pool.query('UPDATE private_work_persistence_policy SET revision=revision+1,persistence_allowed=$2 WHERE scope_id=$1', [scope, allowed]);
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

test('POLICY independent missing/default-deny/foreign owner remain denied, with no seeded policy', async () => {
  assert.equal((await pool.query('SELECT count(*)::int n FROM private_work_persistence_policy')).rows[0].n, 0);
  const f = await member(), peer = await member();
  await assert.rejects(commands.create(f.actor, { key: randomUUID(), title: 'a', objective: 'b' }), status(503));
  await enable(f, false);
  await assert.rejects(commands.create(f.actor, { key: randomUUID(), title: 'a', objective: 'b' }), status(503));
  await change(f.scope, true);
  const q = await pool.connect();
  try {
    await q.query('BEGIN');
    const current = await resolvePolicy(q, f.context); assert.equal(current.revision, 'private-work.v2'); assert(Object.isFrozen(current));
    await assert.rejects(resolvePolicy(q, { ...peer.context, scope: f.context.scope }), status(503));
  } finally { await q.query('ROLLBACK'); q.release(); }
  await assert.rejects(commands.create(peer.actor, { key: randomUUID(), title: 'a', objective: 'b' }), status(503));
});

test('POLICY independent restricted runtime can execute the actual resolver without policy mutation authority', async () => {
  const f = await member(); await enable(f);
  const q = await pool.connect(), role = `fp_policy_read_${process.pid}_${Date.now()}`;
  try {
    await q.query('BEGIN'); await q.query(`CREATE ROLE ${role}`);
    await q.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await q.query(`GRANT SELECT ON private_work_persistence_policy TO ${role}`);
    await q.query(`SET LOCAL ROLE ${role}`);
    await q.query('SAVEPOINT select_only');
    await assert.rejects(resolvePolicy(q, f.context), status(503));
    await q.query('ROLLBACK TO SAVEPOINT select_only');
    await q.query('RESET ROLE');
    await q.query(`GRANT UPDATE(scope_kind) ON private_work_persistence_policy TO ${role}`);
    await q.query(`SET LOCAL ROLE ${role}`);
    const current = await resolvePolicy(q, f.context);
    assert.equal(current.revision, 'private-work.v1');
    for (const column of ['scope_id', 'purpose', 'owner_principal_id', 'revision', 'persistence_allowed', 'retained_byte_limit', 'created_at', 'updated_at'])
      assert.equal((await q.query("SELECT has_column_privilege(current_user,'private_work_persistence_policy',$1,'UPDATE') allowed", [column])).rows[0].allowed, false);
    const before = (await q.query('SELECT to_jsonb(p) state FROM private_work_persistence_policy p WHERE scope_id=$1', [f.scope])).rows[0].state;
    await q.query('UPDATE private_work_persistence_policy SET scope_kind=DEFAULT WHERE scope_id=$1', [f.scope]);
    assert.deepEqual((await q.query('SELECT to_jsonb(p) state FROM private_work_persistence_policy p WHERE scope_id=$1', [f.scope])).rows[0].state, before);
    for (const [sql, errorCode] of [
      ["UPDATE private_work_persistence_policy SET scope_kind='personal'", '428C9'],
      ['UPDATE private_work_persistence_policy SET scope_kind=DEFAULT,persistence_allowed=false', '42501'],
      ['UPDATE private_work_persistence_policy SET revision=revision+1', '42501'],
      ['DELETE FROM private_work_persistence_policy', '42501'],
      ['TRUNCATE private_work_persistence_policy', '42501'],
      ['INSERT INTO private_work_persistence_policy DEFAULT VALUES', '42501'],
    ]) {
      await q.query('SAVEPOINT denied_mutation'); await assert.rejects(q.query(sql), code(errorCode));
      await q.query('ROLLBACK TO SAVEPOINT denied_mutation');
    }
  } finally { await q.query('ROLLBACK'); q.release(); }
});

test('POLICY independent SQL cannot rebind purpose/scope/owner, skip revision, delete, or enable absent quota', async () => {
  const f = await member(), peer = await member(); await enable(f);
  for (const [sql, params] of [
    ["UPDATE private_work_persistence_policy SET purpose='member.avatar',revision=2 WHERE scope_id=$1", [f.scope]],
    ['UPDATE private_work_persistence_policy SET owner_principal_id=$2,revision=2 WHERE scope_id=$1', [f.scope, peer.principal]],
    ['UPDATE private_work_persistence_policy SET scope_id=$2,revision=2 WHERE scope_id=$1', [f.scope, peer.scope]],
    ['UPDATE private_work_persistence_policy SET persistence_allowed=false WHERE scope_id=$1', [f.scope]],
    ['UPDATE private_work_persistence_policy SET revision=3 WHERE scope_id=$1', [f.scope]],
    ['UPDATE private_work_persistence_policy SET retained_byte_limit=NULL,revision=2 WHERE scope_id=$1', [f.scope]],
    ['DELETE FROM private_work_persistence_policy WHERE scope_id=$1', [f.scope]],
  ] as const) await assert.rejects(pool.query(sql, [...params]), code('23514'));
  await assert.rejects(pool.query(`INSERT INTO private_work_persistence_policy(scope_id,purpose,owner_principal_id,revision)
    VALUES($1,'work.private-draft',$2,1)`, [peer.scope, f.principal]), code('23503'));
});

test('POLICY independent revoke blocks actual Work and Result success replays but archive remains available', async () => {
  const f = await fixture(), p = await completed(f); await change(f.scope, false);
  await assert.rejects(commands.create(f.actor, f.input), status(503));
  await assert.rejects(f.service.finalize(f.actor, p.finalize), status(503));
  const gets = f.store.gets;
  await assert.rejects(f.service.readCurrent(f.actor, { workId: f.work.workId }), status(503)); assert.equal(f.store.gets, gets);
  const archived = await commands.archive(f.actor, { key: randomUUID(), workId: f.work.workId, expectedVersion: '2' });
  assert.equal(archived.state, 'archived');
  for (const table of ['scoped_command_receipts', 'scoped_transition_journal', 'scoped_outbox'])
    assert(!JSON.stringify((await pool.query(`SELECT * FROM ${table}`)).rows).includes('PRIVATE_POLICY_'));
});

test('POLICY independent current allowing revision permits fresh history read but refuses old finalize receipt', async () => {
  const f = await fixture(), p = await completed(f); await change(f.scope, true);
  await assert.rejects(f.service.finalize(f.actor, p.finalize), code('asset_policy_changed'));
  assert.equal((await f.service.readResult(f.actor, { workId: f.work.workId, resultId: p.result.resultId })).text, 'PRIVATE_POLICY_RESULT');
});

for (const allowed of [true, false]) test(`POLICY independent change during unlocked GET (${allowed}) rejects returning text`, async () => {
  const f = await fixture(); await completed(f); const started = latch(), release = latch();
  f.store.onGet = async () => { started.release(); await release.promise; };
  const reading = f.service.readCurrent(f.actor, { workId: f.work.workId });
  const rejected = assert.rejects(reading, allowed ? code('asset_policy_changed') : status(503));
  try { await started.promise; await change(f.scope, allowed); } finally { release.release(); }
  await rejected;
});

for (const method of ['create', 'read'] as const) test(`POLICY independent ${method} rechecks session clock after an actual policy row-lock wait`, async () => {
  const f = method === 'read' ? await fixture() : { ...await member(), work: undefined, service: undefined };
  if (method === 'read') await completed(f as Awaited<ReturnType<typeof fixture>>); else await enable(f);
  await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '1second' WHERE token_hash=$1", [f.actor.session_hash]);
  const q = await pool.connect();
  try {
    await q.query('BEGIN'); await q.query('UPDATE private_work_persistence_policy SET revision=revision+1 WHERE scope_id=$1', [f.scope]);
    const operation = method === 'create' ? commands.create(f.actor, { key: randomUUID(), title: 'late', objective: 'must not persist' })
      : f.service!.readCurrent(f.actor, { workId: f.work!.workId });
    const rejected = assert.rejects(operation, status(401));
    await blockedBy(q); await expired(f.actor); await q.query('COMMIT'); await rejected;
    if (method === 'create') assert.equal((await pool.query('SELECT count(*)::int n FROM work_items')).rows[0].n, 0);
  } finally { await q.query('ROLLBACK'); q.release(); }
});
