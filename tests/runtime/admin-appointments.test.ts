import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createLocalJWKSet,exportJWK,generateKeyPair,SignJWT} from 'jose';
import {createPool,LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal,DEMO_USERS,DEMO_PASSWORD,DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {createAdminAccessVerifier} from '../../modules/platform-admin/access.js';

const origin='http://127.0.0.1:4310',databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_admin_appointments_${process.pid}_${Date.now()}`,database=createPool(databaseUrl);
const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,application_name:schema,max:12});
const issuer='https://test-team.cloudflareaccess.com',audience='admin-appointment-tests',email='role-owner@example.invalid',adminId=randomUUID();
const pair=await generateKeyPair('RS256'),jwk=await exportJWK(pair.publicKey);
const verifier=createAdminAccessVerifier({issuer,audience,csrfSecret:'test-admin-appointment-csrf-secret-123456789',keySet:createLocalJWKSet({keys:[{...jwk,kid:'appointments-test',alg:'RS256'}]})});
let app=createApp(pool,origin,'local',{adminVerifier:verifier});
type Identity={jwt:string;csrf:string};
let owner:Identity;
const grant={reason:'已確認由這位會員管理社群。',confirmed:true};
const revoke={active:false,reason:'已完成管理交接，撤銷管理權限。',confirmed:true};
const activate={active:true,reason:'已確認恢復這位會員的管理權限。',confirmed:true};
before(async()=>{await database.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await database.query(`DROP SCHEMA ${schema} CASCADE`);await database.end();});
beforeEach(async()=>{
  await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE');await seedLocal(pool);
  await pool.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)',[adminId,DEMO_COMMUNITY,email,'Role Owner']);
  app=createApp(pool,origin,'local',{adminVerifier:verifier});owner=await identity(email);
});
async function identity(claimedEmail:string,aud=audience):Promise<Identity>{
  const now=Math.floor(Date.now()/1000);
  const jwt=await new SignJWT({type:'app',email:claimedEmail,sub:`verified-${claimedEmail}`,iss:issuer,aud,iat:now,nbf:now,exp:now+600}).setProtectedHeader({alg:'RS256',kid:'appointments-test'}).sign(pair.privateKey);
  const csrf=aud===audience?(await verifier(new Request(origin,{headers:{'Cf-Access-Jwt-Assertion':jwt}}))).csrfToken:'invalid-audience';
  return {jwt,csrf};
}
async function request(path:string,body?:unknown,version?:number,key:string=randomUUID(),actor=owner,headers:Record<string,string>={}){
  const h:Record<string,string>={Origin:origin,'Cf-Access-Jwt-Assertion':actor.jwt,'X-Admin-CSRF':actor.csrf,...headers};
  if(body!==undefined){h['Content-Type']??='application/json';h['Idempotency-Key']=key;if(version!==undefined)h['If-Match']=`"${version}"`;}
  const response=await app.request(origin+'/admin/api'+path,{method:body===undefined?'GET':'POST',headers:h,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json() as any,response};
}
const appointment=(index=0)=>`/members/${DEMO_USERS[index].user_id}/admin`;
async function appoint(index=0){const result=await request(appointment(index),grant,1);assert.equal(result.status,200,JSON.stringify(result.data));return result.data;}
async function outsider(){
  const community=randomUUID(),user=randomUUID(),admin=randomUUID();
  await pool.query('INSERT INTO communities VALUES($1,$2)',[community,'Other community']);
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    SELECT $1,$2,'outside-role@example.invalid','Outside member',password_hash,$3 FROM users LIMIT 1`,[user,community,randomUUID()]);
  await pool.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)',[admin,community,'outside-role@example.invalid','Outside admin']);
  return {community,user,admin};
}

test('appointment uses the persisted member identity, audits once, and exposes truthful synchronization state',async()=>{
  const key=randomUUID(),[first,replay]=await Promise.all([request(appointment(),grant,1,key),request(appointment(),grant,1,key)]);
  assert.equal(first.status,200,JSON.stringify(first.data));assert.deepEqual(replay.data,first.data);
  assert.equal(first.response.headers.get('etag'),'"1"');
  const result=first.data;
  assert.equal(result.user_id,DEMO_USERS[0].user_id);assert.equal(result.email,DEMO_USERS[0].email);
  assert.equal(result.role,'super_admin');assert.equal(result.aggregate_version,1);assert.equal(result.access_synced_version,null);assert.equal(result.access_synced_at,null);assert.equal(result.access_state,'pending');
  const listed=(await request('/admins')).data.items.find((value:any)=>value.admin_id===result.admin_id);
  assert.equal(listed.user_id,DEMO_USERS[0].user_id);assert.equal(listed.aggregate_version,1);assert.equal(listed.access_state,'pending');
  const member=(await request('/members')).data.items.find((value:any)=>value.user_id===DEMO_USERS[0].user_id);
  assert.deepEqual(member.platform_admin,{admin_id:result.admin_id,active:true,aggregate_version:1,access_state:'pending'});
  assert.equal(member.aggregate_version,1); // Role changes do not overwrite member account status.
  const audit=(await request('/audit')).data.items;assert.equal(audit.length,1);assert.equal(audit[0].action,'appoint_platform_admin');assert.equal(audit[0].target_ref,result.admin_id);assert.equal(audit[0].after_state.email,DEMO_USERS[0].email);
  assert.equal((await request(appointment(),{...grant,reason:'重用識別碼但不同理由。'},1,key)).data.code,'idempotency_conflict');
  await pool.query('UPDATE platform_admins SET access_synced_version=aggregate_version,access_synced_at=now() WHERE admin_id=$1',[result.admin_id]);
  const ready=(await request('/admins')).data.items.find((value:any)=>value.admin_id===result.admin_id);
  assert.equal(ready.access_state,'ready');assert.equal(ready.access_synced_version,1);assert.ok(ready.access_synced_at);
  assert.equal((await request('/members')).data.items.find((value:any)=>value.user_id===DEMO_USERS[0].user_id).platform_admin.access_state,'ready');
});

test('role writes require confirmation, versions, reason, CSRF, valid signed Access and an already authorized admin',async()=>{
  const path=appointment();
  for(const body of [{reason:grant.reason},{...grant,confirmed:false},{...grant,reason:'x'},{...grant,email:'override@example.invalid'},{...grant,role:'super_admin'}])assert.equal((await request(path,body,1)).status,422);
  assert.equal((await request(path,grant)).status,428);
  assert.equal((await request(path,grant,2)).status,412);
  assert.equal((await request(path,grant,1,'short')).status,400);
  assert.equal((await request(path,grant,1,randomUUID(),owner,{'X-Admin-CSRF':'wrong'})).data.code,'admin_csrf_rejected');
  assert.equal((await request(path,grant,1,randomUUID(),owner,{Origin:'https://evil.invalid'})).data.code,'origin_rejected');
  assert.equal((await request(path,grant,1,randomUUID(),owner,{'Content-Type':'text/plain'})).status,415);
  assert.equal((await request(path,grant,1,randomUUID(),await identity(email,'other-audience'))).status,401);
  assert.equal((await request(path,grant,1,randomUUID(),await identity(DEMO_USERS[0].email))).status,403);
  const login=await app.request(origin+'/api/v1/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({email:DEMO_USERS[0].email,password:DEMO_PASSWORD})});
  assert.equal(login.status,200);const cookie=login.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await request(path,grant,1,randomUUID(),owner,{'Cf-Access-Jwt-Assertion':'',Cookie:cookie,'Cf-Access-Authenticated-User-Email':email})).status,401);
  assert.equal((await pool.query('SELECT count(*) FROM platform_admins')).rows[0].count,'1');
  assert.equal((await request('/audit')).data.items.length,0);
});

test('cross-community member appointments and admin status changes are unavailable without leaking listings',async()=>{
  const other=await outsider();
  assert.equal((await request(`/members/${other.user}/admin`,grant,1)).status,404);
  assert.equal((await request(`/admins/${other.admin}/status`,revoke,1)).status,404);
  assert.equal((await request(`/admins/${randomUUID()}/status`,revoke,1)).status,404);
  assert.equal((await request('/admins')).data.items.length,1);
  assert.ok((await request('/members')).data.items.every((value:any)=>value.user_id!==other.user&&value.platform_admin===null));
  assert.equal((await request('/audit')).data.items.length,0);
});

test('existing admin records require explicit status changes, and activation requires an active matching member',async()=>{
  await pool.query('UPDATE users SET active=false WHERE user_id=$1',[DEMO_USERS[1].user_id]);
  assert.equal((await request(appointment(1),grant,1)).data.code,'active_member_required');
  const result=await appoint(),path=`/admins/${result.admin_id}/status`;
  assert.equal((await request(appointment(),grant,1)).data.code,'admin_already_exists');
  assert.equal((await request(path,activate,1)).data.code,'admin_status_unchanged');
  assert.equal((await request(path,revoke)).status,428);
  assert.equal((await request(path,{...revoke,confirmed:false},1)).status,422);
  const changed=await request(path,revoke,1);assert.equal(changed.status,200);assert.equal(changed.data.aggregate_version,2);
  assert.equal((await request(appointment(),grant,1)).data.code,'admin_already_exists');
  assert.equal((await request(path,activate,1)).status,412);
  await pool.query('UPDATE users SET active=false WHERE user_id=$1',[DEMO_USERS[0].user_id]);
  assert.equal((await request(path,activate,2)).data.code,'active_member_required');
  await pool.query('UPDATE users SET active=true WHERE user_id=$1',[DEMO_USERS[0].user_id]);
  const enabled=await request(path,activate,2);assert.equal(enabled.status,200);assert.equal(enabled.data.aggregate_version,3);assert.equal(enabled.data.access_state,'pending');
  const legacy=randomUUID();await pool.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name,active) VALUES($1,$2,$3,$4,false)',[legacy,DEMO_COMMUNITY,'legacy-without-member@example.invalid','Legacy admin']);
  assert.equal((await request(`/admins/${legacy}/status`,activate,1)).data.code,'active_member_required');
});

test('revocation is immediate for old Access tokens and replayed commands, while synchronization remains pending',async()=>{
  const result=await appoint(),actor=await identity(DEMO_USERS[0].email),path=`/admins/${result.admin_id}/status`;
  const secondKey=randomUUID(),grantedBySecond=await request(appointment(1),grant,1,secondKey,actor);assert.equal(grantedBySecond.status,200);
  assert.equal((await request('/bootstrap',undefined,undefined,randomUUID(),actor)).status,200);
  await pool.query('UPDATE platform_admins SET access_synced_version=aggregate_version,access_synced_at=now() WHERE admin_id=$1',[result.admin_id]);
  const key=randomUUID(),revoked=await request(path,revoke,1,key);assert.equal(revoked.status,200);
  assert.equal(revoked.data.access_state,'pending_removal');assert.equal(revoked.data.aggregate_version,2);assert.equal(revoked.data.access_synced_version,1);
  assert.deepEqual((await request(path,revoke,1,key)).data,revoked.data);
  assert.equal((await request('/bootstrap',undefined,undefined,randomUUID(),actor)).status,403);
  assert.equal((await request(appointment(1),grant,1,secondKey,actor)).status,403);
  assert.equal((await request(appointment(2),grant,1,randomUUID(),actor)).status,403);
  assert.equal((await request(path,activate,2,randomUUID(),actor)).status,403);
  await pool.query('UPDATE platform_admins SET access_synced_version=aggregate_version,access_synced_at=now() WHERE admin_id=$1',[result.admin_id]);
  assert.equal((await request('/admins')).data.items.find((value:any)=>value.admin_id===result.admin_id).access_state,'revoked');
  assert.equal((await request('/audit')).data.items.filter((value:any)=>value.action==='platform_admin_status').length,1);
});

test('self revocation is rejected and simultaneous mutual revocation leaves one active admin without deadlock',{timeout:10000},async()=>{
  assert.equal((await request(`/admins/${adminId}/status`,revoke,1)).data.code,'self_admin_revocation');
  const second=await appoint(),actor=await identity(DEMO_USERS[0].email);
  assert.equal((await request(`/admins/${adminId.toUpperCase()}/status`,revoke,1)).data.code,'self_admin_revocation');
  const attempts=await Promise.all([request(`/admins/${second.admin_id}/status`,revoke,1),request(`/admins/${adminId}/status`,revoke,1,randomUUID(),actor)]);
  assert.deepEqual(attempts.map(value=>value.status).sort(),[200,403]);
  assert.equal((await pool.query('SELECT count(*) FROM platform_admins WHERE community_id=$1 AND active',[DEMO_COMMUNITY])).rows[0].count,'1');
  assert.equal((await pool.query("SELECT count(*) FROM platform_admin_audit WHERE action='platform_admin_status'")).rows[0].count,'1');
});

test('a request queued behind the Access worker lock acquires no acting-admin row lock and rechecks revocation',{timeout:10000},async()=>{
  await appoint();
  const blocker=await pool.connect();let pending:ReturnType<typeof request>|undefined;
  try {
    await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`admin-roles/${DEMO_COMMUNITY}`]);
    pending=request(appointment(1),grant,1);
    let waiting=false;
    for(let index=0;index<100&&!waiting;index++){
      waiting=(await database.query("SELECT 1 FROM pg_locks l JOIN pg_stat_activity a USING(pid) WHERE a.application_name=$1 AND l.locktype='advisory' AND NOT l.granted",[schema])).rowCount!>0;
      if(!waiting)await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(waiting,true,'appointment must wait for the shared role lock');
    await blocker.query("SET LOCAL lock_timeout='500ms'");
    await blocker.query('UPDATE platform_admins SET active=false,aggregate_version=aggregate_version+1 WHERE admin_id=$1',[adminId]);
    await blocker.query('COMMIT');
    assert.equal((await pending).status,403);
    assert.equal((await pool.query('SELECT count(*) FROM platform_admins WHERE email=$1',[DEMO_USERS[1].email])).rows[0].count,'0');
  }finally{await blocker.query('ROLLBACK');blocker.release();if(pending)await pending;}
});
