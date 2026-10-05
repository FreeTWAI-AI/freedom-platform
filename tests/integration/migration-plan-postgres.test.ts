// Explicit owned PostgreSQL evidence. No TEST_DATABASE_URL or private config.
// DAG execution below is a test-only port, not the private operator runner.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, chmod, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { migrate } from '../../scripts/database.js';
import { DAG_MIGRATIONS, LEGACY_MIGRATIONS, MIGRATION_V2_GUARD, migrationDigest, resolveMigrationPlan, type MigrationSource } from '../../packages/db/migration-plan.mjs';
import { readMigrationSources } from '../../packages/db/migration-files.mjs';

const image = 'sha256:6c538e7206ea40ff740ef27883529390a690b6ead6ba96b44c67a9f7c638e8fd';
const label = randomUUID(), password = randomBytes(32).toString('base64url');
let container = '', directory = '', socket = '', admin: Pool | undefined;
let lifecycle: { dispatch(kind: string, operation: string, invoke: () => string): string; cleanupState(empty: boolean): { cleanup_verified: boolean; status: string } } | undefined;
const containerName = 'fp-c5-migrations-' + label;
const docker = (args: string[], env: Record<string,string> = {}) => execFileSync('/usr/bin/docker', args, {
  env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8', timeout: 30000, maxBuffer: 1048576, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'fp-c5-postgres-')); socket = join(directory, 'socket');
  await mkdir(socket); await chmod(socket, 0o777);
  const { createSupervisorContainerLifecycle } = await import(new URL('../../packages/contribution-tools/behavior-supervisor.mjs', import.meta.url).href);
  lifecycle = createSupervisorContainerLifecycle();
  // Durable intent exists before Docker can commit a create with a lost ACK.
  await writeFile(join(directory, 'intent.json'), JSON.stringify({ label, name: containerName, state: 'create_pending', socket }), { mode: 0o600, flag: 'wx' });
  container = lifecycle!.dispatch('database', 'create', () => docker(['create', '--name', containerName, '--pull=never', '--network', 'none', '--read-only', '--user', 'postgres',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '512m', '--memory-swap', '512m',
    '--pids-limit', '128', '--cpus', '1', '--log-driver', 'none', '--ulimit', 'core=0:0', '--ulimit', 'nofile=256:256',
    '--label', 'freedom.migration-test=' + label, '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
    '--tmpfs', '/var/lib/postgresql:rw,nosuid,nodev,size=1m', '--mount', `type=bind,src=${socket},dst=/run/postgresql`,
    '-e', 'PGDATA=/tmp/data', '-e', 'POSTGRES_DB=fp_c5_migrations', '-e', 'POSTGRES_PASSWORD',
    '-e', 'POSTGRES_INITDB_ARGS=--auth-local=scram-sha-256 --auth-host=reject', image,
    'postgres', '-c', 'listen_addresses=', '-c', 'unix_socket_directories=/run/postgresql', '-c', 'max_locks_per_transaction=256'], { POSTGRES_PASSWORD: password }));
  assert.match(container, /^[a-f0-9]{64}$/);
  await writeFile(join(directory, 'intent.json'), JSON.stringify({ label, name: containerName, state: 'acknowledged', container, socket }), { mode: 0o600 });
  docker(['start', container]);
  const observed = JSON.parse(docker(['inspect', '--format', '{{json .}}', container]));
  assert.equal(observed.Image, image); assert.equal(observed.Config.Labels['freedom.migration-test'], label);
  assert.equal(observed.HostConfig.NetworkMode, 'none'); assert.equal(observed.HostConfig.ReadonlyRootfs, true);
  assert.equal(observed.HostConfig.Memory, 536870912); assert.equal(observed.HostConfig.PidsLimit, 128);
  admin = new Pool({ host: socket, user: 'postgres', database: 'fp_c5_migrations', password, max: 2, connectionTimeoutMillis: 1000, statement_timeout: 30000 });
  let ready = false;
  for (let n = 0; n < 100; n++) { try { await admin.query('SELECT 1'); ready = true; break; } catch { await delay(100); } }
  assert.equal(ready, true, 'owned PostgreSQL is ready');
  const target = (await admin.query('SELECT current_database() db,version() version')).rows[0];
  assert.equal(target.db, 'fp_c5_migrations'); assert.match(target.version, /^PostgreSQL 18\./);
  console.log(JSON.stringify({ evidence: 'owned-local-postgres', image, database: target.db, version: target.version.split(' on ')[0], network: 'none' }));
});
after(async () => {
  let poolClosed = true; try { await admin?.end(); } catch { poolClosed = false; }
  let empty = false;
  // Bounded reconciliation finds only this invocation's label. Even a later
  // empty scan cannot acknowledge a timed-out create; retain its socket/intent.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ids = docker(['ps', '-aq', '--no-trunc', '--filter', 'label=freedom.migration-test=' + label]).split('\n').filter(Boolean);
      for (const id of ids) {
        if (!/^[a-f0-9]{64}$/.test(id)) continue;
        const owned = JSON.parse(docker(['inspect', '--format', '{{json .}}', id]));
        if (owned.Config.Labels?.['freedom.migration-test'] === label && owned.Name === '/' + containerName && owned.Image === image) docker(['rm', '-f', id]);
      }
      empty = docker(['ps', '-aq', '--no-trunc', '--filter', 'label=freedom.migration-test=' + label]) === '';
      if (empty && lifecycle?.cleanupState(true).cleanup_verified) break;
    } catch { empty = false; }
    await delay(100);
  }
  const cleanup = lifecycle?.cleanupState(empty) ?? { cleanup_verified: empty, status: 'not_dispatched' };
  if (directory && cleanup.cleanup_verified) await rm(directory, { recursive: true, force: true });
  else if (directory) {
    await writeFile(join(directory, 'cleanup.json'), JSON.stringify({ label, name: containerName, ...cleanup }), { mode: 0o600 });
    console.log(JSON.stringify({ evidence: 'cleanup_unverified', intent_directory: directory, label, status: cleanup.status }));
  }
  assert.equal(poolClosed, true, 'test pool closed'); assert.equal(cleanup.cleanup_verified, true, 'owned create/cleanup resolved; retain intent/socket otherwise');
  console.log('owned PostgreSQL container and socket directory removed');
});
async function isolated(run: (pool: Pool) => Promise<void>) {
  const schema = 'fp_c5_' + randomBytes(8).toString('hex'); await admin!.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ host: socket, user: 'postgres', database: 'fp_c5_migrations', password, options: `-c search_path=${schema} -c statement_timeout=30000`, max: 2 });
  try { await run(pool); } finally { await pool.end(); await admin!.query(`DROP SCHEMA ${schema} CASCADE`); }
}
test('real repo runner: legacy empty replay, upgrade/no-op and corrupt restored-ledger rejection', { timeout: 120000 }, async () => isolated(async pool => {
  await migrate(pool);
  const before = (await pool.query('SELECT name,sha256,applied_at FROM schema_migrations ORDER BY name')).rows;
  assert(before.length >= 115); assert.equal(before[0].name, '001_local_core.sql');
  await migrate(pool); assert.deepEqual((await pool.query('SELECT name,sha256,applied_at FROM schema_migrations ORDER BY name')).rows, before);
  for (const mutation of [
    "INSERT INTO schema_migrations(name,sha256) VALUES('999_unknown.sql',repeat('f',64))",
    "UPDATE schema_migrations SET sha256=repeat('f',64) WHERE name='001_local_core.sql'",
    "DELETE FROM schema_migrations WHERE name='001_local_core.sql'",
  ]) {
    // Corruption belongs only to this disposable schema. Restore its exact
    // ledger after observing migrate's rejected, rolled-back transaction.
    await pool.query(mutation);
    const corrupt = (await pool.query('SELECT name,sha256,applied_at FROM schema_migrations ORDER BY name')).rows;
    await assert.rejects(migrate(pool));
    assert.deepEqual((await pool.query('SELECT name,sha256,applied_at FROM schema_migrations ORDER BY name')).rows, corrupt);
    await pool.query('DELETE FROM schema_migrations');
    for (const row of before) await pool.query('INSERT INTO schema_migrations(name,sha256,applied_at) VALUES($1,$2,$3)', [row.name, row.sha256, row.applied_at]);
  }
  await migrate(pool);
}));
test('real repo runner upgrades a pre-existing legacy prefix without reapplying its SQL', { timeout: 120000 }, async () => isolated(async pool => {
  const sources = readMigrationSources(fileURLToPath(new URL('../../migrations/', import.meta.url))), prefix = sources.slice(0, 5);
  const q = await pool.connect();
  try {
    await q.query('BEGIN');
    await q.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
    for (const e of prefix) { await q.query(e.sql); await q.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)', [e.name,migrationDigest(e.sql)]); }
    await q.query('COMMIT');
  } catch (error) { await q.query('ROLLBACK'); throw error; } finally { q.release(); }
  const before = (await pool.query('SELECT name,sha256,applied_at FROM schema_migrations ORDER BY name')).rows;
  await migrate(pool);
  const after = (await pool.query('SELECT name,sha256,applied_at FROM schema_migrations ORDER BY name')).rows;
  assert.deepEqual(after.slice(0, prefix.length), before);
  assert.deepEqual(after.map(({name,sha256}) => ({name,sha256})), sources.map(e => ({name:e.name,sha256:migrationDigest(e.sql)})));
}));

const legacy: MigrationSource[] = [{ name: '001_base.sql', sql: 'CREATE TABLE base(id integer PRIMARY KEY); INSERT INTO base VALUES(1);' }];
const A = 'v2_20261005T000000001Z_0000000000000001_alpha.sql', B = 'v2_20261005T000000002Z_0000000000000002_beta.sql', C = 'v2_20261005T000000000Z_0000000000000003_child.sql';
function fixture(name: string, deps: string[], sql: string): MigrationSource { return { name, sql: '-- freedom-migration: ' + JSON.stringify({ format: DAG_MIGRATIONS, depends_on: deps }) + '\n' + MIGRATION_V2_GUARD + sql }; }
const a = fixture(A, ['001_base.sql'], 'CREATE TABLE alpha(id integer PRIMARY KEY REFERENCES base); INSERT INTO alpha VALUES(1);');
const b = fixture(B, ['001_base.sql'], 'CREATE TABLE beta(id integer PRIMARY KEY REFERENCES base); INSERT INTO beta VALUES(1);');
const c = fixture(C, [A,B], 'CREATE TABLE child(a integer REFERENCES alpha,b integer REFERENCES beta); INSERT INTO child SELECT a.id,b.id FROM alpha a,beta b;');
const host = { format: DAG_MIGRATIONS, legacy: { format: LEGACY_MIGRATIONS, first: 1, last: 1, known_gaps: [] }, legacy_ledger: legacy.map(e => ({ name: e.name, sha256: migrationDigest(e.sql) })) };
async function applyFixture(pool: Pool, additions: MigrationSource[]) {
  const q = await pool.connect();
  try {
    await q.query('BEGIN'); await q.query('SELECT pg_advisory_xact_lock(2026092000)');
    await q.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
    const plan = resolveMigrationPlan([...legacy,...additions], host, (await q.query('SELECT name,sha256 FROM schema_migrations ORDER BY name')).rows);
    await q.query("SELECT set_config('freedom.migration_protocol',$1,true)", [DAG_MIGRATIONS]);
    for (const name of plan.pending) { await q.query(plan.sql[name]); await q.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)', [name,plan.ledger.find(e => e.name === name)!.sha256]); }
    await q.query('COMMIT'); return [...plan.pending];
  } catch (error) { await q.query('ROLLBACK'); throw error; } finally { q.release(); }
}
async function facts(pool: Pool) {
  const tables = ['base','alpha','beta','child'], data: Record<string, unknown> = {};
  for (const table of tables) data[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY 1`)).rows;
  return { data, ledger: (await pool.query('SELECT name,sha256 FROM schema_migrations ORDER BY name')).rows,
    columns: (await pool.query('SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema=current_schema() AND table_name<>\'schema_migrations\' ORDER BY table_name,ordinal_position')).rows,
    constraints: (await pool.query("SELECT c.relname,con.contype,pg_get_constraintdef(con.oid) def FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid WHERE c.relnamespace=current_schema()::regnamespace AND c.relname<>'schema_migrations' ORDER BY c.relname,con.contype,def")).rows };
}
test('real SQL: reverse independent merges and empty replay have identical facts and canonical ledger', { timeout: 30000 }, async () => {
  const observed: unknown[] = [];
  for (const first of [a,b,null]) await isolated(async pool => {
    if (first) await applyFixture(pool, [first]);
    const pending = await applyFixture(pool, [c,b,a]);
    assert.deepEqual(pending, first === a ? [B,C] : first === b ? [A,C] : ['001_base.sql',A,B,C]);
    observed.push(await facts(pool)); assert.deepEqual(await applyFixture(pool, [a,b,c]), []);
  });
  assert.deepEqual(observed[0], observed[1]); assert.deepEqual(observed[1], observed[2]);
});
test('real SQL: old all-SQL runner guard rolls back and unknown/digest/dependency ledgers refuse replay', { timeout: 30000 }, async () => isolated(async pool => {
  const q = await pool.connect();
  try { await q.query('BEGIN'); await q.query(legacy[0].sql); await assert.rejects(q.query(a.sql), /migration_runner_v2_required/); }
  finally { await q.query('ROLLBACK'); q.release(); }
  assert.equal((await pool.query("SELECT to_regclass('base') found")).rows[0].found, null);
  await applyFixture(pool, [a,b,c]); const before = await facts(pool);
  await pool.query('DELETE FROM schema_migrations WHERE name=$1', [A]);
  await assert.rejects(applyFixture(pool, [a,b,c]), { code: 'migration_applied_dependency_missing' });
  await pool.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)', [A,migrationDigest(a.sql)]);
  await assert.rejects(applyFixture(pool, [a,b,{ ...c,sql:c.sql+'\n-- changed\n' }]), { code: 'migration_applied_digest_mismatch' });
  await assert.rejects(applyFixture(pool, [a,b]), { code: 'migration_applied_unknown' });
  assert.deepEqual(await facts(pool), before);
}));
test('fixed supervisor initializes real member/work/avatar data with the shared legacy planner', { timeout: 120000 }, async () => {
  // This public schema belongs only to the owned, network-none test container.
  assert.equal((await admin!.query('SELECT current_database() db')).rows[0].db, 'fp_c5_migrations');
  const { initializeSupervisorFixture } = await import(new URL('../../packages/contribution-tools/behavior-supervisor-fixture.mjs', import.meta.url).href);
  const fixture = await initializeSupervisorFixture(admin, randomBytes(32).toString('base64url'));
  const work = (await admin!.query('SELECT owner_ref,title FROM work_items WHERE work_item_id=$1', [fixture.work_id])).rows[0];
  assert.equal(work.owner_ref, fixture.owner.id); assert.equal(typeof work.title, 'string'); assert(work.title.length > 0);
  assert.equal((await admin!.query('SELECT count(*)::int n FROM member_avatars WHERE user_id=$1', [fixture.owner.id])).rows[0].n, 1);
});
