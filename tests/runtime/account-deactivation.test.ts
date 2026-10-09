import { test,before,after,beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { createPool } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal,DEMO_USERS,DEMO_PASSWORD } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
assert.ok(databaseUrl,'Use an explicitly disposable TEST_DATABASE_URL');
const origin='http://127.0.0.1:4310',schema=`fp_deactivation_${process.pid}_${Date.now()}`;
const admin=createPool(databaseUrl),pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`});
const app=createApp(pool,origin);
type Session={cookie:string;csrf:string};
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE');await seedLocal(pool);});
async function request(path:string,session?:Session,body?:unknown,extra:Record<string,string>={}){
  const response=await app.request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{}),...(body===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':randomUUID(),'If-Match':'"1"'}),...extra},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:z.object({csrf_token:z.string().optional(),code:z.string().optional(),deactivated:z.boolean().optional()}).passthrough().parse(await response.json()),response};
}
async function login(email=DEMO_USERS[0].email){
  const result=await request('/auth/login',undefined,{email,password:DEMO_PASSWORD});
  assert.equal(result.status,200,JSON.stringify(result.data));
  assert.ok(result.data.csrf_token);
  return {cookie:result.response.headers.get('set-cookie')!.split(';')[0],csrf:result.data.csrf_token};
}
test('CSRF and foreign origin reject without changing account',async()=>{
  const session=await login();
  const invalidHeaders:Record<string,string>[]=[{'X-CSRF-Token':''},{Origin:'https://attacker.example'}];
  for(const extra of invalidHeaders)assert.equal((await request('/me/account/deactivate',session,{password:DEMO_PASSWORD},extra)).status,403);
  assert.equal((await request('/session',session)).status,200);
  assert.equal((await pool.query('SELECT active FROM users WHERE email=$1',[DEMO_USERS[0].email])).rows[0].active,true);
});
test('wrong password preserves sessions and writes no deactivation audit',async()=>{
  const session=await login();
  const result=await request('/me/account/deactivate',session,{password:'wrong'});
  assert.equal(result.status,422);assert.equal(result.data.code,'password_incorrect');
  assert.equal((await request('/session',session)).status,200);
  assert.equal((await pool.query("SELECT count(*) FROM transition_journal WHERE command='deactivate_account'")).rows[0].count,'0');
});
test('deactivation revokes every own session, retains authority and audit, and prevents login',async()=>{
  const first=await login(),second=await login(),other=await login(DEMO_USERS[1].email);
  await request('/me/account',first);
  const before=(await pool.query('SELECT count(*) FROM users')).rows[0].count;
  const result=await request('/me/account/deactivate',first,{password:DEMO_PASSWORD});
  assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.deactivated,true);
  for(const session of [first,second])assert.equal((await request('/session',session)).status,401);
  assert.equal((await request('/session',other)).status,200);
  assert.equal((await request('/auth/login',undefined,{email:DEMO_USERS[0].email,password:DEMO_PASSWORD})).status,401);
  assert.equal((await pool.query('SELECT count(*) FROM users')).rows[0].count,before);
  const user=(await pool.query('SELECT user_id,active FROM users WHERE email=$1',[DEMO_USERS[0].email])).rows[0];assert.equal(user.active,false);
  assert.equal((await pool.query('SELECT count(*) FROM sessions WHERE user_id=$1 AND revoked_at IS NULL',[user.user_id])).rows[0].count,'0');
  const audit=(await pool.query("SELECT actor_ref,data FROM transition_journal WHERE command='deactivate_account'")).rows;
  assert.equal(audit.length,1);assert.equal(audit[0].actor_ref,user.user_id);assert.deepEqual(audit[0].data,{});
  const receipts=(await pool.query('SELECT response FROM command_receipts WHERE user_id=$1',[user.user_id])).rows;
  assert.ok(receipts.some(row=>row.response.deactivated===true));assert.ok(!JSON.stringify(receipts).includes(DEMO_PASSWORD));
  assert.equal((await request('/me/account/deactivate',first,{password:DEMO_PASSWORD})).status,401);
});
test('stale version and target override reject without revocation',async()=>{
  const session=await login();await request('/me/account',session);
  assert.equal((await request('/me/account/deactivate',session,{password:DEMO_PASSWORD},{'If-Match':'"2"'})).status,412);
  assert.equal((await request('/me/account/deactivate',session,{password:DEMO_PASSWORD,user_id:randomUUID()})).status,422);
  assert.equal((await request('/session',session)).status,200);
});
test('new member can deactivate before completing onboarding',async()=>{
  const registration=await request('/auth/register',undefined,{email:'deactivate@example.test',password:DEMO_PASSWORD});assert.equal(registration.status,201);
  assert.ok(registration.data.csrf_token);
  const session={cookie:registration.response.headers.get('set-cookie')!.split(';')[0],csrf:registration.data.csrf_token};
  assert.equal((await request('/me/account/deactivate',session,{password:DEMO_PASSWORD})).status,200);
  assert.equal((await request('/session',session)).status,401);
});
