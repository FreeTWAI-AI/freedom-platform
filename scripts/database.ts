import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve,dirname } from 'node:path';
import type { Pool } from 'pg';
import { createPool,transaction } from '../packages/db/index.js';
import { readMigrationSources } from '../packages/db/migration-files.mjs';
import { legacyMigrationProfile,resolveMigrationPlan } from '../packages/db/migration-plan.mjs';
import { seedLocal } from '../packages/testing/seed.js';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function migrate(pool:Pool) {
  const sources=readMigrationSources(resolve(ROOT,'migrations'));
  const manifest=JSON.parse(await readFile(resolve(ROOT,'deploy/cloudflare/environments.json'),'utf8'));
  const profile=legacyMigrationProfile(manifest.database_defaults.migrations);
  // Validate the entire source before beginning any SQL; v2 remains closed
  // until the independent operator/release-floor path has been upgraded.
  resolveMigrationPlan(sources,profile);
  await transaction(pool,async q=>{
    await q.query('SELECT pg_advisory_xact_lock(2026092000)');
    await q.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
    const applied=(await q.query('SELECT name,sha256 FROM schema_migrations ORDER BY name')).rows;
    const plan=resolveMigrationPlan(sources,profile,applied);
    const hashes=new Map(plan.ledger.map(row=>[row.name,row.sha256]));
    for(const name of plan.pending) {
      await q.query(plan.sql[name]);await q.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)',[name,hashes.get(name)]);
    }
  });
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.env.NODE_ENV==='production') throw new Error('Local migration/seed runner cannot target production.');
  const pool=createPool();
  try {
    if(process.argv[2]==='migrate') {await migrate(pool);console.log('Migrations applied.');}
    else if(process.argv[2]==='seed') {await seedLocal(pool);console.log('Local demo seeded without resetting existing work. Accounts: maker/reviewer/client@local.test; password: freedom-local-demo');}
    else throw new Error('Use migrate or seed.');
  } finally { await pool.end(); }
}
