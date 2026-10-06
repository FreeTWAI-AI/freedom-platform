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
async function waiterPids(holderPid: number) {
  const rows = (await admin.query<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) ORDER BY pid', [holderPid])).rows;
  return rows.map(row => row.pid);
}
async function waiterPid(holderPid: number) {
  for (let i = 0; i < 200; i++) {
    const waiting = await waiterPids(holderPid);
    if (waiting.length > 0) return waiting[0];
    await delay(20);
  }
  assert.fail(`no backend waited on ${holderPid}`);
}
async function waitUntilSecondWaits(holderPid: number) {
  for (let i = 0; i < 200; i++) {
    const direct = await waiterPids(holderPid);
    if (direct.length >= 2) return;
    if (direct.length === 1 && (await waiterPids(direct[0])).length >= 1) return;
    await delay(20);
  }
  assert.fail('the second request never waited behind the held tenant lock');
}
async function authoritySnapshot(tenantId: string) {
  const memberships = (await pool.query(`SELECT principal_id,role,status,version::text AS version,(revoked_at IS NOT NULL) AS revoked
    FROM tenant_memberships WHERE tenant_id=$1 ORDER BY principal_id`, [tenantId])).rows;
  const revision = (await pool.query<{ revision: string }>(`SELECT authorization_revision::text AS revision FROM tenants WHERE tenant_id=$1`, [tenantId])).rows[0].revision;
  const audit = (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM tenant_authority_audit WHERE tenant_id=$1', [tenantId])).rows[0].n;
  const outbox = (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM scoped_outbox')).rows[0].n;
  const legacyOutbox = (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM outbox')).rows[0].n;
  return { memberships, revision, audit, outbox, legacyOutbox };
}
async function rowCounts() {
  const invitations = (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM tenant_invitations')).rows[0].n;
  const audit = (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM tenant_authority_audit')).rows[0].n;
  const outbox = (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM scoped_outbox')).rows[0].n;
  return { invitations, audit, outbox };
}
async function overlapTwoCreates(owner: Session, names: [string, string]) {
  const communityId = (await pool.query<{ community_id: string }>('SELECT community_id FROM users WHERE user_id=$1', [owner.user.user_id])).rows[0].community_id;
  const blocker = await pool.connect();
  const pending: Array<ReturnType<typeof request>> = [];
  try {
    await blocker.query('BEGIN');
    const holder = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await blocker.query('SELECT community_id FROM communities WHERE community_id=$1 FOR UPDATE', [communityId]);
    pending.push(request('/tenants', owner, { display_name: names[0], workspace_name: `${names[0]}櫃` }, undefined, randomUUID()));
    const firstPid = await waiterPid(holder);
    pending.push(request('/tenants', owner, { display_name: names[1], workspace_name: `${names[1]}櫃` }, undefined, randomUUID()));
    const secondPid = await waiterPid(firstPid);
    assert.notEqual(secondPid, holder);
    await blocker.query('ROLLBACK');
    return await Promise.all(pending);
  } finally {
    await blocker.query('ROLLBACK').catch(() => undefined);
    blocker.release();
    await Promise.allSettled(pending);
  }
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
  const blocker = await pool.connect();
  const pending: Array<ReturnType<typeof request>> = [];
  let leftA: Awaited<ReturnType<typeof request>> | undefined;
  let leftB: Awaited<ReturnType<typeof request>> | undefined;
  try {
    await blocker.query('BEGIN');
    const holder = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await blocker.query('SELECT tenant_id FROM tenants WHERE tenant_id=$1 FOR UPDATE', [tenant.tenant_id]);
    pending.push(
      request(`/tenants/${tenant.tenant_id}/leave`, maker, {}, `"${makerRow.version}"`),
      request(`/tenants/${tenant.tenant_id}/leave`, reviewer, {}, `"${reviewerView.data.my_membership.version}"`),
    );
    await waitUntilSecondWaits(holder);
    await blocker.query('ROLLBACK');
    [leftA, leftB] = await Promise.all(pending);
  } finally {
    await blocker.query('ROLLBACK').catch(() => undefined);
    blocker.release();
    await Promise.allSettled(pending);
  }
  const outcomes = [leftA!, leftB!].map(item => item.status).sort();
  assert.deepEqual(outcomes, [200, 409], JSON.stringify([leftA!.data, leftB!.data]));
  assert.equal([leftA!, leftB!].find(item => item.status === 409)?.data.code, 'last_owner_required');
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
  const blocker = await pool.connect();
  const pending: Array<ReturnType<typeof request>> = [];
  let accepted: Awaited<ReturnType<typeof request>> | undefined;
  let revoked: Awaited<ReturnType<typeof request>> | undefined;
  try {
    await blocker.query('BEGIN');
    const holder = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await blocker.query('SELECT tenant_id FROM tenants WHERE tenant_id=$1 FOR UPDATE', [tenant.tenant_id]);
    pending.push(
      request(`/tenants/${tenant.tenant_id}/invitations/${invitation.invitation_id}/accept`, reviewer, {}, `"${invitation.version}"`),
      request(`/tenants/${tenant.tenant_id}/invitations/${invitation.invitation_id}/revoke`, maker, { reason: '測試撤回邀請' }, `"${invitation.version}"`),
    );
    await waitUntilSecondWaits(holder);
    await blocker.query('ROLLBACK');
    [accepted, revoked] = await Promise.all(pending);
  } finally {
    await blocker.query('ROLLBACK').catch(() => undefined);
    blocker.release();
    await Promise.allSettled(pending);
  }
  const statuses = [accepted!.status, revoked!.status].sort();
  assert.deepEqual(statuses, [200, 409], JSON.stringify([accepted!.data, revoked!.data]));
  assert.equal([accepted!, revoked!].find(item => item.status === 409)?.data.code, 'invitation_closed');
  const state = (await pool.query('SELECT state FROM tenant_invitations WHERE invitation_id=$1', [invitation.invitation_id])).rows[0].state as string;
  assert.ok(state === 'accepted' || state === 'revoked', state);
});

test('member.change cannot reactivate a revoked membership', async () => {
  const maker = await signIn(DEMO_USERS[0].email);
  const reviewer = await signIn(DEMO_USERS[1].email);
  const tenant = await create(maker);
  const principalId = await candidate(maker, reviewer.user.user_id);
  const invitation = await invite(maker, tenant.tenant_id, principalId, 'viewer');
  assert.equal((await request(`/tenants/${tenant.tenant_id}/invitations/${invitation.invitation_id}/accept`, reviewer, {}, `"${invitation.version}"`)).status, 200);
  const row = await memberRow(maker, tenant.tenant_id, principalId);
  const revoked = await request(`/tenants/${tenant.tenant_id}/members/${principalId}/change`, maker, {
    role: 'viewer', status: 'revoked', instance_capabilities: [], reason: '撤銷成員資格',
  }, `"${row.version}"`);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.data));
  const before = await authoritySnapshot(tenant.tenant_id);
  const again = await request(`/tenants/${tenant.tenant_id}/members/${principalId}/change`, maker, {
    role: 'viewer', status: 'active', instance_capabilities: [], reason: '調整成員角色',
  }, `"${revoked.data.version}"`);
  assert.equal(again.status, 409, JSON.stringify(again.data));
  assert.equal(again.data.code, 'member_not_active');
  assert.equal(again.data.detail, '這位夥伴已不在業務空間，需要重新邀請並由對方接受。');
  assert.deepEqual(await authoritySnapshot(tenant.tenant_id), before);

  const client = await signIn(DEMO_USERS[2].email);
  await seedOwner(tenant.tenant_id, client.user.user_id, maker);
  const makerRow = await memberRow(maker, tenant.tenant_id, tenant.my_membership.principal_id);
  assert.equal((await request(`/tenants/${tenant.tenant_id}/leave`, maker, {}, `"${makerRow.version}"`)).status, 200);
  const revokedOwner = await memberRow(client, tenant.tenant_id, tenant.my_membership.principal_id);
  assert.equal(revokedOwner.status, 'revoked');
  const restoreOwner = await request(`/tenants/${tenant.tenant_id}/members/${tenant.my_membership.principal_id}/change`, client, {
    role: 'viewer', status: 'active', instance_capabilities: [], reason: '調整成員角色',
  }, `"${revokedOwner.version}"`);
  assert.equal(restoreOwner.status, 409, JSON.stringify(restoreOwner.data));
  assert.equal(restoreOwner.data.code, 'member_not_active');
  assert.equal((await pool.query(`SELECT status FROM tenant_memberships WHERE tenant_id=$1 AND principal_id=$2`, [tenant.tenant_id, tenant.my_membership.principal_id])).rows[0].status, 'revoked');
});

test('only recovery_required may commit with zero active owners', async () => {
  const maker = await signIn(DEMO_USERS[0].email);
  const tenant = await create(maker);
  const principalId = tenant.my_membership.principal_id;
  async function insertWithoutOwner(status: string) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO tenants(community_id,display_name,status,created_by_principal_id) VALUES($1,'無擁有者',$2,$3)`, [DEMO_COMMUNITY, status, principalId]);
      await client.query('COMMIT');
      return 'committed' as const;
    } catch (error) {
      const pg = error as { code?: string };
      assert.equal(pg.code, '23514', JSON.stringify(error));
      return 'rejected' as const;
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }
  assert.equal(await insertWithoutOwner('suspended'), 'rejected');
  assert.equal(await insertWithoutOwner('archived'), 'rejected');
  assert.equal(await insertWithoutOwner('recovery_required'), 'committed');
  const recovered = (await pool.query<{ tenant_id: string }>(`SELECT tenant_id FROM tenants WHERE status='recovery_required' AND display_name='無擁有者'`)).rows[0].tenant_id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE tenants SET status='active' WHERE tenant_id=$1`, [recovered]);
    await assert.rejects(client.query('COMMIT'), (error: unknown) => (error as { code?: string }).code === '23514');
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
  assert.equal((await pool.query('SELECT status FROM tenants WHERE tenant_id=$1', [recovered])).rows[0].status, 'recovery_required');
});

test('same-person creates serialise under the advisory lock and the sixth hits the quota', async () => {
  const maker = await signIn(DEMO_USERS[0].email);
  const [first, second] = await overlapTwoCreates(maker, ['品牌並一', '品牌並二']);
  assert.deepEqual([first.status, second.status].sort(), [201, 201], JSON.stringify([first.data, second.data]));
  assert.notEqual(first.data.tenant.tenant_id, second.data.tenant.tenant_id);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM tenants WHERE status='active'`)).rows[0].n, 2);
  for (const name of ['品牌額一', '品牌額二']) await create(maker, name);
  const [allowed, denied] = await overlapTwoCreates(maker, ['品牌額三', '品牌額四']);
  const statuses = [allowed.status, denied.status].sort();
  assert.deepEqual(statuses, [201, 429], JSON.stringify([allowed.data, denied.data]));
  assert.equal([allowed, denied].find(item => item.status === 429)?.data.code, 'quota_exceeded');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM tenants WHERE status='active'`)).rows[0].n, 5);
  const principalId = (await pool.query<{ principal_id: string }>('SELECT principal_id FROM principals WHERE user_ref=$1', [maker.user.user_id])).rows[0].principal_id;
  assert.equal((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM tenant_memberships m JOIN tenants t ON t.tenant_id=m.tenant_id
    WHERE m.principal_id=$1 AND m.status='active' AND t.status='active'`, [principalId])).rows[0].n, 5);
});

test('an invitation past seven days or past twenty pending rows is rejected without new rows', async () => {
  const maker = await signIn(DEMO_USERS[0].email);
  const reviewer = await signIn(DEMO_USERS[1].email);
  const tenant = await create(maker);
  const invitee = await candidate(maker, reviewer.user.user_id);
  const beforeWindow = await rowCounts();
  const tooLate = await request(`/tenants/${tenant.tenant_id}/invitations`, maker, {
    invitee_principal_id: invitee, role: 'viewer', instance_capabilities: [],
    expires_at: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString(),
  });
  assert.equal(tooLate.status, 422, JSON.stringify(tooLate.data));
  assert.equal(tooLate.data.code, 'validation_failed');
  assert.equal(tooLate.data.detail, '邀請到期時間必須在 7 日以內。');
  assert.deepEqual(await rowCounts(), beforeWindow);

  const ownerId = tenant.my_membership.principal_id;
  for (let i = 0; i < 20; i++) {
    const userId = randomUUID();
    const label = `pending${String(i).padStart(2, '0')}${randomUUID().slice(0, 8)}`;
    await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
      VALUES($1,$2,$3,$4,'not-a-login-hash',$5)`, [userId, DEMO_COMMUNITY, `${label}@example.test`, `待邀${i}`, randomUUID()]);
    const principalId = (await pool.query<{ principal_id: string }>('INSERT INTO principals(user_ref) VALUES($1) RETURNING principal_id', [userId])).rows[0].principal_id;
    await pool.query(`INSERT INTO tenant_invitations(tenant_id,invitee_principal_id,role,expires_at,state,created_by_principal_id)
      VALUES($1,$2,'viewer',clock_timestamp()+interval '1 day','pending',$3)`, [tenant.tenant_id, principalId, ownerId]);
  }
  const extraUser = randomUUID();
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'第二十一位','not-a-login-hash',$4)`, [extraUser, DEMO_COMMUNITY, `pending-extra-${randomUUID().slice(0, 8)}@example.test`, randomUUID()]);
  const extraPrincipal = (await pool.query<{ principal_id: string }>('INSERT INTO principals(user_ref) VALUES($1) RETURNING principal_id', [extraUser])).rows[0].principal_id;
  const beforeCap = await rowCounts();
  assert.equal(beforeCap.invitations, 20);
  const capped = await request(`/tenants/${tenant.tenant_id}/invitations`, maker, {
    invitee_principal_id: extraPrincipal, role: 'viewer', instance_capabilities: [], expires_at: soon(),
  });
  assert.equal(capped.status, 429, JSON.stringify(capped.data));
  assert.equal(capped.data.code, 'quota_exceeded');
  assert.equal(capped.data.detail, '待回覆的邀請已達上限。');
  assert.deepEqual(await rowCounts(), beforeCap);
});

test('inbox and tenant-list versions move after accept and after leave', async () => {
  const maker = await signIn(DEMO_USERS[0].email);
  const reviewer = await signIn(DEMO_USERS[1].email);
  const client = await signIn(DEMO_USERS[2].email);
  assert.equal((await request('/tenants?limit=20', maker)).data.source_version, '1');
  const tenant = await create(maker);
  const created = (await request('/tenants?limit=20', maker)).data.source_version as string;
  assert.notEqual(created, '1');
  const invitation = await invite(maker, tenant.tenant_id, await candidate(maker, reviewer.user.user_id), 'viewer');
  const beforeInbox = await request('/me/tenant-invitations?limit=20', reviewer);
  assert.equal(beforeInbox.status, 200, JSON.stringify(beforeInbox.data));
  assert.equal((await request(`/tenants/${tenant.tenant_id}/invitations/${invitation.invitation_id}/accept`, reviewer, {}, `"${invitation.version}"`)).status, 200);
  const afterInbox = await request('/me/tenant-invitations?limit=20', reviewer);
  assert.equal(afterInbox.status, 200, JSON.stringify(afterInbox.data));
  assert.notEqual(afterInbox.data.source_version, beforeInbox.data.source_version);
  await seedOwner(tenant.tenant_id, client.user.user_id, maker);
  const beforeLeave = (await request('/tenants?limit=20', maker)).data.source_version as string;
  const makerRow = await memberRow(maker, tenant.tenant_id, tenant.my_membership.principal_id);
  assert.equal((await request(`/tenants/${tenant.tenant_id}/leave`, maker, {}, `"${makerRow.version}"`)).status, 200);
  assert.notEqual((await request('/tenants?limit=20', maker)).data.source_version, beforeLeave);
});

test('revoking an invitation audits the invitee', async () => {
  const maker = await signIn(DEMO_USERS[0].email);
  const reviewer = await signIn(DEMO_USERS[1].email);
  const tenant = await create(maker);
  const invitee = await candidate(maker, reviewer.user.user_id);
  const invitation = await invite(maker, tenant.tenant_id, invitee, 'viewer');
  const revoked = await request(`/tenants/${tenant.tenant_id}/invitations/${invitation.invitation_id}/revoke`, maker, { reason: '測試撤回邀請' }, `"${invitation.version}"`);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.data));
  const target = (await pool.query<{ target_principal_id: string }>(`SELECT target_principal_id FROM tenant_authority_audit
    WHERE tenant_id=$1 AND action='tenant.invite.revoke'`, [tenant.tenant_id])).rows[0].target_principal_id;
  assert.equal(target, invitee);
  assert.notEqual(target, tenant.my_membership.principal_id);
});
