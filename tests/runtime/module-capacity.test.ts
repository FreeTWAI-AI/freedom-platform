import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { transaction } from '../../packages/db/index.js';
import { DEMO_USERS } from '../../packages/testing/seed.js';
import { lockCapacityDimensions } from '../../modules/module-registry/capacity.js';
import { holdSyntheticApply, releaseSyntheticApply, syntheticApplyEntered } from '../../packages/testing/synthetic-module-provider.js';
import { createRegistryHarness, type RegistryHarness } from './module-registry-harness.js';

let h: RegistryHarness;

before(async () => { h = await createRegistryHarness('fp_mcap', { synthetic: true }); });
after(async () => { await h.stop(); });
beforeEach(async () => {
  releaseSyntheticApply();
  await h.reset();
});

async function prepared(display = '容量品牌') {
  const owner = await h.signIn(DEMO_USERS[0].email);
  await h.fullMember(owner.user.user_id, 'guild_ai_field');
  const made = await h.createTenant(owner, display);
  return { owner, ...made };
}

async function setLimits(values: { instances?: number; perModule?: number; concurrent?: number }) {
  await h.pool.query(`UPDATE tenant_capacity_policies SET
      max_active_instances=COALESCE($1, max_active_instances),
      max_instances_per_module=COALESCE($2, max_instances_per_module),
      max_concurrent_provisions=COALESCE($3, max_concurrent_provisions)
    WHERE status='active' AND tenant_id IS NULL`,
  [values.instances ?? null, values.perModule ?? null, values.concurrent ?? null]);
}

test('capacity advisory locks are acquired in lexicographic dimension order', async () => {
  const sorted = ['module_instances.work', 'concurrent_provisions', 'module_instances'].sort();
  assert.deepEqual(sorted, ['concurrent_provisions', 'module_instances', 'module_instances.work']);
  const tenant = randomUUID();
  await Promise.all([0, 1].map(() => transaction(h.pool, async q => {
    await lockCapacityDimensions(q, tenant, ['module_instances.work', 'concurrent_provisions', 'module_instances']);
    await delay(50);
  })));
});

test('T-018 one remaining slot admits one launch, unknown keeps the slot, and another tenant is untouched', async () => {
  const a = await prepared('品牌甲');
  const bOwner = await h.person('品牌乙擁有者');
  await h.fullMember(bOwner.id, 'guild_ai_field');
  const b = await h.createTenant(bOwner.session, '品牌乙');
  await setLimits({ instances: 1, perModule: 3, concurrent: 2 });
  const planA = await h.plan(a.owner, a.tenantId, h.planBody('guild_ai_field', a.workspaceId));
  const planB = await h.plan(bOwner.session, b.tenantId, h.planBody('guild_ai_field', b.workspaceId));
  const secondSpace = await h.workspace(a.owner, a.tenantId, '第二櫃');
  const planA2 = await h.plan(a.owner, a.tenantId, h.planBody('guild_ai_field', secondSpace));
  const raced = await Promise.all([
    h.launch(a.owner, a.tenantId, planA, randomUUID()),
    h.launch(a.owner, a.tenantId, planA2, randomUUID()),
  ]);
  const statuses = raced.map(item => item.status).sort();
  assert.deepEqual(statuses, [200, 429]);
  const denied = raced.find(item => item.status === 429)!;
  assert.equal(denied.data.code, 'quota_exceeded');
  assert.equal(denied.data.dimension, 'module_instances');
  assert.equal(denied.response.headers.get('retry-after'), null);
  assert.equal(await h.count('module_instances', 'WHERE tenant_id=$1', [a.tenantId]), 1);
  const other = await h.launch(bOwner.session, b.tenantId, planB);
  assert.equal(other.status, 200, JSON.stringify(other.data));
  assert.equal(await h.count('module_instances', 'WHERE tenant_id=$1', [b.tenantId]), 1);

  await setLimits({ instances: 3 });
  const synthSpace = await h.workspace(a.owner, a.tenantId, '合成櫃');
  const { setSyntheticFault } = await import('../../packages/testing/synthetic-module-provider.js');
  await setSyntheticFault(h.pool, 'synthetic-storefront', 'timeout');
  const synthPlan = await h.plan(a.owner, a.tenantId, h.planBody('guild_ai_field', synthSpace, 'synthetic-storefront', 'synthetic-storefront@1.0.0'));
  const synth = await h.launch(a.owner, a.tenantId, synthPlan);
  assert.equal(synth.status, 202, JSON.stringify(synth.data));
  assert.equal(synth.data.state, 'needs_reconciliation');
  const unknown = await h.count('capacity_reservations', `WHERE tenant_id=$1 AND state='unknown'`, [a.tenantId]);
  assert.ok(unknown > 0);
  const blocked = await h.plan(a.owner, a.tenantId, h.planBody('guild_ai_field', await h.workspace(a.owner, a.tenantId, '再一櫃'), 'manual-workspace', 'manual-workspace@1.0.0', {
    dependencies: [{ requirement_key: 'work', choice: 'create', configuration: {} }],
  }));
  const blockedLaunch = await h.launch(a.owner, a.tenantId, blocked);
  assert.equal(blockedLaunch.status, 429, JSON.stringify(blockedLaunch.data));
  assert.equal(await h.count('module_instances', 'WHERE tenant_id=$1', [b.tenantId]), 1);
  await assertLedger(a.tenantId);
  await assertLedger(b.tenantId);
});

async function assertLedger(tenantId: string) {
  const reserved = (await h.pool.query<{ dimension: string; units: string }>(
    `SELECT dimension, COALESCE(sum(units),0)::text AS units FROM capacity_reservations
     WHERE tenant_id=$1 AND state IN ('reserved','consumed','unknown') GROUP BY dimension`, [tenantId])).rows;
  for (const row of reserved) {
    let usage = '0';
    if (row.dimension === 'concurrent_provisions') {
      usage = (await h.pool.query(`SELECT count(*)::text AS n FROM module_provision_operations
        WHERE tenant_id=$1 AND state IN ('requested','running','needs_reconciliation')`, [tenantId])).rows[0].n;
    } else if (row.dimension === 'module_instances') {
      usage = (await h.pool.query(`SELECT count(*)::text AS n FROM module_instances
        WHERE tenant_id=$1 AND status IN ('requested','provisioning','active','suspended')`, [tenantId])).rows[0].n;
    } else {
      const moduleKey = row.dimension.slice('module_instances.'.length);
      usage = (await h.pool.query(`SELECT count(*)::text AS n FROM module_instances
        WHERE tenant_id=$1 AND module_key=$2 AND status IN ('requested','provisioning','active','suspended')`,
      [tenantId, moduleKey])).rows[0].n;
    }
    assert.equal(row.units, usage, `${tenantId} ${row.dimension}`);
  }
}

test('per-module and concurrent limits reject, reuse does not reserve another instance, and a missing or zero policy is refused', async () => {
  const { owner, tenantId, workspaceId } = await prepared();
  await setLimits({ instances: 10, perModule: 1, concurrent: 2 });
  const first = await h.plan(owner, tenantId, h.planBody('guild_ai_field', workspaceId));
  assert.equal((await h.launch(owner, tenantId, first)).status, 200);
  const secondSpace = await h.workspace(owner, tenantId, '第二櫃');
  const second = await h.plan(owner, tenantId, h.planBody('guild_ai_field', secondSpace, 'manual-workspace', 'manual-workspace@1.0.0', {
    dependencies: [{ requirement_key: 'work', choice: 'create', configuration: {} }],
  }));
  const overModule = await h.launch(owner, tenantId, second);
  assert.equal(overModule.status, 429, JSON.stringify(overModule.data));
  assert.equal(overModule.data.dimension, 'module_instances.work');
  assert.equal(await h.count('module_instances', 'WHERE tenant_id=$1', [tenantId]), 1);

  await setLimits({ perModule: 3, instances: 1 });
  const reuseSpace = await h.workspace(owner, tenantId, '沿用櫃');
  const version = (await h.pool.query(`SELECT version::text AS version, instance_id FROM module_instances WHERE tenant_id=$1`, [tenantId])).rows[0];
  const reuse = await h.plan(owner, tenantId, h.planBody('guild_ai_field', reuseSpace, 'manual-workspace', 'manual-workspace@1.0.0', {
    dependencies: [{ requirement_key: 'work', choice: 'reuse', instance_id: version.instance_id, expected_version: version.version }],
  }));
  assert.equal(reuse.status, 201, JSON.stringify(reuse.data));
  assert.equal(reuse.data.capacity_delta.some((item: { dimension: string }) => item.dimension === 'module_instances'), false);
  const reused = await h.launch(owner, tenantId, reuse);
  assert.equal(reused.status, 200, JSON.stringify(reused.data));
  assert.equal(await h.count('module_instances', 'WHERE tenant_id=$1', [tenantId]), 1);

  await setLimits({ instances: 10, concurrent: 1 });
  holdSyntheticApply();
  const slowSpace = await h.workspace(owner, tenantId, '慢櫃');
  const slowPlan = await h.plan(owner, tenantId, h.planBody('guild_ai_field', slowSpace, 'synthetic-storefront', 'synthetic-storefront@1.0.0'));
  const slow = h.launch(owner, tenantId, slowPlan);
  await syntheticApplyEntered();
  const otherSpace = await h.workspace(owner, tenantId, '同時櫃');
  const otherPlan = await h.plan(owner, tenantId, h.planBody('guild_ai_field', otherSpace, 'synthetic-storefront', 'synthetic-storefront@1.0.0'));
  const blocked = await h.launch(owner, tenantId, otherPlan);
  assert.equal(blocked.status, 429, JSON.stringify(blocked.data));
  assert.equal(blocked.data.dimension, 'concurrent_provisions');
  releaseSyntheticApply();
  assert.equal((await slow).status, 200, JSON.stringify((await slow).data ?? {}));

  await h.pool.query('DELETE FROM tenant_capacity_policies');
  const bare = await h.workspace(owner, tenantId, '無政策');
  const noPolicy = await h.plan(owner, tenantId, h.planBody('guild_ai_field', bare));
  assert.equal(noPolicy.status, 403);
  assert.equal(noPolicy.data.code, 'policy_unconfigured');
});

test('a zero limit forbids a new instance and a zero concurrent limit forbids a new provision', async () => {
  const { owner, tenantId, workspaceId } = await prepared('零上限');
  await setLimits({ instances: 0 });
  const planned = await h.plan(owner, tenantId, h.planBody('guild_ai_field', workspaceId));
  const denied = await h.launch(owner, tenantId, planned);
  assert.equal(denied.status, 429);
  assert.equal(denied.data.code, 'quota_exceeded');
  assert.equal(denied.data.dimension, 'module_instances');
  assert.equal(await h.count('module_instances', 'WHERE tenant_id=$1', [tenantId]), 0);
  await setLimits({ instances: 10, concurrent: 0 });
  const again = await h.plan(owner, tenantId, h.planBody('guild_ai_field', workspaceId));
  const concurrent = await h.launch(owner, tenantId, again);
  assert.equal(concurrent.status, 429);
  assert.equal(concurrent.data.dimension, 'concurrent_provisions');
  assert.equal(await h.count('application_installations', 'WHERE tenant_id=$1', [tenantId]), 0);
});
