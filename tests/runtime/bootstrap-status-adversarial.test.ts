import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import { migrate } from '../../scripts/database.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import type { Actor } from '../../modules/identity-membership/service.js';
import type { BootstrapProofHost } from '../../contracts/execution/v1/bootstrap.js';
import { createRuntimeRegistrations } from '../../modules/agent-control/runtime-registration.js';
import { parseRuntimePublicJwk } from '../../modules/agent-control/runtime-proof.js';
import { createAgentConnections } from '../../modules/agent-control/agent-connections.js';
import { createBootstrapStatus } from '../../modules/agent-control/bootstrap-status.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname))
  throw new Error('Explicit isolated fp_* TEST_DATABASE_URL required.');
const schema = `fp_bootstrap_adv_${process.pid}_${Date.now()}`, migrator = `${schema}_owner`, runtime = `${schema}_app`;
const admin = new Pool({ connectionString });
function roleUrl(role: string) { const url = new URL(connectionString!); url.username = role; url.password = ''; return url.toString(); }
const owner = new Pool({ connectionString: roleUrl(migrator), options: `-c search_path=${schema} -c statement_timeout=10000` });
const app = new Pool({ connectionString: roleUrl(runtime), options: `-c search_path=${schema} -c statement_timeout=10000`, max: 12 });
const issuer = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const host: BootstrapProofHost = { environment: 'local', clientId: 'synthetic-bootstrap-review',
  issuer: 'https://issuer.example.invalid/', audience: 'https://platform.example.invalid/',
  bootstrapUri: 'https://platform.example.invalid/execution-api/v1/bootstrap',
  keys: [{ kid: 'synthetic-issuer', purpose: 'bootstrap_access', environment: 'local',
    publicJwk: parseRuntimePublicJwk(issuer.publicKey.export({ format: 'jwk' })), notBeforeMs: 0, notAfterMs: Number.MAX_SAFE_INTEGER, revoked: false }] };
const api = createBootstrapStatus(app, host);
const enrollment = createRuntimeRegistrations(app, { environment: 'local' });
const connections = createAgentConnections(app, { environment: 'local', clientId: host.clientId });
let created = false;
before(async () => {
  await admin.query(`CREATE ROLE ${migrator} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE ROLE ${runtime} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE SCHEMA ${schema} AUTHORIZATION ${migrator}; GRANT USAGE ON SCHEMA ${schema} TO ${runtime}`);
  created = true; await migrate(owner);
  const template = await readFile(new URL('../../deploy/cloudflare/sql/20-runtime-grants.psql', import.meta.url), 'utf8');
  const prefix = template.slice(template.indexOf('BEGIN;'), template.indexOf('-- BEGIN PRIVATE POLICY GRANTS'))
    .replaceAll('SCHEMA public', `SCHEMA ${schema}`).replaceAll(':"runtime"', `"${runtime}"`);
  const grants = template.split('-- BEGIN PRIVATE POLICY GRANTS\n')[1].split('\n\\gexec')[0]
    .replaceAll(":'runtime'", `'${runtime}'`).replace("n.nspname='public'", `n.nspname='${schema}'`);
  const q = await owner.connect();
  try { await q.query(prefix); const rows = await q.query(grants); assert.equal(rows.rowCount, 1);
    await q.query(Object.values(rows.rows[0])[0] as string); await q.query('COMMIT'); }
  catch (error) { await q.query('ROLLBACK'); throw error; } finally { q.release(); }
});
after(async () => { await app.end(); await owner.end();
  try { if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE; DROP ROLE ${runtime},${migrator}`); }
  finally { await admin.end(); } });
const status = (...codes: number[]) => (error: unknown) => codes.includes((error as { status?: number } | null)?.status ?? 0);
const sqlCode = (...codes: string[]) => (error: unknown) => codes.includes((error as { code?: string }).code ?? '');
const invalid = (error: unknown) => status(401)(error) && (error as { code?: string }).code === 'bootstrap_invalid';
const encode = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
function signed(key: KeyObject, header: unknown, payload: unknown) {
  const data = encode(header) + '.' + encode(payload);
  return data + '.' + sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
}
async function dbNow() { return Number((await owner.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text ms')).rows[0].ms); }
async function waitUntil(ms: number) {
  for (let i = 0; i < 400; i++) { if (await dbNow() >= ms) return; await delay(10); }
  assert.fail('PostgreSQL clock did not reach the expected boundary');
}
async function blocking(holder: PoolClient) {
  const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  for (let i = 0; i < 300; i++) {
    if ((await admin.query('SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid])).rows[0].n) return;
    await delay(10);
  }
  assert.fail('Actual PostgreSQL lock wait was not observed');
}
async function member() {
  const user = randomUUID(), community = randomUUID(), session = randomUUID();
  await owner.query("INSERT INTO communities VALUES($1,'Synthetic bootstrap review')", [community]);
  const row = (await owner.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic member','not-a-login',$4) RETURNING *`, [user, community, user + '@example.invalid', randomUUID()])).rows[0];
  await owner.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')", [session, user]);
  const actor: Actor = { ...row, session_hash: session, csrf_token: 'synthetic' };
  const context = await withMemberScope(app, { actor, scope: 'personal' }, async () => {}, async (_q, c) => c);
  return { actor, context };
}
async function fixture() {
  const f = await member(), device = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicJwk = parseRuntimePublicJwk(device.publicKey.export({ format: 'jwk' }));
  const challenge = await enrollment.begin(f.actor, { key: randomUUID(), publicJwk });
  const registration = await enrollment.confirm(f.actor, { key: randomUUID(), challengeId: challenge.challenge_id,
    proof: signed(device.privateKey, { alg: 'ES256', typ: 'freedom-runtime-enrollment+jws' }, challenge.payload) });
  const connection = await connections.create(f.actor, { key: randomUUID(), runtimeDeviceId: registration.runtimeDeviceId });
  const challengeInput = { key: randomUUID(), connectionId: connection.connectionId };
  const nonce = await api.challenge(f.actor, challengeInput);
  return { ...f, device, publicJwk, registration, connection, nonce, challengeInput };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function request(f: Fixture, options: { access?: Record<string, unknown>; proof?: Record<string, unknown>; clientId?: string;
  issuerKey?: KeyObject; deviceKey?: KeyObject; nonce?: Fixture['nonce']; connection?: Fixture['connection'] } = {}) {
  const now = Math.floor(await dbNow() / 1000), connection = options.connection ?? f.connection, nonce = options.nonce ?? f.nonce;
  const access = { iss: host.issuer, aud: host.audience, sub: f.context.subject_principal.principal_id,
    owner_user_id: f.actor.user_id, scope_id: f.context.scope.scope_id, runtime_device_id: f.registration.runtimeDeviceId,
    connection_id: connection.connectionId, connection_version: connection.aggregateVersion, client_id: options.clientId ?? host.clientId,
    environment: 'local', purpose: 'bootstrap_access', scope: 'bootstrap.status.read', cnf: { jkt: f.registration.keyThumbprint },
    iat: now - 1, exp: now + 120, jti: randomUUID(), ...options.access };
  const accessToken = signed(options.issuerKey ?? issuer.privateKey, { alg: 'ES256', typ: 'freedom-bootstrap+jwt', kid: host.keys[0].kid }, access);
  const proof = signed(options.deviceKey ?? f.device.privateKey, { alg: 'ES256', typ: 'dpop+jwt', jwk: f.publicJwk }, {
    jti: randomUUID(), htm: 'GET', htu: host.bootstrapUri, iat: now,
    ath: createHash('sha256').update(accessToken, 'ascii').digest('base64url'), nonce: nonce.nonce, ...options.proof });
  return { connectionId: connection.connectionId, nonceId: nonce.nonceId, accessToken, proof };
}
async function pending(nonceId: string) {
  assert.deepEqual((await owner.query('SELECT consumed_at,proof_jti,token_jti FROM bootstrap_nonces WHERE nonce_id=$1', [nonceId])).rows,
    [{ consumed_at: null, proof_jti: null, token_jti: null }]);
}
async function counts() {
  return Promise.all(['bootstrap_nonces', 'scoped_command_receipts', 'scoped_transition_journal', 'scoped_outbox']
    .map(async table => (await owner.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n));
}

test('BOOTSTRAP-ADV real LOGIN roles and actual enrolled signatures admit only minimal own status', async () => {
  for (const [pool, name] of [[owner, migrator], [app, runtime]] as const)
    assert.deepEqual((await pool.query(`SELECT current_user,session_user,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolreplication
      FROM pg_roles WHERE rolname=current_user`)).rows[0], {
      current_user: name, session_user: name, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false, rolreplication: false });
  const f = await fixture(), input = await request(f), before = await counts();
  assert.deepEqual(await api.read(input), { connectionId: f.connection.connectionId, runtimeDeviceId: f.registration.runtimeDeviceId,
    clientId: host.clientId, environment: 'local', connectionVersion: '1', expiresAt: f.connection.expiresAt,
    state: 'active', operation: 'bootstrap.status.read', operational_authority: false });
  assert.deepEqual(await counts(), before, 'Machine admission must not invent a member command receipt or business facts');
  const saved = (await owner.query('SELECT * FROM bootstrap_nonces WHERE nonce_id=$1', [f.nonce.nonceId])).rows[0];
  assert.ok(saved.consumed_at); assert.equal(saved.proof_jti, JSON.parse(Buffer.from(input.proof.split('.')[1], 'base64url').toString()).jti);
  for (const table of ['bootstrap_nonces', 'scoped_command_receipts', 'scoped_transition_journal', 'scoped_outbox']) {
    const bytes = JSON.stringify((await owner.query(`SELECT * FROM ${table}`)).rows);
    for (const secret of [input.accessToken, input.proof, f.device.privateKey.export({ format: 'jwk' }).d!, issuer.privateKey.export({ format: 'jwk' }).d!])
      assert.ok(!bytes.includes(secret), `${table} retained credential material`);
  }
});

test('BOOTSTRAP-ADV machine admission is independent of the old human session cookie', async () => {
  const f = await fixture(), input = await request(f);
  await owner.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1', [f.actor.session_hash]);
  await assert.rejects(api.challenge(f.actor, f.challengeInput), status(401));
  assert.equal((await api.read(input)).operation, 'bootstrap.status.read');
});

test('BOOTSTRAP-ADV concurrent exact proof retries commit exactly one nonce admission', async () => {
  const f = await fixture(), input = await request(f);
  const results = await Promise.allSettled([api.read(input), api.read(input)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(results.some(r => r.status === 'rejected' && invalid(r.reason)));
  await assert.rejects(api.read(input), invalid);
  await assert.rejects(api.read(await request(f)), invalid);
  await assert.rejects(api.challenge(f.actor, f.challengeInput), status(409));
});

test('BOOTSTRAP-ADV high-S and low-S signatures have one admission despite distinct proof bytes', async () => {
  const f = await fixture(), input = await request(f), parts = input.proof.split('.');
  const signature = Buffer.from(parts[2], 'base64url');
  const order = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
  const complement = order - BigInt('0x' + signature.subarray(32).toString('hex'));
  const other = Buffer.concat([signature.subarray(0, 32), Buffer.from(complement.toString(16).padStart(64, '0'), 'hex')]);
  assert.ok(verify('sha256', Buffer.from(parts.slice(0, 2).join('.')), { key: f.device.publicKey, dsaEncoding: 'ieee-p1363' }, other));
  const alternate = parts.slice(0, 2).join('.') + '.' + other.toString('base64url'); assert.notEqual(alternate, input.proof);
  const outcomes = await Promise.allSettled([api.read(input), api.read({ ...input, proof: alternate })]);
  assert.equal(outcomes.filter(v => v.status === 'fulfilled').length, 1);
  assert.ok(outcomes.some(v => v.status === 'rejected' && invalid(v.reason)));
});

test('BOOTSTRAP-ADV repeated proof ID cannot move to a new nonce or another client connection', async () => {
  const f = await fixture(), jti = randomUUID(); await api.read(await request(f, { proof: { jti } }));
  const nonce = await api.challenge(f.actor, { ...f.challengeInput, key: randomUUID() });
  await assert.rejects(api.read(await request(f, { nonce, proof: { jti } })), invalid); await pending(nonce.nonceId);
  const otherHost = { ...host, clientId: 'another-reviewed-client' }, otherApi = createBootstrapStatus(app, otherHost);
  const connection = await createAgentConnections(app, { environment: 'local', clientId: otherHost.clientId })
    .create(f.actor, { key: randomUUID(), runtimeDeviceId: f.registration.runtimeDeviceId });
  const otherNonce = await otherApi.challenge(f.actor, { key: randomUUID(), connectionId: connection.connectionId });
  await assert.rejects(otherApi.read(await request(f, { connection, nonce: otherNonce, clientId: otherHost.clientId, proof: { jti } })), invalid);
  await pending(otherNonce.nonceId);
  assert.equal((await otherApi.read(await request(f, { connection, nonce: otherNonce, clientId: otherHost.clientId }))).operational_authority, false);
});

test('BOOTSTRAP-ADV signed binding/purpose/environment errors and wrong signatures never burn a nonce', async () => {
  const f = await fixture(), stranger = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  for (const access of [{ owner_user_id: randomUUID() }, { sub: randomUUID() }, { scope_id: randomUUID() },
    { runtime_device_id: randomUUID() }, { connection_id: randomUUID() }, { connection_version: '2' },
    { client_id: 'other' }, { environment: 'next' }, { purpose: 'execution' }, { scope: 'work.read' }]) {
    await assert.rejects(api.read(await request(f, { access })), invalid); await pending(f.nonce.nonceId);
  }
  for (const proof of [{ nonce: Buffer.alloc(32, 9).toString('base64url') }, { htm: 'POST' }, { htu: host.bootstrapUri + '?' },
    { ath: Buffer.alloc(32, 8).toString('base64url') }]) {
    await assert.rejects(api.read(await request(f, { proof })), invalid); await pending(f.nonce.nonceId);
  }
  for (const options of [{ issuerKey: stranger.privateKey }, { deviceKey: stranger.privateKey }])
    await assert.rejects(api.read(await request(f, options)), invalid);
  await pending(f.nonce.nonceId); assert.equal((await api.read(await request(f))).operational_authority, false);
});

test('BOOTSTRAP-ADV wrong connection/nonce IDs and overrides have uniform errors without accessor execution', async () => {
  const f = await fixture(), peer = await fixture(), input = await request(f);
  for (const change of [{ connectionId: randomUUID() }, { nonceId: randomUUID() }, { connectionId: peer.connection.connectionId },
    { nonceId: peer.nonce.nonceId }, { nowMs: 0 }, { actor: f.actor }, { expectedBinding: {} }, { operational_authority: true }])
    await assert.rejects(api.read({ ...input, ...change }), invalid);
  let invoked = 0;
  for (const accessor of ['accessToken', 'proof', 'connectionId']) {
    const malformed = { ...input }; Object.defineProperty(malformed, accessor, { enumerable: true, get() { invoked++; throw Error('PRIVATE_MARKER'); } });
    await assert.rejects(api.read(malformed), invalid);
  }
  assert.equal(invoked, 0); await pending(f.nonce.nonceId); await pending(peer.nonce.nonceId);
});

for (const state of ['user', 'principal', 'scope', 'onboarding', 'runtime', 'connection'] as const) {
  test(`BOOTSTRAP-ADV committed ${state} revocation wins a real row-lock race`, async () => {
    const f = await fixture(), input = await request(f), holder = await owner.connect(); await holder.query('BEGIN');
    if (state === 'user') await holder.query('UPDATE users SET active=false WHERE user_id=$1', [f.actor.user_id]);
    if (state === 'principal') await holder.query("UPDATE principals SET status='disabled' WHERE principal_id=$1", [f.context.subject_principal.principal_id]);
    if (state === 'scope') await holder.query("UPDATE resource_scopes SET status='disabled' WHERE scope_id=$1", [f.context.scope.scope_id]);
    if (state === 'onboarding') await holder.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1', [f.actor.user_id]);
    if (state === 'runtime') await holder.query("UPDATE runtime_registrations SET state='revoked',aggregate_version=aggregate_version+1,revoked_at=clock_timestamp() WHERE runtime_device_id=$1", [f.registration.runtimeDeviceId]);
    if (state === 'connection') await holder.query("UPDATE agent_connections SET state='revoked',aggregate_version=aggregate_version+1,revoked_at=clock_timestamp() WHERE connection_id=$1", [f.connection.connectionId]);
    const outcome = api.read(input).then(value => ({ value, error: null }), error => ({ value: null, error }));
    try { await blocking(holder); } finally { await holder.query('COMMIT'); holder.release(); }
    assert.ok(invalid((await outcome).error)); await pending(f.nonce.nonceId);
  });
}

for (const sink of ['scoped_command_receipts', 'scoped_transition_journal', 'scoped_outbox']) {
  test(`BOOTSTRAP-ADV challenge ${sink} failure rolls back nonce and all member facts`, async () => {
    const f = await fixture(), input = { ...f.challengeInput, key: randomUUID() }, initial = await counts();
    await owner.query("CREATE FUNCTION bootstrap_sink_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE_FAULT'; END $$");
    await owner.query(`CREATE TRIGGER bootstrap_sink_fault BEFORE INSERT ON ${sink} FOR EACH ROW EXECUTE FUNCTION bootstrap_sink_fault()`);
    try { await assert.rejects(api.challenge(f.actor, input)); }
    finally { await owner.query(`DROP TRIGGER bootstrap_sink_fault ON ${sink}`); await owner.query('DROP FUNCTION bootstrap_sink_fault()'); }
    assert.deepEqual(await counts(), initial); assert.equal((await api.challenge(f.actor, input)).operational_authority, false);
  });
}

test('BOOTSTRAP-ADV nonce UPDATE fault is opaque, atomic and does not poison a valid retry', async () => {
  const f = await fixture(), input = await request(f), initial = await counts();
  await owner.query("CREATE FUNCTION bootstrap_update_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE_SQL_MARKER'; END $$");
  await owner.query('CREATE TRIGGER bootstrap_update_fault AFTER UPDATE ON bootstrap_nonces FOR EACH ROW EXECUTE FUNCTION bootstrap_update_fault()');
  try { await assert.rejects(api.read(input), error => status(503)(error) && !JSON.stringify(error).includes('PRIVATE_SQL_MARKER')); }
  finally { await owner.query('DROP TRIGGER bootstrap_update_fault ON bootstrap_nonces'); await owner.query('DROP FUNCTION bootstrap_update_fault()'); }
  assert.deepEqual(await counts(), initial); await pending(f.nonce.nonceId);
  assert.equal((await api.read(input)).operational_authority, false);
});

test('BOOTSTRAP-ADV actual app cannot weaken triggers, truncate nonce history, change schema or ledger', async () => {
  for (const sql of ['TRUNCATE bootstrap_nonces', 'ALTER TABLE bootstrap_nonces DISABLE TRIGGER ALL',
    'CREATE TABLE forbidden_bootstrap_table(id int)', 'UPDATE schema_migrations SET name=name'])
    await assert.rejects(app.query(sql), sqlCode('42501'));
  const f = await fixture();
  for (const assignment of ['nonce_id=gen_random_uuid()', 'connection_id=gen_random_uuid()', 'runtime_device_id=gen_random_uuid()',
    'owner_user_id=gen_random_uuid()', 'owner_principal_id=gen_random_uuid()', 'scope_id=gen_random_uuid()',
    "environment='next'", "client_id='other'", 'connection_version=2', "nonce=repeat('A',43)",
    "issued_at=issued_at-interval '1 second'", "expires_at=expires_at+interval '1 second'"])
    await assert.rejects(app.query(`UPDATE bootstrap_nonces SET ${assignment} WHERE nonce_id=$1`, [f.nonce.nonceId]), sqlCode('23514'));
  await assert.rejects(app.query('DELETE FROM bootstrap_nonces WHERE nonce_id=$1', [f.nonce.nonceId]), sqlCode('23514'));
  await api.read(await request(f));
  await assert.rejects(app.query('UPDATE bootstrap_nonces SET consumed_at=NULL,proof_jti=NULL,token_jti=NULL WHERE nonce_id=$1', [f.nonce.nonceId]), sqlCode('23514'));
});

async function insertNonce(q: Pool | PoolClient, f: Fixture, changes: Record<string, unknown> = {}, short = false) {
  const names = ['nonce_id', 'connection_id', 'runtime_device_id', 'owner_user_id', 'owner_principal_id', 'scope_id',
    'environment', 'client_id', 'connection_version', 'challenge_key', 'nonce'];
  const args: unknown[] = [f.nonce.nonceId, randomUUID(), randomUUID(), randomBytes(32).toString('base64url')];
  const defaults = ['$2', 'connection_id', 'runtime_device_id', 'owner_user_id', 'owner_principal_id', 'scope_id',
    'environment', 'client_id', 'connection_version', '$3', '$4'];
  const values = names.map((name, index) => Object.hasOwn(changes, name) ? `$${args.push(changes[name])}` : defaults[index]);
  return q.query(`WITH stamp AS MATERIALIZED (SELECT date_trunc('milliseconds',clock_timestamp()) now)
    INSERT INTO ${schema}.bootstrap_nonces(${names.join(',')},issued_at,expires_at)
    SELECT ${values.join(',')},stamp.now,stamp.now+interval '${short ? 1 : 60} seconds'
    FROM ${schema}.bootstrap_nonces CROSS JOIN stamp WHERE nonce_id=$1 RETURNING *`, args);
}
async function shortNonce(f: Fixture) {
  const row = (await insertNonce(app, f, {}, true)).rows[0];
  return { nonceId: row.nonce_id as string, nonce: row.nonce as string, connectionId: row.connection_id as string,
    issuedAt: row.issued_at.toISOString() as string, expiresAt: row.expires_at.toISOString() as string, operational_authority: false as const };
}

test('BOOTSTRAP-ADV SQL requires physical owner/connection/runtime/version binding including nonnull fields', async () => {
  const f = await fixture(), peer = await fixture();
  for (const change of [{ owner_user_id: peer.actor.user_id }, { owner_principal_id: peer.context.subject_principal.principal_id },
    { scope_id: peer.context.scope.scope_id }, { runtime_device_id: peer.registration.runtimeDeviceId },
    { connection_id: peer.connection.connectionId }, { environment: 'next' }, { client_id: 'other' },
    { connection_version: '2' }, { connection_id: null }, { owner_principal_id: null }])
    await assert.rejects(insertNonce(app, f, change), sqlCode('23514', '23503', '23502'));
  await pending(f.nonce.nonceId);
});

test('BOOTSTRAP-ADV TEMP backing shadows cannot re-enable a physically revoked connection', async () => {
  const f = await fixture();
  await connections.revoke(f.actor, { key: randomUUID(), connectionId: f.connection.connectionId, expectedVersion: '1' });
  const q = await app.connect(); await q.query('BEGIN');
  try {
    await q.query(`CREATE TEMP TABLE agent_connections AS SELECT * FROM ${schema}.agent_connections WHERE connection_id=$1`, [f.connection.connectionId]);
    await q.query("UPDATE pg_temp.agent_connections SET state='active',revoked_at=NULL,aggregate_version=1");
    await assert.rejects(insertNonce(q, f), sqlCode('23514'));
  } finally { await q.query('ROLLBACK'); q.release(); }
});

test('BOOTSTRAP-ADV nonce expiry across a proven row-lock wait rejects without consumption', async () => {
  const f = await fixture(), nonce = await shortNonce(f), input = await request(f, { nonce }), holder = await owner.connect();
  await holder.query('BEGIN'); await holder.query('SELECT nonce_id FROM bootstrap_nonces WHERE nonce_id=$1 FOR UPDATE', [nonce.nonceId]);
  const outcome = api.read(input).then(value => ({ value, error: null }), error => ({ value: null, error }));
  try { await blocking(holder); await waitUntil(Date.parse(nonce.expiresAt)); }
  finally { await holder.query('ROLLBACK'); holder.release(); }
  assert.ok(invalid((await outcome).error)); await pending(nonce.nonceId);
});

for (const boundary of ['nonce', 'token', 'proof'] as const) {
  test(`BOOTSTRAP-ADV actual signature verification crossing ${boundary} expiry cannot consume nonce`, async () => {
    const f = await fixture(), nonce = boundary === 'nonce' ? await shortNonce(f) : f.nonce;
    const now = Math.floor(await dbNow() / 1000), expires = boundary === 'nonce' ? Date.parse(nonce.expiresAt) : (now + 2) * 1000;
    const input = await request(f, { nonce,
      ...(boundary === 'token' ? { access: { exp: now + 2 } } : {}),
      ...(boundary === 'proof' ? { proof: { iat: now - 59 } } : {}) });
    const original = crypto.subtle.verify, descriptor = Object.getOwnPropertyDescriptor(crypto.subtle, 'verify');
    let release!: () => void, entered!: () => void, calls = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const observed = new Promise<void>(resolve => { entered = resolve; });
    // Delay the actual native signature operation, never replace its result.
    Object.defineProperty(crypto.subtle, 'verify', { configurable: true, value: async (...args: Parameters<SubtleCrypto['verify']>) => {
      if (calls++ === 0) { entered(); await gate; }
      return Reflect.apply(original, crypto.subtle, args);
    } });
    const outcome = api.read(input).then(value => ({ value, error: null }), error => ({ value: null, error }));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([observed, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(Error('Native verifier was not reached')), 3000); })]);
      clearTimeout(timeout); await waitUntil(expires);
    } finally {
      clearTimeout(timeout); release();
      if (descriptor) Object.defineProperty(crypto.subtle, 'verify', descriptor); else Reflect.deleteProperty(crypto.subtle, 'verify');
    }
    assert.ok(invalid((await outcome).error)); assert.ok(calls >= 1); await pending(nonce.nonceId);
  });
}

test('BOOTSTRAP-ADV final nonce UPDATE barrier crossing token expiry rolls back the apparent consumption', async () => {
  const f = await fixture(), now = Math.floor(await dbNow() / 1000), expiry = (now + 2) * 1000;
  const input = await request(f, { access: { exp: now + 2 } }), holder = await owner.connect(), barrier = 810000000 + process.pid;
  await owner.query(`CREATE FUNCTION bootstrap_update_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_advisory_xact_lock(${barrier}::bigint); RETURN NEW; END $$`);
  // This sorts after the normal SQL clock guard: service must also recheck crypto
  // freshness after UPDATE returns, even when nonce itself has not expired.
  await owner.query('CREATE TRIGGER zzz_bootstrap_update_barrier AFTER UPDATE ON bootstrap_nonces FOR EACH ROW EXECUTE FUNCTION bootstrap_update_barrier()');
  await holder.query('BEGIN'); await holder.query('SELECT pg_advisory_xact_lock($1::bigint)', [barrier]);
  const outcome = api.read(input).then(value => ({ value, error: null }), error => ({ value: null, error }));
  try { await blocking(holder); await waitUntil(expiry); }
  finally { await holder.query('ROLLBACK'); holder.release(); }
  let result;
  try { result = await outcome; }
  finally { await owner.query('DROP TRIGGER zzz_bootstrap_update_barrier ON bootstrap_nonces'); await owner.query('DROP FUNCTION bootstrap_update_barrier()'); }
  assert.ok(invalid(result.error)); await pending(f.nonce.nonceId);
});

test('BOOTSTRAP-ADV challenge receipt cannot bypass a committed runtime revocation', async () => {
  const f = await fixture(); assert.deepEqual(await api.challenge(f.actor, f.challengeInput), f.nonce);
  await enrollment.revoke(f.actor, { key: randomUUID(), runtimeDeviceId: f.registration.runtimeDeviceId, expectedVersion: '1' });
  await assert.rejects(api.challenge(f.actor, f.challengeInput), status(409));
  await assert.rejects(api.challenge(f.actor, { ...f.challengeInput, key: randomUUID() }), status(409));
  await pending(f.nonce.nonceId);
});
