import assert from 'node:assert/strict';
import { before, after, beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { CompactSign, decodeJwt, exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { migrate } from '../../scripts/database.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import type { Actor } from '../../modules/identity-membership/service.js';
import { createDeviceAuthorizations } from '../../modules/agent-control/device-authorizations.js';
import { createBootstrapStatus } from '../../modules/agent-control/bootstrap-status.js';
import { createRuntimeRegistrations } from '../../modules/agent-control/runtime-registration.js';
import { parseRuntimePublicJwk } from '../../modules/agent-control/runtime-proof.js';
import { DeviceAuthorizationBeginResultSchema, DeviceAuthorizationReviewSchema, DeviceAuthorizationPollResultSchema,
  type DeviceAuthorizationHost, type DeviceAuthorizationBeginResult } from '../../contracts/execution/v1/device-pairing.js';
import { Problem } from '../../packages/shared/problem.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname)) throw new Error('Explicit isolated fp_* TEST_DATABASE_URL required.');
const schema = `fp_device_author_${process.pid}_${Date.now()}`, migrator = `${schema}_owner`, runtime = `${schema}_app`;
const admin = new Pool({ connectionString });
function roleUrl(role: string) { const url = new URL(connectionString!); url.username = role; url.password = ''; return url.toString(); }
const owner = new Pool({ connectionString: roleUrl(migrator), options: `-c search_path=${schema} -c statement_timeout=10000` });
const app = new Pool({ connectionString: roleUrl(runtime), options: `-c search_path=${schema} -c statement_timeout=10000`, max: 12 });
const issuer = await generateKeyPair('ES256');
const issuerJwk = parseRuntimePublicJwk(await exportJWK(issuer.publicKey));
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
after(async () => { await app.end(); await owner.end(); try {
  if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE; DROP ROLE ${runtime},${migrator}`);
} finally { await admin.end(); } });
beforeEach(async () => { await owner.query('TRUNCATE communities,device_authorizations CASCADE'); });
const problem = (status: number, code?: string) => (error: unknown) => error instanceof Problem && error.status === status && (!code || error.code === code);
const invalid = problem(401, 'device_authorization_invalid');
const sqlCode = (value: string) => (error: unknown) => (error as { code?: string }).code === value;
async function member() {
  const user = randomUUID(), community = randomUUID(), session = randomUUID();
  await owner.query("INSERT INTO communities VALUES($1,'Synthetic device owner')", [community]);
  const row = (await owner.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic owner','not-a-login',$4) RETURNING *`, [user, community, user+'@example.invalid', randomUUID()])).rows[0];
  await owner.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')", [session, user]);
  const actor: Actor = { ...row, session_hash: session, csrf_token: 'synthetic' };
  const context = await withMemberScope(app, { actor, scope: 'personal' }, async () => {}, async (_q, context) => context);
  return { actor, context };
}
async function fixture() {
  const m = await member(), device = await generateKeyPair('ES256');
  const publicJwk = parseRuntimePublicJwk(await exportJWK(device.publicKey));
  const now = (await owner.query('SELECT clock_timestamp() now')).rows[0].now.getTime();
  const host: DeviceAuthorizationHost = { environment: 'local', clientId: 'synthetic-device', clientDisplayName: 'Synthetic native client',
    issuer: 'https://issuer.example/', audience: 'https://platform.example/', bootstrapUri: 'https://platform.example/execution-api/v1/bootstrap',
    beginUri: 'https://platform.example/execution-api/v1/device-authorizations', pollUri: 'https://platform.example/execution-api/v1/auth/token',
    verificationUri: 'https://platform.example/device', issuerKid: 'synthetic-issuer',
    keys: [{ kid: 'synthetic-issuer', purpose: 'bootstrap_access', environment: 'local', publicJwk: issuerJwk,
      notBeforeMs: now-3600000, notAfterMs: now+3600000, revoked: false }] };
  return { ...m, device, publicJwk, host, api: await createDeviceAuthorizations(app, { host, signingKey: issuer.privateKey }) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function sign(f: Fixture, claims: Record<string, unknown>, typ = 'freedom-device-pairing+jwt') {
  return new CompactSign(new TextEncoder().encode(JSON.stringify(claims))).setProtectedHeader({ alg: 'ES256', typ, jwk: f.publicJwk }).sign(f.device.privateKey);
}
async function beginInput(f: Fixture, changes: Record<string, unknown> = {}) {
  const claims = { purpose: 'device_pairing_begin', client_id: f.host.clientId, environment: 'local', runtime_kind: 'agent-kit',
    scope: 'bootstrap.status.read', jti: randomUUID(), iat: Math.floor(Date.now()/1000), htm: 'POST', htu: f.host.beginUri, ...changes };
  return { publicJwk: f.publicJwk, runtimeKind: 'agent-kit' as const, proof: await sign(f, claims) };
}
async function start(f: Fixture) { return f.api.begin(await beginInput(f)); }
async function pollInput(f: Fixture, started: DeviceAuthorizationBeginResult, changes: Record<string, unknown> = {}, enrollmentProof?: string) {
  const proof = await sign(f, { purpose: 'device_pairing_poll', client_id: f.host.clientId, environment: 'local', runtime_kind: 'agent-kit',
    scope: 'bootstrap.status.read', jti: randomUUID(), iat: Math.floor(Date.now()/1000), htm: 'POST', htu: f.host.pollUri,
    authorization_id: started.authorizationId, nonce: started.nonce, device_code_hash: createHash('sha256').update(started.deviceCode, 'ascii').digest('base64url'),
    request_digest: started.requestDigest, ...changes });
  return { authorizationId: started.authorizationId, deviceCode: started.deviceCode, proof, ...(enrollmentProof ? { enrollmentProof } : {}) };
}
async function approve(f: Fixture, started: DeviceAuthorizationBeginResult) {
  return f.api.decide(f.actor, { key: randomUUID(), userCode: started.userCode, authorizationId: started.authorizationId, requestDigest: started.requestDigest, decision: 'approve' });
}
async function enrolledProof(f: Fixture, started: DeviceAuthorizationBeginResult) {
  const result = await f.api.poll(await pollInput(f, started));
  assert.equal(result.status, 'proof_required'); if (result.status !== 'proof_required') throw Error('Unexpected protocol result');
  const proof = await new CompactSign(new TextEncoder().encode(result.challenge.payload))
    .setProtectedHeader({ alg: 'ES256', typ: 'freedom-runtime-enrollment+jws' }).sign(f.device.privateKey);
  return { challenge: result.challenge, proof };
}
async function waitPoll(started: DeviceAuthorizationBeginResult) {
  const row = (await owner.query('SELECT last_poll_at,poll_interval FROM device_authorizations WHERE authorization_id=$1', [started.authorizationId])).rows[0];
  const delay = row.last_poll_at ? row.last_poll_at.getTime()+row.poll_interval*1000-Date.now()+30 : 0;
  if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
}
async function exchange(f: Fixture, started: DeviceAuthorizationBeginResult) {
  const enrollment = await enrolledProof(f, started); await waitPoll(started);
  const input = await pollInput(f, started, {}, enrollment.proof), result = await f.api.poll(input);
  assert.equal(result.status, 'issued'); if (result.status !== 'issued') throw Error('Expected issued');
  return { input, result, enrollment };
}
async function counts() { return Promise.all(['runtime_registration_challenges','runtime_registrations','agent_connections','bootstrap_nonces','device_poll_proofs',
  'scoped_command_receipts','scoped_transition_journal','scoped_outbox'].map(async table => (await owner.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n)); }

test('DEVICE-01 real low-privilege fresh-device approval/exchange/status, no member cookie on machine path', async () => {
  const role = (await app.query('SELECT current_user,session_user,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) superuser')).rows[0];
  assert.deepEqual(role, { current_user: runtime, session_user: runtime, superuser: false });
  const f = await fixture(), started = await start(f);
  assert.deepEqual(DeviceAuthorizationBeginResultSchema.parse(started), started);
  assert.equal(Date.parse(started.expiresAt)-Date.parse(started.issuedAt), 300000);
  const review = await f.api.inspect(f.actor, { userCode: started.userCode });
  assert.deepEqual(DeviceAuthorizationReviewSchema.parse(review), review); assert.equal(review.state, 'pending');
  await approve(f, started); assert.deepEqual((await counts()).slice(0, 4), [1,0,0,0]);
  await owner.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1', [f.actor.session_hash]);
  const { result, input } = await exchange(f, started);
  assert.deepEqual(DeviceAuthorizationPollResultSchema.parse(result), result); assert.equal(result.refreshSupported, false);
  assert.equal(issuer.privateKey.extractable, false);
  const claims = decodeJwt(result.accessToken); assert.equal(claims.scope, 'bootstrap.status.read'); assert.equal(claims.purpose, 'bootstrap_access');
  const { issuerKid: _kid, beginUri: _begin, pollUri: _poll, verificationUri: _verify, clientDisplayName: _name, ...host } = f.host;
  const proof = await sign(f, { jti: randomUUID(), htm: 'GET', htu: host.bootstrapUri, iat: Math.floor(Date.now()/1000),
    ath: createHash('sha256').update(result.accessToken).digest('base64url'), nonce: result.nonce.nonce }, 'dpop+jwt');
  const status = await createBootstrapStatus(app, host).read({ connectionId: result.connectionId, nonceId: result.nonce.nonceId, accessToken: result.accessToken, proof });
  assert.equal(status.operational_authority, false); assert.equal(status.operation, 'bootstrap.status.read');
  await assert.rejects(f.api.poll(input), invalid);
  const tables = (await owner.query("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename")).rows;
  for (const { tablename } of tables) {
    const rows = JSON.stringify((await owner.query(`SELECT * FROM "${tablename}"`)).rows);
    for (const secret of [started.deviceCode, started.userCode, result.accessToken, input.proof, input.enrollmentProof!]) assert(!rows.includes(secret), `${tablename} must not store raw secret/proof`);
  }
});
test('DEVICE-02 begin replay cannot redeliver codes or claim another public key', async () => {
  const f = await fixture(), input = await beginInput(f); await f.api.begin(input);
  await assert.rejects(f.api.begin(input), invalid);
  const other = await fixture(); await assert.rejects(other.api.begin({ ...input, publicJwk: other.publicJwk }), invalid);
  assert.equal((await owner.query('SELECT count(*)::int n FROM device_authorizations')).rows[0].n, 1);
});
test('DEVICE-03 durable pending/slowdown and JTI replay, wrong signatures do not burn throttle', async () => {
  const f = await fixture(), started = await start(f), input = await pollInput(f, started);
  assert.equal((await f.api.poll(input)).status, 'authorization_pending');
  await assert.rejects(f.api.poll(input), invalid);
  const early = await f.api.poll(await pollInput(f, started)); assert.deepEqual(early, { status: 'slow_down', interval: 10, operational_authority: false });
  const before = (await owner.query('SELECT * FROM device_authorizations')).rows;
  await assert.rejects(f.api.poll(await pollInput(f, started, { request_digest: 'A'.repeat(43) })), invalid);
  assert.deepEqual((await owner.query('SELECT * FROM device_authorizations')).rows, before);
  assert.equal((await owner.query('SELECT count(*)::int n FROM device_poll_proofs')).rows[0].n, 2);
});
test('DEVICE-04 unknown-code charges survive errors and tenth lookup exhausts durable member bucket', async () => {
  const f = await fixture(), started = await start(f);
  for (let i = 0; i < 10; i++) await assert.rejects(f.api.inspect(f.actor, { userCode: 'ZZZZZ-ZZZZZ' }), problem(404));
  await assert.rejects(f.api.inspect(f.actor, { userCode: started.userCode }), problem(429, 'device_review_limit'));
  assert.equal((await owner.query('SELECT attempts FROM device_review_buckets')).rows[0].attempts, 10);
});
test('DEVICE-05 request substitution fails after charging bucket and two owners cannot bind one request', async () => {
  const f = await fixture(), started = await start(f), peer = await member();
  await assert.rejects(f.api.decide(f.actor, { key: randomUUID(), userCode: started.userCode, authorizationId: started.authorizationId,
    requestDigest: 'A'.repeat(43), decision: 'approve' }), problem(404));
  const outcomes = await Promise.allSettled([f.actor, peer.actor].map(actor => f.api.decide(actor, { key: randomUUID(), userCode: started.userCode,
    authorizationId: started.authorizationId, requestDigest: started.requestDigest, decision: 'approve' })));
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await owner.query('SELECT count(*)::int n FROM runtime_registration_challenges')).rows[0].n, 1);
});
test('DEVICE-06 immutable host display snapshot is retained across replacement host instances', async () => {
  const f = await fixture(), started = await start(f);
  const other = await createDeviceAuthorizations(app, { host: { ...f.host, clientDisplayName: 'Replacement display' }, signingKey: issuer.privateKey });
  assert.equal((await other.inspect(f.actor, { userCode: started.userCode })).clientDisplayName, 'Synthetic native client');
  await assert.rejects(owner.query("UPDATE device_authorizations SET client_display_name='Changed'"), sqlCode('23514'));
});
test('DEVICE-07 deny is durable, creates no enrollment, and signed device receives access_denied', async () => {
  const f = await fixture(), started = await start(f), input = { key: randomUUID(), userCode: started.userCode,
    authorizationId: started.authorizationId, requestDigest: started.requestDigest, decision: 'deny' as const };
  assert.deepEqual(await f.api.decide(f.actor, input), await f.api.decide(f.actor, input));
  assert.equal((await f.api.poll(await pollInput(f, started))).status, 'access_denied');
  assert.deepEqual((await counts()).slice(0, 4), [0,0,0,0]);
});
test('DEVICE-08 old member enrollment confirm cannot consume pairing-owned challenge; real exchange still succeeds', async () => {
  const f = await fixture(), started = await start(f); await approve(f, started);
  const enrollment = await enrolledProof(f, started), registry = createRuntimeRegistrations(app, { environment: 'local' });
  await assert.rejects(registry.confirm(f.actor, { key: randomUUID(), challengeId: enrollment.challenge.challenge_id, proof: enrollment.proof }), sqlCode('23514'));
  assert.deepEqual((await counts()).slice(0, 4), [1,0,0,0]);
  await waitPoll(started);
  assert.equal((await f.api.poll(await pollInput(f, started, {}, enrollment.proof))).status, 'issued');
});
for (const sink of ['scoped_command_receipts','scoped_transition_journal','scoped_outbox']) test(`DEVICE-09 ${sink} approval failure rolls back domain but not review charge`, async () => {
  const f = await fixture(), started = await start(f);
  await owner.query(`CREATE FUNCTION reject_device_fact() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic sink fault'; END$$;
    CREATE TRIGGER reject_device_fact BEFORE INSERT ON ${sink} FOR EACH ROW EXECUTE FUNCTION reject_device_fact()`);
  try { await assert.rejects(approve(f, started), problem(503));
    assert.equal((await owner.query('SELECT state FROM device_authorizations')).rows[0].state, 'pending');
    assert.deepEqual((await counts()).slice(0, 4), [0,0,0,0]);
    assert.equal((await owner.query('SELECT attempts FROM device_review_buckets')).rows[0].attempts, 1);
  } finally { await owner.query(`DROP TRIGGER reject_device_fact ON ${sink}; DROP FUNCTION reject_device_fact()`); }
  assert.equal((await approve(f, started)).state, 'approved');
});
test('DEVICE-10 low-privilege role cannot DDL/TRUNCATE or mutate/delete retained binding', async () => {
  const f = await fixture(); await start(f);
  await assert.rejects(app.query('ALTER TABLE device_authorizations ADD COLUMN bypass integer'), sqlCode('42501'));
  await assert.rejects(app.query('TRUNCATE device_authorizations CASCADE'), sqlCode('42501'));
  await assert.rejects(app.query('DELETE FROM device_authorizations'), sqlCode('23514'));
  await assert.rejects(app.query("UPDATE device_authorizations SET expires_at=expires_at+interval '1 second'"), sqlCode('23514'));
  await assert.rejects(app.query("UPDATE device_authorizations SET nonce=repeat('A',43)"), sqlCode('23514'));
});
test('DEVICE-11 malformed/getter input and extra authority fields fail before execution', async () => {
  const f = await fixture(), input = await beginInput(f); let accessed = false;
  const evil = { ...input, get clock() { accessed = true; return 0; } };
  await assert.rejects(f.api.begin(evil), invalid); assert.equal(accessed, false);
  await assert.rejects(f.api.begin({ ...input, ownerUserId: f.actor.user_id } as typeof input), invalid);
  const options = { get host() { accessed = true; return f.host; }, signingKey: issuer.privateKey };
  await assert.rejects(createDeviceAuthorizations(app, options)); assert.equal(accessed, false);
  assert.equal((await owner.query('SELECT count(*)::int n FROM device_authorizations')).rows[0].n, 0);
});
