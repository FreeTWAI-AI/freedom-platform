// Explicit operator-selected installation, separate from ordinary db:migrate.
// The operator launches this reviewed entry with a sanitized Node environment;
// expected pins must come from its host records, never candidate arguments.
import { Pool } from 'pg';
import { installedMigrationArguments, runInstalledMigrations } from '../deploy/cloudflare/migration-operator.mjs';

let pool;
try {
  const options = installedMigrationArguments(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw Object.assign(new Error('migration_connection_required'),{code:'migration_connection_required'});
  pool = new Pool({ connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:5000,statement_timeout:30000 });
  const result = await runInstalledMigrations(pool,options);
  console.log(JSON.stringify({ ...result,entrypoint:'repository-installed-cli' }));
} catch (error) {
  // No provider connection error, SQL body, URL or credentials in diagnostics.
  const code = /^migration_[a-z0-9_]+$/.test(error?.code ?? '') ? error.code : 'migration_entry_unavailable';
  console.error(JSON.stringify({ status:'failed',code,deployment_authorized:false })); process.exitCode=1;
} finally { await pool?.end(); }
