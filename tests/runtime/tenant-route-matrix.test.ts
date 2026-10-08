import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { createLocalJWKSet } from 'jose';
import { createAdminAccessVerifier } from '../../modules/platform-admin/access.js';
import { Pool } from 'pg';
import { createApp } from '../../apps/platform-api/src/app.js';
import { FakeObjectStore } from '../../packages/asset-storage/fake-store.js';
import { migrate } from '../../scripts/database.js';
import { DEMO_COMMUNITY, DEMO_PASSWORD, DEMO_USERS, seedLocal } from '../../packages/testing/seed.js';
import { ensureSyntheticModuleTables, setSyntheticFault, syntheticModuleProviders } from '../../packages/testing/synthetic-module-provider.js';
import { WORK_CONTRACT_SOURCE_COMMIT } from '../../modules/module-registry/definitions.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname)) {
  throw new Error('Tenant runtime RLS requires explicit disposable fp_* TEST_DATABASE_URL.');
}
const origin = 'http://127.0.0.1:4348';
const stamp = `${process.pid}_${Date.now()}`;
const schema = `rm_${stamp}`;
const migrator = `rmm_${stamp}`;
const runtimeRole = `rmr_${stamp}`;
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
const providers = syntheticModuleProviders(runtime);
const adminVerifier = createAdminAccessVerifier({ issuer: 'https://synthetic-matrix.cloudflareaccess.com', audience: 'tenant-route-matrix',
  csrfSecret: 'synthetic-matrix-admin-csrf-secret-123456789', keySet: createLocalJWKSet({ keys: [] }) });
const app = createApp(runtime, origin, 'local', { guildLaunchpadEnabled: true, tenantWorkAssetStore: store, moduleProviders: providers, adminVerifier });

let created = false;
let runtimeConnection: { current_user: string; session_user: string; rolsuper: boolean; rolbypassrls: boolean; pg_backend_pid: number };
const requestEvidence: { method: string; path: string; pid: number; settings: Record<string, string | null> }[] = [];
let connectionRemovals = 0;
runtime.on('remove', () => { connectionRemovals++; });
const requestStarts = new Map<string, number>();
beforeEach(t => {
  if (t.name.startsWith('T-022 ')) requestStarts.set(t.name, requestEvidence.length);
});
afterEach(t => {
  if (t.name.startsWith('T-022 ')) console.log(JSON.stringify({ matrix_requests: t.name,
    count: requestEvidence.length - requestStarts.get(t.name)! }));
});
type Session = { cookie: string; csrf: string; user: { user_id: string; email: string } };
type Reply = { status: number; data: any; response: Response; bytes: Uint8Array; headers: Headers };

function sha(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}
function jsonHeaders(key?: string, version?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key !== undefined) headers['Idempotency-Key'] = key;
  if (version !== undefined) headers['If-Match'] = version;
  return headers;
}
async function call(method: string, path: string, session?: Session, body?: string | Uint8Array, headers: Record<string, string> = {}): Promise<Reply> {
  const sent: Record<string, string> = { Origin: origin, ...headers };
  if (session) { sent.Cookie = session.cookie; sent['X-CSRF-Token'] = session.csrf; }
  const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  const response = await app.request(origin + (path.startsWith('/admin/') ? path : '/api/v1' + path), { method, headers: sent, body: payload as any });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const type = response.headers.get('content-type') ?? '';
  const data = type.includes('application/json') && bytes.byteLength ? JSON.parse(Buffer.from(bytes).toString('utf8')) : null;
  const reply = { status: response.status, data, response, bytes, headers: response.headers };
  if (/\/module-instances\/[^/]+\/(suspend|resume)$/.test(path)) {
    console.log(JSON.stringify({ lifecycle_reply: { method, path, status: reply.status, code: reply.data?.code ?? null } }));
  }
  if (/\/module-instances\/[^/]+\/archive$|\/module-binding$/.test(path)) {
    console.log(JSON.stringify({ archive_matrix_reply: { method, path, status: reply.status, code: reply.data?.code ?? null } }));
  }
  verifyHeaders(reply, method, path);
  await quiet(method, path);
  return reply;
}
async function post(path: string, session?: Session, body?: unknown, version?: string, key: string = randomUUID()) {
  return call('POST', path, session, body ? JSON.stringify(body) : undefined, jsonHeaders(key, version));
}
async function patch(path: string, session?: Session, body?: unknown, version?: string, key: string = randomUUID()) {
  return call('PATCH', path, session, body ? JSON.stringify(body) : undefined, jsonHeaders(key, version));
}

async function signIn(email: string): Promise<Session> {
  const r = await post('/auth/login', undefined, { email, password: DEMO_PASSWORD });
  assert.equal(r.status, 200, `Sign in failed for ${email}: ${JSON.stringify(r.data)}`);
  return { cookie: r.response.headers.get('set-cookie')!.split(';')[0], csrf: r.data.csrf_token, user: { user_id: r.data.user.user_id, email } };
}

before(async () => {
  await admin.query(`CREATE ROLE ${migrator} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE ROLE ${runtimeRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE SCHEMA ${schema} AUTHORIZATION ${migrator};
    GRANT USAGE ON SCHEMA ${schema} TO ${runtimeRole}`);
  created = true;
  await migrate(owner);
  await ensureSyntheticModuleTables(owner);
  const template = await readFile(new URL('../../deploy/cloudflare/sql/20-runtime-grants.psql', import.meta.url), 'utf8');
  const general = template.slice(template.indexOf('BEGIN;'), template.indexOf('-- BEGIN PRIVATE POLICY GRANTS'))
    .replaceAll('SCHEMA public', `SCHEMA ${schema}`).replaceAll(':"runtime"', `"${runtimeRole}"`);
  const capacity = template.split('-- BEGIN TENANT CAPACITY POLICY GRANTS\n')[1].split('\n\\gexec')[0]
    .replaceAll(":'runtime'", `'${runtimeRole}'`).replaceAll("n.nspname='public'", `n.nspname='${schema}'`);
  const authority = template.split('-- BEGIN TENANT AUTHORITY POLICY GRANTS\n')[1].split('\n\\gexec')[0]
    .replaceAll(":'runtime'", `'${runtimeRole}'`).replaceAll("n.nspname='public'", `n.nspname='${schema}'`);
  const registry = template.split('-- BEGIN MODULE REGISTRY DEFINITION GRANTS\n')[1].split('\n\\gexec')[0]
    .replaceAll(":'runtime'", `'${runtimeRole}'`).replaceAll("n.nspname='public'", `n.nspname='${schema}'`);

  const q = await owner.connect();
  try {
    await q.query(general);
    const statements = await q.query(capacity);
    await q.query(Object.values(statements.rows[0])[0] as string);
    const authorityStatements = await q.query(authority);
    for (const statement of authorityStatements.rows) await q.query(Object.values(statement)[0] as string);
    const registryStatements = await q.query(registry);
    for (const statement of registryStatements.rows) await q.query(Object.values(statement)[0] as string);
    await q.query('COMMIT');
  } catch (error) {
    try { await q.query('ROLLBACK'); } catch {}
    throw error;
  } finally { q.release(); }

  runtimeConnection = (await runtime.query(`SELECT current_user, session_user, rolsuper, rolbypassrls,
    pg_backend_pid() AS pg_backend_pid FROM pg_roles WHERE rolname=current_user`)).rows[0];
  console.log(JSON.stringify({ t024_runtime_connection: runtimeConnection }));

  await seedLocal(owner);
  await owner.query(`UPDATE tenant_authority_policies SET status='retired' WHERE status='active'`);
  await owner.query(`INSERT INTO tenant_authority_policies(revision,status,fresh_auth_ttl_seconds,transfer_ttl_seconds,recovery_approval_ttl_seconds,max_open_recovery_cases_per_tenant)
    VALUES (1,'active',600,86400,86400,1)`);
  await owner.query(`INSERT INTO tenant_capacity_policies(
      policy_id, revision, tenant_id, plan_ref, max_active_instances, max_instances_per_module,
      max_concurrent_provisions, max_work_items, max_retained_bytes, max_concurrent_jobs, max_model_budget, status)
    SELECT $1, 1, NULL, 'synthetic-F-GUILD-TWO-TENANTS-v1', 10, 3, 2, 1000, 104857600, 4, NULL, 'active'
    WHERE NOT EXISTS (SELECT 1 FROM tenant_capacity_policies WHERE status='active' AND tenant_id IS NULL)`, [randomUUID()]);
  await installSyntheticCatalog();
  // Keep both providers unresolved without sleeps or external effects.
  await setSyntheticFault(owner, 'synthetic-inventory', 'crash_before');
  await setSyntheticFault(owner, 'synthetic-storefront', 'crash_before');
  fixture = await buildFixture();
});

after(async () => {
  await runtime.end();
  await owner.end();
  try {
    if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE; DROP ROLE ${runtimeRole}; DROP ROLE ${migrator}`);
  } finally { await admin.end(); }
});


const synthContract = { family: 'guild-launchpad.synthetic', version: '1', source_commit: WORK_CONTRACT_SOURCE_COMMIT, artifact_sha256: '0'.repeat(64), behavior_profile: 'freedom.synthetic/v1' };
async function installSyntheticCatalog() {
  const policy = JSON.stringify({ policy_key: 'synthetic-storefront.launch', version: '1' });
  const inventoryReq = {
    requirement_key: 'inventory', module_key: 'synthetic-inventory', module_release_ref: 'synthetic-inventory@1.0.0',
    capabilities: ['inventory:read'], required: true, cardinality: 'one', allow_reuse: true, compatible_contracts: [synthContract],
  };
  const storefrontReq = {
    requirement_key: 'storefront', module_key: 'synthetic-storefront', module_release_ref: 'synthetic-storefront@1.0.0',
    capabilities: ['storefront:sell'], required: true, cardinality: 'one', allow_reuse: false, compatible_contracts: [synthContract],
  };
  for (const moduleKey of ['synthetic-inventory', 'synthetic-storefront']) {
    const capability = moduleKey === 'synthetic-inventory' ? 'inventory:read' : 'storefront:sell';
    await owner.query(`INSERT INTO module_definitions(
        module_key, release_ref, capabilities, data_catalog_ref, contract_ref, data_schema_version,
        portable_profile_ref, runtime_profiles, config_schema_ref, supported_upgrade_paths,
        license_review_ref, license_state, release_status, version)
      VALUES($1,$2,$3::jsonb,'synthetic.tenant/v1',$4::jsonb,'1',NULL,'["hosted-shared"]'::jsonb,$5,'[]'::jsonb,NULL,'reviewed','available',1)
      ON CONFLICT DO NOTHING`,
    [moduleKey, `${moduleKey}@1.0.0`, JSON.stringify([capability]), JSON.stringify(synthContract), `${moduleKey}.config/v1`]);
  }
  await owner.query(`INSERT INTO application_definitions(
      application_key, release_ref, display_name, source_commit, artifact_digest, skill_book_refs,
      module_requirements, entry_capability, runtime_profiles, launch_policy_ref, license_state,
      release_status, customization_schema_ref, license_review_ref, version)
    VALUES('synthetic-storefront','synthetic-storefront@1.0.0','合成店面',$1,$2::jsonb,'[]'::jsonb,$3::jsonb,
      'storefront:sell','["hosted-reviewed"]'::jsonb,$4::jsonb,'reviewed','available','synthetic-storefront.config/v1',NULL,1)
    ON CONFLICT DO NOTHING`,
  [WORK_CONTRACT_SOURCE_COMMIT, JSON.stringify({ algorithm: 'sha256', value: '0'.repeat(64) }),
    JSON.stringify([inventoryReq, storefrontReq]), policy]);
  await owner.query(`INSERT INTO guild_application_offerings(
      offering_id, community_id, guild_key, application_key, release_ref, status, display_order, launch_policy_ref, version)
    SELECT $1,$2,'guild_ai_field','synthetic-storefront','synthetic-storefront@1.0.0','offered',10,$3::jsonb,1
    WHERE NOT EXISTS (
      SELECT 1 FROM guild_application_offerings
      WHERE community_id=$2 AND guild_key='guild_ai_field' AND release_ref='synthetic-storefront@1.0.0')`,
  [randomUUID(), DEMO_COMMUNITY, policy]);
}

const routeTable: Record<string, string> = {
  'GET /api/v1/tenants/:tenant_id/storefronts/:instance_id': 'tenant',
  'POST /api/v1/tenants/:tenant_id/storefronts/:instance_id/setup': 'tenant',
  'PATCH /api/v1/tenants/:tenant_id/storefronts/:instance_id': 'tenant',
  'GET /api/v1/tenants/:tenant_id/storefronts/:instance_id/slug-availability': 'tenant',
  'GET /api/v1/tenants/:tenant_id/storefronts/:instance_id/products': 'tenant',
  'POST /api/v1/tenants/:tenant_id/storefronts/:instance_id/products': 'tenant',
  'PATCH /api/v1/tenants/:tenant_id/storefronts/:instance_id/products/:product_id': 'tenant',
  'POST /api/v1/tenants/:tenant_id/storefronts/:instance_id/products/:product_id/remove': 'tenant',
  'GET /api/v1/tenants/:tenant_id/storefronts/:instance_id/preview': 'tenant',
  'POST /api/v1/tenants/:tenant_id/storefronts/:instance_id/publish': 'tenant',
  'POST /api/v1/tenants/:tenant_id/storefronts/:instance_id/unpublish': 'tenant',

  'GET /admin/api/guild-applications': 'admin',
  'POST /admin/api/guild-applications/:id/review': 'admin',
  'POST /admin/api/tenant-recovery-cases': 'admin',
  'GET /admin/api/tenant-recovery-cases/:id': 'admin',
  'POST /admin/api/tenant-recovery-cases/:id/approve': 'admin',
  'POST /admin/api/tenant-recovery-cases/:id/execute': 'admin',
  'POST /admin/api/tenant-recovery-cases/:id/close': 'admin',
  'GET /api/v1/public/guilds/:guild_key/launchpad': 'guild',
  'GET /api/v1/applications': 'global',
  'GET /api/v1/applications/:application_key/releases/:release_ref': 'global',
  'GET /api/v1/guild-workspace': 'principal',
  'GET /api/v1/guilds/:guild_key/launchpad': 'guild',
  'GET /api/v1/guilds/:guild_key/launchpad-config': 'guild',
  'POST /api/v1/guilds/:guild_key/launchpad-config/drafts': 'guild',
  'POST /api/v1/guilds/:guild_key/launchpad-config/preview': 'guild',
  'POST /api/v1/guilds/:guild_key/launchpad-config/:config_id/publish': 'guild',
  'POST /api/v1/guilds/:guild_key/launchpad-config/revert': 'guild',
  'POST /api/v1/guilds/:guild_key/launchpad-delegations': 'guild',
  'POST /api/v1/guilds/:guild_key/launchpad-delegations/:delegation_id/revoke': 'guild',
  'GET /api/v1/guild-applications': 'global',
  'POST /api/v1/guild-applications': 'global',
  'GET /api/v1/tenants': 'principal',
  'POST /api/v1/tenants': 'principal',
  'GET /api/v1/tenants/invite-candidates': 'principal',
  'GET /api/v1/me/tenant-invitations': 'principal',
  'GET /api/v1/me/tenant-ownership-transfers': 'principal',
  'GET /api/v1/me/tenant-recovery-cases': 'principal',
  'POST /api/v1/me/tenant-recovery-cases/:id/accept': 'principal',
  'GET /api/v1/tenants/:tenant_id': 'tenant',
  'POST /api/v1/tenants/:tenant_id/edit': 'tenant',
  'GET /api/v1/tenants/:tenant_id/members': 'tenant',
  'POST /api/v1/tenants/:tenant_id/invitations': 'tenant',
  'POST /api/v1/tenants/:tenant_id/invitations/:id/accept': 'tenant',
  'POST /api/v1/tenants/:tenant_id/invitations/:id/decline': 'tenant',
  'POST /api/v1/tenants/:tenant_id/invitations/:id/revoke': 'tenant',
  'POST /api/v1/tenants/:tenant_id/members/:principal_id/change': 'tenant',
  'POST /api/v1/tenants/:tenant_id/leave': 'tenant',
  'POST /api/v1/tenants/:tenant_id/workspaces': 'tenant',
  'GET /api/v1/tenants/:tenant_id/workspaces': 'tenant',
  'POST /api/v1/tenants/:tenant_id/ownership-transfers': 'tenant',
  'GET /api/v1/tenants/:tenant_id/ownership-transfers': 'tenant',
  'GET /api/v1/tenants/:tenant_id/ownership-transfers/:id': 'tenant',
  'POST /api/v1/tenants/:tenant_id/ownership-transfers/:id/accept': 'tenant',
  'POST /api/v1/tenants/:tenant_id/ownership-transfers/:id/cancel': 'tenant',
  'POST /api/v1/tenants/:tenant_id/ownership-transfers/:id/decline': 'tenant',
  'POST /api/v1/tenants/:tenant_id/workspaces/:workspace_id/manual-work': 'tenant',
  'GET /api/v1/tenants/:tenant_id/module-instances': 'tenant',
  'GET /api/v1/tenants/:tenant_id/module-instances/:instance_id': 'tenant',
  'POST /api/v1/tenants/:tenant_id/module-instances/:instance_id/suspend': 'tenant',
  'POST /api/v1/tenants/:tenant_id/module-instances/:instance_id/resume': 'tenant',
  'POST /api/v1/tenants/:tenant_id/module-instances/:instance_id/archive': 'tenant',
  'GET /api/v1/tenants/:tenant_id/application-installations': 'tenant',
  'GET /api/v1/tenants/:tenant_id/application-installations/by-operation/:operation_id': 'tenant',
  'POST /api/v1/tenants/:tenant_id/application-launch-plans': 'tenant',
  'POST /api/v1/tenants/:tenant_id/application-installations': 'tenant',
  'GET /api/v1/tenants/:tenant_id/operations/:operation_id': 'tenant',
  'POST /api/v1/tenants/:tenant_id/operations/:operation_id/reconcile': 'tenant',
  'POST /api/v1/tenants/:tenant_id/operations/:operation_id/cancel': 'tenant',
  'GET /api/v1/tenants/:tenant_id/workspaces/:workspace_id/launchpad-context': 'tenant',
  'GET /api/v1/tenants/:tenant_id/workspaces/:workspace_id/module-binding': 'tenant',
  'POST /api/v1/tenants/:tenant_id/workspaces/:workspace_id/works': 'tenant',
  'GET /api/v1/tenants/:tenant_id/workspaces/:workspace_id/works': 'tenant',
  'GET /api/v1/tenants/:tenant_id/works/:work_id': 'tenant',
  'PATCH /api/v1/tenants/:tenant_id/works/:work_id': 'tenant',
  'POST /api/v1/tenants/:tenant_id/works/:work_id/archive': 'tenant',
  'POST /api/v1/tenants/:tenant_id/works/:work_id/results/uploads': 'tenant',
  'GET /api/v1/tenants/:tenant_id/works/:work_id/results/uploads/:upload_id': 'tenant',
  'PUT /api/v1/tenants/:tenant_id/works/:work_id/results/uploads/:upload_id/content': 'tenant',
  'POST /api/v1/tenants/:tenant_id/works/:work_id/results/uploads/:upload_id/finalize': 'tenant',
  'GET /api/v1/tenants/:tenant_id/works/:work_id/results': 'tenant',
  'GET /api/v1/tenants/:tenant_id/works/:work_id/results/:result_id': 'tenant',
  'HEAD /api/v1/tenants/:tenant_id/works/:work_id/results/:result_id/content': 'tenant',
  'GET /api/v1/tenants/:tenant_id/works/:work_id/results/:result_id/content': 'tenant',
};
async function extraUser(name: string) {
  const id = randomUUID();
  const email = `tenant-${id}@example.test`;
  await owner.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,active,onboarding_required)
    SELECT $1,$2,$3,$4,password_hash,$5,true,false FROM users WHERE email=$6`,
  [id, DEMO_COMMUNITY, email, name, randomUUID(), DEMO_USERS[0].email]);
  return { id, email, session: await signIn(email) };
}

async function buildFixture() {
  const P = await signIn(DEMO_USERS[0].email);
  const O = await signIn(DEMO_USERS[1].email);
  const N = await signIn(DEMO_USERS[2].email);
  const W = (await extraUser('Synthetic W')).session;
  const M = (await extraUser('Synthetic M')).session;
  const I = (await extraUser('Synthetic I')).session;
  const F = (await extraUser('Synthetic F')).session;
  const Anon = undefined;
  const invitee = (await extraUser('Synthetic pending invitee')).session;

  const guild = 'guild_ai_field';
  const q = await owner.connect();
  try {
    const makeMember = async (s: Session, tier: 'intern' | 'full' | 'leader') => {
      const u = s.user.user_id;
      if (tier === 'leader') {
        await q.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier) VALUES($1,$2,$3,$4,'active','full')`, [randomUUID(), DEMO_COMMUNITY, u, guild]);
        await q.query(`INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) VALUES($1,$2,$3)`, [DEMO_COMMUNITY, guild, u]);
      } else {
        await q.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier) VALUES($1,$2,$3,$4,'active',$5)`, [randomUUID(), DEMO_COMMUNITY, u, guild, tier]);
      }
    };
    await makeMember(P, 'full');
    await makeMember(O, 'full');
    await makeMember(N, 'full');
    await makeMember(W, 'full');
    await makeMember(M, 'leader');
    await makeMember(I, 'intern');
    await makeMember(F, 'full');
  } finally {
    q.release();
  }

  async function verify(session: Session, tenantId: string, purpose: string) {
    const res = await post('/me/high-risk-verifications', session, { password: DEMO_PASSWORD, purpose, tenant_id: tenantId });
    assert.equal(res.status, 201, `verify ${purpose}: ${JSON.stringify(res.data)}`);
    assert.ok(res.data.verification_id, 'verification_id is empty');
    return res.data.verification_id as string;
  }

  async function getPrincipal(actor: Session, userId: string) {
    const found = await call('GET', `/tenants/invite-candidates?user_id=${userId}`, actor);
    assert.equal(found.status, 200, `getPrincipal: ${JSON.stringify(found.data)}`);
    assert.ok(found.data.principal_id, 'principal_id is empty');
    return found.data.principal_id as string;
  }

  async function createTenantData(session: Session, isB: boolean) {
    const t = await post('/tenants', session, { display_name: '同名空間', workspace_name: '主工作區' });
    assert.equal(t.status, 201, `create tenant: ${JSON.stringify(t.data)}`);
    const tenantId = t.data.tenant.tenant_id as string;
    const workspaceId = t.data.workspace.workspace_id as string;
    assert.ok(tenantId && workspaceId, 'tenantId or workspaceId is empty');
    const principalId = await getPrincipal(session, session.user.user_id);

    // Enable manual work
    const mw = await post(`/tenants/${tenantId}/workspaces/${workspaceId}/manual-work`, session, { guild_key: guild });
    assert.equal(mw.status, 200, `enable manual work: ${JSON.stringify(mw.data)}`);

    const extraWorkspace = await post(`/tenants/${tenantId}/workspaces`, session, { name: '主工作區' });
    assert.equal(extraWorkspace.status, 201, JSON.stringify(extraWorkspace.data));
    const extraInstance = await post(`/tenants/${tenantId}/workspaces/${extraWorkspace.data.workspace_id}/manual-work`, session,
      { guild_key: guild, choice: { kind: 'create_new' } });
    assert.equal(extraInstance.status, 200, JSON.stringify(extraInstance.data));
    assert.notEqual(extraInstance.data.instance_id, mw.data.instance_id);
    const extraInstanceId = extraInstance.data.instance_id as string;
    const extraDetail = await call('GET', `/tenants/${tenantId}/module-instances/${extraInstanceId}`, session);
    assert.equal(extraDetail.status, 200, JSON.stringify(describe(extraDetail)));
    const extraInstanceVersion = extraDetail.data.version as string;
    assert.match(extraInstanceVersion, /^[1-9][0-9]{0,18}$/);

    // Work
    const w = await post(`/tenants/${tenantId}/workspaces/${workspaceId}/works`, session, { title: '同名工作', objective: 'O', progress: 'todo' });
    assert.equal(w.status, 201, `create work: ${JSON.stringify(w.data)}`);
    const workId = w.data.resource_ref.resource_id as string;
    const workVersion = w.data.version as string;
    assert.ok(workId, 'workId is empty');

    // Upload & Finalize
    const noteBytes = Buffer.from(isB ? 'B-only-note' : 'A-only-note');
    const u1 = await post(`/tenants/${tenantId}/works/${workId}/results/uploads`, session, { content_type: 'text/plain', byte_size: noteBytes.byteLength, sha256: sha(noteBytes), display_name: 'same-name.md', expected_work_version: workVersion });
    assert.equal(u1.status, 201, `prepare upload: ${JSON.stringify(u1.data)}`);
    const uploadId = u1.data.resource_ref?.resource_id ?? u1.data.upload_id as string;
    const uploadVersion = u1.data.version as string;
    assert.ok(uploadId, 'uploadId is empty');

    const putRes = await call('PUT', `/tenants/${tenantId}/works/${workId}/results/uploads/${uploadId}/content`, session, noteBytes, { 'Idempotency-Key': randomUUID(), 'If-Match': `"${uploadVersion}"`, 'Content-Type': 'text/plain' });
    assert.equal(putRes.status, 200, `put upload: ${JSON.stringify(putRes.data)}`);
    const putVersion = putRes.data.version as string;

    const f1 = await post(`/tenants/${tenantId}/works/${workId}/results/uploads/${uploadId}/finalize`, session, { expected_work_version: workVersion }, `"${putVersion}"`);
    assert.equal(f1.status, 200, `finalize upload: ${JSON.stringify(f1.data)}`);
    const resultId = f1.data.resource_ref?.resource_id ?? f1.data.result_id as string;
    assert.ok(resultId, 'resultId is empty');

    // Fetch updated work version
    const updatedWork = await call('GET', `/tenants/${tenantId}/works/${workId}`, session);
    assert.equal(updatedWork.status, 200, `get work: ${JSON.stringify(updatedWork.data)}`);
    const updatedWorkVersion = updatedWork.data.version as string;

    // Prepared upload left unfinalized
    const u2 = await post(`/tenants/${tenantId}/works/${workId}/results/uploads`, session, { content_type: 'text/plain', byte_size: Buffer.byteLength('unfinalized'), sha256: sha(Buffer.from('unfinalized')), display_name: 'unfinalized.md', expected_work_version: updatedWorkVersion });
    assert.equal(u2.status, 201, `prepare upload 2: ${JSON.stringify(u2.data)}`);
    const unfinalizedUploadId = u2.data.resource_ref?.resource_id ?? u2.data.upload_id as string;
    assert.ok(unfinalizedUploadId, 'unfinalizedUploadId is empty');

    // Invitation (leave pending)
    const pI = await getPrincipal(session, invitee.user.user_id);
    const inv = await post(`/tenants/${tenantId}/invitations`, session, { invitee_principal_id: pI, role: 'viewer', instance_capabilities: [], expires_at: new Date(Date.now() + 86400000).toISOString() });
    assert.equal(inv.status, 201, `invite: ${JSON.stringify(inv.data)}`);
    const invitationId = inv.data.invitation_id as string;
    assert.ok(invitationId, 'invitationId is empty');

    // Launch plan, installation, operation
    const plan = await post(`/tenants/${tenantId}/application-launch-plans`, session, { guild_key: guild, workspace_id: workspaceId, application_key: 'synthetic-storefront', release_ref: 'synthetic-storefront@1.0.0', installation_choice: 'create_new', dependencies: [], configuration: {} });
    assert.equal(plan.status, 201, `create plan: ${JSON.stringify(plan.data)}`);
    const planId = plan.data.plan_id as string;
    const planVersion = plan.data.version as string;
    const planDigest = plan.data.configuration_digest;
    assert.ok(planId, 'planId is empty');

    const inst = await post(`/tenants/${tenantId}/application-installations`, session, { plan_id: planId, expected_plan_version: planVersion, configuration_digest: planDigest });
    assert.equal(inst.status, 202, `create installation: ${JSON.stringify(inst.data)}`);
    const operationId = inst.data.operation_id as string;
    assert.ok(operationId, 'operationId is empty');
    const instanceId = mw.data.instance_id as string;
    assert.ok(instanceId, 'manual-work instanceId is empty');
    const instance = await call('GET', `/tenants/${tenantId}/module-instances/${instanceId}`, session);
    assert.equal(instance.status, 200, JSON.stringify(describe(instance)));
    const instanceVersion = instance.data.version as string;
    assert.match(instanceVersion, /^[1-9][0-9]{0,18}$/);
    const lifecycleBefore = await instanceLifecycleSnapshot({ tenantId, instanceId });
    assert.equal(lifecycleBefore.instance.version, instanceVersion);
    assert.equal(lifecycleBefore.instance.status, 'active');
    assert.equal(lifecycleBefore.instance.suspension_operation_id, null);
    assert.equal(lifecycleBefore.instance.archive_operation_id, null);
    assert.equal(lifecycleBefore.instance.binding_state, 'active');
    assert.equal(lifecycleBefore.operations, 0);
    const installation = await call('GET', `/tenants/${tenantId}/application-installations/by-operation/${operationId}`, session);
    assert.equal(installation.status, 200, JSON.stringify(installation.data));
    const dependencyId = installation.data.modules.find((m: any) => m.requirement_key === 'inventory').instance_id as string;
    const scopeId = (await owner.query("SELECT scope_id FROM resource_scopes WHERE kind='tenant' AND tenant_ref=$1", [tenantId])).rows[0].scope_id as string;
    const resourceIds = new Set<string>();
    const collectIds = (value: unknown, key = '') => {
      if (/principal|user_id/.test(key)) return;
      if (typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value)) resourceIds.add(value);
      else if (Array.isArray(value)) value.forEach(child => collectIds(child));
      else if (value && typeof value === 'object') Object.entries(value).forEach(([childKey, child]) => collectIds(child, childKey));
    };
    for (const reply of [mw, extraWorkspace, extraInstance, extraDetail, w, u1, putRes, f1, u2, inv, plan, inst, instance, installation]) collectIds(reply.data);
    for (const id of [tenantId, workspaceId, instanceId, workId, resultId, uploadId, unfinalizedUploadId, invitationId, operationId, planId, dependencyId, installation.data.installation_id, scopeId]) assert.match(id, /^[0-9a-f-]{36}$/);
    const etags = [w.response.headers.get('etag'), u1.response.headers.get('etag'), f1.response.headers.get('etag'), inv.response.headers.get('etag')].filter(Boolean) as string[];

    return {
      tenantId, workspaceId, principalId, instanceId, instanceVersion, extraInstanceId, extraInstanceVersion, lifecycleBefore, workId, resultId, uploadId, unfinalizedUploadId, invitationId, transferId: "", operationId, operationVersion: inst.data.version as string, planId, planVersion, planDigest, dependencyId, installationId: installation.data.installation_id as string, scopeId, workVersion: updatedWorkVersion, uploadVersion,
      etags, versions: [workVersion, uploadVersion, f1.data.work_version, inv.data.version, planVersion, inst.data.version, instanceVersion].filter(Boolean) as string[],
      noteBytes, resourceIds: [...resourceIds]
    };
  }

  const A = await createTenantData(P, false);
  const B = await createTenantData(N, true);

  const soon = new Date(Date.now() + 86400000).toISOString();
  async function inviteAndAccept(from: Session, to: Session, tenantId: string, role: string) {
    const p = await getPrincipal(from, to.user.user_id);
    const res = await post(`/tenants/${tenantId}/invitations`, from, { invitee_principal_id: p, role, instance_capabilities: [], expires_at: soon });
    assert.equal(res.status, 201, `invite in inviteAndAccept: ${JSON.stringify(res.data)}`);
    const acc = await post(`/tenants/${tenantId}/invitations/${res.data.invitation_id}/accept`, to, {}, `"${res.data.version}"`);
    assert.equal(acc.status, 200, `accept invite: ${JSON.stringify(acc.data)}`);
  }

  await inviteAndAccept(P, O, A.tenantId, 'operator');
  await inviteAndAccept(P, W, A.tenantId, 'admin');
  await inviteAndAccept(N, P, B.tenantId, 'viewer');
  await inviteAndAccept(N, W, B.tenantId, 'admin');

  const mPrincipalId = await getPrincipal(P, M.user.user_id);
  const wPrincipalId = await getPrincipal(P, W.user.user_id);
  for (const [data, actor] of [[A, P], [B, N]] as const) {
    const vid = await verify(actor, data.tenantId, 'tenant.ownership.propose');
    const transfer = await post(`/tenants/${data.tenantId}/ownership-transfers`, actor, {
      to_principal_id: wPrincipalId, from_role_after: 'viewer', expires_at: soon, reason: 'synthetic transfer', fresh_auth_verification_id: vid,
    });
    assert.equal(transfer.status, 201, JSON.stringify(transfer.data));
    data.transferId = transfer.data.transfer_id;
    assert.ok(data.transferId);
  }
  return { A, B, mPrincipalId, people: { P, O, N, W, M, I, F, Anon } };
}

let fixture: Awaited<ReturnType<typeof buildFixture>>;

test('T-022 1. Route inventory guard', () => {
  const relevantPaths = /(tenants|tenant-|module-instances|application-|operations\/|manual-work|launchpad-context|works|results|applications|guilds\/[^/]+\/launchpad)/;
  const selectedRoutes = app.routes.filter(r => relevantPaths.test(r.path));
  const counts = Object.values(routeTable).reduce<Record<string, number>>((all, kind) => {
    all[kind] = (all[kind] ?? 0) + 1;
    return all;
  }, {});
  assert.deepEqual(counts, { admin: 7, guild: 9, principal: 8, global: 4, tenant: 56 });
  assert.equal(selectedRoutes.length, 84);
  console.log(JSON.stringify({ route_inventory: { selected: selectedRoutes.length, counts } }));
  for (const r of selectedRoutes) {
    const key = `${r.method} ${r.path}`;
    assert.ok(routeTable[key], `Missing route classification for ${key}`);
  }
  for (const key of Object.keys(routeTable)) {
    const [method, path] = key.split(' ');
    assert.ok(selectedRoutes.find(r => r.method === method && r.path === path), `Extraneous route classification for ${key}`);
  }
});

async function quiet(method: string, path: string) {
  const row = (await runtime.query(`SELECT pg_backend_pid() AS pid,
    current_setting('freedom.tenant_id', true) AS tenant,
    current_setting('freedom.principal_id', true) AS principal, current_setting('freedom.tenant_scope_id', true) AS scope,
    current_setting('freedom.platform_admin_id', true) AS admin`)).rows[0];
  const { pid, ...settings } = row;
  requestEvidence.push({ method, path, pid: Number(pid), settings });
  for (const [key, value] of Object.entries(settings)) assert.ok(value === null || value === '', `${key} context remained in the pool`);
}

function describe(reply: Reply) {
  return { status: reply.status, body: reply.data, headers: Object.fromEntries(reply.headers) };
}
function assertSameAsRandom(route: string, actor: string, real: Reply, random: Reply) {
  const message = `${route}, actor=${actor}, real=${JSON.stringify(describe(real))}, random=${JSON.stringify(describe(random))}`;
  assert.equal(real.status, random.status, message);
  assert.deepEqual(real.data, random.data, message);
  assert.equal(real.headers.get('cache-control'), random.headers.get('cache-control'), message);
  for (const reply of [real, random]) {
    assert.equal(reply.headers.has('etag'), false, message);
    assert.equal(reply.headers.has('location'), false, message);
  }
}

type Route = { method: string; path: string; body?: any; version?: string; isRaw?: boolean };
const routes: Route[] = [
  { method: 'GET', path: '/tenants/:tenant_id' },
  { method: 'POST', path: '/tenants/:tenant_id/edit', body: { display_name: 'new name', public_slug: null }, version: '"1"' },
  { method: 'GET', path: '/tenants/:tenant_id/members' },
  { method: 'POST', path: '/tenants/:tenant_id/members/:principal_id/change', body: { role: 'viewer', status: 'active', instance_capabilities: [], reason: 'synthetic change' }, version: '"1"' },
  { method: 'POST', path: '/tenants/:tenant_id/workspaces', body: { name: 'test ws' } },
  { method: 'GET', path: '/tenants/:tenant_id/workspaces' },
  { method: 'POST', path: '/tenants/:tenant_id/ownership-transfers', body: { to_principal_id: ':m_principal_id', from_role_after: 'viewer', expires_at: new Date(Date.now() + 86400000).toISOString(), reason: 'synthetic transfer', fresh_auth_verification_id: ':verify_propose' } },
  { method: 'GET', path: '/tenants/:tenant_id/ownership-transfers' },
  { method: 'GET', path: '/tenants/:tenant_id/ownership-transfers/:id' },
  { method: 'POST', path: '/tenants/:tenant_id/ownership-transfers/:id/accept', body: { accept_scope: true, fresh_auth_verification_id: ':verify_accept' }, version: '"1"' },
  { method: 'POST', path: '/tenants/:tenant_id/ownership-transfers/:id/cancel', body: { reason: 'synthetic cancel' } },
  { method: 'POST', path: '/tenants/:tenant_id/ownership-transfers/:id/decline', body: {} },
  { method: 'POST', path: '/tenants/:tenant_id/workspaces/:workspace_id/manual-work', body: { guild_key: 'guild_ai_field' } },
  { method: 'GET', path: '/tenants/:tenant_id/module-instances' },
  { method: 'GET', path: '/tenants/:tenant_id/module-instances/:instance_id' },
  { method: 'POST', path: '/tenants/:tenant_id/module-instances/:instance_id/suspend', body: { reason: 'synthetic suspend' }, version: ':instance_version' },
  { method: 'POST', path: '/tenants/:tenant_id/module-instances/:instance_id/resume', body: {}, version: ':instance_version' },
  { method: 'POST', path: '/tenants/:tenant_id/module-instances/:instance_id/archive', body: { reason: 'synthetic archive' }, version: ':instance_version' },
  { method: 'GET', path: '/tenants/:tenant_id/application-installations' },
  { method: 'GET', path: '/tenants/:tenant_id/application-installations/by-operation/:operation_id' },
  { method: 'POST', path: '/tenants/:tenant_id/application-launch-plans', body: { guild_key: 'guild_ai_field', workspace_id: ':workspace_id', application_key: 'synthetic-storefront', release_ref: 'synthetic-storefront@1.0.0', installation_choice: 'create_new', dependencies: [], configuration: {} } },
  { method: 'POST', path: '/tenants/:tenant_id/application-installations', body: { plan_id: ':plan_id', expected_plan_version: ':plan_version', configuration_digest: { algorithm: 'sha256', value: ':plan_digest' } } },
  { method: 'GET', path: '/tenants/:tenant_id/operations/:operation_id' },
  { method: 'POST', path: '/tenants/:tenant_id/operations/:operation_id/reconcile', body: {}, version: ':operation_version' },
  { method: 'POST', path: '/tenants/:tenant_id/operations/:operation_id/cancel', body: { reason: 'member_cancelled' }, version: ':operation_version' },
  { method: 'GET', path: '/tenants/:tenant_id/workspaces/:workspace_id/launchpad-context?guild_key=guild_ai_field' },
  { method: 'GET', path: '/tenants/:tenant_id/workspaces/:workspace_id/module-binding' },
  { method: 'POST', path: '/tenants/:tenant_id/workspaces/:workspace_id/works', body: { title: 'T', objective: 'O', progress: 'todo' } },
  { method: 'GET', path: '/tenants/:tenant_id/workspaces/:workspace_id/works' },
  { method: 'GET', path: '/tenants/:tenant_id/works/:work_id' },
  { method: 'PATCH', path: '/tenants/:tenant_id/works/:work_id', body: { title: 'new', objective: 'O', progress: 'todo' }, version: '"1"' },
  { method: 'POST', path: '/tenants/:tenant_id/works/:work_id/archive', body: {}, version: '"1"' },
  { method: 'GET', path: '/tenants/:tenant_id/works/:work_id/results' },
  { method: 'GET', path: '/tenants/:tenant_id/works/:work_id/results/:result_id' },
  { method: 'HEAD', path: '/tenants/:tenant_id/works/:work_id/results/:result_id/content', isRaw: true },
  { method: 'GET', path: '/tenants/:tenant_id/works/:work_id/results/:result_id/content', isRaw: true },
  { method: 'POST', path: '/tenants/:tenant_id/works/:work_id/results/uploads', body: { content_type: 'text/plain', byte_size: Buffer.byteLength('unfinalized'), sha256: sha(Buffer.from('unfinalized')), display_name: 'n.md', expected_work_version: ':work_version' } },
  { method: 'GET', path: '/tenants/:tenant_id/works/:work_id/results/uploads/:upload_id' },
  { method: 'PUT', path: '/tenants/:tenant_id/works/:work_id/results/uploads/:upload_id/content', body: Buffer.from('unfinalized'), version: '"1"', isRaw: true },
  { method: 'POST', path: '/tenants/:tenant_id/works/:work_id/results/uploads/:upload_id/finalize', body: { expected_work_version: ':work_version' }, version: '"1"' },
  { method: 'POST', path: '/tenants/:tenant_id/invitations', body: { invitee_principal_id: ':m_principal_id', role: 'viewer', instance_capabilities: [], expires_at: new Date(Date.now() + 86400000).toISOString() } },
  { method: 'POST', path: '/tenants/:tenant_id/invitations/:id/accept', body: {}, version: '"1"' },
  { method: 'POST', path: '/tenants/:tenant_id/invitations/:id/decline', body: {} },
  { method: 'POST', path: '/tenants/:tenant_id/invitations/:id/revoke', body: { reason: 'synthetic revoke' }, version: '"1"' },
  { method: 'POST', path: '/tenants/:tenant_id/leave', body: {}, version: '"1"' },
  { method: 'GET', path: '/tenants/:tenant_id/storefronts/:instance_id' },
  { method: 'POST', path: '/tenants/:tenant_id/storefronts/:instance_id/setup', body: { name: '商店', slug: 'matrix-shop', currency: 'TWD' } },
  { method: 'PATCH', path: '/tenants/:tenant_id/storefronts/:instance_id', body: { name: '更名' }, version: '"1"' },
  { method: 'GET', path: '/tenants/:tenant_id/storefronts/:instance_id/slug-availability?slug=matrix-shop' },
  { method: 'GET', path: '/tenants/:tenant_id/storefronts/:instance_id/products' },
  { method: 'POST', path: '/tenants/:tenant_id/storefronts/:instance_id/products', body: { title: '商品', price_minor: 100 } },
  { method: 'PATCH', path: '/tenants/:tenant_id/storefronts/:instance_id/products/:product_id', body: { title: '更名' }, version: '"1"' },
  { method: 'POST', path: '/tenants/:tenant_id/storefronts/:instance_id/products/:product_id/remove', body: {}, version: '"1"' },
  { method: 'GET', path: '/tenants/:tenant_id/storefronts/:instance_id/preview' },
  { method: 'POST', path: '/tenants/:tenant_id/storefronts/:instance_id/publish', body: {}, version: '"1"' },
  { method: 'POST', path: '/tenants/:tenant_id/storefronts/:instance_id/unpublish', body: {}, version: '"1"' },
];

test('T-022 Matrix route matching routeTable', () => {
  assert.deepEqual(routes.map(r => `${r.method} /api/v1${r.path.split('?')[0]}`).sort(),
    Object.entries(routeTable).filter(([, kind]) => kind === 'tenant').map(([key]) => key).sort());
});

type TenantData = Awaited<ReturnType<typeof buildFixture>>['A'];
function ids(data: TenantData, route: Route): Record<string, string> {
  return { tenant_id: data.tenantId, workspace_id: data.workspaceId, work_id: data.workId, result_id: data.resultId,
    upload_id: data.unfinalizedUploadId, id: route.path.includes('ownership-transfers') ? data.transferId : data.invitationId,
    principal_id: data.principalId, product_id: data.workId, instance_id: data.instanceId, operation_id: data.operationId, plan_id: data.planId,
    plan_version: data.planVersion, plan_digest: data.planDigest.value, operation_version: `"${data.operationVersion}"`, instance_version: `"${data.instanceVersion}"`,
    work_version: data.workVersion, m_principal_id: fixture.mPrincipalId, guild_key: 'guild_ai_field' };
}
async function verify(session: Session, tenantId: string, purpose: string) {
  const reply = await call('POST', '/me/high-risk-verifications', session,
    JSON.stringify({ password: DEMO_PASSWORD, purpose, tenant_id: tenantId }), { 'Content-Type': 'application/json' });
  assert.equal(reply.status, 201, `fresh verification: ${JSON.stringify(describe(reply))}`);
  assert.match(reply.data.verification_id, /^[0-9a-f-]{36}$/);
  return reply.data.verification_id as string;
}
async function requestBody(route: Route, session: Session | undefined, replacements: Record<string, string>, override?: any) {
  const original = override ?? route.body;
  if (original === undefined || Buffer.isBuffer(original)) return original;
  const replace = (value: any): any => {
    if (typeof value === 'string' && value.startsWith(':') && replacements[value.slice(1)]) return replacements[value.slice(1)];
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replace(child)]));
    return value;
  };
  const body = replace(original);
  if (body.fresh_auth_verification_id?.startsWith(':verify')) {
    const own = session === fixture.people.P ? fixture.A : session === fixture.people.N ? fixture.B : undefined;
    // Actors without an eligible owner/recipient context use a well-formed missing proof; their target gate runs first.
    body.fresh_auth_verification_id = own
      ? await verify(session!, own.tenantId, 'tenant.ownership.propose') : randomUUID();
  }
  return body;
}
function substitute(path: string, replacements: Record<string, string>) {
  const resolved = path.replace(/:([a-z_]+)/g, (_, key: string) => {
    assert.ok(replacements[key], `No substitution for ${key} in ${path}`);
    return replacements[key];
  });
  assert.equal(/:[a-z_]+/.test(resolved), false, `Unresolved path: ${resolved}`);
  return resolved;
}
async function execute(route: Route, session: Session | undefined, replacements: Record<string, string>, overrideBody?: any) {
  const body = await requestBody(route, session, replacements, overrideBody);
  const headers: Record<string, string> = {};
  if (route.version) {
    const data = replacements.tenant_id === fixture.A.tenantId ? fixture.A : fixture.B;
    headers['If-Match'] = route.version === '"1"' && /\/works\/:work_id(?:\/archive)?$/.test(route.path)
      ? `"${data.workVersion}"` : route.version.startsWith(':') ? replacements[route.version.slice(1)] : route.version;
  }
  if (['POST', 'PATCH', 'PUT'].includes(route.method)) headers['Idempotency-Key'] = randomUUID();
  if (body !== undefined) headers['Content-Type'] = route.isRaw ? 'text/plain' : 'application/json';
  return call(route.method, substitute(route.path, replacements), session,
    body === undefined ? undefined : route.isRaw ? body : JSON.stringify(body), headers);
}
async function pair(route: Route, actor: Session | undefined, realIds: Record<string, string>, randomIds: Record<string, string>) {
  const body = await requestBody(route, actor, realIds);
  return [await execute(route, actor, realIds, body), await execute(route, actor, randomIds, body)] as const;
}
function verifyHeaders(reply: Reply, method: string, path: string) {
  const cc = reply.headers.get('cache-control') ?? '';
  assert.ok(cc.includes('no-store'), `${method} ${path}: missing no-store (${cc})`);
  if (path.startsWith('/tenants/') && reply.status >= 200 && reply.status < 300) assert.ok(cc.includes('private'), `${method} ${path}: missing private`);
  if (method === 'GET' && path.endsWith('/content') && reply.status === 200) assert.match(reply.headers.get('content-disposition') ?? '', /attachment/);
}
function scanForLeaks(reply: Reply, context: string, other: TenantData, extra: string[] = []) {
  const raw = Buffer.from(reply.bytes).toString('utf8') + JSON.stringify(Object.fromEntries(reply.headers));
  const targets = [other.tenantId, other.workspaceId, other.instanceId, other.workId, other.resultId, other.uploadId,
    other.unfinalizedUploadId, other.invitationId, other.transferId, other.planId, other.operationId, other.installationId, other.dependencyId, Buffer.from(other.noteBytes).toString('utf8'), sha(other.noteBytes),
    Buffer.from(other.noteBytes).toString('base64'), Buffer.from(other.noteBytes).toString('hex'), ...other.resourceIds, ...extra];
  for (const target of targets.filter(Boolean)) assert.equal(raw.includes(target), false, `${context}: leaked ${target}; ${JSON.stringify(describe(reply))}`);
}

test('T-022 3a. Other tenant in the path', async () => {
  for (const route of routes) {
    for (const name of ['O', 'M', 'F', 'I', 'N'] as const) {
      const data = name === 'N' ? fixture.A : fixture.B;
      const realIds = ids(data, route);
      const replies = await pair(route, fixture.people[name], realIds, { ...realIds, tenant_id: randomUUID() });
      assertSameAsRandom(`${route.method} ${route.path}`, name, ...replies);
      for (const reply of replies) {
        assert.ok([403, 404, 405].includes(reply.status), `${route.path} ${name}: ${JSON.stringify(describe(reply))}`);
        scanForLeaks(reply, `3a ${route.method} ${route.path} ${name}`, data);
      }
    }
  }
});

test('T-022 3b. Own tenant in path, other tenant resource', async () => {
  for (const route of routes) {
    const positions = [...route.path.matchAll(/:([a-z_]+)/g)].map(m => m[1]).filter(key => key !== 'tenant_id');
    for (const position of positions) {
      for (const name of ['P', 'O'] as const) {
        const realIds = { ...ids(fixture.A, route), [position]: ids(fixture.B, route)[position] };
        const replies = await pair(route, fixture.people[name], realIds, { ...realIds, [position]: randomUUID() });
        assertSameAsRandom(`${route.method} ${route.path} position=${position}`, name, ...replies);
        for (const reply of replies) {
          assert.ok([403, 404, 405].includes(reply.status), JSON.stringify(describe(reply)));
          scanForLeaks(reply, `3b ${route.method} ${route.path} ${name} ${position}`, fixture.B);
        }
      }
    }
  }
});

test('T-022 3c. P as viewer of B', async () => {
  const selfService = /\/leave$|\/invitations\/:id\/(accept|decline)$|\/ownership-transfers\/:id\/(accept|decline)$/;
  for (const route of routes) {
    if (selfService.test(route.path)) continue;
    const realIds = ids(fixture.B, route);
    const reply = await execute(route, fixture.people.P, realIds);
    scanForLeaks(reply, `3c ${route.method} ${route.path} P`, fixture.A);
    if (route.method === 'GET' && ['/tenants/:tenant_id', '/tenants/:tenant_id/workspaces', '/tenants/:tenant_id/members'].includes(route.path)) {
      assert.equal(reply.status, 200, `${route.path}: ${JSON.stringify(describe(reply))}`);
      if (route.path.endsWith('/members')) {
        assert.equal(reply.data.items.length, 1);
        assert.equal(reply.data.items[0].principal_id, fixture.A.principalId);
        assert.equal(reply.data.items[0].role, 'viewer');
      } else assert.ok(JSON.stringify(reply.data).includes(fixture.B.tenantId));
    } else if (route.method === 'HEAD') {
      assert.equal(reply.status, 405, JSON.stringify(describe(reply)));
    } else if (/\/ownership-transfers\/:id|\/invitations\/:id\/revoke/.test(route.path) || route.method === 'GET' && route.path.endsWith('/ownership-transfers')) {
      assert.equal(reply.status, 404, `${route.method} ${route.path}: ${JSON.stringify(describe(reply))}`);
      const randomIds = Object.fromEntries(Object.entries(realIds).map(([key, value]) =>
        [key, ['id'].includes(key) ? randomUUID() : value]));
      const random = await execute(route, fixture.people.P, randomIds);
      assertSameAsRandom(`${route.method} ${route.path}`, 'P viewer recipient gate', reply, random);
      scanForLeaks(random, `3c ${route.path} random`, fixture.A);
    } else if (route.path.includes('/storefronts/')) {
      assert.equal(reply.status, 404, `${route.method} ${route.path}: ${JSON.stringify(describe(reply))}`);
      assert.equal(reply.data.code, 'not_found');
      const random = await execute(route, fixture.people.P, { ...realIds, instance_id: randomUUID() });
      assertSameAsRandom(`${route.method} ${route.path}`, 'P unreadable storefront gate', reply, random);
      scanForLeaks(random, `3c ${route.path} random`, fixture.A);
    } else {
      const code = /\/members|\/workspaces$|\/edit$|\/invitations$|\/ownership-transfers$/.test(route.path)
        ? 'tenant_capability_denied' : 'capability_denied';
      assert.equal(reply.status, 403, `${route.method} ${route.path}: ${JSON.stringify(describe(reply))}`);
      assert.equal(reply.data?.code, code, JSON.stringify(describe(reply)));
      const randomIds = Object.fromEntries(Object.entries(realIds).map(([key, value]) =>
        [key, key === 'tenant_id' || !route.path.includes(`:${key}`) ? value : randomUUID()]));
      const random = await execute(route, fixture.people.P, randomIds);
      assertSameAsRandom(`${route.method} ${route.path}`, 'P viewer capability gate', reply, random);
      scanForLeaks(random, `3c ${route.path} random`, fixture.A);
    }
  }
});

function nonTenantRoute(key: string): Route {
  const [method, fullPath] = key.split(' ');
  const path = fullPath.startsWith('/admin/') ? fullPath : fullPath.slice('/api/v1'.length);
  let body: any = undefined;
  let version: string | undefined;
  if (method === 'POST') {
    body = {};
    if (path === '/tenants') body = { display_name: '同名空間', workspace_name: '主工作區' };
    if (path.includes('tenant-recovery-cases')) {
      version = '"1"';
      if (path.endsWith('/tenant-recovery-cases')) { version = undefined; body = { tenant_id: fixture.A.tenantId, proposed_owner_principal_id: fixture.mPrincipalId, reason: 'synthetic recovery', evidence_ref: randomUUID() }; }
      if (path.endsWith('/approve')) body = { approved_scope: ['tenant.owner.restore'], expires_at: new Date(Date.now() + 60000).toISOString(), reason: 'synthetic review' };
      if (path.endsWith('/close')) body = { decision: 'cancelled', reason: 'synthetic close' };
      if (path.startsWith('/me/')) body = { accept_scope: true, fresh_auth_verification_id: randomUUID() };
    }
    if (path.endsWith('/review')) body = { decision: 'reject', reason: 'synthetic review' };
    if (path.includes('/launchpad-config')) {
      version = '"1"';
      const config = { schema_version: 'guild-launchpad.config/v1', guild_key: 'guild_ai_field', mission_override: null,
        blocks: ['mission','announcements','skill_books','applications','community_tasks','my_work','support'].map((kind, order) => ({ id: kind, kind, order, enabled: true, title: null })),
        application_refs: [], starter: { title_label: '', objective_hint: '', note_hint: '' }, support: { kind: 'platform_help', public_url: null }, extensions: {} };
      body = { body: config };
      if (path.endsWith('/preview')) { body = { body: config, preview_mode: 'member' }; version = undefined; }
      if (path.endsWith('/publish')) body = { expected_body_sha256: 'ab'.repeat(32) };
      if (path.endsWith('/revert')) body = { to_revision: '1', reason: 'synthetic revert' };
    }
    if (path.endsWith('/launchpad-delegations')) body = { principal_id: fixture.mPrincipalId, capabilities: ['guild.content.edit'], expires_at: new Date(Date.now() + 60000).toISOString() };
    if (path.endsWith('/revoke')) { body = { reason: 'synthetic revoke' }; version = '"1"'; }
  }
  return { method, path: path === '/tenants/invite-candidates' ? `${path}?user_id=${fixture.people.M.user.user_id}` : path, body, version };
}
test('T-022 3d. Anonymous', async () => {
  for (const [key, kind] of Object.entries(routeTable)) {
    if (!['tenant', 'principal', 'admin', 'guild'].includes(kind) || key.includes('/public/')) continue;
    const route = kind === 'tenant' ? routes.find(r => `${r.method} /api/v1${r.path.split('?')[0]}` === key)! : nonTenantRoute(key);
    const realIds = { ...ids(fixture.A, route), config_id: randomUUID(), delegation_id: fixture.A.invitationId };
    const randomIds = Object.fromEntries(Object.keys(realIds).map(key => [key, key === 'guild_key' ? 'guild_random' : randomUUID()]));
    const replies = await pair(route, undefined, realIds, randomIds);
    assertSameAsRandom(key, 'Anonymous', ...replies);
    assert.ok([401, 403].includes(replies[0].status), `${key}: ${JSON.stringify(describe(replies[0]))}`);
    for (const reply of replies) { scanForLeaks(reply, `3d ${key}`, fixture.A); scanForLeaks(reply, `3d ${key}`, fixture.B); }
  }
});

test('T-022 3e. Denied instance lifecycle commands left both tenants unchanged', async () => {
  for (const [tenant, data] of [['A', fixture.A], ['B', fixture.B]] as const) {
    const after = await instanceLifecycleSnapshot(data);
    assert.deepEqual(after, data.lifecycleBefore, `${tenant}: denied lifecycle commands changed tenant state`);
    assert.equal(after.instance.archive_operation_id, null);
    assert.equal(after.instance.status, 'active');
    assert.equal(after.instance.binding_state, 'active');
    assert.equal(after.operations, 0, `${tenant}: denied lifecycle commands created operations`);
    console.log(JSON.stringify({ lifecycle_denials_unchanged: { tenant, before: data.lifecycleBefore, after } }));
  }
});

async function instanceLifecycleSnapshot(data: { tenantId: string; instanceId: string }) {
  const instance = (await owner.query<{ status: string; version: string; suspension_operation_id: string | null; archive_operation_id: string | null; binding_state: string }>(
    `SELECT i.status, i.version::text AS version, i.suspension_operation_id, i.archive_operation_id, d.state AS binding_state
     FROM module_instances i JOIN deployment_bindings d
       ON d.tenant_id=i.tenant_id AND d.instance_id=i.instance_id AND d.binding_id=i.binding_id
     WHERE i.tenant_id=$1 AND i.instance_id=$2`, [data.tenantId, data.instanceId],
  )).rows[0];
  assert.ok(instance, 'Manual-work instance and current deployment must exist');
  const operations = (await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM module_provision_operations
     WHERE tenant_id=$1 AND operation_kind IN ('module.instance.suspend','module.instance.resume','module.instance.archive')`, [data.tenantId],
  )).rows[0].n;
  return { instance, operations };
}

async function tenantArchiveSnapshot(data: TenantData) {
  const main = await instanceLifecycleSnapshot(data);
  const extra = await instanceLifecycleSnapshot({ tenantId: data.tenantId, instanceId: data.extraInstanceId });
  const installations = (await owner.query<{ installation_id: string; status: string; version: string; uses_extra_instance: boolean }>(
    `SELECT i.installation_id, i.status, i.version::text AS version,
       EXISTS (SELECT 1 FROM application_module_links l
         WHERE l.tenant_id=i.tenant_id AND l.installation_id=i.installation_id AND l.instance_id=$2) AS uses_extra_instance
     FROM application_installations i WHERE i.tenant_id=$1 ORDER BY i.installation_id`,
    [data.tenantId, data.extraInstanceId],
  )).rows;
  return { main, extra, installations };
}

async function count(table: string, tenantId: string, column = 'tenant_id') {
  assert.match(table, /^[a-z_]+$/); assert.match(column, /^[a-z_]+$/);
  return (await owner.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column}=$1`, [tenantId])).rows[0].n as number;
}
async function secondResult(data: TenantData, actor: Session) {
  const work = await call('GET', `/tenants/${data.tenantId}/works/${data.workId}`, actor);
  assert.equal(work.status, 200, JSON.stringify(describe(work)));
  const prepared = await post(`/tenants/${data.tenantId}/works/${data.workId}/results/uploads`, actor,
    { content_type: 'text/plain', byte_size: data.noteBytes.length, sha256: sha(data.noteBytes), display_name: 'same-name.md', expected_work_version: work.data.version });
  assert.equal(prepared.status, 201, JSON.stringify(describe(prepared)));
  const uploadId = prepared.data.resource_ref.resource_id;
  const written = await call('PUT', `/tenants/${data.tenantId}/works/${data.workId}/results/uploads/${uploadId}/content`, actor, data.noteBytes,
    { 'Content-Type': 'text/plain', 'Idempotency-Key': randomUUID(), 'If-Match': `"${prepared.data.version}"` });
  assert.equal(written.status, 200, JSON.stringify(describe(written)));
  const finalized = await post(`/tenants/${data.tenantId}/works/${data.workId}/results/uploads/${uploadId}/finalize`, actor,
    { expected_work_version: work.data.version }, `"${written.data.version}"`);
  assert.equal(finalized.status, 200, JSON.stringify(describe(finalized)));
  const current = await call('GET', `/tenants/${data.tenantId}/works/${data.workId}`, actor);
  assert.equal(current.status, 200, JSON.stringify(describe(current)));
  data.workVersion = current.data.version;
}

test('T-022 4. Body, header and query substitution', async () => {
  const { A, B, people: { P, N } } = fixture;
  const routerMissing = await call('GET', '/surely-not-a-route', P);
  const outcomes: Record<string, any> = {};
  const freshWorkspace = await post(`/tenants/${A.tenantId}/workspaces`, P, { name: '主工作區' });
  assert.equal(freshWorkspace.status, 201, JSON.stringify(describe(freshWorkspace)));
  scanForLeaks(freshWorkspace, '4 setup workspace', B);
  async function compare(label: string, route: Route, realBody: any, randomBody: any) {
    const real = await execute(route, P, ids(A, route), realBody);
    const random = await execute(route, P, ids(A, route), randomBody);
    assert.notDeepEqual(describe(real), describe(routerMissing), `${label} hit router 404`);
    assertSameAsRandom(label, 'P', real, random);
    assert.ok(real.status >= 400, `${label} accepted B ref: ${JSON.stringify(describe(real))}`);
    for (const reply of [real, random]) scanForLeaks(reply, `4 ${label}`, B);
    outcomes[label] = { status: real.status, code: real.data?.code };
  }
  const manual = { ...routes.find(r => r.path.endsWith('/manual-work'))!, path: `/tenants/:tenant_id/workspaces/${freshWorkspace.data.workspace_id}/manual-work` };
  await compare('manual reuse', manual, { guild_key: 'guild_ai_field', choice: { kind: 'reuse', instance_id: B.instanceId, expected_version: '1' } },
    { guild_key: 'guild_ai_field', choice: { kind: 'reuse', instance_id: randomUUID(), expected_version: '1' } });
  const plan = routes.find(r => r.path.endsWith('/application-launch-plans'))!;
  const planBody = { ...plan.body, workspace_id: A.workspaceId };
  await compare('plan workspace', plan, { ...planBody, workspace_id: B.workspaceId }, { ...planBody, workspace_id: randomUUID() });
  await compare('plan dependency', plan, { ...planBody, workspace_id: freshWorkspace.data.workspace_id, dependencies: [{ requirement_key: 'inventory', choice: 'reuse', instance_id: B.dependencyId, expected_version: '1' }] },
    { ...planBody, workspace_id: freshWorkspace.data.workspace_id, dependencies: [{ requirement_key: 'inventory', choice: 'reuse', instance_id: randomUUID(), expected_version: '1' }] });
  await compare('existing installation', plan, { ...planBody, installation_choice: 'reuse_existing', existing_installation_id: B.installationId },
    { ...planBody, installation_choice: 'reuse_existing', existing_installation_id: randomUUID() });
  const installation = routes.find(r => r.method === 'POST' && r.path.endsWith('/application-installations'))!;
  await compare('installation plan', installation, { ...installation.body, plan_id: B.planId, expected_plan_version: B.planVersion, configuration_digest: B.planDigest },
    { ...installation.body, plan_id: randomUUID(), expected_plan_version: B.planVersion, configuration_digest: B.planDigest });

  // Principal ids are platform-wide. A real B owner may be invited into A, but an unknown person may not.
  const invited = await post(`/tenants/${A.tenantId}/invitations`, P, { invitee_principal_id: B.principalId, role: 'viewer', instance_capabilities: [], expires_at: new Date(Date.now() + 60000).toISOString() });
  assert.equal(invited.status, 201, JSON.stringify(describe(invited)));
  scanForLeaks(invited, '4 platform principal invitation', B);
  const missingPerson = await post(`/tenants/${A.tenantId}/invitations`, P, { invitee_principal_id: randomUUID(), role: 'viewer', instance_capabilities: [], expires_at: new Date(Date.now() + 60000).toISOString() });
  assert.equal(missingPerson.status, 404, JSON.stringify(describe(missingPerson)));
  scanForLeaks(missingPerson, '4 random principal invitation', B);
  const cancelled = await post(`/tenants/${A.tenantId}/ownership-transfers/${A.transferId}/cancel`, P, { reason: 'synthetic cancel' });
  assert.equal(cancelled.status, 200, JSON.stringify(describe(cancelled)));
  scanForLeaks(cancelled, '4 own transfer cancellation', B);
  const transferBody = { to_principal_id: B.principalId, from_role_after: 'viewer', expires_at: new Date(Date.now() + 60000).toISOString(), reason: 'synthetic transfer', fresh_auth_verification_id: await verify(P, A.tenantId, 'tenant.ownership.propose') };
  const proposed = await post(`/tenants/${A.tenantId}/ownership-transfers`, P, transferBody);
  assert.equal(proposed.status, 201, JSON.stringify(describe(proposed)));
  scanForLeaks(proposed, '4 platform principal transfer', B);
  const cleared = await post(`/tenants/${A.tenantId}/ownership-transfers/${proposed.data.transfer_id}/cancel`, P, { reason: 'synthetic cancel' });
  assert.equal(cleared.status, 200, JSON.stringify(describe(cleared)));
  scanForLeaks(cleared, '4 new transfer cancellation', B);
  const unknownRecipient = await post(`/tenants/${A.tenantId}/ownership-transfers`, P, { ...transferBody, to_principal_id: randomUUID(), fresh_auth_verification_id: await verify(P, A.tenantId, 'tenant.ownership.propose') });
  assert.equal(unknownRecipient.status, 404, JSON.stringify(describe(unknownRecipient)));
  scanForLeaks(unknownRecipient, '4 random principal transfer', B);

  await secondResult(B, N);
  const extraWork = await post(`/tenants/${B.tenantId}/workspaces/${B.workspaceId}/works`, N, { title: '同名工作', objective: 'O', progress: 'todo' });
  assert.equal(extraWork.status, 201, JSON.stringify(describe(extraWork)));
  for (const [label, pathA, pathB] of [
    ['Work cursor', `/tenants/${A.tenantId}/workspaces/${A.workspaceId}/works`, `/tenants/${B.tenantId}/workspaces/${B.workspaceId}/works`],
    ['Result cursor', `/tenants/${A.tenantId}/works/${A.workId}/results`, `/tenants/${B.tenantId}/works/${B.workId}/results`],
  ]) {
    const page = await call('GET', `${pathB}?limit=1`, N);
    assert.equal(page.status, 200, JSON.stringify(describe(page)));
    assert.equal(typeof page.data.next_cursor, 'string', `${label} did not produce a cursor`);
    assert.ok(page.data.next_cursor.length);
    const nextPage = await call('GET', `${pathB}?limit=1&cursor=${encodeURIComponent(page.data.next_cursor)}`, N);
    assert.equal(nextPage.status, 200, `${label} own cursor: ${JSON.stringify(describe(nextPage))}`);
    assert.equal(nextPage.data.items.length, 1);
    assert.notDeepEqual(nextPage.data.items[0], page.data.items[0]);
    scanForLeaks(nextPage, `4 ${label} own cursor`, A);
    const wrongCaller = await call('GET', `${pathB}?cursor=${encodeURIComponent(page.data.next_cursor)}`, fixture.people.W);
    assert.equal(wrongCaller.status, 422, `${label} wrong caller: ${JSON.stringify(describe(wrongCaller))}`);
    assert.equal(wrongCaller.data.code, 'invalid_cursor');
    scanForLeaks(wrongCaller, `4 ${label} wrong caller`, A);
    const wrongScopePath = label === 'Work cursor' ? `${pathB}?q=other&cursor=${encodeURIComponent(page.data.next_cursor)}`
      : `/tenants/${B.tenantId}/works/${extraWork.data.resource_ref.resource_id}/results?cursor=${encodeURIComponent(page.data.next_cursor)}`;
    const wrongScope = await call('GET', wrongScopePath, N);
    assert.equal(wrongScope.status, 422, `${label} wrong filter or Work: ${JSON.stringify(describe(wrongScope))}`);
    assert.equal(wrongScope.data.code, 'invalid_cursor');
    scanForLeaks(wrongScope, `4 ${label} wrong filter or Work`, A);
    const replies = [await call('GET', `${pathA}?cursor=${encodeURIComponent(page.data.next_cursor)}`, P), await call('GET', `${pathA}?cursor=invalid`, P)] as const;
    assertSameAsRandom(label, 'P', ...replies);
    assert.equal(replies[0].status, 422, JSON.stringify(describe(replies[0])));
    for (const reply of replies) scanForLeaks(reply, `4 ${label}`, B);
  }
  const finalize = routes.find(r => r.path.endsWith('/finalize'))!;
  await compare('expected work version', { ...finalize, version: `"${A.uploadVersion}"` }, { expected_work_version: B.workVersion }, { expected_work_version: '999' });

  const otherGuild = (await owner.query(`SELECT guild_key FROM positioning_guild_catalog c WHERE NOT EXISTS
    (SELECT 1 FROM positioning_profession_memberships m WHERE m.guild_key=c.guild_key AND m.user_id=$1 AND m.state='active') ORDER BY guild_key LIMIT 1`, [P.user.user_id])).rows[0].guild_key as string;
  const contextPath = `/tenants/${A.tenantId}/workspaces/${A.workspaceId}/launchpad-context`;
  const guildReal = await call('GET', `${contextPath}?guild_key=${otherGuild}`, P);
  const guildRandom = await call('GET', `${contextPath}?guild_key=guild_random`, P);
  // SP-03 permits guild context metadata; tenant capability still controls this read.
  assert.equal(guildReal.status, 200, JSON.stringify(describe(guildReal)));
  assert.equal(guildReal.data.tenant_id, A.tenantId);
  assert.equal(guildReal.data.workspace_id, A.workspaceId);
  assert.equal(guildRandom.status, 404, JSON.stringify(describe(guildRandom)));
  assert.equal(guildRandom.data.code, 'guild_not_found');
  for (const reply of [guildReal, guildRandom]) scanForLeaks(reply, '4 guild_key', B);
  outcomes.guild_key = { key: otherGuild, real: describe(guildReal), random: describe(guildRandom), comparison: 'stopped: guild context metadata is not a tenant reference' };

  const workB = await call('GET', `/tenants/${B.tenantId}/works/${B.workId}`, N);
  assert.equal(workB.status, 200, JSON.stringify(describe(workB)));
  const update = routes.find(r => r.method === 'PATCH')!;
  const matched = await execute({ ...update, version: workB.headers.get('etag')! }, P, ids(A, update));
  assert.equal(matched.status, A.workVersion === B.workVersion ? 200 : 412, JSON.stringify(describe(matched)));
  scanForLeaks(matched, '4 B ETag on A', B);
  const stale = await execute({ ...update, version: '"999"' }, P, ids(A, update));
  assert.equal(stale.status, 412, JSON.stringify(describe(stale)));
  scanForLeaks(stale, '4 stale A ETag', B);

  const workspace = await post(`/tenants/${A.tenantId}/workspaces`, P, { name: '主工作區' });
  assert.equal(workspace.status, 201, JSON.stringify(describe(workspace)));
  const candidates = await post(`/tenants/${A.tenantId}/workspaces/${workspace.data.workspace_id}/manual-work`, P, { guild_key: 'guild_ai_field' });
  assert.equal(candidates.status, 409, JSON.stringify(describe(candidates)));
  assert.equal(candidates.data.code, 'instance_selection_required');
  assert.ok(candidates.data.candidates.length);
  for (const candidate of candidates.data.candidates) {
    const row = (await owner.query('SELECT tenant_id FROM module_instances WHERE instance_id=$1', [candidate.instance_id])).rows[0];
    assert.equal(row?.tenant_id, A.tenantId);
  }
  scanForLeaks(candidates, '4 candidates', B);
  for (const actor of [P, N, fixture.people.O, fixture.people.M]) {
    const launchpad = await call('GET', '/guilds/guild_ai_field/launchpad', actor);
    assert.equal(launchpad.status, 200, JSON.stringify(describe(launchpad)));
    const other = actor === N ? A : B;
    scanForLeaks(launchpad, '4 launchpad eligibility', other);
    const manages = actor === P || actor === N;
    const expectedApplications = ['manual-workspace', 'hosted-store', 'synthetic-storefront'].map(application_key => ({
      application_key, release_ref: `${application_key}@1.0.0`,
      display_name: application_key === 'manual-workspace' ? '人工工作空間' : application_key === 'hosted-store' ? '線上商店' : '合成店面',
      eligibility: { can_launch: manages, reason_codes: manages ? [] : ['tenant_manage_required'],
        policy_revision: '1', required_guild_tier: 'full', tenant_action: manages ? (application_key === 'hosted-store' ? 'select' : 'continue') : 'create' },
    }));
    assert.deepEqual(launchpad.data.applications, expectedApplications);
    const substituted = await call('GET', `/guilds/guild_ai_field/launchpad?tenant_id=${other.tenantId}&workspace_id=${other.workspaceId}`, actor);
    assert.equal(substituted.status, 200, JSON.stringify(describe(substituted)));
    assert.deepEqual(substituted.data.applications, expectedApplications);
    scanForLeaks(substituted, '4 substituted launchpad eligibility', other);
  }
  console.log(JSON.stringify({ item4: outcomes }));
});

function changedCursor(raw: string, changes: Record<string, unknown>) {
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  return Buffer.from(JSON.stringify({ ...JSON.parse(decoded), ...changes })).toString('base64url');
}

async function invalidCursor(path: string, cursor: string, actor?: Session) {
  const separator = path.includes('?') ? '&' : '?';
  const url = `${origin}/api/v1${path}${separator}cursor=${encodeURIComponent(cursor)}`;
  const response = await app.request(url, { headers: actor ? { Cookie: actor.cookie } : {} });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const reply: Reply = { status: response.status, data: JSON.parse(Buffer.from(bytes).toString('utf8')), response, bytes, headers: response.headers };
  await quiet('GET', path);
  console.log(JSON.stringify({ cursor_rejection: path.split('?')[0], status: reply.status, code: reply.data?.code }));
  assert.equal(reply.status, 422, `${path}: ${JSON.stringify(describe(reply))}`);
  assert.equal(reply.data.code, 'invalid_cursor');
  if (path.startsWith('/tenants/')) verifyHeaders(reply, 'GET', path);
}

async function cursorPage(path: string, actor?: Session) {
  const response = await app.request(`${origin}/api/v1${path}`, { headers: actor ? { Cookie: actor.cookie } : {} });
  const data = await response.json() as any;
  assert.equal(response.status, 200, JSON.stringify(data));
  await quiet('GET', path);
  return data;
}

async function walkPages(path: string, actor: Session | undefined, id: string) {
  const separator = path.includes('?') ? '&' : '?';
  const expected = await cursorPage(`${path}${separator}limit=50`, actor);
  assert.equal(expected.next_cursor, null, `${path}: fixture exceeds the reference page`);
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await cursorPage(`${path}${separator}limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, actor);
    seen.push(...page.items.map((item: any) => item[id]));
    assert.equal(new Set(seen).size, seen.length, `${path} repeated a row`);
    assert.ok(seen.length <= expected.items.length, `${path} never ended`);
    cursor = page.next_cursor;
  } while (cursor);
  assert.deepEqual(seen, expected.items.map((item: any) => item[id]), `${path} omitted or reordered a row`);
}

test('T-022 4a. Same admin cursors reject tenant, workspace, caller and registry filter changes', async t => {
  const { A, B, people: { W, N } } = fixture;
  const workspace = await post(`/tenants/${A.tenantId}/workspaces`, W, { name: '游標工作區' });
  assert.equal(workspace.status, 201);
  const extra = await post(`/tenants/${B.tenantId}/workspaces/${B.workspaceId}/works`, W, { title: '分頁工作', objective: 'O', progress: 'todo' });
  assert.equal(extra.status, 201);
  await secondResult(B, N);
  for (const [label, pathA, pathB, filters, id] of [
    ['Work', `/tenants/${A.tenantId}/workspaces/${A.workspaceId}/works`, `/tenants/${B.tenantId}/workspaces/${B.workspaceId}/works`, [], 'work_id'],
    ['Result', `/tenants/${A.tenantId}/works/${A.workId}/results`, `/tenants/${B.tenantId}/works/${B.workId}/results`, [], 'result_id'],
    ['instances', `/tenants/${A.tenantId}/module-instances`, `/tenants/${B.tenantId}/module-instances`, ['module_key=work', 'status=active'], 'instance_id'],
    ['installations', `/tenants/${A.tenantId}/application-installations`, `/tenants/${B.tenantId}/application-installations`, ['application_key=manual-workspace', `workspace_id=${B.workspaceId}`], 'installation_id'],
  ] as const) {
    const page = await cursorPage(`${pathB}?limit=1`, W);
    assert.ok(page.next_cursor, `${label} did not mint a cursor`);
    await t.test(`${label}: same admin across tenants`, () => invalidCursor(pathA, page.next_cursor, W));
    if (label === 'instances' || label === 'installations') {
      await t.test(`${label}: unexpected cursor field`, () => invalidCursor(pathB, changedCursor(page.next_cursor, { unexpected: true }), W));
      await t.test(`${label}: missing cursor field`, async () => {
        const missing = JSON.parse(Buffer.from(page.next_cursor, 'base64url').toString('utf8'));
        delete missing.filter;
        await invalidCursor(pathB, Buffer.from(JSON.stringify(missing)).toString('base64url'), W);
      });
      await t.test(`${label}: different caller`, () => invalidCursor(pathB, page.next_cursor, N));
      await t.test(`${label}: authorization precedes cursor validation`, async () => {
        for (const [actor, status, code] of [
          [fixture.people.O, 403, 'capability_denied'],
          [fixture.people.F, 404, 'tenant_not_found'],
        ] as const) {
          const reply = await call('GET', `${pathA}?cursor=invalid`, actor);
          assert.equal(reply.status, status, JSON.stringify(describe(reply)));
          assert.equal(reply.data.code, code);
          scanForLeaks(reply, '4a cursor authorization', B);
        }
      });

      for (const filter of filters) {
        await walkPages(`${pathB}?${filter}`, W, id);
        await t.test(`${label}: changed ${filter.split('=')[0]}`, () => invalidCursor(`${pathB}?${filter}`, page.next_cursor, W));
      }
    }
    await walkPages(pathB, W, id);
  }
  const path = `/tenants/${A.tenantId}/workspaces/${A.workspaceId}/works`;
  // A fixture has one Work until item 6; add one so a real A cursor is available independently.
  const created = await post(path, W, { title: '工作區游標', objective: 'O', progress: 'todo' });
  assert.equal(created.status, 201);
  const page = await cursorPage(`${path}?limit=1`, W);
  assert.ok(page.next_cursor);
  await t.test('Work: same admin across workspaces of one tenant', () =>
    invalidCursor(`/tenants/${A.tenantId}/workspaces/${workspace.data.workspace_id}/works`, page.next_cursor, W));
});

test('T-022 4b. Catalog cursors bind guild absence and reject PostgreSQL int overflow', async t => {
  // A second platform offering makes every catalog list issue real cursors.
  await owner.query(`INSERT INTO application_definitions(
    application_key, release_ref, display_name, source_commit, artifact_digest, skill_book_refs,
    module_requirements, entry_capability, runtime_profiles, launch_policy_ref, license_state,
    release_status, customization_schema_ref, license_review_ref, version)
    SELECT 'synthetic-public', 'synthetic-public@1.0.0', display_name, source_commit, artifact_digest, skill_book_refs,
      module_requirements, entry_capability, runtime_profiles, launch_policy_ref, license_state,
      release_status, customization_schema_ref, license_review_ref, version
    FROM application_definitions WHERE application_key='manual-workspace'`);
  await owner.query(`INSERT INTO guild_application_offerings(offering_id, application_key, release_ref, status, display_order, launch_policy_ref, version)
    SELECT $1, application_key, release_ref, 'offered', 20, launch_policy_ref, 1
    FROM application_definitions WHERE application_key='synthetic-public'`, [randomUUID()]);
  const { people: { P, N } } = fixture;
  const guildPath = '/applications?guild_key=guild_ai_field';
  const plain = await cursorPage('/applications?limit=1');
  const guild = await cursorPage(`${guildPath}&limit=1`);
  const member = await cursorPage(`${guildPath}&limit=1`, P);
  assert.ok(plain.next_cursor && guild.next_cursor && member.next_cursor, 'Catalog did not mint a cursor');
  const plainCursor = plain.next_cursor as string;
  await t.test('catalog: no guild to guild', () => invalidCursor(guildPath, plainCursor));
  await t.test('catalog: guild to no guild', () => invalidCursor('/applications', guild.next_cursor));
  await t.test('catalog: unexpected cursor field', () => invalidCursor('/applications', changedCursor(plainCursor, { unexpected: true })));
  await t.test('catalog: missing cursor field', async () => {
    const missing = JSON.parse(Buffer.from(plainCursor, 'base64url').toString('utf8'));
    delete missing.filter;
    await invalidCursor('/applications', Buffer.from(JSON.stringify(missing)).toString('base64url'));
  });
  for (const [label, changes] of [
    ['oversized order', { order: 99999999999 }],
    ['negative order', { order: -1 }],
    ['fractional order', { order: 0.5 }],
    ['string order', { order: '1' }],
    ['invalid platform', { platform: 2 }],
    ['invalid id', { id: 'invalid' }],
  ] as const) {
    await t.test(`catalog: ${label}`, () => invalidCursor('/applications', changedCursor(plainCursor, changes)));
  }
  for (const [label, cursor] of [
    ['bad base64', `${plainCursor}!`],
    ['bad JSON', Buffer.from('{').toString('base64url')],
    ['null envelope', Buffer.from('null').toString('base64url')],
    ['array envelope', Buffer.from(`[${Buffer.from(plainCursor, 'base64url').toString('utf8')}]`).toString('base64url')],
    ['scalar envelope', Buffer.from('1').toString('base64url')],
    ['legacy overflow cursor', Buffer.from(`0\n99999999999\n${randomUUID()}`).toString('base64url')],
  ]) {
    await t.test(`catalog: ${label}`, () => invalidCursor('/applications', cursor));
  }
  await t.test('catalog: member to anonymous with the same guild', () => invalidCursor(guildPath, member.next_cursor));
  await t.test('catalog: anonymous to member with the same guild', () => invalidCursor(guildPath, guild.next_cursor, P));
  // No guild uses no community predicate; same-community members share a global guild list.
  await t.test('catalog: no guild cursor works for a member', () =>
    cursorPage(`/applications?cursor=${encodeURIComponent(plainCursor)}`, P));
  await t.test('catalog: member cursor works for another member in the same community', () =>
    cursorPage(`${guildPath}&cursor=${encodeURIComponent(member.next_cursor)}`, N));
  await walkPages('/applications', undefined, 'release_ref');
  await walkPages(guildPath, undefined, 'release_ref');
  await walkPages(guildPath, P, 'release_ref');
});

test('T-022 4c. Work and registry cursors reject noncanonical and impossible timestamps', async t => {
  const { B, people: { W } } = fixture;
  for (const path of [
    `/tenants/${B.tenantId}/workspaces/${B.workspaceId}/works`,
    `/tenants/${B.tenantId}/module-instances`,
    `/tenants/${B.tenantId}/application-installations`,
  ]) {
    const page = await cursorPage(`${path}?limit=1`, W);
    assert.ok(page.next_cursor);
    await t.test(`${path.split('/').at(-1)}: valid leap day and microseconds`, () =>
      cursorPage(`${path}?cursor=${changedCursor(page.next_cursor, { at: '2024-02-29T12:00:00.123456Z' })}`, W));
    for (const at of ['1', '0000-01-01T00:00:00.000000Z', '2026-02-30T12:00:00.000000Z', '2026-01-01T24:00:00.000000Z', '2026-01-01T00:00:00.000Z']) {
      await t.test(`${path.split('/').at(-1)}: ${at}`, () => invalidCursor(path, changedCursor(page.next_cursor, { at }), W));
    }
  }
});

test('T-022 6. Idempotency across tenants', async () => {
  const { A, B, people: { W } } = fixture;
  // Use new Works with equal versions so both requests send exactly the same upload body.
  const workIds: string[] = [];
  for (const data of [A, B]) {
    const work = await post(`/tenants/${data.tenantId}/workspaces/${data.workspaceId}/works`, W, { title: '同名工作', objective: 'O', progress: 'todo' });
    assert.equal(work.status, 201, JSON.stringify(describe(work)));
    workIds.push(work.data.resource_ref.resource_id);
    scanForLeaks(work, '6 setup', data === A ? B : A);
  }
  const cases = [
    { route: '/tenants/:tenant_id/workspaces/:workspace_id/works', body: { title: 'Idempotency', objective: 'O', progress: 'todo' }, table: 'work_items', column: 'tenant_id', status: 201 },
    { route: '/tenants/:tenant_id/works/:work_id/results/uploads', body: { content_type: 'text/plain', byte_size: Buffer.byteLength('unfinalized'), sha256: sha(Buffer.from('unfinalized')), display_name: 'n.md', expected_work_version: '1' }, table: 'asset_upload_intents', column: 'target_tenant_id', status: 201 },
    { route: '/tenants/:tenant_id/workspaces/:workspace_id/manual-work', body: { guild_key: 'guild_ai_field' }, table: 'module_instances', column: 'tenant_id', status: 200 },
  ];
  const outcomes = [];
  for (const item of cases) {
    const before = await Promise.all([count(item.table, A.tenantId, item.column), count(item.table, B.tenantId, item.column)]);
    const headers = jsonHeaders(randomUUID());
    const sent: Reply[] = [];
    for (const [index, data] of [A, B].entries()) {
      sent.push(await call('POST', substitute(item.route, { ...ids(data, { method: 'POST', path: item.route }), work_id: workIds[index] }), W, JSON.stringify(item.body), headers));
    }
    const [replyA, replyB] = sent;
    assert.equal(replyA.status, item.status, `${item.route} A: ${JSON.stringify(describe(replyA))}`);
    const delta = item.status === 200 ? 0 : 1;
    const after = await Promise.all([count(item.table, A.tenantId, item.column), count(item.table, B.tenantId, item.column)]);
    assert.equal(after[0], before[0] + delta, `${item.route} A count`);
    if (replyB.status === 409) {
      assert.equal(replyB.data.code, 'idempotency_conflict', JSON.stringify(describe(replyB)));
      assert.equal(after[1], before[1], `${item.route} B conflict count`);
    } else {
      assert.equal(replyB.status, item.status, `${item.route} B: ${JSON.stringify(describe(replyB))}`);
      assert.equal(after[1], before[1] + delta, `${item.route} B independent count`);
      assert.notDeepEqual(replyB.data, replyA.data);
      if (item.status === 200) {
        assert.equal(replyA.data.reused, true); assert.equal(replyB.data.reused, true);
        assert.equal(replyA.data.instance_id, A.instanceId); assert.equal(replyB.data.instance_id, B.instanceId);
      } else {
        assert.equal(replyA.data.resource_ref.tenant_id, A.tenantId);
        assert.equal(replyB.data.resource_ref.tenant_id, B.tenantId);
        assert.notEqual(replyA.data.resource_ref.resource_id, replyB.data.resource_ref.resource_id);
      }
    }
    const freshId = replyA.data.resource_ref?.resource_id;
    scanForLeaks(replyA, `6 ${item.route} A`, B);
    scanForLeaks(replyB, `6 ${item.route} B`, A, freshId ? [freshId] : []);
    // Versions can coincide, but a resource-version pair must never be replayed across tenants.
    assert.notDeepEqual({ id: replyB.data.resource_ref?.resource_id ?? replyB.data.instance_id, version: replyB.data.version },
      { id: freshId ?? replyA.data.instance_id, version: replyA.data.version });
    outcomes.push({ route: item.route, A: describe(replyA), B: describe(replyB), counts: { before, after } });
  }
  // Registry commands use the same key in A and B, while their targets and receipts remain tenant-local.
  const reusePlans: Reply[] = [];
  const planKey = randomUUID();
  const beforePlans = await Promise.all([count('module_launch_plans', A.tenantId), count('module_launch_plans', B.tenantId)]);
  for (const data of [A, B]) {
    const installations = await call('GET', `/tenants/${data.tenantId}/application-installations?application_key=manual-workspace&workspace_id=${data.workspaceId}`, W);
    assert.equal(installations.status, 200, JSON.stringify(describe(installations)));
    assert.equal(installations.data.items.length, 1);
    const body = { guild_key: 'guild_ai_field', workspace_id: data.workspaceId,
      application_key: 'manual-workspace', release_ref: 'manual-workspace@1.0.0',
      installation_choice: 'reuse_existing', existing_installation_id: installations.data.items[0].installation_id,
      dependencies: [{ requirement_key: 'work', choice: 'reuse', instance_id: data.instanceId, expected_version: '1' }], configuration: {} };
    const path = `/tenants/${data.tenantId}/application-launch-plans`;
    const planned = await post(path, W, body, undefined, planKey);
    assert.equal(planned.status, 201, JSON.stringify(describe(planned)));
    const replay = await post(path, W, body, undefined, planKey);
    assert.equal(replay.status, planned.status);
    assert.deepEqual(replay.data, planned.data);
    assert.equal(planned.data.tenant_id, data.tenantId);
    scanForLeaks(planned, '6 registry plan', data === A ? B : A);
    scanForLeaks(replay, '6 registry plan replay', data === A ? B : A);
    reusePlans.push(planned);
  }
  assert.notEqual(reusePlans[0].data.plan_id, reusePlans[1].data.plan_id);
  const afterPlans = await Promise.all([count('module_launch_plans', A.tenantId), count('module_launch_plans', B.tenantId)]);
  assert.deepEqual(afterPlans, beforePlans.map(n => n + 1));
  outcomes.push({ route: '/tenants/:tenant_id/application-launch-plans', A: describe(reusePlans[0]), B: describe(reusePlans[1]), counts: { before: beforePlans, after: afterPlans } });

  const launchKey = randomUUID();
  const launches: Reply[] = [];
  const beforeInstallations = await Promise.all([count('application_installations', A.tenantId), count('application_installations', B.tenantId)]);
  for (const [index, data] of [A, B].entries()) {
    const plan = reusePlans[index].data;
    const body = { plan_id: plan.plan_id, expected_plan_version: plan.version, configuration_digest: plan.configuration_digest };
    const path = `/tenants/${data.tenantId}/application-installations`;
    const launched = await post(path, W, body, undefined, launchKey);
    assert.equal(launched.status, 200, JSON.stringify(describe(launched)));
    assert.equal(launched.data.state, 'succeeded');
    const replay = await post(path, W, body, undefined, launchKey);
    assert.equal(replay.status, launched.status);
    assert.deepEqual(replay.data, launched.data);
    const installation = await call('GET', `/tenants/${data.tenantId}/application-installations/by-operation/${launched.data.operation_id}`, W);
    assert.equal(installation.status, 200, JSON.stringify(describe(installation)));
    assert.equal(installation.data.tenant_id, data.tenantId);
    assert.equal(installation.data.workspace_id, data.workspaceId);
    assert.equal(installation.data.modules[0].instance_id, data.instanceId);
    for (const reply of [launched, replay, installation]) scanForLeaks(reply, '6 registry launch', data === A ? B : A);
    launches.push(launched);
  }
  assert.notEqual(launches[0].data.operation_id, launches[1].data.operation_id);
  const afterInstallations = await Promise.all([count('application_installations', A.tenantId), count('application_installations', B.tenantId)]);
  assert.deepEqual(afterInstallations, beforeInstallations);
  outcomes.push({ route: '/tenants/:tenant_id/application-installations', A: describe(launches[0]), B: describe(launches[1]), counts: { before: beforeInstallations, after: afterInstallations } });

  for (const action of ['reconcile', 'cancel'] as const) {
    const key = randomUUID();
    const replies: Reply[] = [];
    const before = await Promise.all([count('module_provision_operations', A.tenantId), count('module_provision_operations', B.tenantId)]);
    for (const data of [A, B]) {
      const operation = await call('GET', `/tenants/${data.tenantId}/operations/${data.operationId}`, W);
      assert.equal(operation.status, 200, JSON.stringify(describe(operation)));
      const reply = await post(`/tenants/${data.tenantId}/operations/${data.operationId}/${action}`, W,
        action === 'cancel' ? { reason: 'member_cancelled' } : {}, `"${operation.data.version}"`, key);
      assert.equal(reply.status, 202, JSON.stringify(describe(reply)));
      assert.equal(reply.data.operation_id, data.operationId);
      const other = data === A ? B : A;
      scanForLeaks(reply, `6 registry ${action}`, other);
      const hidden = await post(`/tenants/${data.tenantId}/operations/${other.operationId}/${action}`, W,
        action === 'cancel' ? { reason: 'member_cancelled' } : {}, `"${operation.data.version}"`, key);
      const missing = await post(`/tenants/${data.tenantId}/operations/${randomUUID()}/${action}`, W,
        action === 'cancel' ? { reason: 'member_cancelled' } : {}, `"${operation.data.version}"`, key);
      assertSameAsRandom(`6 registry ${action} receipt target`, 'W', hidden, missing);
      // Cancel checks the used command key before its target; reconcile reads its target first.
      assert.equal(hidden.status, action === 'cancel' ? 409 : 404, JSON.stringify(describe(hidden)));
      assert.equal(hidden.data.code, action === 'cancel' ? 'idempotency_conflict' : 'not_found');
      scanForLeaks(hidden, `6 registry ${action} receipt target`, other);
      scanForLeaks(missing, `6 registry ${action} random target`, other);
      replies.push(reply);
    }
    assert.notDeepEqual(replies[0].data, replies[1].data);
    const after = await Promise.all([count('module_provision_operations', A.tenantId), count('module_provision_operations', B.tenantId)]);
    assert.deepEqual(after, before);
    outcomes.push({ route: `/tenants/:tenant_id/operations/:operation_id/${action}`, A: describe(replies[0]), B: describe(replies[1]), counts: { before, after } });
  }
  // Reuse plans above require the initial instance version; lifecycle positive controls run only after them.
  const operationIds = new Set<string>((await owner.query<{ operation_id: string }>(
    'SELECT operation_id FROM module_provision_operations WHERE tenant_id=ANY($1::uuid[])', [[A.tenantId, B.tenantId]],
  )).rows.map(row => row.operation_id));
  for (const action of ['suspend', 'resume'] as const) {
    const route = `/tenants/:tenant_id/module-instances/:instance_id/${action}`;
    const body = action === 'suspend' ? { reason: 'synthetic suspend' } : {};
    const key = randomUUID();
    const replies: Reply[] = [];
    const before = await Promise.all([instanceLifecycleSnapshot(A), instanceLifecycleSnapshot(B)]);
    const targets = [];
    for (const data of [A, B]) {
      const other = data === A ? B : A;
      const freshId = replies[0]?.data.operation_id;
      const extra = data === B && freshId ? [freshId] : [];
      const ownBefore = await instanceLifecycleSnapshot(data);
      const otherBefore = await instanceLifecycleSnapshot(other);
      const instance = await call('GET', `/tenants/${data.tenantId}/module-instances/${data.instanceId}`, W);
      assert.equal(instance.status, 200, JSON.stringify(describe(instance)));
      assert.equal(instance.data.version, ownBefore.instance.version);
      scanForLeaks(instance, `6 lifecycle ${action} version`, other, extra);
      const expected = `"${instance.data.version}"`;
      const path = substitute(route, ids(data, { method: 'POST', path: route }));
      const reply = await post(path, W, body, expected, key);
      assert.equal(reply.status, 200, JSON.stringify(describe(reply)));
      assert.match(reply.data.operation_id, /^[0-9a-f-]{36}$/);
      assert.equal(operationIds.has(reply.data.operation_id), false, 'Lifecycle must return a fresh operation id');
      operationIds.add(reply.data.operation_id);
      assert.deepEqual(reply.data, { operation_id: reply.data.operation_id, state: 'succeeded', version: '1' });
      assert.equal(reply.headers.get('etag'), '"1"');
      assert.equal(reply.headers.get('cache-control'), 'private, no-store');
      scanForLeaks(reply, `6 lifecycle ${action}`, other, extra);
      const ownAfter = await instanceLifecycleSnapshot(data);
      const status = action === 'suspend' ? 'suspended' : 'active';
      assert.deepEqual(ownAfter, { instance: { ...ownBefore.instance, status, binding_state: status,
        version: String(BigInt(ownBefore.instance.version) + 1n),
        suspension_operation_id: action === 'suspend' ? reply.data.operation_id : null }, operations: ownBefore.operations + 1 });

      const replay = await post(path, W, body, expected, key);
      assert.equal(replay.status, reply.status, JSON.stringify(describe(replay)));
      assert.deepEqual(replay.data, reply.data);
      assert.equal(replay.headers.get('etag'), '"1"');
      assert.equal(replay.headers.get('cache-control'), 'private, no-store');
      scanForLeaks(replay, `6 lifecycle ${action} replay`, other, extra);
      assert.deepEqual(await instanceLifecycleSnapshot(data), ownAfter, 'Receipt replay changed instance or operation count');

      const hidden = await post(`/tenants/${data.tenantId}/module-instances/${other.instanceId}/${action}`, W, body, expected, key);
      const missing = await post(`/tenants/${data.tenantId}/module-instances/${randomUUID()}/${action}`, W, body, expected, key);
      assertSameAsRandom(`6 lifecycle ${action} receipt target`, 'W', hidden, missing);
      // The used command key is checked before either hidden or missing instance is looked up.
      assert.equal(hidden.status, 409, JSON.stringify(describe(hidden)));
      assert.equal(hidden.data.code, 'idempotency_conflict');
      scanForLeaks(hidden, `6 lifecycle ${action} receipt target`, other, extra);
      scanForLeaks(missing, `6 lifecycle ${action} random target`, other, extra);
      assert.deepEqual(await instanceLifecycleSnapshot(data), ownAfter, 'Denied receipt targets changed own tenant');
      assert.deepEqual(await instanceLifecycleSnapshot(other), otherBefore, 'Lifecycle commands changed the other tenant');
      targets.push({ tenant: data === A ? 'A' : 'B', hidden: describe(hidden), missing: describe(missing) });
      replies.push(reply);
      data.resourceIds.push(reply.data.operation_id);
    }
    assert.notDeepEqual(replies[0].data, replies[1].data);
    const after = await Promise.all([instanceLifecycleSnapshot(A), instanceLifecycleSnapshot(B)]);
    assert.deepEqual(after.map(row => row.operations), before.map(row => row.operations + 1));
    outcomes.push({ route, A: describe(replies[0]), B: describe(replies[1]), targets, counts: {
      before: before.map(row => row.operations), after: after.map(row => row.operations),
    }, instances: { before: before.map(row => row.instance), after: after.map(row => row.instance) } });
  }
  // Archive only the extra instances: later private reads still use the main manual-work bindings.
  const archiveRoute = '/tenants/:tenant_id/module-instances/:instance_id/archive';
  const archiveBody = { reason: 'synthetic archive' };
  const archiveKey = randomUUID();
  const archived: Reply[] = [];
  const archiveBefore = await Promise.all([tenantArchiveSnapshot(A), tenantArchiveSnapshot(B)]);
  const archiveTargets = [];
  for (const [data, actor] of [[A, fixture.people.P], [B, fixture.people.N]] as const) {
    const tenant = data === A ? 'A' : 'B';
    const other = data === A ? B : A;
    const freshId = archived[0]?.data.operation_id;
    const extra = data === B && freshId ? [freshId] : [];
    const ownBefore = await tenantArchiveSnapshot(data);
    const otherBefore = await tenantArchiveSnapshot(other);
    assert.equal(ownBefore.extra.instance.version, data.extraInstanceVersion);
    assert.equal(ownBefore.extra.instance.status, 'active');
    assert.equal(ownBefore.extra.instance.archive_operation_id, null);
    assert.equal(ownBefore.extra.instance.binding_state, 'active');
    const path = `/tenants/${data.tenantId}/module-instances/${data.extraInstanceId}/archive`;

    const adminInstance = await call('GET', `/tenants/${data.tenantId}/module-instances/${data.extraInstanceId}`, W);
    assert.equal(adminInstance.status, 200, JSON.stringify(describe(adminInstance)));
    assert.equal(adminInstance.data.version, ownBefore.extra.instance.version);
    scanForLeaks(adminInstance, `6 archive ${tenant} admin version`, other, extra);
    const adminKey = randomUUID();
    const adminDenied = await post(path, W, archiveBody, `"${adminInstance.data.version}"`, adminKey);
    const adminMissing = await post(`/tenants/${data.tenantId}/module-instances/${randomUUID()}/archive`, W,
      archiveBody, `"${adminInstance.data.version}"`, adminKey);
    assert.equal(adminDenied.status, 403, `Archive must refuse admin: ${JSON.stringify(describe(adminDenied))}`);
    assert.equal(adminDenied.data.code, 'capability_denied');
    assertSameAsRandom('6 archive admin capability gate', 'W', adminDenied, adminMissing);
    for (const reply of [adminDenied, adminMissing]) scanForLeaks(reply, `6 archive ${tenant} admin refusal`, other, extra);
    assert.deepEqual(await tenantArchiveSnapshot(data), ownBefore, 'Admin archive changed own tenant');
    assert.deepEqual(await tenantArchiveSnapshot(other), otherBefore, 'Admin archive changed the other tenant');

    const instance = await call('GET', `/tenants/${data.tenantId}/module-instances/${data.extraInstanceId}`, actor);
    assert.equal(instance.status, 200, JSON.stringify(describe(instance)));
    assert.equal(instance.data.version, ownBefore.extra.instance.version);
    scanForLeaks(instance, `6 archive ${tenant} owner version`, other, extra);
    const expected = `"${instance.data.version}"`;
    const reply = await post(path, actor, archiveBody, expected, archiveKey);
    assert.equal(reply.status, 200, JSON.stringify(describe(reply)));
    assert.match(reply.data.operation_id, /^[0-9a-f-]{36}$/);
    assert.equal(operationIds.has(reply.data.operation_id), false, 'Archive must return a fresh operation id');
    operationIds.add(reply.data.operation_id);
    assert.deepEqual(reply.data, { operation_id: reply.data.operation_id, state: 'succeeded', version: '1' });
    assert.equal(reply.headers.get('etag'), '"1"');
    assert.equal(reply.headers.get('cache-control'), 'private, no-store');
    scanForLeaks(reply, `6 archive ${tenant} owner success`, other, extra);
    const ownAfter = await tenantArchiveSnapshot(data);
    assert.ok(ownBefore.installations.some(row => row.uses_extra_instance && row.status === 'active'),
      'Archive must exercise a linked live installation');
    assert.deepEqual(ownAfter, {
      main: { ...ownBefore.main, operations: ownBefore.main.operations + 1 },
      extra: { instance: { ...ownBefore.extra.instance, status: 'archived', binding_state: 'retired',
        version: String(BigInt(ownBefore.extra.instance.version) + 1n), archive_operation_id: reply.data.operation_id },
        operations: ownBefore.extra.operations + 1 },
      installations: ownBefore.installations.map(row => row.uses_extra_instance && !['archived', 'failed'].includes(row.status)
        ? { ...row, status: 'archived', version: String(BigInt(row.version) + 1n) } : row),
    });
    assert.deepEqual(await tenantArchiveSnapshot(other), otherBefore, 'Owner archive changed the other tenant');

    const replay = await post(path, actor, archiveBody, expected, archiveKey);
    assert.equal(replay.status, reply.status, JSON.stringify(describe(replay)));
    assert.deepEqual(replay.data, reply.data);
    assert.equal(replay.headers.get('etag'), '"1"');
    assert.equal(replay.headers.get('cache-control'), 'private, no-store');
    scanForLeaks(replay, `6 archive ${tenant} owner replay`, other, extra);
    assert.deepEqual(await tenantArchiveSnapshot(data), ownAfter, 'Archive receipt replay changed own tenant');
    assert.deepEqual(await tenantArchiveSnapshot(other), otherBefore, 'Archive receipt replay changed the other tenant');

    const hidden = await post(`/tenants/${data.tenantId}/module-instances/${other.extraInstanceId}/archive`, actor,
      archiveBody, expected, archiveKey);
    const missing = await post(`/tenants/${data.tenantId}/module-instances/${randomUUID()}/archive`, actor,
      archiveBody, expected, archiveKey);
    assertSameAsRandom('6 archive receipt target', tenant === 'A' ? 'P' : 'N', hidden, missing);
    // The used command key is checked before either hidden or missing instance is looked up.
    assert.equal(hidden.status, 409, JSON.stringify(describe(hidden)));
    assert.equal(hidden.data.code, 'idempotency_conflict');
    for (const denied of [hidden, missing]) scanForLeaks(denied, `6 archive ${tenant} receipt target`, other, extra);
    assert.deepEqual(await tenantArchiveSnapshot(data), ownAfter, 'Denied archive receipt targets changed own tenant');
    assert.deepEqual(await tenantArchiveSnapshot(other), otherBefore, 'Archive requests changed the other tenant');
    archiveTargets.push({ tenant, admin: { real: describe(adminDenied), random: describe(adminMissing) },
      replay: describe(replay), hidden: describe(hidden), missing: describe(missing) });
    archived.push(reply);
    data.resourceIds.push(reply.data.operation_id);
  }
  assert.notEqual(archived[0].data.operation_id, archived[1].data.operation_id);
  const archiveAfter = await Promise.all([tenantArchiveSnapshot(A), tenantArchiveSnapshot(B)]);
  assert.deepEqual(archiveAfter.map(row => row.main.instance), archiveBefore.map(row => row.main.instance));
  assert.ok(archiveAfter.every(row => row.main.instance.status === 'active'));
  assert.deepEqual(archiveAfter.map(row => row.main.operations), archiveBefore.map(row => row.main.operations + 1));
  outcomes.push({ route: archiveRoute, A: describe(archived[0]), B: describe(archived[1]), targets: archiveTargets,
    counts: { before: archiveBefore.map(row => row.main.operations), after: archiveAfter.map(row => row.main.operations) },
    instances: { before: archiveBefore, after: archiveAfter } });
  console.log(JSON.stringify({ item6: outcomes }));
});

test('T-022 7. Successful private reads and attachment headers', async () => {
  for (const [data, actor, other] of [[fixture.A, fixture.people.P, fixture.B], [fixture.B, fixture.people.N, fixture.A]] as const) {
    for (const route of routes.filter(r => r.method === 'GET')) {
      const reply = await execute(route, actor, ids(data, route));
      if (route.path.includes('/storefronts/')) {
        // This fixture's instance is Work. Storefront endpoints must conceal it.
        assert.equal(reply.status, 404, `${route.path}: ${JSON.stringify(describe(reply))}`);
        assert.equal(reply.data.code, 'not_found');
      } else assert.equal(reply.status, 200, `${route.path}: ${JSON.stringify(describe(reply))}`);
      scanForLeaks(reply, `7 ${route.path}`, other);
      if (route.path.endsWith('/module-binding')) {
        assert.equal(reply.data.tenant_id, data.tenantId);
        assert.equal(reply.data.workspace_id, data.workspaceId);
        assert.equal(reply.data.binding.instance_id, data.instanceId);
        console.log(JSON.stringify({ item7_module_binding: describe(reply) }));
      }
      if (route.path.endsWith('/content')) assert.deepEqual(Buffer.from(reply.bytes), data.noteBytes);
    }
  }
});

test('T-024 every matrix request ran on one runtime-role connection and left no tenant context', () => {
  assert.equal(runtimeConnection.current_user, runtimeRole);
  assert.equal(runtimeConnection.session_user, runtimeRole);
  assert.equal(runtimeConnection.rolsuper, false);
  assert.equal(runtimeConnection.rolbypassrls, false);
  assert.ok(requestEvidence.length > 0, 'No matrix request connection evidence was recorded');
  const pids = [...new Set(requestEvidence.map(row => row.pid))];
  assert.deepEqual(pids, [runtimeConnection.pg_backend_pid],
    `Runtime connection changed (pool removals=${connectionRemovals}). A failed rollback destroys its client; this matrix injects no rollback failure.`);
  for (const row of requestEvidence) {
    for (const [key, value] of Object.entries(row.settings)) {
      assert.ok(value === null || value === '', `${row.method} ${row.path}: ${key} context remained on backend ${row.pid}`);
    }
  }
  console.log(JSON.stringify({ t024_matrix_connection: { requests: requestEvidence.length, backend_pids: pids,
    connection_removals: connectionRemovals, context_clear: true } }));
});
