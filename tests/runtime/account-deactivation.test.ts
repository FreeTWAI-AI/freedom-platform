import { test,before,after,beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createLocalJWKSet,exportJWK,generateKeyPair,SignJWT } from 'jose';
import { z } from 'zod';
import { createPool, digest } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal,DEMO_USERS,DEMO_PASSWORD,DEMO_COMMUNITY } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { tokenHash } from '../../modules/identity-membership/service.js';
import { createAdminAccessVerifier } from '../../modules/platform-admin/access.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
assert.ok(databaseUrl,'Use an explicitly disposable TEST_DATABASE_URL');
const origin='http://127.0.0.1:4310',schema=`fp_deactivation_${process.pid}_${Date.now()}`;
const admin=createPool(databaseUrl),pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`});
const issuer='https://deactivation-tests.cloudflareaccess.com',audience='account-deactivation-tests';
const pair=await generateKeyPair('RS256'),jwk=await exportJWK(pair.publicKey);
const verifier=createAdminAccessVerifier({issuer,audience,csrfSecret:'synthetic-deactivation-admin-csrf-secret-123456789',
  keySet:createLocalJWKSet({keys:[{...jwk,kid:'deactivation-admin',alg:'RS256'}]})});
const adminId=randomUUID(),adminEmail='deactivation-admin@example.test';
const app=createApp(pool,origin,'local',{adminVerifier:verifier,guildLaunchpadEnabled:true});
type Session={cookie:string;csrf:string};
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{
  await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits,client_pairing_requests CASCADE');await seedLocal(pool);
  await pool.query(`UPDATE tenant_authority_policies SET status='retired' WHERE status='active'`);
  await pool.query(`INSERT INTO tenant_authority_policies(revision,status,fresh_auth_ttl_seconds,transfer_ttl_seconds,recovery_approval_ttl_seconds,max_open_recovery_cases_per_tenant)
    VALUES(1,'active',600,86400,86400,1)`);
  await pool.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)',[adminId,DEMO_COMMUNITY,adminEmail,'Deactivation test admin']);
});
async function request(path:string,session?:Session,body?:unknown,extra:Record<string,string>={},version:string|null='"1"'){
  const response=await app.request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{}),...(body===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':randomUUID(),...(version?{'If-Match':version}:{})}),...extra},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:z.object({csrf_token:z.string().optional(),code:z.string().optional(),deactivated:z.boolean().optional()}).passthrough().parse(await response.json()),response};
}
async function login(email=DEMO_USERS[0].email){
  const result=await request('/auth/login',undefined,{email,password:DEMO_PASSWORD});
  assert.equal(result.status,200,JSON.stringify(result.data));
  assert.ok(result.data.csrf_token);
  return {cookie:result.response.headers.get('set-cookie')!.split(';')[0],csrf:result.data.csrf_token};
}
async function createTenant(session:Session,name:string){
  const result=await request('/tenants',session,{display_name:name,workspace_name:name+' workspace'},{},null);
  assert.equal(result.status,201,JSON.stringify(result.data));
  return z.object({tenant:z.object({tenant_id:z.uuid(),authorization_revision:z.string(),my_membership:z.object({principal_id:z.uuid()})})}).parse(result.data).tenant;
}
async function candidate(session:Session,userId:string){
  const result=await request(`/tenants/invite-candidates?user_id=${userId}`,session);
  assert.equal(result.status,200,JSON.stringify(result.data));
  return z.object({principal_id:z.uuid()}).parse(result.data).principal_id;
}
async function proposeTransfer(session:Session,tenantId:string,recipientId:string){
  const verification=await request('/me/high-risk-verifications',session,{password:DEMO_PASSWORD,purpose:'tenant.ownership.propose',tenant_id:tenantId},{},null);
  assert.equal(verification.status,201,JSON.stringify(verification.data));
  const proof=z.object({verification_id:z.uuid()}).parse(verification.data);
  const result=await request(`/tenants/${tenantId}/ownership-transfers`,session,{to_principal_id:recipientId,from_role_after:'viewer',
    expires_at:new Date(Date.now()+3600000).toISOString(),reason:'Synthetic deactivation regression',fresh_auth_verification_id:proof.verification_id},{},null);
  assert.equal(result.status,201,JSON.stringify(result.data));
  return z.object({transfer_id:z.uuid(),state:z.literal('pending'),version:z.string()}).parse(result.data);
}
async function approveSupplierConnection(session:Session){
  const started=await request('/client-connections/start',undefined,{kind:'supplier',client_name:'Deactivation regression'},{},null);
  assert.equal(started.status,201,JSON.stringify(started.data));
  const pairing=z.object({user_code:z.string(),device_secret:z.string()}).parse(started.data);
  const approved=await request(`/client-connections/${pairing.user_code}/approve`,session,{confirmed:true},{},null);
  assert.equal(approved.status,200,JSON.stringify(approved.data));
  return {...pairing,...z.object({connection_id:z.uuid()}).parse(approved.data)};
}
async function supplierConnection(session:Session){
  const pairing=await approveSupplierConnection(session);
  const result=await request('/client-connections/poll',undefined,{device_secret:pairing.device_secret},{},null);
  assert.equal(result.status,200,JSON.stringify(result.data));
  return z.object({status:z.literal('authorized'),access_token:z.string(),connection_id:z.uuid()}).parse(result.data);
}
async function clientConnection(token:string){
  const response=await app.request(origin+'/client-api/v1/connection',{headers:{Authorization:'Bearer '+token}});
  return {status:response.status,data:await response.json() as {code?:string;connection_id?:string}};
}
async function reactivate(userId:string){
  const now=Math.floor(Date.now()/1000);
  const jwt=await new SignJWT({type:'app',email:adminEmail,sub:'synthetic-deactivation-admin',iss:issuer,aud:audience,iat:now,nbf:now,exp:now+600})
    .setProtectedHeader({alg:'RS256',kid:'deactivation-admin'}).sign(pair.privateKey);
  const csrf=(await verifier(new Request(origin,{headers:{'Cf-Access-Jwt-Assertion':jwt}}))).csrfToken;
  const version=(await pool.query<{version:string}>('SELECT admin_status_version::text AS version FROM users WHERE user_id=$1',[userId])).rows[0].version;
  const response=await app.request(origin+`/admin/api/members/${userId}/status`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',
    'Cf-Access-Jwt-Assertion':jwt,'X-Admin-CSRF':csrf,'Idempotency-Key':randomUUID(),'If-Match':`"${version}"`},
    body:JSON.stringify({active:true,reason:'Synthetic account reactivation regression'})});
  const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));
  assert.equal(z.object({active:z.boolean()}).parse(body).active,true);
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
test('self-deactivation requires recovery for every solely owned tenant without deleting memberships or workspaces',async()=>{
  const session=await login();
  const tenants=[await createTenant(session,'Sole owner A'),await createTenant(session,'Sole owner B')];
  const tenantIds=tenants.map(tenant=>tenant.tenant_id);
  const memberships=(await pool.query('SELECT tenant_id,principal_id,role,status,version FROM tenant_memberships WHERE tenant_id=ANY($1::uuid[]) ORDER BY tenant_id,principal_id',[tenantIds])).rows;
  const workspaces=(await pool.query('SELECT workspace_id,tenant_id,name FROM workspaces WHERE tenant_id=ANY($1::uuid[]) ORDER BY workspace_id',[tenantIds])).rows;
  const result=await request('/me/account/deactivate',session,{password:DEMO_PASSWORD});
  assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.deactivated,true);
  for(const tenant of tenants){
    const row=(await pool.query('SELECT status,authorization_revision::text AS revision FROM tenants WHERE tenant_id=$1',[tenant.tenant_id])).rows[0];
    assert.deepEqual(row,{status:'recovery_required',revision:String(BigInt(tenant.authorization_revision)+1n)});
    const audit=(await pool.query("SELECT actor_principal_id,target_principal_id,reason_code FROM tenant_authority_audit WHERE tenant_id=$1 AND action='tenant.security.owner_disabled'",[tenant.tenant_id])).rows;
    assert.deepEqual(audit,[{actor_principal_id:tenant.my_membership.principal_id,target_principal_id:tenant.my_membership.principal_id,reason_code:'owner_account_disabled'}]);
  }
  assert.deepEqual((await pool.query('SELECT tenant_id,principal_id,role,status,version FROM tenant_memberships WHERE tenant_id=ANY($1::uuid[]) ORDER BY tenant_id,principal_id',[tenantIds])).rows,memberships);
  assert.deepEqual((await pool.query('SELECT workspace_id,tenant_id,name FROM workspaces WHERE tenant_id=ANY($1::uuid[]) ORDER BY workspace_id',[tenantIds])).rows,workspaces);
  const events=(await pool.query("SELECT payload->'data'->>'tenant_id' AS tenant_id FROM scoped_outbox WHERE event_type='freedom.tenant.recovery.required.v1'")).rows;
  assert.deepEqual(events.map(row=>row.tenant_id).sort(),[...tenantIds].sort());
  assert.equal((await request('/session',session)).status,401);
});
test('self-deactivation preserves another loginable owner and invalidates sent and received transfers only',async()=>{
  const session=await login(),other=await login(DEMO_USERS[1].email),third=await login(DEMO_USERS[2].email);
  const owned=await createTenant(session,'Two owners'),incoming=await createTenant(other,'Incoming transfer'),unrelated=await createTenant(third,'Unrelated transfer');
  const otherPrincipal=await candidate(session,DEMO_USERS[1].user_id),thirdPrincipal=await candidate(session,DEMO_USERS[2].user_id);
  // Reuse the tenant-recovery suite's synthetic second-owner setup; no public
  // command can add an owner without replacing the transferring owner's role.
  await pool.query(`INSERT INTO tenant_memberships(tenant_id,principal_id,role,status,accepted_at)
    VALUES($1,$2,'owner','active',clock_timestamp())`,[owned.tenant_id,otherPrincipal]);
  const sent=await proposeTransfer(session,owned.tenant_id,thirdPrincipal);
  const received=await proposeTransfer(other,incoming.tenant_id,owned.my_membership.principal_id);
  const untouched=await proposeTransfer(third,unrelated.tenant_id,otherPrincipal);
  const members=(await pool.query('SELECT principal_id,role,status,version FROM tenant_memberships WHERE tenant_id=$1 ORDER BY principal_id',[owned.tenant_id])).rows;
  const result=await request('/me/account/deactivate',session,{password:DEMO_PASSWORD});
  assert.equal(result.status,200,JSON.stringify(result.data));
  for(const tenant of [owned,incoming,unrelated]){
    const row=(await pool.query('SELECT status,authorization_revision::text AS revision FROM tenants WHERE tenant_id=$1',[tenant.tenant_id])).rows[0];
    assert.deepEqual(row,{status:'active',revision:tenant.authorization_revision});
  }
  assert.deepEqual((await pool.query('SELECT principal_id,role,status,version FROM tenant_memberships WHERE tenant_id=$1 ORDER BY principal_id',[owned.tenant_id])).rows,members);
  assert.equal((await request(`/tenants/${owned.tenant_id}`,other)).status,200);
  for(const transfer of [sent,received]){
    const row=(await pool.query('SELECT state,version::text AS version,decided_at IS NOT NULL AS decided FROM tenant_ownership_transfers WHERE transfer_id=$1',[transfer.transfer_id])).rows[0];
    assert.deepEqual(row,{state:'invalidated',version:String(BigInt(transfer.version)+1n),decided:true});
  }
  const remaining=(await pool.query('SELECT state,version::text AS version,decided_at IS NOT NULL AS decided FROM tenant_ownership_transfers WHERE transfer_id=$1',[untouched.transfer_id])).rows[0];
  assert.deepEqual(remaining,{state:'pending',version:untouched.version,decided:false});
  assert.equal((await pool.query("SELECT count(*) FROM scoped_outbox WHERE event_type='freedom.tenant.recovery.required.v1'")).rows[0].count,'0');
});
test('self-deactivation permanently revokes issued and approved client connections across admin reactivation',async()=>{
  const session=await login(),other=await login(DEMO_USERS[1].email);
  await pool.query('UPDATE users SET onboarding_completed_at=now() WHERE user_id=ANY($1::uuid[])',[[DEMO_USERS[0].user_id,DEMO_USERS[1].user_id]]);
  const issued=await supplierConnection(session),pending=await approveSupplierConnection(session),unrelated=await supplierConnection(other);
  assert.equal((await clientConnection(issued.access_token)).status,200);
  assert.equal((await clientConnection(unrelated.access_token)).status,200);
  const result=await request('/me/account/deactivate',session,{password:DEMO_PASSWORD});
  assert.equal(result.status,200,JSON.stringify(result.data));
  const revoked=(await pool.query('SELECT connection_id,revoked_at IS NOT NULL AS revoked,aggregate_version::text AS version FROM member_client_connections WHERE user_id=$1 ORDER BY connection_id',[DEMO_USERS[0].user_id])).rows;
  assert.deepEqual(revoked,[issued.connection_id,pending.connection_id].sort().map(connection_id=>({connection_id,revoked:true,version:'2'})));
  assert.equal((await clientConnection(issued.access_token)).status,401);
  assert.equal((await clientConnection(unrelated.access_token)).status,200);
  await reactivate(DEMO_USERS[0].user_id);
  const fresh=await login();assert.equal((await request('/session',fresh)).status,200);
  assert.equal((await request('/session',session)).status,401);
  const stale=await clientConnection(issued.access_token);
  assert.equal(stale.status,401);assert.equal(stale.data.code,'client_token_invalid');
  const notIssued=await request('/client-connections/poll',undefined,{device_secret:pending.device_secret},{},null);
  assert.equal(notIssued.status,400);assert.equal(notIssued.data.status,'invalid_grant');
  assert.deepEqual((await pool.query('SELECT connection_id,revoked_at IS NOT NULL AS revoked,aggregate_version::text AS version FROM member_client_connections WHERE user_id=$1 ORDER BY connection_id',[DEMO_USERS[0].user_id])).rows,revoked);
  const preserved=(await pool.query('SELECT revoked_at,aggregate_version::text AS version FROM member_client_connections WHERE connection_id=$1',[unrelated.connection_id])).rows[0];
  assert.deepEqual(preserved,{revoked_at:null,version:'1'});
  assert.equal((await clientConnection(unrelated.access_token)).status,200);
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


test('deactivation receipt digest binds only the credential-free operation and version',async()=>{
  const session=await login(),key=randomUUID();
  const result=await request('/me/account/deactivate',session,{password:DEMO_PASSWORD},{'Idempotency-Key':key});
  assert.equal(result.status,200);
  const receipt=(await pool.query('SELECT request_sha256 FROM command_receipts WHERE user_id=$1 AND idempotency_key=$2',[DEMO_USERS[0].user_id,key])).rows[0];
  assert.equal(receipt.request_sha256,digest({body:{},expected:'1'}));
  // Even a committed receipt cannot bypass current session authority.
  assert.equal((await request('/me/account/deactivate',session,{password:DEMO_PASSWORD},{'Idempotency-Key':key})).status,401);
});

test('expiry while waiting for the tenant ownership lock rolls back every deactivation fact',async()=>{
  const session=await login(),otherSession=await login();
  const tenant=await createTenant(session,'Expiry at ownership lock');
  await pool.query('UPDATE users SET onboarding_completed_at=now() WHERE user_id=$1',[DEMO_USERS[0].user_id]);
  const connection=await approveSupplierConnection(session);
  const hash=tokenHash(session.cookie.split('=')[1]),key=randomUUID();
  const before=(await pool.query('SELECT active FROM users WHERE user_id=$1',[DEMO_USERS[0].user_id])).rows[0];
  const blocker=await pool.connect();let pending:ReturnType<typeof request>|undefined;
  try{
    await blocker.query('BEGIN');
    const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    // This is the same actual tenant row lock used by ownership operations.
    await blocker.query('SELECT tenant_id FROM tenants WHERE tenant_id=$1 FOR UPDATE',[tenant.tenant_id]);
    await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '3 seconds' WHERE token_hash=$1",[hash]);
    pending=request('/me/account/deactivate',session,{password:DEMO_PASSWORD},{'Idempotency-Key':key});
    const deadline=Date.now()+10000;let blocked=false;
    while(Date.now()<deadline){
      blocked=(await pool.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS waiting',[pid])).rows[0].waiting;
      if(blocked)break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.equal(blocked,true,'the real HTTP command must reach the tenant row-lock wait');
    while((await pool.query('SELECT expires_at>clock_timestamp() AS live FROM sessions WHERE token_hash=$1',[hash])).rows[0].live){
      assert.ok(Date.now()<deadline,'database clock should pass the session deadline');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    await blocker.query('ROLLBACK');
    const result=await pending;
    assert.equal(result.status,401);assert.equal(result.data.code,'session_expired');
  }finally{
    await blocker.query('ROLLBACK');blocker.release();
    if(pending)await pending;
  }
  assert.deepEqual((await pool.query('SELECT active FROM users WHERE user_id=$1',[DEMO_USERS[0].user_id])).rows[0],before);
  assert.equal((await request('/session',otherSession)).status,200);
  assert.equal((await pool.query('SELECT revoked_at FROM sessions WHERE token_hash=$1',[hash])).rows[0].revoked_at,null);
  assert.deepEqual((await pool.query('SELECT revoked_at,aggregate_version::text AS version FROM member_client_connections WHERE connection_id=$1',[connection.connection_id])).rows[0],{revoked_at:null,version:'1'});
  assert.deepEqual((await pool.query('SELECT status,authorization_revision::text AS revision FROM tenants WHERE tenant_id=$1',[tenant.tenant_id])).rows[0],{status:'active',revision:tenant.authorization_revision});
  for(const [table,where,args] of [
    ['command_receipts','idempotency_key=$1',[key]],
    ['transition_journal',"aggregate_id=$1 AND command='deactivate_account'",[DEMO_USERS[0].user_id]],
    ['tenant_authority_audit',"tenant_id=$1 AND action='tenant.security.owner_disabled'",[tenant.tenant_id]],
    ['scoped_outbox',"event_type='freedom.tenant.recovery.required.v1'",[]],
  ] as const)assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,[...args])).rows[0].n,0);
});
