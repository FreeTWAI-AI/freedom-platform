import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { CompactSign, exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { migrate } from '../../scripts/database.js';
import { createRuntimeRegistrations } from '../../modules/agent-control/runtime-registration.js';
import { createAgentConnections } from '../../modules/agent-control/agent-connections.js';
import { parseRuntimePublicJwk } from '../../modules/agent-control/runtime-proof.js';
import type { Actor } from '../../modules/identity-membership/service.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import { Problem } from '../../packages/shared/problem.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname)) throw new Error('Explicit isolated fp_* TEST_DATABASE_URL required.');
const schema = `fp_agent_connections_${process.pid}_${Date.now()}`, admin = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: `-c search_path=${schema} -c statement_timeout=10000`, max: 12 });
const community = randomUUID(), enrollment = createRuntimeRegistrations(pool, { environment: 'local' });
const api = createAgentConnections(pool, { environment: 'local', clientId: 'synthetic-cli' });
let created = false;
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); created = true; await migrate(pool); });
after(async () => { await pool.end(); try { if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); } });
beforeEach(async () => { await pool.query('TRUNCATE communities CASCADE'); await pool.query("INSERT INTO communities VALUES($1,'Synthetic connection members')", [community]); });
const status = (value: number) => (error: unknown) => error instanceof Problem && error.status === value;
const sqlCode = (code: string) => (error: unknown) => (error as { code?: string }).code === code;
async function member() {
  const user = randomUUID(), session = randomUUID();
  const row = (await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic owner','not-a-login',$4) RETURNING *`, [user, community, user+'@example.invalid', randomUUID()])).rows[0];
  await pool.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')", [session, user]);
  const actor: Actor = { ...row, session_hash: session, csrf_token: 'synthetic' };
  const context = await withMemberScope(pool, { actor, scope: 'personal' }, async () => {}, async (_q, context) => context);
  return { actor, context };
}
async function fixture() {
  const f = await member(), pair = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = parseRuntimePublicJwk(await exportJWK(pair.publicKey));
  const challenge = await enrollment.begin(f.actor, { key: randomUUID(), publicJwk });
  const proof = await new CompactSign(new TextEncoder().encode(challenge.payload))
    .setProtectedHeader({ alg: 'ES256', typ: 'freedom-runtime-enrollment+jws' }).sign(pair.privateKey);
  const runtime = await enrollment.confirm(f.actor, { key: randomUUID(), challengeId: challenge.challenge_id, proof });
  return { ...f, runtime, challenge, create: { key: randomUUID(), runtimeDeviceId: runtime.runtimeDeviceId } };
}
async function count(table: string) { return (await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n; }
const sinks = ['scoped_transition_journal', 'scoped_outbox', 'scoped_command_receipts'];
async function counts() { return Promise.all(['agent_connections', ...sinks].map(count)); }

test('CONNECTION-01 real enrollment creates only immutable metadata with thirty-day expiry and exact retries', async () => {
  const f = await fixture(), prior = await counts(), row = await api.create(f.actor, f.create);
  assert.equal(row.runtimeDeviceId, f.runtime.runtimeDeviceId); assert.equal(row.clientId, 'synthetic-cli');
  assert.equal(row.state, 'active'); assert.equal(row.aggregateVersion, '1'); assert.equal(row.operational_authority, false);
  assert.equal(Date.parse(row.expiresAt)-Date.parse(row.issuedAt), 2_592_000_000);
  assert.deepEqual(await api.create(f.actor, f.create), row);
  assert.deepEqual(await api.read(f.actor, { connectionId: row.connectionId }), row);
  assert.deepEqual(await counts(), prior.map(value => value + 1));
  assert.equal(await count('outbox'), 0); assert.equal(await count('execution_runs'), 0);
  const columns = (await pool.query('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2', [schema, 'agent_connections'])).rows.map(row => row.column_name);
  assert.ok(!columns.some(name => /token|nonce|public_jwk|private_key|refresh/.test(name)));
});
test('CONNECTION-02 member revoke is terminal, CAS protected and exact receipt replay stays valid', async () => {
  const f = await fixture(), row = await api.create(f.actor, f.create);
  await assert.rejects(api.revoke(f.actor, { key: randomUUID(), connectionId: row.connectionId } as never), status(428));
  await assert.rejects(api.revoke(f.actor, { key: randomUUID(), connectionId: row.connectionId, expectedVersion: '2' }), status(412));
  const revoke = { key: randomUUID(), connectionId: row.connectionId, expectedVersion: '1' };
  const revoked = await api.revoke(f.actor, revoke);
  assert.equal(revoked.state, 'revoked'); assert.equal(revoked.aggregateVersion, '2');
  assert.deepEqual(await api.revoke(f.actor, revoke), revoked);
  assert.deepEqual(await api.read(f.actor, { connectionId: row.connectionId }), revoked);
  await assert.rejects(api.revoke(f.actor, { ...revoke, expectedVersion: '2' }), status(409));
  await assert.rejects(api.create(f.actor, f.create), status(409));
  await assert.rejects(api.create(f.actor, { ...f.create, key: randomUUID() }), status(409));
  assert.equal(await count('agent_connections'), 1);
});
test('CONNECTION-03 runtime revocation blocks create and replay but owner can read and revoke connection', async () => {
  const f = await fixture(), row = await api.create(f.actor, f.create);
  await enrollment.revoke(f.actor, { key: randomUUID(), runtimeDeviceId: f.runtime.runtimeDeviceId, expectedVersion: '1' });
  await assert.rejects(api.create(f.actor, f.create), status(409));
  const otherClient = createAgentConnections(pool, { environment: 'local', clientId: 'another-cli' });
  await assert.rejects(otherClient.create(f.actor, { ...f.create, key: randomUUID() }), status(409));
  assert.deepEqual(await api.read(f.actor, { connectionId: row.connectionId }), row);
  assert.equal((await api.revoke(f.actor, { key: randomUUID(), connectionId: row.connectionId, expectedVersion: '1' })).state, 'revoked');
});
test('CONNECTION-04 exact current owner, personal scope, environment and host client bind reads and writes', async () => {
  const f = await fixture(), peer = await member(), row = await api.create(f.actor, f.create);
  await assert.rejects(api.create(peer.actor, f.create), status(404));
  for (const connectionId of [row.connectionId, randomUUID()]) {
    await assert.rejects(api.read(peer.actor, { connectionId }), status(404));
    await assert.rejects(api.revoke(peer.actor, { key: randomUUID(), connectionId, expectedVersion: '1' }), status(404));
  }
  for (const options of [{ environment: 'next' as const, clientId: 'synthetic-cli' }, { environment: 'local' as const, clientId: 'other-cli' }]) {
    const other = createAgentConnections(pool, options);
    await assert.rejects(other.read(f.actor, { connectionId: row.connectionId }), status(404));
    await assert.rejects(other.revoke(f.actor, { key: randomUUID(), connectionId: row.connectionId, expectedVersion: '1' }), status(404));
  }
  await assert.rejects(createAgentConnections(pool, { environment: 'next', clientId: 'synthetic-cli' }).create(f.actor, f.create), status(404));
});
for (const kind of ['session', 'user', 'principal', 'scope', 'onboarding'] as const) test(`CONNECTION-05 current ${kind} rejects read and successful create/revoke receipt replays`, async () => {
  const f = await fixture(), row = await api.create(f.actor, f.create);
  const revoke = { key: randomUUID(), connectionId: row.connectionId, expectedVersion: '1' };
  await api.revoke(f.actor, revoke);
  if (kind === 'session') await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1', [f.actor.session_hash]);
  if (kind === 'user') await pool.query('UPDATE users SET active=false WHERE user_id=$1', [f.actor.user_id]);
  if (kind === 'principal') await pool.query("UPDATE principals SET status='disabled' WHERE principal_id=$1", [f.context.subject_principal.principal_id]);
  if (kind === 'scope') await pool.query("UPDATE resource_scopes SET status='disabled' WHERE scope_id=$1", [f.context.scope.scope_id]);
  if (kind === 'onboarding') await pool.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1', [f.actor.user_id]);
  const expected = kind === 'session' || kind === 'user' ? 401 : 403;
  await assert.rejects(api.read(f.actor, { connectionId: row.connectionId }), status(expected));
  await assert.rejects(api.create(f.actor, f.create), status(expected));
  await assert.rejects(api.revoke(f.actor, revoke), status(expected));
});
test('CONNECTION-06 strict inputs cannot configure owner, policy, lifetime, runtime credential or host identity', async () => {
  const f = await fixture();
  for (const extra of [{ environment: 'next' }, { clientId: 'attacker' }, { expiresAt: '2099-01-01' }, { ownerUserId: randomUUID() }, { operational_authority: true }, { publicJwk: {} }])
    await assert.rejects(api.create(f.actor, { ...f.create, ...extra }));
  await assert.rejects(api.create(f.actor, { key: f.create.key, get runtimeDeviceId() { assert.fail('getter evaluated'); return f.runtime.runtimeDeviceId; } }), status(400));
  for (const clientId of ['', '-starts-with-dash', 'a'.repeat(65), 'client\n', '用戶', 'client/name'])
    assert.throws(() => createAgentConnections(pool, { environment: 'local', clientId }));
  assert.throws(() => createAgentConnections(pool, { clientId: 'ok' } as never));
  assert.throws(() => createAgentConnections(pool, { environment: 'local', clientId: 'ok', expiresIn: 5 } as never));
  assert.equal(await count('agent_connections'), 0);
});
test('CONNECTION-07 simultaneous same-key create and competing revoke each produce one transition', async () => {
  const f = await fixture(), prior = await counts();
  const [a, b] = await Promise.all([api.create(f.actor, f.create), api.create(f.actor, f.create)]);
  assert.deepEqual(a, b); assert.deepEqual(await counts(), prior.map(value => value + 1));
  const responses = await Promise.allSettled(Array.from({ length: 2 }, () => api.revoke(f.actor, { key: randomUUID(), connectionId: a.connectionId, expectedVersion: '1' })));
  assert.equal(responses.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(responses.filter(value => value.status === 'rejected' && status(412)(value.reason)).length, 1);
  assert.deepEqual(await counts(), [prior[0]+1, ...prior.slice(1).map(value => value+2)]);
});
test('CONNECTION-08 different create keys cannot replace existing runtime/client tombstone', async () => {
  const f = await fixture();
  const results = await Promise.allSettled([api.create(f.actor, f.create), api.create(f.actor, { ...f.create, key: randomUUID() })]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(results.filter(value => value.status === 'rejected' && status(409)(value.reason)).length, 1);
  assert.equal(await count('agent_connections'), 1);
});
test('CONNECTION-09 one owner/environment lifetime cap includes revoked records across host clients', async () => {
  const f = await fixture();
  for (let i = 0; i < 31; i++) {
    const client = createAgentConnections(pool, { environment: 'local', clientId: `synthetic-${i}` });
    const row = await client.create(f.actor, { ...f.create, key: randomUUID() });
    if (i === 0) await client.revoke(f.actor, { key: randomUUID(), connectionId: row.connectionId, expectedVersion: '1' });
  }
  const responses = await Promise.allSettled(['last-a', 'last-b'].map(clientId =>
    createAgentConnections(pool, { environment: 'local', clientId }).create(f.actor, { ...f.create, key: randomUUID() })));
  assert.equal(responses.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(responses.filter(value => value.status === 'rejected' && status(429)(value.reason)).length, 1);
  assert.equal(await count('agent_connections'), 32);
});
for (const sink of sinks) for (const operation of ['create', 'revoke'] as const) test(`CONNECTION-10 ${sink} failure atomically rolls back ${operation}`, async () => {
  const f = await fixture(), row = operation === 'revoke' ? await api.create(f.actor, f.create) : undefined;
  const previous = await counts();
  await pool.query("CREATE FUNCTION fp_connection_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic sink failure'; END $$");
  await pool.query(`CREATE TRIGGER fp_connection_fail BEFORE INSERT ON ${sink} FOR EACH ROW EXECUTE FUNCTION fp_connection_fail()`);
  const revoke = row && { key: randomUUID(), connectionId: row.connectionId, expectedVersion: '1' };
  try { await assert.rejects(revoke ? api.revoke(f.actor, revoke) : api.create(f.actor, f.create)); }
  finally { await pool.query(`DROP TRIGGER fp_connection_fail ON ${sink}`); await pool.query('DROP FUNCTION fp_connection_fail()'); }
  assert.deepEqual(await counts(), previous);
  if (row) assert.deepEqual(await api.read(f.actor, { connectionId: row.connectionId }), row);
  assert.equal((await (revoke ? api.revoke(f.actor, revoke) : api.create(f.actor, f.create))).state, revoke ? 'revoked' : 'active');
});
test('CONNECTION-11 SQL forbids identity/expiry/version rewriting and deletion of connection history', async () => {
  const f = await fixture(), row = await api.create(f.actor, f.create);
  for (const assignment of ['connection_id=gen_random_uuid()', 'runtime_device_id=gen_random_uuid()', 'owner_user_id=gen_random_uuid()',
    'owner_principal_id=gen_random_uuid()', 'scope_id=gen_random_uuid()', "environment='next'", "client_id='changed'",
    "issued_at=issued_at-interval '1 hour'", "expires_at=expires_at+interval '1 hour'", 'aggregate_version=aggregate_version+1', "state='revoked',revoked_at=clock_timestamp()"])
    await assert.rejects(pool.query(`UPDATE agent_connections SET ${assignment} WHERE connection_id=$1`, [row.connectionId]), sqlCode('23514'));
  await assert.rejects(pool.query('DELETE FROM agent_connections WHERE connection_id=$1', [row.connectionId]), sqlCode('23514'));
  const stored = (await pool.query('SELECT * FROM agent_connections WHERE connection_id=$1', [row.connectionId])).rows[0];
  assert.equal(stored.state, 'active'); assert.equal(stored.aggregate_version, '1');
});
