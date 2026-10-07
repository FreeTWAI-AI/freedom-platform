import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DEMO_COMMUNITY, DEMO_USERS } from '../../packages/testing/seed.js';
import { WORK_CONTRACT } from '../../modules/module-registry/definitions.js';
import { createRegistryHarness, type RegistryHarness, type Session } from './module-registry-harness.js';

let h: RegistryHarness;

before(async () => { h = await createRegistryHarness('fp_mr', { synthetic: true }); });
after(async () => { await h.stop(); });
beforeEach(async () => { await h.reset(); });

function problem(reply: { status: number; data: any }, status: number, code: string) {
  assert.equal(reply.status, status, JSON.stringify(reply.data));
  assert.equal(reply.data.code, code);
}

async function ownerOn(guilds: string[]) {
  const owner = await h.signIn(DEMO_USERS[0].email);
  for (const guild of guilds) await h.fullMember(owner.user.user_id, guild);
  const made = await h.createTenant(owner, '品牌甲');
  return { owner, ...made };
}

test('catalog is public without a guild and private when a session asks for eligibility', async () => {
  const owner = await h.signIn(DEMO_USERS[0].email);
  await h.fullMember(owner.user.user_id, 'guild_ai_field');
  await h.createTenant(owner, '目錄品牌');
  const pub = await h.call('GET', '/applications');
  assert.equal(pub.status, 200, JSON.stringify(pub.data));
  assert.equal(pub.response.headers.get('cache-control'), 'public, max-age=60');
  assert.equal(pub.response.headers.get('vary'), 'Cookie');
  assert.equal(pub.data.items.some((item: { eligibility?: unknown }) => item.eligibility), false);
  assert.equal(pub.data.items.some((item: { application_key: string }) => item.application_key === 'manual-workspace'), true);
  assert.equal(pub.data.items.some((item: { application_key: string }) => item.application_key === 'synthetic-storefront'), false);
  const signed = await h.call('GET', '/applications?guild_key=guild_ai_field', owner);
  assert.equal(signed.response.headers.get('cache-control'), 'private, no-store');
  assert.ok(signed.data.items.every((item: { eligibility?: { policy_revision: string } }) => item.eligibility?.policy_revision));
  const release = await h.call('GET', '/applications/manual-workspace/releases/manual-workspace@1.0.0');
  assert.equal(release.status, 200, JSON.stringify(release.data));
  assert.equal(release.response.headers.get('cache-control'), 'public, max-age=60');
  assert.equal(release.response.headers.get('vary'), 'Cookie');
  assert.equal(release.data.source_commit, WORK_CONTRACT.source_commit);
  assert.equal(release.data.eligibility, undefined);
  const missing = await h.call('GET', '/applications/manual-workspace/releases/manual-workspace@9.9.9');
  problem(missing, 404, 'not_found');
  const unknownGuild = await h.call('GET', '/applications?guild_key=not-a-guild');
  problem(unknownGuild, 422, 'validation_failed');
  const absent = await h.call('GET', '/applications?guild_key=guild_custom_' + 'ab'.repeat(16));
  problem(absent, 404, 'guild_not_found');
  const dup = await h.call('GET', '/applications?limit=1&limit=2');
  problem(dup, 422, 'validation_failed');
});

test('a guild created during the test still receives the platform-default manual workspace', async () => {
  const hex = randomUUID().replaceAll('-', '');
  const custom = `guild_custom_${hex}`;
  await h.pool.query(`INSERT INTO positioning_guild_catalog(guild_key, profession_key, name, purpose, first_step, module_key, alias, profession_title)
    VALUES($1,$2,$3,$4,$5,'guilds','','')`, [custom, `custom_${hex.slice(0, 12)}`, '測試公會', '給這次測試的公會。', '寫下一個真實的下一步。']);
  const owner = await h.signIn(DEMO_USERS[0].email);
  await h.fullMember(owner.user.user_id, custom);
  const page = await h.call('GET', `/applications?guild_key=${custom}`, owner);
  assert.equal(page.status, 200, JSON.stringify(page.data));
  assert.deepEqual(page.data.items.map((item: { application_key: string }) => item.application_key), ['manual-workspace']);
  const field = await h.call('GET', '/applications?guild_key=guild_ai_field');
  const keys = field.data.items.map((item: { application_key: string }) => item.application_key);
  assert.equal(keys[0], 'manual-workspace');
  assert.ok(keys.includes('synthetic-storefront'));
  assert.equal(keys.includes('synthetic-unresolved'), false);
  assert.equal(keys.includes('synthetic-held'), false);
});

test('T-003/T-008 the same tenant reuses the installation when a non-primary guild launches the same application', async () => {
  const [primary, secondary] = ['guild_ai_field', 'guild_ai_project'];
  const { owner, tenantId, workspaceId } = await ownerOn([primary, secondary]);
  await h.pool.query(`INSERT INTO guild_member_preferences(community_id, user_id, primary_guild_key, secondary_guild_keys)
    VALUES($1,$2,$3,$4) ON CONFLICT (community_id, user_id) DO UPDATE SET primary_guild_key=$3, secondary_guild_keys=$4`,
  [DEMO_COMMUNITY, owner.user.user_id, primary, [secondary]]);
  const firstPlan = await h.plan(owner, tenantId, h.planBody(primary, workspaceId));
  assert.equal(firstPlan.status, 201, JSON.stringify(firstPlan.data));
  const first = await h.launch(owner, tenantId, firstPlan);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const before = {
    installations: await h.count('application_installations'),
    instances: await h.count('module_instances'),
    links: await h.count('application_module_links'),
  };
  const installationId = (await h.pool.query('SELECT installation_id, provision_operation_id FROM application_installations')).rows[0];
  const instanceId = (await h.pool.query('SELECT instance_id, version::text AS version FROM module_instances')).rows[0];
  const reusePlan = await h.plan(owner, tenantId, h.planBody(secondary, workspaceId, 'manual-workspace', 'manual-workspace@1.0.0', {
    installation_choice: 'reuse_existing',
    existing_installation_id: installationId.installation_id,
    dependencies: [{ requirement_key: 'work', choice: 'reuse', instance_id: instanceId.instance_id, expected_version: instanceId.version }],
  }));
  assert.equal(reusePlan.status, 201, JSON.stringify(reusePlan.data));
  const second = await h.launch(owner, tenantId, reusePlan);
  assert.equal(second.status, 200, JSON.stringify(second.data));
  assert.equal(second.data.operation_id, installationId.provision_operation_id);
  assert.equal(await h.count('application_installations'), before.installations);
  assert.equal(await h.count('module_instances'), before.instances);
  assert.equal(await h.count('application_module_links'), before.links);
  assert.equal((await h.pool.query('SELECT instance_id FROM module_instances')).rows[0].instance_id, instanceId.instance_id);
});

test('T-009 an unresolved or unavailable synthetic release is not launchable and manual work still enables', async () => {
  const { owner, tenantId, workspaceId } = await ownerOn(['guild_ai_field']);
  const unresolved = await h.plan(owner, tenantId, h.planBody('guild_ai_field', workspaceId, 'synthetic-unresolved', 'synthetic-unresolved@1.0.0'));
  problem(unresolved, 409, 'license_unresolved');
  const held = await h.plan(owner, tenantId, h.planBody('guild_ai_field', workspaceId, 'synthetic-held', 'synthetic-held@1.0.0'));
  problem(held, 409, 'application_not_available');
  const enabled = await h.enable(owner, tenantId, workspaceId, 'guild_ai_field');
  assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
  assert.equal(enabled.data.entry_capability, 'work:create');
  assert.equal(enabled.data.reused, false);
  assert.equal(await h.count('module_instances', `WHERE module_key='work'`), 1);
});

test('T-020 no choice lists both candidates, reuse keeps data, and create leaves the original instance empty of that data', async () => {
  const { owner, tenantId, workspaceId } = await ownerOn(['guild_ai_field']);
  assert.equal((await h.enable(owner, tenantId, workspaceId, 'guild_ai_field')).status, 200);
  const secondSpace = await h.workspace(owner, tenantId, '第二櫃');
  const created = await h.enable(owner, tenantId, secondSpace, 'guild_ai_field', { kind: 'create_new' });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const work = await h.post(`/tenants/${tenantId}/workspaces/${workspaceId}/works`, owner, { title: '沿用這份', objective: '保留原實例的工作', progress: 'todo' });
  assert.equal(work.status, 201, JSON.stringify(work.data));
  const instances = (await h.pool.query<{ instance_id: string; version: string }>(
    `SELECT instance_id, version::text AS version FROM module_instances WHERE module_key='work' ORDER BY created_at, instance_id`)).rows;
  assert.equal(instances.length, 2);
  const third = await h.workspace(owner, tenantId, '第三櫃');
  const blocked = await h.plan(owner, tenantId, h.planBody('guild_ai_field', third));
  problem(blocked, 409, 'dependency_selection_required');
  assert.equal(blocked.data.candidates.length, 2);
  assert.deepEqual(blocked.data.candidates.map((item: { instance_id: string }) => item.instance_id).sort(), instances.map(row => row.instance_id).sort());
  const reuse = await h.plan(owner, tenantId, h.planBody('guild_ai_field', third, 'manual-workspace', 'manual-workspace@1.0.0', {
    dependencies: [{ requirement_key: 'work', choice: 'reuse', instance_id: instances[0].instance_id, expected_version: instances[0].version }],
  }));
  assert.equal(reuse.status, 201, JSON.stringify(reuse.data));
  assert.equal(reuse.data.warnings[0].code, 'reuse_existing_data');
  const reused = await h.launch(owner, tenantId, reuse);
  assert.equal(reused.status, 200, JSON.stringify(reused.data));
  const link = (await h.pool.query(`SELECT instance_id FROM application_module_links l
    JOIN application_installations i ON i.installation_id=l.installation_id
    WHERE i.workspace_id=$1`, [third])).rows[0];
  assert.equal(link.instance_id, instances[0].instance_id);
  assert.equal(await h.count('work_items', 'WHERE instance_id=$1', [instances[0].instance_id]), 1);
  const fourth = await h.workspace(owner, tenantId, '第四櫃');
  const fresh = await h.plan(owner, tenantId, h.planBody('guild_ai_field', fourth, 'manual-workspace', 'manual-workspace@1.0.0', {
    dependencies: [{ requirement_key: 'work', choice: 'create', configuration: {} }],
  }));
  assert.equal(fresh.status, 201, JSON.stringify(fresh.data));
  assert.equal(fresh.data.warnings[0].code, 'creates_empty_instance');
  assert.equal((await h.launch(owner, tenantId, fresh)).status, 200);
  const createdId = (await h.pool.query(`SELECT l.instance_id FROM application_module_links l
    JOIN application_installations i ON i.installation_id=l.installation_id WHERE i.workspace_id=$1`, [fourth])).rows[0].instance_id;
  assert.notEqual(createdId, instances[0].instance_id);
  assert.equal(await h.count('work_items', 'WHERE instance_id=$1', [instances[0].instance_id]), 1);
  assert.equal(await h.count('work_items', 'WHERE instance_id=$1', [createdId]), 0);
  assert.equal(await h.count('module_instances', `WHERE module_key='work'`), 3);
});

test('T-051 a manual-workspace launch does not write model or AI tables', async () => {
  const names = (await h.pool.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=current_schema() AND c.relkind='r' AND (c.relname LIKE '%model%' OR c.relname LIKE 'ai_%')
     ORDER BY c.relname`)).rows.map(row => row.relname);
  assert.ok(names.length > 0);
  const before: Record<string, number> = {};
  for (const name of names) before[name] = await h.count(name);
  const { owner, tenantId, workspaceId } = await ownerOn(['guild_ai_field']);
  const planned = await h.plan(owner, tenantId, h.planBody('guild_ai_field', workspaceId));
  assert.equal((await h.launch(owner, tenantId, planned)).status, 200);
  for (const name of names) assert.equal(await h.count(name), before[name], name);
});

test('eligibility follows full membership, tenant management, and a configured policy', async () => {
  const guild = 'guild_ai_field';
  const full = await h.signIn(DEMO_USERS[0].email);
  await h.fullMember(full.user.user_id, guild);
  await h.createTenant(full, '有政策');
  const ready = await h.call('GET', `/guilds/${guild}/launchpad`, full);
  assert.equal(ready.status, 200, JSON.stringify(ready.data));
  const app = ready.data.applications.find((item: { application_key: string }) => item.application_key === 'manual-workspace');
  assert.equal(app.eligibility.can_launch, true);
  assert.deepEqual(app.eligibility.reason_codes, []);
  assert.equal(app.eligibility.tenant_action, 'select');
  assert.equal(app.eligibility.policy_revision, '1');
  assert.equal(JSON.stringify(ready.data).includes('tenant_id'), false);

  const intern = await h.person('見習');
  await h.fullMember(intern.id, guild, 'intern');
  await h.createTenant(intern.session, '見習品牌');
  const internView = await h.call('GET', `/applications?guild_key=${guild}`, intern.session);
  assert.equal(internView.data.items[0].eligibility.can_launch, false);
  assert.deepEqual(internView.data.items[0].eligibility.reason_codes, ['guild_full_member_required']);
  assert.equal(internView.data.items[0].eligibility.tenant_action, 'denied');

  const outsider = await h.person('路人');
  const outside = await h.call('GET', `/applications?guild_key=${guild}`, outsider.session);
  assert.deepEqual(outside.data.items[0].eligibility.reason_codes, ['guild_full_member_required']);
  const denied = await h.call('GET', `/guilds/${guild}/launchpad`, outsider.session);
  problem(denied, 403, 'guild_member_required');

  const otherLeader = await h.person('別會會長');
  await h.fullMember(otherLeader.id, 'guild_ai_project');
  await h.pool.query(`INSERT INTO positioning_guild_officers(community_id, guild_key, user_id) VALUES($1,'guild_ai_project',$2)
    ON CONFLICT (community_id, guild_key) DO UPDATE SET user_id=$2`, [DEMO_COMMUNITY, otherLeader.id]);
  const leader = await h.call('GET', `/applications?guild_key=${guild}`, otherLeader.session);
  assert.deepEqual(leader.data.items[0].eligibility.reason_codes, ['guild_full_member_required']);

  const memberOnly = await h.person('沒有業務空間');
  await h.fullMember(memberOnly.id, guild);
  const noTenant = await h.call('GET', `/applications?guild_key=${guild}`, memberOnly.session);
  assert.deepEqual(noTenant.data.items[0].eligibility.reason_codes, ['tenant_manage_required']);
  assert.equal(noTenant.data.items[0].eligibility.tenant_action, 'denied');

  await h.pool.query(`DELETE FROM tenant_capacity_policies`);
  const noPolicy = await h.call('GET', `/applications?guild_key=${guild}`, full);
  assert.equal(noPolicy.data.items[0].eligibility.can_launch, false);
  assert.deepEqual(noPolicy.data.items[0].eligibility.reason_codes, ['policy_unconfigured']);
});

test('member routes hide other tenants and refuse viewer, operator, forged fields, and a disabled flag', async () => {
  const { owner, tenantId, workspaceId } = await ownerOn(['guild_ai_field']);
  const planned = await h.plan(owner, tenantId, h.planBody('guild_ai_field', workspaceId));
  const launched = await h.launch(owner, tenantId, planned);
  assert.equal(launched.status, 200, JSON.stringify(launched.data));
  const instanceId = (await h.pool.query('SELECT instance_id FROM module_instances')).rows[0].instance_id as string;
  const installationId = (await h.pool.query('SELECT installation_id FROM application_installations')).rows[0].installation_id as string;
  const listed = await h.call('GET', `/tenants/${tenantId}/module-instances`, owner);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.data.items[0].contract_ref, WORK_CONTRACT);
  const detail = await h.call('GET', `/tenants/${tenantId}/module-instances/${instanceId}`, owner);
  assert.equal(detail.status, 200);
  assert.ok(Array.isArray(detail.data.dependencies));

  const other = await h.person('另一個擁有者');
  await h.fullMember(other.id, 'guild_ai_field');
  const otherTenant = await h.createTenant(other.session, '品牌乙');
  for (const path of [
    `/tenants/${otherTenant.tenantId}/module-instances/${instanceId}`,
    `/tenants/${tenantId}/application-installations`,
    `/tenants/${otherTenant.tenantId}/operations/${launched.data.operation_id}`,
    `/tenants/${otherTenant.tenantId}/application-installations/by-operation/${launched.data.operation_id}`,
  ]) {
    const hidden = await h.call('GET', path, other.session);
    assert.equal(hidden.status, 404, `${path} ${JSON.stringify(hidden.data)}`);
  }
  const ownEmpty = await h.call('GET', `/tenants/${otherTenant.tenantId}/application-installations`, other.session);
  assert.equal(ownEmpty.status, 200, JSON.stringify(ownEmpty.data));
  assert.deepEqual(ownEmpty.data.items, []);
  const stranger = await h.person('非成員');
  const missing = await h.call('GET', `/tenants/${tenantId}/module-instances`, stranger.session);
  problem(missing, 404, 'tenant_not_found');

  const operator = await h.person('操作員');
  const viewer = await h.person('只讀者');
  await h.fullMember(operator.id, 'guild_ai_field');
  await h.fullMember(viewer.id, 'guild_ai_field');
  const operatorPrincipal = await h.candidate(owner, operator.id);
  const viewerPrincipal = await h.candidate(owner, viewer.id);
  await h.accept(operator.session, tenantId, await h.invite(owner, tenantId, operatorPrincipal, 'operator'));
  await h.accept(viewer.session, tenantId, await h.invite(owner, tenantId, viewerPrincipal, 'viewer'));
  for (const session of [operator.session, viewer.session]) {
    problem(await h.call('GET', `/tenants/${tenantId}/module-instances`, session), 403, 'capability_denied');
    problem(await h.plan(session, tenantId, h.planBody('guild_ai_field', workspaceId)), 403, 'capability_denied');
    problem(await h.call('GET', `/tenants/${tenantId}/operations/${launched.data.operation_id}`, session), 403, 'capability_denied');
  }
  const forged = await h.plan(owner, tenantId, { ...h.planBody('guild_ai_field', workspaceId), tenant_id: tenantId });
  problem(forged, 422, 'validation_failed');
  const actor = await h.plan(owner, tenantId, { ...h.planBody('guild_ai_field', workspaceId), actor: owner.user.user_id });
  problem(actor, 422, 'validation_failed');
  const badConfig = await h.plan(owner, tenantId, h.planBody('guild_ai_field', await h.workspace(owner, tenantId, '設定櫃'), 'manual-workspace', 'manual-workspace@1.0.0', {
    configuration: { password: 'nope' },
  }));
  problem(badConfig, 422, 'configuration_invalid');
  const off = await h.call('GET', '/applications', owner, undefined, {}, h.closed);
  problem(off, 404, 'not_found');
  assert.equal(off.data.detail, '此版本尚未提供這個 API。');
  const offPost = await h.post(`/tenants/${tenantId}/application-launch-plans`, owner, h.planBody('guild_ai_field', workspaceId), undefined, randomUUID(), h.closed);
  problem(offPost, 404, 'not_found');
  void installationId;
});

test('an expired plan and a changed policy revision are plan_stale', async () => {
  const { owner, tenantId, workspaceId } = await ownerOn(['guild_ai_field']);
  const planned = await h.plan(owner, tenantId, h.planBody('guild_ai_field', workspaceId));
  assert.equal(planned.status, 201, JSON.stringify(planned.data));
  const copyId = randomUUID();
  await h.pool.query(`INSERT INTO module_launch_plans(
      plan_id, tenant_id, actor_principal_id, guild_key, application_key, release_ref, workspace_id,
      installation_choice, existing_installation_id, configuration, configuration_digest, selection_digest,
      dependency_versions, warnings, capacity_delta, policy_revision, expires_at, version)
    SELECT $2, tenant_id, actor_principal_id, guild_key, application_key, release_ref, workspace_id,
      installation_choice, existing_installation_id, configuration, configuration_digest, selection_digest,
      dependency_versions, warnings, capacity_delta, policy_revision, clock_timestamp() - interval '1 minute', version
    FROM module_launch_plans WHERE plan_id=$1`, [planned.data.plan_id, copyId]);
  const expired = await h.post(`/tenants/${tenantId}/application-installations`, owner, {
    plan_id: copyId, expected_plan_version: planned.data.version, configuration_digest: planned.data.configuration_digest,
  });
  problem(expired, 409, 'plan_stale');
  await h.pool.query(`UPDATE tenant_capacity_policies SET revision = revision + 1 WHERE status='active'`);
  const shifted = await h.launch(owner, tenantId, planned);
  problem(shifted, 409, 'plan_stale');
});
