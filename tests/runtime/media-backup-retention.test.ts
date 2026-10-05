// Synthetic, no database or cloud: plan-only recovery-set retention.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdtemp, writeFile, mkdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeObjectStore } from '../../packages/asset-storage/fake-store.js';
import { objectKey, preparePrivateText } from '../../packages/asset-storage/index.js';
import { transferBackup, type BackupCapture } from '../../packages/media-migration/backup-transfer.js';
import type { ConsistentBackup } from '../../packages/media-migration/backup-coordinator.js';
import { sealRecoverySet, readbackRecoverySet, recoverySetKeys } from '../../packages/media-migration/backup-archive.js';
import { createFileArchiveStore } from '../../packages/media-migration/backup-archive-fs.js';
import { computeRetentionPlan, planRecoverySetRetention, RetentionError, type RecoverySetState } from '../../packages/media-migration/backup-retention.js';
import { runBackupRetention } from '../../scripts/media-backup-retention.js';

const policy = { keepVerified: 1, minRetentionSeconds: 0, maxReadbackAgeSeconds: 7 * 86_400, maxSets: 100 };
const now = '2026-10-06T00:00:00.000Z', scanNow = '2026-10-10T00:00:00.000Z';
const prod = { environment: 'production', database: 'freedom_next', schema: 'public' };
const staging = { environment: 'staging', database: 'freedom_staging_next', schema: 'public' };
const key = () => objectKey({ scopeId: randomUUID(), assetId: randomUUID(), representationId: randomUUID() });
function sealed(day: number, extra: Partial<Extract<RecoverySetState, { status: 'sealed' }>> = {}): Extract<RecoverySetState, { status: 'sealed' }> {
  const createdAt = `2026-10-0${day}T00:00:00.000Z`;
  return { setId: randomUUID(), status: 'sealed', lineage: prod, createdAt, manifestSha256: 'a'.repeat(64), captureId: randomUUID(),
    objectKeys: [key()], archiveKeys: [], lastVerifiedAt: `2026-10-0${day}T01:00:00.000Z`, anomalies: [], ...extra };
}
const keptIds = (plan: ReturnType<typeof computeRetentionPlan>) => plan.keep.map(k => k.setId);
const prunedIds = (plan: ReturnType<typeof computeRetentionPlan>) => plan.prune.map(p => p.setId);

test('Retention keeps the latest freshly verified set, prunes superseded ones and plans only exclusive objects/pins', () => {
  const shared = key();
  const old = sealed(1, { objectKeys: [shared, key()] }), mid = sealed(2), latest = sealed(3, { objectKeys: [shared] });
  const plan = computeRetentionPlan([old, mid, latest], policy, now);
  assert.equal(plan.status, 'planned'); assert.equal(plan.execution, 'not_run');
  assert.deepEqual(plan.lineages, [{ lineage: 'production/freedom_next/public', latestVerified: latest.setId }]);
  assert.deepEqual(keptIds(plan), [latest.setId]);
  assert.deepEqual(prunedIds(plan).sort(), [old.setId, mid.setId].sort());
  assert.equal(plan.objectPrune.status, 'planned');
  assert(!plan.objectPrune.keys.includes(shared), 'objects still referenced by a kept set are never pruned');
  assert.equal(plan.objectPrune.keys.length, 2);
  assert.deepEqual(plan.captureRelease.items.map(i => i.captureId).sort(), [old.captureId, mid.captureId].sort());
  assert.match(plan.planSha256, /^[0-9a-f]{64}$/); assert(Object.isFrozen(plan.prune));
  assert.equal(computeRetentionPlan([latest, mid, old], policy, now).planSha256, plan.planSha256, 'plan is order independent');
  const window = computeRetentionPlan([old, mid, latest], { ...policy, keepVerified: 2 }, now);
  assert.deepEqual(keptIds(window).sort(), [mid.setId, latest.setId].sort());
});

test('REGRESSION: a capture shared by a kept set is never released, even when another set using it is pruned', () => {
  const captureId = randomUUID();
  const old = sealed(1, { captureId }), latest = sealed(3, { captureId });
  const plan = computeRetentionPlan([old, latest], policy, now);
  assert.deepEqual(prunedIds(plan), [old.setId]);
  assert.equal(plan.captureRelease.status, 'planned');
  assert.deepEqual(plan.captureRelease.items, [], 'shared capture stays pinned while the newer kept set uses it');
  const other = sealed(2);
  const both = computeRetentionPlan([old, other, latest], policy, now);
  assert.deepEqual(both.captureRelease.items, [{ captureId: other.captureId, setIds: [other.setId] }]);
});

test('REGRESSION: unrecognized archive keys withhold source pin release as well as object pruning', () => {
  const old = sealed(1), anchor = sealed(3);
  const known = computeRetentionPlan([old, anchor], policy, now);
  assert.deepEqual(known.captureRelease.items, [{ captureId: old.captureId, setIds: [old.setId] }]);
  const unknown = computeRetentionPlan([old, anchor], policy, now, { strayKeys: 1 });
  assert.equal(unknown.execution, 'not_run');
  assert.equal(unknown.objectPrune.status, 'withheld');
  assert.deepEqual(unknown.captureRelease, { status: 'withheld', reason: 'unrecognized_archive_keys', items: [] });
  assert.notEqual(unknown.planSha256, known.planSha256);
  assert.equal(computeRetentionPlan([anchor, old], policy, now, { strayKeys: 1 }).planSha256, unknown.planSha256);
});

test('REGRESSION: mixed production/staging archive keeps one recovery anchor per lineage', () => {
  const prodOnly = sealed(1, { lineage: prod });
  const stagingOld = sealed(2, { lineage: staging }), stagingNew = sealed(3, { lineage: staging });
  const plan = computeRetentionPlan([prodOnly, stagingOld, stagingNew], policy, now);
  assert(keptIds(plan).includes(prodOnly.setId), 'a newer staging set must not supersede the only production anchor');
  assert.deepEqual(prunedIds(plan), [stagingOld.setId]);
  assert.deepEqual(plan.lineages.map(l => l.latestVerified), [prodOnly.setId, stagingNew.setId]);
  const otherDb = sealed(4, { lineage: { ...prod, database: 'freedom_other' } });
  const db = computeRetentionPlan([prodOnly, otherDb], policy, now);
  assert.deepEqual(prunedIds(db), [], 'database is part of the lineage');
  const unanchored = computeRetentionPlan([prodOnly, sealed(2, { lineage: staging, lastVerifiedAt: undefined })], policy, now);
  assert.equal(unanchored.status, 'no_verified_recovery_set', 'every lineage needs its own anchor for status planned');
  assert.equal(unanchored.prune.length, 0);
  assert.throws(() => computeRetentionPlan([sealed(1, { lineage: { ...prod, schema: 'Bad-Schema' } })], policy, now),
    (e: unknown) => e instanceof RetentionError && e.code === 'invalid_policy');
});

test('REGRESSION: any unanchored lineage withholds the entire deletion and pin-release plan', () => {
  const old = sealed(1), anchor = sealed(3);
  for (const lastVerifiedAt of [undefined, '2026-10-01T01:00:00.000Z']) {
    const unanchored = sealed(1, { lineage: staging, lastVerifiedAt });
    const inputs = [old, anchor, unanchored];
    const plan = computeRetentionPlan(inputs, { ...policy, maxReadbackAgeSeconds: 3 * 86_400 }, now);
    assert.equal(plan.status, 'no_verified_recovery_set');
    assert.deepEqual(plan.lineages.map(l => l.latestVerified), [anchor.setId, null]);
    assert.deepEqual(plan.prune, [], 'a healthy lineage must not leave actionable archive deletions');
    assert.deepEqual(keptIds(plan).sort(), inputs.map(s => s.setId).sort());
    assert.equal(plan.objectPrune.status, 'withheld');
    assert.deepEqual(plan.objectPrune.keys, []);
    assert.equal(plan.captureRelease.status, 'withheld');
    assert.deepEqual(plan.captureRelease.items, []);
    assert.equal(computeRetentionPlan([...inputs].reverse(), { ...policy, maxReadbackAgeSeconds: 3 * 86_400 }, now).planSha256,
      plan.planSha256, 'global fail-closed plan remains deterministic');
  }
});

test('Retention fails closed without a fresh verified set and never prunes young, newer, future, anomalous or incomplete sets', () => {
  const noReceipt = [sealed(1, { lastVerifiedAt: undefined }), sealed(2, { lastVerifiedAt: undefined })];
  const none = computeRetentionPlan(noReceipt, policy, now);
  assert.equal(none.status, 'no_verified_recovery_set'); assert.equal(none.prune.length, 0); assert.equal(none.captureRelease.items.length, 0);
  const stale = computeRetentionPlan([sealed(1), sealed(2)], { ...policy, maxReadbackAgeSeconds: 3600 }, now);
  assert.equal(stale.status, 'no_verified_recovery_set', 'stale receipts do not count as verified'); assert.equal(stale.prune.length, 0);

  const old = sealed(1), anchor = sealed(3), pending = sealed(4, { lastVerifiedAt: undefined });
  const future = sealed(9, { createdAt: '2026-10-11T00:00:00.000Z', lastVerifiedAt: undefined });
  const broken = sealed(5, { anomalies: ['missing_member'] });
  const incomplete: RecoverySetState = { setId: randomUUID(), status: 'incomplete', archiveKeys: [], anomalies: [] };
  const plan = computeRetentionPlan([old, anchor, pending, future, broken, incomplete], policy, now);
  assert.equal(plan.lineages[0].latestVerified, anchor.setId, 'an anomalous set is never the anchor even with a newer receipt');
  assert.deepEqual(prunedIds(plan), [old.setId]);
  const reasons = Object.fromEntries(plan.keep.map(k => [k.setId, k.reasons]));
  assert(reasons[pending.setId].includes('newer_than_latest_verified'));
  assert(reasons[future.setId].includes('future_created_at'));
  assert(reasons[broken.setId].includes('anomaly'));
  assert(reasons[incomplete.setId].includes('incomplete'));
  assert.equal(plan.objectPrune.status, 'withheld', 'unknown references in a kept set withhold object pruning');
  assert.equal(plan.captureRelease.status, 'withheld', 'unknown captures in a kept set withhold pin release');
  const young = computeRetentionPlan([old, anchor], { ...policy, minRetentionSeconds: 30 * 86_400 }, now);
  assert.deepEqual(young.prune, [], 'minimum retention protects every set');
  assert.throws(() => computeRetentionPlan([old], { ...policy, keepVerified: 0 }, now), (e: unknown) => e instanceof RetentionError && e.code === 'invalid_policy');
  assert.throws(() => computeRetentionPlan([old, anchor], { ...policy, maxSets: 1 }, now), (e: unknown) => e instanceof RetentionError && e.code === 'retention_scan_overflow');
});

async function archiveWithSets() {
  const backupObjects = new FakeObjectStore(), source = new FakeObjectStore();
  const root = await mkdtemp(join(tmpdir(), 'fp-recovery-retention-')), archive = await createFileArchiveStore(root);
  async function seal(environment: 'production' | 'staging', database: string, createdAt: string, verified = true) {
    const value = await preparePrivateText(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('Synthetic ' + randomUUID())); c.close(); } }),
      'text/plain', { revision: 'synthetic-retention', platformPersistenceAllowed: true });
    const ids = { assetId: randomUUID(), scopeId: randomUUID(), representationId: randomUUID() };
    await source.putImmutable(objectKey(ids), value);
    const capture: BackupCapture = { captureId: randomUUID(), referenceSnapshot: '1:2:', sourceRelease: 'b'.repeat(40), sourceSchema: 'public',
      references: [{ asset_id: ids.assetId, scope_id: ids.scopeId, representation_id: ids.representationId, policy_revision: 'synthetic-retention',
        byte_size: value.metadata.byteSize, content_sha256: value.metadata.sha256 }] };
    const objects = await transferBackup(capture, source, backupObjects, { async renew() {}, async assertCurrent() { return structuredClone(capture); } });
    const dump = new Uint8Array(randomBytes(4096));
    const backup: ConsistentBackup = { version: 1, status: 'database_snapshot_and_objects_verified', database,
      dump: { sha256: createHash('sha256').update(dump).digest('hex'), byteSize: dump.byteLength }, objects };
    const setId = randomUUID();
    await sealRecoverySet({ backup, setId, environment, createdAt, archive, backupObjects,
      dump: { async open() { return new ReadableStream({ start(c) { c.enqueue(dump); c.close(); } }); } } });
    if (!verified) for (const k of await archive.list(recoverySetKeys(setId).readbackPrefix, 10)) await unlink(join(root, k));
    return setId;
  }
  return { root, archive, backupObjects, seal };
}

test('Archive scan plans from real sealed manifests and receipts, flags strays, and the CLI is plan-only and fail-closed', async () => {
  const a = await archiveWithSets();
  const old = await a.seal('production', 'freedom_next', '2026-10-01T00:00:00.000Z');
  const anchor = await a.seal('production', 'freedom_next', '2026-10-03T00:00:00.000Z');
  const stagingOnly = await a.seal('staging', 'freedom_staging_next', '2026-10-04T00:00:00.000Z');
  const unverified = await a.seal('production', 'freedom_next', '2026-10-05T00:00:00.000Z', false);
  // Re-reading the anchor later refreshes freshness via a new receipt.
  await readbackRecoverySet({ archive: a.archive, setId: anchor, backupObjects: a.backupObjects, verifiedAt: '2026-10-09T00:00:00.000Z', writeReceipt: true });
  const plan = await planRecoverySetRetention(a.archive, { ...policy, maxReadbackAgeSeconds: 2 * 86_400 }, scanNow);
  assert.equal(plan.status, 'no_verified_recovery_set', 'staging receipt is stale relative to the 2 day window');
  assert.deepEqual(plan.prune, [], 'archive scanner must not emit partial deletions for a mixed anchored/unanchored archive');
  assert.equal(plan.keep.length, 4);
  assert.equal(plan.objectPrune.status, 'withheld'); assert.deepEqual(plan.objectPrune.keys, []);
  assert.equal(plan.captureRelease.status, 'withheld'); assert.deepEqual(plan.captureRelease.items, []);
  const wide = await planRecoverySetRetention(a.archive, policy, scanNow);
  assert.equal(wide.status, 'planned');
  assert.deepEqual(wide.prune.map(p => p.setId), [old]);
  assert(wide.keep.some(k => k.setId === stagingOnly && k.reasons.includes('latest_verified')));
  assert(wide.keep.some(k => k.setId === unverified && k.reasons.includes('newer_than_latest_verified')));
  assert.deepEqual(wide.prune[0].archiveKeys.filter(k => !k.includes('/readback/')).sort(),
    [recoverySetKeys(old).dump, recoverySetKeys(old).manifest].sort());

  const cli = await runBackupRetention(['--archive-dir', a.root, '--now', scanNow, '--keep-verified', '1', '--min-retention-hours', '0', '--max-readback-age-hours', '168', '--max-sets', '100']);
  assert.equal(cli.exitCode, 0); assert.equal((cli.report as { planSha256: string }).planSha256, wide.planSha256);
  const mixed = await runBackupRetention(['--archive-dir', a.root, '--now', scanNow, '--keep-verified', '1', '--min-retention-hours', '0', '--max-readback-age-hours', '48', '--max-sets', '100']);
  assert.equal(mixed.exitCode, 3);
  assert.deepEqual(mixed.report, plan, 'CLI preserves the empty deletion and pin-release plan when only one lineage is fresh');
  const strict = await runBackupRetention(['--archive-dir', a.root, '--now', scanNow, '--keep-verified', '1', '--min-retention-hours', '0', '--max-readback-age-hours', '1']);
  assert.equal(strict.exitCode, 3, 'no fresh anchor exits non-zero');
  assert.equal((await runBackupRetention(['--archive-dir', a.root, '--now', scanNow])).exitCode, 2, 'retention parameters are mandatory');
  assert.equal((await runBackupRetention(['--archive-dir', 'relative', '--now', scanNow, '--keep-verified', '1', '--min-retention-hours', '0', '--max-readback-age-hours', '1'])).exitCode, 2);

  // A stray key alone must withhold pins even while every known manifest decodes.
  await mkdir(join(a.root, 'recovery-sets', 'stray'), { recursive: true });
  await writeFile(join(a.root, 'recovery-sets', 'stray', 'unknown.bin'), 'x');
  const stray = await planRecoverySetRetention(a.archive, policy, scanNow);
  assert.deepEqual(stray.captureRelease, { status: 'withheld', reason: 'unrecognized_archive_keys', items: [] });
  assert.equal(stray.objectPrune.status, 'withheld');
  assert.deepEqual(stray.prune.map(p => p.setId), [old]);
  // A corrupt manifest also remains kept and reported.
  await writeFile(join(a.root, recoverySetKeys(unverified).manifest), '{}');
  const flagged = await planRecoverySetRetention(a.archive, policy, scanNow);
  assert(flagged.inspect.some(i => i.setId === unverified && i.reasons.includes('corrupt')));
  assert.equal(flagged.strayKeys, 1);
  assert.equal(flagged.objectPrune.status, 'withheld');
  assert.equal(flagged.captureRelease.status, 'withheld');
  assert.deepEqual(flagged.prune.map(p => p.setId), [old], 'the verified anchor and its lineage logic are unaffected');
});
