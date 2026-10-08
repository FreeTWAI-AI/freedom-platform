import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { lockCapacityPolicy, requirePolicy, type TenantCapacityPolicy } from '../opportunity-project-work/tenant-capacity.js';
import { QuotaExceeded } from './problems.js';

const HOLDING = `('reserved','consumed','unknown')`;

/** Sorted per-tenant dimension locks. Callers must not lock these in any other order. */
export async function lockCapacityDimensions(q: PoolClient, tenantId: string, dimensions: readonly string[]) {
  for (const dimension of [...dimensions].sort()) {
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`module-registry/capacity/v1/${tenantId}/${dimension}`]);
  }
}

export async function installationFingerprintLock(q: PoolClient, tenantId: string, workspaceId: string, applicationKey: string) {
  await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `module-registry/installation/v1/${tenantId}/${workspaceId}/${applicationKey}`,
  ]);
}

/**
 * Workspace row lock shared by launch and the executor's entry binding.
 * FOR NO KEY UPDATE does not conflict with the FOR KEY SHARE an installation
 * or plan insert takes through the workspace foreign key, so this lock stays
 * after those inserts. Callers still take it only after the installation
 * fingerprint and the capacity locks. See README for the full order.
 */
export async function lockWorkspace(q: PoolClient, tenantId: string, workspaceId: string): Promise<string | undefined> {
  const row = (await q.query<{ status: string }>(
    `SELECT status FROM workspaces WHERE tenant_id=$1 AND workspace_id=$2 FOR NO KEY UPDATE`,
    [tenantId, workspaceId],
  )).rows[0];
  return row?.status;
}

export async function instanceUsage(q: PoolClient, tenantId: string, moduleKey?: string): Promise<bigint> {
  const row = (await q.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM module_instances
     WHERE tenant_id=$1 AND status IN ('requested','provisioning','active','suspended')
       AND ($2::text IS NULL OR module_key=$2)`,
    [tenantId, moduleKey ?? null],
  )).rows[0];
  return BigInt(row.n);
}

async function concurrentUsage(q: PoolClient, tenantId: string, exceptOperationId?: string): Promise<bigint> {
  const row = (await q.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM module_provision_operations
     WHERE tenant_id=$1 AND operation_kind='application.launch' AND state IN ('requested','running','needs_reconciliation')
       AND ($2::uuid IS NULL OR operation_id <> $2)`,
    [tenantId, exceptOperationId ?? null],
  )).rows[0];
  return BigInt(row.n);
}

export interface ReservationRequest {
  dimension: string;
  units: bigint;
  limit: bigint;
  usage: bigint;
}

/** Check and reserve under the policy share lock and sorted dimension locks. The caller already holds the installation lock. */
export async function reserveCapacity(q: PoolClient, tenantId: string, operationId: string, creates: readonly { module_key: string; count: number }[], includeConcurrent: boolean): Promise<TenantCapacityPolicy> {
  const policy = requirePolicy(await lockCapacityPolicy(q, tenantId));
  const requests: ReservationRequest[] = [];
  const createsByModule = new Map<string, number>();
  for (const item of creates) {
    createsByModule.set(item.module_key, (createsByModule.get(item.module_key) ?? 0) + item.count);
  }
  const instanceUnits = creates.reduce((sum, item) => sum + item.count, 0);
  if (instanceUnits > 0) {
    requests.push({
      dimension: 'module_instances',
      units: BigInt(instanceUnits),
      limit: BigInt(policy.max_active_instances),
      usage: await instanceUsage(q, tenantId),
    });
    for (const [moduleKey, count] of createsByModule) {
      if (count < 1) continue;
      requests.push({
        dimension: `module_instances.${moduleKey}`,
        units: BigInt(count),
        limit: BigInt(policy.max_instances_per_module),
        usage: await instanceUsage(q, tenantId, moduleKey),
      });
    }
  }
  if (includeConcurrent) {
    requests.push({
      dimension: 'concurrent_provisions',
      units: 1n,
      limit: BigInt(policy.max_concurrent_provisions),
      usage: await concurrentUsage(q, tenantId, operationId),
    });
  }
  const dimensions = requests.map(item => item.dimension);
  await lockCapacityDimensions(q, tenantId, dimensions);
  for (const item of requests) {
    const usage = item.dimension === 'concurrent_provisions'
      ? await concurrentUsage(q, tenantId, operationId)
      : item.dimension === 'module_instances'
        ? await instanceUsage(q, tenantId)
        : await instanceUsage(q, tenantId, item.dimension.slice('module_instances.'.length));
    if (usage + item.units > item.limit) throw new QuotaExceeded(item.dimension);
    item.usage = usage;
  }
  for (const item of requests) {
    await q.query(
      `INSERT INTO capacity_reservations(reservation_id, tenant_id, operation_id, dimension, units, policy_revision, state)
       VALUES($1,$2,$3,$4,$5,$6,'reserved')`,
      [randomUUID(), tenantId, operationId, item.dimension, item.units.toString(), policy.revision],
    );
    await q.query(
      `INSERT INTO capacity_ledger(entry_id, tenant_id, operation_id, dimension, delta, kind, source_ref)
       VALUES($1,$2,$3,$4,$5,'reserved',$6)`,
      [randomUUID(), tenantId, operationId, item.dimension, item.units.toString(), `reserve:${operationId}`],
    );
  }
  return policy;
}

async function ledger(q: PoolClient, tenantId: string, operationId: string, dimension: string, delta: bigint, kind: 'actual' | 'released' | 'unknown', source: string) {
  await q.query(
    `INSERT INTO capacity_ledger(entry_id, tenant_id, operation_id, dimension, delta, kind, source_ref)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [randomUUID(), tenantId, operationId, dimension, delta.toString(), kind, source],
  );
}

export async function consumeInstanceReservations(q: PoolClient, tenantId: string, operationId: string) {
  const rows = (await q.query<{ dimension: string; units: string }>(
    `UPDATE capacity_reservations SET state='consumed', version=version+1
     WHERE operation_id=$1 AND tenant_id=$2 AND dimension <> 'concurrent_provisions' AND state IN ('reserved','unknown')
     RETURNING dimension, units::text AS units`,
    [operationId, tenantId],
  )).rows;
  for (const row of rows) {
    await ledger(q, tenantId, operationId, row.dimension, BigInt(row.units), 'actual', `consume:${operationId}`);
  }
}

export async function releaseConcurrent(q: PoolClient, tenantId: string, operationId: string) {
  const row = (await q.query<{ units: string }>(
    `SELECT units::text AS units FROM capacity_reservations
     WHERE operation_id=$1 AND tenant_id=$2 AND dimension='concurrent_provisions' AND state IN ${HOLDING}`,
    [operationId, tenantId],
  )).rows[0];
  if (!row) return;
  await q.query(
    `UPDATE capacity_reservations SET state='released', version=version+1
     WHERE operation_id=$1 AND tenant_id=$2 AND dimension='concurrent_provisions'`,
    [operationId, tenantId],
  );
  await ledger(q, tenantId, operationId, 'concurrent_provisions', -BigInt(row.units), 'released', `release:${operationId}`);
}

export async function markReservationsUnknown(q: PoolClient, tenantId: string, operationId: string) {
  const rows = (await q.query<{ dimension: string; units: string }>(
    `SELECT dimension, units::text AS units FROM capacity_reservations
     WHERE operation_id=$1 AND tenant_id=$2 AND state='reserved'`,
    [operationId, tenantId],
  )).rows;
  for (const row of rows) {
    await q.query(
      `UPDATE capacity_reservations SET state='unknown', version=version+1
       WHERE operation_id=$1 AND tenant_id=$2 AND dimension=$3`,
      [operationId, tenantId, row.dimension],
    );
    await ledger(q, tenantId, operationId, row.dimension, BigInt(row.units), 'unknown', `unknown:${operationId}`);
  }
}

/** Release `units` from a holding reservation. A full release keeps units > 0 by moving the row to released. */
export async function releaseReservationUnits(q: PoolClient, tenantId: string, operationId: string, dimension: string, units: bigint) {
  if (units <= 0n) return;
  const row = (await q.query<{ units: string; state: string }>(
    `SELECT units::text AS units, state FROM capacity_reservations
     WHERE operation_id=$1 AND tenant_id=$2 AND dimension=$3 AND state IN ${HOLDING}`,
    [operationId, tenantId, dimension],
  )).rows[0];
  if (!row) return;
  const current = BigInt(row.units);
  const releasing = units > current ? current : units;
  if (releasing === current) {
    await q.query(
      `UPDATE capacity_reservations SET state='released', version=version+1
       WHERE operation_id=$1 AND tenant_id=$2 AND dimension=$3`,
      [operationId, tenantId, dimension],
    );
  } else {
    await q.query(
      `UPDATE capacity_reservations SET units=units-$4, version=version+1
       WHERE operation_id=$1 AND tenant_id=$2 AND dimension=$3`,
      [operationId, tenantId, dimension, releasing.toString()],
    );
  }
  await ledger(q, tenantId, operationId, dimension, -releasing, 'released', `release:${operationId}`);
}

export async function releaseAllHolding(q: PoolClient, tenantId: string, operationId: string) {
  const rows = (await q.query<{ dimension: string; units: string }>(
    `SELECT dimension, units::text AS units FROM capacity_reservations
     WHERE operation_id=$1 AND tenant_id=$2 AND state IN ${HOLDING}`,
    [operationId, tenantId],
  )).rows;
  for (const row of rows) await releaseReservationUnits(q, tenantId, operationId, row.dimension, BigInt(row.units));
}
