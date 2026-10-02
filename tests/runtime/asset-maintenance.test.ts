import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { randomUUID, randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createPool } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import type { Actor } from '../../modules/identity-membership/service.js';
import { createAssetMaintenance } from '../../modules/assets/maintenance.js';
import { FakeObjectStore } from '../../packages/asset-storage/fake-store.js';
import { objectKey, sha256, type AssetObjectKey } from '../../packages/asset-storage/index.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('Asset maintenance requires explicit isolated TEST_DATABASE_URL.');
const schema = `fp_asset_maintenance_${process.pid}_${Date.now()}`;
const admin = createPool(connectionString), pool = new Pool({ connectionString, options: `-c search_path=${schema} -c statement_timeout=10000`, max: 12 });
const community = randomUUID(); let created = false;
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); created = true; await migrate(pool); });
after(async () => { await pool.end(); if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(async () => {
  await pool.query('TRUNCATE communities,asset_backup_captures CASCADE');
  await pool.query("INSERT INTO communities VALUES($1,'Synthetic maintenance community')", [community]);
  await pool.query(`UPDATE asset_maintenance_policy SET enabled=true,revision='synthetic-retention',orphan_retention_seconds=1,
    retired_retention_seconds=1,delete_lease_seconds=30,capture_seconds=30,pin_seconds=30,max_capture_objects=10`);
});
class Store extends FakeObjectStore {
  readonly deleted: AssetObjectKey[] = [];
  onDelete?: () => Promise<void>;
  override async delete(key: AssetObjectKey) { this.deleted.push(key); await this.onDelete?.(); return super.delete(key); }
}
function service(store = new Store()) { return { store, api: createAssetMaintenance(pool, { store, enabled: true }) }; }
const source = { sourceRelease: 'a'.repeat(40), sourceSchema: '082-test-synthetic' };
const code = (expected: string) => (error: unknown) => (error as { code?: string })?.code === expected;
function gate() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
async function blockedBy(pid: number) {
  for (let i = 0; i < 250; i++) {
    if ((await admin.query('SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid])).rows[0].n) return;
    await delay(10);
  }
  assert.fail('Expected real blocked PostgreSQL backend.');
}
async function fixture(store: Store, options: { retired?: boolean; pointer?: boolean; liveIntent?: boolean; withObject?: boolean } = {}) {
  const userId = randomUUID(), session = randomUUID(), assetId = randomUUID(), representationId = randomUUID();
  const user = (await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic maintenance owner','synthetic',$4) RETURNING *`, [userId, community, userId + '@example.invalid', randomUUID()])).rows[0];
  await pool.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')", [session, userId]);
  const actor = { ...user, session_hash: session, csrf_token: 'synthetic' } as Actor;
  const context = await withMemberScope(pool, { actor, scope: 'personal' }, async () => {}, async (_q, context) => context);
  const scopeId = context.scope.scope_id, principalId = context.subject_principal.principal_id;
  await pool.query('INSERT INTO member_avatars(user_id,community_id) VALUES($1,$2)', [userId, community]);
  await pool.query('INSERT INTO member_avatar_asset_targets(user_id,scope_id,owner_principal_id) VALUES($1,$2,$3)', [userId, scopeId, principalId]);
  await pool.query(`INSERT INTO assets(asset_id,scope_id,owner_principal_id,owner_user_id,policy_revision,representation_id,created_at)
    VALUES($1,$2,$3,$4,'synthetic-content',$5,clock_timestamp()-interval '1 hour')`, [assetId, scopeId, principalId, userId, representationId]);
  // GC tests use opaque synthetic object bytes, not image decoder evidence.
  const bytes = new Uint8Array([1, 3, 5, 7]), metadata = { contentType: 'image/webp' as const, byteSize: 4, sha256: await sha256(bytes), transformVersion: 'avatar.webp.v1' as const, policyRevision: 'synthetic-content' };
  const key = objectKey({ scopeId, assetId, representationId });
  if (options.withObject !== false) {
    await store.putImmutable(key, { bytes, metadata });
    await pool.query(`INSERT INTO asset_objects(asset_id,scope_id,representation_id,content_type,byte_size,content_sha256,transform_version,policy_revision)
      VALUES($1,$2,$3,'image/webp',4,$4,'avatar.webp.v1','synthetic-content')`, [assetId, scopeId, representationId, metadata.sha256]);
  }
  if (options.retired || options.pointer) await pool.query("UPDATE assets SET state='ready',ready_at=clock_timestamp()-interval '1 hour' WHERE asset_id=$1", [assetId]);
  if (options.retired) await pool.query("UPDATE assets SET state='retired',retired_at=clock_timestamp()-interval '1 hour' WHERE asset_id=$1", [assetId]);
  if (options.pointer) await pool.query('UPDATE member_avatar_asset_targets SET asset_id=$2,linked_at_version=1 WHERE user_id=$1', [userId, assetId]);
  if (options.liveIntent) await pool.query(`INSERT INTO asset_upload_intents(intent_id,asset_id,representation_id,scope_id,owner_principal_id,target_user_id,
    policy_revision,prepare_key,request_digest,source_content_type,source_byte_size,source_sha256,expected_version,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,'synthetic-content',$7,$8,'image/png',4,$8,1,clock_timestamp()+interval '1 hour')`,
  [randomUUID(), assetId, representationId, scopeId, principalId, userId, randomUUID(), metadata.sha256]);
  return { actor, assetId, scopeId, principalId, representationId, key, bytes, metadata };
}

test('ASSET-MAINT-01 application opt-in and complete DB policy are both required, without retention defaults', async () => {
  const s = service(), f = await fixture(s.store);
  const disabled = createAssetMaintenance(pool, { store: s.store });
  await assert.rejects(disabled.claimDelete(f.assetId), code('asset_maintenance_disabled'));
  await pool.query('UPDATE asset_maintenance_policy SET enabled=false');
  await assert.rejects(s.api.claimDelete(f.assetId), code('asset_maintenance_disabled'));
  await assert.rejects(pool.query('UPDATE asset_maintenance_policy SET enabled=true,orphan_retention_seconds=NULL'), code('23514'));
  assert.equal(s.store.deleted.length, 0);
});

test('ASSET-MAINT-02 live pointer, live intent and retention block both API and direct SQL deletion claims', async () => {
  const s = service(), pointed = await fixture(s.store, { pointer: true }), intent = await fixture(s.store, { liveIntent: true }), young = await fixture(s.store);
  await pool.query('UPDATE asset_maintenance_policy SET orphan_retention_seconds=86400');
  for (const f of [pointed, intent, young]) await assert.rejects(s.api.claimDelete(f.assetId), code('23514'));
  await assert.rejects(pool.query(`INSERT INTO asset_deletion_tombstones(asset_id,policy_revision,lease_token,lease_expires_at)
    VALUES($1,'synthetic-retention',$2,clock_timestamp()+interval '5 seconds')`, [pointed.assetId, randomUUID()]), code('23514'));
  assert.equal((await pool.query('SELECT count(*)::int n FROM asset_deletion_tombstones')).rows[0].n, 0);
});

test('ASSET-MAINT-03 expired orphan and retired object deletion leave permanent identity and observation only', async () => {
  const s = service();
  for (const retired of [false, true]) {
    const f = await fixture(s.store, { retired }), lease = await s.api.claimDelete(f.assetId);
    assert.equal((await pool.query('SELECT deletion_fence FROM assets WHERE asset_id=$1', [f.assetId])).rows[0].deletion_fence, '1');
    assert.deepEqual(await s.api.deleteObject(lease), { assetId: f.assetId, attempt: '1', observation: 'missing' });
    assert.equal(await s.store.head(f.key), null);
    assert.equal((await pool.query('SELECT count(*)::int n FROM asset_objects WHERE asset_id=$1', [f.assetId])).rows[0].n, 1);
    await assert.rejects(pool.query('UPDATE assets SET deletion_fence=0 WHERE asset_id=$1', [f.assetId]), code('23514'));
    await assert.rejects(pool.query('DELETE FROM asset_deletion_tombstones WHERE asset_id=$1', [f.assetId]), code('23514'));
  }
});

test('ASSET-MAINT-04 permanent fence rejects ready, pointer, new object and upload intent SQL paths', async () => {
  const s = service(), f = await fixture(s.store), empty = await fixture(s.store, { withObject: false });
  await s.api.claimDelete(f.assetId); await s.api.claimDelete(empty.assetId);
  await assert.rejects(pool.query("UPDATE assets SET state='ready',ready_at=clock_timestamp() WHERE asset_id=$1", [f.assetId]), code('23514'));
  await assert.rejects(pool.query('UPDATE member_avatar_asset_targets SET asset_id=$2,linked_at_version=1 WHERE user_id=$1', [f.actor.user_id, f.assetId]), code('23514'));
  await assert.rejects(pool.query(`INSERT INTO asset_objects(asset_id,scope_id,representation_id,content_type,byte_size,content_sha256,transform_version,policy_revision)
    VALUES($1,$2,$3,'image/webp',4,$4,'avatar.webp.v1','synthetic-content')`, [empty.assetId, empty.scopeId, empty.representationId, empty.metadata.sha256]), code('23514'));
  await assert.rejects(pool.query(`INSERT INTO asset_upload_intents(intent_id,asset_id,representation_id,scope_id,owner_principal_id,target_user_id,
    policy_revision,prepare_key,request_digest,source_content_type,source_byte_size,source_sha256,expected_version,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,'synthetic-content',$7,$8,'image/png',4,$8,1,clock_timestamp()+interval '1 hour')`,
  [randomUUID(), f.assetId, f.representationId, f.scopeId, f.principalId, f.actor.user_id, randomUUID(), f.metadata.sha256]), code('23514'));
});

test('ASSET-MAINT-05 old RR snapshot cannot attach after a committed deletion tuple fence', async () => {
  const s = service(), f = await fixture(s.store), q = await pool.connect();
  try {
    await q.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); await q.query('SELECT * FROM assets WHERE asset_id=$1', [f.assetId]);
    await s.api.claimDelete(f.assetId);
    await assert.rejects(q.query('UPDATE member_avatar_asset_targets SET asset_id=$2,linked_at_version=1 WHERE user_id=$1', [f.actor.user_id, f.assetId]), code('40001'));
  } finally { await q.query('ROLLBACK'); q.release(); }
});

test('ASSET-MAINT-06 old RR GC snapshot cannot miss a newly committed capture barrier', async () => {
  const s = service(), f = await fixture(s.store), q = await pool.connect();
  try {
    await q.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); await q.query('SELECT * FROM asset_maintenance_policy');
    await s.api.beginCapture(source);
    await assert.rejects(q.query(`INSERT INTO asset_deletion_tombstones(asset_id,policy_revision,lease_token,lease_expires_at)
      VALUES($1,'synthetic-retention',$2,clock_timestamp()+interval '5 seconds')`, [f.assetId, randomUUID()]), code('40001'));
  } finally { await q.query('ROLLBACK'); q.release(); }
});

test('ASSET-MAINT-07 object delete holds no owner, pointer, intent, asset or gate locks', async () => {
  const s = service(), f = await fixture(s.store), lease = await s.api.claimDelete(f.assetId), entered = gate(), release = gate();
  s.store.onDelete = async () => { entered.release(); await release.promise; };
  const pending = s.api.deleteObject(lease); void pending.catch(() => {});
  await Promise.race([entered.promise, pending.then(() => assert.fail('Missing storage barrier'))]);
  const q = await pool.connect();
  try {
    await q.query('BEGIN');
    await q.query('SELECT 1 FROM member_avatars WHERE user_id=$1 FOR UPDATE NOWAIT', [f.actor.user_id]);
    await q.query('SELECT 1 FROM member_avatar_asset_targets WHERE user_id=$1 FOR UPDATE NOWAIT', [f.actor.user_id]);
    await q.query('SELECT 1 FROM assets WHERE asset_id=$1 FOR UPDATE NOWAIT', [f.assetId]);
    await q.query('SELECT 1 FROM asset_maintenance_policy FOR UPDATE NOWAIT'); await q.query('COMMIT');
  } finally { await q.query('ROLLBACK'); q.release(); release.release(); }
  assert.equal((await pending).observation, 'missing');
});

test('ASSET-MAINT-08 late PUT may recreate bytes; permanent exact-key rescan deletes them again without reattach', async () => {
  const s = service(), f = await fixture(s.store, { withObject: false });
  assert.equal((await s.api.deleteObject(await s.api.claimDelete(f.assetId))).observation, 'missing');
  await s.store.putImmutable(f.key, { bytes: f.bytes, metadata: f.metadata }); // A delayed old worker.
  assert(await s.store.head(f.key));
  const retry = await s.api.claimDelete(f.assetId); assert.equal(retry.attempt, '2');
  assert.equal((await s.api.deleteObject(retry)).observation, 'missing');
  assert.deepEqual(s.store.deleted, [f.key, f.key]);
});

test('ASSET-MAINT-09 delete-before/delete-after failures are unknown, never success; safe retry reconciles exact key', async () => {
  const s = service();
  for (const fault of ['delete-before', 'delete-after'] as const) {
    const f = await fixture(s.store); s.store.failNext(fault);
    assert.equal((await s.api.deleteObject(await s.api.claimDelete(f.assetId))).observation, 'unknown');
    assert.equal((await s.api.deleteObject(await s.api.claimDelete(f.assetId))).observation, 'missing');
  }
});

test('ASSET-MAINT-10 stale delete lease may finish I/O but cannot overwrite newer attempt evidence', async () => {
  const s = service(), f = await fixture(s.store), old = await s.api.claimDelete(f.assetId), entered = gate(), release = gate();
  s.store.onDelete = async () => { entered.release(); await release.promise; };
  const pending = s.api.deleteObject(old); void pending.catch(() => {}); await entered.promise;
  await pool.query("UPDATE asset_deletion_tombstones SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE asset_id=$1", [f.assetId]);
  const next = await s.api.claimDelete(f.assetId); s.store.onDelete = undefined;
  assert.equal((await s.api.deleteObject(next)).observation, 'missing'); release.release();
  await assert.rejects(pending, code('asset_delete_lease_stale'));
  assert.equal((await pool.query('SELECT attempt FROM asset_deletion_tombstones WHERE asset_id=$1', [f.assetId])).rows[0].attempt, '2');
});

test('ASSET-MAINT-11 capture barrier protects before snapshot and pins protect after barrier transition', async () => {
  const s = service(), f = await fixture(s.store), capture = await s.api.beginCapture(source);
  await assert.rejects(s.api.claimDelete(f.assetId), code('23514'));
  assert.deepEqual(await s.api.captureReferences(capture.captureId), { captureId: capture.captureId, referenceCount: 1 });
  const references = await s.api.readReferences(capture.captureId);
  assert.equal(references.references[0].asset_id, f.assetId); assert.equal(references.references[0].content_sha256, f.metadata.sha256);
  assert.equal(references.sourceRelease, source.sourceRelease); assert(references.referenceSnapshot);
  assert(!JSON.stringify(references).includes(f.key));
  await assert.rejects(s.api.claimDelete(f.assetId), code('23514'));
  await s.api.releaseProtection(capture.captureId, 'release');
  assert.equal((await s.api.claimDelete(f.assetId)).attempt, '1');
});

test('ASSET-MAINT-12 over-limit reference capture rolls all pins back but leaves protective barrier', async () => {
  const s = service(), f = await fixture(s.store); await fixture(s.store);
  await pool.query('UPDATE asset_maintenance_policy SET max_capture_objects=1');
  const capture = await s.api.beginCapture(source);
  await assert.rejects(s.api.captureReferences(capture.captureId), code('asset_capture_limit'));
  assert.equal((await pool.query('SELECT count(*)::int n FROM asset_backup_pins')).rows[0].n, 0);
  await assert.rejects(s.api.claimDelete(f.assetId), code('23514'));
  await s.api.releaseProtection(capture.captureId, 'abort'); assert.equal((await s.api.claimDelete(f.assetId)).attempt, '1');
});

test('ASSET-MAINT-13 expiry fails closed: no renew or usable manifest and GC waits explicit reconciliation', async () => {
  const s = service(), f = await fixture(s.store), capture = await s.api.beginCapture(source);
  await s.api.captureReferences(capture.captureId);
  await pool.query("UPDATE asset_backup_captures SET pin_expires_at=clock_timestamp()-interval '1 second' WHERE capture_id=$1", [capture.captureId]);
  await assert.rejects(s.api.readReferences(capture.captureId), code('asset_capture_expired'));
  await assert.rejects(s.api.renewProtection(capture.captureId), code('asset_capture_expired'));
  await assert.rejects(s.api.claimDelete(f.assetId), code('23514'));
  await s.api.releaseProtection(capture.captureId, 'abort'); await s.api.claimDelete(f.assetId);
});

test('ASSET-MAINT-14 begin barrier never waits for owner rows and defeats GC already blocked on an owner', async () => {
  const s = service(), f = await fixture(s.store), lock = await pool.connect(); let pending: Promise<unknown> | undefined;
  try {
    await lock.query('BEGIN'); await lock.query('SELECT 1 FROM member_avatars WHERE user_id=$1 FOR UPDATE', [f.actor.user_id]);
    const pid = (await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    pending = s.api.claimDelete(f.assetId); void pending.catch(() => {}); await blockedBy(pid);
    const capture = await s.api.beginCapture(source); assert(capture.captureId);
    await lock.query('COMMIT'); await assert.rejects(pending, code('23514'));
  } finally { await lock.query('ROLLBACK'); lock.release(); await pending?.catch(() => {}); }
});

async function pausedPins(run: (pid: number, unlock: () => Promise<void>) => Promise<void>) {
  const lock = await pool.connect(), key = randomInt(10000, 2_000_000_000);
  await pool.query(`CREATE FUNCTION hold_synthetic_pin() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${key}); RETURN NEW; END; $$`);
  await pool.query('CREATE TRIGGER aaa_hold_synthetic_pin BEFORE INSERT ON asset_backup_pins FOR EACH ROW EXECUTE FUNCTION hold_synthetic_pin()');
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [key]);
    const pid = (await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await run(pid, async () => { await lock.query('SELECT pg_advisory_unlock($1)', [key]); });
  } finally {
    await lock.query('SELECT pg_advisory_unlock_all()'); lock.release();
    await pool.query('DROP TRIGGER aaa_hold_synthetic_pin ON asset_backup_pins'); await pool.query('DROP FUNCTION hold_synthetic_pin()');
  }
}

test('ASSET-MAINT-15 snapshot then pointer replacement still pins old representation before barrier release', async () => {
  const s = service(), f = await fixture(s.store, { pointer: true }), capture = await s.api.beginCapture(source);
  await pausedPins(async (pid, unlock) => {
    const pending = s.api.captureReferences(capture.captureId); void pending.catch(() => {});
    try {
      await blockedBy(pid); // The bounded reference snapshot has already run.
      await pool.query('UPDATE member_avatar_asset_targets SET asset_id=NULL,linked_at_version=NULL WHERE user_id=$1', [f.actor.user_id]);
      await pool.query("UPDATE assets SET state='retired',retired_at=clock_timestamp()-interval '1 hour' WHERE asset_id=$1", [f.assetId]);
      await assert.rejects(s.api.claimDelete(f.assetId), code('23514'));
      await unlock(); assert.equal((await pending).referenceCount, 1);
      assert.equal((await s.api.readReferences(capture.captureId)).references[0].asset_id, f.assetId);
      await assert.rejects(s.api.claimDelete(f.assetId), code('23514'));
    } finally { await unlock(); await pending.catch(() => {}); }
  });
});

test('ASSET-MAINT-16 release during paused pinning aborts all references and never certifies stale capture', async () => {
  const s = service(), f = await fixture(s.store), capture = await s.api.beginCapture(source);
  await pausedPins(async (pid, unlock) => {
    const pending = s.api.captureReferences(capture.captureId); void pending.catch(() => {});
    try {
      await blockedBy(pid); await s.api.releaseProtection(capture.captureId, 'abort');
      await unlock(); await assert.rejects(pending, code('23514'));
      assert.equal((await pool.query('SELECT count(*)::int n FROM asset_backup_pins')).rows[0].n, 0);
      await assert.rejects(s.api.readReferences(capture.captureId), code('asset_capture_expired'));
      await s.api.claimDelete(f.assetId);
    } finally { await unlock(); await pending.catch(() => {}); }
  });
});

test('ASSET-MAINT-17 capture expiry during a proven pin wait rolls back pins and keeps fail-closed barrier', async () => {
  const s = service(), f = await fixture(s.store);
  await pool.query('UPDATE asset_maintenance_policy SET capture_seconds=2');
  const capture = await s.api.beginCapture(source);
  await pausedPins(async (pid, unlock) => {
    const pending = s.api.captureReferences(capture.captureId); void pending.catch(() => {});
    try {
      await blockedBy(pid); let expired = false;
      for (let i = 0; i < 250; i++) {
        expired = (await pool.query('SELECT capture_expires_at<=clock_timestamp() expired FROM asset_backup_captures WHERE capture_id=$1', [capture.captureId])).rows[0].expired;
        if (expired) break; await delay(20);
      }
      assert(expired); await unlock(); await assert.rejects(pending, code('23514'));
      assert.equal((await pool.query('SELECT count(*)::int n FROM asset_backup_pins')).rows[0].n, 0);
      await assert.rejects(s.api.renewProtection(capture.captureId), code('asset_capture_expired'));
      await assert.rejects(s.api.claimDelete(f.assetId), code('23514'));
      await s.api.releaseProtection(capture.captureId, 'abort'); await s.api.claimDelete(f.assetId);
    } finally { await unlock(); await pending.catch(() => {}); }
  });
});

test('ASSET-MAINT-18 GC committed before capture gate produces an excluded fenced reference, not a dangling pin', async () => {
  const s = service(), f = await fixture(s.store), q = await pool.connect(); let pending: ReturnType<typeof s.api.beginCapture> | undefined;
  try {
    await q.query('BEGIN');
    await q.query(`INSERT INTO asset_deletion_tombstones(asset_id,policy_revision,lease_token,lease_expires_at)
      VALUES($1,'synthetic-retention',$2,clock_timestamp()+interval '5 seconds')`, [f.assetId, randomUUID()]);
    const pid = (await q.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    pending = s.api.beginCapture(source); void pending.catch(() => {}); await blockedBy(pid); await q.query('COMMIT');
    const capture = await pending;
    assert.equal((await s.api.captureReferences(capture.captureId)).referenceCount, 0);
    assert.equal((await s.api.readReferences(capture.captureId)).references.length, 0);
  } finally { await q.query('ROLLBACK'); q.release(); await pending?.catch(() => {}); }
});

test('ASSET-MAINT-19 PostgreSQL observation failure after delete retains fence and retry safely records absence', async () => {
  const s = service(), f = await fixture(s.store), lease = await s.api.claimDelete(f.assetId);
  await pool.query(`CREATE FUNCTION fail_delete_observation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic observation fault' USING ERRCODE='P0001'; END; $$`);
  await pool.query('CREATE TRIGGER aaa_fail_delete_observation BEFORE UPDATE ON asset_deletion_tombstones FOR EACH ROW EXECUTE FUNCTION fail_delete_observation()');
  try {
    await assert.rejects(s.api.deleteObject(lease), code('P0001'));
    assert.equal(await s.store.head(f.key), null);
    assert.equal((await pool.query('SELECT observation FROM asset_deletion_tombstones WHERE asset_id=$1', [f.assetId])).rows[0].observation, null);
  } finally { await pool.query('DROP TRIGGER aaa_fail_delete_observation ON asset_deletion_tombstones'); await pool.query('DROP FUNCTION fail_delete_observation()'); }
  assert.equal((await s.api.deleteObject(lease)).observation, 'missing');
});

test('ASSET-MAINT-20 metadata pins cannot change owner/content identity or be physically removed', async () => {
  const s = service(), f = await fixture(s.store), capture = await s.api.beginCapture(source);
  await assert.rejects(pool.query(`INSERT INTO asset_backup_pins(capture_id,asset_id,scope_id,representation_id,policy_revision,byte_size,content_sha256)
    VALUES($1,$2,$3,$4,'synthetic-content',5,$5)`, [capture.captureId, f.assetId, f.scopeId, f.representationId, f.metadata.sha256]), code('23503'));
  await s.api.captureReferences(capture.captureId);
  await assert.rejects(pool.query('UPDATE asset_backup_pins SET byte_size=5 WHERE capture_id=$1', [capture.captureId]), code('23514'));
  await assert.rejects(pool.query('DELETE FROM asset_backup_pins WHERE capture_id=$1', [capture.captureId]), code('23514'));
  await assert.rejects(pool.query('DELETE FROM asset_backup_captures WHERE capture_id=$1', [capture.captureId]), code('23514'));
  await assert.rejects(pool.query('DELETE FROM asset_maintenance_policy'), code('23514'));
});

test('ASSET-MAINT-21 approved 48-hour orphan/7-day replacement configuration remains explicit and blocks premature collection', async () => {
  const s = service(), orphan = await fixture(s.store), retired = await fixture(s.store, { retired: true });
  await pool.query("UPDATE asset_maintenance_policy SET revision='approved-starting-policy',orphan_retention_seconds=172800,retired_retention_seconds=604800");
  for (const f of [orphan, retired]) await assert.rejects(s.api.claimDelete(f.assetId), code('23514'));
  assert.equal(s.store.deleted.length, 0);
  await pool.query('UPDATE asset_maintenance_policy SET enabled=false');
  await assert.rejects(s.api.beginCapture(source), code('asset_maintenance_disabled'));
});

test('ASSET-MAINT-22 renewal advances only bounded current protection, not release/abort history', async () => {
  const s = service(); await fixture(s.store); const capture = await s.api.beginCapture(source);
  await s.api.renewProtection(capture.captureId); await s.api.captureReferences(capture.captureId);
  const renewed = await s.api.renewProtection(capture.captureId); assert(renewed.expiresAt);
  const expiry = (await pool.query('SELECT pin_expires_at<=clock_timestamp()+interval \'30 seconds\' bounded FROM asset_backup_captures WHERE capture_id=$1', [capture.captureId])).rows[0];
  assert(expiry.bounded); await s.api.releaseProtection(capture.captureId, 'release');
  await assert.rejects(s.api.renewProtection(capture.captureId), code('asset_capture_expired'));
  await assert.rejects(pool.query("UPDATE asset_backup_captures SET state='pinned' WHERE capture_id=$1", [capture.captureId]), code('23514'));
});

test('ASSET-MAINT-23 pinned transition cannot certify a fabricated reference count', async () => {
  const s = service(); await fixture(s.store); const capture = await s.api.beginCapture(source);
  await assert.rejects(pool.query(`UPDATE asset_backup_captures SET state='pinned',reference_snapshot='synthetic-not-a-backup',reference_count=1,
    pin_expires_at=clock_timestamp()+interval '30 seconds' WHERE capture_id=$1`, [capture.captureId]), code('23514'));
  assert.equal((await pool.query('SELECT state FROM asset_backup_captures WHERE capture_id=$1', [capture.captureId])).rows[0].state, 'capturing');
});

test('ASSET-MAINT-24 DB disable rejects reference output but never prevents explicit protective abort', async () => {
  const s = service(); await fixture(s.store); const capture = await s.api.beginCapture(source); await s.api.captureReferences(capture.captureId);
  await pool.query('UPDATE asset_maintenance_policy SET enabled=false');
  await assert.rejects(s.api.readReferences(capture.captureId), code('asset_maintenance_disabled'));
  assert.equal((await s.api.releaseProtection(capture.captureId, 'abort')).state, 'failed');
});

test('ASSET-MAINT-25 concurrent deletion claims have one active attempt and one bounded rejection', async () => {
  const s = service(), f = await fixture(s.store);
  const results = await Promise.allSettled([s.api.claimDelete(f.assetId), s.api.claimDelete(f.assetId)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const failed = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.equal(failed.reason.code, 'asset_delete_lease_active');
  assert.equal((await pool.query('SELECT attempt FROM asset_deletion_tombstones WHERE asset_id=$1', [f.assetId])).rows[0].attempt, '1');
});

test('ASSET-MAINT-26 pin-state failure rolls back pins and retains barrier for complete retry', async () => {
  const s = service(), f = await fixture(s.store), capture = await s.api.beginCapture(source);
  await pool.query(`CREATE FUNCTION fail_capture_publish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic capture fault' USING ERRCODE='P0001'; END; $$`);
  await pool.query('CREATE TRIGGER aaa_fail_capture_publish BEFORE UPDATE ON asset_backup_captures FOR EACH ROW EXECUTE FUNCTION fail_capture_publish()');
  try {
    await assert.rejects(s.api.captureReferences(capture.captureId), code('P0001'));
    assert.equal((await pool.query('SELECT count(*)::int n FROM asset_backup_pins')).rows[0].n, 0);
    await assert.rejects(s.api.claimDelete(f.assetId), code('23514'));
  } finally { await pool.query('DROP TRIGGER aaa_fail_capture_publish ON asset_backup_captures'); await pool.query('DROP FUNCTION fail_capture_publish()'); }
  assert.equal((await s.api.captureReferences(capture.captureId)).referenceCount, 1);
});

test('ASSET-MAINT-27 attach waiting behind GC sees committed fence; GC waiting behind attach sees live pointer', async () => {
  for (const gcFirst of [true, false]) {
    const s = service(), f = await fixture(s.store), q = await pool.connect(); let pending: Promise<unknown> | undefined;
    try {
      await q.query('BEGIN');
      if (gcFirst) await q.query(`INSERT INTO asset_deletion_tombstones(asset_id,policy_revision,lease_token,lease_expires_at)
        VALUES($1,'synthetic-retention',$2,clock_timestamp()+interval '5 seconds')`, [f.assetId, randomUUID()]);
      else {
        await q.query('SELECT 1 FROM member_avatars WHERE user_id=$1 FOR UPDATE', [f.actor.user_id]);
        await q.query("UPDATE assets SET state='ready',ready_at=clock_timestamp() WHERE asset_id=$1", [f.assetId]);
        await q.query('UPDATE member_avatar_asset_targets SET asset_id=$2,linked_at_version=1 WHERE user_id=$1', [f.actor.user_id, f.assetId]);
      }
      const pid = (await q.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      pending = gcFirst ? pool.query('UPDATE member_avatar_asset_targets SET asset_id=$2,linked_at_version=1 WHERE user_id=$1', [f.actor.user_id, f.assetId]) : s.api.claimDelete(f.assetId);
      void pending.catch(() => {}); await blockedBy(pid); await q.query('COMMIT'); await assert.rejects(pending, code('23514'));
    } finally { await q.query('ROLLBACK'); q.release(); await pending?.catch(() => {}); }
  }
});

test('ASSET-MAINT-28 capture cannot publish after expiry while its final generation update is blocked', async () => {
  const s = service(); await fixture(s.store); await pool.query('UPDATE asset_maintenance_policy SET capture_seconds=2');
  const capture = await s.api.beginCapture(source), lock = await pool.connect(); let pending: Promise<unknown> | undefined;
  try {
    await lock.query('BEGIN'); await lock.query('SELECT 1 FROM asset_maintenance_policy FOR UPDATE');
    const pid = (await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    pending = s.api.captureReferences(capture.captureId); void pending.catch(() => {}); await blockedBy(pid);
    let expired = false;
    for (let i = 0; i < 250; i++) {
      expired = (await pool.query('SELECT capture_expires_at<=clock_timestamp() expired FROM asset_backup_captures WHERE capture_id=$1', [capture.captureId])).rows[0].expired;
      if (expired) break; await delay(20);
    }
    assert(expired); await lock.query('COMMIT'); await assert.rejects(pending, code('23514'));
    assert.equal((await pool.query('SELECT count(*)::int n FROM asset_backup_pins')).rows[0].n, 0);
    assert.equal((await pool.query('SELECT state FROM asset_backup_captures WHERE capture_id=$1', [capture.captureId])).rows[0].state, 'capturing');
  } finally { await lock.query('ROLLBACK'); lock.release(); await pending?.catch(() => {}); }
});
