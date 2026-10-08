import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { bindPrincipalContext, bindTenantContext, isolatedTransaction } from '../../packages/resource-scopes/tenant-transaction.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { FakeObjectStore } from '../../packages/asset-storage/fake-store.js';
import { migrate } from '../../scripts/database.js';
import { DEMO_COMMUNITY, DEMO_PASSWORD, DEMO_USERS, seedLocal } from '../../packages/testing/seed.js';
import { ensureSyntheticModuleTables, setSyntheticFault, syntheticModuleProviders } from '../../packages/testing/synthetic-module-provider.js';
import { WORK_CONTRACT_SOURCE_COMMIT } from '../../modules/module-registry/definitions.js';
import { advanceOperation } from '../../modules/module-registry/operations.js';
import type { ProvisionEffect } from '../../modules/module-registry/providers.js';

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
const app = createApp(runtime, origin, 'local', { guildLaunchpadEnabled: true, tenantWorkAssetStore: store, moduleProviders: providers });

let created = false;
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
  await quiet();
  return reply;
}
async function quiet() {
  const settings = (await runtime.query(`SELECT current_setting('freedom.tenant_id', true) AS tenant,
    current_setting('freedom.tenant_scope_id', true) AS scope,
    current_setting('freedom.principal_id', true) AS principal,
    current_setting('freedom.platform_admin_id', true) AS admin`)).rows[0];
  for (const [key, value] of Object.entries(settings)) assert.ok(value === null || value === '', `${key} context leaked: ${value}`);
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
    const installation = await call('GET', `/tenants/${tenantId}/application-installations/by-operation/${operationId}`, session);
    assert.equal(installation.status, 200, JSON.stringify(installation.data));
    const dependencyId = installation.data.modules.find((m: any) => m.requirement_key === 'inventory').instance_id as string;
    const scopeId = (await owner.query("SELECT scope_id FROM resource_scopes WHERE kind='tenant' AND tenant_ref=$1", [tenantId])).rows[0].scope_id as string;


    const etags = [w.response.headers.get('etag'), u1.response.headers.get('etag'), f1.response.headers.get('etag'), inv.response.headers.get('etag')].filter(Boolean) as string[];

    return {
      tenantId, workspaceId, principalId, instanceId, workId, resultId, uploadId, unfinalizedUploadId, invitationId, transferId: "", operationId, operationVersion: inst.data.version as string, planId, planVersion, planDigest, dependencyId, installationId: installation.data.installation_id as string, scopeId, workVersion: updatedWorkVersion, uploadVersion,
      etags, versions: [workVersion, uploadVersion, f1.data.work_version, inv.data.version, planVersion, inst.data.version].filter(Boolean) as string[],
      noteBytes
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

function identifier(value: string) {
  assert.match(value, /^[a-z][a-z0-9_]*$/, `Unsafe catalog identifier: ${value}`);
  return `"${value}"`;
}

/** Row-security tables test 8 cannot retarget, with the reason. A new table must be covered or listed here. */
const DOCUMENTED_UNCOVERED_RLS_TABLES: Readonly<Record<string, string>> = Object.freeze({
  tenant_capacity_policies: 'The harness installs only a global synthetic policy; no tenant-specific A or B row exists.',
  tenant_recovery_cases: 'Active loginable A and B owners do not meet the recovery preconditions; the recovery suites cover it.',
});

function isRlsRejection(error: unknown): boolean {
  const failure = error as { code?: string; message?: string };
  return failure.code === '42501' && /new row violates row-level security policy/.test(failure.message ?? '');
}

type Policy = { policyname: string; cmd: string; permissive: string; qual: string | null; with_check: string | null };
async function assertTenantWritePolicy(table: string, column: string) {
  const policies = (await owner.query<Policy>(`SELECT policyname, cmd, permissive, qual, with_check FROM pg_policies
    WHERE schemaname=current_schema() AND tablename=$1 AND cmd IN ('ALL','INSERT','UPDATE')
      AND (roles @> ARRAY['public']::name[] OR roles @> ARRAY[$2]::name[]) ORDER BY policyname`, [table, runtimeRole])).rows;
  const name = `${table}_${column === 'scope_id' ? 'tenant_scope' : 'tenant'}`;
  const expected = column === 'scope_id'
    ? "((scope_kind <> 'tenant'::text) OR (scope_id = freedom_ctx_tenant_scope()))"
    : table === 'work_items'
      ? '((tenant_id IS NULL) OR (tenant_id = freedom_ctx_tenant()))'
      : '(tenant_id = freedom_ctx_tenant())';
  const policy = policies.find(row => row.policyname === name);
  assert.ok(policy, `${table}: missing tenant write policy ${name}`);
  assert.equal(policy.cmd, 'ALL', `${table}: tenant policy must cover INSERT and UPDATE`);
  assert.equal(policy.permissive, 'PERMISSIVE');
  assert.equal(policy.qual, expected, `${table}: tenant USING predicate changed`);
  assert.equal(policy.with_check ?? policy.qual, expected, `${table}: tenant WITH CHECK predicate changed`);
  // Permissive policies combine with OR. Pin the additional write checks too, so a new
  // policy or an unbound-principal exception cannot silently bypass the tenant check.
  const exceptions: Record<string, string> = {
    tenant_invitations_invitee_expire: "((freedom_ctx_tenant() IS NULL) AND (invitee_principal_id = freedom_ctx_principal()) AND (state = 'expired'::text))",
    tenant_ownership_transfers_recipient_expire: "((freedom_ctx_tenant() IS NULL) AND (to_principal_id = freedom_ctx_principal()) AND (state = 'expired'::text))",
    tenant_ownership_transfers_principal_invalidate: "((freedom_ctx_tenant() IS NULL) AND (freedom_ctx_principal() IS NOT NULL) AND (state = 'invalidated'::text) AND ((from_principal_id = freedom_ctx_principal()) OR (to_principal_id = freedom_ctx_principal())))",
  };
  for (const other of policies.filter(row => row !== policy)) {
    assert.ok(exceptions[other.policyname], `${table}: unexpected write policy ${other.policyname}`);
    assert.equal(other.with_check ?? other.qual, exceptions[other.policyname], `${table}: principal write exception changed`);
  }
  return policies.map(row => row.policyname);
}

test('T-022 8. Discovered RLS tables reject retarget and cross-tenant select', async () => {
  const { A, B } = fixture;
  const role = (await runtime.query(`SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`)).rows[0];
  assert.equal(role.name, runtimeRole); assert.equal(role.rolsuper, false); assert.equal(role.rolbypassrls, false);
  const tables = (await owner.query<{ relname: string }>(`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p') AND c.relrowsecurity ORDER BY c.relname;
  `)).rows;
  assert.ok(tables.length, 'No RLS tables discovered');
  // Pin the merged P-D1 RLS set; discovery requires fixture coverage for every new table.
  assert.deepEqual(tables.map(row => row.relname), [
    'tenants', 'tenant_memberships', 'tenant_invitations', 'workspaces', 'tenant_authority_audit', 'module_instances',
    'tenant_high_risk_verifications', 'tenant_ownership_transfers', 'tenant_recovery_cases',
    'deployment_bindings', 'workspace_module_bindings', 'tenant_work_results', 'tenant_work_result_targets',
    'application_installations', 'application_module_links', 'capacity_ledger', 'capacity_reservations',
    'module_dependencies', 'module_launch_plan_consumptions', 'module_launch_plans', 'module_provision_operations', 'module_provision_steps',
    'tenant_capacity_policies', 'work_items', 'scoped_command_receipts', 'scoped_transition_journal', 'scoped_outbox',
  ].sort(), 'RLS discovery must match the merged schema; new tables need A/B fixture coverage or an explicit uncovered reason');
  for (const table of ['scoped_command_receipts', 'scoped_outbox', 'scoped_transition_journal']) {
    assert.ok(tables.some(row => row.relname === table), `${table}: missing from RLS discovery`);
  }
  // Tenant commands deliberately omit some public events. Add one synthetic scoped
  // outbox row per tenant, backed by an actual journal, to exercise its private scope.
  for (const data of [A, B]) {
    await owner.query(`INSERT INTO scoped_outbox(event_id,transition_id,scope_id,scope_kind,event_type,payload)
      SELECT $1, transition_id, scope_id, scope_kind, 'synthetic.retarget.v1', '{}'::jsonb
      FROM scoped_transition_journal WHERE scope_id=$2 AND scope_kind='tenant' ORDER BY transition_id LIMIT 1
      ON CONFLICT (transition_id) DO NOTHING`, [randomUUID(), data.scopeId]);
  }
  const record: { table: string; mechanism: 'rls_update' | 'rls_insert' | 'policy_assertion' | 'documented_exception';
    update_covered: boolean; outcome: string; select?: number; own_select?: number; policies?: string[]; reason?: string }[] = [];
  for (const { relname: table } of tables) {
    const quoted = identifier(table);
    const columns = (await owner.query<{ attname: string; attgenerated: string }>(`SELECT a.attname, a.attgenerated FROM pg_attribute a
      JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=current_schema() AND c.relname=$1 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, [table])).rows;
    const scopeKeyed = !columns.some(row => row.attname === 'tenant_id') && columns.some(row => row.attname === 'scope_id');
    const column = columns.some(row => row.attname === 'tenant_id') ? 'tenant_id' : scopeKeyed ? 'scope_id' : null;
    if (!column) {
      assert.ok(DOCUMENTED_UNCOVERED_RLS_TABLES[table], `${table}: RLS table has no supported tenant/scope key or documented reason`);
      record.push({ table, mechanism: 'documented_exception', update_covered: false, outcome: 'uncovered', reason: DOCUMENTED_UNCOVERED_RLS_TABLES[table] });
      continue;
    }
    const aKey = scopeKeyed ? A.scopeId : A.tenantId;
    const bKey = scopeKeyed ? B.scopeId : B.tenantId;
    const scopeFilter = scopeKeyed ? " AND scope_kind='tenant'" : '';
    const pk = (await owner.query<{ attname: string }>(`SELECT a.attname FROM pg_index i
      JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum
      WHERE n.nspname=current_schema() AND c.relname=$1 AND i.indisprimary ORDER BY k.ord`, [table])).rows.map(r => r.attname);
    assert.ok(pk.length, `${table} has no primary key`);
    const aRow = (await owner.query(`SELECT * FROM ${quoted} WHERE ${column}=$1${scopeFilter} ORDER BY ${pk.map(identifier).join(',')} LIMIT 1`, [aKey])).rows[0];
    const bRow = (await owner.query(`SELECT * FROM ${quoted} WHERE ${column}=$1${scopeFilter} ORDER BY ${pk.map(identifier).join(',')} LIMIT 1`, [bKey])).rows[0];
    if (!aRow || !bRow) {
      assert.ok(DOCUMENTED_UNCOVERED_RLS_TABLES[table], `${table}: missing A/B fixture without documented reason`);
      record.push({ table, mechanism: 'documented_exception', update_covered: false, outcome: 'uncovered', reason: DOCUMENTED_UNCOVERED_RLS_TABLES[table] });
      continue;
    }
    const beforeB = (await owner.query(`SELECT count(*)::int AS n FROM ${quoted} WHERE ${column}=$1${scopeFilter}`, [bKey])).rows[0].n;
    const where = (offset: number) => pk.map((col, index) => `${identifier(col)}=$${index + offset}`).join(' AND ');
    const aParams = pk.map(col => aRow[col]);
    const bParams = pk.map(col => bRow[col]);
    let outcome = '';
    let updateCovered = false;
    try {
      const changed = await isolatedTransaction(runtime, async q => {
        await bindPrincipalContext(q, A.principalId);
        await bindTenantContext(q, { tenantId: A.tenantId, tenantScopeId: A.scopeId });
        return q.query(`UPDATE ${quoted} SET ${column}=$1 WHERE ${where(2)}`, [bKey, ...aParams]);
      });
      assert.equal(changed.rowCount, 0, `${table} allowed retarget of A to B`);
      outcome = 'rowCount 0 (UPDATE did not exercise WITH CHECK)';
    } catch (error) {
      const code = (error as { code?: string }).code;
      assert.ok(code && ['42501', '23503', '23514', 'P0001', '23505'].includes(code), `${table}: unexpected SQLSTATE ${code}: ${String(error)}`);
      updateCovered = isRlsRejection(error);
      outcome = `${code}: ${(error as Error).message}`;
    }
    let mechanism: 'rls_update' | 'rls_insert' | 'policy_assertion' = 'rls_update';
    let policies: string[] | undefined;
    if (!updateCovered) {
      if (scopeKeyed) {
        // These append-only tables have BEFORE UPDATE guards but no BEFORE INSERT
        // guard. Clone a structurally valid B row so RLS runs before unique/FK checks.
        const inserted = { ...bRow };
        if (table === 'scoped_command_receipts') inserted.idempotency_key = randomUUID();
        else inserted[pk[0]] = randomUUID();
        const fields = columns.filter(row => !row.attgenerated).map(row => row.attname);
        await assert.rejects(isolatedTransaction(runtime, async q => {
          await bindPrincipalContext(q, A.principalId);
          await bindTenantContext(q, { tenantId: A.tenantId, tenantScopeId: A.scopeId });
          await q.query(`INSERT INTO ${quoted} (${fields.map(identifier).join(',')}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')})`, fields.map(field => inserted[field]));
        }), isRlsRejection, `${table}: INSERT must fail with the RLS 42501 message`);
        mechanism = 'rls_insert';
      } else {
        policies = await assertTenantWritePolicy(table, column);
        mechanism = 'policy_assertion';
      }
    }
    const unchanged = (await owner.query(`SELECT ${column} AS key FROM ${quoted} WHERE ${where(1)}`, aParams)).rows[0];
    assert.equal(unchanged?.key, aKey, `${table} changed or lost A's row`);
    assert.equal((await owner.query(`SELECT count(*)::int AS n FROM ${quoted} WHERE ${column}=$1${scopeFilter}`, [bKey])).rows[0].n, beforeB, `${table} changed B's count`);
    const selected = await isolatedTransaction(runtime, async q => {
      await bindPrincipalContext(q, A.principalId);
      await bindTenantContext(q, { tenantId: A.tenantId, tenantScopeId: A.scopeId });
      return q.query(`SELECT 1 FROM ${quoted} WHERE ${where(1)}`, bParams);
    });
    assert.equal(selected.rowCount, 0, `${table} exposed B's row to A`);
    const own = await isolatedTransaction(runtime, async q => {
      await bindPrincipalContext(q, B.principalId);
      await bindTenantContext(q, { tenantId: B.tenantId, tenantScopeId: B.scopeId });
      return q.query(`SELECT 1 FROM ${quoted} WHERE ${where(1)}`, bParams);
    });
    assert.equal(own.rowCount, 1, `${table}: positive SELECT control cannot see B's row`);
    record.push({ table, mechanism, update_covered: updateCovered, outcome, select: selected.rowCount!, own_select: own.rowCount!, ...(policies ? { policies } : {}) });
  }
  assert.deepEqual(record.map(row => row.table), tables.map(row => row.relname));
  assert.deepEqual(record.filter(row => row.mechanism === 'documented_exception').map(row => row.table).sort(),
    Object.keys(DOCUMENTED_UNCOVERED_RLS_TABLES).sort(), 'Documented exceptions must exactly match uncovered tables');
  console.log(JSON.stringify({ item8: record }));
});

test('T-022 9. An executor bound to A cannot claim or advance B; B can advance its own operation', async () => {
  const { A, B } = fixture;
  const operation = (await owner.query('SELECT state FROM module_provision_operations WHERE operation_id=$1', [B.operationId])).rows[0];
  assert.ok(['requested', 'running', 'needs_reconciliation'].includes(operation.state));
  assert.ok((await owner.query('SELECT 1 FROM module_provision_steps WHERE operation_id=$1', [B.operationId])).rowCount);
  async function snapshot() {
    const rows: Record<string, unknown> = {};
    for (const table of ['module_provision_operations', 'module_provision_steps', 'module_instances', 'application_installations', 'capacity_reservations', 'capacity_ledger']) {
      rows[table] = (await owner.query(`SELECT to_jsonb(t) AS row FROM ${identifier(table)} t WHERE tenant_id=$1 ORDER BY to_jsonb(t)::text`, [B.tenantId])).rows;
    }
    return rows;
  }
  let applied = 0;
  const guardedProviders: typeof providers = Object.fromEntries(Object.entries(providers).map(([key, provider]) => [key, {
    ...provider,
    ...(provider.kind === 'async' ? { apply: async (effect: ProvisionEffect) => { applied++; return provider.apply(effect); } } : {}),
  }]));
  const before = await snapshot();
  await setSyntheticFault(owner, 'synthetic-inventory', null);
  await setSyntheticFault(owner, 'synthetic-storefront', null);
  const clock = () => new Date(Date.now() + 60_000);
  await advanceOperation(runtime, A.tenantId, B.operationId, { providers: guardedProviders, clock });
  assert.equal(applied, 0, 'A dispatched a provider effect for B');
  assert.deepEqual(await snapshot(), before, 'A changed B operation, step, instance, installation or capacity rows');
  await quiet();
  await advanceOperation(runtime, B.tenantId, B.operationId, { providers: guardedProviders, clock });
  assert.ok(applied > 0, 'The B operation was not claimable in its own tenant');
  assert.notDeepEqual(await snapshot(), before, 'The positive control did not advance B');
  await quiet();
});
