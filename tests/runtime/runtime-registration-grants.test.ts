import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { migrate } from '../../scripts/database.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import type { Actor } from '../../modules/identity-membership/service.js';
import { createRuntimeRegistrations } from '../../modules/agent-control/runtime-registration.js';
import { parseRuntimePublicJwk } from '../../modules/agent-control/runtime-proof.js';

const connectionString=process.env.TEST_DATABASE_URL;
if(!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname)) throw new Error('Explicit isolated fp_* TEST_DATABASE_URL required.');
const schema=`fp_runtime_acl_${process.pid}_${Date.now()}`,migrator=`${schema}_migrator`,runtime=`${schema}_app`;
const admin=new Pool({connectionString});
function roleUrl(role:string) { const url=new URL(connectionString!); url.username=role;url.password='';return url.toString(); }
// Dedicated LOGIN connections prove both session_user and current_user. There is
// no SET ROLE from a superuser and no secret or private deployment configuration.
const owner=new Pool({connectionString:roleUrl(migrator),options:`-c search_path=${schema} -c statement_timeout=10000`});
const app=new Pool({connectionString:roleUrl(runtime),options:`-c search_path=${schema} -c statement_timeout=10000`});
const api=createRuntimeRegistrations(app,{environment:'local'});
let created=false,checkQuery:string;
before(async()=>{
  await admin.query(`CREATE ROLE ${migrator} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE ROLE ${runtime} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE SCHEMA ${schema} AUTHORIZATION ${migrator}; GRANT USAGE ON SCHEMA ${schema} TO ${runtime}`);
  created=true;await migrate(owner);
  // The real public grant generator and verifier, substituting fixture identifiers
  // only. This does not claim to execute psql or private deployment helpers.
  const template=await readFile(new URL('../../deploy/cloudflare/sql/20-runtime-grants.psql',import.meta.url),'utf8');
  const prefix=template.slice(template.indexOf('BEGIN;'),template.indexOf('-- BEGIN PRIVATE POLICY GRANTS'))
    .replaceAll('SCHEMA public',`SCHEMA ${schema}`).replaceAll(':"runtime"',`"${runtime}"`);
  const grants=template.split('-- BEGIN PRIVATE POLICY GRANTS\n')[1].split('\n\\gexec')[0]
    .replaceAll(":'runtime'",`'${runtime}'`).replace("n.nspname='public'",`n.nspname='${schema}'`);
  const q=await owner.connect();
  try {await q.query(prefix);const rows=await q.query(grants);assert.equal(rows.rowCount,1);
    await q.query(Object.values(rows.rows[0])[0] as string);await q.query('COMMIT');}
  catch(error){await q.query('ROLLBACK');throw error;}finally{q.release();}
  const verify=await readFile(new URL('../../deploy/cloudflare/sql/30-verify-readonly.psql',import.meta.url),'utf8');
  checkQuery=verify.slice(verify.indexOf("SELECT has_table_privilege(:'runtime',c.oid,'SELECT')"))
    .replaceAll(":'runtime'",`'${runtime}'`).replace("n.nspname='public'",`n.nspname='${schema}'`);
});
after(async()=>{await app.end();await owner.end();try{if(created)await admin.query(`DROP SCHEMA ${schema} CASCADE; DROP ROLE ${runtime},${migrator}`);}finally{await admin.end();}});
const sqlCode=(...values:string[])=>(error:unknown)=>values.includes((error as {code?:string}).code??'');
async function fixture(enroll=true) {
  const user=randomUUID(),community=randomUUID(),session=randomUUID();
  await owner.query("INSERT INTO communities VALUES($1,'Synthetic runtime grant review')",[community]);
  const row=(await owner.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic member','not-a-login',$4) RETURNING *`,[user,community,user+'@example.invalid',randomUUID()])).rows[0];
  await owner.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')",[session,user]);
  const actor:Actor={...row,session_hash:session,csrf_token:'synthetic'};
  const context=await withMemberScope(app,{actor,scope:'personal'},async()=>{},async(_q,c)=>c);
  const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),publicJwk=parseRuntimePublicJwk(pair.publicKey.export({format:'jwk'}));
  const challenge=await api.begin(actor,{key:randomUUID(),publicJwk});
  const signed=Buffer.from('{"alg":"ES256","typ":"freedom-runtime-enrollment+jws"}').toString('base64url')+'.'+Buffer.from(challenge.payload).toString('base64url');
  const proof=signed+'.'+sign('sha256',Buffer.from(signed),{key:pair.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
  if(enroll)await api.confirm(actor,{key:randomUUID(),challengeId:challenge.challenge_id,proof});
  return {actor,context,challenge,publicJwk};
}
async function transaction(run:(q:PoolClient)=>Promise<void>) {
  const q=await app.connect();try{await q.query('BEGIN');await run(q);}finally{await q.query('ROLLBACK');q.release();}
}
async function insertRegistration(q:Pool|PoolClient,challengeId:string) {
  return q.query(`INSERT INTO ${schema}.runtime_registrations(runtime_device_id,challenge_id,owner_user_id,owner_principal_id,scope_id,environment,public_jwk,key_thumbprint,enrolled_at)
    SELECT runtime_device_id,challenge_id,owner_user_id,owner_principal_id,scope_id,environment,public_jwk,key_thumbprint,consumed_at
    FROM runtime_registration_challenges WHERE challenge_id=$1`,[challengeId]);
}

test('RUNTIME-ACL actual app and migrator LOGIN sessions retain constrained effective privileges',async()=>{
  for(const [pool,name] of [[owner,migrator],[app,runtime]] as const) {
    const row=(await pool.query(`SELECT current_user,session_user,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls
      FROM pg_roles WHERE rolname=current_user`)).rows[0];
    assert.deepEqual(row,{current_user:name,session_user:name,rolsuper:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false,rolbypassrls:false});
  }
  assert.deepEqual((await owner.query(checkQuery)).rows,[{private_policy_read:true,private_policy_lock:true,private_policy_unsafe:false}]);
  for(const table of ['runtime_registration_challenges','runtime_registrations']) {
    const row=(await app.query(`SELECT has_table_privilege(current_user,$1,'SELECT') AS read,
      has_table_privilege(current_user,$1,'INSERT') AS insert,has_table_privilege(current_user,$1,'UPDATE') AS update,
      has_table_privilege(current_user,$1,'DELETE') AS delete,
      has_table_privilege(current_user,$1,'TRUNCATE') AS truncate,has_schema_privilege(current_user,$2,'CREATE') AS ddl`,[table,schema])).rows[0];
    assert.deepEqual(row,{read:true,insert:true,update:true,delete:true,truncate:false,ddl:false});
  }
});

test('RUNTIME-ACL real role supports member+ES256 enrollment/read/revoke without model or credential authority',async()=>{
  const f=await fixture(),value=await api.read(f.actor,{runtimeDeviceId:f.challenge.runtime_device_id});
  assert.equal(value.operational_authority,false);
  const revoked=await api.revoke(f.actor,{key:randomUUID(),runtimeDeviceId:value.runtimeDeviceId,expectedVersion:'1'});
  assert.equal(revoked.operational_authority,false);assert.equal(revoked.aggregateVersion,'2');
});

test('RUNTIME-ACL app cannot disable invariants, truncate tombstones, write migration ledger or grant policy',async()=>{
  for(const sql of ['TRUNCATE runtime_registration_challenges CASCADE','TRUNCATE runtime_registrations',
    'ALTER TABLE runtime_registrations DISABLE TRIGGER preserve_runtime_registration',
    'ALTER TABLE runtime_registration_challenges DISABLE TRIGGER preserve_runtime_challenge',
    'UPDATE schema_migrations SET name=name','UPDATE private_work_persistence_policy SET persistence_allowed=true'])
    await assert.rejects(app.query(sql),sqlCode('42501'));
});

test('RUNTIME-ACL consumed challenge owner/key/time identities cannot be rewritten or deleted',async()=>{
  const f=await fixture();
  for(const assignment of ['owner_user_id=gen_random_uuid()','owner_principal_id=gen_random_uuid()','scope_id=gen_random_uuid()',
    'runtime_device_id=gen_random_uuid()','challenge_id=gen_random_uuid()',"environment='next'","nonce=repeat('A',43)",
    "key_thumbprint=repeat('A',43)","begin_key='replacement'","issued_at=issued_at-interval '1 second'",
    'consumed_at=NULL','consumed_at=clock_timestamp()'])
    await assert.rejects(app.query(`UPDATE runtime_registration_challenges SET ${assignment} WHERE challenge_id=$1`,[f.challenge.challenge_id]),sqlCode('23514'));
  await assert.rejects(app.query('DELETE FROM runtime_registration_challenges WHERE challenge_id=$1',[f.challenge.challenge_id]),sqlCode('23514'));
});

test('RUNTIME-ACL registration immutable fields, CAS and permanent revocation survive direct app DML',async()=>{
  const f=await fixture(),id=f.challenge.runtime_device_id;
  for(const assignment of ['runtime_device_id=gen_random_uuid()','challenge_id=gen_random_uuid()','owner_user_id=gen_random_uuid()',
    'owner_principal_id=gen_random_uuid()','scope_id=gen_random_uuid()',"environment='next'","public_jwk='{}'::jsonb",
    "key_thumbprint=repeat('A',43)","enrolled_at=enrolled_at-interval '1 second'",'aggregate_version=2',
    "state='revoked',revoked_at=clock_timestamp()","state='revoked',aggregate_version=3,revoked_at=clock_timestamp()"])
    await assert.rejects(app.query(`UPDATE runtime_registrations SET ${assignment} WHERE runtime_device_id=$1`,[id]),sqlCode('23514'));
  await api.revoke(f.actor,{key:randomUUID(),runtimeDeviceId:id,expectedVersion:'1'});
  for(const assignment of ["state='enrolled',aggregate_version=3,revoked_at=NULL","state='revoked',aggregate_version=3,revoked_at=clock_timestamp()"])
    await assert.rejects(app.query(`UPDATE runtime_registrations SET ${assignment} WHERE runtime_device_id=$1`,[id]),sqlCode('23514'));
  await assert.rejects(app.query('DELETE FROM runtime_registrations WHERE runtime_device_id=$1',[id]),sqlCode('23514'));
});

test('RUNTIME-ACL initial challenge composite foreign keys reject cross-owner scope/user and NULL bypass',async()=>{
  const f=await fixture(false),peer=await fixture(false);
  for(const [column,value] of [['owner_user_id',peer.actor.user_id],['owner_principal_id',peer.context.subject_principal.principal_id],
    ['scope_id',peer.context.scope.scope_id],['scope_id',null],['owner_user_id',null],['owner_principal_id',null]] as const) {
    const columns=['owner_user_id','owner_principal_id','scope_id'];
    const select=columns.map(name=>name===column?'$2':name).join(',');
    await assert.rejects(app.query(`INSERT INTO runtime_registration_challenges(challenge_id,runtime_device_id,owner_user_id,owner_principal_id,scope_id,
      environment,begin_key,public_jwk,key_thumbprint,nonce,issued_at,expires_at)
      SELECT gen_random_uuid(),gen_random_uuid(),${select},environment,gen_random_uuid()::text,public_jwk,key_thumbprint,nonce,issued_at,expires_at
      FROM runtime_registration_challenges WHERE challenge_id=$1`,[f.challenge.challenge_id,value]),sqlCode('23503','23502'));
  }
});

test('RUNTIME-ACL TEMP shadow cannot make an unconsumed real challenge authorize registration',async()=>{
  const f=await fixture(false);
  await transaction(async q=>{
    assert.equal((await q.query("SELECT has_database_privilege(current_user,current_database(),'TEMP') allowed")).rows[0].allowed,true);
    await q.query(`CREATE TEMP TABLE runtime_registration_challenges AS SELECT * FROM ${schema}.runtime_registration_challenges WHERE challenge_id=$1`,[f.challenge.challenge_id]);
    await q.query('UPDATE pg_temp.runtime_registration_challenges SET consumed_at=clock_timestamp()');
    await assert.rejects(insertRegistration(q,f.challenge.challenge_id),sqlCode('23514'));
  });
  assert.equal((await app.query('SELECT count(*)::int n FROM runtime_registrations WHERE challenge_id=$1',[f.challenge.challenge_id])).rows[0].n,0);
});

test('RUNTIME-ACL structurally consumed challenge cannot be substituted with another owner or scope',async()=>{
  // Structural SQL validation is distinct from trusted-service cryptographic admission.
  // A shared application DML role is not a hardware or cryptographic attestation.
  const f=await fixture(false),peer=await fixture(false);
  await app.query('UPDATE runtime_registration_challenges SET consumed_at=clock_timestamp() WHERE challenge_id=$1',[f.challenge.challenge_id]);
  for(const [column,value] of [['owner_user_id',peer.actor.user_id],['owner_principal_id',peer.context.subject_principal.principal_id],
    ['scope_id',peer.context.scope.scope_id],['environment','next'],['runtime_device_id',randomUUID()],['scope_id',null]] as const) {
    const columns=['runtime_device_id','challenge_id','owner_user_id','owner_principal_id','scope_id','environment','public_jwk','key_thumbprint'];
    await assert.rejects(app.query(`INSERT INTO runtime_registrations(${columns.join(',')},enrolled_at)
      SELECT ${columns.map(name=>name===column?'$2':name).join(',')},consumed_at FROM runtime_registration_challenges WHERE challenge_id=$1`,
    [f.challenge.challenge_id,value]),sqlCode('23514','23502'));
  }
  await insertRegistration(app,f.challenge.challenge_id);
  await assert.rejects(app.query('UPDATE runtime_registration_challenges SET consumed_at=clock_timestamp() WHERE challenge_id=$1',[f.challenge.challenge_id]),sqlCode('23514'));
});

test('RUNTIME-ACL generated personal scope survives valid BEFORE-trigger consumption and revocation',async()=>{
  const f=await fixture();
  const initial=(await app.query(`SELECT c.scope_kind AS challenge_scope,r.scope_kind AS registration_scope,c.consumed_at IS NOT NULL AS consumed
    FROM runtime_registration_challenges c JOIN runtime_registrations r USING(challenge_id) WHERE c.challenge_id=$1`,[f.challenge.challenge_id])).rows[0];
  assert.deepEqual(initial,{challenge_scope:'personal',registration_scope:'personal',consumed:true});
  await api.revoke(f.actor,{key:randomUUID(),runtimeDeviceId:f.challenge.runtime_device_id,expectedVersion:'1'});
  assert.equal((await app.query('SELECT scope_kind FROM runtime_registrations WHERE challenge_id=$1',[f.challenge.challenge_id])).rows[0].scope_kind,'personal');
  for(const table of ['runtime_registration_challenges','runtime_registrations'])
    await assert.rejects(app.query(`UPDATE ${table} SET scope_kind='community' WHERE challenge_id=$1`,[f.challenge.challenge_id]),sqlCode('428C9'));
});

test('RUNTIME-ACL JWK NULL members and malformed value shapes cannot bypass CHECK three-valued logic',async()=>{
  const f=await fixture(false);
  for(const invalid of [
    ...['kty','crv','x','y'].map(field=>({...f.publicJwk,[field]:null})),
    {...f.publicJwk,d:'private'}, {...f.publicJwk,x:'A'.repeat(42)+'B'},
    {...f.publicJwk,x:7}, {...f.publicJwk,y:[]}, {...f.publicJwk,kty:'RSA'}, {}, null,
  ]) await assert.rejects(app.query(`INSERT INTO runtime_registration_challenges
    (challenge_id,runtime_device_id,owner_user_id,owner_principal_id,scope_id,environment,begin_key,public_jwk,key_thumbprint,nonce,issued_at,expires_at)
    SELECT gen_random_uuid(),gen_random_uuid(),owner_user_id,owner_principal_id,scope_id,environment,gen_random_uuid()::text,$2::jsonb,key_thumbprint,nonce,issued_at,expires_at
    FROM runtime_registration_challenges WHERE challenge_id=$1`,[f.challenge.challenge_id,JSON.stringify(invalid)]),sqlCode('23514'));
});

test('RUNTIME-ACL pending challenge immutable fields cannot change even while validly consuming',async()=>{
  const f=await fixture(false);
  for(const assignment of ['owner_user_id=gen_random_uuid()','owner_principal_id=gen_random_uuid()','scope_id=gen_random_uuid()',
    'runtime_device_id=gen_random_uuid()','challenge_id=gen_random_uuid()',"environment='next'","nonce=repeat('A',43)",
    "key_thumbprint=repeat('A',43)","public_jwk='{}'::jsonb","begin_key='replacement'",
    "issued_at=issued_at-interval '1 second'","expires_at=expires_at+interval '1 second'"])
    await assert.rejects(app.query(`UPDATE runtime_registration_challenges SET consumed_at=clock_timestamp(),${assignment} WHERE challenge_id=$1`,[f.challenge.challenge_id]),sqlCode('23514'));
  assert.equal((await app.query('SELECT consumed_at FROM runtime_registration_challenges WHERE challenge_id=$1',[f.challenge.challenge_id])).rows[0].consumed_at,null);
});

test('RUNTIME-ACL revoked environment/key tombstone prevents a second structural enrollment',async()=>{
  const f=await fixture();
  await api.revoke(f.actor,{key:randomUUID(),runtimeDeviceId:f.challenge.runtime_device_id,expectedVersion:'1'});
  // SQL checks structure and uniqueness, not ES256. A compromised trusted DML
  // caller can construct a consumed challenge but cannot clear the key tombstone.
  const clone=(await app.query(`INSERT INTO runtime_registration_challenges
    (challenge_id,runtime_device_id,owner_user_id,owner_principal_id,scope_id,environment,begin_key,public_jwk,key_thumbprint,nonce,issued_at,expires_at)
    SELECT gen_random_uuid(),gen_random_uuid(),owner_user_id,owner_principal_id,scope_id,environment,gen_random_uuid()::text,public_jwk,key_thumbprint,nonce,issued_at,expires_at
    FROM runtime_registration_challenges WHERE challenge_id=$1 RETURNING challenge_id`,[f.challenge.challenge_id])).rows[0].challenge_id;
  await app.query('UPDATE runtime_registration_challenges SET consumed_at=clock_timestamp() WHERE challenge_id=$1',[clone]);
  await assert.rejects(insertRegistration(app,clone),sqlCode('23505'));
  assert.equal((await app.query('SELECT count(*)::int n FROM runtime_registrations WHERE environment=$1 AND key_thumbprint=$2',['local',f.challenge.key_thumbprint])).rows[0].n,1);
});
