import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { ObjectStore } from '../asset-storage/index.js';
import type { createAssetMaintenance } from '../../modules/assets/maintenance.js';
import { transferBackup, type BackupManifest } from './backup-transfer.js';

type Maintenance = ReturnType<typeof createAssetMaintenance>;
const identity = z.object({ database: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/),
  sourceSchema: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/),
  sourceRelease: z.string().regex(/^[0-9a-f]{40}$/) }).strict();
const dumpEvidence = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/),
  byteSize: z.number().int().positive().max(1024 * 1024 * 1024) }).strict();
export class ConsistentBackupError extends Error {
  constructor(readonly code: 'backup_disabled' | 'backup_invalid_target' | 'backup_target_mismatch'
    | 'backup_snapshot_mismatch' | 'backup_capture_failed') {
    super(code); this.name = 'ConsistentBackupError';
  }
}
export interface DatabaseSnapshotWriter {
  /** Trusted operator port, not a member callback. It must invoke pg_dump with
   * this snapshot and schema, hash the completed dump, and atomically persist
   * it before returning. No raw SQL, database URL or backup path is returned. */
  write(input: Readonly<{ snapshotId: string; database: string; schema: string;
    release: string }>): Promise<Readonly<{ sha256: string; byteSize: number }>>;
}
export interface ConsistentBackup {
  readonly version: 1;
  readonly status: 'database_snapshot_and_objects_verified';
  readonly database: string;
  readonly dump: Readonly<{ sha256: string; byteSize: number }>;
  readonly objects: BackupManifest;
}

/** Off-request operations only. A committed maintenance barrier precedes the
 * exported PostgreSQL snapshot. Both the pin collector and pg_dump import that
 * same snapshot, so objects created during the dump cannot silently enter the
 * dump without entering the manifest. Every persisted unfenced representation,
 * including retired ones, is protected. No row lock survives into object I/O.
 *
 * Successful completion leaves pins in place for the caller's backup retention
 * decision. Failure does too: an interrupted copy may have real remote effects.
 * The caller may resume immutable objects or explicitly abort the capture;
 * neither this function nor restore rewinds external revocations or dispatch. */
export async function createConsistentAssetBackup(pool: Pool, options: {
  enabled?: boolean;
  target: z.infer<typeof identity>;
  maintenance: Maintenance;
  source: ObjectStore;
  destination: ObjectStore;
  databaseSnapshot: DatabaseSnapshotWriter;
  maxObjects?: number;
  maxBytes?: number;
}): Promise<ConsistentBackup> {
  if (options.enabled !== true) throw new ConsistentBackupError('backup_disabled');
  const parsed = identity.safeParse(options.target);
  if (!parsed.success) throw new ConsistentBackupError('backup_invalid_target');
  const target = Object.freeze(parsed.data);
  const { maintenance, source, destination, databaseSnapshot } = options;
  const budget = Object.freeze({ ...(options.maxObjects === undefined ? {} : { maxObjects: options.maxObjects }),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }) });
  // The exporter stays open while the collector commits through a second
  // connection. A one-connection pool would deadlock the capture barrier.
  if (pool.options.max !== undefined && pool.options.max < 2)
    throw new ConsistentBackupError('backup_invalid_target');
  let exporter: PoolClient | undefined;
  let inTransaction = false;
  try {
    exporter = await pool.connect();
    const actual = (await exporter.query('SELECT current_database() AS database,current_schema() AS schema')).rows[0];
    if (actual.database !== target.database || actual.schema !== target.sourceSchema)
      throw new ConsistentBackupError('backup_target_mismatch');
    // beginCapture commits its global deletion barrier before this snapshot.
    const begun = await maintenance.beginCapture({ sourceRelease: target.sourceRelease, sourceSchema: target.sourceSchema });
    await exporter.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); inTransaction = true;
    await exporter.query("SET LOCAL statement_timeout='30000'; SET LOCAL lock_timeout='3000'; SET LOCAL idle_in_transaction_session_timeout='120000'");
    const snapshot = (await exporter.query('SELECT pg_export_snapshot() AS exported,pg_current_snapshot()::text AS reference')).rows[0];
    if (typeof snapshot.exported !== 'string' || !/^[0-9A-F]{8}-[0-9A-F]{8}-[1-9][0-9]{0,9}$/.test(snapshot.exported))
      throw new ConsistentBackupError('backup_snapshot_mismatch');
    await maintenance.captureReferences(begun.captureId, { snapshotId: snapshot.exported });
    const captured = await maintenance.readReferences(begun.captureId);
    if (captured.referenceSnapshot !== snapshot.reference || captured.sourceRelease !== target.sourceRelease
      || captured.sourceSchema !== target.sourceSchema) throw new ConsistentBackupError('backup_snapshot_mismatch');
    const dump = Object.freeze(dumpEvidence.parse(await databaseSnapshot.write(Object.freeze({
      snapshotId: snapshot.exported, database: target.database, schema: target.sourceSchema, release: target.sourceRelease }))));
    // The exporter is no longer needed after the completed, hashed dump.
    await exporter.query('COMMIT'); inTransaction = false;
    exporter.release(); exporter = undefined;
    const objects = await transferBackup(captured, source, destination, {
      async renew() { await maintenance.renewProtection(begun.captureId); },
      async assertCurrent() { return maintenance.readReferences(begun.captureId); },
    }, budget);
    return Object.freeze({ version: 1, status: 'database_snapshot_and_objects_verified', database: target.database, dump, objects });
  } catch (error) {
    if (error instanceof ConsistentBackupError) throw error;
    // Operator logs may record a fixed code; never propagate SQL/store secrets.
    throw new ConsistentBackupError('backup_capture_failed');
  } finally {
    if (exporter) {
      let destroyed = false;
      if (inTransaction) { try { await exporter.query('ROLLBACK'); } catch { destroyed = true; } }
      exporter.release(destroyed);
    }
  }
}
