import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { createApp } from '../../apps/platform-api/src/app.js';
import { FakeObjectStore } from '../../packages/asset-storage/fake-store.js';
import { migrate } from '../../scripts/database.js';
import { DEMO_COMMUNITY, DEMO_PASSWORD, DEMO_USERS, seedLocal } from '../../packages/testing/seed.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname)) {
  throw new Error('Tenant runtime RLS requires explicit disposable fp_* TEST_DATABASE_URL.');
}
const origin = 'http://127.0.0.1:4346';
const stamp = `${process.pid}_${Date.now()}`;
const schema = `e1h_${stamp}`;
const migrator = `e1hm_${stamp}`;
const runtimeRole = `e1ha_${stamp}`;
const admin = new Pool({ connectionString, max: 2 });
function roleUrl(role: string) {
  const url = new URL(connectionString!);
  url.username = role;
  url.password = '';
  return url.toString();
}
const owner = new Pool({ connectionString: roleUrl(migrator), options: `-c search_path=${schema} -c statement_timeout=20000`, max: 2 });
const runtime = new Pool({
  connectionString: roleUrl(runtimeRole),
  options: `-c search_path=${schema} -c statement_timeout=20000`,
  max: 1,
  connectionTimeoutMillis: 8000,
});
for (const pool of [admin, owner, runtime]) pool.on('error', () => undefined);
const store = new FakeObjectStore();
const app = createApp(runtime, origin, 'local', { guildLaunchpadEnabled: true, tenantWorkAssetStore: store });
const note = new TextEncoder().encode('A-only-note');
type Session = { cookie: string; csrf: string; user: { user_id: string } };
type Reply = { status: number; data: any; response: Response; bytes: Uint8Array };
let created = false;

function sha(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}
function unset(value: unknown) { return value == null || value === ''; }
async function quiet() {
  const row = (await runtime.query<{ p: string | null; t: string | null; s: string | null; a: string | null; n: number }>(
    `SELECT pg_catalog.current_setting('freedom.principal_id', true) AS p,
            pg_catalog.current_setting('freedom.tenant_id', true) AS t,
            pg_catalog.current_setting('freedom.tenant_scope_id', true) AS s,
            pg_catalog.current_setting('freedom.platform_admin_id', true) AS a,
            (SELECT count(*)::int FROM tenants) AS n`)).rows[0];
  assert.equal(unset(row.p) && unset(row.t) && unset(row.s) && unset(row.a), true);
  assert.equal(row.n, 0);
}
async function applyGrants() {
  const template = await readFile(new URL('../../deploy/cloudflare/sql/20-runtime-grants.psql', import.meta.url), 'utf8');
  const general = template.slice(template.indexOf('BEGIN;'), template.indexOf('-- BEGIN PRIVATE POLICY GRANTS'))
    .replaceAll('SCHEMA public', `SCHEMA ${schema}`).replaceAll(':"runtime"', `"${runtimeRole}"`);
  const capacity = template.split('-- BEGIN TENANT CAPACITY POLICY GRANTS\n')[1].split('\n\\gexec')[0]
    .replaceAll(":'runtime'", `'${runtimeRole}'`).replace("n.nspname='public'", `n.nspname='${schema}'`);
  const authority = template.split('-- BEGIN TENANT AUTHORITY POLICY GRANTS\n')[1].split('\n\\gexec')[0]
    .replaceAll(":'runtime'", `'${runtimeRole}'`).replaceAll("n.nspname='public'", `n.nspname='${schema}'`);
  const q = await owner.connect();
  try {
    await q.query(general);
    const statements = await q.query(capacity);
    assert.equal(statements.rowCount, 1);
    await q.query(Object.values(statements.rows[0])[0] as string);
    const authorityStatements = await q.query(authority);
    assert.equal(authorityStatements.rowCount, 2);
    for (const statement of authorityStatements.rows) await q.query(Object.values(statement)[0] as string);
    await q.query('COMMIT');
  } catch (error) {
    try { await q.query('ROLLBACK'); } catch { /* keep the grant error */ }
    throw error;
  } finally { q.release(); }
}

before(async () => {
  assert.ok(migrator.length < 63 && runtimeRole.length < 63 && schema.length < 63);
  await admin.query(`CREATE ROLE ${migrator} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE ROLE ${runtimeRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE SCHEMA ${schema} AUTHORIZATION ${migrator};
    GRANT USAGE ON SCHEMA ${schema} TO ${runtimeRole}`);
  created = true;
  await migrate(owner);
  await applyGrants();
  await seedLocal(owner);
  await owner.query(`INSERT INTO tenant_capacity_policies(
      policy_id, revision, tenant_id, plan_ref, max_active_instances, max_instances_per_module,
      max_concurrent_provisions, max_work_items, max_retained_bytes, max_concurrent_jobs, max_model_budget, status)
    SELECT $1, 1, NULL, 'synthetic-F-GUILD-TWO-TENANTS-v1', 10, 3, 2, 1000, 104857600, 4, NULL, 'active'
    WHERE NOT EXISTS (SELECT 1 FROM tenant_capacity_policies WHERE status='active' AND tenant_id IS NULL)`, [randomUUID()]);
});
after(async () => {
  await runtime.end();
  await owner.end();
  try {
    if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE; DROP ROLE ${runtimeRole}; DROP ROLE ${migrator}`);
  } finally { await admin.end(); }
});

async function call(method: string, path: string, session?: Session, body?: BodyInit | Uint8Array, headers: Record<string, string> = {}): Promise<Reply> {
  const sent: Record<string, string> = { Origin: origin, ...headers };
  if (session) { sent.Cookie = session.cookie; sent['X-CSRF-Token'] = session.csrf; }
  const payload = body instanceof Uint8Array ? new Uint8Array(body) : body;
  try {
    const response = await app.request(origin + '/api/v1' + path, { method, headers: sent, body: payload });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const type = response.headers.get('content-type') ?? '';
    const data = type.includes('application/json') && bytes.byteLength ? JSON.parse(Buffer.from(bytes).toString('utf8')) : null;
    return { status: response.status, data, response, bytes };
  } finally {
    await quiet();
  }
}
function jsonHeaders(key?: string, version?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key !== undefined) headers['Idempotency-Key'] = key;
  if (version !== undefined) headers['If-Match'] = version;
  return headers;
}
async function post(path: string, session: Session | undefined, body: unknown, version?: string, key = randomUUID()) {
  return call('POST', path, session, JSON.stringify(body), jsonHeaders(key, version));
}
async function signIn(email: string): Promise<Session> {
  const r = await post('/auth/login', undefined, { email, password: DEMO_PASSWORD });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { cookie: r.response.headers.get('set-cookie')!.split(';')[0], csrf: r.data.csrf_token, user: r.data.user };
}
async function extraUser(name: string) {
  const id = randomUUID();
  const email = `tenant-${id}@example.test`;
  await owner.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,active,onboarding_required)
    SELECT $1,$2,$3,$4,password_hash,$5,true,false FROM users WHERE email=$6`,
  [id, DEMO_COMMUNITY, email, name, randomUUID(), DEMO_USERS[0].email]);
  return { id, email, session: await signIn(email) };
}
const workBody = (title: string, objective = '把這件事做完', progress: 'todo' | 'in_progress' | 'done' = 'todo') => ({ title, objective, progress });

test('T-024 the non-owner runtime role serves tenant work and returns the same 404 for hidden ids', async () => {
  const maker = await signIn(DEMO_USERS[0].email);
  const reviewer = await signIn(DEMO_USERS[1].email);
  const client = await signIn(DEMO_USERS[2].email);
  const fourth = await extraUser('外來的幹事');
  const personal = await post('/work-items', maker, {
    title: '新的有限工作', objective: '解決一個真實問題', acceptance_criteria: '交付可重用說明',
    gain: '自願留下公共成果，不保證報酬', estimated_minutes: 20, maximum_minutes: 30,
    claim_by: new Date(Date.now() + 86400000).toISOString(), finish_by: new Date(Date.now() + 2 * 86400000).toISOString(),
    will_review: true,
  });
  assert.equal(personal.status, 201, JSON.stringify(personal.data));
  const listed = await call('GET', '/work-items', maker);
  assert.equal(listed.status, 200, JSON.stringify(listed.data));
  assert.ok(listed.data.items.some((item: { work_item_id: string }) => item.work_item_id === personal.data.work_item_id));
  const privateList = await call('GET', '/me/private-work', maker);
  assert.equal(privateList.status, 200, JSON.stringify(privateList.data));

  const made = await post('/tenants', maker, { display_name: '品牌甲', workspace_name: '櫃檯' });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const tenantId = made.data.tenant.tenant_id as string;
  const guild = (await owner.query<{ guild_key: string }>('SELECT guild_key FROM positioning_guild_catalog ORDER BY guild_key LIMIT 1')).rows[0].guild_key;
  await owner.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier)
    VALUES($1,$2,$3,$4,'active','full')`, [randomUUID(), DEMO_COMMUNITY, maker.user.user_id, guild]);

  const reviewerPrincipal = await call('GET', `/tenants/invite-candidates?user_id=${reviewer.user.user_id}`, maker);
  assert.equal(reviewerPrincipal.status, 200, JSON.stringify(reviewerPrincipal.data));
  const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  const reviewerInvite = await post(`/tenants/${tenantId}/invitations`, maker, {
    invitee_principal_id: reviewerPrincipal.data.principal_id, role: 'admin', instance_capabilities: [], expires_at: soon,
  });
  assert.equal(reviewerInvite.status, 201, JSON.stringify(reviewerInvite.data));
  const reviewerPage = await call('GET', '/me/tenant-invitations', reviewer);
  assert.equal(reviewerPage.status, 200, JSON.stringify(reviewerPage.data));
  assert.equal(reviewerPage.data.items.some((item: { invitation_id: string }) => item.invitation_id === reviewerInvite.data.invitation_id), true);
  const accepted = await post(`/tenants/${tenantId}/invitations/${reviewerInvite.data.invitation_id}/accept`, reviewer, {}, `"${reviewerInvite.data.version}"`);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));

  const clientPrincipal = await call('GET', `/tenants/invite-candidates?user_id=${client.user.user_id}`, maker);
  assert.equal(clientPrincipal.status, 200, JSON.stringify(clientPrincipal.data));
  const clientInvite = await post(`/tenants/${tenantId}/invitations`, maker, {
    invitee_principal_id: clientPrincipal.data.principal_id, role: 'viewer', instance_capabilities: [], expires_at: soon,
  });
  assert.equal(clientInvite.status, 201, JSON.stringify(clientInvite.data));
  const declined = await post(`/tenants/${tenantId}/invitations/${clientInvite.data.invitation_id}/decline`, client, {});
  assert.equal(declined.status, 200, JSON.stringify(declined.data));
  assert.equal(declined.data.state, 'declined');

  const fourthPrincipal = await call('GET', `/tenants/invite-candidates?user_id=${fourth.id}`, maker);
  assert.equal(fourthPrincipal.status, 200, JSON.stringify(fourthPrincipal.data));
  const fourthInvite = await post(`/tenants/${tenantId}/invitations`, maker, {
    invitee_principal_id: fourthPrincipal.data.principal_id, role: 'viewer', instance_capabilities: [], expires_at: soon,
  });
  assert.equal(fourthInvite.status, 201, JSON.stringify(fourthInvite.data));
  await owner.query(`UPDATE tenant_invitations SET expires_at = clock_timestamp() - interval '1 minute' WHERE invitation_id=$1`, [fourthInvite.data.invitation_id]);
  const expiredPage = await call('GET', '/me/tenant-invitations', fourth.session);
  assert.equal(expiredPage.status, 200, JSON.stringify(expiredPage.data));
  const expired = expiredPage.data.items.find((item: { invitation_id: string }) => item.invitation_id === fourthInvite.data.invitation_id);
  assert.equal(expired?.state, 'expired');

  const other = await post('/tenants', client, { display_name: '品牌乙', workspace_name: '櫃檯' });
  assert.equal(other.status, 201, JSON.stringify(other.data));
  const mine = await call('GET', '/tenants', maker);
  assert.equal(mine.status, 200, JSON.stringify(mine.data));
  assert.deepEqual(mine.data.items.map((item: { tenant_id: string }) => item.tenant_id), [tenantId]);
  const members = await call('GET', `/tenants/${tenantId}/members?limit=100`, maker);
  assert.equal(members.status, 200, JSON.stringify(members.data));
  assert.deepEqual(members.data.items.map((item: { role: string }) => item.role).sort(), ['admin', 'owner']);
  assert.equal(members.data.items.some((item: { principal_id: string; role: string }) => item.principal_id === reviewerPrincipal.data.principal_id && item.role === 'admin'), true);

  const space = await post(`/tenants/${tenantId}/workspaces`, maker, { name: '後櫃' });
  assert.equal(space.status, 201, JSON.stringify(space.data));
  const workspaceId = space.data.workspace_id as string;
  const enabled = await post(`/tenants/${tenantId}/workspaces/${workspaceId}/manual-work`, maker, { guild_key: guild });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
  const created = await post(`/tenants/${tenantId}/workspaces/${workspaceId}/works`, maker, workBody('第一個工作'));
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.version, '1');
  const workId = created.data.resource_ref.resource_id as string;
  const patched = await call('PATCH', `/tenants/${tenantId}/works/${workId}`, maker, JSON.stringify(workBody('改過的標題', '新的目的', 'in_progress')), jsonHeaders(randomUUID(), '"1"'));
  assert.equal(patched.status, 200, JSON.stringify(patched.data));
  const prepared = await post(`/tenants/${tenantId}/works/${workId}/results/uploads`, maker, {
    content_type: 'text/markdown', byte_size: note.byteLength, sha256: sha(note), display_name: 'note.md', expected_work_version: '2',
  });
  assert.equal(prepared.status, 201, JSON.stringify(prepared.data));
  const uploadId = prepared.data.resource_ref.resource_id as string;
  const written = await call('PUT', `/tenants/${tenantId}/works/${workId}/results/uploads/${uploadId}/content`, maker, note, {
    'Idempotency-Key': randomUUID(), 'If-Match': '"1"',
  });
  assert.equal(written.status, 200, JSON.stringify(written.data));
  assert.equal(written.data.verified, true);
  assert.equal(written.data.version, '2');
  const finalizeKey = randomUUID();
  const finished = await post(`/tenants/${tenantId}/works/${workId}/results/uploads/${uploadId}/finalize`, maker, { expected_work_version: '2' }, '"2"', finalizeKey);
  assert.equal(finished.status, 200, JSON.stringify(finished.data));
  const replayed = await post(`/tenants/${tenantId}/works/${workId}/results/uploads/${uploadId}/finalize`, maker, { expected_work_version: '2' }, '"2"', finalizeKey);
  assert.deepEqual(replayed.data, finished.data);
  const resultId = finished.data.resource_ref.resource_id as string;
  const content = await call('GET', `/tenants/${tenantId}/works/${workId}/results/${resultId}/content`, maker);
  assert.equal(content.status, 200, JSON.stringify(content.data));
  assert.deepEqual(Buffer.from(content.bytes), Buffer.from(note));
  assert.match(content.response.headers.get('content-type') ?? '', /^text\/markdown; charset=utf-8$/);
  assert.match(content.response.headers.get('content-disposition') ?? '', /attachment;/);
  assert.match(content.response.headers.get('content-disposition') ?? '', /filename\*=UTF-8''/);
  assert.equal(content.response.headers.get('cache-control'), 'private, no-store');

  async function sameNotFound(actor: Session, path: string, randomPath: string) {
    const hidden = await call('GET', path, actor);
    const missing = await call('GET', randomPath, actor);
    assert.equal(hidden.status, 404, JSON.stringify(hidden.data));
    assert.deepEqual(hidden.data, missing.data);
  }
  const randomTenant = randomUUID();
  const randomWork = randomUUID();
  const randomUpload = randomUUID();
  const randomResult = randomUUID();
  for (const actor of [client, fourth.session]) {
    await sameNotFound(actor, `/tenants/${tenantId}`, `/tenants/${randomTenant}`);
    await sameNotFound(actor, `/tenants/${tenantId}/works/${workId}`, `/tenants/${randomTenant}/works/${randomWork}`);
    await sameNotFound(actor, `/tenants/${tenantId}/works/${workId}/results/uploads/${uploadId}`, `/tenants/${randomTenant}/works/${randomWork}/results/uploads/${randomUpload}`);
    await sameNotFound(actor, `/tenants/${tenantId}/works/${workId}/results/${resultId}`, `/tenants/${randomTenant}/works/${randomWork}/results/${randomResult}`);
    await sameNotFound(actor, `/tenants/${tenantId}/works/${workId}/results/${resultId}/content`, `/tenants/${randomTenant}/works/${randomWork}/results/${randomResult}/content`);
  }

  const current = await call('GET', `/tenants/${tenantId}/works/${workId}`, maker);
  assert.equal(current.status, 200, JSON.stringify(current.data));
  const archived = await post(`/tenants/${tenantId}/works/${workId}/archive`, maker, {}, `"${current.data.version}"`);
  assert.equal(archived.status, 200, JSON.stringify(archived.data));
});

