import assert from 'node:assert/strict';
import { test, before, after, beforeEach } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import sharp from 'sharp';
import { createPool } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import type { Actor } from '../../modules/identity-membership/service.js';
import { saveAvatar } from '../../modules/identity-membership/avatars.js';
import { createAvatarAssetService } from '../../modules/assets/index.js';
import { normalizeImage } from '../../packages/shared/image-runtime.js';
import { FakeObjectStore } from '../../packages/asset-storage/fake-store.js';
import { sha256, type AssetObjectKey, type ObjectRange, type PreparedRepresentation, type PersistencePolicy } from '../../packages/asset-storage/index.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('Asset lifecycle races require explicit isolated TEST_DATABASE_URL.');
const schema = `fp_asset_races_${process.pid}_${Date.now()}`;
const admin = createPool(connectionString);
const pool = new Pool({ connectionString, options: `-c search_path=${schema} -c statement_timeout=10000`, max: 12 });
const community = randomUUID();
let created = false, png: Buffer, otherPng: Buffer;
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`); created = true; await migrate(pool);
  png = await sharp({ create: { width: 12, height: 12, channels: 3, background: '#235789' } }).png().toBuffer();
  otherPng = await sharp({ create: { width: 12, height: 12, channels: 3, background: '#f19a38' } }).png().toBuffer();
});
after(async () => { await pool.end(); if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(async () => {
  await pool.query('TRUNCATE communities CASCADE');
  await pool.query("INSERT INTO communities VALUES($1,'Synthetic asset race community')", [community]);
});
async function member(): Promise<Actor> {
  const userId = randomUUID(), session = randomUUID();
  const user = (await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic asset owner','not-a-login-hash',$4) RETURNING *`, [userId, community, userId + '@example.invalid', randomUUID()])).rows[0];
  await pool.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',now()+interval '1 hour')", [session, userId]);
  return { ...user, session_hash: session, csrf_token: 'synthetic' };
}
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function stream(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}
async function enteredBeforeCompletion(entered: ReturnType<typeof barrier>, pending: Promise<unknown>) {
  await Promise.race([entered.promise, pending.then(() => { assert.fail('Operation finished before the expected effect barrier.'); })]);
}
class ObservedStore extends FakeObjectStore {
  readonly puts: AssetObjectKey[] = [];
  readonly gets: AssetObjectKey[] = [];
  onPut?: () => Promise<void>;
  onGet?: () => Promise<void>;
  override async putImmutable(key: AssetObjectKey, value: PreparedRepresentation) {
    this.puts.push(key); await this.onPut?.(); return super.putImmutable(key, value);
  }
  override async get(key: AssetObjectKey, range?: ObjectRange) {
    this.gets.push(key); await this.onGet?.(); return super.get(key, range);
  }
}
function service(store = new ObservedStore()) {
  const policy: PersistencePolicy & { revision: string; platformPersistenceAllowed: boolean } = { revision: 'asset-race-policy-1', platformPersistenceAllowed: true };
  const api = createAvatarAssetService(pool, { store, resolvePolicy: async () => ({ ...policy }),
    normalizeAvatar: async (bytes, spec) => normalizeImage(Buffer.from(bytes), spec), leaseSeconds: 60, intentTtlSeconds: 600 });
  return { api, store, policy };
}
type Service = ReturnType<typeof service>;
async function manifest(owner: Actor, expectedVersion = '1', bytes = png) {
  return { key: randomUUID(), targetUserId: owner.user_id, expectedVersion, contentType: 'image/png' as const, byteSize: bytes.length, sha256: await sha256(bytes) };
}
async function prepared(s: Service, owner: Actor, expectedVersion = '1', bytes = png) {
  const prepared = await s.api.prepare(owner, await manifest(owner, expectedVersion, bytes));
  const claim = await s.api.claim(owner, { key: randomUUID(), intentId: prepared.intentId });
  return { prepared, claim, request: { key: randomUUID(), intentId: prepared.intentId, fence: claim.fence, leaseToken: claim.leaseToken } };
}
async function stored(s: Service, owner: Actor, expectedVersion = '1', bytes = png) {
  const result = await prepared(s, owner, expectedVersion, bytes);
  await s.api.write(owner, result.request, stream(bytes));
  return { ...result, finalize: { ...result.request, key: randomUUID() } };
}
const status = (wanted: number) => (error: unknown) => (error as { status?: number })?.status === wanted;
async function count(table: 'assets' | 'asset_objects' | 'asset_upload_intents' | 'scoped_command_receipts' | 'scoped_transition_journal' | 'scoped_outbox' | 'command_receipts' | 'transition_journal' | 'outbox') {
  return (await pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count as number;
}
async function waitForBlocked(pid: number, number: number) {
  for (let attempt = 0; attempt < 250; attempt++) {
    const blocked = (await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid])).rows[0].count;
    if (blocked >= number) return;
    await delay(10);
  }
  assert.fail(`Expected ${number} real blocked PostgreSQL backends.`);
}
async function simultaneous<T>(owner: Actor, run: () => Promise<T>): Promise<[T, T]> {
  const lock = await pool.connect();
  let pending: Promise<[T, T]> | undefined;
  try {
    await lock.query('BEGIN');
    await lock.query('SELECT 1 FROM users WHERE user_id=$1 FOR UPDATE', [owner.user_id]);
    const pid = (await lock.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    pending = Promise.all([run(), run()]);
    void pending.catch(() => {});
    await waitForBlocked(pid, 2);
    await lock.query('COMMIT');
    return await pending;
  } finally { await lock.query('ROLLBACK'); lock.release(); await pending?.catch(() => {}); }
}

test('ASSET-RACE-01 simultaneous same-key prepare creates one immutable intent and one receipt', async () => {
  const owner = await member(), s = service(), input = await manifest(owner);
  const [first, second] = await simultaneous(owner, () => s.api.prepare(owner, input));
  assert.deepEqual(first, second);
  assert.equal(await count('assets'), 1); assert.equal(await count('asset_upload_intents'), 1);
  assert.equal(await count('scoped_command_receipts'), 1); assert.equal(s.store.puts.length, 0);
  await assert.rejects(s.api.prepare(owner, { ...input, sha256: await sha256(otherPng), byteSize: otherPng.length }), status(409));
  assert.equal(await count('assets'), 1); assert.equal(await count('asset_upload_intents'), 1);
});

test('ASSET-RACE-02 simultaneous finalize is one version change, pointer, receipt and scoped event', async () => {
  const owner = await member(), s = service(), upload = await stored(s, owner);
  const before = { receipts: await count('scoped_command_receipts'), journal: await count('scoped_transition_journal'), outbox: await count('scoped_outbox') };
  const [first, second] = await simultaneous(owner, () => s.api.finalize(owner, upload.finalize));
  assert.deepEqual(first, second); assert.equal(first.aggregateVersion, '2');
  assert.deepEqual(await s.api.readTarget(owner), { targetUserId: owner.user_id, assetId: upload.prepared.assetId, aggregateVersion: '2' });
  assert.equal(await count('scoped_command_receipts'), before.receipts + 1);
  assert.equal(await count('scoped_transition_journal'), before.journal + 1);
  assert.equal(await count('scoped_outbox'), before.outbox + 1);
  assert.equal(await count('transition_journal'), 0); assert.equal(await count('outbox'), 0);
});

test('ASSET-RACE-03 blocked object PUT holds no authorization locks and session revoke wins before DB publish', async () => {
  const owner = await member(), s = service(), upload = await prepared(s, owner);
  const entered = barrier(), release = barrier();
  s.store.onPut = async () => { entered.release(); await release.promise; };
  const write = s.api.write(owner, upload.request, stream(png));
  void write.catch(() => {});
  await enteredBeforeCompletion(entered, write);
  const revoker = await pool.connect();
  try {
    await revoker.query('BEGIN'); await revoker.query("SET LOCAL lock_timeout='500ms'");
    // FOR UPDATE NOWAIT proves user/principal/scope/intent locks were released,
    // not merely that this particular session update happened to be unlocked.
    await revoker.query('SELECT 1 FROM users WHERE user_id=$1 FOR UPDATE NOWAIT', [owner.user_id]);
    await revoker.query('SELECT 1 FROM principals WHERE user_ref=$1 FOR UPDATE NOWAIT', [owner.user_id]);
    await revoker.query('SELECT 1 FROM resource_scopes s JOIN principals p ON p.principal_id=s.owner_principal_id WHERE p.user_ref=$1 FOR UPDATE OF s NOWAIT', [owner.user_id]);
    await revoker.query('SELECT 1 FROM asset_upload_intents FOR UPDATE NOWAIT');
    await revoker.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1', [owner.session_hash]);
    await revoker.query('COMMIT');
  } finally { await revoker.query('ROLLBACK'); revoker.release(); release.release(); }
  await assert.rejects(write, status(401));
  assert.equal(s.store.puts.length, 1); assert(await s.store.head(s.store.puts[0]));
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM assets WHERE state='ready'")).rows[0].count, 0);
  assert.equal((await pool.query('SELECT aggregate_version FROM member_avatars WHERE user_id=$1', [owner.user_id])).rows[0].aggregate_version, '1');
});

test('ASSET-RACE-04 blocked finalize read-back holds no locks and committed scope revoke defeats old storage evidence', async () => {
  const owner = await member(), s = service(), upload = await stored(s, owner);
  const entered = barrier(), release = barrier();
  s.store.onGet = async () => { entered.release(); await release.promise; };
  const finalizing = s.api.finalize(owner, upload.finalize); void finalizing.catch(() => {});
  await enteredBeforeCompletion(entered, finalizing);
  const revoker = await pool.connect();
  try {
    await revoker.query('BEGIN'); await revoker.query("SET LOCAL lock_timeout='500ms'");
    await revoker.query("UPDATE resource_scopes s SET status='disabled' FROM principals p WHERE p.principal_id=s.owner_principal_id AND p.user_ref=$1", [owner.user_id]);
    await revoker.query('COMMIT');
  } finally { await revoker.query('ROLLBACK'); revoker.release(); release.release(); }
  await assert.rejects(finalizing, status(403));
  assert.equal((await pool.query('SELECT aggregate_version FROM member_avatars WHERE user_id=$1', [owner.user_id])).rows[0].aggregate_version, '1');
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM assets WHERE state='ready'")).rows[0].count, 0);
});

test('ASSET-RACE-05 real legacy avatar replacement and deletion invalidate prepared expected version', async () => {
  for (const removal of [false, true]) {
    const owner = await member(), s = service();
    const legacy = (bytes: Buffer | null, expected: string) => saveAvatar(pool, { actor: owner, operation: bytes ? 'POST /api/v1/me/avatar' : 'DELETE /api/v1/me/avatar', key: randomUUID(), body: {}, expected }, bytes ? { bytes, mime: 'image/png' } : null);
    const original = await legacy(png, '1'); assert.equal(original.aggregate_version, '2');
    const upload = await stored(s, owner, '2');
    const changed = await legacy(removal ? null : otherPng, '2'); assert.equal(changed.aggregate_version, '3');
    const snapshot = (await pool.query('SELECT aggregate_version,image_bytes FROM member_avatars WHERE user_id=$1', [owner.user_id])).rows[0];
    await assert.rejects(s.api.finalize(owner, upload.finalize), status(412));
    assert.deepEqual((await pool.query('SELECT aggregate_version,image_bytes FROM member_avatars WHERE user_id=$1', [owner.user_id])).rows[0], snapshot);
    assert.equal((await pool.query('SELECT asset_id FROM member_avatar_asset_targets WHERE user_id=$1', [owner.user_id])).rows[0].asset_id, null);
  }
});

test('ASSET-RACE-06 committed old finalize receipt cannot restore a replaced pointer or bypass later revoke', async () => {
  const owner = await member(), s = service(), first = await stored(s, owner);
  const receipt = await s.api.finalize(owner, first.finalize);
  const second = await stored(s, owner, '2', otherPng);
  await s.api.finalize(owner, second.finalize);
  const before = await s.api.readTarget(owner), beforeJournal = await count('scoped_transition_journal');
  assert.deepEqual(await s.api.finalize(owner, first.finalize), receipt);
  assert.deepEqual(await s.api.readTarget(owner), before); assert.equal(before.assetId, second.prepared.assetId);
  assert.equal(await count('scoped_transition_journal'), beforeJournal);
  await pool.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1', [owner.session_hash]);
  await assert.rejects(s.api.finalize(owner, first.finalize), status(401));
});

test('ASSET-RACE-07 another owner cannot prepare, claim, write, finalize or replay a target', async () => {
  const owner = await member(), peer = await member(), s = service(), upload = await stored(s, owner);
  await assert.rejects(s.api.prepare(peer, await manifest(owner)), status(404));
  await assert.rejects(s.api.claim(peer, { key: randomUUID(), intentId: upload.prepared.intentId }), status(404));
  await assert.rejects(s.api.write(peer, upload.request, stream(png)), status(404));
  await assert.rejects(s.api.finalize(peer, upload.finalize), status(404));
  await s.api.finalize(owner, upload.finalize);
  await assert.rejects(s.api.finalize(peer, upload.finalize), status(404));
  assert.equal((await s.api.readTarget(peer)).assetId, null);
});

test('ASSET-RACE-08 actual source bytes must match the pinned input manifest before any object PUT', async () => {
  const owner = await member(), s = service(), upload = await prepared(s, owner);
  await assert.rejects(s.api.write(owner, upload.request, stream(otherPng)));
  assert.equal(s.store.puts.length, 0);
  await s.api.write(owner, upload.request, stream(png));
  assert.equal(s.store.puts.length, 1);
});

test('ASSET-RACE-09 changed or denied persistence policy cannot publish or replay an earlier upload', async () => {
  for (const denied of [false, true]) {
    const owner = await member(), s = service(), upload = await stored(s, owner);
    if (denied) s.policy.platformPersistenceAllowed = false;
    else s.policy.revision = 'asset-race-policy-2';
    await assert.rejects(s.api.finalize(owner, upload.finalize));
    assert.equal((await pool.query('SELECT aggregate_version FROM member_avatars WHERE user_id=$1', [owner.user_id])).rows[0].aggregate_version, '1');
    assert.equal((await pool.query('SELECT asset_id FROM member_avatar_asset_targets WHERE user_id=$1', [owner.user_id])).rows[0].asset_id, null);
  }
});

test('ASSET-RACE-10 object survives a failed PostgreSQL publish; retry commits once without a second PUT', async () => {
  const owner = await member(), s = service(), upload = await stored(s, owner);
  const snapshot = await s.api.readTarget(owner);
  const before = { receipts: await count('scoped_command_receipts'), journal: await count('scoped_transition_journal'), outbox: await count('scoped_outbox') };
  await pool.query(`CREATE FUNCTION reject_synthetic_asset_pointer() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic asset pointer failure' USING ERRCODE='P0001'; END; $$`);
  await pool.query('CREATE TRIGGER reject_synthetic_asset_pointer BEFORE INSERT OR UPDATE ON member_avatar_asset_targets FOR EACH ROW EXECUTE FUNCTION reject_synthetic_asset_pointer()');
  try {
    await assert.rejects(s.api.finalize(owner, upload.finalize), (error: unknown) => (error as { code?: string }).code === 'P0001');
    assert.deepEqual(await s.api.readTarget(owner), snapshot);
    assert.equal(await count('scoped_command_receipts'), before.receipts);
    assert.equal(await count('scoped_transition_journal'), before.journal);
    assert.equal(await count('scoped_outbox'), before.outbox);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM assets WHERE state='ready'")).rows[0].count, 0);
    assert(await s.store.head(s.store.puts[0]));
  } finally {
    await pool.query('DROP TRIGGER reject_synthetic_asset_pointer ON member_avatar_asset_targets');
    await pool.query('DROP FUNCTION reject_synthetic_asset_pointer()');
  }
  const result = await s.api.finalize(owner, upload.finalize);
  assert.equal(result.aggregateVersion, '2'); assert.equal(result.assetId, upload.prepared.assetId);
  assert.equal(s.store.puts.length, 1); assert.equal(await count('asset_objects'), 1);
  assert.equal(await count('scoped_command_receipts'), before.receipts + 1);
  assert.equal(await count('scoped_transition_journal'), before.journal + 1);
  assert.equal(await count('scoped_outbox'), before.outbox + 1);
});

test('ASSET-RACE-11 client results and scoped facts contain no storage key, source bytes, email or session credential', async () => {
  const owner = await member(), s = service(), upload = await stored(s, owner);
  const finished = await s.api.finalize(owner, upload.finalize);
  const facts = [];
  for (const table of ['scoped_command_receipts', 'scoped_transition_journal', 'scoped_outbox']) {
    facts.push(...(await pool.query(`SELECT to_jsonb(t) AS fact FROM ${table} t`)).rows);
  }
  const serialized = JSON.stringify({ prepare: upload.prepared, claim: upload.claim, finished, target: await s.api.readTarget(owner), facts });
  for (const denied of [s.store.puts[0], png.toString('base64'), owner.email, owner.session_hash]) assert(!serialized.includes(denied), 'An internal value escaped into a result or scoped fact.');
  assert.equal(await count('outbox'), 0); assert.equal(await count('transition_journal'), 0); assert.equal(await count('command_receipts'), 0);
});

test('ASSET-RACE-12 expired lease takeover fences an old worker without changing immutable object identity', async () => {
  const owner = await member(), s = service(), upload = await stored(s, owner);
  const before = (await pool.query('SELECT asset_id,representation_id,scope_id,source_sha256,expected_version FROM asset_upload_intents WHERE intent_id=$1', [upload.prepared.intentId])).rows[0];
  await pool.query("UPDATE asset_upload_intents SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE intent_id=$1", [upload.prepared.intentId]);
  const takeover = await s.api.claim(owner, { key: randomUUID(), intentId: upload.prepared.intentId });
  assert.equal(BigInt(takeover.fence), BigInt(upload.claim.fence) + 1n); assert.notEqual(takeover.leaseToken, upload.claim.leaseToken);
  assert.equal(takeover.assetId, upload.prepared.assetId); assert.equal(takeover.representationId, upload.prepared.representationId);
  await assert.rejects(s.api.write(owner, upload.request, stream(png)), status(409));
  await assert.rejects(s.api.finalize(owner, upload.finalize), status(409));
  const fresh = { key: randomUUID(), intentId: takeover.intentId, fence: takeover.fence, leaseToken: takeover.leaseToken };
  const result = await s.api.finalize(owner, fresh);
  assert.equal(result.aggregateVersion, '2'); assert.equal(s.store.puts.length, 1);
  assert.deepEqual((await pool.query('SELECT asset_id,representation_id,scope_id,source_sha256,expected_version FROM asset_upload_intents WHERE intent_id=$1', [upload.prepared.intentId])).rows[0], before);
});

test('ASSET-RACE-13 takeover while an old PUT is blocked leaves bytes recoverable but rejects stale DB finalize', async () => {
  const owner = await member(), s = service(), upload = await prepared(s, owner);
  const entered = barrier(), release = barrier();
  s.store.onPut = async () => { entered.release(); await release.promise; };
  const oldWrite = s.api.write(owner, upload.request, stream(png)); void oldWrite.catch(() => {});
  await enteredBeforeCompletion(entered, oldWrite);
  let takeover: Awaited<ReturnType<Service['api']['claim']>>;
  try {
    await pool.query("UPDATE asset_upload_intents SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE intent_id=$1", [upload.prepared.intentId]);
    takeover = await s.api.claim(owner, { key: randomUUID(), intentId: upload.prepared.intentId });
  } finally { release.release(); }
  await assert.rejects(oldWrite, status(409));
  assert(await s.store.head(s.store.puts[0]));
  const fresh = { key: randomUUID(), intentId: takeover.intentId, fence: takeover.fence, leaseToken: takeover.leaseToken };
  await s.api.write(owner, fresh, stream(png));
  await s.api.finalize(owner, { ...fresh, key: randomUUID() });
  assert.equal(new Set(s.store.puts).size, 1); assert.equal(await count('asset_objects'), 1);
  assert.equal((await s.api.readTarget(owner)).aggregateVersion, '2');
});

test('ASSET-RACE-14 SQL cannot seed ready/stored/finalized states to bypass verified-representation guards', async () => {
  const owner = await member(), s = service(), upload = await prepared(s, owner);
  const code = (error: unknown) => (error as { code?: string })?.code === '23514';
  await assert.rejects(pool.query(`INSERT INTO assets(asset_id,scope_id,owner_principal_id,owner_user_id,policy_revision,representation_id,state,ready_at)
    SELECT $2,scope_id,owner_principal_id,owner_user_id,policy_revision,$3,'ready',clock_timestamp() FROM assets WHERE asset_id=$1`,
  [upload.prepared.assetId, randomUUID(), randomUUID()]), code);
  for (const state of ['stored', 'finalized']) {
    const assetId = randomUUID(), representationId = randomUUID();
    await pool.query(`INSERT INTO assets(asset_id,scope_id,owner_principal_id,owner_user_id,policy_revision,representation_id)
      SELECT $2,scope_id,owner_principal_id,owner_user_id,policy_revision,$3 FROM assets WHERE asset_id=$1`, [upload.prepared.assetId, assetId, representationId]);
    await assert.rejects(pool.query(`INSERT INTO asset_upload_intents(intent_id,asset_id,representation_id,scope_id,owner_principal_id,target_user_id,policy_revision,prepare_key,request_digest,
      source_content_type,source_byte_size,source_sha256,expected_version,expires_at,state,fence,lease_token,lease_expires_at,finalized_at)
      SELECT $2,$3,$4,scope_id,owner_principal_id,target_user_id,policy_revision,$5,request_digest,source_content_type,source_byte_size,source_sha256,expected_version,
        clock_timestamp()+interval '5 minutes',$6,1,$7,clock_timestamp()+interval '1 minute',CASE WHEN $6='finalized' THEN clock_timestamp() END
      FROM asset_upload_intents WHERE intent_id=$1`, [upload.prepared.intentId, randomUUID(), assetId, representationId, randomUUID(), state, randomUUID()]), code);
  }
});

test('ASSET-RACE-15 typed pointer rejects pending/cross-owner assets and ready metadata cannot be rebound', async () => {
  const owner = await member(), peer = await member(), s = service(), own = await stored(s, owner), foreign = await stored(s, peer);
  const sqlCode = (wanted: string) => (error: unknown) => (error as { code?: string })?.code === wanted;
  await assert.rejects(pool.query('UPDATE member_avatar_asset_targets SET asset_id=$2,linked_at_version=1 WHERE user_id=$1', [owner.user_id, own.prepared.assetId]), sqlCode('23503'));
  await s.api.finalize(owner, own.finalize); await s.api.finalize(peer, foreign.finalize);
  await assert.rejects(pool.query('UPDATE member_avatar_asset_targets SET asset_id=$2 WHERE user_id=$1', [owner.user_id, foreign.prepared.assetId]), sqlCode('23503'));
  await assert.rejects(pool.query('UPDATE assets SET owner_user_id=$2 WHERE asset_id=$1', [own.prepared.assetId, peer.user_id]), sqlCode('23514'));
  await assert.rejects(pool.query('UPDATE asset_objects SET content_sha256=$2 WHERE asset_id=$1', [own.prepared.assetId, '0'.repeat(64)]), sqlCode('23514'));
  await assert.rejects(pool.query('UPDATE asset_upload_intents SET expected_version=3 WHERE intent_id=$1', [own.prepared.intentId]), sqlCode('23514'));
});

test('ASSET-RACE-16 mutable Actor cannot switch the target while server policy resolution awaits', async () => {
  const owner = await member(), peer = await member(), originalUserId = owner.user_id;
  await saveAvatar(pool, { actor: peer, operation: 'POST /api/v1/me/avatar', key: randomUUID(), body: {}, expected: '1' }, { bytes: png, mime: 'image/png' });
  const entered = barrier(), release = barrier(); let armed = false;
  const api = createAvatarAssetService(pool, { store: new ObservedStore(),
    normalizeAvatar: async (bytes, spec) => normalizeImage(Buffer.from(bytes), spec),
    resolvePolicy: async () => {
      if (armed) { entered.release(); await release.promise; }
      return { revision: 'actor-snapshot-policy', platformPersistenceAllowed: true };
    } });
  await api.prepare(owner, await manifest(owner));
  armed = true;
  const pending = api.readTarget(owner); void pending.catch(() => {});
  await enteredBeforeCompletion(entered, pending);
  Object.assign(owner, peer); release.release();
  assert.deepEqual(await pending, { targetUserId: originalUserId, assetId: null, aggregateVersion: '1' });
});

test('ASSET-RACE-17 legacy avatar save/delete invalidates an already-linked asset without rewriting old receipt', async () => {
  for (const remove of [false, true]) {
    const owner = await member(), s = service();
    await saveAvatar(pool, { actor: owner, operation: 'POST /api/v1/me/avatar', key: randomUUID(), body: {}, expected: '1' }, { bytes: png, mime: 'image/png' });
    const upload = await stored(s, owner, '2');
    const receipt = await s.api.finalize(owner, upload.finalize); assert.equal(receipt.aggregateVersion, '3');
    await saveAvatar(pool, { actor: owner, operation: remove ? 'DELETE /api/v1/me/avatar' : 'POST /api/v1/me/avatar', key: randomUUID(), body: {}, expected: '3' }, remove ? null : { bytes: otherPng, mime: 'image/png' });
    assert.deepEqual(await s.api.readTarget(owner), { targetUserId: owner.user_id, assetId: null, aggregateVersion: '4' });
    assert.deepEqual(await s.api.finalize(owner, upload.finalize), receipt);
    assert.deepEqual(await s.api.readTarget(owner), { targetUserId: owner.user_id, assetId: null, aggregateVersion: '4' });
  }
});

test('ASSET-RACE-18 raw storage keys, policy/scope/owner override and fabricated verification are not lifecycle inputs', async () => {
  const owner = await member(), s = service(), input = await manifest(owner);
  for (const extra of [{ objectKey: 'v1/arbitrary/key' }, { scopeId: randomUUID() }, { ownerPrincipalId: randomUUID() },
    { policy: { platformPersistenceAllowed: true } }, { purpose: 'work.private-draft' }]) {
    await assert.rejects(s.api.prepare(owner, { ...input, ...extra }));
  }
  assert.equal(await count('assets'), 0); assert.equal(s.store.puts.length, 0);
  const upload = await stored(s, owner);
  await assert.rejects(s.api.finalize(owner, { ...upload.finalize, verifiedObject: { key: 'v1/arbitrary/key' } } as typeof upload.finalize));
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM assets WHERE state='ready'")).rows[0].count, 0);
});

test('ASSET-RACE-19 competing intents for one real avatar version have one winner and retain the losing object', async () => {
  const owner = await member(), s = service(), first = await stored(s, owner), second = await stored(s, owner, '1', otherPng);
  const beforeJournal = await count('scoped_transition_journal'), inputs = [first.finalize, second.finalize];
  let index = 0;
  const results = await simultaneous(owner, async () => {
    try { return { value: await s.api.finalize(owner, inputs[index++]) }; }
    catch (error) { return { error }; }
  });
  const successes = results.filter(result => 'value' in result), failures = results.filter(result => 'error' in result);
  assert.equal(successes.length, 1); assert.equal(failures.length, 1);
  assert.equal((failures[0].error as { status: number }).status, 412);
  const target = await s.api.readTarget(owner);
  assert.equal(target.aggregateVersion, '2'); assert.equal(target.assetId, successes[0].value!.assetId);
  assert.equal(await count('scoped_transition_journal'), beforeJournal + 1);
  assert.equal(await count('asset_objects'), 2);
  for (const key of s.store.puts) assert(await s.store.head(key));
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM assets WHERE state='ready'")).rows[0].count, 1);
});

for (const [index, table] of ['scoped_transition_journal', 'scoped_outbox', 'scoped_command_receipts'].entries()) {
  test(`ASSET-RACE-${20 + index} ${table} failure rolls back ready/pointer/real version and same-key retry commits once`, async () => {
    const owner = await member(), s = service(), upload = await stored(s, owner);
    const before = { receipts: await count('scoped_command_receipts'), journal: await count('scoped_transition_journal'), outbox: await count('scoped_outbox') };
    await pool.query(`CREATE FUNCTION reject_synthetic_asset_fact() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic asset fact failure' USING ERRCODE='P0001'; END; $$`);
    await pool.query(`CREATE TRIGGER reject_synthetic_asset_fact BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_synthetic_asset_fact()`);
    try {
      await assert.rejects(s.api.finalize(owner, upload.finalize), (error: unknown) => (error as { code?: string }).code === 'P0001');
      assert.deepEqual(await s.api.readTarget(owner), { targetUserId: owner.user_id, assetId: null, aggregateVersion: '1' });
      assert.equal((await pool.query('SELECT state FROM assets WHERE asset_id=$1', [upload.prepared.assetId])).rows[0].state, 'pending');
      assert.equal((await pool.query('SELECT state FROM asset_upload_intents WHERE intent_id=$1', [upload.prepared.intentId])).rows[0].state, 'stored');
      assert.equal(await count('scoped_command_receipts'), before.receipts);
      assert.equal(await count('scoped_transition_journal'), before.journal);
      assert.equal(await count('scoped_outbox'), before.outbox);
    } finally {
      // Remove the trigger in a DIFFERENT transaction. An in-trigger deletion
      // followed by RAISE would itself roll back and is not a one-shot fault.
      await pool.query(`DROP TRIGGER reject_synthetic_asset_fact ON ${table}`);
      await pool.query('DROP FUNCTION reject_synthetic_asset_fact()');
    }
    const result = await s.api.finalize(owner, upload.finalize);
    assert.equal(result.aggregateVersion, '2'); assert.equal(s.store.puts.length, 1);
    assert.equal(await count('scoped_command_receipts'), before.receipts + 1);
    assert.equal(await count('scoped_transition_journal'), before.journal + 1);
    assert.equal(await count('scoped_outbox'), before.outbox + 1);
  });
}

test('ASSET-RACE-23 intent expiry is checked after a demonstrated row-lock wait, not at transaction start', async () => {
  const owner = await member(), store = new ObservedStore();
  const policy = { revision: 'expiry-race-policy', platformPersistenceAllowed: true };
  const api = createAvatarAssetService(pool, { store, resolvePolicy: async () => ({ ...policy }),
    normalizeAvatar: async (bytes, spec) => normalizeImage(Buffer.from(bytes), spec), intentTtlSeconds: 2, leaseSeconds: 2 });
  const upload = await stored({ api, store, policy }, owner), lock = await pool.connect();
  let pending: Promise<unknown> | undefined;
  try {
    await lock.query('BEGIN');
    await lock.query('SELECT 1 FROM member_avatars WHERE user_id=$1 FOR UPDATE', [owner.user_id]);
    const pid = (await lock.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    assert((await pool.query('SELECT expires_at>clock_timestamp() AS live FROM asset_upload_intents WHERE intent_id=$1', [upload.prepared.intentId])).rows[0].live);
    pending = api.finalize(owner, upload.finalize); void pending.catch(() => {});
    await waitForBlocked(pid, 1);
    let expired = false;
    for (let attempt = 0; attempt < 250; attempt++) {
      expired = (await pool.query('SELECT expires_at<=clock_timestamp() AS expired FROM asset_upload_intents WHERE intent_id=$1', [upload.prepared.intentId])).rows[0].expired;
      if (expired) break;
      await delay(20);
    }
    assert(expired, 'The actual database clock must pass the immutable deadline while finalize is blocked.');
    await lock.query('COMMIT');
    await assert.rejects(pending, (error: unknown) => (error as { code?: string }).code === 'asset_intent_expired');
    assert.equal((await pool.query('SELECT aggregate_version FROM member_avatars WHERE user_id=$1', [owner.user_id])).rows[0].aggregate_version, '1');
  } finally { await lock.query('ROLLBACK'); lock.release(); await pending?.catch(() => {}); }
});
