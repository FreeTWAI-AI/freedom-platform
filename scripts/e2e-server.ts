import { Pool } from 'pg';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createPool,LOCAL_DATABASE_URL } from '../packages/db/index.js';
import { createApp } from '../apps/platform-api/src/app.js';
import { migrate } from './database.js';
import { seedLocal } from '../packages/testing/seed.js';
import { collaborationGitHubFixture } from '../packages/testing/github-collaboration.js';
import { e2eSchema } from '../packages/testing/e2e-auth-isolation.js';
import { e2eOrigin, e2ePort } from '../packages/testing/e2e-origin.js';

if(process.env.NODE_ENV==='production'||(process.env.FREEDOM_ENV&&process.env.FREEDOM_ENV!=='local'))throw Error('Browser test server is local-only.');
if(process.env.FREEDOM_E2E_GITHUB_FIXTURES==='1')globalThis.fetch=async input=>collaborationGitHubFixture(input);

// Dedicated schema; browser tests never reset the user's local demo records.
const schema=e2eSchema(process.env.FREEDOM_E2E_SCHEMA);
const port=e2ePort(),origin=e2eOrigin();
const url=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const admin=createPool(url);admin.on('error',()=>{});await admin.query(`CREATE SCHEMA ${schema}`);
// application_name is this run only, so a stuck backend can be cancelled without touching anyone else's.
const pool=new Pool({connectionString:url,options:`-c search_path=${schema} -c application_name=${schema}`});
pool.on('error',()=>{});
let server:ReturnType<typeof serve>|undefined,stopping=false;
// Installed before migrate. Playwright's graceful SIGTERM must drop the schema even if startup is still running.
async function stop(code=0){
  if(stopping)return;stopping=true;
  if(server)await Promise.race([new Promise<void>(resolve=>server!.close(()=>resolve())),new Promise<void>(resolve=>setTimeout(resolve,2000))]);
  // End idle clients first. Terminating them while the pool still owns them emits an error that kills the process before DROP.
  await Promise.race([pool.end().catch(()=>{}),new Promise<void>(resolve=>setTimeout(resolve,2000))]);
  await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1 AND pid<>pg_backend_pid()',[schema]).catch(()=>{});
  try{await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}
  finally{await admin.end().catch(()=>{});process.exit(code);}
}
process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
try{await migrate(pool);await seedLocal(pool);}catch(error){console.error(error);await stop(1);}
const app=createApp(pool,origin);
app.use('/*',serveStatic({root:'./apps/portal-web/dist'}));
app.get('*',serveStatic({path:'./apps/portal-web/dist/index.html'}));
server=serve({fetch:app.fetch,hostname:'127.0.0.1',port});
