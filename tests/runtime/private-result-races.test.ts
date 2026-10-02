import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import { migrate } from '../../scripts/database.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import type { Actor } from '../../modules/identity-membership/service.js';

// Independent SQL counterexamples. No production defaults or external objects.
const connectionString = process.env.TEST_DATABASE_URL;
assert(connectionString, 'Explicit disposable TEST_DATABASE_URL is required');
const url = new URL(connectionString);
assert(['postgres:', 'postgresql:'].includes(url.protocol));
assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
assert.match(url.pathname, /^\/fp_[a-z0-9_]+$/);
const schema = `fp_result_races_${process.pid}_${Date.now()}`;
const admin = new Pool({ connectionString, max: 2 });
const pool = new Pool({ connectionString, options: `-c search_path=${schema} -c statement_timeout=10000`, max: 8 });
const community = randomUUID(); let created = false;
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`); created = true; await migrate(pool);
  await pool.query('INSERT INTO communities VALUES($1,$2)', [community, 'Independent synthetic Result review']);
});
after(async () => { await pool.end(); try { if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); } });

type Owner = { actor: Actor; scope: string; principal: string };
async function owner(): Promise<Owner> {
  const id = randomUUID(), session = randomUUID();
  const row = (await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Independent human','synthetic',$4) RETURNING *`, [id, community, id + '@example.invalid', randomUUID()])).rows[0];
  await pool.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')", [session, id]);
  const actor = { ...row, session_hash: session, csrf_token: 'synthetic' } as Actor;
  const context = await withMemberScope(pool, { actor, scope: 'personal' }, async () => {}, async (_q, ctx) => ctx);
  return { actor, scope: context.scope.scope_id, principal: context.subject_principal.principal_id };
}
async function work(o: Owner) {
  const id = randomUUID();
  await pool.query(`INSERT INTO work_items(work_item_id,owner_ref,title,objective,state,work_mode,scope_id,owner_principal_id,participation_terms_revision)
    VALUES($1,$2,'Synthetic Work','Independent SQL boundary','draft','personal_execution',$3,$4,NULL)`, [id, o.actor.user_id, o.scope, o.principal]);
  return id;
}
async function stored(o: Owner, workId: string, expected = '1') {
  const asset = randomUUID(), representation = randomUUID(), intent = randomUUID();
  await pool.query(`INSERT INTO assets(asset_id,scope_id,owner_principal_id,owner_user_id,purpose,policy_revision,representation_id)
    VALUES($1,$2,$3,$4,'work.private-draft','synthetic-independent-v1',$5)`, [asset, o.scope, o.principal, o.actor.user_id, representation]);
  await pool.query(`INSERT INTO asset_upload_intents(intent_id,asset_id,representation_id,scope_id,owner_principal_id,target_user_id,
    purpose,policy_revision,prepare_key,request_digest,source_content_type,source_byte_size,source_sha256,expected_version,reserved_bytes,expires_at,target_kind,target_work_id)
    VALUES($1,$2,$3,$4,$5,$6,'work.private-draft','synthetic-independent-v1',$7,$8,'text/plain',4,$8,$9,262144,clock_timestamp()+interval '1 hour','work.private-result',$10)`,
  [intent, asset, representation, o.scope, o.principal, o.actor.user_id, randomUUID(), 'a'.repeat(64), expected, workId]);
  await pool.query(`UPDATE asset_upload_intents SET state='processing',fence=1,lease_token=$2,lease_expires_at=clock_timestamp()+interval '5 minutes' WHERE intent_id=$1`, [intent, randomUUID()]);
  await pool.query(`INSERT INTO asset_objects(asset_id,scope_id,representation_id,purpose,variant,content_type,byte_size,content_sha256,transform_version,policy_revision)
    VALUES($1,$2,$3,'work.private-draft','draft','text/plain',4,$4,'private-text.utf8.v1','synthetic-independent-v1')`, [asset, o.scope, representation, 'a'.repeat(64)]);
  await pool.query("UPDATE asset_upload_intents SET state='stored' WHERE intent_id=$1", [intent]);
  await pool.query("UPDATE assets SET state='ready',ready_at=clock_timestamp() WHERE asset_id=$1", [asset]);
  return intent;
}
async function append(q: PoolClient, result: string, intent: string, ignore = false) {
  return q.query(`INSERT INTO private_work_results(result_id,intent_id) VALUES($1,$2) ${ignore ? 'ON CONFLICT DO NOTHING' : ''}`, [result, intent]);
}
async function finish(q: PoolClient, intent: string) {
  await q.query("UPDATE asset_upload_intents SET state='finalized',finalized_at=clock_timestamp() WHERE intent_id=$1", [intent]);
}
async function version(id: string) { return (await pool.query('SELECT aggregate_version FROM work_items WHERE work_item_id=$1', [id])).rows[0].aggregate_version; }
async function blockedBy(pid: number) {
  for (let i = 0; i < 250; i++) {
    if ((await admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) yes', [pid])).rows[0].yes) return;
    await delay(10);
  }
  assert.fail('Expected actual PostgreSQL blocking, not timer-only interleaving');
}

test('RESULT-INDEPENDENT-01 suppressed conflict cannot advance another Work without Result/finalization', async () => {
  const o = await owner(), first = await work(o), second = await work(o);
  const a = await stored(o, first), b = await stored(o, second), result = randomUUID(), q = await pool.connect();
  try {
    await q.query('BEGIN'); await append(q, result, a); await finish(q, a); await q.query('COMMIT');
    await q.query('BEGIN'); assert.equal((await append(q, result, b, true)).rowCount, 0); await q.query('COMMIT');
  } finally { await q.query('ROLLBACK'); q.release(); }
  assert.equal(await version(second), '1', 'No Result row means no real Work mutation');
  assert.equal((await pool.query('SELECT state FROM asset_upload_intents WHERE intent_id=$1', [b])).rows[0].state, 'stored');
  assert.equal((await pool.query('SELECT count(*)::int n FROM private_work_results WHERE work_item_id=$1', [second])).rows[0].n, 0);
});

test('RESULT-INDEPENDENT-02 actual concurrent uniqueness conflict cannot leak Work CAS', async () => {
  const o = await owner(), first = await work(o), second = await work(o);
  const a = await stored(o, first), b = await stored(o, second), result = randomUUID();
  const winner = await pool.connect(), loser = await pool.connect(); let pending: ReturnType<typeof append> | undefined;
  try {
    await winner.query('BEGIN'); await loser.query('BEGIN');
    const pid = (await winner.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await append(winner, result, a); await finish(winner, a);
    pending = append(loser, result, b, true); void pending.catch(() => undefined);
    await blockedBy(pid); await winner.query('COMMIT'); assert.equal((await pending).rowCount, 0); await loser.query('COMMIT');
  } finally {
    await winner.query('ROLLBACK'); await pending?.catch(() => undefined); await loser.query('ROLLBACK'); winner.release(); loser.release();
  }
  assert.equal(await version(first), '2'); assert.equal(await version(second), '1');
});

test('RESULT-INDEPENDENT-03 same-Work conflict preserves existing current pointer and exact version', async () => {
  const o = await owner(), id = await work(o), a = await stored(o, id), result = randomUUID(), q = await pool.connect();
  try {
    await q.query('BEGIN'); await append(q, result, a); await finish(q, a); await q.query('COMMIT');
    const before = (await q.query('SELECT * FROM private_work_result_targets WHERE work_item_id=$1', [id])).rows[0];
    const b = await stored(o, id, '2');
    await q.query('BEGIN'); assert.equal((await append(q, result, b, true)).rowCount, 0); await q.query('COMMIT');
    assert.deepEqual((await q.query('SELECT * FROM private_work_result_targets WHERE work_item_id=$1', [id])).rows[0], before);
    assert.equal(await version(id), '2');
  } finally { await q.query('ROLLBACK'); q.release(); }
});

test('RESULT-INDEPENDENT-04 lease expiry during actual target lock wait cannot publish a Result', async () => {
  const o = await owner(), id = await work(o), intent = await stored(o, id);
  const blocker = await pool.connect(), writer = await pool.connect(); let pending: ReturnType<typeof append> | undefined;
  try {
    await pool.query("UPDATE asset_upload_intents SET lease_expires_at=clock_timestamp()+interval '500 milliseconds' WHERE intent_id=$1", [intent]);
    await blocker.query('BEGIN'); await writer.query('BEGIN');
    const pid = (await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await blocker.query('SELECT work_item_id FROM work_items WHERE work_item_id=$1 FOR UPDATE', [id]);
    pending = append(writer, randomUUID(), intent); void pending.catch(() => undefined); await blockedBy(pid);
    let expired = false;
    for (let i = 0; i < 250; i++) {
      expired = (await pool.query('SELECT lease_expires_at<=clock_timestamp() expired FROM asset_upload_intents WHERE intent_id=$1', [intent])).rows[0].expired;
      if (expired) break;
      await delay(10);
    }
    assert(expired, 'Observe database clock expiry before releasing the lock');
    await blocker.query('COMMIT'); await assert.rejects(pending, error => (error as {code?: string}).code === '23514');
  } finally {
    await blocker.query('ROLLBACK'); await pending?.catch(() => undefined); await writer.query('ROLLBACK'); blocker.release(); writer.release();
  }
  assert.equal(await version(id), '1');
  assert.equal((await pool.query('SELECT count(*)::int n FROM private_work_results WHERE work_item_id=$1', [id])).rows[0].n, 0);
});
