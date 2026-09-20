import { readFile,readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve,dirname } from 'node:path';
import type { Pool } from 'pg';
import { createPool,transaction,digest } from '../packages/db/index.js';
import { seedLocal } from '../packages/testing/seed.js';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function migrate(pool:Pool) {
  await transaction(pool,async q=>{
    await q.query('SELECT pg_advisory_xact_lock(2026092000)');
    await q.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
    for(const name of (await readdir(resolve(ROOT,'migrations'))).filter(n=>n.endsWith('.sql')).sort()) {
      const sql=await readFile(resolve(ROOT,'migrations',name),'utf8');const hash=digest(sql);
      const prior=(await q.query('SELECT sha256 FROM schema_migrations WHERE name=$1',[name])).rows[0];
      if(prior) { if(prior.sha256!==hash)throw new Error(`Applied migration changed: ${name}`);continue; }
      await q.query(sql);await q.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)',[name,hash]);
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
