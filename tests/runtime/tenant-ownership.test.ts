import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_USERS, DEMO_PASSWORD } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';

const origin = 'http://127.0.0.1:4310';
const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_tenant_own_${process.pid}_${Date.now()}`;
const admin = createPool(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 12 });
const app = createApp(pool, origin, 'local', { guildLaunchpadEnabled: true });
type Session = { cookie: string; csrf: string; user: { user_id: string } };

before(async () => {
  assert.match(schema, /^fp_tenant_own_[0-9]+_[0-9]+$/);
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
});

async function request(path: string, session?: Session, body?: unknown, version?: string, key = randomUUID()) {
  const headers: Record<string, string> = { Origin: origin, ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}) };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['Idempotency-Key'] = key;
    if (version !== undefined) headers['If-Match'] = version;
  }
  const response = await app.request(origin + '/api/v1' + path, {
    method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() as any, response };
}
async function signIn(email: string): Promise<Session> {
  const r = await request('/auth/login', undefined, { email, password: DEMO_PASSWORD });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { cookie: r.response.headers.get('set-cookie')!.split(';')[0], csrf: r.data.csrf_token, user: r.data.user };
}
const soon = () => new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
async function create(owner: Session, display_name = '品牌甲') {
  const made = await request('/tenants', owner, { display_name, workspace_name: display_name + '櫃' });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  return made.data.tenant as { tenant_id: string; my_membership: { principal_id: string; version: string; role: string } };
}
async function candidate(actor: Session, userId: string) {
  const found = await request(`/tenants/invite-candidates?user_id=${userId}`, actor);
  assert.equal(found.status, 200, JSON.stringify(found.data));
  return found.data.principal_id as string;
}
async function invite(actor: Session, tenantId: string, principalId: string, role: 'admin' | 'operator' | 'viewer') {
  const made = await request(`/tenants/${tenantId}/invitations`, actor, {
    invitee_principal_id: principalId, role, instance_capabilities: [], expires_at: soon(),
  });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  return made.data as { invitation_id: string; version: string };
}
async function memberRow(actor: Session, tenantId: string, principalId: string) {
  const page = await request(`/tenants/${tenantId}/members?limit=100`, actor);
  assert.equal(page.status, 200, JSON.stringify(page.data));
  const row = page.data.items.find((item: { principal_id: string }) => item.principal_id === principalId);
  assert.ok(row, principalId);
  return row as { principal_id: string; version: string; role: string; status: string };
}
async function seedOwner(tenantId: string, userId: string, actor: Session) {
  const principalId = await candidate(actor, userId);
  await pool.query(`INSERT INTO tenant_memberships(tenant_id,principal_id,role,status,accepted_at)
    VALUES($1,$2,'owner','active',clock_timestamp())`, [tenantId, principalId]);
  return principalId;
}

test('the only active owner cannot leave, be demoted, or be revoked', async () => {
  const maker = await signIn(DEMO_USERS[0].email);
  const tenant = await create(maker);
  const leave = await request(`/tenants/${tenant.tenant_id}/leave`, maker, {}, `"${tenant.my_membership.version}"`);
  assert.equal(leave.status, 409);
  assert.equal(leave.data.code, 'last_owner_required');
  const row = await memberRow(maker, tenant.tenant_id, tenant.my_membership.principal_id);
  for (const body of [
    { role: 'viewer', status: 'active', instance_capabilities: [], reason: '調整成員角色' },
    { role: 'viewer', status: 'revoked', instance_capabilities: [], reason: '撤銷成員資格' },
  ]) {
    const denied = await request(`/tenants/${tenant.tenant_id}/members/${row.principal_id}/change`, maker, body, `"${row.version}"`);
    assert.equal(denied.status, 409, JSON.stringify(denied.data));
    assert.equal(denied.data.code, 'last_owner_required');
  }
  assert.equal((await request(`/tenants/${tenant.tenant_id}`, maker)).data.my_membership.role, 'owner');
});

test('a second owner exists only through stored membership; concurrent leaves keep exactly one', async () => {
  const maker = await signIn(DEMO_USERS[0].email);
  const reviewer = await signIn(DEMO_USERS[1].email);
  const tenant = await create(maker);
  assert.equal((await request(`/tenants/${tenant.tenant_id}/invitations`, maker, {
    invitee_principal_id: await candidate(maker, reviewer.user.user_id), role: 'owner', instance_capabilities: [], expires_at: soon(),
  })).status, 422);
  const second = await seedOwner(tenant.tenant_id, reviewer.user.user_id, maker);
  const makerRow = await memberRow(maker, tenant.tenant_id, tenant.my_membership.principal_id);
  const reviewerView = await request(`/tenants/${tenant.tenant_id}`, reviewer);
  assert.equal(reviewerView.data.my_membership.role, 'owner');
  const demote = await request(`/tenants/${tenant.tenant_id}/members/${second}/change`, maker, {
    role: 'viewer', status: 'active', instance_capabilities: [], reason: '調整成員角色',
  }, '"1"');
  assert.equal(demote.status, 403, JSON.stringify(demote.data));
  assert.equal(demote.data.code, 'tenant_capability_denied');
  const [leftA, leftB] = await Promise.all([
    request(`/tenants/${tenant.tenant_id}/leave`, maker, {}, `"${makerRow.version}"`),
    request(`/tenants/${tenant.tenant_id}/leave`, reviewer, {}, `"${reviewerView.data.my_membership.version}"`),
  ]);
  const outcomes = [leftA, leftB].map(item => item.status).sort();
  assert.deepEqual(outcomes, [200, 409], JSON.stringify([leftA.data, leftB.data]));
  assert.equal([leftA, leftB].find(item => item.status === 409)?.data.code, 'last_owner_required');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM tenant_memberships WHERE tenant_id=$1 AND role='owner' AND status='active'`, [tenant.tenant_id])).rows[0].n, 1);
});

test('direct SQL cannot leave an active tenant without an active owner', async () => {
  const maker = await signIn(DEMO_USERS[0].email);
  const tenant = await create(maker);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE tenant_memberships SET status='revoked', revoked_at=clock_timestamp(), updated_at=clock_timestamp() WHERE tenant_id=$1`, [tenant.tenant_id]);
    await assert.rejects(client.query('COMMIT'), (error: unknown) => {
      const pg = error as { code?: string; message?: string };
      return pg.code === '23514' && (pg.message ?? '').includes('active tenant requires an active owner');
    });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  assert.equal((await pool.query(`SELECT status FROM tenant_memberships WHERE tenant_id=$1`, [tenant.tenant_id])).rows[0].status, 'active');
});

test('two concurrent owner demotions cannot both commit', async () => {
  const maker = await signIn(DEMO_USERS[0].email);
  const reviewer = await signIn(DEMO_USERS[1].email);
  const tenant = await create(maker);
  const ownerA = tenant.my_membership.principal_id;
  const ownerB = await seedOwner(tenant.tenant_id, reviewer.user.user_id, maker);
  const client1 = await pool.connect();
  const client2 = await pool.connect();
  const demote = `UPDATE tenant_memberships SET role='viewer', updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2`;
  try {
    await client1.query('BEGIN');
    await client2.query('BEGIN');
    await client1.query(demote, [tenant.tenant_id, ownerA]);
    await client2.query(demote, [tenant.tenant_id, ownerB]);
    // Client 1 holds the same tenant row lock the deferred check takes, so
    // client 2's COMMIT waits inside the trigger until client 1 commits.
    await client1.query('SELECT status FROM tenants WHERE tenant_id=$1 FOR NO KEY UPDATE', [tenant.tenant_id]);
    const secondCommit = client2.query('COMMIT');
    await client1.query('COMMIT');
    await assert.rejects(secondCommit, (error: unknown) => {
      const pg = error as { code?: string; message?: string };
      return pg.code === '23514' && (pg.message ?? '').includes('active tenant requires an active owner');
    });
  } finally {
    await client1.query('ROLLBACK').catch(() => undefined);
    await client2.query('ROLLBACK').catch(() => undefined);
    client1.release();
    client2.release();
  }
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM tenant_memberships WHERE tenant_id=$1 AND role='owner' AND status='active'`, [tenant.tenant_id])).rows[0].n, 1);
});

test('only the invitee can accept; expiry is persisted without consulting If-Match', async () => {
  const maker = await signIn(DEMO_USERS[0].email);
  const reviewer = await signIn(DEMO_USERS[1].email);
  const client = await signIn(DEMO_USERS[2].email);
  const tenant = await create(maker);
  const invitation = await invite(maker, tenant.tenant_id, await candidate(maker, reviewer.user.user_id), 'viewer');
  const ownerAccept = await request(`/tenants/${tenant.tenant_id}/invitations/${invitation.invitation_id}/accept`, maker, {}, `"${invitation.version}"`);
  assert.equal(ownerAccept.status, 404);
  assert.equal(ownerAccept.data.code, 'invitation_not_found');
  await pool.query(`UPDATE tenant_invitations SET expires_at=clock_timestamp()-interval '1 minute' WHERE invitation_id=$1`, [invitation.invitation_id]);
  const stale = await request(`/tenants/${tenant.tenant_id}/invitations/${invitation.invitation_id}/accept`, reviewer, {}, '"9"');
  assert.equal(stale.status, 409, JSON.stringify(stale.data));
  assert.equal(stale.data.code, 'invitation_expired');
  assert.equal((await pool.query('SELECT state FROM tenant_invitations WHERE invitation_id=$1', [invitation.invitation_id])).rows[0].state, 'expired');
  const fresh = await invite(maker, tenant.tenant_id, await candidate(maker, client.user.user_id), 'viewer');
  const accepted = await request(`/tenants/${tenant.tenant_id}/invitations/${fresh.invitation_id}/accept`, client, {}, `"${fresh.version}"`);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
});

test('an admin cannot invite an admin, and a demoted inviter cannot complete the invitation', async () => {
  const maker = await signIn(DEMO_USERS[0].email);
  const adminMember = await signIn(DEMO_USERS[1].email);
  const guest = await signIn(DEMO_USERS[2].email);
  const tenant = await create(maker);
  const adminInvite = await invite(maker, tenant.tenant_id, await candidate(maker, adminMember.user.user_id), 'admin');
  assert.equal((await request(`/tenants/${tenant.tenant_id}/invitations/${adminInvite.invitation_id}/accept`, adminMember, {}, `"${adminInvite.version}"`)).status, 200);
  const tooHigh = await request(`/tenants/${tenant.tenant_id}/invitations`, adminMember, {
    invitee_principal_id: await candidate(adminMember, guest.user.user_id), role: 'admin', instance_capabilities: [], expires_at: soon(),
  });
  assert.equal(tooHigh.status, 403);
  assert.equal(tooHigh.data.code, 'tenant_capability_denied');
  const pending = await invite(adminMember, tenant.tenant_id, await candidate(adminMember, guest.user.user_id), 'viewer');
  const adminRow = await memberRow(maker, tenant.tenant_id, (await request(`/tenants/${tenant.tenant_id}`, adminMember)).data.my_membership.principal_id);
  const demoted = await request(`/tenants/${tenant.tenant_id}/members/${adminRow.principal_id}/change`, maker, {
    role: 'viewer', status: 'active', instance_capabilities: [], reason: '調整成員角色',
  }, `"${adminRow.version}"`);
  assert.equal(demoted.status, 200, JSON.stringify(demoted.data));
  const blocked = await request(`/tenants/${tenant.tenant_id}/invitations/${pending.invitation_id}/accept`, guest, {}, `"${pending.version}"`);
  assert.equal(blocked.status, 403, JSON.stringify(blocked.data));
  assert.equal(blocked.data.code, 'tenant_capability_denied');
  assert.equal((await pool.query('SELECT state FROM tenant_invitations WHERE invitation_id=$1', [pending.invitation_id])).rows[0].state, 'pending');
});

test('accept and revoke of one invitation produce exactly one success', async () => {
  const maker = await signIn(DEMO_USERS[0].email);
  const reviewer = await signIn(DEMO_USERS[1].email);
  const tenant = await create(maker);
  const invitation = await invite(maker, tenant.tenant_id, await candidate(maker, reviewer.user.user_id), 'viewer');
  const [accepted, revoked] = await Promise.all([
    request(`/tenants/${tenant.tenant_id}/invitations/${invitation.invitation_id}/accept`, reviewer, {}, `"${invitation.version}"`),
    request(`/tenants/${tenant.tenant_id}/invitations/${invitation.invitation_id}/revoke`, maker, { reason: '測試撤回邀請' }, `"${invitation.version}"`),
  ]);
  const statuses = [accepted.status, revoked.status].sort();
  assert.deepEqual(statuses, [200, 409], JSON.stringify([accepted.data, revoked.data]));
  assert.equal([accepted, revoked].find(item => item.status === 409)?.data.code, 'invitation_closed');
  const state = (await pool.query('SELECT state FROM tenant_invitations WHERE invitation_id=$1', [invitation.invitation_id])).rows[0].state as string;
  assert.ok(state === 'accepted' || state === 'revoked', state);
});
