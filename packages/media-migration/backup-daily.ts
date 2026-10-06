import type { Pool } from 'pg';
import type { ObjectStore } from '../asset-storage/index.js';
import { createConsistentAssetBackup } from './backup-coordinator.js';
import { sealRecoverySet, readbackRecoverySet, restoreRecoverySet, restoredReferenceAuthorization,
  type ArchiveStore, type DumpSource, type DatabaseRestoreWriter, type RecoverySetVerification } from './backup-archive.js';
import { assessPostDumpSupersetWindow, observeMediaGcState, type MediaGcObservation } from './backup-gc-precondition.js';
import { assertBackupCaptureCurrent } from './backup-transfer.js';

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
  /** Omission preserves the deployed GC-OFF contract. Opt-in does not enable GC. */
  readonly gcSafety?: 'disabled' | 'snapshot-pins';
}
type CaptureOptions = Parameters<typeof createConsistentAssetBackup>[1];
export interface DailyBackupAdapter {
  /** Observe actual target and GC state; default requires GC OFF. snapshot-pins
   * requires an already configured enabled policy, including its SQL-derived
   * policySha256. Sequence-rewinding writers must remain fenced. May open owned pools/locks, but no
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
   * run's pools/processes/containers. Default restores GC OFF; snapshot-pins
   * preserves the exact preflight policy. Read it back in either mode. Retain
   * dumps, archives, unknown remote effects and source pins; never prune. */
  cleanup(context: Readonly<DailyBackupContext>): Promise<{
    gc: MediaGcObservation; ownedResourcesRemaining: number;
  }>;
}
type Stage = 'preflight' | 'capture' | 'seal' | 'offsite' | 'readback' | 'restore' | 'cleanup' | 'complete';
export class DailyBackupError extends Error {
  constructor(readonly code: 'invalid_daily_backup_input' | 'daily_backup_target_mismatch' | 'daily_backup_gc_not_disabled'
    | 'daily_backup_evidence_required' | 'daily_backup_remote_mismatch' | 'daily_backup_restore_mismatch'
    | 'daily_backup_cleanup_failed' | 'daily_backup_aborted' | 'daily_backup_ports_invalid'
    | 'daily_backup_policy_mismatch' | 'daily_backup_protection_lost') { super(code); }
}
const fail = (code: DailyBackupError['code']): never => { throw new DailyBackupError(code); };
function assertGc(value: MediaGcObservation, context: DailyBackupContext) {
  if (!value || value.database !== context.database || value.schema !== context.schema) fail('daily_backup_target_mismatch');
  if (context.gcSafety !== 'snapshot-pins') {
    if (value.maintenanceEnabled !== false || value.domainMaintenanceEnabled !== false) fail('daily_backup_gc_not_disabled');
  } else if (value.maintenanceEnabled !== true || typeof value.domainMaintenanceEnabled !== 'boolean'
    || typeof value.policyRevision !== 'string' || !value.policyRevision.length
    || !/^[a-f0-9]{64}$/.test(value.policySha256 ?? '') || !Number.isFinite(Date.parse(value.observedAt))) {
    fail('daily_backup_policy_mismatch');
  }
}
function assertPolicyIdentity(before: MediaGcObservation, after: MediaGcObservation, context: DailyBackupContext) {
  assertGc(after, context);
  if (after.policySha256 !== before.policySha256 || after.policyRevision !== before.policyRevision
    || after.maintenanceEnabled !== before.maintenanceEnabled || after.domainMaintenanceEnabled !== before.domainMaintenanceEnabled) {
    fail('daily_backup_policy_mismatch');
  }
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
    || !(raw.gcSafety === undefined || raw.gcSafety === 'disabled' || raw.gcSafety === 'snapshot-pins')
    || !Number.isFinite(Date.parse(raw.createdAt)) || !(raw.signal instanceof AbortSignal)) fail('invalid_daily_backup_input');
  const context = Object.freeze({ ...raw }), ports = bindPorts(adapter);
  let stage: Stage = 'preflight', failedStage: Stage | undefined, code: string | undefined;
  let before: MediaGcObservation | undefined, sealed: RecoverySetVerification | undefined;
  let readback: RecoverySetVerification | undefined, restored: Awaited<ReturnType<typeof restoreRecoverySet>> | undefined;
  let cleanupVerified = false, remoteVerified = false;
  let captureId: string | undefined, protectionChecks = 0, protectedAfterRestore = false;
  let publication: Awaited<ReturnType<DailyBackupAdapter['publishAndOpen']>>['publication'] | undefined;
  const proceed = (next: Stage) => { stage = next; if (context.signal.aborted) fail('daily_backup_aborted'); };
  try {
    proceed('preflight'); before = Object.freeze(structuredClone(await ports.preflight(context))); assertGc(before, context);
    proceed('capture'); const capture = await ports.openCapture(context);
    const { pool, dump, archive } = capture, captureOptions = { ...capture.options }, backupObjects = captureOptions.destination;
    const backup = await createConsistentAssetBackup(pool, { ...captureOptions, enabled: true,
      target: { database: context.database, sourceSchema: context.schema, sourceRelease: context.sourceRelease }, snapshotEvidence: true });
    if (!backup.evidence) fail('daily_backup_evidence_required');
    captureId = backup.objects.capture.captureId;
    const protectedCaptureId = captureId;
    const maintenance = captureOptions.maintenance;
    const renew = maintenance.renewProtection.bind(maintenance), read = maintenance.readReferences.bind(maintenance);
    const checkProtection = async (renewFirst = false) => {
      if (context.gcSafety !== 'snapshot-pins') return;
      try {
        if (renewFirst) await renew(protectedCaptureId);
        await assertBackupCaptureCurrent(backup.objects.capture, { assertCurrent: () => read(protectedCaptureId) });
        // Reobserve the actual source database. A caller-supplied preflight
        // digest alone cannot substitute for the fixed SQL policy readback.
        assertPolicyIdentity(before!, await observeMediaGcState(pool), context);
        protectionChecks++;
      } catch (error) { if (error instanceof DailyBackupError) throw error; fail('daily_backup_protection_lost'); }
    };
    // No row lock spans a phase. A renewal is bounded; a post-phase read must
    // still prove the exact, currently live capture. Expiry never implies unpin.
    const protectedPhase = async (next: Stage) => { proceed(next); await checkProtection(true); };
    await protectedPhase('seal'); sealed = await sealRecoverySet({ backup, setId: context.setId, environment: context.environment,
      createdAt: context.createdAt, dump, archive, backupObjects });
    await checkProtection();
    await protectedPhase('offsite'); const suppliedRemote = await ports.publishAndOpen(context, sealed);
    await checkProtection();
    const selected = suppliedRemote.publication;
    if (!selected || !(selected.mode === 'provider_create_only' && selected.atomicCreateOnly === true
      || selected.mode === 'unique_single_writer' && selected.atomicCreateOnly === false)) fail('daily_backup_ports_invalid');
    publication = Object.freeze({ mode: selected.mode, atomicCreateOnly: selected.atomicCreateOnly }) as typeof selected;
    const remote = Object.freeze({ archive: suppliedRemote.archive, backupObjects: suppliedRemote.backupObjects });
    if (remote.archive === archive || remote.backupObjects === backupObjects) fail('daily_backup_remote_mismatch');
    await protectedPhase('readback'); readback = await readbackRecoverySet({ ...remote, setId: context.setId, verifiedAt: new Date().toISOString() });
    if (readback.manifestSha256 !== sealed.manifestSha256 || readback.evidence.status !== 'captured'
      || readback.database !== context.database || readback.schema !== context.schema
      || readback.environment !== context.environment || readback.sourceRelease !== context.sourceRelease) fail('daily_backup_remote_mismatch');
    remoteVerified = true;
    await checkProtection();
    await protectedPhase('restore'); const target = await ports.openRestore(context);
    // Different isolated servers may intentionally use the same logical name.
    // Physical isolation belongs to the trusted adapter's owned-container check.
    if (target.pool === pool) fail('daily_backup_restore_mismatch');
    restored = await restoreRecoverySet({ ...remote, setId: context.setId, destinationObjects: target.objects,
      restoredPool: target.pool, restoredDatabase: target.databaseName, database: target.database,
      objectAuthority: restoredReferenceAuthorization(target.pool, { database: target.databaseName, schema: context.schema, current: { mode: 'quarantine' } }) });
    if (restored.manifestSha256 !== sealed.manifestSha256 || restored.evidence.status !== 'matched'
      || restored.exposure !== 'quarantine_not_approved_for_exposure') fail('daily_backup_restore_mismatch');
    await checkProtection();
    protectedAfterRestore = context.gcSafety === 'snapshot-pins';
  } catch (error) {
    failedStage = stage;
    code = error instanceof DailyBackupError ? error.code : 'daily_backup_phase_failed';
  } finally {
    stage = 'cleanup';
    try {
      const result = await ports.cleanup(context); assertGc(result.gc, context);
      if (result.ownedResourcesRemaining !== 0) fail('daily_backup_cleanup_failed');
      if (before && context.gcSafety === 'snapshot-pins') {
        // Generation legitimately advances on capture/renew; the SQL-derived
        // digest excludes only that counter. Unrelated tombstones may advance.
        assertPolicyIdentity(before, result.gc, context);
        if (Date.parse(result.gc.observedAt) <= Date.parse(before.observedAt)) fail('daily_backup_policy_mismatch');
      } else if (before && assessPostDumpSupersetWindow(before, result.gc).status !== 'superset_window_safe') fail('daily_backup_gc_not_disabled');
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
    gcSafety: context.gcSafety ?? 'disabled', sourceProtection: context.gcSafety === 'snapshot-pins'
      ? { status: protectedAfterRestore ? 'checked_after_restore_before_cleanup' : 'not_verified', captureId: captureId ?? null, checks: protectionChecks }
      : { status: before && cleanupVerified ? 'disabled_window_checked' : 'not_verified', captureId: captureId ?? null, checks: 0 },
    sourcePins: 'retained', retentionExecuted: false, pitr: false, cutoverAuthorized: false });
}
