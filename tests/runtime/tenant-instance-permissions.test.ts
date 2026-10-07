import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { InstanceCapabilitiesInputSchema } from '../../contracts/guild-launchpad/v1/tenant.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { FakeObjectStore } from '../../packages/asset-storage/fake-store.js';
import { migrate } from '../../scripts/database.js';
import { DEMO_COMMUNITY, DEMO_PASSWORD, DEMO_USERS, seedLocal } from '../../packages/testing/seed.js';
import { bindPrincipalContext, isolatedTransaction } from '../../packages/resource-scopes/tenant-transaction.js';
import { lockTenantScope } from '../../packages/resource-scopes/index.js';
import { tenantWorkCapabilities } from '../../modules/opportunity-project-work/tenant-capabilities.js';
import { authenticate, type Actor } from '../../modules/identity-membership/service.js';
import { openRecoveryCase, approveRecoveryCase, executeRecoveryCase } from '../../modules/tenant-workspaces/recovery.js';
import { changeMemberStatus, type AdminActor, type AdminCommand } from '../../modules/platform-admin/service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !/^\/fp_[a-z0-9_]+$/.test(new URL(databaseUrl).pathname)) {
  throw new Error('Instance permissions require an explicit disposable fp_* TEST_DATABASE_URL.');
}
const origin = 'http://127.0.0.1:4354';
const stamp = `${process.pid}_${Date.now()}`;
const schema = `fp_pb2b_${stamp}`;
const runtimeRole = `pb2b_${stamp}`;
const admin = new Pool({ connectionString: databaseUrl, max: 2 });
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema} -c statement_timeout=20000`, max: 8 });
const store = new FakeObjectStore();
const app = createApp(pool, origin, 'local', { guildLaunchpadEnabled: true, tenantWorkAssetStore: store });
type Session = { cookie: string; csrf: string; userId: string };
type Reply = { status: number; data: any; response: Response; bytes: Uint8Array };
const ALL_WORK = ['work:archive', 'work:create', 'work:read', 'work:result.write', 'work:write'];
const WORK_BODY = { title: '合成工作', objective: '證明實例權限', progress: 'todo' };
const soon = () => new Date(Date.now() + 86400000).toISOString();

before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  await admin.query(`CREATE ROLE ${runtimeRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`);
  await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${runtimeRole}`);
  await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${runtimeRole}`);
  await pool.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${schema} TO ${runtimeRole}`);
  const template = await readFile(new URL('../../deploy/cloudflare/sql/20-runtime-grants.psql', import.meta.url), 'utf8');
  for (const marker of ['TENANT CAPACITY POLICY', 'TENANT AUTHORITY POLICY', 'MODULE REGISTRY DEFINITION']) {
    const sql = template.split(`-- BEGIN ${marker} GRANTS\n`)[1].split('\n\\gexec')[0]
      .replaceAll(":'runtime'", `'${runtimeRole}'`).replaceAll("n.nspname='public'", `n.nspname='${schema}'`);
    for (const row of (await pool.query(sql)).rows) await pool.query(Object.values(row)[0] as string);
  }
});
after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE; DROP ROLE ${runtimeRole}`);
  await admin.end();
});
beforeEach(async () => {
  await pool.query('TRUNCATE communities, login_attempts, auth_rate_limits CASCADE');
  await seedLocal(pool);
  await pool.query(`INSERT INTO tenant_authority_policies(revision,status,fresh_auth_ttl_seconds,transfer_ttl_seconds,recovery_approval_ttl_seconds,max_open_recovery_cases_per_tenant)
    SELECT 1,'active',600,86400,86400,1 WHERE NOT EXISTS (SELECT 1 FROM tenant_authority_policies WHERE status='active')`);
  await pool.query(`INSERT INTO tenant_capacity_policies(policy_id,revision,plan_ref,max_active_instances,max_instances_per_module,
    max_concurrent_provisions,max_work_items,max_retained_bytes,max_concurrent_jobs,status)
    SELECT $1,1,'synthetic-instance-permissions',20,10,4,1000,104857600,4,'active'
    WHERE NOT EXISTS (SELECT 1 FROM tenant_capacity_policies WHERE tenant_id IS NULL AND status='active')`, [randomUUID()]);
});
async function call(method: string, path: string, session?: Session, body?: unknown, headers: Record<string, string> = {}, target = app): Promise<Reply> {
  const sent: Record<string, string> = { Origin: origin, ...headers };
  if (session) { sent.Cookie = session.cookie; sent['X-CSRF-Token'] = session.csrf; }
  const binary = body instanceof Uint8Array;
  if (body !== undefined && !binary) sent['Content-Type'] = 'application/json';
  const response = await target.request(origin + '/api/v1' + path, {
    method, headers: sent, body: body === undefined ? undefined : binary ? new Uint8Array(body) : JSON.stringify(body),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const data = response.headers.get('content-type')?.includes('application/json') && bytes.byteLength
    ? JSON.parse(Buffer.from(bytes).toString()) : null;
  return { status: response.status, data, response, bytes };
}
const post = (path: string, session: Session | undefined, body: unknown, version?: string, key = randomUUID(), target = app) =>
  call('POST', path, session, body, { 'Idempotency-Key': key, ...(version ? { 'If-Match': `"${version}"` } : {}) }, target);
async function login(email = DEMO_USERS[0].email, target = app): Promise<Session> {
  const r = await post('/auth/login', undefined, { email, password: DEMO_PASSWORD }, undefined, randomUUID(), target);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { cookie: r.response.headers.get('set-cookie')!.split(';')[0], csrf: r.data.csrf_token, userId: r.data.user.user_id };
}
async function person(name: string, target = app) {
  const userId = randomUUID();
  const email = `pb2b-${userId}@example.test`;
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,active,onboarding_required)
    SELECT $1,$2,$3,$4,password_hash,$5,true,false FROM users WHERE email=$6`,
  [userId, DEMO_COMMUNITY, email, name, randomUUID(), DEMO_USERS[0].email]);
  const session = await login(email, target);
  const found = await call('GET', `/tenants/invite-candidates?user_id=${userId}`, session, undefined, {}, target);
  assert.equal(found.status, 200, JSON.stringify(found.data));
  return { session, principalId: found.data.principal_id as string };
}
async function openTenant(owner?: Session, target = app) {
  owner ??= await login(DEMO_USERS[0].email, target);
  const guild = 'guild_ai_field';
  await pool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier)
    VALUES($1,$2,$3,$4,'active','full') ON CONFLICT DO NOTHING`, [randomUUID(), DEMO_COMMUNITY, owner.userId, guild]);
  const made = await post('/tenants', owner, { display_name: '合成業務', workspace_name: '工作區甲' }, undefined, randomUUID(), target);
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const tenantId = made.data.tenant.tenant_id as string;
  const workspaceId = made.data.workspace.workspace_id as string;
  const enabled = await post(`/tenants/${tenantId}/workspaces/${workspaceId}/manual-work`, owner, { guild_key: guild }, undefined, randomUUID(), target);
  assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
  return { owner, tenantId, workspaceId, instanceId: enabled.data.instance_id as string, principalId: made.data.tenant.my_membership.principal_id as string, guild };
}
type Tenant = Awaited<ReturnType<typeof openTenant>>;
type Person = Awaited<ReturnType<typeof person>>;
type Grants = { instance_id: string; capabilities: string[] }[];
const grant = (t: Tenant, capabilities = ALL_WORK): Grants => [{ instance_id: t.instanceId, capabilities }];
async function invite(t: Tenant, member: Person, role = 'operator', grants: Grants = grant(t), manager = t.owner, target = app) {
  const r = await post(`/tenants/${t.tenantId}/invitations`, manager, {
    invitee_principal_id: member.principalId, role, instance_capabilities: grants, expires_at: soon(),
  }, undefined, randomUUID(), target);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r;
}
async function join(t: Tenant, member: Person, role = 'operator', grants: Grants = grant(t), manager = t.owner, target = app) {
  const invited = await invite(t, member, role, grants, manager, target);
  const r = await post(`/tenants/${t.tenantId}/invitations/${invited.data.invitation_id}/accept`, member.session, {}, invited.data.version, randomUUID(), target);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r;
}
async function change(t: Tenant, member: Person, grants: Grants, role = 'operator', status = 'active', manager = t.owner,
  version?: string, key = randomUUID(), target = app) {
  version ??= (await pool.query(`SELECT version::text FROM tenant_memberships WHERE tenant_id=$1 AND principal_id=$2`, [t.tenantId, member.principalId])).rows[0].version;
  return post(`/tenants/${t.tenantId}/members/${member.principalId}/change`, manager,
    { role, status, instance_capabilities: grants, reason: '調整合成權限' }, version, key, target);
}
async function grantRows(t: Tenant, member: Person) {
  return (await pool.query(`SELECT permission_id,instance_id,capabilities,status,version::text,granted_by_principal_id,revoked_at
    FROM tenant_module_permissions WHERE tenant_id=$1 AND principal_id=$2 ORDER BY instance_id`, [t.tenantId, member.principalId])).rows;
}
async function snapshot(t: Tenant) {
  return (await pool.query(`SELECT
    (SELECT to_jsonb(t) FROM tenants t WHERE tenant_id=$1) AS tenant,
    (SELECT jsonb_agg(to_jsonb(m) ORDER BY principal_id) FROM tenant_memberships m WHERE tenant_id=$1) AS memberships,
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY permission_id) FROM tenant_module_permissions p WHERE tenant_id=$1) AS grants,
    (SELECT jsonb_agg(to_jsonb(i) ORDER BY invitation_id) FROM tenant_invitations i WHERE tenant_id=$1) AS invitations,
    (SELECT count(*)::int FROM scoped_command_receipts) AS receipts,
    (SELECT count(*)::int FROM tenant_authority_audit WHERE tenant_id=$1) AS audit,
    (SELECT count(*)::int FROM scoped_transition_journal) AS journal,
    (SELECT count(*)::int FROM scoped_outbox) AS outbox`, [t.tenantId])).rows[0];
}
async function secondWorkspace(t: Tenant, enable = true) {
  const made = await post(`/tenants/${t.tenantId}/workspaces`, t.owner, { name: '工作區乙' });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const workspaceId = made.data.workspace_id as string;
  if (!enable) return { ...t, workspaceId };
  const enabled = await post(`/tenants/${t.tenantId}/workspaces/${workspaceId}/manual-work`, t.owner,
    { guild_key: t.guild, choice: { kind: 'create_new' } });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
  return { ...t, workspaceId, instanceId: enabled.data.instance_id as string };
}
async function createWork(t: Tenant, session = t.owner, key = randomUUID(), target = app) {
  const r = await post(`/tenants/${t.tenantId}/workspaces/${t.workspaceId}/works`, session, WORK_BODY, undefined, key, target);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return { reply: r, workId: r.data.resource_ref.resource_id as string, key };
}
const NOTE = new TextEncoder().encode('合成文字成果');
function prepareBody(version: string) {
  return { content_type: 'text/plain', byte_size: NOTE.byteLength, sha256: createHash('sha256').update(NOTE).digest('hex'),
    display_name: 'note.txt', expected_work_version: version };
}
async function resultFlow(t: Tenant, workId: string, session = t.owner, version = '1', target = app) {
  const prepareKey = randomUUID(), writeKey = randomUUID(), finalizeKey = randomUUID();
  const prepared = await post(`/tenants/${t.tenantId}/works/${workId}/results/uploads`, session, prepareBody(version), undefined, prepareKey, target);
  assert.equal(prepared.status, 201, JSON.stringify(prepared.data));
  const uploadId = prepared.data.resource_ref.resource_id as string;
  const base = `/tenants/${t.tenantId}/works/${workId}/results/uploads/${uploadId}`;
  const written = await call('PUT', base + '/content', session, NOTE,
    { 'Idempotency-Key': writeKey, 'If-Match': '"1"' }, target);
  assert.equal(written.status, 200, JSON.stringify(written.data));
  const finalized = await post(base + '/finalize', session, { expected_work_version: version }, written.data.version, finalizeKey, target);
  assert.equal(finalized.status, 200, JSON.stringify(finalized.data));
  return { uploadId, resultId: finalized.data.resource_ref.resource_id as string, prepareKey, writeKey, finalizeKey,
    inputVersion: version, uploadVersion: written.data.version as string };
}
async function actorOf(session: Session): Promise<Actor> {
  const token = decodeURIComponent(session.cookie.slice(session.cookie.indexOf('=') + 1));
  return authenticate(pool, token);
}
async function sqlReject(code: string, run: (q: PoolClient) => Promise<unknown>) {
  const q = await pool.connect();
  try { await q.query('BEGIN'); await assert.rejects(run(q), (error: { code?: string }) => error.code === code); }
  finally { await q.query('ROLLBACK'); q.release(); }
}

test('SQL ordinary grant CHECKs, composite FKs, grantor FK and partial uniqueness reject illegal rows', async () => {
  const a = await openTenant();
  const b = await openTenant(await login(DEMO_USERS[1].email));
  const base: Record<string, unknown> = {
    tenant_id: a.tenantId, principal_id: a.principalId, instance_id: a.instanceId, capabilities: ['work:read'],
    purpose: null, expires_at: null, status: 'active', version: '1', granted_by_principal_id: a.principalId, revoked_at: null,
  };
  async function insert(q: PoolClient | Pool, changes: Record<string, unknown> = {}) {
    const row = { ...base, ...changes };
    const columns = Object.keys(row);
    return q.query(`INSERT INTO tenant_module_permissions(${columns.join(',')}) VALUES(${columns.map((_, i) => `$${i + 1}`).join(',')}) RETURNING permission_id`, Object.values(row));
  }
  for (const changes of [
    { capabilities: [] }, { capabilities: [null] }, { capabilities: ['work:read', null] },
    { capabilities: Array.from({ length: 101 }, (_, i) => `key:${i}`) },
    ...['*', 'Work:read', 'work:read\n', 'bad,key', `a${'b'.repeat(160)}`, 'module.data.export', 'module.authority.transfer',
      'module.binding.manage', 'tenant.ownership.transfer', 'instance.manage'].map(key => ({ capabilities: [key] })),
    { purpose: 'export' }, { expires_at: soon() }, { status: 'unknown' }, { version: '0' },
    { status: 'revoked' }, { revoked_at: soon() },
  ]) await sqlReject('23514', q => insert(q, changes));
  for (const changes of [
    { instance_id: b.instanceId }, { instance_id: randomUUID() }, { principal_id: b.principalId },
    { principal_id: randomUUID() }, { tenant_id: randomUUID() }, { granted_by_principal_id: randomUUID() },
  ]) await sqlReject('23503', q => insert(q, changes));
  await insert(pool);
  await sqlReject('23505', q => insert(q));
  // The partial index retains the identity even when the ordinary row is revoked.
  await pool.query(`UPDATE tenant_module_permissions SET status='revoked',revoked_at=clock_timestamp(),version=version+1 WHERE tenant_id=$1`, [a.tenantId]);
  await sqlReject('23505', q => insert(q));
  const longest = `a${'b'.repeat(159)}`;
  await insert(pool, { tenant_id: b.tenantId, principal_id: b.principalId, instance_id: b.instanceId,
    capabilities: Array.from({ length: 100 }, () => longest), status: 'revoked', revoked_at: soon() });
});

test('invitation scopes are canonical, visible to invitees and materialized with inviter and one revision bump', async () => {
  const t = await openTenant();
  const operator = await person('操作人');
  const manager = await person('管理人');
  await join(t, manager, 'admin', []);
  const viewer = await person('讀者');
  const entries = grant(t, ['work:write', 'work:read']);
  const invited = await invite(t, operator, 'operator', entries);
  assert.deepEqual(invited.data.instance_capabilities, grant(t, ['work:read', 'work:write']));
  const inbox = await call('GET', '/me/tenant-invitations', operator.session);
  assert.deepEqual(inbox.data.items[0].instance_capabilities, invited.data.instance_capabilities);
  assert.equal(inbox.response.headers.get('cache-control'), 'private, no-store');
  const stored = (await pool.query('SELECT instance_capabilities FROM tenant_invitations WHERE invitation_id=$1', [invited.data.invitation_id])).rows[0];
  assert.deepEqual(stored.instance_capabilities, invited.data.instance_capabilities);
  const beforeRevision = (await call('GET', `/tenants/${t.tenantId}`, t.owner)).data.authorization_revision;
  const accepted = await post(`/tenants/${t.tenantId}/invitations/${invited.data.invitation_id}/accept`, operator.session, {}, invited.data.version);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  assert.deepEqual(accepted.data.membership.instance_capabilities, invited.data.instance_capabilities);
  const rows = await grantRows(t, operator);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, '1');
  assert.equal(rows[0].granted_by_principal_id, t.principalId);
  const mine = await call('GET', `/tenants/${t.tenantId}`, operator.session);
  assert.equal(BigInt(mine.data.authorization_revision), BigInt(beforeRevision) + 1n);
  assert.deepEqual(mine.data.capabilities, [
    { instance_id: null, keys: ['tenant.metadata.read', 'tenant.workspace.read'] },
    { instance_id: t.instanceId, keys: ['work:read', 'work:write'] },
  ]);
  const mineList = await call('GET', '/tenants', operator.session);
  assert.deepEqual(mineList.data.items[0].capabilities, mine.data.capabilities);
  const members = await call('GET', `/tenants/${t.tenantId}/members`, t.owner);
  assert.deepEqual(members.data.items.find((m: any) => m.principal_id === operator.principalId).instance_capabilities, invited.data.instance_capabilities);
  const v = await join(t, viewer, 'viewer', grant(t, ['work:read']), manager.session);
  assert.deepEqual(v.data.invitation.instance_capabilities, grant(t, ['work:read']));
  assert.equal((await grantRows(t, viewer))[0].granted_by_principal_id, manager.principalId);
  assert.deepEqual((await call('GET', `/tenants/${t.tenantId}`, manager.session)).data.capabilities,
    (await call('GET', `/tenants/${t.tenantId}`, t.owner)).data.capabilities);
});

test('invalid and ungrantable invitation scopes change nothing and conceal instance existence', async () => {
  const t = await openTenant();
  const other = await openTenant(await login(DEMO_USERS[1].email));
  const member = await person('受邀者');
  const cases = [
    { role: 'viewer', entries: grant(t, ['work:read', 'work:write']) },
    { role: 'admin', entries: grant(t, ['work:read']) },
    { role: 'operator', entries: grant(t, ['unregistered:read']) },
    { role: 'operator', entries: grant(t, ['module.data.export', 'work:read']) },
    { role: 'operator', entries: grant(t, ['work:write']) },
    { role: 'operator', entries: [{ instance_id: randomUUID(), capabilities: ['work:read'] }] },
    { role: 'operator', entries: grant(other, ['work:read']) },
  ];
  const before = await snapshot(t);
  let identical: Uint8Array | undefined;
  for (const c of cases) {
    const r = await post(`/tenants/${t.tenantId}/invitations`, t.owner, {
      invitee_principal_id: member.principalId, role: c.role, instance_capabilities: c.entries, expires_at: soon(),
    });
    assert.equal(r.status, 422, JSON.stringify(r.data));
    assert.equal(r.data.code, 'capability_not_grantable');
    identical ??= r.bytes;
    assert.deepEqual(r.bytes, identical);
    assert.deepEqual(await snapshot(t), before);
  }
  for (const entries of [
    [grant(t)[0], grant(t)[0]], grant(t, ['work:read', 'work:read']), grant(t, []),
    Array.from({ length: 21 }, () => ({ instance_id: randomUUID(), capabilities: ['work:read'] })),
    grant(t, Array.from({ length: 101 }, (_, i) => `a:${i}`)), grant(t, ['*']),
  ]) {
    const r = await post(`/tenants/${t.tenantId}/invitations`, t.owner, {
      invitee_principal_id: member.principalId, role: 'operator', instance_capabilities: entries, expires_at: soon(),
    });
    assert.equal(r.status, 422);
    assert.equal(r.data.code, 'validation_failed');
    assert.deepEqual(await snapshot(t), before);
  }
});

test('acceptance revalidates stored scope and stale invitation changes nothing', async () => {
  const t = await openTenant();
  const member = await person('受邀者');
  const invited = await invite(t, member, 'operator', grant(t, ['work:read']));
  await pool.query('UPDATE tenant_invitations SET instance_capabilities=$2::jsonb WHERE invitation_id=$1',
    [invited.data.invitation_id, JSON.stringify(grant(t, ['unregistered:read']))]);
  const before = await snapshot(t);
  const r = await post(`/tenants/${t.tenantId}/invitations/${invited.data.invitation_id}/accept`, member.session, {}, invited.data.version);
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(r.data.code, 'invitation_stale');
  assert.deepEqual(await snapshot(t), before);
});

test('member change replaces grants, preserves unchanged versions, reactivates identity and enforces actor rules and replay', async () => {
  const t = await openTenant();
  const member = await person('操作人');
  await join(t, member, 'operator', []);
  const manager = await person('管理人');
  await join(t, manager, 'admin', []);
  const viewer = await person('讀者');
  await join(t, viewer, 'viewer', grant(t, ['work:read']));
  const firstKey = randomUUID();
  const added = await change(t, member, grant(t, ['work:read']), 'operator', 'active', manager.session, '1', firstKey);
  assert.equal(added.status, 200, JSON.stringify(added.data));
  const initial = (await grantRows(t, member))[0];
  assert.equal(initial.version, '1');
  assert.equal(initial.granted_by_principal_id, manager.principalId);
  const replay = await change(t, member, grant(t, ['work:read']), 'operator', 'active', manager.session, '1', firstKey);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data, added.data);
  const conflict = await change(t, member, [], 'operator', 'active', manager.session, '1', firstKey);
  assert.equal(conflict.status, 409); assert.equal(conflict.data.code, 'idempotency_conflict');
  const stale = await change(t, member, [], 'operator', 'active', manager.session, '1');
  assert.equal(stale.status, 412); assert.equal(stale.data.code, 'version_conflict');
  const same = await change(t, member, grant(t, ['work:read']));
  assert.equal(same.status, 200); assert.equal((await grantRows(t, member))[0].version, '1');
  const changed = await change(t, member, grant(t, ['work:write', 'work:read']));
  assert.equal(changed.status, 200); assert.equal((await grantRows(t, member))[0].version, '2');
  const removed = await change(t, member, []);
  assert.equal(removed.status, 200); assert.deepEqual(removed.data.instance_capabilities, []);
  const revoked = (await grantRows(t, member))[0];
  assert.equal(revoked.status, 'revoked'); assert.equal(revoked.version, '3'); assert.ok(revoked.revoked_at);
  assert.equal((await change(t, member, grant(t, ['work:read']))).status, 200);
  const active = (await grantRows(t, member))[0];
  assert.equal(active.permission_id, initial.permission_id); assert.equal(active.version, '4'); assert.equal(active.status, 'active');
  assert.equal((await change(t, manager, [], 'admin', 'active', manager.session)).status, 403);
  assert.equal((await change(t, member, [], 'operator', 'active', member.session)).status, 403);
  assert.equal((await change(t, member, [], 'operator', 'active', viewer.session)).status, 403);
  const before = await snapshot(t);
  for (const [role, status, entries] of [
    ['admin', 'active', grant(t, ['work:read'])], ['operator', 'revoked', grant(t, ['work:read'])],
    ['viewer', 'active', grant(t, ['work:read', 'work:write'])],
  ] as const) {
    const r = await change(t, member, entries, role, status);
    assert.equal(r.status, 422); assert.equal(r.data.code, 'capability_not_grantable');
    assert.deepEqual(await snapshot(t), before);
  }
  assert.equal((await change(t, member, [], 'admin')).status, 200);
  assert.equal((await grantRows(t, member))[0].status, 'revoked');
  assert.equal((await change(t, member, grant(t, ['work:read']), 'operator')).status, 200);
  assert.equal((await change(t, member, [], 'operator', 'revoked')).status, 200);
  assert.equal((await grantRows(t, member))[0].status, 'revoked');
});

test('leave and ownership transfer revoke ordinary grants without resetting versions', async () => {
  const t = await openTenant();
  const member = await person('離開者');
  await join(t, member);
  const left = await post(`/tenants/${t.tenantId}/leave`, member.session, {}, '1');
  assert.equal(left.status, 200, JSON.stringify(left.data));
  assert.equal((await grantRows(t, member))[0].status, 'revoked');
  const rejoined = await join(t, member, 'operator', grant(t, ['work:read']));
  assert.equal(rejoined.data.membership.version, '3');
  assert.equal((await grantRows(t, member))[0].version, '3');
  const verification = await post('/me/high-risk-verifications', t.owner,
    { password: DEMO_PASSWORD, purpose: 'tenant.ownership.propose', tenant_id: t.tenantId });
  assert.equal(verification.status, 201, JSON.stringify(verification.data));
  const transfer = await post(`/tenants/${t.tenantId}/ownership-transfers`, t.owner, {
    to_principal_id: member.principalId, from_role_after: 'operator', expires_at: new Date(Date.now() + 3600000).toISOString(),
    reason: '交接合成業務', fresh_auth_verification_id: verification.data.verification_id,
  });
  assert.equal(transfer.status, 201, JSON.stringify(transfer.data));
  const fresh = await post('/me/high-risk-verifications', member.session,
    { password: DEMO_PASSWORD, purpose: 'tenant.ownership.accept', tenant_id: t.tenantId });
  assert.equal(fresh.status, 201, JSON.stringify(fresh.data));
  const accepted = await post(`/tenants/${t.tenantId}/ownership-transfers/${transfer.data.transfer_id}/accept`, member.session,
    { accept_scope: true, fresh_auth_verification_id: fresh.data.verification_id }, transfer.data.version);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  assert.equal((await grantRows(t, member))[0].status, 'revoked');
  assert.equal((await grantRows(t, member))[0].version, '4');
  const formerOwner = await call('GET', `/tenants/${t.tenantId}`, t.owner);
  assert.equal(formerOwner.data.my_membership.role, 'operator');
  assert.deepEqual(formerOwner.data.capabilities, [{ instance_id: null, keys: ['tenant.metadata.read', 'tenant.workspace.read'] }]);
});

test('multi-instance acceptance and replacement materialize exactly the canonical set', async () => {
  const t = await openTenant();
  const second = await secondWorkspace(t);
  const member = await person('操作人');
  const entries = [...grant(second, ['work:write', 'work:read']), ...grant(t, ['work:read'])].reverse();
  const accepted = await join(t, member, 'operator', entries);
  const canonical = entries.map(e => ({ ...e, capabilities: [...e.capabilities].sort() }))
    .sort((a, b) => a.instance_id.localeCompare(b.instance_id));
  assert.deepEqual(accepted.data.membership.instance_capabilities, canonical);
  const initial = await grantRows(t, member);
  assert.equal(initial.length, 2); assert.ok(initial.every(row => row.version === '1' && row.granted_by_principal_id === t.principalId));
  const changed = await change(t, member, grant(second, ['work:read', 'work:write']));
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  const rows = await grantRows(t, member);
  assert.equal(rows.find(row => row.instance_id === t.instanceId)!.status, 'revoked');
  assert.equal(rows.find(row => row.instance_id === t.instanceId)!.version, '2');
  assert.equal(rows.find(row => row.instance_id === second.instanceId)!.version, '1');
  // Acceptance after leave replaces a retained set, reactivating only the invited row.
  assert.equal((await post(`/tenants/${t.tenantId}/leave`, member.session, {}, changed.data.version)).status, 200);
  await join(t, member, 'operator', grant(t, ['work:read']));
  const final = await grantRows(t, member);
  assert.equal(final.find(row => row.instance_id === t.instanceId)!.permission_id, initial.find(row => row.instance_id === t.instanceId)!.permission_id);
  assert.equal(final.find(row => row.instance_id === t.instanceId)!.version, '3');
  assert.equal(final.find(row => row.instance_id === second.instanceId)!.status, 'revoked');
});

test('T-015 operator completes all ordinary Work and Result actions while viewer reads and every write stays denied', async () => {
  const t = await openTenant();
  const operator = await person('操作人');
  const viewer = await person('讀者');
  await join(t, operator);
  await join(t, viewer, 'viewer', grant(t, ['work:read']));
  const { workId } = await createWork(t, operator.session);
  const updated = await call('PATCH', `/tenants/${t.tenantId}/works/${workId}`, operator.session,
    { ...WORK_BODY, progress: 'in_progress' }, { 'Idempotency-Key': randomUUID(), 'If-Match': '"1"' });
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  const flow = await resultFlow(t, workId, operator.session, '2');
  const base = `/tenants/${t.tenantId}/works/${workId}`;
  for (const session of [operator.session, viewer.session]) {
    for (const path of [`/tenants/${t.tenantId}/workspaces/${t.workspaceId}/works`, base, base + '/results', base + `/results/${flow.resultId}`]) {
      const read = await call('GET', path, session);
      assert.equal(read.status, 200, JSON.stringify(read.data));
      assert.equal(read.response.headers.get('cache-control'), 'private, no-store');
    }
    const content = await call('GET', base + `/results/${flow.resultId}/content`, session);
    assert.equal(content.status, 200); assert.deepEqual(content.bytes, NOTE);
  }
  assert.equal((await call('GET', base + `/results/uploads/${flow.uploadId}`, operator.session)).status, 200);
  const writes = [
    () => post(`/tenants/${t.tenantId}/workspaces/${t.workspaceId}/works`, viewer.session, WORK_BODY),
    () => call('PATCH', base, viewer.session, WORK_BODY, { 'Idempotency-Key': randomUUID(), 'If-Match': '"3"' }),
    () => post(base + '/archive', viewer.session, {}, '3'),
    () => post(base + '/results/uploads', viewer.session, prepareBody('3')),
    () => call('PUT', base + `/results/uploads/${flow.uploadId}/content`, viewer.session, NOTE,
      { 'Idempotency-Key': randomUUID(), 'If-Match': '"2"' }),
    () => post(base + `/results/uploads/${flow.uploadId}/finalize`, viewer.session, { expected_work_version: '2' }, '2'),
    () => call('GET', base + `/results/uploads/${flow.uploadId}`, viewer.session),
  ];
  const before = await snapshot(t);
  for (const write of writes) {
    const denied = await write(); assert.equal(denied.status, 403, JSON.stringify(denied.data)); assert.equal(denied.data.code, 'capability_denied');
    assert.deepEqual(await snapshot(t), before);
  }
  const archived = await post(base + '/archive', operator.session, {}, '3');
  assert.equal(archived.status, 200, JSON.stringify(archived.data));
  assert.equal((await pool.query('SELECT state FROM work_items WHERE work_item_id=$1', [workId])).rows[0].state, 'archived');
});

test('unreadable instances return byte-identical random-id replies on all Work, Result and upload targets', async () => {
  const t = await openTenant();
  const hidden = await secondWorkspace(t);
  const operator = await person('操作人');
  await join(t, operator);
  const { workId } = await createWork(hidden);
  const flow = await resultFlow(hidden, workId);
  const prefix = `/tenants/${t.tenantId}`;
  const base = prefix + `/works/${workId}`;
  const unknown = prefix + `/works/${randomUUID()}`;
  const missingResultId = randomUUID();
  const upload = base + `/results/uploads/${flow.uploadId}`;
  const unknownUpload = base + `/results/uploads/${randomUUID()}`;
  const headers = () => ({ 'Idempotency-Key': randomUUID(), 'If-Match': '"2"' });
  const pairs: [() => Promise<Reply>, () => Promise<Reply>][] = [
    [() => call('GET', base, operator.session), () => call('GET', unknown, operator.session)],
    [() => call('PATCH', base, operator.session, WORK_BODY, headers()), () => call('PATCH', unknown, operator.session, WORK_BODY, headers())],
    [() => post(base + '/archive', operator.session, {}, '2'), () => post(unknown + '/archive', operator.session, {}, '2')],
    [() => post(base + '/results/uploads', operator.session, prepareBody('2')), () => post(unknown + '/results/uploads', operator.session, prepareBody('2'))],
    [() => call('GET', upload, operator.session), () => call('GET', unknownUpload, operator.session)],
    [() => call('PUT', upload + '/content', operator.session, NOTE, headers()), () => call('PUT', unknownUpload + '/content', operator.session, NOTE, headers())],
    [() => post(upload + '/finalize', operator.session, { expected_work_version: '1' }, '2'), () => post(unknownUpload + '/finalize', operator.session, { expected_work_version: '1' }, '2')],
    [() => call('GET', base + '/results', operator.session), () => call('GET', unknown + '/results', operator.session)],
    [() => call('GET', base + `/results/${flow.resultId}`, operator.session), () => call('GET', base + `/results/${randomUUID()}`, operator.session)],
    [() => call('GET', base + `/results/${flow.resultId}/content`, operator.session), () => call('GET', base + `/results/${randomUUID()}/content`, operator.session)],
    [() => call('GET', base + `/results/${flow.resultId}`, operator.session), () => call('GET', unknown + `/results/${flow.resultId}`, operator.session)],
    [() => call('GET', base + `/results/${flow.resultId}/content`, operator.session), () => call('GET', unknown + `/results/${flow.resultId}/content`, operator.session)],
    [() => call('GET', base + `/results/${missingResultId}`, operator.session), () => call('GET', unknown + `/results/${missingResultId}`, operator.session)],
    [() => call('GET', base + `/results/${missingResultId}/content`, operator.session), () => call('GET', unknown + `/results/${missingResultId}/content`, operator.session)],
  ];
  const before = await snapshot(t);
  for (const [actual, random] of pairs) {
    const r = await actual(), missing = await random();
    assert.equal(r.status, 404, JSON.stringify(r.data)); assert.equal(missing.status, 404);
    assert.deepEqual(r.bytes, missing.bytes);
    assert.equal(r.response.headers.get('cache-control'), 'private, no-store');
  }
  for (const request of [
    () => post(`${prefix}/workspaces/${hidden.workspaceId}/works`, operator.session, WORK_BODY),
    () => call('GET', `${prefix}/workspaces/${hidden.workspaceId}/works`, operator.session),
  ]) {
    const r = await request(); assert.equal(r.status, 403); assert.equal(r.data.code, 'capability_denied');
  }
  assert.deepEqual(await snapshot(t), before);
  // Read on this instance, but the requested write key only exists on another instance.
  assert.equal((await change(t, operator, [...grant(t), ...grant(hidden, ['work:read'])])).status, 200);
  for (const request of [
    () => call('PATCH', base, operator.session, WORK_BODY, headers()),
    () => post(base + '/archive', operator.session, {}, '2'),
    () => post(base + '/results/uploads', operator.session, prepareBody('2')),
    () => post(`${prefix}/workspaces/${hidden.workspaceId}/works`, operator.session, WORK_BODY),
  ]) {
    const r = await request(); assert.equal(r.status, 403, JSON.stringify(r.data)); assert.equal(r.data.code, 'capability_denied');
  }
});

test('grant removal immediately refuses fresh requests and every earlier idempotent Work and Result replay', async () => {
  const t = await openTenant();
  const other = await secondWorkspace(t);
  const member = await person('操作人');
  await join(t, member, 'operator', [...grant(t), ...grant(other)]);
  const created = await createWork(t, member.session);
  const base = `/tenants/${t.tenantId}/works/${created.workId}`;
  const updateKey = randomUUID();
  assert.equal((await call('PATCH', base, member.session, WORK_BODY, { 'Idempotency-Key': updateKey, 'If-Match': '"1"' })).status, 200);
  const flow = await resultFlow(t, created.workId, member.session, '2');
  assert.equal((await change(t, member, grant(other))).status, 200);
  const requests: [number, () => Promise<Reply>][] = [
    [403, () => post(`/tenants/${t.tenantId}/workspaces/${t.workspaceId}/works`, member.session, WORK_BODY, undefined, created.key)],
    [404, () => call('PATCH', base, member.session, WORK_BODY, { 'Idempotency-Key': updateKey, 'If-Match': '"1"' })],
    [404, () => post(base + '/results/uploads', member.session, prepareBody('2'), undefined, flow.prepareKey)],
    [404, () => call('PUT', base + `/results/uploads/${flow.uploadId}/content`, member.session, NOTE, { 'Idempotency-Key': flow.writeKey, 'If-Match': '"1"' })],
    [404, () => post(base + `/results/uploads/${flow.uploadId}/finalize`, member.session, { expected_work_version: '2' }, flow.uploadVersion, flow.finalizeKey)],
    [404, () => call('GET', base, member.session)],
    [404, () => call('GET', base + `/results/${flow.resultId}/content`, member.session)],
  ];
  const before = await snapshot(t);
  for (const [status, request] of requests) {
    const r = await request(); assert.equal(r.status, status, JSON.stringify(r.data));
    assert.equal(r.data.code, status === 403 ? 'capability_denied' : 'not_found');
    assert.deepEqual(await snapshot(t), before);
  }
  assert.equal((await change(t, member, [])).status, 200);
  for (const [, request] of requests) {
    const r = await request(); assert.equal(r.status, 403, JSON.stringify(r.data)); assert.equal(r.data.code, 'capability_denied');
  }
  const paths = [base + '/results', base + `/results/${flow.resultId}`, base + `/results/uploads/${flow.uploadId}`,
    `/tenants/${t.tenantId}/workspaces/${t.workspaceId}/works`];
  for (const path of paths) {
    const r = await call('GET', path, member.session); assert.equal(r.status, 403); assert.equal(r.data.code, 'capability_denied');
  }
  const archive = await post(base + '/archive', member.session, {}, '3');
  assert.equal(archive.status, 403); assert.equal(archive.data.code, 'capability_denied');
});

test('launchpad context requires the workspace grant and lists only granted instances; unbound Work behaviour stays intact', async () => {
  const t = await openTenant();
  const second = await secondWorkspace(t);
  const unbound = await secondWorkspace(t, false);
  const member = await person('操作人');
  await join(t, member, 'operator', grant(second, ['work:read', 'work:create']));
  const path = (space: Tenant) => `/tenants/${space.tenantId}/workspaces/${space.workspaceId}/launchpad-context?guild_key=${space.guild}`;
  assert.equal((await call('GET', path(t), member.session)).status, 403);
  assert.equal((await call('GET', path(unbound), member.session)).status, 403);
  const context = await call('GET', path(second), member.session);
  assert.equal(context.status, 200, JSON.stringify(context.data));
  assert.deepEqual(context.data.instances.map((i: any) => i.instance_id), [second.instanceId]);
  assert.equal((await change(t, member, [...grant(second, ['work:read', 'work:create']), ...grant(t, ['work:read'])])).status, 200);
  const permitted = await call('GET', path(t), member.session);
  assert.equal(permitted.status, 200);
  assert.deepEqual(permitted.data.instances.map((i: any) => i.instance_id).sort(), [t.instanceId, second.instanceId].sort());
  const list = await call('GET', `/tenants/${t.tenantId}/workspaces/${unbound.workspaceId}/works`, member.session);
  assert.equal(list.status, 200); assert.deepEqual(list.data.items, []);
  const create = await post(`/tenants/${t.tenantId}/workspaces/${unbound.workspaceId}/works`, member.session, WORK_BODY);
  assert.equal(create.status, 409); assert.equal(create.data.code, 'work_instance_required');
  const off = createApp(pool, origin, 'local', { tenantWorkAssetStore: store });
  const absent = await call('GET', path(t), t.owner, undefined, {}, off);
  assert.equal(absent.status, 404); assert.equal(absent.data.code, 'not_found');
});

test('account disable retains grants and recovery execute revokes the restored and former owner grants together', async () => {
  const t = await openTenant();
  const recipient = await person('復原擁有者');
  await join(t, recipient);
  // Retained historical owner rows must also be cleared by recovery.
  await pool.query(`INSERT INTO tenant_module_permissions(tenant_id,principal_id,instance_id,capabilities,status,granted_by_principal_id)
    VALUES($1,$2,$3,'{work:read}','active',$2)`, [t.tenantId, t.principalId, t.instanceId]);
  const actors: AdminActor[] = [];
  for (const capability of ['tenant.recovery.open', 'tenant.recovery.review', 'tenant.recovery.execute']) {
    const id = randomUUID(), email = `recovery-${id}@example.test`;
    await pool.query(`INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,'合成管理員')`, [id, DEMO_COMMUNITY, email]);
    await pool.query(`INSERT INTO platform_admin_tenant_recovery_capabilities(admin_id,capability) VALUES($1,$2)`, [id, capability]);
    actors.push({ admin_id: id, community_id: DEMO_COMMUNITY, email, display_name: '合成管理員', role: 'super_admin', subject: id });
  }
  const command = (admin: AdminActor, operation: string, body: unknown, expected?: string): AdminCommand =>
    ({ admin, operation, body, expected, key: randomUUID() });
  const before = (await pool.query('SELECT * FROM tenant_module_permissions ORDER BY permission_id')).rows;
  await changeMemberStatus(pool, command(actors[0], 'member.status', { active: false, reason: '合成帳號停用' }, '1'), t.owner.userId);
  assert.deepEqual((await pool.query('SELECT * FROM tenant_module_permissions ORDER BY permission_id')).rows, before);
  assert.equal((await pool.query('SELECT status FROM tenants WHERE tenant_id=$1', [t.tenantId])).rows[0].status, 'recovery_required');
  const opened = await openRecoveryCase(pool, command(actors[0], 'tenant.recovery.open', {
    tenant_id: t.tenantId, proposed_owner_principal_id: recipient.principalId, evidence_ref: randomUUID(), reason: '唯一擁有者已停用',
  }));
  const approved = await approveRecoveryCase(pool, command(actors[1], 'tenant.recovery.approve', {
    approved_scope: ['tenant.owner.restore'], expires_at: new Date(Date.now() + 3600000).toISOString(), reason: '核准合成復原',
  }, opened.version), opened.case_id);
  const fresh = await post('/me/high-risk-verifications', recipient.session,
    { password: DEMO_PASSWORD, purpose: 'tenant.recovery.accept', tenant_id: t.tenantId });
  assert.equal(fresh.status, 201, JSON.stringify(fresh.data));
  const accepted = await post(`/me/tenant-recovery-cases/${opened.case_id}/accept`, recipient.session,
    { accept_scope: true, fresh_auth_verification_id: fresh.data.verification_id }, approved.version);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  await executeRecoveryCase(pool, command(actors[2], 'tenant.recovery.execute', {}, accepted.data.version), opened.case_id);
  const rows = (await pool.query('SELECT permission_id,status,version::text,revoked_at FROM tenant_module_permissions ORDER BY permission_id')).rows;
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.status === 'revoked' && row.version === '2' && row.revoked_at));
  assert.deepEqual(rows.map(row => row.permission_id), before.map(row => row.permission_id));
  const memberships = (await pool.query('SELECT principal_id,role,status FROM tenant_memberships WHERE tenant_id=$1', [t.tenantId])).rows;
  assert.deepEqual(memberships.find(row => row.principal_id === recipient.principalId), { principal_id: recipient.principalId, role: 'owner', status: 'active' });
  assert.equal(memberships.find(row => row.principal_id === t.principalId)!.status, 'revoked');
});

test('T-013 and restricted runtime max-one connection alternate owner A and scoped operator B without role or grant leakage', async () => {
  const a = await openTenant();
  const b = await openTenant(await login(DEMO_USERS[1].email));
  const samePerson = { session: a.owner, principalId: a.principalId };
  const aReader = await person('甲讀者');
  await join(a, aReader, 'viewer', grant(a, ['work:read']));
  await join(b, samePerson, 'operator', grant(b, ['work:read']));
  const bWork = await createWork(b);
  const url = new URL(databaseUrl!); url.username = runtimeRole; url.password = '';
  const runtime = new Pool({ connectionString: url.toString(), options: `-c search_path=${schema} -c statement_timeout=20000`, max: 1 });
  const restricted = createApp(runtime, origin, 'local', { guildLaunchpadEnabled: true, tenantWorkAssetStore: store });
  const actor = await actorOf(a.owner);
  const pid = (await runtime.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  async function quiet() {
    const row = (await runtime.query(`SELECT pg_backend_pid() AS pid, current_setting('freedom.tenant_id',true) AS tenant,
      current_setting('freedom.principal_id',true) AS principal, current_setting('freedom.tenant_scope_id',true) AS scope`)).rows[0];
    assert.equal(row.pid, pid);
    for (const key of ['tenant', 'principal', 'scope']) assert.ok(row[key] === null || row[key] === '');
    assert.equal((await runtime.query('SELECT * FROM tenant_module_permissions')).rowCount, 0);
  }
  try {
    for (const t of [a, b, a, b, a]) {
      await isolatedTransaction(runtime, async q => {
        await bindPrincipalContext(q, a.principalId);
        assert.equal((await q.query('SELECT * FROM tenant_module_permissions')).rowCount, 0);
        const context = await lockTenantScope(q, { actor, tenantId: t.tenantId, capabilitiesForRole: tenantWorkCapabilities });
        assert.equal(context.role, t === a ? 'owner' : 'operator');
        assert.deepEqual(context.capabilities, t === a ? tenantWorkCapabilities('owner') : []);
        const rows = (await q.query('SELECT tenant_id,principal_id,instance_id,capabilities FROM tenant_module_permissions')).rows;
        assert.deepEqual(rows, [{ tenant_id: t.tenantId, principal_id: t === a ? aReader.principalId : a.principalId,
          instance_id: t.instanceId, capabilities: ['work:read'] }]);
        assert.equal((await q.query('SELECT 1 FROM tenant_module_permissions WHERE tenant_id=$1', [t === a ? b.tenantId : a.tenantId])).rowCount, 0);
      });
      await quiet();
      const view = await call('GET', `/tenants/${t.tenantId}`, a.owner, undefined, {}, restricted);
      assert.equal(view.status, 200, JSON.stringify(view.data));
      assert.equal(view.data.my_membership.role, t === a ? 'owner' : 'operator');
      assert.deepEqual(view.data.capabilities.filter((entry: any) => entry.instance_id !== null), t === a ? [] : [{ instance_id: b.instanceId, keys: ['work:read'] }]);
      const created = await post(`/tenants/${t.tenantId}/workspaces/${t.workspaceId}/works`, a.owner, WORK_BODY, undefined, randomUUID(), restricted);
      assert.equal(created.status, t === a ? 201 : 403, JSON.stringify(created.data));
      if (t === b) assert.equal((await call('GET', `/tenants/${b.tenantId}/works/${bWork.workId}`, a.owner, undefined, {}, restricted)).status, 200);
      await quiet();
    }
    const listed = await call('GET', '/tenants', a.owner, undefined, {}, restricted);
    assert.equal(listed.status, 200, JSON.stringify(listed.data));
    assert.equal(listed.data.items.length, 2);
    assert.deepEqual(listed.data.items.find((item: any) => item.tenant_id === b.tenantId).capabilities.filter((entry: any) => entry.instance_id !== null),
      [{ instance_id: b.instanceId, keys: ['work:read'] }]);
    await quiet();
  } finally { await runtime.end(); }
});

async function blockedBy(holderPid: number): Promise<number> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const row = (await admin.query(`SELECT a.pid FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid
      WHERE $1=ANY(pg_blocking_pids(a.pid)) AND a.wait_event_type='Lock' AND NOT l.granted ORDER BY a.pid LIMIT 1`, [holderPid])).rows[0];
    if (row) return row.pid;
  }
  assert.fail(`No lock waiter appeared behind backend ${holderPid}`);
}

for (const first of ['create', 'revoke'] as const) {
  test(`create versus grant revoke serializes when ${first} holds authority first`, async () => {
    const t = await openTenant();
    const member = await person('競爭操作人');
    await join(t, member);
    const holder = await pool.connect();
    const pending: Promise<Reply>[] = [];
    try {
      await holder.query('BEGIN');
      const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      if (first === 'create') {
        // Pause after create holds its membership SHARE lock, before INSERT.
        await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`tenant.capacity/v1/${t.tenantId}/policy`]);
        pending.push(post(`/tenants/${t.tenantId}/workspaces/${t.workspaceId}/works`, member.session, WORK_BODY));
        const createPid = await blockedBy(pid);
        pending.push(change(t, member, []));
        await blockedBy(createPid);
      } else {
        // Pause change after its tenant UPDATE lock, before target membership.
        await holder.query('SELECT principal_id FROM tenant_memberships WHERE tenant_id=$1 AND principal_id=$2 FOR UPDATE', [t.tenantId, member.principalId]);
        pending.push(change(t, member, []));
        const changePid = await blockedBy(pid);
        pending.push(post(`/tenants/${t.tenantId}/workspaces/${t.workspaceId}/works`, member.session, WORK_BODY));
        await blockedBy(changePid);
      }
      await holder.query('COMMIT');
      const replies = await Promise.all(pending);
      assert.equal(replies[first === 'create' ? 1 : 0].status, 200, JSON.stringify(replies));
      const create = replies[first === 'create' ? 0 : 1];
      assert.equal(create.status, first === 'create' ? 201 : 403, JSON.stringify(create.data));
      const rows = (await pool.query(`SELECT w.work_item_id,w.created_at<=p.revoked_at AS before_revoke
        FROM work_items w JOIN tenant_module_permissions p ON p.tenant_id=w.tenant_id AND p.principal_id=w.created_by_principal_id AND p.instance_id=w.instance_id
        WHERE w.tenant_id=$1`, [t.tenantId])).rows;
      assert.equal(rows.length, first === 'create' ? 1 : 0);
      assert.ok(rows.every(row => row.before_revoke));
      const after = await post(`/tenants/${t.tenantId}/workspaces/${t.workspaceId}/works`, member.session, WORK_BODY);
      assert.equal(after.status, 403); assert.equal(after.data.code, 'capability_denied');
      assert.equal((await grantRows(t, member))[0].status, 'revoked');
    } finally {
      await holder.query('ROLLBACK'); holder.release();
      await Promise.allSettled(pending);
    }
  });
}

function restrictedRuntime() {
  const url = new URL(databaseUrl!); url.username = runtimeRole; url.password = '';
  const runtime = new Pool({ connectionString: url.toString(), options: `-c search_path=${schema} -c statement_timeout=20000`, max: 1 });
  return { runtime, target: createApp(runtime, origin, 'local', { guildLaunchpadEnabled: true, tenantWorkAssetStore: store }) };
}

test('tenant list under restricted runtime omits a membership revoked after its page query', async () => {
  const a = await openTenant();
  const b = await openTenant(await login(DEMO_USERS[1].email));
  const member = await person('競爭列表讀者');
  await join(a, member, 'operator', grant(a, ['work:read']));
  await join(b, member, 'operator', grant(b, ['work:read']));
  const [removed, retained] = [a, b].sort((x, y) => x.tenantId.localeCompare(y.tenantId));
  const expected = (await call('GET', `/tenants/${retained.tenantId}`, member.session)).data;
  const { runtime, target } = restrictedRuntime();
  const holder = await pool.connect();
  let pending: Promise<Reply> | undefined;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT tenant_id FROM tenants WHERE tenant_id=$1 FOR UPDATE', [removed.tenantId]);
    const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    pending = call('GET', '/tenants', member.session, undefined, {}, target);
    await blockedBy(pid); // The unlocked page SELECT has completed; the first tenant read is waiting.
    await holder.query(`UPDATE tenant_memberships SET status='revoked',version=version+1,revoked_at=clock_timestamp()
      WHERE tenant_id=$1 AND principal_id=$2`, [removed.tenantId, member.principalId]);
    await holder.query(`UPDATE tenant_module_permissions SET status='revoked',version=version+1,revoked_at=clock_timestamp()
      WHERE tenant_id=$1 AND principal_id=$2`, [removed.tenantId, member.principalId]);
    await holder.query('UPDATE tenants SET authorization_revision=authorization_revision+1 WHERE tenant_id=$1', [removed.tenantId]);
    await holder.query('COMMIT');
    const listed = await pending;
    assert.equal(listed.status, 200, JSON.stringify(listed.data));
    assert.deepEqual(listed.data.items, [expected]);
    assert.equal(listed.data.next_cursor, null);
    assert.equal(listed.data.source_version, String(BigInt(expected.version) + BigInt(expected.authorization_revision) + BigInt(expected.my_membership.version)));
    assert.equal(listed.response.headers.get('cache-control'), 'private, no-store');
    const settings = (await runtime.query(`SELECT current_setting('freedom.tenant_id',true) AS tenant,
      current_setting('freedom.principal_id',true) AS principal, current_setting('freedom.tenant_scope_id',true) AS scope`)).rows[0];
    assert.ok(Object.values(settings).every(value => value === null || value === ''));
    assert.equal((await runtime.query('SELECT * FROM tenant_module_permissions')).rowCount, 0);
  } finally {
    await holder.query('ROLLBACK'); holder.release();
    if (pending) await Promise.allSettled([pending]);
    await runtime.end();
  }
});

test('tenant list under restricted runtime includes disabled scopes with their own grants', async () => {
  const a = await openTenant();
  const b = await openTenant(await login(DEMO_USERS[1].email));
  const member = await person('停用範圍列表讀者');
  await join(a, member, 'operator', grant(a, ['work:read']));
  await join(b, member, 'viewer', grant(b, ['work:read']));
  const { runtime, target } = restrictedRuntime();
  try {
    const before = await call('GET', '/tenants', member.session, undefined, {}, target);
    assert.equal(before.status, 200, JSON.stringify(before.data));
    assert.equal(before.data.items.length, 2);
    await pool.query(`UPDATE resource_scopes SET status='disabled' WHERE kind='tenant' AND tenant_ref=$1`, [b.tenantId]);
    const listed = await call('GET', '/tenants', member.session, undefined, {}, target);
    assert.equal(listed.status, 200, JSON.stringify(listed.data));
    assert.deepEqual(listed.data, before.data);
    for (const t of [a, b]) assert.deepEqual(listed.data.items.find((item: any) => item.tenant_id === t.tenantId)
      .capabilities.filter((entry: any) => entry.instance_id !== null), [{ instance_id: t.instanceId, keys: ['work:read'] }]);
    assert.equal(listed.response.headers.get('cache-control'), 'private, no-store');
    assert.equal((await runtime.query('SELECT * FROM tenant_module_permissions')).rowCount, 0);
  } finally { await runtime.end(); }
});

test('oversized canonical invitation scope is rejected before INSERT even when compact JSON fits', async () => {
  const t = await openTenant();
  const member = await person('大型範圍受邀者');
  const capabilities = Array.from({ length: 50 }, (_, i) => `synthetic:${String(i).padStart(3, '0')}:${'x'.repeat(145)}`);
  const instanceId = randomUUID(), bindingId = randomUUID();
  await isolatedTransaction(pool, async q => {
    await q.query(`INSERT INTO module_definitions(module_key,release_ref,capabilities,data_catalog_ref,contract_ref,data_schema_version,
      portable_profile_ref,runtime_profiles,config_schema_ref,supported_upgrade_paths,license_review_ref,license_state,release_status,version)
      SELECT 'synthetic-long-keys','synthetic-long-keys@1.0.0',$1::jsonb,data_catalog_ref,contract_ref,data_schema_version,
        portable_profile_ref,runtime_profiles,config_schema_ref,supported_upgrade_paths,license_review_ref,license_state,release_status,version
      FROM module_definitions WHERE module_key='work' AND release_ref='work@1.0.0' ON CONFLICT DO NOTHING`, [JSON.stringify(capabilities)]);
    await q.query(`INSERT INTO module_instances(instance_id,tenant_id,module_key,module_release_ref,application_release_ref,
      data_schema_version,contract_ref,status,binding_id,created_by_principal_id,origin_guild_key)
      SELECT $1,tenant_id,'synthetic-long-keys','synthetic-long-keys@1.0.0',application_release_ref,
        data_schema_version,contract_ref,'active',$2,created_by_principal_id,origin_guild_key
      FROM module_instances WHERE instance_id=$3`, [instanceId, bindingId, t.instanceId]);
    await q.query(`INSERT INTO deployment_bindings(binding_id,tenant_id,instance_id,mode,environment,contract_ref,state)
      SELECT $1,tenant_id,$2,mode,environment,contract_ref,'active' FROM deployment_bindings WHERE instance_id=$3`,
    [bindingId, instanceId, t.instanceId]);
  });
  const entries = [{ instance_id: instanceId, capabilities }];
  assert.equal(InstanceCapabilitiesInputSchema.safeParse(entries).success, true);
  assert.ok(Buffer.byteLength(JSON.stringify(entries)) <= 8192);
  const size = (await pool.query('SELECT octet_length($1::jsonb::text) AS bytes', [JSON.stringify(entries)])).rows[0].bytes;
  assert.ok(size > 8192, String(size));
  const before = await snapshot(t);
  const reply = await post(`/tenants/${t.tenantId}/invitations`, t.owner, {
    invitee_principal_id: member.principalId, role: 'operator', instance_capabilities: entries, expires_at: soon(),
  });
  assert.equal(reply.status, 422, JSON.stringify(reply.data));
  assert.equal(reply.data.code, 'validation_failed');
  assert.equal(reply.data.detail, '邀請的權限範圍太大，請減少實例或權限後再試。');
  assert.deepEqual(await snapshot(t), before);
  assert.equal((await pool.query('SELECT 1 FROM tenant_invitations WHERE tenant_id=$1', [t.tenantId])).rowCount, 0);
  // A smaller canonical invitation fits; acceptance stores grant rows rather
  // than rewriting its scope. Member change stores text[] rows with no JSON cap.
  const invited = await invite(t, member, 'operator', [{ instance_id: instanceId, capabilities: capabilities.slice(0, 49) }]);
  const accepted = await post(`/tenants/${t.tenantId}/invitations/${invited.data.invitation_id}/accept`, member.session, {}, invited.data.version);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  const changed = await change(t, member, entries);
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  assert.deepEqual(changed.data.instance_capabilities, entries);
});
