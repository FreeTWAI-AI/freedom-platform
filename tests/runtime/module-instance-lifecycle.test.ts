import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createApp } from '../../apps/platform-api/src/app.js';
import { InstanceDetailSchema, RegistryOperationSchema } from '../../contracts/guild-launchpad/v1/module-registry.js';
import { ReasonSchema } from '../../contracts/guild-launchpad/v1/tenant.js';
import { LaunchpadContextSchema, ManualWorkBindingSchema } from '../../contracts/guild-launchpad/v1/tenant-work.js';
import { advanceOperation, sweepDueOperations } from '../../modules/module-registry/service.js';
import { digestOf } from '../../modules/module-registry/canonical.js';
import { FakeObjectStore } from '../../packages/asset-storage/fake-store.js';
import { DEMO_USERS } from '../../packages/testing/seed.js';
import { setSyntheticFault } from '../../packages/testing/synthetic-module-provider.js';
import { createRegistryHarness, type RegistryHarness, type Reply, type Session } from './module-registry-harness.js';

let h: RegistryHarness;
let app: ReturnType<typeof createApp>;
const guild = 'guild_ai_field';
const reason = '保留資料，暫停新寫入';
const bytes = new TextEncoder().encode('synthetic result');
const sha = createHash('sha256').update(bytes).digest('hex');
const workBody = (title = '合成工作') => ({ title, objective: '保存人工成果', progress: 'todo' });

before(async () => { h = await createRegistryHarness('fp_mil', { synthetic: true }); });
after(async () => { await h.stop(); });
beforeEach(async () => {
  await h.reset();
  app = createApp(h.pool, h.origin, 'local', { guildLaunchpadEnabled: true, moduleProviders: h.providers, tenantWorkAssetStore: new FakeObjectStore() });
});
function post(path: string, session: Session, body: unknown, version?: string, key = randomUUID()) {
  return h.post(path, session, body, version, key, app);
}
function get(path: string, session: Session) { return h.call('GET', path, session, undefined, {}, app); }
function path(tenantId: string, instanceId: string) { return `/tenants/${tenantId}/module-instances/${instanceId}`; }
async function detail(ctx: { owner: Session; tenantId: string; instanceId: string }) {
  const reply = await get(path(ctx.tenantId, ctx.instanceId), ctx.owner);
  assert.equal(reply.status, 200, JSON.stringify(reply.data));
  return InstanceDetailSchema.parse(reply.data);
}
function error(reply: Reply, status: number, code: string) {
  assert.equal(reply.status, status, JSON.stringify(reply.data));
  assert.equal(reply.data.code, code);
}
async function ready(synthetic = false) {
  const owner = await h.signIn(DEMO_USERS[0].email);
  await h.fullMember(owner.user.user_id, guild);
  const made = await h.createTenant(owner, '生命週期業務');
  if (synthetic) {
    const planned = await h.plan(owner, made.tenantId, h.planBody(guild, made.workspaceId, 'synthetic-storefront', 'synthetic-storefront@1.0.0'));
    assert.equal(planned.status, 201, JSON.stringify(planned.data));
    const launched = await h.launch(owner, made.tenantId, planned);
    assert.equal(launched.status, 200, JSON.stringify(launched.data));
  } else {
    const enabled = await h.enable(owner, made.tenantId, made.workspaceId, guild);
    assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
  }
  const row = (await h.pool.query(`SELECT instance_id FROM module_instances WHERE tenant_id=$1 AND module_key=$2`,
    [made.tenantId, synthetic ? 'synthetic-inventory' : 'work'])).rows[0];
  return { owner, ...made, instanceId: row.instance_id as string };
}
async function suspend(ctx: Awaited<ReturnType<typeof ready>>, key = randomUUID(), expected?: string) {
  const current = expected ?? (await detail(ctx)).version;
  return post(`${path(ctx.tenantId, ctx.instanceId)}/suspend`, ctx.owner, { reason }, `"${current}"`, key);
}
async function resume(ctx: Awaited<ReturnType<typeof ready>>, key = randomUUID(), expected?: string) {
  const current = expected ?? (await detail(ctx)).version;
  return post(`${path(ctx.tenantId, ctx.instanceId)}/resume`, ctx.owner, {}, `"${current}"`, key);
}
async function physical(ctx: { tenantId: string; instanceId: string }) {
  return (await h.pool.query(`SELECT i.status,i.version::text AS version,i.suspension_operation_id,i.authority_epoch::text AS authority_epoch,
      d.state AS binding_state,d.version::text AS binding_version,d.binding_id
    FROM module_instances i JOIN deployment_bindings d ON d.tenant_id=i.tenant_id AND d.binding_id=i.binding_id AND d.instance_id=i.instance_id
    WHERE i.tenant_id=$1 AND i.instance_id=$2`, [ctx.tenantId, ctx.instanceId])).rows[0];
}
async function facts(ctx: { tenantId: string; instanceId: string }, operation: string) {
  return (await h.pool.query(`SELECT j.aggregate_type,j.aggregate_version::text AS version,j.operation,j.data,o.event_type,o.payload
    FROM scoped_transition_journal j JOIN scoped_outbox o ON o.transition_id=j.transition_id
    JOIN resource_scopes s ON s.scope_id=j.scope_id
    WHERE s.tenant_ref=$1 AND j.aggregate_id=$2 AND j.operation=$3`, [ctx.tenantId, ctx.instanceId, operation])).rows;
}
async function capacity(ctx: { tenantId: string }) {
  return (await h.pool.query(`SELECT
    (SELECT count(*)::int FROM module_instances WHERE tenant_id=$1 AND status IN ('requested','provisioning','active','suspended')) AS usage,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY reservation_id) FROM capacity_reservations r WHERE tenant_id=$1) AS reservations,
    (SELECT jsonb_agg(to_jsonb(l) ORDER BY entry_id) FROM capacity_ledger l WHERE tenant_id=$1) AS ledger`, [ctx.tenantId])).rows[0];
}

async function lifecycleSnapshot(ctx: { tenantId: string; instanceId: string }) {
  return { instance: await physical(ctx), capacity: await capacity(ctx), counts: {
    ...await workCounts(), operations: await h.count('module_provision_operations'),
  } };
}

for (const [dimension, totalLimit, moduleLimit] of [
  ['module_instances', 2, 3], ['module_instances.work', 3, 2],
  ['module_instances', 0, 3], ['module_instances.work', 3, 0],
] as const) {
  test(`resume refuses lowered ${dimension} limit ${dimension === 'module_instances' ? totalLimit : moduleLimit} without writes`, async t => {
    const ctx = await ready();
    for (let n = 0; n < 2; n += 1) {
      const workspace = await h.workspace(ctx.owner, ctx.tenantId, `額外工作區${n}`);
      const plan = await h.plan(ctx.owner, ctx.tenantId, h.planBody(guild, workspace, 'manual-workspace', 'manual-workspace@1.0.0', {
        dependencies: [{ requirement_key: 'work', choice: 'create', configuration: {} }],
      }));
      assert.equal(plan.status, 201, JSON.stringify(plan.data));
      assert.equal((await h.launch(ctx.owner, ctx.tenantId, plan)).status, 200);
    }
    assert.equal((await capacity(ctx)).usage, 3);
    assert.equal((await suspend(ctx)).status, 200);
    await h.pool.query(`UPDATE tenant_capacity_policies SET max_active_instances=$1,max_instances_per_module=$2`, [totalLimit, moduleLimit]);
    const before = await lifecycleSnapshot(ctx);
    const refused = await resume(ctx);
    const after = await lifecycleSnapshot(ctx);
    t.diagnostic(JSON.stringify({ status: refused.status, code: refused.data.code ?? null, dimension: refused.data.dimension ?? null,
      before: before.counts, after: after.counts, instance: after.instance }));
    error(refused, 429, 'quota_exceeded');
    assert.equal(refused.data.dimension, dimension);
    assert.deepEqual(after, before);
  });
}

test('detail classifies a retired member binding as platform hold and restores the member reason when suspended', async t => {
  const ctx = await ready();
  assert.equal((await suspend(ctx)).status, 200);
  const member = (await detail(ctx)).suspension;
  assert.equal(member?.kind, 'member');
  await h.pool.query(`UPDATE deployment_bindings SET state='retired' WHERE instance_id=$1`, [ctx.instanceId]);
  const before = await lifecycleSnapshot(ctx);
  const held = await detail(ctx), refused = await resume(ctx);
  t.diagnostic(JSON.stringify({ suspension: held.suspension, status: refused.status, code: refused.data.code, counts: before.counts }));
  error(refused, 409, 'instance_security_hold');
  assert.deepEqual(await lifecycleSnapshot(ctx), before);
  assert.deepEqual(held.suspension, { kind: 'platform', operation_id: null, suspended_at: null, reason: null });
  await h.pool.query(`UPDATE deployment_bindings SET state='suspended' WHERE instance_id=$1`, [ctx.instanceId]);
  assert.deepEqual((await detail(ctx)).suspension, member);
  assert.equal((await detail(ctx)).suspension?.reason, reason);
});

test('two emoji reason is rejected by validation without lifecycle writes', async t => {
  const ctx = await ready(), before = await lifecycleSnapshot(ctx);
  const refused = await post(`${path(ctx.tenantId, ctx.instanceId)}/suspend`, ctx.owner, { reason: '😀😀' }, `"${before.instance.version}"`);
  const after = await lifecycleSnapshot(ctx);
  t.diagnostic(JSON.stringify({ status: refused.status, code: refused.data.code, detail: refused.data.detail, before: before.counts, after: after.counts }));
  error(refused, 422, 'validation_failed');
  assert.deepEqual(after, before);
  assert.equal(ReasonSchema.safeParse('😀😀').success, false, 'shared schema must reject fewer than three code points');
});

test('three emoji reason suspends successfully and round trips through detail', async () => {
  const ctx = await ready(), version = (await detail(ctx)).version;
  const accepted = await post(`${path(ctx.tenantId, ctx.instanceId)}/suspend`, ctx.owner, { reason: '😀😀😀' }, `"${version}"`);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  assert.equal((await detail(ctx)).suspension?.reason, '😀😀😀');
});

test('T-016 owner suspends and resumes with durable operations, exact facts, versions and retained installation', async () => {
  const ctx = await ready();
  const original = await physical(ctx), beforeCapacity = await capacity(ctx);
  const installations = (await h.pool.query(`SELECT to_jsonb(i) AS row FROM application_installations i WHERE tenant_id=$1`, [ctx.tenantId])).rows;
  const principal = (await h.pool.query(`SELECT principal_id FROM tenant_memberships WHERE tenant_id=$1 AND role='owner'`, [ctx.tenantId])).rows[0].principal_id;
  const authRevision = (await h.pool.query(`SELECT authorization_revision::text AS v FROM tenants WHERE tenant_id=$1`, [ctx.tenantId])).rows[0].v;
  const accepted = await suspend(ctx);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  assert.equal(accepted.response.headers.get('etag'), '"1"');
  assert.equal(accepted.response.headers.get('cache-control'), 'private, no-store');
  RegistryOperationSchema.parse(accepted.data);
  assert.equal(accepted.data.state, 'succeeded');
  assert.equal('resource_ref' in accepted.data, false);
  const held = await physical(ctx);
  assert.deepEqual(held, { ...original, status: 'suspended', version: String(BigInt(original.version) + 1n),
    binding_state: 'suspended', binding_version: String(BigInt(original.binding_version) + 1n), suspension_operation_id: accepted.data.operation_id });
  const operation = (await h.pool.query(`SELECT * FROM module_provision_operations WHERE operation_id=$1`, [accepted.data.operation_id])).rows[0];
  assert.equal(operation.operation_kind, 'module.instance.suspend');
  assert.equal(operation.actor_principal_id, principal);
  assert.equal(operation.authorization_revision, authRevision);
  assert.equal(operation.instance_id, ctx.instanceId);
  assert.equal(operation.reason, reason);
  assert.equal(operation.state, 'succeeded');
  assert.equal(operation.policy_revision, null);
  assert.equal(operation.installation_id, null);
  assert.equal(operation.plan_id, null);
  assert.equal(operation.version, '1');
  assert.equal(operation.request_digest, digestOf({ operation: 'module.instance.suspend', tenant_id: ctx.tenantId,
    instance_id: ctx.instanceId, expected: original.version, body: { reason } }));
  const heldDetail = await detail(ctx);
  assert.deepEqual(heldDetail.suspension, { kind: 'member', operation_id: accepted.data.operation_id,
    reason, suspended_at: operation.accepted_at.toISOString() });
  assert.deepEqual(heldDetail.impact, { consumer_count: 0, blocking_consumer_count: 0, consumers: [], workspace_count: 1, workspace_ids: [ctx.workspaceId] });
  assert.deepEqual((await get(`/tenants/${ctx.tenantId}/operations/${accepted.data.operation_id}`, ctx.owner)).data, accepted.data);
  await h.pool.query(`UPDATE tenant_capacity_policies SET revision=2 WHERE tenant_id IS NULL`);
  const continued = await resume(ctx);
  assert.equal(continued.status, 200, JSON.stringify(continued.data));
  assert.equal(continued.response.headers.get('etag'), '"1"');
  const resumed = await physical(ctx);
  assert.deepEqual(resumed, { ...original, version: String(BigInt(original.version) + 2n), binding_version: String(BigInt(original.binding_version) + 2n) });
  const resumeRow = (await h.pool.query(`SELECT * FROM module_provision_operations WHERE operation_id=$1`, [continued.data.operation_id])).rows[0];
  assert.equal(resumeRow.operation_kind, 'module.instance.resume');
  assert.equal(resumeRow.policy_revision, '2');
  assert.equal(resumeRow.authorization_revision, authRevision);
  assert.equal(resumeRow.actor_principal_id, principal);
  assert.equal(resumeRow.instance_id, ctx.instanceId);
  assert.equal(resumeRow.reason, null);
  assert.equal(resumeRow.installation_id, null);
  assert.equal(resumeRow.plan_id, null);
  assert.equal(resumeRow.state, 'succeeded');
  assert.equal(resumeRow.version, '1');
  assert.equal(resumeRow.request_digest, digestOf({ operation: 'module.instance.resume', tenant_id: ctx.tenantId,
    instance_id: ctx.instanceId, expected: held.version, body: {} }));
  assert.equal((await detail(ctx)).suspension, null);
  for (const [kind, status, version] of [['suspend', 'suspended', held.version], ['resume', 'active', resumed.version]]) {
    const recorded = await facts(ctx, `module.instance.${kind}`);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].aggregate_type, 'module_instance_status');
    assert.equal(recorded[0].version, version);
    assert.equal(recorded[0].event_type, 'freedom.module.instance.status_changed.v1');
    assert.deepEqual(recorded[0].data, { instance_id: ctx.instanceId, status, version });
    assert.deepEqual(recorded[0].payload.data, recorded[0].data);
  }
  assert.deepEqual(await capacity(ctx), beforeCapacity);
  assert.deepEqual((await h.pool.query(`SELECT to_jsonb(i) AS row FROM application_installations i WHERE tenant_id=$1`, [ctx.tenantId])).rows, installations);
});

test('admin may manage lifecycle; operator/viewer, non-member, wrong tenant and flag-off fail closed', async () => {
  const ctx = await ready();
  const admin = await h.person('管理夥伴');
  const invited = await h.invite(ctx.owner, ctx.tenantId, await h.candidate(ctx.owner, admin.id), 'admin');
  assert.equal(invited.status, 201);
  await h.accept(admin.session, ctx.tenantId, invited);
  const original = await detail(ctx);
  const endpoint = path(ctx.tenantId, ctx.instanceId);
  assert.equal((await post(`${endpoint}/suspend`, admin.session, { reason }, `"${original.version}"`)).status, 200);
  assert.equal((await post(`${endpoint}/resume`, admin.session, {}, `"${(await detail(ctx)).version}"`)).status, 200);
  for (const role of ['operator', 'viewer'] as const) {
    const person = await h.person(role);
    const invite = await h.invite(ctx.owner, ctx.tenantId, await h.candidate(ctx.owner, person.id), role);
    await h.accept(person.session, ctx.tenantId, invite);
    for (const command of ['suspend', 'resume']) {
      error(await post(`${endpoint}/${command}`, person.session, command === 'suspend' ? { reason } : {}, '"1"'), 403, 'capability_denied');
    }
  }
  const outsider = await h.person('外部夥伴');
  const other = await h.createTenant(ctx.owner, '第二業務');
  for (const command of ['suspend', 'resume']) {
    const body = command === 'suspend' ? { reason } : {};
    const unknown = await post(`${path(ctx.tenantId, randomUUID())}/${command}`, ctx.owner, body, '"1"');
    const cross = await post(`${path(other.tenantId, ctx.instanceId)}/${command}`, ctx.owner, body, '"1"');
    assert.equal(unknown.status, 404); assert.deepEqual(cross.data, unknown.data);
    assert.equal((await post(`${endpoint}/${command}`, outsider.session, body, '"1"')).status, 404);
    assert.equal((await h.post(`${endpoint}/${command}`, ctx.owner, body, '"1"', randomUUID(), h.closed)).status, 404);
  }
  // Guild tier/leave does not affect commands on an existing instance.
  await h.pool.query(`DELETE FROM positioning_profession_memberships WHERE user_id=$1`, [ctx.owner.user.user_id]);
  assert.equal((await suspend(ctx)).status, 200);
  assert.equal((await resume(ctx)).status, 200);
  await h.pool.query(`UPDATE tenants SET status='suspended' WHERE tenant_id=$1`, [ctx.tenantId]);
  for (const command of ['suspend', 'resume']) error(await post(`${endpoint}/${command}`, ctx.owner, command === 'suspend' ? { reason } : {}, '"1"'), 403, 'capability_denied');
});

test('suspend and resume require strict headers and bodies and reject caller authority fields', async () => {
  const ctx = await ready();
  for (const command of ['suspend', 'resume']) {
    if (command === 'resume') assert.equal((await suspend(ctx)).status, 200);
    const endpoint = `${path(ctx.tenantId, ctx.instanceId)}/${command}`;
    const body = command === 'suspend' ? { reason } : {};
    const version = (await detail(ctx)).version;
    for (const key of [undefined, '', 'short', 'a'.repeat(129), 'invalid key', 'invalid.key']) {
      const headers: Record<string, string> = { 'If-Match': `"${version}"` };
      if (key !== undefined) headers['Idempotency-Key'] = key;
      error(await h.call('POST', endpoint, ctx.owner, body, headers, app), 400, 'idempotency_required');
    }
    for (const tag of [undefined, '1', '"0"', 'W/"1"', '"1","2"', '"*"', '"9223372036854775808"', '"10000000000000000000"']) {
      const headers: Record<string, string> = { 'Idempotency-Key': randomUUID() };
      if (tag !== undefined) headers['If-Match'] = tag;
      error(await h.call('POST', endpoint, ctx.owner, body, headers, app), tag === undefined ? 428 : 400, tag === undefined ? 'version_required' : 'invalid_version');
    }
    error(await post(endpoint, ctx.owner, body, '"999"'), 412, 'version_conflict');
    const invalid = command === 'suspend' ? [{}, { reason: '短' }, { reason: 'x'.repeat(1001) }, { reason: '控制\n字元' }, { reason: 42 }, null, []] : [{ reason }, null, []];
    for (const bad of invalid) error(await post(endpoint, ctx.owner, bad, `"${version}"`), 422, 'validation_failed');
    for (const field of ['tenant_id', 'actor', 'owner', 'scope', '__proto__']) {
      error(await post(endpoint, ctx.owner, { ...body, [field]: randomUUID() }, `"${version}"`), 422, 'validation_failed');
    }
    const malformed = await app.request(h.origin + '/api/v1' + endpoint, { method: 'POST',
      headers: { Origin: h.origin, Cookie: ctx.owner.cookie, 'X-CSRF-Token': ctx.owner.csrf,
        'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), 'If-Match': `"${version}"` }, body: '{' });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).code, 'invalid_json');
    for (const headers of [{ Cookie: ctx.owner.cookie, Origin: h.origin }, { Cookie: ctx.owner.cookie, Origin: 'http://wrong.example.test', 'X-CSRF-Token': ctx.owner.csrf }] as Record<string, string>[]) {
      const refused = await app.request(h.origin + '/api/v1' + endpoint, { method: 'POST', body: JSON.stringify(body),
        headers: { ...headers, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), 'If-Match': `"${version}"` } });
      assert.equal(refused.status, 403);
    }
  }
});

for (const command of ['suspend', 'resume'] as const) {
  test(`${command} replay preserves one operation/event, conflicts on payload/version and re-checks current capability`, async () => {
    const ctx = await ready();
    if (command === 'resume') assert.equal((await suspend(ctx)).status, 200);
    const before = await detail(ctx), key = randomUUID(), endpoint = `${path(ctx.tenantId, ctx.instanceId)}/${command}`;
    const body = command === 'suspend' ? { reason } : {};
    const first = await post(endpoint, ctx.owner, body, `"${before.version}"`, key);
    assert.equal(first.status, 200, JSON.stringify(first.data));
    const replay = await post(endpoint, ctx.owner, body, `"${before.version}"`, key);
    assert.equal(replay.status, 200); assert.deepEqual(replay.data, first.data); assert.equal(replay.response.headers.get('etag'), first.response.headers.get('etag'));
    error(await post(endpoint, ctx.owner, body, '"999"', key), 409, 'idempotency_conflict');
    if (command === 'suspend') error(await post(endpoint, ctx.owner, { reason: '另一個原因' }, `"${before.version}"`, key), 409, 'idempotency_conflict');
    assert.equal(await h.count('module_provision_operations', 'WHERE tenant_id=$1 AND operation_kind=$2', [ctx.tenantId, `module.instance.${command}`]), 1);
    assert.equal((await facts(ctx, `module.instance.${command}`)).length, 1);
    const partner = await h.person('接續負責人');
    const invite = await h.invite(ctx.owner, ctx.tenantId, await h.candidate(ctx.owner, partner.id), 'admin');
    await h.accept(partner.session, ctx.tenantId, invite);
    await h.pool.query(`UPDATE tenant_memberships SET role='owner' WHERE tenant_id=$1 AND principal_id=(SELECT principal_id FROM principals WHERE user_ref=$2)`, [ctx.tenantId, partner.id]);
    await h.pool.query(`UPDATE tenant_memberships SET role='viewer', version=version+1 WHERE tenant_id=$1 AND principal_id=(SELECT principal_id FROM principals WHERE user_ref=$2)`, [ctx.tenantId, ctx.owner.user.user_id]);
    error(await post(endpoint, ctx.owner, body, `"${before.version}"`, key), 403, 'capability_denied');
  });
}

test('state errors preserve rows: inactive binding, platform hold, changed binding and missing capacity policy', async () => {
  const ctx = await ready();
  error(await resume(ctx), 409, 'instance_not_suspended');
  await h.pool.query(`UPDATE deployment_bindings SET state='retired' WHERE instance_id=$1`, [ctx.instanceId]);
  error(await suspend(ctx), 409, 'instance_not_active');
  await h.pool.query(`UPDATE deployment_bindings SET state='active' WHERE instance_id=$1`, [ctx.instanceId]);
  assert.equal((await suspend(ctx)).status, 200);
  error(await suspend(ctx), 409, 'instance_not_active');
  await h.pool.query(`UPDATE deployment_bindings SET state='retired' WHERE instance_id=$1`, [ctx.instanceId]);
  const held = await physical(ctx);
  error(await resume(ctx), 409, 'instance_security_hold');
  assert.deepEqual(await physical(ctx), held);
  await h.pool.query(`UPDATE deployment_bindings SET state='suspended' WHERE instance_id=$1`, [ctx.instanceId]);
  await h.pool.query(`UPDATE module_instances SET suspension_operation_id=NULL WHERE instance_id=$1`, [ctx.instanceId]);
  const platformHold = await physical(ctx);
  error(await resume(ctx), 409, 'instance_security_hold');
  assert.deepEqual(await physical(ctx), platformHold);
  assert.deepEqual((await detail(ctx)).suspension, { kind: 'platform', operation_id: null, suspended_at: null, reason: null });
  // Restore only the fixture's member pointer; no platform-hold API exists.
  await h.pool.query(`UPDATE module_instances SET suspension_operation_id=(SELECT operation_id FROM module_provision_operations
    WHERE tenant_id=$1 AND operation_kind='module.instance.suspend') WHERE instance_id=$2`, [ctx.tenantId, ctx.instanceId]);
  await h.pool.query(`UPDATE tenant_capacity_policies SET status='retired'`);
  const before = await physical(ctx);
  error(await resume(ctx), 403, 'policy_unconfigured');
  error(await post(`${path(ctx.tenantId, randomUUID())}/resume`, ctx.owner, {}, '"1"'), 404, 'not_found');
  error(await post(`${path(ctx.tenantId, ctx.instanceId)}/resume`, ctx.owner, {}, '"999"'), 412, 'version_conflict');
  assert.deepEqual(await physical(ctx), before);
  assert.equal(await h.count('module_provision_operations', "WHERE operation_kind='module.instance.resume'"), 0);
});

test('suspend refuses unfinished launch steps and links to a reused instance', async () => {
  const owner = await h.signIn(DEMO_USERS[0].email);
  await h.fullMember(owner.user.user_id, guild);
  const made = await h.createTenant(owner, '未完成啟用');
  await setSyntheticFault(h.pool, 'synthetic-storefront', 'timeout');
  const planned = await h.plan(owner, made.tenantId, h.planBody(guild, made.workspaceId, 'synthetic-storefront', 'synthetic-storefront@1.0.0'));
  assert.equal(planned.status, 201);
  const launched = await h.launch(owner, made.tenantId, planned);
  assert.equal(launched.status, 202);
  const row = (await h.pool.query(`SELECT instance_id FROM module_instances WHERE tenant_id=$1 AND module_key='synthetic-inventory'`, [made.tenantId])).rows[0];
  const ctx = { owner, ...made, instanceId: row.instance_id };
  assert.equal((await detail(ctx)).status, 'active');
  error(await suspend(ctx), 409, 'operation_pending');
  const op = await get(`/tenants/${ctx.tenantId}/operations/${launched.data.operation_id}`, owner);
  await setSyntheticFault(h.pool, 'synthetic-storefront', null);
  assert.equal((await post(`/tenants/${ctx.tenantId}/operations/${op.data.operation_id}/reconcile`, owner, {}, `"${op.data.version}"`)).status, 202);
  const secondSpace = await h.workspace(owner, ctx.tenantId, '重用啟用');
  await setSyntheticFault(h.pool, 'synthetic-storefront', 'timeout');
  const reusedPlan = await h.plan(owner, ctx.tenantId, h.planBody(guild, secondSpace, 'synthetic-storefront', 'synthetic-storefront@1.0.0', {
    dependencies: [{ requirement_key: 'inventory', choice: 'reuse', instance_id: ctx.instanceId, expected_version: (await detail(ctx)).version }],
  }));
  assert.equal(reusedPlan.status, 201, JSON.stringify(reusedPlan.data));
  const reusedLaunch = await h.launch(owner, ctx.tenantId, reusedPlan);
  assert.equal(reusedLaunch.status, 202, JSON.stringify(reusedLaunch.data));
  assert.equal(await h.count('module_provision_steps', 'WHERE operation_id=$1 AND instance_id=$2', [reusedLaunch.data.operation_id, ctx.instanceId]), 0);
  error(await suspend(ctx), 409, 'operation_pending');
  assert.equal(await h.count('module_provision_operations', "WHERE operation_kind='module.instance.suspend'"), 0);
});

function createWork(ctx: Awaited<ReturnType<typeof ready>>, title?: string, key = randomUUID()) {
  return post(`/tenants/${ctx.tenantId}/workspaces/${ctx.workspaceId}/works`, ctx.owner, workBody(title), undefined, key);
}
function prepare(ctx: Awaited<ReturnType<typeof ready>>, workId: string, workVersion = '1', name = 'result.txt') {
  return post(`/tenants/${ctx.tenantId}/works/${workId}/results/uploads`, ctx.owner, {
    content_type: 'text/plain', byte_size: bytes.byteLength, sha256: sha, display_name: name, expected_work_version: workVersion,
  });
}
function finalize(ctx: Awaited<ReturnType<typeof ready>>, workId: string, uploadId: string, workVersion = '1') {
  return post(`/tenants/${ctx.tenantId}/works/${workId}/results/uploads/${uploadId}/finalize`, ctx.owner, { expected_work_version: workVersion }, '"2"');
}
async function putBytes(ctx: Awaited<ReturnType<typeof ready>>, workId: string, uploadId: string) {
  const response = await app.request(h.origin + `/api/v1/tenants/${ctx.tenantId}/works/${workId}/results/uploads/${uploadId}/content`, {
    method: 'PUT', body: bytes, headers: { Origin: h.origin, Cookie: ctx.owner.cookie, 'X-CSRF-Token': ctx.owner.csrf,
      'Idempotency-Key': randomUUID(), 'If-Match': '"1"' },
  });
  return { status: response.status, data: await response.json(), response };
}
async function workCounts() {
  const tables = ['work_items', 'private_work_results', 'assets', 'asset_objects', 'asset_upload_intents', 'scoped_command_receipts', 'scoped_transition_journal', 'scoped_outbox'];
  return Object.fromEntries(await Promise.all(tables.map(async table => [table, await h.count(table)])));
}

test('T-016 real suspend keeps Work and Result reads/archive, fences all five write paths, and resume restores writes', async () => {
  const ctx = await ready();
  const published = await createWork(ctx, '已發布工作');
  assert.equal(published.status, 201, JSON.stringify(published.data));
  const publishedWork = published.data.resource_ref.resource_id;
  const publishedUpload = await prepare(ctx, publishedWork);
  assert.equal(publishedUpload.status, 201);
  assert.equal((await putBytes(ctx, publishedWork, publishedUpload.data.resource_ref.resource_id)).status, 200);
  const finished = await finalize(ctx, publishedWork, publishedUpload.data.resource_ref.resource_id);
  assert.equal(finished.status, 200, JSON.stringify(finished.data));
  const draft = await createWork(ctx, '待編修工作'), archive = await createWork(ctx, '可封存工作');
  const draftId = draft.data.resource_ref.resource_id, archiveId = archive.data.resource_ref.resource_id;
  const unwritten = await prepare(ctx, draftId, '1', 'unwritten.txt');
  const uploaded = await prepare(ctx, draftId, '1', 'uploaded.txt');
  assert.equal(unwritten.status, 201); assert.equal(uploaded.status, 201);
  assert.equal((await putBytes(ctx, draftId, uploaded.data.resource_ref.resource_id)).status, 200);
  assert.equal((await suspend(ctx)).status, 200);
  const before = await workCounts();
  const refusals = [
    await createWork(ctx, '應拒絕的新工作'),
    await h.call('PATCH', `/tenants/${ctx.tenantId}/works/${draftId}`, ctx.owner, workBody('應拒絕的編修'), { 'If-Match': '"1"', 'Idempotency-Key': randomUUID() }, app),
    await prepare(ctx, draftId, '1', 'refused.txt'),
    await putBytes(ctx, draftId, unwritten.data.resource_ref.resource_id),
    await finalize(ctx, draftId, uploaded.data.resource_ref.resource_id),
  ];
  for (const refused of refusals) error(refused, 409, 'work_instance_unavailable');
  assert.deepEqual(await workCounts(), before);
  for (const url of [
    `/tenants/${ctx.tenantId}/workspaces/${ctx.workspaceId}/works`, `/tenants/${ctx.tenantId}/works/${publishedWork}`,
    `/tenants/${ctx.tenantId}/works/${publishedWork}/results`,
    `/tenants/${ctx.tenantId}/works/${publishedWork}/results/${finished.data.resource_ref.resource_id}`,
    `/tenants/${ctx.tenantId}/works/${draftId}/results/uploads/${unwritten.data.resource_ref.resource_id}`,
  ]) assert.equal((await get(url, ctx.owner)).status, 200, url);
  const download = await app.request(h.origin + `/api/v1/tenants/${ctx.tenantId}/works/${publishedWork}/results/${finished.data.resource_ref.resource_id}/content`, {
    headers: { Cookie: ctx.owner.cookie },
  });
  assert.equal(download.status, 200);
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), bytes);
  assert.equal((await post(`/tenants/${ctx.tenantId}/works/${archiveId}/archive`, ctx.owner, {}, '"1"')).status, 200);
  assert.equal((await resume(ctx)).status, 200);
  assert.equal((await createWork(ctx, '恢復後的新工作')).status, 201);
  const updated = await h.call('PATCH', `/tenants/${ctx.tenantId}/works/${draftId}`, ctx.owner, workBody('恢復後的編修'), { 'If-Match': '"1"', 'Idempotency-Key': randomUUID() }, app);
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  assert.equal((await putBytes(ctx, draftId, unwritten.data.resource_ref.resource_id)).status, 200);
  const newUpload = await prepare(ctx, draftId, '2', 'resumed.txt');
  assert.equal(newUpload.status, 201, JSON.stringify(newUpload.data));
  assert.equal((await putBytes(ctx, draftId, newUpload.data.resource_ref.resource_id)).status, 200);
  assert.equal((await finalize(ctx, draftId, newUpload.data.resource_ref.resource_id, '2')).status, 200);
});

async function holder(sql: string, params: unknown[]) {
  const q = await h.pool.connect();
  await q.query('BEGIN');
  const pid = Number((await q.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  try { assert.equal((await q.query(sql, params)).rowCount, 1); }
  catch (e) { await q.query('ROLLBACK'); q.release(); throw e; }
  let closed = false;
  async function close(commit: boolean) {
    if (closed) return;
    closed = true;
    try { await q.query(commit ? 'COMMIT' : 'ROLLBACK'); } finally { q.release(); }
  }
  return { pid, commit: () => close(true), release: () => close(false) };
}
async function waitBlocked(pid: number, parts: string[]) {
  const deadline = Date.now() + 10_000;
  let rows: { pid: number; query: string }[] = [];
  while (Date.now() < deadline) {
    rows = (await h.admin.query<{ pid: number; query: string }>(
      `SELECT pid,query FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))`, [pid],
    )).rows;
    const hit = rows.find(row => parts.every(part => row.query.includes(part)));
    if (hit) return hit;
    await nextTurn();
  }
  assert.fail(`no blocked statement matching ${parts.join(',')}: ${JSON.stringify(rows)}`);
}

for (const winner of ['suspend', 'resume'] as const) {
  test(`lifecycle race: ${winner} holds the instance first and the competing suspend loses CAS`, { timeout: 30_000 }, async t => {
    const ctx = await ready();
    // Resume is valid on a suspended instance. Its instance lock is held while
    // waiting on the binding, so the competing suspend reaches CAS after resume.
    if (winner === 'resume') assert.equal((await suspend(ctx)).status, 200);
    const before = await lifecycleSnapshot(ctx), firstKey = randomUUID(), secondKey = randomUUID();
    const gate = await holder(`SELECT binding_id FROM deployment_bindings WHERE binding_id=$1 FOR SHARE`, [before.instance.binding_id]);
    let first: Promise<Reply> | undefined, second: Promise<Reply> | undefined;
    try {
      first = winner === 'suspend' ? suspend(ctx, firstKey, before.instance.version) : resume(ctx, firstKey, before.instance.version);
      const blocked = await waitBlocked(gate.pid, ['deployment_bindings', 'FOR NO KEY UPDATE']);
      second = suspend(ctx, secondKey, before.instance.version);
      await waitBlocked(blocked.pid, ['module_instances', 'FOR NO KEY UPDATE']);
      await gate.commit();
      const [accepted, refused] = await Promise.all([first, second]);
      t.diagnostic(JSON.stringify({ statuses: [accepted.status, refused.status], loser_code: refused.data.code }));
      assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
      error(refused, 412, 'version_conflict');
      const after = await lifecycleSnapshot(ctx), status = winner === 'suspend' ? 'suspended' : 'active';
      assert.deepEqual(after.instance, { ...before.instance, status, binding_state: status,
        version: String(BigInt(before.instance.version) + 1n), binding_version: String(BigInt(before.instance.binding_version) + 1n),
        suspension_operation_id: winner === 'suspend' ? accepted.data.operation_id : null });
      assert.deepEqual(after.capacity, before.capacity);
      for (const table of ['operations', 'scoped_command_receipts', 'scoped_transition_journal', 'scoped_outbox'] as const) {
        assert.equal(after.counts[table], before.counts[table] + 1, table);
      }
      assert.equal(await h.count('module_provision_operations', 'WHERE tenant_id=$1 AND operation_kind=$2', [ctx.tenantId, `module.instance.${winner}`]), 1);
      assert.equal((await facts(ctx, `module.instance.${winner}`)).length, 1);
      assert.equal(await h.count('scoped_command_receipts', 'WHERE idempotency_key=$1', [secondKey]), 0);
      assert.equal((await detail(ctx)).status, status);
    } finally {
      await gate.release();
      await Promise.allSettled([first, second].filter(Boolean) as Promise<Reply>[]);
    }
  });
}

for (const first of ['work', 'suspend'] as const) {
  test(`Work create versus suspend: ${first} locks the instance first`, { timeout: 30_000 }, async () => {
    const ctx = await ready(), original = await physical(ctx), key = randomUUID();
    const gate = first === 'work'
      ? await holder('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`tenant.capacity/v1/${ctx.tenantId}/policy`])
      : await holder(`SELECT binding_id FROM deployment_bindings WHERE binding_id=$1 FOR SHARE`, [original.binding_id]);
    let creating: Promise<Reply> | undefined, suspending: Promise<Reply> | undefined;
    try {
      if (first === 'work') {
        creating = createWork(ctx, '先完成工作', key);
        const blocked = await waitBlocked(gate.pid, ['pg_advisory_xact_lock']);
        suspending = suspend(ctx, randomUUID(), original.version);
        await waitBlocked(blocked.pid, ['module_instances', 'FOR NO KEY UPDATE']);
      } else {
        suspending = suspend(ctx, randomUUID(), original.version);
        const blocked = await waitBlocked(gate.pid, ['deployment_bindings', 'FOR NO KEY UPDATE']);
        creating = createWork(ctx, '應拒絕工作', key);
        await waitBlocked(blocked.pid, ['module_instances', 'FOR SHARE']);
      }
      await gate.commit();
      const [created, suspended] = await Promise.all([creating!, suspending!]);
      assert.equal(suspended.status, 200, JSON.stringify(suspended.data));
      if (first === 'work') {
        assert.equal(created.status, 201, JSON.stringify(created.data));
        assert.equal(await h.count('work_items', 'WHERE tenant_id=$1', [ctx.tenantId]), 1);
      } else {
        error(created, 409, 'work_instance_unavailable');
        assert.equal(await h.count('work_items', 'WHERE tenant_id=$1', [ctx.tenantId]), 0);
        assert.equal(await h.count('scoped_command_receipts', 'WHERE idempotency_key=$1', [key]), 0);
      }
    } finally {
      await gate.release();
      await Promise.allSettled([creating, suspending].filter(Boolean) as Promise<Reply>[]);
    }
  });
}

test('explicit reuse launch waits for suspend then refuses; plans refuse and default resolution skips it', { timeout: 30_000 }, async () => {
  const ctx = await ready(true), original = await physical(ctx);
  const workspace = await h.workspace(ctx.owner, ctx.tenantId, '競態店面');
  const body = h.planBody(guild, workspace, 'synthetic-storefront', 'synthetic-storefront@1.0.0', {
    dependencies: [{ requirement_key: 'inventory', choice: 'reuse', instance_id: ctx.instanceId, expected_version: original.version }],
  });
  const planned = await h.plan(ctx.owner, ctx.tenantId, body);
  assert.equal(planned.status, 201);
  const gate = await holder(`SELECT binding_id FROM deployment_bindings WHERE binding_id=$1 FOR SHARE`, [original.binding_id]);
  let suspending: Promise<Reply> | undefined, launching: Promise<Reply> | undefined;
  try {
    suspending = suspend(ctx, randomUUID(), original.version);
    const blocked = await waitBlocked(gate.pid, ['deployment_bindings', 'FOR NO KEY UPDATE']);
    launching = h.launch(ctx.owner, ctx.tenantId, planned);
    await waitBlocked(blocked.pid, ['module_instances', 'FOR SHARE']);
    await gate.commit();
    const [suspended, launch] = await Promise.all([suspending, launching]);
    assert.equal(suspended.status, 200); error(launch, 409, 'instance_unavailable');
    error(await h.plan(ctx.owner, ctx.tenantId, body), 409, 'instance_unavailable');
    const defaultPlan = await h.plan(ctx.owner, ctx.tenantId, h.planBody(guild, workspace, 'synthetic-storefront', 'synthetic-storefront@1.0.0'));
    assert.equal(defaultPlan.status, 201, JSON.stringify(defaultPlan.data));
    assert.equal(defaultPlan.data.choices.find((choice: any) => choice.requirement_key === 'inventory').choice, 'create');
    assert.equal(await h.count('application_installations', 'WHERE workspace_id=$1', [workspace]), 0);
  } finally {
    await gate.release();
    await Promise.allSettled([suspending, launching].filter(Boolean) as Promise<Reply>[]);
  }
});

test('capacity usage/reservations/ledger stay unchanged; suspended instances count and lifecycle operations use no provision slot', async () => {
  const ctx = await ready(), original = await capacity(ctx);
  await h.pool.query(`UPDATE tenant_capacity_policies SET max_active_instances=1,max_instances_per_module=1,max_concurrent_provisions=1`);
  assert.equal((await suspend(ctx)).status, 200);
  assert.deepEqual(await capacity(ctx), original);
  const workspace = await h.workspace(ctx.owner, ctx.tenantId, '容量邊界');
  const planned = await h.plan(ctx.owner, ctx.tenantId, h.planBody(guild, workspace));
  assert.equal(planned.status, 201);
  error(await h.launch(ctx.owner, ctx.tenantId, planned), 429, 'quota_exceeded');
  assert.equal((await resume(ctx)).status, 200);
  assert.deepEqual(await capacity(ctx), original);
  await h.pool.query(`UPDATE tenant_capacity_policies SET max_active_instances=10,max_instances_per_module=3`);
  const newPlan = await h.plan(ctx.owner, ctx.tenantId, h.planBody(guild, workspace, 'synthetic-storefront', 'synthetic-storefront@1.0.0'));
  assert.equal(newPlan.status, 201);
  const launched = await h.launch(ctx.owner, ctx.tenantId, newPlan);
  assert.equal(launched.status, 200, JSON.stringify(launched.data));
  const usage = (await h.pool.query(`SELECT count(*)::int AS n FROM module_provision_operations
    WHERE tenant_id=$1 AND operation_kind='application.launch' AND state IN ('requested','running','needs_reconciliation')`, [ctx.tenantId])).rows[0].n;
  assert.equal(usage, 0);
  assert.equal(await h.count('module_provision_steps', `WHERE operation_id IN
    (SELECT operation_id FROM module_provision_operations WHERE operation_kind <> 'application.launch')`), 0);
});

test('lifecycle operations read/reconcile, refuse cancel/by-operation, and never advance or sweep', async () => {
  const ctx = await ready();
  const suspended = await suspend(ctx), resumed = await resume(ctx);
  for (const result of [suspended, resumed]) {
    assert.equal(result.status, 200);
    const endpoint = `/tenants/${ctx.tenantId}/operations/${result.data.operation_id}`;
    const read = await get(endpoint, ctx.owner);
    assert.equal(read.status, 200); assert.deepEqual(read.data, result.data); assert.equal(read.response.headers.get('etag'), '"1"');
    const matched = await post(`${endpoint}/reconcile`, ctx.owner, {}, '"1"');
    assert.equal(matched.status, 202); assert.deepEqual(matched.data, result.data);
    error(await post(`${endpoint}/reconcile`, ctx.owner, {}, '"2"'), 412, 'version_conflict');
    error(await post(`${endpoint}/cancel`, ctx.owner, { reason: 'member_cancelled' }, '"1"'), 409, 'operation_not_cancellable');
    error(await get(`/tenants/${ctx.tenantId}/application-installations/by-operation/${result.data.operation_id}`, ctx.owner), 404, 'not_found');
  }
  const before = await workCounts(), beforeInstance = await physical(ctx);
  const beforeOps = (await h.pool.query(`SELECT to_jsonb(o) AS row FROM module_provision_operations o WHERE tenant_id=$1 ORDER BY operation_id`, [ctx.tenantId])).rows;
  for (const result of [suspended, resumed]) await advanceOperation(h.pool, ctx.tenantId, result.data.operation_id, { providers: h.providers });
  await sweepDueOperations(h.pool, undefined, h.providers);
  assert.deepEqual(await workCounts(), before);
  assert.deepEqual(await physical(ctx), beforeInstance);
  assert.deepEqual((await h.pool.query(`SELECT to_jsonb(o) AS row FROM module_provision_operations o WHERE tenant_id=$1 ORDER BY operation_id`, [ctx.tenantId])).rows, beforeOps);
  // No executor membership or operation locks for a non-launch row.
  const gate = await holder(`SELECT operation_id FROM module_provision_operations WHERE operation_id=$1 FOR UPDATE`, [suspended.data.operation_id]);
  try {
    await advanceOperation(h.pool, ctx.tenantId, suspended.data.operation_id, { providers: h.providers });
    await sweepDueOperations(h.pool, undefined, h.providers);
  } finally { await gate.release(); }
});

test('impact reports bounded ordered consumers/workspaces and true totals; active consumers do not prevent provider suspension', async () => {
  const ctx = await ready(true);
  const storefront = (await h.pool.query(`SELECT instance_id FROM module_instances WHERE tenant_id=$1 AND module_key='synthetic-storefront'`, [ctx.tenantId])).rows[0].instance_id;
  const before = await detail(ctx);
  assert.deepEqual(before.impact.consumers, [{ caller_instance_id: storefront, requirement_key: 'inventory', module_key: 'synthetic-storefront', status: 'active' }]);
  assert.equal(before.impact.consumer_count, 1);
  const workspaces: string[] = [];
  const q = await h.pool.connect();
  try {
    await q.query('BEGIN');
    for (let n = 0; n < 52; n += 1) {
      const caller = randomUUID(), binding = randomUUID(), workspace = randomUUID();
      workspaces.push(workspace);
      await q.query(`INSERT INTO module_instances(instance_id,tenant_id,module_key,module_release_ref,application_release_ref,data_schema_version,
          contract_ref,status,binding_id,created_by_principal_id,origin_guild_key)
        SELECT $1,tenant_id,module_key,module_release_ref,application_release_ref,data_schema_version,contract_ref,'active',$2,created_by_principal_id,origin_guild_key
        FROM module_instances WHERE instance_id=$3`, [caller, binding, storefront]);
      await q.query(`INSERT INTO deployment_bindings(binding_id,tenant_id,instance_id,mode,environment,contract_ref,state)
        SELECT $1,tenant_id,$2,mode,environment,contract_ref,'active' FROM deployment_bindings WHERE instance_id=$3`, [binding, caller, storefront]);
      await q.query(`INSERT INTO module_dependencies(dependency_id,tenant_id,caller_instance_id,requirement_key,capability,provider_instance_id)
        VALUES($1,$2,$3,'inventory','inventory:read',$4)`, [randomUUID(), ctx.tenantId, caller, ctx.instanceId]);
      await q.query(`INSERT INTO workspaces(workspace_id,tenant_id,name) VALUES($1,$2,$3)`, [workspace, ctx.tenantId, `合成入口${n}`]);
      await q.query(`INSERT INTO workspace_module_bindings(tenant_id,workspace_id,entry_capability,instance_id)
        VALUES($1,$2,'inventory:read',$3)`, [ctx.tenantId, workspace, ctx.instanceId]);
    }
    await q.query('COMMIT');
  } finally { await q.query('ROLLBACK'); q.release(); }
  const projected = await detail(ctx);
  assert.equal(projected.impact.consumer_count, 53);
  assert.equal(projected.impact.consumers.length, 50);
  const ids = projected.impact.consumers.map(consumer => consumer.caller_instance_id);
  assert.deepEqual(ids, [...ids].sort());
  assert.equal(projected.impact.workspace_count, 52);
  assert.deepEqual(projected.impact.workspace_ids, workspaces.sort().slice(0, 50));
  assert.equal((await suspend(ctx)).status, 200);
  assert.equal((await get(path(ctx.tenantId, storefront), ctx.owner)).data.status, 'active');
  assert.equal((await detail(ctx)).impact.consumer_count, 53);
});

test('suspended bound workspace still returns strict launchpad context and refuses manual-work enable with 409', async () => {
  const ctx = await ready();
  assert.equal((await suspend(ctx)).status, 200);
  const context = await get(`/tenants/${ctx.tenantId}/workspaces/${ctx.workspaceId}/launchpad-context?guild_key=${guild}`, ctx.owner);
  assert.equal(context.status, 200, JSON.stringify(context.data));
  const body = LaunchpadContextSchema.parse(context.data);
  assert.equal(body.instances.find(instance => instance.instance_id === ctx.instanceId)?.status, 'suspended');
  assert.deepEqual(body.connection_summary, []);
  const before = await enableSnapshot();
  const enabled = await h.enable(ctx.owner, ctx.tenantId, ctx.workspaceId, guild);
  unavailableEnable(enabled, suspendedNotice);
  assert.deepEqual(await enableSnapshot(), before);
  assert.equal((await detail(ctx)).status, 'suspended');
});

test('resume takes no capacity advisory even when another connection holds it', { timeout: 10_000 }, async () => {
  const ctx = await ready();
  assert.equal((await suspend(ctx)).status, 200);
  const gate = await holder('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`tenant.capacity/v1/${ctx.tenantId}/policy`]);
  try { assert.equal((await resume(ctx)).status, 200); }
  finally { await gate.release(); }
});

const suspendedNotice = '這個工作區的模組已暫停，舊的工作仍可查看；恢復後才能新增或修改。';
const unavailableNotice = '這個工作區的模組目前無法寫入，舊的工作仍可查看。';
function unavailableEnable(reply: Reply, notice: string) {
  error(reply, 409, 'work_instance_unavailable');
  assert.equal(reply.data.detail, notice);
  assert.equal(reply.response.headers.get('cache-control'), 'private, no-store');
}
async function enableSnapshot() {
  const rows: Record<string, unknown> = {};
  for (const table of ['workspace_module_bindings', 'module_instances', 'deployment_bindings', 'module_launch_plans',
    'module_provision_operations', 'scoped_command_receipts', 'scoped_transition_journal', 'scoped_outbox']) {
    rows[table] = (await h.pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return rows;
}

test('manual-work enable on a member-suspended binding has no effects or receipt and the same key succeeds after resume', async () => {
  const ctx = await ready(), key = randomUUID();
  assert.equal((await suspend(ctx)).status, 200);
  const before = await enableSnapshot();
  unavailableEnable(await h.enable(ctx.owner, ctx.tenantId, ctx.workspaceId, guild, undefined, key), suspendedNotice);
  assert.deepEqual(await enableSnapshot(), before);
  assert.equal(await h.count('scoped_command_receipts', 'WHERE idempotency_key=$1', [key]), 0);
  assert.equal((await resume(ctx)).status, 200);
  const resumed = await enableSnapshot();
  const enabled = await h.enable(ctx.owner, ctx.tenantId, ctx.workspaceId, guild, undefined, key);
  assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
  const binding = ManualWorkBindingSchema.parse(enabled.data);
  assert.equal(binding.reused, true);
  assert.equal(binding.instance_id, ctx.instanceId);
  const after = await enableSnapshot();
  for (const table of Object.keys(resumed).filter(table => table !== 'scoped_command_receipts')) {
    assert.deepEqual(after[table], resumed[table], table);
  }
  assert.equal(await h.count('scoped_command_receipts', 'WHERE idempotency_key=$1', [key]), 1);
});

test('manual-work enable on a platform-held bound instance returns the suspended notice without effects', async () => {
  const ctx = await ready();
  assert.equal((await suspend(ctx)).status, 200);
  await h.pool.query(`UPDATE module_instances SET suspension_operation_id=NULL WHERE instance_id=$1`, [ctx.instanceId]);
  assert.equal((await physical(ctx)).binding_state, 'suspended');
  assert.equal((await detail(ctx)).suspension?.kind, 'platform');
  const before = await enableSnapshot();
  unavailableEnable(await h.enable(ctx.owner, ctx.tenantId, ctx.workspaceId, guild), suspendedNotice);
  assert.deepEqual(await enableSnapshot(), before);
});

for (const state of ['pending', 'retired'] as const) {
  test(`manual-work enable on an active bound instance with a ${state} deployment returns the unavailable notice without effects`, async () => {
    const ctx = await ready();
    await h.pool.query(`UPDATE deployment_bindings SET state=$1 WHERE instance_id=$2`, [state, ctx.instanceId]);
    assert.equal((await physical(ctx)).status, 'active');
    const before = await enableSnapshot();
    unavailableEnable(await h.enable(ctx.owner, ctx.tenantId, ctx.workspaceId, guild), unavailableNotice);
    assert.deepEqual(await enableSnapshot(), before);
  });
}

test('manual-work enable preserves binding-conflict precedence over a suspended bound instance', async () => {
  const ctx = await ready();
  const secondWorkspace = await h.workspace(ctx.owner, ctx.tenantId, '另一個工作區');
  const second = await h.enable(ctx.owner, ctx.tenantId, secondWorkspace, guild, { kind: 'create_new' });
  assert.equal(second.status, 200, JSON.stringify(second.data));
  assert.equal((await suspend(ctx)).status, 200);
  const before = await enableSnapshot();
  error(await h.enable(ctx.owner, ctx.tenantId, ctx.workspaceId, guild, {
    kind: 'reuse', instance_id: second.data.instance_id, expected_version: '1',
  }), 409, 'workspace_binding_conflict');
  unavailableEnable(await h.enable(ctx.owner, ctx.tenantId, ctx.workspaceId, guild, {
    kind: 'reuse', instance_id: ctx.instanceId, expected_version: (await detail(ctx)).version,
  }), suspendedNotice);
  assert.deepEqual(await enableSnapshot(), before);
});

test('manual-work enable rechecks an unwritable binding that appears while waiting for the installation fingerprint', { timeout: 30_000 }, async t => {
  const ctx = await ready(), version = (await detail(ctx)).version;
  const workspaceId = await h.workspace(ctx.owner, ctx.tenantId, '等待中綁定的工作區');
  assert.equal(await h.count('workspace_module_bindings', 'WHERE workspace_id=$1', [workspaceId]), 0);
  const gate = await holder('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `module-registry/installation/v1/${ctx.tenantId}/${workspaceId}/manual-workspace`,
  ]);
  const key = randomUUID();
  let enabling: Promise<Reply> | undefined;
  try {
    enabling = h.enable(ctx.owner, ctx.tenantId, workspaceId, guild, { kind: 'reuse', instance_id: ctx.instanceId, expected_version: version }, key);
    const blocked = await waitBlocked(gate.pid, ['pg_advisory_xact_lock']);
    const lock = (await h.admin.query(`SELECT 1 FROM pg_locks waiting JOIN pg_locks held
      ON waiting.locktype=held.locktype AND waiting.database=held.database
      AND waiting.classid=held.classid AND waiting.objid=held.objid AND waiting.objsubid=held.objsubid
      WHERE waiting.pid=$1 AND held.pid=$2 AND waiting.locktype='advisory' AND NOT waiting.granted AND held.granted`, [blocked.pid, gate.pid])).rows;
    assert.equal(lock.length, 1, 'enable must be waiting for this fingerprint advisory');
    await h.pool.query(`INSERT INTO workspace_module_bindings(tenant_id,workspace_id,entry_capability,instance_id)
      VALUES($1,$2,'work:create',$3)`, [ctx.tenantId, workspaceId, ctx.instanceId]);
    assert.equal((await suspend(ctx)).status, 200);
    const before = await enableSnapshot();
    await gate.commit();
    const refused = await enabling;
    t.diagnostic(JSON.stringify({ status: refused.status, code: refused.data.code ?? null, reused: refused.data.reused ?? null }));
    unavailableEnable(refused, suspendedNotice);
    assert.deepEqual(await enableSnapshot(), before);
    assert.equal(await h.count('scoped_command_receipts', 'WHERE idempotency_key=$1', [key]), 0);
  } finally {
    await gate.release();
    await Promise.allSettled(enabling ? [enabling] : []);
  }
});
