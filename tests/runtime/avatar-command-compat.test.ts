import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import { avatarMemberCommand, scopedJournal } from '../../packages/scoped-commands/index.js';
import { withMemberScope, type MemberScopeContext } from '../../packages/resource-scopes/index.js';
import { command, checkVersion, digest, type Command } from '../../packages/db/index.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import type { Actor } from '../../modules/identity-membership/service.js';
import { migrate } from '../../scripts/database.js';

const connectionString = process.env.TEST_DATABASE_URL;
assert(connectionString, 'Explicit disposable TEST_DATABASE_URL required');
assert.match(new URL(connectionString).pathname, /^\/fp_[a-z0-9_]+$/);
const schema = `fp_avatar_command_${process.pid}_${Date.now()}`;
const admin = new Pool({ connectionString, max: 3 });
const pool = new Pool({ connectionString, options: `-c search_path=${schema} -c statement_timeout=10000`, max: 10 });
const community = '10000000-0000-4000-8000-000000000001';
const operation = 'POST /api/v1/me/avatar', journalOperation = 'member.avatar.replace';
let created = false;
before(async () => {
  assert.match(schema, /^fp_avatar_command_[0-9]+_[0-9]+$/);
  await admin.query(`CREATE SCHEMA ${schema}`); created = true; await migrate(pool);
  await pool.query("UPDATE avatar_storage_policy SET mode='bridge'");
});
after(async () => { await pool.end(); if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(async () => {
  await pool.query('TRUNCATE communities CASCADE');
  await pool.query('INSERT INTO communities VALUES($1,$2)', [community, 'Synthetic avatar compatibility']);
});
async function member(): Promise<Actor> {
  const id = randomUUID();
  const row = (await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic','not-a-login-hash',$4) RETURNING *`, [id, community, id + '@example.invalid', randomUUID()])).rows[0];
  await pool.query('INSERT INTO member_avatars(user_id,community_id) VALUES($1,$2)', [id, community]);
  return session(row as Actor);
}
async function session(owner: Actor): Promise<Actor> {
  const session_hash = randomUUID();
  await pool.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',now()+interval '1 hour')", [session_hash, owner.user_id]);
  return { ...owner, session_hash, csrf_token: 'synthetic' };
}
const request = (actor: Actor, changes: Partial<Command> = {}): Command => ({ actor, operation,
  key: 'avatar-fixture-001', body: { content_type: 'image/png', sha256: 'a'.repeat(64) }, expected: '1', ...changes });
const problem = (status: number, code: string) => (error: unknown) => error instanceof Problem && error.status === status && error.code === code;
const barrier = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
async function blockedBy(pid: number) {
  for (let i = 0; i < 150; i++) {
    if ((await admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS yes', [pid])).rows[0].yes) return;
    await delay(10);
  }
  assert.fail('Expected real PostgreSQL lock wait');
}
const contextFor = (actor: Actor) => withMemberScope(pool, { actor, scope: 'personal' }, async () => {}, async (_q, context) => context);
async function authorize(q: PoolClient, actor: Actor) {
  const row = (await q.query(`SELECT 1 FROM users WHERE user_id=$1 AND community_id=$2
    AND active AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL)`, [actor.user_id, actor.community_id])).rows[0];
  requireCondition(row, 403, 'onboarding_required', 'Synthetic current eligibility required.');
}
const response = (actor: Actor, version: string) => ({ avatar_url: `/api/v1/members/${actor.user_id}/avatar?v=${version}`, aggregate_version: version });
async function oldMutation(q: PoolClient, actor: Actor, expected = '1') {
  const row = (await q.query('SELECT aggregate_version FROM member_avatars WHERE user_id=$1 FOR UPDATE', [actor.user_id])).rows[0];
  checkVersion(row.aggregate_version, expected);
  const version = (await q.query('UPDATE member_avatars SET aggregate_version=aggregate_version+1 WHERE user_id=$1 RETURNING aggregate_version', [actor.user_id])).rows[0].aggregate_version;
  return response(actor, version);
}
async function replacement(q: PoolClient, context: MemberScopeContext, actor: Actor, expected?: string) {
  const row = (await q.query('SELECT aggregate_version FROM member_avatars WHERE user_id=$1 FOR UPDATE', [actor.user_id])).rows[0];
  checkVersion(row.aggregate_version, expected);
  // Synthetic already-verified object metadata, no provider or raw-byte I/O.
  const assetId = randomUUID(), representation = randomUUID();
  await q.query(`INSERT INTO assets(asset_id,scope_id,owner_principal_id,owner_user_id,policy_revision,representation_id)
    VALUES($1,$2,$3,$4,'fixture1',$5)`, [assetId, context.scope.scope_id, context.subject_principal.principal_id, actor.user_id, representation]);
  await q.query(`INSERT INTO asset_objects(asset_id,scope_id,representation_id,content_type,byte_size,content_sha256,transform_version,policy_revision)
    VALUES($1,$2,$3,'image/webp',1,$4,'avatar.webp.v1','fixture1')`, [assetId, context.scope.scope_id, representation, 'b'.repeat(64)]);
  await q.query("UPDATE assets SET state='ready',ready_at=clock_timestamp() WHERE asset_id=$1", [assetId]);
  const version = (await q.query(`UPDATE member_avatars SET storage_source='asset',aggregate_version=aggregate_version+1
    WHERE user_id=$1 RETURNING aggregate_version`, [actor.user_id])).rows[0].aggregate_version;
  await q.query(`INSERT INTO member_avatar_asset_targets(user_id,scope_id,owner_principal_id,asset_id,linked_at_version)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id) DO UPDATE SET asset_id=EXCLUDED.asset_id,linked_at_version=EXCLUDED.linked_at_version`,
  [actor.user_id, context.scope.scope_id, context.subject_principal.principal_id, assetId, version]);
  await scopedJournal(q, context, { aggregate_type: 'member_avatar', id: actor.user_id, version,
    operation: journalOperation, data: { asset_id: assetId }, eventType: 'freedom.member.avatar.replaced.v1' });
  return response(actor, version);
}
const invoke = (actor: Actor, changes: Partial<Command> = {}) => {
  const input = request(actor, changes);
  return avatarMemberCommand(pool, input, q => authorize(q, actor), (q, context) => replacement(q, context, actor, input.expected));
};
const legacy = (actor: Actor, changes: Partial<Command> = {}) => {
  const input = request(actor, changes);
  return command(pool, input, q => authorize(q, actor), q => oldMutation(q, actor, input.expected));
};
async function counts() {
  return (await pool.query(`SELECT (SELECT count(*)::int FROM command_receipts) receipts,
    (SELECT count(*)::int FROM scoped_command_receipts) scoped_receipts,
    (SELECT count(*)::int FROM scoped_transition_journal) journals,(SELECT count(*)::int FROM scoped_outbox) events,
    (SELECT count(*)::int FROM outbox) legacy_events,(SELECT count(*)::int FROM assets) assets,
    (SELECT count(*)::int FROM member_avatar_asset_targets) pointers,
    (SELECT COALESCE(sum(aggregate_version-1),0)::int FROM member_avatars) effects`)).rows[0];
}
const empty = { receipts: 0, scoped_receipts: 0, journals: 0, events: 0, legacy_events: 0, assets: 0, pointers: 0, effects: 0 };
const changed = { ...empty, receipts: 1, journals: 1, events: 1, assets: 1, pointers: 1, effects: 1 };

test('avatar compatibility atomically commits real version/pointer/scoped facts and original receipt', async () => {
  const actor = await member(), input = request(actor), first = await invoke(actor);
  assert.deepEqual(first, response(actor, '2')); assert(Object.isFrozen(first));
  assert.deepEqual(await invoke(actor), first); assert.deepEqual(await legacy(actor), first);
  assert.deepEqual(await counts(), changed);
  const receipt = (await pool.query('SELECT * FROM command_receipts')).rows[0];
  assert.equal(receipt.operation, operation); assert.equal(receipt.user_id, actor.user_id);
  assert.equal(receipt.request_sha256, digest({ body: input.body, expected: '1' }));
  const fact = (await pool.query('SELECT * FROM scoped_transition_journal')).rows[0];
  assert.equal(fact.aggregate_id, actor.user_id); assert.equal(fact.aggregate_version, '2'); assert.equal(fact.operation, journalOperation);
  const pointer = (await pool.query('SELECT * FROM member_avatar_asset_targets')).rows[0];
  assert.equal(pointer.linked_at_version, '2'); assert.equal(pointer.asset_id, fact.data.asset_id);
});

test('old success lazily maps first use, replays without domain run and survives later pointer changes', async () => {
  const actor = await member(), old = await legacy(actor);
  assert.equal((await pool.query('SELECT count(*)::int n FROM principals')).rows[0].n, 0);
  const probe = () => avatarMemberCommand(pool, request(actor), q => authorize(q, actor), async () => assert.fail('Replay must not execute new pipeline'));
  assert.deepEqual(await probe(), old);
  assert.equal((await pool.query('SELECT count(*)::int n FROM principals')).rows[0].n, 1);
  await invoke(actor, { key: 'avatar-fixture-002', expected: '2' });
  assert.deepEqual(await probe(), old); assert.equal((await counts()).effects, 2);
});

test('early miss sentinel rolls back mappings and never becomes a success receipt', async () => {
  const actor = await member(), miss = Object.freeze({ privateProbeMiss: true });
  await assert.rejects(avatarMemberCommand(pool, request(actor), q => authorize(q, actor), async () => { throw miss; }), error => error === miss);
  assert.deepEqual(await counts(), empty);
  assert.equal((await pool.query('SELECT count(*)::int n FROM principals')).rows[0].n, 0);
  assert.equal((await invoke(actor)).aggregate_version, '2');
});

for (const kind of ['session', 'expired', 'user', 'principal', 'scope', 'domain']) test(`old receipt cannot bypass current ${kind}`, async () => {
  const actor = await member(); await legacy(actor); const context = await contextFor(actor);
  if (kind === 'session') await pool.query('UPDATE sessions SET revoked_at=now()');
  if (kind === 'expired') await pool.query("UPDATE sessions SET expires_at=now()-interval '1 second'");
  if (kind === 'user') await pool.query('UPDATE users SET active=false');
  if (kind === 'principal') await pool.query("UPDATE principals SET status='disabled'");
  if (kind === 'scope') await pool.query("UPDATE resource_scopes SET status='disabled' WHERE scope_id=$1", [context.scope.scope_id]);
  if (kind === 'domain') await pool.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL');
  await assert.rejects(invoke(actor), problem(['session', 'expired', 'user'].includes(kind) ? 401 : 403,
    ['session', 'expired', 'user'].includes(kind) ? 'session_expired' : kind === 'domain' ? 'onboarding_required' : kind + '_disabled'));
  assert.deepEqual(await counts(), { ...empty, receipts: 1, effects: 1 });
});

for (const oldWins of [false, true]) test(`old and new adapters share a real advisory lock when ${oldWins ? 'old' : 'new'} wins`, async () => {
  const actor = await member(), otherSession = await session(actor), entered = barrier(), release = barrier(); let pid = 0;
  const first = oldWins ? command(pool, request(actor), q => authorize(q, actor), async q => {
    pid = (await q.query('SELECT pg_backend_pid() pid')).rows[0].pid; entered.release(); await release.promise; return oldMutation(q, actor);
  }) : avatarMemberCommand(pool, request(actor), q => authorize(q, actor), async (q, context) => {
    pid = (await q.query('SELECT pg_backend_pid() pid')).rows[0].pid; entered.release(); await release.promise; return replacement(q, context, actor, '1');
  });
  await entered.promise; const second = oldWins ? invoke(otherSession) : legacy(otherSession);
  try { await blockedBy(pid); } finally { release.release(); }
  assert.deepEqual(await first, await second);
  assert.deepEqual(await counts(), oldWins ? { ...empty, receipts: 1, effects: 1 } : changed);
});

test('concurrent different original digest and changed expected version remain 409 conflicts', async () => {
  const actor = await member(), other = await session(actor);
  const outcomes = await Promise.allSettled([invoke(actor), invoke(other, { body: { content_type: 'image/png', sha256: 'c'.repeat(64) } })]);
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  const denied = outcomes.find(item => item.status === 'rejected'); assert(denied?.status === 'rejected');
  assert(problem(409, 'idempotency_conflict')(denied.reason));
  await assert.rejects(invoke(actor, { expected: '2' }), problem(409, 'idempotency_conflict'));
  assert.deepEqual(await counts(), changed);
});

for (const table of ['command_receipts', 'scoped_transition_journal', 'scoped_outbox']) test(`${table} failure rolls back pointer, real version and all facts`, async () => {
  const actor = await member();
  await pool.query(`CREATE FUNCTION fp_avatar_reject() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Synthetic rejection'; END;$$`);
  await pool.query(`CREATE TRIGGER fp_avatar_reject BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fp_avatar_reject()`);
  try { await assert.rejects(invoke(actor), error => (error as {code?: string}).code === 'P0001'); }
  finally { await pool.query(`DROP TRIGGER fp_avatar_reject ON ${table}`); await pool.query('DROP FUNCTION fp_avatar_reject()'); }
  assert.deepEqual(await counts(), empty);
  assert.equal((await pool.query('SELECT storage_source FROM member_avatars')).rows[0].storage_source, 'legacy');
});

test('missing/stale real version retains 428/412 and no receipt', async () => {
  const actor = await member();
  await assert.rejects(invoke(actor, { expected: undefined }), problem(428, 'version_required'));
  await assert.rejects(invoke(actor, { expected: '2' }), problem(412, 'version_conflict'));
  assert.deepEqual(await counts(), empty);
});

test('closed avatar profile rejects foreign target, arbitrary receipt profile, operation and body shapes', async () => {
  const actor = await member(); let called = false;
  for (const change of [{ operation: 'DELETE /api/v1/me/avatar' }, { target: randomUUID() }, { scope: 'community' },
    { receiptProfile: 'legacy' }, { body: {} }, { body: { content_type: 'image/svg+xml', sha256: 'a'.repeat(64) } },
    { body: { content_type: 'image/png', sha256: 'bad' } }, { body: { content_type: 'image/png', sha256: 'a'.repeat(64), target: randomUUID() } }]) {
    await assert.rejects(avatarMemberCommand(pool, { ...request(actor), ...change }, async () => { called = true; }, async () => { called = true; }), problem(400, 'invalid_avatar_command'));
  }
  assert.equal(called, false); assert.deepEqual(await counts(), empty);
});

test('scoped journal accepts only live same-client authorized own-avatar context', async () => {
  const actor = await member(), other = await member(); let saved!: MemberScopeContext; let savedQ!: PoolClient;
  const event = { aggregate_type: 'member_avatar', id: actor.user_id, version: '1', operation: journalOperation };
  await avatarMemberCommand(pool, request(actor), async (q, context) => {
    await authorize(q, actor);
    await assert.rejects(scopedJournal(q, context, event), problem(403, 'scoped_context_required'));
  }, async (q, context) => {
    saved = context; savedQ = q;
    await assert.rejects(scopedJournal(q, { ...context }, event), problem(403, 'scoped_context_required'));
    const wrongClient = await pool.connect();
    try { await assert.rejects(scopedJournal(wrongClient, context, event), problem(403, 'scoped_context_required')); }
    finally { wrongClient.release(); }
    await assert.rejects(scopedJournal(q, context, { ...event, id: other.user_id }), problem(400, 'journal_target_mismatch'));
    await assert.rejects(scopedJournal(q, context, { ...event, aggregate_type: 'asset' }), problem(400, 'journal_target_mismatch'));
    await assert.rejects(scopedJournal(q, context, { ...event, operation: 'asset.upload.finalize' }), problem(400, 'journal_operation_mismatch'));
    return replacement(q, context, actor, '1');
  });
  await assert.rejects(scopedJournal(savedQ, saved, event), problem(403, 'scoped_context_required'));
  assert.deepEqual(await counts(), changed);
});

for (const replay of [false, true]) test(`session expires behind actual avatar authorization lock before ${replay ? 'replay' : 'effect'}`, async () => {
  const actor = await member(); await contextFor(actor); if (replay) await legacy(actor);
  const blocker = await pool.connect();
  try {
    await blocker.query('BEGIN'); const pid = (await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await blocker.query('SELECT user_id FROM member_avatars WHERE user_id=$1 FOR UPDATE', [actor.user_id]);
    await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '400 milliseconds' WHERE token_hash=$1", [actor.session_hash]);
    const denied = assert.rejects(avatarMemberCommand(pool, request(actor), async q => {
      await authorize(q, actor); await q.query('SELECT user_id FROM member_avatars WHERE user_id=$1 FOR UPDATE', [actor.user_id]);
    }, (q, context) => replacement(q, context, actor, '1')), problem(401, 'session_expired'));
    try {
      await blockedBy(pid); let expired = false;
      for (let i = 0; i < 150; i++) {
        expired = (await admin.query(`SELECT expires_at<=clock_timestamp() expired FROM ${schema}.sessions WHERE token_hash=$1`, [actor.session_hash])).rows[0].expired;
        if (expired) break; await delay(10);
      }
      assert(expired); await blocker.query('COMMIT');
    } finally { await blocker.query('ROLLBACK'); }
    await denied; assert.deepEqual(await counts(), replay ? { ...empty, receipts: 1, effects: 1 } : empty);
  } finally { blocker.release(); }
});

test('snapshot protects old request digest and response without mutating caller input', async () => {
  const actor = await member(), input = request({ ...actor }), original = digest({ body: input.body, expected: '1' });
  const entered = barrier(), release = barrier();
  const pending = avatarMemberCommand(pool, input, async q => { await authorize(q, actor); entered.release(); await release.promise; },
    (q, context) => replacement(q, context, actor, '1'));
  await entered.promise;
  (input.body as {sha256: string}).sha256 = 'f'.repeat(64); input.actor.user_id = randomUUID(); input.expected = '9'; input.key = 'changed-later-001';
  release.release(); const first = await pending;
  assert(Object.isFrozen(first));
  const receipt = (await pool.query('SELECT * FROM command_receipts')).rows[0];
  assert.equal(receipt.user_id, actor.user_id); assert.equal(receipt.idempotency_key, 'avatar-fixture-001'); assert.equal(receipt.request_sha256, original);
  assert(Object.isFrozen(await invoke(actor)));
});

test('DML-only runtime uses the closed adapter and old receipt replay without schema ownership', async () => {
  const actor = await member(), role = `fp_avatar_runtime_${process.pid}_${Date.now()}`;
  const runtime = new Pool({ connectionString, options: `-c search_path=${schema} -c role=${role} -c statement_timeout=10000`, max: 2 });
  let roleCreated = false;
  try {
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`); roleCreated = true;
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
    await admin.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);
    assert.equal((await runtime.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0].rolsuper, false);
    const first = await avatarMemberCommand(runtime, request(actor), q => authorize(q, actor), (q, context) => replacement(q, context, actor, '1'));
    const replay = await command(runtime, request(actor), q => authorize(q, actor), async () => assert.fail('Must replay original namespace'));
    assert.deepEqual(first, replay); assert.deepEqual(await counts(), changed);
  } finally {
    await runtime.end();
    if (roleCreated) { await admin.query(`DROP OWNED BY ${role}`); await admin.query(`DROP ROLE ${role}`); }
  }
});
