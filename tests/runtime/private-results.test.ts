import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import { createPool } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { createPrivateResultService, type PrivateResultPrepareInput } from '../../modules/autopilot-work/results.js';
import { createPrivateWorkCommands } from '../../modules/opportunity-project-work/private-commands.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import type { Actor } from '../../modules/identity-membership/service.js';
import { FakeObjectStore } from '../../packages/asset-storage/fake-store.js';
import { objectKey, sha256, type AssetObjectKey, type PreparedRepresentation } from '../../packages/asset-storage/index.js';
import { createAvatarAssetService } from '../../modules/assets/index.js';
import { Problem } from '../../packages/shared/problem.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('Private Results require explicit isolated TEST_DATABASE_URL.');
const schema = `fp_private_results_${process.pid}_${Date.now()}`, admin = createPool(connectionString);
const pool = new Pool({ connectionString, options: `-c search_path=${schema} -c statement_timeout=10000`, max: 12 });
const community = randomUUID(); let created = false;
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`); created = true; await migrate(pool);
  await pool.query('CREATE TABLE fp_text_policy(singleton boolean PRIMARY KEY, revision text, allowed boolean, byte_limit text)');
  await pool.query("INSERT INTO fp_text_policy VALUES(true,'synthetic-text-v1',true,'10485760')");
});
after(async () => { await pool.end(); if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(async () => {
  await pool.query('TRUNCATE communities CASCADE');
  await pool.query("INSERT INTO communities VALUES($1,'Synthetic private Result')", [community]);
  await pool.query("UPDATE fp_text_policy SET revision='synthetic-text-v1',allowed=true,byte_limit='10485760'");
});
const status = (expected: number) => (error: unknown) => error instanceof Problem && error.status === expected;
const code = (expected: string) => (error: unknown) => (error as { code?: string })?.code === expected;
const stream = (bytes: Uint8Array) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
const encode = (text: string) => new TextEncoder().encode(text);
function barrier() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
class Store extends FakeObjectStore {
  puts = 0; gets = 0; onGet?: () => Promise<void>; onPut?: () => Promise<void>;
  override async get(key: AssetObjectKey) { this.gets++; await this.onGet?.(); return super.get(key); }
  override async putImmutable(key: AssetObjectKey, value: PreparedRepresentation) { this.puts++; await this.onPut?.(); return super.putImmutable(key, value); }
}
async function resolvePolicy(q: PoolClient) {
  const row = (await q.query('SELECT * FROM fp_text_policy WHERE singleton FOR SHARE')).rows[0];
  return { revision: row.revision as string, platformPersistenceAllowed: row.allowed as boolean, retainedByteLimit: row.byte_limit as string };
}
function service(store = new Store(), usePool: Pool = pool) {
  return { store, api: createPrivateResultService(usePool, { store, resolvePolicy, maxPendingIntents: 20 }) };
}
async function member(): Promise<Actor> {
  const user = randomUUID(), session = randomUUID();
  const row = (await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic owner','not-a-real-login',$4) RETURNING *`, [user, community, user + '@example.invalid', randomUUID()])).rows[0];
  await pool.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')", [session, user]);
  return { ...row, session_hash: session, csrf_token: 'synthetic' };
}
const workCommands = createPrivateWorkCommands(pool, { resolvePolicy: async () => ({ revision: 'synthetic-work-v1', platformPersistenceAllowed: true }) });
async function fixture() {
  const actor = await member(), work = await workCommands.create(actor, { key: randomUUID(), title: 'Private goal', objective: 'Human purpose, not Result content' });
  return { actor, workId: work.workId };
}
async function prepare(f: Awaited<ReturnType<typeof fixture>>, s: ReturnType<typeof service>, text = 'PRIVATE_RESULT_BODY_測試', version = '1') {
  const bytes = encode(text), input: PrivateResultPrepareInput = { key: randomUUID(), targetWorkId: f.workId, expectedVersion: version,
    contentType: 'text/plain', byteSize: bytes.length, sha256: await sha256(bytes) };
  return { input, bytes, prepared: await s.api.prepare(f.actor, input) };
}
async function stored(f: Awaited<ReturnType<typeof fixture>>, s: ReturnType<typeof service>, text?: string, version?: string) {
  const p = await prepare(f, s, text, version), lease = await s.api.claim(f.actor, { key: randomUUID(), intentId: p.prepared.intentId });
  const input = { key: randomUUID(), intentId: lease.intentId, fence: lease.fence, leaseToken: lease.leaseToken };
  await s.api.write(f.actor, { ...input, key: randomUUID() }, stream(p.bytes));
  return { ...p, input };
}
async function completed(f: Awaited<ReturnType<typeof fixture>>, s: ReturnType<typeof service>, text?: string, version?: string) {
  const p = await stored(f, s, text, version); return { ...p, result: await s.api.finalize(f.actor, p.input) };
}
async function blockedBy(q: PoolClient) {
  const pid = (await q.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  for (let i = 0; i < 250; i++) {
    if ((await admin.query('SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid])).rows[0].n) return;
    await delay(10);
  }
  assert.fail('Expected actual PostgreSQL blocking barrier.');
}
async function expire(actor: Actor) {
  for (let i = 0; i < 250; i++) {
    if ((await pool.query('SELECT expires_at<=clock_timestamp() expired FROM sessions WHERE token_hash=$1', [actor.session_hash])).rows[0].expired) return;
    await delay(10);
  }
  assert.fail('Expected bounded session expiry.');
}
async function workVersion(id: string) { return (await pool.query('SELECT aggregate_version FROM work_items WHERE work_item_id=$1', [id])).rows[0].aggregate_version; }

test('PRIVATE-RESULT-01 human lifecycle shares Asset core and publishes one real Result/CAS without body facts', async () => {
  const f = await fixture(), s = service(), p = await completed(f, s), read = await s.api.readCurrent(f.actor, { workId: f.workId });
  assert.equal(p.result.aggregateVersion, '2'); assert.equal(p.result.revision, '1'); assert.equal(p.result.provenance, 'human');
  assert.equal(read?.resultId, p.result.resultId); assert.equal(read?.text, 'PRIVATE_RESULT_BODY_測試'); assert.equal(read?.aggregateVersion, '2');
  assert.equal(await workVersion(f.workId), '2'); assert.equal((await pool.query('SELECT count(*)::int n FROM member_avatars')).rows[0].n, 0);
  for (const table of ['work_claims', 'contributions', 'transition_journal', 'outbox', 'command_receipts'])
    assert.equal((await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0);
  for (const table of ['scoped_command_receipts', 'scoped_transition_journal', 'scoped_outbox']) {
    const data = JSON.stringify((await pool.query(`SELECT * FROM ${table}`)).rows);
    assert(!data.includes('PRIVATE_RESULT_BODY')); assert(!data.includes('v1/')); assert(!data.includes('bucket'));
  }
  assert(!JSON.stringify(read).includes('representation_id'));
});
test('PRIVATE-RESULT-02 current empty and bounded history metadata are owner-only', async () => {
  const f = await fixture(), s = service(); assert.equal(await s.api.readCurrent(f.actor, { workId: f.workId }), null);
  const p = await completed(f, s); const list = await s.api.list(f.actor, { workId: f.workId, limit: 1 });
  assert.equal(list.items[0].resultId, p.result.resultId); assert.equal(list.items[0].revision, '1'); assert(!('text' in list.items[0]));
  assert.equal((await s.api.list(f.actor, { workId: f.workId, offset: 1 })).items.length, 0);
  await assert.rejects(s.api.list(f.actor, { workId: f.workId, limit: 51 }));
  await assert.rejects(s.api.list(f.actor, { workId: f.workId, ownerId: f.actor.user_id } as never));
});
test('PRIVATE-RESULT-03 peer, admin flag and foreign Result IDs cannot confer Work ownership', async () => {
  const f = await fixture(), peer = await fixture(), s = service(), p = await completed(f, s);
  const impostor = { ...peer.actor, is_admin: true } as Actor;
  for (const actor of [peer.actor, impostor]) {
    await assert.rejects(s.api.readCurrent(actor, { workId: f.workId }), status(404));
    await assert.rejects(s.api.readResult(actor, { workId: f.workId, resultId: p.result.resultId }), status(404));
    await assert.rejects(s.api.prepare(actor, { key: randomUUID(), targetWorkId: f.workId, expectedVersion: '2', contentType: 'text/plain', byteSize: 1, sha256: 'a'.repeat(64) }), status(404));
  }
  await assert.rejects(s.api.readResult(f.actor, { workId: f.workId, resultId: randomUUID() }), status(404));
  await assert.rejects(s.api.readResult(peer.actor, { workId: peer.workId, resultId: p.result.resultId }), status(404));
});
test('PRIVATE-RESULT-04 current onboarding, principal/scope and session authority apply to read and receipt replay', async () => {
  for (const revoke of ['onboarding', 'principal', 'scope', 'session'] as const) {
    const f = await fixture(), s = service(), p = await completed(f, s);
    if (revoke === 'onboarding') await pool.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1', [f.actor.user_id]);
    if (revoke === 'principal') await pool.query("UPDATE principals SET status='disabled' WHERE user_ref=$1", [f.actor.user_id]);
    if (revoke === 'scope') await pool.query("UPDATE resource_scopes SET status='disabled' WHERE owner_principal_id=(SELECT principal_id FROM principals WHERE user_ref=$1)", [f.actor.user_id]);
    if (revoke === 'session') await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1', [f.actor.session_hash]);
    await assert.rejects(s.api.readCurrent(f.actor, { workId: f.workId })); await assert.rejects(s.api.finalize(f.actor, p.input));
  }
});
test('PRIVATE-RESULT-05 human replacement retains readable ready/retired history; old replay never reattaches', async () => {
  const f = await fixture(), s = service(), first = await completed(f, s, 'first'), next = await completed(f, s, 'second', '2');
  await pool.query("UPDATE assets SET state='retired',retired_at=clock_timestamp() WHERE asset_id=$1", [first.result.assetId]);
  assert.equal((await s.api.readResult(f.actor, { workId: f.workId, resultId: first.result.resultId })).text, 'first');
  assert.equal((await s.api.readCurrent(f.actor, { workId: f.workId }))?.text, 'second');
  assert.deepEqual(await s.api.finalize(f.actor, first.input), first.result);
  assert.equal((await s.api.readCurrent(f.actor, { workId: f.workId }))?.resultId, next.result.resultId);
  assert.equal(await workVersion(f.workId), '3');
});
test('PRIVATE-RESULT-06 archive hides current/history/list and rejects old success receipt replay', async () => {
  const f = await fixture(), s = service(), p = await completed(f, s);
  await workCommands.archive(f.actor, { key: randomUUID(), workId: f.workId, expectedVersion: '2' });
  await assert.rejects(s.api.readCurrent(f.actor, { workId: f.workId }), status(404));
  await assert.rejects(s.api.readResult(f.actor, { workId: f.workId, resultId: p.result.resultId }), status(404));
  await assert.rejects(s.api.list(f.actor, { workId: f.workId }), status(404)); await assert.rejects(s.api.finalize(f.actor, p.input), status(404));
});
test('PRIVATE-RESULT-07 real human Work update and competing Result both defeat stale finalize with 412', async () => {
  const f = await fixture(), s = service(), old = await stored(f, s);
  await workCommands.update(f.actor, { key: randomUUID(), workId: f.workId, expectedVersion: '1', title: 'Edited', objective: 'New purpose' });
  await assert.rejects(s.api.finalize(f.actor, old.input), status(412));
  const a = await stored(f, s, 'a', '2'), b = await stored(f, s, 'b', '2');
  const outcomes = await Promise.allSettled([s.api.finalize(f.actor, a.input), s.api.finalize(f.actor, b.input)]);
  assert.equal(outcomes.filter(v => v.status === 'fulfilled').length, 1);
  assert.equal((outcomes.find(v => v.status === 'rejected') as PromiseRejectedResult).reason.status, 412);
  assert.equal(await workVersion(f.workId), '3');
});
test('PRIVATE-RESULT-08 identical concurrent prepare/finalize have one intent and real Result ID', async () => {
  const f = await fixture(), s = service(), p = await prepare(f, s);
  const copies = await Promise.all([s.api.prepare(f.actor, p.input), s.api.prepare(f.actor, p.input)]);
  assert(copies.every(v => v.intentId === p.prepared.intentId));
  const lease = await s.api.claim(f.actor, { key: randomUUID(), intentId: p.prepared.intentId });
  const input = { key: randomUUID(), intentId: lease.intentId, fence: lease.fence, leaseToken: lease.leaseToken };
  await s.api.write(f.actor, { ...input, key: randomUUID() }, stream(p.bytes));
  const results = await Promise.all([s.api.finalize(f.actor, input), s.api.finalize(f.actor, input)]);
  assert.deepEqual(results[0], results[1]); assert.equal((await pool.query('SELECT count(*)::int n FROM private_work_results')).rows[0].n, 1);
  await assert.rejects(s.api.prepare(f.actor, { ...p.input, sha256: 'b'.repeat(64) }), status(409));
});
test('PRIVATE-RESULT-09 strict text manifests reject unsupported content and raw identity/secret fields', async () => {
  const f = await fixture(), s = service(), base = { key: randomUUID(), targetWorkId: f.workId, expectedVersion: '1', contentType: 'text/plain', byteSize: 1, sha256: 'a'.repeat(64) };
  for (const change of [{ contentType: 'text/html' }, { byteSize: 0 }, { byteSize: 262145 }, { objectKey: 'arbitrary' }, { providerKey: 'not-a-real-secret' },
    { provenance: 'ai' }, { expectedVersion: '1\n' }, { ownerId: f.actor.user_id }]) await assert.rejects(s.api.prepare(f.actor, { ...base, ...change } as never));
  assert.equal(s.store.puts, 0); assert.equal((await pool.query('SELECT count(*)::int n FROM assets')).rows[0].n, 0);
});
test('PRIVATE-RESULT-10 exact UTF8/plain/Markdown and 256KiB boundaries are enforced before PUT', async () => {
  const f = await fixture(), s = service();
  for (const bytes of [new Uint8Array([0xff]), encode('a\u0000b'), encode('a\u007fb')]) {
    const prepared = await s.api.prepare(f.actor, { key: randomUUID(), targetWorkId: f.workId, expectedVersion: '1', contentType: 'text/plain', byteSize: bytes.length, sha256: await sha256(bytes) });
    const lease = await s.api.claim(f.actor, { key: randomUUID(), intentId: prepared.intentId });
    await assert.rejects(s.api.write(f.actor, { key: randomUUID(), intentId: lease.intentId, fence: lease.fence, leaseToken: lease.leaseToken }, stream(bytes)), code('invalid_content'));
  }
  assert.equal(s.store.puts, 0);
  const p = await completed(f, s, '\ufeff' + 'x'.repeat(262141)); assert.equal((await s.api.readCurrent(f.actor, { workId: f.workId }))?.text, '\ufeff' + 'x'.repeat(262141));
  assert.equal(p.input.fence, '1');
});
test('PRIVATE-RESULT-11 retained quota serializes across distinct Work targets in the same personal scope', async () => {
  const f = await fixture(), s = service(), second = await workCommands.create(f.actor, { key: randomUUID(), title: 'Second', objective: 'Second purpose' });
  await pool.query("UPDATE fp_text_policy SET byte_limit='262144'");
  const ctx = await withMemberScope(pool, { actor: f.actor, scope: 'personal' }, async () => {}, async (_q, ctx) => ctx);
  const q = await pool.connect(); let outcomes: Promise<PromiseSettledResult<unknown>[]>;
  try {
    await q.query('BEGIN'); await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`asset.quota/v1/${ctx.scope.scope_id}/work.private-draft`]);
    outcomes = Promise.allSettled([prepare(f, s), prepare({ ...f, workId: second.workId }, s)]);
    await blockedBy(q); await pool.query('SELECT 1 FROM work_items WHERE work_item_id=$1 FOR UPDATE NOWAIT', [f.workId]); await q.query('COMMIT');
  } finally { await q.query('ROLLBACK'); q.release(); }
  const results = await outcomes!; assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.code, 'asset_retained_quota');
});
test('PRIVATE-RESULT-12 expired unresolved upload remains charged; malformed/denied trusted policy never defaults', async () => {
  const f = await fixture(), s = service(); await pool.query("UPDATE fp_text_policy SET byte_limit='262144'");
  const short = createPrivateResultService(pool, { store: s.store, resolvePolicy, intentTtlSeconds: 1 }), bytes = encode('short');
  const p = await short.prepare(f.actor, { key: randomUUID(), targetWorkId: f.workId, expectedVersion: '1', contentType: 'text/plain', byteSize: bytes.length, sha256: await sha256(bytes) });
  while (!(await pool.query('SELECT expires_at<=clock_timestamp() expired FROM asset_upload_intents WHERE intent_id=$1', [p.intentId])).rows[0].expired) await delay(20);
  await assert.rejects(prepare(f, s), code('asset_retained_quota'));
  await pool.query('UPDATE fp_text_policy SET allowed=false'); await assert.rejects(s.api.readCurrent(f.actor, { workId: f.workId }), code('persistence_prohibited'));
  await pool.query("UPDATE fp_text_policy SET allowed=true,byte_limit='NaN'"); await assert.rejects(s.api.readCurrent(f.actor, { workId: f.workId }), code('private_result_unavailable'));
});
for (const table of ['private_work_results', 'scoped_transition_journal', 'scoped_outbox', 'scoped_command_receipts']) {
  test(`PRIVATE-RESULT-13 ${table} fault rolls Result/pointer/Work/facts back; same-key retry uses verified object`, async () => {
    const f = await fixture(), s = service(), p = await stored(f, s), beforePuts = s.store.puts;
    await pool.query("CREATE FUNCTION fp_fail_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic commit failure'; END $$");
    await pool.query(`CREATE TRIGGER fp_fail_result BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fp_fail_result()`);
    try { await assert.rejects(s.api.finalize(f.actor, p.input)); }
    finally { await pool.query(`DROP TRIGGER fp_fail_result ON ${table}`); await pool.query('DROP FUNCTION fp_fail_result()'); }
    assert.equal(await workVersion(f.workId), '1'); assert.equal((await pool.query('SELECT count(*)::int n FROM private_work_results')).rows[0].n, 0);
    assert.equal((await s.api.finalize(f.actor, p.input)).aggregateVersion, '2'); assert.equal(s.store.puts, beforePuts);
  });
}
test('PRIVATE-RESULT-14 lost COMMIT response is reconciled by same-key replay of real Result ID without new effect', async () => {
  const f = await fixture(), s = service(), p = await stored(f, s); let injected = false;
  const broken = new Proxy(pool, { get(target, property, receiver) {
    if (property !== 'connect') { const value = Reflect.get(target, property, receiver); return typeof value === 'function' ? value.bind(target) : value; }
    return async () => { const q = await pool.connect(); let finalReceipt = false;
      return new Proxy(q, { get(client, key, proxy) {
        if (key !== 'query') { const value = Reflect.get(client, key, proxy); return typeof value === 'function' ? value.bind(client) : value; }
        return async (...args: Parameters<PoolClient['query']>) => {
          const sql = String(args[0]); if (sql.startsWith('INSERT INTO scoped_command_receipts')) finalReceipt = true;
          const result = await (client.query as (...values: unknown[]) => Promise<unknown>)(...args);
          if (sql === 'COMMIT' && finalReceipt && !injected) { injected = true; throw new Error('Synthetic lost commit reply'); }
          return result;
        };
      } });
    };
  } });
  const api = service(s.store, broken).api; await assert.rejects(api.finalize(f.actor, p.input)); assert(injected);
  const actual = (await pool.query('SELECT result_id FROM private_work_results')).rows[0].result_id, puts = s.store.puts;
  assert.equal((await api.finalize(f.actor, p.input)).resultId, actual); assert.equal(s.store.puts, puts); assert.equal(await workVersion(f.workId), '2');
});
for (const change of ['archive', 'edit', 'session', 'policy', 'scope'] as const) {
  test(`PRIVATE-RESULT-15 ${change} during unlocked GET rejects returned private text after revalidation`, async () => {
    const f = await fixture(), s = service(); await completed(f, s); const entered = barrier(), release = barrier();
    s.store.onGet = async () => { entered.release(); await release.promise; };
    const pending = s.api.readCurrent(f.actor, { workId: f.workId }); void pending.catch(() => {}); await entered.promise;
    try {
      if (change === 'archive') await workCommands.archive(f.actor, { key: randomUUID(), workId: f.workId, expectedVersion: '2' });
      if (change === 'edit') await workCommands.update(f.actor, { key: randomUUID(), workId: f.workId, expectedVersion: '2', title: 'changed', objective: 'changed' });
      if (change === 'session') await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1', [f.actor.session_hash]);
      if (change === 'policy') await pool.query('UPDATE fp_text_policy SET allowed=false');
      if (change === 'scope') await pool.query("UPDATE resource_scopes SET status='disabled' WHERE owner_principal_id=(SELECT principal_id FROM principals WHERE user_ref=$1)", [f.actor.user_id]);
    } finally { release.release(); }
    await assert.rejects(pending); s.store.onGet = undefined;
  });
}
test('PRIVATE-RESULT-16 missing/corrupt stored text never falls back to Work objective or a raw key', async () => {
  const f = await fixture(), s = service(), p = await completed(f, s);
  const row = (await pool.query('SELECT scope_id,representation_id FROM assets WHERE asset_id=$1', [p.result.assetId])).rows[0];
  const key = objectKey({ scopeId: row.scope_id, assetId: p.result.assetId, representationId: row.representation_id });
  const get = s.store.get.bind(s.store);
  s.store.get = async id => { const object = await get(id); return object ? { ...object, body: stream(encode('corrupt')) } : null; };
  await assert.rejects(s.api.readCurrent(f.actor, { workId: f.workId }), code('integrity_mismatch')); s.store.get = get;
  await s.store.delete(key); await assert.rejects(s.api.readCurrent(f.actor, { workId: f.workId }), code('object_unavailable'));
});
test('PRIVATE-RESULT-17 actor mutation during policy await cannot select another member Work', async () => {
  const f = await fixture(), peer = await fixture(), s = service(); await completed(f, s);
  const actor = { ...f.actor }, entered = barrier(), release = barrier();
  const api = createPrivateResultService(pool, { store: s.store, resolvePolicy: async q => { entered.release(); await release.promise; return resolvePolicy(q); } });
  const pending = api.readCurrent(actor, { workId: f.workId }); await entered.promise; Object.assign(actor, peer.actor); release.release();
  assert.equal((await pending)?.workId, f.workId);
});
test('PRIVATE-RESULT-18 Asset lock wait crossing session expiry prevents even initial storage GET', async () => {
  const f = await fixture(), s = service(), p = await completed(f, s), q = await pool.connect();
  await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '1.2 seconds' WHERE token_hash=$1", [f.actor.session_hash]);
  let pending: Promise<unknown> | undefined; const gets = s.store.gets;
  try {
    await q.query('BEGIN'); await q.query('SELECT asset_id FROM assets WHERE asset_id=$1 FOR UPDATE', [p.result.assetId]);
    pending = s.api.readCurrent(f.actor, { workId: f.workId }); void pending.catch(() => {}); await blockedBy(q); await expire(f.actor); await q.query('ROLLBACK');
    await assert.rejects(pending, status(401)); assert.equal(s.store.gets, gets);
  } finally { await q.query('ROLLBACK'); q.release(); await pending?.catch(() => {}); }
});
test('PRIVATE-RESULT-19 final post-GET policy lock wait crossing expiry still denies private body', async () => {
  const f = await fixture(), s = service(); await completed(f, s); const q = await pool.connect(), entered = barrier(), release = barrier();
  await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '1.2 seconds' WHERE token_hash=$1", [f.actor.session_hash]);
  s.store.onGet = async () => { entered.release(); await release.promise; };
  const pending = s.api.readCurrent(f.actor, { workId: f.workId }); void pending.catch(() => {}); await entered.promise;
  try {
    await q.query('BEGIN'); await q.query('SELECT singleton FROM fp_text_policy FOR UPDATE'); release.release();
    await blockedBy(q); await expire(f.actor); await q.query('ROLLBACK'); await assert.rejects(pending, status(401));
  } finally { release.release(); await q.query('ROLLBACK'); q.release(); await pending.catch(() => {}); }
});
test('PRIVATE-RESULT-20 avatar claim/write/finalize reject private intent before any policy, source or store effect', async () => {
  const f = await fixture(), s = service(), p = await prepare(f, s);
  let policyCalls = 0, reads = 0, normalizes = 0;
  const avatar = createAvatarAssetService(pool, { store: s.store, normalizeAvatar: async () => { normalizes++; throw new Error('Must not normalize text as avatar'); },
    resolvePolicy: async q => { policyCalls++; return resolvePolicy(q); } });
  await assert.rejects(avatar.claim(f.actor, { key: randomUUID(), intentId: p.prepared.intentId }), status(404));
  const lease = { key: randomUUID(), intentId: p.prepared.intentId, fence: '1', leaseToken: randomUUID() };
  await assert.rejects(avatar.write(f.actor, lease, new ReadableStream({ pull(c) { reads++; c.enqueue(p.bytes); c.close(); } }, { highWaterMark: 0 })), status(404));
  await assert.rejects(avatar.finalize(f.actor, lease), status(404));
  assert.deepEqual([policyCalls, reads, normalizes, s.store.gets, s.store.puts], [0, 0, 0, 0, 0]);
  assert.equal((await pool.query('SELECT fence FROM asset_upload_intents WHERE intent_id=$1', [p.prepared.intentId])).rows[0].fence, '0');
});

test('PRIVATE-RESULT-21 all target/read IDs use central lowercase/version/variant UUID contract', async () => {
  const f = await fixture(), s = service(), base: PrivateResultPrepareInput = { key: randomUUID(), targetWorkId: f.workId,
    expectedVersion: '1', contentType: 'text/plain', byteSize: 1, sha256: 'a'.repeat(64) };
  for (const id of ['A0000000-0000-4000-8000-000000000001', 'a0000000-0000-0000-8000-000000000001', 'a0000000-0000-4000-0000-000000000001']) {
    await assert.rejects(s.api.prepare(f.actor, { ...base, targetWorkId: id }));
    await assert.rejects(s.api.readCurrent(f.actor, { workId: id }));
    await assert.rejects(s.api.readResult(f.actor, { workId: f.workId, resultId: id }));
  }
  assert.equal((await pool.query('SELECT count(*)::int n FROM assets')).rows[0].n, 0);
});

test('PRIVATE-RESULT-22 Markdown stays untrusted exact text, not rendered or interpreted', async () => {
  const f = await fixture(), s = service(), text = '# Human draft\n<script>not executed</script>\n', bytes = encode(text);
  const p = await s.api.prepare(f.actor, { key: randomUUID(), targetWorkId: f.workId, expectedVersion: '1', contentType: 'text/markdown', byteSize: bytes.length, sha256: await sha256(bytes) });
  const claim = await s.api.claim(f.actor, { key: randomUUID(), intentId: p.intentId });
  const lease = { key: randomUUID(), intentId: claim.intentId, fence: claim.fence, leaseToken: claim.leaseToken };
  await s.api.write(f.actor, { ...lease, key: randomUUID() }, stream(bytes)); await s.api.finalize(f.actor, lease);
  const read = await s.api.readCurrent(f.actor, { workId: f.workId }); assert.equal(read?.contentType, 'text/markdown'); assert.equal(read?.text, text);
});

for (const change of ['archive', 'session', 'policy'] as const) {
  test(`PRIVATE-RESULT-23 ${change} commits while PUT is blocked outside locks; late object cannot attach`, async () => {
    const f = await fixture(), s = service(), p = await prepare(f, s), claim = await s.api.claim(f.actor, { key: randomUUID(), intentId: p.prepared.intentId });
    const lease = { key: randomUUID(), intentId: claim.intentId, fence: claim.fence, leaseToken: claim.leaseToken };
    const entered = barrier(), release = barrier(); s.store.onPut = async () => { entered.release(); await release.promise; };
    const pending = s.api.write(f.actor, lease, stream(p.bytes)); void pending.catch(() => {}); await entered.promise;
    try {
      if (change === 'archive') await workCommands.archive(f.actor, { key: randomUUID(), workId: f.workId, expectedVersion: '1' });
      if (change === 'session') await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1', [f.actor.session_hash]);
      if (change === 'policy') await pool.query("UPDATE fp_text_policy SET revision='synthetic-text-v2'");
    } finally { release.release(); }
    await assert.rejects(pending);
    assert.equal((await pool.query('SELECT state FROM assets WHERE asset_id=$1', [p.prepared.assetId])).rows[0].state, 'pending');
    assert.equal((await pool.query('SELECT count(*)::int n FROM asset_objects WHERE asset_id=$1', [p.prepared.assetId])).rows[0].n, 0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM private_work_results')).rows[0].n, 0);
    assert.equal(s.store.puts, 1);
  });
}

test('PRIVATE-RESULT-24 stale fence cannot finalize after bounded lease takeover, which reuses the same stored object', async () => {
  const f = await fixture(), s = service(), p = await stored(f, s), puts = s.store.puts;
  await pool.query("UPDATE asset_upload_intents SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE intent_id=$1", [p.prepared.intentId]);
  const next = await s.api.resumeUpload(f.actor, { key: randomUUID(), intentId: p.prepared.intentId });
  assert.equal(next.fence, '2'); await assert.rejects(s.api.finalize(f.actor, p.input), code('asset_lease_stale'));
  const result = await s.api.finalize(f.actor, { key: randomUUID(), intentId: next.intentId, fence: next.fence, leaseToken: next.leaseToken });
  assert.equal(result.aggregateVersion, '2'); assert.equal(s.store.puts, puts);
});

test('PRIVATE-RESULT-25 current policy revision change invalidates in-flight read but permits an explicit fresh history read', async () => {
  const f = await fixture(), s = service(), p = await completed(f, s), entered = barrier(), release = barrier();
  s.store.onGet = async () => { entered.release(); await release.promise; };
  const pending = s.api.readResult(f.actor, { workId: f.workId, resultId: p.result.resultId }); void pending.catch(() => {}); await entered.promise;
  await pool.query("UPDATE fp_text_policy SET revision='synthetic-text-v2'"); release.release(); await assert.rejects(pending, code('asset_policy_changed'));
  s.store.onGet = undefined;
  assert.equal((await s.api.readResult(f.actor, { workId: f.workId, resultId: p.result.resultId })).text, 'PRIVATE_RESULT_BODY_測試');
  await assert.rejects(s.api.finalize(f.actor, p.input), code('asset_policy_changed'));
});
