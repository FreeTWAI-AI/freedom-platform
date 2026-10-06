import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_USERS, DEMO_PASSWORD } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { tokenHash } from '../../modules/identity-membership/service.js';

// #107: a 30-day absolute session from login or registration, still without sliding renewal.
// Requests are in-process; only the disposable PostgreSQL fixture is contacted.
const origin = 'http://127.0.0.1:4310';
const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_session_lifecycle_${process.pid}_${Date.now()}`;
const admin = createPool(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 });
const app = createApp(pool, origin);
type Session = { cookie: string; csrf: string; hash: string; userId: string };

before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(async () => {
  await pool.query('TRUNCATE communities, login_attempts, auth_rate_limits CASCADE');
  await seedLocal(pool);
});

async function request(path: string, session?: Session, body?: unknown, options: {
  app?: ReturnType<typeof createApp>; headers?: Record<string, string>;
} = {}) {
  const response = await (options.app ?? app).request(origin + '/api/v1' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Origin: origin,
      ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }),
      ...options.headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, status: response.status, data: await response.json() as any };
}

async function signIn(previous?: Session, email = DEMO_USERS[0].email) {
  const result = await request('/auth/login', previous, { email, password: DEMO_PASSWORD });
  assert.equal(result.status, 200);
  const setCookie = result.response.headers.get('set-cookie')!;
  const cookie = setCookie.split(';')[0];
  return {
    session: { cookie, csrf: result.data.csrf_token, hash: tokenHash(cookie.split('=')[1]), userId: result.data.user.user_id },
    setCookie,
  };
}

async function stored(session: Session) {
  return (await pool.query('SELECT expires_at, revoked_at, last_seen_at FROM sessions WHERE token_hash=$1', [session.hash])).rows[0];
}

test('returning member keeps one persistent thirty-day session across fresh apps without sliding expiry', async () => {
  const start = (await pool.query('SELECT clock_timestamp() AS time')).rows[0].time.getTime();
  const { session, setCookie } = await signIn();
  const end = (await pool.query('SELECT clock_timestamp() AS time')).rows[0].time.getTime();
  assert.match(setCookie, /; Max-Age=2592000(?:;|$)/);
  assert.match(setCookie, /; Path=\//);
  assert.match(setCookie, /; HttpOnly/);
  assert.match(setCookie, /; SameSite=Strict/);
  const expiry = (await stored(session)).expires_at.getTime();
  assert.ok(expiry >= start + 30 * 24 * 60 * 60 * 1000 && expiry <= end + 30 * 24 * 60 * 60 * 1000);
  await pool.query("UPDATE sessions SET last_seen_at=now()-interval '2 minutes' WHERE token_hash=$1", [session.hash]);
  const priorPresence = (await stored(session)).last_seen_at.getTime();
  for (let visit = 0; visit < 2; visit++) {
    const result = await request('/session', session, undefined, { app: createApp(pool, origin) });
    assert.equal(result.status, 200);
    assert.equal(result.data.user.user_id, session.userId);
    assert.equal(result.data.csrf_token, session.csrf);
    assert.equal(result.response.headers.get('set-cookie'), null, 'session discovery does not rotate or extend the cookie');
  }
  const current = await stored(session);
  assert.equal(current.expires_at.getTime(), expiry);
  assert.ok(current.last_seen_at.getTime() > priorPresence);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n, 1);
});

test('registration sets the same thirty-day cookie and server expiry as login', async () => {
  const start = (await pool.query('SELECT clock_timestamp() AS time')).rows[0].time.getTime();
  const result = await request('/auth/register', undefined, {
    email: 'thirty-day@example.com', password: 'long-enough-session-password', nickname: '三十天新會員',
  });
  const end = (await pool.query('SELECT clock_timestamp() AS time')).rows[0].time.getTime();
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const setCookie = result.response.headers.get('set-cookie')!;
  assert.match(setCookie, /; Max-Age=2592000(?:;|$)/);
  assert.match(setCookie, /; Path=\//);
  assert.match(setCookie, /; HttpOnly/);
  assert.match(setCookie, /; SameSite=Strict/);
  const cookie = setCookie.split(';')[0];
  const session: Session = { cookie, csrf: result.data.csrf_token, hash: tokenHash(cookie.split('=')[1]), userId: result.data.user.user_id };
  const expiry = (await stored(session)).expires_at.getTime();
  assert.ok(expiry >= start + 30 * 24 * 60 * 60 * 1000 && expiry <= end + 30 * 24 * 60 * 60 * 1000);
});

test('a session older than eight hours still accepts a read and a CSRF write until its original expiry', async () => {
  const { session } = await signIn();
  await pool.query("UPDATE sessions SET created_at=created_at-interval '9 hours', expires_at=expires_at-interval '9 hours' WHERE token_hash=$1", [session.hash]);
  const before = (await pool.query(`SELECT created_at, expires_at,
    created_at<clock_timestamp()-interval '8 hours' AS older_than_eight_hours,
    expires_at>clock_timestamp() AS unexpired
    FROM sessions WHERE token_hash=$1`, [session.hash])).rows[0];
  assert.equal(before.older_than_eight_hours, true);
  assert.equal(before.unexpired, true);
  const read = await request('/session', session, undefined, { app: createApp(pool, origin) });
  assert.equal(read.status, 200);
  assert.equal(read.data.user.user_id, session.userId);
  assert.equal(read.response.headers.get('set-cookie'), null);
  const write = await request('/me/client-errors', session, { action: 'UI /home', error_code: 'synthetic_nine_hours' }, { app: createApp(pool, origin) });
  assert.equal(write.status, 201, JSON.stringify(write.data));
  assert.equal(write.response.headers.get('set-cookie'), null);
  assert.equal((await stored(session)).expires_at.getTime(), before.expires_at.getTime());
});

test('missing browser cookie and expired server session reject reads and writes without refreshing expiry', async () => {
  const { session } = await signIn();
  for (const [path, body] of [
    ['/session', undefined],
    ['/me/client-errors', { action: 'UI /home', error_code: 'synthetic_missing_cookie' }],
  ] as const) {
    const missing = await request(path, undefined, body);
    assert.equal(missing.status, 401);
    assert.equal(missing.data.code, 'login_required');
    assert.equal(missing.response.headers.get('set-cookie'), null);
  }
  assert.equal((await request('/session', session)).status, 200, 'a missing client cookie does not revoke a stored session');
  await pool.query("UPDATE sessions SET expires_at=now()-interval '1 second', last_seen_at=now()-interval '2 minutes' WHERE token_hash=$1", [session.hash]);
  const expired = await stored(session);
  for (const [path, body] of [
    ['/session', undefined],
    ['/me/client-errors', { action: 'UI /home', error_code: 'synthetic_expiry' }],
    ['/auth/logout', {}],
  ] as const) {
    const denied = await request(path, session, body);
    assert.equal(denied.status, 401, path);
    assert.equal(denied.data.code, 'session_expired', path);
    assert.equal(denied.response.headers.get('set-cookie'), null);
  }
  assert.deepEqual(await stored(session), expired, 'denial must not revive, refresh or mutate the expired session');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM member_client_errors')).rows[0].n, 0);
});

test('logout revokes only this device and a captured cookie cannot read, write or logout again', async () => {
  const { session } = await signIn();
  const { session: otherDevice } = await signIn();
  const result = await request('/auth/logout', session, {});
  assert.equal(result.status, 200);
  assert.equal(result.data.logged_out, true);
  assert.match(result.response.headers.get('set-cookie')!, /^freedom_local_session=;/);
  assert.match(result.response.headers.get('set-cookie')!, /; Max-Age=0(?:;|$)/);
  assert.ok((await stored(session)).revoked_at);
  for (const [path, body] of [
    ['/session', undefined],
    ['/me/client-errors', { action: 'UI /home', error_code: 'synthetic_replay' }],
    ['/auth/logout', {}],
  ] as const) {
    const denied = await request(path, session, body, { app: createApp(pool, origin) });
    assert.equal(denied.status, 401);
    assert.equal(denied.data.code, 'session_expired');
  }
  assert.equal((await request('/session', otherDevice)).status, 200);
  assert.equal((await stored(otherDevice)).revoked_at, null);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM member_client_errors')).rows[0].n, 0);
});

test('another device CSRF token cannot sign out a returning member', async () => {
  const { session } = await signIn();
  const { session: otherDevice } = await signIn();
  const denied = await request('/auth/logout', session, {}, { headers: { 'X-CSRF-Token': otherDevice.csrf } });
  assert.equal(denied.status, 403);
  assert.equal(denied.data.code, 'csrf_rejected');
  assert.equal(denied.response.headers.get('set-cookie'), null);
  for (const device of [session, otherDevice]) {
    assert.equal((await stored(device)).revoked_at, null);
    assert.equal((await request('/session', device)).status, 200);
  }
});

test('failed re-login preserves the current session; successful account switch replaces only its supplied cookie', async () => {
  const { session } = await signIn();
  const { session: otherDevice } = await signIn();
  const failed = await request('/auth/login', session, { email: DEMO_USERS[1].email, password: 'synthetic-wrong-password' });
  assert.equal(failed.status, 401);
  assert.equal(failed.data.code, 'invalid_credentials');
  assert.equal(failed.response.headers.get('set-cookie'), null);
  assert.equal((await request('/session', session)).data.user.user_id, session.userId);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n, 2);
  const { session: replacement } = await signIn(session, DEMO_USERS[1].email);
  assert.notEqual(replacement.cookie, session.cookie);
  assert.notEqual(replacement.csrf, session.csrf);
  assert.equal((await request('/session', session)).status, 401);
  assert.equal((await request('/session', replacement)).data.user.user_id, DEMO_USERS[1].user_id);
  assert.equal((await request('/session', otherDevice)).data.user.user_id, session.userId);
});
