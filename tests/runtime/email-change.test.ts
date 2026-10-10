import { test,before,after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { z } from 'zod';
import { createPool } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal,DEMO_USERS,DEMO_PASSWORD } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';

const origin='http://127.0.0.1:4310',databaseUrl=process.env.TEST_DATABASE_URL;
if(!databaseUrl||!new URL(databaseUrl).pathname.startsWith('/fp_'))throw new Error('An owned fp_ test database is required');
const schema=`fp_email_change_${process.pid}_${Date.now()}`,admin=createPool(databaseUrl);
const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`});
const delivered:{to:string;subject:string;body:string}[]=[];
let mailFails=false;
let deliveryBarrier:(()=>Promise<void>)|undefined;
const app=createApp(pool,origin,'local',{eventEmailSender:async(to,subject,body)=>{if(mailFails)throw new Error('unavailable');delivered.push({to,subject,body});await deliveryBarrier?.();}});
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);await seedLocal(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
async function post(path:string,body:unknown,session?:{cookie:string;csrf:string}){
  const response=await app.request(`${origin}/api/v1${path}`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{})},body:JSON.stringify(body)});
  return {status:response.status,body:z.object({csrf_token:z.string().optional()}).passthrough().parse(await response.json()),cookie:response.headers.get('set-cookie')};
}
async function signIn(email:string){const result=await post('/auth/login',{email,password:DEMO_PASSWORD});assert.equal(result.status,200);assert.ok(result.body.csrf_token);return {cookie:result.cookie!.split(';')[0],csrf:result.body.csrf_token};}
function latestToken(){const match=/#change-email\/([A-Za-z0-9_-]{43})/.exec(delivered.at(-1)!.body);assert.ok(match);return match[1];}
async function emailOf(email:string){
  const user=(await pool.query('SELECT email FROM users WHERE email=$1',[email])).rows[0];
  return user?.email;
}

test('password authorization, duplicate email, hash-only proof, switching and session revocation',async()=>{
  const old=DEMO_USERS[0].email,session=await signIn(old),other=await signIn(old);
  const next='changed-member@example.test';
  assert.equal((await post('/me/account/email-change/request',{email:next,password:DEMO_PASSWORD})).status,401);
  assert.equal((await post('/me/account/email-change/request',{email:next,password:DEMO_PASSWORD},{...session,csrf:'invalid'})).status,403);
  assert.equal((await post('/me/account/email-change/request',{email:next,password:'incorrect'},session)).status,401);
  assert.equal((await post('/me/account/email-change/request',{email:DEMO_USERS[1].email,password:DEMO_PASSWORD},session)).status,409);
  assert.equal((await post('/me/account/email-change/request',{email:next.toUpperCase(),password:DEMO_PASSWORD},session)).status,200);
  assert.equal(await emailOf(old),old);assert.equal(delivered.at(-1)!.to,next);
  const token=latestToken(),rows=(await pool.query('SELECT * FROM login_email_change_tokens')).rows;
  assert.equal(rows[0].token_hash.length,64);assert.equal(JSON.stringify(rows).includes(token),false);
  assert.equal((await post('/auth/email-change/confirm',{token})).status,200);
  assert.equal(delivered.at(-1)!.to,old);assert.ok(delivered.at(-1)!.body.includes(next));
  assert.equal((await post('/auth/email-change/confirm',{token})).status,422);
  assert.equal((await app.request(`${origin}/api/v1/session`,{headers:{Cookie:other.cookie}})).status,401);
  const retained=await app.request(`${origin}/api/v1/session`,{headers:{Cookie:session.cookie}});assert.equal(retained.status,200);assert.equal(z.object({user:z.object({email:z.string()})}).parse(await retained.json()).user.email,next);
  assert.equal((await post('/auth/login',{email:old,password:DEMO_PASSWORD})).status,401);
  assert.equal((await post('/auth/login',{email:next,password:DEMO_PASSWORD})).status,200);
  assert.ok((await pool.query('SELECT email_verified_at FROM users WHERE email=$1',[next])).rows[0].email_verified_at);
});
test('expired and competing duplicate email proofs cannot switch; mail failures preserve retry',async()=>{
  const old=DEMO_USERS[2].email,session=await signIn(old),next='expires@example.test';
  assert.equal((await post('/me/account/email-change/request',{email:next,password:DEMO_PASSWORD},session)).status,200);
  const expired=latestToken();
  await pool.query("UPDATE login_email_change_tokens SET created_at=now()-interval '40 minutes',expires_at=now()-interval '1 second' WHERE user_id=(SELECT user_id FROM users WHERE email=$1)",[old]);
  assert.equal((await post('/auth/email-change/confirm',{token:expired})).status,422);assert.equal(await emailOf(old),old);
  assert.equal((await post('/me/account/email-change/request',{email:next,password:DEMO_PASSWORD},session)).status,200);
  const duplicate=latestToken();
  await pool.query('UPDATE users SET email=$1 WHERE email=$2',[next,DEMO_USERS[1].email]);
  assert.equal((await post('/auth/email-change/confirm',{token:duplicate})).status,409);assert.equal(await emailOf(old),old);
  assert.equal((await post('/me/account/email-change/request',{email:'retry@example.test',password:DEMO_PASSWORD},session)).status,200);
  const token=latestToken();assert.equal((await post('/auth/email-change/confirm',{token:duplicate})).status,422);
  mailFails=true;assert.equal((await post('/auth/email-change/confirm',{token})).status,503);assert.equal(await emailOf(old),old);
  mailFails=false;assert.equal((await post('/auth/email-change/confirm',{token})).status,200);
});

test('expiry during old-address delivery rolls back without mailing a false success claim',async()=>{
  const old=(await pool.query('SELECT email FROM users WHERE user_id=$1',[DEMO_USERS[1].user_id])).rows[0].email;
  const session=await signIn(old),next='delayed-confirm@example.test';
  assert.equal((await post('/me/account/email-change/request',{email:next,password:DEMO_PASSWORD},session)).status,200);
  const token=latestToken();
  await pool.query("UPDATE login_email_change_tokens SET expires_at=clock_timestamp()+interval '2 seconds' WHERE user_id=$1",[DEMO_USERS[1].user_id]);
  const before=delivered.length;
  deliveryBarrier=async()=>{await pool.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM expires_at-clock_timestamp()))+0.05) FROM login_email_change_tokens WHERE user_id=$1',[DEMO_USERS[1].user_id]);};
  try{
    assert.equal((await post('/auth/email-change/confirm',{token})).status,422);
    assert.equal(delivered.length,before+1,'the provider accepted a notice before expiry');
    assert.equal(await emailOf(old),old);
    assert.equal((await pool.query('SELECT consumed_at FROM login_email_change_tokens WHERE user_id=$1',[DEMO_USERS[1].user_id])).rows[0].consumed_at,null);
    assert.doesNotMatch(delivered.at(-1)!.subject+delivered.at(-1)!.body,/已變更|已完成/);
    assert.match(delivered.at(-1)!.body,/嘗試/);
  }finally{deliveryBarrier=undefined;}
});

test('a request waiting to replace a proof cannot issue mail after its session expires',async()=>{
  const userId=DEMO_USERS[1].user_id,old=(await pool.query('SELECT email FROM users WHERE user_id=$1',[userId])).rows[0].email;
  const session=await signIn(old);
  assert.equal((await post('/me/account/email-change/request',{email:'blocked-proof@example.test',password:DEMO_PASSWORD},session)).status,200);
  const before=delivered.length,blocker=await pool.connect();
  await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE token_hash=(SELECT requesting_session_hash FROM login_email_change_tokens WHERE user_id=$1)",[userId]);
  await blocker.query('BEGIN');
  await blocker.query('SELECT token_hash FROM login_email_change_tokens WHERE user_id=$1 FOR UPDATE',[userId]);
  let pending:ReturnType<typeof post>|undefined;
  try{
    pending=post('/me/account/email-change/request',{email:'must-not-send@example.test',password:DEMO_PASSWORD},session);
    for(let i=0;i<100;i++){
      const waiting=await admin.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'DELETE FROM login_email_change_tokens%'");
      if(waiting.rowCount)break;
      assert.ok(i<99,'request must be blocked at proof replacement');
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    await pool.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM expires_at-clock_timestamp()))+0.05) FROM sessions WHERE token_hash=(SELECT requesting_session_hash FROM login_email_change_tokens WHERE user_id=$1)',[userId]);
    await blocker.query('COMMIT');
    assert.equal((await pending).status,401);
    assert.equal(delivered.length,before);
    assert.equal((await pool.query('SELECT new_email FROM login_email_change_tokens WHERE user_id=$1',[userId])).rows[0].new_email,'blocked-proof@example.test');
  }finally{await blocker.query('ROLLBACK');blocker.release();await pending;}
});
