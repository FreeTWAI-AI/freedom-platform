import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createPool } from '../../../packages/db/index.js';
import { createApp } from './app.js';
import { assertOriginAllowed, resolveFreedomEnv } from './env.js';

const freedomEnv = resolveFreedomEnv();
if (process.env.NODE_ENV === 'production' && freedomEnv !== 'public') {
  throw new Error('Production NODE_ENV requires explicit FREEDOM_ENV=public.');
}
const port = Number(process.env.PORT ?? 4310);
const origin = process.env.APP_ORIGIN ?? `http://127.0.0.1:${port}`;
assertOriginAllowed(freedomEnv, origin);

const pool = createPool();
await pool.query('SELECT 1');
if(freedomEnv==='public') {
  const community=process.env.FREEDOM_REGISTRATION_COMMUNITY_ID;
  if(!community || !/^[0-9a-f-]{36}$/i.test(community))throw new Error('Public registration requires an explicit community ID.');
  const database=(await pool.query('SELECT current_database() AS name,rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0];
  if(database.rolsuper || database.name!==process.env.FREEDOM_DATABASE_NAME || ['freedom_local','freedom_staging'].includes(database.name))throw new Error('Public runtime requires a dedicated non-superuser database.');
  if((await pool.query('SELECT 1 FROM communities WHERE community_id=$1',[community])).rowCount!==1)throw new Error('Public community is not initialized.');
  if((await pool.query("SELECT 1 FROM users WHERE email LIKE '%@local.test' LIMIT 1")).rowCount)throw new Error('Public database must not contain local demo accounts.');
}
const app = createApp(pool, origin, freedomEnv);
app.use('/*', serveStatic({ root: './apps/portal-web/dist' }));
app.get('*', serveStatic({ path: './apps/portal-web/dist/index.html' }));

const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port });
console.log(`Freedom ${freedomEnv} workspace: ${origin} (no payment execution)`);

async function stop() {
  server.close();
  await pool.end();
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
