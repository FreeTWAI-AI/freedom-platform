import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { OperationSchema, WorkWriteSchema, type Operation } from '../../contracts/guild-launchpad/v1/tenant-work.js';
import { checkVersion } from '../../packages/db/index.js';
import { scopedJournal, scopedTenantCommand } from '../../packages/scoped-commands/index.js';
import type { TenantScopeContext } from '../../packages/resource-scopes/index.js';
import { requireCondition } from '../../packages/shared/problem.js';
import type { Actor } from '../identity-membership/service.js';
import { requireWorkCapability, requireWorkInstance, tenantWorkCapabilities } from './tenant-capabilities.js';
import { lockCapacityPolicy, lockDimension, rejectAtLimit, requirePolicy } from './tenant-capacity.js';
import { loadWork, lockWritableInstance, requireActiveWorkspace, type TenantWorkRow } from './tenant-work.js';

function operation(tenantId: string, instanceId: string, workId: string, operationId = randomUUID()): Operation {
  return OperationSchema.parse({
    operation_id: operationId, state: 'succeeded', version: '1',
    resource_ref: { tenant_id: tenantId, instance_id: instanceId, resource_type: 'work.work', resource_id: workId },
  });
}

async function boundInstance(q: PoolClient, tenantId: string, workspaceId: string) {
  await requireActiveWorkspace(q, tenantId, workspaceId);
  const row = (await q.query<{ instance_id: string; status: string }>(
    `SELECT w.instance_id, ws.status FROM workspace_module_bindings b
     JOIN workspaces ws ON ws.tenant_id=b.tenant_id AND ws.workspace_id=b.workspace_id
     JOIN module_instances w ON w.tenant_id=b.tenant_id AND w.instance_id=b.instance_id
     WHERE b.tenant_id=$1 AND b.workspace_id=$2 AND b.entry_capability='work:create'`,
  [tenantId, workspaceId])).rows[0];
  requireCondition(row, 409, 'work_instance_required', '請先在這個工作區啟用手動工作。');
  requireCondition(row.status === 'active', 409, 'workspace_unavailable', '這個工作區目前無法使用。');
  return row.instance_id;
}

async function journal(q: PoolClient, context: TenantScopeContext, row: TenantWorkRow, name: string) {
  await scopedJournal(q, context, {
    aggregate_type: 'tenant_work', id: row.work_item_id, version: row.aggregate_version, operation: name,
    data: { work_id: row.work_item_id, tenant_id: row.tenant_id, instance_id: row.instance_id, state: row.state, version: row.aggregate_version },
  });
}

export function createTenantWorkCommands(pool: Pool) {
  async function create(actor: Actor, tenantId: string, workspaceId: string, body: unknown, key: string) {
    const input = WorkWriteSchema.parse(body);
    let instanceId!: string;
    return scopedTenantCommand(pool, {
      actor, tenantId, operation: 'work.tenant.create', key, tenantLock: 'share', body: input,
      target: { kind: 'tenant_workspace', id: workspaceId }, capabilitiesForRole: tenantWorkCapabilities,
    }, async (q, context) => {
      await requireWorkCapability(q, context, 'work:create', true);
      instanceId = await boundInstance(q, tenantId, workspaceId);
      await requireWorkInstance(q, context, instanceId, 'work:create');
    }, async (q, context) => {
      await lockWritableInstance(q, tenantId, instanceId);
      const policy = requirePolicy(await lockCapacityPolicy(q, tenantId));
      await lockDimension(q, tenantId, 'work_items');
      const count = (await q.query<{ n: string }>(`SELECT count(*)::text AS n FROM work_items
        WHERE tenant_id=$1 AND work_mode='tenant_execution' AND state<>'archived'`, [tenantId])).rows[0].n;
      rejectAtLimit(BigInt(count), BigInt(policy.max_work_items));
      const workId = randomUUID();
      const row = (await q.query<TenantWorkRow>(`INSERT INTO work_items(work_item_id, work_mode, scope_id, owner_ref, owner_principal_id, community_id,
          title, objective, state, tenant_id, instance_id, workspace_id, created_by_principal_id, progress, updated_at, participation_terms_revision)
        VALUES($1,'tenant_execution',$2,$3,NULL,NULL,$4,$5,'draft',$6,$7,$8,$9,$10,clock_timestamp(),NULL)
        RETURNING work_item_id, tenant_id, workspace_id, instance_id, title, objective, progress, state, aggregate_version::text AS aggregate_version, updated_at, created_at, NULL::uuid AS current_result_id`,
      [workId, context.scope.scope_id, actor.user_id, input.title, input.objective, tenantId, instanceId, workspaceId, context.principal_id, input.progress])).rows[0];
      await journal(q, context, row, 'work.tenant.create');
      return operation(tenantId, instanceId, row.work_item_id);
    });
  }

  async function update(actor: Actor, tenantId: string, workId: string, body: unknown, key: string, expected: string) {
    const input = WorkWriteSchema.parse(body);
    let locked!: TenantWorkRow;
    return scopedTenantCommand(pool, {
      actor, tenantId, operation: 'work.tenant.update', key, tenantLock: 'share', expected, body: input,
      target: { kind: 'tenant_work', id: workId }, capabilitiesForRole: tenantWorkCapabilities,
    }, async (q, context) => {
      await requireWorkCapability(q, context, 'work:write', true);
      const preview = await loadWork(q, tenantId, context.scope.scope_id, workId, false);
      requireCondition(preview, 404, 'not_found', '找不到這個工作。');
      await requireWorkInstance(q, context, preview.instance_id, 'work:write', '找不到這個工作。');
      requireCondition(preview.state === 'draft', 409, 'work_archived', '這個工作已封存。');
      await requireActiveWorkspace(q, tenantId, preview.workspace_id);
      await lockWritableInstance(q, tenantId, preview.instance_id);
      const row = await loadWork(q, tenantId, context.scope.scope_id, workId, true);
      requireCondition(row, 404, 'not_found', '找不到這個工作。');
      requireCondition(row.state === 'draft', 409, 'work_archived', '這個工作已封存。');
      locked = row;
    }, async (q, context) => {
      checkVersion(locked.aggregate_version, expected);
      const row = (await q.query<TenantWorkRow>(`UPDATE work_items SET title=$2, objective=$3, progress=$4, updated_at=clock_timestamp(), aggregate_version=aggregate_version+1
        WHERE work_item_id=$1 AND tenant_id=$5 AND state='draft' AND aggregate_version=$6
        RETURNING work_item_id, tenant_id, workspace_id, instance_id, title, objective, progress, state, aggregate_version::text AS aggregate_version, updated_at, created_at, NULL::uuid AS current_result_id`,
      [workId, input.title, input.objective, input.progress, tenantId, expected])).rows[0];
      requireCondition(row, 412, 'version_conflict', '資料已更新，請重新整理後再操作。');
      await journal(q, context, row, 'work.tenant.update');
      return operation(tenantId, row.instance_id, row.work_item_id);
    });
  }

  async function archive(actor: Actor, tenantId: string, workId: string, key: string, expected: string) {
    let locked!: TenantWorkRow;
    return scopedTenantCommand(pool, {
      actor, tenantId, operation: 'work.tenant.archive', key, tenantLock: 'share', expected, body: {},
      target: { kind: 'tenant_work', id: workId }, capabilitiesForRole: tenantWorkCapabilities,
    }, async (q, context) => {
      await requireWorkCapability(q, context, 'work:archive', true);
      const row = await loadWork(q, tenantId, context.scope.scope_id, workId, true);
      requireCondition(row, 404, 'not_found', '找不到這個工作。');
      await requireWorkInstance(q, context, row.instance_id, 'work:archive', '找不到這個工作。');
      await requireActiveWorkspace(q, tenantId, row.workspace_id);
      locked = row;
    }, async (q, context) => {
      checkVersion(locked.aggregate_version, expected);
      requireCondition(locked.state === 'draft', 409, 'work_archived', '這個工作已封存。');
      const row = (await q.query<TenantWorkRow>(`UPDATE work_items SET state='archived', updated_at=clock_timestamp(), aggregate_version=aggregate_version+1
        WHERE work_item_id=$1 AND tenant_id=$2 AND state='draft' AND aggregate_version=$3
        RETURNING work_item_id, tenant_id, workspace_id, instance_id, title, objective, progress, state, aggregate_version::text AS aggregate_version, updated_at, created_at, NULL::uuid AS current_result_id`,
      [workId, tenantId, expected])).rows[0];
      requireCondition(row, 412, 'version_conflict', '資料已更新，請重新整理後再操作。');
      await journal(q, context, row, 'work.tenant.archive');
      return operation(tenantId, row.instance_id, row.work_item_id);
    });
  }
  return Object.freeze({ create, update, archive });
}
