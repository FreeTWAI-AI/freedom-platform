// Explicit owned PostgreSQL evidence. No TEST_DATABASE_URL or private config.
// DAG execution below is a test-only port, not the private operator runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { migrate } from '../../scripts/database.js';
import { DAG_MIGRATIONS, LEGACY_MIGRATIONS, MIGRATION_V2_GUARD, migrationDigest, resolveMigrationPlan, type MigrationSource } from '../../packages/db/migration-plan.mjs';
import { readMigrationSources } from '../../packages/db/migration-files.mjs';
import { runMigrationPlan } from '../../packages/db/migration-runner.mjs';
import { admin, isolated } from './migration-postgres-fixture.js';

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
  const result = await runMigrationPlan(pool,{sources:[...legacy,...additions],profile:host}); return [...result.applied];
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
test('shared runner verifies its final observed ledger and rolls back rogue ledger SQL atomically', {timeout:30000},async()=>isolated(async pool=>{
  const rogue={...a,sql:a.sql+" INSERT INTO schema_migrations(name,sha256) VALUES('999_unknown.sql',repeat('f',64));"};
  await assert.rejects(runMigrationPlan(pool,{sources:[...legacy,rogue],profile:host}),{code:'migration_final_ledger_mismatch'});
  assert.equal((await pool.query("SELECT to_regclass('base') base,to_regclass('alpha') alpha,to_regclass('schema_migrations') ledger")).rows[0].ledger,null);
}));
