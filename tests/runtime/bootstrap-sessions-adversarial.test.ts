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
import { createBootstrapSessions } from '../../modules/agent-control/bootstrap-sessions.js';
import { createBootstrapTokenIssuer } from '../../modules/agent-control/bootstrap-issuer.js';
import { createAgentConnections } from '../../modules/agent-control/agent-connections.js';
import type { BootstrapSessionHost } from '../../contracts/execution/v1/bootstrap-session.js';
import { createBootstrapStatus } from '../../modules/agent-control/bootstrap-status.js';
import type { BootstrapProofHost } from '../../contracts/execution/v1/bootstrap.js';
import type { DeviceAuthorizationHost } from '../../contracts/execution/v1/device-pairing.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname))
  throw new Error('Explicit isolated fp_* TEST_DATABASE_URL required.');
const schema = `fp_sessions_adv_${process.pid}_${Date.now()}`, migrator = `${schema}_owner`, runtime = `${schema}_app`;
const admin = new Pool({ connectionString });
function roleUrl(role: string) { const url = new URL(connectionString!); url.username = role; url.password = ''; return url.toString(); }
const owner = new Pool({ connectionString: roleUrl(migrator), options: `-c search_path=${schema} -c statement_timeout=10000` });
const app = new Pool({ connectionString: roleUrl(runtime), options: `-c search_path=${schema} -c statement_timeout=10000`, max: 12 });
let created = false;
let sessions: Awaited<ReturnType<typeof createBootstrapSessions>>;
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

const sessionHost: BootstrapSessionHost = { ...bootstrap, issuerKid: host.issuerKid,
  refreshUri: 'https://platform.example.invalid/execution-api/v1/auth/refresh',
  nonceUri: 'https://platform.example.invalid/execution-api/v1/auth/nonce' };

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
  try { await q.query(prefix); const rows = await q.query(grants); assert.equal(rows.rowCount, 2);
    for (const row of rows.rows) await q.query(Object.values(row)[0] as string); await q.query('COMMIT'); }
  catch (error) { await q.query('ROLLBACK'); throw error; } finally { q.release(); }
  const signingKey = await crypto.subtle.importKey('jwk', issuer.privateKey.export({ format: 'jwk' }),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  assert.equal(signingKey.extractable, false);
  api = await createDeviceAuthorizations(app, { host, signingKey });
  sessions = await createBootstrapSessions(app, { host: sessionHost, signingKey });
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

async function paired(publicChallenge = false) {
  const f = await approved();
  if(publicChallenge){
    const challenge=await api.poll(await pollInput(f));assert.equal(challenge.status,'proof_required');
    if(challenge.status!=='proof_required')throw Error('Public enrollment challenge required');
    f.enrollmentProof=signed(f.key.privateKey,{alg:'ES256',typ:'freedom-runtime-enrollment+jws'},challenge.challenge.payload);
    await waitUntil(await dbNow()+challenge.interval*1000);
  }
  const issued = await api.poll({ ...await pollInput(f), enrollmentProof: f.enrollmentProof });
  assert.equal(issued.status, 'issued');
  if (issued.status !== 'issued') throw Error('Genuine device exchange required');
  assert.equal(issued.refreshSupported, true);
  return { ...f, issued };
}
type Paired = Awaited<ReturnType<typeof paired>>;
const hash = (text: string) => createHash('sha256').update(text, 'ascii').digest('base64url');
async function refreshInput(f: Paired, refresh = f.issued.refresh, claims: Record<string, unknown> = {}, key = f.key) {
  return { familyId: refresh.familyId, refreshHandle: refresh.handle,
    proof: signed(key.privateKey, { alg: 'ES256', typ: 'freedom-bootstrap-refresh+jwt', jwk: key.publicJwk }, {
      purpose: 'bootstrap_refresh', client_id: bootstrap.clientId, environment: 'local', connection_id: f.issued.connectionId,
      family_id: refresh.familyId, generation: refresh.generation, refresh_handle_hash: hash(refresh.handle),
      jti: randomUUID(), iat: Math.floor(await dbNow()/1000), htm: 'POST', htu: sessionHost.refreshUri, ...claims }) };
}
async function nonceInput(f: Paired, accessToken = f.issued.accessToken, claims: Record<string, unknown> = {}) {
  return { connectionId: f.issued.connectionId, accessToken,
    proof: signed(f.key.privateKey, { alg: 'ES256', typ: 'freedom-bootstrap-nonce+jwt', jwk: f.key.publicJwk }, {
      purpose: 'bootstrap_nonce', client_id: bootstrap.clientId, environment: 'local', connection_id: f.issued.connectionId,
      jti: randomUUID(), iat: Math.floor(await dbNow()/1000), htm: 'POST', htu: sessionHost.nonceUri, ath: hash(accessToken), ...claims }) };
}
async function readStatus(f: Paired, accessToken: string, nonce: {nonceId: string; nonce: string}) {
  const proof = signed(f.key.privateKey, { alg: 'ES256', typ: 'dpop+jwt', jwk: f.key.publicJwk }, {
    jti: randomUUID(), iat: Math.floor(await dbNow()/1000), htm: 'GET', htu: bootstrap.bootstrapUri,
    ath: hash(accessToken), nonce: nonce.nonce });
  return createBootstrapStatus(app, bootstrap).read({ connectionId: f.issued.connectionId, accessToken, nonceId: nonce.nonceId, proof });
}
async function snapshot(f: Paired) {
  const result: Record<string, unknown> = {};
  for (const table of ['bootstrap_refresh_families','bootstrap_refresh_generations','bootstrap_session_proofs','agent_connections','bootstrap_nonces']) {
    const column = table === 'bootstrap_refresh_generations' ? 'family_id' : 'connection_id';
    const value = column === 'family_id' ? f.issued.refresh.familyId : f.issued.connectionId;
    result[table] = (await owner.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE ${column}=$1 ORDER BY to_jsonb(t)::text`, [value])).rows;
  }
  return result;
}
async function assertRevoked(f: Paired) {
  assert.deepEqual((await owner.query(`SELECT f.state family,c.state connection,c.aggregate_version::text version
    FROM bootstrap_refresh_families f JOIN agent_connections c USING(connection_id) WHERE f.family_id=$1`, [f.issued.refresh.familyId])).rows[0],
  { family: 'revoked', connection: 'revoked', version: '2' });
  await assert.rejects(readStatus(f, f.issued.accessToken, f.issued.nonce), status(401));
}

test('SESSION-ADV real LOGIN roles, fresh device, rotation, sessionless nonce and actual 09 status', async () => {
  for (const [pool, name] of [[owner,migrator],[app,runtime]] as const)
    assert.deepEqual((await pool.query('SELECT current_user,session_user,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0],
      { current_user: name, session_user: name, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
  const f = await paired(true);
  assert.equal(f.issued.refresh.generation, '1');
  await owner.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1', [f.actor.session_hash]);
  const input = await refreshInput(f), next = await sessions.refresh(input);
  assert.equal(next.refresh.generation, '2'); assert.equal(next.refresh.familyId, f.issued.refresh.familyId);
  assert.equal(next.refresh.expiresAt, f.issued.refresh.expiresAt); assert.notEqual(next.refresh.handle, f.issued.refresh.handle);
  assert.equal(next.operational_authority, false);
  const acquisition = await nonceInput(f, next.accessToken), nonce = await sessions.nonce(acquisition);
  assert.equal((await readStatus(f, next.accessToken, nonce)).operation, 'bootstrap.status.read');
  await assert.rejects(sessions.nonce(acquisition), status(401));
  const another = await sessions.nonce(await nonceInput(f, next.accessToken));
  assert.equal((await readStatus(f, next.accessToken, another)).operation, 'bootstrap.status.read');
  for (const { tablename } of (await owner.query('SELECT tablename FROM pg_tables WHERE schemaname=$1',[schema])).rows) {
    const bytes = JSON.stringify((await owner.query(`SELECT * FROM "${tablename}"`)).rows);
    for (const secret of [f.issued.refresh.handle,next.refresh.handle,f.issued.accessToken,next.accessToken,input.proof,acquisition.proof,
      f.authorization.deviceCode,f.enrollmentProof,f.key.privateKey.export({format:'jwk'}).d!,issuer.privateKey.export({format:'jwk'}).d!])
      assert.ok(!bytes.includes(secret), `${tablename} retained raw credential material`);
  }
});

for (const replay of ['exact','equivalent','old-generation'] as const) test(`SESSION-ADV ${replay} spent handle commits family and connection revocation before duplicate JTI admission`, async () => {
  const f = await paired(), input = await refreshInput(f), next = await sessions.refresh(input);
  if (replay === 'old-generation') await sessions.refresh(await refreshInput(f,next.refresh));
  const repeated = replay === 'equivalent' ? {...input,proof:alternateSignature(input.proof,f.key.publicKey)} : input;
  await assert.rejects(sessions.refresh(repeated),status(401));
  await assertRevoked(f);
  await assert.rejects(sessions.nonce(await nonceInput(f,next.accessToken)),status(401));
});

test('SESSION-ADV simultaneous valid use leaves no active winner', async () => {
  const f = await paired(), input = await refreshInput(f);
  const results = await Promise.allSettled([sessions.refresh(input),sessions.refresh({...input,proof:alternateSignature(input.proof,f.key.publicKey)})]);
  assert.equal(results.filter(v=>v.status==='fulfilled').length,1);
  assert.equal(results.filter(v=>v.status==='rejected' && status(401)(v.reason)).length,1);
  await assertRevoked(f);
});

test('SESSION-ADV wrong secret, signature, key, purpose and environment cannot revoke a spent handle', async () => {
  const f = await paired(); await sessions.refresh(await refreshInput(f)); const before = await snapshot(f);
  for (const claims of [{purpose:'bootstrap_nonce'},{environment:'next'},{client_id:'stranger'},{connection_id:randomUUID()},
    {generation:'2'},{family_id:randomUUID()},{iat:Math.floor(await dbNow()/1000)-61},{htu:sessionHost.nonceUri}])
    await assert.rejects(sessions.refresh(await refreshInput(f,f.issued.refresh,claims)),status(401));
  await assert.rejects(sessions.refresh(await refreshInput(f,f.issued.refresh,{},device())),status(401));
  const input = await refreshInput(f);
  await assert.rejects(sessions.refresh({...input,refreshHandle:hash(randomUUID())}),status(401));
  const parts = input.proof.split('.'); const sig=Buffer.from(parts[2],'base64url');sig[0]^=1;parts[2]=sig.toString('base64url');
  await assert.rejects(sessions.refresh({...input,proof:parts.join('.')}),status(401));
  assert.deepEqual(await snapshot(f),before);
});

test('SESSION-ADV session proof JTI is shared across refresh and nonce purposes', async () => {
  const f=await paired(), jti=randomUUID(); const next=await sessions.refresh(await refreshInput(f,f.issued.refresh,{jti}));
  const before=await snapshot(f);
  await assert.rejects(sessions.nonce(await nonceInput(f,next.accessToken,{jti})),status(401));
  assert.deepEqual(await snapshot(f),before);
});

test('SESSION-ADV connection, token and proof splicing cannot consume either legitimate session',async()=>{
  const f=await paired(),other=await paired(),before=await snapshot(f),otherBefore=await snapshot(other);
  const left=await nonceInput(f),right=await nonceInput(other),refresh=await refreshInput(f);
  for(const input of [{...left,connectionId:other.issued.connectionId},{...left,accessToken:other.issued.accessToken},
    {...left,proof:right.proof},{...left,proof:refresh.proof}])await assert.rejects(sessions.nonce(input),status(401));
  await assert.rejects(sessions.refresh({...refresh,familyId:other.issued.refresh.familyId}),status(401));
  assert.deepEqual(await snapshot(f),before);assert.deepEqual(await snapshot(other),otherBefore);
});

test('SESSION-ADV input accessors and authority overrides execute no caller code and write nothing',async()=>{
  const f=await paired(),refresh=await refreshInput(f),nonce=await nonceInput(f),before=await snapshot(f);let called=0;
  for(const field of ['familyId','refreshHandle','proof']){
    const input={...refresh};Object.defineProperty(input,field,{enumerable:true,get(){called++;throw Error('PRIVATE_GETTER');}});
    await assert.rejects(sessions.refresh(input),status(401));
  }
  for(const extra of [{nowMs:0},{actor:f.actor},{expectedBinding:{}},{operational_authority:true}]){
    await assert.rejects(sessions.refresh({...refresh,...extra}),status(401));
    await assert.rejects(sessions.nonce({...nonce,...extra}),status(401));
  }
  assert.equal(called,0);assert.deepEqual(await snapshot(f),before);
});

for (const operation of ['refresh','nonce'] as const) for (const authority of ['user','onboarding','person','scope','runtime','connection'] as const)
test(`SESSION-ADV current ${authority} revocation wins an observed ${operation} lock race`,async()=>{
  const f=await paired(), input=operation==='refresh'?await refreshInput(f):await nonceInput(f), before=await snapshot(f);
  const holder=await owner.connect();await holder.query('BEGIN');
  if(authority==='user')await holder.query('UPDATE users SET active=false WHERE user_id=$1',[f.actor.user_id]);
  if(authority==='onboarding')await holder.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1',[f.actor.user_id]);
  if(authority==='person')await holder.query("UPDATE principals SET status='disabled' WHERE principal_id=$1",[f.context.subject_principal.principal_id]);
  if(authority==='scope')await holder.query("UPDATE resource_scopes SET status='disabled' WHERE scope_id=$1",[f.context.scope.scope_id]);
  if(authority==='runtime')await holder.query("UPDATE runtime_registrations SET state='revoked',revoked_at=date_trunc('milliseconds',clock_timestamp()),aggregate_version=aggregate_version+1 WHERE runtime_device_id=$1",[f.issued.runtimeDeviceId]);
  if(authority==='connection')await holder.query("UPDATE agent_connections SET state='revoked',revoked_at=date_trunc('milliseconds',clock_timestamp()),aggregate_version=aggregate_version+1 WHERE connection_id=$1",[f.issued.connectionId]);
  const outcome=(operation==='refresh'?sessions.refresh(input as Awaited<ReturnType<typeof refreshInput>>):sessions.nonce(input as Awaited<ReturnType<typeof nonceInput>>))
    .then(value=>({value,error:null}),error=>({value:null,error}));
  try{await blocking(holder);}finally{await holder.query('COMMIT');holder.release();}
  assert.ok(status(401)((await outcome).error));
  if(authority==='connection')await assertRevoked(f); else assert.deepEqual(await snapshot(f),before);
});

test('SESSION-ADV actual member CAS revoke terminally revokes the refresh family',async()=>{
  const f=await paired();
  await createAgentConnections(app,{environment:'local',clientId:bootstrap.clientId}).revoke(f.actor,
    {key:randomUUID(),connectionId:f.issued.connectionId,expectedVersion:'1'});
  await assertRevoked(f);await assert.rejects(sessions.refresh(await refreshInput(f)),status(401));
});

test('SESSION-ADV actual member revoke wins a refresh race while its final receipt is blocked',async()=>{
  const f=await paired(),input=await refreshInput(f),holder=await owner.connect(),lock=819039;
  await holder.query('BEGIN');await holder.query('SELECT pg_advisory_xact_lock($1)',[lock]);
  await owner.query(`CREATE FUNCTION member_receipt_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${lock}); RETURN NULL; END $$`);
  await owner.query('CREATE TRIGGER zz_member_receipt_barrier AFTER INSERT ON scoped_command_receipts FOR EACH ROW EXECUTE FUNCTION member_receipt_barrier()');
  const revocation=createAgentConnections(app,{environment:'local',clientId:bootstrap.clientId}).revoke(f.actor,
    {key:randomUUID(),connectionId:f.issued.connectionId,expectedVersion:'1'}).then(value=>({value,error:null}),error=>({value:null,error}));
  let refresh:Promise<{value:unknown;error:unknown}>|undefined;
  try{
    await blocking(holder);refresh=sessions.refresh(input).then(value=>({value,error:null}),error=>({value:null,error}));
    let observed=false;
    for(let i=0;i<300;i++){
      const waiting=(await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE usename=$1 AND cardinality(pg_blocking_pids(pid))>0 AND query LIKE 'SELECT pg_advisory_xact_lock(hashtextextended%'",[runtime])).rows[0].n;
      if(waiting){observed=true;break;}await delay(10);
    }
    assert.ok(observed,'Refresh must actually wait on the member transaction');
  }finally{await holder.query('COMMIT');holder.release();}
  try{assert.equal((await revocation).error,null);assert.ok(refresh);assert.ok(status(401)((await refresh).error));await assertRevoked(f);}
  finally{await owner.query('DROP TRIGGER zz_member_receipt_barrier ON scoped_command_receipts');await owner.query('DROP FUNCTION member_receipt_barrier()');}
});

for(const sink of ['scoped_command_receipts','scoped_transition_journal','scoped_outbox'])
test(`SESSION-ADV member revoke ${sink} failure rolls derived family revocation back`,async()=>{
  const f=await paired(),before=await snapshot(f),service=createAgentConnections(app,{environment:'local',clientId:bootstrap.clientId});
  const input={key:randomUUID(),connectionId:f.issued.connectionId,expectedVersion:'1'};
  await owner.query("CREATE FUNCTION member_revoke_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE_REVOKE_FAULT'; END $$");
  await owner.query(`CREATE TRIGGER member_revoke_fault AFTER INSERT ON ${sink} FOR EACH ROW EXECUTE FUNCTION member_revoke_fault()`);
  try{await assert.rejects(service.revoke(f.actor,input));}
  finally{await owner.query(`DROP TRIGGER member_revoke_fault ON ${sink}`);await owner.query('DROP FUNCTION member_revoke_fault()');}
  assert.deepEqual(await snapshot(f),before);await service.revoke(f.actor,input);await assertRevoked(f);
});

test('SESSION-ADV genuine issuer signing failure rolls rotation and replay admission back',async()=>{
  const f=await paired(),input=await refreshInput(f),before=await snapshot(f),original=crypto.subtle.sign.bind(crypto.subtle);
  crypto.subtle.sign=(async(...args:Parameters<SubtleCrypto['sign']>)=>{
    if(Buffer.from(args[2] as ArrayBuffer).toString().startsWith(encode({alg:'ES256',typ:'freedom-bootstrap+jwt',kid:bootstrap.keys[0].kid})+'.'))throw Error('PRIVATE_SIGN_FAULT');
    return original(...args);
  }) as SubtleCrypto['sign'];
  try{await assert.rejects(sessions.refresh(input),error=>status(401,503)(error)&&!JSON.stringify(error).includes('PRIVATE_SIGN_FAULT'));}
  finally{crypto.subtle.sign=original;}
  assert.deepEqual(await snapshot(f),before);assert.equal((await sessions.refresh(input)).refresh.generation,'2');
});

const rotationSinks = [ ['bootstrap_refresh_generations','UPDATE'], ['bootstrap_refresh_generations','INSERT'],
  ['bootstrap_refresh_families','UPDATE'], ['bootstrap_session_proofs','INSERT'] ] as const;
const nonceSinks = [['bootstrap_nonces','INSERT'],['bootstrap_session_proofs','INSERT']] as const;
const revokeSinks = [['bootstrap_refresh_families','UPDATE'],['agent_connections','UPDATE']] as const;
for(const operation of ['refresh','nonce','reuse'] as const) for(const [table,event] of operation==='refresh'?rotationSinks:operation==='nonce'?nonceSinks:revokeSinks)
test(`SESSION-ADV ${operation} ${table} ${event} failure atomically rolls back and preserves retry`,async()=>{
  const f=await paired(), refresh=await refreshInput(f);
  if(operation==='reuse')await sessions.refresh(refresh);
  const input=operation==='nonce'?await nonceInput(f):refresh, before=await snapshot(f);
  await owner.query("CREATE FUNCTION session_sink_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE_SESSION_FAULT'; END $$");
  await owner.query(`CREATE TRIGGER session_sink_fault AFTER ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION session_sink_fault()`);
  const invoke=()=>operation==='nonce'?sessions.nonce(input as Awaited<ReturnType<typeof nonceInput>>):sessions.refresh(input as Awaited<ReturnType<typeof refreshInput>>);
  try{await assert.rejects(invoke(),error=>status(503)(error)&&!JSON.stringify(error).includes('PRIVATE_SESSION_FAULT'));}
  finally{await owner.query(`DROP TRIGGER session_sink_fault ON ${table}`);await owner.query('DROP FUNCTION session_sink_fault()');}
  assert.deepEqual(await snapshot(f),before);
  if(operation==='reuse'){await assert.rejects(invoke(),status(401));await assertRevoked(f);}else assert.ok(await invoke());
});

for(const table of ['bootstrap_refresh_families','bootstrap_refresh_generations']) test(`SESSION-ADV initial device ${table} sink failure preserves the genuine unspent exchange`,async()=>{
  const f=await approved(), input={...await pollInput(f),enrollmentProof:f.enrollmentProof};
  await owner.query("CREATE FUNCTION initial_session_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE_INITIAL_FAULT'; END $$");
  await owner.query(`CREATE TRIGGER initial_session_fault AFTER INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION initial_session_fault()`);
  try{await assert.rejects(api.poll(input),status(503));}
  finally{await owner.query(`DROP TRIGGER initial_session_fault ON ${table}`);await owner.query('DROP FUNCTION initial_session_fault()');}
  assert.equal((await owner.query('SELECT state FROM device_authorizations WHERE authorization_id=$1',[f.authorization.authorizationId])).rows[0].state,'approved');
  for(const target of ['agent_connections','bootstrap_nonces','runtime_registrations'])
    assert.equal((await owner.query(`SELECT count(*)::int n FROM ${target} WHERE owner_user_id=$1`,[f.actor.user_id])).rows[0].n,0);
  assert.equal((await api.poll(input)).status,'issued');
});

for(const operation of ['refresh','nonce'] as const) test(`SESSION-ADV ${operation} final storage lock crossing proof expiry rolls every sink back`,async()=>{
  const f=await paired(), iat=Math.floor(await dbNow()/1000)-59;
  const input=operation==='refresh'?await refreshInput(f,f.issued.refresh,{iat}):await nonceInput(f,f.issued.accessToken,{iat});
  const before=await snapshot(f),holder=await owner.connect(),lock=819031;
  await holder.query('BEGIN');await holder.query('SELECT pg_advisory_xact_lock($1)',[lock]);
  await owner.query(`CREATE FUNCTION session_final_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${lock}); RETURN NULL; END $$`);
  const target=operation==='refresh'?'bootstrap_refresh_families':'bootstrap_nonces',event=operation==='refresh'?'UPDATE':'INSERT';
  await owner.query(`CREATE TRIGGER zz_session_final_barrier AFTER ${event} ON ${target} FOR EACH ROW EXECUTE FUNCTION session_final_barrier()`);
  const outcome=(operation==='refresh'?sessions.refresh(input as Awaited<ReturnType<typeof refreshInput>>):sessions.nonce(input as Awaited<ReturnType<typeof nonceInput>>))
    .then(value=>({value,error:null}),error=>({value:null,error}));
  try{await blocking(holder);await waitUntil((iat+61)*1000);}finally{await holder.query('COMMIT');holder.release();}
  try{assert.ok(status(401)((await outcome).error));}
  finally{await owner.query(`DROP TRIGGER zz_session_final_barrier ON ${target}`);await owner.query('DROP FUNCTION session_final_barrier()');}
  assert.deepEqual(await snapshot(f),before);
});

test('SESSION-ADV genuine refresh issuer sign await crossing proof expiry rolls rotation back',async()=>{
  const f=await paired(),iat=Math.floor(await dbNow()/1000)-59,input=await refreshInput(f,f.issued.refresh,{iat}),before=await snapshot(f);
  const original=crypto.subtle.sign.bind(crypto.subtle);let reached!:()=>void,release!:()=>void;
  const arrived=new Promise<void>(resolve=>{reached=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  crypto.subtle.sign=(async(...args:Parameters<SubtleCrypto['sign']>)=>{const result=await original(...args);
    if(Buffer.from(args[2] as ArrayBuffer).toString().startsWith(encode({alg:'ES256',typ:'freedom-bootstrap+jwt',kid:bootstrap.keys[0].kid})+'.')){reached();await gate;}return result;
  }) as SubtleCrypto['sign'];
  const outcome=sessions.refresh(input).then(value=>({value,error:null}),error=>({value:null,error}));
  try{await Promise.race([arrived,delay(3000).then(()=>assert.fail('Actual issuer signing barrier not reached'))]);await waitUntil((iat+61)*1000);release();assert.ok(status(401)((await outcome).error));}
  finally{release();crypto.subtle.sign=original;await outcome;}
  assert.deepEqual(await snapshot(f),before);assert.ok(await sessions.refresh(await refreshInput(f)));
});

test('SESSION-ADV runtime LOGIN cannot DDL, delete, rebind, extend, consume a head alone or revoke family alone',async()=>{
  const f=await paired(),before=await snapshot(f);
  await assert.rejects(app.query('CREATE TABLE session_unauthorized_ddl(id integer)'),sqlCode('42501'));
  await assert.rejects(app.query('ALTER TABLE bootstrap_refresh_families DISABLE TRIGGER ALL'),sqlCode('42501'));
  const probes=[
    ['DELETE FROM bootstrap_refresh_generations WHERE family_id=$1',[f.issued.refresh.familyId]],
    ['UPDATE bootstrap_refresh_families SET connection_id=$2 WHERE family_id=$1',[f.issued.refresh.familyId,randomUUID()]],
    ["UPDATE bootstrap_refresh_families SET expires_at=expires_at+interval '1 second' WHERE family_id=$1",[f.issued.refresh.familyId]],
    ["UPDATE bootstrap_refresh_generations SET consumed_at=date_trunc('milliseconds',clock_timestamp()) WHERE family_id=$1",[f.issued.refresh.familyId]],
    ['UPDATE bootstrap_refresh_families SET current_generation=2 WHERE family_id=$1',[f.issued.refresh.familyId]],
    ["UPDATE bootstrap_refresh_families SET state='revoked',revoked_at=date_trunc('milliseconds',clock_timestamp()),revocation_reason='refresh_reuse' WHERE family_id=$1",[f.issued.refresh.familyId]],
  ] as const;
  for(const [sql,params] of probes){const q=await app.connect();await q.query('BEGIN');
    try{await assert.rejects(async()=>{await q.query(sql,[...params]);await q.query('COMMIT');},sqlCode('23514','42501','23503'));}
    finally{await q.query('ROLLBACK');q.release();}}
  assert.deepEqual(await snapshot(f),before);
});

test('SESSION-ADV expired original nonce can be reacquired without old nonce or member cookie',async()=>{
  await owner.query("CREATE FUNCTION short_initial_nonce() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.expires_at:=NEW.issued_at+interval '1 second'; RETURN NEW; END $$");
  await owner.query('CREATE TRIGGER aaa_short_initial_nonce BEFORE INSERT ON bootstrap_nonces FOR EACH ROW EXECUTE FUNCTION short_initial_nonce()');
  let f:Paired;
  try{f=await paired();}finally{await owner.query('DROP TRIGGER aaa_short_initial_nonce ON bootstrap_nonces');await owner.query('DROP FUNCTION short_initial_nonce()');}
  const expiry=(await owner.query('SELECT expires_at FROM bootstrap_nonces WHERE nonce_id=$1',[f.issued.nonce.nonceId])).rows[0].expires_at;
  await waitUntil(expiry.getTime());
  await owner.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[f.actor.session_hash]);
  await assert.rejects(readStatus(f,f.issued.accessToken,f.issued.nonce),status(401));
  const acquired=await sessions.nonce(await nonceInput(f));
  assert.equal((await readStatus(f,f.issued.accessToken,acquired)).operation,'bootstrap.status.read');
});

test('SESSION-ADV an actually expired constrained-issuer access token does not prevent refresh recovery',async()=>{
  const f=await paired(),claims=JSON.parse(Buffer.from(f.issued.accessToken.split('.')[1],'base64url').toString());
  const signingKey=await crypto.subtle.importKey('jwk',issuer.privateKey.export({format:'jwk'}),{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
  const shortIssuer=await createBootstrapTokenIssuer({host:bootstrap,kid:bootstrap.keys[0].kid,signingKey});
  const current=await dbNow(),short=await shortIssuer.issue({binding:{ownerUserId:claims.owner_user_id,principalId:claims.sub,scopeId:claims.scope_id,
    runtimeDeviceId:claims.runtime_device_id,connectionId:claims.connection_id,connectionVersion:claims.connection_version,keyThumbprint:claims.cnf.jkt},
    nowMs:current,notAfterMs:current+2100});
  assert.ok(short);await waitUntil(short.expiresAt*1000);
  await assert.rejects(sessions.nonce(await nonceInput(f,short.accessToken)),status(401));
  const next=await sessions.refresh(await refreshInput(f));
  const acquired=await sessions.nonce(await nonceInput(f,next.accessToken));assert.equal((await readStatus(f,next.accessToken,acquired)).operation,'bootstrap.status.read');
});

test('SESSION-ADV expired shorter family rejects refresh and nonce even with live connection and token',async()=>{
  await owner.query("CREATE FUNCTION short_initial_family() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.expires_at:=NEW.issued_at+interval '1 second'; RETURN NEW; END $$");
  await owner.query('CREATE TRIGGER aaa_short_initial_family BEFORE INSERT ON bootstrap_refresh_families FOR EACH ROW EXECUTE FUNCTION short_initial_family()');
  let f:Paired;
  try{f=await paired();}finally{await owner.query('DROP TRIGGER aaa_short_initial_family ON bootstrap_refresh_families');await owner.query('DROP FUNCTION short_initial_family()');}
  const expiry=(await owner.query('SELECT expires_at FROM bootstrap_refresh_families WHERE family_id=$1',[f.issued.refresh.familyId])).rows[0].expires_at;
  await waitUntil(expiry.getTime());const before=await snapshot(f);
  await assert.rejects(sessions.refresh(await refreshInput(f)),status(401));
  await assert.rejects(sessions.nonce(await nonceInput(f)),status(401));
  assert.deepEqual(await snapshot(f),before);
});

test('SESSION-SQL physical backing cannot be replaced with TEMP connection or generation rows',async()=>{
  const f=await paired(),q=await app.connect();await q.query('BEGIN');
  try{
    await q.query(`CREATE TEMP TABLE agent_connections AS SELECT * FROM ${schema}.agent_connections`);
    await q.query('UPDATE pg_temp.agent_connections SET runtime_device_id=$1 WHERE connection_id=$2',[randomUUID(),f.issued.connectionId]);
    const falseRuntime=(await q.query('SELECT runtime_device_id FROM pg_temp.agent_connections WHERE connection_id=$1',[f.issued.connectionId])).rows[0].runtime_device_id;
    await assert.rejects(q.query(`INSERT INTO ${schema}.bootstrap_session_proofs(connection_id,runtime_device_id,operation,proof_jti,accepted_at)
      VALUES($1,$2,'nonce',$3,date_trunc('milliseconds',clock_timestamp()))`,[f.issued.connectionId,falseRuntime,randomUUID()]),sqlCode('23514','23503'));
  }finally{await q.query('ROLLBACK');q.release();}
  const probe=await app.connect();await probe.query('BEGIN');
  try{
    await probe.query(`CREATE TEMP TABLE bootstrap_refresh_generations AS SELECT * FROM ${schema}.bootstrap_refresh_generations`);
    await probe.query('UPDATE pg_temp.bootstrap_refresh_generations SET consumed_at=date_trunc(\'milliseconds\',clock_timestamp()) WHERE family_id=$1',[f.issued.refresh.familyId]);
    await assert.rejects(probe.query(`INSERT INTO ${schema}.bootstrap_refresh_generations(family_id,generation,parent_generation,handle_hash,handle_wire_hash,issued_at)
      VALUES($1,2,1,$2,$3,date_trunc('milliseconds',clock_timestamp()))`,[f.issued.refresh.familyId,createHash('sha256').update(randomUUID()).digest('hex'),hash(randomUUID())]),sqlCode('23514','23505'));
  }finally{await probe.query('ROLLBACK');probe.release();}
});

test('SESSION-SQL concurrent initial family insertion and connection revocation cannot commit split terminal state',async()=>{
  // Explicit structural probe on a genuine legacy-style member connection;
  // these direct SQL credentials are not an untrusted HTTP entrypoint.
  const f=await paired(),legacy=await createAgentConnections(app,{environment:'local',clientId:'synthetic-legacy'})
    .create(f.actor,{key:randomUUID(),runtimeDeviceId:f.issued.runtimeDeviceId});
  const familyId=randomUUID(),creator=await app.connect(),revoker=await app.connect();
  await creator.query('BEGIN');await revoker.query('BEGIN');
  try{
    const row=(await creator.query("INSERT INTO bootstrap_refresh_families(family_id,connection_id,issued_at,expires_at) SELECT $1,connection_id,date_trunc('milliseconds',clock_timestamp()),expires_at FROM agent_connections WHERE connection_id=$2 RETURNING issued_at",[familyId,legacy.connectionId])).rows[0];
    await creator.query('INSERT INTO bootstrap_refresh_generations(family_id,generation,handle_hash,handle_wire_hash,issued_at) VALUES($1,1,$2,$3,$4)',
      [familyId,createHash('sha256').update(randomUUID()).digest('hex'),hash(randomUUID()),row.issued_at]);
    const pid=(await revoker.query('SELECT pg_backend_pid() pid')).rows[0].pid;let completed=false;
    const update=revoker.query("UPDATE agent_connections SET state='revoked',revoked_at=date_trunc('milliseconds',clock_timestamp()),aggregate_version=aggregate_version+1 WHERE connection_id=$1",[legacy.connectionId])
      .then(value=>{completed=true;return value;});
    // Original migration permits UPDATE to finish before creator commit;
    // corrected migration serializes UPDATE behind creator's backing lock.
    let observed=false;
    for(let attempt=0;attempt<300;attempt++){
      if(completed||(await admin.query('SELECT cardinality(pg_blocking_pids($1))>0 blocked',[pid])).rows[0].blocked){observed=true;break;}
      await delay(10);
    }
    assert.ok(observed,'Actual update completion or lock wait required');
    await creator.query('COMMIT');await update;await revoker.query('COMMIT');
    assert.deepEqual((await owner.query('SELECT f.state family,c.state connection FROM bootstrap_refresh_families f JOIN agent_connections c USING(connection_id) WHERE family_id=$1',[familyId])).rows[0],
      {family:'revoked',connection:'revoked'});
  }finally{await creator.query('ROLLBACK');await revoker.query('ROLLBACK');creator.release();revoker.release();}
});

for(const [generation,parent] of [['2',null],['3','1'],['2','2'],['4097','4096']] as const)
test(`SESSION-SQL cannot fork or skip to generation ${generation} with parent ${parent}`,async()=>{
  const f=await paired(),q=await app.connect();await q.query('BEGIN');
  try{await assert.rejects(q.query(`INSERT INTO bootstrap_refresh_generations(family_id,generation,parent_generation,handle_hash,handle_wire_hash,issued_at)
    VALUES($1,$2,$3,$4,$5,date_trunc('milliseconds',clock_timestamp()))`,[f.issued.refresh.familyId,generation,parent,createHash('sha256').update(randomUUID()).digest('hex'),hash(randomUUID())]),sqlCode('23514','23503','23505'));}
  finally{await q.query('ROLLBACK');q.release();}
});

test('SESSION-ADV pending nonce capacity serializes concurrent calls and rejected admission preserves JTI',async()=>{
  const f=await paired();for(let i=0;i<6;i++)await sessions.nonce(await nonceInput(f));
  const inputs=await Promise.all([nonceInput(f),nonceInput(f)]),results=await Promise.allSettled(inputs.map(v=>sessions.nonce(v)));
  assert.equal(results.filter(v=>v.status==='fulfilled').length,1);
  assert.equal(results.filter(v=>v.status==='rejected'&&status(401)(v.reason)).length,1);
  assert.equal((await owner.query('SELECT count(*)::int n FROM bootstrap_nonces WHERE connection_id=$1',[f.issued.connectionId])).rows[0].n,8);
  const loser=results.findIndex(v=>v.status==='rejected');await readStatus(f,f.issued.accessToken,f.issued.nonce);
  assert.ok(await sessions.nonce(inputs[loser]));
});

// Large quota fixtures use trusted direct SQL with every structural trigger
// enabled; only the boundary admission is a genuine signed service request.
test('SESSION-ADV spent reuse takes precedence over exhausted session ledger capacity',async()=>{
  const f=await paired(),input=await refreshInput(f);await sessions.refresh(input);
  await owner.query(`INSERT INTO bootstrap_session_proofs(connection_id,runtime_device_id,operation,proof_jti,accepted_at)
    SELECT $1,$2,'nonce','synthetic_quota_'||lpad(i::text,10,'0'),date_trunc('milliseconds',clock_timestamp()) FROM generate_series(1,8191) i`,[f.issued.connectionId,f.issued.runtimeDeviceId]);
  await assert.rejects(sessions.refresh(input),status(401));await assertRevoked(f);
});

test('SESSION-ADV nonce lifetime capacity is retained after consumption',async()=>{
  const f=await paired();
  await owner.query(`INSERT INTO bootstrap_nonces(nonce_id,connection_id,runtime_device_id,owner_user_id,owner_principal_id,scope_id,environment,client_id,connection_version,challenge_key,nonce,issued_at,expires_at)
    SELECT gen_random_uuid(),connection_id,runtime_device_id,owner_user_id,owner_principal_id,scope_id,environment,client_id,connection_version,
      'synthetic_lifetime_'||i,translate(rtrim(encode(sha256(i::text::bytea),'base64'),'='),'+/','-_'),date_trunc('milliseconds',clock_timestamp()),date_trunc('milliseconds',clock_timestamp())+interval '59 seconds'
      FROM bootstrap_nonces CROSS JOIN generate_series(1,4095) i WHERE nonce_id=$1`,[f.issued.nonce.nonceId]);
  await owner.query("UPDATE bootstrap_nonces SET consumed_at=date_trunc('milliseconds',clock_timestamp()),proof_jti='quota_proof_'||nonce_id::text,token_jti='quota_token_'||nonce_id::text WHERE connection_id=$1 AND challenge_key LIKE 'synthetic_lifetime_%'",[f.issued.connectionId]);
  const before=await snapshot(f);await assert.rejects(sessions.nonce(await nonceInput(f)),status(401));assert.deepEqual(await snapshot(f),before);
});

test('SESSION-ADV session proof lifetime quota serializes independent concurrent nonce requests',async()=>{
  const f=await paired();
  await owner.query(`INSERT INTO bootstrap_session_proofs(connection_id,runtime_device_id,operation,proof_jti,accepted_at)
    SELECT $1,$2,'nonce','synthetic_quota_'||lpad(i::text,10,'0'),date_trunc('milliseconds',clock_timestamp()) FROM generate_series(1,8191) i`,[f.issued.connectionId,f.issued.runtimeDeviceId]);
  const inputs=await Promise.all([nonceInput(f),nonceInput(f)]),results=await Promise.allSettled(inputs.map(input=>sessions.nonce(input)));
  assert.equal(results.filter(v=>v.status==='fulfilled').length,1);
  assert.equal(results.filter(v=>v.status==='rejected'&&status(401)(v.reason)).length,1);
  assert.equal((await owner.query('SELECT count(*)::int n FROM bootstrap_session_proofs WHERE connection_id=$1',[f.issued.connectionId])).rows[0].n,8192);
});

test('SESSION-ADV generation 4096 is terminal capacity but spent generation one still revokes',async()=>{
  const f=await paired(),terminalHandle=hash(randomUUID()),terminalHash=createHash('sha256').update(JSON.stringify(['freedom.bootstrap-refresh/v1','handle',terminalHandle])).digest('hex');
  const q=await owner.connect();await q.query('BEGIN');
  try{
    await q.query("SET LOCAL statement_timeout='60s'");
    await q.query('SELECT set_config(\'test.family\',$1,true),set_config(\'test.handle\',$2,true),set_config(\'test.wire\',$3,true)',[f.issued.refresh.familyId,terminalHash,hash(terminalHandle)]);
    await q.query(`DO $$ DECLARE i integer; stamp timestamptz; fid uuid:=current_setting('test.family')::uuid; BEGIN
      FOR i IN 2..4096 LOOP
        stamp:=date_trunc('milliseconds',clock_timestamp());
        UPDATE bootstrap_refresh_generations SET consumed_at=stamp WHERE family_id=fid AND generation=i-1;
        INSERT INTO bootstrap_refresh_generations(family_id,generation,parent_generation,handle_hash,handle_wire_hash,issued_at)
          VALUES(fid,i,i-1,CASE WHEN i=4096 THEN current_setting('test.handle') ELSE encode(sha256((fid::text||i::text)::bytea),'hex') END,
            CASE WHEN i=4096 THEN current_setting('test.wire') ELSE translate(rtrim(encode(sha256((fid::text||i::text)::bytea),'base64'),'='),'+/','-_') END,stamp);
        UPDATE bootstrap_refresh_families SET current_generation=i WHERE family_id=fid;
      END LOOP;
    END $$`);
    await q.query('COMMIT');
  }finally{await q.query('ROLLBACK');q.release();}
  const before=await snapshot(f);
  await assert.rejects(sessions.refresh(await refreshInput(f,{...f.issued.refresh,generation:'4096',handle:terminalHandle})),status(401));
  assert.deepEqual(await snapshot(f),before);
  await assert.rejects(sessions.refresh(await refreshInput(f)),status(401));await assertRevoked(f);
});

// Owner-installed corruption probes exercise SQL invariants using actual runtime
// writes and native proofs. They are structural checks, not an HTTP bypass claim.
for(const [table,column,event] of [ ['bootstrap_refresh_families','issued_at','INSERT'],
  ['bootstrap_refresh_families','expires_at','INSERT'],['bootstrap_refresh_generations','issued_at','INSERT'],
  ['bootstrap_refresh_generations','consumed_at','UPDATE'],['bootstrap_session_proofs','accepted_at','INSERT'] ] as const)
for(const value of ['NULL',`NEW.${column} + interval '0.000001 second'`]) test(`SESSION-SQL-TIME ${table}.${column} rejects ${value==='NULL'?'NULL':'submillisecond'}`,async()=>{
  const f=await approved();
  const initial=event==='UPDATE'||table==='bootstrap_session_proofs'?await api.poll({...await pollInput(f),enrollmentProof:f.enrollmentProof}):null;
  if(initial)assert.equal(initial.status,'issued');
  await owner.query(`CREATE FUNCTION session_time_corruption() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.${column}:=${value}; RETURN NEW; END $$`);
  await owner.query(`CREATE TRIGGER aaa_session_time_corruption BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION session_time_corruption()`);
  try{
    if(initial?.status==='issued') await assert.rejects(sessions.refresh(await refreshInput({...f,issued:initial})),status(401,503));
    else await assert.rejects(api.poll({...await pollInput(f),enrollmentProof:f.enrollmentProof}),status(401,503));
  }finally{await owner.query(`DROP TRIGGER aaa_session_time_corruption ON ${table}`);await owner.query('DROP FUNCTION session_time_corruption()');}
});

for(const value of ['NULL',"NEW.revoked_at + interval '0.000001 second'"])
test(`SESSION-SQL-TIME family revocation rejects ${value==='NULL'?'NULL':'submillisecond'} time atomically`,async()=>{
  const f=await paired(),input=await refreshInput(f);await sessions.refresh(input);const before=await snapshot(f);
  await owner.query(`CREATE FUNCTION revoke_time_corruption() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='revoked' THEN NEW.revoked_at:=${value}; END IF; RETURN NEW; END $$`);
  await owner.query('CREATE TRIGGER aaa_revoke_time_corruption BEFORE UPDATE ON bootstrap_refresh_families FOR EACH ROW EXECUTE FUNCTION revoke_time_corruption()');
  try{await assert.rejects(sessions.refresh(input),status(401,503));}
  finally{await owner.query('DROP TRIGGER aaa_revoke_time_corruption ON bootstrap_refresh_families');await owner.query('DROP FUNCTION revoke_time_corruption()');}
  assert.deepEqual(await snapshot(f),before);await assert.rejects(sessions.refresh(input),status(401));await assertRevoked(f);
});
