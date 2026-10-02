import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import { migrate } from '../../scripts/database.js';
import { createExecutionRuns, type CreateExecutionRunInput, type ControlExecutionRunInput } from '../../modules/agent-execution/runs.js';
import { createPrivateWorkCommands } from '../../modules/opportunity-project-work/private-commands.js';
import { resolvePrivateWorkPersistencePolicy } from '../../modules/autopilot-work/policy.js';
import type { Actor } from '../../modules/identity-membership/service.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import { Problem } from '../../packages/shared/problem.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname)) throw new Error('Explicit isolated fp_* TEST_DATABASE_URL required.');
const schema = `fp_execution_runs_${process.pid}_${Date.now()}`, admin = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: `-c search_path=${schema} -c statement_timeout=10000`, max: 12 });
const community = randomUUID(), runs = createExecutionRuns(pool);
const works = createPrivateWorkCommands(pool, { resolvePolicy: resolvePrivateWorkPersistencePolicy });
let created = false;
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); created = true; await migrate(pool); });
after(async () => { await pool.end(); try { if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); } });
beforeEach(async () => {
  await pool.query('TRUNCATE communities CASCADE');
  await pool.query("INSERT INTO communities VALUES($1,'Synthetic Run members')", [community]);
});
const status = (value: number) => (error: unknown) => error instanceof Problem && error.status === value;
const sqlCode = (...values: string[]) => (error: unknown) => values.includes((error as { code?: string }).code ?? '');
async function member() {
  const user = randomUUID(), session = randomUUID();
  const row = (await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic Run owner','not-a-login',$4) RETURNING *`, [user, community, user+'@example.invalid', randomUUID()])).rows[0];
  await pool.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')", [session, user]);
  const actor: Actor = { ...row, session_hash: session, csrf_token: 'synthetic' };
  const context = await withMemberScope(pool, { actor, scope: 'personal' }, async () => {}, async (_q, context) => context);
  await pool.query(`INSERT INTO private_work_persistence_policy(scope_id,purpose,owner_principal_id,revision,persistence_allowed,retained_byte_limit)
    VALUES($1,'work.private-draft',$2,1,true,10485760)`, [context.scope.scope_id, context.subject_principal.principal_id]);
  return { actor, context };
}
async function fixture() {
  const f = await member(), work = await works.create(f.actor, { key: randomUUID(), title: 'Run goal', objective: 'PRIVATE_WORK_BODY_NOT_IN_RUN' });
  return { ...f, workId: work.workId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const createInput = (f: Fixture): CreateExecutionRunInput => ({ key: randomUUID(), workId: f.workId, expectedWorkVersion: '1' });
const controlInput = (runId: string, expectedVersion = '1'): ControlExecutionRunInput => ({ key: randomUUID(), runId, expectedVersion });
async function policyOff(f: Fixture) { await pool.query('UPDATE private_work_persistence_policy SET persistence_allowed=false,revision=revision+1 WHERE scope_id=$1', [f.context.scope.scope_id]); }
async function archive(f: Fixture) { return works.archive(f.actor, { key: randomUUID(), workId: f.workId, expectedVersion: '1' }); }
async function stored(f: Fixture) { return runs.create(f.actor, createInput(f)); }
async function count(table: string) { return (await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n; }
async function rawInsert(f: Fixture, extra: Record<string, unknown> = {}) {
  const values = { run_id: randomUUID(), work_item_id: f.workId, scope_id: f.context.scope.scope_id,
    owner_principal_id: f.context.subject_principal.principal_id, owner_user_id: f.actor.user_id,
    input_work_version: '1', persistence_policy_revision: 'private-work.v1', ...extra };
  const keys = Object.keys(values);
  return pool.query(`INSERT INTO execution_runs(${keys.join(',')}) VALUES(${keys.map((_, i) => '$'+(i+1)).join(',')}) RETURNING *`, Object.values(values));
}
async function blocking(q: PoolClient) {
  const pid = (await q.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  for (let i=0; i<200; i++) {
    if ((await admin.query('SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid])).rows[0].n) return;
    await delay(10);
  }
  assert.fail('Actual row-lock blocker not observed');
}
async function expired(actor: Actor) {
  for (let i=0; i<200; i++) {
    if ((await pool.query('SELECT expires_at<=clock_timestamp() expired FROM sessions WHERE token_hash=$1', [actor.session_hash])).rows[0].expired) return;
    await delay(10);
  }
  assert.fail('DB clock did not cross session expiry');
}

test('RUN-01 create is durable bounded metadata, no operational authority or Work version mutation', async () => {
  const f = await fixture(), value = await stored(f);
  assert.deepEqual(value, { runId: value.runId, workId: f.workId, inputWorkVersion: '1', aggregateVersion: '1', state: 'created', taskLeaseEpoch: '1', controlEpoch: '1', operational_authority: false });
  assert.deepEqual(await runs.read(f.actor, { runId: value.runId }), value);
  assert.equal((await pool.query('SELECT aggregate_version::text FROM work_items WHERE work_item_id=$1', [f.workId])).rows[0].aggregate_version, '1');
  const facts = (await pool.query("SELECT data FROM scoped_transition_journal WHERE aggregate_type='execution_run'")).rows;
  assert.equal(facts.length, 1); assert.equal(facts[0].data.operational_authority, false);
  assert.ok(!JSON.stringify(facts).includes('PRIVATE_WORK_BODY'));
  assert.equal(await count('outbox'), 0); assert.equal(await count('private_work_results'), 0);
});
test('RUN-02 same-key concurrent create persists exactly once with one run fact', async () => {
  const f = await fixture(), input = createInput(f);
  const values = await Promise.all([runs.create(f.actor, input), runs.create(f.actor, input)]);
  assert.deepEqual(values[0], values[1]); assert.equal(await count('execution_runs'), 1);
  assert.equal((await pool.query("SELECT count(*)::int n FROM scoped_command_receipts WHERE operation='execution.run.create'")).rows[0].n, 1);
  assert.equal((await pool.query("SELECT count(*)::int n FROM scoped_transition_journal WHERE aggregate_type='execution_run'")).rows[0].n, 1);
});
test('RUN-03 create replay retains original input snapshot after human edit, but current policy is rechecked', async () => {
  const f = await fixture(), input = createInput(f), first = await runs.create(f.actor, input);
  await works.update(f.actor, { key: randomUUID(), workId: f.workId, expectedVersion: '1', title: 'Changed', objective: 'Human edit' });
  assert.deepEqual(await runs.create(f.actor, input), first);
  await assert.rejects(runs.create(f.actor, { ...input, expectedWorkVersion: '2' }), status(409));
  await policyOff(f); await assert.rejects(runs.create(f.actor, input), status(503));
  assert.equal((await runs.read(f.actor, { runId: first.runId })).inputWorkVersion, '1');
});
test('RUN-04 pause and stop fence independent epochs; historical receipt cannot resurrect stopped state', async () => {
  const f = await fixture(), value = await stored(f), pause = controlInput(value.runId);
  const paused = await runs.pause(f.actor, pause);
  assert.equal(paused.state, 'paused'); assert.equal(paused.aggregateVersion, '2'); assert.equal(paused.taskLeaseEpoch, '2'); assert.equal(paused.controlEpoch, '2');
  const again = await runs.pause(f.actor, controlInput(value.runId, '2')); assert.equal(again.aggregateVersion, '3');
  const stop = controlInput(value.runId, '3'), stopped = await runs.stop(f.actor, stop);
  assert.equal(stopped.state, 'cancelled'); assert.equal(stopped.aggregateVersion, '4');
  assert.deepEqual(await runs.pause(f.actor, pause), paused); assert.deepEqual(await runs.stop(f.actor, stop), stopped);
  assert.equal((await runs.read(f.actor, { runId: value.runId })).state, 'cancelled');
  await assert.rejects(runs.stop(f.actor, controlInput(value.runId, '4')), status(409));
});
test('RUN-05 simultaneous controls on same expected Run version have exactly one winner', async () => {
  const f = await fixture(), value = await stored(f);
  const results = await Promise.allSettled([runs.pause(f.actor, controlInput(value.runId)), runs.stop(f.actor, controlInput(value.runId))]);
  assert.equal(results.filter(v => v.status === 'fulfilled').length, 1);
  const rejected = results.find(v => v.status === 'rejected') as PromiseRejectedResult;
  assert.ok(status(412)(rejected.reason)); assert.equal((await runs.read(f.actor, { runId: value.runId })).aggregateVersion, '2');
});
test('RUN-06 version preconditions and strict canonical inputs cannot add caller authority', async () => {
  const f = await fixture();
  await assert.rejects(runs.create(f.actor, { key: randomUUID(), workId: f.workId } as CreateExecutionRunInput), status(428));
  await assert.rejects(runs.create(f.actor, { ...createInput(f), expectedWorkVersion: '2' }), status(412));
  for (const expectedWorkVersion of ['0', '01', '1\n', '9223372036854775808']) await assert.rejects(runs.create(f.actor, { ...createInput(f), expectedWorkVersion }));
  for (const extra of [{ operational_authority: true }, { runtime_id: randomUUID() }, { policy: true }, { owner: f.actor.user_id }])
    await assert.rejects(runs.create(f.actor, { ...createInput(f), ...extra }));
  const value = await stored(f);
  await assert.rejects(runs.pause(f.actor, { key: randomUUID(), runId: value.runId } as ControlExecutionRunInput), status(428));
  assert.equal(await count('execution_runs'), 1);
});
test('RUN-07 peer/admin assertions and random IDs are indistinguishable on metadata and controls', async () => {
  const f = await fixture(), peer = await member(), value = await stored(f);
  for (const runId of [value.runId, randomUUID()]) {
    await assert.rejects(runs.read({ ...peer.actor, is_admin: true } as Actor, { runId }), status(404));
    await assert.rejects(runs.pause(peer.actor, controlInput(runId)), status(404));
    await assert.rejects(runs.stop(peer.actor, controlInput(runId)), status(404));
  }
  await assert.rejects(runs.create(peer.actor, createInput(f)), status(404));
});
test('RUN-08 revoked session/principal/scope denies reads and successful command replays', async () => {
  const f = await fixture(), input = createInput(f), value = await runs.create(f.actor, input);
  await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1', [f.actor.session_hash]);
  await assert.rejects(runs.read(f.actor, { runId: value.runId }), status(401));
  await assert.rejects(runs.create(f.actor, input), status(401));
  await pool.query('UPDATE sessions SET revoked_at=NULL WHERE token_hash=$1', [f.actor.session_hash]);
  await pool.query("UPDATE principals SET status='disabled' WHERE principal_id=$1", [f.context.subject_principal.principal_id]);
  await assert.rejects(runs.stop(f.actor, controlInput(value.runId)), status(403));
  await pool.query("UPDATE principals SET status='active' WHERE principal_id=$1", [f.context.subject_principal.principal_id]);
  await pool.query("UPDATE resource_scopes SET status='disabled' WHERE scope_id=$1", [f.context.scope.scope_id]);
  await assert.rejects(runs.create(f.actor, input), status(403));
});
test('RUN-09 archive and policy withdrawal do not disable owner read/pause/stop', async () => {
  const f = await fixture(), input = createInput(f), value = await runs.create(f.actor, input);
  await archive(f); await policyOff(f);
  assert.equal((await runs.read(f.actor, { runId: value.runId })).state, 'created');
  await assert.rejects(runs.create(f.actor, input), status(409));
  await runs.pause(f.actor, controlInput(value.runId)); await runs.stop(f.actor, controlInput(value.runId, '2'));
  assert.equal((await pool.query('SELECT aggregate_version::text FROM work_items WHERE work_item_id=$1', [f.workId])).rows[0].aggregate_version, '2');
});
test('RUN-10 direct INSERT requires actual draft/version/policy and closed initial counters', async () => {
  const f = await fixture();
  for (const values of [{ state: 'running' }, { state: 'paused' }, { aggregate_version: '2' }, { task_lease_epoch: '2' }, { control_epoch: '2' },
    { input_work_version: '2' }, { persistence_policy_revision: 'private-work.v2' }]) await assert.rejects(rawInsert(f, values), sqlCode('23514'));
  await rawInsert(f); await policyOff(f); await assert.rejects(rawInsert(f), sqlCode('23514'));
  await archive(f); await assert.rejects(rawInsert(f), sqlCode('23514'));
});
test('RUN-11 direct INSERT rejects owner/scope/Work substitution and NULL-FK bypass', async () => {
  const f = await fixture(), peer = await fixture();
  for (const values of [{ owner_user_id: peer.actor.user_id }, { owner_principal_id: peer.context.subject_principal.principal_id },
    { scope_id: peer.context.scope.scope_id }, { work_item_id: peer.workId }, { scope_id: null }, { owner_principal_id: null }, { owner_user_id: null }])
    await assert.rejects(rawInsert(f, values), sqlCode('23503', '23514', '23502'));
});
test('RUN-12 direct UPDATE cannot rebind identity, alter input/provenance, bypass CAS/fences or activate', async () => {
  const f = await fixture(), value = await stored(f);
  for (const set of ["state='running'", "state='paused'", "aggregate_version=2", "control_epoch=2", "task_lease_epoch=2",
    "input_work_version=2", "persistence_policy_revision='private-work.v2'", "created_at=created_at+interval '1 second'", 'run_id=gen_random_uuid()',
    "state='paused',aggregate_version=3,task_lease_epoch=2,control_epoch=2"]) {
    await assert.rejects(pool.query(`UPDATE execution_runs SET ${set} WHERE run_id=$1`, [value.runId]), sqlCode('23514'));
  }
  await assert.rejects(pool.query('DELETE FROM execution_runs WHERE run_id=$1', [value.runId]), sqlCode('23514'));
  await runs.stop(f.actor, controlInput(value.runId));
  await assert.rejects(pool.query('UPDATE execution_runs SET state=state WHERE run_id=$1', [value.runId]), sqlCode('23514'));
  await assert.rejects(pool.query("UPDATE execution_runs SET state='created',aggregate_version=3,task_lease_epoch=3,control_epoch=3 WHERE run_id=$1", [value.runId]), sqlCode('23514'));
});
test('RUN-13 no fake Attempt/Grant/current lease/recovery/token/Result authority fields exist', async () => {
  const columns = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='execution_runs'", [schema])).rows.map(r => r.column_name);
  for (const column of ['current_attempt_id', 'grant_id', 'runtime_id', 'connection_id', 'recovery_generation', 'expires_at', 'operational_authority', 'result_id']) assert.ok(!columns.includes(column));
  const f = await fixture(), value = await stored(f);
  assert.equal(value.operational_authority, false);
  assert.equal(await count('work_claims'), 0); assert.equal(await count('contributions'), 0);
});
for (const table of ['scoped_transition_journal', 'scoped_outbox', 'scoped_command_receipts']) {
  test(`RUN-14 ${table} failure rolls back Run/control/receipt/facts atomically`, async () => {
    const f = await fixture(), value = await stored(f), input = controlInput(value.runId);
    const before = await Promise.all(['execution_runs','scoped_transition_journal','scoped_outbox','scoped_command_receipts'].map(count));
    await pool.query("CREATE FUNCTION fp_run_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$");
    await pool.query(`CREATE TRIGGER fp_run_fail BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fp_run_fail()`);
    try { await assert.rejects(runs.pause(f.actor, input)); } finally {
      await pool.query(`DROP TRIGGER fp_run_fail ON ${table}`); await pool.query('DROP FUNCTION fp_run_fail()');
    }
    assert.equal((await runs.read(f.actor, { runId: value.runId })).state, 'created');
    assert.deepEqual(await Promise.all(['execution_runs','scoped_transition_journal','scoped_outbox','scoped_command_receipts'].map(count)), before);
    assert.equal((await runs.pause(f.actor, input)).aggregateVersion, '2');
  });
}
for (const action of ['read','pause','stop'] as const) {
  test(`RUN-15 ${action} rejects current session expiry after actual Run lock wait`, async () => {
    const f = await fixture(), value = await stored(f), holder = await pool.connect();
    await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '350 milliseconds' WHERE token_hash=$1", [f.actor.session_hash]);
    await holder.query('BEGIN'); await holder.query('SELECT run_id FROM execution_runs WHERE run_id=$1 FOR UPDATE', [value.runId]);
    const operation = action === 'read' ? runs.read(f.actor, { runId: value.runId }) : runs[action](f.actor, controlInput(value.runId));
    const rejected = assert.rejects(operation, status(401));
    try { await blocking(holder); await expired(f.actor); } finally { await holder.query('ROLLBACK'); holder.release(); }
    await rejected;
    assert.equal((await pool.query('SELECT aggregate_version::text FROM execution_runs WHERE run_id=$1', [value.runId])).rows[0].aggregate_version, '1');
  });
}
test('RUN-16 create rechecks session clock after actual policy wait and snapshots actor/input before awaits', async () => {
  const f = await fixture(), peer = await fixture(), holder = await pool.connect(), actor = { ...f.actor }, input = createInput(f);
  await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '350 milliseconds' WHERE token_hash=$1", [f.actor.session_hash]);
  await holder.query('BEGIN'); await holder.query('SELECT scope_id FROM private_work_persistence_policy WHERE scope_id=$1 FOR UPDATE', [f.context.scope.scope_id]);
  const operation = runs.create(actor, input), rejected = assert.rejects(operation, status(401));
  try { await blocking(holder); actor.user_id=peer.actor.user_id; input.workId=peer.workId; await expired(f.actor); }
  finally { await holder.query('ROLLBACK'); holder.release(); }
  await rejected; assert.equal(await count('execution_runs'), 0);
});
test('RUN-17 successful policy barrier retains immutable actor/input snapshot and replays exact request', async () => {
  const f = await fixture(), peer = await fixture(), holder = await pool.connect(), actor = { ...f.actor }, input = createInput(f), original = { ...input };
  await holder.query('BEGIN'); await holder.query('SELECT scope_id FROM private_work_persistence_policy WHERE scope_id=$1 FOR UPDATE', [f.context.scope.scope_id]);
  const operation = runs.create(actor, input);
  try { await blocking(holder); actor.user_id=peer.actor.user_id; input.workId=peer.workId; }
  finally { await holder.query('ROLLBACK'); holder.release(); }
  const value = await operation; assert.equal(value.workId, f.workId); assert.deepEqual(await runs.create(f.actor, original), value);
});
test('RUN-18 input Work version above JS safe integer stays exact and never grants execution authority', async () => {
  const f = await fixture(), version = '9007199254740993';
  await pool.query('UPDATE work_items SET aggregate_version=$2 WHERE work_item_id=$1', [f.workId, version]);
  const value = await runs.create(f.actor, { ...createInput(f), expectedWorkVersion: version });
  assert.equal(value.inputWorkVersion, version); assert.equal(value.operational_authority, false);
  await runs.stop(f.actor, controlInput(value.runId));
  assert.equal((await pool.query('SELECT aggregate_version::text FROM work_items WHERE work_item_id=$1', [f.workId])).rows[0].aggregate_version, version);
});
test('RUN-19 same-key concurrent pause fences once, and revoked session prevents that receipt replay', async () => {
  const f = await fixture(), value = await stored(f), input = controlInput(value.runId);
  const responses = await Promise.all([runs.pause(f.actor, input), runs.pause(f.actor, input)]);
  assert.deepEqual(responses[0], responses[1]); assert.equal(responses[0].taskLeaseEpoch, '2');
  await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1', [f.actor.session_hash]);
  await assert.rejects(runs.pause(f.actor, input), status(401));
});
test('RUN-20 failed initial create journal does not leave an unreceipted Run', async () => {
  const f = await fixture(), input = createInput(f);
  await pool.query("CREATE FUNCTION fp_run_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$");
  await pool.query('CREATE TRIGGER fp_run_fail BEFORE INSERT ON scoped_transition_journal FOR EACH ROW EXECUTE FUNCTION fp_run_fail()');
  try { await assert.rejects(runs.create(f.actor, input)); } finally {
    await pool.query('DROP TRIGGER fp_run_fail ON scoped_transition_journal'); await pool.query('DROP FUNCTION fp_run_fail()');
  }
  assert.equal(await count('execution_runs'), 0);
  assert.equal((await pool.query("SELECT count(*)::int n FROM scoped_command_receipts WHERE operation='execution.run.create'")).rows[0].n, 0);
  assert.equal((await runs.create(f.actor, input)).state, 'created');
});
