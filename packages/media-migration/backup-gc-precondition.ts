import type { Pool, PoolClient } from 'pg';

/* GC precondition for the CURRENT daily method: pg_dump first, then copy the
 * then-current immutable R2 objects (a post-dump superset). That archive is
 * restorable only if no object referenced by the dump could have been deleted
 * between the dump and the end of the copy. Deletion requires a permanent
 * tombstone, which the database only admits while maintenance GC is enabled.
 * So the window is safe iff GC was disabled at both ends and the exact
 * tombstone set did not change. This read-only check observes; it never
 * enables/disables GC, releases pins or deletes anything.
 *
 * The same-exported-snapshot coordinator path does not need GC OFF: its pins
 * protect the captured set. This guard is for the superset path only. */

export interface MediaGcObservation {
  readonly observedAt: string;
  readonly database: string;
  readonly schema: string;
  readonly maintenanceEnabled: boolean;
  readonly domainMaintenanceEnabled: boolean;
  readonly policyRevision: string | null;
  /** Exact configured policy, excluding only the capture gate's changing generation.
   * Optional for legacy adapters; snapshot-pins admission requires this readback. */
  readonly policySha256?: string;
  readonly deletionFences: number;
  readonly tombstones: number;
  /** Digest of the ordered tombstone asset ids; detects replace-in-place. */
  readonly tombstoneDigest: string;
  readonly openCaptures: number;
}
export class GcPreconditionError extends Error {
  constructor(readonly code: 'gc_observation_unavailable') { super(code); this.name = 'GcPreconditionError'; }
}

/** One statement, one snapshot, database clock. Returns aggregates only. */
export async function observeMediaGcState(db: Pool | PoolClient): Promise<MediaGcObservation> {
  let row: Record<string, unknown> | undefined;
  try {
    row = (await db.query(`SELECT
        to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at,
        current_database() AS database, current_schema() AS schema,
        (SELECT count(*)::int FROM asset_maintenance_policy) AS policies,
        COALESCE((SELECT bool_or(enabled) FROM asset_maintenance_policy),false) AS enabled,
        COALESCE((SELECT bool_or(domain_media_enabled) FROM asset_maintenance_policy),false) AS domain_enabled,
        (SELECT min(revision) FROM asset_maintenance_policy) AS revision,
        (SELECT encode(pg_catalog.sha256(convert_to((to_jsonb(p)-'generation')::text,'UTF8')),'hex')
           FROM asset_maintenance_policy p) AS policy_sha256,
        (SELECT count(*)::int FROM assets WHERE deletion_fence<>0) AS fences,
        (SELECT count(*)::int FROM asset_deletion_tombstones) AS tombstones,
        (SELECT encode(pg_catalog.sha256(convert_to(COALESCE(string_agg(asset_id::text,',' ORDER BY asset_id),''),'UTF8')),'hex')
           FROM asset_deletion_tombstones) AS tombstone_digest,
        (SELECT count(*)::int FROM asset_backup_captures WHERE state IN ('capturing','pinned')) AS open_captures`)).rows[0];
  } catch { throw new GcPreconditionError('gc_observation_unavailable'); }
  const int = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : NaN);
  if (!row || row.policies !== 1 || typeof row.observed_at !== 'string' || typeof row.database !== 'string' || typeof row.schema !== 'string'
    || typeof row.enabled !== 'boolean' || typeof row.domain_enabled !== 'boolean'
    || !(row.revision === null || typeof row.revision === 'string') || typeof row.policy_sha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(row.policy_sha256) || typeof row.tombstone_digest !== 'string'
    || !/^[0-9a-f]{64}$/.test(row.tombstone_digest) || [row.fences, row.tombstones, row.open_captures].some(v => Number.isNaN(int(v))))
    throw new GcPreconditionError('gc_observation_unavailable');
  return Object.freeze({ observedAt: row.observed_at, database: row.database, schema: row.schema, maintenanceEnabled: row.enabled,
    domainMaintenanceEnabled: row.domain_enabled, policyRevision: row.revision as string | null, policySha256: row.policy_sha256, deletionFences: row.fences as number,
    tombstones: row.tombstones as number, tombstoneDigest: row.tombstone_digest, openCaptures: row.open_captures as number });
}

export type SupersetWindowReason = 'gc_enabled_before' | 'gc_enabled_after' | 'domain_gc_enabled_before' | 'domain_gc_enabled_after'
  | 'tombstones_changed' | 'fences_changed' | 'target_changed' | 'window_order_invalid';
export interface SupersetWindowAssessment {
  readonly status: 'superset_window_safe' | 'superset_window_unsafe';
  readonly reasons: readonly SupersetWindowReason[];
}

/** `before` must be observed before pg_dump starts, `after` once the last
 * object copy has been read back. Any reason makes the archive NOT a valid
 * recovery set for objects referenced by the dump. */
export function assessPostDumpSupersetWindow(before: MediaGcObservation, after: MediaGcObservation): SupersetWindowAssessment {
  const reasons: SupersetWindowReason[] = [];
  if (!before || !after) return Object.freeze({ status: 'superset_window_unsafe', reasons: Object.freeze(['window_order_invalid'] as SupersetWindowReason[]) });
  if (before.database !== after.database || before.schema !== after.schema) reasons.push('target_changed');
  const b = Date.parse(before.observedAt), a = Date.parse(after.observedAt);
  if (!Number.isFinite(b) || !Number.isFinite(a) || a <= b) reasons.push('window_order_invalid');
  if (before.maintenanceEnabled !== false) reasons.push('gc_enabled_before');
  if (after.maintenanceEnabled !== false) reasons.push('gc_enabled_after');
  if (before.domainMaintenanceEnabled !== false) reasons.push('domain_gc_enabled_before');
  if (after.domainMaintenanceEnabled !== false) reasons.push('domain_gc_enabled_after');
  if (before.tombstones !== after.tombstones || before.tombstoneDigest !== after.tombstoneDigest) reasons.push('tombstones_changed');
  if (before.deletionFences !== after.deletionFences) reasons.push('fences_changed');
  return Object.freeze({ status: reasons.length ? 'superset_window_unsafe' : 'superset_window_safe', reasons: Object.freeze(reasons) });
}
