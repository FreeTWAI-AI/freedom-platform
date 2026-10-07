import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { createApp } from '../../apps/platform-api/src/app.js';
import { authenticate } from '../../modules/identity-membership/service.js';
import { WORK_CONTRACT_SOURCE_COMMIT } from '../../modules/module-registry/definitions.js';
import { launchApplication, sweepDueOperations } from '../../modules/module-registry/service.js';
import { bindTenantContext } from '../../packages/resource-scopes/tenant-transaction.js';
import { DEMO_COMMUNITY, DEMO_PASSWORD, DEMO_USERS, seedLocal } from '../../packages/testing/seed.js';
import {
  ensureSyntheticModuleTables, setSyntheticFault, syntheticModuleProviders, type SyntheticFault,
} from '../../packages/testing/synthetic-module-provider.js';
import { migrate } from '../../scripts/database.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname)) {
  throw new Error('Module-registry runtime RLS requires explicit disposable fp_* TEST_DATABASE_URL.');
}
const origin = 'http://127.0.0.1:4347';
const stamp = `${process.pid}_${Date.now()}`;
const schema = `d1r_${stamp}`;
const migrator = `d1rm_${stamp}`;
const runtimeRole = `d1ra_${stamp}`;
const guild = 'guild_ai_field';
const digest = '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';
const tenantTables = [
  'application_installations', 'application_module_links', 'module_dependencies', 'module_launch_plans',
  'module_provision_operations', 'module_launch_plan_consumptions', 'module_provision_steps',
  'capacity_reservations', 'capacity_ledger', 'module_instances', 'deployment_bindings', 'workspace_module_bindings',
] as const;
const globalTables = ['application_definitions', 'module_definitions', 'guild_application_offerings'] as const;
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
const providers = syntheticModuleProviders(runtime);
const app = createApp(runtime, origin, 'local', { guildLaunchpadEnabled: true, moduleProviders: providers });
type Session = { cookie: string; csrf: string; user: { user_id: string } };
type Reply = { status: number; data: any; response: Response };
let created = false;

const synthContract = {
  family: 'guild-launchpad.synthetic',
  version: '1',
  source_commit: WORK_CONTRACT_SOURCE_COMMIT,
  artifact_sha256: '0'.repeat(64),
  behavior_profile: 'freedom.synthetic/v1',
};

function unset(value: unknown) { return value == null || value === ''; }
function sqlState(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}
async function quiet() {
  const counts = tenantTables.map(table => `(SELECT count(*)::int FROM ${table}) AS ${table}`).join(', ');
  const row = (await runtime.query<Record<string, string | number | null>>(
    `SELECT pg_catalog.current_setting('freedom.principal_id', true) AS p,
            pg_catalog.current_setting('freedom.tenant_id', true) AS t,
            pg_catalog.current_setting('freedom.tenant_scope_id', true) AS s,
            pg_catalog.current_setting('freedom.platform_admin_id', true) AS a,
            ${counts}`)).rows[0];
  assert.equal(unset(row.p) && unset(row.t) && unset(row.s) && unset(row.a), true);
  for (const table of tenantTables) assert.equal(row[table], 0, table);
}
async function applyGrants() {
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
    assert.equal(statements.rowCount, 1);
    await q.query(Object.values(statements.rows[0])[0] as string);
    const authorityStatements = await q.query(authority);
    assert.equal(authorityStatements.rowCount, 2);
    for (const statement of authorityStatements.rows) await q.query(Object.values(statement)[0] as string);
    const registryStatements = await q.query(registry);
    assert.equal(registryStatements.rowCount, 3);
    for (const statement of registryStatements.rows) await q.query(Object.values(statement)[0] as string);
    await q.query('COMMIT');
  } catch (error) {
    try { await q.query('ROLLBACK'); } catch { /* keep the grant error */ }
    throw error;
  } finally { q.release(); }
}
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
async function installProbes() {
  await owner.query(`
    CREATE TABLE provision_bind_log (
      log_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      table_name text NOT NULL,
      row_tenant uuid,
      ctx_tenant uuid
    );
    CREATE TABLE provision_fail_tenants (tenant_id uuid PRIMARY KEY);
    CREATE FUNCTION provision_bind_log_write() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO provision_bind_log(table_name, row_tenant, ctx_tenant)
      VALUES (TG_TABLE_NAME, NEW.tenant_id, freedom_ctx_tenant());
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER provision_bind_log_steps
      AFTER UPDATE ON module_provision_steps
      FOR EACH ROW EXECUTE FUNCTION provision_bind_log_write();
    CREATE FUNCTION provision_fail_flagged_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM provision_fail_tenants WHERE tenant_id = NEW.tenant_id) THEN
        RAISE EXCEPTION 'flagged tenant provision write' USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER provision_fail_flagged_tenant
      BEFORE UPDATE ON module_provision_steps
      FOR EACH ROW EXECUTE FUNCTION provision_fail_flagged_tenant();
    GRANT SELECT, INSERT ON provision_bind_log TO ${runtimeRole};
    GRANT SELECT ON provision_fail_tenants TO ${runtimeRole};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${runtimeRole};
  `);
}

describe('module registry as the non-owner runtime role', { concurrency: 1 }, () => {
  before(async () => {
    assert.ok(migrator.length < 63 && runtimeRole.length < 63 && schema.length < 63);
    await admin.query(`CREATE ROLE ${migrator} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
      CREATE ROLE ${runtimeRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
      CREATE SCHEMA ${schema} AUTHORIZATION ${migrator};
      GRANT USAGE ON SCHEMA ${schema} TO ${runtimeRole}`);
    created = true;
    await migrate(owner);
    await applyGrants();
    await ensureSyntheticModuleTables(owner);
    await installProbes();
    await seedLocal(owner);
    await owner.query(`INSERT INTO tenant_capacity_policies(
        policy_id, revision, tenant_id, plan_ref, max_active_instances, max_instances_per_module,
        max_concurrent_provisions, max_work_items, max_retained_bytes, max_concurrent_jobs, max_model_budget, status)
      SELECT $1, 1, NULL, 'synthetic-F-GUILD-TWO-TENANTS-v1', 40, 20, 20, 1000, 104857600, 4, NULL, 'active'
      WHERE NOT EXISTS (SELECT 1 FROM tenant_capacity_policies WHERE status='active' AND tenant_id IS NULL)`, [randomUUID()]);
    await installSyntheticCatalog();
  });
  after(async () => {
    await runtime.end();
    await owner.end();
    try {
      if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE; DROP ROLE ${runtimeRole}; DROP ROLE ${migrator}`);
    } finally { await admin.end(); }
  });

  async function call(method: string, path: string, session?: Session, body?: string, headers: Record<string, string> = {}): Promise<Reply> {
    const sent: Record<string, string> = { Origin: origin, ...headers };
    if (session) { sent.Cookie = session.cookie; sent['X-CSRF-Token'] = session.csrf; }
    try {
      const response = await app.request(origin + '/api/v1' + path, { method, headers: sent, body });
      const type = response.headers.get('content-type') ?? '';
      const data = type.includes('application/json') ? await response.json() : null;
      return { status: response.status, data, response };
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
    const reply = await post('/auth/login', undefined, { email, password: DEMO_PASSWORD });
    assert.equal(reply.status, 200, JSON.stringify(reply.data));
    return { cookie: reply.response.headers.get('set-cookie')!.split(';')[0], csrf: reply.data.csrf_token, user: reply.data.user };
  }
  async function fullMember(userId: string) {
    await owner.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier)
      VALUES($1,$2,$3,$4,'active','full')
      ON CONFLICT (community_id, user_id, guild_key) DO UPDATE SET state='active', member_tier='full'`,
    [randomUUID(), DEMO_COMMUNITY, userId, guild]);
  }
  async function person(name: string): Promise<Session> {
    const id = randomUUID();
    const email = `tenant-${id}@example.test`;
    await owner.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,active,onboarding_required)
      SELECT $1,$2,$3,$4,password_hash,$5,true,false FROM users WHERE email=$6`,
    [id, DEMO_COMMUNITY, email, name, randomUUID(), DEMO_USERS[0].email]);
    const session = await signIn(email);
    await fullMember(session.user.user_id);
    return session;
  }
  async function createTenant(session: Session, displayName: string) {
    const made = await post('/tenants', session, { display_name: displayName, workspace_name: '櫃檯' });
    assert.equal(made.status, 201, JSON.stringify(made.data));
    return { tenantId: made.data.tenant.tenant_id as string, workspaceId: made.data.workspace.workspace_id as string };
  }
  async function workspace(session: Session, tenantId: string, name: string) {
    const made = await post(`/tenants/${tenantId}/workspaces`, session, { name });
    assert.equal(made.status, 201, JSON.stringify(made.data));
    return made.data.workspace_id as string;
  }
  async function planAndLaunch(session: Session, tenantId: string, workspaceId: string, application = 'synthetic-storefront', key = randomUUID()) {
    const planned = await post(`/tenants/${tenantId}/application-launch-plans`, session, {
      guild_key: guild, workspace_id: workspaceId, application_key: application, release_ref: `${application}@1.0.0`,
      installation_choice: 'create_new', dependencies: [], configuration: {},
    });
    assert.equal(planned.status, 201, JSON.stringify(planned.data));
    const launched = await post(`/tenants/${tenantId}/application-installations`, session, {
      plan_id: planned.data.plan_id,
      expected_plan_version: planned.data.version,
      configuration_digest: planned.data.configuration_digest,
    }, undefined, key);
    return { planned, launched, key };
  }
  async function fault(moduleKey: string, value: SyntheticFault | null) {
    await setSyntheticFault(owner, moduleKey, value);
  }
  async function scopeOf(tenantId: string) {
    return (await owner.query<{ scope_id: string }>(
      `SELECT scope_id FROM resource_scopes WHERE kind='tenant' AND tenant_ref=$1`, [tenantId])).rows[0].scope_id;
  }
  async function withTenant<T>(tenantId: string, run: (q: PoolClient) => Promise<T>, commit = false): Promise<T> {
    const q = await runtime.connect();
    try {
      await q.query('BEGIN');
      await bindTenantContext(q, { tenantId, tenantScopeId: await scopeOf(tenantId) });
      const result = await run(q);
      await q.query(commit ? 'COMMIT' : 'ROLLBACK');
      return result;
    } catch (error) {
      try { await q.query('ROLLBACK'); } catch { /* keep the original error */ }
      throw error;
    } finally { q.release(); }
  }
  async function expectState(q: PoolClient, statement: string, params: unknown[], code: string) {
    await q.query('SAVEPOINT probe');
    let failed = false;
    try {
      await q.query(statement, params);
    } catch (error) {
      failed = true;
      assert.equal(sqlState(error), code, `${code} ${(error as { message?: string }).message}`);
    }
    assert.equal(failed, true, statement.slice(0, 80));
    await q.query('ROLLBACK TO SAVEPOINT probe');
  }

  test('runtime role completes a launch and still enables, cancels and reconciles', async () => {
    await fault('synthetic-inventory', null);
    await fault('synthetic-storefront', null);
    const session = await person('品牌擁有者');
    const made = await createTenant(session, '品牌甲');
    const launched = await planAndLaunch(session, made.tenantId, made.workspaceId);
    assert.equal(launched.launched.status, 200, JSON.stringify(launched.launched.data));
    assert.equal(launched.launched.data.state, 'succeeded');
    const operationId = launched.launched.data.operation_id as string;
    const scope = await scopeOf(made.tenantId);

    const receipt = (await owner.query<{ tenant_ref: string }>(
      `SELECT s.tenant_ref FROM scoped_command_receipts r
       JOIN resource_scopes s ON s.scope_id=r.scope_id
       WHERE r.idempotency_key=$1`, [launched.key])).rows;
    assert.deepEqual(receipt.map(row => row.tenant_ref), [made.tenantId]);
    const journal = (await owner.query<{ mine: number; other: number }>(
      `SELECT count(*) FILTER (WHERE s.tenant_ref=$2)::int AS mine,
              count(*) FILTER (WHERE s.tenant_ref<>$2)::int AS other
       FROM scoped_transition_journal j
       JOIN resource_scopes s ON s.scope_id=j.scope_id
       WHERE j.aggregate_id=$1 OR j.scope_id=$3 AND j.aggregate_type IN ('application_launch','module_instance')`,
      [operationId, made.tenantId, scope])).rows[0];
    assert.ok(journal.mine > 0);
    assert.equal(journal.other, 0);
    for (const [table, column] of [
      ['module_instances', 'provision_operation_id'],
      ['module_provision_operations', 'operation_id'],
      ['module_provision_steps', 'operation_id'],
      ['module_launch_plan_consumptions', 'operation_id'],
      ['capacity_reservations', 'operation_id'],
      ['capacity_ledger', 'operation_id'],
      ['application_installations', 'provision_operation_id'],
    ] as const) {
      const row = (await owner.query<{ mine: number; other: number }>(
        `SELECT count(*) FILTER (WHERE tenant_id=$2)::int AS mine,
                count(*) FILTER (WHERE tenant_id<>$2)::int AS other
         FROM ${table} WHERE ${column}=$1`, [operationId, made.tenantId])).rows[0];
      assert.ok(row.mine > 0, table);
      assert.equal(row.other, 0, table);
    }
    const links = (await owner.query<{ mine: number; other: number }>(
      `SELECT count(*) FILTER (WHERE l.tenant_id=$2)::int AS mine,
              count(*) FILTER (WHERE l.tenant_id<>$2)::int AS other
       FROM application_module_links l
       JOIN application_installations i ON i.installation_id=l.installation_id
       WHERE i.provision_operation_id=$1`, [operationId, made.tenantId])).rows[0];
    assert.ok(links.mine > 0);
    assert.equal(links.other, 0);
    const dependencies = (await owner.query<{ mine: number; other: number }>(
      `SELECT count(*) FILTER (WHERE d.tenant_id=$2)::int AS mine,
              count(*) FILTER (WHERE d.tenant_id<>$2)::int AS other
       FROM module_dependencies d
       JOIN module_instances i ON i.instance_id=d.caller_instance_id
       WHERE i.provision_operation_id=$1`, [operationId, made.tenantId])).rows[0];
    assert.ok(dependencies.mine > 0);
    assert.equal(dependencies.other, 0);
    const deployment = (await owner.query<{ mine: number; other: number }>(
      `SELECT count(*) FILTER (WHERE b.tenant_id=$2)::int AS mine,
              count(*) FILTER (WHERE b.tenant_id<>$2)::int AS other
       FROM deployment_bindings b
       JOIN module_instances i ON i.instance_id=b.instance_id AND i.tenant_id=b.tenant_id
       WHERE i.provision_operation_id=$1`, [operationId, made.tenantId])).rows[0];
    assert.ok(deployment.mine > 0);
    assert.equal(deployment.other, 0);
    const workspaceBinding = (await owner.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM workspace_module_bindings WHERE workspace_id=$1`, [made.workspaceId])).rows;
    assert.deepEqual(workspaceBinding.map(row => row.tenant_id), [made.tenantId]);

    const instances = await call('GET', `/tenants/${made.tenantId}/module-instances`, session);
    assert.equal(instances.status, 200, JSON.stringify(instances.data));
    assert.ok(instances.data.items.length >= 2);
    assert.equal(instances.data.items.every((item: { tenant_id: string }) => item.tenant_id === made.tenantId), true);
    const instanceId = instances.data.items[0].instance_id as string;
    const detail = await call('GET', `/tenants/${made.tenantId}/module-instances/${instanceId}`, session);
    assert.equal(detail.status, 200, JSON.stringify(detail.data));
    assert.equal(detail.data.tenant_id, made.tenantId);
    const installations = await call('GET', `/tenants/${made.tenantId}/application-installations`, session);
    assert.equal(installations.status, 200, JSON.stringify(installations.data));
    assert.equal(installations.data.items.every((item: { tenant_id: string }) => item.tenant_id === made.tenantId), true);
    const byOperation = await call('GET', `/tenants/${made.tenantId}/application-installations/by-operation/${operationId}`, session);
    assert.equal(byOperation.status, 200, JSON.stringify(byOperation.data));
    assert.equal(byOperation.data.tenant_id, made.tenantId);
    const operation = await call('GET', `/tenants/${made.tenantId}/operations/${operationId}`, session);
    assert.equal(operation.status, 200, JSON.stringify(operation.data));
    assert.equal(operation.data.state, 'succeeded');

    const manualSpace = await workspace(session, made.tenantId, '人工');
    const enabled = await post(`/tenants/${made.tenantId}/workspaces/${manualSpace}/manual-work`, session, { guild_key: guild });
    assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
    assert.equal(enabled.data.reused, false);
    assert.equal(enabled.data.tenant_id, made.tenantId);
    const context = await call('GET', `/tenants/${made.tenantId}/workspaces/${manualSpace}/launchpad-context?guild_key=${guild}`, session);
    assert.equal(context.status, 200, JSON.stringify(context.data));
    assert.equal(context.data.tenant_id, made.tenantId);
    assert.equal(context.data.connection_summary.some((item: { instance_id: string }) => item.instance_id === enabled.data.instance_id), true);

    const terminal = await post(`/tenants/${made.tenantId}/operations/${operationId}/cancel`, session, { reason: 'member_cancelled' }, `"${operation.data.version}"`);
    assert.equal(terminal.status, 409, JSON.stringify(terminal.data));
    assert.equal(terminal.data.code, 'operation_not_cancellable');

    await fault('synthetic-inventory', 'crash_before');
    await fault('synthetic-storefront', 'crash_before');
    const flyingSpace = await workspace(session, made.tenantId, '飛行');
    const flying = await planAndLaunch(session, made.tenantId, flyingSpace);
    assert.equal(flying.launched.status, 202, JSON.stringify(flying.launched.data));
    const flyingCancel = await post(`/tenants/${made.tenantId}/operations/${flying.launched.data.operation_id}/cancel`, session, { reason: 'member_cancelled' }, `"${flying.launched.data.version}"`);
    assert.equal(flyingCancel.status, 202, JSON.stringify(flyingCancel.data));
    assert.notEqual(flyingCancel.data.state, 'cancelled');
    await fault('synthetic-inventory', null);
    await fault('synthetic-storefront', null);

    await fault('synthetic-storefront', 'ack_lost');
    const reconcileSpace = await workspace(session, made.tenantId, '對帳');
    const lost = await planAndLaunch(session, made.tenantId, reconcileSpace);
    assert.equal(lost.launched.status, 202, JSON.stringify(lost.launched.data));
    assert.equal(lost.launched.data.state, 'needs_reconciliation');
    await fault('synthetic-storefront', null);
    const reconciled = await post(`/tenants/${made.tenantId}/operations/${lost.launched.data.operation_id}/reconcile`, session, {}, `"${lost.launched.data.version}"`);
    assert.equal(reconciled.status, 202, JSON.stringify(reconciled.data));
    const afterReconcile = await call('GET', `/tenants/${made.tenantId}/operations/${lost.launched.data.operation_id}`, session);
    assert.equal(afterReconcile.status, 200, JSON.stringify(afterReconcile.data));
    assert.equal(afterReconcile.data.state, 'succeeded');

    const pendingSpace = await workspace(session, made.tenantId, '待取消');
    const pendingPlan = await post(`/tenants/${made.tenantId}/application-launch-plans`, session, {
      guild_key: guild, workspace_id: pendingSpace, application_key: 'synthetic-storefront', release_ref: 'synthetic-storefront@1.0.0',
      installation_choice: 'create_new', dependencies: [], configuration: {},
    });
    assert.equal(pendingPlan.status, 201, JSON.stringify(pendingPlan.data));
    const actor = await authenticate(runtime, session.cookie.split('=')[1]);
    const pending = await launchApplication(runtime, actor, made.tenantId, {
      plan_id: pendingPlan.data.plan_id,
      expected_plan_version: pendingPlan.data.version,
      configuration_digest: pendingPlan.data.configuration_digest,
    }, randomUUID(), providers);
    await quiet();
    const pendingView = await call('GET', `/tenants/${made.tenantId}/operations/${pending.operation_id}`, session);
    assert.equal(pendingView.status, 200, JSON.stringify(pendingView.data));
    assert.equal(pendingView.data.state, 'running');
    const missingVersion = await call('POST', `/tenants/${made.tenantId}/operations/${pending.operation_id}/cancel`, session, JSON.stringify({ reason: 'member_cancelled' }), { 'Content-Type': 'application/json' });
    assert.equal(missingVersion.status, 428, JSON.stringify(missingVersion.data));
    assert.equal(missingVersion.data.code, 'version_required');
    const wrongVersion = await post(`/tenants/${made.tenantId}/operations/${pending.operation_id}/cancel`, session, { reason: 'member_cancelled' }, '"9"');
    assert.equal(wrongVersion.status, 412, JSON.stringify(wrongVersion.data));
    assert.equal(wrongVersion.data.code, 'version_conflict');
    const cancelled = await post(`/tenants/${made.tenantId}/operations/${pending.operation_id}/cancel`, session, { reason: 'member_cancelled' }, `"${pendingView.data.version}"`);
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));
    assert.equal(cancelled.data.state, 'cancelled');

    const other = await createTenant(session, '品牌乙');
    const otherLaunch = await planAndLaunch(session, other.tenantId, other.workspaceId);
    assert.equal(otherLaunch.launched.status, 200, JSON.stringify(otherLaunch.launched.data));
    const hidden = await call('GET', `/tenants/${made.tenantId}/module-instances`, session);
    assert.equal(hidden.status, 200, JSON.stringify(hidden.data));
    const otherInstances = (await owner.query<{ instance_id: string }>(
      `SELECT instance_id FROM module_instances WHERE tenant_id=$1`, [other.tenantId])).rows.map(row => row.instance_id);
    assert.ok(otherInstances.length > 0);
    assert.equal(hidden.data.items.some((item: { instance_id: string }) => otherInstances.includes(item.instance_id)), false);
  });

  test('runtime role sees no other tenant row and refuses a cross-tenant write', async () => {
    await fault('synthetic-inventory', null);
    await fault('synthetic-storefront', null);
    const session = await person('隔離擁有者');
    const first = await createTenant(session, '隔離甲');
    const second = await createTenant(session, '隔離乙');
    const firstLaunch = await planAndLaunch(session, first.tenantId, first.workspaceId);
    const secondLaunch = await planAndLaunch(session, second.tenantId, second.workspaceId);
    assert.equal(firstLaunch.launched.status, 200, JSON.stringify(firstLaunch.launched.data));
    assert.equal(secondLaunch.launched.status, 200, JSON.stringify(secondLaunch.launched.data));
    const principal = (await owner.query<{ principal_id: string }>(
      `SELECT principal_id FROM tenant_memberships WHERE tenant_id=$1 AND role='owner'`, [second.tenantId])).rows[0].principal_id;
    const contract = (await owner.query<{ contract_ref: unknown }>(
      `SELECT contract_ref FROM module_definitions WHERE module_key='work' AND release_ref='work@1.0.0'`)).rows[0].contract_ref;
    const instances = (await owner.query<{ instance_id: string; module_key: string }>(
      `SELECT instance_id, module_key FROM module_instances WHERE tenant_id=$1 ORDER BY module_key`, [second.tenantId])).rows;
    assert.equal(instances.length, 2);
    const sparePlan = randomUUID();
    const spareOperation = randomUUID();
    await owner.query(`INSERT INTO module_launch_plans(
        plan_id, tenant_id, actor_principal_id, guild_key, application_key, release_ref, workspace_id,
        installation_choice, configuration, configuration_digest, selection_digest, dependency_versions,
        warnings, capacity_delta, policy_revision, expires_at)
      SELECT $1, tenant_id, actor_principal_id, guild_key, application_key, release_ref, workspace_id,
        installation_choice, configuration, configuration_digest, selection_digest, dependency_versions,
        warnings, capacity_delta, policy_revision, expires_at
      FROM module_launch_plans WHERE plan_id=$2`, [sparePlan, secondLaunch.planned.data.plan_id]);
    await owner.query(`INSERT INTO module_provision_operations(
        operation_id, tenant_id, installation_id, actor_principal_id, operation_kind, state, request_digest,
        authorization_revision, policy_revision)
      SELECT $1, tenant_id, installation_id, actor_principal_id, operation_kind, 'requested', request_digest,
        authorization_revision, policy_revision
      FROM module_provision_operations WHERE operation_id=$2`, [spareOperation, secondLaunch.launched.data.operation_id]);
    const installationId = (await owner.query<{ installation_id: string }>(
      `SELECT installation_id FROM application_installations WHERE provision_operation_id=$1`,
      [secondLaunch.launched.data.operation_id])).rows[0].installation_id;
    await withTenant(first.tenantId, async q => {
      for (const table of tenantTables) {
        const visible = (await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id=$1`, [second.tenantId])).rows[0].n;
        assert.equal(visible, 0, table);
        const owned = (await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id=$1`, [second.tenantId])).rows[0].n;
        assert.ok(owned > 0, table);
      }
      const inserts: [string, string, unknown[]][] = [
        ['application_installations', `INSERT INTO application_installations(
            installation_id, tenant_id, workspace_id, application_key, release_ref, configuration, configuration_digest,
            status, created_by_principal_id, origin_guild_key)
          VALUES ($1,$2,$3,'manual-workspace','manual-workspace@1.0.0','{}'::jsonb,$4,'requested',$5,'guild_ai_field')`,
          [randomUUID(), second.tenantId, second.workspaceId, digest, principal]],
        ['application_module_links', `INSERT INTO application_module_links(
            installation_id, requirement_key, tenant_id, instance_id, binding_selection)
          VALUES ($1,'extra',$2,$3,'create')`,
          [installationId, second.tenantId, instances[0].instance_id]],
        ['module_dependencies', `INSERT INTO module_dependencies(
            dependency_id, tenant_id, caller_instance_id, requirement_key, capability, provider_instance_id)
          VALUES ($1,$2,$3,'inventory','inventory:read',$4)`,
          [randomUUID(), second.tenantId, instances[0].instance_id, instances[1].instance_id]],
        ['module_launch_plans', `INSERT INTO module_launch_plans(
            plan_id, tenant_id, actor_principal_id, guild_key, application_key, release_ref, workspace_id,
            installation_choice, configuration, configuration_digest, selection_digest, dependency_versions,
            warnings, capacity_delta, policy_revision, expires_at)
          VALUES ($1,$2,$3,'guild_ai_field','manual-workspace','manual-workspace@1.0.0',$4,
            'create_new','{}'::jsonb,$5,$5,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,1,clock_timestamp()+interval '10 minutes')`,
          [randomUUID(), second.tenantId, principal, second.workspaceId, digest]],
        ['module_provision_operations', `INSERT INTO module_provision_operations(
            operation_id, tenant_id, installation_id, actor_principal_id, operation_kind, state, request_digest,
            authorization_revision, policy_revision)
          VALUES ($1,$2,$3,$4,'application.launch','requested',$5,1,1)`,
          [randomUUID(), second.tenantId, installationId, principal, digest]],
        ['module_launch_plan_consumptions', `INSERT INTO module_launch_plan_consumptions(tenant_id, plan_id, operation_id)
          VALUES ($1,$2,$3)`,
          [second.tenantId, sparePlan, spareOperation]],
        ['module_provision_steps', `INSERT INTO module_provision_steps(
            operation_id, step_key, ordinal, instance_id, tenant_id, provider_effect_key, state, expected_authority_epoch)
          VALUES ($1,'step-x',9,$2,$3,$4,'pending',1)`,
          [secondLaunch.launched.data.operation_id, instances[0].instance_id, second.tenantId, randomUUID()]],
        ['capacity_reservations', `INSERT INTO capacity_reservations(
            reservation_id, tenant_id, operation_id, dimension, units, policy_revision, state)
          VALUES ($1,$2,$3,'active_instances',1,1,'reserved')`,
          [randomUUID(), second.tenantId, secondLaunch.launched.data.operation_id]],
        ['capacity_ledger', `INSERT INTO capacity_ledger(
            entry_id, tenant_id, operation_id, dimension, delta, kind, source_ref)
          VALUES ($1,$2,$3,'active_instances',1,'reserved','cross-tenant')`,
          [randomUUID(), second.tenantId, secondLaunch.launched.data.operation_id]],
        ['module_instances', `INSERT INTO module_instances(
            instance_id, tenant_id, module_key, application_release_ref, module_release_ref, data_schema_version,
            contract_ref, status, binding_id, created_by_principal_id, origin_guild_key)
          VALUES ($1,$2,'work','manual-workspace@1.0.0','work@1.0.0','1',$3::jsonb,'requested',$4,$5,'guild_ai_field')`,
          [randomUUID(), second.tenantId, JSON.stringify(contract), randomUUID(), principal]],
        ['deployment_bindings', `INSERT INTO deployment_bindings(
            binding_id, tenant_id, instance_id, mode, environment, contract_ref, state)
          VALUES ($1,$2,$3,'hosted','hosted-shared',$4::jsonb,'pending')`,
          [randomUUID(), second.tenantId, instances[0].instance_id, JSON.stringify(contract)]],
      ];
      for (const [table, statement, params] of inserts) {
        await expectState(q, statement, params, '42501');
        assert.equal(table.length > 0, true);
      }
      // preserve_workspace_module_binding reads module_instances before the policy check.
      // Tenant B's instance is hidden, so the STRICT select raises before 42501.
      await expectState(q, `INSERT INTO workspace_module_bindings(tenant_id, workspace_id, entry_capability, instance_id)
        VALUES ($1,$2,'work:create',$3)`, [second.tenantId, second.workspaceId, instances[0].instance_id], 'P0002');
      for (const table of tenantTables) {
        const updated = await q.query(`UPDATE ${table} SET tenant_id=tenant_id WHERE tenant_id=$1`, [second.tenantId]);
        assert.equal(updated.rowCount, 0, `update ${table}`);
        const deleted = await q.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [second.tenantId]);
        assert.equal(deleted.rowCount, 0, `delete ${table}`);
      }
    });
  });

  test('bound triggers accept a real dependency and still reject a cycle', async () => {
    await fault('synthetic-inventory', null);
    await fault('synthetic-storefront', null);
    const session = await person('觸發擁有者');
    const made = await createTenant(session, '觸發品牌');
    const launched = await planAndLaunch(session, made.tenantId, made.workspaceId);
    assert.equal(launched.launched.status, 200, JSON.stringify(launched.launched.data));
    const operationId = launched.launched.data.operation_id as string;
    const instances = (await owner.query<{ instance_id: string; module_key: string }>(
      `SELECT instance_id, module_key FROM module_instances WHERE provision_operation_id=$1 ORDER BY module_key`,
      [operationId])).rows;
    const inventory = instances.find(row => row.module_key === 'synthetic-inventory')!;
    const storefront = instances.find(row => row.module_key === 'synthetic-storefront')!;
    const existing = (await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM module_dependencies
       WHERE tenant_id=$1 AND caller_instance_id=$2 AND provider_instance_id=$3`,
      [made.tenantId, storefront.instance_id, inventory.instance_id])).rows[0].n;
    assert.equal(existing, 1);
    const planId = launched.planned.data.plan_id as string;
    const installationId = (await owner.query<{ installation_id: string }>(
      `SELECT installation_id FROM application_installations WHERE provision_operation_id=$1`, [operationId])).rows[0].installation_id;
    await withTenant(made.tenantId, async q => {
      await q.query('SAVEPOINT ok_edge');
      await q.query(`INSERT INTO module_dependencies(
          dependency_id, tenant_id, caller_instance_id, requirement_key, capability, provider_instance_id)
        VALUES ($1,$2,$3,'inventory','inventory:read',$4)`,
      [randomUUID(), made.tenantId, storefront.instance_id, inventory.instance_id]);
      await q.query('ROLLBACK TO SAVEPOINT ok_edge');
      await expectState(q, `INSERT INTO module_dependencies(
          dependency_id, tenant_id, caller_instance_id, requirement_key, capability, provider_instance_id)
        VALUES ($1,$2,$3,'storefront','storefront:sell',$4)`,
      [randomUUID(), made.tenantId, inventory.instance_id, storefront.instance_id], '23514');
      await expectState(q, `UPDATE module_launch_plans SET expires_at=expires_at WHERE plan_id=$1`, [planId], '23514');
      await expectState(q, `UPDATE module_launch_plan_consumptions SET consumed_at=consumed_at WHERE plan_id=$1`, [planId], '23514');
      await expectState(q, `UPDATE capacity_ledger SET delta=delta WHERE operation_id=$1`, [operationId], '23514');
      await expectState(q, `DELETE FROM workspace_module_bindings WHERE tenant_id=$1 AND workspace_id=$2`, [made.tenantId, made.workspaceId], '23514');
      await expectState(q, `INSERT INTO workspace_module_bindings(tenant_id, workspace_id, entry_capability, instance_id)
        VALUES ($1,$2,'work:create',$3)`, [made.tenantId, made.workspaceId, inventory.instance_id], '23514');
      await q.query('SAVEPOINT deferred_parent');
      await q.query(`INSERT INTO module_provision_operations(
          operation_id, tenant_id, installation_id, actor_principal_id, operation_kind, state, request_digest,
          authorization_revision, policy_revision)
        SELECT $1,$2,$3,actor_principal_id,'application.launch','requested',$4,1,1
        FROM module_provision_operations WHERE operation_id=$5`,
      [randomUUID(), made.tenantId, installationId, digest, operationId]);
      await q.query('ROLLBACK TO SAVEPOINT deferred_parent');
    });
    const dangling = randomUUID();
    const q = await runtime.connect();
    try {
      await q.query('BEGIN');
      await bindTenantContext(q, { tenantId: made.tenantId, tenantScopeId: await scopeOf(made.tenantId) });
      await q.query(`INSERT INTO module_provision_operations(
          operation_id, tenant_id, installation_id, actor_principal_id, operation_kind, state, request_digest,
          authorization_revision, policy_revision)
        SELECT $1, tenant_id, $2, actor_principal_id, operation_kind, 'requested', request_digest,
          authorization_revision, policy_revision
        FROM module_provision_operations WHERE operation_id=$3`,
      [dangling, randomUUID(), operationId]);
      let commitCode: string | undefined;
      try { await q.query('COMMIT'); }
      catch (error) { commitCode = sqlState(error); }
      assert.equal(commitCode, '23503');
    } finally {
      try { await q.query('ROLLBACK'); } catch { /* commit already ended the transaction */ }
      q.release();
    }
    await quiet();
  });

  test('sweep advances both tenants and a failure in one does not stop the other', async () => {
    await fault('synthetic-inventory', null);
    await fault('synthetic-storefront', null);
    const session = await person('掃描擁有者');
    const first = await createTenant(session, '掃描甲');
    const second = await createTenant(session, '掃描乙');
    async function dueLaunch(tenantId: string, workspaceId: string) {
      await fault('synthetic-inventory', 'crash_before');
      await fault('synthetic-storefront', 'crash_before');
      const launched = await planAndLaunch(session, tenantId, workspaceId);
      assert.equal(launched.launched.status, 202, JSON.stringify(launched.launched.data));
      return launched.launched.data.operation_id as string;
    }
    const firstOperation = await dueLaunch(first.tenantId, first.workspaceId);
    const secondOperation = await dueLaunch(second.tenantId, second.workspaceId);
    await fault('synthetic-inventory', null);
    await fault('synthetic-storefront', null);
    async function arm(operationIds: string[]) {
      await owner.query(`UPDATE module_provision_steps
        SET lease_expires_at=clock_timestamp()+interval '1 day',
            next_attempt_at=clock_timestamp()+interval '1 day'
        WHERE state IN ('pending','dispatched','unknown') AND NOT (operation_id = ANY($1::uuid[]))`, [operationIds]);
      await owner.query(`UPDATE module_provision_steps
        SET lease_expires_at=clock_timestamp()-interval '1 second'
        WHERE operation_id = ANY($1::uuid[])`, [operationIds]);
      await owner.query('DELETE FROM provision_bind_log');
    }
    await arm([firstOperation, secondOperation]);
    await sweepDueOperations(runtime, undefined, providers);
    await quiet();
    const settled = (await owner.query<{ operation_id: string; state: string }>(
      `SELECT operation_id, state FROM module_provision_operations WHERE operation_id = ANY($1::uuid[])`,
      [[firstOperation, secondOperation]])).rows;
    assert.deepEqual(settled.map(row => row.state).sort(), ['succeeded', 'succeeded']);
    const bound = (await owner.query<{ row_tenant: string; ctx_tenant: string; n: number }>(
      `SELECT row_tenant::text AS row_tenant, ctx_tenant::text AS ctx_tenant, count(*)::int AS n
       FROM provision_bind_log GROUP BY 1, 2 ORDER BY 1`)).rows;
    assert.ok(bound.length >= 2, JSON.stringify(bound));
    assert.equal(bound.every(row => row.row_tenant === row.ctx_tenant), true, JSON.stringify(bound));
    assert.deepEqual(bound.map(row => row.row_tenant).sort(), [first.tenantId, second.tenantId].sort());

    const againFirst = await workspace(session, first.tenantId, '掃描甲二');
    const againSecond = await workspace(session, second.tenantId, '掃描乙二');
    const failedOperation = await dueLaunch(first.tenantId, againFirst);
    const continuedOperation = await dueLaunch(second.tenantId, againSecond);
    await fault('synthetic-inventory', null);
    await fault('synthetic-storefront', null);
    await arm([failedOperation, continuedOperation]);
    await owner.query('INSERT INTO provision_fail_tenants(tenant_id) VALUES ($1)', [first.tenantId]);
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args); };
    try { await sweepDueOperations(runtime, undefined, providers); }
    finally { console.error = original; }
    await quiet();
    await owner.query('DELETE FROM provision_fail_tenants WHERE tenant_id=$1', [first.tenantId]);
    const failedState = (await owner.query<{ state: string }>(
      `SELECT state FROM module_provision_operations WHERE operation_id=$1`, [failedOperation])).rows[0].state;
    const continuedState = (await owner.query<{ state: string }>(
      `SELECT state FROM module_provision_operations WHERE operation_id=$1`, [continuedOperation])).rows[0].state;
    assert.equal(failedState, 'running', JSON.stringify(logged));
    assert.equal(continuedState, 'succeeded');
    assert.deepEqual(logged.filter(args => args[0] === 'module_provision_sweep_operation_failed').map(args => args[1]), ['error']);
    const continuedLog = (await owner.query<{ row_tenant: string; ctx_tenant: string }>(
      `SELECT DISTINCT row_tenant::text AS row_tenant, ctx_tenant::text AS ctx_tenant FROM provision_bind_log`)).rows;
    assert.deepEqual(continuedLog, [{ row_tenant: second.tenantId, ctx_tenant: second.tenantId }]);
  });

  test('runtime role reads module-registry policies without force', async () => {
    const flags = (await runtime.query<{
      table_name: string; relrowsecurity: boolean; relforcerowsecurity: boolean; polname: string | null;
      polcmd: string | null; using_expr: string | null; check_expr: string | null; polroles: string | null;
    }>(
      `SELECT c.relname AS table_name, c.relrowsecurity, c.relforcerowsecurity, p.polname, p.polcmd,
              pg_catalog.pg_get_expr(p.polqual, p.polrelid) AS using_expr,
              pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr,
              p.polroles::text AS polroles
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
       LEFT JOIN pg_catalog.pg_policy p ON p.polrelid=c.oid
       WHERE n.nspname=current_schema() AND c.relname = ANY($1::text[])
       ORDER BY c.relname, p.polname`, [[...tenantTables, ...globalTables]])).rows;
    console.log(JSON.stringify({ check: 'module_registry_policies', rows: flags }));
    for (const name of globalTables) {
      const rows = flags.filter(row => row.table_name === name);
      assert.equal(rows.length, 1, name);
      assert.equal(rows[0].relrowsecurity, false, name);
      assert.equal(rows[0].relforcerowsecurity, false, name);
      assert.equal(rows[0].polname, null, name);
    }
    for (const name of tenantTables) {
      const rows = flags.filter(row => row.table_name === name && row.polname);
      assert.equal(rows.length, 1, name);
      assert.equal(rows[0].relrowsecurity, true, name);
      assert.equal(rows[0].relforcerowsecurity, false, name);
      assert.equal(rows[0].polname, `${name}_tenant`, name);
      assert.equal(rows[0].polcmd, '*', name);
      assert.equal(rows[0].polroles, '{0}', name);
      assert.match(rows[0].using_expr ?? '', /tenant_id = freedom_ctx_tenant\(\)/);
      assert.match(rows[0].check_expr ?? '', /tenant_id = freedom_ctx_tenant\(\)/);
    }
    await quiet();
  });
});
