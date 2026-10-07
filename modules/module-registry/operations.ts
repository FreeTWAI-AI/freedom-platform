import type { Pool, PoolClient } from 'pg';
import { RegistryOperationSchema, type RegistryOperation } from '../../contracts/guild-launchpad/v1/module-registry.js';
import type { Actor } from '../identity-membership/service.js';
import { scopedTenantCommand } from '../../packages/scoped-commands/index.js';
import { checkVersion } from '../../packages/db/index.js';
import { assertCurrentSessionClock } from '../../packages/db/member-session.js';
import { lockTenantScope, type TenantScopeContext } from '../../packages/resource-scopes/index.js';
import { bindTenantContext, isolatedTransaction } from '../../packages/resource-scopes/tenant-transaction.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import { readCapacityPolicy } from '../opportunity-project-work/tenant-capacity.js';
import { moduleRegistryCapabilities } from './capabilities.js';
import {
  consumeInstanceReservations, lockWorkspace, markReservationsUnknown, releaseConcurrent, releaseReservationUnits,
} from './capacity.js';
import { MAX_STEP_ATTEMPTS, STEP_LEASE_MS, STEP_WINDOW_MS } from './definitions.js';
import { journalExecutor } from './events.js';
import { sha256Hex } from './canonical.js';
import { effectDigest, type ModuleProvider, type ModuleProviderMap, type ProvisionEffect, defaultModuleProviders } from './providers.js';
const NOT_CANCELLABLE = () => new Problem(409, 'operation_not_cancellable', '這個操作已經結束，不能取消。');
const CONTEXT_UNAVAILABLE = '租戶交易內容目前無法使用。';

/** Executor paths have no member. Bind this tenant before the first tenant-table statement. */
async function bindExecutorTenant(q: PoolClient, tenantId: string): Promise<void> {
  const scope = (await q.query<{ scope_id: string }>(
    `SELECT scope_id FROM resource_scopes WHERE kind='tenant' AND tenant_ref=$1`,
    [tenantId],
  )).rows[0];
  if (!scope) throw new Problem(500, 'tenant_context_unavailable', CONTEXT_UNAVAILABLE);
  await bindTenantContext(q, { tenantId, tenantScopeId: scope.scope_id });
}

function sweepFailureName(error: unknown): string {
  return error instanceof Problem ? error.code : error instanceof Error ? error.name : 'Error';
}

interface OperationRow {
  operation_id: string;
  tenant_id: string;
  installation_id: string;
  actor_principal_id: string;
  state: RegistryOperation['state'];
  version: string;
  accepted_at: Date;
  cancel_requested_at: Date | null;
  policy_revision: string;
  terminal_problem: { code: string; detail: string } | null;
  workspace_id: string;
  application_key: string;
  release_ref: string;
  entry_capability: string;
}

interface StepRow {
  step_key: string;
  ordinal: number;
  instance_id: string;
  module_key: string;
  provider_effect_key: string;
  state: string;
  attempt_count: number;
  lease_fence: number;
  evidence_ref: string | null;
  expected_authority_epoch: string;
  authority_epoch: string;
}

function requireRegistryCapability(context: TenantScopeContext, capability: string, write: boolean) {
  if (write && context.tenant_status !== 'active') throw new Problem(403, 'capability_denied', '目前無法使用這個業務空間。');
  requireCondition(context.capabilities.includes(capability), 403, 'capability_denied', '目前沒有這個操作的權限。');
}

function operationView(row: OperationRow): RegistryOperation {
  return RegistryOperationSchema.parse({
    operation_id: row.operation_id,
    state: row.state,
    version: row.version,
    ...(row.terminal_problem ? { problem: row.terminal_problem } : {}),
  });
}

async function readOperationRow(q: PoolClient, operationId: string, tenantId?: string): Promise<OperationRow> {
  const row = (await q.query<OperationRow>(
    `SELECT o.operation_id, o.tenant_id, o.installation_id, o.actor_principal_id, o.state, o.version::text AS version,
       o.accepted_at, o.cancel_requested_at, o.policy_revision::text AS policy_revision, o.terminal_problem,
       i.workspace_id, i.application_key, i.release_ref, d.entry_capability
     FROM module_provision_operations o
     JOIN application_installations i ON i.tenant_id=o.tenant_id AND i.installation_id=o.installation_id
     JOIN application_definitions d ON d.application_key=i.application_key AND d.release_ref=i.release_ref
     WHERE o.operation_id=$1 AND ($2::uuid IS NULL OR o.tenant_id=$2)`,
    [operationId, tenantId ?? null],
  )).rows[0];
  requireCondition(row, 404, 'not_found', '找不到這個操作。');
  return row;
}

async function actorState(q: PoolClient, tenantId: string, principalId: string) {
  const tenant = (await q.query<{ status: string }>(
    `SELECT status FROM tenants WHERE tenant_id=$1 FOR SHARE`,
    [tenantId],
  )).rows[0];
  const member = (await q.query<{ role: string; status: string }>(
    `SELECT role, status FROM tenant_memberships WHERE tenant_id=$1 AND principal_id=$2 FOR SHARE`,
    [tenantId, principalId],
  )).rows[0];
  const policy = await readCapacityPolicy(q, tenantId);
  const allowed = tenant?.status === 'active' && member?.status === 'active' && (member.role === 'owner' || member.role === 'admin') && !!policy;
  return { allowed, denied: !member || member.status !== 'active' || (member.role !== 'owner' && member.role !== 'admin') || tenant?.status !== 'active' };
}

function backoffMs(operationId: string, attempt: number) {
  const base = 10_000 * 2 ** Math.max(0, attempt - 1);
  const jitter = Number.parseInt(sha256Hex(`${operationId}:${attempt}`).slice(0, 4), 16) % 1000;
  return base + jitter;
}

async function stepsOf(q: PoolClient, operationId: string, tenantId: string): Promise<StepRow[]> {
  return (await q.query<StepRow>(
    `SELECT s.step_key, s.ordinal, s.instance_id, i.module_key, s.provider_effect_key, s.state, s.attempt_count,
       s.lease_fence, s.evidence_ref, s.expected_authority_epoch::text AS expected_authority_epoch,
       i.authority_epoch::text AS authority_epoch
     FROM module_provision_steps s
     JOIN module_instances i ON i.tenant_id=s.tenant_id AND i.instance_id=s.instance_id
     WHERE s.operation_id=$1 AND s.tenant_id=$2
     ORDER BY s.ordinal`,
    [operationId, tenantId],
  )).rows;
}

async function setInstance(q: PoolClient, tenantId: string, instanceId: string, status: string, principalId?: string) {
  const updated = (await q.query<{ version: string }>(
    `UPDATE module_instances SET status=$3, version=version+1
     WHERE tenant_id=$1 AND instance_id=$2 AND status IS DISTINCT FROM $3
     RETURNING version::text AS version`,
    [tenantId, instanceId, status],
  )).rows[0];
  const bindingState = status === 'active' ? 'active' : 'retired';
  await q.query(
    `UPDATE deployment_bindings SET state=$3, version=version+1
     WHERE tenant_id=$1 AND instance_id=$2 AND state IS DISTINCT FROM $3 AND state <> 'retired'`,
    [tenantId, instanceId, bindingState],
  );
  if (updated && principalId) {
    await journalExecutor(q, tenantId, principalId, {
      aggregateType: 'module_instance_status', id: instanceId, version: updated.version,
      eventType: 'freedom.module.instance.status_changed.v1',
      data: { instance_id: instanceId, status, version: updated.version },
    });
  }
}

async function releaseInstanceUnits(q: PoolClient, tenantId: string, operationId: string, moduleKey: string) {
  await releaseReservationUnits(q, tenantId, operationId, 'module_instances', 1n);
  await releaseReservationUnits(q, tenantId, operationId, `module_instances.${moduleKey}`, 1n);
}

async function retain(q: PoolClient, tenantId: string, installationId: string) {
  const rows = (await q.query<{ instance_id: string }>(
    `SELECT i.instance_id FROM application_module_links l
     JOIN module_instances i ON i.tenant_id=l.tenant_id AND i.instance_id=l.instance_id
     WHERE l.tenant_id=$1 AND l.installation_id=$2 AND i.status='active'
     ORDER BY i.instance_id`,
    [tenantId, installationId],
  )).rows;
  return rows.map(row => row.instance_id);
}

async function finishOperation(q: PoolClient, row: OperationRow, state: OperationRow['state'], problem?: { code: string; detail: string }) {
  const updated = (await q.query<OperationRow>(
    `UPDATE module_provision_operations
     SET state=$3, version=version+1, updated_at=clock_timestamp(), terminal_problem=$4::jsonb
     WHERE operation_id=$1 AND tenant_id=$2
     RETURNING version::text AS version, state, terminal_problem`,
    [row.operation_id, row.tenant_id, state, problem ? JSON.stringify(problem) : null],
  )).rows[0];
  row.state = updated.state;
  row.version = updated.version;
  row.terminal_problem = updated.terminal_problem;
  if (state === 'succeeded') {
    await consumeInstanceReservations(q, row.tenant_id, row.operation_id);
    await releaseConcurrent(q, row.tenant_id, row.operation_id);
    await q.query(
      `UPDATE application_installations SET status='active', provision_operation_id=$2, version=version+1
       WHERE tenant_id=$1 AND installation_id=$3 AND status IS DISTINCT FROM 'active'`,
      [row.tenant_id, row.operation_id, row.installation_id],
    );
    await ensureEntryBinding(q, row);
  } else if (state === 'failed' || state === 'cancelled') {
    const kept = await retain(q, row.tenant_id, row.installation_id);
    await q.query(
      `UPDATE application_installations SET status=$3, retained_instance_ids=$4::jsonb, version=version+1
       WHERE tenant_id=$1 AND installation_id=$2`,
      [row.tenant_id, row.installation_id, state === 'cancelled' && kept.length === 0 ? 'archived' : 'failed', JSON.stringify(kept)],
    );
    await consumeInstanceReservations(q, row.tenant_id, row.operation_id);
    await releaseConcurrent(q, row.tenant_id, row.operation_id);
  }
}

async function bumpOperationVersion(q: PoolClient, row: OperationRow) {
  const updated = (await q.query<{ version: string }>(
    `UPDATE module_provision_operations SET version=version+1, updated_at=clock_timestamp()
     WHERE operation_id=$1 AND tenant_id=$2
     RETURNING version::text AS version`,
    [row.operation_id, row.tenant_id],
  )).rows[0];
  row.version = updated.version;
}

/** The entry requirement is the one whose capabilities include `entry_capability`. */
async function ensureEntryBinding(q: PoolClient, row: OperationRow) {
  const requirement = (await q.query<{ module_key: string }>(
    `SELECT req->>'module_key' AS module_key
     FROM application_definitions d
     CROSS JOIN LATERAL jsonb_array_elements(d.module_requirements) AS req
     WHERE d.application_key=$1 AND d.release_ref=$2
       AND jsonb_typeof(req->'capabilities')='array'
       AND jsonb_exists(req->'capabilities', $3)
     LIMIT 1`,
    [row.application_key, row.release_ref, row.entry_capability],
  )).rows[0];
  if (!requirement?.module_key) return;
  const instance = (await q.query<{ instance_id: string }>(
    `SELECT l.instance_id FROM application_module_links l
     JOIN module_instances i ON i.tenant_id=l.tenant_id AND i.instance_id=l.instance_id
     WHERE l.tenant_id=$1 AND l.installation_id=$2 AND i.module_key=$3 AND i.status='active'
     LIMIT 1`,
    [row.tenant_id, row.installation_id, requirement.module_key],
  )).rows[0];
  if (!instance) return;
  await lockWorkspace(q, row.tenant_id, row.workspace_id);
  const existing = (await q.query<{ instance_id: string }>(
    `SELECT instance_id FROM workspace_module_bindings WHERE tenant_id=$1 AND workspace_id=$2 AND entry_capability=$3`,
    [row.tenant_id, row.workspace_id, row.entry_capability],
  )).rows[0];
  if (existing) {
    if (existing.instance_id !== instance.instance_id) {
      await finishOperation(q, row, 'failed', { code: 'workspace_binding_conflict', detail: '這個工作區已經綁定另一個工作實例。' });
    }
    return;
  }
  await q.query(
    `INSERT INTO workspace_module_bindings(tenant_id, workspace_id, entry_capability, instance_id) VALUES($1,$2,$3,$4)`,
    [row.tenant_id, row.workspace_id, row.entry_capability, instance.instance_id],
  );
}

async function closeUndispatched(q: PoolClient, row: OperationRow, steps: StepRow[], status: 'failed' | 'archived', problem: { code: string; detail: string }) {
  for (const step of steps) {
    if (step.state !== 'pending') continue;
    await q.query(
      `UPDATE module_provision_steps SET state='failed_known', problem=$3::jsonb WHERE operation_id=$1 AND step_key=$2`,
      [row.operation_id, step.step_key, JSON.stringify(problem)],
    );
    await setInstance(q, row.tenant_id, step.instance_id, status, row.actor_principal_id);
    await releaseInstanceUnits(q, row.tenant_id, row.operation_id, step.module_key);
    step.state = 'failed_known';
  }
}

/** Pending steps are archived and their units released. Confirmed instances stay active and finishOperation consumes what remains. */
async function settleCancelled(q: PoolClient, row: OperationRow, steps: StepRow[]) {
  await closeUndispatched(q, row, steps, 'archived', { code: 'member_cancelled', detail: '這個操作已取消。' });
  await finishOperation(q, row, 'cancelled');
}

export interface AdvanceOptions {
  providers?: ModuleProviderMap;
  clock?: () => Date;
  budget?: number;
}

export async function advanceOperation(pool: Pool, tenantId: string, operationId: string, options: AdvanceOptions = {}) {
  const providers = options.providers ?? defaultModuleProviders();
  const budget = options.budget ?? 3000;
  const deadline = Date.now() + budget;
  const injected = () => options.clock ? options.clock() : null;
  do {
    const claimed = await isolatedTransaction(pool, async q => {
      await bindExecutorTenant(q, tenantId);
      return claimStep(q, tenantId, operationId, providers, injected());
    });
    if (!claimed || claimed.kind === 'stop') return;
    if (claimed.kind !== 'apply') continue;
    let outcome: 'confirmed' | 'failed_known' | 'unknown' | 'thrown' = 'thrown';
    try { outcome = await claimed.provider.apply(claimed.effect); } catch { outcome = 'thrown'; }
    if (outcome === 'thrown') continue;
    await isolatedTransaction(pool, async q => {
      await bindExecutorTenant(q, tenantId);
      await recordOutcome(q, claimed, outcome, providers);
    });
  } while (Date.now() < deadline);
}

interface ClaimedApply {
  kind: 'apply';
  operation: OperationRow;
  step: StepRow;
  fence: number;
  provider: Extract<ModuleProvider, { kind: 'async' }>;
  effect: ProvisionEffect;
}

async function claimStep(q: PoolClient, tenantId: string, operationId: string, providers: ModuleProviderMap, now: Date | null): Promise<{ kind: 'stop' } | { kind: 'local' } | ClaimedApply | null> {
  const peeked = (await q.query<{ tenant_id: string; actor_principal_id: string }>(
    `SELECT tenant_id, actor_principal_id FROM module_provision_operations WHERE operation_id=$1 AND tenant_id=$2`,
    [operationId, tenantId],
  )).rows[0];
  if (!peeked) return null;
  const gate = await actorState(q, peeked.tenant_id, peeked.actor_principal_id);
  const row = await readOperationRow(q, operationId, peeked.tenant_id);
  await q.query(`SELECT operation_id FROM module_provision_operations WHERE operation_id=$1 FOR UPDATE`, [operationId]);
  if (!['requested', 'running', 'needs_reconciliation'].includes(row.state)) return { kind: 'stop' };
  const steps = await stepsOf(q, operationId, row.tenant_id);
  if (!gate.allowed) {
    await closeUndispatched(q, row, steps, 'failed', { code: 'capability_denied', detail: '目前沒有這個操作的權限。' });
    const open = steps.some(step => step.state === 'dispatched' || step.state === 'unknown');
    if (open) await markNeedsReconciliation(q, row, steps.find(step => step.state === 'unknown' || step.state === 'dispatched') ?? steps[0], 'capability_denied');
    else await finishOperation(q, row, 'failed', { code: 'capability_denied', detail: '目前沒有這個操作的權限。' });
    return { kind: 'stop' };
  }
  if (row.cancel_requested_at) {
    const open = steps.some(step => step.state === 'dispatched' || step.state === 'unknown');
    if (open) return { kind: 'stop' };
    await settleCancelled(q, row, steps);
    return { kind: 'stop' };
  }
  const expiredWindow = (await q.query<{ expired: boolean }>(
    `SELECT COALESCE($2::timestamptz, clock_timestamp()) > accepted_at + make_interval(secs => $3) AS expired
     FROM module_provision_operations WHERE operation_id=$1`,
    [operationId, now, STEP_WINDOW_MS / 1000],
  )).rows[0]?.expired === true;
  const due = (await q.query<{ step_key: string }>(
    `SELECT step_key FROM module_provision_steps
     WHERE operation_id=$1 AND tenant_id=$2 AND (
       (state='pending' AND next_attempt_at <= COALESCE($3::timestamptz, clock_timestamp()))
       OR (state='dispatched' AND lease_expires_at <= COALESCE($3::timestamptz, clock_timestamp())))
     ORDER BY ordinal FOR UPDATE SKIP LOCKED LIMIT 1`,
    [operationId, row.tenant_id, now],
  )).rows[0];
  if (!due) return { kind: 'stop' };
  const step = steps.find(item => item.step_key === due.step_key)!;
  if (step.attempt_count >= MAX_STEP_ATTEMPTS || expiredWindow) {
    await markNeedsReconciliation(q, row, step, 'attempt_limit');
    return { kind: 'stop' };
  }
  if (step.expected_authority_epoch !== step.authority_epoch) {
    await q.query(
      `UPDATE module_provision_steps SET state='failed_known', problem=$3::jsonb WHERE operation_id=$1 AND step_key=$2`,
      [operationId, step.step_key, JSON.stringify({ code: 'authority_changed', detail: '模組實例的授權世代已改變。' })],
    );
    await setInstance(q, row.tenant_id, step.instance_id, 'failed', row.actor_principal_id);
    await releaseInstanceUnits(q, row.tenant_id, operationId, step.module_key);
    await finishOperation(q, row, 'failed', { code: 'authority_changed', detail: '模組實例的授權世代已改變。' });
    return { kind: 'stop' };
  }
  const provider = providers[step.module_key];
  const fence = step.lease_fence + 1;
  await q.query(
    `UPDATE module_provision_steps
     SET state='dispatched', lease_fence=$3,
       lease_expires_at=COALESCE($4::timestamptz, clock_timestamp()) + make_interval(secs => $5),
       attempt_count=attempt_count+1,
       next_attempt_at=COALESCE($4::timestamptz, clock_timestamp()) + make_interval(secs => $5)
     WHERE operation_id=$1 AND step_key=$2`,
    [operationId, step.step_key, fence, now, STEP_LEASE_MS / 1000],
  );
  await q.query(
    `UPDATE module_instances SET status='provisioning', version=version+1 WHERE tenant_id=$1 AND instance_id=$2 AND status='requested'`,
    [row.tenant_id, step.instance_id],
  );
  const effect: ProvisionEffect = {
    effect_key: step.provider_effect_key,
    tenant_id: row.tenant_id,
    instance_id: step.instance_id,
    module_key: step.module_key,
    effect_digest: step.evidence_ref ?? effectDigest({
      effect_key: step.provider_effect_key,
      tenant_id: row.tenant_id,
      instance_id: step.instance_id,
      module_key: step.module_key,
    }),
  };
  if (!step.evidence_ref) {
    await q.query(`UPDATE module_provision_steps SET evidence_ref=$3 WHERE operation_id=$1 AND step_key=$2`, [operationId, step.step_key, effect.effect_digest]);
  }
  if (!provider) {
    await q.query(`UPDATE module_provision_steps SET state='unknown' WHERE operation_id=$1 AND step_key=$2`, [operationId, step.step_key]);
    await markNeedsReconciliation(q, row, step, 'provider_missing');
    return { kind: 'local' };
  }
  if (provider.kind === 'transactional') {
    await provider.initialise(q, effect);
    await applyConfirmed(q, row, step, effect.effect_digest);
    return { kind: 'local' };
  }
  return { kind: 'apply', operation: row, step, fence, provider, effect };
}

async function recordOutcome(q: PoolClient, claimed: ClaimedApply, outcome: 'confirmed' | 'failed_known' | 'unknown', providers: ModuleProviderMap) {
  const gate = await actorState(q, claimed.operation.tenant_id, claimed.operation.actor_principal_id);
  const row = await readOperationRow(q, claimed.operation.operation_id, claimed.operation.tenant_id);
  await q.query(`SELECT operation_id FROM module_provision_operations WHERE operation_id=$1 FOR UPDATE`, [row.operation_id]);
  const updated = await q.query(
    `UPDATE module_provision_steps SET lease_fence=lease_fence WHERE operation_id=$1 AND step_key=$2 AND lease_fence=$3`,
    [row.operation_id, claimed.step.step_key, claimed.fence],
  );
  if (updated.rowCount !== 1) return;
  if (!gate.allowed) {
    await q.query(`UPDATE module_provision_steps SET state='unknown' WHERE operation_id=$1 AND step_key=$2`, [row.operation_id, claimed.step.step_key]);
    await markReservationsUnknown(q, row.tenant_id, row.operation_id);
    await markNeedsReconciliation(q, row, claimed.step, 'capability_denied');
    return;
  }
  if (outcome === 'confirmed') {
    await applyConfirmed(q, row, claimed.step, claimed.effect.effect_digest);
    return;
  }
  if (outcome === 'unknown') {
    await q.query(`UPDATE module_provision_steps SET state='unknown' WHERE operation_id=$1 AND step_key=$2`, [row.operation_id, claimed.step.step_key]);
    await markReservationsUnknown(q, row.tenant_id, row.operation_id);
    await markNeedsReconciliation(q, row, claimed.step, 'effect_unknown');
    return;
  }
  const steps = await stepsOf(q, row.operation_id, row.tenant_id);
  await settleKnownFailure(q, row, steps, claimed.step.step_key, providers);
}

async function applyConfirmed(q: PoolClient, row: OperationRow, step: StepRow, digest: string) {
  const updated = await q.query(
    `UPDATE module_provision_steps SET state='confirmed', evidence_ref=$3, result_digest=$3
     WHERE operation_id=$1 AND step_key=$2 AND state IN ('unknown','pending','dispatched')`,
    [row.operation_id, step.step_key, digest],
  );
  if ((updated.rowCount ?? 0) !== 1) return;
  await setInstance(q, row.tenant_id, step.instance_id, 'active');
  await bumpOperationVersion(q, row);
  const version = (await q.query<{ version: string; binding_id: string; authority_epoch: string }>(
    `SELECT version::text AS version, binding_id, authority_epoch::text AS authority_epoch
     FROM module_instances WHERE tenant_id=$1 AND instance_id=$2`,
    [row.tenant_id, step.instance_id],
  )).rows[0];
  await journalExecutor(q, row.tenant_id, row.actor_principal_id, {
    aggregateType: 'module_instance', id: step.instance_id, version: version.version,
    eventType: 'freedom.module.instance.activated.v1',
    data: { instance_id: step.instance_id, module_key: step.module_key, binding_id: version.binding_id, authority_epoch: version.authority_epoch, version: version.version },
  });
  const rest = await stepsOf(q, row.operation_id, row.tenant_id);
  if (rest.every(item => item.state === 'confirmed' || item.step_key === step.step_key)) {
    await finishOperation(q, row, 'succeeded');
  } else if (row.state === 'requested') {
    await q.query(`UPDATE module_provision_operations SET state='running', updated_at=clock_timestamp() WHERE operation_id=$1 AND state='requested'`, [row.operation_id]);
  }
}

async function settleKnownFailure(q: PoolClient, row: OperationRow, steps: StepRow[], failedKey: string, providers: ModuleProviderMap) {
  const problem = JSON.stringify({ code: 'failed_known', detail: '這個模組沒有完成啟動。' });
  for (const step of steps) {
    if (step.state === 'unknown' || (step.state === 'dispatched' && step.step_key !== failedKey)) continue;
    if (step.state === 'failed_known' || step.state === 'compensated' || step.state === 'compensating') continue;
    if (step.state === 'confirmed') {
      const keep = await providers[step.module_key]?.hasMemberData(q, step.instance_id) ?? false;
      if (keep) continue;
      await q.query(
        `UPDATE module_provision_steps SET state='compensated', problem=$3::jsonb WHERE operation_id=$1 AND step_key=$2`,
        [row.operation_id, step.step_key, problem],
      );
      await setInstance(q, row.tenant_id, step.instance_id, 'archived', row.actor_principal_id);
      await releaseInstanceUnits(q, row.tenant_id, row.operation_id, step.module_key);
      continue;
    }
    if (step.state !== 'pending' && step.step_key !== failedKey) continue;
    const keep = step.step_key === failedKey && (await providers[step.module_key]?.hasMemberData(q, step.instance_id) ?? false);
    await q.query(
      `UPDATE module_provision_steps SET state='failed_known', problem=$3::jsonb WHERE operation_id=$1 AND step_key=$2`,
      [row.operation_id, step.step_key, problem],
    );
    if (keep) await setInstance(q, row.tenant_id, step.instance_id, 'active', row.actor_principal_id);
    else {
      await setInstance(q, row.tenant_id, step.instance_id, 'archived', row.actor_principal_id);
      await releaseInstanceUnits(q, row.tenant_id, row.operation_id, step.module_key);
    }
  }
  const open = (await stepsOf(q, row.operation_id, row.tenant_id)).some(step => step.state === 'dispatched' || step.state === 'unknown');
  if (!open) await finishOperation(q, row, 'failed', { code: 'failed_known', detail: '這個模組沒有完成啟動。' });
}

async function markNeedsReconciliation(q: PoolClient, row: OperationRow, step: StepRow, reason: string) {
  if (row.state === 'needs_reconciliation') return;
  const updated = (await q.query<{ version: string }>(
    `UPDATE module_provision_operations SET state='needs_reconciliation', version=version+1, updated_at=clock_timestamp(),
       terminal_problem=$3::jsonb
     WHERE operation_id=$1 AND tenant_id=$2 AND state IN ('requested','running','needs_reconciliation')
     RETURNING version::text AS version`,
    [row.operation_id, row.tenant_id, JSON.stringify({ code: reason, detail: '這個操作需要對帳後才能繼續。' })],
  )).rows[0];
  if (!updated) return;
  row.state = 'needs_reconciliation';
  row.version = updated.version;
  await journalExecutor(q, row.tenant_id, row.actor_principal_id, {
    aggregateType: 'module_provision', id: row.operation_id, version: updated.version,
    eventType: 'freedom.module.provision.reconciliation_required.v1',
    data: { operation_id: row.operation_id, instance_id: step.instance_id, step_key: step.step_key, reason_code: reason },
  });
}

export async function sweepDueOperations(pool: Pool, clock?: () => Date, providers: ModuleProviderMap = defaultModuleProviders()) {
  const now = clock ? clock() : null;
  const scopes = await isolatedTransaction(pool, async q => (await q.query<{ tenant_ref: string; scope_id: string }>(
    `SELECT tenant_ref, scope_id FROM resource_scopes
     WHERE kind='tenant' AND tenant_ref IS NOT NULL
     ORDER BY tenant_ref`,
  )).rows);
  const due: { tenantId: string; operationId: string }[] = [];
  for (const scope of scopes) {
    if (due.length >= 50) break;
    try {
      const ids = await isolatedTransaction(pool, async q => {
        await bindTenantContext(q, { tenantId: scope.tenant_ref, tenantScopeId: scope.scope_id });
        return (await q.query<{ operation_id: string }>(
          `SELECT DISTINCT o.operation_id
           FROM module_provision_operations o
           JOIN module_provision_steps s ON s.operation_id=o.operation_id AND s.tenant_id=o.tenant_id
           WHERE o.tenant_id=$2
             AND o.state IN ('requested','running','needs_reconciliation')
             AND ((s.state='pending' AND s.next_attempt_at <= COALESCE($1::timestamptz, clock_timestamp()))
               OR (s.state='dispatched' AND s.lease_expires_at <= COALESCE($1::timestamptz, clock_timestamp())))
           ORDER BY o.operation_id
           LIMIT $3`,
          [now, scope.tenant_ref, 50 - due.length],
        )).rows.map(row => row.operation_id);
      });
      for (const operationId of ids) due.push({ tenantId: scope.tenant_ref, operationId });
    } catch (error) {
      console.error('module_provision_sweep_operation_failed', sweepFailureName(error));
    }
  }
  for (const item of due) {
    try { await advanceOperation(pool, item.tenantId, item.operationId, { providers, clock, budget: 3000 }); }
    catch (error) {
      console.error('module_provision_sweep_operation_failed', sweepFailureName(error));
    }
  }
}

export async function readOperation(pool: Pool, actor: Actor, tenantId: string, operationId: string): Promise<RegistryOperation> {
  return isolatedTransaction(pool, async q => {
    const context = await lockTenantScope(q, { actor, tenantId, forUpdate: false, capabilitiesForRole: moduleRegistryCapabilities });
    requireRegistryCapability(context, 'module.operation.read', false);
    const view = operationView(await readOperationRow(q, operationId, tenantId));
    await assertCurrentSessionClock(q, actor);
    return view;
  });
}

export async function reconcileOperation(pool: Pool, actor: Actor, tenantId: string, operationId: string, expected: string, key: string, providers: ModuleProviderMap): Promise<RegistryOperation> {
  const prepared = await isolatedTransaction(pool, async q => {
    const context = await lockTenantScope(q, { actor, tenantId, forUpdate: false, capabilitiesForRole: moduleRegistryCapabilities });
    requireRegistryCapability(context, 'module.operation.reconcile', true);
    const row = await readOperationRow(q, operationId, tenantId);
    checkVersion(row.version, expected);
    if (['succeeded', 'failed', 'cancelled'].includes(row.state)) return { kind: 'done' as const, view: operationView(row) };
    const steps = (await stepsOf(q, operationId, tenantId)).filter(step => step.state === 'unknown');
    return { kind: 'open' as const, steps };
  });
  if (prepared.kind === 'done') return prepared.view;
  const lookups: { step: StepRow; status: string; owner_tenant_id?: string; effect_digest?: string }[] = [];
  for (const step of prepared.steps) {
    const provider = providers[step.module_key];
    if (!provider || provider.kind !== 'async') {
      lookups.push({ step, status: 'unreachable' });
      continue;
    }
    const found = await provider.lookup(step.provider_effect_key);
    lookups.push({ step, status: found.status, owner_tenant_id: found.status === 'found' ? found.owner_tenant_id : undefined, effect_digest: found.status === 'found' ? found.effect_digest : undefined });
  }
  return scopedTenantCommand(pool, {
    actor, tenantId, operation: 'module.provision.reconcile', key, tenantLock: 'share', body: {},
    target: { kind: 'module_operation', id: operationId }, expected, capabilitiesForRole: moduleRegistryCapabilities,
  }, async (q, context) => {
    requireRegistryCapability(context, 'module.operation.reconcile', true);
  }, async (q, context) => {
    void context;
    await q.query(`SELECT operation_id FROM module_provision_operations WHERE operation_id=$1 FOR UPDATE`, [operationId]);
    const row = await readOperationRow(q, operationId, tenantId);
    checkVersion(row.version, expected);
    for (const lookup of lookups) {
      const locked = (await q.query<{ state: string }>(
        `SELECT state FROM module_provision_steps WHERE operation_id=$1 AND tenant_id=$2 AND step_key=$3 FOR UPDATE`,
        [operationId, tenantId, lookup.step.step_key],
      )).rows[0];
      if (!locked || locked.state !== 'unknown') continue;
      const digest = lookup.step.evidence_ref ?? effectDigest({
        effect_key: lookup.step.provider_effect_key, tenant_id: tenantId, instance_id: lookup.step.instance_id, module_key: lookup.step.module_key,
      });
      if (lookup.status === 'found' && lookup.owner_tenant_id === tenantId && lookup.effect_digest === digest) {
        await applyConfirmed(q, row, lookup.step, digest);
      } else if (lookup.status === 'found') {
        await q.query(
          `UPDATE module_provision_operations SET terminal_problem=$2::jsonb, state='needs_reconciliation', version=version+1, updated_at=clock_timestamp()
           WHERE operation_id=$1`,
          [operationId, JSON.stringify({ code: 'effect_identity_conflict', detail: '外部效果的身分與這次操作不一致。' })],
        );
        row.state = 'needs_reconciliation';
      } else if (lookup.status === 'absent') {
        const attempt = lookup.step.attempt_count;
        if (attempt >= MAX_STEP_ATTEMPTS) await markNeedsReconciliation(q, row, lookup.step, 'attempt_limit');
        else {
          const reset = await q.query(
            `UPDATE module_provision_steps
             SET state='pending', next_attempt_at=COALESCE($3::timestamptz, clock_timestamp()) + make_interval(secs => $4)
             WHERE operation_id=$1 AND step_key=$2 AND state='unknown'`,
            [operationId, lookup.step.step_key, null, backoffMs(operationId, Math.max(1, attempt)) / 1000],
          );
          if ((reset.rowCount ?? 0) === 1) await bumpOperationVersion(q, row);
        }
      }
    }
    return operationView(await readOperationRow(q, operationId, tenantId));
  });
}

export async function cancelOperation(pool: Pool, actor: Actor, tenantId: string, operationId: string, expected: string, key: string, reason: string): Promise<RegistryOperation> {
  requireCondition(reason === 'member_cancelled', 422, 'validation_failed', '取消原因無效。');
  return scopedTenantCommand(pool, {
    actor, tenantId, operation: 'module.provision.cancel', key, tenantLock: 'share', body: { reason },
    target: { kind: 'module_operation', id: operationId }, expected, capabilitiesForRole: moduleRegistryCapabilities,
  }, async (q, context) => {
    requireRegistryCapability(context, 'module.operation.reconcile', true);
  }, async q => {
    const row = await readOperationRow(q, operationId, tenantId);
    await q.query(`SELECT operation_id FROM module_provision_operations WHERE operation_id=$1 FOR UPDATE`, [operationId]);
    checkVersion(row.version, expected);
    if (['succeeded', 'failed', 'cancelled'].includes(row.state)) throw NOT_CANCELLABLE();
    const steps = await stepsOf(q, operationId, tenantId);
    const blocked = steps.some(step => step.state === 'confirmed' || step.state === 'dispatched' || step.state === 'unknown');
    if (blocked) {
      await q.query(
        `UPDATE module_provision_operations SET cancel_requested_at=COALESCE(cancel_requested_at, clock_timestamp()), version=version+1, updated_at=clock_timestamp()
         WHERE operation_id=$1 AND tenant_id=$2`,
        [operationId, tenantId],
      );
      return operationView(await readOperationRow(q, operationId, tenantId));
    }
    await settleCancelled(q, row, steps);
    return operationView(await readOperationRow(q, operationId, tenantId));
  });
}
