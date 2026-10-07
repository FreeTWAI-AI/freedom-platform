import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createApp } from '../../apps/platform-api/src/app.js';
import { InstanceDetailSchema, RegistryOperationSchema } from '../../contracts/guild-launchpad/v1/module-registry.js';
import { LaunchpadContextSchema, ManualWorkBindingSchema } from '../../contracts/guild-launchpad/v1/tenant-work.js';
import { launchApplication, advanceOperation, sweepDueOperations } from '../../modules/module-registry/service.js';
import { bindTenantContext } from '../../packages/resource-scopes/tenant-transaction.js';
import { authenticate } from '../../modules/identity-membership/service.js';
import { digestOf } from '../../modules/module-registry/canonical.js';
import { FakeObjectStore } from '../../packages/asset-storage/fake-store.js';
import { DEMO_USERS } from '../../packages/testing/seed.js';
import { setSyntheticFault } from '../../packages/testing/synthetic-module-provider.js';
import { createRegistryHarness, type RegistryHarness, type Reply, type Session } from './module-registry-harness.js';

let h: RegistryHarness;
let app: ReturnType<typeof createApp>;
const guild = 'guild_ai_field';
const reason = '保留資料，封存模組實例';
const bytes = new TextEncoder().encode('synthetic result');
const sha = createHash('sha256').update(bytes).digest('hex');
const workBody = (title = '合成工作') => ({ title, objective: '保存人工成果', progress: 'todo' });

before(async () => { h = await createRegistryHarness('fp_mia', { synthetic: true }); });
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
async function physical(ctx: { tenantId: string; instanceId: string }) {
  return (await h.pool.query(`SELECT i.status,i.version::text AS version,i.suspension_operation_id,i.archive_operation_id,i.authority_epoch::text AS authority_epoch,
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

async function archive(ctx: Awaited<ReturnType<typeof ready>>, key = randomUUID(), expected?: string) {
  const current = expected ?? (await detail(ctx)).version;
  return post(`${path(ctx.tenantId, ctx.instanceId)}/archive`, ctx.owner, { reason }, `"${current}"`, key);
}
async function installations(tenantId: string) {
  return (await h.pool.query(`SELECT installation_id,status,version::text AS version FROM application_installations
    WHERE tenant_id=$1 ORDER BY installation_id`, [tenantId])).rows;
}
async function snapshot(ctx: Awaited<ReturnType<typeof ready>>) {
  const tables = ['module_instances','deployment_bindings','application_installations','application_module_links',
    'module_dependencies','workspace_module_bindings','module_provision_operations','capacity_reservations','capacity_ledger'];
  const rows: Record<string, unknown> = {};
  for (const table of tables) rows[table] = (await h.pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t
    WHERE tenant_id=$1 ORDER BY to_jsonb(t)::text`, [ctx.tenantId])).rows;
  rows.facts = await facts(ctx, 'module.instance.archive');
  rows.receipts = (await h.pool.query(`SELECT to_jsonb(r) AS row FROM scoped_command_receipts r ORDER BY to_jsonb(r)::text`)).rows;
  return rows;
}
test('archive requires strict headers and bodies and reject caller authority fields', async () => {
  const ctx = await ready();
  for (const command of ['archive']) {
    const endpoint = `${path(ctx.tenantId, ctx.instanceId)}/${command}`;
    const body = command === 'archive' ? { reason } : {};
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
    const invalid = command === 'archive' ? [{}, { reason: '短' }, { reason: 'x'.repeat(1001) }, { reason: '控制\n字元' }, { reason: 42 }, null, []] : [{ reason }, null, []];
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

test('T-016 real archive keeps Work and Result reads/archive and fences all five write paths', async () => {
  const ctx = await ready();
  const published = await createWork(ctx, '已發布工作');
  assert.equal(published.status, 201, JSON.stringify(published.data));
  const publishedWork = published.data.resource_ref.resource_id;
  const publishedUpload = await prepare(ctx, publishedWork);
  assert.equal(publishedUpload.status, 201);
  assert.equal((await putBytes(ctx, publishedWork, publishedUpload.data.resource_ref.resource_id)).status, 200);
  const finished = await finalize(ctx, publishedWork, publishedUpload.data.resource_ref.resource_id);
  assert.equal(finished.status, 200, JSON.stringify(finished.data));
  const draft = await createWork(ctx, '待編修工作'), archiveWork = await createWork(ctx, '可封存工作');
  const draftId = draft.data.resource_ref.resource_id, archiveId = archiveWork.data.resource_ref.resource_id;
  const unwritten = await prepare(ctx, draftId, '1', 'unwritten.txt');
  const uploaded = await prepare(ctx, draftId, '1', 'uploaded.txt');
  assert.equal(unwritten.status, 201); assert.equal(uploaded.status, 201);
  assert.equal((await putBytes(ctx, draftId, uploaded.data.resource_ref.resource_id)).status, 200);
  assert.equal((await archive(ctx)).status, 200);
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

for (const first of ['work', 'archive'] as const) {
  test(`Work create versus archive: ${first} locks the instance first`, { timeout: 30_000 }, async () => {
    const ctx = await ready(), original = await physical(ctx), key = randomUUID();
    const gate = first === 'work'
      ? await holder('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`tenant.capacity/v1/${ctx.tenantId}/policy`])
      : await holder(`SELECT binding_id FROM deployment_bindings WHERE binding_id=$1 FOR SHARE`, [original.binding_id]);
    let creating: Promise<Reply> | undefined, archiving: Promise<Reply> | undefined;
    try {
      if (first === 'work') {
        creating = createWork(ctx, '先完成工作', key);
        const blocked = await waitBlocked(gate.pid, ['pg_advisory_xact_lock']);
        archiving = archive(ctx, randomUUID(), original.version);
        await waitBlocked(blocked.pid, ['module_instances', 'FOR NO KEY UPDATE']);
      } else {
        archiving = archive(ctx, randomUUID(), original.version);
        const blocked = await waitBlocked(gate.pid, ['deployment_bindings', 'FOR NO KEY UPDATE']);
        creating = createWork(ctx, '應拒絕工作', key);
        await waitBlocked(blocked.pid, ['module_instances', 'FOR SHARE']);
      }
      await gate.commit();
      const [created, archived] = await Promise.all([creating!, archiving!]);
      assert.equal(archived.status, 200, JSON.stringify(archived.data));
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
      await Promise.allSettled([creating, archiving].filter(Boolean) as Promise<Reply>[]);
    }
  });
}

test('archive operations read/reconcile, refuse cancel/by-operation, and never advance or sweep', async () => {
  const ctx = await ready();
  const archived = await archive(ctx);
  for (const result of [archived]) {
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
  for (const result of [archived]) await advanceOperation(h.pool, ctx.tenantId, result.data.operation_id, { providers: h.providers });
  await sweepDueOperations(h.pool, undefined, h.providers);
  assert.deepEqual(await workCounts(), before);
  assert.deepEqual(await physical(ctx), beforeInstance);
  assert.deepEqual((await h.pool.query(`SELECT to_jsonb(o) AS row FROM module_provision_operations o WHERE tenant_id=$1 ORDER BY operation_id`, [ctx.tenantId])).rows, beforeOps);
  // No executor membership or operation locks for a non-launch row.
  const gate = await holder(`SELECT operation_id FROM module_provision_operations WHERE operation_id=$1 FOR UPDATE`, [archived.data.operation_id]);
  try {
    await advanceOperation(h.pool, ctx.tenantId, archived.data.operation_id, { providers: h.providers });
    await sweepDueOperations(h.pool, undefined, h.providers);
  } finally { await gate.release(); }
});

test('archived bound workspace still returns strict launchpad context and an idempotent manual-work binding', async () => {
  const ctx = await ready();
  const saved = await createWork(ctx, '封存前工作');
  assert.equal(saved.status, 201);
  assert.equal((await archive(ctx)).status, 200);
  const context = await get(`/tenants/${ctx.tenantId}/workspaces/${ctx.workspaceId}/launchpad-context?guild_key=${guild}`, ctx.owner);
  assert.equal(context.status, 200, JSON.stringify(context.data));
  const body = LaunchpadContextSchema.parse(context.data);
  assert.equal(body.instances.find(instance => instance.instance_id === ctx.instanceId)?.status, 'archived');
  assert.deepEqual(body.connection_summary, []);
  assert.deepEqual(Object.keys(context.data).sort(), ['tenant_id', 'workspace_id', 'source_version', 'instances', 'work_page', 'capacity_summary', 'connection_summary'].sort());
  assert.equal(body.work_page.items[0].work_id, saved.data.resource_ref.resource_id);
  const retained = await get(`/tenants/${ctx.tenantId}/workspaces/${ctx.workspaceId}/module-binding`, ctx.owner);
  assert.equal(retained.status, 200, JSON.stringify(retained.data));
  assert.deepEqual(retained.data, { tenant_id: ctx.tenantId, workspace_id: ctx.workspaceId,
    binding: { entry_capability: 'work:create', instance_id: ctx.instanceId, instance_status: 'archived', writable: false } });
  const enabled = await h.enable(ctx.owner, ctx.tenantId, ctx.workspaceId, guild);
  assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
  const binding = ManualWorkBindingSchema.parse(enabled.data);
  assert.equal(binding.reused, true);
  assert.equal(binding.instance_id, ctx.instanceId);
  assert.equal((await detail(ctx)).status, 'archived');
});


test('owner archives active manual work with exact operation, versions, retained references and one fact', async () => {
  const ctx = await ready(), original = await physical(ctx), beforeCapacity = await capacity(ctx);
  const beforeInstallations = await installations(ctx.tenantId);
  const beforeReferences = (await snapshot(ctx));
  const accepted = await archive(ctx);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  assert.equal(accepted.response.headers.get('etag'), '"1"');
  assert.equal(accepted.response.headers.get('cache-control'), 'private, no-store');
  RegistryOperationSchema.parse(accepted.data);
  assert.equal(accepted.data.state, 'succeeded');
  assert.equal('resource_ref' in accepted.data, false);
  const retired = await physical(ctx);
  assert.deepEqual(retired, { ...original, status: 'archived', version: String(BigInt(original.version)+1n),
    archive_operation_id: accepted.data.operation_id, suspension_operation_id: null,
    binding_state: 'retired', binding_version: String(BigInt(original.binding_version)+1n) });
  assert.deepEqual(await installations(ctx.tenantId), beforeInstallations.map(row => ({ ...row, status: 'archived', version: String(BigInt(row.version)+1n) })));
  const operation = (await h.pool.query(`SELECT * FROM module_provision_operations WHERE operation_id=$1`, [accepted.data.operation_id])).rows[0];
  assert.equal(operation.operation_kind, 'module.instance.archive');
  assert.equal(operation.instance_id, ctx.instanceId);
  assert.equal(operation.reason, reason);
  assert.equal(operation.state, 'succeeded');
  assert.equal(operation.version, '1');
  for (const column of ['policy_revision','installation_id','plan_id']) assert.equal(operation[column], null);
  const actor = (await h.pool.query(`SELECT principal_id FROM tenant_memberships WHERE tenant_id=$1 AND role='owner'`, [ctx.tenantId])).rows[0].principal_id;
  assert.equal(operation.actor_principal_id, actor);
  assert.equal(operation.authorization_revision, (await h.pool.query(`SELECT authorization_revision FROM tenants WHERE tenant_id=$1`, [ctx.tenantId])).rows[0].authorization_revision);
  assert.equal(operation.request_digest, digestOf({ operation: 'module.instance.archive', tenant_id: ctx.tenantId, instance_id: ctx.instanceId,
    expected: original.version, body: { reason } }));
  const view = await detail(ctx);
  assert.deepEqual(view.archive, { kind: 'member', operation_id: accepted.data.operation_id, reason, archived_at: operation.accepted_at.toISOString() });
  assert.equal(view.suspension, null);
  assert.deepEqual(view.impact, { consumer_count: 0, blocking_consumer_count: 0, consumers: [], workspace_count: 1, workspace_ids: [ctx.workspaceId] });
  const recorded = await facts(ctx, 'module.instance.archive');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].aggregate_type, 'module_instance_status');
  assert.equal(recorded[0].version, retired.version);
  assert.equal(recorded[0].event_type, 'freedom.module.instance.status_changed.v1');
  const payload = { instance_id: ctx.instanceId, status: 'archived', version: retired.version };
  assert.deepEqual(recorded[0].data, payload);
  assert.deepEqual(recorded[0].payload.data, payload);
  assert.deepEqual((await get(`/tenants/${ctx.tenantId}/operations/${accepted.data.operation_id}`, ctx.owner)).data, accepted.data);
  const afterCapacity = await capacity(ctx);
  assert.deepEqual(afterCapacity, { ...beforeCapacity, usage: 0 });
  const afterReferences = await snapshot(ctx);
  for (const table of ['application_module_links','module_dependencies','workspace_module_bindings']) assert.deepEqual(afterReferences[table], beforeReferences[table]);
  assert.equal((await h.pool.query(`SELECT count(*)::int AS n FROM scoped_transition_journal WHERE operation='module.instance.archive'`)).rows[0].n, 1);
  assert.equal((await h.pool.query(`SELECT count(*)::int AS n FROM scoped_outbox WHERE event_type='freedom.module.instance.status_changed.v1'`)).rows[0].n, 1);
  // DTO state metadata must be present exactly on the corresponding status.
  assert.equal(InstanceDetailSchema.safeParse({ ...view, archive: null }).success, false);
  assert.equal(InstanceDetailSchema.safeParse({ ...view, status: 'active' }).success, false);
  assert.equal(InstanceDetailSchema.safeParse({ ...view, archive: { ...view.archive, forged: true } }).success, false);
});

test('member suspension and failed instances archive; a retired deployment and failed installation are kept', async () => {
  const ctx = await ready();
  assert.equal((await suspend(ctx)).status, 200);
  const suspended = await physical(ctx);
  assert.equal((await archive(ctx)).status, 200);
  const archived = await physical(ctx);
  assert.equal(archived.suspension_operation_id, null);
  assert.equal(archived.binding_state, 'retired');
  assert.equal(archived.binding_version, String(BigInt(suspended.binding_version)+1n));
  assert.equal((await detail(ctx)).suspension, null);
  for (const state of ['active','suspended','retired','pending']) {
    const workspaceId = await h.workspace(ctx.owner, ctx.tenantId, `失敗實例${state}`);
    const enabled = await h.enable(ctx.owner, ctx.tenantId, workspaceId, guild, { kind: 'create_new' });
    assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
    const failed = { ...ctx, workspaceId, instanceId: enabled.data.instance_id };
    await h.pool.query(`UPDATE module_instances SET status='failed' WHERE instance_id=$1`, [failed.instanceId]);
    await h.pool.query(`UPDATE deployment_bindings SET state=$2 WHERE instance_id=$1`, [failed.instanceId, state]);
    await h.pool.query(`UPDATE application_installations SET status='failed' WHERE tenant_id=$1 AND workspace_id=$2`, [ctx.tenantId, workspaceId]);
    const before = await physical(failed), beforeInstallations = await installations(ctx.tenantId);
    assert.equal((await archive(failed)).status, 200);
    assert.equal((await physical(failed)).binding_version, state === 'retired' ? before.binding_version : String(BigInt(before.binding_version)+1n));
    assert.deepEqual(await installations(ctx.tenantId), beforeInstallations);
  }
});

test('only owner archives; admin/operator/viewer, outsiders, foreign targets and flag-off fail closed', async () => {
  const ctx = await ready(), original = await snapshot(ctx);
  for (const role of ['admin','operator','viewer'] as const) {
    const member = await h.person(role);
    await h.accept(member.session, ctx.tenantId, await h.invite(ctx.owner, ctx.tenantId, await h.candidate(ctx.owner, member.id), role));
    const endpoint = `${path(ctx.tenantId, ctx.instanceId)}/archive`;
    const refused = await post(endpoint, member.session, { reason }, '"1"');
    error(refused, 403, 'capability_denied');
    assert.deepEqual((await post(`${path(ctx.tenantId, randomUUID())}/archive`, member.session, { reason }, '"1"')).data, refused.data);
  }
  const outsider = await h.person('外部夥伴');
  const other = await h.createTenant(ctx.owner, '另一業務');
  const unknown = await post(`${path(ctx.tenantId, randomUUID())}/archive`, ctx.owner, { reason }, '"1"');
  error(unknown, 404, 'not_found');
  assert.deepEqual((await post(`${path(other.tenantId, ctx.instanceId)}/archive`, ctx.owner, { reason }, '"1"')).data, unknown.data);
  assert.equal((await post(`${path(ctx.tenantId, ctx.instanceId)}/archive`, outsider.session, { reason }, '"1"')).status, 404);
  assert.equal((await h.post(`${path(ctx.tenantId, ctx.instanceId)}/archive`, ctx.owner, { reason }, '"1"', randomUUID(), h.closed)).status, 404);
  const after = await snapshot(ctx);
  for (const table of ['module_instances','deployment_bindings','application_installations']) assert.deepEqual(after[table], original[table]);
  await h.pool.query(`DELETE FROM positioning_profession_memberships WHERE user_id=$1`, [ctx.owner.user.user_id]);
  assert.equal((await archive(ctx)).status, 200);
});

test('archive replay has one effect, conflicts on reason/version and revalidates ownership', async () => {
  const ctx = await ready(), before = await detail(ctx), key = randomUUID(), endpoint = `${path(ctx.tenantId, ctx.instanceId)}/archive`;
  const first = await archive(ctx, key, before.version);
  assert.equal(first.status, 200);
  const replay = await archive(ctx, key, before.version);
  assert.equal(replay.status, 200); assert.deepEqual(replay.data, first.data);
  assert.equal(replay.response.headers.get('etag'), first.response.headers.get('etag'));
  error(await post(endpoint, ctx.owner, { reason: '另一個封存原因' }, `"${before.version}"`, key), 409, 'idempotency_conflict');
  error(await archive(ctx, key, '999'), 409, 'idempotency_conflict');
  assert.equal(await h.count('module_provision_operations', "WHERE operation_kind='module.instance.archive'"), 1);
  assert.equal((await facts(ctx, 'module.instance.archive')).length, 1);
  const partner = await h.person('接任負責人');
  await h.accept(partner.session, ctx.tenantId, await h.invite(ctx.owner, ctx.tenantId, await h.candidate(ctx.owner, partner.id), 'admin'));
  await h.pool.query(`UPDATE tenant_memberships SET role='owner' WHERE tenant_id=$1 AND principal_id=(SELECT principal_id FROM principals WHERE user_ref=$2)`, [ctx.tenantId, partner.id]);
  await h.pool.query(`UPDATE tenant_memberships SET role='admin',version=version+1 WHERE tenant_id=$1 AND principal_id=(SELECT principal_id FROM principals WHERE user_ref=$2)`, [ctx.tenantId, ctx.owner.user.user_id]);
  error(await archive(ctx, key, before.version), 403, 'capability_denied');
});

test('archive state errors have no effects, preserve platform metadata and respect CAS first', async () => {
  const ctx = await ready();
  async function refused(code: string) {
    const before = await snapshot(ctx);
    error(await archive(ctx), 409, code);
    assert.deepEqual(await snapshot(ctx), before);
  }
  for (const state of ['suspended','retired','pending']) {
    await h.pool.query(`UPDATE deployment_bindings SET state=$2 WHERE instance_id=$1`, [ctx.instanceId, state]);
    await refused('instance_not_archivable');
  }
  await h.pool.query(`UPDATE deployment_bindings SET state='active' WHERE instance_id=$1`, [ctx.instanceId]);
  assert.equal((await suspend(ctx)).status, 200);
  await h.pool.query(`UPDATE deployment_bindings SET state='retired' WHERE instance_id=$1`, [ctx.instanceId]);
  await refused('instance_security_hold');
  await h.pool.query(`UPDATE deployment_bindings SET state='suspended' WHERE instance_id=$1`, [ctx.instanceId]);
  await h.pool.query(`UPDATE module_instances SET suspension_operation_id=NULL WHERE instance_id=$1`, [ctx.instanceId]);
  await refused('instance_security_hold');
  for (const state of ['requested','provisioning']) {
    await h.pool.query(`UPDATE module_instances SET status=$2 WHERE instance_id=$1`, [ctx.instanceId, state]);
    await refused('instance_not_archivable');
  }
  await h.pool.query(`UPDATE module_instances SET status='archived' WHERE instance_id=$1`, [ctx.instanceId]);
  await refused('instance_archived');
  assert.deepEqual((await detail(ctx)).archive, { kind: 'platform', operation_id: null, archived_at: null, reason: null });
  error(await archive(ctx, randomUUID(), '999'), 412, 'version_conflict');
});

test('unfinished launches block archives through both provision steps and reused installation links', async () => {
  const owner = await h.signIn(DEMO_USERS[0].email);
  await h.fullMember(owner.user.user_id, guild);
  const made = await h.createTenant(owner, '未完成啟用');
  await setSyntheticFault(h.pool, 'synthetic-storefront', 'timeout');
  const planned = await h.plan(owner, made.tenantId, h.planBody(guild, made.workspaceId, 'synthetic-storefront', 'synthetic-storefront@1.0.0'));
  assert.equal(planned.status, 201);
  const launched = await h.launch(owner, made.tenantId, planned);
  assert.equal(launched.status, 202, JSON.stringify(launched.data));
  const instances = (await h.pool.query(`SELECT instance_id,module_key FROM module_instances WHERE tenant_id=$1`, [made.tenantId])).rows;
  const inventory = instances.find(row => row.module_key === 'synthetic-inventory')!.instance_id;
  const caller = instances.find(row => row.module_key === 'synthetic-storefront')!.instance_id;
  for (const state of ['requested','provisioning']) {
    await h.pool.query(`UPDATE module_instances SET status=$2 WHERE instance_id=$1`, [caller, state]);
    const ctx = { owner, ...made, instanceId: caller }, before = await snapshot(ctx);
    error(await archive(ctx), 409, 'operation_pending');
    assert.deepEqual(await snapshot(ctx), before);
  }
  const ctx = { owner, ...made, instanceId: inventory }, before = await snapshot(ctx);
  error(await archive(ctx), 409, 'operation_pending');
  assert.deepEqual(await snapshot(ctx), before);
  const op = await get(`/tenants/${ctx.tenantId}/operations/${launched.data.operation_id}`, owner);
  await setSyntheticFault(h.pool, 'synthetic-storefront', null);
  assert.equal((await post(`/tenants/${ctx.tenantId}/operations/${op.data.operation_id}/reconcile`, owner, {}, `"${op.data.version}"`)).status, 202);
  const secondSpace = await h.workspace(owner, ctx.tenantId, '重用啟用');
  await setSyntheticFault(h.pool, 'synthetic-storefront', 'timeout');
  const reusedPlan = await h.plan(owner, ctx.tenantId, h.planBody(guild, secondSpace, 'synthetic-storefront', 'synthetic-storefront@1.0.0', {
    dependencies: [{ requirement_key: 'inventory', choice: 'reuse', instance_id: inventory, expected_version: (await detail(ctx)).version }],
  }));
  assert.equal(reusedPlan.status, 201);
  const reused = await h.launch(owner, ctx.tenantId, reusedPlan);
  assert.equal(reused.status, 202);
  assert.equal(await h.count('module_provision_steps', 'WHERE operation_id=$1 AND instance_id=$2', [reused.data.operation_id, inventory]), 0);
  const linkedBefore = await snapshot(ctx);
  error(await archive(ctx), 409, 'operation_pending');
  assert.deepEqual(await snapshot(ctx), linkedBefore);
});

test('live consumers block provider archive; caller archive retains providers, links and dependencies', async () => {
  const ctx = await ready(true);
  const storefront = (await h.pool.query(`SELECT instance_id FROM module_instances WHERE tenant_id=$1 AND module_key='synthetic-storefront'`, [ctx.tenantId])).rows[0].instance_id;
  const caller = { ...ctx, instanceId: storefront };
  for (const status of ['active','requested','provisioning']) {
    await h.pool.query(`UPDATE module_instances SET status=$2 WHERE instance_id=$1`, [storefront, status]);
    const before = await snapshot(ctx);
    error(await archive(ctx), 409, 'instance_has_consumers');
    assert.deepEqual(await snapshot(ctx), before);
  }
  await h.pool.query(`UPDATE module_instances SET status='active' WHERE instance_id=$1`, [storefront]);
  assert.equal((await suspend(caller)).status, 200);
  const before = await snapshot(ctx), providerBefore = await physical(ctx);
  error(await archive(ctx), 409, 'instance_has_consumers');
  assert.deepEqual(await snapshot(ctx), before);
  assert.equal((await archive(caller)).status, 200);
  assert.deepEqual(await physical(ctx), providerBefore);
  assert.equal((await installations(ctx.tenantId))[0].status, 'archived');
  const after = await snapshot(ctx);
  for (const table of ['application_module_links','module_dependencies','workspace_module_bindings']) assert.deepEqual(after[table], before[table]);
  assert.equal((await detail(ctx)).impact.blocking_consumer_count, 0);
  assert.equal((await archive(ctx)).status, 200);
  assert.equal((await detail(ctx)).impact.consumers[0].status, 'archived');
});

test('a failed consumer does not block provider archive and is retained', async () => {
  const ctx = await ready(true);
  const caller = (await h.pool.query(`SELECT instance_id FROM module_instances WHERE tenant_id=$1 AND module_key='synthetic-storefront'`, [ctx.tenantId])).rows[0].instance_id;
  await h.pool.query(`UPDATE module_instances SET status='failed' WHERE instance_id=$1`, [caller]);
  const before = await physical({ ...ctx, instanceId: caller });
  assert.equal((await archive(ctx)).status, 200);
  assert.deepEqual(await physical({ ...ctx, instanceId: caller }), before);
});

test('a shared work instance archives both installations and keeps both workspaces readable', async () => {
  const ctx = await ready(), workspaceId = await h.workspace(ctx.owner, ctx.tenantId, '共用第二工作區');
  const enabled = await h.enable(ctx.owner, ctx.tenantId, workspaceId, guild,
    { kind: 'reuse', instance_id: ctx.instanceId, expected_version: (await detail(ctx)).version });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
  assert.equal(enabled.data.instance_id, ctx.instanceId);
  const before = await installations(ctx.tenantId);
  assert.equal(before.length, 2);
  const works: { ctx: typeof ctx; workId: string }[] = [];
  for (const workspace of [ctx.workspaceId, workspaceId]) {
    const scoped = { ...ctx, workspaceId: workspace }, work = await createWork(scoped);
    assert.equal(work.status, 201); works.push({ ctx: scoped, workId: work.data.resource_ref.resource_id });
  }
  const bindings = (await snapshot(ctx)).workspace_module_bindings;
  assert.equal((await archive(ctx)).status, 200);
  assert.deepEqual(await installations(ctx.tenantId), before.map(row => ({ ...row, status: 'archived', version: String(BigInt(row.version)+1n) })));
  assert.deepEqual((await snapshot(ctx)).workspace_module_bindings, bindings);
  assert.deepEqual((await detail(ctx)).impact.workspace_ids, [ctx.workspaceId, workspaceId].sort());
  const counts = await workCounts();
  for (const work of works) {
    assert.equal((await get(`/tenants/${ctx.tenantId}/works/${work.workId}`, ctx.owner)).status, 200);
    assert.equal((await get(`/tenants/${ctx.tenantId}/workspaces/${work.ctx.workspaceId}/works`, ctx.owner)).status, 200);
    error(await createWork(work.ctx), 409, 'work_instance_unavailable');
  }
  assert.deepEqual(await workCounts(), counts);
});

test('archive frees active and suspended capacity without capacity locks, reservations or ledger writes', async () => {
  const ctx = await ready();
  await h.pool.query(`UPDATE tenant_capacity_policies SET max_active_instances=1,max_instances_per_module=1`);
  const workspace = await h.workspace(ctx.owner, ctx.tenantId, '新工作區');
  const body = h.planBody(guild, workspace, 'manual-workspace', 'manual-workspace@1.0.0', {
    dependencies: [{ requirement_key: 'work', choice: 'create', configuration: {} }],
  });
  const planned = await h.plan(ctx.owner, ctx.tenantId, body);
  assert.equal(planned.status, 201);
  error(await h.launch(ctx.owner, ctx.tenantId, planned), 429, 'quota_exceeded');
  assert.equal((await suspend(ctx)).status, 200);
  error(await h.launch(ctx.owner, ctx.tenantId, planned), 429, 'quota_exceeded');
  const before = await capacity(ctx);
  const gate = await holder('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`tenant.capacity/v1/${ctx.tenantId}/policy`]);
  try { assert.equal((await archive(ctx)).status, 200); }
  finally { await gate.release(); }
  assert.deepEqual(await capacity(ctx), { ...before, usage: 0 });
  assert.equal((await h.launch(ctx.owner, ctx.tenantId, planned)).status, 200);
  assert.equal((await capacity(ctx)).usage, 1);
});

function fingerprint(ctx: { tenantId: string; workspaceId: string }, application = 'manual-workspace') {
  return `module-registry/installation/v1/${ctx.tenantId}/${ctx.workspaceId}/${application}`;
}

test('a new installation linked after the archive snapshot yields instance_changed; retry covers both', { timeout: 30_000 }, async () => {
  const ctx = await ready(), current = await detail(ctx);
  const workspace = await h.workspace(ctx.owner, ctx.tenantId, '競態新入口');
  const plan = await h.plan(ctx.owner, ctx.tenantId, h.planBody(guild, workspace, 'manual-workspace', 'manual-workspace@1.0.0', {
    dependencies: [{ requirement_key: 'work', choice: 'reuse', instance_id: ctx.instanceId, expected_version: current.version }],
  }));
  assert.equal(plan.status, 201);
  const gate = await holder('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [fingerprint(ctx)]);
  let archiving: Promise<Reply> | undefined;
  try {
    archiving = archive(ctx, randomUUID(), current.version);
    await waitBlocked(gate.pid, ['pg_advisory_xact_lock']);
    const launched = await h.launch(ctx.owner, ctx.tenantId, plan);
    assert.equal(launched.status, 200, JSON.stringify(launched.data));
    const afterLaunch = await snapshot(ctx);
    await gate.commit();
    error(await archiving, 409, 'instance_changed');
    assert.deepEqual(await snapshot(ctx), afterLaunch);
    assert.equal((await archive(ctx)).status, 200);
    const rows = await installations(ctx.tenantId);
    assert.equal(rows.length, 2); assert.ok(rows.every(row => row.status === 'archived'));
  } finally { await gate.release(); await Promise.allSettled([archiving].filter(Boolean) as Promise<Reply>[]); }
});

for (const first of ['launch','archive'] as const) {
  test(`reuse_existing launch versus archive: ${first} takes the fingerprint first`, { timeout: 30_000 }, async () => {
    const ctx = await ready(), current = await detail(ctx), physicalBefore = await physical(ctx);
    const installation = (await installations(ctx.tenantId))[0];
    const plan = await h.plan(ctx.owner, ctx.tenantId, h.planBody(guild, ctx.workspaceId, 'manual-workspace', 'manual-workspace@1.0.0', {
      installation_choice: 'reuse_existing', existing_installation_id: installation.installation_id,
    }));
    assert.equal(plan.status, 201, JSON.stringify(plan.data));
    const gate = first === 'launch'
      ? await holder(`SELECT membership_id FROM positioning_profession_memberships WHERE user_id=$1 AND guild_key=$2 FOR UPDATE`, [ctx.owner.user.user_id, guild])
      : await holder(`SELECT binding_id FROM deployment_bindings WHERE binding_id=$1 FOR SHARE`, [physicalBefore.binding_id]);
    let archiving: Promise<Reply> | undefined, launching: Promise<Reply> | undefined;
    const launchKey = randomUUID(), opCount = await h.count('module_provision_operations');
    try {
      if (first === 'launch') {
        launching = h.launch(ctx.owner, ctx.tenantId, plan, launchKey);
        const blocked = await waitBlocked(gate.pid, ['positioning_profession_memberships','FOR SHARE']);
        archiving = archive(ctx, randomUUID(), current.version);
        await waitBlocked(blocked.pid, ['pg_advisory_xact_lock']);
      } else {
        archiving = archive(ctx, randomUUID(), current.version);
        const blocked = await waitBlocked(gate.pid, ['deployment_bindings','FOR NO KEY UPDATE']);
        launching = h.launch(ctx.owner, ctx.tenantId, plan, launchKey);
        await waitBlocked(blocked.pid, ['pg_advisory_xact_lock']);
      }
      await gate.commit();
      const [archived, launched] = await Promise.all([archiving!, launching!]);
      assert.equal(archived.status, 200, JSON.stringify(archived.data));
      if (first === 'launch') assert.equal(launched.status, 200, JSON.stringify(launched.data));
      else {
        error(launched, 409, 'plan_stale');
        assert.equal(await h.count('scoped_command_receipts', 'WHERE idempotency_key=$1', [launchKey]), 0);
        assert.equal(await h.count('module_launch_plan_consumptions', 'WHERE plan_id=$1', [plan.data.plan_id]), 0);
      }
      assert.equal(await h.count('module_provision_operations'), opCount + (first === 'launch' ? 2 : 1));
      assert.deepEqual(await installations(ctx.tenantId), [{ ...installation, status: 'archived', version: String(BigInt(installation.version)+1n) }]);
    } finally { await gate.release(); await Promise.allSettled([archiving, launching].filter(Boolean) as Promise<Reply>[]); }
  });
}

for (const first of ['suspend','archive'] as const) {
  test(`suspend versus archive: ${first} wins and the instance-lock loser is stale`, { timeout: 30_000 }, async () => {
    const ctx = await ready(), original = await physical(ctx);
    const gate = await holder(`SELECT binding_id FROM deployment_bindings WHERE binding_id=$1 FOR SHARE`, [original.binding_id]);
    let winner: Promise<Reply> | undefined, loser: Promise<Reply> | undefined;
    const loserKey = randomUUID();
    try {
      winner = (first === 'suspend' ? suspend : archive)(ctx, randomUUID(), original.version);
      const blocked = await waitBlocked(gate.pid, ['deployment_bindings','FOR NO KEY UPDATE']);
      loser = (first === 'suspend' ? archive : suspend)(ctx, loserKey, original.version);
      await waitBlocked(blocked.pid, ['module_instances','FOR NO KEY UPDATE']);
      await gate.commit();
      const [won, lost] = await Promise.all([winner, loser]);
      assert.equal(won.status, 200, JSON.stringify(won.data));
      error(lost, 412, 'version_conflict');
      assert.equal((await detail(ctx)).status, first === 'suspend' ? 'suspended' : 'archived');
      assert.equal(await h.count('scoped_command_receipts', 'WHERE idempotency_key=$1', [loserKey]), 0);
      assert.equal((await facts(ctx, `module.instance.${first}`)).length, 1);
      assert.equal((await facts(ctx, `module.instance.${first === 'suspend' ? 'archive' : 'suspend'}`)).length, 0);
    } finally { await gate.release(); await Promise.allSettled([winner, loser].filter(Boolean) as Promise<Reply>[]); }
  });
}

test('restricted runtime role archives and a max-1 pool alternating tenants exposes only the current tenant', async () => {
  const first = await ready();
  const person = await h.person('受限角色乙');
  await h.fullMember(person.id, guild);
  const secondSpace = await h.createTenant(person.session, '受限角色業務乙');
  const enabled = await h.enable(person.session, secondSpace.tenantId, secondSpace.workspaceId, guild);
  assert.equal(enabled.status, 200);
  const second = { owner: person.session, ...secondSpace, instanceId: enabled.data.instance_id as string };
  const role = `fp_archive_runtime_${process.pid}_${Date.now()}`;
  await h.admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`);
  let runtime: Pool | undefined;
  try {
    await h.admin.query(`GRANT USAGE ON SCHEMA ${h.schema} TO ${role}`);
    const template = await readFile(new URL('../../deploy/cloudflare/sql/20-runtime-grants.psql', import.meta.url), 'utf8');
    const general = template.slice(template.indexOf('BEGIN;'), template.indexOf('-- BEGIN PRIVATE POLICY GRANTS'))
      .replaceAll('SCHEMA public', `SCHEMA ${h.schema}`).replaceAll(':"runtime"', `"${role}"`);
    const grantClient = await h.pool.connect();
    try {
      await grantClient.query(general);
      for (const section of ['TENANT CAPACITY POLICY', 'TENANT AUTHORITY POLICY', 'MODULE REGISTRY DEFINITION']) {
        const query = template.split(`-- BEGIN ${section} GRANTS\n`)[1].split('\n\\gexec')[0]
          .replaceAll(":'runtime'", `'${role}'`).replaceAll("n.nspname='public'", `n.nspname='${h.schema}'`);
        const statements = (await grantClient.query(query)).rows;
        assert.ok(statements.length > 0);
        for (const statement of statements) await grantClient.query(Object.values(statement)[0] as string);
      }
      await grantClient.query('COMMIT');
    } finally { await grantClient.query('ROLLBACK'); grantClient.release(); }
    const url = new URL(process.env.TEST_DATABASE_URL!); url.username = role; url.password = '';
    runtime = new Pool({ connectionString: url.toString(), options: `-c search_path=${h.schema}`, max: 1 });
    const runtimeApp = createApp(runtime, h.origin, 'local', { guildLaunchpadEnabled: true });
    const authority = (await runtime.query(`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`)).rows[0];
    assert.deepEqual(authority, { rolsuper: false, rolbypassrls: false });
    assert.equal((await runtime.query(`SELECT relrowsecurity AND relowner <> (SELECT oid FROM pg_roles WHERE rolname=current_user) AS restricted
      FROM pg_class WHERE oid='module_instances'::regclass`)).rows[0].restricted, true);
    const operations = [];
    for (const ctx of [first, second]) {
      const view = await detail(ctx);
      const archived = await h.post(`${path(ctx.tenantId, ctx.instanceId)}/archive`, ctx.owner, { reason }, `"${view.version}"`, randomUUID(), runtimeApp);
      assert.equal(archived.status, 200, JSON.stringify(archived.data)); operations.push(archived.data.operation_id);
    }
    for (const [ctx, foreign, operation, foreignOperation] of [
      [first, second, operations[0], operations[1]], [second, first, operations[1], operations[0]], [first, second, operations[0], operations[1]],
    ] as const) {
      const own = await h.call('GET', path(ctx.tenantId, ctx.instanceId), ctx.owner, undefined, {}, runtimeApp);
      assert.equal(own.status, 200); const body = InstanceDetailSchema.parse(own.data);
      assert.equal(body.archive?.operation_id, operation);
      assert.equal((await h.call('GET', path(ctx.tenantId, foreign.instanceId), ctx.owner, undefined, {}, runtimeApp)).status, 404);
      assert.equal((await h.call('GET', `/tenants/${ctx.tenantId}/operations/${foreignOperation}`, ctx.owner, undefined, {}, runtimeApp)).status, 404);
      assert.equal((await h.post(`${path(ctx.tenantId, foreign.instanceId)}/archive`, ctx.owner, { reason }, '"1"', randomUUID(), runtimeApp)).status, 404);
      assert.equal((await h.post(`${path(foreign.tenantId, foreign.instanceId)}/archive`, ctx.owner, { reason }, '"1"', randomUUID(), runtimeApp)).status, 404);
      const q: PoolClient = await runtime.connect();
      try {
        await q.query('BEGIN');
        const scope = (await h.pool.query(`SELECT scope_id FROM resource_scopes WHERE tenant_ref=$1 AND kind='tenant'`, [ctx.tenantId])).rows[0].scope_id;
        await bindTenantContext(q, { tenantId: ctx.tenantId, tenantScopeId: scope });
        assert.deepEqual((await q.query(`SELECT tenant_id,archive_operation_id FROM module_instances`)).rows,
          [{ tenant_id: ctx.tenantId, archive_operation_id: operation }]);
        assert.deepEqual((await q.query(`SELECT operation_id FROM module_provision_operations WHERE operation_kind='module.instance.archive'`)).rows,
          [{ operation_id: operation }]);
        await q.query('COMMIT');
      } finally { await q.query('ROLLBACK'); q.release(); }
      const quiet: { tenant: string | null; instances: number; operations: number } = (await runtime.query(`SELECT current_setting('freedom.tenant_id',true) AS tenant,
        (SELECT count(*)::int FROM module_instances) AS instances,(SELECT count(*)::int FROM module_provision_operations) AS operations`)).rows[0];
      assert.ok(quiet.tenant === '' || quiet.tenant == null); assert.equal(quiet.instances, 0); assert.equal(quiet.operations, 0);
    }
  } finally {
    await runtime?.end();
    await h.admin.query(`DROP OWNED BY ${role}`);
    await h.admin.query(`DROP ROLE ${role}`);
  }
});


test('workspace binding reports unbound, active, suspended and inactive current deployment independently of connections', async () => {
  const ctx = await ready();
  const read = async (workspace = ctx.workspaceId, query = '') => {
    const reply = await get(`/tenants/${ctx.tenantId}/workspaces/${workspace}/module-binding${query}`, ctx.owner);
    assert.equal(reply.status, 200, JSON.stringify(reply.data));
    assert.deepEqual(Object.keys(reply.data).sort(), ['binding', 'tenant_id', 'workspace_id']);
    assert.equal(reply.data.tenant_id, ctx.tenantId);
    assert.equal(reply.data.workspace_id, workspace);
    assert.equal(reply.response.headers.get('cache-control'), 'private, no-store');
    assert.equal(reply.response.headers.get('vary'), 'Cookie');
    return reply.data;
  };
  const expected = (status: string, writable: boolean) => ({ entry_capability: 'work:create', instance_id: ctx.instanceId, instance_status: status, writable });
  const unbound = await h.workspace(ctx.owner, ctx.tenantId, '未綁定工作區');
  assert.equal((await read(unbound)).binding, null);
  assert.deepEqual((await read()).binding, expected('active', true));
  // Like instance detail and operation reads, this route does not parse query strings.
  assert.deepEqual((await read(ctx.workspaceId, '?tenant_id=ignored&unknown=one&unknown=two')).binding, expected('active', true));
  await h.pool.query(`UPDATE deployment_bindings SET state='suspended' WHERE instance_id=$1`, [ctx.instanceId]);
  assert.deepEqual((await read()).binding, expected('active', false));
  await h.pool.query(`UPDATE deployment_bindings SET state='active' WHERE instance_id=$1`, [ctx.instanceId]);
  assert.equal((await suspend(ctx)).status, 200);
  assert.deepEqual((await read()).binding, expected('suspended', false));
  const context = await get(`/tenants/${ctx.tenantId}/workspaces/${ctx.workspaceId}/launchpad-context?guild_key=${guild}`, ctx.owner);
  assert.equal(context.status, 200);
  assert.deepEqual(context.data.connection_summary, []);
  assert.equal((await archive(ctx)).status, 200);
  assert.deepEqual((await read()).binding, expected('archived', false));
});

test('module binding checks workspace availability, tenant isolation, ids and the release flag', async () => {
  const ctx = await ready();
  const endpoint = (tenant = ctx.tenantId, workspace = ctx.workspaceId) => `/tenants/${tenant}/workspaces/${workspace}/module-binding`;
  error(await get(endpoint(ctx.tenantId, randomUUID()), ctx.owner), 404, 'not_found');
  const other = await h.person('另一位業務擁有者');
  const foreign = await h.createTenant(other.session, '另一個業務');
  error(await get(endpoint(ctx.tenantId, foreign.workspaceId), ctx.owner), 404, 'not_found');
  const denied = await get(endpoint(foreign.tenantId, foreign.workspaceId), ctx.owner);
  const oldDenied = await get(`/tenants/${foreign.tenantId}/workspaces/${foreign.workspaceId}/launchpad-context?guild_key=${guild}`, ctx.owner);
  assert.equal(denied.status, oldDenied.status);
  assert.equal(denied.data.code, oldDenied.data.code);
  assert.equal(denied.status, 404);
  error(await get(endpoint(ctx.tenantId, 'bad-id'), ctx.owner), 422, 'validation_failed');
  const closed = await h.call('GET', endpoint(), ctx.owner, undefined, {}, h.closed);
  assert.equal(closed.status, 404);
  const missing = await h.call('GET', '/unknown-module-binding', ctx.owner, undefined, {}, h.closed);
  assert.deepEqual(closed.data, missing.data);
  await h.pool.query(`UPDATE workspaces SET status='archived' WHERE tenant_id=$1 AND workspace_id=$2`, [ctx.tenantId, ctx.workspaceId]);
  error(await get(endpoint(), ctx.owner), 409, 'workspace_unavailable');
});

test('module binding checks session expiry after its final binding query', async () => {
  const ctx = await ready();
  const actor = await authenticate(h.pool, ctx.owner.cookie.split('=')[1]);
  let expired = false;
  // A controlled SQL deadline change at the query boundary avoids wall-clock sleeps.
  const controlled = new Proxy(h.pool, { get(target, property) {
    if (property !== 'connect') { const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value; }
    return async () => {
      const q = await target.connect();
      return new Proxy(q, { get(client, key) {
        if (key !== 'query') { const value = Reflect.get(client, key, client); return typeof value === 'function' ? value.bind(client) : value; }
        return async (sql: string, params?: unknown[]) => {
          const result = await client.query(sql, params);
          if (sql.includes('FROM workspace_module_bindings w') && !expired) {
            await client.query(`UPDATE sessions SET expires_at='2000-01-01T00:00:00Z' WHERE token_hash=$1`, [actor.session_hash]);
            expired = true;
          }
          return result;
        };
      } });
    };
  } });
  const target = createApp(controlled, h.origin, 'local', { guildLaunchpadEnabled: true });
  const reply = await h.call('GET', `/tenants/${ctx.tenantId}/workspaces/${ctx.workspaceId}/module-binding`, ctx.owner, undefined, {}, target);
  error(reply, 401, 'session_expired');
  assert.equal(expired, true);
  assert.equal(reply.response.headers.get('cache-control'), 'private, no-store');
  assert.equal(reply.response.headers.get('vary'), 'Cookie');
});

for (const refused of ['plan', 'launch'] as const) {
test(`async relaunch ${refused} refuses conflicting entry before plan or launch writes, including a pre-archive plan`, async () => {
  const owner = await h.signIn(DEMO_USERS[0].email);
  await h.fullMember(owner.user.user_id, guild);
  const made = await h.createTenant(owner, '重啟入口');
  const body = h.planBody(guild, made.workspaceId, 'synthetic-storefront', 'synthetic-storefront@1.0.0');
  const early = await h.plan(owner, made.tenantId, body);
  const first = await h.plan(owner, made.tenantId, body);
  assert.equal(early.status, 201); assert.equal(first.status, 201);
  assert.equal((await h.launch(owner, made.tenantId, first)).status, 200);
  const instanceId = (await h.pool.query(`SELECT instance_id FROM workspace_module_bindings WHERE tenant_id=$1 AND workspace_id=$2`, [made.tenantId, made.workspaceId])).rows[0].instance_id;
  const ctx = { owner, ...made, instanceId };
  assert.equal((await archive(ctx)).status, 200);
  const before = await snapshot(ctx), plans = await h.count('module_launch_plans');
  if (refused === 'plan') error(await h.plan(owner, made.tenantId, body), 409, 'workspace_binding_conflict');
  assert.equal(await h.count('module_launch_plans'), plans);
  assert.deepEqual(await snapshot(ctx), before);
  if (refused === 'launch') error(await h.launch(owner, made.tenantId, early), 409, 'workspace_binding_conflict');
  assert.deepEqual(await snapshot(ctx), before);
  assert.equal(await h.count('module_launch_plan_consumptions', 'WHERE plan_id=$1', [early.data.plan_id]), 0);
});

}

test('reusing the entry-bound instance itself succeeds without new capacity rows', async () => {
  const ctx = await ready();
  await h.pool.query(`UPDATE application_installations SET status='archived' WHERE tenant_id=$1`, [ctx.tenantId]);
  const before = await capacity(ctx);
  const plan = await h.plan(ctx.owner, ctx.tenantId, h.planBody(guild, ctx.workspaceId, 'manual-workspace', 'manual-workspace@1.0.0', {
    dependencies: [{ requirement_key: 'work', choice: 'reuse', instance_id: ctx.instanceId, expected_version: (await detail(ctx)).version }],
  }));
  assert.equal(plan.status, 201, JSON.stringify(plan.data));
  assert.equal((await h.launch(ctx.owner, ctx.tenantId, plan)).status, 200);
  const after = await capacity(ctx);
  assert.equal(after.usage, before.usage);
  assert.equal(after.reservations.filter((r: any) => r.dimension.startsWith('module_instances')).length,
    before.reservations.filter((r: any) => r.dimension.startsWith('module_instances')).length);
});

async function duplicateDependencies(ctx: Awaited<ReturnType<typeof ready>>, count: number) {
  await h.pool.query(`INSERT INTO module_dependencies(dependency_id,tenant_id,caller_instance_id,requirement_key,provider_instance_id,capability)
    SELECT gen_random_uuid(),d.tenant_id,d.caller_instance_id,d.requirement_key,d.provider_instance_id,d.capability
    FROM module_dependencies d CROSS JOIN generate_series(1,$2) WHERE d.tenant_id=$1 LIMIT $2`, [ctx.tenantId, count]);
}

test('impact counts only blocking consumers while retaining archived and failed references', async () => {
  const ctx = await ready(true);
  const caller = (await h.pool.query(`SELECT caller_instance_id FROM module_dependencies WHERE tenant_id=$1`, [ctx.tenantId])).rows[0].caller_instance_id;
  for (const status of ['archived', 'failed']) {
    await h.pool.query(`UPDATE module_instances SET status=$2 WHERE instance_id=$1`, [caller, status]);
    const view = await detail(ctx);
    assert.equal(view.impact.consumer_count, 1);
    assert.equal(view.impact.blocking_consumer_count, 0);
  }
  assert.equal((await archive(ctx)).status, 200);
});

test('impact puts a live caller before more than fifty nonblocking dependency rows', async () => {
  const ctx = await ready(true);
  const live = (await h.pool.query(`SELECT caller_instance_id FROM module_dependencies WHERE tenant_id=$1`, [ctx.tenantId])).rows[0].caller_instance_id;
  const oldCaller = '00000000-0000-4000-8000-000000000001', bindingId = randomUUID();
  const q = await h.pool.connect();
  try {
    await q.query('BEGIN');
    await q.query(`INSERT INTO module_instances(instance_id,tenant_id,module_key,application_release_ref,module_release_ref,data_schema_version,contract_ref,status,binding_id,created_by_principal_id,origin_guild_key)
      SELECT $2,tenant_id,module_key,application_release_ref,module_release_ref,data_schema_version,contract_ref,'archived',$3,created_by_principal_id,origin_guild_key
      FROM module_instances WHERE instance_id=$1`, [live, oldCaller, bindingId]);
    await q.query(`INSERT INTO deployment_bindings(binding_id,tenant_id,instance_id,mode,environment,contract_ref,state)
      SELECT $2,tenant_id,$3,mode,environment,contract_ref,'retired' FROM deployment_bindings WHERE instance_id=$1`, [live, bindingId, oldCaller]);
    await q.query(`INSERT INTO module_dependencies(dependency_id,tenant_id,caller_instance_id,requirement_key,provider_instance_id,capability)
      SELECT gen_random_uuid(),d.tenant_id,$2,d.requirement_key,d.provider_instance_id,d.capability
      FROM module_dependencies d CROSS JOIN generate_series(1,51) WHERE d.tenant_id=$1`, [ctx.tenantId, oldCaller]);
    await q.query('COMMIT');
  } finally { await q.query('ROLLBACK'); q.release(); }
  const view = await detail(ctx);
  assert.equal(view.impact.consumer_count, 52);
  assert.equal(view.impact.blocking_consumer_count, 1);
  assert.equal(view.impact.consumers.length, 50);
  assert.equal(view.impact.consumers[0].caller_instance_id, live);
  error(await archive(ctx), 409, 'instance_has_consumers');
});

test('instance detail bounds fifty-one dependencies deterministically instead of returning 500', async () => {
  const ctx = await ready(true);
  await duplicateDependencies(ctx, 50);
  const caller = (await h.pool.query(`SELECT caller_instance_id FROM module_dependencies WHERE tenant_id=$1`, [ctx.tenantId])).rows[0].caller_instance_id;
  const first = await detail({ ...ctx, instanceId: caller });
  assert.equal(first.dependencies.length, 50);
  assert.deepEqual((await detail({ ...ctx, instanceId: caller })).dependencies, first.dependencies);
});

for (const mode of ['cancel', 'compensation'] as const) {
  test(`${mode}-archived instance identifies its launch operation`, async () => {
    const owner = await h.signIn(DEMO_USERS[0].email);
    await h.fullMember(owner.user.user_id, guild);
    const made = await h.createTenant(owner, '啟用封存來源');
    const plan = await h.plan(owner, made.tenantId, h.planBody(guild, made.workspaceId, 'synthetic-storefront', 'synthetic-storefront@1.0.0'));
    let operationId: string;
    if (mode === 'cancel') {
      const actor = await authenticate(h.pool, owner.cookie.split('=')[1]);
      const launched = await launchApplication(h.pool, actor, made.tenantId, {
        plan_id: plan.data.plan_id, expected_plan_version: plan.data.version, configuration_digest: plan.data.configuration_digest,
      }, randomUUID(), h.providers);
      operationId = launched.operation_id;
      const op = await get(`/tenants/${made.tenantId}/operations/${operationId}`, owner);
      const cancelled = await post(`/tenants/${made.tenantId}/operations/${operationId}/cancel`, owner, { reason: 'member_cancelled' }, `"${op.data.version}"`);
      assert.equal(cancelled.status, 200); assert.equal(cancelled.data.state, 'cancelled');
    } else {
      await setSyntheticFault(h.pool, 'synthetic-storefront', 'fail_known');
      const launched = await h.launch(owner, made.tenantId, plan);
      operationId = launched.data.operation_id;
      assert.equal(launched.data.state, 'failed');
    }
    const archived = (await h.pool.query(`SELECT instance_id FROM module_instances WHERE tenant_id=$1 AND status='archived'`, [made.tenantId])).rows;
    assert.equal(archived.length, 2);
    for (const row of archived) {
      const view = await detail({ owner, ...made, instanceId: row.instance_id });
      assert.deepEqual(view.archive, { kind: 'launch', operation_id: operationId, archived_at: null, reason: null });
    }
  });
}

test('SQL archive with no cleanup operation remains a platform archive', async () => {
  const ctx = await ready();
  await h.pool.query(`UPDATE module_instances SET status='archived' WHERE instance_id=$1`, [ctx.instanceId]);
  assert.deepEqual((await detail(ctx)).archive, { kind: 'platform', operation_id: null, archived_at: null, reason: null });
});


test('plan refuses a different reused entry instance in an archived bound workspace', async () => {
  const ctx = await ready();
  assert.equal((await archive(ctx)).status, 200);
  const ws = await h.workspace(ctx.owner, ctx.tenantId, '其他綁定');
  const enabled = await h.enable(ctx.owner, ctx.tenantId, ws, guild, { kind: 'create_new' });
  assert.equal(enabled.status, 200);
  const before = await snapshot(ctx), plans = await h.count('module_launch_plans');
  error(await h.plan(ctx.owner, ctx.tenantId, h.planBody(guild, ctx.workspaceId, 'manual-workspace', 'manual-workspace@1.0.0', {
    dependencies: [{ requirement_key: 'work', choice: 'reuse', instance_id: enabled.data.instance_id, expected_version: enabled.data.version }],
  })), 409, 'workspace_binding_conflict');
  assert.equal(await h.count('module_launch_plans'), plans);
  assert.deepEqual(await snapshot(ctx), before);
});
