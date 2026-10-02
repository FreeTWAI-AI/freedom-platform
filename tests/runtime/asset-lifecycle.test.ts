import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import sharp from 'sharp';
import { migrate } from '../../scripts/database.js';
import { createPool } from '../../packages/db/index.js';
import { tokenHash, type Actor } from '../../modules/identity-membership/service.js';
import { normalizeImage } from '../../packages/shared/image-runtime.js';
import { createAvatarAssetService, type AvatarAssetDependencies } from '../../modules/assets/index.js';
import { AssetStorageError, sha256, type ObjectStore } from '../../packages/asset-storage/index.js';
import { FakeObjectStore } from '../../packages/asset-storage/fake-store.js';
import { Problem } from '../../packages/shared/problem.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('Asset lifecycle tests require explicit isolated TEST_DATABASE_URL');
const schema = `fp_asset_lifecycle_${process.pid}_${Date.now()}`;
const admin = createPool(connectionString), pool = new Pool({ connectionString, options: `-c search_path=${schema} -c statement_timeout=10000`, max: 12 });
const community = randomUUID();
let initialized = false, png: Buffer;
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`); initialized = true; await migrate(pool);
  await pool.query('CREATE TABLE test_asset_policy(user_id uuid PRIMARY KEY REFERENCES users,revision text NOT NULL,allowed boolean NOT NULL)');
  png = await sharp({ create: { width: 30, height: 40, channels: 3, background: 'red' } }).png().toBuffer();
});
after(async () => { await pool.end(); if (initialized) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(async () => { await pool.query('TRUNCATE communities CASCADE'); await pool.query('INSERT INTO communities VALUES($1,$2)', [community, 'Synthetic asset tests']); });
async function member(): Promise<Actor> {
  const id = randomUUID(), hash = tokenHash(randomUUID());
  const row = (await pool.query('INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
    [id, community, id + '@example.invalid', 'Synthetic member', 'not-a-login-hash', randomUUID()])).rows[0];
  await pool.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')", [hash, id]);
  await pool.query("INSERT INTO test_asset_policy VALUES($1,'policy-1',true)", [id]);
  return { ...row, session_hash: hash, csrf_token: 'synthetic' };
}
function service(store: ObjectStore = new FakeObjectStore(), overrides: Partial<AvatarAssetDependencies> = {}) {
  return createAvatarAssetService(pool, { store, normalizeAvatar: (bytes, spec) => normalizeImage(Buffer.from(bytes), spec),
    resolvePolicy: async (q, _context, userId) => {
      const row = (await q.query('SELECT revision,allowed FROM test_asset_policy WHERE user_id=$1 FOR SHARE', [userId])).rows[0];
      return { revision: row.revision, platformPersistenceAllowed: row.allowed };
    }, ...overrides });
}
const body = () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(png); c.close(); } });
const problem = (code: string) => (error: unknown) => error instanceof Problem && error.code === code;
const sqlCode = (code: string) => (error: unknown) => (error as { code?: string })?.code === code;
async function prepared(actor: Actor, api = service(), expectedVersion = '1') {
  const input = { key: randomUUID(), targetUserId: actor.user_id, expectedVersion, contentType: 'image/png' as const, byteSize: png.length, sha256: await sha256(png) };
  const intent = await api.prepare(actor, input);
  return { api, input, intent };
}
async function stored(actor: Actor, api = service(), expectedVersion = '1') {
  const result = await prepared(actor, api, expectedVersion);
  const lease = await api.claim(actor, { key: randomUUID(), intentId: result.intent.intentId });
  const leaseInput = { intentId: lease.intentId, fence: lease.fence, leaseToken: lease.leaseToken };
  await api.write(actor, { key: randomUUID(), ...leaseInput }, body());
  return { ...result, lease, leaseInput };
}

test('ASSET-LIFE-01 durable phases finalize metadata atomically without activating legacy bytes', async () => {
  const owner = await member(), { api, intent, leaseInput } = await stored(owner);
  const pending = (await pool.query('SELECT state FROM assets WHERE asset_id=$1', [intent.assetId])).rows[0];
  assert.equal(pending.state, 'pending'); assert.equal((await api.readTarget(owner)).assetId, null);
  const request = { key: randomUUID(), ...leaseInput };
  const finalized = await api.finalize(owner, request);
  assert.equal(finalized.aggregateVersion, '2');
  assert.deepEqual(await api.finalize(owner, request), finalized);
  assert.deepEqual(await api.readTarget(owner), { targetUserId: owner.user_id, assetId: intent.assetId, aggregateVersion: '2' });
  const avatar = (await pool.query('SELECT * FROM member_avatars WHERE user_id=$1', [owner.user_id])).rows[0];
  assert.equal(avatar.image_bytes, null); assert.equal(avatar.aggregate_version, '2');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM scoped_outbox')).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM outbox')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM transition_journal')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT state FROM asset_upload_intents WHERE intent_id=$1', [intent.intentId])).rows[0].state, 'finalized');
});

test('ASSET-LIFE-02 prepare replay uses stable identity, body conflicts and quota do not create extra assets', async () => {
  const owner = await member(), api = service(undefined, { maxPendingIntents: 1 });
  const { intent, input } = await prepared(owner, api);
  assert.deepEqual(await api.prepare(owner, input), intent);
  await assert.rejects(api.prepare(owner, { ...input, sha256: 'a'.repeat(64) }), problem('idempotency_conflict'));
  await assert.rejects(api.prepare(owner, { ...input, key: randomUUID() }), problem('asset_upload_quota'));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM assets')).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM asset_upload_intents')).rows[0].n, 1);
});

test('ASSET-LIFE-03 source manifest is checked before decoding or object writes', async () => {
  const owner = await member(), store = new FakeObjectStore(); let decodes = 0, puts = 0;
  const original = store.putImmutable.bind(store);
  store.putImmutable = async (...args) => { puts++; return original(...args); };
  const api = service(store, { normalizeAvatar: async () => { decodes++; throw new Error('must not decode'); } });
  const { intent } = await prepared(owner, api);
  const lease = await api.claim(owner, { key: randomUUID(), intentId: intent.intentId });
  const changed = new Uint8Array(png); changed[0] ^= 1;
  await assert.rejects(api.write(owner, { key: randomUUID(), intentId: intent.intentId, fence: lease.fence, leaseToken: lease.leaseToken },
    new ReadableStream({ start(c) { c.enqueue(changed); c.close(); } })), problem('asset_source_mismatch'));
  assert.equal(decodes, 0); assert.equal(puts, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM asset_objects')).rows[0].n, 0);
});

test('ASSET-LIFE-04 current policy denies prepare and prevents finalize/replay after policy change', async () => {
  const owner = await member(), api = service();
  await pool.query('UPDATE test_asset_policy SET allowed=false WHERE user_id=$1', [owner.user_id]);
  await assert.rejects(prepared(owner, api), (error: unknown) => error instanceof AssetStorageError && error.code === 'persistence_prohibited');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM assets')).rows[0].n, 0);
  await pool.query('UPDATE test_asset_policy SET allowed=true WHERE user_id=$1', [owner.user_id]);
  const upload = await stored(owner, api);
  await pool.query("UPDATE test_asset_policy SET revision='policy-2' WHERE user_id=$1", [owner.user_id]);
  await assert.rejects(api.finalize(owner, { key: randomUUID(), ...upload.leaseInput }), problem('asset_policy_changed'));
  assert.equal((await api.readTarget(owner)).assetId, null);
});

test('ASSET-LIFE-05 owner scope is authoritative and old avatar version remains sole CAS source', async () => {
  const owner = await member(), peer = await member(), upload = await stored(owner);
  await assert.rejects(upload.api.prepare(peer, { ...upload.input, key: randomUUID() }), problem('asset_target_not_found'));
  await assert.rejects(upload.api.finalize(peer, { key: randomUUID(), ...upload.leaseInput }), problem('asset_intent_not_found'));
  await pool.query('UPDATE member_avatars SET aggregate_version=aggregate_version+1 WHERE user_id=$1', [owner.user_id]);
  await assert.rejects(upload.api.finalize(owner, { key: randomUUID(), ...upload.leaseInput }), (error: unknown) => error instanceof Problem && error.status === 412);
  assert.equal((await upload.api.readTarget(owner)).assetId, null);
});

test('ASSET-LIFE-06 stored retry uses same object; missing read-back blocks finalize', async () => {
  const owner = await member(), store = new FakeObjectStore(), upload = await stored(owner, service(store));
  const record = (await pool.query('SELECT object_key FROM asset_objects WHERE asset_id=$1', [upload.intent.assetId])).rows[0];
  await store.delete(record.object_key);
  await assert.rejects(upload.api.finalize(owner, { key: randomUUID(), ...upload.leaseInput }), (error: unknown) => error instanceof AssetStorageError && error.code === 'object_unavailable');
  await upload.api.write(owner, { key: randomUUID(), ...upload.leaseInput }, body());
  assert.equal((await upload.api.finalize(owner, { key: randomUUID(), ...upload.leaseInput })).aggregateVersion, '2');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM asset_objects')).rows[0].n, 1);
});

test('ASSET-LIFE-07 SQL blocks pre-ready inserts, intent identity changes and representation mutation', async () => {
  const owner = await member(), upload = await stored(owner);
  const row = (await pool.query('SELECT * FROM assets WHERE asset_id=$1', [upload.intent.assetId])).rows[0];
  await assert.rejects(pool.query("INSERT INTO assets(asset_id,scope_id,owner_principal_id,owner_user_id,policy_revision,representation_id,state,ready_at) VALUES($1,$2,$3,$4,$5,$6,'ready',clock_timestamp())",
    [randomUUID(), row.scope_id, row.owner_principal_id, owner.user_id, row.policy_revision, randomUUID()]), sqlCode('23514'));
  await assert.rejects(pool.query("UPDATE asset_upload_intents SET source_sha256=$2 WHERE intent_id=$1", [upload.intent.intentId, 'a'.repeat(64)]), sqlCode('23514'));
  await assert.rejects(pool.query('UPDATE asset_upload_intents SET fence=fence-1 WHERE intent_id=$1', [upload.intent.intentId]), sqlCode('23514'));
  await assert.rejects(pool.query('UPDATE asset_objects SET byte_size=byte_size WHERE asset_id=$1', [upload.intent.assetId]), sqlCode('23514'));
  await assert.rejects(pool.query('DELETE FROM assets WHERE asset_id=$1', [upload.intent.assetId]), sqlCode('23514'));
  await assert.rejects(pool.query("UPDATE assets SET state='ready',ready_at=clock_timestamp() WHERE asset_id=$1", [(await prepared(owner, upload.api)).intent.assetId]), sqlCode('23514'));
});

test('ASSET-LIFE-08 lease takeover increases fence and rejects stale source worker', async () => {
  const owner = await member(), upload = await prepared(owner);
  const first = await upload.api.claim(owner, { key: randomUUID(), intentId: upload.intent.intentId });
  await assert.rejects(upload.api.claim(owner, { key: randomUUID(), intentId: upload.intent.intentId }), problem('asset_lease_active'));
  await pool.query("UPDATE asset_upload_intents SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE intent_id=$1", [upload.intent.intentId]);
  const second = await upload.api.claim(owner, { key: randomUUID(), intentId: upload.intent.intentId });
  assert.equal(second.fence, '2'); assert.notEqual(second.leaseToken, first.leaseToken);
  await assert.rejects(upload.api.write(owner, { key: randomUUID(), intentId: first.intentId, fence: first.fence, leaseToken: first.leaseToken }, body()), problem('asset_lease_stale'));
  await upload.api.write(owner, { key: randomUUID(), intentId: second.intentId, fence: second.fence, leaseToken: second.leaseToken }, body());
});

test('ASSET-LIFE-09 legacy mutation after finalize makes sidecar pointer stale; old replay cannot reactivate it', async () => {
  const owner = await member(), upload = await stored(owner), request = { key: randomUUID(), ...upload.leaseInput };
  const receipt = await upload.api.finalize(owner, request);
  await pool.query('UPDATE member_avatars SET aggregate_version=aggregate_version+1,image_bytes=NULL WHERE user_id=$1', [owner.user_id]);
  assert.deepEqual(await upload.api.readTarget(owner), { targetUserId: owner.user_id, assetId: null, aggregateVersion: '3' });
  assert.deepEqual(await upload.api.finalize(owner, request), receipt);
  assert.equal((await upload.api.readTarget(owner)).assetId, null);
});

test('ASSET-LIFE-10 actor mutation during policy await cannot select another member target', async () => {
  const owner = await member(), peer = await member();
  await prepared(peer);
  await pool.query('UPDATE member_avatars SET aggregate_version=123 WHERE user_id=$1', [peer.user_id]);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
  const api = service(undefined, { resolvePolicy: async () => { entered(); await barrier; return { revision: 'policy-1', platformPersistenceAllowed: true }; } });
  const mutable = { ...owner }, pending = api.readTarget(mutable);
  await started; mutable.user_id = peer.user_id; release();
  assert.deepEqual(await pending, { targetUserId: owner.user_id, assetId: null, aggregateVersion: '1' });
});

test('ASSET-LIFE-11 current member eligibility is rechecked even for target reads and finalized replay', async () => {
  const owner = await member(), upload = await stored(owner), request = { key: randomUUID(), ...upload.leaseInput };
  await upload.api.finalize(owner, request);
  await pool.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1', [owner.user_id]);
  await assert.rejects(upload.api.readTarget(owner), problem('onboarding_required'));
  await assert.rejects(upload.api.finalize(owner, request), problem('onboarding_required'));
});

test('ASSET-LIFE-12 invalid bigint and key inputs fail validation without coercion or database writes', async () => {
  const owner = await member(), api = service();
  const input = { key: randomUUID(), targetUserId: owner.user_id, expectedVersion: '1', contentType: 'image/png' as const, byteSize: png.length, sha256: await sha256(png) };
  const validation = (error: unknown) => error instanceof Error && error.name === 'ZodError';
  for (const expectedVersion of ['', '0', '-1', '1\n', 'not-a-number', '9'.repeat(20), '9223372036854775808']) {
    await assert.rejects(api.prepare(owner, { ...input, expectedVersion }), validation);
  }
  await assert.rejects(api.prepare(owner, { ...input, key: input.key + '\n' }), validation);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM asset_upload_intents')).rows[0].n, 0);
});

async function waitForLock(blockerPid: number) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if ((await admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked', [blockerPid])).rows[0].blocked) return;
    await delay(10);
  }
  assert.fail('expected actual PostgreSQL lock wait');
}
async function waitForSessionExpiry(actor: Actor) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if ((await admin.query(`SELECT expires_at<=clock_timestamp() AS expired FROM ${schema}.sessions WHERE token_hash=$1`, [actor.session_hash])).rows[0].expired) return;
    await delay(10);
  }
  assert.fail('expected actual database-clock session expiry');
}

test('ASSET-LIFE-13 session expiry during locked inspection prevents source consumption and all object I/O', async () => {
  const owner = await member(), store = new FakeObjectStore(); let reads = 0, decodes = 0, io = 0;
  const api = service({
    putImmutable: async (...args) => { io++; return store.putImmutable(...args); },
    get: async (...args) => { io++; return store.get(...args); },
    head: async (...args) => { io++; return store.head(...args); },
    delete: async (...args) => { io++; return store.delete(...args); },
  }, { normalizeAvatar: async (bytes, spec) => { decodes++; return normalizeImage(Buffer.from(bytes), spec); } });
  const { intent } = await prepared(owner, api), lease = await api.claim(owner, { key: randomUUID(), intentId: intent.intentId });
  const source = new ReadableStream<Uint8Array>({ pull(c) { reads++; c.enqueue(png); c.close(); } }, { highWaterMark: 0 });
  const locker = await pool.connect();
  try {
    await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '1 second' WHERE token_hash=$1", [owner.session_hash]);
    await locker.query('BEGIN');
    const blocker = (await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await locker.query('SELECT 1 FROM member_avatars WHERE user_id=$1 FOR UPDATE', [owner.user_id]);
    const rejected = assert.rejects(api.write(owner, { key: randomUUID(), intentId: lease.intentId, fence: lease.fence, leaseToken: lease.leaseToken }, source), problem('session_expired'));
    await waitForLock(blocker); await waitForSessionExpiry(owner);
    await locker.query('COMMIT'); await rejected;
    assert.equal(reads, 0); assert.equal(decodes, 0); assert.equal(io, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM asset_objects')).rows[0].n, 0);
  } finally { await locker.query('ROLLBACK'); locker.release(); await source.cancel(); }
});

test('ASSET-LIFE-14 session expiry during policy lock wait prevents target metadata disclosure', async () => {
  const owner = await member(), upload = await stored(owner);
  await upload.api.finalize(owner, { key: randomUUID(), ...upload.leaseInput });
  const locker = await pool.connect();
  try {
    await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '1 second' WHERE token_hash=$1", [owner.session_hash]);
    await locker.query('BEGIN');
    const blocker = (await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await locker.query('SELECT 1 FROM test_asset_policy WHERE user_id=$1 FOR UPDATE', [owner.user_id]);
    const rejected = assert.rejects(upload.api.readTarget(owner), problem('session_expired'));
    await waitForLock(blocker); await waitForSessionExpiry(owner);
    await locker.query('COMMIT'); await rejected;
  } finally { await locker.query('ROLLBACK'); locker.release(); }
});
