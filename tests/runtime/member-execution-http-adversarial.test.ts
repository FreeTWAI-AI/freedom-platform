import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CompactSign, exportJWK, generateKeyPair } from 'jose';
import { Hono } from 'hono';
import { Pool, type PoolClient } from 'pg';
import { migrate } from '../../scripts/database.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import { tokenHash, type Actor } from '../../modules/identity-membership/service.js';
import { createDeviceAuthorizations } from '../../modules/agent-control/device-authorizations.js';
import { createRuntimeRegistrationChallenge, parseRuntimePublicJwk } from '../../modules/agent-control/runtime-proof.js';
import { createExecutionRuns } from '../../modules/agent-execution/runs.js';
import { createExecutionPrerequisites } from '../../modules/agent-execution/prerequisites.js';
import { createMemberExecutionHttpTransport } from '../../apps/platform-api/src/routes/member-execution-http.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import type { PlatformEnv } from '../../apps/platform-api/src/module-context.js';
import { ModelConnectionMetadataSchema, ExecutionGrantMetadataSchema, ExecutionAttemptMetadataSchema,
  type ModelSelection } from '../../contracts/execution/v1/member-execution.js';
import type { DeviceAuthorizationHost } from '../../contracts/execution/v1/device-pairing.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname))
  throw new Error('Member execution HTTP adversarial tests require an explicit disposable fp_* TEST_DATABASE_URL.');
const schema = `fp_exec_http_adv_${process.pid}_${Date.now()}`, migrator = `${schema}_owner`, runtime = `${schema}_app`;
const admin = new Pool({ connectionString });
function roleUrl(role: string) { const url = new URL(connectionString!); url.username = role; url.password = ''; return url.toString(); }
const owner = new Pool({ connectionString: roleUrl(migrator), options: `-c search_path=${schema} -c statement_timeout=10000`, max: 8 });
const appPool = new Pool({ connectionString: roleUrl(runtime), options: `-c search_path=${schema} -c statement_timeout=10000`, max: 12 });
const origin = 'http://127.0.0.1:4310', prefix = '/api/v1/me', clientId = 'member-http-independent-review';
const options = { origin, environment: 'local' as const, clientId };
const paths = { runs: prefix + '/execution-runs', models: prefix + '/model-connections', grants: prefix + '/execution-grants', attempts: prefix + '/execution-attempts' };
const selection: ModelSelection = { providerRef: 'synthetic-provider', modelRef: 'synthetic-text-model', processingLocation: 'provider_remote',
  artifactCustody: 'platform_asset', credentialCustody: 'official_cli', engineLocation: 'runtime_local', billingSource: 'user_cli' };
const services = createExecutionPrerequisites(appPool, { environment: options.environment, clientId }), runs = createExecutionRuns(appPool);
let created = false, pairing: Awaited<ReturnType<typeof createDeviceAuthorizations>>, pairingHost: DeviceAuthorizationHost;
type Transport = Awaited<ReturnType<typeof createMemberExecutionHttpTransport>>;
type RequestApp = Pick<Transport, 'request'>;

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
  const issuer = await generateKeyPair('ES256');
  pairingHost = { environment: options.environment, clientId, issuerKid: 'synthetic-issuer',
    issuer: 'https://issuer.example.invalid/', audience: 'https://platform.example.invalid/', bootstrapUri: 'https://platform.example.invalid/execution-api/v1/bootstrap',
    beginUri: 'https://platform.example.invalid/device/begin', pollUri: 'https://platform.example.invalid/device/poll',
    verificationUri: 'https://platform.example.invalid/device', clientDisplayName: 'Synthetic independent HTTP device',
    keys: [{ kid: 'synthetic-issuer', purpose: 'bootstrap_access', environment: 'local',
      publicJwk: parseRuntimePublicJwk(await exportJWK(issuer.publicKey)), notBeforeMs: 0, notAfterMs: Number.MAX_SAFE_INTEGER, revoked: false }] };
  pairing = await createDeviceAuthorizations(appPool, { host: pairingHost, signingKey: issuer.privateKey });
});
after(async () => {
  await appPool.end(); await owner.end();
  try { if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE; DROP ROLE ${runtime},${migrator}`); }
  finally { await admin.end(); }
});
async function dbNow() { return Number((await owner.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text ms')).rows[0].ms); }
async function blockedBy(holder: PoolClient) {
  const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  for (let i = 0; i < 300; i++) {
    if ((await admin.query('SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND usename=$2', [pid, runtime])).rows[0].n) return;
    await delay(10);
  }
  assert.fail('The actual HTTP domain transaction did not enter the expected PostgreSQL lock wait');
}
async function waitUntil(ms: number) {
  for (let i = 0; i < 600; i++) { if (await dbNow() >= ms) return; await delay(10); }
  assert.fail('PostgreSQL clock did not reach the real expiry');
}
async function member() {
  const user = randomUUID(), community = randomUUID(), token = randomBytes(32).toString('base64url'), csrf = randomBytes(24).toString('base64url');
  await owner.query("INSERT INTO communities VALUES($1,'Synthetic independent execution HTTP')", [community]);
  const row = (await owner.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'PRIVATE_HTTP_MEMBER','not-a-login',$4) RETURNING *`, [user, community, user + '@example.invalid', randomUUID()])).rows[0];
  const session = tokenHash(token);
  await owner.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')", [session, user, csrf]);
  const actor: Actor = { ...row, session_hash: session, csrf_token: csrf };
  const context = await withMemberScope(appPool, { actor, scope: 'personal' }, async () => {}, async (_q, c) => c);
  return { actor, context, cookie: 'freedom_local_session=' + token };
}
type Member = Awaited<ReturnType<typeof member>>;
async function paired(human: Member) {
  const device = await generateKeyPair('ES256'), publicJwk = parseRuntimePublicJwk(await exportJWK(device.publicKey));
  const sign = (claims: Record<string, unknown>) => new CompactSign(new TextEncoder().encode(JSON.stringify(claims)))
    .setProtectedHeader({ alg: 'ES256', typ: 'freedom-device-pairing+jwt', jwk: publicJwk }).sign(device.privateKey);
  const base = { client_id: clientId, environment: 'local', runtime_kind: 'agent-kit', scope: 'bootstrap.status.read', htm: 'POST' };
  const started = await pairing.begin({ publicJwk, runtimeKind: 'agent-kit', proof: await sign({ ...base, purpose: 'device_pairing_begin', jti: randomUUID(),
    iat: Math.floor(await dbNow()/1000), htu: pairingHost.beginUri }) });
  await pairing.decide(human.actor, { key: randomUUID(), userCode: started.userCode, authorizationId: started.authorizationId,
    requestDigest: started.requestDigest, decision: 'approve' });
  // Dedicated owner session reads only this synthetic challenge, avoiding the
  // five-second initial poll. Real ES256 enrollment/exchange creates 091 family.
  const row = (await owner.query(`SELECT c.* FROM runtime_registration_challenges c JOIN device_authorizations a USING(challenge_id)
    WHERE a.authorization_id=$1`, [started.authorizationId])).rows[0];
  const challenge = createRuntimeRegistrationChallenge({ challenge_id: row.challenge_id, runtime_device_id: row.runtime_device_id,
    owner_member_id: row.owner_user_id, owner_principal_id: row.owner_principal_id, scope_id: row.scope_id, environment: row.environment,
    key_thumbprint: row.key_thumbprint, nonce: row.nonce, issued_at: row.issued_at.toISOString(), expires_at: row.expires_at.toISOString() });
  const enrollmentProof = await new CompactSign(new TextEncoder().encode(challenge.payload))
    .setProtectedHeader({ alg: 'ES256', typ: 'freedom-runtime-enrollment+jws' }).sign(device.privateKey);
  const initial = await pairing.poll({ authorizationId: started.authorizationId, deviceCode: started.deviceCode, enrollmentProof,
    proof: await sign({ ...base, purpose: 'device_pairing_poll', jti: randomUUID(), iat: Math.floor(await dbNow()/1000), htu: pairingHost.pollUri,
      authorization_id: started.authorizationId, request_digest: started.requestDigest, nonce: started.nonce,
      device_code_hash: createHash('sha256').update(started.deviceCode, 'ascii').digest('base64url') }) });
  assert.equal(initial.status, 'issued'); if (initial.status !== 'issued') throw new Error('Real paired device and refresh family required');
  return { initial, enrollmentProof };
}
type SendOptions = { method?: string; body?: unknown; raw?: string|Uint8Array|ReadableStream<Uint8Array>; signal?: AbortSignal;
  headers?: Record<string, string|undefined> };
async function send(transport: RequestApp, route: string, human?: Member, input: SendOptions = {}) {
  const method = input.method ?? (input.body !== undefined || input.raw !== undefined ? 'POST' : 'GET');
  const headers = new Headers({ Origin: origin, ...(human ? { Cookie: human.cookie, 'X-CSRF-Token': human.actor.csrf_token } : {}),
    ...(!['GET', 'HEAD'].includes(method) ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), 'If-Match': '"1"' } : {}) });
  for (const [key, value] of Object.entries(input.headers ?? {})) value === undefined ? headers.delete(key) : headers.set(key, value);
  const request = new Request(route.startsWith('http') ? route : origin + route, { method, headers, signal: input.signal,
    body: (input.raw ?? (input.body === undefined ? undefined : JSON.stringify(input.body))) as BodyInit|undefined,
    duplex: 'half' } as RequestInit);
  const response = await transport.request(request), text = await response.text();
  assert.match(response.headers.get('Cache-Control') ?? '', /no-store/, `${method} ${route} status ${response.status}`);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  return { response, text, status: response.status, data: text ? JSON.parse(text) as Record<string, unknown> : null };
}
type Reply = Awaited<ReturnType<typeof send>>;
function failure(reply: Reply, ...codes: number[]) {
  assert.ok(codes.includes(reply.status), `Expected ${codes.join('/')} but got ${reply.status}: ${reply.text}`);
  assert.equal(reply.response.headers.get('ETag'), null);
  assert.equal(reply.response.headers.get('Access-Control-Allow-Origin'), null);
  if (reply.text) {
    assert.deepEqual(Object.keys(reply.data!).sort(), ['code', 'detail', 'status', 'title', 'type']);
    assert.equal(reply.data!.status, reply.status); assert.equal(reply.data!.type, 'about:blank');
    for (const secret of ['PRIVATE_HTTP_', 'synthetic-secret', 'password_hash', 'session_hash', 'SELECT ', 'INSERT ', 'stack', 'node_modules'])
      assert.ok(!reply.text.includes(secret), `Safe failure leaked ${secret}`);
  }
}
async function fixture(grantTtlSeconds?: number) {
  const human = await member(), device = await paired(human), workId = randomUUID(), network = 'synthetic-' + randomUUID();
  await owner.query(`INSERT INTO work_items(work_item_id,work_mode,scope_id,owner_principal_id,owner_ref,title,objective,state,participation_terms_revision)
    VALUES($1,'personal_execution',$2,$3,$4,'PRIVATE_HTTP_WORK','PRIVATE_HTTP_OBJECTIVE','draft',NULL)`,
  [workId, human.context.scope.scope_id, human.context.subject_principal.principal_id, human.actor.user_id]);
  await owner.query(`INSERT INTO private_work_persistence_policy(scope_id,owner_principal_id,purpose,revision,persistence_allowed,retained_byte_limit)
    VALUES($1,$2,'work.private-draft',1,true,1048576)`, [human.context.scope.scope_id, human.context.subject_principal.principal_id]);
  const transport = await createMemberExecutionHttpTransport(appPool, { ...options, ...(grantTtlSeconds === undefined ? {} : { grantTtlSeconds }), sourceNetwork: () => network });
  const run = await runs.create(human.actor, { key: randomUUID(), workId, expectedWorkVersion: '1' });
  const model = await services.models.create(human.actor, { key: randomUUID(), connectionId: device.initial.connectionId, expectedConnectionVersion: '1', selection });
  const grantBody = { expectedWorkVersion: '1', connectionId: device.initial.connectionId, expectedConnectionVersion: '1',
    modelConnectionId: model.modelConnectionId, expectedModelVersion: '1', consent: true };
  return { ...human, ...device, workId, transport, network, run, model, grantBody };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function snapshot(f: Fixture) {
  const rows: Record<string, unknown> = {};
  for (const table of ['execution_runs', 'model_connections', 'execution_grants', 'execution_attempts', 'scoped_command_receipts', 'scoped_transition_journal', 'scoped_outbox'])
    rows[table] = (await owner.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE scope_id=$1 ORDER BY to_jsonb(t)::text`, [f.context.scope.scope_id])).rows;
  return rows;
}
async function rejectedUnchanged(f: Fixture, action: () => Promise<Reply>, ...codes: number[]) {
  const before = await snapshot(f); const result = await action(); failure(result, ...codes); assert.deepEqual(await snapshot(f), before); return result;
}
async function grant(f: Fixture, headers: SendOptions['headers'] = {}) {
  const result = await send(f.transport, paths.runs + '/' + f.run.runId + '/grants', f, { body: f.grantBody, headers });
  assert.equal(result.status, 201, result.text); return ExecutionGrantMetadataSchema.parse(result.data);
}

test('MEMBER-HTTP-ADV real non-superuser sessions and every exposed operation preserve blocked metadata and exact CAS', async () => {
  for (const [pool, name] of [[owner, migrator], [appPool, runtime]] as const)
    assert.deepEqual((await pool.query('SELECT current_user,session_user,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0],
      { current_user: name, session_user: name, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
  const f = await fixture(), madeRun = await send(f.transport, paths.runs, f, { body: { workId: f.workId } });
  assert.equal(madeRun.status, 201, madeRun.text); assert.equal(madeRun.data!.state, 'created'); assert.equal(madeRun.data!.operational_authority, false);
  assert.equal(madeRun.response.headers.get('ETag'), '"1"');
  const modelReply = await send(f.transport, paths.models, f, { body: { connectionId: f.initial.connectionId, selection } });
  assert.equal(modelReply.status, 201, modelReply.text); const model = ModelConnectionMetadataSchema.parse(modelReply.data);
  assert.equal(model.state, 'unverified'); assert.equal(modelReply.response.headers.get('ETag'), '"1"');
  const consent = await grant(f), attemptReply = await send(f.transport, paths.runs + '/' + f.run.runId + '/attempts', f,
    { body: { grantId: consent.grantId, expectedGrantVersion: '1' } });
  assert.equal(attemptReply.status, 201, attemptReply.text); const attempt = ExecutionAttemptMetadataSchema.parse(attemptReply.data);
  assert.equal(attempt.operational_authority, false); assert.equal(attempt.state, 'preflight_blocked');
  assert.deepEqual(attempt.grant, consent); assert.equal(attempt.grant.familyId, f.initial.refresh.familyId);
  for (const [path, expected] of [[paths.runs + '/' + f.run.runId, f.run], [paths.models + '/' + model.modelConnectionId, model],
    [paths.grants + '/' + consent.grantId, consent], [paths.attempts + '/' + attempt.attemptId, attempt]] as const) {
    const read = await send(f.transport, path, f); assert.equal(read.status, 200, read.text); assert.deepEqual(read.data, expected);
  }
  const pause = await send(f.transport, paths.runs + '/' + f.run.runId + ':pause', f, { body: {} });
  assert.equal(pause.status, 200, pause.text); assert.equal(pause.data!.aggregateVersion, '2'); assert.equal(pause.data!.taskLeaseEpoch, '2');
  const stop = await send(f.transport, paths.runs + '/' + f.run.runId + ':stop', f, { body: {}, headers: { 'If-Match': '"2"' } });
  assert.equal(stop.status, 200, stop.text); assert.equal(stop.data!.state, 'cancelled'); assert.equal(stop.data!.operational_authority, false);
  const modelRevoke = await send(f.transport, paths.models + '/' + model.modelConnectionId + ':revoke', f, { body: {} });
  assert.equal(modelRevoke.status, 200, modelRevoke.text); assert.equal(modelRevoke.data!.state, 'revoked');
  const revoke = await send(f.transport, paths.grants + '/' + consent.grantId + ':revoke', f, { body: {} });
  assert.equal(revoke.status, 200, revoke.text); assert.equal(revoke.data!.aggregateVersion, '2');
  assert.equal((await send(f.transport, paths.attempts + '/' + attempt.attemptId, f)).data!.operational_authority, false);
  assert.equal((await owner.query('SELECT count(*)::int n FROM private_work_results WHERE work_item_id=$1', [f.workId])).rows[0].n, 0);
});

test('MEMBER-HTTP-ADV exact URL authority, Host, Origin and FetchSite reject hostile aliases and browser reads', async () => {
  const f = await fixture(), path = paths.runs + '/' + f.run.runId;
  for (const url of ['http://127.0.0.1:4311' + path, 'http://localhost:4310' + path, 'https://127.0.0.1:4310' + path,
    origin + path + '?modelReady=true', origin + path + '?', origin + path + '#private', origin + path.replace('/me/', '/%6de/'), origin + path + '%2f'])
    await rejectedUnchanged(f, () => send(f.transport, url, f), 403);
  for (const headers of [{ Host: 'attacker.example.invalid' }, { Host: '127.0.0.1:4311' }, { Origin: 'null' },
    { Origin: 'https://attacker.example.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { 'Sec-Fetch-Site': 'none' }])
    await rejectedUnchanged(f, () => send(f.transport, path, f, { headers }), 403);
  await rejectedUnchanged(f, () => send(f.transport, paths.runs, f, { body: { workId: f.workId }, headers: { Origin: undefined } }), 403);
  await rejectedUnchanged(f, () => send(f.transport, 'https://attacker.example.invalid' + path, f,
    { headers: { 'X-Forwarded-Host': '127.0.0.1:4310', 'X-Forwarded-Proto': 'http', 'CF-Connecting-IP': '127.0.0.1' } }), 403);
});

test('MEMBER-HTTP-ADV HEAD, OPTIONS and unsupported methods cannot fall through to reads, controls or response ETags', async () => {
  const f = await fixture(), consent = await grant(f), attempt = ExecutionAttemptMetadataSchema.parse((await send(f.transport,
    paths.runs + '/' + f.run.runId + '/attempts', f, { body: { grantId: consent.grantId, expectedGrantVersion: '1' } })).data);
  for (const route of [paths.runs + '/' + f.run.runId, paths.models + '/' + f.model.modelConnectionId,
    paths.grants + '/' + consent.grantId, paths.attempts + '/' + attempt.attemptId])
    for (const method of ['HEAD', 'OPTIONS', 'POST', 'PUT', 'DELETE']) {
      const result = await rejectedUnchanged(f, () => send(f.transport, route, f, { method, ...(method === 'POST' ? { body: {} } : {}) }), 405);
      assert.equal(result.response.headers.get('Allow'), 'GET');
      if (method === 'HEAD') assert.equal(result.text, '');
    }
  failure(await send(f.transport, paths.runs, f, { method: 'GET' }), 405);
  failure(await send(f.transport, prefix + '/arbitrary-operation', f), 404);
});

test('MEMBER-HTTP-ADV bearer, DPoP and bootstrap credentials never substitute or mix with a member cookie', async () => {
  const f = await fixture(), path = paths.models + '/' + f.model.modelConnectionId;
  for (const authorization of ['Bearer fw_read_synthetic-secret', 'Bearer shop_synthetic-secret', 'DPoP ' + f.initial.accessToken, 'Basic synthetic-secret', ''])
    await rejectedUnchanged(f, () => send(f.transport, path, f, { headers: { Authorization: authorization } }), 403);
  await rejectedUnchanged(f, () => send(f.transport, path, f, { headers: { DPoP: f.enrollmentProof } }), 403);
  for (const header of ['X-Freedom-Connection', 'X-Freedom-Nonce'])
    for (const value of ['', 'synthetic-secret'])
      await rejectedUnchanged(f, () => send(f.transport, path, f, { headers: { [header]: value } }), 403);
  failure(await send(f.transport, path, undefined, { headers: { Authorization: 'DPoP ' + f.initial.accessToken } }), 403);
  failure(await send(f.transport, path, undefined, { headers: { Cookie: 'freedom_local_session=' + f.initial.accessToken } }), 401);
  for (const cookie of [undefined, 'freedom_local_session=bad', 'fw_read=synthetic-secret', 'freedom_local_session=' + randomBytes(32).toString('base64url')])
    failure(await send(f.transport, path, undefined, { headers: { Cookie: cookie } }), 401);
});

test('MEMBER-HTTP-ADV pre-injected Actor, login CSRF and incomplete onboarding do not grant member authority', async () => {
  const f = await fixture(), outsider = await member(), wrapped = new Hono<PlatformEnv>();
  wrapped.use('*', async (c, next) => { c.set('actor', f.actor); await next(); }); wrapped.route('/', f.transport);
  failure(await send(wrapped, paths.models + '/' + f.model.modelConnectionId), 401);
  failure(await send(wrapped, paths.models + '/' + f.model.modelConnectionId, outsider), 404);
  for (const csrf of [undefined, '', outsider.actor.csrf_token, f.actor.csrf_token + 'x'])
    await rejectedUnchanged(f, () => send(f.transport, paths.runs, f, { body: { workId: f.workId }, headers: { 'X-CSRF-Token': csrf } }), 403);
  await owner.query("UPDATE sessions SET csrf_token='' WHERE token_hash=$1", [f.actor.session_hash]);
  await rejectedUnchanged(f, () => send(f.transport, paths.runs, f, { body: { workId: f.workId }, headers: { 'X-CSRF-Token': '' } }), 403);
  await owner.query('UPDATE sessions SET csrf_token=$2 WHERE token_hash=$1', [f.actor.session_hash, f.actor.csrf_token]);
  await owner.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1', [f.actor.user_id]);
  await rejectedUnchanged(f, () => send(f.transport, paths.runs, f, { body: { workId: f.workId } }), 403);
  failure(await send(f.transport, paths.models + '/' + f.model.modelConnectionId, f), 403);
});

test('MEMBER-HTTP-ADV authentication and CSRF happen before a hostile body stream is consumed', async () => {
  const f = await fixture();
  for (const human of [undefined, f]) {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({ pull() { pulled++; throw new Error('synthetic-secret body should not be read'); } }, { highWaterMark: 0 });
    failure(await send(f.transport, paths.runs, human, { raw: stream, ...(human ? { headers: { 'X-CSRF-Token': undefined } } : {}) }), human ? 403 : 401);
    assert.equal(pulled, 0);
  }
});

test('MEMBER-HTTP-ADV primary CAS only accepts one quoted positive signed-bigint header and rejects body/header substitution', async () => {
  const f = await fixture(), path = paths.runs + '/' + f.run.runId + ':pause';
  await rejectedUnchanged(f, () => send(f.transport, path, f, { body: {}, headers: { 'If-Match': undefined } }), 428);
  for (const value of ['1', '*', 'W/"1"', '"01"', '"0"', '"-1"', '"1.0"', '"1e0"', '"1", "2"', '"9223372036854775808"', '"1" extra'])
    await rejectedUnchanged(f, () => send(f.transport, path, f, { body: {}, headers: { 'If-Match': value } }), 400);
  for (const idempotency of [undefined, 'short', 'has spaces', 'x'.repeat(129), 'has,comma'])
    await rejectedUnchanged(f, () => send(f.transport, path, f, { body: {}, headers: { 'Idempotency-Key': idempotency } }), 400);
  for (const body of [{ expectedVersion: '1' }, { key: randomUUID() }, { runId: f.run.runId }, { operational_authority: true }])
    await rejectedUnchanged(f, () => send(f.transport, path, f, { body }), 400, 422);
  await rejectedUnchanged(f, () => send(f.transport, path, f, { body: {}, headers: { 'If-Match': '"9223372036854775807"' } }), 412);
  for (const field of ['expectedWorkVersion', 'expectedConnectionVersion', 'expectedModelVersion'] as const) {
    const body: Partial<typeof f.grantBody> = { ...f.grantBody }; delete body[field];
    await rejectedUnchanged(f, () => send(f.transport, paths.runs + '/' + f.run.runId + '/grants', f, { body }), 400, 422);
  }
});

test('MEMBER-HTTP-ADV nested authority smuggling and duplicate escaped JSON members are rejected without durable effects', async () => {
  const f = await fixture(), path = paths.models, body = { connectionId: f.initial.connectionId, selection };
  for (const extra of [{ ownerUserId: f.actor.user_id }, { actor: f.actor }, { scopeId: f.context.scope.scope_id }, { modelReady: true },
    { state: 'ready' }, { sourceNetwork: 'synthetic-bypass' }, { expectedConnectionVersion: '1' }, { providerKey: 'synthetic-secret' }])
    await rejectedUnchanged(f, () => send(f.transport, path, f, { body: { ...body, ...extra } }), 400, 422);
  for (const extra of [{ modelReady: true }, { apiKey: 'synthetic-secret' }, { fallback: 'platform-key' }, { providerUrl: 'https://attacker.example.invalid' },
    { credentialCustody: 'official_cli', engineLocation: 'platform' }, { billingSource: 'platform' }])
    await rejectedUnchanged(f, () => send(f.transport, path, f, { body: { ...body, selection: { ...selection, ...extra } } }), 400, 422);
  const json = JSON.stringify(body);
  for (const raw of [json.replace('"connectionId":', '"connectionId":"'+randomUUID()+'","connectionId":'),
    json.replace('"modelRef":"synthetic-text-model"', '"modelRef":"synthetic-text-model","\\u006dodelRef":"switched"'),
    json.replace('"providerRef":', '"__proto__":{"modelReady":true},"providerRef":'),
    json.replace('"providerRef":', '"constructor":"synthetic-secret","providerRef":'),
    '{"connectionId":"'+f.initial.connectionId+'","selection":'+ '['.repeat(65)+'{}'+']'.repeat(65)+'}',
    json + '{}', '[' + json + ']', '{"connectionId":"'+f.initial.connectionId+'","selection":null}'])
    await rejectedUnchanged(f, () => send(f.transport, path, f, { raw }), 400, 422, 413);
  await rejectedUnchanged(f, () => send(f.transport, paths.runs + '/' + f.run.runId + '/grants', f,
    { body: { ...f.grantBody, requiresAi: false, grantTtlSeconds: 86400 } }), 400, 422);
});

test('MEMBER-HTTP-ADV actual bytes, fatal UTF8, Content-Length and chunk limits constrain the JSON body', async () => {
  const f = await fixture(), path = paths.runs;
  for (const headers of [{ 'Content-Type': undefined }, { 'Content-Type': 'text/plain' }, { 'Content-Type': 'application/json; charset=iso-8859-1' }, { 'Content-Encoding': 'gzip' }])
    await rejectedUnchanged(f, () => send(f.transport, path, f, { body: { workId: f.workId }, headers }), 415);
  for (const raw of [new Uint8Array([0x7b, 0x22, 0xc0, 0xaf, 0x22, 0x3a, 0x31, 0x7d]), new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), '{', ''])
    await rejectedUnchanged(f, () => send(f.transport, path, f, { raw }), 400, 422);
  for (const length of ['1', '0', '999', '-1', '1e2', '001', '32769'])
    await rejectedUnchanged(f, () => send(f.transport, path, f, { body: { workId: f.workId }, headers: { 'Content-Length': length } }), 400, 413);
  await rejectedUnchanged(f, () => send(f.transport, path, f, { raw: JSON.stringify({ workId: f.workId, padding: '字'.repeat(12000) }) }), 413);
  let cancelled = 0;
  const chunks = new ReadableStream<Uint8Array>({ start(c) { for (let n = 0; n < 129; n++) c.enqueue(new Uint8Array()); },
    cancel() { cancelled++; return Promise.reject(new Error('synthetic-secret cancellation')); } });
  await rejectedUnchanged(f, () => send(f.transport, path, f, { raw: chunks }), 413); assert.equal(cancelled, 1);
  const large = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(16385)); c.enqueue(new Uint8Array(16385)); } });
  await rejectedUnchanged(f, () => send(f.transport, path, f, { raw: large }), 413);
});

test('MEMBER-HTTP-ADV body abort and deadline terminate stalled reads even when source cancellation never settles', async () => {
  const f = await fixture(), abort = new AbortController(); let cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled++; return new Promise<void>(() => {}); } });
  const before = await snapshot(f), started = Date.now(), pending = send(f.transport, paths.runs, f, { raw: stream, signal: abort.signal });
  setTimeout(() => abort.abort(), 50); failure(await pending, 400); assert.ok(Date.now()-started < 1500); assert.equal(cancelled, 1);
  assert.deepEqual(await snapshot(f), before);
  let timedCancellation = 0;
  const stalled = new ReadableStream<Uint8Array>({ cancel() { timedCancellation++; return new Promise<void>(() => {}); } }), deadlineStart = Date.now();
  await rejectedUnchanged(f, () => send(f.transport, paths.runs, f, { raw: stalled }), 408);
  assert.equal(timedCancellation, 1); assert.ok(Date.now()-deadlineStart >= 4500); assert.ok(Date.now()-deadlineStart < 8500);
});

test('MEMBER-HTTP-ADV conditional/range headers cannot disclose existence or produce cached private responses', async () => {
  const f = await fixture(), outsider = await member(), path = paths.models + '/' + f.model.modelConnectionId;
  for (const headers of [{ 'If-None-Match': '"1"' }, { 'If-Match': '"1"' }, { 'If-Modified-Since': 'Thu, 01 Jan 2099 00:00:00 GMT' },
    { Range: 'bytes=0-5' }, { 'If-Range': '"1"' }]) {
    const result = await send(f.transport, path, f, { headers }); failure(result, 400, 403);
    failure(await send(f.transport, path, outsider, { headers }), 400, 403, 404);
  }
  const fresh = await send(f.transport, path, f); assert.equal(fresh.status, 200); assert.match(fresh.response.headers.get('Cache-Control') ?? '', /private/);
});

test('MEMBER-HTTP-ADV exact retries, changed request conflicts and stale CAS remain transactional through HTTP', async () => {
  const f = await fixture(), key = randomUUID(), headers = { 'Idempotency-Key': key };
  const replies = await Promise.all([send(f.transport, paths.runs, f, { body: { workId: f.workId }, headers }),
    send(f.transport, paths.runs, f, { body: { workId: f.workId }, headers })]);
  assert.equal(replies[0].status, 201); assert.equal(replies[1].status, 201); assert.deepEqual(replies[0].data, replies[1].data);
  await rejectedUnchanged(f, () => send(f.transport, paths.runs, f, { body: { workId: f.workId }, headers: { ...headers, 'If-Match': '"2"' } }), 409, 412);
  const consent = await grant(f), body = { grantId: consent.grantId, expectedGrantVersion: '1' }, attemptHeaders = { 'Idempotency-Key': randomUUID() };
  const attempts = await Promise.all([send(f.transport, paths.runs + '/' + f.run.runId + '/attempts', f, { body, headers: attemptHeaders }),
    send(f.transport, paths.runs + '/' + f.run.runId + '/attempts', f, { body, headers: attemptHeaders })]);
  assert.equal(attempts[0].status, 201); assert.deepEqual(attempts[0].data, attempts[1].data);
  const controlHeaders = { 'Idempotency-Key': randomUUID() }, path = paths.runs + '/' + f.run.runId + ':pause';
  const pause = await send(f.transport, path, f, { body: {}, headers: controlHeaders }); assert.equal(pause.status, 200);
  assert.deepEqual((await send(f.transport, path, f, { body: {}, headers: controlHeaders })).data, pause.data);
  await rejectedUnchanged(f, () => send(f.transport, paths.runs + '/' + f.run.runId + ':stop', f, { body: {} }), 412);
});

test('MEMBER-HTTP-ADV current policy, Work version and model revocation invalidate fresh and replayed consent while cleanup remains usable', async () => {
  for (const kind of ['policy', 'work', 'model'] as const) {
    const f = await fixture(), key = randomUUID(), consent = await grant(f, { 'Idempotency-Key': key });
    const path = paths.runs + '/' + f.run.runId + '/attempts', body = { grantId: consent.grantId, expectedGrantVersion: '1' }, attemptKey = randomUUID();
    const attempt = ExecutionAttemptMetadataSchema.parse((await send(f.transport, path, f, { body, headers: { 'Idempotency-Key': attemptKey } })).data);
    if (kind === 'policy') await owner.query('UPDATE private_work_persistence_policy SET persistence_allowed=false,revision=2 WHERE scope_id=$1', [f.context.scope.scope_id]);
    if (kind === 'work') await owner.query("UPDATE work_items SET title='Human edit',aggregate_version=2 WHERE work_item_id=$1", [f.workId]);
    if (kind === 'model') await services.models.revoke(f.actor, { key: randomUUID(), modelConnectionId: f.model.modelConnectionId, expectedVersion: '1' });
    await rejectedUnchanged(f, () => send(f.transport, path, f, { body, headers: { 'Idempotency-Key': attemptKey } }), 409, 503);
    await rejectedUnchanged(f, () => send(f.transport, paths.runs + '/' + f.run.runId + '/grants', f, { body: f.grantBody, headers: { 'Idempotency-Key': key } }), 409, 412, 503);
    assert.deepEqual((await send(f.transport, paths.attempts + '/' + attempt.attemptId, f)).data, attempt);
    assert.equal((await send(f.transport, paths.grants + '/' + consent.grantId + ':revoke', f, { body: {} })).status, 200);
    assert.equal((await send(f.transport, paths.runs + '/' + f.run.runId + ':stop', f, { body: {} })).status, 200);
  }
});

test('MEMBER-HTTP-ADV foreign owner and different trusted environment/client cannot read, revoke or attach private records', async () => {
  const f = await fixture(), outsider = await member(), consent = await grant(f);
  const attempt = ExecutionAttemptMetadataSchema.parse((await send(f.transport, paths.runs + '/' + f.run.runId + '/attempts', f,
    { body: { grantId: consent.grantId, expectedGrantVersion: '1' } })).data);
  for (const path of [paths.runs + '/' + f.run.runId, paths.models + '/' + f.model.modelConnectionId, paths.grants + '/' + consent.grantId, paths.attempts + '/' + attempt.attemptId])
    failure(await send(f.transport, path, outsider), 404);
  for (const path of [paths.models + '/' + f.model.modelConnectionId + ':revoke', paths.grants + '/' + consent.grantId + ':revoke', paths.runs + '/' + f.run.runId + ':stop'])
    await rejectedUnchanged(f, () => send(f.transport, path, outsider, { body: {} }), 404);
  const alternateOrigin = 'https://127.0.0.1:4310';
  for (const [transport, transportOrigin] of [[await createMemberExecutionHttpTransport(appPool, { ...options, origin: alternateOrigin, environment: 'staging-next', sourceNetwork: () => randomUUID() }), alternateOrigin],
    [await createMemberExecutionHttpTransport(appPool, { ...options, clientId: 'other-client', sourceNetwork: () => randomUUID() }), origin]] as const) {
    for (const path of [paths.models + '/' + f.model.modelConnectionId, paths.grants + '/' + consent.grantId, paths.attempts + '/' + attempt.attemptId])
      failure(await send(transport, transportOrigin + path, f, { headers: { Origin: transportOrigin } }), 404);
  }
});

test('MEMBER-HTTP-ADV session and Grant expiry after real SQL waits reject HTTP disclosure and roll back domain rows', async () => {
  const f = await fixture(), holder = await owner.connect();
  await owner.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE token_hash=$1", [f.actor.session_hash]);
  const expiry = (await owner.query('SELECT expires_at FROM sessions WHERE token_hash=$1', [f.actor.session_hash])).rows[0].expires_at;
  const before = await snapshot(f); await holder.query('BEGIN');
  try {
    await holder.query('SELECT model_connection_id FROM model_connections WHERE model_connection_id=$1 FOR UPDATE', [f.model.modelConnectionId]);
    const pending = send(f.transport, paths.models + '/' + f.model.modelConnectionId, f);
    await blockedBy(holder); await waitUntil(expiry.getTime()); await holder.query('COMMIT'); failure(await pending, 401);
  } finally { await holder.query('ROLLBACK'); holder.release(); }
  assert.deepEqual(await snapshot(f), before);
  const short = await fixture(2), consent = await grant(short), receiptHolder = await owner.connect(), beforeAttempt = await snapshot(short);
  await receiptHolder.query('BEGIN');
  try {
    await receiptHolder.query('LOCK TABLE scoped_command_receipts IN SHARE MODE');
    const pending = send(short.transport, paths.runs + '/' + short.run.runId + '/attempts', short, { body: { grantId: consent.grantId, expectedGrantVersion: '1' } });
    await blockedBy(receiptHolder); await waitUntil(Date.parse(consent.expiresAt)); await receiptHolder.query('COMMIT'); failure(await pending, 409);
  } finally { await receiptHolder.query('ROLLBACK'); receiptHolder.release(); }
  assert.deepEqual(await snapshot(short), beforeAttempt);
});

test('MEMBER-HTTP-ADV real rate charges commit across domain denial, ignore network headers and saturate at the configured network cap', async () => {
  const f = await fixture(), before = await snapshot(f), path = paths.runs + '/' + randomUUID();
  const baseline = Number((await owner.query('SELECT coalesce(sum(attempts),0)::text n FROM auth_rate_limits')).rows[0].n);
  for (let n = 0; n < 60; n++) {
    const result = await send(f.transport, path, f, { headers: { 'X-Test-Network': randomUUID(), 'CF-Connecting-IP': '203.0.113.' + (n+1), 'X-Forwarded-For': randomUUID() } });
    failure(result, 404);
  }
  const denied = await send(f.transport, path, f, { headers: { 'CF-Connecting-IP': '198.51.100.9', 'X-Forwarded-For': 'another-network' } });
  failure(denied, 429); assert.equal(denied.response.headers.get('Retry-After'), '60');
  const total = Number((await owner.query('SELECT coalesce(sum(attempts),0)::text n FROM auth_rate_limits')).rows[0].n);
  assert.ok(total - baseline >= 120, 'Both durable global and network counters charge denied requests independently');
  assert.deepEqual(await snapshot(f), before);
});

test('MEMBER-HTTP-ADV production Node/Worker composition does not import or mount this closed transport', async () => {
  const f = await fixture();
  for (const file of ['../../apps/platform-api/src/platform-app.ts', '../../apps/platform-api/src/app.ts', '../../apps/platform-api/src/worker.ts']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.ok(!source.includes('createMemberExecutionHttpTransport')); assert.ok(!source.includes("from './routes/member-execution-http"));
  }
  const production = createApp(appPool, origin, 'local');
  for (const path of [paths.runs + '/' + f.run.runId, paths.models + '/' + f.model.modelConnectionId])
    assert.equal((await production.request(origin + path, { headers: { Cookie: f.cookie } })).status, 404);
});

test('MEMBER-HTTP-ADV six hundred independent trusted networks still share one durable global execution cap', async () => {
  const f = await fixture(), distinctClient = 'global-independent-' + randomUUID(), before = await snapshot(f);
  const transport = await createMemberExecutionHttpTransport(appPool, { ...options, clientId: distinctClient, sourceNetwork: () => randomUUID() });
  const path = paths.runs + '/' + randomUUID();
  for (let n = 0; n < 600; n++) failure(await send(transport, path, f), 404);
  const saturated = await send(transport, path, f); failure(saturated, 429);
  assert.equal(saturated.response.headers.get('Retry-After'), '60');
  const bucket = createHash('sha256').update(JSON.stringify(['freedom.bootstrap-http/v1','local',distinctClient,'execution_member','global','global'])).digest('hex');
  assert.equal((await owner.query('SELECT attempts FROM auth_rate_limits WHERE bucket=$1', [bucket])).rows[0].attempts, 600);
  assert.deepEqual(await snapshot(f), before);
});

test('MEMBER-HTTP-ADV unavailable or malformed trusted source network fails closed before domain access', async () => {
  const f = await fixture();
  for (const sourceNetwork of [() => { throw new Error('synthetic-secret'); }, () => '', () => 'network\nforged', () => 'x'.repeat(201), () => undefined as unknown as string]) {
    const transport = await createMemberExecutionHttpTransport(appPool, { ...options, sourceNetwork });
    await rejectedUnchanged(f, () => send(transport, paths.models + '/' + f.model.modelConnectionId, f), 503);
  }
});
