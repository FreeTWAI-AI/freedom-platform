// Actual local PG18 pg_dump/pg_restore + native ephemeral R2. This explicitly
// owned-container drill is separate from ordinary npm test. No live DB or cloud
// credentials; full deployment/recovery-authority acceptance is still separate.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { Pool } from 'pg';
import {readFile} from 'node:fs/promises';
import {tokenHash} from '../../modules/identity-membership/service.js';
import {sevenMediaFixtures,mediaApp,memberHeaders,origin} from './helpers/media-restore-fixtures.js';
import sharp from 'sharp';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { migrate } from '../../scripts/database.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import { lockMemberSession } from '../../packages/db/member-session.js';
import { transaction } from '../../packages/db/transaction.js';
import { createAssetMaintenance } from '../../modules/assets/maintenance.js';
import type { Actor } from '../../modules/identity-membership/service.js';
import { createR2ObjectStore, type AssetR2Binding } from '../../packages/asset-storage/r2.js';
import { objectKey, sha256, readVerifiedObject, writeVerifiedObject, type ObjectStore } from '../../packages/asset-storage/index.js';
import { createConsistentAssetBackup, ConsistentBackupError } from '../../packages/media-migration/backup-coordinator.js';
import {lockdownRestoredMediaAcl} from '../../packages/media-migration/restore-acl-lockdown.js';
import {runMediaRestoreAcl} from '../../scripts/media-restore-acl.js';
import { transferRestore } from '../../packages/media-migration/backup-transfer.js';

const configured=process.env.TEST_DATABASE_URL,container=process.env.TEST_POSTGRES_CONTAINER_ID;
assert(configured&&container,'Explicit owned TEST_DATABASE_URL and TEST_POSTGRES_CONTAINER_ID required');
assert.match(container,/^[0-9a-f]{64}$/);
const url=new URL(configured);assert.match(url.pathname,/^\/fp_[a-z0-9_]+$/);
assert(['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&url.username==='postgres');
const details=JSON.parse(execFileSync('docker',['inspect',container],{encoding:'utf8',maxBuffer:1024*1024}))[0];
assert.equal(details.Id,container);assert.equal(details.HostConfig.NetworkMode,'none');
assert.equal(Object.keys(details.HostConfig.PortBindings??{}).length,0);
assert((details.Config.Labels?.['freedom.task']==='base-ci-20261003'&&details.Config.Labels?.['freedom.owner']==='codeql_remediation')
  ||(details.Config.Labels?.['freedom.task']==='media-restore-drill'&&details.Config.Labels?.['freedom.owner']==='run-media-restore-test'));
assert(details.HostConfig.Tmpfs?.['/var/lib/postgresql']);
const sourceDatabase=url.pathname.slice(1),schema='fp_base_backup_'+randomUUID().replaceAll('-','');
const restoredDatabase='fp_base_restore_'+randomUUID().replaceAll('-',''),runtimeRole='fp_restore_app_'+randomUUID().replaceAll('-','');
const runtimePassword=randomBytes(24).toString('hex'),runtimeUrl=new URL(url);runtimeUrl.username=runtimeRole;runtimeUrl.password=runtimePassword;
function runtimeConnection(database:string){const connection=new URL(runtimeUrl);connection.pathname='/'+database;return connection.href;}
const admin=new Pool({connectionString:url.href,max:2});
const pool=new Pool({connectionString:url.href,options:`-c search_path=${schema} -c statement_timeout=10000`,max:6});
const restoredUrl=new URL(url);restoredUrl.pathname='/'+restoredDatabase;
const runtime=new Pool({connectionString:runtimeUrl.href,options:`-c search_path=${schema} -c statement_timeout=10000`,max:6});
let restoredRuntime:Pool|undefined,createdRole=false;
let restored:Pool|undefined,mf:Miniflare|undefined,createdSchema=false,createdDatabase=false;
let source:ObjectStore,backup:ObjectStore,destination:ObjectStore,outboundCalls=0;
before(async()=>{
  await admin.query(`CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`);createdRole=true;
  await admin.query(`CREATE SCHEMA ${schema}`);createdSchema=true;await migrate(pool);await grantRuntime(pool);
  await admin.query(`CREATE DATABASE ${restoredDatabase}`);createdDatabase=true;
  restored=new Pool({connectionString:restoredUrl.href,options:`-c search_path=${schema} -c statement_timeout=10000`,max:4});
  const restoredRuntimeUrl=new URL(runtimeUrl);restoredRuntimeUrl.pathname='/'+restoredDatabase;restoredRuntime=new Pool({connectionString:restoredRuntimeUrl.href,options:`-c search_path=${schema} -c statement_timeout=10000`,max:4});
  mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'synthetic-media-restore',modules:true,
    script:'export default {fetch(){return new Response(null,{status:503})}}',
    compatibilityDate:'2026-09-21',r2Buckets:['SOURCE','BACKUP','RESTORED','INCOMPLETE'],outboundService:()=>{outboundCalls++;return new Response(null,{status:503});}}]}));
  await mf.ready;
  source=createR2ObjectStore(await mf.getR2Bucket('SOURCE') as unknown as AssetR2Binding,{allowDelete:true});
  backup=createR2ObjectStore(await mf.getR2Bucket('BACKUP') as unknown as AssetR2Binding);
  destination=createR2ObjectStore(await mf.getR2Bucket('RESTORED') as unknown as AssetR2Binding);
  await pool.query(`UPDATE asset_maintenance_policy SET enabled=true,revision='synthetic-backup',orphan_retention_seconds=1,
    retired_retention_seconds=1,delete_lease_seconds=30,capture_seconds=60,pin_seconds=60,max_capture_objects=10`);
});
after(async()=>{
  await mf?.dispose();await restoredRuntime?.end();await restored?.end();await runtime.end();await pool.end();
  try{if(createdDatabase)await admin.query(`DROP DATABASE ${restoredDatabase} WITH (FORCE)`);
    if(createdSchema)await admin.query(`DROP SCHEMA ${schema} CASCADE`);if(createdRole)await admin.query(`DROP ROLE ${runtimeRole}`);
  }finally{await admin.end();}assert.equal(outboundCalls,0);
});

// Apply the actual canonical generator, changing only the fixture's schema and role.
async function grantRuntime(target:Pool){
 const script=(await readFile('deploy/cloudflare/sql/20-runtime-grants.psql','utf8')).replace(/^\\set .*$/mg,'').replaceAll(':"runtime"','"'+runtimeRole+'"').replaceAll(":'runtime'","'"+runtimeRole+"'").replaceAll('SCHEMA public','SCHEMA '+schema).replaceAll("n.nspname='public'","n.nspname='"+schema+"'");
 const q=await target.connect();try{await q.query(`GRANT USAGE ON SCHEMA ${schema} TO ${runtimeRole}`);const parts=script.split('\\gexec');for(let i=0;i<parts.length;i++){const result=await q.query(parts[i]);if(i<parts.length-1){const last=Array.isArray(result)?result.at(-1)!:result;for(const row of last.rows)await q.query(Object.values(row)[0] as string);}}}catch(error){await q.query('ROLLBACK');throw error;}finally{q.release();}
}
const pointerTables=['member_avatar_asset_targets','member_service_cover_asset_targets','community_event_banner_asset_targets','community_event_video_asset_targets','skill_submission_image_asset_targets','community_social_thumbnail_asset_targets','community_event_highlight_asset_targets','community_event_highlight_images'];
async function pointerSnapshot(target:Pool){const snapshots:Record<string,unknown>={};for(const table of pointerTables)snapshots[table]=(await target.query(`SELECT to_jsonb(t) value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;return snapshots;}

async function pgTool(tool:'pg_dump'|'pg_restore',args:string[],input?:Buffer):Promise<Buffer>{
  const child=spawn('docker',['exec',...(input?['-i']:[]),container!,tool,'-U','postgres',...args],{stdio:['pipe','pipe','pipe'],detached:true});
  const chunks:Buffer[]=[];let size=0,failed=false;
  const stop=()=>{failed=true;try{process.kill(-child.pid!,'SIGKILL');}catch{}};
  const timer=setTimeout(stop,30000);
  child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>16*1024*1024)stop();else chunks.push(chunk);});
  // Do not expose raw dump/SQL/role/key diagnostics in reports.
  child.stderr.resume();child.stdin.on('error',()=>{});child.stdin.end(input);
  try{await new Promise<void>((done,reject)=>{child.once('error',()=>reject(Error('owned_pg_tool_failed')));
    child.once('close',code=>code===0&&!failed?done():reject(Error('owned_pg_tool_failed')));});return Buffer.concat(chunks,size);
  }finally{clearTimeout(timer);}
}
async function asset(retired=false){
  const community=randomUUID(),userId=randomUUID(),session=randomUUID(),assetId=randomUUID(),representationId=randomUUID();
  await pool.query('INSERT INTO communities VALUES($1,$2)',[community,'Synthetic restore fixture']);
  const user=(await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic backup owner','not-a-login-hash',$4) RETURNING *`,[userId,community,userId+'@example.invalid',randomUUID()])).rows[0];
  await pool.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')",[session,userId]);
  const actor={...user,session_hash:session,csrf_token:'synthetic'} as Actor;
  const context=await withMemberScope(pool,{actor,scope:'personal'},async()=>{},async(_q,c)=>c);
  const scopeId=context.scope.scope_id,principal=context.subject_principal.principal_id;
  await pool.query('INSERT INTO member_avatars(user_id,community_id) VALUES($1,$2)',[userId,community]);
  await pool.query('INSERT INTO member_avatar_asset_targets(user_id,scope_id,owner_principal_id) VALUES($1,$2,$3)',[userId,scopeId,principal]);
  await pool.query(`INSERT INTO assets(asset_id,scope_id,owner_principal_id,owner_user_id,policy_revision,representation_id,created_at)
    VALUES($1,$2,$3,$4,'synthetic-content',$5,clock_timestamp()-interval '1 hour')`,[assetId,scopeId,principal,userId,representationId]);
  const bytes=new Uint8Array(await sharp({create:{width:256,height:256,channels:3,background:retired?'green':'red'}}).webp().toBuffer());
  const metadata={contentType:'image/webp' as const,byteSize:bytes.length,sha256:await sha256(bytes),transformVersion:'avatar.webp.v1' as const,policyRevision:'synthetic-content'};
  const key=objectKey({scopeId,assetId,representationId});
  await writeVerifiedObject(source,key,{bytes,metadata},{revision:metadata.policyRevision,platformPersistenceAllowed:true});
  await pool.query(`INSERT INTO asset_objects(asset_id,scope_id,representation_id,content_type,byte_size,content_sha256,transform_version,policy_revision)
    VALUES($1,$2,$3,'image/webp',$4,$5,'avatar.webp.v1','synthetic-content')`,[assetId,scopeId,representationId,metadata.byteSize,metadata.sha256]);
  await pool.query("UPDATE assets SET state='ready',ready_at=clock_timestamp()-interval '1 hour' WHERE asset_id=$1",[assetId]);
  if(retired)await pool.query("UPDATE assets SET state='retired',retired_at=clock_timestamp()-interval '1 hour' WHERE asset_id=$1",[assetId]);
  else await pool.query('UPDATE member_avatar_asset_targets SET asset_id=$2,linked_at_version=1 WHERE user_id=$1',[userId,assetId]);
  return {actor,assetId,key,metadata,bytes};
}

test('Actual consistent PG dump and nativeR2 restore exclude concurrent additions, retain retired objects and fence restored member sessions',async()=>{
  const first=await asset(),retired=await asset(true),seven=await sevenMediaFixtures(pool,runtime,source),pointers=await pointerSnapshot(pool),snapshotIds=(await pool.query('SELECT asset_id FROM assets ORDER BY asset_id')).rows.map(r=>r.asset_id),maintenance=createAssetMaintenance(pool,{store:source,enabled:true});
  const target={database:sourceDatabase,sourceSchema:schema,sourceRelease:'a'.repeat(40)};
  let dump:Buffer|undefined,late:Awaited<ReturnType<typeof asset>>|undefined;
  const manifest=await createConsistentAssetBackup(pool,{enabled:true,target,maintenance,source,destination:backup,databaseSnapshot:{async write(input){
    // A real committed writer advances after pin capture but before pg_dump.
    late=await asset();
    dump=await pgTool('pg_dump',['--dbname',input.database,'--schema',input.schema,'--snapshot',input.snapshotId,
      '--format=custom','--no-owner','--no-privileges']);
    return {sha256:createHash('sha256').update(dump).digest('hex'),byteSize:dump.length};
  }}});
  assert.equal(manifest.status,'database_snapshot_and_objects_verified');assert.equal(manifest.objects.objects.length,10);
  assert(late&&dump);const lateAsset=late;assert(!manifest.objects.objects.some(o=>o.key===lateAsset.key));
  await assert.rejects(maintenance.claimDelete(retired.assetId),(e:any)=>e.code==='23514','pins block actual GC');
  await pgTool('pg_restore',['--dbname',restoredDatabase,'--single-transaction','--exit-on-error','--no-owner','--no-privileges'],dump);
  const restoredIds=(await restored!.query('SELECT asset_id FROM assets ORDER BY asset_id')).rows.map(r=>r.asset_id);
  assert.deepEqual(restoredIds,snapshotIds);assert.equal(restoredIds.length,10);assert(!restoredIds.includes(late.assetId));
  assert.equal((await restored!.query('SELECT count(*)::int AS n FROM asset_backup_pins')).rows[0].n,0,'dump imports original pre-pin snapshot');
  assert.deepEqual((await restored!.query('SELECT name,sha256 FROM schema_migrations ORDER BY name')).rows,
    (await pool.query('SELECT name,sha256 FROM schema_migrations ORDER BY name')).rows);
  assert.deepEqual(await pointerSnapshot(restored!),pointers,'Every original typed pointer and both highlight variants survive pg_dump.');
  assert.deepEqual((await restored!.query("SELECT a.asset_id,a.purpose,a.scope_kind,a.community_ref,o.variant,o.profile_id,o.content_sha256,o.byte_size,o.object_key FROM assets a JOIN asset_objects o USING(asset_id) WHERE a.owner_user_id=$1 ORDER BY a.asset_id",[seven.member.actor.user_id])).rows,seven.rows);
  await assert.rejects(restoredRuntime!.query(`SELECT * FROM ${schema}.schema_migrations`),(e:any)=>e.code==='42501','No ACLs imported from --no-privileges dump.');
  await restoredRuntime!.end();restoredRuntime=undefined;
  // --no-privileges also strips migration105's PUBLIC function revocations.
  // The unchanged canonical guard must reject that unsafe restored default.
  await assert.rejects(grantRuntime(restored!),(e:any)=>e.code==='P0001'&&e.message==='Unsafe runtime operator media privileges');
  const functionPrivileges=()=>restored!.query("SELECT p.proname,has_function_privilege($1,p.oid,'EXECUTE') allowed FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$2 AND p.proname IN ('lock_media_backfill_operator_approval','lock_media_backfill_cover_owner','lock_media_backfill_cover_consent','publish_media_backfill_cover','lock_media_backfill_video_organizer','lock_media_backfill_video_consent','publish_media_backfill_video') ORDER BY p.proname",[runtimeRole,schema]);
  const unsafeFunctions=(await functionPrivileges()).rows;assert.equal(unsafeFunctions.length,7);assert(unsafeFunctions.every(r=>r.allowed===true),'Stripped ACLs restore PostgreSQL PUBLIC EXECUTE default.');
  const aclTarget={environment:'local' as const,database:restoredDatabase,schema,role:'postgres',releaseSha:'a'.repeat(40)},aclOptions={target:aclTarget,runtimeRole};
  const aclArgs=['--environment','local','--expected-database',restoredDatabase,'--schema',schema,'--expected-role','postgres','--release-sha','a'.repeat(40),'--runtime-role',runtimeRole];
  const noDatabaseEnv=Object.defineProperty({},'FREEDOM_MEDIA_DATABASE_URL',{get(){throw Error('Plan must not read connection secret.');}});
  const plan=await runMediaRestoreAcl(aclArgs,noDatabaseEnv);assert.equal(plan.exitCode,0);assert.equal((plan.report as {execution:string}).execution,'not_run');
  const wrongEnvironment=await runMediaRestoreAcl(['--environment','staging','--expected-database','freedom_next','--schema','public','--expected-role','freedom_next_migrator','--release-sha','a'.repeat(40),'--runtime-role','freedom_next_app'],noDatabaseEnv);assert.equal(wrongEnvironment.exitCode,2);assert.equal((wrongEnvironment.report as {code:string}).code,'invalid_target');
  const mismatch=await runMediaRestoreAcl([...aclArgs,'--execute-lockdown'],{FREEDOM_MEDIA_DATABASE_URL:url.href});assert.equal(mismatch.exitCode,2);assert.equal((mismatch.report as {code:string}).code,'database_target_mismatch');
  await assert.rejects(lockdownRestoredMediaAcl(restored!,{...aclOptions,target:{...aclTarget,database:'fp_wrong_restore'}}),(e:any)=>e.code==='target_mismatch');
  const originalHash=(await restored!.query("SELECT sha256 FROM schema_migrations WHERE name='107_operator_event_video_backfill.sql'")).rows[0].sha256;
  await restored!.query("UPDATE schema_migrations SET sha256=repeat('f',64) WHERE name='107_operator_event_video_backfill.sql'");
  try{await assert.rejects(lockdownRestoredMediaAcl(restored!,aclOptions),(e:any)=>e.code==='ledger_mismatch');}finally{await restored!.query("UPDATE schema_migrations SET sha256=$1 WHERE name='107_operator_event_video_backfill.sql'",[originalHash]);}
  await restored!.query("CREATE FUNCTION fp_unknown_restore_port() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1';REVOKE ALL ON FUNCTION fp_unknown_restore_port() FROM PUBLIC");
  try{await assert.rejects(lockdownRestoredMediaAcl(restored!,aclOptions),(e:any)=>e.code==='function_shape_mismatch');}finally{await restored!.query('DROP FUNCTION fp_unknown_restore_port()');}
  const currentApp=new Pool({connectionString:runtimeConnection(restoredDatabase),max:1});
  try{await currentApp.query('SELECT 1');await assert.rejects(lockdownRestoredMediaAcl(restored!,aclOptions),(e:any)=>e.code==='runtime_active');}finally{await currentApp.end();}
  assert((await functionPrivileges()).rows.every(r=>r.allowed===true),'Every refused operation rolls back without masking unsafe restored defaults.');
  const locked=await runMediaRestoreAcl([...aclArgs,'--execute-lockdown'],{FREEDOM_MEDIA_DATABASE_URL:restoredUrl.href});assert.equal(locked.exitCode,0,JSON.stringify(locked.report));assert.equal((locked.report as {functionsRevoked:number}).functionsRevoked,7);assert.equal((locked.report as {applicationInstalled:boolean}).applicationInstalled,false);
  assert.equal((await lockdownRestoredMediaAcl(restored!,aclOptions)).functionsRevoked,7,'Lockdown can be safely rerun before installation.');
  await grantRuntime(restored!);const closedFunctions=(await functionPrivileges()).rows;assert.equal(closedFunctions.length,7);assert(closedFunctions.every(r=>r.allowed===false));
  restoredRuntime=new Pool({connectionString:runtimeConnection(restoredDatabase),options:`-c search_path=${schema} -c statement_timeout=10000`,max:4});
  await assert.rejects(restoredRuntime!.query("UPDATE domain_media_storage_policy SET persistence_allowed=true"),(e:any)=>e.code==='42501');
  await assert.rejects(restoredRuntime!.query("UPDATE schema_migrations SET sha256=sha256"),(e:any)=>e.code==='42501');
  // Restoring a DB alone also rewinds revocation. Fence all dispatch and apply
  // current external authority before exposing the target; this drill exercises
  // member-session invalidation, not a complete broker/device recovery proof.
  await transaction(restored!,q=>lockMemberSession(q,first.actor));
  await restored!.query("UPDATE sessions SET revoked_at=clock_timestamp() WHERE revoked_at IS NULL; UPDATE asset_maintenance_policy SET enabled=false");
  await assert.rejects(transaction(restored!,q=>lockMemberSession(q,first.actor)),(e:any)=>e.code==='session_expired');
  for(const entry of manifest.objects.objects)await source.delete(entry.key);assert.deepEqual((await(await mf!.getR2Bucket('SOURCE')).list()).objects.map(o=>o.key),[late.key],'Only excluded late writer remains in source R2.');
  const recovered=await transferRestore(manifest.objects,backup,destination,{async assertAllowed(entry){
    const found=(await restored!.query(`SELECT 1 FROM asset_objects o JOIN assets a USING(asset_id)
      WHERE o.object_key=$1 AND a.deletion_fence=0 AND o.content_sha256=$2 AND o.byte_size=$3 AND o.policy_revision=$4`,
      [entry.key,entry.metadata.sha256,entry.metadata.byteSize,entry.metadata.policyRevision])).rowCount;
    assert.equal(found,1);
  }});
  assert.equal(recovered.objectCount,10);
  for(const f of [first,retired])assert.deepEqual((await readVerifiedObject(destination,f.key,f.metadata)).bytes,f.bytes);
  const restoredApp=mediaApp(restoredRuntime!,destination,seven.community);
  for(const read of seven.reads){const denied=await restoredApp.request(origin+read.path,{headers:memberHeaders(seven.member)});if(!read.path.startsWith('/api/v1/public/'))assert.equal(denied.status,401,'Dumped sessions stay fenced.');}
  // New recovery sessions are issued only after fencing the imported sessions.
  for(const member of [seven.member,seven.other]){const token=randomBytes(32).toString('base64url'),hash=tokenHash(token);await restored!.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')",[hash,member.actor.user_id]);member.token=token;member.actor={...member.actor,session_hash:hash};}
  for(const read of seven.reads){
   const result=await restoredApp.request(origin+read.path,{headers:memberHeaders(seven.member)});assert.equal(result.status,200,await result.clone().text());assert.deepEqual(Buffer.from(await result.arrayBuffer()),read.bytes,read.purpose+' original URL and SHA');
   if(read.publicPath){const publicRead=await restoredApp.request(origin+read.publicPath);assert.equal(publicRead.status,200,await publicRead.clone().text());assert.deepEqual(Buffer.from(await publicRead.arrayBuffer()),read.bytes);if(read.publicPath.includes('/public/'))assert.equal(publicRead.headers.get('cache-control'),'public, max-age=300');}
   if(read.dtoPath){const view=await restoredApp.request(origin+read.dtoPath,{headers:memberHeaders(seven.member)});assert.equal(view.status,200,read.dtoPath+' '+await view.clone().text());assert.deepEqual(await view.json(),read.dto,'Original DTO remains identical after restoring.');}
  }
  const skill=seven.reads.find(r=>r.purpose==='skill.submission-image')!;assert.equal((await restoredApp.request(origin+skill.path.replace('/api/v1/me/','/api/v1/'))).status,404,'Private draft remains unavailable on public illustration route.');assert.equal((await restoredApp.request(origin+skill.path,{headers:memberHeaders(seven.other)})).status,404);
  await restored!.query('UPDATE users SET active=false WHERE user_id=$1',[seven.member.actor.user_id]);
  for(const read of seven.reads.filter(r=>!r.path.startsWith('/api/v1/public/')))assert.equal((await restoredApp.request(origin+read.path,{headers:memberHeaders(seven.member)})).status,401,'Inactive caller cannot read restored bytes.');
  await restored!.query('UPDATE users SET active=true WHERE user_id=$1',[seven.member.actor.user_id]);
  const tampered={...manifest.objects,objects:manifest.objects.objects.map((o,i)=>i===0?{...o,metadata:{...o.metadata,sha256:'f'.repeat(64)}}:o)};
  await assert.rejects(transferRestore(tampered,backup,destination,{async assertAllowed(){}}));
  // An external deletion fact survives the DB restore and must veto old bytes.
  await assert.rejects(transferRestore(manifest.objects,backup,destination,{async assertAllowed(entry){
    if(entry.key===first.key)throw Error('external_current_deletion');
  }}));
  const missing=manifest.objects.objects[0];await(await mf!.getR2Bucket('BACKUP')).delete(missing.key);
  const incomplete=createR2ObjectStore(await mf!.getR2Bucket('INCOMPLETE') as unknown as AssetR2Binding);
  await assert.rejects(transferRestore(manifest.objects,backup,incomplete,{async assertAllowed(){}}),'Missing native backup object cannot produce a verified restore.');
  assert((await(await mf!.getR2Bucket('INCOMPLETE')).list()).objects.length<10);
});

test('Backup default-off, mismatched target and single-connection pool fail before snapshot/dump authority',async()=>{
  const maintenance=createAssetMaintenance(pool,{store:source,enabled:true}),target={database:sourceDatabase,sourceSchema:schema,sourceRelease:'b'.repeat(40)};
  let calls=0;const databaseSnapshot={async write(){calls++;return {sha256:'c'.repeat(64),byteSize:1};}};
  const options={target,maintenance,source,destination:backup,databaseSnapshot};
  await assert.rejects(createConsistentAssetBackup(pool,options),e=>e instanceof ConsistentBackupError&&e.code==='backup_disabled');
  await assert.rejects(createConsistentAssetBackup(pool,{...options,enabled:true,target:{...target,database:'fp_wrong'}}),e=>e instanceof ConsistentBackupError&&e.code==='backup_target_mismatch');
  const one=new Pool({connectionString:url.href,max:1});try{
    await assert.rejects(createConsistentAssetBackup(one,{...options,enabled:true}),e=>e instanceof ConsistentBackupError&&e.code==='backup_invalid_target');
  }finally{await one.end();}
  assert.equal(calls,0);
});
