import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DEMO_USERS } from '../../packages/testing/seed.js';
import { authenticate } from '../../modules/identity-membership/service.js';
import { advanceOperation, launchApplication } from '../../modules/module-registry/service.js';
import {
  holdSyntheticApply, releaseSyntheticApply, setSyntheticFault, syntheticApplyEntered,
} from '../../packages/testing/synthetic-module-provider.js';
import { createRegistryHarness, type RegistryHarness } from './module-registry-harness.js';

let h: RegistryHarness;

before(async () => { h = await createRegistryHarness('fp_mprov', { synthetic: true }); });
after(async () => { await h.stop(); });
beforeEach(async () => {
  releaseSyntheticApply();
  await h.reset();
  await setSyntheticFault(h.pool, 'synthetic-inventory', null);
  await setSyntheticFault(h.pool, 'synthetic-storefront', null);
});

async function prepared() {
  const owner = await h.signIn(DEMO_USERS[0].email);
  await h.fullMember(owner.user.user_id, 'guild_ai_field');
  const made = await h.createTenant(owner, '啟動品牌');
  return { owner, ...made };
}

function synthBody(workspaceId: string, extra: Record<string, unknown> = {}) {
  return h.planBody('guild_ai_field', workspaceId, 'synthetic-storefront', 'synthetic-storefront@1.0.0', extra);
}

async function effects(moduleKey?: string) {
  return h.count('synthetic_module_effects', moduleKey ? 'WHERE module_key=$1' : '', moduleKey ? [moduleKey] : []);
}

async function operationVersion(operationId: string) {
  return (await h.pool.query(`SELECT version::text AS version, state FROM module_provision_operations WHERE operation_id=$1`, [operationId])).rows[0] as { version: string; state: string };
}

test('T-017 twenty same-key launches collapse, a different payload conflicts, and two default plans do not create a second instance', async () => {
  const { owner, tenantId, workspaceId } = await prepared();
  const planned = await h.plan(owner, tenantId, synthBody(workspaceId));
  assert.equal(planned.status, 201, JSON.stringify(planned.data));
  const key = randomUUID();
  const raced = await Promise.all(Array.from({ length: 20 }, () => h.launch(owner, tenantId, planned, key)));
  assert.ok(raced.every(item => item.status === 200 || item.status === 202), JSON.stringify(raced.map(item => [item.status, item.data?.code, item.data?.state])));
  assert.equal(new Set(raced.map(item => item.data.operation_id)).size, 1);
  const operationId = raced[0].data.operation_id as string;
  await advanceOperation(h.pool, tenantId, operationId, { providers: h.providers, budget: 3000 });
  const settled = await h.call('GET', `/tenants/${tenantId}/operations/${operationId}`, owner);
  assert.equal(settled.data.state, 'succeeded', JSON.stringify(settled.data));
  assert.equal(await h.count('module_provision_operations', 'WHERE tenant_id=$1', [tenantId]), 1);
  assert.equal(await effects(), 2);
  assert.equal(await h.count('module_instances', 'WHERE tenant_id=$1', [tenantId]), 2);
  assert.equal(await h.count('capacity_reservations', 'WHERE operation_id=$1', [operationId]), 4);
  const conflict = await h.post(`/tenants/${tenantId}/application-installations`, owner, {
    plan_id: planned.data.plan_id,
    expected_plan_version: planned.data.version,
    configuration_digest: { algorithm: 'sha256', value: 'ab'.repeat(32) },
  }, undefined, key);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.code, 'idempotency_conflict');
  assert.equal(await h.count('module_instances', 'WHERE tenant_id=$1', [tenantId]), 2);

  const tabsOwner = await h.person('兩個分頁');
  await h.fullMember(tabsOwner.id, 'guild_ai_field');
  const tabsTenant = await h.createTenant(tabsOwner.session, '分頁品牌');
  const left = await h.plan(tabsOwner.session, tabsTenant.tenantId, synthBody(tabsTenant.workspaceId));
  const right = await h.plan(tabsOwner.session, tabsTenant.tenantId, synthBody(tabsTenant.workspaceId));
  const tabs = await Promise.all([
    h.launch(tabsOwner.session, tabsTenant.tenantId, left, randomUUID()),
    h.launch(tabsOwner.session, tabsTenant.tenantId, right, randomUUID()),
  ]);
  assert.deepEqual(tabs.map(item => item.status).sort(), [200, 409]);
  assert.equal(tabs.find(item => item.status === 409)!.data.code, 'plan_stale');
  assert.equal(await h.count('module_instances', `WHERE tenant_id=$1`, [tabsTenant.tenantId]), 2);
  assert.equal(await h.count('application_installations', `WHERE tenant_id=$1 AND status NOT IN ('archived','failed')`, [tabsTenant.tenantId]), 1);

  const explicitSpace = await h.workspace(tabsOwner.session, tabsTenant.tenantId, '明確新建');
  const explicit = await h.plan(tabsOwner.session, tabsTenant.tenantId, synthBody(explicitSpace, {
    dependencies: [
      { requirement_key: 'inventory', choice: 'create', configuration: {} },
      { requirement_key: 'storefront', choice: 'create', configuration: {} },
    ],
  }));
  assert.equal((await h.launch(tabsOwner.session, tabsTenant.tenantId, explicit)).status, 200);
  assert.equal(await h.count('module_instances', `WHERE tenant_id=$1 AND module_key='synthetic-inventory'`, [tabsTenant.tenantId]), 2);
});

test('T-019 an acknowledgement lost after the provider commit reconciles to the same instance', async () => {
  const { owner, tenantId, workspaceId } = await prepared();
  await setSyntheticFault(h.pool, 'synthetic-storefront', 'ack_lost');
  const planned = await h.plan(owner, tenantId, synthBody(workspaceId));
  const launched = await h.launch(owner, tenantId, planned);
  assert.equal(launched.status, 202, JSON.stringify(launched.data));
  assert.equal(launched.data.state, 'needs_reconciliation');
  const instanceId = (await h.pool.query(`SELECT instance_id FROM module_instances WHERE tenant_id=$1 AND module_key='synthetic-storefront'`, [tenantId])).rows[0].instance_id;
  assert.equal(await effects('synthetic-storefront'), 1);
  await setSyntheticFault(h.pool, 'synthetic-storefront', null);
  const current = await operationVersion(launched.data.operation_id);
  const reconciled = await h.post(`/tenants/${tenantId}/operations/${launched.data.operation_id}/reconcile`, owner, {}, `"${current.version}"`);
  assert.equal(reconciled.status, 202, JSON.stringify(reconciled.data));
  const after = await h.call('GET', `/tenants/${tenantId}/operations/${launched.data.operation_id}`, owner);
  assert.equal(after.data.state, 'succeeded');
  assert.equal(await effects('synthetic-storefront'), 1);
  assert.equal((await h.pool.query(`SELECT status FROM module_instances WHERE instance_id=$1`, [instanceId])).rows[0].status, 'active');
});

test('lookup reports a foreign owner as an identity conflict and an absent effect returns to the same key', async () => {
  const foreign = await prepared();
  await setSyntheticFault(h.pool, 'synthetic-storefront', 'foreign_owner');
  const foreignPlan = await h.plan(foreign.owner, foreign.tenantId, synthBody(foreign.workspaceId));
  const foreignLaunch = await h.launch(foreign.owner, foreign.tenantId, foreignPlan);
  assert.equal(foreignLaunch.status, 202);
  const foreignVersion = await operationVersion(foreignLaunch.data.operation_id);
  const conflict = await h.post(`/tenants/${foreign.tenantId}/operations/${foreignLaunch.data.operation_id}/reconcile`, foreign.owner, {}, `"${foreignVersion.version}"`);
  assert.equal(conflict.status, 202);
  const seen = await h.call('GET', `/tenants/${foreign.tenantId}/operations/${foreignLaunch.data.operation_id}`, foreign.owner);
  assert.equal(seen.data.state, 'needs_reconciliation');
  assert.equal(seen.data.problem.code, 'effect_identity_conflict');
  assert.equal((await h.pool.query(`SELECT state FROM module_provision_steps WHERE operation_id=$1 AND step_key='step-1'`, [foreignLaunch.data.operation_id])).rows[0].state, 'unknown');

  const absent = await prepared();
  await setSyntheticFault(h.pool, 'synthetic-storefront', null);
  await setSyntheticFault(h.pool, 'synthetic-inventory', 'timeout');
  const absentPlan = await h.plan(absent.owner, absent.tenantId, synthBody(absent.workspaceId));
  const absentLaunch = await h.launch(absent.owner, absent.tenantId, absentPlan);
  assert.equal(absentLaunch.status, 202);
  const effectKey = (await h.pool.query(`SELECT provider_effect_key FROM module_provision_steps WHERE operation_id=$1 AND step_key='step-0'`, [absentLaunch.data.operation_id])).rows[0].provider_effect_key;
  await setSyntheticFault(h.pool, 'synthetic-inventory', null);
  const version = await operationVersion(absentLaunch.data.operation_id);
  await h.post(`/tenants/${absent.tenantId}/operations/${absentLaunch.data.operation_id}/reconcile`, absent.owner, {}, `"${version.version}"`);
  const pending = (await h.pool.query(`SELECT state, provider_effect_key FROM module_provision_steps WHERE operation_id=$1 AND step_key='step-0'`, [absentLaunch.data.operation_id])).rows[0];
  assert.equal(pending.state, 'pending');
  assert.equal(pending.provider_effect_key, effectKey);
  await h.pool.query(`UPDATE module_provision_steps SET next_attempt_at='2000-01-01T00:00:00Z' WHERE operation_id=$1 AND step_key='step-0'`, [absentLaunch.data.operation_id]);
  await advanceOperation(h.pool, absent.tenantId, absentLaunch.data.operation_id, { providers: h.providers, budget: 3000 });
  assert.equal(await h.count('synthetic_module_effects', 'WHERE tenant_id=$1 AND module_key=$2', [absent.tenantId, 'synthetic-inventory']), 1);
});

test('T-031/T-032 a crash before or after the effect, a stale fence, and an uncommitted launch do not duplicate work', async () => {
  const crashed = await prepared();
  await setSyntheticFault(h.pool, 'synthetic-inventory', 'crash_before');
  const beforePlan = await h.plan(crashed.owner, crashed.tenantId, synthBody(crashed.workspaceId));
  const beforeLaunch = await h.launch(crashed.owner, crashed.tenantId, beforePlan);
  assert.equal(beforeLaunch.status, 202, JSON.stringify(beforeLaunch.data));
  assert.equal(await effects('synthetic-inventory'), 0);
  assert.equal((await h.pool.query(`SELECT state FROM module_provision_steps WHERE operation_id=$1 AND step_key='step-0'`, [beforeLaunch.data.operation_id])).rows[0].state, 'dispatched');
  await setSyntheticFault(h.pool, 'synthetic-inventory', null);
  await h.pool.query(`UPDATE module_provision_steps SET lease_expires_at=clock_timestamp() - interval '1 second' WHERE operation_id=$1 AND step_key='step-0'`, [beforeLaunch.data.operation_id]);
  await advanceOperation(h.pool, crashed.tenantId, beforeLaunch.data.operation_id, { providers: h.providers, budget: 3000 });
  assert.equal(await effects('synthetic-inventory'), 1);
  const beforeRead = await h.call('GET', `/tenants/${crashed.tenantId}/operations/${beforeLaunch.data.operation_id}`, crashed.owner);
  assert.equal(beforeRead.data.state, 'succeeded');

  const after = await prepared();
  await setSyntheticFault(h.pool, 'synthetic-storefront', 'crash_after');
  const afterPlan = await h.plan(after.owner, after.tenantId, synthBody(after.workspaceId));
  const afterLaunch = await h.launch(after.owner, after.tenantId, afterPlan);
  assert.equal(afterLaunch.status, 202);
  assert.equal(await h.count('synthetic_module_effects', 'WHERE tenant_id=$1 AND module_key=$2', [after.tenantId, 'synthetic-storefront']), 1);
  await setSyntheticFault(h.pool, 'synthetic-storefront', null);
  await h.pool.query(`UPDATE module_provision_steps SET lease_expires_at=clock_timestamp() - interval '1 second' WHERE operation_id=$1 AND state='dispatched'`, [afterLaunch.data.operation_id]);
  await advanceOperation(h.pool, after.tenantId, afterLaunch.data.operation_id, { providers: h.providers, budget: 3000 });
  assert.equal(await h.count('synthetic_module_effects', 'WHERE tenant_id=$1 AND module_key=$2', [after.tenantId, 'synthetic-storefront']), 1);
  assert.equal((await h.call('GET', `/tenants/${after.tenantId}/operations/${afterLaunch.data.operation_id}`, after.owner)).data.state, 'succeeded');

  const fenced = await prepared();
  holdSyntheticApply();
  const fencePlan = await h.plan(fenced.owner, fenced.tenantId, synthBody(fenced.workspaceId));
  const fenceLaunch = h.launch(fenced.owner, fenced.tenantId, fencePlan);
  await syntheticApplyEntered();
  const operationId = (await h.pool.query(`SELECT operation_id FROM module_provision_operations WHERE tenant_id=$1`, [fenced.tenantId])).rows[0].operation_id as string;
  await h.pool.query(`UPDATE module_provision_steps SET lease_expires_at=clock_timestamp() - interval '1 second' WHERE operation_id=$1 AND state='dispatched'`, [operationId]);
  await advanceOperation(h.pool, fenced.tenantId, operationId, { providers: h.providers, budget: 3000 });
  releaseSyntheticApply();
  const fenceResult = await fenceLaunch;
  assert.equal(fenceResult.status, 200, JSON.stringify(fenceResult.data));
  assert.equal(await h.count('synthetic_module_effects', 'WHERE tenant_id=$1', [fenced.tenantId]), 2);
  const fence = (await h.pool.query(`SELECT max(lease_fence) AS fence FROM module_provision_steps WHERE operation_id=$1`, [operationId])).rows[0].fence;
  assert.ok(Number(fence) >= 2);

  const open = await prepared();
  const openPlan = await h.plan(open.owner, open.tenantId, synthBody(open.workspaceId));
  const beforeOps = await h.count('module_provision_operations', 'WHERE tenant_id=$1', [open.tenantId]);
  const beforeSteps = await h.count('module_provision_steps', 'WHERE tenant_id=$1', [open.tenantId]);
  const stale = await h.post(`/tenants/${open.tenantId}/application-installations`, open.owner, {
    plan_id: openPlan.data.plan_id,
    expected_plan_version: openPlan.data.version,
    configuration_digest: { algorithm: 'sha256', value: 'cd'.repeat(32) },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, 'plan_stale');
  assert.equal(await h.count('module_provision_operations', 'WHERE tenant_id=$1', [open.tenantId]), beforeOps);
  assert.equal(await h.count('module_provision_steps', 'WHERE tenant_id=$1', [open.tenantId]), beforeSteps);
  assert.equal(await h.count('synthetic_module_effects', 'WHERE tenant_id=$1', [open.tenantId]), 0);
});

test('T-034 a known failure keeps a reused or data-bearing module and archives an empty new one', async () => {
  const ctx = await prepared();
  const firstPlan = await h.plan(ctx.owner, ctx.tenantId, synthBody(ctx.workspaceId));
  assert.equal((await h.launch(ctx.owner, ctx.tenantId, firstPlan)).status, 200);
  const inventoryId = (await h.pool.query(`SELECT instance_id FROM module_instances WHERE tenant_id=$1 AND module_key='synthetic-inventory'`, [ctx.tenantId])).rows[0].instance_id as string;
  const reuseSpace = await h.workspace(ctx.owner, ctx.tenantId, '沿用庫存');
  await setSyntheticFault(h.pool, 'synthetic-storefront', 'fail_known');
  const reusePlan = await h.plan(ctx.owner, ctx.tenantId, synthBody(reuseSpace));
  const reuseLaunch = await h.launch(ctx.owner, ctx.tenantId, reusePlan);
  assert.equal(reuseLaunch.status, 202, JSON.stringify(reuseLaunch.data));
  assert.equal(reuseLaunch.data.state, 'failed');
  assert.equal((await h.pool.query(`SELECT status FROM module_instances WHERE instance_id=$1`, [inventoryId])).rows[0].status, 'active');
  const reuseRow = (await h.pool.query(`SELECT status, retained_instance_ids FROM application_installations WHERE workspace_id=$1`, [reuseSpace])).rows[0];
  assert.equal(reuseRow.status, 'failed');
  assert.ok(reuseRow.retained_instance_ids.includes(inventoryId));
  assert.equal(await effects('synthetic-inventory'), 1);

  const emptySpace = await h.workspace(ctx.owner, ctx.tenantId, '空白失敗');
  const emptyPlan = await h.plan(ctx.owner, ctx.tenantId, synthBody(emptySpace, {
    dependencies: [
      { requirement_key: 'inventory', choice: 'create', configuration: {} },
      { requirement_key: 'storefront', choice: 'create', configuration: {} },
    ],
  }));
  const emptyLaunch = await h.launch(ctx.owner, ctx.tenantId, emptyPlan);
  assert.equal(emptyLaunch.data.state, 'failed');
  const emptyInventory = (await h.pool.query(`SELECT i.status FROM module_instances i
    JOIN application_module_links l ON l.instance_id=i.instance_id
    JOIN application_installations a ON a.installation_id=l.installation_id
    WHERE a.workspace_id=$1 AND i.module_key='synthetic-inventory'`, [emptySpace])).rows[0];
  assert.equal(emptyInventory.status, 'archived');
  assert.deepEqual((await h.pool.query(`SELECT retained_instance_ids FROM application_installations WHERE workspace_id=$1`, [emptySpace])).rows[0].retained_instance_ids, []);

  await setSyntheticFault(h.pool, 'synthetic-inventory', 'member_data');
  const dataSpace = await h.workspace(ctx.owner, ctx.tenantId, '有資料');
  const dataPlan = await h.plan(ctx.owner, ctx.tenantId, synthBody(dataSpace, {
    dependencies: [
      { requirement_key: 'inventory', choice: 'create', configuration: {} },
      { requirement_key: 'storefront', choice: 'create', configuration: {} },
    ],
  }));
  const dataLaunch = await h.launch(ctx.owner, ctx.tenantId, dataPlan);
  assert.equal(dataLaunch.data.state, 'failed');
  const kept = (await h.pool.query(`SELECT i.instance_id, i.status FROM module_instances i
    JOIN application_module_links l ON l.instance_id=i.instance_id
    JOIN application_installations a ON a.installation_id=l.installation_id
    WHERE a.workspace_id=$1 AND i.module_key='synthetic-inventory'`, [dataSpace])).rows[0];
  assert.equal(kept.status, 'active');
  const dataRow = (await h.pool.query(`SELECT retained_instance_ids FROM application_installations WHERE workspace_id=$1`, [dataSpace])).rows[0];
  assert.ok(dataRow.retained_instance_ids.includes(kept.instance_id));
  const reservation = (await h.pool.query(`SELECT state FROM capacity_reservations WHERE operation_id=$1 AND dimension='module_instances.synthetic-inventory'`, [dataLaunch.data.operation_id])).rows[0];
  assert.equal(reservation.state, 'consumed');
});

for (const resolution of ['reconcile', 'executor'] as const) {
  for (const memberData of [false, true]) {
    test(`a late ${resolution} confirmation settles an earlier known failure with member data ${memberData}`, async () => {
      const { owner, tenantId, workspaceId } = await prepared();
      await setSyntheticFault(h.pool, 'synthetic-inventory', resolution === 'reconcile' ? 'ack_lost' : 'crash_after');
      await setSyntheticFault(h.pool, 'synthetic-storefront', 'fail_known');
      const planned = await h.plan(owner, tenantId, synthBody(workspaceId));
      const launched = await h.launch(owner, tenantId, planned);
      assert.equal(launched.status, 202, JSON.stringify(launched.data));
      const operationId = launched.data.operation_id as string;
      const before = (await h.pool.query(
        'SELECT step_key,state FROM module_provision_steps WHERE operation_id=$1 ORDER BY ordinal', [operationId],
      )).rows;
      assert.deepEqual(before.map(row => row.state), [resolution === 'reconcile' ? 'unknown' : 'dispatched', 'failed_known']);
      const inventory = (await h.pool.query(
        "SELECT instance_id FROM module_instances WHERE tenant_id=$1 AND module_key='synthetic-inventory'", [tenantId],
      )).rows[0].instance_id as string;
      if (memberData) {
        await h.pool.query('UPDATE synthetic_module_effects SET member_data=true WHERE instance_id=$1', [inventory]);
      }
      await setSyntheticFault(h.pool, 'synthetic-inventory', null);
      if (resolution === 'reconcile') {
        const current = await operationVersion(operationId);
        const reply = await h.post(`/tenants/${tenantId}/operations/${operationId}/reconcile`, owner, {}, `"${current.version}"`);
        assert.equal(reply.status, 202, JSON.stringify(reply.data));
      } else {
        await h.pool.query(
          "UPDATE module_provision_steps SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1 AND step_key='step-0'",
          [operationId],
        );
        await advanceOperation(h.pool, tenantId, operationId, { providers: h.providers, budget: 3000 });
      }
      const settled = await h.call('GET', `/tenants/${tenantId}/operations/${operationId}`, owner);
      assert.equal(settled.data.state, 'failed', JSON.stringify(settled.data));
      assert.equal(settled.data.problem.code, 'failed_known');
      assert.equal((await h.pool.query('SELECT status FROM module_instances WHERE instance_id=$1', [inventory])).rows[0].status,
        memberData ? 'active' : 'archived');
      const installation = (await h.pool.query(
        'SELECT status,retained_instance_ids FROM application_installations WHERE tenant_id=$1 AND workspace_id=$2', [tenantId, workspaceId],
      )).rows[0];
      assert.equal(installation.status, 'failed');
      assert.deepEqual(installation.retained_instance_ids, memberData ? [inventory] : []);
      assert.equal(await h.count('workspace_module_bindings', 'WHERE tenant_id=$1 AND workspace_id=$2', [tenantId, workspaceId]), 0);
      const reservations = (await h.pool.query(
        'SELECT dimension,state,units::text FROM capacity_reservations WHERE operation_id=$1 ORDER BY dimension', [operationId],
      )).rows;
      for (const reservation of reservations) {
        const retained = memberData && ['module_instances', 'module_instances.synthetic-inventory'].includes(reservation.dimension);
        assert.equal(reservation.state, retained ? 'consumed' : 'released', reservation.dimension);
        if (retained) assert.equal(reservation.units, '1');
      }
      const ledgerBefore = (await h.pool.query(
        'SELECT entry_id FROM capacity_ledger WHERE operation_id=$1 ORDER BY entry_id', [operationId],
      )).rows;
      const current = await operationVersion(operationId);
      const replay = await h.post(`/tenants/${tenantId}/operations/${operationId}/reconcile`, owner, {}, `"${current.version}"`);
      assert.equal(replay.status, 202, JSON.stringify(replay.data));
      await advanceOperation(h.pool, tenantId, operationId, { providers: h.providers, budget: 3000 });
      assert.deepEqual((await h.pool.query(
        'SELECT entry_id FROM capacity_ledger WHERE operation_id=$1 ORDER BY entry_id', [operationId],
      )).rows, ledgerBefore);
      assert.equal(await effects('synthetic-inventory'), 1);
      assert.deepEqual(await operationVersion(operationId), current);
    });
  }
}

for (const selection of ['explicit-create', 'non-reusable-default'] as const) {
  test(`launch rejects a retired module release after planning ${selection}`, async t => {
    // Definitions survive reset() and cannot be unretired; each case owns its schema.
    const isolated = await createRegistryHarness('fp_mprov_retired', { synthetic: true });
    t.after(async () => { await isolated.stop(); });
    await isolated.reset();
    const owner = await isolated.signIn(DEMO_USERS[0].email);
    await isolated.fullMember(owner.user.user_id, 'guild_ai_field');
    const { tenantId, workspaceId } = await isolated.createTenant(owner, '啟動品牌');
    const effects = () => isolated.count('synthetic_module_effects');
    const extra = selection === 'explicit-create'
      ? { dependencies: [{ requirement_key: 'inventory', choice: 'create', configuration: {} }] }
      : {};
    const planned = await isolated.plan(owner, tenantId, isolated.planBody(
      'guild_ai_field', workspaceId, 'synthetic-storefront', 'synthetic-storefront@1.0.0', extra,
    ));
    assert.equal(planned.status, 201, JSON.stringify(planned.data));
    const moduleKey = selection === 'explicit-create' ? 'synthetic-inventory' : 'synthetic-storefront';
    await isolated.pool.query(
      "UPDATE module_definitions SET release_status='retired',version=version+1 WHERE module_key=$1 AND release_ref=$2",
      [moduleKey, `${moduleKey}@1.0.0`],
    );
    const receipts = await isolated.count('scoped_command_receipts');
    const reply = await isolated.launch(owner, tenantId, planned);
    assert.equal(reply.status, 409, JSON.stringify(reply.data));
    assert.equal(reply.data.code, 'application_not_available');
    for (const table of ['application_installations', 'module_instances', 'module_provision_operations', 'capacity_reservations', 'capacity_ledger', 'module_launch_plan_consumptions']) {
      assert.equal(await isolated.count(table, 'WHERE tenant_id=$1', [tenantId]), 0, table);
    }
    assert.equal(await isolated.count('scoped_command_receipts'), receipts);
    assert.equal(await effects(), 0);
  });
}

test('cancel releases an all-pending operation, keeps quota once work is in flight, and refuses a terminal operation', async () => {
  const { owner, tenantId, workspaceId } = await prepared();
  const actor = await authenticate(h.pool, owner.cookie.split('=')[1]);
  const planned = await h.plan(owner, tenantId, synthBody(workspaceId));
  const launched = await launchApplication(h.pool, actor, tenantId, {
    plan_id: planned.data.plan_id,
    expected_plan_version: planned.data.version,
    configuration_digest: planned.data.configuration_digest,
  }, randomUUID(), h.providers);
  const version = await operationVersion(launched.operation_id);
  const missing = await h.call('POST', `/tenants/${tenantId}/operations/${launched.operation_id}/cancel`, owner, { reason: 'member_cancelled' });
  assert.equal(missing.status, 428);
  assert.equal(missing.data.code, 'version_required');
  const wrong = await h.post(`/tenants/${tenantId}/operations/${launched.operation_id}/cancel`, owner, { reason: 'member_cancelled' }, '"9"');
  assert.equal(wrong.status, 412);
  assert.equal(wrong.data.code, 'version_conflict');
  const cancelled = await h.call('POST', `/tenants/${tenantId}/operations/${launched.operation_id}/cancel`, owner, { reason: 'member_cancelled' }, { 'If-Match': `"${version.version}"` });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));
  assert.equal(cancelled.data.state, 'cancelled');
  assert.equal(await h.count('module_instances', `WHERE tenant_id=$1 AND status='archived'`, [tenantId]), 2);
  assert.equal(await h.count('capacity_reservations', `WHERE operation_id=$1 AND state='released'`, [launched.operation_id]), 4);

  const flying = await h.workspace(owner, tenantId, '已派出');
  await setSyntheticFault(h.pool, 'synthetic-inventory', 'crash_before');
  await setSyntheticFault(h.pool, 'synthetic-storefront', 'crash_before');
  const flyingPlan = await h.plan(owner, tenantId, synthBody(flying));
  const flyingLaunch = await h.launch(owner, tenantId, flyingPlan);
  assert.equal(flyingLaunch.status, 202);
  const flyingCancel = await h.post(`/tenants/${tenantId}/operations/${flyingLaunch.data.operation_id}/cancel`, owner, { reason: 'member_cancelled' }, `"${flyingLaunch.data.version}"`);
  assert.equal(flyingCancel.status, 202, JSON.stringify(flyingCancel.data));
  assert.notEqual(flyingCancel.data.state, 'cancelled');
  assert.equal(await h.count('capacity_reservations', `WHERE operation_id=$1 AND state IN ('reserved','unknown')`, [flyingLaunch.data.operation_id]), 4);

  await setSyntheticFault(h.pool, 'synthetic-inventory', null);
  await setSyntheticFault(h.pool, 'synthetic-storefront', null);
  const doneSpace = await h.workspace(owner, tenantId, '已完成');
  const manual = await h.plan(owner, tenantId, h.planBody('guild_ai_field', doneSpace));
  const done = await h.launch(owner, tenantId, manual);
  assert.equal(done.status, 200, JSON.stringify(done.data));
  const terminal = await h.post(`/tenants/${tenantId}/operations/${done.data.operation_id}/cancel`, owner, { reason: 'member_cancelled' }, `"${done.data.version}"`);
  assert.equal(terminal.status, 409);
  assert.equal(terminal.data.code, 'operation_not_cancellable');
});

test('revoking the actor between steps records no further provider effect', async () => {
  const owner = await h.signIn(DEMO_USERS[0].email);
  await h.fullMember(owner.user.user_id, 'guild_ai_field');
  const made = await h.createTenant(owner, '權限品牌');
  const admin = await h.person('會被降級');
  await h.fullMember(admin.id, 'guild_ai_field');
  const principal = await h.candidate(owner, admin.id);
  const invitation = await h.invite(owner, made.tenantId, principal, 'admin');
  await h.accept(admin.session, made.tenantId, invitation);
  holdSyntheticApply();
  const planned = await h.plan(admin.session, made.tenantId, synthBody(made.workspaceId));
  const launched = h.launch(admin.session, made.tenantId, planned);
  await syntheticApplyEntered();
  const membership = (await h.pool.query(`SELECT version::text AS version FROM tenant_memberships WHERE tenant_id=$1 AND principal_id=$2`, [made.tenantId, principal])).rows[0];
  const demoted = await h.post(`/tenants/${made.tenantId}/members/${principal}/change`, owner, {
    role: 'viewer', status: 'active', instance_capabilities: [], reason: '測試期間改為檢視者',
  }, `"${membership.version}"`);
  assert.equal(demoted.status, 200, JSON.stringify(demoted.data));
  releaseSyntheticApply();
  const result = await launched;
  assert.ok(result.status === 202 || result.status === 403, JSON.stringify(result.data));
  const operationId = (await h.pool.query<{ operation_id: string }>(`SELECT operation_id FROM module_provision_operations WHERE tenant_id=$1`, [made.tenantId])).rows[0].operation_id;
  const seen = await h.call('GET', `/tenants/${made.tenantId}/operations/${operationId}`, owner);
  assert.equal(seen.status, 200, JSON.stringify(seen.data));
  assert.equal(seen.data.state, 'needs_reconciliation');
  assert.equal(await effects('synthetic-storefront'), 0);
  const inventory = (await h.pool.query(`SELECT status FROM module_instances WHERE tenant_id=$1 AND module_key='synthetic-inventory'`, [made.tenantId])).rows[0];
  assert.notEqual(inventory.status, 'active');
});

test('T-016 leaving the guild does not delete an in-flight launch, and a new plan is refused', async () => {
  const { owner, tenantId, workspaceId } = await prepared();
  holdSyntheticApply();
  const planned = await h.plan(owner, tenantId, synthBody(workspaceId));
  const launched = h.launch(owner, tenantId, planned);
  await syntheticApplyEntered();
  await h.pool.query(`UPDATE positioning_profession_memberships SET state='left', left_at=clock_timestamp()
    WHERE user_id=$1 AND guild_key='guild_ai_field'`, [owner.user.user_id]);
  releaseSyntheticApply();
  const result = await launched;
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(await h.count('module_instances', 'WHERE tenant_id=$1 AND status=$2', [tenantId, 'active']), 2);
  const again = await h.workspace(owner, tenantId, '離會後');
  const refused = await h.plan(owner, tenantId, synthBody(again));
  assert.equal(refused.status, 403);
  assert.equal(refused.data.code, 'guild_full_member_required');
  assert.equal(await h.count('module_instances', 'WHERE tenant_id=$1', [tenantId]), 2);
});
