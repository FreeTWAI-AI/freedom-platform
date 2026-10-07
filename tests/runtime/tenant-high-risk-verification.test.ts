import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_USERS, DEMO_PASSWORD, DEMO_COMMUNITY } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { hashPassword, tokenHash } from '../../modules/identity-membership/service.js';

const origin = 'http://127.0.0.1:4310';
const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_thr_${process.pid}_${Date.now()}`;
const admin = createPool(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 8 });
const app = createApp(pool, origin, 'local', { guildLaunchpadEnabled: true });
const closed = createApp(pool, origin, 'local');
const marker = 'SYNTHETIC-MARKER-PASSWORD-pb2a';
type Session = { cookie: string; csrf: string; user: { user_id: string } };

before(async () => {
  assert.match(schema, /^fp_thr_[0-9]+_[0-9]+$/);
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
});
after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
beforeEach(async () => {
  await pool.query('TRUNCATE communities, login_attempts, auth_rate_limits CASCADE');
  await seedLocal(pool);
  await pool.query(`UPDATE tenant_authority_policies SET status='retired' WHERE status='active'`);
  await pool.query(`INSERT INTO tenant_authority_policies(revision,status,fresh_auth_ttl_seconds,transfer_ttl_seconds,recovery_approval_ttl_seconds,max_open_recovery_cases_per_tenant)
    VALUES (1,'active',600,86400,86400,1)`);
});

async function send(path: string, session: Session | undefined, body?: unknown, options: { key?: string | null; version?: string; target?: typeof app } = {}) {
  const headers: Record<string, string> = { Origin: origin, ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}) };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    if (options.key !== null) headers['Idempotency-Key'] = options.key ?? randomUUID();
    if (options.version !== undefined) headers['If-Match'] = options.version;
  }
  const response = await (options.target ?? app).request(origin + '/api/v1' + path, {
    method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) as Record<string, unknown> : {}, response, text };
}
async function signIn(email: string, password = DEMO_PASSWORD): Promise<Session> {
  const r = await send('/auth/login', undefined, { email, password }, { key: null });
  assert.equal(r.status, 200, r.text);
  return { cookie: r.response.headers.get('set-cookie')!.split(';')[0], csrf: String(r.data.csrf_token), user: r.data.user as Session['user'] };
}
async function person(name: string) {
  const id = randomUUID(), email = `tenant-${id}@example.test`;
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,active,onboarding_required)
    SELECT $1,$2,$3,$4,password_hash,$5,true,false FROM users WHERE email=$6`,
  [id, DEMO_COMMUNITY, email, name, randomUUID(), DEMO_USERS[0].email]);
  return { id, email, session: await signIn(email) };
}
const later = () => new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
async function createTenant(owner: Session) {
  const made = await send('/tenants', owner, { display_name: '品牌甲', workspace_name: '櫃檯甲' });
  assert.equal(made.status, 201, made.text);
  return made.data.tenant as { tenant_id: string; my_membership: { principal_id: string } };
}
async function principalOf(userId: string) {
  return (await pool.query<{ principal_id: string }>('SELECT principal_id FROM principals WHERE user_ref=$1', [userId])).rows[0].principal_id;
}
async function candidate(actor: Session, userId: string) {
  const found = await send(`/tenants/invite-candidates?user_id=${userId}`, actor);
  assert.equal(found.status, 200, found.text);
  return String(found.data.principal_id);
}
async function verify(session: Session, tenantId: string, purpose: string, password = DEMO_PASSWORD, key: string | null = null) {
  return send('/me/high-risk-verifications', session, { password, purpose, tenant_id: tenantId }, { key });
}
async function propose(owner: Session, tenantId: string, to: string, verificationId: string, key = randomUUID(), expiresAt = later()) {
  return send(`/tenants/${tenantId}/ownership-transfers`, owner, {
    to_principal_id: to, from_role_after: 'admin', expires_at: expiresAt, reason: '交給下一位擁有者', fresh_auth_verification_id: verificationId,
  }, { key });
}

test.skip('fresh verification rejects a wrong password without becoming 401 and ignores Idempotency-Key', async () => {
  const owner = await person('擁有者');
  const tenant = await createTenant(owner.session);
  const wrong = await verify(owner.session, tenant.tenant_id, 'tenant.ownership.propose', 'not-the-password', 'same-key-123');
  assert.equal(wrong.status, 403, wrong.text);
  assert.equal(wrong.data.code, 'fresh_auth_required');
  assert.equal(wrong.data.detail, '密碼不正確');
  assert.equal(wrong.text.includes('not-the-password'), false);
  const again = await verify(owner.session, tenant.tenant_id, 'tenant.ownership.propose', DEMO_PASSWORD, 'same-key-123');
  assert.equal(again.status, 201, again.text);
  const third = await verify(owner.session, tenant.tenant_id, 'tenant.ownership.propose', DEMO_PASSWORD, 'same-key-123');
  assert.equal(third.status, 201, third.text);
  assert.notEqual(again.data.verification_id, third.data.verification_id);
  assert.equal(again.response.headers.get('cache-control'), 'private, no-store');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM scoped_command_receipts WHERE operation='tenant.high_risk_verification'`)).rows[0].n, 0);
  const extra = await verify(owner.session, tenant.tenant_id, 'tenant.ownership.propose');
  const rejected = await send('/me/high-risk-verifications', owner.session, { password: DEMO_PASSWORD, purpose: 'tenant.ownership.propose', tenant_id: tenant.tenant_id, extra: true }, { key: null });
  assert.equal(rejected.status, 422);
  assert.equal(rejected.data.code, 'validation_failed');
  assert.equal(extra.status, 201);
});

test('unqualified callers do not increment the rate limit; the tenth failure is 403 and the next is 429', async () => {
  const owner = await person('擁有者');
  const stranger = await person('路人');
  const tenant = await createTenant(owner.session);
  for (let i = 0; i < 3; i++) {
    const hidden = await verify(stranger.session, tenant.tenant_id, 'tenant.ownership.propose', 'not-the-password');
    assert.equal(hidden.status, 404, hidden.text);
    assert.equal(hidden.data.code, 'tenant_not_found');
  }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM login_attempts WHERE attempt_key=$1', [tokenHash(`high-risk-verification:${stranger.id}`)])).rows[0].n, 0);
  for (let i = 0; i < 10; i++) {
    const failed = await verify(owner.session, tenant.tenant_id, 'tenant.ownership.propose', 'not-the-password');
    assert.equal(failed.status, 403, failed.text);
    assert.equal(failed.data.code, 'fresh_auth_required');
  }
  const limited = await verify(owner.session, tenant.tenant_id, 'tenant.ownership.propose', DEMO_PASSWORD);
  assert.equal(limited.status, 429, limited.text);
  assert.equal(limited.data.code, 'fresh_auth_rate_limited');
  assert.equal(limited.response.headers.get('retry-after'), '900');
  assert.equal((await pool.query('SELECT failures FROM login_attempts WHERE attempt_key=$1', [tokenHash(`high-risk-verification:${owner.id}`)])).rows[0].failures, 10);
});

test('policy missing is 403 for a qualified owner and still 404 for everyone else', async () => {
  const owner = await person('擁有者');
  const stranger = await person('路人');
  const tenant = await createTenant(owner.session);
  await pool.query(`UPDATE tenant_authority_policies SET status='retired' WHERE status='active'`);
  const hidden = await verify(stranger.session, tenant.tenant_id, 'tenant.ownership.propose');
  assert.equal(hidden.status, 404);
  const missing = await verify(owner.session, tenant.tenant_id, 'tenant.ownership.propose');
  assert.equal(missing.status, 403, missing.text);
  assert.equal(missing.data.code, 'policy_unconfigured');
  assert.equal((await pool.query('SELECT failures FROM login_attempts WHERE attempt_key=$1', [tokenHash(`high-risk-verification:${owner.id}`)])).rows[0].failures, 0);
});

test('a verification is bound to purpose, tenant and session, and logout keeps the row but blocks reuse', async () => {
  const owner = await person('擁有者');
  const recipient = await person('接收者');
  const first = await createTenant(owner.session);
  const second = await send('/tenants', owner.session, { display_name: '品牌乙', workspace_name: '櫃檯乙' });
  assert.equal(second.status, 201, second.text);
  const otherTenant = (second.data.tenant as { tenant_id: string }).tenant_id;
  const to = await candidate(owner.session, recipient.id);
  const made = await verify(owner.session, first.tenant_id, 'tenant.ownership.propose');
  assert.equal(made.status, 201, made.text);
  const otherTenantUse = await propose(owner.session, otherTenant, to, String(made.data.verification_id));
  assert.equal(otherTenantUse.status, 403, otherTenantUse.text);
  assert.equal(otherTenantUse.data.code, 'fresh_auth_required');
  const sessionHash = (await pool.query<{ token_hash: string }>('SELECT token_hash FROM sessions WHERE user_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1', [owner.id])).rows[0].token_hash;
  const principalId = await principalOf(owner.id);
  const wrongPurpose = (await pool.query<{ verification_id: string }>(`INSERT INTO tenant_high_risk_verifications(user_id,principal_id,session_hash,tenant_id,purpose,verified_at,expires_at)
    VALUES($1,$2,$3,$4,'tenant.ownership.accept',clock_timestamp(),clock_timestamp()+interval '5 minutes') RETURNING verification_id`,
  [owner.id, principalId, sessionHash, first.tenant_id])).rows[0].verification_id;
  const purpose = await propose(owner.session, first.tenant_id, to, wrongPurpose);
  assert.equal(purpose.status, 403, purpose.text);
  assert.equal(purpose.data.code, 'fresh_auth_required');
  const otherSession = await signIn(owner.email);
  const fresh = await verify(owner.session, first.tenant_id, 'tenant.ownership.propose');
  const crossed = await propose(otherSession, first.tenant_id, to, String(fresh.data.verification_id));
  assert.equal(crossed.status, 403, crossed.text);
  const current = await verify(owner.session, first.tenant_id, 'tenant.ownership.propose');
  const loggedOut = await app.request(origin + '/api/v1/auth/logout', {
    method: 'POST', headers: { Origin: origin, Cookie: owner.session.cookie, 'X-CSRF-Token': owner.session.csrf, 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(loggedOut.status, 200);
  assert.equal((await pool.query('SELECT consumed_at IS NULL AS open FROM tenant_high_risk_verifications WHERE verification_id=$1', [current.data.verification_id])).rows[0].open, true);
  const returned = await signIn(owner.email);
  const reused = await propose(returned, first.tenant_id, to, String(current.data.verification_id));
  assert.equal(reused.status, 403, reused.text);
  assert.equal(reused.data.code, 'fresh_auth_required');
});

test('database-clock expiry, single use and same-key replay follow the verification row', async () => {
  const owner = await person('擁有者');
  const recipient = await person('接收者');
  const tenant = await createTenant(owner.session);
  const to = await candidate(owner.session, recipient.id);
  const sessionHash = (await pool.query<{ token_hash: string }>('SELECT token_hash FROM sessions WHERE user_id=$1 AND revoked_at IS NULL LIMIT 1', [owner.id])).rows[0].token_hash;
  const expiredId = (await pool.query<{ verification_id: string }>(`INSERT INTO tenant_high_risk_verifications(user_id,principal_id,session_hash,tenant_id,purpose,verified_at,expires_at)
    VALUES($1,$2,$3,$4,'tenant.ownership.propose',clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 minute') RETURNING verification_id`,
  [owner.id, tenant.my_membership.principal_id, sessionHash, tenant.tenant_id])).rows[0].verification_id;
  const expired = await propose(owner.session, tenant.tenant_id, to, expiredId);
  assert.equal(expired.status, 403, expired.text);
  assert.equal(expired.data.code, 'fresh_auth_required');
  const made = await verify(owner.session, tenant.tenant_id, 'tenant.ownership.propose');
  const key = randomUUID();
  const expiresAt = later();
  const first = await propose(owner.session, tenant.tenant_id, to, String(made.data.verification_id), key, expiresAt);
  assert.equal(first.status, 201, first.text);
  const replay = await propose(owner.session, tenant.tenant_id, to, String(made.data.verification_id), key, expiresAt);
  assert.equal(replay.status, 201, replay.text);
  assert.equal(replay.data.transfer_id, first.data.transfer_id);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM tenant_ownership_transfers')).rows[0].n, 1);
  const second = await verify(owner.session, tenant.tenant_id, 'tenant.ownership.propose');
  await pool.query(`UPDATE tenant_ownership_transfers SET state='cancelled', version=version+1, decided_at=clock_timestamp() WHERE transfer_id=$1`, [first.data.transfer_id]);
  const reused = await propose(owner.session, tenant.tenant_id, to, String(made.data.verification_id));
  assert.equal(reused.status, 403, reused.text);
  const again = await propose(owner.session, tenant.tenant_id, to, String(second.data.verification_id));
  assert.equal(again.status, 201, again.text);
});

test('a retired policy blocks a consumed command and the marker password is absent from every text column', async () => {
  const owner = await person('擁有者');
  const tenant = await createTenant(owner.session);
  await pool.query('UPDATE users SET password_hash=$2 WHERE user_id=$1', [owner.id, hashPassword(marker)]);
  const made = await verify(owner.session, tenant.tenant_id, 'tenant.ownership.propose', marker);
  assert.equal(made.status, 201, made.text);
  assert.equal(made.text.includes(marker), false);
  await pool.query(`UPDATE tenant_authority_policies SET status='retired' WHERE status='active'`);
  const blocked = await propose(owner.session, tenant.tenant_id, tenant.my_membership.principal_id, String(made.data.verification_id));
  assert.equal(blocked.status, 403, blocked.text);
  assert.equal(blocked.data.code, 'policy_unconfigured');
  assert.equal(blocked.text.includes(marker), false);
  assert.equal((await pool.query('SELECT consumed_at IS NULL AS open FROM tenant_high_risk_verifications WHERE verification_id=$1', [made.data.verification_id])).rows[0].open, true);
  const columns = (await pool.query<{ relname: string; attname: string }>(`SELECT c.relname, a.attname
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_type t ON t.oid=a.atttypid
    WHERE n.nspname=current_schema() AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped AND t.typname IN ('text','varchar','json','jsonb','bpchar')`)).rows;
  for (const column of columns) {
    const rel = column.relname.replaceAll('"', '""'), att = column.attname.replaceAll('"', '""');
    const hit = await pool.query(`SELECT 1 FROM "${rel}" WHERE "${att}"::text LIKE $1 LIMIT 1`, [`%${marker}%`]);
    assert.equal(hit.rowCount, 0, `${column.relname}.${column.attname}`);
  }
  const off = await send('/me/high-risk-verifications', owner.session, { password: marker, purpose: 'tenant.ownership.propose', tenant_id: tenant.tenant_id }, { key: null, target: closed });
  assert.equal(off.status, 404);
  assert.equal(off.data.code, 'not_found');
});
