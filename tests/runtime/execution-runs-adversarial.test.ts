import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import { createPool } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import type { Actor } from '../../modules/identity-membership/service.js';
import { createPrivateWorkCommands } from '../../modules/opportunity-project-work/private-commands.js';
import { resolvePrivateWorkPersistencePolicy as resolvePolicy } from '../../modules/autopilot-work/policy.js';
import { createExecutionRuns } from '../../modules/agent-execution/runs.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname))
  throw Error('Independent Run tests require an explicit disposable fp_* TEST_DATABASE_URL');
const schema = `fp_run_adversarial_${process.pid}_${Date.now()}`;
const admin = createPool(connectionString), pool = new Pool({ connectionString, options: `-c search_path=${schema} -c statement_timeout=10000`, max: 12 });
const community = randomUUID(), otherCommunity = randomUUID();
const runs = createExecutionRuns(pool), works = createPrivateWorkCommands(pool, { resolvePolicy });
let created = false;
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); created = true; await migrate(pool); });
after(async () => { await pool.end(); if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(async () => {
  await pool.query('TRUNCATE communities CASCADE');
  await pool.query("INSERT INTO communities VALUES($1,'Synthetic owner'),($2,'Synthetic outside')", [community, otherCommunity]);
});
const status = (value: number) => (error: any) => error?.status === value;
const code = (value: string) => (error: any) => error?.code === value;
async function member(communityId = community, seedPolicy = true) {
  const user = randomUUID(), session = randomUUID();
  const row = (await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic','not-a-login',$4) RETURNING *`, [user, communityId, user + '@example.invalid', randomUUID()])).rows[0];
  await pool.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1hour')", [session, user]);
  const actor: Actor = { ...row, session_hash: session, csrf_token: 'synthetic' };
  const context = await withMemberScope(pool, { actor, scope: 'personal' }, async () => {}, async (_q, value) => value);
  const scope = context.scope.scope_id, principal = context.subject_principal.principal_id;
  if (seedPolicy) await pool.query(`INSERT INTO private_work_persistence_policy(scope_id,purpose,owner_principal_id,revision,persistence_allowed,retained_byte_limit)
    VALUES($1,'work.private-draft',$2,1,true,10485760)`, [scope, principal]);
  return { actor, scope, principal };
}
async function fixture(withRun = true) {
  const f = await member(), work = await works.create(f.actor, { key: randomUUID(), title: 'PRIVATE_RUN_TITLE', objective: 'PRIVATE_RUN_OBJECTIVE' });
  const input = { key: randomUUID(), workId: work.workId, expectedWorkVersion: '1' };
  const run = withRun ? await runs.create(f.actor, input) : undefined;
  return { ...f, work, input, run };
}
async function facts() {
  return (await pool.query(`SELECT
    (SELECT count(*)::int FROM execution_runs) runs,
    (SELECT count(*)::int FROM scoped_command_receipts) receipts,
    (SELECT count(*)::int FROM scoped_transition_journal) journal,
    (SELECT count(*)::int FROM scoped_outbox) outbox,
    (SELECT count(*)::int FROM command_receipts) legacy_receipts,
    (SELECT count(*)::int FROM transition_journal) legacy_journal,
    (SELECT count(*)::int FROM outbox) legacy_outbox`)).rows[0];
}
async function blockedBy(q: PoolClient) {
  const pid = (await q.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  for (let i = 0; i < 250; i++) {
    if ((await admin.query('SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid])).rows[0].n) return;
    await delay(10);
  }
  assert.fail('Actual PostgreSQL row-lock wait was not observed');
}
async function expired(actor: Actor) {
  for (let i = 0; i < 250; i++) {
    if ((await pool.query('SELECT expires_at<=clock_timestamp() expired FROM sessions WHERE token_hash=$1', [actor.session_hash])).rows[0].expired) return;
    await delay(10);
  }
  assert.fail('Synthetic session did not expire within bounded wait');
}

test('RUN independent genuine metadata has immutable Work input, separate monotonic epochs and no operational authority', async () => {
  const f = await fixture(), current = f.run!;
  assert.deepEqual(Object.keys(current).sort(), ['aggregateVersion', 'controlEpoch', 'inputWorkVersion', 'operational_authority', 'runId', 'state', 'taskLeaseEpoch', 'workId']);
  assert.equal(current.inputWorkVersion, '1'); assert.equal(current.operational_authority, false);
  const paused = await runs.pause(f.actor, { key: randomUUID(), runId: current.runId, expectedVersion: '1' });
  assert.equal(paused.state, 'paused'); assert.equal(paused.aggregateVersion, '2'); assert.equal(paused.taskLeaseEpoch, '2'); assert.equal(paused.controlEpoch, '2');
  await works.update(f.actor, { key: randomUUID(), workId: f.work.workId, expectedVersion: '1', title: 'New title', objective: 'New input' });
  const stopped = await runs.stop(f.actor, { key: randomUUID(), runId: current.runId, expectedVersion: '2' });
  assert.equal(stopped.state, 'cancelled'); assert.equal(stopped.inputWorkVersion, '1'); assert.equal(stopped.aggregateVersion, '3');
  assert.equal((await pool.query('SELECT aggregate_version FROM work_items WHERE work_item_id=$1', [f.work.workId])).rows[0].aggregate_version, '2');
  assert.deepEqual(await runs.read(f.actor, { runId: current.runId }), stopped);
  await assert.rejects(runs.pause(f.actor, { key: randomUUID(), runId: current.runId, expectedVersion: '3' }), code('execution_run_terminal'));
  for (const table of ['scoped_command_receipts', 'scoped_transition_journal', 'scoped_outbox']) {
    const serialized = JSON.stringify((await pool.query(`SELECT * FROM ${table}`)).rows);
    assert(!serialized.includes('PRIVATE_RUN_')); assert(!serialized.includes(f.actor.session_hash));
  }
  const state = await facts(); assert.equal(state.legacy_receipts, 0); assert.equal(state.legacy_journal, 0); assert.equal(state.legacy_outbox, 0);
});

test('RUN independent same key concurrent create commits exactly one Run/fact/receipt', async () => {
  const f = await fixture(false), before = await facts();
  const [a, b] = await Promise.all([runs.create(f.actor, f.input), runs.create(f.actor, f.input)]);
  assert.deepEqual(a, b);
  const after = await facts();
  for (const field of ['runs', 'receipts', 'journal', 'outbox']) assert.equal(after[field], before[field] + 1);
  assert.equal((await pool.query('SELECT aggregate_version FROM work_items')).rows[0].aggregate_version, '1');
});

test('RUN independent competing pause/stop same CAS has one winner; retry cannot refence', async () => {
  const f = await fixture(), before = await facts(), input = { key: randomUUID(), runId: f.run!.runId, expectedVersion: '1' };
  const results = await Promise.allSettled([runs.pause(f.actor, input), runs.stop(f.actor, { ...input, key: randomUUID() })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const rejection = results.find(r => r.status === 'rejected') as PromiseRejectedResult; assert.equal(rejection.reason.status, 412);
  const current = await runs.read(f.actor, { runId: f.run!.runId });
  assert.equal(current.aggregateVersion, '2'); assert.equal(current.controlEpoch, '2'); assert.equal(current.taskLeaseEpoch, '2');
  assert.equal((await facts()).receipts, before.receipts + 1);
});

test('RUN independent successful control replay is immutable historical receipt, not another transition', async () => {
  const f = await fixture(), pause = { key: randomUUID(), runId: f.run!.runId, expectedVersion: '1' };
  const paused = await runs.pause(f.actor, pause), stop = { key: randomUUID(), runId: f.run!.runId, expectedVersion: '2' };
  const stopped = await runs.stop(f.actor, stop), before = await facts();
  assert.deepEqual(await runs.pause(f.actor, pause), paused); assert.deepEqual(await runs.stop(f.actor, stop), stopped);
  assert.deepEqual(await facts(), before); assert.equal((await runs.read(f.actor, { runId: f.run!.runId })).state, 'cancelled');
  await assert.rejects(runs.stop(f.actor, { ...stop, expectedVersion: '3' }), code('idempotency_conflict'));
});

test('RUN independent create key cannot target another Work or silently use a new expected input version', async () => {
  const f = await fixture(), second = await works.create(f.actor, { key: randomUUID(), title: 'second', objective: 'second' });
  await assert.rejects(runs.create(f.actor, { ...f.input, workId: second.workId }), code('idempotency_conflict'));
  await assert.rejects(runs.create(f.actor, { ...f.input, expectedWorkVersion: '2' }), code('idempotency_conflict'));
  await assert.rejects(runs.create(f.actor, { ...f.input, key: randomUUID(), expectedWorkVersion: '2' }), status(412));
});

test('RUN independent policy withdrawal blocks new/create replay but read/pause/stop work after archive', async () => {
  const f = await fixture();
  await pool.query('UPDATE private_work_persistence_policy SET revision=revision+1,persistence_allowed=false WHERE scope_id=$1', [f.scope]);
  await assert.rejects(runs.create(f.actor, f.input), status(503));
  await assert.rejects(runs.create(f.actor, { ...f.input, key: randomUUID() }), status(503));
  await works.archive(f.actor, { key: randomUUID(), workId: f.work.workId, expectedVersion: '1' });
  assert.equal((await runs.read(f.actor, { runId: f.run!.runId })).state, 'created');
  const paused = await runs.pause(f.actor, { key: randomUUID(), runId: f.run!.runId, expectedVersion: '1' });
  const stop = { key: randomUUID(), runId: f.run!.runId, expectedVersion: paused.aggregateVersion };
  const stopped = await runs.stop(f.actor, stop); assert.equal(stopped.state, 'cancelled');
  assert.deepEqual(await runs.stop(f.actor, stop), stopped);
  await assert.rejects(runs.create(f.actor, f.input), code('private_work_archived'));
  assert.equal((await pool.query('SELECT aggregate_version FROM work_items')).rows[0].aggregate_version, '2');
});

test('RUN independent existing owner controls do not query a locked/unavailable policy source', async () => {
  const f = await fixture(), q = await pool.connect();
  try {
    // A transaction-local source outage demonstrates controls are independent,
    // without mutating an immutable policy identity or installing runtime hooks.
    await q.query('BEGIN'); await q.query('LOCK TABLE private_work_persistence_policy IN ACCESS EXCLUSIVE MODE');
    const stopped = await runs.stop(f.actor, { key: randomUUID(), runId: f.run!.runId, expectedVersion: '1' });
    assert.equal(stopped.state, 'cancelled');
    assert.equal((await runs.read(f.actor, { runId: f.run!.runId })).state, 'cancelled');
  } finally { await q.query('ROLLBACK'); q.release(); }
});

test('RUN independent unconfigured owner policy cannot admit a Run for an existing private Work', async () => {
  const f = await member(community, false), workId = randomUUID();
  // Synthetic persisted Work models pre-policy data without bypassing Run admission.
  await pool.query(`INSERT INTO work_items(work_item_id,work_mode,scope_id,owner_principal_id,owner_ref,title,objective,state,participation_terms_revision)
    VALUES($1,'personal_execution',$2,$3,$4,'Synthetic prior Work','No configured policy','draft',NULL)`,
  [workId, f.scope, f.principal, f.actor.user_id]);
  const before = await facts();
  await assert.rejects(runs.create(f.actor, { key: randomUUID(), workId, expectedWorkVersion: '1' }), status(503));
  assert.deepEqual(await facts(), before);
});

test('RUN independent create observes a policy withdrawal committed during its actual policy lock wait', async () => {
  const f = await fixture(false), q = await pool.connect(), before = await facts();
  try {
    await q.query('BEGIN');
    await q.query('UPDATE private_work_persistence_policy SET revision=revision+1,persistence_allowed=false WHERE scope_id=$1', [f.scope]);
    const rejected = assert.rejects(runs.create(f.actor, f.input), status(503));
    await blockedBy(q); await q.query('COMMIT'); await rejected;
    assert.deepEqual(await facts(), before);
  } finally { await q.query('ROLLBACK'); q.release(); }
});

test('RUN independent same-community/cross-community/admin/guild peers cannot read or control exact IDs', async () => {
  const f = await fixture(), peer = await member(), outsider = await member(otherCommunity);
  await pool.query("INSERT INTO platform_admins(admin_id,community_id,email,display_name,role) VALUES($1,$2,$3,'Synthetic admin','super_admin')", [randomUUID(), community, peer.actor.email]);
  await pool.query('INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) SELECT $1,guild_key,$2 FROM positioning_guild_catalog ORDER BY guild_key LIMIT 1', [community, peer.actor.user_id]);
  for (const other of [peer, outsider]) {
    await assert.rejects(runs.read(other.actor, { runId: f.run!.runId }), status(404));
    await assert.rejects(runs.read(other.actor, { runId: randomUUID() }), status(404));
    await assert.rejects(runs.pause(other.actor, { key: randomUUID(), runId: f.run!.runId, expectedVersion: '1' }), status(404));
    await assert.rejects(runs.stop(other.actor, { key: randomUUID(), runId: f.run!.runId, expectedVersion: '1' }), status(404));
    await assert.rejects(runs.create(other.actor, { ...f.input, key: randomUUID() }), status(404));
  }
});

for (const revoke of ['session', 'user', 'principal', 'scope', 'onboarding'] as const)
  test(`RUN independent ${revoke} revocation blocks reads and success receipt replay`, async () => {
    const f = await fixture(), input = { key: randomUUID(), runId: f.run!.runId, expectedVersion: '1' };
    await runs.pause(f.actor, input);
    if (revoke === 'session') await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1', [f.actor.session_hash]);
    if (revoke === 'user') await pool.query('UPDATE users SET active=false WHERE user_id=$1', [f.actor.user_id]);
    if (revoke === 'principal') await pool.query("UPDATE principals SET status='disabled' WHERE principal_id=$1", [f.principal]);
    if (revoke === 'scope') await pool.query("UPDATE resource_scopes SET status='disabled' WHERE scope_id=$1", [f.scope]);
    if (revoke === 'onboarding') await pool.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1', [f.actor.user_id]);
    const expected = revoke === 'session' || revoke === 'user' ? 401 : 403;
    await assert.rejects(runs.read(f.actor, { runId: f.run!.runId }), status(expected));
    await assert.rejects(runs.pause(f.actor, input), status(expected));
    await assert.rejects(runs.create(f.actor, f.input), status(expected));
    await assert.rejects(runs.stop(f.actor, { ...input, key: randomUUID(), expectedVersion: '2' }), status(expected));
  });

for (const [operation, resource] of [['create', 'work'], ['create', 'policy'], ['pause', 'run'], ['stop', 'work'], ['read', 'run'], ['read', 'work']] as const)
  test(`RUN independent ${operation} rejects expiry after actual ${resource} lock wait`, async () => {
    const f = await fixture(operation !== 'create'), q = await pool.connect(), before = await facts();
    await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '1second' WHERE token_hash=$1", [f.actor.session_hash]);
    try {
      await q.query('BEGIN');
      if (resource === 'work') await q.query('SELECT work_item_id FROM work_items WHERE work_item_id=$1 FOR UPDATE', [f.work.workId]);
      if (resource === 'run') await q.query('SELECT run_id FROM execution_runs WHERE run_id=$1 FOR UPDATE', [f.run!.runId]);
      if (resource === 'policy') await q.query('UPDATE private_work_persistence_policy SET revision=revision+1 WHERE scope_id=$1', [f.scope]);
      const pending = operation === 'create' ? runs.create(f.actor, f.input) : operation === 'read' ? runs.read(f.actor, { runId: f.run!.runId })
        : runs[operation](f.actor, { key: randomUUID(), runId: f.run!.runId, expectedVersion: '1' });
      const rejected = assert.rejects(pending, status(401));
      await blockedBy(q); await expired(f.actor); await q.query('COMMIT'); await rejected;
      assert.deepEqual(await facts(), before);
    } finally { await q.query('ROLLBACK'); q.release(); }
  });

for (const operation of ['create', 'stop'] as const) for (const table of ['scoped_transition_journal', 'scoped_outbox', 'scoped_command_receipts'])
  test(`RUN independent ${operation} rolls back domain+fences when ${table} fails, then same key retries`, async () => {
    const f = await fixture(operation !== 'create'), before = await facts();
    const input = { key: randomUUID(), runId: f.run?.runId ?? randomUUID(), expectedVersion: '1' };
    await pool.query(`CREATE FUNCTION fail_run_fact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic failure' USING ERRCODE='P0001'; END $$`);
    await pool.query(`CREATE TRIGGER fail_run_fact BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_run_fact()`);
    try {
      await assert.rejects(operation === 'create' ? runs.create(f.actor, f.input) : runs.stop(f.actor, input), code('P0001'));
      assert.deepEqual(await facts(), before);
      if (f.run) assert.equal((await runs.read(f.actor, { runId: f.run.runId })).aggregateVersion, '1');
    } finally { await pool.query(`DROP TRIGGER fail_run_fact ON ${table}`); await pool.query('DROP FUNCTION fail_run_fact()'); }
    const result = operation === 'create' ? await runs.create(f.actor, f.input) : await runs.stop(f.actor, input);
    assert.equal(result.state, operation === 'create' ? 'created' : 'cancelled');
    assert.equal((await facts()).receipts, before.receipts + 1);
  });

test('RUN independent strict inputs do not accept pending binding/Grant/actor/policy authorities', async () => {
  const f = await fixture(false), before = await facts();
  for (const extra of ['grantId', 'attemptId', 'runtimeId', 'actor', 'policy', 'scope', 'ownerId', 'operational_authority'])
    await assert.rejects(runs.create(f.actor, { ...f.input, [extra]: 'caller-cannot-authorize' } as any));
  await assert.rejects(runs.create(f.actor, { ...f.input, workId: f.work.workId.toUpperCase() }));
  await assert.rejects(runs.create(f.actor, { ...f.input, key: 'valid_key\n' }));
  await assert.rejects(runs.create(f.actor, { ...f.input, expectedWorkVersion: '9223372036854775808' }));
  await assert.rejects(runs.create(f.actor, { ...f.input, expectedWorkVersion: undefined } as any), status(428));
  assert.deepEqual(await facts(), before);
});

test('RUN independent ordinary SQL cannot invent running state, rewrite input/ownership, skip fences or resurrect terminal row', async () => {
  const f = await fixture(), other = await fixture();
  for (const [set, params] of [
    ["state='running'", []], ['input_work_version=2', []], ['work_item_id=$2', [other.work.workId]], ['owner_user_id=$2', [other.actor.user_id]],
    ['scope_id=$2', [other.scope]], ["persistence_policy_revision='private-work.v2'", []],
    ["state='paused',aggregate_version=2,task_lease_epoch=1,control_epoch=2", []],
    ["state='paused',aggregate_version=3,task_lease_epoch=2,control_epoch=2", []],
  ] as const) await assert.rejects(pool.query(`UPDATE execution_runs SET ${set} WHERE run_id=$1`, [f.run!.runId, ...params]), code('23514'));
  await assert.rejects(pool.query('DELETE FROM execution_runs WHERE run_id=$1', [f.run!.runId]), code('23514'));
  await runs.stop(f.actor, { key: randomUUID(), runId: f.run!.runId, expectedVersion: '1' });
  await assert.rejects(pool.query("UPDATE execution_runs SET state='paused',aggregate_version=3,task_lease_epoch=3,control_epoch=3 WHERE run_id=$1", [f.run!.runId]), code('23514'));
  assert.equal((await runs.read(f.actor, { runId: f.run!.runId })).state, 'cancelled');
});
