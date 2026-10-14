import { test,before,after,beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { createPool } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal,DEMO_USERS,DEMO_PASSWORD } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { tokenHash } from '../../modules/identity-membership/service.js';

const origin='http://127.0.0.1:4310',databaseUrl=process.env.TEST_DATABASE_URL;
assert.ok(databaseUrl,'TEST_DATABASE_URL must target an owned disposable database');
const schema=`fp_verification_${process.pid}_${Date.now()}`,admin=createPool(databaseUrl);
const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,application_name:schema});
const delivered:{to:string;text:string}[]=[];
let failDelivery=false;
const app=createApp(pool,origin,'local',{eventEmailSender:async(to,_subject,text)=>{if(failDelivery)throw new Error('private provider response');delivered.push({to,text});}});
let cookie='',csrf='';
const ResponseBody=z.object({csrf_token:z.string().optional(),code:z.string().optional(),email_verified:z.boolean().optional()});
before(async()=>{
  await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);await seedLocal(pool);
  const response=await post('/auth/login',{email:DEMO_USERS[0].email,password:DEMO_PASSWORD});
  assert.equal(response.status,200);cookie=response.cookie!.split(';')[0];assert.ok(response.body.csrf_token);csrf=response.body.csrf_token;
});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{delivered.length=0;failDelivery=false;await pool.query('DELETE FROM email_verification_tokens');await pool.query('DELETE FROM auth_rate_limits');await pool.query('UPDATE users SET email_verified_at=NULL,active=true WHERE email=$1',[DEMO_USERS[0].email]);});
async function post(path:string,body:unknown,authenticated=false,target=app,headers:Record<string,string>={}){
  const response=await target.request(`${origin}/api/v1${path}`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(authenticated?{Cookie:cookie,'X-CSRF-Token':csrf}:{}),...headers},body:JSON.stringify(body)});
  return {status:response.status,body:ResponseBody.parse(await response.json()),cookie:response.headers.get('set-cookie')};
}
async function requestToken(){
  assert.equal((await post('/me/account/email-verification/request',{},true)).status,200);
  const token=/#verify-email\/([A-Za-z0-9_-]{43})/.exec(delivered.at(-1)!.text)?.[1];assert.ok(token);return token;
}

test('send/resend binds hashed proof to login email and consumes all links once',async()=>{
  const first=await requestToken(),second=await requestToken();
  assert.equal(delivered[0].to,DEMO_USERS[0].email);
  const stored=await pool.query('SELECT * FROM email_verification_tokens');
  assert.equal(stored.rows[0].token_hash.length,64);assert.equal(JSON.stringify(stored.rows).includes(first),false);
  assert.equal((await post('/auth/email-verification/confirm',{token:first})).status,200);
  assert.equal((await post('/auth/email-verification/confirm',{token:first})).status,422);
  assert.equal((await post('/auth/email-verification/confirm',{token:second})).status,422);
  const account=await app.request(`${origin}/api/v1/me/account`,{headers:{Cookie:cookie}});
  assert.equal(ResponseBody.parse(await account.json()).email_verified,true);
  assert.equal((await post('/me/account/email-verification/request',{},true)).body.code,'email_already_verified');
});

test('expired, malformed, inactive and changed-address proofs cannot verify',async()=>{
  const token=await requestToken();
  await pool.query("UPDATE email_verification_tokens SET created_at=now()-interval '1 hour',expires_at=now()-interval '1 second'");
  assert.equal((await post('/auth/email-verification/confirm',{token})).status,422);
  assert.equal((await post('/auth/email-verification/confirm',{token:'bad'})).status,422);
  const inactive=await requestToken();await pool.query('UPDATE users SET active=false WHERE email=$1',[DEMO_USERS[0].email]);
  assert.equal((await post('/auth/email-verification/confirm',{token:inactive})).status,422);
  await pool.query('UPDATE users SET active=true WHERE email=$1',[DEMO_USERS[0].email]);
  const changed=await requestToken();await pool.query('UPDATE email_verification_tokens SET email=$1 WHERE token_hash=$2',['old@example.test',tokenHash(changed)]);
  assert.equal((await post('/auth/email-verification/confirm',{token:changed})).status,422);
  assert.equal((await pool.query('SELECT email_verified_at FROM users WHERE email=$1',[DEMO_USERS[0].email])).rows[0].email_verified_at,null);
});

test('persistent member budget blocks fourth send; confirmation has its own limit',async()=>{
  await requestToken();await requestToken();await requestToken();
  const blocked=await post('/me/account/email-verification/request',{},true);
  assert.equal(blocked.status,429);assert.equal(delivered.length,3);
  for(let n=0;n<30;n++)assert.equal((await post('/auth/email-verification/confirm',{token:'bad'})).status,422);
  assert.equal((await post('/auth/email-verification/confirm',{token:'bad'})).status,429);
});

test('send requires session, CSRF, origin and configured mail; failed delivery has no usable proof',async()=>{
  assert.equal((await post('/me/account/email-verification/request',{})).status,401);
  assert.equal((await post('/me/account/email-verification/request',{},true,app,{'X-CSRF-Token':'bad'})).status,403);
  assert.equal((await post('/auth/email-verification/confirm',{token:'bad'},false,app,{Origin:'https://evil.test'})).status,403);
  const unconfigured=createApp(pool,origin,'local');
  const unavailable=await post('/me/account/email-verification/request',{},true,unconfigured);
  assert.equal(unavailable.status,503);assert.equal(unavailable.body.code,'email_verification_unavailable');
  failDelivery=true;const failed=await post('/me/account/email-verification/request',{},true);
  assert.equal(failed.status,503);assert.equal(failed.body.code,'email_verification_send_failed');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM email_verification_tokens')).rows[0].n,0);
});

test('concurrent confirmations produce exactly one successful transition',async()=>{
  const token=await requestToken();
  const responses=await Promise.all([post('/auth/email-verification/confirm',{token}),post('/auth/email-verification/confirm',{token})]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,422]);
});

for(const stage of ['proof lock','competing proof consumption'])test(`proof expiry during ${stage} leaves email unverified and other links usable`,async()=>{
  const token=await requestToken(),other=await requestToken(),hash=tokenHash(token),userId=DEMO_USERS[0].user_id;
  await pool.query("UPDATE email_verification_tokens SET expires_at=clock_timestamp()+interval '2 seconds' WHERE token_hash=$1",[hash]);
  const priorUser=(await pool.query('SELECT password_hash,email_verified_at FROM users WHERE user_id=$1',[userId])).rows[0];
  const priorSessions=(await pool.query('SELECT token_hash,revoked_at FROM sessions WHERE user_id=$1 ORDER BY token_hash',[userId])).rows;
  const blocker=await pool.connect();
  let pending:Promise<unknown>|undefined;
  try{
    await blocker.query('BEGIN');
    await blocker.query('SELECT token_hash FROM email_verification_tokens WHERE token_hash=$1 FOR UPDATE',[stage==='proof lock'?hash:tokenHash(other)]);
    const confirmation=post('/auth/email-verification/confirm',{token});pending=confirmation;
    const query=stage==='proof lock'?'SELECT 1 FROM email_verification_tokens WHERE token_hash%':'UPDATE email_verification_tokens SET consumed_at%';
    let waiting=false;
    for(let n=0;n<200;n++){
      const row=await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE $2",[schema,query]);
      if(row.rowCount){waiting=true;break;}
      await delay(10);
    }
    assert.ok(waiting,'the initially valid proof must reach the real row-lock barrier');
    await pool.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM expires_at-clock_timestamp()))+0.05) FROM email_verification_tokens WHERE token_hash=$1',[hash]);
    await blocker.query('COMMIT');
    const reply=await confirmation;
    assert.equal(reply.status,422);assert.equal(reply.body.code,'email_verification_link_invalid');assert.equal(reply.cookie,null);
  }finally{
    await blocker.query('ROLLBACK');blocker.release();await pending;
  }
  assert.deepEqual((await pool.query('SELECT password_hash,email_verified_at FROM users WHERE user_id=$1',[userId])).rows[0],priorUser);
  assert.deepEqual((await pool.query('SELECT token_hash,revoked_at FROM sessions WHERE user_id=$1 ORDER BY token_hash',[userId])).rows,priorSessions);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM email_verification_tokens WHERE user_id=$1 AND consumed_at IS NULL',[userId])).rows[0].n,2);
  const account=await app.request(`${origin}/api/v1/me/account`,{headers:{Cookie:cookie}});
  assert.equal(account.status,200);assert.equal(ResponseBody.parse(await account.json()).email_verified,false);
  assert.equal((await post('/auth/email-verification/confirm',{token:other})).status,200,'another still-valid proof can verify after rollback');
  assert.ok((await pool.query('SELECT email_verified_at FROM users WHERE user_id=$1',[userId])).rows[0].email_verified_at);
});
