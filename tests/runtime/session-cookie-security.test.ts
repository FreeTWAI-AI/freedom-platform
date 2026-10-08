import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { createPool, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_USERS, DEMO_PASSWORD, DEMO_COMMUNITY } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { Hono } from 'hono';
import { createPrivateWorkTransport } from '../../apps/platform-api/src/routes/private-work-transport.js';
import { createMemberExecutionHttpTransport } from '../../apps/platform-api/src/routes/member-execution-http.js';
import { createMemberModelHttpTransport } from '../../apps/platform-api/src/routes/member-model-http.js';
import { createMemberModelSettingsHttpTransport } from '../../apps/platform-api/src/routes/member-model-settings-http.js';
import { createMemberCredentialIngestHttpTransport } from '../../apps/platform-api/src/routes/member-credential-ingest-http.js';
import { createBootstrapHttpTransport } from '../../apps/platform-api/src/routes/bootstrap-http.js';
import { createCredentialIngestClient } from '../../apps/platform-api/src/credential-ingest-client.js';
import { createCredentialIngestAuthorizations } from '../../modules/agent-control/credential-ingest-authorizations.js';
import { createUnavailableModelStepHost } from '../../modules/agent-execution/model-step-host.js';
import { resolvePrivateWorkPersistencePolicy } from '../../modules/autopilot-work/policy.js';
import { FakeObjectStore } from '../../packages/asset-storage/fake-store.js';
import { parseRuntimePublicJwk } from '../../modules/agent-control/runtime-proof.js';
import type { DeviceAuthorizationHost } from '../../contracts/execution/v1/device-pairing.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_cookie_security_${process.pid}_${Date.now()}`, admin = createPool(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
const secureOrigin = 'https://cookie-security.example.test', localOrigin = 'http://127.0.0.1:4310';
const secureApp = createApp(pool, secureOrigin, 'staging'), localApp = createApp(pool, localOrigin);
const payload = z.object({ code: z.string().optional(), csrf_token: z.string().optional(), user: z.object({ user_id: z.uuid() }).optional() });
const priorCommunity = process.env.FREEDOM_REGISTRATION_COMMUNITY_ID;
before(async () => { process.env.FREEDOM_REGISTRATION_COMMUNITY_ID = DEMO_COMMUNITY; await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => {
  await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  if (priorCommunity === undefined) delete process.env.FREEDOM_REGISTRATION_COMMUNITY_ID;
  else process.env.FREEDOM_REGISTRATION_COMMUNITY_ID = priorCommunity;
});
beforeEach(async () => { await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE'); await seedLocal(pool); });
async function send(path: string, body?: unknown, headers: Record<string, string> = {}, local = false) {
  const origin = local ? localOrigin : secureOrigin, app = local ? localApp : secureApp;
  const response = await app.request(origin + '/api/v1' + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { response, status: response.status, data: payload.parse(await response.json()) };
}
async function signIn(index = 0, local = false, headers: Record<string, string> = {}) {
  const result = await send('/auth/login', { email: DEMO_USERS[index].email, password: DEMO_PASSWORD }, headers, local);
  assert.equal(result.status, 200); assert.ok(result.data.csrf_token);
  return { cookie: result.response.headers.get('set-cookie')!.split(';')[0], csrf: result.data.csrf_token, response: result.response };
}
function hostCookieAttributes(value: string) {
  assert.match(value, /^__Host-freedom_session=/);
  for (const attribute of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']) assert.ok(value.split('; ').includes(attribute), attribute);
  assert.doesNotMatch(value, /(?:^|;\s*)Domain=/i);
}

test('HTTPS issues host-prefixed login and registration cookies; legacy cookies cannot authorize secure hosts', async () => {
  const member = await signIn(); hostCookieAttributes(member.response.headers.get('set-cookie')!);
  assert.equal((await send('/session', undefined, { Cookie: member.cookie })).data.user?.user_id, DEMO_USERS[0].user_id);
  const legacy = member.cookie.replace('__Host-freedom_session=', 'freedom_local_session=');
  const query = mock.method(pool, 'query', () => { throw new Error('Legacy cookie must not reach SQL'); });
  try {
    assert.equal((await send('/session', undefined, { Cookie: legacy })).status, 401);
    assert.equal(query.mock.callCount(), 0);
  } finally { query.mock.restore(); }
  assert.equal((await send('/session', undefined, { Cookie: `freedom_local_session=attacker; ${member.cookie}` })).data.user?.user_id, DEMO_USERS[0].user_id);
  const registered = await send('/auth/register', { email: 'cookie-new@example.test', password: 'new-cookie-password-2026' });
  assert.equal(registered.status, 201); hostCookieAttributes(registered.response.headers.get('set-cookie')!);
  const local = await signIn(0, true); assert.match(local.cookie, /^freedom_local_session=/);
  assert.doesNotMatch(local.response.headers.get('set-cookie')!, /; Secure/);
  assert.equal((await send('/session', undefined, { Cookie: local.cookie }, true)).status, 200);
  assert.equal((await send('/session', undefined, { Cookie: member.cookie }, true)).status, 401);
  const logout = await send('/auth/logout', {}, { Cookie: local.cookie, 'X-CSRF-Token': local.csrf }, true);
  assert.equal(logout.status, 200);
  assert.match(logout.response.headers.get('set-cookie')!, /^freedom_local_session=;/);
  for (const attribute of ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0']) assert.ok(logout.response.headers.get('set-cookie')!.split('; ').includes(attribute));
  assert.doesNotMatch(logout.response.headers.get('set-cookie')!, /(?:^|;\s*)(?:Secure|Domain=)/i);
  assert.equal((await send('/session', undefined, { Cookie: local.cookie }, true)).status, 401);
});

test('duplicate session cookies reject both orders, whitespace and repeated values before reads or auth mutations', async () => {
  for (const local of [false, true]) {
    const first = await signIn(0, local), second = await signIn(1, local);
    const name = first.cookie.split('=')[0];
    const variants = [`${first.cookie}; ${second.cookie}`, `${second.cookie}; ${first.cookie}`,
      `${first.cookie}; ${name} \t=malformed`, `${first.cookie}; ${first.cookie}`];
    const activeBefore = (await pool.query('SELECT count(*)::int AS n FROM sessions WHERE revoked_at IS NULL')).rows[0].n;
    for (const Cookie of variants) {
      const read = await send('/session', undefined, { Cookie }, local);
      assert.equal(read.status, 403); assert.equal(read.data.code, 'credential_kind_rejected');
      assert.equal((await send('/auth/logout', {}, { Cookie, 'X-CSRF-Token': first.csrf }, local)).status, 403);
      assert.equal((await send('/auth/login', { email: DEMO_USERS[0].email, password: DEMO_PASSWORD }, { Cookie }, local)).status, 403);
      assert.equal((await send('/auth/register', { email: 'ambiguous@example.test', password: 'ambiguous-password-2026' }, { Cookie }, local)).status, 403);
    }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM sessions WHERE revoked_at IS NULL')).rows[0].n, activeBefore);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM users WHERE email='ambiguous@example.test'")).rows[0].n, 0);
    assert.equal((await send('/session', undefined, { Cookie: first.cookie }, local)).status, 200);
  }
});

test('secure account switching revokes only the supplied session and logout clears a valid host cookie', async () => {
  const old = await signIn(), otherDevice = await signIn();
  const replacement = await signIn(1, false, { Cookie: old.cookie });
  assert.equal((await send('/session', undefined, { Cookie: old.cookie })).status, 401);
  assert.equal((await send('/session', undefined, { Cookie: otherDevice.cookie })).status, 200);
  assert.equal((await send('/session', undefined, { Cookie: replacement.cookie })).data.user?.user_id, DEMO_USERS[1].user_id);
  const logout = await send('/auth/logout', {}, { Cookie: replacement.cookie, 'X-CSRF-Token': replacement.csrf });
  assert.equal(logout.status, 200); hostCookieAttributes(logout.response.headers.get('set-cookie')!);
  assert.match(logout.response.headers.get('set-cookie')!, /; Max-Age=0(?:;|$)/);
  assert.equal((await send('/session', undefined, { Cookie: replacement.cookie })).status, 401);
});

test('ambiguous cookies reject a streaming auth request without pulling its body', async () => {
  const member = await signIn(); let pulls = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new TextEncoder().encode('{}')); } }, { highWaterMark: 0 });
  const init: RequestInit & { duplex: 'half' } = { method: 'POST', duplex: 'half', body,
    headers: { Origin: secureOrigin, 'Content-Type': 'application/json', Cookie: `${member.cookie}; ${member.cookie}` } };
  const response = await secureApp.request(new Request(secureOrigin + '/api/v1/auth/login', init));
  assert.equal(response.status, 403); assert.equal(pulls, 0);
  await body.cancel();
});

test('independent HTTPS member transports reject the legacy name and admit the host name', async () => {
  const member = await signIn(), legacy = member.cookie.replace('__Host-freedom_session=', 'freedom_local_session=');
  const configuration = { origin: secureOrigin, environment: 'staging-next' as const, clientId: 'cookie-security' };
  const store = new FakeObjectStore(), host = createUnavailableModelStepHost();
  const ingestKeys = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  const ingestConfiguration = { environment: configuration.environment, clientId: configuration.clientId,
    issuer: 'synthetic-cookie-ingest', audience: 'synthetic-cookie-setup', setupOrigin: 'https://setup.example.test' };
  const ingest = await createCredentialIngestClient(pool, { ...configuration, ...ingestConfiguration, keyId: 'cookie-ingest', signingKey: ingestKeys.privateKey,
    authorizations: createCredentialIngestAuthorizations(pool, { ...ingestConfiguration,
      recover: async () => ({ generation: '1', expiresAt: new Date(Date.now() + 60000).toISOString() }) }) });
  const issuerKeys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', issuerKeys.publicKey);
  const bootstrapHost: DeviceAuthorizationHost = { environment: configuration.environment, clientId: configuration.clientId,
    issuer: 'https://issuer.example.test/', audience: secureOrigin + '/', issuerKid: 'cookie-issuer', clientDisplayName: 'Synthetic cookie client',
    bootstrapUri: secureOrigin + '/execution-api/v1/bootstrap', beginUri: secureOrigin + '/execution-api/v1/auth/device-authorizations',
    pollUri: secureOrigin + '/execution-api/v1/auth/token', verificationUri: secureOrigin + '/device', keys: [{ kid: 'cookie-issuer', purpose: 'bootstrap_access',
      environment: configuration.environment, publicJwk: parseRuntimePublicJwk({ kty, crv, x, y }), notBeforeMs: 0, notAfterMs: Number.MAX_SAFE_INTEGER, revoked: false }] };
  const transports = [
    { name: 'private work', api: new Hono().route('/api/v1', createPrivateWorkTransport(pool, { origin: secureOrigin, freedomEnv: 'staging', store })), path: '/api/v1/me/private-work', status: 200 },
    { name: 'execution', api: await createMemberExecutionHttpTransport(pool, configuration), path: '/api/v1/me/execution-runs/' + randomUUID(), status: 404 },
    { name: 'model broker', api: await createMemberModelHttpTransport(pool, { ...configuration, host, store, resolvePolicy: resolvePrivateWorkPersistencePolicy }), path: '/api/v1/me/model-step-overview', status: 200 },
    { name: 'model settings', api: await createMemberModelSettingsHttpTransport(pool, { ...configuration, selections: [] }), path: '/api/v1/me/model-settings', status: 200 },
    { name: 'credential ingest', api: await createMemberCredentialIngestHttpTransport(pool, { ...configuration, ingest }), path: '/api/v1/me/credential-ingests/' + randomUUID(), status: 403 },
    { name: 'device bootstrap', api: await createBootstrapHttpTransport(pool, { host: bootstrapHost, signingKey: issuerKeys.privateKey }), path: '/api/v1/me/agent-connections', status: 200 },
  ];
  const snapshot = async () => {
    const values: Record<string, unknown> = {};
    for (const table of ['sessions', 'principals', 'resource_scopes', 'scoped_command_receipts', 'execution_runs', 'credential_ingest_authorizations', 'device_authorizations'])
      values[table] = (await pool.query(`SELECT to_jsonb(t) value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
    return values;
  };
  for (const entry of transports) {
    const before = await snapshot();
    const old = await entry.api.request(secureOrigin + entry.path, { headers: { Cookie: legacy } });
    assert.equal(old.status, 401, entry.name); assert.equal((await old.json()).code, 'login_required');
    assert.deepEqual(await snapshot(), before, entry.name + ': no member/session/domain writes; pre-auth rate charges remain');
    const valid = await entry.api.request(secureOrigin + entry.path, { headers: { Cookie: member.cookie } });
    assert.equal(valid.status, entry.status, entry.name + ': ' + await valid.clone().text());
    if (entry.status !== 200) assert.equal((await valid.json()).code, entry.name === 'credential ingest' ? 'credential_ingest_authorization_invalid' : 'not_found', 'Authenticated access reached the domain lookup');
  }
});

test('HTTPS administrative member linking requires the host cookie', async () => {
  const member = await signIn(), id = randomUUID(), email = DEMO_USERS[0].email;
  await pool.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)', [id, DEMO_COMMUNITY, email, 'Synthetic cookie admin']);
  const api = createApp(pool, secureOrigin, 'staging', { adminVerifier: async () => ({ email, subject: 'synthetic-cookie-admin', csrfToken: 'synthetic-admin-csrf' }) });
  const link = (cookie: string) => api.request(secureOrigin + '/admin/api/link-member', { method: 'POST',
    headers: { Origin: secureOrigin, Cookie: cookie, 'X-Admin-CSRF': 'synthetic-admin-csrf', 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: '{}' });
  const old = await link(member.cookie.replace('__Host-freedom_session=', 'freedom_local_session='));
  assert.equal(old.status, 401); assert.equal((await old.json()).code, 'login_required');
  assert.equal((await pool.query('SELECT email_verified_at FROM users WHERE user_id=$1', [DEMO_USERS[0].user_id])).rows[0].email_verified_at, null);
  const valid = await link(member.cookie); assert.equal(valid.status, 200, await valid.clone().text());
  assert.equal((await valid.json()).linked_user_id, DEMO_USERS[0].user_id);
});

test('HTTPS promotion attribution ignores the legacy cookie and recognizes the host cookie', async () => {
  const owner = await signIn(), visitor = await signIn(1);
  const created = await send('/promotion/links', { kind: 'platform', target: 'workshop' }, { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf });
  assert.equal(created.status, 200); assert.ok(created.data.code);
  const click = (cookie: string) => send('/promotion/clicks', { code: created.data.code }, { Cookie: cookie,
    'User-Agent': 'Mozilla/5.0 Chrome/128.0.0.0 Safari/537.36' });
  assert.equal((await click(visitor.cookie.replace('__Host-freedom_session=', 'freedom_local_session='))).status, 200);
  assert.equal((await click(visitor.cookie)).status, 200);
  const keys = (await pool.query('SELECT visitor_key FROM promotion_clicks ORDER BY visitor_key')).rows.map(row => row.visitor_key);
  assert.equal(keys.length, 2); assert.equal(keys[0], 'm:' + DEMO_USERS[1].user_id); assert.match(keys[1], /^v:/);
});
