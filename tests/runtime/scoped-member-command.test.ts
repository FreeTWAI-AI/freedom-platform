import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import { scopedMemberCommand, scopedJournal, type ScopedMemberCommand } from '../../packages/scoped-commands/index.js';
import { withMemberScope, type MemberScopeContext } from '../../packages/resource-scopes/index.js';
import { command, checkVersion, digest } from '../../packages/db/index.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import type { Actor } from '../../modules/identity-membership/service.js';
import { migrate } from '../../scripts/database.js';

// Explicit disposable target only. Never silently fall back to the local DB.
const connectionString = process.env.TEST_DATABASE_URL;
assert(connectionString, 'TEST_DATABASE_URL is required for scoped command tests');
assert.match(new URL(connectionString).pathname, /^\/fp_[a-z0-9_]+$/);
const schema = `fp_scoped_command_${process.pid}_${Date.now()}`;
const admin = new Pool({ connectionString, max: 3 });
const pool = new Pool({ connectionString, options: `-c search_path=${schema} -c statement_timeout=10000`, max: 12 });
let created = false;
const community = '10000000-0000-4000-8000-000000000001';
const target = '30000000-0000-4000-8000-000000000001';
const operation = 'fixture.resource.update';
before(async () => {
  assert.match(schema, /^fp_scoped_command_[0-9]+_[0-9]+$/);
  await admin.query(`CREATE SCHEMA ${schema}`); created = true; await migrate(pool);
  await pool.query(`CREATE TABLE fp_scoped_effects(scope_id uuid NOT NULL REFERENCES resource_scopes,
    target_id uuid NOT NULL, version bigint NOT NULL DEFAULT 1, allowed boolean NOT NULL DEFAULT true, PRIMARY KEY(scope_id,target_id))`);
});
after(async () => { await pool.end(); if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(async () => {
  await pool.query('TRUNCATE communities CASCADE');
  await pool.query('INSERT INTO communities VALUES($1,$2)', [community, 'Synthetic scoped command']);
});
async function member(): Promise<Actor> {
  const id = randomUUID();
  const row = (await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic','not-a-login-hash',$4) RETURNING *`, [id, community, id + '@example.invalid', randomUUID()])).rows[0];
  return session(row as Actor);
}
async function session(owner: Actor): Promise<Actor> {
  const session_hash = randomUUID();
  await pool.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',now()+interval '1 hour')", [session_hash, owner.user_id]);
  return { ...owner, session_hash, csrf_token: 'synthetic' };
}
const inspect = (actor: Actor, scope: 'personal' | 'community' = 'personal') =>
  withMemberScope(pool, { actor, scope }, async () => {}, async (_q, context) => context);
async function setup(actor: Actor, scope: 'personal' | 'community' = 'personal') {
  const context = await inspect(actor, scope);
  await pool.query('INSERT INTO fp_scoped_effects(scope_id,target_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [context.scope.scope_id, target]);
  return context;
}
const request = (actor: Actor, overrides: Partial<ScopedMemberCommand> = {}): ScopedMemberCommand => ({
  actor, scope: 'personal', operation, key: 'fixture-key-001', body: { change: 'metadata-only' },
  target: { kind: 'fixture_resource', id: target }, expected: '1', ...overrides,
});
async function authorize(q: PoolClient, context: MemberScopeContext) {
  const row = (await q.query('SELECT allowed FROM fp_scoped_effects WHERE scope_id=$1 AND target_id=$2 FOR UPDATE', [context.scope.scope_id, target])).rows[0];
  requireCondition(row?.allowed, 403, 'fixture_access_revoked', 'Synthetic access revoked.');
}
async function mutate(q: PoolClient, context: MemberScopeContext, expected = '1', op = operation) {
  const row = (await q.query('SELECT version FROM fp_scoped_effects WHERE scope_id=$1 AND target_id=$2 FOR UPDATE', [context.scope.scope_id, target])).rows[0];
  checkVersion(row.version, expected);
  const version = (await q.query('UPDATE fp_scoped_effects SET version=version+1 WHERE scope_id=$1 AND target_id=$2 RETURNING version', [context.scope.scope_id, target])).rows[0].version;
  await scopedJournal(q, context, { aggregate_type: 'fixture_resource', id: target, version, operation: op,
    data: { content_sha256: 'a'.repeat(64) }, eventType: 'fixture.resource.changed.v1' });
  return { version, scope: context.scope };
}
const invoke = (actor: Actor, overrides: Partial<ScopedMemberCommand> = {}) => {
  const input = request(actor, overrides);
  return scopedMemberCommand(pool, input, authorize, (q, context) => mutate(q, context, input.expected, input.operation));
};
const problem = (status: number, code: string) => (error: unknown) => error instanceof Problem && error.status === status && error.code === code;
const sqlCode = (code: string) => (error: unknown) => (error as {code: string})?.code === code;
const barrier = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
async function blockedBy(pid: number) {
  for (let i = 0; i < 100; i++) {
    if ((await admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS yes', [pid])).rows[0].yes) return;
    await delay(10);
  }
  assert.fail('Actual PostgreSQL lock wait was not observed');
}
async function counts() {
  return (await pool.query(`SELECT (SELECT count(*)::int FROM scoped_command_receipts) receipts,
    (SELECT count(*)::int FROM scoped_transition_journal) journals,(SELECT count(*)::int FROM scoped_outbox) events,
    (SELECT count(*)::int FROM outbox) legacy_events,(SELECT count(*)::int FROM command_receipts) legacy_receipts,
    (SELECT COALESCE(sum(version-1),0)::int FROM fp_scoped_effects) effects`)).rows[0];
}
const empty = { receipts: 0, journals: 0, events: 0, legacy_events: 0, legacy_receipts: 0, effects: 0 };

test('CORE2-01 typed namespace, stable replay and separate scoped facts preserve legacy bytes', async () => {
  const owner = await member(), context = await setup(owner), input = request(owner);
  const first = await invoke(owner), replay = await invoke(owner, { scope: context.scope });
  assert.deepEqual(first, replay); assert.equal(first.version, '2');
  assert(Object.isFrozen(first) && Object.isFrozen(first.scope) && Object.isFrozen(replay) && Object.isFrozen(replay.scope));
  const receipt = (await pool.query('SELECT * FROM scoped_command_receipts')).rows[0];
  assert.equal(receipt.principal_id, context.subject_principal.principal_id); assert.equal(receipt.authn_kind, 'member_session');
  assert.equal(receipt.request_sha256, digest({ profile: 'freedom.scoped-member-command/v1', scope: context.scope,
    target: input.target, expected: '1', body: input.body }));
  assert.notEqual(receipt.principal_id, owner.user_id);
  const payload = (await pool.query('SELECT payload FROM scoped_outbox')).rows[0].payload;
  assert.deepEqual(payload.scope, context.scope); assert(!('community_id' in payload));
  assert(!JSON.stringify(receipt).includes('metadata-only') && !JSON.stringify(payload).includes('metadata-only'));
  assert.deepEqual(await counts(), { ...empty, receipts: 1, journals: 1, events: 1, effects: 1 });
  const legacy = await command(pool, { actor: owner, operation, key: input.key, body: input.body }, async () => {}, async () => ({ legacy: true }));
  assert.deepEqual(legacy, { legacy: true });
  assert.equal((await pool.query('SELECT request_sha256 FROM command_receipts')).rows[0].request_sha256,
    digest({ body: input.body, expected: null }));
});

test('CORE2-02 personal/community and other principals have independent namespaces', async () => {
  const a = await member(), b = await member();
  await setup(a); await setup(a, 'community'); await setup(b);
  await invoke(a); await invoke(a, { scope: 'community' }); await invoke(b);
  assert.deepEqual(await counts(), { ...empty, receipts: 3, journals: 3, events: 3, effects: 3 });
  const privateA = await inspect(a);
  await assert.rejects(invoke(b, { scope: privateA.scope }), problem(404, 'resource_not_found'));
});

for (const changed of ['body', 'expected', 'target-id', 'target-kind'] as const) test(`CORE2-03 changed ${changed} cannot replay a prior receipt`, async () => {
  const owner = await member(); await setup(owner); await invoke(owner);
  const override = changed === 'body' ? { body: { changed: true } } : changed === 'expected' ? { expected: '2' }
    : { target: { kind: changed === 'target-kind' ? 'another_resource' : 'fixture_resource', id: changed === 'target-id' ? randomUUID() : target } };
  await assert.rejects(invoke(owner, override), problem(409, 'idempotency_conflict'));
  assert.equal((await counts()).effects, 1);
});

for (const revocation of ['session', 'expired-session', 'user', 'principal', 'scope', 'domain'] as const) test(`CORE2-04 current ${revocation} authority is required even on replay`, async () => {
  const owner = await member(), context = await setup(owner); await invoke(owner);
  if (revocation === 'session') await pool.query('UPDATE sessions SET revoked_at=now()');
  if (revocation === 'expired-session') await pool.query("UPDATE sessions SET expires_at=now()-interval '1 second'");
  if (revocation === 'user') await pool.query('UPDATE users SET active=false');
  if (revocation === 'principal') await pool.query("UPDATE principals SET status='disabled' WHERE principal_id=$1", [context.subject_principal.principal_id]);
  if (revocation === 'scope') await pool.query("UPDATE resource_scopes SET status='disabled' WHERE scope_id=$1", [context.scope.scope_id]);
  if (revocation === 'domain') await pool.query('UPDATE fp_scoped_effects SET allowed=false');
  await assert.rejects(invoke(owner), problem(['session', 'expired-session', 'user'].includes(revocation) ? 401 : 403,
    ['session', 'expired-session', 'user'].includes(revocation) ? 'session_expired' : revocation === 'domain' ? 'fixture_access_revoked' : revocation + '_disabled'));
  assert.equal((await counts()).effects, 1);
});

test('CORE2-05 equal requests from two sessions serialize to one effect at a real lock barrier', async () => {
  const a = await member(), b = await session(a); await setup(a);
  const entered = barrier(), release = barrier(); let pid = 0;
  const first = scopedMemberCommand(pool, request(a), authorize, async (q, context) => {
    pid = (await q.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; entered.release(); await release.promise;
    return mutate(q, context);
  });
  await entered.promise; const second = invoke(b);
  try { await blockedBy(pid); } finally { release.release(); }
  assert.deepEqual(await first, await second);
  assert.deepEqual(await counts(), { ...empty, receipts: 1, journals: 1, events: 1, effects: 1 });
});

test('CORE2-06 concurrent different payloads yield one effect and one 409', async () => {
  const a = await member(), b = await session(a); await setup(a);
  const results = await Promise.allSettled([invoke(a), invoke(b, { body: { other: true } })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected'); assert(rejected?.status === 'rejected');
  assert(problem(409, 'idempotency_conflict')(rejected.reason)); assert.equal((await counts()).effects, 1);
});

for (const table of ['principals', 'resource_scopes'] as const) test(`CORE2-07 ${table} revocation winning its lock rejects the waiting command`, async () => {
  const owner = await member(), context = await setup(owner), revoker = await pool.connect();
  const column = table === 'principals' ? 'principal_id' : 'scope_id';
  const id = table === 'principals' ? context.subject_principal.principal_id : context.scope.scope_id;
  try {
    await revoker.query('BEGIN');
    const pid = (await revoker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await revoker.query(`UPDATE ${table} SET status='disabled' WHERE ${column}=$1`, [id]);
    const pending = assert.rejects(invoke(owner), problem(403, table === 'principals' ? 'principal_disabled' : 'scope_disabled'));
    try { await blockedBy(pid); await revoker.query('COMMIT'); } finally { await revoker.query('ROLLBACK'); }
    await pending; assert.deepEqual(await counts(), empty);
  } finally { revoker.release(); }
});

test('CORE2-08 already-authorized command commits before waiting scope revocation; replay then denies', async () => {
  const owner = await member(), context = await setup(owner), entered = barrier(), release = barrier(); let pid = 0;
  const running = scopedMemberCommand(pool, request(owner), authorize, async (q, ctx) => {
    pid = (await q.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; entered.release(); await release.promise; return mutate(q, ctx);
  });
  await entered.promise;
  const revoke = pool.query("UPDATE resource_scopes SET status='disabled' WHERE scope_id=$1", [context.scope.scope_id]);
  try { await blockedBy(pid); } finally { release.release(); }
  await running; await revoke;
  await assert.rejects(invoke(owner), problem(403, 'scope_disabled')); assert.equal((await counts()).effects, 1);
});

for (const table of ['scoped_command_receipts', 'scoped_transition_journal', 'scoped_outbox']) test(`CORE2-09 ${table} failure rolls back domain and all facts`, async () => {
  const owner = await member(); await setup(owner);
  await pool.query("CREATE FUNCTION fp_reject_scoped_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic insert failure'; END $$");
  await pool.query(`CREATE TRIGGER fp_reject_scoped_insert BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fp_reject_scoped_insert()`);
  try { await assert.rejects(invoke(owner), /synthetic insert failure/); assert.deepEqual(await counts(), empty); }
  finally { await pool.query(`DROP TRIGGER fp_reject_scoped_insert ON ${table}`); await pool.query('DROP FUNCTION fp_reject_scoped_insert()'); }
});

test('CORE2-10 invalid/machine input and unsafe JSON never reach auth or persist; bad response rolls back', async () => {
  const owner = await member(); await setup(owner); let called = false;
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  for (const body of [undefined, NaN, Infinity, 2n, new Date(), { missing: undefined }, cyclic, '\ud800', '\u0000', 'x'.repeat(256 * 1024 + 1),
    Object.defineProperty({}, 'secret', { enumerable: true, get() { throw new Error('Must not invoke getter'); } })]) {
    await assert.rejects(scopedMemberCommand(pool, request(owner, { body }), async () => { called = true; }, async () => null), problem(400, 'invalid_command_json'));
  }
  await assert.rejects(scopedMemberCommand(pool, { ...request(owner), authn_kind: 'service' } as ScopedMemberCommand, authorize, async () => null), problem(400, 'invalid_scoped_command'));
  await assert.rejects(invoke(owner, { scope: { scope_id: randomUUID(), kind: 'site' } }), problem(403, 'scope_kind_unavailable'));
  assert.equal(called, false); assert.deepEqual(await counts(), empty);
  await assert.rejects(scopedMemberCommand(pool, request(owner), authorize, async (q, context) => {
    await mutate(q, context); return { forbidden: undefined };
  }), problem(400, 'invalid_command_json'));
  assert.deepEqual(await counts(), empty);
});

test('CORE2-11 namespace and digest snapshot survive mutation while authorization is suspended', async () => {
  const owner = await member(); await setup(owner);
  const input = request(owner), entered = barrier(), release = barrier();
  const pending = scopedMemberCommand(pool, input, async (q, context) => { await authorize(q, context); entered.release(); await release.promise; }, mutate);
  await entered.promise;
  input.key = 'changed-key-001'; input.operation = 'changed.operation'; input.target.id = randomUUID();
  (input.body as {change: string}).change = 'changed'; input.actor.session_hash = 'changed'; release.release();
  await pending;
  const fresh = await session(owner);
  assert.equal((await invoke(fresh)).version, '2'); assert.equal((await counts()).effects, 1);
});

test('CORE2-12 scoped journal rejects copied/expired/wrong-client contexts and leaves no legacy fanout', async () => {
  const owner = await member(), readContext = await setup(owner);
  const q = await pool.connect();
  const event = { aggregate_type: 'fixture_resource', id: target, version: '2', operation, data: {} };
  try { await assert.rejects(scopedJournal(q, readContext, event), problem(403, 'scoped_context_required')); } finally { q.release(); }
  let leaked!: MemberScopeContext;
  await scopedMemberCommand(pool, request(owner), authorize, async (q, context) => {
    leaked = context;
    await assert.rejects(scopedJournal(q, { ...context }, event), problem(403, 'scoped_context_required'));
    const other = await pool.connect();
    try { await assert.rejects(scopedJournal(other, context, event), problem(403, 'scoped_context_required')); } finally { other.release(); }
    await assert.rejects(scopedJournal(q, context, { ...event, operation: 'another.operation' }), problem(400, 'journal_operation_mismatch'));
    return mutate(q, context);
  });
  const outside = await pool.connect();
  try { await assert.rejects(scopedJournal(outside, leaked, event), problem(403, 'scoped_context_required')); } finally { outside.release(); }
  assert.equal((await counts()).legacy_events, 0);
});

test('CORE2-13 SQL refuses foreign personal owner, wrong scope kind, machine auth, rebinding and fact deletion', async () => {
  const a = await member(), b = await member(), ca = await setup(a), cb = await setup(b); await invoke(a);
  for (const [column, value, code] of [['principal_id', cb.subject_principal.principal_id, '23503'], ['scope_kind', 'community', '23503'],
    ['authn_kind', 'execution', '23514'], ['principal_kind', 'service', '23514']] as const) {
    const columns = ['principal_id', 'principal_kind', 'authn_kind', 'scope_id', 'scope_kind', 'operation', 'idempotency_key', 'target_kind', 'target_id', 'request_sha256', 'response'];
    const selections = columns.map(name => name === column ? '$1' : name === 'idempotency_key' ? "'another-key-001'" : name);
    await assert.rejects(pool.query(`INSERT INTO scoped_command_receipts(${columns.join(',')}) SELECT ${selections.join(',')} FROM scoped_command_receipts`, [value]), sqlCode(code));
  }
  for (const table of ['scoped_command_receipts', 'scoped_transition_journal', 'scoped_outbox']) {
    await assert.rejects(pool.query(`UPDATE ${table} SET scope_id=$1`, [cb.scope.scope_id]), sqlCode('23514'));
    await assert.rejects(pool.query(`DELETE FROM ${table}`), sqlCode('23514'));
  }
  await scopedMemberCommand(pool, request(b), authorize, async (q, context) => {
    await scopedJournal(q, context, { aggregate_type: 'fixture_resource', id: target, version: '3', operation }); return {};
  });
  const transition = (await pool.query('SELECT transition_id FROM scoped_transition_journal WHERE scope_id=$1', [cb.scope.scope_id])).rows[0].transition_id;
  await assert.rejects(pool.query(`INSERT INTO scoped_outbox(event_id,transition_id,scope_id,scope_kind,event_type,payload)
    VALUES($1,$2,$3,'personal','fixture.bad','{}')`, [randomUUID(), transition, ca.scope.scope_id]), sqlCode('23503'));
});

for (const replay of [false, true]) test(`CORE2-14 expiry during a real domain-lock wait rejects ${replay ? 'replay' : 'new effect'}`, async () => {
  const owner = await member(), context = await setup(owner);
  if (replay) await invoke(owner);
  const blocker = await pool.connect();
  try {
    await blocker.query('BEGIN');
    const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await blocker.query('SELECT version FROM fp_scoped_effects WHERE scope_id=$1 FOR UPDATE', [context.scope.scope_id]);
    // Set expiry before the command locks the session. Expiry must advance on
    // PostgreSQL's real clock even though transaction now() stays at BEGIN.
    await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '400 milliseconds' WHERE token_hash=$1", [owner.session_hash]);
    const denied = assert.rejects(invoke(owner), problem(401, 'session_expired'));
    try {
      await blockedBy(pid);
      let expired = false;
      for (let i = 0; i < 150; i++) {
        expired = (await admin.query(`SELECT expires_at<=clock_timestamp() expired FROM ${schema}.sessions WHERE token_hash=$1`, [owner.session_hash])).rows[0].expired;
        if (expired) break;
        await delay(10);
      }
      assert(expired, 'Database clock must confirm expiry before releasing the domain lock');
      await blocker.query('COMMIT');
    } finally { await blocker.query('ROLLBACK'); }
    await denied;
    assert.deepEqual(await counts(), replay ? { ...empty, receipts: 1, journals: 1, events: 1, effects: 1 } : empty);
  } finally { blocker.release(); }
});

test('CORE2-15 domain version checks retain 428/412 without creating successful receipts', async () => {
  const owner = await member(); await setup(owner);
  await assert.rejects(scopedMemberCommand(pool, request(owner, { expected: undefined }), authorize,
    async () => { checkVersion('1', undefined); return {}; }), problem(428, 'version_required'));
  await assert.rejects(invoke(owner, { expected: '2' }), problem(412, 'version_conflict'));
  assert.deepEqual(await counts(), empty);
});

test('CORE2-16 DML-only runtime can use scoped commands but cannot rebind immutable receipts', async () => {
  const owner = await member(); await setup(owner);
  const role = `fp_scoped_runtime_${process.pid}_${Date.now()}`;
  const runtime = new Pool({ connectionString, options: `-c search_path=${schema} -c role=${role} -c statement_timeout=10000`, max: 2 });
  let roleCreated = false;
  try {
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`); roleCreated = true;
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
    await admin.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);
    const permissions = (await runtime.query('SELECT rolsuper,rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows[0];
    assert.equal(permissions.rolsuper, false); assert.equal(permissions.rolcreaterole, false);
    const first = await scopedMemberCommand(runtime, request(owner), authorize, mutate);
    assert.deepEqual(await scopedMemberCommand(runtime, request(owner), authorize, mutate), first);
    await assert.rejects(runtime.query("UPDATE scoped_command_receipts SET response='{}'"), sqlCode('23514'));
  } finally {
    await runtime.end();
    if (roleCreated) { await admin.query(`DROP OWNED BY ${role}`); await admin.query(`DROP ROLE ${role}`); }
  }
});
