import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_USERS, DEMO_PASSWORD } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { authenticate, tokenHash } from '../../modules/identity-membership/service.js';
import { changePassword, listMemberSessions } from '../../modules/identity-membership/account-security.js';
import { confirmPasswordReset, requestPasswordReset } from '../../modules/identity-membership/password-recovery.js';

// Signed-in password change and session management. Requests are in-process;
// only the disposable PostgreSQL fixture is contacted.
const origin = 'http://127.0.0.1:4311';
const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_account_security_${process.pid}_${Date.now()}`;
const admin = createPool(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 });
const app = createApp(pool, origin);
type Session = { cookie: string; csrf: string; hash: string; userId: string };
const NEW_PASSWORD = 'a-brand-new-password-2026';

before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(async () => {
  await pool.query('TRUNCATE communities, login_attempts, auth_rate_limits CASCADE');
  await seedLocal(pool);
});

type SessionItem = { current: boolean; created_at: string | null; last_seen_at: string | null; expires_at: string };
type Problem = { code?: string };
type Revocation = { revoked_sessions: number; aggregate_version: number };
async function request<T = Problem>(path: string, session?: Session, body?: unknown, headers: Record<string, string> = {}) {
  const response = await app.request(origin + '/api/v1' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Origin: origin,
      ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() as T };
}

async function signIn(email = DEMO_USERS[0].email, password = DEMO_PASSWORD): Promise<Session> {
  const response = await app.request(origin + '/api/v1/auth/login', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  const data = await response.json() as { csrf_token: string; user: { user_id: string } };
  return { cookie, csrf: data.csrf_token, hash: tokenHash(cookie.split('=')[1]), userId: data.user.user_id };
}

test('changing the password keeps the proving session, ends the others and retires the old password', async () => {
  const phone = await signIn();
  const laptop = await signIn();
  const before = await request<{ items: SessionItem[]; total: number }>('/me/sessions', laptop);
  assert.equal(before.status, 200);
  assert.equal(before.data.items.length, 2);
  assert.equal(before.data.items[0].current, true);
  assert.equal(before.data.items.filter(item => item.current).length, 1);
  for (const item of before.data.items) assert.doesNotMatch(JSON.stringify(item), /token|hash|csrf/);

  const changed = await request<{ changed: true; revoked_sessions: number }>('/me/password', laptop, { current_password: DEMO_PASSWORD, new_password: NEW_PASSWORD });
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.data, { changed: true, revoked_sessions: 1 });

  assert.equal((await request('/session', laptop)).status, 200);
  assert.equal((await request('/session', phone)).status, 401);
  const stale = await app.request(origin + '/api/v1/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: DEMO_USERS[0].email, password: DEMO_PASSWORD }) });
  assert.equal(stale.status, 401);
  await signIn(DEMO_USERS[0].email, NEW_PASSWORD);
  const journal = await pool.query(`SELECT data FROM transition_journal WHERE aggregate_id=$1 AND command='change_password'`, [laptop.userId]);
  assert.equal(journal.rowCount, 1);
  assert.deepEqual(journal.rows[0].data, { revoked_sessions: 1 });
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM command_receipts WHERE user_id=$1 AND operation LIKE $2', [laptop.userId, '%/me/password'])).rows[0].n, 0);
});

test('a wrong current password, an unchanged password or a short one changes nothing', async () => {
  const session = await signIn();
  const other = await signIn();
  const wrong = await request('/me/password', session, { current_password: 'not-the-password', new_password: NEW_PASSWORD });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.data.code, 'current_password_invalid');
  const same = await request('/me/password', session, { current_password: DEMO_PASSWORD, new_password: DEMO_PASSWORD });
  assert.equal(same.status, 422);
  assert.equal(same.data.code, 'password_unchanged');
  const short = await request('/me/password', session, { current_password: DEMO_PASSWORD, new_password: 'short' });
  assert.equal(short.status, 422);
  const extra = await request('/me/password', session, { current_password: DEMO_PASSWORD, new_password: NEW_PASSWORD, email: 'x@example.com' });
  assert.equal(extra.status, 422);
  assert.equal((await request('/session', other)).status, 200);
  await signIn(DEMO_USERS[0].email, DEMO_PASSWORD);
  assert.equal((await pool.query('SELECT failures FROM login_attempts WHERE attempt_key=$1', [tokenHash(`password-change:${session.userId}`)])).rows[0].failures, 1);
});

test('ten wrong current passwords lock the change for the window without touching sign-in', async () => {
  const session = await signIn();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.equal((await request('/me/password', session, { current_password: `wrong-${attempt}`, new_password: NEW_PASSWORD })).status, 403);
  }
  const blocked = await request('/me/password', session, { current_password: DEMO_PASSWORD, new_password: NEW_PASSWORD });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.data.code, 'password_change_rate_limited');
  await signIn(DEMO_USERS[0].email, DEMO_PASSWORD);
});

test('password change rejects a missing CSRF token and another member cannot be affected', async () => {
  const session = await signIn();
  const stranger = await signIn(DEMO_USERS[1].email);
  const noCsrf = await app.request(origin + '/api/v1/me/password', {
    method: 'POST', headers: { Origin: origin, Cookie: session.cookie, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ current_password: DEMO_PASSWORD, new_password: NEW_PASSWORD }),
  });
  assert.equal(noCsrf.status, 403);
  assert.equal((await request('/me/password', session, { current_password: DEMO_PASSWORD, new_password: NEW_PASSWORD })).status, 200);
  assert.equal((await request('/session', stranger)).status, 200);
  await signIn(DEMO_USERS[1].email, DEMO_PASSWORD);
});

test('revoking other sessions keeps the current one, replays by key and lists only live sessions', async () => {
  const keep = await signIn();
  const drop = await signIn();
  const stranger = await signIn(DEMO_USERS[1].email);
  const key = randomUUID();
  const first = await request<Revocation>('/me/sessions/revoke-others', keep, {}, { 'Idempotency-Key': key });
  assert.equal(first.status, 200);
  assert.equal(first.data.revoked_sessions, 1);
  const replay = await request<Revocation>('/me/sessions/revoke-others', keep, {}, { 'Idempotency-Key': key });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data, first.data);
  const again = await request<Revocation>('/me/sessions/revoke-others', keep, {});
  assert.equal(again.data.revoked_sessions, 0);
  assert.equal((await request('/session', drop)).status, 401);
  assert.equal((await request('/session', stranger)).status, 200);
  const list = await request<{ items: SessionItem[]; total: number }>('/me/sessions', keep);
  assert.equal(list.data.total, 1);
  assert.equal(list.data.items[0].current, true);
  assert.equal((await request('/me/sessions/revoke-others', keep, { force: true })).status, 422);
});

// Delay a real database statement's result while retaining the same client and
// transaction. This exercises decision-clock checks after a downstream wait.
function delayedPool(match: string, delayed: () => void): Pool {
  return {
    query: pool.query.bind(pool),
    connect: async () => {
      const q = await pool.connect();
      return new Proxy(q, { get(target, property) {
        if (property === 'query') return async (sql: string, values?: unknown[]) => {
          const result = await target.query(sql, values);
          if (sql.includes(match)) { delayed(); await target.query('SELECT pg_sleep(1)'); }
          return result;
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    },
  } as unknown as Pool;
}

test('password change rolls back if its session expires during the journal write', async () => {
  const session = await signIn(), other = await signIn();
  const actor = await authenticate(pool, session.cookie.split('=')[1]);
  const prior = (await pool.query('SELECT password_hash FROM users WHERE user_id=$1', [session.userId])).rows[0].password_hash;
  let waited = false;
  await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE token_hash=$1", [session.hash]);
  await assert.rejects(changePassword(delayedPool('INSERT INTO transition_journal', () => { waited=true; }), actor, { current_password: DEMO_PASSWORD, new_password: NEW_PASSWORD }), (error: unknown) => (error as {code?:string}).code === 'session_expired');
  assert.equal(waited, true, 'the session was initially valid and reached the journal wait');
  assert.equal((await pool.query('SELECT password_hash FROM users WHERE user_id=$1', [session.userId])).rows[0].password_hash, prior);
  assert.equal((await request('/session', other)).status, 200);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM transition_journal WHERE aggregate_id=$1 AND command='change_password'", [session.userId])).rows[0].n, 0);
});

test('session listing rejects an actor revoked after middleware authentication', async () => {
  const session = await signIn(); await signIn();
  const actor = await authenticate(pool, session.cookie.split('=')[1]);
  await pool.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1', [session.hash]);
  await assert.rejects(listMemberSessions(pool, actor), (error: unknown) => (error as {code?:string}).code === 'session_expired');
});

test('session listing refuses metadata when its session expires during the read', async () => {
  const session = await signIn(); await signIn();
  const actor = await authenticate(pool, session.cookie.split('=')[1]);
  let waited = false;
  await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE token_hash=$1", [session.hash]);
  await assert.rejects(listMemberSessions(delayedPool('SELECT token_hash=$2 AS current', () => { waited=true; }), actor), (error: unknown) => (error as {code?:string}).code === 'session_expired');
  assert.equal(waited, true, 'the session was initially valid and reached the metadata read');
});

test('password rotation invalidates only this member outstanding reset links', async () => {
  const session = await signIn(), stranger = await signIn(DEMO_USERS[1].email);
  let resetToken = '';
  await requestPasswordReset(pool, DEMO_USERS[0].email, origin, async (_to,url) => { resetToken=url.split('/').at(-1)!; });
  await requestPasswordReset(pool, DEMO_USERS[1].email, origin, async () => {});
  const consumed = tokenHash('consumed-fixture');
  await pool.query("INSERT INTO password_reset_tokens(token_hash,user_id,expires_at,consumed_at) VALUES($1,$2,now()+interval '30 minutes',now())", [consumed,session.userId]);
  assert.equal((await request('/me/password', session, { current_password: DEMO_PASSWORD, new_password: NEW_PASSWORD })).status, 200);
  await assert.rejects(confirmPasswordReset(pool, resetToken, DEMO_PASSWORD), (error: unknown) => (error as {code?:string}).code === 'reset_link_invalid');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM password_reset_tokens WHERE user_id=$1 AND consumed_at IS NULL', [stranger.userId])).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM password_reset_tokens WHERE token_hash=$1', [consumed])).rows[0].n, 1);
  await signIn(DEMO_USERS[0].email, NEW_PASSWORD);
});
