import { DAG_MIGRATIONS, migrationLedgerDigest, resolveMigrationPlan, MigrationPlanError, MIGRATION_LIMITS } from './migration-plan.mjs';
const LEDGER_QUERY = `SELECT name,sha256 FROM schema_migrations ORDER BY name LIMIT ${MIGRATION_LIMITS.files + 1}`;

function targetShape(target) {
  if (!target || Object.getPrototypeOf(target) !== Object.prototype || Object.keys(target).sort().join(',') !== 'database,role,schema'
    || Object.values(target).some(v => typeof v !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(v))) throw new MigrationPlanError('migration_target_invalid');
}
/** One transaction executor shared by repository and installed operator entry.
 * Profile/source admission belongs to the caller. This port grants no DDL. */
export async function runMigrationPlan(pool, { sources, profile, target }) {
  resolveMigrationPlan(sources, profile);
  if (target !== undefined) targetShape(target);
  // Keep the admitted source/profile stable across connection and lock waits.
  sources = sources.map(({name,sql}) => ({name,sql})); profile = structuredClone(profile);
  if (target !== undefined) target = {...target};
  const q = await pool.connect();
  try {
    await q.query('BEGIN');
    await q.query('SELECT pg_advisory_xact_lock(2026092000)');
    if (target !== undefined) {
      const actual = (await q.query('SELECT current_database() database,current_user role,session_user session_role,current_schema() schema')).rows[0];
      if (!actual || actual.database !== target.database || actual.role !== target.role || actual.session_role !== target.role || actual.schema !== target.schema) throw new MigrationPlanError('migration_target_mismatch');
    }
    await q.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
    const before = (await q.query(LEDGER_QUERY)).rows;
    const plan = resolveMigrationPlan(sources, profile, before), hashes = new Map(plan.ledger.map(row => [row.name, row.sha256]));
    if (profile.format === DAG_MIGRATIONS) await q.query("SELECT set_config('freedom.migration_protocol',$1,true)", [DAG_MIGRATIONS]);
    for (const name of plan.pending) {
      await q.query(plan.sql[name]);
      await q.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)', [name, hashes.get(name)]);
    }
    const after = (await q.query(LEDGER_QUERY)).rows;
    if (JSON.stringify(after) !== JSON.stringify(plan.ledger)) throw new MigrationPlanError('migration_final_ledger_mismatch');
    await q.query('COMMIT');
    return Object.freeze({ format: 'freedom.migration-run/v1', profile: profile.format, plan_digest: plan.plan_digest,
      ledger_digest: plan.ledger_digest, before_ledger_digest: migrationLedgerDigest(before), applied: plan.pending,
      observed_ledger_digest: migrationLedgerDigest(after), deployment_authorized: false });
  } catch (error) { await q.query('ROLLBACK'); throw error; }
  finally { q.release(); }
}
