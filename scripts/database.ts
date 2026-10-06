import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve,dirname } from 'node:path';
import type { Pool } from 'pg';
import { createPool } from '../packages/db/index.js';
import { readMigrationSources } from '../packages/db/migration-files.mjs';
import { legacyMigrationProfile } from '../packages/db/migration-plan.mjs';
import { runMigrationPlan } from '../packages/db/migration-runner.mjs';
import { seedLocal } from '../packages/testing/seed.js';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function migrate(pool:Pool) {
  const sources=readMigrationSources(resolve(ROOT,'migrations'));
  const manifest=JSON.parse(await readFile(resolve(ROOT,'deploy/cloudflare/environments.json'),'utf8'));
  const profile=legacyMigrationProfile(manifest.database_defaults.migrations);
  // Validate the entire source before beginning any SQL; v2 remains closed
  // until the independent operator/release-floor path has been upgraded.
  await runMigrationPlan(pool,{sources,profile});
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
