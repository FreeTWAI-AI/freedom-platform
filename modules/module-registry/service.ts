import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { OpaqueId } from '../../contracts/common/v1/identity.js';
import {
  EnableManualWorkSchema, InstanceCandidateSchema, LaunchpadContextSchema, ManualWorkBindingSchema,
  ModuleInstancePageSchema, ModuleInstanceViewSchema,
  type InstanceCandidate, type ManualWorkBinding, type ModuleInstanceView,
} from '../../contracts/guild-launchpad/v1/tenant-work.js';
import type { Actor } from '../identity-membership/service.js';
import { requireTenantCapability, tenantWorkCapabilities } from '../opportunity-project-work/tenant-capabilities.js';
import { lockCapacityPolicy, lockDimension, rejectAtLimit, requirePolicy, capacitySummary } from '../opportunity-project-work/tenant-capacity.js';
import { scopedJournal, scopedTenantCommand } from '../../packages/scoped-commands/index.js';
import { transaction } from '../../packages/db/index.js';
import { assertCurrentSessionClock } from '../../packages/db/member-session.js';
import { lockTenantScope, type TenantScopeContext } from '../../packages/resource-scopes/index.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import { InstanceSelectionRequired } from './problems.js';

const RELEASE = 'manual-workspace@1.0.0';
const SCHEMA_VERSION = '1';

function encodeCursor(at: string, id: string) {
  return Buffer.from(`${at}\n${id}`).toString('base64url');
}
function decodeCursor(raw?: string): { at: string; id: string } | null {
  if (!raw) return null;
  let text = '';
  try { text = Buffer.from(raw, 'base64url').toString('utf8'); } catch { throw new Problem(422, 'invalid_cursor', '分頁游標無效。'); }
  const split = text.indexOf('\n');
  if (split < 1) throw new Problem(422, 'invalid_cursor', '分頁游標無效。');
  const at = text.slice(0, split), id = text.slice(split + 1);
  if (!OpaqueId.safeParse(id).success || Number.isNaN(Date.parse(at))) throw new Problem(422, 'invalid_cursor', '分頁游標無效。');
  return { at, id };
}

async function guildGate(q: PoolClient, context: TenantScopeContext, actor: Actor, guildKey: string) {
  const catalog = await q.query('SELECT guild_key FROM positioning_guild_catalog WHERE guild_key=$1', [guildKey]);
  requireCondition(catalog.rowCount === 1, 404, 'guild_not_found', '找不到這個公會。');
  const member = await q.query(`SELECT 1 FROM positioning_profession_memberships
    WHERE community_id=$1 AND user_id=$2 AND guild_key=$3 AND state='active' AND member_tier='full'`,
  [context.community_id, actor.user_id, guildKey]);
  requireCondition(member.rowCount === 1, 403, 'guild_full_member_required', '需要這個公會的正式會員身分。');
}

/** After the workspace and policy waits. Do not take this share before those waits. */
async function lockGuildFullMember(q: PoolClient, context: TenantScopeContext, actor: Actor, guildKey: string) {
  const member = await q.query(`SELECT 1 FROM positioning_profession_memberships
    WHERE community_id=$1 AND user_id=$2 AND guild_key=$3 AND state='active' AND member_tier='full' FOR SHARE`,
  [context.community_id, actor.user_id, guildKey]);
  requireCondition(member.rowCount === 1, 403, 'guild_full_member_required', '需要這個公會的正式會員身分。');
}

async function lockActiveWorkInstance(q: PoolClient, tenantId: string, instanceId: string) {
  const picked = (await q.query<{ status: string; module_key: string }>(
    `SELECT status, module_key FROM module_instances WHERE tenant_id=$1 AND instance_id=$2 FOR SHARE`,
    [tenantId, instanceId])).rows[0];
  requireCondition(picked && picked.status === 'active' && picked.module_key === 'work', 404, 'not_found', '找不到這個模組實例。');
}

async function lockWorkspace(q: PoolClient, tenantId: string, workspaceId: string) {
  const row = (await q.query<{ workspace_id: string; status: string; version: string }>(
    `SELECT workspace_id, status, version::text AS version FROM workspaces WHERE tenant_id=$1 AND workspace_id=$2 FOR UPDATE`,
  [tenantId, workspaceId])).rows[0];
  requireCondition(row, 404, 'not_found', '找不到這個工作區。');
  requireCondition(row.status === 'active', 409, 'workspace_unavailable', '這個工作區目前無法使用。');
  return row;
}

async function candidates(q: PoolClient, tenantId: string): Promise<InstanceCandidate[]> {
  const rows = (await q.query<{ instance_id: string; version: string; created_at: Date; bound_workspace_count: number }>(
    `SELECT i.instance_id, i.version::text AS version, i.created_at,
       (SELECT count(*)::int FROM workspace_module_bindings b WHERE b.tenant_id=i.tenant_id AND b.instance_id=i.instance_id) AS bound_workspace_count
     FROM module_instances i
     WHERE i.tenant_id=$1 AND i.module_key='work' AND i.status='active'
     ORDER BY i.created_at, i.instance_id`, [tenantId])).rows;
  return rows.map(row => InstanceCandidateSchema.parse({
    instance_id: row.instance_id, version: row.version, created_at: row.created_at.toISOString(),
    bound_workspace_count: row.bound_workspace_count,
  }));
}

async function bindingOf(q: PoolClient, tenantId: string, workspaceId: string) {
  return (await q.query<{ instance_id: string; version: string; binding_id: string }>(
    `SELECT w.instance_id, w.version::text AS version, i.binding_id
     FROM workspace_module_bindings w
     JOIN module_instances i ON i.tenant_id=w.tenant_id AND i.instance_id=w.instance_id
     WHERE w.tenant_id=$1 AND w.workspace_id=$2 AND w.entry_capability='work:create'`,
  [tenantId, workspaceId])).rows[0] ?? null;
}

function bindingView(tenantId: string, workspaceId: string, row: { instance_id: string; version: string; binding_id: string }, reused: boolean): ManualWorkBinding {
  return ManualWorkBindingSchema.parse({
    instance_id: row.instance_id, tenant_id: tenantId, workspace_id: workspaceId, binding_id: row.binding_id,
    version: row.version, entry_capability: 'work:create', reused,
  });
}

async function instanceView(q: PoolClient, tenantId: string, instanceId: string): Promise<ModuleInstanceView> {
  const row = (await q.query<{
    instance_id: string; tenant_id: string; module_key: string; application_release_ref: string; data_schema_version: string;
    status: ModuleInstanceView['status']; binding_id: string; authority_epoch: string; version: string; configuration_revision: string;
  }>(`SELECT instance_id, tenant_id, module_key, application_release_ref, data_schema_version, status, binding_id,
       authority_epoch::text, version::text, configuration_revision::text
     FROM module_instances WHERE tenant_id=$1 AND instance_id=$2`, [tenantId, instanceId])).rows[0];
  requireCondition(row, 404, 'not_found', '找不到這個模組實例。');
  return ModuleInstanceViewSchema.parse(row);
}

/** Enable is idempotent for an existing work:create binding. A reuse choice that names another instance is a rebind and is refused. */
export async function enableManualWork(pool: Pool, actor: Actor, tenantId: string, workspaceId: string, body: unknown, key: string) {
  OpaqueId.parse(tenantId); OpaqueId.parse(workspaceId);
  const input = EnableManualWorkSchema.parse(body);
  return scopedTenantCommand(pool, {
    actor, tenantId, operation: 'manual.work.enable', key, tenantLock: 'share', body: input,
    target: { kind: 'tenant_workspace', id: workspaceId }, capabilitiesForRole: tenantWorkCapabilities,
  }, async (q, context) => {
    requireTenantCapability(context, 'instance.manage', true);
    await guildGate(q, context, actor, input.guild_key);
    await lockWorkspace(q, tenantId, workspaceId);
    if (input.choice?.kind === 'reuse') await lockActiveWorkInstance(q, tenantId, input.choice.instance_id);
    requirePolicy(await lockCapacityPolicy(q, tenantId));
    await lockGuildFullMember(q, context, actor, input.guild_key);
  }, async (q, context) => {
    const existing = await bindingOf(q, tenantId, workspaceId);
    if (existing) {
      if (input.choice?.kind === 'reuse' && input.choice.instance_id !== existing.instance_id) {
        throw new Problem(409, 'workspace_binding_conflict', '這個工作區已經綁定另一個工作實例。');
      }
      // The binding is unchanged, so its version is already journaled. A second fact at that version would violate the journal identity.
      return bindingView(tenantId, workspaceId, existing, true);
    }
    const options = await candidates(q, tenantId);
    if (!input.choice && options.length > 0) throw new InstanceSelectionRequired(options);
    let instanceId: string;
    let deploymentId: string;
    if (input.choice?.kind === 'reuse') {
      const picked = (await q.query<{ instance_id: string; version: string; status: string; module_key: string; binding_id: string }>(
        `SELECT instance_id, version::text AS version, status, module_key, binding_id FROM module_instances
         WHERE tenant_id=$1 AND instance_id=$2`, [tenantId, input.choice.instance_id])).rows[0];
      requireCondition(picked && picked.status === 'active' && picked.module_key === 'work', 404, 'not_found', '找不到這個模組實例。');
      requireCondition(picked.version === input.choice.expected_version, 412, 'version_conflict', '模組實例版本已改變。');
      instanceId = picked.instance_id;
      deploymentId = picked.binding_id;
    } else {
      await lockDimension(q, tenantId, 'instances');
      const policy = requirePolicy(await lockCapacityPolicy(q, tenantId));
      requireCondition(policy.max_concurrent_provisions > 0, 429, 'quota_exceeded', '已達到這個業務空間的容量上限。');
      const active = (await q.query<{ n: string }>(`SELECT count(*)::text AS n FROM module_instances WHERE tenant_id=$1 AND status='active'`, [tenantId])).rows[0].n;
      const perModule = (await q.query<{ n: string }>(`SELECT count(*)::text AS n FROM module_instances WHERE tenant_id=$1 AND status='active' AND module_key='work'`, [tenantId])).rows[0].n;
      rejectAtLimit(BigInt(active), BigInt(policy.max_active_instances));
      rejectAtLimit(BigInt(perModule), BigInt(policy.max_instances_per_module));
      instanceId = randomUUID();
      deploymentId = randomUUID();
      await q.query(`INSERT INTO module_instances(instance_id, tenant_id, module_key, application_release_ref, data_schema_version,
          contract_ref, status, binding_id, created_by_principal_id, origin_guild_key)
        VALUES($1,$2,'work',$3,$4,NULL,'active',$5,$6,$7)`,
      [instanceId, tenantId, RELEASE, SCHEMA_VERSION, deploymentId, context.principal_id, input.guild_key]);
      await q.query(`INSERT INTO deployment_bindings(binding_id, tenant_id, instance_id, mode, environment, endpoint_ref, service_principal_id, contract_ref, state)
        VALUES($1,$2,$3,'hosted','hosted-shared',NULL,NULL,NULL,'active')`, [deploymentId, tenantId, instanceId]);
    }
    await q.query(`INSERT INTO workspace_module_bindings(tenant_id, workspace_id, entry_capability, instance_id)
      VALUES($1,$2,'work:create',$3)`, [tenantId, workspaceId, instanceId]);
    const created = await bindingOf(q, tenantId, workspaceId);
    requireCondition(created, 500, 'internal_error', '工作綁定沒有完成。');
    const view = bindingView(tenantId, workspaceId, created, false);
    await scopedJournal(q, context, { aggregate_type: 'tenant_work', id: workspaceId, version: view.version, operation: 'manual.work.enable',
      data: { tenant_id: tenantId, workspace_id: workspaceId, instance_id: view.instance_id, binding_id: view.binding_id, reused: false } });
    return view;
  });
}

export async function listInstances(pool: Pool, actor: Actor, tenantId: string, query: { module_key?: string; status?: string; cursor?: string; limit?: number }) {
  OpaqueId.parse(tenantId);
  const limit = query.limit ?? 20;
  const cursor = decodeCursor(query.cursor);
  const clock = { user_id: actor.user_id, session_hash: actor.session_hash };
  return transaction(pool, async q => {
    const context = await lockTenantScope(q, { actor, tenantId, forUpdate: false, capabilitiesForRole: tenantWorkCapabilities });
    requireTenantCapability(context, 'instance.manage', false);
    const rows = (await q.query<{ instance_id: string; cursor_at: string }>(
      `SELECT instance_id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
       FROM module_instances
       WHERE tenant_id=$1
         AND ($2::text IS NULL OR module_key=$2)
         AND ($3::text IS NULL OR status=$3)
         AND ($4::timestamptz IS NULL OR (created_at, instance_id) < ($4::timestamptz, $5::uuid))
       ORDER BY created_at DESC, instance_id DESC LIMIT $6`,
    [tenantId, query.module_key ?? null, query.status ?? null, cursor?.at ?? null, cursor?.id ?? null, limit + 1])).rows;
    const page = rows.slice(0, limit);
    const items = [];
    for (const row of page) items.push(await instanceView(q, tenantId, row.instance_id));
    const version = (await q.query<{ v: string | null }>(`SELECT max(version)::text AS v FROM module_instances WHERE tenant_id=$1`, [tenantId])).rows[0].v;
    const body = ModuleInstancePageSchema.parse({
      items, next_cursor: rows.length > limit ? encodeCursor(page[page.length - 1].cursor_at, page[page.length - 1].instance_id) : null,
      source_version: version && version !== '0' ? version : context.authorization_revision,
    });
    await assertCurrentSessionClock(q, clock);
    return body;
  });
}

export async function readWorkspaceBinding(pool: Pool, actor: Actor, tenantId: string, workspaceId: string) {
  const clock = { user_id: actor.user_id, session_hash: actor.session_hash };
  return transaction(pool, async q => {
    const context = await lockTenantScope(q, { actor, tenantId, forUpdate: false, capabilitiesForRole: tenantWorkCapabilities });
    requireTenantCapability(context, 'work:read', false);
    const row = await bindingOf(q, tenantId, workspaceId);
    const view = row ? bindingView(tenantId, workspaceId, row, true) : null;
    await assertCurrentSessionClock(q, clock);
    return view;
  });
}

export async function launchpadContext(pool: Pool, actor: Actor, tenantId: string, workspaceId: string, guildKey: string, workPage: unknown) {
  OpaqueId.parse(tenantId); OpaqueId.parse(workspaceId);
  const clock = { user_id: actor.user_id, session_hash: actor.session_hash };
  return transaction(pool, async q => {
    const context = await lockTenantScope(q, { actor, tenantId, forUpdate: false, capabilitiesForRole: tenantWorkCapabilities });
    requireTenantCapability(context, 'work:read', false);
    const workspace = (await q.query<{ version: string; status: string }>(`SELECT version::text AS version, status FROM workspaces WHERE tenant_id=$1 AND workspace_id=$2`, [tenantId, workspaceId])).rows[0];
    requireCondition(workspace, 404, 'not_found', '找不到這個工作區。');
    requireCondition(workspace.status === 'active', 409, 'workspace_unavailable', '這個工作區目前無法使用。');
    const catalog = await q.query('SELECT guild_key FROM positioning_guild_catalog WHERE guild_key=$1', [guildKey]);
    requireCondition(catalog.rowCount === 1, 404, 'guild_not_found', '找不到這個公會。');
    const instances = (await q.query<{ instance_id: string }>(`SELECT instance_id FROM module_instances WHERE tenant_id=$1 ORDER BY created_at, instance_id LIMIT 100`, [tenantId])).rows;
    const views = [];
    for (const row of instances) views.push(await instanceView(q, tenantId, row.instance_id));
    const binding = await bindingOf(q, tenantId, workspaceId);
    const hosted = binding ? (await q.query(`SELECT 1 FROM deployment_bindings WHERE instance_id=$1 AND tenant_id=$2 AND mode='hosted' AND state='active'`, [binding.instance_id, tenantId])).rowCount === 1 : false;
    const maxInstance = (await q.query<{ v: string | null }>(`SELECT max(version)::text AS v FROM module_instances WHERE tenant_id=$1`, [tenantId])).rows[0].v;
    const workSource = (workPage as { source_version: string }).source_version;
    const source = [workSource, maxInstance ?? '0', workspace.version].reduce((best, value) => BigInt(value) > BigInt(best) ? value : best, '1');
    const body = LaunchpadContextSchema.parse({
      tenant_id: tenantId, workspace_id: workspaceId, source_version: source, instances: views, work_page: workPage,
      capacity_summary: await capacitySummary(q, context.scope.scope_id, tenantId),
      connection_summary: binding && hosted ? [{ instance_id: binding.instance_id, status: 'hosted_active' }] : [],
    });
    await assertCurrentSessionClock(q, clock);
    return body;
  });
}
