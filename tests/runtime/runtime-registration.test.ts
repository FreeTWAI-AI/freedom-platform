import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { CompactSign, exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { migrate } from '../../scripts/database.js';
import { createRuntimeRegistrations } from '../../modules/agent-control/runtime-registration.js';
import { parseRuntimePublicJwk } from '../../modules/agent-control/runtime-proof.js';
import type { RuntimeRegistrationChallenge } from '../../contracts/execution/v1/runtime-registration.js';
import type { Actor } from '../../modules/identity-membership/service.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import { Problem } from '../../packages/shared/problem.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname)) throw new Error('Explicit isolated fp_* TEST_DATABASE_URL required.');
const schema = `fp_runtime_registration_${process.pid}_${Date.now()}`, admin = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: `-c search_path=${schema} -c statement_timeout=10000`, max: 12 });
const community = randomUUID(), service = createRuntimeRegistrations(pool, { environment: 'local' });
let created = false;
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); created = true; await migrate(pool); });
after(async () => { await pool.end(); try { if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); } });
beforeEach(async () => { await pool.query('TRUNCATE communities CASCADE'); await pool.query("INSERT INTO communities VALUES($1,'Synthetic enrollment members')", [community]); });
const status = (value: number) => (error: unknown) => error instanceof Problem && error.status === value;
async function member() {
  const user = randomUUID(), session = randomUUID();
  const row = (await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic runtime owner','not-a-login',$4) RETURNING *`, [user, community, user+'@example.invalid', randomUUID()])).rows[0];
  await pool.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')", [session, user]);
  const actor: Actor = { ...row, session_hash: session, csrf_token: 'synthetic' };
  const context = await withMemberScope(pool, { actor, scope: 'personal' }, async () => {}, async (_q, context) => context);
  return { actor, context };
}
async function keys() {
  const pair = await generateKeyPair('ES256', { extractable: true });
  return { publicJwk: parseRuntimePublicJwk(await exportJWK(pair.publicKey)), privateKey: pair.privateKey };
}
async function sign(challenge: RuntimeRegistrationChallenge, privateKey: CryptoKey) {
  return new CompactSign(new TextEncoder().encode(challenge.payload))
    .setProtectedHeader({ alg: 'ES256', typ: 'freedom-runtime-enrollment+jws' }).sign(privateKey);
}
async function fixture() {
  const f = await member(), pair = await keys(), input = { key: randomUUID(), publicJwk: pair.publicJwk };
  const challenge = await service.begin(f.actor, input), proof = await sign(challenge, pair.privateKey);
  return { ...f, ...pair, input, challenge, confirm: { key: randomUUID(), challengeId: challenge.challenge_id, proof } };
}
async function count(table: string) { return (await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n; }

test('ENROLL-01 server challenge + actual ES256 confirmation persist public metadata and terminal revocation', async () => {
  const f = await fixture();
  assert.equal(Date.parse(f.challenge.expires_at)-Date.parse(f.challenge.issued_at), 300_000);
  assert.deepEqual(await service.begin(f.actor, f.input), f.challenge);
  const row = await service.confirm(f.actor, f.confirm);
  assert.equal(row.runtimeDeviceId, f.challenge.runtime_device_id); assert.equal(row.state, 'enrolled');
  assert.equal(row.operational_authority, false); assert.equal(row.aggregateVersion, '1');
  assert.deepEqual(await service.read(f.actor, { runtimeDeviceId: row.runtimeDeviceId }), row);
  assert.deepEqual(await service.confirm(f.actor, f.confirm), row);
  const revoke = { key: randomUUID(), runtimeDeviceId: row.runtimeDeviceId, expectedVersion: '1' };
  const revoked = await service.revoke(f.actor, revoke);
  assert.equal(revoked.state, 'revoked'); assert.equal(revoked.aggregateVersion, '2');
  assert.deepEqual(await service.revoke(f.actor, revoke), revoked);
  assert.equal((await service.read(f.actor, { runtimeDeviceId: row.runtimeDeviceId })).state, 'revoked');
  await assert.rejects(service.confirm(f.actor, f.confirm), status(409));
  await assert.rejects(service.begin(f.actor, f.input), status(409));
  await assert.rejects(service.begin(f.actor, { ...f.input, key: randomUUID() }), status(409));
});
test('ENROLL-02 concurrent same-key begin and confirm each write once', async () => {
  const f = await member(), pair = await keys(), input = { key: randomUUID(), publicJwk: pair.publicJwk };
  const results = await Promise.all([service.begin(f.actor, input), service.begin(f.actor, input)]);
  assert.deepEqual(results[0], results[1]); assert.equal(await count('runtime_registration_challenges'), 1);
  const confirm = { key: randomUUID(), challengeId: results[0].challenge_id, proof: await sign(results[0], pair.privateKey) };
  const enrolled = await Promise.all([service.confirm(f.actor, confirm), service.confirm(f.actor, confirm)]);
  assert.deepEqual(enrolled[0], enrolled[1]); assert.equal(await count('runtime_registrations'), 1);
  assert.equal(await count('scoped_command_receipts'), 2); assert.equal(await count('scoped_transition_journal'), 2);
});
test('ENROLL-03 public-key pending challenges cannot squat ownership; confirmed key cannot rebind', async () => {
  const f = await fixture(), peer = await member();
  const other = await service.begin(peer.actor, { key: randomUUID(), publicJwk: f.publicJwk });
  await assert.rejects(service.confirm(peer.actor, { key: randomUUID(), challengeId: other.challenge_id, proof: f.confirm.proof }), status(403));
  const row = await service.confirm(f.actor, f.confirm);
  await assert.rejects(service.confirm(peer.actor, { key: randomUUID(), challengeId: other.challenge_id, proof: await sign(other, f.privateKey) }), status(409));
  assert.equal((await service.read(f.actor, { runtimeDeviceId: row.runtimeDeviceId })).state, 'enrolled');
});
test('ENROLL-04 different receipt keys cannot consume one challenge twice', async () => {
  const f = await fixture();
  const responses = await Promise.allSettled([service.confirm(f.actor, f.confirm), service.confirm(f.actor, { ...f.confirm, key: randomUUID() })]);
  assert.equal(responses.filter(v => v.status === 'fulfilled').length, 1);
  const failure = responses.find(v => v.status === 'rejected') as PromiseRejectedResult;
  assert.ok(status(409)(failure.reason)); assert.equal(await count('runtime_registrations'), 1);
});
test('ENROLL-05 stale owner authority denies all successful receipt replays', async () => {
  const f = await fixture(), row = await service.confirm(f.actor, f.confirm);
  await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1', [f.actor.session_hash]);
  await assert.rejects(service.confirm(f.actor, f.confirm), status(401));
  await assert.rejects(service.read(f.actor, { runtimeDeviceId: row.runtimeDeviceId }), status(401));
  await assert.rejects(service.revoke(f.actor, { key: randomUUID(), runtimeDeviceId: row.runtimeDeviceId, expectedVersion: '1' }), status(401));
});
test('ENROLL-06 private proof never appears in durable receipts/facts and public nonce conveys no authority', async () => {
  const f = await fixture(); await service.confirm(f.actor, f.confirm);
  for (const table of ['scoped_command_receipts','scoped_transition_journal','scoped_outbox','runtime_registration_challenges','runtime_registrations']) {
    const rows = JSON.stringify((await pool.query(`SELECT * FROM ${table}`)).rows);
    assert.ok(!rows.includes(f.confirm.proof)); assert.ok(!rows.includes('PRIVATE KEY'));
  }
  assert.equal(await count('outbox'), 0); assert.equal(await count('execution_runs'), 0);
});
test('ENROLL-07 wrong owner and environment cannot read or consume a challenge', async () => {
  const f = await fixture(), peer = await member(), otherEnv = createRuntimeRegistrations(pool, { environment: 'next' });
  await assert.rejects(service.confirm(peer.actor, f.confirm), status(404));
  await assert.rejects(otherEnv.confirm(f.actor, f.confirm), status(404));
  const row = await service.confirm(f.actor, f.confirm);
  for (const runtimeDeviceId of [row.runtimeDeviceId, randomUUID()]) {
    await assert.rejects(service.read(peer.actor, { runtimeDeviceId }), status(404));
    await assert.rejects(service.revoke(peer.actor, { key: randomUUID(), runtimeDeviceId, expectedVersion: '1' }), status(404));
  }
  await assert.rejects(otherEnv.read(f.actor, { runtimeDeviceId: row.runtimeDeviceId }), status(404));
});
test('ENROLL-08 strict input/host configuration and completed onboarding cannot be caller-overridden', async () => {
  const f = await member(), pair = await keys();
  for (const extra of [{ runtimeDeviceId: randomUUID() }, { environment: 'next' }, { operational_authority: true }, { expiresIn: 999999 }])
    await assert.rejects(service.begin(f.actor, { key: randomUUID(), publicJwk: pair.publicJwk, ...extra }));
  const input = { key: randomUUID(), get publicJwk() { assert.fail('getter must never execute'); return pair.publicJwk; } };
  await assert.rejects(service.begin(f.actor, input), status(400));
  assert.throws(() => createRuntimeRegistrations(pool, {} as never));
  await pool.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1', [f.actor.user_id]);
  await assert.rejects(service.begin(f.actor, { key: randomUUID(), publicJwk: pair.publicJwk }), status(403));
});
test('ENROLL-09 pending owner cap is serialized and rejected begin has no receipt', async () => {
  const f = await member(), pair = await keys();
  const results = await Promise.allSettled(Array.from({ length: 11 }, () => service.begin(f.actor, { key: randomUUID(), publicJwk: pair.publicJwk })));
  assert.equal(results.filter(v => v.status === 'fulfilled').length, 10);
  assert.equal(results.filter(v => v.status === 'rejected' && status(429)(v.reason)).length, 1);
  assert.equal(await count('runtime_registration_challenges'), 10); assert.equal(await count('scoped_command_receipts'), 10);
});
test('ENROLL-10 key identity is per environment; enrollment requires separate signed challenge', async () => {
  const f = await fixture(), next = createRuntimeRegistrations(pool, { environment: 'next' });
  await service.confirm(f.actor, f.confirm);
  const challenge = await next.begin(f.actor, { key: randomUUID(), publicJwk: f.publicJwk });
  await assert.rejects(next.confirm(f.actor, { key: randomUUID(), challengeId: challenge.challenge_id, proof: f.confirm.proof }), status(403));
  const row = await next.confirm(f.actor, { key: randomUUID(), challengeId: challenge.challenge_id, proof: await sign(challenge, f.privateKey) });
  assert.equal(row.environment, 'next'); assert.equal(await count('runtime_registrations'), 2);
});
for (const table of ['scoped_transition_journal', 'scoped_outbox', 'scoped_command_receipts']) {
  test(`ENROLL-11 ${table} failure rolls back consume, registration and all facts`, async () => {
    const f = await fixture(), before = await Promise.all(['scoped_transition_journal','scoped_outbox','scoped_command_receipts'].map(count));
    await pool.query("CREATE FUNCTION fp_enrollment_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic sink failure'; END $$");
    await pool.query(`CREATE TRIGGER fp_enrollment_fail BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fp_enrollment_fail()`);
    try { await assert.rejects(service.confirm(f.actor, f.confirm)); } finally {
      await pool.query(`DROP TRIGGER fp_enrollment_fail ON ${table}`); await pool.query('DROP FUNCTION fp_enrollment_fail()');
    }
    assert.equal(await count('runtime_registrations'), 0);
    assert.equal((await pool.query('SELECT consumed_at FROM runtime_registration_challenges WHERE challenge_id=$1', [f.challenge.challenge_id])).rows[0].consumed_at, null);
    assert.deepEqual(await Promise.all(['scoped_transition_journal','scoped_outbox','scoped_command_receipts'].map(count)), before);
    assert.equal((await service.confirm(f.actor, f.confirm)).state, 'enrolled');
  });
}
test('ENROLL-12 current version controls revoke, with exactly one winner', async () => {
  const f = await fixture(), row = await service.confirm(f.actor, f.confirm);
  await assert.rejects(service.revoke(f.actor, { key: randomUUID(), runtimeDeviceId: row.runtimeDeviceId } as never), status(428));
  const results = await Promise.allSettled(Array.from({ length: 2 }, () => service.revoke(f.actor, { key: randomUUID(), runtimeDeviceId: row.runtimeDeviceId, expectedVersion: '1' })));
  assert.equal(results.filter(v => v.status === 'fulfilled').length, 1);
  assert.equal(results.filter(v => v.status === 'rejected' && status(412)(v.reason)).length, 1);
});
