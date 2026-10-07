import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { DEMO_USERS, seedLocal } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { mapPersonPrincipal } from '../../packages/resource-scopes/index.js';
import { bindPrincipalContext, bindTenantContext, isolatedTransaction } from '../../packages/resource-scopes/tenant-transaction.js';
import { WORK_CONTRACT_ARTIFACT_SHA256, WORK_CONTRACT_SOURCE_COMMIT } from '../../modules/module-registry/definitions.js';
import { createRegistryHarness, type RegistryHarness } from './module-registry-harness.js';

let h: RegistryHarness;
const databaseUrl = process.env.TEST_DATABASE_URL ?? '';

before(async () => { h = await createRegistryHarness('fp_mrs'); });
after(async () => { await h.stop(); });
beforeEach(async () => { await h.reset(); });

async function rejects(run: () => Promise<unknown>, code: string, message?: string) {
  await assert.rejects(run, (error: { code?: string; message?: string }) => {
    assert.equal(error.code, code, error.message ?? '');
    if (message) assert.match(error.message ?? '', new RegExp(message));
    return true;
  });
}

async function enabled() {
  const owner = await h.signIn(DEMO_USERS[0].email);
  await h.fullMember(owner.user.user_id, 'guild_ai_field');
  const made = await h.createTenant(owner, '結構品牌');
  const turned = await h.enable(owner, made.tenantId, made.workspaceId, 'guild_ai_field');
  assert.equal(turned.status, 200, JSON.stringify(turned.data));
  return { owner, ...made };
}

test('definition, offering, plan, and ledger rows reject mutation', async () => {
  const { tenantId } = await enabled();
  await rejects(() => h.pool.query(`DELETE FROM application_definitions WHERE application_key='manual-workspace'`), '23514', 'application definition is immutable');
  await rejects(() => h.pool.query(`UPDATE application_definitions SET display_name='別的名字', version=version+1 WHERE application_key='manual-workspace'`), '23514', 'application definition is immutable');
  await rejects(() => h.pool.query(`DELETE FROM module_definitions WHERE module_key='work'`), '23514', 'module definition is immutable');
  await rejects(() => h.pool.query(`UPDATE module_definitions SET data_catalog_ref='other', version=version+1 WHERE module_key='work'`), '23514', 'module definition is immutable');
  await rejects(() => h.pool.query(`UPDATE guild_application_offerings SET display_order=display_order+1, version=version+1 WHERE guild_key IS NULL`), '23514', 'application offering is immutable');
  await h.pool.query(`UPDATE guild_application_offerings SET status='withdrawn', version=version+1 WHERE guild_key IS NULL AND status='offered'`);
  await rejects(() => h.pool.query(`DELETE FROM guild_application_offerings WHERE guild_key IS NULL`), '23514', 'application offering is immutable');
  const planId = (await h.pool.query(`SELECT plan_id FROM module_launch_plans WHERE tenant_id=$1`, [tenantId])).rows[0].plan_id;
  await rejects(() => h.pool.query(`UPDATE module_launch_plans SET version=version WHERE plan_id=$1`, [planId]), '23514', 'launch plan is immutable');
  await rejects(() => h.pool.query(`DELETE FROM module_launch_plans WHERE plan_id=$1`, [planId]), '23514', 'launch plan is immutable');
  await rejects(() => h.pool.query(`UPDATE module_launch_plan_consumptions SET consumed_at=consumed_at WHERE plan_id=$1`, [planId]), '23514', 'launch plan consumption is immutable');
  await rejects(() => h.pool.query(`UPDATE capacity_ledger SET delta=delta WHERE tenant_id=$1`, [tenantId]), '23514', 'capacity ledger is append-only');
  await rejects(() => h.pool.query(`DELETE FROM capacity_ledger WHERE tenant_id=$1`, [tenantId]), '23514', 'capacity ledger is append-only');
});

test('module instance release reference is immutable even when the replacement release exists', async () => {
  const { tenantId } = await enabled();
  await h.pool.query(`INSERT INTO module_definitions(module_key,release_ref,capabilities,data_catalog_ref,contract_ref,data_schema_version,
      portable_profile_ref,runtime_profiles,config_schema_ref,supported_upgrade_paths,license_review_ref,license_state,release_status,version)
    SELECT module_key,'work@1.0.1',capabilities,data_catalog_ref,contract_ref,data_schema_version,
      portable_profile_ref,runtime_profiles,config_schema_ref,supported_upgrade_paths,license_review_ref,license_state,release_status,version
    FROM module_definitions WHERE module_key='work' AND release_ref='work@1.0.0' ON CONFLICT DO NOTHING`);
  const before = (await h.pool.query('SELECT * FROM module_instances WHERE tenant_id=$1', [tenantId])).rows;
  assert.equal(before.length, 1);
  await rejects(() => h.pool.query(`UPDATE module_instances SET module_release_ref='work@1.0.1' WHERE tenant_id=$1`, [tenantId]),
    '23514', 'Module instance identity is immutable');
  assert.deepEqual((await h.pool.query('SELECT * FROM module_instances WHERE tenant_id=$1', [tenantId])).rows, before);
});

test('checks reject a bad offering, a zero reservation, and a bad status, and the widened instance status stays', async () => {
  const { tenantId } = await enabled();
  const definition = (await h.pool.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='module_instances_status_check'`)).rows[0].def as string;
  for (const status of ['requested', 'provisioning', 'active', 'failed', 'suspended', 'archived']) assert.match(definition, new RegExp(status));
  await rejects(() => h.pool.query(`UPDATE module_instances SET status='draft' WHERE tenant_id=$1`, [tenantId]), '23514');
  await rejects(() => h.pool.query(`UPDATE module_instances SET contract_ref=NULL WHERE tenant_id=$1`, [tenantId]), '23502');
  await rejects(() => h.pool.query(`INSERT INTO guild_application_offerings(
      offering_id, community_id, guild_key, application_key, release_ref, status, display_order, launch_policy_ref, version)
    VALUES($1,NULL,'guild_ai_field','manual-workspace','manual-workspace@1.0.0','offered',1,'{"policy_key":"manual-workspace.launch","version":"1"}'::jsonb,1)`,
  [randomUUID()]), '23514');
  await rejects(() => h.pool.query(`INSERT INTO guild_application_offerings(
      offering_id, community_id, guild_key, application_key, release_ref, status, display_order, launch_policy_ref, version)
    VALUES($1,NULL,NULL,'manual-workspace','manual-workspace@1.0.0','offered',1001,'{"policy_key":"manual-workspace.launch","version":"1"}'::jsonb,1)`,
  [randomUUID()]), '23514');
  const operationId = (await h.pool.query(`SELECT operation_id FROM module_provision_operations WHERE tenant_id=$1`, [tenantId])).rows[0].operation_id;
  await rejects(() => h.pool.query(`INSERT INTO capacity_reservations(
      reservation_id, tenant_id, operation_id, dimension, units, policy_revision, state)
    VALUES($1,$2,$3,'module_instances.extra',0,1,'reserved')`, [randomUUID(), tenantId, operationId]), '23514');
  await rejects(() => h.pool.query(`UPDATE module_provision_operations SET state='nope' WHERE operation_id=$1`, [operationId]), '23514');
  await rejects(() => h.pool.query(`UPDATE module_provision_steps SET state='nope' WHERE operation_id=$1`, [operationId]), '23514');
});

test('cross-tenant links and dependencies are refused, and a dependency cycle is refused', async () => {
  const first = await enabled();
  const other = await h.person('另一個租戶');
  await h.fullMember(other.id, 'guild_ai_field');
  const second = await h.createTenant(other.session, '結構乙');
  assert.equal((await h.enable(other.session, second.tenantId, second.workspaceId, 'guild_ai_field')).status, 200);
  const a = (await h.pool.query(`SELECT installation_id, tenant_id FROM application_installations WHERE tenant_id=$1`, [first.tenantId])).rows[0];
  const b = (await h.pool.query(`SELECT instance_id FROM module_instances WHERE tenant_id=$1`, [second.tenantId])).rows[0];
  const instances = (await h.pool.query(`SELECT instance_id FROM module_instances WHERE tenant_id=$1 ORDER BY instance_id`, [first.tenantId])).rows;
  await rejects(() => h.pool.query(`INSERT INTO application_module_links(installation_id, requirement_key, tenant_id, instance_id, binding_selection)
    VALUES($1,'extra',$2,$3,'reuse')`, [a.installation_id, a.tenant_id, b.instance_id]), '23503');
  await rejects(() => h.pool.query(`INSERT INTO module_dependencies(
      dependency_id, tenant_id, caller_instance_id, requirement_key, capability, provider_instance_id)
    VALUES($1,$2,$3,'work','work:read',$4)`, [randomUUID(), first.tenantId, instances[0].instance_id, b.instance_id]), '23503');
  const space = await h.workspace(first.owner, first.tenantId, '第二實例');
  assert.equal((await h.enable(first.owner, first.tenantId, space, 'guild_ai_field', { kind: 'create_new' })).status, 200);
  const pair = (await h.pool.query(`SELECT instance_id FROM module_instances WHERE tenant_id=$1 ORDER BY created_at`, [first.tenantId])).rows;
  await rejects(() => h.pool.query(`INSERT INTO module_dependencies(
      dependency_id, tenant_id, caller_instance_id, requirement_key, capability, provider_instance_id)
    VALUES($1,$2,$3,'work','work:read',$3)`, [randomUUID(), first.tenantId, pair[0].instance_id]), '23514');
  await h.pool.query(`INSERT INTO module_dependencies(
      dependency_id, tenant_id, caller_instance_id, requirement_key, capability, provider_instance_id)
    VALUES($1,$2,$3,'work','work:read',$4)`, [randomUUID(), first.tenantId, pair[0].instance_id, pair[1].instance_id]);
  await rejects(() => h.pool.query(`INSERT INTO module_dependencies(
      dependency_id, tenant_id, caller_instance_id, requirement_key, capability, provider_instance_id)
    VALUES($1,$2,$3,'work','work:read',$4)`, [randomUUID(), first.tenantId, pair[1].instance_id, pair[0].instance_id]), '23514', 'module dependency cycle');
});

test('a second active binding and a second live installation are refused', async () => {
  const { tenantId } = await enabled();
  await rejects(() => h.pool.query(`INSERT INTO deployment_bindings(
      binding_id, tenant_id, instance_id, mode, environment, endpoint_ref, service_principal_id, contract_ref, state)
    SELECT gen_random_uuid(), tenant_id, instance_id, mode, environment, NULL, NULL, contract_ref, 'active'
    FROM deployment_bindings WHERE tenant_id=$1 AND state='active' LIMIT 1`, [tenantId]), '23505');
  await rejects(() => h.pool.query(`INSERT INTO application_installations(
      installation_id, tenant_id, workspace_id, application_key, release_ref, configuration, configuration_digest,
      status, created_by_principal_id, origin_guild_key)
    SELECT gen_random_uuid(), tenant_id, workspace_id, application_key, release_ref, configuration, configuration_digest,
      'active', created_by_principal_id, origin_guild_key
    FROM application_installations WHERE tenant_id=$1 LIMIT 1`, [tenantId]), '23505');
});

test('P-C2 backfill is idempotent for a workspace binding that has no installation', async () => {
  const ctx = await enabled();
  const space = await h.workspace(ctx.owner, ctx.tenantId, '補安裝');
  const instanceId = (await h.pool.query(`SELECT instance_id FROM module_instances WHERE tenant_id=$1`, [ctx.tenantId])).rows[0].instance_id;
  await h.pool.query(`INSERT INTO workspace_module_bindings(tenant_id, workspace_id, entry_capability, instance_id)
    VALUES($1,$2,'work:create',$3)`, [ctx.tenantId, space, instanceId]);
  await h.pool.query('SELECT backfill_manual_workspace_installations()');
  const row = (await h.pool.query(`SELECT l.binding_selection FROM application_installations i
    JOIN application_module_links l ON l.installation_id=i.installation_id
    WHERE i.workspace_id=$1`, [space])).rows[0];
  assert.equal(row.binding_selection, 'reuse');
  const count = await h.count('application_installations', 'WHERE tenant_id=$1', [ctx.tenantId]);
  await h.pool.query('SELECT backfill_manual_workspace_installations()');
  assert.equal(await h.count('application_installations', 'WHERE tenant_id=$1', [ctx.tenantId]), count);
});

test('the work contract pin matches the current tenant-work schema bytes and the database row', async () => {
  const bytes = await readFile(new URL('../../contracts/guild-launchpad/v1/tenant-work.schema.json', import.meta.url));
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest, WORK_CONTRACT_ARTIFACT_SHA256);
  const row = (await h.pool.query(`SELECT contract_ref->>'source_commit' AS source_commit, contract_ref->>'artifact_sha256' AS artifact_sha256,
      contract_ref->>'behavior_profile' AS behavior_profile
    FROM module_definitions WHERE module_key='work' AND release_ref='work@1.0.0'`)).rows[0];
  assert.equal(row.source_commit, WORK_CONTRACT_SOURCE_COMMIT);
  assert.equal(row.artifact_sha256, digest);
  assert.equal(row.behavior_profile, 'freedom.tenant-work/v1');
});

test('a restricted runtime role can launch and cannot edit definitions, and a max-1 pool does not leak tenants', async () => {
  const runtimeRole = `fp_mrr_${process.pid}_${Date.now()}`.slice(0, 60);
  assert.ok(runtimeRole.length < 63);
  await h.admin.query(`CREATE ROLE ${runtimeRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`);
  try {
    await h.admin.query(`GRANT USAGE ON SCHEMA ${h.schema} TO ${runtimeRole}`);
    await h.admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${h.schema} TO ${runtimeRole}`);
    await h.admin.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${h.schema} TO ${runtimeRole}`);
    const template = await readFile(new URL('../../deploy/cloudflare/sql/20-runtime-grants.psql', import.meta.url), 'utf8');
    const grantQuery = template.split('-- BEGIN MODULE REGISTRY DEFINITION GRANTS\n')[1].split('\n\\gexec')[0]
      .replaceAll(":'runtime'", `'${runtimeRole}'`).replaceAll("n.nspname='public'", `n.nspname='${h.schema}'`);
    const grants = (await h.pool.query(grantQuery)).rows;
    assert.equal(grants.length, 3);
    for (const grant of grants) await h.pool.query(Object.values(grant)[0] as string);
    const runtimeUrl = new URL(databaseUrl);
    runtimeUrl.username = runtimeRole;
    runtimeUrl.password = '';
    const runtime = new Pool({ connectionString: runtimeUrl.toString(), options: `-c search_path=${h.schema}`, max: 1 });
    const runtimeApp = createApp(runtime, h.origin, 'local', { guildLaunchpadEnabled: true });
    try {
      await assert.rejects(runtime.query(`INSERT INTO application_definitions(
          application_key, release_ref, display_name, source_commit, artifact_digest, skill_book_refs, module_requirements,
          entry_capability, runtime_profiles, launch_policy_ref, license_state, release_status, customization_schema_ref, version)
        VALUES('x','x@1.0.0','x','${'a'.repeat(40)}','{}'::jsonb,'[]'::jsonb,'[]'::jsonb,'work:create','[]'::jsonb,'{}'::jsonb,'reviewed','draft','x.config/v1',1)`),
      (error: { code?: string }) => error.code === '42501');
      await assert.rejects(runtime.query(`UPDATE application_definitions SET version=version WHERE application_key='manual-workspace'`), (error: { code?: string }) => error.code === '42501');
      await assert.rejects(runtime.query(`DELETE FROM guild_application_offerings WHERE guild_key IS NULL`), (error: { code?: string }) => error.code === '42501');
      const owner = await h.signIn(DEMO_USERS[0].email, runtimeApp);
      await h.fullMember(owner.user.user_id, 'guild_ai_field');
      const made = await h.post('/tenants', owner, { display_name: '受限角色', workspace_name: '櫃檯' }, undefined, randomUUID(), runtimeApp);
      assert.equal(made.status, 201, JSON.stringify(made.data));
      const enabled = await h.post(`/tenants/${made.data.tenant.tenant_id}/workspaces/${made.data.workspace.workspace_id}/manual-work`, owner, { guild_key: 'guild_ai_field' }, undefined, randomUUID(), runtimeApp);
      assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
      const otherLogin = await h.post('/auth/login', undefined, { email: DEMO_USERS[1].email, password: 'freedom-local-demo' }, undefined, randomUUID(), runtimeApp);
      assert.equal(otherLogin.status, 200);
      const other = { cookie: otherLogin.response.headers.get('set-cookie')!.split(';')[0], csrf: otherLogin.data.csrf_token, user: otherLogin.data.user };
      const hidden = await h.call('GET', `/tenants/${made.data.tenant.tenant_id}/module-instances`, other, undefined, {}, runtimeApp);
      assert.equal(hidden.status, 404);
      const again = await h.call('GET', `/tenants/${made.data.tenant.tenant_id}/module-instances`, owner, undefined, {}, runtimeApp);
      assert.equal(again.status, 200, JSON.stringify(again.data));
      assert.equal(again.data.items.length, 1);
      const client = await h.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('GRANT INSERT ON application_definitions TO PUBLIC');
        const poisoned = (await client.query(grantQuery)).rows;
        assert.equal(poisoned.length, 3);
        let guarded = false;
        for (const row of poisoned) {
          try { await client.query(Object.values(row)[0] as string); }
          catch (error) {
            assert.equal((error as Error).message, 'Unsafe runtime module registry definition privileges');
            guarded = true;
            break;
          }
        }
        assert.equal(guarded, true);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    } finally {
      await runtime.end();
    }
  } finally {
    await h.admin.query(`DROP OWNED BY ${runtimeRole}`);
    await h.admin.query(`DROP ROLE ${runtimeRole}`);
  }
});

test('lifecycle kind, reason, shape and terminal-state checks reject invalid operations', async () => {
  const { tenantId } = await enabled();
  const instance = (await h.pool.query(`SELECT instance_id FROM module_instances WHERE tenant_id=$1`, [tenantId])).rows[0].instance_id;
  const launch = (await h.pool.query(`SELECT operation_id,plan_id FROM module_provision_operations WHERE tenant_id=$1`, [tenantId])).rows[0];
  const suspendId = randomUUID(), resumeId = randomUUID();
  for (const [id, kind, reason, policy] of [
    [suspendId, 'module.instance.suspend', '會員暫停原因', null],
    [resumeId, 'module.instance.resume', null, 1],
  ]) {
    await h.pool.query(`INSERT INTO module_provision_operations(operation_id,tenant_id,actor_principal_id,operation_kind,
        state,request_digest,authorization_revision,policy_revision,instance_id,reason)
      SELECT $1,tenant_id,actor_principal_id,$2,'succeeded',request_digest,authorization_revision,$3,$4,$5
      FROM module_provision_operations WHERE operation_id=$6`, [id, kind, policy, instance, reason, launch.operation_id]);
  }
  const cases: [string, string, string][] = [
    [launch.operation_id, "operation_kind='module.instance.upgrade'", 'kind_check'],
    [launch.operation_id, 'installation_id=NULL', 'launch_shape_check'],
    [launch.operation_id, 'policy_revision=NULL', 'launch_shape_check'],
    [launch.operation_id, `instance_id='${instance}'`, 'launch_shape_check'],
    [launch.operation_id, "reason='原因文字'", 'launch_shape_check'],
    [suspendId, 'instance_id=NULL', 'suspend_shape_check'],
    [suspendId, 'reason=NULL', 'suspend_shape_check'],
    [suspendId, `installation_id=(SELECT installation_id FROM module_provision_operations WHERE operation_id='${launch.operation_id}')`, 'suspend_shape_check'],
    [suspendId, `plan_id='${launch.plan_id}'`, 'suspend_shape_check'],
    [resumeId, 'instance_id=NULL', 'resume_shape_check'],
    [resumeId, 'policy_revision=NULL', 'resume_shape_check'],
    [resumeId, `installation_id=(SELECT installation_id FROM module_provision_operations WHERE operation_id='${launch.operation_id}')`, 'resume_shape_check'],
    [resumeId, `plan_id='${launch.plan_id}'`, 'resume_shape_check'],
    [resumeId, "reason='原因文字'", 'resume_shape_check'],
    [suspendId, "reason='短'", 'reason_check'],
    [suspendId, "reason=repeat('長',1001)", 'reason_check'],
  ];
  for (const [id, set, constraint] of cases) {
    await rejects(() => h.pool.query(`UPDATE module_provision_operations SET ${set} WHERE operation_id=$1`, [id]), '23514', constraint);
  }
  for (const id of [suspendId, resumeId]) {
    for (const state of ['requested', 'running', 'needs_reconciliation', 'failed', 'cancelled']) {
      await rejects(() => h.pool.query(`UPDATE module_provision_operations SET state=$2 WHERE operation_id=$1`, [id, state]), '23514', 'lifecycle_state_check');
    }
  }
  await h.pool.query(`UPDATE module_instances SET status='suspended', suspension_operation_id=$2 WHERE instance_id=$1`, [instance, suspendId]);
  await rejects(() => h.pool.query(`UPDATE module_instances SET status='active' WHERE instance_id=$1`, [instance]), '23514', 'suspension_status_check');
  const index = (await h.pool.query(`SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname='module_dependencies_provider'`, [h.schema])).rows[0];
  assert.match(index.indexdef, /\(tenant_id, provider_instance_id\)/);
});

test('lifecycle instance and suspension-operation composite foreign keys reject cross-tenant and missing refs', async () => {
  const first = await enabled();
  const second = await h.createTenant(first.owner, '另一業務');
  assert.equal((await h.enable(first.owner, second.tenantId, second.workspaceId, 'guild_ai_field')).status, 200);
  const a = (await h.pool.query(`SELECT instance_id FROM module_instances WHERE tenant_id=$1`, [first.tenantId])).rows[0];
  const b = (await h.pool.query(`SELECT instance_id FROM module_instances WHERE tenant_id=$1`, [second.tenantId])).rows[0];
  const op = randomUUID();
  await h.pool.query(`INSERT INTO module_provision_operations(operation_id,tenant_id,actor_principal_id,operation_kind,state,
      request_digest,authorization_revision,instance_id,reason)
    SELECT $1,tenant_id,actor_principal_id,'module.instance.suspend','succeeded',request_digest,authorization_revision,$2,'暫停原因'
    FROM module_provision_operations WHERE tenant_id=$3 LIMIT 1`, [op, b.instance_id, second.tenantId]);
  for (const instance of [a.instance_id, randomUUID()]) {
    await rejects(() => h.pool.query(`UPDATE module_provision_operations SET instance_id=$2 WHERE operation_id=$1`, [op, instance]), '23503', 'instance_fkey');
  }
  await h.pool.query(`UPDATE module_instances SET status='suspended' WHERE instance_id=$1`, [a.instance_id]);
  for (const operation of [op, randomUUID()]) {
    await rejects(() => h.pool.query(`UPDATE module_instances SET suspension_operation_id=$2 WHERE instance_id=$1`, [a.instance_id, operation]), '23503', 'suspension_operation_fkey');
  }
});

test('migration 127 preserves a launch row seeded under schema 126', async () => {
  const schema = `fp_mrs_old_${process.pid}_${Date.now()}`;
  await h.admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    const { readMigrationSources } = await import('../../packages/db/migration-files.mjs');
    const { legacyMigrationProfile } = await import('../../packages/db/migration-plan.mjs');
    const { runMigrationPlan } = await import('../../packages/db/migration-runner.mjs');
    const { seedLocal } = await import('../../packages/testing/seed.js');
    const { migrate } = await import('../../scripts/database.js');
    const sources = readMigrationSources(new URL('../../migrations', import.meta.url).pathname)
      .filter(source => Number(source.name.slice(0, 3)) <= 126);
    await runMigrationPlan(pool, { sources, profile: legacyMigrationProfile({ first: 1, last: 126, known_gaps: [22] }) });
    await seedLocal(pool);
    await pool.query(`INSERT INTO tenant_capacity_policies(policy_id,revision,tenant_id,plan_ref,max_active_instances,
      max_instances_per_module,max_concurrent_provisions,max_work_items,max_retained_bytes,max_concurrent_jobs,status)
      SELECT policy_id,revision,tenant_id,plan_ref,max_active_instances,max_instances_per_module,max_concurrent_provisions,
        max_work_items,max_retained_bytes,max_concurrent_jobs,status FROM ${h.schema}.tenant_capacity_policies`);
    const app = createApp(pool, h.origin, 'local', { guildLaunchpadEnabled: true });
    const owner = await h.signIn(DEMO_USERS[0].email, app);
    await pool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier)
      VALUES($1,$2,$3,'guild_ai_field','active','full')`, [randomUUID(), (await pool.query(`SELECT community_id FROM users WHERE user_id=$1`, [owner.user.user_id])).rows[0].community_id, owner.user.user_id]);
    // Seed the historical tenant without today's TenantView, which requires
    // migration 129's grant table. Keep the actual registry enable below.
    const tenantId = randomUUID(), scopeId = randomUUID(), workspaceId = randomUUID();
    await isolatedTransaction(pool, async q => {
      const principal = await mapPersonPrincipal(q, owner.user.user_id);
      const community = (await q.query('SELECT community_id FROM users WHERE user_id=$1', [owner.user.user_id])).rows[0].community_id;
      await bindPrincipalContext(q, principal.principal_id);
      await bindTenantContext(q, { tenantId, tenantScopeId: scopeId });
      const tenant = await q.query(`INSERT INTO tenants(tenant_id,community_id,display_name,created_by_principal_id)
        VALUES($1,$2,'舊啟用紀錄',$3)`, [tenantId, community, principal.principal_id]);
      assert.equal(tenant.rowCount, 1, 'historical tenant fixture is created');
      await q.query(`INSERT INTO resource_scopes(scope_id,kind,tenant_ref) VALUES($1,'tenant',$2)`, [scopeId, tenantId]);
      await q.query(`INSERT INTO tenant_memberships(tenant_id,principal_id,role,status,accepted_at)
        VALUES($1,$2,'owner','active',clock_timestamp())`, [tenantId, principal.principal_id]);
      await q.query(`INSERT INTO workspaces(workspace_id,tenant_id,name,is_default) VALUES($1,$2,'舊工作區',true)`, [workspaceId, tenantId]);
    });
    const enabled = await h.post(`/tenants/${tenantId}/workspaces/${workspaceId}/manual-work`, owner, { guild_key: 'guild_ai_field' }, undefined, randomUUID(), app);
    assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
    const old = (await pool.query(`SELECT to_jsonb(o) AS row FROM module_provision_operations o`)).rows[0].row;
    assert.equal(old.operation_kind, 'application.launch');
    await migrate(pool);
    const current = (await pool.query(`SELECT to_jsonb(o) AS row FROM module_provision_operations o`)).rows[0].row;
    assert.deepEqual(current, { ...old, instance_id: null, reason: null });
  } finally {
    await pool.end();
    await h.admin.query(`DROP SCHEMA ${schema} CASCADE`);
  }
});

test('archive shape, terminal state, status and tenant operation FK reject invalid rows', async () => {
  const { tenantId } = await enabled();
  const instance = (await h.pool.query(`SELECT instance_id FROM module_instances WHERE tenant_id=$1`, [tenantId])).rows[0].instance_id;
  const launch = (await h.pool.query(`SELECT operation_id,installation_id,plan_id FROM module_provision_operations WHERE tenant_id=$1`, [tenantId])).rows[0];
  const archiveId = randomUUID();
  await h.pool.query(`INSERT INTO module_provision_operations(operation_id,tenant_id,actor_principal_id,operation_kind,
      state,request_digest,authorization_revision,instance_id,reason)
    SELECT $1,tenant_id,actor_principal_id,'module.instance.archive','succeeded',request_digest,authorization_revision,$2,'合成封存原因'
    FROM module_provision_operations WHERE operation_id=$3`, [archiveId, instance, launch.operation_id]);
  for (const set of ['instance_id=NULL', 'reason=NULL', `installation_id='${launch.installation_id}'`,
    `plan_id='${launch.plan_id}'`, 'policy_revision=1']) {
    await rejects(() => h.pool.query(`UPDATE module_provision_operations SET ${set} WHERE operation_id=$1`, [archiveId]), '23514', 'archive_shape_check');
  }
  for (const state of ['requested', 'running', 'needs_reconciliation', 'failed', 'cancelled']) {
    await rejects(() => h.pool.query(`UPDATE module_provision_operations SET state=$2 WHERE operation_id=$1`, [archiveId, state]), '23514', 'lifecycle_state_check');
  }
  for (const reason of ['短', '長'.repeat(1001)]) {
    await rejects(() => h.pool.query(`UPDATE module_provision_operations SET reason=$2 WHERE operation_id=$1`, [archiveId, reason]), '23514', 'reason_check');
  }
  await rejects(() => h.pool.query(`UPDATE module_instances SET archive_operation_id=$2 WHERE instance_id=$1`, [instance, archiveId]), '23514', 'archive_status_check');
  await h.pool.query(`UPDATE module_instances SET status='archived',archive_operation_id=$2 WHERE instance_id=$1`, [instance, archiveId]);
  for (const status of ['requested', 'provisioning', 'active', 'suspended', 'failed']) {
    await rejects(() => h.pool.query(`UPDATE module_instances SET status=$2 WHERE instance_id=$1`, [instance, status]), '23514', 'archive_status_check');
  }
  const second = await h.createTenant((await h.signIn(DEMO_USERS[0].email)), '外租戶操作');
  assert.equal((await h.enable((await h.signIn(DEMO_USERS[0].email)), second.tenantId, second.workspaceId, 'guild_ai_field')).status, 200);
  const foreign = (await h.pool.query(`SELECT operation_id FROM module_provision_operations WHERE tenant_id=$1`, [second.tenantId])).rows[0].operation_id;
  for (const id of [foreign, randomUUID()]) {
    await rejects(() => h.pool.query(`UPDATE module_instances SET archive_operation_id=$2 WHERE instance_id=$1`, [instance, id]), '23503', 'archive_operation_fkey');
  }
  // Platform archives legitimately have no member-operation pointer.
  await h.pool.query(`UPDATE module_instances SET archive_operation_id=NULL WHERE instance_id=$1`, [instance]);
  const index = (await h.pool.query(`SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname='application_module_links_instance'`, [h.schema])).rows[0];
  assert.match(index.indexdef, /\(tenant_id, instance_id\)/);
});

test('migration 128 preserves pre-seeded launch, suspend and resume rows from schema 127', async () => {
  const schema = `fp_mrs_archive_old_${process.pid}_${Date.now()}`;
  await h.admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    const { readMigrationSources } = await import('../../packages/db/migration-files.mjs');
    const { legacyMigrationProfile } = await import('../../packages/db/migration-plan.mjs');
    const { runMigrationPlan } = await import('../../packages/db/migration-runner.mjs');
    const sources = readMigrationSources(new URL('../../migrations', import.meta.url).pathname)
      .filter(source => Number(source.name.slice(0, 3)) <= 127);
    await runMigrationPlan(pool, { sources, profile: legacyMigrationProfile({ first: 1, last: 127, known_gaps: [22] }) });
    await seedLocal(pool);
    await pool.query(`INSERT INTO tenant_capacity_policies(policy_id,revision,tenant_id,plan_ref,max_active_instances,
      max_instances_per_module,max_concurrent_provisions,max_work_items,max_retained_bytes,max_concurrent_jobs,status)
      SELECT policy_id,revision,tenant_id,plan_ref,max_active_instances,max_instances_per_module,max_concurrent_provisions,
        max_work_items,max_retained_bytes,max_concurrent_jobs,status FROM ${h.schema}.tenant_capacity_policies`);
    const app = createApp(pool, h.origin, 'local', { guildLaunchpadEnabled: true });
    const owner = await h.signIn(DEMO_USERS[0].email, app);
    await pool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier)
      VALUES($1,$2,$3,'guild_ai_field','active','full')`, [randomUUID(), (await pool.query(`SELECT community_id FROM users WHERE user_id=$1`, [owner.user.user_id])).rows[0].community_id, owner.user.user_id]);
    // Seed the historical tenant without today's TenantView, which requires
    // migration 129's grant table. Keep the actual registry enable below.
    const tenantId = randomUUID(), scopeId = randomUUID(), workspaceId = randomUUID();
    await isolatedTransaction(pool, async q => {
      const principal = await mapPersonPrincipal(q, owner.user.user_id);
      const community = (await q.query('SELECT community_id FROM users WHERE user_id=$1', [owner.user.user_id])).rows[0].community_id;
      await bindPrincipalContext(q, principal.principal_id);
      await bindTenantContext(q, { tenantId, tenantScopeId: scopeId });
      const tenant = await q.query(`INSERT INTO tenants(tenant_id,community_id,display_name,created_by_principal_id)
        VALUES($1,$2,'舊啟用紀錄',$3)`, [tenantId, community, principal.principal_id]);
      assert.equal(tenant.rowCount, 1, 'historical tenant fixture is created');
      await q.query(`INSERT INTO resource_scopes(scope_id,kind,tenant_ref) VALUES($1,'tenant',$2)`, [scopeId, tenantId]);
      await q.query(`INSERT INTO tenant_memberships(tenant_id,principal_id,role,status,accepted_at)
        VALUES($1,$2,'owner','active',clock_timestamp())`, [tenantId, principal.principal_id]);
      await q.query(`INSERT INTO workspaces(workspace_id,tenant_id,name,is_default) VALUES($1,$2,'舊工作區',true)`, [workspaceId, tenantId]);
    });
    const enabled = await h.post(`/tenants/${tenantId}/workspaces/${workspaceId}/manual-work`, owner, { guild_key: 'guild_ai_field' }, undefined, randomUUID(), app);
    assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
    for (const [kind, reason, policy] of [['module.instance.suspend', '合成暫停原因', null], ['module.instance.resume', null, 1]]) {
      await pool.query(`INSERT INTO module_provision_operations(operation_id,tenant_id,actor_principal_id,operation_kind,
          state,request_digest,authorization_revision,instance_id,reason,policy_revision)
        SELECT $1,o.tenant_id,o.actor_principal_id,$2,'succeeded',o.request_digest,o.authorization_revision,i.instance_id,$3,$4
        FROM module_provision_operations o JOIN module_instances i ON i.tenant_id=o.tenant_id
        WHERE o.operation_kind='application.launch' LIMIT 1`, [randomUUID(), kind, reason, policy]);
    }
    await pool.query('COMMIT');
    const before = (await pool.query(`SELECT to_jsonb(o) AS row FROM module_provision_operations o ORDER BY operation_id`)).rows;
    assert.equal(before.length, 3);
    await pool.query(await readFile(new URL('../../migrations/128_module_instance_archive.sql', import.meta.url), 'utf8'));
    assert.deepEqual((await pool.query(`SELECT to_jsonb(o) AS row FROM module_provision_operations o ORDER BY operation_id`)).rows, before);
    assert.equal((await pool.query(`SELECT archive_operation_id FROM module_instances`)).rows[0].archive_operation_id, null);
  } finally {
    await pool.query('ROLLBACK');
    await pool.end();
    await h.admin.query(`DROP SCHEMA ${schema} CASCADE`);
  }
});
