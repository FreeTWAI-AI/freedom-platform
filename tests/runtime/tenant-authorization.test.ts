import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createPool, digest, LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_USERS, DEMO_PASSWORD, DEMO_COMMUNITY } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';

const origin = 'http://127.0.0.1:4310';
const databaseUrl = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const schema = `fp_tenant_auth_${process.pid}_${Date.now()}`;
const admin = createPool(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 12 });
const app = createApp(pool, origin, 'local', { guildLaunchpadEnabled: true });
const closed = createApp(pool, origin, 'local');
type Session = { cookie: string; csrf: string; user: { user_id: string; display_name: string; email: string } };

before(async () => {
  assert.match(schema, /^fp_tenant_auth_[0-9]+_[0-9]+$/);
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

async function request(path: string, session?: Session, body?: unknown, version?: string, key = randomUUID(), target = app) {
  const headers: Record<string, string> = { Origin: origin, ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}) };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['Idempotency-Key'] = key;
    if (version !== undefined) headers['If-Match'] = version;
  }
  const response = await target.request(origin + '/api/v1' + path, {
    method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() as any, response };
}
const sessionOf = (r: { response: Response; data: any }): Session => ({
  cookie: r.response.headers.get('set-cookie')!.split(';')[0], csrf: r.data.csrf_token, user: r.data.user,
});
async function signIn(email: string): Promise<Session> {
  const r = await request('/auth/login', undefined, { email, password: DEMO_PASSWORD });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return sessionOf(r);
}
async function person(name: string) {
  const id = randomUUID(), email = `tenant-${id}@example.test`;
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,active,onboarding_required)
    SELECT $1,$2,$3,$4,password_hash,$5,true,false FROM users WHERE email=$6`,
  [id, DEMO_COMMUNITY, email, name, randomUUID(), DEMO_USERS[0].email]);
  return { id, email, name, session: await signIn(email) };
}
const soon = () => new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
async function create(owner: Session, display_name: string, workspace_name?: string, key = randomUUID()) {
  const body: { display_name: string; workspace_name?: string } = { display_name };
  if (workspace_name) body.workspace_name = workspace_name;
  const made = await request('/tenants', owner, body, undefined, key);
  assert.equal(made.status, 201, JSON.stringify(made.data));
  return made;
}
async function candidate(actor: Session, userId: string) {
  const found = await request(`/tenants/invite-candidates?user_id=${userId}`, actor);
  assert.equal(found.status, 200, JSON.stringify(found.data));
  return found.data.principal_id as string;
}
async function invite(actor: Session, tenantId: string, principalId: string, role: 'admin' | 'operator' | 'viewer' = 'viewer', key = randomUUID()) {
  return request(`/tenants/${tenantId}/invitations`, actor, {
    invitee_principal_id: principalId, role, instance_capabilities: [], expires_at: soon(),
  }, undefined, key);
}
async function membership(actor: Session, tenantId: string, principalId: string) {
  const page = await request(`/tenants/${tenantId}/members?limit=100`, actor);
  assert.equal(page.status, 200, JSON.stringify(page.data));
  return page.data.items.find((item: { principal_id: string }) => item.principal_id === principalId);
}
async function blockedBy(pid: number) {
  for (let i = 0; i < 200; i++) {
    if ((await admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS yes', [pid])).rows[0].yes) return;
    await delay(20);
  }
  assert.fail('Expected the tenant row lock to block the viewer command.');
}

test('owner can create, list, read and edit a tenant; responses stay private', async () => {
  const maker = await signIn(DEMO_USERS[0].email);
  const made = await create(maker, '品牌甲', '櫃檯甲');
  assert.equal(made.data.tenant.display_name, '品牌甲');
  assert.equal(made.data.tenant.my_membership.role, 'owner');
  assert.equal(made.data.tenant.version, '1');
  assert.equal(made.data.workspace.name, '櫃檯甲');
  assert.equal(made.response.headers.get('cache-control'), 'private, no-store');
  assert.match(made.response.headers.get('vary') ?? '', /Cookie/);
  assert.equal(JSON.stringify(made.data).includes('@'), false);
  const listed = await request('/tenants?limit=20', maker);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.data.items.map((item: { tenant_id: string }) => item.tenant_id), [made.data.tenant.tenant_id]);
  const read = await request(`/tenants/${made.data.tenant.tenant_id}`, maker);
  assert.equal(read.status, 200);
  assert.equal(read.data.default_workspace_id, made.data.workspace.workspace_id);
  assert.equal(read.response.headers.get('cache-control'), 'private, no-store');
  const edited = await request(`/tenants/${made.data.tenant.tenant_id}/edit`, maker, { display_name: '品牌甲改', public_slug: null }, '"1"');
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.equal(edited.data.display_name, '品牌甲改');
  assert.equal(edited.data.version, '2');
  assert.equal(edited.data.authorization_revision, '1');
});

test('a stranger gets the same not-found as a missing tenant; a viewer cannot write', async () => {
  const maker = await signIn(DEMO_USERS[0].email);
  const reviewer = await signIn(DEMO_USERS[1].email);
  const client = await signIn(DEMO_USERS[2].email);
  const brand = await create(maker, '品牌甲');
  const other = await create(reviewer, '品牌乙');
  const tenantA = brand.data.tenant.tenant_id as string;
  const tenantB = other.data.tenant.tenant_id as string;
  for (const path of [`/tenants/${tenantB}`, `/tenants/${tenantB}/members`, `/tenants/${tenantB}/workspaces`]) {
    const denied = await request(path, maker);
    assert.equal(denied.status, 404, path);
    assert.equal(denied.data.code, 'tenant_not_found');
  }
  assert.equal((await request(`/tenants/${tenantB}/edit`, maker, { display_name: '越權', public_slug: null }, '"1"')).data.code, 'tenant_not_found');
  const invited = await candidate(reviewer, maker.user.user_id);
  const invitation = await invite(reviewer, tenantB, invited, 'viewer');
  assert.equal(invitation.status, 201, JSON.stringify(invitation.data));
  const accepted = await request(`/tenants/${tenantB}/invitations/${invitation.data.invitation_id}/accept`, maker, {}, `"${invitation.data.version}"`);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  assert.equal((await request(`/tenants/${tenantB}`, maker)).data.my_membership.role, 'viewer');
  assert.equal((await request('/tenants', maker)).data.items.length, 2);
  for (const [path, body, version] of [
    [`/tenants/${tenantB}/edit`, { display_name: '越權', public_slug: null }, '"1"'],
    [`/tenants/${tenantB}/workspaces`, { name: '越權工作區' }, undefined],
    [`/tenants/${tenantB}/invitations`, { invitee_principal_id: (await candidate(maker, client.user.user_id)), role: 'viewer', instance_capabilities: [], expires_at: soon() }, undefined],
  ] as const) {
    const denied = await request(path, maker, body, version);
    assert.equal(denied.status, 403, path + JSON.stringify(denied.data));
    assert.equal(denied.data.code, 'tenant_capability_denied');
  }
  const stranger = await request(`/tenants/${tenantA}/invitations/${invitation.data.invitation_id}/accept`, client, {}, '"1"');
  assert.equal(stranger.status, 404);
  assert.equal(stranger.data.code, 'invitation_not_found');
  assert.equal((await request(`/tenants/${tenantA}/members/${maker.user.user_id}/change`, client, {
    role: 'viewer', status: 'revoked', instance_capabilities: [], reason: '越權調整成員',
  }, '"1"')).status, 404);
});

test('forged authority fields, bad queries and If-Match mistakes fail before a write', async () => {
  const maker = await signIn(DEMO_USERS[0].email);
  const made = await create(maker, '品牌甲');
  const id = made.data.tenant.tenant_id as string;
  for (const extra of [{ role: 'owner' }, { scope_id: randomUUID() }, { actor: { user_id: maker.user.user_id } }]) {
    const forged = await request('/tenants', maker, { display_name: '偽造', ...extra });
    assert.equal(forged.status, 422, JSON.stringify(forged.data));
    assert.equal(forged.data.code, 'validation_failed');
  }
  assert.equal((await request('/tenants?extra=1', maker)).status, 422);
  assert.equal((await request('/tenants?limit=20&limit=21', maker)).status, 422);
  assert.equal((await request(`/tenants/${id}?cursor=abc`, maker)).status, 422);
  assert.equal((await request(`/tenants/${id}/edit`, maker, { display_name: '品牌甲', public_slug: null })).status, 428);
  assert.equal((await request(`/tenants/${id}/edit`, maker, { display_name: '品牌甲', public_slug: null }, '1')).data.code, 'invalid_version');
  assert.equal((await request(`/tenants/${id}/edit`, maker, { display_name: '品牌甲', public_slug: null }, '"2"')).data.code, 'version_conflict');
  const unexpected = await request('/tenants', maker, { display_name: '不該帶版本' }, '"1"');
  assert.equal(unexpected.status, 400);
  assert.equal(unexpected.data.code, 'invalid_version');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM tenants')).rows[0].n, 1);
});

test('guild office and member tier do not grant tenant access; an intern can still create one', async () => {
  const maker = await signIn(DEMO_USERS[0].email);
  const client = await signIn(DEMO_USERS[2].email);
  const made = await create(maker, '品牌甲');
  const guild = (await pool.query<{ guild_key: string }>('SELECT guild_key FROM positioning_guild_catalog ORDER BY guild_key LIMIT 1')).rows[0].guild_key;
  await pool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier)
    VALUES($1,$2,$3,$4,'active','full')`, [randomUUID(), DEMO_COMMUNITY, client.user.user_id, guild]);
  await pool.query('INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) VALUES($1,$2,$3)', [DEMO_COMMUNITY, guild, client.user.user_id]);
  const officer = await request(`/tenants/${made.data.tenant.tenant_id}`, client);
  assert.equal(officer.status, 404);
  assert.equal(officer.data.code, 'tenant_not_found');
  const intern = await person('實習夥伴');
  await pool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier)
    VALUES($1,$2,$3,$4,'active','intern')`, [randomUUID(), DEMO_COMMUNITY, intern.id, guild]);
  const created = await create(intern.session, '實習空間');
  assert.equal(created.data.tenant.my_membership.role, 'owner');
});

test('idempotent replay returns the original receipt; a changed body conflicts; revocation hides it', async () => {
  const maker = await signIn(DEMO_USERS[0].email);
  const reviewer = await signIn(DEMO_USERS[1].email);
  const key = randomUUID();
  const first = await create(maker, '品牌甲', '櫃檯甲', key);
  const replay = await create(maker, '品牌甲', '櫃檯甲', key);
  assert.deepEqual(replay.data, first.data);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM tenants')).rows[0].n, 1);
  const conflict = await request('/tenants', maker, { display_name: '另一個品牌', workspace_name: '櫃檯甲' }, undefined, key);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.code, 'idempotency_conflict');
  const principalId = await candidate(maker, reviewer.user.user_id);
  const invitation = await invite(maker, first.data.tenant.tenant_id, principalId, 'admin');
  const acceptKey = randomUUID();
  const accepted = await request(`/tenants/${first.data.tenant.tenant_id}/invitations/${invitation.data.invitation_id}/accept`, reviewer, {}, `"${invitation.data.version}"`, acceptKey);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  const spaceKey = randomUUID();
  const space = await request(`/tenants/${first.data.tenant.tenant_id}/workspaces`, reviewer, { name: '第二櫃' }, undefined, spaceKey);
  assert.equal(space.status, 201, JSON.stringify(space.data));
  const row = await membership(maker, first.data.tenant.tenant_id, accepted.data.membership.principal_id);
  const revoked = await request(`/tenants/${first.data.tenant.tenant_id}/members/${row.principal_id}/change`, maker, {
    role: 'admin', status: 'revoked', instance_capabilities: [], reason: '撤銷成員資格',
  }, `"${row.version}"`);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.data));
  const hiddenAccept = await request(`/tenants/${first.data.tenant.tenant_id}/invitations/${invitation.data.invitation_id}/accept`, reviewer, {}, `"${invitation.data.version}"`, acceptKey);
  assert.equal(hiddenAccept.status, 403);
  assert.equal(hiddenAccept.data.code, 'tenant_capability_denied');
  assert.equal(hiddenAccept.data.membership, undefined);
  const hiddenSpace = await request(`/tenants/${first.data.tenant.tenant_id}/workspaces`, reviewer, { name: '第二櫃' }, undefined, spaceKey);
  assert.equal(hiddenSpace.status, 404);
  assert.equal(hiddenSpace.data.code, 'tenant_not_found');
  assert.equal(hiddenSpace.data.workspace_id, undefined);
});

test('a revoked membership observed under the tenant lock rolls the command and receipt back', async () => {
  const maker = await signIn(DEMO_USERS[0].email);
  const reviewer = await signIn(DEMO_USERS[1].email);
  const made = await create(maker, '品牌甲');
  const tenantId = made.data.tenant.tenant_id as string;
  const principalId = await candidate(maker, reviewer.user.user_id);
  const invitation = await invite(maker, tenantId, principalId, 'viewer');
  assert.equal((await request(`/tenants/${tenantId}/invitations/${invitation.data.invitation_id}/accept`, reviewer, {}, `"${invitation.data.version}"`)).status, 200);
  const before = (await pool.query('SELECT count(*)::int AS n FROM scoped_command_receipts')).rows[0].n as number;
  const spaces = (await pool.query('SELECT count(*)::int AS n FROM workspaces')).rows[0].n as number;
  const blocker = await pool.connect();
  try {
    await blocker.query('BEGIN');
    const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    await blocker.query('SELECT tenant_id FROM tenants WHERE tenant_id=$1 FOR UPDATE', [tenantId]);
    const pending = request(`/tenants/${tenantId}/workspaces`, reviewer, { name: '不該建立' });
    await blockedBy(pid);
    await blocker.query(`UPDATE tenant_memberships SET status='revoked', revoked_at=clock_timestamp(), version=version+1, updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND principal_id=$2`, [tenantId, principalId]);
    await blocker.query('COMMIT');
    const denied = await pending;
    assert.equal(denied.status, 404, JSON.stringify(denied.data));
    assert.equal(denied.data.code, 'tenant_not_found');
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
  }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM scoped_command_receipts')).rows[0].n, before);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspaces')).rows[0].n, spaces);
});

test('create and workspace commands use separate digest profiles and scope kinds', async () => {
  const maker = await signIn(DEMO_USERS[0].email);
  const body = { display_name: '品牌甲', workspace_name: '櫃檯甲' };
  const made = await create(maker, body.display_name, body.workspace_name);
  const principalId = (await pool.query<{ principal_id: string }>('SELECT principal_id FROM principals WHERE user_ref=$1', [maker.user.user_id])).rows[0].principal_id;
  const personal = (await pool.query<{ scope_id: string }>('SELECT scope_id FROM resource_scopes WHERE owner_principal_id=$1 AND kind=$2', [principalId, 'personal'])).rows[0].scope_id;
  const createReceipt = (await pool.query<{ request_sha256: string; scope_kind: string }>(
    `SELECT request_sha256, scope_kind FROM scoped_command_receipts WHERE operation='tenant.create'`)).rows[0];
  assert.equal(createReceipt.scope_kind, 'personal');
  assert.equal(createReceipt.request_sha256, digest({
    profile: 'freedom.scoped-member-command/v1', scope: { scope_id: personal, kind: 'personal' },
    target: { kind: 'tenant_collection', id: principalId }, expected: null, body,
  }));
  const journals = (await pool.query<{ scope_kind: string; aggregate_type: string }>(
    `SELECT scope_kind, aggregate_type FROM scoped_transition_journal ORDER BY aggregate_type`)).rows;
  assert.deepEqual(journals.map(row => row.scope_kind), ['personal', 'personal']);
  assert.deepEqual(journals.map(row => row.aggregate_type), ['tenant', 'tenant_membership']);
  const events = (await pool.query<{ event_type: string; scope_kind: string }>(
    `SELECT event_type, scope_kind FROM scoped_outbox ORDER BY event_type`)).rows;
  assert.deepEqual(events.map(row => row.scope_kind), ['personal', 'personal']);
  assert.deepEqual(events.map(row => row.event_type), ['freedom.tenant.created.v1', 'freedom.tenant.membership.changed.v1']);
  const spaceBody = { name: '第二櫃' };
  const space = await request(`/tenants/${made.data.tenant.tenant_id}/workspaces`, maker, spaceBody);
  assert.equal(space.status, 201, JSON.stringify(space.data));
  const tenantScope = (await pool.query<{ scope_id: string }>('SELECT scope_id FROM resource_scopes WHERE tenant_ref=$1', [made.data.tenant.tenant_id])).rows[0].scope_id;
  const spaceReceipt = (await pool.query<{ request_sha256: string; scope_kind: string }>(
    `SELECT request_sha256, scope_kind FROM scoped_command_receipts WHERE operation='tenant.workspace.create'`)).rows[0];
  assert.equal(spaceReceipt.scope_kind, 'tenant');
  assert.equal(spaceReceipt.request_sha256, digest({
    profile: 'freedom.scoped-tenant-command/v1', scope: { scope_id: tenantScope, kind: 'tenant' },
    target: { kind: 'tenant_workspace_collection', id: made.data.tenant.tenant_id }, expected: null, body: spaceBody,
  }));
});

test('launchpad routes stay absent unless the flag is on, and tenant payloads do not leak across reads', async () => {
  const maker = await signIn(DEMO_USERS[0].email);
  const reviewer = await signIn(DEMO_USERS[1].email);
  const absent = await request('/tenants', maker, undefined, undefined, randomUUID(), closed);
  assert.equal(absent.status, 404);
  assert.equal(absent.data.code, 'not_found');
  const first = await create(maker, '品牌甲');
  const second = await create(reviewer, '品牌乙');
  const mine = await request('/tenants', maker);
  const theirs = await request(`/tenants/${second.data.tenant.tenant_id}`, reviewer);
  assert.equal(JSON.stringify(mine.data).includes(second.data.tenant.tenant_id), false);
  assert.equal(JSON.stringify(theirs.data).includes(first.data.tenant.tenant_id), false);
  const site = await request('/site');
  assert.equal(site.data.guild_launchpad_enabled, true);
});
