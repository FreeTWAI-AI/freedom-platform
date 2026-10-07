import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { createPool, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_USERS, DEMO_PASSWORD, DEMO_COMMUNITY } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';

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
  assert.equal((await send('/session', undefined, { Cookie: legacy })).status, 401);
  assert.equal((await send('/session', undefined, { Cookie: `freedom_local_session=attacker; ${member.cookie}` })).data.user?.user_id, DEMO_USERS[0].user_id);
  const registered = await send('/auth/register', { email: 'cookie-new@example.test', password: 'new-cookie-password-2026' });
  assert.equal(registered.status, 201); hostCookieAttributes(registered.response.headers.get('set-cookie')!);
  const local = await signIn(0, true); assert.match(local.cookie, /^freedom_local_session=/);
  assert.doesNotMatch(local.response.headers.get('set-cookie')!, /; Secure/);
  assert.equal((await send('/session', undefined, { Cookie: local.cookie }, true)).status, 200);
  assert.equal((await send('/session', undefined, { Cookie: member.cookie }, true)).status, 401);
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
