import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import { createPool } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import type { Actor } from '../../modules/identity-membership/service.js';
import { createAssetMaintenance } from '../../modules/assets/maintenance.js';
import { FakeObjectStore } from '../../packages/asset-storage/fake-store.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('Result schema tests require explicit isolated TEST_DATABASE_URL.');
const schema = `fp_result_schema_${process.pid}_${Date.now()}`;
const admin = createPool(connectionString), pool = new Pool({ connectionString, options: `-c search_path=${schema} -c statement_timeout=10000`, max: 12 });
const community = randomUUID(), hash = 'a'.repeat(64); let created = false;
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); created = true; await migrate(pool); });
after(async () => { await pool.end(); if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(async () => {
  await pool.query('TRUNCATE communities,asset_backup_captures CASCADE');
  await pool.query("INSERT INTO communities VALUES($1,'Synthetic result community')", [community]);
});
const code = (expected: string) => (error: unknown) => (error as { code?: string })?.code === expected;
type Query = Pick<PoolClient, 'query'>;
type Owner = { user: string; principal: string; scope: string; work: string };
type Artifact = { asset: string; representation: string; purpose: string };
async function insert(q: Query, table: string, row: Record<string, unknown>) {
  const columns = Object.keys(row); assert([table, ...columns].every(name => /^[a-z_][a-z_0-9]*$/.test(name)));
  return q.query(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, Object.values(row));
}
async function owner(q: Pool = pool): Promise<Owner> {
  const user = randomUUID(), session = randomUUID(), work = randomUUID();
  const row = (await q.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic human','synthetic',$4) RETURNING *`, [user, community, user + '@example.invalid', randomUUID()])).rows[0];
  await q.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')", [session, user]);
  const actor = { ...row, session_hash: session, csrf_token: 'synthetic' } as Actor;
  const ctx = await withMemberScope(q, { actor, scope: 'personal' }, async () => {}, async (_q, context) => context);
  const f = { user, work, principal: ctx.subject_principal.principal_id, scope: ctx.scope.scope_id };
  await privateWork(f, work, q); return f;
}
async function privateWork(f: Owner, id = randomUUID(), q: Query = pool) {
  await q.query(`INSERT INTO work_items(work_item_id,owner_ref,title,objective,state,work_mode,scope_id,owner_principal_id,participation_terms_revision)
    VALUES($1,$2,'Synthetic purpose','Synthetic objective','draft','personal_execution',$3,$4,NULL)`, [id, f.user, f.scope, f.principal]);
  return id;
}
async function artifact(f: Owner, purpose = 'work.private-draft', q: Query = pool): Promise<Artifact> {
  const a = { asset: randomUUID(), representation: randomUUID(), purpose };
  await insert(q, 'assets', { asset_id: a.asset, scope_id: f.scope, owner_principal_id: f.principal, owner_user_id: f.user,
    purpose, policy_revision: 'synthetic-text-v1', representation_id: a.representation });
  return a;
}
function objectRow(f: Owner, a: Artifact) {
  const avatar = a.purpose === 'member.avatar';
  return { asset_id: a.asset, scope_id: f.scope, representation_id: a.representation, purpose: a.purpose,
    variant: avatar ? 'avatar' : 'draft', content_type: avatar ? 'image/webp' : 'text/plain', byte_size: 4,
    content_sha256: hash, transform_version: avatar ? 'avatar.webp.v1' : 'private-text.utf8.v1', policy_revision: 'synthetic-text-v1' };
}
function intentRow(f: Owner, a: Artifact, expected = '1') {
  const avatar = a.purpose === 'member.avatar';
  return { intent_id: randomUUID(), asset_id: a.asset, representation_id: a.representation, scope_id: f.scope, owner_principal_id: f.principal,
    target_user_id: f.user, target_kind: avatar ? 'member.avatar' : 'work.private-result', target_work_id: avatar ? null : f.work,
    purpose: a.purpose, policy_revision: 'synthetic-text-v1', prepare_key: randomUUID(), request_digest: hash,
    source_content_type: avatar ? 'image/png' : 'text/plain', source_byte_size: 4, source_sha256: hash,
    expected_version: expected, reserved_bytes: avatar ? 131072 : 262144, expires_at: new Date(Date.now() + 3600000) };
}
async function avatarTarget(f: Owner, q: Query = pool) {
  await q.query('INSERT INTO member_avatars(user_id,community_id) VALUES($1,$2)', [f.user, community]);
  await q.query('INSERT INTO member_avatar_asset_targets(user_id,scope_id,owner_principal_id) VALUES($1,$2,$3)', [f.user, f.scope, f.principal]);
}
async function stored(f: Owner, expected = '1', q: Query = pool) {
  const a = await artifact(f, 'work.private-draft', q), row = intentRow(f, a, expected);
  await insert(q, 'asset_upload_intents', row);
  await q.query(`UPDATE asset_upload_intents SET state='processing',fence=1,lease_token=$2,lease_expires_at=clock_timestamp()+interval '10 minutes'
    WHERE intent_id=$1`, [row.intent_id, randomUUID()]);
  await insert(q, 'asset_objects', objectRow(f, a));
  await q.query("UPDATE asset_upload_intents SET state='stored' WHERE intent_id=$1", [row.intent_id]);
  await q.query("UPDATE assets SET state='ready',ready_at=clock_timestamp() WHERE asset_id=$1", [a.asset]);
  return { ...a, intent: row.intent_id };
}
async function append(q: Query, intent: string) {
  return (await q.query('INSERT INTO private_work_results(result_id,intent_id) VALUES($1,$2) RETURNING *', [randomUUID(), intent])).rows[0];
}
async function finish(q: Query, intent: string) {
  await q.query("UPDATE asset_upload_intents SET state='finalized',finalized_at=clock_timestamp() WHERE intent_id=$1", [intent]);
}
async function publish(intent: string) {
  const q = await pool.connect();
  try { await q.query('BEGIN'); const result = await append(q, intent); await finish(q, intent); await q.query('COMMIT'); return result; }
  finally { await q.query('ROLLBACK'); q.release(); }
}
async function version(work: string) { return (await pool.query('SELECT aggregate_version FROM work_items WHERE work_item_id=$1', [work])).rows[0].aggregate_version; }
async function blockedBy(pid: number) {
  for (let i = 0; i < 250; i++) {
    if ((await admin.query('SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid])).rows[0].n) return;
    await delay(10);
  }
  assert.fail('Expected an actual blocked PostgreSQL backend.');
}

test('RESULT-SCHEMA-01 old avatar SQL defaults and profile remain valid', async () => {
  const f = await owner(); await avatarTarget(f); const a = await artifact(f, 'member.avatar');
  const { purpose: _p, variant: _v, ...object } = objectRow(f, a); await insert(pool, 'asset_objects', object);
  const { purpose: _ip, target_kind: _tk, target_work_id: _tw, reserved_bytes: _rb, ...row } = intentRow(f, a);
  const result = (await insert(pool, 'asset_upload_intents', row)).rows[0];
  assert.equal(result.purpose, 'member.avatar'); assert.equal(result.target_kind, 'member.avatar');
  assert.equal(result.avatar_target_user_id, f.user); assert.equal(result.target_work_id, null); assert.equal(result.work_mode, null);
  assert.equal(result.reserved_bytes, 131072);
});
test('RESULT-SCHEMA-02 avatar rejects retain exact MIME, transform, variant and 128KiB cap', async () => {
  const f = await owner();
  for (const change of [{ byte_size: 131073 }, { byte_size: 0 }, { content_type: 'image/png' }, { content_type: 'text/plain' },
    { variant: 'draft' }, { transform_version: 'private-text.utf8.v1' }]) {
    const a = await artifact(f, 'member.avatar'); await assert.rejects(insert(pool, 'asset_objects', { ...objectRow(f, a), ...change }), code('23514'));
  }
});
test('RESULT-SCHEMA-03 private text allows exactly bounded plain/markdown representations only', async () => {
  const f = await owner();
  for (const mime of ['text/plain', 'text/markdown']) {
    const a = await artifact(f); await insert(pool, 'asset_objects', { ...objectRow(f, a), content_type: mime, byte_size: 262144 });
  }
  for (const change of [{ byte_size: 262145 }, { byte_size: 0 }, { content_type: 'text/html' }, { content_type: 'application/pdf' },
    { variant: 'avatar' }, { transform_version: 'avatar.webp.v1' }]) {
    const a = await artifact(f); await assert.rejects(insert(pool, 'asset_objects', { ...objectRow(f, a), ...change }), code('23514'));
  }
});
test('RESULT-SCHEMA-04 representation purpose is bound to actual Asset identity', async () => {
  const f = await owner(), a = await artifact(f, 'member.avatar');
  await assert.rejects(insert(pool, 'asset_objects', objectRow(f, { ...a, purpose: 'work.private-draft' })), code('23503'));
});
test('RESULT-SCHEMA-05 private intent has exact Work owner without a fake avatar target', async () => {
  const f = await owner(), a = await artifact(f), row = (await insert(pool, 'asset_upload_intents', intentRow(f, a))).rows[0];
  assert.equal(row.avatar_target_user_id, null); assert.equal(row.work_mode, 'personal_execution');
  assert.equal((await pool.query('SELECT count(*)::int n FROM member_avatars')).rows[0].n, 0);
});
test('RESULT-SCHEMA-06 target discriminators, source caps and reservations cannot be mixed', async () => {
  const f = await owner(); await avatarTarget(f);
  for (const change of [{ target_work_id: null }, { target_kind: 'member.avatar' }, { purpose: 'member.avatar' },
    { source_content_type: 'image/png' }, { source_byte_size: 262145 }, { reserved_bytes: 131072 }]) {
    const a = await artifact(f); await assert.rejects(insert(pool, 'asset_upload_intents', { ...intentRow(f, a), ...change }), code('23514'));
  }
  for (const change of [{ target_work_id: f.work }, { source_byte_size: 2097153 }, { reserved_bytes: 262144 }]) {
    const a = await artifact(f, 'member.avatar'); await assert.rejects(insert(pool, 'asset_upload_intents', { ...intentRow(f, a), ...change }), code('23514'));
  }
});
test('RESULT-SCHEMA-07 peer Work, owner and scope substitutions fail actual composite FKs', async () => {
  const f = await owner(), peer = await owner();
  for (const change of [{ target_work_id: peer.work }, { target_user_id: peer.user }, { scope_id: peer.scope }, { owner_principal_id: peer.principal }]) {
    const a = await artifact(f); await assert.rejects(insert(pool, 'asset_upload_intents', { ...intentRow(f, a), ...change }), code('23503'));
  }
});
test('RESULT-SCHEMA-08 typed intent routing and stored object identity remain immutable', async () => {
  const f = await owner(), a = await stored(f), another = await privateWork(f);
  await assert.rejects(pool.query('UPDATE asset_upload_intents SET target_work_id=$2 WHERE intent_id=$1', [a.intent, another]), code('23514'));
  await assert.rejects(pool.query("UPDATE asset_upload_intents SET target_kind='member.avatar' WHERE intent_id=$1", [a.intent]), code('23514'));
  await assert.rejects(pool.query("UPDATE assets SET purpose='member.avatar' WHERE asset_id=$1", [a.asset]), code('23514'));
  await assert.rejects(pool.query("UPDATE asset_objects SET content_type='text/markdown' WHERE asset_id=$1", [a.asset]), code('23514'));
});
test('RESULT-SCHEMA-09 append derives human identity, advances only real Work and publishes typed pointer', async () => {
  const f = await owner(), a = await stored(f), r = await publish(a.intent);
  assert.equal(r.provenance, 'human'); assert.equal(r.owner_principal_id, f.principal); assert.equal(r.owner_user_id, f.user);
  assert.equal(r.work_item_id, f.work); assert.equal(r.scope_id, f.scope); assert.equal(r.revision, '1'); assert.equal(r.work_version, '2');
  assert.equal(await version(f.work), '2');
  const pointer = (await pool.query('SELECT * FROM private_work_result_targets WHERE work_item_id=$1', [f.work])).rows[0];
  assert.equal(pointer.result_id, r.result_id); assert.equal(pointer.linked_at_work_version, '2');
  for (const table of ['work_claims', 'contributions', 'work_benefit_observations', 'transition_journal', 'outbox', 'scoped_command_receipts']) {
    assert.equal((await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0);
  }
});
test('RESULT-SCHEMA-10 caller cannot self-assign provenance, owner, result revision or Work version', async () => {
  const f = await owner(), a = await stored(f);
  for (const change of [{ owner_principal_id: f.principal }, { work_item_id: f.work }, { revision: 1 }, { work_version: 2 }]) {
    await assert.rejects(insert(pool, 'private_work_results', { result_id: randomUUID(), intent_id: a.intent, ...change }), code('23514'));
  }
  await assert.rejects(insert(pool, 'private_work_results', { result_id: randomUUID(), intent_id: a.intent, provenance: 'ai' }), code('428C9'));
  assert.equal(await version(f.work), '1');
});
test('RESULT-SCHEMA-11 avatar upload cannot become a human Work Result', async () => {
  const f = await owner(); await avatarTarget(f); const a = await artifact(f, 'member.avatar'), row = intentRow(f, a);
  await insert(pool, 'asset_upload_intents', row); await assert.rejects(append(pool, row.intent_id), code('23514'));
});
test('RESULT-SCHEMA-12 absent stored evidence, expired lease and archived Work cannot publish', async () => {
  const f = await owner(), a = await artifact(f), row = intentRow(f, a); await insert(pool, 'asset_upload_intents', row);
  await assert.rejects(append(pool, row.intent_id), code('23514'));
  const b = await stored(f); await pool.query("UPDATE asset_upload_intents SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE intent_id=$1", [b.intent]);
  await assert.rejects(append(pool, b.intent), code('23514'));
  const c = await stored(f); await pool.query("UPDATE work_items SET state='archived',aggregate_version=aggregate_version+1 WHERE work_item_id=$1", [f.work]);
  await assert.rejects(append(pool, c.intent), code('23514')); assert.equal(await version(f.work), '2');
});
test('RESULT-SCHEMA-13 missing intent finalization rolls Result, pointer and Work increment back at commit', async () => {
  const f = await owner(), a = await stored(f), q = await pool.connect();
  try { await q.query('BEGIN'); await append(q, a.intent); await assert.rejects(q.query('COMMIT'), code('23514')); }
  finally { await q.query('ROLLBACK'); q.release(); }
  assert.equal(await version(f.work), '1'); assert.equal((await pool.query('SELECT count(*)::int n FROM private_work_results')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM private_work_result_targets')).rows[0].n, 0);
});
test('RESULT-SCHEMA-14 published history cannot update, delete, replay INSERT or rebind its target', async () => {
  const f = await owner(), a = await stored(f), r = await publish(a.intent);
  await assert.rejects(pool.query('UPDATE private_work_results SET revision=revision+1 WHERE result_id=$1', [r.result_id]), code('23514'));
  await assert.rejects(pool.query('DELETE FROM private_work_results WHERE result_id=$1', [r.result_id]), code('23514'));
  await assert.rejects(append(pool, a.intent), code('23514'));
  await assert.rejects(pool.query('DELETE FROM private_work_result_targets WHERE work_item_id=$1', [f.work]), code('23514'));
  assert.equal(await version(f.work), '2');
});
test('RESULT-SCHEMA-15 immutable revision ordering is independent history, not a second version authority', async () => {
  const f = await owner(), a = await stored(f), first = await publish(a.intent);
  await pool.query("UPDATE work_items SET objective='Human edited purpose',aggregate_version=aggregate_version+1 WHERE work_item_id=$1", [f.work]);
  const b = await stored(f, '3'), second = await publish(b.intent);
  assert.equal(second.revision, '2'); assert.equal(second.work_version, '4'); assert.equal(await version(f.work), '4');
  await pool.query("UPDATE assets SET state='retired',retired_at=clock_timestamp() WHERE asset_id=$1", [a.asset]);
  assert.equal((await pool.query('SELECT work_version FROM private_work_results WHERE result_id=$1', [first.result_id])).rows[0].work_version, '2');
  await assert.rejects(pool.query("UPDATE assets SET state='retired',retired_at=clock_timestamp() WHERE asset_id=$1", [b.asset]), code('23503'));
});
test('RESULT-SCHEMA-16 a historical pointer cannot be reattached or cleared without a new lifecycle', async () => {
  const f = await owner(), a = await stored(f), first = await publish(a.intent), b = await stored(f, '2'); await publish(b.intent);
  await assert.rejects(pool.query('UPDATE private_work_result_targets SET result_id=$2,asset_id=$3,linked_at_work_version=2 WHERE work_item_id=$1', [f.work, first.result_id, a.asset]), code('23514'));
  await assert.rejects(pool.query('UPDATE private_work_result_targets SET result_id=NULL,asset_id=NULL,linked_at_work_version=NULL WHERE work_item_id=$1', [f.work]), code('23514'));
});
test('RESULT-SCHEMA-17 an existing human Work edit wins against stale upload expected version', async () => {
  const f = await owner(), a = await stored(f);
  await pool.query('UPDATE work_items SET aggregate_version=aggregate_version+1 WHERE work_item_id=$1', [f.work]);
  await assert.rejects(publish(a.intent), code('P0412')); assert.equal(await version(f.work), '2');
  assert.equal((await pool.query('SELECT count(*)::int n FROM private_work_results')).rows[0].n, 0);
});
test('RESULT-SCHEMA-18 two actual concurrent Result appends serialize on Work; only one expected version wins', async () => {
  const f = await owner(), a = await stored(f), b = await stored(f), q = await pool.connect();
  let pending: Promise<unknown> | undefined;
  try {
    await q.query('BEGIN'); const pid = (await q.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await append(q, a.intent); pending = publish(b.intent); void pending.catch(() => {});
    await blockedBy(pid); await finish(q, a.intent); await q.query('COMMIT'); await assert.rejects(pending, code('P0412'));
  } finally { await q.query('ROLLBACK'); q.release(); await pending?.catch(() => {}); }
  assert.equal(await version(f.work), '2'); assert.equal((await pool.query('SELECT count(*)::int n FROM private_work_results')).rows[0].n, 1);
});
test('RESULT-SCHEMA-19 archive committed during real row-lock wait prevents any later append', async () => {
  const f = await owner(), a = await stored(f), q = await pool.connect(); let pending: Promise<unknown> | undefined;
  try {
    await q.query('BEGIN'); const pid = (await q.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await q.query("UPDATE work_items SET state='archived',aggregate_version=aggregate_version+1 WHERE work_item_id=$1", [f.work]);
    pending = publish(a.intent); void pending.catch(() => {}); await blockedBy(pid); await q.query('COMMIT');
    await assert.rejects(pending, code('23514'));
  } finally { await q.query('ROLLBACK'); q.release(); await pending?.catch(() => {}); }
  assert.equal(await version(f.work), '2');
});
test('RESULT-SCHEMA-20 multi-row same-Work append with one expected version rolls the entire statement back', async () => {
  const f = await owner(), a = await stored(f), b = await stored(f);
  await assert.rejects(pool.query('INSERT INTO private_work_results(result_id,intent_id) VALUES($1,$2),($3,$4)',
    [randomUUID(), a.intent, randomUUID(), b.intent]), code('23505'));
  assert.equal(await version(f.work), '1'); assert.equal((await pool.query('SELECT count(*)::int n FROM private_work_results')).rows[0].n, 0);
});
test('RESULT-SCHEMA-21 a transaction failure after pointer/intent publication also rolls real Work back', async () => {
  const f = await owner(), a = await stored(f), q = await pool.connect();
  try {
    await q.query('BEGIN'); await append(q, a.intent); await finish(q, a.intent);
    await assert.rejects(q.query('SELECT 1/0'), code('22012')); await q.query('ROLLBACK');
  } finally { await q.query('ROLLBACK'); q.release(); }
  assert.equal(await version(f.work), '1'); assert.equal((await pool.query('SELECT state FROM asset_upload_intents WHERE intent_id=$1', [a.intent])).rows[0].state, 'stored');
  assert.equal((await publish(a.intent)).work_version, '2');
});
test('RESULT-SCHEMA-22 private GC is explicitly denied even with elapsed retention and no references', async () => {
  const f = await owner(), a = { asset: randomUUID(), representation: randomUUID() };
  await insert(pool, 'assets', { asset_id: a.asset, representation_id: a.representation, scope_id: f.scope,
    owner_principal_id: f.principal, owner_user_id: f.user, purpose: 'work.private-draft', policy_revision: 'synthetic-text-v1',
    created_at: new Date(Date.now() - 3600000) });
  await pool.query(`UPDATE asset_maintenance_policy SET enabled=true,revision='synthetic-maint',orphan_retention_seconds=1,
    retired_retention_seconds=1,delete_lease_seconds=30,capture_seconds=30,pin_seconds=30,max_capture_objects=10`);
  await assert.rejects(pool.query(`INSERT INTO asset_deletion_tombstones(asset_id,policy_revision,lease_token,lease_expires_at)
    VALUES($1,'synthetic-maint',$2,clock_timestamp()+interval '10 seconds')`, [a.asset, randomUUID()]), code('23514'));
  assert.equal((await pool.query('SELECT deletion_fence FROM assets WHERE asset_id=$1', [a.asset])).rows[0].deletion_fence, '0');
});
test('RESULT-SCHEMA-23 reference capture pins 256KiB text, preserving exact verified metadata and avatar caps', async () => {
  const f = await owner(), text = await artifact(f), avatar = await artifact(f, 'member.avatar');
  await insert(pool, 'asset_objects', { ...objectRow(f, text), byte_size: 262144 }); await insert(pool, 'asset_objects', objectRow(f, avatar));
  await pool.query(`UPDATE asset_maintenance_policy SET enabled=true,revision='synthetic-maint',orphan_retention_seconds=1,
    retired_retention_seconds=1,delete_lease_seconds=30,capture_seconds=30,pin_seconds=30,max_capture_objects=10`);
  const api = createAssetMaintenance(pool, { store: new FakeObjectStore(), enabled: true });
  const capture = await api.beginCapture({ sourceRelease: 'b'.repeat(40), sourceSchema: '084-synthetic' });
  await api.captureReferences(capture.captureId);
  const rows = (await pool.query('SELECT asset_id,byte_size FROM asset_backup_pins WHERE capture_id=$1', [capture.captureId])).rows;
  assert.equal(rows.find(r => r.asset_id === text.asset)?.byte_size, 262144);
  assert.equal(rows.find(r => r.asset_id === avatar.asset)?.byte_size, 4);
  const next = await api.beginCapture({ sourceRelease: 'b'.repeat(40), sourceSchema: '084-synthetic' });
  await assert.rejects(insert(pool, 'asset_backup_pins', { capture_id: next.captureId, asset_id: avatar.asset, scope_id: f.scope,
    representation_id: avatar.representation, policy_revision: 'synthetic-text-v1', byte_size: 262144, content_sha256: hash }), code('23503'));
});
test('RESULT-SCHEMA-24 083 avatar rows upgrade without altering any old field or receipt', async () => {
  const upgrade = `${schema}_upgrade`, q = new Pool({ connectionString, options: `-c search_path=${upgrade}` });
  await admin.query(`CREATE SCHEMA ${upgrade}`);
  try {
    const files = (await readdir(new URL('../../migrations/', import.meta.url))).filter(x => /^\d+.*\.sql$/.test(x)).sort();
    for (const file of files.filter(x => Number(x.slice(0, 3)) <= 83)) await q.query(await readFile(new URL('../../migrations/' + file, import.meta.url), 'utf8'));
    await q.query("INSERT INTO communities VALUES($1,'Synthetic upgrade')", [community]);
    const f = await owner(q); await avatarTarget(f, q); const a = await artifact(f, 'member.avatar', q);
    const { purpose: _purpose, ...row } = objectRow(f, a); await insert(q, 'asset_objects', row);
    const { target_kind: _kind, target_work_id: _work, ...intent } = intentRow(f, a); await insert(q, 'asset_upload_intents', intent);
    await insert(q, 'command_receipts', { user_id: f.user, operation: 'synthetic.avatar', idempotency_key: randomUUID(),
      request_sha256: hash, response: { aggregate_version: '9007199254740993', unchanged: true } });
    const tables = ['users', 'work_items', 'assets', 'asset_objects', 'asset_upload_intents', 'member_avatars', 'member_avatar_asset_targets', 'command_receipts'];
    const snapshots = new Map<string, { columns: string; rows: unknown[] }>();
    for (const table of tables) {
      const names = (await q.query('SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum', [table])).rows.map(r => `"${r.attname}"`).join(',');
      snapshots.set(table, { columns: names, rows: (await q.query(`SELECT ${names} FROM ${table}`)).rows });
    }
    await q.query(await readFile(new URL('../../migrations/084_private_work_result_profiles.sql', import.meta.url), 'utf8'));
    for (const [table, snapshot] of snapshots) assert.deepEqual((await q.query(`SELECT ${snapshot.columns} FROM ${table}`)).rows, snapshot.rows, table);
    const fresh = await artifact(f, 'member.avatar', q), { purpose: _newPurpose, ...oldObject } = objectRow(f, fresh);
    await insert(q, 'asset_objects', oldObject);
  } finally { await q.end(); await admin.query(`DROP SCHEMA ${upgrade} CASCADE`); }
});

test('RESULT-SCHEMA-25 suppressed conflict cannot consume a Work version or create a placeholder target', async () => {
  const f = await owner(), a = await stored(f), first = await publish(a.intent), second = await stored(f, '2');
  const peer = await owner(), other = await stored(peer);
  for (const [intent, work, expected] of [[second.intent, f.work, '2'], [other.intent, peer.work, '1']]) {
    assert.equal((await pool.query('INSERT INTO private_work_results(result_id,intent_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [first.result_id, intent])).rowCount, 0);
    assert.equal(await version(work), expected);
  }
  assert.equal((await pool.query('SELECT count(*)::int n FROM private_work_result_targets WHERE work_item_id=$1', [peer.work])).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM private_work_results')).rows[0].n, 1);
});

test('RESULT-SCHEMA-26 multi-row distinct Work append commits each sole Work CAS and complete intent together', async () => {
  const f = await owner(), peer = await owner(), a = await stored(f), b = await stored(peer), q = await pool.connect();
  try {
    await q.query('BEGIN');
    const rows = (await q.query('INSERT INTO private_work_results(result_id,intent_id) VALUES($1,$2),($3,$4) RETURNING revision,work_version',
      [randomUUID(), a.intent, randomUUID(), b.intent])).rows;
    assert.deepEqual(rows, [{ revision: '1', work_version: '2' }, { revision: '1', work_version: '2' }]);
    await finish(q, a.intent); await finish(q, b.intent); await q.query('COMMIT');
  } finally { await q.query('ROLLBACK'); q.release(); }
  assert.equal(await version(f.work), '2'); assert.equal(await version(peer.work), '2');
});

test('RESULT-SCHEMA-27 even an ON CONFLICT no-op UPDATE cannot mutate immutable history or advance Work', async () => {
  const f = await owner(), a = await stored(f), first = await publish(a.intent), b = await stored(f, '2');
  await assert.rejects(pool.query(`INSERT INTO private_work_results(result_id,intent_id) VALUES($1,$2)
    ON CONFLICT(result_id) DO UPDATE SET created_at=private_work_results.created_at`, [first.result_id, b.intent]), code('23514'));
  assert.equal(await version(f.work), '2');
});

test('RESULT-SCHEMA-28 private intent cannot finalize without its successful Result append', async () => {
  const f = await owner(), a = await stored(f);
  await assert.rejects(finish(pool, a.intent), code('23514'));
  assert.equal((await pool.query('SELECT state FROM asset_upload_intents WHERE intent_id=$1', [a.intent])).rows[0].state, 'stored');
  assert.equal(await version(f.work), '1');
});

test('RESULT-SCHEMA-29 derived real Work versions above JS safe integer retain exact bigint identity', async () => {
  const f = await owner(); await pool.query('UPDATE work_items SET aggregate_version=$2 WHERE work_item_id=$1', [f.work, '9007199254740993']);
  const a = await stored(f, '9007199254740993'), r = await publish(a.intent);
  assert.equal(r.work_version, '9007199254740994'); assert.equal(await version(f.work), '9007199254740994'); assert.equal(r.revision, '1');
});

test('RESULT-SCHEMA-30 community Work and null owner cannot bypass the private target discriminator', async () => {
  const f = await owner(), id = randomUUID();
  await pool.query(`INSERT INTO work_items(work_item_id,community_id,owner_ref,title,objective,acceptance_criteria,gain,state,
    participation_terms,participation_terms_sha256,claim_window_expires_at,due_at)
    VALUES($1,$2,$3,'Community','Shared purpose','Shared criteria','Voluntary','open','{}',$4,clock_timestamp()+interval '1 hour',clock_timestamp()+interval '1 day')`,
  [id, community, f.user, hash]);
  for (const change of [{ target_work_id: id }, { owner_principal_id: null }, { scope_id: null }, { target_user_id: null }]) {
    const a = await artifact(f);
    await assert.rejects(insert(pool, 'asset_upload_intents', { ...intentRow(f, a), ...change }), code(change.target_work_id ? '23503' : '23502'));
  }
});
