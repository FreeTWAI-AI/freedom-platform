import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { z } from 'zod';
import { createPool, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_USERS, DEMO_PASSWORD } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { tokenHash } from '../../modules/identity-membership/service.js';

const origin = 'http://127.0.0.1:4310', databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_login_recovery_${process.pid}_${Date.now()}`, admin = createPool(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 8 });
const delivered: string[] = [];
const app = createApp(pool, origin, 'local', { passwordEmailSender: async (_to, url) => { delivered.push(url); } });
const email = DEMO_USERS[0].email, newPassword = 'synthetic-recovered-password-2026';
const outcome = z.object({ code: z.string().optional(), reset: z.boolean().optional(), csrf_token: z.string().optional(),
  user: z.object({ user_id: z.uuid() }).optional() });
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(async () => { await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE'); await seedLocal(pool); delivered.length = 0; });
async function post(path: string, body: unknown) {
  const response = await app.request(origin + '/api/v1' + path, { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, data: outcome.parse(await response.json()), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function lockAccount() {
  for (let i = 0; i < 10; i++) assert.equal((await post('/auth/login', { email, password: 'wrong-password' })).status, 401);
  assert.equal((await post('/auth/login', { email, password: DEMO_PASSWORD })).status, 429);
}
async function resetLink() {
  assert.equal((await post('/auth/reset/request', { email })).status, 200);
  const token = /\/([A-Za-z0-9_-]{43})$/.exec(delivered.at(-1) ?? '')?.[1];
  assert.ok(token); return token;
}

test('mailbox proof restores a locked member session even if failed logins lock the account again', async () => {
  const old = await post('/auth/login', { email, password: DEMO_PASSWORD }); assert.ok(old.cookie);
  await lockAccount();
  const token = await resetLink();
  assert.equal((await post('/auth/login', { email, password: DEMO_PASSWORD })).status, 429, 'requesting mail alone cannot unlock');
  const recovered = await post('/auth/reset/confirm', { token, password: newPassword });
  assert.equal(recovered.status, 200); assert.equal(recovered.data.reset, true);
  assert.ok(recovered.cookie); assert.ok(recovered.data.csrf_token);
  assert.equal(recovered.data.user?.user_id, DEMO_USERS[0].user_id);
  assert.equal((await post('/auth/reset/confirm', { token, password: newPassword })).status, 422);
  assert.equal((await app.request(origin + '/api/v1/session', { headers: { Cookie: old.cookie } })).status, 401);
  for (let i = 0; i < 10; i++) assert.equal((await post('/auth/login', { email, password: 'attacker-password' })).status, 401);
  assert.equal((await post('/auth/login', { email, password: newPassword })).status, 429);
  const active = await app.request(origin + '/api/v1/session', { headers: { Cookie: recovered.cookie } });
  assert.equal(active.status, 200); assert.equal(outcome.parse(await active.json()).user?.user_id, DEMO_USERS[0].user_id);
});

test('invalid, expired and inactive-account proofs cannot clear the login budget or issue a session', async () => {
  await lockAccount(); const token = await resetLink();
  assert.equal((await post('/auth/reset/confirm', { token: 'A'.repeat(43), password: newPassword })).status, 422);
  await pool.query("UPDATE password_reset_tokens SET created_at=now()-interval '40 minutes',expires_at=now()-interval '1 second' WHERE token_hash=$1", [tokenHash(token)]);
  assert.equal((await post('/auth/reset/confirm', { token, password: newPassword })).status, 422);
  const fresh = await resetLink(); await pool.query('UPDATE users SET active=false WHERE user_id=$1', [DEMO_USERS[0].user_id]);
  assert.equal((await post('/auth/reset/confirm', { token: fresh, password: newPassword })).status, 422);
  assert.equal((await pool.query('SELECT failures FROM login_attempts WHERE attempt_key=$1', [tokenHash(email)])).rows[0].failures, 10);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sessions WHERE revoked_at IS NULL')).rows[0].n, 0);
});

test('simultaneous reset links for one member have one winner and preserve its new session', async () => {
  await lockAccount(); const first = await resetLink(), second = await resetLink();
  const results = await Promise.all([post('/auth/reset/confirm', { token: first, password: newPassword }),
    post('/auth/reset/confirm', { token: second, password: newPassword })]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 422]);
  const winner = results.find(r => r.status === 200); assert.ok(winner?.cookie);
  assert.equal((await app.request(origin + '/api/v1/session', { headers: { Cookie: winner.cookie } })).status, 200);
  assert.equal((await post('/auth/login', { email, password: newPassword })).status, 200);
});

test('a late session failure leaves the old password, session, proof and lockout intact', async () => {
  const old = await post('/auth/login', { email, password: DEMO_PASSWORD }); assert.ok(old.cookie);
  const passwordHash = (await pool.query('SELECT password_hash FROM users WHERE email=$1', [email])).rows[0].password_hash;
  await lockAccount(); const token = await resetLink();
  await pool.query(`CREATE FUNCTION fail_recovery_session() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic session failure'; END $$;
    CREATE TRIGGER fail_recovery_session BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION fail_recovery_session()`);
  try { assert.equal((await post('/auth/reset/confirm', { token, password: newPassword })).status, 500); }
  finally { await pool.query('DROP TRIGGER fail_recovery_session ON sessions; DROP FUNCTION fail_recovery_session()'); }
  assert.equal((await pool.query('SELECT password_hash FROM users WHERE email=$1', [email])).rows[0].password_hash, passwordHash);
  assert.equal((await pool.query('SELECT failures FROM login_attempts WHERE attempt_key=$1', [tokenHash(email)])).rows[0].failures, 10);
  assert.equal((await app.request(origin + '/api/v1/session', { headers: { Cookie: old.cookie } })).status, 200);
  assert.equal((await post('/auth/reset/confirm', { token, password: newPassword })).status, 200, 'the proof can be retried after rollback');
});
