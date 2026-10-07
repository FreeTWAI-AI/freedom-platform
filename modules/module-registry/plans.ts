import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { InstanceCandidateSchema, type InstanceCandidate } from '../../contracts/guild-launchpad/v1/tenant-work.js';
import {
  DependencyChoiceSchema, LaunchPlanSchema, PlanInputSchema,
  type LaunchPlan,
} from '../../contracts/guild-launchpad/v1/module-registry.js';
import type { TenantScopeContext } from '../../packages/resource-scopes/index.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import { readCapacityPolicy } from '../opportunity-project-work/tenant-capacity.js';
import { assertGuildKey, loadOfferedDefinition } from './catalog.js';
import { canonicalJson, digestOf } from './canonical.js';
import { PLAN_TTL_MS, type ContractRef, type Requirement } from './definitions.js';
import { DependencySelectionRequired, InstanceSelectionRequired } from './problems.js';
import type { ModuleProviderMap } from './providers.js';
import { assertConfiguration, coversCapabilities, planStale, sameContract } from './validate.js';

const INSTANCE_UNAVAILABLE = () => new Problem(409, 'instance_unavailable', '這個模組實例目前無法使用。');

export interface StoredChoice {
  requirement_key: string;
  module_key: string;
  module_release_ref: string;
  choice: 'reuse' | 'create';
  origin: 'explicit' | 'default';
  instance_id?: string;
  expected_version?: string;
  configuration: Record<string, never>;
  contract_ref: ContractRef;
  data_schema_version: string;
  config_schema_ref: string;
}

interface ModuleDefinitionRow {
  release_ref: string;
  capabilities: string[];
  contract_ref: ContractRef;
  data_schema_version: string;
  config_schema_ref: string;
  license_state: string;
  release_status: string;
}

interface CandidateRow {
  instance_id: string;
  version: string;
  created_at: Date;
  contract_ref: ContractRef;
  data_schema_version: string;
  module_release_ref: string;
  capabilities: string[];
  bound_workspace_count: number;
}

/** `lock` takes FOR SHARE. Callers that still have a wait ahead must pass false and lock again after that wait. */
export async function assertFullGuildMember(q: PoolClient, communityId: string, userId: string, guildKey: string, lock: boolean) {
  await assertGuildKey(q, guildKey);
  const member = await q.query(
    `SELECT 1 FROM positioning_profession_memberships
     WHERE community_id=$1 AND user_id=$2 AND guild_key=$3 AND state='active' AND member_tier='full'${lock ? ' FOR SHARE' : ''}`,
    [communityId, userId, guildKey],
  );
  requireCondition(member.rowCount === 1, 403, 'guild_full_member_required', '需要這個公會的正式會員身分。');
}

async function workspaceStatus(q: PoolClient, tenantId: string, workspaceId: string) {
  const row = (await q.query<{ status: string }>(
    `SELECT status FROM workspaces WHERE tenant_id=$1 AND workspace_id=$2`,
    [tenantId, workspaceId],
  )).rows[0];
  requireCondition(row, 404, 'not_found', '找不到這個工作區。');
  requireCondition(row.status === 'active', 409, 'workspace_unavailable', '這個工作區目前無法使用。');
}

async function moduleDefinition(q: PoolClient, moduleKey: string, releaseRef: string | undefined): Promise<ModuleDefinitionRow> {
  if (!releaseRef) throw new Problem(409, 'application_not_available', '這個應用目前無法啟動。');
  const row = (await q.query<ModuleDefinitionRow>(
    `SELECT release_ref, capabilities, contract_ref, data_schema_version, config_schema_ref, license_state, release_status
     FROM module_definitions WHERE module_key=$1 AND release_ref=$2`,
    [moduleKey, releaseRef],
  )).rows[0];
  if (!row) throw new Problem(409, 'application_not_available', '這個應用目前無法啟動。');
  if (row.license_state !== 'reviewed') throw new Problem(409, 'license_unresolved', '這個應用的授權尚未完成審查。');
  if (row.release_status !== 'available') throw new Problem(409, 'application_not_available', '這個應用目前無法啟動。');
  return row;
}

async function candidatesFor(q: PoolClient, tenantId: string, requirement: Requirement, definition: ModuleDefinitionRow): Promise<CandidateRow[]> {
  const rows = (await q.query<CandidateRow>(
    `SELECT i.instance_id, i.version::text AS version, i.created_at, i.contract_ref, i.data_schema_version, i.module_release_ref,
       d.capabilities,
       (SELECT count(*)::int FROM workspace_module_bindings b WHERE b.tenant_id=i.tenant_id AND b.instance_id=i.instance_id) AS bound_workspace_count
     FROM module_instances i
     JOIN module_definitions d ON d.module_key=i.module_key AND d.release_ref=i.module_release_ref
     WHERE i.tenant_id=$1 AND i.module_key=$2 AND i.status='active'
       AND (
         NOT EXISTS (SELECT 1 FROM deployment_bindings b WHERE b.tenant_id=i.tenant_id AND b.instance_id=i.instance_id)
         OR EXISTS (SELECT 1 FROM deployment_bindings b WHERE b.tenant_id=i.tenant_id AND b.instance_id=i.instance_id AND b.state='active')
       )
     ORDER BY i.created_at, i.instance_id`,
    [tenantId, requirement.module_key],
  )).rows;
  return rows.filter(row => sameContract(row.contract_ref, definition.contract_ref)
    && requirement.compatible_contracts.some(contract => sameContract(contract, row.contract_ref))
    && row.data_schema_version === definition.data_schema_version
    && coversCapabilities(row.capabilities, requirement.capabilities));
}

function workCandidates(rows: CandidateRow[]): InstanceCandidate[] {
  return rows.map(row => InstanceCandidateSchema.parse({
    instance_id: row.instance_id,
    version: row.version,
    created_at: row.created_at.toISOString(),
    bound_workspace_count: row.bound_workspace_count,
  }));
}

export async function createPlan(
  q: PoolClient,
  context: TenantScopeContext,
  actorUserId: string,
  body: unknown,
  options: { mode: 'general' | 'facade'; providers: ModuleProviderMap; membershipLock?: 'defer' },
): Promise<LaunchPlan> {
  const input = PlanInputSchema.parse(body);
  await assertFullGuildMember(q, context.community_id, actorUserId, input.guild_key, false);
  await workspaceStatus(q, context.tenant_id, input.workspace_id);
  const definition = await loadOfferedDefinition(q, input.guild_key, input.application_key, input.release_ref);
  assertConfiguration(input.configuration ?? {}, definition.customization_schema_ref);
  const policy = await readCapacityPolicy(q, context.tenant_id);
  if (!policy) throw new Problem(403, 'policy_unconfigured', '這個業務空間尚未設定容量政策。');
  const requirements = definition.module_requirements as Requirement[];
  requireCondition(requirements.length > 0 && requirements.length <= 20, 409, 'application_not_available', '這個應用目前無法啟動。');
  const explicit = new Map(input.dependencies.map(choice => [choice.requirement_key, choice]));
  for (const choice of input.dependencies) {
    requireCondition(requirements.some(requirement => requirement.requirement_key === choice.requirement_key), 422, 'validation_failed', '這個應用沒有這個依賴。');
  }
  const live = (await q.query<{ installation_id: string }>(
    `SELECT installation_id FROM application_installations
     WHERE tenant_id=$1 AND workspace_id=$2 AND application_key=$3 AND status NOT IN ('archived','failed')`,
    [context.tenant_id, input.workspace_id, input.application_key],
  )).rows[0];
  let existingInstallationId: string | null = null;
  if (input.installation_choice === 'reuse_existing') {
    requireCondition(input.existing_installation_id, 409, 'installation_selection_required', '這個工作區已經有這個應用，請改為沿用現有安裝。');
    requireCondition(live && live.installation_id === input.existing_installation_id, 409, 'installation_selection_required', '這個工作區已經有這個應用，請改為沿用現有安裝。');
    existingInstallationId = live.installation_id;
  } else if (live) {
    throw new Problem(409, 'installation_selection_required', '這個工作區已經有這個應用，請改為沿用現有安裝。');
  }
  const choices: StoredChoice[] = [];
  const dependencyCandidates: { requirement_key: string; instance_id: string; version: string; created_at: string }[] = [];
  let facadeCandidates: InstanceCandidate[] | null = null;
  for (const requirement of requirements) {
    const moduleDef = await moduleDefinition(q, requirement.module_key, requirement.module_release_ref);
    if (!requirement.compatible_contracts.some(contract => sameContract(contract, moduleDef.contract_ref))) {
      throw new Problem(409, 'application_not_available', '這個應用目前無法啟動。');
    }
    if (!coversCapabilities(moduleDef.capabilities, requirement.capabilities)) {
      throw new Problem(409, 'application_not_available', '這個應用目前無法啟動。');
    }
    const provider = options.providers[requirement.module_key];
    if (!provider) throw new Problem(409, 'application_not_available', '這個應用目前無法啟動。');
    const found = requirement.allow_reuse ? await candidatesFor(q, context.tenant_id, requirement, moduleDef) : [];
    const picked = explicit.get(requirement.requirement_key);
    let choice: StoredChoice['choice'];
    let origin: StoredChoice['origin'];
    let instanceId: string | undefined;
    let expectedVersion: string | undefined;
    if (picked?.choice === 'reuse') {
      requireCondition(requirement.allow_reuse, 409, 'application_not_available', '這個應用目前無法啟動。');
      const held = (await q.query<{ status: string; any_deployment: boolean; live_deployment: boolean }>(
        `SELECT i.status,
           EXISTS (SELECT 1 FROM deployment_bindings b WHERE b.tenant_id=i.tenant_id AND b.instance_id=i.instance_id) AS any_deployment,
           EXISTS (SELECT 1 FROM deployment_bindings b WHERE b.tenant_id=i.tenant_id AND b.instance_id=i.instance_id AND b.state='active') AS live_deployment
         FROM module_instances i WHERE i.tenant_id=$1 AND i.instance_id=$2`,
        [context.tenant_id, picked.instance_id],
      )).rows[0];
      if (held && held.status !== 'active') {
        if (options.mode === 'facade') throw new Problem(404, 'not_found', '找不到這個模組實例。');
        throw INSTANCE_UNAVAILABLE();
      }
      if (held && held.any_deployment && !held.live_deployment) throw INSTANCE_UNAVAILABLE();
      const match = found.find(row => row.instance_id === picked.instance_id);
      requireCondition(match, 404, 'not_found', '找不到這個模組實例。');
      const mismatch = options.mode === 'facade' ? 'version_conflict' : 'plan_stale';
      if (match.version !== picked.expected_version) {
        throw mismatch === 'version_conflict'
          ? new Problem(412, 'version_conflict', '模組實例版本已改變。')
          : planStale();
      }
      choice = 'reuse';
      origin = 'explicit';
      instanceId = match.instance_id;
      expectedVersion = match.version;
    } else if (picked?.choice === 'create') {
      assertConfiguration(picked.configuration ?? {}, moduleDef.config_schema_ref);
      choice = 'create';
      origin = 'explicit';
    } else if (!requirement.allow_reuse || found.length === 0) {
      choice = 'create';
      origin = 'default';
    } else if (options.mode === 'facade') {
      facadeCandidates = workCandidates(found);
      throw new InstanceSelectionRequired(facadeCandidates);
    } else if (found.length === 1) {
      choice = 'reuse';
      origin = 'default';
      instanceId = found[0].instance_id;
      expectedVersion = found[0].version;
    } else {
      for (const row of found) {
        dependencyCandidates.push({
          requirement_key: requirement.requirement_key,
          instance_id: row.instance_id,
          version: row.version,
          created_at: row.created_at.toISOString(),
        });
      }
      continue;
    }
    choices.push({
      requirement_key: requirement.requirement_key,
      module_key: requirement.module_key,
      module_release_ref: moduleDef.release_ref,
      choice,
      origin,
      instance_id: instanceId,
      expected_version: expectedVersion,
      configuration: {},
      contract_ref: moduleDef.contract_ref,
      data_schema_version: moduleDef.data_schema_version,
      config_schema_ref: moduleDef.config_schema_ref,
    });
  }
  if (dependencyCandidates.length) throw new DependencySelectionRequired(dependencyCandidates);
  if (existingInstallationId) {
    const links = (await q.query<{ requirement_key: string; instance_id: string }>(
      `SELECT requirement_key, instance_id FROM application_module_links WHERE installation_id=$1 AND tenant_id=$2`,
      [existingInstallationId, context.tenant_id],
    )).rows;
    requireCondition(links.length === choices.length, 409, 'installation_selection_required', '這個工作區已經有這個應用，請改為沿用現有安裝。');
    for (const link of links) {
      const choice = choices.find(item => item.requirement_key === link.requirement_key);
      requireCondition(choice?.choice === 'reuse' && choice.instance_id === link.instance_id, 409, 'installation_selection_required', '這個工作區已經有這個應用，請改為沿用現有安裝。');
    }
  }
  const creates = choices.filter(choice => choice.choice === 'create');
  const capacityDelta = [];
  if (creates.length) {
    capacityDelta.push({ dimension: 'module_instances', units: String(creates.length) });
    for (const choice of creates) capacityDelta.push({ dimension: `module_instances.${choice.module_key}`, units: '1' });
  }
  if (input.installation_choice === 'create_new') capacityDelta.push({ dimension: 'concurrent_provisions', units: '1' });
  const warnings = choices.map(choice => ({
    code: choice.choice === 'reuse' ? 'reuse_existing_data' : 'creates_empty_instance',
    requirement_key: choice.requirement_key,
  }));
  const wireChoices = choices.map(choice => choice.choice === 'reuse'
    ? { requirement_key: choice.requirement_key, choice: 'reuse' as const, instance_id: choice.instance_id, expected_version: choice.expected_version }
    : { requirement_key: choice.requirement_key, choice: 'create' as const, configuration: {} });
  const configurationDigest = digestOf(input.configuration ?? {});
  const selectionDigest = digestOf(wireChoices);
  const planId = randomUUID();
  const inserted = (await q.query<{ version: string; expires_at: Date }>(
    `INSERT INTO module_launch_plans(
       plan_id, tenant_id, actor_principal_id, guild_key, application_key, release_ref, workspace_id,
       installation_choice, existing_installation_id, configuration, configuration_digest, selection_digest,
       dependency_versions, warnings, capacity_delta, policy_revision, expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::jsonb,$14::jsonb,$15::jsonb,$16,clock_timestamp()+make_interval(secs=>$17))
     RETURNING version::text AS version, expires_at`,
    [
      planId, context.tenant_id, context.principal_id, input.guild_key, input.application_key, input.release_ref,
      input.workspace_id, input.installation_choice, existingInstallationId, canonicalJson(input.configuration ?? {}),
      configurationDigest, selectionDigest, JSON.stringify(choices), JSON.stringify(warnings), JSON.stringify(capacityDelta),
      policy.revision, Math.floor(PLAN_TTL_MS / 1000),
    ],
  )).rows[0];
  if (options.membershipLock !== 'defer') {
    await assertFullGuildMember(q, context.community_id, actorUserId, input.guild_key, true);
  }
  return LaunchPlanSchema.parse({
    plan_id: planId,
    version: inserted.version,
    tenant_id: context.tenant_id,
    workspace_id: input.workspace_id,
    application_key: input.application_key,
    release_ref: input.release_ref,
    expires_at: inserted.expires_at.toISOString(),
    policy_revision: policy.revision,
    choices: wireChoices.map(choice => DependencyChoiceSchema.parse(choice)),
    capacity_delta: capacityDelta,
    warnings,
    configuration_digest: { algorithm: 'sha256', value: configurationDigest },
  });
}
