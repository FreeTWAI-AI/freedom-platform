import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool, type PoolClient } from 'pg';
import { migrate } from '../../scripts/database.js';
import { createAssetMaintenance } from '../../modules/assets/maintenance.js';
import { FakeObjectStore } from '../../packages/asset-storage/fake-store.js';
import { createConsistentAssetBackup, ConsistentBackupError } from '../../packages/media-migration/backup-coordinator.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('Backup coordinator tests require explicit isolated TEST_DATABASE_URL.');
const schema = `fp_backup_coordinator_${process.pid}_${Date.now()}`;
const admin = new Pool({ connectionString, max: 2 });
const pool = new Pool({ connectionString, options: `-c search_path=${schema} -c statement_timeout=10000`, max: 4 });
const source = new FakeObjectStore(), destination = new FakeObjectStore();
const maintenance = createAssetMaintenance(pool, { store: source, enabled: true });
let created = false, database: string;
before(async () => {
  database = (await admin.query('SELECT current_database() AS database')).rows[0].database;
  await admin.query(`CREATE SCHEMA ${schema}`); created = true; await migrate(pool);
  await pool.query(`UPDATE asset_maintenance_policy SET enabled=true,revision='synthetic-coordinator',orphan_retention_seconds=1,
    retired_retention_seconds=1,delete_lease_seconds=30,capture_seconds=60,pin_seconds=60,max_capture_objects=10`);
});
after(async () => { await pool.end(); if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

const dump = { sha256: 'c'.repeat(64), byteSize: 1 };
const options = () => ({ enabled: true, target: { database, sourceSchema: schema, sourceRelease: 'a'.repeat(40) },
  maintenance, source, destination });
function observeExporter() {
  let exporter: PoolClient | undefined;
  pool.once('acquire', client => { exporter = client; });
  return () => { assert(exporter); return exporter; };
}
const failed = (error: unknown) => error instanceof ConsistentBackupError && error.code === 'backup_capture_failed';

test('Exporter idle bound exceeds the daily 180 s dump budget and successful release removes its listener', async () => {
  const exporter = observeExporter(); let handlers: ReturnType<PoolClient['listeners']> = [];
  const result = await createConsistentAssetBackup(pool, { ...options(), databaseSnapshot: { async write() {
    const client = exporter(); handlers = client.listeners('error');
    const idle = (await client.query('SHOW idle_in_transaction_session_timeout')).rows[0].idle_in_transaction_session_timeout;
    const milliseconds = (await client.query('SELECT extract(epoch FROM $1::interval)*1000 AS milliseconds', [idle])).rows[0].milliseconds;
    assert(Number(milliseconds) > 180_000, `Exporter idle bound ${idle} must exceed the dump budget.`);
    assert.equal((await client.query('SHOW statement_timeout')).rows[0].statement_timeout, '30s');
    assert.equal((await client.query('SHOW lock_timeout')).rows[0].lock_timeout, '3s');
    return dump;
  } } });
  assert.equal(result.status, 'database_snapshot_and_objects_verified'); assert.equal(handlers.length, 1);
  for (const handler of handlers) assert(!exporter().listeners('error').includes(handler));
  assert.equal((await pool.query('SELECT 1 AS usable')).rows[0].usable, 1);
});

test('Terminated idle exporter rejects capture without an uncaught error and leaves the pool usable', { timeout: 10000 }, async () => {
  const exporter = observeExporter(), uncaught: unknown[] = [];
  const guard = (error: Error) => { uncaught.push(error); };
  let handlers: ReturnType<PoolClient['listeners']> = [], released: unknown;
  const onRelease = (error: unknown, client: PoolClient) => { if (client === exporter()) released = error; };
  process.once('uncaughtException', guard); pool.on('release', onRelease);
  try {
    await assert.rejects(createConsistentAssetBackup(pool, { ...options(), databaseSnapshot: { async write() {
      const client = exporter(); handlers = client.listeners('error');
      const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const ended = new Promise<void>(resolve => client.once('end', resolve));
      assert.equal((await admin.query('SELECT pg_terminate_backend($1) AS terminated', [pid])).rows[0].terminated, true);
      await ended; // The writer resolves only after asynchronous termination has reached the exporter.
      return dump;
    } } }), failed);
    assert.deepEqual(uncaught, []); assert.equal(handlers.length, 1); assert.equal(released, true);
    for (const handler of handlers) assert(!exporter().listeners('error').includes(handler));
    assert.equal((await pool.query('SELECT 1 AS usable')).rows[0].usable, 1);
    assert.equal((await pool.query("SELECT state FROM asset_backup_captures ORDER BY created_at DESC LIMIT 1")).rows[0].state, 'pinned');
  } finally { process.removeListener('uncaughtException', guard); pool.removeListener('release', onRelease); }
});

test('An exporter error still destroys the client when ROLLBACK succeeds', async () => {
  const exporter = observeExporter(); let handlers: ReturnType<PoolClient['listeners']> = [], released: unknown;
  const onRelease = (error: unknown, client: PoolClient) => { if (client === exporter()) released = error; };
  pool.on('release', onRelease);
  try {
    await assert.rejects(createConsistentAssetBackup(pool, { ...options(), databaseSnapshot: { async write() {
      const client = exporter(); handlers = client.listeners('error');
      client.emit('error', Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT' }));
      return dump;
    } } }), failed);
    assert.equal(handlers.length, 1); assert.equal(released, true);
    for (const handler of handlers) assert(!exporter().listeners('error').includes(handler));
    assert.equal((await pool.query('SELECT 1 AS usable')).rows[0].usable, 1);
  } finally { pool.removeListener('release', onRelease); }
});

test('Target mismatch retains its existing code and removes the exporter listener before release', async () => {
  const exporter = observeExporter();
  await assert.rejects(createConsistentAssetBackup(pool, { ...options(), target: { ...options().target, database: 'fp_wrong' },
    databaseSnapshot: { async write() { assert.fail('Mismatched target must not reach the dump.'); } } }),
  error => error instanceof ConsistentBackupError && error.code === 'backup_target_mismatch');
  // Only the pool's idle-client listener remains; no coordinator listener leaks into reuse.
  assert.equal(exporter().listenerCount('error'), 1);
  assert.equal((await pool.query('SELECT 1 AS usable')).rows[0].usable, 1);
});
