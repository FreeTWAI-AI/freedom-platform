import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { createPool } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_PASSWORD, DEMO_COMMUNITY, DEMO_USERS } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';

const origin = 'http://127.0.0.1:4310';
const databaseUrl = process.env.TEST_DATABASE_URL;
assert.ok(databaseUrl, 'TEST_DATABASE_URL is required');
assert.match(new URL(databaseUrl).pathname, /^\/fp_[a-z0-9_]+$/);
const schema = `fp_tenant_member_identity_${process.pid}_${Date.now()}`;
const admin = createPool(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 8 });
const app = createApp(pool, origin, 'local', { guildLaunchpadEnabled: true });
type Session = { cookie: string; csrf: string; user: { user_id: string } };

before(async () => {
  assert.match(schema, /^fp_tenant_member_identity_[0-9]+_[0-9]+$/);
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

async function request(path: string, session?: Session, body?: unknown) {
  const headers: Record<string, string> = { Origin: origin, ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}) };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['Idempotency-Key'] = randomUUID();
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
  const data = await response.json() as { csrf_token?: string; user?: Session['user'] };
  assert.equal(response.status, 200, JSON.stringify(data));
  return { cookie: response.headers.get('set-cookie')!.split(';')[0], csrf: data.csrf_token!, user: data.user! };
}
async function person(name: string) {
  const id = randomUUID();
  const email = `tenant-identity-${id}@example.test`;
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,active,onboarding_required)
    SELECT $1,$2,$3,$4,password_hash,$5,true,false FROM users WHERE email=$6`,
  [id, DEMO_COMMUNITY, email, name, randomUUID(), DEMO_USERS[0].email]);
  const session = await signIn(email);
  const listed = await request('/tenants?limit=1', session);
  assert.equal(listed.status, 200, JSON.stringify(listed.data));
  const principalId = (await pool.query<{ principal_id: string }>('SELECT principal_id FROM principals WHERE user_ref=$1', [id])).rows[0].principal_id;
  return { id, principalId, session };
}
async function createTenant(owner: Awaited<ReturnType<typeof person>>, displayName: string) {
  const made = await request('/tenants', owner.session, { display_name: displayName, workspace_name: `${displayName}櫃檯` });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const tenant = made.data.tenant as { tenant_id: string; my_membership: { principal_id: string } };
  assert.equal(tenant.my_membership.principal_id, owner.principalId);
  return tenant.tenant_id;
}
async function owners(tenantId: string) {
  return (await pool.query<{ principal_id: string; role: string; status: string }>(
    `SELECT principal_id,role,status FROM tenant_memberships WHERE tenant_id=$1 ORDER BY principal_id`, [tenantId])).rows;
}
async function attempt(change: (client: PoolClient) => Promise<unknown>) {
  const client = await pool.connect();
  let code = 'committed';
  try {
    await client.query('BEGIN');
    await change(client);
    await client.query('COMMIT');
  } catch (error) {
    code = (error as { code?: string }).code ?? 'unknown';
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
  return code;
}

test('moving an owner membership onto another tenant is rejected and both owners stay put', async () => {
  const ownerA = await person('身分甲');
  const ownerB = await person('身分乙');
  const tenantA = await createTenant(ownerA, '空間甲');
  const tenantB = await createTenant(ownerB, '空間乙');
  const code = await attempt(client => client.query(
    'UPDATE tenant_memberships SET tenant_id=$2 WHERE tenant_id=$1 AND principal_id=$3',
    [tenantA, tenantB, ownerA.principalId]));
  assert.equal(code, '23514');
  assert.deepEqual(await owners(tenantA), [{ principal_id: ownerA.principalId, role: 'owner', status: 'active' }]);
  assert.deepEqual(await owners(tenantB), [{ principal_id: ownerB.principalId, role: 'owner', status: 'active' }]);
});

test('rewriting a membership principal is rejected and the original owner remains', async () => {
  const ownerA = await person('身分丙');
  const other = await person('身分丁');
  const tenantA = await createTenant(ownerA, '空間丙');
  const code = await attempt(client => client.query(
    'UPDATE tenant_memberships SET principal_id=$2 WHERE tenant_id=$1 AND principal_id=$3',
    [tenantA, other.principalId, ownerA.principalId]));
  assert.equal(code, '23514');
  assert.deepEqual(await owners(tenantA), [{ principal_id: ownerA.principalId, role: 'owner', status: 'active' }]);
});

test('deleting the sole active owner is rejected', async () => {
  const ownerA = await person('身分戊');
  const tenantA = await createTenant(ownerA, '空間戊');
  const code = await attempt(client => client.query('DELETE FROM tenant_memberships WHERE tenant_id=$1', [tenantA]));
  assert.equal(code, '23514');
  assert.deepEqual(await owners(tenantA), [{ principal_id: ownerA.principalId, role: 'owner', status: 'active' }]);
});

test('same-tenant demotion commits when another active owner remains', async () => {
  const ownerA = await person('身分己');
  const ownerB = await person('身分庚');
  const tenantA = await createTenant(ownerA, '空間己');
  await pool.query(`INSERT INTO tenant_memberships(tenant_id,principal_id,role,status,accepted_at)
    VALUES($1,$2,'owner','active',clock_timestamp())`, [tenantA, ownerB.principalId]);
  const code = await attempt(client => client.query(
    `UPDATE tenant_memberships SET role='admin', updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2`,
    [tenantA, ownerA.principalId]));
  assert.equal(code, 'committed');
  const rows = await owners(tenantA);
  assert.equal(rows.filter(row => row.role === 'owner' && row.status === 'active').length, 1);
  assert.equal(rows.find(row => row.principal_id === ownerA.principalId)?.role, 'admin');
  assert.equal(rows.find(row => row.principal_id === ownerB.principalId)?.role, 'owner');
});

test('demoting the last active owner is rejected', async () => {
  const ownerA = await person('身分辛');
  const tenantA = await createTenant(ownerA, '空間辛');
  const code = await attempt(client => client.query(
    `UPDATE tenant_memberships SET role='viewer', updated_at=clock_timestamp() WHERE tenant_id=$1`, [tenantA]));
  assert.equal(code, '23514');
  assert.deepEqual(await owners(tenantA), [{ principal_id: ownerA.principalId, role: 'owner', status: 'active' }]);
});

test('a recovery_required tenant may commit with zero active owners', async () => {
  const ownerA = await person('身分壬');
  const tenantA = await createTenant(ownerA, '空間壬');
  const code = await attempt(async client => {
    await client.query(`UPDATE tenants SET status='recovery_required', updated_at=clock_timestamp() WHERE tenant_id=$1`, [tenantA]);
    await client.query('DELETE FROM tenant_memberships WHERE tenant_id=$1', [tenantA]);
  });
  assert.equal(code, 'committed');
  assert.deepEqual(await owners(tenantA), []);
  assert.equal((await pool.query<{ status: string }>('SELECT status FROM tenants WHERE tenant_id=$1', [tenantA])).rows[0].status, 'recovery_required');
});
