import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createPool } from '../../../packages/db/index.js';
import { createApp } from './app.js';
import { assertOriginAllowed, resolveFreedomEnv } from './env.js';
import { assertPublicDatabase } from './readiness.js';

const freedomEnv = resolveFreedomEnv();
if (process.env.NODE_ENV === 'production' && freedomEnv !== 'public') {
  throw new Error('Production NODE_ENV requires explicit FREEDOM_ENV=public.');
}
const port = Number(process.env.PORT ?? 4310);
const origin = process.env.APP_ORIGIN ?? `http://127.0.0.1:${port}`;
assertOriginAllowed(freedomEnv, origin);

const pool = createPool();
await pool.query('SELECT 1');
if(freedomEnv==='public')await assertPublicDatabase(pool,{registrationCommunityId:process.env.FREEDOM_REGISTRATION_COMMUNITY_ID,databaseName:process.env.FREEDOM_DATABASE_NAME});
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
