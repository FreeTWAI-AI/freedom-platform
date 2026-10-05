// Actual new archive orchestration: exported-snapshot coordinator -> seal ->
// full readback -> pg_restore -> evidence/current authority -> native local R2.
// Synthetic fixture data only; no live recovery, GC, PITR or exposure approval.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,open,rename,rm} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {Readable} from 'node:stream';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Pool} from 'pg';
import sharp from 'sharp';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {migrate} from '../../scripts/database.js';
import {withMemberScope} from '../../packages/resource-scopes/index.js';
import type {Actor} from '../../modules/identity-membership/service.js';
import {createAssetMaintenance} from '../../modules/assets/maintenance.js';
import {createR2ObjectStore,type AssetR2Binding} from '../../packages/asset-storage/r2.js';
import {objectKey,sha256,writeVerifiedObject,readVerifiedObject} from '../../packages/asset-storage/index.js';
import {createConsistentAssetBackup} from '../../packages/media-migration/backup-coordinator.js';
import {createFileArchiveStore} from '../../packages/media-migration/backup-archive-fs.js';
import {sealRecoverySet,readbackRecoverySet,restoreRecoverySet,restoredReferenceAuthorization,recoverySetKeys,
  RecoveryArchiveError,type DatabaseRestoreWriter} from '../../packages/media-migration/backup-archive.js';

const configured=process.env.TEST_DATABASE_URL,container=process.env.TEST_POSTGRES_CONTAINER_ID;
assert(configured&&container,'Explicit isolated TEST_DATABASE_URL and owned TEST_POSTGRES_CONTAINER_ID required');
assert.match(container,/^[0-9a-f]{64}$/);
const url=new URL(configured);assert.match(url.pathname,/^\/fp_[a-z0-9_]+$/);
assert(['localhost','127.0.0.1','[::1]'].includes(url.hostname));
const details=JSON.parse(execFileSync('docker',['inspect',container],{encoding:'utf8',maxBuffer:1024*1024,timeout:10000}))[0];
assert.equal(details.Id,container);
const runnerOwned=details.Config.Labels?.['freedom.task']==='media-restore-drill'&&details.Config.Labels?.['freedom.owner']==='run-media-restore-test';
if(runnerOwned){
  assert.equal(details.HostConfig.NetworkMode,'none');assert.equal(Object.keys(details.HostConfig.PortBindings??{}).length,0);
  assert(details.HostConfig.Tmpfs?.['/var/lib/postgresql']);
}else{
  // An explicitly allocated disposable test server may be reused, but its
  // owner marker AND inspected loopback port must match the explicit inputs.
  const owner=process.env.TEST_POSTGRES_CONTAINER_OWNER;assert(owner&&details.Config.Labels?.['freedom.owner']===owner);
  assert.match(details.Name,/^\/fp-[a-z0-9-]*tests[a-z0-9-]*$/);
  assert.deepEqual(details.HostConfig.PortBindings?.['5432/tcp'],[{HostIp:'127.0.0.1',HostPort:url.port}]);
  assert(!url.searchParams.has('host'));
}
const database=url.pathname.slice(1),schema='fp_archive_'+randomUUID().replaceAll('-','');
const errorCode=(code:string,detail?:string)=>(e:unknown)=>e instanceof RecoveryArchiveError&&e.code===code&&(detail===undefined||e.detail===detail);

/** Same owned-container tool boundary as the existing restore drill. Input is
 * consumed before pg_restore starts, so a digest-stream error cannot commit a
 * partial database. The restore itself is one PostgreSQL transaction. */
async function pgTool(tool:'pg_dump'|'pg_restore',args:string[],input?:Uint8Array):Promise<Buffer>{
  const child=spawn('docker',['exec',...(input?['-i']:[]),container!,tool,'-U',decodeURIComponent(url.username),...args],{stdio:['pipe','pipe','pipe'],detached:true});
  const chunks:Buffer[]=[];let size=0,failed=false;
  const stop=()=>{failed=true;try{process.kill(-child.pid!,'SIGKILL');}catch{}};
  const timer=setTimeout(stop,30000);
  child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>16*1024*1024)stop();else chunks.push(chunk);});
  child.stderr.resume();child.stdin.on('error',()=>{});child.stdin.end(input);
  try{await new Promise<void>((done,reject)=>{child.once('error',()=>reject(Error('owned_pg_tool_failed')));child.once('close',code=>code===0&&!failed?done():reject(Error('owned_pg_tool_failed')));});
    return Buffer.concat(chunks,size);
  }finally{clearTimeout(timer);}
}

test('New recovery archive restores a real snapshot and native R2, and refuses corrupt/current-revoked/sequence-reset recovery',{timeout:120000},async()=>{
  const admin=new Pool({connectionString:url.href,options:'-c statement_timeout=30000',max:2});
  const pool=new Pool({connectionString:url.href,options:`-c search_path=${schema} -c statement_timeout=30000`,max:6});
  const targets:{name:string;pool:Pool}[]=[];let created=false,mf:Miniflare|undefined,root:string|undefined,outbound=0;
  try{
    assert.equal((await admin.query('SHOW server_version_num')).rows[0].server_version_num.slice(0,2),'18');
    root=await mkdtemp(join(tmpdir(),'fp-real-recovery-archive-'));const dumpPathSource=join(root,'captured.dump');
    await admin.query(`CREATE SCHEMA ${schema}`);created=true;await migrate(pool);
    mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response(null,{status:503})}}',
      compatibilityDate:'2026-09-21',r2Buckets:['SOURCE','BACKUP','RESTORED','REVOKED','RESET','QUARANTINE'],
      outboundService:()=>{outbound++;return new Response(null,{status:503});}}));await mf.ready;
    const store=async(name:string)=>createR2ObjectStore(await mf!.getR2Bucket(name) as unknown as AssetR2Binding);
    const source=await store('SOURCE'),backupObjects=await store('BACKUP');
    await pool.query(`UPDATE asset_maintenance_policy SET enabled=true,revision='synthetic-archive',orphan_retention_seconds=1,
      retired_retention_seconds=1,delete_lease_seconds=30,capture_seconds=120,pin_seconds=120,max_capture_objects=10`);
    async function asset(retired=false){
      const community=randomUUID(),userId=randomUUID(),session=randomUUID(),assetId=randomUUID(),representationId=randomUUID();
      await pool.query("INSERT INTO communities VALUES($1,'Synthetic archive owner')",[community]);
      const user=(await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
        VALUES($1,$2,$3,'Synthetic archive owner','not-a-login-hash',$4) RETURNING *`,[userId,community,userId+'@example.invalid',randomUUID()])).rows[0];
      await pool.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')",[session,userId]);
      const actor={...user,session_hash:session,csrf_token:'synthetic'} as Actor;
      const context=await withMemberScope(pool,{actor,scope:'personal'},async()=>{},async(_q,c)=>c),scopeId=context.scope.scope_id;
      await pool.query(`INSERT INTO assets(asset_id,scope_id,owner_principal_id,owner_user_id,policy_revision,representation_id,created_at)
        VALUES($1,$2,$3,$4,'synthetic-content',$5,clock_timestamp()-interval '1 hour')`,[assetId,scopeId,context.subject_principal.principal_id,userId,representationId]);
      const bytes=new Uint8Array(await sharp({create:{width:256,height:256,channels:3,background:retired?'green':'red'}}).webp().toBuffer());
      const metadata={contentType:'image/webp' as const,byteSize:bytes.length,sha256:await sha256(bytes),transformVersion:'avatar.webp.v1' as const,policyRevision:'synthetic-content'};
      const key=objectKey({scopeId,assetId,representationId});await writeVerifiedObject(source,key,{bytes,metadata},{revision:metadata.policyRevision,platformPersistenceAllowed:true});
      await pool.query(`INSERT INTO asset_objects(asset_id,scope_id,representation_id,content_type,byte_size,content_sha256,transform_version,policy_revision)
        VALUES($1,$2,$3,'image/webp',$4,$5,'avatar.webp.v1','synthetic-content')`,[assetId,scopeId,representationId,bytes.length,metadata.sha256]);
      await pool.query("UPDATE assets SET state='ready',ready_at=clock_timestamp()-interval '1 hour' WHERE asset_id=$1",[assetId]);
      if(retired)await pool.query("UPDATE assets SET state='retired',retired_at=clock_timestamp()-interval '1 hour' WHERE asset_id=$1",[assetId]);
      return {assetId,key,bytes,metadata};
    }
    const first=await asset(),retired=await asset(true);
    await pool.query("SELECT nextval('positioning_guild_officer_revision') FROM generate_series(1,7)");
    const sequenceBefore=(await pool.query('SELECT last_value::text value FROM positioning_guild_officer_revision')).rows[0].value;
    const maintenance=createAssetMaintenance(pool,{store:source,enabled:true});let dump:Buffer|undefined,late:Awaited<ReturnType<typeof asset>>|undefined;
    const backup=await createConsistentAssetBackup(pool,{enabled:true,target:{database,sourceSchema:schema,sourceRelease:'a'.repeat(40)},
      maintenance,source,destination:backupObjects,snapshotEvidence:true,databaseSnapshot:{async write(input){
        late=await asset();await pool.query("SELECT nextval('positioning_guild_officer_revision')");
        dump=await pgTool('pg_dump',['--dbname',input.database,'--schema',input.schema,'--snapshot',input.snapshotId,'--format=custom','--no-owner','--no-privileges']);
        const temp=dumpPathSource+'.partial',file=await open(temp,'wx',0o600);
        try{await file.writeFile(dump);await file.sync();}finally{await file.close();}
        await rename(temp,dumpPathSource);const directory=await open(root!,'r');try{await directory.sync();}finally{await directory.close();}
        return {sha256:createHash('sha256').update(dump).digest('hex'),byteSize:dump.length};
      }}});
    assert(dump&&late&&backup.evidence);assert.equal(backup.objects.objects.length,2);assert(!backup.objects.objects.some(o=>o.key===late!.key));
    assert(backup.evidence.tables.length>100);assert.equal(backup.evidence.sequences.find(s=>s.name==='positioning_guild_officer_revision')?.lastValue,sequenceBefore);
    await assert.rejects(maintenance.claimDelete(retired.assetId),(e:any)=>e.code==='23514','source pins remain protective');
    const archive=await createFileArchiveStore(root),setId=randomUUID();
    const sealed=await sealRecoverySet({backup,setId,environment:'local',createdAt:new Date().toISOString(),
      dump:{async open(){return Readable.toWeb(createReadStream(dumpPathSource)) as ReadableStream<Uint8Array>;}},archive,backupObjects});
    assert.equal(sealed.status,'recovery_set_verified');assert(sealed.receiptKey);
    const readback=await readbackRecoverySet({archive,setId,backupObjects,verifiedAt:new Date().toISOString(),writeReceipt:true});
    assert.equal(readback.manifestSha256,sealed.manifestSha256);assert.equal(readback.objects.count,2);

    async function target(){const name='fp_archive_restore_'+randomUUID().replaceAll('-','');await admin.query(`CREATE DATABASE ${name}`);
      const connection=new URL(url);connection.pathname='/'+name;const restored=new Pool({connectionString:connection.href,options:`-c search_path=${schema} -c statement_timeout=30000`,max:4});
      targets.push({name,pool:restored});return {name,pool:restored};}
    const writer=(after?:()=>Promise<void>):DatabaseRestoreWriter=>({async restore({database,archive}){
      const bytes=new Uint8Array(await new Response(archive).arrayBuffer());await pgTool('pg_restore',['--dbname',database,'--single-transaction','--exit-on-error','--no-owner','--no-privileges'],bytes);await after?.();}});
    const good=await target(),destinationObjects=await store('RESTORED');let checks=0;
    const current={mode:'current_authority' as const,async assertCurrent(entry:{key:string}){checks++;assert(backup.objects.objects.some(o=>o.key===entry.key));}};
    const authority=restoredReferenceAuthorization(good.pool,{database:good.name,schema,current});
    const recovered=await restoreRecoverySet({archive,setId,backupObjects,destinationObjects,restoredPool:good.pool,restoredDatabase:good.name,database:writer(),objectAuthority:authority});
    assert.equal(recovered.status,'database_and_objects_restored');assert.equal(recovered.exposure,'current_authority_applied');assert(checks>=2);
    assert.equal(recovered.evidence.status,'matched');if(recovered.evidence.status==='matched')assert.equal(recovered.evidence.sequencesAdvanced,1);
    assert.equal(recovered.objects.objectCount,2);assert(recovered.remainingOperatorSteps.includes('restore_acl_lockdown'));
    assert.deepEqual((await good.pool.query('SELECT asset_id FROM assets ORDER BY asset_id')).rows.map(r=>r.asset_id),[first.assetId,retired.assetId].sort());
    for(const object of [first,retired])assert.deepEqual((await readVerifiedObject(destinationObjects,object.key,object.metadata)).bytes,object.bytes);
    assert.equal(await destinationObjects.head(late.key),null);
    assert.equal((await good.pool.query('SELECT count(*)::int n FROM asset_backup_pins')).rows[0].n,0,'original exported snapshot predates pin inserts');

    const revoked=await target(),revokedObjects=await store('REVOKED');
    const deny=restoredReferenceAuthorization(revoked.pool,{database:revoked.name,schema,current:{mode:'current_authority',async assertCurrent(){throw Error('synthetic current revocation');}}});
    await assert.rejects(restoreRecoverySet({archive,setId,backupObjects,destinationObjects:revokedObjects,restoredPool:revoked.pool,restoredDatabase:revoked.name,database:writer(),objectAuthority:deny}),errorCode('objects_restore_failed','restore_unauthorized'));
    assert.equal((await(await mf.getR2Bucket('REVOKED')).list()).objects.length,0);
    assert.equal((await revoked.pool.query('SELECT count(*)::int n FROM asset_objects')).rows[0].n,2,'snapshot references do not override current denial');

    const reset=await target(),resetObjects=await store('RESET');
    await assert.rejects(restoreRecoverySet({archive,setId,backupObjects,destinationObjects:resetObjects,restoredPool:reset.pool,restoredDatabase:reset.name,
      database:writer(async()=>{await reset.pool.query("SELECT setval('positioning_guild_officer_revision',1,false)");}),
      objectAuthority:restoredReferenceAuthorization(reset.pool,{database:reset.name,schema,current:{mode:'quarantine'}})}),errorCode('evidence_mismatch'));
    assert.equal((await(await mf.getR2Bucket('RESET')).list()).objects.length,0);

    const quarantine=await target();
    const quarantined=await restoreRecoverySet({archive,setId,backupObjects,destinationObjects:await store('QUARANTINE'),restoredPool:quarantine.pool,restoredDatabase:quarantine.name,database:writer(),
      objectAuthority:restoredReferenceAuthorization(quarantine.pool,{database:quarantine.name,schema,current:{mode:'quarantine'}})});
    assert.equal(quarantined.exposure,'quarantine_not_approved_for_exposure');

    const dumpPath=join(root,recoverySetKeys(setId).dump),stored=await readFile(dumpPath),corrupt=Buffer.from(stored);corrupt[0]^=1;await writeFile(dumpPath,corrupt);
    let restores=0;
    await assert.rejects(restoreRecoverySet({archive,setId,backupObjects,destinationObjects,restoredPool:good.pool,restoredDatabase:good.name,
      database:{async restore(){restores++;}},objectAuthority:authority}),errorCode('dump_mismatch'));
    assert.equal(restores,0,'full readback prevents invoking database restore on archive corruption');
    assert.equal(outbound,0);
  }finally{
    await mf?.dispose();await Promise.all(targets.map(t=>t.pool.end()));await pool.end();
    try{for(const t of targets)await admin.query(`DROP DATABASE ${t.name} WITH (FORCE)`);if(created)await admin.query(`DROP SCHEMA ${schema} CASCADE`);}
    finally{await admin.end();if(root)await rm(root,{recursive:true,force:true});}
  }
});
