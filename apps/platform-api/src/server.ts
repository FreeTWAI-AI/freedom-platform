import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createPool } from '../../../packages/db/index.js';
import { createApp } from './app.js';
import { assertOriginAllowed, resolveFreedomEnv } from './env.js';

if (process.env.NODE_ENV === 'production') {
  throw new Error('This milestone does not enable production authentication or deployment. Use FREEDOM_ENV=staging for Access-backed preview.');
}

const freedomEnv = resolveFreedomEnv();
const port = Number(process.env.PORT ?? 4310);
const origin = process.env.APP_ORIGIN ?? `http://127.0.0.1:${port}`;
assertOriginAllowed(freedomEnv, origin);

const pool = createPool();
await pool.query('SELECT 1');
const app = createApp(pool, origin);
app.use('/*', serveStatic({ root: './apps/portal-web/dist' }));
app.get('*', serveStatic({ path: './apps/portal-web/dist/index.html' }));

const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port });
console.log(`Freedom ${freedomEnv} workspace: ${origin} (demo; no payment execution)`);

async function stop() {
  server.close();
  await pool.end();
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
