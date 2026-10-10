import type { PoolClient } from 'pg';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import { PRIVATE_TEXT_MAX_BYTES } from '../../packages/asset-storage/index.js';

export interface TenantCapacityPolicy {
  readonly policy_id: string;
  readonly revision: string;
  readonly max_active_instances: number;
  readonly max_instances_per_module: number;
  readonly max_concurrent_provisions: number;
  readonly max_work_items: number;
  readonly max_retained_bytes: string;
}

const POLICY_SQL = `SELECT policy_id, revision::text AS revision, max_active_instances, max_instances_per_module,
  max_concurrent_provisions, max_work_items, max_retained_bytes::text AS max_retained_bytes
  FROM tenant_capacity_policies
  WHERE status='active' AND (tenant_id=$1 OR tenant_id IS NULL)
  ORDER BY tenant_id NULLS LAST LIMIT 1`;

/** An override row sorts ahead of the platform default. Callers that mutate
 * take the exclusive policy advisory lock first; reads may use the plain select. */
export async function lockCapacityPolicy(q: PoolClient, tenantId: string): Promise<TenantCapacityPolicy | null> {
  await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`tenant.capacity/v1/${tenantId}/policy`]);
  const row = (await q.query<TenantCapacityPolicy>(POLICY_SQL + ' FOR SHARE', [tenantId])).rows[0] ?? null;
  return row;
}

export async function readCapacityPolicy(q: PoolClient, tenantId: string): Promise<TenantCapacityPolicy | null> {
  return (await q.query<TenantCapacityPolicy>(POLICY_SQL, [tenantId])).rows[0] ?? null;
}

export function requirePolicy(row: TenantCapacityPolicy | null): TenantCapacityPolicy {
  if (!row) throw new Problem(403, 'policy_unconfigured', '這個業務空間尚未設定容量政策。');
  return row;
}

export async function lockDimension(q: PoolClient, tenantId: string, dimension: 'instances' | 'work_items' | 'retained_bytes') {
  await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`tenant.capacity/v1/${tenantId}/${dimension}`]);
}

export function rejectAtLimit(count: bigint, max: bigint) {
  requireCondition(count < max, 429, 'quota_exceeded', '已達到這個業務空間的容量上限。');
}

export async function retainedByteUsage(q: PoolClient, scopeId: string, tenantId: string): Promise<bigint> {
  const row = (await q.query<{ used: string }>(`SELECT COALESCE(sum(COALESCE(o.byte_size, i.reserved_bytes, CASE a.purpose WHEN 'storefront.product-photo' THEN 1048576 ELSE $3 END)::bigint), 0)::text AS used
    FROM assets a
    LEFT JOIN asset_objects o ON o.asset_id=a.asset_id
    LEFT JOIN asset_upload_intents i ON i.asset_id=a.asset_id
    WHERE a.scope_id=$1 AND a.tenant_ref=$2 AND a.purpose IN ('work.tenant-result','storefront.product-photo')`,
  [scopeId, tenantId, PRIVATE_TEXT_MAX_BYTES])).rows[0];
  return BigInt(row.used);
}

export async function capacitySummary(q: PoolClient, scopeId: string, tenantId: string) {
  const policy = await readCapacityPolicy(q, tenantId);
  const row = (await q.query<{ used: string; reserved: string }>(`SELECT
      COALESCE(sum(o.byte_size), 0)::text AS used,
      COALESCE(sum(CASE WHEN o.asset_id IS NULL THEN COALESCE(i.reserved_bytes, CASE a.purpose WHEN 'storefront.product-photo' THEN 1048576 ELSE $3 END) ELSE 0 END), 0)::text AS reserved
    FROM assets a
    LEFT JOIN asset_objects o ON o.asset_id=a.asset_id
    LEFT JOIN asset_upload_intents i ON i.asset_id=a.asset_id
    WHERE a.scope_id=$1 AND a.tenant_ref=$2 AND a.purpose IN ('work.tenant-result','storefront.product-photo')`,
  [scopeId, tenantId, PRIVATE_TEXT_MAX_BYTES])).rows[0];
  return {
    policy_revision: policy?.revision ?? null,
    used: row.used,
    reserved: row.reserved,
    limit: policy?.max_retained_bytes ?? null,
  };
}
