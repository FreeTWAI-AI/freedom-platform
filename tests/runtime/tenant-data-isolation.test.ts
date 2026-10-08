import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { migrate } from '../../scripts/database.js';
import { bindPrincipalContext, bindTenantContext, isolatedTransaction } from '../../packages/resource-scopes/tenant-transaction.js';
import { changeMemberStatus, type AdminActor, type AdminCommand } from '../../modules/platform-admin/service.js';
import { openRecoveryCase } from '../../modules/tenant-workspaces/recovery.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname)) {
  throw new Error('Tenant isolation requires explicit disposable fp_* TEST_DATABASE_URL.');
}
const stamp = `${process.pid}_${Date.now()}`;
const schema = `e1s_${stamp}`;
const migrator = `e1m_${stamp}`;
const runtimeRole = `e1a_${stamp}`;
const admin = new Pool({ connectionString, max: 2 });
function roleUrl(role: string) {
  const url = new URL(connectionString!);
  url.username = role;
  url.password = '';
  return url.toString();
}
const owner = new Pool({ connectionString: roleUrl(migrator), options: `-c search_path=${schema} -c statement_timeout=20000`, max: 2 });
const runtime = new Pool({ connectionString: roleUrl(runtimeRole), options: `-c search_path=${schema} -c statement_timeout=20000`, max: 1 });
// pg_terminate_backend closes the socket after the query rejects. The pool
// emits that as a client error; the test asserts the original query error.
for (const pool of [admin, owner, runtime]) pool.on('error', () => undefined);
const DEFINERS = [
  'lock_media_backfill_avatar_consent', 'lock_media_backfill_avatar_owner', 'lock_media_backfill_banner_consent',
  'lock_media_backfill_banner_organizer', 'lock_media_backfill_cover_consent', 'lock_media_backfill_cover_owner',
  'lock_media_backfill_highlight_bytes', 'lock_media_backfill_highlight_consent', 'lock_media_backfill_highlight_uploader',
  'lock_media_backfill_operator_approval', 'lock_media_backfill_skill_consent', 'lock_media_backfill_skill_owner',
  'lock_media_backfill_social_author', 'lock_media_backfill_social_consent', 'lock_media_backfill_video_consent',
  'lock_media_backfill_video_organizer', 'operator_avatar_intent_admitted', 'publish_media_backfill_avatar',
  'publish_media_backfill_banner', 'publish_media_backfill_cover', 'publish_media_backfill_highlight',
  'publish_media_backfill_skill', 'publish_media_backfill_social', 'publish_media_backfill_video',
].sort();
const RLS_TABLES = [
  'commerce_resource_tenants',
  'tenants', 'tenant_memberships', 'tenant_module_permissions', 'tenant_invitations', 'workspaces', 'tenant_authority_audit', 'module_instances',
  'tenant_high_risk_verifications', 'tenant_ownership_transfers', 'tenant_recovery_cases',
  'application_installations', 'application_module_links', 'capacity_ledger', 'capacity_reservations',
  'module_dependencies', 'module_launch_plan_consumptions', 'module_launch_plans',
  'module_provision_operations', 'module_provision_steps',
  'deployment_bindings', 'workspace_module_bindings', 'tenant_work_results', 'tenant_work_result_targets',
  'tenant_capacity_policies', 'work_items', 'scoped_command_receipts', 'scoped_transition_journal', 'scoped_outbox',
];
const sha = 'ab'.repeat(32);
let created = false;
let pid = 0;

interface Person { userId: string; principalId: string; personalScopeId: string }
interface Space {
  tenantId: string; scopeId: string; workspaceId: string; instanceId: string; bindingId: string;
  workId: string; resultId: string; invitationId: string; auditId: string; receiptKey: string;
  transitionId: string; eventId: string; policyId: string;
}
const people: { p1: Person; p2: Person; p3: Person } = {
  p1: { userId: '', principalId: '', personalScopeId: '' },
  p2: { userId: '', principalId: '', personalScopeId: '' },
  p3: { userId: '', principalId: '', personalScopeId: '' },
};
const spaces: { a: Space; b: Space } = { a: blankSpace(), b: blankSpace() };
let personalWorkId = '';
let personalReceiptKey = '';
let personalTransitionId = '';
let personalEventId = '';
let defaultPolicyId = '';

function blankSpace(): Space {
  return {
    tenantId: randomUUID(), scopeId: randomUUID(), workspaceId: randomUUID(), instanceId: randomUUID(),
    bindingId: randomUUID(), workId: randomUUID(), resultId: randomUUID(), invitationId: randomUUID(),
    auditId: randomUUID(), receiptKey: `receipt${randomUUID().replaceAll('-', '').slice(0, 16)}`,
    transitionId: randomUUID(), eventId: randomUUID(), policyId: randomUUID(),
  };
}
const sqlCode = (code: string) => (error: unknown) => (error as { code?: string }).code === code;
function unset(value: unknown) { return value == null || value === ''; }
function log(check: string, payload: Record<string, unknown>) {
  console.log(JSON.stringify({ check, ...payload }));
}
async function column(q: Pool | PoolClient, sql: string, params: unknown[] = []): Promise<string[]> {
  const rows = (await q.query<{ id: string }>(sql, params)).rows;
  return rows.map(row => row.id).sort();
}
async function backend(q: PoolClient): Promise<number> {
  return Number((await q.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid);
}
async function bindSpace(q: PoolClient, person: Person, space: Space) {
  await bindPrincipalContext(q, person.principalId);
  await bindTenantContext(q, { tenantId: space.tenantId, tenantScopeId: space.scopeId });
}
async function setting(q: Pool | PoolClient, name: string): Promise<string | null> {
  return (await q.query<{ value: string | null }>(`SELECT pg_catalog.current_setting($1, true) AS value`, [name])).rows[0].value;
}

async function applyGrants() {
  const template = await readFile(new URL('../../deploy/cloudflare/sql/20-runtime-grants.psql', import.meta.url), 'utf8');
  const general = template.slice(template.indexOf('BEGIN;'), template.indexOf('-- BEGIN PRIVATE POLICY GRANTS'))
    .replaceAll('SCHEMA public', `SCHEMA ${schema}`).replaceAll(':"runtime"', `"${runtimeRole}"`);
  const capacity = template.split('-- BEGIN TENANT CAPACITY POLICY GRANTS\n')[1].split('\n\\gexec')[0]
    .replaceAll(":'runtime'", `'${runtimeRole}'`).replace("n.nspname='public'", `n.nspname='${schema}'`);
  const q = await owner.connect();
  try {
    await q.query(general);
    const statements = await q.query(capacity);
    assert.equal(statements.rowCount, 1);
    await q.query(Object.values(statements.rows[0])[0] as string);
    await q.query('COMMIT');
  } catch (error) {
    try { await q.query('ROLLBACK'); } catch { /* keep the grant error */ }
    throw error;
  } finally { q.release(); }
}

async function person(email: string): Promise<Person> {
  const userId = randomUUID();
  const principalId = randomUUID();
  const personalScopeId = randomUUID();
  await owner.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,(SELECT community_id FROM communities LIMIT 1),$2,$3,'not-a-login',$4)`,
  [userId, email, email, randomUUID()]);
  await owner.query(`INSERT INTO principals(principal_id,kind,user_ref) VALUES($1,'person',$2)`, [principalId, userId]);
  await owner.query(`INSERT INTO resource_scopes(scope_id,kind,owner_principal_id) VALUES($1,'personal',$2)`, [personalScopeId, principalId]);
  return { userId, principalId, personalScopeId };
}

async function publishResult(q: PoolClient, space: Space, author: Person) {
  const assetId = randomUUID();
  const representationId = randomUUID();
  const intentId = randomUUID();
  await q.query(`INSERT INTO assets(asset_id,scope_id,owner_principal_id,owner_user_id,policy_revision,representation_id,purpose,scope_kind,tenant_ref)
    VALUES($1,$2,$3,$4,'synthetic.r1',$5,'work.tenant-result','tenant',$6)`,
  [assetId, space.scopeId, author.principalId, author.userId, representationId, space.tenantId]);
  await q.query(`INSERT INTO asset_upload_intents(intent_id,asset_id,representation_id,scope_id,owner_principal_id,target_user_id,policy_revision,prepare_key,request_digest,source_content_type,source_byte_size,source_sha256,expected_version,expires_at,purpose,reserved_bytes,target_kind,target_work_id,target_tenant_id,display_name)
    VALUES($1,$2,$3,$4,$5,$6,'synthetic.r1',$7,$8,'text/plain',4,$9,1,clock_timestamp()+interval '2 hours','work.tenant-result',262144,'work.tenant-result',$10,$11,'note.txt')`,
  [intentId, assetId, representationId, space.scopeId, author.principalId, author.userId, `prepare${intentId.replaceAll('-', '').slice(0, 12)}`, sha, sha, space.workId, space.tenantId]);
  await q.query(`UPDATE asset_upload_intents SET state='processing', fence=1, lease_token=$2, lease_expires_at=expires_at WHERE intent_id=$1`, [intentId, randomUUID()]);
  await q.query(`INSERT INTO asset_objects(asset_id,scope_id,representation_id,content_type,byte_size,content_sha256,transform_version,policy_revision,purpose,variant)
    VALUES($1,$2,$3,'text/plain',4,$4,'private-text.utf8.v1','synthetic.r1','work.tenant-result','draft')`,
  [assetId, space.scopeId, representationId, sha]);
  await q.query(`UPDATE assets SET state='ready', ready_at=clock_timestamp() WHERE asset_id=$1`, [assetId]);
  await q.query(`UPDATE asset_upload_intents SET state='stored' WHERE intent_id=$1`, [intentId]);
  await q.query(`INSERT INTO tenant_work_results(result_id,intent_id) VALUES($1,$2)`, [space.resultId, intentId]);
  await q.query(`UPDATE asset_upload_intents SET state='finalized', finalized_at=clock_timestamp() WHERE intent_id=$1`, [intentId]);
}

async function installSpace(space: Space, author: Person, invitee: Person) {
  const guild = (await owner.query<{ guild_key: string }>('SELECT guild_key FROM positioning_guild_catalog ORDER BY guild_key LIMIT 1')).rows[0].guild_key;
  const q = await owner.connect();
  try {
    await q.query('BEGIN');
    await q.query(`INSERT INTO tenants(tenant_id,community_id,display_name,created_by_principal_id)
      VALUES($1,(SELECT community_id FROM communities LIMIT 1),'Same Guild',$2)`, [space.tenantId, author.principalId]);
    await q.query(`INSERT INTO resource_scopes(scope_id,kind,tenant_ref) VALUES($1,'tenant',$2)`, [space.scopeId, space.tenantId]);
    await q.query(`INSERT INTO tenant_memberships(tenant_id,principal_id,role,status,accepted_at)
      VALUES($1,$2,'owner','active',clock_timestamp())`, [space.tenantId, author.principalId]);
    await q.query(`INSERT INTO workspaces(workspace_id,tenant_id,name,is_default) VALUES($1,$2,'Counter',true)`, [space.workspaceId, space.tenantId]);
    await q.query(`INSERT INTO tenant_authority_audit(event_id,tenant_id,actor_principal_id,action,target_principal_id,old_revision,new_revision,reason_code)
      VALUES($1,$2,$3,'tenant.create',$3,1,1,'tenant.created')`, [space.auditId, space.tenantId, author.principalId]);
    await q.query(`INSERT INTO module_instances(
        instance_id, tenant_id, module_key, application_release_ref, module_release_ref, data_schema_version,
        contract_ref, status, binding_id, created_by_principal_id, origin_guild_key)
      SELECT $1, $2, 'work', 'manual-workspace@1.0.0', 'work@1.0.0', '1', contract_ref, 'active', $3, $4, $5
      FROM module_definitions WHERE module_key = 'work' AND release_ref = 'work@1.0.0'`,
    [space.instanceId, space.tenantId, space.bindingId, author.principalId, guild]);
    await q.query(`INSERT INTO deployment_bindings(
        binding_id, tenant_id, instance_id, mode, environment, endpoint_ref, service_principal_id, contract_ref, state)
      SELECT $1, $2, $3, 'hosted', 'hosted-shared', NULL, NULL, contract_ref, 'active'
      FROM module_definitions WHERE module_key = 'work' AND release_ref = 'work@1.0.0'`,
    [space.bindingId, space.tenantId, space.instanceId]);
    await q.query(`INSERT INTO workspace_module_bindings(tenant_id,workspace_id,entry_capability,instance_id)
      VALUES($1,$2,'work:create',$3)`, [space.tenantId, space.workspaceId, space.instanceId]);
    await q.query(`INSERT INTO work_items(work_item_id,work_mode,scope_id,owner_ref,owner_principal_id,community_id,title,objective,state,tenant_id,instance_id,workspace_id,created_by_principal_id,progress,updated_at,participation_terms_revision)
      VALUES($1,'tenant_execution',$2,$3,NULL,NULL,$4,'Keep this note','draft',$5,$6,$7,$8,'todo',clock_timestamp(),NULL)`,
    [space.workId, space.scopeId, author.userId, `note-${space.tenantId}`, space.tenantId, space.instanceId, space.workspaceId, author.principalId]);
    await publishResult(q, space, author);
    await q.query(`INSERT INTO tenant_invitations(invitation_id,tenant_id,invitee_principal_id,role,instance_capabilities,expires_at,state,created_by_principal_id)
      VALUES($1,$2,$3,'viewer','[]'::jsonb,clock_timestamp()+interval '3 days','pending',$4)`,
    [space.invitationId, space.tenantId, invitee.principalId, author.principalId]);
    await q.query(`INSERT INTO tenant_capacity_policies(policy_id,revision,tenant_id,plan_ref,max_active_instances,max_instances_per_module,max_concurrent_provisions,max_work_items,max_retained_bytes,max_concurrent_jobs,max_model_budget,status)
      VALUES($1,1,$2,'synthetic-F-GUILD-TWO-TENANTS-v1',10,3,2,1000,104857600,4,NULL,'active')`, [space.policyId, space.tenantId]);
    await q.query(`INSERT INTO scoped_command_receipts(principal_id,authn_kind,scope_id,operation,idempotency_key,principal_kind,scope_kind,target_kind,target_id,request_sha256,response)
      VALUES($1,'member_session',$2,'tenant.fixture',$3,'person','tenant','tenant',$4,$5,'{}'::jsonb)`,
    [author.principalId, space.scopeId, space.receiptKey, space.tenantId, sha]);
    await q.query(`INSERT INTO scoped_transition_journal(transition_id,scope_id,scope_kind,principal_id,principal_kind,authn_kind,aggregate_type,aggregate_id,aggregate_version,operation,data)
      VALUES($1,$2,'tenant',$3,'person','member_session','tenant',$4,1,'tenant.fixture','{}'::jsonb)`,
    [space.transitionId, space.scopeId, author.principalId, space.tenantId]);
    await q.query(`INSERT INTO scoped_outbox(event_id,transition_id,scope_id,scope_kind,event_type,payload)
      VALUES($1,$2,$3,'tenant','freedom.tenant.fixture.v1','{}'::jsonb)`,
    [space.eventId, space.transitionId, space.scopeId]);
    await q.query('COMMIT');
  } catch (error) {
    try { await q.query('ROLLBACK'); } catch { /* keep the fixture error */ }
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
  const community = randomUUID();
  await owner.query(`INSERT INTO communities VALUES($1,'Synthetic two tenants')`, [community]);
  people.p1 = await person('p1@example.test');
  people.p2 = await person('p2@example.test');
  people.p3 = await person('p3@example.test');
  defaultPolicyId = randomUUID();
  await owner.query(`INSERT INTO tenant_capacity_policies(policy_id,revision,tenant_id,plan_ref,max_active_instances,max_instances_per_module,max_concurrent_provisions,max_work_items,max_retained_bytes,max_concurrent_jobs,max_model_budget,status)
    VALUES($1,1,NULL,'synthetic-F-GUILD-TWO-TENANTS-v1',10,3,2,1000,104857600,4,NULL,'active')`, [defaultPolicyId]);
  await installSpace(spaces.a, people.p1, people.p3);
  await installSpace(spaces.b, people.p2, people.p1);
  await owner.query(`INSERT INTO tenant_memberships(tenant_id,principal_id,role,status,accepted_at)
    VALUES($1,$2,'viewer','active',clock_timestamp())`, [spaces.b.tenantId, people.p1.principalId]);
  personalWorkId = randomUUID();
  await owner.query(`INSERT INTO work_items(work_item_id,work_mode,scope_id,owner_principal_id,owner_ref,title,objective,state,participation_terms_revision)
    VALUES($1,'personal_execution',$2,$3,$4,'Personal note','Visible without a tenant','draft',NULL)`,
  [personalWorkId, people.p1.personalScopeId, people.p1.principalId, people.p1.userId]);
  personalReceiptKey = `personal${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  personalTransitionId = randomUUID();
  personalEventId = randomUUID();
  await owner.query(`INSERT INTO scoped_command_receipts(principal_id,authn_kind,scope_id,operation,idempotency_key,principal_kind,scope_kind,target_kind,target_id,request_sha256,response)
    VALUES($1,'member_session',$2,'tenant.fixture',$3,'person','personal','work',$4,$5,'{}'::jsonb)`,
  [people.p1.principalId, people.p1.personalScopeId, personalReceiptKey, personalWorkId, sha]);
  await owner.query(`INSERT INTO scoped_transition_journal(transition_id,scope_id,scope_kind,principal_id,principal_kind,authn_kind,aggregate_type,aggregate_id,aggregate_version,operation,data)
    VALUES($1,$2,'personal',$3,'person','member_session','work',$4,1,'tenant.fixture','{}'::jsonb)`,
  [personalTransitionId, people.p1.personalScopeId, people.p1.principalId, personalWorkId]);
  await owner.query(`INSERT INTO scoped_outbox(event_id,transition_id,scope_id,scope_kind,event_type,payload)
    VALUES($1,$2,$3,'personal','freedom.tenant.fixture.v1','{}'::jsonb)`,
  [personalEventId, personalTransitionId, people.p1.personalScopeId]);
});

after(async () => {
  await runtime.end();
  await owner.end();
  try {
    if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE; DROP ROLE ${runtimeRole}; DROP ROLE ${migrator}`);
  } finally { await admin.end(); }
});

async function visible(q: PoolClient) {
  return {
    tenants: await column(q, 'SELECT tenant_id AS id FROM tenants'),
    memberships: await column(q, `SELECT tenant_id::text || ':' || principal_id::text AS id FROM tenant_memberships`),
    invitations: await column(q, 'SELECT invitation_id AS id FROM tenant_invitations'),
    workspaces: await column(q, 'SELECT workspace_id AS id FROM workspaces'),
    audit: await column(q, 'SELECT event_id AS id FROM tenant_authority_audit'),
    instances: await column(q, 'SELECT instance_id AS id FROM module_instances'),
    deployments: await column(q, 'SELECT binding_id AS id FROM deployment_bindings'),
    bindings: await column(q, `SELECT tenant_id::text || ':' || workspace_id::text AS id FROM workspace_module_bindings`),
    results: await column(q, 'SELECT result_id AS id FROM tenant_work_results'),
    targets: await column(q, 'SELECT work_item_id AS id FROM tenant_work_result_targets'),
    capacity: await column(q, 'SELECT policy_id AS id FROM tenant_capacity_policies'),
    work: await column(q, 'SELECT work_item_id AS id FROM work_items'),
    receipts: await column(q, 'SELECT idempotency_key AS id FROM scoped_command_receipts'),
    journal: await column(q, 'SELECT transition_id AS id FROM scoped_transition_journal'),
    outbox: await column(q, 'SELECT event_id AS id FROM scoped_outbox'),
  };
}
function pair(tenantId: string, principalId: string) { return `${tenantId}:${principalId}`; }
function tenantSlice(space: Space) {
  return {
    tenants: [space.tenantId],
    memberships: space === spaces.a
      ? [pair(space.tenantId, people.p1.principalId)]
      : [pair(space.tenantId, people.p1.principalId), pair(space.tenantId, people.p2.principalId)].sort(),
    invitations: [space.invitationId],
    workspaces: [space.workspaceId],
    audit: [space.auditId],
    instances: [space.instanceId],
    deployments: [space.bindingId],
    bindings: [`${space.tenantId}:${space.workspaceId}`],
    results: [space.resultId],
    targets: [space.workId],
    capacity: [defaultPolicyId, space.policyId].sort(),
    work: [personalWorkId, space.workId].sort(),
    receipts: [personalReceiptKey, space.receiptKey].sort(),
    journal: [personalTransitionId, space.transitionId].sort(),
    outbox: [personalEventId, space.eventId].sort(),
  };
}
const personalOnly = () => ({
  tenants: [], memberships: [], invitations: [], workspaces: [], audit: [], instances: [], deployments: [],
  bindings: [], results: [], targets: [], capacity: [defaultPolicyId], work: [personalWorkId],
  receipts: [personalReceiptKey], journal: [personalTransitionId], outbox: [personalEventId],
});

async function expectEmptyContext(q: PoolClient) {
  assert.equal(unset(await setting(q, 'freedom.principal_id')), true);
  assert.equal(unset(await setting(q, 'freedom.tenant_id')), true);
  assert.equal(unset(await setting(q, 'freedom.tenant_scope_id')), true);
  assert.equal(unset(await setting(q, 'freedom.platform_admin_id')), true);
  assert.deepEqual(await visible(q), personalOnly());
}

test('T-024 runtime role is not the table owner and row security is enabled without FORCE', async () => {
  const who = (await runtime.query(`SELECT current_user, session_user, rolsuper, rolbypassrls, pg_backend_pid() AS pid
    FROM pg_roles WHERE rolname = current_user`)).rows[0];
  const flags = (await owner.query(`SELECT c.relname AS table, c.relrowsecurity, c.relforcerowsecurity,
      COALESCE(array_agg(p.polname ORDER BY p.polname) FILTER (WHERE p.polname IS NOT NULL), ARRAY[]::text[]) AS policies
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_policy p ON p.polrelid = c.oid
    WHERE n.nspname = $1 AND c.relkind = 'r' AND (c.relrowsecurity OR c.relname = ANY($2::text[]))
    GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity
    ORDER BY c.relname`, [schema, RLS_TABLES])).rows;
  const owners = (await owner.query<{ owner: string }>(`SELECT DISTINCT pg_catalog.pg_get_userbyid(c.relowner) AS owner
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relkind = 'r'`, [schema])).rows.map(row => row.owner);
  log('runtime-role', { current_user: who.current_user, session_user: who.session_user, rolsuper: who.rolsuper, rolbypassrls: who.rolbypassrls, pg_backend_pid: Number(who.pid), table_owners: owners, tables: flags });
  assert.equal(who.current_user, runtimeRole);
  assert.equal(who.session_user, runtimeRole);
  assert.equal(who.rolsuper, false);
  assert.equal(who.rolbypassrls, false);
  assert.deepEqual(owners, [migrator]);
  assert.equal((await runtime.query(`SELECT has_schema_privilege(current_user,$1,'CREATE') AS create`, [schema])).rows[0].create, false);
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
    WHERE n.nspname = $1 AND r.rolname = $2`, [schema, runtimeRole])).rows[0].n, 0);
  for (const row of flags as Array<{ table: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>) {
    if (RLS_TABLES.includes(row.table)) {
      assert.equal(row.relrowsecurity, true, row.table);
      assert.equal(row.relforcerowsecurity, false, row.table);
    }
  }
});

test('T-024 one pooled connection cycles tenant A, tenant B, no context, and back to A', async () => {
  await isolatedTransaction(runtime, async q => {
    pid = await backend(q);
    await bindSpace(q, people.p1, spaces.a);
    assert.deepEqual(await visible(q), tenantSlice(spaces.a));
  });
  await isolatedTransaction(runtime, async q => {
    assert.equal(await backend(q), pid);
    await bindSpace(q, people.p2, spaces.b);
    assert.deepEqual(await visible(q), tenantSlice(spaces.b));
  });
  await isolatedTransaction(runtime, async q => {
    assert.equal(await backend(q), pid);
    await expectEmptyContext(q);
  });
  await isolatedTransaction(runtime, async q => {
    assert.equal(await backend(q), pid);
    await bindSpace(q, people.p1, spaces.a);
    assert.deepEqual(await visible(q), tenantSlice(spaces.a));
  });
  await isolatedTransaction(runtime, async q => {
    assert.equal(await backend(q), pid);
    await expectEmptyContext(q);
  });
});

test('T-024 principal-only context shows the cross-tenant listing rows and nothing else', async () => {
  await isolatedTransaction(runtime, async q => {
    assert.equal(await backend(q), pid);
    await bindPrincipalContext(q, people.p1.principalId);
    assert.deepEqual(await visible(q), {
      ...personalOnly(),
      tenants: [spaces.a.tenantId, spaces.b.tenantId].sort(),
      memberships: [pair(spaces.a.tenantId, people.p1.principalId), pair(spaces.b.tenantId, people.p1.principalId)].sort(),
      invitations: [spaces.b.invitationId],
      workspaces: [spaces.a.workspaceId, spaces.b.workspaceId].sort(),
    });
  });
  await isolatedTransaction(runtime, async q => {
    await bindPrincipalContext(q, people.p3.principalId);
    assert.deepEqual(await visible(q), {
      ...personalOnly(),
      tenants: [spaces.a.tenantId],
      invitations: [spaces.a.invitationId],
    });
  });
  await isolatedTransaction(runtime, async q => {
    await bindPrincipalContext(q, people.p2.principalId);
    assert.deepEqual(await visible(q), {
      ...personalOnly(),
      tenants: [spaces.b.tenantId],
      memberships: [pair(spaces.b.tenantId, people.p2.principalId)],
      workspaces: [spaces.b.workspaceId],
    });
  });
  await isolatedTransaction(runtime, async q => { await expectEmptyContext(q); });
});

test('T-024 exception, timeout, cancel, and deferred owner failure leave the next transaction empty', async () => {
  await assert.rejects(isolatedTransaction(runtime, async q => {
    await bindSpace(q, people.p1, spaces.a);
    throw new Error('synthetic-failure');
  }), (error: Error) => error.message === 'synthetic-failure');
  await isolatedTransaction(runtime, async q => {
    assert.equal(await backend(q), pid);
    await expectEmptyContext(q);
  });

  await assert.rejects(isolatedTransaction(runtime, async q => {
    await bindSpace(q, people.p1, spaces.a);
    await q.query(`SET LOCAL statement_timeout = '100ms'`);
    await q.query('SELECT pg_sleep(1)');
  }), sqlCode('57014'));
  await isolatedTransaction(runtime, async q => {
    assert.equal(await backend(q), pid);
    await expectEmptyContext(q);
  });

  let ready = () => {};
  const gate = new Promise<void>(resolve => { ready = resolve; });
  const cancelled = isolatedTransaction(runtime, async q => {
    await bindSpace(q, people.p1, spaces.a);
    assert.equal(await backend(q), pid);
    ready();
    await q.query('SELECT pg_sleep(30)');
  });
  await gate;
  await admin.query('SELECT pg_cancel_backend($1)', [pid]);
  await assert.rejects(cancelled, sqlCode('57014'));
  await isolatedTransaction(runtime, async q => {
    assert.equal(await backend(q), pid);
    await expectEmptyContext(q);
  });

  await assert.rejects(isolatedTransaction(runtime, async q => {
    await bindSpace(q, people.p1, spaces.a);
    const updated = await q.query(`UPDATE tenant_memberships SET status='revoked', revoked_at=clock_timestamp()
      WHERE tenant_id=$1 AND principal_id=$2 AND role='owner'`, [spaces.a.tenantId, people.p1.principalId]);
    assert.equal(updated.rowCount, 1);
  }), sqlCode('23514'));
  const still = (await owner.query<{ status: string; role: string }>(`SELECT status, role FROM tenant_memberships
    WHERE tenant_id=$1 AND principal_id=$2`, [spaces.a.tenantId, people.p1.principalId])).rows[0];
  assert.deepEqual(still, { status: 'active', role: 'owner' });
  await isolatedTransaction(runtime, async q => {
    assert.equal(await backend(q), pid);
    await expectEmptyContext(q);
  });
});

test('T-024 a failed rollback destroys the client and the next connection has no context', async () => {
  let ready = () => {};
  const gate = new Promise<void>(resolve => { ready = resolve; });
  const beforeCount = runtime.totalCount;
  const terminated = isolatedTransaction(runtime, async q => {
    await bindSpace(q, people.p1, spaces.a);
    assert.equal(await backend(q), pid);
    ready();
    await q.query('SELECT pg_sleep(30)');
  });
  await gate;
  await admin.query('SELECT pg_terminate_backend($1)', [pid]);
  const error = await terminated.then(() => { throw new Error('terminate should fail the callback'); }, (caught: unknown) => caught) as { code?: string; cause?: unknown };
  assert.equal(error.code, '57P01');
  assert.ok(error.cause);
  assert.ok(runtime.totalCount < beforeCount || runtime.totalCount === 0);
  const next = await runtime.query<{ pid: number; tenant: string | null; n: number }>(
    `SELECT pg_backend_pid() AS pid, pg_catalog.current_setting('freedom.tenant_id', true) AS tenant, (SELECT count(*)::int FROM tenants) AS n`);
  assert.notEqual(Number(next.rows[0].pid), pid);
  assert.equal(unset(next.rows[0].tenant), true);
  assert.equal(next.rows[0].n, 0);
  pid = Number(next.rows[0].pid);
});

async function recoveryAdmin(): Promise<AdminActor> {
  const communityId = (await owner.query<{ community_id: string }>('SELECT community_id FROM users WHERE user_id=$1', [people.p1.userId])).rows[0].community_id;
  const actor: AdminActor = {
    admin_id: randomUUID(), community_id: communityId, email: 'recovery-admin@example.test',
    display_name: 'Recovery fixture', role: 'super_admin', subject: 'synthetic-admin',
  };
  actor.email = `recovery-${actor.admin_id}@example.test`;
  await owner.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)',
    [actor.admin_id, communityId, actor.email, actor.display_name]);
  return actor;
}

/** The injected errors do not abort PostgreSQL's transaction. A release without
 * an error would put this still-queryable, context-bearing client back in pg-pool. */
async function adminRollbackFailure(run: (pool: Pool) => Promise<unknown>, failAt: RegExp, principalId: string | null) {
  const faultPool = new Pool({ connectionString: roleUrl(runtimeRole), options: `-c search_path=${schema}`, max: 1 });
  const q = await faultPool.connect();
  const oldPid = await backend(q);
  const query = q.query.bind(q);
  const original = new Error('synthetic admin callback failure');
  const rollback = new Error('synthetic rollback failure');
  const removed = once(faultPool, 'remove', { signal: AbortSignal.timeout(5000) });
  void removed.catch(() => undefined);
  let failed = false;
  let rollbackAttempted = false;
  async function assertBoundAndQueryable() {
    assert.equal((await query('SELECT 1 AS ok')).rows[0].ok, 1);
    const context = (await query(`SELECT current_setting('freedom.tenant_id', true) AS tenant,
      current_setting('freedom.principal_id', true) AS principal`)).rows[0];
    assert.equal(context.tenant, spaces.a.tenantId);
    if (principalId === null) assert.equal(unset(context.principal), true);
    else assert.equal(context.principal, principalId);
    assert.ok(q.listenerCount('error') > 0, 'the checked-out client retains its error listener');
  }
  q.query = (async (sql: string, ...args: unknown[]) => {
    if (sql === 'ROLLBACK') {
      rollbackAttempted = true;
      await assertBoundAndQueryable();
      throw rollback;
    }
    if (failAt.test(sql)) {
      failed = true;
      await assertBoundAndQueryable();
      throw original;
    }
    return (query as (...args: unknown[]) => Promise<unknown>)(sql, ...args);
  }) as typeof q.query;
  q.release();
  try {
    await assert.rejects(run(faultPool), error => error === original);
    assert.equal(failed, true);
    assert.equal(rollbackAttempted, true);
    assert.equal(original.cause, rollback);
    assert.deepEqual(await removed, [q]);
    assert.equal(faultPool.totalCount, 0);
    assert.equal(faultPool.idleCount, 0);
    const next = await faultPool.connect();
    try {
      assert.notEqual(await backend(next), oldPid);
      for (const name of ['freedom.tenant_id', 'freedom.principal_id', 'freedom.tenant_scope_id', 'freedom.platform_admin_id']) {
        assert.equal(unset(await setting(next, name)), true, name);
      }
      assert.equal((await next.query('SELECT tenant_id FROM tenants')).rowCount, 0);
    } finally { next.release(); }
  } finally { await faultPool.end(); }
}

test('T-024 recovery open preserves the original error and destroys a queryable client when rollback fails', async () => {
  const actor = await recoveryAdmin();
  await owner.query(`INSERT INTO platform_admin_tenant_recovery_capabilities(admin_id,capability) VALUES($1,'tenant.recovery.open')`, [actor.admin_id]);
  await owner.query(`INSERT INTO tenant_authority_policies(revision,status,fresh_auth_ttl_seconds,transfer_ttl_seconds,recovery_approval_ttl_seconds,max_open_recovery_cases_per_tenant)
    VALUES(1,'active',600,86400,86400,1)`);
  const template = await readFile(new URL('../../deploy/cloudflare/sql/20-runtime-grants.psql', import.meta.url), 'utf8');
  const authority = template.split('-- BEGIN TENANT AUTHORITY POLICY GRANTS\n')[1].split('\n\\gexec')[0]
    .replaceAll(":'runtime'", `'${runtimeRole}'`).replaceAll("n.nspname='public'", `n.nspname='${schema}'`);
  for (const row of (await owner.query(authority)).rows) await owner.query(Object.values(row)[0] as string);
  const input: AdminCommand = {
    admin: actor, operation: 'tenant.recovery.open', key: randomUUID(),
    body: { tenant_id: spaces.a.tenantId, proposed_owner_principal_id: people.p3.principalId, reason: 'Synthetic recovery', evidence_ref: randomUUID() },
  };
  await adminRollbackFailure(pool => openRecoveryCase(pool, input), /SELECT status, community_id, authorization_revision/, null);
  assert.equal((await owner.query('SELECT case_id FROM tenant_recovery_cases WHERE tenant_id=$1', [spaces.a.tenantId])).rowCount, 0);
});

test('T-024 account deactivation preserves the original error and destroys a queryable client when rollback fails', async () => {
  const actor = await recoveryAdmin();
  const prior = (await owner.query('SELECT active,admin_status_version FROM users WHERE user_id=$1', [people.p1.userId])).rows[0];
  const input: AdminCommand = {
    admin: actor, operation: 'member_status', key: randomUUID(), expected: String(prior.admin_status_version),
    body: { active: false, reason: 'Synthetic deactivation' },
  };
  await adminRollbackFailure(pool => changeMemberStatus(pool, input, people.p1.userId), /SELECT tenant_id FROM tenants WHERE tenant_id=\$1 FOR UPDATE/, people.p1.principalId);
  assert.deepEqual((await owner.query('SELECT active,admin_status_version FROM users WHERE user_id=$1', [people.p1.userId])).rows[0], prior);
});

test('T-024 direct SQL cannot read or retarget the other tenant, and a personal insert needs no context', async () => {
  await isolatedTransaction(runtime, async q => {
    await bindSpace(q, people.p1, spaces.a);
    assert.equal((await q.query('SELECT tenant_id FROM tenants WHERE tenant_id=$1', [spaces.b.tenantId])).rowCount, 0);
    assert.equal((await q.query(`UPDATE tenants SET display_name='stolen' WHERE tenant_id=$1`, [spaces.b.tenantId])).rowCount, 0);
    assert.equal((await q.query('DELETE FROM workspaces WHERE workspace_id=$1', [spaces.b.workspaceId])).rowCount, 0);
  });
  const unchanged = (await owner.query<{ tenant_id: string; display_name: string }>(
    'SELECT tenant_id, display_name FROM tenants WHERE tenant_id=$1', [spaces.a.tenantId])).rows[0];
  await assert.rejects(isolatedTransaction(runtime, async q => {
    await bindSpace(q, people.p1, spaces.a);
    await q.query(`INSERT INTO tenant_memberships(tenant_id,principal_id,role,status,accepted_at)
      VALUES($1,$2,'viewer','active',clock_timestamp())`, [spaces.b.tenantId, people.p3.principalId]);
  }), sqlCode('42501'));
  await assert.rejects(isolatedTransaction(runtime, async q => {
    await bindSpace(q, people.p1, spaces.a);
    await q.query(`INSERT INTO tenants(tenant_id,community_id,display_name,created_by_principal_id)
      VALUES($1,(SELECT community_id FROM communities LIMIT 1),'Fresh',$2)`, [randomUUID(), people.p1.principalId]);
  }), sqlCode('42501'));
  await assert.rejects(isolatedTransaction(runtime, async q => {
    await bindSpace(q, people.p1, spaces.a);
    await q.query('UPDATE tenants SET tenant_id=$2 WHERE tenant_id=$1', [spaces.a.tenantId, spaces.b.tenantId]);
  }), (error: { code?: string }) => error.code === '42501' || error.code === '23505' || error.code === '23514');
  assert.deepEqual((await owner.query('SELECT tenant_id, display_name FROM tenants WHERE tenant_id=$1', [spaces.a.tenantId])).rows[0], unchanged);
  await assert.rejects(isolatedTransaction(runtime, async q => {
    await bindSpace(q, people.p1, spaces.a);
    await q.query(`INSERT INTO workspace_module_bindings(tenant_id,workspace_id,entry_capability,instance_id)
      VALUES($1,$2,'work:create',$3)`, [spaces.a.tenantId, spaces.b.workspaceId, spaces.a.instanceId]);
  }), sqlCode('23503'));
  for (const sql of [
    'TRUNCATE tenants',
    `SET ROLE ${migrator}`,
    'ALTER TABLE tenants DISABLE ROW LEVEL SECURITY',
    'CREATE POLICY tenants_extra ON tenants FOR SELECT TO PUBLIC USING (false)',
    `CREATE FUNCTION e1_definer_probe() RETURNS integer LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$`,
  ]) {
    await assert.rejects(isolatedTransaction(runtime, async q => {
      await bindSpace(q, people.p1, spaces.a);
      await q.query(sql);
    }), sqlCode('42501'));
  }
  await assert.rejects(isolatedTransaction(runtime, async q => {
    await bindSpace(q, people.p1, spaces.a);
    await q.query('SET LOCAL row_security = off');
    await q.query('SELECT tenant_id FROM tenants');
  }), sqlCode('42501'));

  const barePersonal = randomUUID();
  await isolatedTransaction(runtime, async q => {
    await expectEmptyContext(q);
    await q.query(`INSERT INTO work_items(work_item_id,work_mode,scope_id,owner_principal_id,owner_ref,title,objective,state,participation_terms_revision)
      VALUES($1,'personal_execution',$2,$3,$4,'Context free','No tenant binding','draft',NULL)`,
    [barePersonal, people.p1.personalScopeId, people.p1.principalId, people.p1.userId]);
  });
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM work_items WHERE work_item_id=$1', [barePersonal])).rows[0].n, 1);
});

test('T-024 autocommit and a second tenant bind cannot install a context', async () => {
  await runtime.query(`SELECT pg_catalog.set_config('freedom.tenant_id', $1, true)`, [spaces.a.tenantId]);
  const leaked = await runtime.query<{ n: number; tenant: string | null }>(
    `SELECT count(*)::int AS n, pg_catalog.current_setting('freedom.tenant_id', true) AS tenant FROM tenants`);
  assert.equal(leaked.rows[0].n, 0);
  assert.equal(unset(leaked.rows[0].tenant), true);
  const client = await runtime.connect();
  try {
    await assert.rejects(bindTenantContext(client, { tenantId: spaces.a.tenantId, tenantScopeId: spaces.a.scopeId }),
      (error: { status?: number; code?: string }) => error.status === 500 && error.code === 'tenant_context_unavailable');
  } finally { client.release(); }
  await isolatedTransaction(runtime, async q => {
    await bindTenantContext(q, { tenantId: spaces.a.tenantId, tenantScopeId: spaces.a.scopeId });
    await assert.rejects(bindTenantContext(q, { tenantId: spaces.b.tenantId, tenantScopeId: spaces.b.scopeId }),
      (error: { status?: number; code?: string }) => error.status === 500 && error.code === 'tenant_context_unavailable');
    assert.equal(await setting(q, 'freedom.tenant_id'), spaces.a.tenantId);
    assert.equal((await q.query('SELECT count(*)::int AS n FROM tenants')).rows[0].n, 1);
  });
});

test('T-024 definer inventory is unchanged and does not name an RLS table', async () => {
  const rows = (await owner.query<{ proname: string; prosrc: string }>(`SELECT p.proname, p.prosrc
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = $1 AND p.prosecdef ORDER BY p.proname`, [schema])).rows;
  assert.deepEqual(rows.map(row => row.proname), DEFINERS);
  for (const row of rows) {
    for (const table of RLS_TABLES) assert.equal(row.prosrc.includes(table), false, `${row.proname} names ${table}`);
  }
  const ctx = (await owner.query<{ proname: string; prosecdef: boolean }>(`SELECT proname, prosecdef FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = $1 AND proname LIKE 'freedom_ctx_%' ORDER BY proname`, [schema])).rows;
  assert.deepEqual(ctx, [
    { proname: 'freedom_ctx_platform_admin', prosecdef: false },
    { proname: 'freedom_ctx_principal', prosecdef: false },
    { proname: 'freedom_ctx_tenant', prosecdef: false },
    { proname: 'freedom_ctx_tenant_scope', prosecdef: false },
  ]);
});
