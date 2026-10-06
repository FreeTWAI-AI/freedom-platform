import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import { createPool } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_PASSWORD, DEMO_COMMUNITY, DEMO_USERS } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';

const origin = 'http://127.0.0.1:4310';
const databaseUrl = process.env.TEST_DATABASE_URL;
assert.ok(databaseUrl, 'TEST_DATABASE_URL is required');
assert.match(new URL(databaseUrl).pathname, /^\/fp_[a-z0-9_]+$/);
const schema = `fp_tenant_read_deadline_${process.pid}_${Date.now()}`;
const admin = createPool(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 12 });
const app = createApp(pool, origin, 'local', { guildLaunchpadEnabled: true });
type Session = { cookie: string; csrf: string; user: { user_id: string; display_name: string } };
type HttpResult = { status: number; data: Record<string, unknown> };

before(async () => {
  assert.match(schema, /^fp_tenant_read_deadline_[0-9]+_[0-9]+$/);
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

async function request(path: string, session?: Session, body?: unknown, key = randomUUID()): Promise<HttpResult> {
  const headers: Record<string, string> = { Origin: origin, ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}) };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['Idempotency-Key'] = key;
  }
  const response = await app.request(origin + '/api/v1' + path, {
    method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() as Record<string, unknown> };
}
async function signIn(email: string): Promise<Session> {
  const response = await app.request(origin + '/api/v1/auth/login', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ email, password: DEMO_PASSWORD }),
  });
  const data = await response.json() as { csrf_token?: string; user?: Session['user']; code?: string };
  assert.equal(response.status, 200, JSON.stringify(data));
  return { cookie: response.headers.get('set-cookie')!.split(';')[0], csrf: data.csrf_token!, user: data.user! };
}
async function person(name: string) {
  const id = randomUUID();
  const email = `tenant-read-${id}@example.test`;
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,active,onboarding_required)
    SELECT $1,$2,$3,$4,password_hash,$5,true,false FROM users WHERE email=$6`,
  [id, DEMO_COMMUNITY, email, name, randomUUID(), DEMO_USERS[0].email]);
  return { id, email, name, session: await signIn(email) };
}
async function createTenant(owner: Session, displayName: string, workspaceName: string) {
  const made = await request('/tenants', owner, { display_name: displayName, workspace_name: workspaceName });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const tenant = made.data.tenant as { tenant_id: string; display_name: string; my_membership: { principal_id: string } };
  const workspace = made.data.workspace as { workspace_id: string; name: string };
  return { tenant, workspace };
}
async function counts(tenantId: string) {
  return (await pool.query(`SELECT
    (SELECT count(*)::int FROM tenants) AS tenants,
    (SELECT count(*)::int FROM tenant_memberships) AS memberships,
    (SELECT count(*)::int FROM workspaces) AS workspaces,
    (SELECT count(*)::int FROM tenant_invitations) AS invitations,
    (SELECT count(*)::int FROM tenant_authority_audit) AS audit,
    (SELECT count(*)::int FROM scoped_command_receipts) AS receipts,
    (SELECT count(*)::int FROM scoped_transition_journal) AS journals,
    (SELECT count(*)::int FROM scoped_outbox) AS outbox,
    (SELECT version::text FROM tenants WHERE tenant_id=$1) AS version,
    (SELECT authorization_revision::text FROM tenants WHERE tenant_id=$1) AS authorization_revision,
    (SELECT count(*)::int FROM tenant_memberships WHERE tenant_id=$1 AND role='owner' AND status='active') AS owners`,
  [tenantId])).rows[0];
}
async function blockedQuery(pid: number, needle: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const row = (await admin.query<{ query: string }>(
      `SELECT query FROM pg_stat_activity
       WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'
       ORDER BY pid LIMIT 1`, [pid])).rows[0];
    if (row?.query.includes(needle)) return row.query;
    await delay(10);
  }
  assert.fail(`the private read never waited on ${needle}`);
}
async function untilExpired(deadline: Date) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const expired = (await admin.query<{ expired: boolean }>('SELECT clock_timestamp()>$1::timestamptz AS expired', [deadline])).rows[0].expired;
    if (expired) return;
    await delay(10);
  }
  assert.fail('the session deadline did not pass while the read waited');
}
function assertNoPrivate(result: HttpResult, secrets: string[]) {
  assert.equal(result.status, 401, JSON.stringify(result.data));
  assert.equal(result.data.code, 'session_expired');
  const body = JSON.stringify(result.data);
  for (const secret of secrets) assert.equal(body.includes(secret), false, secret);
  assert.equal(body.includes('display_name'), false);
  assert.equal(body.includes('workspace'), false);
  assert.equal(body.includes('principal_id'), false);
}

async function expireWhileWaiting(options: {
  session: Session;
  tenantId: string;
  path: string;
  secrets: string[];
  hold: (client: PoolClient) => Promise<unknown>;
  needle: string;
}) {
  const before = await counts(options.tenantId);
  const deadline = (await pool.query<{ expires_at: Date }>(
    `UPDATE sessions SET expires_at=clock_timestamp()+interval '2 seconds'
     WHERE user_id=$1 AND revoked_at IS NULL RETURNING expires_at`,
    [options.session.user.user_id])).rows[0].expires_at;
  const holder = await pool.connect();
  let pending: Promise<HttpResult> | undefined;
  try {
    await holder.query('BEGIN');
    const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await options.hold(holder);
    pending = request(options.path, options.session);
    const waiting = await blockedQuery(pid, options.needle);
    assert.match(waiting, new RegExp(options.needle));
    await untilExpired(deadline);
    await holder.query('ROLLBACK');
    const result = await pending;
    pending = undefined;
    assertNoPrivate(result, options.secrets);
    assert.deepEqual(await counts(options.tenantId), before);
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
    if (pending) await pending.catch(() => undefined);
  }
}

test('private GET tenant returns no payload when the session expires while the tenant row lock waits', async () => {
  const owner = await person('讀取期限甲');
  const made = await createTenant(owner.session, '期限空間甲', '期限櫃檯甲');
  await expireWhileWaiting({
    session: owner.session, tenantId: made.tenant.tenant_id, path: `/tenants/${made.tenant.tenant_id}`,
    secrets: [made.tenant.tenant_id, made.tenant.display_name, made.workspace.name, made.workspace.workspace_id, made.tenant.my_membership.principal_id],
    hold: client => client.query('SELECT tenant_id FROM tenants WHERE tenant_id=$1 FOR UPDATE', [made.tenant.tenant_id]),
    needle: 'FROM tenants',
  });
});

test('private GET workspaces returns no payload when the session expires while the tenant row lock waits', async () => {
  const owner = await person('讀取期限乙');
  const made = await createTenant(owner.session, '期限空間乙', '期限櫃檯乙');
  await expireWhileWaiting({
    session: owner.session, tenantId: made.tenant.tenant_id, path: `/tenants/${made.tenant.tenant_id}/workspaces?limit=20`,
    secrets: [made.tenant.tenant_id, made.workspace.name, made.workspace.workspace_id, '期限空間乙'],
    hold: client => client.query('SELECT tenant_id FROM tenants WHERE tenant_id=$1 FOR UPDATE', [made.tenant.tenant_id]),
    needle: 'FROM tenants',
  });
});

test('private GET members returns no payload when the session expires while the tenant row lock waits', async () => {
  const owner = await person('讀取期限丙');
  const made = await createTenant(owner.session, '期限空間丙', '期限櫃檯丙');
  await expireWhileWaiting({
    session: owner.session, tenantId: made.tenant.tenant_id, path: `/tenants/${made.tenant.tenant_id}/members?limit=20`,
    secrets: [made.tenant.tenant_id, owner.name, made.tenant.my_membership.principal_id, '期限空間丙'],
    hold: client => client.query('SELECT tenant_id FROM tenants WHERE tenant_id=$1 FOR UPDATE', [made.tenant.tenant_id]),
    needle: 'FROM tenants',
  });
});

test('private GET tenant list returns no payload when the session expires while the principal lock waits', async () => {
  const owner = await person('讀取期限丁');
  const made = await createTenant(owner.session, '期限空間丁', '期限櫃檯丁');
  await expireWhileWaiting({
    session: owner.session, tenantId: made.tenant.tenant_id, path: '/tenants?limit=20',
    secrets: [made.tenant.tenant_id, made.tenant.display_name, made.workspace.workspace_id, made.tenant.my_membership.principal_id],
    hold: client => client.query('SELECT principal_id FROM principals WHERE principal_id=$1 FOR UPDATE', [made.tenant.my_membership.principal_id]),
    needle: 'FROM principals',
  });
});

test('private GET invite candidate returns no payload when the session expires while the principal lock waits', async () => {
  const owner = await person('讀取期限戊');
  const guest = await person('候選期限戊');
  const made = await createTenant(owner.session, '期限空間戊', '期限櫃檯戊');
  const guestList = await request('/tenants?limit=1', guest.session);
  assert.equal(guestList.status, 200, JSON.stringify(guestList.data));
  const guestPrincipal = (await pool.query<{ principal_id: string }>('SELECT principal_id FROM principals WHERE user_ref=$1', [guest.id])).rows[0].principal_id;
  await expireWhileWaiting({
    session: owner.session, tenantId: made.tenant.tenant_id, path: `/tenants/invite-candidates?user_id=${guest.id}`,
    secrets: [guestPrincipal, guest.name, guest.id],
    hold: client => client.query('SELECT principal_id FROM principals WHERE principal_id=$1 FOR UPDATE', [guestPrincipal]),
    needle: 'FROM principals',
  });
});

test('private GET invitation inbox returns no payload when the session expires while its session lock waits', async () => {
  const owner = await person('讀取期限己');
  const guest = await person('受邀期限己');
  const made = await createTenant(owner.session, '期限空間己', '期限櫃檯己');
  const guestPrincipal = (await request(`/tenants/invite-candidates?user_id=${guest.id}`, owner.session)).data.principal_id;
  assert.equal(typeof guestPrincipal, 'string');
  const invitation = await request(`/tenants/${made.tenant.tenant_id}/invitations`, owner.session, {
    invitee_principal_id: guestPrincipal, role: 'viewer', instance_capabilities: [],
    expires_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
  });
  assert.equal(invitation.status, 201, JSON.stringify(invitation.data));
  await expireWhileWaiting({
    session: guest.session, tenantId: made.tenant.tenant_id, path: '/me/tenant-invitations?limit=20',
    secrets: [made.tenant.tenant_id, made.tenant.display_name, String(guestPrincipal)],
    hold: async client => {
      const hash = (await pool.query<{ token_hash: string }>('SELECT token_hash FROM sessions WHERE user_id=$1 AND revoked_at IS NULL', [guest.id])).rows[0].token_hash;
      await client.query('SELECT token_hash FROM sessions WHERE token_hash=$1 FOR UPDATE', [hash]);
    },
    needle: 'FROM sessions',
  });
});

test('the same private reads return their payload while the session is still current', async () => {
  const owner = await person('讀取期限成功');
  const guest = await person('讀取期限夥伴');
  const made = await createTenant(owner.session, '期限空間成功', '期限櫃檯成功');
  const holder = await pool.connect();
  let pending: Promise<HttpResult> | undefined;
  try {
    await holder.query('BEGIN');
    const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await holder.query('SELECT tenant_id FROM tenants WHERE tenant_id=$1 FOR UPDATE', [made.tenant.tenant_id]);
    pending = request(`/tenants/${made.tenant.tenant_id}`, owner.session);
    await blockedQuery(pid, 'FROM tenants');
    await holder.query('ROLLBACK');
    const read = await pending;
    pending = undefined;
    assert.equal(read.status, 200, JSON.stringify(read.data));
    assert.equal(read.data.display_name, '期限空間成功');
    assert.equal(read.data.default_workspace_id, made.workspace.workspace_id);
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
    if (pending) await pending.catch(() => undefined);
  }
  const spaces = await request(`/tenants/${made.tenant.tenant_id}/workspaces?limit=20`, owner.session);
  assert.equal(spaces.status, 200, JSON.stringify(spaces.data));
  assert.equal((spaces.data.items as { name: string }[])[0].name, '期限櫃檯成功');
  const members = await request(`/tenants/${made.tenant.tenant_id}/members?limit=20`, owner.session);
  assert.equal(members.status, 200, JSON.stringify(members.data));
  assert.equal((members.data.items as { display_name: string }[])[0].display_name, owner.name);
  const listed = await request('/tenants?limit=20', owner.session);
  assert.equal(listed.status, 200, JSON.stringify(listed.data));
  assert.equal((listed.data.items as { tenant_id: string }[])[0].tenant_id, made.tenant.tenant_id);
  const candidate = await request(`/tenants/invite-candidates?user_id=${guest.id}`, owner.session);
  assert.equal(candidate.status, 200, JSON.stringify(candidate.data));
  assert.equal(candidate.data.display_name, guest.name);
  const invited = await request(`/tenants/${made.tenant.tenant_id}/invitations`, owner.session, {
    invitee_principal_id: candidate.data.principal_id, role: 'viewer', instance_capabilities: [],
    expires_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
  });
  assert.equal(invited.status, 201, JSON.stringify(invited.data));
  const inbox = await request('/me/tenant-invitations?limit=20', guest.session);
  assert.equal(inbox.status, 200, JSON.stringify(inbox.data));
  assert.equal((inbox.data.items as { tenant_display_name: string }[])[0].tenant_display_name, '期限空間成功');
});
