import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {Pool,type PoolClient} from 'pg';
import {migrate} from '../../scripts/database.js';

const url=process.env.TEST_DATABASE_URL;if(!url)throw new Error('Explicit isolated TEST_DATABASE_URL required');
const schema=`fp_operator_app_acl_${process.pid}_${Date.now()}`,ownerRole=schema+'_owner',appRole=schema+'_app',parentRole=schema+'_parent';
const admin=new Pool({connectionString:url}),owner=new Pool({connectionString:url,options:`-c role=${ownerRole} -c search_path=${schema} -c statement_timeout=10000`});
let ready=false,queries:string[],readback:string;
before(async()=>{
 const grants=await readFile(new URL('../../deploy/cloudflare/sql/20-runtime-grants.psql',import.meta.url),'utf8');
 queries=['TABLE','FUNCTION','SEQUENCE'].map(kind=>grants.split(`-- BEGIN OPERATOR MEDIA ${kind} EXCLUSIONS\n`)[1].split('\n\\gexec')[0].replaceAll(":'runtime'",`'${appRole}'`).replaceAll("n.nspname='public'",`n.nspname='${schema}'`));
 const verify=await readFile(new URL('../../deploy/cloudflare/sql/30-verify-readonly.psql',import.meta.url),'utf8');
 readback=verify.split('-- BEGIN OPERATOR MEDIA READBACK\n')[1].split('\n-- END OPERATOR MEDIA READBACK')[0].replaceAll(":'runtime'",`'${appRole}'`).replaceAll("n.nspname='public'",`n.nspname='${schema}'`);
 await admin.query(`CREATE ROLE ${ownerRole} NOLOGIN;CREATE ROLE ${appRole} NOLOGIN;CREATE ROLE ${parentRole} NOLOGIN;CREATE SCHEMA ${schema} AUTHORIZATION ${ownerRole};GRANT USAGE ON SCHEMA ${schema} TO ${appRole}`);ready=true;await migrate(owner);
});
after(async()=>{await owner.end();if(ready)await admin.query(`DROP SCHEMA ${schema} CASCADE;DROP ROLE ${appRole},${parentRole},${ownerRole}`);await admin.end();});
async function phase(run:(q:PoolClient)=>Promise<void>){const q=await owner.connect();try{await q.query('BEGIN');await run(q);}finally{await q.query('ROLLBACK');q.release();}}
async function fence(q:PoolClient){const counts=[];for(const query of queries){const rows=(await q.query(query)).rows;counts.push(rows.length);for(const row of rows)await q.query(Object.values(row)[0] as string);}assert.deepEqual(counts,[4,7,1]);}
const denied=(e:unknown)=>(e as {code:string}).code==='42501',unsafe=(e:unknown)=>(e as Error).message==='Unsafe runtime operator media privileges';
test('legacy broad grants really permit operator approval insertion; exclusions remove tables, columns, functions and sequence',async()=>{
 await phase(async q=>{
  await q.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${appRole};GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${appRole};GRANT INSERT(allowed) ON media_backfill_operator_policy TO ${appRole} WITH GRANT OPTION;GRANT EXECUTE ON FUNCTION lock_media_backfill_operator_approval(text) TO ${appRole}`);
  assert.deepEqual((await q.query(readback)).rows,[{operator_media_tables:4,operator_media_functions:7,operator_media_unsafe:true}]);
  await q.query('SAVEPOINT unsafe_before');await q.query(`SET LOCAL ROLE ${appRole}`);
  await q.query("INSERT INTO media_backfill_operator_policy(role_name,environment,database_name,schema_name,release_sha,store_binding_id,migration_id,approved_plan_sha256,allowed,expires_at) VALUES('fp_media_migrator_fixture','local',current_database(),$1,$2,'synthetic','synthetic-job',$3,true,clock_timestamp()+interval '1 hour')",[schema,'a'.repeat(40),'b'.repeat(64)]);
  await q.query('ROLLBACK TO SAVEPOINT unsafe_before');await fence(q);await fence(q);
  assert.deepEqual((await q.query(readback)).rows,[{operator_media_tables:4,operator_media_functions:7,operator_media_unsafe:false}]);
  await q.query(`SET LOCAL ROLE ${appRole}`);
  const statements=[...['media_backfill_operator_policy','media_backfill_jobs','media_backfill_items','media_backfill_audit'].flatMap(table=>[`SELECT * FROM ${table}`,`DELETE FROM ${table}`,`TRUNCATE ${table}`]),"UPDATE media_backfill_operator_policy SET allowed=true","INSERT INTO media_backfill_operator_policy(allowed) VALUES(true)","SELECT * FROM lock_media_backfill_operator_approval('forged')","SELECT * FROM lock_media_backfill_cover_owner('forged',NULL)","SELECT * FROM lock_media_backfill_cover_consent('forged')","SELECT * FROM publish_media_backfill_cover('forged',NULL,NULL,0,NULL)","SELECT * FROM lock_media_backfill_video_organizer('forged',NULL)","SELECT * FROM lock_media_backfill_video_consent('forged')","SELECT * FROM publish_media_backfill_video('forged',NULL,NULL,0,NULL)","SELECT nextval('media_backfill_audit_audit_id_seq')"];
  for(const sql of statements){await q.query('SAVEPOINT denied');await assert.rejects(q.query(sql),denied);await q.query('ROLLBACK TO SAVEPOINT denied');}
 });
});
test('PUBLIC column privilege cannot be removed by a direct app revoke and fails the operator fence',async()=>{
 await phase(async q=>{await q.query('GRANT SELECT(approved_plan_sha256) ON media_backfill_operator_policy TO PUBLIC');assert.equal((await q.query(readback)).rows[0].operator_media_unsafe,true);await assert.rejects(fence(q),unsafe);});
});
test('PUBLIC execution on each closed publication port fails the operator fence',async()=>{
 for(const purpose of ['cover','video'])await phase(async q=>{await q.query(`GRANT EXECUTE ON FUNCTION publish_media_backfill_${purpose}(text,uuid,uuid,bigint,uuid) TO PUBLIC`);assert.equal((await q.query(readback)).rows[0].operator_media_unsafe,true);await assert.rejects(fence(q),unsafe);});
});
test('inherited operator table grants cannot masquerade as an app role with no direct grants',async()=>{
 await admin.query(`GRANT ${parentRole} TO ${appRole}`);
 try{await phase(async q=>{await q.query(`GRANT SELECT ON media_backfill_jobs TO ${parentRole}`);await assert.rejects(fence(q),unsafe);});}
 finally{await admin.query(`REVOKE ${parentRole} FROM ${appRole}`);}
});
