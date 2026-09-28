import { test,before,after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createPool,LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal,DEMO_USERS,DEMO_PASSWORD } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';

const origin='http://127.0.0.1:4310',databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_recovery_${process.pid}_${Date.now()}`,admin=createPool(databaseUrl);
const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`});
const delivered:{to:string;url:string}[]=[];
const app=createApp(pool,origin,'local',{passwordEmailSender:async(to,url)=>{delivered.push({to,url});}});
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);await seedLocal(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
async function post(path:string,body:unknown){const response=await app.request(`${origin}/api/v1${path}`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json() as any,cookie:response.headers.get('set-cookie')};}

test('password reset link is private, one-use, expiring, and revokes old sessions',async()=>{
  const email=DEMO_USERS[0].email;
  const initial=await post('/auth/login',{email,password:DEMO_PASSWORD});assert.equal(initial.status,200);
  const unknown=await post('/auth/reset/request',{email:'nobody@example.test'});assert.equal(unknown.status,200);assert.equal(delivered.length,0);
  const requested=await post('/auth/reset/request',{email});assert.equal(requested.status,200);assert.deepEqual(requested.body,unknown.body);
  assert.equal(delivered.length,1);assert.equal(delivered[0].to,email);
  const token=/^http:\/\/127\.0\.0\.1:4310\/#reset-password\/([A-Za-z0-9_-]{43})$/.exec(delivered[0].url)?.[1];assert.ok(token);
  assert.equal((await pool.query('SELECT token_hash FROM password_reset_tokens')).rows[0].token_hash.length,64);
  assert.equal(JSON.stringify((await pool.query('SELECT * FROM password_reset_tokens')).rows).includes(token),false);
  const newPassword='new-member-password-2026';
  assert.equal((await post('/auth/reset/confirm',{token,password:newPassword})).status,200);
  assert.equal((await post('/auth/reset/confirm',{token,password:newPassword})).status,422);
  assert.equal((await post('/auth/login',{email,password:DEMO_PASSWORD})).status,401);
  assert.equal((await post('/auth/login',{email,password:newPassword})).status,200);
  const old=await app.request(`${origin}/api/v1/session`,{headers:{Cookie:initial.cookie!.split(';')[0]}});assert.equal(old.status,401);
  assert.ok((await pool.query('SELECT email_verified_at FROM users WHERE email=$1',[email])).rows[0].email_verified_at);
  await post('/auth/reset/request',{email});const expired=/\/([A-Za-z0-9_-]{43})$/.exec(delivered.at(-1)!.url)![1];
  await pool.query("UPDATE password_reset_tokens SET created_at=now()-interval '40 minutes',expires_at=now()-interval '1 second' WHERE token_hash=(SELECT token_hash FROM password_reset_tokens ORDER BY created_at DESC LIMIT 1)");
  assert.equal((await post('/auth/reset/confirm',{token:expired,password:'another-password-2026'})).status,422);
});
