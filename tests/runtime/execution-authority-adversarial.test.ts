import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CompactSign, exportJWK, generateKeyPair } from 'jose';
import { Pool, type PoolClient } from 'pg';
import { migrate } from '../../scripts/database.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import type { Actor } from '../../modules/identity-membership/service.js';
import { createDeviceAuthorizations } from '../../modules/agent-control/device-authorizations.js';
import { createBootstrapSessions } from '../../modules/agent-control/bootstrap-sessions.js';
import { createAgentConnections } from '../../modules/agent-control/agent-connections.js';
import { createRuntimeRegistrationChallenge, parseRuntimePublicJwk } from '../../modules/agent-control/runtime-proof.js';
import { createExecutionRuns } from '../../modules/agent-execution/runs.js';
import { createExecutionPrerequisites } from '../../modules/agent-execution/prerequisites.js';
import { ModelConnectionMetadataSchema, ExecutionGrantMetadataSchema, ExecutionAttemptMetadataSchema,
  type ModelSelection } from '../../contracts/execution/v1/member-execution.js';
import type { BootstrapSessionHost } from '../../contracts/execution/v1/bootstrap-session.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname))
  throw new Error('Execution authority adversarial tests require an explicit disposable fp_* TEST_DATABASE_URL.');
const schema = `fp_exec_adv_${process.pid}_${Date.now()}`, migrator = `${schema}_owner`, runtime = `${schema}_app`;
const admin = new Pool({ connectionString });
function roleUrl(role: string) { const url = new URL(connectionString!); url.username = role; url.password = ''; return url.toString(); }
const owner = new Pool({ connectionString: roleUrl(migrator), options: `-c search_path=${schema} -c statement_timeout=10000`, max: 8 });
const app = new Pool({ connectionString: roleUrl(runtime), options: `-c search_path=${schema} -c statement_timeout=10000`, max: 12 });
const hostOptions = { environment: 'local' as const, clientId: 'execution-authority-review' };
const api = createExecutionPrerequisites(app, hostOptions), runs = createExecutionRuns(app);
let created = false;
let pairing: Awaited<ReturnType<typeof createDeviceAuthorizations>>;
let sessions: Awaited<ReturnType<typeof createBootstrapSessions>>;
let host: BootstrapSessionHost;
let pairingHost: Parameters<typeof createDeviceAuthorizations>[1]['host'];

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
  try { await q.query(prefix); const statements = await q.query(grants); assert.equal(statements.rowCount, 2);
    for (const row of statements.rows) await q.query(Object.values(row)[0] as string); await q.query('COMMIT'); }
  catch (error) { await q.query('ROLLBACK'); throw error; } finally { q.release(); }
  const issuer = await generateKeyPair('ES256');
  host = { ...hostOptions, issuerKid: 'synthetic-issuer', issuer: 'https://issuer.example.invalid/', audience: 'https://platform.example.invalid/',
    bootstrapUri: 'https://platform.example.invalid/execution-api/v1/bootstrap',
    refreshUri: 'https://platform.example.invalid/execution-api/v1/auth/refresh', nonceUri: 'https://platform.example.invalid/execution-api/v1/auth/nonce',
    keys: [{ kid: 'synthetic-issuer', purpose: 'bootstrap_access', environment: 'local',
      publicJwk: parseRuntimePublicJwk(await exportJWK(issuer.publicKey)), notBeforeMs: 0, notAfterMs: Number.MAX_SAFE_INTEGER, revoked: false }] };
  const { refreshUri: _refresh, nonceUri: _nonce, ...base } = host;
  pairingHost = { ...base, beginUri: 'https://platform.example.invalid/device/begin', pollUri: 'https://platform.example.invalid/device/poll',
    verificationUri: 'https://platform.example.invalid/device', clientDisplayName: 'Synthetic execution review device' };
  pairing = await createDeviceAuthorizations(app, { host: pairingHost, signingKey: issuer.privateKey });
  sessions = await createBootstrapSessions(app, { host, signingKey: issuer.privateKey });
});
after(async () => {
  await app.end(); await owner.end();
  try { if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE; DROP ROLE ${runtime},${migrator}`); }
  finally { await admin.end(); }
});
const status = (...codes: number[]) => (error: unknown) => codes.includes((error as { status?: number })?.status ?? 0);
const sqlCode = (...codes: string[]) => (error: unknown) => codes.includes((error as { code?: string })?.code ?? '');
const selection: ModelSelection = { providerRef: 'synthetic-provider', modelRef: 'synthetic-text-model', processingLocation: 'provider_remote',
  artifactCustody: 'platform_asset', credentialCustody: 'official_cli', engineLocation: 'runtime_local', billingSource: 'user_cli' };
const hash = (text: string) => createHash('sha256').update(text, 'ascii').digest('base64url');
async function dbNow() { return Number((await owner.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text ms')).rows[0].ms); }
async function waitUntil(ms: number) {
  for (let i = 0; i < 500; i++) { if (await dbNow() >= ms) return; await delay(10); }
  assert.fail('PostgreSQL clock did not reach the expected expiry');
}
async function blockedBy(holder: PoolClient) {
  const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  for (let i = 0; i < 300; i++) {
    if ((await admin.query('SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid])).rows[0].n) return;
    await delay(10);
  }
  assert.fail('Actual PostgreSQL lock wait was not observed');
}
async function waiterBehind(holder: PoolClient) {
  const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  for (let i = 0; i < 300; i++) {
    const row = (await admin.query('SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND usename=$2', [pid, runtime])).rows[0];
    if (row) return Number(row.pid);
    await delay(10);
  }
  assert.fail('The real revocation transaction did not wait on the holder');
}
async function blockedByBackend(pid: number) {
  for (let i = 0; i < 300; i++) {
    if ((await admin.query('SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND usename=$2', [pid, runtime])).rows[0].n) return;
    await delay(10);
  }
  assert.fail('The actual Attempt transaction did not wait behind revocation');
}
async function member() {
  const user = randomUUID(), community = randomUUID(), session = randomUUID();
  await owner.query("INSERT INTO communities VALUES($1,'Synthetic execution authority review')", [community]);
  const row = (await owner.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic owner','not-a-login',$4) RETURNING *`, [user, community, user + '@example.invalid', randomUUID()])).rows[0];
  await owner.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')", [session, user]);
  const actor: Actor = { ...row, session_hash: session, csrf_token: 'synthetic' };
  const context = await withMemberScope(app, { actor, scope: 'personal' }, async () => {}, async (_q, c) => c);
  return { actor, context };
}
async function paired(existing?: Awaited<ReturnType<typeof member>>) {
  const human = existing ?? await member(), device = await generateKeyPair('ES256');
  const publicJwk = parseRuntimePublicJwk(await exportJWK(device.publicKey));
  const sign = (typ: string, claims: Record<string, unknown>) => new CompactSign(new TextEncoder().encode(JSON.stringify(claims)))
    .setProtectedHeader({ alg: 'ES256', typ, jwk: publicJwk }).sign(device.privateKey);
  const base = { client_id: hostOptions.clientId, environment: 'local', runtime_kind: 'agent-kit', scope: 'bootstrap.status.read', htm: 'POST' };
  const beginProof = await sign('freedom-device-pairing+jwt', { ...base, purpose: 'device_pairing_begin', jti: randomUUID(),
    iat: Math.floor(await dbNow()/1000), htu: pairingHost.beginUri });
  const started = await pairing.begin({ publicJwk, runtimeKind: 'agent-kit', proof: beginProof });
  await pairing.decide(human.actor, { key: randomUUID(), userCode: started.userCode, authorizationId: started.authorizationId,
    requestDigest: started.requestDigest, decision: 'approve' });
  // Read only the synthetic challenge through the dedicated migrator session.
  // This skips the initial five-second poll, while all proof/exchange/091
  // persistence follows the real implementation without invented families.
  const row = (await owner.query(`SELECT c.* FROM runtime_registration_challenges c JOIN device_authorizations a USING(challenge_id)
    WHERE a.authorization_id=$1`, [started.authorizationId])).rows[0];
  const challenge = createRuntimeRegistrationChallenge({ challenge_id: row.challenge_id, runtime_device_id: row.runtime_device_id,
    owner_member_id: row.owner_user_id, owner_principal_id: row.owner_principal_id, scope_id: row.scope_id,
    environment: row.environment, key_thumbprint: row.key_thumbprint, nonce: row.nonce,
    issued_at: row.issued_at.toISOString(), expires_at: row.expires_at.toISOString() });
  const enrollmentProof = await new CompactSign(new TextEncoder().encode(challenge.payload))
    .setProtectedHeader({ alg: 'ES256', typ: 'freedom-runtime-enrollment+jws' }).sign(device.privateKey);
  const initial = await pairing.poll({ authorizationId: started.authorizationId, deviceCode: started.deviceCode, enrollmentProof,
    proof: await sign('freedom-device-pairing+jwt', { ...base, purpose: 'device_pairing_poll', jti: randomUUID(), iat: Math.floor(await dbNow()/1000),
      htu: pairingHost.pollUri, authorization_id: started.authorizationId, request_digest: started.requestDigest,
      nonce: started.nonce, device_code_hash: hash(started.deviceCode) }) });
  assert.equal(initial.status, 'issued'); if (initial.status !== 'issued') throw Error('Genuine 091 device exchange required');
  return { ...human, initial, sign, enrollmentProof, beginProof, runtimeDeviceId: challenge.runtime_device_id };
}
async function fixture(target = api, workVersion = '1') {
  const f = await paired(), workId = randomUUID();
  await owner.query(`INSERT INTO work_items(work_item_id,work_mode,scope_id,owner_principal_id,owner_ref,title,objective,state,participation_terms_revision,aggregate_version)
    VALUES($1,'personal_execution',$2,$3,$4,'Synthetic model draft','No provider or execution','draft',NULL,$5)`,
  [workId, f.context.scope.scope_id, f.context.subject_principal.principal_id, f.actor.user_id, workVersion]);
  await owner.query(`INSERT INTO private_work_persistence_policy(scope_id,owner_principal_id,purpose,revision,persistence_allowed,retained_byte_limit)
    VALUES($1,$2,'work.private-draft',1,true,1048576)`, [f.context.scope.scope_id, f.context.subject_principal.principal_id]);
  const run = await runs.create(f.actor, { key: randomUUID(), workId, expectedWorkVersion: workVersion });
  const modelInput = { key: randomUUID(), connectionId: f.initial.connectionId, expectedConnectionVersion: '1', selection: { ...selection } };
  const model = await target.models.create(f.actor, modelInput);
  const grantInput = { key: randomUUID(), runId: run.runId, expectedRunVersion: '1', expectedWorkVersion: workVersion,
    connectionId: f.initial.connectionId, expectedConnectionVersion: '1', modelConnectionId: model.modelConnectionId, expectedModelVersion: '1', consent: true as const };
  const grant = await target.grants.create(f.actor, grantInput);
  const attemptInput = { key: randomUUID(), runId: run.runId, grantId: grant.grantId, expectedRunVersion: '1', expectedGrantVersion: '1' };
  return { ...f, workId, run, model, grant, modelInput, grantInput, attemptInput };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function refreshInput(f: Fixture) {
  const refresh = f.initial.refresh;
  return { familyId: refresh.familyId, refreshHandle: refresh.handle,
    proof: await f.sign('freedom-bootstrap-refresh+jwt', { purpose: 'bootstrap_refresh', client_id: hostOptions.clientId, environment: 'local',
      connection_id: f.initial.connectionId, family_id: refresh.familyId, generation: refresh.generation, refresh_handle_hash: hash(refresh.handle),
      jti: randomUUID(), iat: Math.floor(await dbNow()/1000), htm: 'POST', htu: host.refreshUri }) };
}
function directAttempt(q: PoolClient, f: Fixture) {
  return q.query(`INSERT INTO ${schema}.execution_attempts(attempt_id,run_id,work_item_id,owner_user_id,owner_principal_id,scope_id,grant_id,attempt_number,grant_snapshot,created_at)
    SELECT $1,run_id,work_item_id,owner_user_id,owner_principal_id,scope_id,grant_id,1,${schema}.execution_prerequisite_grant_snapshot(to_jsonb(g)),date_trunc('milliseconds',clock_timestamp())
    FROM ${schema}.execution_grants g WHERE grant_id=$2 RETURNING attempt_id`, [randomUUID(), f.grant.grantId]);
}
async function snapshot(f: Fixture) {
  const data: Record<string, unknown> = {};
  for (const table of ['model_connections', 'execution_grants', 'execution_attempts', 'execution_runs', 'scoped_command_receipts', 'scoped_transition_journal', 'scoped_outbox'])
    data[table] = (await owner.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE scope_id=$1 ORDER BY to_jsonb(t)::text`, [f.context.scope.scope_id])).rows;
  return data;
}
async function unchangedAfter(f: Fixture, task: () => Promise<unknown>, rejection?: (error: unknown) => boolean) {
  const before = await snapshot(f);
  if (rejection) await assert.rejects(task(), rejection); else await assert.rejects(task());
  assert.deepEqual(await snapshot(f), before);
}
async function cloneInsert(table: 'model_connections'|'execution_grants', idColumn: 'model_connection_id'|'grant_id', id: string, overrides: Record<string, unknown>) {
  return app.query(`INSERT INTO ${schema}.${table} SELECT (jsonb_populate_record(NULL::${schema}.${table},to_jsonb(t)||$2::jsonb)).*
    FROM ${schema}.${table} t WHERE ${idColumn}=$1`, [id, JSON.stringify({ [idColumn]: randomUUID(), creation_key: randomUUID(), ...overrides })]);
}

test('EXEC-ADV genuine paired model/consent/attempt records remain blocked and cannot mutate the Run or Work', async () => {
  for (const [pool, name] of [[owner, migrator], [app, runtime]] as const)
    assert.deepEqual((await pool.query('SELECT current_user,session_user,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0],
      { current_user: name, session_user: name, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
  const f = await fixture(), attempt = await api.attempts.create(f.actor, f.attemptInput);
  assert.deepEqual(ModelConnectionMetadataSchema.parse(f.model), f.model);
  assert.deepEqual(ExecutionGrantMetadataSchema.parse(f.grant), f.grant);
  assert.deepEqual(ExecutionAttemptMetadataSchema.parse(attempt), attempt);
  assert.equal(f.model.state, 'unverified'); assert.equal(f.grant.purpose, 'model.private-draft');
  assert.equal(f.model.familyId, f.initial.refresh.familyId); assert.equal(f.grant.familyId, f.initial.refresh.familyId);
  assert.deepEqual(attempt.grant, f.grant); assert.equal(attempt.attemptNumber, 1);
  assert.deepEqual(attempt.blockers, ['model_authentication_unavailable', 'model_adapter_unavailable']);
  assert.equal(attempt.state, 'preflight_blocked');
  for (const record of [f.model, f.grant, attempt, attempt.grant]) assert.equal(record.operational_authority, false);
  assert.deepEqual(await runs.read(f.actor, { runId: f.run.runId }), f.run);
  assert.equal((await owner.query('SELECT aggregate_version::text version FROM work_items WHERE work_item_id=$1', [f.workId])).rows[0].version, '1');
  assert.ok(Date.parse(f.grant.expiresAt) - Date.parse(f.grant.issuedAt) <= 3600000);
  assert.ok(Date.parse(f.grant.expiresAt) <= Date.parse(f.initial.refresh.expiresAt));
});

test('EXEC-ADV wrong owner, environment, client and same-owner different paired connection never reveal or create bindings', async () => {
  const f = await fixture(), stranger = await member(), second = await paired({ actor: f.actor, context: f.context });
  const attempt = await api.attempts.create(f.actor, f.attemptInput);
  for (const target of [api, createExecutionPrerequisites(app, { ...hostOptions, environment: 'staging-next' }),
    createExecutionPrerequisites(app, { ...hostOptions, clientId: 'another-client' })]) {
    const actor = target === api ? stranger.actor : f.actor;
    await assert.rejects(target.models.read(actor, { modelConnectionId: f.model.modelConnectionId }), status(404));
    await assert.rejects(target.grants.read(actor, { grantId: f.grant.grantId }), status(404));
    await assert.rejects(target.attempts.read(actor, { attemptId: attempt.attemptId }), status(404));
  }
  await unchangedAfter(f, () => api.grants.create(stranger.actor, { ...f.grantInput, key: randomUUID() }), status(404));
  await unchangedAfter(f, () => api.grants.create(f.actor, { ...f.grantInput, key: randomUUID(), connectionId: second.initial.connectionId }), status(409, 404));
  await unchangedAfter(f, () => api.attempts.create(stranger.actor, { ...f.attemptInput, key: randomUUID() }), status(404));
});

test('EXEC-ADV strict request boundaries reject caller readiness, privileges, provider secrets, fallback and TTL', async () => {
  const f = await fixture(), before = await snapshot(f);
  for (const [field, value] of Object.entries({ modelReady: true, state: 'ready', operational_authority: true, ownerUserId: f.actor.user_id,
    scopeId: f.context.scope.scope_id, runtimeDeviceId: f.runtimeDeviceId, authEvidence: { ready: true }, secret: 'synthetic-secret', requiresAi: false }))
    await assert.rejects(api.models.create(f.actor, { ...f.modelInput, key: randomUUID(), [field]: value } as Parameters<typeof api.models.create>[1]));
  for (const extra of [{ providerUrl: 'https://attacker.example.invalid' }, { apiKey: 'synthetic-secret' }, { fallback: 'platform-key' },
    { billingSource: 'platform' }, { credentialCustody: 'official_cli', engineLocation: 'platform' }, { modelRef: 'bad\n' }])
    await assert.rejects(api.models.create(f.actor, { ...f.modelInput, key: randomUUID(), selection: { ...selection, ...extra } } as Parameters<typeof api.models.create>[1]));
  for (const extra of [{ consent: false }, { purpose: 'action.execute' }, { expiresAt: new Date(Date.now()+86400000).toISOString() },
    { grantTtlSeconds: 86400 }, { requiresAi: false }, { actor: { kind: 'service' } }, { policyRevision: 'private-work.v2' }, { scopeSnapshot: { all: true } }])
    await assert.rejects(api.grants.create(f.actor, { ...f.grantInput, key: randomUUID(), ...extra } as Parameters<typeof api.grants.create>[1]));
  for (const extra of [{ modelReady: true }, { state: 'running' }, { current: true }, { leaseEpoch: '1' }, { recoveryGeneration: '1' },
    { blockers: [] }, { operational_authority: true }, { grant: f.grant }, { selection }])
    await assert.rejects(api.attempts.create(f.actor, { ...f.attemptInput, key: randomUUID(), ...extra } as Parameters<typeof api.attempts.create>[1]));
  assert.deepEqual(await snapshot(f), before);
});

test('EXEC-ADV CAS preconditions and immutable Work input prevent stale consent and attempts', async () => {
  const f = await fixture();
  for (const field of ['expectedRunVersion', 'expectedWorkVersion', 'expectedConnectionVersion', 'expectedModelVersion'] as const) {
    const missing: Partial<typeof f.grantInput> = { ...f.grantInput, key: randomUUID() }; delete missing[field];
    await unchangedAfter(f, () => api.grants.create(f.actor, missing as typeof f.grantInput), status(428));
    await unchangedAfter(f, () => api.grants.create(f.actor, { ...f.grantInput, key: randomUUID(), [field]: '2' }), status(412));
  }
  for (const field of ['expectedRunVersion', 'expectedGrantVersion'] as const) {
    const missing: Partial<typeof f.attemptInput> = { ...f.attemptInput, key: randomUUID() }; delete missing[field];
    await unchangedAfter(f, () => api.attempts.create(f.actor, missing as typeof f.attemptInput), status(428));
  }
  await owner.query("UPDATE work_items SET title='Human edit',aggregate_version=aggregate_version+1 WHERE work_item_id=$1", [f.workId]);
  await unchangedAfter(f, () => api.grants.create(f.actor, { ...f.grantInput, key: randomUUID(), expectedWorkVersion: '2' }), status(409, 412));
  await unchangedAfter(f, () => api.attempts.create(f.actor, f.attemptInput), status(409, 412));
  assert.deepEqual(await api.grants.read(f.actor, { grantId: f.grant.grantId }), f.grant);
});

test('EXEC-ADV exact concurrent retries create one record and preserve original attempt numbering', async () => {
  const f = await fixture(), modelInput = { ...f.modelInput, key: randomUUID() }, grantInput = { ...f.grantInput, key: randomUUID() };
  const models = await Promise.all([api.models.create(f.actor, modelInput), api.models.create(f.actor, modelInput)]);
  assert.deepEqual(models[0], models[1]);
  const grants = await Promise.all([api.grants.create(f.actor, grantInput), api.grants.create(f.actor, grantInput)]);
  assert.deepEqual(grants[0], grants[1]);
  const attempts = await Promise.all([api.attempts.create(f.actor, f.attemptInput), api.attempts.create(f.actor, f.attemptInput)]);
  assert.deepEqual(attempts[0], attempts[1]); assert.equal(attempts[0].attemptNumber, 1);
  const distinct = await Promise.all([api.attempts.create(f.actor, { ...f.attemptInput, key: randomUUID() }),
    api.attempts.create(f.actor, { ...f.attemptInput, key: randomUUID() })]);
  assert.deepEqual(distinct.map(x => x.attemptNumber).sort(), [2, 3]);
  await unchangedAfter(f, () => api.models.create(f.actor, { ...f.modelInput, selection: { ...selection, modelRef: 'different-model' } }), status(409));
  await unchangedAfter(f, () => api.grants.create(f.actor, { ...f.grantInput, expectedModelVersion: '2' }), status(409, 412));
  const otherGrant = await api.grants.create(f.actor, { ...f.grantInput, key: randomUUID() });
  await unchangedAfter(f, () => api.attempts.create(f.actor, { ...f.attemptInput, grantId: otherGrant.grantId }), status(409));
  assert.deepEqual(await runs.read(f.actor, { runId: f.run.runId }), f.run);
  const row = (await owner.query('SELECT count(*)::int n FROM execution_attempts WHERE run_id=$1', [f.run.runId])).rows[0];
  assert.equal(row.n, 3);
});

test('EXEC-ADV revocation and policy withdrawal prevent new and replayed bindings while human cleanup retains original evidence', async () => {
  const f = await fixture(), attempt = await api.attempts.create(f.actor, f.attemptInput);
  const model = await api.models.revoke(f.actor, { key: randomUUID(), modelConnectionId: f.model.modelConnectionId, expectedVersion: '1' });
  assert.equal(model.state, 'revoked'); assert.equal(model.aggregateVersion, '2');
  await unchangedAfter(f, () => api.models.create(f.actor, f.modelInput), status(409));
  await unchangedAfter(f, () => api.grants.create(f.actor, f.grantInput), status(409));
  await unchangedAfter(f, () => api.attempts.create(f.actor, f.attemptInput), status(409));
  await owner.query('UPDATE private_work_persistence_policy SET persistence_allowed=false,revision=2 WHERE scope_id=$1', [f.context.scope.scope_id]);
  await owner.query("UPDATE work_items SET state='archived',aggregate_version=2 WHERE work_item_id=$1", [f.workId]);
  assert.deepEqual(await api.models.read(f.actor, { modelConnectionId: model.modelConnectionId }), model);
  assert.deepEqual(await api.attempts.read(f.actor, { attemptId: attempt.attemptId }), attempt);
  const revoke = { key: randomUUID(), grantId: f.grant.grantId, expectedVersion: '1' };
  const grant = await api.grants.revoke(f.actor, revoke);
  assert.equal(grant.state, 'revoked'); assert.equal(grant.aggregateVersion, '2');
  assert.deepEqual(await api.grants.revoke(f.actor, revoke), grant);
  assert.deepEqual((await api.attempts.read(f.actor, { attemptId: attempt.attemptId })).grant, f.grant);
  assert.equal((await runs.stop(f.actor, { key: randomUUID(), runId: f.run.runId, expectedVersion: '1' })).state, 'cancelled');
});

test('EXEC-ADV current member, principal and scope authority still gates record reads and successful receipt replay', async () => {
  for (const kind of ['session', 'user', 'principal', 'scope']) {
    const f = await fixture(), attempt = await api.attempts.create(f.actor, f.attemptInput);
    if (kind === 'session') await owner.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1', [f.actor.session_hash]);
    if (kind === 'user') await owner.query('UPDATE users SET active=false WHERE user_id=$1', [f.actor.user_id]);
    if (kind === 'principal') await owner.query("UPDATE principals SET status='disabled' WHERE principal_id=$1", [f.context.subject_principal.principal_id]);
    if (kind === 'scope') await owner.query("UPDATE resource_scopes SET status='disabled' WHERE scope_id=$1", [f.context.scope.scope_id]);
    await unchangedAfter(f, () => api.models.create(f.actor, f.modelInput), status(401, 403));
    await assert.rejects(api.attempts.read(f.actor, { attemptId: attempt.attemptId }), status(401, 403));
    await assert.rejects(api.grants.revoke(f.actor, { key: randomUUID(), grantId: f.grant.grantId, expectedVersion: '1' }), status(401, 403));
  }
});

test('EXEC-ADV real refresh rotation keeps same family binding without pinning the spent generation', async () => {
  const f = await fixture(), refresh = f.initial.refresh;
  const rotated = await sessions.refresh({ familyId: refresh.familyId, refreshHandle: refresh.handle,
    proof: await f.sign('freedom-bootstrap-refresh+jwt', { purpose: 'bootstrap_refresh', client_id: hostOptions.clientId, environment: 'local',
      connection_id: f.initial.connectionId, family_id: refresh.familyId, generation: refresh.generation, refresh_handle_hash: hash(refresh.handle),
      jti: randomUUID(), iat: Math.floor(await dbNow()/1000), htm: 'POST', htu: host.refreshUri }) });
  assert.equal(rotated.refresh.generation, '2'); assert.equal(rotated.refresh.familyId, f.grant.familyId);
  const attempt = await api.attempts.create(f.actor, f.attemptInput);
  assert.deepEqual(attempt.grant, f.grant); assert.equal(attempt.operational_authority, false);
});

test('EXEC-ADV exact bootstrap tokens cannot be used as member authority or injected into selection and consent', async () => {
  const f = await fixture();
  const fakeActor = { ...f.actor, session_hash: f.initial.accessToken };
  await unchangedAfter(f, () => api.models.create(fakeActor, { ...f.modelInput, key: randomUUID() }), status(401));
  for (const extra of [{ accessToken: f.initial.accessToken }, { refreshHandle: f.initial.refresh.handle }, { proof: f.enrollmentProof }])
    await unchangedAfter(f, () => api.grants.create(f.actor, { ...f.grantInput, key: randomUUID(), ...extra } as Parameters<typeof api.grants.create>[1]));
  const attempt = await api.attempts.create(f.actor, f.attemptInput), persisted = JSON.stringify(await snapshot(f));
  for (const secret of [f.initial.accessToken, f.initial.refresh.handle, f.enrollmentProof, f.beginProof]) assert.ok(!persisted.includes(secret));
  const response = JSON.stringify([f.model, f.grant, attempt]);
  for (const key of ['publicJwk', 'secret', 'accessToken', 'refreshHandle', 'session_hash', 'authEvidence', 'modelReady']) assert.ok(!response.includes('"'+key+'"'));
});

test('EXEC-ADV grant expiry during the actual receipt SELECT prevents successful attempt replay', async () => {
  const short = createExecutionPrerequisites(app, { ...hostOptions, grantTtlSeconds: 2 });
  const f = await fixture(short), attempt = await short.attempts.create(f.actor, f.attemptInput), before = await snapshot(f);
  const holder = await owner.connect(); await holder.query('BEGIN');
  try {
    await holder.query('LOCK TABLE scoped_command_receipts IN ACCESS EXCLUSIVE MODE');
    const pending = short.attempts.create(f.actor, f.attemptInput); const rejected = assert.rejects(pending, status(409));
    await blockedBy(holder); await waitUntil(Date.parse(f.grant.expiresAt)); await holder.query('COMMIT'); await rejected;
  } finally { await holder.query('ROLLBACK'); holder.release(); }
  assert.deepEqual(await snapshot(f), before);
  assert.deepEqual(await short.attempts.read(f.actor, { attemptId: attempt.attemptId }), attempt);
});

test('EXEC-ADV grant expiry during the actual receipt INSERT rolls back Attempt, journal, outbox and response together', async () => {
  const short = createExecutionPrerequisites(app, { ...hostOptions, grantTtlSeconds: 2 });
  const f = await fixture(short), before = await snapshot(f), holder = await owner.connect(); await holder.query('BEGIN');
  try {
    await holder.query('LOCK TABLE scoped_command_receipts IN SHARE MODE');
    const pending = short.attempts.create(f.actor, f.attemptInput); const rejected = assert.rejects(pending, status(409));
    await blockedBy(holder); await waitUntil(Date.parse(f.grant.expiresAt)); await holder.query('COMMIT'); await rejected;
  } finally { await holder.query('ROLLBACK'); holder.release(); }
  assert.deepEqual(await snapshot(f), before);
  assert.deepEqual(await short.grants.read(f.actor, { grantId: f.grant.grantId }), f.grant);
  assert.equal((await short.grants.revoke(f.actor, { key: randomUUID(), grantId: f.grant.grantId, expectedVersion: '1' })).state, 'revoked');
});

test('EXEC-ADV ordinary SQL cannot rewrite selections, owner/version snapshots, revive revocations, mutate Attempts or erase history', async () => {
  const f = await fixture(), attempt = await api.attempts.create(f.actor, f.attemptInput);
  for (const [table, idColumn, id, assignments] of [
    ['model_connections', 'model_connection_id', f.model.modelConnectionId, ["state='ready'", "selection=jsonb_set(selection,'{modelRef}','\"changed\"')", 'connection_id=gen_random_uuid()', 'family_id=gen_random_uuid()', 'owner_user_id=gen_random_uuid()', 'aggregate_version=2']],
    ['execution_grants', 'grant_id', f.grant.grantId, ['input_work_version=2', 'run_version=2', 'task_lease_epoch=2', 'control_epoch=2', 'model_version=2', "purpose='action.execute'", 'expires_at=expires_at+interval \'1 second\'', 'consent=false']],
    ['execution_attempts', 'attempt_id', attempt.attemptId, ["state='running'", "blockers='[]'", 'attempt_number=2', "grant_snapshot=jsonb_set(grant_snapshot,'{state}','\"revoked\"')", 'created_at=created_at+interval \'1 second\'']],
  ] as const) {
    for (const assignment of assignments)
      await assert.rejects(app.query(`UPDATE ${table} SET ${assignment} WHERE ${idColumn}=$1`, [id]), sqlCode('23514'));
    await assert.rejects(app.query(`DELETE FROM ${table} WHERE ${idColumn}=$1`, [id]), sqlCode('23514'));
    await assert.rejects(app.query(`TRUNCATE ${table} CASCADE`), sqlCode('42501'));
  }
  await api.models.revoke(f.actor, { key: randomUUID(), modelConnectionId: f.model.modelConnectionId, expectedVersion: '1' });
  await assert.rejects(app.query("UPDATE model_connections SET state='unverified',revoked_at=NULL,aggregate_version=3 WHERE model_connection_id=$1", [f.model.modelConnectionId]), sqlCode('23514'));
  await assert.rejects(app.query('UPDATE private_work_persistence_policy SET persistence_allowed=false,revision=revision+1'), sqlCode('42501'));
  await assert.rejects(app.query('ALTER TABLE execution_attempts DISABLE TRIGGER preserve_execution_attempt'), sqlCode('42501'));
  assert.deepEqual(await runs.read(f.actor, { runId: f.run.runId }), f.run);
});

test('EXEC-ADV TEMP-shadowed consent cannot replace a physically revoked grant or produce an Attempt', async () => {
  const f = await fixture(); await api.grants.revoke(f.actor, { key: randomUUID(), grantId: f.grant.grantId, expectedVersion: '1' });
  const q = await app.connect(); await q.query('BEGIN');
  try {
    await q.query(`CREATE TEMP TABLE execution_grants AS SELECT * FROM ${schema}.execution_grants`);
    await q.query("UPDATE pg_temp.execution_grants SET state='active',aggregate_version=1,revoked_at=NULL WHERE grant_id=$1", [f.grant.grantId]);
    await assert.rejects(q.query(`INSERT INTO ${schema}.execution_attempts(attempt_id,run_id,work_item_id,owner_user_id,owner_principal_id,scope_id,grant_id,attempt_number,grant_snapshot,created_at)
      SELECT $1,run_id,work_item_id,owner_user_id,owner_principal_id,scope_id,grant_id,1,to_jsonb(t),date_trunc('milliseconds',clock_timestamp())
      FROM pg_temp.execution_grants t WHERE grant_id=$2`, [randomUUID(), f.grant.grantId]), sqlCode('23514'));
  } finally { await q.query('ROLLBACK'); q.release(); }
  assert.equal((await owner.query('SELECT count(*)::int n FROM execution_attempts WHERE run_id=$1', [f.run.runId])).rows[0].n, 0);
});

test('EXEC-ADV retained Attempt limit is sixteen and exact replay never consumes another slot', async () => {
  const f = await fixture();
  const first = await api.attempts.create(f.actor, f.attemptInput);
  for (let n = 2; n <= 16; n++) assert.equal((await api.attempts.create(f.actor, { ...f.attemptInput, key: randomUUID() })).attemptNumber, n);
  assert.deepEqual(await api.attempts.create(f.actor, f.attemptInput), first);
  await unchangedAfter(f, () => api.attempts.create(f.actor, { ...f.attemptInput, key: randomUUID() }), status(429));
  assert.deepEqual(await runs.read(f.actor, { runId: f.run.runId }), f.run);
});

test('EXEC-ADV exact bigint Work versions survive the original Attempt snapshot without numeric rounding', async () => {
  const large = '9007199254740993', f = await fixture(api, large);
  assert.equal(f.run.inputWorkVersion, large); assert.equal(f.grant.inputWorkVersion, large);
  const grant = f.grant;
  const attempt = await api.attempts.create(f.actor, { ...f.attemptInput, grantId: grant.grantId });
  assert.equal(attempt.grant.inputWorkVersion, large); assert.equal(attempt.grant.policyRevision, 'private-work.v1');
  assert.deepEqual(attempt.grant, grant);
  assert.deepEqual(await api.attempts.read(f.actor, { attemptId: attempt.attemptId }), attempt);
  const stored = (await owner.query("SELECT grant_snapshot->>'input_work_version' version FROM execution_attempts WHERE attempt_id=$1", [attempt.attemptId])).rows[0];
  assert.equal(stored.version, large);
});

test('EXEC-ADV direct inserts reject backdated, foreign, NULL, stale and invented original consent bindings', async () => {
  const f = await fixture(), stranger = await fixture();
  for (const overrides of [{ created_at: '2000-01-01T00:00:00.000Z' }, { created_at: 'infinity' }, { created_at: null },
    { owner_user_id: stranger.actor.user_id }, { owner_principal_id: stranger.context.subject_principal.principal_id },
    { scope_id: stranger.context.scope.scope_id }, { runtime_device_id: stranger.runtimeDeviceId },
    { family_id: stranger.initial.refresh.familyId }, { state: 'ready' }, { selection: { ...selection, modelReady: true } },
    { selection: { ...selection, providerRef: null } }])
    await unchangedAfter(f, () => cloneInsert('model_connections', 'model_connection_id', f.model.modelConnectionId, overrides), sqlCode('23514', '23503', '23502'));
  for (const overrides of [{ created_at: '2000-01-01T00:00:00.000Z', expires_at: '2000-01-01T00:30:00.000Z' },
    { created_at: null }, { expires_at: null }, { expires_at: 'infinity' }, { expires_at: new Date(Date.parse(f.grant.issuedAt)+3600001).toISOString() },
    { runtime_version: '2' }, { connection_version: '2' }, { model_version: '2' }, { input_work_version: '2' },
    { run_version: '2' }, { task_lease_epoch: '2' }, { control_epoch: '2' }, { persistence_policy_revision: 'private-work.v2' },
    { selection: { ...selection, billingSource: 'platform' } }, { consent: null }, { consent: false },
    { run_id: stranger.run.runId }, { work_item_id: stranger.workId }, { model_connection_id: stranger.model.modelConnectionId }])
    await unchangedAfter(f, () => cloneInsert('execution_grants', 'grant_id', f.grant.grantId, overrides), sqlCode('23514', '23503', '23502'));
});

for (const kind of ['connection', 'family'] as const) test(`EXEC-ADV real ${kind} revocation wins an observed lock chain and denies the blocked Attempt plus later retries`, async () => {
  const f = await fixture(), original = await api.attempts.create(f.actor, f.attemptInput), holder = await owner.connect();
  // A genuine consumed refresh handle drives the family-reuse revocation path.
  // Connection revocation uses the actual member command and its 091 cascade.
  const reuse = kind === 'family' ? await refreshInput(f) : undefined;
  if (reuse) await sessions.refresh(reuse);
  await holder.query('BEGIN');
  try {
    await holder.query(`LOCK TABLE ${kind === 'connection' ? 'scoped_command_receipts' : 'bootstrap_refresh_families'} IN SHARE MODE`);
    const revocation = kind === 'connection'
      ? createAgentConnections(app, hostOptions).revoke(f.actor, { key: randomUUID(), connectionId: f.initial.connectionId, expectedVersion: '1' })
      : sessions.refresh(reuse!);
    // Family reuse deliberately commits both tombstones before returning401.
    const revoked = kind === 'family' ? assert.rejects(revocation, status(401)) : revocation;
    const revokingBackend = await waiterBehind(holder);
    const pending = api.attempts.create(f.actor, { ...f.attemptInput, key: randomUUID() });
    const denied = assert.rejects(pending, status(409));
    await blockedByBackend(revokingBackend);
    await holder.query('COMMIT'); await revoked; await denied;
  } finally { await holder.query('ROLLBACK'); holder.release(); }
  assert.deepEqual((await owner.query(`SELECT c.state connection,f.state family,c.aggregate_version::text version
    FROM agent_connections c JOIN bootstrap_refresh_families f USING(connection_id) WHERE c.connection_id=$1`, [f.initial.connectionId])).rows[0],
  { connection: 'revoked', family: 'revoked', version: '2' });
  assert.equal((await owner.query('SELECT count(*)::int n FROM execution_attempts WHERE run_id=$1', [f.run.runId])).rows[0].n, 1);
  assert.deepEqual(await api.attempts.read(f.actor, { attemptId: original.attemptId }), original);
  await unchangedAfter(f, () => api.attempts.create(f.actor, f.attemptInput), status(409));
  await unchangedAfter(f, () => api.attempts.create(f.actor, { ...f.attemptInput, key: randomUUID() }), status(409));
  assert.deepEqual(await runs.read(f.actor, { runId: f.run.runId }), f.run);
});

test('EXEC-ADV direct SQL Attempt INSERT remains provisional and deferred COMMIT rejects an expired genuine Grant', async () => {
  const short = createExecutionPrerequisites(app, { ...hostOptions, grantTtlSeconds: 2 }), f = await fixture(short), before = await snapshot(f);
  const q = await app.connect(); await q.query('BEGIN');
  try {
    const inserted = await directAttempt(q, f); assert.equal(inserted.rowCount, 1);
    assert.equal((await q.query('SELECT count(*)::int n FROM execution_attempts WHERE run_id=$1', [f.run.runId])).rows[0].n, 1);
    assert.equal((await owner.query('SELECT count(*)::int n FROM execution_attempts WHERE run_id=$1', [f.run.runId])).rows[0].n, 0);
    await waitUntil(Date.parse(f.grant.expiresAt));
    await assert.rejects(q.query('COMMIT'), sqlCode('23514'));
  } finally { await q.query('ROLLBACK'); q.release(); }
  assert.deepEqual(await snapshot(f), before);
  await unchangedAfter(f, () => short.attempts.create(f.actor, f.attemptInput), status(409));
});

test('EXEC-ADV an allowed policy revision bump invalidates old consent and replay without rewriting original Attempt evidence', async () => {
  const f = await fixture(), attempt = await api.attempts.create(f.actor, f.attemptInput);
  await owner.query('UPDATE private_work_persistence_policy SET revision=revision+1 WHERE scope_id=$1', [f.context.scope.scope_id]);
  assert.equal((await owner.query('SELECT persistence_allowed FROM private_work_persistence_policy WHERE scope_id=$1', [f.context.scope.scope_id])).rows[0].persistence_allowed, true);
  await unchangedAfter(f, () => api.grants.create(f.actor, f.grantInput), status(409));
  await unchangedAfter(f, () => api.attempts.create(f.actor, f.attemptInput), status(409));
  await unchangedAfter(f, () => api.attempts.create(f.actor, { ...f.attemptInput, key: randomUUID() }), status(409));
  const q = await app.connect(); await q.query('BEGIN');
  try { await assert.rejects(directAttempt(q, f), sqlCode('23514')); }
  finally { await q.query('ROLLBACK'); q.release(); }
  assert.deepEqual(await api.grants.read(f.actor, { grantId: f.grant.grantId }), f.grant);
  assert.deepEqual(await api.attempts.read(f.actor, { attemptId: attempt.attemptId }), attempt);
  assert.equal(attempt.grant.policyRevision, 'private-work.v1');
  const grant = await api.grants.create(f.actor, { ...f.grantInput, key: randomUUID() });
  assert.equal(grant.policyRevision, 'private-work.v2');
  const next = await api.attempts.create(f.actor, { ...f.attemptInput, key: randomUUID(), grantId: grant.grantId });
  assert.equal(next.attemptNumber, 2); assert.deepEqual(next.grant, grant);
  assert.deepEqual(await runs.read(f.actor, { runId: f.run.runId }), f.run);
});
