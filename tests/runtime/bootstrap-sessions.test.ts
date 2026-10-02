import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { CompactSign, exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { migrate } from '../../scripts/database.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import type { Actor } from '../../modules/identity-membership/service.js';
import { createDeviceAuthorizations } from '../../modules/agent-control/device-authorizations.js';
import { createBootstrapSessions } from '../../modules/agent-control/bootstrap-sessions.js';
import { createBootstrapStatus } from '../../modules/agent-control/bootstrap-status.js';
import { createRuntimeRegistrationChallenge, parseRuntimePublicJwk } from '../../modules/agent-control/runtime-proof.js';
import { BootstrapRefreshResultSchema, type BootstrapSessionHost } from '../../contracts/execution/v1/bootstrap-session.js';
import { Problem } from '../../packages/shared/problem.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname)) throw new Error('Explicit isolated fp_* TEST_DATABASE_URL required.');
const schema = `fp_sessions_${process.pid}_${Date.now()}`, migrator = `${schema}_owner`, runtime = `${schema}_app`;
const admin = new Pool({ connectionString });
function roleUrl(role: string) { const url = new URL(connectionString!); url.username = role; url.password = ''; return url.toString(); }
const owner = new Pool({ connectionString: roleUrl(migrator), options: `-c search_path=${schema}` });
const app = new Pool({ connectionString: roleUrl(runtime), options: `-c search_path=${schema}` });
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

test('SESSION lifecycle retains one head, issues new status nonce, and committed spent reuse revokes all tokens', async () => {
  const user = randomUUID(), community = randomUUID(), session = randomUUID();
  await owner.query("INSERT INTO communities VALUES($1,'Synthetic session owner')", [community]);
  const row = (await owner.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic owner','not-a-login',$4) RETURNING *`, [user, community, user+'@example.invalid', randomUUID()])).rows[0];
  await owner.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')", [session, user]);
  const actor: Actor = { ...row, session_hash: session, csrf_token: 'synthetic' };
  await withMemberScope(app, { actor, scope: 'personal' }, async () => {}, async () => {});
  const device = await generateKeyPair('ES256'), issuer = await generateKeyPair('ES256');
  const publicJwk = parseRuntimePublicJwk(await exportJWK(device.publicKey));
  const host: BootstrapSessionHost = { environment: 'local', clientId: 'session-test', issuerKid: 'issuer',
    issuer: 'https://issuer.example/', audience: 'https://platform.example/', bootstrapUri: 'https://platform.example/execution-api/v1/bootstrap',
    refreshUri: 'https://platform.example/session/refresh', nonceUri: 'https://platform.example/session/nonce',
    keys: [{ kid: 'issuer', purpose: 'bootstrap_access', environment: 'local', publicJwk: parseRuntimePublicJwk(await exportJWK(issuer.publicKey)),
      notBeforeMs: Date.now()-3600000, notAfterMs: Date.now()+3600000, revoked: false }] };
  const { refreshUri, nonceUri, ...base } = host;
  const pairingHost = { ...base, beginUri: 'https://platform.example/device/begin', pollUri: 'https://platform.example/device/poll',
    verificationUri: 'https://platform.example/device', clientDisplayName: 'Synthetic session device' };
  const pairing = await createDeviceAuthorizations(app, { host: pairingHost, signingKey: issuer.privateKey });
  const api = await createBootstrapSessions(app, { host, signingKey: issuer.privateKey });
  const hash = (value: string) => createHash('sha256').update(value, 'ascii').digest('base64url');
  const sign = (typ: string, claims: Record<string, unknown>) => new CompactSign(new TextEncoder().encode(JSON.stringify(claims)))
    .setProtectedHeader({ alg: 'ES256', typ, jwk: publicJwk }).sign(device.privateKey);
  const pairClaims = { client_id: host.clientId, environment: 'local', runtime_kind: 'agent-kit', scope: 'bootstrap.status.read', htm: 'POST' };
  const started = await pairing.begin({ publicJwk, runtimeKind: 'agent-kit', proof: await sign('freedom-device-pairing+jwt', {
    ...pairClaims, purpose: 'device_pairing_begin', jti: randomUUID(), iat: Math.floor(Date.now()/1000), htu: pairingHost.beginUri }) });
  await pairing.decide(actor, { key: randomUUID(), userCode: started.userCode, authorizationId: started.authorizationId, requestDigest: started.requestDigest, decision: 'approve' });
  const enrollment = (await owner.query('SELECT c.* FROM runtime_registration_challenges c JOIN device_authorizations a USING(challenge_id) WHERE a.authorization_id=$1', [started.authorizationId])).rows[0];
  const challenge = createRuntimeRegistrationChallenge({ challenge_id: enrollment.challenge_id, runtime_device_id: enrollment.runtime_device_id,
    owner_member_id: enrollment.owner_user_id, owner_principal_id: enrollment.owner_principal_id, scope_id: enrollment.scope_id,
    environment: enrollment.environment, key_thumbprint: enrollment.key_thumbprint, nonce: enrollment.nonce,
    issued_at: enrollment.issued_at.toISOString(), expires_at: enrollment.expires_at.toISOString() });
  const initial = await pairing.poll({ authorizationId: started.authorizationId, deviceCode: started.deviceCode,
    enrollmentProof: await new CompactSign(new TextEncoder().encode(challenge.payload)).setProtectedHeader({ alg: 'ES256', typ: 'freedom-runtime-enrollment+jws' }).sign(device.privateKey),
    proof: await sign('freedom-device-pairing+jwt', { ...pairClaims, purpose: 'device_pairing_poll', jti: randomUUID(), iat: Math.floor(Date.now()/1000),
      htu: pairingHost.pollUri, authorization_id: started.authorizationId, request_digest: started.requestDigest, nonce: started.nonce, device_code_hash: hash(started.deviceCode) }) });
  assert.equal(initial.status, 'issued'); if (initial.status !== 'issued') throw Error('Expected issued');
  assert.equal(initial.refresh.generation, '1'); assert.equal(initial.refreshSupported, true);
  const refreshInput = { familyId: initial.refresh.familyId, refreshHandle: initial.refresh.handle,
    proof: await sign('freedom-bootstrap-refresh+jwt', { purpose: 'bootstrap_refresh', client_id: host.clientId, environment: 'local', connection_id: initial.connectionId,
      family_id: initial.refresh.familyId, generation: '1', refresh_handle_hash: hash(initial.refresh.handle), jti: randomUUID(), iat: Math.floor(Date.now()/1000), htm: 'POST', htu: refreshUri }) };
  const rotated = await api.refresh(refreshInput); assert.deepEqual(BootstrapRefreshResultSchema.parse(rotated), rotated);
  assert.equal(rotated.refresh.generation, '2'); assert.equal(rotated.refresh.expiresAt, initial.refresh.expiresAt);
  const acquired = await api.nonce({ connectionId: initial.connectionId, accessToken: rotated.accessToken,
    proof: await sign('freedom-bootstrap-nonce+jwt', { purpose: 'bootstrap_nonce', client_id: host.clientId, environment: 'local', connection_id: initial.connectionId,
      jti: randomUUID(), iat: Math.floor(Date.now()/1000), htm: 'POST', htu: nonceUri, ath: hash(rotated.accessToken) }) });
  const { issuerKid: _kid, ...statusHost } = base;
  const status = createBootstrapStatus(app, statusHost);
  const resourceProof = await sign('dpop+jwt', { jti: randomUUID(), iat: Math.floor(Date.now()/1000), htm: 'GET', htu: host.bootstrapUri,
    ath: hash(rotated.accessToken), nonce: acquired.nonce });
  assert.equal((await status.read({ connectionId: initial.connectionId, nonceId: acquired.nonceId, accessToken: rotated.accessToken, proof: resourceProof })).operation, 'bootstrap.status.read');
  const invalid = (error: unknown) => error instanceof Problem && error.status === 401 && error.code === 'bootstrap_invalid';
  await assert.rejects(api.refresh(refreshInput), invalid);
  assert.deepEqual((await owner.query('SELECT state,aggregate_version::text FROM agent_connections WHERE connection_id=$1', [initial.connectionId])).rows[0], { state: 'revoked', aggregate_version: '2' });
  assert.equal((await owner.query('SELECT state FROM bootstrap_refresh_families WHERE family_id=$1', [initial.refresh.familyId])).rows[0].state, 'revoked');
  await assert.rejects(status.read({ connectionId: initial.connectionId, nonceId: initial.nonce.nonceId, accessToken: initial.accessToken,
    proof: await sign('dpop+jwt', { jti: randomUUID(), iat: Math.floor(Date.now()/1000), htm: 'GET', htu: host.bootstrapUri, ath: hash(initial.accessToken), nonce: initial.nonce.nonce }) }), invalid);
  const tables = (await owner.query('SELECT tablename FROM pg_tables WHERE schemaname=current_schema()')).rows;
  for (const { tablename } of tables) {
    const persisted = JSON.stringify((await owner.query(`SELECT * FROM "${tablename}"`)).rows);
    for (const secret of [initial.refresh.handle, rotated.refresh.handle, initial.accessToken, rotated.accessToken, refreshInput.proof]) assert(!persisted.includes(secret), tablename);
  }
});
