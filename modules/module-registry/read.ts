import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { OpaqueId } from '../../contracts/common/v1/identity.js';
import {
  InstallationPageSchema, InstallationViewSchema, InstanceDetailSchema, InstancePageSchema, InstanceViewSchema,
  type InstallationView, type InstanceView,
} from '../../contracts/guild-launchpad/v1/module-registry.js';
import type { Actor } from '../identity-membership/service.js';
import { assertCurrentSessionClock } from '../../packages/db/member-session.js';
import { lockTenantScope, type TenantScopeContext } from '../../packages/resource-scopes/index.js';
import { isolatedTransaction } from '../../packages/resource-scopes/tenant-transaction.js';
import { isKeysetTimestamp } from '../../packages/shared/keyset-timestamp.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import { moduleRegistryCapabilities } from './capabilities.js';

function requireManage(context: TenantScopeContext, write: boolean) {
  if (write && context.tenant_status !== 'active') throw new Problem(403, 'capability_denied', '目前無法使用這個業務空間。');
  requireCondition(context.capabilities.includes('instance.manage'), 403, 'capability_denied', '目前沒有這個操作的權限。');
}

type RegistryCursorContext = { tenantId: string; callerId: string; filter: string };
function encodeCursor(at: string, id: string, context: RegistryCursorContext) {
  return Buffer.from(JSON.stringify({ ...context, at, id })).toString('base64url');
}
function decodeCursor(raw: string | undefined, context: RegistryCursorContext) {
  if (!raw) return null;
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); }
  catch { throw new Problem(422, 'invalid_cursor', '分頁游標無效。'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).sort().join(',') !== 'at,callerId,filter,id,tenantId'
    || Object.entries(context).some(([key, value]) => parsed[key] !== value)
    || !isKeysetTimestamp(parsed.at) || !OpaqueId.safeParse(parsed.id).success) {
    throw new Problem(422, 'invalid_cursor', '分頁游標無效。');
  }
  return { at: parsed.at, id: parsed.id as string };
}

const INSTANCE_COLUMNS = `instance_id, tenant_id, module_key, application_release_ref, data_schema_version, contract_ref,
  status, binding_id, authority_epoch::text AS authority_epoch, version::text AS version, configuration_revision::text AS configuration_revision
`;
const INSTANCE_SQL = `SELECT ${INSTANCE_COLUMNS} FROM module_instances WHERE tenant_id=$1 AND instance_id=$2`;

export async function instanceView(q: PoolClient, tenantId: string, instanceId: string): Promise<InstanceView> {
  const row = (await q.query(INSTANCE_SQL, [tenantId, instanceId])).rows[0];
  requireCondition(row, 404, 'not_found', '找不到這個模組實例。');
  return InstanceViewSchema.parse(row);
}

export async function listInstances(pool: Pool, actor: Actor, tenantId: string, query: { module_key?: string; status?: string; cursor?: string; limit?: number }) {
  const limit = query.limit ?? 20;
  return isolatedTransaction(pool, async q => {
    const context = await lockTenantScope(q, { actor, tenantId, forUpdate: false, capabilitiesForRole: moduleRegistryCapabilities });
    requireManage(context, false);
    const cursorContext = { tenantId, callerId: context.subject_principal.principal_id,
      filter: createHash('sha256').update(JSON.stringify({ list: 'instances', module_key: query.module_key ?? null, status: query.status ?? null })).digest('hex') };
    const cursor = decodeCursor(query.cursor, cursorContext);
    const rows = (await q.query<{ instance_id: string; cursor_at: string }>(
      `SELECT instance_id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
       FROM module_instances
       WHERE tenant_id=$1 AND ($2::text IS NULL OR module_key=$2) AND ($3::text IS NULL OR status=$3)
         AND ($4::timestamptz IS NULL OR (created_at, instance_id) < ($4::timestamptz, $5::uuid))
       ORDER BY created_at DESC, instance_id DESC LIMIT $6`,
      [tenantId, query.module_key ?? null, query.status ?? null, cursor?.at ?? null, cursor?.id ?? null, limit + 1],
    )).rows;
    const page = rows.slice(0, limit);
    const items = [];
    for (const row of page) items.push(await instanceView(q, tenantId, row.instance_id));
    const version = (await q.query<{ v: string | null }>(`SELECT max(version)::text AS v FROM module_instances WHERE tenant_id=$1`, [tenantId])).rows[0].v;
    await assertCurrentSessionClock(q, actor);
    return InstancePageSchema.parse({
      items,
      next_cursor: rows.length > limit ? encodeCursor(page[page.length - 1].cursor_at, page[page.length - 1].instance_id, cursorContext) : null,
      source_version: version && version !== '0' ? version : context.authorization_revision,
    });
  });
}

/** The operation query must match this instance's suspension pointer and kind. */
export function isMemberSuspension(matchedOperation: unknown, currentBindingState: string | undefined): boolean {
  return Boolean(matchedOperation) && currentBindingState === 'suspended';
}

export async function readInstance(pool: Pool, actor: Actor, tenantId: string, instanceId: string) {
  return isolatedTransaction(pool, async q => {
    const context = await lockTenantScope(q, { actor, tenantId, forUpdate: false, capabilitiesForRole: moduleRegistryCapabilities });
    requireManage(context, false);
    const row = (await q.query(
      `SELECT ${INSTANCE_COLUMNS}, suspension_operation_id,
         (SELECT d.state FROM deployment_bindings d WHERE d.tenant_id=module_instances.tenant_id
            AND d.instance_id=module_instances.instance_id AND d.binding_id=module_instances.binding_id) AS current_binding_state,
         (SELECT jsonb_build_object('operation_id',o.operation_id,'suspended_at',o.accepted_at,'reason',o.reason)
          FROM module_provision_operations o WHERE o.tenant_id=module_instances.tenant_id
            AND o.operation_id=module_instances.suspension_operation_id AND o.instance_id=module_instances.instance_id
            AND o.operation_kind='module.instance.suspend') AS member_suspension
       FROM module_instances WHERE tenant_id=$1 AND instance_id=$2`, [tenantId, instanceId],
    )).rows[0];
    requireCondition(row, 404, 'not_found', '找不到這個模組實例。');
    const { suspension_operation_id: _pointer, member_suspension: memberSuspension, current_binding_state: bindingState, ...fields } = row;
    const view = InstanceViewSchema.parse(fields);
    const dependencies = (await q.query(
      `SELECT requirement_key, provider_instance_id, version::text AS version
       FROM module_dependencies WHERE tenant_id=$1 AND caller_instance_id=$2 ORDER BY requirement_key`,
      [tenantId, instanceId],
    )).rows;
    const consumers = (await q.query(
      `SELECT d.caller_instance_id, d.requirement_key, i.module_key, i.status
       FROM module_dependencies d JOIN module_instances i
         ON i.tenant_id=d.tenant_id AND i.instance_id=d.caller_instance_id
       WHERE d.tenant_id=$1 AND d.provider_instance_id=$2
       ORDER BY d.caller_instance_id, d.requirement_key, d.dependency_id LIMIT 50`, [tenantId, instanceId],
    )).rows;
    const counts = (await q.query<{ consumer_count: number; workspace_count: number }>(
      `SELECT (SELECT count(*)::int FROM module_dependencies WHERE tenant_id=$1 AND provider_instance_id=$2) AS consumer_count,
         (SELECT count(DISTINCT workspace_id)::int FROM workspace_module_bindings WHERE tenant_id=$1 AND instance_id=$2) AS workspace_count`,
      [tenantId, instanceId],
    )).rows[0];
    const workspaces = (await q.query<{ workspace_id: string }>(
      `SELECT DISTINCT workspace_id FROM workspace_module_bindings WHERE tenant_id=$1 AND instance_id=$2 ORDER BY workspace_id LIMIT 50`,
      [tenantId, instanceId],
    )).rows;
    const suspension = view.status !== 'suspended' ? null : isMemberSuspension(memberSuspension, bindingState)
      ? { kind: 'member', ...memberSuspension, suspended_at: new Date(memberSuspension.suspended_at).toISOString() }
      : { kind: 'platform', operation_id: null, suspended_at: null, reason: null };
    await assertCurrentSessionClock(q, actor);
    return InstanceDetailSchema.parse({ ...view, dependencies,
      impact: { ...counts, consumers, workspace_ids: workspaces.map(row => row.workspace_id) }, suspension });
  });
}

async function installationView(q: PoolClient, tenantId: string, installationId: string): Promise<InstallationView> {
  const row = (await q.query(
    `SELECT installation_id, tenant_id, workspace_id, application_key, release_ref, status, version::text AS version
     FROM application_installations WHERE tenant_id=$1 AND installation_id=$2`,
    [tenantId, installationId],
  )).rows[0];
  requireCondition(row, 404, 'not_found', '找不到這個應用安裝。');
  const modules = (await q.query(
    `SELECT requirement_key, instance_id FROM application_module_links WHERE tenant_id=$1 AND installation_id=$2 ORDER BY requirement_key`,
    [tenantId, installationId],
  )).rows;
  return InstallationViewSchema.parse({ ...row, modules });
}

export async function listInstallations(pool: Pool, actor: Actor, tenantId: string, query: { application_key?: string; workspace_id?: string; cursor?: string; limit?: number }) {
  const limit = query.limit ?? 20;
  return isolatedTransaction(pool, async q => {
    const context = await lockTenantScope(q, { actor, tenantId, forUpdate: false, capabilitiesForRole: moduleRegistryCapabilities });
    requireManage(context, false);
    const cursorContext = { tenantId, callerId: context.subject_principal.principal_id,
      filter: createHash('sha256').update(JSON.stringify({ list: 'installations', application_key: query.application_key ?? null, workspace_id: query.workspace_id ?? null })).digest('hex') };
    const cursor = decodeCursor(query.cursor, cursorContext);
    const rows = (await q.query<{ installation_id: string; cursor_at: string }>(
      `SELECT installation_id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
       FROM application_installations
       WHERE tenant_id=$1 AND ($2::text IS NULL OR application_key=$2) AND ($3::uuid IS NULL OR workspace_id=$3)
         AND ($4::timestamptz IS NULL OR (created_at, installation_id) < ($4::timestamptz, $5::uuid))
       ORDER BY created_at DESC, installation_id DESC LIMIT $6`,
      [tenantId, query.application_key ?? null, query.workspace_id ?? null, cursor?.at ?? null, cursor?.id ?? null, limit + 1],
    )).rows;
    const page = rows.slice(0, limit);
    const items = [];
    for (const row of page) items.push(await installationView(q, tenantId, row.installation_id));
    const version = (await q.query<{ v: string | null }>(`SELECT max(version)::text AS v FROM application_installations WHERE tenant_id=$1`, [tenantId])).rows[0].v;
    await assertCurrentSessionClock(q, actor);
    return InstallationPageSchema.parse({
      items,
      next_cursor: rows.length > limit ? encodeCursor(page[page.length - 1].cursor_at, page[page.length - 1].installation_id, cursorContext) : null,
      source_version: version && version !== '0' ? version : context.authorization_revision,
    });
  });
}

export async function installationByOperation(pool: Pool, actor: Actor, tenantId: string, operationId: string) {
  return isolatedTransaction(pool, async q => {
    const context = await lockTenantScope(q, { actor, tenantId, forUpdate: false, capabilitiesForRole: moduleRegistryCapabilities });
    requireManage(context, false);
    const row = (await q.query<{ installation_id: string }>(
      `SELECT installation_id FROM module_provision_operations WHERE tenant_id=$1 AND operation_id=$2 AND operation_kind='application.launch'`,
      [tenantId, operationId],
    )).rows[0];
    requireCondition(row, 404, 'not_found', '找不到這個應用安裝。');
    const view = await installationView(q, tenantId, row.installation_id);
    await assertCurrentSessionClock(q, actor);
    return view;
  });
}
