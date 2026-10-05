// Isolated TEST_DATABASE_URL only (disposable fp_* schema). Real PostgreSQL
// catalog/sequence behavior for recovery evidence and the superset GC guard.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createPool } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { collectSchemaEvidence, compareEvidence, BackupEvidenceError, type SchemaEvidence } from '../../packages/media-migration/backup-evidence.js';
import { observeMediaGcState, assessPostDumpSupersetWindow } from '../../packages/media-migration/backup-gc-precondition.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('Backup evidence tests require explicit isolated TEST_DATABASE_URL.');
const schema = `fp_backup_evidence_${process.pid}_${Date.now()}`;
const admin = createPool(connectionString), pool = new Pool({ connectionString, options: `-c search_path=${schema} -c statement_timeout=20000`, max: 4 });
let created = false;
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); created = true; await migrate(pool); });
after(async () => { await pool.end(); if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

async function evidence(): Promise<SchemaEvidence> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try { return await collectSchemaEvidence(client, schema); } finally { await client.query('ROLLBACK'); }
  } finally { client.release(); }
}
const mismatch = (e: unknown) => e instanceof BackupEvidenceError && e.code === 'evidence_mismatch';

test('Schema evidence includes the real standalone positioning_guild_officer_revision sequence and detects its reset', async () => {
  const owned = (await pool.query(`SELECT count(*)::int n FROM pg_depend d JOIN pg_class s ON s.oid=d.objid
    WHERE s.relname='positioning_guild_officer_revision' AND s.relnamespace=$1::regnamespace AND d.deptype IN ('a','i')`, [schema])).rows[0].n;
  assert.equal(owned, 0, 'precondition: the migration sequence really has no OWNED BY table');
  await pool.query(`SELECT nextval('positioning_guild_officer_revision') FROM generate_series(1,3)`);
  const first = await evidence();
  const standalone = first.sequences.find(s => s.name === 'positioning_guild_officer_revision');
  assert(standalone, 'standalone sequence is recorded'); assert.equal(standalone.cycle, false);
  assert(!first.tables.some(t => t.sequences.some(s => s.name === 'positioning_guild_officer_revision')), 'owned-sequence collector alone would omit it');
  assert(first.tables.length > 100, 'every migrated table is enumerated');
  assert.equal(first.tableSnapshot, 'exported_snapshot_mvcc'); assert.equal(first.sequenceState, 'read_after_snapshot_lower_bound');
  await pool.query(`SELECT nextval('positioning_guild_officer_revision')`);
  const later = await evidence();
  const advanced = compareEvidence(first, later);
  assert.equal(advanced.sequencesAdvanced, 1, 'a later non-MVCC read is reported as advanced, not hidden');
  assert.equal(advanced.sequences, first.sequences.length);
  assert.throws(() => compareEvidence(later, first), mismatch, 'a restored value below the recorded lower bound is a mismatch');
  await pool.query(`ALTER SEQUENCE positioning_guild_officer_revision RENAME TO positioning_guild_officer_revision_moved`);
  const renamed = await evidence();
  await pool.query(`ALTER SEQUENCE positioning_guild_officer_revision_moved RENAME TO positioning_guild_officer_revision`);
  assert.throws(() => compareEvidence(later, renamed), mismatch, 'a missing standalone sequence cannot report matched');
});

test('Descending or CYCLE sequences are rejected instead of compared as lower bounds', async () => {
  const unsupported = (e: unknown) => e instanceof BackupEvidenceError && e.code === 'evidence_unsupported_sequence';
  await pool.query('CREATE SEQUENCE fp_cycle_probe CYCLE');
  try { await assert.rejects(evidence(), unsupported); } finally { await pool.query('DROP SEQUENCE fp_cycle_probe'); }
  await pool.query('CREATE SEQUENCE fp_descending_probe INCREMENT BY -1');
  try { await assert.rejects(evidence(), unsupported); } finally { await pool.query('DROP SEQUENCE fp_descending_probe'); }
  assert.ok((await evidence()).sequences.length > 0);
});

test('Evidence collection refuses a non-snapshot transaction', async () => {
  const client = await pool.connect();
  try {
    await assert.rejects(collectSchemaEvidence(client, schema), (e: unknown) => e instanceof BackupEvidenceError && e.code === 'evidence_unavailable');
  } finally { client.release(); }
});

test('Superset GC guard: safe only with GC disabled at both ends and an unchanged tombstone set', async () => {
  const before = await observeMediaGcState(pool);
  assert.equal(before.maintenanceEnabled, false); assert.equal(before.tombstones, 0); assert.equal(before.schema, schema);
  await delay(5);
  const after = await observeMediaGcState(pool);
  assert.deepEqual(assessPostDumpSupersetWindow(before, after), { status: 'superset_window_safe', reasons: [] });
  assert.deepEqual(assessPostDumpSupersetWindow(after, before).reasons, ['window_order_invalid']);
  await pool.query(`UPDATE asset_maintenance_policy SET enabled=true,revision='synthetic-superset',orphan_retention_seconds=1,
    retired_retention_seconds=1,delete_lease_seconds=30,capture_seconds=60,pin_seconds=60,max_capture_objects=10`);
  try {
    await delay(5);
    const enabled = await observeMediaGcState(pool);
    assert.deepEqual(assessPostDumpSupersetWindow(before, enabled), { status: 'superset_window_unsafe', reasons: ['gc_enabled_after'] });
  } finally { await pool.query('UPDATE asset_maintenance_policy SET enabled=false'); }
  await delay(5);
  const later = await observeMediaGcState(pool);
  assert.deepEqual(assessPostDumpSupersetWindow(before, { ...later, tombstones: 1, tombstoneDigest: 'f'.repeat(64) }).reasons, ['tombstones_changed']);
  assert.deepEqual(assessPostDumpSupersetWindow(before, { ...later, schema: 'public' }).reasons, ['target_changed']);
});
