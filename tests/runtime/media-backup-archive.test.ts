// Synthetic, no database or cloud: recovery-set archive seal/readback failure
// paths over the real local filesystem archive store and the test-only fake
// ObjectStore. Database restore and real pg_dump are covered by the owned
// container drill (tests/integration/media-backup-archive.test.ts), not here.
import { test,after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, readdir, symlink, mkdir, chmod,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Pool } from 'pg';
import { FakeObjectStore } from '../../packages/asset-storage/fake-store.js';
import { objectKey, preparePrivateText } from '../../packages/asset-storage/index.js';
import { transferBackup, type BackupCapture } from '../../packages/media-migration/backup-transfer.js';
import type { ConsistentBackup } from '../../packages/media-migration/backup-coordinator.js';
import { sealRecoverySet, readbackRecoverySet, recoverySetKeys, decodeRecoverySet, RecoveryArchiveError,
  restoredReferenceAuthorization, restoreRecoverySet, type RestoreObjectAuthority, type ArchiveStore } from '../../packages/media-migration/backup-archive.js';
import { createFileArchiveStore, FileArchiveStoreError } from '../../packages/media-migration/backup-archive-fs.js';
import { compareEvidence, encodeEvidence, decodeEvidence, BackupEvidenceError, type SchemaEvidence } from '../../packages/media-migration/backup-evidence.js';

const policy = { revision: 'synthetic-archive', platformPersistenceAllowed: true };
const stream = (bytes: Uint8Array) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
const code = (expected: string, detail?: string) => (e: unknown) =>
  e instanceof RecoveryArchiveError && e.code === expected && (detail === undefined || e.detail === detail) && !e.message.includes('RAW_PRIVATE');
const SCHEMA = 'fp_synthetic_backup';
const directories:string[]=[];
async function directory(prefix:string){const root=await mkdtemp(join(tmpdir(),prefix));directories.push(root);return root;}
after(async()=>{await Promise.all(directories.map(root=>rm(root,{recursive:true,force:true})));});

function syntheticEvidence(overrides: Partial<SchemaEvidence> = {}): SchemaEvidence {
  return { format: 'freedom.snapshot-evidence/v2', schema: SCHEMA, tableSnapshot: 'exported_snapshot_mvcc',
    sequenceState: 'read_after_snapshot_lower_bound',
    tables: [{ schema: SCHEMA, table: 'synthetic_rows', columns: [{ name: 'id', type: 'bigint' }], count: '2', fingerprint: 'a'.repeat(64),
      sequences: [{ schema: SCHEMA, name: 'synthetic_rows_id_seq', lastValue: '2', isCalled: true }] }],
    sequences: [
      { name: 'positioning_guild_officer_revision', dataType: 'bigint', start: '1', increment: '1', min: '1', max: '9223372036854775807', cycle: false, lastValue: '7', isCalled: true },
      { name: 'synthetic_rows_id_seq', dataType: 'bigint', start: '1', increment: '1', min: '1', max: '9223372036854775807', cycle: false, lastValue: '2', isCalled: true },
    ], ...overrides };
}

async function fixture(options: { evidence?: boolean } = {}) {
  const source = new FakeObjectStore(), backupObjects = new FakeObjectStore();
  const references = [];
  for (const text of ['Synthetic archive object one', 'Synthetic archive object two']) {
    const value = await preparePrivateText(stream(new TextEncoder().encode(text)), 'text/plain', policy);
    const ids = { assetId: randomUUID(), scopeId: randomUUID(), representationId: randomUUID() };
    await source.putImmutable(objectKey(ids), value);
    references.push({ asset_id: ids.assetId, scope_id: ids.scopeId, representation_id: ids.representationId, policy_revision: policy.revision,
      byte_size: value.metadata.byteSize, content_sha256: value.metadata.sha256 });
  }
  const capture: BackupCapture = { captureId: randomUUID(), referenceSnapshot: '100:200:150', sourceRelease: 'a'.repeat(40), sourceSchema: SCHEMA, references };
  const objects = await transferBackup(capture, source, backupObjects, { async renew() {}, async assertCurrent() { return structuredClone(capture); } });
  const dumpBytes = new Uint8Array(randomBytes(300_000));
  const backup: ConsistentBackup = { version: 1, status: 'database_snapshot_and_objects_verified', database: 'fp_synthetic',
    dump: { sha256: createHash('sha256').update(dumpBytes).digest('hex'), byteSize: dumpBytes.byteLength }, objects,
    ...(options.evidence === false ? {} : { evidence: syntheticEvidence() }) };
  const root = await directory('fp-recovery-archive-');
  const archive = await createFileArchiveStore(root);
  const chunked = (bytes: Uint8Array) => ({ async open() { return new ReadableStream<Uint8Array>({ start(c) {
    for (let i = 0; i < bytes.byteLength; i += 65_536) c.enqueue(bytes.slice(i, i + 65_536)); c.close(); } }); } });
  return { source, backupObjects, backup, dumpBytes, root, archive, dump: chunked(dumpBytes), chunked, capture };
}
const createdAt = '2026-10-04T20:00:00.000Z';

test('Restored reference authority captures its mode and bound current check before caller mutation', async () => {
  let queries=0,checks=0;
  const pool={async query(){queries++;return {rows:[{database:'fp_restored',found:true}]};}} as unknown as Pool;
  const current={mode:'current_authority' as const,async assertCurrent(){assert.equal(this,current);checks++;throw Error('current_revoked');}};
  const authority=restoredReferenceAuthorization(pool,{database:'fp_restored',schema:SCHEMA,current});
  Object.assign(current,{mode:'quarantine',assertCurrent:async()=>{}});
  const f=await fixture();
  await assert.rejects(authority.authorization.assertAllowed(f.backup.objects.objects[0]),/current_revoked/);
  assert.equal(authority.exposure,'current_authority_applied');assert.equal(checks,1);assert.equal(queries,0);
});

async function syntheticRestore(onRestore:()=>void,authority:RestoreObjectAuthority){
  const f=await fixture({evidence:false}),setId=randomUUID(),destination=new FakeObjectStore();
  await sealRecoverySet({backup:f.backup,setId,environment:'local',createdAt,dump:f.dump,archive:f.archive,backupObjects:f.backupObjects});
  const result=restoreRecoverySet({archive:f.archive,setId,backupObjects:f.backupObjects,destinationObjects:destination,
    restoredDatabase:'fp_restored',restoredPool:{async query(){return {rows:[{database:'fp_restored',relations:0}]};}} as unknown as Pool,
    database:{async restore({archive}){onRestore();await new Response(archive).arrayBuffer();}},objectAuthority:authority,allowUnavailableEvidence:true});
  return {result,destination,objects:f.backup.objects.objects};
}

test('Restore binds the selected authorization before an awaited database writer can replace it',async()=>{
  let checks=0;
  const authorization={async assertAllowed():Promise<void>{assert.equal(this,authorization);checks++;throw Error('current_revoked');}};
  const authority={authorization,exposure:'current_authority_applied' as const};
  const f=await syntheticRestore(()=>{authorization.assertAllowed=async()=>{};authority.authorization={async assertAllowed(){}};},authority);
  await assert.rejects(f.result,code('objects_restore_failed','restore_unauthorized'));
  assert.equal(checks,1);for(const object of f.objects)assert.equal(await f.destination.head(object.key),null);
});

test('Restore cannot promote quarantine to current-authority exposure through mutation during an await',async()=>{
  const authority={authorization:{async assertAllowed(){}},exposure:'quarantine_not_approved_for_exposure' as const};
  const f=await syntheticRestore(()=>Object.assign(authority,{exposure:'current_authority_applied'}),authority);
  assert.equal((await f.result).exposure,'quarantine_not_approved_for_exposure');
});

test('Seal writes dump/evidence before the manifest, reads everything back and records a receipt; resume is idempotent', async () => {
  const f = await fixture(), setId = randomUUID(), keys = recoverySetKeys(setId);
  const sealed = await sealRecoverySet({ backup: f.backup, setId, environment: 'local', createdAt, dump: f.dump, archive: f.archive, backupObjects: f.backupObjects });
  assert.equal(sealed.status, 'recovery_set_verified');
  assert.deepEqual(sealed.dump, f.backup.dump);
  assert.deepEqual(sealed.objects, { count: 2, bytes: f.backup.objects.objects.reduce((n, o) => n + o.metadata.byteSize, 0) });
  assert.equal(sealed.evidence.status, 'captured');
  assert.equal(sealed.captureId, f.capture.captureId);
  assert.deepEqual(new Uint8Array(await readFile(join(f.root, keys.dump))), f.dumpBytes);
  const manifest = decodeRecoverySet(new Uint8Array(await readFile(join(f.root, keys.manifest))));
  assert.equal(manifest.manifestSha256, sealed.manifestSha256);
  assert.equal(manifest.body.consistency.mode, 'same_exported_snapshot');
  assert.equal(manifest.body.consistency.sourcePins, 'held_until_retention_release');
  assert.ok(sealed.receiptKey?.startsWith(keys.readbackPrefix));
  const again = await sealRecoverySet({ backup: f.backup, setId, environment: 'local', createdAt, dump: f.dump, archive: f.archive, backupObjects: f.backupObjects });
  assert.equal(again.manifestSha256, sealed.manifestSha256);
  assert.equal((await readdir(join(f.root, keys.readbackPrefix))).length, 2, 'each verified readback adds a create-only receipt');
});

test('Seal refuses a dump whose bytes differ from coordinator evidence and never publishes a manifest', async () => {
  const f = await fixture(), setId = randomUUID(), keys = recoverySetKeys(setId);
  const wrong = f.dumpBytes.slice(); wrong[wrong.length - 1] ^= 1;
  await assert.rejects(sealRecoverySet({ backup: f.backup, setId, environment: 'local', createdAt, dump: f.chunked(wrong), archive: f.archive, backupObjects: f.backupObjects }), code('dump_mismatch'));
  const truncated = f.dumpBytes.slice(0, -1);
  await assert.rejects(sealRecoverySet({ backup: f.backup, setId, environment: 'local', createdAt, dump: f.chunked(truncated), archive: f.archive, backupObjects: f.backupObjects }), code('dump_mismatch'));
  assert.deepEqual(await f.archive.list(keys.base, 10), [], 'no partial dump or manifest survives a digest failure');
  await assert.rejects(sealRecoverySet({ backup: f.backup, setId, environment: 'local', createdAt,
    dump: { async open() { throw Error('RAW_PRIVATE path'); } }, archive: f.archive, backupObjects: f.backupObjects }), code('source_unavailable'));
});

test('Seal refuses when the backup object copy is missing, before writing any archive member', async () => {
  const f = await fixture(), setId = randomUUID();
  await f.backupObjects.delete(f.backup.objects.objects[0].key);
  await assert.rejects(sealRecoverySet({ backup: f.backup, setId, environment: 'local', createdAt, dump: f.dump, archive: f.archive, backupObjects: f.backupObjects }),
    code('objects_unverified', 'object_missing'));
  assert.deepEqual(await f.archive.list(recoverySetKeys(setId).base, 10), []);
});

test('Reusing a setId for a different backup is a conflict, never an overwrite', async () => {
  const f = await fixture(), g = await fixture(), setId = randomUUID(), keys = recoverySetKeys(setId);
  await sealRecoverySet({ backup: f.backup, setId, environment: 'local', createdAt, dump: f.dump, archive: f.archive, backupObjects: f.backupObjects });
  const before = await readFile(join(f.root, keys.dump));
  await assert.rejects(sealRecoverySet({ backup: g.backup, setId, environment: 'local', createdAt, dump: g.dump, archive: f.archive, backupObjects: g.backupObjects }), code('archive_conflict'));
  assert.deepEqual(await readFile(join(f.root, keys.dump)), before);
});

test('Readback detects dump bit rot, manifest tampering, evidence tampering and lost backup objects', async () => {
  const f = await fixture(), setId = randomUUID(), keys = recoverySetKeys(setId);
  await sealRecoverySet({ backup: f.backup, setId, environment: 'local', createdAt, dump: f.dump, archive: f.archive, backupObjects: f.backupObjects });
  const read = (writeReceipt = false) => readbackRecoverySet({ archive: f.archive, setId, backupObjects: f.backupObjects, verifiedAt: '2026-10-05T00:00:00.000Z', writeReceipt });
  assert.equal((await read()).status, 'recovery_set_verified');
  await assert.rejects(readbackRecoverySet({ archive: f.archive, setId, backupObjects: f.backupObjects, verifiedAt: '2026-10-03T00:00:00.000Z' }), code('invalid_input'),
    'a receipt cannot predate the set');

  const dumpPath = join(f.root, keys.dump), original = await readFile(dumpPath);
  await chmod(dumpPath, 0o600); const rot = Buffer.from(original); rot[1234] ^= 0xff; await writeFile(dumpPath, rot);
  await assert.rejects(read(true), code('dump_mismatch'));
  await writeFile(dumpPath, original);

  const manifestPath = join(f.root, keys.manifest), manifest = await readFile(manifestPath);
  await writeFile(manifestPath, Buffer.concat([manifest, Buffer.from('\n')]));
  await assert.rejects(read(), code('archive_corrupt'), 'non-canonical manifest bytes are rejected');
  const text = manifest.toString('utf8').replace('"objectCount":2', '"objectCount":1');
  await writeFile(manifestPath, text);
  await assert.rejects(read(), code('archive_corrupt'), 'body digest catches edits');
  await writeFile(manifestPath, manifest);

  const evidencePath = join(f.root, keys.evidence), evidence = await readFile(evidencePath);
  await writeFile(evidencePath, evidence.toString('utf8').replace('"lastValue":"7"', '"lastValue":"8"'));
  await assert.rejects(read(), code('evidence_mismatch'));
  await writeFile(evidencePath, evidence);

  await f.backupObjects.delete(f.backup.objects.objects[1].key);
  await assert.rejects(read(), code('objects_unverified', 'object_missing'));
  assert.equal((await readdir(join(f.root, keys.readbackPrefix))).length, 1, 'failed readbacks never write receipts');
});

test('Archive store failures surface only fixed codes', async () => {
  const f = await fixture(), setId = randomUUID();
  const broken: ArchiveStore = { async putIfAbsent() { throw Error('RAW_PRIVATE bucket credential'); }, get: f.archive.get, list: f.archive.list };
  await assert.rejects(sealRecoverySet({ backup: f.backup, setId, environment: 'local', createdAt, dump: f.dump, archive: broken, backupObjects: f.backupObjects }), code('archive_unavailable'));
  const lying: ArchiveStore = { async putIfAbsent(_k, body) { await body.cancel(); return 'created'; }, get: f.archive.get, list: f.archive.list };
  await assert.rejects(sealRecoverySet({ backup: f.backup, setId: randomUUID(), environment: 'local', createdAt, dump: f.dump, archive: lying, backupObjects: f.backupObjects }),
    code('archive_unavailable'), 'a store that claims success without consuming the verified stream is not trusted');
});

test('Filesystem archive store is create-only and refuses traversal, symlinks and non-regular files', async () => {
  const root = await directory('fp-recovery-fs-'), store = await createFileArchiveStore(root);
  assert.equal(await store.putIfAbsent('recovery-sets/a/one.bin', stream(new Uint8Array([1]))), 'created');
  assert.equal(await store.putIfAbsent('recovery-sets/a/one.bin', stream(new Uint8Array([2]))), 'exists');
  assert.deepEqual(new Uint8Array(await readFile(join(root, 'recovery-sets/a/one.bin'))), new Uint8Array([1]));
  const fsCode = (c: string) => (e: unknown) => e instanceof FileArchiveStoreError && e.code === c;
  for (const key of ['../escape', 'recovery-sets/../x', '/abs', 'recovery-sets/A/upper', 'recovery-sets/.tmp-x/y'])
    await assert.rejects(store.putIfAbsent(key, stream(new Uint8Array([1]))), fsCode('invalid_key'));
  await mkdir(join(root, 'elsewhere'));
  await symlink(join(root, 'elsewhere'), join(root, 'recovery-sets', 'linked'));
  await assert.rejects(store.putIfAbsent('recovery-sets/linked/x', stream(new Uint8Array([1]))), fsCode('invalid_key'));
  await assert.rejects(store.list('recovery-sets/', 10), fsCode('invalid_key'));
  execFileSync('mkfifo', [join(root, 'recovery-sets', 'a', 'pipe')]);
  await assert.rejects(store.get('recovery-sets/a/pipe'), fsCode('invalid_key'), 'FIFO is rejected before a blocking open');
  assert.equal(await store.get('recovery-sets/a/missing'), null);
  await assert.rejects(createFileArchiveStore('relative/dir'), fsCode('invalid_root'));
  const big = await directory('fp-recovery-fs-'), bounded = await createFileArchiveStore(big);
  for (let i = 0; i < 3; i++) await bounded.putIfAbsent(`recovery-sets/s/f${i}`, stream(new Uint8Array([i])));
  await assert.rejects(bounded.list('recovery-sets/', 2), fsCode('list_overflow'), 'listing fails instead of truncating');
});

test('Evidence comparison covers standalone sequences and separates MVCC tables from lower-bound sequence state', () => {
  const recorded = syntheticEvidence();
  assert.deepEqual(decodeEvidence(encodeEvidence(recorded)), recorded);
  const same = compareEvidence(recorded, syntheticEvidence());
  assert.deepEqual(same, { tables: 1, rows: '2', sequences: 2, sequencesAdvanced: 0 });
  const advanced = syntheticEvidence({ sequences: recorded.sequences.map(s => s.name === 'positioning_guild_officer_revision' ? { ...s, lastValue: '9' } : s) });
  assert.equal(compareEvidence(recorded, advanced).sequencesAdvanced, 1);
  const mismatch = (e: unknown) => e instanceof BackupEvidenceError && e.code === 'evidence_mismatch';
  const missing = syntheticEvidence({ sequences: recorded.sequences.filter(s => s.name !== 'positioning_guild_officer_revision') });
  assert.throws(() => compareEvidence(recorded, missing), mismatch, 'a dropped standalone sequence cannot report matched');
  const reset = syntheticEvidence({ sequences: recorded.sequences.map(s => s.name === 'positioning_guild_officer_revision' ? { ...s, lastValue: '1' } : s) });
  assert.throws(() => compareEvidence(recorded, reset), mismatch, 'a reset standalone sequence cannot report matched');
  const uncalled = syntheticEvidence({ sequences: recorded.sequences.map(s => s.name === 'positioning_guild_officer_revision' ? { ...s, isCalled: false } : s) });
  assert.throws(() => compareEvidence(recorded, uncalled), mismatch);
  const redefined = syntheticEvidence({ sequences: recorded.sequences.map(s => s.name === 'positioning_guild_officer_revision' ? { ...s, max: '100' } : s) });
  assert.throws(() => compareEvidence(recorded, redefined), mismatch);
  const rows = syntheticEvidence({ tables: [{ ...recorded.tables[0], fingerprint: 'b'.repeat(64) }] });
  assert.throws(() => compareEvidence(recorded, rows), mismatch);
  const invalid = (e: unknown) => e instanceof BackupEvidenceError && e.code === 'evidence_invalid';
  assert.throws(() => encodeEvidence(syntheticEvidence({ sequences: [{ ...recorded.sequences[0], increment: '-1' }] })), invalid, 'descending sequences cannot use lower-bound evidence');
  assert.throws(() => encodeEvidence({ ...recorded, sequences: [{ ...recorded.sequences[0], cycle: true as false }] }), invalid, 'CYCLE sequences cannot use lower-bound evidence');
});
