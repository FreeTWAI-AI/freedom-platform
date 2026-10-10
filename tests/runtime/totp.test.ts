import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_USERS, DEMO_PASSWORD } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { login } from '../../modules/identity-membership/service.js';
import { matchTotp, totpCode } from '../../modules/identity-membership/totp.js';
import { Problem } from '../../packages/shared/problem.js';
import { digest } from '../../packages/db/index.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname)) {
  throw new Error('Explicit isolated fp_* TEST_DATABASE_URL required.');
}
const origin = 'http://127.0.0.1:4310';
const schema = `fp_totp_${process.pid}_${Date.now()}`;
const admin = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: `-c search_path=${schema} -c statement_timeout=10000`, max: 12 });
// RFC 6238 Appendix B's SHA-1 secret, encoded as the enrollment wire format.
const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const encryptionKey = Buffer.alloc(32, 0x74).toString('base64');
const delivered: string[] = [];
const app = createApp(pool, origin, 'local', {
  totpEncryptionKey: encryptionKey,
  passwordEmailSender: async (_to, url) => { delivered.push(url); },
});
let created = false;
interface Session { cookie: string; csrf: string }
const replyBody = z.object({
  csrf_token: z.string().optional(), code: z.string().optional(),
  enabled: z.boolean().optional(), backup_codes: z.array(z.string()).optional(),
}).passthrough();
interface Reply { status: number; data: z.infer<typeof replyBody>; response: Response }

before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); created = true; await migrate(pool); });
after(async () => {
  await pool.end();
  try { if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
  finally { await admin.end(); }
});
beforeEach(async () => {
  await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE');
  await seedLocal(pool);
  delivered.length = 0;
});

async function request(path: string, body?: unknown, session?: Session, extra: Record<string, string> = {}, api = app): Promise<Reply> {
  const headers: Record<string, string> = { Origin: origin };
  if (session) Object.assign(headers, { Cookie: session.cookie, 'X-CSRF-Token': session.csrf });
  if (body !== undefined) Object.assign(headers, { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() });
  Object.assign(headers, extra);
  const response = await api.request(origin + '/api/v1' + path, {
    method: body === undefined ? 'GET' : 'POST', headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: replyBody.parse(await response.json()), response };
}
async function signIn(index = 0): Promise<Session> {
  const reply = await request('/auth/login', { email: DEMO_USERS[index].email, password: DEMO_PASSWORD });
  assert.equal(reply.status, 200);
  return sessionOf(reply);
}
function sessionOf(reply: Reply): Session {
  const cookie = reply.response.headers.get('set-cookie');
  assert.ok(cookie);
  assert.ok(typeof reply.data.csrf_token === 'string');
  return { cookie: cookie.split(';')[0], csrf: reply.data.csrf_token };
}
async function counter(): Promise<number> {
  return Number((await pool.query('SELECT floor(extract(epoch FROM clock_timestamp()) / 30)::bigint AS counter')).rows[0].counter);
}
async function enroll(session: Session, index = 0) {
  // The current enrollment step is consumed; OTP login tests use its next allowed step.
  const at = await counter();
  const reply = await request('/me/totp/enable', { password: DEMO_PASSWORD, secret, code: totpCode(secret, at) }, session);
  assert.equal(reply.status, 200);
  assert.deepEqual(Object.keys(reply.data).sort(), ['backup_codes', 'enabled']);
  assert.equal(reply.data.enabled, true);
  assert.ok(reply.data.backup_codes && reply.data.backup_codes.length > 0);
  assert.equal(new Set(reply.data.backup_codes).size, reply.data.backup_codes.length);
  const row = (await pool.query('SELECT last_counter FROM member_totp WHERE user_id=$1', [DEMO_USERS[index].user_id])).rows[0];
  assert.equal(Number(row.last_counter), at);
  return { codes: reply.data.backup_codes, at };
}
async function sessionCount(index = 0): Promise<number> {
  return (await pool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id=$1', [DEMO_USERS[index].user_id])).rows[0].n;
}
function noSession(reply: Reply) {
  assert.equal(reply.response.headers.get('set-cookie'), null);
  assert.equal(reply.data.csrf_token, undefined);
  assert.equal(reply.data.user, undefined);
  assert.equal(reply.data.token, undefined);
}
const status = (expected: number) => (error: unknown) => error instanceof Problem && error.status === expected;

// Published SHA-1 vectors are independent expected values, not generated by the implementation.
for (const [seconds, expected] of [
  [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
  [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130'],
] as const) {
  test(`RFC 6238 SHA-1 vector at ${seconds} seconds`, () => {
    assert.equal(totpCode(secret, Math.floor(seconds / 30), 8), expected);
    assert.equal(totpCode(secret, Math.floor(seconds / 30)), expected.slice(-6));
  });
}

test('six-digit verification permits only adjacent steps and rejects malformed codes and replay counters', () => {
  const at = 41152263, now = at * 30000;
  for (const offset of [-1, 0, 1]) {
    const code = totpCode(secret, at + offset);
    assert.equal(matchTotp(secret, code, now, at - 2), at + offset);
    assert.equal(matchTotp(secret, code, now, at + offset), null);
    assert.equal(matchTotp(secret, code, now, at + offset + 1), null);
  }
  for (const offset of [-2, 2]) assert.equal(matchTotp(secret, totpCode(secret, at + offset), now, -1), null);
  for (const code of ['12345', '1234567', 'abcdef', '１２３４５６', ' 123456', '123456\n']) {
    assert.equal(matchTotp(secret, code, now, -1), null);
  }
  const code = totpCode(secret, at);
  assert.equal(matchTotp(secret, code, now + 29999, -1), at);
  assert.equal(matchTotp(secret, totpCode(secret, at - 1), now + 30000, -1), null);
});

test('MFA login repeats password plus code; missing/wrong/replayed codes never create sessions', async () => {
  const session = await signIn(), { at } = await enroll(session), initial = await sessionCount();
  const credentials = { email: DEMO_USERS[0].email, password: DEMO_PASSWORD };
  const required = await request('/auth/login', credentials);
  assert.equal(required.status, 401); assert.equal(required.data.code, 'totp_required'); noSession(required);
  assert.equal(await sessionCount(), initial);
  const replayEnrollment = await request('/auth/login', { ...credentials, code: totpCode(secret, at) });
  assert.equal(replayEnrollment.status, 401); noSession(replayEnrollment);
  const badPassword = await request('/auth/login', { ...credentials, password: 'wrong-password', code: totpCode(secret, await counter()) });
  assert.equal(badPassword.status, 401); noSession(badPassword);
  assert.equal(await sessionCount(), initial);
  const code = totpCode(secret, at + 1);
  const accepted = await request('/auth/login', { ...credentials, code });
  assert.equal(accepted.status, 200);
  assert.equal((await request('/session', undefined, sessionOf(accepted))).status, 200);
  const repeated = await request('/auth/login', { ...credentials, code });
  assert.equal(repeated.status, 401); noSession(repeated);
  assert.equal(await sessionCount(), initial + 1);
});

test('simultaneous TOTP submissions admit exactly one session', async () => {
  const session = await signIn(), { at } = await enroll(session);
  const initial = await sessionCount();
  const body = { email: DEMO_USERS[0].email, password: DEMO_PASSWORD, code: totpCode(secret, at + 1) };
  const replies = await Promise.all([request('/auth/login', body), request('/auth/login', body)]);
  assert.deepEqual(replies.map(r => r.status).sort(), [200, 401]);
  noSession(replies.find(r => r.status === 401)!);
  assert.equal(await sessionCount(), initial + 1);
});

test('backup codes are stored only as hashes and each code is atomically single-use', async () => {
  const session = await signIn(), { codes } = await enroll(session);
  const stored = (await pool.query<{ user_id: string; code_hash: string }>('SELECT * FROM member_totp_backup_codes WHERE user_id=$1', [DEMO_USERS[0].user_id])).rows;
  assert.equal(stored.length, codes.length);
  for (const row of stored) {
    assert.deepEqual(Object.keys(row).sort(), ['code_hash', 'user_id']);
    assert.match(row.code_hash, /^[a-f0-9]{64}$/);
    assert.equal(codes.includes(row.code_hash), false);
  }
  assert.deepEqual(stored.map(row => row.code_hash).sort(), codes.map(code => createHash('sha256').update(code).digest('hex')).sort());
  const initial = await sessionCount();
  const body = { email: DEMO_USERS[0].email, password: DEMO_PASSWORD, code: codes[0] };
  const replies = await Promise.all([request('/auth/login', body), request('/auth/login', body)]);
  assert.deepEqual(replies.map(r => r.status).sort(), [200, 401]);
  noSession(replies.find(r => r.status === 401)!);
  assert.equal(await sessionCount(), initial + 1);
  const replay = await request('/auth/login', body);
  assert.equal(replay.status, 401); noSession(replay);
  const remaining = await request('/me/totp', undefined, sessionOf(replies.find(r => r.status === 200)!));
  assert.deepEqual(remaining.data, { enabled: true, backup_codes_remaining: codes.length - 1 });
});

test('disable requires both the current password and a valid second factor', async () => {
  const session = await signIn(), { codes } = await enroll(session);
  for (const body of [
    { password: 'wrong-password', code: codes[0] },
    { password: DEMO_PASSWORD, code: 'invalid-backup-code' },
  ]) {
    assert.equal((await request('/me/totp/disable', body, session)).status, 401);
    assert.deepEqual((await request('/me/totp', undefined, session)).data, { enabled: true, backup_codes_remaining: codes.length });
  }
  const disabled = await request('/me/totp/disable', { password: DEMO_PASSWORD, code: codes[0] }, session);
  assert.equal(disabled.status, 200); assert.deepEqual(disabled.data, { enabled: false });
  assert.deepEqual((await request('/me/totp', undefined, session)).data, { enabled: false, backup_codes_remaining: 0 });
  const row = (await pool.query('SELECT enabled,secret_ciphertext FROM member_totp WHERE user_id=$1', [DEMO_USERS[0].user_id])).rows[0];
  assert.equal(row.enabled, false); assert.equal(row.secret_ciphertext, null);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM member_totp_backup_codes')).rows[0].n, 0);
  assert.equal((await request('/auth/login', { email: DEMO_USERS[0].email, password: DEMO_PASSWORD })).status, 200);
});

test('per-user second-factor budget survives renewed password login and application recreation', async () => {
  const session = await signIn(), { codes } = await enroll(session);
  const email = DEMO_USERS[0].email, initial = await sessionCount();
  // Use the real service so a separate HTTP/network budget cannot mask the account limiter.
  for (let i = 0; i < 10; i++) {
    await assert.rejects(login(pool, email, DEMO_PASSWORD, undefined, encryptionKey), status(401));
    await assert.rejects(login(pool, email, DEMO_PASSWORD, 'invalid-backup-code', encryptionKey), status(401));
  }
  assert.equal((await pool.query('SELECT failures FROM member_totp WHERE user_id=$1', [DEMO_USERS[0].user_id])).rows[0].failures, 10);
  await assert.rejects(login(pool, email, DEMO_PASSWORD, codes[0], encryptionKey), status(429));
  const freshApp = createApp(pool, origin, 'local', { totpEncryptionKey: encryptionKey });
  const blocked = await request('/auth/login', { email, password: DEMO_PASSWORD, code: codes[0] }, undefined, {}, freshApp);
  assert.equal(blocked.status, 429); noSession(blocked);
  assert.equal(await sessionCount(), initial);
  assert.equal((await request('/auth/login', { email: DEMO_USERS[1].email, password: DEMO_PASSWORD }, undefined, {}, freshApp)).status, 200);
  await pool.query("UPDATE member_totp SET window_start=clock_timestamp()-interval '16 minutes' WHERE user_id=$1", [DEMO_USERS[0].user_id]);
  assert.equal((await request('/auth/login', { email, password: DEMO_PASSWORD, code: codes[0] }, undefined, {}, freshApp)).status, 200);
});

test('management password failures and login code failures share the member second-factor budget', async () => {
  const session = await signIn(), { codes } = await enroll(session);
  for (let i = 0; i < 5; i++) {
    assert.equal((await request('/me/totp/disable', { password: 'wrong-password', code: codes[0] }, session)).status, 401);
    await assert.rejects(login(pool, DEMO_USERS[0].email, DEMO_PASSWORD, 'invalid-backup-code', encryptionKey), status(401));
    await assert.rejects(login(pool, DEMO_USERS[0].email, DEMO_PASSWORD, undefined, encryptionKey), status(401));
  }
  const blocked = await request('/me/totp/disable', { password: DEMO_PASSWORD, code: codes[0] }, session);
  assert.equal(blocked.status, 429);
  assert.deepEqual((await request('/me/totp', undefined, session)).data, { enabled: true, backup_codes_remaining: codes.length });
  await assert.rejects(login(pool, DEMO_USERS[0].email, DEMO_PASSWORD, codes[0], encryptionKey), status(429));
});

test('TOTP management preserves authentication, CSRF, Origin and idempotency boundaries', async () => {
  const session = await signIn();
  assert.deepEqual((await request('/me/totp', undefined, session)).data, { enabled: false, backup_codes_remaining: 0 });
  assert.equal((await request('/me/totp')).status, 401);
  const enable = { password: DEMO_PASSWORD, secret, code: totpCode(secret, await counter()) };
  assert.equal((await request('/me/totp/enable', enable)).status, 401);
  const rejectedHeaders: Record<string, string>[] = [
    { 'X-CSRF-Token': '' }, { 'X-CSRF-Token': 'wrong' }, { Origin: 'https://evil.example' },
  ];
  for (const headers of rejectedHeaders) {
    assert.equal((await request('/me/totp/enable', enable, session, headers)).status, 403);
  }
  assert.equal((await request('/me/totp/enable', enable, session, { 'Idempotency-Key': '' })).status, 400);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM member_totp WHERE enabled')).rows[0].n, 0);
  const { codes } = await enroll(session);
  const disable = { password: DEMO_PASSWORD, code: codes[0] };
  assert.equal((await request('/me/totp/disable', disable)).status, 401);
  for (const headers of rejectedHeaders) {
    assert.equal((await request('/me/totp/disable', disable, session, headers)).status, 403);
  }
  assert.equal((await request('/me/totp/disable', disable, session, { 'Idempotency-Key': '' })).status, 400);
  const other = await signIn(1);
  assert.deepEqual((await request('/me/totp', undefined, other)).data, { enabled: false, backup_codes_remaining: 0 });
  assert.equal((await request('/me/totp/disable', disable, other)).status, 409);
  assert.deepEqual((await request('/me/totp', undefined, session)).data, { enabled: true, backup_codes_remaining: codes.length });
  await request('/auth/logout', {}, session);
  assert.equal((await request('/me/totp', undefined, session)).status, 401);
});

test('secret and one-time backup plaintext never enter response projections, logs or durable rows', async t => {
  const logs: unknown[][] = [];
  for (const method of ['log', 'warn', 'error', 'info', 'debug'] as const) t.mock.method(console, method, (...args: unknown[]) => { logs.push(args); });
  const session = await signIn(), secondSession = await signIn(), key = randomUUID();
  const body = { password: DEMO_PASSWORD, secret, code: totpCode(secret, await counter()) };
  const enabled = await request('/me/totp/enable', body, session, { 'Idempotency-Key': key });
  assert.equal(enabled.status, 200);
  assert.equal(JSON.stringify(enabled.data).includes(secret), false);
  const codes = enabled.data.backup_codes;
  assert.ok(codes && codes.length > 0);
  assert.equal((await request('/session', undefined, secondSession)).status, 401, 'enrollment revokes other sessions');
  const repeated = await request('/me/totp/enable', body, session, { 'Idempotency-Key': key });
  assert.equal(repeated.status, 409);
  const replies = [repeated, await request('/me/totp', undefined, session), await request('/session', undefined, session)];
  for (const reply of replies) {
    const raw = JSON.stringify(reply.data);
    assert.equal([secret, ...codes].some(value => raw.includes(value)), false);
  }
  const ciphertext = (await pool.query('SELECT secret_ciphertext FROM member_totp WHERE user_id=$1', [DEMO_USERS[0].user_id])).rows[0].secret_ciphertext;
  assert.ok(ciphertext); assert.notEqual(String(ciphertext), secret);
  const wrongKeyApp = createApp(pool, origin, 'local', { totpEncryptionKey: Buffer.alloc(32, 0x75).toString('base64') });
  const failed = await request('/auth/login', { email: DEMO_USERS[0].email, password: DEMO_PASSWORD, code: totpCode(secret, await counter()) }, undefined, {}, wrongKeyApp);
  assert.ok(failed.status >= 500); noSession(failed);
  assert.equal([secret, ...codes, encryptionKey].some(value => JSON.stringify(failed.data).includes(value)), false);
  assert.equal([secret, ...codes, encryptionKey, DEMO_PASSWORD].some(value => JSON.stringify(logs).includes(value)), false);
  // Scan every physical table, including receipts/journals, rather than only the new tables.
  const tables = (await pool.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename")).rows;
  for (const { tablename } of tables) {
    const quoted = '"' + tablename.replaceAll('"', '""') + '"';
    const found: boolean = (await pool.query<{found:boolean}>(`SELECT EXISTS(SELECT 1 FROM ${quoted} r WHERE EXISTS(SELECT 1 FROM unnest($1::text[]) s(value) WHERE strpos(row_to_json(r)::text,s.value)>0)) AS found`, [[secret, ...codes, encryptionKey]])).rows[0].found;
    assert.equal(found, false, `plaintext leaked into ${tablename}`);
  }
});

test('mailbox password reset keeps MFA enabled and never issues an authenticated session', async () => {
  const session = await signIn(), { codes } = await enroll(session), initial = await sessionCount();
  const email = DEMO_USERS[0].email, newPassword = 'synthetic-totp-reset-password-2026';
  assert.equal((await request('/auth/reset/request', { email })).status, 200);
  const token = /\/([A-Za-z0-9_-]{43})$/.exec(delivered.at(-1) ?? '')?.[1];
  assert.ok(token);
  const reset = await request('/auth/reset/confirm', { token, password: newPassword }, session);
  assert.equal(reset.status, 200);
  assert.deepEqual(reset.data, { reset: true, totp_required: true, expires_after_minutes: 30 });
  noSession(reset); assert.equal(await sessionCount(), initial);
  assert.equal((await request('/session', undefined, session)).status, 401);
  assert.equal((await request('/auth/reset/confirm', { token, password: newPassword })).status, 422);
  assert.equal((await request('/auth/login', { email, password: DEMO_PASSWORD, code: codes[0] })).status, 401);
  const required = await request('/auth/login', { email, password: newPassword });
  assert.equal(required.status, 401); assert.equal(required.data.code, 'totp_required'); noSession(required);
  assert.equal(await sessionCount(), initial);
  const signedIn = await request('/auth/login', { email, password: newPassword, code: codes[0] });
  assert.equal(signedIn.status, 200);
  assert.deepEqual((await request('/me/totp', undefined, sessionOf(signedIn))).data, { enabled: true, backup_codes_remaining: codes.length - 1 });
});

for (const transition of ['enable', 'disable'] as const) {
  test(`TOTP transition ${transition} receipts bind only the transition and generation`, async () => {
    const session=await signIn(),key=randomUUID();
    const codes=transition==='disable'?(await enroll(session)).codes:undefined;
    const body=transition==='enable'?{password:DEMO_PASSWORD,secret,code:totpCode(secret,await counter())}:{password:DEMO_PASSWORD,code:codes![0]};
    assert.equal((await request('/me/totp/'+transition,body,session,{'Idempotency-Key':key})).status,200);
    const operation='member.totp.'+transition,generation=transition==='enable'?'1':'2';
    const receipt=(await pool.query('SELECT request_sha256,response FROM command_receipts WHERE user_id=$1 AND operation=$2 AND idempotency_key=$3',[DEMO_USERS[0].user_id,operation,key])).rows[0];
    assert.deepEqual(receipt,{request_sha256:digest({body:{transition:operation,generation},expected:null}),response:{enabled:transition==='enable',generation}});
    assert.notEqual(receipt.request_sha256,digest({body,expected:null}));
  });

  test(`TOTP completed ${transition} replay rechecks the current password without issuing factors again`, async () => {
    const session=await signIn(),key=randomUUID();
    const codes=transition==='disable'?(await enroll(session)).codes:undefined;
    const body=transition==='enable'?{password:DEMO_PASSWORD,secret,code:totpCode(secret,await counter())}:{password:DEMO_PASSWORD,code:codes![0]};
    assert.equal((await request('/me/totp/'+transition,body,session,{'Idempotency-Key':key})).status,200);
    const nextPassword='synthetic-totp-replay-new-password';
    const changed=await request('/me/password',{current_password:DEMO_PASSWORD,new_password:nextPassword},session);
    assert.equal(changed.status,200);
    const old=await request('/me/totp/'+transition,body,session,{'Idempotency-Key':key});
    assert.equal(old.status,401);assert.equal(old.data.code,'invalid_totp');
    const replay=await request('/me/totp/'+transition,{...body,password:nextPassword},session,{'Idempotency-Key':key});
    assert.equal(replay.status,transition==='enable'?409:200);
    if(transition==='enable')assert.equal(replay.data.code,'totp_backup_codes_already_delivered');
    else assert.deepEqual(replay.data,{enabled:false});
    assert.equal(replay.data.backup_codes,undefined);
    assert.equal((await pool.query('SELECT failures FROM member_totp WHERE user_id=$1',[DEMO_USERS[0].user_id])).rows[0].failures,1);
  });
}

test('TOTP old disable receipt cannot replay after a later enable and disable generation',async()=>{
  const session=await signIn(),key=randomUUID(),first=await enroll(session);
  const body={password:DEMO_PASSWORD,code:first.codes[0]};
  assert.equal((await request('/me/totp/disable',body,session,{'Idempotency-Key':key})).status,200);
  assert.equal((await request('/me/totp/disable',body,session,{'Idempotency-Key':key})).status,200);
  const next=await enroll(session);
  assert.equal((await request('/me/totp/disable',body,session,{'Idempotency-Key':key})).status,409);
  assert.equal((await request('/me/totp/disable',{password:DEMO_PASSWORD,code:next.codes[0]},session)).status,200);
  const stale=await request('/me/totp/disable',body,session,{'Idempotency-Key':key});
  assert.equal(stale.status,409);assert.equal(stale.data.code,'totp_state_changed');
  assert.equal((await pool.query('SELECT generation FROM member_totp WHERE user_id=$1',[DEMO_USERS[0].user_id])).rows[0].generation,'4');
});
