import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createPool, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_USERS, DEMO_PASSWORD, DEMO_COMMUNITY } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { createAdminAccessVerifier } from '../../modules/platform-admin/access.js';

const origin = 'http://127.0.0.1:4310';
const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_rcv_${process.pid}_${Date.now()}`;
const adminPool = createPool(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 8 });
const issuer = 'https://test-team.cloudflareaccess.com';
const audience = 'admin-recovery-tests';
const pair = await generateKeyPair('RS256');
const jwk = await exportJWK(pair.publicKey);
const verifier = createAdminAccessVerifier({
  issuer, audience, csrfSecret: 'test-fixture-admin-csrf-secret-123456789',
  keySet: createLocalJWKSet({ keys: [{ ...jwk, kid: 'admin-test', alg: 'RS256' }] }),
});
const app = createApp(pool, origin, 'local', { adminVerifier: verifier, guildLaunchpadEnabled: true });

type Session = { cookie: string; csrf: string; user: { user_id: string } };
type Admin = { id: string; email: string; jwt: string; csrf: string };
type Reply = { status: number; data: any; text: string; etag: string | null; cacheControl: string | null };

const roster = {
  opener: { id: randomUUID(), email: 'recovery-opener@example.test', name: '開啟者', capabilities: ['tenant.recovery.open', 'tenant.recovery.review', 'tenant.recovery.execute'] },
  reviewer: { id: randomUUID(), email: 'recovery-reviewer@example.test', name: '核准者', capabilities: ['tenant.recovery.review', 'tenant.recovery.execute', 'tenant.recovery.read'] },
  executor: { id: randomUUID(), email: 'recovery-executor@example.test', name: '執行者', capabilities: ['tenant.recovery.execute'] },
  bare: { id: randomUUID(), email: 'recovery-bare@example.test', name: '無權限', capabilities: [] as string[] },
};
const admins: Record<keyof typeof roster, Admin> = {
  opener: { id: roster.opener.id, email: roster.opener.email, jwt: '', csrf: '' },
  reviewer: { id: roster.reviewer.id, email: roster.reviewer.email, jwt: '', csrf: '' },
  executor: { id: roster.executor.id, email: roster.executor.email, jwt: '', csrf: '' },
  bare: { id: roster.bare.id, email: roster.bare.email, jwt: '', csrf: '' },
};

before(async () => {
  assert.match(schema, /^fp_rcv_[0-9]+_[0-9]+$/);
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  for (const key of Object.keys(roster) as Array<keyof typeof roster>) {
    const jwt = await sign(roster[key].email);
    const csrf = (await verifier(new Request(origin, { headers: { 'Cf-Access-Jwt-Assertion': jwt } }))).csrfToken;
    admins[key] = { id: roster[key].id, email: roster[key].email, jwt, csrf };
  }
});
after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
  await adminPool.end();
});
beforeEach(async () => {
  await pool.query('TRUNCATE communities, login_attempts, auth_rate_limits CASCADE');
  await seedLocal(pool);
  await pool.query(`UPDATE tenant_authority_policies SET status='retired' WHERE status='active'`);
  await pool.query(`INSERT INTO tenant_authority_policies(revision,status,fresh_auth_ttl_seconds,transfer_ttl_seconds,recovery_approval_ttl_seconds,max_open_recovery_cases_per_tenant)
    VALUES (1,'active',600,86400,86400,1)`);
  for (const key of Object.keys(roster) as Array<keyof typeof roster>) {
    const row = roster[key];
    await pool.query(`INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)`, [row.id, DEMO_COMMUNITY, row.email, row.name]);
    for (const capability of row.capabilities) {
      await pool.query(`INSERT INTO platform_admin_tenant_recovery_capabilities(admin_id,capability) VALUES($1,$2)`, [row.id, capability]);
    }
  }
});

async function sign(email: string) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ type: 'app', email, sub: 'verified-human-fixture', iss: issuer, aud: audience, iat: now, nbf: now, exp: now + 600 })
    .setProtectedHeader({ alg: 'RS256', kid: 'admin-test' }).sign(pair.privateKey);
}
async function send(path: string, session: Session | undefined, body?: unknown, version?: string): Promise<Reply> {
  const headers: Record<string, string> = { Origin: origin, ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}) };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['Idempotency-Key'] = randomUUID();
    if (version !== undefined) headers['If-Match'] = version;
  }
  const response = await app.request(origin + '/api/v1' + path, {
    method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : {}, text, etag: response.headers.get('etag'), cacheControl: response.headers.get('cache-control') };
}
async function admin(who: Admin, path: string, body?: unknown, version?: string): Promise<Reply> {
  const headers: Record<string, string> = { Origin: origin, 'Cf-Access-Jwt-Assertion': who.jwt, 'X-Admin-CSRF': who.csrf };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['Idempotency-Key'] = randomUUID();
    if (version !== undefined) headers['If-Match'] = version.startsWith('"') ? version : `"${version}"`;
  }
  const response = await app.request(origin + '/admin/api' + path, {
    method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : {}, text, etag: response.headers.get('etag'), cacheControl: response.headers.get('cache-control') };
}
async function login(email: string): Promise<Session> {
  const response = await app.request(origin + '/api/v1/auth/login', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: DEMO_PASSWORD }),
  });
  const data = await response.json() as { csrf_token: string; user: Session['user'] };
  assert.equal(response.status, 200, JSON.stringify(data));
  return { cookie: response.headers.get('set-cookie')!.split(';')[0], csrf: data.csrf_token, user: data.user };
}
async function person(name: string) {
  const id = randomUUID(), email = `tenant-${id}@example.test`;
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,active,onboarding_required)
    SELECT $1,$2,$3,$4,password_hash,$5,true,false FROM users WHERE email=$6`,
  [id, DEMO_COMMUNITY, email, name, randomUUID(), DEMO_USERS[0].email]);
  return { id, email, session: await login(email) };
}
async function createTenant(owner: Session, name = '品牌甲') {
  const made = await send('/tenants', owner, { display_name: name, workspace_name: name + '櫃' });
  assert.equal(made.status, 201, made.text);
  return made.data.tenant as { tenant_id: string; my_membership: { principal_id: string } };
}
async function candidate(actor: Session, userId: string) {
  const found = await send(`/tenants/invite-candidates?user_id=${userId}`, actor);
  assert.equal(found.status, 200, found.text);
  return (found.data as { principal_id?: string }).principal_id as string;
}
async function verify(session: Session, tenantId: string, purpose: string) {
  const response = await app.request(origin + '/api/v1/me/high-risk-verifications', {
    method: 'POST',
    headers: { Origin: origin, Cookie: session.cookie, 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEMO_PASSWORD, purpose, tenant_id: tenantId }),
  });
  const data = await response.json() as { verification_id?: string };
  assert.equal(response.status, 201, JSON.stringify(data));
  return data.verification_id as string;
}
async function disable(userId: string, version = '1') {
  return admin(admins.opener, `/members/${userId}/status`, { active: false, reason: '會員要求暫停帳號。' }, version);
}
async function enable(userId: string, version: string) {
  return admin(admins.opener, `/members/${userId}/status`, { active: true, reason: '會員要求恢復帳號。' }, version);
}
async function tenantStatus(tenantId: string) {
  return (await pool.query<{ status: string }>(`SELECT status FROM tenants WHERE tenant_id=$1`, [tenantId])).rows[0].status;
}
async function counts(tenantId: string) {
  const row = (await pool.query<{ members: number; spaces: number }>(`SELECT
    (SELECT count(*)::int FROM tenant_memberships WHERE tenant_id=$1) AS members,
    (SELECT count(*)::int FROM workspaces WHERE tenant_id=$1) AS spaces`, [tenantId])).rows[0];
  return row;
}
async function open(who: Admin, tenantId: string, principalId: string) {
  return admin(who, '/tenant-recovery-cases', {
    tenant_id: tenantId, proposed_owner_principal_id: principalId, reason: '唯一可登入的擁有者已停用', evidence_ref: randomUUID(),
  });
}
async function approve(who: Admin, caseId: string, version: string, expiresAt?: string) {
  return admin(who, `/tenant-recovery-cases/${caseId}/approve`, {
    approved_scope: ['tenant.owner.restore'],
    expires_at: expiresAt ?? new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    reason: '證據足夠，核准恢復擁有者',
  }, version);
}
const laterVersion = (value: Reply) => value.data.version ?? value.data.case?.version ?? '';

test('T-014 disabling the only loginable owner requires recovery and keeps the data', async () => {
  const owner = await person('擁有者');
  const viewer = await person('檢視者');
  const leader = await person('會長');
  const tenant = await createTenant(owner.session);
  const viewerPrincipal = await candidate(owner.session, viewer.id);
  await pool.query(`INSERT INTO tenant_memberships(tenant_id,principal_id,role,status,accepted_at) VALUES($1,$2,'viewer','active',clock_timestamp())`, [tenant.tenant_id, viewerPrincipal]);
  const before = await counts(tenant.tenant_id);
  const disabled = await disable(owner.id);
  assert.equal(disabled.status, 200, disabled.text);
  assert.equal(await tenantStatus(tenant.tenant_id), 'recovery_required');
  assert.deepEqual(await counts(tenant.tenant_id), before);
  const memberships = (await pool.query<{ role: string; status: string; active: boolean }>(`SELECT m.role, m.status, u.active
    FROM tenant_memberships m JOIN principals p ON p.principal_id=m.principal_id JOIN users u ON u.user_id=p.user_ref
    WHERE m.tenant_id=$1 ORDER BY m.role`, [tenant.tenant_id])).rows;
  assert.deepEqual(memberships.map(row => row.role).sort(), ['owner', 'viewer']);
  assert.equal(memberships.find(row => row.role === 'owner')?.status, 'active');
  assert.equal(memberships.find(row => row.role === 'owner')?.active, false);
  const read = await send(`/tenants/${tenant.tenant_id}`, viewer.session);
  assert.equal(read.status, 200, read.text);
  assert.equal(read.data.status, 'recovery_required');
  const mutation = await send(`/tenants/${tenant.tenant_id}/leave`, viewer.session, {}, '"1"');
  assert.equal(mutation.status, 409, mutation.text);
  assert.equal(mutation.data.code, 'tenant_recovery_required');
  assert.deepEqual(await counts(tenant.tenant_id), before);
  const ownerRead = await send(`/tenants/${tenant.tenant_id}`, owner.session);
  assert.equal(ownerRead.status, 401, ownerRead.text);
  assert.equal(ownerRead.data.code, 'session_expired');
  await pool.query(`INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) VALUES($1,'guild_marketing',$2)
    ON CONFLICT (community_id,guild_key) DO UPDATE SET user_id=EXCLUDED.user_id`, [DEMO_COMMUNITY, leader.id]);
  await pool.query(`INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)`, [randomUUID(), DEMO_COMMUNITY, leader.email, '會長']);
  const hidden = await send(`/tenants/${tenant.tenant_id}`, leader.session);
  assert.equal(hidden.status, 404, hidden.text);
  assert.equal(hidden.data.code, 'tenant_not_found');
  assert.equal((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM tenant_memberships m JOIN principals p ON p.principal_id=m.principal_id
    WHERE m.tenant_id=$1 AND p.user_ref=$2`, [tenant.tenant_id, leader.id])).rows[0].n, 0);
  const adminRead = await app.request(origin + `/api/v1/tenants/${tenant.tenant_id}`, {
    headers: { Origin: origin, 'Cf-Access-Jwt-Assertion': admins.opener.jwt },
  });
  assert.equal(adminRead.status, 401);
  assert.equal((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM scoped_outbox WHERE event_type='freedom.tenant.recovery.required.v1'`)).rows[0].n, 1);
});

test('T-014 disabling one of two loginable owners leaves the tenant active', async () => {
  const owner = await person('擁有者');
  const other = await person('另一位擁有者');
  const tenant = await createTenant(owner.session);
  const otherPrincipal = await candidate(owner.session, other.id);
  await pool.query(`INSERT INTO tenant_memberships(tenant_id,principal_id,role,status,accepted_at) VALUES($1,$2,'owner','active',clock_timestamp())`, [tenant.tenant_id, otherPrincipal]);
  const disabled = await disable(owner.id);
  assert.equal(disabled.status, 200, disabled.text);
  assert.equal(await tenantStatus(tenant.tenant_id), 'active');
  assert.equal((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM scoped_outbox WHERE event_type='freedom.tenant.recovery.required.v1'`)).rows[0].n, 0);
});

test('T-014 reactivation restores an evidence-only tenant and writes no extra outbox event', async () => {
  const owner = await person('擁有者');
  const recipient = await person('接收者');
  const tenant = await createTenant(owner.session);
  const to = await candidate(owner.session, recipient.id);
  const disabled = await disable(owner.id);
  assert.equal(disabled.status, 200, disabled.text);
  assert.equal(disabled.data.aggregate_version, 2);
  const opened = await open(admins.opener, tenant.tenant_id, to);
  assert.equal(opened.status, 201, opened.text);
  assert.equal(opened.data.state, 'evidence_required');
  const eventsBefore = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM scoped_outbox WHERE event_type='freedom.tenant.recovery.required.v1'`)).rows[0].n;
  const restored = await enable(owner.id, '2');
  assert.equal(restored.status, 200, restored.text);
  assert.equal(await tenantStatus(tenant.tenant_id), 'active');
  assert.equal((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM scoped_outbox WHERE event_type='freedom.tenant.recovery.required.v1'`)).rows[0].n, eventsBefore);
  assert.equal((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM scoped_outbox WHERE event_type LIKE 'freedom.tenant.ownership.transferred%'`)).rows[0].n, 0);
  const reasons = (await pool.query<{ reason_code: string }>(`SELECT reason_code FROM tenant_authority_audit WHERE tenant_id=$1 AND reason_code IN ('owner_account_disabled','owner_account_reactivated') ORDER BY occurred_at, event_id`, [tenant.tenant_id])).rows.map(row => row.reason_code);
  assert.deepEqual(reasons, ['owner_account_disabled', 'owner_account_reactivated']);
});

test('T-014 an approved case blocks reactivation, and execute then refuses the loginable owner', async () => {
  const owner = await person('擁有者');
  const recipient = await person('接收者');
  const tenant = await createTenant(owner.session);
  const to = await candidate(owner.session, recipient.id);
  assert.equal((await disable(owner.id)).status, 200);
  const opened = await open(admins.opener, tenant.tenant_id, to);
  assert.equal(opened.status, 201, opened.text);
  const approved = await approve(admins.reviewer, opened.data.case_id, '1');
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.data.version, '2');
  const verificationId = await verify(recipient.session, tenant.tenant_id, 'tenant.recovery.accept');
  const accepted = await send(`/me/tenant-recovery-cases/${opened.data.case_id}/accept`, recipient.session, {
    accept_scope: true, fresh_auth_verification_id: verificationId,
  }, '"2"');
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal(accepted.data.version, '3');
  const restored = await enable(owner.id, '2');
  assert.equal(restored.status, 200, restored.text);
  assert.equal(await tenantStatus(tenant.tenant_id), 'recovery_required');
  assert.equal((await pool.query<{ active: boolean }>(`SELECT active FROM users WHERE user_id=$1`, [owner.id])).rows[0].active, true);
  const executed = await admin(admins.executor, `/tenant-recovery-cases/${opened.data.case_id}/execute`, {}, '3');
  assert.equal(executed.status, 409, executed.text);
  assert.equal(executed.data.code, 'recovery_not_required');
  assert.equal((await pool.query<{ state: string }>(`SELECT state FROM tenant_recovery_cases WHERE case_id=$1`, [opened.data.case_id])).rows[0].state, 'approved');
});

test('T-014 recovery completes only after a separate open, approval, acceptance and execute', async () => {
  const owner = await person('擁有者');
  const recipient = await person('接收者');
  const tenant = await createTenant(owner.session);
  const to = await candidate(owner.session, recipient.id);
  assert.equal((await disable(owner.id)).status, 200);
  const opened = await open(admins.opener, tenant.tenant_id, to);
  assert.equal(opened.status, 201, opened.text);
  assert.equal(opened.data.state, 'evidence_required');
  assert.equal(opened.data.version, '1');
  assert.equal(opened.etag, '"1"');
  assert.match(opened.cacheControl ?? '', /private/);
  assert.match(opened.cacheControl ?? '', /no-store/);
  const duplicate = await open(admins.opener, tenant.tenant_id, to);
  assert.equal(duplicate.status, 409, duplicate.text);
  assert.equal(duplicate.data.code, 'recovery_case_pending');
  const caseId = opened.data.case_id;
  const approved = await approve(admins.reviewer, caseId, '1');
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.data.version, '2');
  assert.equal((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM tenant_memberships WHERE tenant_id=$1 AND principal_id=$2`, [tenant.tenant_id, to])).rows[0].n, 0);
  const verificationId = await verify(recipient.session, tenant.tenant_id, 'tenant.recovery.accept');
  const accepted = await send(`/me/tenant-recovery-cases/${caseId}/accept`, recipient.session, {
    accept_scope: true, fresh_auth_verification_id: verificationId,
  }, '"2"');
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal(accepted.data.version, '3');
  assert.equal(accepted.data.recipient_accepted, true);
  assert.equal((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM tenant_memberships WHERE tenant_id=$1 AND principal_id=$2`, [tenant.tenant_id, to])).rows[0].n, 0);
  const listed = await send('/me/tenant-recovery-cases', recipient.session);
  assert.equal(listed.status, 200, listed.text);
  assert.equal(listed.data.source_version, '1');
  assert.equal(Object.hasOwn(listed.data.items?.[0] ?? {}, 'evidence_ref'), false);
  const visible = await admin(admins.reviewer, `/tenant-recovery-cases/${caseId}`);
  assert.equal(visible.status, 200, visible.text);
  assert.equal(typeof visible.data.evidence_ref, 'string');
  const executed = await admin(admins.executor, `/tenant-recovery-cases/${caseId}/execute`, {}, '3');
  assert.equal(executed.status, 200, executed.text);
  assert.equal(executed.data.case?.state, 'executed');
  assert.equal(executed.data.case?.version, '4');
  assert.equal(await tenantStatus(tenant.tenant_id), 'active');
  const owners = (await pool.query<{ role: string; status: string; active: boolean; principal_id: string }>(`SELECT m.role, m.status, u.active, m.principal_id
    FROM tenant_memberships m JOIN principals p ON p.principal_id=m.principal_id JOIN users u ON u.user_id=p.user_ref
    WHERE m.tenant_id=$1 AND m.role='owner'`, [tenant.tenant_id])).rows;
  assert.equal(owners.length, 2);
  assert.equal(owners.find(row => row.principal_id === to)?.active, true);
  assert.equal(owners.find(row => row.principal_id === to)?.status, 'active');
  assert.equal(owners.find(row => row.principal_id !== to)?.active, false);
  assert.equal(owners.find(row => row.principal_id !== to)?.status, 'active');
  assert.equal((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM tenant_memberships m
    JOIN principals p ON p.principal_id=m.principal_id AND p.status='active'
    JOIN users u ON u.user_id=p.user_ref AND u.active
    WHERE m.tenant_id=$1 AND m.role='owner' AND m.status='active'`, [tenant.tenant_id])).rows[0].n, 1);
  const events = (await pool.query<{ event_type: string }>(`SELECT event_type FROM scoped_outbox`)).rows.map(row => row.event_type);
  assert.ok(events.includes('freedom.tenant.membership.changed.v1'));
  assert.ok(events.includes('freedom.tenant.recovery.required.v1'));
  assert.equal(events.includes('freedom.tenant.ownership.transferred.v1'), false);
  const closed = await admin(admins.reviewer, `/tenant-recovery-cases/${caseId}/close`, { decision: 'cancelled', reason: '復原已執行，不能再關閉' }, '4');
  assert.equal(closed.status, 409, closed.text);
  assert.equal(closed.data.code, 'recovery_case_terminal');
});

test('T-014 execute without the recipient acceptance stays approved', async () => {
  const owner = await person('擁有者');
  const recipient = await person('接收者');
  const tenant = await createTenant(owner.session);
  const to = await candidate(owner.session, recipient.id);
  assert.equal((await disable(owner.id)).status, 200);
  const opened = await open(admins.opener, tenant.tenant_id, to);
  const caseId = opened.data.case_id;
  assert.equal((await approve(admins.reviewer, caseId, '1')).status, 200);
  const executed = await admin(admins.executor, `/tenant-recovery-cases/${caseId}/execute`, {}, '2');
  assert.equal(executed.status, 409, executed.text);
  assert.equal(executed.data.code, 'recovery_acceptance_required');
  assert.equal((await pool.query<{ state: string }>(`SELECT state FROM tenant_recovery_cases WHERE case_id=$1`, [caseId])).rows[0].state, 'approved');
});

test('T-014 recovery authority requires a capability and three distinct people', async () => {
  const owner = await person('擁有者');
  const recipient = await person('接收者');
  const tenant = await createTenant(owner.session);
  const to = await candidate(owner.session, recipient.id);
  assert.equal((await disable(owner.id)).status, 200);
  const missing = await open(admins.bare, tenant.tenant_id, to);
  assert.equal(missing.status, 403, missing.text);
  assert.equal(missing.data.code, 'recovery_authority_required');
  const mirrorId = randomUUID();
  const mirrorEmail = `recovery-mirror-${mirrorId.slice(0, 8)}@example.test`;
  await pool.query(`UPDATE users SET email=$2 WHERE user_id=$1`, [recipient.id, mirrorEmail]);
  await pool.query(`INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)`, [mirrorId, DEMO_COMMUNITY, mirrorEmail, '同郵箱管理員']);
  await pool.query(`INSERT INTO platform_admin_tenant_recovery_capabilities(admin_id,capability) VALUES($1,'tenant.recovery.open')`, [mirrorId]);
  const mirrorJwt = await sign(mirrorEmail);
  const mirror: Admin = { id: mirrorId, email: mirrorEmail, jwt: mirrorJwt, csrf: (await verifier(new Request(origin, { headers: { 'Cf-Access-Jwt-Assertion': mirrorJwt } }))).csrfToken };
  const sameEmail = await open(mirror, tenant.tenant_id, to);
  assert.equal(sameEmail.status, 403, sameEmail.text);
  assert.equal(sameEmail.data.code, 'recovery_authority_required');
  const opened = await open(admins.opener, tenant.tenant_id, to);
  assert.equal(opened.status, 201, opened.text);
  const caseId = opened.data.case_id;
  const self = await approve(admins.opener, caseId, '1');
  assert.equal(self.status, 403, self.text);
  assert.equal(self.data.code, 'recovery_authority_required');
  assert.equal((await pool.query<{ state: string }>(`SELECT state FROM tenant_recovery_cases WHERE case_id=$1`, [caseId])).rows[0].state, 'evidence_required');
  const cleared = await admin(admins.reviewer, `/tenant-recovery-cases/${caseId}/close`, { decision: 'cancelled', reason: '改由其他人重新開啟' }, '1');
  assert.equal(cleared.status, 200, cleared.text);
  const again = await open(admins.opener, tenant.tenant_id, to);
  assert.equal(again.status, 201, again.text);
  const againId = again.data.case_id;
  assert.equal((await approve(admins.reviewer, againId, '1')).status, 200);
  const sameHands = await admin(admins.reviewer, `/tenant-recovery-cases/${againId}/execute`, {}, '2');
  assert.equal(sameHands.status, 403, sameHands.text);
  assert.equal(sameHands.data.code, 'recovery_authority_required');
  assert.equal((await admin(admins.reviewer, `/tenant-recovery-cases/${againId}/close`, { decision: 'cancelled', reason: '核准者收回這次核准' }, '2')).status, 200);
  const third = await open(admins.opener, tenant.tenant_id, to);
  const thirdId = third.data.case_id;
  assert.equal((await approve(admins.reviewer, thirdId, '1')).status, 200);
  const openerExecutes = await admin(admins.opener, `/tenant-recovery-cases/${thirdId}/execute`, {}, '2');
  assert.equal(openerExecutes.status, 403, openerExecutes.text);
  assert.equal(openerExecutes.data.code, 'recovery_authority_required');
  assert.equal((await pool.query<{ state: string }>(`SELECT state FROM tenant_recovery_cases WHERE case_id=$1`, [thirdId])).rows[0].state, 'approved');
});

test('T-014 an expired approval stays approved', async () => {
  const owner = await person('擁有者');
  const recipient = await person('接收者');
  const tenant = await createTenant(owner.session);
  const to = await candidate(owner.session, recipient.id);
  assert.equal((await disable(owner.id)).status, 200);
  const opened = await open(admins.opener, tenant.tenant_id, to);
  const caseId = opened.data.case_id;
  const expires = (await pool.query<{ expires: Date }>(`SELECT clock_timestamp() + interval '3 seconds' AS expires`)).rows[0].expires;
  const approved = await approve(admins.reviewer, caseId, '1', expires.toISOString());
  assert.equal(approved.status, 200, approved.text);
  const verificationId = await verify(recipient.session, tenant.tenant_id, 'tenant.recovery.accept');
  const accepted = await send(`/me/tenant-recovery-cases/${caseId}/accept`, recipient.session, {
    accept_scope: true, fresh_auth_verification_id: verificationId,
  }, `"${approved.data.version}"`);
  assert.equal(accepted.status, 200, accepted.text);
  await delay(4000);
  const executed = await admin(admins.executor, `/tenant-recovery-cases/${caseId}/execute`, {}, laterVersion(accepted));
  assert.equal(executed.status, 409, executed.text);
  assert.equal(executed.data.code, 'recovery_approval_expired');
  assert.equal((await pool.query<{ state: string }>(`SELECT state FROM tenant_recovery_cases WHERE case_id=$1`, [caseId])).rows[0].state, 'approved');
});

test('admin recovery routes stay hidden when the guild launchpad flag is off', async () => {
  const dark = createApp(pool, origin, 'local', { adminVerifier: verifier });
  const response = await dark.request(origin + '/admin/api/tenant-recovery-cases', {
    method: 'POST',
    headers: {
      Origin: origin, 'Cf-Access-Jwt-Assertion': admins.opener.jwt, 'X-Admin-CSRF': admins.opener.csrf,
      'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify({
      tenant_id: randomUUID(), proposed_owner_principal_id: randomUUID(), reason: '不該出現的復原', evidence_ref: randomUUID(),
    }),
  });
  const data = await response.json() as { code?: string };
  assert.equal(response.status, 404);
  assert.equal(data.code, 'not_found');
});

test('T-016 guild join, leave and intern to full leave tenant status and roles unchanged', async () => {
  const owner = await person('擁有者');
  const member = await person('公會成員');
  const tenant = await createTenant(owner.session);
  const before = (await pool.query<{ status: string; revision: string; members: unknown }>(`SELECT t.status, t.authorization_revision::text AS revision,
    (SELECT json_agg(json_build_object('principal_id', m.principal_id, 'role', m.role, 'status', m.status) ORDER BY m.principal_id)
      FROM tenant_memberships m WHERE m.tenant_id=t.tenant_id) AS members
    FROM tenants t WHERE t.tenant_id=$1`, [tenant.tenant_id])).rows[0];
  const joinedOwner = await send('/guilds/guild_marketing/join', owner.session, {});
  assert.equal(joinedOwner.status, 200, joinedOwner.text);
  await pool.query(`INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) VALUES($1,'guild_marketing',$2)
    ON CONFLICT (community_id,guild_key) DO UPDATE SET user_id=EXCLUDED.user_id`, [DEMO_COMMUNITY, owner.id]);
  const joined = await send('/guilds/guild_marketing/join', member.session, {});
  assert.equal(joined.status, 200, joined.text);
  const full = await send(`/guilds/guild_marketing/members/${member.id}/tier`, owner.session, { member_tier: 'full' }, `"${joined.data.aggregate_version}"`);
  assert.equal(full.status, 200, full.text);
  assert.equal(full.data.member_tier, 'full');
  const intern = await send(`/guilds/guild_marketing/members/${member.id}/tier`, owner.session, { member_tier: 'intern' }, `"${full.data.aggregate_version}"`);
  assert.equal(intern.status, 200, intern.text);
  assert.equal(intern.data.member_tier, 'intern');
  const left = await send('/guilds/guild_marketing/leave', member.session, {}, `"${intern.data.aggregate_version}"`);
  assert.equal(left.status, 200, left.text);
  const after = (await pool.query<{ status: string; revision: string; members: unknown }>(`SELECT t.status, t.authorization_revision::text AS revision,
    (SELECT json_agg(json_build_object('principal_id', m.principal_id, 'role', m.role, 'status', m.status) ORDER BY m.principal_id)
      FROM tenant_memberships m WHERE m.tenant_id=t.tenant_id) AS members
    FROM tenants t WHERE t.tenant_id=$1`, [tenant.tenant_id])).rows[0];
  assert.deepEqual(after, before);
});
