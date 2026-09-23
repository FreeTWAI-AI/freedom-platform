import {z} from 'zod';
import {createPool,transaction} from '../packages/db/index.js';
import {migrate} from './database.js';

// Explicit empty-community bootstrap. This script never imports or executes seedLocal.
if(process.env.FREEDOM_ENV!=='public')throw new Error('Public bootstrap requires FREEDOM_ENV=public.');
const community=z.uuid().parse(process.env.FREEDOM_REGISTRATION_COMMUNITY_ID);
const pool=createPool();
try {
  const database=(await pool.query('SELECT current_database() AS name,rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0];
  if(database.rolsuper||database.name!==process.env.FREEDOM_DATABASE_NAME||['freedom_local','freedom_staging'].includes(database.name))throw new Error('Use a dedicated non-superuser public database.');
  await migrate(pool);
  await transaction(pool,async q=>{
    await q.query('SELECT pg_advisory_xact_lock(2026092301)');
    if((await q.query('SELECT 1 FROM communities WHERE community_id<>$1 LIMIT 1',[community])).rowCount)throw new Error('Public database already has another community.');
    await q.query("INSERT INTO communities(community_id,name) VALUES($1,'自由工坊') ON CONFLICT DO NOTHING",[community]);
  });
  if((await pool.query("SELECT 1 FROM users WHERE email LIKE '%@local.test' LIMIT 1")).rowCount)throw new Error('Public database contains local demo users.');
  console.log('Public schema and community ready; no demo data seeded.');
} finally {await pool.end();}
