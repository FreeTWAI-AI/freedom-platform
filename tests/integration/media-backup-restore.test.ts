// Actual local PG18 pg_dump/pg_restore + native ephemeral R2. This explicitly
// owned-container drill is separate from ordinary npm test. No live DB or cloud
// credentials; full deployment/recovery-authority acceptance is still separate.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { Pool } from 'pg';
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
const restoredDatabase='fp_base_restore_'+randomUUID().replaceAll('-','');
const admin=new Pool({connectionString:url.href,max:2});
const pool=new Pool({connectionString:url.href,options:`-c search_path=${schema} -c statement_timeout=10000`,max:6});
const restoredUrl=new URL(url);restoredUrl.pathname='/'+restoredDatabase;
let restored:Pool|undefined,mf:Miniflare|undefined,createdSchema=false,createdDatabase=false;
let source:ObjectStore,backup:ObjectStore,destination:ObjectStore;
before(async()=>{
  await admin.query(`CREATE SCHEMA ${schema}`);createdSchema=true;await migrate(pool);
  await admin.query(`CREATE DATABASE ${restoredDatabase}`);createdDatabase=true;
  restored=new Pool({connectionString:restoredUrl.href,options:`-c search_path=${schema} -c statement_timeout=10000`,max:4});
  mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'synthetic-media-restore',modules:true,
    script:'export default {fetch(){return new Response(null,{status:503})}}',
    compatibilityDate:'2026-09-21',r2Buckets:['SOURCE','BACKUP','RESTORED'],outboundService:()=>new Response(null,{status:503})}]}));
  await mf.ready;
  source=createR2ObjectStore(await mf.getR2Bucket('SOURCE') as unknown as AssetR2Binding,{allowDelete:true});
  backup=createR2ObjectStore(await mf.getR2Bucket('BACKUP') as unknown as AssetR2Binding);
  destination=createR2ObjectStore(await mf.getR2Bucket('RESTORED') as unknown as AssetR2Binding);
  await pool.query(`UPDATE asset_maintenance_policy SET enabled=true,revision='synthetic-backup',orphan_retention_seconds=1,
    retired_retention_seconds=1,delete_lease_seconds=30,capture_seconds=60,pin_seconds=60,max_capture_objects=10`);
});
after(async()=>{
  await mf?.dispose();await restored?.end();await pool.end();
  try{if(createdDatabase)await admin.query(`DROP DATABASE ${restoredDatabase} WITH (FORCE)`);
    if(createdSchema)await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  }finally{await admin.end();}
});

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
  const first=await asset(),retired=await asset(true),maintenance=createAssetMaintenance(pool,{store:source,enabled:true});
  const target={database:sourceDatabase,sourceSchema:schema,sourceRelease:'a'.repeat(40)};
  let dump:Buffer|undefined,late:Awaited<ReturnType<typeof asset>>|undefined;
  const manifest=await createConsistentAssetBackup(pool,{enabled:true,target,maintenance,source,destination:backup,databaseSnapshot:{async write(input){
    // A real committed writer advances after pin capture but before pg_dump.
    late=await asset();
    dump=await pgTool('pg_dump',['--dbname',input.database,'--schema',input.schema,'--snapshot',input.snapshotId,
      '--format=custom','--no-owner','--no-privileges']);
    return {sha256:createHash('sha256').update(dump).digest('hex'),byteSize:dump.length};
  }}});
  assert.equal(manifest.status,'database_snapshot_and_objects_verified');assert.equal(manifest.objects.objects.length,2);
  assert(late&&dump);const lateAsset=late;assert(!manifest.objects.objects.some(o=>o.key===lateAsset.key));
  await assert.rejects(maintenance.claimDelete(retired.assetId),(e:any)=>e.code==='23514','pins block actual GC');
  await pgTool('pg_restore',['--dbname',restoredDatabase,'--single-transaction','--exit-on-error','--no-owner','--no-privileges'],dump);
  const restoredIds=(await restored!.query('SELECT asset_id FROM assets ORDER BY asset_id')).rows.map(r=>r.asset_id);
  assert.deepEqual(restoredIds,[first.assetId,retired.assetId].sort());assert(!restoredIds.includes(late.assetId));
  assert.equal((await restored!.query('SELECT count(*)::int AS n FROM asset_backup_pins')).rows[0].n,0,'dump imports original pre-pin snapshot');
  assert.deepEqual((await restored!.query('SELECT name,sha256 FROM schema_migrations ORDER BY name')).rows,
    (await pool.query('SELECT name,sha256 FROM schema_migrations ORDER BY name')).rows);
  // Restoring a DB alone also rewinds revocation. Fence all dispatch and apply
  // current external authority before exposing the target; this drill exercises
  // member-session invalidation, not a complete broker/device recovery proof.
  await transaction(restored!,q=>lockMemberSession(q,first.actor));
  await restored!.query("UPDATE sessions SET revoked_at=clock_timestamp() WHERE revoked_at IS NULL; UPDATE asset_maintenance_policy SET enabled=false");
  await assert.rejects(transaction(restored!,q=>lockMemberSession(q,first.actor)),(e:any)=>e.code==='session_expired');
  await source.delete(first.key);await source.delete(retired.key);
  const recovered=await transferRestore(manifest.objects,backup,destination,{async assertAllowed(entry){
    const found=(await restored!.query(`SELECT 1 FROM asset_objects o JOIN assets a USING(asset_id)
      WHERE o.object_key=$1 AND a.deletion_fence=0 AND o.content_sha256=$2 AND o.byte_size=$3 AND o.policy_revision=$4`,
      [entry.key,entry.metadata.sha256,entry.metadata.byteSize,entry.metadata.policyRevision])).rowCount;
    assert.equal(found,1);
  }});
  assert.equal(recovered.objectCount,2);
  for(const f of [first,retired])assert.deepEqual((await readVerifiedObject(destination,f.key,f.metadata)).bytes,f.bytes);
  const tampered={...manifest.objects,objects:manifest.objects.objects.map((o,i)=>i===0?{...o,metadata:{...o.metadata,sha256:'f'.repeat(64)}}:o)};
  await assert.rejects(transferRestore(tampered,backup,destination,{async assertAllowed(){}}));
  // An external deletion fact survives the DB restore and must veto old bytes.
  await assert.rejects(transferRestore(manifest.objects,backup,destination,{async assertAllowed(entry){
    if(entry.key===first.key)throw Error('external_current_deletion');
  }}));
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
