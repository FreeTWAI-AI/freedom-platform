import { Pool } from 'pg';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createPool,LOCAL_DATABASE_URL } from '../packages/db/index.js';
import { createApp } from '../apps/platform-api/src/app.js';
import { migrate } from './database.js';
import { seedLocal } from '../packages/testing/seed.js';

// Dedicated schema; browser tests never reset the user's local demo records.
const schema=`fp_e2e_${process.pid}_${Date.now()}`;
const url=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const admin=createPool(url);await admin.query(`CREATE SCHEMA ${schema}`);
const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`});
try {await migrate(pool);await seedLocal(pool);} catch(e) {await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();throw e;}
const app=createApp(pool,'http://127.0.0.1:4311');
app.use('/*',serveStatic({root:'./apps/portal-web/dist'}));
app.get('*',serveStatic({path:'./apps/portal-web/dist/index.html'}));
const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:4311});
let stopping=false;
async function stop(){if(stopping)return;stopping=true;server.close();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();process.exit(0);}
process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
