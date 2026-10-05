import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runDailyBackup, type DailyBackupAdapter, type DailyBackupContext } from '../../packages/media-migration/backup-daily.js';
import { runDailyBackupCli } from '../../scripts/media-backup-daily.js';
import type { MediaGcObservation } from '../../packages/media-migration/backup-gc-precondition.js';

const context = (): DailyBackupContext => ({ environment: 'local', database: 'fp_daily', schema: 'public',
  sourceRelease: 'a'.repeat(40), operatorSource: 'b'.repeat(40), setId: randomUUID(), createdAt: new Date().toISOString(),
  runDirectory: '/unused-synthetic', signal: new AbortController().signal });
const gc = (after = false): MediaGcObservation => ({ observedAt: after ? '2026-10-05T00:00:02.000Z' : '2026-10-05T00:00:01.000Z',
  database: 'fp_daily', schema: 'public', maintenanceEnabled: false, domainMaintenanceEnabled: false,
  policyRevision: 'synthetic', deletionFences: 0, tombstones: 0, tombstoneDigest: 'a'.repeat(64), openCaptures: 0 });
function fixture() {
  const calls: string[] = [];
  const adapter: DailyBackupAdapter = {
    async preflight() { calls.push('preflight'); return gc(); },
    async openCapture() { calls.push('capture'); throw Error('RAW_PRIVATE_PROVIDER_DETAIL'); },
    async publishAndOpen() { calls.push('offsite'); throw Error('must not run'); },
    async openRestore() { calls.push('restore'); throw Error('must not run'); },
    async cleanup() { calls.push('cleanup'); return { gc: gc(true), ownedResourcesRemaining: 0 }; },
  };
  return { calls, adapter };
}
test('daily capture failure always reconciles owned effects and never becomes completed or leaks provider text', async () => {
  const { calls, adapter } = fixture(); const result = await runDailyBackup(context(), adapter);
  assert.deepEqual(calls, ['preflight', 'capture', 'cleanup']); assert.equal(result.status, 'failed');
  assert.equal(result.stage, 'capture'); assert.equal(result.cleanupVerified, true);
  assert.equal(result.remoteReadback, 'not_verified'); assert.equal(result.sourcePins, 'retained');
  assert.equal(result.retentionExecuted, false); assert.equal(result.cutoverAuthorized, false);
  assert(!JSON.stringify(result).includes('RAW_PRIVATE'));
});
test('wrong target or enabled GC refuses capture and still runs cleanup', async () => {
  for (const changed of [{ database: 'another_database' }, { maintenanceEnabled: true }, { domainMaintenanceEnabled: true }]) {
    const { calls, adapter } = fixture(); adapter.preflight = async () => ({ ...gc(), ...changed });
    const result = await runDailyBackup(context(), adapter);
    assert.equal(result.status, 'failed'); assert.equal(result.stage, 'preflight'); assert.deepEqual(calls, ['cleanup']);
  }
});
test('cleanup failure, remaining owned resources, enabled GC or changed tombstones cannot claim cleanup success', async () => {
  for (const changed of [{ ownedResourcesRemaining: 1 }, { gc: { ...gc(true), maintenanceEnabled: true } },
    { gc: { ...gc(true), tombstones: 1 } }, { gc: { ...gc(true), tombstoneDigest: 'b'.repeat(64) } }]) {
    const { adapter } = fixture(); adapter.cleanup = async () => ({ gc: gc(true), ownedResourcesRemaining: 0, ...changed });
    const result = await runDailyBackup(context(), adapter);
    assert.equal(result.status, 'failed'); assert.equal(result.cleanupVerified, false); assert.equal(result.code, 'daily_backup_cleanup_failed');
  }
});
test('bound cleanup and immutable target survive adapter/caller mutation during an await', async () => {
  const { calls, adapter } = fixture(), input = context();
  adapter.preflight = async () => {
    Object.assign(input, { database: 'wrong_database' });
    adapter.cleanup = async () => { throw Error('replacement cleanup must not run'); };
    return gc();
  };
  const result = await runDailyBackup(input, adapter);
  assert.equal(result.database, 'fp_daily'); assert.equal(result.cleanupVerified, true); assert.deepEqual(calls, ['capture', 'cleanup']);
});
test('an aborted daily run does no capture but still reconciles, and CLI refuses implicit installation inputs', async () => {
  const { calls, adapter } = fixture(), controller = new AbortController(); controller.abort();
  const result = await runDailyBackup({ ...context(), signal: controller.signal }, adapter);
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'daily_backup_aborted'); assert.deepEqual(calls, ['cleanup']);
  assert.equal((await runDailyBackupCli([])).exitCode, 1);
  assert.equal((await runDailyBackupCli(['--adapter', 'relative.mjs'])).exitCode, 1);
});
