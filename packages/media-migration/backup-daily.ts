import type { Pool } from 'pg';
import type { ObjectStore } from '../asset-storage/index.js';
import { createConsistentAssetBackup } from './backup-coordinator.js';
import { sealRecoverySet, readbackRecoverySet, restoreRecoverySet, restoredReferenceAuthorization,
  type ArchiveStore, type DumpSource, type DatabaseRestoreWriter, type RecoverySetVerification } from './backup-archive.js';
import { assessPostDumpSupersetWindow, type MediaGcObservation } from './backup-gc-precondition.js';

/** Explicit operator ports, not candidate/plugin callbacks or an attestation.
 * The adapter owns provider credentials and bounded subprocess/network I/O.
 * This runner owns the fixed backup -> seal -> remote readback -> restore order. */
export interface DailyBackupContext {
  readonly environment: 'production' | 'staging' | 'local';
  readonly database: string;
  readonly schema: string;
  readonly sourceRelease: string;
  readonly operatorSource: string;
  readonly setId: string;
  readonly createdAt: string;
  readonly runDirectory: string;
  readonly signal: AbortSignal;
}
type CaptureOptions = Parameters<typeof createConsistentAssetBackup>[1];
export interface DailyBackupAdapter {
  /** Observe actual target and GC state; also assert deployed GC is OFF and
   * sequence-rewinding writers are fenced. May open owned pools/locks, but no
   * backup/restore allocation or policy change. */
  preflight(context: Readonly<DailyBackupContext>): Promise<MediaGcObservation>;
  /** May prepare the existing maintenance/pin port, but never start pg_dump.
   * DatabaseSnapshotWriter must use the supplied exported snapshot. */
  openCapture(context: Readonly<DailyBackupContext>): Promise<{
    pool: Pool; options: Omit<CaptureOptions, 'enabled' | 'target' | 'snapshotEvidence'>;
    dump: DumpSource; archive: ArchiveStore;
  }>;
  /** Publish without overwriting, completely download the remote copy into a distinct
   * directory/store, verify transport digest, then expose ONLY that copy here.
   * No cached/local fallback. The runner independently reads every member. */
  publishAndOpen(context: Readonly<DailyBackupContext>, sealed: Readonly<RecoverySetVerification>): Promise<{
    archive: ArchiveStore; backupObjects: ObjectStore;
    publication: { mode: 'provider_create_only'; atomicCreateOnly: true }
      | { mode: 'unique_single_writer'; atomicCreateOnly: false };
  }>;
  /** Allocate a new empty owned PG18 target and private native R2 destination.
   * No application binding/network access. Cleanup must cover partial failure. */
  openRestore(context: Readonly<DailyBackupContext>): Promise<{
    pool: Pool; databaseName: string; database: DatabaseRestoreWriter; objects: ObjectStore;
  }>;
  /** Always invoked, including failed preflight/openCapture. Close only this
   * run's pools/processes/containers, restore GC OFF and read it back. Retain
   * dumps, archives, unknown remote effects and source pins; never prune. */
  cleanup(context: Readonly<DailyBackupContext>): Promise<{
    gc: MediaGcObservation; ownedResourcesRemaining: number;
  }>;
}
type Stage = 'preflight' | 'capture' | 'seal' | 'offsite' | 'readback' | 'restore' | 'cleanup' | 'complete';
export class DailyBackupError extends Error {
  constructor(readonly code: 'invalid_daily_backup_input' | 'daily_backup_target_mismatch' | 'daily_backup_gc_not_disabled'
    | 'daily_backup_evidence_required' | 'daily_backup_remote_mismatch' | 'daily_backup_restore_mismatch'
    | 'daily_backup_cleanup_failed' | 'daily_backup_aborted' | 'daily_backup_ports_invalid') { super(code); }
}
const fail = (code: DailyBackupError['code']): never => { throw new DailyBackupError(code); };
function assertGc(value: MediaGcObservation, context: DailyBackupContext) {
  if (!value || value.database !== context.database || value.schema !== context.schema) fail('daily_backup_target_mismatch');
  if (value.maintenanceEnabled !== false || value.domainMaintenanceEnabled !== false) fail('daily_backup_gc_not_disabled');
}
function bindPorts(adapter: DailyBackupAdapter) {
  const names = ['preflight', 'openCapture', 'publishAndOpen', 'openRestore', 'cleanup'] as const;
  if (!adapter || names.some(name => typeof adapter[name] !== 'function')) fail('daily_backup_ports_invalid');
  // Capture method identities before the first asynchronous operation.
  return { preflight: adapter.preflight.bind(adapter), openCapture: adapter.openCapture.bind(adapter),
    publishAndOpen: adapter.publishAndOpen.bind(adapter), openRestore: adapter.openRestore.bind(adapter), cleanup: adapter.cleanup.bind(adapter) };
}

export async function runDailyBackup(raw: DailyBackupContext, adapter: DailyBackupAdapter) {
  if (!raw || !['production', 'staging', 'local'].includes(raw.environment)
    || ![raw.database, raw.schema].every(v => typeof v === 'string' && /^[a-z_][a-z0-9_]{0,62}$/.test(v))
    || ![raw.sourceRelease, raw.operatorSource].every(v => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v))
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(raw.setId)
    || !Number.isFinite(Date.parse(raw.createdAt)) || !(raw.signal instanceof AbortSignal)) fail('invalid_daily_backup_input');
  const context = Object.freeze({ ...raw }), ports = bindPorts(adapter);
  let stage: Stage = 'preflight', failedStage: Stage | undefined, code: string | undefined;
  let before: MediaGcObservation | undefined, sealed: RecoverySetVerification | undefined;
  let readback: RecoverySetVerification | undefined, restored: Awaited<ReturnType<typeof restoreRecoverySet>> | undefined;
  let cleanupVerified = false, remoteVerified = false;
  let publication: Awaited<ReturnType<DailyBackupAdapter['publishAndOpen']>>['publication'] | undefined;
  const proceed = (next: Stage) => { stage = next; if (context.signal.aborted) fail('daily_backup_aborted'); };
  try {
    proceed('preflight'); before = Object.freeze(structuredClone(await ports.preflight(context))); assertGc(before, context);
    proceed('capture'); const capture = await ports.openCapture(context);
    const { pool, dump, archive } = capture, captureOptions = { ...capture.options }, backupObjects = captureOptions.destination;
    const backup = await createConsistentAssetBackup(pool, { ...captureOptions, enabled: true,
      target: { database: context.database, sourceSchema: context.schema, sourceRelease: context.sourceRelease }, snapshotEvidence: true });
    if (!backup.evidence) fail('daily_backup_evidence_required');
    proceed('seal'); sealed = await sealRecoverySet({ backup, setId: context.setId, environment: context.environment,
      createdAt: context.createdAt, dump, archive, backupObjects });
    proceed('offsite'); const suppliedRemote = await ports.publishAndOpen(context, sealed);
    const selected = suppliedRemote.publication;
    if (!selected || !(selected.mode === 'provider_create_only' && selected.atomicCreateOnly === true
      || selected.mode === 'unique_single_writer' && selected.atomicCreateOnly === false)) fail('daily_backup_ports_invalid');
    publication = Object.freeze({ mode: selected.mode, atomicCreateOnly: selected.atomicCreateOnly }) as typeof selected;
    const remote = Object.freeze({ archive: suppliedRemote.archive, backupObjects: suppliedRemote.backupObjects });
    if (remote.archive === archive || remote.backupObjects === backupObjects) fail('daily_backup_remote_mismatch');
    proceed('readback'); readback = await readbackRecoverySet({ ...remote, setId: context.setId, verifiedAt: new Date().toISOString() });
    if (readback.manifestSha256 !== sealed.manifestSha256 || readback.evidence.status !== 'captured'
      || readback.database !== context.database || readback.schema !== context.schema
      || readback.environment !== context.environment || readback.sourceRelease !== context.sourceRelease) fail('daily_backup_remote_mismatch');
    remoteVerified = true;
    proceed('restore'); const target = await ports.openRestore(context);
    // Different isolated servers may intentionally use the same logical name.
    // Physical isolation belongs to the trusted adapter's owned-container check.
    if (target.pool === pool) fail('daily_backup_restore_mismatch');
    restored = await restoreRecoverySet({ ...remote, setId: context.setId, destinationObjects: target.objects,
      restoredPool: target.pool, restoredDatabase: target.databaseName, database: target.database,
      objectAuthority: restoredReferenceAuthorization(target.pool, { database: target.databaseName, schema: context.schema, current: { mode: 'quarantine' } }) });
    if (restored.manifestSha256 !== sealed.manifestSha256 || restored.evidence.status !== 'matched'
      || restored.exposure !== 'quarantine_not_approved_for_exposure') fail('daily_backup_restore_mismatch');
  } catch (error) {
    failedStage = stage;
    code = error instanceof DailyBackupError ? error.code : 'daily_backup_phase_failed';
  } finally {
    stage = 'cleanup';
    try {
      const result = await ports.cleanup(context); assertGc(result.gc, context);
      if (result.ownedResourcesRemaining !== 0) fail('daily_backup_cleanup_failed');
      // This reuses the existing GC/fence/tombstone invariant comparison; it
      // does not relabel the coordinator backup as a post-dump superset.
      if (before && assessPostDumpSupersetWindow(before, result.gc).status !== 'superset_window_safe') fail('daily_backup_gc_not_disabled');
      cleanupVerified = true;
    } catch { failedStage ??= 'cleanup'; code = 'daily_backup_cleanup_failed'; }
  }
  const passed = !code && !!restored && cleanupVerified && !context.signal.aborted;
  return Object.freeze({ format: 'freedom.daily-recovery-backup/v1', status: passed ? 'passed' : 'failed',
    stage: passed ? 'complete' : failedStage ?? stage, code: code ?? (context.signal.aborted ? 'daily_backup_aborted' : null),
    environment: context.environment, database: context.database, schema: context.schema, sourceRelease: context.sourceRelease,
    operatorSource: context.operatorSource, setId: context.setId, createdAt: context.createdAt,
    manifestSha256: sealed?.manifestSha256 ?? null, dump: sealed?.dump ?? null, objects: sealed?.objects ?? null,
    snapshotEvidence: sealed?.evidence.status ?? 'unavailable', remoteReadback: remoteVerified ? 'verified' : 'not_verified',
    offsitePublication: publication ?? null,
    restore: restored?.status ?? 'not_verified', exposure: restored?.exposure ?? 'not_restored', cleanupVerified,
    sourcePins: 'retained', retentionExecuted: false, pitr: false, cutoverAuthorized: false });
}
