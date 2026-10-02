import assert from 'node:assert/strict';
import { before, after, beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { CompactSign, exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { migrate } from '../../scripts/database.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import type { Actor } from '../../modules/identity-membership/service.js';
import { createRuntimeRegistrations } from '../../modules/agent-control/runtime-registration.js';
import { parseRuntimePublicJwk } from '../../modules/agent-control/runtime-proof.js';
import { createAgentConnections } from '../../modules/agent-control/agent-connections.js';
import { createBootstrapStatus } from '../../modules/agent-control/bootstrap-status.js';
import { BootstrapNonceSchema, BootstrapStatusSchema, type BootstrapNonce } from '../../contracts/execution/v1/bootstrap-status.js';
import type { BootstrapProofHost } from '../../contracts/execution/v1/bootstrap.js';
import { Problem } from '../../packages/shared/problem.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname)) throw new Error('Explicit isolated fp_* TEST_DATABASE_URL required.');
const schema = `fp_bootstrap_status_${process.pid}_${Date.now()}`, migrator = `${schema}_owner`, runtime = `${schema}_app`;
const admin = new Pool({ connectionString });
function roleUrl(role: string) { const url = new URL(connectionString!); url.username = role; url.password = ''; return url.toString(); }
const owner = new Pool({ connectionString: roleUrl(migrator), options: `-c search_path=${schema} -c statement_timeout=10000` });
const app = new Pool({ connectionString: roleUrl(runtime), options: `-c search_path=${schema} -c statement_timeout=10000`, max: 12 });
const issuer = await generateKeyPair('ES256', { extractable: true });
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
beforeEach(async () => { await owner.query('TRUNCATE communities CASCADE'); });
const problem = (status: number, code?: string) => (error: unknown) => error instanceof Problem && error.status === status && (!code || error.code === code);
const invalid = problem(401, 'bootstrap_invalid');
const sqlCode = (value: string) => (error: unknown) => (error as { code?: string }).code === value;
async function member() {
  const user = randomUUID(), community = randomUUID(), session = randomUUID();
  await owner.query("INSERT INTO communities VALUES($1,'Synthetic bootstrap owner')", [community]);
  const row = (await owner.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic owner','not-a-login',$4) RETURNING *`, [user, community, user+'@example.invalid', randomUUID()])).rows[0];
  await owner.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')", [session, user]);
  const actor: Actor = { ...row, session_hash: session, csrf_token: 'synthetic' };
  const context = await withMemberScope(app, { actor, scope: 'personal' }, async () => {}, async (_q, context) => context);
  return { actor, context };
}
async function fixture(clientId = 'synthetic-bootstrap') {
  const f = await member(), device = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = parseRuntimePublicJwk(await exportJWK(device.publicKey));
  const enrollment = createRuntimeRegistrations(app, { environment: 'local' });
  const challenge = await enrollment.begin(f.actor, { key: randomUUID(), publicJwk });
  const proof = await new CompactSign(new TextEncoder().encode(challenge.payload))
    .setProtectedHeader({ alg: 'ES256', typ: 'freedom-runtime-enrollment+jws' }).sign(device.privateKey);
  const enrolled = await enrollment.confirm(f.actor, { key: randomUUID(), challengeId: challenge.challenge_id, proof });
  const connections = createAgentConnections(app, { environment: 'local', clientId });
  const connection = await connections.create(f.actor, { key: randomUUID(), runtimeDeviceId: enrolled.runtimeDeviceId });
  const now = (await owner.query('SELECT clock_timestamp() now')).rows[0].now.getTime();
  const host: BootstrapProofHost = { environment: 'local', clientId, issuer: 'https://issuer.example/', audience: 'https://platform.example/',
    bootstrapUri: 'https://platform.example/execution-api/v1/bootstrap', keys: [{ kid: 'synthetic-issuer', environment: 'local', purpose: 'bootstrap_access',
      publicJwk: issuerJwk, notBeforeMs: now-3600000, notAfterMs: now+3600000, revoked: false }] };
  return { ...f, device, publicJwk, enrollment, connections, connection, host, enrolled, api: createBootstrapStatus(app, host) };
}
async function sign(payload: unknown, header: Record<string, unknown>, key: CryptoKey) {
  return new CompactSign(new TextEncoder().encode(JSON.stringify(payload))).setProtectedHeader(header as { alg: string }).sign(key);
}
async function signed(f: Awaited<ReturnType<typeof fixture>>, nonce: BootstrapNonce, changes: { access?: Record<string, unknown>; proof?: Record<string, unknown> } = {}) {
  const now = Math.floor((await owner.query('SELECT clock_timestamp() now')).rows[0].now.getTime()/1000);
  const accessToken = await sign({ iss: f.host.issuer, aud: f.host.audience, sub: f.context.subject_principal.principal_id, owner_user_id: f.actor.user_id,
    scope_id: f.context.scope.scope_id, runtime_device_id: f.enrolled.runtimeDeviceId, connection_id: nonce.connectionId, connection_version: '1',
    client_id: f.host.clientId, environment: 'local', purpose: 'bootstrap_access', scope: 'bootstrap.status.read', cnf: { jkt: f.enrolled.keyThumbprint },
    iat: now-1, exp: now+120, jti: randomUUID(), ...changes.access },
  { alg: 'ES256', typ: 'freedom-bootstrap+jwt', kid: f.host.keys[0].kid }, issuer.privateKey);
  const proof = await sign({ jti: randomUUID(), htm: 'GET', htu: f.host.bootstrapUri, iat: now,
    ath: createHash('sha256').update(accessToken, 'ascii').digest('base64url'), nonce: nonce.nonce, ...changes.proof },
  { alg: 'ES256', typ: 'dpop+jwt', jwk: f.publicJwk }, f.device.privateKey);
  return { connectionId: nonce.connectionId, nonceId: nonce.nonceId, accessToken, proof };
}
async function pending(f: Awaited<ReturnType<typeof fixture>>) { return f.api.challenge(f.actor, { key: randomUUID(), connectionId: f.connection.connectionId }); }
async function counts() { return Promise.all(['bootstrap_nonces', 'scoped_command_receipts', 'scoped_transition_journal', 'scoped_outbox'].map(async table =>
  (await owner.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n)); }
async function isPending(id: string) { return (await owner.query('SELECT consumed_at IS NULL pending FROM bootstrap_nonces WHERE nonce_id=$1', [id])).rows[0].pending; }

test('BOOTSTRAP-01 actual low-privilege LOGIN issues public challenge and admits exact status once with real signatures', async () => {
  const session = (await app.query('SELECT current_user,session_user,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) superuser')).rows[0];
  assert.deepEqual(session, { current_user: runtime, session_user: runtime, superuser: false });
  const f = await fixture(), previous = await counts(), nonce = await pending(f);
  assert.deepEqual(BootstrapNonceSchema.parse(nonce), nonce); assert.equal(Date.parse(nonce.expiresAt)-Date.parse(nonce.issuedAt), 60000);
  assert.deepEqual(await counts(), previous.map(value => value+1));
  const input = await signed(f, nonce), value = await f.api.read(input);
  assert.deepEqual(BootstrapStatusSchema.parse(value), value); assert.equal(value.connectionId, f.connection.connectionId);
  assert.equal(value.operation, 'bootstrap.status.read'); assert.equal(value.operational_authority, false);
  assert.equal(await isPending(nonce.nonceId), false); await assert.rejects(f.api.read(input), invalid);
  assert.deepEqual(await counts(), previous.map(value => value+1), 'machine admission has no fake member receipt/facts');
  for (const table of ['bootstrap_nonces','scoped_command_receipts','scoped_transition_journal','scoped_outbox']) {
    const text = JSON.stringify((await owner.query(`SELECT * FROM ${table}`)).rows);
    assert(!text.includes(input.accessToken)); assert(!text.includes(input.proof)); assert(!text.includes('PRIVATE KEY'));
  }
  assert.equal((await owner.query('SELECT count(*)::int n FROM outbox')).rows[0].n, 0);
});
test('BOOTSTRAP-02 exact member challenge replay requires pending nonce and stops after consume', async () => {
  const f = await fixture(), input = { key: randomUUID(), connectionId: f.connection.connectionId };
  const nonce = await f.api.challenge(f.actor, input), before = await counts();
  assert.deepEqual(await f.api.challenge(f.actor, input), nonce); assert.deepEqual(await counts(), before);
  await f.api.read(await signed(f, nonce));
  await assert.rejects(f.api.challenge(f.actor, input), problem(409));
});
test('BOOTSTRAP-03 machine request neither requires nor resurrects a member session', async () => {
  const f = await fixture(), nonce = await pending(f), input = await signed(f, nonce);
  await owner.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1', [f.actor.session_hash]);
  await assert.rejects(f.api.challenge(f.actor, { key: randomUUID(), connectionId: f.connection.connectionId }), problem(401));
  assert.equal((await f.api.read(input)).operation, 'bootstrap.status.read');
  assert.notEqual((await owner.query('SELECT revoked_at FROM sessions WHERE token_hash=$1', [f.actor.session_hash])).rows[0].revoked_at, null);
});
for (const kind of ['user', 'principal', 'scope', 'onboarding', 'runtime', 'connection'] as const) test(`BOOTSTRAP-04 current ${kind} authority blocks machine read without consuming`, async () => {
  const f = await fixture(), nonce = await pending(f), input = await signed(f, nonce);
  if (kind === 'user') await owner.query('UPDATE users SET active=false WHERE user_id=$1', [f.actor.user_id]);
  if (kind === 'principal') await owner.query("UPDATE principals SET status='disabled' WHERE principal_id=$1", [f.context.subject_principal.principal_id]);
  if (kind === 'scope') await owner.query("UPDATE resource_scopes SET status='disabled' WHERE scope_id=$1", [f.context.scope.scope_id]);
  if (kind === 'onboarding') await owner.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1', [f.actor.user_id]);
  if (kind === 'runtime') await f.enrollment.revoke(f.actor, { key: randomUUID(), runtimeDeviceId: f.enrolled.runtimeDeviceId, expectedVersion: '1' });
  if (kind === 'connection') await f.connections.revoke(f.actor, { key: randomUUID(), connectionId: f.connection.connectionId, expectedVersion: '1' });
  await assert.rejects(f.api.read(input), invalid); assert.equal(await isPending(nonce.nonceId), true);
});
test('BOOTSTRAP-05 invalid signed purpose, owner, key binding, method and nonce cannot burn a valid challenge', async () => {
  const f = await fixture(), nonce = await pending(f);
  for (const changes of [{ access: { owner_user_id: randomUUID() } }, { access: { purpose: 'execution' } },
    { access: { connection_version: '2' } }, { access: { cnf: { jkt: 'A'.repeat(43) } } },
    { proof: { htm: 'POST' } }, { proof: { nonce: 'A'.repeat(43) } }]) {
    await assert.rejects(f.api.read(await signed(f, nonce, changes)), invalid); assert.equal(await isPending(nonce.nonceId), true);
  }
  assert.equal((await f.api.read(await signed(f, nonce))).state, 'active');
});
test('BOOTSTRAP-06 absence, extra fields, getter input, other owner and wrong host remain closed', async () => {
  const f = await fixture(), nonce = await pending(f), input = await signed(f, nonce), peer = await member();
  await assert.rejects(f.api.challenge(peer.actor, { key: randomUUID(), connectionId: f.connection.connectionId }), problem(404));
  for (const changed of [{ ...input, connectionId: randomUUID() }, { ...input, nonceId: randomUUID() },
    { ...input, actor: f.actor }, { ...input, nowMs: Date.now() }, { ...input, operation: 'work.read' },
    { ...input, get proof() { assert.fail('getter executed'); return ''; } }]) await assert.rejects(f.api.read(changed), invalid);
  for (const host of [{ ...f.host, clientId: 'other-client' }, { ...f.host, environment: 'next' as const,
    keys: f.host.keys.map(key => ({ ...key, environment: 'next' as const })) }])
    await assert.rejects(createBootstrapStatus(app, host).read(input), invalid);
  assert.equal(await isPending(nonce.nonceId), true);
});
test('BOOTSTRAP-07 concurrent same challenge and proof requests commit one nonce and one admission', async () => {
  const f = await fixture(), input = { key: randomUUID(), connectionId: f.connection.connectionId };
  const [a,b] = await Promise.all([f.api.challenge(f.actor, input), f.api.challenge(f.actor, input)]); assert.deepEqual(a,b);
  const proof = await signed(f,a), outcomes = await Promise.allSettled([f.api.read(proof),f.api.read(proof)]);
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length,1);
  assert.equal(outcomes.filter(value => value.status === 'rejected' && invalid(value.reason)).length,1);
});
test('BOOTSTRAP-08 consumed proof JTI cannot be reused with a newly signed different nonce', async () => {
  const f = await fixture(), a = await pending(f), b = await pending(f), jti = randomUUID();
  await f.api.read(await signed(f,a,{proof:{jti}}));
  await assert.rejects(f.api.read(await signed(f,b,{proof:{jti}})),invalid);
  assert.equal(await isPending(b.nonceId),true);
  assert.equal((await f.api.read(await signed(f,b))).state,'active');
});
test('BOOTSTRAP-09 pending capacity is serialized across different member receipt keys', async () => {
  const f = await fixture();
  const outcomes = await Promise.allSettled(Array.from({length:9},()=>pending(f)));
  assert.equal(outcomes.filter(value=>value.status==='fulfilled').length,8);
  assert.equal(outcomes.filter(value=>value.status==='rejected' && problem(429)(value.reason)).length,1);
  assert.equal((await owner.query('SELECT count(*)::int n FROM bootstrap_nonces')).rows[0].n,8);
});
for (const sink of ['scoped_transition_journal','scoped_outbox','scoped_command_receipts']) test(`BOOTSTRAP-10 ${sink} failure rolls back challenge and all scoped facts`,async()=>{
  const f=await fixture(), previous=await counts();
  await owner.query("CREATE FUNCTION fp_bootstrap_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic storage fault'; END $$");
  await owner.query(`CREATE TRIGGER fp_bootstrap_fail BEFORE INSERT ON ${sink} FOR EACH ROW EXECUTE FUNCTION fp_bootstrap_fail()`);
  try { await assert.rejects(pending(f)); } finally {
    await owner.query(`DROP TRIGGER fp_bootstrap_fail ON ${sink}`); await owner.query('DROP FUNCTION fp_bootstrap_fail()');
  }
  assert.deepEqual(await counts(),previous); assert(await pending(f));
});
test('BOOTSTRAP-11 nonce update storage error is sanitized and leaves challenge usable after recovery',async()=>{
  const f=await fixture(), nonce=await pending(f), input=await signed(f,nonce);
  await owner.query("CREATE FUNCTION fp_bootstrap_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic private SQL diagnostic'; END $$");
  await owner.query('CREATE TRIGGER fp_bootstrap_fail BEFORE UPDATE ON bootstrap_nonces FOR EACH ROW EXECUTE FUNCTION fp_bootstrap_fail()');
  try { await assert.rejects(f.api.read(input),error=>{
    assert(problem(503,'bootstrap_unavailable')(error)); assert(!String(error).includes('private SQL')); return true;
  }); } finally { await owner.query('DROP TRIGGER fp_bootstrap_fail ON bootstrap_nonces'); await owner.query('DROP FUNCTION fp_bootstrap_fail()'); }
  assert.equal(await isPending(nonce.nonceId),true); assert.equal((await f.api.read(input)).state,'active');
});
test('BOOTSTRAP-12 app cannot mutate immutable nonce identity, delete history or bypass table guards',async()=>{
  const f=await fixture(), nonce=await pending(f);
  for(const assignment of ['nonce_id=gen_random_uuid()','connection_id=gen_random_uuid()','runtime_device_id=gen_random_uuid()',
    'owner_user_id=gen_random_uuid()','owner_principal_id=gen_random_uuid()','scope_id=gen_random_uuid()',"environment='next'",
    "client_id='other'",'connection_version=2',"nonce=repeat('A',43)","issued_at=issued_at-interval '1 second'", "expires_at=expires_at+interval '1 second'"])
    await assert.rejects(app.query(`UPDATE bootstrap_nonces SET ${assignment} WHERE nonce_id=$1`,[nonce.nonceId]),sqlCode('23514'));
  await assert.rejects(app.query('DELETE FROM bootstrap_nonces WHERE nonce_id=$1',[nonce.nonceId]),sqlCode('23514'));
  await assert.rejects(app.query('ALTER TABLE bootstrap_nonces DISABLE TRIGGER preserve_bootstrap_nonce'),sqlCode('42501'));
  await assert.rejects(app.query('TRUNCATE bootstrap_nonces'),sqlCode('42501'));
});
test('BOOTSTRAP-13 host and request snapshots resist mutation across asynchronous database access',async()=>{
  const f=await fixture(), nonce=await pending(f), input=await signed(f,nonce), host=structuredClone(f.host), api=createBootstrapStatus(app,host);
  host.clientId='changed'; host.keys[0].revoked=true; host.keys[0].publicJwk.x='A'.repeat(43);
  const promise=api.read(input); input.connectionId=randomUUID(); input.proof='changed';
  assert.equal((await promise).connectionId,f.connection.connectionId);
});
test('BOOTSTRAP-14 consumed history counts toward the fixed lifetime bound even with no pending nonce',async()=>{
  const f=await fixture();
  // Trusted synthetic history tests accounting, not signature evidence. The real
  // physical backing checks and nonce transition guards remain enabled.
  await owner.query(`WITH stamp AS MATERIALIZED (SELECT date_trunc('milliseconds',clock_timestamp()) now)
    INSERT INTO bootstrap_nonces(nonce_id,connection_id,runtime_device_id,owner_user_id,owner_principal_id,scope_id,
      environment,client_id,connection_version,challenge_key,nonce,issued_at,expires_at)
    SELECT gen_random_uuid(),c.connection_id,c.runtime_device_id,c.owner_user_id,c.owner_principal_id,c.scope_id,
      c.environment,c.client_id,c.aggregate_version,gen_random_uuid()::text,repeat('A',43),stamp.now,stamp.now+interval '60 seconds'
    FROM agent_connections c CROSS JOIN stamp CROSS JOIN generate_series(1,4096) WHERE c.connection_id=$1`,[f.connection.connectionId]);
  await owner.query(`UPDATE bootstrap_nonces SET consumed_at=date_trunc('milliseconds',clock_timestamp()),
    proof_jti=gen_random_uuid()::text,token_jti=gen_random_uuid()::text WHERE connection_id=$1`,[f.connection.connectionId]);
  const rows=(await owner.query(`SELECT count(*)::int lifetime,count(*) FILTER(WHERE consumed_at IS NULL)::int pending
    FROM bootstrap_nonces WHERE connection_id=$1`,[f.connection.connectionId])).rows[0];
  assert.deepEqual(rows,{lifetime:4096,pending:0});
  const previous=await counts(); await assert.rejects(pending(f),problem(429,'bootstrap_challenge_limit'));
  assert.deepEqual(await counts(),previous);
});
test('BOOTSTRAP-15 challenge lifetime is capped by a genuinely near-expiry connection',async()=>{
  const f=await fixture();
  // Synthetic historical connection with the exact immutable thirty-day TTL.
  const row=(await owner.query(`WITH stamp AS MATERIALIZED (SELECT date_trunc('milliseconds',clock_timestamp()) now)
    INSERT INTO agent_connections(connection_id,runtime_device_id,owner_user_id,owner_principal_id,scope_id,environment,client_id,issued_at,expires_at)
    SELECT gen_random_uuid(),runtime_device_id,owner_user_id,owner_principal_id,scope_id,environment,'short-client',
      stamp.now-interval '720 hours'+interval '10 seconds',stamp.now+interval '10 seconds'
    FROM agent_connections CROSS JOIN stamp WHERE connection_id=$1 RETURNING *`,[f.connection.connectionId])).rows[0];
  const api=createBootstrapStatus(app,{...f.host,clientId:'short-client'});
  const nonce=await api.challenge(f.actor,{key:randomUUID(),connectionId:row.connection_id});
  assert.equal(nonce.expiresAt,row.expires_at.toISOString());
  assert(Date.parse(nonce.expiresAt)-Date.parse(nonce.issuedAt)<=10000);
});
