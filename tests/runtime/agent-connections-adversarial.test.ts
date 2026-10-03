import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import { migrate } from '../../scripts/database.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import type { Actor } from '../../modules/identity-membership/service.js';
import { createRuntimeRegistrations } from '../../modules/agent-control/runtime-registration.js';
import { createRuntimeRegistrationChallenge, parseRuntimePublicJwk } from '../../modules/agent-control/runtime-proof.js';
import { createAgentConnections } from '../../modules/agent-control/agent-connections.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname))
  throw new Error('Explicit isolated fp_* TEST_DATABASE_URL required.');
const schema = `fp_connection_adv_${process.pid}_${Date.now()}`;
const migrator = `${schema}_owner`, runtime = `${schema}_app`;
const admin = new Pool({ connectionString });
function roleUrl(role: string) { const url = new URL(connectionString!); url.username = role; url.password = ''; return url.toString(); }
const owner = new Pool({ connectionString: roleUrl(migrator), options: `-c search_path=${schema} -c statement_timeout=10000` });
const app = new Pool({ connectionString: roleUrl(runtime), options: `-c search_path=${schema} -c statement_timeout=10000`, max: 12 });
const enrollment = createRuntimeRegistrations(app, { environment: 'local' });
const api = createAgentConnections(app, { environment: 'local', clientId: 'synthetic-review' });
let created = false;
before(async () => {
  await admin.query(`CREATE ROLE ${migrator} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE ROLE ${runtime} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE SCHEMA ${schema} AUTHORIZATION ${migrator}; GRANT USAGE ON SCHEMA ${schema} TO ${runtime}`);
  created = true;
  await migrate(owner);
  // Exercise the versioned grant generator with only synthetic identifiers replaced.
  // This is an actual app LOGIN, never a superuser session using SET ROLE.
  const template = await readFile(new URL('../../deploy/cloudflare/sql/20-runtime-grants.psql', import.meta.url), 'utf8');
  const prefix = template.slice(template.indexOf('BEGIN;'), template.indexOf('-- BEGIN PRIVATE POLICY GRANTS'))
    .replaceAll('SCHEMA public', `SCHEMA ${schema}`).replaceAll(':"runtime"', `"${runtime}"`);
  const grants = template.split('-- BEGIN PRIVATE POLICY GRANTS\n')[1].split('\n\\gexec')[0]
    .replaceAll(":'runtime'", `'${runtime}'`).replace("n.nspname='public'", `n.nspname='${schema}'`);
  const q = await owner.connect();
  try {
    await q.query(prefix);
    const rows = await q.query(grants); assert.equal(rows.rowCount, 2);
    for (const row of rows.rows) await q.query(Object.values(row)[0] as string); await q.query('COMMIT');
  } catch (error) { await q.query('ROLLBACK'); throw error; } finally { q.release(); }
});
after(async () => {
  await app.end(); await owner.end();
  try { if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE; DROP ROLE ${runtime},${migrator}`); }
  finally { await admin.end(); }
});
const status = (...codes: number[]) => (error: unknown) => codes.includes((error as { status?: number } | null)?.status ?? 0);
const sqlCode = (...codes: string[]) => (error: unknown) => codes.includes((error as { code?: string }).code ?? '');
async function member() {
  const user = randomUUID(), community = randomUUID(), session = randomUUID();
  await owner.query("INSERT INTO communities VALUES($1,'Synthetic connection review')", [community]);
  const row = (await owner.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic member','not-a-login',$4) RETURNING *`, [user, community, user + '@example.invalid', randomUUID()])).rows[0];
  await owner.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')", [session, user]);
  const actor: Actor = { ...row, session_hash: session, csrf_token: 'synthetic' };
  const context = await withMemberScope(app, { actor, scope: 'personal' }, async () => {}, async (_q, c) => c);
  return { actor, context };
}
async function fixture(shortChallenge = false) {
  const f = await member();
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicJwk = parseRuntimePublicJwk(pair.publicKey.export({ format: 'jwk' }));
  let challenge = await enrollment.begin(f.actor, { key: randomUUID(), publicJwk });
  if (shortChallenge) {
    const row = (await owner.query(`WITH stamp AS MATERIALIZED (SELECT date_trunc('milliseconds',clock_timestamp()) now)
      INSERT INTO runtime_registration_challenges
      (challenge_id,runtime_device_id,owner_user_id,owner_principal_id,scope_id,environment,begin_key,public_jwk,key_thumbprint,nonce,issued_at,expires_at)
      SELECT gen_random_uuid(),gen_random_uuid(),owner_user_id,owner_principal_id,scope_id,environment,gen_random_uuid()::text,
        public_jwk,key_thumbprint,nonce,stamp.now-interval '299 seconds',stamp.now+interval '1 second'
      FROM runtime_registration_challenges CROSS JOIN stamp WHERE challenge_id=$1 RETURNING *`, [challenge.challenge_id])).rows[0];
    challenge = createRuntimeRegistrationChallenge({ challenge_id: row.challenge_id, runtime_device_id: row.runtime_device_id,
      owner_member_id: row.owner_user_id, owner_principal_id: row.owner_principal_id, scope_id: row.scope_id, environment: row.environment,
      key_thumbprint: row.key_thumbprint, nonce: row.nonce, issued_at: row.issued_at.toISOString(), expires_at: row.expires_at.toISOString() });
  }
  const signed = Buffer.from('{"alg":"ES256","typ":"freedom-runtime-enrollment+jws"}').toString('base64url') + '.' + Buffer.from(challenge.payload).toString('base64url');
  const proof = signed + '.' + sign('sha256', Buffer.from(signed), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const registered = await enrollment.confirm(f.actor, { key: randomUUID(), challengeId: challenge.challenge_id, proof });
  const input = { key: randomUUID(), runtimeDeviceId: registered.runtimeDeviceId };
  return { ...f, input, registered, challenge, proof, privateKey: pair.privateKey };
}
async function counts() {
  return Promise.all(['agent_connections', 'scoped_command_receipts', 'scoped_transition_journal', 'scoped_outbox']
    .map(async table => (await owner.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n));
}
async function blocking(holder: PoolClient) {
  const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  for (let i = 0; i < 300; i++) {
    if ((await admin.query('SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid])).rows[0].n) return;
    await delay(10);
  }
  assert.fail('Actual PostgreSQL row-lock wait was not observed');
}
async function sessionExpired(actor: Actor) {
  for (let i = 0; i < 300; i++) {
    if ((await owner.query('SELECT expires_at<=clock_timestamp() expired FROM sessions WHERE token_hash=$1', [actor.session_hash])).rows[0].expired) return;
    await delay(10);
  }
  assert.fail('DB clock did not cross session expiry');
}

test('CONNECTION-ADV actual LOGIN roles and real enrollment produce closed metadata only', async () => {
  for (const [pool, name] of [[owner, migrator], [app, runtime]] as const) {
    assert.deepEqual((await pool.query(`SELECT current_user,session_user,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolreplication
      FROM pg_roles WHERE rolname=current_user`)).rows[0], {
      current_user: name, session_user: name, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false, rolreplication: false,
    });
  }
  const f = await fixture(), value = await api.create(f.actor, f.input);
  assert.equal(value.operational_authority, false); assert.equal(value.state, 'active'); assert.equal(value.aggregateVersion, '1');
  assert.equal(value.runtimeDeviceId, f.registered.runtimeDeviceId); assert.equal(value.clientId, 'synthetic-review');
  assert.equal(Date.parse(value.expiresAt) - Date.parse(value.issuedAt), 30 * 86400000);
  assert.deepEqual(await api.read(f.actor, { connectionId: value.connectionId }), value);
  assert.ok(!JSON.stringify(value).includes(f.proof));
  for (const table of ['agent_connections', 'scoped_command_receipts', 'scoped_transition_journal', 'scoped_outbox']) {
    const data = JSON.stringify((await owner.query(`SELECT * FROM ${table}`)).rows);
    assert.ok(!data.includes(f.proof)); assert.ok(!data.includes(f.privateKey.export({ format: 'jwk' }).d!));
  }
});

test('CONNECTION-ADV concurrent exact create retries have one connection and one set of facts', async () => {
  const f = await fixture(), initial = await counts();
  const values = await Promise.all([api.create(f.actor, f.input), api.create(f.actor, f.input)]);
  assert.deepEqual(values[0], values[1]);
  assert.deepEqual(await counts(), initial.map(n => n + 1));
  await assert.rejects(api.create(f.actor, { ...f.input, key: randomUUID() }), status(409));
  assert.deepEqual(await counts(), initial.map(n => n + 1));
});

test('CONNECTION-ADV owner, environment and client bindings prevent existence leaks or host overrides', async () => {
  const f = await fixture(), peer = await member(), value = await api.create(f.actor, f.input);
  for (const runtimeDeviceId of [f.input.runtimeDeviceId, randomUUID()])
    await assert.rejects(api.create(peer.actor, { key: randomUUID(), runtimeDeviceId }), status(404));
  for (const connectionId of [value.connectionId, randomUUID()]) {
    await assert.rejects(api.read(peer.actor, { connectionId }), status(404));
    await assert.rejects(api.revoke(peer.actor, { key: randomUUID(), connectionId, expectedVersion: '1' }), status(404));
  }
  for (const options of [{ environment: 'next' as const, clientId: 'synthetic-review' }, { environment: 'local' as const, clientId: 'other-client' }])
    await assert.rejects(createAgentConnections(app, options).read(f.actor, { connectionId: value.connectionId }), status(404));
  for (const extra of [{ environment: 'next' }, { clientId: 'other-client' }, { ownerUserId: peer.actor.user_id }, { operational_authority: true }])
    await assert.rejects(api.create(f.actor, { ...f.input, ...extra }));
});

test('CONNECTION-ADV changed create body cannot reuse a successful receipt key', async () => {
  const f = await fixture(); await api.create(f.actor, f.input);
  // A second genuinely enrolled runtime of the same member reaches receipt conflict,
  // rather than having a missing/foreign runtime conceal an idempotency failure.
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const challenge = await enrollment.begin(f.actor, { key: randomUUID(), publicJwk: parseRuntimePublicJwk(pair.publicKey.export({ format: 'jwk' })) });
  const signed = Buffer.from('{"alg":"ES256","typ":"freedom-runtime-enrollment+jws"}').toString('base64url') + '.' + Buffer.from(challenge.payload).toString('base64url');
  await enrollment.confirm(f.actor, { key: randomUUID(), challengeId: challenge.challenge_id,
    proof: signed + '.' + sign('sha256', Buffer.from(signed), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') });
  const initial = await counts();
  await assert.rejects(api.create(f.actor, { ...f.input, runtimeDeviceId: challenge.runtime_device_id }), status(409));
  assert.deepEqual(await counts(), initial);
});

for (const kind of ['session', 'user', 'principal', 'scope', 'onboarding'] as const) {
  test(`CONNECTION-ADV current ${kind} authorization precedes receipt replay and reads`, async () => {
    const f = await fixture(), value = await api.create(f.actor, f.input), initial = await counts();
    if (kind === 'session') await owner.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1', [f.actor.session_hash]);
    if (kind === 'user') await owner.query('UPDATE users SET active=false WHERE user_id=$1', [f.actor.user_id]);
    if (kind === 'principal') await owner.query("UPDATE principals SET status='disabled' WHERE principal_id=$1", [f.context.subject_principal.principal_id]);
    if (kind === 'scope') await owner.query("UPDATE resource_scopes SET status='disabled' WHERE scope_id=$1", [f.context.scope.scope_id]);
    if (kind === 'onboarding') await owner.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1', [f.actor.user_id]);
    const expected = kind === 'session' || kind === 'user' ? 401 : 403;
    await assert.rejects(api.create(f.actor, f.input), status(expected));
    await assert.rejects(api.read(f.actor, { connectionId: value.connectionId }), status(expected));
    await assert.rejects(api.revoke(f.actor, { key: randomUUID(), connectionId: value.connectionId, expectedVersion: '1' }), status(expected));
    assert.deepEqual(await counts(), initial);
  });
}

test('CONNECTION-ADV runtime revocation blocks new create and old create replay but leaves read/revoke available', async () => {
  const f = await fixture(), value = await api.create(f.actor, f.input);
  await enrollment.revoke(f.actor, { key: randomUUID(), runtimeDeviceId: f.input.runtimeDeviceId, expectedVersion: '1' });
  const initial = await counts();
  await assert.rejects(api.create(f.actor, f.input), status(409));
  await assert.rejects(api.create(f.actor, { ...f.input, key: randomUUID() }), status(409));
  assert.deepEqual(await counts(), initial);
  assert.equal((await api.read(f.actor, { connectionId: value.connectionId })).state, 'active');
  assert.equal((await api.revoke(f.actor, { key: randomUUID(), connectionId: value.connectionId, expectedVersion: '1' })).state, 'revoked');
  const g = await fixture();
  await enrollment.revoke(g.actor, { key: randomUUID(), runtimeDeviceId: g.input.runtimeDeviceId, expectedVersion: '1' });
  await assert.rejects(api.create(g.actor, g.input), status(409));
});

test('CONNECTION-ADV revoke requires version, serializes competing CAS and retains exact revoke replay', async () => {
  const f = await fixture(), value = await api.create(f.actor, f.input);
  const input = { key: randomUUID(), connectionId: value.connectionId, expectedVersion: '1' };
  await assert.rejects(api.revoke(f.actor, { key: input.key, connectionId: value.connectionId } as typeof input), status(428));
  await assert.rejects(api.revoke(f.actor, { ...input, expectedVersion: '2' }), status(412));
  const inputs = [input, { ...input, key: randomUUID() }];
  const results = await Promise.allSettled(inputs.map(candidate => api.revoke(f.actor, candidate)));
  assert.equal(results.filter(v => v.status === 'fulfilled').length, 1);
  const winner = results.findIndex(v => v.status === 'fulfilled');
  const expected = (results[winner] as PromiseFulfilledResult<Awaited<ReturnType<typeof api.revoke>>>).value;
  assert.equal(expected.state, 'revoked'); assert.equal(expected.aggregateVersion, '2');
  assert.deepEqual(await api.revoke(f.actor, inputs[winner]), expected);
  await assert.rejects(api.revoke(f.actor, { ...inputs[winner], expectedVersion: '2' }), status(409));
  await assert.rejects(api.create(f.actor, f.input), status(409));
  await assert.rejects(api.create(f.actor, { ...f.input, key: randomUUID() }), status(409));
});

for (const action of ['create', 'revoke'] as const) for (const sink of ['scoped_command_receipts', 'scoped_transition_journal', 'scoped_outbox']) {
  test(`CONNECTION-ADV ${action} rolls back row and all facts when ${sink} fails`, async () => {
    const f = await fixture(), value = action === 'revoke' ? await api.create(f.actor, f.input) : null;
    const input = value ? { key: randomUUID(), connectionId: value.connectionId, expectedVersion: '1' } : null;
    const run = () => input ? api.revoke(f.actor, input) : api.create(f.actor, f.input);
    const initial = await counts();
    await owner.query("CREATE FUNCTION connection_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic sink fault'; END $$");
    await owner.query(`CREATE TRIGGER connection_test_fail BEFORE INSERT ON ${sink} FOR EACH ROW EXECUTE FUNCTION connection_test_fail()`);
    try { await assert.rejects(run()); }
    finally { await owner.query(`DROP TRIGGER connection_test_fail ON ${sink}`); await owner.query('DROP FUNCTION connection_test_fail()'); }
    assert.deepEqual(await counts(), initial);
    if (value) assert.equal((await api.read(f.actor, { connectionId: value.connectionId })).state, 'active');
    assert.equal((await run()).operational_authority, false);
  });
}

for (const replay of [false, true]) {
  test(`CONNECTION-ADV committed runtime revocation wins an observed registration lock wait (${replay ? 'replay' : 'new create'})`, async () => {
    const f = await fixture(); if (replay) await api.create(f.actor, f.input);
    const initial = await counts(), holder = await app.connect();
    await holder.query('BEGIN');
    await holder.query("UPDATE runtime_registrations SET state='revoked',aggregate_version=aggregate_version+1,revoked_at=clock_timestamp() WHERE runtime_device_id=$1", [f.input.runtimeDeviceId]);
    const rejected = assert.rejects(api.create(f.actor, f.input), status(409));
    try { await blocking(holder); } finally { await holder.query('COMMIT'); holder.release(); }
    await rejected; assert.deepEqual(await counts(), initial);
  });
}

for (const operation of ['create', 'read', 'revoke'] as const) {
  test(`CONNECTION-ADV ${operation} rechecks real session time after an observed registration lock wait`, async () => {
    const f = await fixture(), value = operation === 'create' ? null : await api.create(f.actor, f.input);
    await owner.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '750 milliseconds' WHERE token_hash=$1", [f.actor.session_hash]);
    const initial = await counts(), holder = await app.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT runtime_device_id FROM runtime_registrations WHERE runtime_device_id=$1 FOR UPDATE', [f.input.runtimeDeviceId]);
    const pending = operation === 'create' ? api.create(f.actor, f.input) : operation === 'read'
      ? api.read(f.actor, { connectionId: value!.connectionId })
      : api.revoke(f.actor, { key: randomUUID(), connectionId: value!.connectionId, expectedVersion: '1' });
    const rejected = assert.rejects(pending, status(401));
    try { await blocking(holder); await sessionExpired(f.actor); } finally { await holder.query('ROLLBACK'); holder.release(); }
    await rejected; assert.deepEqual(await counts(), initial);
  });
}

test('CONNECTION-ADV application role cannot weaken triggers, own schema, truncate history or change ledger', async () => {
  const f = await fixture(), value = await api.create(f.actor, f.input);
  for (const sql of ['TRUNCATE agent_connections', 'ALTER TABLE agent_connections DISABLE TRIGGER ALL',
    'CREATE TABLE forbidden_connection_table(id int)', 'UPDATE schema_migrations SET name=name'])
    await assert.rejects(app.query(sql), sqlCode('42501'));
  for (const assignment of ['connection_id=gen_random_uuid()', 'runtime_device_id=gen_random_uuid()',
    'owner_user_id=gen_random_uuid()', 'owner_principal_id=gen_random_uuid()', 'scope_id=gen_random_uuid()',
    "environment='next'", "client_id='changed-client'", "issued_at=issued_at-interval '1 day'", "expires_at=expires_at+interval '1 day'", 'aggregate_version=2'])
    await assert.rejects(app.query(`UPDATE agent_connections SET ${assignment} WHERE connection_id=$1`, [value.connectionId]), sqlCode('23514'));
  await assert.rejects(app.query('DELETE FROM agent_connections WHERE connection_id=$1', [value.connectionId]), sqlCode('23514'));
});

test('CONNECTION-ADV receipt insert wait crossing session expiry rolls back new connection and all facts', async () => {
  const f = await fixture(), initial = await counts(), holder = await owner.connect();
  const barrier = 700000000 + process.pid;
  await owner.query(`CREATE FUNCTION connection_receipt_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_advisory_xact_lock(${barrier}::bigint); RETURN NEW; END $$`);
  await owner.query('CREATE TRIGGER connection_receipt_barrier BEFORE INSERT ON scoped_command_receipts FOR EACH ROW EXECUTE FUNCTION connection_receipt_barrier()');
  await holder.query('BEGIN'); await holder.query('SELECT pg_advisory_xact_lock($1::bigint)', [barrier]);
  await owner.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '750 milliseconds' WHERE token_hash=$1", [f.actor.session_hash]);
  const outcome = api.create(f.actor, f.input).then(value => ({ value, error: null }), error => ({ value: null, error }));
  try { await blocking(holder); await sessionExpired(f.actor); }
  finally { await holder.query('ROLLBACK'); holder.release(); }
  let result;
  try { result = await outcome; }
  finally {
    await owner.query('DROP TRIGGER connection_receipt_barrier ON scoped_command_receipts');
    await owner.query('DROP FUNCTION connection_receipt_barrier()');
  }
  assert.ok(status(401)(result.error), 'Receipt completion after session expiry must be denied');
  assert.deepEqual(await counts(), initial);
});

async function insertConnection(q: Pool | PoolClient, runtimeId: string, changes: Record<string, unknown> = {}, nearExpiry = false) {
  const names = ['connection_id', 'runtime_device_id', 'owner_user_id', 'owner_principal_id', 'scope_id', 'environment', 'client_id'];
  const defaults = ['gen_random_uuid()', 'runtime_device_id', 'owner_user_id', 'owner_principal_id', 'scope_id', 'environment', "'synthetic-review'"];
  const args: unknown[] = [runtimeId];
  const values = names.map((name, index) => Object.hasOwn(changes, name) ? `$${args.push(changes[name])}` : defaults[index]);
  return q.query(`WITH stamp AS MATERIALIZED (SELECT date_trunc('milliseconds',clock_timestamp()) now)
    INSERT INTO ${schema}.agent_connections(${names.join(',')},issued_at,expires_at)
    SELECT ${values.join(',')},stamp.now${nearExpiry ? "-interval '720 hours'+interval '1 second'" : ''},
      stamp.now+interval '${nearExpiry ? '1 second' : '720 hours'}'
    FROM ${schema}.runtime_registrations CROSS JOIN stamp WHERE runtime_device_id=$1 RETURNING *`, args);
}

test('CONNECTION-ADV SQL binding rejects foreign owner/scope/environment and NULL identity', async () => {
  const f = await fixture(), peer = await fixture();
  for (const changes of [{ owner_user_id: peer.actor.user_id }, { owner_principal_id: peer.context.subject_principal.principal_id },
    { scope_id: peer.context.scope.scope_id }, { environment: 'next' }, { owner_user_id: null }, { scope_id: null }])
    await assert.rejects(insertConnection(app, f.input.runtimeDeviceId, changes), sqlCode('23514', '23502', '23503'));
  assert.equal((await owner.query('SELECT count(*)::int n FROM agent_connections WHERE runtime_device_id=$1', [f.input.runtimeDeviceId])).rows[0].n, 0);
});

test('CONNECTION-ADV TEMP runtime shadow cannot restore a physically revoked registration', async () => {
  const f = await fixture();
  await enrollment.revoke(f.actor, { key: randomUUID(), runtimeDeviceId: f.input.runtimeDeviceId, expectedVersion: '1' });
  const q = await app.connect(); await q.query('BEGIN');
  try {
    await q.query(`CREATE TEMP TABLE runtime_registrations AS SELECT * FROM ${schema}.runtime_registrations WHERE runtime_device_id=$1`, [f.input.runtimeDeviceId]);
    await q.query("UPDATE pg_temp.runtime_registrations SET state='enrolled',revoked_at=NULL");
    await assert.rejects(insertConnection(q, f.input.runtimeDeviceId), sqlCode('23514'));
  } finally { await q.query('ROLLBACK'); q.release(); }
});

test('CONNECTION-ADV expired connection remains readable and revocable but cannot be created again', async () => {
  const f = await fixture();
  const row = (await insertConnection(app, f.input.runtimeDeviceId, {}, true)).rows[0];
  for (let i = 0; i < 300; i++) {
    if ((await owner.query('SELECT expires_at<=clock_timestamp() expired FROM agent_connections WHERE connection_id=$1', [row.connection_id])).rows[0].expired) break;
    await delay(10);
  }
  assert.equal((await owner.query('SELECT expires_at<=clock_timestamp() expired FROM agent_connections WHERE connection_id=$1', [row.connection_id])).rows[0].expired, true);
  await assert.rejects(api.create(f.actor, f.input), status(409));
  const value = await api.read(f.actor, { connectionId: row.connection_id });
  assert.equal(value.operational_authority, false); assert.equal(value.state, 'active');
  assert.equal((await api.revoke(f.actor, { key: randomUUID(), connectionId: row.connection_id, expectedVersion: '1' })).state, 'revoked');
});

test('CONNECTION-ADV enrolled runtime remains usable after its genuinely signed challenge expires', async () => {
  const f = await fixture(true);
  for (let i = 0; i < 300; i++) {
    if ((await owner.query('SELECT expires_at<=clock_timestamp() expired FROM runtime_registration_challenges WHERE challenge_id=$1', [f.challenge.challenge_id])).rows[0].expired) break;
    await delay(10);
  }
  assert.equal((await owner.query('SELECT expires_at<=clock_timestamp() expired FROM runtime_registration_challenges WHERE challenge_id=$1', [f.challenge.challenge_id])).rows[0].expired, true);
  assert.equal((await api.create(f.actor, f.input)).operational_authority, false);
});
