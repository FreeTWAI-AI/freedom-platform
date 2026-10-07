import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  RegistryOperationSchema, ResumeInputSchema, SuspendInputSchema, type RegistryOperation,
} from '../../contracts/guild-launchpad/v1/module-registry.js';
import type { Actor } from '../identity-membership/service.js';
import { checkVersion } from '../../packages/db/index.js';
import { scopedTenantCommand } from '../../packages/scoped-commands/index.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import { readCapacityPolicy, requirePolicy } from '../opportunity-project-work/tenant-capacity.js';
import { moduleRegistryCapabilities } from './capabilities.js';
import { digestOf } from './canonical.js';
import { instanceUsage } from './capacity.js';
import { QuotaExceeded } from './problems.js';
import { isMemberSuspension } from './read.js';
import { journalCommand } from './events.js';
import { requireRegistryCapability } from './operations.js';

type LifecycleKind = 'module.instance.suspend' | 'module.instance.resume';

/** Instance first, then its current deployment; no capacity advisory on either side. */
async function lockInstance(q: PoolClient, tenantId: string, instanceId: string, expected: string) {
  const row = (await q.query<{ status: string; version: string; binding_id: string; module_key: string; suspension_operation_id: string | null }>(
    `SELECT status, version::text AS version, binding_id, module_key, suspension_operation_id
     FROM module_instances WHERE tenant_id=$1 AND instance_id=$2 FOR NO KEY UPDATE`,
    [tenantId, instanceId],
  )).rows[0];
  requireCondition(row, 404, 'not_found', '找不到這個模組實例。');
  checkVersion(row.version, expected);
  return row;
}

async function transition(pool: Pool, actor: Actor, tenantId: string, instanceId: string, expected: string,
  key: string, operation: LifecycleKind, body: { reason: string } | Record<string, never>): Promise<RegistryOperation> {
  const suspend = operation === 'module.instance.suspend';
  return scopedTenantCommand(pool, {
    actor, tenantId, operation, key, tenantLock: 'share', body,
    target: { kind: 'module_instance', id: instanceId }, expected, capabilitiesForRole: moduleRegistryCapabilities,
  }, async (_q, context) => {
    requireRegistryCapability(context, operation, true);
  }, async (q, context) => {
    // This is intentionally an unlocked read before the instance lock. Taking
    // the policy advisory would cycle with Work and launch's opposite orders.
    const policy = suspend ? null : await readCapacityPolicy(q, tenantId);
    const instance = await lockInstance(q, tenantId, instanceId, expected);
    if (suspend && instance.status !== 'active') {
      throw new Problem(409, 'instance_not_active', '只有使用中的模組實例可以暫停。');
    }
    if (!suspend && instance.status !== 'suspended') {
      throw new Problem(409, 'instance_not_suspended', '這個模組實例沒有暫停。');
    }
    const binding = (await q.query<{ state: string }>(
      `SELECT state FROM deployment_bindings
       WHERE tenant_id=$1 AND instance_id=$2 AND binding_id=$3 FOR NO KEY UPDATE`,
      [tenantId, instanceId, instance.binding_id],
    )).rows[0];
    if (suspend) {
      requireCondition(binding?.state === 'active', 409, 'instance_not_active', '只有使用中的模組實例可以暫停。');
      const pending = (await q.query<{ pending: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM module_provision_operations o
           WHERE o.tenant_id=$1 AND o.operation_kind='application.launch'
             AND o.state IN ('requested','running','needs_reconciliation')
             AND (EXISTS (SELECT 1 FROM module_provision_steps s
                    WHERE s.tenant_id=o.tenant_id AND s.operation_id=o.operation_id AND s.instance_id=$2)
               OR EXISTS (SELECT 1 FROM application_module_links l
                    WHERE l.tenant_id=o.tenant_id AND l.installation_id=o.installation_id AND l.instance_id=$2))
         ) AS pending`,
        [tenantId, instanceId],
      )).rows[0].pending;
      requireCondition(!pending, 409, 'operation_pending', '這個模組實例還有未完成的啟用操作，請等它完成或先處理。');
    } else {
      const memberSuspension = instance.suspension_operation_id && (await q.query(
        `SELECT operation_id FROM module_provision_operations
         WHERE tenant_id=$1 AND operation_id=$2 AND instance_id=$3 AND operation_kind='module.instance.suspend'`,
        [tenantId, instance.suspension_operation_id, instanceId],
      )).rows[0];
      requireCondition(isMemberSuspension(memberSuspension, binding?.state), 409, 'instance_security_hold', '這個模組實例由平台暫停，不能自行恢復。');
      // Preserve the instance's uniform 404 and CAS/state errors even without
      // a policy; the policy snapshot was still read before either row lock.
      const currentPolicy = requirePolicy(policy);
      // Suspended instances already count: equality is legal, but a lowered
      // limit must refuse resume. These reads do not reserve additional usage.
      if (await instanceUsage(q, tenantId) > BigInt(currentPolicy.max_active_instances)) {
        throw new QuotaExceeded('module_instances');
      }
      if (await instanceUsage(q, tenantId, instance.module_key) > BigInt(currentPolicy.max_instances_per_module)) {
        throw new QuotaExceeded(`module_instances.${instance.module_key}`);
      }
    }
    const operationId = randomUUID();
    const reason = suspend ? body.reason : null;
    await q.query(
      `INSERT INTO module_provision_operations(operation_id,tenant_id,actor_principal_id,operation_kind,state,
         request_digest,authorization_revision,policy_revision,instance_id,reason,version)
       VALUES($1,$2,$3,$4,'succeeded',$5,$6,$7,$8,$9,1)`,
      [operationId, tenantId, context.principal_id, operation,
        digestOf({ operation, tenant_id: tenantId, instance_id: instanceId, expected, body }),
        context.authorization_revision, policy?.revision ?? null, instanceId, reason],
    );
    const status = suspend ? 'suspended' : 'active';
    const updated = (await q.query<{ version: string }>(
      `UPDATE module_instances SET status=$3, suspension_operation_id=$4, version=version+1
       WHERE tenant_id=$1 AND instance_id=$2 RETURNING version::text AS version`,
      [tenantId, instanceId, status, suspend ? operationId : null],
    )).rows[0];
    await q.query(
      `UPDATE deployment_bindings SET state=$4, version=version+1
       WHERE tenant_id=$1 AND instance_id=$2 AND binding_id=$3`,
      [tenantId, instanceId, instance.binding_id, status],
    );
    await journalCommand(q, context, {
      aggregateType: 'module_instance_status', id: instanceId, version: updated.version, operation,
      eventType: 'freedom.module.instance.status_changed.v1',
      data: { instance_id: instanceId, status, version: updated.version },
    });
    return RegistryOperationSchema.parse({ operation_id: operationId, state: 'succeeded', version: '1' });
  }, async (_q, context) => {
    // The command adapter runs this before returning any stored receipt too.
    requireRegistryCapability(context, operation, true);
  });
}

export function suspendInstance(pool: Pool, actor: Actor, tenantId: string, instanceId: string,
  expected: string, key: string, input: unknown): Promise<RegistryOperation> {
  return transition(pool, actor, tenantId, instanceId, expected, key, 'module.instance.suspend', SuspendInputSchema.parse(input));
}

export function resumeInstance(pool: Pool, actor: Actor, tenantId: string, instanceId: string,
  expected: string, key: string, input: unknown): Promise<RegistryOperation> {
  return transition(pool, actor, tenantId, instanceId, expected, key, 'module.instance.resume', ResumeInputSchema.parse(input));
}
