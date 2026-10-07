import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { TenantScopeContext } from '../../packages/resource-scopes/index.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import { readCapacityPolicy } from '../opportunity-project-work/tenant-capacity.js';
import { loadOfferedDefinition } from './catalog.js';
import { digestOf } from './canonical.js';
import {
  consumeInstanceReservations, installationFingerprintLock, lockWorkspace, releaseConcurrent, reserveCapacity,
} from './capacity.js';
import { journalCommand } from './events.js';
import { effectDigest, type ModuleProviderMap, type ProvisionEffect } from './providers.js';
import { assertFullGuildMember, candidatesFor, moduleDefinition, type StoredChoice } from './plans.js';
import type { Requirement } from './definitions.js';
import { planStale, mapRegistryError, sameContract } from './validate.js';

interface PlanRow {
  plan_id: string;
  tenant_id: string;
  guild_key: string;
  application_key: string;
  release_ref: string;
  workspace_id: string;
  installation_choice: 'reuse_existing' | 'create_new';
  existing_installation_id: string | null;
  configuration_digest: string;
  dependency_versions: StoredChoice[];
  policy_revision: string;
  version: string;
  expires_at: Date;
  consumed: boolean;
}

export interface LaunchResult {
  operation_id: string;
  installation_id: string;
  binding: { instance_id: string; version: string; binding_id: string } | null;
}

async function loadPlan(q: PoolClient, tenantId: string, planId: string): Promise<PlanRow> {
  const row = (await q.query<PlanRow>(
    `SELECT p.plan_id, p.tenant_id, p.guild_key, p.application_key, p.release_ref, p.workspace_id,
       p.installation_choice, p.existing_installation_id, p.configuration_digest, p.dependency_versions,
       p.policy_revision::text AS policy_revision, p.version::text AS version, p.expires_at,
       EXISTS (SELECT 1 FROM module_launch_plan_consumptions c WHERE c.plan_id=p.plan_id) AS consumed
     FROM module_launch_plans p WHERE p.plan_id=$1 AND p.tenant_id=$2 FOR UPDATE`,
    [planId, tenantId],
  )).rows[0];
  requireCondition(row, 404, 'not_found', '找不到這份啟動計畫。');
  return row;
}

async function assertMember(q: PoolClient, context: TenantScopeContext, userId: string, guildKey: string, lock: boolean) {
  await assertFullGuildMember(q, context.community_id, userId, guildKey, lock);
}

async function lockReusedInstances(q: PoolClient, tenantId: string, choices: StoredChoice[], versionMismatch: 'plan_stale' | 'version_conflict', unavailable: 'instance_unavailable' | 'not_found') {
  const reuseIds = choices.filter(choice => choice.choice === 'reuse' && choice.instance_id).map(choice => choice.instance_id!).sort();
  for (const instanceId of reuseIds) {
    const row = (await q.query<{ version: string; status: string; module_key: string; contract_ref: StoredChoice['contract_ref']; data_schema_version: string }>(
      `SELECT i.version::text AS version, i.status, i.module_key, i.contract_ref, i.data_schema_version
       FROM module_instances i
       WHERE i.tenant_id=$1 AND i.instance_id=$2 FOR SHARE`,
      [tenantId, instanceId],
    )).rows[0];
    const choice = choices.find(item => item.instance_id === instanceId);
    requireCondition(row && choice, 404, 'not_found', '找不到這個模組實例。');
    if (unavailable === 'not_found') {
      requireCondition(row.status === 'active' && row.module_key === choice.module_key, 404, 'not_found', '找不到這個模組實例。');
    } else if (row.status !== 'active') {
      throw new Problem(409, 'instance_unavailable', '這個模組實例目前無法使用。');
    }
    const deployment = (await q.query<{ any_deployment: boolean; live: boolean }>(
      `SELECT
         EXISTS (SELECT 1 FROM deployment_bindings b WHERE b.tenant_id=$1 AND b.instance_id=$2) AS any_deployment,
         EXISTS (SELECT 1 FROM deployment_bindings b WHERE b.tenant_id=$1 AND b.instance_id=$2 AND b.state='active') AS live`,
      [tenantId, instanceId],
    )).rows[0];
    if (deployment.any_deployment && !deployment.live) throw new Problem(409, 'instance_unavailable', '這個模組實例目前無法使用。');
    if (unavailable !== 'not_found') requireCondition(row.module_key === choice.module_key, 404, 'not_found', '找不到這個模組實例。');
    if (row.version !== choice.expected_version) {
      throw versionMismatch === 'version_conflict'
        ? new Problem(412, 'version_conflict', '模組實例版本已改變。')
        : planStale();
    }
    if (!sameContract(row.contract_ref, choice.contract_ref) || row.data_schema_version !== choice.data_schema_version) throw planStale();
  }
}

export async function executeLaunch(q: PoolClient, context: TenantScopeContext, actorUserId: string, input: {
  planId: string;
  expectedPlanVersion: string;
  configurationDigest: string;
  versionMismatch: 'plan_stale' | 'version_conflict';
  providers: ModuleProviderMap;
  operation: string;
  now?: Date;
}): Promise<LaunchResult> {
  const injected = input.now ?? null;
  const plan = await loadPlan(q, context.tenant_id, input.planId);
  const expired = (await q.query<{ expired: boolean }>(
    `SELECT expires_at <= COALESCE($2::timestamptz, clock_timestamp()) AS expired
     FROM module_launch_plans WHERE plan_id=$1 AND tenant_id=$3`,
    [plan.plan_id, injected, context.tenant_id],
  )).rows[0]?.expired === true;
  if (plan.consumed || expired) throw planStale();
  if (plan.version !== input.expectedPlanVersion) throw planStale();
  if (plan.configuration_digest !== input.configurationDigest) throw planStale();
  await assertMember(q, context, actorUserId, plan.guild_key, false);
  const definition = await loadOfferedDefinition(q, plan.guild_key, plan.application_key, plan.release_ref);
  await installationFingerprintLock(q, context.tenant_id, plan.workspace_id, plan.application_key);
  const policy = await readCapacityPolicy(q, context.tenant_id);
  if (!policy) throw new Problem(403, 'policy_unconfigured', '這個業務空間尚未設定容量政策。');
  if (policy.revision !== plan.policy_revision) throw planStale();
  const choices = plan.dependency_versions;
  const live = (await q.query<{ installation_id: string; provision_operation_id: string | null }>(
    `SELECT installation_id, provision_operation_id FROM application_installations
     WHERE tenant_id=$1 AND workspace_id=$2 AND application_key=$3 AND status NOT IN ('archived','failed')`,
    [context.tenant_id, plan.workspace_id, plan.application_key],
  )).rows[0];
  if (plan.installation_choice === 'create_new' && live) throw planStale();
  if (plan.installation_choice === 'reuse_existing' && (!live || live.installation_id !== plan.existing_installation_id)) throw planStale();

  if (plan.installation_choice === 'reuse_existing' && live) {
    await assertMember(q, context, actorUserId, plan.guild_key, true);
    return reuseInstallation(q, context, plan, live, input.operation);
  }

  const operationId = randomUUID();
  const installationId = randomUUID();
  const created = new Map<string, { instanceId: string; bindingId: string; effectKey: string }>();
  for (const choice of choices) {
    if (choice.choice !== 'create') continue;
    const provider = input.providers[choice.module_key];
    if (!provider) throw new Problem(409, 'application_not_available', '這個應用目前無法啟動。');
    created.set(choice.requirement_key, { instanceId: randomUUID(), bindingId: randomUUID(), effectKey: randomUUID() });
  }
  const sync = [...created.values()].every(row => {
    const choice = choices.find(item => created.get(item.requirement_key)?.instanceId === row.instanceId);
    return choice ? input.providers[choice.module_key]?.kind === 'transactional' : false;
  });
  try {
    await q.query(
      `INSERT INTO application_installations(
         installation_id, tenant_id, workspace_id, application_key, release_ref, configuration, configuration_digest,
         status, created_by_principal_id, origin_guild_key, provision_operation_id)
       VALUES($1,$2,$3,$4,$5,'{}'::jsonb,$6,$7,$8,$9,NULL)`,
      [installationId, context.tenant_id, plan.workspace_id, plan.application_key, plan.release_ref,
        plan.configuration_digest, sync ? 'active' : 'provisioning', context.principal_id, plan.guild_key],
    );
    await q.query(
      `INSERT INTO module_provision_operations(
         operation_id, tenant_id, installation_id, actor_principal_id, operation_kind, state, request_digest,
         plan_id, authorization_revision, policy_revision, accepted_at)
       VALUES($1,$2,$3,$4,'application.launch',$5,$6,$7,$8,$9,COALESCE($10::timestamptz, clock_timestamp()))`,
      [operationId, context.tenant_id, installationId, context.principal_id, sync ? 'succeeded' : 'running',
        plan.configuration_digest, plan.plan_id, context.authorization_revision, plan.policy_revision, injected],
    );
    const creates = choices.filter(choice => choice.choice === 'create').map(choice => ({ module_key: choice.module_key, count: 1 }));
    const lockedPolicy = await reserveCapacity(q, context.tenant_id, operationId, creates, true);
    if (lockedPolicy.revision !== plan.policy_revision) throw planStale();
    await lockReusedInstances(q, context.tenant_id, choices, input.versionMismatch, input.operation === 'manual.work.enable' ? 'not_found' : 'instance_unavailable');
    const requirements = definition.module_requirements as Requirement[];
    for (const choice of choices) {
      const requirement = requirements.find(item => item.requirement_key === choice.requirement_key);
      // A module that forbids reuse is never a candidate, so an existing instance does not stale a default create.
      if (!requirement?.allow_reuse) continue;
      if (choice.choice === 'create' && choice.origin === 'default') {
        const moduleDef = await moduleDefinition(q, requirement.module_key, requirement.module_release_ref);
        if ((await candidatesFor(q, context.tenant_id, requirement, moduleDef)).length) throw planStale();
      }
    }
    const workspaceStatus = await lockWorkspace(q, context.tenant_id, plan.workspace_id);
    requireCondition(workspaceStatus, 404, 'not_found', '找不到這個工作區。');
    requireCondition(workspaceStatus === 'active', 409, 'workspace_unavailable', '這個工作區目前無法使用。');
    await assertMember(q, context, actorUserId, plan.guild_key, true);
    let ordinal = 0;
    const instanceOf = (requirementKey: string) => {
      const choice = choices.find(item => item.requirement_key === requirementKey);
      if (!choice) throw planStale();
      if (choice.choice === 'reuse') return choice.instance_id!;
      return created.get(requirementKey)!.instanceId;
    };
    for (const choice of choices) {
      if (choice.choice !== 'create') continue;
      const ids = created.get(choice.requirement_key)!;
      const effect: ProvisionEffect = {
        effect_key: ids.effectKey,
        tenant_id: context.tenant_id,
        instance_id: ids.instanceId,
        module_key: choice.module_key,
        effect_digest: '',
      };
      effect.effect_digest = effectDigest(effect);
      const provider = input.providers[choice.module_key];
      const confirmed = provider.kind === 'transactional';
      await q.query(
        `INSERT INTO module_instances(
           instance_id, tenant_id, module_key, application_release_ref, module_release_ref, data_schema_version,
           contract_ref, status, binding_id, created_by_principal_id, origin_guild_key, provision_operation_id)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12)`,
        [ids.instanceId, context.tenant_id, choice.module_key, plan.release_ref, choice.module_release_ref,
          choice.data_schema_version, JSON.stringify(choice.contract_ref), confirmed ? 'active' : 'requested',
          ids.bindingId, context.principal_id, plan.guild_key, operationId],
      );
      await q.query(
        `INSERT INTO deployment_bindings(
           binding_id, tenant_id, instance_id, mode, environment, endpoint_ref, service_principal_id, contract_ref, state)
         VALUES($1,$2,$3,'hosted','hosted-shared',NULL,NULL,$4::jsonb,$5)`,
        [ids.bindingId, context.tenant_id, ids.instanceId, JSON.stringify(choice.contract_ref), confirmed ? 'active' : 'pending'],
      );
      await q.query(
        `INSERT INTO module_provision_steps(
           operation_id, step_key, ordinal, instance_id, tenant_id, provider_effect_key, state, evidence_ref, expected_authority_epoch)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,1)`,
        [operationId, `step-${ordinal}`, ordinal, ids.instanceId, context.tenant_id, ids.effectKey,
          confirmed ? 'confirmed' : 'pending', confirmed ? effect.effect_digest : null],
      );
      if (confirmed && provider.kind === 'transactional') await provider.initialise(q, effect);
      ordinal += 1;
    }
    for (const choice of choices) {
      await q.query(
        `INSERT INTO application_module_links(installation_id, requirement_key, tenant_id, instance_id, binding_selection)
         VALUES($1,$2,$3,$4,$5)`,
        [installationId, choice.requirement_key, context.tenant_id, instanceOf(choice.requirement_key), choice.choice === 'reuse' ? 'reuse' : 'create'],
      );
    }
    if (choices.length > 1) {
      const caller = choices[choices.length - 1];
      for (const providerChoice of choices.slice(0, -1)) {
        await q.query(
          `INSERT INTO module_dependencies(
             dependency_id, tenant_id, caller_instance_id, requirement_key, capability, provider_instance_id)
           VALUES($1,$2,$3,$4,$5,$6)`,
          [randomUUID(), context.tenant_id, instanceOf(caller.requirement_key), providerChoice.requirement_key,
            providerChoice.contract_ref ? (definition.module_requirements as { requirement_key: string; capabilities: string[] }[])
              .find(item => item.requirement_key === providerChoice.requirement_key)?.capabilities[0] ?? providerChoice.requirement_key
            : providerChoice.requirement_key,
            instanceOf(providerChoice.requirement_key)],
        );
      }
    }
    await q.query(
      `INSERT INTO module_launch_plan_consumptions(tenant_id, plan_id, operation_id) VALUES($1,$2,$3)`,
      [context.tenant_id, plan.plan_id, operationId],
    );
    let binding: LaunchResult['binding'] = null;
    if (sync) {
      await consumeInstanceReservations(q, context.tenant_id, operationId);
      await releaseConcurrent(q, context.tenant_id, operationId);
      binding = await bindEntry(q, context.tenant_id, plan.workspace_id, definition.entry_capability, choices, requirements, instanceOf);
      for (const choice of choices) {
        if (choice.choice !== 'create') continue;
        const ids = created.get(choice.requirement_key)!;
        await journalCommand(q, context, {
          aggregateType: 'module_instance', id: ids.instanceId, version: '1', operation: input.operation,
          eventType: 'freedom.module.instance.activated.v1',
          data: { instance_id: ids.instanceId, module_key: choice.module_key, binding_id: ids.bindingId, authority_epoch: '1', version: '1' },
        });
      }
    }
    await journalCommand(q, context, {
      aggregateType: 'application_launch', id: operationId, version: '1', operation: input.operation,
      eventType: 'freedom.application.launch.accepted.v1',
      data: { operation_id: operationId, installation_id: installationId, application_key: plan.application_key, release_ref: plan.release_ref },
    });
    await q.query(`UPDATE application_installations SET provision_operation_id=$2 WHERE installation_id=$1`, [installationId, operationId]);
    return { operation_id: operationId, installation_id: installationId, binding };
  } catch (error) {
    mapRegistryError(error);
  }
}

async function reuseInstallation(q: PoolClient, context: TenantScopeContext, plan: PlanRow, live: { installation_id: string; provision_operation_id: string | null }, operation: string): Promise<LaunchResult> {
  const operationId = randomUUID();
  await q.query(
    `INSERT INTO module_provision_operations(
       operation_id, tenant_id, installation_id, actor_principal_id, operation_kind, state, request_digest,
       plan_id, authorization_revision, policy_revision)
     VALUES($1,$2,$3,$4,'application.launch','succeeded',$5,$6,$7,$8)`,
    [operationId, context.tenant_id, live.installation_id, context.principal_id, plan.configuration_digest,
      plan.plan_id, context.authorization_revision, plan.policy_revision],
  );
  await q.query(
    `INSERT INTO module_launch_plan_consumptions(tenant_id, plan_id, operation_id) VALUES($1,$2,$3)`,
    [context.tenant_id, plan.plan_id, operationId],
  );
  let returned = live.provision_operation_id;
  if (!returned) {
    await q.query(`UPDATE application_installations SET provision_operation_id=$2 WHERE tenant_id=$3 AND installation_id=$1`,
      [live.installation_id, operationId, context.tenant_id]);
    returned = operationId;
  }
  await journalCommand(q, context, {
    aggregateType: 'application_launch', id: operationId, version: '1', operation,
    eventType: 'freedom.application.launch.accepted.v1',
    data: { operation_id: returned, installation_id: live.installation_id, application_key: plan.application_key, release_ref: plan.release_ref },
  });
  return { operation_id: returned, installation_id: live.installation_id, binding: null };
}

async function bindEntry(q: PoolClient, tenantId: string, workspaceId: string, entryCapability: string, choices: StoredChoice[], requirements: readonly { requirement_key: string; capabilities?: readonly string[] }[], instanceOf: (requirementKey: string) => string) {
  const declared = requirements.find(item => (item.capabilities ?? []).includes(entryCapability));
  if (!declared) return null;
  const requirement = choices.find(choice => choice.requirement_key === declared.requirement_key);
  if (!requirement) return null;
  const instanceId = instanceOf(requirement.requirement_key);
  const existing = (await q.query<{ instance_id: string; version: string; binding_id: string }>(
    `SELECT w.instance_id, w.version::text AS version, i.binding_id
     FROM workspace_module_bindings w
     JOIN module_instances i ON i.tenant_id=w.tenant_id AND i.instance_id=w.instance_id
     WHERE w.tenant_id=$1 AND w.workspace_id=$2 AND w.entry_capability=$3`,
    [tenantId, workspaceId, entryCapability],
  )).rows[0];
  if (existing) {
    if (existing.instance_id !== instanceId) throw new Problem(409, 'workspace_binding_conflict', '這個工作區已經綁定另一個工作實例。');
    return { instance_id: existing.instance_id, version: existing.version, binding_id: existing.binding_id };
  }
  await q.query(
    `INSERT INTO workspace_module_bindings(tenant_id, workspace_id, entry_capability, instance_id) VALUES($1,$2,$3,$4)`,
    [tenantId, workspaceId, entryCapability, instanceId],
  );
  const created = (await q.query<{ instance_id: string; version: string; binding_id: string }>(
    `SELECT w.instance_id, w.version::text AS version, i.binding_id
     FROM workspace_module_bindings w
     JOIN module_instances i ON i.tenant_id=w.tenant_id AND i.instance_id=w.instance_id
     WHERE w.tenant_id=$1 AND w.workspace_id=$2 AND w.entry_capability=$3`,
    [tenantId, workspaceId, entryCapability],
  )).rows[0];
  return created;
}

export async function entryBinding(q: PoolClient, tenantId: string, workspaceId: string) {
  return (await q.query<{ instance_id: string; version: string; binding_id: string }>(
    `SELECT w.instance_id, w.version::text AS version, i.binding_id
     FROM workspace_module_bindings w
     JOIN module_instances i ON i.tenant_id=w.tenant_id AND i.instance_id=w.instance_id
     WHERE w.tenant_id=$1 AND w.workspace_id=$2 AND w.entry_capability='work:create'`,
    [tenantId, workspaceId],
  )).rows[0] ?? null;
}
