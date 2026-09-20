import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createPool } from '../../../packages/db/index.js';
import { createApp } from './app.js';

if(process.env.NODE_ENV==='production') throw new Error('This local milestone does not enable production authentication or deployment.');
const port=Number(process.env.PORT??4310);
const origin=process.env.APP_ORIGIN??`http://127.0.0.1:${port}`;
if(!['127.0.0.1','localhost'].includes(new URL(origin).hostname)) throw new Error('APP_ORIGIN must be local.');
const pool=createPool();await pool.query('SELECT 1');
const app=createApp(pool,origin);
app.use('/*',serveStatic({root:'./apps/portal-web/dist'}));
app.get('*',serveStatic({path:'./apps/portal-web/dist/index.html'}));
const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port});
console.log(`Freedom local workspace: ${origin} (local demo; no payment execution)`);
async function stop(){server.close();await pool.end();}
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
