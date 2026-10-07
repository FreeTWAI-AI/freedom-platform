import type { Pool, PoolClient } from 'pg';
import { OpaqueId } from '../../contracts/common/v1/identity.js';
import {
  EnableManualWorkSchema, LaunchpadContextSchema, ManualWorkBindingSchema,
  type ManualWorkBinding,
} from '../../contracts/guild-launchpad/v1/tenant-work.js';
import { LaunchInputSchema, PlanInputSchema as RegistryPlanInput } from '../../contracts/guild-launchpad/v1/module-registry.js';
import type { Actor } from '../identity-membership/service.js';
import { isWorkInstanceWritable, requireTenantCapability, tenantWorkCapabilities } from '../opportunity-project-work/tenant-capabilities.js';
import { readCapacityPolicy, requirePolicy, capacitySummary } from '../opportunity-project-work/tenant-capacity.js';
import { assertCurrentSessionClock } from '../../packages/db/member-session.js';
import { scopedTenantCommand } from '../../packages/scoped-commands/index.js';
import { lockTenantScope } from '../../packages/resource-scopes/index.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import { moduleRegistryCapabilities } from './capabilities.js';
import { installationFingerprintLock } from './capacity.js';
import { journalCommand } from './events.js';
import { MANUAL_WORKSPACE_RELEASE } from './definitions.js';
import { executeLaunch, entryBinding } from './launch.js';
import { assertFullGuildMember, createPlan, manualWorkCandidates } from './plans.js';
import { InstanceSelectionRequired } from './problems.js';
import { resolveProviders, type ModuleProviderMap } from './providers.js';
import { isolatedTransaction } from '../../packages/resource-scopes/tenant-transaction.js';
import { ModuleInstanceViewSchema, type ModuleInstanceView } from '../../contracts/guild-launchpad/v1/tenant-work.js';

export { suspendInstance, resumeInstance, archiveInstance } from './lifecycle.js';
export { listInstances, readInstance, listInstallations, installationByOperation } from './read.js';
export { advanceOperation, readOperation, reconcileOperation, cancelOperation, sweepDueOperations } from './operations.js';

function bindingView(tenantId: string, workspaceId: string, row: { instance_id: string; version: string; binding_id: string }, reused: boolean): ManualWorkBinding {
  return ManualWorkBindingSchema.parse({
    instance_id: row.instance_id, tenant_id: tenantId, workspace_id: workspaceId, binding_id: row.binding_id,
    version: row.version, entry_capability: 'work:create', reused,
  });
}

/** Already-bound workspaces return inside the command. The workspace row is locked only inside launch, after the installation fingerprint. */
export async function enableManualWork(pool: Pool, actor: Actor, tenantId: string, workspaceId: string, body: unknown, key: string) {
  OpaqueId.parse(tenantId);
  OpaqueId.parse(workspaceId);
  const input = EnableManualWorkSchema.parse(body);
  const providers = resolveProviders();
  return scopedTenantCommand(pool, {
    actor, tenantId, operation: 'manual.work.enable', key, tenantLock: 'share', body: input,
    target: { kind: 'tenant_workspace', id: workspaceId }, capabilitiesForRole: tenantWorkCapabilities,
  }, async (q, context) => {
    requireTenantCapability(context, 'instance.manage', true);
  }, async (q, context) => {
    requirePolicy(await readCapacityPolicy(q, tenantId));
    const catalog = await q.query('SELECT guild_key FROM positioning_guild_catalog WHERE guild_key=$1', [input.guild_key]);
    requireCondition(catalog.rowCount === 1, 404, 'guild_not_found', '找不到這個公會。');
    await assertFullGuildMember(q, context.community_id, actor.user_id, input.guild_key, false);
    const existing = await entryBinding(q, tenantId, workspaceId);
    if (existing) {
      if (input.choice?.kind === 'reuse' && input.choice.instance_id !== existing.instance_id) {
        throw new Problem(409, 'workspace_binding_conflict', '這個工作區已經綁定另一個工作實例。');
      }
      await assertFullGuildMember(q, context.community_id, actor.user_id, input.guild_key, true);
      return bindingView(tenantId, workspaceId, existing, true);
    }
    const workspace = (await q.query<{ status: string }>(
      `SELECT status FROM workspaces WHERE tenant_id=$1 AND workspace_id=$2`,
      [tenantId, workspaceId],
    )).rows[0];
    requireCondition(workspace, 404, 'not_found', '找不到這個工作區。');
    requireCondition(workspace.status === 'active', 409, 'workspace_unavailable', '這個工作區目前無法使用。');
    const options = await manualWorkCandidates(q, tenantId, input.guild_key);
    if (!input.choice && options.length > 0) throw new InstanceSelectionRequired(options);
    await installationFingerprintLock(q, tenantId, workspaceId, 'manual-workspace');
    const again = await entryBinding(q, tenantId, workspaceId);
    if (again) {
      if (input.choice?.kind === 'reuse' && input.choice.instance_id !== again.instance_id) {
        throw new Problem(409, 'workspace_binding_conflict', '這個工作區已經綁定另一個工作實例。');
      }
      await assertFullGuildMember(q, context.community_id, actor.user_id, input.guild_key, true);
      return bindingView(tenantId, workspaceId, again, true);
    }
    if (!input.choice) {
      const candidates = await manualWorkCandidates(q, tenantId, input.guild_key);
      if (candidates.length > 0) throw new InstanceSelectionRequired(candidates);
    }
    const dependencies = input.choice?.kind === 'reuse'
      ? [{ requirement_key: 'work', choice: 'reuse' as const, instance_id: input.choice.instance_id, expected_version: input.choice.expected_version }]
      : input.choice?.kind === 'create_new'
        ? [{ requirement_key: 'work', choice: 'create' as const, configuration: {} }]
        : [];
    const planBody = {
      guild_key: input.guild_key,
      workspace_id: workspaceId,
      application_key: 'manual-workspace',
      release_ref: MANUAL_WORKSPACE_RELEASE,
      installation_choice: 'create_new' as const,
      dependencies,
      configuration: {},
    };
    const plan = await createPlan(q, context, actor.user_id, planBody, { mode: 'facade', providers, membershipLock: 'defer' });
    const launched = await executeLaunch(q, context, actor.user_id, {
      planId: plan.plan_id,
      expectedPlanVersion: plan.version,
      configurationDigest: plan.configuration_digest.value,
      versionMismatch: 'version_conflict',
      providers,
      operation: 'manual.work.enable',
    });
    const bound = launched.binding ?? await entryBinding(q, tenantId, workspaceId);
    requireCondition(bound, 500, 'internal_error', '工作綁定沒有完成。');
    const view = bindingView(tenantId, workspaceId, bound, false);
    await journalCommand(q, context, {
      aggregateType: 'tenant_work', id: workspaceId, version: view.version, operation: 'manual.work.enable',
      data: { tenant_id: tenantId, workspace_id: workspaceId, instance_id: view.instance_id, binding_id: view.binding_id, reused: false },
    });
    return view;
  });
}

export async function planApplication(pool: Pool, actor: Actor, tenantId: string, body: unknown, key: string, providers?: ModuleProviderMap) {
  const input = RegistryPlanInput.parse(body);
  return scopedTenantCommand(pool, {
    actor, tenantId, operation: 'application.plan', key, tenantLock: 'share', body: input,
    target: { kind: 'tenant_workspace', id: input.workspace_id }, capabilitiesForRole: moduleRegistryCapabilities,
  }, async (q, context) => {
    requireTenantCapability(context, 'instance.manage', true);
  }, async (q, context) => createPlan(q, context, actor.user_id, input, { mode: 'general', providers: resolveProviders(providers) }));
}

export async function launchApplication(pool: Pool, actor: Actor, tenantId: string, body: unknown, key: string, providers?: ModuleProviderMap) {
  const input = LaunchInputSchema.parse(body);
  const workspaceId = await isolatedTransaction(pool, async q => {
    const context = await lockTenantScope(q, { actor, tenantId, forUpdate: false, capabilitiesForRole: moduleRegistryCapabilities });
    requireTenantCapability(context, 'instance.manage', true);
    const row = (await q.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM module_launch_plans WHERE plan_id=$1 AND tenant_id=$2`,
      [input.plan_id, tenantId],
    )).rows[0];
    requireCondition(row, 404, 'not_found', '找不到這份啟動計畫。');
    return row.workspace_id;
  });
  return scopedTenantCommand(pool, {
    actor, tenantId, operation: 'application.launch', key, tenantLock: 'share', body: input,
    target: { kind: 'tenant_workspace', id: workspaceId }, capabilitiesForRole: moduleRegistryCapabilities,
  }, async (q, context) => {
    requireTenantCapability(context, 'instance.manage', true);
  }, async (q, context) => {
    const launched = await executeLaunch(q, context, actor.user_id, {
      planId: input.plan_id,
      expectedPlanVersion: input.expected_plan_version,
      configurationDigest: input.configuration_digest.value,
      versionMismatch: 'plan_stale',
      providers: resolveProviders(providers),
      operation: 'application.launch',
    });
    return { operation_id: launched.operation_id };
  });
}

async function launchpadInstance(q: PoolClient, tenantId: string, instanceId: string): Promise<ModuleInstanceView | null> {
  const row = (await q.query(
    `SELECT instance_id, tenant_id, module_key, application_release_ref, data_schema_version, status, binding_id,
       authority_epoch::text AS authority_epoch, version::text AS version, configuration_revision::text AS configuration_revision
     FROM module_instances WHERE tenant_id=$1 AND instance_id=$2`,
    [tenantId, instanceId],
  )).rows[0];
  if (!row || !['provisioning', 'active', 'suspended', 'archived'].includes(row.status)) return null;
  return ModuleInstanceViewSchema.parse(row);
}

export async function readWorkspaceBinding(pool: Pool, actor: Actor, tenantId: string, workspaceId: string) {
  return isolatedTransaction(pool, async q => {
    const context = await lockTenantScope(q, { actor, tenantId, forUpdate: false, capabilitiesForRole: tenantWorkCapabilities });
    requireTenantCapability(context, 'work:read', false);
    const row = await entryBinding(q, tenantId, workspaceId);
    const view = row ? bindingView(tenantId, workspaceId, row, true) : null;
    await assertCurrentSessionClock(q, actor);
    return view;
  });
}

export async function launchpadContext(pool: Pool, actor: Actor, tenantId: string, workspaceId: string, guildKey: string, workPage: unknown) {
  OpaqueId.parse(tenantId);
  OpaqueId.parse(workspaceId);
  return isolatedTransaction(pool, async q => {
    const context = await lockTenantScope(q, { actor, tenantId, forUpdate: false, capabilitiesForRole: tenantWorkCapabilities });
    requireTenantCapability(context, 'work:read', false);
    const workspace = (await q.query<{ version: string; status: string }>(
      `SELECT version::text AS version, status FROM workspaces WHERE tenant_id=$1 AND workspace_id=$2`,
      [tenantId, workspaceId],
    )).rows[0];
    requireCondition(workspace, 404, 'not_found', '找不到這個工作區。');
    requireCondition(workspace.status === 'active', 409, 'workspace_unavailable', '這個工作區目前無法使用。');
    const catalog = await q.query('SELECT guild_key FROM positioning_guild_catalog WHERE guild_key=$1', [guildKey]);
    requireCondition(catalog.rowCount === 1, 404, 'guild_not_found', '找不到這個公會。');
    const instances = (await q.query<{ instance_id: string }>(
      `SELECT instance_id FROM module_instances WHERE tenant_id=$1 ORDER BY created_at, instance_id LIMIT 100`,
      [tenantId],
    )).rows;
    const views = [];
    for (const row of instances) {
      const view = await launchpadInstance(q, tenantId, row.instance_id);
      if (view) views.push(view);
    }
    const binding = await entryBinding(q, tenantId, workspaceId);
    const hosted = binding
      ? (await q.query(`SELECT 1 FROM deployment_bindings WHERE instance_id=$1 AND tenant_id=$2 AND mode='hosted' AND state='active'`, [binding.instance_id, tenantId])).rowCount === 1
      : false;
    const maxInstance = (await q.query<{ v: string | null }>(`SELECT max(version)::text AS v FROM module_instances WHERE tenant_id=$1`, [tenantId])).rows[0].v;
    const workSource = (workPage as { source_version: string }).source_version;
    const source = [workSource, maxInstance ?? '0', workspace.version].reduce((best, value) => BigInt(value) > BigInt(best) ? value : best, '1');
    const capacity_summary = await capacitySummary(q, context.scope.scope_id, tenantId);
    const body = LaunchpadContextSchema.parse({
      tenant_id: tenantId, workspace_id: workspaceId, source_version: source, instances: views, work_page: workPage,
      capacity_summary,
      workspace_binding: binding ? {
        instance_id: binding.instance_id, instance_status: binding.instance_status,
        writable: isWorkInstanceWritable(binding.instance_status, binding.deployment_state ?? undefined),
      } : null,
      connection_summary: binding && hosted ? [{ instance_id: binding.instance_id, status: 'hosted_active' }] : [],
    });
    await assertCurrentSessionClock(q, actor);
    return body;
  });
}
