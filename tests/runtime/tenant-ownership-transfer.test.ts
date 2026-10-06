import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createPool, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_USERS, DEMO_PASSWORD, DEMO_COMMUNITY } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';

const origin = 'http://127.0.0.1:4310';
const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_txf_${process.pid}_${Date.now()}`;
const admin = createPool(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 12 });
const app = createApp(pool, origin, 'local', { guildLaunchpadEnabled: true });
type Session = { cookie: string; csrf: string; user: { user_id: string } };
type Tenant = { tenant_id: string; authorization_revision: string; my_membership: { principal_id: string; version: string; role: string } };

before(async () => {
  assert.match(schema, /^fp_txf_[0-9]+_[0-9]+$/);
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

async function send(path: string, session: Session | undefined, body?: unknown, version?: string, key = randomUUID()) {
  const headers: Record<string, string> = { Origin: origin, ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}) };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['Idempotency-Key'] = key;
    if (version !== undefined) headers['If-Match'] = version;
  }
  const response = await app.request(origin + '/api/v1' + path, {
    method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : {}, text };
}
async function login(email: string): Promise<Session> {
  const headers: Record<string, string> = { Origin: origin, 'Content-Type': 'application/json' };
  const response = await app.request(origin + '/api/v1/auth/login', { method: 'POST', headers, body: JSON.stringify({ email, password: DEMO_PASSWORD }) });
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
const later = () => new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
async function createTenant(owner: Session, name = '品牌甲'): Promise<Tenant> {
  const made = await send('/tenants', owner, { display_name: name, workspace_name: name + '櫃' });
  assert.equal(made.status, 201, made.text);
  return made.data.tenant as Tenant;
}
async function candidate(actor: Session, userId: string) {
  const found = await send(`/tenants/invite-candidates?user_id=${userId}`, actor);
  assert.equal(found.status, 200, found.text);
  return found.data.principal_id as string;
}
async function verify(session: Session, tenantId: string, purpose: string) {
  const headers: Record<string, string> = { Origin: origin, Cookie: session.cookie, 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json' };
  const response = await app.request(origin + '/api/v1/me/high-risk-verifications', {
    method: 'POST', headers, body: JSON.stringify({ password: DEMO_PASSWORD, purpose, tenant_id: tenantId }),
  });
  const data = await response.json() as { verification_id?: string; code?: string };
  assert.equal(response.status, 201, JSON.stringify(data));
  return data.verification_id as string;
}
async function propose(owner: Session, tenantId: string, to: string, role = 'admin') {
  const verificationId = await verify(owner, tenantId, 'tenant.ownership.propose');
  const made = await send(`/tenants/${tenantId}/ownership-transfers`, owner, {
    to_principal_id: to, from_role_after: role, expires_at: later(), reason: '交給下一位擁有者', fresh_auth_verification_id: verificationId,
  });
  assert.equal(made.status, 201, made.text);
  return made.data as { transfer_id: string; version: string; state: string };
}
async function accept(session: Session, tenantId: string, transferId: string, version: string, key = randomUUID()) {
  const verificationId = await verify(session, tenantId, 'tenant.ownership.accept');
  return send(`/tenants/${tenantId}/ownership-transfers/${transferId}/accept`, session, {
    accept_scope: true, fresh_auth_verification_id: verificationId,
  }, version, key);
}
async function roles(tenantId: string) {
  const rows = (await pool.query<{ role: string; status: string; principal_id: string }>(
    `SELECT role, status, principal_id FROM tenant_memberships WHERE tenant_id=$1 ORDER BY principal_id`, [tenantId])).rows;
  return rows;
}
async function blockedBy(pid: number, count = 1) {
  for (let i = 0; i < 200; i++) {
    const waiting = (await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid])).rows[0].n;
    if (waiting >= count) return;
    await delay(20);
  }
  assert.fail(`expected ${count} waiter(s) on ${pid}`);
}
async function sessionHash(userId: string) {
  return (await pool.query<{ token_hash: string }>('SELECT token_hash FROM sessions WHERE user_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1', [userId])).rows[0].token_hash;
}

test('T-014 proposing a transfer changes nothing until the named recipient accepts', async () => {
  const owner = await person('擁有者');
  const recipient = await person('接收者');
  const stranger = await person('路人');
  const tenant = await createTenant(owner.session);
  const to = await candidate(owner.session, recipient.id);
  const before = await roles(tenant.tenant_id);
  const transfer = await propose(owner.session, tenant.tenant_id, to, 'admin');
  assert.equal(transfer.state, 'pending');
  assert.deepEqual(await roles(tenant.tenant_id), before);
  assert.equal((await pool.query<{ authorization_revision: string }>('SELECT authorization_revision::text AS authorization_revision FROM tenants WHERE tenant_id=$1', [tenant.tenant_id])).rows[0].authorization_revision, '1');
  const wrong = await send(`/tenants/${tenant.tenant_id}/ownership-transfers/${transfer.transfer_id}/accept`, stranger.session, {
    accept_scope: true, fresh_auth_verification_id: randomUUID(),
  }, `"${transfer.version}"`);
  assert.equal(wrong.status, 404, wrong.text);
  assert.equal(wrong.data.code, 'transfer_not_found');
  assert.deepEqual(await roles(tenant.tenant_id), before);
  const self = await send(`/tenants/${tenant.tenant_id}/ownership-transfers`, owner.session, {
    to_principal_id: tenant.my_membership.principal_id, from_role_after: 'admin', expires_at: later(), reason: '交給自己',
    fresh_auth_verification_id: await verify(owner.session, tenant.tenant_id, 'tenant.ownership.propose'),
  });
  assert.equal(self.status, 422, self.text);
  const duplicate = await send(`/tenants/${tenant.tenant_id}/ownership-transfers`, owner.session, {
    to_principal_id: to, from_role_after: 'viewer', expires_at: later(), reason: '再交一次',
    fresh_auth_verification_id: await verify(owner.session, tenant.tenant_id, 'tenant.ownership.propose'),
  });
  assert.equal(duplicate.status, 409, duplicate.text);
  assert.equal(duplicate.data.code, 'transfer_pending');
});

test('T-014 expiry, demotion and an authority bump invalidate the transfer before acceptance', async () => {
  const owner = await person('擁有者');
  const recipient = await person('接收者');
  const tenant = await createTenant(owner.session);
  const to = await candidate(owner.session, recipient.id);
  const expired = (await pool.query<{ transfer_id: string; version: string }>(`INSERT INTO tenant_ownership_transfers(
    tenant_id, from_principal_id, to_principal_id, from_role_after, state, expires_at, tenant_authorization_revision, reason)
    VALUES ($1,$2,$3,'admin','pending',clock_timestamp()-interval '1 minute',1,'已過期的移交')
    RETURNING transfer_id, version::text AS version`, [tenant.tenant_id, tenant.my_membership.principal_id, to])).rows[0];
  const stale = await accept(recipient.session, tenant.tenant_id, expired.transfer_id, `"${expired.version}"`);
  assert.equal(stale.status, 409, stale.text);
  assert.equal(stale.data.code, 'transfer_expired');
  assert.equal((await pool.query('SELECT state FROM tenant_ownership_transfers WHERE transfer_id=$1', [expired.transfer_id])).rows[0].state, 'expired');

  const demoted = await propose(owner.session, tenant.tenant_id, to);
  await pool.query(`INSERT INTO tenant_memberships(tenant_id,principal_id,role,status,accepted_at) VALUES($1,$2,'owner','active',clock_timestamp())`, [tenant.tenant_id, to]);
  await pool.query(`UPDATE tenant_memberships SET role='admin', version=version+1, updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2`, [tenant.tenant_id, tenant.my_membership.principal_id]);
  const denied = await accept(recipient.session, tenant.tenant_id, demoted.transfer_id, `"${demoted.version}"`);
  assert.equal(denied.status, 409, denied.text);
  assert.equal(denied.data.code, 'transfer_authority_changed');
  assert.equal((await pool.query('SELECT state FROM tenant_ownership_transfers WHERE transfer_id=$1', [demoted.transfer_id])).rows[0].state, 'invalidated');

  await pool.query(`UPDATE tenant_memberships SET role='owner', status='active', revoked_at=NULL, version=version+1 WHERE tenant_id=$1 AND principal_id=$2`, [tenant.tenant_id, tenant.my_membership.principal_id]);
  const bumped = await propose(owner.session, tenant.tenant_id, to);
  await pool.query(`UPDATE tenants SET authorization_revision=authorization_revision+1 WHERE tenant_id=$1`, [tenant.tenant_id]);
  const changed = await accept(recipient.session, tenant.tenant_id, bumped.transfer_id, `"${bumped.version}"`);
  assert.equal(changed.status, 409, changed.text);
  assert.equal(changed.data.code, 'transfer_authority_changed');
  assert.equal((await pool.query('SELECT state FROM tenant_ownership_transfers WHERE transfer_id=$1', [bumped.transfer_id])).rows[0].state, 'invalidated');
});

test('T-014 acceptance applies the recipient and the previous role atomically, a replay after revocation is denied, and a raw gap is rejected', async () => {
  const owner = await person('擁有者');
  const recipient = await person('接收者');
  const tenant = await createTenant(owner.session);
  const to = await candidate(owner.session, recipient.id);
  const transfer = await propose(owner.session, tenant.tenant_id, to, 'revoked');
  const acceptKey = randomUUID();
  const verificationId = await verify(recipient.session, tenant.tenant_id, 'tenant.ownership.accept');
  const accepted = await send(`/tenants/${tenant.tenant_id}/ownership-transfers/${transfer.transfer_id}/accept`, recipient.session, {
    accept_scope: true, fresh_auth_verification_id: verificationId,
  }, `"${transfer.version}"`, acceptKey);
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal(accepted.data.my_role, 'owner');
  assert.equal(accepted.data.transfer.state, 'accepted');
  const memberships = await roles(tenant.tenant_id);
  assert.equal(memberships.find(row => row.principal_id === to)?.role, 'owner');
  assert.equal(memberships.find(row => row.principal_id === to)?.status, 'active');
  const prior = memberships.find(row => row.principal_id === tenant.my_membership.principal_id);
  assert.equal(prior?.role, 'owner');
  assert.equal(prior?.status, 'revoked');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM tenant_memberships WHERE tenant_id=$1 AND role='owner' AND status='active'`, [tenant.tenant_id])).rows[0].n, 1);
  const events = (await pool.query<{ event_type: string }>(`SELECT event_type FROM scoped_outbox WHERE event_type LIKE 'freedom.tenant.%' ORDER BY event_type`)).rows.map(row => row.event_type);
  assert.ok(events.includes('freedom.tenant.ownership.transferred.v1'));
  assert.ok(events.includes('freedom.tenant.membership.changed.v1'));
  await pool.query(`UPDATE tenant_memberships SET status='active', revoked_at=NULL, role='owner', version=version+1, updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2`, [tenant.tenant_id, tenant.my_membership.principal_id]);
  await pool.query(`UPDATE tenant_memberships SET status='revoked', revoked_at=clock_timestamp(), version=version+1, updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2`, [tenant.tenant_id, to]);
  const replay = await send(`/tenants/${tenant.tenant_id}/ownership-transfers/${transfer.transfer_id}/accept`, recipient.session, {
    accept_scope: true, fresh_auth_verification_id: verificationId,
  }, `"${transfer.version}"`, acceptKey);
  assert.equal(replay.status, 403, replay.text);
  assert.equal(replay.data.code, 'tenant_capability_denied');
  await pool.query(`UPDATE tenant_memberships SET status='active', revoked_at=NULL, role='owner', version=version+1, updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2`, [tenant.tenant_id, to]);
  await pool.query(`UPDATE tenant_memberships SET status='revoked', revoked_at=clock_timestamp(), version=version+1, updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2`, [tenant.tenant_id, tenant.my_membership.principal_id]);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE tenant_memberships SET status='revoked', revoked_at=clock_timestamp(), version=version+1, updated_at=clock_timestamp() WHERE tenant_id=$1 AND status='active'`, [tenant.tenant_id]);
    await assert.rejects(client.query('COMMIT'), (error: unknown) => (error as { code?: string; message?: string }).code === '23514' && ((error as { message?: string }).message ?? '').includes('active tenant requires an active owner'));
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM tenant_memberships WHERE tenant_id=$1 AND role='owner' AND status='active'`, [tenant.tenant_id])).rows[0].n, 1);
});

test('T-014 one of two racing accept and cancel calls wins', async () => {
  const owner = await person('擁有者');
  const recipient = await person('接收者');
  const tenant = await createTenant(owner.session);
  const to = await candidate(owner.session, recipient.id);
  const transfer = await propose(owner.session, tenant.tenant_id, to, 'admin');
  const acceptVerification = await verify(recipient.session, tenant.tenant_id, 'tenant.ownership.accept');
  const acceptKey = randomUUID();
  const holder = await pool.connect();
  try {
    await holder.query('BEGIN');
    const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await holder.query('SELECT tenant_id FROM tenants WHERE tenant_id=$1 FOR UPDATE', [tenant.tenant_id]);
    const pendingAccept = send(`/tenants/${tenant.tenant_id}/ownership-transfers/${transfer.transfer_id}/accept`, recipient.session, {
      accept_scope: true, fresh_auth_verification_id: acceptVerification,
    }, `"${transfer.version}"`, acceptKey);
    const pendingCancel = send(`/tenants/${tenant.tenant_id}/ownership-transfers/${transfer.transfer_id}/cancel`, owner.session, { reason: '取消這次擁有權移交' });
    await blockedBy(pid, 1);
    await delay(500);
    await holder.query('COMMIT');
    const [accepted, cancelled] = await Promise.race([
      Promise.all([pendingAccept, pendingCancel]),
      delay(20000).then(() => { throw new Error('accept and cancel did not finish'); }),
    ]);
    const outcomes = [accepted.status, cancelled.status].sort();
    assert.deepEqual(outcomes, [200, 409], JSON.stringify([accepted.data, cancelled.data]));
    assert.equal([accepted, cancelled].find(item => item.status === 409)?.data.code, 'transfer_closed');
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM tenant_memberships WHERE tenant_id=$1 AND role='owner' AND status='active'`, [tenant.tenant_id])).rows[0].n, 1);
});

test('T-049 session expiry while accept waits on the tenant lock or the receipt lock rolls the transfer back', async () => {
  const owner = await person('擁有者');
  const recipient = await person('接收者');
  await createTenant(recipient.session, '接收者自己的空間');
  const tenant = await createTenant(owner.session);
  const to = await candidate(owner.session, recipient.id);
  const transfer = await propose(owner.session, tenant.tenant_id, to, 'admin');
  const verificationId = await verify(recipient.session, tenant.tenant_id, 'tenant.ownership.accept');
  const hash = await sessionHash(recipient.id);
  await pool.query(`UPDATE sessions SET expires_at=clock_timestamp()+interval '5 seconds' WHERE token_hash=$1`, [hash]);
  const holder = await pool.connect();
  const receiptsBefore = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM scoped_command_receipts WHERE operation='tenant.ownership.accept'`)).rows[0].n;
  try {
    await holder.query('BEGIN');
    const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await holder.query('SELECT tenant_id FROM tenants WHERE tenant_id=$1 FOR UPDATE', [tenant.tenant_id]);
    const pending = send(`/tenants/${tenant.tenant_id}/ownership-transfers/${transfer.transfer_id}/accept`, recipient.session, {
      accept_scope: true, fresh_auth_verification_id: verificationId,
    }, `"${transfer.version}"`);
    await blockedBy(pid);
    let expired = false;
    for (let i = 0; i < 160; i++) {
      expired = (await pool.query<{ expired: boolean }>('SELECT expires_at<=clock_timestamp() AS expired FROM sessions WHERE token_hash=$1', [hash])).rows[0].expired;
      if (expired) break;
      await delay(50);
    }
    assert.equal(expired, true);
    await holder.query('COMMIT');
    const denied = await pending;
    assert.equal(denied.status, 401, denied.text);
    assert.equal(denied.data.code, 'session_expired');
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }
  assert.equal((await pool.query('SELECT state FROM tenant_ownership_transfers WHERE transfer_id=$1', [transfer.transfer_id])).rows[0].state, 'pending');
  assert.equal((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM scoped_command_receipts WHERE operation='tenant.ownership.accept'`)).rows[0].n, receiptsBefore);
  assert.equal((await roles(tenant.tenant_id)).some(row => row.principal_id === to), false);

  const again = await login(recipient.email);
  await pool.query(`UPDATE tenant_ownership_transfers SET state='cancelled', version=version+1, decided_at=clock_timestamp() WHERE transfer_id=$1 AND state='pending'`, [transfer.transfer_id]);
  const next = await propose(owner.session, tenant.tenant_id, to, 'admin');
  const scope = (await pool.query<{ scope_id: string; principal_id: string }>(`SELECT s.scope_id, p.principal_id FROM resource_scopes s
    JOIN principals p ON p.principal_id=s.owner_principal_id WHERE p.user_ref=$1 AND s.kind='personal'`, [recipient.id])).rows[0];
  const key = randomUUID();
  const lockKey = JSON.stringify(['freedom.scoped-member-command/v1', scope.principal_id, 'member_session', scope.scope_id, 'tenant.ownership.accept', key]);
  const fresh = await verify(again, tenant.tenant_id, 'tenant.ownership.accept');
  const nextHash = await sessionHash(recipient.id);
  await pool.query(`UPDATE sessions SET expires_at=clock_timestamp()+interval '5 seconds' WHERE token_hash=$1`, [nextHash]);
  const receiptLock = await pool.connect();
  try {
    await receiptLock.query('BEGIN');
    const pid = (await receiptLock.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await receiptLock.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [lockKey]);
    const pending = send(`/tenants/${tenant.tenant_id}/ownership-transfers/${next.transfer_id}/accept`, again, {
      accept_scope: true, fresh_auth_verification_id: fresh,
    }, `"${next.version}"`, key);
    await blockedBy(pid);
    let expired = false;
    for (let i = 0; i < 160; i++) {
      expired = (await pool.query<{ expired: boolean }>('SELECT expires_at<=clock_timestamp() AS expired FROM sessions WHERE token_hash=$1', [nextHash])).rows[0].expired;
      if (expired) break;
      await delay(50);
    }
    assert.equal(expired, true);
    await receiptLock.query('COMMIT');
    const denied = await pending;
    assert.equal(denied.status, 401, denied.text);
    assert.equal(denied.data.code, 'session_expired');
  } finally {
    await receiptLock.query('ROLLBACK');
    receiptLock.release();
  }
  assert.equal((await pool.query('SELECT state FROM tenant_ownership_transfers WHERE transfer_id=$1', [next.transfer_id])).rows[0].state, 'pending');
});

test('T-014 a guild leader and a platform admin gain no tenant access from a pending transfer', async () => {
  const owner = await person('擁有者');
  const recipient = await person('接收者');
  const leader = await person('會長');
  const tenant = await createTenant(owner.session);
  const transfer = await propose(owner.session, tenant.tenant_id, await candidate(owner.session, recipient.id));
  await pool.query('INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) VALUES($1,$2,$3)', [DEMO_COMMUNITY, 'guild_marketing', leader.id]);
  await pool.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)', [randomUUID(), DEMO_COMMUNITY, leader.email, 'Synthetic Admin']);
  const hidden = await send(`/tenants/${tenant.tenant_id}/ownership-transfers/${transfer.transfer_id}`, leader.session);
  assert.equal(hidden.status, 404, hidden.text);
  assert.equal(hidden.data.code, 'transfer_not_found');
  const tenantRead = await send(`/tenants/${tenant.tenant_id}`, leader.session);
  assert.equal(tenantRead.status, 404);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM tenant_memberships WHERE tenant_id=$1 AND principal_id=(SELECT principal_id FROM principals WHERE user_ref=$2)`, [tenant.tenant_id, leader.id])).rows[0].n, 0);
  await pool.query(`UPDATE tenant_authority_policies SET status='retired' WHERE status='active'`);
  const cancelled = await send(`/tenants/${tenant.tenant_id}/ownership-transfers/${transfer.transfer_id}/cancel`, owner.session, { reason: '政策缺席仍可取消' });
  assert.equal(cancelled.status, 200, cancelled.text);
  assert.equal(cancelled.data.state, 'cancelled');
});
