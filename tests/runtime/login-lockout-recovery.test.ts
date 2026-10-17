import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { createPool, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_USERS, DEMO_PASSWORD } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { tokenHash } from '../../modules/identity-membership/service.js';
import { totpCode } from '../../modules/identity-membership/totp.js';

const origin = 'http://127.0.0.1:4310', databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_login_recovery_${process.pid}_${Date.now()}`, admin = createPool(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, application_name: schema, max: 8 });
const delivered: string[] = [];
const app = createApp(pool, origin, 'local', { passwordEmailSender: async (_to, url) => { delivered.push(url); }, totpEncryptionKey: Buffer.alloc(32, 0x74).toString('base64') });
const secureOrigin = 'https://recovery.example.test';
const secureApp = createApp(pool, secureOrigin, 'staging', { passwordEmailSender: async (_to, url) => { delivered.push(url); } });
const email = DEMO_USERS[0].email, newPassword = 'synthetic-recovered-password-2026';
const outcome = z.object({ code: z.string().optional(), reset: z.boolean().optional(), csrf_token: z.string().optional(),
  user: z.object({ user_id: z.uuid() }).optional() });
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(async () => { await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE'); await seedLocal(pool); delivered.length = 0; });
async function post(path: string, body: unknown, secure = false, headers: Record<string, string> = {}) {
  const at = secure ? secureOrigin : origin;
  const response = await (secure ? secureApp : app).request(at + '/api/v1' + path, { method: 'POST',
    headers: { Origin: at, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const raw = await response.json();
  return { response, raw, status: response.status, data: outcome.parse(raw), cookie: response.headers.get('set-cookie')?.split(';')[0] };
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

async function waitForLoginLock(blockerPid:number) {
  const deadline=Date.now()+5000;
  while(Date.now()<deadline){
    if((await admin.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[blockerPid])).rowCount)return;
    await delay(10);
  }
  assert.fail('the native login/recovery transaction must reach the held row');
}

for(const skew of ['ahead','behind'] as const)test(`login failure expiry uses the database clock when the application clock is ${skew}`,async t=>{
  const bucket=tokenHash(email);
  await pool.query(`INSERT INTO login_attempts VALUES($1,10,clock_timestamp()-make_interval(secs=>$2))`,[bucket,skew==='ahead'?0:960]);
  const realNow=Date.now();
  t.mock.method(Date,'now',()=>realNow+(skew==='ahead'?1:-1)*86400000);
  const response=await post('/auth/login',{email,password:'synthetic-invalid-password'});
  assert.equal(response.status,skew==='ahead'?429:401);
  assert.equal(response.data.code,skew==='ahead'?'login_rate_limited':'invalid_credentials');
  assert.equal((await pool.query('SELECT failures FROM login_attempts WHERE attempt_key=$1',[bucket])).rows[0].failures,skew==='ahead'?10:1);
  assert.equal(response.cookie,undefined);
});

test('a reopened login failure window starts after the actual bucket lock wait',async()=>{
  const bucket=tokenHash(email),blocker=await pool.connect();let pending:Promise<unknown>|undefined;
  await pool.query("INSERT INTO login_attempts VALUES($1,10,clock_timestamp()-interval '1 day')",[bucket]);
  try{
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM login_attempts WHERE attempt_key=$1 FOR UPDATE',[bucket]);
    const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const reply=post('/auth/login',{email,password:'synthetic-invalid-password'});pending=reply;
    await waitForLoginLock(pid);
    const marker=(await admin.query('SELECT clock_timestamp()::text AS at')).rows[0].at;
    await blocker.query('COMMIT');
    assert.equal((await reply).status,401);
    const window=(await pool.query('SELECT failures,window_start>=$2::timestamptz AS fresh FROM login_attempts WHERE attempt_key=$1',[bucket,marker])).rows[0];
    assert.deepEqual(window,{failures:1,fresh:true});
    for(let i=0;i<9;i++)assert.equal((await post('/auth/login',{email,password:'synthetic-invalid-password'})).status,401);
    const denied=await post('/auth/login',{email,password:DEMO_PASSWORD});
    assert.equal(denied.status,429);assert.equal(denied.data.code,'login_rate_limited');
  }finally{await blocker.query('ROLLBACK');blocker.release();await pending;}
});

test('mailbox recovery starts the cleared failure window after its user lock wait',async()=>{
  await lockAccount();const token=await resetLink(),blocker=await pool.connect();let pending:Promise<unknown>|undefined;
  try{
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM users WHERE user_id=$1 FOR UPDATE',[DEMO_USERS[0].user_id]);
    const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const reply=post('/auth/reset/confirm',{token,password:newPassword});pending=reply;
    await waitForLoginLock(pid);
    const marker=(await admin.query('SELECT clock_timestamp()::text AS at')).rows[0].at;
    await blocker.query('COMMIT');
    assert.equal((await reply).status,200);
    assert.deepEqual((await pool.query('SELECT failures,window_start>=$2::timestamptz AS fresh FROM login_attempts WHERE attempt_key=$1',[tokenHash(email),marker])).rows[0],{failures:0,fresh:true});
  }finally{await blocker.query('ROLLBACK');blocker.release();await pending;}
});

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

for (const scenario of [
  { mfa: false, waitAt: 'session revocation' },
  { mfa: true, waitAt: 'session revocation' },
  { mfa: false, waitAt: 'session creation' },
]) test(`proof expiry during ${scenario.waitAt} rolls back recovery (${scenario.mfa ? 'MFA' : 'password only'})`, async () => {
  const old = await post('/auth/login', { email, password: DEMO_PASSWORD }); assert.ok(old.cookie);
  const userId = DEMO_USERS[0].user_id;
  if (scenario.mfa) {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const clock = (await pool.query('SELECT floor(extract(epoch FROM clock_timestamp())/30)::bigint AS counter')).rows[0].counter;
    const enabled = await post('/me/totp/enable', { password: DEMO_PASSWORD, secret, code: totpCode(secret, Number(clock)) }, false,
      { Cookie: old.cookie, 'X-CSRF-Token': old.data.csrf_token!, 'Idempotency-Key': randomUUID() });
    assert.equal(enabled.status, 200);
    await pool.query('UPDATE member_totp SET failures=3 WHERE user_id=$1', [userId]);
  }
  await lockAccount();
  const other = await resetLink(), token = await resetLink(), hash = tokenHash(token);
  await pool.query("UPDATE password_reset_tokens SET expires_at=clock_timestamp()+interval '2 seconds' WHERE token_hash=$1", [hash]);
  const priorUser = (await pool.query('SELECT password_hash,email_verified_at FROM users WHERE user_id=$1', [userId])).rows[0];
  const priorSessions = (await pool.query('SELECT token_hash,revoked_at FROM sessions WHERE user_id=$1 ORDER BY token_hash', [userId])).rows;
  const priorAttempt = (await pool.query('SELECT failures,window_start FROM login_attempts WHERE attempt_key=$1', [tokenHash(email)])).rows[0];
  const priorMfa = (await pool.query('SELECT * FROM member_totp WHERE user_id=$1', [userId])).rows;
  let pending: Promise<unknown> | undefined;
  if (scenario.waitAt === 'session creation') {
    // A real PostgreSQL trigger places the wait after the proof was consumed,
    // so a check before session insertion would still accept an expired proof.
    await pool.query(`CREATE FUNCTION wait_recovery_session() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM
          ((SELECT min(expires_at) FROM password_reset_tokens WHERE user_id=NEW.user_id)-clock_timestamp())))+0.05);
        RETURN NEW;
      END $$;
      CREATE TRIGGER wait_recovery_session BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION wait_recovery_session()`);
    try {
      const reply = await post('/auth/reset/confirm', { token, password: newPassword });
      assert.equal(reply.status, 422); assert.equal(reply.data.code, 'reset_link_invalid'); assert.equal(reply.cookie, undefined);
    } finally {
      await pool.query('DROP TRIGGER wait_recovery_session ON sessions; DROP FUNCTION wait_recovery_session()');
    }
  } else {
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT token_hash FROM sessions WHERE user_id=$1 FOR UPDATE', [userId]);
      const reset = post('/auth/reset/confirm', { token, password: newPassword }); pending = reset;
      let waiting = false;
      for (let i = 0; i < 200; i++) {
        const row = await admin.query(`SELECT 1 FROM pg_stat_activity WHERE application_name=$1
          AND wait_event_type='Lock' AND query LIKE 'UPDATE sessions SET revoked_at%'`, [schema]);
        if (row.rowCount) { waiting = true; break; }
        await delay(10);
      }
      assert.ok(waiting, 'an initially valid proof must reach the session row-lock barrier');
      await pool.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM expires_at-clock_timestamp()))+0.05) FROM password_reset_tokens WHERE token_hash=$1', [hash]);
      await blocker.query('COMMIT');
      const reply = await reset;
      assert.equal(reply.status, 422); assert.equal(reply.data.code, 'reset_link_invalid'); assert.equal(reply.cookie, undefined);
    } finally {
      await blocker.query('ROLLBACK'); blocker.release(); await pending;
    }
  }
  assert.deepEqual((await pool.query('SELECT password_hash,email_verified_at FROM users WHERE user_id=$1', [userId])).rows[0], priorUser);
  assert.deepEqual((await pool.query('SELECT token_hash,revoked_at FROM sessions WHERE user_id=$1 ORDER BY token_hash', [userId])).rows, priorSessions);
  assert.deepEqual((await pool.query('SELECT failures,window_start FROM login_attempts WHERE attempt_key=$1', [tokenHash(email)])).rows[0], priorAttempt);
  assert.deepEqual((await pool.query('SELECT * FROM member_totp WHERE user_id=$1', [userId])).rows, priorMfa);
  assert.equal((await pool.query('SELECT consumed_at FROM password_reset_tokens WHERE token_hash=$1', [hash])).rows[0].consumed_at, null);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM password_reset_tokens WHERE user_id=$1 AND consumed_at IS NULL', [userId])).rows[0].n, 2);
  assert.equal((await app.request(origin + '/api/v1/session', { headers: { Cookie: old.cookie } })).status, 200);
  const recovered = await post('/auth/reset/confirm', { token: other, password: newPassword });
  assert.equal(recovered.status, 200, 'the other still-valid mailbox proof remains usable');
  assert.equal(recovered.cookie === undefined, scenario.mfa);
  if (scenario.mfa) {
    assert.deepEqual(recovered.raw, { reset: true, totp_required: true, expires_after_minutes: 30 });
    assert.deepEqual((await pool.query('SELECT * FROM member_totp WHERE user_id=$1', [userId])).rows, priorMfa);
  }
});

for (const secure of [true, false]) test(`${secure ? 'HTTPS' : 'HTTP loopback'} reset issues a fresh session view and revokes pre-reset sessions`, async () => {
  const at = secure ? secureOrigin : origin, api = secure ? secureApp : app;
  const first = await post('/auth/login', { email, password: DEMO_PASSWORD }, secure);
  const second = await post('/auth/login', { email, password: DEMO_PASSWORD }, secure);
  assert.ok(first.cookie); assert.ok(second.cookie);
  assert.equal((await api.request(at + '/api/v1/session', { headers: { Cookie: first.cookie } })).status, 200);
  assert.equal((await post('/auth/reset/request', { email }, secure)).status, 200);
  const link = new URL(delivered.at(-1)!); assert.equal(link.origin, at);
  const token = link.hash.slice('#reset-password/'.length);
  const recovered = await post('/auth/reset/confirm', { token, password: newPassword }, secure);
  assert.equal(recovered.status, 200); assert.ok(recovered.cookie); assert.ok(recovered.data.csrf_token);
  assert.deepEqual(Object.keys(recovered.raw).sort(), ['csrf_token', 'expires_after_minutes', 'reset', 'user']);
  assert.equal(recovered.raw.reset, true); assert.equal(recovered.raw.expires_after_minutes, 30);
  assert.deepEqual(Object.keys(recovered.raw.user).sort(), ['display_name', 'email', 'profession_membership_ref', 'user_id']);
  assert.equal(recovered.data.user?.user_id, DEMO_USERS[0].user_id);
  const cookies = recovered.response.headers.getSetCookie(); assert.equal(cookies.length, 1);
  assert.match(cookies[0], secure ? /^__Host-freedom_session=/ : /^freedom_local_session=/);
  for (const attribute of ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=2592000']) assert.ok(cookies[0].split('; ').includes(attribute), attribute);
  assert.equal(cookies[0].split('; ').includes('Secure'), secure); assert.doesNotMatch(cookies[0], /(?:^|;\s*)Domain=/i);
  assert(!JSON.stringify(recovered.raw).includes(recovered.cookie.split('=')[1]));
  for (const old of [first, second]) {
    assert.notEqual(recovered.cookie, old.cookie);
    assert.equal((await api.request(at + '/api/v1/session', { headers: { Cookie: old.cookie! } })).status, 401);
    assert.ok((await pool.query('SELECT revoked_at FROM sessions WHERE token_hash=$1', [tokenHash(old.cookie!.split('=')[1])])).rows[0].revoked_at);
  }
  const active = await api.request(at + '/api/v1/session', { headers: { Cookie: recovered.cookie } });
  assert.equal(active.status, 200); assert.deepEqual(await active.json(), { user: recovered.raw.user, csrf_token: recovered.data.csrf_token });
});

for (const secure of [true, false]) test(`${secure ? 'HTTPS' : 'HTTP loopback'} reset revokes only the displaced browser session of another account`, async () => {
  const at = secure ? secureOrigin : origin, api = secure ? secureApp : app;
  const first = await post('/auth/login', { email: DEMO_USERS[1].email, password: DEMO_PASSWORD }, secure);
  const second = await post('/auth/login', { email: DEMO_USERS[1].email, password: DEMO_PASSWORD }, secure);
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  assert.ok(first.cookie); assert.ok(second.cookie); assert.notEqual(first.cookie, second.cookie);
  assert.match(first.cookie, secure ? /^__Host-freedom_session=/ : /^freedom_local_session=/);
  assert.equal((await api.request(at + '/api/v1/session', { headers: { Cookie: first.cookie } })).status, 200);
  assert.equal((await post('/auth/reset/request', { email }, secure)).status, 200);
  const link = new URL(delivered.at(-1)!); assert.equal(link.origin, at);
  const token = link.hash.slice('#reset-password/'.length);
  const invalid = await post('/auth/reset/confirm', { token: 'A'.repeat(43), password: newPassword }, secure, { Cookie: first.cookie });
  assert.equal(invalid.status, 422); assert.equal(invalid.data.code, 'reset_link_invalid');
  assert.equal(invalid.cookie, undefined);
  assert.equal((await api.request(at + '/api/v1/session', { headers: { Cookie: first.cookie } })).status, 200);
  assert.equal((await pool.query('SELECT revoked_at FROM sessions WHERE token_hash=$1', [tokenHash(first.cookie.split('=')[1])])).rows[0].revoked_at, null);
  const recovered = await post('/auth/reset/confirm', { token, password: newPassword }, secure, { Cookie: first.cookie });
  assert.equal(recovered.status, 200); assert.ok(recovered.cookie);
  const active = await api.request(at + '/api/v1/session', { headers: { Cookie: recovered.cookie } });
  assert.equal(active.status, 200); assert.equal(outcome.parse(await active.json()).user?.user_id, DEMO_USERS[0].user_id);
  assert.equal((await api.request(at + '/api/v1/session', { headers: { Cookie: first.cookie } })).status, 401);
  assert.ok((await pool.query('SELECT revoked_at FROM sessions WHERE token_hash=$1', [tokenHash(first.cookie.split('=')[1])])).rows[0].revoked_at);
  const other = await api.request(at + '/api/v1/session', { headers: { Cookie: second.cookie } });
  assert.equal(other.status, 200); assert.equal(outcome.parse(await other.json()).user?.user_id, DEMO_USERS[1].user_id);
  assert.equal((await pool.query('SELECT revoked_at FROM sessions WHERE token_hash=$1', [tokenHash(second.cookie.split('=')[1])])).rows[0].revoked_at, null);
});
