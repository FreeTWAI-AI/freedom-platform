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
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import { moduleRegistryCapabilities } from './capabilities.js';
import { isKeysetTimestamp } from '../../packages/shared/keyset-timestamp.js';

function requireManage(context: TenantScopeContext, write: boolean) {
  if (write && context.tenant_status !== 'active') throw new Problem(403, 'capability_denied', '目前無法使用這個業務空間。');
  requireCondition(context.capabilities.includes('instance.manage'), 403, 'capability_denied', '目前沒有這個操作的權限。');
}

function encodeCursor(at: string, id: string) {
  return Buffer.from(`${at}\n${id}`).toString('base64url');
}
function decodeCursor(raw?: string) {
  if (!raw) return null;
  let text = '';
  try { text = Buffer.from(raw, 'base64url').toString('utf8'); } catch { throw new Problem(422, 'invalid_cursor', '分頁游標無效。'); }
  const split = text.indexOf('\n');
  if (split < 1) throw new Problem(422, 'invalid_cursor', '分頁游標無效。');
  const at = text.slice(0, split);
  const id = text.slice(split + 1);
  if (!OpaqueId.safeParse(id).success || Number.isNaN(Date.parse(at))) throw new Problem(422, 'invalid_cursor', '分頁游標無效。');
  return { at, id };
}

const INSTANCE_SQL = `SELECT instance_id, tenant_id, module_key, application_release_ref, data_schema_version, contract_ref,
  status, binding_id, authority_epoch::text AS authority_epoch, version::text AS version, configuration_revision::text AS configuration_revision
  FROM module_instances WHERE tenant_id=$1 AND instance_id=$2`;

type RegistryCursorContext = { tenantId: string; callerId: string; filter: string };
function encodeInstanceCursor(at: string, id: string, context: RegistryCursorContext) {
  return Buffer.from(JSON.stringify({ ...context, at, id })).toString('base64url');
}
function decodeInstanceCursor(raw: string | undefined, context: RegistryCursorContext) {
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
    const cursor = decodeInstanceCursor(query.cursor, cursorContext);
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
      next_cursor: rows.length > limit ? encodeInstanceCursor(page[page.length - 1].cursor_at, page[page.length - 1].instance_id, cursorContext) : null,
      source_version: version && version !== '0' ? version : context.authorization_revision,
    });
  });
}

export async function readInstance(pool: Pool, actor: Actor, tenantId: string, instanceId: string) {
  return isolatedTransaction(pool, async q => {
    const context = await lockTenantScope(q, { actor, tenantId, forUpdate: false, capabilitiesForRole: moduleRegistryCapabilities });
    requireManage(context, false);
    const view = await instanceView(q, tenantId, instanceId);
    const dependencies = (await q.query(
      `SELECT requirement_key, provider_instance_id, version::text AS version
       FROM module_dependencies WHERE tenant_id=$1 AND caller_instance_id=$2 ORDER BY requirement_key`,
      [tenantId, instanceId],
    )).rows;
    await assertCurrentSessionClock(q, actor);
    return InstanceDetailSchema.parse({ ...view, dependencies });
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
  const cursor = decodeCursor(query.cursor);
  return isolatedTransaction(pool, async q => {
    const context = await lockTenantScope(q, { actor, tenantId, forUpdate: false, capabilitiesForRole: moduleRegistryCapabilities });
    requireManage(context, false);
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
      next_cursor: rows.length > limit ? encodeCursor(page[page.length - 1].cursor_at, page[page.length - 1].installation_id) : null,
      source_version: version && version !== '0' ? version : context.authorization_revision,
    });
  });
}

export async function installationByOperation(pool: Pool, actor: Actor, tenantId: string, operationId: string) {
  return isolatedTransaction(pool, async q => {
    const context = await lockTenantScope(q, { actor, tenantId, forUpdate: false, capabilitiesForRole: moduleRegistryCapabilities });
    requireManage(context, false);
    const row = (await q.query<{ installation_id: string }>(
      `SELECT installation_id FROM module_provision_operations WHERE tenant_id=$1 AND operation_id=$2`,
      [tenantId, operationId],
    )).rows[0];
    requireCondition(row, 404, 'not_found', '找不到這個應用安裝。');
    const view = await installationView(q, tenantId, row.installation_id);
    await assertCurrentSessionClock(q, actor);
    return view;
  });
}
