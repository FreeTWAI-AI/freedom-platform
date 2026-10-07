import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { OpaqueId } from '../../contracts/common/v1/identity.js';
import { WorkPageSchema, WorkSchema, type WorkView } from '../../contracts/guild-launchpad/v1/tenant-work.js';
import { withTenantRead, type TenantScopeInput } from '../../packages/resource-scopes/index.js';
import { isKeysetTimestamp } from '../../packages/shared/keyset-timestamp.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import type { Actor } from '../identity-membership/service.js';
import { requireWorkCapability, requireWorkInstance, tenantWorkCapabilities } from './tenant-capabilities.js';

export interface TenantWorkRow {
  work_item_id: string; tenant_id: string; workspace_id: string; instance_id: string;
  title: string; objective: string; progress: 'todo' | 'in_progress' | 'done'; state: 'draft' | 'archived';
  aggregate_version: string; updated_at: Date; created_at: Date; current_result_id: string | null;
}

const FIELDS = `w.work_item_id, w.tenant_id, w.workspace_id, w.instance_id, w.title, w.objective, w.progress, w.state,
  w.aggregate_version::text AS aggregate_version, w.updated_at, w.created_at, t.result_id AS current_result_id`;

type WorkCursorContext = { tenantId: string; workspaceId: string; callerId: string; filter: string };
export function encodeKeyset(at: string, id: string, context: WorkCursorContext) {
  return Buffer.from(JSON.stringify({ ...context, at, id })).toString('base64url');
}
export function decodeKeyset(raw: string | undefined, context: WorkCursorContext): { at: string; id: string } | null {
  if (!raw) return null;
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); }
  catch { throw new Problem(422, 'invalid_cursor', '分頁游標無效。'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).sort().join(',') !== 'at,callerId,filter,id,tenantId,workspaceId'
    || Object.entries(context).some(([key, value]) => parsed[key] !== value)
    || !isKeysetTimestamp(parsed.at) || !OpaqueId.safeParse(parsed.id).success) {
    throw new Problem(422, 'invalid_cursor', '分頁游標無效。');
  }
  return { at: parsed.at, id: parsed.id as string };
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

export function tenantWorkReadInput(actor: Actor, tenantId: string): TenantScopeInput {
  return { actor, tenantId, forUpdate: false, capabilitiesForRole: tenantWorkCapabilities };
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

/** New writes only. Instance FOR SHARE, then its deployment FOR SHARE. */
export async function lockWritableInstance(q: PoolClient, tenantId: string, instanceId: string) {
  const instance = (await q.query<{ status: string; binding_id: string }>(
    `SELECT status, binding_id FROM module_instances WHERE tenant_id=$1 AND instance_id=$2 FOR SHARE`,
    [tenantId, instanceId])).rows[0];
  const deployment = instance ? (await q.query<{ state: string }>(
    `SELECT state FROM deployment_bindings WHERE tenant_id=$1 AND binding_id=$2 AND instance_id=$3 FOR SHARE`,
    [tenantId, instance.binding_id, instanceId])).rows[0] : undefined;
  requireCondition(instance?.status === 'active' && deployment?.state === 'active', 409, 'work_instance_unavailable', '這個工作實例目前無法接受新的寫入。');
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
  const cursorContext = { tenantId, workspaceId, callerId: actor.user_id, filter: createHash('sha256').update(query.q ?? '').digest('hex') };
  const cursor = decodeKeyset(query.cursor, cursorContext);
  return withTenantRead(pool, tenantWorkReadInput(actor, tenantId), async (q, context) => {
    await requireWorkCapability(q, context, 'work:read', false);
    const source = await workspaceSource(q, tenantId, workspaceId);
    const binding = (await q.query<{ instance_id: string }>(`SELECT instance_id FROM workspace_module_bindings
      WHERE tenant_id=$1 AND workspace_id=$2 AND entry_capability='work:create'`, [tenantId, workspaceId])).rows[0];
    if (binding) await requireWorkInstance(q, context, binding.instance_id, 'work:read');
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
      next_cursor: rows.length > limit ? encodeKeyset(page[page.length - 1].cursor_at, page[page.length - 1].work_item_id, cursorContext) : null,
      source_version: source,
    });
  });
}

export async function readTenantWork(pool: Pool, actor: Actor, tenantId: string, workId: string) {
  OpaqueId.parse(tenantId); OpaqueId.parse(workId);
  return withTenantRead(pool, tenantWorkReadInput(actor, tenantId), async (q, context) => {
    await requireWorkCapability(q, context, 'work:read', false);
    const row = await loadWork(q, tenantId, context.scope.scope_id, workId, false);
    requireCondition(row && row.state === 'draft', 404, 'not_found', '找不到這個工作。');
    await requireWorkInstance(q, context, row.instance_id, 'work:read', '找不到這個工作。');
    return workView(row);
  });
}
