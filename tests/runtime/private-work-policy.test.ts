import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import { createPool } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { withMemberScope, lockMemberScope, type MemberScopeContext } from '../../packages/resource-scopes/index.js';
import type { Actor } from '../../modules/identity-membership/service.js';
import { createPrivateWorkCommands } from '../../modules/opportunity-project-work/private-commands.js';
import { createPrivateResultService } from '../../modules/autopilot-work/results.js';
import { resolvePrivateWorkPersistencePolicy } from '../../modules/autopilot-work/policy.js';
import { FakeObjectStore } from '../../packages/asset-storage/fake-store.js';
import { sha256, type AssetObjectKey } from '../../packages/asset-storage/index.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname))
  throw new Error('Private policy tests require explicit disposable fp_* TEST_DATABASE_URL.');
const schema = `fp_private_policy_${process.pid}_${Date.now()}`, role = `${schema}_reader`;
const admin = createPool(connectionString), pool = new Pool({ connectionString, options: `-c search_path=${schema} -c statement_timeout=10000`, max: 12 });
const community = randomUUID(); let created = false, roleCreated = false;
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`); created = true; await migrate(pool);
  await pool.query("INSERT INTO communities VALUES($1,'Synthetic persistence policy')", [community]);
});
after(async () => {
  await pool.end(); if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  if (roleCreated) await admin.query(`DROP ROLE ${role}`); await admin.end();
});
const code = (expected: string) => (error: unknown) => (error as { code?: string })?.code === expected;
const status = (expected: number) => (error: unknown) => (error as { status?: number })?.status === expected;
const commands = createPrivateWorkCommands(pool, { resolvePolicy: resolvePrivateWorkPersistencePolicy });
const workInput = () => ({ key: randomUUID(), title: 'Synthetic private title', objective: 'Synthetic human purpose, not a model result' });
class Store extends FakeObjectStore {
  gets = 0; onGet?: () => Promise<void>;
  override async get(key: AssetObjectKey) { this.gets++; await this.onGet?.(); return super.get(key); }
}
function service(store = new Store()) {
  return { store, api: createPrivateResultService(pool, { store, resolvePolicy: resolvePrivateWorkPersistencePolicy, maxPendingIntents: 20 }) };
}
async function member() {
  const id = randomUUID(), session = randomUUID();
  const row = (await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic policy owner','not-a-real-login',$4) RETURNING *`, [id, community, id+'@example.invalid', randomUUID()])).rows[0];
  await pool.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')", [session, id]);
  const actor: Actor = { ...row, session_hash: session, csrf_token: 'synthetic' };
  const context = await withMemberScope(pool, { actor, scope: 'personal' }, async () => {}, async (_q, context) => context);
  return { actor, context };
}
async function configure(f: Awaited<ReturnType<typeof member>>, enabled = true, quota: string | null = '1048576') {
  await pool.query(`INSERT INTO private_work_persistence_policy(scope_id,purpose,owner_principal_id,revision,persistence_allowed,retained_byte_limit)
    VALUES($1,'work.private-draft',$2,1,$3,$4)`, [f.context.scope.scope_id, f.context.subject_principal.principal_id, enabled, quota]);
}
async function change(f: Awaited<ReturnType<typeof member>>, enabled: boolean, quota = '1048576') {
  await pool.query(`UPDATE private_work_persistence_policy SET revision=revision+1,persistence_allowed=$2,retained_byte_limit=$3 WHERE scope_id=$1`, [f.context.scope.scope_id, enabled, quota]);
}
async function fixture() {
  const f = await member(); await configure(f); const input = workInput(), work = await commands.create(f.actor, input);
  return { ...f, input, workId: work.workId };
}
async function stored(f: Awaited<ReturnType<typeof fixture>>, s: ReturnType<typeof service>) {
  const bytes = new TextEncoder().encode('SYNTHETIC_PRIVATE_TEXT');
  const prepareInput = { key: randomUUID(), targetWorkId: f.workId, expectedVersion: '1', contentType: 'text/plain' as const, byteSize: bytes.length, sha256: await sha256(bytes) };
  const prepared = await s.api.prepare(f.actor, prepareInput), claimInput = { key: randomUUID(), intentId: prepared.intentId };
  const lease = await s.api.claim(f.actor, claimInput), finalInput = { key: randomUUID(), intentId: lease.intentId, fence: lease.fence, leaseToken: lease.leaseToken };
  await s.api.write(f.actor, { ...finalInput, key: randomUUID() }, new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }));
  return { prepareInput, claimInput, finalInput };
}
async function blockedBy(q: PoolClient) {
  const pid = (await q.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  for (let i = 0; i < 250; i++) {
    if ((await admin.query('SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid])).rows[0].n) return;
    await delay(10);
  }
  assert.fail('Expected real PostgreSQL policy lock wait.');
}
async function expired(actor: Actor) {
  for (let i = 0; i < 250; i++) {
    if ((await pool.query('SELECT expires_at<=clock_timestamp() expired FROM sessions WHERE token_hash=$1', [actor.session_hash])).rows[0].expired) return;
    await delay(10);
  }
  assert.fail('Expected actual database clock expiry.');
}

test('POLICY-01 migration creates no enabling policy rows and missing policy denies both closed services', async () => {
  assert.equal((await pool.query('SELECT count(*)::int n FROM private_work_persistence_policy')).rows[0].n, 0);
  const f = await member(); await assert.rejects(commands.create(f.actor, workInput()), code('private_work_policy_unavailable'));
  assert.equal((await pool.query('SELECT count(*)::int n FROM work_items WHERE owner_ref=$1', [f.actor.user_id])).rows[0].n, 0);
  await assert.rejects(withMemberScope(pool, { actor: f.actor, scope: 'personal' }, async () => {}, (q, c) => resolvePrivateWorkPersistencePolicy(q, c)), status(503));
});
test('POLICY-02 default false/null quota fails closed; explicit revision and adequate quota enable both services', async () => {
  const f = await member();
  await pool.query("INSERT INTO private_work_persistence_policy(scope_id,purpose,owner_principal_id,revision) VALUES($1,'work.private-draft',$2,1)", [f.context.scope.scope_id, f.context.subject_principal.principal_id]);
  await assert.rejects(commands.create(f.actor, workInput()), status(503));
  await assert.rejects(pool.query('UPDATE private_work_persistence_policy SET revision=2,persistence_allowed=true WHERE scope_id=$1', [f.context.scope.scope_id]), code('23514'));
  await change(f, true); const work = await commands.create(f.actor, workInput());
  assert.equal(await service().api.readCurrent(f.actor, { workId: work.workId }), null);
  const policy = await withMemberScope(pool, { actor: f.actor, scope: 'personal' }, async () => {}, resolvePrivateWorkPersistencePolicy);
  assert.deepEqual(policy, { revision: 'private-work.v2', platformPersistenceAllowed: true, retainedByteLimit: '1048576' }); assert(Object.isFrozen(policy));
});
test('POLICY-03 exact personal owner composite FK rejects foreign principal/community scope/null/purpose', async () => {
  const a = await member(), b = await member();
  const communityScope = await withMemberScope(pool, { actor: a.actor, scope: 'community' }, async () => {}, async (_q, c) => c);
  for (const [scope, owner, purpose, expected] of [
    [a.context.scope.scope_id, b.context.subject_principal.principal_id, 'work.private-draft', '23503'],
    [communityScope.scope.scope_id, a.context.subject_principal.principal_id, 'work.private-draft', '23503'],
    [null, a.context.subject_principal.principal_id, 'work.private-draft', '23502'],
    [a.context.scope.scope_id, null, 'work.private-draft', '23502'],
    [a.context.scope.scope_id, a.context.subject_principal.principal_id, 'member.avatar', '23514'],
  ]) await assert.rejects(pool.query('INSERT INTO private_work_persistence_policy(scope_id,owner_principal_id,purpose,revision) VALUES($1,$2,$3,1)', [scope, owner, purpose]), code(expected!));
});
test('POLICY-04 invalid revision/quota cannot establish an allowing policy', async () => {
  const f = await member();
  for (const [revision, quota, expected] of [['0','262144','23514'],['2','262144','23514'],['1','0','23514'],['1','262143','23514'],['1',null,'23514'],['1','9223372036854775808','22003']])
    await assert.rejects(pool.query("INSERT INTO private_work_persistence_policy(scope_id,owner_principal_id,purpose,revision,persistence_allowed,retained_byte_limit) VALUES($1,$2,'work.private-draft',$3,true,$4)", [f.context.scope.scope_id, f.context.subject_principal.principal_id, revision, quota]), code(expected!));
  await configure(f, true, '9223372036854775807');
  const value = await withMemberScope(pool, { actor: f.actor, scope: 'personal' }, async () => {}, resolvePrivateWorkPersistencePolicy);
  assert.equal(value.retainedByteLimit, '9223372036854775807');
});
test('POLICY-05 semantic policy changes require exact next revision; delete and identity rebind are denied', async () => {
  const f = await fixture(), peer = await member(), scope = f.context.scope.scope_id;
  for (const sql of ['persistence_allowed=false', 'retained_byte_limit=524288', 'revision=3', 'revision=0'])
    await assert.rejects(pool.query(`UPDATE private_work_persistence_policy SET ${sql} WHERE scope_id=$1`, [scope]), code('23514'));
  await assert.rejects(pool.query('DELETE FROM private_work_persistence_policy WHERE scope_id=$1', [scope]), code('23514'));
  await assert.rejects(pool.query('UPDATE private_work_persistence_policy SET scope_id=$2,owner_principal_id=$3,revision=revision+1 WHERE scope_id=$1', [scope, peer.context.scope.scope_id, peer.context.subject_principal.principal_id]), code('23514'));
  await change(f, false); await change(f, true);
  assert.equal((await pool.query('SELECT revision::text FROM private_work_persistence_policy WHERE scope_id=$1', [scope])).rows[0].revision, '3');
  await assert.rejects(pool.query('UPDATE private_work_persistence_policy SET revision=1 WHERE scope_id=$1', [scope]), code('23514'));
});
test('POLICY-06 resolver rejects wrong context and foreign scope/owner pairing without conferring standalone authority', async () => {
  const f = await fixture(), peer = await member();
  for (const context of [
    { ...f.context, authn_kind: 'machine' }, { ...f.context, scope: { ...f.context.scope, kind: 'community' } },
    { ...f.context, subject_principal: peer.context.subject_principal }, { ...f.context, scope: peer.context.scope },
  ]) await assert.rejects(withMemberScope(pool, { actor: f.actor, scope: 'personal' }, async () => {}, q => resolvePrivateWorkPersistencePolicy(q, context as MemberScopeContext)), status(503));
});
test('POLICY-07 DB policy is shared through actual Work and Result publication and reads', async () => {
  const f = await fixture(), s = service(), p = await stored(f, s), result = await s.api.finalize(f.actor, p.finalInput);
  assert.equal(result.aggregateVersion, '2'); assert.equal((await s.api.readCurrent(f.actor, { workId: f.workId }))?.text, 'SYNTHETIC_PRIVATE_TEXT');
  assert.equal((await pool.query('SELECT policy_revision FROM private_work_results WHERE result_id=$1', [result.resultId])).rows[0].policy_revision, 'private-work.v1');
  await change(f, false); const gets = s.store.gets;
  await assert.rejects(s.api.readCurrent(f.actor, { workId: f.workId }), status(503));
  await assert.rejects(s.api.readResult(f.actor, { workId: f.workId, resultId: result.resultId }), status(503));
  await assert.rejects(s.api.list(f.actor, { workId: f.workId }), status(503)); assert.equal(s.store.gets, gets);
  await assert.rejects(s.api.finalize(f.actor, p.finalInput), status(503)); await assert.rejects(commands.create(f.actor, f.input), status(503));
  assert.equal((await commands.archive(f.actor, { key: randomUUID(), workId: f.workId, expectedVersion: '2' })).state, 'archived');
});
test('POLICY-08 allowing revision change permits fresh historical read, never reactivates old upload/finalize receipts', async () => {
  const f = await fixture(), s = service(), p = await stored(f, s), result = await s.api.finalize(f.actor, p.finalInput);
  await change(f, false); await change(f, true);
  assert.equal((await s.api.readResult(f.actor, { workId: f.workId, resultId: result.resultId }))?.text, 'SYNTHETIC_PRIVATE_TEXT');
  await assert.rejects(s.api.finalize(f.actor, p.finalInput), code('asset_policy_changed'));
  await assert.rejects(s.api.resumeUpload(f.actor, p.claimInput), code('asset_policy_changed'));
  assert.equal((await pool.query('SELECT count(*)::int n FROM private_work_results WHERE work_item_id=$1', [f.workId])).rows[0].n, 1);
});
test('POLICY-09 revision change during external GET denies return after fresh policy read', async () => {
  const f = await fixture(), s = service(), p = await stored(f, s); await s.api.finalize(f.actor, p.finalInput);
  s.store.onGet = async () => { s.store.onGet = undefined; await change(f, true, '524288'); };
  await assert.rejects(s.api.readCurrent(f.actor, { workId: f.workId }), code('asset_policy_changed'));
  assert.equal((await s.api.readCurrent(f.actor, { workId: f.workId }))?.text, 'SYNTHETIC_PRIVATE_TEXT');
});
for (const phase of ['create', 'result-read', 'result-prepare'] as const) test(`POLICY-10 ${phase} waits on policy row then rejects expired session before effect`, async () => {
  const f = await fixture(), s = service(), lock = await pool.connect(); let pending: Promise<unknown> | undefined;
  try {
    await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '250 milliseconds' WHERE token_hash=$1", [f.actor.session_hash]);
    await lock.query('BEGIN'); await lock.query('SELECT scope_id FROM private_work_persistence_policy WHERE scope_id=$1 FOR UPDATE', [f.context.scope.scope_id]);
    pending = phase === 'create' ? commands.create(f.actor, workInput()) : phase === 'result-read' ? s.api.readCurrent(f.actor, { workId: f.workId })
      : s.api.prepare(f.actor, { key: randomUUID(), targetWorkId: f.workId, expectedVersion: '1', contentType: 'text/plain', byteSize: 1, sha256: 'a'.repeat(64) });
    void pending.catch(() => {}); await blockedBy(lock); await expired(f.actor); await lock.query('COMMIT');
    await assert.rejects(pending, status(401)); assert.equal(s.store.gets, 0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM assets WHERE scope_id=$1', [f.context.scope.scope_id])).rows[0].n, 0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM work_items WHERE owner_ref=$1', [f.actor.user_id])).rows[0].n, 1);
  } finally { await lock.query('ROLLBACK'); lock.release(); await pending?.catch(() => {}); }
});
test('POLICY-11 policy SHARE is held until service transaction ends; operator update waits', async () => {
  const f = await fixture(), lock = await pool.connect(); let pending: Promise<unknown> | undefined;
  try {
    await lock.query('BEGIN'); const context = await lockMemberScope(lock, { actor: f.actor, scope: 'personal' });
    await resolvePrivateWorkPersistencePolicy(lock, context);
    pending = change(f, false); void pending.catch(() => {}); await blockedBy(lock);
    await lock.query('COMMIT'); await pending;
    await assert.rejects(commands.create(f.actor, workInput()), status(503));
  } finally { await lock.query('ROLLBACK'); lock.release(); await pending?.catch(() => {}); }
});
test('POLICY-12 read-only runtime policy grant permits SELECT but denies INSERT/UPDATE/DELETE/TRUNCATE', async () => {
  const f = await fixture(); await admin.query(`CREATE ROLE ${role} NOLOGIN`); roleCreated = true;
  await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`); await pool.query(`GRANT SELECT ON private_work_persistence_policy TO ${role}`);
  const q = await pool.connect();
  try {
    await q.query(`SET ROLE ${role}`); assert((await q.query('SELECT 1 FROM private_work_persistence_policy WHERE scope_id=$1', [f.context.scope.scope_id])).rowCount);
    await assert.rejects(q.query('SELECT scope_id FROM private_work_persistence_policy WHERE scope_id=$1 FOR SHARE', [f.context.scope.scope_id]), code('42501'));
    for (const sql of ['UPDATE private_work_persistence_policy SET revision=revision+1', 'DELETE FROM private_work_persistence_policy', 'TRUNCATE private_work_persistence_policy',
      "INSERT INTO private_work_persistence_policy(scope_id,owner_principal_id,purpose,revision) SELECT scope_id,owner_principal_id,purpose,1 FROM private_work_persistence_policy"])
      await assert.rejects(q.query(sql), code('42501'));
  } finally { await q.query('RESET ROLE'); q.release(); }
});
test('POLICY-15 generated-column lock privilege supports real services without allowing policy mutation', async () => {
  const f = await fixture();
  // Synthetic runtime role mirrors existing ordinary-table DML, then removes
  // all policy DML. Only the generated constant gets column-level UPDATE.
  await pool.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
  await pool.query(`REVOKE ALL ON private_work_persistence_policy FROM ${role}`);
  await pool.query(`GRANT SELECT,UPDATE(scope_kind) ON private_work_persistence_policy TO ${role}`);
  const runtime = new Pool({ connectionString, options: `-c search_path=${schema} -c role=${role} -c statement_timeout=10000`, max: 4 });
  try {
    const policy = await withMemberScope(runtime, { actor: f.actor, scope: 'personal' }, async () => {}, resolvePrivateWorkPersistencePolicy);
    assert.equal(policy.revision, 'private-work.v1');
    const work = await createPrivateWorkCommands(runtime, { resolvePolicy: resolvePrivateWorkPersistencePolicy }).create(f.actor, workInput());
    assert.equal(await createPrivateResultService(runtime, { store: new Store(), resolvePolicy: resolvePrivateWorkPersistencePolicy }).readCurrent(f.actor, { workId: work.workId }), null);
    const before = (await runtime.query('SELECT * FROM private_work_persistence_policy WHERE scope_id=$1', [f.context.scope.scope_id])).rows[0];
    await runtime.query('UPDATE private_work_persistence_policy SET scope_kind=DEFAULT WHERE scope_id=$1', [f.context.scope.scope_id]);
    assert.deepEqual((await runtime.query('SELECT * FROM private_work_persistence_policy WHERE scope_id=$1', [f.context.scope.scope_id])).rows[0], before);
    for (const assignment of ['persistence_allowed=false', 'retained_byte_limit=524288', 'revision=revision+1', 'scope_id=scope_id',
      'purpose=purpose', 'owner_principal_id=owner_principal_id', 'created_at=created_at', 'updated_at=updated_at', 'scope_kind=DEFAULT,persistence_allowed=false'])
      await assert.rejects(runtime.query(`UPDATE private_work_persistence_policy SET ${assignment} WHERE scope_id=$1`, [f.context.scope.scope_id]), code('42501'));
    await assert.rejects(runtime.query("UPDATE private_work_persistence_policy SET scope_kind='community' WHERE scope_id=$1", [f.context.scope.scope_id]), code('428C9'));
    for (const sql of ['DELETE FROM private_work_persistence_policy', 'TRUNCATE private_work_persistence_policy',
      "INSERT INTO private_work_persistence_policy(scope_id,owner_principal_id,purpose,revision) SELECT scope_id,owner_principal_id,purpose,1 FROM private_work_persistence_policy"])
      await assert.rejects(runtime.query(sql), code('42501'));
    const privileges = (await runtime.query(`SELECT has_table_privilege(current_user,'private_work_persistence_policy','UPDATE') full_update,
      has_column_privilege(current_user,'private_work_persistence_policy','scope_kind','UPDATE') lock_update,
      has_column_privilege(current_user,'private_work_persistence_policy','revision','UPDATE') revision_update`)).rows[0];
    assert.deepEqual(privileges, { full_update: false, lock_update: true, revision_update: false });
  } finally { await runtime.end(); }
});
test('POLICY-13 update success replay consults current policy but archive still succeeds', async () => {
  const f = await fixture(), edit = { ...workInput(), workId: f.workId, expectedVersion: '1' };
  const updated = await commands.update(f.actor, edit); assert.equal(updated.aggregateVersion, '2');
  await change(f, false);
  await assert.rejects(commands.update(f.actor, edit), status(503));
  assert.equal((await commands.archive(f.actor, { key: randomUUID(), workId: f.workId, expectedVersion: '2' })).state, 'archived');
});
test('POLICY-14 database source errors remain sanitized and do not affect archive control', async () => {
  const f = await fixture(); let called = 0;
  const unavailable = createPrivateWorkCommands(pool, { resolvePolicy: async () => { called++; throw new Error('synthetic unavailable source'); } });
  const q = await pool.connect();
  try {
    await q.query('BEGIN'); const context = await lockMemberScope(q, { actor: f.actor, scope: 'personal' });
    await q.query(`SET LOCAL search_path=pg_catalog`);
    await assert.rejects(resolvePrivateWorkPersistencePolicy(q, context), error => {
      assert.equal((error as Error).message, '私人內容政策暫時無法使用。'); return status(503)(error);
    });
  } finally { await q.query('ROLLBACK'); q.release(); }
  // The archive path does not invoke even an unavailable resolver.
  assert.equal((await unavailable.archive(f.actor, { key: randomUUID(), workId: f.workId, expectedVersion: '1' })).state, 'archived');
  assert.equal(called, 0);
});
