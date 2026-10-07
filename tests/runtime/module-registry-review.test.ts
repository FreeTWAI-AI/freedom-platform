import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { PoolClient } from 'pg';
import { authenticate } from '../../modules/identity-membership/service.js';
import { setMemberTier } from '../../modules/positioning/member-tier.js';
import { launchApplication, advanceOperation, reconcileOperation, sweepDueOperations } from '../../modules/module-registry/service.js';
import { effectDigest } from '../../modules/module-registry/providers.js';
import type { Command } from '../../packages/db/index.js';
import { DEMO_COMMUNITY, DEMO_USERS } from '../../packages/testing/seed.js';
import { setSyntheticFault } from '../../packages/testing/synthetic-module-provider.js';
import { WORK_CONTRACT_SOURCE_COMMIT } from '../../modules/module-registry/definitions.js';
import { consumeInstanceReservations } from '../../modules/module-registry/capacity.js';
import type { ModuleProviderMap } from '../../modules/module-registry/providers.js';
import { createRegistryHarness, type RegistryHarness, type Session } from './module-registry-harness.js';

let h: RegistryHarness;

before(async () => { h = await createRegistryHarness('fp_mrev', { synthetic: true, max: 16 }); });
after(async () => { await h.stop(); });
beforeEach(async () => { await h.reset(); });

const SYNTH = {
  family: 'guild-launchpad.synthetic',
  version: '1',
  source_commit: WORK_CONTRACT_SOURCE_COMMIT,
  artifact_sha256: '0'.repeat(64),
  behavior_profile: 'freedom.synthetic/v1',
};

function tokenOf(session: Session) {
  return session.cookie.split('=')[1];
}

async function actorOf(session: Session) {
  return authenticate(h.pool, tokenOf(session));
}

async function prepared(name = '審查品牌') {
  const owner = await h.signIn(DEMO_USERS[0].email);
  await h.fullMember(owner.user.user_id, 'guild_ai_field');
  const made = await h.createTenant(owner, name);
  return { owner, actor: await actorOf(owner), ...made };
}

async function until(check: () => Promise<boolean>, message: string) {
  for (let n = 0; n < 500; n += 1) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail(message);
}

async function connect(): Promise<PoolClient> {
  return h.pool.connect();
}

async function ledgerNet(tenantId: string, operationId: string) {
  const rows = (await h.pool.query<{ dimension: string; net: string }>(
    `SELECT dimension, COALESCE(sum(delta), 0)::text AS net
     FROM capacity_ledger
     WHERE tenant_id=$1 AND operation_id=$2 AND kind IN ('reserved','released','unknown')
     GROUP BY dimension ORDER BY dimension`,
    [tenantId, operationId],
  )).rows;
  return Object.fromEntries(rows.map(row => [row.dimension, row.net]));
}

async function activeByModule(tenantId: string, operationId: string) {
  const rows = (await h.pool.query<{ module_key: string; n: string }>(
    `SELECT module_key, count(*)::text AS n FROM module_instances
     WHERE tenant_id=$1 AND provision_operation_id=$2 AND status='active'
     GROUP BY module_key`,
    [tenantId, operationId],
  )).rows;
  const byModule = Object.fromEntries(rows.map(row => [row.module_key, Number(row.n)]));
  const active = Object.values(byModule).reduce((sum, n) => sum + n, 0);
  return { active, byModule };
}

test('a partial confirmation keeps consumed capacity for the active instance when cancel settles', async () => {
  const { owner, actor, tenantId, workspaceId } = await prepared('部分取消');
  const space = workspaceId;
  const planned = await h.plan(owner, tenantId, h.planBody('guild_ai_field', space, 'synthetic-storefront', 'synthetic-storefront@1.0.0'));
  assert.equal(planned.status, 201, JSON.stringify(planned.data));
  const transactional = { kind: 'transactional' as const, async initialise() {}, async hasMemberData() { return false; } };
  const launched = await launchApplication(h.pool, actor, tenantId, {
    plan_id: planned.data.plan_id,
    expected_plan_version: planned.data.version,
    configuration_digest: planned.data.configuration_digest,
  }, randomUUID(), { ...h.providers, 'synthetic-inventory': transactional });
  const version = (await h.pool.query<{ version: string; state: string }>(
    `SELECT version::text AS version, state FROM module_provision_operations WHERE operation_id=$1`,
    [launched.operation_id],
  )).rows[0];
  assert.equal(version.state, 'running');
  assert.equal(await h.count('module_provision_steps', `WHERE operation_id=$1 AND state='confirmed'`, [launched.operation_id]), 1);
  const cancelled = await h.post(`/tenants/${tenantId}/operations/${launched.operation_id}/cancel`, owner, { reason: 'member_cancelled' }, `"${version.version}"`);
  assert.equal(cancelled.status, 202, JSON.stringify(cancelled.data));
  await h.pool.query(`UPDATE module_provision_operations SET cancel_requested_at=clock_timestamp() WHERE operation_id=$1 AND cancel_requested_at IS NULL`, [launched.operation_id]);
  await advanceOperation(h.pool, tenantId, launched.operation_id, { providers: h.providers, budget: 3000 });
  const settled = (await h.pool.query<{ state: string }>(`SELECT state FROM module_provision_operations WHERE operation_id=$1`, [launched.operation_id])).rows[0];
  assert.equal(settled.state, 'cancelled');
  const { active, byModule } = await activeByModule(tenantId, launched.operation_id);
  assert.equal(active, 1);
  const net = await ledgerNet(tenantId, launched.operation_id);
  assert.equal(net.module_instances, String(active), JSON.stringify(net));
  for (const [moduleKey, count] of Object.entries(byModule)) {
    assert.equal(net[`module_instances.${moduleKey}`], String(count), moduleKey);
  }
  assert.equal(net.concurrent_provisions ?? '0', '0');
  const archivedModule = (await h.pool.query<{ module_key: string }>(
    `SELECT module_key FROM module_instances WHERE tenant_id=$1 AND provision_operation_id=$2 AND status='archived'`,
    [tenantId, launched.operation_id],
  )).rows[0];
  assert.ok(archivedModule);
  assert.equal(net[`module_instances.${archivedModule.module_key}`] ?? '0', '0');
});

test('two reconciles that both pass the version check activate a step once', { timeout: 20_000 }, async () => {
  const { owner, actor, tenantId, workspaceId } = await prepared('對帳競態');
  await setSyntheticFault(h.pool, 'synthetic-inventory', 'timeout');
  await setSyntheticFault(h.pool, 'synthetic-storefront', 'timeout');
  const planned = await h.plan(owner, tenantId, h.planBody('guild_ai_field', workspaceId, 'synthetic-storefront', 'synthetic-storefront@1.0.0'));
  const launched = await h.launch(owner, tenantId, planned);
  assert.equal(launched.status, 202, JSON.stringify(launched.data));
  await h.pool.query(
    `UPDATE module_provision_steps SET state='pending' WHERE operation_id=$1 AND step_key='step-1'`,
    [launched.data.operation_id],
  );
  const step = (await h.pool.query<{ instance_id: string; provider_effect_key: string; evidence_ref: string | null; module_key: string }>(
    `SELECT s.instance_id, s.provider_effect_key, s.evidence_ref, i.module_key
     FROM module_provision_steps s
     JOIN module_instances i ON i.tenant_id=s.tenant_id AND i.instance_id=s.instance_id
     WHERE s.operation_id=$1 AND s.step_key='step-0'`,
    [launched.data.operation_id],
  )).rows[0];
  const digest = step.evidence_ref ?? effectDigest({
    effect_key: step.provider_effect_key, tenant_id: tenantId, instance_id: step.instance_id, module_key: step.module_key,
  });
  const version = (await h.pool.query<{ version: string }>(
    `SELECT version::text AS version FROM module_provision_operations WHERE operation_id=$1`,
    [launched.data.operation_id],
  )).rows[0].version;
  let waiting = 0;
  let openGate: () => void = () => {};
  const gate = new Promise<void>(resolve => { openGate = resolve; });
  const inventory = h.providers!['synthetic-inventory'] as { lookup: (key: string) => Promise<unknown> };
  const original = inventory.lookup.bind(inventory);
  inventory.lookup = async () => {
    waiting += 1;
    await gate;
    return { status: 'found', owner_tenant_id: tenantId, effect_digest: digest };
  };
  try {
    const first = reconcileOperation(h.pool, actor, tenantId, launched.data.operation_id, version, randomUUID(), h.providers!);
    const second = reconcileOperation(h.pool, actor, tenantId, launched.data.operation_id, version, randomUUID(), h.providers!);
    const settled = Promise.allSettled([first, second]);
    await until(async () => waiting >= 2, 'both reconciles did not reach lookup after the version check');
    openGate();
    const results = await settled;
    const activations = await h.count(
      'scoped_transition_journal',
      `WHERE aggregate_type='module_instance' AND aggregate_id=$1`,
      [step.instance_id],
    );
    assert.equal(activations, 1, JSON.stringify(results));
    assert.equal(await h.count('module_provision_steps', `WHERE operation_id=$1 AND step_key='step-0' AND state='confirmed'`, [launched.data.operation_id]), 1);
    const rejected = results.filter(item => item.status === 'rejected');
    const fulfilled = results.filter(item => item.status === 'fulfilled');
    assert.equal(fulfilled.length + rejected.length, 2);
    if (rejected.length) {
      const error = rejected[0].status === 'rejected' ? rejected[0].reason as { status?: number; code?: string } : {};
      assert.equal(error.status, 412);
      assert.equal(error.code, 'version_conflict');
    }
  } finally {
    inventory.lookup = original;
    openGate();
  }
});

test('two launches on one workspace do not deadlock between the insert and the workspace lock', { timeout: 20_000 }, async () => {
  const { owner, tenantId, workspaceId } = await prepared('鎖序');
  const manual = await h.plan(owner, tenantId, h.planBody('guild_ai_field', workspaceId));
  const synthetic = await h.plan(owner, tenantId, h.planBody('guild_ai_field', workspaceId, 'synthetic-storefront', 'synthetic-storefront@1.0.0'));
  assert.equal(manual.status, 201, JSON.stringify(manual.data));
  assert.equal(synthetic.status, 201, JSON.stringify(synthetic.data));
  const holder = await connect();
  try {
    await holder.query('BEGIN');
    // Capacity policy lock sits between the installation insert (workspace KEY SHARE) and the workspace row lock.
    await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`tenant.capacity/v1/${tenantId}/policy`]);
    const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const first = h.launch(owner, tenantId, manual, randomUUID());
    const second = h.launch(owner, tenantId, synthetic, randomUUID());
    // The FK's row lock shows up as RowShareLock on workspaces. Tuple ForKeyShare stays on the fast path.
    await until(async () => {
      const found = await h.pool.query<{ n: string }>(
        `SELECT count(DISTINCT l.pid)::text AS n
         FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
         WHERE c.relname='workspaces' AND l.locktype='relation' AND l.mode='RowShareLock' AND l.granted
           AND l.pid <> $1`,
        [holderPid],
      );
      return Number(found.rows[0].n) >= 2;
    }, 'both launches did not take the workspace key share after insert');
    await holder.query('COMMIT');
    const results = await Promise.all([first, second]);
    for (const item of results) {
      assert.ok(item.status === 200 || item.status === 202, JSON.stringify(item.data));
      assert.notEqual(item.data?.code, 'internal_error');
      assert.notEqual(item.data?.state, 'failed');
    }
    assert.equal(await h.count('application_installations', 'WHERE tenant_id=$1 AND workspace_id=$2', [tenantId, workspaceId]), 2);
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
  }
});

test('one poison operation does not stop a later due operation in the same sweep', async () => {
  const { owner, tenantId } = await prepared('掃尾');
  await setSyntheticFault(h.pool, 'synthetic-inventory', 'crash_before');
  await setSyntheticFault(h.pool, 'synthetic-storefront', 'crash_before');
  const ids: string[] = [];
  for (const name of ['先櫃', '後櫃']) {
    const space = await h.workspace(owner, tenantId, name);
    const planned = await h.plan(owner, tenantId, h.planBody('guild_ai_field', space, 'synthetic-storefront', 'synthetic-storefront@1.0.0'));
    const launched = await h.launch(owner, tenantId, planned);
    assert.equal(launched.status, 202, JSON.stringify(launched.data));
    ids.push(launched.data.operation_id as string);
  }
  ids.sort();
  const [poison, healthy] = ids;
  await setSyntheticFault(h.pool, 'synthetic-inventory', null);
  await setSyntheticFault(h.pool, 'synthetic-storefront', null);
  await h.pool.query(`UPDATE module_provision_steps SET lease_expires_at='2000-01-01T00:00:00Z', next_attempt_at='2000-01-01T00:00:00Z' WHERE operation_id = ANY($1::uuid[])`, [ids]);
  await h.pool.query(`UPDATE module_provision_steps SET lease_fence=2147483647 WHERE operation_id=$1`, [poison]);
  const lines: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args); };
  try {
    await sweepDueOperations(h.pool, undefined, h.providers);
  } finally {
    console.error = original;
  }
  const healthyState = (await h.pool.query<{ state: string }>(`SELECT state FROM module_provision_operations WHERE operation_id=$1`, [healthy])).rows[0].state;
  assert.equal(healthyState, 'succeeded', healthyState);
  assert.ok(lines.some(args => args[0] === 'module_provision_sweep_operation_failed'));
  assert.equal(JSON.stringify(lines).includes(tenantId), false);
});

test('a step due at clock_timestamp is claimed without a javascript clock', async () => {
  const { tenantId, workspaceId, owner } = await prepared('時鐘');
  await setSyntheticFault(h.pool, 'synthetic-inventory', 'crash_before');
  const planned = await h.plan(owner, tenantId, h.planBody('guild_ai_field', workspaceId, 'synthetic-storefront', 'synthetic-storefront@1.0.0'));
  const launched = await h.launch(owner, tenantId, planned);
  assert.equal(launched.status, 202, JSON.stringify(launched.data));
  await setSyntheticFault(h.pool, 'synthetic-inventory', null);
  await h.pool.query(
    `UPDATE module_provision_steps SET lease_expires_at=clock_timestamp(), next_attempt_at=clock_timestamp()
     WHERE operation_id=$1 AND state='dispatched'`,
    [launched.data.operation_id],
  );
  await advanceOperation(h.pool, tenantId, launched.data.operation_id, { providers: h.providers, budget: 3000 });
  assert.equal(await h.count('synthetic_module_effects', 'WHERE tenant_id=$1 AND module_key=$2', [tenantId, 'synthetic-inventory']), 1);
});

async function leaderFor(guild = 'guild_ai_field') {
  const leader = await h.person('公會長');
  await h.fullMember(leader.id, guild);
  await h.pool.query(
    `INSERT INTO positioning_guild_officers(community_id, guild_key, user_id) VALUES($1,$2,$3)
     ON CONFLICT (community_id, guild_key) DO UPDATE SET user_id=EXCLUDED.user_id`,
    [DEMO_COMMUNITY, guild, leader.id],
  );
  return leader;
}

test('demotion while launch waits on the workspace ends in guild_full_member_required and writes nothing', { timeout: 20_000 }, async () => {
  const owner = await h.person('正式會員');
  await h.fullMember(owner.id, 'guild_ai_field');
  const made = await h.createTenant(owner.session, '降級品牌');
  const leader = await leaderFor();
  const leaderActor = await actorOf(leader.session);
  const planned = await h.plan(owner.session, made.tenantId, h.planBody('guild_ai_field', made.workspaceId));
  assert.equal(planned.status, 201, JSON.stringify(planned.data));
  const before = await domainCounts(made.tenantId);
  const holder = await connect();
  try {
    await holder.query('BEGIN');
    await holder.query(`SELECT workspace_id FROM workspaces WHERE tenant_id=$1 AND workspace_id=$2 FOR UPDATE`, [made.tenantId, made.workspaceId]);
    const pending = h.launch(owner.session, made.tenantId, planned, randomUUID());
    await blockedBy(holder);
    await demoteMember(leaderActor, owner.id);
    await holder.query('COMMIT');
    const result = await pending;
    assert.equal(result.status, 403, JSON.stringify(result.data));
    assert.equal(result.data.code, 'guild_full_member_required');
    assert.deepEqual(await domainCounts(made.tenantId), before);
    assert.equal(await receiptCount(made.tenantId, 'application.launch'), 0);
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
  }
});

test('demotion while manual work waits on the workspace writes nothing', { timeout: 20_000 }, async () => {
  const owner = await h.person('工作會員');
  await h.fullMember(owner.id, 'guild_ai_field');
  const made = await h.createTenant(owner.session, '工作降級');
  const leader = await leaderFor();
  const leaderActor = await actorOf(leader.session);
  const before = await domainCounts(made.tenantId);
  const holder = await connect();
  try {
    await holder.query('BEGIN');
    await holder.query(`SELECT workspace_id FROM workspaces WHERE tenant_id=$1 AND workspace_id=$2 FOR UPDATE`, [made.tenantId, made.workspaceId]);
    const pending = h.enable(owner.session, made.tenantId, made.workspaceId, 'guild_ai_field');
    await blockedBy(holder);
    await demoteMember(leaderActor, owner.id);
    await holder.query('COMMIT');
    const result = await pending;
    assert.equal(result.status, 403, JSON.stringify(result.data));
    assert.equal(result.data.code, 'guild_full_member_required');
    assert.deepEqual(await domainCounts(made.tenantId), before);
    assert.equal(await receiptCount(made.tenantId, 'manual.work.enable'), 0);
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
  }
});

test('a full member still launches and an existing manual-work binding stays idempotent', async () => {
  const { owner, tenantId, workspaceId } = await prepared('沿用成功');
  const planned = await h.plan(owner, tenantId, h.planBody('guild_ai_field', workspaceId));
  const launched = await h.launch(owner, tenantId, planned);
  assert.equal(launched.status, 200, JSON.stringify(launched.data));
  const other = await h.workspace(owner, tenantId, '人工櫃');
  const enabled = await h.enable(owner, tenantId, other, 'guild_ai_field', { kind: 'create_new' });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
  assert.equal(enabled.data.reused, false);
  const again = await h.enable(owner, tenantId, other, 'guild_ai_field');
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(again.data.reused, true);
  assert.equal(again.data.instance_id, enabled.data.instance_id);
});

async function demoteMember(leader: Awaited<ReturnType<typeof actorOf>>, userId: string) {
  const version = (await h.pool.query<{ aggregate_version: string }>(
    `SELECT aggregate_version::text AS aggregate_version FROM positioning_profession_memberships
     WHERE community_id=$1 AND user_id=$2 AND guild_key='guild_ai_field'`,
    [DEMO_COMMUNITY, userId],
  )).rows[0].aggregate_version;
  const command: Command = { actor: leader, operation: 'set_member_tier', key: randomUUID(), body: { member_tier: 'intern' }, expected: version };
  const updated = await setMemberTier(h.pool, command, 'guild_ai_field', userId);
  assert.equal(updated.member_tier, 'intern');
}

async function blockedBy(holder: PoolClient) {
  const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0].pid;
  await until(async () => Boolean((await h.pool.query(
    `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS waiting`,
    [pid],
  )).rows[0].waiting), 'expected the launch to wait on the workspace row');
}

async function domainCounts(tenantId: string) {
  const tables = ['application_installations', 'module_instances', 'deployment_bindings', 'workspace_module_bindings', 'capacity_reservations', 'capacity_ledger', 'module_provision_operations'];
  const counts: Record<string, number> = {};
  for (const table of tables) counts[table] = await h.count(table, 'WHERE tenant_id=$1', [tenantId]);
  return counts;
}

async function receiptCount(tenantId: string, operation: string) {
  return h.count(
    'scoped_command_receipts r JOIN resource_scopes s ON s.scope_id=r.scope_id',
    'WHERE s.tenant_ref=$1 AND r.operation=$2',
    [tenantId, operation],
  );
}

test('launch does not reuse or bind a suspended compatible instance', async () => {
  const { owner, tenantId, workspaceId } = await prepared('停用實例');
  const firstPlan = await h.plan(owner, tenantId, h.planBody('guild_ai_field', workspaceId));
  assert.equal((await h.launch(owner, tenantId, firstPlan)).status, 200);
  const instance = (await h.pool.query<{ instance_id: string; version: string }>(
    `SELECT instance_id, version::text AS version FROM module_instances WHERE tenant_id=$1 AND module_key='work'`,
    [tenantId],
  )).rows[0];
  await h.pool.query(`UPDATE module_instances SET status='suspended' WHERE tenant_id=$1 AND instance_id=$2`, [tenantId, instance.instance_id]);
  const other = await h.workspace(owner, tenantId, '第二櫃');
  const reuse = await h.plan(owner, tenantId, h.planBody('guild_ai_field', other, 'manual-workspace', 'manual-workspace@1.0.0', {
    dependencies: [{ requirement_key: 'work', choice: 'reuse', instance_id: instance.instance_id, expected_version: instance.version }],
  }));
  assert.equal(reuse.status, 409, JSON.stringify(reuse.data));
  assert.equal(reuse.data.code, 'instance_unavailable');
  assert.equal(await h.count('workspace_module_bindings', 'WHERE tenant_id=$1 AND workspace_id=$2', [tenantId, other]), 0);
  assert.equal(await h.count('application_module_links', 'WHERE tenant_id=$1 AND instance_id=$2', [tenantId, instance.instance_id]), 1);
  assert.equal((await h.pool.query(`SELECT status FROM module_instances WHERE instance_id=$1`, [instance.instance_id])).rows[0].status, 'suspended');
});

test('listInstances returns session_expired when the session ends while the tenant row is locked', { timeout: 20_000 }, async () => {
  const { owner } = await prepared('讀取期限');
  const made = await h.createTenant(owner, '已有實例');
  const plan = await h.plan(owner, made.tenantId, h.planBody('guild_ai_field', made.workspaceId));
  assert.equal((await h.launch(owner, made.tenantId, plan)).status, 200);
  const sessionHash = (await actorOf(owner)).session_hash;
  await h.pool.query(`UPDATE sessions SET expires_at=clock_timestamp()+interval '1500 milliseconds' WHERE token_hash=$1`, [sessionHash]);
  const holder = await connect();
  try {
    await holder.query('BEGIN');
    await holder.query(`SELECT tenant_id FROM tenants WHERE tenant_id=$1 FOR UPDATE`, [made.tenantId]);
    const pending = h.call('GET', `/tenants/${made.tenantId}/module-instances`, owner);
    await blockedBy(holder);
    await until(async () => Boolean((await h.pool.query(
      `SELECT expires_at <= clock_timestamp() AS expired FROM sessions WHERE token_hash=$1`,
      [sessionHash],
    )).rows[0]?.expired), 'session deadline did not pass');
    await holder.query('COMMIT');
    const result = await pending;
    assert.equal(result.status, 401, JSON.stringify(result.data));
    assert.equal(result.data.code, 'session_expired');
    assert.equal(JSON.stringify(result.data).includes(made.tenantId), false);
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
  }
});

test('readOperation returns session_expired when the session ends while the tenant row is locked', { timeout: 20_000 }, async () => {
  const { owner, tenantId, workspaceId } = await prepared('操作讀取');
  const plan = await h.plan(owner, tenantId, h.planBody('guild_ai_field', workspaceId));
  const launched = await h.launch(owner, tenantId, plan);
  assert.equal(launched.status, 200, JSON.stringify(launched.data));
  const operationId = launched.data.operation_id as string;
  await h.pool.query(`UPDATE sessions SET expires_at=clock_timestamp()+interval '1500 milliseconds' WHERE token_hash=$1`, [(await actorOf(owner)).session_hash]);
  const holder = await connect();
  try {
    await holder.query('BEGIN');
    await holder.query(`SELECT tenant_id FROM tenants WHERE tenant_id=$1 FOR UPDATE`, [tenantId]);
    const pending = h.call('GET', `/tenants/${tenantId}/operations/${operationId}`, owner);
    await blockedBy(holder);
    await until(async () => Boolean((await h.pool.query(
      `SELECT expires_at <= clock_timestamp() AS expired FROM sessions WHERE user_id=$1`,
      [owner.user.user_id],
    )).rows[0].expired), 'session deadline did not pass');
    await holder.query('COMMIT');
    const result = await pending;
    assert.equal(result.status, 401, JSON.stringify(result.data));
    assert.equal(result.data.code, 'session_expired');
    assert.equal(JSON.stringify(result.data).includes(operationId), false);
    assert.equal(JSON.stringify(result.data).includes(tenantId), false);
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
  }
});

test('the public applications list varies on Cookie', async () => {
  const pub = await h.call('GET', '/applications?guild_key=guild_ai_field');
  assert.equal(pub.status, 200, JSON.stringify(pub.data));
  assert.equal(pub.response.headers.get('cache-control'), 'public, max-age=60');
  assert.equal(pub.response.headers.get('vary'), 'Cookie');
});

test('reconcile of a terminal operation returns that operation instead of operation_not_cancellable', async () => {
  const { owner, tenantId, workspaceId } = await prepared('已結束');
  const plan = await h.plan(owner, tenantId, h.planBody('guild_ai_field', workspaceId));
  const launched = await h.launch(owner, tenantId, plan);
  assert.equal(launched.status, 200, JSON.stringify(launched.data));
  const reconciled = await h.post(`/tenants/${tenantId}/operations/${launched.data.operation_id}/reconcile`, owner, {}, `"${launched.data.version}"`);
  assert.equal(reconciled.status, 202, JSON.stringify(reconciled.data));
  assert.equal(reconciled.data.state, 'succeeded');
  assert.notEqual(reconciled.data.code, 'operation_not_cancellable');
});

test('the entry binding follows the requirement that declares entry_capability', async () => {
  const { owner, actor, tenantId, workspaceId } = await prepared('入口能力');
  const requirements = [
    { requirement_key: 'inventory', module_key: 'synthetic-inventory', module_release_ref: 'synthetic-inventory@1.0.0', capabilities: ['inventory:read'], required: true, cardinality: 'one', allow_reuse: true, compatible_contracts: [SYNTH] },
    { requirement_key: 'storefront', module_key: 'synthetic-storefront', module_release_ref: 'synthetic-storefront@1.0.0', capabilities: ['storefront:sell'], required: true, cardinality: 'one', allow_reuse: false, compatible_contracts: [SYNTH] },
  ];
  await h.pool.query(
    `INSERT INTO application_definitions(
       application_key, release_ref, display_name, source_commit, artifact_digest, skill_book_refs,
       module_requirements, entry_capability, runtime_profiles, launch_policy_ref, license_state,
       release_status, customization_schema_ref, license_review_ref, version)
     VALUES('synthetic-entry','synthetic-entry@1.0.0','入口合成',$1,$2::jsonb,'[]'::jsonb,$3::jsonb,'inventory:read',
       '["hosted-reviewed"]'::jsonb,$4::jsonb,'reviewed','available','synthetic-inventory.config/v1',NULL,1)`,
    [WORK_CONTRACT_SOURCE_COMMIT, JSON.stringify({ algorithm: 'sha256', value: '0'.repeat(64) }), JSON.stringify(requirements), JSON.stringify({ policy_key: 'synthetic-storefront.launch', version: '1' })],
  );
  await h.pool.query(
    `INSERT INTO guild_application_offerings(offering_id, community_id, guild_key, application_key, release_ref, status, display_order, launch_policy_ref, version)
     VALUES($1,$2,'guild_ai_field','synthetic-entry','synthetic-entry@1.0.0','offered',11,$3::jsonb,1)`,
    [randomUUID(), DEMO_COMMUNITY, JSON.stringify({ policy_key: 'synthetic-storefront.launch', version: '1' })],
  );
  const planned = await h.plan(owner, tenantId, h.planBody('guild_ai_field', workspaceId, 'synthetic-entry', 'synthetic-entry@1.0.0'));
  assert.equal(planned.status, 201, JSON.stringify(planned.data));
  const transactional = { kind: 'transactional' as const, async initialise() {}, async hasMemberData() { return false; } };
  await launchApplication(h.pool, actor, tenantId, {
    plan_id: planned.data.plan_id,
    expected_plan_version: planned.data.version,
    configuration_digest: planned.data.configuration_digest,
  }, randomUUID(), { 'synthetic-inventory': transactional, 'synthetic-storefront': transactional });
  const binding = (await h.pool.query<{ entry_capability: string; module_key: string }>(
    `SELECT w.entry_capability, i.module_key FROM workspace_module_bindings w
     JOIN module_instances i ON i.tenant_id=w.tenant_id AND i.instance_id=w.instance_id
     WHERE w.tenant_id=$1 AND w.workspace_id=$2`,
    [tenantId, workspaceId],
  )).rows[0];
  assert.equal(binding?.entry_capability, 'inventory:read');
  assert.equal(binding?.module_key, 'synthetic-inventory');
});

test('a definition whose provider requirement has no capability is refused', async () => {
  const { owner, tenantId, workspaceId } = await prepared('依賴方向');
  const requirements = [
    { requirement_key: 'inventory', module_key: 'synthetic-inventory', module_release_ref: 'synthetic-inventory@1.0.0', capabilities: [], required: true, cardinality: 'one', allow_reuse: true, compatible_contracts: [SYNTH] },
    { requirement_key: 'storefront', module_key: 'synthetic-storefront', module_release_ref: 'synthetic-storefront@1.0.0', capabilities: ['storefront:sell'], required: true, cardinality: 'one', allow_reuse: false, compatible_contracts: [SYNTH] },
  ];
  await h.pool.query(
    `INSERT INTO application_definitions(
       application_key, release_ref, display_name, source_commit, artifact_digest, skill_book_refs,
       module_requirements, entry_capability, runtime_profiles, launch_policy_ref, license_state,
       release_status, customization_schema_ref, license_review_ref, version)
     VALUES('synthetic-edge','synthetic-edge@1.0.0','空能力',$1,$2::jsonb,'[]'::jsonb,$3::jsonb,'storefront:sell',
       '["hosted-reviewed"]'::jsonb,$4::jsonb,'reviewed','available','synthetic-storefront.config/v1',NULL,1)`,
    [WORK_CONTRACT_SOURCE_COMMIT, JSON.stringify({ algorithm: 'sha256', value: '0'.repeat(64) }), JSON.stringify(requirements), JSON.stringify({ policy_key: 'synthetic-storefront.launch', version: '1' })],
  );
  await h.pool.query(
    `INSERT INTO guild_application_offerings(offering_id, community_id, guild_key, application_key, release_ref, status, display_order, launch_policy_ref, version)
     VALUES($1,$2,'guild_ai_field','synthetic-edge','synthetic-edge@1.0.0','offered',12,$3::jsonb,1)`,
    [randomUUID(), DEMO_COMMUNITY, JSON.stringify({ policy_key: 'synthetic-storefront.launch', version: '1' })],
  );
  const planned = await h.plan(owner, tenantId, h.planBody('guild_ai_field', workspaceId, 'synthetic-edge', 'synthetic-edge@1.0.0'));
  assert.equal(planned.status, 409, JSON.stringify(planned.data));
  assert.equal(planned.data.code, 'application_not_available');
  assert.equal(await h.count('module_dependencies', 'WHERE tenant_id=$1', [tenantId]), 0);
});

test('module resolution follows the requirement pin rather than the release row version', async () => {
  const { owner, tenantId, workspaceId } = await prepared('版本釘選');
  await h.pool.query(
    `INSERT INTO module_definitions(
       module_key, release_ref, capabilities, data_catalog_ref, contract_ref, data_schema_version,
       portable_profile_ref, runtime_profiles, config_schema_ref, supported_upgrade_paths,
       license_review_ref, license_state, release_status, version)
     VALUES('synthetic-inventory','synthetic-inventory@9.0.0','["inventory:read"]'::jsonb,'synthetic.tenant/v1',$1::jsonb,'9',
       NULL,'["hosted-shared"]'::jsonb,'synthetic-inventory.config/v1','[]'::jsonb,NULL,'reviewed','available',50)`,
    [JSON.stringify({ ...SYNTH, artifact_sha256: 'ab'.repeat(32) })],
  );
  const requirements = [
    { requirement_key: 'inventory', module_key: 'synthetic-inventory', module_release_ref: 'synthetic-inventory@1.0.0', capabilities: ['inventory:read'], required: true, cardinality: 'one', allow_reuse: true, compatible_contracts: [SYNTH] },
    { requirement_key: 'storefront', module_key: 'synthetic-storefront', module_release_ref: 'synthetic-storefront@1.0.0', capabilities: ['storefront:sell'], required: true, cardinality: 'one', allow_reuse: false, compatible_contracts: [SYNTH] },
  ];
  await h.pool.query(
    `INSERT INTO application_definitions(
       application_key, release_ref, display_name, source_commit, artifact_digest, skill_book_refs,
       module_requirements, entry_capability, runtime_profiles, launch_policy_ref, license_state,
       release_status, customization_schema_ref, license_review_ref, version)
     VALUES('synthetic-pinned','synthetic-pinned@1.0.0','釘選合成',$1,$2::jsonb,'[]'::jsonb,$3::jsonb,'storefront:sell',
       '["hosted-reviewed"]'::jsonb,$4::jsonb,'reviewed','available','synthetic-storefront.config/v1',NULL,1)`,
    [WORK_CONTRACT_SOURCE_COMMIT, JSON.stringify({ algorithm: 'sha256', value: '0'.repeat(64) }), JSON.stringify(requirements), JSON.stringify({ policy_key: 'synthetic-storefront.launch', version: '1' })],
  );
  await h.pool.query(
    `INSERT INTO guild_application_offerings(offering_id, community_id, guild_key, application_key, release_ref, status, display_order, launch_policy_ref, version)
     VALUES($1,$2,'guild_ai_field','synthetic-pinned','synthetic-pinned@1.0.0','offered',13,$3::jsonb,1)`,
    [randomUUID(), DEMO_COMMUNITY, JSON.stringify({ policy_key: 'synthetic-storefront.launch', version: '1' })],
  );
  const planned = await h.plan(owner, tenantId, h.planBody('guild_ai_field', workspaceId, 'synthetic-pinned', 'synthetic-pinned@1.0.0'));
  assert.equal(planned.status, 201, JSON.stringify(planned.data));
  const launched = await h.launch(owner, tenantId, planned);
  assert.ok(launched.status === 200 || launched.status === 202, JSON.stringify(launched.data));
  const release = (await h.pool.query<{ module_release_ref: string }>(
    `SELECT module_release_ref FROM module_instances WHERE tenant_id=$1 AND module_key='synthetic-inventory'`,
    [tenantId],
  )).rows[0];
  assert.equal(release.module_release_ref, 'synthetic-inventory@1.0.0');
});

async function waitForBlocked(holderPid: number, parts: string[]) {
  let seen: { pid: number; query: string }[] = [];
  for (let attempt = 0; attempt < 200; attempt += 1) {
    seen = (await h.pool.query<{ pid: number; query: string }>(
      `SELECT pid, query FROM pg_stat_activity WHERE pid <> $1 AND $1 = ANY(pg_blocking_pids(pid))`,
      [holderPid],
    )).rows.map(row => ({ pid: Number(row.pid), query: row.query ?? '' }));
    const hit = seen.find(row => parts.every(part => row.query.includes(part)));
    if (hit) return hit;
    await delay(25);
  }
  assert.fail(`no backend blocked by ${holderPid} matching ${parts.join(' & ')}; saw ${JSON.stringify(seen)}`);
}

async function waitForBlockedCount(holderPid: number, parts: string[], count: number) {
  let hits: { pid: number; query: string }[] = [];
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const seen = (await h.pool.query<{ pid: number; query: string }>(
      `SELECT pid, query FROM pg_stat_activity WHERE pid <> $1 AND $1 = ANY(pg_blocking_pids(pid))`,
      [holderPid],
    )).rows.map(row => ({ pid: Number(row.pid), query: row.query ?? '' }));
    hits = seen.filter(row => parts.every(part => row.query.includes(part)));
    if (hits.length >= count) return hits;
    await delay(25);
  }
  assert.fail(`expected ${count} backends blocked by ${holderPid} matching ${parts.join(' & ')}; saw ${JSON.stringify(hits)}`);
}

function definedOutcome(result: { status: number; data: { code?: string; state?: string } }) {
  assert.notEqual(result.status, 500, JSON.stringify(result.data));
  assert.notEqual(result.data?.code, 'internal_error');
  assert.notEqual(result.data?.state, 'failed');
}

test('manual enable of a suspended reuse target is not_found and writes nothing', async () => {
  const { owner, tenantId, workspaceId } = await prepared('停用沿用');
  const first = await h.enable(owner, tenantId, workspaceId, 'guild_ai_field');
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const other = await h.workspace(owner, tenantId, '第二櫃');
  await h.pool.query(`UPDATE module_instances SET status='suspended' WHERE instance_id=$1`, [first.data.instance_id]);
  const before = await domainCounts(tenantId);
  const receipts = await receiptCount(tenantId, 'manual.work.enable');
  const plans = await h.count('module_launch_plans', 'WHERE tenant_id=$1', [tenantId]);
  const reused = await h.enable(owner, tenantId, other, 'guild_ai_field', {
    kind: 'reuse', instance_id: first.data.instance_id, expected_version: first.data.version,
  });
  assert.equal(reused.status, 404, JSON.stringify(reused.data));
  assert.equal(reused.data.code, 'not_found');
  assert.deepEqual(await domainCounts(tenantId), before);
  assert.equal(await receiptCount(tenantId, 'manual.work.enable'), receipts);
  assert.equal(await h.count('module_launch_plans', 'WHERE tenant_id=$1', [tenantId]), plans);
  assert.equal(await h.count('workspace_module_bindings', 'WHERE tenant_id=$1 AND workspace_id=$2', [tenantId, other]), 0);
});

test('a reuse target suspended while manual enable waits is not_found and writes nothing', { timeout: 20_000 }, async () => {
  const { owner, tenantId, workspaceId } = await prepared('等待中停用');
  const first = await h.enable(owner, tenantId, workspaceId, 'guild_ai_field');
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const other = await h.workspace(owner, tenantId, '第二櫃');
  const before = await domainCounts(tenantId);
  const holder = await connect();
  const pending: Promise<unknown>[] = [];
  try {
    await holder.query('BEGIN');
    await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`tenant.capacity/v1/${tenantId}/policy`]);
    const pid = Number((await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    const enabling = h.enable(owner, tenantId, other, 'guild_ai_field', {
      kind: 'reuse', instance_id: first.data.instance_id, expected_version: first.data.version,
    });
    pending.push(enabling);
    await waitForBlocked(pid, ['pg_advisory_xact_lock']);
    await h.pool.query(`UPDATE module_instances SET status='suspended' WHERE instance_id=$1`, [first.data.instance_id]);
    await holder.query('COMMIT');
    const reused = await enabling;
    assert.equal(reused.status, 404, JSON.stringify(reused.data));
    assert.equal(reused.data.code, 'not_found');
    assert.deepEqual(await domainCounts(tenantId), before);
    assert.equal(await h.count('workspace_module_bindings', 'WHERE tenant_id=$1 AND workspace_id=$2', [tenantId, other]), 0);
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
    await Promise.allSettled(pending);
  }
});

test('manual enable and a launch on one workspace do not deadlock when enable arrives first', { timeout: 30_000 }, async () => {
  const { owner, tenantId, workspaceId } = await prepared('啟用先到');
  const planned = await h.plan(owner, tenantId, h.planBody('guild_ai_field', workspaceId, 'synthetic-storefront', 'synthetic-storefront@1.0.0'));
  assert.equal(planned.status, 201, JSON.stringify(planned.data));
  const holder = await connect();
  const pending: Promise<unknown>[] = [];
  try {
    await holder.query('BEGIN');
    await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`tenant.capacity/v1/${tenantId}/policy`]);
    const pid = Number((await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    const enabling = h.enable(owner, tenantId, workspaceId, 'guild_ai_field');
    pending.push(enabling);
    await waitForBlocked(pid, ['pg_advisory_xact_lock']);
    const launching = h.launch(owner, tenantId, planned);
    pending.push(launching);
    const waiting = await waitForBlockedCount(pid, ['pg_advisory_xact_lock'], 2);
    assert.equal(waiting.length, 2);
    await holder.query('COMMIT');
    const enabled = await enabling;
    const launched = await launching;
    definedOutcome(enabled);
    definedOutcome(launched);
    assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
    assert.equal(enabled.data.reused, false);
    assert.ok(launched.status === 200 || launched.status === 202, JSON.stringify(launched.data));
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
    await Promise.allSettled(pending);
  }
});

test('manual enable and a launch on one workspace do not deadlock when launch arrives first', { timeout: 30_000 }, async () => {
  const { owner, tenantId, workspaceId } = await prepared('啟動先到');
  const planned = await h.plan(owner, tenantId, h.planBody('guild_ai_field', workspaceId, 'synthetic-storefront', 'synthetic-storefront@1.0.0'));
  assert.equal(planned.status, 201, JSON.stringify(planned.data));
  const holder = await connect();
  const pending: Promise<unknown>[] = [];
  try {
    await holder.query('BEGIN');
    await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`tenant.capacity/v1/${tenantId}/policy`]);
    const pid = Number((await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    const launching = h.launch(owner, tenantId, planned);
    pending.push(launching);
    await waitForBlocked(pid, ['pg_advisory_xact_lock']);
    const enabling = h.enable(owner, tenantId, workspaceId, 'guild_ai_field');
    pending.push(enabling);
    const waiting = await waitForBlockedCount(pid, ['pg_advisory_xact_lock'], 2);
    assert.equal(waiting.length, 2);
    await holder.query('COMMIT');
    const launched = await launching;
    const enabled = await enabling;
    definedOutcome(launched);
    definedOutcome(enabled);
    assert.ok(launched.status === 200 || launched.status === 202, JSON.stringify(launched.data));
    assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
    assert.equal(enabled.data.reused, false);
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
    await Promise.allSettled(pending);
  }
});

for (const ended of ['expired', 'revoked'] as const) {
  for (const suffix of ['', '?guild_key=guild_ai_field']) {
    test(`r4 public catalog treats an ${ended} session as anonymous ${suffix || 'without guild_key'}`, async () => {
      const { owner, actor } = await prepared();
      if (ended === 'expired') {
        await h.pool.query(`UPDATE sessions SET expires_at='2000-01-01T00:00:00Z' WHERE token_hash=$1`, [actor.session_hash]);
      } else {
        await h.pool.query(`UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1`, [actor.session_hash]);
      }
      const reply = await h.call('GET', `/applications${suffix}`, owner);
      assert.equal(reply.status, 200, JSON.stringify(reply.data));
      assert.equal(reply.response.headers.get('cache-control'), 'public, max-age=60');
      assert.equal(reply.response.headers.get('vary'), 'Cookie');
      assert.ok(reply.data.items.length > 0);
      for (const item of reply.data.items) assert.equal(Object.hasOwn(item, 'eligibility'), false);
      const detail = await h.call('GET', '/applications/manual-workspace/releases/manual-workspace@1.0.0', owner);
      assert.equal(detail.status, 200, JSON.stringify(detail.data));
      assert.equal(detail.response.headers.get('cache-control'), 'public, max-age=60');
      assert.equal(detail.response.headers.get('vary'), 'Cookie');
      assert.equal(Object.hasOwn(detail.data, 'eligibility'), false);
    });
  }
}

/** Test-only history catches transient status changes inside a single committed transaction. */
async function observeTerminalTransitions() {
  await h.pool.query(`CREATE TABLE IF NOT EXISTS review_transition_history(
    aggregate text NOT NULL, id uuid NOT NULL, old_state text NOT NULL, new_state text NOT NULL,
    old_version bigint NOT NULL, new_version bigint NOT NULL)`);
  await h.pool.query(`TRUNCATE review_transition_history`);
  await h.pool.query(`CREATE OR REPLACE FUNCTION review_record_transition() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_TABLE_NAME='application_installations' THEN
        INSERT INTO review_transition_history VALUES('installation',NEW.installation_id,OLD.status,NEW.status,OLD.version,NEW.version);
      ELSE
        INSERT INTO review_transition_history VALUES('operation',NEW.operation_id,OLD.state,NEW.state,OLD.version,NEW.version);
      END IF;
      RETURN NEW;
    END $$`);
  await h.pool.query(`CREATE OR REPLACE TRIGGER review_installation_transition AFTER UPDATE ON application_installations
    FOR EACH ROW EXECUTE FUNCTION review_record_transition()`);
  await h.pool.query(`CREATE OR REPLACE TRIGGER review_operation_transition AFTER UPDATE ON module_provision_operations
    FOR EACH ROW EXECUTE FUNCTION review_record_transition()`);
}

async function assertCapacitySettlement(tenantId: string, operationId: string) {
  const reservations = (await h.pool.query<{ dimension: string; units: string; state: string; actuals: number; net: string }>(
    `SELECT r.dimension, r.units::text AS units, r.state,
       (SELECT count(*)::int FROM capacity_ledger l WHERE l.tenant_id=r.tenant_id AND l.operation_id=r.operation_id
         AND l.dimension=r.dimension AND l.kind='actual') AS actuals,
       (SELECT COALESCE(sum(l.delta),0)::text FROM capacity_ledger l WHERE l.tenant_id=r.tenant_id AND l.operation_id=r.operation_id
         AND l.dimension=r.dimension AND l.kind IN ('reserved','released')) AS net
     FROM capacity_reservations r WHERE r.tenant_id=$1 AND r.operation_id=$2 ORDER BY r.dimension`,
    [tenantId, operationId],
  )).rows;
  assert.ok(reservations.length > 0);
  for (const row of reservations) {
    assert.equal(row.actuals, row.state === 'consumed' ? 1 : 0, JSON.stringify(row));
    assert.equal(row.net, row.state === 'released' ? '0' : row.units, JSON.stringify(row));
  }
}

async function assertCancelledSettlement(tenantId: string, workspaceId: string, operationId: string, active: string[]) {
  const operation = (await h.pool.query(`SELECT state,terminal_problem FROM module_provision_operations WHERE operation_id=$1`, [operationId])).rows[0];
  assert.equal(operation.state, 'cancelled');
  assert.equal(operation.terminal_problem, null);
  const terminal = (await h.pool.query(`SELECT new_state,old_version::text,new_version::text FROM review_transition_history
    WHERE aggregate='operation' AND id=$1 AND new_state IN ('succeeded','failed','cancelled')`, [operationId])).rows;
  assert.equal(terminal.length, 1, JSON.stringify(terminal));
  assert.equal(terminal[0].new_state, 'cancelled');
  assert.equal(BigInt(terminal[0].new_version) - BigInt(terminal[0].old_version), 1n);
  const installation = (await h.pool.query(`SELECT installation_id,status,retained_instance_ids FROM application_installations
    WHERE tenant_id=$1 AND provision_operation_id=$2`, [tenantId, operationId])).rows[0];
  assert.equal(installation.status, active.length ? 'failed' : 'archived');
  assert.deepEqual(installation.retained_instance_ids, [...active].sort());
  assert.equal(await h.count('review_transition_history', `WHERE aggregate='installation' AND id=$1 AND new_state='active'`, [installation.installation_id]), 0);
  assert.equal(await h.count('workspace_module_bindings', 'WHERE tenant_id=$1 AND workspace_id=$2', [tenantId, workspaceId]), 0);
  const instances = (await h.pool.query(`SELECT instance_id,status FROM module_instances WHERE tenant_id=$1 AND provision_operation_id=$2`, [tenantId, operationId])).rows;
  for (const instance of instances) assert.equal(instance.status, active.includes(instance.instance_id) ? 'active' : 'archived');
  const reservations = (await h.pool.query(`SELECT dimension,state FROM capacity_reservations WHERE tenant_id=$1 AND operation_id=$2`, [tenantId, operationId])).rows;
  assert.equal(reservations.find(row => row.dimension === 'concurrent_provisions').state, 'released');
  await assertCapacitySettlement(tenantId, operationId);
}

for (const resolution of ['found', 'absent'] as const) {
  test(`r5 cancelled reconcile ${resolution} settles the last open step once`, async () => {
    const { owner, actor, tenantId, workspaceId } = await prepared('取消核對');
    await setSyntheticFault(h.pool, 'synthetic-storefront', resolution === 'found' ? 'ack_lost' : 'timeout');
    const planned = await h.plan(owner, tenantId, h.planBody('guild_ai_field', workspaceId, 'synthetic-storefront', 'synthetic-storefront@1.0.0'));
    const launched = await h.launch(owner, tenantId, planned);
    assert.equal(launched.status, 202, JSON.stringify(launched.data));
    const operationId = launched.data.operation_id;
    const steps = (await h.pool.query(`SELECT instance_id,state FROM module_provision_steps WHERE operation_id=$1 ORDER BY ordinal`, [operationId])).rows;
    assert.deepEqual(steps.map(row => row.state), ['confirmed', 'unknown']);
    await observeTerminalTransitions();
    const cancelled = await h.post(`/tenants/${tenantId}/operations/${operationId}/cancel`, owner, { reason: 'member_cancelled' }, `"${launched.data.version}"`);
    assert.equal(cancelled.status, 202, JSON.stringify(cancelled.data));
    assert.equal(await h.count('capacity_reservations', `WHERE operation_id=$1 AND state='released'`, [operationId]), 0);
    const reconciled = await reconcileOperation(h.pool, actor, tenantId, operationId, cancelled.data.version, randomUUID(), h.providers!);
    assert.equal(reconciled.state, 'cancelled');
    await advanceOperation(h.pool, tenantId, operationId, { providers: h.providers });
    await assertCancelledSettlement(tenantId, workspaceId, operationId, resolution === 'found' ? steps.map(row => row.instance_id) : [steps[0].instance_id]);
  });
}

for (const outcome of ['confirmed', 'failed_known'] as const) {
  for (const memberData of outcome === 'failed_known' ? [false, true] : [false]) {
    test(`r5 cancelled executor ${outcome} retains confirmed instances with member data ${memberData}`, async () => {
      const { owner, actor, tenantId, workspaceId } = await prepared('取消派送');
      const planned = await h.plan(owner, tenantId, h.planBody('guild_ai_field', workspaceId, 'synthetic-storefront', 'synthetic-storefront@1.0.0'));
      const provider = h.providers!['synthetic-storefront'];
      if (provider.kind !== 'async') throw new Error('async provider required');
      let entered!: () => void;
      let release!: () => void;
      const applying = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const providers: ModuleProviderMap = { ...h.providers, 'synthetic-storefront': { ...provider,
        async apply() { entered(); await gate; return outcome; },
        async hasMemberData() { return memberData; },
      } };
      const launched = await launchApplication(h.pool, actor, tenantId, {
        plan_id: planned.data.plan_id, expected_plan_version: planned.data.version, configuration_digest: planned.data.configuration_digest,
      }, randomUUID(), providers);
      await observeTerminalTransitions();
      const advancing = advanceOperation(h.pool, tenantId, launched.operation_id, { providers });
      try {
        await applying;
        const current = await h.call('GET', `/tenants/${tenantId}/operations/${launched.operation_id}`, owner);
        const cancelled = await h.post(`/tenants/${tenantId}/operations/${launched.operation_id}/cancel`, owner, { reason: 'member_cancelled' }, `"${current.data.version}"`);
        assert.equal(cancelled.status, 202, JSON.stringify(cancelled.data));
      } finally { release(); await advancing; }
      const steps = (await h.pool.query(`SELECT instance_id,state FROM module_provision_steps WHERE operation_id=$1 ORDER BY ordinal`, [launched.operation_id])).rows;
      assert.equal(steps[0].state, 'confirmed');
      assert.equal(steps[1].state, outcome);
      await advanceOperation(h.pool, tenantId, launched.operation_id, { providers });
      await assertCancelledSettlement(tenantId, workspaceId, launched.operation_id,
        outcome === 'confirmed' || memberData ? steps.map(row => row.instance_id) : [steps[0].instance_id]);
    });
  }
}

for (const state of ['pending', 'retired'] as const) {
  for (const surface of ['plan', 'facade'] as const) {
    test(`r5 default create through ${surface} excludes a ${state} deployment at launch`, async () => {
      const { owner, tenantId, workspaceId } = await prepared('平台暫停');
      const existing = await h.enable(owner, tenantId, workspaceId, 'guild_ai_field');
      assert.equal(existing.status, 200, JSON.stringify(existing.data));
      await h.pool.query(`UPDATE deployment_bindings SET state=$3 WHERE tenant_id=$1 AND instance_id=$2`, [tenantId, existing.data.instance_id, state]);
      const target = await h.workspace(owner, tenantId, '新工作區');
      if (surface === 'plan') {
        const planned = await h.plan(owner, tenantId, h.planBody('guild_ai_field', target));
        assert.equal(planned.status, 201, JSON.stringify(planned.data));
        assert.deepEqual(planned.data.choices, [{ requirement_key: 'work', choice: 'create', configuration: {} }]);
        const launched = await h.launch(owner, tenantId, planned);
        assert.equal(launched.status, 200, JSON.stringify(launched.data));
        assert.equal(launched.data.state, 'succeeded');
      } else {
        const enabled = await h.enable(owner, tenantId, target, 'guild_ai_field');
        assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
        assert.notEqual(enabled.data.instance_id, existing.data.instance_id);
      }
      assert.equal(await h.count('module_instances', 'WHERE tenant_id=$1', [tenantId]), 2);
      assert.equal(await h.count('workspace_module_bindings', 'WHERE tenant_id=$1 AND workspace_id=$2 AND instance_id<>$3', [tenantId, target, existing.data.instance_id]), 1);
    });
  }
}

test('r5 default create is plan_stale when a usable candidate appears after planning', async () => {
  const { owner, tenantId, workspaceId } = await prepared('新增候選');
  const planned = await h.plan(owner, tenantId, h.planBody('guild_ai_field', workspaceId));
  assert.equal(planned.status, 201, JSON.stringify(planned.data));
  const other = await h.workspace(owner, tenantId, '另一工作區');
  assert.equal((await h.enable(owner, tenantId, other, 'guild_ai_field')).status, 200);
  const before = await domainCounts(tenantId);
  const launched = await h.launch(owner, tenantId, planned);
  assert.equal(launched.status, 409, JSON.stringify(launched.data));
  assert.equal(launched.data.code, 'plan_stale');
  assert.deepEqual(await domainCounts(tenantId), before);
});

test('r5 authorization gate failure keeps precedence over accepted cancel', async () => {
  const { owner, actor, tenantId, workspaceId } = await prepared('撤銷優先');
  const transactional = { kind: 'transactional' as const, async initialise() {}, async hasMemberData() { return false; } };
  const providers = { ...h.providers, 'synthetic-inventory': transactional };
  const planned = await h.plan(owner, tenantId, h.planBody('guild_ai_field', workspaceId, 'synthetic-storefront', 'synthetic-storefront@1.0.0'));
  const launched = await launchApplication(h.pool, actor, tenantId, {
    plan_id: planned.data.plan_id, expected_plan_version: planned.data.version, configuration_digest: planned.data.configuration_digest,
  }, randomUUID(), providers);
  const current = await h.call('GET', `/tenants/${tenantId}/operations/${launched.operation_id}`, owner);
  const cancelled = await h.post(`/tenants/${tenantId}/operations/${launched.operation_id}/cancel`, owner, { reason: 'member_cancelled' }, `"${current.data.version}"`);
  assert.equal(cancelled.status, 202, JSON.stringify(cancelled.data));
  const suspended = await h.pool.query(`UPDATE tenants SET status='suspended' WHERE tenant_id=$1`, [tenantId]);
  assert.equal(suspended.rowCount, 1);
  await observeTerminalTransitions();
  await advanceOperation(h.pool, tenantId, launched.operation_id, { providers });
  const settled = (await h.pool.query(`SELECT state,terminal_problem FROM module_provision_operations WHERE operation_id=$1`, [launched.operation_id])).rows[0];
  assert.equal(settled.state, 'failed');
  assert.equal(settled.terminal_problem.code, 'capability_denied');
  assert.equal(await h.count('review_transition_history', `WHERE aggregate='operation' AND id=$1 AND new_state='cancelled'`, [launched.operation_id]), 0);
  await assertCapacitySettlement(tenantId, launched.operation_id);
});

test('r4 executor binding conflict makes one terminal transition and consumes capacity once', async () => {
  const { owner, actor, tenantId, workspaceId } = await prepared('入口衝突');
  const other = await h.workspace(owner, tenantId, '既有櫃');
  const enabled = await h.enable(owner, tenantId, other, 'guild_ai_field');
  assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
  const planned = await h.plan(owner, tenantId, h.planBody('guild_ai_field', workspaceId, 'manual-workspace', 'manual-workspace@1.0.0', {
    dependencies: [{ requirement_key: 'work', choice: 'create', configuration: {} }],
  }));
  assert.equal(planned.status, 201, JSON.stringify(planned.data));
  // Use the synthetic async provider under the work key. Pause after durable confirmation,
  // before the executor's recordOutcome transaction, so binding can change without DB locks.
  const provider = h.providers!['synthetic-inventory'];
  assert.equal(provider.kind, 'async');
  if (provider.kind !== 'async') throw new Error('async provider required');
  let confirmed!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { confirmed = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const providers = { work: { ...provider, async apply(effect: Parameters<typeof provider.apply>[0]) {
    const result = await provider.apply(effect);
    assert.equal(result, 'confirmed');
    confirmed();
    await gate;
    return result;
  } } };
  const launched = await launchApplication(h.pool, actor, tenantId, {
    plan_id: planned.data.plan_id, expected_plan_version: planned.data.version, configuration_digest: planned.data.configuration_digest,
  }, randomUUID(), providers);
  await observeTerminalTransitions();
  const advancing = advanceOperation(h.pool, tenantId, launched.operation_id, { providers });
  try {
    await entered;
    await h.pool.query(`INSERT INTO workspace_module_bindings(tenant_id,workspace_id,entry_capability,instance_id)
      VALUES($1,$2,'work:create',$3)`, [tenantId, workspaceId, enabled.data.instance_id]);
  } finally {
    release();
    await advancing;
  }
  const reply = await h.call('GET', `/tenants/${tenantId}/operations/${launched.operation_id}`, owner);
  assert.equal(reply.status, 200, JSON.stringify(reply.data));
  assert.equal(reply.data.state, 'failed');
  assert.equal(reply.data.problem.code, 'workspace_binding_conflict');
  const terminal = (await h.pool.query(`SELECT old_state,new_state,old_version::text,new_version::text FROM review_transition_history
    WHERE aggregate='operation' AND id=$1 AND new_state IN ('succeeded','failed','cancelled')`, [launched.operation_id])).rows;
  assert.equal(terminal.length, 1, JSON.stringify(terminal));
  assert.equal(terminal[0].new_state, 'failed');
  assert.equal(BigInt(terminal[0].new_version) - BigInt(terminal[0].old_version), 1n);
  const installation = (await h.pool.query(`SELECT installation_id,status,retained_instance_ids FROM application_installations
    WHERE tenant_id=$1 AND provision_operation_id=$2`, [tenantId, launched.operation_id])).rows[0];
  assert.equal(installation.status, 'failed');
  assert.equal(await h.count('review_transition_history', `WHERE aggregate='installation' AND id=$1 AND new_state='active'`, [installation.installation_id]), 0);
  const instance = (await h.pool.query(`SELECT instance_id,status FROM module_instances WHERE tenant_id=$1 AND provision_operation_id=$2`,
    [tenantId, launched.operation_id])).rows[0];
  assert.equal(instance.status, 'active');
  assert.deepEqual(installation.retained_instance_ids, [instance.instance_id]);
  assert.equal((await h.pool.query(`SELECT instance_id FROM workspace_module_bindings WHERE tenant_id=$1 AND workspace_id=$2`,
    [tenantId, workspaceId])).rows[0].instance_id, enabled.data.instance_id);
  await assertCapacitySettlement(tenantId, launched.operation_id);
});

test('r4 consuming unknown and consumed reservations is idempotent', async () => {
  const { owner, actor, tenantId, workspaceId } = await prepared('重複結算');
  const planned = await h.plan(owner, tenantId, h.planBody('guild_ai_field', workspaceId, 'synthetic-storefront', 'synthetic-storefront@1.0.0'));
  const launched = await launchApplication(h.pool, actor, tenantId, {
    plan_id: planned.data.plan_id, expected_plan_version: planned.data.version, configuration_digest: planned.data.configuration_digest,
  }, randomUUID(), h.providers);
  const q = await connect();
  try {
    await q.query('BEGIN');
    await q.query(`UPDATE capacity_reservations SET state='unknown' WHERE tenant_id=$1 AND operation_id=$2 AND dimension <> 'concurrent_provisions'`,
      [tenantId, launched.operation_id]);
    await consumeInstanceReservations(q, tenantId, launched.operation_id);
    const once = (await q.query(`SELECT dimension,state,version::text FROM capacity_reservations WHERE tenant_id=$1 AND operation_id=$2 ORDER BY dimension`,
      [tenantId, launched.operation_id])).rows;
    assert.equal(once.filter(row => row.state === 'consumed').length, 3);
    await consumeInstanceReservations(q, tenantId, launched.operation_id);
    const twice = (await q.query(`SELECT dimension,state,version::text FROM capacity_reservations WHERE tenant_id=$1 AND operation_id=$2 ORDER BY dimension`,
      [tenantId, launched.operation_id])).rows;
    const actuals = (await q.query(`SELECT dimension,count(*)::int AS n FROM capacity_ledger WHERE tenant_id=$1 AND operation_id=$2 AND kind='actual' GROUP BY dimension`,
      [tenantId, launched.operation_id])).rows;
    assert.deepEqual(twice, once, JSON.stringify({ once, twice, actuals }));
    assert.equal(actuals.length, 3);
    for (const row of actuals) assert.equal(row.n, 1, JSON.stringify(actuals));
  } finally {
    await q.query('ROLLBACK');
    q.release();
  }
});

test('r4 transactional launch binding conflict rolls back every launch write', async () => {
  const { owner, tenantId, workspaceId } = await prepared('交易衝突');
  const other = await h.workspace(owner, tenantId, '既有櫃');
  const enabled = await h.enable(owner, tenantId, other, 'guild_ai_field');
  assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
  await h.pool.query(`INSERT INTO workspace_module_bindings(tenant_id,workspace_id,entry_capability,instance_id)
    VALUES($1,$2,'work:create',$3)`, [tenantId, workspaceId, enabled.data.instance_id]);
  const planned = await h.plan(owner, tenantId, h.planBody('guild_ai_field', workspaceId, 'manual-workspace', 'manual-workspace@1.0.0', {
    dependencies: [{ requirement_key: 'work', choice: 'create', configuration: {} }],
  }));
  assert.equal(planned.status, 201, JSON.stringify(planned.data));
  const before = await domainCounts(tenantId);
  const receipts = await receiptCount(tenantId, 'application.launch');
  const consumptions = await h.count('module_launch_plan_consumptions', 'WHERE tenant_id=$1', [tenantId]);
  const journals = await h.count('scoped_transition_journal');
  const outbox = await h.count('scoped_outbox');
  const reply = await h.launch(owner, tenantId, planned);
  assert.equal(reply.status, 409, JSON.stringify(reply.data));
  assert.equal(reply.data.code, 'workspace_binding_conflict');
  assert.deepEqual(await domainCounts(tenantId), before);
  assert.equal(await receiptCount(tenantId, 'application.launch'), receipts);
  assert.equal(await h.count('module_launch_plan_consumptions', 'WHERE tenant_id=$1', [tenantId]), consumptions);
  assert.equal(await h.count('scoped_transition_journal'), journals);
  assert.equal(await h.count('scoped_outbox'), outbox);
});

test('r4 two cancels with the same If-Match accept one request and settle once', { timeout: 20_000 }, async () => {
  const { owner, actor, tenantId, workspaceId } = await prepared('取消競態');
  await setSyntheticFault(h.pool, 'synthetic-inventory', 'timeout');
  const planned = await h.plan(owner, tenantId, h.planBody('guild_ai_field', workspaceId, 'synthetic-storefront', 'synthetic-storefront@1.0.0'));
  const acceptedLaunch = await launchApplication(h.pool, actor, tenantId, {
    plan_id: planned.data.plan_id, expected_plan_version: planned.data.version, configuration_digest: planned.data.configuration_digest,
  }, randomUUID(), h.providers);
  // Claim only the first step: leave one unknown effect and one undispatched step for cancellation settlement.
  await advanceOperation(h.pool, tenantId, acceptedLaunch.operation_id, { providers: h.providers, budget: 0 });
  const launched = await h.call('GET', `/tenants/${tenantId}/operations/${acceptedLaunch.operation_id}`, owner);
  assert.equal(launched.status, 200, JSON.stringify(launched.data));
  assert.equal(launched.data.state, 'needs_reconciliation');
  const path = `/tenants/${tenantId}/operations/${launched.data.operation_id}/cancel`;
  await observeTerminalTransitions();
  const holder = await connect();
  const pending: Promise<unknown>[] = [];
  try {
    await holder.query('BEGIN');
    await holder.query(`SELECT operation_id FROM module_provision_operations WHERE operation_id=$1 FOR UPDATE`, [launched.data.operation_id]);
    const pid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    const first = h.post(path, owner, { reason: 'member_cancelled' }, `"${launched.data.version}"`, randomUUID());
    pending.push(first);
    await waitForBlocked(pid, ['module_provision_operations', 'FOR UPDATE']);
    const second = h.post(path, owner, { reason: 'member_cancelled' }, `"${launched.data.version}"`, randomUUID());
    pending.push(second);
    // The second row-lock waiter can be blocked by the first waiter; follow the lock chain.
    await until(async () => Number((await h.pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND query LIKE '%SELECT operation_id FROM module_provision_operations%FOR UPDATE%'
        AND cardinality(pg_blocking_pids(pid)) > 0`)).rows[0].n) === 2, 'both cancels did not reach the operation lock');
    await holder.query('COMMIT');
    const results = await Promise.all([first, second]);
    assert.deepEqual(results.map(reply => reply.status).sort(), [202, 412], JSON.stringify(results.map(reply => reply.data)));
    assert.equal(results.find(reply => reply.status === 412)!.data.code, 'version_conflict');
    const accepted = results.find(reply => reply.status === 202)!;
    assert.equal(BigInt(accepted.data.version), BigInt(launched.data.version) + 1n);
    assert.equal(await receiptCount(tenantId, 'module.provision.cancel'), 1);
    assert.equal(await h.count('review_transition_history', `WHERE aggregate='operation' AND id=$1 AND new_version=old_version+1`, [launched.data.operation_id]), 1);
    const cancellation = (await h.pool.query(`SELECT cancel_requested_at FROM module_provision_operations WHERE operation_id=$1`, [launched.data.operation_id])).rows[0];
    assert.ok(cancellation.cancel_requested_at);
    // A confirmed lookup resolves the original unknown effect, then the executor settles cancellation.
    const inventory = h.providers!['synthetic-inventory'];
    if (inventory.kind !== 'async') throw new Error('async provider required');
    const original = inventory.lookup;
    const step = (await h.pool.query(`SELECT instance_id,provider_effect_key FROM module_provision_steps WHERE operation_id=$1 AND step_key='step-0'`, [launched.data.operation_id])).rows[0];
    inventory.lookup = async () => ({ status: 'found', owner_tenant_id: tenantId,
      effect_digest: effectDigest({ effect_key: step.provider_effect_key, tenant_id: tenantId, instance_id: step.instance_id, module_key: 'synthetic-inventory' }) });
    try {
      await reconcileOperation(h.pool, await actorOf(owner), tenantId, launched.data.operation_id, accepted.data.version, randomUUID(), h.providers!);
    } finally { inventory.lookup = original; }
    await advanceOperation(h.pool, tenantId, launched.data.operation_id, { providers: h.providers });
    await advanceOperation(h.pool, tenantId, launched.data.operation_id, { providers: h.providers });
    const settled = (await h.pool.query(`SELECT state,cancel_requested_at FROM module_provision_operations WHERE operation_id=$1`, [launched.data.operation_id])).rows[0];
    assert.equal(settled.state, 'cancelled');
    assert.equal(settled.cancel_requested_at.toISOString(), cancellation.cancel_requested_at.toISOString());
    assert.equal(await h.count('review_transition_history', `WHERE aggregate='operation' AND id=$1 AND new_state='cancelled'`, [launched.data.operation_id]), 1);
    await assertCapacitySettlement(tenantId, launched.data.operation_id);
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
    await Promise.allSettled(pending);
  }
});

test('r5 two cancels settle once with the default executor budget', { timeout: 20_000 }, async () => {
  const { owner, actor, tenantId, workspaceId } = await prepared('取消競態');
  await setSyntheticFault(h.pool, 'synthetic-inventory', 'timeout');
  const planned = await h.plan(owner, tenantId, h.planBody('guild_ai_field', workspaceId, 'synthetic-storefront', 'synthetic-storefront@1.0.0'));
  const acceptedLaunch = await launchApplication(h.pool, actor, tenantId, {
    plan_id: planned.data.plan_id, expected_plan_version: planned.data.version, configuration_digest: planned.data.configuration_digest,
  }, randomUUID(), h.providers);
  // The default budget also confirms the second step before cancellation.
  await advanceOperation(h.pool, tenantId, acceptedLaunch.operation_id, { providers: h.providers });
  const launched = await h.call('GET', `/tenants/${tenantId}/operations/${acceptedLaunch.operation_id}`, owner);
  assert.equal(launched.status, 200, JSON.stringify(launched.data));
  assert.equal(launched.data.state, 'needs_reconciliation');
  const path = `/tenants/${tenantId}/operations/${launched.data.operation_id}/cancel`;
  await observeTerminalTransitions();
  const holder = await connect();
  const pending: Promise<unknown>[] = [];
  try {
    await holder.query('BEGIN');
    await holder.query(`SELECT operation_id FROM module_provision_operations WHERE operation_id=$1 FOR UPDATE`, [launched.data.operation_id]);
    const pid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    const first = h.post(path, owner, { reason: 'member_cancelled' }, `"${launched.data.version}"`, randomUUID());
    pending.push(first);
    await waitForBlocked(pid, ['module_provision_operations', 'FOR UPDATE']);
    const second = h.post(path, owner, { reason: 'member_cancelled' }, `"${launched.data.version}"`, randomUUID());
    pending.push(second);
    // The second row-lock waiter can be blocked by the first waiter; follow the lock chain.
    await until(async () => Number((await h.pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND query LIKE '%SELECT operation_id FROM module_provision_operations%FOR UPDATE%'
        AND cardinality(pg_blocking_pids(pid)) > 0`)).rows[0].n) === 2, 'both cancels did not reach the operation lock');
    await holder.query('COMMIT');
    const results = await Promise.all([first, second]);
    assert.deepEqual(results.map(reply => reply.status).sort(), [202, 412], JSON.stringify(results.map(reply => reply.data)));
    assert.equal(results.find(reply => reply.status === 412)!.data.code, 'version_conflict');
    const accepted = results.find(reply => reply.status === 202)!;
    assert.equal(BigInt(accepted.data.version), BigInt(launched.data.version) + 1n);
    assert.equal(await receiptCount(tenantId, 'module.provision.cancel'), 1);
    assert.equal(await h.count('review_transition_history', `WHERE aggregate='operation' AND id=$1 AND new_version=old_version+1`, [launched.data.operation_id]), 1);
    const cancellation = (await h.pool.query(`SELECT cancel_requested_at FROM module_provision_operations WHERE operation_id=$1`, [launched.data.operation_id])).rows[0];
    assert.ok(cancellation.cancel_requested_at);
    // A confirmed lookup resolves the original unknown effect, then the executor settles cancellation.
    const inventory = h.providers!['synthetic-inventory'];
    if (inventory.kind !== 'async') throw new Error('async provider required');
    const original = inventory.lookup;
    const step = (await h.pool.query(`SELECT instance_id,provider_effect_key FROM module_provision_steps WHERE operation_id=$1 AND step_key='step-0'`, [launched.data.operation_id])).rows[0];
    inventory.lookup = async () => ({ status: 'found', owner_tenant_id: tenantId,
      effect_digest: effectDigest({ effect_key: step.provider_effect_key, tenant_id: tenantId, instance_id: step.instance_id, module_key: 'synthetic-inventory' }) });
    try {
      await reconcileOperation(h.pool, await actorOf(owner), tenantId, launched.data.operation_id, accepted.data.version, randomUUID(), h.providers!);
    } finally { inventory.lookup = original; }
    await advanceOperation(h.pool, tenantId, launched.data.operation_id, { providers: h.providers });
    await advanceOperation(h.pool, tenantId, launched.data.operation_id, { providers: h.providers });
    const settled = (await h.pool.query(`SELECT state,cancel_requested_at FROM module_provision_operations WHERE operation_id=$1`, [launched.data.operation_id])).rows[0];
    assert.equal(settled.state, 'cancelled');
    assert.equal(settled.cancel_requested_at.toISOString(), cancellation.cancel_requested_at.toISOString());
    assert.equal(await h.count('review_transition_history', `WHERE aggregate='operation' AND id=$1 AND new_state='cancelled'`, [launched.data.operation_id]), 1);
    await assertCapacitySettlement(tenantId, launched.data.operation_id);
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
    await Promise.allSettled(pending);
  }
});

async function inactiveDeploymentFixture() {
  const { owner, tenantId, workspaceId } = await prepared('可選實例');
  const usable = await h.enable(owner, tenantId, workspaceId, 'guild_ai_field');
  const other = await h.workspace(owner, tenantId, '第二櫃');
  const unavailable = await h.enable(owner, tenantId, other, 'guild_ai_field', { kind: 'create_new' });
  assert.equal(usable.status, 200, JSON.stringify(usable.data));
  assert.equal(unavailable.status, 200, JSON.stringify(unavailable.data));
  await h.pool.query(`UPDATE deployment_bindings SET state='pending' WHERE tenant_id=$1 AND instance_id=$2`, [tenantId, unavailable.data.instance_id]);
  const target = await h.workspace(owner, tenantId, '待選櫃');
  return { owner, tenantId, target, usable, unavailable };
}

test('r4 manual-work candidates omit active instances with inactive deployments', async () => {
  const { owner, tenantId, target, usable } = await inactiveDeploymentFixture();
  const reply = await h.enable(owner, tenantId, target, 'guild_ai_field');
  assert.equal(reply.status, 409, JSON.stringify(reply.data));
  assert.equal(reply.data.code, 'instance_selection_required');
  assert.deepEqual(reply.data.candidates.map((item: { instance_id: string }) => item.instance_id), [usable.data.instance_id]);
  const picked = await h.enable(owner, tenantId, target, 'guild_ai_field', {
    kind: 'reuse', instance_id: usable.data.instance_id, expected_version: usable.data.version,
  });
  assert.equal(picked.status, 200, JSON.stringify(picked.data));
  assert.equal(picked.data.instance_id, usable.data.instance_id);
});

test('r4 explicit reuse with an inactive deployment is instance_unavailable on facade and plan and writes nothing', async () => {
  const { owner, tenantId, target, unavailable } = await inactiveDeploymentFixture();
  const before = await domainCounts(tenantId);
  const plans = await h.count('module_launch_plans', 'WHERE tenant_id=$1', [tenantId]);
  const receipts = await h.count('scoped_command_receipts');
  const choice = { instance_id: unavailable.data.instance_id, expected_version: unavailable.data.version };
  const replies = [
    await h.enable(owner, tenantId, target, 'guild_ai_field', { kind: 'reuse', ...choice }),
    await h.plan(owner, tenantId, h.planBody('guild_ai_field', target, 'manual-workspace', 'manual-workspace@1.0.0', {
      dependencies: [{ requirement_key: 'work', choice: 'reuse', ...choice }],
    })),
  ];
  for (const reply of replies) {
    assert.equal(reply.status, 409, JSON.stringify(reply.data));
    assert.equal(reply.data.code, 'instance_unavailable');
  }
  assert.deepEqual(await domainCounts(tenantId), before);
  assert.equal(await h.count('module_launch_plans', 'WHERE tenant_id=$1', [tenantId]), plans);
  assert.equal(await h.count('scoped_command_receipts'), receipts);
});

for (const branch of ['intern', 'no_tenant', 'no_policy', 'select', 'continue'] as const) {
  for (const surface of ['catalog', 'launchpad'] as const) {
    test(`r4 eligibility ${surface} maps ${branch} to the required tenant action`, async () => {
      const member = await h.person('資格會員');
      await h.fullMember(member.id, 'guild_ai_field', branch === 'intern' ? 'intern' : 'full');
      if (branch !== 'no_tenant') {
        const { tenantId, workspaceId } = await h.createTenant(member.session, '資格品牌');
        if (branch === 'continue') {
          assert.equal((await h.enable(member.session, tenantId, workspaceId, 'guild_ai_field')).status, 200);
        }
      }
      if (branch === 'no_policy') await h.pool.query('DELETE FROM tenant_capacity_policies');
      const reply = await h.call('GET', surface === 'catalog' ? '/applications?guild_key=guild_ai_field' : '/guilds/guild_ai_field/launchpad', member.session);
      assert.equal(reply.status, 200, JSON.stringify(reply.data));
      const items = surface === 'catalog' ? reply.data.items : reply.data.applications;
      const item = items.find((entry: { application_key: string }) => entry.application_key === 'manual-workspace');
      assert.ok(item);
      const reason = branch === 'intern' ? 'guild_full_member_required' : branch === 'no_tenant' ? 'tenant_manage_required' : branch === 'no_policy' ? 'policy_unconfigured' : null;
      assert.deepEqual(item.eligibility, {
        can_launch: !reason, reason_codes: reason ? [reason] : [], required_guild_tier: 'full',
        tenant_action: branch === 'no_tenant' ? 'create' : reason ? 'denied' : branch,
        policy_revision: '1',
      });
    });
  }
}
