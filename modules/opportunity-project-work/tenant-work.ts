import type { Pool, PoolClient } from 'pg';
import { OpaqueId } from '../../contracts/common/v1/identity.js';
import { WorkPageSchema, WorkSchema, type WorkView } from '../../contracts/guild-launchpad/v1/tenant-work.js';
import { transaction } from '../../packages/db/index.js';
import { lockTenantScope, type TenantScopeContext } from '../../packages/resource-scopes/index.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import type { Actor } from '../identity-membership/service.js';
import { requireTenantCapability, tenantWorkCapabilities } from './tenant-capabilities.js';

export interface TenantWorkRow {
  work_item_id: string; tenant_id: string; workspace_id: string; instance_id: string;
  title: string; objective: string; progress: 'todo' | 'in_progress' | 'done'; state: 'draft' | 'archived';
  aggregate_version: string; updated_at: Date; created_at: Date; current_result_id: string | null;
}

const FIELDS = `w.work_item_id, w.tenant_id, w.workspace_id, w.instance_id, w.title, w.objective, w.progress, w.state,
  w.aggregate_version::text AS aggregate_version, w.updated_at, w.created_at, t.result_id AS current_result_id`;

export function encodeKeyset(at: string, id: string) {
  return Buffer.from(`${at}\n${id}`).toString('base64url');
}
export function decodeKeyset(raw?: string): { at: string; id: string } | null {
  if (!raw) return null;
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const split = text.indexOf('\n');
  if (split < 1) throw new Problem(422, 'invalid_cursor', '分頁游標無效。');
  const at = text.slice(0, split), id = text.slice(split + 1);
  if (!OpaqueId.safeParse(id).success || Number.isNaN(Date.parse(at))) throw new Problem(422, 'invalid_cursor', '分頁游標無效。');
  return { at, id };
}
export function likePattern(value: string) {
  return `%${value.replace(/[\\%_]/g, match => `\\${match}`)}%`;
}

export function workView(row: TenantWorkRow): WorkView {
  return WorkSchema.parse({
    work_id: row.work_item_id, tenant_id: row.tenant_id, workspace_id: row.workspace_id, instance_id: row.instance_id,
    title: row.title, objective: row.objective, progress: row.progress, state: row.state, version: row.aggregate_version,
    updated_at: row.updated_at.toISOString(), ...(row.current_result_id ? { current_result_id: row.current_result_id } : {}),
  });
}

export async function withTenantRead<T>(pool: Pool, actor: Actor, tenantId: string, run: (q: PoolClient, context: TenantScopeContext) => Promise<T>) {
  return transaction(pool, async q => {
    const context = await lockTenantScope(q, { actor, tenantId, forUpdate: false, capabilitiesForRole: tenantWorkCapabilities });
    return run(q, context);
  });
}

export async function loadWork(q: PoolClient, tenantId: string, scopeId: string, workId: string, lock: boolean): Promise<TenantWorkRow | null> {
  return (await q.query<TenantWorkRow>(`SELECT ${FIELDS} FROM work_items w
    LEFT JOIN tenant_work_result_targets t ON t.work_item_id=w.work_item_id
    WHERE w.work_item_id=$1 AND w.tenant_id=$2 AND w.scope_id=$3 AND w.work_mode='tenant_execution'${lock ? ' FOR UPDATE OF w' : ''}`,
  [workId, tenantId, scopeId])).rows[0] ?? null;
}

export async function requireActiveWorkspace(q: PoolClient, tenantId: string, workspaceId: string) {
  const row = (await q.query<{ status: string }>(`SELECT status FROM workspaces WHERE tenant_id=$1 AND workspace_id=$2`, [tenantId, workspaceId])).rows[0];
  requireCondition(row, 404, 'not_found', '找不到這個工作區。');
  requireCondition(row.status === 'active', 409, 'workspace_unavailable', '這個工作區目前無法使用。');
}

async function workspaceSource(q: PoolClient, tenantId: string, workspaceId: string) {
  await requireActiveWorkspace(q, tenantId, workspaceId);
  const row = (await q.query<{ version: string; source: string }>(`SELECT ws.version::text AS version,
      GREATEST(
        COALESCE((SELECT max(aggregate_version) FROM work_items WHERE tenant_id=$1 AND workspace_id=$2 AND work_mode='tenant_execution' AND state='draft'), 0),
        COALESCE((SELECT version FROM workspace_module_bindings WHERE tenant_id=$1 AND workspace_id=$2 AND entry_capability='work:create'), 0),
        ws.version
      )::text AS source
    FROM workspaces ws WHERE ws.tenant_id=$1 AND ws.workspace_id=$2`, [tenantId, workspaceId])).rows[0];
  requireCondition(row, 404, 'not_found', '找不到這個工作區。');
  return row.source === '0' ? row.version : row.source;
}

export async function listTenantWork(pool: Pool, actor: Actor, tenantId: string, workspaceId: string, query: { q?: string; limit?: number; cursor?: string }) {
  OpaqueId.parse(tenantId); OpaqueId.parse(workspaceId);
  const limit = query.limit ?? 20;
  const cursor = decodeKeyset(query.cursor);
  return withTenantRead(pool, actor, tenantId, async (q, context) => {
    requireTenantCapability(context, 'work:read', false);
    const source = await workspaceSource(q, tenantId, workspaceId);
    const rows = (await q.query<TenantWorkRow & { cursor_at: string }>(`SELECT ${FIELDS},
        to_char(w.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
      FROM work_items w
      LEFT JOIN tenant_work_result_targets t ON t.work_item_id=w.work_item_id
      WHERE w.tenant_id=$1 AND w.workspace_id=$2 AND w.scope_id=$3 AND w.work_mode='tenant_execution' AND w.state='draft'
        AND ($4::text IS NULL OR w.title ILIKE $4 ESCAPE '\\')
        AND ($5::timestamptz IS NULL OR (w.created_at, w.work_item_id) < ($5::timestamptz, $6::uuid))
      ORDER BY w.created_at DESC, w.work_item_id DESC LIMIT $7`,
    [tenantId, workspaceId, context.scope.scope_id, query.q ? likePattern(query.q) : null, cursor?.at ?? null, cursor?.id ?? null, limit + 1])).rows;
    const page = rows.slice(0, limit);
    return WorkPageSchema.parse({
      items: page.map(workView),
      next_cursor: rows.length > limit ? encodeKeyset(page[page.length - 1].cursor_at, page[page.length - 1].work_item_id) : null,
      source_version: source,
    });
  });
}

export async function readTenantWork(pool: Pool, actor: Actor, tenantId: string, workId: string) {
  OpaqueId.parse(tenantId); OpaqueId.parse(workId);
  return withTenantRead(pool, actor, tenantId, async (q, context) => {
    requireTenantCapability(context, 'work:read', false);
    const row = await loadWork(q, tenantId, context.scope.scope_id, workId, false);
    requireCondition(row && row.state === 'draft', 404, 'not_found', '找不到這個工作。');
    return workView(row);
  });
}
