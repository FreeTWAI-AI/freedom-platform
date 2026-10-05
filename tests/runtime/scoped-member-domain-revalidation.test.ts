import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import type { Actor } from '../../modules/identity-membership/service.js';
import { scopedMemberCommand, scopedJournal } from '../../packages/scoped-commands/index.js';
import { withMemberScope, type MemberScopeContext } from '../../packages/resource-scopes/index.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import { migrate } from '../../scripts/database.js';

const connectionString = process.env.TEST_DATABASE_URL;
assert(connectionString, 'TEST_DATABASE_URL is required for domain revalidation tests');
assert.match(new URL(connectionString).pathname, /^\/fp_[a-z0-9_]+$/);
const schema = `fp_domain_revalidate_${process.pid}_${Date.now()}`;
const admin = new Pool({ connectionString, max: 3 });
const pool = new Pool({ connectionString, options: `-c search_path=${schema} -c statement_timeout=10000`, max: 5 });
const community = '10000000-0000-4000-8000-000000000001';
const target = '30000000-0000-4000-8000-000000000001';
const operation = 'fixture.domain.revalidate';
let created = false;
before(async () => {
  assert.match(schema, /^fp_domain_revalidate_[0-9]+_[0-9]+$/);
  await admin.query(`CREATE SCHEMA ${schema}`); created = true; await migrate(pool);
  await pool.query('CREATE TABLE fixture_domain_gate(id integer PRIMARY KEY)');
  await pool.query('INSERT INTO fixture_domain_gate VALUES(1)');
  await pool.query(`CREATE TABLE fixture_domain_effects(scope_id uuid PRIMARY KEY REFERENCES resource_scopes,
    version bigint NOT NULL DEFAULT 1)`);
});
after(async () => {
  await pool.end(); if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
});
beforeEach(async () => {
  await pool.query('TRUNCATE communities CASCADE');
  await pool.query('INSERT INTO communities VALUES($1,$2)', [community, 'Synthetic domain revalidation']);
});
async function member(): Promise<Actor> {
  const id = randomUUID();
  const row = (await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic','not-a-login-hash',$4) RETURNING *`,
  [id, community, `${id}@example.invalid`, randomUUID()])).rows[0];
  const session_hash = randomUUID();
  await pool.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')", [session_hash, id]);
  const actor: Actor = { ...row, session_hash, csrf_token: 'synthetic' };
  await withMemberScope(pool, { actor, scope: 'personal' }, async () => {}, async (q, context) => {
    await q.query('INSERT INTO fixture_domain_effects(scope_id) VALUES($1)', [context.scope.scope_id]);
  });
  return actor;
}
async function authorize(q: PoolClient, context: MemberScopeContext) {
  assert.equal((await q.query('SELECT version FROM fixture_domain_effects WHERE scope_id=$1 FOR UPDATE', [context.scope.scope_id])).rowCount, 1);
}
async function mutate(q: PoolClient, context: MemberScopeContext) {
  const row = (await q.query('UPDATE fixture_domain_effects SET version=version+1 WHERE scope_id=$1 RETURNING version::text', [context.scope.scope_id])).rows[0];
  await scopedJournal(q, context, { aggregate_type: 'fixture_domain', id: target, version: row.version, operation,
    data: { state: 'synthetic' }, eventType: 'fixture.domain.changed.v1' });
  return { version: row.version };
}
const invoke = (actor: Actor, revalidate?: (q: PoolClient, context: MemberScopeContext) => Promise<unknown>, assertCurrentTime?: () => void) =>
  scopedMemberCommand(pool, { actor, scope: 'personal', operation, key: 'synthetic-revalidate', body: {},
    target: { kind: 'fixture_domain', id: target }, expected: '1' }, authorize, mutate, revalidate, assertCurrentTime);
async function counts() {
  return (await pool.query(`SELECT (SELECT count(*)::int FROM scoped_command_receipts) receipts,
    (SELECT count(*)::int FROM scoped_transition_journal) journals,(SELECT count(*)::int FROM scoped_outbox) outbox,
    (SELECT COALESCE(sum(version-1),0)::int FROM fixture_domain_effects) effects`)).rows[0];
}
const empty = { receipts: 0, journals: 0, outbox: 0, effects: 0 };
const retained = { receipts: 1, journals: 1, outbox: 1, effects: 1 };
async function blockedBy(pid: number) {
  for (let count = 0; count < 100; count++) {
    if ((await admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) yes', [pid])).rows[0].yes) return;
    await delay(10);
  }
  assert.fail('Actual PostgreSQL revalidation-hook row lock wait was not observed');
}
async function crossExpiry(deadline: Date) {
  const remaining = Number((await admin.query('SELECT GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp()))*1000)::float8 remaining', [deadline])).rows[0].remaining);
  await delay(remaining + 40);
  assert.equal((await admin.query('SELECT clock_timestamp()>$1::timestamptz expired', [deadline])).rows[0].expired, true);
}
async function waitCase(kind: 'session'|'domain', phase: 'read'|'write') {
  const actor = await member();
  if (phase === 'read') assert.deepEqual(await invoke(actor), { version: '2' });
  const deadline: Date = kind === 'session'
    ? (await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '700 milliseconds' WHERE token_hash=$1 RETURNING expires_at", [actor.session_hash])).rows[0].expires_at
    : (await admin.query("SELECT clock_timestamp()+interval '700 milliseconds' deadline")).rows[0].deadline;
  const blocker = await pool.connect();
  let entered!: () => void; const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0;
  await blocker.query('BEGIN');
  try {
    const pid = (await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await blocker.query('SELECT id FROM fixture_domain_gate WHERE id=1 FOR UPDATE');
    const revalidate = async (q: PoolClient) => {
      if (++calls !== (phase === 'read' ? 1 : 2)) return;
      // Trusted domain callbacks may genuinely wait after the receipt operation.
      // Session checks deliberately belong to the helper, not this fixture hook.
      entered();
      await q.query('SELECT id FROM fixture_domain_gate WHERE id=1 FOR UPDATE');
      if (kind === 'domain') {
        const valid = (await q.query('SELECT clock_timestamp()<$1::timestamptz valid', [deadline])).rows[0].valid;
        requireCondition(valid, 403, 'fixture_domain_expired', 'Synthetic domain authority expired.');
      }
    };
    const pending = invoke(actor, revalidate);
    // Attach the rejection expectation before waiting, avoiding unhandled rejects.
    const rejected = assert.rejects(pending, (error: unknown) => error instanceof Problem
      && error.status === (kind === 'session' ? 401 : 403)
      && error.code === (kind === 'session' ? 'session_expired' : 'fixture_domain_expired'));
    await enteredPromise; await blockedBy(pid); await crossExpiry(deadline);
    await blocker.query('COMMIT'); await rejected;
    assert.equal(calls, phase === 'read' ? 1 : 2);
    assert.deepEqual(await counts(), phase === 'read' ? retained : empty);
  } finally {
    await blocker.query('ROLLBACK'); blocker.release();
  }
}

test('replay is denied when an actual domain revalidation hook wait crosses member-session expiry', async () => waitCase('session', 'read'));
test('effect and all three scoped sinks roll back when a post-write hook wait crosses member-session expiry', async () => waitCase('session', 'write'));
test('historical replay is denied when domain authority expires during the post-read hook wait', async () => waitCase('domain', 'read'));
test('effect and all three scoped sinks roll back when domain authority expires during the post-write hook wait', async () => waitCase('domain', 'write'));


for (const phase of ['read','write'] as const) test(`final session-result delivery cannot outlive domain time authority on ${phase}`, async () => {
  const actor = await member();
  if (phase === 'read') assert.deepEqual(await invoke(actor), { version: '2' });
  let current = true, revalidations = 0, delivered = 0;
  const originalConnect = pool.connect.bind(pool);
  // Keep the actual SQL result, but withdraw the server-owned time check when
  // the last session result is delivered after domain SQL revalidation.
  (pool as any).connect = async () => {
    const q = await originalConnect(), originalQuery = q.query, originalRelease = q.release;
    (q as any).query = async (...args: any[]) => {
      const result = await (originalQuery as any).apply(q, args);
      const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
      if (revalidations === (phase === 'read' ? 1 : 2) && delivered === 0
        && sql?.startsWith('SELECT token_hash FROM sessions') && sql.includes('clock_timestamp()')) {
        delivered++; current = false;
      }
      return result;
    };
    (q as any).release = (...args: any[]) => {
      q.query = originalQuery; q.release = originalRelease; (originalRelease as any).apply(q, args);
    };
    return q;
  };
  try {
    await assert.rejects(invoke(actor, async q => {
      await q.query('SELECT clock_timestamp()'); revalidations++;
    }, () => requireCondition(current, 403, 'fixture_domain_expired', 'Synthetic domain authority expired.')),
    (error: unknown) => error instanceof Problem && error.code === 'fixture_domain_expired');
    assert.equal(delivered, 1);
    (pool as any).connect = originalConnect;
    assert.deepEqual(await counts(), phase === 'read' ? retained : empty);
  } finally { (pool as any).connect = originalConnect; }
});
