import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPool, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_USERS } from '../../packages/testing/seed.js';
import { pruneExpiredAuthRecords, SESSION_CASCADES, SESSION_REFERENCES } from '../../modules/identity-membership/auth-pruning.js';
import { CompactSign, exportJWK, generateKeyPair } from 'jose';
import { transaction } from '../../packages/db/transaction.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import { login, authenticate } from '../../modules/identity-membership/service.js';
import { createRuntimeRegistrations } from '../../modules/agent-control/runtime-registration.js';
import { parseRuntimePublicJwk } from '../../modules/agent-control/runtime-proof.js';
import { createAgentConnections } from '../../modules/agent-control/agent-connections.js';
import { insertInitialRefreshFamily } from '../../modules/agent-control/bootstrap-session-store.js';
import { createExecutionPrerequisites } from '../../modules/agent-execution/prerequisites.js';
import { createCredentialIngestAuthorizations } from '../../modules/agent-control/credential-ingest-authorizations.js';
import { createModelBrokerAuthorizations } from '../../modules/agent-control/model-broker-authorizations.js';
import { createCredentialVault } from '../../apps/credential-broker/src/vault.js';
import { createBrokerCredentialStore, getCredentialWriteBinding } from '../../apps/credential-broker/src/store.js';
import { createPrivateWorkCommands } from '../../modules/opportunity-project-work/private-commands.js';
import { resolvePrivateWorkPersistencePolicy } from '../../modules/autopilot-work/policy.js';
import { createExecutionRuns } from '../../modules/agent-execution/runs.js';
import { createModelStepService } from '../../modules/agent-execution/model-step-service.js';
import { createUnavailableModelStepHost } from '../../modules/agent-execution/model-step-host.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_auth_pruning_${process.pid}_${Date.now()}`;
const admin = createPool(databaseUrl);
const migrator = `${schema}_owner`;
const runtimeRole = `${schema}_app`;
const roleUrl = (role: string) => { const url = new URL(databaseUrl); url.username = role; url.password = ''; return url.toString(); };
const pool = new Pool({ connectionString: roleUrl(migrator), options: `-c search_path=${schema}`, max: 4 });
const runtime = new Pool({ connectionString: roleUrl(runtimeRole), options: `-c search_path=${schema}`, max: 1 });

async function capturedPrune(options: Parameters<typeof pruneExpiredAuthRecords>[1] = {}, queries: {text: string; values?: unknown[]}[] = []) {
  const captured = new Proxy(runtime, {get(target, key) {
    if (key === 'connect') return async () => {
      const client = await target.connect();
      return new Proxy(client, {get(q, property) {
        if (property === 'query') return (...args: unknown[]) => {
          queries.push({text: args[0] as string, values: args[1] as unknown[] | undefined});
          return Reflect.apply(q.query, q, args);
        };
        const value = Reflect.get(q, property);
        return typeof value === 'function' ? value.bind(q) : value;
      }});
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  }});
  const result = await pruneExpiredAuthRecords(captured, options);
  return {result, queries};
}

async function applyRuntimeGrants() {
  const template = (await readFile(new URL('../../deploy/cloudflare/sql/20-runtime-grants.psql', import.meta.url), 'utf8'))
    .replace(/^\\set .*$/mg, '').replaceAll('SCHEMA public', `SCHEMA ${schema}`)
    .replaceAll("n.nspname='public'", `n.nspname='${schema}'`)
    .replaceAll(':"runtime"', `"${runtimeRole}"`).replaceAll(":'runtime'", `'${runtimeRole}'`);
  const q = await pool.connect();
  try {
    const pieces = template.split('\\gexec');
    for (let i = 0; i < pieces.length; i += 1) {
      const result = await q.query(pieces[i]);
      const last = Array.isArray(result) ? result[result.length - 1] : result;
      if (i < pieces.length - 1) for (const row of last.rows) await q.query(Object.values(row)[0] as string);
    }
  } catch (error) { await q.query('ROLLBACK'); throw error; } finally { q.release(); }
}

before(async () => {
  await admin.query(`CREATE ROLE ${migrator} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE ROLE ${runtimeRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE SCHEMA ${schema} AUTHORIZATION ${migrator}; GRANT USAGE ON SCHEMA ${schema} TO ${runtimeRole}`);
  await migrate(pool);
  await applyRuntimeGrants();
});
after(async () => { await runtime.end(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE; DROP ROLE ${runtimeRole},${migrator}`); await admin.end(); });
beforeEach(async () => {
  await pool.query('TRUNCATE communities, sessions, login_attempts, auth_rate_limits, password_reset_tokens CASCADE');
  await seedLocal(pool);
});

test('auth_rate_limits and login_attempts prune by window_start', async () => {
  await pool.query(`INSERT INTO auth_rate_limits(bucket,attempts,window_start) VALUES('old-arl','5',now()-interval '2 days')`);
  await pool.query(`INSERT INTO auth_rate_limits(bucket,attempts,window_start) VALUES('live-arl','1',now()-interval '1 hour')`);
  await pool.query(`INSERT INTO login_attempts(attempt_key,failures,window_start) VALUES('old-la@example.com','3',now()-interval '2 days')`);
  await pool.query(`INSERT INTO login_attempts(attempt_key,failures,window_start) VALUES('live-la@example.com','1',now()-interval '1 hour')`);
  const result = await pruneExpiredAuthRecords(runtime);
  assert.equal(result.auth_rate_limits, 1);
  assert.equal(result.login_attempts, 1);
  const arl = (await pool.query('SELECT bucket FROM auth_rate_limits ORDER BY bucket')).rows.map(r => r.bucket);
  const la = (await pool.query('SELECT attempt_key FROM login_attempts ORDER BY attempt_key')).rows.map(r => r.attempt_key);
  assert.deepEqual(arl, ['live-arl']);
  assert.deepEqual(la, ['live-la@example.com']);
});

test('password_reset_tokens prune by expires_at', async () => {
  const oldHash = 'a'.repeat(64);
  const liveHash = 'b'.repeat(64);
  await pool.query(`INSERT INTO password_reset_tokens(token_hash,user_id,created_at,expires_at)
    VALUES($1,$2,now()-interval '3 days',now()-interval '2 days')`,[oldHash, DEMO_USERS[0].user_id]);
  await pool.query(`INSERT INTO password_reset_tokens(token_hash,user_id,created_at,expires_at)
    VALUES($1,$2,now(),now()+interval '1 hour')`,[liveHash, DEMO_USERS[0].user_id]);
  const result = await pruneExpiredAuthRecords(runtime);
  assert.equal(result.password_reset_tokens, 1);
  const hashes = (await pool.query('SELECT token_hash FROM password_reset_tokens')).rows.map(r => r.token_hash);
  assert.deepEqual(hashes, [liveHash]);
});

test('sessions keep the newest per user but prune older expired/revoked rows', async () => {
  const u1 = DEMO_USERS[0].user_id;
  const u2 = DEMO_USERS[1].user_id;
  await pool.query(`INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,revoked_at,last_seen_at,created_at) VALUES
    ('old-u1',$1,'c',now()-interval '40 days',NULL,now()-interval '40 days',now()-interval '40 days'),
    ('revoked-u1',$1,'c',now()+interval '10 days',now()-interval '2 days',now()-interval '3 days',now()-interval '3 days'),
    ('live-u1',$1,'c',now()+interval '10 days',NULL,now(),now())`,[u1]);
  await pool.query(`INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,revoked_at,last_seen_at,created_at) VALUES
    ('only-u2',$1,'c',now()-interval '40 days',NULL,now()-interval '40 days',now()-interval '40 days')`,[u2]);
  const result = await pruneExpiredAuthRecords(runtime);
  assert.equal(result.sessions, 2);
  const remaining = (await pool.query('SELECT token_hash FROM sessions ORDER BY token_hash')).rows.map(r => r.token_hash);
  assert.deepEqual(remaining, ['live-u1', 'only-u2']);
});

test('batch limit bounds a per-run delete and second call clears the remainder', async () => {
  for (let i = 0; i < 5; i += 1) {
    await pool.query(`INSERT INTO auth_rate_limits(bucket,attempts,window_start) VALUES($1,'1',now()-interval '2 days')`,[`stale-${i}`]);
  }
  const first = await pruneExpiredAuthRecords(runtime, {batch: 2});
  assert.equal(first.auth_rate_limits, 2);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM auth_rate_limits WHERE window_start < now() - interval '1 day'`)).rows[0].n, 3);
  const second = await pruneExpiredAuthRecords(runtime, {batch: 2});
  assert.equal(second.auth_rate_limits, 2);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM auth_rate_limits WHERE window_start < now() - interval '1 day'`)).rows[0].n, 1);
});

test('a run with nothing stale returns all four counts as zero', async () => {
  const result = await pruneExpiredAuthRecords(runtime);
  assert.deepEqual(result, {sessions: 0, login_attempts: 0, auth_rate_limits: 0, password_reset_tokens: 0});
});

test('sessions with equal or missing timestamps still keep exactly one row per user', async () => {
  const u = DEMO_USERS[2].user_id;
  await pool.query(`INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,revoked_at,last_seen_at,created_at) VALUES
    ('tie-a',$1,'c',now()-interval '40 days',NULL,now()-interval '41 days',now()-interval '41 days'),
    ('tie-b',$1,'c',now()-interval '40 days',NULL,now()-interval '41 days',now()-interval '41 days'),
    ('null-a',$1,'c',now()-interval '40 days',NULL,NULL,NULL)`,[u]);
  assert.equal((await pruneExpiredAuthRecords(runtime)).sessions, 2);
  assert.deepEqual((await pool.query('SELECT token_hash FROM sessions WHERE user_id=$1',[u])).rows.map(r => r.token_hash), ['tie-b']);
});

test('a stale session still referenced by a non-cascading foreign key is kept instead of failing the batch', async () => {
  const u = DEMO_USERS[0].user_id;
  await pool.query(`INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_seen_at) VALUES
    ('ref-old',$1,'c',now()-interval '40 days',now()-interval '40 days'),
    ('free-old',$1,'c',now()-interval '40 days',now()-interval '41 days'),
    ('live',$1,'c',now()+interval '10 days',now())`,[u]);
  await createVerification(u, 'ref-old');
  // Context-free RLS hides the reference, but the FK rejects the whole batch.
  await assert.rejects(runtime.query(`DELETE FROM sessions WHERE token_hash IN ('ref-old','free-old')`),
    (error: {code?: string}) => error.code === '23503');
  assert.equal((await pool.query(`SELECT token_hash FROM sessions WHERE token_hash='free-old'`)).rowCount, 1);
  assert.equal((await pool.query(`SELECT token_hash FROM sessions WHERE token_hash IN ('ref-old','free-old')`)).rowCount, 2);
  assert.equal((await pruneExpiredAuthRecords(runtime)).sessions, 1);
  assert.deepEqual((await pool.query('SELECT token_hash FROM sessions WHERE user_id=$1 ORDER BY token_hash',[u])).rows.map(r => r.token_hash), ['live', 'ref-old']);
});

test('every foreign key to sessions is either excluded from pruning or an intended cascade', async () => {
  // A new reference to sessions fails here until auth-pruning.ts classifies it; a non-cascading one would make every session batch fail.
  const rows = (await pool.query(`SELECT c.conrelid::regclass::text AS tbl, a.attname AS col, c.confdeltype='c' AS cascade FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
    WHERE c.contype='f' AND c.confrelid='sessions'::regclass ORDER BY 1,2`)).rows;
  assert.deepEqual(rows.filter(r => !r.cascade).map(r => [r.tbl, r.col]), SESSION_REFERENCES.map(([t, c]) => [t, c]));
  assert.deepEqual(rows.filter(r => r.cascade).map(r => [r.tbl, r.col]), SESSION_CASCADES.map(([t, c]) => [t, c]));
});

async function createVerification(user: string, session: string) {
  const principal = randomUUID();
  const tenant = randomUUID();
  const q = await pool.connect();
  try {
    await q.query('BEGIN');
    await q.query(`INSERT INTO principals(principal_id,kind,user_ref) VALUES($1,'person',$2)`, [principal,user]);
    await q.query(`INSERT INTO tenants(tenant_id,community_id,display_name,created_by_principal_id)
      VALUES($1,(SELECT community_id FROM users WHERE user_id=$2),'Prune fixture',$3)`, [tenant,user,principal]);
    await q.query(`INSERT INTO tenant_memberships(tenant_id,principal_id,role,status,accepted_at)
      VALUES($1,$2,'owner','active',now())`, [tenant,principal]);
    await q.query(`INSERT INTO tenant_high_risk_verifications(user_id,principal_id,session_hash,tenant_id,purpose,expires_at)
      VALUES($1,$2,$3,$4,'tenant.ownership.propose',now()+interval '10 minutes')`, [user,principal,session,tenant]);
    await q.query('COMMIT');
  } catch (error) { await q.query('ROLLBACK'); throw error; } finally { q.release(); }
}

async function retainedHistoryBytes() {
  return Promise.all(['tenant_high_risk_verifications','model_broker_authorizations','credential_ingest_authorizations'].map(async table =>
    (await pool.query(`SELECT row_to_json(r)::text AS bytes FROM ${table} r ORDER BY 1`)).rows));
}

async function verificationSessions(count: number) {
  for (let i = 0; i < count; i += 1) {
    const user = DEMO_USERS[i].user_id;
    await pool.query(`INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_seen_at) VALUES
      ($1,$3,'c',now()-interval '40 days',now()-interval '40 days'),
      ($2,$3,'c',now()+interval '10 days',now())`, [`ref-${i}`,`live-${i}`,user]);
    await createVerification(user, `ref-${i}`);
  }
}

// Issue real authorization rows while the member session is fresh, then age the
// session. This keeps the immutable authorization triggers and foreign keys active.
async function referencedAuthorizationSession() {
  const options = {environment: 'local' as const, clientId: 'prune-fixture'};
  const recover = async () => ({generation: '1', expiresAt: new Date(Date.now()+60_000).toISOString()});
  const signed = await login(pool, DEMO_USERS[2].email, 'freedom-local-demo');
  const actor = await authenticate(pool, signed.token);
  const context = await withMemberScope(pool, {actor,scope: 'personal'}, async () => {}, async (_q,c) => c);
  await pool.query(`INSERT INTO private_work_persistence_policy(scope_id,purpose,owner_principal_id,revision,persistence_allowed,retained_byte_limit)
    VALUES($1,'work.private-draft',$2,1,true,10485760)`, [context.scope.scope_id,context.subject_principal.principal_id]);
  await withMemberScope(pool, {actor,scope: 'personal'}, async () => {}, async () => {});
  const enrollment = createRuntimeRegistrations(pool, {environment: options.environment});
  const key = await generateKeyPair('ES256', {extractable: true});
  const challenge = await enrollment.begin(actor, {key: randomUUID(),publicJwk: parseRuntimePublicJwk(await exportJWK(key.publicKey))});
  const proof = await new CompactSign(new TextEncoder().encode(challenge.payload))
    .setProtectedHeader({alg: 'ES256',typ: 'freedom-runtime-enrollment+jws'}).sign(key.privateKey);
  const device = await enrollment.confirm(actor, {key: randomUUID(),challengeId: challenge.challenge_id,proof});
  const connection = await createAgentConnections(pool, options).create(actor, {key: randomUUID(),runtimeDeviceId: device.runtimeDeviceId});
  await transaction(pool, q => insertInitialRefreshFamily(q, connection.connectionId, new Date(connection.issuedAt), new Date(connection.expiresAt)));
  const selection = {providerRef: 'openai',modelRef: 'synthetic-model',processingLocation: 'provider_remote',
    artifactCustody: 'platform_asset' as const,credentialCustody: 'platform_vault' as const,engineLocation: 'platform' as const,billingSource: 'user_byok' as const};
  const prerequisites = createExecutionPrerequisites(pool, options);
  const model = await prerequisites.models.create(actor, {key: randomUUID(),connectionId: connection.connectionId,expectedConnectionVersion: '1',selection});
  await createCredentialIngestAuthorizations(pool, {...options,issuer: 'prune-main',audience: 'prune-broker',setupOrigin: 'https://broker.example.invalid',recover}).issue(actor, {
    command: {operation: 'create',input: {key: randomUUID(),modelConnectionId: model.modelConnectionId,expectedModelVersion: '1',consent: true}},nonce: randomBytes(32).toString('base64url'),
  });
  const kek = await crypto.subtle.generateKey({name: 'AES-GCM',length: 256}, false, ['encrypt','decrypt']);
  const vault = createCredentialVault({kek: {current: async () => ({keyId: 'synthetic-prune-kek',key: kek}),readById: async () => kek},recover});
  const store = createBrokerCredentialStore(pool, {...options,vault,recover});
  const intent = await store.prepareCreate(actor, {key: randomUUID(),modelConnectionId: model.modelConnectionId,expectedModelVersion: '1',consent: true});
  await store.commit(actor, intent, await vault.seal(getCredentialWriteBinding(intent), new TextEncoder().encode('synthetic-prune-key')));
  const work = await createPrivateWorkCommands(pool, {resolvePolicy: resolvePrivateWorkPersistencePolicy}).create(actor, {key: randomUUID(),title: 'Prune fixture',objective: 'Retain authorization history'});
  const run = await createExecutionRuns(pool).create(actor, {key: randomUUID(),workId: work.workId,expectedWorkVersion: '1'});
  const grant = await prerequisites.grants.create(actor, {key: randomUUID(),runId: run.runId,expectedRunVersion: '1',expectedWorkVersion: '1',connectionId: connection.connectionId,expectedConnectionVersion: '1',modelConnectionId: model.modelConnectionId,expectedModelVersion: '1',consent: true});
  await pool.query(`INSERT INTO model_inference_export_policy(policy_id,scope_id,owner_principal_id,environment,client_id,selection,revision,export_allowed,max_prompt_bytes,max_output_tokens)
    VALUES($1,$2,$3,$4,$5,$6,1,true,16384,20)`, [randomUUID(),context.scope.scope_id,context.subject_principal.principal_id,options.environment,options.clientId,JSON.stringify(selection)]);
  const approval = await createModelStepService(pool, {...options,host: createUnavailableModelStepHost()}).approvals.create(actor, {key: randomUUID(),runId: run.runId,grantId: grant.grantId,expectedRunVersion: '1',expectedGrantVersion: '1',expectedWorkVersion: '1',consent: true,maxOutputTokens: 20});
  await createModelBrokerAuthorizations(pool, {...options,issuer: 'prune-main',audience: 'prune-broker',recover}).issue(actor, {
    operation: 'activate',command: {operation: 'activate',input: {key: randomUUID(),approvalId: approval.approvalId,expectedApprovalVersion: '1',expectedRunVersion: '1'}},nonce: randomBytes(32).toString('base64url'),
  });
  await pool.query(`UPDATE sessions SET expires_at=now()-interval '40 days',last_seen_at=now()-interval '40 days',created_at=now()-interval '41 days' WHERE token_hash=$1`, [actor.session_hash]);
  await pool.query(`INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_seen_at) VALUES('live-auth',$1,'c',now()+interval '10 days',now())`, [actor.user_id]);
  return actor.session_hash;
}

test('context-free runtime prune keeps both tenants verification history and clears unreferenced expired sessions', async () => {
  const who = (await runtime.query(`SELECT current_user, session_user, rolsuper, rolbypassrls
    FROM pg_roles WHERE rolname=current_user`)).rows[0];
  assert.deepEqual(who, {current_user: runtimeRole, session_user: runtimeRole, rolsuper: false, rolbypassrls: false});
  const security = (await pool.query(`SELECT pg_get_userbyid(relowner) AS owner, relrowsecurity, relforcerowsecurity
    FROM pg_class WHERE oid='tenant_high_risk_verifications'::regclass`)).rows[0];
  assert.deepEqual(security, {owner: migrator, relrowsecurity: true, relforcerowsecurity: false});
  assert.equal((await runtime.query(`SELECT freedom_ctx_tenant() AS tenant`)).rows[0].tenant, null);
  for (let i = 0; i < 2; i += 1) {
    const user = DEMO_USERS[i].user_id;
    await pool.query(`INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_seen_at) VALUES
      ($1,$4,'c',now()-interval '40 days',now()-interval '40 days'),
      ($2,$4,'c',now()-interval '40 days',now()-interval '41 days'),
      ($3,$4,'c',now()+interval '10 days',now())`, [`ref-${i}`,`free-${i}`,`live-${i}`,user]);
    await createVerification(user, `ref-${i}`);
  }
  const authSession = await referencedAuthorizationSession();
  const authorizations = await Promise.all(['model_broker_authorizations','credential_ingest_authorizations'].map(async table => {
    const rows = (await pool.query(`SELECT * FROM ${table} ORDER BY authorization_id`)).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].original_session_hash, authSession);
    assert.equal((await runtime.query(`SELECT * FROM ${table}`)).rowCount, 1);
    return rows;
  }));
  const history = (await pool.query('SELECT * FROM tenant_high_risk_verifications ORDER BY verification_id')).rows;
  const historyBytes = await retainedHistoryBytes();
  assert.equal(history.length, 2);
  assert.equal((await runtime.query('SELECT * FROM tenant_high_risk_verifications')).rowCount, 0);
  await pool.query(`INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_seen_at)
    VALUES('free-extra',$1,'c',now()-interval '40 days',now()-interval '42 days')`, [DEMO_USERS[0].user_id]);
  await pool.query(`INSERT INTO login_attempts(attempt_key,failures,window_start) VALUES('stale',1,now()-interval '2 days')`);
  await pool.query(`INSERT INTO auth_rate_limits(bucket,attempts,window_start) VALUES('stale',1,now()-interval '2 days')`);
  await pool.query(`INSERT INTO password_reset_tokens(token_hash,user_id,created_at,expires_at) VALUES($1,$2,now()-interval '3 days',now()-interval '2 days')`, ['c'.repeat(64),DEMO_USERS[0].user_id]);
  for (const table of ['login_attempts','auth_rate_limits','password_reset_tokens']) {
    const acl = (await runtime.query(`SELECT has_table_privilege(current_user,$1,'SELECT') AS read,
      has_table_privilege(current_user,$1,'UPDATE') AS lock, has_table_privilege(current_user,$1,'DELETE') AS prune`, [table])).rows[0];
    assert.deepEqual(acl, {read: true, lock: true, prune: true});
  }
  const first = await capturedPrune();
  assert.deepEqual(first.result, {sessions: 3, login_attempts: 1, auth_rate_limits: 1, password_reset_tokens: 1});
  const attempted = first.queries.filter(q => q.text === 'DELETE FROM sessions WHERE token_hash = $1').map(q => q.values?.[0]);
  assert.deepEqual(attempted.slice().sort(), ['free-0','free-1','free-extra','ref-0','ref-1']);
  assert(!attempted.includes(authSession));
  assert.deepEqual((await pool.query('SELECT token_hash FROM sessions ORDER BY token_hash')).rows.map(r => r.token_hash), [authSession,'live-0','live-1','live-auth','ref-0','ref-1'].sort());
  assert.deepEqual((await pool.query('SELECT * FROM tenant_high_risk_verifications ORDER BY verification_id')).rows, history);
  for (const [i,table] of ['model_broker_authorizations','credential_ingest_authorizations'].entries()) {
    assert.deepEqual((await pool.query(`SELECT * FROM ${table} ORDER BY authorization_id`)).rows, authorizations[i]);
  }
  assert.deepEqual(await retainedHistoryBytes(), historyBytes);
  const markers = (await pool.query('SELECT token_hash,prune_retained_at,prune_retained_at::text AS marker FROM sessions ORDER BY token_hash')).rows;
  for (const row of markers) {
    if (row.token_hash.startsWith('ref-')) assert(row.prune_retained_at instanceof Date);
    else assert.equal(row.prune_retained_at, null);
  }
  const second = await capturedPrune();
  assert.deepEqual(second.result, {sessions: 0, login_attempts: 0, auth_rate_limits: 0, password_reset_tokens: 0});
  assert(!second.queries.some(q => q.text === 'SAVEPOINT auth_prune_session'));
  assert.deepEqual((await pool.query('SELECT token_hash,prune_retained_at,prune_retained_at::text AS marker FROM sessions ORDER BY token_hash')).rows, markers);
  assert.deepEqual(await retainedHistoryBytes(), historyBytes);
});

test('session maintenance bounds batches and skips locked candidates', async () => {
  await pool.query(`INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_seen_at)
    SELECT 'batch-'||lpad(i::text,4,'0'),$1,'c',now()-interval '40 days',now()-interval '40 days' FROM generate_series(1,1005) i`, [DEMO_USERS[0].user_id]);
  await pool.query(`INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_seen_at) VALUES('live',$1,'c',now()+interval '10 days',now())`, [DEMO_USERS[0].user_id]);
  const q = await pool.connect();
  try {
    await q.query('BEGIN');
    await q.query(`SELECT token_hash FROM sessions WHERE token_hash='batch-0001' FOR UPDATE`);
    const call = async (batch?: number) => (await pruneExpiredAuthRecords(runtime, {batch})).sessions;
    assert.equal(await call(1000), 1000);
    assert.equal(await call(1), 1);
    assert.equal(await call(1), 1);
    assert.equal(await call(), 2);
    assert.equal(await call(500), 0);
    assert.deepEqual((await pool.query('SELECT token_hash FROM sessions ORDER BY token_hash')).rows.map(r => r.token_hash), ['batch-0001','live']);
    await q.query('COMMIT');
    assert.equal(await call(500), 1);
  } finally { await q.query('ROLLBACK'); q.release(); }
});

test('retained markers let a small batch reach an unreferenced session', async () => {
  const referenced = 3;
  const batch = 2;
  await verificationSessions(referenced);
  await pool.query(`INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_seen_at)
    VALUES('free',$1,'c',now()-interval '40 days',now()-interval '41 days')`, [DEMO_USERS[0].user_id]);
  const history = await retainedHistoryBytes();
  // Each run marks or deletes its candidates; one extra run observes steady state.
  const bound = Math.ceil((referenced+1)/batch)+1;
  let deleted = 0;
  for (let i = 0; i < bound; i += 1) deleted += (await pruneExpiredAuthRecords(runtime, {batch})).sessions;
  assert.equal(bound, 3);
  assert.equal(deleted, 1);
  assert.equal((await pool.query(`SELECT * FROM sessions WHERE token_hash='free'`)).rowCount, 0);
  const rows = (await pool.query(`SELECT token_hash,prune_retained_at FROM sessions WHERE token_hash LIKE 'ref-%' ORDER BY token_hash`)).rows;
  assert.deepEqual(rows.map(r => r.token_hash), ['ref-0','ref-1','ref-2']);
  assert(rows.every(r => r.prune_retained_at instanceof Date));
  assert.deepEqual(await retainedHistoryBytes(), history);
});

test('retained sessions are rechecked after 30 days while younger markers stay unchanged', async () => {
  await verificationSessions(2);
  assert.equal((await pruneExpiredAuthRecords(runtime)).sessions, 0);
  await pool.query(`UPDATE sessions SET prune_retained_at=now()-interval '31 days' WHERE token_hash='ref-0'`);
  await pool.query(`UPDATE sessions SET prune_retained_at=now()-interval '29 days' WHERE token_hash='ref-1'`);
  const before = (await pool.query(`SELECT token_hash,prune_retained_at::text AS marker FROM sessions WHERE token_hash LIKE 'ref-%' ORDER BY token_hash`)).rows;
  const history = await retainedHistoryBytes();
  const {result, queries} = await capturedPrune();
  assert.equal(result.sessions, 0);
  assert.deepEqual(queries.filter(q => q.text === 'DELETE FROM sessions WHERE token_hash = $1').map(q => q.values?.[0]), ['ref-0']);
  assert.deepEqual(queries.filter(q => q.text === 'UPDATE sessions SET prune_retained_at = now() WHERE token_hash = $1').map(q => q.values?.[0]), ['ref-0']);
  const after = (await pool.query(`SELECT token_hash,prune_retained_at::text AS marker,prune_retained_at > now()-interval '1 minute' AS fresh FROM sessions WHERE token_hash LIKE 'ref-%' ORDER BY token_hash`)).rows;
  assert.notEqual(after[0].marker, before[0].marker);
  assert.equal(after[0].fresh, true);
  assert.equal(after[1].marker, before[1].marker);
  assert.deepEqual(await retainedHistoryBytes(), history);
});

test('a non-FK batch error propagates and rolls back every session delete', async () => {
  await pool.query(`INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_seen_at) VALUES
    ('free',$1,'c',now()-interval '40 days',now()-interval '40 days'),
    ('live',$1,'c',now()+interval '10 days',now())`, [DEMO_USERS[0].user_id]);
  const before = (await pool.query('SELECT row_to_json(s)::text AS bytes FROM sessions s ORDER BY token_hash')).rows;
  await pool.query(`CREATE FUNCTION prune_test_error() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic prune failure' USING ERRCODE='P0001'; END; $$;
    CREATE TRIGGER prune_test_error BEFORE DELETE ON sessions FOR EACH ROW EXECUTE FUNCTION prune_test_error()`);
  const queries: {text: string; values?: unknown[]}[] = [];
  try {
    await assert.rejects(capturedPrune({}, queries), (error: {code?: string}) => error.code === 'P0001');
    assert(!queries.some(q => q.text === 'SAVEPOINT auth_prune_session'));
    assert.equal(queries.at(-1)?.text, 'ROLLBACK');
    assert.deepEqual((await pool.query('SELECT row_to_json(s)::text AS bytes FROM sessions s ORDER BY token_hash')).rows, before);
  } finally { await pool.query('DROP TRIGGER prune_test_error ON sessions; DROP FUNCTION prune_test_error()'); }
});

test('a non-FK fallback error propagates and rolls back prior deletes and retained markers', async () => {
  await verificationSessions(1);
  await pool.query(`INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_seen_at) VALUES
    ('free',$1,'c',now()-interval '40 days',now()-interval '41 days'),
    ('error',$1,'c',now()-interval '40 days',now()-interval '42 days')`, [DEMO_USERS[0].user_id]);
  const before = (await pool.query('SELECT row_to_json(s)::text AS bytes FROM sessions s ORDER BY token_hash')).rows;
  const history = await retainedHistoryBytes();
  // The multi-row fast path reaches the real FK; only the single-row retry raises.
  await pool.query(`CREATE FUNCTION prune_test_error() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF (SELECT count(*) FROM deleted_rows)=1 AND EXISTS(SELECT 1 FROM deleted_rows WHERE token_hash='error') THEN
        RAISE EXCEPTION 'synthetic prune failure' USING ERRCODE='P0001';
      END IF;
      RETURN NULL;
    END; $$;
    CREATE TRIGGER prune_test_error AFTER DELETE ON sessions REFERENCING OLD TABLE AS deleted_rows
      FOR EACH STATEMENT EXECUTE FUNCTION prune_test_error()`);
  const queries: {text: string; values?: unknown[]}[] = [];
  try {
    await assert.rejects(capturedPrune({}, queries), (error: {code?: string}) => error.code === 'P0001');
    assert(queries.some(q => q.text === 'UPDATE sessions SET prune_retained_at = now() WHERE token_hash = $1' && q.values?.[0] === 'ref-0'));
    assert.deepEqual(queries.filter(q => q.text === 'DELETE FROM sessions WHERE token_hash = $1').map(q => q.values?.[0]), ['ref-0','free','error']);
    assert.equal(queries.at(-1)?.text, 'ROLLBACK');
    assert.deepEqual((await pool.query('SELECT row_to_json(s)::text AS bytes FROM sessions s ORDER BY token_hash')).rows, before);
    assert.deepEqual(await retainedHistoryBytes(), history);
  } finally { await pool.query('DROP TRIGGER prune_test_error ON sessions; DROP FUNCTION prune_test_error()'); }
});

test('sessionReferences preserves the PR override and rejects invalid identifiers before pruning', async () => {
  await verificationSessions(1);
  // Omitting the visible exclusion still cannot bypass the actual FK.
  assert.equal((await pruneExpiredAuthRecords(runtime, {sessionReferences: []})).sessions, 0);
  assert((await pool.query(`SELECT prune_retained_at FROM sessions WHERE token_hash='ref-0'`)).rows[0].prune_retained_at instanceof Date);
  await pool.query(`INSERT INTO auth_rate_limits(bucket,attempts,window_start) VALUES('stale',1,now()-interval '2 days')`);
  for (const reference of [['sessions; DELETE FROM sessions','token_hash'],['sessions','token_hash)']] as const) {
    await assert.rejects(pruneExpiredAuthRecords(runtime, {sessionReferences: [reference]}), /invalid_session_reference/);
  }
  assert.equal((await pool.query(`SELECT * FROM auth_rate_limits WHERE bucket='stale'`)).rowCount, 1);
});
