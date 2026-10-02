import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash, generateKeyPairSync, randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import { migrate } from '../../scripts/database.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import type { Actor } from '../../modules/identity-membership/service.js';
import { parseRuntimePublicJwk, createRuntimeRegistrationChallenge } from '../../modules/agent-control/runtime-proof.js';
import { createDeviceAuthorizations } from '../../modules/agent-control/device-authorizations.js';
import { createBootstrapStatus } from '../../modules/agent-control/bootstrap-status.js';
import { createRuntimeRegistrations } from '../../modules/agent-control/runtime-registration.js';
import type { BootstrapProofHost } from '../../contracts/execution/v1/bootstrap.js';
import type { DeviceAuthorizationHost } from '../../contracts/execution/v1/device-pairing.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname))
  throw new Error('Explicit isolated fp_* TEST_DATABASE_URL required.');
const schema = `fp_device_adv_${process.pid}_${Date.now()}`, migrator = `${schema}_owner`, runtime = `${schema}_app`;
const admin = new Pool({ connectionString });
function roleUrl(role: string) { const url = new URL(connectionString!); url.username = role; url.password = ''; return url.toString(); }
const owner = new Pool({ connectionString: roleUrl(migrator), options: `-c search_path=${schema} -c statement_timeout=10000` });
const app = new Pool({ connectionString: roleUrl(runtime), options: `-c search_path=${schema} -c statement_timeout=10000`, max: 12 });
let created = false;
let api: Awaited<ReturnType<typeof createDeviceAuthorizations>>;
const issuer = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const bootstrap: BootstrapProofHost = { environment: 'local', clientId: 'synthetic-device-review',
  issuer: 'https://issuer.example.invalid/', audience: 'https://platform.example.invalid/',
  bootstrapUri: 'https://platform.example.invalid/execution-api/v1/bootstrap',
  keys: [{ kid: 'synthetic-issuer', purpose: 'bootstrap_access', environment: 'local',
    publicJwk: parseRuntimePublicJwk(issuer.publicKey.export({ format: 'jwk' })), notBeforeMs: 0,
    notAfterMs: Number.MAX_SAFE_INTEGER, revoked: false }] };
const beginUri = 'https://platform.example.invalid/execution-api/v1/auth/device-authorizations';
const pollUri = 'https://platform.example.invalid/execution-api/v1/auth/token';
const host: DeviceAuthorizationHost = { ...bootstrap, issuerKid: bootstrap.keys[0].kid, beginUri, pollUri,
  verificationUri: 'https://platform.example.invalid/device', clientDisplayName: 'Synthetic reviewed client' };

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
  const signingKey = await crypto.subtle.importKey('jwk', issuer.privateKey.export({ format: 'jwk' }),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  assert.equal(signingKey.extractable, false);
  api = await createDeviceAuthorizations(app, { host, signingKey });
});
after(async () => { await app.end(); await owner.end();
  try { if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE; DROP ROLE ${runtime},${migrator}`); }
  finally { await admin.end(); } });
const status = (...codes: number[]) => (error: unknown) => codes.includes((error as { status?: number } | null)?.status ?? 0);
const sqlCode = (...codes: string[]) => (error: unknown) => codes.includes((error as { code?: string }).code ?? '');
const encode = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
function signed(key: KeyObject, header: unknown, payload: unknown) {
  const data = encode(header) + '.' + encode(payload);
  return data + '.' + sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
}
function alternateSignature(compact: string, publicKey: KeyObject) {
  const parts = compact.split('.'), signature = Buffer.from(parts[2], 'base64url');
  const order = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
  const complement = order - BigInt('0x' + signature.subarray(32).toString('hex'));
  const other = Buffer.concat([signature.subarray(0, 32), Buffer.from(complement.toString(16).padStart(64, '0'), 'hex')]);
  assert.ok(verify('sha256', Buffer.from(parts.slice(0, 2).join('.')), { key: publicKey, dsaEncoding: 'ieee-p1363' }, other));
  return parts.slice(0, 2).join('.') + '.' + other.toString('base64url');
}
async function dbNow() { return Number((await owner.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text ms')).rows[0].ms); }
async function waitUntil(ms: number) {
  for (let i = 0; i < 1600; i++) { if (await dbNow() >= ms) return; await delay(10); }
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
  await owner.query("INSERT INTO communities VALUES($1,'Synthetic device review')", [community]);
  const row = (await owner.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic member','not-a-login',$4) RETURNING *`, [user, community, user + '@example.invalid', randomUUID()])).rows[0];
  await owner.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')", [session, user]);
  const actor: Actor = { ...row, session_hash: session, csrf_token: 'synthetic' };
  const context = await withMemberScope(app, { actor, scope: 'personal' }, async () => {}, async (_q, c) => c);
  return { actor, context };
}
function device() {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { ...keys, publicJwk: parseRuntimePublicJwk(keys.publicKey.export({ format: 'jwk' })) };
}
async function beginInput(key = device(), claims: Record<string, unknown> = {}) {
  return { key, input: { publicJwk: key.publicJwk, runtimeKind: 'agent-kit' as const,
    proof: signed(key.privateKey, { alg: 'ES256', typ: 'freedom-device-pairing+jwt', jwk: key.publicJwk }, {
      purpose: 'device_pairing_begin', client_id: bootstrap.clientId, environment: 'local', runtime_kind: 'agent-kit',
      scope: 'bootstrap.status.read', jti: randomUUID(), iat: Math.floor(await dbNow() / 1000), htm: 'POST', htu: beginUri, ...claims }) } };
}
async function begun() {
  const begin = await beginInput(); return { ...begin, authorization: await api.begin(begin.input) };
}
type Begun = Awaited<ReturnType<typeof begun>>;
async function historical(millisecondsRemaining: number): Promise<Begun> {
  const f = await begun(), stored = (await owner.query('SELECT * FROM device_authorizations WHERE authorization_id=$1', [f.authorization.authorizationId])).rows[0];
  const expiresAt = new Date(await dbNow() + millisecondsRemaining), issuedAt = new Date(expiresAt.getTime() - 300_000);
  const authorizationId = randomUUID(), deviceCode = createHash('sha256').update(randomUUID()).digest('base64url');
  const digits = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase(), userCode = digits.slice(0, 5) + '-' + digits.slice(5);
  const hash = (purpose: string, value: string) => createHash('sha256')
    .update(JSON.stringify(['freedom.device-authorization/v1', purpose, value])).digest('hex');
  const requestDigest = createHash('sha256').update(JSON.stringify({ profile: 'freedom.device-authorization/v1', authorizationId,
    environment: 'local', clientId: bootstrap.clientId, clientDisplayName: host.clientDisplayName, runtimeKind: 'agent-kit', keyThumbprint: stored.key_thumbprint,
    nonce: f.authorization.nonce, scope: 'bootstrap.status.read', issuedAt: issuedAt.toISOString(), expiresAt: expiresAt.toISOString() })).digest('base64url');
  await owner.query(`INSERT INTO device_authorizations
    (authorization_id,environment,client_id,runtime_kind,public_jwk,key_thumbprint,begin_jti,device_code_hash,device_code_wire_hash,user_code_hash,nonce,request_digest,issued_at,expires_at,client_display_name)
    VALUES($1,'local',$2,'agent-kit',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [authorizationId, bootstrap.clientId, f.key.publicJwk,
    stored.key_thumbprint, randomUUID(), hash('device-code', deviceCode), createHash('sha256').update(deviceCode, 'ascii').digest('base64url'),
    hash('user-code', userCode), f.authorization.nonce, requestDigest, issuedAt, expiresAt, host.clientDisplayName]);
  return { ...f, authorization: { ...f.authorization, authorizationId, deviceCode, userCode, requestDigest,
    issuedAt: issuedAt.toISOString(), expiresAt: expiresAt.toISOString() } };
}
async function pollInput(f: Begun, claims: Record<string, unknown> = {}, signingDevice = f.key) {
  return { authorizationId: f.authorization.authorizationId, deviceCode: f.authorization.deviceCode,
    proof: signed(signingDevice.privateKey, { alg: 'ES256', typ: 'freedom-device-pairing+jwt', jwk: signingDevice.publicJwk }, {
      purpose: 'device_pairing_poll', client_id: bootstrap.clientId, environment: 'local', runtime_kind: 'agent-kit',
      scope: 'bootstrap.status.read', jti: randomUUID(), iat: Math.floor(await dbNow() / 1000), htm: 'POST', htu: pollUri,
      authorization_id: f.authorization.authorizationId, nonce: f.authorization.nonce,
      request_digest: f.authorization.requestDigest,
      device_code_hash: createHash('sha256').update(f.authorization.deviceCode, 'ascii').digest('base64url'), ...claims }) };
}
function decision(f: Begun, choice: 'approve' | 'deny' = 'approve') {
  return { key: randomUUID(), userCode: f.authorization.userCode, authorizationId: f.authorization.authorizationId,
    requestDigest: f.authorization.requestDigest, decision: choice };
}
async function approved(seed?: Begun) {
  const f = seed ?? await begun();
  const human = await member(), input = decision(f);
  await api.decide(human.actor, input);
  // Test fixture reads the exact challenge created by real member approval to
  // avoid sleeping five seconds in every exchange test. The full public
  // proof_required -> signed challenge -> issued path has its own test below.
  const row = (await owner.query('SELECT * FROM runtime_registration_challenges WHERE owner_user_id=$1', [human.actor.user_id])).rows[0];
  assert.ok(row);
  const challenge = createRuntimeRegistrationChallenge({ challenge_id: row.challenge_id, owner_member_id: row.owner_user_id,
    owner_principal_id: row.owner_principal_id, scope_id: row.scope_id, runtime_device_id: row.runtime_device_id,
    environment: row.environment, key_thumbprint: row.key_thumbprint, nonce: row.nonce,
    issued_at: row.issued_at.toISOString(), expires_at: row.expires_at.toISOString() });
  const enrollmentProof = signed(f.key.privateKey, { alg: 'ES256', typ: 'freedom-runtime-enrollment+jws' }, challenge.payload);
  return { ...f, ...human, challenge, enrollmentProof, decisionInput: input };
}
async function durableCounts() {
  return Promise.all(['runtime_registration_challenges', 'runtime_registrations', 'agent_connections', 'bootstrap_nonces',
    'scoped_command_receipts', 'scoped_transition_journal', 'scoped_outbox']
    .map(async table => (await owner.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n));
}
async function assertUnconsumed(f: Awaited<ReturnType<typeof approved>>) {
  assert.equal((await owner.query('SELECT state FROM device_authorizations WHERE authorization_id=$1', [f.authorization.authorizationId])).rows[0].state, 'approved');
  const row = (await owner.query('SELECT consumed_at FROM runtime_registration_challenges WHERE challenge_id=$1', [f.challenge.challenge_id])).rows[0];
  assert.equal(row.consumed_at, null);
  for (const table of ['runtime_registrations', 'agent_connections', 'bootstrap_nonces'])
    assert.equal((await owner.query(`SELECT count(*)::int n FROM ${table} WHERE owner_user_id=$1`, [f.actor.user_id])).rows[0].n, 0);
}

test('DEVICE-ADV actual non-superuser LOGIN roles and full public proof_required exchange yield bootstrap-only status', async () => {
  for (const [pool, name] of [[owner, migrator], [app, runtime]] as const)
    assert.deepEqual((await pool.query(`SELECT current_user,session_user,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolreplication
      FROM pg_roles WHERE rolname=current_user`)).rows[0], {
      current_user: name, session_user: name, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false, rolreplication: false });
  const f = await begun(), human = await member();
  const review = await api.inspect(human.actor, { userCode: f.authorization.userCode });
  assert.equal(review.requestDigest, f.authorization.requestDigest); assert.equal(review.scope, 'bootstrap.status.read');
  assert.equal(review.clientDisplayName, host.clientDisplayName); assert.equal(review.environment, 'local');
  assert.equal(Date.parse(f.authorization.expiresAt) - Date.parse(f.authorization.issuedAt), 300_000);
  await api.decide(human.actor, decision(f));
  const reply = await api.poll(await pollInput(f)); assert.equal(reply.status, 'proof_required');
  if (reply.status !== 'proof_required') return assert.fail('Real enrollment challenge required');
  const proof = signed(f.key.privateKey, { alg: 'ES256', typ: 'freedom-runtime-enrollment+jws' }, reply.challenge.payload);
  await waitUntil(await dbNow() + reply.interval * 1000);
  const outcome = await api.poll({ ...await pollInput(f), enrollmentProof: proof }); assert.equal(outcome.status, 'issued');
  if (outcome.status !== 'issued') return assert.fail('Expected bootstrap issuance');
  assert.equal(outcome.refreshSupported, true); assert.equal(outcome.tokenType, 'DPoP');
  const jwt = JSON.parse(Buffer.from(outcome.accessToken.split('.')[1], 'base64url').toString());
  assert.equal(jwt.purpose, 'bootstrap_access'); assert.equal(jwt.scope, 'bootstrap.status.read');
  assert.equal(jwt.owner_user_id, human.actor.user_id); assert.ok(jwt.exp - jwt.iat <= 600);
  const resourceProof = signed(f.key.privateKey, { alg: 'ES256', typ: 'dpop+jwt', jwk: f.key.publicJwk }, {
    jti: randomUUID(), htm: 'GET', htu: bootstrap.bootstrapUri, iat: Math.floor(await dbNow() / 1000),
    ath: createHash('sha256').update(outcome.accessToken, 'ascii').digest('base64url'), nonce: outcome.nonce.nonce });
  assert.equal((await createBootstrapStatus(app, bootstrap).read({ connectionId: outcome.connectionId,
    nonceId: outcome.nonce.nonceId, accessToken: outcome.accessToken, proof: resourceProof })).operation, 'bootstrap.status.read');
  await assert.rejects(api.poll({ ...await pollInput(f), enrollmentProof: proof }), status(401, 409));
  const tables = (await owner.query("SELECT tablename FROM pg_tables WHERE schemaname=$1", [schema])).rows;
  for (const { tablename } of tables) {
    const bytes = JSON.stringify((await owner.query(`SELECT * FROM "${tablename}"`)).rows);
    for (const secret of [f.authorization.deviceCode, f.authorization.userCode, f.input.proof, proof, outcome.accessToken,
      f.key.privateKey.export({ format: 'jwk' }).d!, issuer.privateKey.export({ format: 'jwk' }).d!])
      assert.ok(!bytes.includes(secret), `${tablename} retained raw pairing credential material`);
  }
});

test('DEVICE-ADV begin key substitution and equivalent-signature replay cannot reserve or redeliver secrets', async () => {
  const input = await beginInput(), wrong = device();
  await assert.rejects(api.begin({ ...input.input, publicJwk: wrong.publicJwk }), status(400, 401));
  const first = await api.begin(input.input); assert.ok(first.deviceCode);
  await assert.rejects(api.begin(input.input), status(401, 409));
  await assert.rejects(api.begin({ ...input.input, proof: alternateSignature(input.input.proof, input.key.publicKey) }), status(401, 409));
  assert.ok((await api.begin((await beginInput(wrong)).input)).authorizationId, 'A failed stolen-key request must not reserve that key');
});

test('DEVICE-ADV exact inspected code/id/digest cannot be spliced between requests', async () => {
  const f = await begun(), peer = await begun(), human = await member(), initial = await durableCounts();
  for (const change of [{ authorizationId: peer.authorization.authorizationId }, { requestDigest: peer.authorization.requestDigest },
    { userCode: peer.authorization.userCode }])
    await assert.rejects(api.decide(human.actor, { ...decision(f), ...change }), status(400, 401, 404, 409));
  assert.deepEqual(await durableCounts(), initial);
  assert.equal((await api.decide(human.actor, decision(f))).state, 'approved');
});

test('DEVICE-ADV two current owners racing approval cannot rebind one request', async () => {
  const f = await begun(), humans = await Promise.all([member(), member()]);
  const results = await Promise.allSettled(humans.map(human => api.decide(human.actor, decision(f))));
  assert.equal(results.filter(v => v.status === 'fulfilled').length, 1);
  const winner = results.findIndex(v => v.status === 'fulfilled'), loser = 1 - winner;
  await assert.rejects(api.decide(humans[loser].actor, decision(f)), status(401, 403, 404, 409));
  const challenges = (await owner.query('SELECT owner_user_id FROM runtime_registration_challenges WHERE owner_user_id=ANY($1::uuid[])',
    [humans.map(h => h.actor.user_id)])).rows;
  assert.deepEqual(challenges, [{ owner_user_id: humans[winner].actor.user_id }]);
});

test('DEVICE-ADV nonexistent user codes consume a durable shared inspect/decide budget', async () => {
  const f = await begun(), human = await member();
  for (let i = 0; i < 10; i++) {
    const userCode = `00000-${String(i).padStart(5, '0')}`;
    if (i % 2) await assert.rejects(api.decide(human.actor, { ...decision(f), userCode }), status(400, 401, 404));
    else await assert.rejects(api.inspect(human.actor, { userCode }), status(400, 401, 404));
  }
  await assert.rejects(api.inspect(human.actor, { userCode: f.authorization.userCode }), status(429));
  await assert.rejects(api.decide(human.actor, decision(f)), status(429));
});

test('DEVICE-ADV persistent slow_down and JTI replay survive separate service calls', async () => {
  const f = await begun(); assert.equal((await api.poll(await pollInput(f))).status, 'authorization_pending');
  const second = await pollInput(f), slow = await api.poll(second);
  assert.deepEqual(slow, { status: 'slow_down', interval: 10, operational_authority: false });
  await assert.rejects(api.poll(second), status(401, 409));
  await assert.rejects(api.poll({ ...second, proof: alternateSignature(second.proof, f.key.publicKey) }), status(401, 409));
  assert.deepEqual(await api.poll(await pollInput(f)), { status: 'slow_down', interval: 15, operational_authority: false });
});

test('DEVICE-ADV code/key/request/purpose substitution cannot mutate legitimate polling state', async () => {
  const f = await begun(), peer = await begun();
  const changes = [{ authorization_id: peer.authorization.authorizationId }, { nonce: peer.authorization.nonce },
    { request_digest: peer.authorization.requestDigest }, { device_code_hash: peer.authorization.requestDigest },
    { environment: 'next' }, { client_id: 'other' }, { scope: 'work.read' }, { purpose: 'device_pairing_begin' },
    { htm: 'GET' }, { htu: bootstrap.bootstrapUri }];
  for (const change of changes) await assert.rejects(api.poll(await pollInput(f, change)), status(400, 401));
  await assert.rejects(api.poll(await pollInput(f, {}, peer.key)), status(401));
  await assert.rejects(api.poll({ ...await pollInput(f), deviceCode: peer.authorization.deviceCode }), status(401));
  assert.deepEqual(await api.poll(await pollInput(f)), { status: 'authorization_pending', interval: 5, operational_authority: false });
});

test('DEVICE-ADV approval cannot replace genuine enrollment proof and invalid signatures roll back', async () => {
  const f = await approved(), peer = device(), initial = await durableCounts();
  const forged = signed(peer.privateKey, { alg: 'ES256', typ: 'freedom-runtime-enrollment+jws' }, f.challenge.payload);
  await assert.rejects(api.poll({ ...await pollInput(f), enrollmentProof: forged }), status(400, 401));
  await assertUnconsumed(f); assert.deepEqual(await durableCounts(), initial);
  assert.equal((await api.poll({ ...await pollInput(f), enrollmentProof: f.enrollmentProof })).status, 'issued');
});

test('DEVICE-ADV concurrent equivalent signatures exchange exactly once', async () => {
  const f = await approved(), input = { ...await pollInput(f), enrollmentProof: f.enrollmentProof };
  const results = await Promise.allSettled([api.poll(input), api.poll({ ...input,
    proof: alternateSignature(input.proof, f.key.publicKey), enrollmentProof: alternateSignature(f.enrollmentProof, f.key.publicKey) })]);
  assert.equal(results.filter(v => v.status === 'fulfilled' && v.value.status === 'issued').length, 1);
  assert.equal(results.filter(v => v.status === 'rejected').length, 1);
  for (const table of ['runtime_registrations', 'agent_connections', 'bootstrap_nonces'])
    assert.equal((await owner.query(`SELECT count(*)::int n FROM ${table} WHERE owner_user_id=$1`, [f.actor.user_id])).rows[0].n, 1);
});

test('DEVICE-ADV old member session revocation does not impersonate the member during machine exchange', async () => {
  const f = await approved(); await owner.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1', [f.actor.session_hash]);
  assert.equal((await api.poll({ ...await pollInput(f), enrollmentProof: f.enrollmentProof })).status, 'issued');
});

test('DEVICE-ADV old enrollment confirm cannot bypass ownership of a pairing challenge', async () => {
  const f = await approved();
  await assert.rejects(createRuntimeRegistrations(app, { environment: 'local' }).confirm(f.actor,
    { key: randomUUID(), challengeId: f.challenge.challenge_id, proof: f.enrollmentProof }),
  error => status(400, 401, 403, 409)(error) || sqlCode('23514')(error));
  await assertUnconsumed(f);
  assert.equal((await api.poll({ ...await pollInput(f), enrollmentProof: f.enrollmentProof })).status, 'issued');
});

test('DEVICE-ADV original pairing deadline survives newer enrollment challenge and legacy confirm attempts', async () => {
  const f = await approved(await historical(1800));
  assert.ok(Date.parse(f.challenge.expires_at) > Date.parse(f.authorization.expiresAt) + 200_000);
  await waitUntil(Date.parse(f.authorization.expiresAt));
  await assert.rejects(createRuntimeRegistrations(app, { environment: 'local' }).confirm(f.actor,
    { key: randomUUID(), challengeId: f.challenge.challenge_id, proof: f.enrollmentProof }),
  error => status(400, 401, 403, 409)(error) || sqlCode('23514')(error));
  assert.equal((await api.poll({ ...await pollInput(f), enrollmentProof: f.enrollmentProof })).status, 'expired_token');
  await assertUnconsumed(f);
});

test('DEVICE-ADV final storage wait crossing original deadline rolls exchange back', async () => {
  const f = await approved(await historical(2400)), input = { ...await pollInput(f), enrollmentProof: f.enrollmentProof };
  const initial = await durableCounts(), holder = await owner.connect(), lock = 719031;
  await holder.query('BEGIN'); await holder.query('SELECT pg_advisory_xact_lock($1)', [lock]);
  await owner.query(`CREATE FUNCTION device_final_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.state='consumed' AND OLD.state<>'consumed' THEN PERFORM pg_advisory_xact_lock(${lock}); END IF; RETURN NULL; END $$`);
  await owner.query('CREATE TRIGGER zz_device_final_barrier AFTER UPDATE ON device_authorizations FOR EACH ROW EXECUTE FUNCTION device_final_barrier()');
  const outcome = api.poll(input).then(value => ({ value, error: null }), error => ({ value: null, error }));
  try { await blocking(holder); await waitUntil(Date.parse(f.authorization.expiresAt)); }
  finally { await holder.query('COMMIT'); holder.release(); }
  try { assert.ok(status(401)((await outcome).error)); }
  finally { await owner.query('DROP TRIGGER zz_device_final_barrier ON device_authorizations'); await owner.query('DROP FUNCTION device_final_barrier()'); }
  assert.deepEqual(await durableCounts(), initial); await assertUnconsumed(f);
});

test('DEVICE-ADV genuine issuer signing await crossing poll-proof expiry cannot issue a token', async () => {
  const f = await approved(), iat = Math.floor(await dbNow() / 1000) - 59;
  const input = { ...await pollInput(f, { iat }), enrollmentProof: f.enrollmentProof }, initial = await durableCounts();
  const original = crypto.subtle.sign.bind(crypto.subtle);
  let reached!: () => void, release!: () => void;
  const arrived = new Promise<void>(resolve => { reached = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  crypto.subtle.sign = (async (...args: Parameters<SubtleCrypto['sign']>) => {
    const result = await original(...args);
    const text = Buffer.from(args[2] as ArrayBuffer).toString();
    if (text.startsWith(encode({ alg: 'ES256', typ: 'freedom-bootstrap+jwt', kid: bootstrap.keys[0].kid }) + '.')) {
      reached(); await gate;
    }
    return result;
  }) as SubtleCrypto['sign'];
  const outcome = api.poll(input).then(value => ({ value, error: null }), error => ({ value: null, error }));
  try {
    await Promise.race([arrived, delay(3000).then(() => assert.fail('Actual issuer signing barrier not reached'))]);
    await waitUntil((iat + 61) * 1000); release();
    assert.ok(status(401)((await outcome).error));
  } finally { release(); crypto.subtle.sign = original; await outcome; }
  assert.deepEqual(await durableCounts(), initial); await assertUnconsumed(f);
});

test('DEVICE-ADV real proof possession does not bypass pending-key quota with new JTIs', async () => {
  const key = device();
  for (let i = 0; i < 4; i++) assert.ok((await api.begin((await beginInput(key)).input)).authorizationId);
  await assert.rejects(api.begin((await beginInput(key)).input), status(409, 429));
});

test('DEVICE-ADV input accessors and authority overrides fail before execution or state changes', async () => {
  const f = await begun(), original = await pollInput(f); let invoked = 0;
  for (const accessor of ['authorizationId', 'deviceCode', 'proof']) {
    const input = { ...original }; Object.defineProperty(input, accessor, { enumerable: true, get() { invoked++; throw Error('PRIVATE_MARKER'); } });
    await assert.rejects(api.poll(input), status(400, 401));
  }
  for (const extra of [{ nowMs: 0 }, { actor: {} }, { issuer: bootstrap.issuer }, { operational_authority: true }])
    await assert.rejects(api.poll({ ...original, ...extra }), status(400, 401));
  assert.equal(invoked, 0); assert.equal((await api.poll(original)).status, 'authorization_pending');
});

test('DEVICE-ADV denied requests cannot be approved later and never create an enrollment challenge', async () => {
  const f = await begun(), human = await member(), initial = await durableCounts();
  assert.equal((await api.decide(human.actor, decision(f, 'deny'))).state, 'denied');
  await assert.rejects(api.decide(human.actor, decision(f)), status(400, 401, 403, 409));
  assert.equal((await api.poll(await pollInput(f))).status, 'access_denied');
  assert.deepEqual((await durableCounts()).slice(0, 4), initial.slice(0, 4));
});

test('DEVICE-ADV runtime LOGIN cannot alter schema or rewrite immutable pairing bindings', async () => {
  const f = await begun();
  await assert.rejects(app.query('CREATE TABLE device_unauthorized_ddl(id integer)'), sqlCode('42501'));
  await assert.rejects(app.query('ALTER TABLE device_authorizations DISABLE TRIGGER ALL'), sqlCode('42501'));
  await assert.rejects(app.query('DELETE FROM device_authorizations WHERE authorization_id=$1', [f.authorization.authorizationId]), sqlCode('42501', '23514'));
  await assert.rejects(app.query("UPDATE device_authorizations SET environment='next' WHERE authorization_id=$1", [f.authorization.authorizationId]), sqlCode('23514'));
  await assert.rejects(app.query('UPDATE device_authorizations SET public_jwk=$2 WHERE authorization_id=$1',
    [f.authorization.authorizationId, device().publicJwk]), sqlCode('23514'));
  await assert.rejects(app.query("UPDATE device_authorizations SET expires_at=expires_at+interval '1 second' WHERE authorization_id=$1",
    [f.authorization.authorizationId]), sqlCode('23514'));
});

test('DEVICE-ADV physical-schema guard rejects a TEMP challenge with substituted owner binding', async () => {
  const f = await begun(), stranger = await member();
  const unlinked = await createRuntimeRegistrations(app, { environment: 'local' }).begin(stranger.actor,
    { key: randomUUID(), publicJwk: device().publicJwk });
  const q = await app.connect();
  await q.query('BEGIN');
  try {
    await q.query('CREATE TEMP TABLE runtime_registration_challenges AS SELECT * FROM '+schema+'.runtime_registration_challenges');
    await q.query(`UPDATE pg_temp.runtime_registration_challenges SET owner_user_id=$1,owner_principal_id=$2,scope_id=$3,
      public_jwk=$4,key_thumbprint=(SELECT key_thumbprint FROM ${schema}.device_authorizations WHERE authorization_id=$5) WHERE challenge_id=$6`,
      [stranger.actor.user_id, stranger.context.subject_principal.principal_id, stranger.context.scope.scope_id,
      f.key.publicJwk, f.authorization.authorizationId, unlinked.challenge_id]);
    await assert.rejects(q.query(`UPDATE ${schema}.device_authorizations SET state='approved',decided_at=date_trunc('milliseconds',clock_timestamp()),
      owner_user_id=$1,owner_principal_id=$2,scope_id=$3,challenge_id=$5 WHERE authorization_id=$4`,
      [stranger.actor.user_id, stranger.context.subject_principal.principal_id, stranger.context.scope.scope_id,
      f.authorization.authorizationId, unlinked.challenge_id]), sqlCode('23514'));
  } finally { await q.query('ROLLBACK'); q.release(); }
  assert.equal((await owner.query('SELECT state FROM device_authorizations WHERE authorization_id=$1', [f.authorization.authorizationId])).rows[0].state, 'pending');
});

test('DEVICE-ADV forged exchange marker cannot commit without complete backing exchange', async () => {
  const f = await approved(), q = await app.connect(); await q.query('BEGIN');
  try {
    await q.query(`INSERT INTO device_poll_proofs(authorization_id,proof_jti,accepted_at,exchange_challenge_id)
      VALUES($1,$2,date_trunc('milliseconds',clock_timestamp()),$3)`, [f.authorization.authorizationId, randomUUID(), f.challenge.challenge_id]);
    await assert.rejects(q.query('COMMIT'), sqlCode('23514'));
  } finally { await q.query('ROLLBACK'); q.release(); }
  await assertUnconsumed(f);
  assert.equal((await owner.query('SELECT count(*)::int n FROM device_poll_proofs WHERE authorization_id=$1', [f.authorization.authorizationId])).rows[0].n, 0);
});

for (const revoked of ['user', 'person', 'scope', 'onboarding'] as const) {
  test(`DEVICE-ADV current ${revoked} revocation wins a real approved-poll lock race`, async () => {
    const f = await approved(), input = { ...await pollInput(f), enrollmentProof: f.enrollmentProof };
    const holder = await owner.connect(); await holder.query('BEGIN');
    if (revoked === 'user') await holder.query('UPDATE users SET active=false WHERE user_id=$1', [f.actor.user_id]);
    if (revoked === 'person') await holder.query("UPDATE principals SET status='disabled' WHERE principal_id=$1", [f.context.subject_principal.principal_id]);
    if (revoked === 'scope') await holder.query("UPDATE resource_scopes SET status='disabled' WHERE scope_id=$1", [f.context.scope.scope_id]);
    if (revoked === 'onboarding') await holder.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1', [f.actor.user_id]);
    const outcome = api.poll(input).then(value => ({ value, error: null }), error => ({ value: null, error }));
    try { await blocking(holder); } finally { await holder.query('COMMIT'); holder.release(); }
    assert.ok(status(401, 403)((await outcome).error)); await assertUnconsumed(f);
  });
}

for (const sink of ['runtime_registrations', 'agent_connections', 'bootstrap_refresh_families', 'bootstrap_refresh_generations', 'bootstrap_nonces', 'device_poll_proofs']) {
  test(`DEVICE-ADV exchange ${sink} fault rolls back all durable issuance state`, async () => {
    const f = await approved(), initial = await durableCounts(), input = { ...await pollInput(f), enrollmentProof: f.enrollmentProof };
    await owner.query("CREATE FUNCTION device_sink_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE_DEVICE_FAULT'; END $$");
    await owner.query(`CREATE TRIGGER device_sink_fault AFTER INSERT ON ${sink} FOR EACH ROW EXECUTE FUNCTION device_sink_fault()`);
    try { await assert.rejects(api.poll(input), error => status(503)(error) && !JSON.stringify(error).includes('PRIVATE_DEVICE_FAULT')); }
    finally { await owner.query(`DROP TRIGGER device_sink_fault ON ${sink}`); await owner.query('DROP FUNCTION device_sink_fault()'); }
    assert.deepEqual(await durableCounts(), initial); await assertUnconsumed(f);
    assert.equal((await api.poll(input)).status, 'issued', 'Failed exchange must not persist proof replay or throttle state');
  });
}

for (const sink of ['runtime_registration_challenges', 'device_authorizations']) {
  test(`DEVICE-ADV ${sink} consumption failure cannot commit an issued credential`, async () => {
    const f = await approved(), initial = await durableCounts(), input = { ...await pollInput(f), enrollmentProof: f.enrollmentProof };
    await owner.query("CREATE FUNCTION device_consume_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'PRIVATE_DEVICE_FAULT'; END IF; RETURN NULL; END $$");
    await owner.query(`CREATE TRIGGER device_consume_fault AFTER UPDATE ON ${sink} FOR EACH ROW EXECUTE FUNCTION device_consume_fault()`);
    try { await assert.rejects(api.poll(input), error => status(503)(error) && !JSON.stringify(error).includes('PRIVATE_DEVICE_FAULT')); }
    finally { await owner.query(`DROP TRIGGER device_consume_fault ON ${sink}`); await owner.query('DROP FUNCTION device_consume_fault()'); }
    assert.deepEqual(await durableCounts(), initial); await assertUnconsumed(f);
    assert.equal((await api.poll(input)).status, 'issued');
  });
}

for (const sink of ['runtime_registration_challenges', 'scoped_command_receipts', 'scoped_transition_journal', 'scoped_outbox']) {
  test(`DEVICE-ADV approval ${sink} fault rolls back domain facts but not review charge`, async () => {
    const f = await begun(), human = await member(), input = decision(f), initial = await durableCounts();
    await owner.query("CREATE FUNCTION device_decision_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE_DEVICE_FAULT'; END $$");
    await owner.query(`CREATE TRIGGER device_decision_fault AFTER INSERT ON ${sink} FOR EACH ROW EXECUTE FUNCTION device_decision_fault()`);
    try { await assert.rejects(api.decide(human.actor, input)); }
    finally { await owner.query(`DROP TRIGGER device_decision_fault ON ${sink}`); await owner.query('DROP FUNCTION device_decision_fault()'); }
    assert.deepEqual(await durableCounts(), initial);
    assert.equal((await owner.query('SELECT attempts FROM device_review_buckets WHERE owner_principal_id=$1 AND environment=$2',
      [human.context.subject_principal.principal_id, 'local'])).rows[0].attempts, 1,
    'Domain rollback must not erase the independently committed lookup charge');
    assert.equal((await api.decide(human.actor, input)).state, 'approved');
  });
}

for (const target of ['approved', 'denied'] as const) {
  for (const timestamp of ['NULL', "date_trunc('milliseconds',clock_timestamp()) - interval '0.000999 seconds'"] as const) {
    test(`DEVICE-SQL-TIME ${target} rejects ${timestamp === 'NULL' ? 'NULL' : 'submillisecond'} decided_at under real runtime LOGIN`, async () => {
      const f = await begun(), human = await member();
      const challenge = target === 'approved' ? await createRuntimeRegistrations(app, { environment: 'local' })
        .begin(human.actor, { key: randomUUID(), publicJwk: f.key.publicJwk }) : null;
      const q = await app.connect(); await q.query('BEGIN');
      try {
        await assert.rejects(q.query(`UPDATE device_authorizations SET state=$2,owner_user_id=$3,owner_principal_id=$4,
          scope_id=$5,challenge_id=$6,decided_at=${timestamp} WHERE authorization_id=$1`, [f.authorization.authorizationId,
          target, human.actor.user_id, human.context.subject_principal.principal_id, human.context.scope.scope_id, challenge?.challenge_id ?? null]),
        sqlCode('23514'));
      } finally { await q.query('ROLLBACK'); q.release(); }
      assert.equal((await owner.query('SELECT state FROM device_authorizations WHERE authorization_id=$1', [f.authorization.authorizationId])).rows[0].state, 'pending');
    });
  }
}

for (const timestamp of ['NULL', "NEW.consumed_at + interval '0.000001 second'"] as const) {
  test(`DEVICE-SQL-TIME genuine exchange cannot store ${timestamp === 'NULL' ? 'NULL' : 'submillisecond'} consumed_at`, async () => {
    const f = await approved(), initial = await durableCounts();
    // Structural SQL invariant probe, NOT a claim that an HTTP caller controls
    // this timestamp: the fixture owner corrupts NEW only at the final UPDATE.
    // Enrollment, issuer signatures and all backing rows remain genuine, and
    // the mutation itself is issued by the actual non-superuser runtime LOGIN.
    await owner.query(`CREATE FUNCTION device_timestamp_corruption() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.state='consumed' AND OLD.state<>'consumed' THEN NEW.consumed_at := ${timestamp}; END IF; RETURN NEW; END $$`);
    await owner.query('CREATE TRIGGER aaa_device_timestamp_corruption BEFORE UPDATE ON device_authorizations FOR EACH ROW EXECUTE FUNCTION device_timestamp_corruption()');
    try { await assert.rejects(api.poll({ ...await pollInput(f), enrollmentProof: f.enrollmentProof }), status(401)); }
    finally { await owner.query('DROP TRIGGER aaa_device_timestamp_corruption ON device_authorizations'); await owner.query('DROP FUNCTION device_timestamp_corruption()'); }
    await assertUnconsumed(f); assert.deepEqual(await durableCounts(), initial);
  });
}
